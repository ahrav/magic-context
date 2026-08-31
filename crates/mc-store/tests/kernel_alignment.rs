#![cfg(feature = "test-support")]

use mc_store::kernel::{
    AlignmentProjectionSpec, ArtifactDeletionFault, ArtifactDeletionIdentity, ArtifactDeletionKind,
    ArtifactDeletionRequest, ArtifactErrorKind, ArtifactIngestRequest, CommitIntent,
    DecisionEventPayload, DecisionEventSpec, DecisionPayload, DecisionSpec, DomainSpec,
    KernelErrorKind, KernelStore, ObservationDependencySpec, ObservationPayload, ObservationSpec,
    ProviderEgress, RepositoryProvenance, Sensitivity,
};
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

fn intent(key: &str) -> CommitIntent {
    CommitIntent {
        producer: "kernel-alignment-test".to_string(),
        operation_key: key.to_string(),
        request_digest: format!("{:x}", Sha256::digest(key.as_bytes())),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn decision(index: i64, evidence_id: Option<&str>) -> DecisionSpec {
    DecisionSpec {
        decision_id: format!("decision-{index}"),
        object_id: format!("decision-object-{index}"),
        domain_id: "domain".to_string(),
        proposition_id: None,
        scope_id: None,
        anchor_id: None,
        evidence_id: evidence_id.map(str::to_string),
        decision_kind: "architecture".to_string(),
        payload: DecisionPayload {
            summary: format!("decision {index}"),
            rationale: format!("reason {index}"),
        },
        source_kind: "fixture".to_string(),
        source_id: "decision-lineage".to_string(),
        source_revision: index,
        sensitivity: Sensitivity::Normal,
    }
}

fn observation(index: i64, dependency_object_id: &str) -> ObservationSpec {
    ObservationSpec {
        observation_id: format!("observation-{index}"),
        object_id: format!("observation-object-{index}"),
        domain_id: "domain".to_string(),
        proposition_id: None,
        scope_id: None,
        anchor_id: None,
        evidence_id: None,
        observation_kind: "implementation".to_string(),
        payload: ObservationPayload {
            summary: format!("observed {index}"),
            classification: "implemented".to_string(),
            detail: None,
        },
        observed_at: index,
        dependencies: vec![ObservationDependencySpec {
            dependency_object_id: dependency_object_id.to_string(),
            dependency_kind: "implements".to_string(),
            dependency_payload: None,
        }],
        source_kind: "fixture".to_string(),
        source_id: "observation-lineage".to_string(),
        source_revision: index,
        sensitivity: Sensitivity::Normal,
    }
}

fn open_store() -> (tempfile::TempDir, KernelStore) {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    (root, store)
}

fn seed_domain(store: &KernelStore) {
    store
        .commit(intent("domain"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "domain".to_string(),
                object_id: "domain-object".to_string(),
                name: "fixture".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "domain".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
}

fn seed_pair(store: &KernelStore, evidence_id: Option<&str>) {
    store
        .commit(intent("pair"), |envelope| {
            envelope.insert_decision(decision(1, evidence_id))?;
            envelope.insert_observation(observation(1, "decision-object-1"))?;
            Ok(String::new())
        })
        .unwrap();
}

fn projection_rows(root: &std::path::Path) -> Vec<(String, String, String, String, i64)> {
    let connection =
        Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let rows = connection
        .prepare(
            "SELECT decision_id,observation_id,alignment_kind,alignment_payload,
                    built_through_commit_seq
             FROM alignment_projection ORDER BY decision_id,observation_id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    rows
}

fn projection_redactions(root: &std::path::Path) -> Vec<(String, String, String, i64)> {
    let connection =
        Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let rows = connection
        .prepare(
            "SELECT owner_id,field_name,secret_type,detection_ordinal
             FROM durable_text_redactions
             WHERE owner_kind='alignment_projection'
             ORDER BY owner_id,field_name,detection_ordinal",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    rows
}

#[test]
fn rebuild_is_deterministic_and_historical_derivation_is_stable() {
    let (root, store) = open_store();
    assert!(!store.rebuild_alignment().unwrap().published);
    seed_domain(&store);
    seed_pair(&store, None);

    let historical = store.alignment_as_of(2).unwrap();
    assert_eq!(historical.rows.len(), 1);
    assert_eq!(historical.rows[0].decision_id, "decision-1");
    assert_eq!(historical.rows[0].alignment_kind, "implemented");
    assert_eq!(
        historical.rows[0].alignment_payload,
        r#"{"decision_id":"decision-1","observation_id":"observation-1","alignment_kind":"implemented"}"#
    );

    let first = store.rebuild_alignment().unwrap();
    let first_rows = projection_rows(root.path());
    let first_redactions = projection_redactions(root.path());
    let second = store.rebuild_alignment().unwrap();
    assert_eq!(first, second);
    assert_eq!(first_rows, projection_rows(root.path()));
    assert_eq!(first_redactions, projection_redactions(root.path()));

    store
        .commit(intent("correct"), |envelope| {
            envelope.correct_decision("decision-object-1", decision(2, None))?;
            Ok(String::new())
        })
        .unwrap();
    let reproduced = store.alignment_as_of(2).unwrap();
    assert_eq!(reproduced.known_as_of, historical.known_as_of);
    assert_eq!(reproduced.rows, historical.rows);
    assert_eq!(reproduced.tip, 3);
    let current = store.alignment_as_of(3).unwrap();
    assert_eq!(current.rows[0].decision_id, "decision-2");

    let old_slice = store.slice_as_of(2).unwrap();
    assert_eq!(
        old_slice
            .decisions
            .iter()
            .map(|row| row.decision_id.as_str())
            .collect::<Vec<_>>(),
        ["decision-1"]
    );
    assert_eq!(old_slice.decisions[0].invalidated_commit_seq, None);
    assert_eq!(old_slice.decisions[0].superseded_by, None);
    let current_slice = store.slice_as_of(3).unwrap();
    assert_eq!(current_slice.decisions[0].decision_id, "decision-2");
}

#[test]
fn corrected_dependency_chains_follow_successors_and_retirement_clears_projection() {
    let (root, store) = open_store();
    seed_domain(&store);
    seed_pair(&store, None);

    store
        .commit(intent("correct"), |envelope| {
            envelope.correct_decision("decision-object-1", decision(2, None))?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(projection_rows(root.path())[0].0, "decision-2".to_string());

    store
        .replace_alignment_projection(&[AlignmentProjectionSpec {
            decision_id: "decision-2".to_string(),
            observation_id: "observation-1".to_string(),
            alignment_kind: "stale".to_string(),
            alignment_payload: None,
            built_through_commit_seq: 3,
        }])
        .unwrap();
    store
        .commit(intent("retire"), |envelope| {
            envelope.retire_decision("decision-object-2")?;
            Ok(String::new())
        })
        .unwrap();
    assert!(projection_rows(root.path()).is_empty());
    assert!(store.alignment_as_of(4).unwrap().rows.is_empty());
}

#[test]
fn slice_receipt_replay_repairs_projection_without_reentering_writer_lock() {
    let (root, store) = open_store();
    seed_domain(&store);
    seed_pair(&store, None);
    let expected = projection_rows(root.path());
    store
        .replace_alignment_projection(&[AlignmentProjectionSpec {
            decision_id: "decision-1".to_string(),
            observation_id: "observation-1".to_string(),
            alignment_kind: "stale".to_string(),
            alignment_payload: None,
            built_through_commit_seq: 2,
        }])
        .unwrap();

    let replay = store
        .commit(intent("pair"), |_| {
            panic!("receipt replay must skip operation")
        })
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(projection_rows(root.path()), expected);
}

#[test]
fn deletion_replay_repairs_projection() {
    let (root, store) = open_store();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(ArtifactIngestRequest {
            intent: intent("evidence"),
            payload: b"evidence".to_vec(),
            evidence_id: "evidence".to_string(),
            object_id: "evidence-object".to_string(),
            object_kind: "evidence".to_string(),
            domain_id: "domain".to_string(),
            source_kind: "repository".to_string(),
            source_id: "source".to_string(),
            source_revision: 1,
            media_type: "text/plain".to_string(),
            retention_class: "canonical".to_string(),
            retain_until: None,
            asserted_sensitivity: Sensitivity::Normal,
            provider_egress: ProviderEgress::RemoteAllowed,
            provenance: Some(RepositoryProvenance {
                repository_id: "repo".to_string(),
                revision: "abc123".to_string(),
            }),
        })
        .unwrap();
    seed_pair(&store, Some("evidence"));
    let request = ArtifactDeletionRequest {
        intent: intent("delete-evidence"),
        identity: ArtifactDeletionIdentity::Digest(handle.digest),
        kind: ArtifactDeletionKind::Delete,
        operator_id: None,
        target_locator: None,
        reason: None,
        deleted_at: 42,
    };
    let before_deletion = store.alignment_as_of(3).unwrap();
    assert_eq!(before_deletion.rows.len(), 1);
    store.delete_artifact(request.clone()).unwrap();
    let expected = projection_rows(root.path());
    assert!(expected.is_empty());
    assert_eq!(store.alignment_as_of(3).unwrap().rows, before_deletion.rows);
    assert!(store.alignment_as_of(4).unwrap().rows.is_empty());
    let current_slice = store.slice_as_of(4).unwrap();
    assert_eq!(current_slice.decisions[0].decision_id, "decision-1");
    assert_eq!(
        current_slice.decisions[0].evidence_id.as_deref(),
        Some("evidence")
    );
    store.replace_alignment_projection(&[]).unwrap();
    assert!(projection_rows(root.path()).is_empty());

    let replay = store.delete_artifact(request).unwrap();
    assert!(replay.already_applied);
    assert_eq!(projection_rows(root.path()), expected);
}

#[test]
fn deleted_predecessor_evidence_still_resolves_eligible_successor() {
    let (_root, store) = open_store();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(ArtifactIngestRequest {
            intent: intent("evidence"),
            payload: b"evidence".to_vec(),
            evidence_id: "evidence".to_string(),
            object_id: "evidence-object".to_string(),
            object_kind: "evidence".to_string(),
            domain_id: "domain".to_string(),
            source_kind: "repository".to_string(),
            source_id: "source".to_string(),
            source_revision: 1,
            media_type: "text/plain".to_string(),
            retention_class: "canonical".to_string(),
            retain_until: None,
            asserted_sensitivity: Sensitivity::Normal,
            provider_egress: ProviderEgress::RemoteAllowed,
            provenance: Some(RepositoryProvenance {
                repository_id: "repo".to_string(),
                revision: "abc123".to_string(),
            }),
        })
        .unwrap();
    seed_pair(&store, Some("evidence"));
    store
        .commit(intent("correct"), |envelope| {
            envelope.correct_decision("decision-object-1", decision(2, None))?;
            Ok(String::new())
        })
        .unwrap();
    store
        .delete_artifact(ArtifactDeletionRequest {
            intent: intent("delete-evidence"),
            identity: ArtifactDeletionIdentity::Digest(handle.digest),
            kind: ArtifactDeletionKind::Delete,
            operator_id: None,
            target_locator: None,
            reason: None,
            deleted_at: 42,
        })
        .unwrap();

    let current = store.alignment_as_of(5).unwrap();
    assert_eq!(current.rows.len(), 1);
    assert_eq!(current.rows[0].decision_id, "decision-2");
}

#[test]
fn purge_replay_rebuild_failure_preserves_pending_artifact() {
    let (root, store) = open_store();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(ArtifactIngestRequest {
            intent: intent("evidence"),
            payload: b"evidence".to_vec(),
            evidence_id: "evidence".to_string(),
            object_id: "evidence-object".to_string(),
            object_kind: "evidence".to_string(),
            domain_id: "domain".to_string(),
            source_kind: "repository".to_string(),
            source_id: "source".to_string(),
            source_revision: 1,
            media_type: "text/plain".to_string(),
            retention_class: "canonical".to_string(),
            retain_until: None,
            asserted_sensitivity: Sensitivity::Normal,
            provider_egress: ProviderEgress::RemoteAllowed,
            provenance: Some(RepositoryProvenance {
                repository_id: "repo".to_string(),
                revision: "abc123".to_string(),
            }),
        })
        .unwrap();
    seed_pair(&store, None);
    let request = ArtifactDeletionRequest {
        intent: intent("purge-evidence"),
        identity: ArtifactDeletionIdentity::Digest(handle.digest.clone()),
        kind: ArtifactDeletionKind::Purge,
        operator_id: Some("operator".to_string()),
        target_locator: Some("fixture".to_string()),
        reason: Some("proof".to_string()),
        deleted_at: 42,
    };
    let error = store
        .delete_artifact_with_fault_for_test(request.clone(), ArtifactDeletionFault::AfterCommit)
        .unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::PurgeUnlinkPending);

    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE observations SET observation_payload=X'00'
             WHERE observation_id='observation-1'",
            [],
        )
        .unwrap();
    drop(connection);

    let error = store.delete_artifact(request).unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::ReferenceCommit);
    let object_path = root
        .path()
        .join("artifacts/objects")
        .join(&handle.digest[..2])
        .join(&handle.digest[2..]);
    assert!(object_path.exists());
    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    let pending: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM artifact_pending_unlinks
             WHERE artifact_digest=?1",
            [&handle.digest],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pending, 1);
}

#[test]
fn projection_failure_rolls_back_the_canonical_mutation_and_receipt() {
    let (root, store) = open_store();
    seed_domain(&store);
    seed_pair(&store, None);
    drop(store);

    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE observations SET observation_payload=X'00'
             WHERE observation_id='observation-1'",
            [],
        )
        .unwrap();
    drop(connection);

    let store = KernelStore::open(root.path()).unwrap();
    let error = store
        .commit(intent("must-roll-back"), |envelope| {
            envelope.append_decision_event(
                "decision-1",
                DecisionEventSpec {
                    event_kind: "status".to_string(),
                    payload: DecisionEventPayload {
                        summary: "must not persist".to_string(),
                    },
                    evidence_id: None,
                    recorded_at: 10,
                },
            )?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error.kind(), KernelErrorKind::Io);

    store
        .commit(intent("unrelated-domain"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "unrelated".to_string(),
                object_id: "unrelated-domain-object".to_string(),
                name: "unrelated".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "unrelated-domain".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();

    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    for (table, expected) in [
        ("commit_log", 3),
        ("operation_receipts", 3),
        ("decision_events", 0),
        ("domains", 2),
    ] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, expected, "{table}");
    }
}
