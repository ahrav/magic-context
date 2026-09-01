//! Per-object applicability classification behind two generation caches.
//!
//! One engine instance lives alongside the kernel store and owns all
//! mutable engine state (the caches). Each request supplies a checkout
//! snapshot taken once, a typed query context, and the candidate batch;
//! distinct anchors resolve once per batch, never once per candidate.

use std::collections::HashMap;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use super::super::anchor::{
    evaluate_non_git, AnchorCondition, AnchorEvaluation, AnchorKind, AnchorRowSpec,
    ContextDependency,
};
use super::super::scope::{
    scope_matches, CanonicalScope, MatchOutcome, ScopeMatchContext, ScopeTermSpec,
};
use super::super::QueryContext;
use super::cache::{TwoGenerationCache, GENERATION_CAP};
use super::checkout::{CheckoutSnapshot, EvalBudget};
use super::checks::{run_cheap_check, CheckCache, CheckOutcome};
use super::payloads::{
    CheckSpec, ObjectApplicabilitySpec, PayloadDecode, OBSERVATION_KIND_CURRENT,
    OBSERVATION_KIND_DIRTY_TREE_UNCERTAIN, OBSERVATION_KIND_HISTORICAL,
    OBSERVATION_KIND_LIFECYCLE_INVALIDATED, OBSERVATION_KIND_OUT_OF_SCOPE, OBSERVATION_KIND_STALE,
    OBSERVATION_KIND_UNCERTAIN,
};
use super::resolve::{GitConditionOutcome, ResolutionLadder, PATCH_ID_ALGORITHM};

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

    /// The durable applicability append stores this observation kind.
    pub fn observation_kind(self) -> &'static str {
        match self {
            Self::Current => OBSERVATION_KIND_CURRENT,
            Self::Historical => OBSERVATION_KIND_HISTORICAL,
            Self::OutOfScope => OBSERVATION_KIND_OUT_OF_SCOPE,
            Self::Uncertain => OBSERVATION_KIND_UNCERTAIN,
            Self::DirtyTreeUncertain => OBSERVATION_KIND_DIRTY_TREE_UNCERTAIN,
            Self::Stale => OBSERVATION_KIND_STALE,
            Self::LifecycleInvalidated => OBSERVATION_KIND_LIFECYCLE_INVALIDATED,
        }
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
    patch_id_algorithm: &'static str,
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
        let batch_prefix = batch_digest_prefix(&scope_context);
        // Distinct anchors resolve once per batch even on cache misses.
        let mut batch_anchor_memo: HashMap<String, GitConditionOutcome> = HashMap::new();
        // Memoize each anchor row separately because multiple rows can share an `anchor_id`.
        let mut batch_decode_memo: DecodeMemo<'_> = HashMap::new();
        let mut batch_fingerprint_memo: FingerprintMemo<'_> = HashMap::new();
        let mut check_cache = CheckCache::new();
        let mut objects = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let anchor_fingerprint = candidate.anchor.as_ref().map(|anchor| {
                match batch_fingerprint_memo.get(anchor.anchor_id.as_str()) {
                    Some((row, fingerprint)) if **row == *anchor => *fingerprint,
                    _ => {
                        let fingerprint = anchor_row_fingerprint(anchor);
                        batch_fingerprint_memo
                            .insert(anchor.anchor_id.as_str(), (anchor, fingerprint));
                        fingerprint
                    }
                }
            });
            let token = ClassificationToken(self.object_cache_key(
                snapshot,
                &batch_prefix,
                query,
                candidate,
                anchor_fingerprint.as_ref(),
            ));
            if candidate.lifecycle_invalidated {
                objects.push(finished(
                    candidate,
                    token,
                    Classification::terminal(
                        ApplicabilityState::LifecycleInvalidated,
                        "object lifecycle-invalidated before applicability evaluation",
                    ),
                    false,
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
                    false,
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
            let graph_ops_before = ladder.graph_operations();
            let classification = self.classify(
                snapshot,
                query,
                &scope_context,
                &ladder,
                &mut batch_anchor_memo,
                &mut batch_decode_memo,
                &mut check_cache,
                &mut stats,
                candidate,
                budget,
            );
            stats.graph_operations += ladder.graph_operations() - graph_ops_before;
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
            // An uncacheable verdict has no cache entry, so its token could
            // never be confirmed; claiming a pending append would make read
            // repair re-append it on every request forever.
            let append_pending = classification.cacheable;
            objects.push(finished(candidate, token, classification, append_pending));
        }
        BatchEvaluation { objects, stats }
    }

    /// Marks the durable applicability append for `token` as landed, so
    /// later cache hits stop retrying it. Returns whether the entry was still
    /// cached; a `false` return means the confirmation was dropped.
    #[must_use]
    pub fn confirm_durable_append(&self, token: &ClassificationToken) -> bool {
        self.object_cache
            .lock()
            .expect("cache lock")
            .update(&token.0, |cached| cached.append_confirmed = true)
    }

    #[expect(clippy::too_many_arguments, reason = "internal classify pipeline")]
    fn classify<'batch>(
        &self,
        snapshot: &CheckoutSnapshot,
        query: &QueryContext,
        scope_context: &ScopeMatchContext,
        ladder: &ResolutionLadder<'_>,
        batch_anchor_memo: &mut HashMap<String, GitConditionOutcome>,
        batch_decode_memo: &mut DecodeMemo<'batch>,
        check_cache: &mut CheckCache,
        stats: &mut EvaluationStats,
        candidate: &'batch ApplicabilityCandidate,
        budget: &EvalBudget,
    ) -> Classification {
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
                    let state = ApplicabilityState::Uncertain;
                    let evidence = "scope match is unresolvable in this context";
                    return if budget.is_exhausted() {
                        Classification::uncacheable(state, evidence)
                    } else {
                        Classification::terminal(state, evidence)
                    };
                }
            }
        }
        // Anchor gate.
        if let Some(anchor) = &candidate.anchor {
            match self.evaluate_anchor(
                snapshot,
                query,
                ladder,
                batch_anchor_memo,
                batch_decode_memo,
                stats,
                anchor,
            ) {
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
        // Dirty-tree gate and cheap checks read the object payload.
        let mut gates_ran = candidate.scope_terms.is_some() || candidate.anchor.is_some();
        let spec = match ObjectApplicabilitySpec::decode(candidate.payload.as_deref()) {
            // A payload that cannot be read leaves its declared paths and
            // checks unknown, so staleness is unknown rather than absent.
            PayloadDecode::Undecodable(evidence) => {
                return Classification::terminal(ApplicabilityState::Uncertain, evidence);
            }
            PayloadDecode::Absent => None,
            PayloadDecode::Present(spec) => Some(spec),
        };
        if let Some(spec) = &spec {
            if let Some(path) = dirty_overlap(snapshot, &spec.affected_paths) {
                return Classification::terminal(
                    ApplicabilityState::DirtyTreeUncertain,
                    format!("uncommitted path {path} overlaps affected paths"),
                );
            }
            gates_ran |= !spec.affected_paths.is_empty() || !spec.checks.is_empty();
            for check in &spec.checks {
                match run_cheap_check(snapshot, check, budget, check_cache) {
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
                    CheckOutcome::Unsupported { evidence } => {
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
            match (candidate.anchor.is_some(), gates_ran) {
                (true, _) => "anchor holds at HEAD and all checks pass",
                (false, true) => "scope and declared inputs match this checkout",
                (false, false) => "no scope, anchor, or declared inputs constrain this object",
            },
        )
    }

    #[expect(clippy::too_many_arguments, reason = "internal classify pipeline")]
    fn evaluate_anchor<'batch>(
        &self,
        snapshot: &CheckoutSnapshot,
        query: &QueryContext,
        ladder: &ResolutionLadder<'_>,
        batch_anchor_memo: &mut HashMap<String, GitConditionOutcome>,
        batch_decode_memo: &mut DecodeMemo<'batch>,
        stats: &mut EvaluationStats,
        anchor: &'batch AnchorRowSpec,
    ) -> AnchorVerdict {
        let reusable = matches!(
            batch_decode_memo.get(anchor.anchor_id.as_str()),
            Some((row, _)) if **row == *anchor
        );
        if !reusable {
            let result = AnchorCondition::decode(anchor)
                .map_err(|error| format!("undecodable anchor: {error}"));
            batch_decode_memo.insert(anchor.anchor_id.as_str(), (anchor, result));
        }
        let (_, decode_result) = batch_decode_memo
            .get(anchor.anchor_id.as_str())
            .expect("decode memo holds this anchor id");
        let condition = match decode_result {
            Ok(condition) => condition,
            Err(evidence) => return AnchorVerdict::Uncertain(evidence.clone()),
        };
        match evaluate_non_git(condition, query) {
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
        let AnchorCondition::Git(git_condition) = condition else {
            unreachable!("NeedsGitResolution is only reported for git conditions");
        };
        let outcome = if let Some(outcome) = batch_anchor_memo.get(&anchor.anchor_id) {
            *outcome
        } else {
            let key = AnchorCacheKey {
                checkout_identity: snapshot.identity().to_string(),
                anchor_id: anchor.anchor_id.clone(),
                payload_digest: digest_optional(anchor.payload.as_deref()),
                head: snapshot.head().to_string(),
                patch_id_algorithm: PATCH_ID_ALGORITHM,
            };
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
                            .insert(key, outcome);
                    }
                    outcome
                }
            };
            batch_anchor_memo.insert(anchor.anchor_id.clone(), outcome);
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
        batch_prefix: &Sha256,
        query: &QueryContext,
        candidate: &ApplicabilityCandidate,
        anchor_fingerprint: Option<&[u8; 32]>,
    ) -> ObjectCacheKey {
        ObjectCacheKey {
            checkout_identity: snapshot.identity().to_string(),
            object_id: candidate.object_id.clone(),
            object_revision: candidate.object_revision,
            head: snapshot.head().to_string(),
            dirty_fingerprint: snapshot.dirty_fingerprint().to_string(),
            inputs_digest: inputs_digest(batch_prefix, query, candidate, anchor_fingerprint),
        }
    }
}

enum AnchorVerdict {
    Holds,
    Historical(String),
    Uncertain(String),
}

/// Reuse of a memoized decode requires the stored row to equal the caller's row.
type DecodeMemo<'batch> =
    HashMap<&'batch str, (&'batch AnchorRowSpec, Result<AnchorCondition, String>)>;

