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
    open_isolated, snapshot_checkout, CheckoutSnapshot, DirtyEntry, EvalBudget, PathEncoding,
    SnapshotError,
};
pub use checks::{run_cheap_check, CheckCache, CheckOutcome, MAX_CONFIG_BYTES};
pub use engine::{
    ApplicabilityCandidate, ApplicabilityEngine, ApplicabilityState, BatchEvaluation,
    ClassificationToken, EvaluationStats, FailedCheck, ObjectApplicability,
};
pub use payloads::{
    ApplicabilityObservationPayload, CheckSpec, ObjectApplicabilitySpec, PayloadDecode,
    DEPENDENCY_KIND_TARGET, OBJECT_APPLICABILITY_SCHEMA, OBSERVATION_APPLICABILITY_SCHEMA,
    OBSERVATION_KIND_CURRENT, OBSERVATION_KIND_DIRTY_TREE_UNCERTAIN, OBSERVATION_KIND_HISTORICAL,
    OBSERVATION_KIND_LIFECYCLE_INVALIDATED, OBSERVATION_KIND_OUT_OF_SCOPE, OBSERVATION_KIND_STALE,
    OBSERVATION_KIND_UNCERTAIN,
};
pub use repair::{commit_read_repair, AppendOutcome, InjectionBlock, RepairIntent};
pub use resolve::{
    capture_anchor_representation, compute_patch_id, GitConditionOutcome, ResolutionLadder,
    ResolveObstacle, CANDIDATE_WINDOW, PATCH_ID_ALGORITHM,
};

/// One batch evaluation request against a checkout path.
#[derive(Debug, Clone)]
pub struct ApplicabilityRequest<'a> {
    pub checkout_path: &'a Path,
    pub query: &'a QueryContext,
    pub scope_context: &'a ScopeMatchContext,
    pub candidates: &'a [ApplicabilityCandidate],
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
    ///
    /// An object whose durable block this request could not clear reports commentlint: allow(JUDGE)
    /// uncertain rather than current: the block still stands for every other commentlint: allow(JUDGE)
    /// reader, so a current label here would auto-inject a blocked object. commentlint: allow(JUDGE)
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
        let mut objects = batch.objects;
        let repair_indices: Vec<usize> = objects
            .iter()
            .enumerate()
            .filter(|(_, object)| {
                object.append_pending || object.state == ApplicabilityState::Current
            })
            .map(|(index, _)| index)
            .collect();
        // Reducing per object took the reader lock and re-derived the committed
        // tip once per object, and deriving that tip walks the live registry.
        let blocks = store.applicability_block_states_at_tip(
            &repair_indices
                .iter()
                .map(|index| objects[*index].object_id.as_str())
                .collect::<Vec<_>>(),
            snapshot.identity(),
            budget,
        )?;
        let mut appends = Vec::new();
        for index in repair_indices {
            // The repair pass commits, so it polls the budget per object rather
            // than running a whole batch past an expired deadline.
            if budget.is_exhausted() {
                break;
            }
            let block = blocks.get(objects[index].object_id.as_str());
            let object = &objects[index];
            if object.state == ApplicabilityState::Current
                && !block.is_some_and(|block| block.blocked)
            {
                continue;
            }
            let Some(intent) = RepairIntent::for_classification(
                &snapshot,
                object,
                block,
                request.actor,
                request.observed_at,
            ) else {
                continue;
            };
            let outcome = commit_read_repair(store, self, &snapshot, object, &intent, budget)?;
            // A durable block this request could not clear still blocks every
            // other reader, so a `Current` label here would auto-inject an
            // object the store considers blocked.
            let unresolved = match outcome {
                AppendOutcome::Landed { .. } => None,
                AppendOutcome::Discarded => Some("checkout moved before the clearing append"),
                AppendOutcome::DeadlineMissed => {
                    Some("deadline expired before the clearing append")
                }
            };
            if let Some(reason) = unresolved {
                if objects[index].state == ApplicabilityState::Current {
                    objects[index].state = ApplicabilityState::Uncertain;
                    objects[index].evidence =
                        format!("durable applicability block not cleared: {reason}");
                }
            }
            appends.push((objects[index].object_id.clone(), outcome));
        }
        Ok(ApplicabilityReport {
            objects,
            stats: batch.stats,
            appends,
        })
    }
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
