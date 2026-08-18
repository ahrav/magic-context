//! Admission capacity, internal health, liveness, and shutdown ordering.

mod support;

use std::time::Duration;

use support::raw_client::{
    self, FLAGS_INTERACTIVE, FLAGS_PURE_HEADER, TY_GOODBYE, TY_PING, TY_PONG, TY_REQUEST,
    TY_RESPONSE,
};
use support::{mode_body, BindPolicy, Event, TestHandler, TestHost, LINKED_MODULE_ID};

const BUDGET: Duration = Duration::from_secs(5);
const ROOT: &str = "/workspace/project";

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
    let mut second = raw_client::RawClient::connect(&host.info)
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

    // route_open consumes correlation 1; the test leaves correlation 2
    // pending until the host sends Ping correlation 2.
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
