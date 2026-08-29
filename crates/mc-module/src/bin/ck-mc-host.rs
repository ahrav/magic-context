//! `ck-mc-host`: the production lifecycle/serve executable (plan U2, KTD1).
//!
//! Leaf binary: depends on `mc-module` + `mc-host`, never the reverse.
//! Commands: `serve` (daemon mode), `start`, `stop`, `restart`, `probe`,
//! plus side-effect-free `--version` and `release-info`. Every lifecycle
//! command emits exactly one `magic-context.daemon/v1` JSON object on
//! stdout; exit 0 means `ok:true`, exit 1 an operational failure, and
//! exit 2 a usage error with no lifecycle call.

#![deny(unsafe_code)]

#[path = "ck_mc_host/serve.rs"]
mod serve;
#[path = "ck_mc_host/spawn.rs"]
mod spawn;

use std::collections::BTreeSet;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mc_host::generation::{
    GenerationError, GenerationStore, SourceSpec, StageMeta, ValidatedGeneration,
};
use mc_host::{
    Client, InstanceError, LifecycleProbe, LifecycleState, LifecycleTransactionLock,
    NamespaceAnchor, ProbeFreshness,
};
use mc_module::release_contract;

// -------------------------------------------------------------------------
// Deadlines (plan budget table, KTD22). Every phase receives
// min(phase hard cap, aggregate remaining); the aggregate always wins.
// -------------------------------------------------------------------------

/// Fresh Linux request-to-authenticated-transport outer aggregate (hard).
const OUTER_AGGREGATE: Duration = Duration::from_secs(60);
/// Spawn/publication/auth phase (hard).
const SPAWN_PUBLICATION_AUTH: Duration = Duration::from_secs(3);
/// Stop teardown: committed shutdown until publication removal plus both
/// fences acquirable, bounded above the runtime's own shutdown deadline.
const STOP_TEARDOWN: Duration = Duration::from_secs(10);
/// Bounded settle window for an observed `starting`/`stopping` transition
/// before reporting `lifecycle_busy`.
const TRANSITION_SETTLE: Duration = Duration::from_secs(5);
const REPROBE_INTERVAL: Duration = Duration::from_millis(100);

/// Dev/test-only phase-cap override in milliseconds, clamped to the outer
/// aggregate. Lengthens the spawn/publication/auth and teardown phase caps
/// for slow debug-build CI hosts; the aggregate deadline still binds, so a
/// poisoned value cannot create an unbounded wait.
const PHASE_CAP_ENV: &str = "CK_MC_HOST_TEST_PHASE_CAP_MS";

fn phase_cap(default: Duration) -> Duration {
    let Some(raw) = std::env::var_os(PHASE_CAP_ENV) else {
        return default;
    };
    match raw.to_str().and_then(|value| value.parse::<u64>().ok()) {
        Some(ms) if ms > 0 => Duration::from_millis(ms).min(OUTER_AGGREGATE),
        _ => default,
    }
}

/// KTD22 nesting: the lesser of the phase's hard cap and aggregate remaining.
fn phase_deadline(outer: Instant, cap: Duration) -> Instant {
    let now = Instant::now();
    let remaining = outer.saturating_duration_since(now);
    now + cap.min(remaining)
}

// -------------------------------------------------------------------------
// Closed v1 result vocabulary (KTD12). Remediations mirror the embedded
// release contract's precedence table; a unit test pins the mapping to the
// generated JSON.
// -------------------------------------------------------------------------

const SCHEMA: &str = "magic-context.daemon/v1";

fn remediation_for(reason: &'static str) -> Option<&'static str> {
    match reason {
        "internal_error" => Some("report_bug"),
        "no_data_dir" | "unsupported_filesystem" => Some("set_data_directory"),
        "unsupported_platform" => Some("use_supported_platform"),
        "unsupported_install_layout" => Some("use_supported_install_layout"),
        "unsupported_state_schema" => Some("align_versions"),
        "native_payload_invalid" => Some("reinstall_magic_context"),
        "native_payload_missing" => Some("install_native_payload"),
        "insufficient_storage" => Some("free_storage"),
        "native_probe_unavailable" => Some("run_daemon_restart"),
        "wedged"
        | "publication_invalid"
        | "publication_stale"
        | "publication_missing"
        | "authentication_failed"
        | "shutdown_timeout"
        | "startup_timeout" => Some("inspect_daemon_process"),
        "unsupported_proof_version"
        | "incompatible_control"
        | "incompatible_daemon"
        | "incompatible_module"
        | "incompatible_epochs" => Some("align_versions"),
        "lifecycle_busy" | "storage_starting" | "synapse_starting" | "stopping" | "starting" => {
            Some("wait_and_retry")
        }
        "storage_unavailable" => Some("inspect_storage"),
        "synapse_degraded" => Some("inspect_synapse"),
        "not_running" => Some("run_daemon_start"),
        // Non-failing reasons.
        _ => None,
    }
}

#[derive(serde::Serialize, Clone, Copy)]
struct Effects {
    stop_committed: bool,
    start_committed: bool,
}

#[derive(serde::Serialize)]
struct ReadinessRecord {
    state: &'static str,
    reason: &'static str,
}

#[derive(serde::Serialize)]
struct Readiness {
    transport: ReadinessRecord,
}

#[derive(serde::Serialize)]
struct Check {
    id: &'static str,
    status: &'static str,
    reason: &'static str,
    remediation: Option<&'static str>,
}

#[derive(serde::Serialize, Default)]
struct Versions {
    release: Option<&'static str>,
    proof: Option<&'static str>,
    daemon: Option<String>,
    magic_context: Option<String>,
    synapse: Option<String>,
    broca: Option<String>,
}

impl Versions {
    fn local() -> Self {
        Versions {
            release: Some(release_contract::RELEASE_VERSION),
            ..Versions::default()
        }
    }
}

#[derive(serde::Serialize)]
struct DaemonResult {
    schema: &'static str,
    command: &'static str,
    ok: bool,
    state: &'static str,
    reason: &'static str,
    remediation: Option<&'static str>,
    effects: Option<Effects>,
    readiness: Option<Readiness>,
    checks: Vec<Check>,
    versions: Versions,
}

impl DaemonResult {
    fn new(command: &'static str, ok: bool, state: &'static str, reason: &'static str) -> Self {
        DaemonResult {
            schema: SCHEMA,
            command,
            ok,
            state,
            reason,
            remediation: remediation_for(reason),
            effects: None,
            readiness: None,
            checks: Vec::new(),
            versions: Versions::local(),
        }
    }

    fn with_effects(mut self, effects: Effects) -> Self {
        self.effects = Some(effects);
        self
    }

    fn finish(mut self) -> Self {
        // Applicable-check derivation from the final verdict: the fences
        // check reports lock coherence, the publication check reports
        // whether a running incarnation's credential was observed. IDs stay
        // lexicographically sorted.
        let fences = match self.state {
            "wedged" => ("fail", "wedged"),
            "unavailable" => ("skip", "healthy"),
            _ => ("pass", "healthy"),
        };
        let publication = match self.state {
            "running" => ("pass", "healthy"),
            "wedged" => ("fail", "wedged"),
            _ => ("skip", "healthy"),
        };
        let mut checks = std::mem::take(&mut self.checks);
        checks.push(Check {
            id: "lifecycle.fences",
            status: fences.0,
            reason: fences.1,
            remediation: remediation_for(fences.1),
        });
        checks.push(Check {
            id: "lifecycle.publication",
            status: publication.0,
            reason: publication.1,
            remediation: remediation_for(publication.1),
        });
        checks.sort_by(|a, b| a.id.cmp(b.id));
        self.checks = checks;
        self
    }
}

// -------------------------------------------------------------------------
// Argument parsing: strict and bounded. Anything unrecognized is a usage
// error (exit 2) with no lifecycle call.
// -------------------------------------------------------------------------

enum Command {
    Version,
    ReleaseInfo,
    InputLockDigest,
    Probe,
    Start {
        payload_dir: Option<PathBuf>,
        payload_manifest_digest: Option<String>,
    },
    Stop,
    Restart {
        payload_dir: Option<PathBuf>,
        payload_manifest_digest: Option<String>,
    },
    Serve,
}

const USAGE: &str = "usage: ck-mc-host <serve|start|stop|restart|probe|release-info|input-lock-digest> [--payload-dir <dir> --payload-manifest-digest <sha256>] | --version";

fn parse_args(args: &[std::ffi::OsString]) -> Result<Command, String> {
    let mut iter = args.iter();
    let Some(first) = iter.next() else {
        return Err("missing command".to_owned());
    };
    let Some(first) = first.to_str() else {
        return Err("command is not valid UTF-8".to_owned());
    };
    let mut payload_dir: Option<PathBuf> = None;
    let mut payload_manifest_digest: Option<String> = None;
    let takes_payload = matches!(first, "start" | "restart");
    while let Some(arg) = iter.next() {
        let Some(arg) = arg.to_str() else {
            return Err("argument is not valid UTF-8".to_owned());
        };
        if takes_payload && arg == "--payload-dir" {
            if payload_dir.is_some() {
                return Err("duplicate --payload-dir".to_owned());
            }
            let Some(value) = iter.next() else {
                return Err("--payload-dir requires a value".to_owned());
            };
            if value.is_empty() {
                return Err("--payload-dir requires a nonempty value".to_owned());
            }
            payload_dir = Some(PathBuf::from(value));
        } else if takes_payload && arg == "--payload-manifest-digest" {
            if payload_manifest_digest.is_some() {
                return Err("duplicate --payload-manifest-digest".to_owned());
            }
            let Some(value) = iter.next().and_then(|value| value.to_str()) else {
                return Err("--payload-manifest-digest requires a UTF-8 value".to_owned());
            };
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                return Err("--payload-manifest-digest requires lowercase SHA-256".to_owned());
            }
            payload_manifest_digest = Some(value.to_owned());
        } else {
            return Err(format!("unexpected argument: {arg}"));
        }
    }
    match first {
        "--version" => Ok(Command::Version),
        "release-info" => Ok(Command::ReleaseInfo),
        "input-lock-digest" => Ok(Command::InputLockDigest),
        "probe" => Ok(Command::Probe),
        "start" => Ok(Command::Start {
            payload_dir,
            payload_manifest_digest,
        }),
        "stop" => Ok(Command::Stop),
        "restart" => Ok(Command::Restart {
            payload_dir,
            payload_manifest_digest,
        }),
        "serve" => Ok(Command::Serve),
        other => Err(format!("unknown command: {other}")),
    }
}

