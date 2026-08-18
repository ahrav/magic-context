//! Whole-profile composition over real loopback: discovery, authentication,
//! catalog, routes, unary and streamed requests, cancellation, Goodbye,
//! restart, and graceful shutdown, driven by the independent raw client.
//! Failure-path coverage lives in the focused suites; this file proves the
//! pieces compose.

mod support;

use std::time::Duration;

use support::raw_client::{
    self, FLAGS_INTERACTIVE, FLAGS_PURE_HEADER, TY_CANCEL, TY_GOODBYE, TY_REQUEST, TY_RESPONSE,
    TY_STREAM_DATA, TY_STREAM_END,
};
use support::{mode_body, TestHandler, TestHost, LINKED_MODULE_ID};

const BUDGET: Duration = Duration::from_secs(5);
const ROOT: &str = "/workspace/project";

#[tokio::test]
async fn the_full_profile_composes_over_one_connection() {
    let host = TestHost::start().await;

    // Discovery: the raw client validates the publication itself.
    let info = raw_client::discover(&host.publication_path()).expect("discovery");
    let mut client = raw_client::RawClient::connect(&info)
        .await
        .expect("three-message authentication");

    // Catalog.
    let corr = client
        .control(&serde_json::json!({"op": "catalog.list"}))
        .await
        .expect("catalog");
    let frame = client.frame_within(BUDGET).await.expect("catalog reply");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.json()["modules"][0]["module_id"], LINKED_MODULE_ID);

    // Route.
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "roundtrip")
        .await
        .expect("route");

    // Unary echo.
    let corr = client.next_corr();
    let body = support::echo_body("roundtrip-unary");
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, channel, epoch, corr, &body)
        .await
        .expect("send unary");
    let frame = client.frame_within(BUDGET).await.expect("unary terminal");
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.body, body);

    // Stream.
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "stream", "items": 3})),
        )
        .await
        .expect("send stream");
    let mut data_frames = 0;
    loop {
        let frame = client.frame_within(BUDGET).await.expect("stream frame");
        assert_eq!(frame.corr, corr);
        match frame.ty {
            TY_STREAM_DATA => data_frames += 1,
            TY_STREAM_END => break,
            other => panic!("unexpected frame type {other} in stream"),
        }
    }
    assert_eq!(data_frames, 3);

    // Cancel.
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "await_cancel"})),
        )
        .await
        .expect("send cancellable");
    client
        .send_frame(TY_CANCEL, FLAGS_PURE_HEADER, channel, epoch, corr, &[])
        .await
        .expect("cancel");
    let (_, frame) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("cancel terminal");
    assert_eq!(frame.error_code(), "cancelled");

    // Route Goodbye, then connection Goodbye.
    client
        .send_frame(TY_GOODBYE, FLAGS_PURE_HEADER, channel, epoch, 0, &[])
        .await
        .expect("route goodbye");
    client
        .send_frame(TY_GOODBYE, FLAGS_PURE_HEADER, 0, 0, 0, &[])
        .await
        .expect("connection goodbye");
    assert!(
        client.closed_within(BUDGET).await,
        "a connection Goodbye retires the generation"
    );

    // The handler saw exactly one bind and one route-gone for the route.
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let gones = host.handler.route_gones();
        if gones.len() == 1 {
            assert_eq!(gones, host.handler.binds());
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "route-gone missing");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let publication = host.publication_path();
    let runtime_dir = host.runtime_dir();
    let handler = host.handler.clone();
    host.shutdown_gracefully().await;

    // Post-lifecycle audit: no publication, no temp file, handler dropped.
    assert!(!publication.exists());
    let leftovers: Vec<_> = std::fs::read_dir(&runtime_dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    assert!(
        leftovers.is_empty(),
        "the runtime directory must hold no residue: {leftovers:?}"
    );
    assert!(handler.handler_dropped());
}

#[tokio::test]
async fn restart_rotates_credentials_and_invalidates_old_state() {
    let data_root = tempfile::tempdir().expect("temp root");
    let first = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("first incarnation");
    let old_info = first.info.clone();

    // Live state on the first incarnation.
    let mut old_client = first.client().await;
    let (old_channel, old_epoch) = old_client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "old")
        .await
        .expect("old route");

    first.shutdown_gracefully().await;

    let second = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("second incarnation");

    // Fresh credentials.
    assert_ne!(second.info.key, old_info.key);
    assert_ne!(second.info.daemon_id, old_info.daemon_id);

    // The old key cannot authenticate: the server proof is minted for a
    // daemon ID the stale snapshot does not carry.
    let stale = raw_client::Discovered {
        port: second.info.port,
        ..old_info.clone()
    };
    assert!(
        raw_client::RawClient::connect(&stale).await.is_err(),
        "mixed-generation credentials must fail closed"
    );

    // Old route handles and correlations are meaningless to the successor.
    let mut new_client = second.client().await;
    let corr = new_client.next_corr();
    new_client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            old_channel,
            old_epoch,
            corr,
            &support::echo_body("stale-handle"),
        )
        .await
        .expect("send stale");
    let frame = new_client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "unknown_channel");
    assert_eq!(second.handler.dispatch_count(), 0);

    second.shutdown_gracefully().await;
}

#[tokio::test]
async fn concurrent_clients_settle_independently() {
    let host = TestHost::start().await;
    let clients = 4usize;
    let requests_per_client = 8usize;

    let mut tasks = Vec::new();
    for client_index in 0..clients {
        let info = host.info.clone();
        tasks.push(tokio::spawn(async move {
            let mut client = raw_client::RawClient::connect(&info)
                .await
                .expect("authenticate");
            let (channel, epoch) = client
                .route_open(
                    LINKED_MODULE_ID,
                    ROOT,
                    "opencode",
                    &format!("client-{client_index}"),
                )
                .await
                .expect("route");
            for request_index in 0..requests_per_client {
                let corr = client.next_corr();
                let payload = format!("client-{client_index}-request-{request_index}");
                let body = support::echo_body(&payload);
                client
                    .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, channel, epoch, corr, &body)
                    .await
                    .expect("send");
                let (_, frame) = client
                    .frames_until_corr(corr, Duration::from_secs(10))
                    .await
                    .expect("terminal");
                assert_eq!(frame.ty, TY_RESPONSE);
                assert_eq!(
                    frame.body, body,
                    "a terminal must settle only its own generation's request"
                );
            }
            channel
        }));
    }

    let mut channels = std::collections::HashSet::new();
    for task in tasks {
        let channel = task.await.expect("client task");
        assert!(
            channels.insert(channel),
            "live channels must be globally unique"
        );
    }
    assert_eq!(
        host.handler.dispatch_count(),
        clients * requests_per_client,
        "every request dispatched exactly once"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn degraded_storage_is_an_application_error_not_a_disconnect() {
    let host = TestHost::start().await;
    host.handler
        .set_health(mc_host::HealthStatus::Degraded, Some("store opening"));
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "degraded")
        .await
        .expect("bind works while degraded");

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
                "message": "opening"
            })),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "store_unavailable");

    // Same connection, later request: no reconnect was required.
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &support::echo_body("after-degraded"),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.ty, TY_RESPONSE);

    host.shutdown_gracefully().await;
}
