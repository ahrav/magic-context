use std::fs::{self, File};

use mc_core::redaction::Detection;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[cfg(feature = "test-support")]
use super::ArtifactIngestFault;
use super::{
    is_artifact_digest, read_capped, ArtifactError, ArtifactErrorKind, ArtifactHandle,
    ArtifactIngestRequest, ProviderEgress, MAX_PAYLOAD_BYTES, MAX_PAYLOAD_DETECTIONS,
    MAX_TEXT_FIELD_BYTES,
};
use crate::current_time_ms;
use crate::kernel::durable_fs::{
    classify_io, create_new_file, durable_unlink, open_or_create_secure_directory,
    open_regular_nofollow, publish_noreplace_between_locked, sync_directory,
    sync_publish_directories_with, temp_name, write_and_sync, PublishOutcome, StorageError,
};
use crate::kernel::envelope::{check_fence, commit_with_writer, ObjectRow, PendingChange};
use crate::kernel::redaction::{identity, record, redact, RedactedField};
use crate::kernel::{KernelError, KernelStore, Sensitivity};

const RESERVATION_MS: i64 = 60 * 60 * 1_000;

struct StagedObject<'a> {
    directory: &'a File,
    name: &'a str,
    consumed: bool,
}

impl StagedObject<'_> {
    fn consume(&mut self) {
        self.consumed = true;
    }
}

