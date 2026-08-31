//!
//! Dev-mode lifecycle tests require exact KTD12 result shapes.

#![cfg(unix)]

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
//
// Published daemons require Broca.
// Broca verifies process identity through `/proc` before initializing.
// Broca cannot initialize outside environments that provide `/proc`, so spawned daemons cannot publish there.
//
// Lifecycle path walks open every component with `O_NOFOLLOW`.
// Each isolated data root lives under the per-user temporary directory.
// On macOS, the per-user temporary directory resolves through `/var`.
// Because `/var` is a symlink to `private/var`, `O_NOFOLLOW` rejects the root itself.
// The read-only probe reports the root-symlink refusal as `wedged`/`wedged`.
// Coordination-lock openers report the root-symlink refusal as `wedged`/`internal_error`.
// The root-symlink refusal overrides the state described by the root contents.
//
// Linux-gated tests require a published daemon or an observed lifecycle state; argument-parsing and version-metadata tests resolve no data root and remain portable.
#[cfg(target_os = "linux")]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
use mc_module::{
    COMPARTMENT_RENDER_FORMAT_EPOCH, MEMORY_RENDER_FORMAT_EPOCH,
    PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC, STATE_SYNC_EPOCH, TAGGER_FEATURE_EPOCH,
};
use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_ck-mc-host");
/// Debug-build daemons on loaded CI hosts can exceed the 3s spawn/publication/auth phase cap.
/// `CK_MC_HOST_TEST_PHASE_CAP_MS` widens only phase caps.
/// The 60s aggregate cap still applies.
const PHASE_CAP_MS: &str = "30000";

struct CliOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

#[cfg(target_os = "linux")]
impl CliOutput {
    fn json(&self) -> Value {
        let mut lines = self.stdout.lines();
        let line = lines.next().unwrap_or_else(|| {
            panic!(
                "expected one JSON line, got empty stdout; stderr: {}",
                self.stderr
            )
        });
        assert_eq!(lines.next(), None, "exactly one stdout line expected");
        serde_json::from_str(line).expect("stdout line parses as JSON")
    }
}

fn run(root: &Path, args: &[&str]) -> CliOutput {
    run_with_envelope(root, args, None)
}

fn run_with_envelope(root: &Path, args: &[&str], envelope: Option<&Value>) -> CliOutput {
    run_with_envelope_and_env(root, args, envelope, &[])
}

