#![cfg(target_os = "linux")]

mod support;

use std::time::Duration;
use std::time::Instant;

use mc_host::shm_provider::{qualified_test_profile, TestShmPeer, SHM_TRANSPORT};
use mc_host::wire::{EnvelopeHeader, Flags, FrameType, Priority, PROTOCOL_VERSION};
use support::raw_client::{FLAGS_INTERACTIVE, TY_REQUEST, TY_RESPONSE};
use support::shm_process::{
    commit_shm_peer, daemon_info, daemon_role, goodbye_header, live_descendants, negotiate_grant,
    request_header, serial_crash_lock, shm_roundtrip, spawn_victim, start_daemon,
    start_daemon_with, victim_role, DaemonSoakStats, Observer, RoleProcess, CRASH_ROOT,
    OBSERVATION_TIMEOUT,
};
use support::LINKED_MODULE_ID;

const BUDGET: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
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

/// A dispatch count above `expected` indicates replay.
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

fn one_candidate_charges() -> [u64; 4] {
    let charges = qualified_test_profile().charges();
    [
        charges.descriptors,
        charges.arena_bytes,
        charges.leases,
        charges.mappings,
    ]
}

fn wait_soak_stats(
    daemon: &mut RoleProcess,
    what: &str,
    predicate: impl Fn(&DaemonSoakStats) -> bool,
) -> DaemonSoakStats {
    let deadline = Instant::now() + BUDGET;
    loop {
        let stats = daemon.query_soak_stats();
        if predicate(&stats) {
            return stats;
        }
        assert!(
            Instant::now() < deadline,
            "daemon accounting did not reach {what} within the bounded wait"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

/// The observer succeeds before the kill, during recovery, and after restart.
/// A victim killed before request publication dispatches nothing.
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

    assert_eq!(daemon.query_dispatches(), before_kill);
    observer.roundtrip(1024, 42, window.remaining()).await;

    // A restart with the same external identity performs fresh authentication and negotiation.
    // The restart creates a fresh candidate and receives a successful terminal.
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

/// A victim killed while holding an active committed candidate never becomes a suspect.
/// The victim's admission charges remain active until the daemon closes.
///
/// Dead ring peers retain active admission charges until daemon shutdown.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn killed_victim_holding_active_charges_is_never_reclaimed() {
    let _serial = serial_crash_lock().await;
    let data_root = tempfile::tempdir().expect("data root");
    let mut daemon = start_daemon(data_root.path());
    let info = daemon_info(data_root.path());
    let mut observer = Observer::connect(&info, "observer-dead-peer").await;
    observer.roundtrip(512, 7, BUDGET).await;

    // The victim has not sent `Goodbye` when the kill occurs.
    let mut victim = spawn_victim(data_root.path(), "idle", "victim-dead-peer", None);
    victim.expect_record("barrier idle_committed");
    let held = one_candidate_charges();
    let stats = wait_soak_stats(&mut daemon, "one active candidate", |stats| {
        stats.active == held
    });
    assert_eq!(stats.quarantined, [0; 4]);
    assert_eq!(stats.preparations, 1);
    assert_eq!(stats.readiness, "Ready");

    victim.kill();
    let window = victim.reap_killed();

    for _ in 0..10 {
        let stats = daemon.query_soak_stats();
        assert_eq!(stats.active, held, "dead-peer charges must stay active");
        assert_eq!(stats.quarantined, [0; 4]);
        assert_eq!(stats.preparations, 1);
        assert_eq!(stats.readiness, "Ready");
        std::thread::sleep(Duration::from_millis(50));
    }
    observer.roundtrip(1024, 42, window.remaining()).await;
    let stats = daemon.query_soak_stats();
    assert_eq!(stats.active, held);
    assert_eq!(stats.quarantined, [0; 4]);

    victim.teardown();
    daemon.teardown();
}

/// The recovery controller isolates the suspect candidate record.
/// The provider transitions from `Recovering` to `Ready` with the candidate's exact charges quarantined.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn corrupt_peer_frame_quarantines_exact_charges_and_returns_ready() {
    let _serial = serial_crash_lock().await;
    let data_root = tempfile::tempdir().expect("data root");
    let mut daemon = start_daemon(data_root.path());
    let info = daemon_info(data_root.path());
    let mut observer = Observer::connect(&info, "observer-corrupt").await;
    observer.roundtrip(512, 7, BUDGET).await;

    let peer = commit_shm_peer(&info).await;
    let held = one_candidate_charges();
    wait_soak_stats(&mut daemon, "one active candidate", |stats| {
        stats.active == held
    });

    // The endpoint classifies a peer-side `Response` as `Corrupt` and takes the unclean-close branch.
    let corrupt = EnvelopeHeader {
        len: 0,
        ver: PROTOCOL_VERSION,
        ty: FrameType::Response,
        flags: Flags::new(false, Priority::Interactive, false),
        channel: 0,
        epoch: 0,
        corr: 99,
    };
    tokio::task::block_in_place(|| {
        peer.send(corrupt, &[]).expect("publish role-invalid frame");
    });

    let stats = wait_soak_stats(&mut daemon, "quarantined suspect charges", |stats| {
        stats.quarantined == held && stats.active == [0; 4]
    });
    assert_eq!(stats.preparations, 1);
    // The recovery controller returns to `Ready` rather than `Quarantined`.
    wait_soak_stats(&mut daemon, "readiness Ready", |stats| {
        stats.readiness == "Ready" && stats.quarantined == held && stats.active == [0; 4]
    });
    observer.roundtrip(256, 5, BUDGET).await;
    let peer = commit_shm_peer(&info).await;
    tokio::task::block_in_place(|| {
        shm_roundtrip(&peer, "victim-corrupt-fresh");
        peer.send(goodbye_header(), &[]).expect("publish goodbye");
    });

    daemon.teardown();
}

/// A request committed before the kill dispatches exactly once and is never replayed.
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

    // The daemon dispatches each committed request at most once.
    wait_for_dispatches(&mut daemon, 2, window.remaining());
    observer.roundtrip(1024, 42, window.remaining()).await;

    let mut fresh = spawn_victim(data_root.path(), "roundtrip", "victim-publish", None);
    fresh.expect_record("barrier idle_committed");
    fresh.expect_record("terminal ok");
    fresh.wait_exit_success(BUDGET);
    observer.roundtrip(256, 5, BUDGET).await;
    // Five total dispatches exclude replay of the killed victim's request.
    assert_eq!(daemon.query_dispatches(), 5);

    victim.teardown();
    fresh.teardown();
    daemon.teardown();
}

