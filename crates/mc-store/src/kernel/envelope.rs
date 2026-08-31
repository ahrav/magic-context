use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::redaction::{record, redact, RedactedField};
use super::{KernelError, KernelStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Sensitivity {
    Normal,
    Sensitive,
    Secret,
}

impl Sensitivity {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Sensitive => "sensitive",
            Self::Secret => "secret",
        }
    }

    pub(super) fn from_stored(value: &str) -> Self {
        match value {
            "normal" => Self::Normal,
            "secret" => Self::Secret,
            "sensitive" | "internal" => Self::Sensitive,
            _ => Self::Sensitive,
        }
    }

    pub(super) fn restrictive(self, other: Self) -> Self {
        match (self, other) {
            (Self::Secret, _) | (_, Self::Secret) => Self::Secret,
            (Self::Sensitive, _) | (_, Self::Sensitive) => Self::Sensitive,
            _ => Self::Normal,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitIntent {
    pub producer: String,
    pub operation_key: String,
    pub request_digest: String,
    pub actor: String,
    pub cause: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitReceipt {
    pub commit_seq: i64,
    pub result: String,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainSpec {
    pub domain_id: String,
    pub object_id: String,
    pub name: String,
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: i64,
    pub sensitivity: Sensitivity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ObjectRow {
    pub object_id: String,
    pub object_kind: String,
    pub domain_id: String,
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: i64,
    pub created_commit_seq: i64,
    pub invalidated_commit_seq: Option<i64>,
    pub superseded_by: Option<String>,
    pub sensitivity: Sensitivity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownAsOf {
    pub known_as_of: i64,
    pub tip: i64,
    pub objects: Vec<ObjectRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryProvenance {
    pub repository_id: String,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagingCandidateSpec {
    pub extraction_run_id: String,
    pub candidate_id: String,
    pub extractor: String,
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: i64,
    pub candidate_kind: String,
    pub payload: String,
    pub provenance: Option<RepositoryProvenance>,
    pub recorded_at: i64,
    pub lease_expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagingCandidateRow {
    pub candidate_id: String,
    pub payload: String,
    pub sensitivity: Sensitivity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlignmentProjectionSpec {
    pub decision_id: String,
    pub observation_id: String,
    pub alignment_kind: String,
    pub alignment_payload: Option<String>,
    pub built_through_commit_seq: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectionReplaceResult {
    pub rows: usize,
}

pub const OPERATOR_REDACTION_PLACEHOLDER: &str = "[redacted:operator]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemediationTarget {
    CanonicalDomainName { object_id: String },
}

#[cfg(feature = "test-support")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitFault {
    None,
    AfterEvents,
}

pub(super) struct PendingChange {
    pub(super) object: ObjectRow,
    pub(super) kind: &'static str,
    pub(super) replaced_object_id: Option<String>,
    pub(super) redactions: Vec<(String, RedactedField)>,
    pub(super) audit: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct ChangePayload<'a> {
    change_kind: &'a str,
    object: &'a ObjectRow,
    replaced_object_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audit: Option<&'a serde_json::Value>,
}

pub struct Envelope<'tx> {
    pub(super) tx: &'tx Transaction<'tx>,
    pub(super) commit_seq: i64,
    pub(super) changes: Vec<PendingChange>,
}

impl Envelope<'_> {
    pub fn insert_domain(&mut self, spec: DomainSpec) -> Result<(), KernelError> {
        let spec = RedactedDomain::new(spec)?;
        insert_domain(self.tx, self.commit_seq, &spec)?;
        self.changes.push(PendingChange {
            object: spec.object_row(self.commit_seq),
            kind: "insert",
            replaced_object_id: None,
            redactions: spec.text_fields(),
            audit: None,
        });
        Ok(())
    }

    pub fn correct_domain(
        &mut self,
        replaced_object_id: &str,
        replacement: DomainSpec,
    ) -> Result<(), KernelError> {
        let replaced = redact(replaced_object_id);
        let replacement = RedactedDomain::new(replacement)?;
        let changed = self
            .tx
            .execute(
                "UPDATE object_registry SET invalidated_commit_seq=?1
                 WHERE object_id=?2 AND invalidated_commit_seq IS NULL",
                params![self.commit_seq, replaced.text],
            )
            .map_err(|_| KernelError::Io)?;
        if changed != 1 {
            return Err(KernelError::NotFound);
        }
        self.tx
            .execute(
                "UPDATE domains SET invalidated_commit_seq=?1
                 WHERE object_id=?2 AND invalidated_commit_seq IS NULL",
                params![self.commit_seq, replaced.text],
            )
            .map_err(|_| KernelError::Io)?;
        record(
            self.tx,
            "change_event",
            &replaced.text,
            "replaced_object_id",
            &replaced,
            Some(self.commit_seq),
        )?;
        insert_domain(self.tx, self.commit_seq, &replacement)?;
        self.tx
            .execute(
                "UPDATE object_registry SET superseded_by=?1 WHERE object_id=?2",
                params![replacement.object_id.text, replaced.text],
            )
            .map_err(|_| KernelError::Io)?;
        self.tx
            .execute(
                "UPDATE domains SET superseded_by=?1 WHERE object_id=?2",
                params![replacement.object_id.text, replaced.text],
            )
            .map_err(|_| KernelError::Io)?;
        self.changes.push(PendingChange {
            object: replacement.object_row(self.commit_seq),
            kind: "correct",
            replaced_object_id: Some(replaced.text),
            redactions: replacement.text_fields(),
            audit: None,
        });
        Ok(())
    }

    pub fn retire_domain(&mut self, object_id: &str) -> Result<(), KernelError> {
        let object_id = redact(object_id);
        let mut object = load_object(self.tx, &object_id.text)?.ok_or(KernelError::NotFound)?;
        let changed = self
            .tx
            .execute(
                "UPDATE object_registry SET invalidated_commit_seq=?1
                 WHERE object_id=?2 AND invalidated_commit_seq IS NULL",
                params![self.commit_seq, object_id.text],
            )
            .map_err(|_| KernelError::Io)?;
        if changed != 1 {
            return Err(KernelError::NotFound);
        }
        self.tx
            .execute(
                "UPDATE domains SET invalidated_commit_seq=?1
                 WHERE object_id=?2 AND invalidated_commit_seq IS NULL",
                params![self.commit_seq, object_id.text],
            )
            .map_err(|_| KernelError::Io)?;
        record(
            self.tx,
            "change_event",
            &object_id.text,
            "retired_object_id",
            &object_id,
            Some(self.commit_seq),
        )?;
        object.invalidated_commit_seq = Some(self.commit_seq);
        self.changes.push(PendingChange {
            object,
            kind: "retire",
            replaced_object_id: None,
            redactions: vec![("object_id".to_string(), object_id)],
            audit: None,
        });
        Ok(())
    }

    pub fn remediate_text(
        &mut self,
        target: RemediationTarget,
        operator_id: &str,
        remediated_at: i64,
    ) -> Result<(), KernelError> {
        if operator_id.trim().is_empty() || remediated_at < 0 {
            return Err(KernelError::InvalidInput);
        }
        let operator_id = redact(operator_id);
        match target {
            RemediationTarget::CanonicalDomainName { object_id } => {
                let object_id = redact(&object_id);
                let object = load_object(self.tx, &object_id.text)?.ok_or(KernelError::NotFound)?;
                if object.object_kind != "domain"
                    || self
                        .tx
                        .execute(
                            "UPDATE domains SET name=?1 WHERE object_id=?2",
                            params![OPERATOR_REDACTION_PLACEHOLDER, object_id.text],
                        )
                        .map_err(|_| KernelError::Io)?
                        != 1
                {
                    return Err(KernelError::NotFound);
                }
                let audit = serde_json::json!({
                    "target": "canonical_domain_name",
                    "target_object_id": object_id.text.clone(),
                    "operator_id": operator_id.text.clone(),
                    "remediated_at": remediated_at,
                    "replacement": OPERATOR_REDACTION_PLACEHOLDER,
                });
                self.changes.push(PendingChange {
                    object,
                    kind: "operator_remediation",
                    replaced_object_id: None,
                    redactions: vec![
                        ("object_id".to_string(), object_id),
                        ("operator_id".to_string(), operator_id.clone()),
                    ],
                    audit: Some(audit.clone()),
                });
            }
        }
        Ok(())
    }
}

impl KernelStore {
    pub fn commit(
        &self,
        intent: CommitIntent,
        operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
    ) -> Result<CommitReceipt, KernelError> {
        self.commit_inner(intent, operation, false)
    }

    #[cfg(feature = "test-support")]
    pub fn commit_with_fault_for_test(
        &self,
        intent: CommitIntent,
        fault: CommitFault,
        operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
    ) -> Result<CommitReceipt, KernelError> {
        self.commit_inner(intent, operation, fault == CommitFault::AfterEvents)
    }

    fn commit_inner(
        &self,
        intent: CommitIntent,
        operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
        fault_after_events: bool,
    ) -> Result<CommitReceipt, KernelError> {
        let mut writer = self.lock_writer()?;
        commit_with_writer(
            &mut writer,
            self.lease_epoch(),
            intent,
            operation,
            fault_after_events,
        )
    }
}

pub(super) fn commit_with_writer(
    writer: &mut rusqlite::Connection,
    lease_epoch: u64,
    intent: CommitIntent,
    operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
    fault_after_events: bool,
) -> Result<CommitReceipt, KernelError> {
    let intent = RedactedIntent::new(intent)?;
    let transaction_id = operation_identity(&intent);
    let tx = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| KernelError::Io)?;
    check_fence(&tx, lease_epoch)?;

    if let Some((digest, commit_seq, result)) = tx
        .query_row(
            "SELECT request_digest,commit_seq,result_payload FROM operation_receipts
                 WHERE producer=?1 AND operation_key=?2",
            params![intent.producer.text, intent.operation_key.text],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| KernelError::Io)?
    {
        if digest != intent.request_digest {
            return Err(KernelError::Conflict);
        }
        let repair_alignment = commit_affects_alignment(&tx, commit_seq)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        if repair_alignment {
            // The commit is already durable, so a repair failure cannot change its outcome.
            let _ = super::slice::rebuild_alignment_with_writer(writer, lease_epoch);
        }
        return Ok(CommitReceipt {
            commit_seq,
            result,
            replayed: true,
        });
    }

    tx.execute(
        "INSERT INTO commit_log(
                 transaction_id,writer_epoch,producer,operation_key,request_digest,
                 recorded_at,actor,cause
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            transaction_id,
            i64::try_from(lease_epoch).map_err(|_| KernelError::InvalidInput)?,
            intent.producer.text,
            intent.operation_key.text,
            intent.request_digest,
            current_time_ms(),
            intent.actor.text,
            intent.cause.text,
        ],
    )
    .map_err(|_| KernelError::Io)?;
    let commit_seq = tx.last_insert_rowid();
    intent.record(&tx, &transaction_id, commit_seq)?;

    let mut envelope = Envelope {
        tx: &tx,
        commit_seq,
        changes: Vec::new(),
    };
    let result = operation(&mut envelope)?;
    let rebuild_alignment = envelope.changes.iter().any(change_affects_alignment);
    let result = redact(&result);

    for (ordinal, change) in envelope.changes.iter().enumerate() {
        let ordinal = i64::try_from(ordinal).map_err(|_| KernelError::InvalidInput)?;
        let event_id = format!("{commit_seq}:{ordinal}");
        let payload = ChangePayload {
            change_kind: change.kind,
            object: &change.object,
            replaced_object_id: change.replaced_object_id.as_deref(),
            audit: change.audit.as_ref(),
        };
        tx.execute(
            "INSERT INTO change_event(
                     commit_seq,ordinal,object_id,change_kind,idempotency_key,payload
                 ) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                commit_seq,
                ordinal,
                change.object.object_id,
                change.kind,
                intent.operation_key.text,
                serde_json::to_vec(&payload).map_err(|_| KernelError::InvalidInput)?,
            ],
        )
        .map_err(|_| KernelError::Io)?;
        for (name, field) in &change.redactions {
            record(
                &tx,
                "change_event",
                &event_id,
                name,
                field,
                Some(commit_seq),
            )?;
        }
        record(
            &tx,
            "change_event",
            &event_id,
            "operation_key",
            &intent.operation_key,
            Some(commit_seq),
        )?;
    }
    if fault_after_events {
        return Err(KernelError::Fault);
    }
    for (ordinal, change) in envelope.changes.iter().enumerate() {
        let ordinal = i64::try_from(ordinal).map_err(|_| KernelError::InvalidInput)?;
        let payload = serde_json::to_vec(&ChangePayload {
            change_kind: change.kind,
            object: &change.object,
            replaced_object_id: change.replaced_object_id.as_deref(),
            audit: change.audit.as_ref(),
        })
        .map_err(|_| KernelError::InvalidInput)?;
        tx.execute(
            "INSERT INTO outbox(
                     commit_seq,ordinal,object_id,object_kind,source_kind,source_id,
                     source_revision,sensitivity_class,payload,created_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                commit_seq,
                ordinal,
                change.object.object_id,
                change.object.object_kind,
                change.object.source_kind,
                change.object.source_id,
                change.object.source_revision,
                change.object.sensitivity.as_str(),
                payload,
                current_time_ms(),
            ],
        )
        .map_err(|_| KernelError::Io)?;
        let outbox_position = tx.last_insert_rowid().to_string();
        for (name, field) in &change.redactions {
            record(
                &tx,
                "outbox",
                &outbox_position,
                name,
                field,
                Some(commit_seq),
            )?;
        }
    }
    tx.execute(
            "INSERT INTO operation_receipts(
                 receipt_id,producer,operation_key,request_digest,commit_seq,result_payload,created_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                transaction_id,
                intent.producer.text,
                intent.operation_key.text,
                intent.request_digest,
                commit_seq,
                result.text,
                current_time_ms(),
            ],
        )
        .map_err(|_| KernelError::Io)?;
    record(
        &tx,
        "operation_receipt",
        &transaction_id,
        "result_payload",
        &result,
        Some(commit_seq),
    )?;
    if rebuild_alignment {
        super::slice::rebuild_alignment_tx(&tx)?;
    }
    tx.commit().map_err(|_| KernelError::Io)?;
    Ok(CommitReceipt {
        commit_seq,
        result: result.text,
        replayed: false,
    })
}

/// Single source for the pending-change and replay checks below, so a kind added
/// here cannot reach only one of them.
const ALIGNMENT_CHANGE_KINDS: &[&str] = &[
    "decision_insert",
    "observation_insert",
    "decision_correct",
    "observation_correct",
    "decision_retire",
    "observation_retire",
    "artifact_deletion",
];

fn change_affects_alignment(change: &PendingChange) -> bool {
    ALIGNMENT_CHANGE_KINDS.contains(&change.kind)
}

fn commit_affects_alignment(tx: &Transaction<'_>, commit_seq: i64) -> Result<bool, KernelError> {
    let kinds = serde_json::to_string(ALIGNMENT_CHANGE_KINDS).map_err(|_| KernelError::Io)?;
    tx.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM change_event
             WHERE commit_seq=?1
               AND change_kind IN (SELECT value FROM json_each(?2))
         )",
        params![commit_seq, kinds],
        |row| row.get(0),
    )
    .map_err(|_| KernelError::Io)
}

