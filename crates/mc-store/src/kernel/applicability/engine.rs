//! Per-object applicability classification behind two generation caches.
//!
//! One engine instance lives alongside the kernel store and owns all
//! mutable engine state (the caches). Each request supplies a checkout
//! snapshot taken once, a typed query context, and the candidate batch;
//! distinct anchors resolve once per batch, never once per candidate.

use std::borrow::Cow;
use std::cell::OnceCell;
use std::collections::{hash_map::RandomState, HashMap};
use std::hash::{BuildHasher, Hash, Hasher};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};

use super::super::anchor::{
    evaluate_non_git, AnchorCondition, AnchorEvaluation, AnchorKind, AnchorRowSpec,
    ContextDependency,
};
use super::super::scope::{
    scope_matches, CanonicalScope, MatchOutcome, ScopeFormError, ScopeMatchContext, ScopeTermSpec,
};
use super::super::QueryContext;
use super::cache::{TwoGenerationCache, GENERATION_CAP};
use super::checkout::{CheckoutSnapshot, DirtyEntry, EvalBudget};
use super::checks::{check_observation, run_cheap_check, CheckCache, CheckOutcome};
use super::payloads::{
    CheckSpec, ObjectApplicabilitySpec, PayloadDecode, OBSERVATION_KIND_CURRENT,
    OBSERVATION_KIND_DIRTY_TREE_UNCERTAIN, OBSERVATION_KIND_HISTORICAL,
    OBSERVATION_KIND_LIFECYCLE_INVALIDATED, OBSERVATION_KIND_OUT_OF_SCOPE, OBSERVATION_KIND_STALE,
    OBSERVATION_KIND_UNCERTAIN,
};
use super::repair::AppendOutcome;
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
    /// Inverse of [`Self::label`], so a stored label and its observation kind
    /// are checked against one mapping rather than a naming convention.
    pub fn from_label(label: &str) -> Option<Self> {
        match label {
            "current" => Some(Self::Current),
            "historical" => Some(Self::Historical),
            "out_of_scope" => Some(Self::OutOfScope),
            "uncertain" => Some(Self::Uncertain),
            "dirty_tree_uncertain" => Some(Self::DirtyTreeUncertain),
            "stale" => Some(Self::Stale),
            "lifecycle_invalidated" => Some(Self::LifecycleInvalidated),
            _ => None,
        }
    }

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
pub struct ClassificationToken(Arc<ObjectCacheKey>);

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
    /// Outcome of the durable append this request attempted, or `None` when
    /// repair did not touch the object. Carried here rather than in a parallel
    /// collection keyed by object id, which callers had to re-correlate.
    pub append: Option<AppendOutcome>,
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
    row_fingerprint: [u8; 32],
    head: String,
    repository_state: String,
    patch_id_algorithm: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ObjectCacheKey {
    hash: u64,
    snapshot: SnapshotCacheKey,
    object_id: Box<str>,
    object_revision: i64,
    inputs_digest: [u8; 32],
    check_observations: [u8; 32],
    scoped_dirty_fingerprint: [u8; 32],
}

impl Hash for ObjectCacheKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.hash.hash(state);
    }
}

#[derive(Clone, Copy, Default)]
struct PrehashedState;

impl BuildHasher for PrehashedState {
    type Hasher = PrehashedHasher;

    fn build_hasher(&self) -> Self::Hasher {
        PrehashedHasher::default()
    }
}

#[derive(Default)]
struct PrehashedHasher(u64);

impl Hasher for PrehashedHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    fn write_u64(&mut self, value: u64) {
        self.0 = value;
    }
}

#[derive(Debug, Clone)]
enum SnapshotCacheKey {
    Owned(SnapshotCacheValues),
    Shared(Arc<SnapshotCacheValues>),
}

impl SnapshotCacheKey {
    fn values(&self) -> &SnapshotCacheValues {
        match self {
            Self::Owned(value) => value,
            Self::Shared(value) => value,
        }
    }
}

impl PartialEq for SnapshotCacheKey {
    fn eq(&self, other: &Self) -> bool {
        if let (Self::Shared(left), Self::Shared(right)) = (self, other) {
            if Arc::ptr_eq(left, right) {
                return true;
            }
        }
        self.values() == other.values()
    }
}

impl Eq for SnapshotCacheKey {}

impl Hash for SnapshotCacheKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.values().hash(state);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SnapshotCacheValues {
    hash: u64,
    checkout_identity: String,
    head: String,
    repository_state: String,
}

impl Hash for SnapshotCacheValues {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.hash.hash(state);
    }
}

#[derive(Debug, Clone)]
struct CachedClassification {
    details: Option<Box<CachedClassificationDetails>>,
    query_local: bool,
    append_confirmed: bool,
}

