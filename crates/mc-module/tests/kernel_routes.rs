//! Daemon-side kernel route proofs. The proof registry in
//! `crates/mc-kernel/tests/kernel_proofs/registry.rs` names tests in this file.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cortexkit_store_types::{StorageBackend, StorageDescriptor};
use mc_host::{
    BindOutcome, CompositeComponent, HostInit, PrimaryComponent, RouteHandle, RouteIdentity,
};
use mc_module::kernel_routes::KernelState;
use mc_module::{dev_descriptor_at, McHandler};

fn identity(root: &Path, session: &str) -> RouteIdentity {
    RouteIdentity {
        project_root: root.to_path_buf(),
        harness: "test".to_owned(),
        session: session.to_owned(),
        consumer_module_id: None,
        consumer_launch_nonce: None,
        consumer_capabilities: Vec::new(),
        admission_facts: None,
        credential_fingerprints: std::collections::BTreeMap::new(),
    }
}

fn init(descriptor: &StorageDescriptor) -> HostInit {
    HostInit {
        subc_capabilities: Vec::new(),
        storage: Some(serde_json::to_value(descriptor).expect("storage descriptor serializes")),
    }
}

fn kernel_root(descriptor: &StorageDescriptor) -> PathBuf {
    let StorageBackend::Sqlite { path } = &descriptor.backend else {
        panic!("test descriptor is SQLite");
    };
    Path::new(path).parent().unwrap().join("kernel")
}

/// A handler whose cache and kernel stores are open, bound to one route.
struct Daemon {
    _data: tempfile::TempDir,
    descriptor: StorageDescriptor,
    handler: McHandler,
    route: RouteHandle,
    project: PathBuf,
}

impl Daemon {
    async fn start() -> Self {
        let data = tempfile::tempdir().unwrap();
        let descriptor = dev_descriptor_at(data.path().to_str().unwrap());
        let handler = McHandler::new();
        // Disable kernel sampling so assertions observe the controlled timestamp.
        handler.disable_kernel_sampler_for_test();
        PrimaryComponent::initialize(&handler, init(&descriptor))
            .await
            .unwrap();
        PrimaryComponent::activate(&handler).await.unwrap();
        wait_for_state(&handler, KernelState::Ready).await;
        let project = data.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let route = RouteHandle {
            channel: 7,
            epoch: 1,
        };
        assert!(matches!(
            handler.bind(route, identity(&project, "session-a")).await,
            BindOutcome::Accept
        ));
        Self {
            _data: data,
            descriptor,
            handler,
            route,
            project,
        }
    }
}

