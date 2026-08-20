//! Two-target static composition conformance: catalog contents, target
//! classification, per-child dispatch metadata, degraded-secondary
//! isolation, health aggregation, and shutdown ordering.

mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mc_host::{
    BindOutcome, CancellationToken, CompositeComponent, HealthReport, HealthStatus, HostConfig,
    HostError, HostInit, HostLimits, InitError, ManifestSnapshot, McHostHandler, PrimaryComponent,
    RequestCtx, RequestOutcome, RouteHandle, RouteIdentity, RouteTarget, SecondaryComponent,
    StaticComposite,
};

use support::raw_client::{self, Discovered};

const ROOT: &str = "/workspace/project";
const BUDGET: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq)]
enum Ev {
    Initialized,
    Bind(RouteHandle),
    Request(RouteHandle),
    RouteGone(RouteHandle),
    Shutdown,
}

#[derive(Clone)]
struct FakeComponent {
    id: &'static str,
    role: &'static str,
    disabled: Arc<AtomicBool>,
    health: Arc<Mutex<HealthReport>>,
    initialize_barrier: Arc<tokio::sync::Barrier>,
    events: Arc<Mutex<Vec<Ev>>>,
    /// Id-tagged event log; `fake_pair` shares one between both components
    /// so cross-component ordering is observable.
    timeline: Arc<Mutex<Vec<(&'static str, Ev)>>>,
}

impl FakeComponent {
    fn new(id: &'static str, role: &'static str) -> Self {
        Self {
            id,
            role,
            disabled: Arc::new(AtomicBool::new(false)),
            health: Arc::new(Mutex::new(HealthReport::ok())),
            initialize_barrier: Arc::new(tokio::sync::Barrier::new(1)),
            events: Arc::new(Mutex::new(Vec::new())),
            timeline: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn disable(&self) {
        self.disabled.store(true, Ordering::SeqCst);
        *self.health.lock().expect("health lock") = HealthReport {
            status: HealthStatus::Degraded,
            detail: Some("artifact_invalid".to_owned()),
            metrics: None,
        };
    }

    fn with_initialize_barrier(mut self, barrier: Arc<tokio::sync::Barrier>) -> Self {
        self.initialize_barrier = barrier;
        self
    }

    fn set_health(&self, status: HealthStatus, detail: &str) {
        *self.health.lock().expect("health lock") = HealthReport {
            status,
            detail: Some(detail.to_owned()),
            metrics: None,
        };
    }

    fn events(&self) -> Vec<Ev> {
        self.events.lock().expect("events lock").clone()
    }

    fn timeline(&self) -> Vec<(&'static str, Ev)> {
        self.timeline.lock().expect("timeline lock").clone()
    }

    fn push(&self, event: Ev) {
        self.timeline
            .lock()
            .expect("timeline lock")
            .push((self.id, event.clone()));
        self.events.lock().expect("events lock").push(event);
    }
}

impl CompositeComponent for FakeComponent {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: self.id.to_owned(),
            module_version: "0.0.1".to_owned(),
            provides: vec![serde_json::json!({"role": self.role})],
            control_ops: Vec::new(),
        }
    }

    async fn bind(&self, route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        self.push(Ev::Bind(route));
        if self.disabled.load(Ordering::SeqCst) {
            return BindOutcome::Reject {
                code: "artifact_invalid".to_owned(),
                message: "bundle is missing or invalid".to_owned(),
            };
        }
        BindOutcome::Accept
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        self.push(Ev::Request(ctx.route));
        let body = serde_json::json!({"served_by": self.id});
        let encoded = serde_json::to_vec(&body).expect("body serializes");
        let Ok(mut output) = ctx.reserve_output(encoded.len()).await else {
            return RequestOutcome::Error {
                code: "internal_error".to_owned(),
                message: "reservation failed".to_owned(),
            };
        };
        output
            .extend_from_slice(&encoded)
            .expect("reservation matches body");
        RequestOutcome::Response {
            body: output,
            binary: false,
        }
    }

    async fn route_gone(&self, route: RouteHandle) {
        self.push(Ev::RouteGone(route));
    }

    async fn health(&self) -> HealthReport {
        self.health.lock().expect("health lock").clone()
    }

