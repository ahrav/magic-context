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
pub use repair::{commit_read_repair, AppendOutcome, BlockState, InjectionBlock, RepairIntent};
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
}

impl ApplicabilityReport {
    /// The objects repair appended for this request, with their outcomes.
    pub fn appends(&self) -> impl Iterator<Item = (&str, &AppendOutcome)> {
        self.objects.iter().filter_map(|object| {
            object
                .append
                .as_ref()
                .map(|append| (object.object_id.as_str(), append))
        })
    }
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

/// Re-reductions attempted when the tip moves under an auto-injectable verdict.
///
/// Each pass narrows the window to the commits that landed during it. Sustained
/// concurrent writes stop the retries rather than the report: a block recorded
/// after the last read is caught by the next evaluation, which is the same
/// guarantee a single read gives once the object is reported.
const BLOCK_FENCE_ATTEMPTS: usize = 2;

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
        if repair_indices.is_empty() {
            return Ok(ApplicabilityReport {
                objects,
                stats: batch.stats,
            });
        }
        // Reducing per object took the reader lock and re-derived the committed
        // tip once per object, and deriving that tip walks the live registry.
        let reduced = match store.applicability_block_states_as_of_tip(
            &repair_indices
                .iter()
                .map(|index| objects[*index].object_id.as_str())
                .collect::<Vec<_>>(),
            snapshot.identity(),
            budget,
        ) {
            Ok(reduced) => reduced,
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
                });
            }
            Err(error) => return Err(error),
        };
        let (mut reduced_as_of, blocks) = reduced;
        let mut remaining = repair_indices.as_slice();
        while let Some((index, rest)) = remaining.split_first() {
            let index = *index;
            // The repair pass commits, so it polls the budget per object rather
            // than running a whole batch past an expired deadline. Objects it
            // never reaches still need their labels reconciled: one whose block
            // stands cannot stay current just because the pass stopped early.
            if budget.is_exhausted() {
                for index in remaining {
                    let state = blocks.get(objects[*index].object_id.as_str()).cloned();
                    demote_if_blocked(
                        &mut objects[*index],
                        state.as_ref(),
                        "evaluation deadline expired before the clearing append",
                    );
                }
                break;
            }
            remaining = rest;
            let state = blocks.get(objects[index].object_id.as_str()).cloned();
            // An unreadable record leaves freshness unprovable, and its
            // generation unknowable, so the object degrades on its own instead
            // of a repair being built from a record nothing could read.
            if matches!(state, Some(BlockState::Unreadable)) {
                demote_if_blocked(
                    &mut objects[index],
                    state.as_ref(),
                    "durable applicability record is unreadable",
                );
                continue;
            }
            let block = match &state {
                Some(BlockState::Recorded(block)) => Some(block),
                _ => None,
            };
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
                // The durable record is this verdict, so nothing is outstanding.
                objects[index].append_pending = false;
                continue;
            }
            // Nothing blocked means nothing to clear: no record, a record that
            // already reads current, or a history whose records were all
            // invalidated. Appending a clear over any of those writes durably to
            // lift a block that is not there.
            if object.state == ApplicabilityState::Current
                && !block.is_some_and(|block| block.blocked)
            {
                continue;
            }
            let outcome = commit_read_repair(store, self, &snapshot, object, &intent, budget)?;
            let unresolved = match outcome {
                AppendOutcome::Landed { .. } => None,
                AppendOutcome::Discarded => Some("checkout moved before the clearing append"),
                AppendOutcome::DeadlineMissed => {
                    Some("evaluation deadline expired before the clearing append")
                }
                AppendOutcome::ReceiptWithoutRecord => {
                    Some("the clearing record this repair replayed is no longer live")
                }
            };
            match unresolved {
                Some(reason) => {
                    demote_if_blocked(&mut objects[index], state.as_ref(), reason);
                    // The append is still owed. A current classification carries
                    // `append_pending` false, so demoting it without setting this
                    // would report no outstanding work while the clear is unwritten.
                    objects[index].append_pending = true;
                }
                // `append_pending` marks an append still owed. This one landed,
                // so a consumer reading the report has nothing to retry.
                None => objects[index].append_pending = false,
            }
            objects[index].append = Some(outcome);
        }
        // Deciding not to clear a block is a read-then-act with no transaction
        // around it, so a concurrent evaluation can record one in between. An
        // unchanged tip proves no commit landed since the reduction; a moved tip
        // is re-reduced, and an object blocked by what landed is demoted.
        //
        // A bound reached before the check completes cannot prove the reduction
        // current, so every verdict that would auto-inject reports uncertain,
        // matching the initial reduction's deadline path.
        const UNFENCED: &str = "durable applicability state could not be rechecked";
        for _ in 0..BLOCK_FENCE_ATTEMPTS {
            let tip = match store.applicability_tip(budget) {
                Ok(tip) => tip,
                Err(KernelError::Deadline) => {
                    demote_unfenced(&mut objects, UNFENCED);
                    break;
                }
                Err(error) => return Err(error),
            };
            if tip == reduced_as_of {
                break;
            }
            let injectable: Vec<usize> = objects
                .iter()
                .enumerate()
                .filter(|(_, object)| !object.state.blocks_auto_injection())
                .map(|(index, _)| index)
                .collect();
            if injectable.is_empty() {
                break;
            }
            let refreshed = store.applicability_block_states_as_of_tip(
                &injectable
                    .iter()
                    .map(|index| objects[*index].object_id.as_str())
                    .collect::<Vec<_>>(),
                snapshot.identity(),
                budget,
            );
            let (as_of, refreshed) = match refreshed {
                Ok(refreshed) => refreshed,
                Err(KernelError::Deadline) => {
                    demote_unfenced(&mut objects, UNFENCED);
                    break;
                }
                Err(error) => return Err(error),
            };
            for index in injectable {
                let state = refreshed.get(objects[index].object_id.as_str()).cloned();
                demote_if_blocked(
                    &mut objects[index],
                    state.as_ref(),
                    "a durable block was recorded during this evaluation",
                );
            }
            reduced_as_of = as_of;
        }
        Ok(ApplicabilityReport {
            objects,
            stats: batch.stats,
        })
    }
}

/// Every verdict that would auto-inject reports uncertain, for a bound reached
/// before the durable state could be rechecked. Without that recheck no current
/// verdict can be shown unblocked.
fn demote_unfenced(objects: &mut [ObjectApplicability], reason: &str) {
    for object in objects {
        if !object.state.blocks_auto_injection() {
            object.state = ApplicabilityState::Uncertain;
            object.evidence = format!("durable applicability block not cleared: {reason}");
        }
    }
}

/// A current classification whose durable block still stands cannot be
/// auto-injected: the block applies to every reader, not just this request.
fn demote_if_blocked(object: &mut ObjectApplicability, state: Option<&BlockState>, reason: &str) {
    let blocked = match state {
        Some(BlockState::Recorded(block)) => block.blocked,
        // Freshness that cannot be read cannot be shown clear.
        Some(BlockState::Unreadable) => true,
        None => false,
    };
    if object.state != ApplicabilityState::Current || !blocked {
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
