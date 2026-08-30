use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::envelope::{check_fence, Envelope, ObjectRow, PendingChange, Sensitivity};
use super::redaction::{redact, RedactedField};
use super::{KernelError, KernelStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboxPruneResult {
    pub horizon: i64,
    pub deleted: usize,
}

impl Envelope<'_> {
    pub fn register_outbox_consumer(
        &mut self,
        consumer_id: &str,
        recorded_at: i64,
    ) -> Result<i64, KernelError> {
        if recorded_at < 0 || consumer_id.trim().is_empty() {
            return Err(KernelError::InvalidInput);
        }
        let consumer_id = redact(consumer_id);
        let oldest_commit = self
            .tx
            .query_row("SELECT MIN(commit_seq) FROM outbox", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .map_err(|_| KernelError::Io)?;
        let checkpoint = match oldest_commit {
            Some(commit_seq) => commit_seq.saturating_sub(1).max(0),
            None => self.pre_operation_tip()?,
        };
        self.tx
            .execute(
                "INSERT INTO outbox_consumers(consumer_id,checkpoint_commit_seq,updated_at)
                 VALUES (?1,?2,?3)",
                params![consumer_id.text, checkpoint, recorded_at],
            )
            .map_err(|error| match error {
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error {
                        code: rusqlite::ErrorCode::ConstraintViolation,
                        ..
                    },
                    _,
                ) => KernelError::Conflict,
                _ => KernelError::Io,
            })?;
        let audit_owner_id = consumer_id.text.clone();
        self.push_control_change(
            &audit_owner_id,
            "consumer_register",
            serde_json::json!({
                "consumer_id": consumer_id.text.clone(),
                "checkpoint_commit_seq": checkpoint,
                "recorded_at": recorded_at,
            }),
            vec![("consumer_id".to_string(), consumer_id)],
        );
        Ok(checkpoint)
    }

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
        let audit_owner_id = consumer_id.text.clone();
        self.push_control_change(
            &audit_owner_id,
            "consumer_deregister",
            serde_json::json!({
                "consumer_id": consumer_id.text.clone(),
                "checkpoint_commit_seq": checkpoint,
                "recorded_at": recorded_at,
            }),
            vec![("consumer_id".to_string(), consumer_id)],
        );
        Ok(())
    }

    pub fn abandon_outbox_consumer(
        &mut self,
        consumer_id: &str,
        operator_id: &str,
        reason: &str,
        abandoned_at: i64,
    ) -> Result<(), KernelError> {
        let (consumer_id, checkpoint) = self.consumer_checkpoint(consumer_id, abandoned_at)?;
        if operator_id.trim().is_empty() || reason.trim().is_empty() {
            return Err(KernelError::InvalidInput);
        }
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
        let audit_owner_id = consumer_id.text.clone();
        self.push_control_change(
            &audit_owner_id,
            "consumer_abandon",
            serde_json::json!({
                "consumer_id": consumer_id.text.clone(),
                "checkpoint_commit_seq": checkpoint,
                "operator_id": operator_id.text.clone(),
                "reason": reason.text.clone(),
                "abandoned_at": abandoned_at,
            }),
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
        if recorded_at < 0 || consumer_id.trim().is_empty() {
            return Err(KernelError::InvalidInput);
        }
        let consumer_id = redact(consumer_id);
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
        object_id: &str,
        kind: &'static str,
        audit: serde_json::Value,
        redactions: Vec<(String, RedactedField)>,
    ) {
        self.changes.push(PendingChange {
            object: ObjectRow {
                object_id: object_id.to_string(),
                object_kind: "outbox_consumer".to_string(),
                domain_id: "kernel-control".to_string(),
                source_kind: "kernel-control".to_string(),
                source_id: object_id.to_string(),
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
    pub fn mark_outbox_published_through(
        &self,
        outbox_position: i64,
        published_at: i64,
    ) -> Result<(), KernelError> {
        if outbox_position < 1 || published_at < 0 {
            return Err(KernelError::InvalidCheckpoint);
        }
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
        if !is_outbox_commit_boundary(&tx, outbox_position)? {
            return Err(KernelError::InvalidCheckpoint);
        }
        tx.execute(
            "UPDATE outbox SET published_at=COALESCE(published_at,?1)
             WHERE outbox_position<=?2",
            params![published_at, outbox_position],
        )
        .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)
    }

    pub fn acknowledge_outbox(
        &self,
        consumer_id: &str,
        checkpoint_commit_seq: i64,
        updated_at: i64,
    ) -> Result<(), KernelError> {
        if consumer_id.trim().is_empty() || checkpoint_commit_seq < 0 || updated_at < 0 {
            return Err(KernelError::InvalidCheckpoint);
        }
        let consumer_id = redact(consumer_id);
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
        let current = tx
            .query_row(
                "SELECT checkpoint_commit_seq FROM outbox_consumers WHERE consumer_id=?1",
                [consumer_id.text.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| KernelError::Io)?
            .ok_or(KernelError::NotFound)?;
        let tip = tx
            .query_row(
                "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| KernelError::Io)?;
        let is_existing_commit = checkpoint_commit_seq == current
            || tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM commit_log WHERE commit_seq=?1)",
                    [checkpoint_commit_seq],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| KernelError::Io)?;
        if checkpoint_commit_seq < current || checkpoint_commit_seq > tip || !is_existing_commit {
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

    pub fn prune_outbox(&self) -> Result<OutboxPruneResult, KernelError> {
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
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

fn is_outbox_commit_boundary(
    tx: &rusqlite::Transaction<'_>,
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
