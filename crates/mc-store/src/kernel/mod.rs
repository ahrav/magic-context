mod envelope;
mod open;
mod outbox;
mod redaction;
mod retention;
pub mod schema;

#[cfg(feature = "test-support")]
pub use envelope::CommitFault;
pub use envelope::{
    AlignmentProjectionSpec, CommitIntent, CommitReceipt, DomainSpec, Envelope, KnownAsOf,
    ObjectRow, ProjectionReplaceResult, RemediationTarget, RepositoryProvenance, Sensitivity,
    StagingCandidateRow, StagingCandidateSpec, OPERATOR_REDACTION_PLACEHOLDER,
};
pub use open::{KernelError, KernelErrorKind, KernelStore};
pub use outbox::OutboxPruneResult;
pub use retention::{StagingMaintenanceResult, StagingTerminalState, STAGING_RETENTION_MS};
