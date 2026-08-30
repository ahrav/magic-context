//! IPC budget benchmark: Criterion scalar regression fixtures plus the
//! canonical retained-evidence collector, on one custom entry point.
//!
//! Modes (environment-driven so `cargo bench` arguments stay Criterion's):
//! - default: Criterion scalar groups (developer regression diagnostics,
//!   never tail evidence).
//! - `MC_IPC_BUDGET_ROLE=host`: process-isolated echo host child role.
//! - `MC_IPC_BUDGET_MODE=collect`: run one arm attempt and publish
//!   transactional evidence (exit 0 for complete/skipped, nonzero for
//!   configuration, correctness, or artifact failures).
//! - `MC_IPC_BUDGET_MODE=plan`: print the deterministic counterbalanced
//!   block schedule.
//! - `MC_IPC_BUDGET_MODE=aggregate`: verify, merge, and summarize a run
//!   directory into byte-stable summary data.
//! - `MC_IPC_BUDGET_MODE=finalize-interrupted`: move leftover running
//!   manifests to the `interrupted` terminal state.

#[path = "../tests/support/raw_client.rs"]
mod raw_client;

#[path = "../tests/support/perf_measurement.rs"]
mod perf_measurement;

#[path = "support/linux_topology.rs"]
mod linux_topology;

#[path = "support/atomic.rs"]
mod atomic;

#[path = "support/evidence.rs"]
mod evidence;

#[path = "support/ring.rs"]
mod ring;

#[path = "../tests/support/echo_host.rs"]
mod echo_host;

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use criterion::Criterion;

use atomic::{run_ping_pong, timed_exchanges, PingPongConfig};
use evidence::{
    counterbalanced_schedule, ArmId, Attempt, BuildId, HistogramConfig, HostId, Manifest, State,
    ARM_ATOMIC, ARM_RING_OPEN, ARM_RING_SERIAL, ARM_RING_THROUGHPUT,
};
use linux_topology::{auto_select, effective_affinity, read_topology, AutoSelection, Class};
use perf_measurement::fixture_workload;

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Parses an env knob, defaulting only when the variable is unset. A
/// present but malformed value is a configuration error: silently
/// substituting the default would finalize evidence for a workload the
/// operator did not request, without recording any error.
fn env_parse<T: std::str::FromStr>(name: &str, default: T) -> Result<T, String> {
    match env_var(name) {
        None => Ok(default),
        Some(v) => v
            .parse()
            .map_err(|_| format!("{name}: malformed value {v:?}")),
    }
}

fn main() {
    if env_var("MC_IPC_BUDGET_ROLE").as_deref() == Some("host") {
        run_child_host();
        return;
    }
    match env_var("MC_IPC_BUDGET_MODE").as_deref() {
        Some("collect") => std::process::exit(run_collect()),
        Some("plan") => {
            match render_plan() {
                Ok(plan) => print!("{plan}"),
                Err(err) => {
                    eprintln!("configuration: {err}");
                    std::process::exit(1);
                }
            }
            return;
        }
        Some("aggregate") => std::process::exit(run_aggregate()),
        Some("record-plan") => std::process::exit(run_record_plan()),
        Some("finalize-interrupted") => std::process::exit(run_finalize_interrupted()),
        Some(other) => {
            eprintln!("unknown MC_IPC_BUDGET_MODE {other:?}");
            std::process::exit(1);
        }
        None => {}
    }
    run_criterion();
}

// --- child host role ---------------------------------------------------

