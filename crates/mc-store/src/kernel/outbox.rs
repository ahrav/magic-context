use rusqlite::{params, OptionalExtension, Transaction};

use super::envelope::{Envelope, ObjectRow, PendingChange, Sensitivity};
use super::redaction::{redact, RedactedField};
use super::retention::begin_fenced_write;
use super::{KernelError, KernelStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboxPruneResult {
    /// Rows at or below this `commit_seq` were deleted; the bound is inclusive.
    pub horizon: i64,
    pub deleted: usize,
}

impl Envelope<'_> {
    /// Every entry point screens `consumer_id` through [`stable_consumer_id`], since the id is the primary key of `outbox_consumers`.
    ///
    /// # Errors
    ///
    /// - Returns [`KernelError::InvalidInput`] when `recorded_at` is negative, `consumer_id` is empty, or redaction rewrites `consumer_id`.
    /// - Returns [`KernelError::Conflict`] when the consumer is already registered.
    pub fn register_outbox_consumer(
        &mut self,
        consumer_id: &str,
        recorded_at: i64,
    ) -> Result<i64, KernelError> {
        if recorded_at < 0 {
            return Err(KernelError::InvalidInput);
        }
        let consumer_id = stable_consumer_id(consumer_id)?;
        let oldest_commit = self
            .tx
            .query_row("SELECT MIN(commit_seq) FROM outbox", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .map_err(|_| KernelError::Io)?;
        let checkpoint = match oldest_commit {
            Some(commit_seq) => commit_seq.saturating_sub(1),
            None => self.pre_operation_tip()?,
        };
        self.tx
            .execute(
                "INSERT INTO outbox_consumers(consumer_id,checkpoint_commit_seq,updated_at)
                 VALUES (?1,?2,?3)",
                params![consumer_id.text, checkpoint, recorded_at],
            )
            .map_err(|error| match error {
                rusqlite::Error::SqliteFailure(code, _)
                    if code.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    KernelError::Conflict
                }
                _ => KernelError::Io,
            })?;
        let audit = serde_json::json!({
            "consumer_id": consumer_id.text.clone(),
            "checkpoint_commit_seq": checkpoint,
            "recorded_at": recorded_at,
        });
        self.push_control_change(
            consumer_id.text.clone(),
            "consumer_register",
            audit,
            vec![("consumer_id".to_string(), consumer_id)],
        );
        Ok(checkpoint)
    }

    /// # Errors
    ///
    /// - Returns [`KernelError::InvalidInput`] when `recorded_at` is negative or `consumer_id` is empty.
    /// - Returns [`KernelError::NotFound`] when the consumer is not registered.
    /// - Returns [`KernelError::ConsumerPending`] when the consumer checkpoint is below the pre-operation tip.
    pub fn deregister_outbox_consumer(
        &mut self,
        consumer_id: &str,
        recorded_at: i64,
    ) -> Result<(), KernelError> {
        let (consumer_id, checkpoint) = self.consumer_checkpoint(consumer_id, recorded_at)?;
        if checkpoint < self.pre_operation_tip()? {
            return Err(KernelError::ConsumerPending);
        }
        self.tx
            .execute(
                "DELETE FROM outbox_consumers WHERE consumer_id=?1",
                [consumer_id.text.as_str()],
            )
            .map_err(|_| KernelError::Io)?;
        let audit = serde_json::json!({
            "consumer_id": consumer_id.text.clone(),
            "checkpoint_commit_seq": checkpoint,
            "recorded_at": recorded_at,
        });
        self.push_control_change(
            consumer_id.text.clone(),
            "consumer_deregister",
            audit,
            vec![("consumer_id".to_string(), consumer_id)],
        );
        Ok(())
    }

    /// # Errors
    ///
    /// - Returns [`KernelError::InvalidInput`] when `abandoned_at` is negative, or when `consumer_id`, `operator_id`, or `reason` is empty.
    /// - Returns [`KernelError::NotFound`] when the consumer is not registered.
    pub fn abandon_outbox_consumer(
        &mut self,
        consumer_id: &str,
        operator_id: &str,
        reason: &str,
        abandoned_at: i64,
    ) -> Result<(), KernelError> {
        if operator_id.trim().is_empty() || reason.trim().is_empty() {
            return Err(KernelError::InvalidInput);
        }
        let (consumer_id, checkpoint) = self.consumer_checkpoint(consumer_id, abandoned_at)?;
        let operator_id = redact(operator_id);
        let reason = redact(reason);
        let abandonment_id = format!("{}:{}", self.commit_seq, consumer_id.text);
        self.tx
            .execute(
                "INSERT INTO consumer_abandonments(
                     abandonment_id,consumer_id,operator_id,last_checkpoint_commit_seq,
                     reason,abandoned_at,commit_seq
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    abandonment_id,
                    consumer_id.text,
                    operator_id.text,
                    checkpoint,
                    reason.text,
                    abandoned_at,
                    self.commit_seq,
                ],
            )
            .map_err(|_| KernelError::Io)?;
        self.tx
            .execute(
                "DELETE FROM outbox_consumers WHERE consumer_id=?1",
                [consumer_id.text.as_str()],
            )
            .map_err(|_| KernelError::Io)?;
        let audit = serde_json::json!({
            "consumer_id": consumer_id.text.clone(),
            "checkpoint_commit_seq": checkpoint,
            "operator_id": operator_id.text.clone(),
            "reason": reason.text.clone(),
            "abandoned_at": abandoned_at,
        });
        self.push_control_change(
            consumer_id.text.clone(),
            "consumer_abandon",
            audit,
            vec![
                ("consumer_id".to_string(), consumer_id),
                ("operator_id".to_string(), operator_id),
                ("reason".to_string(), reason),
            ],
        );
        Ok(())
    }

    fn consumer_checkpoint(
        &self,
        consumer_id: &str,
        recorded_at: i64,
    ) -> Result<(RedactedField, i64), KernelError> {
        if recorded_at < 0 {
            return Err(KernelError::InvalidInput);
        }
        let consumer_id = stable_consumer_id(consumer_id)?;
        let checkpoint = self
            .tx
            .query_row(
                "SELECT checkpoint_commit_seq FROM outbox_consumers WHERE consumer_id=?1",
                [consumer_id.text.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| KernelError::Io)?
            .ok_or(KernelError::NotFound)?;
        Ok((consumer_id, checkpoint))
    }

    fn pre_operation_tip(&self) -> Result<i64, KernelError> {
        self.tx
            .query_row(
                "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log WHERE commit_seq<?1",
                [self.commit_seq],
                |row| row.get(0),
            )
            .map_err(|_| KernelError::Io)
    }

    fn push_control_change(
        &mut self,
        object_id: String,
        kind: &'static str,
        audit: serde_json::Value,
        redactions: Vec<(String, RedactedField)>,
    ) {
        self.changes.push(PendingChange {
            object: ObjectRow {
                source_id: object_id.clone(),
                object_id,
                object_kind: "outbox_consumer".to_string(),
                domain_id: "kernel-control".to_string(),
                source_kind: "kernel-control".to_string(),
                source_revision: 0,
                created_commit_seq: self.commit_seq,
                invalidated_commit_seq: None,
                superseded_by: None,
                sensitivity: Sensitivity::Normal,
            },
            kind,
            replaced_object_id: None,
            redactions,
            audit: Some(audit),
        });
    }
}

