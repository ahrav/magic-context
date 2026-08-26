//! Pure rendering for the claim mirror and session-history prompt surfaces.

use crate::decay_render::{render_decayed_compartments, DecayRenderCompartment};
use mc_store::claim_mirror::{ClaimMirrorLifecycle, CommittedClaimMirrorRow};
use std::cmp::Ordering;

/// The body for an empty session history. The `<session-history>` tag is always present
/// (never omitted) so the provider prompt-cache has a stable breakpoint to anchor on —
/// an absent block would shift the bytes after it and bust the cache.
pub const M0_EMPTY_BODY: &str = "<session-history></session-history>";
/// The non-empty placeholder emitted for the m1 delta block when it has no new content.
/// The m1 block is never fully empty because the provider prompt-cache needs a stable
/// breakpoint to anchor on, so even an empty update still emits this marker.
pub const M1_PLACEHOLDER: &str = "(no new content since last materialization)";
/// Default history budget when a caller doesn't supply one.
pub const DEFAULT_HISTORY_BUDGET_TOKENS: f64 = 60_000.0;

fn escape_xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_xml_content(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The canonical project-memory claim categories, in render order.
pub(crate) const MEMORY_CATEGORY_ORDER: [&str; 5] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirroredClaimMemory {
    pub public_claim_id: String,
    pub revision_locator: String,
    pub project_id: i64,
    pub category: String,
    pub content: String,
    pub importance: i64,
    pub provenance_label: Option<String>,
}

impl TryFrom<&CommittedClaimMirrorRow> for MirroredClaimMemory {
    type Error = String;

    fn try_from(row: &CommittedClaimMirrorRow) -> Result<Self, Self::Error> {
        if row.lifecycle != ClaimMirrorLifecycle::Active {
            return Err(format!("claim {} is not active", row.public_claim_id));
        }
        let category = row
            .attributes
            .get("category")
            .and_then(serde_json::Value::as_str)
            .filter(|category| !category.is_empty())
            .ok_or_else(|| format!("claim {} category is missing", row.public_claim_id))?;
        let importance = row
            .attributes
            .get("importance")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| format!("claim {} importance is missing", row.public_claim_id))?;
        Ok(Self {
            public_claim_id: row.public_claim_id.clone(),
            revision_locator: row.revision_locator.clone(),
            project_id: row.project_id,
            category: category.to_string(),
            content: row.content.clone(),
            importance,
            provenance_label: row.provenance_label.clone(),
        })
    }
}

fn claim_render_order(left: &MirroredClaimMemory, right: &MirroredClaimMemory) -> Ordering {
    let left_priority = MEMORY_CATEGORY_ORDER
        .iter()
        .position(|category| *category == left.category);
    let right_priority = MEMORY_CATEGORY_ORDER
        .iter()
        .position(|category| *category == right.category);
    match (left_priority, right_priority) {
        (Some(left_rank), Some(right_rank)) => left_rank
            .cmp(&right_rank)
            .then_with(|| left.public_claim_id.cmp(&right.public_claim_id)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => left
            .category
            .cmp(&right.category)
            .then_with(|| left.public_claim_id.cmp(&right.public_claim_id)),
    }
}

pub fn render_claim_memory_line(claim: &MirroredClaimMemory) -> String {
    let source = claim
        .provenance_label
        .as_deref()
        .filter(|label| !label.is_empty())
        .map(|label| format!(" [{}]", escape_xml_content(label)))
        .unwrap_or_default();
    let mut end = claim.content.len().min(64 * 1024);
    while !claim.content.is_char_boundary(end) {
        end -= 1;
    }
    let content = escape_xml_content(&claim.content[..end]);
    format!("{}{source}: {content}", claim.public_claim_id)
}

pub fn render_claim_memory_block(claims: &[MirroredClaimMemory], wrapper: &str) -> String {
    if claims.is_empty() {
        return String::new();
    }
    let mut ordered = claims.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| claim_render_order(left, right));
    let mut lines = Vec::with_capacity(claims.len() * 2 + 2);
    lines.push(format!("<{wrapper}>"));
    let mut open_category: Option<&str> = None;
    for claim in ordered {
        if open_category != Some(claim.category.as_str()) {
            if let Some(category) = open_category {
                lines.push(format!("</{}>", escape_xml_attr(category)));
            }
            open_category = Some(&claim.category);
            lines.push(format!("<{}>", escape_xml_attr(&claim.category)));
        }
        lines.push(render_claim_memory_line(claim));
    }
    if let Some(category) = open_category {
        lines.push(format!("</{}>", escape_xml_attr(category)));
    }
    lines.push(format!("</{wrapper}>"));
    lines.join("\n")
}

/// Render the `<user-profile>` baseline block: one `- <content>` line per user memory
/// (already budget-trimmed by the caller). Empty set → empty string.
pub fn render_user_profile_block(profile_lines: &[String], wrapper: &str) -> String {
    if profile_lines.is_empty() {
        return String::new();
    }
    let mut lines = Vec::with_capacity(profile_lines.len() + 2);
    lines.push(format!("<{wrapper}>"));
    for content in profile_lines {
        lines.push(format!("- {}", escape_xml_content(content)));
    }
    lines.push(format!("</{wrapper}>"));
    lines.join("\n")
}

