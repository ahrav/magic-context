#[cfg(feature = "test-support")]
use mc_store::kernel::schema::apply_kernel_schema_with_fault_hook_for_test;
use mc_store::kernel::schema::{
    apply_kernel_connection_profile, apply_kernel_schema, kernel_schema_digest,
    kernel_schema_inventory, verify_kernel_connection_contract, KERNEL_APPLICATION_ID,
    KERNEL_SCHEMA_COMPONENT_NAMES,
};
use mc_store::sqlite_runtime::{DIRECT_FORMAT_EPOCH, MC_APPLICATION_ID};
use rusqlite::{params, Connection};

const EXPECTED_COMPONENTS: &[&str] = &[
    "commit_log",
    "change_event",
    "outbox",
    "outbox_publication",
    "operation_receipts",
    "durable_text_redactions",
    "alignment_projection_state",
    "writer_fence",
    "outbox_consumers",
    "deletion_backfill_barriers",
    "deletion_backfill_barrier_consumers",
    "consumer_abandonments",
    "capture_pins",
    "capture_pin_refs",
    "artifact_ingestion_reservations",
    "artifact_purge_tombstones",
    "artifact_pending_unlinks",
    "object_registry",
    "domains",
    "entities",
    "entity_aliases",
    "propositions",
    "predicate_schemas",
    "scopes",
    "scope_term",
    "anchors",
    "evidence_meta",
    "asserted_edges",
    "relation_registry",
    "extraction_runs",
    "candidates",
    "candidate_scores",
    "admission_decisions",
    "decisions",
    "decision_events",
    "observations",
    "observation_dependencies",
    "alignment_projection",
    "mc_kernel_format_marker",
];

fn open_profiled() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = Connection::open(dir.path().join("core.sqlite")).expect("open");
    apply_kernel_connection_profile(&mut conn, 5_000).expect("profile");
    (dir, conn)
}

/// Append a `commit_log` row and return its allocated `commit_seq`.
fn next_commit(conn: &Connection, transaction_id: &str) -> i64 {
    conn.execute(
        "INSERT INTO commit_log(
             transaction_id, writer_epoch, producer, operation_key, request_digest,
             recorded_at, actor, cause
         ) VALUES (?1, 1, 'fixture', ?1, '', 1, 'test', 'fixture')",
        [transaction_id],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// Bootstrap the registry/domain cycle so later fixtures have a valid domain.
fn seed_root_domain(conn: &mut Connection) -> i64 {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    tx.execute(
        "INSERT INTO commit_log(
             transaction_id, writer_epoch, producer, operation_key, request_digest,
             recorded_at, actor, cause
         ) VALUES ('tx-root', 1, 'fixture', 'tx-root', '', 1, 'test', 'root')",
        [],
    )
    .unwrap();
    let commit_seq = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO domains(domain_id, object_id, name, created_commit_seq, sensitivity_class)
         VALUES ('domain-1', 'object-domain-1', 'root', ?1, 'internal')",
        [commit_seq],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO object_registry(
             object_id, object_kind, domain_id, source_kind, source_id, source_revision,
             created_commit_seq, sensitivity_class
         ) VALUES ('object-domain-1', 'domain', 'domain-1', 'test', 'root', 1, ?1, 'internal')",
        [commit_seq],
    )
    .unwrap();
    tx.commit().unwrap();
    commit_seq
}

/// Register a canonical object so a typed row can reference it.
fn seed_object(conn: &Connection, object_id: &str, object_kind: &str, commit_seq: i64) {
    conn.execute(
        "INSERT INTO object_registry(
             object_id, object_kind, domain_id, source_kind, source_id, source_revision,
             created_commit_seq, sensitivity_class
         ) VALUES (?1, ?2, 'domain-1', 'test', ?1, 1, ?3, 'internal')",
        params![object_id, object_kind, commit_seq],
    )
    .unwrap();
}

