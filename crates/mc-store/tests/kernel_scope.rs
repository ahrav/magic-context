#![cfg(feature = "test-support")]

use mc_store::kernel::{
    CommitIntent, DomainSpec, KernelErrorKind, KernelStore, ScopeSpec, ScopeTermSpec, Sensitivity,
};
use rusqlite::{Connection, OpenFlags};

const SECRET: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";

fn intent(key: &str, digest: char) -> CommitIntent {
    CommitIntent {
        producer: "kernel-scope-test".to_string(),
        operation_key: key.to_string(),
        request_digest: digest.to_string().repeat(64),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn domain() -> DomainSpec {
    DomainSpec {
        domain_id: "domain".to_string(),
        object_id: "domain-object".to_string(),
        name: "fixture".to_string(),
        source_kind: "fixture".to_string(),
        source_id: "domain".to_string(),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
    }
}

fn scope(source_revision: i64) -> ScopeSpec {
    ScopeSpec {
        scope_id: "scope".to_string(),
        object_id: "scope-object".to_string(),
        domain_id: "domain".to_string(),
        source_kind: "fixture".to_string(),
        source_id: "scope".to_string(),
        source_revision,
        sensitivity: Sensitivity::Normal,
        terms: vec![
            ScopeTermSpec {
                dimension: "branch".to_string(),
                operator: "exact".to_string(),
                exact_value: Some(format!("feature/{SECRET}")),
                ..ScopeTermSpec::default()
            },
            ScopeTermSpec {
                dimension: "repository".to_string(),
                operator: "exact".to_string(),
                exact_value: Some("magic-context".to_string()),
                ..ScopeTermSpec::default()
            },
        ],
    }
}

fn seed_domain(store: &KernelStore) {
    store
        .commit(intent("domain", '0'), |envelope| {
            envelope.insert_domain(domain())?;
            Ok(String::new())
        })
        .unwrap();
}

#[test]
fn insert_scope_orders_terms_and_redacts_values() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    store
        .commit(intent("scope", '1'), |envelope| {
            Ok(envelope.insert_scope(scope(1))?.result_json())
        })
        .unwrap();

    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let terms = connection
        .prepare(
            "SELECT ordinal,dimension,operator,exact_value
             FROM scope_term ORDER BY ordinal",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(terms.len(), 2);
    assert_eq!(terms[0].0, 0);
    assert_eq!(terms[1].0, 1);
    assert!(!terms[0].3.contains(SECRET));
    let field: String = connection
        .query_row(
            "SELECT field_name FROM durable_text_redactions
             WHERE owner_kind='scopes' AND owner_id='scope'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(field, "terms.0.exact_value");
}

#[test]
fn insert_scope_reports_missing_domain_and_duplicate_source_as_typed_errors() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    store
        .commit(intent("scope", '2'), |envelope| {
            envelope.insert_scope(scope(1))?;
            Ok(String::new())
        })
        .unwrap();

    let duplicate = store
        .commit(intent("duplicate", '3'), |envelope| {
            let mut duplicate = scope(1);
            duplicate.scope_id = "other-scope".to_string();
            duplicate.object_id = "other-scope-object".to_string();
            envelope.insert_scope(duplicate)?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(duplicate.kind(), KernelErrorKind::Conflict);

    let missing = store
        .commit(intent("missing", '4'), |envelope| {
            let mut missing = scope(2);
            missing.scope_id = "missing-scope".to_string();
            missing.object_id = "missing-scope-object".to_string();
            missing.domain_id = "missing".to_string();
            envelope.insert_scope(missing)?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(missing.kind(), KernelErrorKind::NotFound);
}
