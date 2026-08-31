//! Per-object applicability classification behind two generation caches.
//!
//! One engine instance lives alongside the kernel store and owns all
//! mutable engine state (the caches). Each request supplies a checkout
//! snapshot taken once, a typed query context, and the candidate batch;
//! distinct anchors resolve once per batch, never once per candidate.

use std::collections::HashMap;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use super::super::anchor::{evaluate_non_git, AnchorCondition, AnchorEvaluation, AnchorRowSpec};
use super::super::scope::{
    scope_matches, CanonicalScope, MatchOutcome, ScopeMatchContext, ScopeTermSpec,
};
use super::super::QueryContext;
use super::cache::{TwoGenerationCache, GENERATION_CAP};
use super::checkout::{CheckoutSnapshot, EvalBudget};
use super::checks::{run_cheap_check, CheckOutcome};
use super::payloads::{CheckSpec, ObjectApplicabilitySpec};
use super::resolve::{GitConditionOutcome, ResolutionLadder};

/// Applicability state of one object at one checkout. Everything except
/// `Current` is blocked from auto-injection and reachable only through an
/// explicitly labeled search path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ApplicabilityState {
    Current,
    /// The anchor condition definitely does not hold at this checkout.
    Historical,
    /// The object's scope does not match the query context.
    OutOfScope,
    /// Unresolvable anchor, ambiguity, malformed scope, missing context, or
    /// exhausted budget — never presented as current.
    Uncertain,
    /// Uncommitted paths overlap the object's affected paths.
    DirtyTreeUncertain,
    /// A cheap check failed; read repair records the observation.
    Stale,
    /// The object was lifecycle-invalidated before applicability ran.
    LifecycleInvalidated,
}

impl ApplicabilityState {
    /// Mandatory state label consumers surface on explicit search results.
    pub fn label(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Historical => "historical",
            Self::OutOfScope => "out_of_scope",
            Self::Uncertain => "uncertain",
            Self::DirtyTreeUncertain => "dirty_tree_uncertain",
            Self::Stale => "stale",
            Self::LifecycleInvalidated => "lifecycle_invalidated",
        }
    }

    pub fn blocks_auto_injection(self) -> bool {
        self != Self::Current
    }
}

/// One retrieval candidate: identity plus the frozen rows the engine
/// classifies. The caller (retrieval, kh8.6) loads rows; the engine never
/// reads the store.
#[derive(Debug, Clone, Default)]
pub struct ApplicabilityCandidate {
    pub object_id: String,
    pub object_revision: i64,
    /// Lifecycle invalidation is orthogonal to applicability: an
    /// invalidated object is excluded before evaluation runs.
    pub lifecycle_invalidated: bool,
    pub scope_terms: Option<Vec<ScopeTermSpec>>,
    pub anchor: Option<AnchorRowSpec>,
    /// Object applicability payload (affected paths, cheap checks).
    pub payload: Option<Vec<u8>>,
}

/// A failed cheap check, handed to read repair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedCheck {
    pub check: CheckSpec,
    pub evidence: String,
}

/// Opaque handle read repair passes back to confirm a durable append for a
/// cached classification (KTD6 append-confirmed flag).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ClassificationToken(ObjectCacheKey);

/// Per-object verdict with evidence. `append_pending` marks a non-current
/// classification whose durable observation has not been confirmed yet;
/// repair retries the append before the object could auto-inject again.
#[derive(Debug, Clone)]
pub struct ObjectApplicability {
    pub object_id: String,
    pub object_revision: i64,
    pub state: ApplicabilityState,
    pub evidence: String,
    pub failed_check: Option<FailedCheck>,
    pub append_pending: bool,
    pub token: ClassificationToken,
}

/// Cache and repo-access counters for one batch; the zero-IO-on-hit
/// acceptance proof reads `graph_operations`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EvaluationStats {
    pub object_cache_hits: u64,
    pub object_cache_misses: u64,
    pub anchor_cache_hits: u64,
    pub anchor_cache_misses: u64,
    /// Object-database operations (ancestry walks, candidate windows,
    /// patch-ID computations) performed by this batch.
    pub graph_operations: u64,
}