impl KernelStore {
    pub fn known_as_of(&self, requested: i64) -> Result<KnownAsOf, KernelError> {
        if requested < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut reader = self.lock_reader()?;
        let tx = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| KernelError::Io)?;
        let tip = tx
            .query_row(
                "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| KernelError::Io)?;
        if requested > tip {
            return Err(KernelError::FutureSnapshot);
        }
        let mut statement = tx
            .prepare(
                "SELECT object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                        created_commit_seq,sensitivity_class
                 FROM object_registry
                 WHERE created_commit_seq<=?1
                   AND (invalidated_commit_seq IS NULL OR ?1<invalidated_commit_seq)
                 ORDER BY object_id",
            )
            .map_err(|_| KernelError::Io)?;
        let objects = statement
            .query_map([requested], |row| {
                let sensitivity: String = row.get(7)?;
                Ok(ObjectRow {
                    object_id: row.get(0)?,
                    object_kind: row.get(1)?,
                    domain_id: row.get(2)?,
                    source_kind: row.get(3)?,
                    source_id: row.get(4)?,
                    source_revision: row.get(5)?,
                    created_commit_seq: row.get(6)?,
                    invalidated_commit_seq: None,
                    superseded_by: None,
                    sensitivity: Sensitivity::from_stored(&sensitivity),
                })
            })
            .map_err(|_| KernelError::Io)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| KernelError::Io)?;
        drop(statement);
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(KnownAsOf {
            known_as_of: requested,
            tip,
            objects,
        })
    }

    pub fn object_history_as_of(&self, requested: i64) -> Result<KnownAsOf, KernelError> {
        if requested < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut reader = self.lock_reader()?;
        let tx = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| KernelError::Io)?;
        let tip = tx
            .query_row(
                "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| KernelError::Io)?;
        if requested > tip {
            return Err(KernelError::FutureSnapshot);
        }
        let mut statement = tx
            .prepare(
                "SELECT object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                        created_commit_seq,
                        CASE WHEN invalidated_commit_seq<=?1 THEN invalidated_commit_seq END,
                        CASE WHEN invalidated_commit_seq<=?1 THEN superseded_by END,
                        sensitivity_class
                 FROM object_registry
                 WHERE created_commit_seq<=?1
                 ORDER BY object_id",
            )
            .map_err(|_| KernelError::Io)?;
        let objects = statement
            .query_map([requested], |row| {
                let sensitivity: String = row.get(9)?;
                Ok(ObjectRow {
                    object_id: row.get(0)?,
                    object_kind: row.get(1)?,
                    domain_id: row.get(2)?,
                    source_kind: row.get(3)?,
                    source_id: row.get(4)?,
                    source_revision: row.get(5)?,
                    created_commit_seq: row.get(6)?,
                    invalidated_commit_seq: row.get(7)?,
                    superseded_by: row.get(8)?,
                    sensitivity: Sensitivity::from_stored(&sensitivity),
                })
            })
            .map_err(|_| KernelError::Io)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| KernelError::Io)?;
        drop(statement);
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(KnownAsOf {
            known_as_of: requested,
            tip,
            objects,
        })
    }

    pub fn stage_candidate(
        &self,
        spec: StagingCandidateSpec,
    ) -> Result<StagingCandidateRow, KernelError> {
        let spec = RedactedCandidate::new(spec)?;
        let sensitivity = if spec.provenance.is_some() {
            Sensitivity::Normal
        } else {
            Sensitivity::Sensitive
        };
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
        let provenance = spec.provenance_json()?;
        let run_metadata = spec.run_detection_json()?;
        let existing = tx
            .query_row(
                "SELECT extractor,source_kind,source_id,source_revision,sensitivity_class,
                        provenance_witness,redaction_metadata
                 FROM extraction_runs WHERE extraction_run_id=?1",
                [spec.extraction_run_id.text.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Vec<u8>>(5)?,
                        row.get::<_, Vec<u8>>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| KernelError::Io)?;
        if let Some(existing) = existing {
            let expected = (
                spec.extractor.text.clone(),
                Some(spec.source_kind.text.clone()),
                Some(spec.source_id.text.clone()),
                Some(spec.source_revision),
                sensitivity.as_str().to_string(),
                provenance.clone(),
                run_metadata.clone(),
            );
            if existing != expected {
                return Err(KernelError::Conflict);
            }
            if tx
                .execute(
                    "UPDATE extraction_runs
                 SET heartbeat_at=MAX(heartbeat_at,?1),lease_expires_at=MAX(lease_expires_at,?2)
                 WHERE extraction_run_id=?3 AND terminal_state IS NULL",
                    params![
                        spec.recorded_at,
                        spec.lease_expires_at,
                        spec.extraction_run_id.text
                    ],
                )
                .map_err(|_| KernelError::Io)?
                != 1
            {
                return Err(KernelError::Conflict);
            }
        } else {
            tx.execute(
                "INSERT INTO extraction_runs(
                     extraction_run_id,extractor,source_kind,source_id,source_revision,
                     sensitivity_class,provenance_witness,redaction_metadata,started_at,
                     heartbeat_at,lease_expires_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10)",
                params![
                    spec.extraction_run_id.text,
                    spec.extractor.text,
                    spec.source_kind.text,
                    spec.source_id.text,
                    spec.source_revision,
                    sensitivity.as_str(),
                    provenance,
                    run_metadata,
                    spec.recorded_at,
                    spec.lease_expires_at,
                ],
            )
            .map_err(|_| KernelError::Io)?;
            spec.record_run(&tx)?;
        }
        let candidate_metadata = spec.candidate_detection_json()?;
        tx.execute(
            "INSERT INTO candidates(
                 candidate_id,extraction_run_id,candidate_kind,payload,sensitivity_class,
                 provenance_witness,redaction_metadata,created_at,heartbeat_at,lease_expires_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,?9)",
            params![
                spec.candidate_id.text,
                spec.extraction_run_id.text,
                spec.candidate_kind.text,
                spec.payload.text,
                sensitivity.as_str(),
                provenance,
                candidate_metadata,
                spec.recorded_at,
                spec.lease_expires_at,
            ],
        )
        .map_err(|_| KernelError::Io)?;
        spec.record(&tx)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(StagingCandidateRow {
            candidate_id: spec.candidate_id.text,
            payload: spec.payload.text,
            sensitivity,
        })
    }

    pub fn replace_alignment_projection(
        &self,
        rows: &[AlignmentProjectionSpec],
    ) -> Result<ProjectionReplaceResult, KernelError> {
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
        let result = replace_alignment_projection_tx(&tx, rows)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(result)
    }
}

