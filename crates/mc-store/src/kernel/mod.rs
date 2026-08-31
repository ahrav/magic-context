mod backup;
mod durable_fs;
mod envelope;
mod facts;
mod open;
mod outbox;
mod redaction;
mod retention;
pub mod schema;

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
pub use envelope::CommitFault;
pub use envelope::{
    AlignmentProjectionSpec, CommitIntent, CommitReceipt, DomainSpec, Envelope, KnownAsOf,
    ObjectRow, ProjectionReplaceResult, RemediationTarget, RepositoryProvenance, Sensitivity,
    StagingCandidateRow, StagingCandidateSpec, OPERATOR_REDACTION_PLACEHOLDER,
};
pub use facts::{KernelFacts, MAIN_FILE_WARN_BYTES};
pub use open::{KernelError, KernelErrorKind, KernelStore};
pub use outbox::OutboxPruneResult;
pub use retention::{StagingMaintenanceResult, StagingTerminalState};
