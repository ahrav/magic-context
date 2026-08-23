//! Transactional evidence publication for the IPC budget: schema-versioned
//! run manifests, checksummed sidecars, terminal attempt states, and
//! complete-only aggregation.
//!
//! Rules: refuse a preexisting attempt directory, write sidecars before
//! summary fields, checksum every sidecar, and atomically move `running`
//! to exactly one terminal state. Histograms merge only within one arm
//! whose complete manifests share schema, workload, build, host, and arm
//! identifiers. Paired gaps join the atomic-floor and serial-TCP arms only
//! when build, host, ordered CPU pair, and run block all match.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use hdrhistogram::serialization::{Deserializer, Serializer, V2Serializer};
use hdrhistogram::Histogram;

use super::perf_measurement::{sha256_hex, OutcomeCounts, WorkloadId};

pub const SCHEMA_VERSION: u32 = 1;

pub const ARM_ATOMIC: &str = "atomic-floor";
pub const ARM_TCP_SERIAL: &str = "tcp-serial";
pub const ARM_TCP_OPEN: &str = "tcp-open";
pub const ARM_TCP_THROUGHPUT: &str = "tcp-throughput";

/// Fixed-range three-significant-digit histogram bounds shared by every
/// latency-recording arm: 100ns floor, 10s ceiling.
pub const HIST_LOW_NS: u64 = 100;
pub const HIST_HIGH_NS: u64 = 10_000_000_000;
pub const HIST_SIGFIGS: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Running,
    Complete,
    Skipped,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ArmId {
    pub name: String,
    pub class: Option<String>,
    /// Ordered (initiator/load, responder/host) logical CPUs.
    pub pair: Option<(u32, u32)>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BuildId {
    pub commit: String,
    pub rustc: String,
    pub profile: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct HostId {
    pub hostname: String,
    pub kernel: String,
    pub cpu_model: String,
    pub cpu_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct HistogramConfig {
    pub low_ns: u64,
    pub high_ns: u64,
    pub sigfigs: u8,
}

impl Default for HistogramConfig {
    fn default() -> Self {
        Self {
            low_ns: HIST_LOW_NS,
            high_ns: HIST_HIGH_NS,
            sigfigs: HIST_SIGFIGS,
        }
    }
}

impl HistogramConfig {
    pub fn build(&self) -> Result<Histogram<u64>, String> {
        Histogram::new_with_bounds(self.low_ns, self.high_ns, self.sigfigs)
            .map_err(|err| format!("histogram bounds: {err}"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Sidecar {
    pub file: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub state: State,
    pub arm: ArmId,
    pub run_block: u32,
    pub started_utc: String,
    pub finished_utc: Option<String>,
    pub workload: WorkloadId,
    pub build: BuildId,
    pub host: HostId,
    pub histogram: Option<HistogramConfig>,
    pub host_load: Option<serde_json::Value>,
    /// Requested pair plus post-pin singleton affinity readbacks.
    pub affinity: Option<serde_json::Value>,
    pub outcomes: Option<OutcomeCounts>,
    /// Values recorded into histograms after warmup.
    pub recorded_samples: Option<u64>,
    /// Records rejected by the fixed histogram range (also a terminal
    /// outcome per record).
    pub histogram_rejected: Option<u64>,
    pub skip_reason: Option<String>,
    pub fail_reason: Option<String>,
    pub sidecars: Vec<Sidecar>,
    /// Arm-specific scalar summaries, written only after sidecars exist.
    pub results: Option<serde_json::Value>,
}

pub const RUNNING_MANIFEST: &str = "manifest.running.json";
pub const FINAL_MANIFEST: &str = "manifest.json";

/// One attempt directory holding a running manifest and its sidecars.
#[derive(Debug)]
pub struct Attempt {
    dir: PathBuf,
    manifest: Manifest,
}

impl Attempt {
    /// Creates the attempt directory and writes the running manifest.
    /// Refuses a preexisting directory without modifying its contents.
    pub fn begin(run_dir: &Path, attempt_name: &str, manifest: Manifest) -> Result<Self, String> {
        let dir = run_dir.join(attempt_name);
        if dir.exists() {
            return Err(format!(
                "attempt directory {} already exists; refusing to append",
                dir.display()
            ));
        }
        std::fs::create_dir_all(&dir).map_err(|err| format!("{}: {err}", dir.display()))?;
        let attempt = Self { dir, manifest };
        attempt.write_manifest(RUNNING_MANIFEST)?;
        Ok(attempt)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn manifest_mut(&mut self) -> &mut Manifest {
        &mut self.manifest
    }

    /// Writes one sidecar and records its checksum in the manifest.
    pub fn add_sidecar(&mut self, file: &str, bytes: &[u8]) -> Result<(), String> {
        let path = self.dir.join(file);
        std::fs::write(&path, bytes).map_err(|err| format!("{}: {err}", path.display()))?;
        self.manifest.sidecars.push(Sidecar {
            file: file.to_owned(),
            sha256: sha256_hex(bytes),
        });
        Ok(())
    }

    /// Serializes a histogram as an HdrHistogram V2 sidecar.
    pub fn add_histogram(&mut self, file: &str, hist: &Histogram<u64>) -> Result<(), String> {
        let mut bytes = Vec::new();
        V2Serializer::new()
            .serialize(hist, &mut bytes)
            .map_err(|err| format!("histogram serialize: {err}"))?;
        self.add_sidecar(file, &bytes)
    }

    /// Moves the attempt from `running` to exactly one terminal state:
    /// writes the final manifest through a temp file plus atomic rename,
    /// then removes the running marker.
    pub fn finalize(mut self, state: State) -> Result<PathBuf, String> {
        assert!(
            !matches!(state, State::Running),
            "finalize needs a terminal state"
        );
        self.manifest.state = state;
        self.manifest.finished_utc = Some(utc_now());
        let tmp = self.dir.join("manifest.json.tmp");
        let bytes = manifest_bytes(&self.manifest)?;
        std::fs::write(&tmp, &bytes).map_err(|err| format!("{}: {err}", tmp.display()))?;
        let final_path = self.dir.join(FINAL_MANIFEST);
        std::fs::rename(&tmp, &final_path)
            .map_err(|err| format!("{}: {err}", final_path.display()))?;
        let _ = std::fs::remove_file(self.dir.join(RUNNING_MANIFEST));
        Ok(final_path)
    }

    fn write_manifest(&self, name: &str) -> Result<(), String> {
        let path = self.dir.join(name);
        std::fs::write(&path, manifest_bytes(&self.manifest)?)
            .map_err(|err| format!("{}: {err}", path.display()))
    }
}

fn manifest_bytes(manifest: &Manifest) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(manifest).map_err(|err| err.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn utc_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("unix:{}.{:09}", now.as_secs(), now.subsec_nanos())
}

/// Creates a run directory, refusing a preexisting nonempty one.
pub fn create_run_dir(path: &Path) -> Result<(), String> {
    if path.exists() {
        let nonempty = std::fs::read_dir(path)
            .map_err(|err| format!("{}: {err}", path.display()))?
            .next()
            .is_some();
        if nonempty {
            return Err(format!(
                "output directory {} is not empty; refusing to append",
                path.display()
            ));
        }
        return Ok(());
    }
    std::fs::create_dir_all(path).map_err(|err| format!("{}: {err}", path.display()))
}

/// Rewrites every leftover running manifest under `run_dir` to a terminal
/// `interrupted` manifest, retaining the attempt for diagnosis.
pub fn finalize_interrupted(run_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut finalized = Vec::new();
    for entry in
        std::fs::read_dir(run_dir).map_err(|err| format!("{}: {err}", run_dir.display()))?
    {
        let dir = entry.map_err(|err| err.to_string())?.path();
        let running = dir.join(RUNNING_MANIFEST);
        if !running.is_file() || dir.join(FINAL_MANIFEST).exists() {
            continue;
        }
        let bytes =
            std::fs::read(&running).map_err(|err| format!("{}: {err}", running.display()))?;
        let mut manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|err| format!("{}: {err}", running.display()))?;
        manifest.state = State::Interrupted;
        manifest.finished_utc = Some(utc_now());
        let final_path = dir.join(FINAL_MANIFEST);
        std::fs::write(&final_path, manifest_bytes(&manifest)?)
            .map_err(|err| format!("{}: {err}", final_path.display()))?;
        let _ = std::fs::remove_file(&running);
        finalized.push(final_path);
    }
    Ok(finalized)
}

/// One attempt loaded back from disk.
#[derive(Debug, Clone)]
pub struct LoadedAttempt {
    pub dir: PathBuf,
    pub manifest: Manifest,
}

/// Loads every finalized attempt under a run directory. Attempts with only
/// a running manifest are in-flight or interrupted-without-finalize and are
/// not loaded.
pub fn load_attempts(run_dir: &Path) -> Result<Vec<LoadedAttempt>, String> {
    let mut out = Vec::new();
    let entries =
        std::fs::read_dir(run_dir).map_err(|err| format!("{}: {err}", run_dir.display()))?;
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        let manifest_path = dir.join(FINAL_MANIFEST);
        if !manifest_path.is_file() {
            continue;
        }
        let bytes = std::fs::read(&manifest_path)
            .map_err(|err| format!("{}: {err}", manifest_path.display()))?;
        let manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|err| format!("{}: {err}", manifest_path.display()))?;
        // Pairwise `compatible` checks cannot catch a directory whose
        // manifests all share an unsupported schema; every manifest must
        // match the schema this binary's field semantics were written for.
        if manifest.schema != SCHEMA_VERSION {
            return Err(format!(
                "{}: manifest schema {} is not the supported schema {SCHEMA_VERSION}",
                manifest_path.display(),
                manifest.schema
            ));
        }
        out.push(LoadedAttempt { dir, manifest });
    }
    Ok(out)
}

/// Verifies every sidecar checksum recorded in a manifest.
pub fn verify_sidecars(attempt: &LoadedAttempt) -> Result<(), String> {
    for sidecar in &attempt.manifest.sidecars {
        let path = attempt.dir.join(&sidecar.file);
        let bytes = std::fs::read(&path).map_err(|err| format!("{}: {err}", path.display()))?;
        let got = sha256_hex(&bytes);
        if got != sidecar.sha256 {
            return Err(format!(
                "{}: checksum mismatch (recorded {}, observed {got})",
                path.display(),
                sidecar.sha256
            ));
        }
    }
    Ok(())
}

/// True when two complete manifests may enter one aggregate: same schema,
/// workload, build, and host.
pub fn compatible(a: &Manifest, b: &Manifest) -> bool {
    a.schema == b.schema && a.workload == b.workload && a.build == b.build && a.host == b.host
}

/// Deserializes a histogram sidecar back into memory.
pub fn read_histogram(attempt: &LoadedAttempt, file: &str) -> Result<Histogram<u64>, String> {
    let path = attempt.dir.join(file);
    let bytes = std::fs::read(&path).map_err(|err| format!("{}: {err}", path.display()))?;
    Deserializer::new()
        .deserialize(&mut bytes.as_slice())
        .map_err(|err| format!("{}: {err}", path.display()))
}

/// Merges the named histogram sidecar across every complete attempt of one
/// arm. Fails on any incompatibility, corrupt sidecar, or arm mismatch
/// rather than producing a partial merge.
pub fn merge_arm_histograms(
    attempts: &[LoadedAttempt],
    arm: &ArmId,
    file: &str,
) -> Result<Histogram<u64>, String> {
    let complete: Vec<&LoadedAttempt> = attempts
        .iter()
        .filter(|a| a.manifest.state == State::Complete && a.manifest.arm == *arm)
        .collect();
    if complete.is_empty() {
        return Err(format!("no complete attempts for arm {}", arm.name));
    }
    let reference = &complete[0].manifest;
    let mut merged = reference
        .histogram
        .clone()
        .ok_or_else(|| format!("arm {} records no histogram", arm.name))?
        .build()?;
    for attempt in &complete {
        if !compatible(reference, &attempt.manifest) {
            return Err(format!(
                "{}: incompatible manifest excluded from merge",
                attempt.dir.display()
            ));
        }
        verify_sidecars(attempt)?;
        let hist = read_histogram(attempt, file)?;
        merged
            .add(&hist)
            .map_err(|err| format!("{}: merge: {err}", attempt.dir.display()))?;
    }
    Ok(merged)
}

/// One paired floor/current observation joined by run block.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GapRow {
    pub run_block: u32,
    pub pair: (u32, u32),
    pub atomic_rtt_ns: f64,
    pub tcp_p50_ns: f64,
    pub gap_ns: f64,
    pub ratio: f64,
}

/// Joins complete atomic-floor and serial-TCP attempts by (run block,
/// ordered pair) within one compatible build/host set. Blocks missing
/// either side produce no row.
pub fn paired_gaps(attempts: &[LoadedAttempt]) -> Result<Vec<GapRow>, String> {
    let complete: Vec<&LoadedAttempt> = attempts
        .iter()
        .filter(|a| a.manifest.state == State::Complete)
        .collect();
    let Some(reference) = complete.first() else {
        return Ok(Vec::new());
    };
    let mut atomic: BTreeMap<(u32, (u32, u32)), f64> = BTreeMap::new();
    let mut tcp: BTreeMap<(u32, (u32, u32)), f64> = BTreeMap::new();
    for attempt in &complete {
        if !compatible(&reference.manifest, &attempt.manifest) {
            return Err(format!(
                "{}: incompatible manifest excluded from pairing",
                attempt.dir.display()
            ));
        }
        let m = &attempt.manifest;
        let Some(pair) = m.arm.pair else { continue };
        let key = (m.run_block, pair);
        let results = m.results.as_ref();
        match m.arm.name.as_str() {
            ARM_ATOMIC => {
                let rtt = results
                    .and_then(|r| r["median_batch_rtt_ns"].as_f64())
                    .ok_or_else(|| {
                        format!("{}: missing median_batch_rtt_ns", attempt.dir.display())
                    })?;
                atomic.insert(key, rtt);
            }
            ARM_TCP_SERIAL => {
                let p50 = results
                    .and_then(|r| r["p50_ns"].as_f64())
                    .ok_or_else(|| format!("{}: missing p50_ns", attempt.dir.display()))?;
                tcp.insert(key, p50);
            }
            _ => {}
        }
    }
    let mut rows = Vec::new();
    for (key, atomic_rtt) in &atomic {
        if let Some(tcp_p50) = tcp.get(key) {
            rows.push(GapRow {
                run_block: key.0,
                pair: key.1,
                atomic_rtt_ns: *atomic_rtt,
                tcp_p50_ns: *tcp_p50,
                gap_ns: tcp_p50 - atomic_rtt,
                ratio: tcp_p50 / atomic_rtt,
            });
        }
    }
    Ok(rows)
}

/// Counterbalanced fresh-process arm order: odd blocks run the arm list
/// forward, even blocks reversed, so drift affects each arm symmetrically.
pub fn counterbalanced_schedule(blocks: u32, arms: &[String]) -> Vec<Vec<String>> {
    (0..blocks)
        .map(|block| {
            let mut order = arms.to_vec();
            if block % 2 == 1 {
                order.reverse();
            }
            order
        })
        .collect()
}

pub fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).expect("no NaN observations"));
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 1 {
        values[mid]
    } else {
        (values[mid - 1] + values[mid]) / 2.0
    })
}

/// Deterministic percentile-bootstrap interval over run-block statistics.
/// Resamples whole run blocks (never individual requests) with a fixed
/// seed so re-aggregation is byte-stable.
pub fn bootstrap_interval(values: &[f64], iterations: u32, seed: u64) -> Option<(f64, f64)> {
    if values.is_empty() {
        return None;
    }
    let mut state = seed.max(1);
    let mut next = move || {
        // ponytail: xorshift64 is enough determinism for a resampling index
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut medians: Vec<f64> = (0..iterations)
        .map(|_| {
            let mut sample: Vec<f64> = (0..values.len())
                .map(|_| values[(next() % values.len() as u64) as usize])
                .collect();
            median(&mut sample).expect("nonempty resample")
        })
        .collect();
    medians.sort_by(|a, b| a.partial_cmp(b).expect("no NaN medians"));
    let lo = medians[(medians.len() as f64 * 0.025) as usize];
    let hi = medians[((medians.len() as f64 * 0.975) as usize).min(medians.len() - 1)];
    Some((lo, hi))
}
