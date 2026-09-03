use std::fs;

use rusqlite::{Transaction, TransactionBehavior};

use super::open::family_sidecars;
use super::outbox::published_watermark;
use super::{KernelError, KernelStore};

/// One-gibibyte main database size used by callers as an operational warning threshold.
///
/// The value is measured in bytes. [`KernelStore::facts`] reports the current size but
/// does not apply this threshold itself.
pub const MAIN_FILE_WARN_BYTES: u64 = 1024 * 1024 * 1024;

/// Combines transaction-consistent commit counters with separately sampled file sizes.
///
/// Sizes are sampled per file outside any transaction, so a concurrent commit or
/// checkpoint can change them between reads. They describe recent growth for
/// alerting, not a snapshot consistent with `commit_seq`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelFacts {
    pub commit_seq: i64,
    pub main_file_bytes: u64,
    pub family_bytes: u64,
    pub minimum_required_checkpoint: Option<i64>,
    pub commit_lag: Option<i64>,
    pub outbox_lag: OutboxLag,
    pub retained_outbox_rows: u64,
    pub artifact_budget: ArtifactBudgetFacts,
}

/// `warn` becomes true at 80 percent of `cap_bytes`. Saturating arithmetic also makes
/// a zero-byte cap warn for every usage value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArtifactBudgetFacts {
    pub usage_bytes: u64,
    pub cap_bytes: u64,
    pub warn: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboxLag {
    /// Published outbox rows the slowest required consumer has not acknowledged.
    /// `None` when no consumer is registered.
    pub position_lag: Option<i64>,
    pub oldest_unconsumed_age_ms: Option<i64>,
    pub consumer_count: u64,
}

impl KernelStore {
    /// Samples transaction-consistent commit facts, then database-family and artifact sizes.
    ///
    /// `now_ms` is Unix-epoch milliseconds, while `oldest_unconsumed_age_ms` is an elapsed age in milliseconds measured from the oldest pending outbox row.
    /// Future-dated outbox rows report age zero. Missing database sidecar files contribute zero bytes.
    pub fn facts(&self, now_ms: i64) -> Result<KernelFacts, KernelError> {
        Ok(self
            .facts_unless(now_ms, &|| false)?
            .expect("an uncancellable sample completes"))
    }

    /// [`facts`](Self::facts) whose artifact traversal, the one unbounded step,
    /// stops once `cancelled` returns true and yields `None`.
    pub fn facts_unless(
        &self,
        now_ms: i64,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<KernelFacts>, KernelError> {
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
        let consumers = consumer_horizon(&tx)?;
        // `None` distinguishes no registered consumer from a caught-up consumer.
        let commit_lag = consumers
            .minimum_checkpoint
            .map(|checkpoint| commit_seq.saturating_sub(checkpoint));
        let lag = outbox_lag_in(&tx, &consumers, now_ms)?;
        let retained_outbox_rows = tx
            .query_row("SELECT COUNT(*) FROM outbox", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|_| KernelError::Io)?
            .try_into()
            .unwrap_or(0);
        tx.commit().map_err(|_| KernelError::Io)?;
        let main_file_bytes = file_len(&self.db_path)?;
        let family_bytes = family_sidecars(&self.db_path)
            .iter()
            .try_fold(main_file_bytes, |total, path| {
                file_len(path).map(|length| total.saturating_add(length))
            })?;
        let Some(artifact_budget) = self.artifact_budget_facts_unless(cancelled)? else {
            return Ok(None);
        };
        Ok(Some(KernelFacts {
            commit_seq,
            main_file_bytes,
            family_bytes,
            minimum_required_checkpoint: consumers.minimum_checkpoint,
            commit_lag,
            outbox_lag: lag,
            retained_outbox_rows,
            artifact_budget,
        }))
    }

    /// # Errors
    ///
    /// Returns [`KernelError::InvalidInput`] if `now_ms` is negative or
    /// [`KernelError::Io`] if a database operation fails.
    pub fn outbox_lag(&self, now_ms: i64) -> Result<OutboxLag, KernelError> {
        if now_ms < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut reader = self.lock_reader()?;
        let tx = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| KernelError::Io)?;
        let consumers = consumer_horizon(&tx)?;
        let lag = outbox_lag_in(&tx, &consumers, now_ms)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(lag)
    }

    /// Artifact traversal failures propagate as [`KernelError`].
    pub fn artifact_budget_facts(&self) -> Result<ArtifactBudgetFacts, KernelError> {
        Ok(self
            .artifact_budget_facts_unless(&|| false)?
            .expect("an uncancellable walk completes"))
    }

    fn artifact_budget_facts_unless(
        &self,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<ArtifactBudgetFacts>, KernelError> {
        let Some(usage_bytes) = super::cas::gc::object_usage(self, cancelled)? else {
            return Ok(None);
        };
        let warn_at = self.artifact_cap.saturating_sub(self.artifact_cap / 5);
        Ok(Some(ArtifactBudgetFacts {
            usage_bytes,
            cap_bytes: self.artifact_cap,
            warn: usage_bytes >= warn_at,
        }))
    }
}

struct ConsumerHorizon {
    minimum_checkpoint: Option<i64>,
    count: u64,
}

fn consumer_horizon(tx: &Transaction<'_>) -> Result<ConsumerHorizon, KernelError> {
    tx.query_row(
        "SELECT MIN(checkpoint_commit_seq), COUNT(*) FROM outbox_consumers",
        [],
        |row| {
            Ok(ConsumerHorizon {
                minimum_checkpoint: row.get::<_, Option<i64>>(0)?,
                count: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
            })
        },
    )
    .map_err(|_| KernelError::Io)
}

/// Position lag counts published rows past the slowest checkpoint rather than
/// subtracting positions, so pruned rows below the horizon cannot skew it and a
/// publication watermark behind the newest commit is respected. Age covers
/// every unconsumed row, published or not, because an unpublished row is still
/// waiting on the consumer.
fn outbox_lag_in(
    tx: &Transaction<'_>,
    consumers: &ConsumerHorizon,
    now_ms: i64,
) -> Result<OutboxLag, KernelError> {
    let Some(checkpoint) = consumers.minimum_checkpoint else {
        return Ok(OutboxLag {
            position_lag: None,
            oldest_unconsumed_age_ms: None,
            consumer_count: consumers.count,
        });
    };
    let watermark = published_watermark(tx)?;
    let position_lag = tx
        .query_row(
            "SELECT COUNT(*) FROM outbox WHERE commit_seq>?1 AND outbox_position<=?2",
            [checkpoint, watermark],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| KernelError::Io)?;
    let oldest_unconsumed_created_at = tx
        .query_row(
            "SELECT MIN(created_at) FROM outbox WHERE commit_seq>?1",
            [checkpoint],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|_| KernelError::Io)?;
    Ok(OutboxLag {
        position_lag: Some(position_lag),
        oldest_unconsumed_age_ms: oldest_unconsumed_created_at
            .map(|created_at| now_ms.saturating_sub(created_at).max(0)),
        consumer_count: consumers.count,
    })
}

fn file_len(path: &std::path::Path) -> Result<u64, KernelError> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(_) => Err(KernelError::Io),
    }
}
