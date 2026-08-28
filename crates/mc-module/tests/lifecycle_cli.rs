//! Subprocess tests for the production `ck-mc-host` executable (plan U2).
//!
//! Every test gets an isolated data root through `XDG_DATA_HOME` and drives
//! the real binary end to end: strict argument parsing, side-effect-free
//! metadata commands, read-only probes, and the dev-mode staged
//! start/stop/restart transactions with their exact KTD12 result shapes.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_ck-mc-host");
/// Debug-build daemons on loaded CI hosts can exceed the 3s production
/// spawn/publication/auth phase cap; the knob only widens phase caps and the
/// 60s aggregate still binds.
const PHASE_CAP_MS: &str = "30000";

struct CliOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

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
    let output = Command::new(BIN)
        .args(args)
        .env_clear()
        .env("XDG_DATA_HOME", root)
        .env("CK_MC_HOST_TEST_PHASE_CAP_MS", PHASE_CAP_MS)
        .output()
        .expect("ck-mc-host spawns");
    CliOutput {
        code: output.status.code().expect("ck-mc-host exits with a code"),
        stdout: String::from_utf8(output.stdout).expect("stdout is UTF-8"),
        stderr: String::from_utf8(output.stderr).expect("stderr is UTF-8"),
    }
}

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

/// Writes a tiny dev payload: one executable, one data file, one nested file.
fn write_payload(dir: &Path) {
    std::fs::create_dir_all(dir.join("bin")).expect("payload bin dir");
    std::fs::write(dir.join("bin/tool"), b"#dev-binary-bytes").expect("payload tool");
    std::fs::set_permissions(dir.join("bin/tool"), std::fs::Permissions::from_mode(0o700))
        .expect("payload tool mode");
    std::fs::write(dir.join("notices.txt"), b"dev notices").expect("payload notices");
}

fn coordination_dir(root: &Path) -> PathBuf {
    root.join(".mc-host-coordination")
}

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

/// Best-effort stop on drop so a failed assertion cannot leak a daemon.
struct DaemonJanitor {
    root: PathBuf,
    active: bool,
}

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
    // Never unlink or signal: the quarantined lock file must survive.
    assert!(lock_path.exists());
}

/// A quarantined record with both fences free is classified identically by
/// every command.
///
/// `probe_lifecycle` reports this shape as `stopped` (no fence is held), so a
/// command that only checked the `wedged` shape would treat it as cleanly
/// startable: `start`/`restart` would spawn a child that `InstanceGuard`
/// refuses, then report `startup_timeout`, and `stop` would report a clean
/// `already_stopped`. All four must surface `unsupported_state_schema`, and
/// none may touch the preserved bytes.
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
        // The quarantined bytes survive every command byte for byte.
        assert_eq!(
            std::fs::read(&record).expect("record still present"),
            original,
            "{command} must not rewrite the quarantined record"
        );
    }
}

/// `restart` proves the successor is resolvable before committing its stop.
///
/// The stop is irreversible, so a successor condition that was already true
/// on disk must never be discovered after the daemon is down: that yields
/// `stop_committed:true`, `start_committed:false`, and an outage with no
/// takeover. The running daemon must still be serving afterwards.
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

    // Restart toward a payload that cannot resolve. The failure is detected
    // before the stop, so neither effect bit is set.
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

    // start: stages the dev payload, spawns the detached daemon, and
    // completes at authenticated transport.
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

    // The publication authenticates with the real client.
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
            break;
        }
        assert!(
            tokio::time::Instant::now() < readiness_deadline,
            "storage did not become ready; last status: {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    client.close().await.expect("client closes");

    // status: running and healthy. The contracted verb; `probe` above covers
    // the historical spelling of the same command.
    let out = run(&data, &["status"]);
    assert_eq!(out.code, 0);
    assert_result(&out.json(), "status", true, "running", "healthy");

    // Second start: compatible incarnation already running, no respawn.
    let out = run(&data, &["start", "--payload-dir", payload_arg]);
    assert_eq!(out.code, 0);
    let value = out.json();
    assert_result(&value, "start", true, "running", "already_running");

    // restart of a running daemon: one transaction, both effects true.
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

    // Both fences are acquirable and the publication is gone.
    assert!(!publication.exists(), "publication removed at teardown");
    let coordination = coordination_dir(&data);
    assert!(try_flock_exclusive(&coordination.join("transaction.lock")));
    assert!(try_flock_exclusive(&coordination.join("lifetime.lock")));
    let probe =
        mc_host::probe_lifecycle(Some(&data), &mc_host::ProbeFreshness::default()).expect("probe");
    assert_eq!(probe.state, mc_host::LifecycleState::Stopped);
    assert!(probe.instance_lock_free);
    assert!(probe.lifetime_lock_free);

    // stop again: no lock-held incarnation, nothing unlinked or signaled.
    let out = run(&data, &["stop"]);
    assert_eq!(out.code, 0);
    assert_result(&out.json(), "stop", true, "stopped", "already_stopped");

    // restart from stopped: no --payload-dir needed, the promoted current
    // generation revalidates; stop bit stays false.
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

    // Poll briefly for daemon-side teardown stragglers, then verify the
    // daemon log stayed owner-only.
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
