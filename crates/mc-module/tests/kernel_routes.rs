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
