use std::fs::{self, File};

use mc_core::redaction::Detection;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[cfg(feature = "test-support")]
use super::ArtifactIngestFault;
use super::{
    ArtifactError, ArtifactErrorKind, ArtifactHandle, ArtifactIngestRequest, ProviderEgress,
    MAX_PAYLOAD_BYTES,
};
use crate::kernel::durable_fs::{
    create_new_file, durable_unlink, open_or_create_secure_directory,
    publish_noreplace_between_locked, temp_name, write_and_sync, PublishOutcome,
};
use crate::kernel::envelope::{check_fence, commit_with_writer, ObjectRow, PendingChange};
use crate::kernel::open::current_time_ms;
use crate::kernel::redaction::{record, redact, RedactedField};
use crate::kernel::{KernelError, KernelStore, Sensitivity};

const RESERVATION_MS: i64 = 60 * 60 * 1_000;

struct PreparedArtifact {
    request: ArtifactIngestRequest,
    digest: String,
    bytes: Vec<u8>,
    payload_redaction: RedactedField,
    sensitivity: Sensitivity,
    artifact_reference: String,
    redaction_metadata: Vec<u8>,
}

impl PreparedArtifact {
    fn new(mut request: ArtifactIngestRequest) -> Result<Self, ArtifactError> {
        if request.payload.len() > MAX_PAYLOAD_BYTES {
            return Err(ArtifactError::new(ArtifactErrorKind::PayloadTooLarge));
        }
        if request.evidence_id.trim().is_empty()
            || request.object_id.trim().is_empty()
            || request.object_kind.trim().is_empty()
            || request.domain_id.trim().is_empty()
            || request.source_kind.trim().is_empty()
            || request.source_id.trim().is_empty()
            || request.media_type.trim().is_empty()
            || request.retention_class.trim().is_empty()
            || request.source_revision < 0
            || request.retain_until.is_some_and(|value| value < 0)
        {
            return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
        }

        let (payload_redaction, bytes, inspected) = match std::str::from_utf8(&request.payload) {
            Ok(text) => {
                let redaction = redact(text);
                let bytes = redaction.text.as_bytes().to_vec();
                (redaction, bytes, true)
            }
            Err(_) => (
                RedactedField {
                    text: String::new(),
                    detections: Vec::new(),
                },
                std::mem::take(&mut request.payload),
                false,
            ),
        };
        let affirmative_provenance = request.provenance.as_ref().is_some_and(|provenance| {
            !provenance.repository_id.trim().is_empty() && !provenance.revision.trim().is_empty()
        });
        let sensitivity = if !payload_redaction.detections.is_empty() {
            Sensitivity::Secret
        } else if !inspected {
            request
                .asserted_sensitivity
                .restrictive(Sensitivity::Sensitive)
        } else if request.asserted_sensitivity == Sensitivity::Normal && !affirmative_provenance {
            Sensitivity::Sensitive
        } else {
            request.asserted_sensitivity
        };
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let artifact_reference = format!("objects/{}/{}", &digest[..2], &digest[2..]);
        let redaction_metadata = detection_metadata(&payload_redaction.detections)?;
        request.payload.clear();

        Ok(Self {
            request,
            digest,
            bytes,
            payload_redaction,
            sensitivity,
            artifact_reference,
            redaction_metadata,
        })
    }
}

impl KernelStore {
    pub fn ingest_artifact(
        &self,
        request: ArtifactIngestRequest,
    ) -> Result<ArtifactHandle, ArtifactError> {
        self.ingest_artifact_inner(request, false, false, None)
    }

    #[cfg(feature = "test-support")]
    pub fn ingest_artifact_with_fault_for_test(
        &self,
        request: ArtifactIngestRequest,
        fault: ArtifactIngestFault,
    ) -> Result<ArtifactHandle, ArtifactError> {
        self.ingest_artifact_inner(
            request,
            fault == ArtifactIngestFault::AfterDirectorySync,
            fault == ArtifactIngestFault::AfterEvents,
            None,
        )
    }

    #[cfg(feature = "test-support")]
    pub fn ingest_artifact_with_temp_hook_for_test(
        &self,
        request: ArtifactIngestRequest,
        mut hook: impl FnMut(&str),
    ) -> Result<ArtifactHandle, ArtifactError> {
        self.ingest_artifact_inner(request, false, false, Some(&mut hook))
    }

