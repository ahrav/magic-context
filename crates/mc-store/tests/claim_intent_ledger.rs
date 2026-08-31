use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_core::claim_operation::{
    canonical_json_encode, compute_claim_operation_request_digest, ClaimCommandIdentity,
    ClaimIntentAckKind, ClaimIntentBinding, ClaimIntentState,
};
use mc_store::{McStore, McStoreError};
use serde_json::{json, Value};

const INCARNATION: &str = "0123456789abcdef0123456789abcdef";
const PROJECT: &str = "git:claim-intent-test";
/// The context store UUID must differ from `INCARNATION` so tests detect fences that key `mc_authority` by the wrong identifier.
/// An authority fence must not key `mc_authority` by the database incarnation.
const STORE_UUID: &str = "6f1d0c4a-6f2b-4b7a-9c3d-2e5f8a1b4c7d";
const ROUTE_ROOT: &str = "/repo/claim-intent-test";

fn descriptor(dir: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "magic-context-test".to_string(),
        storage_namespace: "mc_cache".to_string(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into_owned(),
        },
    }
}

fn binding(generation: u64) -> ClaimIntentBinding {
    ClaimIntentBinding {
        database_incarnation_id: INCARNATION.to_string(),
        format_epoch: 1,
        authority_project: PROJECT.to_string(),
        authority_generation: generation,
    }
}

fn command(key: impl Into<String>) -> ClaimCommandIdentity {
    ClaimCommandIdentity {
        producer: "mc-module".to_string(),
        operation_key: key.into(),
    }
}

fn request(value: i64) -> Value {
    json!({"operation":"create","value":value})
}

/// Staging requires authority resolved through a route bound to the project.
/// Staging without a route-bound authority is refused.
fn module_authority(store: &McStore) -> u64 {
    store
        .bind_authority_route(STORE_UUID, PROJECT, ROUTE_ROOT)
        .unwrap();
    let preparing = store
        .authority_begin_prepare(STORE_UUID, PROJECT, "memories")
        .unwrap();
    store
        .authority_finish_prepare(
            STORE_UUID,
            PROJECT,
            "memories",
            preparing.generation,
            "same",
            "same",
            true,
        )
        .unwrap()
        .generation
}

fn result(outcome: &str) -> String {
    canonical_json_encode(&json!({
        "resultEncodingVersion": 1,
        "outcome": outcome,
        "staleReason": if outcome == "stale" { json!("authority changed") } else { Value::Null },
        "payload": Value::Null,
        "effects": [],
        "generations": {},
    }))
    .unwrap()
}

#[test]
fn acknowledged_intent_survives_more_than_512_later_commands() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let generation = module_authority(&store);
    let first = command("first");
    let staged = store
        .stage_claim_intent(ROUTE_ROOT, &binding(generation), &first, &request(0), 1)
        .unwrap();
    let committed = store
        .acknowledge_claim_intent(
            &binding(generation),
            &first,
            &staged.record.request_digest,
            ClaimIntentAckKind::ContextCommitted,
            Some(&result("noop")),
            2,
        )
        .unwrap();
    store
        .acknowledge_claim_intent(
            &binding(generation),
            &first,
            &committed.record.request_digest,
            ClaimIntentAckKind::Acknowledged,
            None,
            3,
        )
        .unwrap();

    for index in 0..600 {
        store
            .stage_claim_intent(
                ROUTE_ROOT,
                &binding(generation),
                &command(format!("later-{index:03}")),
                &request(index),
                index + 10,
            )
            .unwrap();
    }

    let retained = store.inspect_claim_intent(&first).unwrap().unwrap();
    assert_eq!(retained.state, ClaimIntentState::Acknowledged);
    assert_eq!(store.list_claim_intents(false, 1_000).unwrap().len(), 601);
}

