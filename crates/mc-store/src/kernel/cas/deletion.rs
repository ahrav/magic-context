use rusqlite::{params, OptionalExtension, TransactionBehavior};
use rustix::fs::{self as rfs, AtFlags};
use serde::Serialize;

use super::MAX_TEXT_FIELD_BYTES;
use super::{is_artifact_digest, ArtifactError, ArtifactErrorKind};
use crate::kernel::durable_fs::{
    append_and_sync, classify_errno, classify_io, durable_unlink, open_secure_directory,
    StorageError,
};
use crate::kernel::envelope::{
    check_fence, commit_with_writer, CommitIntent, ObjectRow, PendingChange, Sensitivity,
};
use crate::kernel::redaction::{identity, redact, RedactedField};
use crate::kernel::{KernelError, KernelStore};

const PROPAGATION_TARGETS: [&str; 4] = [
    "derived_support",
    "retrieval_documents",
    "embeddings",
    "admission_state",
];
const MAX_AUDIT_FIELD_BYTES: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactDeletionKind {
    Delete,
    Purge,
}

impl ArtifactDeletionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Delete => "delete",
            Self::Purge => "purge",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactDeletionIdentity {
    Digest(String),
    EvidenceId(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactDeletionRequest {
    pub intent: CommitIntent,
    pub identity: ArtifactDeletionIdentity,
    pub kind: ArtifactDeletionKind,
    pub operator_id: Option<String>,
    pub target_locator: Option<String>,
    pub reason: Option<String>,
    pub deleted_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactDeletionResult {
    pub kind: ArtifactDeletionKind,
    pub digest: String,
    pub affected_object_ids: Vec<String>,
    pub commit_seq: i64,
    pub barrier_id: String,
    pub already_applied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarrierConsumerStatus {
    pub consumer_id: String,
    pub required_checkpoint_commit_seq: i64,
    pub checkpoint_commit_seq: Option<i64>,
    pub abandoned_by: Option<String>,
    pub abandoned_at: Option<i64>,
    pub satisfied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletionBarrierStatus {
    pub barrier_id: String,
    pub digest: String,
    pub deletion_commit_seq: i64,
    pub completed_at: Option<i64>,
    pub consumers: Vec<BarrierConsumerStatus>,
    pub cleared: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactDeletionFault {
    IntentAppend,
    IntentStorageExhausted,
    AfterCommit,
    Unlink,
    UnlinkStorageExhausted,
}

#[derive(Serialize)]
struct PurgeIntentLine<'a> {
    digest: &'a str,
    target_locator: &'a str,
    operator_id: &'a str,
    timestamp: i64,
}

/// The committed outcome of one deletion, replayed verbatim when its receipt is
/// reused so a later re-ingestion is never reported as invalidated.
#[derive(Serialize, serde::Deserialize)]
struct DeletionReceiptPayload {
    barrier_id: String,
    kind: ArtifactDeletionKind,
    affected_object_ids: Vec<String>,
}

/// Operator-supplied purge audit text after secret redaction.
struct PurgeAuditFields {
    operator_id: RedactedField,
    target_locator: RedactedField,
    reason: RedactedField,
}

impl PurgeAuditFields {
    fn new(request: &ArtifactDeletionRequest) -> Self {
        Self {
            operator_id: redact(request.operator_id.as_deref().unwrap_or_default()),
            target_locator: redact(request.target_locator.as_deref().unwrap_or_default()),
            reason: redact(request.reason.as_deref().unwrap_or_default()),
        }
    }
}

#[derive(Clone)]
struct ArtifactState {
    digest: String,
    artifact_reference: String,
    sensitivity: Sensitivity,
    live_object_ids: Vec<String>,
    all_object_ids: Vec<String>,
    prior_commit_seq: Option<i64>,
    barrier_id: String,
    prior_barrier_id: Option<String>,
    tombstoned: bool,
    pending_unlink: bool,
}

struct Propagation<'a> {
    kind: ArtifactDeletionKind,
    digest: &'a str,
    affected_object_ids: &'a [String],
    barrier_id: &'a str,
    sensitivity: Sensitivity,
    operator_id: &'a str,
    target_locator: &'a str,
    deleted_at: i64,
    redactions: &'a [(String, RedactedField)],
}

impl KernelStore {
    pub fn delete_artifact(
        &self,
        request: ArtifactDeletionRequest,
    ) -> Result<ArtifactDeletionResult, ArtifactError> {
        self.delete_artifact_inner(request, None)
    }

    #[cfg(feature = "test-support")]
    pub fn delete_artifact_with_fault_for_test(
        &self,
        request: ArtifactDeletionRequest,
        fault: ArtifactDeletionFault,
    ) -> Result<ArtifactDeletionResult, ArtifactError> {
        self.delete_artifact_inner(request, Some(fault))
    }

    fn delete_artifact_inner(
        &self,
        request: ArtifactDeletionRequest,
        fault: Option<ArtifactDeletionFault>,
    ) -> Result<ArtifactDeletionResult, ArtifactError> {
        validate_request(&request)?;
        let redacted = PurgeAuditFields::new(&request);
        let mut writer = self
            .lock_writer()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
        let state = load_artifact_state(&writer, &request.identity)?;

        if request.kind == ArtifactDeletionKind::Purge && state.tombstoned {
            if state.pending_unlink {
                self.complete_pending_purge_locked(&mut writer, &state.digest)?;
            }
            return Ok(result_from_state(&state, request.kind, true));
        }
        if request.kind == ArtifactDeletionKind::Delete && state.live_object_ids.is_empty() {
            if state.prior_commit_seq.is_none() {
                return Err(ArtifactError::for_digest(
                    ArtifactErrorKind::ReferenceUnavailable,
                    &state.digest,
                ));
            }
            return Ok(result_from_state(&state, request.kind, true));
        }

        if request.kind == ArtifactDeletionKind::Purge {
            if matches!(
                fault,
                Some(
                    ArtifactDeletionFault::IntentAppend
                        | ArtifactDeletionFault::IntentStorageExhausted
                )
            ) {
                let error = if fault == Some(ArtifactDeletionFault::IntentStorageExhausted) {
                    injected_storage_error(rustix::io::Errno::NOSPC)
                } else {
                    injected_storage_error(rustix::io::Errno::IO)
                };
                return Err(self.map_cas_storage_error(error, ArtifactErrorKind::PurgeIntent));
            }
            let mut line = serde_json::to_vec(&PurgeIntentLine {
                digest: &state.digest,
                target_locator: &redacted.target_locator.text,
                operator_id: &redacted.operator_id.text,
                timestamp: request.deleted_at,
            })
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::InvalidInput))?;
            line.push(b'\n');
            receipt_conflict_free(&writer, &request.intent, &state.barrier_id, request.kind)?;
            let mut log = self
                .purge_intent_log
                .lock()
                .map_err(|_| ArtifactError::new(ArtifactErrorKind::PurgeIntent))?;
            append_and_sync(&mut log, &line).map_err(|error| {
                self.map_cas_storage_error(error, ArtifactErrorKind::PurgeIntent)
            })?;
        }

        let barrier_id = state.barrier_id.clone();
        let digest = state.digest.clone();
        let object_ids = state.live_object_ids.clone();
        let event_object_ids = state.all_object_ids.clone();
        let artifact_reference = state.artifact_reference.clone();
        let sensitivity = state.sensitivity;
        let kind = request.kind;
        let deleted_at = request.deleted_at;
        let operator_id = redacted.operator_id.text.clone();
        let reason = redacted.reason.text.clone();
        let target_locator = redacted.target_locator.text.clone();
        let propagation_redactions = if kind == ArtifactDeletionKind::Purge {
            [
                ("operator_id", &redacted.operator_id),
                ("target_locator", &redacted.target_locator),
                ("reason", &redacted.reason),
            ]
            .into_iter()
            .filter(|(_, field)| !field.detections.is_empty())
            .map(|(name, field)| (name.to_string(), field.clone()))
            .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let receipt = commit_with_writer(
            &mut writer,
            self.lease_epoch(),
            request.intent,
            |envelope| {
                for object_id in &object_ids {
                    envelope
                        .tx
                        .execute(
                            "UPDATE evidence_meta SET invalidated_commit_seq=?1
                             WHERE object_id=?2 AND invalidated_commit_seq IS NULL",
                            params![envelope.commit_seq, object_id],
                        )
                        .map_err(|_| KernelError::Io)?;
                    envelope
                        .tx
                        .execute(
                            "UPDATE object_registry SET invalidated_commit_seq=?1
                             WHERE object_id=?2 AND invalidated_commit_seq IS NULL",
                            params![envelope.commit_seq, object_id],
                        )
                        .map_err(|_| KernelError::Io)?;
                }
                upsert_barrier(
                    envelope,
                    &barrier_id,
                    &digest,
                    &artifact_reference,
                    deleted_at,
                )?;
                if kind == ArtifactDeletionKind::Purge {
                    // A reservation whose lease has expired can outlive the ingest that
                    // created it, and an unexpired one still blocks the tombstone.
                    envelope
                        .tx
                        .execute(
                            "DELETE FROM artifact_ingestion_reservations
                             WHERE state='Live' AND lease_expires_at<=?1
                               AND (artifact_digest=?2 OR artifact_reference=?3)",
                            params![deleted_at, digest, artifact_reference],
                        )
                        .map_err(|_| KernelError::Io)?;
                    envelope
                        .tx
                        .execute(
                            "INSERT INTO artifact_purge_tombstones(
                                 artifact_digest,artifact_reference,operator_id,reason,purged_at,commit_seq
                             ) VALUES (?1,?2,?3,?4,?5,?6)",
                            params![
                                digest,
                                artifact_reference,
                                operator_id,
                                reason,
                                deleted_at,
                                envelope.commit_seq,
                            ],
                        )
                        .map_err(|_| KernelError::Io)?;
                    envelope
                        .tx
                        .execute(
                            "INSERT INTO artifact_pending_unlinks(
                                 artifact_digest,artifact_reference,created_at
                             ) VALUES (?1,?2,?3)",
                            params![digest, artifact_reference, deleted_at],
                        )
                        .map_err(|_| KernelError::Io)?;
                    envelope
                        .tx
                        .execute(
                            "UPDATE capture_pins
                             SET purge_degraded_at=?1,purge_barrier_id=?2
                             WHERE released_at IS NULL AND capture_pin_id IN (
                                 SELECT r.capture_pin_id FROM capture_pin_refs r
                                 JOIN evidence_meta e USING(evidence_id)
                                 WHERE e.artifact_digest=?3 AND r.released_at IS NULL
                             )",
                            params![deleted_at, barrier_id, digest],
                        )
                        .map_err(|_| KernelError::Io)?;
                }
                push_propagation_events(envelope, &Propagation {
                    kind,
                    digest: &digest,
                    affected_object_ids: &event_object_ids,
                    barrier_id: &barrier_id,
                    sensitivity,
                    operator_id: &operator_id,
                    target_locator: &target_locator,
                    deleted_at,
                    redactions: &propagation_redactions,
                });
                serde_json::to_string(&DeletionReceiptPayload {
                    barrier_id: barrier_id.clone(),
                    kind,
                    affected_object_ids: event_object_ids.clone(),
                })
                .map_err(|_| KernelError::Io)
            },
            || Ok(()),
        )
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;

        let committed = serde_json::from_str::<DeletionReceiptPayload>(&receipt.result)
            .ok()
            .filter(|payload| payload.barrier_id == state.barrier_id && payload.kind == kind)
            .ok_or_else(|| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
        let result = ArtifactDeletionResult {
            kind,
            digest: state.digest.clone(),
            affected_object_ids: committed.affected_object_ids,
            commit_seq: receipt.commit_seq,
            barrier_id: committed.barrier_id,
            already_applied: receipt.replayed,
        };
        if kind == ArtifactDeletionKind::Purge {
            if fault == Some(ArtifactDeletionFault::AfterCommit) {
                return Err(ArtifactError::for_digest(
                    ArtifactErrorKind::PurgeUnlinkPending,
                    &state.digest,
                ));
            }
            if matches!(
                fault,
                Some(ArtifactDeletionFault::Unlink | ArtifactDeletionFault::UnlinkStorageExhausted)
            ) {
                let error = if fault == Some(ArtifactDeletionFault::UnlinkStorageExhausted) {
                    injected_storage_error(rustix::io::Errno::NOSPC)
                } else {
                    injected_storage_error(rustix::io::Errno::IO)
                };
                return Err(
                    self.map_cas_storage_error(error, ArtifactErrorKind::PurgeUnlinkPending)
                );
            }
            self.complete_pending_purge_locked(&mut writer, &state.digest)?;
        }
        Ok(result)
    }

    fn complete_pending_purge_locked(
        &self,
        writer: &mut rusqlite::Connection,
        digest: &str,
    ) -> Result<(), ArtifactError> {
        // Unlinking is irreversible, so the fence is verified first.
        let fence = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::PurgeUnlinkPending))?;
        check_fence(&fence, self.lease_epoch())
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::PurgeUnlinkPending))?;
        fence
            .commit()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::PurgeUnlinkPending))?;
        self.unlink_purged_artifact(digest)?;
        self.unlink_digest_temps(digest)?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::PurgeUnlinkPending))?;
        check_fence(&tx, self.lease_epoch())
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::PurgeUnlinkPending))?;
        tx.execute(
            "DELETE FROM artifact_pending_unlinks WHERE artifact_digest=?1",
            [digest],
        )
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::PurgeUnlinkPending))?;
        tx.commit()
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::PurgeUnlinkPending))
    }

    fn unlink_purged_artifact(&self, digest: &str) -> Result<(), ArtifactError> {
        let objects = self.open_objects_directory().map_err(|error| {
            self.map_cas_storage_error(error, ArtifactErrorKind::PurgeUnlinkPending)
        })?;
        let shard = match open_secure_directory(&objects, &digest[..2]) {
            Ok(shard) => shard,
            Err(StorageError::Other(source)) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok(())
            }
            Err(error) => {
                return Err(self.map_cas_storage_error(error, ArtifactErrorKind::PurgeUnlinkPending))
            }
        };
        durable_unlink(&shard, &digest[2..]).map_err(|error| {
            self.map_cas_storage_error(error, ArtifactErrorKind::PurgeUnlinkPending)
        })
    }

    fn unlink_digest_temps(&self, digest: &str) -> Result<(), ArtifactError> {
        self.sweep_digest_temps(digest).map_err(|error| {
            self.map_cas_storage_error(error, ArtifactErrorKind::PurgeUnlinkPending)
        })
    }

    pub(super) fn sweep_digest_temps(&self, digest: &str) -> Result<(), StorageError> {
        let tmp = self.open_artifacts_subdirectory("tmp")?;
        let prefix = format!(".artifact-{digest}-");
        for entry in rfs::Dir::read_from(&tmp).map_err(classify_errno)? {
            let entry = entry.map_err(classify_errno)?;
            let Some(name) = entry.file_name().to_str().ok().map(str::to_owned) else {
                continue;
            };
            if !name.starts_with(&prefix) {
                continue;
            }
            let stat = match rfs::statat(&tmp, name.as_str(), AtFlags::SYMLINK_NOFOLLOW) {
                Ok(stat) => stat,
                Err(rustix::io::Errno::NOENT) => continue,
                Err(error) => return Err(classify_errno(error)),
            };
            let kind = rfs::FileType::from_raw_mode(stat.st_mode);
            if kind.is_file() || kind.is_symlink() {
                durable_unlink(&tmp, &name)?;
            }
        }
        Ok(())
    }

    pub fn deletion_barrier(&self, barrier_id: &str) -> Result<DeletionBarrierStatus, KernelError> {
        if barrier_id.trim().is_empty() {
            return Err(KernelError::InvalidInput);
        }
        let mut reader = self.lock_reader()?;
        let tx = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| KernelError::Io)?;
        let (digest, deletion_commit_seq, completed_at) = tx
            .query_row(
                "SELECT artifact_digest,delete_commit_seq,completed_at
                 FROM deletion_backfill_barriers WHERE barrier_id=?1",
                [barrier_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| KernelError::Io)?
            .ok_or(KernelError::NotFound)?;
        let mut statement = tx
            .prepare(
                "SELECT bc.consumer_id,bc.required_checkpoint_commit_seq,
                        CASE WHEN bc.acknowledged_at IS NOT NULL
                             THEN MAX(bc.required_checkpoint_commit_seq,
                                      COALESCE(c.checkpoint_commit_seq,
                                               bc.required_checkpoint_commit_seq))
                             ELSE c.checkpoint_commit_seq END,
                        (SELECT a.operator_id FROM consumer_abandonments a
                          WHERE a.consumer_id=bc.consumer_id AND a.barrier_id=bc.barrier_id
                            AND a.commit_seq>=bc.required_checkpoint_commit_seq
                          ORDER BY a.abandoned_at LIMIT 1),
                        (SELECT a.abandoned_at FROM consumer_abandonments a
                          WHERE a.consumer_id=bc.consumer_id AND a.barrier_id=bc.barrier_id
                            AND a.commit_seq>=bc.required_checkpoint_commit_seq
                          ORDER BY a.abandoned_at LIMIT 1)
                 FROM deletion_backfill_barrier_consumers bc
                 LEFT JOIN outbox_consumers c USING(consumer_id)
                 WHERE bc.barrier_id=?1 ORDER BY bc.consumer_id",
            )
            .map_err(|_| KernelError::Io)?;
        let consumers = statement
            .query_map([barrier_id], |row| {
                let required = row.get::<_, i64>(1)?;
                let checkpoint = row.get::<_, Option<i64>>(2)?;
                let abandoned_by = row.get::<_, Option<String>>(3)?;
                Ok(BarrierConsumerStatus {
                    consumer_id: row.get(0)?,
                    required_checkpoint_commit_seq: required,
                    checkpoint_commit_seq: checkpoint,
                    abandoned_at: row.get(4)?,
                    satisfied: checkpoint.is_some_and(|value| value >= required)
                        || abandoned_by.is_some(),
                    abandoned_by,
                })
            })
            .map_err(|_| KernelError::Io)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| KernelError::Io)?;
        drop(statement);
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(DeletionBarrierStatus {
            barrier_id: barrier_id.to_string(),
            digest,
            deletion_commit_seq,
            completed_at,
            consumers,
            cleared: completed_at.is_some(),
        })
    }
}

