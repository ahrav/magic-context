#![cfg(feature = "test-support")]

use std::collections::BTreeSet;
use std::fmt::Write;

use mc_store::kernel::{
    AlignmentRow, CommitIntent, DecisionPayload, DecisionSpec, DomainSpec, KernelStore,
    ObservationDependencySpec, ObservationPayload, ObservationSpec, RepositoryProvenance,
    ScopeSpec, ScopeTermSpec, Sensitivity, StagingCandidateSpec,
};
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use sha2::{Digest, Sha256};

const PRODUCER: &str = "session-cache-fixture";
const ACTOR: &str = "hand-authored-test";
const MAIN_SCOPE: &str = "scope-main";
const BRANCH_SCOPE: &str = "scope-redis-branch";
const STAGING_ONLY_TEXT: &str = "staging-only-redis-candidate";
const OPERATION_KEYS: [&str; 6] = [
    "fixture/domain",
    "fixture/scopes",
    "fixture/lru-pair",
    "fixture/redis-pair",
    "fixture/correct-lru-observation",
    "fixture/accept-redis",
];

// Acceptance clause map:
// R6, R20 -> staged_candidate_never_enters_canonical_state.
// R16, R17, KTD6, KTD7 -> branch_alignment_then_main_acceptance_preserves_redis_lineage.
// R18 -> false_lru_classification_is_corrected_append_only.
// R19 -> canonical_slice_and_projection_are_restart_identical.
// Deterministic rebuild acceptance -> canonical_slice_and_projection_are_restart_identical.

struct Fixture {
    store: KernelStore,
    pre_correction: i64,
    pre_acceptance: i64,
    accepted: i64,
}

fn intent(key: &str) -> CommitIntent {
    CommitIntent {
        producer: PRODUCER.to_string(),
        operation_key: key.to_string(),
        request_digest: format!("{:x}", Sha256::digest(key.as_bytes())),
        actor: ACTOR.to_string(),
        cause: "session-cache acceptance proof".to_string(),
    }
}

fn scope(scope_id: &str, branch: &str) -> ScopeSpec {
    ScopeSpec {
        scope_id: scope_id.to_string(),
        object_id: format!("{scope_id}-object"),
        domain_id: "session-cache".to_string(),
        source_kind: "fixture".to_string(),
        source_id: scope_id.to_string(),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
        terms: vec![ScopeTermSpec {
            dimension: "git_branch".to_string(),
            operator: "exact".to_string(),
            exact_value: Some(branch.to_string()),
            ..ScopeTermSpec::default()
        }],
    }
}

fn decision(
    decision_id: &str,
    object_id: &str,
    scope_id: &str,
    source_id: &str,
    source_revision: i64,
    summary: &str,
) -> DecisionSpec {
    DecisionSpec {
        decision_id: decision_id.to_string(),
        object_id: object_id.to_string(),
        domain_id: "session-cache".to_string(),
        proposition_id: None,
        scope_id: Some(scope_id.to_string()),
        anchor_id: None,
        evidence_id: None,
        decision_kind: "cache_backend".to_string(),
        payload: DecisionPayload {
            summary: summary.to_string(),
            rationale: "keep session cache latency bounded".to_string(),
        },
        source_kind: "fixture".to_string(),
        source_id: source_id.to_string(),
        source_revision,
        sensitivity: Sensitivity::Normal,
    }
}

fn observation(
    observation_id: &str,
    object_id: &str,
    scope_id: &str,
    source_id: &str,
    source_revision: i64,
    classification: &str,
    dependency_object_id: &str,
) -> ObservationSpec {
    ObservationSpec {
        observation_id: observation_id.to_string(),
        object_id: object_id.to_string(),
        domain_id: "session-cache".to_string(),
        proposition_id: None,
        scope_id: Some(scope_id.to_string()),
        anchor_id: None,
        evidence_id: None,
        observation_kind: "implementation".to_string(),
        payload: ObservationPayload {
            summary: format!("{scope_id} cache implementation"),
            classification: classification.to_string(),
        },
        observed_at: source_revision,
        dependencies: vec![ObservationDependencySpec {
            dependency_object_id: dependency_object_id.to_string(),
            dependency_kind: "implements".to_string(),
            dependency_payload: None,
        }],
        source_kind: "fixture".to_string(),
        source_id: source_id.to_string(),
        source_revision,
        sensitivity: Sensitivity::Normal,
    }
}

