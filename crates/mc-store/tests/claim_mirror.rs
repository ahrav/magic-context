use std::collections::BTreeMap;

use cortexkit_store_types::StorageDescriptor;
use mc_core::claim_operation::{
    canonical_json_encode, sha256_hex_utf8, ClaimCommandIdentity, ClaimIntentAckKind,
    ClaimIntentBinding, SnapshotVector,
};
use mc_store::claim_mirror::{
    ClaimMirrorChangeKind, ClaimMirrorEffect, ClaimMirrorError, ClaimMirrorLifecycle,
    ClaimMirrorReceiptGroup, ClaimMirrorSnapshot, CommittedClaimMirrorRow, CLAIM_MIRROR_VERSION,
};
use mc_store::McStore;
use rusqlite::Connection;
use serde_json::{json, Value};

const INCARNATION: &str = "0123456789abcdef0123456789abcdef";
const OTHER_INCARNATION: &str = "abcdef0123456789abcdef0123456789";
const CLAIM_A: &str = "mcm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CLAIM_B: &str = "mcm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn descriptor(dir: &std::path::Path) -> StorageDescriptor {
    McStore::test_descriptor(dir, "magic-context-claim-mirror-test")
}

fn vector(incarnation: &str, generations: &[(i64, i64)]) -> SnapshotVector {
    let values = generations
        .iter()
        .map(|(project, generation)| (project.to_string(), *generation))
        .collect::<BTreeMap<_, _>>();
    SnapshotVector {
        vector_version: 1,
        database_incarnation_id: incarnation.to_string(),
        workspace_epoch: "workspace-epoch-1".to_string(),
        project_generations: values.clone(),
        policy_generations: values,
    }
}

fn claim(
    public_claim_id: &str,
    project_id: i64,
    revision: i64,
    content: &str,
    generation: i64,
) -> CommittedClaimMirrorRow {
    let content_digest = sha256_hex_utf8(content);
    CommittedClaimMirrorRow {
        public_claim_id: public_claim_id.to_string(),
        project_id,
        revision_locator: format!("{public_claim_id}/r{revision}/{content_digest}"),
        content: content.to_string(),
        content_digest,
        attributes: json!({
            "category": "workflow",
            "importance": 80,
            "memoryScope": "project",
            "sharing": "private",
        }),
        lifecycle: ClaimMirrorLifecycle::Active,
        applicability: json!({"streams": [{"key": "global", "state": "applies"}]}),
        policy: json!({
            "autoEligible": true,
            "effectiveMaturity": "verified",
            "explicitEligible": true,
            "hardHidden": false,
            "policyVersion": 1,
        }),
        provenance_label: Some("User-confirmed project guidance".to_string()),
        project_generation: generation,
        policy_generation: generation,
    }
}

fn snapshot(
    incarnation: &str,
    generations: &[(i64, i64)],
    checkpoints: &[(i64, i64)],
    claims: Vec<CommittedClaimMirrorRow>,
) -> ClaimMirrorSnapshot {
    ClaimMirrorSnapshot {
        mirror_version: CLAIM_MIRROR_VERSION,
        vector: vector(incarnation, generations),
        project_checkpoints: checkpoints.iter().copied().collect(),
        claims,
    }
}

fn effect(
    effect_id: i64,
    previous_project_effect_id: i64,
    project_id: i64,
    generation: i64,
    kind: ClaimMirrorChangeKind,
    claim: Option<CommittedClaimMirrorRow>,
    identity: &CommittedClaimMirrorRow,
) -> ClaimMirrorEffect {
    ClaimMirrorEffect {
        effect_id,
        previous_project_effect_id,
        effect_key: format!("claim:{effect_id}"),
        project_id,
        generation,
        change_kind: kind,
        public_claim_id: identity.public_claim_id.clone(),
        revision_locator: identity.revision_locator.clone(),
        claim,
    }
}

