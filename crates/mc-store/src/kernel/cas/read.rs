use std::fs;
use std::io::Read;

use rusqlite::{OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

use super::{
    is_artifact_digest, ArtifactDestination, ArtifactEligibility, ArtifactError, ArtifactErrorKind,
    ArtifactHandle, EligibilityDeniedReason, ProviderEgress, MAX_PAYLOAD_BYTES,
};
use crate::kernel::{KernelStore, Sensitivity};

impl KernelStore {
    pub fn read_artifact(&self, handle: &ArtifactHandle) -> Result<Vec<u8>, ArtifactError> {
        if !is_artifact_digest(&handle.digest) {
            return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
        }
        let mut reader = self
            .lock_reader()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?;
        let snapshot = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?;
        let live = snapshot
            .query_row(
                "SELECT 1 FROM evidence_meta
                 WHERE evidence_id=?1 AND artifact_digest=?2 AND invalidated_commit_seq IS NULL",
                [&handle.evidence_id, &handle.digest],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?
            .is_some();
        if !live {
            return Err(ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable));
        }
        let tombstoned = snapshot
            .query_row(
                "SELECT 1 FROM artifact_purge_tombstones WHERE artifact_digest=?1",
                [&handle.digest],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?
            .is_some();
        drop(snapshot);
        drop(reader);
        if tombstoned {
            return Err(ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable));
        }
        let path = self.artifact_object_path(&handle.digest);
        let metadata = fs::symlink_metadata(&path).map_err(|_| {
            ArtifactError::for_digest(ArtifactErrorKind::MissingObject, &handle.digest)
        })?;
        if !metadata.file_type().is_file() {
            return Err(ArtifactError::for_digest(
                ArtifactErrorKind::CorruptObject,
                &handle.digest,
            ));
        }
        let object = fs::File::open(&path).map_err(|_| {
            ArtifactError::for_digest(ArtifactErrorKind::MissingObject, &handle.digest)
        })?;
        let mut bytes = Vec::new();
        object
            .take(
                u64::try_from(MAX_PAYLOAD_BYTES)
                    .unwrap_or(u64::MAX)
                    .saturating_add(1),
            )
            .read_to_end(&mut bytes)
            .map_err(|_| {
                ArtifactError::for_digest(ArtifactErrorKind::MissingObject, &handle.digest)
            })?;
        if bytes.len() > MAX_PAYLOAD_BYTES {
            return Err(ArtifactError::for_digest(
                ArtifactErrorKind::CorruptObject,
                &handle.digest,
            ));
        }
        if format!("{:x}", Sha256::digest(&bytes)) != handle.digest {
            return Err(ArtifactError::for_digest(
                ArtifactErrorKind::CorruptObject,
                &handle.digest,
            ));
        }
        Ok(bytes)
    }

    pub fn artifact_eligibility(
        &self,
        handle: &ArtifactHandle,
        destination: ArtifactDestination,
    ) -> Result<ArtifactEligibility, ArtifactError> {
        if !is_artifact_digest(&handle.digest) {
            return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
        }
        let mut reader = self
            .lock_reader()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?;
        let snapshot = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?;
        let tombstoned = snapshot
            .query_row(
                "SELECT 1 FROM artifact_purge_tombstones WHERE artifact_digest=?1",
                [&handle.digest],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?
            .is_some();
        if tombstoned {
            return Ok(ArtifactEligibility::Denied(
                EligibilityDeniedReason::Tombstoned,
            ));
        }
        let mut statement = snapshot
            .prepare(
                "SELECT sensitivity_class,provider_egress_class FROM evidence_meta
                 WHERE artifact_digest=?1 AND invalidated_commit_seq IS NULL",
            )
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?;
        let rows = statement
            .query_map([&handle.digest], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?;
        let mut classification: Option<(Sensitivity, ProviderEgress)> = None;
        for row in rows {
            let (sensitivity, egress) =
                row.map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?;
            let sensitivity = Sensitivity::from_stored(&sensitivity);
            let egress = ProviderEgress::from_stored(&egress);
            classification = Some(match classification {
                Some((current_sensitivity, current_egress)) => (
                    current_sensitivity.restrictive(sensitivity),
                    current_egress.restrictive(egress),
                ),
                None => (sensitivity, egress),
            });
        }
        drop(statement);
        drop(snapshot);
        drop(reader);

        let Some((sensitivity, egress)) = classification else {
            return Ok(match destination {
                ArtifactDestination::Local => ArtifactEligibility::Allowed,
                ArtifactDestination::Remote => {
                    ArtifactEligibility::Denied(EligibilityDeniedReason::UnknownSensitive)
                }
            });
        };
        if sensitivity == Sensitivity::Secret {
            return Ok(ArtifactEligibility::Denied(EligibilityDeniedReason::Secret));
        }
        if destination == ArtifactDestination::Remote {
            if sensitivity != Sensitivity::Normal {
                return Ok(ArtifactEligibility::Denied(
                    EligibilityDeniedReason::SensitiveRemote,
                ));
            }
            if egress == ProviderEgress::LocalOnly {
                return Ok(ArtifactEligibility::Denied(
                    EligibilityDeniedReason::ProviderRestricted,
                ));
            }
        }
        Ok(ArtifactEligibility::Allowed)
    }
}