/// Reuse of a memoized fingerprint requires the stored row to equal the caller's row.
type FingerprintMemo<'batch> = HashMap<&'batch str, (&'batch AnchorRowSpec, [u8; 32])>;

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
    append_pending: bool,
) -> ObjectApplicability {
    ObjectApplicability {
        object_id: candidate.object_id.clone(),
        object_revision: candidate.object_revision,
        state: classification.state,
        evidence: classification.evidence,
        failed_check: classification.failed_check,
        append_pending: append_pending && classification.state.blocks_auto_injection(),
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
    for entry in snapshot.dirty_entries() {
        let dirty_path = entry.path.as_str();
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
    batch_prefix: &Sha256,
    query: &QueryContext,
    candidate: &ApplicabilityCandidate,
    anchor_fingerprint: Option<&[u8; 32]>,
) -> String {
    let mut hash = batch_prefix.clone();
    // Only the context fields the candidate's anchor kind reads enter the
    // digest, so an unrelated context change (a fresh query instant, say)
    // cannot evict every cached classification.
    let anchor_kind = candidate
        .anchor
        .as_ref()
        .map(|anchor| anchor.anchor_kind.as_str())
        .unwrap_or_default();
    hash_bytes(&mut hash, anchor_kind.as_bytes());
    // An unparseable kind covers every field: it decodes as uncertain, and a
    // narrower key would be wrong if a later build recognizes the kind.
    let dependency = match AnchorKind::from_stored(anchor_kind) {
        Some(kind) => kind.context_dependency(),
        None if candidate.anchor.is_some() => ContextDependency::All,
        None => ContextDependency::None,
    };
    hash_context(&mut hash, query, dependency);
    hash.update(b"\0");
    if let Some(terms) = &candidate.scope_terms {
        hash_usize(&mut hash, terms.len());
        for term in terms {
            hash_scope_term(&mut hash, term);
        }
    }
    hash.update(b"\0");
    if let Some(fingerprint) = anchor_fingerprint {
        hash.update([1]);
        hash.update(fingerprint);
    } else {
        hash.update([0]);
    }
    hash.update(b"\0");
    hash.update(candidate.payload.as_deref().unwrap_or_default());
    format!("{:x}", hash.finalize())
}

/// Hash state over the batch-constant digest inputs, cloned per candidate
/// so the domain tag and scope-context dimensions compress once per batch.
fn batch_digest_prefix(scope_context: &ScopeMatchContext) -> Sha256 {
    let mut hash = Sha256::new();
    hash.update(b"mc-applicability-inputs-v4\0");
    for dimension in super::super::Dimension::ALL {
        hash_opt_str(&mut hash, scope_context.value(dimension));
    }
    hash
}

fn anchor_row_fingerprint(anchor: &AnchorRowSpec) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash_anchor_row(&mut hash, anchor);
    hash.finalize().into()
}

fn hash_context(hash: &mut Sha256, query: &QueryContext, dependency: ContextDependency) {
    let mut field = |value: Option<&str>| hash_opt_str(hash, value);
    match dependency {
        ContextDependency::None => {}
        ContextDependency::ExactToken => field(query.exact_token.as_deref()),
        ContextDependency::DeploymentRevision => field(query.deployment_revision.as_deref()),
        ContextDependency::ConfigRevision => field(query.config_revision.as_deref()),
        ContextDependency::PlatformVersion => field(query.platform_version.as_deref()),
        ContextDependency::QueryInstant => hash_opt_i64(hash, query.query_instant_ms),
        ContextDependency::All => {
            field(query.exact_token.as_deref());
            field(query.deployment_revision.as_deref());
            field(query.config_revision.as_deref());
            field(query.platform_version.as_deref());
            hash_opt_i64(hash, query.query_instant_ms);
        }
    }
}

/// Length prefixes keep the field framing injective.
fn hash_usize(hash: &mut Sha256, value: usize) {
    hash.update((value as u64).to_le_bytes());
}

fn hash_bytes(hash: &mut Sha256, bytes: &[u8]) {
    hash_usize(hash, bytes.len());
    hash.update(bytes);
}

fn hash_opt_str(hash: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            hash.update([1]);
            hash_bytes(hash, value.as_bytes());
        }
        None => hash.update([0]),
    }
}