#[derive(Debug, Clone)]
struct CachedClassificationDetails {
    state: ApplicabilityState,
    evidence: Box<str>,
    failed_check: Option<Box<FailedCheck>>,
}

const CURRENT_EVIDENCE: &str = "anchor holds at HEAD and all checks pass";

struct LastMemo<T> {
    last: Option<([u8; 32], T)>,
}

impl<T> Default for LastMemo<T> {
    fn default() -> Self {
        Self { last: None }
    }
}

impl<T> LastMemo<T> {
    fn get_or_insert_with(&mut self, key: [u8; 32], create: impl FnOnce() -> T) -> &T {
        if self
            .last
            .as_ref()
            .is_none_or(|(last_key, _)| *last_key != key)
        {
            self.last = Some((key, create()));
        }
        &self.last.as_ref().expect("batch memo initialized").1
    }
}

type DecodedPayload = PayloadDecode;
type ScopeVerdict = Result<MatchOutcome, ScopeFormError>;
static ABSENT_PAYLOAD: PayloadDecode = PayloadDecode::Absent;

#[derive(Default)]
struct PayloadMemo<'c> {
    last: Option<(&'c [u8], DecodedPayload)>,
    general: Option<HashMap<&'c [u8], DecodedPayload>>,
}

impl<'c> PayloadMemo<'c> {
    fn get_or_insert_with(
        &mut self,
        key: &'c [u8],
        create: impl FnOnce() -> DecodedPayload,
    ) -> &DecodedPayload {
        if self.general.is_none() {
            if self
                .last
                .as_ref()
                .is_some_and(|(last_key, _)| *last_key == key)
            {
                return &self.last.as_ref().expect("payload memo initialized").1;
            }
            if let Some((last_key, last_value)) = self.last.take() {
                self.general = Some(HashMap::from([(last_key, last_value), (key, create())]));
                return self
                    .general
                    .as_ref()
                    .expect("general payload memo initialized")
                    .get(key)
                    .expect("new payload inserted");
            }
            self.last = Some((key, create()));
            return &self.last.as_ref().expect("payload memo initialized").1;
        }
        let Some(general) = self.general.as_mut() else {
            unreachable!("general payload memo checked present");
        };
        general.entry(key).or_insert_with(create)
    }
}

/// Per-batch memo state. Payload decode is pure. Check observations and
/// verdicts share one cache so the key and classification use the same read.
#[derive(Default)]
struct BatchMemos {
    key: [u8; 32],
    anchors: HashMap<AnchorCacheKey, GitConditionOutcome>,
    anchor_verdict: LastMemo<AnchorVerdict>,
    check_cache: CheckCache,
    check_digest: LastMemo<[u8; 32]>,
    dirty_gate: LastMemo<DirtyGate>,
    scoped_dirty: LastMemo<[u8; 32]>,
    scope: LastMemo<ScopeVerdict>,
}

#[derive(Clone, Copy)]
struct CandidateInputs<'a> {
    scope_terms: &'a Option<Vec<ScopeTermSpec>>,
    anchor: &'a Option<AnchorRowSpec>,
    payload: &'a Option<Vec<u8>>,
}

impl CandidateInputs<'_> {
    fn new(candidate: &ApplicabilityCandidate) -> CandidateInputs<'_> {
        CandidateInputs {
            scope_terms: &candidate.scope_terms,
            anchor: &candidate.anchor,
            payload: &candidate.payload,
        }
    }
}

impl PartialEq for CandidateInputs<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.scope_terms == other.scope_terms
            && self.anchor == other.anchor
            && self.payload == other.payload
    }
}

impl Eq for CandidateInputs<'_> {}

impl Hash for CandidateInputs<'_> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        match self.scope_terms {
            Some(terms) => {
                true.hash(state);
                terms.len().hash(state);
                for term in terms {
                    term.dimension.hash(state);
                    term.operator.hash(state);
                    term.exact_value.hash(state);
                    term.set_values.hash(state);
                    term.range_start.hash(state);
                    term.range_end.hash(state);
                    term.version_range.hash(state);
                    term.git_oid.hash(state);
                    term.git_start_oid.hash(state);
                    term.git_end_oid.hash(state);
                    term.payload.hash(state);
                }
            }
            None => false.hash(state),
        }
        match self.anchor {
            Some(anchor) => {
                true.hash(state);
                anchor.anchor_id.hash(state);
                anchor.anchor_kind.hash(state);
                anchor.exact_value.hash(state);
                anchor.reachable_from_oid.hash(state);
                anchor.reachable_between_start_oid.hash(state);
                anchor.reachable_between_end_oid.hash(state);
                anchor.deployment_revision.hash(state);
                anchor.config_revision.hash(state);
                anchor.platform_version_range.hash(state);
                anchor.wall_clock_start.hash(state);
                anchor.wall_clock_end.hash(state);
                anchor.payload.hash(state);
            }
            None => false.hash(state),
        }
        self.payload.hash(state);
    }
}

