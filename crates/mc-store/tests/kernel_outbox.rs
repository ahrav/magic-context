#![cfg(feature = "test-support")]

use mc_store::kernel::{CommitIntent, DomainSpec, KernelErrorKind, KernelStore, Sensitivity};
use rusqlite::{Connection, OpenFlags};

const SECRET: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";

fn intent(key: &str) -> CommitIntent {
    CommitIntent {
        producer: "kernel-outbox-test".to_string(),
        operation_key: key.to_string(),
        request_digest: "a".repeat(64),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn domain(index: usize) -> DomainSpec {
    DomainSpec {
        domain_id: format!("domain-{index}"),
        object_id: format!("object-{index}"),
        name: if index == 1 {
            format!("name-{SECRET}")
        } else {
            format!("name-{index}")
        },
        source_kind: "fixture".to_string(),
        source_id: format!("source-{index}"),
        source_revision: i64::try_from(index).unwrap(),
        sensitivity: Sensitivity::Normal,
    }
}

fn inspect(root: &std::path::Path) -> Connection {
    Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn commit_domain(store: &KernelStore, index: usize) -> i64 {
    store
        .commit(intent(&format!("write-{index}")), |envelope| {
            envelope.insert_domain(domain(index))?;
            Ok(index.to_string())
        })
        .unwrap()
        .commit_seq
}

#[test]
fn acknowledgements_use_commit_boundaries_through_commit_log_tip() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let first = store
        .commit(intent("multi"), |envelope| {
            envelope.insert_domain(domain(1))?;
            envelope.insert_domain(domain(2))?;
            Ok("two".to_string())
        })
        .unwrap()
        .commit_seq;
    let second = commit_domain(&store, 3);
    let registration = store
        .commit(intent("register"), |envelope| {
            assert_eq!(envelope.register_outbox_consumer("search", 10)?, 0);
            Ok("registered".to_string())
        })
        .unwrap()
        .commit_seq;
    let outbox_rows = inspect(directory.path())
        .query_row("SELECT COUNT(*) FROM outbox", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();

    store.acknowledge_outbox("search", first, 11).unwrap();
    store.acknowledge_outbox("search", first, 12).unwrap();
    store.acknowledge_outbox("search", second, 13).unwrap();
    let empty_commit = store
        .commit(intent("outbox-empty"), |_| Ok("empty".to_string()))
        .unwrap()
        .commit_seq;
    assert!(empty_commit > registration);
    store
        .acknowledge_outbox("search", empty_commit, 14)
        .unwrap();

    let connection = inspect(directory.path());
    assert_eq!(
        connection
            .query_row(
                "SELECT (SELECT MAX(commit_seq) FROM commit_log)-checkpoint_commit_seq
                 FROM outbox_consumers WHERE consumer_id='search'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM outbox", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        outbox_rows
    );
    drop(connection);
    assert_eq!(
        store
            .acknowledge_outbox("search", second, 15)
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidCheckpoint
    );
    assert_eq!(
        store
            .acknowledge_outbox("search", empty_commit + 1, 15)
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidCheckpoint
    );
}

#[test]
fn slow_consumer_sets_commit_prune_horizon_and_registration_sees_oldest_retained_commit() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let first = commit_domain(&store, 1);
    let second = commit_domain(&store, 2);
    let third = commit_domain(&store, 3);
    for consumer in ["slow", "fast"] {
        store
            .commit(intent(&format!("register-{consumer}")), |envelope| {
                assert_eq!(envelope.register_outbox_consumer(consumer, 10)?, 0);
                Ok("registered".to_string())
            })
            .unwrap();
    }
    store.acknowledge_outbox("slow", first, 11).unwrap();
    store.acknowledge_outbox("fast", third, 11).unwrap();
    let receipt_before: (String, i64, String) = inspect(directory.path())
        .query_row(
            "SELECT operation_key,commit_seq,result_payload FROM operation_receipts
             WHERE operation_key='write-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();

    let result = store.prune_outbox().unwrap();
    assert_eq!(result.horizon, first);
    assert_eq!(result.deleted, 1);
    let connection = inspect(directory.path());
    assert_eq!(
        connection
            .query_row("SELECT MIN(commit_seq) FROM outbox", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        second
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM durable_text_redactions r
                 WHERE r.owner_kind='outbox' AND NOT EXISTS (
                     SELECT 1 FROM outbox o WHERE CAST(o.outbox_position AS TEXT)=r.owner_id
                 )",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT operation_key,commit_seq,result_payload FROM operation_receipts
                 WHERE operation_key='write-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap(),
        receipt_before
    );
    drop(connection);

    store
        .commit(intent("register-new"), |envelope| {
            assert_eq!(envelope.register_outbox_consumer("new", 12)?, second - 1);
            Ok("registered".to_string())
        })
        .unwrap();
}

#[test]
fn empty_required_set_refuses_prune_and_empty_outbox_registration_uses_pre_registration_tip() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let tip = store
        .commit(intent("empty"), |_| Ok("empty".to_string()))
        .unwrap()
        .commit_seq;
    assert_eq!(
        store.prune_outbox().unwrap_err().kind(),
        KernelErrorKind::NoRequiredConsumers
    );
    store
        .commit(intent("register"), |envelope| {
            assert_eq!(envelope.register_outbox_consumer("search", 10)?, tip);
            Ok("registered".to_string())
        })
        .unwrap();
}

#[test]
fn deregistration_uses_commit_tip_without_publication_and_abandonment_records_four_facts() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    commit_domain(&store, 1);
    let registration_tip = store
        .commit(intent("register-pending"), |envelope| {
            envelope.register_outbox_consumer("pending", 1)?;
            Ok("registered".to_string())
        })
        .unwrap()
        .commit_seq;
    assert_eq!(
        store
            .commit(intent("deregister-pending"), |envelope| {
                envelope.deregister_outbox_consumer("pending", 2)?;
                Ok("removed".to_string())
            })
            .unwrap_err()
            .kind(),
        KernelErrorKind::ConsumerPending
    );
    store
        .acknowledge_outbox("pending", registration_tip, 3)
        .unwrap();
    store
        .commit(intent("deregister-caught-up"), |envelope| {
            envelope.deregister_outbox_consumer("pending", 4)?;
            Ok("removed".to_string())
        })
        .unwrap();

    let abandoned_registration = store
        .commit(intent("register-abandoned"), |envelope| {
            envelope.register_outbox_consumer("abandoned", 5)?;
            Ok("registered".to_string())
        })
        .unwrap()
        .commit_seq;
    store
        .acknowledge_outbox("abandoned", abandoned_registration, 6)
        .unwrap();
    store
        .commit(intent("abandon"), |envelope| {
            envelope.abandon_outbox_consumer("abandoned", "operator-1", "retired", 42)?;
            Ok("abandoned".to_string())
        })
        .unwrap();

    let connection = inspect(directory.path());
    let facts: (String, i64, String, i64) = connection
        .query_row(
            "SELECT consumer_id,last_checkpoint_commit_seq,operator_id,abandoned_at
             FROM consumer_abandonments",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(facts.0, "abandoned");
    assert!(facts.1 > 0);
    assert_eq!(facts.2, "operator-1");
    assert_eq!(facts.3, 42);
    let payload: String = connection
        .query_row(
            "SELECT CAST(payload AS TEXT) FROM change_event
             WHERE change_kind='consumer_abandon'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        payload.contains("\"consumer_id\":\"abandoned\""),
        "{payload}"
    );
    assert!(payload.contains(&format!("\"checkpoint_commit_seq\":{}", facts.1)));
    assert!(payload.contains("\"operator_id\":\"operator-1\""));
    assert!(payload.contains("\"abandoned_at\":42"));
}

#[test]
fn derived_projection_discard_preserves_exact_checkpoints_and_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let receipt = store
        .commit(intent("empty"), |_| Ok("caller-result".to_string()))
        .unwrap();
    store
        .commit(intent("register"), |envelope| {
            envelope.register_outbox_consumer("search", 7)?;
            Ok("registered".to_string())
        })
        .unwrap();
    let before_checkpoint: (String, i64, i64) = inspect(directory.path())
        .query_row(
            "SELECT consumer_id,checkpoint_commit_seq,updated_at FROM outbox_consumers",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let before_receipt: (String, String, i64, String) = inspect(directory.path())
        .query_row(
            "SELECT producer,operation_key,commit_seq,result_payload FROM operation_receipts
             WHERE operation_key='empty'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(receipt.result, "caller-result");
    drop(store);

    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "OFF")
        .unwrap();
    connection
        .execute(
            "INSERT INTO alignment_projection(
                 decision_id,observation_id,alignment_kind,built_through_commit_seq
             ) VALUES ('derived-decision','derived-observation','derived',1)",
            [],
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();
    assert_eq!(store.replace_alignment_projection(&[]).unwrap().rows, 0);
    let connection = inspect(directory.path());
    assert_eq!(
        connection
            .query_row(
                "SELECT consumer_id,checkpoint_commit_seq,updated_at FROM outbox_consumers",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap(),
        before_checkpoint
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT producer,operation_key,commit_seq,result_payload FROM operation_receipts
                 WHERE operation_key='empty'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap(),
        before_receipt
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM alignment_projection", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn publication_boundary_and_fence_checks_remain_enforced() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("multi"), |envelope| {
            envelope.insert_domain(domain(1))?;
            envelope.insert_domain(domain(2))?;
            Ok("two".to_string())
        })
        .unwrap();
    assert_eq!(
        store
            .mark_outbox_published_through(1, 1)
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidCheckpoint
    );
    store.mark_outbox_published_through(2, 1).unwrap();
    store.invalidate_writer_fence_for_test().unwrap();
    assert_eq!(
        store.prune_outbox().unwrap_err().kind(),
        KernelErrorKind::FenceLost
    );
}

#[test]
fn publication_marks_rows_through_the_position_and_leaves_later_rows_unpublished() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("multi"), |envelope| {
            envelope.insert_domain(domain(1))?;
            envelope.insert_domain(domain(2))?;
            Ok("two".to_string())
        })
        .unwrap();
    commit_domain(&store, 3);

    store.mark_outbox_published_through(2, 7).unwrap();
    let connection = inspect(directory.path());
    let published = |connection: &Connection| -> Vec<(i64, Option<i64>)> {
        connection
            .prepare("SELECT outbox_position,published_at FROM outbox ORDER BY outbox_position")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    assert_eq!(
        published(&connection),
        vec![(1, Some(7)), (2, Some(7)), (3, None)]
    );

    // A later timestamp must not rewrite an already published row.
    store.mark_outbox_published_through(3, 9).unwrap();
    assert_eq!(
        published(&connection),
        vec![(1, Some(7)), (2, Some(7)), (3, Some(9))]
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT published_through_position FROM outbox_publication WHERE id=0",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        3
    );
}

#[test]
fn publication_stays_idempotent_after_the_rows_are_pruned() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let first = store
        .commit(intent("multi"), |envelope| {
            envelope.insert_domain(domain(1))?;
            envelope.insert_domain(domain(2))?;
            Ok("two".to_string())
        })
        .unwrap()
        .commit_seq;
    let second = commit_domain(&store, 3);
    store
        .commit(intent("register"), |envelope| {
            envelope.register_outbox_consumer("search", 10)?;
            Ok("registered".to_string())
        })
        .unwrap();

    store.mark_outbox_published_through(2, 7).unwrap();
    store.acknowledge_outbox("search", first, 11).unwrap();
    assert_eq!(store.prune_outbox().unwrap().deleted, 2);

    // The publisher lost its acknowledgement round trip and repeats a position whose rows are gone.
    store.mark_outbox_published_through(2, 7).unwrap();
    assert_eq!(
        inspect(directory.path())
            .query_row("SELECT MIN(commit_seq) FROM outbox", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        second
    );
}

#[test]
fn a_consumer_id_that_redaction_rewrites_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    assert_eq!(
        store
            .commit(intent("register-secret"), |envelope| {
                envelope.register_outbox_consumer(&format!("search-{SECRET}"), 10)?;
                Ok("registered".to_string())
            })
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidInput
    );
}

#[test]
fn argument_validation_is_separate_from_checkpoint_rejection() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    commit_domain(&store, 1);
    for kind in [
        store.acknowledge_outbox("", 0, 0).unwrap_err().kind(),
        store
            .acknowledge_outbox("search", 0, -1)
            .unwrap_err()
            .kind(),
        store
            .mark_outbox_published_through(0, 1)
            .unwrap_err()
            .kind(),
        store
            .mark_outbox_published_through(1, -1)
            .unwrap_err()
            .kind(),
    ] {
        assert_eq!(kind, KernelErrorKind::InvalidInput);
    }
    assert_eq!(
        store.acknowledge_outbox("absent", 0, 1).unwrap_err().kind(),
        KernelErrorKind::NotFound
    );
}

#[test]
fn every_outbox_and_retention_entry_point_checks_the_writer_fence() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    commit_domain(&store, 1);
    store
        .commit(intent("register"), |envelope| {
            envelope.register_outbox_consumer("search", 10)?;
            Ok("registered".to_string())
        })
        .unwrap();
    store.invalidate_writer_fence_for_test().unwrap();

    for kind in [
        store.prune_outbox().unwrap_err().kind(),
        store
            .acknowledge_outbox("search", 1, 11)
            .unwrap_err()
            .kind(),
        store
            .mark_outbox_published_through(1, 1)
            .unwrap_err()
            .kind(),
        store.run_staging_maintenance(1).unwrap_err().kind(),
        store.abandon_expired_staging_runs(1).unwrap_err().kind(),
        store.delete_aged_staging_runs(1).unwrap_err().kind(),
    ] {
        assert_eq!(kind, KernelErrorKind::FenceLost);
    }
}