/// Echo host child: pins the whole process (before any Tokio thread
/// exists), publishes, prints READY, and shuts down on stdin EOF so the
/// parent's exit always tears it down.
fn run_child_host() {
    if let Some(cpu) = env_var("MC_IPC_BUDGET_HOST_CPU") {
        let cpu: u32 = cpu.parse().expect("MC_IPC_BUDGET_HOST_CPU");
        linux_topology::pin_current_thread(cpu).expect("host pin");
    }
    let data_dir = PathBuf::from(env_var("MC_IPC_BUDGET_DATA_DIR").expect("data dir"));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async move {
        let config = mc_host::HostConfig {
            data_dir: Some(data_dir.clone()),
            daemon_ver: "mc-host/ipc-budget".to_owned(),
            ..Default::default()
        };
        let publication = mc_host::runtime_dir_path(Some(&data_dir))
            .expect("runtime dir")
            .join(mc_host::CONNECTION_FILE_NAME);
        let shutdown = mc_host::CancellationToken::new();
        let host = tokio::spawn(mc_host::run(
            echo_host::EchoHandler,
            config,
            shutdown.clone(),
        ));
        while !publication.exists() {
            if host.is_finished() {
                eprintln!("host exited before publishing: {:?}", host.await);
                std::process::exit(1);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        println!("READY {}", publication.display());
        // Blocking stdin read on a spawn_blocking thread: EOF means the
        // parent is gone or done.
        let _ = tokio::task::spawn_blocking(|| {
            let mut sink = Vec::new();
            let _ = std::io::stdin().read_to_end(&mut sink);
        })
        .await;
        shutdown.cancel();
        let _ = host.await;
    });
}

/// A spawned child host process and its publication path. Dropping closes
/// stdin (shutting the host down) and reaps the child.
struct ChildHost {
    child: Child,
    publication: PathBuf,
    _data_dir: tempfile::TempDir,
}

impl ChildHost {
    fn spawn(host_cpu: Option<u32>) -> Result<Self, String> {
        let data_dir = tempfile::tempdir().map_err(|err| err.to_string())?;
        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        let mut cmd = Command::new(exe);
        cmd.env("MC_IPC_BUDGET_ROLE", "host")
            .env("MC_IPC_BUDGET_DATA_DIR", data_dir.path())
            .env_remove("MC_IPC_BUDGET_MODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        match host_cpu {
            Some(cpu) => cmd.env("MC_IPC_BUDGET_HOST_CPU", cpu.to_string()),
            None => cmd.env_remove("MC_IPC_BUDGET_HOST_CPU"),
        };
        // Fate-bind the host to this collector: when the collector dies
        // without unwinding (plain SIGTERM from the runner's interrupt
        // trap, SIGKILL, OOM), ChildHost::drop never runs, and the
        // pinned host would otherwise survive as an orphan holding its
        // CPU and temp directory into subsequent attempts. The signal is
        // installed after fork, so a collector that died in that window
        // has already reparented this child and no notification will
        // arrive; the parent-pid recheck closes that race.
        let collector_pid = std::process::id();
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.pre_exec(move || {
                rustix::process::set_parent_process_death_signal(Some(
                    rustix::process::Signal::KILL,
                ))
                .map_err(std::io::Error::from)?;
                let parent = rustix::process::getppid()
                    .map(|p| p.as_raw_nonzero().get())
                    .unwrap_or(0);
                if parent != collector_pid as i32 {
                    return Err(std::io::Error::other(
                        "collector died before the parent-death signal was installed",
                    ));
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().map_err(|err| format!("spawn host: {err}"))?;
        let stdout = child.stdout.take().expect("piped stdout");
        // The receiver enforces the deadline because BufReader::lines can
        // block indefinitely.
        let (line_tx, line_rx) = std::sync::mpsc::channel::<std::io::Result<String>>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line_tx.send(line).is_err() {
                    return;
                }
            }
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let publication = loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                let _ = child.kill();
                let _ = child.wait();
                return Err("child host never printed READY".to_owned());
            }
            match line_rx.recv_timeout(remaining) {
                Ok(Ok(line)) if line.starts_with("READY ") => {
                    break PathBuf::from(line.trim_start_matches("READY ").to_owned());
                }
                Ok(Ok(_)) => continue,
                Ok(Err(err)) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("child host stdout: {err}"));
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("child host never printed READY".to_owned());
                }
            }
        };
        Ok(Self {
            child,
            publication,
            _data_dir: data_dir,
        })
    }

    fn publication(&self) -> &Path {
        &self.publication
    }

    /// True when the child is still running (a dead child fails the arm).
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for ChildHost {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if std::time::Instant::now() > deadline => break,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// --- collection mode ----------------------------------------------------

struct CollectConfig {
    out: PathBuf,
    arm: String,
    class: Class,
    explicit_pair: Option<(u32, u32)>,
    block: u32,
}

fn read_collect_config() -> Result<CollectConfig, String> {
    let out = PathBuf::from(env_var("MC_IPC_BUDGET_OUT").ok_or("MC_IPC_BUDGET_OUT unset")?);
    let arm = env_var("MC_IPC_BUDGET_ARM").ok_or("MC_IPC_BUDGET_ARM unset")?;
    if ![
        ARM_ATOMIC,
        ARM_RING_SERIAL,
        ARM_RING_OPEN,
        ARM_RING_THROUGHPUT,
    ]
    .contains(&arm.as_str())
    {
        return Err(format!("unknown arm {arm:?}"));
    }
    let class = Class::parse(&env_var("MC_IPC_BUDGET_CLASS").unwrap_or("same-l3".to_owned()))?;
    let explicit_pair = match env_var("MC_IPC_BUDGET_PAIR") {
        Some(spec) => {
            let (a, b) = spec
                .split_once(',')
                .ok_or_else(|| format!("malformed pair {spec:?}; want A,B"))?;
            Some((
                a.trim()
                    .parse()
                    .map_err(|_| format!("malformed pair {spec:?}"))?,
                b.trim()
                    .parse()
                    .map_err(|_| format!("malformed pair {spec:?}"))?,
            ))
        }
        None => None,
    };
    // Validated here so every later read of the rate (attempt naming,
    // the open-loop collector) sees a well-formed value.
    env_parse::<u64>("MC_IPC_BUDGET_RATE", 0)?;
    Ok(CollectConfig {
        out,
        arm,
        class,
        explicit_pair,
        block: env_parse("MC_IPC_BUDGET_BLOCK", 1)?,
    })
}

fn loadavg() -> serde_json::Value {
    let raw = std::fs::read_to_string("/proc/loadavg").unwrap_or_default();
    let fields: Vec<f64> = raw
        .split_whitespace()
        .take(3)
        .filter_map(|f| f.parse().ok())
        .collect();
    serde_json::json!(fields)
}

fn stamp_end_load(attempt: &mut Attempt) {
    if let Some(serde_json::Value::Object(map)) = attempt.manifest_mut().host_load.as_mut() {
        map.insert("end".to_owned(), loadavg());
    }
}

fn host_id() -> HostId {
    let read = |path: &str| {
        std::fs::read_to_string(path)
            .map(|s| s.trim().to_owned())
            .unwrap_or_else(|_| "unknown".to_owned())
    };
    let cpu_model = std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|info| {
            info.lines()
                .find(|line| line.starts_with("model name"))
                .and_then(|line| line.split_once(':').map(|(_, v)| v.trim().to_owned()))
        })
        .unwrap_or_else(|| std::env::consts::ARCH.to_owned());
    HostId {
        // Manifests are retained in the repository, so the hostname field
        // carries an operator-chosen label, falling back to a hashed
        // machine fingerprint rather than a shared constant: `compatible`
        // treats host-identity equality as proof of one machine, and a
        // shared default would merge histograms across physically
        // different hosts that happen to share kernel and CPU strings.
        hostname: env_var("MC_IPC_BUDGET_HOST_LABEL").unwrap_or_else(|| {
            // An empty machine-id (minimal or not-yet-initialized
            // images) must not hash to one shared identity; fall through
            // to the hostname, and to "unknown" only when both sources
            // are empty.
            let id = std::fs::read_to_string("/etc/machine-id")
                .ok()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    std::fs::read_to_string("/proc/sys/kernel/hostname")
                        .ok()
                        .map(|s| s.trim().to_owned())
                        .filter(|s| !s.is_empty())
                });
            match id {
                Some(id) => format!(
                    "host-{}",
                    &perf_measurement::sha256_hex(id.as_bytes())[..12]
                ),
                None => "unknown".to_owned(),
            }
        }),
        kernel: read("/proc/sys/kernel/osrelease"),
        cpu_model,
        cpu_count: std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(0),
    }
}

fn build_id() -> BuildId {
    BuildId {
        commit: env_var("MC_IPC_BUDGET_COMMIT").unwrap_or_else(|| "unknown".to_owned()),
        rustc: env_var("MC_IPC_BUDGET_RUSTC").unwrap_or_else(|| "unknown".to_owned()),
        profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
        .to_owned(),
        binary: std::env::current_exe()
            .ok()
            .and_then(|exe| std::fs::read(exe).ok())
            .map(|bytes| perf_measurement::sha256_hex(&bytes)[..16].to_owned())
            .unwrap_or_else(|| "unknown".to_owned()),
    }
}

fn base_manifest(cfg: &CollectConfig, pair: Option<(u32, u32)>) -> Manifest {
    Manifest {
        schema: evidence::SCHEMA_VERSION,
        state: State::Running,
        arm: ArmId {
            name: cfg.arm.clone(),
            class: Some(cfg.class.label().to_owned()),
            pair,
        },
        run_block: cfg.block,
        started_utc: evidence::utc_now(),
        finished_utc: None,
        workload: fixture_workload(),
        build: build_id(),
        host: host_id(),
        histogram: None,
        host_load: Some(serde_json::json!({ "begin": loadavg() })),
        affinity: None,
        outcomes: None,
        recorded_samples: None,
        histogram_rejected: None,
        skip_reason: None,
        fail_reason: None,
        sidecars: Vec::new(),
        // The open-loop rate is recorded from creation so skipped and
        // failed attempts still carry the operating point they were
        // planned for; the collector overwrites this with the full
        // configuration on success. Without it, a skip copied onto a
        // different planned rate path would pass identity binding.
        collection: if cfg.arm == ARM_RING_OPEN {
            let rate =
                env_parse("MC_IPC_BUDGET_RATE", 0u64).expect("rate validated at config load");
            Some(serde_json::json!({ "rate_per_sec": rate }))
        } else {
            None
        },
        results: None,
    }
}

fn attempt_name(cfg: &CollectConfig) -> String {
    let mut name = format!("{}-{}-b{:02}", cfg.arm, cfg.class.label(), cfg.block);
    if cfg.arm == ARM_RING_OPEN {
        let rate = env_parse("MC_IPC_BUDGET_RATE", 0u64).expect("rate validated at config load");
        name.push_str(&format!("-r{rate}"));
    }
    name
}

