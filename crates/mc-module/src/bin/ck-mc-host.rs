//! `ck-mc-host` is the lifecycle and serve executable.
//!
//! `ck-mc-host` depends on `mc-module` and `mc-host`; neither dependency depends on `ck-mc-host`.
//! `--version` and `release-info` have no side effects.
//! Each lifecycle command emits exactly one `magic-context.daemon/v1` JSON object on stdout.
//! Exit 0 means `ok:true`; exit 1 indicates an operational failure.
//! Exit 2 indicates a usage error and makes no lifecycle call.

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

use mc_host::generation::{GenerationError, GenerationStore, SourceSpec, StageMeta};
use mc_host::{
    Client, InstanceError, LifecycleProbe, LifecycleState, LifecycleTransactionLock,
    NamespaceAnchor, ProbeFreshness, SendOutcome,
};
use mc_module::release_contract;

// -------------------------------------------------------------------------
// -------------------------------------------------------------------------

/// The outer aggregate caps fresh Linux request-to-authenticated-transport handling at 60 seconds.
const OUTER_AGGREGATE: Duration = Duration::from_secs(60);
/// The 10-second spawn/publication/auth budget covers staged-generation revalidation and retained harness closure hashing before publication.
/// Before publication, `serve` revalidates the staged generation and hashes every retained harness closure node.
/// Both qualified harnesses can require hashing hundreds of megabytes of closure nodes.
/// The budget covers cold-page-cache reads of the retained harness closure nodes.
const SPAWN_PUBLICATION_AUTH: Duration = Duration::from_secs(10);
/// The teardown budget covers committed shutdown through publication removal and acquisition of both fences.
const STOP_TEARDOWN: Duration = Duration::from_secs(10);
/// The command waits at most 5 seconds for an observed `starting` or `stopping` transition before reporting `lifecycle_busy`.
const TRANSITION_SETTLE: Duration = Duration::from_secs(5);
const REPROBE_INTERVAL: Duration = Duration::from_millis(100);
/// The 500 ms close grace prevents a stalled peer from hanging the phase after a proven handshake.
/// Expiry after a proven handshake does not change the authentication verdict.
/// The handshake settles the authentication verdict before close grace begins.
const CLOSE_GRACE: Duration = Duration::from_millis(500);

/// The override can lengthen only the spawn/publication/auth and teardown caps.
/// The aggregate deadline prevents any phase-cap value from causing an unbounded wait.
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

fn phase_deadline(outer: Instant, cap: Duration) -> Instant {
    let now = Instant::now();
    let remaining = outer.saturating_duration_since(now);
    now + cap.min(remaining)
}

// -------------------------------------------------------------------------
// Result reasons use the closed v1 vocabulary.
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
        // Applicable checks derive from the final verdict.
        // The lifecycle check reports lock coherence.
        // The publication check reports whether a running incarnation's credential was observed.
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
// -------------------------------------------------------------------------

enum Command {
    Version,
    ReleaseInfo,
    InputLockDigest,
    Status,
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

const USAGE: &str = "usage: ck-mc-host <serve|start|stop|restart|status|release-info|input-lock-digest> [--payload-dir <dir> --payload-manifest-digest <sha256>] | --version";

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
        "status" | "probe" => Ok(Command::Status),
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
// The process never serializes native error detail.
// Only closed static reasons leave this process.
// -------------------------------------------------------------------------

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

///
/// Pre-commit rejections report the on-disk lifecycle state.
/// classifies them.
fn unchanged_state() -> &'static str {
    match probe() {
        Ok(observed) => probe_state(observed.state),
        Err(error) => instance_failure(&error).0,
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

///
fn quarantined_observation(observed: &LifecycleProbe) -> Option<(&'static str, &'static str)> {
    if observed.reason != mc_host::UNSUPPORTED_STATE_SCHEMA_REASON {
        return None;
    }
    Some((
        probe_state(observed.state),
        mc_host::UNSUPPORTED_STATE_SCHEMA_REASON,
    ))
}

// -------------------------------------------------------------------------
// -------------------------------------------------------------------------

fn probe() -> Result<LifecycleProbe, InstanceError> {
    mc_host::probe_lifecycle(None, &ProbeFreshness::default())
}

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

    fn authenticate(&self, publication: &Path, deadline: Instant) -> Option<String> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        let path = publication.to_path_buf();
        self.inner.block_on(async move {
            // Only `Client::connect` uses `remaining`; `client.close()` uses `CLOSE_GRACE`.
            // `client.close()` runs after `daemon_ver` is saved and cannot change the returned value.
            match tokio::time::timeout(remaining, Client::connect(&path)).await {
                Ok(Ok(client)) => {
                    let daemon_ver = client.daemon_ver().to_owned();
                    let _ = tokio::time::timeout(CLOSE_GRACE, client.close()).await;
                    Some(daemon_ver)
                }
                _ => None,
            }
        })
    }

