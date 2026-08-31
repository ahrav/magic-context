use rusqlite::{params, TransactionBehavior};

use super::envelope::check_fence;
use super::open::current_time_ms;
use super::{KernelError, KernelStore};
use crate::kernel::cas::ArtifactGcResult;

const HOUR_MS: i64 = 60 * 60 * 1_000;
const STAGING_RETENTION_MS: i64 = 30 * 24 * HOUR_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StagingTerminalState {
    Completed,
    Failed,
    Canceled,
}

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
    pub abandoned: usize,
    pub deleted_runs: usize,
    pub artifact_gc: ArtifactGcResult,
}

impl KernelStore {
    pub fn renew_staging_run(
        &self,
        extraction_run_id: &str,
        heartbeat_at: i64,
        lease_expires_at: i64,
    ) -> Result<(), KernelError> {
        validate_lease(extraction_run_id, heartbeat_at, lease_expires_at)?;
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
        let changed = tx
            .execute(
                "UPDATE extraction_runs
                 SET heartbeat_at=?1,lease_expires_at=?2
                 WHERE extraction_run_id=?3 AND terminal_state IS NULL AND heartbeat_at<=?1",
                params![heartbeat_at, lease_expires_at, extraction_run_id],
            )
            .map_err(|_| KernelError::Io)?;
        if changed != 1 {
            return Err(KernelError::Conflict);
        }
        tx.execute(
            "UPDATE candidates SET heartbeat_at=?1,lease_expires_at=?2
             WHERE extraction_run_id=?3 AND terminal_state IS NULL",
            params![heartbeat_at, lease_expires_at, extraction_run_id],
        )
        .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)
    }

    pub fn finish_staging_run(
        &self,
        extraction_run_id: &str,
        state: StagingTerminalState,
        terminal_at: i64,
    ) -> Result<(), KernelError> {
        if extraction_run_id.trim().is_empty() || terminal_at < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
        if tx
            .execute(
                "UPDATE extraction_runs SET terminal_state=?1,terminal_at=?2
                 WHERE extraction_run_id=?3 AND terminal_state IS NULL",
                params![state.as_str(), terminal_at, extraction_run_id],
            )
            .map_err(|_| KernelError::Io)?
            != 1
        {
            return Err(KernelError::Conflict);
        }
        tx.execute(
            "UPDATE candidates SET terminal_state=?1,terminal_at=?2
             WHERE extraction_run_id=?3 AND terminal_state IS NULL",
            params![state.as_str(), terminal_at, extraction_run_id],
        )
        .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)
    }

    pub fn run_staging_maintenance(
        &self,
        now: i64,
    ) -> Result<StagingMaintenanceResult, KernelError> {
        self.run_staging_maintenance_inner(now, None, false)
    }

    fn run_staging_maintenance_inner(
        &self,
        now: i64,
        hook: Option<&mut dyn FnMut()>,
        fault_after_reclaiming: bool,
    ) -> Result<StagingMaintenanceResult, KernelError> {
        if now < 0 {
            return Err(KernelError::InvalidInput);
        }
        self.run_capture_pin_maintenance(now)?;
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
        let abandoned = tx
            .execute(
                "UPDATE extraction_runs
                 SET terminal_state='abandoned',terminal_at=?1
                 WHERE terminal_state IS NULL AND lease_expires_at<=?1",
                [now],
            )
            .map_err(|_| KernelError::Io)?;
        tx.execute(
            "UPDATE candidates
             SET terminal_state='abandoned',
                 terminal_at=(SELECT terminal_at FROM extraction_runs
                              WHERE extraction_run_id=candidates.extraction_run_id)
             WHERE terminal_state IS NULL AND extraction_run_id IN (
                 SELECT extraction_run_id FROM extraction_runs
                 WHERE terminal_state='abandoned' AND terminal_at<=?1
             )",
            [now],
        )
        .map_err(|_| KernelError::Io)?;
        let cutoff = now.saturating_sub(STAGING_RETENTION_MS);
        let deleted_runs = tx
            .execute(
                "DELETE FROM extraction_runs
                 WHERE terminal_at IS NOT NULL AND terminal_at<=?1",
                [cutoff],
            )
            .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        drop(writer);
        let artifact_gc = self.run_artifact_gc(now, hook, fault_after_reclaiming)?;
        Ok(StagingMaintenanceResult {
            abandoned,
            deleted_runs,
            artifact_gc,
        })
    }

    #[cfg(feature = "test-support")]
    pub fn run_staging_maintenance_with_hook_for_test(
        &self,
        now: i64,
        mut hook: impl FnMut(),
    ) -> Result<StagingMaintenanceResult, KernelError> {
        self.run_staging_maintenance_inner(now, Some(&mut hook), false)
    }

    #[cfg(feature = "test-support")]
    pub fn run_staging_maintenance_with_fault_for_test(
        &self,
        now: i64,
        fault: crate::kernel::cas::ArtifactGcFault,
    ) -> Result<StagingMaintenanceResult, KernelError> {
        self.run_staging_maintenance_inner(
            now,
            None,
            fault == crate::kernel::cas::ArtifactGcFault::AfterReclaiming,
        )
    }

    pub(super) fn run_startup_maintenance(&self) -> Result<(), KernelError> {
        self.run_staging_maintenance(current_time_ms()).map(|_| ())
    }
}

fn validate_lease(
    extraction_run_id: &str,
    heartbeat_at: i64,
    lease_expires_at: i64,
) -> Result<(), KernelError> {
    if extraction_run_id.trim().is_empty()
        || heartbeat_at < 0
        || lease_expires_at < heartbeat_at
        || lease_expires_at > heartbeat_at.saturating_add(HOUR_MS)
    {
        return Err(KernelError::InvalidInput);
    }
    Ok(())
}