/// Runs one arm attempt end to end. Exit code 0 covers complete and
/// structured-skip; nonzero is reserved for configuration, correctness, or
/// artifact failures.
fn run_collect() -> i32 {
    let cfg = match read_collect_config() {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("configuration: {err}");
            return 1;
        }
    };
    let pair = match resolve_pair(&cfg) {
        Ok(PairResolution::Pair(pair)) => pair,
        Ok(PairResolution::Skip(reason)) => return finalize_skip(&cfg, &reason),
        Ok(PairResolution::Invalid(pair, reason)) => {
            return run_attempt(&cfg, pair, |_, _| Err(reason.clone()))
        }
        Err(err) => {
            eprintln!("configuration: {err}");
            return 1;
        }
    };
    match cfg.arm.as_str() {
        ARM_ATOMIC => run_attempt(&cfg, pair, collect_atomic),
        ARM_RING_SERIAL => run_attempt(&cfg, pair, collect_ring_serial),
        ARM_RING_OPEN => run_attempt(&cfg, pair, collect_ring_open),
        ARM_RING_THROUGHPUT => run_attempt(&cfg, pair, collect_ring_throughput),
        _ => unreachable!("arm validated at parse"),
    }
}

enum PairResolution {
    Pair((u32, u32)),
    /// Auto-selected class unavailable on this host: structured skip.
    Skip(String),
    /// Explicit pair rejected: configuration failure, recorded on a
    /// failed attempt.
    Invalid((u32, u32), String),
}

/// Resolves the ordered pair before any attempt directory exists, so a
/// malformed configuration fails before measurement.
fn resolve_pair(cfg: &CollectConfig) -> Result<PairResolution, String> {
    let topology = read_topology(Path::new("/")).map_err(|err| format!("topology: {err}"))?;
    let allowed = effective_affinity().map_err(|err| format!("affinity: {err}"))?;
    Ok(match cfg.explicit_pair {
        Some(pair) => match linux_topology::validate_pair(&topology, &allowed, pair, cfg.class) {
            Ok(()) => PairResolution::Pair(pair),
            Err(err) => PairResolution::Invalid(pair, format!("explicit pair invalid: {err}")),
        },
        // auto_select only returns pairs that already pass validate_pair.
        None => match auto_select(&topology, &allowed, cfg.class) {
            AutoSelection::Pair(a, b) => PairResolution::Pair((a, b)),
            AutoSelection::Unavailable(reason) => PairResolution::Skip(reason),
        },
    })
}

fn finalize_skip(cfg: &CollectConfig, reason: &str) -> i32 {
    let attempt = Attempt::begin(&cfg.out, &attempt_name(cfg), base_manifest(cfg, None));
    let mut attempt = match attempt {
        Ok(attempt) => attempt,
        Err(err) => {
            eprintln!("attempt: {err}");
            return 1;
        }
    };
    attempt.manifest_mut().skip_reason = Some(reason.to_owned());
    match attempt.finalize(State::Skipped) {
        Ok(path) => {
            println!("SKIPPED {} ({reason})", path.display());
            0
        }
        Err(err) => {
            eprintln!("finalize: {err}");
            1
        }
    }
}

/// Owns the attempt lifecycle around one arm body: begin, measure, stamp,
/// then finalize to exactly one of Complete or Failed.
fn run_attempt(
    cfg: &CollectConfig,
    pair: (u32, u32),
    body: impl Fn(&mut Attempt, (u32, u32)) -> Result<(), String>,
) -> i32 {
    let attempt = Attempt::begin(&cfg.out, &attempt_name(cfg), base_manifest(cfg, Some(pair)));
    let mut attempt = match attempt {
        Ok(attempt) => attempt,
        Err(err) => {
            eprintln!("attempt: {err}");
            return 1;
        }
    };
    match body(&mut attempt, pair) {
        Ok(()) => {
            stamp_end_load(&mut attempt);
            match attempt.finalize(State::Complete) {
                Ok(path) => {
                    println!("COMPLETE {}", path.display());
                    0
                }
                Err(err) => {
                    eprintln!("finalize: {err}");
                    1
                }
            }
        }
        Err(reason) => {
            eprintln!("failure: {reason}");
            attempt.manifest_mut().fail_reason = Some(reason);
            stamp_end_load(&mut attempt);
            if let Err(err) = attempt.finalize(State::Failed) {
                eprintln!("finalize: {err}");
            }
            1
        }
    }
}

fn collect_atomic(attempt: &mut Attempt, pair: (u32, u32)) -> Result<(), String> {
    let cfg = PingPongConfig {
        initiator_cpu: pair.0,
        responder_cpu: pair.1,
        warmup_batches: env_parse("MC_IPC_BUDGET_WARMUP_BATCHES", 50)?,
        batches: env_parse("MC_IPC_BUDGET_BATCHES", 200)?,
        exchanges_per_batch: env_parse("MC_IPC_BUDGET_EXCHANGES", 10_000)?,
    };
    let output = run_ping_pong(cfg).map_err(|err| format!("atomic arm: {err}"))?;
    let hist_cfg = HistogramConfig::default();
    let mut hist = hist_cfg.build()?;
    let mut rejected = 0u64;
    for &mean in &output.batch_mean_rtt_ns {
        if hist.record(mean.round() as u64).is_err() {
            rejected += 1;
        }
    }
    // A batch mean beyond the histogram range would be retained in
    // batches.json yet omitted from every merged percentile; the
    // attempt fails rather than publishing the faster subset, matching
    // the ring arms' overflow gate.
    if rejected > 0 {
        return Err(format!(
            "{rejected} batch mean(s) exceeded the histogram range; the attempt is invalid"
        ));
    }
    let raw = serde_json::to_vec_pretty(&output).map_err(|err| err.to_string())?;
    attempt.add_sidecar("batches.json", &raw)?;
    attempt.add_histogram("batch_mean_rtt.hist", &hist)?;
    let mut means = output.batch_mean_rtt_ns.clone();
    let median = evidence::median(&mut means).unwrap_or(0.0);
    let manifest = attempt.manifest_mut();
    manifest.histogram = Some(hist_cfg);
    manifest.collection = Some(serde_json::json!({
        "warmup_batches": cfg.warmup_batches,
        "batches": cfg.batches,
        "exchanges_per_batch": cfg.exchanges_per_batch,
    }));
    manifest.recorded_samples = Some(output.batch_mean_rtt_ns.len() as u64 - rejected);
    manifest.histogram_rejected = Some(rejected);
    manifest.affinity = Some(serde_json::json!({
        "requested": [pair.0, pair.1],
        "initiator_observed": output.initiator,
        "responder_observed": output.responder,
    }));
    manifest.results = Some(serde_json::json!({
        "median_batch_rtt_ns": median,
        "min_batch_rtt_ns": means.first().copied().unwrap_or(0.0),
        "max_batch_rtt_ns": means.last().copied().unwrap_or(0.0),
        "exchanges_per_sec": output.exchanges_per_sec(),
        "clock_bracket_ns": output.clock_bracket_ns,
        "batches": output.batch_mean_rtt_ns.len(),
        "exchanges_per_batch": cfg.exchanges_per_batch,
    }));
    Ok(())
}

