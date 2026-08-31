//! These tests use paused Tokio time and backend gates to verify deterministic Broca supervisor behavior without wall-clock sleeps.

mod support;

use std::sync::Arc;
use std::time::Duration;

use mc_host::broca::backend::{BackendError, BackendTerminal, ErrorClass, Harness};
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

/// The fingerprint uses the exact serialized request body.
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

/// `until` yields at most 100,000 times, preventing paused-clock tests from spinning indefinitely when `cond` remains false.
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
    // `Supervisor` charges its 64 MiB retention budget only for retained run data; route metadata, backend capture, tombstones, environment snapshots, and adapter-owned spawn variables are outside that budget.
    assert_eq!(
        resources.retained_resident_bytes,
        64 * 1024 * 1024
            + 1024 * (4096 + 256 + 3 * (16 + 64) + 1024)
            + 8 * ((4 * 1024 * 1024 + 64 * 1024) * 5 + 512 * 1024)
            + 256 * ((4096 + 256) * 3 + 128)
            + (1 + 3 * 8) * 1536 * 1024
            + 3 * 8 * (96 * 1024 + 8 * 1024)
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

    // Idempotency fingerprints exact body bytes, so bodies differing by one inserted space conflict even when they parse identically.
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

/// The barrier releases identical `Supervisor::send` calls concurrently.
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
    // The second admitted run remains queued until the held backend permit is released.
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

    // Unknown, foreign-incarnation, and alias-shaped IDs return `missing` and never match a live run.
    // Unknown, foreign-incarnation, and alias-shaped IDs return `missing` and never match a live run.
    for id in ["", "unknown", "broca-deadbeef00-1", "run-1", "active"] {
        assert_eq!(
            supervisor.status(&key("s-run"), id),
            Ok("missing"),
            "{id:?}"
        );
    }
}

