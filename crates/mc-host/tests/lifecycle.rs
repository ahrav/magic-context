//! Admission capacity, internal health, liveness, and shutdown ordering.

mod support;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use mc_host::{HostError, McHostHandler};

use support::raw_client::{
    self, FLAGS_INTERACTIVE, FLAGS_PURE_HEADER, TY_GOODBYE, TY_PING, TY_PONG, TY_REQUEST,
    TY_RESPONSE,
};
use support::{mode_body, BindPolicy, Event, TestHandler, TestHost, LINKED_MODULE_ID};

const BUDGET: Duration = Duration::from_secs(5);
const ROOT: &str = "/workspace/project";

/// Blocks inside one `route_gone` poll, so task abort cannot take effect until
/// the test releases it.
struct DelayedRouteGoneHandler {
    inner: TestHandler,
    route_gone_started: Arc<AtomicBool>,
    route_gone_release: Arc<(Mutex<bool>, Condvar)>,
    shutdown_calls: Arc<AtomicUsize>,
}

impl McHostHandler for DelayedRouteGoneHandler {
    fn manifests(&self) -> Vec<mc_host::ManifestSnapshot> {
        self.inner.manifests()
    }

    async fn initialize(&self, init: mc_host::HostInit) -> Result<(), mc_host::InitError> {
        self.inner.initialize(init).await
    }

    async fn bind(
        &self,
        route: mc_host::RouteHandle,
        target: mc_host::RouteTarget,
        identity: mc_host::RouteIdentity,
    ) -> mc_host::BindOutcome {
        self.inner.bind(route, target, identity).await
    }

    async fn handle(&self, ctx: mc_host::RequestCtx) -> mc_host::RequestOutcome {
        self.inner.handle(ctx).await
    }

    async fn route_gone(&self, route: mc_host::RouteHandle) {
        self.route_gone_started.store(true, Ordering::SeqCst);
        {
            let (lock, ready) = &*self.route_gone_release;
            let mut released = lock.lock().expect("route-gone release lock");
            while !*released {
                released = ready.wait(released).expect("route-gone release wait");
            }
        }
        self.inner.route_gone(route).await;
    }

    async fn health(&self) -> mc_host::HealthReport {
        self.inner.health().await
    }

    async fn shutdown(&self) {
        self.shutdown_calls.fetch_add(1, Ordering::SeqCst);
        self.inner.shutdown().await;
    }
}

#[tokio::test]
async fn publication_follows_initialization() {
    let host = TestHost::start().await;
    let events = host.handler.events();
    assert_eq!(
        events.first(),
        Some(&Event::Initialized),
        "initialization must complete before anything else"
    );
    // The publication exists, so initialization already returned.
    assert!(host.publication_path().exists());
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn publication_waits_for_initialization_to_return() {
    let data_root = tempfile::tempdir().expect("temp root");
    let handler = TestHandler::new();
    handler.block_init();
    let shutdown = mc_host::CancellationToken::new();
    let config = mc_host::HostConfig {
        data_dir: Some(data_root.path().to_path_buf()),
        ..Default::default()
    };
    let run_handler = handler.clone();
    let run_shutdown = shutdown.clone();
    let task = tokio::spawn(async move { mc_host::run(run_handler, config, run_shutdown).await });
    let publication = support::connection_file(data_root.path());

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !publication.exists(),
        "publication must remain absent while initialization is blocked"
    );
    handler.release_init();
    let deadline = tokio::time::Instant::now() + BUDGET;
    while !publication.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "publication missing"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    shutdown.cancel();
    task.await
        .expect("run task")
        .expect("shutdown after initialization");
}

#[tokio::test]
async fn initialization_timeout_aborts_and_joins_the_callback() {
    let data_root = tempfile::tempdir().expect("temp root");
    let handler = TestHandler::new();
    handler.block_init();
    let config = mc_host::HostConfig {
        data_dir: Some(data_root.path().to_path_buf()),
        timing: mc_host::HostTiming {
            lifecycle_callback_deadline: Duration::from_millis(50),
            ..Default::default()
        },
        ..Default::default()
    };
    let result = mc_host::run(handler.clone(), config, mc_host::CancellationToken::new()).await;
    assert!(matches!(result, Err(mc_host::HostError::InitFailed(_))));
    handler.release_init();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !handler.events().contains(&Event::Initialized),
        "a timed-out initialization task must not continue detached"
    );
}

#[tokio::test]
async fn failed_initialization_prevents_publication() {
    let handler = TestHandler::new();
    handler.fail_init("storage descriptor rejected");

    let result = TestHost::try_start_with(handler, |_config| {}).await;
    let err = match result {
        Ok(_) => panic!("startup must fail when initialization fails"),
        Err(err) => err,
    };
    assert!(
        matches!(err, mc_host::HostError::InitFailed(_)),
        "expected an initialization failure, got {err}"
    );
}

