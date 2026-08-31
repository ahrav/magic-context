mod envelope;
mod open;
mod outbox;
mod redaction;
mod retention;
pub mod schema;

pub use envelope::{
    AlignmentProjectionSpec, CommitIntent, CommitReceipt, DomainSpec, Envelope, KnownAsOf,
    ObjectRow, RemediationTarget, RepositoryProvenance, Sensitivity, StagingCandidateRow,
    StagingCandidateSpec, OPERATOR_REDACTION_PLACEHOLDER,
};
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
