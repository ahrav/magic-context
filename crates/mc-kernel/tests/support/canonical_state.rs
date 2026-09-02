//! `digest(root, profile)` reads every non-`sqlite_%` table in `core.sqlite`
//! plus the CAS listings under `artifacts/objects` and `artifacts/tmp`,
//! normalizes the rows for the requested comparison, and hashes each table
//! separately so an unequal comparison names the table that differs.
//! `sqlite_sequence` stores `AUTOINCREMENT` counters, which outlive rows allocated from them.
//! `digest` hashes `sqlite_sequence` under its own key.
//!
//! Two normalization profiles answer two different questions about one store:
//!
//! * [`Profile::SameRoot`] compares one root with itself after a reopen or a
//!   backup-and-restore. Every reopen advances the lease epoch, so the current
//!   `writer_fence` row is the only column dropped. Everything else, including
//!   the format marker, minted identities, and wall-clock timestamps, must
//!   match exactly.
//! * [`Profile::CrossRoot`] compares two roots that ran the same history (a
//!   clean run against a perturbed run). It additionally drops the per-root
//!   incarnation, every persisted epoch, and every wall-clock timestamp the
//!   kernel stamps itself, then renames minted identities bijectively so two
//!   roots that minted different identifiers for the same objects compare
//!   equal while merged, swapped, or missing identities still differ.
//!
//! Volatile columns dropped by `CrossRoot` (all wall-clock or per-process).
//! `expires_at`, `released_at`, and `terminal_at` are reduced to null-or-set
//! instead of dropped: their nullness decides expiry, purge eligibility, and
//! staging-run visibility, while the instant in each derives from the clock
//! (`KernelStore::open` stamps `terminal_at` on abandoning an expired lease):
//!
//! | table | columns |
//! |---|---|
//! | `mc_kernel_format_marker` | `database_incarnation_id`, `marker_digest`, `created_at` |
//! | `commit_log` | `writer_epoch`, `recorded_at` |
//! | `outbox` | `created_at` |
//! | `operation_receipts` | `created_at` |
//! | `admission_decisions` | `decided_at` |
//! | `capture_pins` | `lease_epoch`, `writer_epoch`, `created_at`; `expires_at`, `released_at` reduced to null-or-set |
//! | `capture_pin_refs` | `expires_at`, `released_at` reduced to null-or-set |
//! | `artifact_ingestion_reservations` | `writer_epoch`, `created_at`, `heartbeat_at`, `lease_expires_at`, `reclaim_started_at` |
//! | `extraction_runs` | `terminal_at` reduced to null-or-set |
//! | `candidates` | `terminal_at` reduced to null-or-set |
//!
//! Identity domains renamed by `CrossRoot`. Each is defined by one table
//! column; the rename applies to every text and blob cell in every table, so
//! relational references and JSON payload references (`$.audit.barrier_id`
//! in `change_event.payload` and `outbox.payload`, `barrier_id` in
//! `operation_receipts.result_payload`, consumer-abandonment payloads) rewrite
//! together with the defining row.
//!
//! | domain | defining column | minted by |
//! |---|---|---|
//! | `barrier` | `deletion_backfill_barriers.barrier_id` | `next_unique_id()` |
//! | `reservation` | `artifact_ingestion_reservations.reservation_id` | `next_unique_id()` |
//! | `abandonment` | `consumer_abandonments.abandonment_id` | `next_unique_id()` |
//! | `capture_pin` | `capture_pins.capture_pin_id` | `randomblob(16)` |
//!
//! Identities are numbered in the order of their defining rows.
//! The ordering key drops the identity column and normalizes the rest.
//! Columns dropped by the profile then order rows tied on that key.
//! Those columns are wall-clock, so within one root they follow creation order.
//! The identity text breaks a tie only when the dropped columns also agree.
//! Comparison of identity text is lexicographic, which is not numeric order.
//! A tie resolved that way can pair rows differently in two roots.
//! A defining row may reference an earlier domain's identity.
//! `capture_pins.purge_barrier_id` is one such column.
//! Earlier domains are renamed before a later ordering key is taken.
//! `IDENTITY_DOMAINS` orders referenced domains before their dependents.
//! No defining row names a later domain's identity.
//!
//! A barrier- or reservation-shaped token can survive renaming.
//! Such a token references an identity no defining row declares.
//! The digest panics rather than compare two roots through it.
//! Capture-pin and abandonment identities have no shape distinct enough to scan.
//! An unresolved one of those surfaces as a digest inequality instead.
//!
//! `expires_at` is compared by presence, not by instant.
//! Two roots handed different explicit values therefore compare equal.
//! The default expiry derives from each root's own clock.
//! Comparing the instant exactly would fail an identical history.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

