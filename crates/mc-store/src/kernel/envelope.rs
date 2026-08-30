use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::redaction::{clear_owner_kind, identity, record, redact, RedactedField};
use super::{map_sqlite, KernelError, KernelStore};
use crate::current_time_ms;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Sensitivity {
    Normal,
    Sensitive,
}

impl Sensitivity {
    fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Sensitive => "sensitive",
        }
    }

    /// Any stored class other than `normal` reads back as `Sensitive`, so an unknown or legacy vocabulary fails closed. commentlint: allow(JUDGE)
    fn from_stored(value: &str) -> Self {
        match value {
            "normal" => Self::Normal,
            _ => Self::Sensitive,
        }
    }
}

/// `producer` and `operation_key` form the dedup key, so `commit` rejects either one carrying a detected secret. commentlint: allow(JUDGE)
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

/// `domain_id` and `object_id` are stored verbatim and rejected when they carry a detected secret; remaining text fields are redacted. commentlint: allow(JUDGE)
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

const DOMAIN_OBJECT_KIND: &str = "domain";

struct PendingChange {
    object: ObjectRow,
    kind: &'static str,
    replaced_object_id: Option<String>,
    redactions: Vec<(String, RedactedField)>,
}

#[derive(Serialize)]
struct ChangePayload<'a> {
    change_kind: &'a str,
    object: &'a ObjectRow,
    replaced_object_id: Option<&'a str>,
}

pub struct Envelope<'tx> {
    tx: &'tx Transaction<'tx>,
    commit_seq: i64,
    changes: Vec<PendingChange>,
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
        });
        Ok(())
    }

    /// `replaced_object_id` addresses a row, so a detected secret in it is rejected rather than redacted. commentlint: allow(JUDGE)
    pub fn correct_domain(
        &mut self,
        replaced_object_id: &str,
        replacement: DomainSpec,
    ) -> Result<(), KernelError> {
        let replaced = identity(replaced_object_id)?;
        let replacement = RedactedDomain::new(replacement)?;
        self.invalidate_domain(&replaced)?;
        insert_domain(self.tx, self.commit_seq, &replacement)?;
        self.set_domain_successor(&replaced, &replacement.object_id)?;
        self.changes.push(PendingChange {
            object: replacement.object_row(self.commit_seq),
            kind: "correct",
            replaced_object_id: Some(replaced),
            redactions: replacement.text_fields(),
        });
        Ok(())
    }

    /// `object_id` addresses a row, so a detected secret in it is rejected rather than redacted. commentlint: allow(JUDGE)
    pub fn retire_domain(&mut self, object_id: &str) -> Result<(), KernelError> {
        let object_id = identity(object_id)?;
        let mut object = self.invalidate_domain(&object_id)?;
        object.invalidated_commit_seq = Some(self.commit_seq);
        self.changes.push(PendingChange {
            object,
            kind: "retire",
            replaced_object_id: None,
            redactions: Vec::new(),
        });
        Ok(())
    }

    /// Both updates require exactly one affected row, so `object_registry` and `domains` cannot diverge on a non-domain object. commentlint: allow(JUDGE)
    fn invalidate_domain(&self, object_id: &str) -> Result<ObjectRow, KernelError> {
        let object = load_object(self.tx, object_id)?.ok_or(KernelError::NotFound)?;
        if object.object_kind != DOMAIN_OBJECT_KIND {
            return Err(KernelError::InvalidInput);
        }
        let registry = self
            .tx
            .execute(
                "UPDATE object_registry SET invalidated_commit_seq=?1
                 WHERE object_id=?2 AND object_kind=?3 AND invalidated_commit_seq IS NULL",
                params![self.commit_seq, object_id, DOMAIN_OBJECT_KIND],
            )
            .map_err(map_sqlite)?;
        let domains = self
            .tx
            .execute(
                "UPDATE domains SET invalidated_commit_seq=?1
                 WHERE object_id=?2 AND invalidated_commit_seq IS NULL",
                params![self.commit_seq, object_id],
            )
            .map_err(map_sqlite)?;
        if registry != 1 || domains != 1 {
            return Err(KernelError::NotFound);
        }
        Ok(object)
    }

    fn set_domain_successor(
        &self,
        replaced_object_id: &str,
        successor_object_id: &str,
    ) -> Result<(), KernelError> {
        let registry = self
            .tx
            .execute(
                "UPDATE object_registry SET superseded_by=?1
                 WHERE object_id=?2 AND object_kind=?3",
                params![successor_object_id, replaced_object_id, DOMAIN_OBJECT_KIND],
            )
            .map_err(map_sqlite)?;
        let domains = self
            .tx
            .execute(
                "UPDATE domains SET superseded_by=?1 WHERE object_id=?2",
                params![successor_object_id, replaced_object_id],
            )
            .map_err(map_sqlite)?;
        if registry != 1 || domains != 1 {
            return Err(KernelError::NotFound);
        }
        Ok(())
    }
}