// -------------------------------------------------------------------------
// Reason mapping from mc-host error types. Native error detail is tainted
// and never serialized; only closed static reasons leave this process.
// -------------------------------------------------------------------------

/// (state, reason) for a failed operation.
fn instance_failure(error: &InstanceError) -> (&'static str, &'static str) {
    match error {
        InstanceError::NoDataDir => ("unavailable", "no_data_dir"),
        InstanceError::UnsupportedPlatform => ("stopped", "unsupported_platform"),
        InstanceError::AlreadyRunning => ("stopped", "lifecycle_busy"),
        InstanceError::UnsupportedStateSchema { .. } => ("wedged", "unsupported_state_schema"),
        InstanceError::Insecure { .. } | InstanceError::NamespaceDrift { .. } => {
            ("wedged", "wedged")
        }
        InstanceError::Io { .. } | InstanceError::InvalidPayloadDigest | InstanceError::Random => {
            ("wedged", "internal_error")
        }
    }
}

fn generation_failure(error: &GenerationError) -> (&'static str, &'static str) {
    match error {
        GenerationError::InsufficientStorage => ("stopped", "insufficient_storage"),
        GenerationError::NativePayloadInvalid { .. } => ("stopped", "native_payload_invalid"),
        GenerationError::UnsupportedStateSchema => ("stopped", "unsupported_state_schema"),
        GenerationError::Instance(inner) => instance_failure(inner),
    }
}

fn probe_state(state: LifecycleState) -> &'static str {
    match state {
        LifecycleState::Stopped => "stopped",
        LifecycleState::Starting => "starting",
        LifecycleState::Running => "running",
        LifecycleState::Stopping => "stopping",
        LifecycleState::Wedged => "wedged",
    }
}

// -------------------------------------------------------------------------
// Shared lifecycle plumbing.
// -------------------------------------------------------------------------

fn probe() -> Result<LifecycleProbe, InstanceError> {
    mc_host::probe_lifecycle(None, &ProbeFreshness::default())
}

/// Re-probes through observed `starting`/`stopping` transitions until they
/// settle or the bounded window expires. Never waits unbounded while the
/// caller holds the transaction lock.
fn settle_probe(deadline: Instant) -> Result<LifecycleProbe, InstanceError> {
    loop {
        let observed = probe()?;
        match observed.state {
            LifecycleState::Starting | LifecycleState::Stopping if Instant::now() < deadline => {
                std::thread::sleep(REPROBE_INTERVAL);
            }
            _ => return Ok(observed),
        }
    }
}

fn publication_path() -> Result<PathBuf, InstanceError> {
    Ok(mc_host::runtime_dir_path(None)?.join(mc_host::CONNECTION_FILE_NAME))
}

fn daemon_log_path() -> Result<PathBuf, InstanceError> {
    // The coordination root is stable, owner-only, and already exists for
    // any mutator (transaction-lock acquisition created it), which the
    // replaceable managed `run` subtree does not guarantee at spawn time.
    Ok(mc_host::coordination_dir_path(None)?.join("daemon.log"))
}

struct Runtime {
    inner: tokio::runtime::Runtime,
}

impl Runtime {
    fn new() -> Result<Self, &'static str> {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map(|inner| Runtime { inner })
            .map_err(|_| "tokio runtime construction failed")
    }

    /// One bounded authenticated connect (bearer handshake) then close.
    /// Returns the proof-authenticated daemon version, never publication metadata.
    fn authenticate(&self, publication: &Path) -> Option<String> {
        let path = publication.to_path_buf();
        self.inner.block_on(async move {
            match Client::connect(&path).await {
                Ok(client) => {
                    let daemon_ver = client.daemon_ver().to_owned();
                    let _ = client.close().await;
                    Some(daemon_ver)
                }
                Err(_) => None,
            }
        })
    }

    /// Authenticated `host.shutdown`; `Ok` is the full-frame acknowledgement
    /// commit point (KTD4).
    fn shutdown(&self, publication: &Path) -> Result<(), &'static str> {
        let path = publication.to_path_buf();
        self.inner.block_on(async move {
            let client = Client::connect(&path)
                .await
                .map_err(|_| "authentication_failed")?;
            let result = client.host_shutdown().await;
            let _ = client.close().await;
            result.map_err(|_| "shutdown_failed")
        })
    }
}

