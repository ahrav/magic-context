use rusqlite::{OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

use super::{
    is_artifact_digest, read_capped, ArtifactDestination, ArtifactEgressFacts, ArtifactEligibility,
    ArtifactError, ArtifactErrorKind, ArtifactHandle, EligibilityDeniedReason, ProviderEgress,
};
use crate::durable_fs::{open_regular_nofollow, open_secure_directory};
use crate::{KernelStore, Sensitivity};

impl KernelStore {
    /// Reads and verifies an artifact referenced by live evidence.
    ///
    /// The metadata snapshot must contain the exact evidence and digest pair, and no purge tombstone may exist. Object reads reject links and non-regular files, enforce the object size cap, and verify the SHA-256 digest before returning bytes.
    ///
    /// Returns `InvalidInput` for malformed digests, `ReferenceUnavailable` for stale or tombstoned references, `MissingObject` for inaccessible storage, and `CorruptObject` for oversized or digest-mismatched content.
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
        let missing =
            || ArtifactError::for_digest(ArtifactErrorKind::MissingObject, &handle.digest);
        let objects = self.open_objects_directory().map_err(|_| missing())?;
        let shard = open_secure_directory(&objects, &handle.digest[..2]).map_err(|_| missing())?;
        let object = open_regular_nofollow(&shard, &handle.digest[2..]).map_err(|_| missing())?;
        let Some(bytes) = read_capped(object).map_err(|_| missing())? else {
            return Err(ArtifactError::for_digest(
                ArtifactErrorKind::CorruptObject,
                &handle.digest,
            ));
        };
        if format!("{:x}", Sha256::digest(&bytes)) != handle.digest {
            return Err(ArtifactError::for_digest(
                ArtifactErrorKind::CorruptObject,
                &handle.digest,
            ));
        }
        Ok(bytes)
    }

    /// Computes the most restrictive live classification for an artifact destination.
    ///
    /// Tombstones deny every destination. Missing live metadata permits local use but denies remote use as unknown-sensitive. Any secret classification denies use; remote use additionally requires normal sensitivity and provider egress permission.
    ///
    /// Returns `InvalidInput` for malformed digests and `ReferenceUnavailable` when metadata cannot be read.
    pub fn artifact_eligibility(
        &self,
        handle: &ArtifactHandle,
        destination: ArtifactDestination,
    ) -> Result<ArtifactEligibility, ArtifactError> {
        self.artifact_egress_facts(handle, destination)
            .map(|facts| facts.eligibility)
    }

    /// The egress verdict together with the class it was derived from, read
    /// in one snapshot so a caller comparing its own assertion against the
    /// stored class judges the same rows the verdict did.
    pub fn artifact_egress_facts(
        &self,
        handle: &ArtifactHandle,
        destination: ArtifactDestination,
    ) -> Result<ArtifactEgressFacts, ArtifactError> {
        if !is_artifact_digest(&handle.digest) {
            return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
        }
        let mut reader = self
            .lock_reader()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?;
        let snapshot = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?;
        let facts = egress_facts_tx(&snapshot, &handle.digest, destination)
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?;
        drop(snapshot);
        drop(reader);
        Ok(facts)
    }
}

/// The egress facts for `digest` as `tx` sees them. The caller has already
/// checked the digest's shape.
pub(crate) fn egress_facts_tx(
    tx: &rusqlite::Transaction<'_>,
    digest: &str,
    destination: ArtifactDestination,
) -> rusqlite::Result<ArtifactEgressFacts> {
    let tombstoned = tx
        .query_row(
            "SELECT 1 FROM artifact_purge_tombstones WHERE artifact_digest=?1",
            [digest],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if tombstoned {
        return Ok(ArtifactEgressFacts {
            eligibility: ArtifactEligibility::Denied(EligibilityDeniedReason::Tombstoned),
            stored_class: None,
        });
    }
    let mut statement = tx.prepare(
        "SELECT sensitivity_class,provider_egress_class FROM evidence_meta
         WHERE artifact_digest=?1 AND invalidated_commit_seq IS NULL",
    )?;
    let rows = statement.query_map([digest], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut stored_class: Option<(Sensitivity, ProviderEgress)> = None;
    for row in rows {
        let (sensitivity, egress) = row?;
        let sensitivity = Sensitivity::from_stored(&sensitivity);
        let egress = ProviderEgress::from_stored(&egress);
        stored_class = Some(match stored_class {
            Some((current_sensitivity, current_egress)) => (
                current_sensitivity.restrictive(sensitivity),
                current_egress.restrictive(egress),
            ),
            None => (sensitivity, egress),
        });
    }
    Ok(ArtifactEgressFacts {
        eligibility: eligibility_for(stored_class, destination),
        stored_class,
    })
}

fn eligibility_for(
    stored_class: Option<(Sensitivity, ProviderEgress)>,
    destination: ArtifactDestination,
) -> ArtifactEligibility {
    let Some((sensitivity, egress)) = stored_class else {
        return match destination {
            ArtifactDestination::Local => ArtifactEligibility::Allowed,
            ArtifactDestination::Remote => {
                ArtifactEligibility::Denied(EligibilityDeniedReason::UnknownSensitive)
            }
        };
    };
    if sensitivity == Sensitivity::Secret {
        return ArtifactEligibility::Denied(EligibilityDeniedReason::Secret);
    }
    if destination == ArtifactDestination::Remote {
        if sensitivity != Sensitivity::Normal {
            return ArtifactEligibility::Denied(EligibilityDeniedReason::SensitiveRemote);
        }
        if egress == ProviderEgress::LocalOnly {
            return ArtifactEligibility::Denied(EligibilityDeniedReason::ProviderRestricted);
        }
    }
    ArtifactEligibility::Allowed
}
