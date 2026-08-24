//! Independent wire-vector conformance: literal proof and header bytes from
//! `docs/mc-host-wire-protocol.md`, plus the framing dispositions a host must
//! apply to a live connection.
//!
//! Expected values here are committed literals decoded by the test oracle in
//! `support::raw_client`. Nothing in this file asks the host to produce its own
//! expected bytes (protocol §14.1).

mod support;

use std::time::Duration;

use support::raw_client::{
    self, RawClient, CLIENT_DOMAIN, FLAGS_INTERACTIVE, FLAGS_PURE_HEADER, HEADER_LEN,
    SERVER_DOMAIN, TY_ERROR, TY_GOODBYE, TY_HELLO, TY_HELLO_ACK, TY_PING, TY_PUSH, TY_REQUEST,
    TY_RESPONSE, TY_STREAM_DATA, TY_STREAM_END,
};
use support::{TestHost, LINKED_MODULE_ID};

const BUDGET: Duration = Duration::from_secs(5);

/// Key `00..1f`, client nonce `20..3f`, server nonce `40..5f`, daemon ID
/// `60..6f` — the inputs the protocol's canonical proofs are computed over.
fn vector_inputs() -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
    (
        (0x00u8..=0x1f).collect(),
        (0x20u8..=0x3f).collect(),
        (0x40u8..=0x5f).collect(),
        (0x60u8..=0x6f).collect(),
    )
}

#[test]
fn committed_auth_proof_vectors_pin_the_construction() {
    let (key, client_nonce, server_nonce, daemon_id) = vector_inputs();

    let expected_server_proof: [u8; 32] = [
        234, 174, 245, 201, 145, 181, 54, 105, 225, 195, 92, 24, 185, 58, 79, 43, 27, 172, 41, 84,
        85, 12, 15, 144, 129, 65, 174, 41, 163, 57, 206, 192,
    ];
    let expected_client_auth: [u8; 32] = [
        168, 51, 199, 61, 160, 183, 32, 109, 223, 82, 6, 97, 222, 1, 81, 240, 135, 27, 140, 91,
        196, 171, 21, 161, 69, 59, 214, 117, 64, 99, 228, 205,
    ];

    assert_eq!(
        raw_client::proof(
            &key,
            SERVER_DOMAIN,
            &client_nonce,
            &server_nonce,
            &daemon_id
        ),
        expected_server_proof.to_vec(),
        "server proof construction drifted from the committed vector"
    );
    assert_eq!(
        raw_client::proof(
            &key,
            CLIENT_DOMAIN,
            &client_nonce,
            &server_nonce,
            &daemon_id
        ),
        expected_client_auth.to_vec(),
        "client proof construction drifted from the committed vector"
    );

    // The two domains must not collapse into one value.
    assert_ne!(expected_server_proof, expected_client_auth);
}

#[test]
fn proof_folds_every_input() {
    let (key, client_nonce, server_nonce, daemon_id) = vector_inputs();
    let baseline = raw_client::proof(
        &key,
        SERVER_DOMAIN,
        &client_nonce,
        &server_nonce,
        &daemon_id,
    );

    let mut other_key = key.clone();
    other_key[0] ^= 0xff;
    let mut other_client = client_nonce.clone();
    other_client[0] ^= 0xff;
    let mut other_server = server_nonce.clone();
    other_server[0] ^= 0xff;
    let mut other_daemon = daemon_id.clone();
    other_daemon[0] ^= 0xff;

    for (label, proof) in [
        (
            "key",
            raw_client::proof(
                &other_key,
                SERVER_DOMAIN,
                &client_nonce,
                &server_nonce,
                &daemon_id,
            ),
        ),
        (
            "client nonce",
            raw_client::proof(
                &key,
                SERVER_DOMAIN,
                &other_client,
                &server_nonce,
                &daemon_id,
            ),
        ),
        (
            "server nonce",
            raw_client::proof(
                &key,
                SERVER_DOMAIN,
                &client_nonce,
                &other_server,
                &daemon_id,
            ),
        ),
        (
            "daemon id",
            raw_client::proof(
                &key,
                SERVER_DOMAIN,
                &client_nonce,
                &server_nonce,
                &other_daemon,
            ),
        ),
    ] {
        assert_ne!(
            proof, baseline,
            "changing the {label} must change the proof"
        );
    }
}