#[tokio::test]
async fn transport_serves_while_the_handler_reports_degraded_storage() {
    let host = TestHost::start_with(|config| {
        config.timing.health_interval = Duration::from_millis(50);
    })
    .await;
    host.handler
        .set_health(mc_host::HealthStatus::Degraded, Some("store opening"));

    // Discovery, authentication, catalog, and bind all work in this window.
    let mut client = host.client().await;
    let corr = client
        .control(&serde_json::json!({"op": "catalog.list"}))
        .await
        .expect("catalog");
    let frame = client.frame_within(BUDGET).await.expect("catalog reply");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.ty, TY_RESPONSE);

    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "degraded")
        .await
        .expect("bind still works while storage opens");

    // A storage-dependent request returns an application terminal, not a
    // transport disconnect.
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({
                "mode": "error",
                "code": "store_unavailable",
                "message": "still opening"
            })),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "store_unavailable");

    // Health ran internally and never appeared as a client operation.
    let deadline = tokio::time::Instant::now() + BUDGET;
    while !host.handler.events().contains(&Event::Health) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the internal health task must run"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let frame = {
        let corr = client
            .control(&serde_json::json!({"op": "health"}))
            .await
            .expect("health op");
        let (_, frame) = client
            .frames_until_corr(corr, BUDGET)
            .await
            .expect("terminal");
        frame
    };
    assert_eq!(
        frame.error_code(),
        "unsupported_operation",
        "handler health must not be reachable as a client JSON operation"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn saturated_handshake_capacity_closes_without_reading_client_bytes() {
    let host = TestHost::start_with(|config| {
        config.limits.max_handshakes = 1;
    })
    .await;

    // Occupy the only handshake slot with a socket that never speaks.
    let squatter = raw_client::connect_unauthenticated(&host.info)
        .await
        .expect("squatter connects");

    // Give the host a moment to accept and charge the slot.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The second peer sends no bytes. EOF therefore proves the host did not
    // wait for a handshake read before enforcing capacity.
    let mut rejected = raw_client::connect_unauthenticated(&host.info)
        .await
        .expect("second connects");
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 1];
    let read = tokio::time::timeout(Duration::from_secs(3), rejected.read(&mut buf)).await;
    assert!(
        matches!(read, Ok(Ok(0)) | Ok(Err(_))),
        "an over-capacity accept must be closed without a reply"
    );

    // Releasing the squatter frees its slot, and a fresh client authenticates.
    drop(squatter);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if raw_client::RawClient::connect(&host.info).await.is_ok() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the handshake slot must be released"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn saturated_connection_capacity_closes_after_authentication() {
    let host = TestHost::start_with(|config| {
        config.limits.max_connections = 1;
    })
    .await;

    let mut first = host.client().await;
    // The first generation stays live and usable.
    let corr = first
        .control(&serde_json::json!({"op": "catalog.list"}))
        .await
        .expect("catalog");
    let frame = first.frame_within(BUDGET).await.expect("reply");
    assert_eq!(frame.corr, corr);

    // ServerProof must arrive before the post-authentication capacity close;
    // an accept-time capacity check would make this connect fail earlier.
    let mut second = raw_client::RawClient::connect_setup_only(&host.info)
        .await
        .expect("the proof exchange completes before promotion is refused");
    assert!(
        second.closed_within(Duration::from_secs(3)).await,
        "a connection beyond capacity must be closed"
    );

    // Releasing the first frees the class.
    drop(first);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(mut client) = raw_client::RawClient::connect(&host.info).await {
            let corr = client
                .control(&serde_json::json!({"op": "catalog.list"}))
                .await
                .expect("catalog");
            if client
                .frames_until_corr(corr, Duration::from_secs(2))
                .await
                .is_ok()
            {
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "authenticated capacity must be released"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    host.shutdown_gracefully().await;
}

/// A sustained unauthenticated flood may exhaust only its own class; existing
/// work and shutdown must still make progress (plan U6 scenario 3).
#[tokio::test]
async fn an_unauthenticated_flood_cannot_starve_established_work() {
    let host = TestHost::start_with(|config| {
        config.limits.max_handshakes = 4;
    })
    .await;

    let mut established = host.client().await;
    let (channel, epoch) = established
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "established")
        .await
        .expect("route");

    let flooding = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let info = host.info.clone();
    let flag = flooding.clone();
    let flood = tokio::spawn(async move {
        let mut held = Vec::new();
        while flag.load(std::sync::atomic::Ordering::Relaxed) {
            if let Ok(socket) = raw_client::connect_unauthenticated(&info).await {
                // Never speak: each socket squats a handshake slot until the
                // absolute auth deadline expires.
                held.push(socket);
            }
            if held.len() > 64 {
                held.clear();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });

    // Established routed work still completes under the flood.
    for index in 0..5 {
        let corr = established.next_corr();
        established
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                channel,
                epoch,
                corr,
                &support::echo_body(&format!("under-flood-{index}")),
            )
            .await
            .expect("send");
        let (_, frame) = established
            .frames_until_corr(corr, Duration::from_secs(10))
            .await
            .expect("established work must still complete");
        assert_eq!(frame.ty, TY_RESPONSE);
    }

    // Shutdown still reaches its deadline while the flood continues.
    let handler = host.handler.clone();
    host.shutdown().await.expect("shutdown under flood");
    assert!(handler.handler_dropped());

    flooding.store(false, std::sync::atomic::Ordering::Relaxed);
    let _ = flood.await;
}

/// Ping correlations live in a host-owned namespace, so a numerically equal
/// consumer correlation cannot cross-settle (protocol §8.3, V43).
#[tokio::test]
async fn ping_and_consumer_correlations_do_not_cross_settle() {
    let host = TestHost::start_with(|config| {
        config.liveness = Some(mc_host::LivenessPolicy {
            ping_interval: Duration::from_millis(50),
            pong_deadline: Duration::from_secs(30),
            invalidate_on_missed: false,
        });
    })
    .await;

    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "ping")
        .await
        .expect("route");

    let corr = client.next_corr();
    assert_eq!(corr, 2);
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "hang"})),
        )
        .await
        .expect("send pending request");

    let equal_ping = loop {
        let frame = client.frame_within(BUDGET).await.expect("frame");
        if frame.ty != TY_PING {
            continue;
        }
        client
            .send_frame(TY_PONG, frame.flags, 0, 0, frame.corr, &[])
            .await
            .expect("pong echo");
        if frame.corr == corr {
            break frame;
        }
    };
    assert_eq!(equal_ping.channel, 0);
    assert_eq!(equal_ping.epoch, 0);
    assert_eq!(equal_ping.corr, corr);

    client
        .send_frame(
            support::raw_client::TY_CANCEL,
            FLAGS_PURE_HEADER,
            channel,
            epoch,
            corr,
            &[],
        )
        .await
        .expect("cancel equal-correlation request");
    let (_, frame) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("consumer terminal");
    assert_eq!(frame.error_code(), "cancelled");

    // An unmatched Pong is dropped without disturbing the generation.
    client
        .send_frame(TY_PONG, FLAGS_PURE_HEADER, 0, 0, 999_999, &[])
        .await
        .expect("unmatched pong");
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &support::echo_body("after-unmatched-pong"),
        )
        .await
        .expect("send");
    let (_, frame) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("still serving");
    assert_eq!(frame.ty, TY_RESPONSE);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn liveness_is_disabled_by_default() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "no-ping")
        .await
        .expect("route");

    // With no configured policy the host must not probe at all.
    assert!(
        tokio::time::timeout(Duration::from_millis(500), client.expect_frame())
            .await
            .is_err(),
        "a default host must not send Ping"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn shutdown_drains_admitted_work_then_says_goodbye() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "drain")
        .await
        .expect("route");

    // In-flight work that will be cancelled by the drain.
    let hanging = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            hanging,
            &mode_body(serde_json::json!({"mode": "hang"})),
        )
        .await
        .expect("send hanging");
    let deadline = tokio::time::Instant::now() + BUDGET;
    while host.handler.dispatch_count() == 0 {
        assert!(tokio::time::Instant::now() < deadline, "handler never ran");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let handler = host.handler.clone();
    let shutdown_task = tokio::spawn(async move { host.shutdown().await });

    // The drain terminal arrives while the writer is still live, and the
    // connection Goodbye follows it.
    let frames = client.drain_until_close(Duration::from_secs(15)).await;
    let cancelled = frames
        .iter()
        .position(|frame| frame.corr == hanging)
        .expect("the drain must settle admitted work");
    assert_eq!(frames[cancelled].error_code(), "cancelled");
    let goodbye = frames
        .iter()
        .position(|frame| frame.ty == TY_GOODBYE && frame.channel == 0 && frame.corr == 0);
    if let Some(goodbye) = goodbye {
        assert!(
            cancelled < goodbye,
            "Goodbye must follow drain terminals, or they arrive on a retired generation"
        );
    }

    shutdown_task
        .await
        .expect("shutdown task joins")
        .expect("graceful shutdown");
    assert!(handler.handler_dropped());
    assert_eq!(
        handler.route_gones().len(),
        1,
        "every handler-visible route is cleaned exactly once"
    );
}

