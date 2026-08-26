//! Store-backed ctx_memory tool primitives.
//!
//! This module is intentionally route/identity agnostic: callers pass the already-resolved
//! project (and, for the session-aware search helper, session) that the daemon bound. Shared
//! visibility is read-only for primary agents; facade mutations require project ownership,
//! which the store rechecks inside the mutation transaction.

use std::collections::BTreeSet;

use mc_store::{
    claim_mirror::{ClaimMirrorError, CommittedClaimMirrorRow},
    ClaimIntentRecord, McStore, McStoreError, StoredCompartmentSearchRow, StoredNoteSearchRow,
};

pub use mc_core::claim_operation::{
    ClaimCommandIdentity, ClaimIntentAckKind, ClaimIntentAckRequest, ClaimIntentAckResponse,
    ClaimIntentBinding, ClaimIntentInspectRequest, ClaimIntentInspectResponse,
    ClaimIntentStageRequest, ClaimIntentStageResponse, ClaimIntentState, ClaimIntentWireRecord,
    CLAIM_INTENT_PROTOCOL_VERSION, CLAIM_REQUEST_ENCODING_VERSION,
};

#[derive(Debug)]
pub enum MemoryToolError {
    Store(McStoreError),
    ClaimMirror(ClaimMirrorError),
    IntentProtocol(String),
}

impl std::fmt::Display for MemoryToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MemoryToolError::Store(e) => write!(f, "store: {e}"),
            MemoryToolError::ClaimMirror(e) => write!(f, "claim mirror: {e}"),
            MemoryToolError::IntentProtocol(reason) => {
                write!(f, "claim intent protocol: {reason}")
            }
        }
    }
}

impl std::error::Error for MemoryToolError {}
impl From<McStoreError> for MemoryToolError {
    fn from(e: McStoreError) -> Self {
        MemoryToolError::Store(e)
    }
}
impl From<ClaimMirrorError> for MemoryToolError {
    fn from(e: ClaimMirrorError) -> Self {
        MemoryToolError::ClaimMirror(e)
    }
}

pub fn list_committed_claims(
    store: &McStore,
    public_claim_ids: &BTreeSet<String>,
    limit: usize,
) -> Result<Vec<CommittedClaimMirrorRow>, MemoryToolError> {
    let Some(state) = store.claim_mirror_state()? else {
        return Ok(Vec::new());
    };
    Ok(store
        .list_claim_mirror(&state.database_incarnation_id, None)?
        .into_iter()
        .filter(|row| {
            public_claim_ids.is_empty() || public_claim_ids.contains(&row.public_claim_id)
        })
        .take(limit)
        .collect())
}

fn require_intent_protocol(version: u32) -> Result<(), MemoryToolError> {
    if version == CLAIM_INTENT_PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(MemoryToolError::IntentProtocol(format!(
            "unsupported protocol version {version}"
        )))
    }
}

fn intent_wire_record(record: ClaimIntentRecord) -> ClaimIntentWireRecord {
    ClaimIntentWireRecord {
        binding: record.binding,
        command: record.command,
        request_digest: record.request_digest,
        state: record.state,
        result_json: record.result_json,
    }
}

pub fn stage_claim_intent(
    store: &McStore,
    request: &ClaimIntentStageRequest,
    now_ms: i64,
) -> Result<ClaimIntentStageResponse, MemoryToolError> {
    require_intent_protocol(request.protocol_version)?;
    if request.request_encoding_version != CLAIM_REQUEST_ENCODING_VERSION {
        return Err(MemoryToolError::IntentProtocol(format!(
            "unsupported request encoding version {}",
            request.request_encoding_version
        )));
    }
    let outcome =
        store.stage_claim_intent(&request.binding, &request.command, &request.request, now_ms)?;
    Ok(ClaimIntentStageResponse {
        protocol_version: CLAIM_INTENT_PROTOCOL_VERSION,
        replayed: outcome.replayed,
        intent: intent_wire_record(outcome.record),
    })
}

pub fn inspect_claim_intents(
    store: &McStore,
    request: &ClaimIntentInspectRequest,
) -> Result<ClaimIntentInspectResponse, MemoryToolError> {
    require_intent_protocol(request.protocol_version)?;
    if request.limit == 0 || request.limit > 10_000 {
        return Err(MemoryToolError::IntentProtocol(
            "inspect limit must be in 1..=10000".to_string(),
        ));
    }
    let records = if let Some(command) = &request.command {
        store
            .inspect_claim_intent(command)?
            .filter(|record| !request.unresolved_only || record.state.is_unresolved())
            .into_iter()
            .collect()
    } else {
        store.list_claim_intents(request.unresolved_only, request.limit as usize)?
    };
    Ok(ClaimIntentInspectResponse {
        protocol_version: CLAIM_INTENT_PROTOCOL_VERSION,
        intents: records.into_iter().map(intent_wire_record).collect(),
    })
}

