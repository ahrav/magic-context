//! Deterministic Broca supervisor conformance: deduplication, exact
//! statuses, replay, every fixed cap, waiter detach, lifecycle
//! linearization, retention, and charge/permit baselines — driven with
//! paused tokio time and backend gates, never wall-clock sleeps.

mod support;

use std::sync::Arc;
use std::time::Duration;

use mc_host::broca::backend::{BackendError, ErrorClass, Harness};
use mc_host::broca::config::{BrocaLimits, TERMINAL_RETENTION};
use mc_host::broca::protocol::SendRequest;
use mc_host::broca::supervisor::{SessionKey, Subscription, Supervisor, SupervisorMetrics};
use mc_host::broca::BrocaComponent;
use mc_host::CompositeComponent;

use support::broca::{open_broca_route, send_call, send_params, start_broca_host, ScriptedBackend};

fn key(session: &str) -> SessionKey {
    SessionKey {
        project_root: "/workspace/project".into(),
        harness: Harness::OpenCode,
        session: session.to_owned(),
    }
}

/// A validated request plus the exact body bytes its fingerprint is taken
/// from; a different prompt yields different bytes and therefore a conflict.
fn send_pair(prompt: &str) -> (SendRequest, Vec<u8>) {
    let request = SendRequest {
        prompt: prompt.to_owned(),
        system: None,
        provider: "prov".to_owned(),
        model: "model-a".to_owned(),
        max_output_tokens: 1_000,
        temperature: 0.1,
    };
    let body = serde_json::to_vec(&serde_json::json!({
        "method": "session.send",
        "params": send_params(prompt, None, "prov/model-a"),
    }))
    .expect("body serializes");
    (request, body)
}

fn send(supervisor: &Supervisor, session: &str, prompt: &str) -> String {
    let (request, body) = send_pair(prompt);
    supervisor
        .send(&key(session), request, &body)
        .expect("send admits")
}

/// Waits for `cond` across cooperative yields; bounded by iteration count so
/// paused-clock tests cannot spin forever on a broken condition.
async fn until(mut cond: impl FnMut() -> bool, what: &str) {
    for _ in 0..100_000 {
        if cond() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("condition not reached: {what}");
}

async fn drain_bytes(mut subscription: Subscription) -> Vec<Vec<u8>> {
    let mut units = Vec::new();
    while let Some(unit) = subscription.next().await {
        units.push(unit.to_vec());
    }
    units
}

fn unit_json(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).expect("unit is JSON")
}

/// Every permit free and every retained byte returned: the state a fresh
/// supervisor starts in and every drained one must return to.
fn assert_baseline(metrics: SupervisorMetrics, limits: &BrocaLimits, sessions: usize) {
    assert_eq!(metrics.free_command_permits, limits.max_command_callbacks);
    assert_eq!(metrics.free_run_slots, limits.max_active_runs);
    assert_eq!(
        metrics.free_subscriber_permits,
        limits.max_total_subscribers
    );
    assert_eq!(metrics.free_backend_permits, limits.max_backend_processes);
    assert_eq!(metrics.sessions, sessions);
    if sessions == 0 {
        assert_eq!(
            metrics.retained_bytes_available, metrics.retained_bytes_capacity,
            "all retained charges must be released"
        );
        assert_eq!(metrics.live_runs, 0);
        assert_eq!(metrics.tombstones, 0);
    }
}

#[test]
fn default_limits_and_resource_declaration_match_the_fixed_caps() {
    let limits = BrocaLimits::default();
    assert_eq!(limits.max_active_runs, 32);
    assert_eq!(limits.max_command_callbacks, 32);
    assert_eq!(limits.max_subscribers_per_run, 2);
    assert_eq!(limits.max_total_subscribers, 64);
    assert_eq!(limits.max_backend_processes, 8);
    assert_eq!(limits.max_run_replay_bytes, 1024 * 1024);
    assert_eq!(limits.max_retained_bytes, 64 * 1024 * 1024);
    assert_eq!(limits.max_terminal_sessions, 256);
    assert_eq!(limits.terminal_retention, Duration::from_secs(15 * 60));
    assert_eq!(mc_host::broca::config::MAX_SEND_BODY_BYTES, 512 * 1024);

    let component = BrocaComponent::new(ScriptedBackend::completing("out"));
    let resources = component.resources();
    assert_eq!(resources.reserved_pending_requests, 96);
    assert_eq!(resources.reserved_handler_tasks, 96);
    // The supervisor's 64 MiB budget plus the retention classes outside
    // it: the route-identity map (1024 routes x (4096-byte root + 256-byte
    // session + 128-byte key overhead)), live backend capture
    // (8 backends x ((4 MiB stdout + 64 KiB stderr) x 5 parse-time copies
    // + one 512 KiB request body retained across the Pi provider
    // fallback's aliased attempt)), and the uncharged deletion-tombstone
    // worst case (256 sessions x the tripled key-meta bound), and the
    // environment snapshot plus its per-spawn transient copies (17 x 2 MiB,
    // the platform exec-argument ceiling).
    assert_eq!(
        resources.retained_resident_bytes,
        64 * 1024 * 1024
            + 1024 * (4096 + 256 + 128)
            + 8 * ((4 * 1024 * 1024 + 64 * 1024) * 5 + 512 * 1024)
            + 256 * ((4096 + 256) * 3 + 128)
            + (1 + 2 * 8) * 2 * 1024 * 1024
    );
    assert_eq!(resources.route_class, mc_host::RouteClass::Reserved);
}