fn build_fixture(root: &std::path::Path) -> Fixture {
    let store = KernelStore::open(root).unwrap();
    store
        .commit(intent("fixture/domain"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "session-cache".to_string(),
                object_id: "session-cache-domain-object".to_string(),
                name: "session cache".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "session-cache-domain".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("fixture/scopes"), |envelope| {
            envelope.insert_scope(scope(MAIN_SCOPE, "main"))?;
            envelope.insert_scope(scope(BRANCH_SCOPE, "feature/redis"))?;
            Ok(String::new())
        })
        .unwrap();
    let pre_correction = store
        .commit(intent("fixture/lru-pair"), |envelope| {
            envelope.insert_decision(decision(
                "lru-decision",
                "lru-decision-object",
                MAIN_SCOPE,
                "lru-decision-lineage",
                1,
                "Use an in-process LRU cache",
            ))?;
            envelope.insert_observation(observation(
                "lru-observation-wrong",
                "lru-observation-wrong-object",
                MAIN_SCOPE,
                "lru-observation-lineage",
                1,
                "intended",
                "lru-decision-object",
            ))?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;
    store
        .commit(intent("fixture/redis-pair"), |envelope| {
            envelope.insert_decision(decision(
                "redis-branch-decision",
                "redis-branch-decision-object",
                BRANCH_SCOPE,
                "redis-decision-lineage",
                1,
                "Use Redis on the feature branch",
            ))?;
            envelope.insert_observation(observation(
                "redis-branch-observation",
                "redis-branch-observation-object",
                BRANCH_SCOPE,
                "redis-observation-lineage",
                1,
                "implemented",
                "redis-branch-decision-object",
            ))?;
            Ok(String::new())
        })
        .unwrap();
    let pre_acceptance = store
        .commit(intent("fixture/correct-lru-observation"), |envelope| {
            envelope.correct_observation(
                "lru-observation-wrong-object",
                observation(
                    "lru-observation",
                    "lru-observation-object",
                    MAIN_SCOPE,
                    "lru-observation-lineage",
                    2,
                    "implemented",
                    "lru-decision-object",
                ),
            )?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;
    let accepted = store
        .commit(intent("fixture/accept-redis"), |envelope| {
            envelope.correct_observation(
                "redis-branch-observation-object",
                observation(
                    "redis-main-observation",
                    "redis-main-observation-object",
                    MAIN_SCOPE,
                    "redis-observation-lineage",
                    2,
                    "implemented",
                    "redis-branch-decision-object",
                ),
            )?;
            envelope.correct_decision(
                "redis-branch-decision-object",
                decision(
                    "redis-main-decision",
                    "redis-main-decision-object",
                    MAIN_SCOPE,
                    "redis-decision-lineage",
                    2,
                    "Use Redis on main",
                ),
            )?;
            envelope.retire_decision("lru-decision-object")?;
            envelope.retire_observation("lru-observation-object")?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;
    store
        .stage_candidate(StagingCandidateSpec {
            extraction_run_id: "fixture-staging-run".to_string(),
            candidate_id: "fixture-staging-candidate".to_string(),
            extractor: "fixture".to_string(),
            source_kind: "repository".to_string(),
            source_id: "unreviewed-cache-note".to_string(),
            source_revision: 1,
            candidate_kind: "observation".to_string(),
            payload: STAGING_ONLY_TEXT.to_string(),
            provenance: Some(RepositoryProvenance {
                repository_id: "fixture-repository".to_string(),
                revision: "abc123".to_string(),
            }),
            recorded_at: 1,
            lease_expires_at: 2,
        })
        .unwrap();
    Fixture {
        store,
        pre_correction,
        pre_acceptance,
        accepted,
    }
}

fn alignment_in_scope(store: &KernelStore, sequence: i64, scope_id: &str) -> Vec<AlignmentRow> {
    let slice = store.slice_as_of(sequence).unwrap();
    let decision_ids = slice
        .decisions
        .iter()
        .filter(|row| row.scope_id.as_deref() == Some(scope_id))
        .map(|row| row.decision_id.as_str())
        .collect::<BTreeSet<_>>();
    let observation_ids = slice
        .observations
        .iter()
        .filter(|row| row.scope_id.as_deref() == Some(scope_id))
        .map(|row| row.observation_id.as_str())
        .collect::<BTreeSet<_>>();
    store
        .alignment_as_of(sequence)
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| {
            decision_ids.contains(row.decision_id.as_str())
                && observation_ids.contains(row.observation_id.as_str())
        })
        .collect()
}

fn read_rows(root: &std::path::Path, sql: &str) -> Vec<Vec<String>> {
    let connection =
        Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let mut statement = connection.prepare(sql).unwrap();
    let column_count = statement.column_count();
    statement
        .query_map([], |row| {
            (0..column_count)
                .map(|column| {
                    Ok(match row.get_ref(column)? {
                        ValueRef::Null => "null".to_string(),
                        ValueRef::Integer(value) => format!("integer:{value}"),
                        ValueRef::Real(value) => format!("real:{:016x}", value.to_bits()),
                        ValueRef::Text(value) => format!("text:{}", encode_hex(value)),
                        ValueRef::Blob(value) => format!("blob:{}", encode_hex(value)),
                    })
                })
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut encoded, byte| {
            write!(encoded, "{byte:02x}").unwrap();
            encoded
        },
    )
}

fn canonical_slice_rows(root: &std::path::Path) -> Vec<(&'static str, Vec<Vec<String>>)> {
    [
        ("decisions", "SELECT * FROM decisions ORDER BY decision_id"),
        (
            "decision_events",
            "SELECT * FROM decision_events ORDER BY decision_id,event_ordinal",
        ),
        (
            "observations",
            "SELECT * FROM observations ORDER BY observation_id",
        ),
        (
            "observation_dependencies",
            "SELECT * FROM observation_dependencies
             ORDER BY observation_id,dependency_object_id,dependency_kind",
        ),
        (
            "alignment_projection",
            "SELECT * FROM alignment_projection ORDER BY decision_id,observation_id",
        ),
    ]
    .into_iter()
    .map(|(table, sql)| (table, read_rows(root, sql)))
    .collect()
}

fn canonical_slice_digests(root: &std::path::Path) -> Vec<(&'static str, String)> {
    canonical_slice_rows(root)
        .into_iter()
        .map(|(table, rows)| {
            let mut digest = Sha256::new();
            for row in rows {
                for value in row {
                    digest.update(value.len().to_le_bytes());
                    digest.update(value);
                }
            }
            (table, format!("{:x}", digest.finalize()))
        })
        .collect()
}

fn projection_evidence(root: &std::path::Path) -> (Vec<Vec<String>>, Vec<Vec<String>>) {
    (
        read_rows(
            root,
            "SELECT * FROM alignment_projection ORDER BY decision_id,observation_id",
        ),
        read_rows(
            root,
            "SELECT * FROM durable_text_redactions
             WHERE owner_kind='alignment_projection'
             ORDER BY owner_id,field_name,detection_ordinal",
        ),
    )
}

fn query_strings(root: &std::path::Path, sql: &str) -> BTreeSet<String> {
    let connection =
        Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let values = connection
        .prepare(sql)
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    values
}

fn query_count(root: &std::path::Path, sql: &str) -> i64 {
    let connection =
        Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

#[test]
fn branch_alignment_then_main_acceptance_preserves_redis_lineage() {
    let root = tempfile::tempdir().unwrap();
    let fixture = build_fixture(root.path());

    let main = alignment_in_scope(&fixture.store, fixture.pre_acceptance, MAIN_SCOPE);
    assert_eq!(
        main.iter()
            .map(|row| (&row.decision_id, &row.observation_id))
            .collect::<Vec<_>>(),
        [(&"lru-decision".to_string(), &"lru-observation".to_string())]
    );
    let branch = alignment_in_scope(&fixture.store, fixture.pre_acceptance, BRANCH_SCOPE);
    assert_eq!(
        branch
            .iter()
            .map(|row| (&row.decision_id, &row.observation_id))
            .collect::<Vec<_>>(),
        [(
            &"redis-branch-decision".to_string(),
            &"redis-branch-observation".to_string()
        )]
    );

    let accepted = alignment_in_scope(&fixture.store, fixture.accepted, MAIN_SCOPE);
    assert_eq!(accepted.len(), 1);
    assert_eq!(accepted[0].decision_id, "redis-main-decision");
    assert_eq!(accepted[0].observation_id, "redis-main-observation");
    assert!(alignment_in_scope(&fixture.store, fixture.accepted, BRANCH_SCOPE).is_empty());
    let history = fixture
        .store
        .object_history_as_of(fixture.accepted)
        .unwrap();
    let branch_decision = history
        .objects
        .iter()
        .find(|row| row.object_id == "redis-branch-decision-object")
        .unwrap();
    let main_decision = history
        .objects
        .iter()
        .find(|row| row.object_id == "redis-main-decision-object")
        .unwrap();
    assert_eq!(
        branch_decision.superseded_by.as_deref(),
        Some("redis-main-decision-object")
    );
    assert_eq!(branch_decision.source_id, main_decision.source_id);
    assert_eq!(
        (
            branch_decision.source_revision,
            main_decision.source_revision
        ),
        (1, 2)
    );
    assert_eq!(
        fixture
            .store
            .rebuild_alignment()
            .unwrap()
            .built_through_commit_seq,
        fixture.accepted
    );
}

#[test]
fn false_lru_classification_is_corrected_append_only() {
    let root = tempfile::tempdir().unwrap();
    let fixture = build_fixture(root.path());

    let before = fixture.store.slice_as_of(fixture.pre_correction).unwrap();
    assert_eq!(
        before
            .observations
            .iter()
            .find(|row| row.observation_id == "lru-observation-wrong")
            .unwrap()
            .payload
            .classification,
        "intended"
    );
    assert_eq!(
        fixture
            .store
            .known_as_of(fixture.pre_correction)
            .unwrap()
            .objects
            .iter()
            .find(|row| row.object_id == "lru-observation-wrong-object")
            .unwrap()
            .invalidated_commit_seq,
        None
    );
    let corrected = fixture.store.slice_as_of(fixture.pre_acceptance).unwrap();
    assert_eq!(
        corrected
            .observations
            .iter()
            .find(|row| row.observation_id == "lru-observation")
            .unwrap()
            .payload
            .classification,
        "implemented"
    );
    assert_eq!(
        query_count(root.path(), "SELECT COUNT(*) FROM observations"),
        4
    );
}

#[test]
fn canonical_slice_and_projection_are_restart_identical() {
    let root = tempfile::tempdir().unwrap();
    let fixture = build_fixture(root.path());
    let known = fixture.store.known_as_of(fixture.accepted).unwrap();
    let slice = fixture.store.slice_as_of(fixture.accepted).unwrap();
    let alignment = fixture.store.alignment_as_of(fixture.accepted).unwrap();
    let digests = canonical_slice_digests(root.path());
    let first = projection_evidence(root.path());

    fixture.store.rebuild_alignment().unwrap();
    assert_eq!(projection_evidence(root.path()), first);
    fixture.store.rebuild_alignment().unwrap();
    assert_eq!(projection_evidence(root.path()), first);

    drop(fixture.store);
    let reopened = KernelStore::open(root.path()).unwrap();
    assert_eq!(reopened.known_as_of(fixture.accepted).unwrap(), known);
    assert_eq!(reopened.slice_as_of(fixture.accepted).unwrap(), slice);
    assert_eq!(
        reopened.alignment_as_of(fixture.accepted).unwrap(),
        alignment
    );
    assert_eq!(canonical_slice_digests(root.path()), digests);
    assert_eq!(projection_evidence(root.path()), first);
    reopened.rebuild_alignment().unwrap();
    assert_eq!(projection_evidence(root.path()), first);
}

#[test]
fn staged_candidate_never_enters_canonical_state() {
    let root = tempfile::tempdir().unwrap();
    let fixture = build_fixture(root.path());
    let known = fixture.store.known_as_of(fixture.accepted).unwrap();
    let history = fixture
        .store
        .object_history_as_of(fixture.accepted)
        .unwrap();
    let slice = fixture.store.slice_as_of(fixture.accepted).unwrap();
    let alignment = fixture.store.alignment_as_of(fixture.accepted).unwrap();

    assert!(known
        .objects
        .iter()
        .all(|row| !row.object_id.contains("staging")));
    assert!(history
        .objects
        .iter()
        .all(|row| !row.object_id.contains("staging")));
    assert!(slice
        .decisions
        .iter()
        .all(|row| !row.payload.summary.contains(STAGING_ONLY_TEXT)));
    assert!(slice
        .observations
        .iter()
        .all(|row| !row.payload.summary.contains(STAGING_ONLY_TEXT)));
    assert!(alignment
        .rows
        .iter()
        .all(|row| !row.alignment_payload.contains(STAGING_ONLY_TEXT)));
    assert_eq!(
        query_strings(root.path(), "SELECT DISTINCT producer FROM commit_log"),
        [PRODUCER.to_string()].into()
    );
    assert_eq!(
        query_strings(root.path(), "SELECT DISTINCT actor FROM commit_log"),
        [ACTOR.to_string()].into()
    );
    assert_eq!(
        query_strings(
            root.path(),
            "SELECT DISTINCT idempotency_key FROM change_event"
        ),
        OPERATION_KEYS.map(str::to_string).into()
    );
    assert_eq!(
        query_count(root.path(), "SELECT COUNT(*) FROM admission_decisions"),
        0
    );
    assert_eq!(
        query_count(
            root.path(),
            "SELECT COUNT(*) FROM alignment_projection
             WHERE alignment_payload LIKE '%staging-only%'"
        ),
        0
    );
}
