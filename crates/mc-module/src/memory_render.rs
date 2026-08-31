//! This module performs pure rendering for claim-mirror and session-history prompt surfaces.

use crate::decay_render::{render_decayed_compartments, DecayRenderCompartment};
use mc_store::claim_mirror::{ClaimMirrorLifecycle, CommittedClaimMirrorRow};
use std::cmp::Ordering;

/// `<session-history>` is never omitted so the provider prompt-cache retains a stable breakpoint.
/// Omitting `<session-history>` would shift subsequent prompt bytes and invalidate the cache.
pub const M0_EMPTY_BODY: &str = "<session-history></session-history>";
/// `M1_PLACEHOLDER` keeps the m1 delta block non-empty when it has no new content.
/// The m1 block remains non-empty to preserve the provider prompt-cache breakpoint.
pub const M1_PLACEHOLDER: &str = "(no new content since last materialization)";
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

/// `MEMORY_CATEGORY_ORDER` defines the canonical project-memory categories in render order.
pub(crate) const MEMORY_CATEGORY_ORDER: [&str; 5] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];

pub(crate) const POSITIVE_MEMORY_CATEGORIES: [&str; 12] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
    "USER_DIRECTIVES",
    "USER_PREFERENCES",
    "CONFIG_DEFAULTS",
    "ARCHITECTURE_DECISIONS",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];

pub(crate) fn is_positive_memory_category(category: &str) -> bool {
    POSITIVE_MEMORY_CATEGORIES.contains(&category)
}

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MirroredClaimMemoryError {
    Inactive {
        public_claim_id: String,
    },
    MissingCategory {
        public_claim_id: String,
    },
    NonPositiveCategory {
        public_claim_id: String,
        category: String,
    },
    MissingImportance {
        public_claim_id: String,
    },
}

impl std::fmt::Display for MirroredClaimMemoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Inactive { public_claim_id } => {
                write!(f, "mirrored claim {public_claim_id} is inactive")
            }
            Self::MissingCategory { public_claim_id } => {
                write!(f, "mirrored claim {public_claim_id} has no category")
            }
            Self::NonPositiveCategory {
                public_claim_id,
                category,
            } => write!(
                f,
                "mirrored claim {public_claim_id} has non-positive category {category}"
            ),
            Self::MissingImportance { public_claim_id } => {
                write!(f, "mirrored claim {public_claim_id} has no importance")
            }
        }
    }
}

impl std::error::Error for MirroredClaimMemoryError {}

impl TryFrom<&CommittedClaimMirrorRow> for MirroredClaimMemory {
    type Error = MirroredClaimMemoryError;

    fn try_from(row: &CommittedClaimMirrorRow) -> Result<Self, Self::Error> {
        if row.lifecycle != ClaimMirrorLifecycle::Active {
            return Err(MirroredClaimMemoryError::Inactive {
                public_claim_id: row.public_claim_id.clone(),
            });
        }
        let category = row
            .attributes
            .get("category")
            .and_then(serde_json::Value::as_str)
            .filter(|category| !category.is_empty())
            .ok_or_else(|| MirroredClaimMemoryError::MissingCategory {
                public_claim_id: row.public_claim_id.clone(),
            })?;
        // Only positive categories reach native surfaces because native surfaces do not render warnings.
        // Native surfaces filter non-positive categories so warning records do not render as facts.
        if !is_positive_memory_category(category) {
            return Err(MirroredClaimMemoryError::NonPositiveCategory {
                public_claim_id: row.public_claim_id.clone(),
                category: category.to_string(),
            });
        }
        let importance = row
            .attributes
            .get("importance")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| MirroredClaimMemoryError::MissingImportance {
                public_claim_id: row.public_claim_id.clone(),
            })?;
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
    // `<project-memory>` continuation lines must remain indented because m0 byte accounting and the prompt cache depend on its line structure.
    let content = escape_xml_content(&claim.content[..end]).replace('\n', "\n  ");
    format!("{}{source}: {content}", claim.public_claim_id)
}