fn hash_opt_i64(hash: &mut Sha256, value: Option<i64>) {
    match value {
        Some(value) => {
            hash.update([1]);
            hash.update(value.to_le_bytes());
        }
        None => hash.update([0]),
    }
}

// The exhaustive destructuring pattern keeps every `ScopeTermSpec` field in the digest.
fn hash_scope_term(hash: &mut Sha256, term: &super::super::ScopeTermSpec) {
    let super::super::ScopeTermSpec {
        dimension,
        operator,
        exact_value,
        set_values,
        range_start,
        range_end,
        version_range,
        git_oid,
        git_start_oid,
        git_end_oid,
        payload,
    } = term;
    hash_bytes(hash, dimension.as_bytes());
    hash_bytes(hash, operator.as_bytes());
    hash_opt_str(hash, exact_value.as_deref());
    match set_values {
        Some(values) => {
            hash.update([1]);
            hash_usize(hash, values.len());
            for value in values {
                hash_bytes(hash, value.as_bytes());
            }
        }
        None => hash.update([0]),
    }
    hash_opt_str(hash, range_start.as_deref());
    hash_opt_str(hash, range_end.as_deref());
    hash_opt_str(hash, version_range.as_deref());
    hash_opt_str(hash, git_oid.as_deref());
    hash_opt_str(hash, git_start_oid.as_deref());
    hash_opt_str(hash, git_end_oid.as_deref());
    hash_opt_str(hash, payload.as_deref());
}