use mc_kernel::schema::KERNEL_APPLICATION_ID;
use mc_kernel::sqlite_runtime::compute_marker_digest_for_application_id;

/// Comparison the digest is normalized for; see the module documentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    SameRoot,
    CrossRoot,
}

/// One SHA-256 hex digest per table, plus the CAS object listing under the
/// `cas_objects` key. Equality is table-wise so a failing assertion reports
/// exactly which table diverged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalDigest {
    pub tables: BTreeMap<String, String>,
}

impl CanonicalDigest {
    pub fn table(&self, name: &str) -> &str {
        self.tables
            .get(name)
            .unwrap_or_else(|| panic!("digest has no table {name}"))
    }

    /// Equality assertion that names the differing tables instead of
    /// printing two maps of hashes. The key-set check runs first because equal
    /// shared-table digests would otherwise mask a table only one state covers.
    #[track_caller]
    pub fn assert_same(&self, other: &Self, context: &str) {
        let missing_here = other
            .tables
            .keys()
            .filter(|table| !self.tables.contains_key(*table));
        let missing_there = self
            .tables
            .keys()
            .filter(|table| !other.tables.contains_key(*table));
        let uncovered = missing_here
            .chain(missing_there)
            .map(String::as_str)
            .collect::<Vec<_>>();
        assert!(
            uncovered.is_empty(),
            "{context}: only one digest covers {uncovered:?}"
        );
        let differing = self
            .tables
            .iter()
            .filter(|(table, digest)| other.tables.get(*table) != Some(digest))
            .map(|(table, _)| table.as_str())
            .collect::<Vec<_>>();
        assert!(
            differing.is_empty(),
            "{context}: canonical state differs in {differing:?}"
        );
    }
}

/// Digest the canonical state at `root` under `profile`.
pub fn digest(root: &Path, profile: Profile) -> CanonicalDigest {
    let state = State::read(root);
    let normalized = state.normalize(profile);
    let mut tables = BTreeMap::new();
    for (table, rows) in normalized.tables {
        tables.insert(table, hash_rows(&rows));
    }
    let object_rows = normalized
        .objects
        .into_iter()
        .map(|(digest, len)| vec![Cell::Text(digest), Cell::Integer(len as i64)])
        .collect::<Vec<_>>();
    tables.insert("cas_objects".to_string(), hash_rows(&object_rows));
    let temp_rows = normalized
        .temps
        .into_iter()
        .map(|(depth, digest, len)| {
            vec![
                Cell::Integer(depth as i64),
                Cell::Text(digest),
                Cell::Integer(len as i64),
            ]
        })
        .collect::<Vec<_>>();
    tables.insert("cas_temps".to_string(), hash_rows(&temp_rows));
    let unexpected_rows = normalized
        .unexpected
        .into_iter()
        .map(|(depth, digest, len)| {
            vec![
                Cell::Integer(depth as i64),
                Cell::Text(digest),
                Cell::Integer(len as i64),
            ]
        })
        .collect::<Vec<_>>();
    tables.insert("cas_unexpected".to_string(), hash_rows(&unexpected_rows));
    let sequence_rows = normalized
        .sequences
        .into_iter()
        .map(|(name, seq)| vec![Cell::Text(name), Cell::Integer(seq)])
        .collect::<Vec<_>>();
    tables.insert("sqlite_sequence".to_string(), hash_rows(&sequence_rows));
    tables.insert(
        "schema_identity".to_string(),
        hash_rows(&schema_identity_rows(root)),
    );
    tables.insert("cas_layout".to_string(), hash_rows(&layout_rows(root)));
    CanonicalDigest { tables }
}

