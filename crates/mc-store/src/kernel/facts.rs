use std::fs;

use rusqlite::TransactionBehavior;

use super::open::family_sidecars;
use super::{KernelError, KernelStore};

pub const MAIN_FILE_WARN_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelFacts {
    pub commit_seq: i64,
    pub main_file_bytes: u64,
    pub family_bytes: u64,
    pub minimum_required_checkpoint: Option<i64>,
    pub commit_lag: Option<i64>,
    pub oldest_unconsumed_age_ms: Option<i64>,
}

impl KernelStore {
    pub fn facts(&self, now_ms: i64) -> Result<KernelFacts, KernelError> {
        if now_ms < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut reader = self.lock_reader()?;
        let tx = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| KernelError::Io)?;
        let commit_seq = tx
            .query_row(
                "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| KernelError::Io)?;
        let minimum_required_checkpoint = tx
            .query_row(
                "SELECT MIN(checkpoint_commit_seq) FROM outbox_consumers",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(|_| KernelError::Io)?;
        // `None` distinguishes no registered consumer from a caught-up consumer.
        let commit_lag =
            minimum_required_checkpoint.map(|checkpoint| commit_seq.saturating_sub(checkpoint));
        let oldest_unconsumed_created_at = match minimum_required_checkpoint {
            Some(checkpoint) if checkpoint < commit_seq => tx
                .query_row(
                    "SELECT MIN(created_at) FROM outbox WHERE commit_seq>?1",
                    [checkpoint],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .map_err(|_| KernelError::Io)?,
            _ => None,
        };
        let main_file_bytes = file_len(&self.db_path)?;
        let family_bytes = family_sidecars(&self.db_path)
            .iter()
            .try_fold(main_file_bytes, |total, path| {
                file_len(path).map(|length| total.saturating_add(length))
            })?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(KernelFacts {
            commit_seq,
            main_file_bytes,
            family_bytes,
            minimum_required_checkpoint,
            commit_lag,
            oldest_unconsumed_age_ms: oldest_unconsumed_created_at
                .map(|created_at| now_ms.saturating_sub(created_at).max(0)),
        })
    }
}

fn file_len(path: &std::path::Path) -> Result<u64, KernelError> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(_) => Err(KernelError::Io),
    }
}
