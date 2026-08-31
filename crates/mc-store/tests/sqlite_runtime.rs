use mc_store::sqlite_runtime::{
    compute_marker_digest, compute_schema_manifest_digest, evaluate_sqlite_runtime_gate,
    probe_sqlite_engine_identity_off_path, verify_sqlite_connection_contract, SqliteEngineIdentity,
    DIRECT_FORMAT_EPOCH, DIRECT_FORMAT_MARKER_TABLE, FORMAT_MARKER_DIGEST_PROTOCOL,
    MC_APPLICATION_ID, SCHEMA_MANIFEST_PROTOCOL, SQLITE_WAL_RESET_SAFE_MIN_VERSION,
};
use rusqlite::Connection;
use serde_json::Value;

const VOCABULARY_FIXTURE: &str = include_str!(
    "../../../packages/plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json"
);

fn fixture() -> Value {
    serde_json::from_str(VOCABULARY_FIXTURE).expect("vocabulary fixture parses")
}

fn manifest_components(fixture: &Value) -> Vec<(String, Vec<String>, Vec<String>)> {
    fixture["componentManifest"]["components"]
        .as_array()
        .expect("components array")
        .iter()
        .map(|component| {
            let strings = |key: &str| -> Vec<String> {
                component[key]
                    .as_array()
                    .expect("string array")
                    .iter()
                    .map(|value| value.as_str().expect("string").to_string())
                    .collect()
            };
            (
                component["name"].as_str().expect("name").to_string(),
                strings("dependsOn"),
                strings("provides"),
            )
        })
        .collect()
}

#[test]
fn sqlite_runtime_source() {
    let fixture = fixture();

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

    assert_eq!(
        SCHEMA_MANIFEST_PROTOCOL,
        fixture["componentManifest"]["protocol"].as_str().unwrap()
    );
    let components = manifest_components(&fixture);
    assert_eq!(
        compute_schema_manifest_digest(&components),
        fixture["goldens"]["manifestDigest"].as_str().unwrap()
    );

    // The marker digest binds the database incarnation.
    let marker = &fixture["goldens"]["marker"];
    assert_eq!(
        compute_marker_digest(
            marker["formatEpoch"].as_i64().unwrap(),
            marker["databaseIncarnationId"].as_str().unwrap(),
            marker["componentManifestDigest"].as_str().unwrap(),
            marker["createdAtMs"].as_i64().unwrap(),
        ),
        marker["markerDigest"].as_str().unwrap()
    );
    let other_incarnation = compute_marker_digest(
        marker["formatEpoch"].as_i64().unwrap(),
        "ffffffffffffffffffffffffffffffff",
        marker["componentManifestDigest"].as_str().unwrap(),
        marker["createdAtMs"].as_i64().unwrap(),
    );
    assert_ne!(other_incarnation, marker["markerDigest"].as_str().unwrap());

    let safe = SqliteEngineIdentity {
        sqlite_version: "3.51.3".to_string(),
        sqlite_source_id: "2026-01-01 00:00:00 0123456789abcdef0123456789abcdef01234567"
            .to_string(),
    };
    assert!(evaluate_sqlite_runtime_gate(&safe).is_empty());
    let unsafe_bundled = SqliteEngineIdentity {
        sqlite_version: "3.46.0".to_string(),
        sqlite_source_id:
            "2024-05-23 13:25:27 96c92aba00c8375bc32fafcdf12429c58bd8aabfcadab6683e35bbb9cdebf19e"
                .to_string(),
    };
    assert_eq!(
        evaluate_sqlite_runtime_gate(&unsafe_bundled),
        vec!["SQLite 3.46.0 predates the WAL-reset fix in 3.47.1".to_string()]
    );
    let unknown_source = SqliteEngineIdentity {
        sqlite_version: "3.51.3".to_string(),
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
    let live_reasons = evaluate_sqlite_runtime_gate(&live);
    let mut version_parts = live.sqlite_version.split('.');
    let live_tuple = [
        version_parts.next().unwrap().parse::<u64>().unwrap(),
        version_parts.next().unwrap().parse::<u64>().unwrap(),
        version_parts.next().unwrap_or("0").parse::<u64>().unwrap(),
    ];
    if live_tuple >= SQLITE_WAL_RESET_SAFE_MIN_VERSION {
        assert!(
            live_reasons.is_empty(),
            "safe engine must pass: {live_reasons:?}"
        );
    } else {
        assert_eq!(
            live_reasons,
            vec![format!(
                "SQLite {} predates the WAL-reset fix in 3.47.1",
                live.sqlite_version
            )]
        );
    }
}

#[test]
fn sqlite_runtime_source_connection_contract() {
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
    let violations = verify_sqlite_connection_contract(&conn, true, 5000).expect("contract");
    assert_eq!(violations, vec!["foreign_keys is disabled".to_string()]);

    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=OFF")
        .expect("degrade");
    let violations = verify_sqlite_connection_contract(&conn, true, 5000).expect("contract");
    assert_eq!(
        violations,
        vec![
            "busy_timeout 0ms is below the required 5000ms".to_string(),
            "synchronous mode 0 is not in the declared set [1, 2, 3]".to_string(),
        ]
    );
}

#[test]
fn sqlite_runtime_source_id_gate_fails_closed_on_non_ascii_stamps() {
    let straddling = format!("2026-01-01 00:00:00\u{e9}{}", "0".repeat(45));
    assert!(!straddling.is_char_boundary(20));
    assert_eq!(
        evaluate_sqlite_runtime_gate(&SqliteEngineIdentity {
            sqlite_version: "3.51.3".to_string(),
            sqlite_source_id: straddling.clone(),
        }),
        vec![format!(
            "sqlite_source_id() '{straddling}' is not a recognized SQLite source identity"
        )]
    );

    let padded = format!("\u{4e16}\u{754c}\u{4e16}\u{754c}{}", "0".repeat(60));
    assert_eq!(
        evaluate_sqlite_runtime_gate(&SqliteEngineIdentity {
            sqlite_version: "3.51.3".to_string(),
            sqlite_source_id: padded.clone(),
        }),
        vec![format!(
            "sqlite_source_id() '{padded}' is not a recognized SQLite source identity"
        )]
    );
}
