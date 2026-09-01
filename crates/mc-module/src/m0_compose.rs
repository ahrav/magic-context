//! This module reads a session's durable state.
//! The durable state includes compartments, memories or the workspace union, the user profile, and project docs.
//! This module composes frozen m0 bytes and watermarks that HARD persists.
//!
//! This module produces bytes but does not classify HARD versus SOFT.
//! `apply_once` feeds these bytes into the cache core.
//! This module returns identical bytes for identical store contents, `now_ms`, and `budget`.
//! The caller supplies frozen `now_ms`; this module never reads a live clock.

use std::collections::{BTreeSet, HashSet};

use mc_core::claim_operation::SnapshotVector;
use mc_store::{McStore, McStoreError};
use sha2::{Digest, Sha256};

use crate::compartment_coverage::{resolve_coverage, CoverageGap};
use crate::decay_render::{extract_m0_block, DecayRenderCompartment};
use crate::memory_render::{
    is_positive_memory_category, render_claim_memory_block, render_claim_memory_line, render_m0,
    M0Inputs, MirroredClaimMemory,
};
use crate::project_docs::read_project_docs_canonical;

pub(crate) const MEMORY_MURAL_BLOCK: &str =
    "<memory-mural>\nThe project memory mural image follows.\n</memory-mural>";

#[derive(Debug)]
pub enum M0ComposeError {
    Store(McStoreError),
    /// The stored compartment ranges overlap or otherwise fail strict ordering.
    CoverageGap(CoverageGap),
}

impl std::fmt::Display for M0ComposeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            M0ComposeError::Store(e) => write!(f, "store: {e}"),
            M0ComposeError::CoverageGap(g) => write!(f, "{g}"),
        }
    }
}
impl std::error::Error for M0ComposeError {}
impl From<McStoreError> for M0ComposeError {
    fn from(e: McStoreError) -> Self {
        M0ComposeError::Store(e)
    }
}

/// `M0Composition` holds bytes and watermarks that HARD persists atomically in `ModuleMeta`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct M0Composition {
    /// `m0_bytes` contains docs, the profile, decayed compartments, and memories.
    pub m0_bytes: String,
    /// `mural` follows the m0 text block on the OpenCode wire.
    pub mural: Option<M0MuralBlock>,
    /// `boundary_id` anchors cache reverts at the last covered raw message.
    /// `boundary_id` is empty when no compartments are summarized, leaving the live array as the tail.
    pub boundary_id: String,
    /// `coverage_ordinal` marks m0's tail-trim point.
    /// `coverage_ordinal` is `None` when no compartments exist.
    pub coverage_ordinal: Option<u64>,
    /// `first_covered_ordinal` is the first covered ordinal; the caller rejects live items below it to prevent trimming an uncovered leading gap.
    pub first_covered_ordinal: Option<u64>,
    /// `folded_compartment_seq` advances only on a HARD.
    pub folded_compartment_seq: i64,
    pub rendered_revision_locators: Vec<String>,
    /// The claim rows supply this generation vector.
    pub claim_snapshot_vector: Option<SnapshotVector>,
    /// `docs_hash` records the project-docs version included in m0; it does not trigger HARD.
    /// The next natural HARD re-reads current docs.
    pub docs_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct M0MuralInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub data_url: Option<String>,
    #[serde(default, alias = "content_epoch")]
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct M0MuralBlock {
    pub data_url: String,
    pub content_hash: String,
}

/// config).
pub struct M0ComposeInputs<'a> {
    pub session_id: &'a str,
    /// `project_path` comes from the route binding; the request body cannot override it.
    /// request body).
    pub project_path: &'a str,
    /// `project_directory` identifies the directory containing `ARCHITECTURE.md` and `STRUCTURE.md`.
    pub project_directory: &'a str,
    pub now_ms: i64,
    /// `history_budget_tokens` limits frozen rendering.
    /// The renderer produces estimator-independent output when all compartments fit.
    pub history_budget_tokens: f64,
    /// Passing system-role content covered by the current fold keeps m0 composition deterministic and replayable.
    /// replayable.
    pub covered_system_messages: &'a [String],
    /// Disabled memory removes both project memories and the user-profile memory block.
    pub memory_enabled: bool,
    pub memory_budget_tokens: f64,
    pub user_profile_budget_tokens: f64,
    /// `inject_docs` matches whether the TypeScript materializer includes the project-docs block.
    pub inject_docs: bool,
    /// `temporal_awareness` gates temporal heading dates at render time, including rows persisted by a prior pass.
    pub temporal_awareness: bool,
    /// The host resolves and capability-gates OpenCode-only image bytes before passing them here.
    pub mural: Option<&'a M0MuralInput>,
}