pub(super) fn replace_alignment_projection_tx(
    tx: &Transaction<'_>,
    rows: &[AlignmentProjectionSpec],
) -> Result<ProjectionReplaceResult, KernelError> {
    let rows = rows
        .iter()
        .map(RedactedProjection::new)
        .collect::<Result<Vec<_>, _>>()?;
    tx.execute(
        "DELETE FROM durable_text_redactions WHERE owner_kind='alignment_projection'",
        [],
    )
    .map_err(|_| KernelError::Io)?;
    tx.execute("DELETE FROM alignment_projection", [])
        .map_err(|_| KernelError::Io)?;
    {
        let mut statement = tx
            .prepare(
                "INSERT INTO alignment_projection(
                     decision_id,observation_id,alignment_kind,alignment_payload,
                     built_through_commit_seq
                 ) VALUES (?1,?2,?3,?4,?5)",
            )
            .map_err(|_| KernelError::Io)?;
        for row in &rows {
            statement
                .execute(params![
                    row.decision_id.text,
                    row.observation_id.text,
                    row.alignment_kind.text,
                    row.alignment_payload.as_ref().map(|field| &field.text),
                    row.built_through_commit_seq,
                ])
                .map_err(|_| KernelError::Io)?;
        }
    }
    for row in &rows {
        row.record(tx)?;
    }
    Ok(ProjectionReplaceResult { rows: rows.len() })
}