    /// `host.shutdown` requires authentication; `Ok` means the full acknowledgement frame was received.
    ///
    /// `Err("shutdown_outcome_unknown")` reports an unknown shutdown outcome, not a definite failure.
    fn shutdown(&self, publication: &Path, deadline: Instant) -> Result<(), &'static str> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("shutdown_failed");
        }
        let path = publication.to_path_buf();
        self.inner.block_on(async move {
            // The caller's deadline bounds each attempt in addition to the client's timeouts.
            // An unreachable or stalled peer cannot let an attempt exceed the caller's reserved budget.
            // A timeout reports an unknown outcome because the request may already have been written.
            match tokio::time::timeout(remaining, async {
                let client = Client::connect(&path)
                    .await
                    .map_err(|_| "authentication_failed")?;
                let result = client.host_shutdown().await;
                let _ = client.close().await;
                result.map_err(|error| match error.outcome() {
                    SendOutcome::OutcomeUnknown => "shutdown_outcome_unknown",
                    _ => "shutdown_failed",
                })
            })
            .await
            {
                Ok(result) => result,
                Err(_) => Err("shutdown_outcome_unknown"),
            }
        })
    }
}

/// The publication daemon version is untrusted and supports observational output only.
/// Authorization and compatibility never consume this value.
fn publication_daemon_ver(observed: &LifecycleProbe) -> Option<String> {
    observed
        .publication
        .as_ref()
        .map(|publication| publication.daemon_ver.clone())
}

