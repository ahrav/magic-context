#![cfg(feature = "test-support")]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::{mpsc, Arc};

use mc_store::kernel::{
    ArtifactDeletionFault, ArtifactDeletionIdentity, ArtifactDeletionKind, ArtifactDeletionRequest,
    ArtifactDestination, ArtifactEligibility, ArtifactErrorKind, ArtifactIngestRequest,
    CommitIntent, ConsumerAbandonment, DomainSpec, EligibilityDeniedReason, KernelStore,
    ProviderEgress, RepositoryProvenance, Sensitivity,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

fn intent(key: &str) -> CommitIntent {
    CommitIntent {
        producer: "kernel-deletion-test".to_string(),
        operation_key: key.to_string(),
        request_digest: format!("{:x}", Sha256::digest(key.as_bytes())),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
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
            Ok("domain".to_string())
        })
        .unwrap();
}

fn ingest(store: &KernelStore, key: &str, payload: &[u8]) -> mc_store::kernel::ArtifactHandle {
    store.ingest_artifact(ingest_request(key, payload)).unwrap()
}

fn ingest_request(key: &str, payload: &[u8]) -> ArtifactIngestRequest {
    ArtifactIngestRequest {
        intent: intent(key),
        payload: payload.to_vec(),
        evidence_id: format!("evidence-{key}"),
        object_id: format!("object-{key}"),
        object_kind: "evidence".to_string(),
        domain_id: "domain".to_string(),
        source_kind: "repository".to_string(),
        source_id: format!("src/{key}"),
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
    }
}

fn delete_request(key: &str, digest: &str, kind: ArtifactDeletionKind) -> ArtifactDeletionRequest {
    ArtifactDeletionRequest {
        intent: intent(&format!("deletion-{key}")),
        identity: ArtifactDeletionIdentity::Digest(digest.to_string()),
        kind,
        operator_id: (kind == ArtifactDeletionKind::Purge).then(|| "operator-1".to_string()),
        target_locator: (kind == ArtifactDeletionKind::Purge)
            .then(|| "incident://secret-1".to_string()),
        reason: (kind == ArtifactDeletionKind::Purge).then(|| "secret".to_string()),
        deleted_at: 42,
    }
}

fn inspect(root: &std::path::Path) -> Connection {
    Connection::open(root.join("core.sqlite")).unwrap()
}

fn object_path(root: &std::path::Path, digest: &str) -> std::path::PathBuf {
    root.join("artifacts/objects")
        .join(&digest[..2])
        .join(&digest[2..])
}

fn tree_entries(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut entries = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path.clone());
            }
            entries.push(path.strip_prefix(root).unwrap().to_path_buf());
        }
    }
    entries.sort();
    entries
}

#[test]
fn deletion_invalidates_every_reference_in_one_commit_and_emits_complete_target_work() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = b"shared";
    let handles = [
        ingest(&store, "one", payload),
        ingest(&store, "two", payload),
        ingest(&store, "three", payload),
    ];
    store
        .commit(intent("register-consumers"), |envelope| {
            envelope.register_outbox_consumer("search", 1)?;
            envelope.register_outbox_consumer("vectors", 1)?;
            Ok("registered".to_string())
        })
        .unwrap();

    let result = store
        .delete_artifact(delete_request(
            "delete",
            &handles[0].digest,
            ArtifactDeletionKind::Delete,
        ))
        .unwrap();
    assert_eq!(result.affected_object_ids.len(), 3);
    assert!(object_path(root.path(), &handles[0].digest).exists());

    let connection = inspect(root.path());
    let invalidations: Vec<(String, i64, i64)> = connection
        .prepare(
            "SELECT e.object_id,e.invalidated_commit_seq,o.invalidated_commit_seq
             FROM evidence_meta e JOIN object_registry o USING(object_id)
             WHERE e.artifact_digest=?1 ORDER BY e.object_id",
        )
        .unwrap()
        .query_map([&handles[0].digest], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(invalidations
        .iter()
        .all(
            |(_, evidence_seq, object_seq)| *evidence_seq == result.commit_seq
                && *object_seq == result.commit_seq
        ));

    let mut statement = connection
        .prepare("SELECT payload FROM outbox WHERE commit_seq=?1 ORDER BY ordinal")
        .unwrap();
    let payloads: Vec<serde_json::Value> = statement
        .query_map([result.commit_seq], |row| row.get::<_, Vec<u8>>(0))
        .unwrap()
        .map(|row| serde_json::from_slice(&row.unwrap()).unwrap())
        .collect();
    assert_eq!(payloads.len(), 4);
    let mut targets = payloads
        .iter()
        .map(|payload| payload["audit"]["target_class"].as_str().unwrap())
        .collect::<Vec<_>>();
    targets.sort_unstable();
    assert_eq!(
        targets,
        [
            "admission_state",
            "derived_support",
            "embeddings",
            "retrieval_documents"
        ]
    );
    for payload in payloads {
        let audit = &payload["audit"];
        assert_eq!(audit["deletion_kind"], "delete");
        assert_eq!(audit["digest"], handles[0].digest);
        assert_eq!(audit["deletion_commit_seq"], result.commit_seq);
        assert_eq!(audit["barrier_id"], result.barrier_id);
        assert_eq!(audit["sensitivity"], "normal");
        assert_eq!(audit["affected_object_ids"].as_array().unwrap().len(), 3);
    }
}