#[test]
fn kernel_schema_has_one_ordered_full_shape() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).expect("bootstrap");

    assert_eq!(KERNEL_SCHEMA_COMPONENT_NAMES, EXPECTED_COMPONENTS);
    assert_eq!(kernel_schema_inventory(&conn).unwrap(), EXPECTED_COMPONENTS);
    assert_eq!(
        conn.query_row("PRAGMA application_id", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        KERNEL_APPLICATION_ID
    );
    assert_eq!(
        conn.query_row(
            "SELECT schema_digest FROM mc_kernel_format_marker",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        kernel_schema_digest(&conn).unwrap()
    );
    assert!(kernel_schema_inventory(&conn)
        .unwrap()
        .iter()
        .all(|name| !name.starts_with("sqlite_")));
}

const INCARNATION: &str = "0123456789abcdef0123456789abcdef";

const PINNED_SCHEMA_DIGEST: &str =
    "0ba154ed8894bb37d797bed095e0d72c99b6643c671740c725fdca4aecfcc95a";

#[test]
fn cas_control_tables_and_lookup_indexes_are_frozen() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    for (table, expected_columns) in [
        (
            "artifact_ingestion_reservations",
            &[
                "reservation_id",
                "artifact_digest",
                "artifact_reference",
                "state",
                "writer_epoch",
                "created_at",
                "heartbeat_at",
                "lease_expires_at",
                "reclaim_started_at",
            ][..],
        ),
        (
            "artifact_purge_tombstones",
            &[
                "artifact_digest",
                "artifact_reference",
                "operator_id",
                "reason",
                "purged_at",
                "commit_seq",
            ][..],
        ),
        (
            "artifact_pending_unlinks",
            &[
                "artifact_digest",
                "artifact_reference",
                "created_at",
                "last_attempt_at",
                "attempt_count",
            ][..],
        ),
        (
            "deletion_backfill_barriers",
            &[
                "barrier_id",
                "artifact_digest",
                "artifact_reference",
                "delete_commit_seq",
                "created_at",
                "completed_at",
            ][..],
        ),
        (
            "deletion_backfill_barrier_consumers",
            &[
                "barrier_id",
                "consumer_id",
                "required_checkpoint_commit_seq",
                "acknowledged_at",
            ][..],
        ),
    ] {
        let columns = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(columns, expected_columns, "unexpected columns for {table}");
    }

    let capture_pin_columns = conn
        .prepare("PRAGMA table_info(capture_pins)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(capture_pin_columns.contains(&"purge_degraded_at".to_string()));
    assert!(capture_pin_columns.contains(&"purge_barrier_id".to_string()));

    let abandonment_columns = conn
        .prepare("PRAGMA table_info(consumer_abandonments)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(abandonment_columns.contains(&"barrier_id".to_string()));

    let indexes = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type='index' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for index in [
        "idx_evidence_artifact_digest",
        "idx_evidence_artifact_reference",
        "idx_reservations_digest",
        "idx_reservations_reference",
        "idx_reservations_reclaim",
        "idx_pending_unlinks_created",
        "idx_purge_tombstones_reference",
        "idx_purge_tombstones_commit_fk",
        "idx_deletion_barriers_commit",
        "idx_deletion_barriers_incomplete",
        "idx_deletion_barriers_open",
        "idx_deletion_barrier_consumers_checkpoint",
        "idx_abandonments_barrier_fk",
        "idx_capture_pins_purge_degraded",
        "idx_capture_pins_purge_barrier_fk",
    ] {
        assert!(indexes.iter().any(|name| name == index), "missing {index}");
    }
}

#[test]
fn cas_control_rows_preserve_reclaim_purge_and_backfill_state() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let commit_seq = next_commit(&conn, "purge-commit");

    assert!(conn
        .execute(
            "INSERT INTO artifact_ingestion_reservations(
                 reservation_id,artifact_digest,artifact_reference,state,writer_epoch,
                 created_at,heartbeat_at,lease_expires_at
             ) VALUES ('bad','digest','ref','Expired',7,1,1,2)",
            [],
        )
        .is_err());
    conn.execute(
        "INSERT INTO artifact_ingestion_reservations(
             reservation_id,artifact_digest,artifact_reference,state,writer_epoch,
             created_at,heartbeat_at,lease_expires_at
         ) VALUES ('reservation-1','digest','ref','Live',7,1,1,2)",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE artifact_ingestion_reservations
         SET state='Reclaiming',reclaim_started_at=3 WHERE reservation_id='reservation-1'",
        [],
    )
    .unwrap();
    assert!(conn
        .execute(
            "UPDATE artifact_ingestion_reservations
             SET artifact_reference='retargeted' WHERE reservation_id='reservation-1'",
            [],
        )
        .is_err());
    conn.execute(
        "UPDATE artifact_ingestion_reservations
         SET heartbeat_at=4,lease_expires_at=6 WHERE reservation_id='reservation-1'",
        [],
    )
    .unwrap();
    assert!(conn
        .execute(
            "UPDATE artifact_ingestion_reservations
             SET state='Live',reclaim_started_at=NULL WHERE reservation_id='reservation-1'",
            [],
        )
        .is_err());

    conn.execute(
        "INSERT INTO artifact_purge_tombstones(
             artifact_digest,artifact_reference,operator_id,reason,purged_at,commit_seq
         ) VALUES ('digest','ref','operator-1','secret',4,?1)",
        [commit_seq],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO artifact_pending_unlinks(
             artifact_digest,artifact_reference,created_at
         ) VALUES ('digest','ref',4)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO deletion_backfill_barriers(
             barrier_id,artifact_digest,artifact_reference,delete_commit_seq,created_at
         ) VALUES ('barrier-1','digest','ref',?1,4)",
        [commit_seq],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO outbox_consumers(consumer_id,checkpoint_commit_seq,updated_at)
         VALUES ('search',?1,5)",
        [commit_seq],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO deletion_backfill_barrier_consumers(
             barrier_id,consumer_id,required_checkpoint_commit_seq
         ) VALUES ('barrier-1','search',?1)",
        [commit_seq],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM outbox_consumers WHERE consumer_id='search'",
        [],
    )
    .unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM deletion_backfill_barrier_consumers",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        1
    );

    conn.execute(
        "INSERT INTO consumer_abandonments(
             abandonment_id,consumer_id,barrier_id,operator_id,last_checkpoint_commit_seq,
             reason,abandoned_at,commit_seq
         ) VALUES ('abandon-1','search','barrier-1','operator-1',?1,'retired',6,?1)",
        [commit_seq],
    )
    .unwrap();
    assert!(conn
        .execute(
            "INSERT INTO capture_pins(
                 capture_pin_id,pin_kind,owner_id,commit_seq,lease_epoch,writer_epoch,
                 created_at,purge_degraded_at
             ) VALUES ('bad-pin','backup','backup-1',?1,1,7,7,8)",
            [commit_seq],
        )
        .is_err());
    conn.execute(
        "INSERT INTO capture_pins(
             capture_pin_id,pin_kind,owner_id,commit_seq,lease_epoch,writer_epoch,
             created_at,purge_degraded_at,purge_barrier_id
         ) VALUES ('pin-1','backup','backup-1',?1,1,7,7,8,'barrier-1')",
        [commit_seq],
    )
    .unwrap();
    assert!(conn
        .execute(
            "UPDATE capture_pins SET purge_degraded_at=NULL,purge_barrier_id=NULL
             WHERE capture_pin_id='pin-1'",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "DELETE FROM artifact_purge_tombstones WHERE artifact_digest='digest'",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "UPDATE artifact_purge_tombstones SET reason='rewritten' WHERE artifact_digest='digest'",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "INSERT INTO artifact_purge_tombstones(
                 artifact_digest,artifact_reference,operator_id,reason,purged_at,commit_seq
             ) VALUES ('digest-2','ref','operator-1','secret',5,?1)",
            [commit_seq],
        )
        .is_err());
    conn.execute(
        "INSERT INTO artifact_purge_tombstones(
             artifact_digest,artifact_reference,operator_id,reason,purged_at,commit_seq
         ) VALUES ('digest-3','ref-3','operator-1','secret',5,?1)",
        [commit_seq],
    )
    .unwrap();
    assert!(conn
        .execute(
            "INSERT INTO artifact_pending_unlinks(
                 artifact_digest,artifact_reference,created_at
             ) VALUES ('digest-3','wrong-ref',5)",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "INSERT INTO deletion_backfill_barriers(
                 barrier_id,artifact_digest,artifact_reference,delete_commit_seq,created_at
             ) VALUES ('mismatched','digest-3','not-ref-3',?1,6)",
            [commit_seq],
        )
        .is_err());
    assert!(conn
        .execute(
            "INSERT INTO artifact_ingestion_reservations(
                 reservation_id,artifact_digest,artifact_reference,state,writer_epoch,
                 created_at,heartbeat_at,lease_expires_at
             ) VALUES ('revive-purged','digest','fresh-ref','Live',7,9,9,10)",
            [],
        )
        .is_err());
    conn.execute(
        "INSERT INTO artifact_ingestion_reservations(
             reservation_id,artifact_digest,artifact_reference,state,writer_epoch,
             created_at,heartbeat_at,lease_expires_at
         ) VALUES ('live-4','digest-4','ref-4','Live',7,9,9,10)",
        [],
    )
    .unwrap();
    assert!(conn
        .execute(
            "INSERT INTO artifact_purge_tombstones(
                 artifact_digest,artifact_reference,operator_id,reason,purged_at,commit_seq
             ) VALUES ('digest-4','ref-4','operator-1','secret',9,?1)",
            [commit_seq],
        )
        .is_err());
    assert!(conn
        .execute(
            "UPDATE artifact_pending_unlinks SET artifact_reference='retargeted'
             WHERE artifact_digest='digest'",
            [],
        )
        .is_err());
    conn.execute(
        "UPDATE artifact_pending_unlinks SET last_attempt_at=9,attempt_count=1
         WHERE artifact_digest='digest'",
        [],
    )
    .unwrap();
}

