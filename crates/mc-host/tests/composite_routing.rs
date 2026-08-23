//! Three-target static composition conformance: catalog contents, target
//! classification, per-child dispatch metadata, degraded-child isolation,
//! health aggregation, and ordered shutdown with typed redacted failures.

mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mc_host::{
    BindOutcome, CancellationToken, CompositeComponent, HealthReport, HealthStatus, HostConfig,
    HostError, HostInit, HostLimits, InitError, ManifestSnapshot, McHostHandler, PrimaryComponent,
    RequestCtx, RequestOutcome, RouteHandle, RouteIdentity, RouteTarget, SecondaryComponent,
    ShutdownError, StaticComposite,
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
    shutdown_error: Arc<Mutex<Option<String>>>,
    initialize_barrier: Arc<tokio::sync::Barrier>,
    events: Arc<Mutex<Vec<Ev>>>,
    /// Id-tagged event log; `fake_trio` shares one across all three
    /// components so cross-component ordering is observable.
    timeline: Arc<Mutex<Vec<(&'static str, Ev)>>>,
}

impl FakeComponent {
    fn new(id: &'static str, role: &'static str) -> Self {
        Self {
            id,
            role,
            disabled: Arc::new(AtomicBool::new(false)),
            health: Arc::new(Mutex::new(HealthReport::ok())),
            shutdown_error: Arc::new(Mutex::new(None)),
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

    fn fail_shutdown(&self, detail: &str) {
        *self.shutdown_error.lock().expect("shutdown error lock") = Some(detail.to_owned());
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

    async fn shutdown(&self) -> Result<(), ShutdownError> {
        self.push(Ev::Shutdown);
        match self
            .shutdown_error
            .lock()
            .expect("shutdown error lock")
            .take()
        {
            Some(detail) => Err(ShutdownError(detail)),
            None => Ok(()),
        }
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

fn fake_trio() -> (FakeComponent, FakeComponent, FakeComponent) {
    let primary = FakeComponent::new("magic-context", "tool_provider");
    let mut secondary = FakeComponent::new("synapse", "management_surface");
    let mut tertiary = FakeComponent::new("broca", "management_surface");
    secondary.timeline = primary.timeline.clone();
    tertiary.timeline = primary.timeline.clone();
    (primary, secondary, tertiary)
}

#[tokio::test]
async fn independent_component_initializers_overlap() {
    let barrier = Arc::new(tokio::sync::Barrier::new(3));
    let primary = FakeComponent::new("magic-context", "tool_provider")
        .with_initialize_barrier(Arc::clone(&barrier));
    let secondary = FakeComponent::new("synapse", "management_surface")
        .with_initialize_barrier(Arc::clone(&barrier));
    let tertiary =
        FakeComponent::new("broca", "management_surface").with_initialize_barrier(barrier);
    let composite = StaticComposite::new(primary.clone(), secondary.clone(), tertiary.clone())
        .expect("distinct ids");

    tokio::time::timeout(BUDGET, composite.initialize(HostInit::default()))
        .await
        .expect("all three initializers enter the barrier")
        .expect("initialization succeeds");

    assert_eq!(primary.events(), vec![Ev::Initialized]);
    assert_eq!(secondary.events(), vec![Ev::Initialized]);
    assert_eq!(tertiary.events(), vec![Ev::Initialized]);
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
async fn three_target_catalog_lists_all_modules_deterministically() {
    let (primary, secondary, tertiary) = fake_trio();
    let composite = StaticComposite::new(primary, secondary, tertiary).expect("distinct ids");
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
    assert_eq!(modules.len(), 3);
    assert_eq!(modules[0]["module_id"], "magic-context");
    assert_eq!(modules[0]["roles"][0]["role"], "tool_provider");
    assert_eq!(modules[1]["module_id"], "synapse");
    assert_eq!(modules[1]["roles"][0]["role"], "management_surface");
    assert_eq!(modules[2]["module_id"], "broca");
    assert_eq!(modules[2]["roles"][0]["role"], "management_surface");
    // No composite module implements any control op; `wake.create` stays
    // excluded so wake-plane probes fail open (AE10).
    support::assert_control_ops(&body["modules"], &[]);

    for (filter, expected) in [
        ("magic-context", 1),
        ("synapse", 1),
        ("broca", 1),
        ("unknown", 0),
    ] {
        let corr = client
            .control(&serde_json::json!({"op": "catalog.list", "module_id": filter}))
            .await
            .expect("send filtered catalog.list");
        let frame = client.frame_within(BUDGET).await.expect("catalog");
        assert_eq!(frame.corr, corr);
        let body = frame.json();
        let modules = body["modules"].as_array().expect("modules").len();
        assert_eq!(modules, expected, "filter {filter}");
        if expected == 1 {
            assert_eq!(body["modules"][0]["module_id"], filter);
            support::assert_control_ops(&body["modules"], &[]);
        }
    }

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn all_supported_targets_dispatch_to_their_component() {
    let (primary, secondary, tertiary) = fake_trio();
    let composite = StaticComposite::new(primary.clone(), secondary.clone(), tertiary.clone())
        .expect("distinct ids");
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
    let (br_channel, br_epoch) = client
        .route_open_target("management_surface", "broca", ROOT, "opencode", "s1")
        .await
        .expect("broca binds");
    assert_ne!(mc_channel, sy_channel, "channels are host-global");
    assert_ne!(mc_channel, br_channel);
    assert_ne!(sy_channel, br_channel);

    assert_eq!(
        request_served_by(&mut client, mc_channel, mc_epoch).await,
        "magic-context"
    );
    assert_eq!(
        request_served_by(&mut client, sy_channel, sy_epoch).await,
        "synapse"
    );
    assert_eq!(
        request_served_by(&mut client, br_channel, br_epoch).await,
        "broca"
    );
    for component in [&primary, &secondary, &tertiary] {
        assert_eq!(
            component
                .events()
                .iter()
                .filter(|event| matches!(event, Ev::Request(_)))
                .count(),
            1,
            "{} must serve exactly its own request",
            component.id
        );
    }

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn wrong_role_pairings_reject_without_any_bind() {
    let (primary, secondary, tertiary) = fake_trio();
    let composite = StaticComposite::new(primary.clone(), secondary.clone(), tertiary.clone())
        .expect("distinct ids");
    let host = CompositeHost::start(composite).await;
    let mut client = host.client().await;

    for (kind, module, expected) in [
        ("tool_provider", "synapse", "target_unavailable"),
        ("tool_provider", "broca", "target_unavailable"),
        ("management_surface", "magic-context", "target_unavailable"),
        ("management_surface", "thalamus", "unknown_module"),
        ("tool_provider", "thalamus", "unknown_module"),
        ("internal_service", "broca", "target_unavailable"),
        ("mystery_kind", "magic-context", "target_unavailable"),
    ] {
        let err = client
            .route_open_target(kind, module, ROOT, "opencode", "s1")
            .await
            .expect_err("unroutable pairing must reject");
        assert_eq!(err, expected, "{kind}/{module}");
    }

    for component in [&primary, &secondary, &tertiary] {
        assert!(
            component
                .events()
                .iter()
                .all(|event| *event == Ev::Initialized),
            "no bind may run on {}",
            component.id
        );
    }

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn disabled_secondary_rejects_its_bind_and_leaves_primary_available() {
    let (primary, secondary, tertiary) = fake_trio();
    secondary.disable();
    let composite =
        StaticComposite::new(primary.clone(), secondary.clone(), tertiary).expect("distinct ids");
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
async fn rejected_broca_bind_gets_exactly_one_broca_route_gone() {
    let (primary, secondary, tertiary) = fake_trio();
    tertiary.disable();
    let composite = StaticComposite::new(primary.clone(), secondary.clone(), tertiary.clone())
        .expect("distinct ids");
    let host = CompositeHost::start(composite).await;
    let mut client = host.client().await;

    let err = client
        .route_open_target("management_surface", "broca", ROOT, "opencode", "s1")
        .await
        .expect_err("disabled broca rejects bind");
    assert_eq!(err, "artifact_invalid");

    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let gones = tertiary
            .events()
            .iter()
            .filter(|event| matches!(event, Ev::RouteGone(_)))
            .count();
        if gones == 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "route-gone did not reach the rejecting broca child"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // The rejection stayed inside the broca child: no sibling saw a
    // route-gone or a bind for its handle.
    for component in [&primary, &secondary] {
        assert!(
            component
                .events()
                .iter()
                .all(|event| *event == Ev::Initialized),
            "{} must not observe the rejected broca handle",
            component.id
        );
    }

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn a_closed_route_handle_cannot_dispatch_to_stale_child_ownership() {
    let (primary, secondary, tertiary) = fake_trio();
    let composite = StaticComposite::new(primary.clone(), secondary.clone(), tertiary.clone())
        .expect("distinct ids");
    let host = CompositeHost::start(composite).await;
    let mut client = host.client().await;

    let (channel, epoch) = client
        .route_open_target("management_surface", "broca", ROOT, "opencode", "s1")
        .await
        .expect("broca binds");
    client
        .send_frame(
            raw_client::TY_GOODBYE,
            raw_client::FLAGS_PURE_HEADER,
            channel,
            epoch,
            0,
            &[],
        )
        .await
        .expect("route goodbye");
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        if tertiary
            .events()
            .iter()
            .any(|event| matches!(event, Ev::RouteGone(_)))
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "route-gone did not complete"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // The stale handle must be refused at the host, not routed to any child.
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
        .expect("send stale request");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.error_code(), "unknown_channel");
    for component in [&primary, &secondary, &tertiary] {
        assert!(
            !component
                .events()
                .iter()
                .any(|event| matches!(event, Ev::Request(_))),
            "{} must not serve the stale handle",
            component.id
        );
    }

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn shutdown_runs_after_route_cleanup_and_orders_children() {
    let (primary, secondary, tertiary) = fake_trio();
    let composite = StaticComposite::new(primary.clone(), secondary.clone(), tertiary.clone())
        .expect("distinct ids");
    let host = CompositeHost::start(composite).await;
    let mut client = host.client().await;

    for (kind, module) in [
        ("tool_provider", "magic-context"),
        ("management_surface", "synapse"),
        ("management_surface", "broca"),
    ] {
        client
            .route_open_target(kind, module, ROOT, "opencode", "s1")
            .await
            .expect("route binds");
    }

    host.shutdown().await.expect("graceful shutdown");

    for component in [&primary, &secondary, &tertiary] {
        let events = component.events();
        let gone = events
            .iter()
            .position(|event| matches!(event, Ev::RouteGone(_)))
            .expect("route-gone recorded");
        let shutdown = events
            .iter()
            .position(|event| *event == Ev::Shutdown)
            .expect("shutdown recorded");
        assert!(
            gone < shutdown,
            "{}: route cleanup precedes shutdown",
            component.id
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| **event == Ev::Shutdown)
                .count(),
            1,
            "{}: shutdown runs exactly once",
            component.id
        );
    }
    // Fixed drain order: Broca before Synapse before the primary.
    let timeline = primary.timeline();
    let shutdown_at = |id: &str| {
        timeline
            .iter()
            .position(|(component, event)| *component == id && *event == Ev::Shutdown)
            .expect("shutdown recorded in the shared timeline")
    };
    assert!(
        shutdown_at("broca") < shutdown_at("synapse"),
        "broca shuts down before synapse"
    );
    assert!(
        shutdown_at("synapse") < shutdown_at("magic-context"),
        "synapse shuts down before the primary"
    );
}

#[tokio::test]
async fn health_aggregates_with_deterministic_precedence() {
    let (primary, secondary, tertiary) = fake_trio();
    let composite = StaticComposite::new(primary.clone(), secondary.clone(), tertiary.clone())
        .expect("distinct ids");

    let report = composite.health().await;
    assert_eq!(report.status, HealthStatus::Ok);

    tertiary.set_health(HealthStatus::Degraded, "broca degraded");
    let report = composite.health().await;
    assert_eq!(report.status, HealthStatus::Degraded);
    assert_eq!(report.detail.as_deref(), Some("broca degraded"));

    // Equal optional severities always report the earlier catalog entry.
    secondary.set_health(HealthStatus::Degraded, "synapse degraded");
    let report = composite.health().await;
    assert_eq!(
        report.detail.as_deref(),
        Some("synapse degraded"),
        "synapse wins the tie against broca deterministically"
    );

    tertiary.set_health(HealthStatus::Failing, "broca failing");
    let report = composite.health().await;
    assert_eq!(report.status, HealthStatus::Failing);
    assert_eq!(report.detail.as_deref(), Some("broca failing"));

    primary.set_health(HealthStatus::Failing, "primary failing");
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
    let middle = FakeComponent::new("magic-context", "management_surface");
    let right = FakeComponent::new("broca", "management_surface");
    assert!(StaticComposite::new(left, middle, right).is_err());

    let left = FakeComponent::new("magic-context", "tool_provider");
    let middle = FakeComponent::new("synapse", "management_surface");
    let right = FakeComponent::new("synapse", "management_surface");
    assert!(StaticComposite::new(left, middle, right).is_err());

    let left = FakeComponent::new("magic-context", "tool_provider");
    let middle = FakeComponent::new("synapse", "management_surface");
    let right = FakeComponent::new("magic-context", "management_surface");
    assert!(StaticComposite::new(left, middle, right).is_err());
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
    let result = mc_host::run(
        BadManifestHandler { manifests },
        config,
        CancellationToken::new(),
    )
    .await;
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
        manifest("b", &["management_surface"]),
        manifest("c", &["management_surface"]),
        manifest("d", &["management_surface"]),
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

/// A child whose shutdown always panics, for proving the composite still
/// drains every later child before surfacing the failure.
struct PanickingShutdownChild {
    id: &'static str,
    shutdown_entered: Arc<AtomicBool>,
}

impl CompositeComponent for PanickingShutdownChild {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: self.id.to_owned(),
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

    async fn shutdown(&self) -> Result<(), ShutdownError> {
        self.shutdown_entered.store(true, Ordering::SeqCst);
        panic!("SECRET-SHUTDOWN-PAYLOAD-51ab");
    }
}

impl SecondaryComponent for PanickingShutdownChild {
    async fn initialize(&self) -> Result<(), InitError> {
        Ok(())
    }
}

#[tokio::test]
async fn a_panicking_broca_shutdown_still_drains_later_children_and_redacts() {
    let (primary, secondary, _tertiary) = fake_trio();
    let shutdown_entered = Arc::new(AtomicBool::new(false));
    let broca = PanickingShutdownChild {
        id: "broca",
        shutdown_entered: Arc::clone(&shutdown_entered),
    };
    let composite =
        StaticComposite::new(primary.clone(), secondary.clone(), broca).expect("distinct ids");

    let joined = tokio::spawn(async move { composite.shutdown().await }).await;
    let err = joined.expect_err("the composite must surface the broca failure");
    assert!(err.is_panic(), "the surfaced failure is a panic");
    let payload = err.into_panic();
    let message = payload
        .downcast_ref::<String>()
        .expect("composed failure message")
        .clone();
    assert_eq!(
        message, "broca shutdown panicked",
        "one deterministic redacted failure"
    );
    assert!(shutdown_entered.load(Ordering::SeqCst));
    // Broca drains first, so both later children must still have drained.
    assert!(
        secondary.events().contains(&Ev::Shutdown),
        "synapse must drain despite the broca panic"
    );
    assert!(
        primary.events().contains(&Ev::Shutdown),
        "the primary must drain despite the broca panic"
    );
}

#[tokio::test]
async fn an_erroring_broca_shutdown_still_drains_later_children_and_redacts() {
    let (primary, secondary, tertiary) = fake_trio();
    tertiary.fail_shutdown("SECRET-DETAIL-77");
    let composite = StaticComposite::new(primary.clone(), secondary.clone(), tertiary.clone())
        .expect("distinct ids");

    let joined = tokio::spawn(async move { composite.shutdown().await }).await;
    let err = joined.expect_err("the composite must surface the broca failure");
    assert!(err.is_panic());
    let payload = err.into_panic();
    let message = payload
        .downcast_ref::<String>()
        .expect("composed failure message")
        .clone();
    assert!(
        !message.contains("SECRET-DETAIL-77"),
        "the typed error detail must be redacted: {message}"
    );
    assert_eq!(
        message,
        "broca shutdown failed (16 bytes of detail redacted)"
    );
    for component in [&primary, &secondary, &tertiary] {
        assert!(
            component.events().contains(&Ev::Shutdown),
            "{} must drain despite the broca error",
            component.id
        );
    }
}

#[tokio::test]
async fn a_child_shutdown_failure_makes_the_host_incarnation_non_graceful() {
    let (primary, secondary, tertiary) = fake_trio();
    tertiary.fail_shutdown("late broca cleanup fault");
    let composite =
        StaticComposite::new(primary.clone(), secondary.clone(), tertiary).expect("distinct ids");
    let host = CompositeHost::start(composite).await;

    // The composite surfaced the collected failure only after every child
    // drained; the runtime classifies the callback as failed and keeps the
    // incarnation non-graceful while the instance fence is retained.
    let result = host.shutdown().await;
    assert!(
        matches!(result, Err(HostError::LifecycleFatal(_))),
        "a child shutdown failure must not report graceful completion: {result:?}"
    );
    for component in [&primary, &secondary] {
        assert!(
            component.events().contains(&Ev::Shutdown),
            "{} must still drain",
            component.id
        );
    }
}

/// A child whose health probe always panics, for proving the composite
/// reports the fault instead of unwinding into the host's fatal path.
struct PanickingHealthChild {
    id: &'static str,
    health_entered: Arc<AtomicBool>,
}

impl CompositeComponent for PanickingHealthChild {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: self.id.to_owned(),
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
        self.health_entered.store(true, Ordering::SeqCst);
        panic!("child health panic");
    }

    async fn shutdown(&self) -> Result<(), ShutdownError> {
        Ok(())
    }
}

impl SecondaryComponent for PanickingHealthChild {
    async fn initialize(&self) -> Result<(), InitError> {
        Ok(())
    }
}

#[tokio::test]
async fn a_panicking_broca_health_reports_failing_without_skipping_other_children() {
    let (primary, secondary, _tertiary) = fake_trio();
    let health_entered = Arc::new(AtomicBool::new(false));
    let composite = StaticComposite::new(
        primary.clone(),
        secondary.clone(),
        PanickingHealthChild {
            id: "broca",
            health_entered: Arc::clone(&health_entered),
        },
    )
    .expect("distinct ids");

    let report = composite.health().await;
    assert!(health_entered.load(Ordering::SeqCst));
    assert_eq!(report.status, HealthStatus::Failing);
    assert_eq!(
        report.detail.as_deref(),
        Some("broca health check panicked")
    );

    // Other children were still polled: a degraded synapse is visible when
    // it outranks nothing, and never masked by the broca fault below its
    // severity.
    secondary.set_health(HealthStatus::Degraded, "synapse degraded");
    let report = composite.health().await;
    assert_eq!(
        report.detail.as_deref(),
        Some("broca health check panicked"),
        "the caught fault outranks a merely degraded sibling"
    );

    primary.set_health(HealthStatus::Failing, "primary failing");
    let report = composite.health().await;
    assert_eq!(
        report.detail.as_deref(),
        Some("primary failing"),
        "the mandatory component still wins severity ties"
    );
}

#[tokio::test]
async fn a_panicking_synapse_health_reports_failing_without_unwinding() {
    let (primary, _secondary, tertiary) = fake_trio();
    let health_entered = Arc::new(AtomicBool::new(false));
    let composite = StaticComposite::new(
        primary.clone(),
        PanickingHealthChild {
            id: "synapse",
            health_entered: Arc::clone(&health_entered),
        },
        tertiary,
    )
    .expect("distinct ids");

    let report = composite.health().await;
    assert!(health_entered.load(Ordering::SeqCst));
    assert_eq!(report.status, HealthStatus::Failing);
    assert_eq!(
        report.detail.as_deref(),
        Some("synapse health check panicked")
    );
}
