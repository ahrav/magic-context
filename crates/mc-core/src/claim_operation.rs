//! Claim-operation encoding contract: the Rust twin of
//! `packages/plugin/src/features/magic-context/memory/claim-operation-contract.ts`.
//! Both runtimes are proven against the golden corpus
//! `memory/fixtures/claim-operation-contract-v1.json`.
//!
//! Canonical encoding rules (pinned by the encoding versions below):
//! - values: null, booleans, safe integers (|n| <= 2^53 - 1), strings,
//!   arrays, and objects. Floats with a fractional part, non-finite numbers,
//!   and out-of-range integers are rejected. A float with zero fraction in
//!   the safe range encodes as its integer value (matching JavaScript, where
//!   `JSON.parse` cannot distinguish `1e3` from `1000`).
//! - objects: keys sorted by Unicode code point (Rust `str` ordering).
//! - strings: `"`, `\`, and U+0000-U+001F escaped as `\u00xx` lowercase; no
//!   short escapes; every other code point emitted literally.
//! - no insignificant whitespace.
//!
//! Digests are SHA-256 hex over `<protocol>\n<canonical JSON>` UTF-8 bytes.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

pub const CLAIM_REQUEST_ENCODING_VERSION: u32 = 1;
pub const CLAIM_RESULT_ENCODING_VERSION: u32 = 1;
/// Version of the Rust-host staged-intent protocol. This is independent from
/// request/result encoding versions so transport evolution cannot silently
/// reinterpret persisted command bytes.
pub const CLAIM_INTENT_PROTOCOL_VERSION: u32 = 1;

pub const CLAIM_REQUEST_DIGEST_PROTOCOL: &str = "mc-claim-request-v1";
pub const CLAIM_MUTATION_TOKEN_DIGEST_PROTOCOL: &str = "mc-claim-mutation-token-v1";
pub const SNAPSHOT_VECTOR_DIGEST_PROTOCOL: &str = "mc-claim-snapshot-vector-v1";
pub const APPLICABILITY_HEADS_DIGEST_PROTOCOL: &str = "mc-claim-applicability-heads-v1";
pub const POLICY_HEADS_DIGEST_PROTOCOL: &str = "mc-claim-policy-heads-v1";

pub const PUBLIC_CLAIM_ID_PREFIX: &str = "mcm_";

/// Largest integer both runtimes represent exactly: 2^53 - 1.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractError {
    /// A value outside the canonical vocabulary (float with fraction,
    /// out-of-range integer, or non-finite number).
    NotCanonical(String),
    /// A stored result envelope that fails strict decoding.
    MalformedResult(String),
}

impl std::fmt::Display for ContractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ContractError::NotCanonical(reason) => write!(f, "not canonical: {reason}"),
            ContractError::MalformedResult(reason) => write!(f, "malformed result: {reason}"),
        }
    }
}

impl std::error::Error for ContractError {}

/// Extract the exact integer value of a JSON number when it lies within the
/// cross-runtime safe range; `None` otherwise.
fn number_as_safe_integer(number: &Number) -> Option<i64> {
    if let Some(value) = number.as_i64() {
        return (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER)
            .contains(&value)
            .then_some(value);
    }
    if let Some(value) = number.as_u64() {
        let max = u64::try_from(MAX_SAFE_INTEGER).expect("constant fits in u64");
        if value <= max {
            return i64::try_from(value).ok();
        }
        return None;
    }
    let value = number.as_f64()?;
    if !value.is_finite() || value.fract() != 0.0 || value.abs() > MAX_SAFE_INTEGER as f64 {
        return None;
    }
    Some(value as i64)
}