async fn wait_for_state(handler: &McHandler, expected: KernelState) {
    let started = Instant::now();
    loop {
        let state = handler.kernel_state();
        if state == expected {
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "kernel state stayed {state:?}, expected {expected:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn activation_opens_the_kernel_store_beside_the_cache_store() {
    let daemon = Daemon::start().await;
    let StorageBackend::Sqlite { path } = &daemon.descriptor.backend else {
        panic!("test descriptor is SQLite");
    };
    assert!(Path::new(path).is_file(), "cache store at {path}");
    let root = kernel_root(&daemon.descriptor);
    assert!(root.join("core.sqlite").is_file());
    assert_eq!(
        fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(daemon.handler.kernel_store_for_test().is_some());
    let _ = &daemon.route;
    let _ = &daemon.project;

    daemon.handler.shutdown().await.unwrap();
    assert_eq!(daemon.handler.kernel_state(), KernelState::Unavailable);
    assert!(daemon.handler.kernel_store_for_test().is_none());
}

#[tokio::test]
async fn a_second_daemon_on_the_same_root_starts_until_the_first_releases_its_lease() {
    let first = Daemon::start().await;
    let second = McHandler::new();
    PrimaryComponent::initialize(&second, init(&first.descriptor))
        .await
        .unwrap();
    PrimaryComponent::activate(&second).await.unwrap();
    // The cache store lease is held, so the kernel behind it has not opened.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(second.kernel_state(), KernelState::Starting);
    assert!(second.kernel_store_for_test().is_none());

    first.handler.shutdown().await.unwrap();
    wait_for_state(&second, KernelState::Ready).await;
    assert!(second.kernel_store_for_test().is_some());
    second.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_kernel_file_this_build_cannot_read_leaves_the_kernel_unavailable() {
    let data = tempfile::tempdir().unwrap();
    let descriptor = dev_descriptor_at(data.path().to_str().unwrap());
    let root = kernel_root(&descriptor);
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    // A header shorter than SQLite's 100 bytes is neither pristine nor a kernel file.
    fs::write(root.join("core.sqlite"), b"not a database").unwrap();

    let handler = McHandler::new();
    PrimaryComponent::initialize(&handler, init(&descriptor))
        .await
        .unwrap();
    PrimaryComponent::activate(&handler).await.unwrap();
    wait_for_state(&handler, KernelState::Unavailable).await;
    assert!(handler.kernel_store_for_test().is_none());
    assert_eq!(
        handler.kernel_unavailable_reason_for_test(),
        Some(mc_module::kernel_routes::UnavailableReason::StoreUnsupported)
    );
    // The cache store still answers.
    let route = RouteHandle {
        channel: 3,
        epoch: 1,
    };
    assert!(matches!(
        handler.bind(route, identity(data.path(), "s")).await,
        BindOutcome::Accept
    ));
    handler.shutdown().await.unwrap();
}

/// Encodes a prepared response the way the transport would and parses it back.
fn response_json(output: &mc_module::dispatch::PreparedOutput) -> serde_json::Value {
    let measured = output.measure().expect("response measures");
    let mut bytes = Vec::with_capacity(measured.len());
    measured.write_to(&mut bytes).expect("response encodes");
    serde_json::from_slice(&bytes).expect("response is JSON")
}

fn kernel_block(health: &mc_host::HealthReport) -> serde_json::Value {
    health.metrics.as_ref().expect("health metrics")["kernel"].clone()
}

fn intent(key: &str) -> mc_kernel::CommitIntent {
    mc_kernel::CommitIntent {
        producer: "kernel-routes-test".to_string(),
        operation_key: key.to_string(),
        request_digest: "c".repeat(64),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn domain(index: i64) -> mc_kernel::DomainSpec {
    mc_kernel::DomainSpec {
        domain_id: format!("domain-{index}"),
        object_id: format!("object-{index}"),
        name: format!("name-{index}"),
        source_kind: "fixture".to_string(),
        source_id: format!("source-{index}"),
        source_revision: index,
        sensitivity: mc_kernel::Sensitivity::Normal,
    }
}

/// Emits `count` outbox rows in one commit and returns the commit sequence.
fn insert_domains(store: &mc_kernel::KernelStore, first: i64, count: i64) -> i64 {
    store
        .commit(intent(&format!("domains-{first}-{count}")), |envelope| {
            for index in first..first + count {
                envelope.insert_domain(domain(index))?;
            }
            Ok(String::new())
        })
        .unwrap()
        .commit_seq
}

#[tokio::test]
async fn health_reads_the_sampled_kernel_block_without_touching_the_store() {
    let daemon = Daemon::start().await;
    daemon.handler.sample_kernel_health_for_test(1_000).await;
    let health = daemon.handler.health().await;
    assert_eq!(health.status, mc_host::HealthStatus::Ok);
    let kernel = kernel_block(&health);
    assert_eq!(kernel["kernel_state"], "ready");
    assert_eq!(kernel["sampled_at_ms"], 1_000);
    assert_eq!(kernel["core_file_warn"], false);
    assert_eq!(kernel["artifact_warn"], false);
    assert!(kernel["artifact_cap_bytes"].as_u64().unwrap() > 0);
    assert_eq!(kernel["retained_outbox_rows"], 0);

    // Dropping the slot on shutdown republishes the phase; the sampler holds no
    // strong reference between ticks, so the successor can take the lease.
    daemon.handler.shutdown().await.unwrap();
    let after = daemon.handler.health().await;
    let kernel = kernel_block(&after);
    assert_eq!(kernel["kernel_state"], "unavailable");
    assert_eq!(kernel["unavailable_reason"], "store_unavailable");
    assert!(kernel.get("core_file_bytes").is_none());
    let successor = McHandler::new();
    PrimaryComponent::initialize(&successor, init(&daemon.descriptor))
        .await
        .unwrap();
    PrimaryComponent::activate(&successor).await.unwrap();
    wait_for_state(&successor, KernelState::Ready).await;
    successor.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_empty_required_consumer_set_raises_a_daemon_health_warning() {
    let daemon = Daemon::start().await;
    let store = daemon.handler.kernel_store_for_test().unwrap();
    insert_domains(&store, 1, 3);
    store.mark_outbox_published_through(3, 1).unwrap();
    daemon.handler.sample_kernel_health_for_test(1_000).await;

    // No consumer: lag is unknown, the block says so, and the daemon stays Ok.
    // The readiness surface renders this as `warn (no_required_consumer)`.
    let health = daemon.handler.health().await;
    assert_eq!(health.status, mc_host::HealthStatus::Ok);
    let kernel = kernel_block(&health);
    assert_eq!(kernel["required_consumer_count"], 0);
    assert_eq!(kernel["outbox_position_lag"], serde_json::Value::Null);
    assert_eq!(kernel["oldest_unconsumed_age_ms"], serde_json::Value::Null);
    assert_eq!(kernel["retained_outbox_rows"], 3);
    assert_eq!(kernel["lag_threshold_tripped"], false);
    daemon.handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn crossing_the_lag_threshold_raises_a_daemon_health_warning() {
    let daemon = Daemon::start().await;
    let store = daemon.handler.kernel_store_for_test().unwrap();
    let registered = store
        .commit(intent("register"), |envelope| {
            envelope.register_outbox_consumer("projector", 1)?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;
    // The registration's own control row sits at position 1; acknowledging that
    // commit leaves only the domain rows at positions 2..=10_000 unconsumed.
    store
        .acknowledge_outbox("projector", registered, 1)
        .unwrap();
    let mut next = 1;
    while next <= 9_999 {
        let count = (9_999 - next + 1).min(2_500);
        insert_domains(&store, next, count);
        next += count;
    }
    store.mark_outbox_published_through(10_000, 1).unwrap();
    let created_at: i64 =
        rusqlite::Connection::open(kernel_root(&daemon.descriptor).join("core.sqlite"))
            .unwrap()
            .query_row(
                "SELECT MIN(created_at) FROM outbox WHERE commit_seq > ?1",
                [registered],
                |row| row.get(0),
            )
            .unwrap();

    // 9,999 published positions of lag and 59,999 ms of age: below both thresholds.
    daemon
        .handler
        .sample_kernel_health_for_test(created_at + 59_999)
        .await;
    let health = daemon.handler.health().await;
    assert_eq!(health.status, mc_host::HealthStatus::Ok, "{health:?}");
    let kernel = kernel_block(&health);
    assert_eq!(kernel["outbox_position_lag"], 9_999);
    assert_eq!(kernel["required_consumer_count"], 1);
    assert_eq!(kernel["lag_threshold_tripped"], false);

    // The 10,000th published position trips the counter threshold.
    insert_domains(&store, 10_000, 1);
    store.mark_outbox_published_through(10_001, 1).unwrap();
    daemon
        .handler
        .sample_kernel_health_for_test(created_at + 59_999)
        .await;
    let health = daemon.handler.health().await;
    assert_eq!(health.status, mc_host::HealthStatus::Degraded);
    assert!(health
        .detail
        .as_deref()
        .is_some_and(|detail| detail.ends_with("kernel outbox lag past threshold")));
    let kernel = kernel_block(&health);
    assert_eq!(kernel["outbox_position_lag"], 10_000);
    assert_eq!(kernel["lag_threshold_tripped"], true);

    // Acknowledging to the tip clears the counter; age alone trips at 60 s.
    let tip = store.facts(created_at).unwrap().commit_seq;
    store.acknowledge_outbox("projector", tip - 1, 1).unwrap();
    daemon
        .handler
        .sample_kernel_health_for_test(created_at + 59_999)
        .await;
    assert_eq!(
        daemon.handler.health().await.status,
        mc_host::HealthStatus::Ok
    );
    daemon
        .handler
        .sample_kernel_health_for_test(created_at + 120_000)
        .await;
    let health = daemon.handler.health().await;
    let kernel = kernel_block(&health);
    assert_eq!(kernel["outbox_position_lag"], 1);
    assert!(kernel["oldest_unconsumed_age_ms"].as_i64().unwrap() >= 60_000);
    assert_eq!(kernel["lag_threshold_tripped"], true);
    assert_eq!(health.status, mc_host::HealthStatus::Degraded);

    // The routed status method reports the same block from live facts.
    let status = daemon
        .handler
        .dispatch_value_for_test(
            daemon.route,
            serde_json::json!({"method": "status", "session_id": "session-a"}),
        )
        .await;
    let mc_module::dispatch::PreparedOutcome::Response(output) = status else {
        panic!("status responded with {status:?}");
    };
    let value = response_json(&output);
    assert_eq!(value["kernel"]["kernel_state"], "ready");
    assert_eq!(value["kernel"]["required_consumer_count"], 1);
    daemon.handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_background_sampler_publishes_facts_on_its_own() {
    let data = tempfile::tempdir().unwrap();
    let descriptor = dev_descriptor_at(data.path().to_str().unwrap());
    let handler = McHandler::new();
    PrimaryComponent::initialize(&handler, init(&descriptor))
        .await
        .unwrap();
    PrimaryComponent::activate(&handler).await.unwrap();
    wait_for_state(&handler, KernelState::Ready).await;

    // `Ready` reaches the health block only once the sampler has facts.
    let started = Instant::now();
    let kernel = loop {
        let kernel = kernel_block(&handler.health().await);
        if kernel["kernel_state"] == "ready" {
            break kernel;
        }
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "sampler never published: {kernel}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(kernel["sampled_at_ms"].as_i64().unwrap() > 0);
    assert_eq!(kernel["retained_outbox_rows"], 0);
    assert_eq!(kernel["required_consumer_count"], 0);
    handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_failed_facts_sample_reports_the_kernel_unavailable_until_one_succeeds() {
    let daemon = Daemon::start().await;
    daemon.handler.sample_kernel_health_for_test(1_000).await;
    assert_eq!(
        daemon.handler.health().await.status,
        mc_host::HealthStatus::Ok
    );

    // The store only opens owner-only artifact directories.
    let objects = kernel_root(&daemon.descriptor).join("artifacts/objects");
    fs::set_permissions(&objects, fs::Permissions::from_mode(0o755)).unwrap();
    daemon.handler.sample_kernel_health_for_test(2_000).await;
    let health = daemon.handler.health().await;
    assert_eq!(health.status, mc_host::HealthStatus::Degraded, "{health:?}");
    assert!(health
        .detail
        .as_deref()
        .is_some_and(|detail| detail.ends_with("kernel store is unavailable")));
    let kernel = kernel_block(&health);
    assert_eq!(kernel["kernel_state"], "unavailable");
    assert_eq!(kernel["unavailable_reason"], "store_unavailable");
    assert_eq!(kernel["sampled_at_ms"], 2_000);
    assert!(kernel.get("core_file_bytes").is_none());
    assert!(kernel.get("lag_threshold_tripped").is_none());
    // Routes are not fenced by the health projection.
    assert_eq!(daemon.handler.kernel_state(), KernelState::Ready);
    assert!(daemon.handler.kernel_store_for_test().is_some());

    // The routed status method reports the same failure from live facts.
    let status = daemon
        .handler
        .dispatch_value_for_test(
            daemon.route,
            serde_json::json!({"method": "status", "session_id": "session-a"}),
        )
        .await;
    let mc_module::dispatch::PreparedOutcome::Response(output) = status else {
        panic!("status responded with {status:?}");
    };
    let value = response_json(&output);
    assert_eq!(value["kernel"]["kernel_state"], "unavailable");
    assert_eq!(value["kernel"]["unavailable_reason"], "store_unavailable");

    fs::set_permissions(&objects, fs::Permissions::from_mode(0o700)).unwrap();
    daemon.handler.sample_kernel_health_for_test(3_000).await;
    let health = daemon.handler.health().await;
    assert_eq!(health.status, mc_host::HealthStatus::Ok, "{health:?}");
    let kernel = kernel_block(&health);
    assert_eq!(kernel["kernel_state"], "ready");
    assert_eq!(kernel["sampled_at_ms"], 3_000);
    assert!(kernel.get("unavailable_reason").is_none());
    assert_eq!(kernel["retained_outbox_rows"], 0);
    daemon.handler.shutdown().await.unwrap();
}