fn group(
    receipt_id: i64,
    generations: &[(i64, i64)],
    effects: Vec<ClaimMirrorEffect>,
) -> ClaimMirrorReceiptGroup {
    ClaimMirrorReceiptGroup {
        mirror_version: CLAIM_MIRROR_VERSION,
        receipt_id,
        expected_effect_count: effects.len(),
        vector: vector(INCARNATION, generations),
        effects,
    }
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

fn active_audit_counts(root: &std::path::Path) -> (i64, i64, i64, i64) {
    Connection::open(root.join("store.db"))
        .unwrap()
        .query_row(
            "SELECT
                 (SELECT COUNT(*) FROM mc_scan_batches),
                 (SELECT COUNT(*) FROM mc_field_scans),
                 (SELECT COUNT(*) FROM mc_scan_owner_copies),
                 (SELECT COUNT(*) FROM mc_scan_detections)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
}

#[test]
fn claim_json_fields_are_scanned_once_without_rewriting_escaped_quotes() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let mut row = claim(CLAIM_A, 41, 1, "plain content", 1);
    row.attributes = json!({"quoted": "say \\\"hello\\\"", "nested": {"displayName": "value"}});

    store
        .replace_claim_mirror_snapshot(
            &snapshot(INCARNATION, &[(41, 1)], &[(41, 0)], vec![row.clone()]),
            1,
        )
        .unwrap();

    assert_eq!(
        store.list_claim_mirror(INCARNATION, Some(41)).unwrap()[0].attributes,
        row.attributes
    );
    let connection = Connection::open(dir.path().join("store.db")).unwrap();
    let per_field: Vec<(String, i64)> = connection
        .prepare(
            "SELECT field_id,COUNT(*) FROM mc_scan_owner_copies
             WHERE field_id LIKE 'claim_%' GROUP BY field_id ORDER BY field_id",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        per_field,
        vec![
            ("claim_applicability".to_string(), 1),
            ("claim_attributes".to_string(), 1),
            ("claim_content".to_string(), 1),
            ("claim_policy".to_string(), 1),
        ]
    );
}

#[test]
fn protected_claim_json_key_rejects_atomically_with_exact_error() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    for protected_key in ["apiToken", "encryptionKey", "signingKeys", "clientSecret"] {
        let mut row = claim(CLAIM_A, 41, 1, "plain content", 1);
        row.policy = Value::Object(serde_json::Map::from_iter([(
            protected_key.to_string(),
            Value::String("value with quotes".to_string()),
        )]));
        let error = store
            .replace_claim_mirror_snapshot(
                &snapshot(INCARNATION, &[(41, 1)], &[(41, 0)], vec![row]),
                1,
            )
            .unwrap_err();
        assert!(matches!(
            error,
            ClaimMirrorError::Redaction(mc_core::redaction::RedactionErrorKind::SecretDetected)
        ));
        assert!(store.claim_mirror_state().unwrap().is_none());
        assert_eq!(active_audit_counts(dir.path()), (0, 0, 0, 0));
    }

    let mut benign = claim(CLAIM_A, 41, 1, "plain content", 1);
    benign.policy = json!({"key": "display selector", "keys": ["left", "right"]});
    store
        .replace_claim_mirror_snapshot(
            &snapshot(INCARNATION, &[(41, 1)], &[(41, 0)], vec![benign]),
            2,
        )
        .unwrap();
}

#[test]
fn u10_scenario_1_full_snapshot_roundtrips_committed_claim_vocabulary() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let expected = claim(
        CLAIM_A,
        41,
        3,
        "Use the repository formatter before commit.",
        7,
    );

    store
        .replace_claim_mirror_snapshot(
            &snapshot(INCARNATION, &[(41, 7)], &[(41, 29)], vec![expected.clone()]),
            100,
        )
        .unwrap();

    assert_eq!(
        store.list_claim_mirror(INCARNATION, Some(41)).unwrap(),
        vec![expected]
    );
    let state = store.claim_mirror_state().unwrap().unwrap();
    assert_eq!(state.database_incarnation_id, INCARNATION);
    assert_eq!(state.projects[&41].project_generation, 7);
    assert_eq!(state.projects[&41].policy_generation, 7);
    assert_eq!(state.projects[&41].acked_effect_id, 29);
    assert!(store
        .list_claim_mirror(OTHER_INCARNATION, None)
        .unwrap()
        .is_empty());
}

