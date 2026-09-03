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
//! | `artifact_ingestion_reservations` | `created_at`, `heartbeat_at`, `lease_expires_at`, `reclaim_started_at`; `writer_epoch` reduced to whether it matches the `writer_fence` epoch |
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
//!
//! A caller-supplied instant stays `Rule::Keep`, because it is part of the history.
//! `deletion_backfill_barriers.created_at` takes the deletion request's `deleted_at`.
//! `consumer_abandonments.abandoned_at` arrives on the abandonment request.
//! `completed_at` and `acknowledged_at` are threaded from that same caller value.
//! Neither `outbox.rs` nor `cas/deletion.rs` reads the clock at all.
//! A cross-root proof must therefore pass one fixed instant to both roots.

#![allow(dead_code)]

/// Stands in for a content digest, which is 64 hex characters and cannot collide with it.
const DIRECTORY_MARKER: &str = "<directory>";

/// Stands in for a content digest, which is 64 hex characters.
const SYMLINK_MARKER: &str = "<symlink>";

/// `cortexkit_lease::EPOCH_WIDTH`, the fixed byte width of a persisted lease epoch.
const LEASE_EPOCH_WIDTH: usize = 20;

/// `(depth, relative path, content digest, byte length)`.
type CasEntry = (u64, String, String, u64);

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