impl KernelStore {
    /// `operation` runs while this thread holds the writer mutex inside an `IMMEDIATE` transaction: calling back into this store deadlocks, blocking work extends the single-writer window, and a reader opened inside it cannot see the in-flight write. commentlint: allow(JUDGE)
    pub fn commit(
        &self,
        intent: CommitIntent,
        operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
    ) -> Result<CommitReceipt, KernelError> {
        self.commit_inner(intent, operation, || Ok(()))
    }

    #[cfg(feature = "test-support")]
    pub fn commit_with_fault_after_events_for_test(
        &self,
        intent: CommitIntent,
        operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
    ) -> Result<CommitReceipt, KernelError> {
        self.commit_inner(intent, operation, || Err(KernelError::Fault))
    }

    fn commit_inner(
        &self,
        intent: CommitIntent,
        operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
        after_events: impl FnOnce() -> Result<(), KernelError>,
    ) -> Result<CommitReceipt, KernelError> {
        let intent = RedactedIntent::new(intent)?;
        let transaction_id = operation_identity(&intent);
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite)?;
        check_fence(&tx, self.lease_epoch())?;

        if let Some((digest, commit_seq, result)) = tx
            .query_row(
                "SELECT request_digest,commit_seq,result_payload FROM operation_receipts
                 WHERE producer=?1 AND operation_key=?2",
                params![intent.producer, intent.operation_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sqlite)?
        {
            if digest != intent.request_digest {
                return Err(KernelError::Conflict);
            }
            tx.commit().map_err(map_sqlite)?;
            return Ok(CommitReceipt {
                commit_seq,
                result,
                replayed: true,
            });
        }

        let recorded_at = current_time_ms();
        tx.execute(
            "INSERT INTO commit_log(
                 transaction_id,writer_epoch,producer,operation_key,request_digest,
                 recorded_at,actor,cause
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                transaction_id,
                i64::try_from(self.lease_epoch()).map_err(|_| KernelError::InvalidInput)?,
                intent.producer,
                intent.operation_key,
                intent.request_digest,
                recorded_at,
                intent.actor.text,
                intent.cause.text,
            ],
        )
        .map_err(map_sqlite)?;
        let commit_seq = tx.last_insert_rowid();
        intent.record(&tx, &transaction_id, commit_seq)?;

        let mut envelope = Envelope {
            tx: &tx,
            commit_seq,
            changes: Vec::new(),
        };
        let result = operation(&mut envelope)?;
        let result = redact(&result);

        let payloads = envelope
            .changes
            .iter()
            .map(|change| {
                serde_json::to_vec(&ChangePayload {
                    change_kind: change.kind,
                    object: &change.object,
                    replaced_object_id: change.replaced_object_id.as_deref(),
                })
                .map_err(|_| KernelError::InvalidInput)
            })
            .collect::<Result<Vec<_>, _>>()?;