#[test]
fn barrier_uses_recorded_consumers_and_requires_explicit_empty_set_abandonment() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = ingest(&store, "barrier", b"barrier");
    store
        .commit(intent("register-search"), |envelope| {
            envelope.register_outbox_consumer("search", 1)?;
            Ok("registered".to_string())
        })
        .unwrap();
    let deletion = store
        .delete_artifact(delete_request(
            "delete-barrier",
            &handle.digest,
            ArtifactDeletionKind::Delete,
        ))
        .unwrap();
    assert!(
        !store
            .deletion_barrier(&deletion.barrier_id)
            .unwrap()
            .cleared
    );
    store
        .commit(intent("register-later"), |envelope| {
            envelope.register_outbox_consumer("later", 2)?;
            Ok("registered".to_string())
        })
        .unwrap();
    store
        .acknowledge_outbox("search", deletion.commit_seq, 3)
        .unwrap();
    let status = store.deletion_barrier(&deletion.barrier_id).unwrap();
    assert!(status.cleared);
    assert_eq!(status.consumers.len(), 1);

    let second = ingest(&store, "empty", b"empty");
    store
        .commit(intent("abandon-search"), |envelope| {
            envelope.abandon_outbox_consumer(
                "search",
                ConsumerAbandonment {
                    operator_id: "operator-2".to_string(),
                    reason: "retired".to_string(),
                    abandoned_at: 10,
                    barrier_id: None,
                },
            )?;
            envelope.abandon_outbox_consumer(
                "later",
                ConsumerAbandonment {
                    operator_id: "operator-2".to_string(),
                    reason: "retired".to_string(),
                    abandoned_at: 10,
                    barrier_id: None,
                },
            )?;
            Ok("abandoned".to_string())
        })
        .unwrap();
    let empty = store
        .delete_artifact(delete_request(
            "delete-empty",
            &second.digest,
            ArtifactDeletionKind::Delete,
        ))
        .unwrap();
    assert!(!store.deletion_barrier(&empty.barrier_id).unwrap().cleared);
    store
        .commit(intent("abandon-empty"), |envelope| {
            envelope.abandon_deletion_barrier(
                &empty.barrier_id,
                "operator-3",
                "no consumers",
                11,
            )?;
            Ok("abandoned".to_string())
        })
        .unwrap();
    assert!(store.deletion_barrier(&empty.barrier_id).unwrap().cleared);
}

#[test]
fn barrier_specific_consumer_abandonment_records_operator_barrier_and_time() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = ingest(&store, "abandon", b"abandon");
    store
        .commit(intent("register-abandon"), |envelope| {
            envelope.register_outbox_consumer("search", 1)?;
            envelope.register_outbox_consumer("vectors", 1)?;
            Ok("registered".to_string())
        })
        .unwrap();
    let deletion = store
        .delete_artifact(delete_request(
            "delete-abandon",
            &handle.digest,
            ArtifactDeletionKind::Delete,
        ))
        .unwrap();
    store
        .acknowledge_outbox("search", deletion.commit_seq, 7)
        .unwrap();
    store
        .commit(intent("abandon-vectors"), |envelope| {
            envelope.abandon_outbox_consumer(
                "vectors",
                ConsumerAbandonment {
                    operator_id: "operator-9".to_string(),
                    reason: "retired".to_string(),
                    abandoned_at: 8,
                    barrier_id: Some(deletion.barrier_id.clone()),
                },
            )?;
            Ok("abandoned".to_string())
        })
        .unwrap();
    let status = store.deletion_barrier(&deletion.barrier_id).unwrap();
    assert!(status.cleared);
    let vectors = status
        .consumers
        .iter()
        .find(|consumer| consumer.consumer_id == "vectors")
        .unwrap();
    assert_eq!(vectors.abandoned_by.as_deref(), Some("operator-9"));
    assert_eq!(vectors.abandoned_at, Some(8));
    let facts: (String, String, i64) = inspect(root.path())
        .query_row(
            "SELECT barrier_id,operator_id,abandoned_at FROM consumer_abandonments
             WHERE consumer_id='vectors'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(facts, (deletion.barrier_id, "operator-9".to_string(), 8));
}

