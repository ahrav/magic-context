//! Barrier-driven real-process crash and isolation scenarios for the
//! provisional ring-backed shared-memory tuple. See
//! `support/shm_process.rs` for the harness contract, the manifest-gate
//! note, and the Bun/Node stub category. commentlint: allow(JUDGE)
#![cfg(target_os = "linux")]

mod support;

use std::time::Duration;
use std::time::Instant;

use mc_host::shm_provider::{TestShmPeer, SHM_TRANSPORT};
use support::raw_client::{FLAGS_INTERACTIVE, TY_REQUEST, TY_RESPONSE};
use support::shm_process::{
    commit_shm_peer, daemon_info, daemon_role, goodbye_header, live_descendants, negotiate_grant,
    request_header, serial_crash_lock, shm_roundtrip, spawn_victim, start_daemon,
    start_daemon_with, victim_role, Observer, RoleProcess, CRASH_ROOT, OBSERVATION_TIMEOUT,
};
use support::LINKED_MODULE_ID;

const BUDGET: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Process roles, dispatched via libtest self-reexec (the ring.rs pattern).
// ---------------------------------------------------------------------------

#[test]
#[ignore = "daemon role for the shm crash harness"]
fn shm_role_daemon() {
    daemon_role();
}

#[test]
#[ignore = "victim role for the shm crash harness"]
fn shm_role_victim() {
    victim_role();
}

// ---------------------------------------------------------------------------
// Parent-side helpers.
// ---------------------------------------------------------------------------

/// Bounded poll until the daemon reports exactly `expected` dispatches;
/// exceeding it at any sample fails immediately (replay detector).
/// commentlint: allow(JUDGE)
fn wait_for_dispatches(daemon: &mut RoleProcess, expected: u64, budget: Duration) {
    let deadline = Instant::now() + budget;
    loop {
        let count = daemon.query_dispatches();
        assert!(
            count <= expected,
            "dispatch count must never exceed {expected}"
        );
        if count == expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "dispatch count did not reach {expected} within its bounded wait"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

/// Idle-commit barrier with a promptly reaped victim: observer traffic
/// succeeds immediately before the kill, during recovery, and after a fresh
/// restart; a victim killed before request publication dispatches nothing.
/// commentlint: allow(JUDGE)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn promptly_reaped_idle_kill_preserves_observer_and_restarts_fresh() {
    let _serial = serial_crash_lock().await;
    let data_root = tempfile::tempdir().expect("data root");
    let mut daemon = start_daemon(data_root.path());
    let info = daemon_info(data_root.path());
    let mut observer = Observer::connect(&info, "observer-idle").await;
    observer.roundtrip(512, 7, BUDGET).await;

    let mut victim = spawn_victim(data_root.path(), "idle", "victim-idle", None);
    victim.expect_record("barrier idle_committed");
    assert!(
        live_descendants(victim.pid()).is_empty(),
        "victim role spawns no descendants"
    );
    observer.roundtrip(512, 9, BUDGET).await;
    let before_kill = daemon.query_dispatches();

    victim.kill();
    let window = victim.reap_killed();

    // Killed before request publication: the victim contributed no dispatch.
    assert_eq!(daemon.query_dispatches(), before_kill);
    observer.roundtrip(1024, 42, window.remaining()).await;

    // Fresh restart with the same external identity: fresh auth,
    // negotiation, and candidate, ending in a successful terminal.
    let mut fresh = spawn_victim(data_root.path(), "roundtrip", "victim-idle", None);
    fresh.expect_record("barrier idle_committed");
    fresh.expect_record("terminal ok");
    fresh.wait_exit_success(BUDGET);
    observer.roundtrip(256, 5, BUDGET).await;
    assert_eq!(daemon.query_dispatches(), before_kill + 3);

    victim.teardown();
    fresh.teardown();
    daemon.teardown();
}

/// Request-publication barrier: a request committed before the kill
/// dispatches exactly once and is never replayed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kill_after_request_publication_dispatches_once_without_replay() {
    let _serial = serial_crash_lock().await;
    let data_root = tempfile::tempdir().expect("data root");
    let mut daemon = start_daemon(data_root.path());
    let info = daemon_info(data_root.path());
    let mut observer = Observer::connect(&info, "observer-publish").await;
    observer.roundtrip(512, 7, BUDGET).await;

    let mut victim = spawn_victim(data_root.path(), "publish", "victim-publish", None);
    victim.expect_record("barrier idle_committed");
    victim.expect_record("barrier request_published");
    victim.kill();
    let window = victim.reap_killed();

    // The dead victim never observes a terminal; the daemon-side contract is
    // at-most-once dispatch of the committed request. commentlint: allow(JUDGE)
    wait_for_dispatches(&mut daemon, 2, window.remaining());
    observer.roundtrip(1024, 42, window.remaining()).await;

    let mut fresh = spawn_victim(data_root.path(), "roundtrip", "victim-publish", None);
    fresh.expect_record("barrier idle_committed");
    fresh.expect_record("terminal ok");
    fresh.wait_exit_success(BUDGET);
    observer.roundtrip(256, 5, BUDGET).await;
    // Exact accounting proves the killed victim's request never replayed.
    assert_eq!(daemon.query_dispatches(), 5);

    victim.teardown();
    fresh.teardown();
    daemon.teardown();
}