impl Drop for StagedObject<'_> {
    fn drop(&mut self) {
        if !self.consumed {
            let _ = durable_unlink(self.directory, self.name);
        }
    }
}

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
        if !is_artifact_digest(&request.intent.request_digest) {
            return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
        }
        let (repository_id, revision) =
            request.provenance.as_ref().map_or(("", ""), |provenance| {
                (
                    provenance.repository_id.as_str(),
                    provenance.revision.as_str(),
                )
            });
        if [
            request.evidence_id.as_str(),
            request.object_id.as_str(),
            request.object_kind.as_str(),
            request.domain_id.as_str(),
            request.source_kind.as_str(),
            request.source_id.as_str(),
            request.media_type.as_str(),
            request.retention_class.as_str(),
            request.intent.producer.as_str(),
            request.intent.operation_key.as_str(),
            request.intent.actor.as_str(),
            request.intent.cause.as_str(),
            repository_id,
            revision,
        ]
        .into_iter()
        .any(|field| field.len() > MAX_TEXT_FIELD_BYTES)
        {
            return Err(ArtifactError::new(ArtifactErrorKind::TextFieldTooLong));
        }
        if [
            request.evidence_id.as_str(),
            request.object_id.as_str(),
            request.object_kind.as_str(),
            request.domain_id.as_str(),
            request.source_kind.as_str(),
            request.source_id.as_str(),
            repository_id,
            revision,
        ]
        .into_iter()
        .any(|field| identity(field).is_err())
        {
            return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
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
            Err(_) => {
                if !redact(&String::from_utf8_lossy(&request.payload))
                    .detections
                    .is_empty()
                {
                    return Err(ArtifactError::new(ArtifactErrorKind::UnredactableSecret));
                }
                (
                    RedactedField {
                        text: String::new(),
                        detections: Vec::new(),
                    },
                    std::mem::take(&mut request.payload),
                    false,
                )
            }
        };
        let affirmative_provenance = request.provenance.as_ref().is_some_and(|provenance| {
            !provenance.repository_id.trim().is_empty() && !provenance.revision.trim().is_empty()
        });
        if bytes.len() > MAX_PAYLOAD_BYTES {
            return Err(ArtifactError::new(ArtifactErrorKind::PayloadTooLarge));
        }
        if payload_redaction.detections.len() > MAX_PAYLOAD_DETECTIONS {
            return Err(ArtifactError::new(ArtifactErrorKind::DetectionLimit));
        }
        // A recognized secret anywhere that is stored verbatim-after-redaction must
        // raise the class, not only one in the payload; otherwise a clean payload
        // with a leaking media type stays remotely eligible.
        let metadata_detected = [&request.media_type, &request.retention_class]
            .into_iter()
            .any(|field| !redact(field).detections.is_empty());
        let sensitivity = if !payload_redaction.detections.is_empty() || metadata_detected {
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
        self.ingest_artifact_inner(request, false, false)
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
        )
    }

    fn ingest_artifact_inner(
        &self,
        request: ArtifactIngestRequest,
        fault_after_directory_sync: bool,
        fault_after_events: bool,
    ) -> Result<ArtifactHandle, ArtifactError> {
        if self.cas_is_failed() {
            return Err(ArtifactError::new(ArtifactErrorKind::IngestionFailClosed));
        }
        let prepared = PreparedArtifact::new(request)?;
        let byte_length = u64::try_from(prepared.bytes.len())
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::InvalidInput))?;

        let store_root = self
            .artifacts_path
            .parent()
            .ok_or_else(|| self.fail_storage(ArtifactErrorKind::IngestionFailClosed))?;
        let root = File::open(store_root)
            .map_err(|_| self.fail_storage(ArtifactErrorKind::IngestionFailClosed))?;
        let artifacts = open_or_create_secure_directory(&root, "artifacts")
            .map_err(|error| self.map_storage_error(error))?;
        let tmp = open_or_create_secure_directory(&artifacts, "tmp")
            .map_err(|error| self.map_storage_error(error))?;
        let objects = open_or_create_secure_directory(&artifacts, "objects")
            .map_err(|error| self.map_storage_error(error))?;
        let temp_name = temp_name("artifact");
        let mut temp =
            create_new_file(&tmp, &temp_name).map_err(|error| self.map_storage_error(error))?;
        let mut staged = StagedObject {
            directory: &tmp,
            name: &temp_name,
            consumed: false,
        };
        if let Err(error) = write_and_sync(&mut temp, &prepared.bytes) {
            return Err(self.map_storage_error(error));
        }
        drop(temp);

        let mut writer = self
            .lock_writer()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
        self.check_budget(&prepared.digest, byte_length)?;
        let shard = open_or_create_secure_directory(&objects, &prepared.digest[..2])
            .map_err(|error| self.map_storage_error(error))?;
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
        if artifact_is_blocked(&reservation, &prepared.digest)
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?
        {
            drop(reservation);
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
            Ok(PublishOutcome::Published) => {
                staged.consume();
                true
            }
            // The destination holds the object but the temp link survived, so the
            // guard stays armed to retry its removal on scope exit.
            Ok(PublishOutcome::PublishedTempRetained) => true,
            Ok(PublishOutcome::AlreadyExists) => {
                if let Err(error) = durable_unlink(&tmp, &temp_name) {
                    let mapped = self.map_storage_error(error);
                    self.release_reservation(&mut writer, &reservation_id);
                    return Err(mapped);
                }
                staged.consume();
                false
            }
            Err(error) => {
                let mapped = self.map_storage_error(error);
                self.cleanup_failed_reference(&mut writer, &reservation_id, &prepared.digest, true);
                return Err(mapped);
            }
        };

        if let Err(error) = sync_publish_directories_with(&tmp, &shard, sync_directory) {
            let mapped = self.map_storage_error(error);
            self.cleanup_failed_reference(
                &mut writer,
                &reservation_id,
                &prepared.digest,
                published_new,
            );
            return Err(mapped);
        }
        if let Err(error) = verify_object(&shard, &prepared.digest[2..], &prepared.digest) {
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
            || {
                if fault_after_events {
                    Err(KernelError::Fault)
                } else {
                    Ok(())
                }
            },
        );
        match commit_result {
            Ok(receipt) if receipt.replayed => {
                let committed = committed_digest(&mut writer, &receipt.result);
                match committed {
                    Ok(Some(digest)) if digest == prepared.digest => {
                        if let Err(error) =
                            self.merge_replayed_classification(&mut writer, &prepared)
                        {
                            self.cleanup_failed_reference(
                                &mut writer,
                                &reservation_id,
                                &prepared.digest,
                                published_new,
                            );
                            return Err(error);
                        }
                        self.release_reservation(&mut writer, &reservation_id);
                        Ok(ArtifactHandle {
                            digest: prepared.digest,
                            evidence_id: receipt.result,
                        })
                    }
                    Ok(_) => {
                        self.cleanup_failed_reference(
                            &mut writer,
                            &reservation_id,
                            &prepared.digest,
                            published_new,
                        );
                        Err(ArtifactError::new(ArtifactErrorKind::InvalidInput))
                    }
                    Err(error) => {
                        self.cleanup_failed_reference(
                            &mut writer,
                            &reservation_id,
                            &prepared.digest,
                            published_new,
                        );
                        Err(error)
                    }
                }
            }
            Ok(_) => Ok(ArtifactHandle {
                digest: prepared.digest,
                evidence_id: redact(&prepared.request.evidence_id).text,
            }),
            Err(error) => {
                self.cleanup_failed_reference(
                    &mut writer,
                    &reservation_id,
                    &prepared.digest,
                    published_new,
                );
                Err(ArtifactError::new(match error {
                    KernelError::InvalidInput => ArtifactErrorKind::InvalidInput,
                    _ => ArtifactErrorKind::ReferenceCommit,
                }))
            }
        }
    }

    fn check_budget(&self, digest: &str, byte_length: u64) -> Result<(), ArtifactError> {
        let usage = regular_file_bytes(&self.artifacts_path.join("objects"))
            .map_err(|error| self.map_storage_error(error))?;
        let already_present = fs::symlink_metadata(self.artifact_object_path(digest))
            .is_ok_and(|metadata| metadata.file_type().is_file());
        let projected = usage.saturating_add(if already_present { 0 } else { byte_length });
        if projected > self.artifact_cap {
            return Err(ArtifactError::capacity(usage, self.artifact_cap));
        }
        Ok(())
    }

    fn map_storage_error(&self, error: StorageError) -> ArtifactError {
        match error {
            StorageError::Exhausted(_) => ArtifactError::new(ArtifactErrorKind::StorageExhausted),
            StorageError::Other(_) => self.fail_storage(ArtifactErrorKind::IngestionFailClosed),
        }
    }

    fn fail_storage(&self, kind: ArtifactErrorKind) -> ArtifactError {
        self.latch_cas_failure();
        ArtifactError::new(kind)
    }

    fn merge_replayed_classification(
        &self,
        writer: &mut Connection,
        prepared: &PreparedArtifact,
    ) -> Result<(), ArtifactError> {
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
        check_fence(&tx, self.lease_epoch())
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
        merge_stored_classification(
            &tx,
            &prepared.digest,
            prepared.sensitivity,
            prepared.request.provider_egress,
        )
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
        tx.commit()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
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
        let Ok(objects) = self.open_objects_directory() else {
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

    let (sensitivity, egress) = merge_stored_classification(
        envelope.tx,
        &prepared.digest,
        prepared.sensitivity,
        prepared.request.provider_egress,
    )?;

    // Identity columns must survive round-trip, so a detected secret is refused
    // rather than replaced: two ids differing only inside a redacted span would
    // otherwise collapse onto one placeholder-backed identity.
    let evidence_id = identity(&prepared.request.evidence_id)?;
    let object_id = identity(&prepared.request.object_id)?;
    let object_kind = identity(&prepared.request.object_kind)?;
    let domain_id = identity(&prepared.request.domain_id)?;
    let source_kind = identity(&prepared.request.source_kind)?;
    let source_id = identity(&prepared.request.source_id)?;
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
                object_id,
                object_kind,
                domain_id,
                source_kind,
                source_id,
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
                evidence_id,
                object_id,
                prepared.artifact_reference,
                prepared.digest,
                i64::try_from(prepared.bytes.len()).map_err(|_| KernelError::InvalidInput)?,
                media_type.text,
                retention_class.text,
                prepared.request.retain_until,
                first_detection.map(|_| "secret_redaction"),
                None::<&str>,
                first_detection.map(|_| prepared.redaction_metadata.as_slice()),
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
        &evidence_id,
        "payload",
        &prepared.payload_redaction,
        Some(envelope.commit_seq),
    )?;
    for (name, field) in [
        ("media_type", &media_type),
        ("retention_class", &retention_class),
    ] {
        record(
            envelope.tx,
            "evidence",
            &evidence_id,
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
            object_id: object_id.clone(),
            object_kind: object_kind.clone(),
            domain_id: domain_id.clone(),
            source_kind: source_kind.clone(),
            source_id: source_id.clone(),
            source_revision: prepared.request.source_revision,
            created_commit_seq: envelope.commit_seq,
            invalidated_commit_seq: None,
            superseded_by: None,
            sensitivity,
        },
        kind: "insert",
        replaced_object_id: None,
        redactions: Vec::new(),
        audit: None,
    });
    Ok(evidence_id)
}