struct RedactedIntent {
    producer: RedactedField,
    operation_key: RedactedField,
    request_digest: String,
    actor: RedactedField,
    cause: RedactedField,
}

impl RedactedIntent {
    fn new(intent: CommitIntent) -> Result<Self, KernelError> {
        if !is_lower_hex(&intent.request_digest, 64) {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            producer: redact(&intent.producer),
            operation_key: redact(&intent.operation_key),
            request_digest: intent.request_digest,
            actor: redact(&intent.actor),
            cause: redact(&intent.cause),
        })
    }

    fn record(
        &self,
        tx: &Transaction<'_>,
        owner_id: &str,
        commit_seq: i64,
    ) -> Result<(), KernelError> {
        for (name, field) in [
            ("producer", &self.producer),
            ("operation_key", &self.operation_key),
            ("actor", &self.actor),
            ("cause", &self.cause),
        ] {
            record(tx, "commit_log", owner_id, name, field, Some(commit_seq))?;
        }
        Ok(())
    }
}

struct RedactedDomain {
    domain_id: RedactedField,
    object_id: RedactedField,
    name: RedactedField,
    source_kind: RedactedField,
    source_id: RedactedField,
    source_revision: i64,
    sensitivity: Sensitivity,
}

impl RedactedDomain {
    fn new(spec: DomainSpec) -> Result<Self, KernelError> {
        if spec.source_revision < 0 {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            domain_id: redact(&spec.domain_id),
            object_id: redact(&spec.object_id),
            name: redact(&spec.name),
            source_kind: redact(&spec.source_kind),
            source_id: redact(&spec.source_id),
            source_revision: spec.source_revision,
            sensitivity: spec.sensitivity,
        })
    }

    fn object_row(&self, commit_seq: i64) -> ObjectRow {
        ObjectRow {
            object_id: self.object_id.text.clone(),
            object_kind: "domain".to_string(),
            domain_id: self.domain_id.text.clone(),
            source_kind: self.source_kind.text.clone(),
            source_id: self.source_id.text.clone(),
            source_revision: self.source_revision,
            created_commit_seq: commit_seq,
            invalidated_commit_seq: None,
            superseded_by: None,
            sensitivity: self.sensitivity,
        }
    }

    fn text_fields(&self) -> Vec<(String, RedactedField)> {
        vec![
            ("domain_id".to_string(), self.domain_id.clone()),
            ("object_id".to_string(), self.object_id.clone()),
            ("name".to_string(), self.name.clone()),
            ("source_kind".to_string(), self.source_kind.clone()),
            ("source_id".to_string(), self.source_id.clone()),
        ]
    }
}