/// Pins the collector (load side) and spawns the pinned child host,
/// recording requested and effective affinity in the manifest.
fn ring_arm_setup(attempt: &mut Attempt, pair: (u32, u32)) -> Result<ChildHost, String> {
    linux_topology::pin_current_thread(pair.0).map_err(|err| format!("load pin: {err}"))?;
    let host = ChildHost::spawn(Some(pair.1))?;
    let load_affinity: Vec<u32> = effective_affinity()?.into_iter().collect();
    attempt.manifest_mut().affinity = Some(serde_json::json!({
        "requested": [pair.0, pair.1],
        "load_effective": load_affinity,
    }));
    Ok(host)
}

fn check_host_alive(host: &mut ChildHost) -> Result<(), String> {
    if !host.alive() {
        return Err("child host exited during measurement".to_owned());
    }
    Ok(())
}

/// Correctness is a gate, not an outcome to average over: a live host
/// returning wrong bodies, protocol errors, or unexpected frames
/// satisfies conservation, and publishing the successful subset would
/// select latency from only the requests the host answered correctly.
/// A histogram overflow is a valid measured terminal excluded from every
/// percentile, so retaining the attempt would survivorship-bias the
/// tails toward the faster subset; it fails the attempt the same way.
fn check_correctness(outcomes: &perf_measurement::OutcomeCounts) -> Result<(), String> {
    let correctness_failures =
        outcomes.protocol_error + outcomes.body_mismatch + outcomes.unexpected_frame;
    if correctness_failures > 0 {
        return Err(format!(
            "{correctness_failures} correctness violation(s) in measured outcomes: {outcomes:?}"
        ));
    }
    if outcomes.histogram_overflow > 0 {
        return Err(format!(
            "{} measured terminal(s) exceeded the histogram range and would be silently \
             excluded from every percentile: {outcomes:?}",
            outcomes.histogram_overflow
        ));
    }
    Ok(())
}

fn check_host_and_conservation(
    host: &mut ChildHost,
    outcomes: &perf_measurement::OutcomeCounts,
    scheduled: u64,
) -> Result<(), String> {
    check_host_alive(host)?;
    if !outcomes.conserved(scheduled) {
        return Err(format!(
            "outcome-accounting loss: {} outcomes for {scheduled} scheduled slots",
            outcomes.total()
        ));
    }
    check_correctness(outcomes)
}

fn collect_ring_serial(attempt: &mut Attempt, pair: (u32, u32)) -> Result<(), String> {
    let cfg = ring::SerialConfig {
        warmup_ops: env_parse("MC_IPC_BUDGET_WARMUP_OPS", 20_000)?,
        measured_ops: env_parse("MC_IPC_BUDGET_MEASURED_OPS", 120_000)?,
        histogram: HistogramConfig::default(),
    };
    let mut host = ring_arm_setup(attempt, pair)?;
    let result =
        ring::run_serial(host.publication(), &cfg).map_err(|err| format!("serial arm: {err}"))?;
    if result.scheduled != cfg.measured_ops
        || result.outcomes.peer_closed
            + result.outcomes.write_failure
            + result.outcomes.unresolved_at_drain
            > 0
    {
        return Err(format!(
            "serial window truncated: {} of {} measured operations scheduled on a connection \
             that must stay healthy for the whole window (outcomes: {:?}); the attempt is invalid",
            result.scheduled, cfg.measured_ops, result.outcomes
        ));
    }
    check_host_and_conservation(&mut host, &result.outcomes, result.scheduled)?;
    attempt.add_histogram("issue_to_terminal.hist", &result.histogram)?;
    let hist = &result.histogram;
    let results = serde_json::json!({
        "p50_ns": hist.value_at_quantile(0.50),
        "p99_ns": hist.value_at_quantile(0.99),
        "p999_ns": if perf_measurement::tail_publishable(hist.len()) {
            serde_json::json!(hist.value_at_quantile(0.999))
        } else {
            serde_json::Value::Null
        },
        "max_ns": hist.max(),
        "scheduled": result.scheduled,
        "elapsed_secs": result.elapsed.as_secs_f64(),
    });
    // The results and outcomes get a checksummed record; aggregation
    // compares the manifest copies against it, so a manifest edit to any
    // scalar (not just the p50 the gap pairing recomputes) fails loudly.
    let record = serde_json::json!({
        "results": results,
        "outcomes": result.outcomes,
    });
    attempt.add_sidecar(
        "serial.json",
        &serde_json::to_vec_pretty(&record).map_err(|err| err.to_string())?,
    )?;
    let manifest = attempt.manifest_mut();
    manifest.histogram = Some(cfg.histogram.clone());
    manifest.collection = Some(serde_json::json!({
        "warmup_ops": cfg.warmup_ops,
        "measured_ops": cfg.measured_ops,
    }));
    manifest.outcomes = Some(result.outcomes.clone());
    manifest.recorded_samples = Some(hist.len());
    manifest.histogram_rejected = Some(result.outcomes.histogram_overflow);
    manifest.results = Some(results);
    Ok(())
}

fn collect_ring_open(attempt: &mut Attempt, pair: (u32, u32)) -> Result<(), String> {
    let rate = env_parse("MC_IPC_BUDGET_RATE", 0u64)?;
    let cfg = ring::OpenLoopConfig {
        rate_per_sec: rate,
        warmup: Duration::from_secs(env_parse("MC_IPC_BUDGET_WARMUP_SECS", 2)?),
        measure: Duration::from_secs(env_parse("MC_IPC_BUDGET_MEASURE_SECS", 10)?),
        inflight_cap: env_parse("MC_IPC_BUDGET_INFLIGHT_CAP", 1024)?,
        histogram: HistogramConfig::default(),
    };
    let mut host = ring_arm_setup(attempt, pair)?;
    let result = ring::run_open_loop(host.publication(), &cfg)
        .map_err(|err| format!("open-loop arm: {err}"))?;
    if result.truncated {
        return Err(format!(
            "connection retired after {:.2}s, before the {}s warmup+measure window completed \
             (outcomes: {:?}); the attempt is invalid",
            result.elapsed.as_secs_f64(),
            (cfg.warmup + cfg.measure).as_secs(),
            result.outcomes
        ));
    }
    // Drain-time transport failures do not mark the run truncated (the
    // window itself completed), but a live peer that left measured
    // requests unanswered or closed during the drain still lost
    // responses; retaining the attempt would publish latency from only
    // the successful subset.
    let transport_failures = result.outcomes.peer_closed
        + result.outcomes.write_failure
        + result.outcomes.unresolved_at_drain;
    if transport_failures > 0 {
        return Err(format!(
            "{transport_failures} transport-failure outcome(s) in the measured window \
             (outcomes: {:?}); the attempt is invalid",
            result.outcomes
        ));
    }
    check_host_and_conservation(&mut host, &result.outcomes, result.scheduled_slots)?;
    if result.outcomes.success == 0 {
        return Err(format!(
            "offered-rate point {rate}/s produced no successful measured observation \
             (outcomes: {:?}); the point is invalid for this host",
            result.outcomes
        ));
    }
    for (file, hist) in [
        ("sched_to_completion.hist", &result.sched_to_completion),
        ("issue_to_completion.hist", &result.issue_to_completion),
        ("scheduler_lag.hist", &result.scheduler_lag),
    ] {
        attempt.add_histogram(file, hist)?;
    }
    let results = serde_json::json!({
        "offered_rate_per_sec": rate,
        "sched_p50_ns": result.sched_to_completion.value_at_quantile(0.50),
        "sched_p99_ns": result.sched_to_completion.value_at_quantile(0.99),
        "issue_p50_ns": result.issue_to_completion.value_at_quantile(0.50),
        "issue_p99_ns": result.issue_to_completion.value_at_quantile(0.99),
        "lag_p99_ns": result.scheduler_lag.value_at_quantile(0.99),
        "scheduled_slots": result.scheduled_slots,
        "elapsed_secs": result.elapsed.as_secs_f64(),
    });
    // The results and outcomes get a checksummed record like the serial
    // and throughput arms; the histograms cover only the percentiles,
    // leaving scheduled_slots and the outcome counters unprotected
    // otherwise.
    let record = serde_json::json!({
        "results": results,
        "outcomes": result.outcomes,
    });
    attempt.add_sidecar(
        "open.json",
        &serde_json::to_vec_pretty(&record).map_err(|err| err.to_string())?,
    )?;
    let manifest = attempt.manifest_mut();
    manifest.histogram = Some(cfg.histogram.clone());
    manifest.collection = Some(serde_json::json!({
        "rate_per_sec": rate,
        "warmup_secs": cfg.warmup.as_secs(),
        "measure_secs": cfg.measure.as_secs(),
        "inflight_cap": cfg.inflight_cap,
    }));
    manifest.outcomes = Some(result.outcomes.clone());
    manifest.recorded_samples = Some(result.sched_to_completion.len());
    manifest.histogram_rejected = Some(result.outcomes.histogram_overflow);
    manifest.results = Some(results);
    Ok(())
}

