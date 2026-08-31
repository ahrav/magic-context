#![cfg(feature = "test-support")]

use mc_store::kernel::{CommitIntent, DomainSpec, KernelErrorKind, KernelStore, Sensitivity};
use rusqlite::{Connection, OpenFlags};

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
        name: format!("name-{index}"),
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
fn consumer_insert_maps_only_constraint_failures_to_conflict() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("register-once"), |envelope| {
            envelope.register_outbox_consumer("search", 1)?;
            Ok("registered".to_string())
        })
        .unwrap();
    assert_eq!(
        store
            .commit(intent("register-twice"), |envelope| {
                envelope.register_outbox_consumer("search", 2)?;
                Ok("duplicate".to_string())
            })
            .unwrap_err()
            .kind(),
        KernelErrorKind::Conflict
    );

    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute_batch("DROP TABLE outbox_consumers")
        .unwrap();
    drop(connection);
    assert_eq!(
        store
            .commit(intent("register-io"), |envelope| {
                envelope.register_outbox_consumer("other", 3)?;
                Ok("unreachable".to_string())
            })
            .unwrap_err()
            .kind(),
        KernelErrorKind::Io
    );
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
                "SELECT COUNT(*) FROM scan_owner_copies
                 WHERE owner_kind='outbox' AND owner_commit_seq<=?1",
                [first],
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
            envelope.abandon_outbox_consumer("abandoned", "operator-1", "password=retired", 42)?;
            Ok("abandoned".to_string())
        })
        .unwrap();

    let connection = inspect(directory.path());
    let facts: (String, i64, String, String, i64) = connection
        .query_row(
            "SELECT consumer_id,last_checkpoint_commit_seq,operator_id,reason,abandoned_at
             FROM consumer_abandonments",
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
    assert!(facts.1 > 0);
    assert_eq!(facts.2, "operator-1");
    assert_eq!(facts.3, "password=<REDACTED:password>");
    assert_eq!(facts.4, 42);
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
    assert!(payload.contains("\"reason\":\"password=<REDACTED:password>\""));
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
            "INSERT INTO scan_batches(scan_batch_id,created_at)
             VALUES ('0123456789abcdef0123456789abcdef',1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO alignment_projection(
                 decision_id,observation_id,alignment_kind,scan_batch_id,built_through_commit_seq
              ) VALUES ('derived-decision','derived-observation','derived',
                        '0123456789abcdef0123456789abcdef',1)",
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