    fn ingest_artifact_inner(
        &self,
        request: ArtifactIngestRequest,
        fault_after_directory_sync: bool,
        fault_after_events: bool,
        temp_written_hook: Option<&mut dyn FnMut(&str)>,
    ) -> Result<ArtifactHandle, ArtifactError> {
        if self.cas_is_failed() {
            return Err(ArtifactError::new(ArtifactErrorKind::IngestionFailClosed));
        }
        let prepared = PreparedArtifact::new(request)?;
        let byte_length = u64::try_from(prepared.bytes.len())
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::InvalidInput))?;

        self.check_budget(&prepared.digest, byte_length)?;

        let artifacts = File::open(&self.artifacts_path)
            .map_err(|_| self.fail_cas_storage(ArtifactErrorKind::IngestionFailClosed))?;
        let tmp = open_or_create_secure_directory(&artifacts, "tmp").map_err(|error| {
            self.map_cas_storage_error(error, ArtifactErrorKind::IngestionFailClosed)
        })?;
        let objects = open_or_create_secure_directory(&artifacts, "objects").map_err(|error| {
            self.map_cas_storage_error(error, ArtifactErrorKind::IngestionFailClosed)
        })?;
        let temp_name = temp_name(&format!("artifact-{}", prepared.digest));
        let mut temp = create_new_file(&tmp, &temp_name).map_err(|error| {
            self.map_cas_storage_error(error, ArtifactErrorKind::IngestionFailClosed)
        })?;
        if let Err(error) = write_and_sync(&mut temp, &prepared.bytes) {
            let mapped = self.map_cas_storage_error(error, ArtifactErrorKind::IngestionFailClosed);
            let _ = durable_unlink(&tmp, &temp_name).map_err(|cleanup| {
                self.map_cas_storage_error(cleanup, ArtifactErrorKind::IngestionFailClosed)
            });
            return Err(mapped);
        }
        drop(temp);
        if let Some(hook) = temp_written_hook {
            hook(&temp_name);
        }

        let mut writer = self
            .lock_writer()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
        if let Err(error) = self.check_budget(&prepared.digest, byte_length) {
            let _ = durable_unlink(&tmp, &temp_name).map_err(|cleanup| {
                self.map_cas_storage_error(cleanup, ArtifactErrorKind::IngestionFailClosed)
            });
            return Err(error);
        }
        let shard =
            open_or_create_secure_directory(&objects, &prepared.digest[..2]).map_err(|error| {
                self.map_cas_storage_error(error, ArtifactErrorKind::IngestionFailClosed)
            })?;
        let now = current_time_ms();
        let reservation_id = format!(
            "{}-{}",
            prepared.digest,
            crate::kernel::durable_fs::next_unique_id()
        );

        let reservation = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
        check_fence(&reservation, self.lease_epoch())
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
        if artifact_is_reclaiming(&reservation, &prepared.digest)
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?
        {
            drop(reservation);
            let _ = durable_unlink(&tmp, &temp_name).map_err(|cleanup| {
                self.map_cas_storage_error(cleanup, ArtifactErrorKind::IngestionFailClosed)
            });
            return Err(ArtifactError::for_digest(
                ArtifactErrorKind::ReclaimInProgress,
                &prepared.digest,
            ));
        }
        if artifact_is_blocked(&reservation, &prepared.digest)
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?
        {
            drop(reservation);
            let _ = durable_unlink(&tmp, &temp_name).map_err(|cleanup| {
                self.map_cas_storage_error(cleanup, ArtifactErrorKind::IngestionFailClosed)
            });
            return Err(ArtifactError::for_digest(
                ArtifactErrorKind::ReAdmissionBlocked,
                &prepared.digest,
            ));
        }
        reservation
            .execute(
                "INSERT INTO artifact_ingestion_reservations(
                     reservation_id,artifact_digest,artifact_reference,state,writer_epoch,
                     created_at,heartbeat_at,lease_expires_at
                 ) VALUES (?1,?2,?3,'Live',?4,?5,?5,?6)",
                params![
                    reservation_id,
                    prepared.digest,
                    prepared.artifact_reference,
                    i64::try_from(self.lease_epoch())
                        .map_err(|_| ArtifactError::new(ArtifactErrorKind::InvalidInput))?,
                    now,
                    now.saturating_add(RESERVATION_MS),
                ],
            )
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
        reservation
            .commit()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;

        let publish =
            publish_noreplace_between_locked(&tmp, &temp_name, &shard, &prepared.digest[2..]);
        let published_new = match publish {
            Ok(PublishOutcome::Published) => true,
            Ok(PublishOutcome::AlreadyExists) => {
                if let Err(error) = durable_unlink(&tmp, &temp_name) {
                    let mapped =
                        self.map_cas_storage_error(error, ArtifactErrorKind::IngestionFailClosed);
                    self.release_reservation(&mut writer, &reservation_id);
                    return Err(mapped);
                }
                false
            }
            Err(error) => {
                let mapped =
                    self.map_cas_storage_error(error, ArtifactErrorKind::IngestionFailClosed);
                self.release_reservation(&mut writer, &reservation_id);
                let _ = durable_unlink(&tmp, &temp_name).map_err(|cleanup| {
                    self.map_cas_storage_error(cleanup, ArtifactErrorKind::IngestionFailClosed)
                });
                return Err(mapped);
            }
        };

        if let Err(error) = verify_object(
            &self.artifact_object_path(&prepared.digest),
            &prepared.digest,
        ) {
            self.cleanup_failed_reference(
                &mut writer,
                &reservation_id,
                &prepared.digest,
                published_new,
            );
            return Err(error);
        }
        if fault_after_directory_sync {
            self.cleanup_failed_reference(
                &mut writer,
                &reservation_id,
                &prepared.digest,
                published_new,
            );
            self.latch_cas_failure();
            return Err(ArtifactError::new(ArtifactErrorKind::IngestionFailClosed));
        }
        if self.cas_is_failed() {
            self.cleanup_failed_reference(
                &mut writer,
                &reservation_id,
                &prepared.digest,
                published_new,
            );
            return Err(ArtifactError::new(ArtifactErrorKind::IngestionFailClosed));
        }

        let commit_result = commit_with_writer(
            &mut writer,
            self.lease_epoch(),
            prepared.request.intent.clone(),
            |envelope| insert_reference(envelope, &prepared, &reservation_id),
            fault_after_events,
        );
        match commit_result {
            Ok(receipt) => {
                if receipt.replayed {
                    self.release_reservation(&mut writer, &reservation_id);
                }
                Ok(ArtifactHandle {
                    digest: prepared.digest,
                    evidence_id: redact(&prepared.request.evidence_id).text,
                })
            }
            Err(_) => {
                self.cleanup_failed_reference(
                    &mut writer,
                    &reservation_id,
                    &prepared.digest,
                    published_new,
                );
                Err(ArtifactError::new(ArtifactErrorKind::ReferenceCommit))
            }
        }
    }

    fn check_budget(&self, digest: &str, byte_length: u64) -> Result<(), ArtifactError> {
        let usage = current_usage(&self.artifacts_path)?;
        let already_present = fs::symlink_metadata(self.artifact_object_path(digest))
            .is_ok_and(|metadata| metadata.file_type().is_file());
        let projected = usage.saturating_add(if already_present { 0 } else { byte_length });
        if projected > self.artifact_cap {
            return Err(ArtifactError::capacity(usage, self.artifact_cap));
        }
        Ok(())
    }

    fn release_reservation(&self, writer: &mut Connection, reservation_id: &str) {
        let Ok(tx) = writer.transaction_with_behavior(TransactionBehavior::Immediate) else {
            return;
        };
        if check_fence(&tx, self.lease_epoch()).is_err() {
            return;
        }
        if tx
            .execute(
                "DELETE FROM artifact_ingestion_reservations WHERE reservation_id=?1",
                [reservation_id],
            )
            .is_ok()
        {
            let _ = tx.commit();
        }
    }

    fn cleanup_failed_reference(
        &self,
        writer: &mut Connection,
        reservation_id: &str,
        digest: &str,
        published_new: bool,
    ) {
        let Ok(tx) = writer.transaction_with_behavior(TransactionBehavior::Immediate) else {
            return;
        };
        if check_fence(&tx, self.lease_epoch()).is_err() {
            return;
        }
        if tx
            .execute(
                "DELETE FROM artifact_ingestion_reservations WHERE reservation_id=?1",
                [reservation_id],
            )
            .is_err()
        {
            return;
        }
        if !published_new {
            let _ = tx.commit();
            return;
        }
        let protected: i64 = match tx.query_row(
            "SELECT
                 (SELECT COUNT(*) FROM evidence_meta WHERE artifact_digest=?1) +
                 (SELECT COUNT(*) FROM artifact_ingestion_reservations WHERE artifact_digest=?1)",
            [digest],
            |row| row.get(0),
        ) {
            Ok(value) => value,
            Err(_) => return,
        };
        if tx.commit().is_err() || protected != 0 {
            return;
        }
        let Ok(objects) = File::open(self.artifacts_path.join("objects")) else {
            self.latch_cas_failure();
            return;
        };
        let Ok(shard) = open_or_create_secure_directory(&objects, &digest[..2]) else {
            self.latch_cas_failure();
            return;
        };
        if durable_unlink(&shard, &digest[2..]).is_err() {
            self.latch_cas_failure();
        }
    }
}

