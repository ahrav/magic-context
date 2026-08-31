//! Applicability engine: resolves anchors and scopes against a live checkout.
//!
//! The pure algebra lives in `kernel::scope` and `kernel::anchor`; this
//! module owns the IO edges — gitoxide checkout access and envelope commits.
//! All git access goes through `gix`; the kernel never spawns a subprocess.

mod cache;
mod checkout;
mod checks;
mod engine;
mod payloads;
mod repair;
mod resolve;

use std::path::Path;

use super::anchor::QueryContext;
use super::scope::ScopeMatchContext;
use super::{KernelError, KernelStore};

pub use checkout::{
    open_isolated, snapshot_checkout, CheckoutSnapshot, DirtyEntry, EvalBudget, SnapshotError,
};
pub use checks::{run_cheap_check, CheckOutcome};
pub use engine::{
    ApplicabilityCandidate, ApplicabilityEngine, ApplicabilityState, BatchEvaluation,
    ClassificationToken, EvaluationStats, FailedCheck, ObjectApplicability,
};
pub use payloads::PayloadDecodeError;
pub use payloads::{
    ApplicabilityObservationPayload, CheckSpec, ObjectApplicabilitySpec, DEPENDENCY_KIND_TARGET,
    OBJECT_APPLICABILITY_SCHEMA, OBSERVATION_APPLICABILITY_SCHEMA, OBSERVATION_KIND_CURRENT,
    OBSERVATION_KIND_HISTORICAL, OBSERVATION_KIND_STALE, OBSERVATION_KIND_UNCERTAIN,
};
pub use repair::{
    commit_read_repair, AppendOutcome, InjectionBlock, PriorBlockState, RepairIntent,
};
pub use resolve::{
    capture_anchor_representation, compute_patch_id, GitConditionOutcome, ResolutionLadder,
    CANDIDATE_WINDOW, PATCH_ID_ALGORITHM,
};

/// One batch evaluation request against a checkout path.
#[derive(Debug, Clone)]
pub struct ApplicabilityRequest<'a> {
    pub checkout_path: &'a Path,
    pub query: &'a QueryContext,
    pub scope_context: &'a ScopeMatchContext,
    pub candidates: &'a [ApplicabilityCandidate],
    /// Domain owning the applicability observations repair appends.
    pub domain_id: &'a str,
    /// Actor recorded on repair commits.
    pub actor: &'a str,
    /// Observation timestamp in UTC milliseconds.
    pub observed_at: i64,
}

/// Batch verdict: one labeled status per candidate. Domain outcomes
/// (including every uncertainty) live inside; only store failures surface
/// as errors — a corrupt store never renders as a mere "uncertain" label.
#[derive(Debug, Clone)]
pub struct ApplicabilityReport {
    pub objects: Vec<ObjectApplicability>,
    pub stats: EvaluationStats,
    /// Durable append outcomes for the objects repair touched this request,
    /// in `objects` order (objects without appends are absent).
    pub appends: Vec<(String, AppendOutcome)>,
}

impl ApplicabilityReport {
    /// The auto-injection view: current objects only.
    pub fn auto_injectable(&self) -> impl Iterator<Item = &ObjectApplicability> {
        self.objects
            .iter()
            .filter(|object| !object.state.blocks_auto_injection())
    }

    /// The explicit-search view: every non-current object with its
    /// mandatory state label. There is no unlabeled escape hatch.
    pub fn labeled_non_current(
        &self,
    ) -> impl Iterator<Item = (&'static str, &ObjectApplicability)> {
        self.objects
            .iter()
            .filter(|object| object.state.blocks_auto_injection())
            .map(|object| (object.state.label(), object))
    }
}

impl ApplicabilityEngine {
    /// The one entry point retrieval consumers use: snapshot the checkout
    /// once, classify the batch, and perform read repair for stale and
    /// clearing classifications. kh8.6 composes the result as an input
    /// predicate; no visibility policy lives here.
    ///
    /// A checkout that cannot be snapshotted (unreadable, unborn HEAD,
    /// budget exhausted) classifies every candidate uncertain — that is a
    /// domain outcome, not a store failure.
    pub fn evaluate(
        &self,
        store: &KernelStore,
        request: &ApplicabilityRequest<'_>,
        budget: &EvalBudget,
    ) -> Result<ApplicabilityReport, KernelError> {
        let snapshot = match snapshot_checkout(request.checkout_path, budget) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return Ok(ApplicabilityReport {
                    objects: uncertain_batch(request.candidates, &error),
                    stats: EvaluationStats::default(),
                    appends: Vec::new(),
                });
            }
        };
        let batch = self.evaluate_batch(
            &snapshot,
            request.query,
            request.scope_context,
            request.candidates,
            budget,
        );
        let mut appends = Vec::new();
        // One committed tip for the whole batch: every block-state read in
        // this request sees the same snapshot of the observation log.
        let tip = store_tip(store)?;
        for object in &batch.objects {
            // Only stale classifications and current re-evaluations earn
            // durable appends; the other states are recomputable in-request
            // vetoes.
            if !matches!(
                object.state,
                ApplicabilityState::Stale | ApplicabilityState::Current
            ) {
                continue;
            }
            let prior_block =
                store.applicability_block_state(&object.object_id, snapshot.identity(), tip)?;
            let durably_blocked = prior_block.as_ref().is_some_and(|block| block.blocked);
            let appends_durably = match object.state {
                // A stale verdict appends when its own append is pending or
                // when the durable record disagrees (a clear landed since
                // the cached classification confirmed its append).
                ApplicabilityState::Stale => object.append_pending || !durably_blocked,
                // A current verdict appends only to clear a recorded block.
                ApplicabilityState::Current => durably_blocked,
                _ => false,
            };
            if !appends_durably {
                continue;
            }
            let Some(intent) = RepairIntent::for_classification(
                &snapshot,
                object,
                request.domain_id,
                request.actor,
                request.observed_at,
                PriorBlockState(prior_block.and_then(|block| block.latest_clear_commit_seq)),
            ) else {
                continue;
            };
            let outcome = commit_read_repair(store, self, &snapshot, object, &intent, budget)?;
            appends.push((object.object_id.clone(), outcome));
        }
        Ok(ApplicabilityReport {
            objects: batch.objects,
            stats: batch.stats,
            appends,
        })
    }
}

fn store_tip(store: &KernelStore) -> Result<i64, KernelError> {
    Ok(store.known_as_of(0)?.tip)
}

fn uncertain_batch(
    candidates: &[ApplicabilityCandidate],
    error: &SnapshotError,
) -> Vec<ObjectApplicability> {
    candidates
        .iter()
        .map(|candidate| {
            ObjectApplicability::uncertain_without_snapshot(
                candidate,
                format!("checkout snapshot unavailable: {error}"),
            )
        })
        .collect()
}