/// Native surfaces filter non-positive categories because callers can construct `MirroredClaimMemory` directly and native surfaces lack a warning renderer.
pub fn render_claim_memory_block(claims: &[MirroredClaimMemory], wrapper: &str) -> String {
    let mut ordered = claims
        .iter()
        .filter(|claim| is_positive_memory_category(&claim.category))
        .collect::<Vec<_>>();
    if ordered.is_empty() {
        return String::new();
    }
    ordered.sort_by(|left, right| claim_render_order(left, right));
    let mut lines = Vec::with_capacity(ordered.len() * 2 + 2);
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

/// The caller token-trims user memories; an empty set renders as an empty string.
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

/// The caller supplies system-role content deduplicated in first-ordinal order.
/// The renderer preserves system-role content byte-for-byte.
/// The renderer does not escape system-role content, preserving original prompt bytes in each entry.
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

/// `render_m0` receives blocks the caller has already chosen and token-budget-trimmed.
/// `render_m0` does not choose which rows or history compartments fit the budget.
pub struct M0Inputs<'a> {
    /// Callers pass an empty string when no `<project-docs>` block exists.
    pub project_docs: &'a str,
    /// The caller token-trims user-profile memory.
    pub user_profile: &'a [String],
    /// The caller deduplicates system-role fragments by ordinal before passing them to `render_m0`.
    /// The caller orders system-role fragments by first appearance before passing them to `render_m0`.
    pub covered_system_messages: &'a [String],
    /// The caller supplies chronologically ordered, token-trimmed history; the renderer applies decay.
    pub compartments: &'a [DecayRenderCompartment],
    /// `history_budget_tokens` is measured before applying the pressure multiplier.
    pub history_budget_tokens: f64,
    /// Values below 1 use an effective multiplier of 1; larger values tighten the effective budget and increase decay.
    /// `decay_pressure_multiplier` produces `effective_budget = history_budget_tokens / max(1, decay_pressure_multiplier)`.
    pub decay_pressure_multiplier: f64,
}

/// `render_m0` expects the caller to pre-trim each sub-block.
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

/// block.
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

#[cfg(test)]
mod tests {
    use super::*;
    use mc_core::claim_operation::sha256_hex_utf8;
    use serde_json::json;

    fn mirrored_row(category: Option<&str>) -> CommittedClaimMirrorRow {
        let content = "Keep this project fact.";
        let content_digest = sha256_hex_utf8(content);
        let mut attributes = json!({ "importance": 80 });
        if let Some(category) = category {
            attributes["category"] = json!(category);
        }
        CommittedClaimMirrorRow {
            public_claim_id: "mcm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            project_id: 41,
            revision_locator: format!("mcm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/r1/{content_digest}"),
            content: content.to_string(),
            content_digest,
            attributes,
            lifecycle: ClaimMirrorLifecycle::Active,
            applicability: json!({}),
            policy: json!({}),
            provenance_label: None,
            project_generation: 1,
            policy_generation: 1,
        }
    }

    #[test]
    fn positive_categories_render_and_non_positive_categories_are_typed_rejections() {
        for category in POSITIVE_MEMORY_CATEGORIES {
            let claim = MirroredClaimMemory::try_from(&mirrored_row(Some(category)))
                .expect("positive category must render");
            assert_eq!(claim.category, category);
        }

        assert!(matches!(
            MirroredClaimMemory::try_from(&mirrored_row(Some("REJECTED_APPROACH"))),
            Err(MirroredClaimMemoryError::NonPositiveCategory { category, .. })
                if category == "REJECTED_APPROACH"
        ));
        assert!(matches!(
            MirroredClaimMemory::try_from(&mirrored_row(Some("FUTURE_NEGATIVE_CATEGORY"))),
            Err(MirroredClaimMemoryError::NonPositiveCategory { category, .. })
                if category == "FUTURE_NEGATIVE_CATEGORY"
        ));
        assert!(matches!(
            MirroredClaimMemory::try_from(&mirrored_row(None)),
            Err(MirroredClaimMemoryError::MissingCategory { .. })
        ));
    }