#[tokio::test]
async fn identical_resend_dedups_and_any_byte_difference_conflicts() {
    let (backend, gate) = ScriptedBackend::gated("out");
    let supervisor = Supervisor::new(Arc::clone(&backend) as Arc<_>);
    let (request, body) = send_pair("same prompt");

    let first = supervisor
        .send(&key("s1"), request.clone(), &body)
        .expect("first send admits");
    let second = supervisor
        .send(&key("s1"), request.clone(), &body)
        .expect("identical resend returns the existing run");
    assert_eq!(first, second);

    // Same parsed request, byte-different body (one inserted space):
    // idempotency is defined over the exact body bytes (KTD11), so a
    // semantically identical re-serialization must conflict rather than
    // dedupe — this fails if the fingerprint were taken over the parsed
    // structure instead of the raw bytes.
    let mut spaced = body.clone();
    spaced.insert(1, b' ');
    let respaced = supervisor
        .send(&key("s1"), request, &spaced)
        .expect_err("a byte-different body for the key conflicts");
    assert_eq!(respaced.code, "idempotency_conflict");

    let (different, different_body) = send_pair("different prompt");
    let conflict = supervisor
        .send(&key("s1"), different, &different_body)
        .expect_err("a differing send for the key conflicts");
    assert_eq!(conflict.code, "idempotency_conflict");

    until(|| backend.starts() == 1, "backend starts once").await;
    gate.add_permits(1);
    until(
        || supervisor.status(&key("s1"), &first) == Ok("completed"),
        "run completes",
    )
    .await;
    assert_eq!(backend.starts(), 1, "the resend started no second backend");
}

/// A true admission race (AE2): two OS threads release from one barrier and
/// call the synchronous `Supervisor::send` with identical bytes at the same
/// time, so both really contend on the index lock instead of running
/// sequentially on one task.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn racing_identical_sends_converge_on_one_run_and_one_backend_start() {
    let (backend, gate) = ScriptedBackend::gated("out");
    let supervisor = Arc::new(Supervisor::new(Arc::clone(&backend) as Arc<_>));
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let mut racers = Vec::new();
    for _ in 0..2 {
        let supervisor = Arc::clone(&supervisor);
        let barrier = Arc::clone(&barrier);
        let (request, body) = send_pair("same prompt");
        racers.push(tokio::task::spawn_blocking(move || {
            barrier.wait();
            supervisor.send(&key("s1"), request, &body)
        }));
    }
    let mut run_ids = Vec::new();
    for racer in racers {
        run_ids.push(
            racer
                .await
                .expect("racer joins")
                .expect("both racing identical sends succeed"),
        );
    }
    assert_eq!(run_ids[0], run_ids[1], "both racers observe one shared run");
    assert_eq!(supervisor.metrics().sessions, 1);
    assert_eq!(supervisor.metrics().live_runs, 1);

    gate.add_permits(1);
    until(
        || supervisor.status(&key("s1"), &run_ids[0]) == Ok("completed"),
        "the shared run completes",
    )
    .await;
    assert_eq!(
        backend.starts(),
        1,
        "the race admitted exactly one backend start"
    );
}

#[tokio::test]
async fn status_reports_exact_states_without_aliases() {
    let (backend, gate) = ScriptedBackend::gated("out");
    let limits = BrocaLimits {
        max_backend_processes: 1,
        ..BrocaLimits::default()
    };
    let supervisor = Supervisor::with_limits(Arc::clone(&backend) as Arc<_>, limits);

    let running = send(&supervisor, "s-run", "p1");
    until(|| backend.starts() == 1, "first run starts").await;
    // The single backend permit is held, so the second admitted run is
    // deterministically still queued.
    let queued = send(&supervisor, "s-queue", "p2");
    assert_eq!(supervisor.status(&key("s-run"), &running), Ok("running"));
    assert_eq!(supervisor.status(&key("s-queue"), &queued), Ok("queued"));

    supervisor
        .cancel(&key("s-queue"), &queued)
        .await
        .expect("cancel queued run");
    assert_eq!(supervisor.status(&key("s-queue"), &queued), Ok("cancelled"));

    gate.add_permits(1);
    until(
        || supervisor.status(&key("s-run"), &running) == Ok("completed"),
        "gated run completes",
    )
    .await;

    let failing = ScriptedBackend::failing(BackendError {
        class: ErrorClass::Permanent,
        message: "model does not exist".to_owned(),
        retry_after_secs: None,
        provider_code: Some("model_not_found".to_owned()),
    });
    let fail_supervisor = Supervisor::new(failing as Arc<_>);
    let failed = send(&fail_supervisor, "s-fail", "p3");
    until(
        || fail_supervisor.status(&key("s-fail"), &failed) == Ok("failed"),
        "failing run fails",
    )
    .await;

    // Unknown, foreign-incarnation, and alias-shaped IDs are all exactly
    // `missing` — never substring-matched onto a live run.
    for id in ["", "unknown", "broca-deadbeef00-1", "run-1", "active"] {
        assert_eq!(
            supervisor.status(&key("s-run"), id),
            Ok("missing"),
            "{id:?}"
        );
    }
}

