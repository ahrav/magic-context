//! Test-classified surface: subc-transport server/keygen items used ONLY by
//! mc-module's historian_producer unit tests, plus the consumer items used by
//! tests/real_daemon.rs.
use std::{net::SocketAddr, time::Duration};

use subc_client_rs::{CallOptions, ConsumerOptions, RetryBackoff, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget};
use subc_transport::{
    authenticate_server, generate_daemon_id, generate_key, read_frame, write_atomic,
    ConnectionInfo, Endpoint, SCHEMA_VERSION,
};
use tokio::net::TcpListener;

#[tokio::test]
async fn test_only_items_have_published_shapes() {
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
