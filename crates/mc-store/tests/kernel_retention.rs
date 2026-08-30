#![cfg(feature = "test-support")]

use mc_store::kernel::{
    CommitIntent, DomainSpec, KernelErrorKind, KernelStore, RemediationTarget,
    RepositoryProvenance, Sensitivity, StagingCandidateSpec, StagingTerminalState,
    OPERATOR_REDACTION_PLACEHOLDER, STAGING_RETENTION_MS,
};
use rusqlite::{Connection, OpenFlags};

const HOUR_MS: i64 = 60 * 60 * 1_000;
const DAY_MS: i64 = 24 * HOUR_MS;
/// The last instant a run staged at 0 still holds its lease.
const TERMINAL_AT: i64 = HOUR_MS - 1;

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
    let now = 31 * DAY_MS;
    let result = store.run_staging_maintenance(now).unwrap();
    assert_eq!(result.abandoned_runs, 1);
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
fn completed_staging_survives_day_29_and_is_deleted_day_31() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(candidate("run", "candidate", 0))
        .unwrap();
    store
        .finish_staging_run("run", StagingTerminalState::Completed, TERMINAL_AT)
        .unwrap();
    assert_eq!(
        store
            .stage_candidate(candidate("run", "late-candidate", 2 * DAY_MS))
            .unwrap_err()
            .kind(),
        KernelErrorKind::Conflict
    );
    // One millisecond short of the cutoff, so a retention window longer or shorter than
    // STAGING_RETENTION_MS fails one of the two assertions.
    assert_eq!(
        store
            .run_staging_maintenance(TERMINAL_AT + STAGING_RETENTION_MS - 1)
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
            .run_staging_maintenance(TERMINAL_AT + STAGING_RETENTION_MS)
            .unwrap()
            .deleted_runs,
        1
    );
    let connection = inspect(directory.path());
    for table in [
        "extraction_runs",
        "candidates",
        "candidate_scores",
        "durable_text_redactions",
    ] {
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
        .finish_staging_run("run", StagingTerminalState::Completed, TERMINAL_AT)
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

    // Deletion is caller-driven, so drive it past the retention cutoff rather than relying on open.
    let store = KernelStore::open(directory.path()).unwrap();
    assert_eq!(
        store
            .delete_aged_staging_runs(TERMINAL_AT + STAGING_RETENTION_MS)
            .unwrap(),
        1
    );
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
        .finish_staging_run("run", StagingTerminalState::Completed, TERMINAL_AT)
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

const AWS_KEY: &str = "AKIAFFFFFFFFFFFFFFFF";

fn secret_candidate(recorded_at: i64) -> StagingCandidateSpec {
    let mut spec = candidate(
        &format!("run-{AWS_KEY}"),
        &format!("cand-{AWS_KEY}"),
        recorded_at,
    );
    spec.payload = format!("payload-{AWS_KEY}");
    spec
}

#[test]
fn renew_advances_the_lease_for_a_run_whose_id_carries_a_secret() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let run = format!("run-{AWS_KEY}");
    store.stage_candidate(secret_candidate(0)).unwrap();

    store.renew_staging_run(&run, 10, 10 + HOUR_MS).unwrap();
    let connection = inspect(directory.path());
    let leases: (i64, i64, i64, i64) = connection
        .query_row(
            "SELECT r.heartbeat_at,r.lease_expires_at,c.heartbeat_at,c.lease_expires_at
             FROM extraction_runs r JOIN candidates c USING(extraction_run_id)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(leases, (10, 10 + HOUR_MS, 10, 10 + HOUR_MS));

    // A shorter lease must not pull the expiry back into the sweep's reach.
    store.renew_staging_run(&run, 20, 20).unwrap();
    let after: (i64, i64) = connection
        .query_row(
            "SELECT heartbeat_at,lease_expires_at FROM extraction_runs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(after, (20, 10 + HOUR_MS));
}

#[test]
fn renew_rejects_an_unknown_run_a_backwards_heartbeat_and_an_expired_lease() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(candidate("run", "candidate", 100))
        .unwrap();

    assert_eq!(
        store
            .renew_staging_run("absent", 100, 100)
            .unwrap_err()
            .kind(),
        KernelErrorKind::NotFound
    );
    assert_eq!(
        store
            .renew_staging_run("run", 50, 50 + HOUR_MS)
            .unwrap_err()
            .kind(),
        KernelErrorKind::Conflict
    );
    assert_eq!(
        store
            .renew_staging_run("run", 2, 2 + HOUR_MS + 1)
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidInput
    );
    // The stored lease ends at 100 + HOUR_MS, so a heartbeat at that instant is too late.
    assert_eq!(
        store
            .renew_staging_run("run", 100 + HOUR_MS, 100 + HOUR_MS)
            .unwrap_err()
            .kind(),
        KernelErrorKind::Conflict
    );
}

#[test]
fn finish_rejects_a_terminal_time_before_the_run_lifecycle() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(candidate("run", "candidate", DAY_MS))
        .unwrap();

    // Backdating terminal_at would expire the retention window on a run that just finished.
    assert_eq!(
        store
            .finish_staging_run("run", StagingTerminalState::Completed, 0)
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidInput
    );
    assert_eq!(
        store
            .finish_staging_run("absent", StagingTerminalState::Completed, DAY_MS)
            .unwrap_err()
            .kind(),
        KernelErrorKind::NotFound
    );
    store
        .finish_staging_run("run", StagingTerminalState::Failed, DAY_MS)
        .unwrap();
    assert_eq!(
        store
            .finish_staging_run("run", StagingTerminalState::Canceled, DAY_MS)
            .unwrap_err()
            .kind(),
        KernelErrorKind::Conflict
    );
    assert_eq!(
        inspect(directory.path())
            .query_row(
                "SELECT terminal_state FROM extraction_runs WHERE extraction_run_id='run'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "failed"
    );
}

#[test]
fn finish_terminates_a_run_whose_id_carries_a_secret() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store.stage_candidate(secret_candidate(0)).unwrap();
    store
        .finish_staging_run(
            &format!("run-{AWS_KEY}"),
            StagingTerminalState::Canceled,
            TERMINAL_AT,
        )
        .unwrap();
    let states: (String, String) = inspect(directory.path())
        .query_row(
            "SELECT r.terminal_state,c.terminal_state
             FROM extraction_runs r JOIN candidates c USING(extraction_run_id)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(states, ("canceled".to_string(), "canceled".to_string()));
}

#[test]
fn deleting_aged_runs_removes_their_secret_location_rows() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store.stage_candidate(secret_candidate(0)).unwrap();
    store
        .finish_staging_run(
            &format!("run-{AWS_KEY}"),
            StagingTerminalState::Completed,
            0,
        )
        .unwrap();

    let connection = inspect(directory.path());
    let staged_redactions = |connection: &Connection| -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM durable_text_redactions
                 WHERE owner_kind IN ('extraction_run','staging_candidate')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
    };
    assert!(staged_redactions(&connection) > 0);

    assert_eq!(
        store
            .delete_aged_staging_runs(STAGING_RETENTION_MS)
            .unwrap(),
        1
    );
    assert_eq!(staged_redactions(&connection), 0);
    // Nothing is left to delete, so a second pass reports an empty batch.
    assert_eq!(
        store
            .delete_aged_staging_runs(STAGING_RETENTION_MS)
            .unwrap(),
        0
    );
}

