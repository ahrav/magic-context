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
mod resolve;

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
pub use resolve::{
    capture_anchor_representation, compute_patch_id, GitConditionOutcome, ResolutionLadder,
    ResolveObstacle, CANDIDATE_WINDOW, PATCH_ID_ALGORITHM,
};