fn insert_reference(
    envelope: &mut crate::kernel::Envelope<'_>,
    prepared: &PreparedArtifact,
    reservation_id: &str,
) -> Result<String, KernelError> {
    if artifact_is_blocked(envelope.tx, &prepared.digest)? {
        return Err(KernelError::Conflict);
    }
    let reservation_state: Option<String> = envelope
        .tx
        .query_row(
            "SELECT state FROM artifact_ingestion_reservations WHERE reservation_id=?1 AND artifact_digest=?2",
            params![reservation_id, prepared.digest],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| KernelError::Io)?;
    if reservation_state.as_deref() != Some("Live") {
        return Err(KernelError::Conflict);
    }
    let reclaiming: i64 = envelope
        .tx
        .query_row(
            "SELECT COUNT(*) FROM artifact_ingestion_reservations WHERE artifact_digest=?1 AND state='Reclaiming'",
            [&prepared.digest],
            |row| row.get(0),
        )
        .map_err(|_| KernelError::Io)?;
    if reclaiming != 0 {
        return Err(KernelError::Conflict);
    }

    let mut sensitivity = prepared.sensitivity;
    let mut egress = prepared.request.provider_egress;
    let mut statement = envelope
        .tx
        .prepare(
            "SELECT sensitivity_class,provider_egress_class FROM evidence_meta
             WHERE artifact_digest=?1 AND invalidated_commit_seq IS NULL",
        )
        .map_err(|_| KernelError::Io)?;
    let rows = statement
        .query_map([&prepared.digest], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| KernelError::Io)?;
    for row in rows {
        let (stored_sensitivity, stored_egress) = row.map_err(|_| KernelError::Io)?;
        sensitivity = sensitivity.restrictive(Sensitivity::from_stored(&stored_sensitivity));
        egress = egress.restrictive(ProviderEgress::from_stored(&stored_egress));
    }
    drop(statement);
    envelope
        .tx
        .execute(
            "UPDATE evidence_meta SET sensitivity_class=?1,provider_egress_class=?2
             WHERE artifact_digest=?3 AND invalidated_commit_seq IS NULL",
            params![sensitivity.as_str(), egress.as_str(), prepared.digest],
        )
        .map_err(|_| KernelError::Io)?;

    let evidence_id = redact(&prepared.request.evidence_id);
    let object_id = redact(&prepared.request.object_id);
    let object_kind = redact(&prepared.request.object_kind);
    let domain_id = redact(&prepared.request.domain_id);
    let source_kind = redact(&prepared.request.source_kind);
    let source_id = redact(&prepared.request.source_id);
    let media_type = redact(&prepared.request.media_type);
    let retention_class = redact(&prepared.request.retention_class);
    envelope
        .tx
        .execute(
            "INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                object_id.text,
                object_kind.text,
                domain_id.text,
                source_kind.text,
                source_id.text,
                prepared.request.source_revision,
                envelope.commit_seq,
                sensitivity.as_str(),
            ],
        )
        .map_err(|_| KernelError::Io)?;
    let first_detection = prepared.payload_redaction.detections.first();
    envelope
        .tx
        .execute(
            "INSERT INTO evidence_meta(
                 evidence_id,object_id,artifact_reference,artifact_digest,byte_length,media_type,
                 retention_class,retain_until,detector_kind,detector_version,detector_metadata,
                 detector_id,secret_type,utf8_offset,utf8_length,provider_egress_class,
                 redaction_metadata,created_commit_seq,sensitivity_class
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
            params![
                evidence_id.text,
                object_id.text,
                prepared.artifact_reference,
                prepared.digest,
                i64::try_from(prepared.bytes.len()).map_err(|_| KernelError::InvalidInput)?,
                media_type.text,
                retention_class.text,
                prepared.request.retain_until,
                first_detection.map(|_| "secret_redaction"),
                first_detection.map(|detection| detection.detector_id),
                prepared.redaction_metadata,
                first_detection.map(|detection| detection.detector_id),
                first_detection.map(|detection| detection.secret_type.as_str()),
                first_detection
                    .map(|detection| i64::try_from(detection.offset))
                    .transpose()
                    .map_err(|_| KernelError::InvalidInput)?,
                first_detection
                    .map(|detection| i64::try_from(detection.length))
                    .transpose()
                    .map_err(|_| KernelError::InvalidInput)?,
                egress.as_str(),
                prepared.redaction_metadata,
                envelope.commit_seq,
                sensitivity.as_str(),
            ],
        )
        .map_err(|_| KernelError::Io)?;
    record(
        envelope.tx,
        "evidence",
        &evidence_id.text,
        "payload",
        &prepared.payload_redaction,
        Some(envelope.commit_seq),
    )?;
    for (name, field) in [
        ("object_id", &object_id),
        ("object_kind", &object_kind),
        ("domain_id", &domain_id),
        ("source_kind", &source_kind),
        ("source_id", &source_id),
    ] {
        record(
            envelope.tx,
            "object_registry",
            &object_id.text,
            name,
            field,
            Some(envelope.commit_seq),
        )?;
    }
    if envelope
        .tx
        .execute(
            "DELETE FROM artifact_ingestion_reservations WHERE reservation_id=?1 AND state='Live'",
            [reservation_id],
        )
        .map_err(|_| KernelError::Io)?
        != 1
    {
        return Err(KernelError::Conflict);
    }
    envelope.changes.push(PendingChange {
        object: ObjectRow {
            object_id: object_id.text.clone(),
            object_kind: object_kind.text.clone(),
            domain_id: domain_id.text.clone(),
            source_kind: source_kind.text.clone(),
            source_id: source_id.text.clone(),
            source_revision: prepared.request.source_revision,
            created_commit_seq: envelope.commit_seq,
            invalidated_commit_seq: None,
            superseded_by: None,
            sensitivity,
        },
        kind: "insert",
        replaced_object_id: None,
        redactions: vec![
            ("evidence_id".to_string(), evidence_id.clone()),
            ("object_id".to_string(), object_id),
            ("source_id".to_string(), source_id),
        ],
        audit: None,
    });
    Ok(evidence_id.text)
}

