//! Test-classified surface: subc-transport server/keygen items used ONLY by
//! mc-module's historian_producer unit tests, plus the consumer items used by
//! tests/real_daemon.rs.
use std::{net::SocketAddr, time::Duration};

use subc_client_rs::{
    CallOptions, ConsumerOptions, HandlerOutcome, HealthStatus, RetryBackoff, SubcConsumer,
};
use subc_control::ClientControlResponse;
use subc_protocol::manifest::{ConsumerRole, ExecutionMode};
use subc_protocol::{BindIdentity, ErrorBody, FrameBuildError, FrameType, RouteTarget};
use subc_transport::{
    authenticate_server, generate_daemon_id, generate_key, read_frame, write_atomic, AuthError,
    ConnectionFileError, ConnectionInfo, Endpoint, FrameIoError, SCHEMA_VERSION,
};
use tokio::net::TcpListener;

fn assert_debug<T: std::fmt::Debug>() {}
fn assert_clone<T: Clone>() {}
fn assert_partial_eq<T: PartialEq>() {}
fn assert_error<T: std::error::Error>() {}

/// Every trait bound the compiler-closure pass folded into an inventory row
/// must exist on the published types, not only in the hand-edited stubs.
/// Compiling these instantiations is the proof; the function body never runs.
fn amended_trait_bounds_exist_in_published_sources() {
    assert_debug::<ErrorBody>();
    assert_debug::<RouteTarget>();
    assert_debug::<FrameType>();
    assert_debug::<ConsumerRole>();
    assert_debug::<ExecutionMode>();
    assert_debug::<HandlerOutcome>();
    assert_debug::<HealthStatus>();
    assert_debug::<ClientControlResponse>();
    assert_clone::<BindIdentity>();
    assert_clone::<RouteTarget>();
    assert_partial_eq::<RouteTarget>();
    assert_partial_eq::<FrameType>();
    assert_partial_eq::<ConsumerRole>();
    assert_partial_eq::<ExecutionMode>();
    assert_partial_eq::<HealthStatus>();
    assert_error::<AuthError>();
    assert_error::<ConnectionFileError>();
    assert_error::<FrameIoError>();
    assert_error::<FrameBuildError>();
}

#[tokio::test]
async fn test_only_items_have_published_shapes() {
    amended_trait_bounds_exist_in_published_sources();

    // The producer's liveness check needs `Ping` and `==`/`!=` on `FrameType`;
    // comparing distinct variants exercises `PartialEq` without a
    // self-comparison.
    assert_ne!(FrameType::Ping, FrameType::Request);

    // mc-module's unit tests compare `manifest().consumes` with `assert_eq!`,
    // so `ConsumerRole` must support equality between separately constructed
    // values.
    let consumes = ConsumerRole::ServiceClient {
        of: vec!["thalamus".to_string()],
    };
    assert!(
        consumes
            == ConsumerRole::ServiceClient {
                of: vec!["thalamus".to_string()],
            }
    );

    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let key = generate_key().unwrap();
    let daemon_id = generate_daemon_id().unwrap();
    let connection_file = temp.path().join("subc-connection.json");
    write_atomic(
        &connection_file,
        &ConnectionInfo {
            schema: SCHEMA_VERSION,
            wire_version: Some(subc_protocol::PROTOCOL_VERSION),
            endpoints: vec![Endpoint {
                host: addr.ip().to_string(),
                port: addr.port(),
            }],
            key: key.clone(),
            daemon_id,
            pid: std::process::id(),
            daemon_ver: "fake".to_string(),
        },
    )
    .unwrap();

    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        authenticate_server(&mut stream, &key, &daemon_id, "fake", Duration::from_secs(2))
            .await
            .unwrap();
        let _ = read_frame(&mut stream).await;
    });

    // real_daemon.rs consumer shapes.
    let options = ConsumerOptions {
        handshake_timeout: Duration::from_secs(2),
        call_timeout: Duration::from_secs(60),
        reconnect_backoff: RetryBackoff::default(),
        restored_debounce: Duration::from_millis(10),
    };
    if let Ok(consumer) = SubcConsumer::connect(&connection_file, options).await {
        let _ = consumer
            .call(
                RouteTarget::ToolProvider {
                    module_id: "magic-context".to_string(),
                },
                BindIdentity {
                    project_root: temp.path().to_path_buf(),
                    harness: "claude-code".to_string(),
                    session: "spine".to_string(),
                },
                b"{}".to_vec(),
                CallOptions::default(),
            )
            .await;
        consumer.close().await;
    }
    server.abort();
}