fn encode_canonical_string(out: &mut String, value: &str) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn encode_canonical_value(out: &mut String, value: &Value) -> Result<(), ContractError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            let integer = number_as_safe_integer(number).ok_or_else(|| {
                ContractError::NotCanonical(format!("number {number} is not a safe integer"))
            })?;
            let _ = write!(out, "{integer}");
        }
        Value::String(text) => encode_canonical_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                encode_canonical_value(out, item)?;
            }
            out.push(']');
        }
        Value::Object(entries) => {
            let sorted: BTreeMap<&String, &Value> = entries.iter().collect();
            out.push('{');
            for (index, (key, item)) in sorted.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                encode_canonical_string(out, key);
                out.push(':');
                encode_canonical_value(out, item)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// Canonicalize a JSON value into the pinned byte form.
pub fn canonical_json_encode(value: &Value) -> Result<String, ContractError> {
    let mut out = String::new();
    encode_canonical_value(&mut out, value)?;
    Ok(out)
}

pub fn sha256_hex_utf8(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn protocol_digest(protocol: &str, value: &Value) -> Result<String, ContractError> {
    let canonical = canonical_json_encode(value)?;
    Ok(sha256_hex_utf8(&format!("{protocol}\n{canonical}")))
}

/// Canonical request digest for the operation identity.
pub fn compute_claim_operation_request_digest(request: &Value) -> Result<String, ContractError> {
    protocol_digest(CLAIM_REQUEST_DIGEST_PROTOCOL, request)
}

fn is_lower_hex(text: &str, expected_len: usize) -> bool {
    text.len() == expected_len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Validate the opaque public claim identity: `mcm_` + 32 lowercase hex.
pub fn is_valid_public_claim_id(candidate: &str) -> bool {
    candidate
        .strip_prefix(PUBLIC_CLAIM_ID_PREFIX)
        .is_some_and(|rest| is_lower_hex(rest, 32))
}

/// Canonical revision identity: public claim ID + revision number + exact
/// content digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevisionLocator {
    pub public_claim_id: String,
    pub revision: i64,
    pub content_digest: String,
}

/// Render `<publicId>/r<revision>/<sha256>`; `None` when a field is invalid.
pub fn format_revision_locator(locator: &RevisionLocator) -> Option<String> {
    if !is_valid_public_claim_id(&locator.public_claim_id)
        || !(1..=MAX_SAFE_INTEGER).contains(&locator.revision)
        || !is_lower_hex(&locator.content_digest, 64)
    {
        return None;
    }
    Some(format!(
        "{}/r{}/{}",
        locator.public_claim_id, locator.revision, locator.content_digest
    ))
}

/// Parse and validate a revision locator string; `None` when malformed.
pub fn parse_revision_locator(raw: &str) -> Option<RevisionLocator> {
    let mut parts = raw.split('/');
    let public_claim_id = parts.next()?;
    let revision_part = parts.next()?;
    let content_digest = parts.next()?;
    if parts.next().is_some() || !is_valid_public_claim_id(public_claim_id) {
        return None;
    }
    let digits = revision_part.strip_prefix('r')?;
    if digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let revision: i64 = digits.parse().ok()?;
    if !(1..=MAX_SAFE_INTEGER).contains(&revision) || !is_lower_hex(content_digest, 64) {
        return None;
    }
    Some(RevisionLocator {
        public_claim_id: public_claim_id.to_string(),
        revision,
        content_digest: content_digest.to_string(),
    })
}

/// Claim-local fencing state: revision identity plus the lifecycle,
/// applicability, and policy heads of the current revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimMutationToken {
    pub token_version: u32,
    pub public_claim_id: String,
    pub revision: i64,
    pub content_digest: String,
    pub lifecycle_seq: i64,
    pub applicability_heads_digest: String,
    pub policy_heads_digest: String,
}

fn token_value(token: &ClaimMutationToken) -> Value {
    serde_json::json!({
        "applicabilityHeadsDigest": token.applicability_heads_digest,
        "contentDigest": token.content_digest,
        "lifecycleSeq": token.lifecycle_seq,
        "policyHeadsDigest": token.policy_heads_digest,
        "publicClaimId": token.public_claim_id,
        "revision": token.revision,
        "tokenVersion": token.token_version,
    })
}

pub fn canonical_claim_mutation_token(token: &ClaimMutationToken) -> Result<String, ContractError> {
    canonical_json_encode(&token_value(token))
}

pub fn compute_claim_mutation_token_digest(
    token: &ClaimMutationToken,
) -> Result<String, ContractError> {
    protocol_digest(CLAIM_MUTATION_TOKEN_DIGEST_PROTOCOL, &token_value(token))
}

/// Digest over applicability stream heads: `{seq, streamKey}` pairs sorted
/// by stream key.
pub fn compute_applicability_heads_digest(
    heads: &[(String, i64)],
) -> Result<String, ContractError> {
    let mut sorted: Vec<&(String, i64)> = heads.iter().collect();
    sorted.sort_by(|left, right| left.0.cmp(&right.0));
    let items: Vec<Value> = sorted
        .iter()
        .map(|(stream_key, seq)| serde_json::json!({ "seq": seq, "streamKey": stream_key }))
        .collect();
    protocol_digest(APPLICABILITY_HEADS_DIGEST_PROTOCOL, &Value::Array(items))
}

/// Append-only policy ledger counts for the current revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyHeadCounts {
    pub maturity_seq: i64,
    pub approval_count: i64,
    pub disposition_count: i64,
    pub artifact_count: i64,
    pub artifact_event_count: i64,
    pub verification_count: i64,
}