#[test]
fn committed_header_vectors_decode_to_their_documented_fields() {
    // Control `route.open`: len 173, Interactive/Normal, channel 0, epoch 0,
    // correlation 1.
    let control = hex_to_bytes("ad0000000200020000000000000100000000000000");
    assert_eq!(control.len(), HEADER_LEN);
    let decoded = raw_client::decode_header(&control);
    assert_eq!(decoded.len, 173);
    assert_eq!(decoded.ver, 2);
    assert_eq!(decoded.ty, TY_REQUEST);
    assert_eq!(decoded.flags, FLAGS_INTERACTIVE);
    assert_eq!(decoded.channel, 0);
    assert_eq!(decoded.epoch, 0);
    assert_eq!(decoded.corr, 1);
    assert_eq!(
        raw_client::header(173, TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, 1),
        control,
        "encoding must reproduce the committed control header"
    );

    // Routed request: len 44, Background/Normal, channel 7, epoch 77,
    // correlation 2.
    let routed = hex_to_bytes("2c00000002000407004d0000000200000000000000");
    let decoded = raw_client::decode_header(&routed);
    assert_eq!(decoded.len, 44);
    assert_eq!(decoded.ty, TY_REQUEST);
    assert_eq!(decoded.flags, 0b0000_0100);
    assert_eq!(decoded.channel, 7);
    assert_eq!(decoded.epoch, 77);
    assert_eq!(decoded.corr, 2);
    assert_eq!(
        raw_client::header(44, TY_REQUEST, 0b0000_0100, 7, 77, 2),
        routed
    );
}

#[test]
fn canonical_route_open_body_is_173_bytes() {
    let canonical = concat!(
        r#"{"op":"route.open","target":{"kind":"tool_provider","module_id":"magic-context"},"#,
        r#""identity":{"project_root":"/workspace/project","harness":"opencode","session":"session-1"}}"#
    );
    assert_eq!(
        canonical.len(),
        173,
        "the documented control header declares 173 body bytes"
    );
    // The literal must still be the shape the host accepts.
    let parsed: serde_json::Value = serde_json::from_str(canonical).expect("canonical JSON");
    assert_eq!(parsed["op"], "route.open");
    assert_eq!(parsed["target"]["module_id"], LINKED_MODULE_ID);
}

#[test]
fn catalog_capability_vector_includes_negotiate_but_never_the_candidate_ops() {
    let canonical = concat!(
        r#"{"op":"catalog.list","generation":1,"modules":[],"#,
        r#""subc_ops":["route.open","catalog.list","host.shutdown","transport.negotiate"]}"#
    );
    let parsed: serde_json::Value = serde_json::from_str(canonical).expect("canonical JSON");
    assert_eq!(parsed["op"], "catalog.list");
    assert_eq!(
        parsed["subc_ops"],
        serde_json::json!([
            "route.open",
            "catalog.list",
            "host.shutdown",
            "transport.negotiate"
        ])
    );
    assert!(!canonical.contains("transport.activate"));
    assert!(!canonical.contains("transport.commit"));
}