/// Names of every table the digest covers at `root`, in sorted order. The
/// oracle reads the live schema so a new kernel table is digested without an
/// edit here; the inventory test in `kernel_proofs` pins that set against the
/// schema module's declared component list.
pub fn digested_tables(root: &Path) -> BTreeSet<String> {
    let connection = open_read_only(root);
    table_names(&connection).into_iter().collect()
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Cell {
    Null,
    Integer(i64),
    Real(u64),
    Text(String),
    Blob(Vec<u8>),
}

impl Cell {
    fn feed(&self, hasher: &mut Sha256) {
        match self {
            Cell::Null => hasher.update([0u8]),
            Cell::Integer(value) => {
                hasher.update([1u8]);
                hasher.update(value.to_le_bytes());
            }
            Cell::Real(bits) => {
                hasher.update([2u8]);
                hasher.update(bits.to_le_bytes());
            }
            Cell::Text(value) => {
                hasher.update([3u8]);
                hasher.update((value.len() as u64).to_le_bytes());
                hasher.update(value.as_bytes());
            }
            Cell::Blob(value) => {
                hasher.update([4u8]);
                hasher.update((value.len() as u64).to_le_bytes());
                hasher.update(value);
            }
        }
    }
}

struct Table {
    columns: Vec<String>,
    rows: Vec<Vec<Cell>>,
}

struct State {
    tables: BTreeMap<String, Table>,
    sequences: Vec<(String, i64)>,
    objects: Vec<(String, u64)>,
    unexpected: Vec<(u64, String, u64)>,
    temps: Vec<(u64, String, u64)>,
}

struct Normalized {
    tables: BTreeMap<String, Vec<Vec<Cell>>>,
    sequences: Vec<(String, i64)>,
    objects: Vec<(String, u64)>,
    unexpected: Vec<(u64, String, u64)>,
    temps: Vec<(u64, String, u64)>,
}

impl State {
    fn read(root: &Path) -> Self {
        let connection = open_read_only(root);
        let mut tables = BTreeMap::new();
        for name in table_names(&connection) {
            let columns = columns_of(&connection, &name);
            let sql = format!(
                "SELECT {} FROM \"{name}\"",
                columns
                    .iter()
                    .map(|column| format!("\"{column}\""))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            let mut statement = connection.prepare(&sql).unwrap();
            let rows = statement
                .query_map([], |row| {
                    (0..columns.len())
                        .map(|index| {
                            Ok(match row.get_ref(index)? {
                                ValueRef::Null => Cell::Null,
                                ValueRef::Integer(value) => Cell::Integer(value),
                                ValueRef::Real(value) => Cell::Real(value.to_bits()),
                                ValueRef::Text(value) => {
                                    Cell::Text(String::from_utf8(value.to_vec()).unwrap_or_else(
                                        |_| panic!("{name}.{} is not UTF-8", columns[index]),
                                    ))
                                }
                                ValueRef::Blob(value) => Cell::Blob(value.to_vec()),
                            })
                        })
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            tables.insert(name, Table { columns, rows });
        }
        verify_format_marker(&tables);
        Self {
            tables,
            sequences: read_sequences(&connection),
            objects: scan_objects(root),
            unexpected: scan_unexpected_objects(root),
            temps: scan_temps(root),
        }
    }

    fn normalize(mut self, profile: Profile) -> Normalized {
        let renames = match profile {
            Profile::SameRoot => Vec::new(),
            Profile::CrossRoot => {
                assert_no_placeholder_syntax(&self.tables);
                self.identity_renames()
            }
        };
        let mut tables = BTreeMap::new();
        for (name, table) in self.tables {
            let kept = table
                .columns
                .iter()
                .enumerate()
                .map(|(index, column)| (index, column_rule(profile, &name, column)))
                .filter(|(_, rule)| *rule != Rule::Drop)
                .collect::<Vec<_>>();
            let mut rows = table
                .rows
                .into_iter()
                .map(|row| {
                    kept.iter()
                        .map(|&(index, rule)| {
                            rename_cell(apply_rule(row[index].clone(), rule), &renames)
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            if profile == Profile::CrossRoot {
                for row in &rows {
                    for cell in row {
                        assert_no_unresolved_identity(&name, cell);
                    }
                }
            }
            rows.sort();
            tables.insert(name, rows);
        }
        self.objects.sort();
        self.temps.sort();
        Normalized {
            tables,
            sequences: self.sequences,
            objects: self.objects,
            unexpected: self.unexpected,
            temps: self.temps,
        }
    }

    /// Bijective rename map over every identity domain, longest tokens first
    /// so a token that embeds another domain's shape is rewritten whole.
    fn identity_renames(&self) -> Vec<(String, String)> {
        let mut renames = Vec::new();
        for domain in IDENTITY_DOMAINS {
            // Earlier renames normalize cross-root identity text in ordering keys.
            let resolved = longest_token_first(&renames);
            let table = &self.tables[domain.table];
            let column = table
                .columns
                .iter()
                .position(|column| column == domain.column)
                .unwrap_or_else(|| panic!("{}.{} missing", domain.table, domain.column));
            // Identity ordinals sort by normalized columns, then dropped columns, then identity.
            // A dropped wall-clock column orders tied rows by creation within one root.
            // Its value never reaches the digest, so only the induced order carries over.
            let mut ordered = table
                .rows
                .iter()
                .map(|row| {
                    let Cell::Text(id) = &row[column] else {
                        panic!("{}.{} is not text", domain.table, domain.column);
                    };
                    let mut key = Vec::new();
                    let mut creation = Vec::new();
                    for (index, (cell, name)) in row.iter().zip(&table.columns).enumerate() {
                        if index == column {
                            continue;
                        }
                        let rule = column_rule(Profile::CrossRoot, domain.table, name);
                        if rule == Rule::Drop {
                            creation.push(cell.clone());
                        } else {
                            key.push(rename_cell(apply_rule(cell.clone(), rule), &resolved));
                        }
                    }
                    (key, creation, id.clone())
                })
                .collect::<Vec<_>>();
            ordered.sort();
            for (ordinal, (_, _, id)) in ordered.into_iter().enumerate() {
                renames.push((id, format!("<{}:{ordinal}>", domain.name)));
            }
        }
        longest_token_first(&renames)
    }
}

/// Orders longer tokens first so `replace_tokens` rewrites embedded identities whole.
fn longest_token_first(renames: &[(String, String)]) -> Vec<(String, String)> {
    let mut ordered = renames.to_vec();
    ordered.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
    ordered
}

struct IdentityDomain {
    name: &'static str,
    table: &'static str,
    column: &'static str,
}

const IDENTITY_DOMAINS: &[IdentityDomain] = &[
    IdentityDomain {
        name: "barrier",
        table: "deletion_backfill_barriers",
        column: "barrier_id",
    },
    IdentityDomain {
        name: "reservation",
        table: "artifact_ingestion_reservations",
        column: "reservation_id",
    },
    IdentityDomain {
        name: "abandonment",
        table: "consumer_abandonments",
        column: "abandonment_id",
    },
    IdentityDomain {
        name: "capture_pin",
        table: "capture_pins",
        column: "capture_pin_id",
    },
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Rule {
    Keep,
    Drop,
    /// Reduce to `Null` or `Integer(1)`: the value is wall-clock but its
    /// nullness is state. `expires_at IS NULL` means the caller pinned without
    /// expiry; `released_at IS NULL` defines an active pin; `terminal_at IS
    /// NULL` defines a live staging run.
    Presence,
}

fn column_rule(profile: Profile, table: &str, column: &str) -> Rule {
    let dropped: &[&str] = match (profile, table) {
        (_, "writer_fence") => &["writer_epoch"],
        (Profile::SameRoot, _) => &[],
        (Profile::CrossRoot, "mc_kernel_format_marker") => {
            &["database_incarnation_id", "marker_digest", "created_at"]
        }
        (Profile::CrossRoot, "commit_log") => &["writer_epoch", "recorded_at"],
        (Profile::CrossRoot, "outbox") => &["created_at"],
        (Profile::CrossRoot, "operation_receipts") => &["created_at"],
        (Profile::CrossRoot, "admission_decisions") => &["decided_at"],
        (Profile::CrossRoot, "capture_pins") => &["lease_epoch", "writer_epoch", "created_at"],
        (Profile::CrossRoot, "artifact_ingestion_reservations") => &[
            "writer_epoch",
            "created_at",
            "heartbeat_at",
            "lease_expires_at",
            "reclaim_started_at",
        ],
        (Profile::CrossRoot, _) => &[],
    };
    let presence: &[&str] = match table {
        "capture_pins" | "capture_pin_refs" => &["expires_at", "released_at"],
        "extraction_runs" | "candidates" => &["terminal_at"],
        _ => &[],
    };
    if dropped.contains(&column) {
        Rule::Drop
    } else if profile == Profile::CrossRoot && presence.contains(&column) {
        Rule::Presence
    } else {
        Rule::Keep
    }
}

fn apply_rule(cell: Cell, rule: Rule) -> Cell {
    match (rule, cell) {
        (Rule::Presence, Cell::Null) => Cell::Null,
        (Rule::Presence, _) => Cell::Integer(1),
        (_, cell) => cell,
    }
}

fn rename_cell(cell: Cell, renames: &[(String, String)]) -> Cell {
    if renames.is_empty() {
        return cell;
    }
    match cell {
        Cell::Text(text) => {
            let mut bytes = text.into_bytes();
            for (from, to) in renames {
                bytes = replace_tokens(&bytes, from.as_bytes(), to.as_bytes());
            }
            Cell::Text(String::from_utf8(bytes).unwrap())
        }
        Cell::Blob(mut bytes) => {
            for (from, to) in renames {
                bytes = replace_tokens(&bytes, from.as_bytes(), to.as_bytes());
            }
            Cell::Blob(bytes)
        }
        other => other,
    }
}

/// Replaces whole tokens only: a match adjoined by another identity
/// character on either side is a longer identity that merely contains
/// `from`, so it stays untouched and is later reported as unresolved.
fn replace_tokens(haystack: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    let is_identity_byte = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'-';
    let mut out = Vec::with_capacity(haystack.len());
    let mut index = 0;
    while index < haystack.len() {
        let rest = &haystack[index..];
        let continues = rest
            .get(from.len())
            .is_some_and(|&byte| is_identity_byte(byte));
        let preceded = index > 0 && is_identity_byte(haystack[index - 1]);
        if rest.starts_with(from) && !continues && !preceded {
            out.extend_from_slice(to);
            index += from.len();
        } else {
            out.push(haystack[index]);
            index += 1;
        }
    }
    out
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

/// Panics when a cell still carries a barrier- or reservation-shaped token
/// (`[artifact-deletion-]<64 hex>-<digits>`) after renaming: that token names
/// an identity no defining row declares, so the two roots cannot be compared.
fn assert_no_unresolved_identity(table: &str, cell: &Cell) {
    let bytes: &[u8] = match cell {
        Cell::Text(text) => text.as_bytes(),
        Cell::Blob(bytes) => bytes,
        _ => return,
    };
    for index in 0..bytes.len().saturating_sub(65) {
        let window = &bytes[index..index + 64];
        let preceded_by_hex = index > 0 && is_lower_hex(bytes[index - 1]);
        if !preceded_by_hex
            && window.iter().copied().all(is_lower_hex)
            && bytes[index + 64] == b'-'
            && bytes[index + 65].is_ascii_digit()
        {
            let token = String::from_utf8_lossy(&bytes[index.saturating_sub(18)..]);
            panic!(
                "{table} references an identity no defining row declares: {}",
                token.chars().take(96).collect::<String>()
            );
        }
    }
}

/// Verify the marker digest here, since a normalized comparison no longer covers it.
///
/// `read_valid_marker` recomputes it on open, so a corrupted value must not compare equal.
fn verify_format_marker(tables: &BTreeMap<String, Table>) {
    let Some(table) = tables.get("mc_kernel_format_marker") else {
        return;
    };
    let column = |name: &str| {
        table
            .columns
            .iter()
            .position(|column| column == name)
            .unwrap_or_else(|| panic!("mc_kernel_format_marker.{name} missing"))
    };
    let epoch = column("format_epoch");
    let incarnation = column("database_incarnation_id");
    let schema = column("schema_digest");
    let created = column("created_at");
    let marker = column("marker_digest");
    for row in &table.rows {
        let (
            Cell::Integer(format_epoch),
            Cell::Text(incarnation_id),
            Cell::Text(schema_digest),
            Cell::Integer(created_at),
            Cell::Text(marker_digest),
        ) = (
            &row[epoch],
            &row[incarnation],
            &row[schema],
            &row[created],
            &row[marker],
        )
        else {
            panic!("mc_kernel_format_marker holds an unexpected column type");
        };
        let expected = compute_marker_digest_for_application_id(
            KERNEL_APPLICATION_ID,
            *format_epoch,
            incarnation_id,
            schema_digest,
            *created_at,
        );
        assert_eq!(
            marker_digest, &expected,
            "mc_kernel_format_marker.marker_digest does not match its own row"
        );
    }
}

/// A stored cell that already reads as a placeholder collides with a renamed identity.
///
/// The healthy root normalizes a minted id to the same literal, so the two would compare equal.
fn assert_no_placeholder_syntax(tables: &BTreeMap<String, Table>) {
    for (name, table) in tables {
        for row in &table.rows {
            for cell in row {
                let bytes: &[u8] = match cell {
                    Cell::Text(text) => text.as_bytes(),
                    Cell::Blob(bytes) => bytes,
                    _ => continue,
                };
                for domain in IDENTITY_DOMAINS {
                    let needle = format!("<{}:", domain.name);
                    if bytes
                        .windows(needle.len())
                        .any(|window| window == needle.as_bytes())
                    {
                        panic!(
                            "{name} already holds the {} placeholder syntax",
                            domain.name
                        );
                    }
                }
            }
        }
    }
}

/// The live schema and the header values `KernelStore` checks when it opens a database.
///
/// A dropped trigger or a rewritten `user_version` leaves every table row intact.
fn schema_identity_rows(root: &Path) -> Vec<Vec<Cell>> {
    let connection = open_read_only(root);
    let mut rows = connection
        .prepare(
            "SELECT type,name,COALESCE(sql,'') FROM sqlite_master
             WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .unwrap()
        .query_map([], |row| {
            Ok(vec![
                Cell::Text(row.get::<_, String>(0)?),
                Cell::Text(row.get::<_, String>(1)?),
                Cell::Text(row.get::<_, String>(2)?),
            ])
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for pragma in ["application_id", "user_version"] {
        let value: i64 = connection
            .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get(0))
            .unwrap();
        rows.push(vec![
            Cell::Text(pragma.to_string()),
            Cell::Integer(value),
            Cell::Null,
        ]);
    }
    rows
}

/// Owner and permission bits of the CAS directory chain.
///
/// `open_secure_directory` refuses a directory that is not owner-only, so the mode is state.
fn layout_rows(root: &Path) -> Vec<Vec<Cell>> {
    let mut rows = Vec::new();
    for relative in ["artifacts", "artifacts/objects", "artifacts/tmp"] {
        let Ok(metadata) = fs::symlink_metadata(root.join(relative)) else {
            continue;
        };
        rows.push(vec![
            Cell::Text(relative.to_string()),
            Cell::Integer(i64::from(metadata.uid())),
            Cell::Integer(i64::from(metadata.permissions().mode() & 0o7777)),
        ]);
    }
    rows
}

fn hash_rows(rows: &[Vec<Cell>]) -> String {
    let mut hasher = Sha256::new();
    hasher.update((rows.len() as u64).to_le_bytes());
    for row in rows {
        hasher.update((row.len() as u64).to_le_bytes());
        for cell in row {
            cell.feed(&mut hasher);
        }
    }
    format!("{:x}", hasher.finalize())
}

fn open_read_only(root: &Path) -> Connection {
    Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn table_names(connection: &Connection) -> Vec<String> {
    connection
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn columns_of(connection: &Connection, table: &str) -> Vec<String> {
    connection
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// The `AUTOINCREMENT` high-water mark per table, empty until such a table is written.
///
/// `outbox.outbox_position` is declared `INTEGER PRIMARY KEY AUTOINCREMENT`.
/// Pruning every emitted row leaves this counter as the only record of the next position.
fn read_sequences(connection: &Connection) -> Vec<(String, i64)> {
    let present = connection
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
        .unwrap()
        .exists([])
        .unwrap();
    if !present {
        return Vec::new();
    }
    let mut rows = connection
        .prepare("SELECT name,seq FROM sqlite_sequence")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    rows.sort();
    rows
}

/// Every published CAS object as `(digest, byte_length)`, verifying each
/// object's bytes hash to its path. Missing `artifacts/objects` reads as empty.
/// Only two-character lowercase-hex shards hold objects.
pub fn scan_objects(root: &Path) -> Vec<(String, u64)> {
    let objects = root.join("artifacts/objects");
    let Some(shards) = read_dir_or_absent(&objects) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for shard in shards {
        let shard = shard.unwrap();
        if !shard.file_type().unwrap().is_dir() {
            continue;
        }
        let prefix = shard.file_name().into_string().unwrap();
        if prefix.len() != 2 || !prefix.bytes().all(is_lower_hex) {
            continue;
        }
        for entry in fs::read_dir(shard.path()).unwrap() {
            let entry = entry.unwrap();
            if !entry.file_type().unwrap().is_file() {
                continue;
            }
            let digest = format!("{prefix}{}", entry.file_name().to_string_lossy());
            let bytes = fs::read(entry.path()).unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(&bytes)),
                digest,
                "object bytes do not hash to their path"
            );
            result.push((digest, bytes.len() as u64));
        }
    }
    result.sort();
    result
}

/// Every file left under `artifacts/tmp` as `(depth, sha256(bytes), byte_length)`.
///
/// Names are excluded because they embed the per-process `next_unique_id()`;
/// the content digest is what a leaked plaintext copy of a purged artifact
/// shares across roots. Missing `artifacts/tmp` reads as empty.
/// `prepare_layout` unlinks only files and symlinks, so a directory here survives a restart.
pub fn scan_temps(root: &Path) -> Vec<(u64, String, u64)> {
    let Some(entries) = read_dir_or_absent(&root.join("artifacts/tmp")) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for entry in entries {
        collect_file_digests(&entry.unwrap().path(), 0, &mut result);
    }
    result.sort();
    result
}

/// `None` for an absent directory, panicking on every other error.
///
/// Treating an unreadable CAS directory as empty would make its digest equal an empty store's.
fn read_dir_or_absent(path: &Path) -> Option<fs::ReadDir> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            panic!("{} is a symlink", path.display())
        }
        Ok(metadata) if !metadata.is_dir() => panic!("{} is not a directory", path.display()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => panic!("cannot stat {}: {error}", path.display()),
    }
    match fs::read_dir(path) {
        Ok(entries) => Some(entries),
        Err(error) => panic!("cannot read {}: {error}", path.display()),
    }
}

/// Hash regular files outside valid shards so digest comparison detects unexpected CAS state.
///
/// Content digests are recorded instead of names, as `scan_temps` does.
pub fn scan_unexpected_objects(root: &Path) -> Vec<(u64, String, u64)> {
    let Some(entries) = read_dir_or_absent(&root.join("artifacts/objects")) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.unwrap();
        let name = entry.file_name().into_string().unwrap();
        let is_shard = entry.file_type().unwrap().is_dir()
            && name.len() == 2
            && name.bytes().all(is_lower_hex);
        if !is_shard {
            collect_file_digests(&entry.path(), 0, &mut result);
            continue;
        }
        // Only a regular file inside a shard is an object, so anything else is stray state.
        for inner in fs::read_dir(entry.path()).unwrap() {
            let inner = inner.unwrap().path();
            if !fs::symlink_metadata(&inner).unwrap().is_file() {
                collect_file_digests(&inner, 1, &mut result);
            }
        }
    }
    result.sort();
    result
}

/// Symlinks are excluded rather than followed.
///
/// `depth` accompanies each digest because `regular_file_bytes` charges a root-level file but
/// descends only one level, so the same bytes cost different usage at different depths.
fn collect_file_digests(path: &Path, depth: u64, out: &mut Vec<(u64, String, u64)>) {
    let metadata = fs::symlink_metadata(path).unwrap();
    if metadata.is_dir() {
        for entry in fs::read_dir(path).unwrap() {
            collect_file_digests(&entry.unwrap().path(), depth + 1, out);
        }
    } else if metadata.is_file() {
        let bytes = fs::read(path).unwrap();
        out.push((
            depth,
            format!("{:x}", Sha256::digest(&bytes)),
            bytes.len() as u64,
        ));
    }
}
