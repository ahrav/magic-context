#[cfg(feature = "test-support")]
use mc_store::kernel::schema::apply_kernel_schema_with_fault_hook_for_test;
use mc_store::kernel::schema::{
    apply_kernel_connection_profile, apply_kernel_schema, kernel_schema_digest,
    kernel_schema_inventory, KERNEL_APPLICATION_ID, KERNEL_FORMAT_EPOCH,
    KERNEL_SCHEMA_COMPONENT_NAMES,
};
use mc_store::sqlite_runtime::verify_sqlite_connection_contract;
use rusqlite::{params, Connection};
use serde::Deserialize;

const EXPECTED_COMPONENTS: &[&str] = &[
    "commit_log",
    "change_event",
    "outbox",
    "operation_receipts",
    "durable_text_redactions",
    "writer_fence",
    "outbox_consumers",
    "consumer_abandonments",
    "capture_pins",
    "capture_pin_refs",
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
const TEST_INCARNATION: &str = "0123456789abcdef0123456789abcdef";

#[derive(Deserialize)]
struct FormatVocabulary {
    schema: String,
    application_id: u32,
    format_epoch: i64,
    schema_digest_protocol: String,
    schema_digest: String,
    ordered_components: Vec<String>,
}

fn open_profiled() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = Connection::open(dir.path().join("core.sqlite")).expect("open");
    apply_kernel_connection_profile(&mut conn, 5_000).expect("profile");
    (dir, conn)
}

#[test]
fn kernel_schema_has_one_ordered_full_shape() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).expect("bootstrap");

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

#[test]
fn generated_schema_matches_pinned_format_vocabulary() {
    let fixture: FormatVocabulary =
        serde_json::from_str(include_str!("fixtures/kernel-format-vocabulary-v1.json")).unwrap();
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).unwrap();

    assert_eq!(fixture.schema, "magic-context.kernel-format-vocabulary/v1");
    assert_eq!(fixture.application_id, KERNEL_APPLICATION_ID);
    assert_eq!(fixture.format_epoch, KERNEL_FORMAT_EPOCH);
    assert_eq!(fixture.schema_digest_protocol, "mc-kernel-schema-v1");
    assert_eq!(
        fixture.ordered_components,
        kernel_schema_inventory(&conn).unwrap()
    );
    assert_eq!(fixture.schema_digest, kernel_schema_digest(&conn).unwrap());
}

#[test]
fn column_only_drift_changes_digest_without_changing_component_inventory() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).unwrap();
    let inventory = kernel_schema_inventory(&conn).unwrap();
    let digest = kernel_schema_digest(&conn).unwrap();

    conn.execute_batch("ALTER TABLE domains ADD COLUMN drift_probe TEXT")
        .unwrap();

    assert_eq!(kernel_schema_inventory(&conn).unwrap(), inventory);
    assert_ne!(kernel_schema_digest(&conn).unwrap(), digest);
}

#[test]
fn kernel_profile_is_strict_and_verified() {
    let (_dir, conn) = open_profiled();
    assert_eq!(
        verify_sqlite_connection_contract(&conn, true, 5_000).unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn first_root_transaction_resolves_deferred_registry_cycle() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).unwrap();

    let tx = conn.transaction().unwrap();
    tx.execute(
        "INSERT INTO commit_log(transaction_id, writer_epoch, recorded_at, actor, cause)
         VALUES ('tx-1', 7, 1000, 'test', 'root')",
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
fn structural_guards_reject_arbitrary_updates_while_envelope_records_authorization_audit() {
    // Structural guards constrain row shapes; authorization and its audit record belong to the
    // private Connection envelope boundary. commentlint: allow(JUDGE)
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute(
        "INSERT INTO commit_log(transaction_id,writer_epoch,recorded_at,actor,cause)
         VALUES ('tx-guard',7,1000,'test','guard')",
        [],
    )
    .unwrap();
    let commit_seq = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO domains(domain_id,object_id,name,created_commit_seq,sensitivity_class)
         VALUES ('domain-guard','object-guard','original',?1,'internal')",
        [commit_seq],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO object_registry(
             object_id,object_kind,domain_id,source_kind,source_id,source_revision,
             created_commit_seq,sensitivity_class
         ) VALUES ('object-guard','domain','domain-guard','test','source',1,?1,'internal')",
        [commit_seq],
    )
    .unwrap();
    tx.commit().unwrap();

    assert!(conn
        .execute(
            "UPDATE domains SET name='arbitrary-rewrite' WHERE domain_id='domain-guard'",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "UPDATE object_registry SET source_id='arbitrary-rewrite'
             WHERE object_id='object-guard'",
            [],
        )
        .is_err());
    assert_eq!(
        conn.query_row(
            "SELECT name FROM domains WHERE domain_id='domain-guard'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "original"
    );
}

#[test]
fn candidate_delete_cascades_scores_but_preserves_admission_audit() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).unwrap();
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
         ) VALUES ('candidate-1', 'run-1', 'proposition', 'payload', 'internal', X'03', X'7b7d', 1, 2, 3)",
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
    let error =
        apply_kernel_schema_with_fault_hook_for_test(&mut conn, TEST_INCARNATION, 1_000, || {
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
fn consumers_checkpoint_commit_sequences() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).unwrap();
    conn.execute(
        "INSERT INTO commit_log(transaction_id, writer_epoch, recorded_at, actor, cause)
         VALUES ('tx-1', 7, 1, 'test', 'outbox')",
        [],
    )
    .unwrap();
    let commit_seq = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO outbox(
             commit_seq, ordinal, object_id, object_kind, source_kind, source_id,
             source_revision, sensitivity_class, payload, created_at
         ) VALUES (?1, 0, 'object-1', 'test', 'test', 'root', 1, 'internal', X'01', 2)",
        [commit_seq],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO outbox_consumers(
             consumer_id, checkpoint_commit_seq, updated_at
         ) VALUES ('search', ?1, 3)",
        params![commit_seq],
    )
    .unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT checkpoint_commit_seq FROM outbox_consumers WHERE consumer_id = 'search'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        commit_seq
    );
}

