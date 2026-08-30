//! The optimized selection module must produce decision-for-decision
//! identical output to this frozen copy on every generated input.
//!
//! `reference` defines expected behavior; optimized output must match it.

#[allow(clippy::all, dead_code)]
mod reference {
    //! Tail-reduction SELECTION — decides WHICH tail items to reduce and produces
    //! their [`ReductionDecision`]s, which slice-3's mechanics freeze/replay/fold.
    //!
    //! This is the module-owned reduction producer. It is a PURE, DETERMINISTIC function over the flat, block-granular
    //! typed tail (CK#1's `ContentKind` projected 1:1 per block into [`SelItem`]).
    //! Determinism is the cache invariant: same (items, frozen_keys, ctx, cfg) → same
    //! decisions → the slice-3 freeze/replay stays byte-identical.
    //!
    //! Faithful port of the OpenCode selectors: control-plane supersession, edit
    //! supersession, duplicate-tool cleanup, emergency tiered drop, age-based two-pass,
    //! and ctx_reduce agent-drop.
    //!
    //! Cache-critical invariants (enforced structurally here):
    //! - **frozen_keys HARD FILTER**: a CK item stays LIVE with original bytes after
    //!   reduction (unlike a TS dropped tag, which leaves the active set), so every
    //!   selector MUST exclude already-frozen ids up front or it would re-target them.
    //! - **provider_executed filter**: the selectors touch only CLIENT-executed harness
    //!   tools; server-side model tools (provider_executed=true) and Opaque blocks stay
    //!   verbatim.
    //! - **payload purity**: every payload is a pure function of (id, immutable block
    //!   bytes) with ZERO pass-varying state, so a frozen target can never be re-emitted
    //!   with different bytes.
    //! - **arc-safe emission**: a tool reduction emits decisions for its ToolCall and
    //!   paired ToolResult together. Reasoning is never rewritten, and a reasoning-bearing
    //!   assistant with no other durable sibling makes the whole tool arc ineligible.
    //! - **deterministic merge**: exactly one decision per target; `drop` beats
    //!   `edit_marker`; stable output order.

    use std::collections::{HashMap, HashSet};

    pub use mc_module::transform::ReductionDecision;

    fn utf16_len(text: &str) -> usize {
        text.encode_utf16().count()
    }

    fn utf16_prefix(text: &str, limit: usize) -> &str {
        let mut used = 0;
        let mut end = 0;
        for (start, character) in text.char_indices() {
            let next = used + character.len_utf16();
            if next > limit {
                break;
            }
            used = next;
            end = start + character.len_utf8();
        }
        &text[..end]
    }

    // --- ported TS constants (exact; the differential golden is the arbiter) ---

    /// `todowrite`: keep the newest 1 (the live plan is the newest todo state).
    const TODOWRITE_KEEP: usize = 1;
    /// Recent `ctx_reduce` arcs retained as visible housekeeping exemplars.
    const CTX_REDUCE_KEEP: usize = 3;
    /// Zero-value meta tools whose every occurrence is droppable.
    const ZERO_VALUE_META_TOOLS: &[&str] = &["bash_status", "bash_kill"];
    /// `ctx_note` actions that carry no lasting value (droppable when positively read).
    const CTX_NOTE_ZERO_VALUE_ACTIONS: &[&str] = &["read", "dismiss"];
    /// Mirrors the duplicate-safe tool list in the TypeScript twin:
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
    /// Tools whose superseded older calls compress to an edit_marker.
    const EDIT_TOOLS: &[&str] = &["edit", "write"];
    /// filePath-like input keys, preserved verbatim in an edit_marker.
    const FILE_PATH_KEYS: &[&str] = &["filePath", "file_path", "path"];
    /// Diff-bearing input keys, clamped to a region hint in an edit_marker.
    const DIFF_KEYS: &[&str] = &[
        "oldString",
        "newString",
        "content",
        "old_string",
        "new_string",
    ];
    /// Region-hint length: enough to identify the edited section, cheap to keep.
    const EDIT_REGION_HINT_LEN: usize = 40;
    /// The clamp sentinel appended to a region-hinted diff value.
    const TRUNCATION_SENTINEL: &str = "...[truncated]";

    /// Reclaim target fraction: `fixedFloor + 0.30 × (ceiling − fixedFloor)`.
    const TARGET_FRACTION: f64 = 0.30;
    /// Newest `ceil(0.20 × n)` of each of T1/T2 are reserved (never evicted).
    const TIER_RECENCY_RESERVE: f64 = 0.20;
    /// Skip arcs too small to recover meaningful tokens during pressure-triggered reclamation.
    const AGE_RECLAIM_MIN_TOKENS: usize = 250;
    /// Minimum reclaim to justify an emergency cache bust (tokens).
    const EMERGENCY_REARM_MIN_TOKENS: f64 = 2000.0;
    /// Byte→token estimate for the emergency reclaim math (matches the TS nudge).
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

    /// The typed content-kind projection selection branches on — CK#1 `ContentKind`
    /// reduced to exactly the fields the five selectors read.
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

