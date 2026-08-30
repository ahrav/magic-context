use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use super::envelope::check_fence;
use super::redaction::redact;
use super::{KernelError, KernelStore};

pub(super) const HOUR_MS: i64 = 60 * 60 * 1_000;

pub const STAGING_RETENTION_MS: i64 = 30 * 24 * HOUR_MS;

const DELETE_BATCH_RUNS: i64 = 1_024;

/// Owners cannot declare `abandoned`, reserving it for lease-sweep reclamation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StagingTerminalState {
    Completed,
    Failed,
    Canceled,
}

/// A CHECK constraint on both `terminal_state` columns lists `abandoned`, so a typo here fails the write instead of stranding rows the candidate sweep never matches.
const ABANDONED_STATE: &str = "abandoned";

impl StagingTerminalState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StagingMaintenanceResult {
    pub abandoned_runs: usize,
    pub deleted_runs: usize,
}

impl KernelStore {
    /// `heartbeat_at` is the caller's clock reading. The run must still hold a lease at that instant, because the sweep may already have reclaimed an expired one.
    ///
    /// Both leases move forward only. A renewal carrying a shorter lease keeps the longer stored one.
    ///
    /// # Errors
    ///
    /// - Returns [`KernelError::InvalidInput`] when the id is empty, a timestamp is negative, or the lease falls outside `heartbeat_at+1 ..= heartbeat_at + 1h`.
    /// - Returns [`KernelError::NotFound`] when no run has the id.
    /// - Returns [`KernelError::Conflict`] when the run is terminal, its lease has expired, or `heartbeat_at` moves the heartbeat backwards.
    pub fn renew_staging_run(
        &self,
        extraction_run_id: &str,
        heartbeat_at: i64,
        lease_expires_at: i64,
    ) -> Result<(), KernelError> {
        validate_lease(extraction_run_id, heartbeat_at, lease_expires_at)?;
        // `stage_candidate` stores the redacted id, so a raw argument matches no row whenever the id itself contains a detected secret.
        let run_id = redact(extraction_run_id).text;
        let mut writer = self.lock_writer()?;
        let tx = begin_fenced_write(&mut writer, self.lease_epoch())?;
        let run = load_run_lifecycle(&tx, &run_id)?.ok_or(KernelError::NotFound)?;
        if run.terminal_state.is_some()
            || run.lease_expires_at <= heartbeat_at
            || run.heartbeat_at > heartbeat_at
        {
            return Err(KernelError::Conflict);
        }
        tx.execute(
            "UPDATE extraction_runs
             SET heartbeat_at=?1,lease_expires_at=MAX(lease_expires_at,?2)
             WHERE extraction_run_id=?3 AND terminal_state IS NULL",
            params![heartbeat_at, lease_expires_at, run_id],
        )
        .map_err(|_| KernelError::Io)?;
        tx.execute(
            "UPDATE candidates
             SET heartbeat_at=MAX(heartbeat_at,?1),lease_expires_at=MAX(lease_expires_at,?2)
             WHERE extraction_run_id=?3 AND terminal_state IS NULL",
            params![heartbeat_at, lease_expires_at, run_id],
        )
        .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)
    }

    /// `terminal_at` starts the run's retention clock, so it is bracketed by the run's own timestamps: at or after `max(started_at, heartbeat_at)`, and inside the lease. A value below the floor lets the next sweep delete a run that just finished, and one past the lease exempts the run from the cutoff indefinitely.
    ///
    /// # Errors
    ///
    /// - Returns [`KernelError::InvalidInput`] when the id is empty, `terminal_at` is negative, or `terminal_at` precedes the run's `started_at` or `heartbeat_at`.
    /// - Returns [`KernelError::NotFound`] when no run has the id.
    /// - Returns [`KernelError::Conflict`] when the run is already terminal, or its lease has expired at `terminal_at`.
    pub fn finish_staging_run(
        &self,
        extraction_run_id: &str,
        state: StagingTerminalState,
        terminal_at: i64,
    ) -> Result<(), KernelError> {
        if extraction_run_id.trim().is_empty() || terminal_at < 0 {
            return Err(KernelError::InvalidInput);
        }
        let run_id = redact(extraction_run_id).text;
        let mut writer = self.lock_writer()?;
        let tx = begin_fenced_write(&mut writer, self.lease_epoch())?;
        let run = load_run_lifecycle(&tx, &run_id)?.ok_or(KernelError::NotFound)?;
        if run.terminal_state.is_some() {
            return Err(KernelError::Conflict);
        }
        if terminal_at < run.started_at.max(run.heartbeat_at) {
            return Err(KernelError::InvalidInput);
        }
        // The lease also caps terminal_at from above, so a clock error cannot park a run
        // beyond the deletion cutoff forever.
        if terminal_at >= run.lease_expires_at {
            return Err(KernelError::Conflict);
        }
        tx.execute(
            "UPDATE extraction_runs SET terminal_state=?1,terminal_at=?2
             WHERE extraction_run_id=?3 AND terminal_state IS NULL",
            params![state.as_str(), terminal_at, run_id],
        )
        .map_err(|_| KernelError::Io)?;
        tx.execute(
            "UPDATE candidates SET terminal_state=?1,terminal_at=?2
             WHERE extraction_run_id=?3 AND terminal_state IS NULL",
            params![state.as_str(), terminal_at, run_id],
        )
        .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)
    }

    /// # Errors
    ///
    /// Returns [`KernelError::InvalidInput`] when `now` is negative.
    pub fn abandon_expired_staging_runs(&self, now: i64) -> Result<usize, KernelError> {
        if now < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut writer = self.lock_writer()?;
        let tx = begin_fenced_write(&mut writer, self.lease_epoch())?;
        let abandoned = abandon_expired(&tx, now)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(abandoned)
    }

    /// `candidates` and `candidate_scores` follow by foreign-key cascade. `durable_text_redactions` references neither table, so the sweep deletes its rows for the purged runs and candidates explicitly, preventing stale text offsets and redaction-key collisions when the same run id is staged again.
    ///
    /// Each call deletes at most [`DELETE_BATCH_RUNS`] runs. Repeat until `deleted_runs` is zero.
    ///
    /// # Errors
    ///
    /// Returns [`KernelError::InvalidInput`] when `now` is negative.
    pub fn delete_aged_staging_runs(&self, now: i64) -> Result<usize, KernelError> {
        if now < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut writer = self.lock_writer()?;
        let tx = begin_fenced_write(&mut writer, self.lease_epoch())?;
        let deleted = delete_aged(&tx, now)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(deleted)
    }

    /// # Errors
    ///
    /// Returns [`KernelError::InvalidInput`] when `now` is negative.
    pub fn run_staging_maintenance(
        &self,
        now: i64,
    ) -> Result<StagingMaintenanceResult, KernelError> {
        if now < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut writer = self.lock_writer()?;
        let tx = begin_fenced_write(&mut writer, self.lease_epoch())?;
        let abandoned_runs = abandon_expired(&tx, now)?;
        let deleted_runs = delete_aged(&tx, now)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(StagingMaintenanceResult {
            abandoned_runs,
            deleted_runs,
        })
    }
}

