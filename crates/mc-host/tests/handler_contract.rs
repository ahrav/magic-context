//! `McHandler` must use `mc-host` types rather than the private `subc-*` SDK.

mod support;

use std::time::Duration;

use mc_host::{
    ConfigError, HostError, HostLimits, ResourceDeclaration, RouteClass, StaticComposite,
};
use support::raw_client::{
    FLAGS_INTERACTIVE, TY_REQUEST, TY_RESPONSE, TY_STREAM_DATA, TY_STREAM_END,
};
use support::{mode_body, BindPolicy, CompositeTestHost, Event, TestHost, LINKED_MODULE_ID};

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

fn broca_declaration(retained_resident_bytes: u64) -> ResourceDeclaration {
    ResourceDeclaration {
        reserved_handler_tasks: 96,
        reserved_pending_requests: 96,
        retained_resident_bytes,
        route_class: RouteClass::Reserved,
    }
}

fn three_child_composite(
    declaration: ResourceDeclaration,
) -> StaticComposite<support::StubComponent, support::StubComponent, support::StubComponent> {
    let (mc, synapse, broca) = support::stub_trio();
    StaticComposite::new(mc, synapse, broca.with_resources(declaration)).expect("distinct ids")
}

/// A 96-slot declaration must leave at least one general slot in each pool:
/// startup fails when either limit is at most the reservation and starts
/// when both are one above it (R13, plan KTD2).
#[tokio::test]
async fn reservations_must_leave_one_general_slot_in_each_pool() {
    for (pending, tasks) in [(96, 200), (200, 96), (96, 96)] {
        let result =
            CompositeTestHost::try_start(three_child_composite(broca_declaration(0)), |config| {
                config.limits.max_pending_requests = pending;
                config.limits.max_handler_tasks = tasks;
            })
            .await;
        assert!(
            matches!(result, Err(HostError::InitFailed(_))),
            "limits ({pending}, {tasks}) must fail against a 96-slot reservation"
        );
    }

    let host = CompositeTestHost::start(three_child_composite(broca_declaration(0)), |config| {
        config.limits.max_pending_requests = 97;
        config.limits.max_handler_tasks = 97;
    })
    .await;
    // One general slot exists in each pool: an ordinary request dispatches.
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open_target(
            "tool_provider",
            "magic-context",
            "/workspace/project",
            "opencode",
            "s1",
        )
        .await
        .expect("magic-context binds");
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "echo"})),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.ty, TY_RESPONSE);
    host.shutdown().await.expect("graceful shutdown");
}

/// A reserved-class module must reserve permits, and a general-class module
/// must not: both mismatches are impossible accounting and fail startup.
#[tokio::test]
async fn class_and_reservation_mismatches_fail_startup() {
    let mismatches = [
        ResourceDeclaration {
            reserved_handler_tasks: 0,
            reserved_pending_requests: 0,
            retained_resident_bytes: 0,
            route_class: RouteClass::Reserved,
        },
        ResourceDeclaration {
            reserved_handler_tasks: 4,
            reserved_pending_requests: 4,
            retained_resident_bytes: 0,
            route_class: RouteClass::General,
        },
    ];
    for declaration in mismatches {
        let result =
            CompositeTestHost::try_start(three_child_composite(declaration), |_config| {}).await;
        assert!(
            matches!(result, Err(HostError::InitFailed(_))),
            "declaration {declaration:?} must fail startup"
        );
    }
}