fn collect_ring_throughput(attempt: &mut Attempt, pair: (u32, u32)) -> Result<(), String> {
    let cfg = ring::ThroughputConfig {
        depth: env_parse("MC_IPC_BUDGET_DEPTH", 32)?,
        warmup: Duration::from_secs(env_parse("MC_IPC_BUDGET_WARMUP_SECS", 2)?),
        measure: Duration::from_secs(env_parse("MC_IPC_BUDGET_MEASURE_SECS", 10)?),
    };
    let mut host = ring_arm_setup(attempt, pair)?;
    let result = ring::run_throughput(host.publication(), &cfg)
        .map_err(|err| format!("throughput arm: {err}"))?;
    if result.truncated {
        return Err(format!(
            "connection retired before the {}s measure window completed (measured {:.2}s, \
             outcomes: {:?}); the attempt is invalid",
            cfg.measure.as_secs(),
            result.measured.as_secs_f64(),
            result.outcomes
        ));
    }
    // The throughput arm has no scheduled count independent of its
    // outcomes (`terminal` is `outcomes.total()`), so a conservation
    // check against it proves nothing; response loss surfaces instead as
    // an undrained in-flight request, which `run_throughput` returns as
    // an error. Host liveness and correctness stay as gates.
    check_host_alive(&mut host)?;
    check_correctness(&result.outcomes)?;
    if result.successful == 0 {
        // Every measured completion can land in the post-window drain
        // (depth 1 with latency longer than the remaining window), which
        // is a valid drain but not a measured operating point.
        return Err(format!(
            "throughput window produced no measured successful completion \
             (outcomes: {:?}); the point is invalid for this host",
            result.outcomes
        ));
    }
    let results = serde_json::json!({
        "depth": cfg.depth,
        "offered": result.offered,
        "terminal": result.terminal,
        "successful": result.successful,
        "successful_per_sec": result.successful_per_sec,
        "goodput_bytes_per_sec": result.goodput_bytes_per_sec,
        "drained": result.drained,
        "measured_secs": result.measured.as_secs_f64(),
    });
    // The throughput arm writes no histogram, so its counters get their
    // own checksummed sidecar; aggregation compares the manifest's
    // results and outcomes against it, exactly like the histogram-backed
    // arms' scalar checks.
    let record = serde_json::json!({
        "results": results,
        "outcomes": result.outcomes,
    });
    attempt.add_sidecar(
        "throughput.json",
        &serde_json::to_vec_pretty(&record).map_err(|err| err.to_string())?,
    )?;
    let manifest = attempt.manifest_mut();
    manifest.collection = Some(serde_json::json!({
        "depth": cfg.depth,
        "warmup_secs": cfg.warmup.as_secs(),
        "measure_secs": cfg.measure.as_secs(),
    }));
    manifest.outcomes = Some(result.outcomes.clone());
    manifest.recorded_samples = Some(result.successful);
    manifest.results = Some(results);
    Ok(())
}

// --- plan / aggregate / finalize ----------------------------------------

/// Default open-loop offered-rate points; byte-identical to the script's
/// `BUDGET_RATES` default so the plan preview matches execution.
pub const DEFAULT_RATES: &str = "20000 50000 80000";

/// Cross-NUMA paired tail in forward orientation. The script's
/// `budget_block` runs these after the same-L3 arms, reversing their
/// order on even blocks like the same-L3 arms.
const CROSS_ARMS: [&str; 2] = [ARM_ATOMIC, ARM_RING_SERIAL];

fn plan_arms() -> Vec<String> {
    [
        ARM_ATOMIC,
        ARM_RING_SERIAL,
        ARM_RING_OPEN,
        ARM_RING_THROUGHPUT,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect()
}

/// Expands one block into the collection sequence the script's
/// `budget_block` executes: the counterbalanced same-L3 arms with
/// `ring-open` fanned out per offered rate (rate order as given, never
/// reversed), then the cross-NUMA paired tail in its own counterbalanced
/// order.
pub fn plan_block_entries(same_l3: &[String], cross: &[String], rates: &[u64]) -> Vec<String> {
    let mut entries = Vec::new();
    for arm in same_l3 {
        if arm == ARM_RING_OPEN {
            entries.extend(rates.iter().map(|rate| format!("{arm}@same-l3:r{rate}")));
        } else {
            entries.push(format!("{arm}@same-l3"));
        }
    }
    entries.extend(cross.iter().map(|arm| format!("{arm}@cross-numa")));
    entries
}

/// Attempt directory names the standard schedule produces for one run:
/// every same-L3 arm per block (one open-loop attempt per rate) plus the
/// cross-NUMA paired tail. The names mirror `attempt_name` exactly so
/// aggregation can verify the planned set is fully present.
fn expected_attempt_names(blocks: u32, rates: &[u64]) -> Vec<String> {
    let mut names = Vec::new();
    for block in 1..=blocks {
        for arm in [ARM_ATOMIC, ARM_RING_SERIAL, ARM_RING_THROUGHPUT] {
            names.push(format!("{arm}-same-l3-b{block:02}"));
        }
        for rate in rates {
            names.push(format!("{ARM_RING_OPEN}-same-l3-b{block:02}-r{rate}"));
        }
        for arm in CROSS_ARMS {
            names.push(format!("{arm}-cross-numa-b{block:02}"));
        }
    }
    names
}

/// Persists the planned attempt set at run creation, so aggregation can
/// detect a deleted or omitted attempt directory: a missing repetition
/// leaves no residue for the manifest checks to reject, and a partial
/// run would otherwise summarize as a valid smaller experiment.
fn run_record_plan() -> i32 {
    let out = PathBuf::from(match env_var("MC_IPC_BUDGET_OUT") {
        Some(out) => out,
        None => {
            eprintln!("MC_IPC_BUDGET_OUT unset");
            return 1;
        }
    });
    let plan = (|| -> Result<serde_json::Value, String> {
        let blocks = env_parse("MC_IPC_BUDGET_BLOCKS", 10u32)?;
        let rates: Vec<u64> = env_var("MC_IPC_BUDGET_RATES")
            .unwrap_or_else(|| DEFAULT_RATES.to_owned())
            .split_whitespace()
            .map(|token| {
                token
                    .parse()
                    .map_err(|_| format!("MC_IPC_BUDGET_RATES: malformed rate {token:?}"))
            })
            .collect::<Result<_, _>>()?;
        Ok(serde_json::json!({
            "attempts": expected_attempt_names(blocks, &rates),
        }))
    })();
    match plan {
        Ok(plan) => {
            let path = out.join("run-plan.json");
            let mut text = serde_json::to_string_pretty(&plan).expect("serialize plan");
            text.push('\n');
            // Create-new semantics: rewriting an existing plan (say with
            // a smaller block count after losing a block) would let
            // aggregation accept the surviving subset, defeating the
            // completeness guarantee the plan provides.
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path);
            let mut file = match file {
                Ok(file) => file,
                Err(err) => {
                    eprintln!(
                        "{}: refusing to overwrite the run plan: {err}",
                        path.display()
                    );
                    return 1;
                }
            };
            use std::io::Write;
            if let Err(err) = file.write_all(text.as_bytes()) {
                eprintln!("{}: {err}", path.display());
                return 1;
            }
            0
        }
        Err(err) => {
            eprintln!("configuration: {err}");
            1
        }
    }
}