struct RunLifecycle {
    terminal_state: Option<String>,
    started_at: i64,
    heartbeat_at: i64,
    lease_expires_at: i64,
}

fn load_run_lifecycle(
    tx: &Transaction<'_>,
    extraction_run_id: &str,
) -> Result<Option<RunLifecycle>, KernelError> {
    tx.query_row(
        "SELECT terminal_state,started_at,heartbeat_at,lease_expires_at
         FROM extraction_runs WHERE extraction_run_id=?1",
        [extraction_run_id],
        |row| {
            Ok(RunLifecycle {
                terminal_state: row.get(0)?,
                started_at: row.get(1)?,
                heartbeat_at: row.get(2)?,
                lease_expires_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|_| KernelError::Io)
}

fn abandon_expired(tx: &Transaction<'_>, now: i64) -> Result<usize, KernelError> {
    let abandoned = tx
        .execute(
            "UPDATE extraction_runs
             SET terminal_state=?2,terminal_at=?1
             WHERE terminal_state IS NULL AND lease_expires_at<=?1",
            params![now, ABANDONED_STATE],
        )
        .map_err(|_| KernelError::Io)?;
    tx.execute(
        "UPDATE candidates
         SET terminal_state=?2,
             terminal_at=(SELECT terminal_at FROM extraction_runs
                          WHERE extraction_run_id=candidates.extraction_run_id)
         WHERE terminal_state IS NULL AND extraction_run_id IN (
             SELECT extraction_run_id FROM extraction_runs
             WHERE terminal_state=?2 AND terminal_at<=?1
         )",
        params![now, ABANDONED_STATE],
    )
    .map_err(|_| KernelError::Io)?;
    Ok(abandoned)
}

fn delete_aged(tx: &Transaction<'_>, now: i64) -> Result<usize, KernelError> {
    let cutoff = now.saturating_sub(STAGING_RETENTION_MS);
    let run_ids: Vec<String> = tx
        .prepare(
            "SELECT extraction_run_id FROM extraction_runs
             WHERE terminal_at IS NOT NULL AND terminal_at<=?1
             ORDER BY terminal_at,extraction_run_id
             LIMIT ?2",
        )
        .and_then(|mut stmt| {
            stmt.query_map(params![cutoff, DELETE_BATCH_RUNS], |row| row.get(0))?
                .collect()
        })
        .map_err(|_| KernelError::Io)?;
    for run_id in &run_ids {
        tx.execute(
            "DELETE FROM durable_text_redactions
             WHERE owner_kind='staging_candidate' AND owner_id IN (
                 SELECT candidate_id FROM candidates WHERE extraction_run_id=?1
             )",
            [run_id],
        )
        .map_err(|_| KernelError::Io)?;
        tx.execute(
            "DELETE FROM durable_text_redactions
             WHERE owner_kind='extraction_run' AND owner_id=?1",
            [run_id],
        )
        .map_err(|_| KernelError::Io)?;
        tx.execute(
            "DELETE FROM extraction_runs WHERE extraction_run_id=?1",
            [run_id],
        )
        .map_err(|_| KernelError::Io)?;
    }
    Ok(run_ids.len())
}

pub(super) fn begin_fenced_write(
    writer: &mut rusqlite::Connection,
    lease_epoch: u64,
) -> Result<Transaction<'_>, KernelError> {
    let tx = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| KernelError::Io)?;
    check_fence(&tx, lease_epoch)?;
    Ok(tx)
}

fn validate_lease(
    extraction_run_id: &str,
    heartbeat_at: i64,
    lease_expires_at: i64,
) -> Result<(), KernelError> {
    if extraction_run_id.trim().is_empty()
        || heartbeat_at < 0
        || lease_expires_at <= heartbeat_at
        || lease_expires_at > heartbeat_at.saturating_add(HOUR_MS)
    {
        return Err(KernelError::InvalidInput);
    }
    Ok(())
}