        for (index, change) in envelope.changes.iter().enumerate() {
            let ordinal = i64::try_from(index).map_err(|_| KernelError::InvalidInput)?;
            let event_id = format!("{commit_seq}:{ordinal}");
            tx.execute(
                "INSERT INTO change_event(
                     commit_seq,ordinal,object_id,change_kind,idempotency_key,payload
                 ) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    commit_seq,
                    ordinal,
                    change.object.object_id,
                    change.kind,
                    intent.operation_key,
                    payloads[index],
                ],
            )
            .map_err(map_sqlite)?;
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
        }
        after_events()?;
        for (index, change) in envelope.changes.iter().enumerate() {
            let ordinal = i64::try_from(index).map_err(|_| KernelError::InvalidInput)?;
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
                    payloads[index],
                    recorded_at,
                ],
            )
            .map_err(map_sqlite)?;
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
                intent.producer,
                intent.operation_key,
                intent.request_digest,
                commit_seq,
                result.text,
                recorded_at,
            ],
        )
        .map_err(map_sqlite)?;
        record(
            &tx,
            "operation_receipt",
            &transaction_id,
            "result_payload",
            &result,
            Some(commit_seq),
        )?;
        tx.commit().map_err(map_sqlite)?;
        Ok(CommitReceipt {
            commit_seq,
            result: result.text,
            replayed: false,
        })
    }

    /// `invalidated_commit_seq` and `superseded_by` are always `None` here, because a row this snapshot returns is by definition not yet invalidated. commentlint: allow(JUDGE)
    pub fn known_as_of(&self, requested: i64) -> Result<KnownAsOf, KernelError> {
        self.snapshot(
            requested,
            "SELECT object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                    created_commit_seq,NULL,NULL,sensitivity_class
             FROM object_registry
             WHERE created_commit_seq<=?1
               AND (invalidated_commit_seq IS NULL OR ?1<invalidated_commit_seq)
             ORDER BY object_id",
        )
    }

    /// Every object created by `requested`, exposing only the invalidation metadata `requested` already knew. commentlint: allow(JUDGE)
    pub fn object_history_as_of(&self, requested: i64) -> Result<KnownAsOf, KernelError> {
        self.snapshot(
            requested,
            "SELECT object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                    created_commit_seq,
                    CASE WHEN invalidated_commit_seq<=?1 THEN invalidated_commit_seq END,
                    CASE WHEN invalidated_commit_seq<=?1 THEN superseded_by END,
                    sensitivity_class
             FROM object_registry
             WHERE created_commit_seq<=?1
             ORDER BY object_id",
        )
    }

    fn snapshot(&self, requested: i64, sql: &str) -> Result<KnownAsOf, KernelError> {
        if requested < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut reader = self.lock_reader()?;
        let tx = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(map_sqlite)?;
        let tip = tx
            .query_row(
                "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(map_sqlite)?;
        if requested > tip {
            return Err(KernelError::FutureSnapshot);
        }
        let mut statement = tx.prepare(sql).map_err(map_sqlite)?;
        let objects = statement
            .query_map([requested], object_row_from)
            .map_err(map_sqlite)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(map_sqlite)?;
        drop(statement);
        tx.commit().map_err(map_sqlite)?;
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
        let sensitivity = spec.sensitivity();
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite)?;
        check_fence(&tx, self.lease_epoch())?;
        let provenance = spec.provenance_json()?;
        let run_metadata = spec.run_detection_json()?;
        let existing = tx
            .query_row(
                "SELECT extractor,source_kind,source_id,source_revision,sensitivity_class,
                        provenance_witness
                 FROM extraction_runs WHERE extraction_run_id=?1",
                [spec.extraction_run_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Vec<u8>>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sqlite)?;
        if let Some(existing) = existing {
            let expected = (
                spec.extractor.text.clone(),
                Some(spec.source_kind.text.clone()),
                Some(spec.source_id.text.clone()),
                Some(spec.source_revision),
                sensitivity.as_str().to_string(),
                provenance.clone(),
            );
            if existing != expected {
                return Err(KernelError::Conflict);
            }
            tx.execute(
                "UPDATE extraction_runs
                 SET heartbeat_at=MAX(heartbeat_at,?1),lease_expires_at=MAX(lease_expires_at,?2)
                 WHERE extraction_run_id=?3",
                params![
                    spec.recorded_at,
                    spec.lease_expires_at,
                    spec.extraction_run_id
                ],
            )
            .map_err(map_sqlite)?;
        } else {
            tx.execute(
                "INSERT INTO extraction_runs(
                     extraction_run_id,extractor,source_kind,source_id,source_revision,
                     sensitivity_class,provenance_witness,redaction_metadata,started_at,
                     heartbeat_at,lease_expires_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10)",
                params![
                    spec.extraction_run_id,
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
            .map_err(map_sqlite)?;
            spec.record_run(&tx)?;
        }
        let candidate_metadata = spec.candidate_detection_json()?;
        tx.execute(
            "INSERT INTO candidates(
                 candidate_id,extraction_run_id,candidate_kind,payload,sensitivity_class,
                 provenance_witness,redaction_metadata,created_at,heartbeat_at,lease_expires_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,?9)",
            params![
                spec.candidate_id,
                spec.extraction_run_id,
                spec.candidate_kind.text,
                spec.payload.text,
                sensitivity.as_str(),
                provenance,
                candidate_metadata,
                spec.recorded_at,
                spec.lease_expires_at,
            ],
        )
        .map_err(map_sqlite)?;
        spec.record(&tx)?;
        tx.commit().map_err(map_sqlite)?;
        Ok(StagingCandidateRow {
            candidate_id: spec.candidate_id,
            payload: spec.payload.text,
            sensitivity,
        })
    }

    /// A truncate-then-insert rebuild, not an upsert; an empty `rows` is rejected so erasing the projection is always deliberate. commentlint: allow(JUDGE)
    pub fn replace_alignment_projection(
        &self,
        rows: &[AlignmentProjectionSpec],
    ) -> Result<usize, KernelError> {
        if rows.is_empty() {
            return Err(KernelError::InvalidInput);
        }
        let rows = rows
            .iter()
            .map(RedactedProjection::new)
            .collect::<Result<Vec<_>, _>>()?;
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite)?;
        check_fence(&tx, self.lease_epoch())?;
        tx.execute("DELETE FROM alignment_projection", [])
            .map_err(map_sqlite)?;
        clear_owner_kind(&tx, "alignment_projection")?;
        for row in &rows {
            tx.execute(
                "INSERT INTO alignment_projection(
                     decision_id,observation_id,alignment_kind,alignment_payload,
                     built_through_commit_seq
                 ) VALUES (?1,?2,?3,?4,?5)",
                params![
                    row.decision_id,
                    row.observation_id,
                    row.alignment_kind.text,
                    row.alignment_payload.as_ref().map(|field| &field.text),
                    row.built_through_commit_seq,
                ],
            )
            .map_err(map_sqlite)?;
            row.record(&tx)?;
        }
        tx.commit().map_err(map_sqlite)?;
        Ok(rows.len())
    }
}