    /// Pass-level inputs that ride the transform request run-config (NOT CK item
    /// fields). See spec §5 for the sourcing buckets (derive / durable / config /
    /// caller-owned). For the isolated build these are supplied directly.
    #[derive(Debug, Clone)]
    pub struct SelectionContext {
        pub pass_class: PassClass,
        /// Provider-reported current total input tokens from the request usage sample.
        pub current_total_input_tokens: f64,
        /// ceiling = contextLimit × executeThreshold%.
        pub ceiling_tokens: f64,
        /// The protected-recent window: items with `ordinal > protected_cutoff_ordinal`
        /// are never emergency-evicted (0 = protect nothing).
        pub protected_cutoff_ordinal: u64,
        /// The frozen two-pass watermark: tool items with `ordinal <= last_execute_ordinal`
        /// may join the next riding/force batch (0 = none). It advances only after that
        /// batch is applied, so execute-band residency cannot age in one new arc per pass.
        pub last_execute_ordinal: u64,
        /// True only for a scheduler execute caused by a context-pressure threshold crossing.
        pub scheduler_pressure_execute: bool,
        /// Emergency idempotence latch: the input-token reading at the prior emergency
        /// drop (0 if never), and whether any emergency drop has happened.
        pub prior_input_sample: f64,
        pub has_prior_drop: bool,
        /// Agent-marked drop ids (the ctx_reduce §N§ signal), a caller-owned side input.
        /// Canonical flat ids of the marked blocks.
        pub agent_drop_ids: Vec<String>,
        /// Agent-drop command ownership, keyed by canonical block id. Missing entries are
        /// legacy rows queued without a command id.
        pub agent_drop_command_ids: HashMap<String, String>,
        /// Agent-drop ids whose command already made its first application. The marker is
        /// durable at command scope, but selection needs the per-id projection.
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

    /// Which scheduler class this pass is — gates which selectors run.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum PassClass {
        /// A normal execute+bust pass: control-plane / edit / two-pass / ctx_reduce run.
        Execute,
        /// A derived force-band pass: the emergency tiered drop runs (in addition).
        EmergencyForce,
        /// A defer pass: selection produces nothing new (mechanics replay frozen).
        Defer,
    }

    /// Config knobs (frozen at bind, like the budget): the smart-drops gate and the
    /// keep/reserve/hint parameters. Defaults mirror the TS constants (smart_drops off).
    #[derive(Debug, Clone, Default)]
    pub struct SelectionConfig {
        /// Gates the smart-drops selectors (control-plane + edit supersession).
        pub smart_drops: bool,
    }

    /// A tool ARC grouped from the flat blocks: the selection unit. Each selector picks
    /// arcs to reduce; the arc then expands to per-block decisions.
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
        /// Malformed providers can repeat a call id inside one assistant message; TS treats
        /// those blocks as one drop target, so Rust keeps one composite arc with many blocks.
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

    /// Normalize a tool name for matching (lowercase, strip an `mcp_` prefix) — mirrors
    /// the TS `normalizeToolName`, defensive for MCP-surfaced names.
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

    /// Read a string field from a ToolCall input object by any of the given keys.
    fn read_input_str(input: &serde_json::Value, keys: &[&str]) -> Option<String> {
        let obj = input.as_object()?;
        for key in keys {
            if let Some(serde_json::Value::String(s)) = obj.get(*key) {
                return Some(s.clone());
            }
        }
        None
    }

