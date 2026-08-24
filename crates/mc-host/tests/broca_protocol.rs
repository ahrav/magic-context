//! Broca protocol conformance: strict five-operation decoding, the 512 KiB
//! request boundary, bind validation, and wire-shape compatibility with the
//! JSON `HistorianProducer` sends and parses today.

mod support;

use std::sync::Arc;

use mc_host::broca::backend::Harness;
use mc_host::broca::protocol::{self, Request};
use mc_host::broca::{config, BrocaComponent};
use mc_host::{BindOutcome, CompositeComponent, RouteHandle, RouteIdentity};

use support::broca::{
    call, drain_subscribe, open_broca_route, send_call, send_params, BrocaHost, ScriptedBackend,
};

fn body(value: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&value).expect("body serializes")
}

fn send_body(prompt: &str, system: Option<&str>) -> Vec<u8> {
    body(serde_json::json!({
        "method": "session.send",
        "params": send_params(prompt, system, "prov/model-a"),
    }))
}

fn mutate(text: &str, needle: &str, replacement: &str) -> Vec<u8> {
    assert!(
        text.contains(needle),
        "mutation needle vanished; the case would test an unmutated valid body: {needle}"
    );
    text.replace(needle, replacement).into_bytes()
}

#[test]
fn each_valid_operation_decodes_its_exact_schema() {
    let request = protocol::parse_request(&send_body("hello", Some("guidance")), false)
        .expect("valid send decodes");
    let Request::Send(send) = request else {
        panic!("expected a send");
    };
    assert_eq!(send.prompt, "hello");
    assert_eq!(send.system.as_deref(), Some("guidance"));
    assert_eq!(send.provider, "prov");
    assert_eq!(send.model, "model-a");
    assert_eq!(send.max_output_tokens, 32_000);
    assert_eq!(send.temperature, 0.1);

    // Canonical model strings split at the FIRST slash; remaining slashes
    // belong to the model segment.
    let request = protocol::parse_request(
        &body(serde_json::json!({
            "method": "session.send",
            "params": send_params("p", None, "google/gemini/flash"),
        })),
        false,
    )
    .expect("multi-slash model decodes");
    let Request::Send(send) = request else {
        panic!("expected a send");
    };
    assert_eq!(send.provider, "google");
    assert_eq!(send.model, "gemini/flash");
    assert_eq!(send.system, None);

    assert_eq!(
        protocol::parse_request(
            &body(serde_json::json!({
                "method": "session.subscribe",
                "params": { "from": "start" },
            })),
            false,
        )
        .expect("subscribe decodes"),
        Request::Subscribe
    );
    assert_eq!(
        protocol::parse_request(
            &body(serde_json::json!({
                "method": "run.status",
                "params": { "run_id": "broca-abc-1" },
            })),
            false,
        )
        .expect("status decodes"),
        Request::Status {
            run_id: "broca-abc-1".to_owned()
        }
    );
    assert_eq!(
        protocol::parse_request(
            &body(serde_json::json!({
                "method": "run.cancel",
                "params": { "run_id": "broca-abc-1" },
            })),
            false,
        )
        .expect("cancel decodes"),
        Request::Cancel {
            run_id: "broca-abc-1".to_owned()
        }
    );
    // The session is the route identity, so delete accepts empty params or
    // no params field at all.
    assert_eq!(
        protocol::parse_request(
            &body(serde_json::json!({ "method": "session.delete", "params": {} })),
            false,
        )
        .expect("delete decodes"),
        Request::Delete
    );
    assert_eq!(
        protocol::parse_request(
            &body(serde_json::json!({ "method": "session.delete" })),
            false
        )
        .expect("delete without params decodes"),
        Request::Delete
    );
}