#[test]
fn maintenance_rejects_a_negative_clock_reading() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    for kind in [
        store.run_staging_maintenance(-1).unwrap_err().kind(),
        store.abandon_expired_staging_runs(-1).unwrap_err().kind(),
        store.delete_aged_staging_runs(-1).unwrap_err().kind(),
    ] {
        assert_eq!(kind, KernelErrorKind::InvalidInput);
    }
}

#[test]
fn opening_the_store_reclaims_leases_without_deleting_aged_runs() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(candidate("run", "candidate", 0))
        .unwrap();
    store
        .finish_staging_run("run", StagingTerminalState::Completed, 0)
        .unwrap();
    drop(store);

    // The wall clock is far past the cutoff, so a deleting sweep at open would drop the run.
    let reopened = KernelStore::open(directory.path()).unwrap();
    assert_eq!(
        inspect(directory.path())
            .query_row("SELECT COUNT(*) FROM extraction_runs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(reopened.delete_aged_staging_runs(now_ms()).unwrap(), 1);
}

#[test]
fn the_operator_placeholder_is_not_an_insertable_domain_name() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let spec = |name: &str, index: i64| DomainSpec {
        domain_id: format!("domain-{index}"),
        object_id: format!("object-{index}"),
        name: name.to_string(),
        source_kind: "fixture".to_string(),
        source_id: format!("source-{index}"),
        source_revision: index,
        sensitivity: Sensitivity::Normal,
    };

    assert_eq!(
        store
            .commit(intent("reserved"), |envelope| {
                envelope.insert_domain(spec(OPERATOR_REDACTION_PLACEHOLDER, 1))?;
                Ok("inserted".to_string())
            })
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidInput
    );
    // The uniqueness index still binds ordinary names.
    store
        .commit(intent("first"), |envelope| {
            envelope.insert_domain(spec("payments", 1))?;
            Ok("inserted".to_string())
        })
        .unwrap();
    assert!(store
        .commit(intent("duplicate"), |envelope| {
            envelope.insert_domain(spec("payments", 2))?;
            Ok("inserted".to_string())
        })
        .is_err());
}

