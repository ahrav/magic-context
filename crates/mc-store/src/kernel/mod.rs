mod admission;
mod anchor;
pub mod applicability;
mod backup;
mod cas;
mod durable_fs;
mod envelope;
mod facts;
mod object_write;
mod open;
mod outbox;
mod redaction;
mod retention;
pub mod schema;
mod scope;
mod slice;

pub use admission::{
    evaluate_admission, surface_visibility, AdmissionDecision, AdmissionDomainSpec, AdmissionEvent,
    AdmissionRequest, Disposition, EffectiveMaturity, Evaluation, EvaluationInputs, EventKind,
    Maturity, Outcome, PriorDecision, SourceClass, Surface, SurfaceVisibility, TaintClass,
    VisibilityRow, POLICY_REVISION,
};
pub use anchor::{
    encode_anchor_captures, evaluate_non_git, AnchorCapture, AnchorCondition, AnchorDecodeError,
    AnchorEvaluation, AnchorKind, AnchorRowSpec, GitCondition, PatchIdCapture, QueryContext,
    ANCHOR_CAPTURE_SCHEMA,
};
#[cfg(all(target_os = "linux", feature = "test-support"))]
pub use backup::filesystem_is_unsafe_for_test;
#[cfg(all(target_os = "macos", feature = "test-support"))]
pub use backup::filesystem_name_is_unsafe_for_test;
#[cfg(feature = "test-support")]
pub use backup::{
    owner_is_current_for_test, sensitivity_bearing_tables_for_test,
    verify_backup_with_deadline_for_test, RestoreFault,
};
pub use backup::{BackupManifest, BackupRequest};
#[cfg(feature = "test-support")]
pub use cas::{
    ArtifactDeletionFault, ArtifactDeletionHook, ArtifactGcFault, ArtifactIngestFault,
    ArtifactIngestHook,
};
pub use cas::{
    ArtifactDeletionIdentity, ArtifactDeletionKind, ArtifactDeletionRequest,
    ArtifactDeletionResult, ArtifactDestination, ArtifactEligibility, ArtifactError,
    ArtifactErrorKind, ArtifactGcResult, ArtifactHandle, ArtifactIngestRequest,
    BarrierConsumerStatus, DeletionBarrierStatus, EligibilityDeniedReason, ProviderEgress,
};
pub use envelope::{
    AlignmentProjectionSpec, CommitIntent, CommitReceipt, DomainSpec, Envelope, KnownAsOf,
    ObjectRow, RemediationTarget, RepositoryProvenance, Sensitivity, StagingCandidateRow,
    StagingCandidateSpec, OPERATOR_REDACTION_PLACEHOLDER,
};
pub use facts::{ArtifactBudgetFacts, KernelFacts, MAIN_FILE_WARN_BYTES};
pub use open::{KernelError, KernelStore};
pub use outbox::{ConsumerAbandonment, OutboxPruneResult};
pub use retention::{StagingMaintenanceResult, StagingTerminalState, STAGING_RETENTION_MS};
pub use scope::{
    coerce_version, scope_equivalent, scope_matches, scope_overlaps, scope_subsumes,
    CanonicalScope, Dimension, GraphOracle, MatchOutcome, ScopeFormError, ScopeMatchContext,
    ScopeSpec, ScopeTermSpec, ScopeWriteOutcome, TermValue, UnknownGraph, VersionSpec,
};
pub use slice::{
    AlignmentRebuild, AlignmentRow, AlignmentSnapshot, DecisionEventOutcome, DecisionEventPayload,
    DecisionEventSpec, DecisionPayload, DecisionRow, DecisionSpec, DecisionWriteOutcome,
    ObservationDependencySpec, ObservationPayload, ObservationRow, ObservationSpec,
    ObservationWriteOutcome, RetirementOutcome, SliceSnapshot,
};

/// A constraint violation is permanent and a lock wait is retryable, so collapsing both into `Io` would make either untreatable.
pub(crate) fn map_sqlite(error: rusqlite::Error) -> KernelError {
    let rusqlite::Error::SqliteFailure(failure, _) = &error else {
        return KernelError::Io;
    };
    match failure.code {
        rusqlite::ffi::ErrorCode::ConstraintViolation => KernelError::Conflict,
        rusqlite::ffi::ErrorCode::DatabaseBusy | rusqlite::ffi::ErrorCode::DatabaseLocked => {
            KernelError::Busy
        }
        _ => KernelError::Io,
    }
}