// The exhaustive destructuring pattern keeps every `AnchorRowSpec` field in the digest.
fn hash_anchor_row(hash: &mut Sha256, anchor: &AnchorRowSpec) {
    let AnchorRowSpec {
        anchor_id,
        anchor_kind,
        exact_value,
        reachable_from_oid,
        reachable_between_start_oid,
        reachable_between_end_oid,
        deployment_revision,
        config_revision,
        platform_version_range,
        wall_clock_start,
        wall_clock_end,
        payload,
    } = anchor;
    hash_bytes(hash, anchor_id.as_bytes());
    hash_bytes(hash, anchor_kind.as_bytes());
    hash_opt_str(hash, exact_value.as_deref());
    hash_opt_str(hash, reachable_from_oid.as_deref());
    hash_opt_str(hash, reachable_between_start_oid.as_deref());
    hash_opt_str(hash, reachable_between_end_oid.as_deref());
    hash_opt_str(hash, deployment_revision.as_deref());
    hash_opt_str(hash, config_revision.as_deref());
    hash_opt_str(hash, platform_version_range.as_deref());
    hash_opt_i64(hash, *wall_clock_start);
    hash_opt_i64(hash, *wall_clock_end);
    match payload {
        Some(payload) => {
            hash.update([1]);
            hash_bytes(hash, payload);
        }
        None => hash.update([0]),
    }
}