#[tokio::test]
async fn shutdown_refuses_new_routes_and_new_routed_work() {
    let host = TestHost::start_with(|config| {
        config.timing.lifecycle_callback_deadline = Duration::from_secs(10);
    })
    .await;
    host.handler.block_route_gone();
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "freeze")
        .await
        .expect("route");

    // Hold the drain open so the frozen-admission window is observable.
    let hanging = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            hanging,
            &mode_body(serde_json::json!({"mode": "hang"})),
        )
        .await
        .expect("send hanging");
    let deadline = tokio::time::Instant::now() + BUDGET;
    while host.handler.dispatch_count() == 0 {
        assert!(tokio::time::Instant::now() < deadline, "handler never ran");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let publication = host.publication_path();
    let handler = host.handler.clone();
    let info = host.info.clone();
    let shutdown_task = tokio::spawn(async move { host.shutdown().await });

    // The fenced unlink happens early in the drain.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while publication.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the publication must be removed during shutdown"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // A new client can no longer discover the host.
    assert!(raw_client::discover(&publication).is_err());
    let _ = info;

    let open_corr = client
        .control(&serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "late"}
        }))
        .await
        .expect("post-freeze route open");
    let (mut seen, open_error) = client
        .frames_until_corr(open_corr, BUDGET)
        .await
        .expect("route-open refusal");
    assert_eq!(open_error.error_code(), "target_unavailable");

    let request_corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            request_corr,
            &support::echo_body("late"),
        )
        .await
        .expect("post-freeze request");
    let (more, request_error) = client
        .frames_until_corr(request_corr, BUDGET)
        .await
        .expect("routed refusal");
    seen.extend(more);
    assert_eq!(request_error.error_code(), "server_busy");

    handler.release_route_gone();
    seen.extend(client.drain_until_close(Duration::from_secs(15)).await);
    assert!(
        seen.iter().any(|frame| frame.corr == hanging),
        "admitted work must receive a terminal"
    );

    shutdown_task
        .await
        .expect("shutdown joins")
        .expect("graceful shutdown");
    assert!(handler.handler_dropped());
}

/// A hung lifecycle callback is host-fatal: shutdown must not report success
/// (plan KTD9, KTD10).
#[tokio::test]
async fn a_panicking_bind_is_cleaned_before_fatal_shutdown() {
    let host = TestHost::start_with(|config| {
        config.timing.lifecycle_callback_deadline = Duration::from_millis(300);
    })
    .await;
    host.handler.set_bind_policy(BindPolicy::Panic);
    let mut client = host.client().await;
    let _ = client
        .control(&serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "panic-bind"}
        }))
        .await
        .expect("route open");

    let handler = host.handler.clone();
    let deadline = tokio::time::Instant::now() + BUDGET;
    while handler.binds().is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "bind never started");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let result = host.shutdown().await;
    assert!(
        matches!(result, Err(mc_host::HostError::LifecycleFatal(_))),
        "expected lifecycle fatal, got {result:?}"
    );
    assert_eq!(handler.binds().len(), 1);
    assert_eq!(
        handler.route_gones(),
        handler.binds(),
        "a bind that observed its handle is still owed route-gone"
    );
}

#[tokio::test]
async fn a_hung_route_gone_callback_is_fatal_rather_than_falsely_graceful() {
    let host = TestHost::start_with(|config| {
        config.timing.lifecycle_callback_deadline = Duration::from_millis(300);
        config.timing.shutdown_deadline = Duration::from_secs(3);
    })
    .await;
    let mut client = host.client().await;
    client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "hang-gone")
        .await
        .expect("route");
    host.handler.hang_route_gone();

    let handler = host.handler.clone();
    let result = host.shutdown().await;
    let err = match result {
        Ok(()) => panic!("a hung route-gone callback must not report graceful shutdown"),
        Err(err) => err,
    };
    assert!(
        matches!(
            err,
            mc_host::HostError::LifecycleFatal(_) | mc_host::HostError::ShutdownDeadlineExpired
        ),
        "expected a fatal shutdown result, got {err}"
    );
    // The handler is still released so no stale state survives the process.
    assert!(handler.handler_dropped());
}

#[tokio::test]
async fn a_panicking_route_gone_callback_is_fatal() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "panic-gone")
        .await
        .expect("route");
    host.handler.panic_route_gone();

    let result = host.shutdown().await;
    assert!(
        matches!(
            result,
            Err(mc_host::HostError::LifecycleFatal(_))
                | Err(mc_host::HostError::ShutdownDeadlineExpired)
        ),
        "a panicking lifecycle callback must be fatal, got {result:?}"
    );
}

