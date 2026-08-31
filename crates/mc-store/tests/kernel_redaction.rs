#![cfg(feature = "test-support")]

use std::{
    fs,
    sync::{mpsc, Arc, Barrier},
    time::Duration,
};

use mc_core::redaction::RedactionErrorKind;
use mc_store::kernel::{
    CommitIntent, DomainSpec, KernelErrorKind, KernelStore, RepositoryProvenance, Sensitivity,
    StagingCandidateSpec,
};
use rusqlite::{Connection, OpenFlags};

const SECRET: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";

fn intent(key: &str, digest: char) -> CommitIntent {
    CommitIntent {
        producer: "redaction-test".to_string(),
        operation_key: key.to_string(),
        request_digest: digest.to_string().repeat(64),
        actor: "redaction-actor".to_string(),
        cause: format!("cause {SECRET}"),
    }
}

fn domain() -> DomainSpec {
    DomainSpec {
        domain_id: "redacted-domain".to_string(),
        object_id: "redacted-object".to_string(),
        name: "domain name".to_string(),
        source_kind: "fixture".to_string(),
        source_id: "redaction-source".to_string(),
        source_revision: 1,
        sensitivity: Sensitivity::Sensitive,
    }
}

fn family_bytes(root: &std::path::Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("core.sqlite")
            && entry.file_type().unwrap().is_file()
        {
            bytes.extend(fs::read(entry.path()).unwrap());
        }
    }
    assert!(
        !bytes.is_empty(),
        "database family observation must read bytes"
    );
    assert!(
        bytes
            .windows(b"SQLite format 3".len())
            .any(|window| window == b"SQLite format 3"),
        "database family observation must contain SQLite header"
    );
    bytes
}

fn inspect_text(root: &std::path::Path, sql: &str) -> String {
    let connection =
        Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn audit_counts(root: &std::path::Path) -> (i64, i64, i64, i64) {
    let connection = Connection::open(root.join("core.sqlite")).unwrap();
    connection
        .query_row(
            "SELECT
                 (SELECT COUNT(*) FROM scan_batches),
                 (SELECT COUNT(*) FROM field_scans),
                 (SELECT COUNT(*) FROM scan_owner_copies),
                 (SELECT COUNT(*) FROM scan_detections)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
}

#[test]
fn existing_operation_identity_replays_before_new_identity_policy() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let original = store
        .commit(intent("legacy-operation", 'a'), |_| {
            Ok("original receipt".to_string())
        })
        .unwrap();
    drop(store);

    let legacy_producer = format!("legacy-{SECRET}");
    let legacy_key = format!("legacy-operation-{SECRET}");
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE operation_receipts SET producer=?1,operation_key=?2",
            rusqlite::params![legacy_producer, legacy_key],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE commit_log SET producer=?1,operation_key=?2",
            rusqlite::params![legacy_producer, legacy_key],
        )
        .unwrap();
    drop(connection);

    let store = KernelStore::open(directory.path()).unwrap();
    let before = audit_counts(directory.path());
    let replay = store
        .commit(
            CommitIntent {
                producer: legacy_producer,
                operation_key: legacy_key,
                request_digest: "a".repeat(64),
                actor: "new caller".to_string(),
                cause: "new cause".to_string(),
            },
            |_| panic!("replay must not execute operation"),
        )
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.commit_seq, original.commit_seq);
    assert_eq!(replay.result, "original receipt");
    assert_eq!(audit_counts(directory.path()), before);
}

#[test]
fn replay_refuses_after_writer_fence_is_lost() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("fenced-replay", '8'), |_| Ok("stable".to_string()))
        .unwrap();
    store.invalidate_writer_fence_for_test().unwrap();

    let error = store
        .commit(intent("fenced-replay", '8'), |_| {
            panic!("replay must not execute")
        })
        .unwrap_err();
    assert_eq!(error.kind(), KernelErrorKind::FenceLost);
}

