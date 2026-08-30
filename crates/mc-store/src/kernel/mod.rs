mod envelope;
mod open;
mod redaction;
pub mod schema;

pub use envelope::{
    AlignmentProjectionSpec, CommitIntent, CommitReceipt, DomainSpec, Envelope, KnownAsOf,
    ObjectRow, RepositoryProvenance, Sensitivity, StagingCandidateRow, StagingCandidateSpec,
};
pub use open::{KernelError, KernelStore};

/// Separates a constraint violation a caller can act on, a lock wait a caller may retry, and genuine I/O failure. commentlint: allow(JUDGE)
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