#[test]
fn staged_intent_reopens_and_rejects_binding_or_digest_reuse() {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());
    let identity = command("restart");
    let (original_digest, generation) = {
        let store = McStore::open(&descriptor).unwrap();
        let generation = module_authority(&store);
        let digest = store
            .stage_claim_intent(ROUTE_ROOT, &binding(generation), &identity, &request(1), 10)
            .unwrap()
            .record
            .request_digest;
        (digest, generation)
    };

    let store = McStore::open(&descriptor).unwrap();
    let reopened = store.inspect_claim_intent(&identity).unwrap().unwrap();
    assert_eq!(reopened.request_digest, original_digest);
    assert_eq!(reopened.state, ClaimIntentState::Staged);

    let mut other_incarnation = binding(generation);
    other_incarnation.database_incarnation_id = "abcdef0123456789abcdef0123456789".to_string();
    assert!(matches!(
        store.stage_claim_intent(ROUTE_ROOT, &other_incarnation, &identity, &request(1), 11),
        Err(McStoreError::ClaimIntentBindingMismatch {
            field: "database incarnation",
            ..
        })
    ));
    assert!(matches!(
        store.stage_claim_intent(ROUTE_ROOT, &binding(generation), &identity, &request(2), 12),
        Err(McStoreError::ClaimIntentIdentityConflict { .. })
    ));
}

#[test]
fn stale_zero_effect_result_can_settle_after_authority_drain_starts() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    store
        .bind_authority_route(STORE_UUID, PROJECT, ROUTE_ROOT)
        .unwrap();
    let preparing = store
        .authority_begin_prepare(STORE_UUID, PROJECT, "memories")
        .unwrap();
    // A `PREPARING` authority is not `MODULE`, so the route-resolved fence refuses staging.
    assert!(matches!(
        store.stage_claim_intent(ROUTE_ROOT, &binding(preparing.generation), &command("preparing"), &request(0), 0),
        Err(McStoreError::ClaimIntentAuthorityFrozen { ref state }) if state == "PREPARING"
    ));
    let active = store
        .authority_finish_prepare(
            STORE_UUID,
            PROJECT,
            "memories",
            preparing.generation,
            "same",
            "same",
            true,
        )
        .unwrap();
    let active_binding = binding(active.generation);
    let identity = command("stale");
    let staged = store
        .stage_claim_intent(ROUTE_ROOT, &active_binding, &identity, &request(1), 1)
        .unwrap();

    let draining = store
        .authority_begin_drain(STORE_UUID, PROJECT, "memories", "lease", 100, 2)
        .unwrap();
    assert!(draining.generation > active.generation);
    assert!(matches!(
        store.stage_claim_intent(
            ROUTE_ROOT,
            &binding(draining.generation),
            &command("new"),
            &request(2),
            3,
        ),
        Err(McStoreError::ClaimIntentAuthorityFrozen { ref state }) if state == "DRAINING"
    ));

    let settled = store
        .acknowledge_claim_intent(
            &active_binding,
            &identity,
            &staged.record.request_digest,
            ClaimIntentAckKind::TerminalRejected,
            Some(&result("stale")),
            4,
        )
        .unwrap();
    assert_eq!(settled.record.state, ClaimIntentState::TerminalRejected);
    assert_eq!(store.unresolved_claim_intent_count().unwrap(), 0);
}

#[test]
fn staging_fails_closed_without_route_resolved_module_authority() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();

    // A binding alone cannot stage without a route binding and authority row.
    // The authority lookup must use the route-bound identifier rather than the caller-supplied marker incarnation.
    assert!(matches!(
        store.stage_claim_intent(ROUTE_ROOT, &binding(1), &command("unowned"), &request(0), 1),
        Err(McStoreError::ClaimIntentRouteNotManaged)
    ));
    assert_eq!(store.unresolved_claim_intent_count().unwrap(), 0);

    let generation = module_authority(&store);

    // A binding naming another project cannot borrow the route's authority.
    // A binding naming another project cannot borrow the route's authority.
    let mut foreign = binding(generation);
    foreign.authority_project = "git:someone-else".to_string();
    assert!(matches!(
        store.stage_claim_intent(ROUTE_ROOT, &foreign, &command("foreign"), &request(1), 2),
        Err(McStoreError::ClaimIntentBindingMismatch {
            field: "authority project",
            ..
        })
    ));

    // The stage rejects a generation that differs from the live authority row.
    assert!(matches!(
        store.stage_claim_intent(
            ROUTE_ROOT,
            &binding(generation + 1),
            &command("stale-generation"),
            &request(2),
            3,
        ),
        Err(McStoreError::ClaimIntentBindingMismatch {
            field: "authority generation",
            ..
        })
    ));

    // An unbound route cannot stage even when authority exists for the project.
    assert!(matches!(
        store.stage_claim_intent(
            "/repo/some-other-route",
            &binding(generation),
            &command("unbound-route"),
            &request(3),
            4,
        ),
        Err(McStoreError::ClaimIntentRouteNotManaged)
    ));

    assert_eq!(store.unresolved_claim_intent_count().unwrap(), 0);
}