/// Untrusted publication daemon version for observational output only.
/// Authorization and compatibility never consume this value.
fn publication_daemon_ver(observed: &LifecycleProbe) -> Option<String> {
    observed
        .publication
        .as_ref()
        .map(|publication| publication.daemon_ver.clone())
}

/// Parses `mc-host/X.Y.Z` against the embedded half-open supported daemon
/// range from the release contract.
fn daemon_version_compatible(daemon_ver: &str) -> bool {
    /// One canonical numeric component: digits only, and no leading zero
    /// unless the component is exactly `0`. This is the same grammar the
    /// plugin's `CANONICAL_SEMVER` enforces in
    /// `mc-host-lifecycle/compatibility.ts`. Deferring to `str::parse` alone
    /// would accept `00`, `01`, and `+1`, so the CLI would call a daemon
    /// healthy that the client refuses as `incompatible_daemon`.
    fn component(part: &str) -> Option<u64> {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        if part.len() > 1 && part.starts_with('0') {
            return None;
        }
        part.parse().ok()
    }
    fn triple(version: &str) -> Option<[u64; 3]> {
        let mut parts = version.split('.');
        let major = component(parts.next()?)?;
        let minor = component(parts.next()?)?;
        let patch = component(parts.next()?)?;
        if parts.next().is_some() {
            return None;
        }
        Some([major, minor, patch])
    }
    let Some(version) = daemon_ver.strip_prefix("mc-host/").and_then(triple) else {
        return false;
    };
    let contract: serde_json::Value = serde_json::from_str(release_contract::RELEASE_CONTRACT_JSON)
        .expect("embedded release contract parses");
    let range = &contract["versions"]["supported_daemon_range"];
    let bound = |key: &str| {
        range[key]
            .as_str()
            .and_then(triple)
            .expect("contract daemon range bounds parse")
    };
    version >= bound("min_inclusive") && version < bound("max_exclusive")
}

// -------------------------------------------------------------------------
// probe
// -------------------------------------------------------------------------

/// Read-only, no-create observation. Mirrors the plan's `status` row
/// semantics: a coherent `stopped` observation is `not_running` (ok:false),
/// `running` with a contract-conforming publication is `healthy` (ok:true).
/// No connection is dialed: probe stays purely observational, so `proof`
/// and readiness stay null and `versions.daemon` is publication-diagnostic.
fn cmd_probe() -> DaemonResult {
    let observed = match probe() {
        Ok(observed) => observed,
        Err(error) => {
            let (state, reason) = instance_failure(&error);
            return DaemonResult::new("probe", false, state, reason);
        }
    };
    let state = probe_state(observed.state);
    let (ok, reason) = match observed.state {
        LifecycleState::Running => (true, "healthy"),
        LifecycleState::Stopped if observed.reason == "unsupported_state_schema" => {
            (false, "unsupported_state_schema")
        }
        LifecycleState::Stopped => (false, "not_running"),
        LifecycleState::Starting => (false, "starting"),
        LifecycleState::Stopping => (false, "stopping"),
        LifecycleState::Wedged if observed.reason == "unsupported_state_schema" => {
            (false, "unsupported_state_schema")
        }
        LifecycleState::Wedged => (false, "wedged"),
    };
    let mut result = DaemonResult::new("probe", ok, state, reason);
    result.versions.daemon = publication_daemon_ver(&observed);
    result
}

// -------------------------------------------------------------------------
// start
// -------------------------------------------------------------------------

/// The staged start pipeline shared by `start` and `restart`'s successor
/// phase. The caller already holds the transaction lock and supplies the
/// aggregate deadline. Returns the terminal (ok, state, reason) triple plus
/// authenticated-transport readiness.
struct StartOutcome {
    ok: bool,
    start_committed: bool,
    state: &'static str,
    reason: &'static str,
    daemon_ver: Option<String>,
    generation_check: Option<(&'static str, &'static str)>,
}

fn start_phase(
    runtime: &Runtime,
    payload_dir: Option<&Path>,
    payload_manifest_digest: Option<&str>,
    anchor: &NamespaceAnchor,
    outer: Instant,
    launcher_envelope: serve::PreparedLauncherEnvelope,
) -> StartOutcome {
    let fail = |state: &'static str, reason: &'static str| StartOutcome {
        ok: false,
        start_committed: false,
        state,
        reason,
        daemon_ver: None,
        generation_check: Some(("fail", reason)),
    };

    // Validate or stage the requested generation (KTD9).
    let (digest, generation_launcher) =
        match resolve_generation(payload_dir, payload_manifest_digest) {
            Ok(generation) => generation,
            Err((state, reason)) => return fail(state, reason),
        };

    // Namespace identity must still hold before the spawn commit (KTD2).
    if anchor.verify().is_err() {
        return fail("wedged", "wedged");
    }

    let envelope = launcher_envelope.to_startup(digest);
    let envelope_bytes = serde_json::to_vec(&envelope).expect("envelope serializes");
    let log_path = match daemon_log_path() {
        Ok(path) => path,
        Err(_) => return fail("stopped", "internal_error"),
    };
    if spawn::spawn_detached(&log_path, &envelope_bytes, generation_launcher).is_err() {
        return fail("stopped", "internal_error");
    }

    // Bounded wait for publication evidence plus authentication — never for
    // the child PID.
    let deadline = phase_deadline(outer, phase_cap(SPAWN_PUBLICATION_AUTH));
    let publication = match publication_path() {
        Ok(path) => path,
        Err(_) => return fail("stopped", "internal_error"),
    };
    loop {
        if let Some(daemon_ver) = publication
            .exists()
            .then(|| runtime.authenticate(&publication))
            .flatten()
        {
            if !daemon_version_compatible(&daemon_ver) {
                return StartOutcome {
                    ok: false,
                    start_committed: true,
                    state: "running",
                    reason: "incompatible_daemon",
                    daemon_ver: Some(daemon_ver),
                    generation_check: Some(("pass", "healthy")),
                };
            }
            if launcher_envelope.commit_selection(&publication).is_err() {
                return match stop_phase(runtime, outer) {
                    (_, Ok(())) => StartOutcome {
                        ok: false,
                        start_committed: true,
                        state: "stopped",
                        reason: "internal_error",
                        daemon_ver: Some(daemon_ver),
                        generation_check: Some(("fail", "internal_error")),
                    },
                    (_, Err((state, reason))) => StartOutcome {
                        ok: false,
                        start_committed: true,
                        state,
                        reason,
                        daemon_ver: Some(daemon_ver),
                        generation_check: Some(("fail", "internal_error")),
                    },
                };
            }
            return StartOutcome {
                ok: true,
                start_committed: true,
                state: "running",
                reason: "started",
                daemon_ver: Some(daemon_ver),
                generation_check: Some(("pass", "healthy")),
            };
        }
        if Instant::now() >= deadline {
            let state = match probe().map(|observed| observed.state) {
                Ok(LifecycleState::Starting) => "starting",
                _ => "wedged",
            };
            return StartOutcome {
                ok: false,
                start_committed: false,
                state,
                reason: "startup_timeout",
                daemon_ver: None,
                generation_check: Some(("pass", "healthy")),
            };
        }
        std::thread::sleep(REPROBE_INTERVAL);
    }
}