#[test]
fn envelope_redacts_before_bind_and_never_leaks_secret_to_storage_or_errors() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let receipt = store
        .commit(intent("secret-operation", 'a'), |envelope| {
            envelope.insert_domain(domain())?;
            Ok(format!("result {SECRET}"))
        })
        .unwrap();
    assert!(!receipt.result.contains(SECRET));
    assert_eq!(
        inspect_text(directory.path(), "SELECT actor FROM commit_log"),
        "redaction-actor"
    );
    assert_eq!(
        inspect_text(directory.path(), "SELECT name FROM domains"),
        "domain name"
    );
    assert!(!family_bytes(directory.path())
        .windows(SECRET.len())
        .any(|window| window == SECRET.as_bytes()));

    let mut conflicting_intent = intent("secret-operation", 'b');
    conflicting_intent.actor = format!("actor {SECRET}");
    let conflict = store
        .commit(conflicting_intent, |_| Ok(String::new()))
        .unwrap_err();
    assert_eq!(conflict.kind(), KernelErrorKind::Conflict);
    assert!(!conflict.to_string().contains(SECRET));
    assert!(!format!("{conflict:?}").contains(SECRET));

    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let metadata: (String, String, String, String, String, String, i64) = connection
        .query_row(
            "SELECT field_scans.detector_id,scan_detections.rule_id,
                    scan_detections.detector_revision,scan_detections.exactness,
                    scan_detections.label_id,scan_detections.span_kind,
                    scan_detections.detection_ordinal
             FROM scan_detections
             JOIN field_scans USING(scan_id)
             ORDER BY scan_id,detection_ordinal LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(metadata.0, "redaction-vocabulary-v1");
    assert_eq!(metadata.1, "anthropic-api-key");
    assert_eq!(metadata.2, "redaction-vocabulary-v1");
    assert_eq!(metadata.3, "exact");
    assert_eq!(metadata.4, "anthropic_api_key");
    assert_eq!(metadata.5, "value");
    assert_eq!(metadata.6, 0);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM scan_batches", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM field_scans WHERE finding_count=0)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap());
    let owner_kinds = connection
        .prepare("SELECT DISTINCT owner_kind FROM scan_owner_copies ORDER BY owner_kind")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for expected in [
        "change_event",
        "commit_log",
        "object_registry",
        "operation_receipt",
        "outbox",
    ] {
        assert!(
            owner_kinds.iter().any(|kind| kind == expected),
            "{expected}"
        );
    }
}

#[test]
fn intent_rejection_precedes_writer_lock_and_result_limits_keep_typed_reason() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(KernelStore::open(directory.path()).unwrap());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = {
        let store = Arc::clone(&store);
        std::thread::spawn(move || {
            store
                .commit(intent("held-writer", 'c'), |_| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(String::new())
                })
                .unwrap();
        })
    };
    entered_rx.recv().unwrap();

    let (result_tx, result_rx) = mpsc::channel();
    let contender = {
        let store = Arc::clone(&store);
        std::thread::spawn(move || {
            let mut blocked = intent("blocked-new-operation", 'd');
            blocked.request_digest = "invalid".to_string();
            let error = store.commit(blocked, |_| Ok(String::new())).unwrap_err();
            result_tx.send(error.kind()).unwrap();
        })
    };
    let kind = result_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("intent scan must finish while writer lock is held");
    assert_eq!(kind, KernelErrorKind::InvalidInput);
    let (clean_tx, clean_rx) = mpsc::channel();
    let clean_contender = {
        let store = Arc::clone(&store);
        std::thread::spawn(move || {
            let receipt = store
                .commit(
                    intent("blocked-clean-operation", '9'),
                    |_| Ok(String::new()),
                )
                .unwrap();
            clean_tx.send(receipt.commit_seq).unwrap();
        })
    };
    assert!(
        clean_rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "clean contender must wait for writer fence"
    );
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    contender.join().unwrap();
    assert!(clean_rx.recv_timeout(Duration::from_secs(1)).unwrap() > 0);
    clean_contender.join().unwrap();

    let error = store
        .commit(intent("oversized-result", 'e'), |_| {
            Ok("x".repeat(2 * 1024 * 1024))
        })
        .unwrap_err();
    assert_eq!(
        error.kind(),
        KernelErrorKind::Redaction(RedactionErrorKind::InputLimit)
    );
}

