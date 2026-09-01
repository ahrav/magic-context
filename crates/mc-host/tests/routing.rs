mod support;

use std::collections::HashSet;
use std::time::Duration;

use support::raw_client::{
    self, FLAGS_INTERACTIVE, FLAGS_PURE_HEADER, TY_GOODBYE, TY_REQUEST, TY_RESPONSE,
};
use support::{BindPolicy, Event, TestHost, LINKED_MODULE_ID, MODULE_VERSION};

const BUDGET: Duration = Duration::from_secs(5);
const ROOT: &str = "/workspace/project";

/// A control request produces exactly one terminal frame.
async fn control_once(
    client: &mut raw_client::RawClient,
    body: serde_json::Value,
) -> raw_client::RawFrame {
    let corr = client.control(&body).await.expect("send control");
    let (skipped, frame) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("one terminal");
    assert!(
        skipped.is_empty(),
        "a control request must produce exactly one frame, also saw {skipped:?}"
    );
    frame
}

#[tokio::test]
async fn catalog_is_truthful_and_filters_exactly() {
    let host = TestHost::start().await;
    let mut client = host.client().await;

    let unfiltered = control_once(&mut client, serde_json::json!({"op": "catalog.list"})).await;
    assert_eq!(unfiltered.ty, TY_RESPONSE);
    let json = unfiltered.json();
    assert_eq!(json["op"], "catalog.list");
    assert!(json["generation"].is_u64());
    let modules = json["modules"].as_array().expect("modules array");
    assert_eq!(modules.len(), 1);
    assert_eq!(modules[0]["module_id"], LINKED_MODULE_ID);
    assert_eq!(modules[0]["module_version"], MODULE_VERSION);
    // The host preserves manifest fields it does not understand.
    assert_eq!(
        modules[0]["roles"][0]["tools"][0]["name"], "ctx_reduce",
        "tool schemas must reach the client intact"
    );
    assert_eq!(
        modules[0]["roles"][0]["forward_compatible_extra"]["nested"],
        true
    );
    assert_eq!(
        json["subc_ops"],
        serde_json::json!(["route.open", "catalog.list", "host.shutdown", "host.status"])
    );
    assert!(!unfiltered
        .body
        .windows(18)
        .any(|w| w == b"transport.activate"));
    assert!(!unfiltered
        .body
        .windows(16)
        .any(|w| w == b"transport.commit"));
    // The direct host exposes only `health.check`.
    support::assert_control_ops(&json["modules"], &["health.check"]);

    let exact = control_once(
        &mut client,
        serde_json::json!({"op": "catalog.list", "module_id": LINKED_MODULE_ID}),
    )
    .await;
    let exact_json = exact.json();
    assert_eq!(exact_json["modules"].as_array().expect("array").len(), 1);
    support::assert_control_ops(&exact_json["modules"], &["health.check"]);

    let unknown = control_once(
        &mut client,
        serde_json::json!({"op": "catalog.list", "module_id": "not-linked"}),
    )
    .await;
    assert_eq!(unknown.ty, TY_RESPONSE, "an unknown filter is not an error");
    assert!(unknown.json()["modules"]
        .as_array()
        .expect("array")
        .is_empty());

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn unsupported_operations_leave_the_generation_usable() {
    let host = TestHost::start().await;
    let mut client = host.client().await;

    for op in [
        "server.describe",
        "route.poll",
        "supervisor.list",
        "wake.create",
        "health",
        "transport.activate",
        "transport.commit",
    ] {
        let frame = control_once(&mut client, serde_json::json!({"op": op})).await;
        assert_eq!(
            frame.error_code(),
            "unsupported_operation",
            "{op} must be refused as unsupported"
        );
    }

    // The connection still serves a supported operation afterwards.
    let frame = control_once(&mut client, serde_json::json!({"op": "catalog.list"})).await;
    assert_eq!(frame.ty, TY_RESPONSE);
    assert!(
        host.handler.binds().is_empty(),
        "an unsupported operation must not reach the handler"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn bounded_metadata_accepts_its_maximum_and_rejects_one_past_it() {
    let host = TestHost::start().await;
    let mut client = host.client().await;

    let base = |session: serde_json::Value| {
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": session}
        })
    };

    // The session rejects payloads larger than 256 bytes.
    let at_max = control_once(&mut client, base(serde_json::json!("s".repeat(256)))).await;
    assert_eq!(at_max.ty, TY_RESPONSE, "the exact maximum must be accepted");

    let over = control_once(&mut client, base(serde_json::json!("s".repeat(257)))).await;
    assert_eq!(over.error_code(), "invalid_control_request");

    let with_nul = control_once(&mut client, base(serde_json::json!("ses\0sion"))).await;
    assert_eq!(with_nul.error_code(), "invalid_control_request");

    // Validation rejects relative project roots before any handler work.
    let relative = control_once(
        &mut client,
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": "relative/path", "harness": "opencode", "session": "s"}
        }),
    )
    .await;
    assert_eq!(relative.error_code(), "invalid_control_request");

    // `admission_facts` limits compact input to 8,192 bytes and nesting to depth 32.
    let facts_at_max = serde_json::Value::String("f".repeat(8_190));
    let ok = control_once(
        &mut client,
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "facts"},
            "admission_facts": facts_at_max
        }),
    )
    .await;
    assert_eq!(ok.ty, TY_RESPONSE);

    let facts_over = serde_json::Value::String("f".repeat(8_191));
    let rejected = control_once(
        &mut client,
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "facts"},
            "admission_facts": facts_over
        }),
    )
    .await;
    assert_eq!(rejected.error_code(), "invalid_control_request");

    // `admission_facts` caps capabilities at 32.
    let too_many: Vec<serde_json::Value> = (0..33)
        .map(|index| serde_json::json!(format!("cap-{index}")))
        .collect();
    let rejected = control_once(
        &mut client,
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "caps"},
            "consumer_capabilities": too_many
        }),
    )
    .await;
    assert_eq!(rejected.error_code(), "invalid_control_request");

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn malformed_control_bodies_are_refused_before_handler_work() {
    let host = TestHost::start().await;
    let mut client = host.client().await;

    // Validation rejects duplicate recognized fields.
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            0,
            0,
            corr,
            br#"{"op":"catalog.list","op":"route.open"}"#,
        )
        .await
        .expect("send duplicate");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "invalid_control_request");

    // Invalid UTF-8.
    let corr = client.next_corr();
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, corr, &[0xff, 0xfe])
        .await
        .expect("send invalid utf8");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "invalid_control_request");

    // The binary flag is illegal on the JSON-only control channel.
    let corr = client.next_corr();
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE | 0b1, 0, 0, corr, b"{}")
        .await
        .expect("send binary control");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "invalid_control_request");

    assert!(
        host.handler.binds().is_empty(),
        "malformed control must never invoke bind"
    );
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn unroutable_targets_are_classified_distinctly() {
    let host = TestHost::start().await;
    let mut client = host.client().await;

    let frame = control_once(
        &mut client,
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "internal_service", "module_id": "thalamus", "service_id": "svc"},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "s"}
        }),
    )
    .await;
    assert_eq!(
        frame.error_code(),
        "target_unavailable",
        "internal_service is not routable on this profile"
    );

    for kind in ["tool_provider", "management_surface"] {
        let frame = control_once(
            &mut client,
            serde_json::json!({
                "op": "route.open",
                "target": {"kind": kind, "module_id": "thalamus"},
                "identity": {"project_root": ROOT, "harness": "opencode", "session": "s"}
            }),
        )
        .await;
        assert_eq!(
            frame.error_code(),
            "unknown_module",
            "a recognized kind naming an absent module is unknown_module"
        );
    }

    let frame = control_once(
        &mut client,
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "management_surface", "module_id": "magic-context"},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "s"}
        }),
    )
    .await;
    assert_eq!(
        frame.error_code(),
        "target_unavailable",
        "a known module with an unadvertised role is target_unavailable"
    );

    let frame = control_once(
        &mut client,
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": "magic-context-next"},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "s"}
        }),
    )
    .await;
    assert_eq!(frame.error_code(), "unknown_module");

    assert!(
        host.handler.binds().is_empty(),
        "an unroutable target must not reach bind"
    );
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn identity_reaches_the_handler_as_bounded_claims() {
    let host = TestHost::start().await;
    let mut client = host.client().await;

    let frame = control_once(
        &mut client,
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {
                "project_root": ROOT,
                "harness": "opencode",
                "session": support::CANARY_SESSION
            },
            "consumer_identity": {"module_id": "plugin", "launch_nonce": "nonce-1"},
            "consumer_capabilities": ["elicitation", "sampling"],
            "admission_facts": {"tier": "first_party"}
        }),
    )
    .await;
    assert_eq!(frame.ty, TY_RESPONSE);

    let binds = host.handler.events();
    let bound_session = binds
        .iter()
        .find_map(|event| match event {
            Event::Bind(_, session) => Some(session.clone()),
            _ => None,
        })
        .expect("handler observed one bind");
    assert_eq!(bound_session, support::CANARY_SESSION);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn concurrent_generations_receive_distinct_live_channels() {
    let host = TestHost::start().await;
    let mut first = host.client().await;
    let mut second = host.client().await;

    let mut channels = HashSet::new();
    // Each distinct (root, session) pair uses distinct session state.
    let (channel, epoch) = first
        .route_open(LINKED_MODULE_ID, "/workspace/a", "opencode", "shared")
        .await
        .expect("first route");
    assert!(channels.insert(channel));
    let (other_channel, other_epoch) = first
        .route_open(LINKED_MODULE_ID, "/workspace/b", "opencode", "shared")
        .await
        .expect("second root, same session");
    assert!(channels.insert(other_channel));
    let (third_channel, _) = second
        .route_open(LINKED_MODULE_ID, "/workspace/a", "opencode", "other")
        .await
        .expect("second generation route");
    assert!(channels.insert(third_channel));

    assert_ne!(epoch, 0);
    assert_ne!(other_epoch, 0);
    assert_eq!(channels.len(), 3, "live channels must be globally unique");
    assert_eq!(host.handler.binds().len(), 3);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn rejected_bind_never_publishes_and_still_reports_route_gone() {
    let host = TestHost::start().await;
    host.handler.set_bind_policy(BindPolicy::RejectSession {
        session: "denied".to_owned(),
        code: "policy_denied".to_owned(),
        message: "handler refused".to_owned(),
    });
    let mut client = host.client().await;

    let frame = control_once(
        &mut client,
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "denied"}
        }),
    )
    .await;
    assert_eq!(frame.error_code(), "policy_denied");

    let binds = host.handler.binds();
    let gones = host.handler.route_gones();
    assert_eq!(binds.len(), 1);
    assert_eq!(
        gones, binds,
        "the handler observed the handle, so route-gone is owed exactly once"
    );

    // Rejected roots do not prevent a permitted session from binding.
    let ok = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "allowed")
        .await
        .expect("a later route still opens");
    assert_ne!(ok.0, 0);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn closed_route_requests_are_unknown_and_cleanup_is_idempotent() {
    let host = TestHost::start().await;
    let mut client = host.client().await;

    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "first")
        .await
        .expect("route");

    // Closing a route makes its previous epoch inert.
    client
        .send_frame(TY_GOODBYE, FLAGS_PURE_HEADER, channel, epoch, 0, &[])
        .await
        .expect("route goodbye");

    // Requests on a closed epoch are never dispatched.
    let before = host.handler.dispatch_count();
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &support::echo_body("stale"),
        )
        .await
        .expect("stale request");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.error_code(), "unknown_channel");
    assert_eq!(
        host.handler.dispatch_count(),
        before,
        "unknown_channel must prove zero handler dispatch"
    );

    // A stale Cancel and a duplicate Goodbye are idempotent no-ops.
    client
        .send_frame(6, FLAGS_PURE_HEADER, channel, epoch, corr, &[])
        .await
        .expect("stale cancel");
    client
        .send_frame(TY_GOODBYE, FLAGS_PURE_HEADER, channel, epoch, 0, &[])
        .await
        .expect("duplicate goodbye");

    // `Cancel` and duplicate `Goodbye` leave the connection usable.
    // corruption.
    let frame = control_once(&mut client, serde_json::json!({"op": "catalog.list"})).await;
    assert_eq!(frame.ty, TY_RESPONSE);

    let gones = host.handler.route_gones();
    assert_eq!(
        gones
            .iter()
            .filter(|handle| handle.channel == channel)
            .count(),
        1,
        "route-gone must fire exactly once despite the duplicate Goodbye"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn a_generation_cannot_close_another_generations_route() {
    let host = TestHost::start().await;
    let mut first = host.client().await;
    let mut second = host.client().await;
    let (first_channel, first_epoch) = first
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "first-owner")
        .await
        .expect("first route");
    let (second_channel, second_epoch) = second
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "second-owner")
        .await
        .expect("second route");

    first
        .send_frame(
            TY_GOODBYE,
            FLAGS_PURE_HEADER,
            second_channel,
            second_epoch,
            0,
            &[],
        )
        .await
        .expect("foreign Goodbye");

    let corr = first.next_corr();
    first
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            first_channel,
            first_epoch,
            corr,
            &support::echo_body("sender-still-live"),
        )
        .await
        .expect("request on sender route");
    let frame = first.frame_within(BUDGET).await.expect("sender terminal");
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.corr, corr);

    let corr = second.next_corr();
    second
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            second_channel,
            second_epoch,
            corr,
            &support::echo_body("still-owned"),
        )
        .await
        .expect("request on owned route");
    let frame = second.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.corr, corr);
    assert!(
        !host.handler.route_gones().iter().any(|handle| {
            (handle.channel == first_channel && handle.epoch == first_epoch)
                || (handle.channel == second_channel && handle.epoch == second_epoch)
        }),
        "a foreign Goodbye must not close either generation"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn route_capacity_exhaustion_is_refused_without_binding() {
    let host = TestHost::start_with(|config| {
        config.limits.max_routes = 2;
    })
    .await;
    let mut client = host.client().await;

    for index in 0..2 {
        client
            .route_open(LINKED_MODULE_ID, ROOT, "opencode", &format!("s{index}"))
            .await
            .unwrap_or_else(|err| panic!("route {index} must open: {err}"));
    }
    let binds_before = host.handler.binds().len();

    let frame = control_once(
        &mut client,
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "overflow"}
        }),
    )
    .await;
    assert_eq!(frame.error_code(), "target_unavailable");
    assert_eq!(
        host.handler.binds().len(),
        binds_before,
        "capacity refusal must happen before bind"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn retiring_a_generation_cleans_its_routes_exactly_once() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let mut handles = Vec::new();
    for index in 0..3 {
        handles.push(
            client
                .route_open(LINKED_MODULE_ID, ROOT, "opencode", &format!("s{index}"))
                .await
                .expect("route"),
        );
    }
    assert_eq!(host.handler.binds().len(), 3);

    // Dropping the connection retires the generation.
    drop(client);

    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        if host.handler.route_gones().len() == 3 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "every route of a retired generation must be cleaned, saw {:?}",
            host.handler.route_gones()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let gones = host.handler.route_gones();
    let unique: HashSet<_> = gones.iter().collect();
    assert_eq!(unique.len(), gones.len(), "route-gone must not repeat");

    host.shutdown_gracefully().await;
}