    async fn shutdown(&self) {
        self.push(Ev::Shutdown);
    }
}

impl PrimaryComponent for FakeComponent {
    async fn initialize(&self, _init: HostInit) -> Result<(), InitError> {
        self.initialize_barrier.wait().await;
        self.push(Ev::Initialized);
        Ok(())
    }
}

impl SecondaryComponent for FakeComponent {
    async fn initialize(&self) -> Result<(), InitError> {
        self.initialize_barrier.wait().await;
        self.push(Ev::Initialized);
        Ok(())
    }
}

fn fake_pair() -> (FakeComponent, FakeComponent) {
    let primary = FakeComponent::new("magic-context", "tool_provider");
    let mut secondary = FakeComponent::new("synapse", "management_surface");
    secondary.timeline = primary.timeline.clone();
    (primary, secondary)
}

#[tokio::test]
async fn independent_component_initializers_overlap() {
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let primary = FakeComponent::new("magic-context", "tool_provider")
        .with_initialize_barrier(Arc::clone(&barrier));
    let secondary =
        FakeComponent::new("synapse", "management_surface").with_initialize_barrier(barrier);
    let composite = StaticComposite::new(primary.clone(), secondary.clone()).expect("distinct ids");

    tokio::time::timeout(BUDGET, composite.initialize(HostInit::default()))
        .await
        .expect("both initializers enter the barrier")
        .expect("initialization succeeds");

    assert_eq!(primary.events(), vec![Ev::Initialized]);
    assert_eq!(secondary.events(), vec![Ev::Initialized]);
}

struct CompositeHost {
    info: Discovered,
    shutdown: CancellationToken,
    join: tokio::task::JoinHandle<Result<(), HostError>>,
    _data_root: tempfile::TempDir,
}

impl CompositeHost {
    async fn start<H: McHostHandler>(handler: H) -> Self {
        let data_root = tempfile::tempdir().expect("temp data root");
        let mut config = HostConfig {
            data_dir: Some(data_root.path().to_path_buf()),
            daemon_ver: "mc-host/test".to_owned(),
            limits: HostLimits {
                max_resident_bytes: mc_host::config::MIN_RESIDENT_BYTES * 2,
                ..Default::default()
            },
            ..Default::default()
        };
        config.timing.frame_deadline = Duration::from_secs(5);
        config.timing.shutdown_deadline = Duration::from_secs(5);
        config.timing.route_close_budget = Duration::from_secs(2);
        config.timing.lifecycle_callback_deadline = Duration::from_secs(2);

        let publication = support::connection_file(data_root.path());
        let shutdown = CancellationToken::new();
        let run_shutdown = shutdown.clone();
        let join = tokio::spawn(async move { mc_host::run(handler, config, run_shutdown).await });

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if join.is_finished() {
                panic!(
                    "host exited before publishing: {:?}",
                    join.await.expect("run task joins")
                );
            }
            if std::fs::read(&publication).is_ok() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "host did not publish in time"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let info = raw_client::discover(&publication).expect("publication validates");
        Self {
            info,
            shutdown,
            join,
            _data_root: data_root,
        }
    }

    async fn client(&self) -> raw_client::RawClient {
        raw_client::RawClient::connect(&self.info)
            .await
            .expect("authenticated connection")
    }

    async fn shutdown(self) -> Result<(), HostError> {
        self.shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(20), self.join)
            .await
            .expect("host finishes within its shutdown budget")
            .expect("run task joins")
    }
}

async fn request_served_by(client: &mut raw_client::RawClient, channel: u16, epoch: u32) -> String {
    let corr = client.next_corr();
    client
        .send_frame(
            raw_client::TY_REQUEST,
            raw_client::FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            b"{}",
        )
        .await
        .expect("send routed request");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);
    frame.json()["served_by"]
        .as_str()
        .expect("served_by field")
        .to_owned()
}

