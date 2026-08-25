#![cfg(unix)]
#![forbid(unsafe_code)]

mod support;

use std::fs;
use std::process::Command;
use std::time::{Duration, Instant};

use mc_host::TargetKind;
use mc_store::{McStore, StoredCompartment};
use serde_json::{json, Value};
use support::direct_host::{
    mode, request_json, send_body, storage_descriptor, workspace_root, FixtureProcess, BUDGET,
    REDACTION_SENTINEL,
};

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        encoded.push(TABLE[((value >> 18) & 0x3f) as usize] as char);
        encoded.push(TABLE[((value >> 12) & 0x3f) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            TABLE[(value & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    encoded
}

fn redaction_forms(publication: &str) -> Vec<String> {
    let connection: Value = serde_json::from_str(publication).expect("publication JSON");
    let mut forms = vec![publication.to_owned()];
    for field in ["key", "daemon_id"] {
        let bytes = connection[field]
            .as_array()
            .expect("byte array")
            .iter()
            .map(|value| value.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        forms.push(serde_json::to_string(&bytes).unwrap());
        forms.push(format!(
            "[{}]",
            bytes
                .iter()
                .map(u8::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ));
        forms.push(bytes.iter().map(|byte| format!("{byte:02x}")).collect());
        forms.push(base64(&bytes));
    }
    forms
}

async fn wait_for_store(client: &mc_host::Client, route: mc_host::RouteHandle, session: &str) {
    let deadline = Instant::now() + BUDGET;
    loop {
        let body = serde_json::to_vec(&json!({"kind": "status", "session_id": session})).unwrap();
        match client
            .request(
                route,
                body,
                mc_host::RequestOptions {
                    timeout: BUDGET,
                    cancellation: None,
                },
            )
            .await
        {
            Ok(response) => {
                let status: Value = serde_json::from_slice(&response.body).unwrap();
                if status["store_open"] == true {
                    return;
                }
            }
            Err(error) if error.code() == "store_unavailable" => {}
            Err(error) => panic!("store readiness request failed: {error}"),
        }
        assert!(Instant::now() < deadline, "module store did not open");
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn readiness_permissions_catalog_and_real_unary_transform() {
    let fixture = FixtureProcess::start();
    let immediate_control = fixture.control(0, "counters");
    assert_eq!(immediate_control["ok"], true);
    assert_eq!(mode(fixture.root()), 0o700);
    assert_eq!(mode(&fixture.control_path()), 0o600);
    assert_eq!(mode(&fixture.connection_file()), 0o600);

    let info = mc_host::read_connection_file(fixture.connection_file())
        .expect("strict connection publication");
    assert_eq!(info.wire_version, 2);
    assert_eq!(
        fixture.readiness()["catalog"],
        json!(["magic-context", "synapse", "broca"])
    );

    let client = fixture.client().await;
    let session = "direct-unary";
    let primary = fixture
        .open_route(&client, "magic-context", TargetKind::ToolProvider, session)
        .await;
    let synapse = fixture
        .open_route(
            &client,
            "synapse",
            TargetKind::ManagementSurface,
            "synapse-route",
        )
        .await;
    let broca = fixture
        .open_route(
            &client,
            "broca",
            TargetKind::ManagementSurface,
            "broca-route",
        )
        .await;
    wait_for_store(&client, primary, session).await;

    let response = request_json(
        &client,
        primary,
        json!({
            "kind": "transform",
            "v": 2,
            "session_id": session,
            "serializer_profile": "owned-llmrunner",
            "render_config": "direct-host-config",
            "full_array_fingerprint": "direct-host-fingerprint",
            "messages": [{
                "mid": "m1",
                "ordinal": 1,
                "ck": {
                    "role": "user",
                    "content": [{"kind": {"type": "text", "text": "direct host request"}}],
                    "meta": {"harness_id": "m1"}
                }
            }]
        }),
    )
    .await;
    assert_eq!(response["status"], "ok");
    assert_eq!(response["served_from"], "transform");
    assert_eq!(
        response["full_array_fingerprint"],
        "direct-host-fingerprint"
    );

    client
        .close_route(primary)
        .await
        .expect("primary route closes");
    client
        .close_route(synapse)
        .await
        .expect("synapse route closes");
    client.close_route(broca).await.expect("broca route closes");
    client.close().await.expect("managed client closes");
    fixture.shutdown();
}

#[tokio::test]
async fn direct_primary_replays_transform_state_across_fixture_restart() {
    let root = tempfile::tempdir().expect("persistent fixture root");
    fs::create_dir_all(root.path().join("project")).expect("project root");
    let descriptor = storage_descriptor(root.path());
    let store = McStore::open(&descriptor).expect("seed store opens");
    store
        .replace_compartments(
            "restart-transform",
            &[StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 10,
                end_message_id: "m10#0".to_owned(),
                title: "Seeded compartment".to_owned(),
                content: "RESTART-SUMMARY".to_owned(),
                p1: Some("RESTART-SUMMARY".to_owned()),
                importance: 50,
                ..Default::default()
            }],
        )
        .expect("compartment seed commits");
    drop(store);

    let request = json!({
        "kind": "transform",
        "v": 2,
        "session_id": "restart-transform",
        "serializer_profile": "owned-llmrunner",
        "render_config": "restart-config",
        "messages": [
            {
                "mid": "m10",
                "ordinal": 10,
                "ck": {
                    "role": "user",
                    "content": [{"kind": {"type": "text", "text": "covered"}}],
                    "meta": {"harness_id": "m10"}
                }
            },
            {
                "mid": "m11",
                "ordinal": 11,
                "ck": {
                    "role": "user",
                    "content": [{"kind": {"type": "text", "text": "tail"}}],
                    "meta": {"harness_id": "m11"}
                }
            }
        ]
    });

    let first = FixtureProcess::start_at(root.path().to_path_buf());
    let client = first.client().await;
    let route = first
        .open_route(
            &client,
            "magic-context",
            TargetKind::ToolProvider,
            "restart-transform",
        )
        .await;
    wait_for_store(&client, route, "restart-transform").await;
    let materialized = request_json(&client, route, request.clone()).await;
    assert_eq!(materialized["action"], "HARD");
    let first_m0 = materialized["ck_messages"]
        .as_array()
        .expect("ck messages")
        .iter()
        .find(|message| message["meta"]["synthetic"] == true)
        .expect("synthetic m0")["content"][0]["kind"]["text"]
        .as_str()
        .expect("m0 text")
        .to_owned();
    assert!(first_m0.contains("RESTART-SUMMARY"));
    client.close().await.expect("first client closes");
    first.shutdown();

    let second = FixtureProcess::start_at(root.path().to_path_buf());
    let client = second.client().await;
    let route = second
        .open_route(
            &client,
            "magic-context",
            TargetKind::ToolProvider,
            "restart-transform",
        )
        .await;
    wait_for_store(&client, route, "restart-transform").await;
    let replay = request_json(&client, route, request).await;
    assert_eq!(replay["action"], "SOFT+");
    let replay_m0 = replay["ck_messages"]
        .as_array()
        .expect("ck messages")
        .iter()
        .find(|message| message["meta"]["synthetic"] == true)
        .expect("synthetic m0")["content"][0]["kind"]["text"]
        .as_str()
        .expect("m0 text");
    assert_eq!(replay_m0, first_m0);
    client.close().await.expect("second client closes");
    second.shutdown();
}

#[tokio::test]
async fn malformed_unknown_duplicate_and_overcap_controls_do_not_mutate_backend() {
    let fixture = FixtureProcess::start();
    let publication = fs::read_to_string(fixture.connection_file()).expect("publication readable");
    let redaction_forms = redaction_forms(&publication);
    let sensitive_blob = format!("{}|{}", REDACTION_SENTINEL, redaction_forms.join("|"));
    let before = fixture.counters(1);

    let unknown = fixture.control_raw(
        format!(
            "{}\n",
            json!({"id": 2, "command": {"name": format!("unknown-{REDACTION_SENTINEL}")}})
        )
        .as_bytes(),
    );
    assert_eq!(unknown["id"], 2);
    assert_eq!(unknown["ok"], false);
    assert_eq!(unknown["error"]["code"], "unknown_command");

    let malformed = fixture.control_raw(
        format!(
            "{{\"id\":3,\"secret\":{},\"command\":\n",
            json!(&sensitive_blob)
        )
        .as_bytes(),
    );
    assert_eq!(malformed["ok"], false);
    assert_eq!(malformed["error"]["code"], "malformed_request");

    let duplicate = fixture.control_raw(
        format!(
            "{{\"id\":4,\"id\":5,\"secret\":{},\"command\":{{\"name\":\"block-next-call\"}}}}\n",
            json!(&sensitive_blob)
        )
        .as_bytes(),
    );
    assert_eq!(duplicate["ok"], false);
    assert_eq!(duplicate["error"]["code"], "malformed_request");

    let mut oversized = serde_json::to_string(&sensitive_blob).unwrap().into_bytes();
    oversized.resize(64 * 1024 + 1, b'x');
    oversized.push(b'\n');
    let overcap = fixture.control_raw(&oversized);
    assert_eq!(overcap["ok"], false);
    assert_eq!(overcap["error"]["code"], "request_too_large");

    assert_eq!(fixture.counters(6), before);

    let client = fixture.client().await;
    let route = fixture
        .open_route(
            &client,
            "broca",
            TargetKind::ManagementSurface,
            "malformed-control",
        )
        .await;
    let sent = request_json(&client, route, send_body("state probe")).await;
    assert!(sent["run_id"].is_string());
    let deadline = Instant::now() + BUDGET;
    loop {
        let counters = fixture.counters(7);
        if counters["completed"] == 1 {
            assert_eq!(counters["blocked"], 0);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "default success state was mutated"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    client.close().await.expect("managed client closes");
    let readiness = fixture.readiness().to_string();
    let output = fixture.shutdown();
    let surfaces = format!(
        "{unknown}\n{malformed}\n{duplicate}\n{overcap}\n{before}\n{readiness}\n{}\n{}",
        output.stdout, output.stderr
    );
    assert!(!surfaces.contains(REDACTION_SENTINEL));
    for form in redaction_forms {
        assert!(
            !surfaces.contains(&form),
            "secret form leaked across fixture surfaces: {form}"
        );
    }
}

#[tokio::test]
async fn control_shutdown_cleans_state_and_redacts_all_fixture_surfaces() {
    let fixture = FixtureProcess::start();
    let publication = fs::read_to_string(fixture.connection_file()).expect("publication readable");
    let client = fixture.client().await;
    let route = fixture
        .open_route(&client, "broca", TargetKind::ManagementSurface, "redaction")
        .await;
    assert_eq!(fixture.control(1, "block-next-call")["ok"], true);
    let sent = request_json(&client, route, send_body(REDACTION_SENTINEL)).await;
    assert!(sent["run_id"].is_string());
    let deadline = Instant::now() + BUDGET;
    let counters = loop {
        let counters = fixture.counters(7);
        if counters["blocked"] == 1 {
            break counters;
        }
        assert!(Instant::now() < deadline, "backend call never blocked");
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let readiness = fixture.readiness().to_string();
    let output = fixture.shutdown();
    drop(client);
    let surfaces = format!(
        "{readiness}\n{counters}\n{}\n{}",
        output.stdout, output.stderr
    );
    assert!(!surfaces.contains(REDACTION_SENTINEL));
    for form in redaction_forms(&publication) {
        assert!(
            !surfaces.contains(&form),
            "secret form leaked across fixture surfaces: {form}"
        );
    }
}

#[tokio::test]
async fn sigterm_releases_blocked_backend_and_cleans_runtime_state() {
    let mut fixture = FixtureProcess::start();
    let block = fixture.control(1, "block-next-call");
    assert_eq!(block["id"], 1);
    assert_eq!(block["ok"], true);
    let client = fixture.client().await;
    let route = fixture
        .open_route(
            &client,
            "broca",
            TargetKind::ManagementSurface,
            "sigterm-blocked",
        )
        .await;
    let response = request_json(&client, route, send_body(REDACTION_SENTINEL)).await;
    assert!(response["run_id"].is_string());

    let deadline = Instant::now() + BUDGET;
    while fixture.counters(2)["blocked"] != 1 {
        assert!(Instant::now() < deadline, "backend call never blocked");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    fixture.signal_term();
    drop(client);
    let output = fixture.wait_for_exit();
    assert!(!output.stdout.contains(REDACTION_SENTINEL));
    assert!(!output.stderr.contains(REDACTION_SENTINEL));
}

#[test]
fn cargo_metadata_has_no_ck_mc_binary() {
    let output = Command::new("cargo")
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .current_dir(workspace_root())
        .output()
        .expect("cargo metadata runs");
    assert!(output.status.success(), "cargo metadata failed");
    let metadata: Value = serde_json::from_slice(&output.stdout).expect("metadata JSON");
    let package = metadata["packages"]
        .as_array()
        .expect("packages")
        .iter()
        .find(|package| package["name"] == "mc-module")
        .expect("mc-module package");
    let targets = package["targets"].as_array().expect("targets");
    let removed_binary = ["ck", "mc"].join("-");
    assert!(targets.iter().all(|target| {
        target["name"] != removed_binary
            && !target["kind"]
                .as_array()
                .expect("target kind")
                .iter()
                .any(|kind| kind == "bin")
    }));
}