#[test]
fn store_rebuild_is_refused_until_intents_drain_then_freezes_new_stages() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let generation = module_authority(&store);
    let identity = command("pending");
    let staged = store
        .stage_claim_intent(ROUTE_ROOT, &binding(generation), &identity, &request(1), 1)
        .unwrap();

    assert!(matches!(
        store.begin_claim_store_rebuild(INCARNATION, generation, 2),
        Err(McStoreError::ClaimIntentResetBlocked { unresolved: 1 })
    ));
    store
        .acknowledge_claim_intent(
            &binding(generation),
            &identity,
            &staged.record.request_digest,
            ClaimIntentAckKind::TerminalRejected,
            Some(&result("stale")),
            3,
        )
        .unwrap();
    store
        .begin_claim_store_rebuild(INCARNATION, generation, 4)
        .unwrap();
    assert!(matches!(
        store.stage_claim_intent(ROUTE_ROOT, &binding(generation), &command("too-late"), &request(2), 5),
        Err(McStoreError::ClaimIntentAuthorityFrozen { ref state }) if state == "resetting"
    ));
    let mut replacement = binding(generation);
    replacement.database_incarnation_id = "abcdef0123456789abcdef0123456789".to_string();
    assert!(matches!(
        store.stage_claim_intent(ROUTE_ROOT, &replacement, &command("replacement"), &request(3), 6),
        Err(McStoreError::ClaimIntentAuthorityFrozen { ref state }) if state == "resetting"
    ));

    let digest = compute_claim_operation_request_digest(&request(1)).unwrap();
    assert_eq!(
        store
            .inspect_claim_intent(&identity)
            .unwrap()
            .unwrap()
            .request_digest,
        digest
    );
}

/// Replaying a `staged` intent revalidates live authority rather than trusting the stored binding.
///
/// A replay executes the same context mutation.
/// Recovery reads of terminal or committed rows remain idempotent; only `staged` rows are fenced.
#[test]
fn replaying_a_staged_intent_refuses_after_authority_begins_draining() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    store
        .bind_authority_route(STORE_UUID, PROJECT, ROUTE_ROOT)
        .unwrap();
    let preparing = store
        .authority_begin_prepare(STORE_UUID, PROJECT, "memories")
        .unwrap();
    let active = store
        .authority_finish_prepare(
            STORE_UUID,
            PROJECT,
            "memories",
            preparing.generation,
            "same",
            "same",
            true,
        )
        .unwrap();
    let active_binding = binding(active.generation);
    let identity = command("replay-fence");

    // The first attempt simulates a crash before context commit by leaving the intent staged.
    let staged = store
        .stage_claim_intent(ROUTE_ROOT, &active_binding, &identity, &request(1), 1)
        .unwrap();
    assert!(!staged.replayed);
    assert_eq!(staged.record.state, ClaimIntentState::Staged);

    let draining = store
        .authority_begin_drain(STORE_UUID, PROJECT, "memories", "lease", 100, 2)
        .unwrap();
    assert!(draining.generation > active.generation);

    // The retry's identity, digest, and binding match the stored intent; a live authority read must reject it.
    assert!(matches!(
        store.stage_claim_intent(ROUTE_ROOT, &active_binding, &identity, &request(1), 3),
        Err(McStoreError::ClaimIntentAuthorityFrozen { ref state }) if state == "DRAINING"
    ));

    // The staged row is untouched, so the drain can still settle it.
    let settled = store
        .acknowledge_claim_intent(
            &active_binding,
            &identity,
            &staged.record.request_digest,
            ClaimIntentAckKind::TerminalRejected,
            Some(&result("stale")),
            4,
        )
        .unwrap();
    assert_eq!(settled.record.state, ClaimIntentState::TerminalRejected);
}