pub(crate) fn resolved_mural(input: Option<&M0MuralInput>) -> Option<M0MuralBlock> {
    let input = input?;
    if !input.enabled || !input.supports_vision {
        return None;
    }
    let data_url = input
        .data_url
        .as_deref()
        .filter(|value| !value.is_empty())?
        .to_string();
    let content_hash = input
        .content_hash
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{:x}", Sha256::digest(data_url.as_bytes())));
    Some(M0MuralBlock {
        data_url,
        content_hash,
    })
}

pub(crate) fn trim_claims_to_budget(
    claims: &[MirroredClaimMemory],
    budget_tokens: f64,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> Vec<MirroredClaimMemory> {
    let budget = budget_tokens.max(1.0);
    // `rendered_revision_locators` includes only claims rendered by `render_claim_memory_block`.
    let mut ordered = claims
        .iter()
        .filter(|claim| is_positive_memory_category(&claim.category))
        .cloned()
        .collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        right
            .importance
            .cmp(&left.importance)
            .then_with(|| left.public_claim_id.cmp(&right.public_claim_id))
    });
    let project_count = ordered
        .iter()
        .map(|claim| claim.project_id)
        .collect::<HashSet<_>>()
        .len()
        .max(1);
    let floor = budget / project_count as f64;
    let mut selected = Vec::new();
    let mut selected_ids = HashSet::new();
    let mut categories = HashSet::<String>::new();
    let mut used = estimate_tokens("<project-memory>\n</project-memory>") as f64;
    for project_id in ordered
        .iter()
        .map(|claim| claim.project_id)
        .collect::<BTreeSet<_>>()
    {
        let mut member_used = 0.0;
        for claim in ordered
            .iter()
            .filter(|claim| claim.project_id == project_id)
        {
            let mut cost = estimate_tokens(&(render_claim_memory_line(claim) + "\n"));
            if !categories.contains(&claim.category) {
                cost += estimate_tokens(&format!("<{}>\n</{}>\n", claim.category, claim.category));
            }
            let cost = cost as f64;
            if member_used + cost > floor || used + cost > budget {
                continue;
            }
            member_used += cost;
            used += cost;
            categories.insert(claim.category.clone());
            selected_ids.insert(claim.public_claim_id.clone());
            selected.push(claim.clone());
        }
    }
    for claim in ordered {
        if selected_ids.contains(&claim.public_claim_id) {
            continue;
        }
        let mut cost = estimate_tokens(&(render_claim_memory_line(&claim) + "\n"));
        if !categories.contains(&claim.category) {
            cost += estimate_tokens(&format!("<{}>\n</{}>\n", claim.category, claim.category));
        }
        if used + cost as f64 > budget {
            continue;
        }
        used += cost as f64;
        categories.insert(claim.category.clone());
        selected_ids.insert(claim.public_claim_id.clone());
        selected.push(claim);
    }
    selected
}

