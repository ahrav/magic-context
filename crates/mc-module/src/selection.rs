//!
//! Each block maps 1:1 to [`SelItem`].
//! Selectors emit identical decisions for identical `(items, frozen_keys, ctx, cfg)`.
//!
//!
//! Cache invariants:
//! Selectors exclude `frozen_keys` because CK items remain live with their original bytes after reduction.
//!   selector MUST exclude already-frozen ids up front or it would re-target them.
//! Selectors touch only client-executed harness items.
//! Selectors leave provider-executed tools and Opaque blocks verbatim.
//!   verbatim.
//! Payloads depend only on an item's `id` and immutable block bytes.
//! Selectors never re-emit frozen targets with different bytes.
//! A tool reduction emits decisions for its `ToolCall` and durable assistant sibling.
//! Selectors never rewrite reasoning.
//! A tool arc without another durable assistant sibling is ineligible for reduction.
//! Each target receives exactly one decision; `drop` overrides `edit_marker`.
//! Selectors emit decisions in stable order.

use std::collections::{HashMap, HashSet};

use crate::transform::{utf16_len, utf16_prefix, ReductionDecision};

/// `todowrite`: keep the newest 1 (the live plan is the newest task-list state).
const TODOWRITE_KEEP: usize = 1;
/// Keep the newest 3 `ctx_reduce` arcs as housekeeping examples.
const CTX_REDUCE_KEEP: usize = 3;
/// Selectors may drop every occurrence of these zero-value meta tools.
const ZERO_VALUE_META_TOOLS: &[&str] = &["bash_status", "bash_kill"];
/// Selectors may drop `ctx_note` actions in `CTX_NOTE_ZERO_VALUE_ACTIONS` when positively read.
const CTX_NOTE_ZERO_VALUE_ACTIONS: &[&str] = &["read", "dismiss"];
/// `packages/plugin/src/hooks/magic-context/heuristic-cleanup.ts`.
const DEDUP_SAFE_TOOLS: &[&str] = &[
    "mcp_grep",
    "mcp_read",
    "mcp_glob",
    "mcp_ast_grep_search",
    "mcp_lsp_diagnostics",
    "mcp_lsp_symbols",
    "mcp_lsp_find_references",
    "mcp_lsp_goto_definition",
    "mcp_lsp_prepare_rename",
];
/// Selectors compress superseded older calls to these tools into an `edit_marker`.
const EDIT_TOOLS: &[&str] = &["edit", "write"];
/// Edit markers preserve values for `FILE_PATH_KEYS` verbatim.
const FILE_PATH_KEYS: &[&str] = &["filePath", "file_path", "path"];
/// Edit markers clamp values for `DIFF_KEYS` to a region hint.
const DIFF_KEYS: &[&str] = &[
    "oldString",
    "newString",
    "content",
    "old_string",
    "new_string",
];
const EDIT_REGION_HINT_LEN: usize = 40;
/// `TRUNCATION_SENTINEL` marks a region-hinted diff value as truncated.
const TRUNCATION_SENTINEL: &str = "...[truncated]";

/// Reclaim target fraction: `fixedFloor + 0.30 × (ceiling − fixedFloor)`.
const TARGET_FRACTION: f64 = 0.30;
/// Newest `ceil(0.20 × n)` of each of T1/T2 are reserved (never evicted).
const TIER_RECENCY_RESERVE: f64 = 0.20;
/// Pressure-triggered reclamation skips arcs below 250 tokens.
const AGE_RECLAIM_MIN_TOKENS: usize = 250;
/// Emergency rearming requires reclaiming at least 2,000 tokens.
const EMERGENCY_REARM_MIN_TOKENS: f64 = 2000.0;
/// Emergency reclaim estimates use 0.25 tokens per byte.
const TOKENS_PER_BYTE: f64 = 0.25;
/// T1 (keep longest): navigation/structure the agent re-uses.
const T1_TOOLS: &[&str] = &["read", "todowrite", "task", "aft_outline", "aft_zoom"];
/// T2 (medium): edit-class continuation context.
const T2_TOOLS: &[&str] = &["edit", "write", "apply_patch", "grep", "glob", "aft_search"];
/// Newest-window tool arcs keep a name-preserving call skeleton; older ones fully
/// reduce the call block. The skeleton-vs-full choice is frozen at freeze time.
pub(crate) const RECENT_TOOL_SKELETON_WINDOW: usize = 20;

/// The reduction kind emitted per block. `drop` = `[dropped]` placeholder;
/// `skeleton` = a name-preserving ToolCall shell (newest window, pairing context);
/// `edit_marker` = filePath verbatim + region-hinted diff for a superseded edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RedKind {
    Drop,
    Skeleton,
    EditMarker,
}

impl RedKind {
    fn as_str(self) -> &'static str {
        match self {
            RedKind::Drop => "drop",
            RedKind::Skeleton => "skeleton",
            RedKind::EditMarker => "edit_marker",
        }
    }
}

/// The message role needed to reason about provider-side same-role merging.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelMessageRole {
    Assistant,
    System,
    NonAssistant,
}

/// The selectors use this typed content-kind projection.
#[derive(Debug, Clone)]
pub enum SelKind {
    ToolCall {
        name: String,
        /// The ToolCall.input (filePath / action / diff keys live here).
        input: serde_json::Value,
    },
    ToolResult {
        tool_name: String,
    },
    Reasoning,
    Text,
    RedactedReasoning,
    Media,
    Opaque,
}

/// A flat, block-granular reducible item, one per content block from the provider. The
/// `id` is this module's stable reduction identifier in `mid#block_index` form for every
/// block, including tool calls and tool results. This struct adds the typed fields that
/// the selection logic needs on top of the raw incoming item.
#[derive(Debug, Clone)]
pub struct SelItem {
    pub id: String,
    pub ordinal: u64,
    /// Provider-facing role of the owning message.
    pub message_role: SelMessageRole,
    pub kind: SelKind,
    /// True = the model's own SERVER-side tool (stays verbatim; never targeted).
    pub provider_executed: bool,
    /// Bytes this block contributes to reclaim accounting (output/content bytes).
    pub byte_size: usize,
    /// Persisted tag-token estimate for this block, when one exists.
    pub token_count: Option<usize>,
    /// The arc this block belongs to, for arc-atomic emission: every block in a tool
    /// arc carries the paired ToolCall block's `mid#block_index`; non-arc blocks carry
    /// `None`. The raw provider tool-call id is only a pairing hint at ingress and is
    /// never an identity key here.
    pub arc_id: Option<String>,
}

/// Pass-level inputs come from the transform request run-config, not CK items.
#[derive(Debug, Clone)]
pub struct SelectionContext {
    pub pass_class: PassClass,
    /// Provider-reported current total input tokens from the request usage sample.
    pub current_total_input_tokens: f64,
    /// ceiling = contextLimit × executeThreshold%.
    pub ceiling_tokens: f64,
    /// Items with `ordinal > protected_cutoff_ordinal` are never emergency-evicted; 0 protects nothing.
    pub protected_cutoff_ordinal: u64,
    /// Tool items with `ordinal <= last_execute_ordinal` may join the next riding or force batch; 0 permits none.
    /// `last_execute_ordinal` advances only after the riding or force batch is applied.
    /// Applying a riding or force batch advances the watermark only afterward, preventing execute-band residency from aging by one arc per pass.
    pub last_execute_ordinal: u64,
    /// True only for a scheduler execute caused by a context-pressure threshold crossing.
    pub scheduler_pressure_execute: bool,
    /// `prior_input_sample` records the prior emergency-drop input-token reading, or 0 if none; `has_prior_drop` records whether any emergency drop occurred.
    pub prior_input_sample: f64,
    pub has_prior_drop: bool,
    /// Caller-owned IDs marked for dropping.
    /// `agent_drop_ids` contains canonical flat block IDs.
    pub agent_drop_ids: Vec<String>,
    /// Missing `agent_drop_command_ids` entries denote blocks queued without command IDs.
    pub agent_drop_command_ids: HashMap<String, String>,
    /// `first_applied_agent_drop_ids` contains IDs whose commands completed their first application.
    /// Selection projects the command-scoped first-application marker onto individual block IDs.
    pub first_applied_agent_drop_ids: HashSet<String>,
    /// True when a byte-changing pass is already known before reduction selection.
    /// Selection may also discover a different command's first application as a ride.
    pub pass_already_busting: bool,
    /// True when supersession can ride concrete work already scheduled for this pass.
    /// Unlike `pass_already_busting`, a held emergency latch alone does not set this.
    pub supersession_ride_available: bool,
    /// Dynamic newest-tag protection expressed as exact block ids.
    pub tag_window_protected_block_ids: HashSet<String>,
    /// Whole-message protection for mutation-exempt and lineage-anchor messages.
    pub exempt_message_protected_block_ids: HashSet<String>,
}

impl SelectionContext {
    fn block_is_protected(&self, block_id: &str) -> bool {
        self.tag_window_protected_block_ids.contains(block_id)
            || self.exempt_message_protected_block_ids.contains(block_id)
    }
}

/// `PassClass` determines which selectors run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassClass {
    /// A normal execute+bust pass: control-plane / edit / two-pass / ctx_reduce run.
    Execute,
    /// A derived force-band pass: the emergency tiered drop runs (in addition).
    EmergencyForce,
    /// A defer pass: selection produces nothing new (mechanics replay frozen).
    Defer,
}

#[derive(Debug, Clone, Default)]
pub struct SelectionConfig {
    /// Gates the smart-drops selectors (control-plane + edit supersession).
    pub smart_drops: bool,
}

/// Selectors choose tool arcs as reduction units, then expand each selected arc into per-block decisions.
struct ToolArc {
    arc_id: String,
    /// Message that owns the ToolCall block; duplicate fingerprints are owner-qualified.
    owner_message_id: Option<String>,
    name: String,
    /// Original tool name, needed because the duplicate-safe set retains the `mcp_` prefix.
    dedup_name: String,
    /// Result position mirrors the order in which the TS tagger allocates tool tags.
    dedup_result_ordinal: u64,
    dedup_result_block_index: usize,
    /// The arc's age key = the ToolCall block's ordinal (or the min block ordinal).
    ordinal: u64,
    provider_executed: bool,
    input: serde_json::Value,
    /// FlatBlock ids of ToolCall blocks owned by this `(assistant mid, call id)` arc.
    /// TS groups repeated call IDs within one assistant message into one drop target; Rust keeps them in one composite arc.
    call_inputs: Vec<(String, serde_json::Value)>,
    call_bytes: usize,
    /// FlatBlock ids of paired ToolResult blocks (absent when a result has not arrived).
    result_ids: Vec<String>,
    result_bytes: usize,
    /// Persisted tag-token total; legacy arcs with no estimate remain reclaimable.
    reclaim_tokens: Option<usize>,
    /// True once ANY block of the arc is already frozen/reduced (arc is inactive).
    reduced: bool,
}

impl ToolArc {
    /// Bytes a full arc drop actually removes from the wire. Signed reasoning stays verbatim.
    fn reclaim_bytes(&self) -> usize {
        self.call_bytes + self.result_bytes
    }
}

/// Matches TS `normalizeToolName` for MCP-surfaced names.
fn normalize_tool_name(name: &str) -> String {
    let lower = name.to_lowercase();
    lower
        .strip_prefix("mcp_")
        .map(str::to_string)
        .unwrap_or(lower)
}

fn is_edit_tool(name: &str) -> bool {
    EDIT_TOOLS.contains(&name)
}

fn read_input_str(input: &serde_json::Value, keys: &[&str]) -> Option<String> {
    let obj = input.as_object()?;
    for key in keys {
        if let Some(serde_json::Value::String(s)) = obj.get(*key) {
            return Some(s.clone());
        }
    }
    None
}