/// Render covered system-role messages as m0 text. The caller supplies content that has
/// already been deduplicated in first-ordinal order; this function deliberately does not
/// escape it so the prompt bytes inside each entry remain the original system content.
pub fn render_covered_system_messages_block(messages: &[String]) -> String {
    if messages.is_empty() {
        return String::new();
    }
    let mut block = String::from("<covered-system-messages>");
    for content in messages {
        block.push_str("\n<covered-system-message>");
        block.push_str(content);
        block.push_str("</covered-system-message>");
    }
    block.push_str("\n</covered-system-messages>");
    block
}

/// Inputs to [`render_m0`] after the caller has already chosen and token-budget-trimmed
/// each sub-block. This renderer only assembles those blocks in order with framing; it
/// does not decide which rows or history compartments fit the budget.
pub struct M0Inputs<'a> {
    /// The pre-rendered `<project-docs>` block (empty string when absent).
    pub project_docs: &'a str,
    /// User-profile memory contents (trimmed); rendered as `- <content>` lines.
    pub user_profile: &'a [String],
    /// System-role prompt fragments whose ordinals are already covered by m0, deduplicated
    /// and ordered by their first appearance before being passed in by the caller.
    pub covered_system_messages: &'a [String],
    /// The compartment history (trimmed/ordered chronological), decay-rendered here.
    pub compartments: &'a [DecayRenderCompartment],
    /// The history budget in tokens (before the pressure multiplier).
    pub history_budget_tokens: f64,
    /// The drift-pressure multiplier (≥1): a tighter effective budget → more decay
    /// demotion. Maps to `effective_budget = budget / max(1, multiplier)`, keeping the
    /// decay curve the single source of pressure math.
    pub decay_pressure_multiplier: f64,
}

/// Compose the m0 baseline: `<project-docs>` + `<user-profile>` +
/// `<covered-system-messages>` + `<session-history>` + `<project-memory>`, joined by
/// blank lines and trimmed. The session-history block is always present (empty history
/// uses the `M0_EMPTY_BODY` placeholder — see its doc for why); the other blocks are
/// omitted when empty. `estimate_tokens` is used inside the decay renderer for its
/// budget-fit check (injected; under a loose budget the render is pure and
/// estimator-independent). This function only composes; sub-block budget trims happen in
/// the caller (they need the token estimator, a separate subsystem).
pub fn render_m0(inputs: &M0Inputs, estimate_tokens: impl Fn(&str) -> usize) -> String {
    let mut sections: Vec<String> = Vec::new();
    if !inputs.project_docs.is_empty() {
        sections.push(inputs.project_docs.to_string());
    }
    let user_profile = render_user_profile_block(inputs.user_profile, "user-profile");
    if !user_profile.is_empty() {
        sections.push(user_profile);
    }
    let covered_systems = render_covered_system_messages_block(inputs.covered_system_messages);
    if !covered_systems.is_empty() {
        sections.push(covered_systems);
    }

    let effective_budget = inputs.history_budget_tokens / inputs.decay_pressure_multiplier.max(1.0);
    let session_history =
        render_decayed_compartments(inputs.compartments, effective_budget, estimate_tokens);
    sections.push(if session_history.is_empty() {
        M0_EMPTY_BODY.to_string()
    } else {
        format!("<session-history>\n{session_history}\n</session-history>")
    });

    sections.join("\n\n").trim().to_string()
}

/// Assemble the m1 delta body from its (already-rendered) sub-blocks, in order:
/// `<memory-updates>` → `<new-compartments>` → `<new-memories>` → `<new-user-profile>`,
/// joining the non-empty pieces with newlines and wrapping them in
/// `<session-history-since>`. Each piece is an empty string when absent (no rows / no
/// change). When ALL are empty, returns the `placeholder` instead — m1 is the volatile
/// half of the cached prefix and must never be fully empty, because the provider cache
/// anchors a breakpoint at the m1 block and an empty block would shift it.
pub fn assemble_m1(
    memory_updates: &str,
    new_compartments: &str,
    new_memories: &str,
    new_user_profile: &str,
    placeholder: &str,
) -> String {
    let mut blocks: Vec<&str> = Vec::with_capacity(4);
    for piece in [
        memory_updates,
        new_compartments,
        new_memories,
        new_user_profile,
    ] {
        if !piece.is_empty() {
            blocks.push(piece);
        }
    }
    if blocks.is_empty() {
        return placeholder.to_string();
    }
    format!(
        "<session-history-since>\n{}\n</session-history-since>",
        blocks.join("\n")
    )
}

/// Render the `<new-compartments>` block: each new compartment at full-fidelity P1 (no
/// decay applies to a newly-added compartment until it folds into the baseline), joined
/// by a blank line. An empty slice returns an empty string so the caller can omit the
/// block.
/// Render the `<new-compartments>` block: each unfolded compartment at a FIXED tier (1),
/// with NO clock/age/pressure input, so the bytes are a pure function of the compartment
/// ROW fields. This row-purity is load-bearing for the m1 digest: `m1_revision_signal`
/// uses `max_compartment_seq` as the complete m1-SOFT leg for compartments BECAUSE the
/// only way these bytes change without a new sequence (a row mutation) routes to a HARD.
/// If you add a time/age/pressure-varying input here, that completeness breaks — re-read
/// the COMPLETENESS INVARIANT on `m1_revision_signal` before doing so.
pub fn render_new_compartments(
    compartments: &[&crate::decay_render::DecayRenderCompartment],
) -> String {
    if compartments.is_empty() {
        return String::new();
    }
    let bodies: Vec<String> = compartments
        .iter()
        .map(|c| crate::decay_render::render_compartment_at_tier(c, 1))
        .collect();
    format!(
        "<new-compartments>\n{}\n</new-compartments>",
        bodies.join("\n\n")
    )
}