#[derive(Debug, Clone)]
pub struct BatchEvaluation {
    pub objects: Vec<ObjectApplicability>,
    pub stats: EvaluationStats,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AnchorCacheKey {
    checkout_identity: String,
    anchor_id: String,
    payload_digest: String,
    head: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ObjectCacheKey {
    checkout_identity: String,
    object_id: String,
    object_revision: i64,
    head: String,
    dirty_fingerprint: String,
    inputs_digest: String,
}

#[derive(Debug, Clone)]
struct CachedClassification {
    state: ApplicabilityState,
    evidence: String,
    failed_check: Option<FailedCheck>,
    append_confirmed: bool,
}

/// Single owner of engine state: the two generation caches (KTD6). Owned
/// alongside the kernel store; requests borrow it together with a fresh
/// checkout snapshot.
pub struct ApplicabilityEngine {
    anchor_cache: Mutex<TwoGenerationCache<AnchorCacheKey, GitConditionOutcome>>,
    object_cache: Mutex<TwoGenerationCache<ObjectCacheKey, CachedClassification>>,
}

impl Default for ApplicabilityEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl ApplicabilityEngine {
    pub fn new() -> Self {
        Self {
            anchor_cache: Mutex::new(TwoGenerationCache::new(GENERATION_CAP)),
            object_cache: Mutex::new(TwoGenerationCache::new(GENERATION_CAP)),
        }
    }

    /// Classifies a candidate batch against one snapshot. Budget exhaustion
    /// mid-batch renders the remaining objects uncertain; nothing partial is
    /// cached.
    pub fn evaluate_batch(
        &self,
        snapshot: &CheckoutSnapshot,
        query: &QueryContext,
        scope_context: &ScopeMatchContext,
        candidates: &[ApplicabilityCandidate],
        budget: &EvalBudget,
    ) -> BatchEvaluation {
        let mut stats = EvaluationStats::default();
        let ladder = ResolutionLadder::new(snapshot, budget);
        let scope_context = scope_context.clone().with_head_commit(snapshot.head());
        // Distinct anchors resolve once per batch even on cache misses. The
        // memo key matches the anchor cache key, so two candidates sharing
        // an anchor id but carrying different rows can never alias.
        let mut batch_anchor_memo: HashMap<AnchorCacheKey, GitConditionOutcome> = HashMap::new();
        let mut objects = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let token = ClassificationToken(self.object_cache_key(
                snapshot,
                query,
                &scope_context,
                candidate,
            ));
            if candidate.lifecycle_invalidated {
                objects.push(finished(
                    candidate,
                    token,
                    Classification::terminal(
                        ApplicabilityState::LifecycleInvalidated,
                        "object lifecycle-invalidated before applicability evaluation",
                    ),
                ));
                continue;
            }
            if budget.is_exhausted() {
                objects.push(finished(
                    candidate,
                    token,
                    Classification::uncacheable(
                        ApplicabilityState::Uncertain,
                        "evaluation budget exhausted before this object",
                    ),
                ));
                continue;
            }
            if let Some(cached) = self.object_cache.lock().expect("cache lock").get(&token.0) {
                stats.object_cache_hits += 1;
                objects.push(ObjectApplicability {
                    object_id: candidate.object_id.clone(),
                    object_revision: candidate.object_revision,
                    state: cached.state,
                    evidence: cached.evidence,
                    failed_check: cached.failed_check,
                    append_pending: cached.state.blocks_auto_injection()
                        && !cached.append_confirmed,
                    token,
                });
                continue;
            }
            stats.object_cache_misses += 1;
            let classification = self.classify(
                query,
                &scope_context,
                &ladder,
                &mut batch_anchor_memo,
                &mut stats,
                candidate,
            );
            if classification.cacheable {
                self.object_cache.lock().expect("cache lock").insert(
                    token.0.clone(),
                    CachedClassification {
                        state: classification.state,
                        evidence: classification.evidence.clone(),
                        failed_check: classification.failed_check.clone(),
                        append_confirmed: false,
                    },
                );
            }
            objects.push(finished(candidate, token, classification));
        }
        // Read the counter once for the whole batch so hit paths cannot hide
        // graph work behind branch placement.
        stats.graph_operations = ladder.graph_operations();
        BatchEvaluation { objects, stats }
    }

    /// Marks the durable applicability append for `token` as landed, so
    /// later cache hits stop retrying it.
    pub fn confirm_durable_append(&self, token: &ClassificationToken) {
        self.object_cache
            .lock()
            .expect("cache lock")
            .update(&token.0, |cached| cached.append_confirmed = true);
    }

    fn classify(
        &self,
        query: &QueryContext,
        scope_context: &ScopeMatchContext,
        ladder: &ResolutionLadder<'_>,
        batch_anchor_memo: &mut HashMap<AnchorCacheKey, GitConditionOutcome>,
        stats: &mut EvaluationStats,
        candidate: &ApplicabilityCandidate,
    ) -> Classification {
        let snapshot = ladder.snapshot();
        let budget = ladder.budget();
        // Scope gate.
        if let Some(terms) = &candidate.scope_terms {
            let scope = match CanonicalScope::from_term_specs(terms) {
                Ok(scope) => scope,
                Err(error) => {
                    return Classification::terminal(
                        ApplicabilityState::Uncertain,
                        format!("malformed scope: {error}"),
                    );
                }
            };
            match scope_matches(&scope, scope_context, ladder) {
                MatchOutcome::Matches => {}
                MatchOutcome::DoesNotMatch => {
                    return Classification::terminal(
                        ApplicabilityState::OutOfScope,
                        "scope does not match the query context",
                    );
                }
                MatchOutcome::Uncertain => {
                    return Classification::terminal(
                        ApplicabilityState::Uncertain,
                        "scope match is unresolvable in this context",
                    );
                }
            }
        }
        // Anchor gate.
        if let Some(anchor) = &candidate.anchor {
            match self.evaluate_anchor(snapshot, query, ladder, batch_anchor_memo, stats, anchor) {
                AnchorVerdict::Holds => {}
                AnchorVerdict::Historical(evidence) => {
                    return Classification::terminal(ApplicabilityState::Historical, evidence);
                }
                AnchorVerdict::Uncertain(evidence) => {
                    let state = ApplicabilityState::Uncertain;
                    return if budget.is_exhausted() {
                        Classification::uncacheable(state, evidence)
                    } else {
                        Classification::terminal(state, evidence)
                    };
                }
            }
        }
        // Dirty-tree gate and cheap checks read the object payload. A
        // present-but-undecodable payload fails closed: the declared paths
        // and checks are unknowable, so the object is uncertain, never
        // silently current.
        let spec = match ObjectApplicabilitySpec::decode(candidate.payload.as_deref()) {
            Ok(spec) => spec,
            Err(_) => {
                return Classification::terminal(
                    ApplicabilityState::Uncertain,
                    "object applicability payload is undecodable",
                );
            }
        };
        if let Some(spec) = &spec {
            if let Some(path) = dirty_overlap(snapshot, &spec.affected_paths) {
                return Classification::terminal(
                    ApplicabilityState::DirtyTreeUncertain,
                    format!("uncommitted path {path} overlaps affected paths"),
                );
            }
            for check in &spec.checks {
                match run_cheap_check(snapshot, check, budget) {
                    CheckOutcome::Passed => {}
                    CheckOutcome::Failed { evidence } => {
                        return Classification {
                            state: ApplicabilityState::Stale,
                            failed_check: Some(FailedCheck {
                                check: check.clone(),
                                evidence: evidence.clone(),
                            }),
                            evidence,
                            cacheable: true,
                        };
                    }
                    CheckOutcome::Unsupported { evidence } | CheckOutcome::Invalid { evidence } => {
                        return Classification::terminal(ApplicabilityState::Uncertain, evidence);
                    }
                    CheckOutcome::BudgetExhausted => {
                        return Classification::uncacheable(
                            ApplicabilityState::Uncertain,
                            "evaluation budget exhausted during cheap checks",
                        );
                    }
                }
            }
        }
        Classification::terminal(
            ApplicabilityState::Current,
            "anchor holds at HEAD and all checks pass",
        )
    }

    fn evaluate_anchor(
        &self,
        snapshot: &CheckoutSnapshot,
        query: &QueryContext,
        ladder: &ResolutionLadder<'_>,
        batch_anchor_memo: &mut HashMap<AnchorCacheKey, GitConditionOutcome>,
        stats: &mut EvaluationStats,
        anchor: &AnchorRowSpec,
    ) -> AnchorVerdict {
        let condition = match AnchorCondition::decode(anchor) {
            Ok(condition) => condition,
            Err(error) => return AnchorVerdict::Uncertain(format!("undecodable anchor: {error}")),
        };
        match evaluate_non_git(&condition, query) {
            AnchorEvaluation::Holds => return AnchorVerdict::Holds,
            AnchorEvaluation::DoesNotHold { historical } => {
                return AnchorVerdict::Historical(historical_evidence(historical));
            }
            AnchorEvaluation::Uncertain => {
                return AnchorVerdict::Uncertain(
                    "anchor needs context the query did not provide".to_string(),
                );
            }
            AnchorEvaluation::NeedsGitResolution => {}
        }
        let AnchorCondition::Git(git_condition) = &condition else {
            unreachable!("NeedsGitResolution is only reported for git conditions");
        };
        let key = AnchorCacheKey {
            checkout_identity: snapshot.identity().to_string(),
            anchor_id: anchor.anchor_id.clone(),
            payload_digest: digest_optional(anchor.payload.as_deref()),
            head: snapshot.head().to_string(),
        };
        let outcome = if let Some(outcome) = batch_anchor_memo.get(&key) {
            *outcome
        } else {
            let cached = self.anchor_cache.lock().expect("cache lock").get(&key);
            let outcome = match cached {
                Some(outcome) => {
                    stats.anchor_cache_hits += 1;
                    outcome
                }
                None => {
                    stats.anchor_cache_misses += 1;
                    let outcome = ladder.evaluate(git_condition);
                    // Budget-driven uncertainty is transient; caching it
                    // would pin a degraded verdict to this (HEAD, anchor).
                    if outcome != GitConditionOutcome::Uncertain || !ladder.budget_was_exhausted() {
                        self.anchor_cache
                            .lock()
                            .expect("cache lock")
                            .insert(key.clone(), outcome);
                    }
                    outcome
                }
            };
            batch_anchor_memo.insert(key, outcome);
            outcome
        };
        match outcome {
            GitConditionOutcome::Holds => AnchorVerdict::Holds,
            GitConditionOutcome::DoesNotHold { historical } => {
                AnchorVerdict::Historical(historical_evidence(historical))
            }
            GitConditionOutcome::Uncertain => {
                AnchorVerdict::Uncertain("anchor commit did not resolve against HEAD".to_string())
            }
        }
    }

    fn object_cache_key(
        &self,
        snapshot: &CheckoutSnapshot,
        query: &QueryContext,
        scope_context: &ScopeMatchContext,
        candidate: &ApplicabilityCandidate,
    ) -> ObjectCacheKey {
        ObjectCacheKey {
            checkout_identity: snapshot.identity().to_string(),
            object_id: candidate.object_id.clone(),
            object_revision: candidate.object_revision,
            head: snapshot.head().to_string(),
            dirty_fingerprint: snapshot.dirty_fingerprint().to_string(),
            inputs_digest: inputs_digest(query, scope_context, candidate),
        }
    }
}

impl ObjectApplicability {
    /// Uncertain verdict for a candidate whose checkout could not be
    /// snapshotted; carries a degenerate token no cache entry ever matches.
    pub(super) fn uncertain_without_snapshot(
        candidate: &ApplicabilityCandidate,
        evidence: String,
    ) -> Self {
        Self {
            object_id: candidate.object_id.clone(),
            object_revision: candidate.object_revision,
            state: ApplicabilityState::Uncertain,
            evidence,
            failed_check: None,
            append_pending: false,
            token: ClassificationToken(ObjectCacheKey {
                checkout_identity: String::new(),
                object_id: candidate.object_id.clone(),
                object_revision: candidate.object_revision,
                head: String::new(),
                dirty_fingerprint: String::new(),
                inputs_digest: String::new(),
            }),
        }
    }
}

enum AnchorVerdict {
    Holds,
    Historical(String),
    Uncertain(String),
}

fn historical_evidence(historical: bool) -> String {
    if historical {
        "anchor validity window exited".to_string()
    } else {
        "anchor condition does not hold at this checkout".to_string()
    }
}

struct Classification {
    state: ApplicabilityState,
    evidence: String,
    failed_check: Option<FailedCheck>,
    cacheable: bool,
}

impl Classification {
    fn terminal(state: ApplicabilityState, evidence: impl Into<String>) -> Self {
        Self {
            state,
            evidence: evidence.into(),
            failed_check: None,
            cacheable: true,
        }
    }