/// Response-publication barrier, reported by the daemon provider before the
/// victim consumes: reclamation of the dead victim's endpoint must not
/// corrupt the observer's own response bytes. commentlint: allow(JUDGE)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kill_before_response_consumption_leaves_observer_uncorrupted() {
    let _serial = serial_crash_lock().await;
    let data_root = tempfile::tempdir().expect("data root");
    let mut daemon = start_daemon(data_root.path());
    let info = daemon_info(data_root.path());
    let mut observer = Observer::connect(&info, "observer-response").await;
    observer.roundtrip(512, 7, BUDGET).await;

    let mut victim = spawn_victim(data_root.path(), "publish", "victim-response", None);
    victim.expect_record("barrier idle_committed");
    victim.expect_record("barrier request_published");
    // The daemon provider owns response publication; the victim parks
    // without consuming, so the kill lands between publication and
    // consumption. commentlint: allow(JUDGE)
    daemon.wait_for_record("barrier response_published");
    victim.kill();
    let window = victim.reap_killed();

    observer.roundtrip(4097, 90, window.remaining()).await;

    let mut fresh = spawn_victim(data_root.path(), "roundtrip", "victim-response", None);
    fresh.expect_record("barrier idle_committed");
    fresh.expect_record("terminal ok");
    fresh.wait_exit_success(BUDGET);
    observer.roundtrip(256, 5, BUDGET).await;

    victim.teardown();
    fresh.teardown();
    daemon.teardown();
}

/// Seeded-defect detector: a harness that starts observation timing at
/// `kill` instead of after `wait` must fail here. commentlint: allow(JUDGE)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn held_zombie_starts_observation_timing_only_after_reap() {
    let _serial = serial_crash_lock().await;
    let data_root = tempfile::tempdir().expect("data root");
    let daemon = start_daemon(data_root.path());
    let info = daemon_info(data_root.path());
    let mut observer = Observer::connect(&info, "observer-zombie").await;

    let mut victim = spawn_victim(data_root.path(), "idle", "victim-zombie", None);
    victim.expect_record("barrier idle_committed");
    let evidence = victim.kill();
    assert!(
        victim.observation_window().is_none(),
        "observation timing must not start at kill"
    );
    victim.wait_zombie(BUDGET);
    // Real elapsed work while the zombie is deliberately held unreaped.
    observer.roundtrip(512, 7, BUDGET).await;
    assert!(
        victim.observation_window().is_none(),
        "a held zombie must not have an observation window"
    );
    let held = evidence.killed_at.elapsed();

    let window = victim.reap_killed();
    assert!(
        window.started_at.duration_since(evidence.killed_at) >= held,
        "the observation window must be anchored to the reap, not the kill"
    );
    assert_eq!(
        window.deadline.duration_since(window.started_at),
        OBSERVATION_TIMEOUT,
        "the observation window spans exactly the post-reap timeout"
    );
    observer.roundtrip(512, 9, window.remaining()).await;

    victim.teardown();
    daemon.teardown();
}