    /// Group the flat blocks into tool arcs (by `arc_id`), collecting the call/result
    /// bytes and adjacent reasoning. Non-tool, non-arc blocks are ignored here (they
    /// are not reduction targets for the tool selectors; ctx_reduce targets ids directly).
    fn group_arcs(items: &[SelItem], frozen: &HashSet<String>) -> Vec<ToolArc> {
        let mut arcs: HashMap<String, ToolArc> = HashMap::new();
        // Deterministic arc order = first-appearance order (by min ordinal), applied at
        // the end via a sort. Build the map first.
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

    /// Arc ids whose complete removal would erase a tool-result separator and expose
    /// reasoning-bearing assistant content to a provider-side same-role merge.
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

    /// Tool arcs in an assistant that consists only of native reasoning plus reducible tool blocks
    /// are not reduction candidates. Reasoning cannot be rewritten, so changing every remaining
    /// tool sibling would either strand a reasoning-only message or mutate a signed assistant turn.
    pub(crate) fn reasoning_ineligible_arc_ids(items: &[SelItem]) -> HashSet<String> {
        let mut messages: HashMap<&str, ReasoningMessageShape> = HashMap::new();
        for item in items {
            let Some(mid) = item_message_id(item) else {
                continue;
            };
            let message = messages.entry(mid).or_default();
            match &item.kind {
                SelKind::Reasoning | SelKind::RedactedReasoning => message.has_reasoning = true,
                SelKind::ToolCall { .. } | SelKind::ToolResult { .. }
                    if !item.provider_executed =>
                {
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

    // --- payload builders (PURE functions of the block's immutable bytes) ---

    /// The provider-neutral reduced-content placeholder for a fully-dropped block. Selection
    /// stays pure over immutable block bytes; the transform freeze path adds a durable tag
    /// reference when the target already has a minted visible tag number.
    const DROPPED_PLACEHOLDER: &str = "[dropped]";

    fn safe_prefix(s: &str, max_len: usize) -> &str {
        let mut end = max_len.min(s.len());
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        &s[..end]
    }

    /// Clamp a diff value to a region hint (edit_marker): first `EDIT_REGION_HINT_LEN`
    /// UTF-16 units + the sentinel. Idempotent (already-hinted values pass through). Pure.
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

    /// Build the edit_marker payload for a superseded edit/write ToolCall: filePath-like
    /// keys VERBATIM, diff keys clamped to a region hint, other keys untouched. Emitted as
    /// a canonical (sorted-key) JSON string so it is deterministic + pure. Mirrors the TS
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

    /// Serialize a JSON value with sorted object keys (deterministic bytes across passes).
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

    // --- the reduction plan an arc/selector contributes, before window-shaping ---

    /// A per-arc reduction intent from the tool selectors, before the skeleton-window
    /// shape is applied. `edit_marker` distinguishes the edit-supersession intent (which
    /// keeps the ToolCall as a region-hinted marker) from a plain drop.
    struct ArcIntent {
        edit_marker: bool,
    }

    /// Selection modes an arc's ToolCall block can freeze into.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum ArcShape {
        /// In the newest skeleton window: keep a name-preserving call skeleton.
        Skeleton,
        /// Older than the window: fully drop the call block.
        FullDrop,
        /// TS duplicate-tool cleanup always fully drops older calls. It bypasses the ordinary
        /// recency skeleton window, but still demotes for reasoning-adjacency safety.
        DedupFullDrop,
        /// Edit-supersession: keep filePath + a region hint (regardless of window).
        EditMarker,
    }

    /// Clamp ToolCall input values exactly like the TypeScript drop target: inputs at or
    /// below 500 JSON bytes remain intact; larger object values keep short strings while
    /// arrays and nested objects become compact summaries. The result is frozen at selection.
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

    /// Expand a reduced arc into its per-block [`ReductionDecision`]s: the ToolCall block
    /// takes the shape kind and paired ToolResults are dropped. Reasoning stays verbatim;
    /// reasoning-only message shapes have already been excluded from the candidate pool.
    /// Skips blocks that are already frozen (never re-decide) or absent.
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
        // Reasoning blocks are NEVER reduction targets: signed thinking is
        // provider-verified content, and a placeholder-rewritten reasoning block can
        // never re-encode for Anthropic (the signature is gone), which permanently
        // fences the session to raw. The arc's reasoning stays verbatim; reclaim
        // comes from the call/result blocks only.
    }

    // --- the five selectors: each returns the ARC-IDs (or block-ids) it targets ---

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

    /// 1.1 Control-plane supersession + 1.2 edit supersession (the smart_drops selectors).
    /// Newest-arc-first, per tool name: todowrite keep-1, ctx_reduce keep-K, zero-value
    /// meta drop-all, ctx_note drop-on-zero-value-action; edit/write older-per-file →
    /// edit_marker. Returns per-arc intents so the caller expands + shapes them. Active
    /// (non-reduced, client-executed) arcs only.
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
            // Edit supersession first (1.2): older-per-file → edit_marker.
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
                // no resolvable filePath → skip (fail-safe); still fall through to name rules
            }
            // Control-plane supersession (1.1).
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

    /// Select older completed duplicate calls from safe tools. The owner is in both the lookup key
    /// and the fingerprint, so identical calls from distinct assistant messages stay distinct.
    /// Arguments use `serde_json` serialization; a serialization failure skips that candidate.
    fn select_tool_dedup(arcs: &[&ToolArc], ctx: &SelectionContext) -> HashSet<String> {
        // Including `owner_message_id` in `fingerprint` keeps identical calls from
        // distinct assistant messages in separate buckets.
        let mut groups: HashMap<String, Vec<&ToolArc>> = HashMap::new();
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
            let owner_message_id = arc.owner_message_id.as_ref().expect("owner checked above");
            let fingerprint = format!("{owner_message_id}:{}:{args}", arc.dedup_name);
            groups.entry(fingerprint).or_default().push(*arc);
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
                // Preserve the newest (highest tool-result position, then stable arc id).
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

    /// 1.4 Age-based two-pass: tool arcs whose age (ToolCall ordinal) is at/under the
    /// last-execute watermark. Add-only (the watermark advances forward). Returns arc ids.
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

    /// 1.5 ctx_reduce agent-drop: the caller-supplied marked ids (a control-plane side
    /// input). These are already flat block ids; emitted directly as drops (arc-atomic
    /// isn't needed — the agent marks specific blocks). Frozen/absent filtered by caller.
    fn select_agent_drops(
        ctx: &SelectionContext,
        live_ids: &HashSet<&str>,
        frozen: &HashSet<String>,
        out: &mut Vec<ReductionDecision>,
    ) {
        for id in &ctx.agent_drop_ids {
            if frozen.contains(id) || !live_ids.contains(id.as_str()) || ctx.block_is_protected(id)
            {
                continue;
            }
            let first_applied = ctx.first_applied_agent_drop_ids.contains(id);
            // A context already at its execute ceiling is an independent/natural bust
            // opportunity. It must drain every queued row; the one-self-bust rule only
            // applies while this pass would bust solely because of a newly selected drop.
            let natural_bust = ctx.pass_already_busting
                || (ctx.pass_class == PassClass::Execute
                    && ctx.ceiling_tokens > 0.0
                    && ctx.current_total_input_tokens >= ctx.ceiling_tokens);
            let can_ride = natural_bust
                || (first_applied
                    && ctx.agent_drop_ids.iter().any(|other| {
                        other != id
                            && !ctx.first_applied_agent_drop_ids.contains(other)
                            && live_ids.contains(other.as_str())
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

    /// Tier of a tool for the emergency drop: T1 nav (keep longest), T2 edit·search, T3
    /// misc (drop first). Mirrors the TS `resolveToolTier`.
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

    /// Reconstruct the active floor-tag population. A tool arc is one tag in the TS planner, so its
    /// call/result/reasoning bytes are aggregated before the per-tag token rounding is applied.
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

    /// 1.3 Emergency tiered drop (derived force-band). Target headroom = fixedFloor + 0.30 ×
    /// (ceiling − fixedFloor); walk T3→T2→T1 oldest-first, skipping the protected tail
    /// and the newest-20% T1/T2 reserve, until reclaim met. The floor covers every active
    /// live tag class, while candidates remain active tool arcs. Returns the arc ids to full-drop.
    fn select_emergency(
        arcs: &[&ToolArc],
        ctx: &SelectionContext,
        all_active_floor_tokens: f64,
    ) -> HashSet<String> {
        // Guards mirror the TS planner: unknown ceiling/usage → no-op; idempotence latch.
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
        // TS rounds the scalar target reclaim before applying the re-arm floor. Keep the
        // comparison on that rounded value; comparing the raw float can fire for a
        // sub-threshold fractional remainder at the boundary.
        let reclaim_tokens = (ctx.current_total_input_tokens - target).round();
        if reclaim_tokens <= EMERGENCY_REARM_MIN_TOKENS {
            return HashSet::new();
        }

        // Per-tier recency reserve (T1, T2 only): the newest ceil(20%) active arcs.
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

        // Protect ctx_reduce exemplars without changing the target math. The fixed floor
        // above already derives from every active floor tag, so removing candidates changes
        // neither the floor nor target (panel-verified emergency interaction).
        let protected_ctx_reduce_arcs = newest_ctx_reduce_arc_ids(arcs);

        // Build candidates per tier (protected tail + reserve excluded).
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

        // Walk T3 → T2 → T1, oldest-first within tier, until reclaim met.
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
        /// The pressure pass was already busting, or was in the force band, so the age
        /// batch had an application opportunity. Empty opportunities still advance the
        /// watermark so future arcs can age into a later batch.
        pub two_pass_batch_can_apply: bool,
        /// Live superseded arcs counted at the existing selector call inside an open ride gate.
        /// `active_arcs` excludes any arc with a frozen member, so this depth can shrink between rides.
        /// Missing means the gate stayed shut and the selector did not run.
        pub eligible_supersession_count: Option<usize>,
        /// Eligible supersession arcs entirely removed by the newest-tag block window.
        pub supersession_withheld_by_tag_window_count: Option<usize>,
        /// Eligible supersession arcs entirely removed by a whole-message exemption.
        pub supersession_withheld_by_exempt_message_count: Option<usize>,
        /// Eligible supersession arcs represented in the final decision list after every filter.
        pub applied_supersession_count: Option<usize>,
    }

    /// Produce the full reduction-decision set for this pass. PURE + deterministic (see
    /// the module-level docs for the invariants). Empty on a defer pass (the mechanics
    /// replay the already-frozen set).
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
        let live_ids: HashSet<&str> = items
            .iter()
            .filter(|item| {
                // Media/Opaque are pass-through carriers; Reasoning is signed
                // provider-verified content whose rewrite can never re-encode.
                // None of the three may ever become a reduction target, including
                // via agent-directed ctx_reduce ids.
                !matches!(
                    item.kind,
                    SelKind::Media
                        | SelKind::Opaque
                        | SelKind::Reasoning
                        | SelKind::RedactedReasoning
                )
            })
            .map(|item| item.id.as_str())
            .collect();
        let arcs = group_arcs(items, frozen_keys);
        let reasoning_ineligible_arcs = reasoning_ineligible_arc_ids(items);
        let reasoning_adjacency_collapse_arcs = reasoning_adjacency_collapse_arc_ids(items);
        // The COMPOSED candidate pool: active (non-reduced), client-executed arcs only.
        // frozen_keys is applied per-block at emit time (expand_arc skips frozen ids); an
        // arc is "reduced/inactive" once ANY of its blocks is frozen — excluded here so it
        // never re-enters candidate/reserve/reclaim accounting.
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

        // Per-arc reduction intents (arc_id → shape), assembled in TS precedence order.
        let mut arc_shapes: HashMap<String, ArcShape> = HashMap::new();
        // Dedup precedes age selection, as in the TS heuristic pass. An older duplicate
        // removed here must not also enter the two-pass age batch.
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
                // Compute emergency first to learn whether this pass has concrete reclaim work;
                // dedup intent still enters before the age intent below.
                // Floor accounting and eviction candidates have different populations. Every
                // unfrozen tagged-content class contributes to the fixed-floor derivation, including
                // text, media, reasoning, and non-droppable tools; system-prefix and opaque metadata
                // remain outside that population. Only active client tool arcs can be selected below.
                let all_active_floor_tokens = active_floor_tokens(items, frozen_keys);
                let emergency_arc_ids =
                    select_emergency(&active_arcs, ctx, all_active_floor_tokens);
                if !emergency_arc_ids.is_empty() || !two_pass_arc_ids.is_empty() {
                    for arc_id in &dedup_arc_ids {
                        arc_shapes.insert(arc_id.clone(), ArcShape::DedupFullDrop);
                    }
                }
                // The force-band edge admits a waiting age batch without changing emergency's
                // own candidate accounting or tiered selection.
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
                // Apply supersession only when this pass selected concrete reclaim work: an
                // emergency eviction or a two-pass reclaim batch. If emergency mode has met
                // its headroom target but selected nothing, defer supersession so it cannot
                // create a cache bust by itself.
                if cfg.smart_drops
                    && (!emergency_arc_ids.is_empty() || !two_pass_arc_ids.is_empty())
                {
                    // A superseded arc remains eligible while the ride gate is shut, so the count
                    // observed when it next opens summarizes everything accumulated between rides.
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
                // Order = dedup (drop) → two-pass (drop) → control-plane (drop) → edit (edit_marker).
                // drop wins: a later edit_marker never overrides an assigned drop. The transform maps
                // ordinary scheduler Execute here only when classification identifies an independent
                // bust opportunity; an active background historian defers ordinary executes first.
                for arc_id in &dedup_arc_ids {
                    arc_shapes.insert(arc_id.clone(), ArcShape::DedupFullDrop);
                }
                for arc_id in &two_pass_arc_ids {
                    arc_shapes
                        .entry(arc_id.clone())
                        .or_insert(ArcShape::FullDrop);
                }
                // Supersession is deferred work: ordinary execute-band pressure and a held
                // emergency latch cannot authorize a rewrite. Concrete scheduled work or an
                // admitted two-pass batch lets the whole pending set ride the same bust.
                if cfg.smart_drops
                    && (ctx.supersession_ride_available || !two_pass_arc_ids.is_empty())
                {
                    // Count the exact selector output before overlap precedence removes members.
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

        // Supersession's recency floor follows the newest ACTIVE tag window rather than a second
        // owner-message K=20 window. If either half has a protected active tag, retain the whole arc;
        // otherwise filtering only the tagged result would leave a partially superseded pair.
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

        // Resolve fresh full-drop intents to a skeleton when either recency or removal safety
        // requires a result shell. Decided ONCE here (freeze-time): frozen_keys excludes replayed
        // arcs, so neither an aging window nor a newly detected adjacency can change frozen bytes.
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

        // ctx_reduce agent drops stay block-granular, but pass-through carriers are absent
        // from live_ids so Media and Opaque can never become reduction targets.
        select_agent_drops(ctx, &live_ids, frozen_keys, &mut out);

        // Agent-directed ids can name either half of a tool arc, so apply the same whole-message
        // guard after their block-granular decisions have been added.
        let arc_by_block_id: HashMap<&str, &str> = items
            .iter()
            .filter_map(|item| Some((item.id.as_str(), item.arc_id.as_deref()?)))
            .collect();
        out.retain(|decision| {
            arc_by_block_id
                .get(decision.target_id.as_str())
                .is_none_or(|arc_id| !reasoning_ineligible_arcs.contains(*arc_id))
        });

        // Protection is block-specific, not an ordinal cutoff: remove protected targets from
        // both automatic arc decisions and agent-directed decisions before the stable merge.
        out.retain(|decision| !ctx.block_is_protected(&decision.target_id));

        // Deterministic merge: exactly one decision per target (drop > edit_marker >
        // skeleton), stable output order (by target_id).
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

    /// Collapse to one decision per target_id (drop beats edit_marker beats skeleton) and
    /// sort by target_id for byte-deterministic output.
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
}

use std::collections::{HashMap, HashSet};

use mc_module::selection::{
    select_reductions_with_outcome, PassClass, SelItem, SelKind, SelMessageRole, SelectionConfig,
    SelectionContext,
};
use proptest::prelude::*;

#[derive(Debug, Clone)]
struct ItemSpec {
    msg: u8,
    block: u8,
    ordinal_slot: u8,
    role: u8,
    kind: u8,
    tool: u8,
    input: u8,
    provider_executed: bool,
    byte_size: u16,
    token_count: Option<u16>,
    arc: Option<u8>,
    frozen: bool,
    agent_drop: bool,
    tag_protected: bool,
    exempt_protected: bool,
}

fn item_spec() -> impl Strategy<Value = ItemSpec> {
    (
        (0u8..12, 0u8..3, 0u8..32, 0u8..3, 0u8..7),
        (
            0u8..15,
            0u8..10,
            any::<bool>(),
            0u16..4096,
            proptest::option::of(0u16..2048),
        ),
        (
            proptest::option::of(0u8..8),
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
        ),
    )
        .prop_map(
            |(
                (msg, block, ordinal_slot, role, kind),
                (tool, input, provider_executed, byte_size, token_count),
                (arc, frozen, agent_drop, tag_protected, exempt_protected),
            )| ItemSpec {
                msg,
                block,
                ordinal_slot,
                role,
                kind,
                tool,
                input,
                provider_executed,
                byte_size,
                token_count,
                arc,
                frozen,
                agent_drop,
                tag_protected,
                exempt_protected,
            },
        )
}

const TOOLS: [&str; 15] = [
    "mcp_read",
    "mcp_grep",
    "read",
    "edit",
    "write",
    "todowrite",
    "ctx_reduce",
    "ctx_note",
    "bash",
    "glob",
    // `ZERO_VALUE_META_TOOLS` members.
    "bash_status",
    "bash_kill",
    // Mixed-case tool names test `normalize_tool_name`.
    "MCP_READ",
    "Edit",
    "TodoWrite",
];

/// The rocket's UTF-16 surrogate pair crosses `EDIT_REGION_HINT_LEN`.
const DIFF_ACROSS_HINT_BOUNDARY: &str = "012345678901234567890123456789012345678\u{1F680}tail";

/// `large_input` exceeds 500 serialized bytes and exercises `clamp_object` truncation for
/// strings, arrays, and objects.
fn large_input() -> serde_json::Value {
    serde_json::json!({
        "filePath": "src/a.rs",
        "oldString": "x".repeat(640),
        "items": (0..12).collect::<Vec<u32>>(),
        "nested": {"k": "value", "deep": {"a": 1, "b": "two"}},
        "flag": true,
        "limit": 7,
    })
}

fn input_value(variant: u8) -> serde_json::Value {
    match variant {
        0 => serde_json::json!({"filePath": "src/a.rs"}),
        1 => serde_json::json!({"filePath": "src/b.rs"}),
        2 => serde_json::json!({"path": "src/a.rs", "limit": 5}),
        3 => serde_json::json!({"action": "list"}),
        4 => serde_json::json!({"description": "do things"}),
        // `CTX_NOTE_ZERO_VALUE_ACTIONS` members.
        5 => serde_json::json!({"action": "read"}),
        6 => serde_json::json!({"action": "dismiss"}),
        7 => large_input(),
        8 => serde_json::json!({
            "filePath": "src/a.rs",
            "oldString": DIFF_ACROSS_HINT_BOUNDARY,
            "newString": "short",
        }),
        _ => serde_json::json!({}),
    }
}

fn id_of(spec: &ItemSpec) -> String {
    format!("m{}#{}", spec.msg, spec.block)
}

macro_rules! build_inputs {
    ($specs:expr, $ctx_bits:expr, $SelItem:path, $SelKind:path, $SelMessageRole:path,
     $SelectionContext:path, $PassClass:path, $SelectionConfig:path) => {{
        use $PassClass as P;
        use $SelKind as K;
        use $SelMessageRole as R;
        type Item = $SelItem;
        type Ctx = $SelectionContext;
        type Cfg = $SelectionConfig;
        let specs = $specs;
        let (
            pass_class,
            tokens,
            ceiling,
            cutoff_slot,
            execute_slot,
            pressure,
            prior,
            busting,
            ride,
            smart,
        ) = $ctx_bits;
        let items: Vec<Item> = specs
            .iter()
            .map(|s| {
                let kind = match s.kind {
                    0 => K::ToolCall {
                        name: TOOLS[usize::from(s.tool)].to_string(),
                        input: input_value(s.input),
                    },
                    1 => K::ToolResult {
                        tool_name: TOOLS[usize::from(s.tool)].to_string(),
                    },
                    2 => K::Reasoning,
                    3 => K::RedactedReasoning,
                    4 => K::Media,
                    5 => K::Opaque,
                    _ => K::Text,
                };
                let role = match s.role {
                    0 => R::Assistant,
                    1 => R::System,
                    _ => R::NonAssistant,
                };
                Item {
                    id: id_of(s),
                    ordinal: u64::from(s.ordinal_slot),
                    message_role: role,
                    kind,
                    provider_executed: s.provider_executed,
                    byte_size: usize::from(s.byte_size),
                    token_count: s.token_count.map(usize::from),
                    arc_id: s.arc.map(|a| format!("m{}#0", a)),
                }
            })
            .collect();
        let frozen: HashSet<String> = specs
            .iter()
            .filter(|s| s.frozen)
            .map(|s| id_of(s))
            .collect();
        let agent_drop_ids: Vec<String> = specs
            .iter()
            .filter(|s| s.agent_drop)
            .map(|s| id_of(s))
            .collect();
        let agent_drop_command_ids: HashMap<String, String> = agent_drop_ids
            .iter()
            .enumerate()
            .filter(|(i, _)| i % 2 == 0)
            .map(|(i, id)| (id.clone(), format!("cmd-{}", i / 4)))
            .collect();
        let first_applied: HashSet<String> = agent_drop_ids
            .iter()
            .enumerate()
            .filter(|(i, _)| i % 3 == 0)
            .map(|(_, id)| id.clone())
            .collect();
        let max_ordinal = items.iter().map(|i| i.ordinal).max().unwrap_or(0);
        let ctx = Ctx {
            pass_class: match pass_class {
                0u8 => P::Execute,
                1 => P::EmergencyForce,
                _ => P::Defer,
            },
            current_total_input_tokens: tokens,
            ceiling_tokens: ceiling,
            protected_cutoff_ordinal: max_ordinal * u64::from(cutoff_slot) / 4,
            last_execute_ordinal: max_ordinal * u64::from(execute_slot) / 4,
            scheduler_pressure_execute: pressure,
            // Arm 1 sets `prior_input_sample` to `tokens` so `prior_input_sample == tokens`
            // exercises the early return in `select_emergency`.
            prior_input_sample: match prior {
                0 => 0.0,
                1 => tokens,
                2 => tokens * 0.5,
                _ => tokens * 1.5,
            },
            has_prior_drop: prior != 0,
            agent_drop_ids,
            agent_drop_command_ids,
            first_applied_agent_drop_ids: first_applied,
            pass_already_busting: busting,
            supersession_ride_available: ride,
            tag_window_protected_block_ids: specs
                .iter()
                .filter(|s| s.tag_protected)
                .map(|s| id_of(s))
                .collect(),
            exempt_message_protected_block_ids: specs
                .iter()
                .filter(|s| s.exempt_protected)
                .map(|s| id_of(s))
                .collect(),
        };
        let cfg = Cfg { smart_drops: smart };
        (items, frozen, ctx, cfg)
    }};
}

type CtxBits = (u8, f64, f64, u8, u8, bool, u8, bool, bool, bool);

fn ctx_bits() -> impl Strategy<Value = CtxBits> {
    (
        (0u8..3, 0.0f64..200_000.0, 0.0f64..150_000.0, 0u8..5, 0u8..5),
        (
            any::<bool>(),
            0u8..4,
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
        ),
    )
        .prop_map(|((a, b, c, d, e), (f, g, h, i, j))| (a, b, c, d, e, f, g, h, i, j))
}

fn decision_rows(
    decisions: &[mc_module::transform::ReductionDecision],
) -> Vec<(String, String, String)> {
    decisions
        .iter()
        .map(|d| (d.target_id.clone(), d.kind.clone(), d.payload.clone()))
        .collect()
}

/// Compare all outcome fields: `transform` uses `two_pass_batch_can_apply` to update
/// `meta.last_execute_ordinal`, so scalar fields can differ when decisions are
/// byte-identical.
macro_rules! outcome_rows {
    ($outcome:expr) => {{
        let outcome = $outcome;
        (
            decision_rows(&outcome.decisions),
            outcome.two_pass_batch_can_apply,
            outcome.eligible_supersession_count,
            outcome.supersession_withheld_by_tag_window_count,
            outcome.supersession_withheld_by_exempt_message_count,
            outcome.applied_supersession_count,
        )
    }};
}

/// `arc_window_specs` generates 24 to 30 arcs, exceeding `RECENT_TOOL_SKELETON_WINDOW` (20).
/// `frozen_tail` freezes the newest arc's call, which drops that arc from `active_arcs`.
fn arc_window_specs() -> impl Strategy<Value = Vec<ItemSpec>> {
    (
        24u8..31,
        0u8..15,
        0u8..10,
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
    )
        .prop_map(
            |(arc_count, tool, input, provider_executed, agent_drop, frozen_tail)| {
                let mut specs = Vec::with_capacity(usize::from(arc_count) * 2);
                for arc in 0..arc_count {
                    let mut push = |block: u8, kind: u8, byte_size: u16, agent_drop: bool| {
                        specs.push(ItemSpec {
                            msg: arc,
                            block,
                            ordinal_slot: arc,
                            role: 0,
                            kind,
                            tool,
                            input,
                            provider_executed,
                            byte_size,
                            token_count: None,
                            arc: Some(arc),
                            frozen: frozen_tail && arc + 1 == arc_count,
                            agent_drop,
                            tag_protected: false,
                            exempt_protected: false,
                        });
                    };
                    push(0, 0, 1200, agent_drop);
                    push(1, 1, 600, false);
                }
                specs
            },
        )
}

macro_rules! outcome_pair {
    ($specs:expr, $bits:expr) => {{
        let specs = $specs;
        let bits = $bits;
        let (items, frozen, ctx, cfg) = build_inputs!(
            &specs,
            bits,
            SelItem,
            SelKind,
            SelMessageRole,
            SelectionContext,
            PassClass,
            SelectionConfig
        );
        let (ref_items, ref_frozen, ref_ctx, ref_cfg) = build_inputs!(
            &specs,
            bits,
            reference::SelItem,
            reference::SelKind,
            reference::SelMessageRole,
            reference::SelectionContext,
            reference::PassClass,
            reference::SelectionConfig
        );
        let optimized = outcome_rows!(select_reductions_with_outcome(&items, &frozen, &ctx, &cfg));
        let expected = outcome_rows!(reference::select_reductions_with_outcome(
            &ref_items,
            &ref_frozen,
            &ref_ctx,
            &ref_cfg,
        ));
        (optimized, expected, specs, bits)
    }};
}

fn payload_clamp_specs() -> impl Strategy<Value = Vec<ItemSpec>> {
    (
        3u8..8,
        prop_oneof![
            Just(3u8),
            Just(4u8),
            Just(13u8),
            Just(0u8),
            Just(2u8),
            Just(12u8)
        ],
        proptest::collection::vec(prop_oneof![Just(7u8), Just(8u8)], 8),
        any::<bool>(),
    )
        .prop_map(|(arc_count, tool, inputs, agent_drop)| {
            let mut specs = Vec::with_capacity(usize::from(arc_count) * 2);
            for arc in 0..arc_count {
                let input = inputs[usize::from(arc) % inputs.len()];
                let mut push = |block: u8, kind: u8, byte_size: u16, agent_drop: bool| {
                    specs.push(ItemSpec {
                        msg: arc,
                        block,
                        ordinal_slot: arc,
                        role: 0,
                        kind,
                        tool,
                        input,
                        provider_executed: false,
                        byte_size,
                        token_count: None,
                        arc: Some(arc),
                        frozen: false,
                        agent_drop,
                        tag_protected: false,
                        exempt_protected: false,
                    });
                };
                push(0, 0, 1400, agent_drop && arc == 0);
                push(1, 1, 700, false);
            }
            specs
        })
}

fn dedup_specs() -> impl Strategy<Value = Vec<ItemSpec>> {
    (
        2u8..6,
        prop_oneof![Just(0u8), Just(1u8)],
        0u8..10,
        any::<bool>(),
    )
        .prop_map(|(arc_count, tool, input, tag_protected)| {
            let mut specs = Vec::with_capacity(usize::from(arc_count) * 2);
            for arc in 0..arc_count {
                let mut push = |block: u8, kind: u8, byte_size: u16, tag_protected: bool| {
                    specs.push(ItemSpec {
                        msg: 0,
                        block,
                        ordinal_slot: arc,
                        role: 0,
                        kind,
                        tool,
                        input,
                        provider_executed: false,
                        byte_size,
                        token_count: None,
                        arc: Some(arc),
                        frozen: false,
                        agent_drop: false,
                        tag_protected,
                        exempt_protected: false,
                    });
                };
                push(arc * 2, 0, 900, tag_protected && arc == 0);
                push(arc * 2 + 1, 1, 400, false);
            }
            specs
        })
}

fn pressured_ctx_bits() -> impl Strategy<Value = CtxBits> {
    (0u8..5, 0u8..5, 0u8..4, any::<bool>()).prop_map(
        |(cutoff_slot, execute_slot, prior, busting)| {
            (
                0,
                180_000.0,
                100_000.0,
                cutoff_slot,
                execute_slot,
                true,
                prior,
                busting,
                true,
                true,
            )
        },
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]
    #[test]
    fn optimized_matches_frozen_reference(
        specs in proptest::collection::vec(item_spec(), 0..40),
        bits in ctx_bits(),
    ) {
        let (optimized, expected, specs, bits) = outcome_pair!(specs, bits);
        prop_assert_eq!(optimized, expected, "diverged on {:?} {:?}", specs, bits);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(192))]
    #[test]
    fn optimized_matches_frozen_reference_across_skeleton_window(
        specs in arc_window_specs(),
        bits in ctx_bits(),
    ) {
        let (optimized, expected, specs, bits) = outcome_pair!(specs, bits);
        prop_assert_eq!(optimized, expected, "diverged on {:?} {:?}", specs, bits);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(192))]
    #[test]
    fn optimized_matches_frozen_reference_on_duplicate_calls(
        specs in dedup_specs(),
        bits in ctx_bits(),
    ) {
        let (optimized, expected, specs, bits) = outcome_pair!(specs, bits);
        prop_assert_eq!(optimized, expected, "diverged on {:?} {:?}", specs, bits);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(192))]
    #[test]
    fn optimized_matches_frozen_reference_on_clamped_payloads(
        specs in payload_clamp_specs(),
        bits in pressured_ctx_bits(),
    ) {
        let (optimized, expected, specs, bits) = outcome_pair!(specs, bits);
        prop_assert_eq!(optimized, expected, "diverged on {:?} {:?}", specs, bits);
    }
}
