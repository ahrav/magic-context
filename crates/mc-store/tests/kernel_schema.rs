#[cfg(feature = "test-support")]
use mc_store::kernel::schema::apply_kernel_schema_with_fault_hook_for_test;
use mc_store::kernel::schema::{
    apply_kernel_connection_profile, apply_kernel_schema, kernel_schema_digest,
    kernel_schema_inventory, verify_kernel_connection_contract, KERNEL_APPLICATION_ID,
    KERNEL_SCHEMA_COMPONENT_NAMES,
};
use mc_store::sqlite_runtime::MC_APPLICATION_ID;
use rusqlite::{params, Connection};

const EXPECTED_COMPONENTS: &[&str] = &[
    "commit_log",
    "change_event",
    "outbox",
    "operation_receipts",
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

fn open_profiled() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = Connection::open(dir.path().join("core.sqlite")).expect("open");
    apply_kernel_connection_profile(&mut conn, 5_000).expect("profile");
    (dir, conn)
}

/// Append a `commit_log` row and return its allocated `commit_seq`.
fn next_commit(conn: &Connection, transaction_id: &str) -> i64 {
    conn.execute(
        "INSERT INTO commit_log(transaction_id, writer_epoch, recorded_at, actor, cause)
         VALUES (?1, 1, 1, 'test', 'fixture')",
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
        "INSERT INTO commit_log(transaction_id, writer_epoch, recorded_at, actor, cause)
         VALUES ('tx-root', 1, 1, 'test', 'root')",
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).expect("bootstrap");

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

const PINNED_SCHEMA_DIGEST: &str =
    "8b612a52d93a8696c6d3182fa198cba0a894dc3623dc65c9bb21979120dee74f";

#[test]
fn kernel_schema_digest_is_pinned_to_the_frozen_v1_shape() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).expect("bootstrap");
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();

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
fn candidate_delete_cascades_scores_but_preserves_admission_audit() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
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
    let error =
        apply_kernel_schema_with_fault_hook_for_test(&mut conn, "incarnation-1", 1_000, || {
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
    conn.execute(
        "INSERT INTO commit_log(transaction_id, writer_epoch, recorded_at, actor, cause)
         VALUES ('tx-1', 7, 1, 'test', 'outbox')",
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
        "INSERT INTO outbox_consumers(consumer_id, checkpoint_outbox_position, updated_at)
         VALUES ('search', ?1, 3), ('mirror', 0, 3)",
        params![latest_position - 1],
    )
    .unwrap();

    conn.execute(
        "UPDATE outbox_consumers SET checkpoint_outbox_position = ?1
         WHERE consumer_id = 'search'",
        params![latest_position],
    )
    .unwrap();

    let checkpoint = |conn: &Connection, consumer: &str| -> i64 {
        conn.query_row(
            "SELECT checkpoint_outbox_position FROM outbox_consumers WHERE consumer_id = ?1",
            [consumer],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(checkpoint(&conn, "search"), latest_position);
    assert_eq!(checkpoint(&conn, "mirror"), 0);
    assert_eq!(
        conn.query_row(
            "SELECT MIN(checkpoint_outbox_position) FROM outbox_consumers",
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();

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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
    conn.execute(
        "INSERT INTO outbox_consumers(consumer_id, checkpoint_outbox_position, updated_at)
         VALUES ('search', 9, 10)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO commit_log(transaction_id, writer_epoch, recorded_at, actor, cause)
         VALUES ('tx-abandon', 7, 10, 'operator-1', 'abandonment')",
        [],
    )
    .unwrap();
    let commit_seq = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO consumer_abandonments(
             abandonment_id, consumer_id, operator_id, last_checkpoint_outbox_position,
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();

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
    assert_eq!(incarnation, "incarnation-1");
}

#[test]
fn one_source_revision_admits_many_objects_of_one_kind() {
    let (_dir, mut conn) = open_profiled();
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();

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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
    conn.execute(
        "INSERT INTO outbox_consumers(consumer_id, checkpoint_outbox_position, updated_at)
         VALUES ('search', 5, 1)",
        [],
    )
    .unwrap();

    conn.execute(
        "UPDATE outbox_consumers SET checkpoint_outbox_position = 9 WHERE consumer_id = 'search'",
        [],
    )
    .expect("forward advance is legal");
    assert!(conn
        .execute(
            "UPDATE outbox_consumers SET checkpoint_outbox_position = 4
              WHERE consumer_id = 'search'",
            [],
        )
        .is_err());
    // Re-acknowledging the same position stays legal.
    conn.execute(
        "UPDATE outbox_consumers SET checkpoint_outbox_position = 9, updated_at = 2
          WHERE consumer_id = 'search'",
        [],
    )
    .expect("idempotent re-acknowledgement is legal");
    assert_eq!(
        conn.query_row(
            "SELECT checkpoint_outbox_position FROM outbox_consumers WHERE consumer_id = 'search'",
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();

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

    apply_kernel_schema(&mut conn, "incarnation-1", 1_000)
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();
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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();

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
    apply_kernel_schema(&mut conn, "incarnation-1", 1_000).unwrap();

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