#[test]
fn u10_scenario_2_complete_receipt_group_is_atomic_and_replay_safe() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let original = claim(CLAIM_A, 41, 1, "Original claim.", 1);
    store
        .replace_claim_mirror_snapshot(
            &snapshot(INCARNATION, &[(41, 1)], &[(41, 0)], vec![original]),
            1,
        )
        .unwrap();

    let updated = claim(CLAIM_A, 41, 2, "Updated claim.", 2);
    let inserted = claim(CLAIM_B, 41, 1, "Second claim.", 2);
    let effects = vec![
        effect(
            1,
            0,
            41,
            2,
            ClaimMirrorChangeKind::Upsert,
            Some(updated.clone()),
            &updated,
        ),
        effect(
            2,
            1,
            41,
            2,
            ClaimMirrorChangeKind::Upsert,
            Some(inserted.clone()),
            &inserted,
        ),
    ];
    let receipt = group(9, &[(41, 2)], effects);
    let applied = store.apply_claim_mirror_receipt(&receipt, 2).unwrap();
    assert!(!applied.replayed);
    assert_eq!(applied.applied_effect_count, 2);
    assert_eq!(
        store.list_claim_mirror(INCARNATION, Some(41)).unwrap(),
        vec![updated, inserted]
    );
    assert_eq!(
        store.claim_mirror_state().unwrap().unwrap().projects[&41].acked_effect_id,
        2
    );

    let replay = store.apply_claim_mirror_receipt(&receipt, 3).unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.applied_effect_count, 0);

    let mut incomplete = group(
        10,
        &[(41, 3)],
        vec![effect(
            3,
            2,
            41,
            3,
            ClaimMirrorChangeKind::Evidence,
            None,
            &claim(CLAIM_A, 41, 2, "Updated claim.", 3),
        )],
    );
    incomplete.expected_effect_count = 2;
    assert!(matches!(
        store.apply_claim_mirror_receipt(&incomplete, 4),
        Err(ClaimMirrorError::Invalid(_))
    ));
    assert_eq!(
        store.claim_mirror_state().unwrap().unwrap().projects[&41].acked_effect_id,
        2
    );
}

#[test]
fn u10_scenario_3_versions_incarnation_generations_and_project_predecessors_are_strict() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let original = claim(CLAIM_A, 41, 1, "Original claim.", 1);
    store
        .replace_claim_mirror_snapshot(
            &snapshot(INCARNATION, &[(41, 1)], &[(41, 4)], vec![original.clone()]),
            1,
        )
        .unwrap();

    let updated = claim(CLAIM_A, 41, 2, "Updated claim.", 2);
    let base_effect = effect(
        7,
        4,
        41,
        2,
        ClaimMirrorChangeKind::Upsert,
        Some(updated.clone()),
        &updated,
    );

    let mut wrong_version = group(1, &[(41, 2)], vec![base_effect.clone()]);
    wrong_version.mirror_version = 2;
    assert!(matches!(
        store.apply_claim_mirror_receipt(&wrong_version, 2),
        Err(ClaimMirrorError::Invalid(_))
    ));

    let mut wrong_incarnation = group(1, &[(41, 2)], vec![base_effect.clone()]);
    wrong_incarnation.vector.database_incarnation_id = OTHER_INCARNATION.to_string();
    assert!(matches!(
        store.apply_claim_mirror_receipt(&wrong_incarnation, 2),
        Err(ClaimMirrorError::IncarnationMismatch { .. })
    ));

    let jumped = claim(CLAIM_A, 41, 2, "Updated claim.", 3);
    let wrong_generation = group(
        1,
        &[(41, 3)],
        vec![effect(
            7,
            4,
            41,
            3,
            ClaimMirrorChangeKind::Upsert,
            Some(jumped.clone()),
            &jumped,
        )],
    );
    assert!(matches!(
        store.apply_claim_mirror_receipt(&wrong_generation, 2),
        Err(ClaimMirrorError::GenerationMismatch {
            project_id: 41,
            expected: 2,
            found: 3,
        })
    ));

    let mut skipped = base_effect;
    skipped.previous_project_effect_id = 6;
    assert!(matches!(
        store.apply_claim_mirror_receipt(&group(1, &[(41, 2)], vec![skipped]), 2),
        Err(ClaimMirrorError::CheckpointMismatch {
            project_id: 41,
            expected: 4,
            found: 6,
        })
    ));

    assert_eq!(
        store.list_claim_mirror(INCARNATION, None).unwrap(),
        vec![original.clone()]
    );
    let project = &store.claim_mirror_state().unwrap().unwrap().projects[&41];
    assert_eq!(project.project_generation, 1);
    assert_eq!(project.acked_effect_id, 4);

    store
        .begin_claim_store_rebuild(OTHER_INCARNATION, 1, 3)
        .unwrap();
    assert!(matches!(
        store.replace_claim_mirror_snapshot(
            &snapshot(INCARNATION, &[(41, 1)], &[(41, 4)], vec![original]),
            4,
        ),
        Err(ClaimMirrorError::IncarnationMismatch { .. })
    ));
}