    fn uncacheable(state: ApplicabilityState, evidence: impl Into<String>) -> Self {
        Self {
            state,
            evidence: evidence.into(),
            failed_check: None,
            cacheable: false,
        }
    }
}

fn finished(
    candidate: &ApplicabilityCandidate,
    token: ClassificationToken,
    classification: Classification,
) -> ObjectApplicability {
    // Lifecycle invalidation is a store-side verdict with no checkout
    // evidence to append; every other blocking state starts append-pending.
    let append_pending = classification.state.blocks_auto_injection()
        && classification.state != ApplicabilityState::LifecycleInvalidated;
    ObjectApplicability {
        object_id: candidate.object_id.clone(),
        object_revision: candidate.object_revision,
        state: classification.state,
        evidence: classification.evidence,
        failed_check: classification.failed_check,
        append_pending,
        token,
    }
}

/// A dirty path overlaps an affected path when they are equal or one is a
/// directory prefix of the other (untracked directories are recorded as a
/// single collapsed entry).
fn dirty_overlap(snapshot: &CheckoutSnapshot, affected_paths: &[String]) -> Option<String> {
    if affected_paths.is_empty() {
        return None;
    }
    let dirty = snapshot.dirty_paths();
    for dirty_path in dirty {
        for affected in affected_paths {
            if paths_overlap(dirty_path, affected) {
                return Some(dirty_path.to_string());
            }
        }
    }
    None
}

fn paths_overlap(a: &str, b: &str) -> bool {
    let a = a.trim_end_matches('/');
    let b = b.trim_end_matches('/');
    a == b
        || a.strip_prefix(b).is_some_and(|rest| rest.starts_with('/'))
        || b.strip_prefix(a).is_some_and(|rest| rest.starts_with('/'))
}

fn digest_optional(payload: Option<&[u8]>) -> String {
    let mut hash = Sha256::new();
    hash.update(payload.unwrap_or_default());
    format!("{:x}", hash.finalize())
}

/// Digest over every non-snapshot input that can change the verdict, so a
/// cache entry can never answer for a different query context, scope
/// context, payload, or anchor row.
fn inputs_digest(
    query: &QueryContext,
    scope_context: &ScopeMatchContext,
    candidate: &ApplicabilityCandidate,
) -> String {
    let mut hash = Sha256::new();
    hash.update(b"mc-applicability-inputs-v1\0");
    // Only the context fields the candidate's anchor kind reads enter the
    // digest, so an unrelated context change (a fresh query instant, say)
    // cannot evict every cached classification.
    let anchor_kind = candidate
        .anchor
        .as_ref()
        .map(|anchor| anchor.anchor_kind.as_str())
        .unwrap_or_default();
    let relevant: &[Option<&str>] = match anchor_kind {
        "exact" => &[query.exact_token.as_deref()],
        "deployment_revision" => &[query.deployment_revision.as_deref()],
        "config_revision" => &[query.config_revision.as_deref()],
        "platform_version" => &[query.platform_version.as_deref()],
        _ => &[],
    };
    for field in relevant {
        hash.update(field.unwrap_or("<none>").as_bytes());
        hash.update(b"\0");
    }
    if anchor_kind == "wall_clock_interval" {
        hash.update(
            query
                .query_instant_ms
                .map(|instant| instant.to_string())
                .unwrap_or_else(|| "<none>".to_string())
                .as_bytes(),
        );
    }
    hash.update(b"\0");
    for dimension in super::super::Dimension::ALL {
        hash.update(
            scope_context
                .value(dimension)
                .unwrap_or("<none>")
                .as_bytes(),
        );
        hash.update(b"\0");
    }
    if let Some(terms) = &candidate.scope_terms {
        hash.update(format!("{terms:?}").as_bytes());
    }
    hash.update(b"\0");
    if let Some(anchor) = &candidate.anchor {
        hash.update(format!("{anchor:?}").as_bytes());
    }
    hash.update(b"\0");
    hash.update(candidate.payload.as_deref().unwrap_or_default());
    format!("{:x}", hash.finalize())
}