impl KernelStore {
    /// The watermark lives in `outbox_publication` rather than being derived from surviving `outbox` rows, so a publisher whose acknowledgement round trip was lost can repeat the same position after those rows are pruned.
    ///
    /// A position at or below the stored watermark counts as already published and skips the commit-boundary check.
    ///
    /// # Errors
    ///
    /// - Returns [`KernelError::InvalidInput`] when `outbox_position` is below 1 or `published_at` is negative.
    /// - Returns [`KernelError::InvalidCheckpoint`] when the position is above the watermark and is not the last row of its commit.
    pub fn mark_outbox_published_through(
        &self,
        outbox_position: i64,
        published_at: i64,
    ) -> Result<(), KernelError> {
        if outbox_position < 1 || published_at < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut writer = self.lock_writer()?;
        let tx = begin_fenced_write(&mut writer, self.lease_epoch())?;
        let watermark = published_watermark(&tx)?;
        if outbox_position > watermark && !is_outbox_commit_boundary(&tx, outbox_position)? {
            return Err(KernelError::InvalidCheckpoint);
        }
        tx.execute(
            "UPDATE outbox SET published_at=?1
             WHERE outbox_position<=?2 AND published_at IS NULL",
            params![published_at, outbox_position],
        )
        .map_err(|_| KernelError::Io)?;
        tx.execute(
            "INSERT INTO outbox_publication(id,published_through_position,published_at)
             VALUES (0,?1,?2)
             ON CONFLICT(id) DO UPDATE SET
                 published_through_position=MAX(published_through_position,?1),
                 published_at=MAX(published_at,?2)",
            params![outbox_position, published_at],
        )
        .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)
    }

    /// # Errors
    ///
    /// - Returns [`KernelError::InvalidInput`] when `consumer_id` is empty or a timestamp is negative.
    /// - Returns [`KernelError::NotFound`] when the consumer is not registered.
    /// - Returns [`KernelError::InvalidCheckpoint`] when the checkpoint moves backwards or names no committed sequence.
    pub fn acknowledge_outbox(
        &self,
        consumer_id: &str,
        checkpoint_commit_seq: i64,
        updated_at: i64,
    ) -> Result<(), KernelError> {
        if checkpoint_commit_seq < 0 || updated_at < 0 {
            return Err(KernelError::InvalidInput);
        }
        let consumer_id = stable_consumer_id(consumer_id)?;
        let mut writer = self.lock_writer()?;
        let tx = begin_fenced_write(&mut writer, self.lease_epoch())?;
        let current = tx
            .query_row(
                "SELECT checkpoint_commit_seq FROM outbox_consumers WHERE consumer_id=?1",
                [consumer_id.text.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| KernelError::Io)?
            .ok_or(KernelError::NotFound)?;
        let is_existing_commit = checkpoint_commit_seq == current
            || tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM commit_log WHERE commit_seq=?1)",
                    [checkpoint_commit_seq],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| KernelError::Io)?;
        if checkpoint_commit_seq < current || !is_existing_commit {
            return Err(KernelError::InvalidCheckpoint);
        }
        tx.execute(
            "UPDATE outbox_consumers
             SET checkpoint_commit_seq=?1,updated_at=MAX(updated_at,?2)
             WHERE consumer_id=?3",
            params![checkpoint_commit_seq, updated_at, consumer_id.text],
        )
        .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)
    }

    /// Registered consumers bound the horizon; publication does not. A publisher that needs its own rows retained registers as a consumer, because `published_at` records progress without holding rows back.
    ///
    /// # Errors
    ///
    /// Returns [`KernelError::NoRequiredConsumers`] when no consumer is registered, since an empty consumer set names no safe horizon.
    pub fn prune_outbox(&self) -> Result<OutboxPruneResult, KernelError> {
        let mut writer = self.lock_writer()?;
        let tx = begin_fenced_write(&mut writer, self.lease_epoch())?;
        let horizon = tx
            .query_row(
                "SELECT MIN(checkpoint_commit_seq) FROM outbox_consumers",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(|_| KernelError::Io)?
            .ok_or(KernelError::NoRequiredConsumers)?;
        tx.execute(
            "DELETE FROM durable_text_redactions
             WHERE owner_kind='outbox' AND owner_id IN (
                 SELECT CAST(outbox_position AS TEXT) FROM outbox WHERE commit_seq<=?1
             )",
            [horizon],
        )
        .map_err(|_| KernelError::Io)?;
        let deleted = tx
            .execute("DELETE FROM outbox WHERE commit_seq<=?1", [horizon])
            .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(OutboxPruneResult { horizon, deleted })
    }
}