#[test]
fn plain_delete_backfill_barrier_does_not_require_a_purge_tombstone() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let commit_seq = next_commit(&conn, "plain-delete");

    conn.execute(
        "INSERT INTO deletion_backfill_barriers(
             barrier_id,artifact_digest,artifact_reference,delete_commit_seq,created_at
         ) VALUES ('plain-barrier','plain-digest','plain-ref',?1,2)",
        [commit_seq],
    )
    .expect("plain deletion must create a barrier without a purge tombstone");
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM artifact_purge_tombstones",
            [],
            |row| { row.get::<_, i64>(0) }
        )
        .unwrap(),
        0
    );

    assert!(
        conn.execute(
            "INSERT INTO artifact_purge_tombstones(
                 artifact_digest,artifact_reference,operator_id,reason,purged_at,commit_seq
             ) VALUES ('plain-digest','other-ref','operator-1','secret',3,?1)",
            [commit_seq],
        )
        .is_err(),
        "a tombstone must match the open barrier reference"
    );

    assert!(
        conn.execute(
            "INSERT INTO deletion_backfill_barriers(
                 barrier_id,artifact_digest,artifact_reference,delete_commit_seq,created_at
             ) VALUES ('second-open','plain-digest','plain-ref',?1,3)",
            [commit_seq],
        )
        .is_err(),
        "one open barrier per digest"
    );
    conn.execute(
        "UPDATE deletion_backfill_barriers SET completed_at=4 WHERE barrier_id='plain-barrier'",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO deletion_backfill_barriers(
             barrier_id,artifact_digest,artifact_reference,delete_commit_seq,created_at
         ) VALUES ('second-cycle','plain-digest','plain-ref',?1,5)",
        [commit_seq],
    )
    .expect("a re-ingested digest must accept a new barrier after completion");
}

#[test]
fn kernel_schema_digest_is_pinned_to_the_frozen_v1_shape() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).expect("bootstrap");
    assert_eq!(kernel_schema_digest(&conn).unwrap(), PINNED_SCHEMA_DIGEST);
}

#[test]
fn kernel_profile_is_strict_and_verified() {
    let (_dir, conn) = open_profiled();
    assert_eq!(
        verify_kernel_connection_contract(&conn, 5_000).unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn first_root_transaction_resolves_deferred_registry_cycle() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    let tx = conn.transaction().unwrap();
    tx.execute(
        "INSERT INTO commit_log(
             transaction_id, writer_epoch, producer, operation_key, request_digest,
             recorded_at, actor, cause
         ) VALUES ('tx-1', 7, 'fixture', 'tx-1', '', 1000, 'test', 'root')",
        [],
    )
    .unwrap();
    let commit_seq = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO domains(domain_id, object_id, name, created_commit_seq, sensitivity_class)
         VALUES ('domain-1', 'object-1', 'root', ?1, 'internal')",
        [commit_seq],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO object_registry(
             object_id, object_kind, domain_id, source_kind, source_id, source_revision,
             created_commit_seq, sensitivity_class
         ) VALUES ('object-1', 'domain', 'domain-1', 'test', 'root', 1, ?1, 'internal')",
        [commit_seq],
    )
    .unwrap();
    tx.commit().unwrap();
}

#[test]
fn candidate_delete_cascades_scores_but_preserves_admission_audit() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    conn.execute(
        "INSERT INTO extraction_runs(
             extraction_run_id, extractor, sensitivity_class, provenance_witness,
             redaction_metadata, started_at, heartbeat_at, lease_expires_at
         ) VALUES ('run-1', 'test', 'internal', X'01', X'7b7d', 1, 2, 3)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO candidates(
             candidate_id, extraction_run_id, candidate_kind, payload, sensitivity_class,
             provenance_witness, redaction_metadata, created_at, heartbeat_at, lease_expires_at
         ) VALUES ('candidate-1', 'run-1', 'proposition', X'02', 'internal', X'03', X'7b7d', 1, 2, 3)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO candidate_scores(candidate_id, scorer, score, scored_at)
         VALUES ('candidate-1', 'test', 1.0, 4)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO admission_decisions(
             admission_decision_id, candidate_id, source_kind, source_id, source_revision,
             source_class, taint_class, maturity, disposition, visibility, policy_revision,
             reason, decided_at
         ) VALUES ('admission-1', 'candidate-1', 'test', 'root', 1, 'test', 'test',
                   'candidate', 'accepted', 'explicit', 1, 'fixture', 5)",
        [],
    )
    .unwrap();

    conn.execute(
        "DELETE FROM candidates WHERE candidate_id = 'candidate-1'",
        [],
    )
    .unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM candidate_scores", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT candidate_id FROM admission_decisions WHERE admission_decision_id = 'admission-1'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap(),
        None
    );
}

#[cfg(feature = "test-support")]
#[test]
fn late_bootstrap_failure_leaves_no_partial_schema() {
    let (_dir, mut conn) = open_profiled();
    let error = apply_kernel_schema_with_fault_hook_for_test(&mut conn, INCARNATION, 1_000, || {
        Err(rusqlite::Error::InvalidQuery)
    })
    .expect_err("fault must abort bootstrap");
    assert!(matches!(error, rusqlite::Error::InvalidQuery));
    assert_eq!(
        kernel_schema_inventory(&conn).unwrap(),
        Vec::<String>::new()
    );
    assert_eq!(
        conn.query_row("PRAGMA application_id", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        0
    );
}

#[test]
fn consumers_checkpoint_independent_outbox_positions() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    conn.execute(
        "INSERT INTO commit_log(
             transaction_id, writer_epoch, producer, operation_key, request_digest,
             recorded_at, actor, cause
         ) VALUES ('tx-1', 7, 'fixture', 'tx-1', '', 1, 'test', 'outbox')",
        [],
    )
    .unwrap();
    let commit_seq = conn.last_insert_rowid();
    for ordinal in 0..2 {
        conn.execute(
            "INSERT INTO outbox(
                 commit_seq, ordinal, object_id, object_kind, source_kind, source_id,
                 source_revision, sensitivity_class, payload, created_at
             ) VALUES (?1, ?2, 'object-1', 'test', 'test', 'root', 1, 'internal', X'01', 2)",
            params![commit_seq, ordinal],
        )
        .unwrap();
    }
    let latest_position = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO outbox_consumers(consumer_id, checkpoint_commit_seq, updated_at)
         VALUES ('search', ?1, 3), ('mirror', 0, 3)",
        params![latest_position - 1],
    )
    .unwrap();

    conn.execute(
        "UPDATE outbox_consumers SET checkpoint_commit_seq = ?1
         WHERE consumer_id = 'search'",
        params![latest_position],
    )
    .unwrap();

    let checkpoint = |conn: &Connection, consumer: &str| -> i64 {
        conn.query_row(
            "SELECT checkpoint_commit_seq FROM outbox_consumers WHERE consumer_id = ?1",
            [consumer],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(checkpoint(&conn, "search"), latest_position);
    assert_eq!(checkpoint(&conn, "mirror"), 0);
    assert_eq!(
        conn.query_row(
            "SELECT MIN(checkpoint_commit_seq) FROM outbox_consumers",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        0
    );
}

#[test]
fn every_kernel_table_is_strict_and_enforces_types_and_foreign_keys() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT name, sql FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        )
        .unwrap();
    let tables = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(tables.len(), EXPECTED_COMPONENTS.len());
    for (name, sql) in tables {
        assert!(sql.ends_with(" STRICT"), "{name} is not STRICT: {sql}");
    }

    assert!(conn
        .execute(
            "UPDATE writer_fence SET writer_epoch = 'not-an-integer' WHERE id = 0",
            []
        )
        .is_err());
    assert!(conn
        .execute(
            "INSERT INTO outbox(
                 commit_seq, ordinal, object_id, object_kind, source_kind, source_id,
                 source_revision, sensitivity_class, payload, created_at
             ) VALUES (999, 0, 'missing', 'test', 'test', 'missing', 1, 'internal', X'01', 1)",
            [],
        )
        .is_err());
}

