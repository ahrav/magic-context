//! Rebuildable committed-claim mirror.
//!
//! This projection is deliberately separate from the staged claim-intent ledger. It
//! stores only public claim identities and committed snapshots. Full reseeds require
//! the intent ledger to be drained; receipt groups advance project checkpoints only
//! after every effect in the receipt has applied.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use mc_core::claim_operation::{
    canonical_json_encode, canonical_snapshot_vector, is_lower_hex, is_valid_public_claim_id,
    parse_revision_locator, sha256_hex_utf8, SnapshotVector, MAX_SAFE_INTEGER,
};
use mc_core::redaction::{
    redact_durable_text, secret_shaped_json_key, Detection, RedactionErrorKind,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ensure_durable_text_bound, retire_active_scan_owner_kind, DurableWriteFamily, McStore,
    PreparedWrite, WriteDisposition,
};

/// Version of full-snapshot and receipt-group inputs accepted by this mirror.
pub const CLAIM_MIRROR_VERSION: u32 = 1;
/// Version of generation vectors accepted by this mirror.
pub const CLAIM_MIRROR_VECTOR_VERSION: u32 = 1;
/// Version of the `claim.mirror.*` facade transport. Independent from
/// `CLAIM_MIRROR_VERSION` so transport evolution cannot silently reinterpret
/// snapshot or receipt payloads. Mirrors `CLAIM_MIRROR_PROTOCOL_VERSION` on the
/// host wire; the host decoder compares it for exact equality.
pub const CLAIM_MIRROR_PROTOCOL_VERSION: u32 = 1;

/// Authoritative lifecycle stored with a committed claim revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimMirrorLifecycle {
    /// Claim participates in current retrieval.
    Active,
    /// Claim remains committed but is not active.
    Archived,
    /// Claim has left the committed mirror view.
    Retired,
}

impl ClaimMirrorLifecycle {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
            Self::Retired => "retired",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "active" => Some(Self::Active),
            "archived" => Some(Self::Archived),
            "retired" => Some(Self::Retired),
            _ => None,
        }
    }
}

/// Source outbox change that caused a committed mirror refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimMirrorChangeKind {
    /// Claim content or attributes changed.
    Upsert,
    /// Supporting evidence changed.
    Evidence,
    /// Lifecycle state changed.
    Lifecycle,
    /// Applicability state changed.
    Applicability,
    /// Verification state changed.
    Verification,
    /// Derivation state changed.
    Derivation,
}

/// Complete committed state for one public claim. JSON fields preserve the
/// authoritative claim vocabulary without introducing legacy memory defaults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommittedClaimMirrorRow {
    /// Stable public claim identifier.
    pub public_claim_id: String,
    /// Owning project identifier.
    pub project_id: i64,
    /// Public claim revision and content digest locator.
    pub revision_locator: String,
    /// Committed claim text.
    pub content: String,
    /// Lowercase SHA-256 digest of `content`.
    pub content_digest: String,
    /// Authoritative claim attributes object.
    pub attributes: Value,
    /// Authoritative lifecycle state.
    pub lifecycle: ClaimMirrorLifecycle,
    /// Authoritative applicability object.
    pub applicability: Value,
    /// Authoritative policy object.
    pub policy: Value,
    /// Optional source label safe for display.
    pub provenance_label: Option<String>,
    /// Project generation represented by this row.
    pub project_generation: i64,
    /// Policy generation represented by this row.
    pub policy_generation: i64,
}

/// Atomic full snapshot. Project checkpoints identify the last source effect
/// included by the snapshot for each project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimMirrorSnapshot {
    /// Input schema version.
    pub mirror_version: u32,
    /// Complete project and policy generation vector.
    pub vector: SnapshotVector,
    /// Last included source effect ID for each project.
    pub project_checkpoints: BTreeMap<i64, i64>,
    /// Complete committed claim set.
    pub claims: Vec<CommittedClaimMirrorRow>,
}

/// One source effect in a complete receipt. `previous_project_effect_id` is the
/// source outbox predecessor for this project, making omissions detectable even
/// when unrelated projects occupy intervening global effect IDs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimMirrorEffect {
    /// Globally ordered source effect ID.
    pub effect_id: i64,
    /// Previous source effect ID for this project.
    pub previous_project_effect_id: i64,
    /// Nonempty unique source effect key.
    pub effect_key: String,
    /// Project changed by this effect.
    pub project_id: i64,
    /// Resulting project generation.
    pub generation: i64,
    /// Source change category.
    pub change_kind: ClaimMirrorChangeKind,
    /// Claim changed by this effect.
    pub public_claim_id: String,
    /// Revision locator named by this effect.
    pub revision_locator: String,
    /// `None` means the claim is absent from the committed mirror view. This is
    /// how policy-only revocation removes an otherwise unchanged revision.
    pub claim: Option<CommittedClaimMirrorRow>,
}

/// Every effect from one lifetime source receipt, in source effect-ID order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimMirrorReceiptGroup {
    /// Input schema version.
    pub mirror_version: u32,
    /// Stable source receipt identifier.
    pub receipt_id: i64,
    /// Effect count declared by the source receipt.
    pub expected_effect_count: usize,
    /// Complete generation vector after applying the receipt.
    pub vector: SnapshotVector,
    /// Contiguous effects in source effect-ID order.
    pub effects: Vec<ClaimMirrorEffect>,
}

/// Committed generation and source-outbox checkpoint for one project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimMirrorProjectState {
    /// Latest mirrored project generation.
    pub project_generation: i64,
    /// Latest mirrored policy generation.
    pub policy_generation: i64,
    /// Last applied source effect ID for this project.
    pub acked_effect_id: i64,
}

/// Current mirror incarnation, workspace epoch, and per-project progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimMirrorState {
    /// Stored mirror schema version.
    pub mirror_version: u32,
    /// Stored generation-vector schema version.
    pub vector_version: u32,
    /// Database incarnation fenced by this mirror.
    pub database_incarnation_id: String,
    /// Workspace epoch fenced by this mirror.
    pub workspace_epoch: String,
    /// Progress keyed by project ID.
    pub projects: BTreeMap<i64, ClaimMirrorProjectState>,
}

