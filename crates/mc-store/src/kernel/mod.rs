mod backup;
mod cas;
mod durable_fs;
mod envelope;
mod facts;
mod open;
mod outbox;
mod redaction;
mod retention;
pub mod schema;

#[cfg(feature = "test-support")]
pub use backup::{
    filesystem_is_unsafe_for_test, filesystem_name_is_unsafe_for_test, owner_is_current_for_test,
    verify_backup_with_deadline_for_test, BackupFault, RestoreFault,
};
pub use backup::{BackupManifest, BackupRequest, BackupResult};
pub use cas::{
    ArtifactDestination, ArtifactEligibility, ArtifactError, ArtifactErrorKind, ArtifactGcResult,
    ArtifactHandle, ArtifactIngestRequest, EligibilityDeniedReason, ProviderEgress,
};
#[cfg(feature = "test-support")]
pub use cas::{ArtifactGcFault, ArtifactIngestFault};
#[cfg(feature = "test-support")]
pub use envelope::CommitFault;
pub use envelope::{
    AlignmentProjectionSpec, CommitIntent, CommitReceipt, DomainSpec, Envelope, KnownAsOf,
    ObjectRow, ProjectionReplaceResult, RemediationTarget, RepositoryProvenance, Sensitivity,
    StagingCandidateRow, StagingCandidateSpec, OPERATOR_REDACTION_PLACEHOLDER,
};
pub use facts::{ArtifactBudgetFacts, KernelFacts, MAIN_FILE_WARN_BYTES};
pub use open::{KernelError, KernelErrorKind, KernelStore};
pub use outbox::OutboxPruneResult;
pub use retention::{StagingMaintenanceResult, StagingTerminalState};