fn insert_domain(
    tx: &Transaction<'_>,
    commit_seq: i64,
    spec: &RedactedDomain,
) -> Result<(), KernelError> {
    tx.execute(
        "INSERT INTO domains(
             domain_id,object_id,name,created_commit_seq,sensitivity_class
         ) VALUES (?1,?2,?3,?4,?5)",
        params![
            spec.domain_id.text,
            spec.object_id.text,
            spec.name.text,
            commit_seq,
            spec.sensitivity.as_str(),
        ],
    )
    .map_err(|_| KernelError::Io)?;
    tx.execute(
        "INSERT INTO object_registry(
             object_id,object_kind,domain_id,source_kind,source_id,source_revision,
             created_commit_seq,sensitivity_class
         ) VALUES (?1,'domain',?2,?3,?4,?5,?6,?7)",
        params![
            spec.object_id.text,
            spec.domain_id.text,
            spec.source_kind.text,
            spec.source_id.text,
            spec.source_revision,
            commit_seq,
            spec.sensitivity.as_str(),
        ],
    )
    .map_err(|_| KernelError::Io)?;
    for (name, field) in [
        ("domain_id", &spec.domain_id),
        ("object_id", &spec.object_id),
        ("name", &spec.name),
        ("source_kind", &spec.source_kind),
        ("source_id", &spec.source_id),
    ] {
        record(
            tx,
            "object_registry",
            &spec.object_id.text,
            name,
            field,
            Some(commit_seq),
        )?;
    }
    Ok(())
}

