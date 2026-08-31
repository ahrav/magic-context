//!
//! This module persists each session's `cortexkit-cache-core` [`CoreState`] and `module_meta`.
//! `module_meta` stores `initialized`, `last_render_config`, and `coverage_ordinal`.
//!
//! Concurrency: writes go through `cortexkit-store`'s epoch-fenced transaction
//! The `row_version` CAS runs inside the epoch-fenced transaction.
//! The epoch fence rejects only strictly newer writers.
//! Equal-epoch writers are not fenced; `row_version` CAS detects same-epoch conflicts.
//! The persistence pass uses `row_version` CAS to catch a second same-epoch writer and writes conditionally.
//! A pass writes only when durable state changed; a pure SoftPlus replay writes nothing.
//! A deferred pass performs no write.

#![forbid(unsafe_code)]

pub mod claim_mirror;
pub mod sqlite_runtime;

use cortexkit_cache_core::{CoreState, DurabilityClass, FrozenUnit};
use cortexkit_store::{open_sqlite, Migration, SqliteStore, StoreError};
use cortexkit_store_types::StorageDescriptor;
use flate2::{read::DeflateDecoder, write::DeflateEncoder, Compression};
use mc_core::claim_operation::{
    canonical_json_encode, canonical_snapshot_vector, compute_claim_operation_request_digest,
    decode_claim_operation_result, is_lower_hex, ClaimCommandIdentity, ClaimIntentAckKind,
    ClaimIntentBinding, ClaimIntentState, ClaimResultOutcome, SnapshotVector,
    CLAIM_REQUEST_ENCODING_VERSION,
};
use rusqlite::{functions::FunctionFlags, params, types::Value as SqlValue, OptionalExtension};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::{Cursor, Error, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

pub type ProviderExtras = BTreeMap<String, BTreeMap<String, Value>>;

static NEXT_TAG_CACHE_NAMESPACE: AtomicU64 = AtomicU64::new(1);

///
/// Transform and facade lanes can observe the same directory through different spellings when
/// a project is reached through a symlink. Comparing those spellings as strings would make a
/// valid session look unresolved, so filesystem roots share this boundary normalization. A root
/// `canonical_root` retains the input spelling when canonicalization fails so requests do not fail for removed roots.
pub fn canonical_root(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub synthetic: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub summary: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub errored: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish: Option<String>,
    /// `created_at_ms` stores the harness-provided creation time for temporal compartment headings without affecting message identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageOrigin {
    pub provider: String,
    pub model: String,
    pub api: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CkWireMessage {
    pub role: String,
    pub content: Vec<CkWireBlock>,
    pub origin: Option<MessageOrigin>,
    pub provider_extras: ProviderExtras,
    pub meta: HarnessMeta,
    /// `original` retains parsed JSON for pass-through messages and must remain a `Value` rather than a typed-struct round-trip.
    /// Value-level: serializing this retained value, never a typed-struct round-trip,
    /// preserves harmless unknown fields and keeps replay lossless as the CK wire evolves.
    original: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CkWireMessageData {
    pub role: String,
    pub content: Vec<CkWireBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<MessageOrigin>,
    #[serde(default, skip_serializing_if = "ProviderExtras::is_empty")]
    pub provider_extras: ProviderExtras,
    #[serde(default)]
    pub meta: HarnessMeta,
}

impl<'de> Deserialize<'de> for CkWireMessage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let original = Value::deserialize(deserializer)?;
        let data =
            CkWireMessageData::deserialize(original.clone()).map_err(serde::de::Error::custom)?;
        Ok(Self {
            role: data.role,
            content: data.content,
            origin: data.origin,
            provider_extras: data.provider_extras,
            meta: data.meta,
            original: Some(original),
        })
    }
}

impl Serialize for CkWireMessage {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if let Some(original) = &self.original {
            return original.serialize(serializer);
        }
        CkWireMessageData {
            role: self.role.clone(),
            content: self.content.clone(),
            origin: self.origin.clone(),
            provider_extras: self.provider_extras.clone(),
            meta: self.meta.clone(),
        }
        .serialize(serializer)
    }
}

impl CkWireMessage {
    pub fn from_parts(
        role: impl Into<String>,
        content: Vec<CkWireBlock>,
        origin: Option<MessageOrigin>,
        provider_extras: ProviderExtras,
        meta: HarnessMeta,
    ) -> Self {
        Self {
            role: role.into(),
            content,
            origin,
            provider_extras,
            meta,
            original: None,
        }
    }

    pub fn synthetic_user_text(text: impl Into<String>) -> Self {
        Self::from_parts(
            "user",
            vec![CkWireBlock::bare(CkKind::Text { text: text.into() })],
            None,
            ProviderExtras::new(),
            HarnessMeta {
                synthetic: true,
                ..Default::default()
            },
        )
    }

    pub fn mark_modified(&mut self) {
        self.original = None;
    }

    fn mark_fully_typed(&mut self) {
        self.original = None;
        for block in &mut self.content {
            block.mark_modified();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CkWireBlock {
    pub kind: CkKind,
    pub provider_extras: ProviderExtras,
    /// Serializing retained block JSON directly preserves unknown fields.
    original: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CkWireBlockData {
    pub kind: CkKind,
    #[serde(default, skip_serializing_if = "ProviderExtras::is_empty")]
    pub provider_extras: ProviderExtras,
}

impl<'de> Deserialize<'de> for CkWireBlock {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let original = Value::deserialize(deserializer)?;
        let data =
            CkWireBlockData::deserialize(original.clone()).map_err(serde::de::Error::custom)?;
        Ok(Self {
            kind: data.kind,
            provider_extras: data.provider_extras,
            original: Some(original),
        })
    }
}

impl Serialize for CkWireBlock {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if let Some(original) = &self.original {
            return original.serialize(serializer);
        }
        CkWireBlockData {
            kind: self.kind.clone(),
            provider_extras: self.provider_extras.clone(),
        }
        .serialize(serializer)
    }
}

impl CkWireBlock {
    pub fn bare(kind: CkKind) -> Self {
        Self {
            kind,
            provider_extras: ProviderExtras::new(),
            original: None,
        }
    }

    pub fn with_provider_extras(kind: CkKind, provider_extras: ProviderExtras) -> Self {
        Self {
            kind,
            provider_extras,
            original: None,
        }
    }

    /// Mutators must clear `original` after editing typed content so serialization emits the edit.
    /// Every mutator that edits `kind` through a live block must clear `original`.
    /// `Serialize` prefers `original` for lossless pass-through.
    /// pass-through, so an uncleared block silently serializes its pre-mutation
    /// bytes and the edit never reaches the wire.
    pub fn mark_modified(&mut self) {
        self.original = None;
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CkKind {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    RedactedReasoning {
        data: String,
    },
    ToolCall {
        id: String,
        name: String,
        input: Value,
        #[serde(default)]
        provider_executed: bool,
    },
    ToolResult {
        id: String,
        tool_name: String,
        output: CkToolOutput,
        #[serde(default)]
        provider_executed: bool,
    },
    Media(MediaBlock),
    Opaque(OpaqueBlock),
}

impl CkKind {
    pub fn tag(&self) -> &'static str {
        match self {
            CkKind::Text { .. } => "text",
            CkKind::Reasoning { .. } => "reasoning",
            CkKind::RedactedReasoning { .. } => "redacted_reasoning",
            CkKind::ToolCall { .. } => "tool_call",
            CkKind::ToolResult { .. } => "tool_result",
            CkKind::Media(_) => "media",
            CkKind::Opaque(_) => "opaque",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CkToolOutput {
    pub kind: CkOutputKind,
    #[serde(default, skip_serializing_if = "ProviderExtras::is_empty")]
    pub provider_extras: ProviderExtras,
}

impl CkToolOutput {
    pub fn bare(kind: CkOutputKind) -> Self {
        Self {
            kind,
            provider_extras: ProviderExtras::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CkOutputKind {
    Text { text: String },
    Json { value: Value },
    ErrorText { text: String },
    ErrorJson { value: Value },
    ExecutionDenied { reason: Option<String> },
    Content { blocks: Vec<ResultBlock> },
    // Error-flagged content arrays keep their own variant so failure state survives
    // decode/encode; errors are output variants here, never a sibling flag.
    ErrorContent { blocks: Vec<ResultBlock> },
}

impl CkOutputKind {
    pub fn tag(&self) -> &'static str {
        match self {
            CkOutputKind::Text { .. } => "text",
            CkOutputKind::Json { .. } => "json",
            CkOutputKind::ErrorText { .. } => "error_text",
            CkOutputKind::ErrorJson { .. } => "error_json",
            CkOutputKind::ExecutionDenied { .. } => "execution_denied",
            CkOutputKind::Content { .. } => "content",
            CkOutputKind::ErrorContent { .. } => "error_content",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultBlock {
    pub kind: ResultBlockKind,
    #[serde(default, skip_serializing_if = "ProviderExtras::is_empty")]
    pub provider_extras: ProviderExtras,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResultBlockKind {
    Text { text: String },
    Media { media: MediaBlock },
    Opaque { opaque: OpaqueBlock },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpaqueBlock {
    pub source: Value,
    pub kind: String,
    pub raw: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arc: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaBlock {
    pub kind: MediaKind,
    pub media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    pub source: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Audio,
    Video,
    File,
    Document,
}

/// This namespace isolates cache-state migrations from other namespaces in the same database.
const NS: &str = "mc_cache";

/// The transaction's `COALESCE` default for `row_version` denotes an absent row.
const NO_ROW: i64 = -1;
const MAX_CHUNK_TRANSCRIPT_COMPRESSED_BYTES: usize = 256 * 1024;
/// Decompression limits prevent a small compressed row from allocating an unbounded transcript.
const MAX_CHUNK_TRANSCRIPT_INFLATED_BYTES: usize = 512 * 1024;
const CHUNK_TRANSCRIPT_TRUNCATION_MARKER: &str =
    "\n[truncated: transcript exceeded the inflated-byte limit]";
const MAX_SESSION_TRANSCRIPT_COMPRESSED_BYTES: i64 = 8 * 1024 * 1024;
const PASS_SCHEDULER_HISTORY_CAP: usize = 256;
const PASS_SCHEDULER_INTERESTING_HISTORY_CAP: usize = 256;
const MAX_FULL_ARRAY_FINGERPRINT_BYTES: usize = 256;
/// The recency entry is at most 99 bytes.
/// An interesting entry is at most 1,906 bytes; JSON escapes fingerprint bytes as `\u00xx`.
const MAX_PASS_SCHEDULER_OBSERVATION_JSON_BYTES: usize = 99;
const MAX_INTERESTING_PASS_SCHEDULER_OBSERVATION_JSON_BYTES: usize = 1_906;
/// `PASS_SCHEDULER_TELEMETRY_MAX_BYTES` caps the combined UTF-8 bytes for both scheduler JSON arrays on one session row.
pub const PASS_SCHEDULER_TELEMETRY_MAX_BYTES: usize = 1
    + PASS_SCHEDULER_HISTORY_CAP * (MAX_PASS_SCHEDULER_OBSERVATION_JSON_BYTES + 1)
    + 1
    + PASS_SCHEDULER_INTERESTING_HISTORY_CAP
        * (MAX_INTERESTING_PASS_SCHEDULER_OBSERVATION_JSON_BYTES + 1);

fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 57,
    statements: r#"
CREATE TABLE mc_cache_state (
            session_id   TEXT PRIMARY KEY,
            row_version  INTEGER NOT NULL,
            core_state   TEXT NOT NULL,
            meta         TEXT NOT NULL
        , last_activity_at INTEGER NOT NULL DEFAULT 0);

CREATE TABLE mc_compartments (
            session_id        TEXT NOT NULL,
            sequence          INTEGER NOT NULL,
            start_message     INTEGER NOT NULL,
            end_message       INTEGER NOT NULL,
            start_message_id  TEXT NOT NULL DEFAULT '',
            end_message_id    TEXT NOT NULL DEFAULT '',
            title             TEXT NOT NULL,
            content           TEXT NOT NULL,
            p1                TEXT,
            p2                TEXT,
            p3                TEXT,
            p4                TEXT,
            importance        INTEGER NOT NULL DEFAULT 50,
            episode_type      TEXT,
            legacy            INTEGER NOT NULL DEFAULT 0,
            created_at        INTEGER NOT NULL DEFAULT 0, start_date TEXT, end_date TEXT,
            PRIMARY KEY (session_id, sequence)
        );

CREATE TABLE mc_user_memories (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            content              TEXT NOT NULL,
            status               TEXT NOT NULL DEFAULT 'active',
            promoted_at          INTEGER NOT NULL DEFAULT 0,
            source_candidate_ids TEXT DEFAULT '[]',
            created_at           INTEGER NOT NULL DEFAULT 0,
            updated_at           INTEGER NOT NULL DEFAULT 0
        );

CREATE INDEX idx_mc_user_memories_status
            ON mc_user_memories(status);

CREATE TABLE mc_workspaces (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            name             TEXT NOT NULL UNIQUE,
            created_at       INTEGER NOT NULL DEFAULT 0,
            updated_at       INTEGER NOT NULL DEFAULT 0,
            share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'
        );

CREATE TABLE mc_workspace_members (
            workspace_id  INTEGER NOT NULL REFERENCES mc_workspaces(id) ON DELETE CASCADE,
            project_path  TEXT NOT NULL,
            display_name  TEXT NOT NULL,
            display_path  TEXT NOT NULL,
            added_at      INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (workspace_id, project_path)
        );

CREATE UNIQUE INDEX idx_mc_workspace_member_unique
            ON mc_workspace_members(project_path);

CREATE TABLE pending_agent_drops (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT NOT NULL,
            target_id   TEXT NOT NULL,
            queued_at   INTEGER NOT NULL DEFAULT 0, command_id TEXT,
            UNIQUE(session_id, target_id)
        );

CREATE INDEX idx_pending_agent_drops_session
            ON pending_agent_drops(session_id, queued_at, id);

CREATE TABLE shadow_divergences (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id           TEXT NOT NULL,
            pass_seq             INTEGER NOT NULL,
            class                TEXT NOT NULL,
            first_mid            TEXT,
            first_block          TEXT,
            first_field          TEXT,
            ts_prefix            TEXT NOT NULL,
            rs_prefix            TEXT NOT NULL,
            normalizations       TEXT NOT NULL,
            ts_decision          TEXT NOT NULL,
            rs_decision          TEXT NOT NULL,
            state_hash           TEXT NOT NULL,
            created_at           INTEGER NOT NULL DEFAULT 0
        , first_diff_offset INTEGER, ts_window TEXT NOT NULL DEFAULT '', rs_window TEXT NOT NULL DEFAULT '');

CREATE INDEX idx_shadow_divergences_session
            ON shadow_divergences(session_id, pass_seq, id);

CREATE TABLE mc_pass_trace (
            session_id             TEXT PRIMARY KEY,
            last_received_at_ms    INTEGER NOT NULL,
            last_completed_at_ms   INTEGER NOT NULL,
            last_reject_error      TEXT NULL,
            last_reject_at_ms      INTEGER NULL,
            reject_count           INTEGER NOT NULL DEFAULT 0,
            receive_count          INTEGER NOT NULL DEFAULT 0
        , first_divergence TEXT NULL, last_divergence TEXT NULL, scheduler_history TEXT NOT NULL DEFAULT '[]', scheduler_interesting_history TEXT NOT NULL DEFAULT '[]');

CREATE TABLE mc_chunk_transcripts (
            session_id          TEXT NOT NULL,
            compartment_seq     INTEGER NOT NULL,
            start_ordinal       INTEGER NOT NULL,
            end_ordinal         INTEGER NOT NULL,
            transcript_deflate  BLOB NOT NULL,
            created_at_ms       INTEGER NOT NULL, raw_messages_deflate BLOB NULL,
            PRIMARY KEY (session_id, compartment_seq)
        );

CREATE INDEX idx_mc_chunk_transcripts_session_range
            ON mc_chunk_transcripts(session_id, start_ordinal, end_ordinal, compartment_seq);

CREATE TABLE mc_tags (
            session_id     TEXT NOT NULL,
            tag_number    INTEGER NOT NULL,
            block_id      TEXT NOT NULL,
            kind          TEXT NOT NULL CHECK (kind IN ('message', 'tool_call', 'tool_result')),
            token_count   INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL DEFAULT 0, source_bytes BLOB NOT NULL DEFAULT X'',
            PRIMARY KEY (session_id, tag_number),
            UNIQUE(session_id, block_id)
        );

CREATE INDEX idx_mc_tags_session_block
            ON mc_tags(session_id, block_id);

CREATE TABLE mc_channel1_appends (
            session_id     TEXT NOT NULL,
            block_id       TEXT NOT NULL,
            reminder_text  TEXT NOT NULL,
            fired_at_ms    INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_id, block_id)
        );

CREATE INDEX idx_mc_channel1_appends_session
            ON mc_channel1_appends(session_id, fired_at_ms, block_id);

CREATE TABLE mc_reduce_command_ledger (
            session_id   TEXT NOT NULL,
            command_id   TEXT NOT NULL,
            queued_at_ms INTEGER NOT NULL, first_applied_at_ms INTEGER, disposition TEXT
            CHECK (disposition IS NULL OR disposition IN ('no_targets')),
            PRIMARY KEY (session_id, command_id)
        );

CREATE INDEX idx_mc_reduce_command_ledger_session_newest
            ON mc_reduce_command_ledger(session_id, queued_at_ms DESC, command_id DESC);

CREATE TABLE mc_state_imports (
            session_id      TEXT PRIMARY KEY,
            import_id       TEXT NOT NULL,
            imported_count  INTEGER NOT NULL,
            completed_at_ms INTEGER NOT NULL
        );

CREATE TABLE mc_user_hints (
            session_id  TEXT NOT NULL,
            block_id    TEXT NOT NULL,
            hint_text   TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (session_id, block_id)
        );

CREATE INDEX idx_mc_user_hints_session_created
            ON mc_user_hints(session_id, created_at, block_id);

CREATE TABLE mc_overlay_frontiers (
            session_id        TEXT PRIMARY KEY,
            max_seen_ordinal  INTEGER NOT NULL DEFAULT 0
        );

CREATE TABLE mc_temporal_marks (
            session_id   TEXT NOT NULL,
            block_id     TEXT NOT NULL,
            marker_text  TEXT NOT NULL,
            created_at   INTEGER NOT NULL,
            PRIMARY KEY (session_id, block_id)
        );

CREATE INDEX idx_mc_temporal_marks_session_created
            ON mc_temporal_marks(session_id, created_at, block_id);

CREATE TABLE mc_wrapup_commands (
            session_id   TEXT NOT NULL,
            command_id   TEXT NOT NULL,
            disposition  TEXT NOT NULL
                CHECK (disposition IN ('completed', 'nothing_to_compact', 'failed')),
            rounds       INTEGER NOT NULL,
            summary      TEXT NOT NULL,
            created_at   INTEGER NOT NULL,
            PRIMARY KEY (session_id, command_id)
        );

CREATE INDEX idx_mc_wrapup_commands_session_created
            ON mc_wrapup_commands(session_id, created_at, command_id);

CREATE TABLE shadow_user_profile (
            shadow_project_path  TEXT NOT NULL,
            profile_index        INTEGER NOT NULL,
            content              TEXT NOT NULL,
            PRIMARY KEY (shadow_project_path, profile_index)
        );

CREATE INDEX idx_shadow_user_profile_project
            ON shadow_user_profile(shadow_project_path, profile_index);

CREATE INDEX idx_pending_agent_drops_command
            ON pending_agent_drops(session_id, command_id, id);

CREATE TABLE mc_recomp_commands (
            session_id   TEXT NOT NULL,
            command_id   TEXT NOT NULL,
            disposition  TEXT NOT NULL CHECK (disposition IN ('started', 'already_in_progress', 'nothing_to_do')),
            created_at   INTEGER NOT NULL,
            PRIMARY KEY (session_id, command_id)
        );

CREATE INDEX idx_mc_recomp_commands_session_created
            ON mc_recomp_commands(session_id, created_at, command_id);

CREATE TABLE mc_changefeed (
            feed_seq            INTEGER PRIMARY KEY AUTOINCREMENT,
            domain              TEXT NOT NULL CHECK (domain = 'notes'),
            op                  TEXT NOT NULL CHECK (op IN ('insert', 'update', 'tombstone')),
            module_row_id       INTEGER NOT NULL,
            full_row_snapshot   JSON NOT NULL,
            content_hash        TEXT
        );

CREATE INDEX idx_mc_changefeed_domain_seq
            ON mc_changefeed(domain, feed_seq);

CREATE TABLE mc_authority (
            context_store_uuid TEXT NOT NULL,
            project            TEXT NOT NULL,
            domain             TEXT NOT NULL CHECK (domain IN ('memories', 'notes')),
            state               TEXT NOT NULL CHECK (state IN ('TS', 'PREPARING', 'MODULE', 'DRAINING')),
            generation         INTEGER NOT NULL DEFAULT 0,
            captured_upper_bound INTEGER,
            drain_generation   INTEGER,
            drain_cursor       INTEGER NOT NULL DEFAULT 0,
            step_seed          INTEGER NOT NULL DEFAULT 0,
            step_memories      INTEGER NOT NULL DEFAULT 0,
            step_notes         INTEGER NOT NULL DEFAULT 0,
            step_compartments  INTEGER NOT NULL DEFAULT 0,
            step_reconcile     INTEGER NOT NULL DEFAULT 0,
            step_verify        INTEGER NOT NULL DEFAULT 0,
            step_flip          INTEGER NOT NULL DEFAULT 0,
            coordinator_lease TEXT,
            lease_expires_at  INTEGER,
            checksum_expected TEXT,
            checksum_actual   TEXT,
            checksum_ok       INTEGER, coordinator_token TEXT, note_eval_protocol_epoch INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (context_store_uuid, project, domain)
        );

CREATE INDEX idx_mc_authority_project
            ON mc_authority(context_store_uuid, project, state);

CREATE TABLE mc_notes (
            id                         INTEGER PRIMARY KEY AUTOINCREMENT,
            type                       TEXT NOT NULL DEFAULT 'smart'
                CHECK (type IN ('session', 'smart')),
            project_path               TEXT NOT NULL,
            session_id                 TEXT,
            content                    TEXT NOT NULL,
            status                     TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'pending', 'ready', 'surfacing', 'surfaced', 'dismissed')),
            surface_condition          TEXT,
            ready_at                   INTEGER,
            ready_reason               TEXT,
            manifest_json              TEXT,
            compiled_check             TEXT,
            check_hash                 TEXT,
            check_cron                 TEXT,
            check_failure_count       INTEGER NOT NULL DEFAULT 0,
            check_network_failure_count INTEGER NOT NULL DEFAULT 0,
            check_quarantined_until   INTEGER,
            check_next_due_at         INTEGER,
            check_compiled_at         INTEGER,
            check_false_since_at      INTEGER,
            check_last_liveness_at    INTEGER,
            last_checked_at           INTEGER,
            check_status               TEXT NOT NULL DEFAULT 'uncompiled',
            check_version              INTEGER NOT NULL DEFAULT 0,
            policy_version            INTEGER NOT NULL DEFAULT 1,
            harness                    TEXT NOT NULL DEFAULT 'module',
            anchor_block_id            TEXT,
            anchor_ordinal             INTEGER,
            dismissed_at              INTEGER,
            dismissal_resolution       TEXT,
            status_version             INTEGER NOT NULL DEFAULT 0,
            created_at_ms             INTEGER NOT NULL DEFAULT 0,
            updated_at_ms             INTEGER NOT NULL DEFAULT 0,
            context_store_uuid        TEXT,
            context_row_id            INTEGER, source_revision INTEGER NOT NULL DEFAULT 0, state_version INTEGER NOT NULL DEFAULT 0, compiled_source_revision INTEGER, compiled_project_path TEXT, compiled_provider TEXT, compiled_config TEXT, compiled_at INTEGER, compile_status TEXT
            CHECK (compile_status IN ('compiled', 'plain', 'refused') OR compile_status IS NULL),
            UNIQUE(context_store_uuid, context_row_id)
        );

CREATE INDEX idx_mc_notes_scope_status
            ON mc_notes(project_path, session_id, status, updated_at_ms DESC, id DESC);

CREATE INDEX idx_mc_notes_due
            ON mc_notes(project_path, status, check_next_due_at, id);

CREATE TABLE mc_note_deliveries (
            delivery_id                 TEXT PRIMARY KEY,
            note_id                     INTEGER NOT NULL,
            session_id                  TEXT NOT NULL,
            delivered_pass_fingerprint  TEXT NOT NULL,
            transform_pass_id           TEXT NOT NULL DEFAULT '',
            acked_at                    INTEGER,
            created_at_ms               INTEGER NOT NULL DEFAULT 0, project_path TEXT NOT NULL DEFAULT '', disposition TEXT
            CHECK(disposition IS NULL OR disposition IN ('acked','nacked','superseded')),
            UNIQUE(note_id, session_id, delivered_pass_fingerprint)
        );

CREATE TRIGGER mc_notes_ownership_insert
        BEFORE INSERT ON mc_notes
        WHEN NEW.project_path = '' OR mc_note_caller_project() IS NOT NEW.project_path
        BEGIN
            SELECT RAISE(ABORT, 'note ownership insert is outside the caller project');
        END;

CREATE TRIGGER mc_notes_ownership_update
        BEFORE UPDATE ON mc_notes
        WHEN (NEW.id IS NOT OLD.id OR NEW.type IS NOT OLD.type
              OR NEW.session_id IS NOT OLD.session_id OR NEW.project_path IS NOT OLD.project_path
              OR NEW.context_store_uuid IS NOT OLD.context_store_uuid
              OR NEW.context_row_id IS NOT OLD.context_row_id)
          AND NOT (mc_note_caller_project() IS OLD.project_path
                   OR mc_note_caller_project() IS NEW.project_path)
        BEGIN
            SELECT RAISE(ABORT, 'note ownership update is outside the old or new project');
        END;

CREATE TRIGGER mc_notes_ownership_delete
        BEFORE DELETE ON mc_notes
        WHEN mc_note_caller_project() IS NOT OLD.project_path
        BEGIN
            SELECT RAISE(ABORT, 'note ownership delete is outside the row project');
        END;

CREATE TABLE mc_authority_seed_rows (
            context_store_uuid TEXT NOT NULL,
            project TEXT NOT NULL,
            domain TEXT NOT NULL CHECK(domain = 'notes'),
            source_row_id INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,
            PRIMARY KEY(context_store_uuid, project, domain, source_row_id)
        );

CREATE INDEX idx_mc_note_deliveries_retry
            ON mc_note_deliveries(project_path, session_id, disposition, created_at_ms, note_id);

CREATE TABLE mc_authority_route_bindings (
            route_project_root TEXT PRIMARY KEY,
            context_store_uuid TEXT NOT NULL,
            project            TEXT NOT NULL
        );

CREATE INDEX idx_mc_authority_route_bindings_authority
            ON mc_authority_route_bindings(context_store_uuid, project);





CREATE TABLE mc_dream_task_commands (
            session_id   TEXT NOT NULL,
            command_id   TEXT NOT NULL,
            response_json TEXT NOT NULL,
            created_at   INTEGER NOT NULL,
            PRIMARY KEY (session_id, command_id)
        );

CREATE INDEX idx_mc_dream_task_commands_created
            ON mc_dream_task_commands(session_id, created_at, command_id);

CREATE TABLE mc_transform_session_roots (
            session_id  TEXT NOT NULL,
            project_root TEXT NOT NULL,
            observed_at INTEGER NOT NULL,
            PRIMARY KEY(session_id, project_root)
        );

CREATE INDEX idx_mc_transform_session_roots_observed
            ON mc_transform_session_roots(observed_at);

CREATE TRIGGER mc_notes_facade_authority_insert
        BEFORE INSERT ON mc_notes
        WHEN mc_facade_authority_domain() = 'notes'
          AND EXISTS (
              SELECT 1 FROM mc_authority_route_bindings binding
              JOIN mc_authority authority
                ON authority.context_store_uuid = binding.context_store_uuid
               AND authority.project = binding.project
             WHERE binding.route_project_root = mc_facade_authority_route()
               AND authority.domain = 'notes'
               AND authority.project = NEW.project_path
               AND authority.state != 'MODULE'
          )
        BEGIN SELECT RAISE(ABORT, 'authority_draining'); END;

CREATE TRIGGER mc_notes_facade_authority_update
        BEFORE UPDATE ON mc_notes
        WHEN mc_facade_authority_domain() = 'notes'
          AND EXISTS (
              SELECT 1 FROM mc_authority_route_bindings binding
              JOIN mc_authority authority
                ON authority.context_store_uuid = binding.context_store_uuid
               AND authority.project = binding.project
             WHERE binding.route_project_root = mc_facade_authority_route()
               AND authority.domain = 'notes'
               AND authority.project IN (OLD.project_path, NEW.project_path)
               AND authority.state != 'MODULE'
          )
        BEGIN SELECT RAISE(ABORT, 'authority_draining'); END;

CREATE TRIGGER mc_notes_facade_authority_delete
        BEFORE DELETE ON mc_notes
        WHEN mc_facade_authority_domain() = 'notes'
          AND EXISTS (
              SELECT 1 FROM mc_authority_route_bindings binding
              JOIN mc_authority authority
                ON authority.context_store_uuid = binding.context_store_uuid
               AND authority.project = binding.project
             WHERE binding.route_project_root = mc_facade_authority_route()
               AND authority.domain = 'notes'
               AND authority.project = OLD.project_path
               AND authority.state != 'MODULE'
          )
        BEGIN SELECT RAISE(ABORT, 'authority_draining'); END;

CREATE TABLE mc_compartment_events (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id            TEXT NOT NULL,
            compartment_id        INTEGER,
            at_compartment        INTEGER,
            kind                  TEXT NOT NULL,
            fields_json           TEXT NOT NULL DEFAULT '{}',
            created_at             INTEGER NOT NULL DEFAULT 0,
            harness                TEXT NOT NULL DEFAULT 'module'
        );

CREATE INDEX idx_mc_compartment_events_session
            ON mc_compartment_events(session_id, id);

CREATE TABLE mc_primer_candidates (
            id                       INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path             TEXT NOT NULL,
            harness                  TEXT NOT NULL DEFAULT 'module',
            session_id               TEXT NOT NULL,
            question                 TEXT NOT NULL,
            normalized_question      TEXT NOT NULL,
            source_compartment_start INTEGER,
            source_compartment_end   INTEGER,
            source_start_message_id  TEXT NOT NULL DEFAULT '',
            source_end_message_id    TEXT NOT NULL DEFAULT '',
            source_message_time      INTEGER NOT NULL DEFAULT 0,
            created_at               INTEGER NOT NULL DEFAULT 0,
            UNIQUE(project_path, harness, session_id, source_start_message_id, source_end_message_id)
        );

CREATE INDEX idx_mc_primer_candidates_project
            ON mc_primer_candidates(project_path, created_at, id);

CREATE TABLE mc_user_memory_candidates (
            id                       INTEGER PRIMARY KEY AUTOINCREMENT,
            content                  TEXT NOT NULL,
            session_id               TEXT NOT NULL,
            source_compartment_start INTEGER,
            source_compartment_end   INTEGER,
            created_at               INTEGER NOT NULL DEFAULT 0
        );

CREATE INDEX idx_mc_user_memory_candidates_session
            ON mc_user_memory_candidates(session_id, created_at, id);

CREATE TABLE mc_historian_side_channel_outbox (
            session_id          TEXT NOT NULL,
            firing_seq         INTEGER NOT NULL,
            kind               TEXT NOT NULL
                CHECK (kind IN ('event', 'primer', 'user_observation')),
            source_start       INTEGER NOT NULL,
            source_end         INTEGER NOT NULL,
            item_index         INTEGER NOT NULL,
            payload_json       TEXT NOT NULL,
            attempt_count      INTEGER NOT NULL DEFAULT 0,
            next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
            last_attempt_at_ms INTEGER,
            last_error         TEXT,
            delivered_at_ms    INTEGER,
            created_at_ms      INTEGER NOT NULL,
            PRIMARY KEY (session_id, firing_seq, kind, source_start, source_end, item_index)
        );

CREATE INDEX idx_mc_historian_side_channel_outbox_due
            ON mc_historian_side_channel_outbox(
                session_id, kind, delivered_at_ms, next_attempt_at_ms, firing_seq, item_index
            );

CREATE TABLE mc_facade_mutation_ledger (
            identity_scope TEXT NOT NULL,
            tool           TEXT NOT NULL,
            action         TEXT NOT NULL,
            command_id     TEXT NOT NULL,
            response_json  BLOB NOT NULL,
            created_at_ms  INTEGER NOT NULL,
            PRIMARY KEY (identity_scope, tool, action, command_id)
        );

CREATE INDEX idx_mc_facade_mutation_ledger_scope_newest
            ON mc_facade_mutation_ledger(identity_scope, created_at_ms DESC, tool, action, command_id);

CREATE INDEX idx_mc_compartments_session_end_message
            ON mc_compartments(session_id, end_message);

CREATE INDEX idx_mc_notes_project_status_updated
            ON mc_notes(project_path, status, updated_at_ms DESC, id DESC);

CREATE INDEX idx_mc_historian_side_channel_outbox_order
            ON mc_historian_side_channel_outbox(
                session_id, kind, delivered_at_ms,
                firing_seq, source_start, source_end, item_index, next_attempt_at_ms
            );

CREATE TABLE mc_tag_cache_generations (
            session_id TEXT PRIMARY KEY,
            generation INTEGER NOT NULL DEFAULT 0,
            tag_count INTEGER NOT NULL DEFAULT 0,
            max_tag_number INTEGER NOT NULL DEFAULT 0
        );

CREATE TRIGGER mc_tags_cache_generation_insert AFTER INSERT ON mc_tags BEGIN
            INSERT INTO mc_tag_cache_generations(session_id, generation, tag_count, max_tag_number)
            VALUES (NEW.session_id, 1, 1, NEW.tag_number)
            ON CONFLICT(session_id) DO UPDATE SET
                generation = generation + 1,
                tag_count = tag_count + 1,
                max_tag_number = MAX(max_tag_number, NEW.tag_number);
        END;

CREATE TRIGGER mc_tags_cache_generation_delete AFTER DELETE ON mc_tags BEGIN
            INSERT INTO mc_tag_cache_generations(session_id, generation, tag_count, max_tag_number)
            VALUES (
                OLD.session_id,
                1,
                (SELECT COUNT(*) FROM mc_tags WHERE session_id = OLD.session_id),
                (SELECT COALESCE(MAX(tag_number), 0) FROM mc_tags WHERE session_id = OLD.session_id)
            )
            ON CONFLICT(session_id) DO UPDATE SET
                generation = generation + 1,
                tag_count = excluded.tag_count,
                max_tag_number = excluded.max_tag_number;
        END;

CREATE TRIGGER mc_tags_cache_generation_update AFTER UPDATE ON mc_tags BEGIN
            INSERT INTO mc_tag_cache_generations(session_id, generation, tag_count, max_tag_number)
            VALUES (
                OLD.session_id,
                1,
                (SELECT COUNT(*) FROM mc_tags WHERE session_id = OLD.session_id),
                (SELECT COALESCE(MAX(tag_number), 0) FROM mc_tags WHERE session_id = OLD.session_id)
            )
            ON CONFLICT(session_id) DO UPDATE SET
                generation = generation + 1,
                tag_count = excluded.tag_count,
                max_tag_number = excluded.max_tag_number;
            INSERT INTO mc_tag_cache_generations(session_id, generation, tag_count, max_tag_number)
            VALUES (
                NEW.session_id,
                1,
                (SELECT COUNT(*) FROM mc_tags WHERE session_id = NEW.session_id),
                (SELECT COALESCE(MAX(tag_number), 0) FROM mc_tags WHERE session_id = NEW.session_id)
            )
            ON CONFLICT(session_id) DO UPDATE SET
                generation = generation + 1,
                tag_count = excluded.tag_count,
                max_tag_number = excluded.max_tag_number;
        END;

CREATE TABLE mc_project_mural_artifacts (
            project_path TEXT PRIMARY KEY NOT NULL,
            data_url BLOB NOT NULL,
            content_hash TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

CREATE TRIGGER mc_notes_writer_fence_insert
        BEFORE INSERT ON mc_notes
        WHEN mc_note_writer_v2() IS NOT 1
        BEGIN
            SELECT RAISE(ABORT, 'mc_notes requires a protocol-v2 binary');
        END;

CREATE TRIGGER mc_notes_writer_fence_update
        BEFORE UPDATE ON mc_notes
        WHEN mc_note_writer_v2() IS NOT 1
        BEGIN
            SELECT RAISE(ABORT, 'mc_notes requires a protocol-v2 binary');
        END;

CREATE TRIGGER mc_notes_writer_fence_delete
        BEFORE DELETE ON mc_notes
        WHEN mc_note_writer_v2() IS NOT 1
        BEGIN
            SELECT RAISE(ABORT, 'mc_notes requires a protocol-v2 binary');
        END;

CREATE TRIGGER mc_notes_feed_insert AFTER INSERT ON mc_notes BEGIN
            INSERT INTO mc_changefeed(domain, op, module_row_id, full_row_snapshot, content_hash)
            VALUES ('notes', 'insert', NEW.id,
                json_object(
                    'id', NEW.id, 'type', NEW.type, 'project_path', NEW.project_path,
                    'session_id', NEW.session_id, 'content', NEW.content, 'status', NEW.status,
                    'surface_condition', NEW.surface_condition, 'ready_at', NEW.ready_at,
                    'ready_reason', NEW.ready_reason, 'manifest_json', NEW.manifest_json,
                    'compiled_check', NEW.compiled_check, 'check_hash', NEW.check_hash,
                    'check_cron', NEW.check_cron, 'check_failure_count', NEW.check_failure_count,
                    'check_network_failure_count', NEW.check_network_failure_count,
                    'check_quarantined_until', NEW.check_quarantined_until,
                    'check_next_due_at', NEW.check_next_due_at, 'check_compiled_at', NEW.check_compiled_at,
                    'check_false_since_at', NEW.check_false_since_at,
                    'check_last_liveness_at', NEW.check_last_liveness_at,
                    'last_checked_at', NEW.last_checked_at, 'check_status', NEW.check_status,
                    'check_version', NEW.check_version, 'policy_version', NEW.policy_version,
                    'harness', NEW.harness, 'anchor_block_id', NEW.anchor_block_id,
                    'anchor_ordinal', NEW.anchor_ordinal, 'dismissed_at', NEW.dismissed_at,
                    'dismissal_resolution', NEW.dismissal_resolution,
                    'status_version', NEW.status_version, 'created_at_ms', NEW.created_at_ms,
                    'updated_at_ms', NEW.updated_at_ms, 'context_store_uuid', NEW.context_store_uuid,
                    'context_row_id', NEW.context_row_id,
                    'source_revision', NEW.source_revision, 'state_version', NEW.state_version,
                    'compiled_source_revision', NEW.compiled_source_revision,
                    'compiled_project_path', NEW.compiled_project_path,
                    'compiled_provider', NEW.compiled_provider,
                    'compiled_config', NEW.compiled_config,
                    'compiled_at', NEW.compiled_at, 'compile_status', NEW.compile_status), NULL);
        END;

CREATE TRIGGER mc_notes_feed_update AFTER UPDATE ON mc_notes
        WHEN NEW.id IS NOT OLD.id OR NEW.type IS NOT OLD.type
          OR NEW.project_path IS NOT OLD.project_path OR NEW.session_id IS NOT OLD.session_id
          OR NEW.content IS NOT OLD.content OR NEW.status IS NOT OLD.status
          OR NEW.surface_condition IS NOT OLD.surface_condition OR NEW.ready_at IS NOT OLD.ready_at
          OR NEW.ready_reason IS NOT OLD.ready_reason OR NEW.manifest_json IS NOT OLD.manifest_json
          OR NEW.compiled_check IS NOT OLD.compiled_check OR NEW.check_hash IS NOT OLD.check_hash
          OR NEW.check_cron IS NOT OLD.check_cron
          OR NEW.check_failure_count IS NOT OLD.check_failure_count
          OR NEW.check_network_failure_count IS NOT OLD.check_network_failure_count
          OR NEW.check_quarantined_until IS NOT OLD.check_quarantined_until
          OR NEW.check_next_due_at IS NOT OLD.check_next_due_at
          OR NEW.check_compiled_at IS NOT OLD.check_compiled_at
          OR NEW.check_false_since_at IS NOT OLD.check_false_since_at
          OR NEW.check_last_liveness_at IS NOT OLD.check_last_liveness_at
          OR NEW.last_checked_at IS NOT OLD.last_checked_at OR NEW.check_status IS NOT OLD.check_status
          OR NEW.check_version IS NOT OLD.check_version OR NEW.policy_version IS NOT OLD.policy_version
          OR NEW.harness IS NOT OLD.harness OR NEW.anchor_block_id IS NOT OLD.anchor_block_id
          OR NEW.anchor_ordinal IS NOT OLD.anchor_ordinal OR NEW.dismissed_at IS NOT OLD.dismissed_at
          OR NEW.dismissal_resolution IS NOT OLD.dismissal_resolution
          OR NEW.status_version IS NOT OLD.status_version
          OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.updated_at_ms IS NOT OLD.updated_at_ms
          OR NEW.context_store_uuid IS NOT OLD.context_store_uuid
          OR NEW.context_row_id IS NOT OLD.context_row_id
          OR NEW.source_revision IS NOT OLD.source_revision
          OR NEW.state_version IS NOT OLD.state_version
          OR NEW.compiled_source_revision IS NOT OLD.compiled_source_revision
          OR NEW.compiled_project_path IS NOT OLD.compiled_project_path
          OR NEW.compiled_provider IS NOT OLD.compiled_provider
          OR NEW.compiled_config IS NOT OLD.compiled_config
          OR NEW.compiled_at IS NOT OLD.compiled_at
          OR NEW.compile_status IS NOT OLD.compile_status
        BEGIN
            INSERT INTO mc_changefeed(domain, op, module_row_id, full_row_snapshot, content_hash)
            VALUES ('notes', 'update', NEW.id,
                json_object(
                    'id', NEW.id, 'type', NEW.type, 'project_path', NEW.project_path,
                    'session_id', NEW.session_id, 'content', NEW.content, 'status', NEW.status,
                    'surface_condition', NEW.surface_condition, 'ready_at', NEW.ready_at,
                    'ready_reason', NEW.ready_reason, 'manifest_json', NEW.manifest_json,
                    'compiled_check', NEW.compiled_check, 'check_hash', NEW.check_hash,
                    'check_cron', NEW.check_cron, 'check_failure_count', NEW.check_failure_count,
                    'check_network_failure_count', NEW.check_network_failure_count,
                    'check_quarantined_until', NEW.check_quarantined_until,
                    'check_next_due_at', NEW.check_next_due_at, 'check_compiled_at', NEW.check_compiled_at,
                    'check_false_since_at', NEW.check_false_since_at,
                    'check_last_liveness_at', NEW.check_last_liveness_at,
                    'last_checked_at', NEW.last_checked_at, 'check_status', NEW.check_status,
                    'check_version', NEW.check_version, 'policy_version', NEW.policy_version,
                    'harness', NEW.harness, 'anchor_block_id', NEW.anchor_block_id,
                    'anchor_ordinal', NEW.anchor_ordinal, 'dismissed_at', NEW.dismissed_at,
                    'dismissal_resolution', NEW.dismissal_resolution,
                    'status_version', NEW.status_version, 'created_at_ms', NEW.created_at_ms,
                    'updated_at_ms', NEW.updated_at_ms, 'context_store_uuid', NEW.context_store_uuid,
                    'context_row_id', NEW.context_row_id,
                    'source_revision', NEW.source_revision, 'state_version', NEW.state_version,
                    'compiled_source_revision', NEW.compiled_source_revision,
                    'compiled_project_path', NEW.compiled_project_path,
                    'compiled_provider', NEW.compiled_provider,
                    'compiled_config', NEW.compiled_config,
                    'compiled_at', NEW.compiled_at, 'compile_status', NEW.compile_status), NULL);
        END;

CREATE TRIGGER mc_notes_feed_delete AFTER DELETE ON mc_notes BEGIN
            INSERT INTO mc_changefeed(domain, op, module_row_id, full_row_snapshot, content_hash)
            VALUES ('notes', 'tombstone', OLD.id,
                json_object(
                    'id', OLD.id, 'type', OLD.type, 'project_path', OLD.project_path,
                    'session_id', OLD.session_id, 'content', OLD.content, 'status', OLD.status,
                    'surface_condition', OLD.surface_condition, 'ready_at', OLD.ready_at,
                    'ready_reason', OLD.ready_reason, 'manifest_json', OLD.manifest_json,
                    'compiled_check', OLD.compiled_check, 'check_hash', OLD.check_hash,
                    'check_cron', OLD.check_cron, 'check_failure_count', OLD.check_failure_count,
                    'check_network_failure_count', OLD.check_network_failure_count,
                    'check_quarantined_until', OLD.check_quarantined_until,
                    'check_next_due_at', OLD.check_next_due_at, 'check_compiled_at', OLD.check_compiled_at,
                    'check_false_since_at', OLD.check_false_since_at,
                    'check_last_liveness_at', OLD.check_last_liveness_at,
                    'last_checked_at', OLD.last_checked_at, 'check_status', OLD.check_status,
                    'check_version', OLD.check_version, 'policy_version', OLD.policy_version,
                    'harness', OLD.harness, 'anchor_block_id', OLD.anchor_block_id,
                    'anchor_ordinal', OLD.anchor_ordinal, 'dismissed_at', OLD.dismissed_at,
                    'dismissal_resolution', OLD.dismissal_resolution,
                    'status_version', OLD.status_version, 'created_at_ms', OLD.created_at_ms,
                    'updated_at_ms', OLD.updated_at_ms, 'context_store_uuid', OLD.context_store_uuid,
                    'context_row_id', OLD.context_row_id,
                    'source_revision', OLD.source_revision, 'state_version', OLD.state_version,
                    'compiled_source_revision', OLD.compiled_source_revision,
                    'compiled_project_path', OLD.compiled_project_path,
                    'compiled_provider', OLD.compiled_provider,
                    'compiled_config', OLD.compiled_config,
                    'compiled_at', OLD.compiled_at, 'compile_status', OLD.compile_status), NULL);
        END;

CREATE TABLE mc_note_eval_claims (
            claim_id TEXT PRIMARY KEY,
            project TEXT NOT NULL,
            note_id INTEGER NOT NULL,
            phase TEXT NOT NULL CHECK (phase IN ('compile', 'due', 'liveness', 'fallback')),
            acquisition_id TEXT NOT NULL,
            evaluator_instance TEXT NOT NULL,
            evaluator_slot INTEGER NOT NULL,
            registration_generation INTEGER NOT NULL,
            source_revision INTEGER NOT NULL,
            state_version INTEGER NOT NULL,
            policy_version INTEGER NOT NULL,
            protocol_epoch INTEGER NOT NULL,
            authority_generation INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            completion_id TEXT,
            terminal_kind TEXT,
            terminal_response TEXT,
            terminal_at_ms INTEGER,
            UNIQUE (project, acquisition_id)
        );

CREATE UNIQUE INDEX idx_mc_note_eval_claims_active_note
            ON mc_note_eval_claims(project, note_id) WHERE terminal_kind IS NULL;

CREATE UNIQUE INDEX idx_mc_note_eval_claims_active_slot
            ON mc_note_eval_claims(project, evaluator_instance, evaluator_slot)
            WHERE terminal_kind IS NULL;

CREATE TABLE mc_note_eval_acquisitions (
            project TEXT NOT NULL,
            acquisition_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (project, acquisition_id)
        );

CREATE INDEX idx_mc_primer_candidates_session
            ON mc_primer_candidates(session_id, id);

CREATE TABLE mc_claim_intents (
            producer TEXT NOT NULL CHECK (length(producer) BETWEEN 1 AND 256),
            operation_key TEXT NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 256),
            database_incarnation_id TEXT NOT NULL CHECK (length(database_incarnation_id) = 32),
            format_epoch INTEGER NOT NULL CHECK (format_epoch > 0),
            authority_project TEXT NOT NULL CHECK (length(authority_project) > 0),
            authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0),
            request_encoding_version INTEGER NOT NULL CHECK (request_encoding_version = 1),
            request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
            state TEXT NOT NULL CHECK (state IN (
                'staged', 'context-committed', 'acknowledged', 'terminal-rejected'
            )),
            result_json TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (producer, operation_key),
            CHECK (
                (state = 'staged' AND result_json IS NULL)
                OR (state <> 'staged' AND result_json IS NOT NULL)
            )
        );

CREATE INDEX idx_mc_claim_intents_unresolved
            ON mc_claim_intents(state, created_at_ms, producer, operation_key);

CREATE TABLE mc_claim_intent_controls (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            database_incarnation_id TEXT NOT NULL
                CHECK (length(database_incarnation_id) = 32),
            authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0),
            transition_state TEXT NOT NULL CHECK (transition_state IN (
                'accepting', 'draining', 'resetting'
            )),
            updated_at_ms INTEGER NOT NULL
        );

CREATE TABLE mc_claim_mirror_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            mirror_version INTEGER NOT NULL CHECK (mirror_version = 1),
            vector_version INTEGER NOT NULL CHECK (vector_version = 1),
            database_incarnation_id TEXT NOT NULL
                CHECK (length(database_incarnation_id) = 32),
            workspace_epoch TEXT NOT NULL CHECK (length(workspace_epoch) > 0),
            updated_at_ms INTEGER NOT NULL
        );

CREATE TABLE mc_claim_mirror_projects (
            database_incarnation_id TEXT NOT NULL
                CHECK (length(database_incarnation_id) = 32),
            project_id INTEGER NOT NULL CHECK (project_id > 0),
            project_generation INTEGER NOT NULL CHECK (project_generation >= 0),
            policy_generation INTEGER NOT NULL CHECK (policy_generation >= 0),
            acked_effect_id INTEGER NOT NULL CHECK (acked_effect_id >= 0),
            PRIMARY KEY (database_incarnation_id, project_id)
        ) WITHOUT ROWID;

CREATE TABLE mc_claim_mirror_claims (
            database_incarnation_id TEXT NOT NULL
                CHECK (length(database_incarnation_id) = 32),
            public_claim_id TEXT NOT NULL CHECK (length(public_claim_id) = 36),
            project_id INTEGER NOT NULL CHECK (project_id > 0),
            revision_locator TEXT NOT NULL CHECK (length(revision_locator) > 0),
            revision INTEGER NOT NULL CHECK (revision > 0),
            content TEXT NOT NULL,
            content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
            attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
            lifecycle_state TEXT NOT NULL CHECK (
                lifecycle_state IN ('active', 'archived', 'retired')
            ),
            applicability_json TEXT NOT NULL CHECK (json_valid(applicability_json)),
            policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
            provenance_label TEXT,
            project_generation INTEGER NOT NULL CHECK (project_generation >= 0),
            policy_generation INTEGER NOT NULL CHECK (policy_generation >= 0),
            PRIMARY KEY (database_incarnation_id, public_claim_id),
            UNIQUE (database_incarnation_id, revision_locator),
            FOREIGN KEY (database_incarnation_id, project_id)
                REFERENCES mc_claim_mirror_projects(database_incarnation_id, project_id)
                ON DELETE CASCADE
        ) WITHOUT ROWID;

CREATE INDEX idx_mc_claim_mirror_claims_project
            ON mc_claim_mirror_claims(database_incarnation_id, project_id, public_claim_id);

CREATE TABLE mc_claim_mirror_receipts (
            database_incarnation_id TEXT NOT NULL
                CHECK (length(database_incarnation_id) = 32),
            receipt_id INTEGER NOT NULL CHECK (receipt_id > 0),
            expected_effect_count INTEGER NOT NULL CHECK (expected_effect_count > 0),
            first_effect_id INTEGER NOT NULL CHECK (first_effect_id > 0),
            last_effect_id INTEGER NOT NULL CHECK (last_effect_id >= first_effect_id),
            group_digest TEXT NOT NULL CHECK (length(group_digest) = 64),
            generation_vector_json TEXT NOT NULL CHECK (json_valid(generation_vector_json)),
            applied_at_ms INTEGER NOT NULL,
            PRIMARY KEY (database_incarnation_id, receipt_id)
        ) WITHOUT ROWID;
    "#,
}];

///
/// `McStore::open` applies all bundled migrations, so this value is the highest schema version the binary supports.
/// migration list.
pub const LATEST_MIGRATION_VERSION: u32 = {
    let mut latest = 0;
    let mut index = 0;
    while index < MIGRATIONS.len() {
        if MIGRATIONS[index].version > latest {
            latest = MIGRATIONS[index].version;
        }
        index += 1;
    }
    latest
};

/// older schema.
///
const OLDEST_ADOPTABLE_MIGRATION_VERSION: u32 = LATEST_MIGRATION_VERSION;

/// The version lookup returns the highest `mc_cache` migration in `store.db`, or `None` when the namespace has no history.
/// The version lookup returns `None` for a fresh `store.db` or one predating the version table.
fn recorded_mc_cache_version(inner: &SqliteStore) -> Result<Option<u32>, McStoreError> {
    Ok(inner.with_conn(|conn| {
        let tracked: bool = conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM main.sqlite_schema
                  WHERE type = 'table' AND name = 'cortexkit_schema_version'
             )",
            [],
            |row| row.get(0),
        )?;
        if !tracked {
            return Ok(None);
        }
        let recorded: i64 = conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM cortexkit_schema_version WHERE namespace = ?1",
            [NS],
            |row| row.get(0),
        )?;
        Ok(u32::try_from(recorded).ok().filter(|version| *version > 0))
    })?)
}

/// Migration validation refuses `store.db` histories predating the consolidated bootstrap before applying migrations.
///
fn refuse_pre_cutover_store(inner: &SqliteStore) -> Result<(), McStoreError> {
    match recorded_mc_cache_version(inner)? {
        Some(recorded) if recorded < OLDEST_ADOPTABLE_MIGRATION_VERSION => {
            Err(McStoreError::PreCutoverModuleStore {
                recorded_version: recorded,
                bootstrap_version: OLDEST_ADOPTABLE_MIGRATION_VERSION,
            })
        }
        _ => Ok(()),
    }
}

/// Every statement requires the authority predicate so bindings outside MODULE-owned domains cannot modify rows.
fn normalize_authority_note_route_tx(
    tx: &rusqlite::Transaction<'_>,
    context_store_uuid: &str,
    project: &str,
    route_project_root: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE mc_notes
            SET project_path = ?2
          WHERE project_path = ?3
            AND EXISTS (
                SELECT 1 FROM mc_authority
                 WHERE context_store_uuid = ?1
                   AND project = ?2
                   AND domain = 'notes'
                   AND state = 'MODULE'
            )",
        params![context_store_uuid, project, route_project_root],
    )?;
    Ok(())
}

/// A project's workspace membership is the union of identities it reads: OWN has full visibility; FOREIGN is visible only in `share_categories`.
/// The row-version CAS that guards cache-state commits also guards writer orchestration, preventing stale producers from publishing against newer module state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistorianPhase {
    #[default]
    Idle,
    Firing,
    AwaitingProducer,
    Validating,
    Publishing,
}

impl HistorianPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            HistorianPhase::Idle => "idle",
            HistorianPhase::Firing => "firing",
            HistorianPhase::AwaitingProducer => "awaiting_producer",
            HistorianPhase::Validating => "validating",
            HistorianPhase::Publishing => "publishing",
        }
    }
}

/// The historian run pins an inclusive ordinal range.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistorianChunkRange {
    pub from_ordinal: u64,
    pub to_ordinal: u64,
}

/// The historian firing uses a content-sensitive identity for each selected message.
/// The outer firing vector preserves message order; each block vector preserves the canonical block order in [`ModuleMeta::block_identity_by_mid`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistorianSelectedMessageIdentity {
    pub mid: String,
    pub block_identities: Vec<BlockIdentity>,
}

/// `ModuleMeta` stores durable historian state.
/// When idle, `firing_seq` remains the monotonic last-issued sequence and the state clears in-flight identifiers.
/// Abandon paths clear in-flight identifiers and set `failure_backoff_at_ms`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistorianDurableState {
    #[serde(default)]
    pub state: HistorianPhase,
    #[serde(default)]
    pub firing_seq: u64,
    #[serde(default)]
    pub chunk_range: Option<HistorianChunkRange>,
    #[serde(default)]
    pub chunk_fingerprint: String,
    /// The producer receives durable content identities for exactly the message range.
    /// The write transaction permits later tail extension but rejects drift in selected bytes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_range_identities: Vec<HistorianSelectedMessageIdentity>,
    #[serde(default)]
    pub producer_session_id: Option<String>,
    #[serde(default)]
    pub producer_run_id: Option<String>,
    /// Broca identifies a run by `(project_root, harness, session)`.
    /// Recovery reattaches with the recorded harness rather than the resuming binding.
    /// After a cross-harness handoff, the resuming binding resolves the original run as `missing`.
    /// The resuming binding abandons and refires a run resolved as `missing`.
    /// An absent recorded harness makes recovery fall back to the resuming binding.
    #[serde(default)]
    pub producer_harness: Option<String>,
    #[serde(default)]
    pub fired_at_ms: Option<i64>,
    /// `expected_revert_epoch` records the session-level revert epoch observed when the chunk was assembled.
    /// A reattached producer publishes against `expected_revert_epoch` rather than the session's current epoch.
    #[serde(default)]
    pub expected_revert_epoch: u64,
    /// `compartment_set_generation` records the generation observed with the firing snapshot.
    /// Publication rechecks `compartment_set_generation` inside its transaction.
    /// The transactional recheck detects compartment-set changes after the snapshot before append.
    #[serde(default)]
    pub compartment_set_generation: CompartmentSetGeneration,
    #[serde(default)]
    pub failure_backoff_at_ms: Option<i64>,
    /// `last_failure` records human-readable detail of the most recent failed firing.
    /// A later firing clears `last_failure` after establishing its producer run.
    #[serde(default)]
    pub last_failure: Option<String>,
    /// `last_no_fire` records why the most recent pass declined to fire without numeric details.
    /// A firing clears `last_no_fire`.
    #[serde(default)]
    pub last_no_fire: Option<String>,
    /// `consecutive_publish_failures` is diagnostic only.
    /// Historian publication failures do not affect emitted bytes.
    #[serde(default)]
    pub consecutive_publish_failures: u32,
}

impl Default for HistorianDurableState {
    fn default() -> Self {
        HistorianDurableState {
            state: HistorianPhase::Idle,
            firing_seq: 0,
            chunk_range: None,
            chunk_fingerprint: String::new(),
            selected_range_identities: Vec::new(),
            producer_session_id: None,
            producer_run_id: None,
            producer_harness: None,
            fired_at_ms: None,
            expected_revert_epoch: 0,
            compartment_set_generation: CompartmentSetGeneration::default(),
            failure_backoff_at_ms: None,
            last_failure: None,
            last_no_fire: None,
            consecutive_publish_failures: 0,
        }
    }
}

/// `PassSchedulerObservation` records one accepted pass in the bounded scheduler history attached to [`PassTrace`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassSchedulerObservation {
    pub timestamp_ms: i64,
    pub scheduler_decision: String,
    pub drain_latch_active: bool,
}

/// `InterestingPassSchedulerObservation` retains incident-worthy scheduler evidence independently of the recency ring.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InterestingPassSchedulerObservation {
    pub timestamp_ms: i64,
    pub scheduler_decision: String,
    pub drain_latch_active: bool,
    /// `request_observed_at_ms` must not use the module clock as a fallback.
    /// The module clock and sender clock are not interchangeable correlation keys.
    pub request_observed_at_ms: Option<u64>,
    /// The transform response echoes the caller-owned full-array fingerprint.
    /// `full_array_fingerprint` is omitted only when the caller supplied no identity or exceeded the diagnostic byte bound.
    pub full_array_fingerprint: Option<String>,
    /// The field contains live superseded tool arcs observed when the ride gate opened, before downstream filters.
    /// A missing value means the gate stayed shut and selection did not run; zero means selection observed an empty set.
    #[serde(default)]
    pub eligible_supersession_count: Option<u64>,
    /// The newest-tag block window can remove all final decisions for eligible supersession arcs.
    /// `withheld_by_tag_window` counts tool arcs.
    #[serde(default)]
    pub withheld_by_tag_window: Option<u64>,
    /// Mutation-exempt or lineage-anchor messages can remove all final decisions for eligible supersession arcs.
    /// `withheld_by_exempt_message` counts tool arcs.
    #[serde(default)]
    pub withheld_by_exempt_message: Option<u64>,
    /// The final reduction decision list contains eligible supersession tool arcs.
    #[serde(default)]
    pub applied_supersession_count: Option<u64>,
}

impl InterestingPassSchedulerObservation {
    fn from_observation(
        observation: &PassSchedulerObservation,
        request_observed_at_ms: Option<u64>,
        full_array_fingerprint: Option<&str>,
        eligible_supersession_count: Option<u64>,
        withheld_by_tag_window: Option<u64>,
        withheld_by_exempt_message: Option<u64>,
        applied_supersession_count: Option<u64>,
    ) -> Self {
        Self {
            timestamp_ms: observation.timestamp_ms,
            scheduler_decision: observation.scheduler_decision.clone(),
            drain_latch_active: observation.drain_latch_active,
            request_observed_at_ms,
            full_array_fingerprint: full_array_fingerprint
                .filter(|fingerprint| fingerprint.len() <= MAX_FULL_ARRAY_FINGERPRINT_BYTES)
                .map(str::to_string),
            eligible_supersession_count,
            withheld_by_tag_window,
            withheld_by_exempt_message,
            applied_supersession_count,
        }
    }
}

fn serialize_scheduler_observation(
    observation: &PassSchedulerObservation,
) -> Result<String, McStoreError> {
    if !matches!(
        observation.scheduler_decision.as_str(),
        "Defer" | "Execute" | "Force85" | "Emergency95"
    ) {
        return Err(McStoreError::Serde(format!(
            "unknown scheduler decision {:?}",
            observation.scheduler_decision
        )));
    }
    serde_json::to_string(observation).map_err(|error| McStoreError::Serde(error.to_string()))
}

fn scheduler_pass_is_interesting(
    applied_reduction: bool,
    produced_output_divergence: bool,
) -> bool {
    applied_reduction || produced_output_divergence
}

fn serialize_interesting_scheduler_observation(
    observation: &PassSchedulerObservation,
    request_observed_at_ms: Option<u64>,
    full_array_fingerprint: Option<&str>,
    eligible_supersession_count: Option<u64>,
    withheld_by_tag_window: Option<u64>,
    withheld_by_exempt_message: Option<u64>,
    applied_supersession_count: Option<u64>,
) -> Result<String, McStoreError> {
    serde_json::to_string(&InterestingPassSchedulerObservation::from_observation(
        observation,
        request_observed_at_ms,
        full_array_fingerprint,
        eligible_supersession_count,
        withheld_by_tag_window,
        withheld_by_exempt_message,
        applied_supersession_count,
    ))
    .map_err(|error| McStoreError::Serde(error.to_string()))
}

/// The breadcrumb record retains durable receive, complete, and reject events for one session's transform passes.
/// `PassTrace` records the breadcrumb trail without advancing the cache `row_version`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassTrace {
    pub last_received_at_ms: i64,
    pub last_completed_at_ms: i64,
    pub last_reject_error: Option<String>,
    pub last_reject_at_ms: Option<i64>,
    pub reject_count: u64,
    pub receive_count: u64,
    pub first_divergence: Option<String>,
    pub last_divergence: Option<String>,
    /// The bounded history stores accepted scheduler decisions and latch state from oldest to newest.
    pub scheduler_history: Vec<PassSchedulerObservation>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistorianEventCandidate {
    pub kind: String,
    pub at_compartment: Option<u64>,
    pub compartment_id: Option<u64>,
    pub fields_json: String,
    pub created_at: i64,
    pub harness: String,
}

/// A primer candidate remains available across sessions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistorianPrimerCandidate {
    pub project_path: String,
    pub session_id: String,
    pub question: String,
    pub source_compartment_start: Option<u64>,
    pub source_compartment_end: Option<u64>,
    pub source_start_message_id: String,
    pub source_end_message_id: String,
    pub source_message_time: i64,
    pub created_at: i64,
}

/// `Project memory` must not receive privacy-gated user observations until the user opts into collection.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistorianUserMemoryCandidate {
    pub content: String,
    pub session_id: String,
    pub source_compartment_start: Option<u64>,
    pub source_compartment_end: Option<u64>,
    pub created_at: i64,
}

/// The predicate must match every durable state field before additive writes occur.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianPublishPredicate {
    pub firing_seq: u64,
    pub producer_run_id: String,
    pub chunk_fingerprint: String,
    pub selected_range_identities: Vec<HistorianSelectedMessageIdentity>,
    /// The generation captures the complete compartment set used to assemble the raw chunk.
    /// `count` distinguishes sequence reuse that `max_sequence` alone cannot.
    /// cannot distinguish.
    pub compartment_set_generation: CompartmentSetGeneration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianPublishResult {
    pub row_version: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistorianSideChannelDrainResult {
    pub attempted: usize,
    pub succeeded: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistorianSideChannelStatus {
    pub pending_count: usize,
    pub last_failure: Option<String>,
}

/// `CompartmentSetGeneration` provides a snapshot-consistent generation for the compartment set.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompartmentSetGeneration {
    pub max_sequence: i64,
    pub count: i64,
}

/// `HistorianAssemblySnapshot` stores the epoch and compartment generation with the compartments that determine the chunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianAssemblySnapshot {
    pub compartments: Vec<StoredCompartment>,
    pub revert_epoch: u64,
    pub compartment_set_generation: CompartmentSetGeneration,
}

/// The caller must use the returned `row_version` for the subsequent pass commit.
/// The caller must patch the returned metadata fields into the whole-blob `ModuleMeta`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TruncateOutcome {
    pub revert_epoch: u64,
    pub last_recut: Option<String>,
    pub row_version: u64,
}

pub struct HistorianPublishRequest<'a> {
    pub session_id: &'a str,
    pub expected_row_version: Option<u64>,
    pub expected_revert_epoch: u64,
    pub predicate: &'a HistorianPublishPredicate,
    pub project_path: &'a str,
    pub compartments: &'a [StoredCompartment],
    pub events: &'a [HistorianEventCandidate],
    pub primer_candidates: &'a [HistorianPrimerCandidate],
    pub user_memory_candidates: &'a [HistorianUserMemoryCandidate],
    pub publication_floor_ordinal: u64,
    pub chunk_transcript: Option<&'a str>,
    /// `raw_chunk_messages` preserves original CK messages, including full tool output, for `ctx_expand` recovery.
    pub raw_chunk_messages: Option<&'a str>,
}

/// `HistorianPublishError` distinguishes CAS conflicts from stale-producer state mismatches.
/// caller can tell "another writer already committed" from "this producer is stale."
#[derive(Debug)]
pub enum HistorianPublishError {
    Store(McStoreError),
    CasConflict {
        expected: Option<u64>,
        found: u64,
        reason: Option<String>,
    },
    /// A caller-supplied publication fence refused the publish before any write.
    /// A fence rejection does not indicate producer failure.
    /// A fresh snapshot may retry immediately after a fence rejection.
    FenceRejected {
        reason: String,
    },
    /// An overlap with a durable range rejects the publish.
    /// The rejection lets callers abandon a stale firing without treating it as a SQLite failure.
    /// The rejection leaves the session immediately reusable.
    CompartmentOverlap {
        existing_sequence: i64,
        incoming_start_message: i64,
        incoming_end_message: i64,
    },
    StateMismatch {
        expected: Box<HistorianPublishPredicate>,
        found: Box<HistorianDurableState>,
    },
    InvalidState {
        state: String,
    },
    Serde(String),
}

impl std::fmt::Display for HistorianPublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HistorianPublishError::Store(e) => write!(f, "store: {e}"),
            HistorianPublishError::FenceRejected { reason } => {
                write!(f, "publication fence rejected: {reason}")
            }
            HistorianPublishError::CompartmentOverlap {
                existing_sequence,
                incoming_start_message,
                incoming_end_message,
            } => write!(
                f,
                "historian compartment {incoming_start_message}..={incoming_end_message} overlaps existing sequence {existing_sequence}"
            ),
            HistorianPublishError::CasConflict {
                expected,
                found,
                reason,
            } => {
                if let Some(reason) = reason {
                    write!(
                        f,
                        "publish CAS conflict: expected {expected:?}, found {found}: {reason}"
                    )
                } else {
                    write!(f, "publish CAS conflict: expected {expected:?}, found {found}")
                }
            }
            HistorianPublishError::StateMismatch { expected, found } => write!(
                f,
                "historian publish state mismatch: expected seq {} run {} fingerprint {}, found {:?}",
                expected.firing_seq, expected.producer_run_id, expected.chunk_fingerprint, found
            ),
            HistorianPublishError::InvalidState { state } => {
                write!(f, "historian publish invalid state: {state}")
            }
            HistorianPublishError::Serde(e) => write!(f, "serde: {e}"),
        }
    }
}

impl std::error::Error for HistorianPublishError {}

impl From<McStoreError> for HistorianPublishError {
    fn from(e: McStoreError) -> Self {
        HistorianPublishError::Store(e)
    }
}

impl From<StoreError> for HistorianPublishError {
    fn from(e: StoreError) -> Self {
        HistorianPublishError::Store(McStoreError::Store(e))
    }
}

/// Persisted provider usage keeps pressure bands stable across retries and restarts.
/// A non-zero request-supplied value replaces the persisted value.
/// An absent or all-zero request uses the persisted value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModuleUsage {
    #[serde(default)]
    pub current_total_input_tokens: u64,
    #[serde(default)]
    pub context_limit_tokens: u64,
    /// The host uses the final-wire estimate only to clear an armed emergency latch.
    #[serde(default)]
    pub final_wire_input_tokens: u64,
    #[serde(default)]
    pub final_wire_trusted: bool,
}

impl ModuleUsage {
    pub fn is_non_zero(&self) -> bool {
        self.current_total_input_tokens != 0 || self.context_limit_tokens != 0
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeferredExecuteState {
    pub reason: String,
}

/// Cache metadata stores fake-compaction lineage counters so status reads match their terminal disposition.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineageDescentCounters {
    #[serde(default)]
    pub compaction_seen: u64,
    #[serde(default)]
    pub compaction_answered: u64,
    #[serde(default)]
    pub fork_arm: u64,
    #[serde(default)]
    pub descended: u64,
    #[serde(default)]
    pub unknown_ancestor: u64,
    #[serde(default)]
    pub already_bootstrapped: u64,
    #[serde(default)]
    pub not_compaction_shape: u64,
    #[serde(default)]
    pub observed_flag_missing_shape_present: u64,
    #[serde(default)]
    pub cycle_detected: u64,
    #[serde(default)]
    pub pending_build_skew: u64,
    #[serde(default)]
    pub pending_no_responses: u64,
}

/// Each edge stores the epoch of `new_key`.
/// For the first hop, `prior_epoch` is the prior node's epoch.
/// epoch thereafter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageConstituent {
    pub prior_key: String,
    pub new_key: String,
    pub epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageAnchor {
    pub block_id: String,
    pub message_id: String,
    pub content_hash: String,
    pub ordinal: u64,
}

/// `mc-module` recognizes canonical pre-overlay blocks.
/// The store owns source selection, validation, copying, terminal recording, and the prior-lineage publish fence.
pub struct LineageDescentRequest<'a> {
    pub target_key: &'a str,
    pub expected_target_row_version: Option<u64>,
    pub edge_id: u64,
    pub prior_key: &'a str,
    pub prior_epoch: u64,
    pub new_epoch: u64,
    pub constituents: &'a [LineageConstituent],
    pub compaction_observed: bool,
    pub anchor: Option<&'a LineageAnchor>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineageDescentDisposition {
    Descended,
    UnknownAncestor,
    AlreadyBootstrapped,
    NotCompactionShape,
    ObservedFlagMissingShapePresent,
    CycleDetected,
    PendingBuildSkew,
    Replay,
}

impl LineageDescentDisposition {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Descended => "descended",
            Self::UnknownAncestor => "unknown_ancestor",
            Self::AlreadyBootstrapped => "already_bootstrapped",
            Self::NotCompactionShape => "not_compaction_shape",
            Self::ObservedFlagMissingShapePresent => "observed_flag_missing_shape_present",
            Self::CycleDetected => "cycle_detected",
            Self::PendingBuildSkew => "pending_build_skew",
            Self::Replay => "replay",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LineageDescentOutcome {
    pub loaded: LoadedState,
    pub disposition: LineageDescentDisposition,
    pub source_key: Option<String>,
    pub prior_last_ordinal: Option<u64>,
    pub materialization_required: bool,
    /// The store may acknowledge a terminal record for this target only after the transform returns successfully.
    pub acknowledge: bool,
}

fn record_lineage_disposition(
    meta: &mut ModuleMeta,
    target_key: &str,
    edge_id: u64,
    disposition: &LineageDescentDisposition,
    source_key: Option<&str>,
    prior_last_ordinal: Option<u64>,
    completed: bool,
) {
    meta.lineage_descent_target_key = target_key.to_string();
    meta.lineage_descent_edge_id = edge_id;
    meta.lineage_descent_disposition = disposition.as_str().to_string();
    meta.lineage_descent_source_key = source_key.map(str::to_string);
    meta.ordinal_continuation_base = prior_last_ordinal;
    meta.descent_completed = completed;
    meta.lineage_descent_counters.compaction_seen = meta
        .lineage_descent_counters
        .compaction_seen
        .saturating_add(1);
    meta.lineage_descent_counters.compaction_answered = meta
        .lineage_descent_counters
        .compaction_answered
        .saturating_add(1);
    match disposition {
        LineageDescentDisposition::Descended => {
            meta.lineage_descent_counters.fork_arm =
                meta.lineage_descent_counters.fork_arm.saturating_add(1);
            meta.lineage_descent_counters.descended =
                meta.lineage_descent_counters.descended.saturating_add(1);
        }
        LineageDescentDisposition::UnknownAncestor => {
            meta.lineage_descent_counters.unknown_ancestor = meta
                .lineage_descent_counters
                .unknown_ancestor
                .saturating_add(1);
        }
        LineageDescentDisposition::AlreadyBootstrapped => {
            meta.lineage_descent_counters.already_bootstrapped = meta
                .lineage_descent_counters
                .already_bootstrapped
                .saturating_add(1);
        }
        LineageDescentDisposition::NotCompactionShape => {
            meta.lineage_descent_counters.not_compaction_shape = meta
                .lineage_descent_counters
                .not_compaction_shape
                .saturating_add(1);
        }
        LineageDescentDisposition::ObservedFlagMissingShapePresent => {
            meta.lineage_descent_counters
                .observed_flag_missing_shape_present = meta
                .lineage_descent_counters
                .observed_flag_missing_shape_present
                .saturating_add(1);
        }
        LineageDescentDisposition::CycleDetected => {
            meta.lineage_descent_counters.cycle_detected = meta
                .lineage_descent_counters
                .cycle_detected
                .saturating_add(1);
        }
        LineageDescentDisposition::PendingBuildSkew | LineageDescentDisposition::Replay => {}
    }
}

/// The module retains this TypeScript-owned compaction marker until the consuming transform pass handles it.
/// The module retains the marker so a restart cannot silently lose the pending boundary reconciliation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingCompactionMarkerState {
    pub ordinal: u64,
    pub end_message_id: String,
    pub published_at: i64,
}

/// The transform arms this durable alarm for a boundary-absent request that shares no prefix with the session's held lineage.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRewriteState {
    pub armed_at_ms: i64,
    pub absent_shape_fingerprint: String,
    #[serde(default)]
    pub absent_request_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_present_at_ms: Option<i64>,
}

/// The transform records the ordered block-identity vector per `mid` and rejects later drift to avoid applying frozen reductions to a different block list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockIdentity {
    pub kind_tag: String,
    pub byte_fingerprint: String,
}

/// Module metadata persists the frozen CK-native synthetic `todowrite` pair.
///
/// The transform replays the pair exactly at its stored anchor until the task-list content changes.
/// Rebuilding or moving the pair changes the exact prompt bytes seen by the provider.
/// Store both CK messages byte-complete to preserve the exact prompt bytes seen by the provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FrozenSyntheticTodoPair {
    /// The assistant `ToolCall` and tool result use the same synthetic tool-call ID.
    pub call_id: String,
    /// The stored ID identifies the real tail message after which the pair is inserted; `None` means no real tail exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_mid: Option<String>,
    /// The stored assistant-role CK message carries the synthetic `todowrite` `ToolCall`.
    pub assistant_msg: CkWireMessage,
    /// The stored tool-role CK message carries the matching synthetic `todowrite` `ToolResult`.
    pub tool_msg: CkWireMessage,
}

#[derive(Debug, Clone, Deserialize)]
struct FrozenSyntheticTodoPairData {
    call_id: String,
    #[serde(default)]
    anchor_mid: Option<String>,
    assistant_msg: CkWireMessage,
    tool_msg: CkWireMessage,
}

impl<'de> Deserialize<'de> for FrozenSyntheticTodoPair {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let data = FrozenSyntheticTodoPairData::deserialize(deserializer)?;
        let mut assistant_msg = data.assistant_msg;
        let mut tool_msg = data.tool_msg;
        // Frozen synthetic task-list messages are generated by this crate, not passed through from inbound messages.
        // Clear the retained `Value` after loading metadata so replay uses canonical typed serialization.
        assistant_msg.mark_fully_typed();
        tool_msg.mark_fully_typed();
        Ok(Self {
            call_id: data.call_id,
            anchor_mid: data.anchor_mid,
            assistant_msg,
            tool_msg,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteNudgeAnchorSeed {
    pub message_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServedBlockFingerprint {
    pub block_id: String,
    pub content_hash: String,
    pub serialized_len: usize,
}

fn bool_is_false(value: &bool) -> bool {
    !*value
}

fn u8_is_zero(value: &u8) -> bool {
    *value == 0
}

/// The state retains a response-side Channel-2 directive until gateway delivery acknowledges it.
/// The text is stored verbatim because Claude Code does not retain the injected prompt block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingChannel2Directive {
    pub text: String,
    pub directive_id: String,
    pub armed_at_ms: i64,
    pub arming_watermark: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TailHygienePartKind {
    Text,
    ToolInput,
    ToolOutput,
    File,
    Excluded,
}

/// Persist measurements so later passes can record appended content without tokenizing the historical prefix again.
/// Later passes record appended content and update recency from persisted measurements.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TailHygienePartMeasurement {
    pub key: String,
    pub content_hash: String,
    pub kind: TailHygienePartKind,
    pub tokens: i64,
    pub u_tokens: i64,
    pub tag_number: Option<i64>,
    pub tag_status: Option<String>,
    pub protected: bool,
}

/// `TailHygieneBaseline` measures hygiene metrics against the live tail, not the full history.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TailHygieneBaseline {
    pub baseline_u: i64,
    pub baseline_t: i64,
    pub turn_delta_u: i64,
    pub turn_delta_t: i64,
    pub baseline_generation: u64,
    pub computed_at_ms: i64,
    pub evaluable: bool,
    pub generation_invalidated: bool,
    pub baseline_parts: Vec<TailHygienePartMeasurement>,
    pub content_signature: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModuleMeta {
    /// `bootstrap_complete` is true after durable bootstrap completes; a seeded session can still await its first module fold.
    /// `bootstrap_seed_fold_pending` keeps a seeded session pending until its first module fold.
    pub initialized: bool,
    /// `bootstrap_seed_fold_pending` means a bootstrap state-sync adopted its boundary before the module rendered frozen prefix regions `m0` and `m1`.
    #[serde(default, skip_serializing_if = "bool_is_false")]
    pub bootstrap_seed_fold_pending: bool,
    /// `last_render_config` stores the render-config fingerprint from the last Hard fold; a differing incoming fingerprint starts a new Hard epoch.
    pub last_render_config: String,
    /// The module uses provider, model, system-prompt, and upgrade observations to adopt legacy rows without treating the first non-empty observation as a cache eviction.
    #[serde(default)]
    pub last_provider_id: String,
    #[serde(default)]
    pub last_model_key: String,
    #[serde(default)]
    pub last_system_prompt_hash: String,
    #[serde(default)]
    pub last_upgrade_state: String,
    /// `coverage_ordinal` stores the terminal ordinal covered by the last baseline; it is monotonic-absolute, not positional, and may decrease on revert-Hard.
    pub coverage_ordinal: Option<u64>,
    /// `last_todo_state` stores the normalized `todowrite` view captured on a bust pass; task lists are session-scoped working state, not project-shared memory or preferences.
    #[serde(default)]
    pub last_todo_state: Option<String>,
    /// Host-side task-list forwarding uses `last_todo_state_owner_message_id` to make retries of one tool result harmless without suppressing newer states.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_todo_state_owner_message_id: Option<String>,
    /// `last_todo_state_hash` stores the SHA-256 of normalized task-list state and combines with the owner id to detect replays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_todo_state_hash: Option<String>,
    /// `soft_refresh_pending` causes the next eligible transform to perform a SOFT refresh after `session.flush` sets it.
    #[serde(default)]
    pub soft_refresh_pending: bool,
    /// `guidance_date` stores this session's `Today's date: ...` guidance line.
    /// Passes update `guidance_date` only when they already rewrite cached content because the guidance line changes with the wall clock.
    #[serde(default)]
    pub guidance_date: String,
    /// `revert_epoch` increments atomically with each revert re-cut.
    /// `firings` carry the epoch observed at assembly, preventing stale publishers from appending output.
    #[serde(default)]
    pub revert_epoch: u64,
    /// `last_recut` records the suffix dropped by the most recent deterministic re-cut.
    #[serde(default)]
    pub last_recut: Option<String>,
    /// The module marks a boundary-absent, share-nothing request on a key with lineage as an alarmed raw-pass-through state.
    /// The alarmed raw-pass-through state does not permit a future truncate.
    #[serde(default)]
    pub pending_rewrite: Option<PendingRewriteState>,
    /// The module counts interleave edges between pending raw traffic and boundary-present traffic.
    /// The interleave-edge counter is diagnostic and triggers the durable ambiguous alarm.
    #[serde(default)]
    pub pending_rewrite_trip_count: u32,
    /// Repeated arm/clear interleaving sets the ambiguous alarm.
    /// When the ambiguous alarm is true, serving continues but boundary-absent traffic remains raw.
    #[serde(default)]
    pub pending_rewrite_ambiguous: bool,
    /// pending_rewrite_last_failure is independent of historian failures because no historian run owns the alarm state.
    #[serde(default)]
    pub pending_rewrite_last_failure: Option<String>,
    /// synthetic_todo stores a CK-native task-list pair and the real tail message ID preceding it.
    /// Replays preserve the synthetic pair's position; changed task-list content moves it to a new tail end.
    /// tail end.
    #[serde(default)]
    pub synthetic_todo: Option<FrozenSyntheticTodoPair>,
    /// The host replays bootstrap-copied note-nudge anchors after native serving so mode transitions retain them.
    #[serde(default)]
    pub note_nudge_anchors: Vec<NoteNudgeAnchorSeed>,
    /// m1_revision records the in-session revision used to render the frozen m1 block.
    /// An `m1` signal mismatch marks pending work but does not permit a provider-cache bust.
    /// m1_revision == 0 denotes pre-materialization metadata.
    #[serde(default)]
    pub m1_revision: u64,
    /// m1_compartment_seq stores the highest compartment sequence represented by m1_revision.
    /// m1_compartment_seq is unaffected by project memories, notes, or profile churn.
    /// `None` identifies metadata written before the component watermark was persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub m1_compartment_seq: Option<i64>,
    /// boundary_divergence_pending_count records coherent divergence observations suppressed by a pending compartment revision.
    /// Active historian and wrapup publication windows neither increment nor reset boundary_divergence_pending_count.
    /// After active historian and wrapup publication windows close, legacy or damaged rows resume escalation.
    #[serde(default, skip_serializing_if = "u8_is_zero")]
    pub boundary_divergence_pending_count: u8,
    /// memory_disabled records whether the last materializing pass disabled cross-session memory.
    /// `false` keeps pre-field metadata and fresh default state compatible with the historical enabled mode.
    #[serde(default)]
    pub memory_disabled: bool,
    /// m1_external_revision records the external render-lane fingerprint applied by the last HARD fold.
    /// Workspace changes trigger eager HARD folds and remain separate from deferred in-session changes.
    #[serde(default)]
    pub m1_external_revision: u64,
    /// project_memory_epoch stores the latest project-memory epoch received from TypeScript state-sync.
    /// A project-memory epoch update arms an eager HARD fold on the next transform instead of becoming an m1 delta.
    #[serde(default)]
    pub project_memory_epoch: u64,
    #[serde(default)]
    pub project_memory_epoch_pending: bool,
    /// user_profile_version participates in the in-session m1 signal.
    /// `user_profile_version` defers until a provider-cache bust opportunity.
    #[serde(default)]
    pub user_profile_version: u64,
    /// m1_user_profile_version records the profile version whose rows were rendered into m0 or m1.
    /// Separating rendered and current profile versions prevents acknowledgment of empty or budget-trimmed profile deltas before their bodies reach the provider.
    #[serde(default)]
    pub m1_user_profile_version: u64,
    /// State-sync watermark edges populate the durable start of a pending in-session delta.
    /// Pure defer transforms do not write the pending in-session delta start.
    /// A defer transform performs no writes, preserving replay behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub m1_pending_since_ms: Option<i64>,

    // m0 uses separate coverage watermarks and a memory manifest.
    /// folded_compartment_seq stores the highest compartment sequence folded into m0.
    /// folded_compartment_seq advances only on a HARD fold.
    /// `m0` renders compartments with `sequence > folded_compartment_seq` at P1 as new.
    #[serde(default)]
    pub folded_compartment_seq: i64,
    /// `coverage_start_ordinal` is the first ordinal covered by the compartment span reflected in `coverage_ordinal`.
    /// Leading system messages below coverage_start_ordinal are not summarized by compartments.
    /// Leading system messages below `coverage_start_ordinal` remain pass-through on full-array profiles.
    #[serde(default)]
    pub coverage_start_ordinal: Option<u64>,
    /// `coverage_compartment_seq` is the highest compartment `sequence` reflected in `coverage_ordinal` after a HARD fold or coverage-extending SOFT.
    /// `coverage_compartment_seq` avoids loading full rows for covered-system absorption on steady defer passes.
    /// Callers fall back to `folded_compartment_seq` when `coverage_compartment_seq` is `None`.
    #[serde(default)]
    pub coverage_compartment_seq: Option<i64>,
    /// The frozen m0 contains these claim revisions.
    #[serde(default)]
    pub rendered_revision_locators: Vec<String>,
    /// The frozen m0/m1 pair represents this claim generation vector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_snapshot_vector: Option<SnapshotVector>,
    /// `expiry_cutoff_ms` freezes the module clock at the last HARD materialization.
    /// Memory expiry is judged against expiry_cutoff_ms, not a live clock.
    /// `compose` uses the memory set that built the `m0` baseline.
    /// Memory that expires between a HARD fold and a later pass must not change the rendered bytes.
    /// `expiry_cutoff_ms` is 0 before the first HARD fold.
    #[serde(default)]
    pub expiry_cutoff_ms: i64,

    /// `historian` and `publication_floor_ordinal` never affect rendered bytes.
    #[serde(default)]
    pub historian: HistorianDurableState,
    /// A successful publication advances `publication_floor_ordinal`, the trigger-only protected-tail floor.
    /// `publication_floor_ordinal` only anchors future historian trigger selection; `coverage_ordinal` drives render and splice output.
    #[serde(default)]
    pub publication_floor_ordinal: Option<u64>,

    /// `mid` identifies the producer message.
    /// Each `BlockIdentity` stores its block kind and a fingerprint of canonical reduction-accounting bytes.
    #[serde(default)]
    pub block_identity_by_mid: BTreeMap<String, Vec<BlockIdentity>>,
    /// Covered and frozen identities reject changes, but OpenCode may rewrite an uncovered queued message in place.
    #[serde(default)]
    pub tail_identity_re_adopt_count: u64,
    /// `newest_live_block_id` is the newest non-synthetic flat block ID seen in a successful live pass.
    /// A created note uses `newest_live_block_id` as a best-effort pointer to the conversation end it refers to.
    #[serde(default)]
    pub newest_live_block_id: Option<String>,
    /// Absent or zero usage retains the prior value; any later non-zero usage replaces it, even after reclaim.
    #[serde(default)]
    pub last_usage: Option<ModuleUsage>,
    #[serde(default)]
    pub last_serializer_profile: String,
    /// `reasoning_cleared_through_ordinal` stores the OpenCode reasoning cutoff captured on the last bust for pre-tag compatibility.
    /// A defer pass replays the same cutoff after OpenCode rebuilds the native message array.
    #[serde(default)]
    pub reasoning_cleared_through_ordinal: u64,
    /// `reasoning_cleared_through_tag` stores the tag-number cutoff from the last independently busting pass.
    /// `reasoning_cleared_through_tag` is the cycle basis, not the highest changed message; retaining it across restart prevents later tag mints from adding reasoning strips to the cached prefix.
    /// Writers keep the older ordinal field populated so pre-tag readers remain compatible.
    #[serde(default)]
    pub reasoning_cleared_through_tag: u64,
    /// `caveman_age_basis_tag` stores the highest tag number used as the immutable caveman age basis by the last caveman-enabled bust.
    /// `caveman_age_basis_tag` persists across defer passes and restarts; newly tagged text waits for the next independently busting pass.
    /// Zero means no caveman-enabled bust has captured an age basis yet.
    #[serde(default)]
    pub caveman_age_basis_tag: u64,
    /// `cc_u1_active` stores the request-local Claude Code mechanics state committed with the rendered identity.
    #[serde(default)]
    pub cc_u1_active: bool,
    /// `tagging_surface_active` stores the request-local tagging-surface latch committed with the rendered identity.
    /// The dual latch lets a transition pass issue one cache-breaking HARD first.
    #[serde(default)]
    pub tagging_surface_active: bool,
    /// `channel1_last_nudge_undropped` stores the reclaimable-token amount at the last Channel-1 append or suppression reset.
    #[serde(default)]
    pub channel1_last_nudge_undropped: i64,
    /// An empty `channel1_last_nudge_level` means no active band.
    #[serde(default)]
    pub channel1_last_nudge_level: String,
    /// `tail_hygiene_baseline` stores measurements from one shared tail walk so both nudge channels use the same baseline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail_hygiene_baseline: Option<TailHygieneBaseline>,
    /// Auto-search decisions for served blocks remain hidden until an independent cache-busting pass; a new physical tail renders immediately and is never added.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub pending_user_hint_block_ids: BTreeSet<String>,
    /// After `ctx_reduce` records that the agent acted on a reminder, the next transform suppresses new Channel-1 appends but replays every stored append row.
    #[serde(default)]
    pub channel1_reduce_suppressed: bool,

    /// `last_execute_ordinal` stores the highest tail ordinal observed on an execute pass that froze reductions.
    #[serde(default)]
    pub last_execute_ordinal: u64,
    #[serde(default)]
    pub last_emergency_input_sample: f64,
    #[serde(default)]
    pub has_prior_emergency_drop: bool,
    #[serde(default)]
    pub deferred_execute_state: Option<DeferredExecuteState>,
    #[serde(default)]
    pub pending_compaction_marker: Option<PendingCompactionMarkerState>,

    /// Descent uses newest_live_ordinal, rather than compacted coverage, as the provisional base for the replacement array.
    #[serde(default)]
    pub newest_live_ordinal: u64,
    /// A successful cross-lineage copy sets descent_completed after writing the real boundary row; terminal refusal records leave it false so they cannot be selected as copy sources.
    #[serde(default)]
    pub descent_completed: bool,
    #[serde(default)]
    pub lineage_descent_target_key: String,
    #[serde(default)]
    pub lineage_descent_edge_id: u64,
    #[serde(default)]
    pub lineage_descent_disposition: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage_descent_source_key: Option<String>,
    /// New-array ordinals start immediately after the prior lineage's final ordinal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordinal_continuation_base: Option<u64>,
    /// The summary block is the durable mutation/trim anchor, not the mutable whole message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_content_hash: Option<String>,
    /// The fenced copy commits before transform composition; lineage_descent_materialized is set only by the hard pass that consumes the copy.
    /// If the process crashes after the fenced copy commits but before a hard pass consumes it, replay materializes the copied state again.
    #[serde(default)]
    pub lineage_descent_materialized: bool,
    #[serde(default)]
    pub lineage_descent_counters: LineageDescentCounters,

    #[serde(default)]
    pub channel2_nudge_state: String,
    /// Claude Code directive bytes await an idempotent gateway delivery echo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_channel2_directive: Option<PendingChannel2Directive>,
    /// The pressure-cycle latch remains true from a pressure crossing until a later below-threshold observation rearms the cycle.
    #[serde(default, skip_serializing_if = "bool_is_false")]
    pub channel2_pressure_latched: bool,
    /// The monotonic cycle identity makes directive IDs deterministic across retries.
    #[serde(default)]
    pub channel2_arming_watermark: u64,
    #[serde(default)]
    pub emergency_drain_active: bool,
    /// The drain-latch timestamp is 0 when inactive; otherwise, it is the Unix-millisecond entry time.
    #[serde(default)]
    pub emergency_drain_entered_at_ms: i64,
    /// The system persists the response-recency anchor only on passes that already commit.
    #[serde(default)]
    pub last_committed_pass_at_ms: i64,
    /// The fingerprint vector contains exactly the blocks served to the provider on that pass, so it is bounded by the output size.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub served_output_fingerprint: Vec<ServedBlockFingerprint>,

    /// The record tracks its shadow reset generation; the system rejects operations created before the most recent reset so they cannot write rows from an older generation.
    /// session state.
    #[serde(default)]
    pub shadow_generation: u64,
    /// The sequence number can be zero; callers must compare it directly rather than treating zero as missing.
    /// missing.
    #[serde(default)]
    pub shadow_seq: u64,
    /// The record enters quarantine when the shadow session first diverges from the source state; quarantine remains terminal for that generation until a reset clears the quarantine state and counter.
    /// After quarantine, later passes increment the divergence counter without adding duplicate divergence rows until a reset clears the counter and quarantine state.
    #[serde(default)]
    pub shadow_quarantined: bool,
    #[serde(default)]
    pub shadow_quarantined_pass_count: u64,
    /// consistent state.
    #[serde(default)]
    pub shadow_acked_watermarks: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingAgentDrop {
    pub id: i64,
    pub target_id: String,
    pub queued_at_ms: i64,
    pub command_id: Option<String>,
    pub command_first_applied_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendOutcome {
    pub queued: u64,
    pub duplicate: bool,
    /// The ledger row's disposition becomes terminal when the command resolves zero targets.
    /// NULL indicates that the command produced pending drops.
    pub disposition: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagMintInput {
    pub block_id: String,
    pub kind: String,
    pub token_count: i64,
    pub source_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McTagRow {
    pub tag_number: i64,
    pub block_id: String,
    pub kind: String,
    pub token_count: i64,
    pub created_at_ms: i64,
    pub source_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagNumberRow {
    pub block_id: String,
    pub tag_number: i64,
}

/// The tag identity validates the module's in-process baseline.
///
/// SQLite triggers advance `generation` on every insert, update, and delete.
/// count/max fields make normal append deltas recognizable without rehydrating old payloads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TagCacheSummary {
    pub generation: u64,
    pub count: usize,
    pub max_tag_number: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Channel1AppendRow {
    pub block_id: String,
    pub reminder_text: String,
    pub fired_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserHintRow {
    pub block_id: String,
    pub hint_text: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemporalMarkInput {
    pub ordinal: u64,
    pub block_id: String,
    pub marker_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemporalMarkRow {
    pub block_id: String,
    pub marker_text: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserHintDecisionInput {
    pub ordinal: u64,
    pub block_id: String,
    pub hint_text: String,
}

/// A transform commits staged overlay writes only after every local validation accepts the pass.
/// The cache-state CAS serializes competing speculative renders.
#[derive(Debug, Default)]
pub struct TransformOverlayBatch<'a> {
    pub max_seen_ordinal: Option<u64>,
    pub tag_mints: &'a [McTagRow],
    pub temporal_marks: &'a [TemporalMarkInput],
    pub user_hint: Option<&'a UserHintDecisionInput>,
    pub channel1_append: Option<&'a Channel1AppendRow>,
    pub created_at_ms: i64,
}

impl TransformOverlayBatch<'_> {
    pub fn is_empty(&self) -> bool {
        self.max_seen_ordinal.is_none()
            && self.tag_mints.is_empty()
            && self.temporal_marks.is_empty()
            && self.user_hint.is_none()
            && self.channel1_append.is_none()
    }
}

pub struct TransformCommit<'a> {
    pub expected: Option<u64>,
    pub core: &'a CoreState,
    pub meta: &'a ModuleMeta,
    pub consumed_drop_ids: &'a [i64],
    pub first_applied_command_ids: &'a [String],
    /// The cache commit fences the snapshot vector.
    pub claim_snapshot_vector: Option<&'a SnapshotVector>,
    /// The fenced commit re-reads the highest observed compartment sequence before publishing rendered m1 bytes.
    /// Re-reading the compartment sequence prevents an interleaved publication from being hidden by stale rendered m1 bytes.
    pub compartment_max_seq: Option<i64>,
    /// The transform records the authenticated filesystem root for this cache commit.
    pub project_root: Option<&'a str>,
    /// The transaction stores first-divergence attribution with the accepted pass.
    pub first_divergence: Option<&'a str>,
    /// The transaction stores the scheduler arm and drain-latch state only for accepted transform passes.
    pub scheduler_observation: Option<&'a PassSchedulerObservation>,
    /// The transform request carries the sender clock and exact full-array identity.
    pub scheduler_request_observed_at_ms: Option<u64>,
    pub scheduler_full_array_fingerprint: Option<&'a str>,
    /// An absent eligible-supersession-tool-arc count means selection did not run; zero means it ran and found none.
    pub scheduler_eligible_supersession_count: Option<u64>,
    pub scheduler_withheld_by_tag_window: Option<u64>,
    pub scheduler_withheld_by_exempt_message: Option<u64>,
    pub scheduler_applied_supersession_count: Option<u64>,
    /// A true value means the pass added a previously unfrozen reduction to the served output.
    pub scheduler_applied_reductions: bool,
    pub overlays: TransformOverlayBatch<'a>,
}

#[derive(Debug, Clone)]
pub struct SessionStatusSnapshot {
    pub loaded: LoadedState,
    pub compartment_count: usize,
    pub pending_drop_count: usize,
    pub tag_count: usize,
    pub pass_trace: Option<PassTrace>,
    pub compartment_page: Option<CompartmentPage>,
}

/// `CompartmentPage` contains a bounded chronological page of module-owned compartments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompartmentPage {
    pub compartments: Vec<StoredCompartment>,
    pub max_sequence: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrapupCommandRow {
    pub disposition: String,
    pub rounds: usize,
    pub summary: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecompCommandRow {
    pub disposition: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoStateSetOutcome {
    Updated { row_version: u64 },
    Noop,
}

/// A stored compartment row supplies the m0/m1 history source.
/// A value of 1 denotes the oldest row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredCompartment {
    pub sequence: i64,
    pub start_message: i64,
    pub end_message: i64,
    pub start_message_id: String,
    pub end_message_id: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub title: String,
    /// The field contains v2 P1 text or the flat legacy body and is always present.
    pub content: String,
    /// The field contains v2 paraphrase tiers and is `None` for legacy rows.
    pub p1: Option<String>,
    pub p2: Option<String>,
    pub p3: Option<String>,
    pub p4: Option<String>,
    /// The decay rate ranges from 1 through 100 and defaults to 50.
    pub importance: i32,
    pub episode_type: Option<String>,
    /// A value of 1 denotes a pre-v2 flat compartment; 0 denotes a v2 tiered compartment.
    pub legacy: i32,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectMuralArtifact {
    pub project_path: String,
    pub data_url: Vec<u8>,
    pub content_hash: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct M1RevisionSnapshot {
    pub max_compartment_seq: i64,
    pub note_status_version: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredCompartmentSearchRow {
    pub sequence: i64,
    pub title: String,
    pub content: String,
    pub p1: Option<String>,
    pub p2: Option<String>,
    pub p3: Option<String>,
    pub p4: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredChunkTranscript {
    pub compartment_seq: i64,
    pub start_ordinal: i64,
    pub end_ordinal: i64,
    pub transcript: Option<String>,
    /// The field stores JSON-encoded original CK messages for this compacted range.
    /// Old transcript rows lack this payload, so callers retain the condensed transcript fallback.
    pub raw_messages_json: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct NoteInput<'a> {
    pub project_path: &'a str,
    pub route_project_root: Option<&'a str>,
    pub session_id: &'a str,
    pub content: &'a str,
    pub surface_condition: Option<&'a str>,
    pub anchor_block_id: Option<&'a str>,
    pub now_ms: i64,
}

/// `surface_condition` selects the pending smart-note path.
/// An absent `surface_condition` creates an ordinary active note for legacy callers.
/// Rust-mode adapter keeps session-only notes on the TypeScript-owned path.
#[derive(Debug, Clone, Copy)]
pub struct NoteWriteInput<'a> {
    pub project_path: &'a str,
    /// Facade writes use the bound route root, while the note remains keyed by `project_path`.
    pub route_project_root: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub content: &'a str,
    pub surface_condition: Option<&'a str>,
    pub anchor_block_id: Option<&'a str>,
    pub anchor_ordinal: Option<i64>,
    pub compiled_provider: Option<&'a str>,
    pub compiled_config: Option<&'a str>,
    pub compiled_at: Option<i64>,
    pub compile_status: Option<&'a str>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NoteConditionCompile<'a> {
    pub compiled_provider: Option<&'a str>,
    pub compiled_config: Option<&'a str>,
    pub compiled_at: Option<i64>,
    pub compile_status: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredNote {
    pub id: i64,
    pub type_name: String,
    pub project_path: String,
    pub session_id: String,
    pub content: String,
    pub status: String,
    pub surface_condition: Option<String>,
    pub ready_at: Option<i64>,
    pub ready_reason: Option<String>,
    pub manifest_json: Option<String>,
    pub compiled_check: Option<String>,
    pub check_hash: Option<String>,
    pub check_cron: Option<String>,
    pub check_failure_count: i64,
    pub check_network_failure_count: i64,
    pub check_quarantined_until: Option<i64>,
    pub check_next_due_at: Option<i64>,
    pub check_compiled_at: Option<i64>,
    pub check_false_since_at: Option<i64>,
    pub check_last_liveness_at: Option<i64>,
    pub last_checked_at: Option<i64>,
    pub check_status: Option<String>,
    pub check_version: Option<i64>,
    pub policy_version: Option<i64>,
    pub harness: String,
    pub anchor_block_id: Option<String>,
    pub anchor_ordinal: Option<i64>,
    pub dismissed_at: Option<i64>,
    pub dismissal_resolution: Option<String>,
    pub status_version: i64,
    pub source_revision: i64,
    pub state_version: i64,
    pub compiled_source_revision: Option<i64>,
    pub compiled_project_path: Option<String>,
    pub compiled_provider: Option<String>,
    pub compiled_config: Option<String>,
    pub compiled_at: Option<i64>,
    pub compile_status: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub context_store_uuid: Option<String>,
    pub context_row_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteDelivery {
    pub delivery_id: String,
    pub note_id: i64,
    pub session_id: String,
    pub delivered_pass_fingerprint: String,
    pub transform_pass_id: String,
    pub acked_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteCasOutcome {
    Applied(StoredNote),
    Conflict { current: Option<StoredNote> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteTransitionInput<'a> {
    pub project_path: &'a str,
    pub note_id: i64,
    pub from_status: &'a str,
    pub source_revision: i64,
    pub to_status: &'a str,
    pub result: Option<&'a str>,
    pub now_ms: i64,
}

pub struct NoteEvaluationInput<'a> {
    pub project_path: &'a str,
    pub note_id: i64,
    pub source_revision: i64,
    pub verdict: bool,
    pub compiled_check: Option<&'a str>,
    pub manifest_json: Option<&'a str>,
    pub check_hash: Option<&'a str>,
    pub next_due_at: Option<i64>,
    pub now_ms: i64,
}

/// A durable smart-note evaluation claim expires after this lease length.
pub const NOTE_EVAL_CLAIM_LEASE_MS: i64 = 2 * 60_000;
/// `no_work` acquisition decisions remain replayable for this retention period.
pub const NOTE_EVAL_NO_WORK_RETENTION_MS: i64 = 10 * 60_000;
/// Terminal claim results remain replayable for this retention period.
pub const NOTE_EVAL_TERMINAL_RETENTION_MS: i64 = 7 * 24 * 60 * 60_000;
/// Terminal claims redact `terminal_response` after 24 hours.
/// Redact `terminal_response` before terminal-row expiry.
/// The system retains `terminal_response` for 24 hours, then redacts it before terminal-row expiry.
/// Redacting `terminal_response` prevents evaluator-supplied response text from surviving for the terminal-retention window.
pub const NOTE_EVAL_RESPONSE_REDACT_MS: i64 = 24 * 60 * 60_000;
/// Each project retains at most 10,000 rows in each evaluation ledger.
pub const NOTE_EVAL_LEDGER_CAP: i64 = 10_000;
/// Each committed compiled-artifact repair batch repairs 500 rows.
const NOTE_ARTIFACT_REPAIR_BATCH: i64 = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteEvalClaim {
    pub claim_id: String,
    pub note_id: i64,
    pub phase: String,
    pub acquisition_id: String,
    pub evaluator_instance: String,
    pub evaluator_slot: i64,
    pub registration_generation: i64,
    pub source_revision: i64,
    pub state_version: i64,
    pub policy_version: i64,
    pub protocol_epoch: i64,
    pub authority_generation: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// The acquisition transaction stores the caller closure's selection decision.
/// `NoWork` records its cause so the acquisition ledger can replay the decision after response loss.
/// `cycle_exhausted` tells the client to poll again after the selection cursor is spent.
/// An empty selection result ends the drain.
pub enum NoteEvalSelection {
    Claim { note_id: i64, phase: String },
    NoWork { cycle_exhausted: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)]
pub enum NoteEvalAcquireOutcome {
    Claim {
        claim: NoteEvalClaim,
        note: StoredNote,
        replayed: bool,
    },
    NoWork {
        replayed: bool,
        /// The acquisition ledger records cursor exhaustion so response-loss replay re-announces it.
        cycle_exhausted: bool,
    },
    /// The acquisition identity replays an expired decision.
    Expired,
    /// The acquisition identity replays a terminal claim result.
    Terminal {
        kind: String,
        response: Option<String>,
    },
    Busy,
    AuthorityChanged,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteEvalRenewOutcome {
    Renewed {
        expires_at: i64,
    },
    Expired,
    AuthorityChanged,
    UnknownClaim,
    Invalid,
    TerminalReplay {
        kind: String,
        response: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)]
pub enum NoteEvalCompleteOutcome {
    Applied { response_json: String },
    Replayed { response_json: String },
    Conflict { kind: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteEvalAbandonOutcome {
    Abandoned,
    Replayed { kind: String },
    UnknownClaim,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteEvalReducedState {
    pub status: String,
    pub ready_at: Option<i64>,
    pub ready_reason: Option<String>,
    pub last_checked_at: Option<i64>,
    pub updated_at_ms: i64,
    pub compiled_check: Option<String>,
    pub manifest_json: Option<String>,
    pub check_hash: Option<String>,
    pub check_cron: Option<String>,
    pub check_version: Option<i64>,
    pub check_status: Option<String>,
    pub check_failure_count: i64,
    pub check_network_failure_count: i64,
    pub check_quarantined_until: Option<i64>,
    pub check_next_due_at: Option<i64>,
    pub check_compiled_at: Option<i64>,
    pub check_false_since_at: Option<i64>,
    pub check_last_liveness_at: Option<i64>,
    pub policy_version: Option<i64>,
    pub compiled_source_revision: Option<i64>,
    pub compiled_project_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredNoteSearchRow {
    pub id: i64,
    pub content: String,
    pub status: String,
    pub surface_condition: Option<String>,
    pub updated_at_ms: i64,
}

/// The ledger persists one claim command intent and its committed result JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimIntentRecord {
    pub binding: ClaimIntentBinding,
    pub command: ClaimCommandIdentity,
    pub request_digest: String,
    pub state: ClaimIntentState,
    pub result_json: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimIntentMutationOutcome {
    pub record: ClaimIntentRecord,
    pub replayed: bool,
}

/// The authority state covers one context store, project, and owned domain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorityRow {
    pub context_store_uuid: String,
    pub project: String,
    pub domain: String,
    pub state: String,
    pub generation: u64,
    pub captured_upper_bound: Option<i64>,
    pub drain_generation: Option<u64>,
    pub drain_cursor: i64,
    pub step_seed: bool,
    pub step_memories: bool,
    pub step_notes: bool,
    pub step_compartments: bool,
    pub step_reconcile: bool,
    pub step_verify: bool,
    pub step_flip: bool,
    pub coordinator_lease: Option<String>,
    pub lease_expires_at: Option<i64>,
    /// Drain begin or takeover mints an attempt-unique token; step and finish require that token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_token: Option<String>,
    pub checksum_expected: Option<String>,
    pub checksum_actual: Option<String>,
    pub checksum_ok: Option<bool>,
}

/// Each `mirror.pull` call returns one append-only row; its snapshot contains the complete row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangefeedRow {
    pub feed_seq: i64,
    pub domain: String,
    pub op: String,
    pub module_row_id: i64,
    pub full_row_snapshot: Value,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangefeedPage {
    pub domain: String,
    pub cursor: i64,
    pub next_cursor: i64,
    pub has_more: bool,
    pub rows: Vec<ChangefeedRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamTaskCommandRow {
    pub response_json: String,
    pub created_at: i64,
}

/// The crash-idempotent authority seed uses the persisted context-store row.
/// The module persists owned fields and separately verifies the host-provided content hash without interpreting the JSON payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthoritySeedRow {
    pub source_row_id: i64,
    pub snapshot: Value,
}

#[derive(Debug, Clone)]
pub struct LoadedState {
    pub core: CoreState,
    pub meta: ModuleMeta,
    /// Callers pass `row_version` to [`McStore::commit`] as the CAS expectation.
    /// `None` selects [`McStore::commit`]'s INSERT path when no row exists.
    pub row_version: Option<u64>,
}

/// The module collects these query-family timings while loading a transform snapshot.
///
/// These fields expose the read-transaction breakdown in the module's per-pass diagnostic line without changing snapshot contents or transaction scope.
#[derive(Debug, Clone, Default)]
pub struct TransformSnapshotTimings {
    pub cache_state_ms: f64,
    pub temporal_ms: f64,
    pub user_hints_ms: f64,
    pub channel1_ms: f64,
    pub overlay_frontier_ms: f64,
}

/// The module reads cache state and every non-tag byte-affecting transform overlay from one SQLite snapshot.
///
/// The module caches tag rows as immutable payloads and validates them with [`TagCacheSummary`].
#[derive(Debug, Clone)]
pub struct TransformSnapshot {
    pub loaded: LoadedState,
    pub temporal_marks: Vec<TemporalMarkRow>,
    pub user_hints: Vec<UserHintRow>,
    pub channel1_appends: Vec<Channel1AppendRow>,
    pub overlay_frontier: Option<u64>,
    pub timings: TransformSnapshotTimings,
}

#[derive(Debug)]
pub struct WrapupCommandRecord<'a> {
    pub session_id: &'a str,
    pub command_id: &'a str,
    pub disposition: &'a str,
    pub rounds: usize,
    pub summary: &'a str,
    pub created_at: i64,
    pub expected_row_version: Option<u64>,
    pub expected_revert_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordWrapupCommandOutcome {
    Recorded(WrapupCommandRow),
    Stale {
        found_row_version: Option<u64>,
        found_revert_epoch: u64,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModuleWorkspaceMemberRow {
    pub project_path: String,
    pub display_name: String,
    pub display_path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModuleWorkspaceRow {
    pub name: String,
    pub share_categories: Vec<String>,
    pub members: Vec<ModuleWorkspaceMemberRow>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModuleDropSeedRow {
    pub block_id: String,
    pub related_block_ids: Vec<String>,
    pub drop_mode: String,
    pub payload: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PendingAgentDropSeedRow {
    pub block_id: String,
    pub queued_at_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserHintSeedRow {
    pub block_id: String,
    pub hint_text: String,
}

/// The module replays the TypeScript-owned strip decision before its first transform.
/// Message-level strips carry the message ID because one source operation can cover several CK blocks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModuleStripSeedRow {
    pub message_id: String,
    pub strip_kind: String,
}

pub struct ModuleStateSyncRequest<'a> {
    pub session_id: &'a str,
    pub project_path: &'a str,
    pub shadow_generation: u64,
    pub expected_shadow_seq: u64,
    /// A full seed includes the producer's current flat compaction boundary.
    pub seed_boundary_id: Option<&'a str>,
    pub drop_seeds: &'a [ModuleDropSeedRow],
    pub drop_seed_skipped: usize,
    pub pending_agent_drops: &'a [PendingAgentDropSeedRow],
    pub pending_agent_drops_skipped: usize,
    pub user_hint_seeds: &'a [UserHintSeedRow],
    pub auto_search_hint_skipped: usize,
    /// When user_hints_replace_session is true, the seed batch is the host's complete hint-decision list for the session.
    /// When user_hints_replace_session is true, an absent stored hint block has no backing decision the host can validate.
    /// A pre-policy hint whose raw message is gone has no backing decision the host can validate.
    /// Keeping a hint without a validatable backing decision replays unvalidated overlay bytes forever.
    /// When user_hints_replace_session is true, seed rows are upserted and absent stored rows are deleted.
    pub user_hints_replace_session: bool,
    pub note_nudge_anchors: Option<&'a [NoteNudgeAnchorSeed]>,
    pub todo_synthetic_anchor: Option<&'a FrozenSyntheticTodoPair>,
    pub todo_synthetic_anchor_present: bool,
    pub emergency_latches: Option<(f64, bool, u64)>,
    pub pending_compaction_marker: Option<Option<&'a PendingCompactionMarkerState>>,
    pub deferred_execute_state: Option<Option<&'a DeferredExecuteState>>,
    pub channel2_nudge_state: Option<&'a str>,
    pub strip_seeds: &'a [ModuleStripSeedRow],
    pub strip_seed_skipped: usize,
    pub reasoning_cleared_through_tag: Option<u64>,
    pub compartments: &'a [StoredCompartment],
    pub user_profile: &'a [String],
    /// False means the sender omitted the profile section; true includes Some(empty) clears.
    pub user_profile_present: bool,
    pub workspace: Option<&'a ModuleWorkspaceRow>,
    /// False means the sender omitted the workspace section; true includes an explicit clear.
    pub workspace_present: bool,
    pub last_todo_state: Option<String>,
    pub project_memory_epoch: Option<u64>,
    pub user_profile_version: Option<u64>,
    pub acked_watermarks: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleStateSyncResult {
    pub shadow_generation: u64,
    pub shadow_seq: u64,
    pub row_version: u64,
    /// Number of TS drop rows that could not be materialized into frozen module units.
    pub drop_seeds_skipped: usize,
    pub pending_agent_drops_seeded: usize,
    pub pending_agent_drops_skipped: usize,
    pub user_hint_seeds_seeded: usize,
    pub auto_search_hint_skipped: usize,
    pub note_nudge_anchors_seeded: usize,
    pub todo_synthetic_anchor_seeded: bool,
    pub emergency_latches_seeded: bool,
    /// Number of TS strip rows that could not be materialized into frozen module units.
    pub strip_seeds_skipped: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateImportResult {
    pub imported: usize,
    pub duplicate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateImportPreflight {
    Ready,
    Duplicate { imported: usize },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateImportValidationError {
    SeqNotIncreasing { previous: i64, current: i64 },
    RangeInvalid { sequence: i64 },
    RangesOverlap { previous: i64, current: i64 },
    P1Empty { sequence: i64 },
    EndMessageIdInvalid { sequence: i64 },
}

impl StateImportValidationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::SeqNotIncreasing { .. } => "seq_not_increasing",
            Self::RangeInvalid { .. } => "range_invalid",
            Self::RangesOverlap { .. } => "ranges_overlap",
            Self::P1Empty { .. } => "p1_empty",
            Self::EndMessageIdInvalid { .. } => "end_message_id_invalid",
        }
    }
}

#[derive(Debug)]
pub enum StateImportError {
    Store(McStoreError),
    SessionNotEmpty,
    Validation(StateImportValidationError),
}

#[derive(Debug)]
pub enum ModuleStateSyncError {
    Store(McStoreError),
    GenerationMismatch { expected: u64, found: u64 },
    AuthoritySeqMismatch { expected: u64, found: u64 },
    HistorianBusy { phase: HistorianPhase },
    InvalidSeedBoundary { declared: String, detail: String },
    Serde(String),
}

#[derive(Debug)]
pub enum McStoreError {
    Store(StoreError),
    /// `store.db` contains pre-consolidation `mc_cache` history that this binary cannot adopt or migrate.
    /// `store.db` contains pre-consolidation `mc_cache` history that this binary cannot adopt or migrate.
    PreCutoverModuleStore {
        recorded_version: u32,
        bootstrap_version: u32,
    },
    /// A concurrent writer committed first, changing the on-disk row_version.
    /// The caller re-loads and re-steps.
    CasConflict {
        expected: Option<u64>,
        found: u64,
    },
    /// An authority transition was requested from the wrong durable state.
    AuthorityStateMismatch {
        expected: String,
        found: String,
    },
    /// A caller used a stale authority generation after another transition committed.
    AuthorityGenerationMismatch {
        expected: u64,
        found: u64,
    },
    /// The module feed advanced after a drain captured its replay bound.
    AuthorityFeedHeadAdvanced {
        captured: i64,
        found: i64,
    },
    Serde(String),
    MemoryDuplicateContent {
        id: i64,
    },
    NoteCasConflict {
        id: i64,
        expected_status: String,
        expected_version: i64,
        found_status: String,
        found_version: i64,
    },
    NoteOwnershipMismatch {
        id: i64,
        project: String,
    },
    /// An append would overlap a durable compartment range for the same session.
    CompartmentRangeOverlap {
        existing_sequence: i64,
        incoming_start_message: i64,
        incoming_end_message: i64,
    },
    /// A facade route bound to an authority-managed identity must use the domain identity, not filesystem-path transport vocabulary, to write.
    /// A facade route bound to an authority-managed identity must use the domain identity, not filesystem-path transport vocabulary, to write.
    FacadeProjectVocabularyMismatch {
        route_project_root: String,
        authority_project: String,
        write_project: String,
        domain: String,
    },
    ClaimIntentInvalid(String),
    ClaimIntentIdentityConflict {
        producer: String,
        operation_key: String,
    },
    ClaimIntentBindingMismatch {
        field: &'static str,
        expected: String,
        found: String,
    },
    ClaimIntentAuthorityFrozen {
        state: String,
    },
    /// The bound daemon route resolves to no memories authority row.
    ClaimIntentRouteNotManaged,
    ClaimIntentNotFound {
        producer: String,
        operation_key: String,
    },
    ClaimIntentTransition {
        expected: String,
        found: String,
    },
    ClaimIntentResetBlocked {
        unresolved: usize,
    },
}

impl std::fmt::Display for McStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McStoreError::Store(e) => write!(f, "store: {e}"),
            McStoreError::PreCutoverModuleStore {
                recorded_version,
                bootstrap_version,
            } => write!(
                f,
                "module store predates the claims cutover: store.db records mc_cache schema v{recorded_version}, and this binary composes v{bootstrap_version} from an empty schema. \
                 It is not migrated or reinterpreted. Stop every Magic Context process, move or delete store.db (and its -wal/-shm siblings) to let this binary compose a new one; \
                 project memory lives in context.db and is unaffected."
            ),
            McStoreError::CasConflict { expected, found } => {
                write!(f, "cas conflict: expected {expected:?}, found {found}")
            }
            McStoreError::AuthorityStateMismatch { expected, found } => {
                write!(
                    f,
                    "authority state mismatch: expected {expected}, found {found}"
                )
            }
            McStoreError::AuthorityGenerationMismatch { expected, found } => {
                write!(
                    f,
                    "authority generation mismatch: expected {expected}, found {found}"
                )
            }
            McStoreError::AuthorityFeedHeadAdvanced { captured, found } => write!(
                f,
                "authority feed head advanced after drain capture: captured {captured}, found {found}"
            ),
            McStoreError::Serde(e) => write!(f, "serde: {e}"),
            McStoreError::MemoryDuplicateContent { id } => {
                write!(f, "memory content already exists as ID {id}")
            }
            McStoreError::NoteCasConflict {
                id,
                expected_status,
                expected_version,
                found_status,
                found_version,
            } => write!(
                f,
                "note {id} CAS conflict: expected {expected_status}@{expected_version}, found {found_status}@{found_version}"
            ),
            McStoreError::NoteOwnershipMismatch { id, project } => {
                write!(f, "note {id} is not owned by project {project}")
            }
            McStoreError::CompartmentRangeOverlap {
                existing_sequence,
                incoming_start_message,
                incoming_end_message,
            } => write!(
                f,
                "compartment {incoming_start_message}..={incoming_end_message} overlaps existing sequence {existing_sequence}"
            ),
            McStoreError::FacadeProjectVocabularyMismatch {
                route_project_root,
                authority_project,
                write_project,
                domain,
            } => write!(
                f,
                "{domain} facade route {route_project_root} is authority-managed as {authority_project}, but the write used {write_project}"
            ),
            McStoreError::ClaimIntentInvalid(reason) => {
                write!(f, "invalid claim intent: {reason}")
            }
            McStoreError::ClaimIntentIdentityConflict {
                producer,
                operation_key,
            } => write!(
                f,
                "claim command identity {producer}/{operation_key} was reused with a different request digest"
            ),
            McStoreError::ClaimIntentBindingMismatch {
                field,
                expected,
                found,
            } => write!(
                f,
                "claim intent {field} mismatch: expected {expected}, found {found}"
            ),
            McStoreError::ClaimIntentAuthorityFrozen { state } => {
                write!(f, "claim intent writes are frozen during authority state {state}")
            }
            McStoreError::ClaimIntentRouteNotManaged => write!(
                f,
                "claim intent route has no memories authority; refusing to stage"
            ),
            McStoreError::ClaimIntentNotFound {
                producer,
                operation_key,
            } => write!(f, "claim intent {producer}/{operation_key} was not found"),
            McStoreError::ClaimIntentTransition { expected, found } => write!(
                f,
                "claim intent state mismatch: expected {expected}, found {found}"
            ),
            McStoreError::ClaimIntentResetBlocked { unresolved } => write!(
                f,
                "store rebuild refused while {unresolved} claim intents remain unresolved"
            ),
        }
    }
}
impl std::error::Error for McStoreError {}
impl From<StoreError> for McStoreError {
    fn from(e: StoreError) -> Self {
        McStoreError::Store(e)
    }
}

impl std::fmt::Display for StateImportValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SeqNotIncreasing { previous, current } => write!(
                f,
                "compartment seq must be strictly increasing: {current} followed {previous}"
            ),
            Self::RangeInvalid { sequence } => {
                write!(
                    f,
                    "compartment {sequence} has start_message after end_message"
                )
            }
            Self::RangesOverlap { previous, current } => write!(
                f,
                "compartment {current} overlaps or precedes compartment {previous}"
            ),
            Self::P1Empty { sequence } => {
                write!(f, "compartment {sequence} has an empty p1")
            }
            Self::EndMessageIdInvalid { sequence } => write!(
                f,
                "compartment {sequence} end_message_id is not a parseable mid#idx"
            ),
        }
    }
}

impl std::error::Error for StateImportValidationError {}

impl std::fmt::Display for StateImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(f, "store: {error}"),
            Self::SessionNotEmpty => write!(f, "session already has durable state"),
            Self::Validation(error) => write!(f, "{}: {error}", error.code()),
        }
    }
}

impl std::error::Error for StateImportError {}

impl From<McStoreError> for StateImportError {
    fn from(error: McStoreError) -> Self {
        Self::Store(error)
    }
}

impl From<StoreError> for StateImportError {
    fn from(error: StoreError) -> Self {
        Self::Store(McStoreError::Store(error))
    }
}

impl std::fmt::Display for ModuleStateSyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModuleStateSyncError::Store(e) => write!(f, "store: {e}"),
            ModuleStateSyncError::GenerationMismatch { expected, found } => write!(
                f,
                "shadow generation mismatch: expected {expected}, found {found}"
            ),
            ModuleStateSyncError::AuthoritySeqMismatch { expected, found } => write!(
                f,
                "authority seq mismatch: expected {expected}, found {found}"
            ),
            ModuleStateSyncError::HistorianBusy { phase } => {
                write!(f, "historian compartment sync busy: {}", phase.as_str())
            }
            ModuleStateSyncError::InvalidSeedBoundary { declared, detail } => {
                write!(f, "invalid seed boundary {declared:?}: {detail}")
            }
            ModuleStateSyncError::Serde(e) => write!(f, "serde: {e}"),
        }
    }
}

impl std::error::Error for ModuleStateSyncError {}

impl From<McStoreError> for ModuleStateSyncError {
    fn from(e: McStoreError) -> Self {
        ModuleStateSyncError::Store(e)
    }
}

impl From<StoreError> for ModuleStateSyncError {
    fn from(e: StoreError) -> Self {
        ModuleStateSyncError::Store(McStoreError::Store(e))
    }
}

/// The fenced commit transaction returns either the new row_version or a CAS conflict containing the on-disk version.
/// CAS conflicts are return values so the transaction can commit no changes and the caller can reload cleanly.
enum CommitOutcome {
    Committed(u64),
    CasConflict(u64),
}

enum AuthorityFinishDrainOutcome {
    Finished(Box<AuthorityRow>),
    FeedHeadAdvanced { captured: i64, found: i64 },
}

enum ClaimIntentTxnOutcome {
    Applied(ClaimIntentMutationOutcome),
    IdentityConflict,
    BindingMismatch {
        field: &'static str,
        expected: String,
        found: String,
    },
    Frozen(String),
    /// No `mc_authority` row is reachable from the bound daemon route.
    /// `RouteNotManaged` indicates that no `mc_authority` row is reachable from the bound daemon route.
    /// `RouteNotManaged` means "never managed here"; `Frozen` means "managed but transitioning".
    RouteNotManaged,
    NotFound,
    Transition {
        expected: String,
        found: String,
    },
    ResetBlocked(usize),
    ResetGranted,
}

enum PublishTxnOutcome {
    Committed(HistorianPublishResult),
    CasConflict {
        found: u64,
        reason: Option<String>,
    },
    FenceRejected(String),
    CompartmentOverlap {
        existing_sequence: i64,
        incoming_start_message: i64,
        incoming_end_message: i64,
    },
    StateMismatch(Box<HistorianDurableState>),
    InvalidState(String),
    Serde(String),
}

enum AppendCompartmentsTxnOutcome {
    Appended,
    Overlap {
        existing_sequence: i64,
        incoming_start_message: i64,
        incoming_end_message: i64,
    },
}

const HISTORIAN_SIDE_CHANNEL_KINDS: [&str; 3] = ["event", "primer", "user_observation"];
const HISTORIAN_SIDE_CHANNEL_DRAIN_PER_KIND: usize = 32;
const HISTORIAN_SIDE_CHANNEL_MAX_BACKOFF_MS: i64 = 60_000;
const HISTORIAN_SIDE_CHANNEL_ERROR_CAP: usize = 2_000;

#[derive(Debug)]
struct HistorianSideChannelOutboxRow {
    session_id: String,
    id: HistorianSideChannelOutboxId,
    payload_json: String,
    attempt_count: u32,
}

#[derive(Debug)]
struct HistorianSideChannelPendingItem {
    id: HistorianSideChannelOutboxId,
    payload_json: String,
    created_at_ms: i64,
}

#[derive(Debug, Clone)]
struct HistorianSideChannelOutboxId {
    firing_seq: u64,
    kind: String,
    source_start: u64,
    source_end: u64,
    item_index: usize,
}

enum AbandonHistorianTxnOutcome {
    Unchanged,
    Committed(u64),
    Serde(String),
}

enum TruncateTxnOutcome {
    Committed(TruncateOutcome),
    CasConflict(u64),
    Serde(String),
}

#[allow(clippy::large_enum_variant)]
enum LineageDescentTxnOutcome {
    Committed(LineageDescentOutcome),
    CasConflict(u64),
    Invalid(String),
    Serde(String),
}

enum StateImportTxnOutcome {
    Imported(usize),
    Duplicate(usize),
    SessionNotEmpty,
    Validation(StateImportValidationError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedSeedBoundary {
    boundary_id: String,
    coverage_start_ordinal: u64,
    coverage_end_ordinal: u64,
    max_sequence: i64,
}

const AUTHORITY_SELECT_SQL: &str = "SELECT context_store_uuid, project, domain, state, generation,
    captured_upper_bound, drain_generation, drain_cursor, step_seed, step_memories,
    step_notes, step_compartments, step_reconcile, step_verify, step_flip,
    coordinator_lease, lease_expires_at, coordinator_token,
    checksum_expected, checksum_actual, checksum_ok
    FROM mc_authority WHERE context_store_uuid = ?1 AND project = ?2 AND domain = ?3";

const CLAIM_INTENT_COLUMNS: &str = "producer, operation_key, database_incarnation_id,
    format_epoch, authority_project, authority_generation, request_digest, state,
    result_json, created_at_ms, updated_at_ms";

fn claim_intent_record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClaimIntentRecord> {
    let state: String = row.get(7)?;
    let Some(state) = ClaimIntentState::parse(&state) else {
        return Err(rusqlite::Error::InvalidColumnType(
            7,
            "state".to_string(),
            rusqlite::types::Type::Text,
        ));
    };
    let authority_generation: i64 = row.get(5)?;
    Ok(ClaimIntentRecord {
        command: ClaimCommandIdentity {
            producer: row.get(0)?,
            operation_key: row.get(1)?,
        },
        binding: ClaimIntentBinding {
            database_incarnation_id: row.get(2)?,
            format_epoch: row.get(3)?,
            authority_project: row.get(4)?,
            authority_generation: authority_generation as u64,
        },
        request_digest: row.get(6)?,
        state,
        result_json: row.get(8)?,
        created_at_ms: row.get(9)?,
        updated_at_ms: row.get(10)?,
    })
}

fn validate_claim_intent_fields(
    binding: &ClaimIntentBinding,
    command: &ClaimCommandIdentity,
) -> Result<(), McStoreError> {
    if !is_lower_hex(&binding.database_incarnation_id, 32) {
        return Err(McStoreError::ClaimIntentInvalid(
            "database incarnation ID must be 32 lowercase hex characters".to_string(),
        ));
    }
    if binding.format_epoch < 1 {
        return Err(McStoreError::ClaimIntentInvalid(
            "format epoch must be positive".to_string(),
        ));
    }
    if binding.authority_project.is_empty() {
        return Err(McStoreError::ClaimIntentInvalid(
            "authority project is required".to_string(),
        ));
    }
    i64::try_from(binding.authority_generation).map_err(|_| {
        McStoreError::ClaimIntentInvalid("authority generation exceeds SQLite i64".to_string())
    })?;
    for (name, value) in [
        ("producer", command.producer.as_str()),
        ("operation key", command.operation_key.as_str()),
    ] {
        if value.is_empty() || value.len() > 256 {
            return Err(McStoreError::ClaimIntentInvalid(format!(
                "{name} must contain 1..=256 bytes"
            )));
        }
    }
    Ok(())
}

fn require_claim_intent_binding(
    stored: &ClaimIntentRecord,
    binding: &ClaimIntentBinding,
) -> Result<(), McStoreError> {
    for (field, expected, found) in [
        (
            "database incarnation",
            stored.binding.database_incarnation_id.clone(),
            binding.database_incarnation_id.clone(),
        ),
        (
            "format epoch",
            stored.binding.format_epoch.to_string(),
            binding.format_epoch.to_string(),
        ),
        (
            "authority project",
            stored.binding.authority_project.clone(),
            binding.authority_project.clone(),
        ),
        (
            "authority generation",
            stored.binding.authority_generation.to_string(),
            binding.authority_generation.to_string(),
        ),
    ] {
        if expected != found {
            return Err(McStoreError::ClaimIntentBindingMismatch {
                field,
                expected,
                found,
            });
        }
    }
    Ok(())
}

fn claim_intent_mutation_result(
    outcome: ClaimIntentTxnOutcome,
    command: &ClaimCommandIdentity,
) -> Result<ClaimIntentMutationOutcome, McStoreError> {
    match outcome {
        ClaimIntentTxnOutcome::Applied(outcome) => Ok(outcome),
        ClaimIntentTxnOutcome::IdentityConflict => Err(McStoreError::ClaimIntentIdentityConflict {
            producer: command.producer.clone(),
            operation_key: command.operation_key.clone(),
        }),
        ClaimIntentTxnOutcome::BindingMismatch {
            field,
            expected,
            found,
        } => Err(McStoreError::ClaimIntentBindingMismatch {
            field,
            expected,
            found,
        }),
        ClaimIntentTxnOutcome::Frozen(state) => {
            Err(McStoreError::ClaimIntentAuthorityFrozen { state })
        }
        ClaimIntentTxnOutcome::RouteNotManaged => Err(McStoreError::ClaimIntentRouteNotManaged),
        ClaimIntentTxnOutcome::NotFound => Err(McStoreError::ClaimIntentNotFound {
            producer: command.producer.clone(),
            operation_key: command.operation_key.clone(),
        }),
        ClaimIntentTxnOutcome::Transition { expected, found } => {
            Err(McStoreError::ClaimIntentTransition { expected, found })
        }
        ClaimIntentTxnOutcome::ResetBlocked(_) | ClaimIntentTxnOutcome::ResetGranted => {
            unreachable!("claim mutation transaction cannot return a rebuild outcome")
        }
    }
}

fn validate_claim_result_json(
    result_json: &str,
    kind: ClaimIntentAckKind,
) -> Result<(), McStoreError> {
    let result = decode_claim_operation_result(result_json)
        .map_err(|error| McStoreError::ClaimIntentInvalid(error.to_string()))?;
    let value: Value = serde_json::from_str(result_json)
        .map_err(|error| McStoreError::ClaimIntentInvalid(error.to_string()))?;
    let canonical = canonical_json_encode(&value)
        .map_err(|error| McStoreError::ClaimIntentInvalid(error.to_string()))?;
    if canonical.as_bytes() != result_json.as_bytes() {
        return Err(McStoreError::ClaimIntentInvalid(
            "result_json is not canonical".to_string(),
        ));
    }
    match kind {
        ClaimIntentAckKind::ContextCommitted
            if !matches!(
                result.outcome,
                ClaimResultOutcome::Applied | ClaimResultOutcome::Noop
            ) =>
        {
            Err(McStoreError::ClaimIntentInvalid(
                "context-committed result must be applied or noop".to_string(),
            ))
        }
        ClaimIntentAckKind::TerminalRejected
            if result.outcome != ClaimResultOutcome::Stale
                || !result.effects.is_empty()
                || !result.generations.is_empty() =>
        {
            Err(McStoreError::ClaimIntentInvalid(
                "terminal-rejected result must be stale with zero effects".to_string(),
            ))
        }
        _ => Ok(()),
    }
}

#[derive(Debug)]
enum AuthorityTransitionError {
    State { expected: String, found: String },
    Generation { expected: u64, found: u64 },
    CoordinatorToken,
    CoordinatorLeaseExpired,
}

impl std::fmt::Display for AuthorityTransitionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::State { expected, found } => {
                write!(f, "expected state {expected}, found {found}")
            }
            Self::Generation { expected, found } => {
                write!(f, "expected generation {expected}, found {found}")
            }
            Self::CoordinatorToken => {
                write!(f, "drain coordinator token mismatch or missing")
            }
            Self::CoordinatorLeaseExpired => {
                write!(f, "drain coordinator lease expired")
            }
        }
    }
}

fn mint_coordinator_token(lease: &str, lease_expires_at: i64, generation: u64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!(
        "{:x}",
        Sha256::digest(
            format!("drain-token:{lease}:{lease_expires_at}:{generation}:{nanos}").as_bytes()
        )
    )
}

impl std::error::Error for AuthorityTransitionError {}

fn map_authority_sql_error(error: StoreError) -> McStoreError {
    // cortexkit-store erases driver-specific errors at its connection boundary.
    // Do not report a successful transition when a generation or state check fails.
    McStoreError::Store(error)
}

fn validate_authority_domain(domain: &str) -> Result<(), McStoreError> {
    if matches!(domain, "memories" | "notes") {
        Ok(())
    } else {
        Err(McStoreError::Serde(format!(
            "unknown authority domain {domain}"
        )))
    }
}

/// transaction.
///
/// Callers must not key `mc_authority` by caller-supplied identity fields.
/// The bound route is the only trustworthy authority identity on a facade request.
///
///
/// A caller can distinguish an unmanaged route from a non-`MODULE` route.
///
fn claim_intent_stage_fence(
    tx: &rusqlite::Transaction<'_>,
    route_project_root: &str,
    binding: &ClaimIntentBinding,
) -> rusqlite::Result<Option<ClaimIntentTxnOutcome>> {
    let transition: Option<String> = tx
        .query_row(
            "SELECT transition_state FROM mc_claim_intent_controls WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(state) = transition.filter(|state| state != "accepting") {
        return Ok(Some(ClaimIntentTxnOutcome::Frozen(state)));
    }
    // The lookup resolves the authority from the bound route, never from the caller-supplied binding.
    let Some((authority_project, state, generation)) =
        authority_for_route_tx(tx, route_project_root, "memories")?
    else {
        return Ok(Some(ClaimIntentTxnOutcome::RouteNotManaged));
    };
    if state != "MODULE" {
        return Ok(Some(ClaimIntentTxnOutcome::Frozen(state)));
    }
    if authority_project != binding.authority_project {
        return Ok(Some(ClaimIntentTxnOutcome::BindingMismatch {
            field: "authority project",
            expected: authority_project,
            found: binding.authority_project.clone(),
        }));
    }
    if generation != binding.authority_generation {
        return Ok(Some(ClaimIntentTxnOutcome::BindingMismatch {
            field: "authority generation",
            expected: generation.to_string(),
            found: binding.authority_generation.to_string(),
        }));
    }
    Ok(None)
}

fn authority_for_route_tx(
    tx: &rusqlite::Transaction<'_>,
    route_project_root: &str,
    domain: &str,
) -> rusqlite::Result<Option<(String, String, u64)>> {
    tx.query_row(
        "SELECT authority.project, authority.state, authority.generation
           FROM mc_authority_route_bindings binding
           JOIN mc_authority authority
             ON authority.context_store_uuid = binding.context_store_uuid
            AND authority.project = binding.project
          WHERE binding.route_project_root = ?1
            AND authority.domain = ?2",
        params![route_project_root, domain],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get::<_, i64>(2)?.max(0) as u64,
            ))
        },
    )
    .optional()
}

fn set_claim_intent_transition_tx(
    tx: &rusqlite::Transaction<'_>,
    database_incarnation_id: &str,
    authority_generation: u64,
    transition_state: &str,
) -> rusqlite::Result<()> {
    if !is_lower_hex(database_incarnation_id, 32) {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO mc_claim_intent_controls(
            id, database_incarnation_id, authority_generation,
            transition_state, updated_at_ms
         ) VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            database_incarnation_id = excluded.database_incarnation_id,
            authority_generation = excluded.authority_generation,
            transition_state = excluded.transition_state,
            updated_at_ms = excluded.updated_at_ms",
        params![
            database_incarnation_id,
            authority_generation as i64,
            transition_state,
            current_time_ms(),
        ],
    )?;
    Ok(())
}

fn authority_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuthorityRow> {
    Ok(AuthorityRow {
        context_store_uuid: row.get(0)?,
        project: row.get(1)?,
        domain: row.get(2)?,
        state: row.get(3)?,
        generation: row.get::<_, i64>(4)? as u64,
        captured_upper_bound: row.get(5)?,
        drain_generation: row.get::<_, Option<i64>>(6)?.map(|value| value as u64),
        drain_cursor: row.get(7)?,
        step_seed: row.get::<_, i64>(8)? != 0,
        step_memories: row.get::<_, i64>(9)? != 0,
        step_notes: row.get::<_, i64>(10)? != 0,
        step_compartments: row.get::<_, i64>(11)? != 0,
        step_reconcile: row.get::<_, i64>(12)? != 0,
        step_verify: row.get::<_, i64>(13)? != 0,
        step_flip: row.get::<_, i64>(14)? != 0,
        coordinator_lease: row.get(15)?,
        lease_expires_at: row.get(16)?,
        coordinator_token: row.get(17)?,
        checksum_expected: row.get(18)?,
        checksum_actual: row.get(19)?,
        checksum_ok: row.get::<_, Option<i64>>(20)?.map(|value| value != 0),
    })
}

fn authority_require_live_coordinator(
    current: &AuthorityRow,
    expected_token: &str,
    now_ms: i64,
) -> Result<(), rusqlite::Error> {
    if current.coordinator_token.as_deref() != Some(expected_token) || expected_token.is_empty() {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            AuthorityTransitionError::CoordinatorToken,
        )));
    }
    if current.lease_expires_at.unwrap_or(0) <= now_ms {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            AuthorityTransitionError::CoordinatorLeaseExpired,
        )));
    }
    Ok(())
}

fn split_flat_block_id(id: &str) -> Option<(&str, u64)> {
    let (mid, index) = id.rsplit_once('#')?;
    if mid.is_empty() || mid.contains('#') {
        return None;
    }
    Some((mid, index.parse().ok()?))
}

pub fn validate_state_import_compartments(
    compartments: &[StoredCompartment],
) -> Result<(), StateImportValidationError> {
    let mut previous: Option<&StoredCompartment> = None;
    for compartment in compartments {
        if compartment.start_message > compartment.end_message {
            return Err(StateImportValidationError::RangeInvalid {
                sequence: compartment.sequence,
            });
        }
        if compartment
            .p1
            .as_deref()
            .is_none_or(|p1| p1.trim().is_empty())
        {
            return Err(StateImportValidationError::P1Empty {
                sequence: compartment.sequence,
            });
        }
        if split_flat_block_id(&compartment.end_message_id).is_none() {
            return Err(StateImportValidationError::EndMessageIdInvalid {
                sequence: compartment.sequence,
            });
        }
        if let Some(previous) = previous {
            if compartment.sequence <= previous.sequence {
                return Err(StateImportValidationError::SeqNotIncreasing {
                    previous: previous.sequence,
                    current: compartment.sequence,
                });
            }
            if compartment.start_message <= previous.end_message {
                return Err(StateImportValidationError::RangesOverlap {
                    previous: previous.sequence,
                    current: compartment.sequence,
                });
            }
        }
        previous = Some(compartment);
    }
    Ok(())
}

fn session_has_durable_state(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<bool> {
    let exists: i64 = conn
        .prepare_cached(
            "SELECT EXISTS(
             SELECT 1 FROM mc_cache_state WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_compartments WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_tags WHERE session_id = ?1
             UNION ALL SELECT 1 FROM pending_agent_drops WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_reduce_command_ledger WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_channel1_appends WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_user_hints WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_temporal_marks WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_overlay_frontiers WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_wrapup_commands WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_recomp_commands WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_pass_trace WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_chunk_transcripts WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_compartment_events WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_primer_candidates WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_user_memory_candidates WHERE session_id = ?1
             UNION ALL SELECT 1 FROM mc_notes WHERE session_id = ?1
         )",
        )?
        .query_row(params![session_id], |row| row.get(0))?;
    Ok(exists != 0)
}

fn validated_seed_boundary(
    declared: &str,
    compartments: &[StoredCompartment],
) -> Result<ValidatedSeedBoundary, String> {
    let (declared_mid, declared_index) = split_flat_block_id(declared)
        .ok_or_else(|| "declared identity must be a parseable <mid>#<index> flat id".to_string())?;
    let mut ordered = compartments.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|compartment| compartment.sequence);
    let tail = ordered
        .last()
        .copied()
        .ok_or_else(|| "a boundary cannot be adopted without seeded compartments".to_string())?;

    if ordered.iter().any(|compartment| {
        compartment.start_message < 0 || compartment.end_message < compartment.start_message
    }) {
        return Err(
            "seeded compartment ordinal ranges must be non-negative and ordered".to_string(),
        );
    }
    for pair in ordered.windows(2) {
        if pair[0].sequence == pair[1].sequence {
            return Err("seeded compartment sequences must be unique".to_string());
        }
        if pair[1].start_message <= pair[0].end_message {
            return Err(format!(
                "seeded compartment ranges overlap at ordinals {} and {}",
                pair[0].end_message, pair[1].start_message
            ));
        }
    }

    let (tail_mid, tail_index) = split_flat_block_id(&tail.end_message_id).ok_or_else(|| {
        "the highest-sequence compartment must carry a parseable flat end_message_id".to_string()
    })?;
    if declared_mid != tail_mid {
        return Err(format!(
            "declared message {declared_mid:?} did not match tail compartment message {tail_mid:?}"
        ));
    }
    if declared_index != tail_index {
        return Err(format!(
            "declared block index {declared_index} did not match tail compartment end-block index {tail_index}"
        ));
    }

    Ok(ValidatedSeedBoundary {
        boundary_id: tail.end_message_id.clone(),
        coverage_start_ordinal: ordered[0].start_message as u64,
        coverage_end_ordinal: tail.end_message as u64,
        max_sequence: tail.sequence,
    })
}

enum ModuleStateSyncTxnOutcome {
    Committed(ModuleStateSyncResult),
    GenerationMismatch { found: u64 },
    AuthoritySeqMismatch { found: u64 },
    HistorianBusy { phase: HistorianPhase },
    InvalidSeedBoundary { declared: String, detail: String },
    Serde(String),
}

#[cfg(any(test, feature = "test-support"))]
type AbandonHistorianHook = std::sync::Arc<std::sync::Mutex<Option<Box<dyn FnMut() + Send>>>>;
#[cfg(any(test, feature = "test-support"))]
type BeforeMaxCompartmentEndReadHook =
    std::sync::Arc<std::sync::Mutex<Option<Box<dyn FnMut(&McStore) + Send>>>>;

/// module's lifetime.
struct FacadeAuthorityScope {
    owner: std::thread::ThreadId,
    route_project_root: String,
    domain: String,
}

struct FacadeMutationScopeGuard<'a> {
    scope: &'a Mutex<Option<FacadeAuthorityScope>>,
}

impl Drop for FacadeMutationScopeGuard<'_> {
    fn drop(&mut self) {
        *self
            .scope
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

struct FacadeNoteScopeGuard<'a> {
    scope: &'a Mutex<Option<String>>,
    previous: Option<String>,
}

impl Drop for FacadeNoteScopeGuard<'_> {
    fn drop(&mut self) {
        *self
            .scope
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = self.previous.take();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FacadeMutationOutcome {
    Applied(Vec<u8>),
    Duplicate(Vec<u8>),
}

pub struct FacadeMutationTxn<'a> {
    tx: &'a rusqlite::Transaction<'a>,
}

impl<'a> FacadeMutationTxn<'a> {
    pub fn insert_note(&self, input: NoteInput<'_>) -> Result<StoredNote, String> {
        let content = input.content.trim();
        if content.is_empty() {
            return Err("note content must not be empty".to_string());
        }
        self.tx
            .execute(
                "INSERT INTO mc_notes
                 (type, project_path, session_id, content, status, surface_condition,
                  anchor_block_id, harness, created_at_ms, updated_at_ms)
                 VALUES ('session', ?1, ?2, ?3, 'active', ?4, ?5, 'module', ?6, ?6)",
                params![
                    input.project_path,
                    input.session_id,
                    content,
                    input.surface_condition,
                    input.anchor_block_id,
                    input.now_ms,
                ],
            )
            .map_err(|error| error.to_string())?;
        load_note_tx(self.tx, self.tx.last_insert_rowid()).map_err(|error| error.to_string())
    }

    pub fn insert_project_note(&self, input: NoteWriteInput<'_>) -> Result<StoredNote, String> {
        let content = input.content.trim();
        if content.is_empty() {
            return Err("note content must not be empty".to_string());
        }
        let status = if input
            .surface_condition
            .is_some_and(|condition| !condition.trim().is_empty())
        {
            "pending"
        } else {
            "active"
        };
        self.tx
            .execute(
                "INSERT INTO mc_notes
                 (type, project_path, session_id, content, status, surface_condition,
                  anchor_block_id, anchor_ordinal, harness, compiled_provider, compiled_config,
                  compiled_at, compile_status, created_at_ms, updated_at_ms)
                 VALUES ('smart', ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'module', ?8, ?9, ?10, ?11, ?12, ?12)",
                params![
                    input.project_path,
                    input.session_id,
                    content,
                    status,
                    input
                        .surface_condition
                        .map(str::trim)
                        .filter(|value| !value.is_empty()),
                    input.anchor_block_id,
                    input.anchor_ordinal,
                    input.compiled_provider,
                    input.compiled_config,
                    input.compiled_at,
                    input.compile_status,
                    input.now_ms,
                ],
            )
            .map_err(|error| error.to_string())?;
        load_note_tx(self.tx, self.tx.last_insert_rowid()).map_err(|error| error.to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_note_cas(
        &self,
        project_path: &str,
        note_id: i64,
        expected_status: &str,
        expected_version: i64,
        content: Option<&str>,
        surface_condition: Option<Option<&str>>,
        condition_compile: Option<NoteConditionCompile<'_>>,
        now_ms: i64,
    ) -> Result<NoteCasOutcome, String> {
        let current = load_note_tx(self.tx, note_id)
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(current) = current else {
            return Ok(NoteCasOutcome::Conflict { current: None });
        };
        if current.project_path != project_path
            || current.status != expected_status
            || current.status_version != expected_version
        {
            return Ok(NoteCasOutcome::Conflict {
                current: Some(current),
            });
        }
        let next_content = content.map(str::trim).unwrap_or(&current.content);
        if next_content.is_empty() {
            return Ok(NoteCasOutcome::Conflict {
                current: Some(current),
            });
        }
        let condition_changed = surface_condition.is_some();
        let next_condition = surface_condition
            .flatten()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let content_changed = next_content != current.content;
        let compiler_edit = condition_changed || content_changed;
        let remaining_condition = if condition_changed {
            next_condition
        } else {
            current
                .surface_condition
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let next_status = if compiler_edit && remaining_condition.is_some() {
            "pending"
        } else {
            current.status.as_str()
        };
        let compile = condition_compile.unwrap_or_default();
        let changed = self
            .tx
            .execute(
                NOTE_CAS_UPDATE_SQL,
                params![
                    next_content,
                    condition_changed,
                    next_condition,
                    next_status,
                    compiler_edit,
                    now_ms,
                    compile.compiled_provider,
                    compile.compiled_config,
                    compile.compiled_at,
                    compile.compile_status,
                    note_id,
                    project_path,
                    expected_status,
                    expected_version,
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Ok(NoteCasOutcome::Conflict {
                current: load_note_tx(self.tx, note_id)
                    .optional()
                    .map_err(|error| error.to_string())?,
            });
        }
        if compiler_edit {
            fence_active_note_claims_tx(self.tx, project_path, Some(note_id), "stale", now_ms)
                .map_err(|error| error.to_string())?;
        }
        Ok(NoteCasOutcome::Applied(
            load_note_tx(self.tx, note_id).map_err(|error| error.to_string())?,
        ))
    }

    pub fn dismiss_note(
        &self,
        project_path: &str,
        session_id: &str,
        note_id: i64,
        resolution: Option<&str>,
        now_ms: i64,
    ) -> Result<Option<StoredNote>, String> {
        let Some(current) = load_note_tx(self.tx, note_id)
            .optional()
            .map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        if current.project_path != project_path
            || current.session_id != session_id
            || !matches!(
                current.status.as_str(),
                "active" | "pending" | "ready" | "surfacing" | "surfaced"
            )
        {
            return Ok(None);
        }
        let resolution = resolution.map(str::trim).filter(|value| !value.is_empty());
        let content = resolution
            .map(|value| format!("{}\n\nResolution: {value}", current.content))
            .unwrap_or_else(|| current.content.clone());
        let changed = self
            .tx
            .execute(
                "UPDATE mc_notes
                    SET status = 'dismissed', content = ?1,
                        status_version = status_version + 1, state_version = state_version + 1,
                        updated_at_ms = ?2,
                        dismissed_at = ?2, dismissal_resolution = ?3
                  WHERE id = ?4 AND project_path = ?5
                    AND status = ?6 AND status_version = ?7",
                params![
                    content,
                    now_ms,
                    resolution,
                    note_id,
                    project_path,
                    current.status,
                    current.status_version,
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Ok(None);
        }
        fence_active_note_claims_tx(self.tx, project_path, Some(note_id), "stale", now_ms)
            .map_err(|error| error.to_string())?;
        Ok(Some(
            load_note_tx(self.tx, note_id).map_err(|error| error.to_string())?,
        ))
    }
}

pub struct McStore {
    inner: SqliteStore,
    tag_cache_namespace: u64,
    note_caller_project: Arc<Mutex<Option<String>>>,
    facade_authority_scope: Arc<Mutex<Option<FacadeAuthorityScope>>>,
    facade_mutation_lock: Mutex<()>,
    #[cfg(any(test, feature = "test-support"))]
    abandon_historian_hook: AbandonHistorianHook,
    #[cfg(any(test, feature = "test-support"))]
    #[cfg(any(test, feature = "test-support"))]
    before_max_compartment_end_read_hook: BeforeMaxCompartmentEndReadHook,
    #[cfg(any(test, feature = "test-support"))]
    tag_number_query_count: std::sync::atomic::AtomicUsize,
    #[cfg(any(test, feature = "test-support"))]
    authority_seed_transaction_count: std::sync::atomic::AtomicUsize,
    #[cfg(any(test, feature = "test-support"))]
    historian_side_channel_fail_once: Mutex<BTreeSet<String>>,
}

fn valid_drop_seed_block_id(block_id: &str) -> bool {
    let Some((mid, index)) = block_id.rsplit_once('#') else {
        return false;
    };
    !mid.is_empty() && !mid.contains('#') && index.parse::<usize>().is_ok()
}

fn seeded_drop_unit(
    block_id: &str,
    drop_mode: &str,
    payload: Option<&str>,
    related: bool,
) -> Option<FrozenUnit> {
    if !valid_drop_seed_block_id(block_id) {
        return None;
    }
    let (kind, frozen_payload) = if related || drop_mode == "full" {
        ("drop", "[dropped]".to_string())
    } else if drop_mode == "truncated" || drop_mode == "skeleton" {
        ("skeleton", "[dropped]".to_string())
    } else if drop_mode == "edit_marker" {
        ("edit_marker", payload.unwrap_or("[dropped]").to_string())
    } else {
        return None;
    };
    Some(FrozenUnit {
        key: format!("red:{block_id}"),
        kind: kind.to_string(),
        frozen_payload,
        durability_class: DurabilityClass::Lineage,
        reset_rule: String::new(),
    })
}

fn materialize_drop_seed_units(
    core: &mut CoreState,
    session_id: &str,
    seeds: &[ModuleDropSeedRow],
    initial_skipped: usize,
) -> usize {
    let mut skipped = initial_skipped;
    let mut candidates = BTreeMap::<String, FrozenUnit>::new();
    for seed in seeds {
        let Some(primary) = seeded_drop_unit(
            &seed.block_id,
            &seed.drop_mode,
            seed.payload.as_deref(),
            false,
        ) else {
            skipped = skipped.saturating_add(1);
            eprintln!(
                "mc-store: skipped invalid drop seed for session {session_id}: {}",
                seed.block_id
            );
            continue;
        };
        let primary_key = primary.key.clone();
        if let Some(existing) = candidates.get(&primary_key) {
            if existing != &primary {
                let existing_order = (&existing.kind, &existing.frozen_payload);
                let primary_order = (&primary.kind, &primary.frozen_payload);
                if primary_order < existing_order {
                    candidates.insert(primary_key.clone(), primary);
                }
                eprintln!(
                    "mc-store: resolved conflicting drop seed deterministically for session {session_id}: {}",
                    primary_key
                );
            }
        } else {
            candidates.insert(primary_key, primary);
        }
        let mut related = seed.related_block_ids.clone();
        related.sort();
        related.dedup();
        for block_id in related {
            let Some(unit) = seeded_drop_unit(&block_id, "full", None, true) else {
                skipped = skipped.saturating_add(1);
                eprintln!(
                    "mc-store: skipped invalid related drop seed for session {session_id}: {block_id}"
                );
                continue;
            };
            if let Some(existing) = candidates.get(&unit.key) {
                if existing != &unit {
                    eprintln!(
                        "mc-store: ignored conflicting related drop seed for session {session_id}: {}",
                        unit.key
                    );
                }
            } else {
                candidates.insert(unit.key.clone(), unit);
            }
        }
    }

    for (key, unit) in candidates {
        if let Some(existing) = core
            .frozen_units
            .iter()
            .find(|existing| existing.key == key)
        {
            if existing != &unit {
                eprintln!(
                    "mc-store: retained existing frozen drop unit for session {session_id}: {key}"
                );
            }
            continue;
        }
        core.frozen_units.push(unit);
    }
    skipped
}

fn valid_strip_seed_kind(kind: &str) -> bool {
    matches!(
        kind,
        "placeholder" | "system_injected" | "stale_reduce" | "processed_image"
    )
}

fn materialize_strip_seed_units(
    core: &mut CoreState,
    session_id: &str,
    seeds: &[ModuleStripSeedRow],
    initial_skipped: usize,
) -> usize {
    let mut skipped = initial_skipped;
    let mut candidates = BTreeMap::<String, FrozenUnit>::new();
    for seed in seeds {
        if seed.message_id.is_empty()
            || seed.message_id.contains('#')
            || !valid_strip_seed_kind(&seed.strip_kind)
        {
            skipped = skipped.saturating_add(1);
            eprintln!(
                "mc-store: skipped invalid strip seed for session {session_id}: {}:{}",
                seed.strip_kind, seed.message_id
            );
            continue;
        }
        let key = format!("strip:{}:{}", seed.strip_kind, seed.message_id);
        candidates.entry(key.clone()).or_insert(FrozenUnit {
            key,
            kind: format!("strip_{}", seed.strip_kind),
            frozen_payload: "[dropped]".to_string(),
            durability_class: DurabilityClass::Lineage,
            reset_rule: String::new(),
        });
    }
    for (key, unit) in candidates {
        if let Some(existing) = core
            .frozen_units
            .iter()
            .find(|existing| existing.key == key)
        {
            if existing != &unit {
                eprintln!(
                    "mc-store: retained existing frozen strip unit for session {session_id}: {key}"
                );
            }
            continue;
        }
        core.frozen_units.push(unit);
    }
    skipped
}

impl McStore {
    pub fn tag_cache_namespace(&self) -> u64 {
        self.tag_cache_namespace
    }

    pub fn open(descriptor: &StorageDescriptor) -> Result<Self, McStoreError> {
        let inner = open_sqlite(descriptor)?;
        let note_caller_project = Arc::new(Mutex::new(None::<String>));
        let facade_authority_scope = Arc::new(Mutex::new(None::<FacadeAuthorityScope>));
        let note_udf_scope = Arc::clone(&note_caller_project);
        let facade_domain_scope = Arc::clone(&facade_authority_scope);
        let facade_route_scope = Arc::clone(&facade_authority_scope);
        inner.with_conn(move |conn| {
            conn.create_scalar_function(
                "mc_note_caller_project",
                0,
                FunctionFlags::SQLITE_UTF8,
                move |_context| {
                    Ok(note_udf_scope
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone()
                        .unwrap_or_default())
                },
            )?;
            conn.create_scalar_function(
                "mc_facade_authority_domain",
                0,
                FunctionFlags::SQLITE_UTF8,
                move |_context| {
                    Ok(facade_domain_scope
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .as_ref()
                        .filter(|scope| scope.owner == std::thread::current().id())
                        .map(|scope| scope.domain.clone())
                        .unwrap_or_default())
                },
            )?;
            conn.create_scalar_function(
                "mc_note_writer_v2",
                0,
                FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
                |_context| Ok(1i64),
            )?;
            conn.create_scalar_function(
                "mc_facade_authority_route",
                0,
                FunctionFlags::SQLITE_UTF8,
                move |_context| {
                    Ok(facade_route_scope
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .as_ref()
                        .filter(|scope| scope.owner == std::thread::current().id())
                        .map(|scope| scope.route_project_root.clone())
                        .unwrap_or_default())
                },
            )
        })?;
        refuse_pre_cutover_store(&inner)?;
        inner.migrate(NS, MIGRATIONS)?;
        inner.with_conn(|conn| {
            conn.set_prepared_statement_cache_capacity(128);
            Ok(())
        })?;
        let store = McStore {
            inner,
            tag_cache_namespace: NEXT_TAG_CACHE_NAMESPACE.fetch_add(1, Ordering::Relaxed),
            note_caller_project,
            facade_authority_scope,
            facade_mutation_lock: Mutex::new(()),
            #[cfg(any(test, feature = "test-support"))]
            abandon_historian_hook: std::sync::Arc::new(std::sync::Mutex::new(None)),
            #[cfg(any(test, feature = "test-support"))]
            #[cfg(any(test, feature = "test-support"))]
            before_max_compartment_end_read_hook: std::sync::Arc::new(std::sync::Mutex::new(None)),
            #[cfg(any(test, feature = "test-support"))]
            #[cfg(any(test, feature = "test-support"))]
            tag_number_query_count: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(any(test, feature = "test-support"))]
            authority_seed_transaction_count: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(any(test, feature = "test-support"))]
            #[cfg(any(test, feature = "test-support"))]
            historian_side_channel_fail_once: Mutex::new(BTreeSet::new()),
        };
        store.repair_note_artifacts_v51()?;
        store.prune_transform_session_roots()?;
        Ok(store)
    }

    fn prune_transform_session_roots(&self) -> Result<(), McStoreError> {
        const THIRTY_DAYS_MS: i64 = 30 * 24 * 60 * 60 * 1000;
        let now_ms = current_time_ms();
        self.inner
            .with_conn(|conn| {
                // The pruner removes lineage only when both the root observation and cache activity watermark predate the inactivity window.
                conn.execute(
                    "DELETE FROM mc_transform_session_roots AS roots
                      WHERE roots.observed_at < ?1
                        AND NOT EXISTS (
                            SELECT 1 FROM mc_cache_state AS cache
                             WHERE cache.session_id = roots.session_id
                               AND cache.last_activity_at >= ?1
                        )",
                    params![now_ms.saturating_sub(THIRTY_DAYS_MS)],
                )?;
                Ok(())
            })
            .map_err(Into::into)
    }

    pub fn knows_transform_session_root(
        &self,
        session_id: &str,
        project_root: &str,
    ) -> Result<bool, McStoreError> {
        let candidate = canonical_root(project_root);
        self.inner
            .with_conn(|conn| {
                let mut statement = conn.prepare_cached(
                    "SELECT project_root
                       FROM mc_transform_session_roots
                      WHERE session_id = ?1",
                )?;
                let rows =
                    statement.query_map(params![session_id], |row| row.get::<_, String>(0))?;
                for row in rows {
                    if canonical_root(row?) == candidate {
                        return Ok(true);
                    }
                }
                Ok(false)
            })
            .map_err(Into::into)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_facade_command(
        &self,
        route_project_root: &str,
        caller_project: &str,
        domain: &str,
        identity_scope: &str,
        tool: &str,
        action: &str,
        command_id: Option<&str>,
        mutation: impl FnOnce(&FacadeMutationTxn<'_>) -> Result<Vec<u8>, String>,
    ) -> Result<FacadeMutationOutcome, McStoreError> {
        let _mutation_guard = self
            .facade_mutation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_note_scope = self
            .note_caller_project
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .replace(caller_project.to_string());
        let _note_scope_guard = FacadeNoteScopeGuard {
            scope: &self.note_caller_project,
            previous: previous_note_scope,
        };
        {
            let mut scope = self
                .facade_authority_scope
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *scope = Some(FacadeAuthorityScope {
                owner: std::thread::current().id(),
                route_project_root: route_project_root.to_string(),
                domain: domain.to_string(),
            });
        }
        let _scope_guard = FacadeMutationScopeGuard {
            scope: &self.facade_authority_scope,
        };
        self.inner
            .with_conn_fenced(|tx| {
                if let Some(command_id) = command_id {
                    let stored = tx
                        .query_row(
                            "SELECT response_json
                               FROM mc_facade_mutation_ledger
                              WHERE identity_scope = ?1 AND tool = ?2
                                AND action = ?3 AND command_id = ?4",
                            params![identity_scope, tool, action, command_id],
                            |row| row.get::<_, Vec<u8>>(0),
                        )
                        .optional()?;
                    if let Some(response) = stored {
                        return Ok(FacadeMutationOutcome::Duplicate(response));
                    }
                }

                let response = mutation(&FacadeMutationTxn { tx }).map_err(|error| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                        error,
                    )))
                })?;
                if let Some(command_id) = command_id {
                    let created_at_ms = current_time_ms();
                    tx.execute(
                        "INSERT INTO mc_facade_mutation_ledger
                             (identity_scope, tool, action, command_id, response_json, created_at_ms)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            identity_scope,
                            tool,
                            action,
                            command_id,
                            response,
                            created_at_ms
                        ],
                    )?;
                    // Old outcomes are forgettable because the host session has a bounded replay horizon.
                    tx.execute(
                        "DELETE FROM mc_facade_mutation_ledger
                          WHERE identity_scope = ?1
                            AND (created_at_ms, tool, action, command_id) IN (
                                SELECT created_at_ms, tool, action, command_id
                                  FROM mc_facade_mutation_ledger
                                 WHERE identity_scope = ?1
                                 ORDER BY created_at_ms DESC, tool DESC, action DESC, command_id DESC
                                 LIMIT -1 OFFSET 512
                            )",
                        params![identity_scope],
                    )?;
                }
                Ok(FacadeMutationOutcome::Applied(response))
            })
            .map_err(Into::into)
    }

    /// Replay this idempotent repair on every store open because SQL migration cannot safely rekey several note owners under one caller identity.
    /// The repair records completion in mc_cache_state after verifying pre-v51 compiled artifacts.
    /// This repair does not advance any note revision.
    fn repair_note_artifacts_v51(&self) -> Result<(), McStoreError> {
        const FLAG_KEY: &str = "note_artifact_repair_v51_done";
        let done = self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM mc_cache_state WHERE session_id = ?1)",
                params![FLAG_KEY],
                |row| row.get::<_, i64>(0),
            )
        })? != 0;
        if done {
            return Ok(());
        }
        let projects = self.inner.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT DISTINCT project_path FROM mc_notes
                  WHERE compiled_check IS NOT NULL AND compiled_source_revision IS NULL
                  ORDER BY project_path",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        for project in projects {
            // The repair commits bounded batches so a mid-repair kill preserves completed work; each pass reselects unrepaired rows to resume later.
            loop {
                let processed = self
                    .with_note_conn_fenced(&project, |tx| repair_note_artifacts_tx(tx, &project))?;
                if processed < NOTE_ARTIFACT_REPAIR_BATCH as usize {
                    break;
                }
            }
        }
        self.inner.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO mc_cache_state (session_id, row_version, core_state, meta)
                 VALUES (?1, 0, '', '')",
                params![FLAG_KEY],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    /// Domain rows use the authority identity as their key; route paths are transport-only.
    pub fn bind_authority_route(
        &self,
        context_store_uuid: &str,
        project: &str,
        route_project_root: &str,
    ) -> Result<(), McStoreError> {
        self.with_note_conn_fenced(route_project_root, |tx| {
            tx.execute(
                "INSERT INTO mc_authority_route_bindings(route_project_root, context_store_uuid, project)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(route_project_root) DO UPDATE SET
                    context_store_uuid = excluded.context_store_uuid,
                    project = excluded.project",
                params![route_project_root, context_store_uuid, project],
            )?;
            // Cleanup runs after every upsert because binds can precede twin creation and cached authority-status checks may not retry.
            normalize_authority_note_route_tx(tx, context_store_uuid, project, route_project_root)?;
            Ok(())
        })
    }

    /// The lookup returns the MODULE authority identity and context UUID so writes can bind routes even when authority-status results are cached.
    pub fn module_authority_for_project(
        &self,
        project: &str,
        domain: &str,
    ) -> Result<Option<(String, String)>, McStoreError> {
        validate_authority_domain(domain)?;
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT context_store_uuid, project
                       FROM mc_authority
                      WHERE project = ?1 AND domain = ?2 AND state = 'MODULE'
                      ORDER BY context_store_uuid
                      LIMIT 1",
                    params![project, domain],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
            })
            .map_err(Into::into)
    }

    /// Exposing DRAINING lets callers return a retryable transition error.
    /// filesystem route.
    pub fn facade_authority_for_project(
        &self,
        project: &str,
        domain: &str,
    ) -> Result<Option<(String, String, String)>, McStoreError> {
        validate_authority_domain(domain)?;
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT context_store_uuid, project, state
                       FROM mc_authority
                      WHERE project = ?1 AND domain = ?2
                        AND state IN ('MODULE', 'DRAINING')
                      ORDER BY context_store_uuid
                      LIMIT 1",
                    params![project, domain],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
            })
            .map_err(Into::into)
    }

    /// The route lookup returns the authority identity and state for an ACTIVE or DRAINING route; mutations use the state while transforms and reads preserve continuity.
    pub fn authority_project_state_for_route(
        &self,
        route_project_root: &str,
        domain: &str,
    ) -> Result<Option<(String, String)>, McStoreError> {
        validate_authority_domain(domain)?;
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT authority.project, authority.state
                       FROM mc_authority_route_bindings binding
                       JOIN mc_authority authority
                         ON authority.context_store_uuid = binding.context_store_uuid
                        AND authority.project = binding.project
                      WHERE binding.route_project_root = ?1
                        AND authority.domain = ?2
                        AND authority.state IN ('MODULE', 'DRAINING')",
                    params![route_project_root, domain],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
            })
            .map_err(Into::into)
    }

    /// The route lookup returns the authority identity only for ACTIVE routes; PREPARING remains route-keyed until verified MODULE acknowledgement publishes the identity-key flip.
    pub fn authority_project_for_route(
        &self,
        route_project_root: &str,
        domain: &str,
    ) -> Result<Option<String>, McStoreError> {
        validate_authority_domain(domain)?;
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT authority.project
                       FROM mc_authority_route_bindings binding
                       JOIN mc_authority authority
                         ON authority.context_store_uuid = binding.context_store_uuid
                        AND authority.project = binding.project
                      WHERE binding.route_project_root = ?1
                        AND authority.domain = ?2
                        AND authority.state IN ('MODULE', 'DRAINING')",
                    params![route_project_root, domain],
                    |row| row.get(0),
                )
                .optional()
            })
            .map_err(Into::into)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn fail_next_historian_side_channel_for_test(&self, kind: &str) {
        assert!(
            HISTORIAN_SIDE_CHANNEL_KINDS.contains(&kind),
            "unknown historian side-channel kind: {kind}"
        );
        self.historian_side_channel_fail_once
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(kind.to_string());
    }

    /// The facade write path rejects writes that cross the route's active authority identity.
    pub fn enforce_facade_project_vocabulary(
        &self,
        route_project_root: &str,
        write_project: &str,
        domain: &str,
    ) -> Result<(), McStoreError> {
        let authority_project = self.authority_project_for_route(route_project_root, domain)?;
        if let Some(authority_project) = authority_project.filter(|value| value != write_project) {
            return Err(McStoreError::FacadeProjectVocabularyMismatch {
                route_project_root: route_project_root.to_string(),
                authority_project,
                write_project: write_project.to_string(),
                domain: domain.to_string(),
            });
        }
        Ok(())
    }

    /// The hook runs once immediately before the max-compartment-end query so detector tests can publish after an earlier revision read without a production scheduling seam.
    #[cfg(any(test, feature = "test-support"))]
    pub fn set_before_max_compartment_end_read_hook(&self, hook: Box<dyn FnMut(&McStore) + Send>) {
        *self
            .before_max_compartment_end_read_hook
            .lock()
            .expect("max compartment-end read hook mutex") = Some(hook);
    }

    /// The callback runs while cleanup holds SQLite's writer lock to verify that a competing write cannot occur between reading the match and storing the idle state.
    #[cfg(any(test, feature = "test-support"))]
    pub fn set_abandon_historian_hook(&self, hook: Box<dyn FnMut() + Send>) {
        *self
            .abandon_historian_hook
            .lock()
            .expect("abandon historian hook mutex") = Some(hook);
    }

    pub fn facade_mutation_ledger_response(
        &self,
        identity_scope: &str,
        tool: &str,
        action: &str,
        command_id: &str,
    ) -> Result<Option<Vec<u8>>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT response_json
                       FROM mc_facade_mutation_ledger
                      WHERE identity_scope = ?1 AND tool = ?2
                        AND action = ?3 AND command_id = ?4",
                    params![identity_scope, tool, action, command_id],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional()
            })
            .map_err(Into::into)
    }

    fn with_note_conn_fenced<T>(
        &self,
        caller_project: &str,
        operation: impl FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<T>,
    ) -> Result<T, McStoreError> {
        let caller_project = caller_project.to_string();
        let caller_scope = Arc::clone(&self.note_caller_project);
        self.inner
            .with_conn_fenced(|tx| {
                let previous = caller_scope
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .replace(caller_project);
                let result = operation(tx);
                *caller_scope
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = previous;
                result
            })
            .map_err(Into::into)
    }

    /// The applied `mc_cache` schema version is the maximum version recorded for this namespace in `cortexkit_schema_version`.
    pub fn module_store_schema_version(&self) -> Result<u32, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COALESCE(MAX(version), 0) FROM cortexkit_schema_version WHERE namespace = ?1",
                    params![NS],
                    |row| row.get::<_, u32>(0),
                )
            })
            .map_err(Into::into)
    }

    /// Facade identity shortcuts use committed module cache state as a provenance check.
    /// A client-supplied harness label cannot create a committed module cache-state row.
    pub fn has_cache_state(&self, session_id: &str) -> Result<bool, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.prepare_cached(
                    "SELECT EXISTS(SELECT 1 FROM mc_cache_state WHERE session_id = ?1)",
                )?
                .query_row(params![session_id], |row| row.get::<_, i64>(0))
            })
            .map(|exists| exists != 0)
            .map_err(Into::into)
    }

    pub fn load_project_mural_artifact(
        &self,
        project_path: &str,
    ) -> Result<Option<ProjectMuralArtifact>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT project_path, data_url, content_hash, updated_at
                       FROM mc_project_mural_artifacts
                      WHERE project_path = ?1",
                    params![project_path],
                    |row| {
                        Ok(ProjectMuralArtifact {
                            project_path: row.get(0)?,
                            data_url: row.get(1)?,
                            content_hash: row.get(2)?,
                            updated_at: row.get(3)?,
                        })
                    },
                )
                .optional()
            })
            .map_err(Into::into)
    }

    ///
    /// Updating `updated_at` when the host artifact is unchanged would turn ordinary defer traffic into a write stream, so the hash is the sole gate.
    pub fn upsert_project_mural_artifact(
        &self,
        project_path: &str,
        data_url: &[u8],
        content_hash: &str,
        updated_at: i64,
    ) -> Result<bool, McStoreError> {
        self.inner
            .with_conn_fenced(|tx| {
                let changed = tx.execute(
                    "INSERT INTO mc_project_mural_artifacts(
                         project_path, data_url, content_hash, updated_at
                     ) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(project_path) DO UPDATE SET
                         data_url = excluded.data_url,
                         content_hash = excluded.content_hash,
                         updated_at = excluded.updated_at
                     WHERE mc_project_mural_artifacts.content_hash <> excluded.content_hash",
                    params![project_path, data_url, content_hash, updated_at],
                )?;
                Ok(changed != 0)
            })
            .map_err(Into::into)
    }

    /// Project memories and smart notes survive because their ownership is project-scoped.
    /// The cleanup atomically removes session notes and cache, overlay, and producer ledger rows.
    pub fn delete_session(
        &self,
        session_id: &str,
        project_path: &str,
    ) -> Result<usize, McStoreError> {
        self.with_note_conn_fenced(project_path, |tx| {
            let tables = {
                let mut stmt = tx.prepare_cached(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                )?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let mut deleted = 0usize;
            for table in tables {
                let quoted = format!("\"{}\"", table.replace('"', "\"\""));
                let has_session_id = {
                    // The query uses `prepare` because its SQL text embeds the table name, so one-shot entries would only churn the LRU cache.
                    let mut stmt = tx.prepare(&format!("PRAGMA table_info({quoted})"))?;
                    let columns = stmt
                        .query_map([], |row| row.get::<_, String>(1))?
                        .collect::<Result<Vec<_>, _>>()?;
                    columns.into_iter().any(|column| column == "session_id")
                };
                if has_session_id {
                    deleted = deleted.saturating_add(if table == "mc_notes" {
                        tx.execute(
                            &format!(
                                "DELETE FROM {quoted} WHERE session_id = ?1 AND project_path = ?2 AND type = 'session'"
                            ),
                            params![session_id, project_path],
                        )?
                    } else {
                        tx.execute(
                            &format!("DELETE FROM {quoted} WHERE session_id = ?1"),
                            params![session_id],
                        )?
                    });
                }
            }
            Ok(deleted)
        })
    }

    /// The loader returns uninitialized defaults when no session row exists; the classifier then bootstraps.
    pub fn load(&self, session_id: &str) -> Result<LoadedState, McStoreError> {
        let row = self.inner.with_conn(|conn| {
            Ok(conn
                .prepare_cached(
                    "SELECT row_version, core_state, meta FROM mc_cache_state WHERE session_id = ?1",
                )?
                .query_row(
                    params![session_id],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)? as u64,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    },
                )
                .ok())
        })?;

        match row {
            None => Ok(LoadedState {
                core: CoreState::default(),
                meta: ModuleMeta::default(),
                row_version: None,
            }),
            Some((rv, core_json, meta_json)) => Ok(LoadedState {
                core: serde_json::from_str(&core_json)
                    .map_err(|e| McStoreError::Serde(e.to_string()))?,
                meta: serde_json::from_str(&meta_json)
                    .map_err(|e| McStoreError::Serde(e.to_string()))?,
                row_version: Some(rv),
            }),
        }
    }

    /// The loader reads cache state and non-tag render overlays in one SQLite read transaction.
    /// No-write passes linearize reads at this snapshot; tag payloads use a separately validated module baseline to avoid streaming every source blob on stable passes.
    pub fn load_transform_snapshot(
        &self,
        session_id: &str,
    ) -> Result<TransformSnapshot, McStoreError> {
        self.load_transform_snapshot_with_hook(session_id, || {})
    }

    fn load_transform_snapshot_with_hook(
        &self,
        session_id: &str,
        after_state_read: impl FnOnce(),
    ) -> Result<TransformSnapshot, McStoreError> {
        let snapshot = self.inner.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;
            let cache_state_started_at = Instant::now();
            let state = transaction
                .query_row(
                    "SELECT row_version, core_state, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![session_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)? as u64,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;
            let loaded = match state {
                Some((row_version, core_json, meta_json)) => LoadedState {
                    core: serde_json::from_str(&core_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    meta: serde_json::from_str(&meta_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            2,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    row_version: Some(row_version),
                },
                None => LoadedState {
                    core: CoreState::default(),
                    meta: ModuleMeta::default(),
                    row_version: None,
                },
            };
            let cache_state_ms = cache_state_started_at.elapsed().as_secs_f64() * 1_000.0;
            after_state_read();

            let temporal_started_at = Instant::now();
            let temporal_marks = {
                let mut statement = transaction.prepare_cached(
                    "SELECT block_id, marker_text, created_at FROM mc_temporal_marks
                      WHERE session_id = ?1 ORDER BY created_at ASC, block_id ASC",
                )?;
                let rows = statement
                    .query_map(params![session_id], |row| {
                        Ok(TemporalMarkRow {
                            block_id: row.get(0)?,
                            marker_text: row.get(1)?,
                            created_at: row.get(2)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let temporal_ms = temporal_started_at.elapsed().as_secs_f64() * 1_000.0;
            let user_hints_started_at = Instant::now();
            let user_hints = {
                let mut statement = transaction.prepare_cached(
                    "SELECT block_id, hint_text, created_at FROM mc_user_hints
                      WHERE session_id = ?1 ORDER BY created_at ASC, block_id ASC",
                )?;
                let rows = statement
                    .query_map(params![session_id], |row| {
                        Ok(UserHintRow {
                            block_id: row.get(0)?,
                            hint_text: row.get(1)?,
                            created_at: row.get(2)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let user_hints_ms = user_hints_started_at.elapsed().as_secs_f64() * 1_000.0;
            let channel1_started_at = Instant::now();
            let channel1_appends = {
                let mut statement = transaction.prepare_cached(
                    "SELECT block_id, reminder_text, fired_at_ms FROM mc_channel1_appends
                      WHERE session_id = ?1 ORDER BY fired_at_ms ASC, block_id ASC",
                )?;
                let rows = statement
                    .query_map(params![session_id], |row| {
                        Ok(Channel1AppendRow {
                            block_id: row.get(0)?,
                            reminder_text: row.get(1)?,
                            fired_at_ms: row.get(2)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let channel1_ms = channel1_started_at.elapsed().as_secs_f64() * 1_000.0;
            let overlay_frontier_started_at = Instant::now();
            let overlay_frontier = transaction
                .query_row(
                    "SELECT max_seen_ordinal FROM mc_overlay_frontiers WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .map(|ordinal| ordinal.max(0) as u64);
            let overlay_frontier_ms = overlay_frontier_started_at.elapsed().as_secs_f64() * 1_000.0;
            transaction.commit()?;
            Ok(TransformSnapshot {
                loaded,
                temporal_marks,
                user_hints,
                channel1_appends,
                overlay_frontier,
                timings: TransformSnapshotTimings {
                    cache_state_ms,
                    temporal_ms,
                    user_hints_ms,
                    channel1_ms,
                    overlay_frontier_ms,
                },
            })
        })?;
        Ok(snapshot)
    }

    /// The loader reads all durable fields used by `session.status` in one SQLite read transaction.
    pub fn load_session_status_snapshot(
        &self,
        session_id: &str,
        compartment_page: Option<(i64, usize)>,
    ) -> Result<SessionStatusSnapshot, McStoreError> {
        let snapshot = self.inner.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;
            let state = transaction
                .query_row(
                    "SELECT row_version, core_state, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![session_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)? as u64,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;
            let loaded = match state {
                Some((row_version, core_json, meta_json)) => LoadedState {
                    core: serde_json::from_str(&core_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    meta: serde_json::from_str(&meta_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            2,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    row_version: Some(row_version),
                },
                None => LoadedState {
                    core: CoreState::default(),
                    meta: ModuleMeta::default(),
                    row_version: None,
                },
            };
            let count = |table: &str| -> Result<usize, rusqlite::Error> {
                transaction.query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE session_id = ?1"),
                    params![session_id],
                    |row| row.get::<_, i64>(0),
                )
                .map(|value| value.max(0) as usize)
            };
            let compartment_page = compartment_page
                .map(|(after_sequence, limit)| {
                    let max_sequence = transaction
                        .query_row(
                            "SELECT MAX(sequence) FROM mc_compartments WHERE session_id = ?1",
                            params![session_id],
                            |row| row.get::<_, Option<i64>>(0),
                        )?
                        .map_or(after_sequence, |max| max.max(after_sequence));
                    let mut statement = transaction.prepare(
                        "SELECT sequence, start_message, end_message, start_message_id, end_message_id,
                                start_date, end_date, title, content, p1, p2, p3, p4, importance,
                                episode_type, legacy, created_at
                           FROM mc_compartments
                          WHERE session_id = ?1 AND sequence > ?2
                          ORDER BY sequence ASC LIMIT ?3",
                    )?;
                    let compartments = statement
                        .query_map(
                            params![session_id, after_sequence, i64::try_from(limit).unwrap_or(i64::MAX)],
                            Self::stored_compartment_from_row,
                        )?
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok::<CompartmentPage, rusqlite::Error>(CompartmentPage {
                        compartments,
                        max_sequence,
                    })
                })
                .transpose()?;
            let pass_trace = transaction
                .query_row(
                    "SELECT last_received_at_ms, last_completed_at_ms, last_reject_error,
                            last_reject_at_ms, reject_count, receive_count, first_divergence,
                            last_divergence, scheduler_history
                       FROM mc_pass_trace WHERE session_id = ?1",
                    params![session_id],
                    |row| {
                        Ok(PassTrace {
                            last_received_at_ms: row.get(0)?,
                            last_completed_at_ms: row.get(1)?,
                            last_reject_error: row.get(2)?,
                            last_reject_at_ms: row.get(3)?,
                            reject_count: row.get::<_, i64>(4)?.max(0) as u64,
                            receive_count: row.get::<_, i64>(5)?.max(0) as u64,
                            first_divergence: row.get(6)?,
                            last_divergence: row.get(7)?,
                            scheduler_history: serde_json::from_str(
                                &row.get::<_, String>(8)?,
                            )
                            .map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    8,
                                    rusqlite::types::Type::Text,
                                    Box::new(error),
                                )
                            })?,
                        })
                    },
                )
                .optional()?;
            let snapshot = SessionStatusSnapshot {
                loaded,
                compartment_count: count("mc_compartments")?,
                pending_drop_count: count("pending_agent_drops")?,
                tag_count: count("mc_tags")?,
                pass_trace,
                compartment_page,
            };
            transaction.commit()?;
            Ok(snapshot)
        })?;
        Ok(snapshot)
    }

    /// The acceptance recorder uses a one-statement UPSERT outside the fenced cache-state transaction so the observability write does not contend with or extend the pass commit.
    pub fn trace_pass_received(&self, session_id: &str, now_ms: i64) -> Result<(), McStoreError> {
        self.inner.with_conn(|conn| {
            conn.prepare_cached(
                "INSERT INTO mc_pass_trace (
                     session_id,
                     last_received_at_ms,
                     last_completed_at_ms,
                     last_reject_error,
                     last_reject_at_ms,
                     reject_count,
                     receive_count,
                     first_divergence
                 ) VALUES (?1, ?2, 0, NULL, NULL, 0, 1, NULL)
                 ON CONFLICT(session_id) DO UPDATE SET
                     last_received_at_ms = excluded.last_received_at_ms,
                     receive_count = mc_pass_trace.receive_count + 1,
                     first_divergence = NULL",
            )?
            .execute(params![session_id, now_ms])?;
            Ok(())
        })?;
        Ok(())
    }

    /// The transform clears current-pass divergence after a successful stable transform. Current-pass divergence remains separate from `trace_pass_received` because direct module callers skip the daemon receive hook and daemon callers must not count a pass twice.
    pub fn trace_pass_stable(
        &self,
        session_id: &str,
        observation: &PassSchedulerObservation,
        _request_observed_at_ms: Option<u64>,
        _full_array_fingerprint: Option<&str>,
    ) -> Result<(), McStoreError> {
        let observation_json = serialize_scheduler_observation(observation)?;
        let interesting_json: Option<String> = None;
        self.inner.with_conn(|conn| {
            conn.execute(
                "INSERT INTO mc_pass_trace (
                     session_id,
                     last_received_at_ms,
                     last_completed_at_ms,
                     last_reject_error,
                     last_reject_at_ms,
                     reject_count,
                     receive_count,
                     first_divergence,
                     scheduler_history,
                     scheduler_interesting_history
                 ) VALUES (
                     ?1, 0, ?2, NULL, NULL, 0, 0, NULL, json_array(json(?3)),
                     CASE WHEN ?4 IS NOT NULL THEN json_array(json(?4)) ELSE '[]' END
                 )
                 ON CONFLICT(session_id) DO UPDATE SET
                     first_divergence = NULL,
                     last_completed_at_ms = excluded.last_completed_at_ms,
                     scheduler_history = CASE
                         WHEN json_array_length(mc_pass_trace.scheduler_history) < 256 THEN
                             json_insert(mc_pass_trace.scheduler_history, '$[#]', json(?3))
                         ELSE
                             json_insert(
                                 (SELECT json_group_array(json(value))
                                    FROM json_each(mc_pass_trace.scheduler_history)
                                   WHERE key >= json_array_length(mc_pass_trace.scheduler_history) - 255),
                                 '$[#]', json(?3)
                             )
                     END,
                     scheduler_interesting_history = CASE
                         WHEN ?4 IS NULL THEN mc_pass_trace.scheduler_interesting_history
                         WHEN json_array_length(mc_pass_trace.scheduler_interesting_history) < 256 THEN
                             json_insert(
                                 mc_pass_trace.scheduler_interesting_history,
                                 '$[#]', json(?4)
                             )
                         ELSE
                             json_insert(
                                 (SELECT json_group_array(json(value))
                                    FROM json_each(mc_pass_trace.scheduler_interesting_history)
                                   WHERE key >= json_array_length(
                                       mc_pass_trace.scheduler_interesting_history
                                   ) - 255),
                                 '$[#]', json(?4)
                             )
                     END",
                params![
                    session_id,
                    observation.timestamp_ms,
                    observation_json,
                    interesting_json
                ],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    /// The completion recorder runs outside the fenced cache-state transaction so the breadcrumb cannot alter CAS semantics or extend the transaction beyond the cache write.
    pub fn trace_pass_completed(&self, session_id: &str, now_ms: i64) -> Result<(), McStoreError> {
        self.inner.with_conn(|conn| {
            conn.execute(
                "INSERT INTO mc_pass_trace (
                     session_id,
                     last_received_at_ms,
                     last_completed_at_ms,
                     last_reject_error,
                     last_reject_at_ms,
                     reject_count,
                     receive_count,
                     first_divergence
                 ) VALUES (?1, 0, ?2, NULL, NULL, 0, 0, NULL)
                 ON CONFLICT(session_id) DO UPDATE SET
                     last_completed_at_ms = excluded.last_completed_at_ms",
                params![session_id, now_ms],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    /// The store caps rejection errors to prevent unbounded diagnostic rows.
    pub fn trace_pass_rejected(
        &self,
        session_id: &str,
        error: &str,
        now_ms: i64,
    ) -> Result<(), McStoreError> {
        let error = capped_trace_error(error);
        self.inner.with_conn(|conn| {
            conn.execute(
                "INSERT INTO mc_pass_trace (
                     session_id,
                     last_received_at_ms,
                     last_completed_at_ms,
                     last_reject_error,
                     last_reject_at_ms,
                     reject_count,
                     receive_count,
                     first_divergence
                 ) VALUES (?1, 0, 0, ?2, ?3, 1, 0, NULL)
                 ON CONFLICT(session_id) DO UPDATE SET
                     last_reject_error = excluded.last_reject_error,
                     last_reject_at_ms = excluded.last_reject_at_ms,
                     reject_count = mc_pass_trace.reject_count + 1",
                params![session_id, error, now_ms],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    pub fn load_pass_trace(&self, session_id: &str) -> Result<Option<PassTrace>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT
                     last_received_at_ms,
                     last_completed_at_ms,
                     last_reject_error,
                     last_reject_at_ms,
                     reject_count,
                     receive_count,
                     first_divergence,
                     last_divergence,
                     scheduler_history
                   FROM mc_pass_trace
                 WHERE session_id = ?1",
                params![session_id],
                |r| {
                    Ok(PassTrace {
                        last_received_at_ms: r.get(0)?,
                        last_completed_at_ms: r.get(1)?,
                        last_reject_error: r.get(2)?,
                        last_reject_at_ms: r.get(3)?,
                        reject_count: r.get::<_, i64>(4)? as u64,
                        receive_count: r.get::<_, i64>(5)? as u64,
                        first_divergence: r.get(6)?,
                        last_divergence: r.get(7)?,
                        scheduler_history: serde_json::from_str(&r.get::<_, String>(8)?).map_err(
                            |error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    8,
                                    rusqlite::types::Type::Text,
                                    Box::new(error),
                                )
                            },
                        )?,
                    })
                },
            )
            .optional()
        })?)
    }

    /// The session row stores the JSON ring so appends reuse pass writes; `json_each` makes bounded records directly filterable during an incident.
    pub fn load_pass_scheduler_history(
        &self,
        session_id: &str,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Vec<PassSchedulerObservation>, McStoreError> {
        if start_ms > end_ms {
            return Ok(Vec::new());
        }
        Ok(self.inner.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT history.value
                   FROM mc_pass_trace AS trace,
                        json_each(trace.scheduler_history) AS history
                  WHERE trace.session_id = ?1
                    AND CAST(json_extract(history.value, '$.timestamp_ms') AS INTEGER)
                        BETWEEN ?2 AND ?3
                  ORDER BY CAST(history.key AS INTEGER)",
            )?;
            let rows = statement
                .query_map(params![session_id, start_ms, end_ms], |row| {
                    let raw = row.get::<_, String>(0)?;
                    serde_json::from_str(&raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?)
    }

    /// The loader reads incident-worthy scheduler observations from the independently bounded retention set.
    pub fn load_interesting_pass_scheduler_history(
        &self,
        session_id: &str,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Vec<InterestingPassSchedulerObservation>, McStoreError> {
        if start_ms > end_ms {
            return Ok(Vec::new());
        }
        Ok(self.inner.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT history.value
                   FROM mc_pass_trace AS trace,
                        json_each(trace.scheduler_interesting_history) AS history
                  WHERE trace.session_id = ?1
                    AND CAST(json_extract(history.value, '$.timestamp_ms') AS INTEGER)
                        BETWEEN ?2 AND ?3
                  ORDER BY CAST(history.key AS INTEGER)",
            )?;
            let rows = statement
                .query_map(params![session_id, start_ms, end_ms], |row| {
                    let raw = row.get::<_, String>(0)?;
                    serde_json::from_str(&raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?)
    }

    pub fn load_interesting_pass_scheduler_history_by_request_time(
        &self,
        session_id: &str,
        request_observed_at_ms: u64,
    ) -> Result<Vec<InterestingPassSchedulerObservation>, McStoreError> {
        let request_observed_at_ms = request_observed_at_ms.to_string();
        Ok(self.inner.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT history.value
                   FROM mc_pass_trace AS trace,
                        json_each(trace.scheduler_interesting_history) AS history
                  WHERE trace.session_id = ?1
                    AND CAST(json_extract(
                        history.value, '$.request_observed_at_ms'
                    ) AS TEXT) = ?2
                  ORDER BY CAST(history.key AS INTEGER)",
            )?;
            let rows = statement
                .query_map(params![session_id, request_observed_at_ms], |row| {
                    let raw = row.get::<_, String>(0)?;
                    serde_json::from_str(&raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?)
    }

    pub fn load_interesting_pass_scheduler_history_by_fingerprint(
        &self,
        session_id: &str,
        full_array_fingerprint: &str,
    ) -> Result<Vec<InterestingPassSchedulerObservation>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT history.value
                   FROM mc_pass_trace AS trace,
                        json_each(trace.scheduler_interesting_history) AS history
                  WHERE trace.session_id = ?1
                    AND json_extract(history.value, '$.full_array_fingerprint') = ?2
                  ORDER BY CAST(history.key AS INTEGER)",
            )?;
            let rows = statement
                .query_map(params![session_id, full_array_fingerprint], |row| {
                    let raw = row.get::<_, String>(0)?;
                    serde_json::from_str(&raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?)
    }

    /// The store appends block IDs requested by `ctx_reduce` to the durable per-session queue.
    /// Repeated delivery does not add duplicate pending IDs.
    pub fn append_pending_agent_drops(
        &self,
        session_id: &str,
        target_ids: &[String],
        queued_at_ms: i64,
    ) -> Result<usize, McStoreError> {
        let outcome = self.append_pending_agent_drops_with_command(
            session_id,
            None,
            target_ids,
            queued_at_ms,
            false,
        )?;
        Ok(outcome.queued as usize)
    }

    /// The store appends `ctx_reduce` drops and records the requesting command when supplied.
    /// A repeated command is acknowledged without modifying pending queue rows.
    ///
    /// When `zero_targets` is true, the store records the ledger row as `no_targets` so retries deduplicate without counting it as pending.
    /// The store sets the ledger row's disposition to `no_targets` so it is not counted as pending.
    pub fn append_pending_agent_drops_with_command(
        &self,
        session_id: &str,
        command_id: Option<&str>,
        target_ids: &[String],
        queued_at_ms: i64,
        zero_targets: bool,
    ) -> Result<AppendOutcome, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            if let Some(command_id) = command_id {
                let recorded = tx.execute(
                    "INSERT OR IGNORE INTO mc_reduce_command_ledger
                         (session_id, command_id, queued_at_ms)
                     VALUES (?1, ?2, ?3)",
                    params![session_id, command_id, queued_at_ms],
                )?;
                if recorded == 0 {
                    return Ok(AppendOutcome {
                        queued: 0,
                        duplicate: true,
                        disposition: None,
                    });
                }
            }

            let mut queued = 0u64;
            for target_id in target_ids {
                let target_id = target_id.trim();
                if target_id.is_empty() {
                    continue;
                }
                queued += tx.execute(
                    "INSERT OR IGNORE INTO pending_agent_drops
                         (session_id, target_id, queued_at, command_id)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![session_id, target_id, queued_at_ms, command_id],
                )? as u64;
            }

            // Command IDs remain until lineage teardown because pruning could make an old outcome-unknown retry destructive.

            // When the caller resolves zero targets, the store marks the ledger row terminal so retries deduplicate without creating pending work.
            if zero_targets {
                if let Some(command_id) = command_id {
                    tx.execute(
                        "UPDATE mc_reduce_command_ledger
                         SET disposition = 'no_targets'
                         WHERE session_id = ?1
                           AND command_id = ?2
                           AND disposition IS NULL",
                        params![session_id, command_id],
                    )?;
                }
            }

            Ok(AppendOutcome {
                queued,
                duplicate: false,
                disposition: if zero_targets {
                    Some("no_targets".to_string())
                } else {
                    None
                },
            })
        })?;
        Ok(outcome)
    }

    /// The loader reads queued `ctx_reduce` drops in deterministic drain order.
    pub fn load_pending_agent_drops(
        &self,
        session_id: &str,
    ) -> Result<Vec<PendingAgentDrop>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT p.id, p.target_id, p.queued_at, p.command_id,
                        l.first_applied_at_ms
                 FROM pending_agent_drops p
                 LEFT JOIN mc_reduce_command_ledger l
                   ON l.session_id = p.session_id AND l.command_id = p.command_id
                 WHERE p.session_id = ?1
                 ORDER BY p.queued_at ASC, p.id ASC",
            )?;
            let rows = stmt.query_map(params![session_id], |r| {
                Ok(PendingAgentDrop {
                    id: r.get(0)?,
                    target_id: r.get(1)?,
                    queued_at_ms: r.get(2)?,
                    command_id: r.get(3)?,
                    command_first_applied_at_ms: r.get(4)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?)
    }

    /// The store mints tag rows for newly observed block IDs and returns every requested row.
    /// Existing rows keep their original numbers; fresh rows consume the next numbers
    /// Fresh rows consume the next numbers in caller order within one transaction.
    #[cfg_attr(not(any(test, feature = "test-support")), allow(dead_code))]
    pub(crate) fn mint_or_get_tags(
        &self,
        session_id: &str,
        inputs: &[TagMintInput],
        created_at_ms: i64,
    ) -> Result<Vec<McTagRow>, McStoreError> {
        Ok(self.inner.with_conn_fenced(|tx| {
            let mut out = Vec::with_capacity(inputs.len());
            for input in inputs {
                let block_id = input.block_id.trim();
                if block_id.is_empty() {
                    continue;
                }
                if let Some(row) = tx
                    .prepare_cached(
                        "SELECT tag_number, block_id, kind, token_count, created_at_ms, source_bytes
                         FROM mc_tags
                         WHERE session_id = ?1 AND block_id = ?2",
                    )?
                    .query_row(params![session_id, block_id], tag_row_from_sql)
                    .optional()?
                {
                    out.push(row);
                    continue;
                }
                let next = tx
                    .prepare_cached(
                        "SELECT COALESCE(MAX(tag_number), 0) + 1 FROM mc_tags WHERE session_id = ?1",
                    )?
                    .query_row(params![session_id], |r| r.get::<_, i64>(0))?;
                tx.prepare_cached(
                    "INSERT INTO mc_tags
                         (session_id, tag_number, block_id, kind, token_count, created_at_ms, source_bytes)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )?
                .execute(
                    params![
                        session_id,
                        next,
                        block_id,
                        input.kind.as_str(),
                        input.token_count.max(0),
                        created_at_ms,
                        input.source_bytes.as_slice(),
                    ],
                )?;
                out.push(McTagRow {
                    tag_number: next,
                    block_id: block_id.to_string(),
                    kind: input.kind.clone(),
                    token_count: input.token_count.max(0),
                    created_at_ms,
                    source_bytes: input.source_bytes.clone(),
                });
            }
            Ok(out)
        })?)
    }

    pub fn load_tags_for_session(&self, session_id: &str) -> Result<Vec<McTagRow>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT tag_number, block_id, kind, token_count, created_at_ms, source_bytes
                 FROM mc_tags
                 WHERE session_id = ?1
                 ORDER BY tag_number ASC",
            )?;
            let rows = stmt.query_map(params![session_id], tag_row_from_sql)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?)
    }

    pub fn load_tags_after(
        &self,
        session_id: &str,
        after_tag_number: i64,
    ) -> Result<Vec<McTagRow>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT tag_number, block_id, kind, token_count, created_at_ms, source_bytes
                 FROM mc_tags
                 WHERE session_id = ?1 AND tag_number > ?2
                 ORDER BY tag_number ASC",
            )?;
            let rows = stmt.query_map(params![session_id, after_tag_number], tag_row_from_sql)?;
            rows.collect::<Result<Vec<_>, _>>()
        })?)
    }

    /// The method returns the trigger-maintained tag identity for cache validation without reading blobs.
    ///
    /// Triggers maintain the cached count and maximum; replacements and deletions recompute the maximum from the primary-key prefix.
    /// Steady transforms read the cached row instead of tag payloads.
    pub fn tag_cache_summary(&self, session_id: &str) -> Result<TagCacheSummary, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            conn.prepare_cached(
                "SELECT generation, tag_count, max_tag_number
                   FROM mc_tag_cache_generations
                  WHERE session_id = ?1",
            )?
            .query_row(params![session_id], |row| {
                Ok(TagCacheSummary {
                    generation: row.get::<_, i64>(0)?.max(0) as u64,
                    count: row.get::<_, i64>(1)?.max(0) as usize,
                    max_tag_number: row.get(2)?,
                })
            })
            .optional()
            .map(|summary| summary.unwrap_or_default())
        })?)
    }

    /// The query loads only the fields used to decide whether native reasoning is old enough to clear.
    pub fn load_tag_numbers_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<TagNumberRow>, McStoreError> {
        #[cfg(any(test, feature = "test-support"))]
        self.tag_number_query_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT block_id, tag_number FROM mc_tags
                 WHERE session_id = ?1 ORDER BY tag_number ASC",
            )?;
            let rows = stmt.query_map(params![session_id], |row| {
                Ok(TagNumberRow {
                    block_id: row.get(0)?,
                    tag_number: row.get(1)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })?)
    }

    pub fn load_tag_numbers_after(
        &self,
        session_id: &str,
        after_tag_number: i64,
    ) -> Result<Vec<TagNumberRow>, McStoreError> {
        #[cfg(any(test, feature = "test-support"))]
        self.tag_number_query_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT block_id, tag_number FROM mc_tags
                 WHERE session_id = ?1 AND tag_number > ?2
                 ORDER BY tag_number ASC",
            )?;
            let rows = stmt.query_map(params![session_id, after_tag_number], |row| {
                Ok(TagNumberRow {
                    block_id: row.get(0)?,
                    tag_number: row.get(1)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })?)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn tag_number_query_count_for_test(&self) -> usize {
        self.tag_number_query_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Test-only raw SQL seam verifies trigger-backed cache invalidation after out-of-band writes.
    /// Production tag changes use the fenced transform transaction.
    #[cfg(any(test, feature = "test-support"))]
    pub fn execute_tag_sql_for_test(&self, sql: &str) -> Result<(), McStoreError> {
        self.inner.with_conn(|conn| {
            conn.execute_batch(sql)?;
            Ok(())
        })?;
        Ok(())
    }

    pub fn sum_tag_token_counts_for_blocks(
        &self,
        session_id: &str,
        block_ids: &HashSet<String>,
    ) -> Result<i64, McStoreError> {
        if block_ids.is_empty() {
            return Ok(0);
        }
        let rows = self.load_tags_for_session(session_id)?;
        Ok(rows
            .into_iter()
            .filter(|row| block_ids.contains(&row.block_id))
            .map(|row| row.token_count.max(0))
            .sum())
    }

    /// The store inserts one Channel-1 append row only if the block has not already received one.
    #[cfg_attr(not(any(test, feature = "test-support")), allow(dead_code))]
    pub(crate) fn append_channel1_nudge(
        &self,
        session_id: &str,
        block_id: &str,
        reminder_text: &str,
        fired_at_ms: i64,
    ) -> Result<bool, McStoreError> {
        Ok(self.inner.with_conn_fenced(|tx| {
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO mc_channel1_appends
                     (session_id, block_id, reminder_text, fired_at_ms)
                 VALUES (?1, ?2, ?3, ?4)",
                params![session_id, block_id, reminder_text, fired_at_ms],
            )?;
            Ok(inserted > 0)
        })?)
    }

    /// The loader returns stored Channel-1 append bytes in deterministic order.
    pub fn load_channel1_appends(
        &self,
        session_id: &str,
    ) -> Result<Vec<Channel1AppendRow>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT block_id, reminder_text, fired_at_ms
                 FROM mc_channel1_appends
                 WHERE session_id = ?1
                 ORDER BY fired_at_ms ASC, block_id ASC",
            )?;
            let rows = stmt.query_map(params![session_id], |r| {
                Ok(Channel1AppendRow {
                    block_id: r.get(0)?,
                    reminder_text: r.get(1)?,
                    fired_at_ms: r.get(2)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?)
    }

    /// The query reads the ordinal frontier that prevents first-applying overlays to closed turns.
    /// A missing row is distinct from ordinal zero, which is a valid first message.
    pub fn overlay_watermark(&self, session_id: &str) -> Result<Option<u64>, McStoreError> {
        let value = self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT max_seen_ordinal FROM mc_overlay_frontiers WHERE session_id = ?1",
                params![session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
        })?;
        Ok(value.map(|ordinal| ordinal.max(0) as u64))
    }

    /// The store freezes first-sight overlay decisions and advances the pass watermark atomically.
    /// Every candidate is compared with the watermark from before this transaction.
    /// A racing hint writer returns the already-stored bytes so both callers render the same canonical decision.
    #[cfg(test)]
    pub(crate) fn apply_active_overlay_decisions(
        &self,
        session_id: &str,
        max_seen_ordinal: u64,
        temporal_marks: &[TemporalMarkInput],
        user_hint: Option<&UserHintDecisionInput>,
        created_at: i64,
    ) -> Result<Option<UserHintRow>, McStoreError> {
        let max_seen_ordinal = i64::try_from(max_seen_ordinal)
            .map_err(|_| McStoreError::Serde("message ordinal exceeds SQLite range".to_string()))?;
        let temporal_marks = temporal_marks
            .iter()
            .map(|mark| {
                i64::try_from(mark.ordinal)
                    .map(|ordinal| (ordinal, mark))
                    .map_err(|_| {
                        McStoreError::Serde("message ordinal exceeds SQLite range".to_string())
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let hint_ordinal = user_hint
            .map(|hint| {
                i64::try_from(hint.ordinal).map_err(|_| {
                    McStoreError::Serde("message ordinal exceeds SQLite range".to_string())
                })
            })
            .transpose()?;

        Ok(self.inner.with_conn_fenced(|tx| {
            let previous = tx
                .query_row(
                    "SELECT max_seen_ordinal
                     FROM mc_overlay_frontiers
                     WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;

            for (ordinal, mark) in &temporal_marks {
                if previous.is_none_or(|frontier| *ordinal > frontier) {
                    tx.execute(
                        "INSERT OR IGNORE INTO mc_temporal_marks
                             (session_id, block_id, marker_text, created_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![session_id, mark.block_id, mark.marker_text, created_at],
                    )?;
                }
            }

            let canonical_hint = if let Some(hint) = user_hint {
                let existing = tx
                    .query_row(
                        "SELECT block_id, hint_text, created_at
                         FROM mc_user_hints
                         WHERE session_id = ?1 AND block_id = ?2",
                        params![session_id, hint.block_id],
                        |row| {
                            Ok(UserHintRow {
                                block_id: row.get(0)?,
                                hint_text: row.get(1)?,
                                created_at: row.get(2)?,
                            })
                        },
                    )
                    .optional()?;
                if existing.is_some()
                    || hint_ordinal
                        .is_some_and(|ordinal| previous.is_some_and(|frontier| ordinal <= frontier))
                {
                    existing
                } else {
                    tx.execute(
                        "INSERT OR IGNORE INTO mc_user_hints
                             (session_id, block_id, hint_text, created_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![session_id, hint.block_id, hint.hint_text, created_at],
                    )?;
                    tx.query_row(
                        "SELECT block_id, hint_text, created_at
                         FROM mc_user_hints
                         WHERE session_id = ?1 AND block_id = ?2",
                        params![session_id, hint.block_id],
                        |row| {
                            Ok(UserHintRow {
                                block_id: row.get(0)?,
                                hint_text: row.get(1)?,
                                created_at: row.get(2)?,
                            })
                        },
                    )
                    .optional()?
                }
            } else {
                None
            };

            tx.execute(
                "INSERT INTO mc_overlay_frontiers (session_id, max_seen_ordinal)
                 VALUES (?1, ?2)
                 ON CONFLICT(session_id) DO UPDATE SET
                     max_seen_ordinal = MAX(max_seen_ordinal, excluded.max_seen_ordinal)",
                params![session_id, max_seen_ordinal],
            )?;
            Ok(canonical_hint)
        })?)
    }

    /// The store persists one auto-search decision, including an empty no-result decision.
    #[cfg(test)]
    pub(crate) fn append_user_hint(
        &self,
        session_id: &str,
        block_id: &str,
        hint_text: &str,
        created_at: i64,
    ) -> Result<bool, McStoreError> {
        Ok(self.inner.with_conn_fenced(|tx| {
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO mc_user_hints
                     (session_id, block_id, hint_text, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![session_id, block_id, hint_text, created_at],
            )?;
            Ok(inserted > 0)
        })?)
    }

    #[cfg(feature = "test-support")]
    pub fn seed_tags_for_test(
        &self,
        session_id: &str,
        inputs: &[TagMintInput],
        created_at_ms: i64,
    ) -> Result<Vec<McTagRow>, McStoreError> {
        self.mint_or_get_tags(session_id, inputs, created_at_ms)
    }

    #[cfg(feature = "test-support")]
    pub fn seed_channel1_append_for_test(
        &self,
        session_id: &str,
        block_id: &str,
        reminder_text: &str,
        fired_at_ms: i64,
    ) -> Result<bool, McStoreError> {
        self.append_channel1_nudge(session_id, block_id, reminder_text, fired_at_ms)
    }

    /// The loader returns exact auto-search overlay bytes and durable empty decisions.
    pub fn load_user_hints(&self, session_id: &str) -> Result<Vec<UserHintRow>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT block_id, hint_text, created_at
                 FROM mc_user_hints
                 WHERE session_id = ?1
                 ORDER BY created_at ASC, block_id ASC",
            )?;
            let rows = stmt.query_map(params![session_id], |row| {
                Ok(UserHintRow {
                    block_id: row.get(0)?,
                    hint_text: row.get(1)?,
                    created_at: row.get(2)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?)
    }

    /// The loader returns persisted marker bytes, including empty no-marker decisions.
    pub fn load_temporal_marks(
        &self,
        session_id: &str,
    ) -> Result<Vec<TemporalMarkRow>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT block_id, marker_text, created_at
                 FROM mc_temporal_marks
                 WHERE session_id = ?1
                 ORDER BY created_at ASC, block_id ASC",
            )?;
            let rows = stmt.query_map(params![session_id], |row| {
                Ok(TemporalMarkRow {
                    block_id: row.get(0)?,
                    marker_text: row.get(1)?,
                    created_at: row.get(2)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?)
    }

    /// `set_todo_state` treats matching owner_message_id and state_hash as a replay no-op.
    pub fn set_todo_state(
        &self,
        session_id: &str,
        state_json: &str,
        owner_message_id: &str,
        state_hash: &str,
    ) -> Result<TodoStateSetOutcome, McStoreError> {
        let mut last_conflict = None;
        for _ in 0..8 {
            let loaded = self.load(session_id)?;
            if loaded.meta.last_todo_state_owner_message_id.as_deref() == Some(owner_message_id)
                && loaded.meta.last_todo_state_hash.as_deref() == Some(state_hash)
            {
                return Ok(TodoStateSetOutcome::Noop);
            }
            let mut meta = loaded.meta;
            meta.last_todo_state = Some(state_json.to_string());
            meta.last_todo_state_owner_message_id = Some(owner_message_id.to_string());
            meta.last_todo_state_hash = Some(state_hash.to_string());
            match self.commit(session_id, loaded.row_version, &loaded.core, &meta) {
                Ok(row_version) => {
                    return Ok(TodoStateSetOutcome::Updated { row_version });
                }
                Err(error @ McStoreError::CasConflict { .. }) => last_conflict = Some(error),
                Err(error) => return Err(error),
            }
        }
        Err(last_conflict.unwrap_or_else(|| {
            McStoreError::Serde("todo state update exceeded CAS retry limit".to_string())
        }))
    }

    /// `arm_soft_refresh` persists a one-shot refresh for the next eligible transform pass.
    pub fn arm_soft_refresh(&self, session_id: &str) -> Result<bool, McStoreError> {
        let mut last_conflict = None;
        for _ in 0..8 {
            let loaded = self.load(session_id)?;
            if loaded.meta.soft_refresh_pending {
                return Ok(true);
            }
            let mut meta = loaded.meta;
            meta.soft_refresh_pending = true;
            match self.commit(session_id, loaded.row_version, &loaded.core, &meta) {
                Ok(_) => return Ok(true),
                Err(error @ McStoreError::CasConflict { .. }) => last_conflict = Some(error),
                Err(error) => return Err(error),
            }
        }
        Err(last_conflict.unwrap_or_else(|| {
            McStoreError::Serde("soft refresh arm exceeded CAS retry limit".to_string())
        }))
    }

    pub fn load_recomp_command(
        &self,
        session_id: &str,
        command_id: &str,
    ) -> Result<Option<RecompCommandRow>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT disposition, created_at FROM mc_recomp_commands
                 WHERE session_id = ?1 AND command_id = ?2",
                params![session_id, command_id],
                |row| {
                    Ok(RecompCommandRow {
                        disposition: row.get(0)?,
                        created_at: row.get(1)?,
                    })
                },
            )
            .optional()
        })?)
    }

    pub fn record_recomp_command(
        &self,
        session_id: &str,
        command_id: &str,
        disposition: &str,
        created_at: i64,
    ) -> Result<RecompCommandRow, McStoreError> {
        if !matches!(
            disposition,
            "started" | "already_in_progress" | "nothing_to_do"
        ) {
            return Err(McStoreError::Serde(format!(
                "invalid recomp disposition {disposition:?}"
            )));
        }
        Ok(self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO mc_recomp_commands
                 (session_id, command_id, disposition, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![session_id, command_id, disposition, created_at],
            )?;
            tx.query_row(
                "SELECT disposition, created_at FROM mc_recomp_commands
                 WHERE session_id = ?1 AND command_id = ?2",
                params![session_id, command_id],
                |row| {
                    Ok(RecompCommandRow {
                        disposition: row.get(0)?,
                        created_at: row.get(1)?,
                    })
                },
            )
        })?)
    }

    pub fn load_wrapup_command(
        &self,
        session_id: &str,
        command_id: &str,
    ) -> Result<Option<WrapupCommandRow>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT disposition, rounds, summary, created_at
                 FROM mc_wrapup_commands
                 WHERE session_id = ?1 AND command_id = ?2",
                params![session_id, command_id],
                |row| {
                    let rounds = row.get::<_, i64>(1)?;
                    Ok(WrapupCommandRow {
                        disposition: row.get(0)?,
                        rounds: rounds.max(0) as usize,
                        summary: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                },
            )
            .optional()
        })?)
    }

    /// The transaction records a terminal wrapup outcome and returns the canonical row on a retry race.
    pub fn record_wrapup_command(
        &self,
        session_id: &str,
        command_id: &str,
        disposition: &str,
        rounds: usize,
        summary: &str,
        created_at: i64,
    ) -> Result<WrapupCommandRow, McStoreError> {
        let valid_disposition = matches!(disposition, "completed" | "nothing_to_compact");
        if !valid_disposition {
            return Err(McStoreError::Serde(format!(
                "nonterminal wrapup disposition {disposition:?} cannot be recorded"
            )));
        }
        debug_assert!(valid_disposition);
        let rounds = i64::try_from(rounds)
            .map_err(|_| McStoreError::Serde("wrapup rounds exceed SQLite range".to_string()))?;
        Ok(self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO mc_wrapup_commands
                     (session_id, command_id, disposition, rounds, summary, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    session_id,
                    command_id,
                    disposition,
                    rounds,
                    summary,
                    created_at
                ],
            )?;
            tx.query_row(
                "SELECT disposition, rounds, summary, created_at
                 FROM mc_wrapup_commands
                 WHERE session_id = ?1 AND command_id = ?2",
                params![session_id, command_id],
                |row| {
                    let rounds = row.get::<_, i64>(1)?;
                    Ok(WrapupCommandRow {
                        disposition: row.get(0)?,
                        rounds: rounds.max(0) as usize,
                        summary: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                },
            )
        })?)
    }

    /// The method returns a recorded dream-task result for command-id retry deduplication.
    pub fn load_dream_task_command(
        &self,
        session_id: &str,
        command_id: &str,
    ) -> Result<Option<DreamTaskCommandRow>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT response_json, created_at
                   FROM mc_dream_task_commands
                  WHERE session_id = ?1 AND command_id = ?2",
                params![session_id, command_id],
                |row| {
                    Ok(DreamTaskCommandRow {
                        response_json: row.get(0)?,
                        created_at: row.get(1)?,
                    })
                },
            )
            .optional()
        })?)
    }

    /// `INSERT OR IGNORE` preserves the first dream-task response across command-id retries.
    pub fn record_dream_task_command(
        &self,
        session_id: &str,
        command_id: &str,
        response_json: &str,
        created_at: i64,
    ) -> Result<DreamTaskCommandRow, McStoreError> {
        Ok(self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO mc_dream_task_commands
                     (session_id, command_id, response_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![session_id, command_id, response_json, created_at],
            )?;
            tx.query_row(
                "SELECT response_json, created_at
                   FROM mc_dream_task_commands
                  WHERE session_id = ?1 AND command_id = ?2",
                params![session_id, command_id],
                |row| {
                    Ok(DreamTaskCommandRow {
                        response_json: row.get(0)?,
                        created_at: row.get(1)?,
                    })
                },
            )
        })?)
    }

    pub fn record_wrapup_command_if_current(
        &self,
        record: WrapupCommandRecord<'_>,
    ) -> Result<RecordWrapupCommandOutcome, McStoreError> {
        let valid_disposition = matches!(
            record.disposition,
            "completed" | "nothing_to_compact" | "failed"
        );
        if !valid_disposition {
            return Err(McStoreError::Serde(format!(
                "nonterminal wrapup disposition {:?} cannot be recorded",
                record.disposition
            )));
        }
        debug_assert!(valid_disposition);
        let rounds = i64::try_from(record.rounds)
            .map_err(|_| McStoreError::Serde("wrapup rounds exceed SQLite range".to_string()))?;
        Ok(self.inner.with_conn_fenced(|transaction| {
            let current = transaction
                .query_row(
                    "SELECT row_version, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![record.session_id],
                    |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let (found_row_version, found_revert_epoch) = match current {
                Some((row_version, meta_json)) => {
                    let meta = serde_json::from_str::<ModuleMeta>(&meta_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                    (Some(row_version), meta.revert_epoch)
                }
                None => (None, 0),
            };
            if found_row_version != record.expected_row_version
                || found_revert_epoch != record.expected_revert_epoch
            {
                return Ok(RecordWrapupCommandOutcome::Stale {
                    found_row_version,
                    found_revert_epoch,
                });
            }
            let legacy_failure_created_at = transaction
                .query_row(
                    "SELECT disposition, created_at FROM mc_wrapup_commands
                     WHERE session_id = ?1 AND command_id = ?2",
                    params![record.session_id, record.command_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?
                .and_then(|(disposition, created_at)| {
                    (disposition == "failed").then_some(created_at)
                });
            if let Some(failed_created_at) = legacy_failure_created_at {
                let summary = wrapup_replaced_failure_summary(record.summary, failed_created_at);
                transaction.execute(
                    "UPDATE mc_wrapup_commands
                     SET disposition = ?3, rounds = ?4, summary = ?5, created_at = ?6
                     WHERE session_id = ?1 AND command_id = ?2 AND disposition = 'failed'",
                    params![
                        record.session_id,
                        record.command_id,
                        record.disposition,
                        rounds,
                        summary,
                        record.created_at
                    ],
                )?;
            }

            transaction.execute(
                "INSERT OR IGNORE INTO mc_wrapup_commands
                     (session_id, command_id, disposition, rounds, summary, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    record.session_id,
                    record.command_id,
                    record.disposition,
                    rounds,
                    record.summary,
                    record.created_at
                ],
            )?;
            let row = transaction.query_row(
                "SELECT disposition, rounds, summary, created_at
                 FROM mc_wrapup_commands
                 WHERE session_id = ?1 AND command_id = ?2",
                params![record.session_id, record.command_id],
                |row| {
                    let rounds = row.get::<_, i64>(1)?;
                    Ok(WrapupCommandRow {
                        disposition: row.get(0)?,
                        rounds: rounds.max(0) as usize,
                        summary: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                },
            )?;
            Ok(RecordWrapupCommandOutcome::Recorded(row))
        })?)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn seed_legacy_wrapup_command_for_test(
        &self,
        session_id: &str,
        command_id: &str,
        disposition: &str,
        rounds: usize,
        summary: &str,
        created_at: i64,
    ) -> Result<(), McStoreError> {
        let rounds = i64::try_from(rounds)
            .map_err(|_| McStoreError::Serde("wrapup rounds exceed SQLite range".to_string()))?;
        Ok(self.inner.with_conn_fenced(|transaction| {
            transaction.execute(
                "INSERT INTO mc_wrapup_commands
                     (session_id, command_id, disposition, rounds, summary, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    session_id,
                    command_id,
                    disposition,
                    rounds,
                    summary,
                    created_at
                ],
            )?;
            Ok(())
        })?)
    }

    pub fn preflight_state_import(
        &self,
        session_id: &str,
        import_id: &str,
    ) -> Result<StateImportPreflight, StateImportError> {
        let status = self.inner.with_conn(|conn| {
            let completed = conn
                .query_row(
                    "SELECT import_id, imported_count FROM mc_state_imports WHERE session_id = ?1",
                    params![session_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            let nonempty = session_has_durable_state(conn, session_id)?;
            Ok((completed, nonempty))
        })?;
        match status {
            (Some((completed_id, imported)), _) if completed_id == import_id => {
                Ok(StateImportPreflight::Duplicate {
                    imported: imported.max(0) as usize,
                })
            }
            (Some(_), _) | (None, true) => Err(StateImportError::SessionNotEmpty),
            (None, false) => Ok(StateImportPreflight::Ready),
        }
    }

    pub fn commit_state_import(
        &self,
        session_id: &str,
        import_id: &str,
        compartments: &[StoredCompartment],
        completed_at_ms: i64,
    ) -> Result<StateImportResult, StateImportError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let completed = tx
                .query_row(
                    "SELECT import_id, imported_count FROM mc_state_imports WHERE session_id = ?1",
                    params![session_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            if let Some((completed_id, imported)) = completed {
                if completed_id == import_id {
                    return Ok(StateImportTxnOutcome::Duplicate(imported.max(0) as usize));
                }
                return Ok(StateImportTxnOutcome::SessionNotEmpty);
            }

            if session_has_durable_state(tx, session_id)? {
                return Ok(StateImportTxnOutcome::SessionNotEmpty);
            }
            if let Err(error) = validate_state_import_compartments(compartments) {
                return Ok(StateImportTxnOutcome::Validation(error));
            }

            for compartment in compartments {
                insert_compartment_tx(tx, session_id, compartment.sequence, compartment)?;
            }
            tx.execute(
                "INSERT INTO mc_state_imports
                     (session_id, import_id, imported_count, completed_at_ms)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    session_id,
                    import_id,
                    compartments.len() as i64,
                    completed_at_ms
                ],
            )?;
            Ok(StateImportTxnOutcome::Imported(compartments.len()))
        })?;

        match outcome {
            StateImportTxnOutcome::Imported(imported) => Ok(StateImportResult {
                imported,
                duplicate: false,
            }),
            StateImportTxnOutcome::Duplicate(imported) => Ok(StateImportResult {
                imported,
                duplicate: true,
            }),
            StateImportTxnOutcome::SessionNotEmpty => Err(StateImportError::SessionNotEmpty),
            StateImportTxnOutcome::Validation(error) => Err(StateImportError::Validation(error)),
        }
    }

    ///
    pub fn commit(
        &self,
        session_id: &str,
        expected: Option<u64>,
        core: &CoreState,
        meta: &ModuleMeta,
    ) -> Result<u64, McStoreError> {
        self.commit_with_consumed_drops(session_id, expected, core, meta, &[])
    }

    pub fn commit_with_consumed_drops(
        &self,
        session_id: &str,
        expected: Option<u64>,
        core: &CoreState,
        meta: &ModuleMeta,
        consumed_drop_ids: &[i64],
    ) -> Result<u64, McStoreError> {
        self.commit_transform(
            session_id,
            TransformCommit {
                expected,
                core,
                meta,
                consumed_drop_ids,
                first_applied_command_ids: &[],
                claim_snapshot_vector: None,
                compartment_max_seq: None,
                project_root: None,
                first_divergence: None,
                scheduler_observation: None,
                scheduler_request_observed_at_ms: None,
                scheduler_full_array_fingerprint: None,
                scheduler_eligible_supersession_count: None,
                scheduler_withheld_by_tag_window: None,
                scheduler_withheld_by_exempt_message: None,
                scheduler_applied_supersession_count: None,
                scheduler_applied_reductions: false,
                overlays: TransformOverlayBatch::default(),
            },
        )
    }

    pub fn commit_transform(
        &self,
        session_id: &str,
        request: TransformCommit<'_>,
    ) -> Result<u64, McStoreError> {
        let TransformCommit {
            expected,
            core,
            meta,
            consumed_drop_ids,
            first_applied_command_ids,
            claim_snapshot_vector,
            compartment_max_seq,
            project_root,
            first_divergence,
            scheduler_observation,
            scheduler_request_observed_at_ms,
            scheduler_full_array_fingerprint,
            scheduler_eligible_supersession_count,
            scheduler_withheld_by_tag_window,
            scheduler_withheld_by_exempt_message,
            scheduler_applied_supersession_count,
            scheduler_applied_reductions,
            overlays,
        } = request;
        let max_seen_ordinal = overlays
            .max_seen_ordinal
            .map(|ordinal| {
                i64::try_from(ordinal).map_err(|_| {
                    McStoreError::Serde("message ordinal exceeds SQLite range".to_string())
                })
            })
            .transpose()?;
        let temporal_marks = overlays
            .temporal_marks
            .iter()
            .map(|mark| {
                i64::try_from(mark.ordinal)
                    .map(|ordinal| (ordinal, mark))
                    .map_err(|_| {
                        McStoreError::Serde("message ordinal exceeds SQLite range".to_string())
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let hint_ordinal = overlays
            .user_hint
            .map(|hint| {
                i64::try_from(hint.ordinal).map_err(|_| {
                    McStoreError::Serde("message ordinal exceeds SQLite range".to_string())
                })
            })
            .transpose()?;
        let core_json =
            serde_json::to_string(core).map_err(|e| McStoreError::Serde(e.to_string()))?;
        let meta_json =
            serde_json::to_string(meta).map_err(|e| McStoreError::Serde(e.to_string()))?;
        let scheduler_observation_json = scheduler_observation
            .map(serialize_scheduler_observation)
            .transpose()?;
        let next = expected.unwrap_or(0) + 1;
        let scheduler_interesting_json = scheduler_observation
            .filter(|_| {
                scheduler_pass_is_interesting(
                    scheduler_applied_reductions,
                    first_divergence.is_some(),
                )
            })
            .map(|observation| {
                serialize_interesting_scheduler_observation(
                    observation,
                    scheduler_request_observed_at_ms,
                    scheduler_full_array_fingerprint,
                    scheduler_eligible_supersession_count,
                    scheduler_withheld_by_tag_window,
                    scheduler_withheld_by_exempt_message,
                    scheduler_applied_supersession_count,
                )
            })
            .transpose()?;
        let canonical_project_root = project_root
            .filter(|root| !root.is_empty())
            .map(|root| canonical_root(root).to_string_lossy().into_owned());
        let divergence_pass_id = next as i64;
        let divergence_at_ms = if overlays.created_at_ms > 0 {
            overlays.created_at_ms
        } else {
            current_time_ms()
        };

        let outcome = self.inner.with_conn_fenced(|tx| {
            // The fenced transaction reads the current row_version; it returns NO_ROW when no row exists.
            let current: i64 = tx.query_row(
                "SELECT COALESCE((SELECT row_version FROM mc_cache_state WHERE session_id = ?1), ?2)",
                params![session_id, NO_ROW],
                |r| r.get(0),
            )?;

            let cas_ok = match expected {
                None => current == NO_ROW,
                Some(v) => current == v as i64,
            };
            if !cas_ok {
                // The transaction commits nothing on a CAS conflict.
                return Ok(CommitOutcome::CasConflict(current.max(0) as u64));
            }
            if let Some(expected_vector) = claim_snapshot_vector {
                let current_vector = claim_mirror::snapshot_vector_from_connection(tx)?;
                let vector_matches = current_vector
                    .as_ref()
                    .and_then(|vector| canonical_snapshot_vector(vector).ok())
                    == canonical_snapshot_vector(expected_vector).ok();
                if !vector_matches {
                    return Ok(CommitOutcome::CasConflict(current.max(0) as u64));
                }
            }
            if let Some(expected_seq) = compartment_max_seq {
                let current_seq: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(sequence), 0) FROM mc_compartments WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get(0),
                )?;
                if current_seq != expected_seq {
                    return Ok(CommitOutcome::CasConflict(current.max(0) as u64));
                }
            }

            // The fenced transaction uses INSERT because bootstrap has no row to update.
            tx.execute(
                "INSERT INTO mc_cache_state (session_id, row_version, core_state, meta, last_activity_at)
                  VALUES (?1, ?2, ?3, ?4, ?5)
                  ON CONFLICT(session_id) DO UPDATE SET
                      row_version = excluded.row_version,
                      core_state  = excluded.core_state,
                      meta        = excluded.meta,
                      last_activity_at = excluded.last_activity_at",
                params![session_id, next as i64, core_json, meta_json, current_time_ms()],
            )?;
            // Every accepted transform owns the current-pass value: stable passes write NULL
            // Stable passes write NULL so an older divergence is not reported as current.
            tx.execute(
                "INSERT INTO mc_pass_trace (
                     session_id,
                     last_received_at_ms,
                     last_completed_at_ms,
                     last_reject_error,
                     last_reject_at_ms,
                     reject_count,
                     receive_count,
                     first_divergence,
                     last_divergence,
                     scheduler_history,
                     scheduler_interesting_history
                 ) VALUES (
                     ?1, 0, 0, NULL, NULL, 0, 0, ?2,
                     CASE WHEN ?2 IS NOT NULL THEN
                         json_object('pass_id', ?3, 'timestamp_ms', ?4, 'divergence', json(?2))
                     ELSE NULL END,
                     CASE WHEN ?5 IS NOT NULL THEN json_array(json(?5)) ELSE '[]' END,
                     CASE WHEN ?6 IS NOT NULL THEN json_array(json(?6)) ELSE '[]' END
                 )
                 ON CONFLICT(session_id) DO UPDATE SET
                     first_divergence = excluded.first_divergence,
                     last_divergence = CASE WHEN excluded.first_divergence IS NOT NULL THEN
                          json_object(
                              'pass_id', ?3,
                              'timestamp_ms', ?4,
                              'divergence', json(excluded.first_divergence)
                          )
                     ELSE mc_pass_trace.last_divergence END,
                     scheduler_history = CASE
                         WHEN ?5 IS NULL THEN mc_pass_trace.scheduler_history
                         WHEN json_array_length(mc_pass_trace.scheduler_history) < 256 THEN
                             json_insert(mc_pass_trace.scheduler_history, '$[#]', json(?5))
                         ELSE
                             json_insert(
                                 (SELECT json_group_array(json(value))
                                    FROM json_each(mc_pass_trace.scheduler_history)
                                   WHERE key >= json_array_length(mc_pass_trace.scheduler_history) - 255),
                                 '$[#]', json(?5)
                              )
                      END,
                      scheduler_interesting_history = CASE
                          WHEN ?6 IS NULL THEN mc_pass_trace.scheduler_interesting_history
                          WHEN json_array_length(mc_pass_trace.scheduler_interesting_history) < 256 THEN
                              json_insert(
                                  mc_pass_trace.scheduler_interesting_history,
                                  '$[#]', json(?6)
                              )
                          ELSE
                              json_insert(
                                  (SELECT json_group_array(json(value))
                                     FROM json_each(mc_pass_trace.scheduler_interesting_history)
                                    WHERE key >= json_array_length(
                                        mc_pass_trace.scheduler_interesting_history
                                    ) - 255),
                                  '$[#]', json(?6)
                              )
                      END",
                 params![
                     session_id,
                     first_divergence,
                     divergence_pass_id,
                     divergence_at_ms,
                     scheduler_observation_json,
                     scheduler_interesting_json
                 ],
            )?;
            if let Some(project_root) = canonical_project_root.as_deref() {
                tx.execute(
                     "INSERT INTO mc_transform_session_roots(
                         session_id, project_root, observed_at
                     ) VALUES (?1, ?2, ?3)
                     ON CONFLICT(session_id, project_root) DO UPDATE SET
                         observed_at = excluded.observed_at",
                    params![session_id, project_root, overlays.created_at_ms],
                )?;
            }

            for input in overlays.tag_mints {
                let block_id = input.block_id.trim();
                if block_id.is_empty() {
                    continue;
                }
                let exists = tx
                    .prepare_cached("SELECT 1 FROM mc_tags WHERE session_id = ?1 AND block_id = ?2")?
                    .query_row(params![session_id, block_id], |_| Ok(()))
                    .optional()?
                    .is_some();
                if exists {
                    continue;
                }
                let next_tag = tx
                    .prepare_cached(
                        "SELECT COALESCE(MAX(tag_number), 0) + 1 FROM mc_tags WHERE session_id = ?1",
                    )?
                    .query_row(params![session_id], |row| row.get::<_, i64>(0))?;
                tx.prepare_cached(
                    "INSERT INTO mc_tags
                         (session_id, tag_number, block_id, kind, token_count, created_at_ms, source_bytes)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )?
                .execute(
                    params![
                        session_id,
                        next_tag,
                        block_id,
                        input.kind,
                        input.token_count.max(0),
                        overlays.created_at_ms,
                        input.source_bytes,
                    ],
                )?;
            }

            let previous_frontier = tx
                .query_row(
                    "SELECT max_seen_ordinal FROM mc_overlay_frontiers WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            for (ordinal, mark) in &temporal_marks {
                if previous_frontier.is_none_or(|frontier| *ordinal > frontier) {
                    tx.execute(
                        "INSERT OR IGNORE INTO mc_temporal_marks
                             (session_id, block_id, marker_text, created_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![
                            session_id,
                            mark.block_id,
                            mark.marker_text,
                            overlays.created_at_ms
                        ],
                    )?;
                }
            }
            if let Some(hint) = overlays.user_hint {
                let eligible = hint_ordinal.is_some_and(|ordinal| {
                    previous_frontier.is_none_or(|frontier| ordinal > frontier)
                });
                if eligible {
                    tx.execute(
                        "INSERT OR IGNORE INTO mc_user_hints
                             (session_id, block_id, hint_text, created_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![
                            session_id,
                            hint.block_id,
                            hint.hint_text,
                            overlays.created_at_ms
                        ],
                    )?;
                }
            }
            if let Some(append) = overlays.channel1_append {
                tx.execute(
                    "INSERT OR IGNORE INTO mc_channel1_appends
                         (session_id, block_id, reminder_text, fired_at_ms)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        session_id,
                        append.block_id,
                        append.reminder_text,
                        append.fired_at_ms
                    ],
                )?;
            }
            if let Some(max_seen_ordinal) = max_seen_ordinal {
                tx.execute(
                    "INSERT INTO mc_overlay_frontiers (session_id, max_seen_ordinal)
                     VALUES (?1, ?2)
                     ON CONFLICT(session_id) DO UPDATE SET
                         max_seen_ordinal = MAX(max_seen_ordinal, excluded.max_seen_ordinal)",
                    params![session_id, max_seen_ordinal],
                )?;
            }

            for command_id in first_applied_command_ids {
                tx.execute(
                    "UPDATE mc_reduce_command_ledger
                     SET first_applied_at_ms = ?3
                     WHERE session_id = ?1
                       AND command_id = ?2
                       AND first_applied_at_ms IS NULL",
                    params![session_id, command_id, overlays.created_at_ms],
                )?;
            }
            for drop_id in consumed_drop_ids {
                tx.execute(
                    "DELETE FROM pending_agent_drops WHERE session_id = ?1 AND id = ?2",
                    params![session_id, drop_id],
                )?;
            }
            Ok(CommitOutcome::Committed(next))
        })?;

        match outcome {
            CommitOutcome::Committed(v) => Ok(v),
            CommitOutcome::CasConflict(found) => Err(McStoreError::CasConflict { expected, found }),
        }
    }

    pub fn apply_authority_state_sync(
        &self,
        request: ModuleStateSyncRequest<'_>,
    ) -> Result<ModuleStateSyncResult, ModuleStateSyncError> {
        self.apply_state_sync(request)
    }

    fn apply_state_sync(
        &self,
        request: ModuleStateSyncRequest<'_>,
    ) -> Result<ModuleStateSyncResult, ModuleStateSyncError> {
        let default_core_json = serde_json::to_string(&CoreState::default())
            .map_err(|e| ModuleStateSyncError::Serde(e.to_string()))?;
        let outcome = self.inner.with_conn_fenced(|tx| {
            let row = tx
                .query_row(
                    "SELECT row_version, core_state, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![request.session_id],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;

            let (current, mut core, mut meta) = match row {
                Some((row_version, core_state_json, meta_json)) => {
                    let core = match serde_json::from_str::<CoreState>(&core_state_json) {
                        Ok(core) => core,
                        Err(e) => return Ok(ModuleStateSyncTxnOutcome::Serde(e.to_string())),
                    };
                    let meta = match serde_json::from_str::<ModuleMeta>(&meta_json) {
                        Ok(meta) => meta,
                        Err(e) => return Ok(ModuleStateSyncTxnOutcome::Serde(e.to_string())),
                    };
                    (row_version, core, meta)
                }
                None => {
                    let core = match serde_json::from_str::<CoreState>(&default_core_json) {
                        Ok(core) => core,
                        Err(e) => return Ok(ModuleStateSyncTxnOutcome::Serde(e.to_string())),
                    };
                    (NO_ROW, core, ModuleMeta::default())
                }
            };
            let initialized_before_sync = meta.initialized;

            if !request.compartments.is_empty()
                && meta.historian.state != HistorianPhase::Idle
            {
                return Ok(ModuleStateSyncTxnOutcome::HistorianBusy {
                    phase: meta.historian.state,
                });
            }
            if meta.shadow_generation != request.shadow_generation {
                return Ok(ModuleStateSyncTxnOutcome::GenerationMismatch {
                    found: meta.shadow_generation,
                });
            }
            if meta.shadow_seq != request.expected_shadow_seq {
                return Ok(ModuleStateSyncTxnOutcome::AuthoritySeqMismatch {
                    found: meta.shadow_seq,
                });
            }

            if let Some(declared) = request.seed_boundary_id {
                let adoption = match validated_seed_boundary(declared, request.compartments) {
                    Ok(adoption) => adoption,
                    Err(detail) => {
                        return Ok(ModuleStateSyncTxnOutcome::InvalidSeedBoundary {
                            declared: declared.to_string(),
                            detail,
                        })
                    }
                };
                if meta.initialized {
                    eprintln!(
                        "mc-store: retained materialized boundary {:?} over state-sync seed {:?} for session {}",
                        core.boundary_id, adoption.boundary_id, request.session_id
                    );
                } else {
                    core.boundary_id = adoption.boundary_id;
                    core.reconcile_pending = false;
                    meta.coverage_ordinal = Some(adoption.coverage_end_ordinal);
                    meta.coverage_start_ordinal = Some(adoption.coverage_start_ordinal);
                    meta.coverage_compartment_seq = Some(adoption.max_sequence);
                    meta.folded_compartment_seq = adoption.max_sequence;
                    meta.pending_rewrite = None;
                    meta.initialized = true;
                    meta.bootstrap_seed_fold_pending = true;
                }
            }

            let drop_seeds_skipped = materialize_drop_seed_units(
                &mut core,
                request.session_id,
                request.drop_seeds,
                request.drop_seed_skipped,
            );
            let mut pending_agent_drops_seeded = 0usize;
            let mut pending_agent_drops_skipped = request.pending_agent_drops_skipped;
            for seed in request.pending_agent_drops {
                if !valid_drop_seed_block_id(&seed.block_id) {
                    pending_agent_drops_skipped = pending_agent_drops_skipped.saturating_add(1);
                    eprintln!(
                        "mc-store: skipped invalid pending drop seed for session {}: {}",
                        request.session_id, seed.block_id
                    );
                    continue;
                }
                pending_agent_drops_seeded += tx.execute(
                    "INSERT INTO pending_agent_drops(session_id, target_id, queued_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(session_id, target_id) DO NOTHING",
                    params![request.session_id, seed.block_id, seed.queued_at_ms.max(0)],
                )?;
            }
            let mut user_hint_seeds_seeded = 0usize;
            let mut auto_search_hint_skipped = request.auto_search_hint_skipped;
            if request.user_hints_replace_session {
                // row.
                // The method skips the replace-delete when serializing hint IDs fails, retaining existing hints.
                // kept set.
                if let Ok(kept_json) = serde_json::to_string(
                    &request
                        .user_hint_seeds
                        .iter()
                        .map(|seed| seed.block_id.as_str())
                        .collect::<Vec<_>>(),
                ) {
                    tx.execute(
                        "DELETE FROM mc_user_hints
                          WHERE session_id = ?1
                            AND block_id NOT IN (SELECT value FROM json_each(?2))",
                        params![request.session_id, kept_json],
                    )?;
                }
            }
            for seed in request.user_hint_seeds {
                if !valid_drop_seed_block_id(&seed.block_id) {
                    auto_search_hint_skipped = auto_search_hint_skipped.saturating_add(1);
                    continue;
                }
                user_hint_seeds_seeded += tx.execute(
                    "INSERT INTO mc_user_hints(session_id, block_id, hint_text, created_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(session_id, block_id) DO UPDATE SET
                         hint_text = excluded.hint_text",
                    params![request.session_id, seed.block_id, seed.hint_text, current_time_ms()],
                )?;
            }
            let note_nudge_anchors_seeded = request
                .note_nudge_anchors
                .map(|anchors| {
                    meta.note_nudge_anchors = anchors.to_vec();
                    anchors.len()
                })
                .unwrap_or(0);
            let todo_synthetic_anchor_seeded = if request.todo_synthetic_anchor_present {
                meta.synthetic_todo = request.todo_synthetic_anchor.cloned();
                true
            } else {
                false
            };
            let emergency_latches_seeded = if let Some((sample, has_prior, watermark)) = request.emergency_latches {
                meta.last_emergency_input_sample = sample.max(0.0);
                meta.has_prior_emergency_drop = has_prior;
                meta.last_execute_ordinal = watermark;
                true
            } else {
                false
            };
            if let Some(marker) = request.pending_compaction_marker {
                meta.pending_compaction_marker = marker.cloned();
            }
            if let Some(deferred) = request.deferred_execute_state {
                meta.deferred_execute_state = deferred.cloned();
            }
            if let Some(state) = request.channel2_nudge_state {
                meta.channel2_nudge_state = state.to_string();
            }
            let strip_seeds_skipped = materialize_strip_seed_units(
                &mut core,
                request.session_id,
                request.strip_seeds,
                request.strip_seed_skipped,
            );

            let mut compartment_overwrites_skipped = 0usize;
            for compartment in request.compartments {
                if initialized_before_sync {
                    let retained_sequence = meta.folded_compartment_seq;
                    if compartment.sequence <= retained_sequence
                        || !write_seed_compartment_tx(
                            tx,
                            request.session_id,
                            compartment,
                            false,
                        )?
                    {
                        compartment_overwrites_skipped =
                            compartment_overwrites_skipped.saturating_add(1);
                    }
                } else {
                    write_seed_compartment_tx(tx, request.session_id, compartment, true)?;
                }
            }
            if compartment_overwrites_skipped > 0 {
                eprintln!(
                    "mc-store: skipped {} state-sync compartment overwrite(s) while retaining folded sequence {} for session {}",
                    compartment_overwrites_skipped,
                    meta.folded_compartment_seq,
                    request.session_id
                );
            }
            if request.workspace_present {
                replace_workspace_tx(tx, request.project_path, request.workspace)?;
            }
            if request.user_profile_present {
                replace_authority_user_profile_tx(tx, request.user_profile)?;
            }

            let in_session_watermark_changed = meta.shadow_acked_watermarks != request.acked_watermarks;
            meta.last_todo_state = request.last_todo_state.clone();
            if in_session_watermark_changed && meta.m1_pending_since_ms.is_none() {
                meta.m1_pending_since_ms = Some(current_time_ms());
            }
            if let Some(epoch) = request.project_memory_epoch {
                if epoch != meta.project_memory_epoch {
                    meta.project_memory_epoch_pending = true;
                }
                meta.project_memory_epoch = epoch;
            }
            if let Some(version) = request.user_profile_version {
                meta.user_profile_version = version;
            }
            if let Some(watermark) = request.reasoning_cleared_through_tag {
                meta.reasoning_cleared_through_tag =
                    meta.reasoning_cleared_through_tag.max(watermark);
                meta.reasoning_cleared_through_ordinal =
                    meta.reasoning_cleared_through_ordinal.max(watermark);
            }
            meta.shadow_seq = meta.shadow_seq.saturating_add(1);
            meta.shadow_acked_watermarks = request.acked_watermarks.clone();

            let next = current.max(0) as u64 + 1;
            let core_json = match serde_json::to_string(&core) {
                Ok(json) => json,
                Err(e) => return Ok(ModuleStateSyncTxnOutcome::Serde(e.to_string())),
            };
            let meta_json = match serde_json::to_string(&meta) {
                Ok(json) => json,
                Err(e) => return Ok(ModuleStateSyncTxnOutcome::Serde(e.to_string())),
            };
            tx.execute(
                "INSERT INTO mc_cache_state (session_id, row_version, core_state, meta, last_activity_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(session_id) DO UPDATE SET
                     row_version = excluded.row_version,
                     core_state  = excluded.core_state,
                     meta        = excluded.meta,
                     last_activity_at = excluded.last_activity_at",
                params![request.session_id, next as i64, core_json, meta_json, current_time_ms()],
            )?;

            Ok(ModuleStateSyncTxnOutcome::Committed(ModuleStateSyncResult {
                shadow_generation: meta.shadow_generation,
                shadow_seq: meta.shadow_seq,
                row_version: next,
                drop_seeds_skipped,
                pending_agent_drops_seeded,
                pending_agent_drops_skipped,
                user_hint_seeds_seeded,
                auto_search_hint_skipped,
                note_nudge_anchors_seeded,
                todo_synthetic_anchor_seeded,
                emergency_latches_seeded,
                strip_seeds_skipped,
            }))
        })?;

        match outcome {
            ModuleStateSyncTxnOutcome::Committed(result) => Ok(result),
            ModuleStateSyncTxnOutcome::GenerationMismatch { found } => {
                Err(ModuleStateSyncError::GenerationMismatch {
                    expected: request.shadow_generation,
                    found,
                })
            }
            ModuleStateSyncTxnOutcome::AuthoritySeqMismatch { found } => {
                Err(ModuleStateSyncError::AuthoritySeqMismatch {
                    expected: request.expected_shadow_seq,
                    found,
                })
            }
            ModuleStateSyncTxnOutcome::HistorianBusy { phase } => {
                Err(ModuleStateSyncError::HistorianBusy { phase })
            }
            ModuleStateSyncTxnOutcome::InvalidSeedBoundary { declared, detail } => {
                Err(ModuleStateSyncError::InvalidSeedBoundary { declared, detail })
            }
            ModuleStateSyncTxnOutcome::Serde(e) => Err(ModuleStateSyncError::Serde(e)),
        }
    }

    fn stored_compartment_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredCompartment> {
        Ok(StoredCompartment {
            sequence: r.get(0)?,
            start_message: r.get(1)?,
            end_message: r.get(2)?,
            start_message_id: r.get(3)?,
            end_message_id: r.get(4)?,
            start_date: r.get(5)?,
            end_date: r.get(6)?,
            title: r.get(7)?,
            content: r.get(8)?,
            p1: r.get(9)?,
            p2: r.get(10)?,
            p3: r.get(11)?,
            p4: r.get(12)?,
            importance: r.get::<_, Option<i64>>(13)?.unwrap_or(50) as i32,
            episode_type: r.get(14)?,
            legacy: r.get::<_, Option<i64>>(15)?.unwrap_or(0) as i32,
            created_at: r.get(16)?,
        })
    }

    /// The decay renderer requires compartments in oldest-first order because it indexes them from newest.
    /// The caller must pass compartments oldest-first because the decay renderer indexes them from newest.
    pub fn load_compartments(
        &self,
        session_id: &str,
    ) -> Result<Vec<StoredCompartment>, McStoreError> {
        let rows = self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT sequence, start_message, end_message, start_message_id, end_message_id,
                        start_date, end_date, title, content, p1, p2, p3, p4, importance,
                        episode_type, legacy, created_at
                 FROM mc_compartments WHERE session_id = ?1 ORDER BY sequence ASC",
            )?;
            let mapped = stmt
                .query_map(params![session_id], Self::stored_compartment_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(mapped)
        })?;
        Ok(rows)
    }

    pub fn max_compartment_end_ordinal(&self, session_id: &str) -> Result<i64, McStoreError> {
        #[cfg(any(test, feature = "test-support"))]
        {
            let hook = self
                .before_max_compartment_end_read_hook
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            if let Some(mut hook) = hook {
                hook(self);
            }
        }
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COALESCE(MAX(end_message), 0)
                       FROM mc_compartments
                      WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get(0),
                )
            })
            .map_err(Into::into)
    }

    pub fn last_compacted_ordinal(&self, session_id: &str) -> Result<i64, McStoreError> {
        self.max_compartment_end_ordinal(session_id)
    }

    /// Expansion must not materialize every historical compartment before applying its response.
    /// budget.
    pub fn load_compartments_for_range(
        &self,
        session_id: &str,
        start: i64,
        end: i64,
        limit: usize,
    ) -> Result<Vec<StoredCompartment>, McStoreError> {
        if limit == 0 || start > end {
            return Ok(Vec::new());
        }
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        self.inner
            .with_conn(|conn| {
                let mut stmt = conn.prepare_cached(
                    "SELECT sequence, start_message, end_message, start_message_id, end_message_id,
                            start_date, end_date, title, content, p1, p2, p3, p4, importance,
                            episode_type, legacy, created_at
                       FROM mc_compartments
                      WHERE session_id = ?1
                        AND end_message >= ?2
                        AND start_message <= ?3
                      ORDER BY sequence ASC
                      LIMIT ?4",
                )?;
                let mapped = stmt
                    .query_map(
                        params![session_id, start, end, limit],
                        Self::stored_compartment_from_row,
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(mapped)
            })
            .map_err(Into::into)
    }

    pub fn load_compartments_after(
        &self,
        session_id: &str,
        after_sequence: i64,
        limit: usize,
    ) -> Result<CompartmentPage, McStoreError> {
        let page = self.inner.with_conn(|conn| {
            let max_sequence = conn
                .query_row(
                    "SELECT MAX(sequence) FROM mc_compartments WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get::<_, Option<i64>>(0),
                )?
                .map_or(after_sequence, |max| max.max(after_sequence));
            let mut stmt = conn.prepare_cached(
                "SELECT sequence, start_message, end_message, start_message_id, end_message_id,
                        start_date, end_date, title, content, p1, p2, p3, p4, importance,
                        episode_type, legacy, created_at
                 FROM mc_compartments
                 WHERE session_id = ?1 AND sequence > ?2
                 ORDER BY sequence ASC LIMIT ?3",
            )?;
            let compartments = stmt
                .query_map(
                    params![session_id, after_sequence, limit as i64],
                    Self::stored_compartment_from_row,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(CompartmentPage {
                compartments,
                max_sequence,
            })
        })?;
        Ok(page)
    }

    pub fn load_historian_assembly_snapshot(
        &self,
        session_id: &str,
    ) -> Result<HistorianAssemblySnapshot, McStoreError> {
        let (meta_json, compartments, compartment_set_generation) =
            self.inner.with_conn(|conn| {
                let meta_json = conn
                    .query_row(
                        "SELECT meta FROM mc_cache_state WHERE session_id = ?1",
                        params![session_id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?;
                let mut stmt = conn.prepare_cached(
                    "SELECT sequence, start_message, end_message, start_message_id, end_message_id,
                        start_date, end_date, title, content, p1, p2, p3, p4, importance,
                        episode_type, legacy, created_at
                 FROM mc_compartments WHERE session_id = ?1 ORDER BY sequence ASC",
                )?;
                let compartments = stmt
                    .query_map(params![session_id], Self::stored_compartment_from_row)?
                    .collect::<Result<Vec<_>, _>>()?;
                let compartment_set_generation = conn.query_row(
                    "SELECT COALESCE(MAX(sequence), 0), COUNT(*)
                 FROM mc_compartments WHERE session_id = ?1",
                    params![session_id],
                    |row| {
                        Ok(CompartmentSetGeneration {
                            max_sequence: row.get(0)?,
                            count: row.get(1)?,
                        })
                    },
                )?;
                Ok((meta_json, compartments, compartment_set_generation))
            })?;
        let revert_epoch = match meta_json {
            Some(json) => {
                serde_json::from_str::<ModuleMeta>(&json)
                    .map_err(|e| McStoreError::Serde(e.to_string()))?
                    .revert_epoch
            }
            None => 0,
        };
        Ok(HistorianAssemblySnapshot {
            compartments,
            revert_epoch,
            compartment_set_generation,
        })
    }

    /// The method returns 0 when no compartment exists.
    pub fn max_compartment_seq(&self, session_id: &str) -> Result<i64, McStoreError> {
        let max = self.inner.with_conn(|conn| {
            let v: i64 = conn.query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM mc_compartments WHERE session_id = ?1",
                params![session_id],
                |r| r.get(0),
            )?;
            Ok(v)
        })?;
        Ok(max)
    }

    /// `SELECT EXISTS` distinguishes an empty session from sequence 0, which `max_compartment_seq` maps to 0.
    pub fn has_compartments(&self, session_id: &str) -> Result<bool, McStoreError> {
        let exists = self.inner.with_conn(|conn| {
            let v: i64 = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM mc_compartments WHERE session_id = ?1)",
                params![session_id],
                |r| r.get(0),
            )?;
            Ok(v)
        })?;
        Ok(exists != 0)
    }

    /// The writer-fenced transaction resolves and persists one fake-compaction lineage edge.
    /// The fenced transaction atomically writes copied compartments with their marker, anchor, ordinal base, and prior-lineage publish fence.
    pub fn descend_lineage(
        &self,
        request: LineageDescentRequest<'_>,
    ) -> Result<LineageDescentOutcome, McStoreError> {
        let note_caller_project = Arc::clone(&self.note_caller_project);
        let outcome = self.inner.with_conn_fenced(|tx| {
            let current_target = tx
                .query_row(
                    "SELECT row_version, core_state, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![request.target_key],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;
            let current_target_version = current_target
                .as_ref()
                .map_or(NO_ROW, |(version, _, _)| *version);
            let cas_ok = match request.expected_target_row_version {
                Some(expected) => current_target_version == expected as i64,
                None => current_target_version == NO_ROW,
            };
            if !cas_ok {
                return Ok(LineageDescentTxnOutcome::CasConflict(
                    current_target_version.max(0) as u64,
                ));
            }

            let (mut target_core, mut target_meta) = match current_target.as_ref() {
                Some((_, core_json, meta_json)) => {
                    let core = match serde_json::from_str(core_json) {
                        Ok(core) => core,
                        Err(error) => {
                            return Ok(LineageDescentTxnOutcome::Serde(error.to_string()))
                        }
                    };
                    let meta = match serde_json::from_str(meta_json) {
                        Ok(meta) => meta,
                        Err(error) => {
                            return Ok(LineageDescentTxnOutcome::Serde(error.to_string()))
                        }
                    };
                    (core, meta)
                }
                None => (CoreState::default(), ModuleMeta::default()),
            };

            if !target_meta.lineage_descent_disposition.is_empty()
                && target_meta.lineage_descent_target_key == request.target_key
            {
                return Ok(LineageDescentTxnOutcome::Committed(LineageDescentOutcome {
                    source_key: target_meta.lineage_descent_source_key.clone(),
                    prior_last_ordinal: target_meta.ordinal_continuation_base,
                    materialization_required: target_meta.descent_completed
                        && !target_meta.lineage_descent_materialized,
                    acknowledge: true,
                    disposition: LineageDescentDisposition::Replay,
                    loaded: LoadedState {
                        core: target_core,
                        meta: target_meta,
                        row_version: Some(current_target_version.max(0) as u64),
                    },
                }));
            }

            let mut path_is_cycle = request.new_epoch <= request.prior_epoch;
            let mut path_is_contiguous = true;
            let mut visited = HashSet::<(String, u64)>::new();
            visited.insert((request.prior_key.to_string(), request.prior_epoch));
            let mut previous_key = request.prior_key;
            let mut previous_epoch = request.prior_epoch;
            for hop in request.constituents {
                if hop.prior_key != previous_key || hop.epoch <= previous_epoch {
                    path_is_contiguous = false;
                    path_is_cycle = true;
                    break;
                }
                if !visited.insert((hop.new_key.clone(), hop.epoch)) {
                    path_is_cycle = true;
                    break;
                }
                previous_key = &hop.new_key;
                previous_epoch = hop.epoch;
            }
            if !request.constituents.is_empty()
                && (previous_key != request.target_key || previous_epoch != request.new_epoch)
            {
                path_is_contiguous = false;
            }
            if !path_is_contiguous && !path_is_cycle {
                return Ok(LineageDescentTxnOutcome::Invalid(
                    "lineage constituent path is not contiguous with the composed edge".to_string(),
                ));
            }

            let terminal = if !target_core.boundary_id.trim().is_empty() {
                Some(LineageDescentDisposition::AlreadyBootstrapped)
            } else if path_is_cycle {
                Some(LineageDescentDisposition::CycleDetected)
            } else if request.anchor.is_none() {
                Some(LineageDescentDisposition::NotCompactionShape)
            } else if !request.compaction_observed {
                Some(LineageDescentDisposition::ObservedFlagMissingShapePresent)
            } else {
                None
            };

            if let Some(disposition) = terminal {
                record_lineage_disposition(
                    &mut target_meta,
                    request.target_key,
                    request.edge_id,
                    &disposition,
                    None,
                    None,
                    false,
                );
                let next_version = current_target_version.max(0) as u64 + 1;
                let core_json = match serde_json::to_string(&target_core) {
                    Ok(json) => json,
                    Err(error) => {
                        return Ok(LineageDescentTxnOutcome::Serde(error.to_string()))
                    }
                };
                let meta_json = match serde_json::to_string(&target_meta) {
                    Ok(json) => json,
                    Err(error) => {
                        return Ok(LineageDescentTxnOutcome::Serde(error.to_string()))
                    }
                };
                tx.execute(
                    "INSERT INTO mc_cache_state (session_id, row_version, core_state, meta, last_activity_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(session_id) DO UPDATE SET
                         row_version = excluded.row_version,
                         core_state = excluded.core_state,
                         meta = excluded.meta,
                         last_activity_at = excluded.last_activity_at",
                    params![
                        request.target_key,
                        next_version as i64,
                        core_json,
                        meta_json,
                        request.now_ms
                    ],
                )?;
                return Ok(LineageDescentTxnOutcome::Committed(LineageDescentOutcome {
                    loaded: LoadedState {
                        core: target_core,
                        meta: target_meta,
                        row_version: Some(next_version),
                    },
                    disposition,
                    source_key: None,
                    prior_last_ordinal: None,
                    materialization_required: false,
                    acknowledge: true,
                }));
            }

            let mut source_key = None;
            for hop in request.constituents.iter().rev() {
                let candidate = hop.prior_key.as_str();
                let candidate_meta = tx
                    .query_row(
                        "SELECT meta FROM mc_cache_state WHERE session_id = ?1",
                        params![candidate],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                let Some(candidate_meta) = candidate_meta else {
                    continue;
                };
                let candidate_meta: ModuleMeta = match serde_json::from_str(&candidate_meta) {
                    Ok(meta) => meta,
                    Err(error) => {
                        return Ok(LineageDescentTxnOutcome::Serde(error.to_string()))
                    }
                };
                if candidate_meta.descent_completed {
                    source_key = Some(candidate.to_string());
                    break;
                }
            }
            if source_key.is_none() {
                let root_exists = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM mc_cache_state WHERE session_id = ?1)",
                        params![request.prior_key],
                        |row| row.get::<_, i64>(0),
                    )?
                    != 0;
                if root_exists {
                    source_key = Some(request.prior_key.to_string());
                }
            }

            let Some(source_key) = source_key else {
                let disposition = LineageDescentDisposition::UnknownAncestor;
                record_lineage_disposition(
                    &mut target_meta,
                    request.target_key,
                    request.edge_id,
                    &disposition,
                    None,
                    None,
                    false,
                );
                let next_version = current_target_version.max(0) as u64 + 1;
                let core_json = match serde_json::to_string(&target_core) {
                    Ok(json) => json,
                    Err(error) => {
                        return Ok(LineageDescentTxnOutcome::Serde(error.to_string()))
                    }
                };
                let meta_json = match serde_json::to_string(&target_meta) {
                    Ok(json) => json,
                    Err(error) => {
                        return Ok(LineageDescentTxnOutcome::Serde(error.to_string()))
                    }
                };
                tx.execute(
                    "INSERT INTO mc_cache_state (session_id, row_version, core_state, meta, last_activity_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(session_id) DO UPDATE SET
                         row_version = excluded.row_version,
                         core_state = excluded.core_state,
                         meta = excluded.meta,
                         last_activity_at = excluded.last_activity_at",
                    params![
                        request.target_key,
                        next_version as i64,
                        core_json,
                        meta_json,
                        request.now_ms
                    ],
                )?;
                return Ok(LineageDescentTxnOutcome::Committed(LineageDescentOutcome {
                    loaded: LoadedState {
                        core: target_core,
                        meta: target_meta,
                        row_version: Some(next_version),
                    },
                    disposition,
                    source_key: None,
                    prior_last_ordinal: None,
                    materialization_required: false,
                    acknowledge: true,
                }));
            };

            let source_row = tx
                .query_row(
                    "SELECT core_state, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![source_key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((source_core_json, source_meta_json)) = source_row else {
                return Ok(LineageDescentTxnOutcome::Invalid(
                    "selected lineage source disappeared inside the fenced transaction".to_string(),
                ));
            };
            let source_core: CoreState = match serde_json::from_str(&source_core_json) {
                Ok(core) => core,
                Err(error) => return Ok(LineageDescentTxnOutcome::Serde(error.to_string())),
            };
            let source_meta: ModuleMeta = match serde_json::from_str(&source_meta_json) {
                Ok(meta) => meta,
                Err(error) => return Ok(LineageDescentTxnOutcome::Serde(error.to_string())),
            };
            let prior_last = source_meta.newest_live_ordinal;
            if prior_last == 0 {
                target_meta.lineage_descent_target_key = request.target_key.to_string();
                target_meta.lineage_descent_edge_id = request.edge_id;
                target_meta.lineage_descent_counters.compaction_seen = target_meta
                    .lineage_descent_counters
                    .compaction_seen
                    .saturating_add(1);
                target_meta
                    .lineage_descent_counters
                    .pending_build_skew = target_meta
                    .lineage_descent_counters
                    .pending_build_skew
                    .saturating_add(1);
                let next_version = current_target_version.max(0) as u64 + 1;
                let core_json = match serde_json::to_string(&target_core) {
                    Ok(json) => json,
                    Err(error) => {
                        return Ok(LineageDescentTxnOutcome::Serde(error.to_string()))
                    }
                };
                let meta_json = match serde_json::to_string(&target_meta) {
                    Ok(json) => json,
                    Err(error) => {
                        return Ok(LineageDescentTxnOutcome::Serde(error.to_string()))
                    }
                };
                tx.execute(
                    "INSERT INTO mc_cache_state (session_id, row_version, core_state, meta, last_activity_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(session_id) DO UPDATE SET
                         row_version = excluded.row_version,
                         core_state = excluded.core_state,
                         meta = excluded.meta,
                         last_activity_at = excluded.last_activity_at",
                    params![
                        request.target_key,
                        next_version as i64,
                        core_json,
                        meta_json,
                        request.now_ms
                    ],
                )?;
                return Ok(LineageDescentTxnOutcome::Committed(LineageDescentOutcome {
                    loaded: LoadedState {
                        core: target_core,
                        meta: target_meta,
                        row_version: Some(next_version),
                    },
                    disposition: LineageDescentDisposition::PendingBuildSkew,
                    source_key: Some(source_key),
                    prior_last_ordinal: None,
                    materialization_required: false,
                    acknowledge: false,
                }));
            }

            let mut statement = tx.prepare_cached(
                "SELECT sequence, start_message, end_message
                   FROM mc_compartments
                  WHERE session_id = ?1
                  ORDER BY sequence ASC",
            )?;
            let ranges = statement
                .query_map(params![source_key], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            let prior_last_i64 = match i64::try_from(prior_last) {
                Ok(value) => value,
                Err(_) => {
                    return Ok(LineageDescentTxnOutcome::Invalid(
                        "prior lineage ordinal exceeds SQLite range".to_string(),
                    ))
                }
            };
            let mut previous_end = None;
            for (_, start, end) in &ranges {
                if *start > *end
                    || *end > prior_last_i64
                    || previous_end.is_some_and(|previous| *start <= previous)
                {
                    return Ok(LineageDescentTxnOutcome::Invalid(format!(
                        "descent range validation failed: [{start},{end}] after {previous_end:?}, prior_last={prior_last}"
                    )));
                }
                previous_end = Some(*end);
            }
            let anchor = request.anchor.expect("eligible descent has an anchor");
            let placeholder_ordinal = match prior_last.checked_add(1) {
                Some(value) => value,
                None => {
                    return Ok(LineageDescentTxnOutcome::Invalid(
                        "prior lineage ordinal overflow".to_string(),
                    ))
                }
            };
            // Fresh lineages require anchor 0 or 1; continued lineages require the placeholder.
            if anchor.ordinal > 1 && anchor.ordinal != placeholder_ordinal {
                return Ok(LineageDescentTxnOutcome::Invalid(format!(
                    "descent anchor {} has ordinal {}, expected a fresh origin (0 or 1) or continued ordinal {}",
                    anchor.block_id, anchor.ordinal, placeholder_ordinal
                )));
            }
            let placeholder_ordinal_i64 = match i64::try_from(placeholder_ordinal) {
                Ok(value) => value,
                Err(_) => {
                    return Ok(LineageDescentTxnOutcome::Invalid(
                        "placeholder ordinal exceeds SQLite range".to_string(),
                    ))
                }
            };
            let placeholder_sequence = ranges
                .last()
                .map_or(1, |(sequence, _, _)| sequence.saturating_add(1));

            // The transaction prepares every fallible blob mutation before copying the first row.
            // After the first row copy, any SQL failure must unwind the fenced transaction rather than return a validation outcome that could commit a partial adoption.
            let prior_row = tx
                .query_row(
                    "SELECT row_version, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![request.prior_key],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((prior_version, prior_meta_json)) = prior_row else {
                return Ok(LineageDescentTxnOutcome::Invalid(
                    "root prior lineage has no cache state for the publish fence".to_string(),
                ));
            };
            let mut prior_meta: ModuleMeta = match serde_json::from_str(&prior_meta_json) {
                Ok(meta) => meta,
                Err(error) => return Ok(LineageDescentTxnOutcome::Serde(error.to_string())),
            };
            prior_meta.revert_epoch = prior_meta.revert_epoch.saturating_add(1);
            prior_meta.last_recut = Some(format!(
                "lineage descent edge {} fenced prior key at epoch {}",
                request.edge_id, prior_meta.revert_epoch
            ));
            let prior_meta_json = match serde_json::to_string(&prior_meta) {
                Ok(json) => json,
                Err(error) => return Ok(LineageDescentTxnOutcome::Serde(error.to_string())),
            };

            target_core = source_core;
            target_core.boundary_id = anchor.block_id.clone();
            target_core.reconcile_pending = false;
            target_meta = source_meta;
            target_meta.coverage_ordinal = Some(placeholder_ordinal);
            target_meta.coverage_compartment_seq = Some(placeholder_sequence);
            target_meta.newest_live_ordinal = prior_last;
            target_meta.historian = HistorianDurableState::default();
            target_meta.pending_rewrite = None;
            target_meta.pending_rewrite_trip_count = 0;
            target_meta.pending_rewrite_ambiguous = false;
            target_meta.pending_rewrite_last_failure = None;
            target_meta.served_output_fingerprint.clear();
            target_meta.anchor_block_id = Some(anchor.block_id.clone());
            target_meta.anchor_content_hash = Some(anchor.content_hash.clone());
            target_meta.ordinal_continuation_base = Some(prior_last);
            target_meta.lineage_descent_materialized = false;
            record_lineage_disposition(
                &mut target_meta,
                request.target_key,
                request.edge_id,
                &LineageDescentDisposition::Descended,
                Some(&source_key),
                Some(prior_last),
                true,
            );
            let next_target_version = current_target_version.max(0) as u64 + 1;
            let target_core_json = match serde_json::to_string(&target_core) {
                Ok(json) => json,
                Err(error) => return Ok(LineageDescentTxnOutcome::Serde(error.to_string())),
            };
            let target_meta_json = match serde_json::to_string(&target_meta) {
                Ok(json) => json,
                Err(error) => return Ok(LineageDescentTxnOutcome::Serde(error.to_string())),
            };

            for table in [
                "mc_chunk_transcripts",
                "mc_compartments",
                "mc_tags",
                "mc_temporal_marks",
                "mc_user_hints",
                "mc_channel1_appends",
                "mc_overlay_frontiers",
            ] {
                tx.execute(
                    &format!("DELETE FROM {table} WHERE session_id = ?1"),
                    params![request.target_key],
                )?;
            }
            // Session notes follow the descended conversation key; the method does not copy smart notes because their project-wide visibility is independent of retained lineage history.
            let note_projects = {
                let mut statement = tx.prepare_cached(
                    "SELECT DISTINCT project_path FROM mc_notes
                      WHERE session_id = ?1 AND type = 'session'",
                )?;
                let projects = statement
                    .query_map(params![source_key], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                projects
            };
            for note_project in note_projects {
                let previous_project = note_caller_project
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .replace(note_project.clone());
                let copy_result = (|| -> rusqlite::Result<()> {
                    tx.execute(
                        "DELETE FROM mc_notes
                          WHERE session_id = ?1 AND project_path = ?2 AND type = 'session'",
                        params![request.target_key, note_project],
                    )?;
                    tx.execute(
                        &format!(
                            "INSERT INTO mc_notes ({NOTE_INSERT_COLUMNS})
                             SELECT type, project_path, ?1, content, status, surface_condition,
                                    ready_at, ready_reason, manifest_json, compiled_check, check_hash,
                                    check_cron, check_failure_count, check_network_failure_count,
                                    check_quarantined_until, check_next_due_at, check_compiled_at,
                                    check_false_since_at, check_last_liveness_at, last_checked_at,
                                    check_status, check_version, policy_version, harness,
                                    anchor_block_id, anchor_ordinal, dismissed_at, dismissal_resolution,
                                    status_version, created_at_ms, updated_at_ms, NULL, NULL,
                                    source_revision, state_version, compiled_source_revision,
                                    compiled_project_path, compiled_provider, compiled_config,
                                    compiled_at, compile_status
                               FROM mc_notes
                              WHERE session_id = ?2 AND project_path = ?3 AND type = 'session'"
                        ),
                        params![request.target_key, source_key, note_project],
                    )?;
                    Ok(())
                })();
                *note_caller_project
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = previous_project;
                copy_result?;
            }
            tx.execute(
                "INSERT INTO mc_compartments (
                     session_id, sequence, start_message, end_message, start_message_id,
                     end_message_id, start_date, end_date, title, content, p1, p2, p3, p4,
                     importance, episode_type, legacy, created_at
                 )
                 SELECT ?1, sequence, start_message, end_message, start_message_id,
                        end_message_id, start_date, end_date, title, content, p1, p2, p3, p4,
                        importance, episode_type, legacy, created_at
                   FROM mc_compartments WHERE session_id = ?2",
                params![request.target_key, source_key],
            )?;
            tx.execute(
                "INSERT INTO mc_chunk_transcripts (
                     session_id, compartment_seq, start_ordinal, end_ordinal,
                     transcript_deflate, raw_messages_deflate, created_at_ms
                 )
                 SELECT ?1, compartment_seq, start_ordinal, end_ordinal,
                        transcript_deflate, raw_messages_deflate, created_at_ms
                   FROM mc_chunk_transcripts WHERE session_id = ?2",
                params![request.target_key, source_key],
            )?;
            tx.execute(
                "INSERT INTO mc_tags (
                     session_id, tag_number, block_id, kind, token_count, created_at_ms, source_bytes
                 )
                 SELECT ?1, tag_number, block_id, kind, token_count, created_at_ms, source_bytes
                   FROM mc_tags WHERE session_id = ?2",
                params![request.target_key, source_key],
            )?;
            tx.execute(
                "INSERT INTO mc_temporal_marks (session_id, block_id, marker_text, created_at)
                 SELECT ?1, block_id, marker_text, created_at
                   FROM mc_temporal_marks WHERE session_id = ?2",
                params![request.target_key, source_key],
            )?;
            tx.execute(
                "INSERT INTO mc_user_hints (session_id, block_id, hint_text, created_at)
                 SELECT ?1, block_id, hint_text, created_at
                   FROM mc_user_hints WHERE session_id = ?2",
                params![request.target_key, source_key],
            )?;
            tx.execute(
                "INSERT INTO mc_channel1_appends (session_id, block_id, reminder_text, fired_at_ms)
                 SELECT ?1, block_id, reminder_text, fired_at_ms
                   FROM mc_channel1_appends WHERE session_id = ?2",
                params![request.target_key, source_key],
            )?;
            tx.execute(
                "INSERT INTO mc_overlay_frontiers (session_id, max_seen_ordinal)
                 SELECT ?1, max_seen_ordinal
                   FROM mc_overlay_frontiers WHERE session_id = ?2",
                params![request.target_key, source_key],
            )?;
            tx.execute(
                "INSERT INTO mc_compartments (
                     session_id, sequence, start_message, end_message, start_message_id,
                     end_message_id, start_date, end_date, title, content, p1, p2, p3, p4,
                     importance, episode_type, legacy, created_at
                 ) VALUES (?1, ?2, ?3, ?3, ?4, ?5, NULL, NULL, '', '', '', '', '', '', 100,
                           'lineage_boundary', 0, ?6)",
                params![
                    request.target_key,
                    placeholder_sequence,
                    placeholder_ordinal_i64,
                    anchor.message_id,
                    anchor.block_id,
                    request.now_ms
                ],
            )?;
            let placeholder_valid = tx
                .query_row(
                    "SELECT start_message, end_message, end_message_id
                       FROM mc_compartments
                      WHERE session_id = ?1 AND sequence = ?2",
                    params![request.target_key, placeholder_sequence],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )?
                == (
                    placeholder_ordinal_i64,
                    placeholder_ordinal_i64,
                    anchor.block_id.clone(),
                );
            if !placeholder_valid {
                return Err(rusqlite::Error::InvalidQuery);
            }

            tx.execute(
                "UPDATE mc_cache_state
                    SET row_version = ?2, meta = ?3, last_activity_at = ?4
                  WHERE session_id = ?1 AND row_version = ?5",
                params![
                    request.prior_key,
                    prior_version.saturating_add(1),
                    prior_meta_json,
                    request.now_ms,
                    prior_version
                ],
            )?;

            tx.execute(
                "INSERT INTO mc_cache_state (session_id, row_version, core_state, meta, last_activity_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(session_id) DO UPDATE SET
                     row_version = excluded.row_version,
                     core_state = excluded.core_state,
                     meta = excluded.meta,
                     last_activity_at = excluded.last_activity_at",
                params![
                    request.target_key,
                    next_target_version as i64,
                    target_core_json,
                    target_meta_json,
                    request.now_ms
                ],
            )?;

            Ok(LineageDescentTxnOutcome::Committed(LineageDescentOutcome {
                loaded: LoadedState {
                    core: target_core,
                    meta: target_meta,
                    row_version: Some(next_target_version),
                },
                disposition: LineageDescentDisposition::Descended,
                source_key: Some(source_key),
                prior_last_ordinal: Some(prior_last),
                materialization_required: true,
                acknowledge: true,
            }))
        })?;

        match outcome {
            LineageDescentTxnOutcome::Committed(outcome) => Ok(outcome),
            LineageDescentTxnOutcome::CasConflict(found) => Err(McStoreError::CasConflict {
                expected: request.expected_target_row_version,
                found,
            }),
            LineageDescentTxnOutcome::Invalid(detail) => Err(McStoreError::Serde(format!(
                "lineage descent validation failed: {detail}"
            ))),
            LineageDescentTxnOutcome::Serde(error) => Err(McStoreError::Serde(error)),
        }
    }

    pub fn load_m1_revision_snapshot(
        &self,
        note_project_path: &str,
        session_id: &str,
    ) -> Result<M1RevisionSnapshot, McStoreError> {
        self.inner
            .with_conn(|conn| {
                let transaction = conn.unchecked_transaction()?;
                let max_compartment_seq = transaction.query_row(
                    "SELECT COALESCE(MAX(sequence), 0) FROM mc_compartments WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get(0),
                )?;
                let note_status_version = transaction.query_row(
                    "SELECT COALESCE(MAX(status_version), 0) FROM mc_notes WHERE project_path = ?1",
                    params![note_project_path],
                    |row| row.get(0),
                )?;
                transaction.commit()?;
                Ok(M1RevisionSnapshot {
                    max_compartment_seq,
                    note_status_version,
                })
            })
            .map_err(Into::into)
    }

    /// The method replaces a session's entire compartment set in one fenced transaction.
    pub fn replace_compartments(
        &self,
        session_id: &str,
        compartments: &[StoredCompartment],
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "DELETE FROM mc_chunk_transcripts WHERE session_id = ?1",
                params![session_id],
            )?;
            tx.execute(
                "DELETE FROM mc_compartments WHERE session_id = ?1",
                params![session_id],
            )?;
            for c in compartments {
                insert_compartment_tx(tx, session_id, c.sequence, c)?;
            }
            Ok(())
        })?;
        Ok(())
    }

    ///
    /// The reset writes default `CoreState` and `ModuleMeta` values with a bumped revert epoch.
    pub fn reset_session_for_recomp(
        &self,
        session_id: &str,
        expected_row_version: Option<u64>,
    ) -> Result<TruncateOutcome, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let row = tx
                .query_row(
                    "SELECT row_version, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![session_id],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((current, meta_json)) = row else {
                return Ok(TruncateTxnOutcome::CasConflict(0));
            };
            let cas_ok = match expected_row_version {
                Some(version) => current == version as i64,
                None => current == NO_ROW,
            };
            if !cas_ok {
                return Ok(TruncateTxnOutcome::CasConflict(current.max(0) as u64));
            }
            let prior_meta: ModuleMeta = match serde_json::from_str(&meta_json) {
                Ok(meta) => meta,
                Err(error) => return Ok(TruncateTxnOutcome::Serde(error.to_string())),
            };
            let next_epoch = prior_meta.revert_epoch.saturating_add(1);
            let reset_meta = ModuleMeta {
                revert_epoch: next_epoch,
                last_recut: Some(format!(
                    "native recomp reset all compartments; epoch {next_epoch}"
                )),
                ..ModuleMeta::default()
            };
            let core_json = match serde_json::to_string(&CoreState::default()) {
                Ok(json) => json,
                Err(error) => return Ok(TruncateTxnOutcome::Serde(error.to_string())),
            };
            let reset_meta_json = match serde_json::to_string(&reset_meta) {
                Ok(json) => json,
                Err(error) => return Ok(TruncateTxnOutcome::Serde(error.to_string())),
            };
            tx.execute(
                "DELETE FROM mc_chunk_transcripts WHERE session_id = ?1",
                params![session_id],
            )?;
            tx.execute(
                "DELETE FROM mc_compartments WHERE session_id = ?1",
                params![session_id],
            )?;
            tx.execute(
                "DELETE FROM mc_compartment_events WHERE session_id = ?1",
                params![session_id],
            )?;
            tx.execute(
                "DELETE FROM mc_primer_candidates WHERE session_id = ?1",
                params![session_id],
            )?;
            tx.execute(
                "DELETE FROM mc_user_memory_candidates WHERE session_id = ?1",
                params![session_id],
            )?;
            tx.execute(
                "DELETE FROM mc_historian_side_channel_outbox WHERE session_id = ?1",
                params![session_id],
            )?;
            let next_version = current as u64 + 1;
            tx.execute(
                "UPDATE mc_cache_state
                    SET row_version = ?2, core_state = ?3, meta = ?4
                  WHERE session_id = ?1 AND row_version = ?5",
                params![
                    session_id,
                    next_version as i64,
                    core_json,
                    reset_meta_json,
                    current
                ],
            )?;
            Ok(TruncateTxnOutcome::Committed(TruncateOutcome {
                revert_epoch: next_epoch,
                last_recut: reset_meta.last_recut,
                row_version: next_version,
            }))
        })?;
        match outcome {
            TruncateTxnOutcome::Committed(outcome) => Ok(outcome),
            TruncateTxnOutcome::CasConflict(found) => Err(McStoreError::CasConflict {
                expected: expected_row_version,
                found,
            }),
            TruncateTxnOutcome::Serde(error) => Err(McStoreError::Serde(error)),
        }
    }

    /// The truncation increments the revert epoch under the same row-version CAS. A no-op returns the current epoch and version without rewriting `meta`.
    pub fn truncate_compartments_for_revert(
        &self,
        session_id: &str,
        keep_through_seq: i64,
        expected_row_version: Option<u64>,
    ) -> Result<TruncateOutcome, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let row = tx
                .query_row(
                    "SELECT row_version, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![session_id],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((current, meta_json)) = row else {
                return Ok(TruncateTxnOutcome::CasConflict(0));
            };

            let cas_ok = match expected_row_version {
                Some(v) => current == v as i64,
                None => current == NO_ROW,
            };
            if !cas_ok {
                return Ok(TruncateTxnOutcome::CasConflict(current.max(0) as u64));
            }

            let mut meta: ModuleMeta = match serde_json::from_str(&meta_json) {
                Ok(meta) => meta,
                Err(e) => return Ok(TruncateTxnOutcome::Serde(e.to_string())),
            };

            let (dropped_count, dropped_min, dropped_max): (i64, Option<i64>, Option<i64>) = tx
                .query_row(
                    "SELECT COUNT(*), MIN(sequence), MAX(sequence)
                     FROM mc_compartments WHERE session_id = ?1 AND sequence > ?2",
                    params![session_id, keep_through_seq],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
            if dropped_count == 0 {
                return Ok(TruncateTxnOutcome::Committed(TruncateOutcome {
                    revert_epoch: meta.revert_epoch,
                    last_recut: meta.last_recut,
                    row_version: current.max(0) as u64,
                }));
            }

            let surviving_tail = tx
                .query_row(
                    "SELECT sequence, end_message_id FROM mc_compartments
                     WHERE session_id = ?1 AND sequence <= ?2
                     ORDER BY sequence DESC LIMIT 1",
                    params![session_id, keep_through_seq],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?;
            let surviving_head_id = tx
                .query_row(
                    "SELECT start_message_id FROM mc_compartments
                     WHERE session_id = ?1 AND sequence <= ?2
                     ORDER BY sequence ASC LIMIT 1",
                    params![session_id, keep_through_seq],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;

            let next_epoch = meta.revert_epoch.saturating_add(1);
            let dropped_range = match (dropped_min, dropped_max) {
                (Some(min), Some(max)) if min == max => min.to_string(),
                (Some(min), Some(max)) => format!("{min}..{max}"),
                _ => "unknown".to_string(),
            };
            let surviving_seq = surviving_tail
                .as_ref()
                .map(|(seq, _)| seq.to_string())
                .unwrap_or_else(|| "none".to_string());
            let live_head = surviving_head_id.unwrap_or_else(|| "none".to_string());
            let live_tail = surviving_tail
                .as_ref()
                .map(|(_, id)| id.clone())
                .unwrap_or_else(|| "none".to_string());
            let last_recut = Some(format!(
                "dropped seq {dropped_range}; surviving seq {surviving_seq}; live head {live_head}; live tail {live_tail}; epoch {next_epoch}"
            ));
            meta.revert_epoch = next_epoch;
            meta.last_recut = last_recut.clone();
            let meta_json = match serde_json::to_string(&meta) {
                Ok(json) => json,
                Err(e) => return Ok(TruncateTxnOutcome::Serde(e.to_string())),
            };

            tx.execute(
                "DELETE FROM mc_chunk_transcripts WHERE session_id = ?1 AND compartment_seq > ?2",
                params![session_id, keep_through_seq],
            )?;
            tx.execute(
                "DELETE FROM mc_compartments WHERE session_id = ?1 AND sequence > ?2",
                params![session_id, keep_through_seq],
            )?;
            tx.execute(
                "DELETE FROM mc_compartment_events
                  WHERE session_id = ?1 AND compartment_id > ?2",
                params![session_id, keep_through_seq],
            )?;
            tx.execute(
                "DELETE FROM mc_primer_candidates
                  WHERE session_id = ?1
                    AND source_compartment_start > COALESCE(
                        (SELECT MAX(end_message) FROM mc_compartments WHERE session_id = ?1), -1)",
                params![session_id],
            )?;
            tx.execute(
                "DELETE FROM mc_user_memory_candidates
                  WHERE session_id = ?1
                    AND source_compartment_start > COALESCE(
                        (SELECT MAX(end_message) FROM mc_compartments WHERE session_id = ?1), -1)",
                params![session_id],
            )?;
            tx.execute(
                "DELETE FROM mc_historian_side_channel_outbox
                  WHERE session_id = ?1
                    AND source_start > COALESCE(
                        (SELECT MAX(end_message) FROM mc_compartments WHERE session_id = ?1), -1)",
                params![session_id],
            )?;
            let next = current as u64 + 1;
            tx.execute(
                "UPDATE mc_cache_state SET row_version = ?2, meta = ?3
                 WHERE session_id = ?1 AND row_version = ?4",
                params![session_id, next as i64, meta_json, current],
            )?;

            Ok(TruncateTxnOutcome::Committed(TruncateOutcome {
                revert_epoch: next_epoch,
                last_recut,
                row_version: next,
            }))
        })?;

        match outcome {
            TruncateTxnOutcome::Committed(outcome) => Ok(outcome),
            TruncateTxnOutcome::CasConflict(found) => Err(McStoreError::CasConflict {
                expected: expected_row_version,
                found,
            }),
            TruncateTxnOutcome::Serde(e) => Err(McStoreError::Serde(e)),
        }
    }

    /// The transaction appends compartments at the current tail without renumbering existing rows.
    /// The store treats incoming `sequence` values as producer-local hints.
    /// The store assigns durable sequences contiguously after the current maximum.
    pub fn append_compartments(
        &self,
        session_id: &str,
        compartments: &[StoredCompartment],
    ) -> Result<(), McStoreError> {
        let outcome = self
            .inner
            .with_conn_fenced(|tx| append_compartments_tx(tx, session_id, compartments))?;
        match outcome {
            AppendCompartmentsTxnOutcome::Appended => Ok(()),
            AppendCompartmentsTxnOutcome::Overlap {
                existing_sequence,
                incoming_start_message,
                incoming_end_message,
            } => Err(McStoreError::CompartmentRangeOverlap {
                existing_sequence,
                incoming_start_message,
                incoming_end_message,
            }),
        }
    }

    /// watermark.
    pub fn abandon_historian_run_if_matching(
        &self,
        session_id: &str,
        predicate: &HistorianPublishPredicate,
        failure_backoff_at_ms: Option<i64>,
        detail: Option<&str>,
    ) -> Result<Option<u64>, McStoreError> {
        self.abandon_historian_run_if_matching_with_publish_failure(
            session_id,
            predicate,
            failure_backoff_at_ms,
            detail,
            false,
        )
    }

    /// The transaction releases a matching run and optionally records a failed publish attempt.
    /// The durable historian state records publish failures because publication can fail after producer success.
    pub fn abandon_historian_run_if_matching_with_publish_failure(
        &self,
        session_id: &str,
        predicate: &HistorianPublishPredicate,
        failure_backoff_at_ms: Option<i64>,
        detail: Option<&str>,
        count_publish_failure: bool,
    ) -> Result<Option<u64>, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let row = tx
                .query_row(
                    "SELECT row_version, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![session_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((current, meta_json)) = row else {
                return Ok(AbandonHistorianTxnOutcome::Unchanged);
            };
            let mut meta: ModuleMeta = match serde_json::from_str(&meta_json) {
                Ok(meta) => meta,
                Err(error) => return Ok(AbandonHistorianTxnOutcome::Serde(error.to_string())),
            };
            let historian = &meta.historian;
            let predicate_matches = historian.firing_seq == predicate.firing_seq
                && historian.producer_run_id.as_deref() == Some(predicate.producer_run_id.as_str())
                && historian.chunk_fingerprint == predicate.chunk_fingerprint
                && historian.selected_range_identities == predicate.selected_range_identities
                && historian.compartment_set_generation == predicate.compartment_set_generation;
            if !predicate_matches || historian.state == HistorianPhase::Idle {
                return Ok(AbandonHistorianTxnOutcome::Unchanged);
            }

            #[cfg(any(test, feature = "test-support"))]
            if let Some(hook) = self
                .abandon_historian_hook
                .lock()
                .expect("abandon historian hook mutex")
                .as_mut()
            {
                hook();
            }

            let last_failure = detail
                .map(str::to_string)
                .or_else(|| historian.last_failure.clone());
            meta.historian = HistorianDurableState {
                state: HistorianPhase::Idle,
                firing_seq: historian.firing_seq,
                failure_backoff_at_ms,
                last_failure,
                consecutive_publish_failures: if count_publish_failure {
                    historian.consecutive_publish_failures.saturating_add(1)
                } else {
                    historian.consecutive_publish_failures
                },
                ..HistorianDurableState::default()
            };
            let next = current.max(0) as u64 + 1;
            let meta_json = match serde_json::to_string(&meta) {
                Ok(json) => json,
                Err(error) => return Ok(AbandonHistorianTxnOutcome::Serde(error.to_string())),
            };
            tx.execute(
                "UPDATE mc_cache_state SET row_version = ?2, meta = ?3
                 WHERE session_id = ?1 AND row_version = ?4",
                params![session_id, next as i64, meta_json, current],
            )?;
            Ok(AbandonHistorianTxnOutcome::Committed(next))
        })?;

        match outcome {
            AbandonHistorianTxnOutcome::Unchanged => Ok(None),
            AbandonHistorianTxnOutcome::Committed(row_version) => Ok(Some(row_version)),
            AbandonHistorianTxnOutcome::Serde(error) => Err(McStoreError::Serde(error)),
        }
    }

    pub fn record_historian_publish_failure_if_matching(
        &self,
        session_id: &str,
        predicate: &HistorianPublishPredicate,
    ) -> Result<Option<u64>, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let row = tx
                .query_row(
                    "SELECT row_version, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![session_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((current, meta_json)) = row else {
                return Ok(AbandonHistorianTxnOutcome::Unchanged);
            };
            let mut meta: ModuleMeta = match serde_json::from_str(&meta_json) {
                Ok(meta) => meta,
                Err(error) => return Ok(AbandonHistorianTxnOutcome::Serde(error.to_string())),
            };
            let historian = &meta.historian;
            let predicate_matches = historian.firing_seq == predicate.firing_seq
                && historian.producer_run_id.as_deref() == Some(predicate.producer_run_id.as_str())
                && historian.chunk_fingerprint == predicate.chunk_fingerprint
                && historian.selected_range_identities == predicate.selected_range_identities
                && historian.compartment_set_generation == predicate.compartment_set_generation;
            if !predicate_matches {
                return Ok(AbandonHistorianTxnOutcome::Unchanged);
            }
            meta.historian.consecutive_publish_failures = meta
                .historian
                .consecutive_publish_failures
                .saturating_add(1);
            let next = current.max(0) as u64 + 1;
            let meta_json = match serde_json::to_string(&meta) {
                Ok(json) => json,
                Err(error) => return Ok(AbandonHistorianTxnOutcome::Serde(error.to_string())),
            };
            tx.execute(
                "UPDATE mc_cache_state SET row_version = ?2, meta = ?3 WHERE session_id = ?1 AND row_version = ?4",
                params![session_id, next as i64, meta_json, current],
            )?;
            Ok(AbandonHistorianTxnOutcome::Committed(next))
        })?;
        match outcome {
            AbandonHistorianTxnOutcome::Unchanged => Ok(None),
            AbandonHistorianTxnOutcome::Committed(row_version) => Ok(Some(row_version)),
            AbandonHistorianTxnOutcome::Serde(error) => Err(McStoreError::Serde(error)),
        }
    }

    /// The transaction publishes a validated historian chunk in one CAS-gated transaction.
    /// The publish predicate requires the producer to match the exact firing that created the chunk.
    /// Stale reattaches and racing publishers fail before the transaction writes any rows.
    /// The transaction leaves render state unchanged; later materialization exposes new rows through existing store watermarks.
    /// The transaction leaves `CoreState`, `coverage_ordinal`, watermarks, and m1 revision unchanged.
    pub fn publish_historian_chunk(
        &self,
        request: HistorianPublishRequest<'_>,
    ) -> Result<HistorianPublishResult, HistorianPublishError> {
        let session_id = request.session_id;
        let expected_row_version = request.expected_row_version;
        let predicate = request.predicate;
        let side_channel_items =
            historian_side_channel_pending_items(&request).map_err(HistorianPublishError::Serde)?;
        let outcome = self.inner.with_conn_fenced(|tx| {
            let row = tx
                .query_row(
                    "SELECT row_version, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![session_id],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?;

            let Some((current, meta_json)) = row else {
                return Ok(PublishTxnOutcome::InvalidState("missing".to_string()));
            };

            let cas_ok = match expected_row_version {
                Some(v) => current == v as i64,
                None => current == NO_ROW,
            };
            if !cas_ok {
                return Ok(PublishTxnOutcome::CasConflict {
                    found: current.max(0) as u64,
                    reason: None,
                });
            }

            let mut meta: ModuleMeta = match serde_json::from_str(&meta_json) {
                Ok(meta) => meta,
                Err(e) => return Ok(PublishTxnOutcome::Serde(e.to_string())),
            };

            if !matches!(
                meta.historian.state,
                HistorianPhase::Publishing | HistorianPhase::AwaitingProducer
            ) {
                return Ok(PublishTxnOutcome::InvalidState(
                    meta.historian.state.as_str().to_string(),
                ));
            }

            let predicate_matches = meta.historian.firing_seq == predicate.firing_seq
                && meta.historian.producer_run_id.as_deref()
                    == Some(predicate.producer_run_id.as_str())
                && meta.historian.chunk_fingerprint == predicate.chunk_fingerprint
                && meta.historian.selected_range_identities == predicate.selected_range_identities
                && meta.historian.compartment_set_generation
                    == predicate.compartment_set_generation;
            if !predicate_matches {
                return Ok(PublishTxnOutcome::StateMismatch(Box::new(meta.historian)));
            }

            // Block identities verify content freshness.
            // An empty vector cannot establish that the selected content is current.
            if predicate.selected_range_identities.is_empty() {
                return Ok(PublishTxnOutcome::FenceRejected(
                    "historian firing has no selected-range content identities".to_string(),
                ));
            }
            if let Some(changed) = predicate.selected_range_identities.iter().find(|selected| {
                meta.block_identity_by_mid.get(&selected.mid) != Some(&selected.block_identities)
            }) {
                return Ok(PublishTxnOutcome::FenceRejected(format!(
                    "selected historian message {} changed after firing",
                    changed.mid
                )));
            }

            if meta.revert_epoch != request.expected_revert_epoch {
                return Ok(PublishTxnOutcome::CasConflict {
                    found: current.max(0) as u64,
                    reason: Some(
                        "revert epoch mismatch (session was re-cut mid-firing)".to_string(),
                    ),
                });
            }

            let current_compartment_set_generation = tx.query_row(
                "SELECT COALESCE(MAX(sequence), 0), COUNT(*)
                 FROM mc_compartments WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok(CompartmentSetGeneration {
                        max_sequence: row.get(0)?,
                        count: row.get(1)?,
                    })
                },
            )?;
            if current_compartment_set_generation != predicate.compartment_set_generation {
                return Ok(PublishTxnOutcome::FenceRejected(format!(
                    "compartment set changed after firing (expected max sequence {} with {} rows, found {} with {} rows)",
                    predicate.compartment_set_generation.max_sequence,
                    predicate.compartment_set_generation.count,
                    current_compartment_set_generation.max_sequence,
                    current_compartment_set_generation.count,
                )));
            }

            let first_appended_sequence = next_compartment_sequence_tx(tx, session_id)?;
            match append_compartments_tx(tx, session_id, request.compartments)? {
                AppendCompartmentsTxnOutcome::Appended => {}
                AppendCompartmentsTxnOutcome::Overlap {
                    existing_sequence,
                    incoming_start_message,
                    incoming_end_message,
                } => {
                    return Ok(PublishTxnOutcome::CompartmentOverlap {
                        existing_sequence,
                        incoming_start_message,
                        incoming_end_message,
                    });
                }
            }
            if request.chunk_transcript.is_some() || request.raw_chunk_messages.is_some() {
                insert_chunk_transcripts_tx(
                    tx,
                    session_id,
                    first_appended_sequence,
                    request.compartments,
                    request.chunk_transcript,
                    request.raw_chunk_messages,
                )?;
            }
            enqueue_historian_side_channels_tx(tx, session_id, &side_channel_items)?;

            meta.publication_floor_ordinal = Some(
                meta.publication_floor_ordinal
                    .unwrap_or(1)
                    .max(request.publication_floor_ordinal.max(1)),
            );
            meta.historian = idle_historian_after_success(meta.historian.firing_seq);

            let next = current as u64 + 1;
            let meta_json = match serde_json::to_string(&meta) {
                Ok(json) => json,
                Err(e) => return Ok(PublishTxnOutcome::Serde(e.to_string())),
            };
            tx.execute(
                "UPDATE mc_cache_state SET row_version = ?2, meta = ?3
                 WHERE session_id = ?1 AND row_version = ?4",
                params![session_id, next as i64, meta_json, current],
            )?;

            Ok(PublishTxnOutcome::Committed(HistorianPublishResult {
                row_version: next,
            }))
        })?;

        match outcome {
            PublishTxnOutcome::Committed(result) => {
                // The compartment commit already makes the accepted payload durable.
                // The transaction drains each historian side-channel kind independently and retains failed work for a later transform.
                let _ = self.drain_historian_side_channels(
                    session_id,
                    current_time_ms(),
                    HISTORIAN_SIDE_CHANNEL_DRAIN_PER_KIND,
                );
                Ok(result)
            }
            PublishTxnOutcome::CasConflict { found, reason } => {
                Err(HistorianPublishError::CasConflict {
                    expected: expected_row_version,
                    found,
                    reason,
                })
            }
            PublishTxnOutcome::FenceRejected(reason) => {
                Err(HistorianPublishError::FenceRejected { reason })
            }
            PublishTxnOutcome::CompartmentOverlap {
                existing_sequence,
                incoming_start_message,
                incoming_end_message,
            } => Err(HistorianPublishError::CompartmentOverlap {
                existing_sequence,
                incoming_start_message,
                incoming_end_message,
            }),
            PublishTxnOutcome::StateMismatch(found) => Err(HistorianPublishError::StateMismatch {
                expected: Box::new(predicate.clone()),
                found,
            }),
            PublishTxnOutcome::InvalidState(state) => {
                Err(HistorianPublishError::InvalidState { state })
            }
            PublishTxnOutcome::Serde(e) => Err(HistorianPublishError::Serde(e)),
        }
    }

    /// The transaction drains due historian side-channel work without coupling target tables.
    pub fn drain_historian_side_channels(
        &self,
        session_id: &str,
        now_ms: i64,
        per_kind_limit: usize,
    ) -> Result<HistorianSideChannelDrainResult, McStoreError> {
        let mut result = HistorianSideChannelDrainResult::default();
        let mut bookkeeping_error = None;
        self.delete_delivered_historian_side_channels(session_id)?;
        if per_kind_limit == 0 {
            return Ok(result);
        }

        for kind in HISTORIAN_SIDE_CHANNEL_KINDS {
            let rows = self.load_due_historian_side_channels(
                session_id,
                kind,
                now_ms,
                per_kind_limit.min(HISTORIAN_SIDE_CHANNEL_DRAIN_PER_KIND),
            )?;
            for row in rows {
                result.attempted += 1;
                match self.deliver_historian_side_channel(&row, now_ms) {
                    Ok(()) => {
                        result.succeeded += 1;
                        if let Err(error) = self.delete_delivered_historian_side_channel(&row) {
                            bookkeeping_error.get_or_insert(error);
                        }
                    }
                    Err(error) => {
                        result.failed += 1;
                        if let Err(record_error) =
                            self.record_historian_side_channel_failure(&row, now_ms, &error)
                        {
                            bookkeeping_error.get_or_insert(record_error);
                        }
                    }
                }
            }
        }

        match bookkeeping_error {
            Some(error) => Err(error),
            None => Ok(result),
        }
    }

    pub fn historian_side_channel_status(
        &self,
        session_id: &str,
    ) -> Result<HistorianSideChannelStatus, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*),
                        (SELECT last_error
                           FROM mc_historian_side_channel_outbox recent
                          WHERE recent.session_id = ?1
                            AND recent.delivered_at_ms IS NULL
                            AND recent.last_error IS NOT NULL
                          ORDER BY recent.last_attempt_at_ms DESC, recent.firing_seq DESC,
                                   recent.item_index DESC
                          LIMIT 1)
                   FROM mc_historian_side_channel_outbox pending
                  WHERE pending.session_id = ?1 AND pending.delivered_at_ms IS NULL",
                params![session_id],
                |row| {
                    Ok(HistorianSideChannelStatus {
                        pending_count: row.get::<_, i64>(0)?.max(0) as usize,
                        last_failure: row.get(1)?,
                    })
                },
            )
        })?)
    }

    fn load_due_historian_side_channels(
        &self,
        session_id: &str,
        kind: &str,
        now_ms: i64,
        limit: usize,
    ) -> Result<Vec<HistorianSideChannelOutboxRow>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT firing_seq, source_start, source_end, item_index, payload_json,
                        attempt_count
                   FROM mc_historian_side_channel_outbox INDEXED BY idx_mc_historian_side_channel_outbox_order
                  WHERE session_id = ?1 AND kind = ?2 AND delivered_at_ms IS NULL
                    AND next_attempt_at_ms <= ?3
                  ORDER BY firing_seq, source_start, source_end, item_index
                  LIMIT ?4",
            )?;
            let rows =
                statement.query_map(params![session_id, kind, now_ms, limit as i64], |row| {
                    Ok(HistorianSideChannelOutboxRow {
                        session_id: session_id.to_string(),
                        id: HistorianSideChannelOutboxId {
                            firing_seq: row.get::<_, i64>(0)?.max(0) as u64,
                            kind: kind.to_string(),
                            source_start: row.get::<_, i64>(1)?.max(0) as u64,
                            source_end: row.get::<_, i64>(2)?.max(0) as u64,
                            item_index: row.get::<_, i64>(3)?.max(0) as usize,
                        },
                        payload_json: row.get(4)?,
                        attempt_count: row.get::<_, i64>(5)?.max(0) as u32,
                    })
                })?;
            rows.collect::<Result<Vec<_>, _>>()
        })?)
    }

    fn deliver_historian_side_channel(
        &self,
        row: &HistorianSideChannelOutboxRow,
        now_ms: i64,
    ) -> Result<(), McStoreError> {
        #[cfg(any(test, feature = "test-support"))]
        if self
            .historian_side_channel_fail_once
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&row.id.kind)
        {
            return Err(McStoreError::Serde(format!(
                "injected historian {} side-channel failure",
                row.id.kind
            )));
        }

        match row.id.kind.as_str() {
            "event" => {
                let candidate: HistorianEventCandidate = serde_json::from_str(&row.payload_json)
                    .map_err(|error| McStoreError::Serde(error.to_string()))?;
                self.inner.with_conn_fenced(|tx| {
                    insert_historian_events_tx(
                        tx,
                        &row.session_id,
                        std::slice::from_ref(&candidate),
                    )?;
                    mark_historian_side_channel_delivered_tx(tx, row, now_ms)
                })?;
            }
            "primer" => {
                let candidate: HistorianPrimerCandidate =
                    serde_json::from_str(&row.payload_json)
                        .map_err(|error| McStoreError::Serde(error.to_string()))?;
                self.inner.with_conn_fenced(|tx| {
                    insert_historian_primer_tx(tx, &candidate)?;
                    mark_historian_side_channel_delivered_tx(tx, row, now_ms)
                })?;
            }
            "user_observation" => {
                let candidate: HistorianUserMemoryCandidate =
                    serde_json::from_str(&row.payload_json)
                        .map_err(|error| McStoreError::Serde(error.to_string()))?;
                self.inner.with_conn_fenced(|tx| {
                    insert_historian_user_observation_tx(tx, &candidate)?;
                    mark_historian_side_channel_delivered_tx(tx, row, now_ms)
                })?;
            }
            other => {
                return Err(McStoreError::Serde(format!(
                    "unknown historian side-channel kind {other:?}"
                )))
            }
        }
        Ok(())
    }

    fn record_historian_side_channel_failure(
        &self,
        row: &HistorianSideChannelOutboxRow,
        now_ms: i64,
        error: &McStoreError,
    ) -> Result<(), McStoreError> {
        let exponent = row.attempt_count.min(6);
        let delay_ms = 1_000_i64
            .saturating_mul(1_i64 << exponent)
            .min(HISTORIAN_SIDE_CHANNEL_MAX_BACKOFF_MS);
        let next_attempt_at_ms = now_ms.saturating_add(delay_ms);
        let error = error
            .to_string()
            .chars()
            .take(HISTORIAN_SIDE_CHANNEL_ERROR_CAP)
            .collect::<String>();
        self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "UPDATE mc_historian_side_channel_outbox
                    SET attempt_count = attempt_count + 1, next_attempt_at_ms = ?7,
                        last_attempt_at_ms = ?8, last_error = ?9
                  WHERE session_id = ?1 AND firing_seq = ?2 AND kind = ?3
                    AND source_start = ?4 AND source_end = ?5 AND item_index = ?6
                    AND delivered_at_ms IS NULL",
                params![
                    row.session_id,
                    row.id.firing_seq as i64,
                    row.id.kind,
                    row.id.source_start as i64,
                    row.id.source_end as i64,
                    row.id.item_index as i64,
                    next_attempt_at_ms,
                    now_ms,
                    error,
                ],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    fn delete_delivered_historian_side_channels(
        &self,
        session_id: &str,
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "DELETE FROM mc_historian_side_channel_outbox
                  WHERE session_id = ?1 AND delivered_at_ms IS NOT NULL",
                params![session_id],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    fn delete_delivered_historian_side_channel(
        &self,
        row: &HistorianSideChannelOutboxRow,
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "DELETE FROM mc_historian_side_channel_outbox
                  WHERE session_id = ?1 AND firing_seq = ?2 AND kind = ?3
                    AND source_start = ?4 AND source_end = ?5 AND item_index = ?6
                    AND delivered_at_ms IS NOT NULL",
                params![
                    row.session_id,
                    row.id.firing_seq as i64,
                    row.id.kind,
                    row.id.source_start as i64,
                    row.id.source_end as i64,
                    row.id.item_index as i64,
                ],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    pub fn load_compartment_events(
        &self,
        session_id: &str,
    ) -> Result<Vec<HistorianEventCandidate>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT kind, at_compartment, compartment_id, fields_json, created_at, harness
                   FROM mc_compartment_events
                  WHERE session_id = ?1 ORDER BY id",
            )?;
            let rows = stmt.query_map(params![session_id], |row| {
                Ok(HistorianEventCandidate {
                    kind: row.get(0)?,
                    at_compartment: row.get::<_, Option<i64>>(1)?.map(|v| v as u64),
                    compartment_id: row.get::<_, Option<i64>>(2)?.map(|v| v as u64),
                    fields_json: row.get(3)?,
                    created_at: row.get(4)?,
                    harness: row.get(5)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })?)
    }

    pub fn load_primer_candidates(
        &self,
        session_id: &str,
    ) -> Result<Vec<HistorianPrimerCandidate>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT project_path, session_id, question, source_compartment_start,
                        source_compartment_end, source_start_message_id, source_end_message_id,
                        source_message_time, created_at
                   FROM mc_primer_candidates
                  WHERE session_id = ?1 ORDER BY id",
            )?;
            let rows = stmt.query_map(params![session_id], |row| {
                Ok(HistorianPrimerCandidate {
                    project_path: row.get(0)?,
                    session_id: row.get(1)?,
                    question: row.get(2)?,
                    source_compartment_start: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                    source_compartment_end: row.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                    source_start_message_id: row.get(5)?,
                    source_end_message_id: row.get(6)?,
                    source_message_time: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })?)
    }

    pub fn load_user_memory_candidates(
        &self,
        session_id: &str,
    ) -> Result<Vec<HistorianUserMemoryCandidate>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT content, session_id, source_compartment_start,
                        source_compartment_end, created_at
                   FROM mc_user_memory_candidates
                  WHERE session_id = ?1 ORDER BY id",
            )?;
            let rows = stmt.query_map(params![session_id], |row| {
                Ok(HistorianUserMemoryCandidate {
                    content: row.get(0)?,
                    session_id: row.get(1)?,
                    source_compartment_start: row.get::<_, Option<i64>>(2)?.map(|v| v as u64),
                    source_compartment_end: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                    created_at: row.get(4)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })?)
    }

    /// `expires_at = NULL` means the row never expires; `expires_at <= now_ms` excludes the row.
    /// `importance DESC, id ASC` makes trimming retain the highest-importance rows deterministically.
    /// The caller supplies `now_ms` to fix the expiry cutoff for rendering and replay.
    /// Caller-supplied `now_ms` makes rendering and replay apply the same expiry cutoff.
    /// `now_ms` prevents replay from expiring a memory after the original render and changing the rendered bytes.
    pub fn load_compartment_candidates(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<StoredCompartmentSearchRow>, McStoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = self.inner.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT sequence, title, content, p1, p2, p3, p4, created_at
                   FROM mc_compartments
                  WHERE session_id = ?1
                  ORDER BY sequence DESC
                  LIMIT ?2",
            )?;
            let rows = statement
                .query_map(params![session_id, limit], |row| {
                    Ok(StoredCompartmentSearchRow {
                        sequence: row.get(0)?,
                        title: row.get(1)?,
                        content: row.get(2)?,
                        p1: row.get(3)?,
                        p2: row.get(4)?,
                        p3: row.get(5)?,
                        p4: row.get(6)?,
                        created_at: row.get(7)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        Ok(rows)
    }

    /// The query searches active, permanent memory visible to `project_path` with literal, case-insensitive SQL `LIKE`.
    /// Workspace visibility must use the shared visibility fence.
    /// The query searches the resolved session's compartment title and tier text with literal, case-insensitive SQL `LIKE`.
    /// The caller supplies the resolved session ID; this store layer does not route sessions.
    pub fn search_compartments_like(
        &self,
        session_id: &str,
        query: &str,
    ) -> Result<Vec<StoredCompartmentSearchRow>, McStoreError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let pattern = sql_like_pattern(query);
        let rows = self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT sequence, title, content, p1, p2, p3, p4, created_at
                   FROM mc_compartments
                  WHERE session_id = ?1
                    AND (LOWER(title) LIKE ?2 ESCAPE '\\'
                      OR LOWER(content) LIKE ?2 ESCAPE '\\'
                      OR LOWER(COALESCE(p1, '')) LIKE ?2 ESCAPE '\\'
                      OR LOWER(COALESCE(p2, '')) LIKE ?2 ESCAPE '\\'
                      OR LOWER(COALESCE(p3, '')) LIKE ?2 ESCAPE '\\'
                      OR LOWER(COALESCE(p4, '')) LIKE ?2 ESCAPE '\\')
                  ORDER BY sequence DESC
                  LIMIT 100",
            )?;
            let mapped = stmt
                .query_map(params![session_id, pattern], |r| {
                    Ok(StoredCompartmentSearchRow {
                        sequence: r.get(0)?,
                        title: r.get(1)?,
                        content: r.get(2)?,
                        p1: r.get(3)?,
                        p2: r.get(4)?,
                        p3: r.get(5)?,
                        p4: r.get(6)?,
                        created_at: r.get(7)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(mapped)
        })?;
        Ok(rows)
    }

    pub fn load_chunk_transcripts_for_range(
        &self,
        session_id: &str,
        start: i64,
        end: i64,
    ) -> Result<Vec<StoredChunkTranscript>, McStoreError> {
        self.load_chunk_transcripts_for_range_bounded(session_id, start, end, usize::MAX)
    }

    /// The `limit` bounds database reads and transcript decompression.
    /// rendering starts.
    pub fn load_chunk_transcripts_for_range_bounded(
        &self,
        session_id: &str,
        start: i64,
        end: i64,
        limit: usize,
    ) -> Result<Vec<StoredChunkTranscript>, McStoreError> {
        if limit == 0 || start > end {
            return Ok(Vec::new());
        }
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT compartment_seq, start_ordinal, end_ordinal, transcript_deflate,
                        raw_messages_deflate, created_at_ms
                   FROM mc_chunk_transcripts
                   WHERE session_id = ?1
                     AND end_ordinal >= ?2
                     AND start_ordinal <= ?3
                   ORDER BY compartment_seq ASC
                   LIMIT ?4",
            )?;
            let mapped = stmt
                .query_map(params![session_id, start, end, limit], |r| {
                    let transcript_blob: Vec<u8> = r.get(3)?;
                    let raw_messages_blob: Option<Vec<u8>> = r.get(4)?;
                    Ok(StoredChunkTranscript {
                        compartment_seq: r.get(0)?,
                        start_ordinal: r.get(1)?,
                        end_ordinal: r.get(2)?,
                        transcript: decompress_transcript(&transcript_blob).ok(),
                        raw_messages_json: raw_messages_blob
                            .as_deref()
                            .and_then(|blob| decompress_raw_messages(blob).ok()),
                        created_at_ms: r.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(mapped)
        })?;
        Ok(rows)
    }

    pub fn load_chunk_transcript_for_message(
        &self,
        session_id: &str,
        ordinal: i64,
    ) -> Result<Option<StoredChunkTranscript>, McStoreError> {
        Ok(self
            .load_chunk_transcripts_for_range(session_id, ordinal, ordinal)?
            .into_iter()
            .next())
    }

    fn note_by_id(&self, note_id: i64) -> Result<Option<StoredNote>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    &format!("SELECT {NOTE_SELECT_COLUMNS} FROM mc_notes WHERE id = ?1"),
                    params![note_id],
                    stored_note_from_row,
                )
                .optional()
            })
            .map_err(Into::into)
    }

    fn require_note_project(&self, project_path: &str, note_id: i64) -> Result<(), McStoreError> {
        if let Some(note) = self.note_by_id(note_id)? {
            if note.project_path != project_path {
                return Err(McStoreError::NoteOwnershipMismatch {
                    id: note_id,
                    project: project_path.to_string(),
                });
            }
        }
        Ok(())
    }

    /// The lookup uses the facade's project/session visibility fence.
    /// Smart notes are project-visible across sessions; session notes require matching provenance.
    /// The SQL predicate keeps this lookup independent of page size.
    pub fn get_note_by_id(
        &self,
        project_path: &str,
        session_id: &str,
        note_id: i64,
    ) -> Result<Option<StoredNote>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    &format!(
                        "SELECT {NOTE_SELECT_COLUMNS} FROM mc_notes
                         WHERE id = ?1 AND project_path = ?2
                           AND (type = 'smart' OR session_id = ?3)"
                    ),
                    params![note_id, project_path, session_id],
                    stored_note_from_row,
                )
                .optional()
            })
            .map_err(Into::into)
    }

    /// A session sees all project smart notes and its ordinary notes; SQL enforces ownership and pagination.
    pub fn read_visible_notes(
        &self,
        project_path: &str,
        session_id: &str,
        statuses: &[&str],
        limit: usize,
        offset: usize,
    ) -> Result<Vec<StoredNote>, McStoreError> {
        let limit = i64::try_from(limit.clamp(1, 1000))
            .map_err(|_| McStoreError::Serde("note limit exceeds i64".to_string()))?;
        let offset = i64::try_from(offset)
            .map_err(|_| McStoreError::Serde("note offset exceeds i64".to_string()))?;
        let statuses = if statuses.is_empty() {
            vec!["active"]
        } else {
            statuses.to_vec()
        };
        let placeholders = std::iter::repeat_n("?", statuses.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {NOTE_SELECT_COLUMNS} FROM mc_notes
             WHERE project_path = ? AND status IN ({placeholders})
               AND (type = 'smart' OR session_id = ?)
             ORDER BY updated_at_ms DESC, id DESC LIMIT ? OFFSET ?"
        );
        self.inner
            .with_conn(|conn| {
                let mut stmt = conn.prepare_cached(&sql)?;
                let mut values = Vec::with_capacity(statuses.len() + 3);
                values.push(SqlValue::Text(project_path.to_string()));
                for status in &statuses {
                    values.push(SqlValue::Text((*status).to_string()));
                }
                values.push(SqlValue::Text(session_id.to_string()));
                values.push(SqlValue::Integer(limit));
                values.push(SqlValue::Integer(offset));
                let rows = stmt
                    .query_map(rusqlite::params_from_iter(values), stored_note_from_row)?
                    .collect::<Result<Vec<_>, _>>();
                rows
            })
            .map_err(Into::into)
    }

    pub fn insert_note(&self, input: NoteInput<'_>) -> Result<StoredNote, McStoreError> {
        if let Some(route_project_root) = input.route_project_root {
            self.enforce_facade_project_vocabulary(
                route_project_root,
                input.project_path,
                "notes",
            )?;
        }
        let content = input.content.trim();
        if content.is_empty() {
            return Err(McStoreError::Serde(
                "note content must not be empty".to_string(),
            ));
        }
        self.with_note_conn_fenced(input.project_path, |tx| {
            tx.execute(
                "INSERT INTO mc_notes
                 (type, project_path, session_id, content, status, surface_condition,
                  anchor_block_id, harness, created_at_ms, updated_at_ms)
                 VALUES ('session', ?1, ?2, ?3, 'active', ?4, ?5, 'module', ?6, ?6)",
                params![
                    input.project_path,
                    input.session_id,
                    content,
                    input.surface_condition,
                    input.anchor_block_id,
                    input.now_ms,
                ],
            )?;
            load_note_tx(tx, tx.last_insert_rowid())
        })
    }

    pub fn insert_project_note(
        &self,
        input: NoteWriteInput<'_>,
    ) -> Result<StoredNote, McStoreError> {
        if let Some(route_project_root) = input.route_project_root {
            self.enforce_facade_project_vocabulary(
                route_project_root,
                input.project_path,
                "notes",
            )?;
        }
        let content = input.content.trim();
        if content.is_empty() {
            return Err(McStoreError::Serde(
                "note content must not be empty".to_string(),
            ));
        }
        let status = if input
            .surface_condition
            .is_some_and(|condition| !condition.trim().is_empty())
        {
            "pending"
        } else {
            "active"
        };
        self.with_note_conn_fenced(input.project_path, |tx| {
            tx.execute(
                "INSERT INTO mc_notes
                 (type, project_path, session_id, content, status, surface_condition,
                  anchor_block_id, anchor_ordinal, harness, compiled_provider, compiled_config,
                  compiled_at, compile_status, created_at_ms, updated_at_ms)
                 VALUES ('smart', ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'module', ?8, ?9, ?10, ?11, ?12, ?12)",
                params![
                    input.project_path,
                    input.session_id,
                    content,
                    status,
                    input
                        .surface_condition
                        .map(str::trim)
                        .filter(|value| !value.is_empty()),
                    input.anchor_block_id,
                    input.anchor_ordinal,
                    input.compiled_provider,
                    input.compiled_config,
                    input.compiled_at,
                    input.compile_status,
                    input.now_ms,
                ],
            )?;
            load_note_tx(tx, tx.last_insert_rowid())
        })
    }

    pub fn read_notes(
        &self,
        project_path: &str,
        session_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<StoredNote>, McStoreError> {
        self.read_project_notes(project_path, Some(session_id), &["active"], limit, offset)
    }

    /// The query selects project-owned notes by project ownership, not `session_id`.
    /// `session_id` remains an optional provenance filter only for the legacy session-note view.
    pub fn read_project_notes(
        &self,
        project_path: &str,
        session_id: Option<&str>,
        statuses: &[&str],
        limit: usize,
        offset: usize,
    ) -> Result<Vec<StoredNote>, McStoreError> {
        let limit = i64::try_from(limit.clamp(1, 1000))
            .map_err(|_| McStoreError::Serde("note limit exceeds i64".to_string()))?;
        let offset = i64::try_from(offset)
            .map_err(|_| McStoreError::Serde("note offset exceeds i64".to_string()))?;
        let statuses = if statuses.is_empty() {
            vec!["active"]
        } else {
            statuses.to_vec()
        };
        let placeholders = std::iter::repeat_n("?", statuses.len())
            .collect::<Vec<_>>()
            .join(", ");
        let session_clause = if session_id.is_some() {
            " AND type = 'session' AND session_id = ?"
        } else {
            ""
        };
        let sql = format!(
            "SELECT {NOTE_SELECT_COLUMNS} FROM mc_notes
             WHERE project_path = ? AND status IN ({placeholders}){session_clause}
             ORDER BY updated_at_ms DESC, id DESC LIMIT ? OFFSET ?"
        );
        self.inner
            .with_conn(|conn| {
                let mut stmt = conn.prepare_cached(&sql)?;
                let mut values: Vec<SqlValue> = Vec::with_capacity(statuses.len() + 4);
                values.push(SqlValue::Text(project_path.to_string()));
                for status in &statuses {
                    values.push(SqlValue::Text((*status).to_string()));
                }
                if let Some(session_id) = session_id {
                    values.push(SqlValue::Text(session_id.to_string()));
                }
                values.push(SqlValue::Integer(limit));
                values.push(SqlValue::Integer(offset));
                let rows = stmt
                    .query_map(rusqlite::params_from_iter(values), stored_note_from_row)?
                    .collect::<Result<Vec<_>, _>>();
                rows
            })
            .map_err(Into::into)
    }

    pub fn read_smart_notes(
        &self,
        project_path: &str,
        statuses: &[&str],
        limit: usize,
        offset: usize,
    ) -> Result<Vec<StoredNote>, McStoreError> {
        let limit = i64::try_from(limit.clamp(1, 1000))
            .map_err(|_| McStoreError::Serde("note limit exceeds i64".to_string()))?;
        let offset = i64::try_from(offset)
            .map_err(|_| McStoreError::Serde("note offset exceeds i64".to_string()))?;
        let statuses = if statuses.is_empty() {
            vec!["active"]
        } else {
            statuses.to_vec()
        };
        let placeholders = std::iter::repeat_n("?", statuses.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {NOTE_SELECT_COLUMNS} FROM mc_notes
             WHERE project_path = ? AND type = 'smart' AND status IN ({placeholders})
             ORDER BY updated_at_ms DESC, id DESC LIMIT ? OFFSET ?"
        );
        self.inner
            .with_conn(|conn| {
                let mut statement = conn.prepare_cached(&sql)?;
                let mut values: Vec<SqlValue> = Vec::with_capacity(statuses.len() + 3);
                values.push(SqlValue::Text(project_path.to_string()));
                for status in statuses {
                    values.push(SqlValue::Text(status.to_string()));
                }
                values.push(SqlValue::Integer(limit));
                values.push(SqlValue::Integer(offset));
                let rows = statement
                    .query_map(rusqlite::params_from_iter(values), stored_note_from_row)?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .map_err(Into::into)
    }

    pub fn count_notes_by_type(
        &self,
        project_path: &str,
        type_name: &str,
        session_id: Option<&str>,
        statuses: &[&str],
    ) -> Result<usize, McStoreError> {
        if !matches!(type_name, "session" | "smart") {
            return Err(McStoreError::Serde("invalid note type".to_string()));
        }
        let statuses = if statuses.is_empty() {
            vec!["active"]
        } else {
            statuses.to_vec()
        };
        let placeholders = std::iter::repeat_n("?", statuses.len())
            .collect::<Vec<_>>()
            .join(", ");
        let session_clause = if session_id.is_some() {
            " AND session_id = ?"
        } else {
            ""
        };
        let sql = format!(
            "SELECT COUNT(*) FROM mc_notes WHERE project_path = ? AND type = ? AND status IN ({placeholders}){session_clause}"
        );
        self.inner
            .with_conn(|conn| {
                let mut values: Vec<SqlValue> = Vec::with_capacity(statuses.len() + 3);
                values.push(SqlValue::Text(project_path.to_string()));
                values.push(SqlValue::Text(type_name.to_string()));
                for status in statuses {
                    values.push(SqlValue::Text(status.to_string()));
                }
                if let Some(session_id) = session_id {
                    values.push(SqlValue::Text(session_id.to_string()));
                }
                conn.query_row(&sql, rusqlite::params_from_iter(values), |row| {
                    row.get::<_, i64>(0)
                })
            })
            .map_err(Into::into)
            .and_then(|count| {
                usize::try_from(count)
                    .map_err(|_| McStoreError::Serde("note count exceeds usize".to_string()))
            })
    }

    pub fn update_note_content(
        &self,
        project_path: &str,
        session_id: &str,
        note_id: i64,
        content: &str,
        now_ms: i64,
    ) -> Result<Option<StoredNote>, McStoreError> {
        let current = self.get_note_by_id(project_path, session_id, note_id)?;
        let current = current.filter(|note| {
            matches!(
                note.status.as_str(),
                "active" | "pending" | "ready" | "surfacing" | "surfaced"
            )
        });
        let Some(current) = current else {
            return Ok(None);
        };
        match self.update_note_cas(
            project_path,
            note_id,
            &current.status,
            current.status_version,
            Some(content),
            None,
            None,
            now_ms,
        )? {
            NoteCasOutcome::Applied(note) => Ok(Some(note)),
            NoteCasOutcome::Conflict { .. } => Ok(None),
        }
    }

    /// The update changes content or condition only when status and revision match the caller's snapshot; changing the condition clears compiled evaluation state.
    #[allow(clippy::too_many_arguments)]
    pub fn update_note_cas(
        &self,
        project_path: &str,
        note_id: i64,
        expected_status: &str,
        expected_version: i64,
        content: Option<&str>,
        surface_condition: Option<Option<&str>>,
        condition_compile: Option<NoteConditionCompile<'_>>,
        now_ms: i64,
    ) -> Result<NoteCasOutcome, McStoreError> {
        self.require_note_project(project_path, note_id)?;
        let result = self.with_note_conn_fenced(project_path, |tx| {
            let current = load_note_tx(tx, note_id).optional()?;
            let Some(current) = current else {
                return Ok(NoteCasOutcome::Conflict { current: None });
            };
            if current.project_path != project_path {
                return Ok(NoteCasOutcome::Conflict {
                    current: Some(current),
                });
            }
            if current.status != expected_status || current.status_version != expected_version {
                return Ok(NoteCasOutcome::Conflict {
                    current: Some(current),
                });
            }
            let next_content = content.map(str::trim).unwrap_or(&current.content);
            if next_content.is_empty() {
                return Ok(NoteCasOutcome::Conflict {
                    current: Some(current),
                });
            }
            let next_condition = surface_condition
                .flatten()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let current_condition = current
                .surface_condition
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            // Re-supplying an unchanged condition does not invalidate the compiled artifact, reset a ready note to pending, or fence active claims.
            let condition_changed =
                surface_condition.is_some() && next_condition != current_condition;
            let content_changed = next_content != current.content;
            let compiler_edit = condition_changed || content_changed;
            if !compiler_edit {
                // An unchanged update does not bump versions because a version bump fences an active evaluation claim.
                return Ok(NoteCasOutcome::Applied(current));
            }
            let remaining_condition = if condition_changed {
                next_condition
            } else {
                current_condition
            };
            let next_status = if compiler_edit && remaining_condition.is_some() {
                "pending"
            } else {
                current.status.as_str()
            };
            let compile = condition_compile.unwrap_or_default();
            let changed = tx.execute(
                NOTE_CAS_UPDATE_SQL,
                params![
                    next_content,
                    condition_changed,
                    next_condition,
                    next_status,
                    compiler_edit,
                    now_ms,
                    compile.compiled_provider,
                    compile.compiled_config,
                    compile.compiled_at,
                    compile.compile_status,
                    note_id,
                    project_path,
                    expected_status,
                    expected_version,
                ],
            )?;
            if changed == 0 {
                return Ok(NoteCasOutcome::Conflict {
                    current: load_note_tx(tx, note_id).optional()?,
                });
            }
            if compiler_edit {
                fence_active_note_claims_tx(tx, project_path, Some(note_id), "stale", now_ms)?;
            }
            Ok(NoteCasOutcome::Applied(load_note_tx(tx, note_id)?))
        })?;
        Ok(result)
    }

    pub fn dismiss_note(
        &self,
        project_path: &str,
        session_id: &str,
        note_id: i64,
        resolution: Option<&str>,
        now_ms: i64,
    ) -> Result<Option<StoredNote>, McStoreError> {
        if self
            .get_note_by_id(project_path, session_id, note_id)?
            .is_none()
        {
            return Ok(None);
        }
        let resolution = resolution.map(str::trim).filter(|value| !value.is_empty());
        self.with_note_conn_fenced(project_path, |tx| {
            let Some(current) = load_note_tx(tx, note_id).optional()? else {
                return Ok(None);
            };
            if current.project_path != project_path
                || !matches!(
                    current.status.as_str(),
                    "active" | "pending" | "ready" | "surfacing" | "surfaced"
                )
            {
                return Ok(None);
            }
            let content = resolution
                .map(|value| format!("{}\n\nResolution: {value}", current.content))
                .unwrap_or_else(|| current.content.clone());
            let changed = tx.execute(
                "UPDATE mc_notes
                    SET status = 'dismissed', content = ?1,
                        status_version = status_version + 1, state_version = state_version + 1,
                        updated_at_ms = ?2,
                        dismissed_at = ?2, dismissal_resolution = ?3
                  WHERE id = ?4 AND project_path = ?5
                    AND status = ?6 AND status_version = ?7",
                params![
                    content,
                    now_ms,
                    resolution,
                    note_id,
                    project_path,
                    current.status,
                    current.status_version,
                ],
            )?;
            if changed == 0 {
                return Ok(None);
            }
            fence_active_note_claims_tx(tx, project_path, Some(note_id), "stale", now_ms)?;
            Ok(Some(load_note_tx(tx, note_id)?))
        })
    }

    pub fn dismiss_note_cas(
        &self,
        project_path: &str,
        note_id: i64,
        expected_status: &str,
        expected_version: i64,
        resolution: Option<&str>,
        now_ms: i64,
    ) -> Result<NoteCasOutcome, McStoreError> {
        self.require_note_project(project_path, note_id)?;
        let outcome = self.transition_note_internal(
            project_path,
            note_id,
            expected_status,
            expected_version,
            "dismissed",
            resolution,
            now_ms,
        )?;
        if let NoteCasOutcome::Conflict {
            current: Some(current),
        } = &outcome
        {
            if current.status != "dismissed" {
                return self.transition_note_internal(
                    project_path,
                    note_id,
                    &current.status,
                    current.status_version,
                    "dismissed",
                    resolution,
                    now_ms,
                );
            }
        }
        Ok(outcome)
    }

    pub fn write_note_evaluation(
        &self,
        input: NoteEvaluationInput<'_>,
    ) -> Result<NoteCasOutcome, McStoreError> {
        self.require_note_project(input.project_path, input.note_id)?;
        self.with_note_conn_fenced(input.project_path, |tx| {
            let Some(current) = load_note_tx(tx, input.note_id).optional()? else {
                return Ok(NoteCasOutcome::Conflict { current: None });
            };
            if current.project_path != input.project_path
                || current.status != "pending"
                || current.status_version != input.source_revision
            {
                return Ok(NoteCasOutcome::Conflict { current: Some(current) });
            }
            let status = if input.verdict { "ready" } else { "pending" };
            tx.execute(
                "UPDATE mc_notes SET status = ?1, status_version = status_version + 1,
                    state_version = state_version + 1,
                    updated_at_ms = ?2, ready_at = CASE WHEN ?1 = 'ready' THEN ?2 ELSE ready_at END,
                    ready_reason = CASE WHEN ?1 = 'ready' THEN 'condition_true' ELSE ready_reason END,
                    compiled_check = ?3, manifest_json = ?4, check_hash = ?5,
                    check_next_due_at = ?6, last_checked_at = ?2,
                    check_status = CASE WHEN ?1 = 'ready' THEN 'true' ELSE 'false' END
                  WHERE id = ?7 AND project_path = ?8 AND status = 'pending' AND status_version = ?9",
                params![
                    status,
                    input.now_ms,
                    input.compiled_check,
                    input.manifest_json,
                    input.check_hash,
                    input.next_due_at,
                    input.note_id,
                    input.project_path,
                    input.source_revision,
                ],
            )?;
            Ok(NoteCasOutcome::Applied(load_note_tx(tx, input.note_id)?))
        })
    }

    pub fn transition_note(
        &self,
        input: NoteTransitionInput<'_>,
    ) -> Result<NoteCasOutcome, McStoreError> {
        self.transition_note_internal(
            input.project_path,
            input.note_id,
            input.from_status,
            input.source_revision,
            input.to_status,
            input.result,
            input.now_ms,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn transition_note_internal(
        &self,
        project_path: &str,
        note_id: i64,
        expected_status: &str,
        expected_version: i64,
        to_status: &str,
        result: Option<&str>,
        now_ms: i64,
    ) -> Result<NoteCasOutcome, McStoreError> {
        self.require_note_project(project_path, note_id)?;
        if !matches!(
            to_status,
            "active" | "pending" | "ready" | "surfacing" | "surfaced" | "dismissed"
        ) {
            return Err(McStoreError::Serde(format!(
                "invalid note transition target {to_status}"
            )));
        }
        self.with_note_conn_fenced(project_path, |tx| {
            let Some(current) = load_note_tx(tx, note_id).optional()? else {
                return Ok(NoteCasOutcome::Conflict { current: None });
            };
            if current.project_path != project_path
                || current.status != expected_status
                || current.status_version != expected_version
            {
                return Ok(NoteCasOutcome::Conflict { current: Some(current) });
            }
            tx.execute(
                "UPDATE mc_notes SET status = ?1, status_version = status_version + 1,
                    state_version = state_version + 1,
                    updated_at_ms = ?2,
                    ready_at = CASE WHEN ?1 = 'ready' THEN COALESCE(ready_at, ?2) ELSE ready_at END,
                    ready_reason = CASE WHEN ?1 = 'ready' THEN COALESCE(?3, ready_reason) ELSE ready_reason END,
                    dismissed_at = CASE WHEN ?1 = 'dismissed' THEN ?2 ELSE dismissed_at END,
                    dismissal_resolution = CASE WHEN ?1 = 'dismissed' THEN ?3 ELSE dismissal_resolution END
                  WHERE id = ?4 AND project_path = ?5 AND status = ?6 AND status_version = ?7",
                params![to_status, now_ms, result, note_id, project_path, expected_status, expected_version],
            )?;
            Ok(NoteCasOutcome::Applied(load_note_tx(tx, note_id)?))
        })
    }

    pub fn claim_due_note(
        &self,
        project_path: &str,
        now_ms: i64,
    ) -> Result<Option<StoredNote>, McStoreError> {
        self.with_note_conn_fenced(project_path, |tx| {
            let note = tx
                .query_row(
                    &format!(
                        "SELECT {NOTE_SELECT_COLUMNS} FROM mc_notes
                         WHERE project_path = ?1 AND type = 'smart' AND status = 'pending'
                           AND (check_next_due_at IS NULL OR check_next_due_at <= ?2)
                           AND (check_quarantined_until IS NULL OR check_quarantined_until <= ?2)
                         ORDER BY COALESCE(check_next_due_at, 0), id LIMIT 1"
                    ),
                    params![project_path, now_ms],
                    stored_note_from_row,
                )
                .optional()?;
            let Some(note) = note else { return Ok(None) };
            let changed = tx.execute(
                "UPDATE mc_notes SET status_version = status_version + 1,
                    state_version = state_version + 1, updated_at_ms = ?1
                   WHERE id = ?2 AND project_path = ?3 AND status = 'pending' AND status_version = ?4",
                params![now_ms, note.id, project_path, note.status_version],
            )?;
            if changed == 0 { return Ok(None); }
            tx.query_row(
                &format!("SELECT {NOTE_SELECT_COLUMNS} FROM mc_notes WHERE id = ?1"),
                params![note.id],
                stored_note_from_row,
            ).map(Some)
        })
    }

    pub fn claim_note_delivery(
        &self,
        project_path: &str,
        session_id: &str,
        delivered_pass_fingerprint: &str,
        transform_pass_id: &str,
        now_ms: i64,
    ) -> Result<Vec<(StoredNote, NoteDelivery)>, McStoreError> {
        self.with_note_conn_fenced(project_path, |tx| {
            let notes = {
                let mut stmt = tx.prepare_cached(&format!(
                    "SELECT {NOTE_SELECT_COLUMNS} FROM mc_notes
                     WHERE project_path = ?1 AND type = 'smart' AND
                       (status = 'ready' OR status = 'surfacing' OR status = 'surfaced')
                     ORDER BY updated_at_ms ASC, id ASC"
                ))?;
                let rows = stmt
                    .query_map(params![project_path], stored_note_from_row)?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let mut candidates = Vec::new();
            for note in notes {
                let unacked = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM mc_note_deliveries
                       WHERE project_path = ?1 AND note_id = ?2 AND session_id = ?3 AND disposition IS NULL)",
                    params![project_path, note.id, session_id],
                    |r| r.get::<_, i64>(0),
                )? != 0;
                if note.status == "surfaced" && !unacked {
                    continue;
                }
                let existing = tx
                    .query_row(
                        "SELECT delivery_id, transform_pass_id, acked_at
                           FROM mc_note_deliveries
                          WHERE project_path = ?1 AND note_id = ?2 AND session_id = ?3
                            AND delivered_pass_fingerprint = ?4 AND disposition IS NULL",
                        params![project_path, note.id, session_id, delivered_pass_fingerprint],
                        |r| {
                            Ok(NoteDelivery {
                                delivery_id: r.get(0)?,
                                note_id: note.id,
                                session_id: session_id.to_string(),
                                delivered_pass_fingerprint: delivered_pass_fingerprint.to_string(),
                                transform_pass_id: r.get(1)?,
                                acked_at: r.get(2)?,
                            })
                        },
                    )
                    .optional()?;
                if let Some(delivery) = existing {
                    if delivery.acked_at.is_none() {
                        candidates.push((note, delivery));
                    }
                    continue;
                }
                if note.status == "ready" {
                    let changed = tx.execute(
                        "UPDATE mc_notes SET status = 'surfacing', status_version = status_version + 1,
                            state_version = state_version + 1,
                            updated_at_ms = ?1
                          WHERE id = ?2 AND project_path = ?3 AND status = 'ready' AND status_version = ?4",
                        params![now_ms, note.id, project_path, note.status_version],
                    )?;
                    if changed == 0 {
                        continue;
                    }
                }
                let delivery_id = format!(
                    "{}:{project_path}:{}:{session_id}:{transform_pass_id}:{}",
                    project_path.len(),
                    session_id.len(),
                    note.id
                );
                tx.execute(
                    "INSERT INTO mc_note_deliveries
                       (delivery_id, note_id, session_id, delivered_pass_fingerprint,
                        transform_pass_id, created_at_ms, project_path)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        delivery_id,
                        note.id,
                        session_id,
                        delivered_pass_fingerprint,
                        transform_pass_id,
                        now_ms,
                        project_path
                    ],
                )?;
                let stored = load_note_tx(tx, note.id)?;
                candidates.push((
                    stored,
                    NoteDelivery {
                        delivery_id,
                        note_id: note.id,
                        session_id: session_id.to_string(),
                        delivered_pass_fingerprint: delivered_pass_fingerprint.to_string(),
                        transform_pass_id: transform_pass_id.to_string(),
                        acked_at: None,
                    },
                ));
            }
            Ok(candidates)
        })
    }

    pub fn ack_note_delivery(
        &self,
        project_path: &str,
        session_id: &str,
        transform_pass_id: &str,
        now_ms: i64,
    ) -> Result<usize, McStoreError> {
        self.with_note_conn_fenced(project_path, |tx| {
            let ids = tx
                .prepare(
                    "SELECT DISTINCT note_id FROM mc_note_deliveries
                       WHERE project_path = ?1 AND session_id = ?2 AND transform_pass_id = ?3
                         AND disposition IS NULL",
                )?
                .query_map(
                    params![project_path, session_id, transform_pass_id],
                    |row| row.get::<_, i64>(0),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            let changed = tx.execute(
                "UPDATE mc_note_deliveries SET acked_at = ?1, disposition = 'acked'
                   WHERE project_path = ?2 AND session_id = ?3 AND transform_pass_id = ?4
                     AND disposition IS NULL",
                params![now_ms, project_path, session_id, transform_pass_id],
            )?;
            for id in ids {
                tx.execute(
                    "UPDATE mc_note_deliveries SET disposition = 'superseded'
                       WHERE project_path = ?1 AND note_id = ?2 AND session_id = ?3
                         AND disposition IS NULL",
                    params![project_path, id, session_id],
                )?;
                tx.execute(
                    "UPDATE mc_notes SET status = 'surfaced', status_version = status_version + 1,
                        state_version = state_version + 1, updated_at_ms = ?1
                      WHERE id = ?2 AND project_path = ?3 AND status IN ('surfacing', 'surfaced')",
                    params![now_ms, id, project_path],
                )?;
            }
            Ok(changed)
        })
    }

    pub fn nack_note_delivery(
        &self,
        project_path: &str,
        session_id: &str,
        transform_pass_id: &str,
        now_ms: i64,
    ) -> Result<usize, McStoreError> {
        self.with_note_conn_fenced(project_path, |tx| {
            let ids = tx
                .prepare(
                    "SELECT DISTINCT note_id FROM mc_note_deliveries
                       WHERE project_path = ?1 AND session_id = ?2 AND transform_pass_id = ?3
                         AND disposition IS NULL",
                )?
                .query_map(params![project_path, session_id, transform_pass_id], |r| {
                    r.get::<_, i64>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let changed = tx.execute(
                "UPDATE mc_note_deliveries SET disposition = 'nacked'
                   WHERE project_path = ?1 AND session_id = ?2 AND transform_pass_id = ?3
                     AND disposition IS NULL",
                params![project_path, session_id, transform_pass_id],
            )?;
            for id in &ids {
                tx.execute(
                    "UPDATE mc_notes SET status = 'ready', status_version = status_version + 1,
                        state_version = state_version + 1, updated_at_ms = ?1
                      WHERE id = ?2 AND project_path = ?3 AND status IN ('surfacing', 'surfaced')",
                    params![now_ms, id, project_path],
                )?;
            }
            Ok(changed)
        })
    }

    pub fn search_notes_like(
        &self,
        project_path: &str,
        session_id: &str,
        query: &str,
    ) -> Result<Vec<StoredNoteSearchRow>, McStoreError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let pattern = sql_like_pattern(query);
        let rows = self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, content, status, surface_condition, updated_at_ms
                   FROM mc_notes
                  WHERE project_path = ?1
                    AND (type = 'smart' OR session_id = ?3)
                    AND (LOWER(content) LIKE ?2 ESCAPE '\\'
                      OR LOWER(COALESCE(surface_condition, '')) LIKE ?2 ESCAPE '\\')
                  ORDER BY updated_at_ms DESC, id DESC
                  LIMIT 100",
            )?;
            let mapped = stmt
                .query_map(params![project_path, pattern, session_id], |r| {
                    Ok(StoredNoteSearchRow {
                        id: r.get(0)?,
                        content: r.get(1)?,
                        status: r.get(2)?,
                        surface_condition: r.get(3)?,
                        updated_at_ms: r.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(mapped)
        })?;
        Ok(rows)
    }

    pub fn load_active_user_memories(&self) -> Result<Vec<String>, McStoreError> {
        let rows = self.inner.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT content FROM mc_user_memories WHERE status = 'active'
                 ORDER BY promoted_at ASC, id ASC",
            )?;
            let mapped = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(mapped)
        })?;
        Ok(rows)
    }

    pub fn seed_workspace_member(
        &self,
        workspace: &str,
        project_path: &str,
        share_categories_json: &str,
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "INSERT INTO mc_workspaces (name, share_categories) VALUES (?1, ?2)
                 ON CONFLICT(name) DO NOTHING",
                params![workspace, share_categories_json],
            )?;
            let ws_id: i64 = tx.query_row(
                "SELECT id FROM mc_workspaces WHERE name = ?1",
                params![workspace],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO mc_workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                 VALUES (?1, ?2, ?2, ?2, 0)",
                params![ws_id, project_path],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    ///
    pub fn stage_claim_intent(
        &self,
        route_project_root: &str,
        binding: &ClaimIntentBinding,
        command: &ClaimCommandIdentity,
        request: &Value,
        now_ms: i64,
    ) -> Result<ClaimIntentMutationOutcome, McStoreError> {
        validate_claim_intent_fields(binding, command)?;
        let request_digest = compute_claim_operation_request_digest(request)
            .map_err(|error| McStoreError::ClaimIntentInvalid(error.to_string()))?;
        let authority_generation = i64::try_from(binding.authority_generation).map_err(|_| {
            McStoreError::ClaimIntentInvalid("authority generation exceeds SQLite i64".to_string())
        })?;
        let outcome = self.inner.with_conn_fenced(|tx| {
            let existing = tx
                .query_row(
                    &format!(
                        "SELECT {CLAIM_INTENT_COLUMNS} FROM mc_claim_intents
                          WHERE producer = ?1 AND operation_key = ?2"
                    ),
                    params![command.producer, command.operation_key],
                    claim_intent_record_from_row,
                )
                .optional()?;
            if let Some(record) = existing {
                if record.request_digest != request_digest {
                    return Ok(ClaimIntentTxnOutcome::IdentityConflict);
                }
                if let Err(McStoreError::ClaimIntentBindingMismatch {
                    field,
                    expected,
                    found,
                }) = require_claim_intent_binding(&record, binding)
                {
                    return Ok(ClaimIntentTxnOutcome::BindingMismatch {
                        field,
                        expected,
                        found,
                    });
                }
                if record.state == ClaimIntentState::Staged {
                    if let Some(rejection) =
                        claim_intent_stage_fence(tx, route_project_root, binding)?
                    {
                        return Ok(rejection);
                    }
                }
                return Ok(ClaimIntentTxnOutcome::Applied(ClaimIntentMutationOutcome {
                    record,
                    replayed: true,
                }));
            }

            if let Some(rejection) = claim_intent_stage_fence(tx, route_project_root, binding)? {
                return Ok(rejection);
            }
            tx.execute(
                "INSERT INTO mc_claim_intents(
                    producer, operation_key, database_incarnation_id, format_epoch,
                    authority_project, authority_generation, request_encoding_version,
                    request_digest, state, result_json, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'staged', NULL, ?9, ?9)",
                params![
                    command.producer,
                    command.operation_key,
                    binding.database_incarnation_id,
                    binding.format_epoch,
                    binding.authority_project,
                    authority_generation,
                    CLAIM_REQUEST_ENCODING_VERSION,
                    request_digest,
                    now_ms,
                ],
            )?;
            let record = tx.query_row(
                &format!(
                    "SELECT {CLAIM_INTENT_COLUMNS} FROM mc_claim_intents
                      WHERE producer = ?1 AND operation_key = ?2"
                ),
                params![command.producer, command.operation_key],
                claim_intent_record_from_row,
            )?;
            Ok(ClaimIntentTxnOutcome::Applied(ClaimIntentMutationOutcome {
                record,
                replayed: false,
            }))
        })?;
        claim_intent_mutation_result(outcome, command)
    }

    pub fn inspect_claim_intent(
        &self,
        command: &ClaimCommandIdentity,
    ) -> Result<Option<ClaimIntentRecord>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    &format!(
                        "SELECT {CLAIM_INTENT_COLUMNS} FROM mc_claim_intents
                          WHERE producer = ?1 AND operation_key = ?2"
                    ),
                    params![command.producer, command.operation_key],
                    claim_intent_record_from_row,
                )
                .optional()
            })
            .map_err(Into::into)
    }

    pub fn list_claim_intents(
        &self,
        unresolved_only: bool,
        limit: usize,
    ) -> Result<Vec<ClaimIntentRecord>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                let where_clause = if unresolved_only {
                    "WHERE state IN ('staged', 'context-committed')"
                } else {
                    ""
                };
                let sql = format!(
                    "SELECT {CLAIM_INTENT_COLUMNS} FROM mc_claim_intents
                     {where_clause}
                     ORDER BY created_at_ms, producer, operation_key LIMIT ?1"
                );
                let mut statement = conn.prepare_cached(&sql)?;
                let rows =
                    statement.query_map(params![limit as i64], claim_intent_record_from_row)?;
                rows.collect()
            })
            .map_err(Into::into)
    }

    pub fn acknowledge_claim_intent(
        &self,
        binding: &ClaimIntentBinding,
        command: &ClaimCommandIdentity,
        request_digest: &str,
        kind: ClaimIntentAckKind,
        result_json: Option<&str>,
        now_ms: i64,
    ) -> Result<ClaimIntentMutationOutcome, McStoreError> {
        validate_claim_intent_fields(binding, command)?;
        if !is_lower_hex(request_digest, 64) {
            return Err(McStoreError::ClaimIntentInvalid(
                "request digest must be 64 lowercase hex characters".to_string(),
            ));
        }
        match (kind, result_json) {
            (ClaimIntentAckKind::Acknowledged, None) => {}
            (ClaimIntentAckKind::Acknowledged, Some(_)) => {
                return Err(McStoreError::ClaimIntentInvalid(
                    "acknowledged transition must not supply result_json".to_string(),
                ));
            }
            (_, Some(result)) => validate_claim_result_json(result, kind)?,
            (_, None) => {
                return Err(McStoreError::ClaimIntentInvalid(
                    "result_json is required for this transition".to_string(),
                ));
            }
        }

        let outcome = self.inner.with_conn_fenced(|tx| {
            let Some(record) = tx
                .query_row(
                    &format!(
                        "SELECT {CLAIM_INTENT_COLUMNS} FROM mc_claim_intents
                          WHERE producer = ?1 AND operation_key = ?2"
                    ),
                    params![command.producer, command.operation_key],
                    claim_intent_record_from_row,
                )
                .optional()?
            else {
                return Ok(ClaimIntentTxnOutcome::NotFound);
            };
            if record.request_digest != request_digest {
                return Ok(ClaimIntentTxnOutcome::IdentityConflict);
            }
            if let Err(McStoreError::ClaimIntentBindingMismatch {
                field,
                expected,
                found,
            }) = require_claim_intent_binding(&record, binding)
            {
                return Ok(ClaimIntentTxnOutcome::BindingMismatch {
                    field,
                    expected,
                    found,
                });
            }

            let next_state = match (kind, record.state) {
                (ClaimIntentAckKind::ContextCommitted, ClaimIntentState::Staged) => {
                    Some(ClaimIntentState::ContextCommitted)
                }
                (ClaimIntentAckKind::TerminalRejected, ClaimIntentState::Staged) => {
                    Some(ClaimIntentState::TerminalRejected)
                }
                (ClaimIntentAckKind::Acknowledged, ClaimIntentState::ContextCommitted) => {
                    Some(ClaimIntentState::Acknowledged)
                }
                (ClaimIntentAckKind::Acknowledged, ClaimIntentState::Acknowledged)
                | (ClaimIntentAckKind::Acknowledged, ClaimIntentState::TerminalRejected) => None,
                (ClaimIntentAckKind::ContextCommitted, ClaimIntentState::ContextCommitted)
                | (ClaimIntentAckKind::ContextCommitted, ClaimIntentState::Acknowledged)
                | (ClaimIntentAckKind::TerminalRejected, ClaimIntentState::TerminalRejected)
                    if record.result_json.as_deref() == result_json =>
                {
                    None
                }
                _ => {
                    return Ok(ClaimIntentTxnOutcome::Transition {
                        expected: match kind {
                            ClaimIntentAckKind::ContextCommitted
                            | ClaimIntentAckKind::TerminalRejected => "staged",
                            ClaimIntentAckKind::Acknowledged => "context-committed",
                        }
                        .to_string(),
                        found: record.state.as_str().to_string(),
                    });
                }
            };
            if let Some(next_state) = next_state {
                tx.execute(
                    "UPDATE mc_claim_intents
                        SET state = ?1, result_json = COALESCE(?2, result_json), updated_at_ms = ?3
                      WHERE producer = ?4 AND operation_key = ?5",
                    params![
                        next_state.as_str(),
                        result_json,
                        now_ms,
                        command.producer,
                        command.operation_key,
                    ],
                )?;
                let record = tx.query_row(
                    &format!(
                        "SELECT {CLAIM_INTENT_COLUMNS} FROM mc_claim_intents
                          WHERE producer = ?1 AND operation_key = ?2"
                    ),
                    params![command.producer, command.operation_key],
                    claim_intent_record_from_row,
                )?;
                return Ok(ClaimIntentTxnOutcome::Applied(ClaimIntentMutationOutcome {
                    record,
                    replayed: false,
                }));
            }
            Ok(ClaimIntentTxnOutcome::Applied(ClaimIntentMutationOutcome {
                record,
                replayed: true,
            }))
        })?;
        claim_intent_mutation_result(outcome, command)
    }

    pub fn unresolved_claim_intent_count(&self) -> Result<usize, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM mc_claim_intents
                      WHERE state IN ('staged', 'context-committed')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .map(|count| count as usize)
            .map_err(Into::into)
    }

    pub fn begin_claim_store_rebuild(
        &self,
        database_incarnation_id: &str,
        authority_generation: u64,
        now_ms: i64,
    ) -> Result<(), McStoreError> {
        if !is_lower_hex(database_incarnation_id, 32) {
            return Err(McStoreError::ClaimIntentInvalid(
                "database incarnation ID must be 32 lowercase hex characters".to_string(),
            ));
        }
        let generation = i64::try_from(authority_generation).map_err(|_| {
            McStoreError::ClaimIntentInvalid("authority generation exceeds SQLite i64".to_string())
        })?;
        let outcome = self.inner.with_conn_fenced(|tx| {
            let unresolved: i64 = tx.query_row(
                "SELECT COUNT(*) FROM mc_claim_intents
                  WHERE state IN ('staged', 'context-committed')",
                [],
                |row| row.get(0),
            )?;
            if unresolved > 0 {
                return Ok(ClaimIntentTxnOutcome::ResetBlocked(unresolved as usize));
            }
            tx.execute(
                "INSERT INTO mc_claim_intent_controls(
                    id, database_incarnation_id, authority_generation,
                    transition_state, updated_at_ms
                 ) VALUES (1, ?1, ?2, 'resetting', ?3)
                 ON CONFLICT(id) DO UPDATE SET
                    database_incarnation_id = excluded.database_incarnation_id,
                    authority_generation = excluded.authority_generation,
                    transition_state = 'resetting', updated_at_ms = excluded.updated_at_ms",
                params![database_incarnation_id, generation, now_ms],
            )?;
            Ok(ClaimIntentTxnOutcome::ResetGranted)
        })?;
        match outcome {
            ClaimIntentTxnOutcome::ResetGranted => Ok(()),
            ClaimIntentTxnOutcome::ResetBlocked(unresolved) => {
                Err(McStoreError::ClaimIntentResetBlocked { unresolved })
            }
            _ => unreachable!("rebuild transaction returns only granted or blocked"),
        }
    }

    pub fn authority_status(
        &self,
        context_store_uuid: &str,
        project: &str,
        domain: &str,
    ) -> Result<Option<AuthorityRow>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )
                .optional()
            })
            .map_err(Into::into)
    }

    pub fn authority_begin_prepare(
        &self,
        context_store_uuid: &str,
        project: &str,
        domain: &str,
    ) -> Result<AuthorityRow, McStoreError> {
        validate_authority_domain(domain)?;
        self.with_note_conn_fenced(project, |tx| {
                tx.execute(
                    "INSERT INTO mc_authority(context_store_uuid, project, domain, state)
                     VALUES (?1, ?2, ?3, 'TS') ON CONFLICT(context_store_uuid, project, domain) DO NOTHING",
                    params![context_store_uuid, project, domain],
                )?;
                let current = tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )?;
                if current.state == "TS" {
                    if domain == "notes" {
                        tx.execute(
                            "DELETE FROM mc_notes WHERE context_store_uuid = ?1 AND project_path = ?2",
                            params![context_store_uuid, project],
                        )?;
                    }
                    tx.execute(
                        "DELETE FROM mc_authority_seed_rows WHERE context_store_uuid = ?1 AND project = ?2 AND domain = ?3",
                        params![context_store_uuid, project, domain],
                    )?;
                    if domain == "notes" {
                        fence_active_note_claims_tx(
                            tx,
                            project,
                            None,
                            "authority_changed",
                            current_time_ms(),
                        )?;
                    }
                    tx.execute(
                        "UPDATE mc_authority SET state = 'PREPARING', generation = generation + 1,
                                checksum_expected = NULL, checksum_actual = NULL, checksum_ok = NULL
                         WHERE context_store_uuid = ?1 AND project = ?2 AND domain = ?3",
                        params![context_store_uuid, project, domain],
                    )?;
                } else if current.state != "PREPARING" {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::State {
                            expected: "TS".to_string(),
                            found: current.state,
                        },
                    )));
                }
                let row = tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )?;
                if domain == "memories" {
                    set_claim_intent_transition_tx(
                        tx,
                        context_store_uuid,
                        row.generation,
                        "resetting",
                    )?;
                }
                Ok(row)
            })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn authority_verify_prepare(
        &self,
        context_store_uuid: &str,
        project: &str,
        domain: &str,
        expected_generation: u64,
        checksum_expected: &str,
        checksum_actual: &str,
    ) -> Result<AuthorityRow, McStoreError> {
        validate_authority_domain(domain)?;
        self.inner
            .with_conn_fenced(|tx| {
                let current = tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )?;
                if current.generation != expected_generation || current.state != "PREPARING" {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::State {
                            expected: format!("PREPARING generation {expected_generation}"),
                            found: format!("{} generation {}", current.state, current.generation),
                        },
                    )));
                }
                tx.execute(
                    "UPDATE mc_authority SET checksum_expected = ?1, checksum_actual = ?2, checksum_ok = ?3
                       WHERE context_store_uuid = ?4 AND project = ?5 AND domain = ?6",
                    params![
                        checksum_expected,
                        checksum_actual,
                        if checksum_expected == checksum_actual { 1 } else { 0 },
                        context_store_uuid,
                        project,
                        domain
                    ],
                )?;
                tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )
            })
            .map_err(map_authority_sql_error)
    }

    pub fn authority_ack_prepare(
        &self,
        context_store_uuid: &str,
        project: &str,
        domain: &str,
        expected_generation: u64,
    ) -> Result<AuthorityRow, McStoreError> {
        validate_authority_domain(domain)?;
        self.inner
            .with_conn_fenced(|tx| {
                let current = tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )?;
                if current.generation != expected_generation
                    || current.state != "PREPARING"
                    || current.checksum_ok != Some(true)
                {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::State {
                            expected: format!(
                                "verified PREPARING generation {expected_generation}"
                            ),
                            found: format!("{} generation {}", current.state, current.generation),
                        },
                    )));
                }
                if domain == "notes" {
                    // full lease.
                    fence_active_note_claims_tx(
                        tx,
                        project,
                        None,
                        "authority_changed",
                        current_time_ms(),
                    )?;
                }
                tx.execute(
                    "UPDATE mc_authority SET state = 'MODULE', generation = generation + 1,
                            note_eval_protocol_epoch = CASE WHEN domain = 'notes' THEN 2
                                ELSE note_eval_protocol_epoch END
                       WHERE context_store_uuid = ?1 AND project = ?2 AND domain = ?3",
                    params![context_store_uuid, project, domain],
                )?;
                tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )
            })
            .map_err(map_authority_sql_error)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn authority_finish_prepare(
        &self,
        context_store_uuid: &str,
        project: &str,
        domain: &str,
        expected_generation: u64,
        checksum_expected: &str,
        checksum_actual: &str,
        verified: bool,
    ) -> Result<AuthorityRow, McStoreError> {
        validate_authority_domain(domain)?;
        self.inner
            .with_conn_fenced(|tx| {
                let current = tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )?;
                if current.generation != expected_generation {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::Generation {
                            expected: expected_generation,
                            found: current.generation,
                        },
                    )));
                }
                if current.state != "PREPARING" {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::State {
                            expected: "PREPARING".to_string(),
                            found: current.state,
                        },
                    )));
                }
                if verified && checksum_expected != checksum_actual {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::State {
                            expected: "matching checksums".to_string(),
                            found: "verification failed".to_string(),
                        },
                    )));
                }
                let next_state = if verified { "MODULE" } else { "TS" };
                if domain == "notes" {
                    // full lease.
                    fence_active_note_claims_tx(
                        tx,
                        project,
                        None,
                        "authority_changed",
                        current_time_ms(),
                    )?;
                }
                let update_sql = if verified && domain == "notes" {
                    "UPDATE mc_authority
                        SET state = ?1, generation = generation + 1,
                            checksum_expected = ?2, checksum_actual = ?3, checksum_ok = ?4,
                            note_eval_protocol_epoch = 2
                      WHERE context_store_uuid = ?5 AND project = ?6 AND domain = ?7"
                } else {
                    "UPDATE mc_authority
                        SET state = ?1, generation = generation + 1,
                            checksum_expected = ?2, checksum_actual = ?3, checksum_ok = ?4
                      WHERE context_store_uuid = ?5 AND project = ?6 AND domain = ?7"
                };
                tx.execute(
                    update_sql,
                    params![
                        next_state,
                        checksum_expected,
                        checksum_actual,
                        if verified { 1 } else { 0 },
                        context_store_uuid,
                        project,
                        domain
                    ],
                )?;
                let row = tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )?;
                if domain == "memories" {
                    set_claim_intent_transition_tx(
                        tx,
                        context_store_uuid,
                        row.generation,
                        if row.state == "MODULE" {
                            "accepting"
                        } else {
                            "resetting"
                        },
                    )?;
                }
                Ok(row)
            })
            .map_err(map_authority_sql_error)
    }

    pub fn authority_abort_prepare(
        &self,
        context_store_uuid: &str,
        project: &str,
        domain: &str,
        expected_generation: u64,
    ) -> Result<AuthorityRow, McStoreError> {
        self.authority_finish_prepare(
            context_store_uuid,
            project,
            domain,
            expected_generation,
            "",
            "",
            false,
        )
    }

    pub fn authority_begin_drain(
        &self,
        context_store_uuid: &str,
        project: &str,
        domain: &str,
        lease: &str,
        lease_expires_at: i64,
        now_ms: i64,
    ) -> Result<AuthorityRow, McStoreError> {
        validate_authority_domain(domain)?;
        self.inner
            .with_conn_fenced(|tx| {
                let current = tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )?;
                if current.state == "DRAINING" {
                    let held_by_other = current.coordinator_lease.as_deref() != Some(lease);
                    let lease_live = current.lease_expires_at.unwrap_or(0) > now_ms;
                    if held_by_other && lease_live {
                        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                            AuthorityTransitionError::State {
                                expected: "the existing drain coordinator or an expired lease"
                                    .to_string(),
                                found: "a different live drain coordinator".to_string(),
                            },
                        )));
                    }
                    let token = mint_coordinator_token(lease, lease_expires_at, current.generation);
                    let feed_head: i64 = tx.query_row(
                        "SELECT COALESCE(MAX(feed_seq), 0) FROM mc_changefeed WHERE domain = ?1",
                        params![domain],
                        |row| row.get(0),
                    )?;
                    let captured_upper_bound = current
                        .captured_upper_bound
                        .unwrap_or(0)
                        .max(feed_head);
                    tx.execute(
                        "UPDATE mc_authority
                            SET coordinator_lease = ?1, lease_expires_at = ?2, coordinator_token = ?3,
                                captured_upper_bound = ?4
                          WHERE context_store_uuid = ?5 AND project = ?6 AND domain = ?7",
                        params![
                            lease,
                            lease_expires_at,
                            token,
                            captured_upper_bound,
                            context_store_uuid,
                            project,
                            domain
                        ],
                    )?;
                    let row = tx.query_row(
                        AUTHORITY_SELECT_SQL,
                        params![context_store_uuid, project, domain],
                        authority_row_from_sql,
                    )?;
                    if domain == "memories" {
                        set_claim_intent_transition_tx(
                            tx,
                            context_store_uuid,
                            row.generation,
                            "draining",
                        )?;
                    }
                    return Ok(row);
                }
                if current.state != "MODULE" {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::State {
                            expected: "MODULE".to_string(),
                            found: current.state,
                        },
                    )));
                }
                let upper_bound: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(feed_seq), 0) FROM mc_changefeed WHERE domain = ?1",
                    params![domain],
                    |row| row.get(0),
                )?;
                if domain == "notes" {
                    fence_active_note_claims_tx(tx, project, None, "authority_changed", now_ms)?;
                }
                let next_generation = current.generation + 1;
                let token = mint_coordinator_token(lease, lease_expires_at, next_generation);
                tx.execute(
                    "UPDATE mc_authority
                        SET state = 'DRAINING', generation = generation + 1,
                            captured_upper_bound = ?1, drain_generation = generation + 1,
                            drain_cursor = 0, coordinator_lease = ?2, lease_expires_at = ?3,
                            coordinator_token = ?4,
                            step_seed = 0, step_memories = 0, step_notes = 0,
                            step_compartments = 0, step_reconcile = 0, step_verify = 0, step_flip = 0
                      WHERE context_store_uuid = ?5 AND project = ?6 AND domain = ?7",
                    params![
                        upper_bound,
                        lease,
                        lease_expires_at,
                        token,
                        context_store_uuid,
                        project,
                        domain
                    ],
                )?;
                let row = tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )?;
                if domain == "memories" {
                    set_claim_intent_transition_tx(
                        tx,
                        context_store_uuid,
                        row.generation,
                        "draining",
                    )?;
                }
                Ok(row)
            })
            .map_err(map_authority_sql_error)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn authority_drain_step(
        &self,
        context_store_uuid: &str,
        project: &str,
        domain: &str,
        expected_generation: u64,
        step: &str,
        cursor: Option<i64>,
        coordinator_token: &str,
        now_ms: i64,
    ) -> Result<AuthorityRow, McStoreError> {
        validate_authority_domain(domain)?;
        let column = match step {
            "seed" => "step_seed",
            "memories" => "step_memories",
            "notes" => "step_notes",
            "compartments" => "step_compartments",
            "reconcile" => "step_reconcile",
            "verify" => "step_verify",
            "flip" => "step_flip",
            _ => return Err(McStoreError::Serde(format!("unknown drain step {step}"))),
        };
        self.inner
            .with_conn_fenced(|tx| {
                let current = tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )?;
                if current.generation != expected_generation {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::Generation {
                            expected: expected_generation,
                            found: current.generation,
                        },
                    )));
                }
                if current.state != "DRAINING" {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::State {
                            expected: "DRAINING".to_string(),
                            found: current.state,
                        },
                    )));
                }
                authority_require_live_coordinator(&current, coordinator_token, now_ms)?;
                tx.execute(
                    &format!("UPDATE mc_authority SET {column} = 1, drain_cursor = COALESCE(?1, drain_cursor) WHERE context_store_uuid = ?2 AND project = ?3 AND domain = ?4"),
                    params![cursor, context_store_uuid, project, domain],
                )?;
                tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )
            })
            .map_err(map_authority_sql_error)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn authority_finish_drain(
        &self,
        context_store_uuid: &str,
        project: &str,
        domain: &str,
        expected_generation: u64,
        checksum_expected: &str,
        checksum_actual: &str,
        verified: bool,
        coordinator_token: &str,
        now_ms: i64,
    ) -> Result<AuthorityRow, McStoreError> {
        validate_authority_domain(domain)?;
        let outcome = self
            .inner
            .with_conn_fenced(|tx| {
                let current = tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )?;
                if current.generation != expected_generation {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::Generation {
                            expected: expected_generation,
                            found: current.generation,
                        },
                    )));
                }
                if current.state != "DRAINING" {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::State {
                            expected: "DRAINING".to_string(),
                            found: current.state,
                        },
                    )));
                }
                authority_require_live_coordinator(&current, coordinator_token, now_ms)?;
                let all_steps = current.step_seed
                    && current.step_memories
                    && current.step_notes
                    && current.step_compartments
                    && current.step_reconcile
                    && current.step_verify;
                if !all_steps || !verified || checksum_expected != checksum_actual {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                        AuthorityTransitionError::State {
                            expected: "all drain steps and verification".to_string(),
                            found: "incomplete or failed".to_string(),
                        },
                    )));
                }
                let feed_head: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(feed_seq), 0) FROM mc_changefeed WHERE domain = ?1",
                    params![domain],
                    |row| row.get(0),
                )?;
                let captured = current.captured_upper_bound.unwrap_or(0);
                if feed_head != captured {
                    return Ok(AuthorityFinishDrainOutcome::FeedHeadAdvanced {
                        captured,
                        found: feed_head,
                    });
                }
                tx.execute(
                    "UPDATE mc_authority SET state = 'TS', generation = generation + 1,
                            checksum_expected = ?1, checksum_actual = ?2, checksum_ok = ?3,
                            coordinator_lease = NULL, lease_expires_at = NULL,
                            coordinator_token = NULL, step_flip = 1
                      WHERE context_store_uuid = ?4 AND project = ?5 AND domain = ?6",
                    params![
                        checksum_expected,
                        checksum_actual,
                        if verified { 1 } else { 0 },
                        context_store_uuid,
                        project,
                        domain
                    ],
                )?;
                tx.query_row(
                    AUTHORITY_SELECT_SQL,
                    params![context_store_uuid, project, domain],
                    authority_row_from_sql,
                )
                .map(Box::new)
                .map(AuthorityFinishDrainOutcome::Finished)
            })
            .map_err(map_authority_sql_error)?;
        match outcome {
            AuthorityFinishDrainOutcome::Finished(row) => Ok(*row),
            AuthorityFinishDrainOutcome::FeedHeadAdvanced { captured, found } => {
                Err(McStoreError::AuthorityFeedHeadAdvanced { captured, found })
            }
        }
    }

    ///
    pub fn seed_authority_rows(
        &self,
        context_store_uuid: &str,
        project: &str,
        domain: &str,
        rows: &[AuthoritySeedRow],
    ) -> Result<Vec<i64>, McStoreError> {
        validate_authority_domain(domain)?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        if domain != "notes" {
            return Err(McStoreError::Serde(
                "project claims use claim.mirror.replace, not authority row seeds".to_string(),
            ));
        }
        self.seed_note_snapshots(context_store_uuid, project, rows)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn authority_seed_transaction_count_for_test(&self) -> usize {
        self.authority_seed_transaction_count
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn authority_seed_checksum(
        &self,
        context_store_uuid: &str,
        project: &str,
        domain: &str,
    ) -> Result<String, McStoreError> {
        validate_authority_domain(domain)?;
        let rows = self.inner.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT source_row_id, snapshot_json FROM mc_authority_seed_rows WHERE context_store_uuid = ?1 AND project = ?2 AND domain = ?3 ORDER BY source_row_id ASC",
            )?;
            let rows = statement
                .query_map(params![context_store_uuid, project, domain], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        let mut canonical_rows = Vec::with_capacity(rows.len());
        for (source_row_id, snapshot_json) in rows {
            let snapshot: Value = serde_json::from_str(&snapshot_json)
                .map_err(|error| McStoreError::Serde(error.to_string()))?;
            canonical_rows.push(serde_json::json!({
                "source_row_id": source_row_id,
                "snapshot": snapshot,
            }));
        }
        let canonical = canonical_authority_value(&Value::Array(canonical_rows));
        Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
    }

    fn seed_note_snapshots(
        &self,
        context_store_uuid: &str,
        project: &str,
        rows: &[AuthoritySeedRow],
    ) -> Result<Vec<i64>, McStoreError> {
        let prepared = rows
            .iter()
            .map(|row| {
                let object = row.snapshot.as_object().ok_or_else(|| {
                    McStoreError::Serde("note seed snapshot must be an object".to_string())
                })?;
                if object.get("project_path").and_then(Value::as_str) != Some(project) {
                    return Err(McStoreError::Serde(
                        "note seed snapshot project_path did not match the authority project"
                            .to_string(),
                    ));
                }
                let snapshot_json = serde_json::to_string(&row.snapshot)
                    .map_err(|error| McStoreError::Serde(error.to_string()))?;
                Ok((row.source_row_id, snapshot_json))
            })
            .collect::<Result<Vec<_>, McStoreError>>()?;

        #[cfg(any(test, feature = "test-support"))]
        self.authority_seed_transaction_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        self.with_note_conn_fenced(project, |tx| {
            let mut note_upsert = tx.prepare_cached(&format!(
                "INSERT INTO mc_notes ({NOTE_INSERT_COLUMNS}) VALUES (
                     ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                     ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
                     ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37,
                     ?38, ?39, ?40, ?41)
                 ON CONFLICT(context_store_uuid, context_row_id) DO UPDATE SET
                    type=excluded.type, project_path=excluded.project_path,
                    session_id=excluded.session_id, content=excluded.content,
                    status=excluded.status, surface_condition=excluded.surface_condition,
                    ready_at=excluded.ready_at, ready_reason=excluded.ready_reason,
                    manifest_json=excluded.manifest_json, compiled_check=excluded.compiled_check,
                    check_hash=excluded.check_hash, check_cron=excluded.check_cron,
                    check_failure_count=excluded.check_failure_count,
                    check_network_failure_count=excluded.check_network_failure_count,
                    check_quarantined_until=excluded.check_quarantined_until,
                    check_next_due_at=excluded.check_next_due_at, check_compiled_at=excluded.check_compiled_at,
                    check_false_since_at=excluded.check_false_since_at,
                    check_last_liveness_at=excluded.check_last_liveness_at,
                    last_checked_at=excluded.last_checked_at, check_status=excluded.check_status,
                    check_version=excluded.check_version, policy_version=excluded.policy_version,
                    harness=excluded.harness, anchor_block_id=excluded.anchor_block_id,
                    anchor_ordinal=excluded.anchor_ordinal, dismissed_at=excluded.dismissed_at,
                    dismissal_resolution=excluded.dismissal_resolution,
                    status_version=excluded.status_version, created_at_ms=excluded.created_at_ms,
                    updated_at_ms=excluded.updated_at_ms,
                    source_revision=excluded.source_revision, state_version=excluded.state_version,
                    compiled_source_revision=excluded.compiled_source_revision,
                    compiled_project_path=excluded.compiled_project_path,
                    compiled_provider=excluded.compiled_provider,
                    compiled_config=excluded.compiled_config,
                    compiled_at=excluded.compiled_at, compile_status=excluded.compile_status"
            ))?;
            let mut note_by_source = tx.prepare_cached(
                "SELECT id FROM mc_notes
                   WHERE context_store_uuid = ?1 AND project_path = ?2 AND context_row_id = ?3",
            )?;
            let mut seed_row_upsert = tx.prepare_cached(
                "INSERT INTO mc_authority_seed_rows(
                     context_store_uuid, project, domain, source_row_id, snapshot_json
                 ) VALUES (?1, ?2, 'notes', ?3, ?4)
                 ON CONFLICT(context_store_uuid, project, domain, source_row_id)
                 DO UPDATE SET snapshot_json = excluded.snapshot_json",
            )?;
            let mut module_row_ids = Vec::with_capacity(rows.len());

            for ((source_row_id, snapshot_json), row) in prepared.iter().zip(rows) {
                let object = row.snapshot.as_object().expect("validated note seed object");
                let text = |name: &str| object.get(name).and_then(Value::as_str);
                let integer = |name: &str| object.get(name).and_then(Value::as_i64);
                note_upsert.execute(params![
                    text("type").unwrap_or("smart"),
                    project,
                    text("session_id"),
                    text("content").unwrap_or(""),
                    text("status").unwrap_or("active"),
                    text("surface_condition"),
                    integer("ready_at"),
                    text("ready_reason"),
                    text("manifest_json"),
                    text("compiled_check"),
                    text("check_hash"),
                    text("check_cron"),
                    integer("check_failure_count").unwrap_or(0),
                    integer("check_network_failure_count").unwrap_or(0),
                    integer("check_quarantined_until"),
                    integer("check_next_due_at"),
                    integer("check_compiled_at"),
                    integer("check_false_since_at"),
                    integer("check_last_liveness_at"),
                    integer("last_checked_at"),
                    text("check_status").unwrap_or("uncompiled"),
                    integer("check_version").unwrap_or(0),
                    integer("policy_version").unwrap_or(1),
                    text("harness").unwrap_or("module"),
                    text("anchor_block_id"),
                    integer("anchor_ordinal"),
                    integer("dismissed_at"),
                    text("dismissal_resolution"),
                    integer("status_version").unwrap_or(0),
                    integer("created_at_ms").or_else(|| integer("created_at")).unwrap_or(0),
                    integer("updated_at_ms").or_else(|| integer("updated_at")).unwrap_or(0),
                    context_store_uuid,
                    source_row_id,
                    integer("source_revision")
                        .or_else(|| integer("status_version"))
                        .unwrap_or(0),
                    integer("state_version")
                        .or_else(|| integer("status_version"))
                        .unwrap_or(0),
                    integer("compiled_source_revision"),
                    text("compiled_project_path"),
                    text("compiled_provider"),
                    text("compiled_config"),
                    integer("compiled_at"),
                    text("compile_status"),
                ])?;
                let module_row_id: i64 = note_by_source.query_row(
                    params![context_store_uuid, project, source_row_id],
                    |row| row.get(0),
                )?;
                seed_row_upsert.execute(params![
                    context_store_uuid,
                    project,
                    source_row_id,
                    snapshot_json,
                ])?;
                module_row_ids.push(module_row_id);
            }
            // Verification prevents an unvalidated compiled check from becoming selectable.
            loop {
                let processed = repair_note_artifacts_tx(tx, project)?;
                if processed < NOTE_ARTIFACT_REPAIR_BATCH as usize {
                    break;
                }
            }
            Ok(module_row_ids)
        })
    }

    /// filtering by domain preserves monotonic retry semantics even when domains interleave.
    pub fn pull_changefeed(
        &self,
        domain: &str,
        cursor: i64,
        limit: usize,
    ) -> Result<ChangefeedPage, McStoreError> {
        if domain != "notes" {
            return Err(McStoreError::Serde(
                "project claims use the committed claim mirror protocol".to_string(),
            ));
        }
        let limit = i64::try_from(limit.clamp(1, 1000))
            .map_err(|_| McStoreError::Serde("feed limit exceeds i64".to_string()))?;
        self.inner
            .with_conn(|conn| {
                let mut stmt = conn.prepare_cached(
                    "SELECT feed_seq, domain, op, module_row_id, full_row_snapshot, content_hash
                       FROM mc_changefeed WHERE domain = ?1 AND feed_seq > ?2
                       ORDER BY feed_seq ASC LIMIT ?3",
                )?;
                let rows = stmt
                    .query_map(params![domain, cursor, limit], |row| {
                        let snapshot: String = row.get(4)?;
                        Ok(ChangefeedRow {
                            feed_seq: row.get(0)?,
                            domain: row.get(1)?,
                            op: row.get(2)?,
                            module_row_id: row.get(3)?,
                            full_row_snapshot: serde_json::from_str(&snapshot).map_err(
                                |error| {
                                    rusqlite::Error::FromSqlConversionFailure(
                                        4,
                                        rusqlite::types::Type::Text,
                                        Box::new(error),
                                    )
                                },
                            )?,
                            content_hash: row.get(5)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let next_cursor = rows.last().map(|row| row.feed_seq).unwrap_or(cursor);
                Ok(ChangefeedPage {
                    domain: domain.to_string(),
                    cursor,
                    next_cursor,
                    has_more: rows.len() == limit as usize,
                    rows,
                })
            })
            .map_err(Into::into)
    }
}

fn write_seed_compartment_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    c: &StoredCompartment,
    overwrite_existing: bool,
) -> rusqlite::Result<bool> {
    let conflict_clause = if overwrite_existing {
        "ON CONFLICT(session_id, sequence) DO UPDATE SET
            start_message = excluded.start_message,
            end_message = excluded.end_message,
            start_message_id = excluded.start_message_id,
            end_message_id = excluded.end_message_id,
            start_date = excluded.start_date,
            end_date = excluded.end_date,
            title = excluded.title,
            content = excluded.content,
            p1 = excluded.p1,
            p2 = excluded.p2,
            p3 = excluded.p3,
            p4 = excluded.p4,
            importance = excluded.importance,
            episode_type = excluded.episode_type,
            legacy = excluded.legacy,
            created_at = excluded.created_at"
    } else {
        "ON CONFLICT(session_id, sequence) DO NOTHING"
    };
    let sql = format!(
        "INSERT INTO mc_compartments
           (session_id, sequence, start_message, end_message, start_message_id,
            end_message_id, start_date, end_date, title, content, p1, p2, p3, p4,
            importance, episode_type, legacy, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
         {conflict_clause}"
    );
    let changed = tx.execute(
        &sql,
        params![
            session_id,
            c.sequence,
            c.start_message,
            c.end_message,
            &c.start_message_id,
            &c.end_message_id,
            c.start_date.as_deref(),
            c.end_date.as_deref(),
            &c.title,
            &c.content,
            c.p1.as_deref(),
            c.p2.as_deref(),
            c.p3.as_deref(),
            c.p4.as_deref(),
            c.importance as i64,
            c.episode_type.as_deref(),
            c.legacy as i64,
            c.created_at,
        ],
    )?;
    Ok(changed != 0)
}

fn replace_workspace_tx(
    tx: &rusqlite::Transaction<'_>,
    project_path: &str,
    workspace: Option<&ModuleWorkspaceRow>,
) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM mc_workspaces
          WHERE id IN (
              SELECT workspace_id FROM mc_workspace_members WHERE project_path = ?1
          )",
        params![project_path],
    )?;
    let Some(workspace) = workspace else {
        return Ok(());
    };
    let share_categories = serde_json::to_string(&workspace.share_categories)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    tx.execute(
        "INSERT INTO mc_workspaces (name, created_at, updated_at, share_categories)
         VALUES (?1, 0, 0, ?2)",
        params![&workspace.name, share_categories],
    )?;
    let workspace_id = tx.last_insert_rowid();
    for member in &workspace.members {
        tx.execute(
            "INSERT INTO mc_workspace_members
                (workspace_id, project_path, display_name, display_path, added_at)
             VALUES (?1, ?2, ?3, ?4, 0)",
            params![
                workspace_id,
                &member.project_path,
                &member.display_name,
                &member.display_path
            ],
        )?;
    }
    Ok(())
}

fn replace_authority_user_profile_tx(
    tx: &rusqlite::Transaction<'_>,
    profile_lines: &[String],
) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM mc_user_memories", [])?;
    for (index, content) in profile_lines.iter().enumerate() {
        tx.execute(
            "INSERT INTO mc_user_memories
                (content, status, promoted_at, source_candidate_ids, created_at, updated_at)
             VALUES (?1, 'active', ?2, '[]', 0, 0)",
            params![content, index as i64],
        )?;
    }
    Ok(())
}

fn insert_compartment_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    sequence: i64,
    c: &StoredCompartment,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO mc_compartments
           (session_id, sequence, start_message, end_message, start_message_id,
            end_message_id, start_date, end_date, title, content, p1, p2, p3, p4,
            importance, episode_type, legacy, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
        params![
            session_id,
            sequence,
            c.start_message,
            c.end_message,
            &c.start_message_id,
            &c.end_message_id,
            c.start_date.as_deref(),
            c.end_date.as_deref(),
            &c.title,
            &c.content,
            c.p1.as_deref(),
            c.p2.as_deref(),
            c.p3.as_deref(),
            c.p4.as_deref(),
            c.importance as i64,
            c.episode_type.as_deref(),
            c.legacy as i64,
            c.created_at,
        ],
    )?;
    Ok(())
}

fn insert_historian_events_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    events: &[HistorianEventCandidate],
) -> rusqlite::Result<()> {
    for event in events {
        tx.execute(
            "INSERT INTO mc_compartment_events
               (session_id, compartment_id, at_compartment, kind, fields_json, created_at, harness)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'module')",
            params![
                session_id,
                event.compartment_id.map(|v| v as i64),
                event.at_compartment.map(|v| v as i64),
                event.kind,
                event.fields_json,
                event.created_at,
            ],
        )?;
    }
    Ok(())
}

fn historian_side_channel_pending_items(
    request: &HistorianPublishRequest<'_>,
) -> Result<Vec<HistorianSideChannelPendingItem>, String> {
    let default_start = request
        .compartments
        .iter()
        .map(|compartment| compartment.start_message.max(0) as u64)
        .min()
        .unwrap_or_else(|| request.publication_floor_ordinal.saturating_sub(1));
    let default_end = request
        .compartments
        .iter()
        .map(|compartment| compartment.end_message.max(0) as u64)
        .max()
        .unwrap_or(default_start);
    let created_at_ms = current_time_ms();
    let mut items = Vec::new();

    for (item_index, event) in request.events.iter().enumerate() {
        let source = event.compartment_id.and_then(|sequence| {
            request
                .compartments
                .iter()
                .find(|compartment| compartment.sequence.max(0) as u64 == sequence)
        });
        items.push(HistorianSideChannelPendingItem {
            id: HistorianSideChannelOutboxId {
                firing_seq: request.predicate.firing_seq,
                kind: "event".to_string(),
                source_start: source
                    .map(|compartment| compartment.start_message.max(0) as u64)
                    .unwrap_or(default_start),
                source_end: source
                    .map(|compartment| compartment.end_message.max(0) as u64)
                    .unwrap_or(default_end),
                item_index,
            },
            payload_json: serde_json::to_string(event).map_err(|error| error.to_string())?,
            created_at_ms,
        });
    }
    for (item_index, primer) in request.primer_candidates.iter().enumerate() {
        if primer.question.trim().is_empty() {
            continue;
        }
        items.push(HistorianSideChannelPendingItem {
            id: HistorianSideChannelOutboxId {
                firing_seq: request.predicate.firing_seq,
                kind: "primer".to_string(),
                source_start: primer.source_compartment_start.unwrap_or(default_start),
                source_end: primer.source_compartment_end.unwrap_or(default_end),
                item_index,
            },
            payload_json: serde_json::to_string(primer).map_err(|error| error.to_string())?,
            created_at_ms,
        });
    }
    for (item_index, observation) in request.user_memory_candidates.iter().enumerate() {
        if observation.content.trim().is_empty() {
            continue;
        }
        items.push(HistorianSideChannelPendingItem {
            id: HistorianSideChannelOutboxId {
                firing_seq: request.predicate.firing_seq,
                kind: "user_observation".to_string(),
                source_start: observation
                    .source_compartment_start
                    .unwrap_or(default_start),
                source_end: observation.source_compartment_end.unwrap_or(default_end),
                item_index,
            },
            payload_json: serde_json::to_string(observation).map_err(|error| error.to_string())?,
            created_at_ms,
        });
    }
    Ok(items)
}

fn enqueue_historian_side_channels_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    items: &[HistorianSideChannelPendingItem],
) -> rusqlite::Result<()> {
    for item in items {
        tx.execute(
            "INSERT INTO mc_historian_side_channel_outbox
                 (session_id, firing_seq, kind, source_start, source_end, item_index,
                  payload_json, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                session_id,
                item.id.firing_seq as i64,
                item.id.kind,
                item.id.source_start as i64,
                item.id.source_end as i64,
                item.id.item_index as i64,
                item.payload_json,
                item.created_at_ms,
            ],
        )?;
    }
    Ok(())
}

fn mark_historian_side_channel_delivered_tx(
    tx: &rusqlite::Transaction<'_>,
    row: &HistorianSideChannelOutboxRow,
    now_ms: i64,
) -> rusqlite::Result<()> {
    let changed = tx.execute(
        "UPDATE mc_historian_side_channel_outbox
            SET delivered_at_ms = ?7, last_attempt_at_ms = ?7, last_error = NULL
          WHERE session_id = ?1 AND firing_seq = ?2 AND kind = ?3
            AND source_start = ?4 AND source_end = ?5 AND item_index = ?6
            AND delivered_at_ms IS NULL",
        params![
            row.session_id,
            row.id.firing_seq as i64,
            row.id.kind,
            row.id.source_start as i64,
            row.id.source_end as i64,
            row.id.item_index as i64,
            now_ms,
        ],
    )?;
    if changed != 1 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

fn insert_historian_primer_tx(
    tx: &rusqlite::Transaction<'_>,
    candidate: &HistorianPrimerCandidate,
) -> rusqlite::Result<()> {
    let question = candidate.question.trim();
    if question.is_empty() {
        return Ok(());
    }
    let normalized = question
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    tx.execute(
        "INSERT INTO mc_primer_candidates
           (project_path, harness, session_id, question, normalized_question,
            source_compartment_start, source_compartment_end,
            source_start_message_id, source_end_message_id,
            source_message_time, created_at)
         VALUES (?1, 'module', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(project_path, harness, session_id,
                     source_start_message_id, source_end_message_id)
         DO UPDATE SET question = excluded.question,
                       normalized_question = excluded.normalized_question,
                       source_compartment_start = excluded.source_compartment_start,
                       source_compartment_end = excluded.source_compartment_end,
                       source_message_time = excluded.source_message_time,
                       created_at = MIN(mc_primer_candidates.created_at, excluded.created_at)",
        params![
            candidate.project_path,
            candidate.session_id,
            question,
            normalized,
            candidate.source_compartment_start.map(|value| value as i64),
            candidate.source_compartment_end.map(|value| value as i64),
            candidate.source_start_message_id,
            candidate.source_end_message_id,
            candidate.source_message_time,
            candidate.created_at,
        ],
    )?;
    Ok(())
}

fn insert_historian_user_observation_tx(
    tx: &rusqlite::Transaction<'_>,
    candidate: &HistorianUserMemoryCandidate,
) -> rusqlite::Result<()> {
    let content = candidate.content.trim();
    if content.is_empty() {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO mc_user_memory_candidates
           (content, session_id, source_compartment_start, source_compartment_end, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            content,
            candidate.session_id,
            candidate.source_compartment_start.map(|value| value as i64),
            candidate.source_compartment_end.map(|value| value as i64),
            candidate.created_at,
        ],
    )?;
    Ok(())
}

fn append_compartments_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    compartments: &[StoredCompartment],
) -> rusqlite::Result<AppendCompartmentsTxnOutcome> {
    if compartments.is_empty() {
        return Ok(AppendCompartmentsTxnOutcome::Appended);
    }

    let next_sequence = next_compartment_sequence_tx(tx, session_id)?;
    let mut statement = tx.prepare_cached(
        "SELECT sequence, start_message, end_message
         FROM mc_compartments WHERE session_id = ?1",
    )?;
    let mut ranges = statement
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    // The append validator rejects the whole batch before writing its first row.
    // Whole-batch validation prevents partial batches and ordinal-overlap corruption.
    for (index, compartment) in compartments.iter().enumerate() {
        if let Some((existing_sequence, _, _)) = ranges.iter().find(|(_, start, end)| {
            compartment.start_message <= *end && *start <= compartment.end_message
        }) {
            return Ok(AppendCompartmentsTxnOutcome::Overlap {
                existing_sequence: *existing_sequence,
                incoming_start_message: compartment.start_message,
                incoming_end_message: compartment.end_message,
            });
        }
        ranges.push((
            next_sequence + index as i64,
            compartment.start_message,
            compartment.end_message,
        ));
    }

    for (index, compartment) in compartments.iter().enumerate() {
        insert_compartment_tx(tx, session_id, next_sequence + index as i64, compartment)?;
    }
    Ok(AppendCompartmentsTxnOutcome::Appended)
}

fn next_compartment_sequence_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
) -> rusqlite::Result<i64> {
    tx.query_row(
        "SELECT COALESCE(MAX(sequence), 0) + 1 FROM mc_compartments WHERE session_id = ?1",
        params![session_id],
        |r| r.get(0),
    )
}

fn insert_chunk_transcripts_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    first_sequence: i64,
    compartments: &[StoredCompartment],
    transcript: Option<&str>,
    raw_messages: Option<&str>,
) -> rusqlite::Result<()> {
    if compartments.is_empty() {
        return Ok(());
    }
    let compressed = transcript.and_then(|transcript| {
        compress_transcript(transcript)
            .ok()
            .filter(|compressed| compressed.len() <= MAX_CHUNK_TRANSCRIPT_COMPRESSED_BYTES)
    });
    let raw_messages_compressed = raw_messages
        .map(compress_raw_messages)
        .transpose()
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    if compressed.is_none() && raw_messages_compressed.is_none() {
        return Ok(());
    }
    // Raw-only rows store a condensed payload because transcript_deflate is NOT NULL.
    // historian transcript.
    let compressed = compressed.unwrap_or_else(|| compress_transcript("").unwrap_or_default());
    for (idx, compartment) in compartments.iter().enumerate() {
        tx.execute(
            "INSERT OR REPLACE INTO mc_chunk_transcripts
               (session_id, compartment_seq, start_ordinal, end_ordinal,
                transcript_deflate, raw_messages_deflate, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                session_id,
                first_sequence + idx as i64,
                compartment.start_message,
                compartment.end_message,
                &compressed,
                raw_messages_compressed.as_deref(),
                compartment.created_at,
            ],
        )?;
    }
    evict_chunk_transcripts_tx(tx, session_id)
}

fn evict_chunk_transcripts_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
) -> rusqlite::Result<()> {
    let empty_transcript = compress_transcript("").unwrap_or_default();
    loop {
        let total: i64 = tx.query_row(
            "SELECT COALESCE(SUM(LENGTH(transcript_deflate)), 0)
               FROM mc_chunk_transcripts WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )?;
        if total <= MAX_SESSION_TRANSCRIPT_COMPRESSED_BYTES {
            return Ok(());
        }
        let victim: Option<(i64, bool)> = tx
            .query_row(
                "SELECT compartment_seq, raw_messages_deflate IS NOT NULL
                   FROM mc_chunk_transcripts
                  WHERE session_id = ?1
                    AND (raw_messages_deflate IS NULL OR transcript_deflate <> ?2)
                  ORDER BY created_at_ms ASC, compartment_seq ASC
                  LIMIT 1",
                params![session_id, &empty_transcript],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((victim, retains_raw_messages)) = victim else {
            return Ok(());
        };
        if retains_raw_messages {
            // Full-message recovery retains the raw payload.
            // The transcript budget reclaims only the optional condensed transcript.
            tx.execute(
                "UPDATE mc_chunk_transcripts
                    SET transcript_deflate = ?3
                  WHERE session_id = ?1 AND compartment_seq = ?2",
                params![session_id, victim, &empty_transcript],
            )?;
        } else {
            tx.execute(
                "DELETE FROM mc_chunk_transcripts WHERE session_id = ?1 AND compartment_seq = ?2",
                params![session_id, victim],
            )?;
        }
    }
}

fn compress_transcript(transcript: &str) -> std::io::Result<Vec<u8>> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(transcript.as_bytes())?;
    encoder.finish()
}

fn compress_raw_messages(raw_messages: &str) -> std::io::Result<Vec<u8>> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(raw_messages.as_bytes())?;
    encoder.finish()
}

fn decompress_raw_messages(blob: &[u8]) -> std::io::Result<String> {
    let mut decoder = DeflateDecoder::new(blob);
    let mut raw_messages = String::new();
    decoder.read_to_string(&mut raw_messages)?;
    Ok(raw_messages)
}

fn decompress_transcript(blob: &[u8]) -> std::io::Result<String> {
    let decoder = DeflateDecoder::new(blob);
    // The reader reads only the suffix needed to complete a UTF-8 code point split at the output cap.
    // The suffix permits discarding a UTF-8 code point split at the cap without unbounded decompressor buffering.
    let mut limited = decoder.take((MAX_CHUNK_TRANSCRIPT_INFLATED_BYTES + 4) as u64);
    let mut inflated_prefix = Vec::new();
    limited.read_to_end(&mut inflated_prefix)?;
    let valid_len = match std::str::from_utf8(&inflated_prefix) {
        Ok(_) => inflated_prefix.len(),
        Err(error)
            if error.valid_up_to() >= MAX_CHUNK_TRANSCRIPT_INFLATED_BYTES.saturating_sub(4) =>
        {
            error.valid_up_to()
        }
        Err(error) => {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!(
                    "transcript is not valid UTF-8 at byte {}",
                    error.valid_up_to()
                ),
            ));
        }
    };
    let mut output_len = valid_len.min(MAX_CHUNK_TRANSCRIPT_INFLATED_BYTES);
    while std::str::from_utf8(&inflated_prefix[..output_len]).is_err() {
        output_len -= 1;
    }
    let truncated = output_len < inflated_prefix.len()
        || inflated_prefix.len() > MAX_CHUNK_TRANSCRIPT_INFLATED_BYTES;
    let mut reader = Cursor::new(&inflated_prefix[..output_len])
        .take(MAX_CHUNK_TRANSCRIPT_INFLATED_BYTES as u64);
    let mut out = String::new();
    reader.read_to_string(&mut out)?;
    if !truncated {
        return Ok(out);
    }

    out.push_str(CHUNK_TRANSCRIPT_TRUNCATION_MARKER);
    Ok(out)
}

fn tag_row_from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<McTagRow> {
    Ok(McTagRow {
        tag_number: r.get(0)?,
        block_id: r.get(1)?,
        kind: r.get(2)?,
        token_count: r.get(3)?,
        created_at_ms: r.get(4)?,
        source_bytes: r.get(5)?,
    })
}

const NOTE_SELECT_COLUMNS: &str = "id, type, project_path, session_id, content, status, surface_condition, ready_at, ready_reason, manifest_json, compiled_check, check_hash, check_cron, check_failure_count, check_network_failure_count, check_quarantined_until, check_next_due_at, check_compiled_at, check_false_since_at, check_last_liveness_at, last_checked_at, check_status, check_version, policy_version, harness, anchor_block_id, anchor_ordinal, dismissed_at, dismissal_resolution, status_version, created_at_ms, updated_at_ms, context_store_uuid, context_row_id, source_revision, state_version, compiled_source_revision, compiled_project_path, compiled_provider, compiled_config, compiled_at, compile_status";
const NOTE_INSERT_COLUMNS: &str = "type, project_path, session_id, content, status, surface_condition, ready_at, ready_reason, manifest_json, compiled_check, check_hash, check_cron, check_failure_count, check_network_failure_count, check_quarantined_until, check_next_due_at, check_compiled_at, check_false_since_at, check_last_liveness_at, last_checked_at, check_status, check_version, policy_version, harness, anchor_block_id, anchor_ordinal, dismissed_at, dismissal_resolution, status_version, created_at_ms, updated_at_ms, context_store_uuid, context_row_id, source_revision, state_version, compiled_source_revision, compiled_project_path, compiled_provider, compiled_config, compiled_at, compile_status";

// Parameter ?2 denotes a condition change; parameter ?5 denotes a compiler-input edit.
// A compiler-input edit advances source_revision and resets compiled evaluation state.
// Parameters ?7 through ?10 replace compile authoring metadata only when the condition changes.
const NOTE_CAS_UPDATE_SQL: &str = "UPDATE mc_notes SET content = ?1,
    surface_condition = CASE WHEN ?2 THEN ?3 ELSE surface_condition END,
    status = ?4, status_version = status_version + 1, state_version = state_version + 1,
    source_revision = source_revision + CASE WHEN ?5 THEN 1 ELSE 0 END,
    updated_at_ms = ?6,
    last_checked_at = CASE WHEN ?5 THEN NULL ELSE last_checked_at END,
    ready_at = CASE WHEN ?5 THEN NULL ELSE ready_at END,
    ready_reason = CASE WHEN ?5 THEN NULL ELSE ready_reason END,
    compiled_check = CASE WHEN ?5 THEN NULL ELSE compiled_check END,
    manifest_json = CASE WHEN ?5 THEN NULL ELSE manifest_json END,
    check_hash = CASE WHEN ?5 THEN NULL ELSE check_hash END,
    check_cron = CASE WHEN ?5 THEN NULL ELSE check_cron END,
    compiled_source_revision = CASE WHEN ?5 THEN NULL ELSE compiled_source_revision END,
    compiled_project_path = CASE WHEN ?5 THEN NULL ELSE compiled_project_path END,
    check_version = CASE WHEN ?5 THEN 0 ELSE check_version END,
    check_status = CASE WHEN ?5 THEN 'uncompiled' ELSE check_status END,
    check_failure_count = CASE WHEN ?5 THEN 0 ELSE check_failure_count END,
    check_network_failure_count = CASE WHEN ?5 THEN 0 ELSE check_network_failure_count END,
    check_quarantined_until = CASE WHEN ?5 THEN NULL ELSE check_quarantined_until END,
    check_next_due_at = CASE WHEN ?5 THEN NULL ELSE check_next_due_at END,
    check_compiled_at = CASE WHEN ?5 THEN NULL ELSE check_compiled_at END,
    check_false_since_at = CASE WHEN ?5 THEN NULL ELSE check_false_since_at END,
    check_last_liveness_at = CASE WHEN ?5 THEN NULL ELSE check_last_liveness_at END,
    compiled_provider = CASE WHEN ?2 THEN ?7 ELSE compiled_provider END,
    compiled_config = CASE WHEN ?2 THEN ?8 ELSE compiled_config END,
    compiled_at = CASE WHEN ?2 THEN ?9 ELSE compiled_at END,
    compile_status = CASE WHEN ?2 THEN ?10 ELSE compile_status END
  WHERE id = ?11 AND project_path = ?12 AND status = ?13 AND status_version = ?14";

fn stored_note_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredNote> {
    Ok(StoredNote {
        id: r.get(0)?,
        type_name: r.get(1)?,
        project_path: r.get(2)?,
        session_id: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        content: r.get(4)?,
        status: r.get(5)?,
        surface_condition: r.get(6)?,
        ready_at: r.get(7)?,
        ready_reason: r.get(8)?,
        manifest_json: r.get(9)?,
        compiled_check: r.get(10)?,
        check_hash: r.get(11)?,
        check_cron: r.get(12)?,
        check_failure_count: r.get(13)?,
        check_network_failure_count: r.get(14)?,
        check_quarantined_until: r.get(15)?,
        check_next_due_at: r.get(16)?,
        check_compiled_at: r.get(17)?,
        check_false_since_at: r.get(18)?,
        check_last_liveness_at: r.get(19)?,
        last_checked_at: r.get(20)?,
        check_status: r.get(21)?,
        check_version: r.get(22)?,
        policy_version: r.get(23)?,
        harness: r.get(24)?,
        anchor_block_id: r.get(25)?,
        anchor_ordinal: r.get(26)?,
        dismissed_at: r.get(27)?,
        dismissal_resolution: r.get(28)?,
        status_version: r.get(29)?,
        created_at_ms: r.get(30)?,
        updated_at_ms: r.get(31)?,
        context_store_uuid: r.get(32)?,
        context_row_id: r.get(33)?,
        source_revision: r.get(34)?,
        state_version: r.get(35)?,
        compiled_source_revision: r.get(36)?,
        compiled_project_path: r.get(37)?,
        compiled_provider: r.get(38)?,
        compiled_config: r.get(39)?,
        compiled_at: r.get(40)?,
        compile_status: r.get(41)?,
    })
}

fn load_note_tx(tx: &rusqlite::Transaction<'_>, id: i64) -> rusqlite::Result<StoredNote> {
    tx.query_row(
        &format!("SELECT {NOTE_SELECT_COLUMNS} FROM mc_notes WHERE id = ?1"),
        params![id],
        stored_note_from_row,
    )
}

const NOTE_EVAL_CLAIM_COLUMNS: &str = "claim_id, note_id, phase, acquisition_id, \
    evaluator_instance, evaluator_slot, registration_generation, source_revision, \
    state_version, policy_version, protocol_epoch, authority_generation, expires_at, \
    completion_id, terminal_kind, terminal_response";

/// Acquisition polls the pending set on every call, so the selector excludes content and manifest_json.
/// Polling omits the compiled artifact body to avoid loading up to `MAX_COMPILED_CHECK_BYTES` per call.
/// The selector needs only whether an artifact exists.
const NOTE_EVAL_CANDIDATE_COLUMNS: &str = "id, status, compile_status, created_at_ms, \
    compiled_check IS NOT NULL, check_status, check_quarantined_until, check_next_due_at, \
    check_false_since_at, check_last_liveness_at, policy_version, last_checked_at";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteEvalCandidate {
    pub id: i64,
    pub status: String,
    pub compile_status: Option<String>,
    pub created_at_ms: i64,
    pub has_compiled_check: bool,
    pub check_status: Option<String>,
    pub check_quarantined_until: Option<i64>,
    pub check_next_due_at: Option<i64>,
    pub check_false_since_at: Option<i64>,
    pub check_last_liveness_at: Option<i64>,
    pub policy_version: Option<i64>,
    pub last_checked_at: Option<i64>,
}

fn note_eval_candidate_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<NoteEvalCandidate> {
    Ok(NoteEvalCandidate {
        id: r.get(0)?,
        status: r.get(1)?,
        compile_status: r.get(2)?,
        created_at_ms: r.get(3)?,
        has_compiled_check: r.get(4)?,
        check_status: r.get(5)?,
        check_quarantined_until: r.get(6)?,
        check_next_due_at: r.get(7)?,
        check_false_since_at: r.get(8)?,
        check_last_liveness_at: r.get(9)?,
        policy_version: r.get(10)?,
        last_checked_at: r.get(11)?,
    })
}

const NOTE_EVAL_ID_MAX_LEN: usize = 200;
const NOTE_EVAL_RESPONSE_MAX_LEN: usize = 2048;

struct NoteEvalClaimRow {
    claim: NoteEvalClaim,
    completion_id: Option<String>,
    terminal_kind: Option<String>,
    terminal_response: Option<String>,
}

fn note_eval_claim_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteEvalClaimRow> {
    Ok(NoteEvalClaimRow {
        claim: NoteEvalClaim {
            claim_id: row.get(0)?,
            note_id: row.get(1)?,
            phase: row.get(2)?,
            acquisition_id: row.get(3)?,
            evaluator_instance: row.get(4)?,
            evaluator_slot: row.get(5)?,
            registration_generation: row.get(6)?,
            source_revision: row.get(7)?,
            state_version: row.get(8)?,
            policy_version: row.get(9)?,
            protocol_epoch: row.get(10)?,
            authority_generation: row.get(11)?,
            expires_at: row.get(12)?,
        },
        completion_id: row.get(13)?,
        terminal_kind: row.get(14)?,
        terminal_response: row.get(15)?,
    })
}

fn note_eval_valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= NOTE_EVAL_ID_MAX_LEN
}

fn note_eval_bound_response(response: &str) -> String {
    if response.len() <= NOTE_EVAL_RESPONSE_MAX_LEN {
        return response.to_string();
    }
    let mut end = NOTE_EVAL_RESPONSE_MAX_LEN;
    while !response.is_char_boundary(end) {
        end -= 1;
    }
    response[..end].to_string()
}

fn note_eval_kind_response(kind: &str) -> String {
    serde_json::json!({ "result": kind }).to_string()
}

/// The lookup resolves the notes-authority row that fences this project's evaluation protocol.
fn note_eval_authority_tx(
    tx: &rusqlite::Transaction<'_>,
    project: &str,
) -> rusqlite::Result<Option<(i64, i64, String)>> {
    tx.query_row(
        "SELECT generation, note_eval_protocol_epoch, state
           FROM mc_authority
          WHERE project = ?1 AND domain = 'notes'
          ORDER BY CASE WHEN state = 'MODULE' THEN 0 ELSE 1 END, context_store_uuid
          LIMIT 1",
        params![project],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
}

fn note_eval_module_authority_tx(
    tx: &rusqlite::Transaction<'_>,
    project: &str,
) -> rusqlite::Result<Option<(i64, i64)>> {
    Ok(note_eval_authority_tx(tx, project)?
        .filter(|(_, _, state)| state == "MODULE")
        .map(|(generation, epoch, _)| (generation, epoch)))
}

fn load_note_eval_claim_tx(
    tx: &rusqlite::Transaction<'_>,
    project: &str,
    claim_id: &str,
) -> rusqlite::Result<Option<NoteEvalClaimRow>> {
    tx.query_row(
        &format!(
            "SELECT {NOTE_EVAL_CLAIM_COLUMNS} FROM mc_note_eval_claims
              WHERE project = ?1 AND claim_id = ?2"
        ),
        params![project, claim_id],
        note_eval_claim_from_row,
    )
    .optional()
}

fn mark_note_eval_claim_terminal_tx(
    tx: &rusqlite::Transaction<'_>,
    project: &str,
    claim_id: &str,
    kind: &str,
    completion_id: Option<&str>,
    response: &str,
    now_ms: i64,
) -> rusqlite::Result<usize> {
    tx.execute(
        "UPDATE mc_note_eval_claims
            SET terminal_kind = ?1, completion_id = COALESCE(?2, completion_id),
                terminal_response = ?3, terminal_at_ms = ?4
          WHERE project = ?5 AND claim_id = ?6 AND terminal_kind IS NULL",
        params![kind, completion_id, response, now_ms, project, claim_id],
    )
}

/// The update terminally fences active claims so in-flight evaluations cannot complete.
/// `note_id = None` terminally fences every active claim in the project, preventing stale completions.
fn fence_active_note_claims_tx(
    tx: &rusqlite::Transaction<'_>,
    project: &str,
    note_id: Option<i64>,
    kind: &str,
    now_ms: i64,
) -> rusqlite::Result<usize> {
    tx.execute(
        "UPDATE mc_note_eval_claims
            SET terminal_kind = ?1, terminal_response = ?2, terminal_at_ms = ?3
          WHERE project = ?4 AND terminal_kind IS NULL AND (?5 IS NULL OR note_id = ?5)",
        params![
            kind,
            note_eval_kind_response(kind),
            now_ms,
            project,
            note_id
        ],
    )
}

/// The cleanup expires overdue active claims and tombstones expired `no_work` decisions.
/// `decision = ''` preserves replay identity for tombstoned `no_work` decisions.
/// The cleanup sets terminal responses to `NULL` after their completion-replay window.
/// `NOTE_EVAL_RESPONSE_REDACT_MS` nulls terminal responses before terminal-row deletion.
/// Tombstoned rows replay as `Expired` and do not count against either cap.
fn collect_note_eval_ledgers_tx(
    tx: &rusqlite::Transaction<'_>,
    project: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE mc_note_eval_claims
            SET terminal_kind = 'expired', terminal_response = ?1, terminal_at_ms = ?2
          WHERE project = ?3 AND terminal_kind IS NULL AND expires_at <= ?2",
        params![note_eval_kind_response("expired"), now_ms, project],
    )?;
    tx.execute(
        "UPDATE mc_note_eval_acquisitions SET decision = ''
          WHERE project = ?1 AND decision <> '' AND expires_at <= ?2",
        params![project, now_ms],
    )?;
    tx.execute(
        "UPDATE mc_note_eval_claims SET terminal_response = NULL
          WHERE project = ?1 AND terminal_kind IS NOT NULL AND terminal_response IS NOT NULL
            AND terminal_at_ms IS NOT NULL AND terminal_at_ms <= ?2",
        params![project, now_ms - NOTE_EVAL_RESPONSE_REDACT_MS],
    )?;
    // The cleanup deletes tombstoned acquisitions and terminal claims after their retention periods.
    // `decision = ''` and `terminal_response = NULL` leave rows until retention-based deletion.
    // Without cleanup, recording every idle `no_work` poll would grow the ledger without bound.
    // Idle `no_work` polls also create acquisition rows.
    // Unbounded ledger growth makes per-poll GC and cap counts scan progressively more rows.
    tx.execute(
        "DELETE FROM mc_note_eval_acquisitions
          WHERE project = ?1 AND decision = '' AND expires_at <= ?2",
        params![project, now_ms - NOTE_EVAL_NO_WORK_RETENTION_MS],
    )?;
    tx.execute(
        "DELETE FROM mc_note_eval_claims
          WHERE project = ?1 AND terminal_kind IS NOT NULL
            AND terminal_at_ms IS NOT NULL AND terminal_at_ms <= ?2",
        params![project, now_ms - NOTE_EVAL_TERMINAL_RETENTION_MS],
    )?;
    Ok(())
}

impl McStore {
    /// The operation acquires one durable evaluation claim or a replayable `no_work` decision.
    /// `select` receives pending, unclaimed smart notes and returns either a `(note, phase)` claim or a classified `no_work` decision.
    /// `no_work` decisions retain their `cycle_exhausted` cause and commit atomically under `(project, acquisition_id)` uniqueness.
    /// For a given `(project, acquisition_id)`, response loss replays the original decision.
    #[allow(clippy::too_many_arguments)]
    pub fn acquire_note_evaluation(
        &self,
        project: &str,
        acquisition_id: &str,
        evaluator_instance: &str,
        evaluator_slot: i64,
        registration_generation: i64,
        select: impl FnOnce(&[NoteEvalCandidate]) -> NoteEvalSelection,
        now_ms: i64,
    ) -> Result<NoteEvalAcquireOutcome, McStoreError> {
        self.acquire_note_evaluation_with_cap(
            project,
            acquisition_id,
            evaluator_instance,
            evaluator_slot,
            registration_generation,
            select,
            now_ms,
            NOTE_EVAL_LEDGER_CAP,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn acquire_note_evaluation_with_cap(
        &self,
        project: &str,
        acquisition_id: &str,
        evaluator_instance: &str,
        evaluator_slot: i64,
        registration_generation: i64,
        select: impl FnOnce(&[NoteEvalCandidate]) -> NoteEvalSelection,
        now_ms: i64,
        ledger_cap: i64,
    ) -> Result<NoteEvalAcquireOutcome, McStoreError> {
        if project.is_empty()
            || !note_eval_valid_id(acquisition_id)
            || !note_eval_valid_id(evaluator_instance)
            || evaluator_slot < 0
        {
            return Ok(NoteEvalAcquireOutcome::Invalid);
        }
        self.with_note_conn_fenced(project, |tx| {
            collect_note_eval_ledgers_tx(tx, project, now_ms)?;
            let replayed_claim = tx
                .query_row(
                    &format!(
                        "SELECT {NOTE_EVAL_CLAIM_COLUMNS} FROM mc_note_eval_claims
                          WHERE project = ?1 AND acquisition_id = ?2"
                    ),
                    params![project, acquisition_id],
                    note_eval_claim_from_row,
                )
                .optional()?;
            if let Some(row) = replayed_claim {
                if let Some(kind) = row.terminal_kind {
                    return Ok(NoteEvalAcquireOutcome::Terminal {
                        kind,
                        response: row.terminal_response,
                    });
                }
                if row.claim.evaluator_instance != evaluator_instance
                    || row.claim.evaluator_slot != evaluator_slot
                {
                    return Ok(NoteEvalAcquireOutcome::Invalid);
                }
                return rebind_note_eval_claim_tx(
                    tx,
                    project,
                    row.claim,
                    acquisition_id,
                    registration_generation,
                    now_ms,
                );
            }
            let replayed_decision = tx
                .query_row(
                    "SELECT decision FROM mc_note_eval_acquisitions
                      WHERE project = ?1 AND acquisition_id = ?2",
                    params![project, acquisition_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(decision) = replayed_decision {
                return Ok(if decision.is_empty() {
                    NoteEvalAcquireOutcome::Expired
                } else {
                    NoteEvalAcquireOutcome::NoWork {
                        replayed: true,
                        cycle_exhausted: decision == "no_work_exhausted",
                    }
                });
            }
            let Some((authority_generation, protocol_epoch)) =
                note_eval_module_authority_tx(tx, project)?
            else {
                return Ok(NoteEvalAcquireOutcome::AuthorityChanged);
            };
            let slot_claim = tx
                .query_row(
                    &format!(
                        "SELECT {NOTE_EVAL_CLAIM_COLUMNS} FROM mc_note_eval_claims
                          WHERE project = ?1 AND evaluator_instance = ?2
                            AND evaluator_slot = ?3 AND terminal_kind IS NULL"
                    ),
                    params![project, evaluator_instance, evaluator_slot],
                    note_eval_claim_from_row,
                )
                .optional()?;
            if let Some(row) = slot_claim {
                return rebind_note_eval_claim_tx(
                    tx,
                    project,
                    row.claim,
                    acquisition_id,
                    registration_generation,
                    now_ms,
                );
            }
            let candidates = {
                let mut stmt = tx.prepare_cached(&format!(
                    "SELECT {NOTE_EVAL_CANDIDATE_COLUMNS} FROM mc_notes
                      WHERE project_path = ?1 AND type = 'smart' AND status = 'pending'
                        AND id NOT IN (SELECT note_id FROM mc_note_eval_claims
                                        WHERE project = ?1 AND terminal_kind IS NULL)
                      ORDER BY id"
                ))?;
                let rows = stmt
                    .query_map(params![project], note_eval_candidate_from_row)?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let (note_id, phase) = match select(&candidates) {
                NoteEvalSelection::Claim { note_id, phase } => (note_id, phase),
                NoteEvalSelection::NoWork { cycle_exhausted } => {
                    let live: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM mc_note_eval_acquisitions
                          WHERE project = ?1 AND decision <> ''",
                        params![project],
                        |row| row.get(0),
                    )?;
                    if live >= ledger_cap {
                        return Ok(NoteEvalAcquireOutcome::Busy);
                    }
                    tx.execute(
                        "INSERT INTO mc_note_eval_acquisitions(
                             project, acquisition_id, decision, created_at_ms, expires_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            project,
                            acquisition_id,
                            if cycle_exhausted {
                                "no_work_exhausted"
                            } else {
                                "no_work"
                            },
                            now_ms,
                            now_ms + NOTE_EVAL_NO_WORK_RETENTION_MS
                        ],
                    )?;
                    return Ok(NoteEvalAcquireOutcome::NoWork {
                        replayed: false,
                        cycle_exhausted,
                    });
                }
            };
            if !matches!(phase.as_str(), "compile" | "due" | "liveness" | "fallback") {
                return Ok(NoteEvalAcquireOutcome::Invalid);
            }
            let Some(candidate) = candidates.into_iter().find(|note| note.id == note_id) else {
                return Ok(NoteEvalAcquireOutcome::Invalid);
            };
            let note = load_note_tx(tx, candidate.id)?;
            // `collect_note_eval_ledgers_tx` instead.
            let live: i64 = tx.query_row(
                "SELECT COUNT(*) FROM mc_note_eval_claims
                  WHERE project = ?1 AND terminal_kind IS NULL",
                params![project],
                |row| row.get(0),
            )?;
            if live >= ledger_cap {
                return Ok(NoteEvalAcquireOutcome::Busy);
            }
            let claim = NoteEvalClaim {
                claim_id: {
                    let mut hasher = Sha256::new();
                    hasher.update(project.as_bytes());
                    hasher.update([0u8]);
                    hasher.update(acquisition_id.as_bytes());
                    format!("nec:{:x}", hasher.finalize())
                },
                note_id: note.id,
                phase,
                acquisition_id: acquisition_id.to_string(),
                evaluator_instance: evaluator_instance.to_string(),
                evaluator_slot,
                registration_generation,
                source_revision: note.source_revision,
                state_version: note.state_version,
                policy_version: note.policy_version.unwrap_or(1),
                protocol_epoch,
                authority_generation,
                expires_at: now_ms + NOTE_EVAL_CLAIM_LEASE_MS,
            };
            tx.execute(
                "INSERT INTO mc_note_eval_claims(
                     claim_id, project, note_id, phase, acquisition_id, evaluator_instance,
                     evaluator_slot, registration_generation, source_revision, state_version,
                     policy_version, protocol_epoch, authority_generation, expires_at,
                     created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    claim.claim_id,
                    project,
                    claim.note_id,
                    claim.phase,
                    claim.acquisition_id,
                    claim.evaluator_instance,
                    claim.evaluator_slot,
                    claim.registration_generation,
                    claim.source_revision,
                    claim.state_version,
                    claim.policy_version,
                    claim.protocol_epoch,
                    claim.authority_generation,
                    claim.expires_at,
                    now_ms,
                ],
            )?;
            Ok(NoteEvalAcquireOutcome::Claim {
                claim,
                note,
                replayed: false,
            })
        })
    }

    pub fn renew_note_evaluation_claim(
        &self,
        project: &str,
        claim_id: &str,
        evaluator_instance: &str,
        evaluator_slot: i64,
        registration_generation: i64,
        now_ms: i64,
    ) -> Result<NoteEvalRenewOutcome, McStoreError> {
        self.with_note_conn_fenced(project, |tx| {
            let Some(row) = load_note_eval_claim_tx(tx, project, claim_id)? else {
                return Ok(NoteEvalRenewOutcome::UnknownClaim);
            };
            if let Some(kind) = row.terminal_kind {
                return Ok(NoteEvalRenewOutcome::TerminalReplay {
                    kind,
                    response: row.terminal_response,
                });
            }
            if row.claim.evaluator_instance != evaluator_instance
                || row.claim.evaluator_slot != evaluator_slot
            {
                return Ok(NoteEvalRenewOutcome::Invalid);
            }
            if row.claim.expires_at <= now_ms {
                mark_note_eval_claim_terminal_tx(
                    tx,
                    project,
                    claim_id,
                    "expired",
                    None,
                    &note_eval_kind_response("expired"),
                    now_ms,
                )?;
                return Ok(NoteEvalRenewOutcome::Expired);
            }
            match note_eval_module_authority_tx(tx, project)? {
                Some((generation, _)) if generation == row.claim.authority_generation => {}
                _ => return Ok(NoteEvalRenewOutcome::AuthorityChanged),
            }
            let expires_at = now_ms + NOTE_EVAL_CLAIM_LEASE_MS;
            tx.execute(
                "UPDATE mc_note_eval_claims
                    SET expires_at = ?1, registration_generation = ?2
                  WHERE project = ?3 AND claim_id = ?4 AND terminal_kind IS NULL",
                params![expires_at, registration_generation, project, claim_id],
            )?;
            Ok(NoteEvalRenewOutcome::Renewed { expires_at })
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn complete_note_evaluation(
        &self,
        project: &str,
        claim_id: &str,
        completion_id: &str,
        evaluator_instance: &str,
        evaluator_slot: i64,
        now_ms: i64,
        apply: impl FnOnce(&NoteEvalClaim, &StoredNote) -> Result<NoteEvalReducedState, String>,
    ) -> Result<NoteEvalCompleteOutcome, McStoreError> {
        if !note_eval_valid_id(completion_id) {
            return Ok(NoteEvalCompleteOutcome::Conflict { kind: "invalid" });
        }
        self.with_note_conn_fenced(project, |tx| {
            let Some(row) = load_note_eval_claim_tx(tx, project, claim_id)? else {
                return Ok(NoteEvalCompleteOutcome::Conflict {
                    kind: "unknown_claim",
                });
            };
            if let Some(kind) = row.terminal_kind {
                return Ok(match row.completion_id {
                    Some(stored) if stored == completion_id => match row.terminal_response {
                        Some(response_json) => NoteEvalCompleteOutcome::Replayed { response_json },
                        None => NoteEvalCompleteOutcome::Conflict { kind: "expired" },
                    },
                    Some(_) => NoteEvalCompleteOutcome::Conflict {
                        kind: "completion_conflict",
                    },
                    None => NoteEvalCompleteOutcome::Conflict {
                        kind: match kind.as_str() {
                            "stale" => "stale",
                            "expired" => "expired",
                            "authority_changed" => "authority_changed",
                            _ => "invalid",
                        },
                    },
                });
            }
            if row.claim.evaluator_instance != evaluator_instance
                || row.claim.evaluator_slot != evaluator_slot
            {
                return Ok(NoteEvalCompleteOutcome::Conflict { kind: "invalid" });
            }
            if row.claim.expires_at <= now_ms {
                mark_note_eval_claim_terminal_tx(
                    tx,
                    project,
                    claim_id,
                    "expired",
                    None,
                    &note_eval_kind_response("expired"),
                    now_ms,
                )?;
                return Ok(NoteEvalCompleteOutcome::Conflict { kind: "expired" });
            }
            match note_eval_module_authority_tx(tx, project)? {
                Some((generation, _)) if generation == row.claim.authority_generation => {}
                _ => {
                    mark_note_eval_claim_terminal_tx(
                        tx,
                        project,
                        claim_id,
                        "authority_changed",
                        None,
                        &note_eval_kind_response("authority_changed"),
                        now_ms,
                    )?;
                    return Ok(NoteEvalCompleteOutcome::Conflict {
                        kind: "authority_changed",
                    });
                }
            }
            let stale = |tx: &rusqlite::Transaction<'_>| -> rusqlite::Result<_> {
                mark_note_eval_claim_terminal_tx(
                    tx,
                    project,
                    claim_id,
                    "stale",
                    None,
                    &note_eval_kind_response("stale"),
                    now_ms,
                )?;
                Ok(NoteEvalCompleteOutcome::Conflict { kind: "stale" })
            };
            let note = load_note_tx(tx, row.claim.note_id).optional()?;
            let Some(note) = note.filter(|note| note.project_path == project) else {
                return stale(tx);
            };
            if note.source_revision != row.claim.source_revision
                || note.state_version != row.claim.state_version
                || note.status != "pending"
            {
                return stale(tx);
            }
            let reduced = match apply(&row.claim, &note) {
                Ok(reduced) => reduced,
                Err(message) => {
                    let response = serde_json::json!({
                        "result": "invalid",
                        "error": note_eval_bound_response(&message),
                    })
                    .to_string();
                    mark_note_eval_claim_terminal_tx(
                        tx,
                        project,
                        claim_id,
                        "invalid",
                        None,
                        &note_eval_bound_response(&response),
                        now_ms,
                    )?;
                    return Ok(NoteEvalCompleteOutcome::Conflict { kind: "invalid" });
                }
            };
            if !matches!(reduced.status.as_str(), "pending" | "ready") {
                mark_note_eval_claim_terminal_tx(
                    tx,
                    project,
                    claim_id,
                    "invalid",
                    None,
                    &note_eval_kind_response("invalid"),
                    now_ms,
                )?;
                return Ok(NoteEvalCompleteOutcome::Conflict { kind: "invalid" });
            }
            let changed = tx.execute(
                "UPDATE mc_notes SET status = ?1, ready_at = ?2, ready_reason = ?3,
                    last_checked_at = ?4, updated_at_ms = ?5, compiled_check = ?6,
                    manifest_json = ?7, check_hash = ?8, check_cron = ?9, check_version = ?10,
                    check_status = ?11, check_failure_count = ?12,
                    check_network_failure_count = ?13, check_quarantined_until = ?14,
                    check_next_due_at = ?15, check_compiled_at = ?16,
                    check_false_since_at = ?17, check_last_liveness_at = ?18,
                    policy_version = ?19, compiled_source_revision = ?20,
                    compiled_project_path = ?21,
                    status_version = status_version + 1, state_version = state_version + 1
                  WHERE id = ?22 AND project_path = ?23 AND status = 'pending'
                    AND state_version = ?24",
                params![
                    reduced.status,
                    reduced.ready_at,
                    reduced.ready_reason,
                    reduced.last_checked_at,
                    reduced.updated_at_ms,
                    reduced.compiled_check,
                    reduced.manifest_json,
                    reduced.check_hash,
                    reduced.check_cron,
                    reduced.check_version.unwrap_or(0),
                    reduced.check_status,
                    reduced.check_failure_count,
                    reduced.check_network_failure_count,
                    reduced.check_quarantined_until,
                    reduced.check_next_due_at,
                    reduced.check_compiled_at,
                    reduced.check_false_since_at,
                    reduced.check_last_liveness_at,
                    reduced.policy_version.unwrap_or(1),
                    reduced.compiled_source_revision,
                    reduced.compiled_project_path,
                    row.claim.note_id,
                    project,
                    row.claim.state_version,
                ],
            )?;
            if changed == 0 {
                return stale(tx);
            }
            let response_json = serde_json::json!({
                "result": "applied",
                "note_id": row.claim.note_id,
                "status": reduced.status,
                "state_version": row.claim.state_version + 1,
                "check_status": reduced.check_status,
            })
            .to_string();
            mark_note_eval_claim_terminal_tx(
                tx,
                project,
                claim_id,
                "applied",
                Some(completion_id),
                &response_json,
                now_ms,
            )?;
            Ok(NoteEvalCompleteOutcome::Applied { response_json })
        })
    }

    pub fn abandon_note_evaluation_claim(
        &self,
        project: &str,
        claim_id: &str,
        evaluator_instance: &str,
        evaluator_slot: i64,
        now_ms: i64,
    ) -> Result<NoteEvalAbandonOutcome, McStoreError> {
        self.with_note_conn_fenced(project, |tx| {
            let Some(row) = load_note_eval_claim_tx(tx, project, claim_id)? else {
                return Ok(NoteEvalAbandonOutcome::UnknownClaim);
            };
            if let Some(kind) = row.terminal_kind {
                return Ok(NoteEvalAbandonOutcome::Replayed { kind });
            }
            if row.claim.evaluator_instance != evaluator_instance
                || row.claim.evaluator_slot != evaluator_slot
            {
                return Ok(NoteEvalAbandonOutcome::Invalid);
            }
            mark_note_eval_claim_terminal_tx(
                tx,
                project,
                claim_id,
                "abandoned",
                None,
                &note_eval_kind_response("abandoned"),
                now_ms,
            )?;
            Ok(NoteEvalAbandonOutcome::Abandoned)
        })
    }
}

fn rebind_note_eval_claim_tx(
    tx: &rusqlite::Transaction<'_>,
    project: &str,
    mut claim: NoteEvalClaim,
    acquisition_id: &str,
    registration_generation: i64,
    now_ms: i64,
) -> rusqlite::Result<NoteEvalAcquireOutcome> {
    let expires_at = now_ms + NOTE_EVAL_CLAIM_LEASE_MS;
    tx.execute(
        "UPDATE mc_note_eval_claims
            SET registration_generation = ?1, expires_at = ?2, acquisition_id = ?3
          WHERE project = ?4 AND claim_id = ?5 AND terminal_kind IS NULL",
        params![
            registration_generation,
            expires_at,
            acquisition_id,
            project,
            claim.claim_id
        ],
    )?;
    claim.registration_generation = registration_generation;
    claim.expires_at = expires_at;
    claim.acquisition_id = acquisition_id.to_string();
    let note = load_note_tx(tx, claim.note_id)
        .optional()?
        .filter(|note| note.project_path == project);
    let Some(note) = note else {
        return Ok(NoteEvalAcquireOutcome::Invalid);
    };
    Ok(NoteEvalAcquireOutcome::Claim {
        claim,
        note,
        replayed: true,
    })
}

/// digest.
///
/// legacy artifact.
pub fn note_check_digest(
    surface_condition: Option<&str>,
    compiled_check: &str,
    manifest_json: Option<&str>,
    check_cron: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(surface_condition.unwrap_or("").as_bytes());
    hasher.update(b"\0");
    hasher.update(compiled_check.as_bytes());
    hasher.update(b"\0");
    hasher.update(manifest_json.unwrap_or("").as_bytes());
    hasher.update(b"\0");
    hasher.update(check_cron.unwrap_or("").as_bytes());
    format!("{:x}", hasher.finalize())
}

fn repair_note_artifacts_tx(
    tx: &rusqlite::Transaction<'_>,
    project_path: &str,
) -> rusqlite::Result<usize> {
    struct Candidate {
        id: i64,
        surface_condition: Option<String>,
        compiled_check: String,
        manifest_json: Option<String>,
        check_hash: Option<String>,
        check_cron: Option<String>,
        source_revision: i64,
    }
    let candidates = {
        let mut statement = tx.prepare_cached(
            "SELECT id, surface_condition, compiled_check, manifest_json, check_hash,
                    check_cron, source_revision
               FROM mc_notes
              WHERE project_path = ?1 AND compiled_check IS NOT NULL
                AND compiled_source_revision IS NULL
              ORDER BY id
              LIMIT ?2",
        )?;
        let rows = statement
            .query_map(params![project_path, NOTE_ARTIFACT_REPAIR_BATCH], |row| {
                Ok(Candidate {
                    id: row.get(0)?,
                    surface_condition: row.get(1)?,
                    compiled_check: row.get(2)?,
                    manifest_json: row.get(3)?,
                    check_hash: row.get(4)?,
                    check_cron: row.get(5)?,
                    source_revision: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let processed = candidates.len();
    for candidate in candidates {
        let verified = match candidate.check_hash.as_deref() {
            None => true,
            Some(hash) => {
                note_check_digest(
                    candidate.surface_condition.as_deref(),
                    &candidate.compiled_check,
                    candidate.manifest_json.as_deref(),
                    candidate.check_cron.as_deref(),
                ) == hash
            }
        };
        if verified {
            tx.execute(
                "UPDATE mc_notes
                    SET compiled_source_revision = ?1, compiled_project_path = ?2
                  WHERE id = ?3",
                params![candidate.source_revision, project_path, candidate.id],
            )?;
        } else {
            tx.execute(
                "UPDATE mc_notes
                    SET compiled_check = NULL, manifest_json = NULL, check_hash = NULL,
                        check_cron = NULL, compiled_source_revision = NULL,
                        compiled_project_path = NULL, check_version = 0,
                        check_status = 'uncompiled'
                  WHERE id = ?1",
                params![candidate.id],
            )?;
        }
    }
    Ok(processed)
}

fn sql_like_pattern(query: &str) -> String {
    let mut escaped = String::new();
    for ch in query.trim().to_lowercase().chars() {
        match ch {
            '\\' | '%' | '_' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    format!("%{escaped}%")
}

fn canonical_authority_value(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_authority_value)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| *key);
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_authority_value(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn idle_historian_after_success(firing_seq: u64) -> HistorianDurableState {
    HistorianDurableState {
        firing_seq,
        ..HistorianDurableState::default()
    }
}

fn wrapup_replaced_failure_summary(summary: &str, failed_created_at: i64) -> String {
    const SUMMARY_MAX_CHARS: usize = 500;

    let suffix = format!("; replaced failed record from {failed_created_at}");
    let prefix_chars = SUMMARY_MAX_CHARS.saturating_sub(suffix.chars().count());
    format!(
        "{}{}",
        summary.chars().take(prefix_chars).collect::<String>(),
        suffix
    )
}

fn capped_trace_error(error: &str) -> String {
    error.chars().take(2000).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend};

    fn descriptor(dir: &std::path::Path) -> StorageDescriptor {
        StorageDescriptor {
            module_id: "magic-context-test".to_string(),
            storage_namespace: "mc_cache".to_string(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().to_string(),
            },
        }
    }

    fn commit_scheduler_observation(
        store: &McStore,
        session_id: &str,
        expected: Option<u64>,
        observation: &PassSchedulerObservation,
        interest: (
            bool,
            Option<u64>,
            Option<u64>,
            Option<u64>,
            Option<u64>,
            u64,
        ),
        request_observed_at_ms: Option<u64>,
        full_array_fingerprint: Option<&str>,
    ) -> u64 {
        let (
            produced_output_divergence,
            eligible_supersession_count,
            withheld_by_tag_window_count,
            withheld_by_exempt_message_count,
            applied_supersession_count,
            applied_reduction_count,
        ) = interest;
        let core = CoreState::default();
        let meta = ModuleMeta::default();
        store
            .commit_transform(
                session_id,
                TransformCommit {
                    expected,
                    core: &core,
                    meta: &meta,
                    consumed_drop_ids: &[],
                    first_applied_command_ids: &[],
                    claim_snapshot_vector: None,
                    compartment_max_seq: None,
                    project_root: None,
                    first_divergence: produced_output_divergence.then_some("{}"),
                    scheduler_observation: Some(observation),
                    scheduler_request_observed_at_ms: request_observed_at_ms,
                    scheduler_full_array_fingerprint: full_array_fingerprint,
                    scheduler_eligible_supersession_count: eligible_supersession_count,
                    scheduler_withheld_by_tag_window: withheld_by_tag_window_count,
                    scheduler_withheld_by_exempt_message: withheld_by_exempt_message_count,
                    scheduler_applied_supersession_count: applied_supersession_count,
                    scheduler_applied_reductions: applied_reduction_count > 0,
                    overlays: TransformOverlayBatch::default(),
                },
            )
            .unwrap()
    }

    fn command_ledger_ids(store: &McStore, session_id: &str) -> Vec<String> {
        command_ledger_rows(store, session_id)
            .into_iter()
            .map(|(command_id, _)| command_id)
            .collect()
    }

    fn command_ledger_rows(store: &McStore, session_id: &str) -> Vec<(String, Option<String>)> {
        store
            .inner
            .with_conn(|conn| {
                let mut statement = conn.prepare_cached(
                    "SELECT command_id, disposition
                     FROM mc_reduce_command_ledger
                     WHERE session_id = ?1
                     ORDER BY queued_at_ms ASC, command_id ASC",
                )?;
                let rows = statement
                    .query_map(params![session_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
                let mut commands = Vec::new();
                for row in rows {
                    commands.push(row?);
                }
                Ok(commands)
            })
            .unwrap()
    }

    #[test]
    fn bootstrap_load_returns_uninitialized_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let loaded = store.load("ses_a").unwrap();
        assert!(!loaded.meta.initialized);
        assert_eq!(loaded.row_version, None);
        assert_eq!(loaded.core, CoreState::default());
    }

    #[test]
    fn delete_session_clears_owned_rows_without_touching_another_session() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let core = CoreState::default();
        let meta = ModuleMeta::default();
        store.commit("ses_delete", None, &core, &meta).unwrap();
        store.commit("ses_keep", None, &core, &meta).unwrap();
        store
            .insert_note(NoteInput {
                project_path: "/project",
                route_project_root: None,
                session_id: "ses_delete",
                content: "session note",
                surface_condition: None,
                anchor_block_id: None,
                now_ms: 1,
            })
            .unwrap();
        store
            .insert_project_note(NoteWriteInput {
                project_path: "/project",
                route_project_root: None,
                session_id: Some("ses_delete"),
                content: "smart note",
                surface_condition: Some("later"),
                anchor_block_id: None,
                anchor_ordinal: None,
                compiled_provider: None,
                compiled_config: None,
                compiled_at: None,
                compile_status: None,
                now_ms: 1,
            })
            .unwrap();
        for session_id in ["ses_delete", "ses_keep"] {
            store
                .mint_or_get_tags(
                    session_id,
                    &[TagMintInput {
                        block_id: format!("{session_id}#0"),
                        kind: "message".to_string(),
                        token_count: 1,
                        source_bytes: b"source".to_vec(),
                    }],
                    1,
                )
                .unwrap();
            store
                .append_pending_agent_drops(session_id, &[format!("{session_id}#0")], 1)
                .unwrap();
        }

        assert!(store.delete_session("ses_delete", "/project").unwrap() >= 3);
        assert!(!store.has_cache_state("ses_delete").unwrap());
        assert!(store
            .load_tags_for_session("ses_delete")
            .unwrap()
            .is_empty());
        assert!(store
            .load_pending_agent_drops("ses_delete")
            .unwrap()
            .is_empty());
        let remaining_note_types = store
            .inner
            .with_conn(|conn| {
                let mut stmt = conn.prepare_cached(
                    "SELECT type FROM mc_notes WHERE session_id = 'ses_delete' ORDER BY id",
                )?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(remaining_note_types, vec!["smart".to_string()]);
        assert!(store.has_cache_state("ses_keep").unwrap());
        assert_eq!(store.load_tags_for_session("ses_keep").unwrap().len(), 1);
        assert_eq!(store.load_pending_agent_drops("ses_keep").unwrap().len(), 1);
    }

    #[test]
    fn commit_then_load_roundtrips_and_bumps_row_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();

        let core = CoreState {
            boundary_id: "b1".into(),
            ..Default::default()
        };
        let meta = ModuleMeta {
            initialized: true,
            last_render_config: "cfg1".into(),
            coverage_ordinal: Some(42),
            last_todo_state: Some(
                r#"[{"content":"persist me","status":"pending","priority":"high"}]"#.into(),
            ),
            m1_revision: 0,
            ..Default::default()
        };

        let v1 = store.commit("ses_a", None, &core, &meta).unwrap();
        assert_eq!(v1, 1);

        let loaded = store.load("ses_a").unwrap();
        assert_eq!(loaded.row_version, Some(1));
        assert_eq!(loaded.core.boundary_id, "b1");
        assert_eq!(loaded.meta, meta);

        let v2 = store.commit("ses_a", Some(1), &core, &meta).unwrap();
        assert_eq!(v2, 2);
    }

    #[test]
    fn boundary_divergence_counter_cas_loser_does_not_double_increment_and_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let session = "counter-cas";
        let core = CoreState::default();
        let initial_meta = ModuleMeta {
            boundary_divergence_pending_count: 0,
            ..Default::default()
        };
        store.commit(session, None, &core, &initial_meta).unwrap();

        let left = store.load(session).unwrap();
        let right = store.load(session).unwrap();
        assert_eq!(left.row_version, Some(1));
        assert_eq!(right.row_version, Some(1));

        let mut left_meta = left.meta.clone();
        left_meta.boundary_divergence_pending_count = 1;
        store
            .commit(session, left.row_version, &left.core, &left_meta)
            .unwrap();

        let mut right_meta = right.meta.clone();
        right_meta.boundary_divergence_pending_count = 1;
        let loser = store.commit(session, right.row_version, &right.core, &right_meta);
        assert!(matches!(
            loser,
            Err(McStoreError::CasConflict {
                expected: Some(1),
                found: 2
            })
        ));
        assert_eq!(
            store
                .load(session)
                .unwrap()
                .meta
                .boundary_divergence_pending_count,
            1
        );

        drop(store);
        let reopened = McStore::open(&descriptor(dir.path())).unwrap();
        assert_eq!(
            reopened
                .load(session)
                .unwrap()
                .meta
                .boundary_divergence_pending_count,
            1
        );
    }

    #[test]
    fn transform_session_root_lineage_is_cache_committed_and_pruned_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0);

        let commit_root = |session_id: &str, expected: Option<u64>, observed_at: i64| {
            let loaded = store.load(session_id).unwrap();
            store
                .commit_transform(
                    session_id,
                    TransformCommit {
                        expected,
                        core: &loaded.core,
                        meta: &loaded.meta,
                        consumed_drop_ids: &[],
                        first_applied_command_ids: &[],
                        claim_snapshot_vector: None,
                        compartment_max_seq: None,
                        project_root: Some("/root-a"),
                        first_divergence: None,
                        scheduler_observation: None,
                        scheduler_request_observed_at_ms: None,
                        scheduler_full_array_fingerprint: None,
                        scheduler_eligible_supersession_count: None,
                        scheduler_withheld_by_tag_window: None,
                        scheduler_withheld_by_exempt_message: None,
                        scheduler_applied_supersession_count: None,
                        scheduler_applied_reductions: false,
                        overlays: TransformOverlayBatch {
                            created_at_ms: observed_at,
                            ..Default::default()
                        },
                    },
                )
                .unwrap()
        };

        commit_root("refreshed", None, 1);
        commit_root("refreshed", Some(1), now_ms);
        commit_root("idle-live", None, 1);
        commit_root("deleted", None, 1);
        store
            .inner
            .with_conn(|conn| {
                conn.execute(
                    "DELETE FROM mc_cache_state WHERE session_id = 'deleted'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        drop(store);

        let reopened = McStore::open(&descriptor(dir.path())).unwrap();
        assert!(reopened
            .knows_transform_session_root("refreshed", "/root-a")
            .unwrap());
        assert!(!reopened
            .knows_transform_session_root("refreshed", "/root-b")
            .unwrap());
        assert!(reopened
            .knows_transform_session_root("idle-live", "/root-a")
            .unwrap());
        assert!(reopened.has_cache_state("idle-live").unwrap());
        assert!(!reopened
            .knows_transform_session_root("deleted", "/root-a")
            .unwrap());
        assert!(!reopened.has_cache_state("deleted").unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn transform_session_roots_canonicalize_writes_and_match_legacy_symlink_rows() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = dir.path().join("link");
        symlink(&target, &link).unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let canonical_target = canonical_root(&target);
        let target_text = canonical_target.to_str().unwrap();
        let link_text = link.to_str().unwrap();

        let initial = store.load("canonical-write").unwrap();
        store
            .commit_transform(
                "canonical-write",
                TransformCommit {
                    expected: initial.row_version,
                    core: &initial.core,
                    meta: &initial.meta,
                    consumed_drop_ids: &[],
                    first_applied_command_ids: &[],
                    claim_snapshot_vector: None,
                    compartment_max_seq: None,
                    project_root: Some(link_text),
                    first_divergence: None,
                    scheduler_observation: None,
                    scheduler_request_observed_at_ms: None,
                    scheduler_full_array_fingerprint: None,
                    scheduler_eligible_supersession_count: None,
                    scheduler_withheld_by_tag_window: None,
                    scheduler_withheld_by_exempt_message: None,
                    scheduler_applied_supersession_count: None,
                    scheduler_applied_reductions: false,
                    overlays: TransformOverlayBatch::default(),
                },
            )
            .unwrap();
        let stored_root: String = store
            .inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT project_root FROM mc_transform_session_roots
                      WHERE session_id = 'canonical-write'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(stored_root, target_text);
        assert!(store
            .knows_transform_session_root("canonical-write", link_text)
            .unwrap());
        assert!(store
            .knows_transform_session_root("canonical-write", target_text)
            .unwrap());

        store
            .commit(
                "legacy-row",
                None,
                &CoreState::default(),
                &ModuleMeta::default(),
            )
            .unwrap();
        store
            .inner
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO mc_transform_session_roots
                         (session_id, project_root, observed_at)
                     VALUES ('legacy-row', ?1, 1)",
                    params![link_text],
                )?;
                Ok(())
            })
            .unwrap();
        assert!(store
            .knows_transform_session_root("legacy-row", target_text)
            .unwrap());
        assert!(store
            .knows_transform_session_root("legacy-row", link_text)
            .unwrap());

        let missing = dir.path().join("gone");
        assert_eq!(canonical_root(&missing), missing);
        let missing_text = missing.to_str().unwrap();
        let missing_initial = store.load("missing-root").unwrap();
        store
            .commit_transform(
                "missing-root",
                TransformCommit {
                    expected: missing_initial.row_version,
                    core: &missing_initial.core,
                    meta: &missing_initial.meta,
                    consumed_drop_ids: &[],
                    first_applied_command_ids: &[],
                    claim_snapshot_vector: None,
                    compartment_max_seq: None,
                    project_root: Some(missing_text),
                    first_divergence: None,
                    scheduler_observation: None,
                    scheduler_request_observed_at_ms: None,
                    scheduler_full_array_fingerprint: None,
                    scheduler_eligible_supersession_count: None,
                    scheduler_withheld_by_tag_window: None,
                    scheduler_withheld_by_exempt_message: None,
                    scheduler_applied_supersession_count: None,
                    scheduler_applied_reductions: false,
                    overlays: TransformOverlayBatch::default(),
                },
            )
            .unwrap();
        assert!(store
            .knows_transform_session_root("missing-root", missing_text)
            .unwrap());
        assert!(!store
            .knows_transform_session_root("missing-root", "/another/gone")
            .unwrap());
    }

    #[test]
    fn stale_cas_expectation_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let core = CoreState::default();
        let meta = ModuleMeta::default();

        store.commit("ses_a", None, &core, &meta).unwrap(); // row_version now 1
        let err = store.commit("ses_a", None, &core, &meta).unwrap_err();
        match err {
            McStoreError::CasConflict { expected, found } => {
                assert_eq!(expected, None);
                assert_eq!(found, 1);
            }
            other => panic!("expected CasConflict, got {other}"),
        }
    }

    #[test]
    fn transform_snapshot_resists_commit_between_state_and_overlay_reads() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = descriptor(dir.path());
        let store = McStore::open(&descriptor).unwrap();
        let initial = store.load("ses").unwrap();
        store
            .commit("ses", initial.row_version, &initial.core, &initial.meta)
            .unwrap();
        let raw_path = match &descriptor.backend {
            StorageBackend::Sqlite { path } => path,
            _ => unreachable!("test descriptor is SQLite"),
        };
        let mut raw = rusqlite::Connection::open(raw_path).unwrap();
        raw.pragma_update(None, "busy_timeout", 5_000).unwrap();
        let core_json = serde_json::to_string(&initial.core).unwrap();
        let meta_json = serde_json::to_string(&initial.meta).unwrap();

        let snapshot = store
            .load_transform_snapshot_with_hook("ses", || {
                let transaction = raw.transaction().unwrap();
                transaction
                    .execute(
                        "UPDATE mc_cache_state SET row_version = 2, core_state = ?2, meta = ?3
                         WHERE session_id = ?1",
                        params!["ses", core_json, meta_json],
                    )
                    .unwrap();
                transaction
                    .execute(
                        "INSERT INTO mc_tags
                             (session_id, tag_number, block_id, kind, token_count, created_at_ms, source_bytes)
                         VALUES (?1, 1, 'm1#0', 'message', 1, 10, ?2)",
                        params!["ses", b"text".as_slice()],
                    )
                    .unwrap();
                transaction
                    .execute(
                        "INSERT INTO mc_overlay_frontiers (session_id, max_seen_ordinal)
                         VALUES (?1, 1)",
                        params!["ses"],
                    )
                    .unwrap();
                transaction.commit().unwrap();
            })
            .unwrap();
        assert_eq!(snapshot.loaded.row_version, Some(1));
        assert_eq!(snapshot.overlay_frontier, None);
        let current = store.load_transform_snapshot("ses").unwrap();
        assert_eq!(current.loaded.row_version, Some(2));
        assert_eq!(store.load_tags_for_session("ses").unwrap().len(), 1);
        assert_eq!(current.overlay_frontier, Some(1));
    }

    #[test]
    fn transform_snapshot_keeps_row_version_and_overlays_from_one_commit() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let initial = store.load("ses").unwrap();
        store
            .commit("ses", initial.row_version, &initial.core, &initial.meta)
            .unwrap();

        let split_state = store.load("ses").unwrap();
        let tag_mints = [McTagRow {
            tag_number: 1,
            block_id: "m1#0".to_string(),
            kind: "message".to_string(),
            token_count: 4,
            created_at_ms: 10,
            source_bytes: b"authored text".to_vec(),
        }];
        let temporal_marks = [TemporalMarkInput {
            ordinal: 1,
            block_id: "m1#0".to_string(),
            marker_text: "<!-- +5m -->\n".to_string(),
        }];
        let hint = UserHintDecisionInput {
            ordinal: 1,
            block_id: "m1#0".to_string(),
            hint_text: "<ctx-search-hint>memory</ctx-search-hint>".to_string(),
        };
        let channel1 = Channel1AppendRow {
            block_id: "m1#0".to_string(),
            reminder_text: "<system-reminder>reduce</system-reminder>".to_string(),
            fired_at_ms: 10,
        };
        store
            .commit_transform(
                "ses",
                TransformCommit {
                    expected: split_state.row_version,
                    core: &split_state.core,
                    meta: &split_state.meta,
                    consumed_drop_ids: &[],
                    first_applied_command_ids: &[],
                    claim_snapshot_vector: None,
                    compartment_max_seq: None,
                    project_root: None,
                    first_divergence: None,
                    scheduler_observation: None,
                    scheduler_request_observed_at_ms: None,
                    scheduler_full_array_fingerprint: None,
                    scheduler_eligible_supersession_count: None,
                    scheduler_withheld_by_tag_window: None,
                    scheduler_withheld_by_exempt_message: None,
                    scheduler_applied_supersession_count: None,
                    scheduler_applied_reductions: false,
                    overlays: TransformOverlayBatch {
                        max_seen_ordinal: Some(1),
                        tag_mints: &tag_mints,
                        temporal_marks: &temporal_marks,
                        user_hint: Some(&hint),
                        channel1_append: Some(&channel1),
                        created_at_ms: 10,
                    },
                },
            )
            .unwrap();

        let split_tags = store.load_tags_for_session("ses").unwrap();
        assert_eq!(split_state.row_version, Some(1));
        assert_eq!(
            split_tags.len(),
            1,
            "a split read can mix v1 state with v2 overlays"
        );

        let snapshot = store.load_transform_snapshot("ses").unwrap();
        assert_eq!(snapshot.loaded.row_version, Some(2));
        assert_eq!(store.load_tags_for_session("ses").unwrap().len(), 1);
        assert_eq!(snapshot.temporal_marks.len(), 1);
        assert_eq!(snapshot.user_hints.len(), 1);
        assert_eq!(snapshot.channel1_appends.len(), 1);
        assert_eq!(snapshot.overlay_frontier, Some(1));
    }

    #[test]
    fn transform_cas_conflict_leaves_every_overlay_table_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let initial = store.load("ses").unwrap();
        store
            .commit("ses", initial.row_version, &initial.core, &initial.meta)
            .unwrap();
        let stale = store.load("ses").unwrap();
        store
            .commit("ses", stale.row_version, &stale.core, &stale.meta)
            .unwrap();

        let tags = [McTagRow {
            tag_number: 1,
            block_id: "m1#0".to_string(),
            kind: "message".to_string(),
            token_count: 1,
            created_at_ms: 1,
            source_bytes: b"text".to_vec(),
        }];
        let marks = [TemporalMarkInput {
            ordinal: 1,
            block_id: "m1#0".to_string(),
            marker_text: "marker".to_string(),
        }];
        let hint = UserHintDecisionInput {
            ordinal: 1,
            block_id: "m1#0".to_string(),
            hint_text: "hint".to_string(),
        };
        let channel1 = Channel1AppendRow {
            block_id: "m1#0".to_string(),
            reminder_text: "reminder".to_string(),
            fired_at_ms: 1,
        };
        let error = store
            .commit_transform(
                "ses",
                TransformCommit {
                    expected: stale.row_version,
                    core: &stale.core,
                    meta: &stale.meta,
                    consumed_drop_ids: &[],
                    first_applied_command_ids: &[],
                    claim_snapshot_vector: None,
                    compartment_max_seq: None,
                    project_root: None,
                    first_divergence: None,
                    scheduler_observation: None,
                    scheduler_request_observed_at_ms: None,
                    scheduler_full_array_fingerprint: None,
                    scheduler_eligible_supersession_count: None,
                    scheduler_withheld_by_tag_window: None,
                    scheduler_withheld_by_exempt_message: None,
                    scheduler_applied_supersession_count: None,
                    scheduler_applied_reductions: false,
                    overlays: TransformOverlayBatch {
                        max_seen_ordinal: Some(1),
                        tag_mints: &tags,
                        temporal_marks: &marks,
                        user_hint: Some(&hint),
                        channel1_append: Some(&channel1),
                        created_at_ms: 1,
                    },
                },
            )
            .unwrap_err();
        assert!(matches!(error, McStoreError::CasConflict { .. }));
        let snapshot = store.load_transform_snapshot("ses").unwrap();
        assert!(store.load_tags_for_session("ses").unwrap().is_empty());
        assert!(snapshot.temporal_marks.is_empty());
        assert!(snapshot.user_hints.is_empty());
        assert!(snapshot.channel1_appends.is_empty());
        assert_eq!(snapshot.overlay_frontier, None);
    }

    #[test]
    fn pending_agent_drops_delete_only_inside_successful_commit_tx() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        assert_eq!(
            store
                .append_pending_agent_drops("ses", &["a#0".to_string(), "a#0".to_string()], 7)
                .unwrap(),
            1,
            "duplicate pending ids are ignored while still queued"
        );
        let queued = store.load_pending_agent_drops("ses").unwrap();
        assert_eq!(queued.len(), 1);

        let core = CoreState::default();
        let meta = ModuleMeta::default();
        let conflict =
            store.commit_with_consumed_drops("ses", Some(99), &core, &meta, &[queued[0].id]);
        assert!(matches!(conflict, Err(McStoreError::CasConflict { .. })));
        assert_eq!(
            store.load_pending_agent_drops("ses").unwrap().len(),
            1,
            "a failed fenced commit leaves queued drops for retry"
        );

        store
            .commit_with_consumed_drops("ses", None, &core, &meta, &[queued[0].id])
            .unwrap();
        assert!(store.load_pending_agent_drops("ses").unwrap().is_empty());
        assert!(command_ledger_ids(&store, "ses").is_empty());
    }

    #[test]
    fn command_id_duplicate_is_recognized_while_drops_are_pending() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let target_ids = vec!["a#0".to_string()];

        let first = store
            .append_pending_agent_drops_with_command(
                "ses",
                Some("tool-use-1"),
                &target_ids,
                1,
                false,
            )
            .unwrap();
        assert_eq!(
            first,
            AppendOutcome {
                queued: 1,
                duplicate: false,
                disposition: None,
            }
        );
        let pending = store.load_pending_agent_drops("ses").unwrap();

        let retry = store
            .append_pending_agent_drops_with_command(
                "ses",
                Some("tool-use-1"),
                &target_ids,
                2,
                false,
            )
            .unwrap();
        assert_eq!(
            retry,
            AppendOutcome {
                queued: 0,
                duplicate: true,
                disposition: None,
            }
        );
        assert_eq!(store.load_pending_agent_drops("ses").unwrap(), pending);
        assert_eq!(command_ledger_ids(&store, "ses"), vec!["tool-use-1"]);
    }

    #[test]
    fn first_application_marker_is_atomic_and_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = descriptor(dir.path());
        let store = McStore::open(&descriptor).unwrap();
        let targets = vec!["a#0".to_string(), "b#0".to_string()];
        store
            .append_pending_agent_drops_with_command("ses", Some("batch-1"), &targets, 1, false)
            .unwrap();
        let pending = store.load_pending_agent_drops("ses").unwrap();
        let loaded = store.load("ses").unwrap();
        let command_ids = vec!["batch-1".to_string()];
        store
            .commit_transform(
                "ses",
                TransformCommit {
                    expected: loaded.row_version,
                    core: &loaded.core,
                    meta: &loaded.meta,
                    consumed_drop_ids: &[pending[0].id],
                    first_applied_command_ids: &command_ids,
                    claim_snapshot_vector: None,
                    compartment_max_seq: None,
                    project_root: None,
                    first_divergence: None,
                    scheduler_observation: None,
                    scheduler_request_observed_at_ms: None,
                    scheduler_full_array_fingerprint: None,
                    scheduler_eligible_supersession_count: None,
                    scheduler_withheld_by_tag_window: None,
                    scheduler_withheld_by_exempt_message: None,
                    scheduler_applied_supersession_count: None,
                    scheduler_applied_reductions: false,
                    overlays: TransformOverlayBatch::default(),
                },
            )
            .unwrap();
        let remaining = store.load_pending_agent_drops("ses").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].command_id.as_deref(), Some("batch-1"));
        assert_eq!(remaining[0].command_first_applied_at_ms, Some(0));
        drop(store);

        let reopened = McStore::open(&descriptor).unwrap();
        let persisted = reopened.load_pending_agent_drops("ses").unwrap();
        assert_eq!(persisted, remaining);
    }

    #[test]
    fn command_id_duplicate_survives_consumption() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let target_ids = vec!["a#0".to_string()];
        store
            .append_pending_agent_drops_with_command(
                "ses",
                Some("tool-use-1"),
                &target_ids,
                1,
                false,
            )
            .unwrap();
        let pending = store.load_pending_agent_drops("ses").unwrap();
        store
            .commit_with_consumed_drops(
                "ses",
                None,
                &CoreState::default(),
                &ModuleMeta::default(),
                &[pending[0].id],
            )
            .unwrap();
        assert!(store.load_pending_agent_drops("ses").unwrap().is_empty());

        let retry = store
            .append_pending_agent_drops_with_command(
                "ses",
                Some("tool-use-1"),
                &target_ids,
                2,
                false,
            )
            .unwrap();
        assert_eq!(
            retry,
            AppendOutcome {
                queued: 0,
                duplicate: true,
                disposition: None,
            }
        );
    }

    #[test]
    fn different_command_id_requeues_after_consumption() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let target_ids = vec!["a#0".to_string()];
        store
            .append_pending_agent_drops_with_command(
                "ses",
                Some("tool-use-1"),
                &target_ids,
                1,
                false,
            )
            .unwrap();
        let pending = store.load_pending_agent_drops("ses").unwrap();
        store
            .commit_with_consumed_drops(
                "ses",
                None,
                &CoreState::default(),
                &ModuleMeta::default(),
                &[pending[0].id],
            )
            .unwrap();

        let next = store
            .append_pending_agent_drops_with_command(
                "ses",
                Some("tool-use-2"),
                &target_ids,
                2,
                false,
            )
            .unwrap();
        assert_eq!(
            next,
            AppendOutcome {
                queued: 1,
                duplicate: false,
                disposition: None,
            }
        );
    }

    #[test]
    fn failed_command_append_rolls_back_ledger_entry() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        store
            .inner
            .with_conn(|conn| {
                conn.execute_batch(
                    "CREATE TRIGGER fail_pending_agent_drop
                     BEFORE INSERT ON pending_agent_drops
                     BEGIN
                         SELECT RAISE(ABORT, 'forced pending append failure');
                     END;",
                )?;
                Ok(())
            })
            .unwrap();
        let target_ids = vec!["a#0".to_string()];

        assert!(store
            .append_pending_agent_drops_with_command(
                "ses",
                Some("tool-use-1"),
                &target_ids,
                1,
                false
            )
            .is_err());
        assert!(command_ledger_ids(&store, "ses").is_empty());
        assert!(store.load_pending_agent_drops("ses").unwrap().is_empty());

        store
            .inner
            .with_conn(|conn| {
                conn.execute_batch("DROP TRIGGER fail_pending_agent_drop")?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store
                .append_pending_agent_drops_with_command(
                    "ses",
                    Some("tool-use-1"),
                    &target_ids,
                    2,
                    false
                )
                .unwrap(),
            AppendOutcome {
                queued: 1,
                duplicate: false,
                disposition: None,
            }
        );
    }

    #[test]
    fn command_id_ledger_retains_rows_past_512_commands() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let target_ids = vec!["a#0".to_string()];

        for queued_at_ms in 0..513i64 {
            let command_id = format!("command-{queued_at_ms:03}");
            let outcome = store
                .append_pending_agent_drops_with_command(
                    "ses",
                    Some(&command_id),
                    &target_ids,
                    queued_at_ms,
                    false,
                )
                .unwrap();
            assert!(!outcome.duplicate);
        }

        let command_ids = command_ledger_ids(&store, "ses");
        assert_eq!(command_ids.len(), 513);
        assert_eq!(command_ids.first().map(String::as_str), Some("command-000"));
        assert_eq!(command_ids.last().map(String::as_str), Some("command-512"));

        let oldest_retry = store
            .append_pending_agent_drops_with_command(
                "ses",
                Some("command-000"),
                &target_ids,
                513,
                false,
            )
            .unwrap();
        assert!(oldest_retry.duplicate);
    }

    #[test]
    fn zero_target_append_records_ledger_row_with_no_targets_disposition() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();

        let outcome = store
            .append_pending_agent_drops_with_command("ses", Some("cmd-zero"), &[], 1, true)
            .unwrap();
        assert_eq!(
            outcome,
            AppendOutcome {
                queued: 0,
                duplicate: false,
                disposition: Some("no_targets".to_string()),
            }
        );
        assert!(store.load_pending_agent_drops("ses").unwrap().is_empty());

        let retry = store
            .append_pending_agent_drops_with_command("ses", Some("cmd-zero"), &[], 2, true)
            .unwrap();
        assert_eq!(
            retry,
            AppendOutcome {
                queued: 0,
                duplicate: true,
                disposition: None,
            }
        );

        let normal = store
            .append_pending_agent_drops_with_command(
                "ses",
                Some("cmd-normal"),
                &["a#0".to_string()],
                3,
                false,
            )
            .unwrap();
        assert_eq!(
            normal,
            AppendOutcome {
                queued: 1,
                duplicate: false,
                disposition: None,
            }
        );
        assert_eq!(store.load_pending_agent_drops("ses").unwrap().len(), 1);

        assert_eq!(
            command_ledger_rows(&store, "ses"),
            vec![
                ("cmd-zero".to_string(), Some("no_targets".to_string())),
                ("cmd-normal".to_string(), None),
            ]
        );
    }

    #[test]
    fn tags_mint_monotonically_and_channel1_appends_are_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let first = vec![
            TagMintInput {
                block_id: "m1#0".to_string(),
                kind: "message".to_string(),
                token_count: 11,
                source_bytes: b"message source".to_vec(),
            },
            TagMintInput {
                block_id: "m2#0".to_string(),
                kind: "tool_result".to_string(),
                token_count: 22,
                source_bytes: b"tool source".to_vec(),
            },
        ];
        let rows = store.mint_or_get_tags("ses", &first, 100).unwrap();
        assert_eq!(
            rows.iter().map(|row| row.tag_number).collect::<Vec<_>>(),
            vec![1, 2]
        );

        let second = vec![
            TagMintInput {
                block_id: "m1#0".to_string(),
                kind: "message".to_string(),
                token_count: 999,
                source_bytes: b"changed source must not overwrite".to_vec(),
            },
            TagMintInput {
                block_id: "m3#0".to_string(),
                kind: "tool_call".to_string(),
                token_count: 33,
                source_bytes: b"new source".to_vec(),
            },
        ];
        let rows = store.mint_or_get_tags("ses", &second, 200).unwrap();
        assert_eq!(
            rows.iter().map(|row| row.tag_number).collect::<Vec<_>>(),
            vec![1, 3],
            "existing block keeps its tag; only new observations consume the next number"
        );
        let all = store.load_tags_for_session("ses").unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(store.tag_number_query_count_for_test(), 0);
        assert_eq!(
            store.load_tag_numbers_for_session("ses").unwrap(),
            vec![
                TagNumberRow {
                    block_id: "m1#0".to_string(),
                    tag_number: 1,
                },
                TagNumberRow {
                    block_id: "m2#0".to_string(),
                    tag_number: 2,
                },
                TagNumberRow {
                    block_id: "m3#0".to_string(),
                    tag_number: 3,
                },
            ]
        );
        assert_eq!(store.tag_number_query_count_for_test(), 1);
        assert_eq!(
            store
                .load_tags_after("ses", 1)
                .unwrap()
                .into_iter()
                .map(|row| row.tag_number)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(
            store
                .load_tag_numbers_after("ses", 1)
                .unwrap()
                .into_iter()
                .map(|row| row.tag_number)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(
            store.tag_cache_summary("ses").unwrap(),
            TagCacheSummary {
                generation: 3,
                count: 3,
                max_tag_number: 3,
            }
        );
        store
            .execute_tag_sql_for_test(
                "UPDATE mc_tags SET source_bytes = X'706f69736f6e6564' WHERE session_id = 'ses' AND tag_number = 1",
            )
            .unwrap();
        assert_eq!(
            store.tag_cache_summary("ses").unwrap(),
            TagCacheSummary {
                generation: 5,
                count: 3,
                max_tag_number: 3,
            },
            "an update fires both OLD and NEW generation writes"
        );
        assert_eq!(
            all[0].token_count, 11,
            "token count is computed once at mint"
        );
        assert_eq!(
            all[0].source_bytes, b"message source",
            "pre-overlay provenance is immutable after the first mint"
        );
        let token_sum_ids = ["m1#0".to_string(), "m3#0".to_string()]
            .into_iter()
            .collect::<HashSet<_>>();
        assert_eq!(
            store
                .sum_tag_token_counts_for_blocks("ses", &token_sum_ids)
                .unwrap(),
            44
        );
        store
            .execute_tag_sql_for_test(
                "DELETE FROM mc_tags WHERE session_id = 'ses' AND tag_number = 3",
            )
            .unwrap();
        assert_eq!(
            store.tag_cache_summary("ses").unwrap(),
            TagCacheSummary {
                generation: 6,
                count: 2,
                max_tag_number: 2,
            },
            "deletion advances the generation and refreshes the cached table summary"
        );

        assert!(store
            .append_channel1_nudge(
                "ses",
                "m2#0",
                "\n\n<system-reminder>hi</system-reminder>",
                300
            )
            .unwrap());
        assert!(!store
            .append_channel1_nudge("ses", "m2#0", "different", 400)
            .unwrap());
        let appends = store.load_channel1_appends("ses").unwrap();
        assert_eq!(appends.len(), 1);
        assert_eq!(
            appends[0].reminder_text,
            "\n\n<system-reminder>hi</system-reminder>"
        );

        assert!(store.append_user_hint("ses", "m1#0", "", 500).unwrap());
        assert!(!store
            .append_user_hint("ses", "m1#0", "different", 600)
            .unwrap());
        assert!(store
            .append_user_hint(
                "ses",
                "m3#0",
                "\n\n<ctx-search-hint>hit</ctx-search-hint>",
                700
            )
            .unwrap());
        assert_eq!(
            store.load_user_hints("ses").unwrap(),
            vec![
                UserHintRow {
                    block_id: "m1#0".to_string(),
                    hint_text: String::new(),
                    created_at: 500,
                },
                UserHintRow {
                    block_id: "m3#0".to_string(),
                    hint_text: "\n\n<ctx-search-hint>hit</ctx-search-hint>".to_string(),
                    created_at: 700,
                },
            ]
        );
        assert_eq!(store.overlay_watermark("ses").unwrap(), None);
        store
            .apply_active_overlay_decisions("ses", 4, &[], None, 800)
            .unwrap();
        assert_eq!(store.overlay_watermark("ses").unwrap(), Some(4));
    }

    #[test]
    fn overlay_decisions_share_an_atomic_ordinal_watermark() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(McStore::open(&descriptor(dir.path())).unwrap());
        let initial = store.load("race").unwrap();
        store
            .commit("race", initial.row_version, &initial.core, &initial.meta)
            .unwrap();

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut joins = Vec::new();
        for hint_text in ["winner-a", "winner-b"] {
            let store = std::sync::Arc::clone(&store);
            let barrier = std::sync::Arc::clone(&barrier);
            joins.push(std::thread::spawn(move || {
                let loaded = store.load("race").unwrap();
                let temporal_marks = [TemporalMarkInput {
                    ordinal: 3,
                    block_id: "m3#0".to_string(),
                    marker_text: "<!-- +5m -->\n".to_string(),
                }];
                let hint = UserHintDecisionInput {
                    ordinal: 3,
                    block_id: "m3#0".to_string(),
                    hint_text: hint_text.to_string(),
                };
                barrier.wait();
                store.commit_transform(
                    "race",
                    TransformCommit {
                        expected: loaded.row_version,
                        core: &loaded.core,
                        meta: &loaded.meta,
                        consumed_drop_ids: &[],
                        first_applied_command_ids: &[],
                        claim_snapshot_vector: None,
                        compartment_max_seq: None,
                        project_root: None,
                        first_divergence: None,
                        scheduler_observation: None,
                        scheduler_request_observed_at_ms: None,
                        scheduler_full_array_fingerprint: None,
                        scheduler_eligible_supersession_count: None,
                        scheduler_withheld_by_tag_window: None,
                        scheduler_withheld_by_exempt_message: None,
                        scheduler_applied_supersession_count: None,
                        scheduler_applied_reductions: false,
                        overlays: TransformOverlayBatch {
                            max_seen_ordinal: Some(3),
                            temporal_marks: &temporal_marks,
                            user_hint: Some(&hint),
                            created_at_ms: 100,
                            ..Default::default()
                        },
                    },
                )
            }));
        }
        barrier.wait();
        let outcomes = joins
            .into_iter()
            .map(|join| join.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, Err(McStoreError::CasConflict { .. })))
                .count(),
            1
        );
        let winner = store.load_user_hints("race").unwrap();
        assert_eq!(winner.len(), 1);
        assert!(matches!(
            winner[0].hint_text.as_str(),
            "winner-a" | "winner-b"
        ));
        assert_eq!(store.overlay_watermark("race").unwrap(), Some(3));
        assert_eq!(store.load_temporal_marks("race").unwrap().len(), 1);

        let loaded = store.load("race").unwrap();
        let late_mark = [TemporalMarkInput {
            ordinal: 2,
            block_id: "m2#0".to_string(),
            marker_text: "late marker".to_string(),
        }];
        let late_hint = UserHintDecisionInput {
            ordinal: 2,
            block_id: "m2#0".to_string(),
            hint_text: "late hint".to_string(),
        };
        store
            .commit_transform(
                "race",
                TransformCommit {
                    expected: loaded.row_version,
                    core: &loaded.core,
                    meta: &loaded.meta,
                    consumed_drop_ids: &[],
                    first_applied_command_ids: &[],
                    claim_snapshot_vector: None,
                    compartment_max_seq: None,
                    project_root: None,
                    first_divergence: None,
                    scheduler_observation: None,
                    scheduler_request_observed_at_ms: None,
                    scheduler_full_array_fingerprint: None,
                    scheduler_eligible_supersession_count: None,
                    scheduler_withheld_by_tag_window: None,
                    scheduler_withheld_by_exempt_message: None,
                    scheduler_applied_supersession_count: None,
                    scheduler_applied_reductions: false,
                    overlays: TransformOverlayBatch {
                        max_seen_ordinal: Some(4),
                        temporal_marks: &late_mark,
                        user_hint: Some(&late_hint),
                        created_at_ms: 200,
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        assert_eq!(store.overlay_watermark("race").unwrap(), Some(4));
        assert_eq!(store.load_user_hints("race").unwrap().len(), 1);
        assert_eq!(store.load_temporal_marks("race").unwrap().len(), 1);
    }

    #[test]
    fn wrapup_command_ledger_keeps_the_first_terminal_result() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let first = store
            .record_wrapup_command("session", "command", "completed", 2, "done", 10)
            .unwrap();
        let retry = store
            .record_wrapup_command("session", "command", "nothing_to_compact", 9, "changed", 20)
            .unwrap();
        assert_eq!(retry, first);
        let rejected = store
            .record_wrapup_command("session", "failed-command", "failed", 9, "changed", 20)
            .unwrap_err();
        assert!(rejected
            .to_string()
            .contains("nonterminal wrapup disposition"));
        assert_eq!(
            store.load_wrapup_command("session", "command").unwrap(),
            Some(first)
        );
        assert!(store
            .load_wrapup_command("session", "failed-command")
            .unwrap()
            .is_none());
        assert!(store
            .load_wrapup_command("session", "other")
            .unwrap()
            .is_none());
    }

    #[test]
    fn todo_state_set_and_soft_refresh_are_replay_safe() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let state = r#"[{"content":"one","status":"pending","priority":"medium"}]"#;
        let first = store
            .set_todo_state("session", state, "m1", "hash-1")
            .unwrap();
        assert!(matches!(
            first,
            TodoStateSetOutcome::Updated { row_version: 1 }
        ));
        assert!(matches!(
            store.set_todo_state("session", state, "m1", "hash-1"),
            Ok(TodoStateSetOutcome::Noop)
        ));
        let changed_owner = store
            .set_todo_state("session", state, "m2", "hash-1")
            .unwrap();
        assert!(matches!(
            changed_owner,
            TodoStateSetOutcome::Updated { row_version: 2 }
        ));
        assert!(matches!(
            store.set_todo_state("session", "[]", "m2", "hash-2"),
            Ok(TodoStateSetOutcome::Updated { row_version: 3 })
        ));

        assert!(store.arm_soft_refresh("session").unwrap());
        let armed = store.load("session").unwrap();
        assert!(armed.meta.soft_refresh_pending);
        assert!(store.arm_soft_refresh("session").unwrap());
        let still_armed = store.load("session").unwrap();
        assert_eq!(still_armed.row_version, armed.row_version);

        let first_recomp = store
            .record_recomp_command("session", "recomp-1", "nothing_to_do", 10)
            .unwrap();
        let replay = store
            .record_recomp_command("session", "recomp-1", "started", 20)
            .unwrap();
        assert_eq!(replay, first_recomp);
        assert_eq!(
            store.load_recomp_command("session", "recomp-1").unwrap(),
            Some(first_recomp)
        );
    }

    #[test]
    fn wrapup_command_recording_is_fenced_by_row_version_and_revert_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let initial = store.load("session").unwrap();
        let row_version = store
            .commit("session", initial.row_version, &initial.core, &initial.meta)
            .unwrap();
        let stale = store
            .record_wrapup_command_if_current(WrapupCommandRecord {
                session_id: "session",
                command_id: "stale",
                disposition: "completed",
                rounds: 1,
                summary: "done",
                created_at: 10,
                expected_row_version: Some(row_version - 1),
                expected_revert_epoch: 0,
            })
            .unwrap();
        assert!(matches!(stale, RecordWrapupCommandOutcome::Stale { .. }));
        assert!(store
            .load_wrapup_command("session", "stale")
            .unwrap()
            .is_none());

        let recorded = store
            .record_wrapup_command_if_current(WrapupCommandRecord {
                session_id: "session",
                command_id: "current",
                disposition: "completed",
                rounds: 1,
                summary: "done",
                created_at: 10,
                expected_row_version: Some(row_version),
                expected_revert_epoch: 0,
            })
            .unwrap();
        assert!(matches!(
            recorded,
            RecordWrapupCommandOutcome::Recorded(WrapupCommandRow { ref disposition, .. })
                if disposition == "completed"
        ));
    }

    #[test]
    fn wrapup_command_recording_replaces_legacy_failure_with_capped_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let initial = store.load("session").unwrap();
        let row_version = store
            .commit("session", initial.row_version, &initial.core, &initial.meta)
            .unwrap();
        store
            .seed_legacy_wrapup_command_for_test(
                "session",
                "legacy",
                "failed",
                1,
                "old failure",
                17,
            )
            .unwrap();
        let summary = "é".repeat(600);

        let outcome = store
            .record_wrapup_command_if_current(WrapupCommandRecord {
                session_id: "session",
                command_id: "legacy",
                disposition: "completed",
                rounds: 3,
                summary: &summary,
                created_at: 99,
                expected_row_version: Some(row_version),
                expected_revert_epoch: 0,
            })
            .unwrap();
        let RecordWrapupCommandOutcome::Recorded(recorded) = outcome else {
            panic!("legacy failure must be atomically replaced");
        };
        assert_eq!(recorded.disposition, "completed");
        assert_eq!(recorded.rounds, 3);
        assert_eq!(recorded.created_at, 99);
        assert!(recorded.summary.chars().count() <= 500);
        assert!(recorded
            .summary
            .ends_with("; replaced failed record from 17"));
        assert_eq!(
            store.load_wrapup_command("session", "legacy").unwrap(),
            Some(recorded)
        );
    }

    #[test]
    fn pass_trace_upserts_counts_and_caps_errors() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let long_error = "é".repeat(2_500);

        store.trace_pass_received("trace", 11).unwrap();
        store.trace_pass_received("trace", 12).unwrap();
        store.trace_pass_rejected("trace", &long_error, 21).unwrap();
        store
            .trace_pass_rejected("trace", "second error", 22)
            .unwrap();
        store.trace_pass_completed("trace", 31).unwrap();

        let trace = store.load_pass_trace("trace").unwrap().unwrap();
        assert_eq!(trace.last_received_at_ms, 12);
        assert_eq!(trace.last_completed_at_ms, 31);
        assert_eq!(trace.last_reject_error.as_deref(), Some("second error"));
        assert_eq!(trace.last_reject_at_ms, Some(22));
        assert_eq!(trace.reject_count, 2);
        assert_eq!(trace.receive_count, 2);

        let defer = PassSchedulerObservation {
            timestamp_ms: 32,
            scheduler_decision: "Defer".to_string(),
            drain_latch_active: false,
        };
        let force = PassSchedulerObservation {
            timestamp_ms: 33,
            scheduler_decision: "Force85".to_string(),
            drain_latch_active: true,
        };
        store
            .trace_pass_stable("scheduler-trace", &defer, None, None)
            .unwrap();
        store
            .trace_pass_stable("scheduler-trace", &force, None, None)
            .unwrap();
        let scheduler_trace = store.load_pass_trace("scheduler-trace").unwrap().unwrap();
        assert_eq!(
            scheduler_trace.scheduler_history,
            vec![defer, force.clone()]
        );
        assert_eq!(
            store
                .load_pass_scheduler_history("scheduler-trace", 33, 33)
                .unwrap(),
            vec![force]
        );

        for timestamp_ms in 0..=256 {
            store
                .trace_pass_stable(
                    "bounded-scheduler-trace",
                    &PassSchedulerObservation {
                        timestamp_ms,
                        scheduler_decision: "Execute".to_string(),
                        drain_latch_active: false,
                    },
                    None,
                    None,
                )
                .unwrap();
        }
        let bounded = store
            .load_pass_trace("bounded-scheduler-trace")
            .unwrap()
            .unwrap()
            .scheduler_history;
        assert_eq!(bounded.len(), 256);
        assert_eq!(bounded.first().unwrap().timestamp_ms, 1);
        assert_eq!(bounded.last().unwrap().timestamp_ms, 256);

        store
            .trace_pass_rejected("trace-cap", &long_error, 41)
            .unwrap();
        let capped = store.load_pass_trace("trace-cap").unwrap().unwrap();
        assert_eq!(
            capped.last_reject_error.as_ref().unwrap().chars().count(),
            2_000
        );
    }

    #[test]
    fn scheduler_interesting_pass_survives_latched_execute_flood() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let interesting = PassSchedulerObservation {
            timestamp_ms: 1,
            scheduler_decision: "Force85".to_string(),
            drain_latch_active: true,
        };

        commit_scheduler_observation(
            &store,
            "scheduler-flood",
            None,
            &interesting,
            (false, Some(3), Some(0), Some(0), Some(3), 1),
            Some(10_001),
            Some("oldest-interest"),
        );
        for timestamp_ms in 2..=513 {
            store
                .trace_pass_stable(
                    "scheduler-flood",
                    &PassSchedulerObservation {
                        timestamp_ms,
                        scheduler_decision: "Execute".to_string(),
                        drain_latch_active: true,
                    },
                    Some(10_000 + timestamp_ms as u64),
                    None,
                )
                .unwrap();
        }

        assert_eq!(
            store
                .load_interesting_pass_scheduler_history("scheduler-flood", 1, 1)
                .unwrap(),
            vec![InterestingPassSchedulerObservation::from_observation(
                &interesting,
                Some(10_001),
                Some("oldest-interest"),
                Some(3),
                Some(0),
                Some(0),
                Some(3),
            )],
            "the oldest reduction pass must survive a flood of latched Execute passes that applied nothing"
        );
        let recency = store.load_pass_trace("scheduler-flood").unwrap().unwrap();
        assert_eq!(recency.scheduler_history.len(), PASS_SCHEDULER_HISTORY_CAP);
        assert_eq!(recency.scheduler_history.first().unwrap().timestamp_ms, 258);
    }

    #[test]
    fn scheduler_interesting_history_selects_only_reductions_and_divergence() {
        const POPULATION_SIZE: usize = 402;
        const LATCHED_PASSES: usize = 306;
        const INTERESTING_PASSES: usize = 26;

        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let divergence_indices = [19, 79, 139, 219, 319, 401];
        let mut expected = None;
        let mut expected_timestamps = Vec::new();
        let mut latched_count = 0;

        for index in 0..POPULATION_SIZE {
            let drain_latch_active = index < LATCHED_PASSES;
            latched_count += usize::from(drain_latch_active);
            let scheduler_decision = match index {
                0..214 => "Execute",
                214..306 => "Force85",
                306..386 => "Execute",
                386..400 => "Defer",
                400 => "Force85",
                _ => "Emergency95",
            };
            let applied_reduction = index < 400 && index % 20 == 0;
            let produced_output_divergence = divergence_indices.contains(&index);
            let timestamp_ms = index as i64 + 1;
            if applied_reduction || produced_output_divergence {
                expected_timestamps.push(timestamp_ms);
            }
            let fingerprint = format!("population-{index}");
            expected = Some(commit_scheduler_observation(
                &store,
                "interesting-selectivity",
                expected,
                &PassSchedulerObservation {
                    timestamp_ms,
                    scheduler_decision: scheduler_decision.to_string(),
                    drain_latch_active,
                },
                (
                    produced_output_divergence,
                    Some((index % 7) as u64),
                    Some(0),
                    Some(0),
                    Some((index % 7) as u64),
                    u64::from(applied_reduction),
                ),
                Some(20_000 + index as u64),
                Some(&fingerprint),
            ));
        }

        let retained = store
            .load_interesting_pass_scheduler_history("interesting-selectivity", i64::MIN, i64::MAX)
            .unwrap();
        assert_eq!(latched_count, LATCHED_PASSES);
        assert_eq!(expected_timestamps.len(), INTERESTING_PASSES);
        assert_eq!(retained.len(), INTERESTING_PASSES);
        assert_eq!(
            retained
                .iter()
                .map(|observation| observation.timestamp_ms)
                .collect::<Vec<_>>(),
            expected_timestamps,
            "only passes that applied a reduction or diverged belong in the interesting ring"
        );

        let recency = store
            .load_pass_trace("interesting-selectivity")
            .unwrap()
            .unwrap()
            .scheduler_history;
        assert_eq!(recency.len(), PASS_SCHEDULER_HISTORY_CAP);
        assert_eq!(recency.first().unwrap().timestamp_ms, 147);
        assert_eq!(recency.last().unwrap().timestamp_ms, 402);
    }

    #[test]
    fn scheduler_interesting_history_preserves_attributes_and_variable_decisions() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let reduction = PassSchedulerObservation {
            timestamp_ms: 700,
            scheduler_decision: "Execute".to_string(),
            drain_latch_active: true,
        };
        let divergence = PassSchedulerObservation {
            timestamp_ms: 701,
            scheduler_decision: "Emergency95".to_string(),
            drain_latch_active: false,
        };

        let first_version = commit_scheduler_observation(
            &store,
            "interesting-attributes",
            None,
            &reduction,
            (false, Some(3), Some(1), Some(0), Some(1), 1),
            Some(70_000),
            Some("reduction-fingerprint"),
        );
        commit_scheduler_observation(
            &store,
            "interesting-attributes",
            Some(first_version),
            &divergence,
            (false, Some(3), Some(0), Some(1), Some(2), 3),
            None,
            Some("divergence-fingerprint"),
        );

        let retained = store
            .load_interesting_pass_scheduler_history("interesting-attributes", i64::MIN, i64::MAX)
            .unwrap();
        assert_eq!(
            retained,
            vec![
                InterestingPassSchedulerObservation::from_observation(
                    &reduction,
                    Some(70_000),
                    Some("reduction-fingerprint"),
                    Some(3),
                    Some(1),
                    Some(0),
                    Some(1),
                ),
                InterestingPassSchedulerObservation::from_observation(
                    &divergence,
                    None,
                    Some("divergence-fingerprint"),
                    Some(3),
                    Some(0),
                    Some(1),
                    Some(2),
                ),
            ]
        );
        assert_ne!(
            retained[0].scheduler_decision, retained[1].scheduler_decision,
            "interesting entries must record each pass's actual scheduler decision"
        );
        assert_eq!(retained[1].request_observed_at_ms, None);
        assert_eq!(
            retained
                .iter()
                .map(|observation| observation.eligible_supersession_count)
                .collect::<Vec<_>>(),
            vec![Some(3), Some(3)],
            "both passes must retain the identical pre-gate accumulator depth"
        );
        assert_eq!(
            retained
                .iter()
                .map(|observation| observation.applied_supersession_count)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(2)],
            "the applied count must distinguish one landing member from the whole eligible group"
        );
    }

    #[test]
    fn scheduler_interesting_history_is_oldest_first_bounded_and_byte_bounded() {
        let worst_observation = PassSchedulerObservation {
            timestamp_ms: i64::MIN,
            scheduler_decision: "Emergency95".to_string(),
            drain_latch_active: false,
        };
        assert_eq!(
            serialize_scheduler_observation(&worst_observation)
                .unwrap()
                .len(),
            MAX_PASS_SCHEDULER_OBSERVATION_JSON_BYTES
        );
        assert_eq!(
            serialize_interesting_scheduler_observation(
                &worst_observation,
                Some(u64::MAX),
                Some(&"\0".repeat(MAX_FULL_ARRAY_FINGERPRINT_BYTES)),
                Some(u64::MAX),
                Some(u64::MAX),
                Some(u64::MAX),
                Some(u64::MAX),
            )
            .unwrap()
            .len(),
            MAX_INTERESTING_PASS_SCHEDULER_OBSERVATION_JSON_BYTES
        );

        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let fingerprint = "x".repeat(MAX_FULL_ARRAY_FINGERPRINT_BYTES);
        let mut expected = None;
        for timestamp_ms in 0..=256 {
            expected = Some(commit_scheduler_observation(
                &store,
                "interesting-bound",
                expected,
                &PassSchedulerObservation {
                    timestamp_ms,
                    scheduler_decision: "Emergency95".to_string(),
                    drain_latch_active: true,
                },
                (false, Some(3), Some(0), Some(0), Some(3), 1),
                Some(timestamp_ms as u64),
                Some(&fingerprint),
            ));
        }

        let retained = store
            .load_interesting_pass_scheduler_history("interesting-bound", i64::MIN, i64::MAX)
            .unwrap();
        assert_eq!(retained.len(), PASS_SCHEDULER_INTERESTING_HISTORY_CAP);
        assert_eq!(retained.first().unwrap().timestamp_ms, 1);
        assert_eq!(retained.last().unwrap().timestamp_ms, 256);
        let telemetry_bytes = store
            .inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT length(CAST(scheduler_history AS BLOB))
                          + length(CAST(scheduler_interesting_history AS BLOB))
                       FROM mc_pass_trace WHERE session_id = 'interesting-bound'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap();
        assert!(telemetry_bytes as usize <= PASS_SCHEDULER_TELEMETRY_MAX_BYTES);
    }

    #[test]
    fn scheduler_interesting_history_queries_time_and_shared_request_identity() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let entries = [
            (100, "Execute", 9_001, "fingerprint-a"),
            (100, "Force85", 9_024, "fingerprint-b"),
            (300, "Emergency95", 9_300, "fingerprint-c"),
        ];
        let mut expected = None;
        for (timestamp_ms, decision, request_time, fingerprint) in entries {
            expected = Some(commit_scheduler_observation(
                &store,
                "interesting-query",
                expected,
                &PassSchedulerObservation {
                    timestamp_ms,
                    scheduler_decision: decision.to_string(),
                    drain_latch_active: decision == "Execute",
                },
                (false, Some(3), Some(0), Some(0), Some(3), 1),
                Some(request_time),
                Some(fingerprint),
            ));
        }

        let range = store
            .load_interesting_pass_scheduler_history("interesting-query", 100, 299)
            .unwrap();
        assert_eq!(range.len(), 2, "the module-clock range is inclusive");
        assert_eq!(range[0].scheduler_decision, "Execute");
        assert_eq!(range[1].scheduler_decision, "Force85");

        for (request_time, fingerprint, expected_decision) in [
            (9_001, "fingerprint-a", "Execute"),
            (9_024, "fingerprint-b", "Force85"),
        ] {
            let by_request_time = store
                .load_interesting_pass_scheduler_history_by_request_time(
                    "interesting-query",
                    request_time,
                )
                .unwrap();
            assert_eq!(by_request_time.len(), 1);
            assert_eq!(by_request_time[0].scheduler_decision, expected_decision);
            assert_eq!(
                by_request_time[0].full_array_fingerprint.as_deref(),
                Some(fingerprint)
            );

            let by_fingerprint = store
                .load_interesting_pass_scheduler_history_by_fingerprint(
                    "interesting-query",
                    fingerprint,
                )
                .unwrap();
            assert_eq!(by_fingerprint.len(), 1);
            assert_eq!(by_fingerprint[0].scheduler_decision, expected_decision);
            assert_eq!(by_fingerprint[0].request_observed_at_ms, Some(request_time));
        }

        commit_scheduler_observation(
            &store,
            "interesting-query",
            expected,
            &PassSchedulerObservation {
                timestamp_ms: 400,
                scheduler_decision: "Force85".to_string(),
                drain_latch_active: false,
            },
            (false, Some(3), Some(0), Some(0), Some(3), 1),
            None,
            Some("fingerprint-without-sender-time"),
        );
        let absent = store
            .load_interesting_pass_scheduler_history_by_fingerprint(
                "interesting-query",
                "fingerprint-without-sender-time",
            )
            .unwrap();
        assert_eq!(absent.len(), 1);
        assert_eq!(absent[0].request_observed_at_ms, None);
    }

    #[test]
    fn scheduler_interest_includes_reductions_and_output_divergence_on_defer() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let core = CoreState::default();
        let meta = ModuleMeta::default();
        let observation = PassSchedulerObservation {
            timestamp_ms: 500,
            scheduler_decision: "Defer".to_string(),
            drain_latch_active: false,
        };

        for (session_id, first_divergence, applied_reductions, fingerprint) in [
            ("divergence-interest", Some("{}"), false, "diverged"),
            ("reduction-interest", None, true, "reduced"),
        ] {
            store
                .commit_transform(
                    session_id,
                    TransformCommit {
                        expected: None,
                        core: &core,
                        meta: &meta,
                        consumed_drop_ids: &[],
                        first_applied_command_ids: &[],
                        claim_snapshot_vector: None,
                        compartment_max_seq: None,
                        project_root: None,
                        first_divergence,
                        scheduler_observation: Some(&observation),
                        scheduler_request_observed_at_ms: Some(500),
                        scheduler_full_array_fingerprint: Some(fingerprint),
                        scheduler_eligible_supersession_count: None,
                        scheduler_withheld_by_tag_window: None,
                        scheduler_withheld_by_exempt_message: None,
                        scheduler_applied_supersession_count: None,
                        scheduler_applied_reductions: applied_reductions,
                        overlays: TransformOverlayBatch::default(),
                    },
                )
                .unwrap();
            let retained = store
                .load_interesting_pass_scheduler_history(session_id, 500, 500)
                .unwrap();
            assert_eq!(retained.len(), 1);
            assert_eq!(retained[0].scheduler_decision, "Defer");
            assert_eq!(
                retained[0].eligible_supersession_count, None,
                "Defer did not run supersession selection, so its depth must remain absent"
            );
            assert_eq!(
                retained[0].full_array_fingerprint.as_deref(),
                Some(fingerprint)
            );
        }
    }

    #[test]
    fn project_mural_artifact_upsert_is_hash_gated() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();

        assert!(store
            .upsert_project_mural_artifact(
                "git:project",
                b"data:image/png;base64,YQ==",
                "mural-a",
                100,
            )
            .unwrap());
        let first = store
            .load_project_mural_artifact("git:project")
            .unwrap()
            .unwrap();
        assert_eq!(first.data_url, b"data:image/png;base64,YQ==");
        assert_eq!(first.content_hash, "mural-a");
        assert_eq!(first.updated_at, 100);

        assert!(!store
            .upsert_project_mural_artifact(
                "git:project",
                b"data:image/png;base64,unexpected-but-same-hash",
                "mural-a",
                200,
            )
            .unwrap());
        let unchanged = store
            .load_project_mural_artifact("git:project")
            .unwrap()
            .unwrap();
        assert_eq!(
            unchanged, first,
            "same hash must not bump artifact identity"
        );

        assert!(store
            .upsert_project_mural_artifact(
                "git:project",
                b"data:image/png;base64,Yg==",
                "mural-b",
                300,
            )
            .unwrap());
        assert_eq!(
            store
                .load_project_mural_artifact("git:project")
                .unwrap()
                .unwrap(),
            ProjectMuralArtifact {
                project_path: "git:project".to_string(),
                data_url: b"data:image/png;base64,Yg==".to_vec(),
                content_hash: "mural-b".to_string(),
                updated_at: 300,
            }
        );
    }

    #[test]
    fn schema_version_probe_reads_the_live_store_and_matches_the_shipped_ceiling() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        // expose.
        let shipped_max = MIGRATIONS
            .iter()
            .map(|migration| migration.version)
            .max()
            .unwrap();
        assert_eq!(LATEST_MIGRATION_VERSION, shipped_max);
        assert_eq!(
            store.module_store_schema_version().unwrap(),
            LATEST_MIGRATION_VERSION
        );
    }

    #[test]
    fn pre_cutover_module_store_is_refused_by_family_not_by_ddl_collision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE cortexkit_schema_version (
                     namespace TEXT NOT NULL,
                     version INTEGER NOT NULL,
                     applied_at_unix INTEGER NOT NULL,
                     PRIMARY KEY (namespace, version)
                 );
                 CREATE TABLE mc_cache_state (
                     session_id   TEXT PRIMARY KEY,
                     row_version  INTEGER NOT NULL,
                     core_state   TEXT NOT NULL,
                     meta         TEXT NOT NULL
                 );",
            )
            .unwrap();
            for version in 1..OLDEST_ADOPTABLE_MIGRATION_VERSION {
                conn.execute(
                    "INSERT INTO cortexkit_schema_version (namespace, version, applied_at_unix)
                     VALUES (?1, ?2, 0)",
                    params![NS, version],
                )
                .unwrap();
            }
        }

        let error = match McStore::open(&descriptor(dir.path())) {
            Ok(_) => panic!("expected a pre-cutover family refusal, got an open store"),
            Err(error) => error,
        };
        match error {
            McStoreError::PreCutoverModuleStore {
                recorded_version,
                bootstrap_version,
            } => {
                assert_eq!(recorded_version, OLDEST_ADOPTABLE_MIGRATION_VERSION - 1);
                assert_eq!(bootstrap_version, OLDEST_ADOPTABLE_MIGRATION_VERSION);
            }
            other => panic!("expected a pre-cutover family refusal, got {other}"),
        }
    }

    #[test]
    fn fresh_and_current_module_stores_open_without_a_pre_cutover_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = descriptor(dir.path());
        let first = McStore::open(&descriptor).unwrap();
        assert_eq!(
            first.module_store_schema_version().unwrap(),
            LATEST_MIGRATION_VERSION
        );
        drop(first);
        let second = McStore::open(&descriptor).unwrap();
        assert_eq!(
            second.module_store_schema_version().unwrap(),
            LATEST_MIGRATION_VERSION
        );
    }

    #[test]
    fn double_open_same_path_is_rejected_by_lease() {
        let dir = tempfile::tempdir().unwrap();
        let d = descriptor(dir.path());
        let _first = McStore::open(&d).unwrap();
        assert!(McStore::open(&d).is_err());
    }

    fn import_compartment(
        sequence: i64,
        start_message: i64,
        end_message: i64,
        end_message_id: &str,
        p1: &str,
    ) -> StoredCompartment {
        StoredCompartment {
            sequence,
            start_message,
            end_message,
            end_message_id: end_message_id.to_string(),
            title: format!("imported {sequence}"),
            content: p1.to_string(),
            p1: Some(p1.to_string()),
            importance: 50,
            ..Default::default()
        }
    }

    #[test]
    fn state_import_is_atomic_bootstrap_only_and_durably_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let compartments = vec![
            import_compartment(4, 1, 4, "m4#0", "first"),
            import_compartment(9, 5, 9, "m9#0", "second"),
        ];

        assert_eq!(
            store.preflight_state_import("fresh", "bundle-a").unwrap(),
            StateImportPreflight::Ready
        );
        let imported = store
            .commit_state_import("fresh", "bundle-a", &compartments, 123)
            .unwrap();
        assert_eq!(
            imported,
            StateImportResult {
                imported: 2,
                duplicate: false
            }
        );
        assert_eq!(store.load_compartments("fresh").unwrap(), compartments);
        let loaded = store.load("fresh").unwrap();
        assert!(loaded.core.boundary_id.is_empty());
        assert!(
            loaded.row_version.is_none(),
            "import leaves bootstrap INSERT to transform"
        );

        let malformed_retry = vec![import_compartment(1, 3, 2, "bad", "")];
        let duplicate = store
            .commit_state_import("fresh", "bundle-a", &malformed_retry, 999)
            .unwrap();
        assert_eq!(
            duplicate,
            StateImportResult {
                imported: 2,
                duplicate: true
            }
        );
        assert!(store.load("fresh").unwrap().row_version.is_none());
        assert!(matches!(
            store.commit_state_import("fresh", "bundle-b", &compartments, 999),
            Err(StateImportError::SessionNotEmpty)
        ));
        assert_eq!(store.load_compartments("fresh").unwrap(), compartments);

        store
            .commit("used", None, &CoreState::default(), &ModuleMeta::default())
            .unwrap();
        assert!(matches!(
            store.commit_state_import("used", "bundle-c", &compartments, 999),
            Err(StateImportError::SessionNotEmpty)
        ));
        assert!(store.load_compartments("used").unwrap().is_empty());
    }

    #[test]
    fn state_import_preflight_rejects_each_session_owned_state_kind() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();

        let cache = store.load("cache").unwrap();
        store
            .commit("cache", None, &cache.core, &cache.meta)
            .unwrap();
        store
            .replace_compartments(
                "compartments",
                &[import_compartment(1, 1, 1, "m1#0", "summary")],
            )
            .unwrap();
        store
            .mint_or_get_tags(
                "tags",
                &[TagMintInput {
                    block_id: "m1#0".to_string(),
                    kind: "message".to_string(),
                    token_count: 1,
                    source_bytes: b"source".to_vec(),
                }],
                1,
            )
            .unwrap();
        store
            .append_pending_agent_drops("pending", &["m1#0".to_string()], 1)
            .unwrap();
        store
            .append_pending_agent_drops_with_command("ledger", Some("command"), &[], 1, true)
            .unwrap();
        store.append_user_hint("hints", "m1#0", "", 1).unwrap();
        store
            .apply_active_overlay_decisions(
                "overlays",
                1,
                &[TemporalMarkInput {
                    ordinal: 1,
                    block_id: "m1#0".to_string(),
                    marker_text: String::new(),
                }],
                None,
                1,
            )
            .unwrap();
        store
            .record_wrapup_command("wrapup", "command", "completed", 1, "done", 1)
            .unwrap();

        for session_id in [
            "cache",
            "compartments",
            "tags",
            "pending",
            "ledger",
            "hints",
            "overlays",
            "wrapup",
        ] {
            assert!(matches!(
                store.preflight_state_import(session_id, "bundle"),
                Err(StateImportError::SessionNotEmpty)
            ));
            assert!(matches!(
                store.commit_state_import(session_id, "bundle", &[], 2),
                Err(StateImportError::SessionNotEmpty)
            ));
        }
    }

    #[test]
    fn rejected_state_import_validation_leaves_no_rows() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let invalid = vec![import_compartment(1, 3, 2, "m2#0", "bad")];

        let error = store
            .commit_state_import("fresh", "bundle-a", &invalid, 123)
            .unwrap_err();
        assert!(matches!(
            error,
            StateImportError::Validation(StateImportValidationError::RangeInvalid { .. })
        ));
        assert!(store.load_compartments("fresh").unwrap().is_empty());
        assert_eq!(
            store.preflight_state_import("fresh", "bundle-a").unwrap(),
            StateImportPreflight::Ready
        );
    }

    #[test]
    fn compartments_roundtrip_chronological_with_tiers_and_legacy() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        assert!(store.load_compartments("ses_a").unwrap().is_empty());

        let comps = vec![
            StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 9,
                title: "oldest legacy".into(),
                content: "U: flat body".into(),
                legacy: 1,
                importance: 50,
                created_at: 100,
                ..Default::default()
            },
            StoredCompartment {
                sequence: 2,
                start_message: 10,
                end_message: 19,
                start_date: Some("2026-01-02".into()),
                end_date: Some("2026-01-03".into()),
                title: "v2 row".into(),
                content: "P1 full".into(),
                p1: Some("P1 full".into()),
                p2: Some("P2 dense".into()),
                p3: Some("P3".into()),
                p4: None,
                importance: 80,
                episode_type: Some("design,feature".into()),
                legacy: 0,
                created_at: 200,
                ..Default::default()
            },
        ];
        store.replace_compartments("ses_a", &comps).unwrap();

        let read = store.load_compartments("ses_a").unwrap();
        assert_eq!(
            read, comps,
            "chronological round-trip incl NULL p4 + tiers + legacy"
        );
        assert_eq!(read[0].sequence, 1, "oldest first");

        let replacement = vec![StoredCompartment {
            sequence: 1,
            title: "only".into(),
            content: "x".into(),
            importance: 50,
            ..Default::default()
        }];
        store.replace_compartments("ses_a", &replacement).unwrap();
        let read2 = store.load_compartments("ses_a").unwrap();
        assert_eq!(read2.len(), 1);
        assert_eq!(read2[0].title, "only");

        assert!(store.load_compartments("ses_b").unwrap().is_empty());
    }

    #[test]
    fn max_compartment_end_ordinal_matches_full_compartment_load() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let compartments = vec![
            StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 8,
                title: "first".into(),
                content: "one".into(),
                ..Default::default()
            },
            StoredCompartment {
                sequence: 2,
                start_message: 9,
                end_message: 23,
                title: "second".into(),
                content: "two".into(),
                ..Default::default()
            },
        ];
        store
            .replace_compartments("ordinal-session", &compartments)
            .unwrap();

        let full_max = store
            .load_compartments("ordinal-session")
            .unwrap()
            .iter()
            .map(|compartment| compartment.end_message)
            .max()
            .unwrap_or(0);
        assert_eq!(
            store
                .max_compartment_end_ordinal("ordinal-session")
                .unwrap(),
            full_max
        );
        assert_eq!(
            store.max_compartment_end_ordinal("empty-session").unwrap(),
            0
        );

        let details = store
            .inner
            .with_conn(|conn| {
                let mut statement = conn.prepare_cached(
                    "EXPLAIN QUERY PLAN
                     SELECT COALESCE(MAX(end_message), 0)
                       FROM mc_compartments WHERE session_id = ?1",
                )?;
                let rows = statement
                    .query_map(params!["ordinal-session"], |row| row.get::<_, String>(3))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .unwrap();
        assert!(
            details.iter().any(|detail| {
                detail.contains("USING COVERING INDEX idx_mc_compartments_session_end_message")
            }),
            "compartment max must use the covering end-ordinal index: {details:?}"
        );
    }

    #[test]
    fn active_user_memories_ordered_promoted_then_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let insert = |id: i64, content: &str, status: &str, promoted: i64| {
            store
                .inner
                .with_conn_fenced(|tx| {
                    tx.execute(
                        "INSERT INTO mc_user_memories (id, content, status, promoted_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![id, content, status, promoted],
                    )?;
                    Ok(())
                })
                .unwrap();
        };
        insert(1, "first", "active", 50);
        insert(4, "tie-later-id", "active", 100);
        insert(3, "tie-earlier-id", "active", 100);
        insert(2, "archived", "archived", 10); // status != active → excluded from the result

        let got = store.load_active_user_memories().unwrap();
        assert_eq!(got, vec!["first", "tie-earlier-id", "tie-later-id"]);
    }

    #[test]
    fn append_compartments_preserves_existing_rows_and_assigns_tail_sequences() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let c1 = StoredCompartment {
            sequence: 1,
            start_message: 1,
            end_message: 2,
            end_message_id: "m2".into(),
            title: "old-1".into(),
            content: "old one".into(),
            ..Default::default()
        };
        let c2 = StoredCompartment {
            sequence: 2,
            start_message: 3,
            end_message: 4,
            end_message_id: "m4".into(),
            title: "old-2".into(),
            content: "old two".into(),
            ..Default::default()
        };
        store
            .replace_compartments("ses", &[c1.clone(), c2.clone()])
            .unwrap();

        let appended = StoredCompartment {
            sequence: 99,
            start_message: 5,
            end_message: 6,
            end_message_id: "m6".into(),
            title: "new".into(),
            content: "new tail".into(),
            ..Default::default()
        };
        store.append_compartments("ses", &[appended]).unwrap();

        let rows = store.load_compartments("ses").unwrap();
        let seqs: Vec<i64> = rows.iter().map(|c| c.sequence).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
        assert_eq!(rows[0].title, c1.title);
        assert_eq!(rows[1].title, c2.title);
        assert_eq!(rows[2].title, "new");
    }

    #[test]
    fn append_compartments_rejects_overlapping_ranges_without_partial_rows() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let compartment = |sequence: i64,
                           start_message: i64,
                           end_message: i64,
                           end_message_id: &str| StoredCompartment {
            sequence,
            start_message,
            end_message,
            end_message_id: end_message_id.to_string(),
            title: "summary".to_string(),
            content: "summary".to_string(),
            ..Default::default()
        };
        store
            .replace_compartments("ses", &[compartment(1, 1, 5, "m5")])
            .unwrap();

        let error = store
            .append_compartments("ses", &[compartment(99, 5, 8, "m8")])
            .unwrap_err();
        assert!(matches!(
            error,
            McStoreError::CompartmentRangeOverlap {
                existing_sequence: 1,
                incoming_start_message: 5,
                incoming_end_message: 8,
            }
        ));
        let rows = store.load_compartments("ses").unwrap();
        assert_eq!(rows.len(), 1, "a rejected append must stay atomic");
        assert_eq!(rows[0].sequence, 1);

        store
            .append_compartments("ses", &[compartment(99, 6, 8, "m8")])
            .unwrap();
        let rows = store.load_compartments("ses").unwrap();
        assert_eq!(rows.len(), 2, "a disjoint append must remain legal");
        assert_eq!(rows[1].sequence, 2, "append still owns durable numbering");
    }

    fn selected_range_identities() -> Vec<HistorianSelectedMessageIdentity> {
        vec![HistorianSelectedMessageIdentity {
            mid: "m10".to_string(),
            block_identities: vec![BlockIdentity {
                kind_tag: "text".to_string(),
                byte_fingerprint: "content-a".to_string(),
            }],
        }]
    }

    fn publishing_meta() -> ModuleMeta {
        let selected_range_identities = selected_range_identities();
        ModuleMeta {
            block_identity_by_mid: selected_range_identities
                .iter()
                .map(|selected| (selected.mid.clone(), selected.block_identities.clone()))
                .collect(),
            historian: HistorianDurableState {
                state: HistorianPhase::Publishing,
                firing_seq: 7,
                chunk_range: Some(HistorianChunkRange {
                    from_ordinal: 10,
                    to_ordinal: 20,
                }),
                chunk_fingerprint: "fp".into(),
                selected_range_identities,
                producer_session_id: Some("producer-session".into()),
                producer_run_id: Some("run-1".into()),
                producer_harness: None,
                fired_at_ms: Some(123),
                expected_revert_epoch: 0,
                compartment_set_generation: CompartmentSetGeneration::default(),
                failure_backoff_at_ms: Some(456),
                last_failure: None,
                last_no_fire: None,
                consecutive_publish_failures: 0,
            },
            ..Default::default()
        }
    }

    #[test]
    fn historian_publish_failure_counter_accumulates_and_success_state_resets() {
        let directory = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(directory.path())).unwrap();
        let predicate = publish_predicate();
        let mut meta = publishing_meta();
        store
            .commit("publish-health", None, &CoreState::default(), &meta)
            .unwrap();

        for expected_failures in 1..=3 {
            let loaded = store.load("publish-health").unwrap();
            meta = publishing_meta();
            meta.historian.consecutive_publish_failures =
                loaded.meta.historian.consecutive_publish_failures;
            store
                .commit("publish-health", loaded.row_version, &loaded.core, &meta)
                .unwrap();
            store
                .abandon_historian_run_if_matching_with_publish_failure(
                    "publish-health",
                    &predicate,
                    None,
                    Some("publication failed"),
                    true,
                )
                .unwrap();
            assert_eq!(
                store
                    .load("publish-health")
                    .unwrap()
                    .meta
                    .historian
                    .consecutive_publish_failures,
                expected_failures,
            );
        }

        let successful = idle_historian_after_success(predicate.firing_seq);
        assert_eq!(successful.consecutive_publish_failures, 0);
    }

    fn publish_predicate() -> HistorianPublishPredicate {
        HistorianPublishPredicate {
            firing_seq: 7,
            producer_run_id: "run-1".into(),
            chunk_fingerprint: "fp".into(),
            selected_range_identities: selected_range_identities(),
            compartment_set_generation: CompartmentSetGeneration::default(),
        }
    }

    fn publish_compartment() -> StoredCompartment {
        StoredCompartment {
            start_message: 10,
            end_message: 20,
            end_message_id: "m20".into(),
            title: "published".into(),
            content: "published summary".into(),
            ..Default::default()
        }
    }

    #[test]
    fn matching_historian_abandon_fences_predicate_and_update_for_both_backoffs() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = descriptor(dir.path());
        let raw_path = match &descriptor.backend {
            StorageBackend::Sqlite { path } => path.clone(),
            _ => unreachable!("test descriptor is SQLite"),
        };
        let store = McStore::open(&descriptor).unwrap();
        store
            .commit("ses", None, &CoreState::default(), &publishing_meta())
            .unwrap();

        let hook_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook_calls_for_hook = std::sync::Arc::clone(&hook_calls);
        store.set_abandon_historian_hook(Box::new(move || {
            hook_calls_for_hook.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let raw = rusqlite::Connection::open(&raw_path).unwrap();
            raw.busy_timeout(std::time::Duration::ZERO).unwrap();
            let error = raw
                .execute(
                    "UPDATE mc_cache_state SET row_version = row_version WHERE session_id = ?1",
                    params!["ses"],
                )
                .expect_err("BEGIN IMMEDIATE must block a competing writer");
            assert!(
                matches!(
                    error,
                    rusqlite::Error::SqliteFailure(ref error, _)
                        if error.code == rusqlite::ErrorCode::DatabaseBusy
                ),
                "the competing write must fail with SQLITE_BUSY: {error}"
            );
        }));

        let first_before = store.load("ses").unwrap();
        let first_abandoned = store
            .abandon_historian_run_if_matching(
                "ses",
                &publish_predicate(),
                None,
                Some("snapshot generation changed"),
            )
            .unwrap();
        assert_eq!(first_abandoned, Some(first_before.row_version.unwrap() + 1));
        let idle = store.load("ses").unwrap();
        assert_eq!(idle.row_version, first_abandoned);
        assert_eq!(idle.meta.historian.state, HistorianPhase::Idle);
        assert_eq!(idle.meta.historian.firing_seq, 7);
        assert_eq!(idle.meta.historian.failure_backoff_at_ms, None);
        assert_eq!(
            idle.meta.historian.last_failure.as_deref(),
            Some("snapshot generation changed")
        );

        let publishing = store.load("ses").unwrap();
        let publishing_meta = publishing_meta();
        store
            .commit(
                "ses",
                publishing.row_version,
                &publishing.core,
                &publishing_meta,
            )
            .unwrap();
        let second_before = store.load("ses").unwrap();
        let second_abandoned = store
            .abandon_historian_run_if_matching(
                "ses",
                &publish_predicate(),
                Some(999),
                Some("fingerprint or CAS conflict"),
            )
            .unwrap();
        assert_eq!(
            second_abandoned,
            Some(second_before.row_version.unwrap() + 1)
        );
        let cooled_down = store.load("ses").unwrap();
        assert_eq!(cooled_down.row_version, second_abandoned);
        assert_eq!(cooled_down.meta.historian.state, HistorianPhase::Idle);
        assert_eq!(cooled_down.meta.historian.failure_backoff_at_ms, Some(999));
        assert_eq!(
            cooled_down.meta.historian.last_failure.as_deref(),
            Some("fingerprint or CAS conflict")
        );
        assert_eq!(
            hook_calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "the fenced callback must run for both abandon variants"
        );
    }

    #[test]
    fn publish_historian_chunk_rejects_overlapping_compartment_as_typed_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let mut existing = publish_compartment();
        existing.sequence = 1;
        store.replace_compartments("ses", &[existing]).unwrap();
        let mut meta = publishing_meta();
        meta.historian.compartment_set_generation = CompartmentSetGeneration {
            max_sequence: 1,
            count: 1,
        };
        store
            .commit("ses", None, &CoreState::default(), &meta)
            .unwrap();
        let expected = store.load("ses").unwrap().row_version;
        let predicate = HistorianPublishPredicate {
            compartment_set_generation: meta.historian.compartment_set_generation,
            ..publish_predicate()
        };

        let error = store
            .publish_historian_chunk(HistorianPublishRequest {
                session_id: "ses",
                expected_row_version: expected,
                expected_revert_epoch: 0,
                predicate: &predicate,
                project_path: "git:proj",
                compartments: &[publish_compartment()],
                events: &[],
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 21,
                chunk_transcript: None,
                raw_chunk_messages: None,
            })
            .unwrap_err();
        assert!(matches!(
            error,
            HistorianPublishError::CompartmentOverlap {
                existing_sequence: 1,
                incoming_start_message: 10,
                incoming_end_message: 20,
            }
        ));
        assert_eq!(store.load_compartments("ses").unwrap().len(), 1);
    }

    #[test]
    fn historian_side_channel_faults_are_isolated_and_retryable_per_kind() {
        for failed_kind in HISTORIAN_SIDE_CHANNEL_KINDS {
            let dir = tempfile::tempdir().unwrap();
            let store = McStore::open(&descriptor(dir.path())).unwrap();
            store
                .commit("ses", None, &CoreState::default(), &publishing_meta())
                .unwrap();
            store.fail_next_historian_side_channel_for_test(failed_kind);
            let event = HistorianEventCandidate {
                kind: "trajectory_correction".into(),
                at_compartment: Some(1),
                compartment_id: Some(0),
                fields_json: "{\"detail\":\"fixed\"}".into(),
                created_at: 123,
                harness: "module".into(),
            };
            let primer = HistorianPrimerCandidate {
                project_path: "git:proj".into(),
                session_id: "ses".into(),
                question: "How is publication recovered?".into(),
                source_compartment_start: Some(10),
                source_compartment_end: Some(20),
                source_start_message_id: "m10".into(),
                source_end_message_id: "m20".into(),
                source_message_time: 123,
                created_at: 123,
            };
            let observation = HistorianUserMemoryCandidate {
                content: "The user prefers explicit recovery semantics.".into(),
                session_id: "ses".into(),
                source_compartment_start: Some(10),
                source_compartment_end: Some(20),
                created_at: 123,
            };
            let expected = store.load("ses").unwrap().row_version;

            store
                .publish_historian_chunk(HistorianPublishRequest {
                    session_id: "ses",
                    expected_row_version: expected,
                    expected_revert_epoch: 0,
                    predicate: &publish_predicate(),
                    project_path: "git:proj",
                    compartments: &[publish_compartment()],
                    events: std::slice::from_ref(&event),
                    primer_candidates: std::slice::from_ref(&primer),
                    user_memory_candidates: std::slice::from_ref(&observation),
                    publication_floor_ordinal: 21,
                    chunk_transcript: None,
                    raw_chunk_messages: None,
                })
                .unwrap();

            assert_eq!(store.load_compartments("ses").unwrap().len(), 1);
            assert_eq!(
                store.load_compartment_events("ses").unwrap().len(),
                usize::from(failed_kind != "event")
            );
            assert_eq!(
                store.load_primer_candidates("ses").unwrap().len(),
                usize::from(failed_kind != "primer")
            );
            assert_eq!(
                store.load_user_memory_candidates("ses").unwrap().len(),
                usize::from(failed_kind != "user_observation")
            );
            if failed_kind == "primer" {
                assert_eq!(
                    store.load_user_memory_candidates("ses").unwrap().len(),
                    1,
                    "a failed Primer write must not suppress user observations"
                );
            }
            let pending = store.historian_side_channel_status("ses").unwrap();
            assert_eq!(pending.pending_count, 1);
            assert!(pending
                .last_failure
                .as_deref()
                .is_some_and(|error| error.contains(failed_kind)));

            let retry = store
                .drain_historian_side_channels("ses", i64::MAX, 32)
                .unwrap();
            assert_eq!(retry.succeeded, 1);
            assert_eq!(store.load_compartment_events("ses").unwrap().len(), 1);
            assert_eq!(store.load_primer_candidates("ses").unwrap().len(), 1);
            assert_eq!(store.load_user_memory_candidates("ses").unwrap().len(), 1);
            assert_eq!(
                store
                    .historian_side_channel_status("ses")
                    .unwrap()
                    .pending_count,
                0
            );
        }
    }

    #[test]
    fn historian_side_channel_outbox_recovers_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = descriptor(dir.path());
        let store = McStore::open(&descriptor).unwrap();
        store
            .commit("ses", None, &CoreState::default(), &publishing_meta())
            .unwrap();
        store.fail_next_historian_side_channel_for_test("event");
        let event = HistorianEventCandidate {
            kind: "causal_incident".into(),
            fields_json: "{}".into(),
            created_at: 123,
            harness: "module".into(),
            ..Default::default()
        };
        let expected = store.load("ses").unwrap().row_version;
        store
            .publish_historian_chunk(HistorianPublishRequest {
                session_id: "ses",
                expected_row_version: expected,
                expected_revert_epoch: 0,
                predicate: &publish_predicate(),
                project_path: "git:proj",
                compartments: &[publish_compartment()],
                events: std::slice::from_ref(&event),
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 21,
                chunk_transcript: None,
                raw_chunk_messages: None,
            })
            .unwrap();
        assert_eq!(
            store
                .historian_side_channel_status("ses")
                .unwrap()
                .pending_count,
            1
        );
        drop(store);

        let reopened = McStore::open(&descriptor).unwrap();
        let recovery = reopened
            .drain_historian_side_channels("ses", i64::MAX, 32)
            .unwrap();
        assert_eq!(recovery.succeeded, 1);
        assert_eq!(reopened.load_compartment_events("ses").unwrap().len(), 1);
        assert_eq!(
            reopened
                .historian_side_channel_status("ses")
                .unwrap()
                .pending_count,
            0
        );
    }

    #[test]
    fn publish_historian_chunk_persists_transcript_inside_cas() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        store
            .commit("ses", None, &CoreState::default(), &publishing_meta())
            .unwrap();
        let expected = store.load("ses").unwrap().row_version;
        store
            .publish_historian_chunk(HistorianPublishRequest {
                session_id: "ses",
                expected_row_version: expected,
                expected_revert_epoch: 0,
                predicate: &publish_predicate(),
                project_path: "git:proj",
                compartments: &[publish_compartment()],
                events: &[],
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 21,
                chunk_transcript: Some("U: hello\nA: world"),
                raw_chunk_messages: None,
            })
            .unwrap();

        let rows = store
            .load_chunk_transcripts_for_range("ses", 10, 21)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].compartment_seq, 1);
        assert_eq!(rows[0].transcript.as_deref(), Some("U: hello\nA: world"));
    }

    #[test]
    fn publish_historian_chunk_cas_conflict_leaves_no_transcript_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        store
            .commit("ses", None, &CoreState::default(), &publishing_meta())
            .unwrap();
        let event = HistorianEventCandidate {
            kind: "orphan".into(),
            fields_json: "{}".into(),
            ..Default::default()
        };
        let err = store
            .publish_historian_chunk(HistorianPublishRequest {
                session_id: "ses",
                expected_row_version: Some(99),
                expected_revert_epoch: 0,
                predicate: &publish_predicate(),
                project_path: "git:proj",
                compartments: &[publish_compartment()],
                events: std::slice::from_ref(&event),
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 21,
                chunk_transcript: Some("U: orphan"),
                raw_chunk_messages: None,
            })
            .unwrap_err();
        assert!(matches!(err, HistorianPublishError::CasConflict { .. }));
        assert!(store
            .load_chunk_transcripts_for_range("ses", 10, 21)
            .unwrap()
            .is_empty());
        assert!(store.load_compartment_events("ses").unwrap().is_empty());
        assert_eq!(
            store
                .historian_side_channel_status("ses")
                .unwrap()
                .pending_count,
            0,
            "a rejected CAS must not leave side-channel work behind"
        );
    }

    #[test]
    fn oversized_chunk_transcript_is_evicted_as_unrecoverable() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        store
            .commit("ses", None, &CoreState::default(), &publishing_meta())
            .unwrap();
        let transcript = (0..50_000)
            .map(|i| format!("{:x}", md5::compute(i.to_string())))
            .collect::<String>();
        assert!(
            compress_transcript(&transcript).unwrap().len() > MAX_CHUNK_TRANSCRIPT_COMPRESSED_BYTES
        );
        let expected = store.load("ses").unwrap().row_version;
        store
            .publish_historian_chunk(HistorianPublishRequest {
                session_id: "ses",
                expected_row_version: expected,
                expected_revert_epoch: 0,
                predicate: &publish_predicate(),
                project_path: "git:proj",
                compartments: &[publish_compartment()],
                events: &[],
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 21,
                chunk_transcript: Some(&transcript),
                raw_chunk_messages: None,
            })
            .unwrap();
        assert!(store
            .load_chunk_transcripts_for_range("ses", 10, 21)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn bounded_transcript_reads_limit_rows_and_inflated_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        store
            .commit("ses", None, &CoreState::default(), &publishing_meta())
            .unwrap();
        let compartments = (0..8)
            .map(|index| StoredCompartment {
                start_message: 10 + index * 2,
                end_message: 11 + index * 2,
                end_message_id: format!("m{}", 11 + index * 2),
                title: format!("bounded {index}"),
                content: "summary".to_string(),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        let expected = store.load("ses").unwrap().row_version;
        store
            .publish_historian_chunk(HistorianPublishRequest {
                session_id: "ses",
                expected_row_version: expected,
                expected_revert_epoch: 0,
                predicate: &publish_predicate(),
                project_path: "git:proj",
                compartments: &compartments,
                events: &[],
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 25,
                chunk_transcript: Some("U: bounded row"),
                raw_chunk_messages: None,
            })
            .unwrap();

        assert_eq!(store.last_compacted_ordinal("ses").unwrap(), 25);
        assert_eq!(
            store
                .load_compartments_for_range("ses", 1, 100, 3)
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            store
                .load_chunk_transcripts_for_range_bounded("ses", 1, 100, 3)
                .unwrap()
                .len(),
            3
        );

        let oversized = "a🙂".repeat(MAX_CHUNK_TRANSCRIPT_INFLATED_BYTES / 5 + 100_000);
        assert!(
            compress_transcript(&oversized).unwrap().len() < MAX_CHUNK_TRANSCRIPT_COMPRESSED_BYTES
        );
        let loaded = store.load("ses").unwrap();
        let mut replay_meta = publishing_meta();
        replay_meta.historian.compartment_set_generation = CompartmentSetGeneration {
            max_sequence: 8,
            count: 8,
        };
        store
            .commit("ses", loaded.row_version, &loaded.core, &replay_meta)
            .unwrap();
        let expected = store.load("ses").unwrap().row_version;
        let replay_predicate = HistorianPublishPredicate {
            compartment_set_generation: replay_meta.historian.compartment_set_generation,
            ..publish_predicate()
        };
        store
            .publish_historian_chunk(HistorianPublishRequest {
                session_id: "ses",
                expected_row_version: expected,
                expected_revert_epoch: 0,
                predicate: &replay_predicate,
                project_path: "git:proj",
                compartments: &[StoredCompartment {
                    start_message: 100,
                    end_message: 101,
                    end_message_id: "m101".to_string(),
                    title: "inflated".to_string(),
                    content: "summary".to_string(),
                    ..Default::default()
                }],
                events: &[],
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 101,
                chunk_transcript: Some(&oversized),
                raw_chunk_messages: None,
            })
            .unwrap();
        let transcript = store
            .load_chunk_transcripts_for_range("ses", 100, 101)
            .unwrap()
            .pop()
            .unwrap()
            .transcript
            .unwrap();
        assert!(transcript.contains(CHUNK_TRANSCRIPT_TRUNCATION_MARKER.trim()));
        assert!(
            transcript.len()
                <= MAX_CHUNK_TRANSCRIPT_INFLATED_BYTES + CHUNK_TRANSCRIPT_TRUNCATION_MARKER.len()
        );
    }

    #[test]
    fn note_search_is_scoped_to_the_requested_composite_session_and_smart_notes() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let project = "git:shared-project";
        let session_a = "conversation:alpha:instance-a";
        let session_b = "conversation:beta:instance-b";
        let note_a = store
            .insert_note(NoteInput {
                project_path: project,
                route_project_root: None,
                session_id: session_a,
                content: "only alpha session detail",
                surface_condition: None,
                anchor_block_id: None,
                now_ms: 1,
            })
            .unwrap();
        let note_b = store
            .insert_note(NoteInput {
                project_path: project,
                route_project_root: None,
                session_id: session_b,
                content: "only beta session detail",
                surface_condition: None,
                anchor_block_id: None,
                now_ms: 2,
            })
            .unwrap();
        let smart = store
            .insert_project_note(NoteWriteInput {
                project_path: project,
                route_project_root: None,
                session_id: Some(session_a),
                content: "shared project guidance",
                surface_condition: Some("shared condition"),
                anchor_block_id: None,
                anchor_ordinal: None,
                compiled_provider: None,
                compiled_config: None,
                compiled_at: None,
                compile_status: None,
                now_ms: 3,
            })
            .unwrap();

        let ids_a = store
            .search_notes_like(project, session_a, "detail")
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect::<BTreeSet<_>>();
        assert_eq!(ids_a, BTreeSet::from([note_a.id]));
        let ids_b = store
            .search_notes_like(project, session_b, "detail")
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect::<BTreeSet<_>>();
        assert_eq!(ids_b, BTreeSet::from([note_b.id]));

        let ids_a = store
            .search_notes_like(project, session_a, "shared")
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect::<BTreeSet<_>>();
        let ids_b = store
            .search_notes_like(project, session_b, "shared")
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect::<BTreeSet<_>>();
        assert_eq!(ids_a, BTreeSet::from([smart.id]));
        assert_eq!(ids_b, BTreeSet::from([smart.id]));
    }

    #[test]
    fn notes_crud_pagination_dismiss_resolution_and_search() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let first = store
            .insert_note(NoteInput {
                project_path: "git:proj",
                route_project_root: None,
                session_id: "ses",
                content: "Revisit frobnicator later",
                surface_condition: Some("when release tag advances"),
                anchor_block_id: Some("m9#0"),
                now_ms: 10,
            })
            .unwrap();
        let second = store
            .insert_note(NoteInput {
                project_path: "git:proj",
                route_project_root: None,
                session_id: "ses",
                content: "Check pagination",
                surface_condition: None,
                anchor_block_id: None,
                now_ms: 20,
            })
            .unwrap();
        assert_eq!(
            store.read_notes("git:proj", "ses", 1, 0).unwrap()[0].id,
            second.id
        );
        assert_eq!(
            store.read_notes("git:proj", "ses", 1, 1).unwrap()[0].id,
            first.id
        );
        store
            .update_note_content(
                "git:proj",
                "ses",
                first.id,
                "Revisit updated frobnicator",
                30,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            store
                .search_notes_like("git:proj", "ses", "updated")
                .unwrap()[0]
                .id,
            first.id
        );
        let before_dismiss = store
            .get_note_by_id("git:proj", "ses", first.id)
            .unwrap()
            .unwrap();
        let feed_before_dismiss = store.pull_changefeed("notes", 0, 100).unwrap().next_cursor;
        let dismissed = store
            .dismiss_note("git:proj", "ses", first.id, Some("done in v2"), 40)
            .unwrap()
            .unwrap();
        assert_eq!(dismissed.status, "dismissed");
        assert!(dismissed.content.contains("done in v2"));
        assert_eq!(dismissed.status_version, before_dismiss.status_version + 1);
        let dismissal_feed = store
            .pull_changefeed("notes", feed_before_dismiss, 100)
            .unwrap();
        assert_eq!(dismissal_feed.rows.len(), 1);
        assert_eq!(dismissal_feed.rows[0].module_row_id, first.id);
        assert_eq!(store.read_notes("git:proj", "ses", 25, 0).unwrap().len(), 1);
        assert!(store
            .search_notes_like("git:other", "ses", "pagination")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn note_update_with_unchanged_condition_is_not_a_compiler_edit() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let note = store
            .insert_project_note(NoteWriteInput {
                project_path: "git:proj",
                route_project_root: None,
                session_id: Some("writer-session"),
                content: "wait for the release",
                surface_condition: Some("release exists"),
                anchor_block_id: None,
                anchor_ordinal: None,
                compiled_provider: None,
                compiled_config: None,
                compiled_at: None,
                compile_status: None,
                now_ms: 10,
            })
            .unwrap();
        let claimed = store.claim_due_note("git:proj", 20).unwrap().unwrap();
        let ready = match store
            .write_note_evaluation(NoteEvaluationInput {
                project_path: "git:proj",
                note_id: note.id,
                source_revision: claimed.status_version,
                verdict: true,
                compiled_check: Some("release exists"),
                manifest_json: Some("{}"),
                check_hash: Some("hash"),
                next_due_at: None,
                now_ms: 30,
            })
            .unwrap()
        {
            NoteCasOutcome::Applied(note) => note,
            other => panic!("unexpected evaluation outcome: {other:?}"),
        };
        assert!(ready.compiled_check.is_some());

        let unchanged = match store
            .update_note_cas(
                "git:proj",
                note.id,
                &ready.status,
                ready.status_version,
                None,
                Some(Some("  release exists  ")),
                None,
                40,
            )
            .unwrap()
        {
            NoteCasOutcome::Applied(note) => note,
            other => panic!("unexpected unchanged-condition outcome: {other:?}"),
        };
        assert_eq!(unchanged.status, ready.status);
        assert_eq!(unchanged.source_revision, ready.source_revision);
        assert_eq!(unchanged.compiled_check, ready.compiled_check);
        assert_eq!(unchanged.status_version, ready.status_version);
        assert_eq!(unchanged.state_version, ready.state_version);

        let changed = match store
            .update_note_cas(
                "git:proj",
                note.id,
                &unchanged.status,
                unchanged.status_version,
                None,
                Some(Some("release tagged")),
                None,
                50,
            )
            .unwrap()
        {
            NoteCasOutcome::Applied(note) => note,
            other => panic!("unexpected changed-condition outcome: {other:?}"),
        };
        assert_eq!(changed.status, "pending");
        assert_eq!(changed.source_revision, unchanged.source_revision + 1);
        assert!(changed.compiled_check.is_none());
    }

    #[test]
    fn project_notes_use_cas_and_at_least_once_delivery() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let note = store
            .insert_project_note(NoteWriteInput {
                project_path: "git:proj",
                route_project_root: None,
                session_id: Some("writer-session"),
                content: "wait for the release",
                surface_condition: Some("release exists"),
                anchor_block_id: None,
                anchor_ordinal: None,
                compiled_provider: None,
                compiled_config: None,
                compiled_at: None,
                compile_status: None,
                now_ms: 10,
            })
            .unwrap();
        assert_eq!(note.status, "pending");
        let note = match store
            .update_note_cas(
                "git:proj",
                note.id,
                "pending",
                note.status_version,
                Some("wait for the release tag"),
                None,
                None,
                11,
            )
            .unwrap()
        {
            NoteCasOutcome::Applied(note) => note,
            other => panic!("unexpected cold-start update outcome: {other:?}"),
        };
        assert!(store
            .read_project_notes("git:other", None, &["pending"], 25, 0)
            .unwrap()
            .is_empty());
        assert!(matches!(
            store.update_note_cas(
                "git:other",
                note.id,
                "pending",
                note.status_version,
                Some("cross-project write"),
                None,
                None,
                11,
            ),
            Err(McStoreError::NoteOwnershipMismatch { .. })
        ));

        let claimed = store.claim_due_note("git:proj", 20).unwrap().unwrap();
        let evaluated = store
            .write_note_evaluation(NoteEvaluationInput {
                project_path: "git:proj",
                note_id: note.id,
                source_revision: claimed.status_version,
                verdict: true,
                compiled_check: Some("release exists"),
                manifest_json: Some("{}"),
                check_hash: Some("hash"),
                next_due_at: None,
                now_ms: 30,
            })
            .unwrap();
        let ready = match evaluated {
            NoteCasOutcome::Applied(note) => note,
            other => panic!("unexpected evaluation outcome: {other:?}"),
        };
        assert_eq!(ready.status, "ready");

        let first = store
            .claim_note_delivery("git:proj", "serve-session", "pass-1", "pass-1", 40)
            .unwrap();
        assert_eq!(first.len(), 1);
        assert!(!store
            .claim_note_delivery("git:proj", "serve-session", "pass-2", "pass-2", 50)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .ack_note_delivery("git:proj", "serve-session", "pass-2", 60)
                .unwrap(),
            1
        );
        assert!(store
            .claim_note_delivery("git:proj", "serve-session", "pass-3", "pass-3", 70)
            .unwrap()
            .is_empty());

        let surfaced = store
            .read_project_notes("git:proj", None, &["surfaced"], 25, 0)
            .unwrap()
            .into_iter()
            .find(|row| row.id == note.id)
            .unwrap();
        let dismissed = store
            .dismiss_note_cas(
                "git:proj",
                note.id,
                "surfaced",
                surfaced.status_version,
                Some("done"),
                80,
            )
            .unwrap();
        assert!(matches!(dismissed, NoteCasOutcome::Applied(note) if note.status == "dismissed"));
        assert!(store
            .claim_note_delivery("git:proj", "serve-session", "pass-4", "pass-4", 90)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn note_delivery_nack_is_terminal_and_late_ack_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let note = store
            .insert_project_note(NoteWriteInput {
                project_path: "git:proj",
                route_project_root: None,
                session_id: Some("writer"),
                content: "evaluate me",
                surface_condition: Some("condition"),
                anchor_block_id: None,
                anchor_ordinal: None,
                compiled_provider: None,
                compiled_config: None,
                compiled_at: None,
                compile_status: None,
                now_ms: 1,
            })
            .unwrap();
        store
            .write_note_evaluation(NoteEvaluationInput {
                project_path: "git:proj",
                note_id: note.id,
                source_revision: note.status_version,
                verdict: true,
                compiled_check: None,
                manifest_json: None,
                check_hash: None,
                next_due_at: None,
                now_ms: 2,
            })
            .unwrap();
        assert_eq!(
            store
                .claim_note_delivery("git:proj", "session", "fingerprint-1", "pass", 3)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .nack_note_delivery("git:proj", "session", "pass", 4)
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .ack_note_delivery("git:proj", "session", "pass", 5)
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .claim_note_delivery("git:proj", "session", "fingerprint-2", "pass-2", 6)
                .unwrap()
                .len(),
            1,
            "a NACKed attempt is terminal, while the ready note may be retried in a new attempt"
        );
    }

    #[test]
    fn note_delivery_ack_is_scoped_by_project_session_and_pass() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        for project in ["git:a", "git:b"] {
            let note = store
                .insert_project_note(NoteWriteInput {
                    project_path: project,
                    route_project_root: None,
                    session_id: Some("writer"),
                    content: "scoped note",
                    surface_condition: Some("condition"),
                    anchor_block_id: None,
                    anchor_ordinal: None,
                    compiled_provider: None,
                    compiled_config: None,
                    compiled_at: None,
                    compile_status: None,
                    now_ms: 1,
                })
                .unwrap();
            store
                .write_note_evaluation(NoteEvaluationInput {
                    project_path: project,
                    note_id: note.id,
                    source_revision: note.status_version,
                    verdict: true,
                    compiled_check: None,
                    manifest_json: None,
                    check_hash: None,
                    next_due_at: None,
                    now_ms: 2,
                })
                .unwrap();
            store
                .claim_note_delivery(project, "session", project, "shared-pass", 3)
                .unwrap();
        }
        assert_eq!(
            store
                .ack_note_delivery("git:a", "session", "shared-pass", 4)
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .read_project_notes("git:a", None, &["surfaced"], 10, 0)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .read_project_notes("git:b", None, &["surfacing"], 10, 0)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn note_lookup_and_visibility_paging_are_not_bounded_by_first_page() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let mut first_id = 0;
        for index in 0..105 {
            let note = store
                .insert_project_note(NoteWriteInput {
                    project_path: "git:proj",
                    route_project_root: None,
                    session_id: Some("writer"),
                    content: &format!("note {index}"),
                    surface_condition: None,
                    anchor_block_id: None,
                    anchor_ordinal: None,
                    compiled_provider: None,
                    compiled_config: None,
                    compiled_at: None,
                    compile_status: None,
                    now_ms: 1,
                })
                .unwrap();
            if index == 0 {
                first_id = note.id;
            }
        }
        let found = store
            .get_note_by_id("git:proj", "reader", first_id)
            .unwrap()
            .unwrap();
        assert_eq!(found.id, first_id);
        let updated = store
            .update_note_content(
                "git:proj",
                "reader",
                first_id,
                "updated outside the first page",
                2,
            )
            .unwrap()
            .unwrap();
        assert_eq!(updated.content, "updated outside the first page");
        let page = store
            .read_visible_notes("git:proj", "reader", &["active"], 5, 100)
            .unwrap();
        assert_eq!(page.len(), 5);
        assert!(page.iter().all(|note| note.project_path == "git:proj"));
    }

    fn insert_smart_note_with_compile(
        store: &McStore,
        project: &str,
        content: &str,
        condition: Option<&str>,
        compile: Option<NoteConditionCompile<'_>>,
    ) -> StoredNote {
        let compile = compile.unwrap_or_default();
        store
            .insert_project_note(NoteWriteInput {
                project_path: project,
                route_project_root: None,
                session_id: Some("writer"),
                content,
                surface_condition: condition,
                anchor_block_id: None,
                anchor_ordinal: None,
                compiled_provider: compile.compiled_provider,
                compiled_config: compile.compiled_config,
                compiled_at: compile.compiled_at,
                compile_status: compile.compile_status,
                now_ms: 1,
            })
            .unwrap()
    }

    #[test]
    fn note_create_initializes_revisions_equal_and_content_edits_keep_them_equal() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let note =
            insert_smart_note_with_compile(&store, "git:proj", "first body", Some("cond"), None);
        assert_eq!(note.source_revision, 0);
        assert_eq!(note.state_version, 0);
        assert_eq!(note.status_version, 0);
        let mut current = note;
        for step in 1..=3i64 {
            let body = format!("body {step}");
            current = match store
                .update_note_cas(
                    "git:proj",
                    current.id,
                    &current.status,
                    current.status_version,
                    Some(&body),
                    None,
                    None,
                    10 + step,
                )
                .unwrap()
            {
                NoteCasOutcome::Applied(note) => note,
                other => panic!("unexpected content edit outcome: {other:?}"),
            };
            assert_eq!(current.source_revision, step);
            assert_eq!(current.state_version, step);
            assert_eq!(current.status_version, step);
        }
    }

    #[test]
    fn note_content_edit_advances_source_revision_and_resets_evaluation_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let note = insert_smart_note_with_compile(
            &store,
            "git:proj",
            "watch the release",
            Some("release exists"),
            Some(NoteConditionCompile {
                compiled_provider: Some("retina-1"),
                compiled_config: Some("{\"model\":\"a\"}"),
                compiled_at: Some(7),
                compile_status: Some("compiled"),
            }),
        );
        store
            .write_note_evaluation(NoteEvaluationInput {
                project_path: "git:proj",
                note_id: note.id,
                source_revision: 0,
                verdict: false,
                compiled_check: Some("check-code"),
                manifest_json: Some("{}"),
                check_hash: Some("hash"),
                next_due_at: Some(50),
                now_ms: 2,
            })
            .unwrap();
        store
            .inner
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE mc_notes SET check_failure_count = 3, check_network_failure_count = 2,
                        check_quarantined_until = 9, check_compiled_at = 8,
                        check_false_since_at = 7, check_last_liveness_at = 6,
                        check_cron = '0 * * * *', check_version = 4,
                        compiled_source_revision = 0, compiled_project_path = 'git:proj'
                      WHERE id = ?1",
                    params![note.id],
                )?;
                Ok(())
            })
            .unwrap();
        let edited = match store
            .update_note_cas(
                "git:proj",
                note.id,
                "pending",
                1,
                Some("new body"),
                None,
                None,
                3,
            )
            .unwrap()
        {
            NoteCasOutcome::Applied(note) => note,
            other => panic!("unexpected content edit outcome: {other:?}"),
        };
        assert_eq!(edited.source_revision, 1);
        assert_eq!(edited.state_version, 2);
        assert_eq!(edited.status_version, 2);
        assert_eq!(edited.status, "pending");
        assert_eq!(edited.compiled_check, None);
        assert_eq!(edited.manifest_json, None);
        assert_eq!(edited.check_hash, None);
        assert_eq!(edited.check_cron, None);
        assert_eq!(edited.compiled_source_revision, None);
        assert_eq!(edited.compiled_project_path, None);
        assert_eq!(edited.check_version, Some(0));
        assert_eq!(edited.check_status.as_deref(), Some("uncompiled"));
        assert_eq!(edited.check_failure_count, 0);
        assert_eq!(edited.check_network_failure_count, 0);
        assert_eq!(edited.check_quarantined_until, None);
        assert_eq!(edited.check_next_due_at, None);
        assert_eq!(edited.check_compiled_at, None);
        assert_eq!(edited.check_false_since_at, None);
        assert_eq!(edited.check_last_liveness_at, None);
        assert_eq!(edited.last_checked_at, None);
        assert_eq!(edited.ready_at, None);
        assert_eq!(edited.ready_reason, None);
        assert_eq!(edited.compiled_provider.as_deref(), Some("retina-1"));
        assert_eq!(edited.compiled_config.as_deref(), Some("{\"model\":\"a\"}"));
        assert_eq!(edited.compiled_at, Some(7));
        assert_eq!(edited.compile_status.as_deref(), Some("compiled"));
    }

    #[test]
    fn note_condition_edit_resets_evaluation_state_and_replaces_compile_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let note = insert_smart_note_with_compile(
            &store,
            "git:proj",
            "watch the release",
            Some("release exists"),
            Some(NoteConditionCompile {
                compiled_provider: Some("retina-1"),
                compiled_config: Some("{\"model\":\"a\"}"),
                compiled_at: Some(7),
                compile_status: Some("compiled"),
            }),
        );
        store
            .write_note_evaluation(NoteEvaluationInput {
                project_path: "git:proj",
                note_id: note.id,
                source_revision: 0,
                verdict: false,
                compiled_check: Some("check-code"),
                manifest_json: Some("{}"),
                check_hash: Some("hash"),
                next_due_at: Some(50),
                now_ms: 2,
            })
            .unwrap();
        let recompiled = match store
            .update_note_cas(
                "git:proj",
                note.id,
                "pending",
                1,
                None,
                Some(Some("tag advances")),
                Some(NoteConditionCompile {
                    compiled_provider: Some("retina-2"),
                    compiled_config: Some("{\"model\":\"b\"}"),
                    compiled_at: Some(9),
                    compile_status: Some("plain"),
                }),
                3,
            )
            .unwrap()
        {
            NoteCasOutcome::Applied(note) => note,
            other => panic!("unexpected condition edit outcome: {other:?}"),
        };
        assert_eq!(recompiled.source_revision, 1);
        assert_eq!(recompiled.state_version, 2);
        assert_eq!(recompiled.status_version, 2);
        assert_eq!(recompiled.status, "pending");
        assert_eq!(
            recompiled.surface_condition.as_deref(),
            Some("tag advances")
        );
        assert_eq!(recompiled.compiled_check, None);
        assert_eq!(recompiled.manifest_json, None);
        assert_eq!(recompiled.check_hash, None);
        assert_eq!(recompiled.check_status.as_deref(), Some("uncompiled"));
        assert_eq!(recompiled.compiled_provider.as_deref(), Some("retina-2"));
        assert_eq!(
            recompiled.compiled_config.as_deref(),
            Some("{\"model\":\"b\"}")
        );
        assert_eq!(recompiled.compiled_at, Some(9));
        assert_eq!(recompiled.compile_status.as_deref(), Some("plain"));
        let cleared = match store
            .update_note_cas(
                "git:proj",
                note.id,
                "pending",
                2,
                None,
                Some(Some("third condition")),
                None,
                4,
            )
            .unwrap()
        {
            NoteCasOutcome::Applied(note) => note,
            other => panic!("unexpected condition edit outcome: {other:?}"),
        };
        assert_eq!(cleared.source_revision, 2);
        assert_eq!(cleared.state_version, 3);
        assert_eq!(cleared.compiled_provider, None);
        assert_eq!(cleared.compiled_config, None);
        assert_eq!(cleared.compiled_at, None);
        assert_eq!(cleared.compile_status, None);
    }

    #[test]
    fn note_lifecycle_transitions_advance_state_but_not_source_and_keep_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let note = insert_smart_note_with_compile(
            &store,
            "git:proj",
            "surface me",
            Some("release exists"),
            None,
        );
        let ready = match store
            .write_note_evaluation(NoteEvaluationInput {
                project_path: "git:proj",
                note_id: note.id,
                source_revision: 0,
                verdict: true,
                compiled_check: Some("check-code"),
                manifest_json: Some("{}"),
                check_hash: Some("hash"),
                next_due_at: None,
                now_ms: 2,
            })
            .unwrap()
        {
            NoteCasOutcome::Applied(note) => note,
            other => panic!("unexpected evaluation outcome: {other:?}"),
        };
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.status_version, 1);
        assert_eq!(ready.state_version, 1);
        assert_eq!(ready.source_revision, 0);
        let (surfacing, _) = store
            .claim_note_delivery("git:proj", "session", "fingerprint", "pass", 3)
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(surfacing.status, "surfacing");
        assert_eq!(surfacing.status_version, 2);
        assert_eq!(surfacing.state_version, 2);
        assert_eq!(surfacing.source_revision, 0);
        store
            .ack_note_delivery("git:proj", "session", "pass", 4)
            .unwrap();
        let surfaced = store
            .get_note_by_id("git:proj", "session", note.id)
            .unwrap()
            .unwrap();
        assert_eq!(surfaced.status, "surfaced");
        assert_eq!(surfaced.status_version, 3);
        assert_eq!(surfaced.state_version, 3);
        assert_eq!(surfaced.source_revision, 0);
        let dismissed = match store
            .dismiss_note_cas("git:proj", note.id, "surfaced", 3, Some("done"), 5)
            .unwrap()
        {
            NoteCasOutcome::Applied(note) => note,
            other => panic!("unexpected dismissal outcome: {other:?}"),
        };
        assert_eq!(dismissed.status, "dismissed");
        assert_eq!(dismissed.status_version, 4);
        assert_eq!(dismissed.state_version, 4);
        assert_eq!(dismissed.source_revision, 0);
        assert_eq!(dismissed.compiled_check.as_deref(), Some("check-code"));
        assert_eq!(dismissed.manifest_json.as_deref(), Some("{}"));
        assert_eq!(dismissed.check_hash.as_deref(), Some("hash"));

        let due =
            insert_smart_note_with_compile(&store, "git:proj", "due note", Some("cond"), None);
        let claimed = store.claim_due_note("git:proj", 10).unwrap().unwrap();
        assert_eq!(claimed.id, due.id);
        assert_eq!(claimed.status_version, 1);
        assert_eq!(claimed.state_version, 1);
        assert_eq!(claimed.source_revision, 0);
    }

    fn register_pre_v2_note_functions(conn: &rusqlite::Connection, project: &'static str) {
        conn.create_scalar_function(
            "mc_note_caller_project",
            0,
            FunctionFlags::SQLITE_UTF8,
            move |_context| Ok(project.to_string()),
        )
        .unwrap();
        conn.create_scalar_function(
            "mc_facade_authority_domain",
            0,
            FunctionFlags::SQLITE_UTF8,
            |_context| Ok(String::new()),
        )
        .unwrap();
        conn.create_scalar_function(
            "mc_facade_authority_route",
            0,
            FunctionFlags::SQLITE_UTF8,
            |_context| Ok(String::new()),
        )
        .unwrap();
    }

    #[test]
    fn migration_v51_backfill_initializes_revisions_and_normalizes_check_status() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        drop(McStore::open(&descriptor(dir.path())).unwrap());
        let conn = rusqlite::Connection::open(&path).unwrap();
        register_pre_v2_note_functions(&conn, "git:proj");
        conn.create_scalar_function(
            "mc_note_writer_v2",
            0,
            FunctionFlags::SQLITE_UTF8,
            |_context| Ok(1i64),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO mc_notes
                (type, project_path, session_id, content, status, check_status,
                 status_version, created_at_ms, updated_at_ms)
             VALUES ('smart', 'git:proj', 'writer', 'legacy row', 'pending', 'true', 7, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE mc_notes SET source_revision = status_version, state_version = status_version",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE mc_notes SET check_status = 'uncompiled'
              WHERE check_status NOT IN ('uncompiled', 'compiled', 'failing', 'fallback')",
            [],
        )
        .unwrap();
        let (source, state, status_version, check_status) = conn
            .query_row(
                "SELECT source_revision, state_version, status_version, check_status
                   FROM mc_notes WHERE content = 'legacy row'",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!((source, state, status_version), (7, 7, 7));
        assert_eq!(check_status, "uncompiled");
    }

    #[test]
    fn note_artifact_repair_verifies_digest_or_clears_compiled_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let good = insert_smart_note_with_compile(&store, "git:proj", "good", Some("cond"), None);
        let bad = insert_smart_note_with_compile(&store, "git:proj", "bad", Some("cond"), None);
        let manifest = "{\"hosts\":[]}";
        let good_hash = note_check_digest(
            Some("cond"),
            "check-code",
            Some(manifest),
            Some("0 * * * *"),
        );
        store
            .inner
            .with_conn(|conn| {
                for (id, hash) in [(good.id, good_hash.as_str()), (bad.id, "forged")] {
                    conn.execute(
                        "UPDATE mc_notes SET compiled_check = 'check-code', manifest_json = ?2,
                            check_hash = ?3, check_cron = '0 * * * *',
                            check_status = 'compiled', check_version = 4
                          WHERE id = ?1",
                        params![id, manifest, hash],
                    )?;
                }
                conn.execute(
                    "DELETE FROM mc_cache_state WHERE session_id = 'note_artifact_repair_v51_done'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        store.repair_note_artifacts_v51().unwrap();
        let verified = store
            .get_note_by_id("git:proj", "writer", good.id)
            .unwrap()
            .unwrap();
        assert_eq!(verified.compiled_check.as_deref(), Some("check-code"));
        assert_eq!(verified.manifest_json.as_deref(), Some(manifest));
        assert_eq!(verified.check_hash.as_deref(), Some(good_hash.as_str()));
        assert_eq!(verified.compiled_source_revision, Some(0));
        assert_eq!(verified.compiled_project_path.as_deref(), Some("git:proj"));
        assert_eq!(verified.check_status.as_deref(), Some("compiled"));
        assert_eq!(verified.check_version, Some(4));
        assert_eq!(verified.status_version, 0);
        assert_eq!(verified.state_version, 0);
        assert_eq!(verified.source_revision, 0);
        let cleared = store
            .get_note_by_id("git:proj", "writer", bad.id)
            .unwrap()
            .unwrap();
        assert_eq!(cleared.compiled_check, None);
        assert_eq!(cleared.manifest_json, None);
        assert_eq!(cleared.check_hash, None);
        assert_eq!(cleared.check_cron, None);
        assert_eq!(cleared.compiled_source_revision, None);
        assert_eq!(cleared.compiled_project_path, None);
        assert_eq!(cleared.check_version, Some(0));
        assert_eq!(cleared.check_status.as_deref(), Some("uncompiled"));
        assert_eq!(cleared.content, "bad");
        assert_eq!(cleared.status, "pending");
        assert_eq!(cleared.status_version, 0);
        assert_eq!(cleared.state_version, 0);
        assert_eq!(cleared.source_revision, 0);
        store.repair_note_artifacts_v51().unwrap();
    }

    #[test]
    fn mc_notes_writer_fence_blocks_connections_without_the_v2_function() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        drop(McStore::open(&descriptor(dir.path())).unwrap());
        let conn = rusqlite::Connection::open(&path).unwrap();
        register_pre_v2_note_functions(&conn, "git:proj");
        let insert = "INSERT INTO mc_notes
                (type, project_path, session_id, content, status, created_at_ms, updated_at_ms)
             VALUES ('smart', 'git:proj', 'writer', 'fenced write', 'active', 1, 1)";
        let error = conn.execute(insert, []).unwrap_err().to_string();
        assert!(error.contains("mc_note_writer_v2"), "{error}");
        conn.create_scalar_function(
            "mc_note_writer_v2",
            0,
            FunctionFlags::SQLITE_UTF8,
            |_context| Ok(1i64),
        )
        .unwrap();
        conn.execute(insert, []).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mc_notes WHERE content = 'fenced write'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn publish_historian_chunk_fails_loud_from_non_publish_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        store
            .commit("ses", None, &CoreState::default(), &ModuleMeta::default())
            .unwrap();
        let expected = store.load("ses").unwrap().row_version;

        let err = store
            .publish_historian_chunk(HistorianPublishRequest {
                session_id: "ses",
                expected_row_version: expected,
                expected_revert_epoch: 0,
                predicate: &publish_predicate(),
                project_path: "git:proj",
                compartments: &[publish_compartment()],
                events: &[],
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 21,
                chunk_transcript: None,
                raw_chunk_messages: None,
            })
            .unwrap_err();
        assert!(
            matches!(err, HistorianPublishError::InvalidState { ref state } if state == "idle"),
            "idle state must fail loudly: {err:?}"
        );
        assert!(store.load_compartments("ses").unwrap().is_empty());
    }
    fn recut_comp(seq: i64, start: i64, end: i64, end_id: &str) -> StoredCompartment {
        StoredCompartment {
            sequence: seq,
            start_message: start,
            end_message: end,
            start_message_id: format!("m{start}#0"),
            end_message_id: end_id.to_string(),
            title: format!("C{seq}"),
            content: format!("summary {seq}"),
            p1: Some(format!("summary {seq}")),
            importance: 50,
            ..Default::default()
        }
    }

    #[test]
    fn truncate_compartments_for_revert_deletes_suffix_and_bumps_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let meta = ModuleMeta {
            coverage_ordinal: Some(3),
            folded_compartment_seq: 3,
            ..Default::default()
        };
        let rv = store
            .commit("ses", None, &CoreState::default(), &meta)
            .unwrap();
        store
            .replace_compartments(
                "ses",
                &[
                    recut_comp(1, 1, 1, "a#0"),
                    recut_comp(2, 2, 2, "b#0"),
                    recut_comp(3, 3, 3, "c#0"),
                ],
            )
            .unwrap();

        let outcome = store
            .truncate_compartments_for_revert("ses", 1, Some(rv))
            .unwrap();
        assert_eq!(outcome.revert_epoch, 1);
        assert_eq!(outcome.row_version, rv + 1);
        assert!(outcome
            .last_recut
            .as_deref()
            .unwrap()
            .contains("dropped seq 2..3"));
        let loaded = store.load("ses").unwrap();
        assert_eq!(loaded.meta.revert_epoch, 1);
        assert_eq!(loaded.meta.last_recut, outcome.last_recut);
        let compartments = store.load_compartments("ses").unwrap();
        assert_eq!(compartments.len(), 1);
        assert_eq!(compartments[0].sequence, 1);

        let no_op = store
            .truncate_compartments_for_revert("ses", 1, Some(outcome.row_version))
            .unwrap();
        assert_eq!(no_op.revert_epoch, 1);
        assert_eq!(no_op.row_version, outcome.row_version);
        assert_eq!(store.load_compartments("ses").unwrap().len(), 1);
    }

    #[test]
    fn assembly_snapshot_reads_compartments_and_revert_epoch_together() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let meta = ModuleMeta {
            revert_epoch: 4,
            ..Default::default()
        };
        store
            .commit("ses", None, &CoreState::default(), &meta)
            .unwrap();
        store
            .replace_compartments("ses", &[recut_comp(1, 1, 1, "a#0")])
            .unwrap();

        let snapshot = store.load_historian_assembly_snapshot("ses").unwrap();
        assert_eq!(snapshot.revert_epoch, 4);
        assert_eq!(snapshot.compartments.len(), 1);
        assert_eq!(snapshot.compartments[0].end_message_id, "a#0");
    }

    #[test]
    fn publish_historian_chunk_rejects_recut_epoch_mismatch_as_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let mut meta = publishing_meta();
        meta.revert_epoch = 1;
        store
            .commit("ses", None, &CoreState::default(), &meta)
            .unwrap();
        let expected = store.load("ses").unwrap().row_version;

        let err = store
            .publish_historian_chunk(HistorianPublishRequest {
                session_id: "ses",
                expected_row_version: expected,
                expected_revert_epoch: 0,
                predicate: &publish_predicate(),
                project_path: "git:proj",
                compartments: &[publish_compartment()],
                events: &[],
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 21,
                chunk_transcript: None,
                raw_chunk_messages: None,
            })
            .unwrap_err();
        assert!(matches!(
            err,
            HistorianPublishError::CasConflict {
                reason: Some(ref reason),
                ..
            } if reason == "revert epoch mismatch (session was re-cut mid-firing)"
        ));
        assert!(store.load_compartments("ses").unwrap().is_empty());
        assert_eq!(
            store.load("ses").unwrap().meta.historian.state,
            HistorianPhase::Publishing
        );
    }

    const EVAL_PROJECT: &str = "git:proj";

    fn note_eval_store(dir: &std::path::Path) -> McStore {
        let store = McStore::open(&descriptor(dir)).unwrap();
        let preparing = store
            .authority_begin_prepare("ctx", EVAL_PROJECT, "notes")
            .unwrap();
        store
            .authority_finish_prepare(
                "ctx",
                EVAL_PROJECT,
                "notes",
                preparing.generation,
                "hash",
                "hash",
                true,
            )
            .unwrap();
        store
    }

    fn eval_note(store: &McStore, content: &str) -> StoredNote {
        store
            .insert_project_note(NoteWriteInput {
                project_path: EVAL_PROJECT,
                route_project_root: None,
                session_id: Some("writer"),
                content,
                surface_condition: Some("condition"),
                anchor_block_id: None,
                anchor_ordinal: None,
                compiled_provider: None,
                compiled_config: None,
                compiled_at: None,
                compile_status: None,
                now_ms: 1,
            })
            .unwrap()
    }

    fn pick_first(notes: &[NoteEvalCandidate]) -> NoteEvalSelection {
        match notes.first() {
            Some(note) => NoteEvalSelection::Claim {
                note_id: note.id,
                phase: "due".to_string(),
            },
            None => NoteEvalSelection::NoWork {
                cycle_exhausted: false,
            },
        }
    }

    fn pick_none(_: &[NoteEvalCandidate]) -> NoteEvalSelection {
        NoteEvalSelection::NoWork {
            cycle_exhausted: false,
        }
    }

    fn eval_reduced(note: &StoredNote, status: &str, now_ms: i64) -> NoteEvalReducedState {
        let ready = status == "ready";
        NoteEvalReducedState {
            status: status.to_string(),
            ready_at: ready.then_some(now_ms),
            ready_reason: ready.then(|| "condition_true".to_string()),
            last_checked_at: Some(now_ms),
            updated_at_ms: now_ms,
            compiled_check: Some("compiled body".to_string()),
            manifest_json: Some("{}".to_string()),
            check_hash: Some("hash".to_string()),
            check_cron: note.check_cron.clone(),
            check_version: Some(1),
            check_status: Some("compiled".to_string()),
            check_failure_count: note.check_failure_count,
            check_network_failure_count: note.check_network_failure_count,
            check_quarantined_until: None,
            check_next_due_at: Some(now_ms + 60_000),
            check_compiled_at: Some(now_ms),
            check_false_since_at: None,
            check_last_liveness_at: None,
            policy_version: note.policy_version,
            compiled_source_revision: Some(note.source_revision),
            compiled_project_path: Some(EVAL_PROJECT.to_string()),
        }
    }

    fn eval_claim(store: &McStore, acquisition_id: &str, slot: i64, now_ms: i64) -> NoteEvalClaim {
        match store
            .acquire_note_evaluation(
                EVAL_PROJECT,
                acquisition_id,
                "eval-a",
                slot,
                1,
                pick_first,
                now_ms,
            )
            .unwrap()
        {
            NoteEvalAcquireOutcome::Claim {
                claim,
                replayed: false,
                ..
            } => claim,
            other => panic!("expected fresh claim, got {other:?}"),
        }
    }

    fn reload_note(store: &McStore, id: i64) -> StoredNote {
        store
            .get_note_by_id(EVAL_PROJECT, "writer", id)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn note_eval_acquire_replays_lost_claim_response() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        let note = eval_note(&store, "watch the build");
        let claim = eval_claim(&store, "acq-1", 0, 100);
        assert_eq!(claim.note_id, note.id);
        match store
            .acquire_note_evaluation(EVAL_PROJECT, "acq-1", "eval-a", 0, 2, pick_first, 200)
            .unwrap()
        {
            NoteEvalAcquireOutcome::Claim {
                claim: replayed,
                replayed: true,
                ..
            } => {
                assert_eq!(replayed.claim_id, claim.claim_id);
                assert_eq!(replayed.registration_generation, 2);
                assert_eq!(replayed.expires_at, 200 + NOTE_EVAL_CLAIM_LEASE_MS);
            }
            other => panic!("expected replayed claim, got {other:?}"),
        }
        assert_eq!(
            store
                .acquire_note_evaluation(EVAL_PROJECT, "acq-1", "eval-a", 1, 2, pick_first, 200)
                .unwrap(),
            NoteEvalAcquireOutcome::Invalid,
            "a different slot must not steal a replayed acquisition identity"
        );
    }

    #[test]
    fn note_eval_claim_ids_fit_the_wire_id_limit_for_long_project_identities() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let project = format!("dir:/{}", "p".repeat(200));
        let preparing = store
            .authority_begin_prepare("ctx", &project, "notes")
            .unwrap();
        store
            .authority_finish_prepare(
                "ctx",
                &project,
                "notes",
                preparing.generation,
                "hash",
                "hash",
                true,
            )
            .unwrap();
        store
            .insert_project_note(NoteWriteInput {
                project_path: &project,
                route_project_root: None,
                session_id: Some("writer"),
                content: "watch the build",
                surface_condition: Some("condition"),
                anchor_block_id: None,
                anchor_ordinal: None,
                compiled_provider: None,
                compiled_config: None,
                compiled_at: None,
                compile_status: None,
                now_ms: 1,
            })
            .unwrap();
        match store
            .acquire_note_evaluation(&project, "acq-long", "eval-a", 0, 1, pick_first, 100)
            .unwrap()
        {
            NoteEvalAcquireOutcome::Claim { claim, .. } => {
                assert!(
                    claim.claim_id.len() <= 128,
                    "claim id must fit the module's 128-byte id fields, got {} bytes",
                    claim.claim_id.len()
                );
            }
            other => panic!("expected claim, got {other:?}"),
        }
    }

    #[test]
    fn note_eval_no_work_decision_replays_after_work_appears() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        let outcome = store
            .acquire_note_evaluation(
                EVAL_PROJECT,
                "acq-1",
                "eval-a",
                0,
                1,
                |notes| {
                    assert!(notes.is_empty());
                    pick_none(notes)
                },
                100,
            )
            .unwrap();
        assert_eq!(
            outcome,
            NoteEvalAcquireOutcome::NoWork {
                replayed: false,
                cycle_exhausted: false
            }
        );
        eval_note(&store, "new work");
        assert_eq!(
            store
                .acquire_note_evaluation(EVAL_PROJECT, "acq-1", "eval-a", 0, 1, pick_first, 200)
                .unwrap(),
            NoteEvalAcquireOutcome::NoWork {
                replayed: true,
                cycle_exhausted: false
            },
            "the durable decision wins over newly available work"
        );
        assert!(matches!(
            store
                .acquire_note_evaluation(EVAL_PROJECT, "acq-2", "eval-a", 0, 1, pick_first, 300)
                .unwrap(),
            NoteEvalAcquireOutcome::Claim {
                replayed: false,
                ..
            }
        ));
    }

    #[test]
    fn note_eval_exhausted_no_work_decision_survives_replay() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        eval_note(&store, "hidden by a spent cursor");
        let outcome = store
            .acquire_note_evaluation(
                EVAL_PROJECT,
                "acq-1",
                "eval-a",
                0,
                1,
                |_| NoteEvalSelection::NoWork {
                    cycle_exhausted: true,
                },
                100,
            )
            .unwrap();
        assert_eq!(
            outcome,
            NoteEvalAcquireOutcome::NoWork {
                replayed: false,
                cycle_exhausted: true
            }
        );
        assert_eq!(
            store
                .acquire_note_evaluation(EVAL_PROJECT, "acq-1", "eval-a", 0, 1, pick_first, 200)
                .unwrap(),
            NoteEvalAcquireOutcome::NoWork {
                replayed: true,
                cycle_exhausted: true
            }
        );
    }

    #[test]
    fn note_eval_slot_with_active_claim_recovers_it_for_a_new_acquisition() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        eval_note(&store, "watch the build");
        let claim = eval_claim(&store, "acq-1", 0, 100);
        match store
            .acquire_note_evaluation(
                EVAL_PROJECT,
                "acq-2",
                "eval-a",
                0,
                2,
                |_| panic!("selection must not run when the slot already owns a claim"),
                200,
            )
            .unwrap()
        {
            NoteEvalAcquireOutcome::Claim {
                claim: recovered,
                replayed: true,
                ..
            } => {
                assert_eq!(recovered.claim_id, claim.claim_id);
                assert_eq!(recovered.acquisition_id, "acq-2");
            }
            other => panic!("expected recovered claim, got {other:?}"),
        }
        match store
            .acquire_note_evaluation(
                EVAL_PROJECT,
                "acq-2",
                "eval-a",
                0,
                2,
                |_| panic!("a replayed acquisition must not re-select"),
                300,
            )
            .unwrap()
        {
            NoteEvalAcquireOutcome::Claim {
                claim: replayed,
                replayed: true,
                ..
            } => assert_eq!(replayed.claim_id, claim.claim_id),
            other => panic!("expected replayed rebind, got {other:?}"),
        }
    }

    #[test]
    fn note_eval_ledger_rows_are_reclaimed_after_retention() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        eval_note(&store, "note");

        let idle_at = 1_000;
        store
            .acquire_note_evaluation(EVAL_PROJECT, "idle-1", "eval-a", 0, 1, pick_none, idle_at)
            .unwrap();
        let claim = eval_claim(&store, "acq-1", 0, idle_at);
        store
            .complete_note_evaluation(
                EVAL_PROJECT,
                &claim.claim_id,
                "done-1",
                "eval-a",
                0,
                idle_at,
                |_claim, note| Ok(eval_reduced(note, "pending", idle_at)),
            )
            .unwrap();

        let count = |table: &str| -> i64 {
            store
                .inner
                .with_conn(|conn| {
                    Ok(conn
                        .query_row(
                            &format!("SELECT COUNT(*) FROM {table} WHERE project = ?1"),
                            params![EVAL_PROJECT],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap())
                })
                .unwrap()
        };
        assert_eq!(
            count("mc_note_eval_acquisitions"),
            1,
            "the idle poll records a replayable no_work decision"
        );
        assert_eq!(count("mc_note_eval_claims"), 1);

        let after_retention =
            idle_at + NOTE_EVAL_TERMINAL_RETENTION_MS + NOTE_EVAL_NO_WORK_RETENTION_MS + 1;
        store
            .acquire_note_evaluation(
                EVAL_PROJECT,
                "idle-2",
                "eval-a",
                0,
                1,
                pick_none,
                after_retention,
            )
            .unwrap();
        assert_eq!(
            count("mc_note_eval_claims"),
            0,
            "terminal claims past retention must be deleted"
        );
        assert_eq!(
            count("mc_note_eval_acquisitions"),
            1,
            "only the current acquisition should remain"
        );
    }

    #[test]
    fn note_eval_terminal_response_is_redacted_before_row_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        eval_note(&store, "note");

        let now = 1_000;
        let claim = eval_claim(&store, "acq-1", 0, now);
        store
            .complete_note_evaluation(
                EVAL_PROJECT,
                &claim.claim_id,
                "done-1",
                "eval-a",
                0,
                now,
                |_claim, note| Ok(eval_reduced(note, "pending", now)),
            )
            .unwrap();

        let response_state = |at: i64| -> (i64, i64) {
            store
                .acquire_note_evaluation(
                    EVAL_PROJECT,
                    &format!("idle-{at}"),
                    "eval-a",
                    0,
                    1,
                    pick_none,
                    at,
                )
                .unwrap();
            store
                .inner
                .with_conn(|conn| {
                    let rows = conn
                        .query_row(
                            "SELECT COUNT(*) FROM mc_note_eval_claims WHERE project = ?1",
                            params![EVAL_PROJECT],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap();
                    let with_response = conn
                        .query_row(
                            "SELECT COUNT(*) FROM mc_note_eval_claims
                              WHERE project = ?1 AND terminal_response IS NOT NULL",
                            params![EVAL_PROJECT],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap();
                    Ok((rows, with_response))
                })
                .unwrap()
        };

        assert_eq!(
            response_state(now + NOTE_EVAL_RESPONSE_REDACT_MS - 1),
            (1, 1),
            "inside the redact window the replay payload is retained"
        );
        assert_eq!(
            response_state(now + NOTE_EVAL_RESPONSE_REDACT_MS),
            (1, 0),
            "past the redact window the response is nulled while the row is retained"
        );
        assert_eq!(
            response_state(now + NOTE_EVAL_TERMINAL_RETENTION_MS),
            (0, 0),
            "past terminal retention the row itself is deleted"
        );
    }

    #[test]
    fn note_eval_cap_counts_live_claims_not_retained_terminal_ones() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        eval_note(&store, "note");
        let now = 1_000;

        let claim = eval_claim(&store, "acq-1", 0, now);
        store
            .complete_note_evaluation(
                EVAL_PROJECT,
                &claim.claim_id,
                "done-1",
                "eval-a",
                0,
                now,
                |_claim, note| Ok(eval_reduced(note, "pending", now)),
            )
            .unwrap();

        match store
            .acquire_note_evaluation_with_cap(
                EVAL_PROJECT,
                "acq-2",
                "eval-a",
                0,
                1,
                pick_first,
                now + 1,
                1,
            )
            .unwrap()
        {
            NoteEvalAcquireOutcome::Claim { .. } => {}
            other => panic!("terminal rows must not consume the live cap, got {other:?}"),
        }
    }

    #[test]
    fn v51_repair_keeps_a_legacy_artifact_that_has_no_recorded_digest() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        let note = eval_note(&store, "note");

        store
            .inner
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE mc_notes SET compiled_check = 'legacy body', manifest_json = '{}',
                        check_hash = NULL, check_status = 'compiled',
                        compiled_source_revision = NULL
                      WHERE id = ?1",
                    params![note.id],
                )?;
                conn.execute(
                    "DELETE FROM mc_cache_state WHERE session_id = ?1",
                    params!["note_artifact_repair_v51_done"],
                )?;
                Ok(())
            })
            .unwrap();

        store.repair_note_artifacts_v51().unwrap();

        let repaired = reload_note(&store, note.id);
        assert_eq!(
            repaired.compiled_check.as_deref(),
            Some("legacy body"),
            "an unverifiable legacy artifact must be adopted, not destroyed"
        );
        assert!(
            repaired.compiled_source_revision.is_some(),
            "adoption must stamp the provenance so the repair does not run forever"
        );
    }

    #[test]
    fn note_eval_active_claims_are_unique_per_note_and_slot() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        let first = eval_note(&store, "note one");
        let second = eval_note(&store, "note two");
        let claim = eval_claim(&store, "acq-1", 0, 100);
        assert_eq!(claim.note_id, first.id);
        match store
            .acquire_note_evaluation(
                EVAL_PROJECT,
                "acq-2",
                "eval-a",
                1,
                1,
                |notes| {
                    assert_eq!(
                        notes.iter().map(|note| note.id).collect::<Vec<_>>(),
                        vec![second.id],
                        "a claimed note must not be offered again"
                    );
                    pick_first(notes)
                },
                200,
            )
            .unwrap()
        {
            NoteEvalAcquireOutcome::Claim { claim, .. } => assert_eq!(claim.note_id, second.id),
            other => panic!("expected claim on the second note, got {other:?}"),
        }
        assert_eq!(
            store
                .acquire_note_evaluation(
                    EVAL_PROJECT,
                    "acq-3",
                    "eval-b",
                    0,
                    1,
                    |notes| {
                        assert!(notes.is_empty());
                        pick_none(notes)
                    },
                    300,
                )
                .unwrap(),
            NoteEvalAcquireOutcome::NoWork {
                replayed: false,
                cycle_exhausted: false
            }
        );
    }

    #[test]
    fn note_eval_renewal_extends_and_expiry_frees_the_note() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        let note = eval_note(&store, "watch the build");
        let claim = eval_claim(&store, "acq-1", 0, 0);
        assert_eq!(claim.expires_at, NOTE_EVAL_CLAIM_LEASE_MS);
        assert_eq!(
            store
                .renew_note_evaluation_claim(EVAL_PROJECT, &claim.claim_id, "eval-a", 0, 1, 60_000)
                .unwrap(),
            NoteEvalRenewOutcome::Renewed {
                expires_at: 60_000 + NOTE_EVAL_CLAIM_LEASE_MS
            }
        );
        let expiry = 60_000 + NOTE_EVAL_CLAIM_LEASE_MS;
        assert_eq!(
            store
                .renew_note_evaluation_claim(EVAL_PROJECT, &claim.claim_id, "eval-a", 0, 1, expiry)
                .unwrap(),
            NoteEvalRenewOutcome::Expired
        );
        assert!(matches!(
            store
                .renew_note_evaluation_claim(
                    EVAL_PROJECT,
                    &claim.claim_id,
                    "eval-a",
                    0,
                    1,
                    expiry + 1
                )
                .unwrap(),
            NoteEvalRenewOutcome::TerminalReplay { ref kind, .. } if kind == "expired"
        ));
        match store
            .acquire_note_evaluation(
                EVAL_PROJECT,
                "acq-2",
                "eval-b",
                0,
                1,
                pick_first,
                expiry + 1,
            )
            .unwrap()
        {
            NoteEvalAcquireOutcome::Claim {
                claim: second,
                replayed: false,
                ..
            } => assert_eq!(second.note_id, note.id),
            other => panic!("expected the note to be claimable again, got {other:?}"),
        }
        let before = reload_note(&store, note.id);
        assert_eq!(
            store
                .complete_note_evaluation(
                    EVAL_PROJECT,
                    &claim.claim_id,
                    "comp-1",
                    "eval-a",
                    0,
                    expiry + 2,
                    |_claim, note| Ok(eval_reduced(note, "ready", expiry + 2)),
                )
                .unwrap(),
            NoteEvalCompleteOutcome::Conflict { kind: "expired" }
        );
        let after = reload_note(&store, note.id);
        assert_eq!(
            after, before,
            "an expired completion must not mutate the note"
        );
    }

    #[test]
    fn note_eval_completion_applies_replays_and_detects_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        let note = eval_note(&store, "watch the build");
        let claim = eval_claim(&store, "acq-1", 0, 0);
        let response = match store
            .complete_note_evaluation(
                EVAL_PROJECT,
                &claim.claim_id,
                "comp-1",
                "eval-a",
                0,
                50,
                |_claim, note| Ok(eval_reduced(note, "pending", 50)),
            )
            .unwrap()
        {
            NoteEvalCompleteOutcome::Applied { response_json } => response_json,
            other => panic!("expected applied completion, got {other:?}"),
        };
        let applied = reload_note(&store, note.id);
        assert_eq!(applied.state_version, note.state_version + 1);
        assert_eq!(applied.status_version, note.status_version + 1);
        assert_eq!(applied.state_version, applied.status_version);
        assert_eq!(applied.source_revision, note.source_revision);
        assert_eq!(applied.status, "pending");
        assert!(!response.contains("watch the build"));
        assert_eq!(
            store
                .complete_note_evaluation(
                    EVAL_PROJECT,
                    &claim.claim_id,
                    "comp-1",
                    "eval-a",
                    0,
                    60,
                    |_, _| panic!("a replayed completion must not run the reducer"),
                )
                .unwrap(),
            NoteEvalCompleteOutcome::Replayed {
                response_json: response.clone()
            }
        );
        assert_eq!(
            store
                .complete_note_evaluation(
                    EVAL_PROJECT,
                    &claim.claim_id,
                    "comp-2",
                    "eval-a",
                    0,
                    70,
                    |_, _| panic!("a conflicting completion must not run the reducer"),
                )
                .unwrap(),
            NoteEvalCompleteOutcome::Conflict {
                kind: "completion_conflict"
            }
        );
        let second = eval_claim(&store, "acq-2", 0, 100);
        assert_eq!(second.note_id, note.id);
        assert_eq!(second.state_version, applied.state_version);
        match store
            .complete_note_evaluation(
                EVAL_PROJECT,
                &second.claim_id,
                "comp-3",
                "eval-a",
                0,
                150,
                |_claim, note| Ok(eval_reduced(note, "ready", 150)),
            )
            .unwrap()
        {
            NoteEvalCompleteOutcome::Applied { .. } => {
                assert_eq!(reload_note(&store, note.id).status, "ready");
            }
            other => panic!("expected second completion to apply, got {other:?}"),
        }
    }

    #[test]
    fn note_eval_edit_and_dismissal_fence_active_claims() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        let note = eval_note(&store, "watch the build");
        let claim = eval_claim(&store, "acq-1", 0, 0);
        let edited = match store
            .update_note_cas(
                EVAL_PROJECT,
                note.id,
                "pending",
                note.status_version,
                Some("watch the release"),
                None,
                None,
                10,
            )
            .unwrap()
        {
            NoteCasOutcome::Applied(note) => note,
            other => panic!("expected the edit to apply, got {other:?}"),
        };
        assert!(matches!(
            store
                .renew_note_evaluation_claim(EVAL_PROJECT, &claim.claim_id, "eval-a", 0, 1, 20)
                .unwrap(),
            NoteEvalRenewOutcome::TerminalReplay { ref kind, .. } if kind == "stale"
        ));
        assert_eq!(
            store
                .complete_note_evaluation(
                    EVAL_PROJECT,
                    &claim.claim_id,
                    "comp-1",
                    "eval-a",
                    0,
                    30,
                    |_claim, note| Ok(eval_reduced(note, "ready", 30)),
                )
                .unwrap(),
            NoteEvalCompleteOutcome::Conflict { kind: "stale" }
        );
        assert_eq!(reload_note(&store, note.id), edited);

        let second = eval_note(&store, "another note");
        let second_claim = eval_claim(&store, "acq-2", 0, 40);
        assert_eq!(second_claim.note_id, edited.id.min(second.id));
        store
            .dismiss_note(
                EVAL_PROJECT,
                "writer",
                second_claim.note_id,
                Some("done"),
                50,
            )
            .unwrap()
            .expect("dismissal applies");
        assert_eq!(
            store
                .complete_note_evaluation(
                    EVAL_PROJECT,
                    &second_claim.claim_id,
                    "comp-2",
                    "eval-a",
                    0,
                    60,
                    |_claim, note| Ok(eval_reduced(note, "ready", 60)),
                )
                .unwrap(),
            NoteEvalCompleteOutcome::Conflict { kind: "stale" }
        );
        assert_eq!(
            reload_note(&store, second_claim.note_id).status,
            "dismissed"
        );
    }

    #[test]
    fn note_eval_drain_fences_claims_with_authority_changed() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        let note = eval_note(&store, "watch the build");
        let claim = eval_claim(&store, "acq-1", 0, 0);
        let before = reload_note(&store, note.id);
        store
            .authority_begin_drain("ctx", EVAL_PROJECT, "notes", "lease", 1_000_000, 10)
            .unwrap();
        assert!(matches!(
            store
                .renew_note_evaluation_claim(EVAL_PROJECT, &claim.claim_id, "eval-a", 0, 1, 20)
                .unwrap(),
            NoteEvalRenewOutcome::TerminalReplay { ref kind, .. } if kind == "authority_changed"
        ));
        assert_eq!(
            store
                .complete_note_evaluation(
                    EVAL_PROJECT,
                    &claim.claim_id,
                    "comp-1",
                    "eval-a",
                    0,
                    30,
                    |_claim, note| Ok(eval_reduced(note, "ready", 30)),
                )
                .unwrap(),
            NoteEvalCompleteOutcome::Conflict {
                kind: "authority_changed"
            }
        );
        assert_eq!(reload_note(&store, note.id), before);
        assert_eq!(
            store
                .acquire_note_evaluation(EVAL_PROJECT, "acq-2", "eval-a", 0, 1, pick_first, 40)
                .unwrap(),
            NoteEvalAcquireOutcome::AuthorityChanged
        );
    }

    #[test]
    fn note_eval_ledger_caps_return_busy_and_tombstones_replay_expired() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        eval_note(&store, "note one");
        eval_note(&store, "note two");
        assert!(matches!(
            store
                .acquire_note_evaluation_with_cap(
                    EVAL_PROJECT,
                    "acq-1",
                    "eval-a",
                    0,
                    1,
                    pick_first,
                    0,
                    1
                )
                .unwrap(),
            NoteEvalAcquireOutcome::Claim { .. }
        ));
        assert_eq!(
            store
                .acquire_note_evaluation_with_cap(
                    EVAL_PROJECT,
                    "acq-2",
                    "eval-a",
                    1,
                    1,
                    pick_first,
                    10,
                    1
                )
                .unwrap(),
            NoteEvalAcquireOutcome::Busy,
            "a saturated protected claim ledger must refuse new claims"
        );
        assert_eq!(
            store
                .acquire_note_evaluation_with_cap(
                    EVAL_PROJECT,
                    "acq-3",
                    "eval-b",
                    0,
                    1,
                    pick_none,
                    20,
                    1
                )
                .unwrap(),
            NoteEvalAcquireOutcome::NoWork {
                replayed: false,
                cycle_exhausted: false
            }
        );
        assert_eq!(
            store
                .acquire_note_evaluation_with_cap(
                    EVAL_PROJECT,
                    "acq-4",
                    "eval-b",
                    0,
                    1,
                    pick_none,
                    30,
                    1
                )
                .unwrap(),
            NoteEvalAcquireOutcome::Busy,
            "a saturated no-work ledger must refuse new decisions"
        );
        let after_retention = 20 + NOTE_EVAL_NO_WORK_RETENTION_MS + 1;
        assert_eq!(
            store
                .acquire_note_evaluation_with_cap(
                    EVAL_PROJECT,
                    "acq-4",
                    "eval-b",
                    0,
                    1,
                    pick_none,
                    after_retention,
                    1
                )
                .unwrap(),
            NoteEvalAcquireOutcome::NoWork {
                replayed: false,
                cycle_exhausted: false
            },
            "tombstoning the expired decision frees ledger capacity"
        );
        assert_eq!(
            store
                .acquire_note_evaluation_with_cap(
                    EVAL_PROJECT,
                    "acq-3",
                    "eval-b",
                    0,
                    1,
                    pick_none,
                    after_retention + 1,
                    1
                )
                .unwrap(),
            NoteEvalAcquireOutcome::Expired,
            "a tombstoned decision replays as expired"
        );
    }

    #[test]
    fn note_eval_abandon_is_replayable_and_never_touches_the_note() {
        let dir = tempfile::tempdir().unwrap();
        let store = note_eval_store(dir.path());
        let note = eval_note(&store, "watch the build");
        let before = reload_note(&store, note.id);
        let claim = eval_claim(&store, "acq-1", 0, 0);
        assert_eq!(
            store
                .abandon_note_evaluation_claim(EVAL_PROJECT, &claim.claim_id, "eval-a", 0, 10)
                .unwrap(),
            NoteEvalAbandonOutcome::Abandoned
        );
        assert_eq!(
            reload_note(&store, note.id),
            before,
            "abandon must not change note state or failure counters"
        );
        assert_eq!(
            store
                .abandon_note_evaluation_claim(EVAL_PROJECT, &claim.claim_id, "eval-a", 0, 20)
                .unwrap(),
            NoteEvalAbandonOutcome::Replayed {
                kind: "abandoned".to_string()
            }
        );
        match store
            .acquire_note_evaluation(EVAL_PROJECT, "acq-2", "eval-a", 0, 1, pick_first, 30)
            .unwrap()
        {
            NoteEvalAcquireOutcome::Claim { claim: second, .. } => {
                assert_eq!(second.note_id, note.id)
            }
            other => panic!("expected the note to be claimable after abandon, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod shadow_tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend};

    fn store(dir: &std::path::Path) -> McStore {
        McStore::open(&StorageDescriptor {
            module_id: "magic-context-test".to_string(),
            storage_namespace: "mc_cache".to_string(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().to_string(),
            },
        })
        .unwrap()
    }

    fn comp(sequence: i64, end: i64, end_id: &str) -> StoredCompartment {
        StoredCompartment {
            sequence,
            start_message: 0,
            end_message: end,
            start_message_id: "a#0".to_string(),
            end_message_id: end_id.to_string(),
            title: "c".to_string(),
            content: "p1".to_string(),
            p1: Some("p1".to_string()),
            importance: 50,
            ..Default::default()
        }
    }

    fn apply_state_sync_sections(
        store: &McStore,
        expected_shadow_seq: u64,
        user_profile: Option<&[String]>,
        workspace_present: bool,
        workspace: Option<&ModuleWorkspaceRow>,
    ) {
        store
            .apply_authority_state_sync(ModuleStateSyncRequest {
                session_id: "section-delta-session",
                project_path: "project",
                shadow_generation: 0,
                expected_shadow_seq,
                seed_boundary_id: None,
                drop_seeds: &[],
                drop_seed_skipped: 0,
                pending_agent_drops: &[],
                pending_agent_drops_skipped: 0,
                user_hint_seeds: &[],
                auto_search_hint_skipped: 0,
                user_hints_replace_session: false,
                note_nudge_anchors: None,
                todo_synthetic_anchor: None,
                todo_synthetic_anchor_present: false,
                emergency_latches: None,
                pending_compaction_marker: None,
                deferred_execute_state: None,
                channel2_nudge_state: None,
                strip_seeds: &[],
                strip_seed_skipped: 0,
                reasoning_cleared_through_tag: None,
                compartments: &[],
                user_profile: user_profile.unwrap_or(&[]),
                user_profile_present: user_profile.is_some(),
                workspace,
                workspace_present,
                last_todo_state: None,
                project_memory_epoch: None,
                user_profile_version: None,
                acked_watermarks: serde_json::json!({"section_seq": expected_shadow_seq}),
            })
            .unwrap();
    }

    type SectionSnapshot = (Vec<(i64, String)>, Vec<(i64, String, String)>);

    fn section_snapshot(store: &McStore) -> SectionSnapshot {
        store
            .inner
            .with_conn(|conn| {
                let profiles = conn
                    .prepare("SELECT id, content FROM mc_user_memories ORDER BY id")?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<Result<Vec<(i64, String)>, _>>()?;
                let workspaces = conn
                    .prepare(
                        "SELECT workspace.id, member.project_path, member.display_name
                           FROM mc_workspaces workspace
                           JOIN mc_workspace_members member ON member.workspace_id = workspace.id
                          ORDER BY workspace.id, member.project_path",
                    )?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<Result<Vec<(i64, String, String)>, _>>()?;
                Ok((profiles, workspaces))
            })
            .unwrap()
    }

    #[test]
    fn state_sync_sections_distinguish_absent_empty_and_legacy_always_present() {
        let workspace_a = ModuleWorkspaceRow {
            name: "workspace-a".to_string(),
            share_categories: vec!["CONSTRAINTS".to_string()],
            members: vec![ModuleWorkspaceMemberRow {
                project_path: "project".to_string(),
                display_name: "project".to_string(),
                display_path: "project".to_string(),
            }],
        };
        let workspace_b = ModuleWorkspaceRow {
            name: "workspace-b".to_string(),
            ..workspace_a.clone()
        };
        let profile_a = vec!["profile-a".to_string()];
        let profile_b = vec!["profile-b".to_string()];

        let mixed_dir = tempfile::tempdir().unwrap();
        let mixed = store(mixed_dir.path());
        apply_state_sync_sections(&mixed, 0, Some(&profile_a), true, Some(&workspace_a));
        let before_absent = section_snapshot(&mixed);
        apply_state_sync_sections(&mixed, 1, None, false, None);
        assert_eq!(
            section_snapshot(&mixed),
            before_absent,
            "absent sections must be untouched"
        );
        apply_state_sync_sections(&mixed, 2, Some(&profile_b), true, Some(&workspace_b));
        let mixed_final = section_snapshot(&mixed);

        let always_dir = tempfile::tempdir().unwrap();
        let always = store(always_dir.path());
        apply_state_sync_sections(&always, 0, Some(&profile_a), true, Some(&workspace_a));
        apply_state_sync_sections(&always, 1, Some(&profile_a), true, Some(&workspace_a));
        apply_state_sync_sections(&always, 2, Some(&profile_b), true, Some(&workspace_b));
        let always_final = section_snapshot(&always);
        assert_eq!(
            mixed_final.0.iter().map(|row| &row.1).collect::<Vec<_>>(),
            vec![&"profile-b".to_string()]
        );
        assert_eq!(
            mixed_final.1.iter().map(|row| &row.1).collect::<Vec<_>>(),
            vec![&"project".to_string()]
        );
        assert_eq!(
            mixed_final.0.iter().map(|row| &row.1).collect::<Vec<_>>(),
            always_final.0.iter().map(|row| &row.1).collect::<Vec<_>>(),
        );
        assert_eq!(
            mixed_final
                .1
                .iter()
                .map(|row| (&row.1, &row.2))
                .collect::<Vec<_>>(),
            always_final
                .1
                .iter()
                .map(|row| (&row.1, &row.2))
                .collect::<Vec<_>>(),
        );

        apply_state_sync_sections(&mixed, 3, Some(&[]), true, None);
        assert_eq!(section_snapshot(&mixed), (Vec::new(), Vec::new()));
    }

    #[test]
    fn authority_note_seed_frame_uses_one_fenced_transaction_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let rows = (1..=8)
            .map(|source_row_id| AuthoritySeedRow {
                source_row_id,
                snapshot: serde_json::json!({
                    "id": source_row_id,
                    "project_path": "project",
                    "session_id": format!("session-{source_row_id}"),
                    "content": format!("note {source_row_id}"),
                    "status": "active"
                }),
            })
            .collect::<Vec<_>>();
        let before = store.authority_seed_transaction_count_for_test();
        let first = store
            .seed_authority_rows("store-uuid", "project", "notes", &rows)
            .unwrap();
        assert_eq!(
            store.authority_seed_transaction_count_for_test(),
            before + 1,
            "one wire frame must use one fenced transaction regardless of row count"
        );
        let state_before_retry = store
            .authority_seed_checksum("store-uuid", "project", "notes")
            .unwrap();
        let second = store
            .seed_authority_rows("store-uuid", "project", "notes", &rows)
            .unwrap();
        assert_eq!(
            first, second,
            "re-seeding a frame reuses source-key identities"
        );
        assert_eq!(
            store.authority_seed_transaction_count_for_test(),
            before + 2
        );
        assert_eq!(
            store
                .authority_seed_checksum("store-uuid", "project", "notes")
                .unwrap(),
            state_before_retry,
            "re-seeding the same frame must be a no-op"
        );
    }

    #[test]
    fn authority_state_machine_persists_generations_and_drain_journal() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store
            .bind_authority_route("store-uuid", "project", "/repo")
            .unwrap();
        let preparing = store
            .authority_begin_prepare("store-uuid", "project", "memories")
            .unwrap();
        assert_eq!(preparing.state, "PREPARING");
        assert_eq!(preparing.generation, 1);
        assert_eq!(
            store
                .authority_project_for_route("/repo", "memories")
                .unwrap(),
            None,
            "PREPARING must keep transforms on the complete TypeScript snapshot"
        );
        let module = store
            .authority_finish_prepare(
                "store-uuid",
                "project",
                "memories",
                preparing.generation,
                "hash",
                "hash",
                true,
            )
            .unwrap();
        assert_eq!(module.state, "MODULE");
        assert_eq!(module.generation, 2);
        assert_eq!(
            store
                .authority_project_for_route("/repo", "memories")
                .unwrap()
                .as_deref(),
            Some("project")
        );
        let draining = store
            .authority_begin_drain("store-uuid", "project", "memories", "lease", 100, 0)
            .unwrap();
        assert_eq!(draining.state, "DRAINING");
        assert_eq!(draining.captured_upper_bound, Some(0));
        assert_eq!(
            store
                .authority_project_for_route("/repo", "memories")
                .unwrap()
                .as_deref(),
            Some("project")
        );
        let token = draining.coordinator_token.clone().expect("token minted");
        let stepped = store
            .authority_drain_step(
                "store-uuid",
                "project",
                "memories",
                draining.generation,
                "seed",
                Some(0),
                &token,
                0,
            )
            .unwrap();
        assert!(stepped.step_seed);
    }

    #[test]
    fn authority_drain_begin_resumes_each_crash_journal_position() {
        for completed_steps in [0usize, 3, 6] {
            let dir = tempfile::tempdir().unwrap();
            let store = store(dir.path());
            let preparing = store
                .authority_begin_prepare("store-uuid", "project", "memories")
                .unwrap();
            store
                .authority_finish_prepare(
                    "store-uuid",
                    "project",
                    "memories",
                    preparing.generation,
                    "hash",
                    "hash",
                    true,
                )
                .unwrap();
            let draining = store
                .authority_begin_drain("store-uuid", "project", "memories", "coordinator", 100, 0)
                .unwrap();
            let token = draining.coordinator_token.clone().expect("token minted");
            let steps = [
                "seed",
                "memories",
                "notes",
                "compartments",
                "reconcile",
                "verify",
            ];
            for step in steps.iter().take(completed_steps) {
                store
                    .authority_drain_step(
                        "store-uuid",
                        "project",
                        "memories",
                        draining.generation,
                        step,
                        Some(0),
                        &token,
                        0,
                    )
                    .unwrap();
            }

            let resumed = store
                .authority_begin_drain("store-uuid", "project", "memories", "coordinator", 200, 101)
                .unwrap();
            assert_eq!(resumed.generation, draining.generation);
            assert_eq!(resumed.captured_upper_bound, draining.captured_upper_bound);
            let resume_token = resumed.coordinator_token.clone().expect("resume token");
            assert_ne!(
                resume_token, token,
                "resume mints a fresh coordinator token"
            );
            for step in steps.iter().skip(completed_steps) {
                store
                    .authority_drain_step(
                        "store-uuid",
                        "project",
                        "memories",
                        resumed.generation,
                        step,
                        Some(0),
                        &resume_token,
                        101,
                    )
                    .unwrap();
            }
            let finished = store
                .authority_finish_drain(
                    "store-uuid",
                    "project",
                    "memories",
                    resumed.generation,
                    "hash",
                    "hash",
                    true,
                    &resume_token,
                    101,
                )
                .unwrap();
            assert_eq!(finished.state, "TS");
        }
    }

    #[test]
    fn authority_drain_resume_rejects_a_different_live_lease() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let preparing = store
            .authority_begin_prepare("store-uuid", "project", "memories")
            .unwrap();
        store
            .authority_finish_prepare(
                "store-uuid",
                "project",
                "memories",
                preparing.generation,
                "hash",
                "hash",
                true,
            )
            .unwrap();
        store
            .authority_begin_drain("store-uuid", "project", "memories", "first", 200, 100)
            .unwrap();
        assert!(store
            .authority_begin_drain("store-uuid", "project", "memories", "second", 250, 150)
            .is_err());
        let resumed = store
            .authority_begin_drain("store-uuid", "project", "memories", "second", 400, 201)
            .unwrap();
        assert_eq!(resumed.coordinator_lease.as_deref(), Some("second"));
    }

    #[test]
    fn authority_drain_stale_coordinator_token_rejected_after_takeover() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let preparing = store
            .authority_begin_prepare("store-uuid", "project", "memories")
            .unwrap();
        store
            .authority_finish_prepare(
                "store-uuid",
                "project",
                "memories",
                preparing.generation,
                "hash",
                "hash",
                true,
            )
            .unwrap();
        let first = store
            .authority_begin_drain("store-uuid", "project", "memories", "first", 100, 0)
            .unwrap();
        let stale_token = first.coordinator_token.clone().expect("first token");
        let second = store
            .authority_begin_drain("store-uuid", "project", "memories", "second", 400, 101)
            .unwrap();
        let live_token = second.coordinator_token.clone().expect("second token");
        assert_ne!(stale_token, live_token);
        assert!(store
            .authority_drain_step(
                "store-uuid",
                "project",
                "memories",
                second.generation,
                "seed",
                Some(0),
                &stale_token,
                150,
            )
            .is_err());
        assert!(store
            .authority_finish_drain(
                "store-uuid",
                "project",
                "memories",
                second.generation,
                "hash",
                "hash",
                true,
                &stale_token,
                150,
            )
            .is_err());
        store
            .authority_drain_step(
                "store-uuid",
                "project",
                "memories",
                second.generation,
                "seed",
                Some(0),
                &live_token,
                150,
            )
            .unwrap();
    }

    #[test]
    fn authority_seq_fence_rejects_an_interleaved_stale_sender() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let session = "authority-session";
        let project = "authority-project";

        store
            .apply_authority_state_sync(ModuleStateSyncRequest {
                session_id: session,
                project_path: project,
                shadow_generation: 0,
                expected_shadow_seq: 0,
                seed_boundary_id: None,
                drop_seeds: &[],
                drop_seed_skipped: 0,
                strip_seeds: &[],
                strip_seed_skipped: 0,
                reasoning_cleared_through_tag: None,
                compartments: &[comp(0, 0, "first#0")],
                user_profile: &[],
                user_profile_present: true,
                workspace: None,
                workspace_present: true,
                last_todo_state: Some("first".to_string()),
                project_memory_epoch: None,
                user_profile_version: None,
                pending_agent_drops: &[],
                pending_agent_drops_skipped: 0,
                user_hint_seeds: &[],
                auto_search_hint_skipped: 0,
                user_hints_replace_session: false,
                note_nudge_anchors: None,
                todo_synthetic_anchor: None,
                todo_synthetic_anchor_present: false,
                emergency_latches: None,
                pending_compaction_marker: None,
                deferred_execute_state: None,
                channel2_nudge_state: None,
                acked_watermarks: serde_json::json!({"sender": "first"}),
            })
            .unwrap();

        let stale = store
            .apply_authority_state_sync(ModuleStateSyncRequest {
                session_id: session,
                project_path: project,
                shadow_generation: 0,
                expected_shadow_seq: 0,
                seed_boundary_id: None,
                drop_seeds: &[],
                drop_seed_skipped: 0,
                strip_seeds: &[],
                strip_seed_skipped: 0,
                reasoning_cleared_through_tag: None,
                compartments: &[comp(1, 1, "second#0")],
                user_profile: &[],
                user_profile_present: true,
                workspace: None,
                workspace_present: true,
                last_todo_state: Some("second".to_string()),
                project_memory_epoch: None,
                user_profile_version: None,
                pending_agent_drops: &[],
                pending_agent_drops_skipped: 0,
                user_hint_seeds: &[],
                auto_search_hint_skipped: 0,
                user_hints_replace_session: false,
                note_nudge_anchors: None,
                todo_synthetic_anchor: None,
                todo_synthetic_anchor_present: false,
                emergency_latches: None,
                pending_compaction_marker: None,
                deferred_execute_state: None,
                channel2_nudge_state: None,
                acked_watermarks: serde_json::json!({"sender": "second"}),
            })
            .unwrap_err();

        assert!(matches!(
            stale,
            ModuleStateSyncError::AuthoritySeqMismatch {
                expected: 0,
                found: 1
            }
        ));
        let loaded = store.load(session).unwrap();
        assert_eq!(loaded.meta.shadow_seq, 1);
        assert_eq!(loaded.meta.last_todo_state.as_deref(), Some("first"));
        assert_eq!(
            store.load_compartments(session).unwrap()[0].end_message_id,
            "first#0"
        );
    }
}

#[cfg(test)]
mod lineage_descent_tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend};

    fn store(dir: &std::path::Path) -> McStore {
        McStore::open(&StorageDescriptor {
            module_id: "magic-context-lineage-test".to_string(),
            storage_namespace: "mc_cache".to_string(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().to_string(),
            },
        })
        .unwrap()
    }

    fn compartment(sequence: i64, start: i64, end: i64, end_id: &str) -> StoredCompartment {
        StoredCompartment {
            sequence,
            start_message: start,
            end_message: end,
            start_message_id: format!("m{start}#0"),
            end_message_id: end_id.to_string(),
            title: format!("range-{start}-{end}"),
            content: format!("history {start} through {end}"),
            p1: Some(format!("history {start} through {end}")),
            importance: 50,
            ..Default::default()
        }
    }

    fn seed_lineage(store: &McStore, key: &str, newest_live_ordinal: u64) {
        let core = CoreState {
            boundary_id: "m6#0".to_string(),
            ..CoreState::default()
        };
        let meta = ModuleMeta {
            initialized: true,
            newest_live_ordinal,
            coverage_ordinal: Some(6),
            ..ModuleMeta::default()
        };
        store.commit(key, None, &core, &meta).unwrap();
        store
            .append_compartments(
                key,
                &[compartment(1, 1, 3, "m3#0"), compartment(2, 4, 6, "m6#0")],
            )
            .unwrap();
    }

    fn anchor() -> LineageAnchor {
        LineageAnchor {
            block_id: "summary#1".to_string(),
            message_id: "summary".to_string(),
            content_hash: "abc123".to_string(),
            ordinal: 1,
        }
    }

    fn direct_hop(prior: &str, target: &str, epoch: u64) -> Vec<LineageConstituent> {
        vec![LineageConstituent {
            prior_key: prior.to_string(),
            new_key: target.to_string(),
            epoch,
        }]
    }

    #[test]
    fn descent_accepts_a_zero_based_fresh_anchor() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_lineage(&store, "A", 10);
        let hops = direct_hop("A", "B", 2);
        let anchor = LineageAnchor {
            block_id: "ccm-0#1".to_string(),
            message_id: "ccm-0".to_string(),
            content_hash: "abc123".to_string(),
            ordinal: 0,
        };
        let outcome = store
            .descend_lineage(LineageDescentRequest {
                target_key: "B",
                expected_target_row_version: None,
                edge_id: 42,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &hops,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 10,
            })
            .unwrap();
        assert_eq!(outcome.disposition, LineageDescentDisposition::Descended);
        assert_eq!(outcome.prior_last_ordinal, Some(10));
        let target = store.load("B").unwrap();
        assert_eq!(target.meta.coverage_ordinal, Some(11));
        assert_eq!(target.core.boundary_id, "ccm-0#1");
    }

    #[test]
    fn descent_refuses_a_mid_space_anchor() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_lineage(&store, "A", 10);
        let hops = direct_hop("A", "B", 2);
        let anchor = LineageAnchor {
            block_id: "ccm-2#0".to_string(),
            message_id: "ccm-2".to_string(),
            content_hash: "abc123".to_string(),
            ordinal: 2,
        };
        let error = store
            .descend_lineage(LineageDescentRequest {
                target_key: "B",
                expected_target_row_version: None,
                edge_id: 43,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &hops,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 10,
            })
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("expected a fresh origin (0 or 1)"),
            "{error}"
        );
    }

    #[test]
    fn descent_copies_verbatim_ranges_and_session_notes_without_replay_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_lineage(&store, "A", 10);
        let source_note = store
            .insert_note(NoteInput {
                project_path: "git:project",
                route_project_root: None,
                session_id: "A",
                content: "remember the inherited note",
                surface_condition: None,
                anchor_block_id: Some("m2#0"),
                now_ms: 1,
            })
            .unwrap();
        store
            .inner
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO mc_tags
                         (session_id, tag_number, block_id, kind, token_count, created_at_ms, source_bytes)
                      VALUES ('A', 1, 'm2#0', 'message', 7, 1, X'61')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO mc_temporal_marks(session_id, block_id, marker_text, created_at)
                     VALUES ('A', 'm2#0', '<!-- +1m -->', 1)",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO mc_chunk_transcripts(
                         session_id, compartment_seq, start_ordinal, end_ordinal,
                         transcript_deflate, created_at_ms
                     ) VALUES ('A', 1, 1, 3, ?1, 1)",
                    params![compress_transcript("U: pre-compaction transcript").unwrap()],
                )?;
                Ok(())
            })
            .unwrap();
        let before_epoch = store.load("A").unwrap().meta.revert_epoch;
        let hops = direct_hop("A", "B", 2);
        let anchor = anchor();
        let outcome = store
            .descend_lineage(LineageDescentRequest {
                target_key: "B",
                expected_target_row_version: None,
                edge_id: 41,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &hops,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 10,
            })
            .unwrap();
        assert_eq!(outcome.disposition, LineageDescentDisposition::Descended);
        assert_eq!(outcome.source_key.as_deref(), Some("A"));
        assert_eq!(outcome.prior_last_ordinal, Some(10));
        assert!(outcome.materialization_required && outcome.acknowledge);

        let copied = store.load_compartments("B").unwrap();
        assert_eq!(
            copied
                .iter()
                .map(|row| (
                    row.start_message,
                    row.end_message,
                    row.end_message_id.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![(1, 3, "m3#0"), (4, 6, "m6#0"), (11, 11, "summary#1")]
        );
        let target = store.load("B").unwrap();
        assert!(target.meta.descent_completed);
        assert_eq!(target.meta.anchor_block_id.as_deref(), Some("summary#1"));
        assert_eq!(target.meta.anchor_content_hash.as_deref(), Some("abc123"));
        assert_eq!(target.meta.ordinal_continuation_base, Some(10));
        assert_eq!(target.core.boundary_id, "summary#1");
        assert_eq!(
            store.load("A").unwrap().meta.revert_epoch,
            before_epoch + 1,
            "descent must activate the shipped prior-key historian fence"
        );
        let copied_markers = store
            .inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT
                         (SELECT COUNT(*) FROM mc_tags WHERE session_id = 'B'),
                         (SELECT COUNT(*) FROM mc_temporal_marks WHERE session_id = 'B')",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
            })
            .unwrap();
        assert_eq!(copied_markers, (1, 1));
        let inherited_notes = store.read_notes("git:project", "B", 10, 0).unwrap();
        assert_eq!(inherited_notes.len(), 1);
        assert_ne!(inherited_notes[0].id, source_note.id);
        assert_eq!(inherited_notes[0].content, source_note.content);
        assert_eq!(
            inherited_notes[0].anchor_block_id.as_deref(),
            source_note.anchor_block_id.as_deref()
        );
        let transcript = store.load_chunk_transcripts_for_range("B", 1, 3).unwrap();
        assert_eq!(transcript.len(), 1);
        assert_eq!(
            transcript[0].transcript.as_deref(),
            Some("U: pre-compaction transcript")
        );
        assert_eq!(
            (transcript[0].start_ordinal, transcript[0].end_ordinal),
            (1, 3)
        );

        let replay = store
            .descend_lineage(LineageDescentRequest {
                target_key: "B",
                expected_target_row_version: target.row_version,
                edge_id: 41,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &hops,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 11,
            })
            .unwrap();
        assert_eq!(replay.disposition, LineageDescentDisposition::Replay);
        assert_eq!(
            store.load("A").unwrap().meta.revert_epoch,
            before_epoch + 1,
            "write-free replay must not re-bump the prior publish fence"
        );
        assert_eq!(
            store.read_notes("git:project", "B", 10, 0).unwrap().len(),
            1,
            "a replay must not duplicate inherited session notes"
        );
    }

    #[test]
    fn newest_completed_constituent_wins_and_unmarked_rows_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_lineage(&store, "A", 10);
        let first_hops = direct_hop("A", "B", 2);
        let anchor = anchor();
        store
            .descend_lineage(LineageDescentRequest {
                target_key: "B",
                expected_target_row_version: None,
                edge_id: 1,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &first_hops,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 1,
            })
            .unwrap();
        store
            .append_compartments("B", &[compartment(4, 12, 13, "b-work#0")])
            .unwrap();
        let mut b = store.load("B").unwrap();
        b.meta.newest_live_ordinal = 14;
        store.commit("B", b.row_version, &b.core, &b.meta).unwrap();
        let composed = vec![
            LineageConstituent {
                prior_key: "A".to_string(),
                new_key: "B".to_string(),
                epoch: 2,
            },
            LineageConstituent {
                prior_key: "B".to_string(),
                new_key: "C".to_string(),
                epoch: 3,
            },
        ];
        let c = store
            .descend_lineage(LineageDescentRequest {
                target_key: "C",
                expected_target_row_version: None,
                edge_id: 2,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 3,
                constituents: &composed,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 2,
            })
            .unwrap();
        assert_eq!(c.source_key.as_deref(), Some("B"));
        assert!(store
            .load_compartments("C")
            .unwrap()
            .iter()
            .any(|row| row.end_message_id == "b-work#0"));

        let mut unmarked_meta = ModuleMeta {
            initialized: true,
            newest_live_ordinal: 20,
            ..ModuleMeta::default()
        };
        let mut unmarked_core = CoreState::default();
        unmarked_core.boundary_id.clear();
        store
            .commit("D", None, &unmarked_core, &unmarked_meta)
            .unwrap();
        store
            .append_compartments("D", &[compartment(1, 18, 19, "aborted-own-row#0")])
            .unwrap();
        unmarked_meta = store.load("D").unwrap().meta;
        assert!(!unmarked_meta.descent_completed);
        let through_unmarked = vec![
            LineageConstituent {
                prior_key: "A".to_string(),
                new_key: "D".to_string(),
                epoch: 4,
            },
            LineageConstituent {
                prior_key: "D".to_string(),
                new_key: "E".to_string(),
                epoch: 5,
            },
        ];
        let e = store
            .descend_lineage(LineageDescentRequest {
                target_key: "E",
                expected_target_row_version: None,
                edge_id: 3,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 5,
                constituents: &through_unmarked,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 3,
            })
            .unwrap();
        assert_eq!(e.source_key.as_deref(), Some("A"));
        assert!(!store
            .load_compartments("E")
            .unwrap()
            .iter()
            .any(|row| row.end_message_id == "aborted-own-row#0"));
    }

    #[test]
    fn terminal_branches_are_durable_before_ack() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let anchor = anchor();

        let unknown_hops = direct_hop("missing", "unknown", 2);
        let unknown = store
            .descend_lineage(LineageDescentRequest {
                target_key: "unknown",
                expected_target_row_version: None,
                edge_id: 10,
                prior_key: "missing",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &unknown_hops,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 1,
            })
            .unwrap();
        assert_eq!(
            unknown.disposition,
            LineageDescentDisposition::UnknownAncestor
        );
        assert!(unknown.acknowledge);
        assert_eq!(
            store
                .load("unknown")
                .unwrap()
                .meta
                .lineage_descent_disposition,
            "unknown_ancestor"
        );

        store
            .commit(
                "legacy-source",
                None,
                &CoreState::default(),
                &ModuleMeta::default(),
            )
            .unwrap();
        let build_skew_hops = direct_hop("legacy-source", "build-skew", 2);
        let build_skew = store
            .descend_lineage(LineageDescentRequest {
                target_key: "build-skew",
                expected_target_row_version: None,
                edge_id: 9,
                prior_key: "legacy-source",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &build_skew_hops,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 1,
            })
            .unwrap();
        assert_eq!(
            build_skew.disposition,
            LineageDescentDisposition::PendingBuildSkew
        );
        assert!(!build_skew.acknowledge);
        assert_eq!(
            store
                .load("build-skew")
                .unwrap()
                .meta
                .lineage_descent_counters
                .pending_build_skew,
            1
        );

        seed_lineage(&store, "A", 10);
        let missing_shape_hops = direct_hop("A", "rewind", 2);
        let rewind = store
            .descend_lineage(LineageDescentRequest {
                target_key: "rewind",
                expected_target_row_version: None,
                edge_id: 11,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &missing_shape_hops,
                compaction_observed: true,
                anchor: None,
                now_ms: 2,
            })
            .unwrap();
        assert_eq!(
            rewind.disposition,
            LineageDescentDisposition::NotCompactionShape
        );
        assert!(store.load_compartments("rewind").unwrap().is_empty());

        let flag_hops = direct_hop("A", "restart-window", 2);
        let flag_missing = store
            .descend_lineage(LineageDescentRequest {
                target_key: "restart-window",
                expected_target_row_version: None,
                edge_id: 12,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &flag_hops,
                compaction_observed: false,
                anchor: Some(&anchor),
                now_ms: 3,
            })
            .unwrap();
        assert_eq!(
            flag_missing.disposition,
            LineageDescentDisposition::ObservedFlagMissingShapePresent
        );

        let boot_core = CoreState {
            boundary_id: "own#0".to_string(),
            ..CoreState::default()
        };
        store
            .commit("boot", None, &boot_core, &ModuleMeta::default())
            .unwrap();
        let boot_hops = direct_hop("A", "boot", 2);
        let boot = store
            .descend_lineage(LineageDescentRequest {
                target_key: "boot",
                expected_target_row_version: store.load("boot").unwrap().row_version,
                edge_id: 13,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &boot_hops,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 4,
            })
            .unwrap();
        assert_eq!(
            boot.disposition,
            LineageDescentDisposition::AlreadyBootstrapped
        );
        assert_eq!(store.load("boot").unwrap().core.boundary_id, "own#0");

        let cycle = vec![
            LineageConstituent {
                prior_key: "A".to_string(),
                new_key: "B".to_string(),
                epoch: 2,
            },
            LineageConstituent {
                prior_key: "B".to_string(),
                new_key: "cycle-target".to_string(),
                epoch: 2,
            },
        ];
        let cycle_outcome = store
            .descend_lineage(LineageDescentRequest {
                target_key: "cycle-target",
                expected_target_row_version: None,
                edge_id: 14,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &cycle,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 5,
            })
            .unwrap();
        assert_eq!(
            cycle_outcome.disposition,
            LineageDescentDisposition::CycleDetected
        );
    }

    #[test]
    fn descent_cas_loser_leaves_the_concurrent_target_and_prior_fence_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_lineage(&store, "A", 10);
        store
            .commit("B", None, &CoreState::default(), &ModuleMeta::default())
            .unwrap();
        let target_before = store.load("B").unwrap();
        let prior_before = store.load("A").unwrap();
        let hops = direct_hop("A", "B", 2);
        let anchor = anchor();

        let error = store
            .descend_lineage(LineageDescentRequest {
                target_key: "B",
                expected_target_row_version: None,
                edge_id: 19,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &hops,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 1,
            })
            .unwrap_err();
        assert!(matches!(
            error,
            McStoreError::CasConflict {
                expected: None,
                found: _
            }
        ));
        let target_after = store.load("B").unwrap();
        assert_eq!(target_after.row_version, target_before.row_version);
        assert!(target_after.meta.lineage_descent_disposition.is_empty());
        assert_eq!(
            store.load("A").unwrap().meta.revert_epoch,
            prior_before.meta.revert_epoch
        );

        let retry = store
            .descend_lineage(LineageDescentRequest {
                target_key: "B",
                expected_target_row_version: target_before.row_version,
                edge_id: 19,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &hops,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 2,
            })
            .unwrap();
        assert_eq!(retry.disposition, LineageDescentDisposition::Descended);
    }

    #[test]
    fn invalid_source_ranges_abort_without_partial_target_or_prior_fence() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_lineage(&store, "A", 10);
        store
            .replace_compartments(
                "A",
                &[compartment(1, 1, 6, "m6#0"), compartment(2, 5, 8, "m8#0")],
            )
            .unwrap();
        let prior_before = store.load("A").unwrap();
        let hops = direct_hop("A", "B", 2);
        let anchor = anchor();
        let error = store
            .descend_lineage(LineageDescentRequest {
                target_key: "B",
                expected_target_row_version: None,
                edge_id: 20,
                prior_key: "A",
                prior_epoch: 1,
                new_epoch: 2,
                constituents: &hops,
                compaction_observed: true,
                anchor: Some(&anchor),
                now_ms: 1,
            })
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("lineage descent validation failed"));
        assert!(store.load("B").unwrap().row_version.is_none());
        assert!(store.load_compartments("B").unwrap().is_empty());
        let prior_after = store.load("A").unwrap();
        assert_eq!(prior_after.row_version, prior_before.row_version);
        assert_eq!(
            prior_after.meta.revert_epoch,
            prior_before.meta.revert_epoch
        );
    }
}