fn group_arcs(items: &[SelItem], frozen: &HashSet<String>) -> Vec<ToolArc> {
    let mut arcs: HashMap<String, ToolArc> = HashMap::new();
    for item in items {
        let Some(arc_id) = item.arc_id.clone() else {
            continue;
        };
        let entry = arcs.entry(arc_id.clone()).or_insert_with(|| ToolArc {
            arc_id: arc_id.clone(),
            owner_message_id: None,
            name: String::new(),
            dedup_name: String::new(),
            dedup_result_ordinal: 0,
            dedup_result_block_index: 0,
            ordinal: u64::MAX,
            provider_executed: false,
            input: serde_json::Value::Null,
            call_inputs: Vec::new(),
            call_bytes: 0,
            result_ids: Vec::new(),
            result_bytes: 0,
            reclaim_tokens: None,
            reduced: false,
        });
        entry.ordinal = entry.ordinal.min(item.ordinal);
        if let Some(token_count) = item.token_count {
            entry.reclaim_tokens = Some(
                entry
                    .reclaim_tokens
                    .unwrap_or(0)
                    .saturating_add(token_count),
            );
        }
        if frozen.contains(&item.id) {
            entry.reduced = true;
        }
        match &item.kind {
            SelKind::ToolCall { name, input } => {
                entry.name = normalize_tool_name(name);
                entry.dedup_name = name.clone();
                if entry.call_inputs.is_empty() {
                    entry.input = input.clone();
                    entry.owner_message_id = item_message_id(item).map(str::to_owned);
                }
                entry.call_inputs.push((item.id.clone(), input.clone()));
                entry.call_bytes += item.byte_size;
                entry.provider_executed = item.provider_executed;
            }
            SelKind::ToolResult { tool_name } => {
                if entry.name.is_empty() {
                    entry.name = normalize_tool_name(tool_name);
                    entry.dedup_name = tool_name.clone();
                }
                let block_index = item
                    .id
                    .rsplit_once('#')
                    .and_then(|(_, index)| index.parse::<usize>().ok())
                    .unwrap_or(0);
                if (item.ordinal, block_index)
                    > (entry.dedup_result_ordinal, entry.dedup_result_block_index)
                {
                    entry.dedup_result_ordinal = item.ordinal;
                    entry.dedup_result_block_index = block_index;
                }
                entry.result_ids.push(item.id.clone());
                entry.result_bytes += item.byte_size;
                if item.provider_executed {
                    entry.provider_executed = true;
                }
            }
            _ => {}
        }
    }
    let mut out: Vec<ToolArc> = arcs.into_values().collect();
    out.sort_by(|a, b| {
        a.ordinal
            .cmp(&b.ordinal)
            .then_with(|| a.arc_id.cmp(&b.arc_id))
    });
    out
}

#[derive(Default)]
struct ReasoningMessageShape {
    has_reasoning: bool,
    has_durable_non_tool_sibling: bool,
    tool_arc_ids: HashSet<String>,
}

fn item_message_id(item: &SelItem) -> Option<&str> {
    let (mid, index) = item.id.rsplit_once('#')?;
    index.parse::<usize>().ok().map(|_| mid)
}

struct AdjacencyMessageShape<'a> {
    mid: &'a str,
    ordinal: u64,
    role: SelMessageRole,
    has_reasoning: bool,
    items: Vec<&'a SelItem>,
}

impl AdjacencyMessageShape<'_> {
    fn fully_removed_by_arc(&self) -> Option<&str> {
        let arc_id = self.items.first()?.arc_id.as_deref()?;
        self.items
            .iter()
            .all(|item| {
                item.arc_id.as_deref() == Some(arc_id)
                    && matches!(
                        item.kind,
                        SelKind::ToolCall { .. } | SelKind::ToolResult { .. }
                    )
            })
            .then_some(arc_id)
    }

    fn is_result_separator(&self) -> bool {
        self.role == SelMessageRole::NonAssistant
            && self
                .items
                .iter()
                .any(|item| matches!(item.kind, SelKind::ToolResult { .. }))
    }
}

fn reasoning_adjacency_collapse_arc_ids(items: &[SelItem]) -> HashSet<String> {
    let mut messages: HashMap<&str, AdjacencyMessageShape<'_>> = HashMap::new();
    for item in items {
        let Some(mid) = item_message_id(item) else {
            continue;
        };
        let message = messages
            .entry(mid)
            .or_insert_with(|| AdjacencyMessageShape {
                mid,
                ordinal: item.ordinal,
                role: item.message_role,
                has_reasoning: false,
                items: Vec::new(),
            });
        message.ordinal = message.ordinal.min(item.ordinal);
        message.has_reasoning |=
            matches!(item.kind, SelKind::Reasoning | SelKind::RedactedReasoning);
        message.items.push(item);
    }
    let mut messages = messages.into_values().collect::<Vec<_>>();
    messages.sort_by(|left, right| {
        left.ordinal
            .cmp(&right.ordinal)
            .then_with(|| left.mid.cmp(right.mid))
    });

    let mut removable_by_arc: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        if let Some(arc_id) = message.fully_removed_by_arc() {
            removable_by_arc.entry(arc_id).or_default().push(index);
        }
    }

    removable_by_arc
        .into_iter()
        .filter_map(|(arc_id, indexes)| {
            let hazardous = indexes
                .chunk_by(|left, right| *right == *left + 1)
                .any(|run| {
                    let first = run[0];
                    let last = run[run.len() - 1];
                    let Some(left) = first.checked_sub(1).and_then(|index| messages.get(index))
                    else {
                        return false;
                    };
                    let Some(right) = messages.get(last + 1) else {
                        return false;
                    };
                    run.iter()
                        .any(|index| messages[*index].is_result_separator())
                        && left.role == SelMessageRole::Assistant
                        && right.role == SelMessageRole::Assistant
                        && (left.has_reasoning || right.has_reasoning)
                });
            hazardous.then(|| arc_id.to_string())
        })
        .collect()
}

pub(crate) fn reasoning_ineligible_arc_ids(items: &[SelItem]) -> HashSet<String> {
    let mut messages: HashMap<&str, ReasoningMessageShape> = HashMap::new();
    for item in items {
        let Some(mid) = item_message_id(item) else {
            continue;
        };
        let message = messages.entry(mid).or_default();
        match &item.kind {
            SelKind::Reasoning | SelKind::RedactedReasoning => message.has_reasoning = true,
            SelKind::ToolCall { .. } | SelKind::ToolResult { .. } if !item.provider_executed => {
                if let Some(arc_id) = &item.arc_id {
                    message.tool_arc_ids.insert(arc_id.clone());
                } else {
                    message.has_durable_non_tool_sibling = true;
                }
            }
            SelKind::ToolCall { .. } | SelKind::ToolResult { .. } => {
                message.has_durable_non_tool_sibling = true;
            }
            _ => message.has_durable_non_tool_sibling = true,
        }
    }

    messages
        .into_values()
        .filter(|message| message.has_reasoning && !message.has_durable_non_tool_sibling)
        .flat_map(|message| message.tool_arc_ids)
        .collect()
}

pub(crate) fn filter_reasoning_ineligible_decisions(
    items: &[SelItem],
    decisions: Vec<ReductionDecision>,
) -> Vec<ReductionDecision> {
    let ineligible_arcs = reasoning_ineligible_arc_ids(items);
    if ineligible_arcs.is_empty() {
        return decisions;
    }
    let arc_by_block_id: HashMap<&str, &str> = items
        .iter()
        .filter_map(|item| Some((item.id.as_str(), item.arc_id.as_deref()?)))
        .collect();
    decisions
        .into_iter()
        .filter(|decision| {
            arc_by_block_id
                .get(decision.target_id.as_str())
                .is_none_or(|arc_id| !ineligible_arcs.contains(*arc_id))
        })
        .collect()
}

const DROPPED_PLACEHOLDER: &str = "[dropped]";

