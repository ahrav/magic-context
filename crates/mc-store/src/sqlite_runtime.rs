//! Off-path SQLite runtime probe and connection-contract checks for `store.db`
//! writers, sharing one vocabulary (application ID, format epoch, marker and
//! manifest digests) with the TypeScript host. The fixture
//! `packages/plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json`
//! is the cross-runtime source of truth; the `sqlite_runtime` integration test
//! proves this module against it.

use rusqlite::Connection;
use sha2::{Digest, Sha256};

/// `PRAGMA application_id` value for the direct format: ASCII "MCTX".
pub const MC_APPLICATION_ID: u32 = 0x4D43_5458;

/// `PRAGMA user_version` value for the direct format.
pub const DIRECT_FORMAT_EPOCH: i64 = 1;

pub const DIRECT_FORMAT_MARKER_TABLE: &str = "mc_format_marker";

pub const FORMAT_MARKER_DIGEST_PROTOCOL: &str = "mc-direct-format-marker-v1";

pub const SCHEMA_MANIFEST_PROTOCOL: &str = "mc-schema-manifest-v1";

/// Minimum supported SQLite release, carrying the complete WAL-reset race fix
/// (<https://www.sqlite.org/wal.html#walresetbug>).
pub const MIN_SUPPORTED_SQLITE_VERSION: [u64; 3] = [3, 51, 3];

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
    // A multi-byte sequence across the stamp boundary is not a timestamp, and
    // splitting inside one would panic: fail closed instead.
    if bytes.len() < 20 + 40 || !source_id.is_char_boundary(20) {
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
        Some(version) if version >= MIN_SUPPORTED_SQLITE_VERSION => {}
        _ => reasons.push(format!(
            "SQLite {} is below the supported floor 3.51.3",
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

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Canonical manifest digest over the shared line encoding: the protocol line,
/// then one `component name=<n> dependsOn=<a,b> provides=<x,y>` line per
/// component, joined with '\n'.
pub fn compute_schema_manifest_digest(components: &[(String, Vec<String>, Vec<String>)]) -> String {
    let mut lines = vec![SCHEMA_MANIFEST_PROTOCOL.to_string()];
    for (name, depends_on, provides) in components {
        lines.push(format!(
            "component name={} dependsOn={} provides={}",
            name,
            depends_on.join(","),
            provides.join(",")
        ));
    }
    sha256_hex(&lines.join("\n"))
}

/// Canonical marker digest over the shared line encoding.
pub fn compute_marker_digest(
    format_epoch: i64,
    database_incarnation_id: &str,
    component_manifest_digest: &str,
    created_at_ms: i64,
) -> String {
    let lines = [
        FORMAT_MARKER_DIGEST_PROTOCOL.to_string(),
        format!("application_id={MC_APPLICATION_ID}"),
        format!("format_epoch={format_epoch}"),
        format!("database_incarnation_id={database_incarnation_id}"),
        format!("component_manifest_digest={component_manifest_digest}"),
        format!("created_at_ms={created_at_ms}"),
    ];
    sha256_hex(&lines.join("\n"))
}