fn load_object(tx: &Transaction<'_>, object_id: &str) -> Result<Option<ObjectRow>, KernelError> {
    tx.query_row(
        "SELECT object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                created_commit_seq,sensitivity_class
         FROM object_registry WHERE object_id=?1 AND invalidated_commit_seq IS NULL",
        [object_id],
        |row| {
            let sensitivity: String = row.get(7)?;
            Ok(ObjectRow {
                object_id: row.get(0)?,
                object_kind: row.get(1)?,
                domain_id: row.get(2)?,
                source_kind: row.get(3)?,
                source_id: row.get(4)?,
                source_revision: row.get(5)?,
                created_commit_seq: row.get(6)?,
                invalidated_commit_seq: None,
                superseded_by: None,
                sensitivity: Sensitivity::from_stored(&sensitivity),
            })
        },
    )
    .optional()
    .map_err(|_| KernelError::Io)
}

struct RedactedCandidate {
    extraction_run_id: RedactedField,
    candidate_id: RedactedField,
    extractor: RedactedField,
    source_kind: RedactedField,
    source_id: RedactedField,
    source_revision: i64,
    candidate_kind: RedactedField,
    payload: RedactedField,
    provenance: Option<(RedactedField, RedactedField)>,
    recorded_at: i64,
    lease_expires_at: i64,
}