/// The negotiation request is the generation's first control traffic, so it
/// uses consumer correlation 1 on the bootstrap; activation and commit use
/// the candidate's reserved correlations 1 and 2.
#[test]
fn committed_negotiation_vectors_pin_bodies_and_headers() {
    struct Vector {
        name: &'static str,
        body: &'static str,
        header_hex: &'static str,
        ty: u8,
        flags: u8,
        corr: u64,
    }

    const FLAGS_RESPONSE: u8 = FLAGS_INTERACTIVE | 0b0000_1000;

    let vectors = [
        Vector {
            name: "tcp-only offer request",
            body: r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1}]}"#,
            header_hex: "6a0000000200020000000000000100000000000000",
            ty: TY_REQUEST,
            flags: FLAGS_INTERACTIVE,
            corr: 1,
        },
        Vector {
            name: "ordered shm+tcp offer request",
            body: r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"shm","capability_version":1,"parameters":{}},{"transport":"tcp","capability_version":1}]}"#,
            header_hex: "a50000000200020000000000000100000000000000",
            ty: TY_REQUEST,
            flags: FLAGS_INTERACTIVE,
            corr: 1,
        },
        Vector {
            name: "direct tcp selection response",
            body: r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1}}"#,
            header_hex: "6a00000002010a0000000000000100000000000000",
            ty: TY_RESPONSE,
            flags: FLAGS_RESPONSE,
            corr: 1,
        },
        Vector {
            name: "tcp fallback response with reason",
            body: r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1},"reason":"capability_version_mismatch"}"#,
            header_hex: "9100000002010a0000000000000100000000000000",
            ty: TY_RESPONSE,
            flags: FLAGS_RESPONSE,
            corr: 1,
        },
        Vector {
            name: "non-tcp grant response",
            body: r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"activation_token":"00112233445566778899aabbccddeeff","descriptor":{}}"#,
            header_hex: "b000000002010a0000000000000100000000000000",
            ty: TY_RESPONSE,
            flags: FLAGS_RESPONSE,
            corr: 1,
        },
        Vector {
            name: "candidate activate request (corr 1)",
            body: r#"{"op":"transport.activate","negotiation_version":1,"activation_token":"00112233445566778899aabbccddeeff"}"#,
            header_hex: "690000000200020000000000000100000000000000",
            ty: TY_REQUEST,
            flags: FLAGS_INTERACTIVE,
            corr: 1,
        },
        Vector {
            name: "candidate activate response (corr 1)",
            body: r#"{"op":"transport.activate","negotiation_version":1}"#,
            header_hex: "3300000002010a0000000000000100000000000000",
            ty: TY_RESPONSE,
            flags: FLAGS_RESPONSE,
            corr: 1,
        },
        Vector {
            name: "candidate commit request (corr 2)",
            body: r#"{"op":"transport.commit","negotiation_version":1}"#,
            header_hex: "310000000200020000000000000200000000000000",
            ty: TY_REQUEST,
            flags: FLAGS_INTERACTIVE,
            corr: 2,
        },
        Vector {
            name: "candidate commit response (corr 2)",
            body: r#"{"op":"transport.commit","negotiation_version":1}"#,
            header_hex: "3100000002010a0000000000000200000000000000",
            ty: TY_RESPONSE,
            flags: FLAGS_RESPONSE,
            corr: 2,
        },
    ];

    for vector in vectors {
        let header_bytes = hex_to_bytes(vector.header_hex);
        assert_eq!(header_bytes.len(), HEADER_LEN, "{}", vector.name);
        let decoded = raw_client::decode_header(&header_bytes);
        assert_eq!(
            decoded.len as usize,
            vector.body.len(),
            "{}: the pinned header must declare the compact body length",
            vector.name
        );
        assert_eq!(decoded.ver, 2, "{}", vector.name);
        assert_eq!(decoded.ty, vector.ty, "{}", vector.name);
        assert_eq!(decoded.flags, vector.flags, "{}", vector.name);
        assert_eq!(decoded.channel, 0, "{}: channel 0 control", vector.name);
        assert_eq!(decoded.epoch, 0, "{}: epoch 0 on channel 0", vector.name);
        assert_eq!(decoded.corr, vector.corr, "{}", vector.name);
        assert_eq!(
            raw_client::header(
                vector.body.len() as u32,
                vector.ty,
                vector.flags,
                0,
                0,
                vector.corr
            ),
            header_bytes,
            "{}: encoding must reproduce the committed header",
            vector.name
        );
        let parsed: serde_json::Value =
            serde_json::from_str(vector.body).expect("pinned negotiation vector JSON");
        assert_eq!(parsed["negotiation_version"], 1, "{}", vector.name);
        assert!(
            parsed["op"]
                .as_str()
                .is_some_and(|op| op.starts_with("transport.")),
            "{}",
            vector.name
        );
        assert_eq!(
            serde_json::to_string(&parsed).expect("reserialize").len(),
            vector.body.len(),
            "{}: the pinned body must be compact",
            vector.name
        );
    }
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    assert!(hex.len().is_multiple_of(2), "hex must be byte-aligned");
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex digit"))
        .collect()
}