fn run_with_envelope_and_env(
    root: &Path,
    args: &[&str],
    envelope: Option<&Value>,
    env: &[(&str, &str)],
) -> CliOutput {
    let mut command = Command::new(BIN);
    command
        .args(args)
        .env_clear()
        .env("XDG_DATA_HOME", root)
        .env("CK_MC_HOST_TEST_PHASE_CAP_MS", PHASE_CAP_MS)
        .env("CK_MC_HOST_TEST_ALLOW_SELF_EXEC", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command.spawn().expect("ck-mc-host spawns");
    if let Some(envelope) = envelope {
        let bytes = serde_json::to_vec(envelope).expect("launcher envelope serializes");
        child
            .stdin
            .take()
            .expect("launcher stdin")
            .write_all(&bytes)
            .expect("launcher envelope writes");
    }
    let output = child.wait_with_output().expect("ck-mc-host exits");
    CliOutput {
        code: output.status.code().expect("ck-mc-host exits with a code"),
        stdout: String::from_utf8(output.stdout).expect("stdout is UTF-8"),
        stderr: String::from_utf8(output.stderr).expect("stderr is UTF-8"),
    }
}

#[cfg(target_os = "linux")]
fn assert_result(value: &Value, command: &str, ok: bool, state: &str, reason: &str) {
    assert_eq!(value["schema"], "magic-context.daemon/v1");
    assert_eq!(value["command"], command);
    assert_eq!(value["ok"], ok);
    assert_eq!(value["state"], state);
    assert_eq!(value["reason"], reason);
    let checks = value["checks"].as_array().expect("checks array");
    let ids: Vec<&str> = checks
        .iter()
        .map(|check| check["id"].as_str().expect("check id"))
        .collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    assert_eq!(ids, sorted, "check IDs must be lexicographically sorted");
    assert_eq!(value["versions"]["release"], "0.38.0");
}

#[cfg(target_os = "linux")]
fn effects(value: &Value) -> (bool, bool) {
    (
        value["effects"]["stop_committed"]
            .as_bool()
            .expect("stop_committed"),
        value["effects"]["start_committed"]
            .as_bool()
            .expect("start_committed"),
    )
}

#[cfg(target_os = "linux")]
fn write_payload(dir: &Path) {
    std::fs::create_dir_all(dir.join("bin")).expect("payload bin dir");
    std::fs::write(dir.join("bin/tool"), b"#dev-binary-bytes").expect("payload tool");
    std::fs::set_permissions(dir.join("bin/tool"), std::fs::Permissions::from_mode(0o700))
        .expect("payload tool mode");
    std::fs::write(dir.join("notices.txt"), b"dev notices").expect("payload notices");
}

#[cfg(target_os = "linux")]
fn coordination_dir(root: &Path) -> PathBuf {
    root.join(".mc-host-coordination")
}

#[cfg(target_os = "linux")]
fn daemon_id(root: &Path) -> [u8; 16] {
    let publication = mc_host::runtime_dir_path(Some(root))
        .expect("runtime dir")
        .join(mc_host::CONNECTION_FILE_NAME);
    mc_host::read_connection_file(publication)
        .expect("connection file")
        .daemon_id
}

#[cfg(target_os = "linux")]
fn try_flock_exclusive(path: &Path) -> bool {
    use std::os::fd::AsRawFd;
    let file = std::fs::File::open(path).expect("lock file opens");
    let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    if locked {
        unsafe {
            libc::flock(file.as_raw_fd(), libc::LOCK_UN);
        }
    }
    locked
}

/// `InstanceGuard` attempts to stop its daemon on drop so failed assertions do not leak it.
#[cfg(target_os = "linux")]
struct DaemonJanitor {
    root: PathBuf,
    active: bool,
}

#[cfg(target_os = "linux")]
impl Drop for DaemonJanitor {
    fn drop(&mut self) {
        if self.active {
            let _ = run(&self.root, &["stop"]);
        }
    }
}

#[test]
fn usage_errors_exit_2_with_no_lifecycle_call() {
    let root = tempfile::tempdir().expect("root");
    let cases: &[&[&str]] = &[
        &[],
        &["bogus"],
        &["start", "extra"],
        &["stop", "--payload-dir", "x"],
        &["start", "--payload-dir"],
        &["start", "--payload-dir", "a", "--payload-dir", "b"],
        &["probe", "--version"],
    ];
    for args in cases {
        let out = run(root.path(), args);
        assert_eq!(out.code, 2, "args {args:?} must be a usage error");
        assert!(
            out.stdout.is_empty(),
            "usage errors emit no lifecycle object: {args:?}"
        );
        assert!(!out.stderr.is_empty(), "usage errors explain on stderr");
    }
    assert!(
        !root.path().join("data").exists()
            && std::fs::read_dir(root.path()).unwrap().next().is_none(),
        "usage errors must not touch the filesystem"
    );
}

#[test]
fn version_and_release_info_are_side_effect_free() {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");

    let version = run(&data, &["--version"]);
    assert_eq!(version.code, 0);
    assert!(version.stdout.contains("0.38.0"));
    assert!(version.stdout.contains("mc-host/0.1.0"));

    let info = run(&data, &["release-info"]);
    assert_eq!(info.code, 0);
    let contract: Value = serde_json::from_str(&info.stdout).expect("release contract JSON");
    assert_eq!(contract["schema"], "magic-context.mc-host-release/v1");
    assert_eq!(contract["release"]["version"], "0.38.0");
    assert_eq!(
        info.stdout.trim(),
        mc_module::release_contract::RELEASE_CONTRACT_JSON
    );

    let inputs = run(&data, &["input-lock-digest"]);
    assert_eq!(inputs.code, 0);
    assert_eq!(
        inputs.stdout.trim(),
        mc_module::production_inputs::PRODUCTION_INPUTS_LOCK_SHA256
    );
    assert_eq!(inputs.stdout.trim().len(), 64);

    assert!(!data.exists(), "metadata commands must not create the root");
}

#[cfg(target_os = "linux")]
#[test]
fn probe_on_empty_root_reports_stopped_without_mutation() {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");

    let out = run(&data, &["probe"]);
    assert_eq!(out.code, 1);
    let value = out.json();
    assert_result(&value, "status", false, "stopped", "not_running");
    assert_eq!(value["remediation"], "run_daemon_start");
    assert_eq!(value["effects"], Value::Null);
    assert!(
        !data.exists(),
        "read-only probe must not create the data root or coordination dir"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn start_without_staged_payload_fails_closed_in_production_mode() {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");

    let out = run(&data, &["start"]);
    assert_eq!(out.code, 1);
    let value = out.json();
    assert_result(&value, "start", false, "stopped", "native_payload_missing");
    assert_eq!(value["remediation"], "install_native_payload");
    // The failed start acquired the transaction lock but staged nothing.
    assert!(!data.join("cortexkit").join("run").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn restart_start_failure_from_stopped_reports_false_false() {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");

    let out = run(
        &data,
        &[
            "restart",
            "--payload-dir",
            "/nonexistent-ck-mc-host-payload",
        ],
    );
    assert_eq!(out.code, 1);
    let value = out.json();
    assert_result(
        &value,
        "restart",
        false,
        "stopped",
        "native_payload_invalid",
    );
    assert_eq!(effects(&value), (false, false));
}

#[cfg(target_os = "linux")]
#[test]
fn start_reports_lifecycle_busy_while_transaction_lock_is_held() {
    use std::os::fd::AsRawFd;
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");
    let coordination = coordination_dir(&data);
    std::fs::create_dir_all(&coordination).expect("coordination dir");
    std::fs::set_permissions(&coordination, std::fs::Permissions::from_mode(0o700))
        .expect("coordination mode");
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).expect("data mode");
    let lock_path = coordination.join("transaction.lock");
    std::fs::write(&lock_path, b"").expect("transaction lock file");
    std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o600))
        .expect("lock mode");
    let holder = std::fs::File::open(&lock_path).expect("lock opens");
    assert_eq!(
        unsafe { libc::flock(holder.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0,
        "test holds the transaction lock"
    );

    let out = run(&data, &["start"]);
    assert_eq!(out.code, 1);
    let value = out.json();
    assert_eq!(value["command"], "start");
    assert_eq!(value["ok"], false);
    assert_eq!(value["reason"], "lifecycle_busy");
    assert_eq!(value["remediation"], "wait_and_retry");
}

#[cfg(target_os = "linux")]
#[test]
fn stop_reports_wedged_when_lifetime_fence_is_held_without_a_runtime_dir() {
    use std::os::fd::AsRawFd;
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");
    let coordination = coordination_dir(&data);
    std::fs::create_dir_all(&coordination).expect("coordination dir");
    std::fs::set_permissions(&coordination, std::fs::Permissions::from_mode(0o700))
        .expect("coordination mode");
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).expect("data mode");
    let lock_path = coordination.join("lifetime.lock");
    std::fs::write(&lock_path, b"").expect("lifetime lock file");
    std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o600))
        .expect("lock mode");
    let holder = std::fs::File::open(&lock_path).expect("lock opens");
    assert_eq!(
        unsafe { libc::flock(holder.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0,
        "test holds the lifetime fence"
    );

    let out = run(&data, &["stop"]);
    assert_eq!(out.code, 1);
    let value = out.json();
    assert_result(&value, "stop", false, "wedged", "wedged");
    assert_eq!(value["remediation"], "inspect_daemon_process");
    // Cleanup must not unlink or signal; the quarantined lock file must survive.
    assert!(lock_path.exists());
}

#[cfg(target_os = "linux")]
#[test]
fn dev_payload_without_explicit_test_self_exec_fails_closed() {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");
    let payload = root.path().join("payload");
    write_payload(&payload);
    let payload_arg = payload.to_str().expect("payload path");

    let out = run_with_envelope_and_env(
        &data,
        &["start", "--payload-dir", payload_arg],
        None,
        &[("CK_MC_HOST_TEST_ALLOW_SELF_EXEC", "0")],
    );
    assert_eq!(out.code, 1);
    assert_result(
        &out.json(),
        "start",
        false,
        "stopped",
        "native_payload_invalid",
    );
}

/// `probe_lifecycle`, `start`, `restart`, and `stop` must return `unsupported_state_schema` for a quarantined record with both fences free.
/// every command.
///
/// A command that checks only the `wedged` shape would treat the quarantined record as startable.
/// `start` and `restart` would spawn a child that `InstanceGuard` refuses, then report `startup_timeout`.
/// `probe_lifecycle`, `start`, `restart`, and `stop` must not modify the preserved bytes.
#[cfg(target_os = "linux")]
#[test]
fn quarantined_record_is_classified_alike_by_every_command() {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");
    let run_dir = data.join("cortexkit").join("run");
    std::fs::create_dir_all(&run_dir).expect("runtime dir");
    for dir in [&data, &data.join("cortexkit"), &run_dir] {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).expect("dir mode");
    }
    // Schema 2 decodes as an unknown schema: preserved, never repaired.
    let record = run_dir.join("mc-host-lifecycle.json");
    let original = br#"{"schema":2,"unknown_future_field":true}"#;
    std::fs::write(&record, original).expect("quarantined record");
    std::fs::set_permissions(&record, std::fs::Permissions::from_mode(0o600)).expect("record mode");

    for (args, command, state) in [
        (vec!["probe"], "status", "stopped"),
        (vec!["start"], "start", "stopped"),
        (vec!["stop"], "stop", "stopped"),
        (vec!["restart"], "restart", "stopped"),
    ] {
        let out = run(&data, &args);
        let value = out.json();
        assert_eq!(out.code, 1, "{command} must fail closed");
        assert_result(&value, command, false, state, "unsupported_state_schema");
        assert_eq!(value["remediation"], "align_versions");
        if command == "restart" {
            assert_eq!(
                effects(&value),
                (false, false),
                "restart must not commit a stop over a quarantined record"
            );
        }
        assert_eq!(
            std::fs::read(&record).expect("record still present"),
            original,
            "{command} must not rewrite the quarantined record"
        );
    }
}

///
/// `restart` resolves the successor before stopping; otherwise it can commit `stop` without committing `start` and leave no takeover.
/// `restart` leaves the running daemon serving when successor resolution fails.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_preflights_the_successor_before_committing_the_stop() {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");
    let payload = root.path().join("payload");
    write_payload(&payload);
    let payload_arg = payload.to_str().expect("payload path");
    let mut janitor = DaemonJanitor {
        root: data.clone(),
        active: false,
    };

    let out = run(&data, &["start", "--payload-dir", payload_arg]);
    janitor.active = true;
    assert_eq!(out.code, 0, "start failed: {} {}", out.stdout, out.stderr);
    assert_result(&out.json(), "start", true, "running", "started");

    // The invalid successor is detected before `restart` commits `stop` or `start`.
    let out = run(
        &data,
        &[
            "restart",
            "--payload-dir",
            "/nonexistent-ck-mc-host-payload",
        ],
    );
    assert_eq!(out.code, 1);
    let value = out.json();
    assert_result(
        &value,
        "restart",
        false,
        "running",
        "native_payload_invalid",
    );
    assert_eq!(
        effects(&value),
        (false, false),
        "an unresolvable successor must not commit a stop"
    );

    // The daemon is still serving: the publication still authenticates.
    let out = run(&data, &["probe"]);
    assert_eq!(out.code, 0);
    assert_result(&out.json(), "status", true, "running", "healthy");
    let publication = mc_host::runtime_dir_path(Some(&data))
        .expect("runtime dir")
        .join(mc_host::CONNECTION_FILE_NAME);
    let client = mc_host::Client::connect(&publication)
        .await
        .expect("daemon still authenticates after the refused restart");
    client.close().await.expect("client closes");

    let out = run(&data, &["stop"]);
    assert_eq!(out.code, 0, "stop failed: {} {}", out.stdout, out.stderr);
    assert_result(&out.json(), "stop", true, "stopped", "stopped");
    janitor.active = false;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_dev_mode_lifecycle_roundtrip() {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");
    let payload = root.path().join("payload");
    write_payload(&payload);
    let payload_arg = payload.to_str().expect("payload path");
    let mut janitor = DaemonJanitor {
        root: data.clone(),
        active: false,
    };

    // `start` stages the development payload, spawns the detached daemon, and completes after authenticated transport is ready.
    let out = run(&data, &["start", "--payload-dir", payload_arg]);
    janitor.active = true;
    assert_eq!(out.code, 0, "start failed: {} {}", out.stdout, out.stderr);
    let value = out.json();
    assert_result(&value, "start", true, "running", "started");
    assert_eq!(value["remediation"], Value::Null);
    assert_eq!(value["effects"], Value::Null);
    assert_eq!(value["readiness"]["transport"]["state"], "ready");
    assert_eq!(value["versions"]["proof"], "current");
    assert_eq!(value["versions"]["daemon"], "mc-host/0.1.0");

    let publication = mc_host::runtime_dir_path(Some(&data))
        .expect("runtime dir")
        .join(mc_host::CONNECTION_FILE_NAME);
    let client = mc_host::Client::connect(&publication)
        .await
        .expect("published daemon authenticates");
    let readiness_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let status = client.host_status().await.expect("host status");
        let storage =
            status.metrics["components"]["magic-context"]["metrics"]["storage_state"].as_str();
        if storage == Some("ready") {
            let epochs = &status.metrics["components"]["magic-context"]["metrics"]["epochs"];
            assert_eq!(epochs["memory_render_epoch"], MEMORY_RENDER_FORMAT_EPOCH);
            assert_eq!(
                epochs["compartment_render_epoch"],
                COMPARTMENT_RENDER_FORMAT_EPOCH
            );
            assert_eq!(epochs["profile_epoch"], PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC);
            assert_eq!(epochs["tagger_epoch"], TAGGER_FEATURE_EPOCH);
            assert_eq!(epochs["state_sync_epoch"], STATE_SYNC_EPOCH);
            break;
        }
        assert!(
            tokio::time::Instant::now() < readiness_deadline,
            "storage did not become ready; last status: {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    client.close().await.expect("client closes");

    // Compatibility uses the version authenticated in the proof transcript.
    let out = run(&data, &["start"]);
    assert_eq!(out.code, 0, "start failed: {} {}", out.stdout, out.stderr);
    let value = out.json();
    assert_result(&value, "start", true, "running", "already_running");
    assert_eq!(value["versions"]["daemon"], "mc-host/0.1.0");

    let out = run(&data, &["status"]);
    assert_eq!(out.code, 0);
    assert_result(&out.json(), "status", true, "running", "healthy");

    // A second `start` reuses the compatible running incarnation without respawning it.
    let out = run(&data, &["start", "--payload-dir", payload_arg]);
    assert_eq!(out.code, 0);
    let value = out.json();
    assert_result(&value, "start", true, "running", "already_running");

    // `restart` atomically commits stopping the running daemon and starting its successor.
    let out = run(&data, &["restart", "--payload-dir", payload_arg]);
    assert_eq!(out.code, 0, "restart failed: {} {}", out.stdout, out.stderr);
    let value = out.json();
    assert_result(&value, "restart", true, "running", "started");
    assert_eq!(effects(&value), (true, true));

    // stop: commits at full-frame acknowledgement and waits for teardown.
    let out = run(&data, &["stop"]);
    assert_eq!(out.code, 0, "stop failed: {} {}", out.stdout, out.stderr);
    let value = out.json();
    assert_result(&value, "stop", true, "stopped", "stopped");
    janitor.active = false;

    assert!(!publication.exists(), "publication removed at teardown");
    let coordination = coordination_dir(&data);
    assert!(try_flock_exclusive(&coordination.join("transaction.lock")));
    assert!(try_flock_exclusive(&coordination.join("lifetime.lock")));
    let probe =
        mc_host::probe_lifecycle(Some(&data), &mc_host::ProbeFreshness::default()).expect("probe");
    assert_eq!(probe.state, mc_host::LifecycleState::Stopped);
    assert!(probe.instance_lock_free);
    assert!(probe.lifetime_lock_free);

    // A second `stop` finds no lock-held incarnation and neither unlinks nor signals anything.
    let out = run(&data, &["stop"]);
    assert_eq!(out.code, 0);
    assert_result(&out.json(), "stop", true, "stopped", "already_stopped");

    // A restart from stopped revalidates the promoted current generation without `--payload-dir`; its stop effect remains false.
    let out = run(&data, &["restart"]);
    janitor.active = true;
    assert_eq!(out.code, 0, "restart failed: {} {}", out.stdout, out.stderr);
    let value = out.json();
    assert_result(&value, "restart", true, "running", "started");
    assert_eq!(effects(&value), (false, true));

    // Final teardown.
    let out = run(&data, &["stop"]);
    assert_eq!(out.code, 0);
    assert_result(&out.json(), "stop", true, "stopped", "stopped");
    janitor.active = false;

    // `stop` completes daemon teardown before returning.
    let log = coordination_dir(&data).join("daemon.log");
    assert!(log.exists(), "detached daemon logged to the owner-only log");
    let mode = std::fs::metadata(&log)
        .expect("log metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "daemon log must be owner-only");
    tokio::time::sleep(Duration::from_millis(50)).await;
}

#[cfg(target_os = "linux")]
#[test]
fn credentialed_restart_is_explicit_exact_and_clears_stale_selection() {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");
    let payload = root.path().join("payload");
    write_payload(&payload);
    let payload_arg = payload.to_str().expect("payload path");
    let first_envelope = serde_json::json!({
        "schema": 1,
        "credentials": {"OPENAI_API_KEY": "first-owner-secret"}
    });
    let changed_envelope = serde_json::json!({
        "schema": 1,
        "credentials": {"OPENAI_API_KEY": "second-owner-secret"}
    });
    let merged_envelope = serde_json::json!({
        "schema": 1,
        "credentials": {
            "ANTHROPIC_API_KEY": "second-owner-secret",
            "OPENAI_API_KEY": "first-owner-secret"
        }
    });
    let mut janitor = DaemonJanitor {
        root: data.clone(),
        active: false,
    };

    let started = run_with_envelope(
        &data,
        &["start", "--payload-dir", payload_arg],
        Some(&first_envelope),
    );
    janitor.active = true;
    assert_eq!(
        started.code, 0,
        "credentialed start failed: {} {}",
        started.stdout, started.stderr
    );
    let first_id = daemon_id(&data);
    let selection = data
        .join("cortexkit")
        .join("mc-host-harness-closures")
        .join("active-selection.json");

    let plain_start = run(&data, &["start"]);
    assert_eq!(plain_start.code, 0);
    assert_result(
        &plain_start.json(),
        "start",
        true,
        "running",
        "already_running",
    );
    assert_eq!(daemon_id(&data), first_id);

    let conflicting_start = run_with_envelope(&data, &["start"], Some(&changed_envelope));
    assert_eq!(conflicting_start.code, 1);
    assert_result(
        &conflicting_start.json(),
        "start",
        false,
        "running",
        "harness_unavailable",
    );
    assert_eq!(
        daemon_id(&data),
        first_id,
        "start must never replace a healthy daemon"
    );

    let rejected_restart = run_with_envelope(&data, &["restart"], Some(&changed_envelope));
    assert_eq!(rejected_restart.code, 1);
    assert_result(
        &rejected_restart.json(),
        "restart",
        false,
        "running",
        "harness_unavailable",
    );
    assert_eq!(effects(&rejected_restart.json()), (false, false));
    assert_eq!(
        daemon_id(&data),
        first_id,
        "credential mismatch must fail before restart commits"
    );

    let invalid_descriptor = serde_json::json!({
        "schema": 1,
        "opencode": {
            "manifest_sha256": "f".repeat(64),
            "source_roots": {"runtime": "/missing/qualified-runtime"}
        },
        "credentials": {"OPENAI_API_KEY": "first-owner-secret"}
    });
    let rejected_descriptor_restart =
        run_with_envelope(&data, &["restart"], Some(&invalid_descriptor));
    assert_eq!(rejected_descriptor_restart.code, 1);
    assert_result(
        &rejected_descriptor_restart.json(),
        "restart",
        false,
        "running",
        "harness_unavailable",
    );
    assert_eq!(effects(&rejected_descriptor_restart.json()), (false, false));
    assert_eq!(
        daemon_id(&data),
        first_id,
        "invalid descriptor must fail before restart commits"
    );

    let additive_start = run_with_envelope(&data, &["start"], Some(&merged_envelope));
    assert_eq!(additive_start.code, 1);
    assert_result(
        &additive_start.json(),
        "start",
        false,
        "running",
        "harness_unavailable",
    );
    assert_eq!(
        daemon_id(&data),
        first_id,
        "start must not restart to merge an additional credential row"
    );

    let selection_before_changed_restart =
        std::fs::read(&selection).expect("active selection before rejected restart");
    let changed_restart = run_with_envelope(&data, &["restart"], Some(&merged_envelope));
    assert_eq!(changed_restart.code, 1);
    assert_result(
        &changed_restart.json(),
        "restart",
        false,
        "running",
        "harness_unavailable",
    );
    assert_eq!(effects(&changed_restart.json()), (false, false));
    assert_eq!(
        daemon_id(&data),
        first_id,
        "restart must not adopt changed credential or descriptor snapshots"
    );
    assert_eq!(
        std::fs::read(&selection).expect("active selection after rejected restart"),
        selection_before_changed_restart,
        "rejected restart must preserve active selection bytes"
    );

    let refresh_stop = run(&data, &["stop"]);
    assert_eq!(refresh_stop.code, 0);
    assert_result(&refresh_stop.json(), "stop", true, "stopped", "stopped");
    janitor.active = false;

    let demand_started = run_with_envelope(&data, &["start"], Some(&merged_envelope));
    assert_eq!(
        demand_started.code, 0,
        "demand start failed: {} {}",
        demand_started.stdout, demand_started.stderr
    );
    assert_result(&demand_started.json(), "start", true, "running", "started");
    janitor.active = true;
    assert_ne!(
        daemon_id(&data),
        first_id,
        "stop plus later demand-start must rotate daemon identity"
    );

    let failed_commit = run_with_envelope_and_env(
        &data,
        &["restart"],
        Some(&merged_envelope),
        &[("CK_MC_HOST_TEST_FAIL_SELECTION_FSYNC", "1")],
    );
    assert_eq!(failed_commit.code, 1);
    assert_result(
        &failed_commit.json(),
        "restart",
        false,
        "stopped",
        "internal_error",
    );
    assert_eq!(effects(&failed_commit.json()), (true, true));
    assert!(
        !selection.exists(),
        "failed post-rename selector commit must remove the stale selector"
    );
    janitor.active = false;

    let stopped = run(&data, &["stop"]);
    assert_eq!(stopped.code, 0);
    janitor.active = false;

    let unknown = b"{\"schema\":2,\"future\":\"preserve-me\"}";
    std::fs::write(&selection, unknown).expect("unknown selection fixture");
    std::fs::set_permissions(&selection, std::fs::Permissions::from_mode(0o600))
        .expect("unknown selection mode");
    let unknown_start = run(&data, &["start"]);
    assert_eq!(unknown_start.code, 1);
    assert_result(
        &unknown_start.json(),
        "start",
        false,
        "wedged",
        "unsupported_state_schema",
    );
    let unknown_restart = run(&data, &["restart"]);
    assert_eq!(unknown_restart.code, 1);
    assert_result(
        &unknown_restart.json(),
        "restart",
        false,
        "wedged",
        "unsupported_state_schema",
    );
    assert_eq!(effects(&unknown_restart.json()), (false, false));
    let unknown_stop = run(&data, &["stop"]);
    assert_eq!(unknown_stop.code, 1);
    assert_result(
        &unknown_stop.json(),
        "stop",
        false,
        "wedged",
        "unsupported_state_schema",
    );
    assert_eq!(
        std::fs::read(&selection).expect("unknown selection preserved"),
        unknown
    );

    std::fs::write(&selection, b"{\"schema\":1}").expect("stale selection fixture");
    std::fs::set_permissions(&selection, std::fs::Permissions::from_mode(0o600))
        .expect("stale selection mode");
    let stopped_again = run(&data, &["stop"]);
    assert_eq!(stopped_again.code, 0);
    assert_result(
        &stopped_again.json(),
        "stop",
        true,
        "stopped",
        "already_stopped",
    );
    assert!(
        !selection.exists(),
        "already-stopped cleanup must remove stale active selection"
    );

    // A schema-1 selection that cites a digest outside the qualified closure is stale state owned by this binary; `stop` clears it instead of treating it as tampering.
    std::fs::write(
        &selection,
        format!("{{\"schema\":1,\"opencode\":\"{}\"}}", "f".repeat(64)).as_bytes(),
    )
    .expect("unqualified selection fixture");
    std::fs::set_permissions(&selection, std::fs::Permissions::from_mode(0o600))
        .expect("unqualified selection mode");
    let stale_digest_stop = run(&data, &["stop"]);
    assert_eq!(stale_digest_stop.code, 0);
    assert_result(
        &stale_digest_stop.json(),
        "stop",
        true,
        "stopped",
        "already_stopped",
    );
    assert!(
        !selection.exists(),
        "stop must clear a stale selection citing an unqualified closure"
    );

    // After the stop transaction commits, selector-cleanup failures do not fail `stop`.
    // Selector-cleanup residue is stale bookkeeping.
    // A later `start` rewrites stale selector state; failing `stop` would force recovery for a host that is already stopped.
    // An unsupported selector schema causes `stop` to fail.
    std::fs::write(&selection, b"{\"schema\":1}").expect("cleanup-fault fixture");
    std::fs::set_permissions(&selection, std::fs::Permissions::from_mode(0o600))
        .expect("cleanup-fault mode");
    let already_stopped_cleanup_fault = run_with_envelope_and_env(
        &data,
        &["stop"],
        None,
        &[("CK_MC_HOST_TEST_FAIL_SELECTION_REMOVAL", "1")],
    );
    assert_eq!(already_stopped_cleanup_fault.code, 0);
    assert_result(
        &already_stopped_cleanup_fault.json(),
        "stop",
        true,
        "stopped",
        "already_stopped",
    );
    assert!(
        selection.exists(),
        "the injected fault must leave the selector unremoved"
    );
    std::fs::remove_file(&selection).expect("cleanup-fault fixture removal");

    // After the stop transaction commits, selector-cleanup failures do not fail `stop`.
    // `stop` signals, acknowledges, and observes the incarnation stopped before selector cleanup runs.
    let cleanup_fault_start = run_with_envelope(&data, &["start"], Some(&merged_envelope));
    assert_eq!(
        cleanup_fault_start.code, 0,
        "start before the committed-stop cleanup fault failed: {} {}",
        cleanup_fault_start.stdout, cleanup_fault_start.stderr
    );
    janitor.active = true;
    assert!(
        selection.exists(),
        "a credentialed start publishes the selector the cleanup fault targets"
    );
    let committed_stop_cleanup_fault = run_with_envelope_and_env(
        &data,
        &["stop"],
        None,
        &[("CK_MC_HOST_TEST_FAIL_SELECTION_REMOVAL", "1")],
    );
    janitor.active = false;
    assert_eq!(committed_stop_cleanup_fault.code, 0);
    assert_result(
        &committed_stop_cleanup_fault.json(),
        "stop",
        true,
        "stopped",
        "stopped",
    );
    assert_eq!(
        run(&data, &["probe"]).json()["state"],
        "stopped",
        "a cleanup fault must not hide a committed stop from the next probe"
    );
    assert!(
        selection.exists(),
        "the injected fault must leave the selector unremoved"
    );
    std::fs::remove_file(&selection).expect("committed-stop cleanup fixture removal");
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigint_runs_ordered_daemon_teardown() {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");
    let payload = root.path().join("payload-source");
    let launcher = payload.join("payload/bin/ck-mc-host");
    std::fs::create_dir_all(launcher.parent().expect("launcher parent"))
        .expect("payload launcher dir");
    std::fs::copy(BIN, &launcher).expect("copy real launcher into payload");
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700))
        .expect("launcher mode");
    let mut janitor = DaemonJanitor {
        root: data.clone(),
        active: false,
    };
    let start = run(
        &data,
        &["start", "--payload-dir", payload.to_str().expect("payload")],
    );
    janitor.active = true;
    assert_eq!(
        start.code, 0,
        "start failed: {} {}",
        start.stdout, start.stderr
    );

    let publication = mc_host::runtime_dir_path(Some(&data))
        .expect("runtime dir")
        .join(mc_host::CONNECTION_FILE_NAME);
    let published: Value =
        serde_json::from_slice(&std::fs::read(&publication).expect("publication"))
            .expect("publication json");
    let pid = published["pid"].as_u64().expect("pid").to_string();
    let signal = Command::new("kill")
        .args(["-INT", &pid])
        .status()
        .expect("send SIGINT");
    assert!(signal.success());

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let probe = run(&data, &["probe"]).json();
        if probe["state"] == "stopped" {
            break;
        }
        assert!(Instant::now() < deadline, "SIGINT teardown did not finish");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    janitor.active = false;
    assert!(!publication.exists());
    let probe =
        mc_host::probe_lifecycle(Some(&data), &mc_host::ProbeFreshness::default()).expect("probe");
    assert!(probe.instance_lock_free);
    assert!(probe.lifetime_lock_free);
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_generation_restarts_after_source_payload_deletion() {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");
    let payload = root.path().join("payload-source");
    let launcher = payload.join("payload/bin/ck-mc-host");
    std::fs::create_dir_all(launcher.parent().expect("launcher parent"))
        .expect("payload launcher dir");
    std::fs::copy(BIN, &launcher).expect("copy real launcher into payload");
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700))
        .expect("launcher mode");
    let payload_arg = payload.to_str().expect("payload path");
    let mut janitor = DaemonJanitor {
        root: data.clone(),
        active: false,
    };

    let start = run(&data, &["start", "--payload-dir", payload_arg]);
    janitor.active = true;
    assert_eq!(
        start.code, 0,
        "staged launcher start failed: {} {}",
        start.stdout, start.stderr
    );
    assert_result(&start.json(), "start", true, "running", "started");

    let stop = run(&data, &["stop"]);
    assert_eq!(stop.code, 0, "stop failed: {} {}", stop.stdout, stop.stderr);
    janitor.active = false;
    std::fs::remove_dir_all(&payload).expect("remove package source bytes");

    let restart = run(&data, &["restart"]);
    janitor.active = true;
    assert_eq!(
        restart.code, 0,
        "retained restart failed: {} {}",
        restart.stdout, restart.stderr
    );
    assert_result(&restart.json(), "restart", true, "running", "started");
    assert_eq!(effects(&restart.json()), (false, true));

    let stop = run(&data, &["stop"]);
    assert_eq!(stop.code, 0, "final stop failed");
    janitor.active = false;
}
