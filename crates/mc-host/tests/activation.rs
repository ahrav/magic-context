//! R37).

mod support;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mc_host::{
    BindOutcome, CancellationToken, CompositeComponent, HealthReport, HealthStatus, HostConfig,
    HostError, HostInit, HostLimits, InitError, ManifestSnapshot, PrimaryComponent, RequestCtx,
    RequestOutcome, RouteHandle, RouteIdentity, SecondaryComponent, ShutdownError, StaticComposite,
};

use support::synapse::EchoPrimary;

const BUDGET: Duration = Duration::from_secs(10);

/// invariant failure.
struct GatedState {
    id: &'static str,
    release: tokio::sync::Semaphore,
    fail_activation: bool,
    activated: AtomicBool,
    degraded: AtomicBool,
}

#[derive(Clone)]
struct GatedActivation(Arc<GatedState>);

impl std::ops::Deref for GatedActivation {
    type Target = GatedState;

    fn deref(&self) -> &GatedState {
        &self.0
    }
}

impl GatedActivation {
    fn new(id: &'static str, fail_activation: bool) -> Self {
        Self(Arc::new(GatedState {
            id,
            release: tokio::sync::Semaphore::new(0),
            fail_activation,
            activated: AtomicBool::new(false),
            degraded: AtomicBool::new(false),
        }))
    }
}

impl CompositeComponent for GatedActivation {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: self.id.to_owned(),
            module_version: "0.0.1".to_owned(),
            provides: vec![serde_json::json!({"role": "management_surface"})],
            control_ops: Vec::new(),
        }
    }

    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        if self.activated.load(Ordering::SeqCst) {
            BindOutcome::Accept
        } else {
            BindOutcome::Reject {
                code: "module_reloading".to_owned(),
                message: "activation has not settled".to_owned(),
            }
        }
    }

    async fn handle(&self, _ctx: RequestCtx) -> RequestOutcome {
        RequestOutcome::error("unused", "unused")
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        if self.degraded.load(Ordering::SeqCst) {
            HealthReport {
                status: HealthStatus::Degraded,
                detail: Some("artifact fault degraded this lane".to_owned()),
                metrics: None,
            }
        } else {
            HealthReport::ok()
        }
    }

    async fn shutdown(&self) -> Result<(), ShutdownError> {
        Ok(())
    }
}

impl SecondaryComponent for GatedActivation {
    async fn initialize(&self) -> Result<(), InitError> {
        Ok(())
    }

    async fn activate(&self) -> Result<(), InitError> {
        let _permit = self.release.acquire().await;
        if self.fail_activation {
            return Err(InitError("activation invariant violated".to_owned()));
        }
        self.degraded.store(true, Ordering::SeqCst);
        self.activated.store(true, Ordering::SeqCst);
        Ok(())
    }
}

fn host_config(data_root: &Path) -> HostConfig {
    let mut config = HostConfig {
        data_dir: Some(data_root.to_path_buf()),
        daemon_ver: "mc-host/test".to_owned(),
        limits: HostLimits {
            max_resident_bytes: mc_host::config::MIN_RESIDENT_BYTES * 2,
            ..Default::default()
        },
        ..Default::default()
    };
    config.timing.shutdown_deadline = Duration::from_secs(5);
    config.timing.lifecycle_callback_deadline = Duration::from_secs(3);
    config
}