#[test]
fn normal_synchronous_mode_fails_kernel_verification() {
    let (_dir, conn) = open_profiled();
    conn.pragma_update(None, "synchronous", "NORMAL").unwrap();
    assert_eq!(
        verify_kernel_connection_contract(&conn, 5_000).unwrap(),
        vec!["synchronous mode 1 is not FULL or EXTRA [2, 3]".to_string()]
    );
}

#[test]
fn trusted_schema_on_fails_kernel_verification() {
    let (_dir, conn) = open_profiled();
    conn.pragma_update(None, "trusted_schema", "ON").unwrap();
    assert_eq!(
        verify_kernel_connection_contract(&conn, 5_000).unwrap(),
        vec!["trusted_schema is enabled".to_string()]
    );
}

#[test]
fn commit_receipt_and_change_identity_shapes_are_not_overconstrained() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    conn.execute(
        "INSERT INTO commit_log(
             transaction_id, writer_epoch, producer, operation_key, request_digest,
             recorded_at, actor, cause
         ) VALUES ('tx-identity', 42, 'fixture', 'tx-identity', '', 1, 'test', 'identity')",
        [],
    )
    .unwrap();
    let commit_seq = conn.last_insert_rowid();
    assert_eq!(
        conn.query_row(
            "SELECT writer_epoch FROM commit_log WHERE commit_seq = ?1",
            [commit_seq],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        42
    );

    for (receipt_id, producer) in [("receipt-a", "producer-a"), ("receipt-b", "producer-b")] {
        conn.execute(
            "INSERT INTO operation_receipts(
                 receipt_id, producer, operation_key, request_digest, commit_seq,
                 result_payload, created_at
             ) VALUES (?1, ?2, 'shared-key', 'digest-1', ?3, X'01', 2)",
            params![receipt_id, producer, commit_seq],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO change_event(
             commit_seq, ordinal, object_id, change_kind, idempotency_key
         ) VALUES (?1, 0, 'object-a', 'create', 'shared-operation')",
        [commit_seq],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO change_event(
             commit_seq, ordinal, object_id, change_kind, idempotency_key
         ) VALUES (?1, 1, 'object-b', 'create', 'shared-operation')",
        [commit_seq],
    )
    .unwrap();
}

#[test]
fn abandonment_audit_survives_consumer_deletion() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    conn.execute(
        "INSERT INTO outbox_consumers(consumer_id, checkpoint_commit_seq, updated_at)
         VALUES ('search', 9, 10)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO commit_log(
             transaction_id, writer_epoch, producer, operation_key, request_digest,
             recorded_at, actor, cause
         ) VALUES ('tx-abandon', 7, 'fixture', 'tx-abandon', '', 10, 'operator-1', 'abandonment')",
        [],
    )
    .unwrap();
    let commit_seq = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO consumer_abandonments(
             abandonment_id, consumer_id, operator_id, last_checkpoint_commit_seq,
             reason, commit_seq, abandoned_at
         ) VALUES ('abandon-1', 'search', 'operator-1', 9, 'retired', ?1, 11)",
        [commit_seq],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM outbox_consumers WHERE consumer_id = 'search'",
        [],
    )
    .unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM consumer_abandonments", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        1
    );
}

#[test]
fn superseded_predicate_schema_replacement_reuses_its_name() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let created = seed_root_domain(&mut conn);

    seed_object(&conn, "object-pred-1", "predicate_schema", created);
    conn.execute(
        "INSERT INTO predicate_schemas(
             predicate_schema_id, object_id, domain_id, predicate_name, value_schema,
             freshness_class, created_commit_seq, sensitivity_class
         ) VALUES ('pred-1', 'object-pred-1', 'domain-1', 'owner', X'01', 'stable', ?1,
                   'internal')",
        [created],
    )
    .unwrap();

    // R8 correction: bind the predecessor's invalidation and append a successor
    // that keeps the same domain-scoped predicate name.
    let corrected = next_commit(&conn, "tx-correct");
    seed_object(&conn, "object-pred-2", "predicate_schema", corrected);
    conn.execute(
        "UPDATE predicate_schemas
            SET invalidated_commit_seq = ?1, superseded_by = 'object-pred-2'
          WHERE predicate_schema_id = 'pred-1'",
        [corrected],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO predicate_schemas(
             predicate_schema_id, object_id, domain_id, predicate_name, value_schema,
             freshness_class, created_commit_seq, sensitivity_class
         ) VALUES ('pred-2', 'object-pred-2', 'domain-1', 'owner', X'02', 'stable', ?1,
                   'internal')",
        [corrected],
    )
    .expect("successor must reuse the invalidated predicate name");

    // Exactly one active row may hold the name at a time.
    let third = next_commit(&conn, "tx-third");
    seed_object(&conn, "object-pred-3", "predicate_schema", third);
    assert!(conn
        .execute(
            "INSERT INTO predicate_schemas(
                 predicate_schema_id, object_id, domain_id, predicate_name, value_schema,
                 freshness_class, created_commit_seq, sensitivity_class
             ) VALUES ('pred-3', 'object-pred-3', 'domain-1', 'owner', X'03', 'stable', ?1,
                       'internal')",
            [third],
        )
        .is_err());
}

