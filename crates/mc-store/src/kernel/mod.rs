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
pub use cas::ArtifactIngestFault;
pub use cas::{
    ArtifactDestination, ArtifactEligibility, ArtifactError, ArtifactErrorKind, ArtifactHandle,
    ArtifactIngestRequest, EligibilityDeniedReason, ProviderEgress,
};
pub use envelope::{
    AlignmentProjectionSpec, CommitIntent, CommitReceipt, DomainSpec, Envelope, KnownAsOf,
    ObjectRow, RemediationTarget, RepositoryProvenance, Sensitivity, StagingCandidateRow,
    StagingCandidateSpec, OPERATOR_REDACTION_PLACEHOLDER,
};
pub use facts::{KernelFacts, MAIN_FILE_WARN_BYTES};
pub use open::{KernelError, KernelStore};
pub use outbox::OutboxPruneResult;
pub use retention::{StagingMaintenanceResult, StagingTerminalState, STAGING_RETENTION_MS};

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
