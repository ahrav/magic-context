//! Applicability engine: resolves anchors and scopes against a live checkout.
//!
//! The pure algebra lives in `kernel::scope` and `kernel::anchor`; this
//! module owns the IO edges — gitoxide checkout access and envelope commits.
//! All git access goes through `gix`; the kernel never spawns a subprocess.

mod checkout;
mod resolve;

pub use checkout::{
    open_isolated, snapshot_checkout, CheckoutSnapshot, DirtyEntry, EvalBudget, SnapshotError,
};
pub use resolve::{
    capture_anchor_representation, compute_patch_id, GitConditionOutcome, ResolutionLadder,
    ResolveObstacle, CANDIDATE_WINDOW, PATCH_ID_ALGORITHM,
};
