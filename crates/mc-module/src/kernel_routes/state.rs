//! The closed outcome vocabulary every `kernel.*` route answers with.
//!
//! Three exhaustive matches map [`KernelError`], [`ArtifactErrorKind`], and
//! route-local conditions onto [`KernelOutcome`]; none has a wildcard arm, so a
//! new kernel variant fails to compile here until it is classified. The
//! TypeScript thin client projects this enum onto its `MemoryState` union.

use mc_kernel::{ArtifactErrorKind, KernelError};
use serde::Serialize;

/// Serialized as `{"kind": ..., ...}`; the client treats an unknown `kind`
/// as `invalid(unrecognized_state)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KernelOutcome {
    Available,
    /// A gated `explicit_search` read past the lag threshold.
    Stale {
        lag_positions: i64,
        oldest_unconsumed_age_ms: i64,
    },
    /// A gated `auto_search` read past the lag threshold.
    Abstained {
        lag_positions: i64,
        oldest_unconsumed_age_ms: i64,
    },
    Unavailable {
        reason: UnavailableReason,
    },
    Conflict {
        reason: ConflictReason,
    },
    Invalid {
        reason: InvalidReason,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableReason {
    /// The kernel store has not finished opening.
    StoreStarting,
    /// The kernel store failed to open or lost its lease.
    StoreUnavailable,
    /// The kernel store cannot be opened by this build: foreign or corrupt
    /// file, unsupported engine, or identity mismatch.
    StoreUnsupported,
    /// The writer or a lease is held; the next request may succeed.
    StoreBusy,
    /// No consumer is registered, so gated reads cannot be judged fresh.
    NoRequiredConsumer,
    /// The client's `as_of` is ahead of the store's tip.
    SnapshotDiverged,
    /// The staging budget for paged artifact uploads is exhausted, or the
    /// route already has an upload in flight.
    QueueFull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictReason {
    KnownAsOfAdvanced,
    Retracted,
    Superseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InvalidReason {
    /// A request named a project or root other than the route binding's.
    ProjectMismatch,
    /// An `operation_key` was reused with a different `request_digest`.
    OperationKeyReused,
    /// A plugin route asserted a source or sensitivity class above the one
    /// the daemon derives.
    ClassOverDeclared,
    /// Kernel input validation or admission policy rejected the request.
    InvalidInput,
    AdmissionPolicy,
    /// The named object does not exist, is not live, or is not scoped to the
    /// bound project.
    NotFound,
    /// A write named an id the registry already holds or otherwise violated a
    /// storage constraint; retrying with fresh tokens cannot succeed.
    AlreadyExists,
    /// A successor's `source_revision` does not exceed its predecessor's.
    /// Retrying with a higher revision can succeed.
    RevisionNotAdvanced,
    /// A foreign scope occupies the bound project's reserved scope id.
    /// Retrying cannot succeed until that scope is removed.
    ScopeReserved,
    PayloadTooLarge,
    /// A staged page's bytes do not match its declared digest, or a page index
    /// was resent with different bytes.
    PageDigest,
    /// A page does not fit the declared upload layout: its index is past
    /// `page_count`, its bytes overrun `total_bytes`, or `finish` was called
    /// with pages still missing.
    PageIndex,
    /// A page decodes to more bytes than one page may carry.
    PageTooLarge,
    /// The assembled payload does not hash to the declared payload digest.
    PayloadDigest,
    /// The named upload is not in flight on this route.
    UploadNotFound,
    /// Artifact ingestion is fail-closed until the store reopens.
    IngestionFailClosed,
    /// An artifact is referenced but not live, or the payload holds a secret
    /// the redactor cannot rewrite.
    ArtifactUnusable,
    /// A kernel outcome no `kernel.*` route can produce reached the mapping.
    Internal,
}

impl KernelOutcome {
    pub const fn unavailable(reason: UnavailableReason) -> Self {
        Self::Unavailable { reason }
    }

    pub const fn conflict(reason: ConflictReason) -> Self {
        Self::Conflict { reason }
    }

    pub const fn invalid(reason: InvalidReason) -> Self {
        Self::Invalid { reason }
    }

    pub const fn is_available(&self) -> bool {
        matches!(self, Self::Available)
    }
}

impl From<KernelError> for KernelOutcome {
    fn from(error: KernelError) -> Self {
        match error {
            KernelError::Held
            | KernelError::Busy
            | KernelError::Deadline
            | KernelError::ConsumerPending => Self::unavailable(UnavailableReason::StoreBusy),
            KernelError::EngineUnsupported
            | KernelError::Foreign
            | KernelError::Inconclusive
            | KernelError::IdentityMismatch
            | KernelError::CorruptCanonicalRow => {
                Self::unavailable(UnavailableReason::StoreUnsupported)
            }
            KernelError::FenceLost | KernelError::Io | KernelError::Fault => {
                Self::unavailable(UnavailableReason::StoreUnavailable)
            }
            KernelError::FutureSnapshot => Self::unavailable(UnavailableReason::SnapshotDiverged),
            KernelError::NoRequiredConsumers => {
                Self::unavailable(UnavailableReason::NoRequiredConsumer)
            }
            KernelError::Conflict => Self::conflict(ConflictReason::KnownAsOfAdvanced),
            KernelError::InvalidInput => Self::invalid(InvalidReason::InvalidInput),
            KernelError::AdmissionPolicy => Self::invalid(InvalidReason::AdmissionPolicy),
            KernelError::NotFound => Self::invalid(InvalidReason::NotFound),
            // Only the backup, restore, and checkpoint APIs raise these, and no
            // `kernel.*` route calls those APIs.
            KernelError::InvalidCheckpoint
            | KernelError::UnsafeDestination
            | KernelError::InvalidBackup
            | KernelError::InvalidRestore => Self::invalid(InvalidReason::Internal),
        }
    }
}

impl From<ArtifactErrorKind> for KernelOutcome {
    fn from(kind: ArtifactErrorKind) -> Self {
        match kind {
            ArtifactErrorKind::Capacity | ArtifactErrorKind::ReclaimInProgress => {
                Self::unavailable(UnavailableReason::StoreBusy)
            }
            ArtifactErrorKind::StorageExhausted
            | ArtifactErrorKind::CorruptObject
            | ArtifactErrorKind::MissingObject
            | ArtifactErrorKind::ReferenceCommit
            | ArtifactErrorKind::AlignmentRebuild
            | ArtifactErrorKind::PurgeIntent
            | ArtifactErrorKind::PurgeUnlinkPending => {
                Self::unavailable(UnavailableReason::StoreUnavailable)
            }
            ArtifactErrorKind::PayloadTooLarge => Self::invalid(InvalidReason::PayloadTooLarge),
            ArtifactErrorKind::InvalidInput
            | ArtifactErrorKind::TextFieldTooLong
            | ArtifactErrorKind::DetectionLimit => Self::invalid(InvalidReason::InvalidInput),
            ArtifactErrorKind::IngestionFailClosed => {
                Self::invalid(InvalidReason::IngestionFailClosed)
            }
            ArtifactErrorKind::ReAdmissionBlocked
            | ArtifactErrorKind::ReferenceUnavailable
            | ArtifactErrorKind::UnredactableSecret
            | ArtifactErrorKind::ScanIncomplete => Self::invalid(InvalidReason::ArtifactUnusable),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KERNEL_ERRORS: &[KernelError] = &[
        KernelError::Held,
        KernelError::EngineUnsupported,
        KernelError::Foreign,
        KernelError::Inconclusive,
        KernelError::Io,
        KernelError::Busy,
        KernelError::IdentityMismatch,
        KernelError::FenceLost,
        KernelError::Conflict,
        KernelError::CorruptCanonicalRow,
        KernelError::InvalidInput,
        KernelError::AdmissionPolicy,
        KernelError::FutureSnapshot,
        KernelError::NotFound,
        KernelError::InvalidCheckpoint,
        KernelError::NoRequiredConsumers,
        KernelError::ConsumerPending,
        KernelError::Fault,
        KernelError::Deadline,
        KernelError::UnsafeDestination,
        KernelError::InvalidBackup,
        KernelError::InvalidRestore,
    ];

    const ARTIFACT_ERRORS: &[ArtifactErrorKind] = &[
        ArtifactErrorKind::PayloadTooLarge,
        ArtifactErrorKind::Capacity,
        ArtifactErrorKind::StorageExhausted,
        ArtifactErrorKind::IngestionFailClosed,
        ArtifactErrorKind::ReAdmissionBlocked,
        ArtifactErrorKind::MissingObject,
        ArtifactErrorKind::CorruptObject,
        ArtifactErrorKind::ReferenceUnavailable,
        ArtifactErrorKind::ReferenceCommit,
        ArtifactErrorKind::AlignmentRebuild,
        ArtifactErrorKind::ReclaimInProgress,
        ArtifactErrorKind::UnredactableSecret,
        ArtifactErrorKind::ScanIncomplete,
        ArtifactErrorKind::DetectionLimit,
        ArtifactErrorKind::TextFieldTooLong,
        ArtifactErrorKind::InvalidInput,
        ArtifactErrorKind::PurgeIntent,
        ArtifactErrorKind::PurgeUnlinkPending,
    ];

    #[test]
    fn every_kernel_error_serializes_to_a_tagged_non_available_state() {
        for error in KERNEL_ERRORS {
            let outcome = KernelOutcome::from(*error);
            assert!(!outcome.is_available(), "{error:?}");
            let value = serde_json::to_value(&outcome).unwrap();
            assert!(value["kind"].is_string(), "{error:?}: {value}");
            assert!(value["reason"].is_string(), "{error:?}: {value}");
        }
    }

    #[test]
    fn every_artifact_error_serializes_to_a_tagged_non_available_state() {
        for kind in ARTIFACT_ERRORS {
            let outcome = KernelOutcome::from(*kind);
            assert!(!outcome.is_available(), "{kind:?}");
            let value = serde_json::to_value(&outcome).unwrap();
            assert!(value["kind"].is_string(), "{kind:?}: {value}");
            assert!(value["reason"].is_string(), "{kind:?}: {value}");
        }
    }

    #[test]
    fn wire_shape_uses_snake_case_tags() {
        assert_eq!(
            serde_json::to_value(KernelOutcome::from(KernelError::Deadline)).unwrap(),
            serde_json::json!({"kind": "unavailable", "reason": "store_busy"})
        );
        assert_eq!(
            serde_json::to_value(KernelOutcome::from(KernelError::FutureSnapshot)).unwrap(),
            serde_json::json!({"kind": "unavailable", "reason": "snapshot_diverged"})
        );
        assert_eq!(
            serde_json::to_value(KernelOutcome::from(ArtifactErrorKind::PayloadTooLarge)).unwrap(),
            serde_json::json!({"kind": "invalid", "reason": "payload_too_large"})
        );
        assert_eq!(
            serde_json::to_value(KernelOutcome::Stale {
                lag_positions: 10_000,
                oldest_unconsumed_age_ms: 5
            })
            .unwrap(),
            serde_json::json!({"kind": "stale", "lag_positions": 10_000, "oldest_unconsumed_age_ms": 5})
        );
        assert_eq!(
            serde_json::to_value(KernelOutcome::Available).unwrap(),
            serde_json::json!({"kind": "available"})
        );
    }
}
