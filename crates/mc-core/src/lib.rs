//!
//! This crate makes origin-agnostic classification decisions.
//! The `mc-module` crate performs rendering and I/O.
//! The cache core freezes supplied rendered units and does not select them.

#![forbid(unsafe_code)]

pub mod claim_operation;
pub mod decay;
pub mod redaction;

#[cfg(feature = "cache-core")]
pub use cortexkit_cache_core::{
    Action, CoreState, DurabilityClass, FrozenUnit, PassInput, StepResult,
};

/// `CkItem` represents a decoded conversation item supplied by an outer system.
/// This crate never parses provider wire bytes.
pub trait CkItem {
    /// `id` is stable and defines the coverage boundary.
    fn id(&self) -> &str;
    /// Ordinal values strictly increase across the lineage.
    /// An ordinal is absolute rather than positional; moving the window does not change it.
    fn ordinal(&self) -> u64;
    /// `bytes` returns this item's opaque, byte-complete rendering.
    fn bytes(&self) -> &str;
    /// Synthetic items are module-generated `m0` or `m1` blocks, not conversation items.
    /// Boundary, coverage, and tail computation exclude synthetic items.
    fn synthetic(&self) -> bool {
        false
    }
}

/// The consuming module computes every `ClassifierInput` field.
/// This crate receives decision inputs without inspecting frozen units.
#[derive(Debug, Clone, Default)]
pub struct ClassifierInput {
    /// `initialized` is `false` for a fresh session.
    /// A false `initialized` value selects bootstrap Hard before any defer can replay a baseline.
    pub initialized: bool,
    /// `is_legacy_baseline` is true only for one `"baseline"` frozen unit with no pending changes.
    /// Only the legacy baseline shape permits destructive clear-then-Hard migration.
    pub is_legacy_baseline: bool,
    /// A valid current frozen set contains exactly one `m0`, exactly one `m1`, and zero or more `red:*` units.
    /// An initialized shape is rejected only when it is neither legacy, `cached_m1_missing`, nor valid.
    /// Unknown frozen-set shapes are rejected and never cleared.
    pub valid_m0m1_shape: bool,
    /// An initialized state with one valid `m0` and no `m1` is rebuilt with Hard rather than rejected as unknown.
    pub cached_m1_missing: bool,
    /// Render-config (model/system/tool) differs from the persisted one → epoch Hard.
    pub render_config_changed: bool,
    /// A HARD trigger fired (compaction fold / idle-ttl / pressure) — decider-supplied.
    pub hard_fold_requested: bool,
    pub boundary_present: bool,
    /// `reconcile_pending` is true when an earlier defer loses the boundary.
    pub reconcile_pending: bool,
    /// `m1_revision_changed` compares revisions without rendering bytes.
    pub m1_revision_changed: bool,
    /// `reductions_pending` is true when a live-tail decision targets an ID absent from the frozen reduction set.
    /// ID membership is sufficient because frozen reductions are immutable.
    /// Within an epoch, only a previously unseen target ID changes the frozen reductions.
    /// `reductions_pending` and `m1_revision_changed` coalesce into one `Soft` pass when `boundary_present` and `bust_opportunity` are true.
    pub reductions_pending: bool,
    /// `bust_opportunity` is true only when an independent reason already renders bytes.
    /// Without `bust_opportunity`, an in-session m1 delta is deferred.
    pub bust_opportunity: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassPlan {
    Hard,
    MigrateHard,
    Soft,
    Defer,
    Reject(&'static str),
}

///
/// in `cortexkit-cache-core`):
pub fn classify(input: &ClassifierInput) -> PassPlan {
    if !input.initialized {
        return PassPlan::Hard;
    }
    if input.is_legacy_baseline {
        return PassPlan::MigrateHard;
    }
    // A missing m1 is a recoverable cache shape, not an unknown schema.
    if input.cached_m1_missing {
        return PassPlan::Hard;
    }
    if !input.valid_m0m1_shape {
        return PassPlan::Reject("unknown frozen-set shape");
    }
    if input.render_config_changed {
        return PassPlan::Hard;
    }
    if input.hard_fold_requested {
        return PassPlan::Hard;
    }
    if input.reconcile_pending && !input.boundary_present {
        return PassPlan::Hard;
    }
    if input.reconcile_pending {
        return PassPlan::Defer;
    }
    if input.boundary_present
        && input.bust_opportunity
        && (input.m1_revision_changed || input.reductions_pending)
    {
        return PassPlan::Soft;
    }
    PassPlan::Defer
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> ClassifierInput {
        ClassifierInput {
            initialized: true,
            valid_m0m1_shape: true,
            boundary_present: true,
            bust_opportunity: true,
            ..Default::default()
        }
    }

    #[test]
    fn bootstrap_when_uninitialized_is_hard() {
        let input = ClassifierInput {
            initialized: false,
            m1_revision_changed: true,
            ..Default::default()
        };
        assert_eq!(classify(&input), PassPlan::Hard);
    }

    #[test]
    fn legacy_baseline_migrates() {
        let input = ClassifierInput {
            is_legacy_baseline: true,
            valid_m0m1_shape: false, // legacy is not m0/m1-valid, but rule 2 wins
            m1_revision_changed: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::MigrateHard);
    }

    #[test]
    fn missing_m1_is_rebuilt_as_hard() {
        let input = ClassifierInput {
            cached_m1_missing: true,
            valid_m0m1_shape: false,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Hard);
    }

    #[test]
    fn unknown_shape_rejects_never_clears() {
        let input = ClassifierInput {
            is_legacy_baseline: false,
            valid_m0m1_shape: false,
            m1_revision_changed: true,
            ..base()
        };
        assert!(matches!(classify(&input), PassPlan::Reject(_)));
    }

    #[test]
    fn epoch_change_is_hard() {
        let input = ClassifierInput {
            render_config_changed: true,
            m1_revision_changed: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Hard);
    }

    #[test]
    fn hard_fold_requested_is_hard() {
        let input = ClassifierInput {
            hard_fold_requested: true,
            m1_revision_changed: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Hard);
    }

    #[test]
    fn reconcile_boundary_absent_rematerializes() {
        let input = ClassifierInput {
            reconcile_pending: true,
            boundary_present: false,
            m1_revision_changed: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Hard);
    }

    #[test]
    fn reconcile_boundary_present_defers_to_clear() {
        let input = ClassifierInput {
            reconcile_pending: true,
            boundary_present: true,
            m1_revision_changed: true, // even with a delta, the clearing defer wins
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Defer);
    }

    #[test]
    fn soft_delta_rides_only_with_boundary_present() {
        let present = ClassifierInput {
            boundary_present: true,
            m1_revision_changed: true,
            ..base()
        };
        assert_eq!(classify(&present), PassPlan::Soft);

        let absent = ClassifierInput {
            boundary_present: false,
            m1_revision_changed: true,
            reconcile_pending: false,
            ..base()
        };
        assert_eq!(classify(&absent), PassPlan::Defer);
    }

    #[test]
    fn pending_delta_without_bust_opportunity_defers() {
        let input = ClassifierInput {
            m1_revision_changed: true,
            bust_opportunity: false,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Defer);
    }

    #[test]
    fn boundary_present_no_delta_defers() {
        let input = ClassifierInput {
            boundary_present: true,
            m1_revision_changed: false,
            reductions_pending: false,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Defer);
    }

    #[test]
    fn a_new_reduction_rides_a_soft() {
        let input = ClassifierInput {
            boundary_present: true,
            m1_revision_changed: false,
            reductions_pending: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Soft);
    }

    #[test]
    fn m1_and_reduction_coalesce_into_one_soft() {
        let input = ClassifierInput {
            boundary_present: true,
            m1_revision_changed: true,
            reductions_pending: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Soft);
    }

    #[test]
    fn boundary_absent_reduction_defers_never_soft() {
        let input = ClassifierInput {
            boundary_present: false,
            m1_revision_changed: true,
            reductions_pending: true,
            reconcile_pending: false,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Defer);
    }
}