#[test]
fn evidence_identity_delete_and_reissue_are_no_effects() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = ingest(&store, "identity", b"identity");
    let mut request = delete_request(
        "delete-identity",
        &handle.digest,
        ArtifactDeletionKind::Delete,
    );
    request.identity = ArtifactDeletionIdentity::EvidenceId(handle.evidence_id.clone());
    let first = store.delete_artifact(request).unwrap();
    let commits_before: i64 = inspect(root.path())
        .query_row("SELECT COUNT(*) FROM commit_log", [], |row| row.get(0))
        .unwrap();
    let second = store
        .delete_artifact(delete_request(
            "delete-identity-reissue",
            &handle.digest,
            ArtifactDeletionKind::Delete,
        ))
        .unwrap();
    assert!(second.already_applied);
    assert_eq!(second.commit_seq, first.commit_seq);
    assert_eq!(
        inspect(root.path())
            .query_row("SELECT COUNT(*) FROM commit_log", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        commits_before
    );
}

#[test]
fn purge_tombstones_unlinks_degrades_pins_and_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = ingest(&store, "purge", b"purge me");
    let connection = inspect(root.path());
    let commit_seq: i64 = connection
        .query_row("SELECT MAX(commit_seq) FROM commit_log", [], |row| {
            row.get(0)
        })
        .unwrap();
    connection
        .execute(
            "INSERT INTO capture_pins(capture_pin_id,pin_kind,owner_id,commit_seq,lease_epoch,writer_epoch,created_at)
             VALUES ('pin','backup','owner',?1,1,1,1)",
            [commit_seq],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO capture_pin_refs(capture_pin_id,evidence_id) VALUES ('pin',?1)",
            [&handle.evidence_id],
        )
        .unwrap();
    drop(connection);

    let result = store
        .delete_artifact(delete_request(
            "purge",
            &handle.digest,
            ArtifactDeletionKind::Purge,
        ))
        .unwrap();
    assert!(!object_path(root.path(), &handle.digest).exists());
    assert_eq!(
        store
            .artifact_eligibility(&handle, ArtifactDestination::Local)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::Tombstoned)
    );
    assert_eq!(
        store
            .ingest_artifact(ArtifactIngestRequest {
                intent: intent("purge-readmit"),
                payload: b"purge me".to_vec(),
                evidence_id: "readmit".to_string(),
                object_id: "readmit-object".to_string(),
                object_kind: "evidence".to_string(),
                domain_id: "domain".to_string(),
                source_kind: "repository".to_string(),
                source_id: "readmit".to_string(),
                source_revision: 1,
                media_type: "text/plain".to_string(),
                retention_class: "canonical".to_string(),
                retain_until: None,
                asserted_sensitivity: Sensitivity::Normal,
                provider_egress: ProviderEgress::RemoteAllowed,
                provenance: None,
            })
            .unwrap_err()
            .kind(),
        ArtifactErrorKind::ReAdmissionBlocked
    );
    let connection = inspect(root.path());
    let facts: (i64, i64, String, String, i64) = connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM artifact_purge_tombstones WHERE artifact_digest=?1),
                (SELECT COUNT(*) FROM artifact_pending_unlinks WHERE artifact_digest=?1),
                (SELECT operator_id FROM artifact_purge_tombstones WHERE artifact_digest=?1),
                (SELECT reason FROM artifact_purge_tombstones WHERE artifact_digest=?1),
                (SELECT purge_degraded_at FROM capture_pins WHERE capture_pin_id='pin')",
            [&handle.digest],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        facts,
        (1, 0, "operator-1".to_string(), "secret".to_string(), 42)
    );
    let commits_before: i64 = connection
        .query_row("SELECT COUNT(*) FROM commit_log", [], |row| row.get(0))
        .unwrap();
    drop(connection);
    let shard = object_path(root.path(), &handle.digest)
        .parent()
        .unwrap()
        .to_path_buf();
    fs::remove_dir(&shard).unwrap();
    let artifacts_before = tree_entries(&root.path().join("artifacts"));
    let replay = store
        .delete_artifact(delete_request(
            "purge-reissue",
            &handle.digest,
            ArtifactDeletionKind::Purge,
        ))
        .unwrap();
    assert!(replay.already_applied);
    assert_eq!(replay.commit_seq, result.commit_seq);
    assert!(!shard.exists());
    assert_eq!(
        tree_entries(&root.path().join("artifacts")),
        artifacts_before
    );
    assert_eq!(
        inspect(root.path())
            .query_row("SELECT COUNT(*) FROM commit_log", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        commits_before
    );
    let intent_log = fs::read_to_string(root.path().join("purge-intent.jsonl")).unwrap();
    assert!(intent_log.contains(&handle.digest));
    assert!(intent_log.contains("incident://secret-1"));
    assert!(!intent_log.contains("purge me"));
    let audit_payload: String = inspect(root.path())
        .query_row(
            "SELECT CAST(payload AS TEXT) FROM change_event
             WHERE commit_seq=?1 AND change_kind='artifact_deletion' LIMIT 1",
            [result.commit_seq],
            |row| row.get(0),
        )
        .unwrap();
    assert!(audit_payload.contains("\"operator_id\":\"operator-1\""));
    assert!(audit_payload.contains("\"target_locator\":\"incident://secret-1\""));
    assert!(audit_payload.contains("\"deleted_at\":42"));
}