fn safe_prefix(s: &str, max_len: usize) -> &str {
    let mut end = max_len.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn region_hint(value: &str) -> String {
    if value.ends_with(TRUNCATION_SENTINEL) {
        return value.to_string();
    }
    if utf16_len(value) > EDIT_REGION_HINT_LEN {
        format!(
            "{}{}",
            utf16_prefix(value, EDIT_REGION_HINT_LEN),
            TRUNCATION_SENTINEL
        )
    } else {
        value.to_string()
    }
}

/// `applyEditMarkerToInput`.
fn edit_marker_payload(input: &serde_json::Value) -> String {
    let mut obj = match input.as_object() {
        Some(o) => o.clone(),
        None => return DROPPED_PLACEHOLDER.to_string(),
    };
    for (key, value) in obj.iter_mut() {
        if FILE_PATH_KEYS.contains(&key.as_str()) {
            continue;
        }
        if !DIFF_KEYS.contains(&key.as_str()) {
            continue;
        }
        if let serde_json::Value::String(s) = value {
            *value = serde_json::Value::String(region_hint(s));
        }
    }
    canonical_json(&serde_json::Value::Object(obj))
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonical_json(&map[k])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

struct ArcIntent {
    edit_marker: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ArcShape {
    Skeleton,
    FullDrop,
    DedupFullDrop,
    EditMarker,
}

fn skeleton_payload(input: &serde_json::Value) -> String {
    const INPUT_CLAMP_BYTES: usize = 500;
    const SKELETON_ARG_LEN: usize = 5;
    let serialized_len = serde_json::to_string(input)
        .map(|value| value.len())
        .unwrap_or(0);
    if serialized_len <= INPUT_CLAMP_BYTES {
        return canonical_json(input);
    }
    let clamp_object = |object: &serde_json::Map<String, serde_json::Value>| {
        let mut output = object.clone();
        for value in output.values_mut() {
            match value {
                serde_json::Value::String(s) if s.chars().count() > SKELETON_ARG_LEN => {
                    let byte_len = s
                        .char_indices()
                        .nth(SKELETON_ARG_LEN)
                        .map(|(i, _)| i)
                        .unwrap_or(s.len());
                    *value = serde_json::Value::String(format!(
                        "{}{}",
                        safe_prefix(s, byte_len),
                        TRUNCATION_SENTINEL
                    ));
                }
                serde_json::Value::Array(items) => {
                    *value = serde_json::Value::String(format!("[{} items]", items.len()));
                }
                serde_json::Value::Object(_) => {
                    *value = serde_json::Value::String("[object]".to_string());
                }
                _ => {}
            }
        }
        canonical_json(&serde_json::Value::Object(output))
    };
    match input {
        serde_json::Value::Object(object) => clamp_object(object),
        serde_json::Value::Array(items) => format!("[{} items]", items.len()),
        _ => canonical_json(input),
    }
}

fn expand_arc(
    arc: &ToolArc,
    shape: ArcShape,
    frozen: &HashSet<String>,
    out: &mut Vec<ReductionDecision>,
) {
    for (call_id, input) in &arc.call_inputs {
        if !frozen.contains(call_id) {
            let (kind, payload) = match shape {
                ArcShape::Skeleton => (RedKind::Skeleton, skeleton_payload(input)),
                ArcShape::FullDrop | ArcShape::DedupFullDrop => {
                    (RedKind::Drop, DROPPED_PLACEHOLDER.to_string())
                }
                ArcShape::EditMarker => (RedKind::EditMarker, edit_marker_payload(input)),
            };
            out.push(ReductionDecision {
                target_id: call_id.clone(),
                kind: kind.as_str().to_string(),
                payload,
            });
        }
    }
    for result_id in &arc.result_ids {
        if !frozen.contains(result_id) {
            out.push(ReductionDecision {
                target_id: result_id.clone(),
                kind: RedKind::Drop.as_str().to_string(),
                payload: DROPPED_PLACEHOLDER.to_string(),
            });
        }
    }
}

fn newest_ctx_reduce_arc_ids(arcs: &[&ToolArc]) -> HashSet<String> {
    let mut newest_first: Vec<&ToolArc> = arcs
        .iter()
        .copied()
        .filter(|arc| arc.name == "ctx_reduce")
        .collect();
    newest_first.sort_by(|left, right| {
        right
            .ordinal
            .cmp(&left.ordinal)
            .then_with(|| right.arc_id.cmp(&left.arc_id))
    });
    newest_first
        .into_iter()
        .take(CTX_REDUCE_KEEP)
        .map(|arc| arc.arc_id.clone())
        .collect()
}

/// Control-plane supersession and edit supersession select `smart_drops` targets.
/// The selector keeps the newest `todowrite` arc and `CTX_REDUCE_KEEP` `ctx_reduce` arcs and drops all zero-value meta arcs.
/// The selector drops `ctx_note` arcs with zero-value actions and marks older same-file edit/write arcs with `edit_marker`.
fn select_supersession(arcs: &[&ToolArc]) -> HashMap<String, ArcIntent> {
    let mut intents: HashMap<String, ArcIntent> = HashMap::new();
    // Newest-arc-first for keep-N and newest-per-file semantics.
    let mut newest_first: Vec<&&ToolArc> = arcs.iter().collect();
    newest_first.sort_by(|a, b| {
        b.ordinal
            .cmp(&a.ordinal)
            .then_with(|| b.arc_id.cmp(&a.arc_id))
    });

    let mut todowrite_seen = 0usize;
    let protected_ctx_reduce_arcs = newest_ctx_reduce_arc_ids(arcs);
    let mut seen_file: HashSet<String> = HashSet::new();

    for arc in newest_first {
        let name = arc.name.as_str();
        // Edit supersession runs first: older calls for each file use `edit_marker`.
        if is_edit_tool(name) {
            if let Some(fp) = read_input_str(&arc.input, FILE_PATH_KEYS) {
                if seen_file.contains(&fp) {
                    intents
                        .entry(arc.arc_id.clone())
                        .or_insert(ArcIntent { edit_marker: true });
                } else {
                    seen_file.insert(fp); // newest edit to this file stays full
                }
            }
            // No resolvable `filePath` skips edit supersession; name rules still apply.
        }
        let is_drop_target = if name == "todowrite" {
            todowrite_seen += 1;
            todowrite_seen > TODOWRITE_KEEP
        } else if name == "ctx_reduce" {
            !protected_ctx_reduce_arcs.contains(&arc.arc_id)
        } else if ZERO_VALUE_META_TOOLS.contains(&name) {
            true
        } else if name == "ctx_note" {
            read_input_str(&arc.input, &["action"])
                .map(|a| CTX_NOTE_ZERO_VALUE_ACTIONS.contains(&a.as_str()))
                .unwrap_or(false)
        } else {
            false
        };
        if is_drop_target {
            // A full drop supersedes an edit_marker for the same arc (drop wins).
            intents.insert(arc.arc_id.clone(), ArcIntent { edit_marker: false });
        }
    }
    intents
}

/// Including the owner in the fingerprint keeps identical calls from distinct assistant messages separate.
fn select_tool_dedup(arcs: &[&ToolArc], ctx: &SelectionContext) -> HashSet<String> {
    let mut by_owner_arc: HashMap<(String, String), (&ToolArc, String)> = HashMap::new();
    for arc in arcs {
        if !DEDUP_SAFE_TOOLS.contains(&arc.dedup_name.as_str())
            || arc.owner_message_id.is_none()
            || arc.result_ids.is_empty()
            || arc
                .call_inputs
                .iter()
                .any(|(id, _)| ctx.block_is_protected(id))
            || arc.result_ids.iter().any(|id| ctx.block_is_protected(id))
            || (ctx.protected_cutoff_ordinal > 0 && arc.ordinal > ctx.protected_cutoff_ordinal)
        {
            continue;
        }
        let Some(args) = serde_json::to_string(&arc.input).ok() else {
            continue;
        };
        let owner_message_id = arc
            .owner_message_id
            .as_ref()
            .expect("owner checked above")
            .clone();
        let fingerprint = format!("{owner_message_id}:{}:{args}", arc.dedup_name);
        by_owner_arc.insert((owner_message_id, arc.arc_id.clone()), (*arc, fingerprint));
    }

    let mut groups: HashMap<String, Vec<&ToolArc>> = HashMap::new();
    for (_, (arc, fingerprint)) in by_owner_arc {
        groups.entry(fingerprint).or_default().push(arc);
    }
    groups
        .into_values()
        .flat_map(|mut group| {
            if group.len() <= 1 {
                return Vec::new();
            }
            group.sort_by(|left, right| {
                left.dedup_result_ordinal
                    .cmp(&right.dedup_result_ordinal)
                    .then_with(|| {
                        left.dedup_result_block_index
                            .cmp(&right.dedup_result_block_index)
                    })
                    .then_with(|| left.arc_id.cmp(&right.arc_id))
            });
            group.pop();
            group
                .into_iter()
                .map(|arc| arc.arc_id.clone())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn two_pass_batch_can_apply(ctx: &SelectionContext) -> bool {
    ctx.scheduler_pressure_execute
        && (ctx.pass_already_busting || ctx.pass_class == PassClass::EmergencyForce)
}

fn select_two_pass(arcs: &[&ToolArc], ctx: &SelectionContext) -> HashSet<String> {
    if !two_pass_batch_can_apply(ctx) || ctx.last_execute_ordinal == 0 {
        return HashSet::new();
    }
    let protected_ctx_reduce_arcs = newest_ctx_reduce_arc_ids(arcs);
    let newest_todowrite = arcs
        .iter()
        .filter(|arc| arc.name == "todowrite")
        .max_by(|left, right| {
            left.ordinal
                .cmp(&right.ordinal)
                .then_with(|| left.arc_id.cmp(&right.arc_id))
        })
        .map(|arc| arc.arc_id.as_str());
    arcs.iter()
        .filter(|arc| arc.ordinal <= ctx.last_execute_ordinal)
        .filter(|arc| {
            arc.reclaim_tokens
                .is_none_or(|tokens| tokens >= AGE_RECLAIM_MIN_TOKENS)
        })
        .filter(|arc| Some(arc.arc_id.as_str()) != newest_todowrite)
        .filter(|arc| !protected_ctx_reduce_arcs.contains(&arc.arc_id))
        .map(|arc| arc.arc_id.clone())
        .collect()
}

fn select_agent_drops(
    ctx: &SelectionContext,
    live_ids: &HashSet<String>,
    frozen: &HashSet<String>,
    out: &mut Vec<ReductionDecision>,
) {
    for id in &ctx.agent_drop_ids {
        if frozen.contains(id) || !live_ids.contains(id) || ctx.block_is_protected(id) {
            continue;
        }
        let first_applied = ctx.first_applied_agent_drop_ids.contains(id);
        let natural_bust = ctx.pass_already_busting
            || (ctx.pass_class == PassClass::Execute
                && ctx.ceiling_tokens > 0.0
                && ctx.current_total_input_tokens >= ctx.ceiling_tokens);
        let can_ride = natural_bust
            || (first_applied
                && ctx.agent_drop_ids.iter().any(|other| {
                    other != id
                        && !ctx.first_applied_agent_drop_ids.contains(other)
                        && live_ids.contains(other)
                        && !frozen.contains(other)
                        && !ctx.block_is_protected(other)
                        && ctx.agent_drop_command_ids.get(other)
                            != ctx.agent_drop_command_ids.get(id)
                }));
        if first_applied && !can_ride {
            continue;
        }
        out.push(ReductionDecision {
            target_id: id.clone(),
            kind: RedKind::Drop.as_str().to_string(),
            payload: DROPPED_PLACEHOLDER.to_string(),
        });
    }
}

fn resolve_tool_tier(name: &str) -> u8 {
    let n = normalize_tool_name(name);
    if T1_TOOLS.contains(&n.as_str()) {
        1
    } else if T2_TOOLS.contains(&n.as_str()) {
        2
    } else {
        3
    }
}

fn bytes_to_tokens(bytes: usize) -> f64 {
    (bytes as f64 * TOKENS_PER_BYTE).round()
}

fn active_floor_tokens(items: &[SelItem], frozen_keys: &HashSet<String>) -> f64 {
    let mut tool_tag_bytes: HashMap<&str, usize> = HashMap::new();
    let mut tokens = 0.0;
    for item in items.iter().filter(|item| {
        !frozen_keys.contains(&item.id)
            && item.message_role != SelMessageRole::System
            && !matches!(item.kind, SelKind::Opaque)
    }) {
        if let Some(arc_id) = item.arc_id.as_deref() {
            tool_tag_bytes
                .entry(arc_id)
                .and_modify(|bytes| *bytes = bytes.saturating_add(item.byte_size))
                .or_insert(item.byte_size);
        } else {
            tokens += bytes_to_tokens(item.byte_size);
        }
    }
    tokens
        + tool_tag_bytes
            .into_values()
            .map(bytes_to_tokens)
            .sum::<f64>()
}

fn select_emergency(
    arcs: &[&ToolArc],
    ctx: &SelectionContext,
    all_active_floor_tokens: f64,
) -> HashSet<String> {
    if !ctx.ceiling_tokens.is_finite() || ctx.ceiling_tokens <= 0.0 {
        return HashSet::new();
    }
    if !ctx.current_total_input_tokens.is_finite() || ctx.current_total_input_tokens <= 0.0 {
        return HashSet::new();
    }
    if ctx.has_prior_drop && ctx.current_total_input_tokens == ctx.prior_input_sample {
        return HashSet::new();
    }

    let fixed_floor = (ctx.current_total_input_tokens - all_active_floor_tokens).max(0.0);
    let working_span = (ctx.ceiling_tokens - fixed_floor).max(0.0);
    let target = fixed_floor + TARGET_FRACTION * working_span;
    let reclaim_tokens = (ctx.current_total_input_tokens - target).round();
    if reclaim_tokens <= EMERGENCY_REARM_MIN_TOKENS {
        return HashSet::new();
    }

    let mut tier_active: HashMap<u8, Vec<&&ToolArc>> = HashMap::new();
    for arc in arcs {
        let tier = resolve_tool_tier(&arc.name);
        if tier == 1 || tier == 2 {
            tier_active.entry(tier).or_default().push(arc);
        }
    }
    let mut reserved: HashSet<String> = HashSet::new();
    for tier in [1u8, 2u8] {
        if let Some(nums) = tier_active.get_mut(&tier) {
            nums.sort_by(|a, b| {
                b.ordinal
                    .cmp(&a.ordinal)
                    .then_with(|| b.arc_id.cmp(&a.arc_id))
            });
            let reserve_count = (TIER_RECENCY_RESERVE * nums.len() as f64).ceil() as usize;
            for arc in nums.iter().take(reserve_count) {
                reserved.insert(arc.arc_id.clone());
            }
        }
    }

    let protected_ctx_reduce_arcs = newest_ctx_reduce_arc_ids(arcs);

    let mut by_tier: HashMap<u8, Vec<&&ToolArc>> = HashMap::new();
    for arc in arcs {
        if arc.ordinal > ctx.protected_cutoff_ordinal && ctx.protected_cutoff_ordinal > 0 {
            continue; // global protected tail
        }
        if protected_ctx_reduce_arcs.contains(&arc.arc_id) {
            continue;
        }
        let tier = resolve_tool_tier(&arc.name);
        if (tier == 1 || tier == 2) && reserved.contains(&arc.arc_id) {
            continue;
        }
        by_tier.entry(tier).or_default().push(arc);
    }

    let mut selected: HashSet<String> = HashSet::new();
    let mut reclaimed = 0.0f64;
    'outer: for tier in [3u8, 2u8, 1u8] {
        if let Some(group) = by_tier.get_mut(&tier) {
            group.sort_by(|a, b| {
                a.ordinal
                    .cmp(&b.ordinal)
                    .then_with(|| a.arc_id.cmp(&b.arc_id))
            });
            for arc in group.iter() {
                selected.insert(arc.arc_id.clone());
                reclaimed += bytes_to_tokens(arc.reclaim_bytes());
                if reclaimed >= reclaim_tokens {
                    break 'outer;
                }
            }
        }
    }
    selected
}

#[derive(Debug, Default)]
pub(crate) struct SelectionOutcome {
    pub decisions: Vec<ReductionDecision>,
    pub two_pass_batch_can_apply: bool,
    pub eligible_supersession_count: Option<usize>,
    pub supersession_withheld_by_tag_window_count: Option<usize>,
    pub supersession_withheld_by_exempt_message_count: Option<usize>,
    pub applied_supersession_count: Option<usize>,
}

pub fn select_reductions(
    items: &[SelItem],
    frozen_keys: &HashSet<String>,
    ctx: &SelectionContext,
    cfg: &SelectionConfig,
) -> Vec<ReductionDecision> {
    select_reductions_with_outcome(items, frozen_keys, ctx, cfg).decisions
}

pub(crate) fn select_reductions_with_outcome(
    items: &[SelItem],
    frozen_keys: &HashSet<String>,
    ctx: &SelectionContext,
    cfg: &SelectionConfig,
) -> SelectionOutcome {
    if ctx.pass_class == PassClass::Defer {
        return SelectionOutcome::default();
    }

    let two_pass_batch_can_apply = two_pass_batch_can_apply(ctx);
    let live_ids: HashSet<String> = items
        .iter()
        .filter(|item| {
            !matches!(
                item.kind,
                SelKind::Media | SelKind::Opaque | SelKind::Reasoning | SelKind::RedactedReasoning
            )
        })
        .map(|item| item.id.clone())
        .collect();
    let arcs = group_arcs(items, frozen_keys);
    let reasoning_ineligible_arcs = reasoning_ineligible_arc_ids(items);
    let reasoning_adjacency_collapse_arcs = reasoning_adjacency_collapse_arc_ids(items);
    let active_arcs: Vec<&ToolArc> = arcs
        .iter()
        .filter(|a| {
            !a.reduced && !a.provider_executed && !reasoning_ineligible_arcs.contains(&a.arc_id)
        })
        .collect();
    let arc_by_id: HashMap<&str, &ToolArc> = active_arcs
        .iter()
        .map(|arc| (arc.arc_id.as_str(), *arc))
        .collect();

    let mut arc_shapes: HashMap<String, ArcShape> = HashMap::new();
    let dedup_arc_ids = select_tool_dedup(&active_arcs, ctx);
    let arcs_after_dedup: Vec<&ToolArc> = active_arcs
        .iter()
        .copied()
        .filter(|arc| !dedup_arc_ids.contains(&arc.arc_id))
        .collect();
    let two_pass_arc_ids = select_two_pass(&arcs_after_dedup, ctx);
    let mut eligible_supersession_arc_ids = None;

    match ctx.pass_class {
        PassClass::EmergencyForce => {
            // System-prefix and opaque metadata do not contribute to the fixed floor.
            let all_active_floor_tokens = active_floor_tokens(items, frozen_keys);
            let emergency_arc_ids = select_emergency(&active_arcs, ctx, all_active_floor_tokens);
            if !emergency_arc_ids.is_empty() || !two_pass_arc_ids.is_empty() {
                for arc_id in &dedup_arc_ids {
                    arc_shapes.insert(arc_id.clone(), ArcShape::DedupFullDrop);
                }
            }
            // The force-band edge admits a waiting age batch without changing emergency candidate accounting or tiered selection.
            for arc_id in &two_pass_arc_ids {
                arc_shapes
                    .entry(arc_id.clone())
                    .or_insert(ArcShape::FullDrop);
            }
            for arc_id in &emergency_arc_ids {
                arc_shapes
                    .entry(arc_id.clone())
                    .or_insert(ArcShape::FullDrop);
            }
            // Supersession applies only after an emergency eviction or a two-pass reclaim batch.
            // If emergency mode meets its headroom target without selecting anything, defer supersession so it cannot create a cache bust by itself.
            if cfg.smart_drops && (!emergency_arc_ids.is_empty() || !two_pass_arc_ids.is_empty()) {
                let intents = select_supersession(&active_arcs);
                eligible_supersession_arc_ids =
                    Some(intents.keys().cloned().collect::<HashSet<_>>());
                for (arc_id, intent) in intents {
                    arc_shapes.entry(arc_id).or_insert(if intent.edit_marker {
                        ArcShape::EditMarker
                    } else {
                        ArcShape::FullDrop
                    });
                }
            }
        }
        PassClass::Execute => {
            // The selector applies dedup (drop) → two-pass (drop) → control-plane (drop) → edit (edit_marker).
            // A later `edit_marker` never overrides an assigned drop.
            for arc_id in &dedup_arc_ids {
                arc_shapes.insert(arc_id.clone(), ArcShape::DedupFullDrop);
            }
            for arc_id in &two_pass_arc_ids {
                arc_shapes
                    .entry(arc_id.clone())
                    .or_insert(ArcShape::FullDrop);
            }
            // An admitted two-pass batch lets the whole pending set ride the same bust.
            if cfg.smart_drops && (ctx.supersession_ride_available || !two_pass_arc_ids.is_empty())
            {
                // The selector counts the exact output before overlap precedence removes members.
                let intents = select_supersession(&active_arcs);
                eligible_supersession_arc_ids =
                    Some(intents.keys().cloned().collect::<HashSet<_>>());
                for (arc_id, intent) in intents {
                    if arc_shapes.contains_key(&arc_id) {
                        continue; // already a drop (two-pass) → drop wins
                    }
                    arc_shapes.insert(
                        arc_id,
                        if intent.edit_marker {
                            ArcShape::EditMarker
                        } else {
                            ArcShape::FullDrop
                        },
                    );
                }
            }
        }
        PassClass::Defer => unreachable!("defer returned early"),
    }

    // Supersession's recency floor follows the newest active tag window rather than a separate owner-message `K=20` window.
    // If either half has a protected active tag, retain the whole arc.
    // Filtering only the tagged result would leave an arc partially superseded when its other half is protected.
    let protected_supersession_arcs = |protected_block_ids: &HashSet<String>| {
        eligible_supersession_arc_ids.as_ref().map(|eligible| {
            eligible
                .iter()
                .filter(|arc_id| {
                    arc_by_id.get(arc_id.as_str()).is_some_and(|arc| {
                        arc.call_inputs
                            .iter()
                            .any(|(id, _)| protected_block_ids.contains(id))
                            || arc
                                .result_ids
                                .iter()
                                .any(|id| protected_block_ids.contains(id))
                    })
                })
                .cloned()
                .collect::<HashSet<_>>()
        })
    };
    let supersession_arcs_with_tag_window_protection =
        protected_supersession_arcs(&ctx.tag_window_protected_block_ids);
    let supersession_arcs_with_exempt_message_protection =
        protected_supersession_arcs(&ctx.exempt_message_protected_block_ids);

    // FullDrop resolves to Skeleton when reasoning adjacency or the skeleton window requires a result shell.
    // The resolver decides before expand_arc; frozen_keys excludes replayed arcs.
    // Frozen arcs cannot change when an aging window advances or a new adjacency is detected.
    // EditMarker is window-independent.
    let mut newest_arcs: Vec<&&ToolArc> = active_arcs.iter().collect();
    newest_arcs.sort_by(|a, b| {
        b.ordinal
            .cmp(&a.ordinal)
            .then_with(|| b.arc_id.cmp(&a.arc_id))
    });
    let skeleton_window: HashSet<String> = newest_arcs
        .iter()
        .take(RECENT_TOOL_SKELETON_WINDOW)
        .map(|a| a.arc_id.clone())
        .collect();

    let mut out: Vec<ReductionDecision> = Vec::new();
    for (arc_id, shape) in &arc_shapes {
        let Some(arc) = arc_by_id.get(arc_id.as_str()) else {
            continue;
        };
        if supersession_arcs_with_tag_window_protection
            .as_ref()
            .is_some_and(|protected| protected.contains(arc_id))
            || supersession_arcs_with_exempt_message_protection
                .as_ref()
                .is_some_and(|protected| protected.contains(arc_id))
        {
            continue;
        }
        let resolved = match shape {
            ArcShape::EditMarker => ArcShape::EditMarker,
            ArcShape::Skeleton => ArcShape::Skeleton,
            ArcShape::FullDrop
                if reasoning_adjacency_collapse_arcs.contains(arc_id)
                    || skeleton_window.contains(arc_id) =>
            {
                ArcShape::Skeleton
            }
            ArcShape::DedupFullDrop if reasoning_adjacency_collapse_arcs.contains(arc_id) => {
                ArcShape::Skeleton
            }
            ArcShape::FullDrop => ArcShape::FullDrop,
            ArcShape::DedupFullDrop => ArcShape::DedupFullDrop,
        };
        expand_arc(arc, resolved, frozen_keys, &mut out);
    }

    // ctx_reduce agent drops stay block-granular, and Media and Opaque cannot become reduction targets because pass-through carriers are absent from live_ids.
    select_agent_drops(ctx, &live_ids, frozen_keys, &mut out);

    // Agent-directed ids can name either half of a tool arc, so the whole-message guard runs after block-granular decisions.
    let arc_by_block_id: HashMap<&str, &str> = items
        .iter()
        .filter_map(|item| Some((item.id.as_str(), item.arc_id.as_deref()?)))
        .collect();
    out.retain(|decision| {
        arc_by_block_id
            .get(decision.target_id.as_str())
            .is_none_or(|arc_id| !reasoning_ineligible_arcs.contains(*arc_id))
    });

    // Protection removes protected targets from automatic and agent-directed decisions before the stable merge.
    out.retain(|decision| !ctx.block_is_protected(&decision.target_id));

    // The merge emits one decision per target, prioritizing drop over edit_marker over skeleton.
    // The merge orders output by target_id.
    let decisions = dedupe_and_sort(out);
    let applied_supersession_arcs = eligible_supersession_arc_ids.as_ref().map(|eligible| {
        decisions
            .iter()
            .filter_map(|decision| arc_by_block_id.get(decision.target_id.as_str()).copied())
            .filter(|arc_id| eligible.contains(*arc_id))
            .map(str::to_string)
            .collect::<HashSet<_>>()
    });
    let withheld_count = |protected: &Option<HashSet<String>>| {
        protected
            .as_ref()
            .zip(applied_supersession_arcs.as_ref())
            .map(|(protected, applied)| protected.difference(applied).count())
    };
    SelectionOutcome {
        decisions,
        two_pass_batch_can_apply,
        eligible_supersession_count: eligible_supersession_arc_ids.as_ref().map(HashSet::len),
        supersession_withheld_by_tag_window_count: withheld_count(
            &supersession_arcs_with_tag_window_protection,
        ),
        supersession_withheld_by_exempt_message_count: withheld_count(
            &supersession_arcs_with_exempt_message_protection,
        ),
        applied_supersession_count: applied_supersession_arcs.as_ref().map(HashSet::len),
    }
}

fn dedupe_and_sort(decisions: Vec<ReductionDecision>) -> Vec<ReductionDecision> {
    fn rank(kind: &str) -> u8 {
        match kind {
            "drop" => 3,
            "edit_marker" => 2,
            "skeleton" => 1,
            _ => 0,
        }
    }
    let mut best: HashMap<String, ReductionDecision> = HashMap::new();
    for d in decisions {
        match best.get(&d.target_id) {
            Some(existing) if rank(&existing.kind) >= rank(&d.kind) => {}
            _ => {
                best.insert(d.target_id.clone(), d);
            }
        }
    }
    let mut out: Vec<ReductionDecision> = best.into_values().collect();
    out.sort_by(|a, b| a.target_id.cmp(&b.target_id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    fn call_block_id(mid: &str) -> String {
        format!("{mid}#0")
    }

    fn result_block_id(mid: &str) -> String {
        format!("{mid}#1")
    }

    fn reasoning_block_id(mid: &str) -> String {
        format!("{mid}#2")
    }

    fn tool_call(
        mid: &str,
        ordinal: u64,
        name: &str,
        input: serde_json::Value,
        bytes: usize,
    ) -> SelItem {
        let id = call_block_id(mid);
        SelItem {
            id: id.clone(),
            ordinal,
            message_role: SelMessageRole::Assistant,
            kind: SelKind::ToolCall {
                name: name.to_string(),
                input,
            },
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: Some(id),
        }
    }

    fn tool_result(mid: &str, ordinal: u64, name: &str, bytes: usize) -> SelItem {
        SelItem {
            id: result_block_id(mid),
            ordinal,
            message_role: SelMessageRole::NonAssistant,
            kind: SelKind::ToolResult {
                tool_name: name.to_string(),
            },
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: Some(call_block_id(mid)),
        }
    }

    fn reasoning(mid: &str, ordinal: u64, bytes: usize) -> SelItem {
        SelItem {
            id: reasoning_block_id(mid),
            ordinal,
            message_role: SelMessageRole::Assistant,
            kind: SelKind::Reasoning,
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: Some(call_block_id(mid)),
        }
    }

    fn reasoning_with_id(id: &str, arc_id: &str, ordinal: u64, bytes: usize) -> SelItem {
        SelItem {
            id: id.to_string(),
            ordinal,
            message_role: SelMessageRole::Assistant,
            kind: SelKind::Reasoning,
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: Some(arc_id.to_string()),
        }
    }

    fn text_with_id(id: &str, ordinal: u64, bytes: usize) -> SelItem {
        SelItem {
            id: id.to_string(),
            ordinal,
            message_role: SelMessageRole::NonAssistant,
            kind: SelKind::Text,
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: None,
        }
    }

    fn tool_call_with_ids(
        id: &str,
        arc_id: &str,
        ordinal: u64,
        name: &str,
        input: serde_json::Value,
        bytes: usize,
    ) -> SelItem {
        SelItem {
            id: id.to_string(),
            ordinal,
            message_role: SelMessageRole::Assistant,
            kind: SelKind::ToolCall {
                name: name.to_string(),
                input,
            },
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: Some(arc_id.to_string()),
        }
    }

    fn tool_result_with_ids(
        id: &str,
        arc_id: &str,
        ordinal: u64,
        name: &str,
        bytes: usize,
    ) -> SelItem {
        SelItem {
            id: id.to_string(),
            ordinal,
            message_role: SelMessageRole::NonAssistant,
            kind: SelKind::ToolResult {
                tool_name: name.to_string(),
            },
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: Some(arc_id.to_string()),
        }
    }

    fn base_ctx(pass: PassClass) -> SelectionContext {
        SelectionContext {
            pass_class: pass,
            current_total_input_tokens: 0.0,
            ceiling_tokens: 0.0,
            protected_cutoff_ordinal: 0,
            last_execute_ordinal: 0,
            scheduler_pressure_execute: pass == PassClass::Execute,
            prior_input_sample: 0.0,
            has_prior_drop: false,
            agent_drop_ids: Vec::new(),
            agent_drop_command_ids: HashMap::new(),
            first_applied_agent_drop_ids: HashSet::new(),
            pass_already_busting: false,
            supersession_ride_available: false,
            tag_window_protected_block_ids: HashSet::new(),
            exempt_message_protected_block_ids: HashSet::new(),
        }
    }

    #[test]
    fn natural_bust_drains_a_single_command_remainder() {
        let items = vec![SelItem {
            id: "drop".to_string(),
            ordinal: 1,
            message_role: SelMessageRole::NonAssistant,
            kind: SelKind::Text,
            provider_executed: false,
            byte_size: 128,
            token_count: None,
            arc_id: None,
        }];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec!["drop".to_string()];
        ctx.agent_drop_command_ids
            .insert("drop".to_string(), "command-1".to_string());
        ctx.first_applied_agent_drop_ids.insert("drop".to_string());
        ctx.current_total_input_tokens = 100.0;
        ctx.ceiling_tokens = 100.0;

        let selected =
            select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].target_id, "drop");

        ctx.current_total_input_tokens = 99.0;
        let held = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(held.is_empty());
    }

    /// The selector projects per-block decisions to {arc_id -> "drop"|"edit_marker"} by each arc's call block.
    fn arc_decisions(
        items: &[SelItem],
        out: &[ReductionDecision],
    ) -> std::collections::BTreeMap<String, String> {
        let id_to_arc_and_kind: HashMap<&str, (&str, bool)> = items
            .iter()
            .filter_map(|i| {
                i.arc_id.as_deref().map(|a| {
                    (
                        i.id.as_str(),
                        (a, matches!(&i.kind, SelKind::ToolCall { .. })),
                    )
                })
            })
            .collect();
        let mut m = std::collections::BTreeMap::new();
        for d in out {
            let Some((arc, is_call)) = id_to_arc_and_kind.get(d.target_id.as_str()) else {
                continue;
            };
            // The arc's decision is defined by its CALL block's kind.
            if *is_call {
                let arc_kind = match d.kind.as_str() {
                    "edit_marker" => "edit_marker",
                    _ => "drop", // skeleton or drop → arc-level "drop"
                };
                m.insert(arc.to_string(), arc_kind.to_string());
            } else {
                m.entry(arc.to_string())
                    .or_insert_with(|| "drop".to_string());
            }
        }
        m
    }

    fn served_block_bytes(
        items: &[SelItem],
        decisions: &[ReductionDecision],
    ) -> std::collections::BTreeMap<String, Vec<u8>> {
        let reductions: HashMap<&str, &str> = decisions
            .iter()
            .map(|decision| (decision.target_id.as_str(), decision.payload.as_str()))
            .collect();
        items
            .iter()
            .map(|item| {
                let bytes = reductions.get(item.id.as_str()).map_or_else(
                    || vec![b'x'; item.byte_size],
                    |payload| payload.as_bytes().to_vec(),
                );
                (item.id.clone(), bytes)
            })
            .collect()
    }

    #[derive(Deserialize)]
    struct ItemJson {
        id: String,
        ordinal: u64,
        kind: serde_json::Value,
        provider_executed: bool,
        byte_size: usize,
        token_count: Option<usize>,
        arc_id: Option<String>,
    }
    #[derive(Deserialize)]
    struct CtxJson {
        pass_class: String,
        current_total_input_tokens: f64,
        ceiling_tokens: f64,
        protected_cutoff_ordinal: u64,
        last_execute_ordinal: u64,
        scheduler_pressure_execute: bool,
        #[serde(default)]
        pass_already_busting: bool,
        prior_input_sample: f64,
        has_prior_drop: bool,
        agent_drop_ids: Vec<String>,
    }
    #[derive(Deserialize)]
    struct GoldenCase {
        label: String,
        items: Vec<ItemJson>,
        ctx: CtxJson,
        smart_drops: bool,
        frozen: Vec<String>,
        expected: std::collections::BTreeMap<String, String>,
    }

    fn parse_kind(v: &serde_json::Value) -> SelKind {
        if let Some(s) = v.as_str() {
            return match s {
                "Reasoning" => SelKind::Reasoning,
                "Text" => SelKind::Text,
                "RedactedReasoning" => SelKind::RedactedReasoning,
                "Media" => SelKind::Media,
                _ => SelKind::Opaque,
            };
        }
        if let Some(obj) = v.as_object() {
            if let Some(tc) = obj.get("ToolCall") {
                return SelKind::ToolCall {
                    name: tc
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string(),
                    input: tc.get("input").cloned().unwrap_or(serde_json::Value::Null),
                };
            }
            if let Some(tr) = obj.get("ToolResult") {
                return SelKind::ToolResult {
                    tool_name: tr
                        .get("tool_name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string(),
                };
            }
        }
        SelKind::Opaque
    }

    #[test]
    fn selection_golden_matches_ts_selectors() {
        let raw = include_str!("../testdata/selection-golden.json");
        let cases: Vec<GoldenCase> =
            serde_json::from_str(raw).expect("parse selection-golden.json");
        assert!(!cases.is_empty(), "empty selection golden");
        let mut seen_reduction_kinds = HashSet::new();
        let mut saw_t1_tool = false;
        let mut saw_t2_tool = false;

        for case in &cases {
            let mut items: Vec<SelItem> = case
                .items
                .iter()
                .map(|i| {
                    let kind = parse_kind(&i.kind);
                    let message_role = if matches!(
                        kind,
                        SelKind::ToolCall { .. } | SelKind::Reasoning | SelKind::RedactedReasoning
                    ) {
                        SelMessageRole::Assistant
                    } else {
                        SelMessageRole::NonAssistant
                    };
                    SelItem {
                        id: i.id.clone(),
                        ordinal: i.ordinal,
                        message_role,
                        kind,
                        provider_executed: i.provider_executed,
                        byte_size: i.byte_size,
                        token_count: i.token_count,
                        arc_id: i.arc_id.clone(),
                    }
                })
                .collect();
            if case.smart_drops {
                let first_padding_ordinal = items
                    .iter()
                    .map(|item| item.ordinal)
                    .max()
                    .unwrap_or(0)
                    .saturating_add(1);
                for n in 0..RECENT_TOOL_SKELETON_WINDOW {
                    items.push(text_with_id(
                        &format!("golden-tail-{n}#0"),
                        first_padding_ordinal + n as u64,
                        1,
                    ));
                }
            }
            let call_ids: HashSet<&str> = items
                .iter()
                .filter(|i| matches!(&i.kind, SelKind::ToolCall { .. }))
                .map(|i| i.id.as_str())
                .collect();
            for item in &items {
                assert!(
                    !item.id.ends_with("#call")
                        && !item.id.ends_with("#result")
                        && !item.id.ends_with("#reasoning"),
                    "golden item '{}' still uses the pre-FlatBlock tool suffix vocabulary",
                    item.id
                );
                if let SelKind::ToolCall { name, .. } = &item.kind {
                    let tier = resolve_tool_tier(name);
                    saw_t1_tool |= tier == 1;
                    saw_t2_tool |= tier == 2;
                }
            }
            for arc in case.expected.keys() {
                assert!(
                    call_ids.contains(arc.as_str()),
                    "case '{}' expected arc '{}' is not the ToolCall FlatBlock id",
                    case.label,
                    arc
                );
            }
            let pass = match case.ctx.pass_class.as_str() {
                "EmergencyForce" => PassClass::EmergencyForce,
                "Defer" => PassClass::Defer,
                _ => PassClass::Execute,
            };
            let ctx = SelectionContext {
                pass_class: pass,
                current_total_input_tokens: case.ctx.current_total_input_tokens,
                ceiling_tokens: case.ctx.ceiling_tokens,
                protected_cutoff_ordinal: case.ctx.protected_cutoff_ordinal,
                last_execute_ordinal: case.ctx.last_execute_ordinal,
                scheduler_pressure_execute: case.ctx.scheduler_pressure_execute,
                prior_input_sample: case.ctx.prior_input_sample,
                has_prior_drop: case.ctx.has_prior_drop,
                agent_drop_ids: case.ctx.agent_drop_ids.clone(),
                agent_drop_command_ids: HashMap::new(),
                first_applied_agent_drop_ids: HashSet::new(),
                pass_already_busting: case.smart_drops || case.ctx.pass_already_busting,
                supersession_ride_available: case.smart_drops || case.ctx.pass_already_busting,
                tag_window_protected_block_ids: HashSet::new(),
                exempt_message_protected_block_ids: HashSet::new(),
            };
            let cfg = SelectionConfig {
                smart_drops: case.smart_drops,
            };
            let frozen: HashSet<String> = case.frozen.iter().cloned().collect();
            let out = select_reductions(&items, &frozen, &ctx, &cfg);
            seen_reduction_kinds.extend(out.iter().map(|d| d.kind.clone()));
            let got = arc_decisions(&items, &out);
            assert_eq!(
                got, case.expected,
                "arc-decision mismatch in case '{}'",
                case.label
            );
        }

        for kind in ["drop", "skeleton", "edit_marker"] {
            assert!(
                seen_reduction_kinds.contains(kind),
                "selection golden stopped exercising reduction kind '{kind}'"
            );
        }
        assert!(saw_t1_tool, "selection golden stopped exercising T1 tools");
        assert!(saw_t2_tool, "selection golden stopped exercising T2 tools");
    }

    #[test]
    fn age_reclaim_requires_both_scheduler_pressure_and_a_ride() {
        let mut result = tool_result("c1", 1, "bash", 2_000);
        result.token_count = Some(300);
        let items = vec![
            tool_call("c1", 1, "bash", serde_json::json!({}), 50),
            result,
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 1;

        let level_only = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert!(level_only.decisions.is_empty());
        assert!(!level_only.two_pass_batch_can_apply);

        ctx.pass_already_busting = true;
        ctx.scheduler_pressure_execute = false;
        let ride_only = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert!(ride_only.decisions.is_empty());
        assert!(!ride_only.two_pass_batch_can_apply);

        ctx.scheduler_pressure_execute = true;
        let admitted = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert_eq!(admitted.decisions.len(), 2);
        assert!(admitted.two_pass_batch_can_apply);
    }

    #[test]
    fn supersession_measurements_distinguish_protection_sources_and_final_application() {
        let mut items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
            tool_call(
                "c2",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"two"}),
                500,
            ),
            tool_result("c2", 2, "edit", 100),
            tool_call(
                "c3",
                3,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"three"}),
                500,
            ),
            tool_result("c3", 3, "edit", 100),
        ];
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 4 + n as u64, 1));
        }
        let config = SelectionConfig { smart_drops: true };
        let mut protected = base_ctx(PassClass::Execute);
        protected.supersession_ride_available = true;
        protected
            .tag_window_protected_block_ids
            .extend([call_block_id("c1"), result_block_id("c1")]);
        protected
            .exempt_message_protected_block_ids
            .extend([call_block_id("c2"), result_block_id("c2")]);

        let withheld = select_reductions_with_outcome(&items, &HashSet::new(), &protected, &config);
        assert_eq!(withheld.eligible_supersession_count, Some(2));
        assert_eq!(withheld.supersession_withheld_by_tag_window_count, Some(1));
        assert_eq!(
            withheld.supersession_withheld_by_exempt_message_count,
            Some(1)
        );
        assert_eq!(withheld.applied_supersession_count, Some(0));
        assert!(withheld.decisions.is_empty());

        let mut tag_only = base_ctx(PassClass::Execute);
        tag_only.supersession_ride_available = true;
        tag_only
            .tag_window_protected_block_ids
            .extend([call_block_id("c1"), result_block_id("c1")]);
        let partially_withheld =
            select_reductions_with_outcome(&items, &HashSet::new(), &tag_only, &config);
        assert_eq!(
            partially_withheld.supersession_withheld_by_tag_window_count,
            Some(1)
        );
        assert_eq!(
            partially_withheld.supersession_withheld_by_exempt_message_count,
            Some(0)
        );
        assert_eq!(partially_withheld.applied_supersession_count, Some(1));

        let mut unprotected = base_ctx(PassClass::Execute);
        unprotected.supersession_ride_available = true;
        let applied =
            select_reductions_with_outcome(&items, &HashSet::new(), &unprotected, &config);
        assert_eq!(applied.eligible_supersession_count, Some(2));
        assert_eq!(applied.supersession_withheld_by_tag_window_count, Some(0));
        assert_eq!(
            applied.supersession_withheld_by_exempt_message_count,
            Some(0)
        );
        assert_eq!(applied.applied_supersession_count, Some(2));
    }

    #[test]
    fn force_band_applies_waiting_two_pass_batch_without_a_ride() {
        let mut result = tool_result("c1", 1, "read", 2_000);
        result.token_count = Some(300);
        let items = vec![
            tool_call("c1", 1, "read", serde_json::json!({"path":"a.txt"}), 50),
            result,
        ];
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.last_execute_ordinal = 1;
        ctx.scheduler_pressure_execute = true;
        assert!(!ctx.pass_already_busting);

        let admitted = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert_eq!(admitted.decisions.len(), 2);
        assert!(admitted.two_pass_batch_can_apply);
    }

    #[test]
    fn force_band_two_pass_batch_carries_pending_supersession() {
        let mut aged_result = tool_result("aged", 1, "read", 2_000);
        aged_result.token_count = Some(300);
        let mut items = vec![
            tool_call("aged", 1, "read", serde_json::json!({"path":"old.txt"}), 50),
            aged_result,
            tool_call(
                "c1",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 2, "edit", 100),
            tool_call(
                "c2",
                3,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"two"}),
                500,
            ),
            tool_result("c2", 3, "edit", 100),
        ];
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 4 + n as u64, 1));
        }

        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.last_execute_ordinal = 1;
        ctx.scheduler_pressure_execute = true;
        ctx.current_total_input_tokens = 90_000.0;
        ctx.ceiling_tokens = 100_000.0;
        ctx.pass_already_busting = true;
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );

        assert_eq!(out.len(), 4);
        assert!(out.iter().any(|decision| decision.target_id == "aged#0"));
        assert!(out
            .iter()
            .any(|decision| { decision.target_id == "c1#0" && decision.kind == "edit_marker" }));
        assert!(out
            .iter()
            .all(|decision| !decision.target_id.starts_with("c2#")));
    }

    #[test]
    fn emergency_floor_counts_non_tool_live_text_and_reasoning() {
        let mut items = Vec::new();
        for index in 0..6 {
            let mid = format!("emergency-{index}");
            items.push(tool_call(
                &mid,
                index + 1,
                "bash",
                serde_json::json!({}),
                20_000,
            ));
            items.push(tool_result(&mid, index + 1, "bash", 20_000));
        }
        items.push(text_with_id("heavy-text#0", 7, 30_000));
        items.push(SelItem {
            id: "heavy-reasoning#0".to_string(),
            ordinal: 8,
            message_role: SelMessageRole::Assistant,
            kind: SelKind::Reasoning,
            provider_executed: false,
            byte_size: 10_000,
            token_count: None,
            arc_id: None,
        });
        items.push(SelItem {
            id: "irreducible-system#0".to_string(),
            ordinal: 9,
            message_role: SelMessageRole::System,
            kind: SelKind::Text,
            provider_executed: false,
            byte_size: 40_000,
            token_count: None,
            arc_id: None,
        });

        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 90_000.0;
        ctx.ceiling_tokens = 100_000.0;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());

        assert_eq!(
            arc_decisions(&items, &out).len(),
            5,
            "the true live-tail floor includes active text/reasoning but not the system prefix: {out:?}"
        );
    }

    #[test]
    fn emergency_reclaim_does_not_count_retained_reasoning() {
        let mut items = Vec::new();
        for index in 0..4 {
            let mid = format!("reasoned-{index}");
            let ordinal = index + 1;
            items.push(reasoning(&mid, ordinal, 32_000));
            items.push(tool_call(
                &mid,
                ordinal,
                "bash",
                serde_json::json!({}),
                4_000,
            ));
            items.push(SelItem {
                id: format!("{mid}#3"),
                ordinal,
                message_role: SelMessageRole::Assistant,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 1,
                token_count: None,
                arc_id: None,
            });
            items.push(tool_result(&mid, ordinal, "bash", 4_000));
        }

        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 90_000.0;
        ctx.ceiling_tokens = 100_000.0;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());

        assert_eq!(
            arc_decisions(&items, &out).len(),
            4,
            "reasoning stays on wire, so every available call/result arc is needed: {out:?}"
        );
    }

    #[test]
    fn emergency_eviction_carries_pending_supersession() {
        let mut items = vec![
            tool_call("emergency", 1, "bash", serde_json::json!({}), 160_000),
            tool_result("emergency", 1, "bash", 40_000),
            tool_call(
                "c1",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 2, "edit", 100),
            tool_call(
                "c2",
                3,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"two"}),
                500,
            ),
            tool_result("c2", 3, "edit", 100),
        ];
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 4 + n as u64, 1));
        }

        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 90_000.0;
        ctx.ceiling_tokens = 100_000.0;
        ctx.pass_already_busting = true;
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );

        assert_eq!(out.len(), 4);
        assert!(out
            .iter()
            .any(|decision| decision.target_id == "emergency#0"));
        assert!(out
            .iter()
            .any(|decision| { decision.target_id == "c1#0" && decision.kind == "edit_marker" }));
        assert!(out
            .iter()
            .all(|decision| !decision.target_id.starts_with("c2#")));
    }

    #[test]
    fn sustained_execute_band_accumulates_supersession_without_trickling() {
        const PASSES: u64 = 3;

        let mut items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
        ];
        let cfg = SelectionConfig { smart_drops: true };
        let mut next_ordinal = 2;

        for pass in 1..=PASSES {
            let edit_number = pass + 1;
            items.push(tool_call(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":format!("edit-{edit_number}")}),
                500,
            ));
            items.push(tool_result(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                100,
            ));
            next_ordinal += 1;
            for message in 0..RECENT_TOOL_SKELETON_WINDOW {
                items.push(text_with_id(
                    &format!("pass-{pass}-tail-{message}#0"),
                    next_ordinal,
                    1,
                ));
                next_ordinal += 1;
            }

            let mut ctx = base_ctx(PassClass::Execute);
            ctx.scheduler_pressure_execute = true;
            assert!(
                select_reductions(&items, &HashSet::new(), &ctx, &cfg).is_empty(),
                "66% execute-band pressure must not admit pass {pass} supersession"
            );

            ctx.pass_already_busting = true;
            ctx.supersession_ride_available = true;
            assert_eq!(
                select_reductions(&items, &HashSet::new(), &ctx, &cfg).len(),
                pass as usize * 2,
                "the pending superseded members must accumulate as a single batch"
            );
        }
    }

    #[test]
    fn independent_bust_applies_the_whole_aged_supersession_batch() {
        let mut items = Vec::new();
        for n in 1..=4u64 {
            items.push(tool_call(
                &format!("c{n}"),
                n,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":format!("edit-{n}")}),
                500,
            ));
            items.push(tool_result(&format!("c{n}"), n, "edit", 100));
        }
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 5 + n as u64, 1));
        }

        let mut ctx = base_ctx(PassClass::Execute);
        ctx.scheduler_pressure_execute = true;
        ctx.pass_already_busting = true;
        ctx.supersession_ride_available = true;
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );
        assert_eq!(out.len(), 6, "all three superseded arcs must ride together");
        assert_eq!(
            out.iter()
                .filter(|decision| decision.kind == "edit_marker")
                .count(),
            3,
            "each superseded call becomes an edit marker"
        );
        assert!(out
            .iter()
            .all(|decision| !decision.target_id.starts_with("c4#")));
    }

    #[test]
    fn idle_force_band_defers_aged_supersession_without_changing_served_bytes() {
        let mut items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
            tool_call(
                "c2",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"two"}),
                500,
            ),
            tool_result("c2", 2, "edit", 100),
        ];
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 3 + n as u64, 1));
        }

        let cfg = SelectionConfig { smart_drops: true };
        let previous =
            select_reductions(&items, &HashSet::new(), &base_ctx(PassClass::Execute), &cfg);
        assert!(previous.is_empty());
        let previous_served = served_block_bytes(&items, &previous);

        let mut emergency_ctx = base_ctx(PassClass::EmergencyForce);
        emergency_ctx.current_total_input_tokens = 90_000.0;
        emergency_ctx.ceiling_tokens = 100_000.0;
        emergency_ctx.pass_already_busting = true;
        let emergency = select_reductions(&items, &HashSet::new(), &emergency_ctx, &cfg);

        assert!(
            emergency.is_empty(),
            "an idle force band cannot create a bust"
        );
        assert_eq!(served_block_bytes(&items, &emergency), previous_served);
    }

    #[test]
    fn sustained_idle_force_band_batches_supersession_until_a_real_bust() {
        const IDLE_PASSES: u64 = 3;

        let mut items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
        ];
        let cfg = SelectionConfig { smart_drops: true };
        let mut next_ordinal = 2;
        let mut self_caused_busts = 0;

        for pass in 1..=IDLE_PASSES {
            let edit_number = pass + 1;
            items.push(tool_call(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":format!("edit-{edit_number}")}),
                500,
            ));
            items.push(tool_result(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                100,
            ));
            next_ordinal += 1;
            for message in 0..RECENT_TOOL_SKELETON_WINDOW {
                items.push(text_with_id(
                    &format!("pass-{pass}-tail-{message}#0"),
                    next_ordinal,
                    1,
                ));
                next_ordinal += 1;
            }

            let mut ctx = base_ctx(PassClass::EmergencyForce);
            ctx.current_total_input_tokens = 90_000.0;
            ctx.ceiling_tokens = 100_000.0;
            ctx.pass_already_busting = true;
            if !select_reductions(&items, &HashSet::new(), &ctx, &cfg).is_empty() {
                self_caused_busts += 1;
            }
        }

        assert_eq!(self_caused_busts, 0, "idle force passes must not trickle");

        items.push(tool_call(
            "emergency",
            next_ordinal,
            "bash",
            serde_json::json!({}),
            160_000,
        ));
        items.push(tool_result("emergency", next_ordinal, "bash", 40_000));
        let mut bust_ctx = base_ctx(PassClass::EmergencyForce);
        bust_ctx.current_total_input_tokens = 90_000.0;
        bust_ctx.ceiling_tokens = 100_000.0;
        bust_ctx.pass_already_busting = true;
        let bust = select_reductions(&items, &HashSet::new(), &bust_ctx, &cfg);
        let markers: HashSet<&str> = bust
            .iter()
            .filter(|decision| decision.kind == "edit_marker")
            .map(|decision| decision.target_id.as_str())
            .collect();

        assert_eq!(
            markers,
            HashSet::from(["c1#0", "c2#0", "c3#0"]),
            "the first real emergency eviction must carry the whole pending batch"
        );
        assert!(bust
            .iter()
            .any(|decision| decision.target_id == "emergency#0"));
        assert!(bust
            .iter()
            .all(|decision| !decision.target_id.starts_with("c4#")));
    }

    #[test]
    fn latched_force_below_band_preserves_served_bytes_while_supersession_accumulates() {
        const LATCHED_PASSES: u64 = 3;

        let mut items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
        ];
        let cfg = SelectionConfig { smart_drops: true };
        let mut previous_served = served_block_bytes(&items, &[]);
        let mut next_ordinal = 2;
        let mut applied_reclaims = 0;

        for pass in 1..=LATCHED_PASSES {
            let edit_number = pass + 1;
            items.push(tool_call(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":format!("edit-{edit_number}")}),
                500,
            ));
            items.push(tool_result(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                100,
            ));
            next_ordinal += 1;
            for message in 0..RECENT_TOOL_SKELETON_WINDOW {
                items.push(text_with_id(
                    &format!("latched-{pass}-tail-{message}#0"),
                    next_ordinal,
                    1,
                ));
                next_ordinal += 1;
            }

            let mut ctx = base_ctx(PassClass::EmergencyForce);
            ctx.current_total_input_tokens = 70_000.0;
            ctx.ceiling_tokens = 100_000.0;
            ctx.pass_already_busting = true;
            let reductions = select_reductions(&items, &HashSet::new(), &ctx, &cfg);
            applied_reclaims += usize::from(!reductions.is_empty());
            let served = served_block_bytes(&items, &reductions);
            for (id, previous_bytes) in &previous_served {
                assert_eq!(
                    served.get(id),
                    Some(previous_bytes),
                    "latched pass {pass} changed previously served block {id}"
                );
            }
            previous_served = served;
        }

        assert_eq!(
            applied_reclaims, 0,
            "an armed but idle emergency latch must not authorize supersession"
        );
    }

    #[test]
    fn supersession_floor_tracks_active_tag_window_on_thirty_arc_fixture() {
        let mut items = Vec::new();
        for n in 1..=30u64 {
            let call_id = format!("c{n}");
            items.push(tool_call(
                &call_id,
                n,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":format!("edit-{n}")}),
                500,
            ));
            items.push(tool_result(&call_id, n, "edit", 100));
        }

        let mut ctx = base_ctx(PassClass::Execute);
        ctx.pass_already_busting = true;
        ctx.supersession_ride_available = true;
        //
        // The owner-message K=20 floor admits c1..c10 and retains c11..c30.
        // The active odd-tool-tag floor admits c2,c4,..,c28 and retains c1,c3,..,c29 plus c30.
        //
        // Protecting a tagged result block must retain its complete arc.
        for n in (1..30u64).step_by(2) {
            ctx.tag_window_protected_block_ids
                .insert(result_block_id(&format!("c{n}")));
        }

        let decisions = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );
        let admitted = decisions
            .iter()
            .filter_map(|decision| decision.target_id.split('#').next())
            .map(str::to_string)
            .collect::<HashSet<_>>();
        let expected = (2..30u64)
            .step_by(2)
            .map(|n| format!("c{n}"))
            .collect::<HashSet<_>>();

        assert_eq!(admitted, expected);
        assert_eq!(decisions.len(), expected.len() * 2);
    }

    #[test]
    fn edit_marker_region_hint_caps_utf16_and_backs_off_split_surrogate() {
        let split_astral = format!("{}😀tail", "a".repeat(39));
        assert_eq!(
            region_hint(&split_astral),
            format!("{}{}", "a".repeat(39), TRUNCATION_SENTINEL)
        );

        let complete_astral = format!("{}😀tail", "a".repeat(38));
        assert_eq!(
            region_hint(&complete_astral),
            format!("{}😀{}", "a".repeat(38), TRUNCATION_SENTINEL)
        );
    }

    #[test]
    fn provider_executed_arc_never_targeted() {
        // A server-side tool arc must be skipped even under the two-pass watermark.
        let mut items = vec![
            tool_call("c1", 1, "bash", serde_json::json!({}), 200),
            tool_result("c1", 1, "bash", 200),
            tool_call("c2", 2, "web_search", serde_json::json!({}), 200),
            tool_result("c2", 2, "web_search", 200),
        ];
        let c2_arc = call_block_id("c2");
        for it in items.iter_mut() {
            if it.arc_id.as_deref() == Some(c2_arc.as_str()) {
                it.provider_executed = true;
            }
        }
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 2; // both arcs at/under watermark
        ctx.pass_already_busting = true;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        let arcs = arc_decisions(&items, &out);
        assert_eq!(
            arcs.get(&call_block_id("c1")).map(String::as_str),
            Some("drop")
        );
        assert!(
            !arcs.contains_key(&c2_arc),
            "provider_executed arc must be skipped"
        );
    }

    #[test]
    fn frozen_arc_blocks_never_re_emitted() {
        // c1's result already frozen → the arc is inactive; no decision for ANY c1 block.
        let items = vec![
            tool_call("c1", 1, "bash", serde_json::json!({}), 200),
            tool_result("c1", 1, "bash", 200),
            tool_call("c2", 2, "bash", serde_json::json!({}), 200),
            tool_result("c2", 2, "bash", 200),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 2;
        ctx.pass_already_busting = true;
        let frozen: HashSet<String> = [result_block_id("c1")].into_iter().collect();
        let out = select_reductions(&items, &frozen, &ctx, &SelectionConfig::default());
        assert!(
            out.iter().all(|d| !d.target_id.starts_with("c1")),
            "no c1 block may be re-emitted once the arc is frozen: {out:?}"
        );
        assert!(
            out.iter().any(|d| d.target_id.starts_with("c2")),
            "c2 should still reduce"
        );
    }

    #[test]
    fn dynamic_block_protection_filters_automatic_and_agent_drop_decisions() {
        let items = vec![
            tool_call("c1", 1, "bash", serde_json::json!({}), 200),
            tool_result("c1", 1, "bash", 200),
            tool_call("c2", 2, "bash", serde_json::json!({}), 200),
            tool_result("c2", 2, "bash", 200),
        ];
        let protected = result_block_id("c1");
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 2;
        ctx.pass_already_busting = true;
        ctx.agent_drop_ids = vec![protected.clone()];
        ctx.tag_window_protected_block_ids.insert(protected.clone());

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(out.iter().all(|decision| decision.target_id != protected));
        assert!(
            out.iter()
                .any(|decision| decision.target_id == result_block_id("c2")),
            "the unprotected automatic candidate must still be selected"
        );
    }

    #[test]
    fn reasoning_only_assistant_makes_the_whole_tool_arc_ineligible() {
        let target_arc = "assistant#1";
        let mut items = vec![
            reasoning_with_id("assistant#0", target_arc, 1, 100),
            tool_call_with_ids(
                target_arc,
                target_arc,
                1,
                "aft_outline",
                serde_json::json!({"target": ["src/model.rs"]}),
                50,
            ),
            tool_result_with_ids("tool-result#0", target_arc, 2, "aft_outline", 300),
        ];
        // The target arc lies outside the newest-20 skeleton window; the whole-message guard retains both tool carriers.
        for ordinal in 3..=22 {
            let arc = format!("new-{ordinal}#0");
            items.push(tool_call_with_ids(
                &arc,
                &arc,
                ordinal,
                "bash",
                serde_json::json!({}),
                50,
            ));
            items.push(tool_result_with_ids(
                &format!("new-result-{ordinal}#0"),
                &arc,
                ordinal,
                "bash",
                300,
            ));
        }
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 22;
        ctx.pass_already_busting = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(
            out.iter().all(|decision| {
                decision.target_id != target_arc && decision.target_id != "tool-result#0"
            }),
            "reasoning-bearing arc must remain byte-complete: {out:?}"
        );
        assert!(
            out.iter()
                .all(|decision| decision.target_id != "assistant#0"),
            "reasoning itself must never become a reduction target: {out:?}"
        );
        assert!(
            !out.is_empty(),
            "unrelated age-reclaim candidates must still reduce"
        );
    }

    #[test]
    fn reasoning_with_a_durable_text_sibling_reclaims_via_separator_skeleton() {
        let target_arc = "assistant#1";
        let mut items = vec![
            reasoning_with_id("assistant#0", target_arc, 1, 100),
            tool_call_with_ids(
                target_arc,
                target_arc,
                1,
                "aft_outline",
                serde_json::json!({"target": ["src/model.rs"]}),
                50,
            ),
            text_with_id("assistant#2", 1, 20),
            tool_result_with_ids("tool-result#0", target_arc, 2, "aft_outline", 300),
        ];
        for ordinal in 3..=22 {
            let arc = format!("new-{ordinal}#0");
            items.push(tool_call_with_ids(
                &arc,
                &arc,
                ordinal,
                "bash",
                serde_json::json!({}),
                50,
            ));
            items.push(tool_result_with_ids(
                &format!("new-result-{ordinal}#0"),
                &arc,
                ordinal,
                "bash",
                300,
            ));
        }
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 22;
        ctx.pass_already_busting = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(
            out.iter().any(|decision| {
                decision.target_id == target_arc && decision.kind == "skeleton"
            }),
            "the durable text sibling keeps the arc reclaimable while its result separates reasoning-bearing assistants: {out:?}"
        );
        assert!(
            out.iter().any(|decision| {
                decision.target_id == "tool-result#0" && decision.kind == "drop"
            }),
            "skeleton mode must reclaim the result payload through the existing drop placeholder: {out:?}"
        );
    }

    #[test]
    fn age_eligible_reasoning_block_never_becomes_a_reduction_target() {
        // Historical reasoning cleanup bypasses frozen_keys and applies to whole blocks.
        // ReductionDecision targets must never include signed reasoning.
        let items = vec![
            reasoning("c1", 1, 100),
            tool_call("c1", 1, "bash", serde_json::json!({}), 50),
            tool_result("c1", 1, "bash", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 100;
        ctx.scheduler_pressure_execute = true;
        ctx.pass_already_busting = true;
        ctx.agent_drop_ids = vec![reasoning_block_id("c1")];
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(
            out.iter().all(|d| d.target_id != reasoning_block_id("c1")),
            "{out:?}"
        );
    }

    #[test]
    fn reused_provider_call_id_does_not_merge_cross_turn_arcs() {
        // ToolCall FlatBlock ids are session-injective, so repeated provider call IDs reduce as independent arcs.
        let items = vec![
            tool_call_with_ids(
                "turn1#0",
                "turn1#0",
                1,
                "bash",
                serde_json::json!({"provider_call_id":"call_0"}),
                50,
            ),
            tool_result_with_ids("turn1-tool#0", "turn1#0", 1, "bash", 300),
            tool_call_with_ids(
                "turn2#0",
                "turn2#0",
                2,
                "bash",
                serde_json::json!({"provider_call_id":"call_0"}),
                50,
            ),
            tool_result_with_ids("turn2-tool#0", "turn2#0", 2, "bash", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 2;
        ctx.pass_already_busting = true;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        let arcs = arc_decisions(&items, &out);
        assert_eq!(arcs.get("turn1#0").map(String::as_str), Some("drop"));
        assert_eq!(arcs.get("turn2#0").map(String::as_str), Some("drop"));

        let ids: HashSet<&str> = out.iter().map(|d| d.target_id.as_str()).collect();
        assert!(
            ids.contains("turn1#0") && ids.contains("turn1-tool#0"),
            "{ids:?}"
        );
        assert!(
            ids.contains("turn2#0") && ids.contains("turn2-tool#0"),
            "{ids:?}"
        );
    }

    #[test]
    fn skeleton_window_keeps_call_shell_older_full_drops() {
        let mut items = Vec::new();
        for n in 1..=22u64 {
            items.push(tool_call(
                &format!("c{n}"),
                n,
                "bash",
                serde_json::json!({"cmd": "x".repeat(20)}),
                50,
            ));
            items.push(tool_result(&format!("c{n}"), n, "bash", 200));
        }
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 22; // all arcs are drop candidates
        ctx.pass_already_busting = true;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        let call_kind = |arc: &str| -> String {
            out.iter()
                .find(|d| d.target_id == call_block_id(arc))
                .map(|d| d.kind.clone())
                .unwrap_or_default()
        };
        assert_eq!(call_kind("c1"), "drop", "oldest arc full-drops the call");
        assert_eq!(call_kind("c2"), "drop", "2nd oldest full-drops");
        assert_eq!(call_kind("c22"), "skeleton", "newest keeps a skeleton call");
        assert_eq!(call_kind("c3"), "skeleton", "inside the window → skeleton");
    }

    #[test]
    fn drop_wins_over_edit_marker() {
        // c1 is both an edit_marker candidate and a two-pass drop candidate; drop must win.
        let items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"x".repeat(80)}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
            tool_call(
                "c2",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"y".repeat(80)}),
                500,
            ),
            tool_result("c2", 2, "edit", 100),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 1; // c1 under watermark → two-pass drop
        ctx.pass_already_busting = true;
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );
        let c1_call = out
            .iter()
            .find(|d| d.target_id == call_block_id("c1"))
            .map(|d| d.kind.clone());
        // A drop-path arc emits "skeleton" in the skeleton window and "drop" otherwise; it never emits "edit_marker".
        assert!(
            matches!(c1_call.as_deref(), Some("drop") | Some("skeleton")),
            "drop beats edit_marker for c1 (got {c1_call:?})"
        );
        assert_ne!(
            c1_call.as_deref(),
            Some("edit_marker"),
            "edit_marker must NOT win"
        );
    }

    #[test]
    fn payload_purity_independent_of_pressure() {
        // The payload depends only on id and immutable block bytes.
        //
        // c1 and c2 are edit_marker candidates because c3 is the newest edit to a.ts.
        // last_execute_ordinal remains 0, so c1 cannot become a two-pass FullDrop.
        let mut items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"z".repeat(80)}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
            tool_call(
                "c2",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"w".repeat(80)}),
                500,
            ),
            tool_result("c2", 2, "edit", 100),
            tool_call(
                "c3",
                3,
                "edit",
                serde_json::json!({"filePath":"a.ts","content":"q".repeat(80)}),
                500,
            ),
            tool_result("c3", 3, "edit", 100),
            tool_call("c9", 9, "read", serde_json::json!({}), 50),
            tool_result("c9", 9, "read", 300),
        ];
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 10 + n as u64, 1));
        }
        let c1_marker_payload = |ctx: &SelectionContext| -> Option<String> {
            let out = select_reductions(
                &items,
                &HashSet::new(),
                ctx,
                &SelectionConfig { smart_drops: true },
            );
            out.iter()
                .find(|d| d.target_id == call_block_id("c1") && d.kind == "edit_marker")
                .map(|d| d.payload.clone())
        };

        let mut ctx_a = base_ctx(PassClass::Execute);
        ctx_a.pass_already_busting = true;
        ctx_a.supersession_ride_available = true;
        // Context B drops unrelated c9 through agent_drop_ids.
        let ctx_b = SelectionContext {
            agent_drop_ids: vec![result_block_id("c9")],
            current_total_input_tokens: 123_456.0,
            ceiling_tokens: 200_000.0,
            protected_cutoff_ordinal: 2,
            prior_input_sample: 99_000.0,
            has_prior_drop: true,
            pass_already_busting: true,
            supersession_ride_available: true,
            ..base_ctx(PassClass::Execute)
        };

        // c9's agent drop makes the reduction sets differ.
        let set_a = select_reductions(
            &items,
            &HashSet::new(),
            &ctx_a,
            &SelectionConfig { smart_drops: true },
        );
        let set_b = select_reductions(
            &items,
            &HashSet::new(),
            &ctx_b,
            &SelectionConfig { smart_drops: true },
        );
        assert!(
            !set_a.iter().any(|d| d.target_id == result_block_id("c9")),
            "context A must NOT drop c9"
        );
        assert!(
            set_b.iter().any(|d| d.target_id == result_block_id("c9")),
            "context B MUST drop c9 (the sets genuinely differ)"
        );

        let pa = c1_marker_payload(&ctx_a);
        let pb = c1_marker_payload(&ctx_b);
        assert!(pa.is_some(), "c1 must be an edit_marker in context A");
        assert!(pb.is_some(), "c1 must be an edit_marker in context B");
        assert_eq!(
            pa, pb,
            "edit_marker payload must NOT vary with the differing context"
        );
        // The c1 edit_marker payload equals the pure function's output for c1's immutable input bytes.
        assert_eq!(
            pa.as_deref(),
            Some(
                edit_marker_payload(
                    &serde_json::json!({"filePath":"a.ts","oldString":"z".repeat(80)})
                )
                .as_str()
            ),
            "payload must be exactly the pure fn of the block's input bytes"
        );
    }

    #[test]
    fn agent_drop_ids_reduce_directly() {
        let items = vec![
            tool_call("c1", 1, "read", serde_json::json!({}), 50),
            tool_result("c1", 1, "read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec![result_block_id("c1")];
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(out
            .iter()
            .any(|d| d.target_id == result_block_id("c1") && d.kind == "drop"));
    }

    #[test]
    fn held_agent_drop_never_trickles_when_the_window_slides() {
        let items = vec![SelItem {
            id: "held#0".to_string(),
            ordinal: 1,
            message_role: SelMessageRole::NonAssistant,
            kind: SelKind::Text,
            provider_executed: false,
            byte_size: 100,
            token_count: None,
            arc_id: None,
        }];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec!["held#0".to_string()];
        ctx.agent_drop_command_ids
            .insert("held#0".to_string(), "command-a".to_string());
        ctx.first_applied_agent_drop_ids
            .insert("held#0".to_string());
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(
            out.is_empty(),
            "a held row cannot create a stable-pass bust"
        );
    }

    #[test]
    fn different_command_first_application_is_a_single_ride_opportunity() {
        let items = vec![
            SelItem {
                id: "held#0".to_string(),
                ordinal: 1,
                message_role: SelMessageRole::NonAssistant,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 100,
                token_count: None,
                arc_id: None,
            },
            SelItem {
                id: "new#0".to_string(),
                ordinal: 2,
                message_role: SelMessageRole::NonAssistant,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 100,
                token_count: None,
                arc_id: None,
            },
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec!["held#0".to_string(), "new#0".to_string()];
        ctx.agent_drop_command_ids
            .insert("held#0".to_string(), "command-a".to_string());
        ctx.agent_drop_command_ids
            .insert("new#0".to_string(), "command-b".to_string());
        ctx.first_applied_agent_drop_ids
            .insert("held#0".to_string());
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert_eq!(
            out.iter()
                .map(|decision| decision.target_id.as_str())
                .collect::<Vec<_>>(),
            vec!["held#0", "new#0"]
        );
    }

    #[test]
    fn pass_through_carriers_are_never_reduction_targets() {
        let items = [SelKind::Media, SelKind::Opaque]
            .into_iter()
            .enumerate()
            .map(|(index, kind)| SelItem {
                id: format!("carrier#{index}"),
                ordinal: 1,
                message_role: SelMessageRole::NonAssistant,
                kind,
                provider_executed: false,
                byte_size: 100,
                token_count: None,
                arc_id: None,
            })
            .collect::<Vec<_>>();
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = items.iter().map(|item| item.id.clone()).collect();
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(out.is_empty());
    }

    #[test]
    fn duplicate_safe_tools_keep_the_newest_same_owner_full_drop() {
        let args = serde_json::json!({"line": 7, "path": "src/lib.rs"});
        let items = vec![
            tool_call_with_ids("owner#0", "owner#0", 1, "mcp_read", args.clone(), 50),
            tool_result_with_ids("older-result#0", "owner#0", 2, "mcp_read", 300),
            tool_call_with_ids(
                "owner#1",
                "owner#1",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs", "line": 7}),
                50,
            ),
            tool_result_with_ids("newer-result#0", "owner#1", 3, "mcp_read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert_eq!(
            out.iter()
                .map(|decision| (decision.target_id.as_str(), decision.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![("older-result#0", "drop"), ("owner#0", "drop")],
            "the older safe duplicate must fully drop while the newest call stays live: {out:?}"
        );
    }

    #[test]
    fn duplicate_safe_tools_never_merge_across_owner_messages() {
        let args = serde_json::json!({"path": "src/lib.rs"});
        let items = vec![
            tool_call_with_ids("owner-a#0", "owner-a#0", 1, "mcp_read", args.clone(), 50),
            tool_result_with_ids("result-a#0", "owner-a#0", 2, "mcp_read", 300),
            tool_call_with_ids("owner-b#0", "owner-b#0", 3, "mcp_read", args, 50),
            tool_result_with_ids("result-b#0", "owner-b#0", 4, "mcp_read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(
            out.is_empty(),
            "identical calls from distinct assistant owners are distinct invocations: {out:?}"
        );
    }

    #[test]
    fn duplicate_non_safe_tools_never_deduplicate() {
        let args = serde_json::json!({"path": "src/lib.rs"});
        let items = vec![
            tool_call_with_ids("owner#0", "owner#0", 1, "read", args.clone(), 50),
            tool_result_with_ids("older-result#0", "owner#0", 2, "read", 300),
            tool_call_with_ids("owner#1", "owner#1", 1, "read", args, 50),
            tool_result_with_ids("newer-result#0", "owner#1", 3, "read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(out.is_empty(), "non-safe tools must stay live: {out:?}");
    }

    #[test]
    fn duplicate_safe_tools_skip_protected_and_open_arcs() {
        let protected_items = vec![
            tool_call_with_ids(
                "protected-owner#0",
                "protected-owner#0",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
            tool_result_with_ids(
                "protected-old-result#0",
                "protected-owner#0",
                1,
                "mcp_read",
                300,
            ),
            tool_call_with_ids(
                "protected-owner#1",
                "protected-owner#1",
                2,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
            tool_result_with_ids(
                "protected-new-result#0",
                "protected-owner#1",
                2,
                "mcp_read",
                300,
            ),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;
        ctx.protected_cutoff_ordinal = 1;
        assert!(
            select_reductions(
                &protected_items,
                &HashSet::new(),
                &ctx,
                &SelectionConfig::default(),
            )
            .is_empty(),
            "a protected newest duplicate must not let the older candidate deduplicate"
        );

        let open_items = vec![
            tool_call_with_ids(
                "open-owner#0",
                "open-owner#0",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
            tool_call_with_ids(
                "open-owner#1",
                "open-owner#1",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
        ];
        ctx.protected_cutoff_ordinal = 0;
        assert!(
            select_reductions(
                &open_items,
                &HashSet::new(),
                &ctx,
                &SelectionConfig::default()
            )
            .is_empty(),
            "open tool arcs never participate in duplicate selection"
        );
    }

    #[test]
    fn duplicate_safe_tools_run_on_execute_but_not_defer_passes() {
        let items = vec![
            tool_call_with_ids(
                "owner#0",
                "owner#0",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
            tool_result_with_ids("older-result#0", "owner#0", 2, "mcp_read", 300),
            tool_call_with_ids(
                "owner#1",
                "owner#1",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
            tool_result_with_ids("newer-result#0", "owner#1", 3, "mcp_read", 300),
        ];
        let execute = base_ctx(PassClass::Execute);
        let selected = select_reductions(
            &items,
            &HashSet::new(),
            &execute,
            &SelectionConfig::default(),
        );
        assert_eq!(selected.len(), 2);
        assert!(selected
            .iter()
            .any(|decision| decision.target_id == "owner#0"));
        assert!(selected
            .iter()
            .any(|decision| decision.target_id == "older-result#0"));

        let deferred = base_ctx(PassClass::Defer);
        assert!(
            select_reductions(
                &items,
                &HashSet::new(),
                &deferred,
                &SelectionConfig::default(),
            )
            .is_empty(),
            "defer replays frozen reductions and never first-applies deduplication"
        );
    }

    #[test]
    fn duplicate_full_drop_skeletonizes_for_reasoning_adjacency() {
        let args = serde_json::json!({"path": "src/lib.rs"});
        let items = vec![
            reasoning_with_id("left#0", "left#2", 1, 50),
            SelItem {
                id: "left#1".to_string(),
                ordinal: 1,
                message_role: SelMessageRole::Assistant,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 50,
                token_count: None,
                arc_id: None,
            },
            tool_call_with_ids("left#2", "left#2", 1, "mcp_read", args.clone(), 50),
            tool_call_with_ids("left#3", "left#3", 1, "mcp_read", args, 50),
            tool_result_with_ids("older-result#0", "left#2", 2, "mcp_read", 300),
            SelItem {
                id: "right#0".to_string(),
                ordinal: 3,
                message_role: SelMessageRole::Assistant,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 50,
                token_count: None,
                arc_id: None,
            },
            tool_result_with_ids("newer-result#0", "left#3", 4, "mcp_read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert_eq!(
            out.iter()
                .find(|decision| decision.target_id == "left#2")
                .map(|decision| decision.kind.as_str()),
            Some("skeleton"),
            "the dedup full drop must take the same reasoning-adjacency safety demotion: {out:?}"
        );
        assert_eq!(
            out.iter()
                .find(|decision| decision.target_id == "older-result#0")
                .map(|decision| decision.kind.as_str()),
            Some("drop")
        );
    }

    #[test]
    fn defer_pass_produces_nothing() {
        let items = vec![
            tool_call("c1", 1, "bash", serde_json::json!({}), 50),
            tool_result("c1", 1, "bash", 300),
        ];
        let mut ctx = base_ctx(PassClass::Defer);
        ctx.last_execute_ordinal = 1;
        ctx.agent_drop_ids = vec![result_block_id("c1")];
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );
        assert!(out.is_empty(), "defer produces no reductions");
    }
}