fn validate_request(request: &ArtifactDeletionRequest) -> Result<(), ArtifactError> {
    if request.deleted_at < 0 {
        return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
    }
    if !is_artifact_digest(&request.intent.request_digest) {
        return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
    }
    if request.intent.producer.trim().is_empty()
        || request.intent.operation_key.trim().is_empty()
        || identity(&request.intent.producer).is_err()
        || identity(&request.intent.operation_key).is_err()
    {
        return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
    }
    if request.kind == ArtifactDeletionKind::Purge {
        for field in [
            request.operator_id.as_deref(),
            request.target_locator.as_deref(),
            request.reason.as_deref(),
        ] {
            let Some(field) = field else {
                return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
            };
            if field.trim().is_empty() || field.len() > MAX_AUDIT_FIELD_BYTES {
                return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
            }
        }
    } else if request.operator_id.is_some()
        || request.target_locator.is_some()
        || request.reason.is_some()
    {
        return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
    }
    Ok(())
}

fn load_artifact_state(
    connection: &rusqlite::Connection,
    identity: &ArtifactDeletionIdentity,
) -> Result<ArtifactState, ArtifactError> {
    let digest = match identity {
        ArtifactDeletionIdentity::Digest(digest) if is_artifact_digest(digest) => digest.clone(),
        ArtifactDeletionIdentity::Digest(_) => {
            return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
        }
        ArtifactDeletionIdentity::EvidenceId(evidence_id) if !evidence_id.trim().is_empty() => {
            if evidence_id.len() > MAX_TEXT_FIELD_BYTES {
                return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
            }
            let evidence_id = redact(evidence_id).text;
            let stored: String = connection
                .query_row(
                    "SELECT artifact_digest FROM evidence_meta WHERE evidence_id=?1",
                    [&evidence_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?
                .ok_or_else(|| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?;
            if !is_artifact_digest(&stored) {
                return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
            }
            stored
        }
        ArtifactDeletionIdentity::EvidenceId(_) => {
            return Err(ArtifactError::new(ArtifactErrorKind::InvalidInput));
        }
    };
    let mut statement = connection
        .prepare(
            "SELECT object_id,artifact_reference,sensitivity_class,invalidated_commit_seq
             FROM evidence_meta WHERE artifact_digest=?1 ORDER BY object_id",
        )
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
    let rows = statement
        .query_map([&digest], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
    let sensitivity = rows.first().map_or(Sensitivity::Sensitive, |_| {
        rows.iter().fold(Sensitivity::Normal, |current, row| {
            current.restrictive(Sensitivity::from_stored(&row.2))
        })
    });
    let artifact_reference = rows.first().map_or_else(
        || format!("objects/{}/{}", &digest[..2], &digest[2..]),
        |row| row.1.clone(),
    );
    let all_object_ids = rows.iter().map(|row| row.0.clone()).collect::<Vec<_>>();
    let live_object_ids = rows
        .iter()
        .filter(|row| row.3.is_none())
        .map(|row| row.0.clone())
        .collect::<Vec<String>>();
    let open_barrier = connection
        .query_row(
            "SELECT barrier_id FROM deletion_backfill_barriers
             WHERE artifact_digest=?1 AND completed_at IS NULL",
            [&digest],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
    let prior_barrier = connection
        .query_row(
            "SELECT barrier_id,delete_commit_seq FROM deletion_backfill_barriers
             WHERE artifact_digest=?1
             ORDER BY delete_commit_seq DESC,barrier_id DESC LIMIT 1",
            [&digest],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
    let prior_commit_seq = prior_barrier.as_ref().map(|(_, commit_seq)| *commit_seq);
    let prior_barrier_id = prior_barrier
        .as_ref()
        .map(|(barrier_id, _)| barrier_id.clone());
    // `idx_deletion_barriers_open` admits one incomplete barrier per digest, and a
    // completed barrier stays as an audit record holding its primary key.
    let barrier_id = match open_barrier {
        Some(barrier_id) => barrier_id,
        None => format!(
            "artifact-deletion-{digest}-{}",
            crate::kernel::durable_fs::next_unique_id()
        ),
    };
    let (tombstoned, pending_unlink) = connection
        .query_row(
            "SELECT
                 EXISTS(SELECT 1 FROM artifact_purge_tombstones WHERE artifact_digest=?1),
                 EXISTS(SELECT 1 FROM artifact_pending_unlinks WHERE artifact_digest=?1)",
            [&digest],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
    Ok(ArtifactState {
        digest,
        artifact_reference,
        sensitivity,
        live_object_ids,
        all_object_ids,
        prior_commit_seq,
        barrier_id,
        prior_barrier_id,
        tombstoned,
        pending_unlink,
    })
}

/// Rejects a reused operation key that carries a different request digest, which
/// the commit refuses after the purge intent would already be durable.
fn receipt_conflict_free(
    connection: &rusqlite::Connection,
    intent: &CommitIntent,
    barrier_id: &str,
    kind: ArtifactDeletionKind,
) -> Result<(), ArtifactError> {
    let recorded: Option<(String, String)> = connection
        .query_row(
            "SELECT request_digest,result_payload FROM operation_receipts
             WHERE producer=?1 AND operation_key=?2",
            params![
                redact(&intent.producer).text,
                redact(&intent.operation_key).text
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
    let Some((digest, payload)) = recorded else {
        return Ok(());
    };
    if digest != intent.request_digest {
        return Err(ArtifactError::new(ArtifactErrorKind::ReferenceCommit));
    }
    // This receipt will be replayed, so it has to describe this deletion.
    serde_json::from_str::<DeletionReceiptPayload>(&payload)
        .ok()
        .filter(|stored| stored.barrier_id == barrier_id && stored.kind == kind)
        .map(|_| ())
        .ok_or_else(|| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))
}

fn injected_storage_error(errno: rustix::io::Errno) -> StorageError {
    classify_io(std::io::Error::from_raw_os_error(errno.raw_os_error()))
}

fn result_from_state(
    state: &ArtifactState,
    kind: ArtifactDeletionKind,
    already_applied: bool,
) -> ArtifactDeletionResult {
    ArtifactDeletionResult {
        kind,
        digest: state.digest.clone(),
        affected_object_ids: state.all_object_ids.clone(),
        commit_seq: state.prior_commit_seq.unwrap_or(0),
        barrier_id: state
            .prior_barrier_id
            .clone()
            .unwrap_or_else(|| state.barrier_id.clone()),
        already_applied,
    }
}

fn upsert_barrier(
    envelope: &mut crate::kernel::Envelope<'_>,
    barrier_id: &str,
    digest: &str,
    artifact_reference: &str,
    deleted_at: i64,
) -> Result<(), KernelError> {
    envelope
        .tx
        .execute(
            "INSERT INTO deletion_backfill_barriers(
                 barrier_id,artifact_digest,artifact_reference,delete_commit_seq,created_at
             ) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(artifact_digest) WHERE completed_at IS NULL DO UPDATE SET
                 delete_commit_seq=excluded.delete_commit_seq,
                 artifact_reference=excluded.artifact_reference,
                 created_at=excluded.created_at",
            params![
                barrier_id,
                digest,
                artifact_reference,
                envelope.commit_seq,
                deleted_at,
            ],
        )
        .map_err(|_| KernelError::Io)?;
    envelope
        .tx
        .execute(
            "DELETE FROM deletion_backfill_barrier_consumers WHERE barrier_id=?1",
            [barrier_id],
        )
        .map_err(|_| KernelError::Io)?;
    envelope
        .tx
        .execute(
            "INSERT INTO deletion_backfill_barrier_consumers(
                 barrier_id,consumer_id,required_checkpoint_commit_seq
             ) SELECT ?1,consumer_id,?2 FROM outbox_consumers",
            params![barrier_id, envelope.commit_seq],
        )
        .map_err(|_| KernelError::Io)?;
    Ok(())
}

fn push_propagation_events(envelope: &mut crate::kernel::Envelope<'_>, work: &Propagation<'_>) {
    for target_class in PROPAGATION_TARGETS {
        envelope.changes.push(PendingChange {
            object: ObjectRow {
                object_id: work.digest.to_string(),
                object_kind: target_class.to_string(),
                domain_id: "kernel-control".to_string(),
                source_kind: "artifact_deletion".to_string(),
                source_id: work.digest.to_string(),
                source_revision: envelope.commit_seq,
                created_commit_seq: envelope.commit_seq,
                invalidated_commit_seq: Some(envelope.commit_seq),
                superseded_by: None,
                sensitivity: work.sensitivity,
            },
            kind: "artifact_deletion",
            replaced_object_id: None,
            redactions: work.redactions.to_vec(),
            audit: Some(serde_json::json!({
                "target_class": target_class,
                "deletion_kind": work.kind.as_str(),
                "digest": work.digest,
                "affected_object_ids": work.affected_object_ids,
                "deletion_commit_seq": envelope.commit_seq,
                "barrier_id": work.barrier_id,
                "sensitivity": work.sensitivity.as_str(),
                "operator_id": work.operator_id,
                "target_locator": work.target_locator,
                "deleted_at": work.deleted_at,
            })),
        });
    }
}