/// The daemon publishes the response before the victim consumes it; reclaiming the victim endpoint must not corrupt the observer response.
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
    // The daemon publishes the response while the victim remains parked without consuming it.
    // consumption.
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

/// Observation timing begins after reap, not at kill.
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
    // The roundtrip lets time elapse while the zombie remains unreaped.
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

/// A fresh candidate with the same external identity rejects stale activation from its killed predecessor through its incarnation fence.
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

    // A fresh negotiation mints a new token, candidate identity, and ring grant.
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

    // Presenting a stale token retires the fresh candidate and bootstrap without returning an activation response.
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

/// After daemon restart, old pending work is classified without replay; TCP service reports `unavailable`, and a fresh shared-memory negotiation succeeds.
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

    // After restart on the same publication root, zero dispatches prove that the old pending request never replayed.
    let mut daemon2 = start_daemon_with(data_root.path(), 1);
    let info_after = daemon_info(data_root.path());
    assert!(
        info_after.daemon_id != info_before.daemon_id,
        "a restarted daemon must publish a fresh identity"
    );
    assert_eq!(daemon2.query_dispatches(), 0);
    let mut observer = Observer::connect(&info_after, "observer-restart-fresh").await;
    observer.roundtrip(512, 11, BUDGET).await;

    // Under transient admission pressure, the provider reports `unavailable` while TCP service remains healthy.
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

    let peer = commit_shm_peer(&info_after).await;
    tokio::task::block_in_place(|| {
        shm_roundtrip(&peer, "victim-restart-fresh");
        peer.send(goodbye_header(), &[]).expect("publish goodbye");
    });
    // The dispatch count includes only the new observer, TCP probe, and shared-memory requests.
    assert_eq!(daemon2.query_dispatches(), 3);

    daemon2.teardown();
}
