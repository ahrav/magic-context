use magic_context_dashboard_db_adapter::{claim_adapter, sqlite_runtime};
use mc_core::claim_operation::{
    canonical_json_encode, compute_claim_operation_request_digest, decode_claim_operation_result,
    is_valid_public_claim_id, sha256_hex_utf8,
};
use rusqlite::{params, Connection};
use serde_json::Value;

const PROJECT: &str = "git:dashboard-adapter-tests";
const CLAIM_A: &str = "mcm_00112233445566778899aabbccddeeff";
const CLAIM_B: &str = "mcm_ffeeddccbbaa99887766554433221100";
const CONTRACT_FIXTURE: &str = include_str!(
    "../../../plugin/src/features/magic-context/memory/fixtures/claim-operation-contract-v1.json"
);

fn test_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open test database");
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        CREATE TABLE mc_format_marker (
            id INTEGER PRIMARY KEY,
            format_epoch INTEGER NOT NULL,
            database_incarnation_id TEXT NOT NULL,
            component_manifest_digest TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            marker_digest TEXT NOT NULL
        );
        INSERT INTO mc_format_marker VALUES (
            1, 1, '0123456789abcdef0123456789abcdef',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        );

        CREATE TABLE projects (
            id INTEGER PRIMARY KEY,
            canonical_identity TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE episodes (
            id INTEGER PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES projects(id),
            source_session_id TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE source_spans (
            id INTEGER PRIMARY KEY,
            episode_id INTEGER NOT NULL REFERENCES episodes(id),
            source_locator TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            start_offset INTEGER NOT NULL,
            end_offset INTEGER NOT NULL,
            raw_artifact_ref TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE observations (
            id INTEGER PRIMARY KEY,
            source_span_id INTEGER NOT NULL REFERENCES source_spans(id),
            extracted_text TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            extractor TEXT NOT NULL,
            extractor_version TEXT NOT NULL,
            extractor_run_id TEXT NOT NULL,
            independence_key TEXT NOT NULL,
            source_trust_class TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE claims (
            id INTEGER PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES projects(id),
            subject TEXT NOT NULL,
            predicate TEXT NOT NULL,
            scope TEXT NOT NULL,
            state TEXT NOT NULL,
            current_revision_id INTEGER,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE claim_revisions (
            id INTEGER PRIMARY KEY,
            claim_id INTEGER NOT NULL REFERENCES claims(id),
            revision INTEGER NOT NULL,
            content TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            source_session_id TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE (claim_id, revision)
        );
        CREATE TABLE claim_evidence (
            revision_id INTEGER NOT NULL REFERENCES claim_revisions(id),
            observation_id INTEGER NOT NULL REFERENCES observations(id),
            relation TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (revision_id, observation_id)
        ) WITHOUT ROWID;
        CREATE TABLE claim_conflicts (
            id INTEGER PRIMARY KEY,
            relation TEXT NOT NULL,
            left_revision_id INTEGER NOT NULL,
            right_revision_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE verification_events (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL,
            observation_id INTEGER,
            outcome TEXT NOT NULL,
            verifier TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE claim_public_ids (
            claim_id INTEGER PRIMARY KEY REFERENCES claims(id),
            public_id TEXT NOT NULL UNIQUE CHECK (
                length(public_id) = 36 AND public_id GLOB 'mcm_*'
            ),
            created_at INTEGER NOT NULL
        );
        CREATE TABLE claim_memory_revision_attributes (
            revision_id INTEGER PRIMARY KEY REFERENCES claim_revisions(id),
            claim_id INTEGER NOT NULL REFERENCES claims(id),
            project_id INTEGER NOT NULL REFERENCES projects(id),
            category TEXT NOT NULL,
            normalized_hash TEXT NOT NULL,
            importance INTEGER NOT NULL,
            memory_scope TEXT NOT NULL,
            sharing TEXT NOT NULL,
            expires_at INTEGER,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE claim_memory_lifecycle_events (
            id INTEGER PRIMARY KEY,
            claim_id INTEGER NOT NULL REFERENCES claims(id),
            seq INTEGER NOT NULL,
            predecessor_id INTEGER,
            state TEXT NOT NULL,
            actor TEXT NOT NULL,
            reason TEXT,
            recorded_at INTEGER NOT NULL,
            UNIQUE (claim_id, seq)
        );
        CREATE VIEW claim_memory_lifecycle_heads AS
        SELECT event.id AS event_id, event.claim_id, event.seq, event.state,
               event.actor, event.recorded_at
        FROM claim_memory_lifecycle_events event
        WHERE event.seq = (
            SELECT MAX(inner_event.seq)
            FROM claim_memory_lifecycle_events inner_event
            WHERE inner_event.claim_id = event.claim_id
        );
        CREATE TABLE claim_memory_current_heads (
            claim_id INTEGER PRIMARY KEY REFERENCES claims(id),
            project_id INTEGER NOT NULL REFERENCES projects(id),
            category TEXT NOT NULL,
            normalized_hash TEXT NOT NULL,
            revision_id INTEGER NOT NULL REFERENCES claim_revisions(id),
            lifecycle_state TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE claim_usage_stats (
            claim_id INTEGER PRIMARY KEY REFERENCES claims(id),
            seen_count INTEGER NOT NULL,
            retrieval_count INTEGER NOT NULL,
            last_seen_at INTEGER,
            last_retrieved_at INTEGER,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE claim_project_generations (
            project_id INTEGER PRIMARY KEY REFERENCES projects(id),
            generation INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE claim_operation_receipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            producer TEXT NOT NULL,
            operation_key TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            request_encoding_version INTEGER NOT NULL,
            result_encoding_version INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            expected_effect_count INTEGER NOT NULL,
            effect_summary_json TEXT NOT NULL,
            generation_vector_json TEXT NOT NULL,
            result_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE (producer, operation_key)
        );
        CREATE TABLE claim_operation_effects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_id INTEGER NOT NULL REFERENCES claim_operation_receipts(id),
            effect_key TEXT NOT NULL,
            project_id INTEGER NOT NULL REFERENCES projects(id),
            claim_id INTEGER NOT NULL REFERENCES claims(id),
            revision_id INTEGER,
            change_kind TEXT NOT NULL,
            generation INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE (receipt_id, effect_key)
        );

        CREATE TABLE claim_revision_applicability_streams (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES claim_revisions(id),
            project_id INTEGER NOT NULL REFERENCES projects(id),
            owner_kind TEXT NOT NULL,
            stream_key TEXT NOT NULL,
            key_protocol TEXT NOT NULL,
            source_digest TEXT NOT NULL,
            branch_selector TEXT,
            context_fingerprint TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE (revision_id, stream_key)
        );
        CREATE TABLE claim_revision_applicability_assertions (
            id INTEGER PRIMARY KEY,
            stream_id INTEGER NOT NULL REFERENCES claim_revision_applicability_streams(id),
            seq INTEGER NOT NULL,
            predecessor_id INTEGER,
            state TEXT NOT NULL,
            valid_from_anchor_id INTEGER,
            valid_until_anchor_id INTEGER,
            evaluated_against_anchor_id INTEGER,
            known_from INTEGER,
            recorded_at INTEGER NOT NULL,
            paths_state TEXT NOT NULL,
            dependency_fingerprint TEXT,
            dependency_protocol TEXT,
            verifier_spec TEXT,
            UNIQUE (stream_id, seq)
        );
        CREATE TABLE claim_revision_applicability_paths (
            assertion_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (assertion_id, kind, value)
        ) WITHOUT ROWID;
        CREATE TABLE claim_revision_applicability_symbols (
            assertion_id INTEGER NOT NULL,
            protocol TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (assertion_id, protocol, value)
        ) WITHOUT ROWID;

        CREATE TABLE claim_revision_policy_subjects (
            revision_id INTEGER PRIMARY KEY REFERENCES claim_revisions(id),
            project_id INTEGER NOT NULL REFERENCES projects(id),
            claim_kind TEXT NOT NULL,
            origin_observation_id INTEGER,
            origin_taint TEXT NOT NULL,
            classification_method TEXT NOT NULL,
            source_digest TEXT NOT NULL,
            policy_version INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE claim_maturity_streams (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL UNIQUE REFERENCES claim_revisions(id),
            project_id INTEGER NOT NULL REFERENCES projects(id),
            created_at INTEGER NOT NULL
        );
        CREATE TABLE claim_maturity_assertions (
            id INTEGER PRIMARY KEY,
            stream_id INTEGER NOT NULL REFERENCES claim_maturity_streams(id),
            seq INTEGER NOT NULL,
            predecessor_id INTEGER,
            maturity TEXT NOT NULL,
            actor TEXT NOT NULL,
            evidence_json TEXT,
            approval_action_id INTEGER,
            artifact_id INTEGER,
            policy_version INTEGER NOT NULL,
            recorded_at INTEGER NOT NULL,
            UNIQUE (stream_id, seq)
        );
        CREATE TABLE claim_disposition_events (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL,
            project_id INTEGER,
            disposition TEXT NOT NULL,
            action TEXT NOT NULL,
            reason TEXT,
            actor TEXT,
            policy_version INTEGER,
            recorded_at INTEGER
        );
        CREATE TABLE claim_approval_actions (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL
        );
        CREATE TABLE claim_enforcement_artifacts (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL
        );
        CREATE TABLE claim_enforcement_artifact_events (
            id INTEGER PRIMARY KEY,
            artifact_id INTEGER NOT NULL
        );
        CREATE TABLE claim_effective_policy (
            revision_id INTEGER PRIMARY KEY REFERENCES claim_revisions(id),
            claim_id INTEGER NOT NULL REFERENCES claims(id),
            project_id INTEGER NOT NULL REFERENCES projects(id),
            effective_maturity TEXT NOT NULL,
            origin_taint TEXT NOT NULL,
            auto_eligible INTEGER NOT NULL,
            explicit_eligible INTEGER NOT NULL,
            hard_hidden INTEGER NOT NULL,
            reason_codes_json TEXT NOT NULL,
            dispositions_json TEXT NOT NULL,
            policy_version INTEGER NOT NULL,
            generation INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        INSERT INTO projects (id, canonical_identity, created_at)
        VALUES (1, 'git:dashboard-adapter-tests', 1);
        "#,
    )
    .expect("create direct-claims test schema");
    conn
}

fn seed_claim(conn: &Connection, public_id: &str, content: &str, category: &str, lifecycle: &str) {
    assert!(is_valid_public_claim_id(public_id));
    let now = 1_700_000_000_000_i64;
    conn.execute(
        "INSERT INTO episodes (project_id, source_session_id, created_at) VALUES (1, NULL, ?1)",
        [now],
    )
    .unwrap();
    let episode_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO source_spans (episode_id, source_locator, content_sha256, start_offset, end_offset, raw_artifact_ref, created_at) VALUES (?1, 'seed://claim', ?2, 0, 1, NULL, ?3)",
        params![episode_id, sha256_hex_utf8(content), now],
    )
    .unwrap();
    let span_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO observations (source_span_id, extracted_text, content_sha256, extractor, extractor_version, extractor_run_id, independence_key, source_trust_class, created_at) VALUES (?1, ?2, ?3, 'seed', '1', ?4, ?4, 'explicit_user', ?5)",
        params![span_id, content, sha256_hex_utf8(content), format!("seed:{public_id}"), now],
    )
    .unwrap();
    let observation_id = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO claims (project_id, subject, predicate, scope, state, current_revision_id, created_at) VALUES (1, ?1, 'states', 'project-memory', ?2, NULL, ?3)",
        params![public_id, if lifecycle == "active" { "active" } else { "archived" }, now],
    )
    .unwrap();
    let claim_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO claim_public_ids (claim_id, public_id, created_at) VALUES (?1, ?2, ?3)",
        params![claim_id, public_id, now],
    )
    .unwrap();
    let digest = sha256_hex_utf8(content);
    conn.execute(
        "INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, source_session_id, created_at) VALUES (?1, 1, ?2, ?3, NULL, ?4)",
        params![claim_id, content, digest, now],
    )
    .unwrap();
    let revision_id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE claims SET current_revision_id = ?1 WHERE id = ?2",
        params![revision_id, claim_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?1, ?2, 'supports', ?3)",
        params![revision_id, observation_id, now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO claim_memory_revision_attributes (revision_id, claim_id, project_id, category, normalized_hash, importance, memory_scope, sharing, expires_at, created_at) VALUES (?1, ?2, 1, ?3, ?4, 50, 'project', 'private', NULL, ?5)",
        params![revision_id, claim_id, category, format!("hash:{public_id}"), now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO claim_memory_lifecycle_events (claim_id, seq, predecessor_id, state, actor, reason, recorded_at) VALUES (?1, 1, NULL, ?2, 'seed', 'seed', ?3)",
        params![claim_id, lifecycle, now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO claim_memory_current_heads (claim_id, project_id, category, normalized_hash, revision_id, lifecycle_state, updated_at) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6)",
        params![claim_id, category, format!("hash:{public_id}"), revision_id, lifecycle, now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO claim_usage_stats (claim_id, seen_count, retrieval_count, last_seen_at, last_retrieved_at, updated_at) VALUES (?1, 2, 3, NULL, NULL, ?2)",
        params![claim_id, now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO claim_revision_applicability_streams (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, branch_selector, context_fingerprint, created_at) VALUES (?1, 1, 'source', 'baseline:v1', 'mc-applicability-stream-key-v1', ?2, NULL, NULL, ?3)",
        params![revision_id, digest, now],
    )
    .unwrap();
    let stream_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO claim_revision_applicability_assertions (stream_id, seq, predecessor_id, state, valid_from_anchor_id, valid_until_anchor_id, evaluated_against_anchor_id, known_from, recorded_at, paths_state, dependency_fingerprint, dependency_protocol, verifier_spec) VALUES (?1, 1, NULL, 'unknown', NULL, NULL, NULL, ?2, ?2, 'unknown', NULL, NULL, NULL)",
        params![stream_id, now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO claim_revision_policy_subjects (revision_id, project_id, claim_kind, origin_observation_id, origin_taint, classification_method, source_digest, policy_version, created_at) VALUES (?1, 1, 'unknown', ?2, 'USER_EXPLICIT', 'seed', ?3, 1, ?4)",
        params![revision_id, observation_id, digest, now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO claim_maturity_streams (revision_id, project_id, created_at) VALUES (?1, 1, ?2)",
        params![revision_id, now],
    )
    .unwrap();
    let maturity_stream_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO claim_maturity_assertions (stream_id, seq, predecessor_id, maturity, actor, evidence_json, approval_action_id, artifact_id, policy_version, recorded_at) VALUES (?1, 1, NULL, 'VERIFIED', 'seed', NULL, NULL, NULL, 1, ?2)",
        params![maturity_stream_id, now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO claim_effective_policy (revision_id, claim_id, project_id, effective_maturity, origin_taint, auto_eligible, explicit_eligible, hard_hidden, reason_codes_json, dispositions_json, policy_version, generation, updated_at) VALUES (?1, ?2, 1, 'VERIFIED', 'USER_EXPLICIT', 1, 1, 0, '[\"eligible\"]', '[]', 1, 0, ?3)",
        params![revision_id, claim_id, now],
    )
    .unwrap();
}

fn read_claim(conn: &Connection, public_id: &str) -> claim_adapter::ClaimMemory {
    claim_adapter::read_claim_memories(conn, Some(PROJECT), None, None, None, 100, 0)
        .expect("read claims")
        .claims
        .into_iter()
        .find(|claim| claim.public_claim_id == public_id)
        .expect("seeded claim is visible")
}

fn target(claim: &claim_adapter::ClaimMemory) -> claim_adapter::ClaimMutationTarget {
    claim_adapter::ClaimMutationTarget {
        revision_locator: claim.revision_locator.clone(),
        mutation_token: claim.mutation_token.clone(),
    }
}

fn scalar(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

#[test]
fn adapter_and_mc_core_share_golden_contract() {
    let fixture: Value = serde_json::from_str(CONTRACT_FIXTURE).unwrap();
    for case in fixture["canonicalization"].as_array().unwrap() {
        assert_eq!(
            canonical_json_encode(&case["value"]).unwrap(),
            case["canonical"].as_str().unwrap()
        );
        assert_eq!(
            compute_claim_operation_request_digest(&case["value"]).unwrap(),
            case["requestDigest"].as_str().unwrap()
        );
    }
    for case in fixture["results"]["valid"].as_array().unwrap() {
        let result_json = case["resultJson"].as_str().unwrap();
        let decoded = decode_claim_operation_result(result_json).unwrap();
        assert_eq!(decoded.outcome.as_str(), case["outcome"].as_str().unwrap());
        assert_eq!(
            decoded.effects.len(),
            case["effectCount"].as_u64().unwrap() as usize
        );
    }
    assert!(is_valid_public_claim_id(CLAIM_A));
    assert!(!is_valid_public_claim_id(
        "clm_00112233445566778899aabbccddeeff"
    ));

    let mut conn = test_db();
    seed_claim(&conn, CLAIM_A, "old content", "FACT", "active");
    let claim = read_claim(&conn, CLAIM_A);
    let response = claim_adapter::revise_claim(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::ReviseClaimInput {
            target: target(&claim),
            operation_key: "golden-adapter-result".to_string(),
            content: Some("new content".to_string()),
            category: None,
        },
    )
    .unwrap();
    let decoded = decode_claim_operation_result(&response.result_json).unwrap();
    assert_eq!(decoded.outcome.as_str(), "applied");
    assert_eq!(decoded.effects.len(), 1);
    assert_eq!(
        canonical_json_encode(&response.result).unwrap(),
        response.result_json
    );
}

#[test]
fn reads_direct_current_claims_and_stats_with_canonical_ids() {
    let mut conn = test_db();
    seed_claim(&conn, CLAIM_A, "alpha fact", "FACT", "active");
    seed_claim(&conn, CLAIM_B, "beta rule", "RULE", "archived");

    let listed =
        claim_adapter::read_claim_memories(&conn, Some(PROJECT), None, None, Some("alpha"), 100, 0)
            .unwrap();
    assert_eq!(listed.outcome, "ok");
    assert_eq!(listed.claims.len(), 1);
    assert_eq!(listed.claims[0].public_claim_id, CLAIM_A);
    assert!(is_valid_public_claim_id(&listed.claims[0].public_claim_id));
    assert_eq!(listed.claims[0].revision, 1);
    assert_eq!(listed.claims[0].telemetry.seen_count, 2);
    assert_eq!(listed.claims[0].telemetry.retrieval_count, 3);
    assert_eq!(listed.claims[0].applicability.len(), 1);
    assert_eq!(listed.claims[0].evidence_labels.len(), 1);
    assert!(listed.snapshot_vector.is_some());

    let stats = claim_adapter::read_claim_memory_stats(&conn, Some(PROJECT)).unwrap();
    assert_eq!(stats.total, 2);
    assert_eq!(stats.active, 1);
    assert_eq!(stats.archived, 1);
    assert_eq!(stats.retired, 0);
    assert_eq!(stats.categories.len(), 2);

    let mut malformed = target(&listed.claims[0]);
    malformed.mutation_token.public_claim_id = "clm_00112233445566778899aabbccddeeff".to_string();
    let error = claim_adapter::set_claim_lifecycle(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::SetLifecycleInput {
            target: malformed,
            operation_key: "reject-clm".to_string(),
            lifecycle_state: "archived".to_string(),
        },
    )
    .unwrap_err();
    assert!(error.contains("invalid public claim ID"), "{error}");
}

#[test]
fn content_and_category_revisions_append_without_mutating_history() {
    let mut conn = test_db();
    seed_claim(&conn, CLAIM_A, "old content", "FACT", "active");
    let first = read_claim(&conn, CLAIM_A);

    let content = claim_adapter::revise_claim(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::ReviseClaimInput {
            target: target(&first),
            operation_key: "revise-content".to_string(),
            content: Some("new content".to_string()),
            category: None,
        },
    )
    .unwrap();
    assert_eq!(content.outcome, "applied");
    assert_eq!(content.refreshed_claims[0].revision, 2);

    let category = claim_adapter::revise_claim(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::ReviseClaimInput {
            target: target(&content.refreshed_claims[0]),
            operation_key: "revise-category".to_string(),
            content: None,
            category: Some("RULE".to_string()),
        },
    )
    .unwrap();
    assert_eq!(category.outcome, "applied");
    assert_eq!(category.refreshed_claims[0].revision, 3);
    assert_eq!(category.refreshed_claims[0].category, "RULE");
    assert_eq!(category.refreshed_claims[0].content, "new content");

    let mut statement = conn
        .prepare("SELECT revision, content, content_sha256 FROM claim_revisions ORDER BY revision")
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows[0],
        (1, "old content".to_string(), sha256_hex_utf8("old content"))
    );
    assert_eq!(
        rows[1],
        (2, "new content".to_string(), sha256_hex_utf8("new content"))
    );
    assert_eq!(
        rows[2],
        (3, "new content".to_string(), sha256_hex_utf8("new content"))
    );

    let categories = conn
        .prepare("SELECT category FROM claim_memory_revision_attributes ORDER BY revision_id")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(categories, vec!["FACT", "FACT", "RULE"]);
}

#[test]
fn lifecycle_archive_and_restore_append_events() {
    let mut conn = test_db();
    seed_claim(&conn, CLAIM_A, "fact", "FACT", "active");
    let active = read_claim(&conn, CLAIM_A);

    let archived = claim_adapter::set_claim_lifecycle(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::SetLifecycleInput {
            target: target(&active),
            operation_key: "archive".to_string(),
            lifecycle_state: "archived".to_string(),
        },
    )
    .unwrap();
    assert_eq!(archived.outcome, "applied");
    assert_eq!(archived.refreshed_claims[0].lifecycle_state, "archived");

    let restored = claim_adapter::set_claim_lifecycle(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::SetLifecycleInput {
            target: target(&archived.refreshed_claims[0]),
            operation_key: "restore".to_string(),
            lifecycle_state: "active".to_string(),
        },
    )
    .unwrap();
    assert_eq!(restored.outcome, "applied");
    assert_eq!(restored.refreshed_claims[0].lifecycle_state, "active");
    assert_eq!(
        scalar(&conn, "SELECT COUNT(*) FROM claim_memory_lifecycle_events"),
        3
    );
    assert_eq!(
        scalar(&conn, "SELECT MAX(seq) FROM claim_memory_lifecycle_events"),
        3
    );
    assert_eq!(
        conn.query_row("SELECT state FROM claims", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "active"
    );
}

#[test]
fn replay_returns_stored_result_and_key_reuse_is_rejected() {
    let mut conn = test_db();
    seed_claim(&conn, CLAIM_A, "fact", "FACT", "active");
    let claim = read_claim(&conn, CLAIM_A);
    let input = claim_adapter::SetLifecycleInput {
        target: target(&claim),
        operation_key: "replay-key".to_string(),
        lifecycle_state: "archived".to_string(),
    };

    let first = claim_adapter::set_claim_lifecycle(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        input.clone(),
    )
    .unwrap();
    let replay = claim_adapter::set_claim_lifecycle(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        input,
    )
    .unwrap();
    assert!(!first.replayed);
    assert!(replay.replayed);
    assert_eq!(replay.result_json, first.result_json);
    assert_eq!(
        scalar(&conn, "SELECT COUNT(*) FROM claim_operation_receipts"),
        1
    );
    assert_eq!(
        scalar(&conn, "SELECT COUNT(*) FROM claim_operation_effects"),
        1
    );

    let error = claim_adapter::set_claim_lifecycle(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::SetLifecycleInput {
            target: target(&claim),
            operation_key: "replay-key".to_string(),
            lifecycle_state: "active".to_string(),
        },
    )
    .unwrap_err();
    assert!(error.contains("operation key reused with different input"));
}

#[test]
fn stale_revision_token_commits_zero_effects() {
    let mut conn = test_db();
    seed_claim(&conn, CLAIM_A, "old", "FACT", "active");
    let stale = read_claim(&conn, CLAIM_A);
    let revised = claim_adapter::revise_claim(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::ReviseClaimInput {
            target: target(&stale),
            operation_key: "advance-head".to_string(),
            content: Some("new".to_string()),
            category: None,
        },
    )
    .unwrap();
    assert_eq!(revised.outcome, "applied");
    let effects_before = scalar(&conn, "SELECT COUNT(*) FROM claim_operation_effects");
    let generation_before = scalar(
        &conn,
        "SELECT generation FROM claim_project_generations WHERE project_id = 1",
    );

    let response = claim_adapter::revise_claim(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::ReviseClaimInput {
            target: target(&stale),
            operation_key: "stale-revision".to_string(),
            content: None,
            category: Some("RULE".to_string()),
        },
    )
    .unwrap();
    assert_eq!(response.outcome, "stale");
    assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM claim_revisions"), 2);
    assert_eq!(
        scalar(&conn, "SELECT COUNT(*) FROM claim_operation_effects"),
        effects_before
    );
    assert_eq!(
        scalar(
            &conn,
            "SELECT generation FROM claim_project_generations WHERE project_id = 1"
        ),
        generation_before
    );
    assert_eq!(
        conn.query_row(
            "SELECT expected_effect_count FROM claim_operation_receipts WHERE operation_key = 'stale-revision'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        0
    );
}

#[test]
fn bulk_stale_target_aborts_every_claim() {
    let mut conn = test_db();
    seed_claim(&conn, CLAIM_A, "alpha", "FACT", "active");
    seed_claim(&conn, CLAIM_B, "beta", "FACT", "active");
    let first = read_claim(&conn, CLAIM_A);
    let stale_second = read_claim(&conn, CLAIM_B);
    let advanced_second = claim_adapter::revise_claim(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::ReviseClaimInput {
            target: target(&stale_second),
            operation_key: "advance-second".to_string(),
            content: Some("beta revised".to_string()),
            category: None,
        },
    )
    .unwrap();
    assert_eq!(advanced_second.outcome, "applied");
    let effects_before = scalar(&conn, "SELECT COUNT(*) FROM claim_operation_effects");

    let response = claim_adapter::bulk_archive_claims(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::BulkArchiveInput {
            targets: vec![target(&first), target(&stale_second)],
            operation_key: "bulk-stale".to_string(),
        },
    )
    .unwrap();
    assert_eq!(response.outcome, "stale");
    assert_eq!(
        scalar(
            &conn,
            "SELECT COUNT(*) FROM claim_memory_current_heads WHERE lifecycle_state = 'active'"
        ),
        2
    );
    assert_eq!(
        scalar(&conn, "SELECT COUNT(*) FROM claim_operation_effects"),
        effects_before
    );
    assert_eq!(
        conn.query_row(
            "SELECT expected_effect_count FROM claim_operation_receipts WHERE operation_key = 'bulk-stale'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        0
    );
}

#[test]
fn tauri_and_http_mutations_record_distinct_provenance() {
    let mut conn = test_db();
    seed_claim(&conn, CLAIM_A, "alpha", "FACT", "active");
    seed_claim(&conn, CLAIM_B, "beta", "FACT", "active");
    let tauri = read_claim(&conn, CLAIM_A);
    let http = read_claim(&conn, CLAIM_B);

    claim_adapter::revise_claim(
        &mut conn,
        claim_adapter::MutationChannel::TauriExplicitUser,
        claim_adapter::ReviseClaimInput {
            target: target(&tauri),
            operation_key: "tauri-provenance".to_string(),
            content: Some("alpha revised".to_string()),
            category: None,
        },
    )
    .unwrap();
    claim_adapter::revise_claim(
        &mut conn,
        claim_adapter::MutationChannel::BearerHttp,
        claim_adapter::ReviseClaimInput {
            target: target(&http),
            operation_key: "http-provenance".to_string(),
            content: Some("beta revised".to_string()),
            category: None,
        },
    )
    .unwrap();

    let rows = conn
        .prepare(
            "SELECT extractor_run_id, extractor, source_trust_class FROM observations WHERE extractor_run_id IN ('tauri-provenance', 'http-provenance') ORDER BY extractor_run_id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                "http-provenance".to_string(),
                "dashboard:http".to_string(),
                "model_inference".to_string()
            ),
            (
                "tauri-provenance".to_string(),
                "dashboard:tauri".to_string(),
                "explicit_user".to_string()
            )
        ]
    );
    let taints = conn
        .prepare(
            "SELECT observation.extractor_run_id, subject.origin_taint FROM claim_revision_policy_subjects subject JOIN observations observation ON observation.id = subject.origin_observation_id WHERE observation.extractor_run_id IN ('tauri-provenance', 'http-provenance') ORDER BY observation.extractor_run_id",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        taints,
        vec![
            (
                "http-provenance".to_string(),
                "ASSISTANT_INFERENCE".to_string()
            ),
            ("tauri-provenance".to_string(), "USER_EXPLICIT".to_string())
        ]
    );
}

#[test]
fn adapter_runtime_and_format_checks_refuse_unsafe_inputs() {
    let outdated = sqlite_runtime::SqliteEngineIdentity {
        sqlite_version: "3.45.0".to_string(),
        sqlite_source_id: "2024-01-15 17:01:13 1066602b2b1976fe58b5150777cced894af17c803"
            .to_string(),
    };
    assert_eq!(
        sqlite_runtime::evaluate_sqlite_runtime_gate(&outdated),
        vec!["SQLite 3.45.0 predates the WAL-reset fix in 3.47.1"]
    );
    let unknown = sqlite_runtime::SqliteEngineIdentity {
        sqlite_version: "3.53.2".to_string(),
        sqlite_source_id: "vendor-build".to_string(),
    };
    assert_eq!(
        sqlite_runtime::evaluate_sqlite_runtime_gate(&unknown),
        vec!["sqlite_source_id() 'vendor-build' is not a recognized SQLite source identity"]
    );

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unsupported.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE legacy_memories (id INTEGER PRIMARY KEY)")
        .unwrap();
    let reasons = sqlite_runtime::verify_direct_format(&conn, &path).unwrap();
    assert!(reasons
        .iter()
        .any(|reason| reason == "direct-format marker is absent"));
    assert!(reasons
        .iter()
        .any(|reason| reason.contains("application_id 0 does not match expected")));
    assert!(reasons
        .iter()
        .any(|reason| reason == "unregistered schema object: legacy_memories"));
}