/// A 64 MiB retained declaration raises the resident floor: one byte below
/// the handler-dependent floor fails startup, the exact floor starts and
/// still admits one maximum-size ingress body, so ingress, scratch, egress,
/// catalog, and declared retention exactly sum to the configured cap.
#[tokio::test]
async fn retained_declaration_raises_the_resident_floor_exactly() {
    const RETAINED: u64 = 64 * 1024 * 1024;
    let try_resident = |bytes: u64| async move {
        CompositeTestHost::try_start(
            three_child_composite(broca_declaration(RETAINED)),
            move |config| {
                config.limits.max_resident_bytes = bytes;
            },
        )
        .await
    };

    // The floor is MIN_RESIDENT_BYTES + retained + the serialized catalog's
    // resident length, which only the runtime knows; bisect the boundary.
    // `lo` always fails (the catalog is nonempty) and `hi` must pass.
    let mut lo = mc_host::config::MIN_RESIDENT_BYTES + RETAINED;
    let mut hi = lo + 64 * 1024;
    assert!(
        matches!(try_resident(lo).await, Err(HostError::InitFailed(_))),
        "the floor without catalog headroom must fail"
    );
    match try_resident(hi).await {
        Ok(host) => host.shutdown().await.expect("graceful shutdown"),
        Err(err) => panic!("64 KiB of catalog headroom must start: {err}"),
    }
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        match try_resident(mid).await {
            Ok(host) => {
                host.shutdown().await.expect("graceful shutdown");
                hi = mid;
            }
            Err(HostError::InitFailed(_)) => lo = mid,
            Err(err) => panic!("unexpected startup failure: {err}"),
        }
    }
    let floor = hi;

    assert!(
        matches!(try_resident(floor - 1).await, Err(HostError::InitFailed(_))),
        "one byte below the handler-dependent floor must be rejected"
    );

    // At the exact floor the ingress pool is exactly one maximum body: a
    // 64 MiB frame is still interoperable (protocol V12/V28).
    let host = match try_resident(floor).await {
        Ok(host) => host,
        Err(err) => panic!("the exact floor must be accepted: {err}"),
    };
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open_target(
            "tool_provider",
            "magic-context",
            "/workspace/project",
            "opencode",
            "big",
        )
        .await
        .expect("route");
    let prefix = br#"{"mode":"echo","pad":""#;
    let suffix = br#""}"#;
    let max_body = 64 * 1024 * 1024usize;
    let mut body = Vec::with_capacity(max_body);
    body.extend_from_slice(prefix);
    body.extend(std::iter::repeat_n(
        b'a',
        max_body - prefix.len() - suffix.len(),
    ));
    body.extend_from_slice(suffix);
    let corr = client.next_corr();
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, channel, epoch, corr, &body)
        .await
        .expect("send maximum-size frame");
    let frame = client
        .frame_within(Duration::from_secs(60))
        .await
        .expect("maximum-size frame answered at the exact floor");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.ty, TY_RESPONSE);
    host.shutdown().await.expect("graceful shutdown");
}

/// The default resident cap absorbs the whole Broca declaration: it is the
/// former two-component 256 MiB default plus exactly the declared retained
/// reservation (the 64 MiB supervisor budget plus the route-map and
/// backend-capture headroom), so ingress headroom is preserved, and the
/// default-limit three-component host starts.
#[tokio::test]
async fn the_default_resident_cap_absorbs_the_broca_reservation() {
    const RETAINED: u64 = 64 * 1024 * 1024
        + 1024 * (4096 + 256 + 128)
        + 8 * ((4 * 1024 * 1024 + 64 * 1024) * 5 + 512 * 1024)
        + 256 * ((4096 + 256) * 2 + 128);
    let defaults = HostLimits::default();
    assert_eq!(
        defaults.max_resident_bytes - RETAINED,
        256 * 1024 * 1024,
        "the default grew by exactly the declared retained reservation"
    );

    let host = CompositeTestHost::start(
        three_child_composite(broca_declaration(RETAINED)),
        |config| {
            // Default limits: the production declaration must fit them.
            config.limits = HostLimits::default();
        },
    )
    .await;
    host.shutdown().await.expect("graceful shutdown");
}

/// A zero-reservation handler keeps single-pool behavior: the tightest
/// interoperable limits still serve a request because nothing was carved out
/// of the general pools.
#[tokio::test]
async fn zero_reservation_handlers_keep_single_pool_admission() {
    let (mc, synapse, broca) = support::stub_trio();
    let composite = StaticComposite::new(mc, synapse, broca).expect("distinct ids");
    let host = CompositeTestHost::start(composite, |config| {
        config.limits.max_pending_requests = 1;
        config.limits.max_handler_tasks = 1;
    })
    .await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open_target(
            "management_surface",
            "broca",
            "/workspace/project",
            "opencode",
            "s1",
        )
        .await
        .expect("broca binds");
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "echo"})),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.json()["served_by"], "broca");
    host.shutdown().await.expect("graceful shutdown");
}