#[test]
fn purge_removes_actual_digest_temp_from_concurrent_dedup_ingest() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(KernelStore::open(root.path()).unwrap());
    seed_domain(&store);
    let payload = b"concurrent purge";
    let handle = ingest(&store, "concurrent-original", payload);
    let (name_tx, name_rx) = mpsc::sync_channel(1);
    let (resume_tx, resume_rx) = mpsc::sync_channel(1);
    let ingest_store = Arc::clone(&store);
    let ingest_thread = std::thread::spawn(move || {
        ingest_store.ingest_artifact_with_temp_hook_for_test(
            ingest_request("concurrent-dedup", payload),
            |name| {
                name_tx.send(name.to_string()).unwrap();
                resume_rx.recv().unwrap();
            },
        )
    });
    let temp_name = name_rx.recv().unwrap();
    assert!(temp_name.starts_with(&format!(".artifact-{}-", handle.digest)));
    let temp_path = root.path().join("artifacts/tmp").join(&temp_name);
    assert!(temp_path.exists());

    store
        .delete_artifact(delete_request(
            "purge-concurrent",
            &handle.digest,
            ArtifactDeletionKind::Purge,
        ))
        .unwrap();
    assert!(!temp_path.exists());
    resume_tx.send(()).unwrap();
    assert_eq!(
        ingest_thread.join().unwrap().unwrap_err().kind(),
        ArtifactErrorKind::ReAdmissionBlocked
    );
}

