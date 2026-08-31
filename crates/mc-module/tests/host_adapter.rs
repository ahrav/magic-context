use std::path::Path;
use std::time::Duration;

use cortexkit_store_types::StorageDescriptor;
use mc_host::{
    BindOutcome, CompositeComponent, HealthStatus, HostInit, PrimaryComponent, RouteHandle,
    RouteIdentity,
};
use mc_module::{dev_descriptor_at, McHandler};
use mc_store::McStore;

fn assert_primary<T: PrimaryComponent>() {}

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

#[tokio::test]
async fn host_lifecycle_uses_full_route_handles() {
    assert_primary::<McHandler>();
    let data = tempfile::tempdir().unwrap();
    let descriptor = dev_descriptor_at(data.path().to_str().unwrap());
    let handler = McHandler::new();

    let manifest = handler.manifest();
    assert_eq!(manifest.module_id, "magic-context");
    assert_eq!(manifest.provides[0]["role"], "tool_provider");
    assert!(handler.resources().reserved_handler_tasks == 0);
    PrimaryComponent::initialize(&handler, init(&descriptor))
        .await
        .unwrap();
    PrimaryComponent::activate(&handler).await.unwrap();

    let old = RouteHandle {
        channel: 17,
        epoch: 4,
    };
    let newer = RouteHandle {
        channel: 17,
        epoch: 5,
    };
    assert!(matches!(
        handler.bind(old, identity(data.path(), "old")).await,
        BindOutcome::Accept
    ));
    assert!(matches!(
        handler.bind(newer, identity(data.path(), "new")).await,
        BindOutcome::Accept
    ));
    handler.route_gone(old).await;
    let health = handler.health().await;
    assert_ne!(health.status, HealthStatus::Failing);
    let epochs = &health.metrics.expect("health metrics")["epochs"];
    assert_eq!(
        epochs["memory_render_epoch"],
        mc_module::MEMORY_RENDER_FORMAT_EPOCH
    );
    assert_eq!(
        epochs["compartment_render_epoch"],
        mc_module::COMPARTMENT_RENDER_FORMAT_EPOCH
    );
    assert_eq!(
        epochs["profile_epoch"],
        mc_module::PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC
    );
    assert_eq!(epochs["tagger_epoch"], mc_module::TAGGER_FEATURE_EPOCH);
    assert_eq!(epochs["state_sync_epoch"], mc_module::STATE_SYNC_EPOCH);

    handler.route_gone(newer).await;
    handler.shutdown().await.unwrap();
    assert!(PrimaryComponent::initialize(&handler, init(&descriptor))
        .await
        .is_err());
    let reopened = McHandler::new();
    PrimaryComponent::initialize(&reopened, init(&descriptor))
        .await
        .unwrap();
    reopened.shutdown().await.unwrap();
    assert!(PrimaryComponent::activate(&reopened).await.is_err());
}

#[tokio::test]
async fn invalid_initialization_fails_and_partial_shutdown_is_safe() {
    let handler = McHandler::new();
    let error = PrimaryComponent::initialize(
        &handler,
        HostInit {
            subc_capabilities: Vec::new(),
            storage: Some(serde_json::json!({"backend": "not-a-storage-descriptor"})),
        },
    )
    .await
    .expect_err("invalid storage must prevent publication");
    assert!(error
        .to_string()
        .contains("invalid Magic Context storage descriptor"));
    assert_ne!(handler.health().await.status, HealthStatus::Failing);
    handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_cancels_and_joins_blocked_store_open() {
    let data = tempfile::tempdir().unwrap();
    let descriptor = dev_descriptor_at(data.path().to_str().unwrap());
    let held = McStore::open(&descriptor).expect("hold single-writer lease");
    let handler = McHandler::new();
    PrimaryComponent::initialize(&handler, init(&descriptor))
        .await
        .unwrap();
    PrimaryComponent::activate(&handler).await.unwrap();

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if handler
                .health()
                .await
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("waiting on storage lease"))
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("store waiter reached blocked phase");

    tokio::time::timeout(Duration::from_secs(1), handler.shutdown())
        .await
        .expect("shutdown joined blocked waiter")
        .unwrap();
    drop(held);
    McStore::open(&descriptor).expect("shutdown retained no store lease");
}

#[test]
fn adapter_source_has_one_prepared_outcome_and_tracked_spawn_boundary() {
    let source = include_str!("../src/lib.rs");
    let production = source
        .split("#[cfg(test)]\nmod tests {")
        .next()
        .expect("production source");

    assert!(!production.contains("HandlerOutcome"));
    assert!(!production.contains("ModuleHandler"));
    let removed_client_api = ["subc", "client", "rs"].join("_") + "::";
    assert!(!production.contains(&removed_client_api));
    assert!(!production.contains("tokio::spawn("));
    assert!(production.contains("spawn_module_task"));
    // The cancellation token is the sole shutdown state.
    // The `spawn_gate` is a critical section, not a second shutdown flag.
    // A separate admission boolean can diverge from the cancellation token.
    assert!(production.contains("spawn_gate"));
    assert!(
        !production.contains("task_admission_open"),
        "admission must be derived from the cancellation token, not tracked separately"
    );
    assert!(production.contains("self.tasks.close()"));
    assert!(production.contains("self.cancel.cancel()"));
    assert!(production.contains("self.tasks.wait().await"));

    let transform = production
        .split("fn respond_transform")
        .nth(1)
        .expect("transform preparation")
        .split("fn emit_pass_timing")
        .next()
        .unwrap();
    assert!(transform.contains("PreparedOutput::transform_segments"));
    assert!(!transform.contains("serde_json::to_vec"));
    assert!(!transform.contains("Vec::with_capacity"));
}
