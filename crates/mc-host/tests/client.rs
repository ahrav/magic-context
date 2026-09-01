mod support;

use std::{path::PathBuf, time::Duration};

use mc_host::{
    Client, LivenessPolicy, RequestOptions, RouteIdentity, RouteTarget, SendOutcome, TargetKind,
};
use support::{mode_body, TestHost, LINKED_MODULE_ID};

fn target() -> RouteTarget {
    RouteTarget {
        module_id: LINKED_MODULE_ID.to_owned(),
        kind: TargetKind::ToolProvider,
    }
}

fn identity(session: &str) -> RouteIdentity {
    RouteIdentity {
        project_root: PathBuf::from("/tmp/mc-host-client-test"),
        harness: "client-test".to_owned(),
        session: session.to_owned(),
        consumer_module_id: None,
        consumer_launch_nonce: None,
        consumer_capabilities: Vec::new(),
        admission_facts: None,
        credential_fingerprints: std::collections::BTreeMap::new(),
    }
}

#[tokio::test]
async fn authenticates_attaches_ring_routes_unary_and_closes() {
    let host = TestHost::start().await;
    let publication: serde_json::Value =
        serde_json::from_slice(&std::fs::read(host.publication_path()).unwrap()).unwrap();
    assert!(publication.get("setup_socket").is_some());
    assert!(publication.get("endpoints").is_none());

    let client = Client::connect(host.publication_path())
        .await
        .expect("managed client attaches the mandatory ring");
    assert_eq!(
        client.daemon_id().as_slice(),
        host.info.daemon_id.as_slice()
    );
    let route = client
        .open_route(target(), identity("happy"))
        .await
        .expect("route opens");
    let body = mode_body(serde_json::json!({"mode": "echo", "value": 7}));
    let response = client
        .request(route, body.clone(), RequestOptions::default())
        .await
        .expect("unary response");
    assert_eq!(response.body, body);

    client.close_route(route).await.expect("route closes");
    client.close().await.expect("client closes");
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn ring_stream_and_control_traffic_share_one_live_generation() {
    let host = TestHost::start_with(|config| {
        config.liveness = Some(LivenessPolicy {
            ping_interval: Duration::from_millis(20),
            pong_deadline: Duration::from_millis(80),
            invalidate_on_missed: true,
        });
    })
    .await;
    let client = Client::connect(host.publication_path()).await.unwrap();
    let route = client
        .open_route(target(), identity("stream-ping"))
        .await
        .unwrap();
    let mut stream = client
        .request_stream(
            route,
            mode_body(serde_json::json!({"mode": "stream_then_hang", "items": 2})),
            RequestOptions {
                timeout: Duration::from_secs(2),
                cancellation: None,
            },
        )
        .await
        .unwrap();

    for expected in 0..2 {
        let item = stream.next().await.unwrap().expect("stream item");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&item.body).unwrap()["item"],
            expected
        );
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    let body = mode_body(serde_json::json!({"mode": "echo", "value": "unrelated"}));
    assert_eq!(
        client
            .request(route, body.clone(), RequestOptions::default())
            .await
            .expect("Ping/Pong and stream traffic do not block unary")
            .body,
        body
    );
    stream.cancel().expect("stream cancellation");
    client.close().await.unwrap();
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn ring_terminal_is_typed_redacted_and_generation_remains_usable() {
    let host = TestHost::start().await;
    let client = Client::connect(host.publication_path()).await.unwrap();
    let route = client
        .open_route(target(), identity("terminal"))
        .await
        .unwrap();
    let sentinel = "CANARY-TERMINAL-BODY-7f31";
    let error = client
        .request(
            route,
            mode_body(serde_json::json!({
                "mode": "error",
                "code": "stable_failure",
                "message": sentinel
            })),
            RequestOptions::default(),
        )
        .await
        .expect_err("host returns Error terminal");
    assert_eq!(error.outcome(), SendOutcome::Terminal);
    assert_eq!(error.code(), "stable_failure");
    assert!(!format!("{error:?} {error}").contains(sentinel));

    let body = mode_body(serde_json::json!({"mode": "echo", "after": "error"}));
    assert_eq!(
        client
            .request(route, body.clone(), RequestOptions::default())
            .await
            .expect("terminal is correlation-scoped")
            .body,
        body
    );
    client.close().await.unwrap();
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn caller_cancellation_is_correlation_scoped() {
    let host = TestHost::start().await;
    let client = Client::connect(host.publication_path()).await.unwrap();
    let route = client
        .open_route(target(), identity("cancel"))
        .await
        .unwrap();
    let cancel = mc_host::CancellationToken::new();
    let trigger = cancel.clone();
    let request = client.request(
        route,
        mode_body(serde_json::json!({"mode": "await_cancel"})),
        RequestOptions {
            timeout: Duration::from_secs(2),
            cancellation: Some(cancel),
        },
    );
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        trigger.cancel();
    });
    let error = request.await.expect_err("caller cancellation wins");
    assert!(matches!(
        error.outcome(),
        SendOutcome::NotSent | SendOutcome::OutcomeUnknown
    ));

    let body = mode_body(serde_json::json!({"mode": "echo", "after": "cancel"}));
    let response = client
        .request(route, body.clone(), RequestOptions::default())
        .await
        .expect("later request remains independent");
    assert_eq!(response.body, body);

    client.close().await.unwrap();
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn request_deadline_is_one_absolute_owner_and_honors_overrides() {
    let host = TestHost::start().await;
    let client = Client::connect(host.publication_path()).await.unwrap();
    let route = client
        .open_route(target(), identity("deadline"))
        .await
        .unwrap();

    let error = client
        .request(
            route,
            mode_body(serde_json::json!({"mode": "slow", "ms": 100})),
            RequestOptions {
                timeout: Duration::from_millis(20),
                cancellation: None,
            },
        )
        .await
        .expect_err("short caller deadline wins");
    assert_eq!(error.outcome(), SendOutcome::OutcomeUnknown);
    assert_eq!(error.code(), "deadline_expired");

    let response = client
        .request(
            route,
            mode_body(serde_json::json!({"mode": "slow", "ms": 20})),
            RequestOptions {
                timeout: Duration::from_millis(200),
                cancellation: None,
            },
        )
        .await
        .expect("longer caller deadline is honored");
    assert_eq!(response.body, b"slow-done");

    client.close().await.unwrap();
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn close_rejects_new_sends() {
    let host = TestHost::start().await;
    let client = Client::connect(host.publication_path()).await.unwrap();
    let route = client
        .open_route(target(), identity("close"))
        .await
        .unwrap();
    client.close().await.unwrap();
    let error = client
        .request(route, b"after-close".to_vec(), RequestOptions::default())
        .await
        .expect_err("closed client rejects sends");
    assert_eq!(error.outcome(), SendOutcome::NotSent);
    assert_eq!(error.code(), "client_closed");
    host.shutdown_gracefully().await;
}
