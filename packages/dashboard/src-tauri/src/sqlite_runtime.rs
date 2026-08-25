//! Off-path SQLite runtime probe and connection-contract checks for the
//! dashboard's `context.db` writers, sharing one vocabulary (application ID,
//! format epoch, marker table, manifest protocol) with the TypeScript host
//! and `mc-store`. The fixture
//! `packages/plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json`
//! is the cross-runtime source of truth; the `sqlite_runtime` integration
//! test proves this module against it. Shared Rust protocol types converge
//! into `mc-core` once the dashboard joins the claim operation contract; the
//! dashboard build stays standalone until then.

use mc_core::claim_operation::sha256_hex_utf8;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;

const DIRECT_FORMAT_FIXTURE: &str = include_str!(
    "../../../plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json"
);

pub const DATABASE_RESET_MARKER_SUFFIX: &str = ".mc-reset";

/// `PRAGMA application_id` value for the direct format: ASCII "MCTX".
pub const MC_APPLICATION_ID: u32 = 0x4D43_5458;

/// `PRAGMA user_version` value for the direct format.
pub const DIRECT_FORMAT_EPOCH: i64 = 1;

pub const DIRECT_FORMAT_MARKER_TABLE: &str = "mc_format_marker";

pub const FORMAT_MARKER_DIGEST_PROTOCOL: &str = "mc-direct-format-marker-v1";

pub const SCHEMA_MANIFEST_PROTOCOL: &str = "mc-schema-manifest-v1";

/// Minimum SQLite release carrying the WAL-reset fix
/// (<https://www.sqlite.org/wal.html#walresetbug>).
pub const SQLITE_WAL_RESET_SAFE_MIN_VERSION: [u64; 3] = [3, 47, 1];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqliteEngineIdentity {
    pub sqlite_version: String,
    pub sqlite_source_id: String,
}

/// Read `sqlite_version()` / `sqlite_source_id()` from an open connection.
pub fn read_sqlite_engine_identity(conn: &Connection) -> rusqlite::Result<SqliteEngineIdentity> {
    conn.query_row("SELECT sqlite_version(), sqlite_source_id()", [], |row| {
        Ok(SqliteEngineIdentity {
            sqlite_version: row.get(0)?,
            sqlite_source_id: row.get(1)?,
        })
    })
}

/// Probe the compiled engine on a throwaway in-memory connection, never the
/// real database file.
pub fn probe_sqlite_engine_identity_off_path() -> rusqlite::Result<SqliteEngineIdentity> {
    let conn = Connection::open_in_memory()?;
    read_sqlite_engine_identity(&conn)
}

fn parse_dotted_version(version: &str) -> Option<[u64; 3]> {
    let mut parts = version.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = match parts.next() {
        Some(raw) => raw
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .ok()?,
        None => 0,
    };
    Some([major, minor, patch])
}

fn is_well_formed_source_id(source_id: &str) -> bool {
    // `YYYY-MM-DD HH:MM:SS <40-64 hex chars>`
    let bytes = source_id.as_bytes();
    if bytes.len() < 20 + 40 {
        return false;
    }
    let (stamp, hash) = source_id.split_at(20);
    let stamp_ok = stamp.char_indices().all(|(index, c)| match index {
        4 | 7 => c == '-',
        10 => c == ' ',
        13 | 16 => c == ':',
        19 => c == ' ',
        _ => c.is_ascii_digit(),
    });
    let hash_ok = (40..=64).contains(&hash.len())
        && hash
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    stamp_ok && hash_ok
}

/// Evaluate the WAL-reset-safety gate. Returns every failure reason (empty =
/// pass). The engine identity is authoritative: a wrapper version alone never
/// passes, and an unknown `sqlite_source_id()` fails closed.
pub fn evaluate_sqlite_runtime_gate(identity: &SqliteEngineIdentity) -> Vec<String> {
    let mut reasons = Vec::new();
    match parse_dotted_version(&identity.sqlite_version) {
        Some(version) if version >= SQLITE_WAL_RESET_SAFE_MIN_VERSION => {}
        _ => reasons.push(format!(
            "SQLite {} predates the WAL-reset fix in 3.47.1",
            identity.sqlite_version
        )),
    }
    if !is_well_formed_source_id(&identity.sqlite_source_id) {
        reasons.push(format!(
            "sqlite_source_id() '{}' is not a recognized SQLite source identity",
            identity.sqlite_source_id
        ));
    }
    reasons
}