#[tokio::test]
async fn host_authenticates_against_the_independent_oracle() {
    let host = TestHost::start().await;
    let client = host.client().await;
    assert_eq!(client.daemon_ver, "mc-host/test");
    drop(client);
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn every_valid_role_claim_gets_identical_admission() {
    let host = TestHost::start().await;
    for role in ["client", "watchdog", "provider", ""] {
        let mut client = RawClient::connect_with_role(&host.info, role)
            .await
            .unwrap_or_else(|err| panic!("role {role:?} must authenticate identically: {err}"));
        // Reporting metadata cannot buy privilege: the same operations work and
        // nothing more becomes reachable.
        let corr = client
            .control(&serde_json::json!({"op": "catalog.list"}))
            .await
            .expect("catalog");
        let frame = client.frame_within(BUDGET).await.expect("catalog reply");
        assert_eq!(frame.corr, corr);
        assert_eq!(frame.ty, TY_RESPONSE);
        let unsupported = client
            .control(&serde_json::json!({"op": "supervisor.restart", "module_id": "x"}))
            .await
            .expect("unsupported op");
        let frame = client.frame_within(BUDGET).await.expect("reply");
        assert_eq!(frame.corr, unsupported);
        assert_eq!(frame.error_code(), "unsupported_operation");
    }
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn auth_message_at_the_cap_is_valid_and_over_it_closes() {
    let host = TestHost::start().await;

    // Exactly 4,096 bytes: valid. Padding whitespace inside the JSON keeps it
    // parseable while reaching the cap.
    let mut stream = raw_client::connect_unauthenticated(&host.info)
        .await
        .expect("connect");
    let nonce: Vec<u8> = (0u8..32).collect();
    let base = serde_json::json!({"client_nonce": nonce, "role": "client"});
    let mut body = serde_json::to_vec(&base).expect("hello");
    let pad = 4096 - body.len();
    // Re-serialize with a padded role so the message reaches exactly the cap.
    let padded_role = format!("client{}", " ".repeat(pad));
    body = serde_json::to_vec(&serde_json::json!({
        "client_nonce": nonce,
        "role": padded_role
    }))
    .expect("padded hello");
    assert_eq!(body.len(), 4096, "fixture must sit exactly on the cap");
    write_len_prefixed(&mut stream, &body).await;
    // The host answers, proving the message was accepted.
    let reply = read_len_prefixed(&mut stream).await.expect("server proof");
    assert!(reply["server_proof"].is_array());
    drop(stream);

    // The valid JSON fixture detects hosts that parse before enforcing the
    // 4,096-byte limit.
    let mut stream = raw_client::connect_unauthenticated(&host.info)
        .await
        .expect("connect");
    let nonce: Vec<u8> = (0u8..32).collect();
    let base = serde_json::to_vec(&serde_json::json!({
        "client_nonce": nonce,
        "role": "client"
    }))
    .expect("hello");
    let padded_role = format!("client{}", " ".repeat(4097 - base.len()));
    let oversize = serde_json::to_vec(&serde_json::json!({
        "client_nonce": (0u8..32).collect::<Vec<_>>(),
        "role": padded_role
    }))
    .expect("oversize hello");
    assert_eq!(oversize.len(), 4097);
    write_len_prefixed(&mut stream, &oversize).await;
    assert!(
        read_len_prefixed(&mut stream).await.is_none(),
        "an over-cap auth message must not receive a reply"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn malformed_and_wrong_proof_handshakes_close_without_envelope_traffic() {
    let host = TestHost::start().await;

    // Malformed JSON.
    let mut stream = raw_client::connect_unauthenticated(&host.info)
        .await
        .expect("connect");
    write_len_prefixed(&mut stream, b"{not json").await;
    assert!(read_len_prefixed(&mut stream).await.is_none());

    // Wrong nonce length.
    let mut stream = raw_client::connect_unauthenticated(&host.info)
        .await
        .expect("connect");
    let short: Vec<u8> = (0u8..16).collect();
    write_len_prefixed(
        &mut stream,
        &serde_json::to_vec(&serde_json::json!({"client_nonce": short, "role": "client"}))
            .expect("hello"),
    )
    .await;
    assert!(read_len_prefixed(&mut stream).await.is_none());

    // Valid hello, then a wrong client proof: the host must close and never
    // read or write an envelope frame.
    let mut stream = raw_client::connect_unauthenticated(&host.info)
        .await
        .expect("connect");
    let nonce: Vec<u8> = (0u8..32).collect();
    write_len_prefixed(
        &mut stream,
        &serde_json::to_vec(&serde_json::json!({"client_nonce": nonce, "role": "client"}))
            .expect("hello"),
    )
    .await;
    let _server = read_len_prefixed(&mut stream).await.expect("server proof");
    write_len_prefixed(
        &mut stream,
        &serde_json::to_vec(&serde_json::json!({"client_auth": vec![0u8; 32]})).expect("bad auth"),
    )
    .await;
    let mut buf = [0u8; 1];
    use tokio::io::AsyncReadExt;
    let read = tokio::time::timeout(BUDGET, stream.read(&mut buf))
        .await
        .expect("host must close promptly");
    assert!(
        matches!(read, Ok(0) | Err(_)),
        "a failed proof must yield EOF, never frame bytes"
    );

    host.shutdown_gracefully().await;
}

/// Each structurally illegal frame retires the generation with no `Error`
/// frame and no resynchronization (protocol §6.3, AE2, V13-V15, V17, V42).
#[tokio::test]
async fn structural_corruption_closes_silently() {
    struct Case {
        name: &'static str,
        bytes: Vec<u8>,
    }

    let cases = vec![
        Case {
            name: "unsupported version",
            bytes: {
                let mut header = raw_client::header(0, TY_GOODBYE, FLAGS_PURE_HEADER, 0, 0, 0);
                header[4] = 3;
                header
            },
        },
        Case {
            name: "unknown frame type",
            bytes: raw_client::header(0, 99, FLAGS_PURE_HEADER, 0, 0, 0),
        },
        Case {
            name: "reserved flag bit",
            bytes: raw_client::header(0, TY_GOODBYE, 0b1000_0000, 0, 0, 0),
        },
        Case {
            name: "reserved priority value",
            bytes: raw_client::header(0, TY_GOODBYE, 0b0000_0110, 0, 0, 0),
        },
        Case {
            name: "reserved admission value",
            bytes: raw_client::header(0, TY_GOODBYE, 0b0011_0000, 0, 0, 0),
        },
        Case {
            name: "sheddable on a delivered frame type",
            bytes: raw_client::header(0, TY_REQUEST, 0b0010_0010, 0, 0, 1),
        },
        Case {
            name: "nonzero epoch on the control channel",
            bytes: raw_client::header(0, TY_REQUEST, FLAGS_INTERACTIVE, 0, 4, 1),
        },
        Case {
            name: "binary pure-header frame",
            bytes: raw_client::header(0, TY_GOODBYE, 0b0000_0001, 0, 0, 0),
        },
        Case {
            name: "last pure-header frame",
            bytes: raw_client::header(0, TY_GOODBYE, 0b0000_1000, 0, 0, 0),
        },
        Case {
            name: "Expedite pure-header frame",
            bytes: raw_client::header(0, TY_GOODBYE, 0b0001_0000, 0, 0, 0),
        },
        Case {
            name: "pure-header frame declaring a body",
            bytes: {
                let mut wire = raw_client::header(4, TY_CANCEL_LOCAL, FLAGS_PURE_HEADER, 1, 1, 1);
                wire.extend_from_slice(b"body");
                wire
            },
        },
        Case {
            name: "body declaration over 64 MiB",
            bytes: raw_client::header(
                MAX_BODY_LEN_LOCAL + 1,
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                7,
                1,
                1,
            ),
        },
        Case {
            name: "consumer-originated Response",
            bytes: raw_client::header(0, TY_RESPONSE, FLAGS_INTERACTIVE, 7, 1, 1),
        },
        Case {
            name: "consumer-originated StreamData",
            bytes: raw_client::header(0, TY_STREAM_DATA, FLAGS_INTERACTIVE, 7, 1, 1),
        },
        Case {
            name: "consumer-originated StreamEnd",
            bytes: raw_client::header(0, TY_STREAM_END, FLAGS_INTERACTIVE, 7, 1, 1),
        },
        Case {
            name: "consumer-originated Error",
            bytes: raw_client::header(0, TY_ERROR, FLAGS_INTERACTIVE, 7, 1, 1),
        },
        Case {
            name: "consumer-originated Push",
            bytes: raw_client::header(0, TY_PUSH, FLAGS_INTERACTIVE, 7, 1, 0),
        },
        Case {
            name: "role-invalid Hello",
            bytes: raw_client::header(0, TY_HELLO, FLAGS_INTERACTIVE, 0, 0, 1),
        },
        Case {
            name: "role-invalid HelloAck",
            bytes: raw_client::header(0, TY_HELLO_ACK, FLAGS_INTERACTIVE, 0, 0, 1),
        },
        Case {
            name: "consumer-originated Ping",
            bytes: raw_client::header(0, TY_PING, FLAGS_PURE_HEADER, 0, 0, 1),
        },
        Case {
            name: "routed request with zero epoch",
            bytes: raw_client::header(0, TY_REQUEST, FLAGS_INTERACTIVE, 7, 0, 1),
        },
        Case {
            name: "zero correlation on a control request",
            bytes: raw_client::header(0, TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, 0),
        },
    ];

    let host = TestHost::start().await;
    for case in cases {
        let mut client = host.client().await;
        client
            .send_raw(&case.bytes)
            .await
            .unwrap_or_else(|err| panic!("{}: send failed: {err}", case.name));

        let frames = client.drain_until_close(Duration::from_secs(2)).await;
        assert!(
            frames.is_empty(),
            "{}: corruption must not produce a frame, got {frames:?}",
            case.name
        );
        assert!(
            client.closed_within(Duration::from_secs(2)).await,
            "{}: the generation must be retired",
            case.name
        );
    }
    assert_eq!(
        host.handler.dispatch_count(),
        0,
        "structural corruption must never reach the handler"
    );
    host.shutdown_gracefully().await;
}

const TY_CANCEL_LOCAL: u8 = 6;
const MAX_BODY_LEN_LOCAL: u32 = 64 * 1024 * 1024;

#[tokio::test]
async fn pure_header_frames_accept_any_valid_priority() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(
            LINKED_MODULE_ID,
            "/workspace/project",
            "opencode",
            "priority",
        )
        .await
        .expect("route");

    client
        .send_frame(
            TY_CANCEL_LOCAL,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            999_999,
            &[],
        )
        .await
        .expect("Interactive Cancel");
    let corr = client
        .control(&serde_json::json!({"op": "catalog.list"}))
        .await
        .expect("catalog after Cancel");
    let frame = client.frame_within(BUDGET).await.expect("catalog response");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.ty, TY_RESPONSE);

    client
        .send_frame(TY_GOODBYE, 0b0000_0100, channel, epoch, 0, &[])
        .await
        .expect("Background route Goodbye");
    let corr = client
        .control(&serde_json::json!({"op": "catalog.list"}))
        .await
        .expect("catalog after Background Goodbye");
    let frame = client.frame_within(BUDGET).await.expect("catalog response");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.ty, TY_RESPONSE);

    client
        .send_frame(TY_GOODBYE, FLAGS_PURE_HEADER, 0, 0, 0, &[])
        .await
        .expect("connection Goodbye");
    assert!(client.closed_within(BUDGET).await);
    host.shutdown_gracefully().await;
}

/// The decoder detects truncation only at EOF or the frame deadline.
#[tokio::test]
async fn eof_inside_a_frame_closes_without_a_terminal() {
    let host = TestHost::start().await;

    let mut client = host.client().await;
    let header = raw_client::header(0, TY_GOODBYE, FLAGS_PURE_HEADER, 0, 0, 0);
    client
        .send_raw(&header[..12])
        .await
        .expect("partial header");
    client.shutdown_write().await.expect("half close");
    assert!(
        client
            .drain_until_close(Duration::from_secs(2))
            .await
            .is_empty(),
        "a truncated header must not produce a frame"
    );
    assert!(client.closed_within(Duration::from_secs(2)).await);

    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, "/workspace/project", "opencode", "trunc")
        .await
        .expect("route");
    let corr = client.next_corr();
    let mut wire = raw_client::header(64, TY_REQUEST, FLAGS_INTERACTIVE, channel, epoch, corr);
    wire.extend_from_slice(b"only-part-of-the-declared-body");
    client.send_raw(&wire).await.expect("partial body");
    client.shutdown_write().await.expect("half close");
    assert!(
        client
            .drain_until_close(Duration::from_secs(2))
            .await
            .is_empty(),
        "a truncated body must not produce a terminal"
    );
    assert!(client.closed_within(Duration::from_secs(2)).await);
    assert_eq!(
        host.handler.dispatch_count(),
        0,
        "a frame that never completed must not reach the handler"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn clean_eof_before_a_header_is_orderly() {
    let host = TestHost::start().await;
    let client = host.client().await;
    drop(client);
    // An orderly close must leave the host serving other connections.
    let mut next = host.client().await;
    let corr = next
        .control(&serde_json::json!({"op": "catalog.list"}))
        .await
        .expect("catalog");
    let frame = next.frame_within(BUDGET).await.expect("reply");
    assert_eq!(frame.corr, corr);
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn control_body_at_the_profile_cap_is_read_and_over_it_is_rejected_early() {
    let host = TestHost::start().await;
    let mut client = host.client().await;

    // Exactly 65,536 bytes: admitted and parsed. Whitespace padding keeps it
    // valid JSON, so the reply proves the body was fully read.
    let mut body =
        serde_json::to_vec(&serde_json::json!({"op": "catalog.list"})).expect("catalog body");
    let pad = 65_536 - body.len();
    body.pop();
    body.extend(std::iter::repeat_n(b' ', pad));
    body.push(b'}');
    assert_eq!(body.len(), 65_536);
    let corr = client.next_corr();
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, corr, &body)
        .await
        .expect("send at cap");
    let frame = client.frame_within(BUDGET).await.expect("reply at cap");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.ty, TY_RESPONSE);

    // Receiving the terminal before any body bytes are sent proves the host
    // rejects the declared length from the header.
    let prefix = br#"{"op":"catalog.list","padding":""#;
    let suffix = br#""}"#;
    let mut oversize = Vec::with_capacity(65_537);
    oversize.extend_from_slice(prefix);
    oversize.extend(std::iter::repeat_n(
        b'p',
        65_537 - prefix.len() - suffix.len(),
    ));
    oversize.extend_from_slice(suffix);
    assert_eq!(oversize.len(), 65_537);
    serde_json::from_slice::<serde_json::Value>(&oversize).expect("valid over-cap JSON");
    let corr = client.next_corr();
    let header = raw_client::header(
        oversize.len() as u32,
        TY_REQUEST,
        FLAGS_INTERACTIVE,
        0,
        0,
        corr,
    );
    client
        .send_raw(&header)
        .await
        .expect("send oversize header");
    let frame = client.frame_within(BUDGET).await.expect("early terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.error_code(), "invalid_control_request");
    client.send_raw(&oversize).await.expect("satisfy the drain");

    // Alignment survived the drain: the next frame is served normally.
    let corr = client
        .control(&serde_json::json!({"op": "catalog.list"}))
        .await
        .expect("post-drain catalog");
    let frame = client.frame_within(BUDGET).await.expect("post-drain reply");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.ty, TY_RESPONSE);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn a_maximum_size_frame_stays_interoperable() {
    let host = TestHost::start_with(|config| {
        // 64 KiB of headroom absorbs the cached catalog's resident-byte
        // subtraction while keeping the budgets at their interop floor.
        config.limits.max_resident_bytes = mc_host::config::MIN_RESIDENT_BYTES + 64 * 1024;
    })
    .await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, "/workspace/project", "opencode", "big")
        .await
        .expect("route");

    // Exactly 64 MiB of valid JSON: the profile must accept one such frame.
    let prefix = br#"{"mode":"len","pad":""#;
    let suffix = br#""}"#;
    let pad = MAX_BODY_LEN_LOCAL as usize - prefix.len() - suffix.len();
    let mut body = Vec::with_capacity(MAX_BODY_LEN_LOCAL as usize);
    body.extend_from_slice(prefix);
    body.extend(std::iter::repeat_n(b'a', pad));
    body.extend_from_slice(suffix);
    assert_eq!(body.len(), MAX_BODY_LEN_LOCAL as usize);

    let corr = client.next_corr();
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, channel, epoch, corr, &body)
        .await
        .expect("send maximum-size frame");

    let frame = client
        .frame_within(Duration::from_secs(60))
        .await
        .expect("maximum-size frame must be answered");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(
        frame.json()["received_bytes"].as_u64(),
        Some(u64::from(MAX_BODY_LEN_LOCAL)),
        "the handler must observe every declared byte"
    );

    host.shutdown_gracefully().await;
}

