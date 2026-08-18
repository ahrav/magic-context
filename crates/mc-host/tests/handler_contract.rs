//! `McHandler` must use `mc-host` types rather than the private `subc-*` SDK.

mod support;

use std::time::Duration;

use mc_host::{ConfigError, HostLimits};
use support::raw_client::{
    FLAGS_INTERACTIVE, TY_REQUEST, TY_RESPONSE, TY_STREAM_DATA, TY_STREAM_END,
};
use support::{mode_body, BindPolicy, Event, TestHost, LINKED_MODULE_ID};

const BUDGET: Duration = Duration::from_secs(5);
const ROOT: &str = "/workspace/project";

#[tokio::test]
async fn one_route_yields_one_bind_and_one_route_gone_for_the_same_handle() {
    let host = TestHost::start().await;
    let mut client = host.client().await;

    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "contract")
        .await
        .expect("route");

    let binds = host.handler.binds();
    assert_eq!(binds.len(), 1);
    assert_eq!(binds[0].channel, channel);
    assert_eq!(binds[0].epoch, epoch);
    assert!(
        host.handler.route_gones().is_empty(),
        "route-gone must not fire while the route is live"
    );

    drop(client);

    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let gones = host.handler.route_gones();
        if !gones.is_empty() {
            assert_eq!(gones, binds, "route-gone carries the bound handle");
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "route-gone missing");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let events = host.handler.events();
    assert_eq!(
        events.iter().filter(|e| **e == Event::Initialized).count(),
        1,
        "initialization runs exactly once"
    );
    assert_eq!(
        events.first(),
        Some(&Event::Initialized),
        "initialization precedes every bind"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn the_handler_sees_the_exact_bound_identity() {
    let host = TestHost::start().await;
    let mut client = host.client().await;

    client
        .control(&serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {
                "project_root": "/workspace/exact",
                "harness": "pi",
                "session": "session-exact"
            },
            "consumer_identity": {"module_id": "plugin", "launch_nonce": "nonce-exact"},
            "consumer_capabilities": ["elicitation", "roots"],
            "admission_facts": {"tier": "first_party"}
        }))
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("response");
    assert_eq!(frame.ty, TY_RESPONSE);

    let identities = host.handler.identities();
    assert_eq!(identities.len(), 1);
    let identity = &identities[0].1;
    assert_eq!(
        identity.project_root,
        std::path::PathBuf::from("/workspace/exact")
    );
    assert_eq!(identity.harness, "pi");
    assert_eq!(identity.session, "session-exact");
    assert_eq!(identity.consumer_module_id.as_deref(), Some("plugin"));
    assert_eq!(
        identity.consumer_launch_nonce.as_deref(),
        Some("nonce-exact")
    );
    assert_eq!(identity.consumer_capabilities, ["elicitation", "roots"]);
    assert_eq!(
        identity.admission_facts,
        Some(serde_json::json!({"tier": "first_party"}))
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn every_request_outcome_is_expressible() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "outcomes")
        .await
        .expect("route");

    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &support::echo_body("unary"),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.ty, TY_RESPONSE);

    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "stream", "items": 2})),
        )
        .await
        .expect("send");
    let mut kinds = Vec::new();
    loop {
        let frame = client.frame_within(BUDGET).await.expect("stream frame");
        kinds.push(frame.ty);
        if frame.ty == TY_STREAM_END {
            break;
        }
    }
    assert_eq!(kinds, vec![TY_STREAM_DATA, TY_STREAM_DATA, TY_STREAM_END]);

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
                "code": "handler_specific",
                "message": "chosen by the module"
            })),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "handler_specific");

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn cancellation_is_observable_through_the_request_context() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "cancel-ctx")
        .await
        .expect("route");

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
        .expect("send");
    let deadline = tokio::time::Instant::now() + BUDGET;
    while host.handler.dispatch_count() == 0 {
        assert!(tokio::time::Instant::now() < deadline, "handler never ran");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    client
        .send_frame(
            support::raw_client::TY_CANCEL,
            support::raw_client::FLAGS_PURE_HEADER,
            channel,
            epoch,
            corr,
            &[],
        )
        .await
        .expect("cancel");

    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(
        frame.error_code(),
        "cancelled",
        "the host selects the terminal, not the handler"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn a_rejected_bind_carries_the_handler_code_to_the_client() {
    let host = TestHost::start().await;
    host.handler.set_bind_policy(BindPolicy::RejectSession {
        session: "nope".to_owned(),
        code: "module_reloading".to_owned(),
        message: "not ready".to_owned(),
    });
    let mut client = host.client().await;

    client
        .control(&serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "nope"}
        }))
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "module_reloading");

    host.shutdown_gracefully().await;
}

#[test]
fn limit_defaults_are_finite_and_validated() {
    let defaults = HostLimits::default();
    defaults.validate().expect("defaults must be usable");
    assert!(defaults.max_handshakes > 0);
    assert!(defaults.max_connections > 0);
    assert!(defaults.max_routes > 0);
    assert!(defaults.max_pending_requests > 0);
    assert!(defaults.max_handler_tasks > 0);
    assert!(defaults.writer_queue_frames > 0);
    assert!(
        defaults.max_resident_bytes >= mc_host::config::MIN_RESIDENT_BYTES,
        "defaults must keep one maximum-size frame interoperable"
    );

    let zeroed = HostLimits {
        max_handler_tasks: 0,
        ..Default::default()
    };
    assert_eq!(
        zeroed.validate(),
        Err(ConfigError::ZeroLimit {
            name: "max_handler_tasks"
        }),
        "zero must be rejected rather than mean unbounded"
    );

    let starved = HostLimits {
        max_resident_bytes: 1024,
        ..Default::default()
    };
    assert!(matches!(
        starved.validate(),
        Err(ConfigError::ResidentBytesBelowInteropMinimum { .. })
    ));

    let tightened = HostLimits {
        max_handshakes: 1,
        max_connections: 1,
        max_routes: 1,
        max_pending_requests: 1,
        max_handler_tasks: 1,
        writer_queue_frames: 1,
        max_resident_bytes: mc_host::config::MIN_RESIDENT_BYTES,
    };
    tightened
        .validate()
        .expect("minimal but interoperable limits are valid");
}