#[test]
fn every_malformed_shape_is_rejected_with_schema_violation() {
    let ok = send_body("p", None);
    let ok_text = String::from_utf8(ok.clone()).expect("utf8");
    let cases: Vec<(&str, Vec<u8>, bool)> = vec![
        ("binary body", ok.clone(), true),
        ("non-object root", b"\"session.send\"".to_vec(), false),
        ("array root", b"[]".to_vec(), false),
        ("truncated json", ok[..ok.len() - 2].to_vec(), false),
        (
            "trailing content",
            {
                let mut trailing = ok.clone();
                trailing.extend_from_slice(b" {}");
                trailing
            },
            false,
        ),
        (
            "duplicate method",
            b"{\"method\":\"session.delete\",\"method\":\"session.delete\"}".to_vec(),
            false,
        ),
        (
            "duplicate params",
            b"{\"method\":\"session.delete\",\"params\":{},\"params\":{}}".to_vec(),
            false,
        ),
        (
            "duplicate prompt",
            mutate(&ok_text, "\"prompt\":", "\"prompt\":\"x\",\"prompt\":"),
            false,
        ),
        (
            "unknown envelope field",
            mutate(&ok_text, "\"method\":", "\"junk\":1,\"method\":"),
            false,
        ),
        (
            "unknown params field",
            mutate(&ok_text, "\"prompt\":", "\"junk\":1,\"prompt\":"),
            false,
        ),
        (
            "unknown method",
            body(serde_json::json!({ "method": "session.list", "params": {} })),
            false,
        ),
        (
            "array params",
            body(serde_json::json!({ "method": "session.send", "params": [] })),
            false,
        ),
        (
            "missing params on send",
            body(serde_json::json!({ "method": "session.send" })),
            false,
        ),
        ("empty prompt", send_body("", None), false),
        ("empty system", send_body("p", Some("")), false),
        (
            "flat model string",
            mutate(
                &ok_text,
                "\"model\":{\"model\":\"model-a\",\"provider\":\"prov\"}",
                "\"model\":\"prov/model-a\"",
            ),
            false,
        ),
        (
            "provider with slash",
            mutate(&ok_text, "\"provider\":\"prov\"", "\"provider\":\"pr/ov\""),
            false,
        ),
        (
            "empty provider",
            mutate(&ok_text, "\"provider\":\"prov\"", "\"provider\":\"\""),
            false,
        ),
        (
            "nonempty tools",
            mutate(&ok_text, "\"tools\":[]", "\"tools\":[{\"name\":\"x\"}]"),
            false,
        ),
        (
            "missing tools",
            mutate(&ok_text, ",\"tools\":[]", ""),
            false,
        ),
        (
            "zero max_output_tokens",
            mutate(
                &ok_text,
                "\"max_output_tokens\":32000",
                "\"max_output_tokens\":0",
            ),
            false,
        ),
        (
            "oversized max_output_tokens",
            mutate(
                &ok_text,
                "\"max_output_tokens\":32000",
                &format!(
                    "\"max_output_tokens\":{}",
                    config::MAX_OUTPUT_TOKENS_BOUND + 1
                ),
            ),
            false,
        ),
        (
            "temperature out of range",
            mutate(&ok_text, "\"temperature\":0.1", "\"temperature\":3.5"),
            false,
        ),
        (
            "temperature as string",
            mutate(&ok_text, "\"temperature\":0.1", "\"temperature\":\"0.1\""),
            false,
        ),
        (
            "missing generation",
            mutate(
                &ok_text,
                "\"generation\":{\"max_output_tokens\":32000,\"temperature\":0.1},",
                "",
            ),
            false,
        ),
        (
            "subscribe from cursor",
            body(
                serde_json::json!({ "method": "session.subscribe", "params": { "from": "cursor:3" } }),
            ),
            false,
        ),
        (
            "subscribe without from",
            body(serde_json::json!({ "method": "session.subscribe", "params": {} })),
            false,
        ),
        (
            "status without run_id",
            body(serde_json::json!({ "method": "run.status", "params": {} })),
            false,
        ),
        (
            "empty run_id",
            body(serde_json::json!({ "method": "run.cancel", "params": { "run_id": "" } })),
            false,
        ),
        (
            "oversized run_id",
            body(serde_json::json!({
                "method": "run.status",
                "params": { "run_id": "r".repeat(protocol::MAX_RUN_ID_BYTES + 1) },
            })),
            false,
        ),
        (
            "delete with junk params",
            body(
                serde_json::json!({ "method": "session.delete", "params": { "session_id": "x" } }),
            ),
            false,
        ),
        (
            "over-depth body",
            body(serde_json::json!({
                "method": "session.subscribe",
                "params": { "from": {"a": {"b": {"c": {"d": {"e": {"f": "start"}}}}}} },
            })),
            false,
        ),
    ];
    for (case, bytes, binary) in cases {
        let error = protocol::parse_request(&bytes, binary).expect_err(case);
        assert_eq!(error.code, "schema_violation", "{case}: {}", error.message);
    }
}

#[test]
fn the_512kib_boundary_admits_exactly_and_rejects_one_byte_over() {
    // Measure the fixed envelope around a one-byte prompt, then pad the
    // prompt so the whole body lands exactly on the cap.
    let probe = send_body("p", None);
    let envelope = probe.len() - 1;
    let at_cap = send_body(&"p".repeat(config::MAX_SEND_BODY_BYTES - envelope), None);
    assert_eq!(at_cap.len(), config::MAX_SEND_BODY_BYTES);
    assert!(matches!(
        protocol::parse_request(&at_cap, false).expect("boundary body is admitted"),
        Request::Send(_)
    ));

    let over_cap = send_body(
        &"p".repeat(config::MAX_SEND_BODY_BYTES - envelope + 1),
        None,
    );
    assert_eq!(over_cap.len(), config::MAX_SEND_BODY_BYTES + 1);
    let error = protocol::parse_request(&over_cap, false).expect_err("one byte over is rejected");
    assert_eq!(error.code, "schema_violation");
    assert!(error.message.contains("512 KiB"), "{}", error.message);
}

