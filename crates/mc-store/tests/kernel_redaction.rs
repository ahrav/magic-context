#![cfg(feature = "test-support")]

use std::fs;

use mc_store::kernel::{
    CommitIntent, DomainSpec, KernelError, KernelStore, RepositoryProvenance, Sensitivity,
    StagingCandidateSpec,
};
use rusqlite::{Connection, OpenFlags};

const SECRET: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";
const SECRET_MASK: &str = "<ANTHROPIC_API_KEY_REDACTED>";
const CONTROL: &str = "redacted-domain";

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
        domain_id: CONTROL.to_string(),
        object_id: "redacted-object".to_string(),
        name: "redacted-name".to_string(),
        source_kind: "fixture".to_string(),
        source_id: "redacted-source".to_string(),
        source_revision: 1,
        sensitivity: Sensitivity::Sensitive,
    }
}

/// A zero-byte scan would satisfy every absence assertion below, so an empty result is a test failure rather than a pass.
fn family_bytes(root: &std::path::Path) -> Vec<u8> {
    let base = root.join("core.sqlite");
    let mut bytes = fs::read(&base).expect("main database is readable");
    let wal = std::path::PathBuf::from(format!("{}-wal", base.display()));
    if wal.exists() {
        bytes.extend(fs::read(&wal).expect("write-ahead log is readable"));
    }
    assert!(!bytes.is_empty(), "scanned zero bytes");
    bytes
}

fn assert_absent_and_scan_is_live(root: &std::path::Path) {
    let bytes = family_bytes(root);
    assert!(
        bytes
            .windows(CONTROL.len())
            .any(|window| window == CONTROL.as_bytes()),
        "scan did not observe stored text, so an absence check would be vacuous"
    );
    assert!(!bytes
        .windows(SECRET.len())
        .any(|window| window == SECRET.as_bytes()));
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
    assert_eq!(
        inspect_text(directory.path(), "SELECT actor FROM commit_log"),
        format!("actor {SECRET_MASK}")
    );
    assert_eq!(
        inspect_text(directory.path(), "SELECT cause FROM commit_log"),
        format!("cause {SECRET_MASK}")
    );
    assert_absent_and_scan_is_live(directory.path());

    let conflict = store
        .commit(intent("secret-operation", 'b'), |_| Ok(String::new()))
        .unwrap_err();
    assert_eq!(conflict, KernelError::Conflict);
    assert!(!conflict.to_string().contains(SECRET));
    assert!(!format!("{conflict:?}").contains(SECRET));

    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let metadata: (String, String, i64, i64) = connection
        .query_row(
            "SELECT detector_id,secret_type,source_utf8_offset,source_utf8_length
             FROM durable_text_redactions
             WHERE owner_kind='commit_log' AND field_name='actor'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(metadata.0, "redaction-vocabulary-v1");
    assert_eq!(metadata.1, "anthropic_api_key");
    // The span indexes the pre-redaction input: "actor " is 6 bytes, then the secret.
    assert_eq!(
        (metadata.2, metadata.3),
        (6, i64::try_from(SECRET.len()).unwrap())
    );
    let owner_kinds = connection
        .prepare("SELECT DISTINCT owner_kind FROM durable_text_redactions ORDER BY owner_kind")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for expected in ["commit_log", "operation_receipt"] {
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
    let bytes = family_bytes(directory.path());
    assert!(!bytes
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
    assert_eq!(error, KernelError::Conflict);

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
fn one_run_accepts_candidates_with_different_classifications() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let mut clean = shared_run_candidate("candidate-clean", 1);
    clean.payload = "public source".to_string();
    let mut secret = shared_run_candidate("candidate-secret", 2);
    secret.payload = format!("payload {SECRET}");

    assert_eq!(
        store.stage_candidate(clean).unwrap().sensitivity,
        Sensitivity::Normal
    );
    assert_eq!(
        store.stage_candidate(secret).unwrap().sensitivity,
        Sensitivity::Sensitive
    );

    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let run_class: String = connection
        .query_row("SELECT sensitivity_class FROM extraction_runs", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        run_class, "normal",
        "run classification must not follow one candidate"
    );
    let mut classes = connection
        .prepare("SELECT sensitivity_class FROM candidates ORDER BY candidate_id")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    classes.sort();
    assert_eq!(classes, ["normal", "sensitive"]);
}

#[test]
fn run_identity_fields_reject_a_detected_secret() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    for mutate in [
        |spec: &mut StagingCandidateSpec| spec.source_id = format!("src {SECRET}"),
        |spec: &mut StagingCandidateSpec| spec.extractor = format!("tool {SECRET}"),
    ] {
        let mut spec = shared_run_candidate("candidate-a", 1);
        mutate(&mut spec);
        assert_eq!(
            store.stage_candidate(spec).unwrap_err(),
            KernelError::InvalidInput
        );
    }
}

#[test]
fn a_terminal_or_expired_run_refuses_further_candidates() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(shared_run_candidate("candidate-a", 1))
        .unwrap();

    // recorded_at past the stored lease_expires_at of 11.
    assert_eq!(
        store
            .stage_candidate(shared_run_candidate("candidate-late", 99))
            .unwrap_err(),
        KernelError::Conflict
    );

    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE extraction_runs SET terminal_state='completed',terminal_at=5",
            [],
        )
        .unwrap();
    drop(connection);
    assert_eq!(
        store
            .stage_candidate(shared_run_candidate("candidate-after-terminal", 2))
            .unwrap_err(),
        KernelError::Conflict
    );
}

#[test]
fn a_run_whose_lease_expires_exactly_now_is_not_resurrected() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    // shared_run_candidate(_, 1) stores lease_expires_at = 11.
    store
        .stage_candidate(shared_run_candidate("candidate-a", 1))
        .unwrap();
    assert_eq!(
        store
            .stage_candidate(shared_run_candidate("candidate-boundary", 11))
            .unwrap_err(),
        KernelError::Conflict
    );
    store
        .stage_candidate(shared_run_candidate("candidate-live", 10))
        .unwrap();
}