async fn wait_for_publication(publication: &PathBuf) {
    let deadline = tokio::time::Instant::now() + BUDGET;
    while std::fs::read(publication).is_err() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "host did not publish in time"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn transport_publishes_before_blocked_activation_settles() {
    let data_root = tempfile::tempdir().expect("data root");
    let synapse_like = GatedActivation::new("synapse", false);
    let broca_like = GatedActivation::new("broca", false);
    let composite = StaticComposite::new(EchoPrimary, synapse_like.clone(), broca_like.clone())
        .expect("distinct ids");

    let shutdown = CancellationToken::new();
    let run_shutdown = shutdown.clone();
    let config = host_config(data_root.path());
    let publication = support::connection_file(data_root.path());
    let host = tokio::spawn(async move { mc_host::run(composite, config, run_shutdown).await });

    wait_for_publication(&publication).await;
    assert!(!synapse_like.activated.load(Ordering::SeqCst));
    assert!(!broca_like.activated.load(Ordering::SeqCst));

    let info = support::raw_client::discover(&publication).expect("publication validates");
    let mut client = support::raw_client::RawClient::connect(&info)
        .await
        .expect("authenticated connection");
    let (channel, epoch) = client
        .route_open("magic-context", "/workspace/project", "opencode", "s1")
        .await
        .expect("primary binds before activation settles");
    let corr = client.next_corr();
    client
        .send_frame(
            support::raw_client::TY_REQUEST,
            support::raw_client::FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            b"{\"ping\":true}",
        )
        .await
        .expect("send echo");
    let frame = client.frame_within(BUDGET).await.expect("echo terminal");
    assert_eq!(frame.corr, corr);

    let err = client
        .route_open_target(
            "management_surface",
            "synapse",
            "/workspace/project",
            "opencode",
            "s1",
        )
        .await
        .expect_err("gated secondary rejects until activation settles");
    assert_eq!(err, "module_reloading");

    synapse_like.release.add_permits(1);
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        match client
            .route_open_target(
                "management_surface",
                "synapse",
                "/workspace/project",
                "opencode",
                "s2",
            )
            .await
        {
            Ok(_) => break,
            Err(code) if code == "module_reloading" => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "released lane must settle"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(code) => panic!("released lane must bind, got {code}"),
        }
    }
    assert!(!broca_like.activated.load(Ordering::SeqCst));

    broca_like.release.add_permits(1);
    drop(client);
    shutdown.cancel();
    let result = host.await.expect("run task joins");
    assert!(result.is_ok(), "graceful shutdown, got {result:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn activation_invariant_failure_reaches_the_fatal_channel() {
    let data_root = tempfile::tempdir().expect("data root");
    let failing = GatedActivation::new("synapse", true);
    let composite = StaticComposite::new(
        EchoPrimary,
        failing.clone(),
        support::StubComponent::new("broca", "management_surface"),
    )
    .expect("distinct ids");

    let shutdown = CancellationToken::new();
    let config = host_config(data_root.path());
    let publication = support::connection_file(data_root.path());
    let run_shutdown = shutdown.clone();
    let host = tokio::spawn(async move { mc_host::run(composite, config, run_shutdown).await });
    wait_for_publication(&publication).await;

    failing.release.add_permits(1);
    let result = tokio::time::timeout(BUDGET, host)
        .await
        .expect("host tears down after a fatal activation")
        .expect("run task joins");
    match result {
        Err(HostError::LifecycleFatal(message)) => {
            assert!(
                message.contains("activation"),
                "fatal message names activation, got {message:?}"
            );
            assert!(
                !message.contains("invariant violated"),
                "handler-authored detail must stay redacted"
            );
        }
        other => panic!("expected LifecycleFatal, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn expected_artifact_faults_degrade_only_their_lane() {
    let data_root = tempfile::tempdir().expect("data root");
    let degrading = GatedActivation::new("synapse", false);
    let composite = StaticComposite::new(
        EchoPrimary,
        degrading.clone(),
        support::StubComponent::new("broca", "management_surface"),
    )
    .expect("distinct ids");

    let shutdown = CancellationToken::new();
    let config = host_config(data_root.path());
    let publication = support::connection_file(data_root.path());
    let run_shutdown = shutdown.clone();
    let host = tokio::spawn(async move { mc_host::run(composite, config, run_shutdown).await });
    wait_for_publication(&publication).await;

    degrading.release.add_permits(1);
    let deadline = tokio::time::Instant::now() + BUDGET;
    while !degrading.degraded.load(Ordering::SeqCst) {
        assert!(tokio::time::Instant::now() < deadline, "lane degrades");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let info = support::raw_client::discover(&publication).expect("publication validates");
    let mut client = support::raw_client::RawClient::connect(&info)
        .await
        .expect("authenticated connection after degradation");
    client
        .route_open("magic-context", "/workspace/project", "opencode", "s1")
        .await
        .expect("primary still binds");

    drop(client);
    shutdown.cancel();
    let result = host.await.expect("run task joins");
    assert!(result.is_ok(), "graceful shutdown, got {result:?}");
}

struct OrderingState {
    publication: PathBuf,
    initialize_saw_publication: AtomicBool,
    activate_saw_publication: AtomicBool,
}

#[derive(Clone)]
struct OrderingPrimary(Arc<OrderingState>);

impl std::ops::Deref for OrderingPrimary {
    type Target = OrderingState;

    fn deref(&self) -> &OrderingState {
        &self.0
    }
}

impl CompositeComponent for OrderingPrimary {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: "magic-context".to_owned(),
            module_version: "0.0.1".to_owned(),
            provides: vec![serde_json::json!({"role": "tool_provider"})],
            control_ops: Vec::new(),
        }
    }

    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        BindOutcome::Accept
    }

    async fn handle(&self, _ctx: RequestCtx) -> RequestOutcome {
        RequestOutcome::error("unused", "unused")
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        HealthReport::ok()
    }

    async fn shutdown(&self) -> Result<(), ShutdownError> {
        Ok(())
    }
}

impl PrimaryComponent for OrderingPrimary {
    async fn initialize(&self, _init: HostInit) -> Result<(), InitError> {
        self.initialize_saw_publication
            .store(self.publication.exists(), Ordering::SeqCst);
        Ok(())
    }

    async fn activate(&self) -> Result<(), InitError> {
        self.activate_saw_publication
            .store(self.publication.exists(), Ordering::SeqCst);
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bootstrap_precedes_publication_and_activation_follows_it() {
    let data_root = tempfile::tempdir().expect("data root");
    let publication = support::connection_file(data_root.path());
    let primary = OrderingPrimary(Arc::new(OrderingState {
        publication: publication.clone(),
        initialize_saw_publication: AtomicBool::new(true),
        activate_saw_publication: AtomicBool::new(false),
    }));
    let composite = StaticComposite::new(
        primary.clone(),
        support::StubComponent::new("synapse", "management_surface"),
        support::StubComponent::new("broca", "management_surface"),
    )
    .expect("distinct ids");

    let shutdown = CancellationToken::new();
    let config = host_config(data_root.path());
    let run_shutdown = shutdown.clone();
    let host = tokio::spawn(async move { mc_host::run(composite, config, run_shutdown).await });
    wait_for_publication(&publication).await;

    let deadline = tokio::time::Instant::now() + BUDGET;
    while !primary.activate_saw_publication.load(Ordering::SeqCst) {
        assert!(tokio::time::Instant::now() < deadline, "activation runs");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        !primary.initialize_saw_publication.load(Ordering::SeqCst),
        "pre-publication bootstrap must run before the transport publishes"
    );

    shutdown.cancel();
    let result = host.await.expect("run task joins");
    assert!(result.is_ok(), "graceful shutdown, got {result:?}");
}
