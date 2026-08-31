use std::collections::BTreeMap;
use std::fs::{self, File};
use std::time::UNIX_EPOCH;

use rusqlite::{params, TransactionBehavior};

use super::is_artifact_digest;
use crate::kernel::durable_fs::{durable_unlink, open_secure_directory, StorageError};
use crate::kernel::envelope::check_fence;
use crate::kernel::{KernelError, KernelStore};

const HOUR_MS: i64 = 60 * 60 * 1_000;
pub(in crate::kernel) const REFERENCED_GRACE_MS: i64 = 14 * 24 * HOUR_MS;
const ORPHAN_GRACE_MS: i64 = HOUR_MS;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ArtifactGcResult {
    pub reclaimed_objects: usize,
    pub reclaimed_bytes: u64,
    pub failed_candidates: usize,
}

#[cfg(feature = "test-support")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactGcFault {
    AfterReclaiming,
}

#[derive(Clone)]
struct Candidate {
    digest: String,
    modified_at: Option<i64>,
}

impl KernelStore {
    pub(in crate::kernel) fn run_artifact_gc(
        &self,
        now: i64,
        hook: Option<&mut dyn FnMut()>,
        fault_after_reclaiming: bool,
    ) -> Result<ArtifactGcResult, KernelError> {
        let candidates = self.snapshot_gc_candidates()?;
        if let Some(hook) = hook {
            hook();
        }
        let mut result = ArtifactGcResult::default();
        for candidate in candidates {
            match self.reclaim_candidate(&candidate, now, fault_after_reclaiming) {
                Ok(Some(bytes)) => {
                    result.reclaimed_objects += 1;
                    result.reclaimed_bytes = result.reclaimed_bytes.saturating_add(bytes);
                }
                Ok(None) => {}
                Err(error @ (KernelError::FenceLost | KernelError::Fault)) => return Err(error),
                Err(_) => result.failed_candidates += 1,
            }
        }
        Ok(result)
    }

    fn reclaim_candidate(
        &self,
        candidate: &Candidate,
        now: i64,
        fault_after_reclaiming: bool,
    ) -> Result<Option<u64>, KernelError> {
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
        if !prepare_reclaim(&tx, candidate, now, self.lease_epoch())? {
            tx.commit().map_err(|_| KernelError::Io)?;
            return Ok(None);
        }
        tx.commit().map_err(|_| KernelError::Io)?;
        drop(writer);

        if fault_after_reclaiming {
            return Err(KernelError::Fault);
        }
        let (removed, bytes) = self.unlink_artifact(&candidate.digest)?;
        self.sweep_digest_temps(&candidate.digest)
            .map_err(|error| self.map_gc_storage_error(error))?;

        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
        tx.execute(
            "DELETE FROM artifact_ingestion_reservations
             WHERE artifact_digest=?1 AND state='Reclaiming'",
            [&candidate.digest],
        )
        .map_err(|_| KernelError::Io)?;
        tx.execute(
            "DELETE FROM artifact_pending_unlinks WHERE artifact_digest=?1",
            [&candidate.digest],
        )
        .map_err(|_| KernelError::Io)?;
        tx.execute(
            "DELETE FROM capture_pin_refs
             WHERE released_at IS NOT NULL AND evidence_id IN (
                 SELECT evidence_id FROM evidence_meta WHERE artifact_digest=?1
             )",
            [&candidate.digest],
        )
        .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(removed.then_some(bytes))
    }

