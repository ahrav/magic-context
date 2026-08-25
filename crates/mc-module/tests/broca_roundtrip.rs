#![cfg(unix)]
#![forbid(unsafe_code)]

mod support;

use std::time::{Duration, Instant};

use mc_host::{RequestOptions, ResponseStream, TargetKind};
use serde_json::{json, Value};
use support::direct_host::{request_json, send_body, FixtureProcess, BUDGET};

async fn subscribe(client: &mc_host::Client, route: mc_host::RouteHandle) -> ResponseStream {
    client
        .request_stream(
            route,
            serde_json::to_vec(&json!({
                "method": "session.subscribe",
                "params": {"from": "start"}
            }))
            .expect("subscribe serializes"),
            RequestOptions {
                timeout: BUDGET,
                cancellation: None,
            },
        )
        .await
        .expect("subscription starts")
}

async fn drain(stream: &mut ResponseStream) -> Vec<Value> {
    let mut items = Vec::new();
    while let Some(item) = stream.next().await.expect("subscription settles") {
        items.push(serde_json::from_slice(&item.body).expect("stream item JSON"));
    }
    items
}

fn unit_type(item: &Value) -> Option<&str> {
    item["unit"]["type"].as_str()
}

async fn wait_for_counter(fixture: &FixtureProcess, field: &str, value: u64) {
    let deadline = Instant::now() + BUDGET;
    loop {
        if fixture.counters(500)[field] == value {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "counter {field} never reached {value}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn real_broca_success_block_release_failure_and_counters() {
    let fixture = FixtureProcess::start();
    let client = fixture.client().await;
    let success_route = fixture
        .open_route(
            &client,
            "broca",
            TargetKind::ManagementSurface,
            "successful-broca",
        )
        .await;

    let success_control = fixture.control(1, "backend-success");
    assert_eq!(success_control["id"], 1);
    assert_eq!(success_control["ok"], true);
    let success = request_json(&client, success_route, send_body("success request")).await;
    assert!(success["run_id"].is_string());
    let mut success_stream = subscribe(&client, success_route).await;
    let success_items = drain(&mut success_stream).await;
    assert_eq!(
        success_items
            .iter()
            .filter_map(unit_type)
            .collect::<Vec<_>>(),
        ["run_started", "assistant_message", "run_finished"]
    );
    assert_eq!(
        success_items[1]["unit"]["message"]["content"][0]["text"],
        "fixture-success"
    );

    let blocked_route = fixture
        .open_route(
            &client,
            "broca",
            TargetKind::ManagementSurface,
            "blocked-broca",
        )
        .await;
    assert_eq!(fixture.control(2, "block-next-call")["ok"], true);
    let blocked = request_json(&client, blocked_route, send_body("blocked request")).await;
    assert!(blocked["run_id"].is_string());
    wait_for_counter(&fixture, "blocked", 1).await;
    let mut blocked_stream = subscribe(&client, blocked_route).await;
    let released = fixture.control(3, "release-blocked-call");
    assert_eq!(released["id"], 3);
    assert_eq!(released["result"]["accepted"], true);
    let blocked_items = drain(&mut blocked_stream).await;
    assert_eq!(
        blocked_items[1]["unit"]["message"]["content"][0]["text"],
        "fixture-released"
    );

    let failed_route = fixture
        .open_route(
            &client,
            "broca",
            TargetKind::ManagementSurface,
            "failed-broca",
        )
        .await;
    assert_eq!(fixture.control(4, "typed-failure")["ok"], true);
    let failed = request_json(&client, failed_route, send_body("failure request")).await;
    assert!(failed["run_id"].is_string());
    let mut failed_stream = subscribe(&client, failed_route).await;
    let failed_items = drain(&mut failed_stream).await;
    let error = failed_items
        .iter()
        .find(|item| unit_type(item) == Some("error"))
        .expect("typed failure event");
    assert_eq!(error["unit"]["error"]["class"], "permanent");
    assert_eq!(error["unit"]["error"]["provider_code"], "fixture_terminal");

    let counters = fixture.counters(5);
    assert_eq!(counters["started"], 3);
    assert_eq!(counters["completed"], 2);
    assert_eq!(counters["blocked"], 1);
    assert_eq!(counters["released"], 1);
    assert_eq!(counters["failed"], 1);
    assert_eq!(counters["cancelled"], 0);

    client.close().await.expect("managed client closes");
    fixture.shutdown();
}

#[tokio::test]
async fn real_broca_cancel_shutdown_and_full_route_handle_cleanup() {
    let fixture = FixtureProcess::start();
    let client = fixture.client().await;
    let route = fixture
        .open_route(
            &client,
            "broca",
            TargetKind::ManagementSurface,
            "cancelled-broca",
        )
        .await;
    assert_eq!(fixture.control(1, "block-next-call")["ok"], true);
    let sent = request_json(&client, route, send_body("cancel request")).await;
    let run_id = sent["run_id"].as_str().expect("run id").to_owned();
    wait_for_counter(&fixture, "blocked", 1).await;
    let cancelled = request_json(
        &client,
        route,
        json!({"method": "run.cancel", "params": {"run_id": run_id}}),
    )
    .await;
    assert_eq!(cancelled["ok"], true);
    wait_for_counter(&fixture, "cancelled", 1).await;
    let status = request_json(
        &client,
        route,
        json!({"method": "run.status", "params": {"run_id": run_id}}),
    )
    .await;
    assert_eq!(status["state"], "cancelled");

    client.close_route(route).await.expect("old route closes");
    let replacement = fixture
        .open_route(
            &client,
            "broca",
            TargetKind::ManagementSurface,
            "replacement-broca",
        )
        .await;
    assert_ne!(route, replacement, "reused channel must carry a new epoch");
    let old = client
        .request(
            route,
            serde_json::to_vec(&send_body("stale route")).unwrap(),
            RequestOptions::default(),
        )
        .await
        .expect_err("closed full handle is rejected");
    assert_eq!(old.code(), "route_not_live");
    let replacement_response = request_json(&client, replacement, send_body("new route")).await;
    assert!(replacement_response["run_id"].is_string());

    client.close().await.expect("managed client closes");
    fixture.shutdown();
}