#[tokio::test]
async fn a_close_racing_an_in_flight_bind_never_publishes_the_route() {
    let host = TestHost::start().await;
    host.handler.set_bind_policy(BindPolicy::BlockUntilReleased);
    let mut client = host.client().await;

    let corr = client
        .control(&serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "racing"}
        }))
        .await
        .expect("send route.open");
    let _ = corr;

    // Wait until the handler is inside bind, then retire the generation.
    let deadline = tokio::time::Instant::now() + BUDGET;
    while host.handler.binds().is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "bind never started");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    drop(client);
    host.handler.release_bind();

    // Close wins: route-gone still runs exactly once for the observed handle.
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let gones = host.handler.route_gones();
        if gones.len() == 1 {
            assert_eq!(gones, host.handler.binds());
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "route-gone must run once for a bind the close raced, saw {gones:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    host.shutdown_gracefully().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lock_release_follows_route_gone_and_handler_drop() {
    let data_root = tempfile::tempdir().expect("temp root");
    let host = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| {
            config.data_dir = Some(path);
            config.timing.lifecycle_callback_deadline = Duration::from_secs(10);
        }
    })
    .await
    .expect("host publishes");
    let mut client = host.client().await;
    client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "ordered-shutdown")
        .await
        .expect("route");
    host.handler.block_route_gone();
    host.handler.block_handler_drop();
    let handler = host.handler.clone();
    let shutdown = tokio::spawn(async move { host.shutdown().await });
    tokio::time::sleep(Duration::from_millis(100)).await;

    let blocked = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await;
    assert!(
        matches!(blocked, Err(mc_host::HostError::Instance(_))),
        "the lock must remain held while route-gone is blocked"
    );

    handler.release_route_gone();
    let deadline = tokio::time::Instant::now() + BUDGET;
    while !handler.handler_drop_started() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "handler drop never started"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let blocked_during_drop = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await;
    assert!(
        matches!(blocked_during_drop, Err(mc_host::HostError::Instance(_))),
        "the lock must remain held until handler drop completes"
    );
    handler.release_handler_drop();
    shutdown
        .await
        .expect("shutdown task")
        .expect("graceful shutdown");
    let events = handler.events();
    let route_gone = events
        .iter()
        .position(|event| matches!(event, Event::RouteGone(_)))
        .expect("route-gone event");
    let handler_drop = events
        .iter()
        .position(|event| *event == Event::HandlerDropped)
        .expect("handler-drop event");
    assert!(route_gone < handler_drop);

    let successor = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("successor starts after ordered cleanup");
    successor.shutdown_gracefully().await;
}

#[tokio::test]
async fn a_successor_starts_only_after_the_predecessor_releases_its_lock() {
    let data_root = tempfile::tempdir().expect("temp root");
    let first = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("first host publishes");
    let first_info = first.info.clone();

    // A second host against the same runtime directory is refused.
    let blocked = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await;
    assert!(
        matches!(blocked, Err(mc_host::HostError::Instance(_))),
        "a second instance must be refused while the lock is held"
    );

    first.shutdown_gracefully().await;

    // After release, a successor starts with fresh credentials.
    let second = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("successor publishes after the lock is released");
    assert_ne!(
        second.info.key, first_info.key,
        "each incarnation mints a fresh key"
    );
    assert_ne!(
        second.info.daemon_id, first_info.daemon_id,
        "each incarnation mints a fresh daemon ID"
    );

    // Old credentials cannot authenticate against the new incarnation.
    assert!(
        raw_client::RawClient::connect(&first_info).await.is_err(),
        "mixed-generation credentials must fail closed"
    );

    second.shutdown_gracefully().await;
}

#[tokio::test]
async fn shutdown_callback_deadline_expiry_retains_the_handler_until_it_stops() {
    let host = TestHost::start().await;
    host.handler.block_shutdown();
    let handler = host.handler.clone();

    let result = host.shutdown().await;
    assert!(
        matches!(result, Err(HostError::LifecycleFatal(ref message))
            if message.contains("shutdown callback")),
        "an overrunning shutdown callback must be reported as lifecycle-fatal, got {result:?}"
    );
    // The callback is still executing: the handler must stay owned.
    assert!(
        !handler.handler_dropped(),
        "the handler must not drop while its shutdown callback runs"
    );
    assert!(
        handler
            .events()
            .iter()
            .all(|event| *event != Event::Shutdown),
        "the blocked callback has not completed yet"
    );

    handler.release_shutdown();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !handler.handler_dropped() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the handler must drop once the shutdown callback stops"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(handler.events().contains(&Event::Shutdown));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn delayed_lifecycle_callback_runs_shutdown_once_before_successor_starts() {
    let data_root = tempfile::tempdir().expect("temp root");
    let handler = TestHandler::new();
    handler.block_shutdown();
    let route_gone_started = Arc::new(AtomicBool::new(false));
    let route_gone_release = Arc::new((Mutex::new(false), Condvar::new()));
    let shutdown_calls = Arc::new(AtomicUsize::new(0));
    let runtime_handler = DelayedRouteGoneHandler {
        inner: handler.clone(),
        route_gone_started: Arc::clone(&route_gone_started),
        route_gone_release: Arc::clone(&route_gone_release),
        shutdown_calls: Arc::clone(&shutdown_calls),
    };
    let shutdown = mc_host::CancellationToken::new();
    let config = mc_host::HostConfig {
        data_dir: Some(data_root.path().to_path_buf()),
        timing: mc_host::HostTiming {
            shutdown_deadline: Duration::from_millis(100),
            lifecycle_callback_deadline: Duration::from_millis(50),
            ..Default::default()
        },
        ..Default::default()
    };
    let run_shutdown = shutdown.clone();
    let task =
        tokio::spawn(async move { mc_host::run(runtime_handler, config, run_shutdown).await });
    let publication = support::connection_file(data_root.path());
    let deadline = tokio::time::Instant::now() + BUDGET;
    while !publication.exists() {
        assert!(!task.is_finished(), "host exited before publishing");
        assert!(
            tokio::time::Instant::now() < deadline,
            "host did not publish"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let info = raw_client::discover(&publication).expect("publication validates");
    let mut client = raw_client::RawClient::connect(&info)
        .await
        .expect("client authenticates");
    client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "delayed-route-gone")
        .await
        .expect("route");

    shutdown.cancel();
    let deadline = tokio::time::Instant::now() + BUDGET;
    while !route_gone_started.load(Ordering::SeqCst) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "route-gone callback did not start"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let result = tokio::time::timeout(BUDGET, task)
        .await
        .expect("run returns after the lifecycle-chain wait")
        .expect("run task joins");
    assert!(
        matches!(result, Err(HostError::LifecycleFatal(ref message))
            if message.contains("route_gone")),
        "the delayed callback must fail shutdown, got {result:?}"
    );
    assert!(
        handler.route_gones().is_empty(),
        "the callback must still be blocked after both lifecycle waits"
    );
    assert_eq!(
        shutdown_calls.load(Ordering::SeqCst),
        0,
        "handler shutdown must not overlap the lifecycle callback"
    );

    let blocked = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await;
    assert!(
        matches!(blocked, Err(HostError::Instance(_))),
        "the reaper must retain the lock after run returns"
    );

    {
        let (lock, ready) = &*route_gone_release;
        *lock.lock().expect("route-gone release lock") = true;
        ready.notify_all();
    }
    let deadline = tokio::time::Instant::now() + BUDGET;
    while shutdown_calls.load(Ordering::SeqCst) == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "handler shutdown did not start after route-gone drained"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        shutdown_calls.load(Ordering::SeqCst),
        1,
        "handler shutdown must start exactly once"
    );

    let successor =
        assert_lock_released_only_after_shutdown_callback(&handler, data_root.path()).await;
    assert_eq!(
        shutdown_calls.load(Ordering::SeqCst),
        1,
        "handler shutdown must run exactly once"
    );
    assert_eq!(
        handler
            .events()
            .iter()
            .filter(|event| **event == Event::Shutdown)
            .count(),
        1,
        "handler shutdown must complete exactly once"
    );
    successor.shutdown_gracefully().await;
}