    fn snapshot_gc_candidates(&self) -> Result<Vec<Candidate>, KernelError> {
        let reader = self.lock_reader()?;
        let mut statement = reader
            .prepare(
                "SELECT artifact_digest FROM artifact_ingestion_reservations
                   WHERE state='Reclaiming'
                 UNION SELECT artifact_digest FROM artifact_pending_unlinks",
            )
            .map_err(|_| KernelError::Io)?;
        let reclaim_state = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| KernelError::Io)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| KernelError::Io)?;
        drop(statement);
        drop(reader);

        // Reclaiming needs bytes to unlink or durable reclaim state to retire.
        // `evidence_meta` outlives both, and `prepare_reclaim` rechecks liveness per
        // candidate, so a pass costs the object scan plus outstanding reclaim rows
        // rather than the whole reference history.
        let mut candidates: BTreeMap<String, Candidate> = BTreeMap::new();
        for digest in reclaim_state {
            if !is_artifact_digest(&digest) {
                continue;
            }
            candidates.insert(
                digest.clone(),
                Candidate {
                    digest,
                    modified_at: None,
                },
            );
        }
        for object in scan_objects(&self.artifacts_path.join("objects"))? {
            candidates
                .entry(object.digest.clone())
                .and_modify(|candidate| candidate.modified_at = object.modified_at)
                .or_insert(object);
        }
        Ok(candidates.into_values().collect())
    }

    fn unlink_artifact(&self, digest: &str) -> Result<(bool, u64), KernelError> {
        let path = self.artifact_object_path(digest);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => metadata,
            Ok(_) => return Err(self.latch_gc_failure()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((false, 0)),
            Err(_) => return Err(self.latch_gc_failure()),
        };
        let objects =
            File::open(self.artifacts_path.join("objects")).map_err(|_| self.latch_gc_failure())?;
        let shard = match open_secure_directory(&objects, &digest[..2]) {
            Ok(shard) => shard,
            Err(StorageError::Other(source)) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok((false, 0))
            }
            Err(error) => return Err(self.map_gc_storage_error(error)),
        };
        durable_unlink(&shard, &digest[2..]).map_err(|error| self.map_gc_storage_error(error))?;
        Ok((true, metadata.len()))
    }

    fn map_gc_storage_error(&self, error: StorageError) -> KernelError {
        if matches!(error, StorageError::Other(_)) {
            self.latch_cas_failure();
        }
        KernelError::Io
    }

    fn latch_gc_failure(&self) -> KernelError {
        self.latch_cas_failure();
        KernelError::Io
    }
}