pub(crate) fn trim_user_profile_to_budget(
    profile: Vec<String>,
    budget_tokens: f64,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> Vec<String> {
    let mut used = 0usize;
    profile
        .into_iter()
        .filter(|content| {
            let cost = estimate_tokens(&format!("- {content}")) + 4;
            if (used + cost) as f64 > budget_tokens.max(1.0) {
                return false;
            }
            used += cost;
            true
        })
        .collect()
}

/// The history estimate counts only the rendered `<session-history>` slice to match the history budget.
fn history_slice_tokens(m0_text: &str, estimate_tokens: impl Fn(&str) -> usize) -> usize {
    extract_m0_block(m0_text, "session-history").map_or(0, |slice| estimate_tokens(&slice))
}

/// The renderer retries at most three times while history tokens exceed 105% of a positive budget.
/// After three retries, the function returns the last render even if history tokens exceed 105% of the budget.
fn render_m0_with_decay_pressure_retry(
    inputs: &M0Inputs<'_>,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> String {
    let render = |decay_pressure_multiplier| {
        render_m0(
            &M0Inputs {
                project_docs: inputs.project_docs,
                user_profile: inputs.user_profile,
                covered_system_messages: inputs.covered_system_messages,
                compartments: inputs.compartments,
                history_budget_tokens: inputs.history_budget_tokens,
                decay_pressure_multiplier,
            },
            estimate_tokens,
        )
    };
    let mut decay_pressure_multiplier = 1.0;
    let mut m0_bytes = render(decay_pressure_multiplier);
    let mut attempts = 0;
    while inputs.history_budget_tokens > 0.0
        && history_slice_tokens(&m0_bytes, estimate_tokens) as f64
            > inputs.history_budget_tokens * 1.05
        && attempts < 3
    {
        decay_pressure_multiplier *= 1.15;
        m0_bytes = render(decay_pressure_multiplier);
        attempts += 1;
    }
    m0_bytes
}

pub fn compose_m0_from_claim_mirror(
    store: &McStore,
    inputs: &M0ComposeInputs<'_>,
    claims: &[MirroredClaimMemory],
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> Result<M0Composition, M0ComposeError> {
    compose_m0(store, inputs, claims, estimate_tokens)
}

fn compose_m0(
    store: &McStore,
    inputs: &M0ComposeInputs<'_>,
    claims: &[MirroredClaimMemory],
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> Result<M0Composition, M0ComposeError> {
    let compartments = store.load_compartments(inputs.session_id)?;
    let coverage = resolve_coverage(&compartments).map_err(M0ComposeError::CoverageGap)?;
    let (boundary_id, coverage_ordinal, first_covered_ordinal, folded_compartment_seq) =
        match &coverage {
            Some(c) => (
                c.boundary_id.clone(),
                Some(c.coverage_end_ordinal),
                Some(c.first_covered_ordinal),
                c.max_sequence,
            ),
            None => (String::new(), None, None, 0),
        };

    let selected_claims = if inputs.memory_enabled {
        trim_claims_to_budget(claims, inputs.memory_budget_tokens, estimate_tokens)
    } else {
        Vec::new()
    };
    let rendered_revision_locators = selected_claims
        .iter()
        .map(|claim| claim.revision_locator.clone())
        .collect();

    let user_profile = if inputs.memory_enabled {
        store.load_active_user_memories()?
    } else {
        Vec::new()
    };
    let user_profile = trim_user_profile_to_budget(
        user_profile,
        inputs.user_profile_budget_tokens,
        estimate_tokens,
    );
    let docs = if inputs.inject_docs {
        read_project_docs_canonical(inputs.project_directory)
    } else {
        crate::project_docs::ProjectDocs::default()
    };

    let decay_compartments: Vec<DecayRenderCompartment> = compartments
        .iter()
        .map(|compartment| {
            let mut rendered = DecayRenderCompartment::from(compartment);
            if !inputs.temporal_awareness {
                rendered.start_date = None;
                rendered.end_date = None;
            }
            rendered
        })
        .collect();
    let mural = resolved_mural(inputs.mural);
    let mut m0_bytes = render_m0_with_decay_pressure_retry(
        &M0Inputs {
            project_docs: &docs.rendered_block,
            user_profile: &user_profile,
            covered_system_messages: inputs.covered_system_messages,
            compartments: &decay_compartments,
            history_budget_tokens: inputs.history_budget_tokens,
            decay_pressure_multiplier: 1.0,
        },
        estimate_tokens,
    );
    let claim_memory = render_claim_memory_block(&selected_claims, "project-memory");
    if !claim_memory.is_empty() {
        m0_bytes.push_str("\n\n");
        m0_bytes.push_str(&claim_memory);
    }
    if mural.is_some() {
        m0_bytes.push_str("\n\n");
        m0_bytes.push_str(MEMORY_MURAL_BLOCK);
    }

    Ok(M0Composition {
        m0_bytes,
        mural,
        boundary_id,
        coverage_ordinal,
        first_covered_ordinal,
        folded_compartment_seq,
        rendered_revision_locators,
        claim_snapshot_vector: None,
        docs_hash: docs.canonical_hash,
    })
}