/// Result of applying or replaying one complete receipt group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimMirrorApplyResult {
    /// Whether an identical receipt had already been applied.
    pub replayed: bool,
    /// Number of effects applied by this call.
    pub applied_effect_count: usize,
}

/// Validation, fencing, or storage failure from committed-mirror operations.
#[derive(Debug)]
pub enum ClaimMirrorError {
    /// Underlying durable-store failure.
    Store(cortexkit_store::StoreError),
    /// Invalid snapshot or receipt input.
    Invalid(String),
    /// Durable text violated redaction policy.
    Redaction(mc_core::redaction::RedactionErrorKind),
    /// Incremental receipt arrived before a full seed.
    NotSeeded,
    /// Input targeted a different database incarnation.
    IncarnationMismatch {
        /// Incarnation accepted by current state.
        expected: String,
        /// Incarnation carried by the input.
        found: String,
    },
    /// Input generation did not follow stored project state.
    GenerationMismatch {
        /// Project with the mismatch.
        project_id: i64,
        /// Required next generation.
        expected: i64,
        /// Generation carried by the input.
        found: i64,
    },
    /// Effect predecessor did not match the stored project checkpoint.
    CheckpointMismatch {
        /// Project with the mismatch.
        project_id: i64,
        /// Stored predecessor effect ID.
        expected: i64,
        /// Predecessor effect ID carried by the input.
        found: i64,
    },
    /// A receipt ID was replayed with different canonical bytes.
    ReceiptConflict {
        /// Conflicting receipt identifier.
        receipt_id: i64,
    },
    /// Reset cannot proceed while claim intents remain unresolved.
    ResetBlocked {
        /// Number of unresolved intents.
        unresolved: usize,
    },
    /// Existing mirror state requires the explicit rebuild transition.
    ResetRequired,
}

impl std::fmt::Display for ClaimMirrorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(f, "store: {error}"),
            Self::Invalid(reason) => write!(f, "invalid claim mirror input: {reason}"),
            Self::Redaction(kind) => write!(f, "claim mirror durable text rejected: {kind:?}"),
            Self::NotSeeded => write!(f, "claim mirror has not been seeded"),
            Self::IncarnationMismatch { expected, found } => write!(
                f,
                "claim mirror incarnation mismatch: expected {expected}, found {found}"
            ),
            Self::GenerationMismatch {
                project_id,
                expected,
                found,
            } => write!(
                f,
                "claim mirror project {project_id} generation mismatch: expected {expected}, found {found}"
            ),
            Self::CheckpointMismatch {
                project_id,
                expected,
                found,
            } => write!(
                f,
                "claim mirror project {project_id} checkpoint mismatch: expected {expected}, found {found}"
            ),
            Self::ReceiptConflict { receipt_id } => {
                write!(f, "claim mirror receipt {receipt_id} was replayed with different bytes")
            }
            Self::ResetBlocked { unresolved } => write!(
                f,
                "claim mirror reset refused while {unresolved} claim intents remain unresolved"
            ),
            Self::ResetRequired => write!(
                f,
                "claim mirror replacement requires begin_claim_store_rebuild"
            ),
        }
    }
}

impl std::error::Error for ClaimMirrorError {}

