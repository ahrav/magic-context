//! The store → m0 byte producer for the HARD branch: read a session's durable state
//! (compartments, memories or the workspace union, user-profile, project-docs) and
//! compose the frozen m0 baseline bytes plus the watermarks the HARD persists.
//!
//! This is the BYTE producer only — it does not classify or decide HARD-vs-SOFT (that's
//! `apply_once`, which feeds these bytes into the cache core). It is pure given the store
//! contents + `now_ms` + `budget`: same inputs → same bytes, the property the frozen-m0
//! cache depends on. The expiry cutoff (`now_ms`) is passed in (frozen at the HARD by the
//! caller, never read here from a live clock) so a later defer replays identical bytes.

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

/// Why composing the HARD m0 from the store failed.
#[derive(Debug)]
pub enum M0ComposeError {
    /// A store read failed.
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

/// The composed m0 baseline: its frozen bytes plus the watermarks the HARD persists into
/// [`mc_store::ModuleMeta`] atomically with those bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct M0Composition {
    /// The frozen m0 baseline bytes (docs + profile + decayed compartments + memories).
    pub m0_bytes: String,
    /// Optional image block appended after the m0 text block on the OpenCode wire.
    pub mural: Option<M0MuralBlock>,
    /// The last raw message id covered by m0 — the cache/revert anchor. Empty when the
    /// session has no compartments (nothing summarized → no covered prefix → the whole
    /// live array is the tail).
    pub boundary_id: String,
    /// The last covered ordinal (the m0 coverage end / tail-trim point). None when there
    /// are no compartments.
    pub coverage_ordinal: Option<u64>,
    /// The FIRST covered ordinal (the leading edge of m0 coverage = the first compartment's
    /// start). None when there are no compartments. The caller fails loud if any live item
    /// sits BELOW this — it would be covered by no compartment yet trimmed as covered (a
    /// silent leading-gap drop).
    pub first_covered_ordinal: Option<u64>,
    /// The highest compartment sequence folded into m0 (advances only on a HARD).
    pub folded_compartment_seq: i64,
    /// m0 contains these rendered claim revision locators.
    pub rendered_revision_locators: Vec<String>,
    /// The claim rows supply this generation vector.
    pub claim_snapshot_vector: Option<SnapshotVector>,
    /// The canonical project-docs hash, a SNAPSHOT MARKER persisted with the bytes (NOT a
    /// HARD trigger — see `M0ContentEpoch`). Records which docs version is in m0 so the
    /// next natural HARD re-reads current docs.
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

/// The fixed expiry/budget inputs for an m0 compose, threaded from the caller so the
/// HARD freezes them (a defer replays the same bytes, never re-reading a live clock or
/// config).
pub struct M0ComposeInputs<'a> {
    pub session_id: &'a str,
    /// The project the store reads key off (resolved from the route binding, never the
    /// request body).
    pub project_path: &'a str,
    /// The project directory on disk, for reading ARCHITECTURE.md / STRUCTURE.md.
    pub project_directory: &'a str,
    /// The expiry cutoff, FROZEN at the HARD (a memory expiring after this still renders;
    /// a later defer uses the same cutoff → identical bytes).
    pub now_ms: i64,
    /// The history budget in tokens selected for this frozen render decision. The decay
    /// renderer fits the compartments to it; under a loose budget the render is estimator-independent.
    pub history_budget_tokens: f64,
    /// System-role content that is no longer in the live tail because the current fold
    /// covers its ordinal. Passing it explicitly keeps m0 composition deterministic and
    /// replayable.
    pub covered_system_messages: &'a [String],
    /// Disabled memory removes both project memories and the user-profile memory block.
    pub memory_enabled: bool,
    /// Maximum token estimate for the grouped project-memory block.
    pub memory_budget_tokens: f64,
    /// Maximum token estimate for the user-profile block.
    pub user_profile_budget_tokens: f64,
    /// Whether the TypeScript materializer would include the project-docs block.
    pub inject_docs: bool,
    /// Gate temporal heading dates at render time, including rows persisted by a prior pass.
    pub temporal_awareness: bool,
    /// OpenCode-only image bytes already resolved and capability-gated by the host.
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
    // Selection is the record of what m0 rendered: callers derive
    // `rendered_revision_locators` from the result. Dropping non-positive
    // categories here keeps that record aligned with
    // `render_claim_memory_block`, which refuses to render them, so a
    // hand-assembled warning claim cannot consume budget or be reported as
    // rendered content it never became.
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

/// Count only the rendered `<session-history>` slice, matching the history budget's scope.
fn history_slice_tokens(m0_text: &str, estimate_tokens: impl Fn(&str) -> usize) -> usize {
    extract_m0_block(m0_text, "session-history").map_or(0, |slice| estimate_tokens(&slice))
}

/// Render m0 and, when the history slice overshoots, tighten decay pressure at most three times.
/// The capped final render is retained even when its history still exceeds the slack threshold.
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

/// Read the store and compose the HARD m0 bytes + watermarks. `estimate_tokens` is the
/// token estimator used for every injection budget and the history fit.
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
    // --- compartments: the session history, coverage anchor, and folded watermark ---
    let compartments = store.load_compartments(inputs.session_id)?;
    // Store-pure coverage checks enforce strict ordering without assuming integer
    // contiguity: consumer producers may retire ordinal numbers permanently. The
    // transform layer has the live array and fails loud if a present message below
    // the coverage end is not covered by any compartment.
    let coverage = resolve_coverage(&compartments).map_err(M0ComposeError::CoverageGap)?;
    let (boundary_id, coverage_ordinal, first_covered_ordinal, folded_compartment_seq) =
        match &coverage {
            Some(c) => (
                c.boundary_id.clone(),
                Some(c.coverage_end_ordinal),
                Some(c.first_covered_ordinal),
                c.max_sequence,
            ),
            // no compartments → nothing summarized → no covered prefix
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

    // --- user-profile + project-docs ---
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

    // Compose m0 through the shared renderer after the project/profile budgets have selected
    // their candidates. History keeps its existing decay-pressure fit in this same render.
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