#[test]
fn superseded_domain_and_relation_names_are_reusable_once_invalidated() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let created = seed_root_domain(&mut conn);
    let corrected = next_commit(&conn, "tx-correct");

    conn.execute(
        "UPDATE domains SET invalidated_commit_seq = ?1 WHERE domain_id = 'domain-1'",
        [corrected],
    )
    .unwrap();
    seed_object(&conn, "object-domain-2", "domain", corrected);
    conn.execute(
        "INSERT INTO domains(domain_id, object_id, name, created_commit_seq, sensitivity_class)
         VALUES ('domain-2', 'object-domain-2', 'root', ?1, 'internal')",
        [corrected],
    )
    .expect("successor domain must reuse the invalidated name");

    seed_object(&conn, "object-rel-1", "relation", created);
    conn.execute(
        "INSERT INTO relation_registry(
             relation_id, object_id, relation_name, source_kind, target_kind, symmetry,
             cardinality, created_commit_seq, invalidated_commit_seq, sensitivity_class
         ) VALUES ('rel-1', 'object-rel-1', 'depends_on', 'entity', 'entity', 'directed',
                   'many_to_many', ?1, ?2, 'internal')",
        params![created, corrected],
    )
    .unwrap();
    seed_object(&conn, "object-rel-2", "relation", corrected);
    conn.execute(
        "INSERT INTO relation_registry(
             relation_id, object_id, relation_name, source_kind, target_kind, symmetry,
             cardinality, created_commit_seq, sensitivity_class
         ) VALUES ('rel-2', 'object-rel-2', 'depends_on', 'entity', 'entity', 'directed',
                   'many_to_many', ?1, 'internal')",
        [corrected],
    )
    .expect("successor relation must reuse the invalidated name");
}

#[test]
fn inverted_and_empty_validity_intervals_are_refused() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let created = seed_root_domain(&mut conn);
    let later = next_commit(&conn, "tx-later");

    seed_object(&conn, "object-entity-1", "entity", later);
    let insert_entity = |invalidated: i64| {
        conn.execute(
            "INSERT INTO entities(
                 entity_id, object_id, domain_id, entity_kind, canonical_name,
                 created_commit_seq, invalidated_commit_seq, sensitivity_class
             ) VALUES ('entity-1', 'object-entity-1', 'domain-1', 'service', 'api', ?1, ?2,
                       'internal')",
            params![later, invalidated],
        )
    };
    // Inverted: invalidation precedes creation.
    assert!(insert_entity(created).is_err());
    // Empty: `created <= N < invalidated` selects no snapshot.
    assert!(insert_entity(later).is_err());

    let after = next_commit(&conn, "tx-after");
    insert_entity(after).expect("invalidation after creation is a legal interval");
}

#[test]
fn format_marker_rejects_update_and_delete() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    assert!(conn
        .execute(
            "UPDATE mc_kernel_format_marker SET format_epoch = 2 WHERE singleton = 1",
            [],
        )
        .is_err());
    assert!(conn
        .execute("UPDATE mc_kernel_format_marker SET schema_digest = 'x'", [])
        .is_err());
    assert!(conn
        .execute("DELETE FROM mc_kernel_format_marker", [])
        .is_err());

    let (epoch, incarnation): (i64, String) = conn
        .query_row(
            "SELECT format_epoch, database_incarnation_id FROM mc_kernel_format_marker",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(epoch, 1);
    assert_eq!(incarnation, INCARNATION);
}

#[test]
fn one_source_revision_admits_many_objects_of_one_kind() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let created = seed_root_domain(&mut conn);

    // One extraction over one file revision yields many propositions; object
    // identity is the object id, not the source triple.
    for object_id in ["object-prop-1", "object-prop-2"] {
        conn.execute(
            "INSERT INTO object_registry(
                 object_id, object_kind, domain_id, source_kind, source_id, source_revision,
                 created_commit_seq, sensitivity_class
             ) VALUES (?1, 'proposition', 'domain-1', 'file', 'src/lib.rs', 7, ?2, 'internal')",
            params![object_id, created],
        )
        .expect("a source revision may yield many objects of one kind");
    }
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM object_registry WHERE object_kind = 'proposition'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        2
    );
}

#[test]
fn canonical_evidence_delete_is_refused_while_referenced() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let created = seed_root_domain(&mut conn);

    seed_object(&conn, "object-ev-1", "evidence", created);
    conn.execute(
        "INSERT INTO evidence_meta(
             evidence_id, object_id, artifact_reference, artifact_digest, byte_length,
             media_type, retention_class, provider_egress_class, redaction_metadata,
             created_commit_seq, sensitivity_class
         ) VALUES ('ev-1', 'object-ev-1', 'cas://a', 'digest-a', 3, 'text/plain', 'standard',
                   'internal', X'7b7d', ?1, 'internal')",
        [created],
    )
    .unwrap();
    seed_object(&conn, "object-obs-1", "observation", created);
    conn.execute(
        "INSERT INTO observations(
             observation_id, object_id, evidence_id, observation_kind, observation_payload,
             observed_at, created_commit_seq, sensitivity_class
         ) VALUES ('obs-1', 'object-obs-1', 'ev-1', 'measured', X'01', 5, ?1, 'internal')",
        [created],
    )
    .unwrap();

    // R8 forbids canonical DELETE; RESTRICT refuses rather than silently
    // nulling the link and losing the historical association.
    assert!(conn
        .execute("DELETE FROM evidence_meta WHERE evidence_id = 'ev-1'", [])
        .is_err());
    assert_eq!(
        conn.query_row(
            "SELECT evidence_id FROM observations WHERE observation_id = 'obs-1'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap(),
        Some("ev-1".to_string())
    );
}

#[test]
fn kernel_stamps_the_shared_direct_format_application_id() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    assert_eq!(KERNEL_APPLICATION_ID, MC_APPLICATION_ID);
    assert_eq!(
        conn.query_row("PRAGMA application_id", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        MC_APPLICATION_ID
    );
    // The marker table, not the application id, decides the family.
    assert!(kernel_schema_inventory(&conn)
        .unwrap()
        .contains(&"mc_kernel_format_marker".to_string()));
}

#[test]
fn commit_log_rejects_update_and_delete() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let commit_seq = next_commit(&conn, "tx-audit");

    assert!(conn
        .execute(
            "UPDATE commit_log SET actor = 'someone-else' WHERE commit_seq = ?1",
            [commit_seq],
        )
        .is_err());
    assert!(conn
        .execute(
            "UPDATE commit_log SET writer_epoch = 99 WHERE commit_seq = ?1",
            [commit_seq],
        )
        .is_err());
    assert!(conn
        .execute("DELETE FROM commit_log WHERE commit_seq = ?1", [commit_seq])
        .is_err());
    assert_eq!(
        conn.query_row(
            "SELECT actor FROM commit_log WHERE commit_seq = ?1",
            [commit_seq],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "test"
    );
}

#[test]
fn consumer_checkpoints_advance_but_never_retreat() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    conn.execute(
        "INSERT INTO outbox_consumers(consumer_id, checkpoint_commit_seq, updated_at)
         VALUES ('search', 5, 1)",
        [],
    )
    .unwrap();

    conn.execute(
        "UPDATE outbox_consumers SET checkpoint_commit_seq = 9 WHERE consumer_id = 'search'",
        [],
    )
    .expect("forward advance is legal");
    assert!(conn
        .execute(
            "UPDATE outbox_consumers SET checkpoint_commit_seq = 4
              WHERE consumer_id = 'search'",
            [],
        )
        .is_err());
    // Re-acknowledging the same position stays legal.
    conn.execute(
        "UPDATE outbox_consumers SET checkpoint_commit_seq = 9, updated_at = 2
          WHERE consumer_id = 'search'",
        [],
    )
    .expect("idempotent re-acknowledgement is legal");
    assert_eq!(
        conn.query_row(
            "SELECT checkpoint_commit_seq FROM outbox_consumers WHERE consumer_id = 'search'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        9
    );
}