impl From<cortexkit_store::StoreError> for ClaimMirrorError {
    fn from(error: cortexkit_store::StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<crate::McStoreError> for ClaimMirrorError {
    fn from(error: crate::McStoreError) -> Self {
        match error {
            crate::McStoreError::Redaction(kind) => Self::Redaction(kind),
            // Preserve storage failures instead of classifying them as invalid input.
            crate::McStoreError::Store(error) => Self::Store(error),
            crate::McStoreError::Serde(reason) => Self::Invalid(reason),
            _ => Self::Invalid("claim mirror preparation failed".to_string()),
        }
    }
}

fn prepare_claim_text(
    write: &mut PreparedWrite,
    claim: &CommittedClaimMirrorRow,
) -> Result<(), ClaimMirrorError> {
    write.identity("claim_content", &claim.content)?;
    prepare_integrity_json(write, "claim_attributes", &claim.attributes)?;
    prepare_integrity_json(write, "claim_applicability", &claim.applicability)?;
    prepare_integrity_json(write, "claim_policy", &claim.policy)?;
    if let Some(label) = &claim.provenance_label {
        write.identity("provenance_label", label)?;
    }
    Ok(())
}

fn prepare_integrity_json(
    write: &mut PreparedWrite,
    field_id: &'static str,
    value: &Value,
) -> Result<(), ClaimMirrorError> {
    /// A secret-named key only conceals a secret when text sits under it.
    /// Rejecting `{"token_count": 3}` refuses a count that no scanner would flag.
    fn carries_text(value: &Value) -> bool {
        match value {
            Value::String(text) => !text.is_empty(),
            Value::Array(values) => values.iter().any(carries_text),
            Value::Object(fields) => fields.values().any(carries_text),
            Value::Null | Value::Bool(_) | Value::Number(_) => false,
        }
    }

    fn reject_secret_shaped_keys(value: &Value) -> Result<(), ClaimMirrorError> {
        match value {
            Value::Array(values) => values.iter().try_for_each(reject_secret_shaped_keys),
            Value::Object(fields) => fields.iter().try_for_each(|(key, value)| {
                if secret_shaped_json_key(key) && carries_text(value) {
                    return Err(ClaimMirrorError::Redaction(
                        RedactionErrorKind::SecretDetected,
                    ));
                }
                reject_secret_shaped_keys(value)
            }),
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(()),
        }
    }

    /// Scans each leaf on its own rather than a concatenation of them.
    ///
    /// No separator is safe to join on: the keyed rules skip whitespace between `=` and the
    /// value, so a field ending in `password=` swallows the next field's text and reports a
    /// secret that neither field contains.
    ///
    /// Object keys are stored verbatim, so scan them for credentials.
    fn scan_leaves(value: &Value, detections: &mut Vec<Detection>) -> Result<(), ClaimMirrorError> {
        match value {
            Value::String(text) => {
                ensure_durable_text_bound(text)?;
                detections.extend(redact_durable_text(text).detections);
                Ok(())
            }
            Value::Array(values) => values
                .iter()
                .try_for_each(|value| scan_leaves(value, detections)),
            Value::Object(fields) => fields.iter().try_for_each(|(key, value)| {
                ensure_durable_text_bound(key)?;
                detections.extend(redact_durable_text(key).detections);
                scan_leaves(value, detections)
            }),
            Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        }
    }

    reject_secret_shaped_keys(value)?;
    // Per-leaf bounds admit many small strings whose canonical encoding, which is what the
    // mirror stores, exceeds the durable limit.
    ensure_durable_text_bound(&validate_json_object(value, field_id)?)?;
    let mut detections = Vec::new();
    scan_leaves(value, &mut detections)?;
    if !detections.is_empty() {
        return Err(ClaimMirrorError::Redaction(
            RedactionErrorKind::SecretDetected,
        ));
    }
    write.record_observed_scan(field_id, detections, "reject");
    Ok(())
}

fn existing_claim_ids_tx(
    tx: &rusqlite::Transaction<'_>,
    incarnation: &str,
) -> rusqlite::Result<BTreeSet<String>> {
    let mut statement = tx.prepare(
        "SELECT public_claim_id FROM mc_claim_mirror_claims
          WHERE database_incarnation_id = ?1",
    )?;
    let ids = statement
        .query_map(params![incarnation], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    Ok(ids)
}

fn valid_project_id(project_id: i64) -> bool {
    (1..=MAX_SAFE_INTEGER).contains(&project_id)
}

fn validate_json_object(value: &Value, field: &str) -> Result<String, ClaimMirrorError> {
    if !value.is_object() {
        return Err(ClaimMirrorError::Invalid(format!(
            "{field} must be an object"
        )));
    }
    canonical_json_encode(value).map_err(|error| ClaimMirrorError::Invalid(error.to_string()))
}

fn validate_vector(vector: &SnapshotVector) -> Result<BTreeSet<i64>, ClaimMirrorError> {
    if vector.vector_version != CLAIM_MIRROR_VECTOR_VERSION {
        return Err(ClaimMirrorError::Invalid(format!(
            "snapshot vector version {} is unsupported",
            vector.vector_version
        )));
    }
    if !is_lower_hex(&vector.database_incarnation_id, 32) {
        return Err(ClaimMirrorError::Invalid(
            "database incarnation ID must be 32 lowercase hex characters".to_string(),
        ));
    }
    if vector.workspace_epoch.is_empty() {
        return Err(ClaimMirrorError::Invalid(
            "workspace epoch must not be empty".to_string(),
        ));
    }
    if vector
        .project_generations
        .keys()
        .ne(vector.policy_generations.keys())
    {
        return Err(ClaimMirrorError::Invalid(
            "project and policy generation vectors must name the same projects".to_string(),
        ));
    }

    let mut projects = BTreeSet::new();
    for (key, project_generation) in &vector.project_generations {
        let project_id = key.parse::<i64>().map_err(|_| {
            ClaimMirrorError::Invalid(format!("generation key {key:?} is not a project ID"))
        })?;
        if !valid_project_id(project_id) || key != &project_id.to_string() {
            return Err(ClaimMirrorError::Invalid(format!(
                "generation key {key:?} is not a canonical project ID"
            )));
        }
        let policy_generation = vector.policy_generations[key];
        if !(0..=MAX_SAFE_INTEGER).contains(project_generation)
            || !(0..=MAX_SAFE_INTEGER).contains(&policy_generation)
        {
            return Err(ClaimMirrorError::Invalid(format!(
                "project {project_id} generation is outside the safe range"
            )));
        }
        projects.insert(project_id);
    }
    Ok(projects)
}

fn validate_claim(
    claim: &CommittedClaimMirrorRow,
    vector: &SnapshotVector,
) -> Result<(), ClaimMirrorError> {
    if !is_valid_public_claim_id(&claim.public_claim_id) {
        return Err(ClaimMirrorError::Invalid(format!(
            "invalid public claim ID {}",
            claim.public_claim_id
        )));
    }
    if !valid_project_id(claim.project_id) {
        return Err(ClaimMirrorError::Invalid(format!(
            "invalid project ID {}",
            claim.project_id
        )));
    }
    let locator = parse_revision_locator(&claim.revision_locator).ok_or_else(|| {
        ClaimMirrorError::Invalid(format!(
            "invalid revision locator {}",
            claim.revision_locator
        ))
    })?;
    if locator.public_claim_id != claim.public_claim_id
        || locator.content_digest != claim.content_digest
    {
        return Err(ClaimMirrorError::Invalid(format!(
            "revision locator does not match claim {}",
            claim.public_claim_id
        )));
    }
    if sha256_hex_utf8(&claim.content) != claim.content_digest {
        return Err(ClaimMirrorError::Invalid(format!(
            "content digest does not match claim {}",
            claim.public_claim_id
        )));
    }
    let key = claim.project_id.to_string();
    let project_generation = vector.project_generations.get(&key).ok_or_else(|| {
        ClaimMirrorError::Invalid(format!(
            "claim {} project {} is absent from generation vector",
            claim.public_claim_id, claim.project_id
        ))
    })?;
    let policy_generation = vector.policy_generations[&key];
    if claim.project_generation != *project_generation
        || claim.policy_generation != policy_generation
    {
        return Err(ClaimMirrorError::Invalid(format!(
            "claim {} generation does not match snapshot vector",
            claim.public_claim_id
        )));
    }
    validate_json_object(&claim.attributes, "claim attributes")?;
    validate_json_object(&claim.applicability, "claim applicability")?;
    validate_json_object(&claim.policy, "claim policy")?;
    if claim
        .provenance_label
        .as_deref()
        .is_some_and(|label| label.is_empty() || label.len() > 512)
    {
        return Err(ClaimMirrorError::Invalid(
            "provenance label must contain 1..=512 bytes".to_string(),
        ));
    }
    Ok(())
}

fn validate_snapshot(snapshot: &ClaimMirrorSnapshot) -> Result<(), ClaimMirrorError> {
    if snapshot.mirror_version != CLAIM_MIRROR_VERSION {
        return Err(ClaimMirrorError::Invalid(format!(
            "mirror version {} is unsupported",
            snapshot.mirror_version
        )));
    }
    let projects = validate_vector(&snapshot.vector)?;
    if snapshot
        .project_checkpoints
        .keys()
        .copied()
        .collect::<BTreeSet<_>>()
        != projects
    {
        return Err(ClaimMirrorError::Invalid(
            "snapshot checkpoints must name every generation-vector project".to_string(),
        ));
    }
    if snapshot
        .project_checkpoints
        .iter()
        .any(|(project_id, checkpoint)| {
            !valid_project_id(*project_id) || !(0..=MAX_SAFE_INTEGER).contains(checkpoint)
        })
    {
        return Err(ClaimMirrorError::Invalid(
            "snapshot checkpoint is outside the safe range".to_string(),
        ));
    }
    let mut public_ids = BTreeSet::new();
    let mut locators = BTreeSet::new();
    for claim in &snapshot.claims {
        validate_claim(claim, &snapshot.vector)?;
        if !public_ids.insert(&claim.public_claim_id) {
            return Err(ClaimMirrorError::Invalid(format!(
                "duplicate public claim ID {}",
                claim.public_claim_id
            )));
        }
        if !locators.insert(&claim.revision_locator) {
            return Err(ClaimMirrorError::Invalid(format!(
                "duplicate revision locator {}",
                claim.revision_locator
            )));
        }
    }
    Ok(())
}

fn validate_group(group: &ClaimMirrorReceiptGroup) -> Result<String, ClaimMirrorError> {
    if group.mirror_version != CLAIM_MIRROR_VERSION {
        return Err(ClaimMirrorError::Invalid(format!(
            "mirror version {} is unsupported",
            group.mirror_version
        )));
    }
    validate_vector(&group.vector)?;
    if group.receipt_id <= 0 || group.receipt_id > MAX_SAFE_INTEGER {
        return Err(ClaimMirrorError::Invalid(
            "receipt ID is outside the safe range".to_string(),
        ));
    }
    if group.expected_effect_count == 0 || group.expected_effect_count != group.effects.len() {
        return Err(ClaimMirrorError::Invalid(format!(
            "receipt {} expected {} effects but carried {}",
            group.receipt_id,
            group.expected_effect_count,
            group.effects.len()
        )));
    }

    let first_effect_id = group.effects.first().map(|effect| effect.effect_id);
    let mut keys = BTreeSet::new();
    for (index, effect) in group.effects.iter().enumerate() {
        let expected_effect_id = i64::try_from(index)
            .ok()
            .and_then(|index| first_effect_id.and_then(|first| first.checked_add(index)));
        if expected_effect_id != Some(effect.effect_id)
            || effect.effect_id <= 0
            || effect.effect_id > MAX_SAFE_INTEGER
        {
            return Err(ClaimMirrorError::Invalid(
                "receipt effects must have contiguous positive IDs".to_string(),
            ));
        }
        if effect.effect_key.is_empty() || !keys.insert(&effect.effect_key) {
            return Err(ClaimMirrorError::Invalid(
                "receipt effect keys must be nonempty and unique".to_string(),
            ));
        }
        if !valid_project_id(effect.project_id)
            || !(0..effect.effect_id).contains(&effect.previous_project_effect_id)
        {
            return Err(ClaimMirrorError::Invalid(format!(
                "effect {} has an invalid project predecessor",
                effect.effect_id
            )));
        }
        if !is_valid_public_claim_id(&effect.public_claim_id) {
            return Err(ClaimMirrorError::Invalid(format!(
                "effect {} has an invalid public claim ID",
                effect.effect_id
            )));
        }
        let locator = parse_revision_locator(&effect.revision_locator).ok_or_else(|| {
            ClaimMirrorError::Invalid(format!(
                "effect {} has an invalid revision locator",
                effect.effect_id
            ))
        })?;
        if locator.public_claim_id != effect.public_claim_id {
            return Err(ClaimMirrorError::Invalid(format!(
                "effect {} claim and revision locator disagree",
                effect.effect_id
            )));
        }
        let key = effect.project_id.to_string();
        if group.vector.project_generations.get(&key) != Some(&effect.generation) {
            return Err(ClaimMirrorError::Invalid(format!(
                "effect {} generation disagrees with receipt vector",
                effect.effect_id
            )));
        }
        if let Some(claim) = &effect.claim {
            validate_claim(claim, &group.vector)?;
            if claim.public_claim_id != effect.public_claim_id
                || claim.project_id != effect.project_id
                || claim.revision_locator != effect.revision_locator
            {
                return Err(ClaimMirrorError::Invalid(format!(
                    "effect {} hydrated claim disagrees with effect identity",
                    effect.effect_id
                )));
            }
        }
    }

    let value = serde_json::to_value(group)
        .map_err(|error| ClaimMirrorError::Invalid(error.to_string()))?;
    let canonical = canonical_json_encode(&value)
        .map_err(|error| ClaimMirrorError::Invalid(error.to_string()))?;
    Ok(sha256_hex_utf8(&canonical))
}

fn row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<CommittedClaimMirrorRow> {
    let lifecycle: String = row.get(6)?;
    let attributes: String = row.get(5)?;
    let applicability: String = row.get(7)?;
    let policy: String = row.get(8)?;
    Ok(CommittedClaimMirrorRow {
        public_claim_id: row.get(0)?,
        project_id: row.get(1)?,
        revision_locator: row.get(2)?,
        content: row.get(3)?,
        content_digest: row.get(4)?,
        attributes: serde_json::from_str(&attributes).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        lifecycle: ClaimMirrorLifecycle::parse(&lifecycle).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                "invalid claim mirror lifecycle".into(),
            )
        })?,
        applicability: serde_json::from_str(&applicability).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        policy: serde_json::from_str(&policy).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                8,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        provenance_label: row.get(9)?,
        project_generation: row.get(10)?,
        policy_generation: row.get(11)?,
    })
}