impl RedactedCandidate {
    fn new(spec: StagingCandidateSpec) -> Result<Self, KernelError> {
        if spec.source_revision < 0
            || spec.recorded_at < 0
            || spec.lease_expires_at < spec.recorded_at
            || spec.lease_expires_at > spec.recorded_at.saturating_add(60 * 60 * 1_000)
        {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            extraction_run_id: redact(&spec.extraction_run_id),
            candidate_id: redact(&spec.candidate_id),
            extractor: redact(&spec.extractor),
            source_kind: redact(&spec.source_kind),
            source_id: redact(&spec.source_id),
            source_revision: spec.source_revision,
            candidate_kind: redact(&spec.candidate_kind),
            payload: redact(&spec.payload),
            provenance: spec
                .provenance
                .filter(|value| {
                    !value.repository_id.trim().is_empty() && !value.revision.trim().is_empty()
                })
                .map(|value| (redact(&value.repository_id), redact(&value.revision))),
            recorded_at: spec.recorded_at,
            lease_expires_at: spec.lease_expires_at,
        })
    }

    fn provenance_json(&self) -> Result<Vec<u8>, KernelError> {
        match &self.provenance {
            Some((repository_id, revision)) => serde_json::to_vec(&serde_json::json!({
                "kind": "repository",
                "repository_id": repository_id.text,
                "revision": revision.text,
            })),
            None => serde_json::to_vec(&serde_json::json!({"kind": "unclassified"})),
        }
        .map_err(|_| KernelError::InvalidInput)
    }

    fn run_fields(&self) -> Vec<(&'static str, &RedactedField)> {
        let mut fields = vec![
            ("extraction_run_id", &self.extraction_run_id),
            ("extractor", &self.extractor),
            ("source_kind", &self.source_kind),
            ("source_id", &self.source_id),
        ];
        if let Some((repository_id, revision)) = &self.provenance {
            fields.push(("repository_id", repository_id));
            fields.push(("revision", revision));
        }
        fields
    }

    fn candidate_fields(&self) -> Vec<(&'static str, &RedactedField)> {
        vec![
            ("candidate_id", &self.candidate_id),
            ("extraction_run_id", &self.extraction_run_id),
            ("candidate_kind", &self.candidate_kind),
            ("payload", &self.payload),
        ]
    }

    fn detection_json(
        &self,
        fields: Vec<(&'static str, &RedactedField)>,
    ) -> Result<Vec<u8>, KernelError> {
        #[derive(Serialize)]
        struct Metadata<'a> {
            field: &'a str,
            detector_id: &'a str,
            secret_type: &'a str,
            utf8_offset: usize,
            utf8_length: usize,
        }
        let metadata = fields
            .into_iter()
            .flat_map(|(name, field)| {
                field.detections.iter().map(move |detection| Metadata {
                    field: name,
                    detector_id: detection.detector_id,
                    secret_type: &detection.secret_type,
                    utf8_offset: detection.offset,
                    utf8_length: detection.length,
                })
            })
            .collect::<Vec<_>>();
        serde_json::to_vec(&metadata).map_err(|_| KernelError::InvalidInput)
    }

    fn run_detection_json(&self) -> Result<Vec<u8>, KernelError> {
        self.detection_json(self.run_fields())
    }

    fn candidate_detection_json(&self) -> Result<Vec<u8>, KernelError> {
        self.detection_json(self.candidate_fields())
    }

    fn record_run(&self, tx: &Transaction<'_>) -> Result<(), KernelError> {
        for (name, field) in self.run_fields() {
            record(
                tx,
                "extraction_run",
                &self.extraction_run_id.text,
                name,
                field,
                None,
            )?;
        }
        Ok(())
    }

    fn record(&self, tx: &Transaction<'_>) -> Result<(), KernelError> {
        for (name, field) in self.candidate_fields() {
            record(
                tx,
                "staging_candidate",
                &self.candidate_id.text,
                name,
                field,
                None,
            )?;
        }
        Ok(())
    }
}