/// Run IDs are sequential within an incarnation, so holding one makes its
/// neighbours guessable. A caller may only observe and interrupt runs in the
/// session its own route is bound to: another session's live run must be
/// indistinguishable from an unknown ID, and cancelling it must be a no-op
/// rather than a way to kill someone else's billable work.
#[tokio::test]
async fn status_and_cancel_are_scoped_to_the_bound_session() {
    let (backend, gate) = ScriptedBackend::gated("out");
    let supervisor = Supervisor::new(Arc::clone(&backend) as Arc<_>);

    let victim = send(&supervisor, "s-victim", "p1");
    until(|| backend.starts() == 1, "victim run starts").await;
    assert_eq!(supervisor.status(&key("s-victim"), &victim), Ok("running"));

    // A different session on the same project and harness, and a different
    // project entirely, both see nothing.
    assert_eq!(
        supervisor.status(&key("s-attacker"), &victim),
        Ok("missing"),
        "another session must not observe this run's state"
    );
    let foreign_project = SessionKey {
        project_root: "/workspace/other".into(),
        harness: Harness::OpenCode,
        session: "s-victim".to_owned(),
    };
    assert_eq!(
        supervisor.status(&foreign_project, &victim),
        Ok("missing"),
        "another project must not observe this run's state"
    );

    // The cancel is the unknown-run no-op, and the run keeps running.
    supervisor
        .cancel(&key("s-attacker"), &victim)
        .await
        .expect("foreign cancel is a no-op");
    assert_eq!(
        supervisor.status(&key("s-victim"), &victim),
        Ok("running"),
        "another session must not interrupt this run"
    );

    // The owning session still controls its own run.
    supervisor
        .cancel(&key("s-victim"), &victim)
        .await
        .expect("owner cancels");
    assert_eq!(
        supervisor.status(&key("s-victim"), &victim),
        Ok("cancelled")
    );
    gate.add_permits(1);
    supervisor.shutdown().await;
}

/// A panicking backend must still yield exactly one failed terminal: an
/// unfinished run would stay `running` forever, hold its active-run slot,
/// and strand its subscribers.
#[tokio::test]
async fn backend_panic_commits_one_failed_terminal() {
    let backend = ScriptedBackend::with_behavior(|_request, _events, _cancel| {
        Box::pin(async { panic!("backend bug") })
    });
    let supervisor = Supervisor::new(backend as Arc<_>);
    let run_id = send(&supervisor, "s-panic", "p1");
    until(
        || supervisor.status(&key("s-panic"), &run_id) == Ok("failed"),
        "panicked run fails",
    )
    .await;
    // `finish` ran, so the run slot is free again: a fresh run on another
    // session still admits and reaches its own terminal.
    let second = send(&supervisor, "s-after-panic", "p2");
    until(
        || supervisor.status(&key("s-after-panic"), &second) == Ok("failed"),
        "post-panic run still executes",
    )
    .await;
}

#[tokio::test(start_paused = true)]
async fn early_and_late_subscribers_replay_byte_identical_units() {
    let (backend, gate) = ScriptedBackend::gated("streamed text");
    let limits = BrocaLimits {
        max_backend_processes: 1,
        ..BrocaLimits::default()
    };
    let supervisor = Supervisor::with_limits(Arc::clone(&backend) as Arc<_>, limits);

    // Occupy the only backend permit so the observed run stays queued.
    send(&supervisor, "s-block", "blocker");
    until(|| backend.starts() == 1, "blocker starts").await;
    let run_id = send(&supervisor, "s-watch", "watched");

    let mut early = supervisor
        .subscribe(&key("s-watch"))
        .expect("early subscriber attaches");
    // Attached before the run started: nothing to replay yet, so the
    // cursor must wait for run_started rather than fabricate output.
    let pending = tokio::time::timeout(Duration::from_millis(50), early.next()).await;
    assert!(pending.is_err(), "early subscriber waits for run_started");

    gate.add_permits(2);
    let mut early_units = Vec::new();
    while let Some(unit) = early.next().await {
        early_units.push(unit.to_vec());
    }
    until(
        || supervisor.status(&key("s-watch"), &run_id) == Ok("completed"),
        "watched run completes",
    )
    .await;

    let late = supervisor
        .subscribe(&key("s-watch"))
        .expect("late subscriber attaches");
    let late_units = drain_bytes(late).await;
    assert_eq!(early_units, late_units, "replay must be byte-identical");
    assert_eq!(early_units.len(), 3);
    assert_eq!(unit_json(&early_units[0])["unit"]["type"], "run_started");
    assert_eq!(
        unit_json(&early_units[1])["unit"]["message"]["content"][0]["text"],
        "streamed text"
    );
    assert_eq!(unit_json(&early_units[2])["unit"]["type"], "run_finished");
}

#[tokio::test]
async fn subscriber_caps_enforce_per_run_and_total_without_leaking_permits() {
    let (backend, gate) = ScriptedBackend::gated("out");
    let limits = BrocaLimits {
        max_total_subscribers: 5,
        ..BrocaLimits::default()
    };
    let supervisor = Supervisor::with_limits(Arc::clone(&backend) as Arc<_>, limits.clone());
    for session in ["a", "b", "c"] {
        send(&supervisor, session, session);
    }

    let _a1 = supervisor.subscribe(&key("a")).expect("first on a");
    let _a2 = supervisor.subscribe(&key("a")).expect("second on a");
    let third = supervisor
        .subscribe(&key("a"))
        .expect_err("third on one run is over the per-run cap");
    assert_eq!(third.code, "queue_full");
    // The rejected third subscriber must return its total-pool permit.
    assert_eq!(supervisor.metrics().free_subscriber_permits, 3);

    let _b1 = supervisor.subscribe(&key("b")).expect("first on b");
    let _b2 = supervisor.subscribe(&key("b")).expect("second on b");
    let _c1 = supervisor.subscribe(&key("c")).expect("first on c");
    assert_eq!(supervisor.metrics().free_subscriber_permits, 0);
    // Per-run capacity remains on c, but the total pool is exhausted.
    let total_full = supervisor
        .subscribe(&key("c"))
        .expect_err("subscriber over the total cap fails");
    assert_eq!(total_full.code, "queue_full");

    drop(_a1);
    let _c2 = supervisor
        .subscribe(&key("c"))
        .expect("a released permit re-admits");

    drop((_a2, _b1, _b2, _c1, _c2));
    assert_eq!(
        supervisor.metrics().free_subscriber_permits,
        limits.max_total_subscribers
    );
    gate.add_permits(3);
    supervisor.shutdown().await;
}