fn read_claims(
    conn: &rusqlite::Connection,
    database_incarnation_id: &str,
    project_id: Option<i64>,
) -> rusqlite::Result<Vec<CommittedClaimMirrorRow>> {
    let mut statement = conn.prepare_cached(
        "SELECT public_claim_id, project_id, revision_locator, content,
                content_digest, attributes_json, lifecycle_state,
                applicability_json, policy_json, provenance_label,
                project_generation, policy_generation
           FROM mc_claim_mirror_claims
          WHERE database_incarnation_id = ?1
            AND (?2 IS NULL OR project_id = ?2)
          ORDER BY project_id, public_claim_id",
    )?;
    let rows = statement.query_map(params![database_incarnation_id, project_id], row_from_sql)?;
    rows.collect()
}

fn insert_claim(
    tx: &rusqlite::Transaction<'_>,
    incarnation: &str,
    claim: &CommittedClaimMirrorRow,
) -> rusqlite::Result<()> {
    let revision = parse_revision_locator(&claim.revision_locator)
        .ok_or(rusqlite::Error::InvalidQuery)?
        .revision;
    let attributes =
        canonical_json_encode(&claim.attributes).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let applicability =
        canonical_json_encode(&claim.applicability).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let policy = canonical_json_encode(&claim.policy).map_err(|_| rusqlite::Error::InvalidQuery)?;
    tx.execute(
        "INSERT INTO mc_claim_mirror_claims(
            database_incarnation_id, public_claim_id, project_id, revision_locator,
            revision, content, content_digest, attributes_json, lifecycle_state,
            applicability_json, policy_json, provenance_label,
            project_generation, policy_generation
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(database_incarnation_id, public_claim_id) DO UPDATE SET
            project_id = excluded.project_id,
            revision_locator = excluded.revision_locator,
            revision = excluded.revision,
            content = excluded.content,
            content_digest = excluded.content_digest,
            attributes_json = excluded.attributes_json,
            lifecycle_state = excluded.lifecycle_state,
            applicability_json = excluded.applicability_json,
            policy_json = excluded.policy_json,
            provenance_label = excluded.provenance_label,
            project_generation = excluded.project_generation,
            policy_generation = excluded.policy_generation",
        params![
            incarnation,
            claim.public_claim_id,
            claim.project_id,
            claim.revision_locator,
            revision,
            claim.content,
            claim.content_digest,
            attributes,
            claim.lifecycle.as_str(),
            applicability,
            policy,
            claim.provenance_label,
            claim.project_generation,
            claim.policy_generation,
        ],
    )?;
    Ok(())
}