/// An explicit verified payload root stages a candidate. Without one, only a
/// fully valid retained current generation may start.
fn resolve_generation(
    payload_dir: Option<&Path>,
    payload_manifest_digest: Option<&str>,
) -> Result<(String, Option<std::os::fd::OwnedFd>), (&'static str, &'static str)> {
    match payload_dir {
        Some(dir) => {
            let store = GenerationStore::open(None).map_err(|e| generation_failure(&e))?;
            let mut protected = BTreeSet::new();
            if let Ok(mc_host::generation::CurrentProfile::Current(current)) = store.read_current()
            {
                protected.insert(current);
            }
            // Prune unreferenced complete generations and stale temps under
            // the held transaction lock before staging.
            store
                .prune(&protected)
                .map_err(|e| generation_failure(&e))?;
            let payload = payload_sources(dir, payload_manifest_digest)?;
            let meta = StageMeta {
                target: host_target().to_owned(),
                release_contract_sha256: release_contract::RELEASE_CONTRACT_SHA256.to_owned(),
                // Dev/test staging is explicitly unqualified (U9): the value
                // is a self-describing marker, not a placeholder hash in a
                // production payload.
                inputs_lock_sha256: payload.inputs_lock_sha256,
                source_payload_manifest_sha256: payload_manifest_digest
                    .unwrap_or("unqualified-dev-manifest")
                    .to_owned(),
            };
            let digest = store
                .stage_and_promote(&payload.sources, &meta, &protected)
                .map_err(|e| generation_failure(&e))?;
            // Complete revalidation of the promoted generation before spawn.
            let validated = store
                .validate(&digest)
                .map_err(|e| generation_failure(&e))?;
            let launcher = resolve_generation_launcher(&validated)?;
            Ok((digest, launcher))
        }
        None => {
            let store = GenerationStore::open_probe(None)
                .map_err(|e| generation_failure(&e))?
                .ok_or(("stopped", "native_payload_missing"))?;
            match store.read_current().map_err(|e| generation_failure(&e))? {
                mc_host::generation::CurrentProfile::Current(digest) => {
                    let validated = store
                        .validate(&digest)
                        .map_err(|e| generation_failure(&e))?;
                    if payload_manifest_digest.is_some_and(|expected| {
                        validated.manifest.source_payload_manifest_sha256 != expected
                    }) {
                        return Err(("stopped", "native_payload_invalid"));
                    }
                    let launcher = resolve_generation_launcher(&validated)?;
                    Ok((digest, launcher))
                }
                mc_host::generation::CurrentProfile::Absent => {
                    Err(("stopped", "native_payload_missing"))
                }
                mc_host::generation::CurrentProfile::Quarantined => {
                    Err(("stopped", "unsupported_state_schema"))
                }
            }
        }
    }
}

fn resolve_generation_launcher(
    validated: &ValidatedGeneration,
) -> Result<Option<std::os::fd::OwnedFd>, (&'static str, &'static str)> {
    const PRODUCTION_LAUNCHER: &str = "payload/bin/ck-mc-host";
    match validated.open_verified_file(PRODUCTION_LAUNCHER) {
        Ok(launcher) => Ok(Some(launcher)),
        Err(_)
            if validated.manifest.source_payload_manifest_sha256 == "unqualified-dev-manifest"
                && spawn::test_self_exec_allowed() =>
        {
            Ok(None)
        }
        Err(_) => Err(("stopped", "native_payload_invalid")),
    }
}

fn host_target() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64-gnu"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x64"
    }
    #[cfg(not(any(
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64")
    )))]
    {
        "unsupported"
    }
}

