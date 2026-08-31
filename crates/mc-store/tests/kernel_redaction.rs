#![cfg(feature = "test-support")]

use std::fs;

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
        actor: format!("actor {SECRET}"),
        cause: format!("cause {SECRET}"),
    }
}

fn domain() -> DomainSpec {
    DomainSpec {
        domain_id: "redacted-domain".to_string(),
        object_id: "redacted-object".to_string(),
        name: format!("name {SECRET}"),
        source_kind: "fixture".to_string(),
        source_id: format!("source {SECRET}"),
        source_revision: 1,
        sensitivity: Sensitivity::Sensitive,
    }
}

fn family_bytes(root: &std::path::Path) -> Vec<u8> {
    let base = root.join("core.sqlite");
    [
        base.clone(),
        std::path::PathBuf::from(format!("{}-wal", base.display())),
    ]
    .into_iter()
    .filter_map(|path| fs::read(path).ok())
    .flatten()
    .collect()
}

fn inspect_text(root: &std::path::Path, sql: &str) -> String {
    let connection =
        Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
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
    assert!(inspect_text(directory.path(), "SELECT actor FROM commit_log").contains("REDACTED"));
    assert!(inspect_text(directory.path(), "SELECT name FROM domains").contains("REDACTED"));
    assert!(!family_bytes(directory.path())
        .windows(SECRET.len())
        .any(|window| window == SECRET.as_bytes()));

    let conflict = store
        .commit(intent("secret-operation", 'b'), |_| Ok(String::new()))
        .unwrap_err();
    assert_eq!(conflict.kind(), KernelErrorKind::Conflict);
    assert!(!conflict.to_string().contains(SECRET));
    assert!(!format!("{conflict:?}").contains(SECRET));

    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let metadata: (String, String, i64, i64) = connection
        .query_row(
            "SELECT detector_id,secret_type,utf8_offset,utf8_length
             FROM durable_text_redactions ORDER BY owner_kind,field_name LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(metadata.0, "redaction-vocabulary-v1");
    assert_eq!(metadata.1, "anthropic_api_key");
    assert!(metadata.2 >= 0 && metadata.3 > 0);
    let owner_kinds = connection
        .prepare("SELECT DISTINCT owner_kind FROM durable_text_redactions ORDER BY owner_kind")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for expected in ["change_event", "commit_log", "operation_receipt", "outbox"] {
        assert!(
            owner_kinds.iter().any(|kind| kind == expected),
            "{expected}"
        );
    }
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
    assert_eq!(unknown.sensitivity, Sensitivity::Secret);
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

    let proven_secret = store
        .stage_candidate(StagingCandidateSpec {
            extraction_run_id: "run-proven-secret".to_string(),
            candidate_id: "candidate-proven-secret".to_string(),
            extractor: "fixture".to_string(),
            source_kind: "repository".to_string(),
            source_id: "tracked-file".to_string(),
            source_revision: 1,
            candidate_kind: "observation".to_string(),
            payload: format!("tracked but leaking {SECRET}"),
            provenance: Some(RepositoryProvenance {
                repository_id: "repo".to_string(),
                revision: "abc123".to_string(),
            }),
            recorded_at: 1,
            lease_expires_at: 2,
        })
        .unwrap();
    assert_eq!(proven_secret.sensitivity, Sensitivity::Secret);
    assert!(!proven_secret.payload.contains(SECRET));

    let leaking_provenance = store
        .stage_candidate(StagingCandidateSpec {
            extraction_run_id: "run-provenance-secret".to_string(),
            candidate_id: "candidate-provenance-secret".to_string(),
            extractor: "fixture".to_string(),
            source_kind: "repository".to_string(),
            source_id: "tracked-file".to_string(),
            source_revision: 1,
            candidate_kind: "observation".to_string(),
            payload: "clean payload".to_string(),
            provenance: Some(RepositoryProvenance {
                repository_id: format!("repo key={SECRET}"),
                revision: "abc123".to_string(),
            }),
            recorded_at: 1,
            lease_expires_at: 2,
        })
        .unwrap();
    assert_eq!(leaking_provenance.sensitivity, Sensitivity::Secret);
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
            ("candidate-proven-secret".to_string(), "secret".to_string()),
            (
                "candidate-provenance-secret".to_string(),
                "secret".to_string()
            ),
            ("candidate-unknown".to_string(), "secret".to_string())
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
            ("run-proven-secret".to_string(), "secret".to_string()),
            ("run-provenance-secret".to_string(), "secret".to_string()),
            ("run-unknown".to_string(), "secret".to_string())
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
    mismatch.source_id = "different-source".to_string();
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