fn render_plan() -> Result<String, String> {
    let blocks = env_parse("MC_IPC_BUDGET_BLOCKS", 10u32)?;
    let rates: Vec<u64> = env_var("MC_IPC_BUDGET_RATES")
        .unwrap_or_else(|| DEFAULT_RATES.to_owned())
        .split_whitespace()
        .map(|token| {
            token
                .parse()
                .map_err(|_| format!("MC_IPC_BUDGET_RATES: malformed rate {token:?}"))
        })
        .collect::<Result<_, _>>()?;
    let cross: Vec<String> = CROSS_ARMS.iter().map(|s| (*s).to_owned()).collect();
    let same_l3_schedule = counterbalanced_schedule(blocks, &plan_arms());
    let cross_schedule = counterbalanced_schedule(blocks, &cross);
    let mut out = String::new();
    for (block, (same_l3, cross)) in same_l3_schedule.iter().zip(&cross_schedule).enumerate() {
        out.push_str(&format!(
            "block {:02}: {}\n",
            block + 1,
            plan_block_entries(same_l3, cross, &rates).join(" -> ")
        ));
    }
    Ok(out)
}

fn run_aggregate() -> i32 {
    let out = PathBuf::from(match env_var("MC_IPC_BUDGET_OUT") {
        Some(out) => out,
        None => {
            eprintln!("MC_IPC_BUDGET_OUT unset");
            return 1;
        }
    });
    match aggregate(&out) {
        Ok(summary) => {
            let path = out.join("summary.json");
            if let Err(err) = std::fs::write(&path, &summary) {
                eprintln!("{}: {err}", path.display());
                return 1;
            }
            print!("{summary}");
            0
        }
        Err(err) => {
            eprintln!("aggregate: {err}");
            1
        }
    }
}