struct PayloadSources {
    sources: Vec<SourceSpec>,
    inputs_lock_sha256: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustedPayloadManifest {
    schema: String,
    release: TrustedReleaseIdentity,
    release_contract_sha256: String,
    production_inputs_lock_sha256: String,
    mode: String,
    package: TrustedPackageIdentity,
    platform_floor: serde_json::Value,
    synapse: String,
    launcher: String,
    files: Vec<TrustedPayloadFile>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustedReleaseIdentity {
    id: String,
    version: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustedPackageIdentity {
    name: String,
    version: String,
    target: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustedPayloadFile {
    path: String,
    #[serde(rename = "type")]
    file_type: String,
    size: u64,
    mode: String,
    sha256: String,
}

fn payload_sources(
    dir: &Path,
    expected_manifest_digest: Option<&str>,
) -> Result<PayloadSources, (&'static str, &'static str)> {
    if let Some(expected) = expected_manifest_digest {
        return trusted_payload_sources(dir, expected);
    }
    Ok(PayloadSources {
        sources: unqualified_payload_sources(dir)?,
        inputs_lock_sha256: "unqualified-dev-inputs".to_owned(),
    })
}

fn trusted_payload_sources(
    dir: &Path,
    expected_manifest_digest: &str,
) -> Result<PayloadSources, (&'static str, &'static str)> {
    use sha2::Digest;

    let invalid = ("stopped", "native_payload_invalid");
    let manifest_path = dir.join("payload-manifest.json");
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&manifest_path)
        .map_err(|_| invalid)?;
    let meta = file.metadata().map_err(|_| invalid)?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > 1024 * 1024 {
        return Err(invalid);
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut bytes).map_err(|_| invalid)?;
    let canonical = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    if canonical.contains(&b'\n')
        || format!("{:x}", sha2::Sha256::digest(canonical)) != expected_manifest_digest
    {
        return Err(invalid);
    }
    let manifest: TrustedPayloadManifest =
        serde_json::from_slice(canonical).map_err(|_| invalid)?;
    let expected_package = match host_target() {
        "linux-x64-gnu" => "@cortexkit/mc-host-linux-x64-gnu",
        "darwin-arm64" => "@cortexkit/mc-host-darwin-arm64",
        "darwin-x64" => "@cortexkit/mc-host-darwin-x64",
        _ => return Err(invalid),
    };
    let _ = (&manifest.platform_floor, &manifest.synapse);
    if manifest.schema != "magic-context.mc-host-payload-manifest/v1"
        || manifest.release.id != "mc-host-release"
        || manifest.release.version != release_contract::RELEASE_VERSION
        || manifest.release_contract_sha256 != release_contract::RELEASE_CONTRACT_SHA256
        || manifest.mode != "production"
        || manifest.package.name != expected_package
        || manifest.package.version != release_contract::RELEASE_VERSION
        || manifest.package.target != host_target()
        || manifest.launcher != "payload/bin/ck-mc-host"
        || manifest.production_inputs_lock_sha256.len() != 64
        || !manifest
            .production_inputs_lock_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(invalid);
    }
    let mut sources = Vec::with_capacity(manifest.files.len());
    let mut previous: Option<&str> = None;
    let mut launcher_seen = false;
    for entry in &manifest.files {
        if entry.file_type != "file"
            || entry.size == 0
            || entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || !entry.path.starts_with("payload/")
            || entry
                .path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || previous.is_some_and(|value| value >= entry.path.as_str())
        {
            return Err(invalid);
        }
        previous = Some(&entry.path);
        let executable = match entry.mode.as_str() {
            "755" => true,
            "644" => false,
            _ => return Err(invalid),
        };
        if entry.path == manifest.launcher {
            launcher_seen = true;
            if !executable {
                return Err(invalid);
            }
        }
        sources.push(SourceSpec {
            rel_path: entry.path.clone(),
            source: dir.join(&entry.path),
            executable,
            expected_size: Some(entry.size),
            expected_sha256: Some(entry.sha256.clone()),
        });
    }
    if !launcher_seen || sources.is_empty() {
        return Err(invalid);
    }
    Ok(PayloadSources {
        sources,
        inputs_lock_sha256: manifest.production_inputs_lock_sha256,
    })
}

/// Enumerates a dev payload directory into sorted staging sources. Only
/// regular files are accepted; symlinks and special files are rejected.
fn unqualified_payload_sources(
    dir: &Path,
) -> Result<Vec<SourceSpec>, (&'static str, &'static str)> {
    use std::os::unix::fs::PermissionsExt;
    fn walk(
        base: &Path,
        rel: &str,
        out: &mut Vec<SourceSpec>,
    ) -> Result<(), (&'static str, &'static str)> {
        let invalid = ("stopped", "native_payload_invalid");
        let dir_path = if rel.is_empty() {
            base.to_path_buf()
        } else {
            base.join(rel)
        };
        let entries = std::fs::read_dir(&dir_path).map_err(|_| invalid)?;
        for entry in entries {
            let entry = entry.map_err(|_| invalid)?;
            let name = entry.file_name().into_string().map_err(|_| invalid)?;
            let child_rel = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let meta = entry.file_type().map_err(|_| invalid)?;
            if meta.is_symlink() {
                return Err(invalid);
            }
            if meta.is_dir() {
                walk(base, &child_rel, out)?;
            } else if meta.is_file() {
                let metadata = entry.metadata().map_err(|_| invalid)?;
                out.push(SourceSpec {
                    rel_path: child_rel,
                    source: base.join(rel).join(entry.file_name()),
                    executable: metadata.permissions().mode() & 0o111 != 0,
                    expected_size: None,
                    expected_sha256: None,
                });
            } else {
                return Err(invalid);
            }
        }
        Ok(())
    }
    let mut sources = Vec::new();
    walk(dir, "", &mut sources)?;
    if sources.is_empty() {
        return Err(("stopped", "native_payload_invalid"));
    }
    sources.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(sources)
}

fn prepare_launcher_envelope(
    envelope: serve::LauncherEnvelope,
    mode: serve::SelectionMode<'_>,
) -> Result<serve::PreparedLauncherEnvelope, &'static str> {
    let data_dir = mc_host::runtime_dir_path(None)
        .ok()
        .and_then(|run_dir| {
            run_dir
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
        })
        .ok_or("lifecycle data directory is unavailable")?;
    envelope.prepare(data_dir, mode)
}

fn cmd_start(
    payload_dir: Option<&Path>,
    payload_manifest_digest: Option<&str>,
    launcher_envelope: serve::LauncherEnvelope,
) -> DaemonResult {
    let command = "start";
    let outer = Instant::now() + OUTER_AGGREGATE;
    let runtime = match Runtime::new() {
        Ok(runtime) => runtime,
        Err(_) => return DaemonResult::new(command, false, "stopped", "internal_error"),
    };

    // Serialized lifecycle transaction (KTD2); bounded acquisition.
    let _tx = match LifecycleTransactionLock::acquire_exclusive(None) {
        Ok(tx) => tx,
        Err(error) => {
            let (state, reason) = instance_failure(&error);
            return DaemonResult::new(command, false, state, reason);
        }
    };
    let anchor = match NamespaceAnchor::capture(None) {
        Ok(anchor) => anchor,
        Err(error) => {
            let (state, reason) = instance_failure(&error);
            return DaemonResult::new(command, false, state, reason);
        }
    };
    let observed = match settle_probe(phase_deadline(outer, TRANSITION_SETTLE)) {
        Ok(observed) => observed,
        Err(error) => {
            let (state, reason) = instance_failure(&error);
            return DaemonResult::new(command, false, state, reason);
        }
    };
    match observed.state {
        LifecycleState::Running => {
            let publication = match publication_path() {
                Ok(path) => path,
                Err(_) => return DaemonResult::new(command, false, "running", "internal_error"),
            };
            let Some(daemon_ver) = runtime.authenticate(&publication) else {
                return DaemonResult::new(command, false, "running", "authentication_failed");
            };
            if !daemon_version_compatible(&daemon_ver) {
                let mut result =
                    DaemonResult::new(command, false, "running", "incompatible_daemon");
                result.versions.daemon = Some(daemon_ver);
                return result;
            }
            let credential_identity_key = match serve::credential_identity_key(&publication) {
                Ok(key) => key,
                Err(_) => {
                    return DaemonResult::new(command, false, "running", "authentication_failed")
                }
            };
            let prepared = match prepare_launcher_envelope(
                launcher_envelope,
                serve::SelectionMode::Running {
                    credential_identity_key: &credential_identity_key,
                    require_previous_credentials: false,
                },
            ) {
                Ok(prepared) => prepared,
                Err("unsupported active harness selection schema") => {
                    return DaemonResult::new(command, false, "wedged", "unsupported_state_schema")
                }
                Err(_) => {
                    return DaemonResult::new(command, false, "running", "harness_unavailable")
                }
            };
            if prepared.changed {
                return DaemonResult::new(command, false, "running", "harness_unavailable");
            }
            let mut result = DaemonResult::new(command, true, "running", "already_running");
            result.versions.daemon = Some(daemon_ver);
            result.versions.proof = Some("current");
            result.readiness = Some(Readiness {
                transport: ReadinessRecord {
                    state: "ready",
                    reason: "healthy",
                },
            });
            result
        }
        LifecycleState::Starting | LifecycleState::Stopping => DaemonResult::new(
            command,
            false,
            probe_state(observed.state),
            "lifecycle_busy",
        ),
        LifecycleState::Wedged => {
            let reason = if observed.reason == "unsupported_state_schema" {
                "unsupported_state_schema"
            } else {
                "wedged"
            };
            DaemonResult::new(command, false, "wedged", reason)
        }
        LifecycleState::Stopped => {
            let prepared =
                match prepare_launcher_envelope(launcher_envelope, serve::SelectionMode::Fresh) {
                    Ok(prepared) => prepared,
                    Err("unsupported active harness selection schema") => {
                        return DaemonResult::new(
                            command,
                            false,
                            "wedged",
                            "unsupported_state_schema",
                        )
                    }
                    Err(_) => {
                        return DaemonResult::new(command, false, "stopped", "harness_unavailable")
                    }
                };
            let outcome = start_phase(
                &runtime,
                payload_dir,
                payload_manifest_digest,
                &anchor,
                outer,
                prepared,
            );
            start_outcome_result(command, outcome, None)
        }
    }
}

fn start_outcome_result(
    command: &'static str,
    outcome: StartOutcome,
    effects: Option<Effects>,
) -> DaemonResult {
    let mut result = DaemonResult::new(command, outcome.ok, outcome.state, outcome.reason);
    result.versions.daemon = outcome.daemon_ver;
    if outcome.ok {
        result.versions.proof = Some("current");
        result.readiness = Some(Readiness {
            transport: ReadinessRecord {
                state: "ready",
                reason: "healthy",
            },
        });
    }
    if let Some((status, reason)) = outcome.generation_check {
        result.checks.push(Check {
            id: "artifact.current_generation",
            status,
            reason,
            remediation: remediation_for(reason),
        });
    }
    if let Some(effects) = effects {
        result.effects = Some(effects);
    }
    result
}

// -------------------------------------------------------------------------
// stop
// -------------------------------------------------------------------------

/// Committed-stop phase shared by `stop` and `restart`. The caller holds the
/// transaction lock and has already observed `Running`. Returns
/// `(stop_committed, terminal)` where terminal is `Ok(())` for a completed
/// teardown or the (state, reason) failure.
fn stop_phase(
    runtime: &Runtime,
    outer: Instant,
) -> (bool, Result<(), (&'static str, &'static str)>) {
    let publication = match publication_path() {
        Ok(path) => path,
        Err(_) => return (false, Err(("running", "internal_error"))),
    };
    match runtime.shutdown(&publication) {
        Ok(()) => {}
        Err("authentication_failed") => return (false, Err(("running", "authentication_failed"))),
        // A response-in-flight attempt that did not settle: not committed.
        Err(_) => return (false, Err(("running", "lifecycle_busy"))),
    }
    // Full-frame acknowledgement received: the stop is committed (KTD4).
    let deadline = phase_deadline(outer, phase_cap(STOP_TEARDOWN));
    loop {
        match probe() {
            Ok(observed) if observed.state == LifecycleState::Stopped => {
                return (true, Ok(()));
            }
            Ok(_) => {}
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            return (true, Err(("stopping", "shutdown_timeout")));
        }
        std::thread::sleep(REPROBE_INTERVAL);
    }
}

fn cmd_stop() -> DaemonResult {
    let command = "stop";
    let outer = Instant::now() + OUTER_AGGREGATE;
    let runtime = match Runtime::new() {
        Ok(runtime) => runtime,
        Err(_) => return DaemonResult::new(command, false, "stopped", "internal_error"),
    };
    let _tx = match LifecycleTransactionLock::acquire_exclusive(None) {
        Ok(tx) => tx,
        Err(error) => {
            let (state, reason) = instance_failure(&error);
            return DaemonResult::new(command, false, state, reason);
        }
    };
    let observed = match settle_probe(phase_deadline(outer, TRANSITION_SETTLE)) {
        Ok(observed) => observed,
        Err(error) => {
            let (state, reason) = instance_failure(&error);
            return DaemonResult::new(command, false, state, reason);
        }
    };
    match observed.state {
        // No lock-held incarnation exists. Selector cleanup is best-effort
        // stale-state removal under the transaction ownership boundary, so a
        // cleanup failure is reported (`ok:false`) without restating the
        // lifecycle state: the host really is stopped, and `wedged` would
        // route remediation at a daemon process that is not there. Only an
        // unsupported schema stays `wedged`, because that state is owned by a
        // newer binary and needs `align_versions`.
        LifecycleState::Stopped => match serve::clear_active_selection() {
            Ok(()) => DaemonResult::new(command, true, "stopped", "already_stopped"),
            Err("unsupported active harness selection schema") => {
                DaemonResult::new(command, false, "wedged", "unsupported_state_schema")
            }
            Err(_) => DaemonResult::new(command, false, "stopped", "internal_error"),
        },
        LifecycleState::Wedged => {
            let reason = if observed.reason == "unsupported_state_schema" {
                "unsupported_state_schema"
            } else {
                "wedged"
            };
            DaemonResult::new(command, false, "wedged", reason)
        }
        LifecycleState::Starting | LifecycleState::Stopping => DaemonResult::new(
            command,
            false,
            probe_state(observed.state),
            "lifecycle_busy",
        ),
        LifecycleState::Running => match stop_phase(&runtime, outer) {
            // The stop transaction committed: the incarnation was signalled,
            // acknowledged, and observed stopped. A best-effort selector
            // cleanup failure after that point cannot un-commit it, so the
            // reported state stays `stopped` and only `ok`/`reason` carry the
            // cleanup fault. Reporting `wedged` here contradicted the
            // committed stop and sent callers into wedged recovery against an
            // already-stopped host.
            (_, Ok(())) => match serve::clear_active_selection() {
                Ok(()) => DaemonResult::new(command, true, "stopped", "stopped"),
                Err("unsupported active harness selection schema") => {
                    DaemonResult::new(command, false, "wedged", "unsupported_state_schema")
                }
                Err(_) => DaemonResult::new(command, false, "stopped", "internal_error"),
            },
            (_, Err((state, reason))) => DaemonResult::new(command, false, state, reason),
        },
    }
}

// -------------------------------------------------------------------------
// restart
// -------------------------------------------------------------------------

fn cmd_restart(
    payload_dir: Option<&Path>,
    payload_manifest_digest: Option<&str>,
    launcher_envelope: serve::LauncherEnvelope,
) -> DaemonResult {
    let command = "restart";
    let effects = |stop: bool, start: bool| Effects {
        stop_committed: stop,
        start_committed: start,
    };
    let outer = Instant::now() + OUTER_AGGREGATE;
    let runtime = match Runtime::new() {
        Ok(runtime) => runtime,
        Err(_) => {
            return DaemonResult::new(command, false, "stopped", "internal_error")
                .with_effects(effects(false, false))
        }
    };
    // ONE transaction lock held continuously across stop, teardown,
    // promotion, and successor start (KTD24); every wait below is bounded.
    let _tx = match LifecycleTransactionLock::acquire_exclusive(None) {
        Ok(tx) => tx,
        Err(error) => {
            let (state, reason) = instance_failure(&error);
            return DaemonResult::new(command, false, state, reason)
                .with_effects(effects(false, false));
        }
    };
    let anchor = match NamespaceAnchor::capture(None) {
        Ok(anchor) => anchor,
        Err(error) => {
            let (state, reason) = instance_failure(&error);
            return DaemonResult::new(command, false, state, reason)
                .with_effects(effects(false, false));
        }
    };
    let observed = match settle_probe(phase_deadline(outer, TRANSITION_SETTLE)) {
        Ok(observed) => observed,
        Err(error) => {
            let (state, reason) = instance_failure(&error);
            return DaemonResult::new(command, false, state, reason)
                .with_effects(effects(false, false));
        }
    };
    let credential_identity_key = if observed.state == LifecycleState::Running {
        let publication = match publication_path() {
            Ok(path) => path,
            Err(_) => {
                return DaemonResult::new(command, false, "running", "internal_error")
                    .with_effects(effects(false, false))
            }
        };
        if runtime.authenticate(&publication).is_none() {
            return DaemonResult::new(command, false, "running", "authentication_failed")
                .with_effects(effects(false, false));
        }
        match serve::credential_identity_key(&publication) {
            Ok(key) => Some(key),
            Err(_) => {
                return DaemonResult::new(command, false, "running", "authentication_failed")
                    .with_effects(effects(false, false))
            }
        }
    } else {
        None
    };
    let prepared = match prepare_launcher_envelope(
        launcher_envelope,
        match credential_identity_key.as_ref() {
            Some(key) => serve::SelectionMode::Running {
                credential_identity_key: key,
                require_previous_credentials: true,
            },
            None => serve::SelectionMode::Fresh,
        },
    ) {
        Ok(prepared) => prepared,
        Err("unsupported active harness selection schema") => {
            return DaemonResult::new(command, false, "wedged", "unsupported_state_schema")
                .with_effects(effects(false, false))
        }
        Err(_) => {
            return DaemonResult::new(
                command,
                false,
                probe_state(observed.state),
                "harness_unavailable",
            )
            .with_effects(effects(false, false))
        }
    };
    let stop_committed = match observed.state {
        LifecycleState::Stopped => false,
        LifecycleState::Wedged => {
            let reason = if observed.reason == "unsupported_state_schema" {
                "unsupported_state_schema"
            } else {
                "wedged"
            };
            return DaemonResult::new(command, false, "wedged", reason)
                .with_effects(effects(false, false));
        }
        LifecycleState::Starting | LifecycleState::Stopping => {
            return DaemonResult::new(
                command,
                false,
                probe_state(observed.state),
                "lifecycle_busy",
            )
            .with_effects(effects(false, false));
        }
        LifecycleState::Running => match stop_phase(&runtime, outer) {
            (_, Ok(())) => true,
            // Pre-acknowledgement failure: no start attempt, both bits false.
            (false, Err((state, reason))) => {
                return DaemonResult::new(command, false, state, reason)
                    .with_effects(effects(false, false));
            }
            // Acknowledged but teardown missed its deadline: committed stop,
            // no start attempt.
            (true, Err((state, reason))) => {
                return DaemonResult::new(command, false, state, reason)
                    .with_effects(effects(true, false));
            }
        },
    };
    let outcome = start_phase(
        &runtime,
        payload_dir,
        payload_manifest_digest,
        &anchor,
        outer,
        prepared,
    );
    let start_committed = outcome.start_committed;
    start_outcome_result(
        command,
        outcome,
        Some(effects(stop_committed, start_committed)),
    )
}

// -------------------------------------------------------------------------
// main
// -------------------------------------------------------------------------

fn emit(result: DaemonResult) -> i32 {
    let result = result.finish();
    match serde_json::to_string(&result) {
        Ok(json) => {
            println!("{json}");
            if result.ok {
                0
            } else {
                1
            }
        }
        Err(_) => {
            // Bounded stderr only when the JSON object cannot be formed.
            eprintln!("ck-mc-host: result serialization failed");
            1
        }
    }
}

fn real_main() -> i32 {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let command = match parse_args(&args) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("ck-mc-host: {message}");
            eprintln!("{USAGE}");
            return 2;
        }
    };
    match command {
        Command::Version => {
            println!(
                "ck-mc-host {} ({})",
                release_contract::RELEASE_VERSION,
                release_contract::DAEMON_VERSION
            );
            0
        }
        Command::ReleaseInfo => {
            println!("{}", release_contract::RELEASE_CONTRACT_JSON);
            0
        }
        Command::InputLockDigest => {
            println!(
                "{}",
                mc_module::production_inputs::PRODUCTION_INPUTS_LOCK_SHA256
            );
            0
        }
        Command::Probe => emit(cmd_probe()),
        Command::Start {
            payload_dir,
            payload_manifest_digest,
        } => {
            spawn::ignore_sigpipe();
            match serve::read_launcher_envelope() {
                Ok(envelope) => emit(cmd_start(
                    payload_dir.as_deref(),
                    payload_manifest_digest.as_deref(),
                    envelope,
                )),
                Err(_) => emit(DaemonResult::new(
                    "start",
                    false,
                    "stopped",
                    "internal_error",
                )),
            }
        }
        Command::Stop => emit(cmd_stop()),
        Command::Restart {
            payload_dir,
            payload_manifest_digest,
        } => {
            spawn::ignore_sigpipe();
            match serve::read_launcher_envelope() {
                Ok(envelope) => emit(cmd_restart(
                    payload_dir.as_deref(),
                    payload_manifest_digest.as_deref(),
                    envelope,
                )),
                Err(_) => emit(
                    DaemonResult::new("restart", false, "stopped", "internal_error").with_effects(
                        Effects {
                            stop_committed: false,
                            start_committed: false,
                        },
                    ),
                ),
            }
        }
        Command::Serve => match serve::run() {
            Ok(()) => 0,
            Err(message) => {
                eprintln!("ck-mc-host serve: {message}");
                1
            }
        },
    }
}

