use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const KERNEL_APPLICATION_ID: u32 = 0x4D43_4B52;
pub const KERNEL_SCHEMA_COMPONENT_NAMES: &[&str] = &[
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

const COMPONENTS: &[(&str, &str)] = &[
    (
        "commit_log",
        r#"CREATE TABLE commit_log(commit_seq INTEGER PRIMARY KEY AUTOINCREMENT,transaction_id TEXT NOT NULL UNIQUE,writer_epoch INTEGER NOT NULL,recorded_at INTEGER NOT NULL,actor TEXT NOT NULL,cause TEXT NOT NULL) STRICT;"#,
    ),
    (
        "change_event",
        r#"CREATE TABLE change_event(commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq) ON DELETE RESTRICT,ordinal INTEGER NOT NULL,object_id TEXT NOT NULL,change_kind TEXT NOT NULL,source_span_id TEXT,idempotency_key TEXT NOT NULL,payload BLOB,PRIMARY KEY(commit_seq,ordinal)) STRICT; CREATE INDEX idx_change_event_object_known_as_of ON change_event(object_id,commit_seq,ordinal); CREATE INDEX idx_change_event_operation ON change_event(idempotency_key,commit_seq,ordinal);"#,
    ),
    (
        "outbox",
        r#"CREATE TABLE outbox(outbox_position INTEGER PRIMARY KEY AUTOINCREMENT,commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq) ON DELETE RESTRICT,ordinal INTEGER NOT NULL,object_id TEXT NOT NULL,object_kind TEXT NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,sensitivity_class TEXT NOT NULL,payload BLOB NOT NULL,created_at INTEGER NOT NULL,published_at INTEGER,UNIQUE(commit_seq,ordinal)) STRICT; CREATE INDEX idx_outbox_poll ON outbox(published_at,outbox_position); CREATE INDEX idx_outbox_prune ON outbox(published_at,created_at,outbox_position); CREATE INDEX idx_outbox_commit_fk ON outbox(commit_seq);"#,
    ),
    (
        "operation_receipts",
        r#"CREATE TABLE operation_receipts(receipt_id TEXT PRIMARY KEY,producer TEXT NOT NULL,operation_key TEXT NOT NULL,request_digest TEXT NOT NULL,commit_seq INTEGER REFERENCES commit_log(commit_seq) ON DELETE RESTRICT,result_payload BLOB NOT NULL,created_at INTEGER NOT NULL,UNIQUE(producer,operation_key)) STRICT; CREATE INDEX idx_receipts_commit_fk ON operation_receipts(commit_seq);"#,
    ),
    (
        "writer_fence",
        r#"CREATE TABLE writer_fence(id INTEGER PRIMARY KEY CHECK(id=0),writer_epoch INTEGER) STRICT;"#,
    ),
    (
        "outbox_consumers",
        r#"CREATE TABLE outbox_consumers(consumer_id TEXT PRIMARY KEY,checkpoint_outbox_position INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL) STRICT; CREATE INDEX idx_consumers_checkpoint ON outbox_consumers(checkpoint_outbox_position,consumer_id);"#,
    ),
    (
        "consumer_abandonments",
        r#"CREATE TABLE consumer_abandonments(abandonment_id TEXT PRIMARY KEY,consumer_id TEXT NOT NULL,operator_id TEXT NOT NULL,last_checkpoint_outbox_position INTEGER NOT NULL,reason TEXT NOT NULL,abandoned_at INTEGER NOT NULL) STRICT; CREATE INDEX idx_abandonments_consumer ON consumer_abandonments(consumer_id,abandoned_at);"#,
    ),
    (
        "capture_pins",
        r#"CREATE TABLE capture_pins(capture_pin_id TEXT PRIMARY KEY,pin_kind TEXT NOT NULL,owner_id TEXT NOT NULL,commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq) ON DELETE RESTRICT,lease_epoch INTEGER NOT NULL,writer_epoch INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER,released_at INTEGER) STRICT; CREATE INDEX idx_capture_pins_commit_fk ON capture_pins(commit_seq); CREATE INDEX idx_capture_pins_ttl ON capture_pins(released_at,expires_at,capture_pin_id);"#,
    ),
    (
        "capture_pin_refs",
        r#"CREATE TABLE capture_pin_refs(capture_pin_id TEXT NOT NULL REFERENCES capture_pins(capture_pin_id) ON DELETE CASCADE,evidence_id TEXT NOT NULL REFERENCES evidence_meta(evidence_id) ON DELETE RESTRICT,expires_at INTEGER,released_at INTEGER,PRIMARY KEY(capture_pin_id,evidence_id)) STRICT; CREATE INDEX idx_capture_pin_refs_evidence_fk ON capture_pin_refs(evidence_id,capture_pin_id);"#,
    ),
    (
        "object_registry",
        r#"CREATE TABLE object_registry(object_id TEXT PRIMARY KEY,object_kind TEXT NOT NULL,domain_id TEXT NOT NULL REFERENCES domains(domain_id) DEFERRABLE INITIALLY DEFERRED,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq) ON DELETE RESTRICT,invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq) ON DELETE RESTRICT,superseded_by TEXT REFERENCES object_registry(object_id) DEFERRABLE INITIALLY DEFERRED,sensitivity_class TEXT NOT NULL,UNIQUE(source_kind,source_id,source_revision,object_kind)) STRICT; CREATE INDEX idx_objects_known_as_of ON object_registry(created_commit_seq,invalidated_commit_seq,object_id); CREATE INDEX idx_objects_domain_fk ON object_registry(domain_id,object_id); CREATE INDEX idx_objects_superseded_fk ON object_registry(superseded_by);"#,
    ),
    (
        "domains",
        r#"CREATE TABLE domains(domain_id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE REFERENCES object_registry(object_id) DEFERRABLE INITIALLY DEFERRED,name TEXT NOT NULL UNIQUE,created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL) STRICT; CREATE INDEX idx_domains_known_as_of ON domains(created_commit_seq,invalidated_commit_seq,domain_id); CREATE INDEX idx_domains_superseded_fk ON domains(superseded_by);"#,
    ),
    (
        "entities",
        r#"CREATE TABLE entities(entity_id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE REFERENCES object_registry(object_id),domain_id TEXT NOT NULL REFERENCES domains(domain_id),entity_kind TEXT NOT NULL,canonical_name TEXT NOT NULL,created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL) STRICT; CREATE INDEX idx_entities_domain_fk ON entities(domain_id,entity_id); CREATE INDEX idx_entities_known_as_of ON entities(created_commit_seq,invalidated_commit_seq,entity_id); CREATE INDEX idx_entities_superseded_fk ON entities(superseded_by);"#,
    ),
    (
        "entity_aliases",
        r#"CREATE TABLE entity_aliases(entity_id TEXT NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,alias TEXT NOT NULL,alias_kind TEXT NOT NULL,created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL,PRIMARY KEY(entity_id,alias,alias_kind)) STRICT; CREATE INDEX idx_alias_lookup ON entity_aliases(alias,alias_kind,entity_id); CREATE INDEX idx_alias_known_as_of ON entity_aliases(created_commit_seq,invalidated_commit_seq,entity_id);"#,
    ),
    (
        "propositions",
        r#"CREATE TABLE propositions(proposition_id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE REFERENCES object_registry(object_id),subject_id TEXT NOT NULL REFERENCES object_registry(object_id),predicate_schema_id TEXT NOT NULL REFERENCES predicate_schemas(predicate_schema_id),value BLOB NOT NULL,value_schema_id TEXT NOT NULL,normalized_hash TEXT NOT NULL,scope_id TEXT REFERENCES scopes(scope_id),anchor_id TEXT REFERENCES anchors(anchor_id),created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL) STRICT; CREATE INDEX idx_prop_known_as_of ON propositions(created_commit_seq,invalidated_commit_seq,proposition_id); CREATE INDEX idx_prop_subject_fk ON propositions(subject_id,predicate_schema_id); CREATE INDEX idx_prop_predicate_fk ON propositions(predicate_schema_id); CREATE INDEX idx_prop_scope_fk ON propositions(scope_id); CREATE INDEX idx_prop_anchor_fk ON propositions(anchor_id);"#,
    ),
    (
        "predicate_schemas",
        r#"CREATE TABLE predicate_schemas(predicate_schema_id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE REFERENCES object_registry(object_id),domain_id TEXT NOT NULL REFERENCES domains(domain_id),predicate_name TEXT NOT NULL,value_schema BLOB NOT NULL,freshness_class TEXT NOT NULL,created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL,UNIQUE(domain_id,predicate_name)) STRICT; CREATE INDEX idx_predicate_domain_fk ON predicate_schemas(domain_id); CREATE INDEX idx_predicate_known_as_of ON predicate_schemas(created_commit_seq,invalidated_commit_seq,predicate_schema_id);"#,
    ),
    (
        "scopes",
        r#"CREATE TABLE scopes(scope_id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE REFERENCES object_registry(object_id),domain_id TEXT NOT NULL REFERENCES domains(domain_id),created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL) STRICT; CREATE INDEX idx_scopes_domain_fk ON scopes(domain_id); CREATE INDEX idx_scopes_known_as_of ON scopes(created_commit_seq,invalidated_commit_seq,scope_id);"#,
    ),
    (
        "scope_term",
        r#"CREATE TABLE scope_term(scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,dimension TEXT NOT NULL,operator TEXT NOT NULL,exact_value TEXT,set_values BLOB,range_start TEXT,range_end TEXT,version_range TEXT,git_oid TEXT,git_start_oid TEXT,git_end_oid TEXT,payload BLOB,PRIMARY KEY(scope_id,ordinal)) STRICT;"#,
    ),
    (
        "anchors",
        r#"CREATE TABLE anchors(anchor_id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE REFERENCES object_registry(object_id),anchor_kind TEXT NOT NULL,exact_value TEXT,reachable_from_oid TEXT,reachable_between_start_oid TEXT,reachable_between_end_oid TEXT,deployment_revision TEXT,config_revision TEXT,platform_version_range TEXT,wall_clock_start INTEGER,wall_clock_end INTEGER,payload BLOB,created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL) STRICT; CREATE INDEX idx_anchors_known_as_of ON anchors(created_commit_seq,invalidated_commit_seq,anchor_id);"#,
    ),
    (
        "evidence_meta",
        r#"CREATE TABLE evidence_meta(evidence_id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE REFERENCES object_registry(object_id),artifact_reference TEXT NOT NULL,artifact_digest TEXT NOT NULL,byte_length INTEGER NOT NULL,media_type TEXT NOT NULL,retention_class TEXT NOT NULL,retain_until INTEGER,detector_kind TEXT,detector_version TEXT,detector_metadata BLOB,detector_id TEXT,secret_type TEXT,utf8_offset INTEGER,utf8_length INTEGER,provider_egress_class TEXT NOT NULL,redaction_metadata BLOB NOT NULL,created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL) STRICT; CREATE INDEX idx_evidence_retention ON evidence_meta(retain_until,evidence_id); CREATE INDEX idx_evidence_known_as_of ON evidence_meta(created_commit_seq,invalidated_commit_seq,evidence_id);"#,
    ),
    (
        "asserted_edges",
        r#"CREATE TABLE asserted_edges(edge_id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE REFERENCES object_registry(object_id),relation_id TEXT NOT NULL REFERENCES relation_registry(relation_id),source_object_id TEXT NOT NULL REFERENCES object_registry(object_id),target_object_id TEXT NOT NULL REFERENCES object_registry(object_id),scope_id TEXT REFERENCES scopes(scope_id),anchor_id TEXT REFERENCES anchors(anchor_id),evidence_id TEXT REFERENCES evidence_meta(evidence_id) ON DELETE SET NULL,edge_payload BLOB,created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL) STRICT; CREATE INDEX idx_edges_relation_fk ON asserted_edges(relation_id); CREATE INDEX idx_edges_source_fk ON asserted_edges(source_object_id); CREATE INDEX idx_edges_target_fk ON asserted_edges(target_object_id); CREATE INDEX idx_edges_evidence_fk ON asserted_edges(evidence_id); CREATE INDEX idx_edges_known_as_of ON asserted_edges(created_commit_seq,invalidated_commit_seq,edge_id);"#,
    ),
    (
        "relation_registry",
        r#"CREATE TABLE relation_registry(relation_id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE REFERENCES object_registry(object_id),relation_name TEXT NOT NULL UNIQUE,source_kind TEXT NOT NULL,target_kind TEXT NOT NULL,symmetry TEXT NOT NULL,cardinality TEXT NOT NULL,created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL) STRICT; CREATE INDEX idx_rel_known_as_of ON relation_registry(created_commit_seq,invalidated_commit_seq,relation_id);"#,
    ),
    (
        "extraction_runs",
        r#"CREATE TABLE extraction_runs(extraction_run_id TEXT PRIMARY KEY,extractor TEXT NOT NULL,source_kind TEXT,source_id TEXT,source_revision INTEGER,sensitivity_class TEXT NOT NULL,provenance_witness BLOB NOT NULL,redaction_metadata BLOB NOT NULL,detector_id TEXT,secret_type TEXT,utf8_offset INTEGER,utf8_length INTEGER,started_at INTEGER NOT NULL,heartbeat_at INTEGER NOT NULL,lease_expires_at INTEGER NOT NULL,terminal_state TEXT,terminal_at INTEGER) STRICT; CREATE INDEX idx_runs_ttl ON extraction_runs(terminal_at,lease_expires_at,extraction_run_id); CREATE INDEX idx_runs_heartbeat ON extraction_runs(terminal_at,heartbeat_at,extraction_run_id);"#,
    ),
    (
        "candidates",
        r#"CREATE TABLE candidates(candidate_id TEXT PRIMARY KEY,extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(extraction_run_id) ON DELETE CASCADE,candidate_kind TEXT NOT NULL,payload BLOB NOT NULL,sensitivity_class TEXT NOT NULL,provenance_witness BLOB NOT NULL,redaction_metadata BLOB NOT NULL,detector_id TEXT,secret_type TEXT,utf8_offset INTEGER,utf8_length INTEGER,created_at INTEGER NOT NULL,heartbeat_at INTEGER NOT NULL,lease_expires_at INTEGER NOT NULL,terminal_state TEXT,terminal_at INTEGER) STRICT; CREATE INDEX idx_candidates_run_fk ON candidates(extraction_run_id,candidate_id); CREATE INDEX idx_candidates_ttl ON candidates(terminal_at,lease_expires_at,candidate_id);"#,
    ),
    (
        "candidate_scores",
        r#"CREATE TABLE candidate_scores(candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,scorer TEXT NOT NULL,score REAL NOT NULL,score_payload BLOB,scored_at INTEGER NOT NULL,PRIMARY KEY(candidate_id,scorer)) STRICT;"#,
    ),
    (
        "admission_decisions",
        r#"CREATE TABLE admission_decisions(admission_decision_id TEXT PRIMARY KEY,candidate_id TEXT REFERENCES candidates(candidate_id) ON DELETE SET NULL,subject_object_id TEXT REFERENCES object_registry(object_id),source_kind TEXT NOT NULL,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_class TEXT NOT NULL,taint_class TEXT NOT NULL,maturity TEXT NOT NULL,disposition TEXT NOT NULL,visibility TEXT NOT NULL,policy_revision INTEGER NOT NULL,reason TEXT NOT NULL,evidence_id TEXT REFERENCES evidence_meta(evidence_id) ON DELETE SET NULL,approval_object_id TEXT REFERENCES object_registry(object_id) ON DELETE SET NULL,decided_at INTEGER NOT NULL) STRICT; CREATE INDEX idx_admission_candidate_fk ON admission_decisions(candidate_id); CREATE INDEX idx_admission_subject_fk ON admission_decisions(subject_object_id); CREATE INDEX idx_admission_evidence_fk ON admission_decisions(evidence_id); CREATE INDEX idx_admission_source ON admission_decisions(source_kind,source_id,source_revision,decided_at);"#,
    ),
    (
        "decisions",
        r#"CREATE TABLE decisions(decision_id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE REFERENCES object_registry(object_id),proposition_id TEXT REFERENCES propositions(proposition_id),scope_id TEXT REFERENCES scopes(scope_id),anchor_id TEXT REFERENCES anchors(anchor_id),evidence_id TEXT REFERENCES evidence_meta(evidence_id) ON DELETE SET NULL,decision_kind TEXT NOT NULL,decision_payload BLOB NOT NULL,created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL) STRICT; CREATE INDEX idx_decisions_known_as_of ON decisions(created_commit_seq,invalidated_commit_seq,decision_id); CREATE INDEX idx_decisions_evidence_fk ON decisions(evidence_id);"#,
    ),
    (
        "decision_events",
        r#"CREATE TABLE decision_events(decision_id TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE CASCADE,event_ordinal INTEGER NOT NULL,commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),event_kind TEXT NOT NULL,event_payload BLOB NOT NULL,evidence_id TEXT REFERENCES evidence_meta(evidence_id) ON DELETE SET NULL,recorded_at INTEGER NOT NULL,PRIMARY KEY(decision_id,event_ordinal)) STRICT; CREATE INDEX idx_decision_events_commit ON decision_events(commit_seq,decision_id,event_ordinal); CREATE INDEX idx_decision_events_evidence_fk ON decision_events(evidence_id);"#,
    ),
    (
        "observations",
        r#"CREATE TABLE observations(observation_id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE REFERENCES object_registry(object_id),proposition_id TEXT REFERENCES propositions(proposition_id),scope_id TEXT REFERENCES scopes(scope_id),anchor_id TEXT REFERENCES anchors(anchor_id),evidence_id TEXT REFERENCES evidence_meta(evidence_id) ON DELETE SET NULL,observation_kind TEXT NOT NULL,observation_payload BLOB NOT NULL,observed_at INTEGER NOT NULL,created_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),invalidated_commit_seq INTEGER REFERENCES commit_log(commit_seq),superseded_by TEXT REFERENCES object_registry(object_id),sensitivity_class TEXT NOT NULL) STRICT; CREATE INDEX idx_observations_known_as_of ON observations(created_commit_seq,invalidated_commit_seq,observation_id); CREATE INDEX idx_observations_evidence_fk ON observations(evidence_id);"#,
    ),
    (
        "observation_dependencies",
        r#"CREATE TABLE observation_dependencies(observation_id TEXT NOT NULL REFERENCES observations(observation_id) ON DELETE CASCADE,dependency_object_id TEXT NOT NULL REFERENCES object_registry(object_id),dependency_kind TEXT NOT NULL,dependency_payload BLOB,PRIMARY KEY(observation_id,dependency_object_id,dependency_kind)) STRICT; CREATE INDEX idx_observation_dependency_fk ON observation_dependencies(dependency_object_id,observation_id);"#,
    ),
    (
        "alignment_projection",
        r#"CREATE TABLE alignment_projection(decision_id TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE CASCADE,observation_id TEXT NOT NULL REFERENCES observations(observation_id) ON DELETE CASCADE,alignment_kind TEXT NOT NULL,alignment_payload BLOB,built_through_commit_seq INTEGER NOT NULL REFERENCES commit_log(commit_seq),PRIMARY KEY(decision_id,observation_id)) STRICT; CREATE INDEX idx_alignment_observation_fk ON alignment_projection(observation_id,decision_id); CREATE INDEX idx_alignment_built ON alignment_projection(built_through_commit_seq,decision_id);"#,
    ),
    (
        "mc_kernel_format_marker",
        r#"CREATE TABLE mc_kernel_format_marker(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format_epoch INTEGER NOT NULL,database_incarnation_id TEXT NOT NULL,schema_digest TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;"#,
    ),
];

pub fn apply_kernel_connection_profile(
    conn: &mut Connection,
    busy_timeout_ms: i64,
) -> rusqlite::Result<()> {
    if !conn.is_autocommit() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "trusted_schema", "OFF")?;
    conn.pragma_update(None, "busy_timeout", busy_timeout_ms)?;
    Ok(())
}