/// Builds the byte-stable run summary from complete attempts only.
fn aggregate(run_dir: &Path) -> Result<String, String> {
    // Attempts holding only a running manifest are crash residue that
    // finalize-interrupted has not converted, and a directory with no
    // manifest at all is a failed Attempt::begin; aggregating past
    // either would publish a complete-looking summary that silently
    // omits repetitions.
    let mut unfinalized = 0usize;
    let entries =
        std::fs::read_dir(run_dir).map_err(|err| format!("{}: {err}", run_dir.display()))?;
    for entry in entries {
        let path = entry.map_err(|err| err.to_string())?.path();
        if !path.is_dir() {
            continue;
        }
        let has_final = path.join(evidence::FINAL_MANIFEST).is_file();
        let has_running = path.join(evidence::RUNNING_MANIFEST).is_file();
        if has_final {
            continue;
        }
        if has_running {
            unfinalized += 1;
        } else {
            return Err(format!(
                "{}: attempt directory holds no manifest at all; remove it or restore \
                 its manifest before aggregating",
                path.display()
            ));
        }
    }
    if unfinalized > 0 {
        return Err(format!(
            "{unfinalized} attempt(s) hold only a running manifest; run \
             MC_IPC_BUDGET_MODE=finalize-interrupted over this directory first"
        ));
    }
    // The persisted plan is required: a lost or omitted run-plan.json
    // would otherwise skip the completeness check and let a partial copy
    // summarize as a valid smaller experiment — the exact failure the
    // plan exists to prevent. (Runs predating the plan file also predate
    // the record sidecars, so they are already rejected below and need
    // the harness at their collection commit.)
    let plan_path = run_dir.join("run-plan.json");
    if !plan_path.is_file() {
        return Err(format!(
            "{}: run-plan.json is missing; rerun MC_IPC_BUDGET_MODE=record-plan with this \
             run's block and rate configuration before aggregating",
            run_dir.display()
        ));
    }
    let planned: std::collections::BTreeSet<String> = {
        let raw =
            std::fs::read(&plan_path).map_err(|err| format!("{}: {err}", plan_path.display()))?;
        let plan: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|err| format!("{}: {err}", plan_path.display()))?;
        let expected = plan["attempts"]
            .as_array()
            .ok_or_else(|| format!("{}: missing attempts array", plan_path.display()))?;
        let mut names = std::collections::BTreeSet::new();
        for name in expected {
            let name = name
                .as_str()
                .ok_or_else(|| format!("{}: non-string attempt name", plan_path.display()))?;
            if !run_dir.join(name).join(evidence::FINAL_MANIFEST).is_file() {
                return Err(format!(
                    "planned attempt {name} has no finalized manifest; the run is incomplete"
                ));
            }
            names.insert(name.to_owned());
        }
        names
    };
    let attempts: Vec<evidence::LoadedAttempt> = evidence::load_attempts(run_dir)?;
    // Every attempt directory must be bound to the plan and to the
    // identity its manifest records: an extra unplanned attempt would
    // silently join the aggregates, and a renamed or copied directory
    // (an r80000 attempt posing as r20000, or a skip renamed onto a
    // planned path) would satisfy the plan while measuring nothing or
    // the wrong operating point.
    for a in &attempts {
        let actual = a
            .dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !planned.contains(&actual) {
            return Err(format!(
                "{}: attempt is not in the persisted run plan",
                a.dir.display()
            ));
        }
        let m = &a.manifest;
        let base = format!(
            "{}-{}-b{:02}",
            m.arm.name,
            m.arm.class.clone().unwrap_or_default(),
            m.run_block
        );
        let name_ok = if m.arm.name == ARM_RING_OPEN {
            // Every open-loop manifest records its planned rate from
            // creation, so skipped and failed attempts bind to their
            // exact operating point too.
            let rate = m
                .collection
                .as_ref()
                .and_then(|c| c["rate_per_sec"].as_u64())
                .ok_or_else(|| {
                    format!("{}: open-loop manifest records no rate", a.dir.display())
                })?;
            actual == format!("{base}-r{rate}")
        } else {
            actual == base
        };
        if !name_ok {
            return Err(format!(
                "{}: directory name does not match its manifest identity (expected {base})",
                a.dir.display()
            ));
        }
    }
    if attempts.is_empty() {
        return Err("run directory holds no finalized attempts".to_owned());
    }
    for attempt in &attempts {
        if attempt.manifest.state == State::Complete {
            evidence::verify_sidecars(attempt)?;
        }
    }

    let mut arms_summary = serde_json::Map::new();
    // Groups are (arm, collection configuration): one ArmId can cover
    // several operating points (the open-loop arm runs one attempt per
    // offered rate), and pooling their histograms would merge different
    // workloads into one distribution.
    type Group = (ArmId, Option<serde_json::Value>);
    let mut groups: Vec<Group> = Vec::new();
    for attempt in &attempts {
        let group = (
            attempt.manifest.arm.clone(),
            attempt.manifest.collection.clone(),
        );
        if attempt.manifest.state == State::Complete && !groups.contains(&group) {
            groups.push(group);
        }
    }
    groups.sort_by(|a, b| {
        (&a.0.name, a.0.pair, a.1.as_ref().map(ToString::to_string)).cmp(&(
            &b.0.name,
            b.0.pair,
            b.1.as_ref().map(ToString::to_string),
        ))
    });
    for (arm, collection) in &groups {
        let group_attempts: Vec<evidence::LoadedAttempt> = attempts
            .iter()
            .filter(|a| a.manifest.arm == *arm && a.manifest.collection == *collection)
            .cloned()
            .collect();
        let complete: Vec<&evidence::LoadedAttempt> = group_attempts
            .iter()
            .filter(|a| a.manifest.state == State::Complete)
            .collect();
        let mut entry = serde_json::Map::new();
        entry.insert("attempts".to_owned(), serde_json::json!(complete.len()));
        entry.insert(
            "class".to_owned(),
            serde_json::json!(arm.class.clone().unwrap_or_default()),
        );
        entry.insert("pair".to_owned(), serde_json::json!(arm.pair));
        entry.insert("collection".to_owned(), serde_json::json!(collection));
        let hist_file = match arm.name.as_str() {
            ARM_ATOMIC => Some("batch_mean_rtt.hist"),
            ARM_RING_SERIAL => Some("issue_to_terminal.hist"),
            _ => None,
        };
        if let Some(file) = hist_file {
            let merged = evidence::merge_arm_histograms(&group_attempts, arm, file)?;
            let total: u64 = merged.len();
            // The headline floor derives from each repetition's verified
            // histogram, not the manifest's recorded_samples scalar: the
            // scalar is unprotected by any checksum, and an inflated
            // value could unlock p99.9 for a repetition that never met
            // the floor.
            let mut headline_ok = true;
            for a in &complete {
                if evidence::read_histogram(a, file)?.len() < perf_measurement::HEADLINE_TAIL_FLOOR
                {
                    headline_ok = false;
                    break;
                }
            }
            entry.insert(
                "merged".to_owned(),
                serde_json::json!({
                    "samples": total,
                    "p50_ns": merged.value_at_quantile(0.50),
                    "p99_ns": merged.value_at_quantile(0.99),
                    "p999_ns": if perf_measurement::tail_publishable(total) && headline_ok {
                        serde_json::json!(merged.value_at_quantile(0.999))
                    } else {
                        serde_json::Value::Null
                    },
                    "max_ns": merged.max(),
                }),
            );
        }
        if arm.name == ARM_RING_OPEN {
            // Open-loop block scalars must agree with their checksummed
            // sidecars, exactly like the paired-gap scalars: the
            // manifest's results object is otherwise unprotected on its
            // way into summary.json.
            for a in &complete {
                let checks: [(&str, &str, f64); 5] = [
                    ("sched_to_completion.hist", "sched_p50_ns", 0.50),
                    ("sched_to_completion.hist", "sched_p99_ns", 0.99),
                    ("issue_to_completion.hist", "issue_p50_ns", 0.50),
                    ("issue_to_completion.hist", "issue_p99_ns", 0.99),
                    ("scheduler_lag.hist", "lag_p99_ns", 0.99),
                ];
                for (file, field, quantile) in checks {
                    let recomputed = evidence::read_histogram(a, file)?.value_at_quantile(quantile);
                    let recorded = a
                        .manifest
                        .results
                        .as_ref()
                        .and_then(|r| r[field].as_u64())
                        .ok_or_else(|| format!("{}: missing {field}", a.dir.display()))?;
                    if recomputed != recorded {
                        return Err(format!(
                            "{}: {field} {recorded} disagrees with the verified {file} \
                             value {recomputed}",
                            a.dir.display()
                        ));
                    }
                }
            }
        }
        // Record-backed arms: the manifest's results and outcomes are
        // compared against their checksummed record sidecar, so a
        // manifest edit to any scalar fails loudly. The serial arm's
        // histogram covers only its percentiles; the throughput arm has
        // no histogram at all.
        let record_file = match arm.name.as_str() {
            ARM_RING_SERIAL => Some("serial.json"),
            ARM_RING_OPEN => Some("open.json"),
            ARM_RING_THROUGHPUT => Some("throughput.json"),
            _ => None,
        };
        if let Some(file) = record_file {
            for a in &complete {
                evidence::require_declared(a, file)?;
                let raw = std::fs::read(a.dir.join(file))
                    .map_err(|err| format!("{}: {file}: {err}", a.dir.display()))?;
                let record: serde_json::Value = serde_json::from_slice(&raw)
                    .map_err(|err| format!("{}: {file}: {err}", a.dir.display()))?;
                let manifest_results = a
                    .manifest
                    .results
                    .clone()
                    .unwrap_or(serde_json::Value::Null);
                if record["results"] != manifest_results
                    || record["outcomes"] != serde_json::json!(a.manifest.outcomes)
                {
                    return Err(format!(
                        "{}: manifest results or outcomes disagree with the verified {file}",
                        a.dir.display()
                    ));
                }
            }
        }
        if arm.name == ARM_ATOMIC {
            // Every atomic result field is recomputable from the
            // checksummed batches.json record; the manifest's copy is
            // otherwise unprotected beyond the median the gap pairing
            // recomputes.
            for a in &complete {
                evidence::require_declared(a, "batches.json")?;
                let raw = std::fs::read(a.dir.join("batches.json"))
                    .map_err(|err| format!("{}: batches.json: {err}", a.dir.display()))?;
                let output: atomic::PingPongOutput = serde_json::from_slice(&raw)
                    .map_err(|err| format!("{}: batches.json: {err}", a.dir.display()))?;
                let mut means = output.batch_mean_rtt_ns.clone();
                let median = evidence::median(&mut means).unwrap_or(0.0);
                let batches = output.batch_mean_rtt_ns.len() as u64;
                let expected = serde_json::json!({
                    "median_batch_rtt_ns": median,
                    "min_batch_rtt_ns": means.first().copied().unwrap_or(0.0),
                    "max_batch_rtt_ns": means.last().copied().unwrap_or(0.0),
                    "exchanges_per_sec": output.exchanges_per_sec(),
                    "clock_bracket_ns": output.clock_bracket_ns,
                    "batches": batches,
                    "exchanges_per_batch": output.total_exchanges.checked_div(batches).unwrap_or(0),
                });
                let manifest_results = a
                    .manifest
                    .results
                    .clone()
                    .unwrap_or(serde_json::Value::Null);
                if expected != manifest_results {
                    return Err(format!(
                        "{}: manifest results disagree with the verified batches.json",
                        a.dir.display()
                    ));
                }
            }
        }
        let per_block: Vec<serde_json::Value> = complete
            .iter()
            .map(|a| {
                serde_json::json!({
                    "run_block": a.manifest.run_block,
                    "results": a.manifest.results,
                    "outcomes": a.manifest.outcomes,
                })
            })
            .collect();
        entry.insert("blocks".to_owned(), serde_json::Value::Array(per_block));
        let mut key = match arm.pair {
            Some((a, b)) => format!(
                "{}@{}-{},{}",
                arm.name,
                arm.class.clone().unwrap_or_default(),
                a,
                b
            ),
            None => arm.name.clone(),
        };
        // Operating points of one arm stay distinct in the summary; the
        // rate suffix matches the plan preview's `arm@class:rN` shape.
        if let Some(rate) = collection.as_ref().and_then(|c| c["rate_per_sec"].as_u64()) {
            key.push_str(&format!(":r{rate}"));
        }
        // Two groups can still share a key when they differ only in
        // non-rate collection settings (a resumed run mixing serial
        // measured_ops, say); a silent insert would replace one group's
        // evidence with the other's.
        if arms_summary.contains_key(&key) {
            let fingerprint = perf_measurement::sha256_hex(
                serde_json::to_string(&collection)
                    .map_err(|err| err.to_string())?
                    .as_bytes(),
            );
            key.push_str(&format!(":cfg-{}", &fingerprint[..8]));
            if arms_summary.contains_key(&key) {
                return Err(format!("duplicate summary group {key}"));
            }
        }
        arms_summary.insert(key, serde_json::Value::Object(entry));
    }

    let gaps = evidence::paired_gaps(&attempts)?;
    // Gap statistics never pool topology classes or CPU pairs: rows from
    // different classes or different ordered pairs measure different
    // hardware paths, so each (class, pair) gets its own median and
    // bootstrap interval.
    let mut gaps_by_class: std::collections::BTreeMap<String, (Vec<f64>, Vec<f64>)> =
        std::collections::BTreeMap::new();
    for g in &gaps {
        let label = format!(
            "{}@{},{}",
            g.class.clone().unwrap_or_default(),
            g.pair.0,
            g.pair.1
        );
        let entry = gaps_by_class.entry(label).or_default();
        entry.0.push(g.ratio);
        entry.1.push(g.gap_ns);
    }
    let gap_stats = if gaps_by_class.is_empty() {
        serde_json::Value::Null
    } else {
        let mut by_class = serde_json::Map::new();
        for (class, (mut gap_ratios, mut gap_ns)) in gaps_by_class {
            by_class.insert(
                class,
                serde_json::json!({
                    "blocks": gap_ratios.len(),
                    "median_gap_ns": evidence::median(&mut gap_ns),
                    "min_gap_ns": gap_ns.first(),
                    "max_gap_ns": gap_ns.last(),
                    "median_ratio": evidence::median(&mut gap_ratios),
                    "min_ratio": gap_ratios.first(),
                    "max_ratio": gap_ratios.last(),
                    "ratio_bootstrap_95": evidence::bootstrap_interval(&gap_ratios, 2000, 42),
                    "gap_ns_bootstrap_95": evidence::bootstrap_interval(&gap_ns, 2000, 42),
                }),
            );
        }
        serde_json::Value::Object(by_class)
    };

    let states: Vec<serde_json::Value> = attempts
        .iter()
        .map(|a| {
            serde_json::json!({
                "attempt": a.dir.file_name().map(|n| n.to_string_lossy().into_owned()),
                "arm": a.manifest.arm.name,
                "run_block": a.manifest.run_block,
                "state": a.manifest.state,
                "skip_reason": a.manifest.skip_reason,
                "fail_reason": a.manifest.fail_reason,
            })
        })
        .collect();

    let summary = serde_json::json!({
        "schema": evidence::SCHEMA_VERSION,
        "attempts": states,
        "arms": arms_summary,
        "gaps": gaps.iter().map(|g| serde_json::json!({
            "run_block": g.run_block,
            "class": g.class,
            "pair": g.pair,
            "atomic_rtt_ns": g.atomic_rtt_ns,
            "ring_p50_ns": g.ring_p50_ns,
            "gap_ns": g.gap_ns,
            "ratio": g.ratio,
        })).collect::<Vec<_>>(),
        "gap_stats": gap_stats,
    });
    let mut text = serde_json::to_string_pretty(&summary).map_err(|err| err.to_string())?;
    text.push('\n');
    Ok(text)
}

