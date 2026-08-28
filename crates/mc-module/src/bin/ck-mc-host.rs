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

use mc_host::generation::{GenerationError, GenerationStore, SourceSpec, StageMeta};
use mc_host::{
    Client, InstanceError, LifecycleProbe, LifecycleState, LifecycleTransactionLock,
    NamespaceAnchor, ProbeFreshness, SendOutcome,
};
use mc_module::release_contract;

// -------------------------------------------------------------------------
// Deadlines (plan budget table, KTD22). Every phase receives
// min(phase hard cap, aggregate remaining); the aggregate always wins.
// -------------------------------------------------------------------------

/// Fresh Linux request-to-authenticated-transport outer aggregate (hard).
const OUTER_AGGREGATE: Duration = Duration::from_secs(60);
/// Spawn/publication/auth phase (hard). Before publishing, serve fully
/// revalidates the staged generation and re-hashes every retained harness
/// closure node (hundreds of megabytes when both harnesses are qualified),
/// so this budget covers cold-page-cache reads of that working set, not
/// just process spawn and socket publication.
const SPAWN_PUBLICATION_AUTH: Duration = Duration::from_secs(10);
/// Stop teardown: committed shutdown until publication removal plus both
/// fences acquirable, bounded above the runtime's own shutdown deadline.
const STOP_TEARDOWN: Duration = Duration::from_secs(10);
/// Bounded settle window for an observed `starting`/`stopping` transition
/// before reporting `lifecycle_busy`.
const TRANSITION_SETTLE: Duration = Duration::from_secs(5);
const REPROBE_INTERVAL: Duration = Duration::from_millis(100);
/// Bound on the best-effort close that follows a proven handshake. It exists only
/// so a stalled peer cannot hang the phase; expiring it never changes an
/// authentication verdict the handshake already settled.
const CLOSE_GRACE: Duration = Duration::from_millis(500);

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
        // `probe` is the historical spelling of the contract's `status`
        // command; both resolve to the same observation.
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