async fn write_len_prefixed(stream: &mut tokio::net::TcpStream, body: &[u8]) {
    use tokio::io::AsyncWriteExt;
    stream
        .write_all(&(body.len() as u32).to_le_bytes())
        .await
        .expect("write length");
    stream.write_all(body).await.expect("write body");
}

async fn read_len_prefixed(stream: &mut tokio::net::TcpStream) -> Option<serde_json::Value> {
    use tokio::io::AsyncReadExt;
    let mut len_bytes = [0u8; 4];
    match tokio::time::timeout(BUDGET, stream.read_exact(&mut len_bytes)).await {
        Ok(Ok(_)) => {}
        _ => return None,
    }
    let len = u32::from_le_bytes(len_bytes);
    if len > 4096 {
        return None;
    }
    let mut body = vec![0u8; len as usize];
    match tokio::time::timeout(BUDGET, stream.read_exact(&mut body)).await {
        Ok(Ok(_)) => serde_json::from_slice(&body).ok(),
        _ => None,
    }
}

/// Pins the exact `host.shutdown` success bytes: a tagged compact object with
/// only the `op` field, decoded here by the independent oracle.
#[tokio::test]
async fn host_shutdown_response_bytes_are_pinned() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let corr = client
        .control(&serde_json::json!({"op": "host.shutdown"}))
        .await
        .expect("send shutdown");
    let deadline = tokio::time::Instant::now() + BUDGET;
    let frame = loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = client.frame_within(remaining).await.expect("frame");
        if frame.corr == corr && frame.ty != raw_client::TY_PING {
            break frame;
        }
    };
    assert_eq!(frame.ty, TY_RESPONSE);
    // Interactive priority (bits 1-2 = 01) plus the last-frame bit (bit 3):
    // the full flags byte is part of the pinned response.
    assert_eq!(frame.flags, FLAGS_INTERACTIVE | 0b0000_1000);
    assert_eq!(frame.channel, 0);
    assert_eq!(frame.epoch, 0);
    assert_eq!(frame.body, br#"{"op":"host.shutdown"}"#.to_vec());
    host.shutdown().await.expect("graceful shutdown");
}