#[tokio::test]
async fn thirty_two_blocked_commands_admit_and_command_33_fails_fast() {
    let (backend, gate) = ScriptedBackend::gated_ignoring_cancel("out");
    let supervisor = Arc::new(Supervisor::new(Arc::clone(&backend) as Arc<_>));
    let run_id = send(&supervisor, "s1", "p");
    until(|| backend.starts() == 1, "run starts").await;

    // Each cancel holds one command permit while it waits for the backend
    // to stop; the fixture ignores cancellation until the gate releases.
    let mut blocked = Vec::new();
    for _ in 0..32 {
        let supervisor = Arc::clone(&supervisor);
        let run_id = run_id.clone();
        blocked.push(tokio::spawn(async move {
            supervisor.cancel(&key("s1"), &run_id).await
        }));
    }
    until(
        || supervisor.metrics().free_command_permits == 0,
        "32 commands hold every permit",
    )
    .await;

    let overflow = supervisor
        .status(&key("s1"), &run_id)
        .expect_err("command 33 fails fast");
    assert_eq!(overflow.code, "queue_full");

    gate.add_permits(1);
    for handle in blocked {
        handle
            .await
            .expect("cancel task joins")
            .expect("blocked cancel settles");
    }
    assert_eq!(supervisor.metrics().free_command_permits, 32);
    // The cancellation terminal committed before the backend's late
    // completion, which must not rewrite it.
    assert_eq!(supervisor.status(&key("s1"), &run_id), Ok("cancelled"));
}

#[tokio::test]
async fn thirty_two_runs_queue_behind_eight_backends_and_run_33_fails_without_state() {
    let (backend, gate) = ScriptedBackend::gated("out");
    let supervisor = Supervisor::new(Arc::clone(&backend) as Arc<_>);
    let mut runs = Vec::new();
    for index in 0..32 {
        runs.push(send(
            &supervisor,
            &format!("s{index}"),
            &format!("p{index}"),
        ));
    }
    until(|| backend.starts() == 8, "exactly eight backends run").await;
    let metrics = supervisor.metrics();
    assert_eq!(metrics.free_run_slots, 0);
    assert_eq!(metrics.free_backend_permits, 0);
    assert_eq!(metrics.live_runs, 32);

    let (request, body) = send_pair("p33");
    let overflow = supervisor
        .send(&key("s33"), request, &body)
        .expect_err("run 33 fails");
    assert_eq!(overflow.code, "queue_full");
    assert_eq!(
        supervisor.metrics().live_runs,
        32,
        "the rejected run must leave no index entry"
    );
    assert_eq!(supervisor.metrics().sessions, 32);

    gate.add_permits(32);
    for (index, run_id) in runs.iter().enumerate() {
        until(
            || supervisor.status(&key(&format!("s{index}")), run_id) == Ok("completed"),
            "queued run completes after permits release",
        )
        .await;
    }
    // Every reaped backend restores its permit; every terminal releases its
    // run slot.
    assert_eq!(supervisor.metrics().free_backend_permits, 8);
    assert_eq!(supervisor.metrics().free_run_slots, 32);
    assert_eq!(backend.starts(), 32);
}

#[tokio::test]
async fn dropping_a_subscriber_detaches_only_the_waiter() {
    let (backend, gate) = ScriptedBackend::gated("late output");
    let supervisor = Supervisor::new(Arc::clone(&backend) as Arc<_>);
    let run_id = send(&supervisor, "s1", "p");
    until(|| backend.starts() == 1, "run starts").await;

    let mut early = supervisor
        .subscribe(&key("s1"))
        .expect("subscriber attaches");
    let first = early.next().await.expect("run_started replays");
    assert_eq!(unit_json(&first)["unit"]["type"], "run_started");
    drop(early);

    gate.add_permits(1);
    until(
        || supervisor.status(&key("s1"), &run_id) == Ok("completed"),
        "run completes after its waiter detached",
    )
    .await;
    assert_eq!(
        backend.cancels_observed(),
        0,
        "waiter detach must never cancel the backend"
    );
    let replay = drain_bytes(supervisor.subscribe(&key("s1")).expect("re-subscribe")).await;
    assert_eq!(replay.len(), 3, "full replay survives the detach");
}