struct RedactedProjection {
    decision_id: RedactedField,
    observation_id: RedactedField,
    alignment_kind: RedactedField,
    alignment_payload: Option<RedactedField>,
    built_through_commit_seq: i64,
}

impl RedactedProjection {
    fn new(spec: &AlignmentProjectionSpec) -> Result<Self, KernelError> {
        if spec.built_through_commit_seq < 1 {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            decision_id: redact(&spec.decision_id),
            observation_id: redact(&spec.observation_id),
            alignment_kind: redact(&spec.alignment_kind),
            alignment_payload: spec.alignment_payload.as_deref().map(redact),
            built_through_commit_seq: spec.built_through_commit_seq,
        })
    }

    fn record(&self, tx: &Transaction<'_>) -> Result<(), KernelError> {
        let owner_id = format!("{}:{}", self.decision_id.text, self.observation_id.text);
        for (name, field) in [
            ("decision_id", &self.decision_id),
            ("observation_id", &self.observation_id),
            ("alignment_kind", &self.alignment_kind),
        ] {
            record(tx, "alignment_projection", &owner_id, name, field, None)?;
        }
        if let Some(payload) = &self.alignment_payload {
            record(
                tx,
                "alignment_projection",
                &owner_id,
                "alignment_payload",
                payload,
                None,
            )?;
        }
        Ok(())
    }
}

pub(super) fn check_fence(tx: &Transaction<'_>, expected: u64) -> Result<(), KernelError> {
    let durable: i64 = tx
        .query_row(
            "SELECT writer_epoch FROM writer_fence WHERE id=0",
            [],
            |row| row.get(0),
        )
        .map_err(|_| KernelError::FenceLost)?;
    if u64::try_from(durable).ok() != Some(expected) {
        return Err(KernelError::FenceLost);
    }
    Ok(())
}

fn operation_identity(intent: &RedactedIntent) -> String {
    let mut hash = Sha256::new();
    hash.update(b"mc-kernel-operation-v1\0");
    hash.update(intent.producer.text.as_bytes());
    hash.update(b"\0");
    hash.update(intent.operation_key.text.as_bytes());
    hash.update(b"\0");
    hash.update(intent.request_digest.as_bytes());
    format!("{:x}", hash.finalize())
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
