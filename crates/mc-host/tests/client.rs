mod support;

use std::{path::PathBuf, time::Duration};

#[cfg(unix)]
use std::os::unix::fs::{symlink, PermissionsExt};

use mc_host::{
    auth::authenticate_server,
    connection_file::{ConnectionInfo, Endpoint},
    Client, LivenessPolicy, RequestOptions, RouteIdentity, RouteTarget, SendOutcome, TargetKind,
};
use support::{
    mode_body,
    raw_client::{self, FLAGS_RESPONSE_TEXT_LAST, TY_ERROR, TY_RESPONSE},
    TestHost, LINKED_MODULE_ID,
};

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
    }
}

#[tokio::test]
async fn authenticates_negotiates_routes_unary_and_closes() {
    let host = TestHost::start().await;
    let client = Client::connect(host.publication_path())
        .await
        .expect("managed client connects");
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
async fn host_terminal_is_typed_and_redacted() {
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
    let rendered = format!("{error:?} {error}");
    assert!(!rendered.contains(sentinel));

    client.close().await.unwrap();
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn stream_order_and_slow_consumer_do_not_block_ping_or_unary() {
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

    let first = stream.next().await.unwrap().expect("first item");
    let second = stream.next().await.unwrap().expect("second item");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&first.body).unwrap()["item"],
        0
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&second.body).unwrap()["item"],
        1
    );

    tokio::time::sleep(Duration::from_millis(150)).await;
    let body = mode_body(serde_json::json!({"mode": "echo", "value": "unrelated"}));
    let response = client
        .request(route, body.clone(), RequestOptions::default())
        .await
        .expect("Ping/Pong and slow stream do not block unary");
    assert_eq!(response.body, body);
    stream.cancel().expect("stream cancellation");

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

#[cfg(unix)]
#[tokio::test]
async fn invalid_discovery_matrix_never_dials() {
    let root = tempfile::tempdir().unwrap();
    let publication = root.path().join("connection.json");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let valid = serde_json::json!({
        "schema": 1,
        "wire_version": 2,
        "endpoints": [{"host": "127.0.0.1", "port": port}],
        "key": vec![7; 32],
        "daemon_id": vec![8; 16],
        "pid": 1,
        "daemon_ver": "test"
    });

    async fn rejected_without_dial(
        listener: &tokio::net::TcpListener,
        publication: &std::path::Path,
    ) {
        let error = Client::connect(publication)
            .await
            .expect_err("discovery rejects before dial");
        assert_eq!(error.code(), "discovery_failed");
        assert!(
            tokio::time::timeout(Duration::from_millis(10), listener.accept())
                .await
                .is_err()
        );
    }

    let write = |value: &serde_json::Value| {
        std::fs::write(&publication, serde_json::to_vec(value).unwrap()).unwrap();
        std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o600)).unwrap();
    };

    let mut missing = valid.clone();
    missing.as_object_mut().unwrap().remove("wire_version");
    write(&missing);
    rejected_without_dial(&listener, &publication).await;

    let mut unsupported = valid.clone();
    unsupported["wire_version"] = serde_json::json!(1);
    write(&unsupported);
    rejected_without_dial(&listener, &publication).await;

    std::fs::write(&publication, b"not-json").unwrap();
    std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o600)).unwrap();
    rejected_without_dial(&listener, &publication).await;

    std::fs::write(
        &publication,
        vec![b'x'; mc_host::MAX_CONNECTION_FILE_LEN + 1],
    )
    .unwrap();
    std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o600)).unwrap();
    rejected_without_dial(&listener, &publication).await;

    write(&valid);
    std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o640)).unwrap();
    rejected_without_dial(&listener, &publication).await;

    let target = root.path().join("target.json");
    std::fs::rename(&publication, &target).unwrap();
    symlink(&target, &publication).unwrap();
    rejected_without_dial(&listener, &publication).await;
}