pub fn compute_policy_heads_digest(counts: &PolicyHeadCounts) -> Result<String, ContractError> {
    protocol_digest(
        POLICY_HEADS_DIGEST_PROTOCOL,
        &serde_json::json!({
            "approvalCount": counts.approval_count,
            "artifactCount": counts.artifact_count,
            "artifactEventCount": counts.artifact_event_count,
            "dispositionCount": counts.disposition_count,
            "maturitySeq": counts.maturity_seq,
            "verificationCount": counts.verification_count,
        }),
    )
}

/// Publication-freshness state, separate from mutation fencing: database
/// incarnation, workspace epoch, and per-project claim/policy generations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotVector {
    pub vector_version: u32,
    pub database_incarnation_id: String,
    pub workspace_epoch: String,
    pub project_generations: BTreeMap<String, i64>,
    pub policy_generations: BTreeMap<String, i64>,
}

fn snapshot_vector_value(vector: &SnapshotVector) -> Value {
    let generations = |map: &BTreeMap<String, i64>| {
        Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), Value::from(*value)))
                .collect::<Map<String, Value>>(),
        )
    };
    serde_json::json!({
        "databaseIncarnationId": vector.database_incarnation_id,
        "policyGenerations": generations(&vector.policy_generations),
        "projectGenerations": generations(&vector.project_generations),
        "vectorVersion": vector.vector_version,
        "workspaceEpoch": vector.workspace_epoch,
    })
}

pub fn canonical_snapshot_vector(vector: &SnapshotVector) -> Result<String, ContractError> {
    canonical_json_encode(&snapshot_vector_value(vector))
}

pub fn compute_snapshot_vector_digest(vector: &SnapshotVector) -> Result<String, ContractError> {
    protocol_digest(
        SNAPSHOT_VECTOR_DIGEST_PROTOCOL,
        &snapshot_vector_value(vector),
    )
}

/// Stable identity of one semantic claim command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimCommandIdentity {
    pub producer: String,
    pub operation_key: String,
}

/// Context database and authority fence captured when a command is staged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimIntentBinding {
    pub database_incarnation_id: String,
    pub format_epoch: i64,
    pub authority_project: String,
    pub authority_generation: u64,
}

/// Durable staged-intent lifecycle. `acknowledged` is transport settlement,
/// not a second semantic claim state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaimIntentState {
    Staged,
    ContextCommitted,
    Acknowledged,
    TerminalRejected,
}

impl ClaimIntentState {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "staged" => Some(Self::Staged),
            "context-committed" => Some(Self::ContextCommitted),
            "acknowledged" => Some(Self::Acknowledged),
            "terminal-rejected" => Some(Self::TerminalRejected),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::ContextCommitted => "context-committed",
            Self::Acknowledged => "acknowledged",
            Self::TerminalRejected => "terminal-rejected",
        }
    }

    pub fn is_unresolved(self) -> bool {
        matches!(self, Self::Staged | Self::ContextCommitted)
    }
}

/// Versioned request used to durably stage a command before context mutation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimIntentStageRequest {
    pub protocol_version: u32,
    pub request_encoding_version: u32,
    pub binding: ClaimIntentBinding,
    pub command: ClaimCommandIdentity,
    pub request: Value,
}

/// Versioned intent inspection. Omitting `command` lists rows in creation order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimIntentInspectRequest {
    pub protocol_version: u32,
    pub command: Option<ClaimCommandIdentity>,
    pub unresolved_only: bool,
    pub limit: u32,
}

/// One legal acknowledgement transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaimIntentAckKind {
    ContextCommitted,
    Acknowledged,
    TerminalRejected,
}