#[test]
fn new_kernel_identities_reject_instead_of_collapsing() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    for operation_key in [format!("first {SECRET}"), format!("second {SECRET}")] {
        let error = store
            .commit(intent(&operation_key, 'a'), |_| Ok(String::new()))
            .unwrap_err();
        assert_eq!(
            error.kind(),
            KernelErrorKind::Redaction(RedactionErrorKind::SecretDetected)
        );
        assert!(!error.to_string().contains(SECRET));
    }
    let error = store
        .commit(intent("secret-domain-name", 'b'), |envelope| {
            let mut domain = domain();
            domain.name = format!("name {SECRET}");
            envelope.insert_domain(domain)?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(
        error.kind(),
        KernelErrorKind::Redaction(RedactionErrorKind::SecretDetected)
    );
    assert!(!error.to_string().contains(SECRET));
}

#[test]
fn staging_requires_affirmative_repository_provenance_for_normal() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let unknown = store
        .stage_candidate(StagingCandidateSpec {
            extraction_run_id: "run-unknown".to_string(),
            candidate_id: "candidate-unknown".to_string(),
            extractor: "fixture".to_string(),
            source_kind: "tool".to_string(),
            source_id: "unknown".to_string(),
            source_revision: 1,
            candidate_kind: "observation".to_string(),
            payload: format!("payload {SECRET}"),
            provenance: None,
            recorded_at: 1,
            lease_expires_at: 2,
        })
        .unwrap();
    assert_eq!(unknown.sensitivity, Sensitivity::Sensitive);
    assert!(!unknown.payload.contains(SECRET));

    let proven = store
        .stage_candidate(StagingCandidateSpec {
            extraction_run_id: "run-proven".to_string(),
            candidate_id: "candidate-proven".to_string(),
            extractor: "fixture".to_string(),
            source_kind: "repository".to_string(),
            source_id: "tracked-file".to_string(),
            source_revision: 1,
            candidate_kind: "observation".to_string(),
            payload: "public source".to_string(),
            provenance: Some(RepositoryProvenance {
                repository_id: "repo".to_string(),
                revision: "abc123".to_string(),
            }),
            recorded_at: 1,
            lease_expires_at: 2,
        })
        .unwrap();
    assert_eq!(proven.sensitivity, Sensitivity::Normal);
    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        connection
            .prepare("SELECT candidate_id,sensitivity_class FROM candidates ORDER BY candidate_id",)
            .unwrap()
            .query_map([], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?
            )))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap(),
        [
            ("candidate-proven".to_string(), "normal".to_string()),
            ("candidate-unknown".to_string(), "sensitive".to_string())
        ]
    );
    assert_eq!(
        connection
            .prepare(
                "SELECT extraction_run_id,sensitivity_class FROM extraction_runs
                 ORDER BY extraction_run_id",
            )
            .unwrap()
            .query_map([], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?
            )))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap(),
        [
            ("run-proven".to_string(), "normal".to_string()),
            ("run-unknown".to_string(), "sensitive".to_string())
        ]
    );
    assert!(!family_bytes(directory.path())
        .windows(SECRET.len())
        .any(|window| window == SECRET.as_bytes()));
}

fn shared_run_candidate(candidate_id: &str, recorded_at: i64) -> StagingCandidateSpec {
    StagingCandidateSpec {
        extraction_run_id: "shared-run".to_string(),
        candidate_id: candidate_id.to_string(),
        extractor: "fixture".to_string(),
        source_kind: "repository".to_string(),
        source_id: "tracked-file".to_string(),
        source_revision: 1,
        candidate_kind: "observation".to_string(),
        payload: format!("payload-{candidate_id}"),
        provenance: Some(RepositoryProvenance {
            repository_id: "repo".to_string(),
            revision: "abc123".to_string(),
        }),
        recorded_at,
        lease_expires_at: recorded_at + 10,
    }
}

#[test]
fn staging_run_is_inserted_once_and_reused_for_multiple_candidates() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(shared_run_candidate("candidate-a", 1))
        .unwrap();
    store
        .stage_candidate(shared_run_candidate("candidate-b", 5))
        .unwrap();

    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM extraction_runs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM candidates", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    let renewal: (i64, i64) = connection
        .query_row(
            "SELECT heartbeat_at,lease_expires_at FROM extraction_runs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(renewal, (5, 15));
}

#[test]
fn staging_run_reuse_with_changed_immutable_metadata_is_a_typed_conflict() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(shared_run_candidate("candidate-a", 1))
        .unwrap();
    let mut mismatch = shared_run_candidate("candidate-b", 5);
    mismatch.source_id = format!("different-source {SECRET}");
    let error = store.stage_candidate(mismatch).unwrap_err();
    assert_eq!(error.kind(), KernelErrorKind::Conflict);

    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM candidates", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let renewal: (i64, i64) = connection
        .query_row(
            "SELECT heartbeat_at,lease_expires_at FROM extraction_runs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(renewal, (1, 11));
}

#[test]
fn concurrent_duplicate_persists_one_scan_batch() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(KernelStore::open(directory.path()).unwrap());
    let barrier = Arc::new(Barrier::new(2));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let store = Arc::clone(&store);
        let barrier = Arc::clone(&barrier);
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            store
                .commit(intent("concurrent-same-operation", 'f'), |envelope| {
                    envelope.insert_domain(domain())?;
                    Ok("password=winner-secret".to_string())
                })
                .unwrap()
        }));
    }
    let receipts = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(receipts[0].commit_seq, receipts[1].commit_seq);
    assert_eq!(receipts[0].result, receipts[1].result);
    assert_eq!(receipts[0].result, "password=<REDACTED:password>");
    assert_ne!(receipts[0].replayed, receipts[1].replayed);

    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM scan_batches", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