fn artifact_is_blocked(
    connection: &rusqlite::Transaction<'_>,
    digest: &str,
) -> Result<bool, KernelError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifact_purge_tombstones WHERE artifact_digest=?1)
                    OR EXISTS(SELECT 1 FROM artifact_pending_unlinks WHERE artifact_digest=?1)",
            [digest],
            |row| row.get(0),
        )
        .map_err(|_| KernelError::Io)
}

fn artifact_is_reclaiming(
    connection: &rusqlite::Transaction<'_>,
    digest: &str,
) -> Result<bool, KernelError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifact_ingestion_reservations
                           WHERE artifact_digest=?1 AND state='Reclaiming')",
            [digest],
            |row| row.get(0),
        )
        .map_err(|_| KernelError::Io)
}

fn verify_object(path: &std::path::Path, digest: &str) -> Result<(), ArtifactError> {
    let bytes = fs::read(path)
        .map_err(|_| ArtifactError::for_digest(ArtifactErrorKind::MissingObject, digest))?;
    if format!("{:x}", Sha256::digest(bytes)) != digest {
        return Err(ArtifactError::for_digest(
            ArtifactErrorKind::CorruptObject,
            digest,
        ));
    }
    Ok(())
}

fn current_usage(artifacts_path: &std::path::Path) -> Result<u64, ArtifactError> {
    super::gc::object_usage(artifacts_path)
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))
}

fn detection_metadata(detections: &[Detection]) -> Result<Vec<u8>, ArtifactError> {
    #[derive(Serialize)]
    struct Metadata<'a> {
        detector_id: &'a str,
        secret_type: &'a str,
        utf8_offset: usize,
        utf8_length: usize,
    }
    serde_json::to_vec(
        &detections
            .iter()
            .map(|detection| Metadata {
                detector_id: detection.detector_id,
                secret_type: &detection.secret_type,
                utf8_offset: detection.offset,
                utf8_length: detection.length,
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|_| ArtifactError::new(ArtifactErrorKind::InvalidInput))
}