#[test]
fn u10_scenario_4_policy_only_revocation_removes_committed_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let visible = claim(CLAIM_A, 41, 1, "Visible until policy changes.", 1);
    store
        .replace_claim_mirror_snapshot(
            &snapshot(INCARNATION, &[(41, 1)], &[(41, 0)], vec![visible.clone()]),
            1,
        )
        .unwrap();

    let revoke = effect(
        1,
        0,
        41,
        2,
        ClaimMirrorChangeKind::Verification,
        None,
        &visible,
    );
    store
        .apply_claim_mirror_receipt(&group(1, &[(41, 2)], vec![revoke]), 2)
        .unwrap();

    assert!(store
        .list_claim_mirror(INCARNATION, Some(41))
        .unwrap()
        .is_empty());
    let project = &store.claim_mirror_state().unwrap().unwrap().projects[&41];
    assert_eq!(project.project_generation, 2);
    assert_eq!(project.acked_effect_id, 1);
}

#[test]
fn u10_scenario_7_delete_and_reseed_require_drained_u5_intents() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let original = claim(CLAIM_A, 41, 1, "Drain before reset.", 1);
    let original_snapshot = snapshot(INCARNATION, &[(41, 1)], &[(41, 0)], vec![original.clone()]);
    store
        .replace_claim_mirror_snapshot(&original_snapshot, 1)
        .unwrap();

    let route_root = "/repo/claim-mirror-test";
    let store_uuid = "6f1d0c4a-6f2b-4b7a-9c3d-2e5f8a1b4c7d";
    let authority_project = "git:claim-mirror-test";
    // Staging resolves the memories authority through the bound route.
    store
        .bind_authority_route(store_uuid, authority_project, route_root)
        .unwrap();
    let preparing = store
        .authority_begin_prepare(store_uuid, authority_project, "memories")
        .unwrap();
    let authority_generation = store
        .authority_finish_prepare(
            store_uuid,
            authority_project,
            "memories",
            preparing.generation,
            "same",
            "same",
            true,
        )
        .unwrap()
        .generation;

    let binding = ClaimIntentBinding {
        database_incarnation_id: INCARNATION.to_string(),
        format_epoch: 1,
        authority_project: authority_project.to_string(),
        authority_generation,
    };
    let command = ClaimCommandIdentity {
        producer: "mc-module".to_string(),
        operation_key: "pending-reset".to_string(),
    };
    let staged = store
        .stage_claim_intent(
            route_root,
            &binding,
            &command,
            &json!({"operation": "update"}),
            2,
        )
        .unwrap();

    assert!(matches!(
        store.delete_claim_mirror(),
        Err(ClaimMirrorError::ResetBlocked { unresolved: 1 })
    ));
    assert_eq!(
        store.list_claim_mirror(INCARNATION, None).unwrap(),
        vec![original]
    );

    store
        .acknowledge_claim_intent(
            &binding,
            &command,
            &staged.record.request_digest,
            ClaimIntentAckKind::TerminalRejected,
            Some(&result("stale")),
            3,
        )
        .unwrap();
    assert!(matches!(
        store.delete_claim_mirror(),
        Err(ClaimMirrorError::ResetRequired)
    ));

    store.begin_claim_store_rebuild(INCARNATION, 1, 4).unwrap();
    store.delete_claim_mirror().unwrap();
    assert!(store.claim_mirror_state().unwrap().is_none());
    assert!(store.inspect_claim_intent(&command).unwrap().is_some());
}

#[test]
fn u10_scenario_7_equivalent_restart_seed_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let source = snapshot(
        INCARNATION,
        &[(41, 1)],
        &[(41, 9)],
        vec![claim(CLAIM_A, 41, 1, "Restart-safe claim.", 1)],
    );
    store.replace_claim_mirror_snapshot(&source, 1).unwrap();
    store.replace_claim_mirror_snapshot(&source, 2).unwrap();

    let mut changed = source.clone();
    changed.project_checkpoints.insert(41, 10);
    assert!(matches!(
        store.replace_claim_mirror_snapshot(&changed, 3),
        Err(ClaimMirrorError::ResetRequired)
    ));
}