#[tokio::test]
async fn cancel_covers_queued_and_running_runs_and_stays_idempotent() {
    let (backend, gate) = ScriptedBackend::gated("out");
    let limits = BrocaLimits {
        max_backend_processes: 1,
        ..BrocaLimits::default()
    };
    let supervisor = Supervisor::with_limits(Arc::clone(&backend) as Arc<_>, limits);

    let running = send(&supervisor, "s-running", "p1");
    until(|| backend.starts() == 1, "first run starts").await;
    let queued = send(&supervisor, "s-queued", "p2");

    supervisor
        .cancel(&key("s-queued"), &queued)
        .await
        .expect("cancel queued");
    assert_eq!(
        supervisor.status(&key("s-queued"), &queued),
        Ok("cancelled")
    );
    // A run cancelled while queued still replays a well-formed log: the
    // prepended run_started, then exactly one cancellation terminal.
    let replay = drain_bytes(supervisor.subscribe(&key("s-queued")).expect("subscribe")).await;
    assert_eq!(replay.len(), 2);
    assert_eq!(unit_json(&replay[0])["unit"]["type"], "run_started");
    let terminal = unit_json(&replay[1]);
    assert_eq!(terminal["unit"]["type"], "error");
    assert_eq!(terminal["unit"]["error"]["class"], "permanent");

    supervisor
        .cancel(&key("s-running"), &running)
        .await
        .expect("cancel running");
    assert_eq!(
        supervisor.status(&key("s-running"), &running),
        Ok("cancelled")
    );
    assert_eq!(
        backend.cancels_observed(),
        1,
        "the running backend saw the cancel"
    );
    supervisor
        .cancel(&key("s-running"), &running)
        .await
        .expect("repeated cancel is idempotent");
    assert_eq!(
        supervisor.status(&key("s-running"), &running),
        Ok("cancelled")
    );

    // The queued run never consumed the backend permit it was waiting for,
    // and both terminals returned their active-run slots.
    assert_eq!(supervisor.metrics().free_backend_permits, 1);
    assert_eq!(
        supervisor.metrics().free_run_slots,
        BrocaLimits::default().max_active_runs
    );
    drop(gate);
}

#[tokio::test]
async fn completion_cannot_overwrite_a_committed_cancellation() {
    let (backend, gate) = ScriptedBackend::gated_ignoring_cancel("late completion");
    let supervisor = Arc::new(Supervisor::new(Arc::clone(&backend) as Arc<_>));
    let run_id = send(&supervisor, "s1", "p");
    until(|| backend.starts() == 1, "run starts").await;

    let canceller = {
        let supervisor = Arc::clone(&supervisor);
        let run_id = run_id.clone();
        tokio::spawn(async move { supervisor.cancel(&key("s1"), &run_id).await })
    };
    until(
        || supervisor.status(&key("s1"), &run_id) == Ok("cancelled"),
        "cancellation terminal commits",
    )
    .await;

    // Only now may the backend finish — with a completion the run must drop.
    gate.add_permits(1);
    canceller
        .await
        .expect("cancel task joins")
        .expect("cancel settles after the backend stops");
    assert_eq!(supervisor.status(&key("s1"), &run_id), Ok("cancelled"));
    let replay = drain_bytes(supervisor.subscribe(&key("s1")).expect("subscribe")).await;
    let last = unit_json(replay.last().expect("terminal unit"));
    assert_eq!(last["unit"]["type"], "error");
    assert_eq!(
        replay
            .iter()
            .filter(|unit| {
                let ty = unit_json(unit)["unit"]["type"].as_str().map(str::to_owned);
                ty.as_deref() == Some("error") || ty.as_deref() == Some("run_finished")
            })
            .count(),
        1,
        "exactly one in-band terminal"
    );
}

#[tokio::test]
async fn delete_during_running_waits_purges_and_installs_an_idempotent_tombstone() {
    let (backend, _gate) = ScriptedBackend::gated("out");
    let supervisor = Supervisor::new(Arc::clone(&backend) as Arc<_>);
    let run_id = send(&supervisor, "s1", "prompt bytes");
    until(|| backend.starts() == 1, "run starts").await;

    supervisor.delete(&key("s1")).await.expect("delete settles");
    assert_eq!(
        backend.cancels_observed(),
        1,
        "delete must wait for backend cancellation"
    );
    assert_eq!(supervisor.status(&key("s1"), &run_id), Ok("missing"));
    let metrics = supervisor.metrics();
    assert_eq!(metrics.live_runs, 0);
    assert_eq!(metrics.tombstones, 1);
    assert!(
        metrics.retained_bytes_capacity - metrics.retained_bytes_available
            < mc_host::broca::config::TERMINAL_HEADROOM_BYTES,
        "replay and request charges are gone; only tombstone metadata remains"
    );

    let after_first = supervisor.metrics();
    supervisor
        .delete(&key("s1"))
        .await
        .expect("repeated delete is side-effect free");
    assert_eq!(supervisor.metrics(), after_first);

    let (request, body) = send_pair("prompt bytes");
    let resurrect = supervisor
        .send(&key("s1"), request, &body)
        .expect_err("the tombstone blocks resurrection");
    assert_eq!(resurrect.code, "session_deleted");
    // The failed resurrection returns its candidate reservations.
    assert_eq!(supervisor.metrics(), after_first);
}