/// The one classification of a quarantined-record observation, shared by
/// every command so they cannot drift.
///
/// `probe_lifecycle` reports the quarantined record as `stopped` when both
/// fences are free and as `wedged` when one is held, but the record is
/// quarantined in both shapes and `InstanceGuard::acquire` refuses to start
/// over either. Commands that checked only the `wedged` shape would spawn a
/// child that can never publish and then report `startup_timeout`, so the
/// reason — not the state — is what callers must key on.
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
    /// `true` is the transport-authenticated success signal.
    ///
    /// Bounded by the caller's phase deadline, not just by the client's own
    /// handshake timeout: an existing publication whose endpoint is unreachable
    /// or whose handshake stalls would otherwise let one attempt run past the
    /// phase's hard cap while the lifecycle transaction lock is still held.
    fn authenticate(&self, publication: &Path, deadline: Instant) -> bool {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let path = publication.to_path_buf();
        self.inner.block_on(async move {
            // Only the handshake is bounded by the phase deadline. A completed
            // handshake *is* the authenticated-transport proof, so the close that
            // follows is best-effort cleanup and must not be able to withdraw it:
            // `close` carries its own longer deadline than this phase cap, so
            // folding it into the same timeout let a healthy daemon under slow
            // teardown report `authentication_failed`. It is still bounded, so a
            // stalled peer cannot hang the phase.
            match tokio::time::timeout(remaining, Client::connect(&path)).await {
                Ok(Ok(client)) => {
                    let _ = tokio::time::timeout(CLOSE_GRACE, client.close()).await;
                    true
                }
                _ => false,
            }
        })
    }

    /// Authenticated `host.shutdown`; `Ok` is the full-frame acknowledgement
    /// commit point (KTD4).
    ///
    /// `Err("shutdown_outcome_unknown")` is distinct from a definite failure:
    /// the request reached `WRITING`/`WRITTEN` and then timed out, so the host
    /// may already have committed and begun tearing down. Collapsing it into a
    /// not-committed result would let a caller report a serving daemon as
    /// untouched while it goes down.
    fn shutdown(&self, publication: &Path, deadline: Instant) -> Result<(), &'static str> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("shutdown_failed");
        }
        let path = publication.to_path_buf();
        self.inner.block_on(async move {
            // Bounded by the caller's deadline as well as by the client's own
            // timeouts: an unreachable or stalled peer must not let one attempt
            // outlive the budget the caller reserved for the whole operation.
            // A timeout here is an unknown outcome, not a proven failure — the
            // request may already have been written — so it is reported as such
            // and settled by observation.
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
///
/// The accepted shape must stay byte-for-byte identical to
/// `evaluateDaemonCompatibility` in
/// `packages/plugin/src/shared/mc-host-lifecycle/compatibility.ts`, whose
/// `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$` regex gates the same
/// authenticated `daemon_ver` against the same contract range. The two must
/// agree on every input or one side reports a daemon compatible while the other
/// rejects it, so `triple` rejects anything but three components that are pure
/// ASCII digits with no redundant leading zero — `u64::from_str` alone would
/// accept a leading `+` and `007`, neither of which the regex does.
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

/// Read-only, no-create observation. Mirrors the plan's `status` row
/// semantics: a coherent `stopped` observation is `not_running` (ok:false),
/// `running` with a contract-conforming publication is `healthy` (ok:true).
/// No connection is dialed: probe stays purely observational, so `proof`
/// and readiness stay null and `versions.daemon` is publication-diagnostic.
///
/// The emitted `command` is `status`, the contracted name for these row
/// semantics. The release contract fixes a closed command union of `start`,
/// `stop`, `restart`, `status`, and `doctor`, so a `probe` command would be
/// rejected by every consumer validating against the embedded contract. `probe`
/// remains an accepted CLI spelling of the same operation.
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

/// The staged start pipeline shared by `start` and `restart`'s successor
/// phase. The caller already holds the transaction lock and supplies the
/// aggregate deadline. Returns the terminal (ok, state, reason) triple plus
/// authenticated-transport readiness.
struct StartOutcome {
    ok: bool,
    state: &'static str,
    reason: &'static str,
    daemon_ver: Option<String>,
    generation_check: Option<(&'static str, &'static str)>,
}

/// Where the successor's generation comes from.
///
/// The two arms are exclusive by construction: a caller that already holds a
/// resolved generation has no use for a payload root or an expected digest, and
/// passing all three as separate parameters left the digest silently dead
/// whenever a preflighted generation was supplied.
enum SuccessorGeneration<'a> {
    /// Resolve during the start. `start` uses this: nothing was running, so there
    /// is no stop to sequence the resolution ahead of.
    Resolve {
        payload_dir: Option<&'a Path>,
        payload_manifest_digest: Option<&'a str>,
    },
    /// Reuse what the pre-stop preflight already resolved and validated, so
    /// `restart` validates its successor exactly once even though it has to do so
    /// before committing an irreversible stop.
    Preflighted(ResolvedGeneration),
}

/// Starts a successor daemon.
fn start_phase(
    runtime: &Runtime,
    generation: SuccessorGeneration<'_>,
    anchor: &NamespaceAnchor,
    outer: Instant,
    launcher_envelope: serve::LauncherEnvelope,
    stop_committed: bool,
) -> StartOutcome {
    // Resolution failures are the only ones that say anything about the retained
    // artifact, so they are the only ones that may report the generation check as
    // failing.
    let unresolved = |state: &'static str, reason: &'static str| StartOutcome {
        ok: false,
        state,
        reason,
        daemon_ver: None,
        generation_check: Some(("fail", reason)),
    };
    // Every failure after resolution — namespace drift, log or envelope faults,
    // spawn faults, a spent budget — leaves a generation that was completely
    // validated moments earlier. Reporting `artifact.current_generation` as
    // failing there would tell a diagnostic consumer the retained artifact is
    // corrupt on the strength of an unrelated lifecycle or spawn error.
    let resolved_but_failed = |state: &'static str, reason: &'static str| StartOutcome {
        ok: false,
        state,
        reason,
        daemon_ver: None,
        generation_check: Some(("pass", "healthy")),
    };

    // Validate or stage the requested generation (KTD9).
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

    // Namespace identity must still hold before the spawn commit (KTD2).
    if anchor.verify().is_err() {
        return resolved_but_failed("wedged", "wedged");
    }

    // Generation resolution stages and hashes every payload file synchronously
    // and can outlast the aggregate on slow storage. With nothing committed,
    // spawning past the budget would report `startup_timeout` to the caller while
    // a daemon comes up behind it, so the spawn is refused instead and the caller
    // can retry cleanly. Resolution already succeeded, so the generation check
    // passes.
    //
    // Once a stop is committed the trade inverts: the spawn is the only path back
    // to service, and refusing it would turn an overrun into an outage. The
    // deadline must never be the reason a committed stop has no successor, so the
    // aggregate is allowed to overrun rather than the daemon left down. The
    // pre-stop reservation in `cmd_restart` is what keeps that overrun rare;
    // post-stop staging is unbounded work that no reservation can size.
    if !stop_committed && Instant::now() >= outer {
        return resolved_but_failed("stopped", "startup_timeout");
    }

    // The library owns the managed layout; deriving the data root by
    // walking parents off a derived path would silently break if that
    // layout ever gained or lost a level.
    let data_dir = match mc_host::data_dir_path(None) {
        Ok(data_dir) => data_dir,
        Err(_) => return resolved_but_failed("stopped", "internal_error"),
    };
    let envelope = launcher_envelope.materialize_into_startup(data_dir, digest);
    let envelope_bytes = match serde_json::to_vec(&envelope) {
        Ok(bytes) => bytes,
        // A Unix data root may hold bytes that are not valid UTF-8, which the
        // JSON envelope cannot represent. That is an operational failure of this
        // command, not a reason to abandon the single required result object
        // after generation staging has already run.
        Err(_) => return resolved_but_failed("stopped", "internal_error"),
    };
    let log_path = match daemon_log_path() {
        Ok(path) => path,
        Err(_) => return resolved_but_failed("stopped", "internal_error"),
    };
    if spawn::spawn_detached(&log_path, &envelope_bytes, generation_launcher).is_err() {
        return resolved_but_failed("stopped", "internal_error");
    }

    // Bounded wait for publication evidence plus authentication — never for
    // the child PID.
    let deadline = phase_deadline(outer, phase_cap(SPAWN_PUBLICATION_AUTH));
    let publication = match publication_path() {
        Ok(path) => path,
        Err(_) => return resolved_but_failed("stopped", "internal_error"),
    };
    loop {
        // Authentication alone does not prove *this* root has a serving daemon: a
        // still-valid publication left in the runtime directory authenticates
        // whichever endpoint it names, which need not be the child being waited
        // on. A coherent `Running` probe is the local evidence that a lock-held
        // incarnation exists here, and the daemon publishes only after taking its
        // fences, so requiring it costs nothing on the success path.
        if publication.exists() && runtime.authenticate(&publication, deadline) {
            if let Ok(observed) = probe() {
                if observed.state == LifecycleState::Running {
                    let daemon_ver = publication_daemon_ver(&observed);
                    if let Some(daemon_ver) = &daemon_ver {
                        if !daemon_version_compatible(daemon_ver) {
                            return StartOutcome {
                                ok: false,
                                state: "running",
                                reason: "incompatible_daemon",
                                daemon_ver: Some(daemon_ver.clone()),
                                generation_check: Some(("pass", "healthy")),
                            };
                        }
                    }
                    return StartOutcome {
                        ok: true,
                        state: "running",
                        reason: "started",
                        daemon_ver,
                        generation_check: Some(("pass", "healthy")),
                    };
                }
            }
        }
        if Instant::now() >= deadline {
            // A child that exited before publishing — a rejected envelope or a
            // failed post-fork step — leaves a coherent `stopped` observation.
            // Reporting that as `wedged` would claim fence incoherence and emit
            // failed lifecycle checks with no daemon left to inspect.
            let state = match probe().map(|observed| observed.state) {
                Ok(LifecycleState::Starting) => "starting",
                Ok(LifecycleState::Stopped) => "stopped",
                _ => "wedged",
            };
            return StartOutcome {
                ok: false,
                state,
                reason: "startup_timeout",
                daemon_ver: None,
                generation_check: Some(("pass", "healthy")),
            };
        }
        std::thread::sleep(REPROBE_INTERVAL);
    }
}

/// Read-only preflight of the successor generation, run before any stop.
///
/// `restart` commits an irreversible stop, so every successor condition that
/// is already true on disk must be discovered first. Otherwise an absent
/// store, an absent or quarantined profile, or a generation that fails
/// revalidation takes the serving daemon down with `stop_committed:true`,
/// `start_committed:false`, and no takeover — a hard outage produced by
/// state that was observable before anything was touched.
///
/// Returns the resolved generation when the caller may reuse it, so the
/// successor start does not pay a second validation pass.
fn preflight_generation(
    payload_dir: Option<&Path>,
    payload_manifest_digest: Option<&str>,
) -> Result<Option<ResolvedGeneration>, (&'static str, &'static str)> {
    // Platform support is pre-existing state like any other, so it is decided
    // here rather than inside the post-stop resolution: otherwise
    // `restart --payload-dir` on an unsupported target commits the stop and only
    // then reports `unsupported_platform`, which is an outage produced by a
    // condition that was knowable before anything was touched.
    if build_target().is_none() {
        return Err(("stopped", "unsupported_platform"));
    }
    match payload_dir {
        // Dev staging prunes, stages, and promotes, so the mutation must stay
        // after the stop. Everything read-only about it is preflighted here: the
        // source tree, and the destination store's own state. A quarantined or
        // insecure store fails staging just as surely as a bad source tree does,
        // and it is observable under the lock we already hold, so discovering it
        // after the stop would commit an outage for a condition that was knowable
        // beforehand.
        Some(dir) => {
            payload_sources(dir, payload_manifest_digest)?;
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
        // Production resolution is entirely read-only, so it runs in full
        // here and its result — digest and retained launcher alike — is handed
        // to the successor start.
        None => resolve_generation(None, payload_manifest_digest).map(Some),
    }
}

/// This build's payload target, in the release contract's platform spelling.
///
/// The contract enumerates `platforms.supported[].target`; staging commits one
/// of those names into every manifest, and selection compares against it. A
/// single definition keeps the value the staging path writes and the value the
/// selection path requires from drifting apart.
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

/// Confirms a validated generation was staged by this release for this target.
///
/// `validate` proves a generation is internally coherent, not that it belongs
/// to the running binary. An upgrade or a copied data directory can leave a
/// structurally valid generation from another release or platform as the
/// current selection; without this check the new daemon would accept and
/// advertise that payload. Both fields are committed by the manifest, so the
/// comparison is against content the digest already binds.
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

/// A generation that resolved, with the launcher the successor must exec.
///
/// The launcher is the payload's own `ck-mc-host`, opened through the validated
/// generation so the descriptor names bytes the digest already covers. It is
/// absent when the retained payload carries no launcher, in which case the
/// successor re-execs the running image.
struct ResolvedGeneration {
    digest: String,
    launcher: Option<std::os::fd::OwnedFd>,
}

/// Opens the generation's own launcher, or reports that it has none.
///
/// `.ok()` on the verification result conflated two different states: a dev
/// fixture that legitimately ships no launcher, and a production payload whose
/// launcher was deleted, truncated, or rewritten since staging. Both reached
/// `spawn_detached` as `None`, which then re-execs the *running* binary — so a
/// tampered launcher produced a successful start from bytes outside the selected
/// generation instead of failing closed.
///
/// The manifest separates the two: a launcher it names must verify, and one it
/// does not name does not exist.
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
        return Ok(None);
    }
    validated
        .open_verified_file(PRODUCTION_LAUNCHER)
        .map(Some)
        .map_err(|_| ("stopped", "native_payload_invalid"))
}