/// Verify the per-connection contract after PRAGMAs are applied: foreign keys
/// enforced, WAL activated (when expected), a busy timeout installed, and a
/// declared synchronous mode. Returns every violation (empty = pass).
pub fn verify_sqlite_connection_contract(
    conn: &Connection,
    expect_wal: bool,
    min_busy_timeout_ms: i64,
) -> rusqlite::Result<Vec<String>> {
    let mut violations = Vec::new();
    let foreign_keys: i64 = conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
    if foreign_keys != 1 {
        violations.push("foreign_keys is disabled".to_string());
    }
    let journal_mode: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    if expect_wal && !journal_mode.eq_ignore_ascii_case("wal") {
        violations.push(format!("journal_mode is '{journal_mode}', expected 'wal'"));
    }
    let busy_timeout_ms: i64 = conn.query_row("PRAGMA busy_timeout", [], |row| row.get(0))?;
    if busy_timeout_ms < min_busy_timeout_ms {
        violations.push(format!(
            "busy_timeout {busy_timeout_ms}ms is below the required {min_busy_timeout_ms}ms"
        ));
    }
    let synchronous: i64 = conn.query_row("PRAGMA synchronous", [], |row| row.get(0))?;
    if !(1..=3).contains(&synchronous) {
        violations.push(format!(
            "synchronous mode {synchronous} is not in the declared set [1, 2, 3]"
        ));
    }
    Ok(violations)
}

fn direct_format_fixture() -> Result<Value, String> {
    serde_json::from_str(DIRECT_FORMAT_FIXTURE)
        .map_err(|error| format!("embedded direct-format fixture is invalid: {error}"))
}

fn lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Validates the exact direct-format family.
pub fn verify_direct_format(conn: &Connection, db_path: &Path) -> Result<Vec<String>, String> {
    let fixture = direct_format_fixture()?;
    let mut reasons = Vec::new();
    if std::path::PathBuf::from(format!(
        "{}{}",
        db_path.display(),
        DATABASE_RESET_MARKER_SUFFIX
    ))
    .exists()
    {
        reasons.push("a pending reset marker exists for this database family".to_string());
    }

    let expected_application_id = fixture["applicationId"]
        .as_i64()
        .ok_or("direct-format fixture applicationId is invalid")?;
    let expected_epoch = fixture["formatEpoch"]
        .as_i64()
        .ok_or("direct-format fixture formatEpoch is invalid")?;
    let expected_manifest = fixture["goldens"]["manifestDigest"]
        .as_str()
        .ok_or("direct-format fixture manifest digest is invalid")?;

    let application_id: i64 = conn
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if application_id != expected_application_id {
        reasons.push(format!(
            "application_id {application_id} does not match expected {expected_application_id}"
        ));
    }
    let user_version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if user_version != expected_epoch {
        reasons.push(format!(
            "user_version {user_version} does not match expected format epoch {expected_epoch}"
        ));
    }

    let marker_exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?1",
            [DIRECT_FORMAT_MARKER_TABLE],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if marker_exists.is_none() {
        reasons.push("direct-format marker is absent".to_string());
    } else {
        let rows = conn
            .prepare(
                "SELECT format_epoch, database_incarnation_id, component_manifest_digest, \
                        created_at_ms, marker_digest FROM mc_format_marker",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|error| error.to_string())?;
        if rows.len() != 1 {
            reasons.push(format!("marker table has {} rows", rows.len()));
        } else {
            let (epoch, incarnation, manifest, created_at, stored_digest) = &rows[0];
            if *epoch != expected_epoch {
                reasons.push(format!(
                    "marker format epoch {epoch} does not match expected {expected_epoch}"
                ));
            }
            if !lower_hex(incarnation, 32) {
                reasons.push("marker database incarnation ID is invalid".to_string());
            }
            if !lower_hex(manifest, 64) {
                reasons.push("marker component manifest digest is invalid".to_string());
            } else if manifest != expected_manifest {
                reasons.push(
                    "marker component manifest digest does not match this build's manifest"
                        .to_string(),
                );
            }
            let digest_input = format!(
                "{FORMAT_MARKER_DIGEST_PROTOCOL}\napplication_id={expected_application_id}\nformat_epoch={epoch}\ndatabase_incarnation_id={incarnation}\ncomponent_manifest_digest={manifest}\ncreated_at_ms={created_at}"
            );
            if sha256_hex_utf8(&digest_input) != *stored_digest {
                reasons.push("marker digest mismatch".to_string());
            }
        }
    }

    let components = fixture["componentManifest"]["components"]
        .as_array()
        .ok_or("direct-format fixture components are invalid")?;
    let mut expected_objects = BTreeSet::from([DIRECT_FORMAT_MARKER_TABLE.to_string()]);
    for component in components {
        for provided in component["provides"]
            .as_array()
            .ok_or("direct-format fixture provides list is invalid")?
        {
            expected_objects.insert(
                provided
                    .as_str()
                    .ok_or("direct-format fixture object name is invalid")?
                    .to_string(),
            );
        }
    }
    let actual_objects: BTreeSet<String> = conn
        .prepare(
            "SELECT name FROM main.sqlite_schema \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<BTreeSet<_>>>()
        })
        .map_err(|error| error.to_string())?;
    for missing in expected_objects.difference(&actual_objects) {
        reasons.push(format!("missing registered schema object: {missing}"));
    }
    for extra in actual_objects.difference(&expected_objects) {
        reasons.push(format!("unregistered schema object: {extra}"));
    }
    Ok(reasons)
}