#[test]
fn every_kernel_table_is_strict_and_enforces_types_and_foreign_keys() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).unwrap();

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
        verify_sqlite_connection_contract(&conn, true, 5_000).unwrap(),
        vec!["synchronous mode 1 is not FULL or EXTRA [2, 3]".to_string()]
    );
}

#[test]
fn commit_receipt_and_change_identity_shapes_are_not_overconstrained() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).unwrap();
    conn.execute(
        "INSERT INTO commit_log(
             transaction_id, writer_epoch, recorded_at, actor, cause
         ) VALUES ('tx-identity', 42, 1, 'test', 'identity')",
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
             ) VALUES (?1, ?2, 'shared-key', 'digest-1', ?3, 'result', 2)",
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
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).unwrap();
    conn.execute(
        "INSERT INTO commit_log(transaction_id,writer_epoch,recorded_at,actor,cause)
         VALUES ('abandonment-commit',1,1,'test','fixture')",
        [],
    )
    .unwrap();
    let commit_seq = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO outbox_consumers(consumer_id, checkpoint_commit_seq, updated_at)
         VALUES ('search', 9, 10)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO consumer_abandonments(
             abandonment_id, consumer_id, operator_id, last_checkpoint_commit_seq,
             reason, abandoned_at, commit_seq
         ) VALUES ('abandon-1', 'search', 'operator-1', 9, 'retired', 11, ?1)",
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
fn durable_text_redactions_is_digest_covered_normalized_metadata_with_restricted_parent() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).unwrap();
    assert!(kernel_schema_inventory(&conn)
        .unwrap()
        .contains(&"durable_text_redactions".to_string()));

    let columns = conn
        .prepare("PRAGMA table_info(durable_text_redactions)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        columns,
        [
            "owner_kind",
            "owner_id",
            "field_name",
            "detection_ordinal",
            "detector_id",
            "secret_type",
            "utf8_offset",
            "utf8_length",
            "commit_seq",
        ]
    );
    assert!(!columns.iter().any(|column| column.contains("match")));

    let digest_with_relation = kernel_schema_digest(&conn).unwrap();
    conn.execute_batch("DROP TABLE durable_text_redactions")
        .unwrap();
    assert_ne!(digest_with_relation, kernel_schema_digest(&conn).unwrap());

    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, TEST_INCARNATION, 1_000).unwrap();
    conn.execute(
        "INSERT INTO commit_log(transaction_id,writer_epoch,recorded_at,actor,cause)
         VALUES ('redaction-parent',1,1,'test','fixture')",
        [],
    )
    .unwrap();
    let commit_seq = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO durable_text_redactions(
             owner_kind,owner_id,field_name,detection_ordinal,detector_id,secret_type,
             utf8_offset,utf8_length,commit_seq
         ) VALUES ('commit_log','redaction-parent','cause',0,'detector','token',0,10,?1)",
        [commit_seq],
    )
    .unwrap();
    assert!(conn
        .execute("DELETE FROM commit_log WHERE commit_seq=?1", [commit_seq])
        .is_err());
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM durable_text_redactions", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        1
    );
}