#[tokio::test]
async fn two_target_catalog_lists_both_modules_deterministically() {
    let (primary, secondary) = fake_pair();
    let composite = StaticComposite::new(primary, secondary).expect("distinct ids");
    let host = CompositeHost::start(composite).await;
    let mut client = host.client().await;

    let corr = client
        .control(&serde_json::json!({"op": "catalog.list"}))
        .await
        .expect("send catalog.list");
    let frame = client.frame_within(BUDGET).await.expect("catalog");
    assert_eq!(frame.corr, corr);
    let body = frame.json();
    let modules = body["modules"].as_array().expect("modules array");
    assert_eq!(modules.len(), 2);
    assert_eq!(modules[0]["module_id"], "magic-context");
    assert_eq!(modules[0]["roles"][0]["role"], "tool_provider");
    assert_eq!(modules[1]["module_id"], "synapse");
    assert_eq!(modules[1]["roles"][0]["role"], "management_surface");

    for (filter, expected) in [("magic-context", 1), ("synapse", 1), ("unknown", 0)] {
        let corr = client
            .control(&serde_json::json!({"op": "catalog.list", "module_id": filter}))
            .await
            .expect("send filtered catalog.list");
        let frame = client.frame_within(BUDGET).await.expect("catalog");
        assert_eq!(frame.corr, corr);
        let modules = frame.json()["modules"].as_array().expect("modules").len();
        assert_eq!(modules, expected, "filter {filter}");
        if expected == 1 {
            assert_eq!(frame.json()["modules"][0]["module_id"], filter);
        }
    }

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn both_supported_targets_dispatch_to_their_component() {
    let (primary, secondary) = fake_pair();
    let composite = StaticComposite::new(primary.clone(), secondary.clone()).expect("distinct ids");
    let host = CompositeHost::start(composite).await;
    let mut client = host.client().await;

    let (mc_channel, mc_epoch) = client
        .route_open_target("tool_provider", "magic-context", ROOT, "opencode", "s1")
        .await
        .expect("magic-context binds");
    let (sy_channel, sy_epoch) = client
        .route_open_target("management_surface", "synapse", ROOT, "opencode", "s1")
        .await
        .expect("synapse binds");
    assert_ne!(mc_channel, sy_channel, "channels are host-global");

    assert_eq!(
        request_served_by(&mut client, mc_channel, mc_epoch).await,
        "magic-context"
    );
    assert_eq!(
        request_served_by(&mut client, sy_channel, sy_epoch).await,
        "synapse"
    );
    assert_eq!(
        primary
            .events()
            .iter()
            .filter(|event| matches!(event, Ev::Request(_)))
            .count(),
        1
    );
    assert_eq!(
        secondary
            .events()
            .iter()
            .filter(|event| matches!(event, Ev::Request(_)))
            .count(),
        1
    );

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn wrong_role_pairings_reject_without_any_bind() {
    let (primary, secondary) = fake_pair();
    let composite = StaticComposite::new(primary.clone(), secondary.clone()).expect("distinct ids");
    let host = CompositeHost::start(composite).await;
    let mut client = host.client().await;

    let err = client
        .route_open_target("tool_provider", "synapse", ROOT, "opencode", "s1")
        .await
        .expect_err("synapse does not serve tool_provider");
    assert_eq!(err, "target_unavailable");
    let err = client
        .route_open_target(
            "management_surface",
            "magic-context",
            ROOT,
            "opencode",
            "s1",
        )
        .await
        .expect_err("magic-context does not serve management_surface");
    assert_eq!(err, "target_unavailable");
    let err = client
        .route_open_target("management_surface", "thalamus", ROOT, "opencode", "s1")
        .await
        .expect_err("thalamus is not a static module");
    assert_eq!(err, "unknown_module");
    let err = client
        .route_open_target("internal_service", "synapse", ROOT, "opencode", "s1")
        .await
        .expect_err("internal_service is not routable");
    assert_eq!(err, "target_unavailable");

    assert!(
        primary
            .events()
            .iter()
            .all(|event| *event == Ev::Initialized),
        "no primary bind may run"
    );
    assert!(secondary
        .events()
        .iter()
        .all(|event| *event == Ev::Initialized));

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn disabled_secondary_rejects_its_bind_and_leaves_primary_available() {
    let (primary, secondary) = fake_pair();
    secondary.disable();
    let composite = StaticComposite::new(primary.clone(), secondary.clone()).expect("distinct ids");
    let host = CompositeHost::start(composite).await;
    let mut client = host.client().await;

    let err = client
        .route_open_target("management_surface", "synapse", ROOT, "opencode", "s1")
        .await
        .expect_err("disabled synapse rejects bind");
    assert_eq!(err, "artifact_invalid");

    // The rejected bind still owes exactly one route-gone to the same child.
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let gones = secondary
            .events()
            .iter()
            .filter(|event| matches!(event, Ev::RouteGone(_)))
            .count();
        if gones == 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "route-gone did not reach the rejecting component"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let (channel, epoch) = client
        .route_open_target("tool_provider", "magic-context", ROOT, "opencode", "s1")
        .await
        .expect("magic-context stays routable");
    assert_eq!(
        request_served_by(&mut client, channel, epoch).await,
        "magic-context"
    );

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn shutdown_runs_after_route_cleanup_and_orders_children() {
    let (primary, secondary) = fake_pair();
    let composite = StaticComposite::new(primary.clone(), secondary.clone()).expect("distinct ids");
    let host = CompositeHost::start(composite).await;
    let mut client = host.client().await;

    let (mc_channel, _mc_epoch) = client
        .route_open_target("tool_provider", "magic-context", ROOT, "opencode", "s1")
        .await
        .expect("magic-context binds");
    let (sy_channel, _sy_epoch) = client
        .route_open_target("management_surface", "synapse", ROOT, "opencode", "s1")
        .await
        .expect("synapse binds");
    assert_ne!(mc_channel, sy_channel);

    host.shutdown().await.expect("graceful shutdown");

    let primary_events = primary.events();
    let secondary_events = secondary.events();
    let gone_index = |events: &[Ev]| {
        events
            .iter()
            .position(|event| matches!(event, Ev::RouteGone(_)))
            .expect("route-gone recorded")
    };
    let shutdown_index = |events: &[Ev]| {
        events
            .iter()
            .position(|event| *event == Ev::Shutdown)
            .expect("shutdown recorded")
    };
    assert!(gone_index(&primary_events) < shutdown_index(&primary_events));
    assert!(gone_index(&secondary_events) < shutdown_index(&secondary_events));
    // The composite shuts children down sequentially, optional secondary
    // before mandatory primary.
    let timeline = primary.timeline();
    let shutdown_at = |id: &str| {
        timeline
            .iter()
            .position(|(component, event)| *component == id && *event == Ev::Shutdown)
            .expect("shutdown recorded in the shared timeline")
    };
    assert!(
        shutdown_at("synapse") < shutdown_at("magic-context"),
        "secondary shuts down before primary"
    );
    assert_eq!(
        primary_events
            .iter()
            .filter(|event| **event == Ev::Shutdown)
            .count(),
        1
    );
    assert_eq!(
        secondary_events
            .iter()
            .filter(|event| **event == Ev::Shutdown)
            .count(),
        1
    );
}

#[tokio::test]
async fn health_aggregates_with_primary_precedence() {
    let (primary, secondary) = fake_pair();
    let composite = StaticComposite::new(primary.clone(), secondary.clone()).expect("distinct ids");

    let report = composite.health().await;
    assert_eq!(report.status, HealthStatus::Ok);

    secondary.set_health(HealthStatus::Degraded, "synapse degraded");
    let report = composite.health().await;
    assert_eq!(report.status, HealthStatus::Degraded);
    assert_eq!(report.detail.as_deref(), Some("synapse degraded"));

    primary.set_health(HealthStatus::Failing, "primary failing");
    let report = composite.health().await;
    assert_eq!(report.status, HealthStatus::Failing);
    assert_eq!(report.detail.as_deref(), Some("primary failing"));

    secondary.set_health(HealthStatus::Failing, "secondary failing");
    let report = composite.health().await;
    assert_eq!(
        report.detail.as_deref(),
        Some("primary failing"),
        "the mandatory component wins severity ties"
    );
}

#[tokio::test]
async fn duplicate_component_ids_are_refused_at_construction() {
    let left = FakeComponent::new("magic-context", "tool_provider");
    let right = FakeComponent::new("magic-context", "management_surface");
    assert!(StaticComposite::new(left, right).is_err());
}

struct BadManifestHandler {
    manifests: Vec<ManifestSnapshot>,
}

impl McHostHandler for BadManifestHandler {
    fn manifests(&self) -> Vec<ManifestSnapshot> {
        self.manifests.clone()
    }

    async fn initialize(&self, _init: HostInit) -> Result<(), InitError> {
        Ok(())
    }

    async fn bind(
        &self,
        _route: RouteHandle,
        _target: RouteTarget,
        _identity: RouteIdentity,
    ) -> BindOutcome {
        BindOutcome::Accept
    }

    async fn handle(&self, _ctx: RequestCtx) -> RequestOutcome {
        RequestOutcome::Error {
            code: "internal_error".to_owned(),
            message: "unreachable".to_owned(),
        }
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        HealthReport::ok()
    }

    async fn shutdown(&self) {}
}

fn manifest(module_id: &str, roles: &[&str]) -> ManifestSnapshot {
    ManifestSnapshot {
        module_id: module_id.to_owned(),
        module_version: "0.0.1".to_owned(),
        provides: roles
            .iter()
            .map(|role| serde_json::json!({"role": role}))
            .collect(),
        control_ops: Vec::new(),
    }
}

async fn expect_init_failure(manifests: Vec<ManifestSnapshot>) {
    let data_root = tempfile::tempdir().expect("temp data root");
    let publication = support::connection_file(data_root.path());
    let config = HostConfig {
        data_dir: Some(data_root.path().to_path_buf()),
        ..Default::default()
    };
    let shutdown = CancellationToken::new();
    shutdown.cancel();
    let result = mc_host::run(BadManifestHandler { manifests }, config, shutdown).await;
    assert!(
        matches!(result, Err(HostError::InitFailed(_))),
        "invalid manifest sets must fail before publication"
    );
    assert!(!publication.exists(), "invalid manifests must not publish");
}

#[tokio::test]
async fn invalid_manifest_sets_fail_before_publication() {
    expect_init_failure(Vec::new()).await;
    expect_init_failure(vec![
        manifest("a", &["tool_provider"]),
        manifest("b", &["tool_provider"]),
        manifest("c", &["tool_provider"]),
    ])
    .await;
    expect_init_failure(vec![
        manifest("dup", &["tool_provider"]),
        manifest("dup", &["management_surface"]),
    ])
    .await;
    expect_init_failure(vec![manifest("a", &["mystery_role"])]).await;
    expect_init_failure(vec![manifest("a", &["tool_provider", "tool_provider"])]).await;
    expect_init_failure(vec![manifest("a", &[])]).await;
    expect_init_failure(vec![manifest("a", &["management_surface"])]).await;
}

/// A secondary whose shutdown always panics, for proving the composite still
/// drains the mandatory primary before re-raising.
struct PanickingShutdownSecondary {
    shutdown_entered: Arc<AtomicBool>,
}

impl CompositeComponent for PanickingShutdownSecondary {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: "synapse".to_owned(),
            module_version: "0.0.1".to_owned(),
            provides: vec![serde_json::json!({"role": "management_surface"})],
            control_ops: Vec::new(),
        }
    }

    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        BindOutcome::Accept
    }

    async fn handle(&self, _ctx: RequestCtx) -> RequestOutcome {
        RequestOutcome::Error {
            code: "internal_error".to_owned(),
            message: "unreachable".to_owned(),
        }
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        HealthReport::ok()
    }

    async fn shutdown(&self) {
        self.shutdown_entered.store(true, Ordering::SeqCst);
        panic!("secondary shutdown panic");
    }
}

impl SecondaryComponent for PanickingShutdownSecondary {
    async fn initialize(&self) -> Result<(), InitError> {
        Ok(())
    }
}

#[tokio::test]
async fn a_panicking_secondary_shutdown_still_drains_the_primary_and_repanics() {
    let primary = FakeComponent::new("magic-context", "tool_provider");
    let shutdown_entered = Arc::new(AtomicBool::new(false));
    let secondary = PanickingShutdownSecondary {
        shutdown_entered: Arc::clone(&shutdown_entered),
    };
    let composite = StaticComposite::new(primary.clone(), secondary).expect("distinct ids");

    let joined = tokio::spawn(async move { composite.shutdown().await }).await;
    let err = joined.expect_err("the composite must re-raise the secondary's panic");
    assert!(
        err.is_panic(),
        "the re-raised payload is a panic, not an abort"
    );
    assert!(shutdown_entered.load(Ordering::SeqCst));
    assert!(
        primary.events().contains(&Ev::Shutdown),
        "the primary's shutdown must run despite the secondary's panic"
    );
}