/// An explicit verified payload root stages a candidate. Without one, only a
/// fully valid retained current generation may start.
///
/// `payload_manifest_digest` is the digest the caller requires the resolved
/// generation to have been staged from; a mismatch is `native_payload_invalid`.
fn resolve_generation(
    payload_dir: Option<&Path>,
    payload_manifest_digest: Option<&str>,
) -> Result<ResolvedGeneration, (&'static str, &'static str)> {
    // Platform support is decided before any payload state is inspected. The
    // contract orders `unsupported_platform` ahead of `native_payload_missing`
    // in its failing-reason precedence, and on an unsupported target a fresh
    // data root would otherwise report a missing payload and tell the user to
    // install one that cannot run here.
    let Some(target) = build_target() else {
        return Err(("stopped", "unsupported_platform"));
    };
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
                target: target.to_owned(),
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
                    // A caller naming the digest it expects is asserting which payload
                    // the successor must come from, so a generation that disagrees —
                    // or that predates the field and cannot answer at all — is not
                    // the one that was asked for.
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
    if canonical.contains(&b'\n')
        || format!("{:x}", sha2::Sha256::digest(canonical)) != expected_manifest_digest
    {
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
        // The qualified lock is compiled into this executable, so the payload has to
        // cite that exact one. Checking only that the value was well-formed hex let a
        // manifest label arbitrary model, ORT, or harness bytes as production while
        // naming an unrelated lock, and the generation then persisted that unverified
        // claim as its own provenance.
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
    // A quarantined record blocks the start in every observed state, so it is
    // classified before the state dispatch rather than only on `wedged`.
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
            if !runtime.authenticate(&publication, auth_deadline) {
                return DaemonResult::new(command, false, "running", "authentication_failed");
            }
            let daemon_ver = publication_daemon_ver(&observed);
            if let Some(daemon_ver) = &daemon_ver {
                if !daemon_version_compatible(daemon_ver) {
                    let mut result =
                        DaemonResult::new(command, false, "running", "incompatible_daemon");
                    result.versions.daemon = Some(daemon_ver.clone());
                    return result;
                }
            }
            let mut result = DaemonResult::new(command, true, "running", "already_running");
            result.versions.daemon = daemon_ver;
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
            let outcome = start_phase(
                &runtime,
                SuccessorGeneration::Resolve {
                    payload_dir,
                    payload_manifest_digest,
                },
                &anchor,
                outer,
                launcher_envelope,
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

/// Committed-stop phase shared by `stop` and `restart`. The caller holds the
/// transaction lock and has already observed `Running`. Returns
/// `(stop_committed, terminal)` where terminal is `Ok(())` for a completed
/// teardown or the (state, reason) failure.
///
/// An unknown shutdown outcome is resolved by observation, never assumed: the
/// host commits at full-frame write completion, so a client-side timeout can
/// race a commit that already happened. Reporting that as not-committed would
/// tell a caller the daemon is untouched while it is tearing down, and would
/// make `restart` skip its successor start.
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
        // The frame was in flight when the client deadline expired: the host
        // may already have committed. Fall through to the teardown wait and
        // let the probe decide, rather than asserting either bit.
        Err("shutdown_outcome_unknown") => commit_uncertain = true,
        // A response-in-flight attempt that did not settle: not committed.
        Err(_) => return (false, Err(("running", "lifecycle_busy"))),
    }
    // Acknowledged (or in-flight and unresolved): wait for the teardown to
    // become observable and let the probe settle the commit question.
    let deadline = phase_deadline(outer, phase_cap(STOP_TEARDOWN));
    loop {
        match probe() {
            // Observed teardown proves the commit, acknowledged or not.
            Ok(observed) if observed.state == LifecycleState::Stopped => {
                return (true, Ok(()));
            }
            Ok(_) => {}
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            if commit_uncertain {
                // Never acknowledged, so the commit is decided by observation
                // rather than assumed in either direction.
                return match probe().map(|observed| observed.state) {
                    // Still fully running: the shutdown did not take effect,
                    // so the daemon really is untouched.
                    Ok(LifecycleState::Running) => (false, Err(("running", "lifecycle_busy"))),
                    // Teardown is visibly underway or no longer readable:
                    // report a committed stop so no caller assumes the
                    // daemon kept serving.
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
    // Classified before the state dispatch so a quarantined record is not
    // reported as a clean `already_stopped`: it carries an `align_versions`
    // remediation and will block the next start.
    if let Some((state, reason)) = quarantined_observation(&observed) {
        return DaemonResult::new(command, false, state, reason);
    }
    match observed.state {
        // No lock-held incarnation: nothing to signal, unlink, or clean.
        LifecycleState::Stopped => DaemonResult::new(command, true, "stopped", "already_stopped"),
        LifecycleState::Wedged => DaemonResult::new(command, false, "wedged", "wedged"),
        LifecycleState::Starting | LifecycleState::Stopping => DaemonResult::new(
            command,
            false,
            probe_state(observed.state),
            "lifecycle_busy",
        ),
        LifecycleState::Running => match stop_phase(&runtime, outer) {
            (_, Ok(())) => DaemonResult::new(command, true, "stopped", "stopped"),
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
    // Classified before any stop: a quarantined record blocks the successor
    // start in every observed state, so committing a stop over it would
    // guarantee an outage with no takeover.
    if let Some((state, reason)) = quarantined_observation(&observed) {
        return DaemonResult::new(command, false, state, reason)
            .with_effects(effects(false, false));
    }
    // States that cannot be restarted at all return before the successor
    // preflight, so no validation work is done for a request that bails.
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
    // The stop below is irreversible, so the successor is proven resolvable
    // first. Every failure here is pre-existing on-disk state and reports
    // both effect bits false with the daemon still serving.
    let preresolved = match preflight_generation(payload_dir, payload_manifest_digest) {
        Ok(preresolved) => preresolved,
        Err((_, reason)) => {
            // Nothing has been touched, so the reported state is the one just
            // observed rather than the resolver's start-from-stopped default.
            return DaemonResult::new(command, false, probe_state(observed.state), reason)
                .with_effects(effects(false, false));
        }
    };
    let stop_committed = match observed.state {
        LifecycleState::Running => {
            // The stop is irreversible and the successor start needs a budget of
            // its own, so the successor's phase is *reserved* out of the
            // aggregate rather than merely checked once: the stop is given
            // `outer` minus that reservation, so no amount of time spent
            // acknowledging or observing the teardown can consume it. Checking a
            // snapshot and then handing the stop the full aggregate would let a
            // shutdown that acknowledges near the deadline leave the old daemon
            // stopped with `start_phase` refusing to spawn — an outage
            // manufactured by a deadline rather than by any on-disk state.
            //
            // When the reservation cannot be met the restart is refused with the
            // daemon still serving and both effect bits false; retrying is the
            // contract remediation for `lifecycle_busy`, and a refused restart is
            // recoverable where a committed stop with no successor is not.
            let stop_deadline = match outer.checked_sub(phase_cap(SPAWN_PUBLICATION_AUTH)) {
                Some(deadline) if deadline > Instant::now() => deadline,
                _ => {
                    return DaemonResult::new(command, false, "running", "lifecycle_busy")
                        .with_effects(effects(false, false));
                }
            };
            match stop_phase(&runtime, stop_deadline) {
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
            }
        }
        // Nothing was running, so there is no stop to commit.
        _ => false,
    };
    let outcome = start_phase(
        &runtime,
        // Dev staging mutates, so the preflight leaves it for the post-stop
        // resolution; production resolution is read-only and already ran.
        match preresolved {
            Some(resolved) => SuccessorGeneration::Preflighted(resolved),
            None => SuccessorGeneration::Resolve {
                payload_dir,
                payload_manifest_digest,
            },
        },
        &anchor,
        outer,
        launcher_envelope,
        stop_committed,
    );
    let start_committed = outcome.ok;
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
        assert!(matches!(parse_args(&os(&["status"])), Ok(Command::Status)));
        // `probe` is the accepted historical spelling of the same command.
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
            // The payload must cite the lock compiled into this binary; any other
            // well-formed digest is rejected.
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
        let startup = envelope.materialize_into_startup(root.path().to_path_buf(), "cd".repeat(32));
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

    /// The accepted shape must match `evaluateDaemonCompatibility`'s
    /// `^(\d+)\.(\d+)\.(\d+)$` in
    /// `packages/plugin/src/shared/mc-host-lifecycle/compatibility.ts`. A
    /// component that side accepts and this one rejects (or the reverse) makes
    /// a native result and the TypeScript policy verdict contradict each other
    /// for the same daemon.
    #[test]
    fn daemon_version_shape_matches_the_typescript_gate() {
        // `u64::from_str` alone accepts these; the regex does not.
        assert!(!daemon_version_compatible("mc-host/+0.1.0"));
        assert!(!daemon_version_compatible("mc-host/0.+1.0"));
        assert!(!daemon_version_compatible("mc-host/0.1.+0"));
        // Neither side accepts empty components, signs, or whitespace.
        assert!(!daemon_version_compatible("mc-host/0..0"));
        assert!(!daemon_version_compatible("mc-host/0.1."));
        assert!(!daemon_version_compatible("mc-host/-0.1.0"));
        assert!(!daemon_version_compatible("mc-host/ 0.1.0"));
        assert!(!daemon_version_compatible("mc-host/0.1.0 "));
        assert!(!daemon_version_compatible("mc-host/0.1.0-rc1"));
        assert!(!daemon_version_compatible("mc-host/0.1.0.0"));
        // A redundant leading zero is not the canonical spelling, and the
        // mismatch detail both sides emit calls the grammar canonical, so
        // neither side may accept it.
        assert!(!daemon_version_compatible("mc-host/0.01.0"));
        assert!(!daemon_version_compatible("mc-host/00.1.0"));
        assert!(!daemon_version_compatible("mc-host/0.1.00"));
        assert!(!daemon_version_compatible("mc-host/01.2.3"));
        // A single zero component is canonical and stays accepted.
        assert!(daemon_version_compatible("mc-host/0.1.0"));
    }
}