/// Redaction is not injective, so an id it rewrites can alias onto a different registered consumer. Screening every entry point, not just registration, keeps one consumer's acknowledgement from advancing another's prune horizon.
fn stable_consumer_id(consumer_id: &str) -> Result<RedactedField, KernelError> {
    if consumer_id.trim().is_empty() {
        return Err(KernelError::InvalidInput);
    }
    let redacted = redact(consumer_id);
    if redacted.text != consumer_id {
        return Err(KernelError::InvalidInput);
    }
    Ok(redacted)
}

fn published_watermark(tx: &Transaction<'_>) -> Result<i64, KernelError> {
    tx.query_row(
        "SELECT published_through_position FROM outbox_publication WHERE id=0",
        [],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|value| value.unwrap_or(0))
    .map_err(|_| KernelError::Io)
}

fn is_outbox_commit_boundary(
    tx: &Transaction<'_>,
    outbox_position: i64,
) -> Result<bool, KernelError> {
    tx.query_row(
        "SELECT NOT EXISTS(
             SELECT 1 FROM outbox later
             WHERE later.commit_seq=chosen.commit_seq
               AND later.outbox_position>chosen.outbox_position
         ) FROM outbox chosen WHERE chosen.outbox_position=?1",
        [outbox_position],
        |row| row.get::<_, bool>(0),
    )
    .optional()
    .map(|value| value.unwrap_or(false))
    .map_err(|_| KernelError::Io)
}
