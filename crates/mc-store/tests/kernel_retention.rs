#![cfg(feature = "test-support")]

use mc_store::kernel::{
    CommitIntent, DomainSpec, KernelErrorKind, KernelStore, RemediationTarget,
    RepositoryProvenance, Sensitivity, StagingCandidateSpec, StagingTerminalState,
    OPERATOR_REDACTION_PLACEHOLDER,
};
use rusqlite::{Connection, OpenFlags};

const HOUR_MS: i64 = 60 * 60 * 1_000;
const DAY_MS: i64 = 24 * HOUR_MS;

fn intent(key: &str) -> CommitIntent {
    CommitIntent {
        producer: "kernel-retention-test".to_string(),
        operation_key: key.to_string(),
        request_digest: "b".repeat(64),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn candidate(run: &str, candidate: &str, recorded_at: i64) -> StagingCandidateSpec {
    StagingCandidateSpec {
        extraction_run_id: run.to_string(),
        candidate_id: candidate.to_string(),
        extractor: "fixture".to_string(),
        source_kind: "repo".to_string(),
        source_id: "source".to_string(),
        source_revision: 1,
        candidate_kind: "domain".to_string(),
        payload: "payload".to_string(),
        provenance: Some(RepositoryProvenance {
            repository_id: "repo".to_string(),
            revision: "abc".to_string(),
        }),
        recorded_at,
        lease_expires_at: recorded_at + HOUR_MS,
    }
}

fn inspect(root: &std::path::Path) -> Connection {
    Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap()
}

#[test]
fn first_day_31_sweep_abandons_incomplete_run_without_deleting_it() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(candidate("run", "candidate", 0))
        .unwrap();
    assert_eq!(
        store
            .renew_staging_run("run", 2, 2 + HOUR_MS + 1)
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidInput
    );

    let now = 31 * DAY_MS;
    let result = store.run_staging_maintenance(now).unwrap();
    assert_eq!(result.abandoned, 1);
    assert_eq!(result.deleted_runs, 0);
    let connection = inspect(directory.path());
    let run: (String, i64) = connection
        .query_row(
            "SELECT terminal_state,terminal_at FROM extraction_runs WHERE extraction_run_id='run'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let staged_candidate: (String, i64) = connection
        .query_row(
            "SELECT terminal_state,terminal_at FROM candidates WHERE candidate_id='candidate'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(run, ("abandoned".to_string(), now));
    assert_eq!(staged_candidate, run);
}

#[test]
fn open_runs_staging_sweep_after_fencing() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(candidate("run", "candidate", 0))
        .unwrap();
    drop(store);

    let before = now_ms();
    let reopened = KernelStore::open(directory.path()).unwrap();
    let after = now_ms();
    let connection = inspect(directory.path());
    let facts: (String, i64, i64, String, i64) = connection
        .query_row(
            "SELECT r.terminal_state,r.terminal_at,COUNT(c.candidate_id),
                    MIN(c.terminal_state),MIN(c.terminal_at)
             FROM extraction_runs r JOIN candidates c USING(extraction_run_id)
             WHERE r.extraction_run_id='run'",
            [],
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
    assert_eq!(facts.0, "abandoned");
    assert!((before..=after).contains(&facts.1));
    assert_eq!(facts.2, 1);
    assert_eq!(facts.3, "abandoned");
    assert_eq!(facts.4, facts.1);
    drop(reopened);
}

#[test]
fn completed_staging_is_retained_at_elapsed_day_29_and_deleted_at_elapsed_day_30() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(candidate("run", "candidate", 0))
        .unwrap();
    store
        .finish_staging_run("run", StagingTerminalState::Completed, DAY_MS)
        .unwrap();
    assert_eq!(
        store
            .stage_candidate(candidate("run", "late-candidate", 2 * DAY_MS))
            .unwrap_err()
            .kind(),
        KernelErrorKind::Conflict
    );
    assert_eq!(
        store
            .run_staging_maintenance(DAY_MS + 30 * DAY_MS - 1)
            .unwrap()
            .deleted_runs,
        0
    );
    assert_eq!(
        inspect(directory.path())
            .query_row("SELECT COUNT(*) FROM extraction_runs", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .run_staging_maintenance(DAY_MS + 30 * DAY_MS)
            .unwrap()
            .deleted_runs,
        1
    );
    let connection = inspect(directory.path());
    for table in ["extraction_runs", "candidates", "candidate_scores"] {
        assert_eq!(
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0,
            "{table}"
        );
    }
}

#[test]
fn staging_cleanup_preserves_exact_denormalized_admission_facts() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(candidate("run", "candidate", 0))
        .unwrap();
    store
        .finish_staging_run("run", StagingTerminalState::Completed, DAY_MS)
        .unwrap();
    drop(store);
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "INSERT INTO admission_decisions(
                 admission_decision_id,candidate_id,source_kind,source_id,source_revision,
                 source_class,taint_class,maturity,disposition,visibility,policy_revision,
                 reason,decided_at
             ) VALUES ('admission','candidate','fixture','source',7,'normal','tainted',
                       'candidate','accepted','explicit',9,'proof',11)",
            [],
        )
        .unwrap();
    drop(connection);

    let _store = KernelStore::open(directory.path()).unwrap();
    let connection = inspect(directory.path());
    let source_facts: (Option<String>, String, String, i64, String, String) = connection
        .query_row(
            "SELECT candidate_id,source_kind,source_id,source_revision,source_class,taint_class
             FROM admission_decisions WHERE admission_decision_id='admission'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    let decision_facts: (String, String, String, i64, String, i64) = connection
        .query_row(
            "SELECT maturity,disposition,visibility,policy_revision,reason,decided_at
             FROM admission_decisions WHERE admission_decision_id='admission'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        source_facts,
        (
            None,
            "fixture".to_string(),
            "source".to_string(),
            7,
            "normal".to_string(),
            "tainted".to_string(),
        )
    );
    assert_eq!(
        decision_facts,
        (
            "candidate".to_string(),
            "accepted".to_string(),
            "explicit".to_string(),
            9,
            "proof".to_string(),
            11,
        )
    );
}

#[test]
fn halted_consumer_does_not_block_staging_cleanup_or_lose_unacked_outbox_rows() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("write"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "domain".to_string(),
                object_id: "object".to_string(),
                name: "name".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "source".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok("written".to_string())
        })
        .unwrap();
    store
        .commit(intent("register"), |envelope| {
            envelope.register_outbox_consumer("halted", 1)?;
            Ok("registered".to_string())
        })
        .unwrap();
    let before = inspect(directory.path())
        .prepare("SELECT outbox_position,commit_seq,payload FROM outbox ORDER BY outbox_position")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    store
        .stage_candidate(candidate("run", "candidate", 0))
        .unwrap();
    store
        .finish_staging_run("run", StagingTerminalState::Completed, DAY_MS)
        .unwrap();
    assert_eq!(
        store
            .run_staging_maintenance(32 * DAY_MS)
            .unwrap()
            .deleted_runs,
        1
    );

    let connection = inspect(directory.path());
    let after = connection
        .prepare("SELECT outbox_position,commit_seq,payload FROM outbox ORDER BY outbox_position")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(after, before);
    assert_eq!(
        connection
            .query_row(
                "SELECT checkpoint_commit_seq FROM outbox_consumers WHERE consumer_id='halted'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
}

#[test]
fn remediation_supports_two_live_domains_and_keeps_receipt_as_caller_result() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("insert"), |envelope| {
            for index in 1..=2 {
                envelope.insert_domain(DomainSpec {
                    domain_id: format!("domain-{index}"),
                    object_id: format!("object-{index}"),
                    name: format!("later-discovered-secret-{index}"),
                    source_kind: "fixture".to_string(),
                    source_id: format!("source-{index}"),
                    source_revision: index,
                    sensitivity: Sensitivity::Sensitive,
                })?;
            }
            Ok("inserted".to_string())
        })
        .unwrap();
    let receipt = store
        .commit(intent("remediate"), |envelope| {
            for index in 1..=2 {
                envelope.remediate_text(
                    RemediationTarget::CanonicalDomainName {
                        object_id: format!("object-{index}"),
                    },
                    "operator-1",
                    42,
                )?;
            }
            Ok("remediated".to_string())
        })
        .unwrap();
    assert_eq!(receipt.result, "remediated");

    let connection = inspect(directory.path());
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM domains WHERE name=?1",
                [OPERATOR_REDACTION_PLACEHOLDER],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM change_event
                 WHERE change_kind='operator_remediation'
                   AND CAST(payload AS TEXT) LIKE '%operator-1%'
                   AND CAST(payload AS TEXT) LIKE '%canonical_domain_name%'
                   AND CAST(payload AS TEXT) LIKE '%target_object_id%'
                   AND CAST(payload AS TEXT) LIKE '%\"remediated_at\":42%'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT result_payload FROM operation_receipts WHERE operation_key='remediate'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "remediated"
    );
}