/// Asserts the guard ordering shared by every interrupted-incarnation path:
/// the instance lock refuses a successor while the blocked shutdown callback
/// runs, and releases only after that callback completes. Returns the
/// successor host that finally acquired the lock.
async fn assert_lock_released_only_after_shutdown_callback(
    handler: &TestHandler,
    data_root: &std::path::Path,
) -> TestHost {
    // Let the detached cleanup progress to the shutdown callback before
    // observing the held lock.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !handler.events().contains(&Event::Shutdown),
        "the blocked shutdown callback has not completed"
    );
    let blocked = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await;
    assert!(
        matches!(blocked, Err(HostError::Instance(_))),
        "the lock must stay held while the shutdown callback runs"
    );

    handler.release_shutdown();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let attempt = TestHost::try_start_with(TestHandler::new(), {
            let path = data_root.to_path_buf();
            move |config| config.data_dir = Some(path)
        })
        .await;
        if let Ok(successor) = attempt {
            assert!(
                handler.events().contains(&Event::Shutdown),
                "the shutdown callback completes before the lock releases"
            );
            return successor;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the lock must release once the shutdown callback stops"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// An abandoned `run` future (supervisor abort, not a shutdown signal) must
/// still run the handler shutdown callback: component-owned work is only
/// stopped and drained by `shutdown`, and the instance lock must not release
/// beside it.
#[tokio::test]
async fn an_abandoned_run_future_runs_the_shutdown_callback_before_lock_release() {
    let data_root = tempfile::tempdir().expect("temp root");
    let handler = TestHandler::new();
    handler.block_shutdown();
    let shutdown = mc_host::CancellationToken::new();
    let config = mc_host::HostConfig {
        data_dir: Some(data_root.path().to_path_buf()),
        ..Default::default()
    };
    let run_handler = handler.clone();
    let run_shutdown = shutdown.clone();
    let task = tokio::spawn(async move { mc_host::run(run_handler, config, run_shutdown).await });
    let publication = support::connection_file(data_root.path());
    let deadline = tokio::time::Instant::now() + BUDGET;
    while !publication.exists() {
        assert!(!task.is_finished(), "host exited before publishing");
        assert!(
            tokio::time::Instant::now() < deadline,
            "host did not publish"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // Abandon the run future outright; the forced cleanup owns the instance
    // guard from here.
    task.abort();
    assert!(
        task.await.is_err(),
        "the aborted run future cannot complete"
    );

    let successor =
        assert_lock_released_only_after_shutdown_callback(&handler, data_root.path()).await;
    assert_eq!(
        handler
            .events()
            .iter()
            .filter(|event| **event == Event::Shutdown)
            .count(),
        1,
        "the abandoned incarnation runs its shutdown callback exactly once"
    );
    successor.shutdown_gracefully().await;
}

/// A shutdown request during initialization aborts the callback, and the
/// detached reaper then runs the handler shutdown callback before releasing
/// the lock: an interrupted initialize can already have handed work to
/// component-owned trackers that only `shutdown` drains.
#[tokio::test]
async fn shutdown_during_initialization_runs_the_shutdown_callback_before_lock_release() {
    let data_root = tempfile::tempdir().expect("temp root");
    let handler = TestHandler::new();
    handler.block_init();
    handler.block_shutdown();
    let shutdown = mc_host::CancellationToken::new();
    let config = mc_host::HostConfig {
        data_dir: Some(data_root.path().to_path_buf()),
        ..Default::default()
    };
    let run_handler = handler.clone();
    let run_shutdown = shutdown.clone();
    let task = tokio::spawn(async move { mc_host::run(run_handler, config, run_shutdown).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    shutdown.cancel();
    let result = task.await.expect("run task joins");
    assert!(
        matches!(result, Err(HostError::InitFailed(_))),
        "shutdown during initialization fails startup, got {result:?}"
    );

    let successor =
        assert_lock_released_only_after_shutdown_callback(&handler, data_root.path()).await;
    assert!(
        !handler.events().contains(&Event::Initialized),
        "the aborted initialize must not complete detached"
    );
    successor.shutdown_gracefully().await;
}

/// The initialize-deadline path takes the same reaper as shutdown-during-init:
/// the shutdown callback runs and the lock outlives it.
#[tokio::test]
async fn initialization_deadline_expiry_runs_the_shutdown_callback_before_lock_release() {
    let data_root = tempfile::tempdir().expect("temp root");
    let handler = TestHandler::new();
    handler.block_init();
    handler.block_shutdown();
    let config = mc_host::HostConfig {
        data_dir: Some(data_root.path().to_path_buf()),
        timing: mc_host::HostTiming {
            lifecycle_callback_deadline: Duration::from_millis(50),
            ..Default::default()
        },
        ..Default::default()
    };
    let result = mc_host::run(handler.clone(), config, mc_host::CancellationToken::new()).await;
    assert!(
        matches!(result, Err(HostError::InitFailed(_))),
        "an initialize deadline expiry fails startup, got {result:?}"
    );

    let successor =
        assert_lock_released_only_after_shutdown_callback(&handler, data_root.path()).await;
    assert!(
        !handler.events().contains(&Event::Initialized),
        "the aborted initialize must not complete detached"
    );
    successor.shutdown_gracefully().await;
}

/// An initialization that *returns* a failure still drains the handler: a
/// composite's primary can have initialized before its secondary failed, and
/// only the shutdown callback stops that work. The callback is awaited inside
/// `run`, so the instance lock — released when `run` returns — cannot free
/// while handler-owned work is still live.
#[tokio::test]
async fn a_failed_initialization_runs_the_shutdown_callback_before_lock_release() {
    let data_root = tempfile::tempdir().expect("temp root");
    let handler = TestHandler::new();
    handler.fail_init("secondary component failed to initialize");
    handler.block_shutdown();
    let config = mc_host::HostConfig {
        data_dir: Some(data_root.path().to_path_buf()),
        ..Default::default()
    };
    let run_handler = handler.clone();
    let mut task = tokio::spawn(async move {
        mc_host::run(run_handler, config, mc_host::CancellationToken::new()).await
    });

    // While the shutdown callback is blocked, startup has not returned and the
    // lock is still held against a successor.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut task)
            .await
            .is_err(),
        "startup must not return while the shutdown callback runs"
    );
    let blocked = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await;
    assert!(
        matches!(blocked, Err(HostError::Instance(_))),
        "the lock must stay held while the shutdown callback runs"
    );

    handler.release_shutdown();
    let result = task.await.expect("run task joins");
    assert!(
        matches!(result, Err(HostError::InitFailed(_))),
        "a failed initialize fails startup, got {result:?}"
    );
    assert!(
        handler.events().contains(&Event::Shutdown),
        "the shutdown callback drains the handler on the init-failure path"
    );
    assert!(
        !handler.events().contains(&Event::Initialized),
        "the failing initialize never reports success"
    );

    let successor = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("the lock releases once startup returns");
    successor.shutdown_gracefully().await;
}

#[tokio::test]
async fn aborting_failed_initialization_cleanup_retains_lock_until_shutdown_stops() {
    let data_root = tempfile::tempdir().expect("temp root");
    let handler = TestHandler::new();
    handler.fail_init("secondary component failed to initialize");
    handler.block_shutdown();
    let config = mc_host::HostConfig {
        data_dir: Some(data_root.path().to_path_buf()),
        ..Default::default()
    };
    let run_handler = handler.clone();
    let mut task = tokio::spawn(async move {
        mc_host::run(run_handler, config, mc_host::CancellationToken::new()).await
    });

    // Initialization returns immediately, so a pending startup is waiting for
    // the blocked shutdown callback before returning its original error.
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut task)
            .await
            .is_err(),
        "startup must wait for the shutdown callback"
    );
    task.abort();
    assert!(task.await.is_err(), "the run task was aborted");

    let successor =
        assert_lock_released_only_after_shutdown_callback(&handler, data_root.path()).await;
    assert_eq!(
        handler
            .events()
            .iter()
            .filter(|event| **event == Event::Shutdown)
            .count(),
        1,
        "aborting cleanup must not invoke shutdown twice"
    );
    successor.shutdown_gracefully().await;
}

/// A setup failure *after* a successful initialize drains the handler too:
/// publication is the last step before the host owns cleanup, and an
/// initialized handler can already hold stores or background work that only
/// the shutdown callback stops.
#[tokio::test]
async fn a_publication_failure_runs_the_shutdown_callback_before_lock_release() {
    let data_root = tempfile::tempdir().expect("temp root");
    let handler = TestHandler::new();
    // Initialize blocks so the runtime directory can be removed after the
    // instance lock exists but before publication writes the connection file.
    handler.block_init();
    let config = mc_host::HostConfig {
        data_dir: Some(data_root.path().to_path_buf()),
        ..Default::default()
    };
    let run_handler = handler.clone();
    let task = tokio::spawn(async move {
        mc_host::run(run_handler, config, mc_host::CancellationToken::new()).await
    });

    tokio::time::sleep(Duration::from_millis(150)).await;
    let host_dir = data_root.path().join("cortexkit").join("run");
    // The directory holds the starting lifecycle record; removing the whole
    // tree still makes the publication write fail.
    std::fs::remove_dir_all(&host_dir).expect("remove runtime directory");
    handler.release_init();

    let result = task.await.expect("run task joins");

    assert!(
        matches!(result, Err(HostError::Io(ref error)) if error.kind() == std::io::ErrorKind::NotFound),
        "a removed runtime directory fails setup before publication, got {result:?}"
    );
    assert!(
        handler.events().contains(&Event::Initialized),
        "initialization completed before publication was attempted"
    );
    assert!(
        handler.events().contains(&Event::Shutdown),
        "the shutdown callback drains the handler on a post-initialize setup failure"
    );
}

// --- host.shutdown and lifecycle evidence (plan U1) ---

/// One authenticated `host.shutdown`: the correlated success response is
/// fully observed before Goodbye/EOF, the run completes gracefully, and the
/// runtime directory holds neither publication nor lifecycle record.
#[tokio::test]
async fn host_shutdown_commits_after_the_full_response_and_stops_gracefully() {
    let host = TestHost::start().await;
    let publication = host.publication_path();
    let record = host.runtime_dir().join(mc_host::LIFECYCLE_RECORD_NAME);
    assert!(record.exists(), "a running host keeps a lifecycle record");

    let mut client = host.client().await;
    let corr = client
        .control(&serde_json::json!({"op": "host.shutdown"}))
        .await
        .expect("send shutdown");
    let (skipped, response) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("shutdown response");
    assert!(
        skipped
            .iter()
            .all(|frame| frame.ty == TY_PING || frame.ty == TY_GOODBYE),
        "no other terminal may precede the shutdown response: {skipped:?}"
    );
    assert_eq!(response.ty, TY_RESPONSE);
    assert_eq!(response.json()["op"], "host.shutdown");

    let trailing = client.drain_until_close(BUDGET).await;
    assert!(
        trailing.iter().any(|frame| frame.ty == TY_GOODBYE),
        "the drain still sends a connection Goodbye after the response: {trailing:?}"
    );

    let handler = host.handler.clone();
    host.shutdown().await.expect("graceful shutdown");
    assert!(handler.events().contains(&Event::Shutdown));
    assert!(!publication.exists(), "publication removed by its owner");
    assert!(!record.exists(), "lifecycle record removed under the lock");
}

/// Two connections race `host.shutdown`: each correlation settles exactly
/// once with a parseable response, and the host cancels once.
#[tokio::test]
async fn concurrent_shutdown_requests_each_settle_exactly_once() {
    let host = TestHost::start().await;
    let mut first = host.client().await;
    let mut second = host.client().await;

    let first_corr = first
        .control(&serde_json::json!({"op": "host.shutdown"}))
        .await
        .expect("first shutdown");
    let second_corr = second
        .control(&serde_json::json!({"op": "host.shutdown"}))
        .await
        .expect("second shutdown");

    // Each request correlation must receive exactly one non-ping terminal.
    for (client, corr) in [(&mut first, first_corr), (&mut second, second_corr)] {
        let (skipped, response) = client
            .frames_until_corr(corr, BUDGET)
            .await
            .expect("each requester settles");
        assert_eq!(response.ty, TY_RESPONSE);
        assert_eq!(response.json()["op"], "host.shutdown");
        let trailing = client.drain_until_close(BUDGET).await;
        let duplicates = skipped
            .iter()
            .chain(trailing.iter())
            .filter(|frame| frame.corr == corr && frame.ty != TY_PING)
            .count();
        assert_eq!(
            duplicates, 0,
            "duplicate settlement: {skipped:?} {trailing:?}"
        );
    }

    let handler = host.handler.clone();
    host.shutdown().await.expect("graceful shutdown");
    assert_eq!(
        handler
            .events()
            .iter()
            .filter(|event| **event == Event::Shutdown)
            .count(),
        1,
        "cancellation and handler shutdown fire once per incarnation"
    );
}

/// A requester that dies right after sending `host.shutdown` cannot strand
/// the stop: whether its attempt committed or reopened, either the host is
/// already stopping or a later authenticated requester completes the stop.
#[tokio::test]
async fn a_dying_requester_cannot_strand_the_stop() {
    let host = TestHost::start().await;
    let mut first = host.client().await;
    first
        .control(&serde_json::json!({"op": "host.shutdown"}))
        .await
        .expect("send shutdown");
    // Abrupt close: the response write may succeed (commit) or fail and
    // reopen ownership.
    drop(first);
    tokio::time::sleep(Duration::from_millis(50)).await;

    if let Ok(mut second) = raw_client::RawClient::connect(&host.info).await {
        if let Ok(corr) = second
            .control(&serde_json::json!({"op": "host.shutdown"}))
            .await
        {
            // A reopened latch must let this requester commit; a committed
            // one answers success. A generation retired mid-drain may close
            // without the frame, which the wire-initiated stop proven below
            // still shows was a completed stop.
            let _ = second.frames_until_corr(corr, BUDGET).await;
        }
    }

    // The second interaction above is fallible only because a committed
    // first attempt may already be tearing the host down. Whichever branch
    // ran, the WIRE must have initiated the stop: the handler observes its
    // shutdown before the direct cancellation below, which would otherwise
    // mask a stranded stop (a failed connect against a healthy host).
    let deadline = tokio::time::Instant::now() + BUDGET;
    while !host.handler.events().contains(&Event::Shutdown) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "wire-initiated shutdown never happened: the dying requester's \
             attempt did not commit and no successor completed the stop"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn pipelined_shutdown_requests_on_one_connection_both_settle() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let body = br#"{"op":"host.shutdown"}"#;
    let first = client.next_corr();
    let second = client.next_corr();
    let mut wire = raw_client::header(
        body.len() as u32,
        TY_REQUEST,
        FLAGS_INTERACTIVE,
        0,
        0,
        first,
    );
    wire.extend_from_slice(body);
    wire.extend_from_slice(&raw_client::header(
        body.len() as u32,
        TY_REQUEST,
        FLAGS_INTERACTIVE,
        0,
        0,
        second,
    ));
    wire.extend_from_slice(body);
    client.send_raw(&wire).await.expect("pipeline shutdowns");

    // The host answers pipelined control requests from concurrent tasks, so the
    // two responses arrive in either order. `frames_until_corr` hands back the
    // frames it consumed while searching, and those are the only copy: asking
    // for `second` sequentially after its response was already consumed would
    // wait out the whole budget.
    let (consumed, first_response) = client
        .frames_until_corr(first, BUDGET)
        .await
        .expect("shutdown response");
    let second_response = match consumed
        .into_iter()
        .find(|frame| frame.corr == second && frame.ty != TY_PING)
    {
        Some(frame) => frame,
        None => {
            client
                .frames_until_corr(second, BUDGET)
                .await
                .expect("shutdown response")
                .1
        }
    };
    for response in [first_response, second_response] {
        assert_eq!(response.ty, TY_RESPONSE);
        assert_eq!(response.json()["op"], "host.shutdown");
    }
    host.shutdown().await.expect("graceful shutdown");
}

/// Key possession is the whole authorization: every role label gets the same
/// shutdown capability, so no supported key reader is read-only (plan R33).
#[tokio::test]
async fn any_role_with_the_bearer_key_can_shut_down() {
    for role in ["client", "diagnostic-readonly"] {
        let host = TestHost::start().await;
        let mut client = raw_client::RawClient::connect_with_role(&host.info, role)
            .await
            .expect("authenticated connection");
        let corr = client
            .control(&serde_json::json!({"op": "host.shutdown"}))
            .await
            .expect("send shutdown");
        let (_skipped, response) = client
            .frames_until_corr(corr, BUDGET)
            .await
            .expect("shutdown response");
        assert_eq!(response.ty, TY_RESPONSE, "role {role} must be stop-capable");
        host.shutdown().await.expect("graceful shutdown");
    }
}

/// Without the bearer key no shutdown is possible, and malformed shutdown
/// shapes are rejected without stopping the host.
#[tokio::test]
async fn shutdown_requires_authentication_and_a_valid_shape() {
    let host = TestHost::start().await;

    // Unauthenticated socket: no envelope is ever read or written back.
    let mut raw = raw_client::connect_unauthenticated(&host.info)
        .await
        .expect("setup socket connect");
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let frame = {
        let body = br#"{"op":"host.shutdown"}"#;
        let mut wire = raw_client::header(
            body.len() as u32,
            raw_client::TY_REQUEST,
            raw_client::FLAGS_INTERACTIVE,
            0,
            0,
            1,
        );
        wire.extend_from_slice(body);
        wire
    };
    let _ = raw.write_all(&frame).await;
    let mut byte = [0u8; 1];
    let read = tokio::time::timeout(BUDGET, raw.read(&mut byte))
        .await
        .expect("the failed handshake closes within its deadline");
    assert!(
        matches!(read, Ok(0))
            || matches!(read, Err(ref error) if error.kind() == std::io::ErrorKind::ConnectionReset),
        "no byte may reach an unauthenticated socket: {read:?}"
    );
    drop(raw);

    // Authenticated but malformed: binary flag on channel 0.
    let mut client = host.client().await;
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE | 0b0000_0001,
            0,
            0,
            corr,
            br#"{"op":"host.shutdown"}"#,
        )
        .await
        .expect("send binary control");
    let (_skipped, rejection) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("rejection");
    assert_eq!(rejection.error_code(), "invalid_control_request");

    // The host is still serving: a catalog request round-trips.
    let catalog_corr = client
        .control(&serde_json::json!({"op": "catalog.list"}))
        .await
        .expect("catalog");
    let (_skipped, catalog) = client
        .frames_until_corr(catalog_corr, BUDGET)
        .await
        .expect("catalog response");
    assert_eq!(catalog.ty, TY_RESPONSE);

    host.shutdown_gracefully().await;
}

/// The native probe tracks one incarnation end to end: running while the
/// host serves, stopped once it exits, and never by PID.
#[tokio::test]
async fn probe_observes_running_then_stopped_across_an_incarnation() {
    let host = TestHost::start().await;
    let data_root = host.data_root.path().to_path_buf();

    let observed = mc_host::probe_lifecycle(Some(&data_root), &mc_host::ProbeFreshness::default())
        .expect("probe while running");
    assert_eq!(observed.state, mc_host::LifecycleState::Running);
    assert!(!observed.instance_lock_free);
    let summary = observed.publication.expect("publication summary");
    assert!(std::path::Path::new(&summary.setup_socket).is_absolute());

    // Stop through the authenticated wire operation, then reprobe.
    let mut client = host.client().await;
    let corr = client
        .control(&serde_json::json!({"op": "host.shutdown"}))
        .await
        .expect("send shutdown");
    let (_skipped, response) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("shutdown response");
    assert_eq!(response.ty, TY_RESPONSE);
    host.shutdown().await.expect("graceful shutdown");

    let observed = mc_host::probe_lifecycle(Some(&data_root), &mc_host::ProbeFreshness::default())
        .expect("probe after stop");
    assert_eq!(observed.state, mc_host::LifecycleState::Stopped);
    assert!(observed.instance_lock_free);
    assert!(
        observed.publication.is_none(),
        "no stale publication remains"
    );
}

// --- stable coordination fences (plan U1) ---

/// Replacing the whole managed `cortexkit` subtree while a host serves leaves
/// its descriptor-owned evidence isolated, but the stable lifetime fence still
/// names the live incarnation: probes report `wedged`, never `stopped`, and a
/// successor cannot start until the first daemon fully tears down.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replaced_cortexkit_subtree_cannot_admit_an_overlapping_incarnation() {
    let data_root = tempfile::tempdir().expect("temp root");
    let host = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("host publishes");

    let cortexkit = data_root.path().join("cortexkit");
    std::fs::rename(&cortexkit, data_root.path().join("cortexkit-old"))
        .expect("replace the managed subtree");

    let root = data_root.path().to_path_buf();
    let observed = tokio::task::spawn_blocking({
        let root = root.clone();
        move || mc_host::probe_lifecycle(Some(&root), &mc_host::ProbeFreshness::default())
    })
    .await
    .expect("probe task")
    .expect("probe");
    assert_eq!(
        observed.state,
        mc_host::LifecycleState::Wedged,
        "a displaced live incarnation must not read as stopped: {}",
        observed.reason
    );
    assert!(!observed.lifetime_lock_free);

    let blocked = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await;
    assert!(
        matches!(
            blocked,
            Err(HostError::Instance(mc_host::InstanceError::AlreadyRunning))
        ),
        "the lifetime fence must refuse a successor while the first host lives, \
         and must do so because the fence is held"
    );

    host.shutdown().await.expect("graceful shutdown");

    // Teardown released both fences: a successor starts in the same root.
    let successor = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("successor starts after the displaced host tears down");
    successor.shutdown_gracefully().await;
}

/// Mixed-release coordination: every incarnation locks the same never-renamed
/// coordination inodes, so two independent openers — a stand-in for release N
/// and N-1 — contend on one lock instead of splitting ownership.
#[tokio::test]
async fn successive_incarnations_lock_the_same_coordination_inodes() {
    use std::os::unix::fs::MetadataExt;

    let data_root = tempfile::tempdir().expect("temp root");
    let coordination = data_root
        .path()
        .join(mc_host::COORDINATION_DIR_NAME)
        .join(mc_host::LIFETIME_LOCK_NAME);

    let first = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("first host publishes");
    let meta = std::fs::symlink_metadata(&coordination).expect("lifetime.lock exists");
    assert!(meta.file_type().is_file());
    let identity = (meta.dev(), meta.ino());
    first.shutdown_gracefully().await;

    let second = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("second host publishes");
    let meta = std::fs::symlink_metadata(&coordination).expect("lifetime.lock still exists");
    assert_eq!(
        (meta.dev(), meta.ino()),
        identity,
        "supported code must never replace the coordination lock inode"
    );
    second.shutdown_gracefully().await;
}