/// Exercises the component's bind checks directly: the host's control layer
/// refuses relative roots and empty identity fields before a bind, so these
/// component-level rejections are unreachable over the wire.
#[tokio::test]
async fn bind_requires_absolute_root_nonempty_session_and_supported_harness() {
    let component = BrocaComponent::new(ScriptedBackend::completing("out"));
    let identity = |root: &str, harness: &str, session: &str| RouteIdentity {
        project_root: root.into(),
        harness: harness.to_owned(),
        session: session.to_owned(),
        consumer_module_id: None,
        consumer_launch_nonce: None,
        consumer_capabilities: Vec::new(),
        admission_facts: None,
    };
    let route = |channel| RouteHandle { channel, epoch: 1 };
    let rejects = [
        ("relative root", identity("relative/path", "opencode", "s1")),
        ("empty root", identity("", "pi", "s1")),
        ("empty session", identity("/root", "opencode", "")),
        ("unsupported harness", identity("/root", "codex", "s1")),
        ("empty harness", identity("/root", "", "s1")),
    ];
    for (index, (case, identity)) in rejects.into_iter().enumerate() {
        let outcome = component.bind(route(index as u16), identity).await;
        let BindOutcome::Reject { code, .. } = outcome else {
            panic!("{case} must reject");
        };
        assert_eq!(code, "invalid_identity", "{case}");
    }
    for (index, harness) in ["opencode", "pi"].into_iter().enumerate() {
        let outcome = component
            .bind(route(100 + index as u16), identity("/root", harness, "s1"))
            .await;
        assert!(
            matches!(outcome, BindOutcome::Accept),
            "{harness} must bind"
        );
    }
}

#[test]
fn harness_vocabulary_is_closed() {
    assert_eq!(Harness::parse("opencode"), Some(Harness::OpenCode));
    assert_eq!(Harness::parse("pi"), Some(Harness::Pi));
    for alias in ["OpenCode", "PI", "opencode ", "codex", ""] {
        assert_eq!(Harness::parse(alias), None, "{alias:?} must not parse");
    }
}

