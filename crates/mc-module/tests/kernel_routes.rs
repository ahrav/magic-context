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

// ---------------------------------------------------------------------------
// `kernel.read`, `kernel.commit`, `kernel.eligibility.batch`
// ---------------------------------------------------------------------------

use mc_kernel::{
    AdmissionEvent, AdmissionRequest, ArtifactDeletionIdentity, ArtifactDeletionKind,
    ArtifactDeletionRequest, ArtifactIngestRequest, DecisionPayload, DecisionSpec, EventKind,
    ObservationPayload, ObservationSpec, ProviderEgress, RepositoryProvenance, ScopeSpec,
    ScopeTermSpec, Sensitivity, SourceClass, TaintClass,
};
use mc_module::dispatch::PreparedOutcome;
use serde_json::{json, Value};

const SESSION: &str = "session-a";
const DOMAIN: &str = "domain";
const SECRET: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";

fn seed_domain(store: &mc_kernel::KernelStore) {
    store
        .commit(intent("seed-domain"), |envelope| {
            envelope.insert_domain(mc_kernel::DomainSpec {
                domain_id: DOMAIN.to_string(),
                object_id: "domain-object".to_string(),
                name: "fixture".to_string(),
                source_kind: "fixture".to_string(),
                source_id: DOMAIN.to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
}

fn digest(seed: &str) -> String {
    use sha2::Digest as _;
    format!("{:x}", sha2::Sha256::digest(seed.as_bytes()))
}

fn wire_intent(key: &str, digest_seed: &str) -> Value {
    json!({
        "producer": "plugin",
        "operation_key": key,
        "request_digest": digest(digest_seed),
        "actor": "assistant",
        "cause": "ctx_memory",
    })
}

fn decision_spec(index: i64) -> Value {
    json!({
        "decision_id": format!("decision-{index}"),
        "object_id": format!("decision-object-{index}"),
        "domain_id": DOMAIN,
        "decision_kind": "memory",
        "payload": {"summary": format!("decision {index}"), "rationale": format!("because {index}")},
        "source_id": "memory-lineage",
        "source_revision": index,
    })
}

fn insert_decision(index: i64) -> Value {
    json!({"op": "insert_decision", "spec": decision_spec(index)})
}

fn commit_request(project: &Path, key: &str, operations: Vec<Value>, tokens: Vec<Value>) -> Value {
    json!({
        "method": "kernel.commit",
        "v": 1,
        "session_id": SESSION,
        "project_root": project.to_str().unwrap(),
        "intent": wire_intent(key, key),
        "tokens": tokens,
        "operations": operations,
        "source_kind": "assistant",
    })
}

fn read_request(project: &Path, surface: &str, as_of: Option<i64>) -> Value {
    json!({
        "method": "kernel.read",
        "v": 1,
        "session_id": SESSION,
        "project_root": project.to_str().unwrap(),
        "surface": surface,
        "as_of": as_of,
        "gated": false,
    })
}

fn token(object_id: &str, known_as_of: i64) -> Value {
    json!({"object_id": object_id, "known_as_of": known_as_of})
}

fn state_of(value: &Value) -> (String, Option<String>) {
    (
        value["state"]["kind"].as_str().unwrap().to_string(),
        value["state"]["reason"].as_str().map(str::to_string),
    )
}

fn assert_state(value: &Value, kind: &str, reason: Option<&str>) {
    assert_eq!(
        state_of(value),
        (kind.to_string(), reason.map(str::to_string)),
        "{value}"
    );
}

fn object_ids(read: &Value) -> Vec<String> {
    let mut ids: Vec<String> = read["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["object"]["object_id"].as_str().unwrap().to_string())
        .collect();
    ids.sort();
    ids
}

impl Daemon {
    async fn call(&self, route: RouteHandle, request: Value) -> Value {
        match self.handler.dispatch_value_for_test(route, request).await {
            PreparedOutcome::Response(output) => response_json(&output),
            PreparedOutcome::Error { code, message } => {
                panic!("kernel route answered {code}: {message}")
            }
            PreparedOutcome::Streamed => panic!("kernel route streamed"),
        }
    }

    async fn commit(&self, key: &str, operations: Vec<Value>, tokens: Vec<Value>) -> Value {
        self.call(
            self.route,
            commit_request(&self.project, key, operations, tokens),
        )
        .await
    }

    async fn read(&self, surface: &str, as_of: Option<i64>) -> Value {
        self.call(self.route, read_request(&self.project, surface, as_of))
            .await
    }

    fn store(&self) -> std::sync::Arc<mc_kernel::KernelStore> {
        self.handler.kernel_store_for_test().unwrap()
    }

    fn tip(&self) -> i64 {
        self.store().tip().unwrap()
    }

    /// Binds a second route, on a second session, to a second project root.
    async fn bind_project(&self, name: &str) -> (RouteHandle, PathBuf) {
        let root = self._data.path().join(name);
        fs::create_dir_all(&root).unwrap();
        let route = RouteHandle {
            channel: 11,
            epoch: 1,
        };
        assert!(matches!(
            self.handler.bind(route, identity(&root, "session-b")).await,
            BindOutcome::Accept
        ));
        (route, root)
    }

    /// The project scope id the route materialized, read back off a row.
    async fn project_scope_id(&self) -> String {
        let read = self.read("explicit_search", None).await;
        read["rows"][0]["scope_id"].as_str().unwrap().to_string()
    }
}

/// Deterministic-lineage decision written straight into the store under `scope_id`.
fn store_decision(index: i64, scope_id: &str, source_id: &str) -> DecisionSpec {
    DecisionSpec {
        decision_id: format!("store-decision-{index}"),
        object_id: format!("store-decision-object-{index}"),
        domain_id: DOMAIN.to_string(),
        proposition_id: None,
        scope_id: Some(scope_id.to_string()),
        anchor_id: None,
        evidence_id: None,
        decision_kind: "architecture".to_string(),
        payload: DecisionPayload {
            summary: format!("decision {index}"),
            rationale: format!("because {index}"),
        },
        source_kind: "repo".to_string(),
        source_id: source_id.to_string(),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
    }
}

fn code_observation(index: i64, source_id: &str) -> ObservationSpec {
    ObservationSpec {
        observation_id: format!("observation-{index}"),
        object_id: format!("observation-object-{index}"),
        domain_id: DOMAIN.to_string(),
        proposition_id: None,
        scope_id: None,
        anchor_id: None,
        evidence_id: None,
        observation_kind: "code_present".to_string(),
        payload: ObservationPayload {
            summary: "code present".to_string(),
            classification: "code_present".to_string(),
            detail: None,
        },
        observed_at: 1,
        dependencies: Vec::new(),
        source_kind: "repo".to_string(),
        source_id: source_id.to_string(),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
    }
}

fn admission(
    subject: &str,
    kind: EventKind,
    trigger: Option<&str>,
    classes: (SourceClass, TaintClass),
) -> AdmissionRequest {
    AdmissionRequest {
        candidate_id: None,
        subject_object_id: Some(subject.to_string()),
        source_class: Some(classes.0),
        taint_class: Some(classes.1),
        event: AdmissionEvent {
            kind,
            trigger_object_id: trigger.map(str::to_string),
            approval_object_id: None,
            evidence_id: None,
            reason: format!("{kind:?}"),
        },
    }
}

fn ingest(key: &str, payload: &[u8], sensitivity: Sensitivity) -> ArtifactIngestRequest {
    ArtifactIngestRequest {
        intent: intent(key),
        payload: payload.to_vec(),
        evidence_id: format!("evidence-{key}"),
        object_id: format!("evidence-object-{key}"),
        object_kind: "evidence".to_string(),
        domain_id: DOMAIN.to_string(),
        source_kind: "repository".to_string(),
        source_id: format!("src/{key}"),
        source_revision: 1,
        media_type: "text/plain".to_string(),
        retention_class: "canonical".to_string(),
        retain_until: None,
        asserted_sensitivity: sensitivity,
        provider_egress: ProviderEgress::RemoteAllowed,
        provenance: Some(RepositoryProvenance {
            repository_id: "repo".to_string(),
            revision: "abc123".to_string(),
        }),
    }
}

#[tokio::test]
async fn replayed_intents_return_one_receipt_and_projects_never_collide() {
    let daemon = Daemon::start().await;
    seed_domain(&daemon.store());
    let first = daemon
        .commit("create-1", vec![insert_decision(1)], vec![])
        .await;
    assert_state(&first, "available", None);
    let commit_seq = first["receipt"]["commit_seq"].as_i64().unwrap();
    assert_eq!(first["receipt"]["replayed"], false);
    assert_eq!(first["known_as_of"], commit_seq);
    assert_eq!(
        first["tokens"],
        json!([{"object_id": "decision-object-1", "known_as_of": commit_seq}])
    );
    let tip = daemon.tip();

    let again = daemon
        .commit("create-1", vec![insert_decision(1)], vec![])
        .await;
    assert_state(&again, "available", None);
    assert_eq!(again["receipt"]["commit_seq"], commit_seq);
    assert_eq!(again["receipt"]["replayed"], true);
    assert_eq!(again["tokens"], first["tokens"]);
    assert_eq!(daemon.tip(), tip, "a replay writes nothing");

    // The same request bytes on a route bound to another project are another
    // operation: a receipt of their own, neither replayed.
    let (route_b, project_b) = daemon.bind_project("project-b").await;
    let mut request = commit_request(&project_b, "create-1", vec![insert_decision(2)], vec![]);
    request["session_id"] = json!("session-b");
    let other = daemon.call(route_b, request).await;
    assert_state(&other, "available", None);
    assert_eq!(other["receipt"]["replayed"], false);
    assert_ne!(other["receipt"]["commit_seq"], commit_seq);
    daemon.handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_operation_key_reused_with_another_digest_is_invalid() {
    let daemon = Daemon::start().await;
    seed_domain(&daemon.store());
    assert_state(
        &daemon.commit("key", vec![insert_decision(1)], vec![]).await,
        "available",
        None,
    );
    let tip = daemon.tip();
    let mut reused = commit_request(&daemon.project, "key", vec![insert_decision(2)], vec![]);
    reused["intent"] = wire_intent("key", "other-bytes");
    let response = daemon.call(daemon.route, reused).await;
    assert_state(&response, "invalid", Some("operation_key_reused"));
    assert_eq!(daemon.tip(), tip);
    daemon.handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_token_conflicts_when_its_object_advanced_was_retracted_or_was_superseded() {
    let daemon = Daemon::start().await;
    seed_domain(&daemon.store());
    let created = daemon
        .commit(
            "create",
            vec![insert_decision(1), insert_decision(2), insert_decision(3)],
            vec![],
        )
        .await;
    let n = created["known_as_of"].as_i64().unwrap();

    // Object 1 changes at N+1 (a supersession into 4); object 2 is retired.
    let changed = daemon
        .commit(
            "change",
            vec![
                json!({"op": "supersede_decision", "replaced_object_id": "decision-object-1", "spec": decision_spec(4)}),
                json!({"op": "retire_decision", "object_id": "decision-object-2"}),
            ],
            vec![],
        )
        .await;
    assert_state(&changed, "available", None);
    assert_eq!(changed["known_as_of"].as_i64().unwrap(), n + 1);
    let tip = daemon.tip();

    // Object 4 is live but changed after N: known_as_of advanced.
    let advanced = daemon
        .commit(
            "mutate-advanced",
            vec![json!({"op": "retire_decision", "object_id": "decision-object-4"})],
            vec![token("decision-object-4", n)],
        )
        .await;
    assert_state(&advanced, "conflict", Some("known_as_of_advanced"));
    let retracted = daemon
        .commit(
            "mutate-retracted",
            vec![json!({"op": "retire_decision", "object_id": "decision-object-3"})],
            vec![token("decision-object-2", n)],
        )
        .await;
    assert_state(&retracted, "conflict", Some("retracted"));
    let superseded = daemon
        .commit(
            "mutate-superseded",
            vec![json!({"op": "retire_decision", "object_id": "decision-object-3"})],
            vec![token("decision-object-1", n)],
        )
        .await;
    assert_state(&superseded, "conflict", Some("superseded"));
    let missing = daemon
        .commit(
            "mutate-missing",
            vec![json!({"op": "retire_decision", "object_id": "decision-object-3"})],
            vec![token("never-written", n)],
        )
        .await;
    assert_state(&missing, "conflict", Some("retracted"));
    assert_eq!(daemon.tip(), tip, "a conflicting commit writes nothing");

    // A token at the current tip on an untouched object lets the mutation land.
    let landed = daemon
        .commit(
            "mutate-fresh",
            vec![json!({"op": "retire_decision", "object_id": "decision-object-3"})],
            vec![token("decision-object-3", tip)],
        )
        .await;
    assert_state(&landed, "available", None);
    daemon.handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_merge_folds_every_predecessor_into_one_survivor_in_one_commit() {
    let daemon = Daemon::start().await;
    seed_domain(&daemon.store());
    daemon
        .commit(
            "create",
            vec![insert_decision(1), insert_decision(2), insert_decision(3)],
            vec![],
        )
        .await;
    let before = daemon.read("explicit_search", None).await;
    assert_eq!(
        object_ids(&before),
        [
            "decision-object-1",
            "decision-object-2",
            "decision-object-3"
        ]
    );

    let merged = daemon
        .commit(
            "merge",
            vec![
                json!({"op": "supersede_decision", "replaced_object_id": "decision-object-1", "spec": decision_spec(3)}),
                json!({"op": "supersede_decision", "replaced_object_id": "decision-object-2", "spec": decision_spec(3)}),
            ],
            vec![],
        )
        .await;
    assert_state(&merged, "available", None);
    let touched: Vec<&str> = merged["tokens"]
        .as_array()
        .unwrap()
        .iter()
        .map(|token| token["object_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        touched,
        [
            "decision-object-1",
            "decision-object-2",
            "decision-object-3"
        ]
    );
    let after = daemon.read("explicit_search", None).await;
    assert_eq!(object_ids(&after), ["decision-object-3"]);
    let history = daemon
        .store()
        .object_history_as_of(daemon.tip())
        .unwrap()
        .objects;
    for predecessor in ["decision-object-1", "decision-object-2"] {
        let row = history
            .iter()
            .find(|object| object.object_id == predecessor)
            .unwrap();
        assert_eq!(row.superseded_by.as_deref(), Some("decision-object-3"));
        assert!(row.invalidated_commit_seq.is_some());
    }
    daemon.handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_plugin_route_cannot_declare_a_class_above_the_derived_one() {
    let daemon = Daemon::start().await;
    seed_domain(&daemon.store());
    let tip = daemon.tip();
    let mut over = commit_request(&daemon.project, "over", vec![insert_decision(1)], vec![]);
    over["asserted_source_class"] = json!("explicit_user");
    let response = daemon.call(daemon.route, over).await;
    assert_state(&response, "invalid", Some("class_over_declared"));
    assert_eq!(daemon.tip(), tip);

    let mut over_taint = commit_request(&daemon.project, "taint", vec![insert_decision(1)], vec![]);
    over_taint["asserted_taint_class"] = json!("current_code");
    assert_state(
        &daemon.call(daemon.route, over_taint).await,
        "invalid",
        Some("class_over_declared"),
    );

    let mut unknown = commit_request(&daemon.project, "unknown", vec![insert_decision(1)], vec![]);
    unknown["source_kind"] = json!("oracle");
    assert_state(
        &daemon.call(daemon.route, unknown).await,
        "invalid",
        Some("invalid_input"),
    );

    let mut derived = commit_request(&daemon.project, "derived", vec![insert_decision(1)], vec![]);
    derived["asserted_source_class"] = json!("model_inference");
    derived["asserted_taint_class"] = json!("assistant_inference");
    let response = daemon.call(daemon.route, derived).await;
    assert_state(&response, "available", None);
    let read = daemon.read("explicit_search", None).await;
    assert_eq!(object_ids(&read), ["decision-object-1"]);
    // Inference-class writes serve labeled on explicit search and never on
    // the automatic surfaces.
    assert_eq!(read["rows"][0]["labeled"], true);
    assert!(object_ids(&daemon.read("auto_inject", None).await).is_empty());
    assert!(object_ids(&daemon.read("auto_search", None).await).is_empty());
    daemon.handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_request_naming_another_project_root_is_refused_before_any_work() {
    let daemon = Daemon::start().await;
    seed_domain(&daemon.store());
    let tip = daemon.tip();
    let elsewhere = daemon._data.path().join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    let response = daemon
        .call(
            daemon.route,
            commit_request(&elsewhere, "foreign", vec![insert_decision(1)], vec![]),
        )
        .await;
    assert_state(&response, "invalid", Some("project_mismatch"));
    assert_eq!(daemon.tip(), tip);
    let read = daemon
        .call(
            daemon.route,
            read_request(&elsewhere, "explicit_search", None),
        )
        .await;
    assert_state(&read, "invalid", Some("project_mismatch"));
    // A missing project_root is a malformed request, not a kernel state.
    let mut missing = read_request(&daemon.project, "explicit_search", None);
    missing.as_object_mut().unwrap().remove("project_root");
    assert!(matches!(
        daemon.handler.dispatch_value_for_test(daemon.route, missing).await,
        PreparedOutcome::Error { code, .. } if code == "invalid_params"
    ));
    daemon.handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn rows_serve_only_to_the_project_their_scope_names() {
    let daemon = Daemon::start().await;
    let store = daemon.store();
    seed_domain(&store);
    assert_state(
        &daemon.commit("a", vec![insert_decision(1)], vec![]).await,
        "available",
        None,
    );
    let (route_b, project_b) = daemon.bind_project("project-b").await;
    let mut write_b = commit_request(&project_b, "b", vec![insert_decision(2)], vec![]);
    write_b["session_id"] = json!("session-b");
    assert_state(&daemon.call(route_b, write_b).await, "available", None);

    // A row whose project term was redacted names no resolvable project.
    store
        .commit(intent("redacted-scope"), |envelope| {
            envelope.insert_scope(ScopeSpec {
                scope_id: "scope-redacted".to_string(),
                object_id: "scope-redacted".to_string(),
                domain_id: DOMAIN.to_string(),
                source_kind: "fixture".to_string(),
                source_id: "scope-redacted".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
                terms: vec![ScopeTermSpec {
                    dimension: "project".to_string(),
                    operator: "exact".to_string(),
                    exact_value: Some(format!("/projects/{SECRET}")),
                    ..ScopeTermSpec::default()
                }],
            })?;
            envelope.insert_decision(store_decision(9, "scope-redacted", "redacted-lineage"))?;
            envelope.record_admission(admission(
                "store-decision-object-9",
                EventKind::Other,
                None,
                (SourceClass::ModelInference, TaintClass::AssistantInference),
            ))?;
            Ok(String::new())
        })
        .unwrap();
    let terms = store.scope_terms("scope-redacted").unwrap();
    assert!(!terms[0].exact_value.as_deref().unwrap().contains(SECRET));

    let read_a = daemon.read("explicit_search", None).await;
    assert_eq!(object_ids(&read_a), ["decision-object-1"]);
    let mut request_b = read_request(&project_b, "explicit_search", None);
    request_b["session_id"] = json!("session-b");
    let read_b = daemon.call(route_b, request_b).await;
    assert_eq!(object_ids(&read_b), ["decision-object-2"]);
    // The unfiltered kernel view still holds all three, so the filter is what
    // hid them.
    let all = store
        .visible_as_of(mc_kernel::Surface::ExplicitSearch, daemon.tip())
        .unwrap();
    assert_eq!(all.rows.len(), 3);
    daemon.handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn reads_at_a_snapshot_return_what_was_visible_then() {
    let daemon = Daemon::start().await;
    let store = daemon.store();
    seed_domain(&store);
    // The first route write materializes the project scope used below.
    daemon
        .commit("seed", vec![insert_decision(1)], vec![])
        .await;
    let scope_id = daemon.project_scope_id().await;

    // A verified decision, the maturity `auto_inject` serves, admitted at N.
    let n = store
        .commit(intent("verified"), |envelope| {
            envelope.insert_observation(code_observation(1, "verified-lineage"))?;
            envelope.insert_decision(store_decision(1, &scope_id, "verified-lineage"))?;
            envelope.record_admission(admission(
                "store-decision-object-1",
                EventKind::CodeObserved,
                Some("observation-object-1"),
                (SourceClass::TrustedLocalCode, TaintClass::CurrentCode),
            ))?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;
    let at_n = daemon.read("auto_inject", Some(n)).await;
    assert_eq!(object_ids(&at_n), ["store-decision-object-1"]);
    assert_eq!(at_n["rows"][0]["visibility"], "visible");
    assert_eq!(
        at_n["rows"][0]["token"],
        token("store-decision-object-1", n)
    );

    // N+1: the verified decision is marked stale and a second row appears.
    store
        .commit(intent("retract"), |envelope| {
            envelope.record_admission(admission(
                "store-decision-object-1",
                EventKind::MarkStale,
                None,
                (SourceClass::TrustedLocalCode, TaintClass::CurrentCode),
            ))?;
            Ok(String::new())
        })
        .unwrap();
    daemon
        .commit("later", vec![insert_decision(2)], vec![])
        .await;

    let at_tip = daemon.read("auto_inject", None).await;
    assert_state(&at_tip, "available", None);
    assert!(object_ids(&at_tip).is_empty(), "{at_tip}");
    assert_eq!(at_tip["known_as_of"], at_tip["tip"]);
    let still_n = daemon.read("auto_inject", Some(n)).await;
    assert_eq!(object_ids(&still_n), ["store-decision-object-1"]);
    assert_eq!(still_n["known_as_of"], n);
    let explicit_at_n = daemon.read("explicit_search", Some(n)).await;
    assert_eq!(
        object_ids(&explicit_at_n),
        ["decision-object-1", "store-decision-object-1"]
    );
    let explicit_at_tip = daemon.read("explicit_search", None).await;
    assert_eq!(
        object_ids(&explicit_at_tip),
        [
            "decision-object-1",
            "decision-object-2",
            "store-decision-object-1"
        ]
    );

    let future = daemon.read("auto_inject", Some(daemon.tip() + 1)).await;
    assert_state(&future, "unavailable", Some("snapshot_diverged"));
    daemon.handler.shutdown().await.unwrap();
}

fn eligibility_request(project: &Path, destination: &str, candidates: Vec<Value>) -> Value {
    json!({
        "method": "kernel.eligibility.batch",
        "v": 1,
        "session_id": SESSION,
        "project_root": project.to_str().unwrap(),
        "destination": destination,
        "candidates": candidates,
    })
}

fn verdicts(response: &Value) -> Vec<(String, String)> {
    response["verdicts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["object_id"].as_str().unwrap().to_string(),
                entry["verdict"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[tokio::test]
async fn eligibility_verdicts_cover_every_class_and_cache_per_incarnation_and_tip() {
    let daemon = Daemon::start().await;
    let store = daemon.store();
    seed_domain(&store);
    daemon
        .commit(
            "create",
            vec![
                insert_decision(1),
                insert_decision(2),
                insert_decision(3),
                insert_decision(4),
                insert_decision(6),
            ],
            vec![],
        )
        .await;
    daemon
        .commit(
            "change",
            vec![
                json!({"op": "retire_decision", "object_id": "decision-object-2"}),
                json!({"op": "supersede_decision", "replaced_object_id": "decision-object-3", "spec": decision_spec(5)}),
            ],
            vec![],
        )
        .await;
    let (route_b, project_b) = daemon.bind_project("project-b").await;
    let mut write_b = commit_request(&project_b, "b", vec![insert_decision(7)], vec![]);
    write_b["session_id"] = json!("session-b");
    daemon.call(route_b, write_b).await;
    let sensitive = store
        .ingest_artifact(ingest(
            "sensitive",
            b"sensitive bytes",
            Sensitivity::Sensitive,
        ))
        .unwrap();

    let candidates = vec![
        json!({"object_id": "decision-object-1", "source_revision": 1}),
        json!({"object_id": "decision-object-2", "source_revision": 2}),
        json!({"object_id": "decision-object-3", "source_revision": 3}),
        json!({"object_id": "decision-object-4", "source_revision": 40}),
        json!({"object_id": "decision-object-7", "source_revision": 7}),
        json!({"object_id": "decision-object-6", "source_revision": 6, "artifact_digest": sensitive.digest}),
        json!({"object_id": "never-written", "source_revision": 1}),
    ];
    let request = eligibility_request(&daemon.project, "remote", candidates.clone());
    let first = daemon.call(daemon.route, request.clone()).await;
    assert_state(&first, "available", None);
    assert_eq!(first["known_as_of"], daemon.tip());
    assert_eq!(first["cache_hits"], 0);
    assert_eq!(
        verdicts(&first),
        [
            ("decision-object-1", "ok"),
            ("decision-object-2", "retracted"),
            ("decision-object-3", "superseded"),
            ("decision-object-4", "stale"),
            ("decision-object-7", "wrong_scope"),
            ("decision-object-6", "provider_sensitive"),
            ("never-written", "retracted"),
        ]
        .map(|(id, verdict)| (id.to_string(), verdict.to_string()))
    );
    assert_eq!(daemon.handler.eligibility_cache_len_for_test(), 7);

    // Same tip, same candidates: every verdict comes from the cache.
    let second = daemon.call(daemon.route, request.clone()).await;
    assert_eq!(second["cache_hits"], 7);
    assert_eq!(verdicts(&second), verdicts(&first));
    // A different declared revision is a different key and a different verdict.
    let revised = daemon
        .call(
            daemon.route,
            eligibility_request(
                &daemon.project,
                "remote",
                vec![json!({"object_id": "decision-object-1", "source_revision": 2})],
            ),
        )
        .await;
    assert_eq!(revised["cache_hits"], 0);
    assert_eq!(verdicts(&revised)[0].1, "stale");
    // Locally the sensitive artifact is eligible; destination is part of the key.
    let local = daemon
        .call(
            daemon.route,
            eligibility_request(&daemon.project, "local", candidates.clone()),
        )
        .await;
    assert_eq!(local["cache_hits"], 0);
    assert_eq!(verdicts(&local)[5].1, "ok");

    // Retiring the `ok` candidate moves the tip, so the old entries stop matching.
    daemon
        .commit(
            "retire-1",
            vec![json!({"op": "retire_decision", "object_id": "decision-object-1"})],
            vec![],
        )
        .await;
    let third = daemon.call(daemon.route, request.clone()).await;
    assert_eq!(third["cache_hits"], 0);
    assert_eq!(verdicts(&third)[0].1, "retracted");

    // Dropping the store slot empties the map with it.
    assert!(daemon.handler.eligibility_cache_len_for_test() > 0);
    daemon.handler.shutdown().await.unwrap();
    assert_eq!(daemon.handler.eligibility_cache_len_for_test(), 0);
}

#[tokio::test]
async fn an_artifact_purge_advances_the_commit_sequence() {
    let daemon = Daemon::start().await;
    let store = daemon.store();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(ingest("purged", b"purge me", Sensitivity::Normal))
        .unwrap();
    let before = daemon.tip();
    let result = store
        .delete_artifact(ArtifactDeletionRequest {
            intent: intent("purge"),
            identity: ArtifactDeletionIdentity::Digest(handle.digest.clone()),
            kind: ArtifactDeletionKind::Purge,
            operator_id: Some("operator-1".to_string()),
            target_locator: Some("incident://secret-1".to_string()),
            reason: Some("secret".to_string()),
            deleted_at: 42,
        })
        .unwrap();
    let after = daemon.tip();
    assert!(after > before, "purge left the tip at {before}");
    assert_eq!(result.commit_seq, after);
    daemon.handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_commit_that_cannot_take_the_writer_by_its_deadline_is_store_busy() {
    let daemon = Daemon::start().await;
    let store = daemon.store();
    seed_domain(&store);
    let held = store.clone();
    let holder = std::thread::spawn(move || {
        held.commit(intent("hold"), |_| {
            std::thread::sleep(Duration::from_millis(1_500));
            Ok(String::new())
        })
        .unwrap()
    });
    // Let the holder take the writer before the bounded commit asks for it.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut bounded = commit_request(&daemon.project, "bounded", vec![insert_decision(1)], vec![]);
    bounded["deadline_ms"] = json!(100);
    let started = Instant::now();
    let busy = daemon.call(daemon.route, bounded).await;
    assert_state(&busy, "unavailable", Some("store_busy"));
    assert!(
        started.elapsed() < Duration::from_millis(1_200),
        "{:?}",
        started.elapsed()
    );
    holder.join().unwrap();

    let landed = daemon
        .commit("after", vec![insert_decision(2)], vec![])
        .await;
    assert_state(&landed, "available", None);
    let read = daemon.read("explicit_search", None).await;
    assert_eq!(object_ids(&read), ["decision-object-2"]);
    daemon.handler.shutdown().await.unwrap();
}

// ---------------------------------------------------------------------------
// Serving policy and the egress decision
// ---------------------------------------------------------------------------

fn gated_read_request(project: &Path, surface: &str, now_ms: i64) -> Value {
    let mut request = read_request(project, surface, None);
    request["gated"] = json!(true);
    request["now_ms"] = json!(now_ms);
    request
}

fn core_connection(daemon: &Daemon) -> rusqlite::Connection {
    rusqlite::Connection::open(kernel_root(&daemon.descriptor).join("core.sqlite")).unwrap()
}

/// The newest outbox position, which is always the last row of its commit and
/// so a legal publication watermark.
fn newest_outbox_position(daemon: &Daemon) -> i64 {
    core_connection(daemon)
        .query_row("SELECT MAX(outbox_position) FROM outbox", [], |row| {
            row.get(0)
        })
        .unwrap()
}

/// Creation time of the oldest outbox row past `checkpoint`, the row whose
/// age the lag facts report.
fn oldest_unconsumed_created_at(daemon: &Daemon, checkpoint: i64) -> i64 {
    core_connection(daemon)
        .query_row(
            "SELECT MIN(created_at) FROM outbox WHERE commit_seq > ?1",
            [checkpoint],
            |row| row.get(0),
        )
        .unwrap()
}

impl Daemon {
    async fn gated_read(&self, surface: &str, now_ms: i64) -> Value {
        self.call(
            self.route,
            gated_read_request(&self.project, surface, now_ms),
        )
        .await
    }

    fn register_consumer(&self, consumer: &str) -> i64 {
        self.store()
            .commit(intent(&format!("register-{consumer}")), |envelope| {
                envelope.register_outbox_consumer(consumer, 1)?;
                Ok(String::new())
            })
            .unwrap()
            .commit_seq
    }

    fn deregister_consumer(&self, consumer: &str) {
        self.store()
            .commit(intent(&format!("deregister-{consumer}")), |envelope| {
                envelope.deregister_outbox_consumer(consumer, 1)?;
                Ok(String::new())
            })
            .unwrap();
    }

    /// Emits `count` outbox rows and publishes every row emitted so far.
    fn publish_domains(&self, first: i64, count: i64) {
        let store = self.store();
        let mut next = first;
        while next < first + count {
            let batch = (first + count - next).min(2_500);
            insert_domains(&store, next, batch);
            next += batch;
        }
        store
            .mark_outbox_published_through(newest_outbox_position(self), 1)
            .unwrap();
    }
}

fn assert_stale(value: &Value, lag_positions: i64) {
    assert_state(value, "stale", None);
    assert_eq!(value["state"]["lag_positions"], lag_positions, "{value}");
    assert!(value.get("rows").is_none(), "{value}");
}

#[tokio::test]
async fn search_returns_stale_marker_and_injection_abstains_past_threshold() {
    let daemon = Daemon::start().await;
    let store = daemon.store();
    seed_domain(&store);
    daemon
        .commit("create-1", vec![insert_decision(1)], vec![])
        .await;

    // No registered consumer: freshness cannot be judged, so explicit search
    // says so, automatic surfaces abstain, and ungated reads serve rows.
    let explicit = daemon.gated_read("explicit_search", 1).await;
    assert_state(&explicit, "unavailable", Some("no_required_consumer"));
    assert!(explicit.get("rows").is_none());
    for surface in ["auto_search", "auto_inject"] {
        assert_state(&daemon.gated_read(surface, 1).await, "abstained", None);
    }
    assert_eq!(
        object_ids(&daemon.read("explicit_search", None).await),
        ["decision-object-1"]
    );

    // A consumer caught up to its registration, then 9,999 published rows.
    let registered = daemon.register_consumer("projector");
    store
        .acknowledge_outbox("projector", registered, 1)
        .unwrap();
    daemon.publish_domains(1, 9_999);
    let created_at = oldest_unconsumed_created_at(&daemon, registered);
    let below = daemon
        .gated_read("explicit_search", created_at + 59_999)
        .await;
    assert_state(&below, "available", None);
    assert_eq!(object_ids(&below), ["decision-object-1"]);

    // The 10,000th published position trips the counter threshold.
    daemon.publish_domains(10_000, 1);
    let stale = daemon
        .gated_read("explicit_search", created_at + 59_999)
        .await;
    assert_stale(&stale, 10_000);
    assert_eq!(stale["state"]["oldest_unconsumed_age_ms"], 59_999);
    for surface in ["auto_search", "auto_inject"] {
        let abstained = daemon.gated_read(surface, created_at + 59_999).await;
        assert_state(&abstained, "abstained", None);
        assert_eq!(abstained["state"]["lag_positions"], 10_000);
        assert!(abstained.get("rows").is_none());
    }
    // Canonical writes continue past the threshold, and ungated reads see them.
    let receipt = daemon
        .commit("create-2", vec![insert_decision(2)], vec![])
        .await;
    assert_state(&receipt, "available", None);
    assert!(receipt["receipt"]["commit_seq"].is_i64(), "{receipt}");
    assert_eq!(
        object_ids(&daemon.read("explicit_search", None).await),
        ["decision-object-1", "decision-object-2"]
    );
    assert_state(&daemon.read("auto_search", None).await, "available", None);

    // Acknowledging everything but the last commit leaves one unpublished
    // commit whose age alone decides the verdict.
    let tip = daemon.tip();
    store.acknowledge_outbox("projector", tip - 1, 1).unwrap();
    let created_at = oldest_unconsumed_created_at(&daemon, tip - 1);
    let fresh = daemon
        .gated_read("explicit_search", created_at + 59_999)
        .await;
    assert_state(&fresh, "available", None);
    assert_eq!(fresh["known_as_of"], tip);
    let aged = daemon
        .gated_read("explicit_search", created_at + 60_000)
        .await;
    assert_stale(&aged, 0);
    assert_eq!(aged["state"]["oldest_unconsumed_age_ms"], 60_000);
    assert_state(
        &daemon.gated_read("auto_search", created_at + 60_000).await,
        "abstained",
        None,
    );

    // Catching up and leaving returns the store to the unjudgeable state.
    store.acknowledge_outbox("projector", tip, 1).unwrap();
    daemon.deregister_consumer("projector");
    assert_state(
        &daemon
            .gated_read("explicit_search", created_at + 60_000)
            .await,
        "unavailable",
        Some("no_required_consumer"),
    );

    // A consumer that joins behind 12,000 published rows is stale by exactly
    // that many until it acknowledges past the threshold.
    let before = daemon.tip();
    let first_batch = insert_domains(&store, 20_000, 1_000);
    daemon.publish_domains(21_000, 11_000);
    let joined = daemon.register_consumer("late");
    store.acknowledge_outbox("late", before, 1).unwrap();
    let created_at = oldest_unconsumed_created_at(&daemon, before);
    assert_stale(
        &daemon.gated_read("explicit_search", created_at).await,
        12_000,
    );
    store.acknowledge_outbox("late", first_batch, 1).unwrap();
    assert_stale(
        &daemon.gated_read("explicit_search", created_at).await,
        11_000,
    );
    // The next commit holds 2,500 rows, so acknowledging it crosses back
    // under the threshold.
    store
        .acknowledge_outbox("late", first_batch + 1, 1)
        .unwrap();
    let caught_up = daemon.gated_read("explicit_search", created_at).await;
    assert_state(&caught_up, "available", None);
    assert_eq!(
        object_ids(&caught_up),
        ["decision-object-1", "decision-object-2"]
    );
    store.acknowledge_outbox("late", joined, 1).unwrap();
    daemon.deregister_consumer("late");
    assert_state(
        &daemon.gated_read("explicit_search", created_at).await,
        "unavailable",
        Some("no_required_consumer"),
    );
    assert_state(
        &daemon.gated_read("auto_search", created_at).await,
        "abstained",
        None,
    );
    daemon.handler.shutdown().await.unwrap();
}

/// Stands in for a provider: the test dispatches through it only when the
/// gate answered `allowed`, so its count is the number of requests made.
struct Recorder(std::sync::atomic::AtomicUsize);

impl Recorder {
    fn dispatch(&self) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    fn requests(&self) -> usize {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn egress_request(
    project: &Path,
    digest: &str,
    destination: &str,
    asserted: &str,
    owning_object_id: &str,
) -> Value {
    json!({
        "method": "kernel.egress.decide",
        "v": 1,
        "session_id": SESSION,
        "project_root": project.to_str().unwrap(),
        "artifact_digest": digest,
        "destination": destination,
        "asserted_sensitivity": asserted,
        "owning_object_id": owning_object_id,
    })
}

impl Daemon {
    /// Asks the gate and dispatches through `recorder` exactly when it allows,
    /// returning the wire decision.
    async fn egress(
        &self,
        recorder: &Recorder,
        digest: &str,
        destination: &str,
        asserted: &str,
        owning_object_id: &str,
    ) -> Value {
        let response = self
            .call(
                self.route,
                egress_request(
                    &self.project,
                    digest,
                    destination,
                    asserted,
                    owning_object_id,
                ),
            )
            .await;
        assert_state(&response, "available", None);
        if response["decision"] == json!("allowed") {
            recorder.dispatch();
        }
        response["decision"].clone()
    }
}

fn refused(reason: &str) -> Value {
    json!({"refused": reason})
}

/// Artifacts of every class plus an owning object in the bound project and
/// one in another project.
async fn egress_fixture(daemon: &Daemon) -> [String; 3] {
    let store = daemon.store();
    seed_domain(&store);
    daemon
        .commit("create-1", vec![insert_decision(1)], vec![])
        .await;
    let (route_b, project_b) = daemon.bind_project("project-b").await;
    let mut write_b = commit_request(&project_b, "b", vec![insert_decision(2)], vec![]);
    write_b["session_id"] = json!("session-b");
    assert_state(&daemon.call(route_b, write_b).await, "available", None);
    let normal = store
        .ingest_artifact(ingest("normal", b"public bytes", Sensitivity::Normal))
        .unwrap();
    let sensitive = store
        .ingest_artifact(ingest(
            "sensitive",
            b"private bytes",
            Sensitivity::Sensitive,
        ))
        .unwrap();
    let secret = store
        .ingest_artifact(ingest("secret", b"classified bytes", Sensitivity::Secret))
        .unwrap();
    [normal.digest, sensitive.digest, secret.digest]
}

#[tokio::test]
async fn egress_gate_rejects_sensitive_remote_and_all_secret_without_a_request() {
    let daemon = Daemon::start().await;
    let [normal, sensitive, secret] = egress_fixture(&daemon).await;
    let recorder = Recorder(std::sync::atomic::AtomicUsize::new(0));
    let owner = "decision-object-1";

    assert_eq!(
        daemon
            .egress(&recorder, &sensitive, "remote", "normal", owner)
            .await,
        refused("under_declared")
    );
    assert_eq!(
        daemon
            .egress(&recorder, &sensitive, "remote", "sensitive", owner)
            .await,
        refused("sensitive_remote")
    );
    for destination in ["local", "remote"] {
        for asserted in ["normal", "sensitive", "secret"] {
            assert_eq!(
                daemon
                    .egress(&recorder, &secret, destination, asserted, owner)
                    .await,
                refused("secret"),
                "{destination} {asserted}"
            );
        }
    }
    assert_eq!(
        daemon
            .egress(&recorder, &"a".repeat(64), "remote", "normal", owner)
            .await,
        refused("unknown_sensitive")
    );
    assert_eq!(
        daemon
            .egress(&recorder, &normal, "remote", "normal", "decision-object-2")
            .await,
        refused("wrong_scope")
    );
    assert_eq!(
        daemon
            .egress(&recorder, &normal, "remote", "normal", "never-written")
            .await,
        refused("wrong_scope")
    );
    assert_eq!(recorder.requests(), 0, "a refusal made a provider request");

    assert_eq!(
        daemon
            .egress(&recorder, &normal, "remote", "normal", owner)
            .await,
        json!("allowed")
    );
    assert_eq!(recorder.requests(), 1);
    // Local egress of a sensitive artifact is eligible when declared honestly.
    assert_eq!(
        daemon
            .egress(&recorder, &sensitive, "local", "sensitive", owner)
            .await,
        json!("allowed")
    );
    assert_eq!(recorder.requests(), 2);
    daemon.handler.shutdown().await.unwrap();
}

#[tokio::test]
async fn egress_gate_rejects_an_under_declared_normal_request_without_a_request() {
    let daemon = Daemon::start().await;
    let [_, sensitive, _] = egress_fixture(&daemon).await;
    let recorder = Recorder(std::sync::atomic::AtomicUsize::new(0));

    assert_eq!(
        daemon
            .egress(
                &recorder,
                &sensitive,
                "remote",
                "normal",
                "decision-object-1"
            )
            .await,
        refused("under_declared")
    );
    // The same artifact declared honestly is refused for its destination, not
    // its declaration, so the first refusal was the assertion's.
    assert_eq!(
        daemon
            .egress(
                &recorder,
                &sensitive,
                "remote",
                "sensitive",
                "decision-object-1"
            )
            .await,
        refused("sensitive_remote")
    );
    assert_eq!(recorder.requests(), 0);
    daemon.handler.shutdown().await.unwrap();
}
