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
    checkout_identity_digest, ApplicabilityObservationPayload, CheckSpec, ObjectApplicabilitySpec,
    PayloadDecode, DEPENDENCY_KIND_TARGET, OBJECT_APPLICABILITY_SCHEMA,
    OBSERVATION_APPLICABILITY_SCHEMA, OBSERVATION_KIND_CURRENT,
    OBSERVATION_KIND_DIRTY_TREE_UNCERTAIN, OBSERVATION_KIND_HISTORICAL,
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
        // Every stale or current classification is reconciled against the
        // durable record, not against the engine's append-confirmed flag. That
        // flag records only that some earlier append landed; a clearing
        // observation since then makes the confirmation stale, and a cached
        // stale verdict would otherwise skip repair and leave the block lifted.
        let repair_indices: Vec<usize> = objects
            .iter()
            .enumerate()
            .filter(|(_, object)| {
                matches!(
                    object.state,
                    ApplicabilityState::Stale | ApplicabilityState::Current
                )
            })
            .map(|(index, _)| index)
            .collect();
        // Reducing per object took the reader lock and re-derived the committed
        // tip once per object, and deriving that tip walks the live registry.
        let blocks = match store.applicability_block_states_at_tip(
            &repair_indices
                .iter()
                .map(|index| objects[*index].object_id.as_str())
                .collect::<Vec<_>>(),
            snapshot.identity(),
            budget,
        ) {
            Ok(blocks) => blocks,
            // A deadline is a domain outcome, not a store failure. Without the
            // durable record no current verdict can be shown unblocked, so
            // every one of them reports uncertain.
            Err(KernelError::Deadline) => {
                for index in &repair_indices {
                    if objects[*index].state == ApplicabilityState::Current {
                        objects[*index].state = ApplicabilityState::Uncertain;
                        objects[*index].evidence =
                            "durable applicability block unread: evaluation deadline expired"
                                .to_string();
                    }
                }
                return Ok(ApplicabilityReport {
                    objects,
                    stats: batch.stats,
                    appends: Vec::new(),
                });
            }
            Err(error) => return Err(error),
        };
        let mut appends = Vec::new();
        let mut remaining = repair_indices.as_slice();
        while let Some((index, rest)) = remaining.split_first() {
            let index = *index;
            // The repair pass commits, so it polls the budget per object rather
            // than running a whole batch past an expired deadline. Objects it
            // never reaches still need their labels reconciled: one whose block
            // stands cannot stay current just because the pass stopped early.
            if budget.is_exhausted() {
                for index in remaining {
                    let block = blocks.get(objects[*index].object_id.as_str()).cloned();
                    demote_if_blocked(
                        &mut objects[*index],
                        block.as_ref(),
                        "evaluation deadline expired before the clearing append",
                    );
                }
                break;
            }
            remaining = rest;
            let block = blocks.get(objects[index].object_id.as_str());
            let object = &objects[index];
            let Some(intent) = RepairIntent::for_classification(
                &snapshot,
                object,
                block,
                request.actor,
                request.observed_at,
            ) else {
                continue;
            };
            // Matching the kind is not enough: a stale record from an earlier
            // HEAD or dirty fingerprint describes a checkout state this repair
            // does not, and deep verification needs evidence for the current
            // one. The dedup identity covers the whole snapshot, so comparing
            // it skips only a repair the record already is.
            if block.is_some_and(|block| block.repair_identity == intent.operation_key()) {
                continue;
            }
            // Nothing recorded means nothing to clear.
            if object.state == ApplicabilityState::Current && block.is_none() {
                continue;
            }
            let outcome = commit_read_repair(store, self, &snapshot, object, &intent, budget)?;
            let unresolved = match outcome {
                AppendOutcome::Landed { .. } => None,
                AppendOutcome::Discarded => Some("checkout moved before the clearing append"),
                AppendOutcome::DeadlineMissed => {
                    Some("evaluation deadline expired before the clearing append")
                }
            };
            if let Some(reason) = unresolved {
                let block = block.cloned();
                demote_if_blocked(&mut objects[index], block.as_ref(), reason);
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

/// A current classification whose durable block still stands cannot be
/// auto-injected: the block applies to every reader, not just this request.
fn demote_if_blocked(
    object: &mut ObjectApplicability,
    block: Option<&InjectionBlock>,
    reason: &str,
) {
    if object.state != ApplicabilityState::Current || !block.is_some_and(|block| block.blocked) {
        return;
    }
    object.state = ApplicabilityState::Uncertain;
    object.evidence = format!("durable applicability block not cleared: {reason}");
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
