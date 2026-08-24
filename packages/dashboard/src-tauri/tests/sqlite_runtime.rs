use magic_context_dashboard_lib::sqlite_runtime::{
    evaluate_sqlite_runtime_gate, probe_sqlite_engine_identity_off_path,
    verify_sqlite_connection_contract, SqliteEngineIdentity, DIRECT_FORMAT_EPOCH,
    DIRECT_FORMAT_MARKER_TABLE, FORMAT_MARKER_DIGEST_PROTOCOL, MC_APPLICATION_ID,
    SCHEMA_MANIFEST_PROTOCOL, SQLITE_WAL_RESET_SAFE_MIN_VERSION,
};
use rusqlite::Connection;
use serde_json::Value;

const VOCABULARY_FIXTURE: &str = include_str!(
    "../../../plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json"
);

#[test]
fn sqlite_runtime_source() {
    let fixture: Value = serde_json::from_str(VOCABULARY_FIXTURE).expect("fixture parses");

    assert_eq!(
        u64::from(MC_APPLICATION_ID),
        fixture["applicationId"].as_u64().unwrap()
    );
    assert_eq!(
        DIRECT_FORMAT_EPOCH,
        fixture["formatEpoch"].as_i64().unwrap()
    );
    assert_eq!(
        DIRECT_FORMAT_MARKER_TABLE,
        fixture["markerTable"].as_str().unwrap()
    );
    assert_eq!(
        FORMAT_MARKER_DIGEST_PROTOCOL,
        fixture["markerDigestProtocol"].as_str().unwrap()
    );
    assert_eq!(
        SCHEMA_MANIFEST_PROTOCOL,
        fixture["manifestProtocol"].as_str().unwrap()
    );
    assert_eq!(
        fixture["minSqliteVersion"].as_str().unwrap(),
        format!(
            "{}.{}.{}",
            SQLITE_WAL_RESET_SAFE_MIN_VERSION[0],
            SQLITE_WAL_RESET_SAFE_MIN_VERSION[1],
            SQLITE_WAL_RESET_SAFE_MIN_VERSION[2]
        )
    );

    let manifest = &fixture["componentManifest"];
    assert_eq!(
        SCHEMA_MANIFEST_PROTOCOL,
        manifest["protocol"].as_str().unwrap()
    );
    let components = manifest["components"].as_array().expect("components");
    assert!(!components.is_empty());
    for component in components {
        assert!(component["name"].as_str().is_some());
        assert!(component["dependsOn"].as_array().is_some());
        assert!(!component["provides"].as_array().unwrap().is_empty());
    }
    assert_eq!(components[0]["name"].as_str().unwrap(), "claims-evidence");

    let safe = SqliteEngineIdentity {
        sqlite_version: "3.53.2".to_string(),
        sqlite_source_id: "2026-01-01 00:00:00 0123456789abcdef0123456789abcdef01234567"
            .to_string(),
    };
    assert!(evaluate_sqlite_runtime_gate(&safe).is_empty());
    let unsafe_bundled = SqliteEngineIdentity {
        sqlite_version: "3.45.0".to_string(),
        sqlite_source_id:
            "2024-01-15 17:01:13 1066602b2b1976fe58b5150777cced894af17c803e068f5918390d6915b46e1d"
                .to_string(),
    };
    assert_eq!(
        evaluate_sqlite_runtime_gate(&unsafe_bundled),
        vec!["SQLite 3.45.0 predates the WAL-reset fix in 3.47.1".to_string()]
    );
    let unknown_source = SqliteEngineIdentity {
        sqlite_version: "3.53.2".to_string(),
        sqlite_source_id: "vendor-custom-build".to_string(),
    };
    assert_eq!(
        evaluate_sqlite_runtime_gate(&unknown_source),
        vec![
            "sqlite_source_id() 'vendor-custom-build' is not a recognized SQLite source identity"
                .to_string()
        ]
    );

    let live = probe_sqlite_engine_identity_off_path().expect("off-path probe");
    println!(
        "live bundled engine: sqlite_version={} sqlite_source_id={}",
        live.sqlite_version, live.sqlite_source_id
    );
    let reasons = evaluate_sqlite_runtime_gate(&live);
    assert!(reasons.is_empty(), "bundled engine must pass: {reasons:?}");
}

#[test]
fn sqlite_runtime_connection_contract() {
    let dir = tempfile::tempdir().expect("tempdir");
    let conn = Connection::open(dir.path().join("contract.db")).expect("open");
    conn.execute_batch("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")
        .expect("pragmas");
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .expect("journal mode");
    assert!(journal_mode.eq_ignore_ascii_case("wal"));
    assert_eq!(
        verify_sqlite_connection_contract(&conn, true, 5000).expect("contract"),
        Vec::<String>::new()
    );

    conn.execute_batch("PRAGMA foreign_keys=OFF")
        .expect("disable fk");
    assert_eq!(
        verify_sqlite_connection_contract(&conn, true, 5000).expect("contract"),
        vec!["foreign_keys is disabled".to_string()]
    );

    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=OFF")
        .expect("degrade");
    assert_eq!(
        verify_sqlite_connection_contract(&conn, true, 5000).expect("contract"),
        vec![
            "busy_timeout 0ms is below the required 5000ms".to_string(),
            "synchronous mode 0 is not in the declared set [1, 2, 3]".to_string(),
        ]
    );
}