#[test]
fn staging_leases_must_outlive_their_heartbeat() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    let insert_run = |lease_expires_at: i64| {
        conn.execute(
            "INSERT INTO extraction_runs(
                 extraction_run_id, extractor, sensitivity_class, provenance_witness,
                 redaction_metadata, started_at, heartbeat_at, lease_expires_at
             ) VALUES ('run-1', 'test', 'internal', X'01', X'7b7d', 1, 10, ?1)",
            [lease_expires_at],
        )
    };
    assert!(insert_run(9).is_err(), "expired-on-write lease is refused");
    assert!(insert_run(10).is_err(), "zero-length lease is refused");
    insert_run(11).expect("a lease outliving its heartbeat is legal");

    assert!(conn
        .execute(
            "INSERT INTO candidates(
                 candidate_id, extraction_run_id, candidate_kind, payload, sensitivity_class,
                 provenance_witness, redaction_metadata, created_at, heartbeat_at,
                 lease_expires_at
             ) VALUES ('candidate-1', 'run-1', 'proposition', X'02', 'internal', X'03',
                       X'7b7d', 1, 10, 10)",
            [],
        )
        .is_err());
}

#[test]
fn bootstrap_refuses_a_database_holding_foreign_objects() {
    let (_dir, mut conn) = open_profiled();
    conn.execute_batch("CREATE TABLE legacy_notes(id INTEGER PRIMARY KEY, body TEXT);")
        .unwrap();

    apply_kernel_schema(&mut conn, INCARNATION, 1_000)
        .expect_err("a non-pristine database must not be stamped as a kernel format");

    // Nothing stamped, nothing destroyed.
    assert_eq!(
        conn.query_row("PRAGMA application_id", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        kernel_schema_inventory(&conn).unwrap(),
        vec!["legacy_notes".to_string()]
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM legacy_notes", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn invalidated_alias_can_be_reintroduced_for_the_same_entity() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let created = seed_root_domain(&mut conn);

    seed_object(&conn, "object-entity-1", "entity", created);
    conn.execute(
        "INSERT INTO entities(
             entity_id, object_id, domain_id, entity_kind, canonical_name,
             created_commit_seq, sensitivity_class
         ) VALUES ('entity-1', 'object-entity-1', 'domain-1', 'service', 'api', ?1, 'internal')",
        [created],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO entity_aliases(
             entity_id, alias, alias_kind, created_commit_seq, sensitivity_class
         ) VALUES ('entity-1', 'api-svc', 'short', ?1, 'internal')",
        [created],
    )
    .unwrap();

    // A second active row for the same alias is still refused.
    let retired = next_commit(&conn, "tx-retire");
    assert!(conn
        .execute(
            "INSERT INTO entity_aliases(
                 entity_id, alias, alias_kind, created_commit_seq, sensitivity_class
             ) VALUES ('entity-1', 'api-svc', 'short', ?1, 'internal')",
            [retired],
        )
        .is_err());

    conn.execute(
        "UPDATE entity_aliases SET invalidated_commit_seq = ?1
          WHERE entity_id = 'entity-1' AND alias = 'api-svc' AND alias_kind = 'short'",
        [retired],
    )
    .unwrap();
    let revived = next_commit(&conn, "tx-revive");
    conn.execute(
        "INSERT INTO entity_aliases(
             entity_id, alias, alias_kind, created_commit_seq, sensitivity_class
         ) VALUES ('entity-1', 'api-svc', 'short', ?1, 'internal')",
        [revived],
    )
    .expect("an invalidated alias must be reintroducible");

    // Both intervals are retained, so history survives the reintroduction.
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM entity_aliases WHERE alias = 'api-svc'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        2
    );
}

#[test]
fn canonical_parents_refuse_deletion_instead_of_cascading() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let created = seed_root_domain(&mut conn);

    seed_object(&conn, "object-decision-1", "decision", created);
    conn.execute(
        "INSERT INTO decisions(
             decision_id, object_id, decision_kind, decision_payload, created_commit_seq,
             sensitivity_class
         ) VALUES ('decision-1', 'object-decision-1', 'accept', X'01', ?1, 'internal')",
        [created],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO decision_events(
             decision_id, event_ordinal, commit_seq, event_kind, event_payload, recorded_at
         ) VALUES ('decision-1', 0, ?1, 'opened', X'02', 5)",
        [created],
    )
    .unwrap();

    // Cascading would destroy canonical event history while the registry row
    // still claims the decision exists.
    assert!(conn
        .execute("DELETE FROM decisions WHERE decision_id = 'decision-1'", [])
        .is_err());
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM decision_events", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn writer_fence_singleton_cannot_be_deleted() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    assert!(conn.execute("DELETE FROM writer_fence", []).is_err());
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM writer_fence", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn staging_terminal_state_and_timestamp_are_set_together() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    let insert_run = |id: &str, state: Option<&str>, at: Option<i64>| {
        conn.execute(
            "INSERT INTO extraction_runs(
                 extraction_run_id, extractor, sensitivity_class, provenance_witness,
                 redaction_metadata, started_at, heartbeat_at, lease_expires_at,
                 terminal_state, terminal_at
             ) VALUES (?1, 'test', 'internal', X'01', X'7b7d', 1, 10, 20, ?2, ?3)",
            params![id, state, at],
        )
    };
    // R10 starts the retention clock at completion, so a terminal row needs one.
    assert!(insert_run("run-a", Some("completed"), None).is_err());
    assert!(insert_run("run-b", None, Some(30)).is_err());
    insert_run("run-c", None, None).expect("a live run has neither");
    insert_run("run-d", Some("completed"), Some(30)).expect("a terminal run has both");
}

#[test]
fn bootstrap_refuses_a_header_only_database() {
    let (_dir, mut conn) = open_profiled();
    // No schema objects, so the inventory check alone would pass this file.
    conn.pragma_update(None, "application_id", 0x4D43_5458_i64)
        .unwrap();

    apply_kernel_schema(&mut conn, INCARNATION, 1_000)
        .expect_err("a header-stamped file is not pristine");
    assert_eq!(
        conn.query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0x4D43_5458_i64,
        "the foreign header must survive untouched"
    );
    assert_eq!(
        kernel_schema_inventory(&conn).unwrap(),
        Vec::<String>::new()
    );

    let (_dir2, mut conn2) = open_profiled();
    conn2.pragma_update(None, "user_version", 7_i64).unwrap();
    apply_kernel_schema(&mut conn2, INCARNATION, 1_000)
        .expect_err("a stamped user_version is not pristine");
}