/// Run IDs are sequential within an incarnation, so another session can guess a live run ID.
/// A route may observe or cancel only runs in its bound session.
/// Runs in another session return `missing`.
/// Cancelling a run outside the bound session is a no-op.
#[tokio::test]
async fn status_and_cancel_are_scoped_to_the_bound_session() {
    let (backend, gate) = ScriptedBackend::gated("out");
    let supervisor = Supervisor::new(Arc::clone(&backend) as Arc<_>);

    let victim = send(&supervisor, "s-victim", "p1");
    until(|| backend.starts() == 1, "victim run starts").await;
    assert_eq!(supervisor.status(&key("s-victim"), &victim), Ok("running"));

    // Different sessions in the same project and sessions in other projects return `missing`.
    // Different sessions in the same project and sessions in other projects return `missing`.
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

    // Cancelling an unknown run is a no-op, so the owning run remains running.
    supervisor
        .cancel(&key("s-attacker"), &victim)
        .await
        .expect("foreign cancel is a no-op");
    assert_eq!(
        supervisor.status(&key("s-victim"), &victim),
        Ok("running"),
        "another session must not interrupt this run"
    );

    // The owning session can still cancel its run.
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

/// A panicking backend produces exactly one `failed` terminal.
/// Without a terminal, a run remains `running`, retains its active-run slot, and strands subscribers.
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
    // `finish` frees the run slot, so a fresh run in another session still admits and reaches its own terminal.
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

    // The held backend permit keeps the observed run queued.
    send(&supervisor, "s-block", "blocker");
    until(|| backend.starts() == 1, "blocker starts").await;
    let run_id = send(&supervisor, "s-watch", "watched");

    let mut early = supervisor
        .subscribe(&key("s-watch"))
        .expect("early subscriber attaches");
    // A subscriber attached before `run_started` has no output to replay.
    // A subscriber attached before `run_started` waits for that event instead of receiving fabricated output.
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

    // Each cancel holds one command permit until the backend stops; the fixture ignores cancellation until the gate releases.
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
    // After committing a cancellation terminal, the run ignores the backend's late completion.
    // After committing a cancellation terminal, the run ignores the backend's late completion.
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
    // Reaping a backend restores its permit, and reaching a terminal state releases its active-run slot.
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
    // A queued cancelled run replays `run_started` followed by exactly one cancellation terminal.
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

    // A queued run does not consume the backend permit it awaits.
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

    // The supervisor ignores the backend's completion after committing a cancellation terminal.
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

/// `work_done` proves only task completion; `cancel` and `delete` must return an error until process-tree teardown is confirmed.
#[tokio::test]
async fn unproven_teardown_fails_cancel_and_delete() {
    let backend = ScriptedBackend::with_behavior(|_request, _events, _cancel| {
        Box::pin(async {
            BackendTerminal::FailedUnresolved(BackendError {
                class: ErrorClass::Transient,
                message: "pi backend process group teardown was not confirmed".to_owned(),
                retry_after_secs: None,
                provider_code: None,
            })
        })
    });
    let supervisor = Supervisor::new(backend as Arc<_>);

    let run_id = send(&supervisor, "s-unproven", "p1");
    until(
        || supervisor.status(&key("s-unproven"), &run_id) == Ok("failed"),
        "the unresolved run still commits its failed terminal",
    )
    .await;

    // `cancel` returns `teardown_unconfirmed` after the terminal commits when teardown remains unproven.
    let cancelled = supervisor
        .cancel(&key("s-unproven"), &run_id)
        .await
        .expect_err("cancel cannot claim an unproven teardown");
    assert_eq!(cancelled.code, "teardown_unconfirmed");

    // `delete` purges and tombstones the session before reporting unproven teardown.
    let deleted = supervisor
        .delete(&key("s-unproven"))
        .await
        .expect_err("delete cannot claim an unproven teardown");
    assert_eq!(deleted.code, "teardown_unconfirmed");
    let (request, body) = send_pair("p2");
    let resurrect = supervisor
        .send(&key("s-unproven"), request, &body)
        .expect_err("the tombstone blocks resurrection");
    assert_eq!(
        resurrect.code, "session_deleted",
        "the tombstone must exist despite the reported failure"
    );
}

/// `finish` preserves the first terminal, but `cancel` still reports unproven teardown when the backend cannot confirm it.
#[tokio::test]
async fn cancellation_winning_the_terminal_still_reports_unproven_teardown() {
    let backend = ScriptedBackend::with_behavior(|_request, _events, cancel| {
        Box::pin(async move {
            cancel.cancelled().await;
            BackendTerminal::FailedUnresolved(BackendError {
                class: ErrorClass::Transient,
                message: "process group teardown was not confirmed".to_owned(),
                retry_after_secs: None,
                provider_code: None,
            })
        })
    });
    let supervisor = Supervisor::new(backend as Arc<_>);

    let run_id = send(&supervisor, "s-cancel-unproven", "p1");
    until(
        || supervisor.status(&key("s-cancel-unproven"), &run_id) == Ok("running"),
        "the backend starts before the cancel races it",
    )
    .await;

    let cancelled = supervisor
        .cancel(&key("s-cancel-unproven"), &run_id)
        .await
        .expect_err("cancel cannot claim a teardown the backend disproved");
    assert_eq!(cancelled.code, "teardown_unconfirmed");
    assert_eq!(
        supervisor.status(&key("s-cancel-unproven"), &run_id),
        Ok("cancelled")
    );

    let deleted = supervisor
        .delete(&key("s-cancel-unproven"))
        .await
        .expect_err("delete reports the same unproven teardown");
    assert_eq!(deleted.code, "teardown_unconfirmed");
}

/// `shutdown` reports runs with unproven teardown.
#[tokio::test]
async fn shutdown_counts_runs_with_unproven_teardown() {
    let backend = ScriptedBackend::with_behavior(|_request, _events, cancel| {
        Box::pin(async move {
            cancel.cancelled().await;
            BackendTerminal::FailedUnresolved(BackendError {
                class: ErrorClass::Transient,
                message: "process group teardown was not confirmed".to_owned(),
                retry_after_secs: None,
                provider_code: None,
            })
        })
    });
    let supervisor = Supervisor::new(backend as Arc<_>);
    let run_id = send(&supervisor, "s-shutdown-unproven", "p1");
    until(
        || supervisor.status(&key("s-shutdown-unproven"), &run_id) == Ok("running"),
        "the backend starts before shutdown cancels it",
    )
    .await;

    assert_eq!(
        supervisor.shutdown().await,
        1,
        "shutdown must surface the run whose teardown was never proven"
    );
}

/// Terminal runs with unproven teardown remain indexed so later control operations observe the teardown verdict.
#[tokio::test]
async fn terminal_cap_never_evicts_a_run_awaiting_teardown() {
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
    // `wait_work_done` must retain the terminal run while `delete` waits, even if another session reaches the terminal cap.
    // would race.
    until(
        || supervisor.status(&key("s-del"), &run_a) == Ok("cancelled"),
        "delete commits the cancellation terminal",
    )
    .await;

    // A second session's terminal commit enforces the one-session cap while delete remains parked.
    // The second run remains queued behind the backend's single permit, so cancellation settles promptly.
    let run_b = send(&supervisor, "s-evict", "pb");
    supervisor
        .cancel(&key("s-evict"), &run_b)
        .await
        .expect("cancel the second session's run");
    assert_eq!(
        supervisor.status(&key("s-del"), &run_a),
        Ok("cancelled"),
        "a run awaiting teardown must survive cap pressure"
    );

    gate.add_permits(1);
    deleter
        .await
        .expect("delete task joins")
        .expect("delete settles");
    assert_eq!(
        supervisor.status(&key("s-del"), &run_a),
        Ok("missing"),
        "the settled delete purged its run"
    );
    assert_eq!(supervisor.metrics().tombstones, 1);
    let (request, body) = send_pair("pa");
    let resurrect = supervisor
        .send(&key("s-del"), request, &body)
        .expect_err("the delete still blocks resurrection");
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
    assert_eq!(supervisor.status(&key("s0"), &runs[0]), Ok("missing"));
    assert_eq!(supervisor.status(&key("s1"), &runs[1]), Ok("completed"));
    assert_eq!(supervisor.status(&key("s2"), &runs[2]), Ok("completed"));
    assert_eq!(supervisor.metrics().sessions, 2);

    tokio::time::advance(TERMINAL_RETENTION).await;
    // Any command sweeps expired entries first, so both survivors report missing and their retained-byte charges are removed.
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
    // The retained-byte limit admits one live request but rejects a live request plus an expired terminal's residue.
    // Admission succeeds only when the pressure path sweeps the expired entry and retries.
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
    // The flooding backend emits no later frames, so retained frames are final.
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

    // Deleting the session and expiring its tombstone must restore the retained-byte budget to its construction baseline.
    // baseline.
    supervisor.delete(&key("s1")).await.expect("delete settles");
    tokio::time::advance(TERMINAL_RETENTION).await;
    // Commands sweep expired entries before status checks.
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

    // Rejected candidates release their reservations.
    let run_a = send(&supervisor, "a", "prompt a");
    let (conflicting, conflicting_body) = send_pair("other prompt");
    supervisor
        .send(&key("a"), conflicting, &conflicting_body)
        .expect_err("conflict");

    // Run 3 is rejected by the two-run cap before creating an entry.
    let run_b = send(&supervisor, "b", "prompt b");
    let (third, third_body) = send_pair("prompt c");
    supervisor
        .send(&key("c"), third, &third_body)
        .expect_err("active-run cap");
    assert_eq!(supervisor.metrics().sessions, 2);

    let mut aborted = supervisor.subscribe(&key("a")).expect("subscriber");
    until(|| backend.starts() == 1, "first backend starts").await;
    let _ = aborted.next().await;
    drop(aborted);

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
        // The subscriber wakes and finishes; a hung subscriber would block this join.
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

/// Request cancellation, route closure, and whole-connection loss each detach only their subscriber while the gated run completes.
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

    // When the host cancels the handler task, the handler's waiter detaches and its stream settles without a run terminal.
    // The handler's waiter detaches, and the subscription stream settles without a run terminal.
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
    // The closed route settles its in-flight subscription with a terminal frame.
    client
        .frames_until_corr(corr, support::broca::BUDGET)
        .await
        .expect("the goodbye'd subscription settles");

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