struct RedactedIntent {
    producer: String,
    operation_key: String,
    request_digest: String,
    actor: RedactedField,
    cause: RedactedField,
}

impl RedactedIntent {
    fn new(intent: CommitIntent) -> Result<Self, KernelError> {
        if !mc_core::claim_operation::is_lower_hex(&intent.request_digest, 64) {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            producer: identity(&intent.producer)?,
            operation_key: identity(&intent.operation_key)?,
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
        for (name, field) in [("actor", &self.actor), ("cause", &self.cause)] {
            record(tx, "commit_log", owner_id, name, field, Some(commit_seq))?;
        }
        Ok(())
    }
}

struct RedactedDomain {
    domain_id: String,
    object_id: String,
    name: RedactedField,
    source_kind: RedactedField,
    source_id: RedactedField,
    source_revision: i64,
    sensitivity: Sensitivity,
}

impl RedactedDomain {
    fn new(spec: DomainSpec) -> Result<Self, KernelError> {
        if spec.source_revision < 0
            || spec.domain_id.trim().is_empty()
            || spec.object_id.trim().is_empty()
            || spec.name.trim().is_empty()
            || spec.source_kind.trim().is_empty()
            || spec.source_id.trim().is_empty()
        {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            domain_id: identity(&spec.domain_id)?,
            object_id: identity(&spec.object_id)?,
            name: redact(&spec.name),
            source_kind: redact(&spec.source_kind),
            source_id: redact(&spec.source_id),
            source_revision: spec.source_revision,
            sensitivity: spec.sensitivity,
        })
    }