/// One authenticated round trip through all five operations in the
/// historian order, asserting the exact JSON field names the Rust
/// producer's `unit_*` helpers and `classify_run_state` parse today.
#[tokio::test]
async fn five_operation_round_trip_matches_the_consumed_wire_shapes() {
    let backend = ScriptedBackend::completing("historian output");
    let component = BrocaComponent::new(Arc::clone(&backend) as Arc<_>);
    let supervisor = component.supervisor();
    let host = BrocaHost::start(component).await;
    let mut client = host.client().await;
    let (command_ch, command_ep) = open_broca_route(&mut client, "opencode", "hist:1").await;
    let (sub_ch, sub_ep) = open_broca_route(&mut client, "opencode", "hist:1").await;

    let response = call(
        &mut client,
        command_ch,
        command_ep,
        "session.send",
        send_params("summarize", Some("role guidance"), "prov/model-a"),
    )
    .await;
    assert_eq!(response.ty, support::raw_client::TY_RESPONSE);
    let run_id = response.json()["run_id"]
        .as_str()
        .expect("send returns run_id")
        .to_owned();

    // A byte-identical resend must return the original run and never start
    // a second backend.
    let replay = call(
        &mut client,
        command_ch,
        command_ep,
        "session.send",
        send_params("summarize", Some("role guidance"), "prov/model-a"),
    )
    .await;
    assert_eq!(replay.json()["run_id"], serde_json::json!(run_id));
    assert_eq!(backend.starts(), 1, "one backend start for the resend");

    let corr = send_call(
        &mut client,
        sub_ch,
        sub_ep,
        "session.subscribe",
        serde_json::json!({ "from": "start" }),
    )
    .await;
    let (units, terminal) = drain_subscribe(&mut client, corr).await;
    assert_eq!(terminal.ty, support::raw_client::TY_STREAM_END);
    assert_eq!(
        units.len(),
        3,
        "run_started, assistant, run_finished: {units:?}"
    );
    for unit in &units {
        assert_eq!(unit["kind"], "control");
        assert_eq!(unit["unit"]["run_id"], serde_json::json!(run_id));
    }
    assert_eq!(units[0]["unit"]["type"], "run_started");
    assert_eq!(units[1]["unit"]["type"], "assistant_message");
    assert_eq!(units[1]["unit"]["message"]["role"], "assistant");
    assert_eq!(
        units[1]["unit"]["message"]["content"],
        serde_json::json!([{ "type": "text", "text": "historian output" }])
    );
    assert_eq!(units[2]["unit"]["type"], "run_finished");
    assert_eq!(units[2]["unit"]["finish_reason"], "completed");

    // The inserted JSON whitespace does not change the parsed request, but
    // idempotency hashes exact request-body bytes, so this request
    // conflicts rather than deduplicates.
    let mut spaced_body = serde_json::to_vec(&serde_json::json!({
        "method": "session.send",
        "params": send_params("summarize", Some("role guidance"), "prov/model-a"),
    }))
    .expect("body serializes");
    spaced_body.insert(1, b' ');
    let corr = client.next_corr();
    client
        .send_frame(
            support::raw_client::TY_REQUEST,
            support::raw_client::FLAGS_INTERACTIVE,
            command_ch,
            command_ep,
            corr,
            &spaced_body,
        )
        .await
        .expect("send byte-different body");
    let (_skipped, conflict) = client
        .frames_until_corr(corr, support::broca::BUDGET)
        .await
        .expect("conflict terminal");
    assert_eq!(conflict.ty, support::raw_client::TY_ERROR);
    assert_eq!(conflict.error_code(), "idempotency_conflict");

    // A rejected idempotency conflict leaves later replays unchanged.
    let corr = send_call(
        &mut client,
        sub_ch,
        sub_ep,
        "session.subscribe",
        serde_json::json!({ "from": "start" }),
    )
    .await;
    let (replayed_units, replay_terminal) = drain_subscribe(&mut client, corr).await;
    assert_eq!(replay_terminal.ty, support::raw_client::TY_STREAM_END);
    assert_eq!(replayed_units, units);

    let status = call(
        &mut client,
        command_ch,
        command_ep,
        "run.status",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    assert_eq!(
        status.json(),
        serde_json::json!({ "run_id": run_id, "state": "completed" })
    );

    let cancelled = call(
        &mut client,
        command_ch,
        command_ep,
        "run.cancel",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    assert_eq!(cancelled.json(), serde_json::json!({ "ok": true }));
    // Cancel after completion is idempotent and cannot change the run's
    // committed state.
    let status = call(
        &mut client,
        command_ch,
        command_ep,
        "run.status",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    assert_eq!(status.json()["state"], "completed");

    let deleted = call(
        &mut client,
        command_ch,
        command_ep,
        "session.delete",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(deleted.json(), serde_json::json!({ "ok": true }));
    let status = call(
        &mut client,
        command_ch,
        command_ep,
        "run.status",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    assert_eq!(
        status.json(),
        serde_json::json!({ "run_id": run_id, "state": "missing" })
    );

    // The retained tombstone must block resurrection of the session.
    let resurrect = call(
        &mut client,
        command_ch,
        command_ep,
        "session.send",
        send_params("summarize", Some("role guidance"), "prov/model-a"),
    )
    .await;
    assert_eq!(resurrect.ty, support::raw_client::TY_ERROR);
    assert_eq!(resurrect.error_code(), "session_deleted");

    let metrics = supervisor.metrics();
    assert_eq!(metrics.tombstones, 1);
    assert_eq!(metrics.live_runs, 0);
    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn malformed_requests_over_the_host_create_no_run_state() {
    let backend = ScriptedBackend::completing("out");
    let component = BrocaComponent::new(Arc::clone(&backend) as Arc<_>);
    let supervisor = component.supervisor();
    let host = BrocaHost::start(component).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_broca_route(&mut client, "pi", "s1").await;

    let baseline = supervisor.metrics();
    for bytes in [
        b"not json at all".to_vec(),
        b"{\"method\":\"session.send\",\"params\":{},\"params\":{}}".to_vec(),
        serde_json::to_vec(&serde_json::json!({ "method": "run.everything" })).expect("body"),
    ] {
        let corr = client.next_corr();
        client
            .send_frame(
                support::raw_client::TY_REQUEST,
                support::raw_client::FLAGS_INTERACTIVE,
                channel,
                epoch,
                corr,
                &bytes,
            )
            .await
            .expect("send malformed request");
        let (_skipped, frame) = client
            .frames_until_corr(corr, support::broca::BUDGET)
            .await
            .expect("terminal");
        assert_eq!(frame.ty, support::raw_client::TY_ERROR);
        assert_eq!(frame.error_code(), "schema_violation");
    }
    assert_eq!(backend.starts(), 0, "no backend may start");
    assert_eq!(supervisor.metrics(), baseline, "no state may exist");
    host.shutdown().await.expect("graceful shutdown");
}
