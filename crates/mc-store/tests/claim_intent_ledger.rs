use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_core::claim_operation::{
    canonical_json_encode, compute_claim_operation_request_digest, ClaimCommandIdentity,
    ClaimIntentAckKind, ClaimIntentBinding, ClaimIntentState,
};
use mc_store::{McStore, McStoreError};
use serde_json::{json, Value};

const INCARNATION: &str = "0123456789abcdef0123456789abcdef";
const PROJECT: &str = "git:claim-intent-test";

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
    let first = command("first");
    let staged = store
        .stage_claim_intent(&binding(1), &first, &request(0), 1)
        .unwrap();
    let committed = store
        .acknowledge_claim_intent(
            &binding(1),
            &first,
            &staged.record.request_digest,
            ClaimIntentAckKind::ContextCommitted,
            Some(&result("noop")),
            2,
        )
        .unwrap();
    store
        .acknowledge_claim_intent(
            &binding(1),
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
                &binding(1),
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
    let original_digest = {
        let store = McStore::open(&descriptor).unwrap();
        store
            .stage_claim_intent(&binding(7), &identity, &request(1), 10)
            .unwrap()
            .record
            .request_digest
    };

    let store = McStore::open(&descriptor).unwrap();
    let reopened = store.inspect_claim_intent(&identity).unwrap().unwrap();
    assert_eq!(reopened.request_digest, original_digest);
    assert_eq!(reopened.state, ClaimIntentState::Staged);

    let mut other_incarnation = binding(7);
    other_incarnation.database_incarnation_id = "abcdef0123456789abcdef0123456789".to_string();
    assert!(matches!(
        store.stage_claim_intent(&other_incarnation, &identity, &request(1), 11),
        Err(McStoreError::ClaimIntentBindingMismatch {
            field: "database incarnation",
            ..
        })
    ));
    assert!(matches!(
        store.stage_claim_intent(&binding(7), &identity, &request(2), 12),
        Err(McStoreError::ClaimIntentIdentityConflict { .. })
    ));
}

#[test]
fn stale_zero_effect_result_can_settle_after_authority_drain_starts() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let preparing = store
        .authority_begin_prepare(INCARNATION, PROJECT, "memories")
        .unwrap();
    let active = store
        .authority_finish_prepare(
            INCARNATION,
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
        .stage_claim_intent(&active_binding, &identity, &request(1), 1)
        .unwrap();

    let draining = store
        .authority_begin_drain(INCARNATION, PROJECT, "memories", "lease", 100, 2)
        .unwrap();
    let settled = store
        .acknowledge_claim_intent(
            &active_binding,
            &identity,
            &staged.record.request_digest,
            ClaimIntentAckKind::TerminalRejected,
            Some(&result("stale")),
            3,
        )
        .unwrap();
    assert_eq!(settled.record.state, ClaimIntentState::TerminalRejected);
    assert_eq!(store.unresolved_claim_intent_count().unwrap(), 0);

    assert!(matches!(
        store.stage_claim_intent(
            &binding(draining.generation),
            &command("new"),
            &request(2),
            4,
        ),
        Err(McStoreError::ClaimIntentAuthorityFrozen { .. })
    ));
}

#[test]
fn store_rebuild_is_refused_until_intents_drain_then_freezes_new_stages() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let identity = command("pending");
    let staged = store
        .stage_claim_intent(&binding(1), &identity, &request(1), 1)
        .unwrap();

    assert!(matches!(
        store.begin_claim_store_rebuild(INCARNATION, 1, 2),
        Err(McStoreError::ClaimIntentResetBlocked { unresolved: 1 })
    ));
    store
        .acknowledge_claim_intent(
            &binding(1),
            &identity,
            &staged.record.request_digest,
            ClaimIntentAckKind::TerminalRejected,
            Some(&result("stale")),
            3,
        )
        .unwrap();
    store.begin_claim_store_rebuild(INCARNATION, 1, 4).unwrap();
    assert!(matches!(
        store.stage_claim_intent(&binding(1), &command("too-late"), &request(2), 5),
        Err(McStoreError::ClaimIntentAuthorityFrozen { ref state }) if state == "resetting"
    ));
    let mut replacement = binding(1);
    replacement.database_incarnation_id = "abcdef0123456789abcdef0123456789".to_string();
    assert!(matches!(
        store.stage_claim_intent(&replacement, &command("replacement"), &request(3), 6),
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