    fn object_row(&self, commit_seq: i64) -> ObjectRow {
        ObjectRow {
            object_id: self.object_id.clone(),
            object_kind: DOMAIN_OBJECT_KIND.to_string(),
            domain_id: self.domain_id.clone(),
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
            spec.domain_id,
            spec.object_id,
            spec.name.text,
            commit_seq,
            spec.sensitivity.as_str(),
        ],
    )
    .map_err(map_sqlite)?;
    tx.execute(
        "INSERT INTO object_registry(
             object_id,object_kind,domain_id,source_kind,source_id,source_revision,
             created_commit_seq,sensitivity_class
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            spec.object_id,
            DOMAIN_OBJECT_KIND,
            spec.domain_id,
            spec.source_kind.text,
            spec.source_id.text,
            spec.source_revision,
            commit_seq,
            spec.sensitivity.as_str(),
        ],
    )
    .map_err(map_sqlite)?;
    for (name, field) in [
        ("name", &spec.name),
        ("source_kind", &spec.source_kind),
        ("source_id", &spec.source_id),
    ] {
        record(
            tx,
            "object_registry",
            &spec.object_id,
            name,
            field,
            Some(commit_seq),
        )?;
    }
    Ok(())
}

fn object_row_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<ObjectRow> {
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
}

fn load_object(tx: &Transaction<'_>, object_id: &str) -> Result<Option<ObjectRow>, KernelError> {
    tx.query_row(
        "SELECT object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                created_commit_seq,NULL,NULL,sensitivity_class
         FROM object_registry WHERE object_id=?1 AND invalidated_commit_seq IS NULL",
        [object_id],
        object_row_from,
    )
    .optional()
    .map_err(map_sqlite)
}

struct RedactedCandidate {
    extraction_run_id: String,
    candidate_id: String,
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
            || spec.extraction_run_id.trim().is_empty()
            || spec.candidate_id.trim().is_empty()
        {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            extraction_run_id: identity(&spec.extraction_run_id)?,
            candidate_id: identity(&spec.candidate_id)?,
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

    /// Repository provenance alone does not clear a payload, so a detected secret in any field escalates the class. commentlint: allow(JUDGE)
    fn sensitivity(&self) -> Sensitivity {
        let detected = self
            .candidate_fields()
            .into_iter()
            .chain(self.run_fields())
            .any(|(_, field)| !field.detections.is_empty());
        if self.provenance.is_some() && !detected {
            Sensitivity::Normal
        } else {
            Sensitivity::Sensitive
        }
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
            source_utf8_offset: usize,
            source_utf8_length: usize,
        }
        let metadata = fields
            .into_iter()
            .flat_map(|(name, field)| {
                field.detections.iter().map(move |detection| Metadata {
                    field: name,
                    detector_id: detection.detector_id,
                    secret_type: &detection.secret_type,
                    source_utf8_offset: detection.offset,
                    source_utf8_length: detection.length,
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
                &self.extraction_run_id,
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
                &self.candidate_id,
                name,
                field,
                None,
            )?;
        }
        Ok(())
    }
}

struct RedactedProjection {
    decision_id: String,
    observation_id: String,
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
            decision_id: identity(&spec.decision_id)?,
            observation_id: identity(&spec.observation_id)?,
            alignment_kind: redact(&spec.alignment_kind),
            alignment_payload: spec.alignment_payload.as_deref().map(redact),
            built_through_commit_seq: spec.built_through_commit_seq,
        })
    }

    /// Length-prefixing keeps distinct id pairs from sharing one owner_id when an id contains the separator. commentlint: allow(JUDGE)
    fn owner_id(&self) -> String {
        format!(
            "{}:{}:{}",
            self.decision_id.len(),
            self.decision_id,
            self.observation_id
        )
    }

    fn record(&self, tx: &Transaction<'_>) -> Result<(), KernelError> {
        let owner_id = self.owner_id();
        record(
            tx,
            "alignment_projection",
            &owner_id,
            "alignment_kind",
            &self.alignment_kind,
            None,
        )?;
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

fn check_fence(tx: &Transaction<'_>, expected: u64) -> Result<(), KernelError> {
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

/// Length-prefixing each component keeps two distinct field splits from sharing one preimage. commentlint: allow(JUDGE)
fn operation_identity(intent: &RedactedIntent) -> String {
    let mut hash = Sha256::new();
    hash.update(b"mc-kernel-operation-v2\0");
    for component in [
        intent.producer.as_str(),
        intent.operation_key.as_str(),
        intent.request_digest.as_str(),
    ] {
        hash.update(
            u64::try_from(component.len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
        hash.update(component.as_bytes());
    }
    format!("{:x}", hash.finalize())
}