fn run_finalize_interrupted() -> i32 {
    let out = PathBuf::from(match env_var("MC_IPC_BUDGET_OUT") {
        Some(out) => out,
        None => {
            eprintln!("MC_IPC_BUDGET_OUT unset");
            return 1;
        }
    });
    match evidence::finalize_interrupted(&out) {
        Ok(finalized) => {
            for path in finalized {
                println!("INTERRUPTED {}", path.display());
            }
            0
        }
        Err(err) => {
            eprintln!("finalize-interrupted: {err}");
            1
        }
    }
}

// --- criterion scalar fixtures -------------------------------------------

/// Criterion output is a developer regression diagnostic; retained
/// HdrHistogram evidence owns every tail conclusion.
fn run_criterion() {
    let mut criterion = Criterion::default().configure_from_args();

    let topology = read_topology(Path::new("/")).ok();
    let allowed = effective_affinity().unwrap_or_else(|_| BTreeSet::new());
    let same_l3 = topology
        .as_ref()
        .and_then(|t| match auto_select(t, &allowed, Class::SameL3) {
            AutoSelection::Pair(a, b) => Some((a, b)),
            AutoSelection::Unavailable(reason) => {
                eprintln!("atomic_rtt: skipped ({reason})");
                None
            }
        });

    if let Some((a, b)) = same_l3 {
        let mut group = criterion.benchmark_group("atomic_rtt");
        group.bench_function("same_l3_full_rtt", |bencher| {
            bencher.iter_custom(|iters| timed_exchanges(a, b, iters).expect("valid pinned pair"));
        });
        group.finish();
        // Any pin the atomic fixture leaves on this thread propagates
        // into the child host spawned below (an unpinned spawn inherits
        // the parent's mask), time-slicing host and client on one core;
        // restore the schedulable set captured before any group ran.
        if allowed.is_empty() {
            eprintln!("atomic_rtt: affinity not restored (allowed CPU set is empty)");
        } else if let Err(err) = linux_topology::set_current_thread_affinity(&allowed) {
            eprintln!("atomic_rtt: affinity not restored ({err})");
        }
    }

    match ChildHost::spawn(None) {
        Ok(host) => {
            let mut probe = ring::SerialProbe::connect(host.publication()).expect("serial probe");
            let mut group = criterion.benchmark_group("serial_ring_rtt");
            group.bench_function("loopback_fixture_echo", |bencher| {
                bencher.iter_custom(|iters| probe.roundtrips(iters).expect("roundtrips"));
            });
            group.finish();
            drop(probe);
            drop(host);
        }
        Err(err) => eprintln!("serial_ring_rtt: skipped ({err})"),
    }

    criterion.final_summary();
}