/// Single owner of engine state: the two generation caches (KTD6). Owned
/// alongside the kernel store; requests borrow it together with a fresh
/// checkout snapshot.
pub struct ApplicabilityEngine {
    anchor_cache: Mutex<TwoGenerationCache<AnchorCacheKey, GitConditionOutcome>>,
    object_cache:
        Mutex<TwoGenerationCache<Arc<ObjectCacheKey>, CachedClassification, PrehashedState>>,
    cache_hasher: RandomState,
}

impl Default for ApplicabilityEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl ApplicabilityEngine {
    pub fn new() -> Self {
        let cache_hasher = RandomState::new();
        let object_cache = TwoGenerationCache::with_hasher(GENERATION_CAP, PrehashedState);
        Self {
            anchor_cache: Mutex::new(TwoGenerationCache::new(GENERATION_CAP)),
            object_cache: Mutex::new(object_cache),
            cache_hasher,
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
        let resolved_scope_context = OnceCell::new();
        let snapshot_hash = self.cache_hasher.hash_one((
            snapshot.identity(),
            snapshot.head(),
            snapshot.repository_state(),
        ));
        let mut cache_context = (candidates.len() > 1).then(|| {
            Arc::new(SnapshotCacheValues {
                hash: snapshot_hash,
                checkout_identity: snapshot.identity().to_string(),
                head: snapshot.head().to_string(),
                repository_state: snapshot.repository_state().to_string(),
            })
        });
        let mut digest_prefixes = InputDigestPrefixes::new(query, scope_context);
        let mut batch_input_digests: Option<HashMap<CandidateInputs<'_>, [u8; 32]>> = None;
        let mut last_input_digest = None;
        // Distinct anchors and repeated payloads resolve once per batch.
        let mut batch_memos = BatchMemos::default();
        let mut payload_memo = PayloadMemo::default();
        let mut objects = Vec::with_capacity(candidates.len());
        self.object_cache
            .lock()
            .expect("cache lock")
            .reserve(candidates.len());
        for candidate in candidates {
            let payload_decode = match candidate.payload.as_deref() {
                Some(payload) => payload_memo
                    .get_or_insert_with(payload, || ObjectApplicabilitySpec::decode(Some(payload))),
                None => &ABSENT_PAYLOAD,
            };
            let inputs_digest = if candidates.len() > 1 {
                let candidate_inputs = CandidateInputs::new(candidate);
                if let Some((_, digest)) =
                    last_input_digest.filter(|(last, _)| *last == candidate_inputs)
                {
                    digest
                } else {
                    let digest = match (&mut batch_input_digests, last_input_digest) {
                        (Some(digests), _) => {
                            digests.get(&candidate_inputs).copied().unwrap_or_else(|| {
                                let digest = digest_prefixes.for_candidate(candidate);
                                digests.insert(candidate_inputs, digest);
                                digest
                            })
                        }
                        (None, Some((last, digest))) => {
                            let mut digests = HashMap::from([(last, digest)]);
                            let digest = digest_prefixes.for_candidate(candidate);
                            digests.insert(candidate_inputs, digest);
                            batch_input_digests = Some(digests);
                            digest
                        }
                        (None, None) => digest_prefixes.for_candidate(candidate),
                    };
                    last_input_digest = Some((candidate_inputs, digest));
                    digest
                }
            } else {
                digest_prefixes.for_candidate(candidate)
            };
            batch_memos.key = inputs_digest;
            let check_observations =
                *batch_memos
                    .check_digest
                    .get_or_insert_with(inputs_digest, || {
                        check_observations_digest(
                            snapshot,
                            payload_decode,
                            &mut batch_memos.check_cache,
                            budget,
                        )
                    });
            let scoped_dirty_fingerprint = *batch_memos
                .scoped_dirty
                .get_or_insert_with(inputs_digest, || {
                    scoped_dirty_fingerprint(snapshot, payload_decode, budget)
                });
            let key = self.object_cache_key(
                snapshot,
                snapshot_hash,
                cache_context.as_ref(),
                candidate,
                inputs_digest,
                check_observations,
                scoped_dirty_fingerprint,
            );
            if candidate.lifecycle_invalidated {
                objects.push(finished(
                    candidate,
                    ClassificationToken(Arc::new(key)),
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
                    ClassificationToken(Arc::new(key)),
                    Classification::uncacheable(
                        ApplicabilityState::Uncertain,
                        "evaluation budget exhausted before this object",
                    ),
                    false,
                ));
                continue;
            }
            if let Some((key, cached)) = self
                .object_cache
                .lock()
                .expect("cache lock")
                .get_key_value(&key)
            {
                stats.object_cache_hits += 1;
                if let SnapshotCacheKey::Shared(context) = &key.snapshot {
                    if cache_context
                        .as_ref()
                        .is_none_or(|current| !Arc::ptr_eq(current, context))
                    {
                        cache_context = Some(Arc::clone(context));
                    }
                }
                let (state, evidence, failed_check) = match cached.details {
                    Some(details) => (
                        details.state,
                        details.evidence.into(),
                        details.failed_check.map(|failed| *failed),
                    ),
                    None => (
                        ApplicabilityState::Current,
                        CURRENT_EVIDENCE.to_string(),
                        None,
                    ),
                };
                objects.push(ObjectApplicability {
                    object_id: candidate.object_id.clone(),
                    object_revision: candidate.object_revision,
                    state,
                    evidence,
                    failed_check,
                    append_pending: state.blocks_auto_injection()
                        && !cached.query_local
                        && !cached.append_confirmed,
                    token: ClassificationToken(key),
                    append: None,
                });
                continue;
            }
            stats.object_cache_misses += 1;
            let key = Arc::new(key);
            let token = ClassificationToken(Arc::clone(&key));
            let scope_context = resolved_scope_context
                .get_or_init(|| scope_context.clone().with_head_commit(snapshot.head()));
            let graph_ops_before = ladder.graph_operations();
            let classification = self.classify(
                query,
                scope_context,
                &ladder,
                &mut batch_memos,
                &mut stats,
                candidate,
                payload_decode,
            );
            let boundary_moved = if ladder.graph_operations() > graph_ops_before {
                ladder.repository_state_moved()
            } else {
                ladder.repository_state_movement_seen()
            };
            let cacheable = classification.cacheable
                && !boundary_moved
                && !(classification.state == ApplicabilityState::Uncertain
                    && ladder.saw_unreadable_object())
                && !budget.is_exhausted();
            if cacheable {
                self.object_cache.lock().expect("cache lock").insert(
                    key,
                    CachedClassification {
                        details: (classification.state != ApplicabilityState::Current).then(|| {
                            Box::new(CachedClassificationDetails {
                                state: classification.state,
                                evidence: classification.evidence.as_str().into(),
                                failed_check: classification.failed_check.clone().map(Box::new),
                            })
                        }),
                        query_local: classification.query_local,
                        append_confirmed: false,
                    },
                );
            }
            let append_pending = cacheable && !classification.query_local;
            objects.push(finished(candidate, token, classification, append_pending));
        }
        // Read the counter once for the whole batch so hit paths cannot hide
        // graph work behind branch placement.
        stats.graph_operations = ladder.graph_operations();
        BatchEvaluation { objects, stats }
    }

    /// Marks the durable applicability append for `token` as landed, so
    /// later cache hits stop retrying it.
    #[must_use]
    pub fn confirm_durable_append(&self, token: &ClassificationToken) -> bool {
        self.object_cache
            .lock()
            .expect("cache lock")
            .update(token.0.as_ref(), |cached| cached.append_confirmed = true)
    }

    #[expect(clippy::too_many_arguments, reason = "internal classify pipeline")]
    fn classify(
        &self,
        query: &QueryContext,
        scope_context: &ScopeMatchContext,
        ladder: &ResolutionLadder<'_>,
        memos: &mut BatchMemos,
        stats: &mut EvaluationStats,
        candidate: &ApplicabilityCandidate,
        payload_decode: &PayloadDecode,
    ) -> Classification {
        let snapshot = ladder.snapshot();
        let budget = ladder.budget();
        let mut gates_ran = candidate.scope_terms.is_some() || candidate.anchor.is_some();
        // Scope gate.
        if let Some(terms) = &candidate.scope_terms {
            let outcome = match memos.scope.get_or_insert_with(memos.key, || {
                CanonicalScope::from_term_specs(terms)
                    .map(|scope| scope_matches(&scope, scope_context, ladder))
            }) {
                Ok(outcome) => *outcome,
                Err(error) => {
                    return Classification::terminal(
                        ApplicabilityState::Uncertain,
                        format!("malformed scope: {error}"),
                    );
                }
            };
            match outcome {
                MatchOutcome::Matches => {}
                MatchOutcome::DoesNotMatch => {
                    return Classification::terminal(
                        ApplicabilityState::OutOfScope,
                        "scope does not match the query context",
                    )
                    .query_local();
                }
                MatchOutcome::Uncertain => {
                    return Classification::terminal(
                        ApplicabilityState::Uncertain,
                        "scope match is unresolvable in this context",
                    )
                    .query_local();
                }
            }
        }
        // Anchor gate.
        if let Some(anchor) = &candidate.anchor {
            let anchor_reads_context = !matches!(
                AnchorKind::from_stored(&anchor.anchor_kind).map(AnchorKind::context_dependency),
                Some(ContextDependency::None)
            );
            let localize = |classification: Classification| {
                if anchor_reads_context {
                    classification.query_local()
                } else {
                    classification
                }
            };
            let BatchMemos {
                key,
                anchors,
                anchor_verdict,
                ..
            } = memos;
            match anchor_verdict.get_or_insert_with(*key, || {
                self.evaluate_anchor(snapshot, query, ladder, anchors, stats, anchor)
            }) {
                AnchorVerdict::Holds => {}
                AnchorVerdict::Historical(evidence) => {
                    return localize(Classification::terminal(
                        ApplicabilityState::Historical,
                        evidence.clone(),
                    ));
                }
                AnchorVerdict::Uncertain(evidence) => {
                    let state = ApplicabilityState::Uncertain;
                    return if budget.is_exhausted() {
                        localize(Classification::uncacheable(state, evidence.clone()))
                    } else {
                        localize(Classification::terminal(state, evidence.clone()))
                    };
                }
            }
        }
        // Dirty-tree gate and cheap checks read the object payload. A
        // present-but-undecodable payload fails closed: the declared paths
        // and checks are unknowable, so the object is uncertain, never
        // silently current.
        let spec = match payload_decode {
            PayloadDecode::Absent => None,
            PayloadDecode::Present(spec) => Some(spec),
            PayloadDecode::Undecodable(evidence) => {
                return Classification::terminal(ApplicabilityState::Uncertain, evidence.clone());
            }
        };
        if let Some(spec) = spec {
            gates_ran |= !spec.affected_paths.is_empty() || !spec.checks.is_empty();
            match memos.dirty_gate.get_or_insert_with(memos.key, || {
                dirty_gate(snapshot, &spec.affected_paths, budget)
            }) {
                DirtyGate::Clear => {}
                DirtyGate::Overlap(path) => {
                    return Classification::terminal(
                        ApplicabilityState::DirtyTreeUncertain,
                        format!("uncommitted path {path} overlaps affected paths"),
                    );
                }
                DirtyGate::Unplaceable(path) => {
                    return Classification::terminal(
                        ApplicabilityState::Uncertain,
                        format!("affected path {path} does not resolve inside this checkout"),
                    );
                }
                DirtyGate::BudgetExhausted => {
                    return Classification::uncacheable(
                        ApplicabilityState::Uncertain,
                        "evaluation budget exhausted during the dirty-tree gate",
                    );
                }
            }
            for check in &spec.checks {
                let outcome = run_cheap_check(snapshot, check, budget, &mut memos.check_cache);
                match outcome {
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
                            query_local: false,
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
                (true, _) => CURRENT_EVIDENCE,
                (false, true) => "scope and declared inputs match this checkout",
                (false, false) => "no scope, anchor, or declared inputs constrain this object",
            },
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
            row_fingerprint: anchor_row_fingerprint(anchor),
            head: snapshot.head().to_string(),
            repository_state: snapshot.repository_state().to_string(),
            patch_id_algorithm: PATCH_ID_ALGORITHM,
        };
        let outcome = if let Some(outcome) = batch_anchor_memo.get(&key) {
            *outcome
        } else {
            let cached = self.anchor_cache.lock().expect("cache lock").get(&key);
            let (outcome, memoizable) = match cached {
                Some(outcome) => {
                    stats.anchor_cache_hits += 1;
                    (outcome, true)
                }
                None => {
                    stats.anchor_cache_misses += 1;
                    let outcome = ladder.evaluate(git_condition);
                    let boundary_moved = ladder.repository_state_moved();
                    // Budget-driven uncertainty is transient; caching it
                    // would pin a degraded verdict to this (HEAD, anchor).
                    if !boundary_moved
                        && (outcome != GitConditionOutcome::Uncertain
                            || (!ladder.budget_was_exhausted() && !ladder.saw_unreadable_object()))
                    {
                        self.anchor_cache
                            .lock()
                            .expect("cache lock")
                            .insert(key.clone(), outcome);
                    }
                    (outcome, !boundary_moved)
                }
            };
            if memoizable {
                batch_anchor_memo.insert(key, outcome);
            }
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

    #[expect(clippy::too_many_arguments, reason = "exact cache-key dimensions")]
    fn object_cache_key(
        &self,
        snapshot: &CheckoutSnapshot,
        snapshot_hash: u64,
        context: Option<&Arc<SnapshotCacheValues>>,
        candidate: &ApplicabilityCandidate,
        inputs_digest: [u8; 32],
        check_observations: [u8; 32],
        scoped_dirty_fingerprint: [u8; 32],
    ) -> ObjectCacheKey {
        let snapshot = match context {
            Some(context) => SnapshotCacheKey::Shared(Arc::clone(context)),
            None => SnapshotCacheKey::Owned(SnapshotCacheValues {
                hash: snapshot_hash,
                checkout_identity: snapshot.identity().to_string(),
                head: snapshot.head().to_string(),
                repository_state: snapshot.repository_state().to_string(),
            }),
        };
        ObjectCacheKey {
            hash: self.cache_hasher.hash_one((
                snapshot_hash,
                candidate.object_id.as_str(),
                candidate.object_revision,
                inputs_digest,
                check_observations,
                scoped_dirty_fingerprint,
            )),
            snapshot,
            object_id: candidate.object_id.as_str().into(),
            object_revision: candidate.object_revision,
            inputs_digest,
            check_observations,
            scoped_dirty_fingerprint,
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
            token: ClassificationToken(Arc::new(ObjectCacheKey {
                hash: 0,
                snapshot: SnapshotCacheKey::Owned(SnapshotCacheValues {
                    hash: 0,
                    checkout_identity: String::new(),
                    head: String::new(),
                    repository_state: String::new(),
                }),
                object_id: candidate.object_id.as_str().into(),
                object_revision: candidate.object_revision,
                inputs_digest: [0; 32],
                check_observations: [0; 32],
                scoped_dirty_fingerprint: [0; 32],
            })),
            append: None,
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
    query_local: bool,
}

impl Classification {
    fn terminal(state: ApplicabilityState, evidence: impl Into<String>) -> Self {
        Self {
            state,
            evidence: evidence.into(),
            failed_check: None,
            cacheable: true,
            query_local: false,
        }
    }

    fn uncacheable(state: ApplicabilityState, evidence: impl Into<String>) -> Self {
        Self {
            state,
            evidence: evidence.into(),
            failed_check: None,
            cacheable: false,
            query_local: false,
        }
    }

    fn query_local(mut self) -> Self {
        self.query_local = true;
        self
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
        append: None,
    }
}

#[derive(Clone)]
enum DirtyGate {
    Clear,
    Overlap(String),
    Unplaceable(String),
    BudgetExhausted,
}

fn dirty_gate(
    snapshot: &CheckoutSnapshot,
    affected_paths: &[String],
    budget: &EvalBudget,
) -> DirtyGate {
    for affected in affected_paths {
        if let DeclaredPath::Unplaceable = declared_path(affected) {
            return DirtyGate::Unplaceable(affected.clone());
        }
    }
    for entry in snapshot.dirty_entries() {
        if budget.is_exhausted() {
            return DirtyGate::BudgetExhausted;
        }
        if !entry.is_uncommitted_change() {
            continue;
        }
        if affected_paths
            .iter()
            .any(|affected| entry_overlaps(entry, affected))
        {
            return DirtyGate::Overlap(entry.path.clone());
        }
    }
    DirtyGate::Clear
}

enum DeclaredPath<'a> {
    Path(Cow<'a, str>),
    WorktreeRoot,
    Unplaceable,
}

fn declared_path(path: &str) -> DeclaredPath<'_> {
    let trimmed = path.trim_end_matches('/');
    let mut needs_rewrite = trimmed.starts_with('/');
    for segment in trimmed.split('/') {
        match segment {
            ".." => return DeclaredPath::Unplaceable,
            "" | "." => needs_rewrite = true,
            _ => {}
        }
    }
    if !needs_rewrite {
        return DeclaredPath::Path(Cow::Borrowed(trimmed));
    }
    let segments: Vec<&str> = trimmed
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();
    if segments.is_empty() {
        return DeclaredPath::WorktreeRoot;
    }
    DeclaredPath::Path(Cow::Owned(segments.join("/")))
}

fn paths_overlap(dirty: &[u8], declared: &[u8]) -> bool {
    let dirty = trim_trailing_slashes(dirty);
    let declared = trim_trailing_slashes(declared);
    dirty == declared || is_under(dirty, declared) || is_under(declared, dirty)
}

fn is_under(path: &[u8], ancestor: &[u8]) -> bool {
    path.strip_prefix(ancestor)
        .is_some_and(|rest| rest.starts_with(b"/"))
}

fn trim_trailing_slashes(mut path: &[u8]) -> &[u8] {
    while let Some(rest) = path.strip_suffix(b"/") {
        path = rest;
    }
    path
}

fn entry_overlaps(entry: &DirtyEntry, declared: &str) -> bool {
    match declared_path(declared) {
        DeclaredPath::Path(declared) => {
            paths_overlap(&entry.raw_path, declared.as_ref().as_bytes())
        }
        DeclaredPath::WorktreeRoot | DeclaredPath::Unplaceable => true,
    }
}

fn scoped_dirty_fingerprint(
    snapshot: &CheckoutSnapshot,
    payload_decode: &PayloadDecode,
    budget: &EvalBudget,
) -> [u8; 32] {
    let mut hash = Sha256::new();
    let PayloadDecode::Present(spec) = payload_decode else {
        return hash.finalize().into();
    };
    for affected in &spec.affected_paths {
        if matches!(declared_path(affected), DeclaredPath::Unplaceable) {
            hash.update(b"unplaceable\0");
            hash.update(affected.as_bytes());
        }
    }
    for entry in snapshot.dirty_entries() {
        if budget.is_exhausted() {
            break;
        }
        if entry.is_uncommitted_change()
            && spec
                .affected_paths
                .iter()
                .any(|affected| entry_overlaps(entry, affected))
        {
            hash.update((entry.raw_path.len() as u64).to_le_bytes());
            hash.update(&entry.raw_path);
            hash.update(entry.status.as_bytes());
            hash.update(entry.content_hash.as_bytes());
        }
    }
    hash.finalize().into()
}

fn anchor_row_fingerprint(anchor: &AnchorRowSpec) -> [u8; 32] {
    let mut hash = Sha256::new();
    digest_field(&mut hash, Some(&anchor.anchor_id));
    digest_field(&mut hash, Some(&anchor.anchor_kind));
    digest_field(&mut hash, anchor.exact_value.as_deref());
    digest_field(&mut hash, anchor.reachable_from_oid.as_deref());
    digest_field(&mut hash, anchor.reachable_between_start_oid.as_deref());
    digest_field(&mut hash, anchor.reachable_between_end_oid.as_deref());
    digest_field(&mut hash, anchor.deployment_revision.as_deref());
    digest_field(&mut hash, anchor.config_revision.as_deref());
    digest_field(&mut hash, anchor.platform_version_range.as_deref());
    digest_i64(&mut hash, anchor.wall_clock_start);
    digest_i64(&mut hash, anchor.wall_clock_end);
    match &anchor.payload {
        Some(payload) => {
            hash.update([1]);
            hash.update((payload.len() as u64).to_le_bytes());
            hash.update(payload);
        }
        None => hash.update([0]),
    }
    hash.finalize().into()
}

fn check_observations_digest(
    snapshot: &CheckoutSnapshot,
    payload_decode: &PayloadDecode,
    cache: &mut CheckCache,
    budget: &EvalBudget,
) -> [u8; 32] {
    let mut hash = Sha256::new();
    let PayloadDecode::Present(spec) = payload_decode else {
        return hash.finalize().into();
    };
    for check in &spec.checks {
        if budget.is_exhausted() {
            break;
        }
        if let Some(observation) = check_observation(cache, snapshot, check) {
            hash.update((observation.len() as u64).to_le_bytes());
            hash.update(observation.as_bytes());
        }
    }
    hash.finalize().into()
}

#[derive(Clone, Copy)]
enum InputPrefixKind {
    Default = 0,
    Exact,
    Deployment,
    Config,
    Platform,
    WallClock,
    All,
}

struct InputDigestPrefixes<'a> {
    query: &'a QueryContext,
    scope_context: &'a ScopeMatchContext,
    cached: [Option<Sha256>; 7],
}

impl<'a> InputDigestPrefixes<'a> {
    fn new(query: &'a QueryContext, scope_context: &'a ScopeMatchContext) -> Self {
        Self {
            query,
            scope_context,
            cached: std::array::from_fn(|_| None),
        }
    }

    fn for_candidate(&mut self, candidate: &ApplicabilityCandidate) -> [u8; 32] {
        let kind = match candidate.anchor.as_ref().map(|anchor| {
            AnchorKind::from_stored(&anchor.anchor_kind)
                .map(AnchorKind::context_dependency)
                .unwrap_or(ContextDependency::All)
        }) {
            None | Some(ContextDependency::None) => InputPrefixKind::Default,
            Some(ContextDependency::ExactToken) => InputPrefixKind::Exact,
            Some(ContextDependency::DeploymentRevision) => InputPrefixKind::Deployment,
            Some(ContextDependency::ConfigRevision) => InputPrefixKind::Config,
            Some(ContextDependency::PlatformVersion) => InputPrefixKind::Platform,
            Some(ContextDependency::QueryInstant) => InputPrefixKind::WallClock,
            Some(ContextDependency::All) => InputPrefixKind::All,
        };
        let slot = &mut self.cached[kind as usize];
        if slot.is_none() {
            *slot = Some(inputs_digest_prefix(self.query, self.scope_context, kind));
        }
        finish_inputs_digest(slot.clone().expect("digest prefix initialized"), candidate)
    }
}

fn inputs_digest_prefix(
    query: &QueryContext,
    scope_context: &ScopeMatchContext,
    kind: InputPrefixKind,
) -> Sha256 {
    let mut hash = Sha256::new();
    hash.update(b"mc-applicability-inputs-v4\0");
    // Only the context fields the candidate's anchor kind reads enter the
    // digest, so an unrelated context change (a fresh query instant, say)
    // cannot evict every cached classification.
    let relevant: &[Option<&str>] = match kind {
        InputPrefixKind::Exact => &[query.exact_token.as_deref()],
        InputPrefixKind::Deployment => &[query.deployment_revision.as_deref()],
        InputPrefixKind::Config => &[query.config_revision.as_deref()],
        InputPrefixKind::Platform => &[query.platform_version.as_deref()],
        InputPrefixKind::All => &[
            query.exact_token.as_deref(),
            query.deployment_revision.as_deref(),
            query.config_revision.as_deref(),
            query.platform_version.as_deref(),
        ],
        _ => &[],
    };
    for field in relevant {
        digest_field(&mut hash, *field);
    }
    if matches!(kind, InputPrefixKind::WallClock | InputPrefixKind::All) {
        match query.query_instant_ms {
            Some(instant) => {
                hash.update([1]);
                hash.update(instant.to_le_bytes());
            }
            None => hash.update([0]),
        }
    }
    for dimension in super::super::Dimension::ALL {
        digest_field(&mut hash, scope_context.value(dimension));
    }
    hash
}

/// Digest over every non-snapshot input that can change the verdict, so a
/// cache entry can never answer for a different query context, scope
/// context, payload, or anchor row.
fn finish_inputs_digest(mut hash: Sha256, candidate: &ApplicabilityCandidate) -> [u8; 32] {
    if let Some(terms) = &candidate.scope_terms {
        hash.update([1u8]);
        hash.update((terms.len() as u64).to_le_bytes());
        for term in terms {
            digest_field(&mut hash, Some(&term.dimension));
            digest_field(&mut hash, Some(&term.operator));
            digest_field(&mut hash, term.exact_value.as_deref());
            match &term.set_values {
                Some(values) => {
                    hash.update([1u8]);
                    hash.update((values.len() as u64).to_le_bytes());
                    for value in values {
                        digest_field(&mut hash, Some(value));
                    }
                }
                None => hash.update([0u8]),
            }
            digest_field(&mut hash, term.range_start.as_deref());
            digest_field(&mut hash, term.range_end.as_deref());
            digest_field(&mut hash, term.version_range.as_deref());
            digest_field(&mut hash, term.git_oid.as_deref());
            digest_field(&mut hash, term.git_start_oid.as_deref());
            digest_field(&mut hash, term.git_end_oid.as_deref());
            digest_field(&mut hash, term.payload.as_deref());
        }
    } else {
        hash.update([0u8]);
    }
    if let Some(anchor) = &candidate.anchor {
        hash.update([1u8]);
        digest_field(&mut hash, Some(&anchor.anchor_id));
        digest_field(&mut hash, Some(&anchor.anchor_kind));
        digest_field(&mut hash, anchor.exact_value.as_deref());
        digest_field(&mut hash, anchor.reachable_from_oid.as_deref());
        digest_field(&mut hash, anchor.reachable_between_start_oid.as_deref());
        digest_field(&mut hash, anchor.reachable_between_end_oid.as_deref());
        digest_field(&mut hash, anchor.deployment_revision.as_deref());
        digest_field(&mut hash, anchor.config_revision.as_deref());
        digest_field(&mut hash, anchor.platform_version_range.as_deref());
        digest_i64(&mut hash, anchor.wall_clock_start);
        digest_i64(&mut hash, anchor.wall_clock_end);
        match &anchor.payload {
            Some(payload) => {
                hash.update([1u8]);
                hash.update((payload.len() as u64).to_le_bytes());
                hash.update(payload);
            }
            None => hash.update([0u8]),
        }
    } else {
        hash.update([0u8]);
    }
    match &candidate.payload {
        Some(payload) => {
            hash.update([1]);
            hash.update((payload.len() as u64).to_le_bytes());
            hash.update(payload);
        }
        None => hash.update([0]),
    }
    hash.finalize().into()
}

/// Presence-tagged, length-prefixed encoding distinguishes `None`,
/// `Some("<none>")`, and adjacent fields.
fn digest_field(hash: &mut Sha256, field: Option<&str>) {
    match field {
        Some(value) => {
            hash.update([1u8]);
            hash.update((value.len() as u64).to_le_bytes());
            hash.update(value.as_bytes());
        }
        None => hash.update([0u8]),
    }
}

fn digest_i64(hash: &mut Sha256, field: Option<i64>) {
    match field {
        Some(value) => {
            hash.update([1u8]);
            hash.update(value.to_le_bytes());
        }
        None => hash.update([0u8]),
    }
}