/// The three-target profile's catalog is a deterministic wire shape: exactly
/// `magic-context`, `synapse`, `broca` in order with the pinned `subc_ops`
/// (protocol §7.3, V40).
#[tokio::test]
async fn three_component_catalog_order_is_pinned() {
    let (mc, synapse, broca) = support::stub_trio();
    let composite =
        mc_host::StaticComposite::new(mc, synapse, broca).expect("distinct component ids");
    let host = support::CompositeTestHost::start(composite, |_config| {}).await;
    let mut client = host.client().await;

    let corr = client
        .control(&serde_json::json!({"op": "catalog.list"}))
        .await
        .expect("send catalog.list");
    let frame = client.frame_within(BUDGET).await.expect("catalog");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.ty, TY_RESPONSE);
    let body = frame.json();
    let ids: Vec<&str> = body["modules"]
        .as_array()
        .expect("modules array")
        .iter()
        .map(|module| module["module_id"].as_str().expect("module_id"))
        .collect();
    assert_eq!(ids, ["magic-context", "synapse", "broca"]);
    assert_eq!(
        body["subc_ops"],
        serde_json::json!([
            "route.open",
            "catalog.list",
            "host.shutdown",
            "transport.negotiate"
        ])
    );

    host.shutdown().await.expect("graceful shutdown");
}