use mc_kernel::schema::KERNEL_APPLICATION_ID;
use mc_kernel::sqlite_runtime::compute_marker_digest_for_application_id;
use mc_kernel::{reset_marker_is_valid_for_test, restore_marker_is_valid_for_test};

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
    let object_digests = normalized
        .objects
        .iter()
        .map(|(digest, _)| digest.clone())
        .collect::<Vec<_>>();
    let object_rows = normalized
        .objects
        .into_iter()
        .map(|(digest, len)| vec![Cell::Text(digest), Cell::Integer(len as i64)])
        .collect::<Vec<_>>();
    tables.insert("cas_objects".to_string(), hash_rows(&object_rows));
    let temp_rows = normalized
        .temps
        .into_iter()
        .map(|(depth, name, digest, len)| {
            vec![
                Cell::Integer(depth as i64),
                Cell::Text(name),
                Cell::Text(digest),
                Cell::Integer(len as i64),
            ]
        })
        .collect::<Vec<_>>();
    tables.insert("cas_temps".to_string(), hash_rows(&temp_rows));
    let unexpected_rows = normalized
        .unexpected
        .into_iter()
        .map(|(depth, name, digest, len)| {
            vec![
                Cell::Integer(depth as i64),
                Cell::Text(name),
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
        hash_rows(&normalized.identity),
    );
    tables.insert("cas_layout".to_string(), hash_rows(&layout_rows(root)));
    tables.insert("leases".to_string(), hash_rows(&lease_rows(root)));
    tables.insert(
        "recovery_markers".to_string(),
        hash_rows(&recovery_marker_rows(root, profile)),
    );
    let metadata_rows = scan_object_metadata(root, &object_digests)
        .into_iter()
        .map(|(digest, uid, mode, links)| {
            vec![
                Cell::Text(digest),
                Cell::Integer(i64::from(uid)),
                Cell::Integer(i64::from(mode)),
                Cell::Integer(links as i64),
            ]
        })
        .collect::<Vec<_>>();
    tables.insert("cas_object_metadata".to_string(), hash_rows(&metadata_rows));
    CanonicalDigest { tables }
}

/// Every `(table, column)` in the live schema whose name reads as an instant or an epoch and
/// which `CrossRoot` still compares exactly.
///
/// `column_rule` is a hand-written match, so a new stamp on an existing table would otherwise
/// fall through to `Rule::Keep` unnoticed. A proof pins this set, which forces a decision.
pub fn cross_root_compared_clock_columns(root: &Path) -> BTreeSet<String> {
    let connection = open_read_only(root);
    let mut compared = BTreeSet::new();
    for table in table_names(&connection) {
        for column in columns_of(&connection, &table) {
            let reads_as_clock = column.ends_with("_at") || column.contains("epoch");
            if reads_as_clock && column_rule(Profile::CrossRoot, &table, &column) == Rule::Keep {
                compared.insert(format!("{table}.{column}"));
            }
        }
    }
    compared
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
    identity: Vec<Vec<Cell>>,
    sequences: Vec<(String, i64)>,
    objects: Vec<(String, u64)>,
    unexpected: Vec<CasEntry>,
    temps: Vec<CasEntry>,
}

struct Normalized {
    tables: BTreeMap<String, Vec<Vec<Cell>>>,
    identity: Vec<Vec<Cell>>,
    sequences: Vec<(String, i64)>,
    objects: Vec<(String, u64)>,
    unexpected: Vec<CasEntry>,
    temps: Vec<CasEntry>,
}

impl State {
    fn read(root: &Path) -> Self {
        // `prepare_private_dir` stats the root without following, and requires a directory.
        let root_metadata = fs::symlink_metadata(root).unwrap();
        assert!(
            root_metadata.is_dir() && !root_metadata.file_type().is_symlink(),
            "{} is not a directory",
            root.display()
        );
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
                                ValueRef::Real(value) => Cell::Real(canonical_real_bits(value)),
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
        verify_lease_epoch(root, &tables);
        Self {
            identity: schema_identity_rows(&connection),
            tables,
            sequences: read_sequences(&connection),
            objects: scan_objects(root),
            unexpected: scan_unexpected_objects(root),
            temps: scan_temps(root),
        }
    }

    fn normalize(mut self, profile: Profile) -> Normalized {
        let current_writer = current_writer_epoch(&self.tables);
        let renames = match profile {
            Profile::SameRoot => Vec::new(),
            Profile::CrossRoot => {
                assert_no_placeholder_syntax(&self.tables);
                self.identity_renames(current_writer)
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
                            rename_cell(
                                apply_rule(row[index].clone(), rule, current_writer),
                                &renames,
                            )
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
            identity: self.identity,
            sequences: self.sequences,
            objects: self.objects,
            unexpected: self.unexpected,
            temps: self.temps,
        }
    }

    /// Bijective rename map over every identity domain, longest tokens first
    /// so a token that embeds another domain's shape is rewritten whole.
    fn identity_renames(&self, current_writer: Option<i64>) -> Vec<(String, String)> {
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
                            key.push(rename_cell(
                                apply_rule(cell.clone(), rule, current_writer),
                                &resolved,
                            ));
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
    /// Reduce to whether the value equals the store's current writer epoch.
    ///
    /// `prepare_reclaim` treats a live reservation as protective only on an epoch match, so the
    /// relationship is state even though the epoch itself is per-root.
    CurrentWriter,
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
            "created_at",
            "heartbeat_at",
            "lease_expires_at",
            "reclaim_started_at",
        ],
        (Profile::CrossRoot, _) => &[],
    };
    if profile == Profile::CrossRoot
        && table == "artifact_ingestion_reservations"
        && column == "writer_epoch"
    {
        return Rule::CurrentWriter;
    }
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

fn apply_rule(cell: Cell, rule: Rule, current_writer: Option<i64>) -> Cell {
    match (rule, cell) {
        (Rule::Presence, Cell::Null) => Cell::Null,
        (Rule::Presence, _) => Cell::Integer(1),
        (Rule::CurrentWriter, Cell::Integer(epoch)) => {
            Cell::Integer(i64::from(current_writer == Some(epoch)))
        }
        (_, cell) => cell,
    }
}

/// The `writer_fence` epoch, which every other epoch is compared against.
fn current_writer_epoch(tables: &BTreeMap<String, Table>) -> Option<i64> {
    let table = tables.get("writer_fence")?;
    let index = table
        .columns
        .iter()
        .position(|column| column == "writer_epoch")?;
    match table.rows.first()?.get(index)? {
        Cell::Integer(epoch) => Some(*epoch),
        _ => None,
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

/// Collapses the `f64` encodings SQL treats as one value.
///
/// `to_bits` separates `-0.0` from `0.0` and one NaN payload from another, so two roots that
/// reached an equal score by different arithmetic would digest apart.
fn canonical_real_bits(value: f64) -> u64 {
    if value == 0.0 {
        0.0f64.to_bits()
    } else if value.is_nan() {
        f64::NAN.to_bits()
    } else {
        value.to_bits()
    }
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
    // `replace_tokens` skips a match adjoined by another identity byte, so a token sitting
    // directly after a hex byte is neither renamed nor reported if this scan skips it too.
    for index in 0..bytes.len().saturating_sub(65) {
        let window = &bytes[index..index + 64];
        if window.iter().copied().all(is_lower_hex)
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
fn schema_identity_rows(connection: &Connection) -> Vec<Vec<Cell>> {
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
    let mut paths = vec![
        "artifacts".to_string(),
        "artifacts/objects".to_string(),
        "artifacts/tmp".to_string(),
    ];
    // A shard opens through the same owner-only check, so its mode is state too.
    if let Ok(entries) = fs::read_dir(root.join("artifacts/objects")) {
        for entry in entries {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().unwrap().is_dir() && name.len() == 2 {
                paths.push(format!("artifacts/objects/{name}"));
            }
        }
    }
    paths.sort();
    for relative in paths {
        let Ok(metadata) = fs::symlink_metadata(root.join(&relative)) else {
            continue;
        };
        rows.push(vec![
            Cell::Text(relative),
            Cell::Integer(i64::from(metadata.uid())),
            Cell::Integer(i64::from(metadata.permissions().mode() & 0o7777)),
        ]);
    }
    rows
}

/// The persisted leases: how many are well-formed, plus one row per entry that is not.
///
/// A lease file name is an FNV hash of the key identity and its body is an epoch, so neither
/// travels across roots. `FileLeaseStore::acquire` opens the entry as a regular file and reads
/// its epoch before the database opens, so an entry it would reject is state distinct from a
/// healthy lease, and a count alone would let a directory or an unparseable body pass as one.
fn lease_rows(root: &Path) -> Vec<Vec<Cell>> {
    let Ok(entries) = fs::read_dir(root.join("leases")) else {
        return Vec::new();
    };
    let mut valid = 0i64;
    let mut invalid = Vec::new();
    for entry in entries {
        let path = entry.unwrap().path();
        if !path.to_string_lossy().ends_with(".lease") {
            continue;
        }
        match lease_epoch(&path) {
            Ok(_) => valid += 1,
            Err(kind) => invalid.push(kind),
        }
    }
    invalid.sort();
    let mut rows = vec![vec![Cell::Text("valid".to_string()), Cell::Integer(valid)]];
    rows.extend(invalid.into_iter().map(|kind| vec![Cell::Text(kind)]));
    rows
}

/// Reads a lease entry the way the lease store does, or names why it cannot.
///
/// `persist_epoch` pads a short file with `x` before overwriting from offset 0, so a surviving
/// `x` marks a torn write rather than a digit to strip. Only a complete zero-padded epoch is a
/// healthy lease; anything else is invalid content, not a lower epoch.
fn lease_epoch(path: &Path) -> Result<i64, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("<unreadable:{error}>"))?;
    if metadata.file_type().is_symlink() {
        return Err(SYMLINK_MARKER.to_string());
    }
    if metadata.is_dir() {
        return Err(DIRECTORY_MARKER.to_string());
    }
    if !metadata.is_file() {
        return Err(format!(
            "<other:{:o}>",
            metadata.permissions().mode() & 0o170000
        ));
    }
    let text = fs::read_to_string(path).map_err(|error| format!("<unreadable:{error}>"))?;
    if text.len() != LEASE_EPOCH_WIDTH || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("<invalid-epoch>".to_string());
    }
    text.parse::<i64>()
        .map_err(|_| "<invalid-epoch>".to_string())
}

/// The persisted lease epoch cannot trail the fence the database was stamped with.
///
/// `writer_fence` takes its epoch from the lease store at open, so a lease store that was
/// deleted or rolled back hands the next writer an epoch a committed row already used.
fn verify_lease_epoch(root: &Path, tables: &BTreeMap<String, Table>) {
    let Some(fence) = current_writer_epoch(tables) else {
        return;
    };
    let Ok(entries) = fs::read_dir(root.join("leases")) else {
        return;
    };
    let mut persisted = None;
    for entry in entries {
        let path = entry.unwrap().path();
        if !path.to_string_lossy().ends_with(".lease") {
            continue;
        }
        // An entry the lease store would reject is recorded by `lease_rows`; only a
        // well-formed epoch can be compared against the fence.
        if let Ok(epoch) = lease_epoch(&path) {
            persisted = Some(persisted.unwrap_or(epoch).max(epoch));
        }
    }
    if let Some(epoch) = persisted {
        assert!(
            epoch >= fence,
            "lease epoch {epoch} trails the writer_fence epoch {fence}"
        );
    }
}

/// The recovery markers `KernelStore::open` inspects before it opens the live family.
///
/// An invalid marker makes the next open fail, so its presence and contents are state.
fn recovery_marker_rows(root: &Path, profile: Profile) -> Vec<Vec<Cell>> {
    let database = root.join("core.sqlite");
    let mut rows = Vec::new();
    for suffix in [".mc-restore", ".mc-reset", ".mc-reset.staging"] {
        let path = root.join(format!("core.sqlite{suffix}"));
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        let content = if metadata.is_file() {
            if profile == Profile::CrossRoot {
                // A marker's fields are all per-root: the absolute database and recovery
                // paths, a random incarnation, and a digest over those. Only one root's own
                // history can compare its bytes. What travels is whether the next open would
                // accept it, so the kernel's own validation decides the cell. The staging
                // file is a torn publish the kernel never reads, so only its presence is state.
                let valid = match suffix {
                    ".mc-restore" => Some(restore_marker_is_valid_for_test(&database)),
                    ".mc-reset" => Some(reset_marker_is_valid_for_test(&database)),
                    _ => None,
                };
                match valid {
                    Some(true) => Cell::Text("<valid>".to_string()),
                    Some(false) => Cell::Text("<invalid>".to_string()),
                    None => Cell::Integer(1),
                }
            } else {
                let bytes = fs::read(&path).unwrap();
                Cell::Text(format!("{:x}", Sha256::digest(&bytes)))
            }
        } else if metadata.file_type().is_symlink() {
            Cell::Text(SYMLINK_MARKER.to_string())
        } else if metadata.is_dir() {
            Cell::Text(DIRECTORY_MARKER.to_string())
        } else {
            // A fifo, socket, or device left here is not a directory and must not read as one.
            Cell::Text(format!(
                "<other:{:o}>",
                metadata.permissions().mode() & 0o170000
            ))
        };
        rows.push(vec![Cell::Text(suffix.to_string()), content]);
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
    let path = root.join("core.sqlite");
    // `KernelStore::open` inspects this file without following, and refuses a symlink.
    let metadata = fs::symlink_metadata(&path).unwrap();
    assert!(
        !metadata.file_type().is_symlink(),
        "{} is a symlink",
        path.display()
    );
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
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
    let Some(shards) = read_dir_or_absent(root, "artifacts/objects") else {
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
pub fn scan_temps(root: &Path) -> Vec<CasEntry> {
    let Some(entries) = read_dir_or_absent(root, "artifacts/tmp") else {
        return Vec::new();
    };
    let mut collected = Vec::new();
    for entry in entries {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        collect_file_digests(&entry.path(), &name, 0, &mut collected);
    }
    let mut result = collected
        .into_iter()
        .map(|(depth, relative, digest, len)| {
            (depth, temp_stem(last_component(&relative)), digest, len)
        })
        .collect::<Vec<_>>();
    result.sort();
    result
}

/// `None` for an absent directory, panicking on every other error.
///
/// Treating an unreadable CAS directory as empty would make its digest equal an empty store's.
fn read_dir_or_absent(root: &Path, relative: &str) -> Option<fs::ReadDir> {
    let mut path = root.to_path_buf();
    // Every component is checked, since an intermediate symlink also invalidates the layout.
    for component in relative.split('/') {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                panic!("{} is a symlink", path.display())
            }
            Ok(metadata) if !metadata.is_dir() => panic!("{} is not a directory", path.display()),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => panic!("cannot stat {}: {error}", path.display()),
        }
    }
    match fs::read_dir(&path) {
        Ok(entries) => Some(entries),
        Err(error) => panic!("cannot read {}: {error}", path.display()),
    }
}

/// Owner, mode, and link count of every published object.
///
/// `open_regular_nofollow` refuses an object whose `nlink` is not 1, whose owner is not the
/// caller, or whose mode intersects `0o177`, so all three decide whether the artifact reads.
pub fn scan_object_metadata(root: &Path, digests: &[String]) -> Vec<(String, u32, u32, u64)> {
    let mut result = Vec::new();
    for digest in digests {
        let path = root.join(format!(
            "artifacts/objects/{}/{}",
            &digest[..2],
            &digest[2..]
        ));
        let metadata = fs::symlink_metadata(&path).unwrap();
        result.push((
            digest.clone(),
            metadata.uid(),
            metadata.permissions().mode() & 0o7777,
            metadata.nlink(),
        ));
    }
    result.sort();
    result
}

/// Hash regular files outside valid shards so digest comparison detects unexpected CAS state.
///
/// Content digests are recorded instead of names, as `scan_temps` does.
pub fn scan_unexpected_objects(root: &Path) -> Vec<CasEntry> {
    let Some(entries) = read_dir_or_absent(root, "artifacts/objects") else {
        return Vec::new();
    };
    let mut collected = Vec::new();
    for entry in entries {
        let entry = entry.unwrap();
        let name = entry.file_name().into_string().unwrap();
        let is_shard = entry.file_type().unwrap().is_dir()
            && name.len() == 2
            && name.bytes().all(is_lower_hex);
        if !is_shard {
            collect_file_digests(&entry.path(), &name, 0, &mut collected);
            continue;
        }
        // Only a regular file inside a shard is an object, so anything else is stray state.
        for inner in fs::read_dir(entry.path()).unwrap() {
            let inner = inner.unwrap();
            let path = inner.path();
            if !fs::symlink_metadata(&path).unwrap().is_file() {
                let relative = format!("{name}/{}", inner.file_name().to_string_lossy());
                collect_file_digests(&path, &relative, 1, &mut collected);
            }
        }
    }
    let mut result = collected;
    result.sort();
    result
}

/// Symlinks are excluded rather than followed.
///
/// `depth` accompanies each digest because `regular_file_bytes` charges a root-level file but
/// descends only one level, so the same bytes cost different usage at different depths.
fn collect_file_digests(path: &Path, relative: &str, depth: u64, out: &mut Vec<CasEntry>) {
    let metadata = fs::symlink_metadata(path).unwrap();
    if metadata.file_type().is_symlink() {
        // A symlink at a future digest path fails a no-replace publication.
        out.push((depth, relative.to_string(), SYMLINK_MARKER.to_string(), 0));
    } else if metadata.is_dir() {
        // A directory holding no regular file would otherwise read the same as its absence.
        out.push((depth, relative.to_string(), DIRECTORY_MARKER.to_string(), 0));
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let child = format!("{relative}/{}", entry.file_name().to_string_lossy());
            collect_file_digests(&entry.path(), &child, depth + 1, out);
        }
    } else if metadata.is_file() {
        let bytes = fs::read(path).unwrap();
        out.push((
            depth,
            relative.to_string(),
            format!("{:x}", Sha256::digest(&bytes)),
            bytes.len() as u64,
        ));
    }
}

/// The final component of a relative path.
fn last_component(relative: &str) -> &str {
    relative.rsplit('/').next().unwrap_or(relative)
}

/// The part of a temp name that is state, with the process-unique counter removed.
///
/// `sweep_digest_temps` unlinks only names starting with `.artifact-{digest}-`.
/// The stem therefore decides whether a purge of that artifact removes the plaintext.
fn temp_stem(name: &str) -> String {
    let base = name.strip_suffix(".tmp").unwrap_or(name);
    match base.rsplit_once('-') {
        Some((stem, counter))
            if !counter.is_empty() && counter.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            stem.to_string()
        }
        _ => String::new(),
    }
}