#[test]
fn remediation_reaches_retired_domains_and_repeats_without_failing() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("insert"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "domain-1".to_string(),
                object_id: "object-1".to_string(),
                name: "later-discovered-secret".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "source-1".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Sensitive,
            })?;
            Ok("inserted".to_string())
        })
        .unwrap();
    store
        .commit(intent("retire"), |envelope| {
            envelope.retire_domain("object-1")?;
            Ok("retired".to_string())
        })
        .unwrap();

    // A retired domain still stores its plaintext name, so remediation has to reach it.
    store
        .commit(intent("remediate"), |envelope| {
            envelope.remediate_text(
                RemediationTarget::CanonicalDomainName {
                    object_id: "object-1".to_string(),
                },
                "operator-1",
                42,
            )?;
            Ok("remediated".to_string())
        })
        .unwrap();
    assert_eq!(
        inspect(directory.path())
            .query_row(
                "SELECT name FROM domains WHERE object_id='object-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        OPERATOR_REDACTION_PLACEHOLDER
    );

    // Repeating the remediation records a second audit entry instead of aborting.
    store
        .commit(intent("remediate-again"), |envelope| {
            envelope.remediate_text(
                RemediationTarget::CanonicalDomainName {
                    object_id: "object-1".to_string(),
                },
                "operator-1",
                43,
            )?;
            Ok("remediated".to_string())
        })
        .unwrap();
    assert_eq!(
        inspect(directory.path())
            .query_row(
                "SELECT COUNT(*) FROM change_event WHERE change_kind='operator_remediation'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        2
    );
}

#[test]
fn remediation_rejects_an_unknown_object_and_a_non_domain_kind() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    assert_eq!(
        store
            .commit(intent("missing"), |envelope| {
                envelope.remediate_text(
                    RemediationTarget::CanonicalDomainName {
                        object_id: "absent".to_string(),
                    },
                    "operator-1",
                    1,
                )?;
                Ok("remediated".to_string())
            })
            .unwrap_err()
            .kind(),
        KernelErrorKind::NotFound
    );
    assert_eq!(
        store
            .commit(intent("empty-operator"), |envelope| {
                envelope.remediate_text(
                    RemediationTarget::CanonicalDomainName {
                        object_id: "absent".to_string(),
                    },
                    "   ",
                    1,
                )?;
                Ok("remediated".to_string())
            })
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidInput
    );
}

#[test]
fn staging_a_candidate_cannot_revive_a_run_whose_lease_expired() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(candidate("run", "first", 100))
        .unwrap();

    // The stored lease ends at 100 + HOUR_MS. A producer arriving at that instant is as
    // stale as one calling renew_staging_run, so both paths refuse it.
    assert_eq!(
        store
            .stage_candidate(candidate("run", "second", 100 + HOUR_MS))
            .unwrap_err()
            .kind(),
        KernelErrorKind::Conflict
    );
    let connection = inspect(directory.path());
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM candidates", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT lease_expires_at FROM extraction_runs", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        100 + HOUR_MS
    );

    // A producer still inside the lease keeps working.
    store
        .stage_candidate(candidate("run", "third", 100 + HOUR_MS - 1))
        .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM candidates", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn finishing_requires_the_lease_to_still_cover_the_terminal_instant() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .stage_candidate(candidate("run", "candidate", 0))
        .unwrap();

    // A far-future terminal_at would sit past every later cutoff and exempt the run and its
    // candidate payloads from deletion for good, so the lease caps it.
    assert_eq!(
        store
            .finish_staging_run("run", StagingTerminalState::Completed, i64::MAX)
            .unwrap_err()
            .kind(),
        KernelErrorKind::Conflict
    );
    assert_eq!(
        store
            .finish_staging_run("run", StagingTerminalState::Completed, HOUR_MS)
            .unwrap_err()
            .kind(),
        KernelErrorKind::Conflict
    );
    store
        .finish_staging_run("run", StagingTerminalState::Completed, HOUR_MS - 1)
        .unwrap();
    assert_eq!(
        store
            .delete_aged_staging_runs(HOUR_MS - 1 + STAGING_RETENTION_MS)
            .unwrap(),
        1
    );
}

#[test]
fn staging_a_candidate_cannot_reach_back_before_the_run_heartbeat() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let mut first = candidate("run", "first", 200);
    first.lease_expires_at = 250;
    store.stage_candidate(first).unwrap();

    // An out-of-order producer at 150 sits inside the stored lease of 250 but behind the
    // heartbeat of 200, and its own long lease would otherwise extend the run.
    let mut stale = candidate("run", "stale", 150);
    stale.lease_expires_at = 150 + HOUR_MS;
    assert_eq!(
        store.stage_candidate(stale).unwrap_err().kind(),
        KernelErrorKind::Conflict
    );
    let connection = inspect(directory.path());
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM candidates", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT heartbeat_at,lease_expires_at FROM extraction_runs",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap(),
        (200, 250)
    );
}