#[test]
fn commit_history_identity_is_immutable_and_undeletable() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let commit_seq = next_commit(&conn, "tx-events");
    conn.execute(
        "INSERT INTO change_event(
             commit_seq, ordinal, object_id, change_kind, idempotency_key, payload
         ) VALUES (?1, 0, 'object-a', 'create', 'op-1', X'01')",
        [commit_seq],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO operation_receipts(
             receipt_id, producer, operation_key, request_digest, commit_seq,
             result_payload, created_at
         ) VALUES ('receipt-1', 'producer-a', 'op-1', 'digest-1', ?1, X'02', 2)",
        [commit_seq],
    )
    .unwrap();

    for sql in [
        "UPDATE change_event SET object_id = 'object-b' WHERE ordinal = 0",
        "UPDATE change_event SET idempotency_key = 'op-2' WHERE ordinal = 0",
        "DELETE FROM change_event",
        "UPDATE operation_receipts SET operation_key = 'op-2'",
        "UPDATE operation_receipts SET request_digest = 'digest-2'",
        "DELETE FROM operation_receipts",
    ] {
        assert!(conn.execute(sql, []).is_err(), "must be refused: {sql}");
    }

    // R11 scans these payloads, so R8's remediation overwrite stays reachable.
    conn.execute(
        "UPDATE change_event SET payload = X'99' WHERE ordinal = 0",
        [],
    )
    .expect("payload remediation must remain possible");
    conn.execute("UPDATE operation_receipts SET result_payload = X'99'", [])
        .expect("result payload remediation must remain possible");
}

#[test]
fn active_capture_pin_must_be_released_before_deletion() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let commit_seq = next_commit(&conn, "tx-pin");
    conn.execute(
        "INSERT INTO capture_pins(
             capture_pin_id, pin_kind, owner_id, commit_seq, lease_epoch, writer_epoch,
             created_at
         ) VALUES ('pin-1', 'backup', 'operator-1', ?1, 1, 1, 5)",
        [commit_seq],
    )
    .unwrap();

    // Deleting an active pin would cascade its evidence references away and let
    // GC reclaim artifacts an in-progress backup still needs.
    assert!(conn
        .execute(
            "DELETE FROM capture_pins WHERE capture_pin_id = 'pin-1'",
            []
        )
        .is_err());
    conn.execute(
        "UPDATE capture_pins SET released_at = 6 WHERE capture_pin_id = 'pin-1'",
        [],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM capture_pins WHERE capture_pin_id = 'pin-1'",
        [],
    )
    .expect("a released pin is deletable");
}

#[test]
fn bootstrap_stamps_the_direct_format_epoch() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        DIRECT_FORMAT_EPOCH
    );
    // The header epoch and the marker epoch describe the same format.
    assert_eq!(
        conn.query_row(
            "SELECT format_epoch FROM mc_kernel_format_marker",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        DIRECT_FORMAT_EPOCH
    );
}

#[test]
fn capture_references_survive_until_released() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let created = seed_root_domain(&mut conn);
    seed_object(&conn, "object-ev-1", "evidence", created);
    conn.execute(
        "INSERT INTO evidence_meta(
             evidence_id, object_id, artifact_reference, artifact_digest, byte_length,
             media_type, retention_class, provider_egress_class, redaction_metadata,
             created_commit_seq, sensitivity_class
         ) VALUES ('ev-1', 'object-ev-1', 'cas://a', 'digest-a', 3, 'text/plain', 'standard',
                   'internal', X'7b7d', ?1, 'internal')",
        [created],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO capture_pins(
             capture_pin_id, pin_kind, owner_id, commit_seq, lease_epoch, writer_epoch, created_at
         ) VALUES ('pin-1', 'backup', 'operator-1', ?1, 1, 1, 5)",
        [created],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO capture_pin_refs(capture_pin_id, evidence_id) VALUES ('pin-1', 'ev-1')",
        [],
    )
    .unwrap();

    // A direct delete would let GC reclaim an artifact the backup still holds.
    assert!(conn
        .execute(
            "DELETE FROM capture_pin_refs WHERE evidence_id = 'ev-1'",
            []
        )
        .is_err());
    assert!(conn
        .execute(
            "UPDATE capture_pin_refs SET capture_pin_id = 'pin-2' WHERE evidence_id = 'ev-1'",
            [],
        )
        .is_err());

    // A BEFORE DELETE trigger fires for FK cascade rows too, so releasing the
    // reference is part of the pin teardown rather than optional.
    conn.execute(
        "UPDATE capture_pins SET released_at = 6 WHERE capture_pin_id = 'pin-1'",
        [],
    )
    .unwrap();
    assert!(
        conn.execute(
            "DELETE FROM capture_pins WHERE capture_pin_id = 'pin-1'",
            []
        )
        .is_err(),
        "an unreleased reference blocks the cascade"
    );
    conn.execute(
        "UPDATE capture_pin_refs SET released_at = 6 WHERE evidence_id = 'ev-1'",
        [],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM capture_pins WHERE capture_pin_id = 'pin-1'",
        [],
    )
    .expect("a fully released pin tears down with its references");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM capture_pin_refs", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn audit_and_event_identity_are_immutable_and_undeletable() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let created = seed_root_domain(&mut conn);
    conn.execute(
        "INSERT INTO consumer_abandonments(
             abandonment_id, consumer_id, operator_id, last_checkpoint_commit_seq,
             reason, commit_seq, abandoned_at
         ) VALUES ('abandon-1', 'search', 'operator-1', 9, 'retired', ?1, 11)",
        [created],
    )
    .unwrap();
    seed_object(&conn, "object-decision-1", "decision", created);
    conn.execute(
        "INSERT INTO decisions(
             decision_id, object_id, decision_kind, decision_payload, created_commit_seq,
             sensitivity_class
         ) VALUES ('decision-1', 'object-decision-1', 'accept', X'01', ?1, 'internal')",
        [created],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO decision_events(
             decision_id, event_ordinal, commit_seq, event_kind, event_payload, recorded_at
         ) VALUES ('decision-1', 0, ?1, 'opened', X'02', 5)",
        [created],
    )
    .unwrap();

    for sql in [
        "UPDATE consumer_abandonments SET consumer_id = 'other'",
        "UPDATE consumer_abandonments SET last_checkpoint_commit_seq = 0",
        "UPDATE consumer_abandonments SET commit_seq = NULL",
        "DELETE FROM consumer_abandonments",
        "UPDATE decision_events SET event_kind = 'closed'",
        "UPDATE decision_events SET event_ordinal = 1",
        "DELETE FROM decision_events",
    ] {
        assert!(conn.execute(sql, []).is_err(), "must be refused: {sql}");
    }

    // Detector-scanned columns stay writable for R8 remediation.
    conn.execute("UPDATE consumer_abandonments SET reason = '[redacted]'", [])
        .expect("reason remediation must remain possible");
    conn.execute("UPDATE decision_events SET event_payload = X'99'", [])
        .expect("event payload remediation must remain possible");
}