pub fn apply_kernel_schema(
    conn: &mut Connection,
    incarnation: &str,
    created_at: i64,
) -> rusqlite::Result<()> {
    apply_schema(conn, incarnation, created_at, || Ok(()))
}

fn apply_schema<F: FnOnce() -> rusqlite::Result<()>>(
    conn: &mut Connection,
    incarnation: &str,
    created_at: i64,
    hook: F,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.pragma_update(None, "application_id", KERNEL_APPLICATION_ID)?;
    for ((name, sql), expected) in COMPONENTS.iter().zip(KERNEL_SCHEMA_COMPONENT_NAMES) {
        debug_assert_eq!(name, expected);
        tx.execute_batch(sql)?;
    }
    tx.execute("INSERT INTO writer_fence(id) VALUES(0)", [])?;
    hook()?;
    let digest = kernel_schema_digest(&tx)?;
    tx.execute("INSERT INTO mc_kernel_format_marker(singleton,format_epoch,database_incarnation_id,schema_digest,created_at) VALUES(1,1,?1,?2,?3)", params![incarnation,digest,created_at])?;
    tx.commit()
}

#[cfg(feature = "test-support")]
pub fn apply_kernel_schema_with_fault_hook_for_test<F: FnOnce() -> rusqlite::Result<()>>(
    conn: &mut Connection,
    incarnation: &str,
    created_at: i64,
    hook: F,
) -> rusqlite::Result<()> {
    apply_schema(conn, incarnation, created_at, hook)
}

pub fn kernel_schema_inventory(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")?;
    let actual = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    let mut result: Vec<String> = KERNEL_SCHEMA_COMPONENT_NAMES
        .iter()
        .filter(|name| actual.contains(**name))
        .map(|name| (*name).into())
        .collect();
    result.extend(
        actual
            .into_iter()
            .filter(|name| !KERNEL_SCHEMA_COMPONENT_NAMES.contains(&name.as_str())),
    );
    Ok(result)
}

pub fn kernel_schema_digest(conn: &Connection) -> rusqlite::Result<String> {
    let mut stmt = conn.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql IS NOT NULL ORDER BY type,name")?;
    let mut rows = stmt.query([])?;
    let mut hash = Sha256::new();
    hash.update(b"mc-kernel-schema-v1\n");
    while let Some(row) = rows.next()? {
        for column in 0..4 {
            let value: String = row.get(column)?;
            hash.update(value.as_bytes());
            hash.update(b"\0");
        }
        hash.update(b"\n");
    }
    Ok(format!("{:x}", hash.finalize()))
}