fn merge_stored_classification(
    tx: &rusqlite::Transaction<'_>,
    digest: &str,
    mut sensitivity: Sensitivity,
    mut egress: ProviderEgress,
) -> Result<(Sensitivity, ProviderEgress), KernelError> {
    let mut statement = tx
        .prepare(
            "SELECT sensitivity_class,provider_egress_class FROM evidence_meta
             WHERE artifact_digest=?1",
        )
        .map_err(|_| KernelError::Io)?;
    let rows = statement
        .query_map([digest], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| KernelError::Io)?;
    for row in rows {
        let (stored_sensitivity, stored_egress) = row.map_err(|_| KernelError::Io)?;
        sensitivity = sensitivity.restrictive(Sensitivity::from_stored(&stored_sensitivity));
        egress = egress.restrictive(ProviderEgress::from_stored(&stored_egress));
    }
    drop(statement);
    tx.execute(
        "UPDATE evidence_meta SET sensitivity_class=?1,provider_egress_class=?2
         WHERE artifact_digest=?3 AND invalidated_commit_seq IS NULL",
        params![sensitivity.as_str(), egress.as_str(), digest],
    )
    .map_err(|_| KernelError::Io)?;
    Ok((sensitivity, egress))
}

fn committed_digest(
    writer: &mut Connection,
    evidence_id: &str,
) -> Result<Option<String>, ArtifactError> {
    writer
        .query_row(
            "SELECT artifact_digest FROM evidence_meta WHERE evidence_id=?1",
            [evidence_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))
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

fn verify_object(shard: &File, name: &str, digest: &str) -> Result<(), ArtifactError> {
    let object = open_regular_nofollow(shard, name)
        .map_err(|_| ArtifactError::for_digest(ArtifactErrorKind::MissingObject, digest))?;
    let Some(bytes) = read_capped(object)
        .map_err(|_| ArtifactError::for_digest(ArtifactErrorKind::MissingObject, digest))?
    else {
        return Err(ArtifactError::for_digest(
            ArtifactErrorKind::CorruptObject,
            digest,
        ));
    };
    if format!("{:x}", Sha256::digest(bytes)) != digest {
        return Err(ArtifactError::for_digest(
            ArtifactErrorKind::CorruptObject,
            digest,
        ));
    }
    Ok(())
}

fn regular_file_bytes(objects: &std::path::Path) -> Result<u64, StorageError> {
    let mut bytes = 0_u64;
    for entry in fs::read_dir(objects).map_err(classify_io)? {
        let entry = entry.map_err(classify_io)?;
        let metadata = entry.metadata().map_err(classify_io)?;
        if metadata.file_type().is_file() {
            bytes = bytes.saturating_add(metadata.len());
            continue;
        }
        if !metadata.file_type().is_dir() {
            continue;
        }
        for shard_entry in fs::read_dir(entry.path()).map_err(classify_io)? {
            let shard_entry = shard_entry.map_err(classify_io)?;
            let shard_metadata = shard_entry.metadata().map_err(classify_io)?;
            if shard_metadata.file_type().is_file() {
                bytes = bytes.saturating_add(shard_metadata.len());
            }
        }
    }
    Ok(bytes)
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