#[test]
fn u10_scenario_8_reseed_reproduces_state_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());
    let expected = claim(CLAIM_A, 41, 3, "Rebuildable committed claim.", 7);
    let source = snapshot(
        INCARNATION,
        &[(41, 7), (42, 2)],
        &[(41, 29), (42, 11)],
        vec![expected.clone()],
    );
    {
        let store = McStore::open(&descriptor).unwrap();
        store.replace_claim_mirror_snapshot(&source, 1).unwrap();
        let before_rows = store.list_claim_mirror(INCARNATION, None).unwrap();
        let before_state = store.claim_mirror_state().unwrap().unwrap();

        store.begin_claim_store_rebuild(INCARNATION, 7, 2).unwrap();
        store.delete_claim_mirror().unwrap();
        store.replace_claim_mirror_snapshot(&source, 3).unwrap();

        assert_eq!(
            store.list_claim_mirror(INCARNATION, None).unwrap(),
            before_rows
        );
        assert_eq!(store.claim_mirror_state().unwrap().unwrap(), before_state);
    }

    let reopened = McStore::open(&descriptor).unwrap();
    assert_eq!(
        reopened.list_claim_mirror(INCARNATION, None).unwrap(),
        vec![expected]
    );
    let state = reopened.claim_mirror_state().unwrap().unwrap();
    assert_eq!(state.projects[&41].acked_effect_id, 29);
    assert_eq!(state.projects[&42].acked_effect_id, 11);
}

///
#[test]
fn receipt_advances_generation_stamps_on_untouched_rows_so_restart_seed_matches() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let touched = claim(CLAIM_A, 41, 1, "Original claim.", 1);
    let untouched = claim(CLAIM_B, 41, 1, "Untouched claim.", 1);
    store
        .replace_claim_mirror_snapshot(
            &snapshot(
                INCARNATION,
                &[(41, 1)],
                &[(41, 0)],
                vec![touched, untouched.clone()],
            ),
            1,
        )
        .unwrap();

    let revised = claim(CLAIM_A, 41, 2, "Revised claim.", 2);
    let receipt = group(
        9,
        &[(41, 2)],
        vec![effect(
            1,
            0,
            41,
            2,
            ClaimMirrorChangeKind::Upsert,
            Some(revised.clone()),
            &revised,
        )],
    );
    store.apply_claim_mirror_receipt(&receipt, 2).unwrap();

    let stored = store.list_claim_mirror(INCARNATION, Some(41)).unwrap();
    let stored_untouched = stored
        .iter()
        .find(|row| row.public_claim_id == CLAIM_B)
        .expect("untouched claim stays mirrored");
    assert_eq!(stored_untouched.project_generation, 2);
    assert_eq!(stored_untouched.policy_generation, 2);

    // An equivalent snapshot replacement succeeds without a reset.
    let reseed = snapshot(
        INCARNATION,
        &[(41, 2)],
        &[(41, 1)],
        vec![revised, claim(CLAIM_B, 41, 1, "Untouched claim.", 2)],
    );
    store.replace_claim_mirror_snapshot(&reseed, 3).unwrap();
    assert_eq!(
        store.claim_mirror_state().unwrap().unwrap().projects[&41].project_generation,
        2
    );
}

///
#[test]
fn receipt_rejects_equal_revision_carrying_different_content() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let stored = claim(CLAIM_A, 41, 2, "Stored content.", 1);
    store
        .replace_claim_mirror_snapshot(
            &snapshot(INCARNATION, &[(41, 1)], &[(41, 0)], vec![stored.clone()]),
            1,
        )
        .unwrap();

    let forged = claim(CLAIM_A, 41, 2, "Different content, same revision.", 2);
    let receipt = group(
        9,
        &[(41, 2)],
        vec![effect(
            1,
            0,
            41,
            2,
            ClaimMirrorChangeKind::Upsert,
            Some(forged.clone()),
            &forged,
        )],
    );
    assert!(matches!(
        store.apply_claim_mirror_receipt(&receipt, 2),
        Err(ClaimMirrorError::Invalid(_))
    ));
    assert_eq!(
        store.list_claim_mirror(INCARNATION, Some(41)).unwrap(),
        vec![stored]
    );
}