#[test]
fn replace_cannot_bypass_the_append_only_guards() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    let commit_seq = next_commit(&conn, "tx-replace");

    // REPLACE resolves a conflict by deleting the existing row; the delete
    // trigger only runs when recursive_triggers is on. Every value below
    // satisfies the STRICT column types and the length CHECKs, so the BEFORE
    // INSERT guard is the only thing left that can reject these statements.
    let columns = "singleton, format_epoch, database_incarnation_id, schema_digest, created_at,
                   marker_digest";
    let values = format!(
        "1, 99, '{}', '{}', 2, '{}'",
        "9".repeat(32),
        PINNED_SCHEMA_DIGEST,
        "d".repeat(64)
    );
    for verb in ["INSERT OR REPLACE", "REPLACE"] {
        let statement = format!("{verb} INTO mc_kernel_format_marker({columns}) VALUES({values})");
        assert!(conn.execute(&statement, []).is_err(), "{statement}");
    }
    assert_eq!(
        conn.query_row(
            "SELECT database_incarnation_id FROM mc_kernel_format_marker",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        INCARNATION
    );
    assert!(conn
        .execute(
            "INSERT OR REPLACE INTO commit_log(
                 commit_seq, transaction_id, writer_epoch, recorded_at, actor, cause
             ) VALUES (?1, 'tx-hijack', 1, 1, 'attacker', 'rewrite')",
            [commit_seq],
        )
        .is_err());
    assert_eq!(
        conn.query_row(
            "SELECT actor FROM commit_log WHERE commit_seq = ?1",
            [commit_seq],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "test"
    );
}

#[test]
fn malformed_incarnation_ids_are_refused() {
    for bad in [
        "incarnation-1",
        "",
        "0123456789ABCDEF0123456789ABCDEF",
        "0123456789abcdef0123456789abcde",
        "0123456789abcdef0123456789abcdeff",
        "0123456789abcdef0123456789abcdeg",
    ] {
        let (_dir, mut conn) = open_profiled();
        assert!(
            apply_kernel_schema(&mut conn, bad, 1_000).is_err(),
            "must refuse incarnation {bad:?}"
        );
        assert_eq!(
            kernel_schema_inventory(&conn).unwrap(),
            Vec::<String>::new(),
            "a refused bootstrap leaves no schema"
        );
    }
}

#[test]
fn staging_timestamps_must_be_chronological() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    let insert_run = |id: &str, started: i64, heartbeat: i64, terminal: Option<i64>| {
        conn.execute(
            "INSERT INTO extraction_runs(
                 extraction_run_id, extractor, sensitivity_class, provenance_witness,
                 redaction_metadata, started_at, heartbeat_at, lease_expires_at,
                 terminal_state, terminal_at
             ) VALUES (?1, 'test', 'internal', X'01', X'7b7d', ?2, ?3, 9999,
                       CASE WHEN ?4 IS NULL THEN NULL ELSE 'completed' END, ?4)",
            params![id, started, heartbeat, terminal],
        )
    };
    assert!(
        insert_run("run-a", 100, 50, None).is_err(),
        "heartbeat before start"
    );
    assert!(
        insert_run("run-b", 10, 50, Some(40)).is_err(),
        "terminal before last heartbeat"
    );
    insert_run("run-c", 10, 50, None).expect("live run in order");
    insert_run("run-d", 10, 50, Some(50)).expect("terminal at the last heartbeat");

    assert!(conn
        .execute(
            "INSERT INTO candidates(
                 candidate_id, extraction_run_id, candidate_kind, payload, sensitivity_class,
                 provenance_witness, redaction_metadata, created_at, heartbeat_at,
                 lease_expires_at
             ) VALUES ('candidate-1', 'run-c', 'proposition', X'02', 'internal', X'03',
                       X'7b7d', 100, 50, 9999)",
            [],
        )
        .is_err());
}

#[test]
fn commit_log_requires_an_explicit_operation_identity() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    let omitted = conn.execute(
        "INSERT INTO commit_log(transaction_id,writer_epoch,recorded_at,actor,cause)
         VALUES ('tx-omitted',1,1,'test','omitted')",
        [],
    );
    assert!(
        omitted.is_err(),
        "producer and operation_key must have no default that two writers can share"
    );

    for (transaction_id, operation_key) in [("tx-a", "op-a"), ("tx-b", "op-b")] {
        conn.execute(
            "INSERT INTO commit_log(
                 transaction_id,writer_epoch,producer,operation_key,request_digest,
                 recorded_at,actor,cause
             ) VALUES (?1,1,'fixture',?2,'',1,'test','explicit')",
            params![transaction_id, operation_key],
        )
        .unwrap();
    }
    let repeated = conn.execute(
        "INSERT INTO commit_log(
             transaction_id,writer_epoch,producer,operation_key,request_digest,
             recorded_at,actor,cause
         ) VALUES ('tx-c',1,'fixture','op-a','',1,'test','repeat')",
        [],
    );
    assert!(repeated.is_err(), "idx_commit_operation must stay unique");
}

#[test]
fn an_unstamped_writer_fence_reads_as_a_typed_epoch() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();

    let epoch: i64 = conn
        .query_row(
            "SELECT writer_epoch FROM writer_fence WHERE id=0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(epoch, -1, "bootstrap must seed a sentinel, not NULL");
}

#[test]
fn the_domains_ddl_spells_the_same_placeholder_the_code_compares_against() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).expect("bootstrap");

    // The index and the trigger carry the placeholder as SQL text, so a change to the
    // constant that missed the DDL would leave remediation exempt from neither.
    let sites = conn
        .prepare(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE tbl_name='domains' AND sql LIKE '%' || ?1 || '%'",
        )
        .unwrap()
        .query_row([mc_store::kernel::OPERATOR_REDACTION_PLACEHOLDER], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
    assert_eq!(sites, 2);
}

#[test]
fn staging_terminal_state_columns_reject_values_outside_the_vocabulary() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).expect("bootstrap");
    conn.execute_batch(
        "INSERT INTO commit_log(commit_seq,transaction_id,writer_epoch,producer,operation_key,request_digest,recorded_at,actor,cause)
         VALUES(1,'t1',1,'p','k','',1,'test','proof');
         INSERT INTO extraction_runs(
             extraction_run_id,extractor,sensitivity_class,provenance_witness,
             redaction_metadata,started_at,heartbeat_at,lease_expires_at
         ) VALUES('run','fixture','normal',x'00',x'00',1,1,2);",
    )
    .unwrap();

    for state in ["completed", "failed", "canceled", "abandoned"] {
        conn.execute(
            "UPDATE extraction_runs SET terminal_state=?1,terminal_at=5",
            [state],
        )
        .unwrap();
    }
    assert!(conn
        .execute(
            "UPDATE extraction_runs SET terminal_state='done',terminal_at=5",
            [],
        )
        .is_err());
}