#[cfg(unix)]
#[tokio::test]
async fn managed_client_negotiation_failures_retire_socket_without_application_frame() {
    enum Reply {
        Error(&'static str),
        Response { corr: u64, body: &'static [u8] },
    }

    let cases = [
        (
            "legacy unsupported_operation",
            Reply::Error("unsupported_operation"),
        ),
        ("connection_in_use", Reply::Error("connection_in_use")),
        (
            "first application response",
            Reply::Response {
                corr: 2,
                body: br#"{"op":"route.open","route_channel":7,"route_epoch":1}"#,
            },
        ),
        (
            "malformed selection",
            Reply::Response {
                corr: 1,
                body: br#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp"}}"#,
            },
        ),
        (
            "version mismatch",
            Reply::Response {
                corr: 1,
                body: br#"{"op":"transport.negotiate","negotiation_version":2,"selected":{"transport":"tcp","capability_version":1}}"#,
            },
        ),
        (
            "duplicate root op",
            Reply::Response {
                corr: 1,
                body: br#"{"op":"transport.negotiate","op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1}}"#,
            },
        ),
        (
            "duplicate root version",
            Reply::Response {
                corr: 1,
                body: br#"{"op":"transport.negotiate","negotiation_version":1,"negotiation_version":1,"selected":{"transport":"tcp","capability_version":1}}"#,
            },
        ),
        (
            "duplicate nested transport",
            Reply::Response {
                corr: 1,
                body: br#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","transport":"tcp","capability_version":1}}"#,
            },
        ),
        (
            "tcp fallback reason",
            Reply::Response {
                corr: 1,
                body: br#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1},"reason":"unavailable"}"#,
            },
        ),
    ];

    for (name, reply) in cases {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let publication = root.path().join("connection.json");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let key = vec![0x5a; 32];
        let daemon_id = [0x3c; 16];
        let info = ConnectionInfo {
            schema: 1,
            wire_version: 2,
            endpoints: vec![Endpoint {
                host: "127.0.0.1".to_owned(),
                port: listener.local_addr().unwrap().port(),
            }],
            key: key.clone(),
            daemon_id,
            pid: std::process::id(),
            daemon_ver: "fake-peer".to_owned(),
        };
        std::fs::write(&publication, serde_json::to_vec(&info).unwrap()).unwrap();
        std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o600)).unwrap();

        let peer = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let (mut socket, _) = listener.accept().await.unwrap();
            authenticate_server(
                &mut socket,
                &key,
                &daemon_id,
                "fake-peer",
                Duration::from_secs(1),
            )
            .await
            .expect("managed client authenticates");
            let mut header = [0u8; raw_client::HEADER_LEN];
            socket
                .read_exact(&mut header)
                .await
                .expect("negotiation header");
            let frame = raw_client::decode_header(&header);
            assert_eq!(frame.ty, raw_client::TY_REQUEST, "{name}");
            assert_eq!(frame.corr, 1, "{name}");
            let mut request_body = vec![0; frame.len as usize];
            socket
                .read_exact(&mut request_body)
                .await
                .expect("negotiation body");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&request_body).unwrap()["op"],
                "transport.negotiate",
                "{name}"
            );

            let (ty, corr, body) = match reply {
                Reply::Error(code) => (
                    TY_ERROR,
                    1,
                    serde_json::to_vec(&serde_json::json!({
                        "code": code,
                        "message": "peer-controlled sentinel"
                    }))
                    .unwrap(),
                ),
                Reply::Response { corr, body } => (TY_RESPONSE, corr, body.to_vec()),
            };
            let mut response =
                raw_client::header(body.len() as u32, ty, FLAGS_RESPONSE_TEXT_LAST, 0, 0, corr);
            response.extend_from_slice(&body);
            socket.write_all(&response).await.expect("selection reply");

            let mut byte = [0u8; 1];
            let closed = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut byte))
                .await
                .expect("client retires socket")
                .expect("socket read");
            assert_eq!(closed, 0, "{name}: no application frame after rejection");
        });

        let error = Client::connect(&publication)
            .await
            .expect_err(&format!("{name}: connect must fail"));
        assert_eq!(error.code(), "negotiation_failed", "{name}");
        peer.await.unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn zero_length_stream_item_is_delivered_and_does_not_retire_the_connection() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Only `StreamEnd` must be empty, so a zero-length `StreamData` item is
    // legal. It must reach the stream consumer rather than being misread as an
    // exhausted retained-byte budget, which would retire the generation and
    // fail every unrelated in-flight request.
    const STREAM_FLAGS: u8 = raw_client::FLAGS_INTERACTIVE;

    async fn read_frame(socket: &mut tokio::net::TcpStream) -> raw_client::RawFrame {
        let mut header = [0u8; raw_client::HEADER_LEN];
        socket.read_exact(&mut header).await.expect("frame header");
        let mut frame = raw_client::decode_header(&header);
        if frame.len > 0 {
            let mut body = vec![0; frame.len as usize];
            socket.read_exact(&mut body).await.expect("frame body");
            frame.body = body;
        }
        frame
    }

    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let publication = root.path().join("connection.json");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let key = vec![0x5a; 32];
    let daemon_id = [0x3c; 16];
    let info = ConnectionInfo {
        schema: 1,
        wire_version: 2,
        endpoints: vec![Endpoint {
            host: "127.0.0.1".to_owned(),
            port: listener.local_addr().unwrap().port(),
        }],
        key: key.clone(),
        daemon_id,
        pid: std::process::id(),
        daemon_ver: "fake-peer".to_owned(),
    };
    std::fs::write(&publication, serde_json::to_vec(&info).unwrap()).unwrap();
    std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o600)).unwrap();

    let peer = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        authenticate_server(
            &mut socket,
            &key,
            &daemon_id,
            "fake-peer",
            Duration::from_secs(1),
        )
        .await
        .expect("managed client authenticates");

        // Negotiation (correlation 1).
        let negotiate = read_frame(&mut socket).await;
        assert_eq!(negotiate.corr, 1);
        let selection = br#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1}}"#;
        let mut reply = raw_client::header(
            selection.len() as u32,
            TY_RESPONSE,
            FLAGS_RESPONSE_TEXT_LAST,
            0,
            0,
            1,
        );
        reply.extend_from_slice(selection);
        socket.write_all(&reply).await.expect("selection reply");

        // route.open (correlation 2) grants channel 7 epoch 1.
        let open = read_frame(&mut socket).await;
        assert_eq!(open.corr, 2);
        let opened = br#"{"op":"route.open","route_channel":7,"route_epoch":1}"#;
        let mut reply = raw_client::header(
            opened.len() as u32,
            TY_RESPONSE,
            FLAGS_RESPONSE_TEXT_LAST,
            0,
            0,
            2,
        );
        reply.extend_from_slice(opened);
        socket.write_all(&reply).await.expect("route.open reply");

        // Stream request (correlation 3): first item empty, then a payload
        // item, then StreamEnd.
        let stream_request = read_frame(&mut socket).await;
        assert_eq!(stream_request.corr, 3);
        assert_eq!(stream_request.channel, 7);
        let empty_item = raw_client::header(0, raw_client::TY_STREAM_DATA, STREAM_FLAGS, 7, 1, 3);
        socket.write_all(&empty_item).await.expect("empty item");
        let payload = b"payload";
        let mut item = raw_client::header(
            payload.len() as u32,
            raw_client::TY_STREAM_DATA,
            STREAM_FLAGS,
            7,
            1,
            3,
        );
        item.extend_from_slice(payload);
        socket.write_all(&item).await.expect("payload item");
        let end = raw_client::header(0, raw_client::TY_STREAM_END, STREAM_FLAGS, 7, 1, 3);
        socket.write_all(&end).await.expect("stream end");

        // An unrelated unary (correlation 4) proves the generation survived.
        let unary = read_frame(&mut socket).await;
        assert_eq!(unary.corr, 4);
        let mut reply = raw_client::header(
            unary.body.len() as u32,
            TY_RESPONSE,
            FLAGS_RESPONSE_TEXT_LAST,
            7,
            1,
            4,
        );
        reply.extend_from_slice(&unary.body);
        socket.write_all(&reply).await.expect("unary echo");
    });

    let client = Client::connect(&publication)
        .await
        .expect("managed client connects to fake peer");
    let route = client
        .open_route(target(), identity("empty-item"))
        .await
        .expect("route opens");
    let mut stream = client
        .request_stream(route, b"stream".to_vec(), RequestOptions::default())
        .await
        .expect("stream starts");

    let first = stream
        .next()
        .await
        .expect("empty item does not retire the generation")
        .expect("first item is delivered");
    assert!(first.body.is_empty(), "the empty item arrives intact");
    let second = stream
        .next()
        .await
        .expect("stream continues past the empty item")
        .expect("second item is delivered");
    assert_eq!(second.body, b"payload");
    assert!(
        stream.next().await.expect("stream ends cleanly").is_none(),
        "StreamEnd terminates the stream"
    );

    let body = b"after-empty-item".to_vec();
    let response = client
        .request(route, body.clone(), RequestOptions::default())
        .await
        .expect("an unrelated request still succeeds on the same generation");
    assert_eq!(response.body, body);
    peer.await.unwrap();
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