/// The eviction/delete race (AE7): a terminal-cap eviction removes the
/// session while `delete` is parked in its work-done wait, so the re-lock
/// no longer finds the run — the delete must still leave a tombstone
/// (charged fresh, since the evicted run's charges are gone) rather than
/// silently losing its resurrection guard.
#[tokio::test]
async fn delete_racing_a_terminal_cap_eviction_still_installs_a_tombstone() {
    let (backend, gate) = ScriptedBackend::gated_ignoring_cancel("out");
    let limits = BrocaLimits {
        max_terminal_sessions: 1,
        max_backend_processes: 1,
        ..BrocaLimits::default()
    };
    let supervisor = Arc::new(Supervisor::with_limits(
        Arc::clone(&backend) as Arc<_>,
        limits,
    ));

    let run_a = send(&supervisor, "s-del", "pa");
    until(|| backend.starts() == 1, "the deleted run's backend starts").await;
    let deleter = {
        let supervisor = Arc::clone(&supervisor);
        tokio::spawn(async move { supervisor.delete(&key("s-del")).await })
    };
    // The cancel-blind backend pins delete in wait_work_done after its
    // terminal committed, which is exactly the window the eviction races.
    until(
        || supervisor.status(&key("s-del"), &run_a) == Ok("cancelled"),
        "delete commits the cancellation terminal",
    )
    .await;

    // A second session's terminal commit enforces the 1-session cap and
    // evicts the (older, subscriber-free) deleted session while delete is
    // still parked. The second run stays queued behind the single backend
    // permit, so cancelling it settles promptly.
    let run_b = send(&supervisor, "s-evict", "pb");
    supervisor
        .cancel(&key("s-evict"), &run_b)
        .await
        .expect("cancel the evictor");
    assert_eq!(
        supervisor.status(&key("s-del"), &run_a),
        Ok("missing"),
        "the eviction removed the deleted session before delete re-locked"
    );

    gate.add_permits(1);
    deleter
        .await
        .expect("delete task joins")
        .expect("delete settles");
    assert_eq!(supervisor.metrics().tombstones, 1);
    let (request, body) = send_pair("pa");
    let resurrect = supervisor
        .send(&key("s-del"), request, &body)
        .expect_err("the raced delete still blocks resurrection");
    assert_eq!(resurrect.code, "session_deleted");
}

#[tokio::test(start_paused = true)]
async fn terminal_expiry_and_oldest_eviction_enforce_the_session_caps() {
    let backend = ScriptedBackend::completing("out");
    let limits = BrocaLimits {
        max_terminal_sessions: 2,
        ..BrocaLimits::default()
    };
    let supervisor = Supervisor::with_limits(Arc::clone(&backend) as Arc<_>, limits);

    let mut runs = Vec::new();
    for index in 0..3 {
        let run_id = send(&supervisor, &format!("s{index}"), &format!("p{index}"));
        until(
            || supervisor.status(&key(&format!("s{index}")), &run_id) == Ok("completed"),
            "run completes",
        )
        .await;
        runs.push(run_id);
        // Distinct commit instants make "oldest" deterministic.
        tokio::time::advance(Duration::from_secs(1)).await;
    }
    // The third terminal displaced the oldest retained session.
    assert_eq!(supervisor.status(&key("s0"), &runs[0]), Ok("missing"));
    assert_eq!(supervisor.status(&key("s1"), &runs[1]), Ok("completed"));
    assert_eq!(supervisor.status(&key("s2"), &runs[2]), Ok("completed"));
    assert_eq!(supervisor.metrics().sessions, 2);

    tokio::time::advance(TERMINAL_RETENTION).await;
    // Any command sweeps first, so both survivors now report missing and
    // their charges are gone.
    assert_eq!(supervisor.status(&key("s1"), &runs[1]), Ok("missing"));
    assert_eq!(supervisor.status(&key("s2"), &runs[2]), Ok("missing"));
    let metrics = supervisor.metrics();
    assert_eq!(metrics.sessions, 0);
    assert_eq!(
        metrics.retained_bytes_available,
        metrics.retained_bytes_capacity
    );
}

#[tokio::test(start_paused = true)]
async fn retained_pressure_sweeps_expired_entries_and_retries_admission_once() {
    let backend = ScriptedBackend::completing("out");
    // Sized so one live request fits, but a live request plus one expired
    // terminal's residue does not — admission then succeeds only if the
    // pressure path sweeps the expired entry and retries.
    let limits = BrocaLimits {
        max_retained_bytes: 20 * 1024,
        ..BrocaLimits::default()
    };
    let supervisor = Supervisor::with_limits(Arc::clone(&backend) as Arc<_>, limits);

    let first = send(&supervisor, "s1", &"x".repeat(12 * 1024));
    until(
        || supervisor.status(&key("s1"), &first) == Ok("completed"),
        "first run completes",
    )
    .await;
    let retained_before = supervisor.metrics().retained_bytes_available;
    assert!(
        retained_before < supervisor.metrics().retained_bytes_capacity,
        "the terminal keeps a retained charge until expiry"
    );

    tokio::time::advance(TERMINAL_RETENTION).await;
    let second = send(&supervisor, "s2", &"y".repeat(12 * 1024));
    until(
        || supervisor.status(&key("s2"), &second) == Ok("completed"),
        "second run completes after the sweep freed the budget",
    )
    .await;
    assert_eq!(supervisor.metrics().sessions, 1);
}

#[tokio::test(start_paused = true)]
async fn replay_overflow_commits_one_failed_terminal_and_stops_growth() {
    let backend = ScriptedBackend::flooding(2_000, 10);
    let limits = BrocaLimits {
        max_run_replay_bytes: 12 * 1024,
        ..BrocaLimits::default()
    };
    let supervisor = Supervisor::with_limits(Arc::clone(&backend) as Arc<_>, limits.clone());
    let run_id = send(&supervisor, "s1", "p");
    until(
        || supervisor.status(&key("s1"), &run_id) == Ok("failed"),
        "the overflowing run fails",
    )
    .await;
    // The flooding backend has already emitted everything it ever will;
    // whatever survived the cap is final.
    let retained_after_failure = supervisor.metrics().retained_bytes_available;

    let replay = drain_bytes(supervisor.subscribe(&key("s1")).expect("subscribe")).await;
    assert!(
        replay.len() < 12,
        "retention stopped before the ten flooded units all landed"
    );
    let last = unit_json(replay.last().expect("terminal"));
    assert_eq!(last["unit"]["type"], "error");
    assert_eq!(last["unit"]["error"]["class"], "permanent");
    let terminal_count = replay
        .iter()
        .filter(|unit| unit_json(unit)["unit"]["type"] == "error")
        .count();
    assert_eq!(terminal_count, 1, "exactly one failed terminal");
    assert_eq!(
        supervisor.metrics().retained_bytes_available,
        retained_after_failure,
        "no retained growth after the terminal"
    );

    // The truncated replay's accounting must provably release: delete the
    // session, expire its tombstone, and land back on the construction
    // baseline.
    supervisor.delete(&key("s1")).await.expect("delete settles");
    tokio::time::advance(TERMINAL_RETENTION).await;
    // Commands sweep expired entries; a status probe is the cheapest one.
    assert_eq!(supervisor.status(&key("s1"), "gone"), Ok("missing"));
    assert_baseline(supervisor.metrics(), &limits, 0);
}