fn main() {
    std::process::exit(real_main());
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    /// Every reason/remediation pair this binary can emit must match the
    /// embedded release contract's precedence table exactly.
    #[test]
    fn remediation_mapping_matches_release_contract() {
        let contract: serde_json::Value =
            serde_json::from_str(release_contract::RELEASE_CONTRACT_JSON).expect("contract");
        let failing = contract["cli"]["reasons"]["failing_by_precedence"]
            .as_array()
            .expect("failing reasons");
        for entry in failing {
            let id = entry["id"].as_str().expect("reason id");
            // `harness_unavailable` remediation is subreason-driven and this
            // binary never emits it as a top-level reason.
            if id == "harness_unavailable" {
                continue;
            }
            let expected = entry["remediation"].as_str();
            // Round-trip through a leaked static so the lookup signature
            // stays &'static str.
            let reason: &'static str = Box::leak(id.to_owned().into_boxed_str());
            assert_eq!(
                remediation_for(reason),
                expected,
                "remediation mismatch for {id}"
            );
        }
        for id in contract["cli"]["reasons"]["non_failing"]
            .as_array()
            .expect("non-failing reasons")
        {
            let reason: &'static str =
                Box::leak(id.as_str().expect("reason").to_owned().into_boxed_str());
            assert_eq!(remediation_for(reason), None);
        }
    }

    #[test]
    fn parse_rejects_unknown_and_duplicate_input() {
        let os = |values: &[&str]| -> Vec<std::ffi::OsString> {
            values.iter().map(std::ffi::OsString::from).collect()
        };
        assert!(parse_args(&os(&["bogus"])).is_err());
        assert!(parse_args(&os(&["start", "extra"])).is_err());
        assert!(parse_args(&os(&["stop", "--payload-dir", "x"])).is_err());
        assert!(parse_args(&os(&["start", "--payload-dir"])).is_err());
        assert!(parse_args(&os(&["start", "--payload-dir", "a", "--payload-dir", "b"])).is_err());
        assert!(parse_args(&os(&[])).is_err());
        assert!(matches!(
            parse_args(&os(&["start", "--payload-dir", "a"])),
            Ok(Command::Start {
                payload_dir: Some(_),
                payload_manifest_digest: None,
            })
        ));
        assert!(matches!(
            parse_args(&os(&[
                "start",
                "--payload-dir",
                "a",
                "--payload-manifest-digest",
                &"a".repeat(64),
            ])),
            Ok(Command::Start {
                payload_manifest_digest: Some(_),
                ..
            })
        ));
        assert!(matches!(
            parse_args(&os(&[
                "start",
                "--payload-manifest-digest",
                &"a".repeat(64),
            ])),
            Ok(Command::Start {
                payload_dir: None,
                payload_manifest_digest: Some(_),
            })
        ));
        assert!(matches!(parse_args(&os(&["probe"])), Ok(Command::Probe)));
        assert!(matches!(
            parse_args(&os(&["--version"])),
            Ok(Command::Version)
        ));
    }

    #[test]
    fn launcher_envelope_accepts_only_bounded_descriptors_and_credentials() {
        let mut envelope = serve::LauncherEnvelope::empty();
        envelope.opencode = Some(serve::HarnessCandidate {
            manifest_sha256: "ab".repeat(32),
            source_roots: std::collections::BTreeMap::from([(
                "opencode-install".to_owned(),
                PathBuf::from("/opt/opencode"),
            )]),
        });
        envelope
            .credentials
            .insert("ANTHROPIC_API_KEY".to_owned(), "secret".to_owned());
        assert_eq!(envelope.validate(), Ok(()));

        envelope
            .credentials
            .insert("AWS_ACCESS_KEY_ID".to_owned(), "ambient".to_owned());
        assert_eq!(
            envelope.validate(),
            Err("credential source contains an unsupported variable")
        );
        envelope.credentials.remove("AWS_ACCESS_KEY_ID");
        envelope
            .credentials
            .insert("ANTHROPIC_API_KEY".to_owned(), "x".repeat(16 * 1024 + 1));
        assert_eq!(
            envelope.validate(),
            Err("credential value exceeds its size cap")
        );
    }

    #[test]
    fn trusted_payload_manifest_binds_every_staged_file() {
        let payload = tempfile::tempdir().expect("payload");
        let store_root = tempfile::tempdir().expect("store");
        let launcher_path = payload.path().join("payload/bin/ck-mc-host");
        let model_path = payload.path().join("payload/model/model.onnx");
        std::fs::create_dir_all(launcher_path.parent().expect("launcher parent")).expect("mkdir");
        std::fs::create_dir_all(model_path.parent().expect("model parent")).expect("mkdir");
        std::fs::write(&launcher_path, b"launcher").expect("launcher");
        std::fs::write(&model_path, b"model-v1").expect("model");
        let hash = |bytes: &[u8]| format!("{:x}", sha2::Sha256::digest(bytes));
        let package_name = match host_target() {
            "linux-x64-gnu" => "@cortexkit/mc-host-linux-x64-gnu",
            "darwin-arm64" => "@cortexkit/mc-host-darwin-arm64",
            "darwin-x64" => "@cortexkit/mc-host-darwin-x64",
            _ => return,
        };
        let manifest = serde_json::json!({
            "schema": "magic-context.mc-host-payload-manifest/v1",
            "release": {"id": "mc-host-release", "version": release_contract::RELEASE_VERSION},
            "release_contract_sha256": release_contract::RELEASE_CONTRACT_SHA256,
            "production_inputs_lock_sha256": "b".repeat(64),
            "mode": "production",
            "package": {
                "name": package_name,
                "version": release_contract::RELEASE_VERSION,
                "target": host_target()
            },
            "platform_floor": {"kernel_min": "4.18", "glibc_min": "2.28"},
            "synapse": "certified_cpu",
            "launcher": "payload/bin/ck-mc-host",
            "files": [
                {
                    "path": "payload/bin/ck-mc-host",
                    "type": "file",
                    "size": 8,
                    "mode": "755",
                    "sha256": hash(b"launcher")
                },
                {
                    "path": "payload/model/model.onnx",
                    "type": "file",
                    "size": 8,
                    "mode": "644",
                    "sha256": hash(b"model-v1")
                }
            ]
        });
        let manifest_bytes = serde_json::to_vec(&manifest).expect("manifest");
        let manifest_digest = hash(&manifest_bytes);
        std::fs::write(
            payload.path().join("payload-manifest.json"),
            &manifest_bytes,
        )
        .expect("manifest write");
        let sources =
            trusted_payload_sources(payload.path(), &manifest_digest).expect("trusted sources");
        std::fs::write(&model_path, b"model-v2").expect("mutate model");
        let store = GenerationStore::open(Some(store_root.path())).expect("store");
        let result = store.stage_and_promote(
            &sources.sources,
            &StageMeta {
                target: "linux-x64-gnu".to_owned(),
                release_contract_sha256: release_contract::RELEASE_CONTRACT_SHA256.to_owned(),
                inputs_lock_sha256: sources.inputs_lock_sha256,
                source_payload_manifest_sha256: manifest_digest,
            },
            &BTreeSet::new(),
        );
        assert!(matches!(
            result,
            Err(GenerationError::NativePayloadInvalid { .. })
        ));
    }

    #[test]
    fn launcher_materialization_removes_source_paths_from_serve_envelope() {
        let root = tempfile::tempdir().expect("data root");
        let secret_source = "/private/package-cache/opencode";
        let mut envelope = serve::LauncherEnvelope::empty();
        envelope.opencode = Some(serve::HarnessCandidate {
            manifest_sha256: "ab".repeat(32),
            source_roots: std::collections::BTreeMap::from([(
                "runtime".to_owned(),
                PathBuf::from(secret_source),
            )]),
        });
        let startup = envelope
            .prepare(root.path().to_path_buf(), serve::SelectionMode::Fresh)
            .expect("prepare isolated envelope")
            .to_startup("cd".repeat(32));
        assert!(matches!(
            startup.opencode,
            Some(serve::HarnessSnapshot::Unavailable { ref reason })
                if reason == "descriptor_invalid"
        ));
        let serialized = serde_json::to_string(&startup).expect("serialize startup");
        assert!(!serialized.contains(secret_source));
        assert!(!serialized.contains("source_roots"));

        let ready = serve::StartupEnvelope {
            schema: 1,
            data_dir: root.path().to_path_buf(),
            payload_manifest_digest: "cd".repeat(32),
            opencode: Some(serve::HarnessSnapshot::Ready {
                manifest_sha256: "ef".repeat(32),
            }),
            pi: None,
            credentials: std::collections::BTreeMap::new(),
        };
        let ready_json = serde_json::to_value(ready).expect("serialize ready startup");
        assert_eq!(
            ready_json["opencode"],
            serde_json::json!({
                "state": "ready",
                "manifest_sha256": "ef".repeat(32),
            })
        );
        assert!(ready_json.get("source_roots").is_none());
    }

    #[test]
    fn daemon_version_range_check_uses_contract_bounds() {
        assert!(daemon_version_compatible("mc-host/0.1.0"));
        assert!(daemon_version_compatible("mc-host/0.1.9"));
        assert!(!daemon_version_compatible("mc-host/0.2.0"));
        assert!(!daemon_version_compatible("mc-host/0.0.9"));
        assert!(!daemon_version_compatible("other/0.1.0"));
        assert!(!daemon_version_compatible("mc-host/1"));
    }

    /// The CLI gate and the plugin's `evaluateDaemonCompatibility` decide the
    /// same question about the same authenticated `daemon_ver`, so a version
    /// the client quarantines as `incompatible_daemon` must never pass here.
    /// `mc-host/00.01.000` numerically resolves inside the supported range,
    /// so only the canonical-component rule rejects it.
    #[test]
    fn daemon_version_rejects_noncanonical_components() {
        assert!(!daemon_version_compatible("mc-host/00.01.000"));
        assert!(!daemon_version_compatible("mc-host/0.01.0"));
        assert!(!daemon_version_compatible("mc-host/0.1.00"));
        assert!(!daemon_version_compatible("mc-host/+0.1.0"));
        assert!(!daemon_version_compatible("mc-host/0.+1.0"));
        assert!(!daemon_version_compatible("mc-host/0. 1.0"));
        assert!(!daemon_version_compatible("mc-host/0..0"));
    }
}