#[test]
fn a_lookup_id_that_redaction_rewrites_cannot_alias_onto_another_consumer() {
    const AWS_KEY: &str = "AKIAFFFFFFFFFFFFFFFF";
    const REPLACEMENT: &str = "<AWS_ACCESS_KEY_ID_REDACTED>";

    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let first = commit_domain(&store, 1);
    commit_domain(&store, 2);
    // The literal replacement survives redaction unchanged, so registration accepts it.
    store
        .commit(intent("register-literal"), |envelope| {
            envelope.register_outbox_consumer(REPLACEMENT, 10)?;
            Ok("registered".to_string())
        })
        .unwrap();

    // Redacting this id yields exactly the registered id, which would advance a consumer
    // that has read nothing and let prune_outbox delete rows it never consumed.
    assert_eq!(
        store
            .acknowledge_outbox(AWS_KEY, first, 11)
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidInput
    );
    assert_eq!(
        store
            .commit(intent("deregister-alias"), |envelope| {
                envelope.deregister_outbox_consumer(AWS_KEY, 12)?;
                Ok("deregistered".to_string())
            })
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidInput
    );
    assert_eq!(
        inspect(directory.path())
            .query_row(
                "SELECT checkpoint_commit_seq FROM outbox_consumers WHERE consumer_id=?1",
                [REPLACEMENT],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
}
