use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::envelope::{check_fence, Envelope, ObjectRow, PendingChange, Sensitivity};
use super::redaction::{redact, RedactedField};
use super::{KernelError, KernelStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboxPruneResult {
    pub horizon: i64,
    pub deleted: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumerAbandonment {
    pub operator_id: String,
    pub reason: String,
    pub abandoned_at: i64,
    pub barrier_id: Option<String>,
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
        // A missing `outbox_consumers` row counts as checkpoint -1, below every
        // `required_checkpoint_commit_seq`, so barriers settle before the delete.
        complete_satisfied_barriers(self.tx, recorded_at)?;
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
        abandonment: ConsumerAbandonment,
    ) -> Result<(), KernelError> {
        let (consumer_id, checkpoint) =
            self.consumer_checkpoint(consumer_id, abandonment.abandoned_at)?;
        if abandonment.operator_id.trim().is_empty() || abandonment.reason.trim().is_empty() {
            return Err(KernelError::InvalidInput);
        }
        let operator_id = redact(&abandonment.operator_id);
        let reason = redact(&abandonment.reason);
        let barrier_id = abandonment.barrier_id.as_deref().map(redact);
        if let Some(barrier_id) = &barrier_id {
            let recorded: bool = self
                .tx
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM deletion_backfill_barrier_consumers
                         WHERE barrier_id=?1 AND consumer_id=?2
                     )",
                    params![barrier_id.text, consumer_id.text],
                    |row| row.get(0),
                )
                .map_err(|_| KernelError::Io)?;
            if !recorded {
                return Err(KernelError::NotFound);
            }
        }
        let abandonment_id = format!("{}:{}", self.commit_seq, consumer_id.text);
        // Deleting `outbox_consumers` removes the consumer checkpoint. Record one
        // abandonment per blocked barrier so each can still satisfy its
        // `required_checkpoint_commit_seq`.
        let recorded = self
            .tx
            .execute(
                "INSERT INTO consumer_abandonments(
                     abandonment_id,consumer_id,barrier_id,operator_id,
                     last_checkpoint_commit_seq,reason,abandoned_at,commit_seq
                 )
                 SELECT ?1 || ':' || bc.barrier_id,?2,bc.barrier_id,?3,?4,?5,?6,?7
                 FROM deletion_backfill_barrier_consumers bc
                 JOIN deletion_backfill_barriers b USING(barrier_id)
                 WHERE bc.consumer_id=?2
                   AND (b.completed_at IS NULL OR b.barrier_id=?8)",
                params![
                    abandonment_id,
                    consumer_id.text,
                    operator_id.text,
                    checkpoint,
                    reason.text,
                    abandonment.abandoned_at,
                    self.commit_seq,
                    barrier_id.as_ref().map(|value| value.text.as_str()),
                ],
            )
            .map_err(|_| KernelError::Io)?;
        if recorded == 0 {
            self.tx
                .execute(
                    "INSERT INTO consumer_abandonments(
                         abandonment_id,consumer_id,barrier_id,operator_id,
                         last_checkpoint_commit_seq,reason,abandoned_at,commit_seq
                     ) VALUES (?1,?2,NULL,?3,?4,?5,?6,?7)",
                    params![
                        abandonment_id,
                        consumer_id.text,
                        operator_id.text,
                        checkpoint,
                        reason.text,
                        abandonment.abandoned_at,
                        self.commit_seq,
                    ],
                )
                .map_err(|_| KernelError::Io)?;
        }
        self.tx
            .execute(
                "DELETE FROM outbox_consumers WHERE consumer_id=?1",
                [consumer_id.text.as_str()],
            )
            .map_err(|_| KernelError::Io)?;
        let audit_owner_id = consumer_id.text.clone();
        complete_satisfied_barriers(self.tx, abandonment.abandoned_at)?;
        self.push_control_change(
            &audit_owner_id,
            "consumer_abandon",
            serde_json::json!({
                "consumer_id": consumer_id.text.clone(),
                "checkpoint_commit_seq": checkpoint,
                "operator_id": operator_id.text.clone(),
                "reason": reason.text.clone(),
                "abandoned_at": abandonment.abandoned_at,
                "barrier_id": barrier_id.as_ref().map(|value| value.text.clone()),
            }),
            vec![
                ("consumer_id".to_string(), consumer_id),
                ("operator_id".to_string(), operator_id),
                ("reason".to_string(), reason),
            ],
        );
        Ok(())
    }

    pub fn abandon_deletion_barrier(
        &mut self,
        barrier_id: &str,
        operator_id: &str,
        reason: &str,
        abandoned_at: i64,
    ) -> Result<(), KernelError> {
        if barrier_id.trim().is_empty()
            || operator_id.trim().is_empty()
            || reason.trim().is_empty()
            || abandoned_at < 0
        {
            return Err(KernelError::InvalidInput);
        }
        let barrier_id = redact(barrier_id);
        let operator_id = redact(operator_id);
        let reason = redact(reason);
        let consumer_count: i64 = self
            .tx
            .query_row(
                "SELECT COUNT(*) FROM deletion_backfill_barrier_consumers WHERE barrier_id=?1",
                [&barrier_id.text],
                |row| row.get(0),
            )
            .map_err(|_| KernelError::Io)?;
        if consumer_count != 0 {
            return Err(KernelError::Conflict);
        }
        if self
            .tx
            .execute(
                "UPDATE deletion_backfill_barriers SET completed_at=?1
                 WHERE barrier_id=?2 AND completed_at IS NULL",
                params![abandoned_at, barrier_id.text],
            )
            .map_err(|_| KernelError::Io)?
            != 1
        {
            return Err(KernelError::NotFound);
        }
        let audit_owner_id = barrier_id.text.clone();
        self.push_control_change(
            &audit_owner_id,
            "deletion_barrier_abandon",
            serde_json::json!({
                "barrier_id": barrier_id.text.clone(),
                "operator_id": operator_id.text.clone(),
                "reason": reason.text.clone(),
                "abandoned_at": abandoned_at,
            }),
            vec![
                ("barrier_id".to_string(), barrier_id),
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
        complete_satisfied_barriers(&tx, updated_at)?;
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

fn complete_satisfied_barriers(
    tx: &rusqlite::Transaction<'_>,
    completed_at: i64,
) -> Result<(), KernelError> {
    tx.execute(
        "UPDATE deletion_backfill_barriers AS b SET completed_at=?1
         WHERE b.completed_at IS NULL
           AND EXISTS(
               SELECT 1 FROM deletion_backfill_barrier_consumers bc
               WHERE bc.barrier_id=b.barrier_id
           )
           AND NOT EXISTS(
               SELECT 1 FROM deletion_backfill_barrier_consumers bc
               LEFT JOIN outbox_consumers c USING(consumer_id)
               WHERE bc.barrier_id=b.barrier_id
                 AND COALESCE(c.checkpoint_commit_seq,-1)<bc.required_checkpoint_commit_seq
                 AND NOT EXISTS(
                     SELECT 1 FROM consumer_abandonments a
                     WHERE a.barrier_id=bc.barrier_id AND a.consumer_id=bc.consumer_id
                       AND a.commit_seq>=bc.required_checkpoint_commit_seq
                 )
           )",
        params![completed_at],
    )
    .map_err(|_| KernelError::Io)?;
    Ok(())
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