fn prepare_reclaim(
    tx: &rusqlite::Transaction<'_>,
    candidate: &Candidate,
    now: i64,
    lease_epoch: u64,
) -> Result<bool, KernelError> {
    let pending_purge: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifact_pending_unlinks WHERE artifact_digest=?1)",
            [&candidate.digest],
            |row| row.get(0),
        )
        .map_err(|_| KernelError::Io)?;
    let reclaiming: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifact_ingestion_reservations
                           WHERE artifact_digest=?1 AND state='Reclaiming')",
            [&candidate.digest],
            |row| row.get(0),
        )
        .map_err(|_| KernelError::Io)?;
    if pending_purge || reclaiming {
        return Ok(true);
    }

    let live_reference: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM evidence_meta
                           WHERE artifact_digest=?1 AND invalidated_commit_seq IS NULL)",
            [&candidate.digest],
            |row| row.get(0),
        )
        .map_err(|_| KernelError::Io)?;
    if live_reference {
        return Ok(false);
    }
    let active_pin: bool = tx
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM capture_pin_refs r
                 JOIN capture_pins p USING(capture_pin_id)
                 JOIN evidence_meta e USING(evidence_id)
                 WHERE e.artifact_digest=?1
                   AND COALESCE(r.released_at,p.released_at) IS NULL
             )",
            [&candidate.digest],
            |row| row.get(0),
        )
        .map_err(|_| KernelError::Io)?;
    if active_pin {
        return Ok(false);
    }

    let live_reservation_expires_at: Option<i64> = tx
        .query_row(
            "SELECT MAX(lease_expires_at) FROM artifact_ingestion_reservations
             WHERE artifact_digest=?1 AND state='Live'",
            [&candidate.digest],
            |row| row.get(0),
        )
        .map_err(|_| KernelError::Io)?;
    if live_reservation_expires_at.is_some_and(|expires_at| now < expires_at) {
        return Ok(false);
    }

    let (invalidated_at, retain_until, pin_released_at): (Option<i64>, Option<i64>, Option<i64>) =
        tx.query_row(
            "SELECT MAX(c.recorded_at),MAX(e.retain_until),
                    MAX(COALESCE(r.released_at,p.released_at))
             FROM evidence_meta e
             LEFT JOIN commit_log c ON c.commit_seq=e.invalidated_commit_seq
             LEFT JOIN capture_pin_refs r ON r.evidence_id=e.evidence_id
             LEFT JOIN capture_pins p ON p.capture_pin_id=r.capture_pin_id
             WHERE e.artifact_digest=?1",
            [&candidate.digest],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| KernelError::Io)?;
    if invalidated_at.is_some() || pin_released_at.is_some() {
        let mut deadline = retain_until;
        for timestamp in [invalidated_at, pin_released_at].into_iter().flatten() {
            let Some(grace_deadline) = timestamp.checked_add(REFERENCED_GRACE_MS) else {
                return Ok(false);
            };
            deadline = Some(deadline.map_or(grace_deadline, |value| value.max(grace_deadline)));
        }
        if deadline.is_some_and(|deadline| now < deadline) {
            return Ok(false);
        }
    } else if live_reservation_expires_at.is_none() {
        let Some(modified_at) = candidate.modified_at else {
            return Ok(false);
        };
        if !elapsed(now, modified_at, ORPHAN_GRACE_MS) {
            return Ok(false);
        }
    }

    let changed = tx
        .execute(
            "UPDATE artifact_ingestion_reservations
             SET state='Reclaiming',reclaim_started_at=?1
             WHERE artifact_digest=?2 AND state='Live'",
            params![now, candidate.digest],
        )
        .map_err(|_| KernelError::Io)?;
    if changed == 0 {
        tx.execute(
            "INSERT INTO artifact_ingestion_reservations(
                 reservation_id,artifact_digest,artifact_reference,state,writer_epoch,
                 created_at,heartbeat_at,lease_expires_at,reclaim_started_at
             ) VALUES (?1,?2,?3,'Reclaiming',?4,?5,?5,?5,?5)",
            params![
                format!("gc-{}", candidate.digest),
                candidate.digest,
                format!(
                    "objects/{}/{}",
                    &candidate.digest[..2],
                    &candidate.digest[2..]
                ),
                i64::try_from(lease_epoch).map_err(|_| KernelError::InvalidInput)?,
                now,
            ],
        )
        .map_err(|_| KernelError::Io)?;
    }
    Ok(true)
}

fn elapsed(now: i64, since: i64, duration: i64) -> bool {
    now.checked_sub(since).is_some_and(|age| age >= duration)
}

fn scan_objects(root: &std::path::Path) -> Result<Vec<Candidate>, KernelError> {
    let mut objects = Vec::new();
    for shard in fs::read_dir(root).map_err(|_| KernelError::Io)? {
        let Ok(shard) = shard else { continue };
        let Ok(shard_type) = shard.file_type() else {
            continue;
        };
        let Some(prefix) = shard.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !shard_type.is_dir() || prefix.len() != 2 {
            continue;
        }
        let Ok(entries) = fs::read_dir(shard.path()) else {
            continue;
        };
        for entry in entries {
            let Ok(entry) = entry else { continue };
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let Some(suffix) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let digest = format!("{prefix}{suffix}");
            if metadata.file_type().is_file() && is_artifact_digest(&digest) {
                let modified_at = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .and_then(|duration| i64::try_from(duration.as_millis()).ok());
                objects.push(Candidate {
                    digest,
                    modified_at,
                });
            }
        }
    }
    Ok(objects)
}

pub(in crate::kernel) fn object_usage(
    artifacts_path: &std::path::Path,
) -> Result<u64, KernelError> {
    super::ingest::regular_file_bytes(&artifacts_path.join("objects")).map_err(|_| KernelError::Io)
}