    #[test]
    fn render_boundary_drops_non_positive_categories_built_without_the_conversion() {
        let hand_built = |category: &str, content: &str| MirroredClaimMemory {
            public_claim_id: format!("mcm_{}", "a".repeat(32)),
            revision_locator: format!("mcm_{}/r1/{}", "a".repeat(32), "b".repeat(64)),
            project_id: 41,
            category: category.to_string(),
            content: content.to_string(),
            importance: 80,
            provenance_label: None,
        };

        let mixed = [
            hand_built("PROJECT_RULES", "Keep this project fact."),
            hand_built("REJECTED_APPROACH", "Do not resurrect the shelved design."),
            hand_built(
                "FUTURE_NEGATIVE_CATEGORY",
                "Unknown categories stay silent.",
            ),
        ];
        let block = render_claim_memory_block(&mixed, "project-memory");
        assert!(block.contains("Keep this project fact."));
        assert!(!block.contains("REJECTED_APPROACH"));
        assert!(!block.contains("Do not resurrect the shelved design."));
        assert!(!block.contains("FUTURE_NEGATIVE_CATEGORY"));
        assert!(!block.contains("Unknown categories stay silent."));

        let only_negative = [hand_built("REJECTED_APPROACH", "Shelved design.")];
        assert_eq!(
            render_claim_memory_block(&only_negative, "project-memory"),
            ""
        );
    }

    /// The pattern requires exactly one `export const <name>` declaration followed by a non-identifier character so prefixed constant names cannot match.
    fn typescript_string_array<'a>(source: &'a str, name: &str) -> Vec<&'a str> {
        let declaration = format!("export const {name}");
        let tails = source
            .match_indices(&declaration)
            .map(|(index, matched)| &source[index + matched.len()..])
            .filter(|tail| {
                !tail
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            })
            .collect::<Vec<_>>();
        assert_eq!(
            tails.len(),
            1,
            "expected exactly one `export const {name}` declaration"
        );
        let body = tails[0]
            .split("];")
            .next()
            .unwrap_or_else(|| panic!("unterminated TypeScript {name} array"));
        body.lines()
            .filter_map(|line| line.trim().strip_prefix('"'))
            .filter_map(|line| line.split('"').next())
            .collect()
    }

    #[test]
    fn positive_category_vocabulary_matches_typescript() {
        let source =
            include_str!("../../../packages/plugin/src/features/magic-context/memory/constants.ts");

        assert_eq!(
            typescript_string_array(source, "CATEGORY_PRIORITY"),
            POSITIVE_MEMORY_CATEGORIES
        );

        // CATEGORY_PRIORITY only orders rows; writable taxonomies determine category validity.
        // The test gates mirror-row categories against writable taxonomies so newly writable positive categories fail instead of being dropped.
        for name in ["V2_MEMORY_CATEGORIES", "PROMOTABLE_CATEGORIES"] {
            let categories = typescript_string_array(source, name);
            assert!(!categories.is_empty(), "TypeScript {name} parsed as empty");
            for category in categories {
                assert!(
                    is_positive_memory_category(category),
                    "TypeScript {name} entry {category} is missing from POSITIVE_MEMORY_CATEGORIES"
                );
            }
        }
    }

    #[test]
    fn render_order_is_a_prefix_of_the_positive_vocabulary() {
        // `claim_render_order` must keep `MEMORY_CATEGORY_ORDER` equal to the vocabulary prefix of `POSITIVE_MEMORY_CATEGORIES` so sorting and inclusion remain aligned.
        assert_eq!(
            MEMORY_CATEGORY_ORDER[..],
            POSITIVE_MEMORY_CATEGORIES[..MEMORY_CATEGORY_ORDER.len()]
        );
    }
}