#[tokio::test(start_paused = true)]
async fn every_path_returns_permits_and_charges_to_baseline() {
    let (backend, gate) = ScriptedBackend::gated("out");
    let limits = BrocaLimits {
        max_active_runs: 2,
        max_backend_processes: 1,
        max_run_replay_bytes: 12 * 1024,
        ..BrocaLimits::default()
    };
    let supervisor = Supervisor::with_limits(Arc::clone(&backend) as Arc<_>, limits.clone());

    // Conflict: rejected candidates release their reservations.
    let run_a = send(&supervisor, "a", "prompt a");
    let (conflicting, conflicting_body) = send_pair("other prompt");
    supervisor
        .send(&key("a"), conflicting, &conflicting_body)
        .expect_err("conflict");

    // Full admission: run 3 bounces off the 2-run cap with no entry.
    let run_b = send(&supervisor, "b", "prompt b");
    let (third, third_body) = send_pair("prompt c");
    supervisor
        .send(&key("c"), third, &third_body)
        .expect_err("active-run cap");
    assert_eq!(supervisor.metrics().sessions, 2);

    // Callback abort: a mid-stream subscriber dropped without draining.
    let mut aborted = supervisor.subscribe(&key("a")).expect("subscriber");
    until(|| backend.starts() == 1, "first backend starts").await;
    let _ = aborted.next().await;
    drop(aborted);

    // Natural completion for one run, cancellation race for the other.
    gate.add_permits(2);
    until(
        || supervisor.status(&key("a"), &run_a) == Ok("completed"),
        "a completes",
    )
    .await;
    supervisor
        .cancel(&key("b"), &run_b)
        .await
        .expect("cancel b");
    supervisor
        .cancel(&key("b"), &run_b)
        .await
        .expect("idempotent cancel");

    // Deletion of one terminal session, expiry of the other.
    supervisor.delete(&key("b")).await.expect("delete b");
    tokio::time::advance(TERMINAL_RETENTION).await;
    assert_eq!(supervisor.status(&key("a"), &run_a), Ok("missing"));
    assert_eq!(supervisor.status(&key("b"), &run_b), Ok("missing"));

    assert_baseline(supervisor.metrics(), &limits, 0);

    // Shutdown from a state with live work must also land on baseline.
    let (gated_backend, _late_gate) = ScriptedBackend::gated("late");
    let closing = Supervisor::with_limits(gated_backend as Arc<_>, limits.clone());
    send(&closing, "z", "prompt z");
    closing.shutdown().await;
    assert_baseline(closing.metrics(), &limits, 0);
}

#[tokio::test]
async fn shutdown_refuses_new_work_stops_backends_and_wakes_subscribers() {
    let (backend, _gate) = ScriptedBackend::gated("out");
    let limits = BrocaLimits {
        max_backend_processes: 2,
        ..BrocaLimits::default()
    };
    let supervisor = Arc::new(Supervisor::with_limits(
        Arc::clone(&backend) as Arc<_>,
        limits.clone(),
    ));
    // Two running, one queued behind the shrunken backend pool.
    for session in ["a", "b", "c"] {
        send(&supervisor, session, session);
    }
    until(|| backend.starts() == 2, "two backends run").await;

    let mut waiters = Vec::new();
    for session in ["a", "b", "c"] {
        let mut subscription = supervisor.subscribe(&key(session)).expect("subscriber");
        waiters.push(tokio::spawn(async move {
            let mut units = 0usize;
            while subscription.next().await.is_some() {
                units += 1;
            }
            units
        }));
    }

    supervisor.shutdown().await;
    assert_eq!(
        backend.cancels_observed(),
        2,
        "every running backend observed the stop"
    );
    for waiter in waiters {
        // Woken and finished — a hung subscriber would hang this join.
        waiter.await.expect("subscriber task joins");
    }

    let (request, body) = send_pair("late");
    assert_eq!(
        supervisor
            .send(&key("late"), request, &body)
            .expect_err("send after shutdown")
            .code,
        "cancelled"
    );
    assert_eq!(
        supervisor
            .subscribe(&key("a"))
            .expect_err("subscribe after shutdown")
            .code,
        "cancelled"
    );
    assert_eq!(
        supervisor
            .status(&key("a"), "anything")
            .expect_err("status after shutdown")
            .code,
        "cancelled"
    );
    assert_baseline(supervisor.metrics(), &limits, 0);
}