/// Versioned acknowledgement. Result bytes are supplied only when recording
/// `context-committed` or `terminal-rejected`; they must already use canonical
/// claim-result encoding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimIntentAckRequest {
    pub protocol_version: u32,
    pub binding: ClaimIntentBinding,
    pub command: ClaimCommandIdentity,
    pub request_digest: String,
    pub kind: ClaimIntentAckKind,
    pub result_json: Option<String>,
}

/// Shared response row for stage, inspect, and acknowledgement APIs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimIntentWireRecord {
    pub binding: ClaimIntentBinding,
    pub command: ClaimCommandIdentity,
    pub request_digest: String,
    pub state: ClaimIntentState,
    pub result_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimIntentStageResponse {
    pub protocol_version: u32,
    pub replayed: bool,
    pub intent: ClaimIntentWireRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimIntentInspectResponse {
    pub protocol_version: u32,
    pub intents: Vec<ClaimIntentWireRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimIntentAckResponse {
    pub protocol_version: u32,
    pub replayed: bool,
    pub intent: ClaimIntentWireRecord,
}

/// Stored result outcomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimResultOutcome {
    Applied,
    Stale,
    Noop,
}

impl ClaimResultOutcome {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "applied" => Some(Self::Applied),
            "stale" => Some(Self::Stale),
            "noop" => Some(Self::Noop),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Stale => "stale",
            Self::Noop => "noop",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimOperationResultEffect {
    pub effect_key: String,
    pub change_kind: String,
    pub project_id: i64,
    pub generation: i64,
    pub revision_locator: Option<String>,
}

/// The durable, replay-returned result envelope.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimOperationResult {
    pub result_encoding_version: u32,
    pub outcome: ClaimResultOutcome,
    pub stale_reason: Option<String>,
    pub payload: Value,
    pub effects: Vec<ClaimOperationResultEffect>,
    pub generations: BTreeMap<String, i64>,
}

fn require_safe_integer(value: &Value, field: &str) -> Result<i64, ContractError> {
    value
        .as_number()
        .and_then(number_as_safe_integer)
        .ok_or_else(|| ContractError::MalformedResult(format!("{field} must be a safe integer")))
}

fn decode_effect(entry: &Value, index: usize) -> Result<ClaimOperationResultEffect, ContractError> {
    let entry = entry.as_object().ok_or_else(|| {
        ContractError::MalformedResult(format!("result effect {index} must be an object"))
    })?;
    const ALLOWED_FIELDS: &[&str] = &[
        "effectKey",
        "changeKind",
        "projectId",
        "generation",
        "revisionLocator",
    ];
    if let Some(field) = entry
        .keys()
        .find(|field| !ALLOWED_FIELDS.contains(&field.as_str()))
    {
        return Err(ContractError::MalformedResult(format!(
            "result effect {index} contains unknown field {field}"
        )));
    }
    let string_field = |field: &str| -> Result<String, ContractError> {
        entry
            .get(field)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                ContractError::MalformedResult(format!("result effect {index} {field} malformed"))
            })
    };
    let revision_locator = match entry.get("revisionLocator") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => {
            if parse_revision_locator(raw).is_none() {
                return Err(ContractError::MalformedResult(format!(
                    "result effect {index} carries an invalid revision locator"
                )));
            }
            Some(raw.clone())
        }
        Some(_) => {
            return Err(ContractError::MalformedResult(format!(
                "result effect {index} revisionLocator malformed"
            )))
        }
    };
    Ok(ClaimOperationResultEffect {
        effect_key: string_field("effectKey")?,
        change_kind: string_field("changeKind")?,
        project_id: require_safe_integer(
            entry.get("projectId").unwrap_or(&Value::Null),
            "effect projectId",
        )?,
        generation: require_safe_integer(
            entry.get("generation").unwrap_or(&Value::Null),
            "effect generation",
        )?,
        revision_locator,
    })
}