#[test]
fn purge_intent_failure_has_no_commit_and_commit_before_unlink_recovers_on_reopen() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = ingest(&store, "crash", b"crash window");
    let before: i64 = inspect(root.path())
        .query_row("SELECT COUNT(*) FROM commit_log", [], |row| row.get(0))
        .unwrap();
    let error = store
        .delete_artifact_with_fault_for_test(
            delete_request("intent-fail", &handle.digest, ArtifactDeletionKind::Purge),
            ArtifactDeletionFault::IntentAppend,
        )
        .unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::PurgeIntent);
    assert!(!error.is_retriable());
    assert_eq!(
        inspect(root.path())
            .query_row("SELECT COUNT(*) FROM commit_log", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert_eq!(
        store
            .ingest_artifact(ingest_request("latched-after-intent", b"other"))
            .unwrap_err()
            .kind(),
        ArtifactErrorKind::IngestionFailClosed
    );
    drop(store);
    let store = KernelStore::open(root.path()).unwrap();

    let error = store
        .delete_artifact_with_fault_for_test(
            delete_request("after-commit", &handle.digest, ArtifactDeletionKind::Purge),
            ArtifactDeletionFault::AfterCommit,
        )
        .unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::PurgeUnlinkPending);
    assert!(object_path(root.path(), &handle.digest).exists());
    let readmit = store.ingest_artifact(ArtifactIngestRequest {
        intent: intent("crash-readmit"),
        payload: b"crash window".to_vec(),
        evidence_id: "crash-readmit".to_string(),
        object_id: "crash-readmit-object".to_string(),
        object_kind: "evidence".to_string(),
        domain_id: "domain".to_string(),
        source_kind: "repository".to_string(),
        source_id: "crash-readmit".to_string(),
        source_revision: 1,
        media_type: "text/plain".to_string(),
        retention_class: "canonical".to_string(),
        retain_until: None,
        asserted_sensitivity: Sensitivity::Normal,
        provider_egress: ProviderEgress::RemoteAllowed,
        provenance: None,
    });
    assert_eq!(
        readmit.unwrap_err().kind(),
        ArtifactErrorKind::ReAdmissionBlocked
    );
    drop(store);
    let reopened = KernelStore::open(root.path()).unwrap();
    assert!(!object_path(root.path(), &handle.digest).exists());
    assert_eq!(
        inspect(root.path())
            .query_row(
                "SELECT COUNT(*) FROM artifact_pending_unlinks WHERE artifact_digest=?1",
                [&handle.digest],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    drop(reopened);
}

#[test]
fn purge_storage_exhaustion_is_retriable_and_does_not_latch_ingestion() {
    for (suffix, fault) in [
        ("intent", ArtifactDeletionFault::IntentStorageExhausted),
        ("unlink", ArtifactDeletionFault::UnlinkStorageExhausted),
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = KernelStore::open(root.path()).unwrap();
        seed_domain(&store);
        let handle = ingest(&store, &format!("capacity-{suffix}"), b"capacity");
        let error = store
            .delete_artifact_with_fault_for_test(
                delete_request(
                    &format!("purge-capacity-{suffix}"),
                    &handle.digest,
                    ArtifactDeletionKind::Purge,
                ),
                fault,
            )
            .unwrap_err();
        assert_eq!(error.kind(), ArtifactErrorKind::StorageExhausted);
        assert!(error.is_retriable());
        store
            .ingest_artifact(ingest_request(
                &format!("healthy-after-{suffix}"),
                suffix.as_bytes(),
            ))
            .unwrap();
    }
}

#[test]
fn non_capacity_purge_unlink_failure_latches_ingestion_and_keeps_pending_work() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = ingest(&store, "unlink-failure", b"unlink failure");
    let error = store
        .delete_artifact_with_fault_for_test(
            delete_request(
                "purge-unlink-failure",
                &handle.digest,
                ArtifactDeletionKind::Purge,
            ),
            ArtifactDeletionFault::Unlink,
        )
        .unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::PurgeUnlinkPending);
    assert!(error.is_retriable());
    assert_eq!(
        inspect(root.path())
            .query_row(
                "SELECT COUNT(*) FROM artifact_pending_unlinks WHERE artifact_digest=?1",
                [&handle.digest],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .ingest_artifact(ingest_request("latched-after-unlink", b"other"))
            .unwrap_err()
            .kind(),
        ArtifactErrorKind::IngestionFailClosed
    );
}

#[test]
fn purge_unreferenced_present_object_works() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    let bytes = b"orphan purge";
    let digest = format!("{:x}", Sha256::digest(bytes));
    let path = object_path(root.path(), &digest);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(&path, bytes).unwrap();

    let result = store
        .delete_artifact(delete_request(
            "purge-orphan",
            &digest,
            ArtifactDeletionKind::Purge,
        ))
        .unwrap();
    assert!(result.affected_object_ids.is_empty());
    assert!(!path.exists());
    assert_eq!(
        inspect(root.path())
            .query_row(
                "SELECT COUNT(*) FROM artifact_purge_tombstones WHERE artifact_digest=?1",
                [&digest],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
}

#[test]
fn purge_reissue_after_simulated_restore_recreates_control_facts_and_effects() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = ingest(&store, "restore", b"restored secret");
    let first = store
        .delete_artifact(delete_request(
            "purge-restore-first",
            &handle.digest,
            ArtifactDeletionKind::Purge,
        ))
        .unwrap();
    let connection = inspect(root.path());
    connection
        .execute_batch(
            "DROP TRIGGER artifact_purge_tombstones_no_delete;
             DROP TRIGGER artifact_purge_tombstones_no_update;",
        )
        .unwrap();
    connection
        .execute(
            "DELETE FROM artifact_purge_tombstones WHERE artifact_digest=?1",
            [&handle.digest],
        )
        .unwrap();
    drop(connection);
    let path = object_path(root.path(), &handle.digest);
    fs::write(&path, b"restored secret").unwrap();

    let second = store
        .delete_artifact(delete_request(
            "purge-restore-second",
            &handle.digest,
            ArtifactDeletionKind::Purge,
        ))
        .unwrap();
    assert!(!second.already_applied);
    assert!(second.commit_seq > first.commit_seq);
    assert!(!path.exists());
    assert_eq!(
        inspect(root.path())
            .query_row(
                "SELECT COUNT(*) FROM artifact_purge_tombstones WHERE artifact_digest=?1",
                [&handle.digest],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
}