fn read_project_states(
    conn: &rusqlite::Connection,
    incarnation: &str,
) -> rusqlite::Result<BTreeMap<i64, ClaimMirrorProjectState>> {
    let mut statement = conn.prepare_cached(
        "SELECT project_id, project_generation, policy_generation, acked_effect_id
           FROM mc_claim_mirror_projects
          WHERE database_incarnation_id = ?1 ORDER BY project_id",
    )?;
    let rows = statement.query_map([incarnation], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            ClaimMirrorProjectState {
                project_generation: row.get(1)?,
                policy_generation: row.get(2)?,
                acked_effect_id: row.get(3)?,
            },
        ))
    })?;
    rows.collect()
}

pub(crate) fn snapshot_vector_from_connection(
    conn: &rusqlite::Connection,
) -> rusqlite::Result<Option<SnapshotVector>> {
    let state = conn
        .query_row(
            "SELECT vector_version, database_incarnation_id, workspace_epoch
               FROM mc_claim_mirror_state WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((vector_version, database_incarnation_id, workspace_epoch)) = state else {
        return Ok(None);
    };
    let projects = read_project_states(conn, &database_incarnation_id)?;
    Ok(Some(SnapshotVector {
        vector_version,
        database_incarnation_id,
        workspace_epoch,
        project_generations: projects
            .iter()
            .map(|(project_id, state)| (project_id.to_string(), state.project_generation))
            .collect(),
        policy_generations: projects
            .iter()
            .map(|(project_id, state)| (project_id.to_string(), state.policy_generation))
            .collect(),
    }))
}

fn claim_intent_control(conn: &rusqlite::Connection) -> rusqlite::Result<Option<(String, String)>> {
    conn.query_row(
        "SELECT database_incarnation_id, transition_state
           FROM mc_claim_intent_controls WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

fn unresolved_claim_intents(conn: &rusqlite::Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM mc_claim_intents
          WHERE state IN ('staged', 'context-committed')",
        [],
        |row| row.get(0),
    )
}

fn clear_claim_mirror(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM mc_claim_mirror_receipts", [])?;
    tx.execute("DELETE FROM mc_claim_mirror_claims", [])?;
    tx.execute("DELETE FROM mc_claim_mirror_projects", [])?;
    tx.execute("DELETE FROM mc_claim_mirror_state", [])?;
    Ok(())
}

impl McStore {
    /// Read the committed mirror vector and every per-project checkpoint.
    pub fn claim_mirror_state(&self) -> Result<Option<ClaimMirrorState>, ClaimMirrorError> {
        self.inner
            .with_conn(|conn| {
                let state = conn
                    .query_row(
                        "SELECT mirror_version, vector_version, database_incarnation_id,
                                workspace_epoch
                           FROM mc_claim_mirror_state WHERE id = 1",
                        [],
                        |row| {
                            Ok(ClaimMirrorState {
                                mirror_version: row.get(0)?,
                                vector_version: row.get(1)?,
                                database_incarnation_id: row.get(2)?,
                                workspace_epoch: row.get(3)?,
                                projects: BTreeMap::new(),
                            })
                        },
                    )
                    .optional()?;
                let Some(mut state) = state else {
                    return Ok(None);
                };
                state.projects = read_project_states(conn, &state.database_incarnation_id)?;
                Ok(Some(state))
            })
            .map_err(Into::into)
    }

    /// List committed claims bound to one database incarnation, optionally by project.
    pub fn list_claim_mirror(
        &self,
        database_incarnation_id: &str,
        project_id: Option<i64>,
    ) -> Result<Vec<CommittedClaimMirrorRow>, ClaimMirrorError> {
        self.inner
            .with_conn(|conn| read_claims(conn, database_incarnation_id, project_id))
            .map_err(Into::into)
    }

    /// Atomically replace the full rebuildable mirror from a validated snapshot.
    ///
    /// Replacing existing state requires `begin_claim_store_rebuild`; every staged
    /// U5 intent must be terminal before this method can delete prior mirror rows.
    pub fn replace_claim_mirror_snapshot(
        &self,
        snapshot: &ClaimMirrorSnapshot,
        now_ms: i64,
    ) -> Result<(), ClaimMirrorError> {
        validate_snapshot(snapshot)?;
        let mut write = PreparedWrite::new(DurableWriteFamily::ClaimMirror);
        write.domain_owner(
            "database",
            &snapshot.vector.database_incarnation_id,
            "claim_mirror",
        );
        write.identity("workspace_epoch", &snapshot.vector.workspace_epoch)?;
        write.identity(
            "database_incarnation_id",
            &snapshot.vector.database_incarnation_id,
        )?;
        for claim in &snapshot.claims {
            prepare_claim_text(&mut write, claim)?;
        }
        let incarnation = &snapshot.vector.database_incarnation_id;
        let outcome = write.execute(&self.inner, |coordinated| {
            let tx = coordinated.tx();
            let existing_ids = existing_claim_ids_tx(tx, incarnation)?;
            for claim in &snapshot.claims {
                let prepared = &mut coordinated.prepared.borrow_mut();
                let recorded = if existing_ids.contains(&claim.public_claim_id) {
                    prepared.existing_identity("public_claim_id", &claim.public_claim_id)
                } else {
                    prepared.identity("public_claim_id", &claim.public_claim_id)
                };
                recorded
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            }
            let unresolved = unresolved_claim_intents(tx)?;
            if unresolved > 0 {
                return Ok(WriteDisposition::Replay(Err(
                    ClaimMirrorError::ResetBlocked {
                        unresolved: unresolved as usize,
                    },
                )));
            }
            let existing: Option<String> = tx
                .query_row(
                    "SELECT database_incarnation_id FROM mc_claim_mirror_state WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let control = claim_intent_control(tx)?;
            if let Some((control_incarnation, _)) = control.as_ref() {
                if control_incarnation != incarnation {
                    return Ok(WriteDisposition::Replay(Err(
                        ClaimMirrorError::IncarnationMismatch {
                            expected: control_incarnation.clone(),
                            found: incarnation.clone(),
                        },
                    )));
                }
            }
            if existing.is_some() {
                let projects = read_project_states(tx, incarnation)?;
                let vector_matches = snapshot_vector_from_connection(tx)?
                    .as_ref()
                    .is_some_and(|vector| vector == &snapshot.vector);
                let checkpoints_match = projects.iter().all(|(project_id, project)| {
                    snapshot.project_checkpoints.get(project_id) == Some(&project.acked_effect_id)
                });
                let mut expected_claims = snapshot.claims.clone();
                expected_claims.sort_by(|left, right| {
                    left.project_id
                        .cmp(&right.project_id)
                        .then_with(|| left.public_claim_id.cmp(&right.public_claim_id))
                });
                if vector_matches
                    && checkpoints_match
                    && read_claims(tx, incarnation, None)? == expected_claims
                {
                    return Ok(WriteDisposition::Replay(Ok(())));
                }
                if !matches!(control.as_ref(), Some((_, state)) if state == "resetting") {
                    return Ok(WriteDisposition::Replay(Err(
                        ClaimMirrorError::ResetRequired,
                    )));
                }
            }
            if existing.is_none()
                && matches!(control.as_ref(), Some((_, state)) if state == "draining")
            {
                return Ok(WriteDisposition::Replay(Err(
                    ClaimMirrorError::ResetRequired,
                )));
            }

            if let Some(existing_incarnation) = existing.as_deref() {
                retire_active_scan_owner_kind(
                    tx,
                    "database",
                    existing_incarnation,
                    "claim_mirror",
                )?;
            }
            clear_claim_mirror(tx)?;
            tx.execute(
                "INSERT INTO mc_claim_mirror_state(
                    id, mirror_version, vector_version, database_incarnation_id,
                    workspace_epoch, updated_at_ms
                 ) VALUES (1, ?1, ?2, ?3, ?4, ?5)",
                params![
                    CLAIM_MIRROR_VERSION,
                    CLAIM_MIRROR_VECTOR_VERSION,
                    incarnation,
                    snapshot.vector.workspace_epoch,
                    now_ms,
                ],
            )?;
            for (project, generation) in &snapshot.vector.project_generations {
                let project_id: i64 = project.parse().map_err(|_| rusqlite::Error::InvalidQuery)?;
                tx.execute(
                    "INSERT INTO mc_claim_mirror_projects(
                        database_incarnation_id, project_id, project_generation,
                        policy_generation, acked_effect_id
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        incarnation,
                        project_id,
                        generation,
                        snapshot.vector.policy_generations[project],
                        snapshot.project_checkpoints[&project_id],
                    ],
                )?;
            }
            for claim in &snapshot.claims {
                insert_claim(tx, incarnation, claim)?;
            }
            if matches!(control.as_ref(), Some((_, state)) if state == "resetting") {
                tx.execute(
                    "UPDATE mc_claim_intent_controls
                        SET transition_state = 'accepting', updated_at_ms = ?1
                      WHERE id = 1",
                    [now_ms],
                )?;
            }
            Ok(WriteDisposition::Applied(Ok(())))
        })?;
        outcome
    }

    /// Atomically apply every hydrated effect from one complete source receipt.
    pub fn apply_claim_mirror_receipt(
        &self,
        group: &ClaimMirrorReceiptGroup,
        now_ms: i64,
    ) -> Result<ClaimMirrorApplyResult, ClaimMirrorError> {
        let group_digest = validate_group(group)?;
        let mut write = PreparedWrite::new(DurableWriteFamily::ClaimMirror);
        write.domain_owner(
            "database",
            &group.vector.database_incarnation_id,
            "claim_mirror",
        );
        write.existing_identity(
            "database_incarnation_id",
            &group.vector.database_incarnation_id,
        )?;
        write.existing_identity("workspace_epoch", &group.vector.workspace_epoch)?;
        for effect in &group.effects {
            if let Some(claim) = &effect.claim {
                prepare_claim_text(&mut write, claim)?;
            }
        }
        let incarnation = &group.vector.database_incarnation_id;
        let generation_vector_json = canonical_snapshot_vector(&group.vector)
            .map_err(|error| ClaimMirrorError::Invalid(error.to_string()))?;
        write.identity("generation_vector", &generation_vector_json)?;
        let effect_count = i64::try_from(group.expected_effect_count).map_err(|_| {
            ClaimMirrorError::Invalid("receipt effect count exceeds SQLite i64".to_string())
        })?;
        let first_effect_id = group
            .effects
            .first()
            .ok_or_else(|| ClaimMirrorError::Invalid("receipt has no effects".to_string()))?
            .effect_id;
        let last_effect_id = group
            .effects
            .last()
            .ok_or_else(|| ClaimMirrorError::Invalid("receipt has no effects".to_string()))?
            .effect_id;
        // A per-effect rejection must roll the transaction back, because the loop below
        // interleaves validation with mutation: an earlier effect can already be applied
        // when a later one is refused. Returning a disposition would commit that partial
        // group, so the typed rejection is stashed here and the closure fails instead.
        let rejected: RefCell<Option<ClaimMirrorError>> = RefCell::new(None);
        let outcome = write.execute(&self.inner, |coordinated| {
            let tx = coordinated.tx();
            rejected.borrow_mut().take();
            let existing_ids = existing_claim_ids_tx(tx, incarnation)?;
            for effect in &group.effects {
                let prepared = &mut coordinated.prepared.borrow_mut();
                let recorded = if existing_ids.contains(&effect.public_claim_id) {
                    prepared.existing_identity("public_claim_id", &effect.public_claim_id)
                } else {
                    prepared.identity("public_claim_id", &effect.public_claim_id)
                };
                recorded
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            }
            let outcome =
                (|| -> rusqlite::Result<Result<ClaimMirrorApplyResult, ClaimMirrorError>> {
                    let state: Option<(String, String)> = tx
                        .query_row(
                            "SELECT database_incarnation_id, workspace_epoch
                       FROM mc_claim_mirror_state WHERE id = 1",
                            [],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()?;
                    let Some((stored_incarnation, workspace_epoch)) = state else {
                        return Ok(Err(ClaimMirrorError::NotSeeded));
                    };
                    if stored_incarnation != *incarnation {
                        return Ok(Err(ClaimMirrorError::IncarnationMismatch {
                            expected: stored_incarnation,
                            found: incarnation.clone(),
                        }));
                    }
                    if workspace_epoch != group.vector.workspace_epoch {
                        return Ok(Err(ClaimMirrorError::Invalid(
                            "receipt workspace epoch does not match mirror".to_string(),
                        )));
                    }
                    let control = claim_intent_control(tx)?;
                    if let Some((control_incarnation, state)) = control {
                        if control_incarnation != *incarnation {
                            return Ok(Err(ClaimMirrorError::IncarnationMismatch {
                                expected: control_incarnation,
                                found: incarnation.clone(),
                            }));
                        }
                        if state != "accepting" {
                            return Ok(Err(ClaimMirrorError::ResetRequired));
                        }
                    }

                    let replay: Option<String> = tx
                        .query_row(
                            "SELECT group_digest FROM mc_claim_mirror_receipts
                      WHERE database_incarnation_id = ?1 AND receipt_id = ?2",
                            params![incarnation, group.receipt_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    if let Some(stored_digest) = replay {
                        return if stored_digest == group_digest {
                            Ok(Ok(ClaimMirrorApplyResult {
                                replayed: true,
                                applied_effect_count: 0,
                            }))
                        } else {
                            Ok(Err(ClaimMirrorError::ReceiptConflict {
                                receipt_id: group.receipt_id,
                            }))
                        };
                    }

                    let stored_projects = read_project_states(tx, incarnation)?;

                    let vector_projects = group
                        .vector
                        .project_generations
                        .keys()
                        .map(|key| {
                            key.parse::<i64>()
                                .map_err(|_| rusqlite::Error::InvalidQuery)
                        })
                        .collect::<Result<BTreeSet<_>, _>>()?;
                    if vector_projects != stored_projects.keys().copied().collect() {
                        return Ok(Err(ClaimMirrorError::Invalid(
                            "receipt generation vector project set does not match mirror"
                                .to_string(),
                        )));
                    }
                    let touched = group
                        .effects
                        .iter()
                        .map(|effect| effect.project_id)
                        .collect::<BTreeSet<_>>();
                    for (project_id, stored) in &stored_projects {
                        let key = project_id.to_string();
                        let found = group.vector.project_generations[&key];
                        let found_policy = group.vector.policy_generations[&key];
                        let increment = i64::from(touched.contains(project_id));
                        let expected = stored
                            .project_generation
                            .checked_add(increment)
                            .ok_or(rusqlite::Error::InvalidQuery)?;
                        let expected_policy = stored
                            .policy_generation
                            .checked_add(increment)
                            .ok_or(rusqlite::Error::InvalidQuery)?;
                        if found != expected {
                            return Ok(Err(ClaimMirrorError::GenerationMismatch {
                                project_id: *project_id,
                                expected,
                                found,
                            }));
                        }
                        if found_policy != expected_policy {
                            return Ok(Err(ClaimMirrorError::GenerationMismatch {
                                project_id: *project_id,
                                expected: expected_policy,
                                found: found_policy,
                            }));
                        }
                    }

                    let mut checkpoints = stored_projects
                        .iter()
                        .map(|(project_id, state)| (*project_id, state.acked_effect_id))
                        .collect::<BTreeMap<_, _>>();
                    for effect in &group.effects {
                        let expected = checkpoints[&effect.project_id];
                        if effect.previous_project_effect_id != expected {
                            return Ok(Err(ClaimMirrorError::CheckpointMismatch {
                                project_id: effect.project_id,
                                expected,
                                found: effect.previous_project_effect_id,
                            }));
                        }
                        checkpoints.insert(effect.project_id, effect.effect_id);
                    }

                    for effect in &group.effects {
                        let existing: Option<(i64, String, i64)> = tx
                            .query_row(
                                "SELECT project_id, revision_locator, revision
                           FROM mc_claim_mirror_claims
                          WHERE database_incarnation_id = ?1 AND public_claim_id = ?2",
                                params![incarnation, effect.public_claim_id],
                                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                            )
                            .optional()?;
                        if let Some((project_id, locator, revision)) = existing.as_ref() {
                            if *project_id != effect.project_id {
                                {
                                    *rejected.borrow_mut() = Some(ClaimMirrorError::Invalid(format!(
                                        "public claim {} changed projects",
                                        effect.public_claim_id
                                    )));
                                    return Err(rusqlite::Error::InvalidQuery);
                                }
                            }
                            let incoming_revision =
                                parse_revision_locator(&effect.revision_locator)
                                    .ok_or(rusqlite::Error::InvalidQuery)?
                                    .revision;
                            if incoming_revision < *revision {
                                {
                                    *rejected.borrow_mut() = Some(ClaimMirrorError::Invalid(format!(
                                        "public claim {} revision regressed",
                                        effect.public_claim_id
                                    )));
                                    return Err(rusqlite::Error::InvalidQuery);
                                }
                            }
                            // A revision locator embeds the content digest, so the same
                            // revision arriving with a different locator means the same
                            // revision carries different content. Without this the upsert
                            // below would silently replace the stored content.
                            if incoming_revision == *revision && locator != &effect.revision_locator
                            {
                                {
                                    *rejected.borrow_mut() = Some(ClaimMirrorError::Invalid(format!(
                                        "public claim {} revision {} does not match the stored locator",
                                        effect.public_claim_id, incoming_revision
                                    )));
                                    return Err(rusqlite::Error::InvalidQuery);
                                }
                            }
                            if effect.claim.is_none() && locator != &effect.revision_locator {
                                {
                                    *rejected.borrow_mut() = Some(ClaimMirrorError::Invalid(format!(
                                        "revocation for {} does not match current revision",
                                        effect.public_claim_id
                                    )));
                                    return Err(rusqlite::Error::InvalidQuery);
                                }
                            }
                        }
                        if let Some(claim) = &effect.claim {
                            insert_claim(tx, incarnation, claim)?;
                        } else {
                            tx.execute(
                                "DELETE FROM mc_claim_mirror_claims
                          WHERE database_incarnation_id = ?1
                            AND public_claim_id = ?2
                            AND revision_locator = ?3",
                                params![
                                    incarnation,
                                    effect.public_claim_id,
                                    effect.revision_locator
                                ],
                            )?;
                        }
                    }

                    for project_id in &touched {
                        let key = project_id.to_string();
                        // Every retained row in a touched project takes the receipt's
                        // generations, not just the rows an effect names. The host stamps
                        // its full snapshot from the current vector, and row equality
                        // includes these fields, so leaving untouched rows on the previous
                        // generation makes the next full replacement compare unequal and
                        // return `ResetRequired`.
                        tx.execute(
                            "UPDATE mc_claim_mirror_claims
                        SET project_generation = ?1, policy_generation = ?2
                      WHERE database_incarnation_id = ?3 AND project_id = ?4",
                            params![
                                group.vector.project_generations[&key],
                                group.vector.policy_generations[&key],
                                incarnation,
                                project_id,
                            ],
                        )?;
                        tx.execute(
                            "UPDATE mc_claim_mirror_projects
                        SET project_generation = ?1, policy_generation = ?2,
                            acked_effect_id = ?3
                      WHERE database_incarnation_id = ?4 AND project_id = ?5",
                            params![
                                group.vector.project_generations[&key],
                                group.vector.policy_generations[&key],
                                checkpoints[project_id],
                                incarnation,
                                project_id,
                            ],
                        )?;
                    }
                    tx.execute(
                        "INSERT INTO mc_claim_mirror_receipts(
                    database_incarnation_id, receipt_id, expected_effect_count,
                    first_effect_id, last_effect_id, group_digest,
                    generation_vector_json, applied_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            incarnation,
                            group.receipt_id,
                            effect_count,
                            first_effect_id,
                            last_effect_id,
                            group_digest,
                            generation_vector_json,
                            now_ms,
                        ],
                    )?;
                    tx.execute(
                        "UPDATE mc_claim_mirror_state SET updated_at_ms = ?1 WHERE id = 1",
                        [now_ms],
                    )?;
                    Ok(Ok(ClaimMirrorApplyResult {
                        replayed: false,
                        applied_effect_count: group.effects.len(),
                    }))
                })()?;
            Ok(match &outcome {
                Ok(result) if !result.replayed => WriteDisposition::Applied(outcome),
                _ => WriteDisposition::Replay(outcome),
            })
        });
        match outcome {
            Ok(outcome) => outcome,
            // A stashed rejection means the closure failed on purpose so the fence would
            // roll back; report the reason it refused, not the rollback itself.
            Err(error) => match rejected.borrow_mut().take() {
                Some(rejection) => Err(rejection),
                None => Err(ClaimMirrorError::from(error)),
            },
        }
    }

    /// Delete only rebuildable mirror state. The staged-intent ledger remains
    /// untouched and must already be frozen in `resetting` with no unresolved row.
    pub fn delete_claim_mirror(&self) -> Result<(), ClaimMirrorError> {
        self.inner.with_conn_fenced(|tx| {
            let unresolved = unresolved_claim_intents(tx)?;
            if unresolved > 0 {
                return Ok(Err(ClaimMirrorError::ResetBlocked {
                    unresolved: unresolved as usize,
                }));
            }
            let resetting = tx
                .query_row(
                    "SELECT transition_state = 'resetting'
                       FROM mc_claim_intent_controls WHERE id = 1",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .optional()?
                .unwrap_or(false);
            if !resetting {
                return Ok(Err(ClaimMirrorError::ResetRequired));
            }
            if let Some(database_incarnation_id) = tx
                .query_row(
                    "SELECT database_incarnation_id FROM mc_claim_mirror_state WHERE id = 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            {
                retire_active_scan_owner_kind(
                    tx,
                    "database",
                    &database_incarnation_id,
                    "claim_mirror",
                )?;
            }
            clear_claim_mirror(tx)?;
            Ok(Ok(()))
        })?
    }
}