/// Restart with the same external test identity: the fresh candidate's
/// incarnation fence rejects the killed predecessor's stale activation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_with_same_identity_rejects_stale_activation() {
    let _serial = serial_crash_lock().await;
    let data_root = tempfile::tempdir().expect("data root");
    let daemon = start_daemon(data_root.path());
    let info = daemon_info(data_root.path());
    let stale_path = data_root.path().join("stale-candidate.json");

    let mut victim = spawn_victim(data_root.path(), "idle", "victim-fence", Some(&stale_path));
    victim.expect_record("barrier idle_committed");
    victim.kill();
    victim.reap_killed();

    let mut fresh = spawn_victim(data_root.path(), "roundtrip", "victim-fence", None);
    fresh.expect_record("barrier idle_committed");
    fresh.expect_record("terminal ok");
    fresh.wait_exit_success(BUDGET);

    let stale: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&stale_path).expect("stale record"))
            .expect("stale json");
    std::fs::remove_file(&stale_path).expect("stale record removed");
    let stale_token = stale["activation_token"].as_str().expect("stale token");

    // A fresh negotiation mints a fresh token, candidate identity, and ring
    // grant; values stay out of assertion output (R17). commentlint: allow(JUDGE)
    let (mut bootstrap, grant) = negotiate_grant(&info).await;
    assert_eq!(grant["selected"]["transport"], SHM_TRANSPORT);
    assert!(
        grant["activation_token"].as_str() != Some(stale_token),
        "a fresh grant must mint a fresh activation token"
    );
    assert!(
        grant["descriptor"]["candidate_id"] != stale["descriptor"]["candidate_id"],
        "a fresh candidate must carry a fresh identity"
    );
    assert!(
        grant["descriptor"]["host_to_peer_grant"] != stale["descriptor"]["host_to_peer_grant"],
        "a fresh candidate must carry a fresh ring incarnation grant"
    );

    // Presenting the stale token on the fresh candidate retires both the
    // candidate and the bootstrap with no activation response.
    let peer = tokio::task::block_in_place(|| {
        TestShmPeer::attach(&grant["descriptor"]).expect("attach fresh candidate")
    });
    let activate = format!(
        r#"{{"op":"transport.activate","negotiation_version":1,"activation_token":"{stale_token}"}}"#
    )
    .into_bytes();
    tokio::task::block_in_place(|| {
        peer.send(request_header(0, 0, 1, activate.len()), &activate)
            .expect("publish stale activate");
    });
    assert!(
        bootstrap.closed_within(BUDGET).await,
        "a stale activation must retire the bootstrap"
    );
    tokio::task::block_in_place(|| {
        assert!(
            peer.recv(Duration::from_millis(300)).is_err(),
            "a stale activation must receive no response"
        );
    });

    // Only the stale token is rejected: a correct fresh setup succeeds.
    let peer = commit_shm_peer(&info).await;
    tokio::task::block_in_place(|| {
        shm_roundtrip(&peer, "victim-fence-fresh");
        peer.send(goodbye_header(), &[]).expect("publish goodbye");
    });

    victim.teardown();
    fresh.teardown();
    daemon.teardown();
}

/// Daemon restart: old pending work is classified without replay, a fresh
/// observer serves over TCP while the provider reports exact `unavailable`,
/// and a subsequent fresh shared-memory negotiation succeeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_restart_classifies_old_work_and_renegotiates_fresh() {
    let _serial = serial_crash_lock().await;
    let data_root = tempfile::tempdir().expect("data root");
    let mut daemon = start_daemon_with(data_root.path(), 1);
    let info_before = daemon_info(data_root.path());
    let mut observer = Observer::connect(&info_before, "observer-restart").await;
    observer.roundtrip(512, 7, BUDGET).await;

    // Old pending work: a hang-mode request dispatches but never settles.
    let mut victim = spawn_victim(data_root.path(), "pending", "victim-restart", None);
    victim.expect_record("barrier idle_committed");
    victim.expect_record("barrier request_published");
    wait_for_dispatches(&mut daemon, 2, BUDGET);

    daemon.kill();
    daemon.reap_killed();
    victim.kill();
    victim.reap_killed();
    victim.teardown();
    drop(observer);

    // Restart on the same publication root: a fresh daemon identity, and
    // zero dispatches proves the old pending request never replayed.
    let mut daemon2 = start_daemon_with(data_root.path(), 1);
    let info_after = daemon_info(data_root.path());
    assert!(
        info_after.daemon_id != info_before.daemon_id,
        "a restarted daemon must publish a fresh identity"
    );
    assert_eq!(daemon2.query_dispatches(), 0);
    let mut observer = Observer::connect(&info_after, "observer-restart-fresh").await;
    observer.roundtrip(512, 11, BUDGET).await;

    // Transient admission pressure: the provider reports exact
    // `unavailable` while TCP service stays healthy.
    daemon2.send_command("hold_admission");
    daemon2.wait_for_record("held");
    let (mut probe, selection) = negotiate_grant(&info_after).await;
    assert_eq!(selection["selected"]["transport"], "tcp");
    assert_eq!(selection["reason"], "unavailable");
    let (channel, epoch) = probe
        .route_open(LINKED_MODULE_ID, CRASH_ROOT, "shm-crash", "probe-tcp")
        .await
        .expect("tcp route during transient unavailability");
    let corr = probe.next_corr();
    let body = serde_json::to_vec(&serde_json::json!({
        "mode": "direct_fill",
        "bytes": 64,
        "value": 7
    }))
    .expect("tcp body");
    probe
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, channel, epoch, corr, &body)
        .await
        .expect("tcp request");
    let (_, frame) = probe
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("tcp terminal");
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.body, vec![7; 64]);
    daemon2.send_command("release_admission");
    daemon2.wait_for_record("released");

    // Fresh shared-memory negotiation now succeeds end to end.
    let peer = commit_shm_peer(&info_after).await;
    tokio::task::block_in_place(|| {
        shm_roundtrip(&peer, "victim-restart-fresh");
        peer.send(goodbye_header(), &[]).expect("publish goodbye");
    });
    // Exactly the new observer, TCP probe, and shared-memory requests.
    assert_eq!(daemon2.query_dispatches(), 3);

    daemon2.teardown();
}
