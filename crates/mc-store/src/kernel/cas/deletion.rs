use std::fs::{self, File};

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::{is_artifact_digest, ArtifactError, ArtifactErrorKind};
use crate::kernel::durable_fs::{
    append_and_sync, classify_io, durable_unlink, open_secure_directory, StorageError,
};
use crate::kernel::envelope::{
    check_fence, commit_with_writer, CommitIntent, ObjectRow, PendingChange, Sensitivity,
};
use crate::kernel::{KernelError, KernelStore};

const PROPAGATION_TARGETS: [&str; 4] = [
    "derived_support",
    "retrieval_documents",
    "embeddings",
    "admission_state",
];
const MAX_AUDIT_FIELD_BYTES: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

#[derive(Clone)]
struct ArtifactState {
    digest: String,
    artifact_reference: String,
    sensitivity: Sensitivity,
    live_object_ids: Vec<String>,
    all_object_ids: Vec<String>,
    prior_commit_seq: Option<i64>,
    barrier_id: String,
    tombstoned: bool,
    pending_unlink: bool,
}

struct Propagation<'a> {
    kind: ArtifactDeletionKind,
    digest: &'a str,
    affected_object_ids: &'a [String],
    barrier_id: &'a str,
    sensitivity: Sensitivity,
    operator_id: Option<&'a str>,
    target_locator: Option<&'a str>,
    deleted_at: i64,
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
            let operator_id = request
                .operator_id
                .as_deref()
                .ok_or_else(|| ArtifactError::new(ArtifactErrorKind::InvalidInput))?;
            let target_locator = request
                .target_locator
                .as_deref()
                .ok_or_else(|| ArtifactError::new(ArtifactErrorKind::InvalidInput))?;
            let mut line = serde_json::to_vec(&PurgeIntentLine {
                digest: &state.digest,
                target_locator,
                operator_id,
                timestamp: request.deleted_at,
            })
            .map_err(|_| ArtifactError::new(ArtifactErrorKind::InvalidInput))?;
            line.push(b'\n');
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
        let operator_id = request.operator_id.clone();
        let reason = request.reason.clone();
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
                    envelope
                        .tx
                        .execute(
                            "INSERT INTO artifact_purge_tombstones(
                                 artifact_digest,artifact_reference,operator_id,reason,purged_at,commit_seq
                             ) VALUES (?1,?2,?3,?4,?5,?6)",
                            params![
                                digest,
                                artifact_reference,
                                operator_id.as_deref().ok_or(KernelError::InvalidInput)?,
                                reason.as_deref().ok_or(KernelError::InvalidInput)?,
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
                    operator_id: operator_id.as_deref(),
                    target_locator: request.target_locator.as_deref(),
                    deleted_at,
                });
                Ok(barrier_id.clone())
            },
            false,
        )
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;

        let result = ArtifactDeletionResult {
            kind,
            digest: state.digest.clone(),
            affected_object_ids: state.all_object_ids,
            commit_seq: receipt.commit_seq,
            barrier_id: state.barrier_id,
            already_applied: false,
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
        let objects = File::open(self.artifacts_path.join("objects")).map_err(|error| {
            self.map_cas_storage_error(classify_io(error), ArtifactErrorKind::PurgeUnlinkPending)
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
        let tmp_path = self.artifacts_path.join("tmp");
        let tmp = File::open(&tmp_path).map_err(|error| {
            self.map_cas_storage_error(classify_io(error), ArtifactErrorKind::PurgeUnlinkPending)
        })?;
        let prefix = format!(".artifact-{digest}-");
        for entry in fs::read_dir(&tmp_path).map_err(|error| {
            self.map_cas_storage_error(classify_io(error), ArtifactErrorKind::PurgeUnlinkPending)
        })? {
            let entry = entry.map_err(|error| {
                self.map_cas_storage_error(
                    classify_io(error),
                    ArtifactErrorKind::PurgeUnlinkPending,
                )
            })?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let file_type = entry.file_type().map_err(|error| {
                self.map_cas_storage_error(
                    classify_io(error),
                    ArtifactErrorKind::PurgeUnlinkPending,
                )
            })?;
            if name.starts_with(&prefix) && (file_type.is_file() || file_type.is_symlink()) {
                durable_unlink(&tmp, &name).map_err(|error| {
                    self.map_cas_storage_error(error, ArtifactErrorKind::PurgeUnlinkPending)
                })?;
            }
        }
        Ok(())
    }

    pub fn deletion_barrier(&self, barrier_id: &str) -> Result<DeletionBarrierStatus, KernelError> {
        if barrier_id.trim().is_empty() {
            return Err(KernelError::InvalidInput);
        }
        let reader = self.lock_reader()?;
        let (digest, deletion_commit_seq, completed_at) = reader
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
        let mut statement = reader
            .prepare(
                "SELECT bc.consumer_id,bc.required_checkpoint_commit_seq,
                        c.checkpoint_commit_seq,a.operator_id,a.abandoned_at
                 FROM deletion_backfill_barrier_consumers bc
                 LEFT JOIN outbox_consumers c USING(consumer_id)
                 LEFT JOIN consumer_abandonments a
                   ON a.consumer_id=bc.consumer_id AND a.barrier_id=bc.barrier_id
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
        let cleared = if consumers.is_empty() {
            completed_at.is_some()
        } else {
            consumers.iter().all(|consumer| consumer.satisfied)
        };
        Ok(DeletionBarrierStatus {
            barrier_id: barrier_id.to_string(),
            digest,
            deletion_commit_seq,
            completed_at,
            consumers,
            cleared,
        })
    }
}

fn validate_request(request: &ArtifactDeletionRequest) -> Result<(), ArtifactError> {
    if request.deleted_at < 0 {
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
            connection
                .query_row(
                    "SELECT artifact_digest FROM evidence_meta WHERE evidence_id=?1",
                    [evidence_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?
                .ok_or_else(|| ArtifactError::new(ArtifactErrorKind::ReferenceUnavailable))?
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
        .collect();
    let barrier_id = format!("artifact-deletion-{digest}");
    let prior_commit_seq = connection
        .query_row(
            "SELECT delete_commit_seq FROM deletion_backfill_barriers WHERE artifact_digest=?1",
            [&digest],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| ArtifactError::new(ArtifactErrorKind::ReferenceCommit))?;
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
        tombstoned,
        pending_unlink,
    })
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
        barrier_id: state.barrier_id.clone(),
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
             ON CONFLICT(artifact_digest) DO UPDATE SET
                 delete_commit_seq=excluded.delete_commit_seq,
                 artifact_reference=excluded.artifact_reference,
                 created_at=excluded.created_at,
                 completed_at=NULL",
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
            redactions: Vec::new(),
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