/// Waiter detach through the real transport: request cancellation, route
/// closure, and whole-connection loss each detach only that subscriber
/// while the gated run survives to completion.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transport_detach_paths_leave_the_run_untouched() {
    let (backend, gate) = ScriptedBackend::gated("survivor output");
    let component = BrocaComponent::new(Arc::clone(&backend) as Arc<_>);
    let supervisor = component.supervisor();
    let host = start_broca_host(component).await;

    let mut client = host.client().await;
    let (command_ch, command_ep) = open_broca_route(&mut client, "opencode", "s1").await;
    let response = support::broca::call(
        &mut client,
        command_ch,
        command_ep,
        "session.send",
        send_params("detach fixture", None, "prov/model-a"),
    )
    .await;
    let run_id = response.json()["run_id"]
        .as_str()
        .expect("run id")
        .to_owned();

    // Request cancellation: the host cancels the handler task; the waiter
    // detaches and the stream settles without a run terminal.
    let (sub_ch, sub_ep) = open_broca_route(&mut client, "opencode", "s1").await;
    let corr = send_call(
        &mut client,
        sub_ch,
        sub_ep,
        "session.subscribe",
        serde_json::json!({ "from": "start" }),
    )
    .await;
    let first = client
        .frames_until_corr(corr, support::broca::BUDGET)
        .await
        .expect("run_started streams")
        .1;
    assert_eq!(first.ty, support::raw_client::TY_STREAM_DATA);
    client
        .send_frame(
            support::raw_client::TY_CANCEL,
            support::raw_client::FLAGS_INTERACTIVE,
            sub_ch,
            sub_ep,
            corr,
            &[],
        )
        .await
        .expect("cancel frame");
    let (_stream_units, terminal) = support::broca::drain_subscribe(&mut client, corr).await;
    assert_ne!(
        terminal.ty,
        support::raw_client::TY_STREAM_DATA,
        "the cancelled request settles"
    );

    // Route closure: a fresh subscription's route says goodbye mid-stream.
    let (gone_ch, gone_ep) = open_broca_route(&mut client, "opencode", "s1").await;
    let corr = send_call(
        &mut client,
        gone_ch,
        gone_ep,
        "session.subscribe",
        serde_json::json!({ "from": "start" }),
    )
    .await;
    client
        .frames_until_corr(corr, support::broca::BUDGET)
        .await
        .expect("run_started streams again");
    client
        .send_frame(
            support::raw_client::TY_GOODBYE,
            support::raw_client::FLAGS_INTERACTIVE,
            gone_ch,
            gone_ep,
            0,
            &[],
        )
        .await
        .expect("goodbye frame");
    // The closed route settles its in-flight subscription with a terminal
    // frame; consume it before reading later control responses.
    client
        .frames_until_corr(corr, support::broca::BUDGET)
        .await
        .expect("the goodbye'd subscription settles");

    // Connection loss: a second authenticated connection subscribes, then
    // drops entirely.
    {
        let mut doomed = host.client().await;
        let (lost_ch, lost_ep) = open_broca_route(&mut doomed, "opencode", "s1").await;
        let corr = send_call(
            &mut doomed,
            lost_ch,
            lost_ep,
            "session.subscribe",
            serde_json::json!({ "from": "start" }),
        )
        .await;
        doomed
            .frames_until_corr(corr, support::broca::BUDGET)
            .await
            .expect("run_started streams on the doomed connection");
    }

    // Every waiter is gone; the run itself never saw a cancellation.
    let deadline = tokio::time::Instant::now() + support::broca::BUDGET;
    loop {
        if supervisor.metrics().free_subscriber_permits == 64 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "detached waiters must release their permits"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(backend.cancels_observed(), 0);

    gate.add_permits(1);
    let (final_ch, final_ep) = open_broca_route(&mut client, "opencode", "s1").await;
    let corr = send_call(
        &mut client,
        final_ch,
        final_ep,
        "session.subscribe",
        serde_json::json!({ "from": "start" }),
    )
    .await;
    let (units, terminal) = support::broca::drain_subscribe(&mut client, corr).await;
    assert_eq!(terminal.ty, support::raw_client::TY_STREAM_END);
    assert_eq!(units.len(), 3, "full replay after every detach: {units:?}");
    assert_eq!(units[2]["unit"]["type"], "run_finished");
    assert_eq!(backend.starts(), 1);

    let status = support::broca::call(
        &mut client,
        command_ch,
        command_ep,
        "run.status",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    assert_eq!(status.json()["state"], "completed");
    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_shutdown_drains_the_supervisor_to_zero_state() {
    let (backend, _gate) = ScriptedBackend::gated("out");
    let component = BrocaComponent::new(Arc::clone(&backend) as Arc<_>);
    let supervisor = component.supervisor();
    let host = start_broca_host(component).await;

    let mut client = host.client().await;
    let (command_ch, command_ep) = open_broca_route(&mut client, "pi", "s1").await;
    support::broca::call(
        &mut client,
        command_ch,
        command_ep,
        "session.send",
        send_params("shutdown fixture", None, "prov/model-a"),
    )
    .await;
    let (sub_ch, sub_ep) = open_broca_route(&mut client, "pi", "s1").await;
    let corr = send_call(
        &mut client,
        sub_ch,
        sub_ep,
        "session.subscribe",
        serde_json::json!({ "from": "start" }),
    )
    .await;
    client
        .frames_until_corr(corr, support::broca::BUDGET)
        .await
        .expect("subscriber is mid-stream");

    host.shutdown().await.expect("graceful shutdown");
    assert_eq!(backend.cancels_observed(), 1, "the running backend stopped");
    let metrics = supervisor.metrics();
    assert_eq!(metrics.sessions, 0);
    assert_eq!(metrics.live_runs, 0);
    assert_eq!(metrics.tombstones, 0);
    assert_eq!(
        metrics.retained_bytes_available,
        metrics.retained_bytes_capacity
    );
    assert_eq!(metrics.free_subscriber_permits, 64);
    assert_eq!(metrics.free_backend_permits, 8);
    assert_eq!(metrics.free_run_slots, 32);
}