pub fn acknowledge_claim_intent(
    store: &McStore,
    request: &ClaimIntentAckRequest,
    now_ms: i64,
) -> Result<ClaimIntentAckResponse, MemoryToolError> {
    require_intent_protocol(request.protocol_version)?;
    let outcome = store.acknowledge_claim_intent(
        &request.binding,
        &request.command,
        &request.request_digest,
        request.kind,
        request.result_json.as_deref(),
        now_ms,
    )?;
    Ok(ClaimIntentAckResponse {
        protocol_version: CLAIM_INTENT_PROTOCOL_VERSION,
        replayed: outcome.replayed,
        intent: intent_wire_record(outcome.record),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemorySearchSourceKind {
    CompartmentTitle,
    CompartmentBody,
    Note,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemorySearchResult {
    pub source_kind: MemorySearchSourceKind,
    /// Use the record's primary identifier: memory row id for memory results,
    /// compartment sequence for compartment results, and note id for note results.
    pub id: i64,
    pub snippet: String,
    pub category: Option<String>,
    pub sequence: Option<i64>,
    pub title: Option<String>,
    pub note_status: Option<String>,
    pub surface_condition: Option<String>,
}

#[derive(Debug)]
struct RankedSearchResult {
    result: MemorySearchResult,
    rank: u8,
    recency: i64,
}

/// Keyword search over the resolved session's compartments and project notes.
pub fn search_compartments_and_notes_for_session(
    store: &McStore,
    project_path: &str,
    session_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<MemorySearchResult>, MemoryToolError> {
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let mut ranked = Vec::new();
    for compartment in store.search_compartments_like(session_id, query)? {
        if let Some(hit) = compartment_search_hit(compartment, query) {
            ranked.push(hit);
        }
    }
    for note in store.search_notes_like(project_path, session_id, query)? {
        if first_match(&note.content, query).is_some()
            || note
                .surface_condition
                .as_deref()
                .is_some_and(|condition| first_match(condition, query).is_some())
        {
            ranked.push(note_search_hit(note, query));
        }
    }

    ranked.sort_by(|left, right| {
        left.rank
            .cmp(&right.rank)
            .then_with(|| right.recency.cmp(&left.recency))
            .then_with(|| left.result.id.cmp(&right.result.id))
    });
    ranked.truncate(limit);
    Ok(ranked.into_iter().map(|r| r.result).collect())
}

fn note_search_hit(note: StoredNoteSearchRow, query: &str) -> RankedSearchResult {
    let matched_text = if first_match(&note.content, query).is_some() {
        note.content.as_str()
    } else {
        note.surface_condition
            .as_deref()
            .unwrap_or(note.content.as_str())
    };
    RankedSearchResult {
        rank: 1,
        recency: note.updated_at_ms,
        result: MemorySearchResult {
            source_kind: MemorySearchSourceKind::Note,
            id: note.id,
            snippet: snippet_around_match(matched_text, query),
            category: None,
            sequence: None,
            title: None,
            note_status: Some(note.status),
            surface_condition: note.surface_condition,
        },
    }
}

fn compartment_search_hit(
    compartment: StoredCompartmentSearchRow,
    query: &str,
) -> Option<RankedSearchResult> {
    if first_match(&compartment.title, query).is_some() {
        return Some(RankedSearchResult {
            rank: 1,
            recency: compartment.sequence,
            result: MemorySearchResult {
                source_kind: MemorySearchSourceKind::CompartmentTitle,
                id: compartment.sequence,
                snippet: snippet_around_match(&compartment.title, query),
                category: None,
                sequence: Some(compartment.sequence),
                title: Some(compartment.title),
                note_status: None,
                surface_condition: None,
            },
        });
    }

    let body = compartment_body_text(&compartment);
    first_match(&body, query).map(|_| RankedSearchResult {
        rank: 2,
        recency: compartment.sequence,
        result: MemorySearchResult {
            source_kind: MemorySearchSourceKind::CompartmentBody,
            id: compartment.sequence,
            snippet: snippet_around_match(&body, query),
            category: None,
            sequence: Some(compartment.sequence),
            title: Some(compartment.title),
            note_status: None,
            surface_condition: None,
        },
    })
}

fn compartment_body_text(compartment: &StoredCompartmentSearchRow) -> String {
    let mut parts = Vec::new();
    push_unique_text(&mut parts, &compartment.content);
    for tier in [
        &compartment.p1,
        &compartment.p2,
        &compartment.p3,
        &compartment.p4,
    ] {
        if let Some(text) = tier.as_deref() {
            push_unique_text(&mut parts, text);
        }
    }
    parts.join("\n")
}

fn push_unique_text(parts: &mut Vec<String>, text: &str) {
    if !text.is_empty() && !parts.iter().any(|part| part == text) {
        parts.push(text.to_string());
    }
}

fn first_match(text: &str, query: &str) -> Option<usize> {
    text.to_lowercase().find(&query.to_lowercase())
}

fn snippet_around_match(text: &str, query: &str) -> String {
    const CONTEXT: usize = 100;
    const MAX_CHARS: usize = 200;

    let Some(hit) = first_match(text, query) else {
        return text.chars().take(MAX_CHARS).collect();
    };
    let query_len = query.len();
    let mut start = hit.saturating_sub(CONTEXT);
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (hit + query_len + CONTEXT).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }

    let snippet: String = text[start..end].chars().take(MAX_CHARS).collect();
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < text.len() { "…" } else { "" };
    format!("{prefix}{}{suffix}", snippet.trim())
}