///
/// `evaluateDaemonCompatibility` in
/// `packages/plugin/src/shared/mc-host-lifecycle/compatibility.ts`, whose
fn daemon_version_compatible(daemon_ver: &str) -> bool {
    fn triple(version: &str) -> Option<[u64; 3]> {
        fn component(part: &str) -> Option<u64> {
            if part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
            {
                return None;
            }
            part.parse().ok()
        }
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

/// `cmd_probe` observes the daemon without creating an instance.
/// `running` with a contract-conforming publication is `healthy` (ok:true).
/// `cmd_probe` does not dial a connection, so `proof` and readiness remain null.
/// `cmd_probe` reports `versions.daemon` only as publication diagnostics.
///
fn cmd_probe() -> DaemonResult {
    let command = "status";
    let observed = match probe() {
        Ok(observed) => observed,
        Err(error) => {
            let (state, reason) = instance_failure(&error);
            return DaemonResult::new(command, false, state, reason);
        }
    };
    let state = probe_state(observed.state);
    let (ok, reason) = match quarantined_observation(&observed) {
        Some((_, reason)) => (false, reason),
        None => match observed.state {
            LifecycleState::Running => (true, "healthy"),
            LifecycleState::Stopped => (false, "not_running"),
            LifecycleState::Starting => (false, "starting"),
            LifecycleState::Stopping => (false, "stopping"),
            LifecycleState::Wedged => (false, "wedged"),
        },
    };
    let mut result = DaemonResult::new(command, ok, state, reason);
    result.versions.daemon = publication_daemon_ver(&observed);
    result
}

// -------------------------------------------------------------------------
// start
// -------------------------------------------------------------------------

/// authenticated-transport readiness.
struct StartOutcome {
    ok: bool,
    start_committed: bool,
    state: &'static str,
    reason: &'static str,
    daemon_ver: Option<String>,
    generation_check: Option<(&'static str, &'static str)>,
}

///
enum SuccessorGeneration<'a> {
    Resolve {
        payload_dir: Option<&'a Path>,
        payload_manifest_digest: Option<&'a str>,
    },
    Preflighted(ResolvedGeneration),
}

fn start_phase(
    runtime: &Runtime,
    generation: SuccessorGeneration<'_>,
    anchor: &NamespaceAnchor,
    outer: Instant,
    launcher_envelope: serve::PreparedLauncherEnvelope,
    stop_committed: bool,
) -> StartOutcome {
    // failing.
    let unresolved = |state: &'static str, reason: &'static str| StartOutcome {
        ok: false,
        start_committed: false,
        state,
        reason,
        daemon_ver: None,
        generation_check: Some(("fail", reason)),
    };
    let resolved_but_failed = |state: &'static str, reason: &'static str| StartOutcome {
        ok: false,
        start_committed: false,
        state,
        reason,
        daemon_ver: None,
        generation_check: Some(("pass", "healthy")),
    };

    let ResolvedGeneration {
        digest,
        launcher: generation_launcher,
    } = match generation {
        SuccessorGeneration::Preflighted(resolved) => resolved,
        SuccessorGeneration::Resolve {
            payload_dir,
            payload_manifest_digest,
        } => match resolve_generation(payload_dir, payload_manifest_digest) {
            Ok(resolved) => resolved,
            Err((state, reason)) => return unresolved(state, reason),
        },
    };

    if anchor.verify().is_err() {
        return resolved_but_failed("wedged", "wedged");
    }

    // Generation resolution can outlast `outer` on slow storage.
    // Spawning after `outer` expires would return `startup_timeout` while allowing a daemon to start later.
    // Refusing the spawn prevents a daemon from starting after `startup_timeout` is returned.
    // passes.
    //
    // After a committed stop, spawning is the only path that restores service.
    // After a committed stop, `outer` may expire without preventing the successor spawn.
    // After a committed stop, the aggregate may overrun `outer` to restore service.
    if !stop_committed && Instant::now() >= outer {
        return resolved_but_failed("stopped", "startup_timeout");
    }

    let envelope = launcher_envelope.to_startup(digest);
    let envelope_bytes = match serde_json::to_vec(&envelope) {
        Ok(bytes) => bytes,
        // Unix data-root paths can contain non-UTF-8 bytes that JSON cannot represent.
        Err(_) => return resolved_but_failed("stopped", "internal_error"),
    };
    let log_path = match daemon_log_path() {
        Ok(path) => path,
        Err(_) => return resolved_but_failed("stopped", "internal_error"),
    };
    if spawn::spawn_detached(&log_path, &envelope_bytes, generation_launcher).is_err() {
        return resolved_but_failed("stopped", "internal_error");
    }

    // The loop waits for publication and authentication evidence, not the child PID.
    let deadline = phase_deadline(outer, phase_cap(SPAWN_PUBLICATION_AUTH));
    let publication = match publication_path() {
        Ok(path) => path,
        Err(_) => return resolved_but_failed("stopped", "internal_error"),
    };
    loop {
        // `runtime.authenticate` can authenticate a stale publication for another endpoint, so authentication alone cannot identify this root's daemon.
        // `probe()` returning `LifecycleState::Running` proves that a lock-held incarnation exists at this root.
        // The daemon publishes only after taking its fences.
        if let Some(daemon_ver) = publication
            .exists()
            .then(|| runtime.authenticate(&publication, deadline))
            .flatten()
        {
            if let Ok(observed) = probe() {
                if observed.state == LifecycleState::Running {
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
                                generation_check: Some(("pass", "healthy")),
                            },
                            (_, Err((state, reason))) => StartOutcome {
                                ok: false,
                                start_committed: true,
                                state,
                                reason,
                                daemon_ver: Some(daemon_ver),
                                generation_check: Some(("pass", "healthy")),
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
            }
        }
        if Instant::now() >= deadline {
            // A child that exits before publishing leaves a coherent `stopped` observation.
            // Reporting a pre-publication child exit as `wedged` would falsely claim fence incoherence.
            let state = match probe().map(|observed| observed.state) {
                Ok(LifecycleState::Starting) => "starting",
                Ok(LifecycleState::Stopped) => "stopped",
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

/// `restart` preflights the successor generation before stopping the current daemon.
///
/// An irreversible stop requires discovering every successor condition already present on disk first.
///
/// The resolver returns the resolved generation to avoid revalidating before successor start.
fn preflight_generation(
    payload_dir: Option<&Path>,
    payload_manifest_digest: Option<&str>,
) -> Result<Option<ResolvedGeneration>, (&'static str, &'static str)> {
    // Reject unsupported targets before stop because post-stop resolution would otherwise commit the stop before reporting `unsupported_platform`.
    if build_target().is_none() {
        return Err(("stopped", "unsupported_platform"));
    }
    match payload_dir {
        // A quarantined or insecure store fails staging before any mutation.
        // beforehand.
        Some(dir) => {
            let payload = payload_sources(dir, payload_manifest_digest)?;
            // A source byte mismatch must fail before the irreversible stop.
            mc_host::generation::verify_sources(&payload.sources)
                .map_err(|e| generation_failure(&e))?;
            // No-create probe: an absent store is fine, staging creates it.
            if let Some(store) =
                GenerationStore::open_probe(None).map_err(|e| generation_failure(&e))?
            {
                match store.read_current().map_err(|e| generation_failure(&e))? {
                    mc_host::generation::CurrentProfile::Quarantined => {
                        return Err(("stopped", "unsupported_state_schema"));
                    }
                    mc_host::generation::CurrentProfile::Absent
                    | mc_host::generation::CurrentProfile::Current(_) => {}
                }
            }
            Ok(None)
        }
        // An unresolved production generation must not commit a stop.
        None => resolve_generation(None, payload_manifest_digest).map(Some),
    }
}

/// `build_target` returns the target in the release contract's platform spelling.
///
/// Staging writes and selection compares `platforms.supported[].target`; sharing this definition prevents spelling drift.
const fn build_target() -> Option<&'static str> {
    if cfg!(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu"
    )) {
        Some("linux-x64-gnu")
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("darwin-arm64")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("darwin-x64")
    } else {
        None
    }
}

/// The validation confirms that the generation was staged by this release for this target.
///
/// `validate` does not verify that the generation matches the running binary.
fn generation_identity_matches(
    manifest: &mc_host::generation::GenerationManifest,
    target: &str,
) -> Result<(), (&'static str, &'static str)> {
    if manifest.target != target {
        return Err(("stopped", "native_payload_invalid"));
    }
    if manifest.release_contract_sha256 != release_contract::RELEASE_CONTRACT_SHA256 {
        return Err(("stopped", "native_payload_invalid"));
    }
    Ok(())
}

///
/// When present, `launcher` is an open verified `ck-mc-host` descriptor bound to the generation digest.
struct ResolvedGeneration {
    digest: String,
    launcher: Option<std::os::fd::OwnedFd>,
}

///
///
fn generation_launcher(
    validated: &mc_host::generation::ValidatedGeneration,
) -> Result<Option<std::os::fd::OwnedFd>, (&'static str, &'static str)> {
    const PRODUCTION_LAUNCHER: &str = "payload/bin/ck-mc-host";
    if !validated
        .manifest
        .files
        .iter()
        .any(|file| file.path == PRODUCTION_LAUNCHER)
    {
        return if validated.manifest.source_payload_manifest_sha256.as_deref()
            == Some("unqualified-dev-manifest")
            && spawn::test_self_exec_allowed()
        {
            Ok(None)
        } else {
            Err(("stopped", "native_payload_invalid"))
        };
    }
    validated
        .open_verified_file(PRODUCTION_LAUNCHER)
        .map(Some)
        .map_err(|_| ("stopped", "native_payload_invalid"))
}

///
/// `payload_manifest_digest` requires the resolved generation to have been staged from that digest; a mismatch returns `native_payload_invalid`.
fn resolve_generation(
    payload_dir: Option<&Path>,
    payload_manifest_digest: Option<&str>,
) -> Result<ResolvedGeneration, (&'static str, &'static str)> {
    // `unsupported_platform` takes precedence over `native_payload_missing`, so `build_target()` runs before payload inspection.
    let Some(target) = build_target() else {
        return Err(("stopped", "unsupported_platform"));
    };
    match payload_dir {
        Some(dir) => {
            let payload = payload_sources(dir, payload_manifest_digest)?;
            mc_host::generation::verify_sources(&payload.sources)
                .map_err(|e| generation_failure(&e))?;
            let store = GenerationStore::open(None).map_err(|e| generation_failure(&e))?;
            let mut protected = BTreeSet::new();
            if let Ok(mc_host::generation::CurrentProfile::Current(current)) = store.read_current()
            {
                protected.insert(current);
            }
            // The staging transaction prunes unreferenced complete generations and stale staging directories while holding the transaction lock.
            store
                .prune(&protected)
                .map_err(|e| generation_failure(&e))?;
            let meta = StageMeta {
                target: target.to_owned(),
                release_contract_sha256: release_contract::RELEASE_CONTRACT_SHA256.to_owned(),
                // The `unqualified-dev-manifest` value identifies an unqualified dev/test payload; it is not a placeholder hash.
                // production payload.
                inputs_lock_sha256: payload.inputs_lock_sha256,
                source_payload_manifest_sha256: payload_manifest_digest
                    .unwrap_or("unqualified-dev-manifest")
                    .to_owned(),
            };
            let digest = store
                .stage_and_promote(&payload.sources, &meta, &protected)
                .map_err(|e| generation_failure(&e))?;
            let validated = store
                .validate(&digest)
                .map_err(|e| generation_failure(&e))?;
            generation_identity_matches(&validated.manifest, target)?;
            let launcher = generation_launcher(&validated)?;
            Ok(ResolvedGeneration { digest, launcher })
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
                    generation_identity_matches(&validated.manifest, target)?;
                    // When `payload_manifest_digest` is supplied, `resolve_generation` rejects a generation whose `source_payload_manifest_sha256` differs or is absent.
                    if payload_manifest_digest.is_some_and(|expected| {
                        validated.manifest.source_payload_manifest_sha256.as_deref()
                            != Some(expected)
                    }) {
                        return Err(("stopped", "native_payload_invalid"));
                    }
                    let launcher = generation_launcher(&validated)?;
                    Ok(ResolvedGeneration { digest, launcher })
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
    // The digest binds the manifest's exact bytes, so serialization must match the producer byte-for-byte.
    if format!("{:x}", sha2::Sha256::digest(canonical)) != expected_manifest_digest {
        return Err(invalid);
    }
    let manifest: TrustedPayloadManifest =
        serde_json::from_slice(canonical).map_err(|_| invalid)?;
    let Some(target) = build_target() else {
        return Err(invalid);
    };
    let expected_package = match target {
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
        || manifest.package.target != target
        || manifest.launcher != "payload/bin/ck-mc-host"
        // `production_inputs_lock_sha256` must equal the lock compiled into the executable; hex validation alone would permit unrelated production inputs.
        || manifest.production_inputs_lock_sha256
            != mc_module::production_inputs::PRODUCTION_INPUTS_LOCK_SHA256
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
    let data_dir = mc_host::data_dir_path(None)
        .ok()
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
    // Quarantined records must block startup in every state, so classify them before dispatching on `wedged`.
    if let Some((state, reason)) = quarantined_observation(&observed) {
        return DaemonResult::new(command, false, state, reason);
    }
    match observed.state {
        LifecycleState::Running => {
            let publication = match publication_path() {
                Ok(path) => path,
                Err(_) => return DaemonResult::new(command, false, "running", "internal_error"),
            };
            let auth_deadline = phase_deadline(outer, phase_cap(SPAWN_PUBLICATION_AUTH));
            let Some(daemon_ver) = runtime.authenticate(&publication, auth_deadline) else {
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
        LifecycleState::Wedged => DaemonResult::new(command, false, "wedged", "wedged"),
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
                SuccessorGeneration::Resolve {
                    payload_dir,
                    payload_manifest_digest,
                },
                &anchor,
                outer,
                prepared,
                false,
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

/// `stop` and `restart` share this committed-stop phase after the caller acquires the transaction lock and observes `Running`.
/// The function returns `(stop_committed, terminal)`, where `terminal` is `Ok(())` after teardown or a `(state, reason)` failure.
///
/// After a shutdown timeout, the function probes because the host may have committed at full-frame write completion.
fn stop_phase(
    runtime: &Runtime,
    outer: Instant,
) -> (bool, Result<(), (&'static str, &'static str)>) {
    let publication = match publication_path() {
        Ok(path) => path,
        Err(_) => return (false, Err(("running", "internal_error"))),
    };
    let mut commit_uncertain = false;
    match runtime.shutdown(&publication, outer) {
        Ok(()) => {}
        Err("authentication_failed") => return (false, Err(("running", "authentication_failed"))),
        // After an in-flight frame times out, the function waits for teardown and lets the probe determine whether the host committed it.
        // After an in-flight frame times out, the function waits for teardown and lets the probe determine whether the host committed it.
        Err("shutdown_outcome_unknown") => commit_uncertain = true,
        // An unresolved response-in-flight attempt requires a commit probe.
        Err(_) => return (false, Err(("running", "lifecycle_busy"))),
    }
    // After acknowledgement or an unresolved in-flight request, the function waits for teardown and lets the probe determine whether the host committed it.
    // After acknowledgement or an unresolved in-flight request, the function waits for teardown and lets the probe determine whether the host committed it.
    let deadline = phase_deadline(outer, phase_cap(STOP_TEARDOWN));
    loop {
        match probe() {
            // If the request was never acknowledged, teardown observation determines whether it committed.
            Ok(observed) if observed.state == LifecycleState::Stopped => {
                return (true, Ok(()));
            }
            Ok(_) => {}
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            if commit_uncertain {
                // If the request was never acknowledged, teardown observation determines whether it committed.
                // If the request was never acknowledged, teardown observation determines whether it committed.
                return match probe().map(|observed| observed.state) {
                    // The daemon is still running; the shutdown did not take effect.
                    Ok(LifecycleState::Running) => (false, Err(("running", "lifecycle_busy"))),
                    // The function reports a committed stop so callers do not assume the daemon kept serving.
                    _ => (true, Err(("stopping", "shutdown_timeout"))),
                };
            }
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
    // The function classifies quarantined records before state dispatch to avoid reporting `already_stopped`.
    // Quarantined records require `align_versions` and block the next start.
    if let Some((state, reason)) = quarantined_observation(&observed) {
        return DaemonResult::new(command, false, state, reason);
    }
    match observed.state {
        // The transaction lock confines selector cleanup to stale-state removal.
        LifecycleState::Stopped => match serve::clear_active_selection() {
            Err("unsupported active harness selection schema") => {
                DaemonResult::new(command, false, "wedged", "unsupported_state_schema")
            }
            Ok(()) | Err(_) => DaemonResult::new(command, true, "stopped", "already_stopped"),
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
            // `align_versions`.
            (_, Ok(())) => match serve::clear_active_selection() {
                Err("unsupported active harness selection schema") => {
                    DaemonResult::new(command, false, "wedged", "unsupported_state_schema")
                }
                Ok(()) | Err(_) => DaemonResult::new(command, true, "stopped", "stopped"),
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
    // A single transaction lock spans stop, teardown, promotion, and successor start; every wait below is bounded.
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
    // A quarantined record prevents successor startup before any stop.
    if let Some((state, reason)) = quarantined_observation(&observed) {
        return DaemonResult::new(command, false, state, reason)
            .with_effects(effects(false, false));
    }
    match observed.state {
        LifecycleState::Wedged => {
            return DaemonResult::new(command, false, "wedged", "wedged")
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
        LifecycleState::Stopped | LifecycleState::Running => {}
    }
    // Preflight runs before the irreversible stop so resolver failures leave the daemon serving.
    let preresolved = match preflight_generation(payload_dir, payload_manifest_digest) {
        Ok(preresolved) => preresolved,
        Err((_, reason)) => {
            // On preflight failure, the function reports the observed state because no state changed.
            return DaemonResult::new(command, false, probe_state(observed.state), reason)
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
        let auth_deadline = phase_deadline(outer, phase_cap(SPAWN_PUBLICATION_AUTH));
        if runtime.authenticate(&publication, auth_deadline).is_none() {
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
        LifecycleState::Running => {
            // The function reserves `start_phase` time before stopping so teardown cannot exhaust the successor-start budget.
            //
            // If reservation fails, return `lifecycle_busy` without effects so callers can retry.
            let stop_deadline = match outer.checked_sub(phase_cap(SPAWN_PUBLICATION_AUTH)) {
                Some(deadline) if deadline > Instant::now() => deadline,
                _ => {
                    return DaemonResult::new(command, false, "running", "lifecycle_busy")
                        .with_effects(effects(false, false));
                }
            };
            match stop_phase(&runtime, stop_deadline) {
                (_, Ok(())) => true,
                // A pre-acknowledgement failure does not attempt a start and leaves both effects false.
                (false, Err((state, reason))) => {
                    return DaemonResult::new(command, false, state, reason)
                        .with_effects(effects(false, false));
                }
                // If acknowledged teardown misses its deadline, the stop remains committed and no start is attempted.
                (true, Err((state, reason))) => {
                    return DaemonResult::new(command, false, state, reason)
                        .with_effects(effects(true, false));
                }
            }
        }
        _ => false,
    };
    let outcome = start_phase(
        &runtime,
        match preresolved {
            Some(resolved) => SuccessorGeneration::Preflighted(resolved),
            None => SuccessorGeneration::Resolve {
                payload_dir,
                payload_manifest_digest,
            },
        },
        &anchor,
        outer,
        prepared,
        stop_committed,
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
        Command::Status => emit(cmd_probe()),
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
                    unchanged_state(),
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
                    DaemonResult::new("restart", false, unchanged_state(), "internal_error")
                        .with_effects(Effects {
                            stop_committed: false,
                            start_committed: false,
                        }),
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

    #[test]
    fn remediation_mapping_matches_release_contract() {
        let contract: serde_json::Value =
            serde_json::from_str(release_contract::RELEASE_CONTRACT_JSON).expect("contract");
        let failing = contract["cli"]["reasons"]["failing_by_precedence"]
            .as_array()
            .expect("failing reasons");
        for entry in failing {
            let id = entry["id"].as_str().expect("reason id");
            if id == "harness_unavailable" {
                continue;
            }
            let expected = entry["remediation"].as_str();
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
        assert!(matches!(parse_args(&os(&["status"])), Ok(Command::Status)));
        assert!(matches!(parse_args(&os(&["probe"])), Ok(Command::Status)));
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
        let Some(target) = build_target() else {
            return;
        };
        let package_name = match target {
            "linux-x64-gnu" => "@cortexkit/mc-host-linux-x64-gnu",
            "darwin-arm64" => "@cortexkit/mc-host-darwin-arm64",
            "darwin-x64" => "@cortexkit/mc-host-darwin-x64",
            _ => return,
        };
        let manifest = serde_json::json!({
            "schema": "magic-context.mc-host-payload-manifest/v1",
            "release": {"id": "mc-host-release", "version": release_contract::RELEASE_VERSION},
            "release_contract_sha256": release_contract::RELEASE_CONTRACT_SHA256,
            "production_inputs_lock_sha256":
                mc_module::production_inputs::PRODUCTION_INPUTS_LOCK_SHA256,
            "mode": "production",
            "package": {
                "name": package_name,
                "version": release_contract::RELEASE_VERSION,
                "target": target
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
        let manifest_bytes = format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest).expect("manifest")
        )
        .into_bytes();
        let manifest_digest = hash(
            manifest_bytes
                .strip_suffix(b"\n")
                .expect("trailing newline"),
        );
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
            Some(serve::HarnessSnapshot::Unavailable {
                reason: serve::HarnessUnavailableReason::DescriptorInvalid
            })
        ));
        let serialized = serde_json::to_string(&startup).expect("serialize startup");
        assert!(!serialized.contains(secret_source));
        assert!(!serialized.contains("source_roots"));

        let ready = serve::StartupEnvelope {
            schema: serve::STARTUP_ENVELOPE_SCHEMA,
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
    #[test]
    fn daemon_version_shape_matches_the_typescript_gate() {
        assert!(!daemon_version_compatible("mc-host/+0.1.0"));
        assert!(!daemon_version_compatible("mc-host/0.+1.0"));
        assert!(!daemon_version_compatible("mc-host/0.1.+0"));
        assert!(!daemon_version_compatible("mc-host/0..0"));
        assert!(!daemon_version_compatible("mc-host/0.1."));
        assert!(!daemon_version_compatible("mc-host/-0.1.0"));
        assert!(!daemon_version_compatible("mc-host/ 0.1.0"));
        assert!(!daemon_version_compatible("mc-host/0.1.0 "));
        assert!(!daemon_version_compatible("mc-host/0.1.0-rc1"));
        assert!(!daemon_version_compatible("mc-host/0.1.0.0"));
        assert!(!daemon_version_compatible("mc-host/0.01.0"));
        assert!(!daemon_version_compatible("mc-host/00.1.0"));
        assert!(!daemon_version_compatible("mc-host/0.1.00"));
        assert!(!daemon_version_compatible("mc-host/01.2.3"));
        assert!(daemon_version_compatible("mc-host/0.1.0"));
    }
}
