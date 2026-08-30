mod envelope;
mod open;
mod redaction;
pub mod schema;

pub use envelope::{
    AlignmentProjectionSpec, CommitIntent, CommitReceipt, DomainSpec, Envelope, KnownAsOf,
    ObjectRow, RepositoryProvenance, Sensitivity, StagingCandidateRow, StagingCandidateSpec,
};
pub use open::{KernelError, KernelStore};

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