/// Strict decoder for a stored result envelope. Fails closed on an unknown
/// encoding version, outcome, or malformed effect rows.
pub fn decode_claim_operation_result(
    result_json: &str,
) -> Result<ClaimOperationResult, ContractError> {
    let parsed: Value = serde_json::from_str(result_json).map_err(|error| {
        ContractError::MalformedResult(format!("stored result is not JSON: {error}"))
    })?;
    let record = parsed
        .as_object()
        .ok_or_else(|| ContractError::MalformedResult("stored result must be an object".into()))?;
    const ALLOWED_FIELDS: &[&str] = &[
        "resultEncodingVersion",
        "outcome",
        "staleReason",
        "payload",
        "effects",
        "generations",
    ];
    if let Some(field) = record
        .keys()
        .find(|field| !ALLOWED_FIELDS.contains(&field.as_str()))
    {
        return Err(ContractError::MalformedResult(format!(
            "stored result contains unknown field {field}"
        )));
    }
    let version = record
        .get("resultEncodingVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ContractError::MalformedResult("resultEncodingVersion must be an integer".into())
        })?;
    if version != u64::from(CLAIM_RESULT_ENCODING_VERSION) {
        return Err(ContractError::MalformedResult(format!(
            "unsupported result encoding version: {version}"
        )));
    }
    let outcome = record
        .get("outcome")
        .and_then(Value::as_str)
        .and_then(ClaimResultOutcome::parse)
        .ok_or_else(|| ContractError::MalformedResult("unsupported result outcome".into()))?;
    let stale_reason = match record.get("staleReason") {
        None | Some(Value::Null) => None,
        Some(Value::String(reason)) => Some(reason.clone()),
        Some(_) => {
            return Err(ContractError::MalformedResult(
                "staleReason must be a string or null".into(),
            ))
        }
    };
    let effects = record
        .get("effects")
        .and_then(Value::as_array)
        .ok_or_else(|| ContractError::MalformedResult("result effects must be an array".into()))?
        .iter()
        .enumerate()
        .map(|(index, entry)| decode_effect(entry, index))
        .collect::<Result<Vec<_>, _>>()?;
    let generations = record
        .get("generations")
        .and_then(Value::as_object)
        .ok_or_else(|| ContractError::MalformedResult("result generations must be a map".into()))?
        .iter()
        .map(|(key, value)| Ok((key.clone(), require_safe_integer(value, "generation")?)))
        .collect::<Result<BTreeMap<String, i64>, ContractError>>()?;
    Ok(ClaimOperationResult {
        result_encoding_version: CLAIM_RESULT_ENCODING_VERSION,
        outcome,
        stale_reason,
        payload: record.get("payload").cloned().unwrap_or(Value::Null),
        effects,
        generations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!(
        "../../../packages/plugin/src/features/magic-context/memory/fixtures/claim-operation-contract-v1.json"
    );

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("golden corpus parses")
    }

    #[test]
    fn vocabulary_matches_fixture() {
        let fixture = fixture();
        assert_eq!(
            u64::from(CLAIM_REQUEST_ENCODING_VERSION),
            fixture["requestEncodingVersion"].as_u64().unwrap()
        );
        assert_eq!(
            u64::from(CLAIM_RESULT_ENCODING_VERSION),
            fixture["resultEncodingVersion"].as_u64().unwrap()
        );
        let protocols = &fixture["digestProtocols"];
        assert_eq!(
            CLAIM_REQUEST_DIGEST_PROTOCOL,
            protocols["request"].as_str().unwrap()
        );
        assert_eq!(
            CLAIM_MUTATION_TOKEN_DIGEST_PROTOCOL,
            protocols["mutationToken"].as_str().unwrap()
        );
        assert_eq!(
            SNAPSHOT_VECTOR_DIGEST_PROTOCOL,
            protocols["snapshotVector"].as_str().unwrap()
        );
        assert_eq!(
            APPLICABILITY_HEADS_DIGEST_PROTOCOL,
            protocols["applicabilityHeads"].as_str().unwrap()
        );
        assert_eq!(
            POLICY_HEADS_DIGEST_PROTOCOL,
            protocols["policyHeads"].as_str().unwrap()
        );
    }

    #[test]
    fn canonical_bytes_and_request_digests_match_fixture() {
        for case in fixture()["canonicalization"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let canonical = canonical_json_encode(&case["value"])
                .unwrap_or_else(|error| panic!("case {name}: {error}"));
            assert_eq!(
                canonical,
                case["canonical"].as_str().unwrap(),
                "case {name}"
            );
            assert_eq!(
                compute_claim_operation_request_digest(&case["value"]).unwrap(),
                case["requestDigest"].as_str().unwrap(),
                "case {name}"
            );
        }
    }

    #[test]
    fn non_canonical_numbers_are_rejected() {
        for case in fixture()["invalidCanonical"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let value: Value = serde_json::from_str(case["valueJson"].as_str().unwrap()).unwrap();
            assert!(
                canonical_json_encode(&value).is_err(),
                "case {name} must be rejected"
            );
        }
    }

    #[test]
    fn public_claim_id_validation_matches_fixture() {
        let fixture = fixture();
        for id in fixture["publicClaimIds"]["valid"].as_array().unwrap() {
            assert!(is_valid_public_claim_id(id.as_str().unwrap()));
        }
        for id in fixture["publicClaimIds"]["invalid"].as_array().unwrap() {
            assert!(!is_valid_public_claim_id(id.as_str().unwrap()));
        }
    }

    #[test]
    fn revision_locators_match_fixture() {
        let fixture = fixture();
        for case in fixture["revisionLocators"]["valid"].as_array().unwrap() {
            let parsed = parse_revision_locator(case["locator"].as_str().unwrap())
                .expect("valid locator parses");
            assert_eq!(
                parsed.public_claim_id,
                case["publicClaimId"].as_str().unwrap()
            );
            assert_eq!(parsed.revision, case["revision"].as_i64().unwrap());
            assert_eq!(
                parsed.content_digest,
                case["contentDigest"].as_str().unwrap()
            );
            assert_eq!(
                format_revision_locator(&parsed).unwrap(),
                case["locator"].as_str().unwrap()
            );
        }
        for raw in fixture["revisionLocators"]["invalid"].as_array().unwrap() {
            assert!(
                parse_revision_locator(raw.as_str().unwrap()).is_none(),
                "locator {raw} must be rejected"
            );
        }
    }

    #[test]
    fn mutation_tokens_match_fixture() {
        for case in fixture()["mutationTokens"].as_array().unwrap() {
            let token: ClaimMutationToken = serde_json::from_value(case["token"].clone()).unwrap();
            assert_eq!(
                canonical_claim_mutation_token(&token).unwrap(),
                case["canonical"].as_str().unwrap()
            );
            assert_eq!(
                compute_claim_mutation_token_digest(&token).unwrap(),
                case["digest"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn applicability_and_policy_head_digests_match_fixture() {
        let fixture = fixture();
        for case in fixture["applicabilityHeads"].as_array().unwrap() {
            let heads: Vec<(String, i64)> = case["heads"]
                .as_array()
                .unwrap()
                .iter()
                .map(|head| {
                    (
                        head["streamKey"].as_str().unwrap().to_string(),
                        head["seq"].as_i64().unwrap(),
                    )
                })
                .collect();
            assert_eq!(
                compute_applicability_heads_digest(&heads).unwrap(),
                case["digest"].as_str().unwrap()
            );
        }
        for case in fixture["policyHeads"].as_array().unwrap() {
            let counts: PolicyHeadCounts = serde_json::from_value(case["counts"].clone()).unwrap();
            assert_eq!(
                compute_policy_heads_digest(&counts).unwrap(),
                case["digest"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn snapshot_vectors_match_fixture() {
        for case in fixture()["snapshotVectors"].as_array().unwrap() {
            let vector: SnapshotVector = serde_json::from_value(case["vector"].clone()).unwrap();
            assert_eq!(
                canonical_snapshot_vector(&vector).unwrap(),
                case["canonical"].as_str().unwrap()
            );
            assert_eq!(
                compute_snapshot_vector_digest(&vector).unwrap(),
                case["digest"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn stored_results_decode_and_reencode_byte_identically() {
        let fixture = fixture();
        for case in fixture["results"]["valid"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let result_json = case["resultJson"].as_str().unwrap();
            let decoded = decode_claim_operation_result(result_json)
                .unwrap_or_else(|error| panic!("case {name}: {error}"));
            assert_eq!(decoded.outcome.as_str(), case["outcome"].as_str().unwrap());
            assert_eq!(
                decoded.effects.len(),
                case["effectCount"].as_u64().unwrap() as usize,
                "case {name}"
            );
            // The stored bytes are already canonical: re-encoding the parsed
            // value must reproduce them exactly.
            let parsed: Value = serde_json::from_str(result_json).unwrap();
            assert_eq!(
                canonical_json_encode(&parsed).unwrap(),
                result_json,
                "case {name}"
            );
        }
        for case in fixture["results"]["invalid"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            assert!(
                decode_claim_operation_result(case["resultJson"].as_str().unwrap()).is_err(),
                "case {name} must fail decoding"
            );
        }
    }
}
