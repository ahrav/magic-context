use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::redaction::{clear_owner, clear_owner_kind, identity, record, redact, RedactedField};
use super::{map_sqlite, KernelError, KernelStore};
use crate::current_time_ms;

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

    /// An unrecognized stored class resolves to `Secret`, the strictest handling.
    pub(super) fn from_stored(value: &str) -> Self {
        match value {
            "normal" => Self::Normal,
            "sensitive" => Self::Sensitive,
            _ => Self::Secret,
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

/// `producer` and `operation_key` form the dedup key, so `commit` rejects either one carrying a detected secret.
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

const DOMAIN_OBJECT_KIND: &str = "domain";
/// R4 caps an active staging lease at one hour past its last heartbeat.
pub(super) const MAX_STAGING_LEASE_MS: i64 = 3_600_000;
/// A caller-supplied heartbeat may lead the store clock only by this much, which
/// stays small against the lease cap so a future timestamp cannot extend the
/// reaper boundary.
const MAX_STAGING_CLOCK_SKEW_MS: i64 = 60_000;

pub const OPERATOR_REDACTION_PLACEHOLDER: &str = super::schema::operator_redaction_placeholder!();

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RemediationTarget {
    CanonicalDomainName { object_id: String },
}

pub(super) struct PendingChange {
    pub(super) object: ObjectRow,
    pub(super) kind: &'static str,
    pub(super) replaced_object_id: Option<String>,
    pub(super) redactions: Vec<(String, RedactedField)>,
    /// Operator-supplied context for changes whose object row does not carry it.
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
    poisoned: Option<KernelError>,
}

impl Envelope<'_> {
    /// A mutation can fail after writing part of its rows, and a caller may discard that `Err`. Recording it here lets `commit` refuse a transaction whose change set no longer describes its writes.
    pub(super) fn poison<T>(&mut self, result: Result<T, KernelError>) -> Result<T, KernelError> {
        if let Err(error) = &result {
            self.poisoned = Some(*error);
        }
        result
    }

    pub fn insert_domain(&mut self, spec: DomainSpec) -> Result<(), KernelError> {
        if let Some(error) = self.poisoned {
            return Err(error);
        }
        let outcome = self.insert_domain_inner(spec);
        self.poison(outcome)
    }

    fn insert_domain_inner(&mut self, spec: DomainSpec) -> Result<(), KernelError> {
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

    /// `replaced_object_id` selects the row to supersede, so redacting it could resolve a different object.
    pub fn correct_domain(
        &mut self,
        replaced_object_id: &str,
        replacement: DomainSpec,
    ) -> Result<(), KernelError> {
        if let Some(error) = self.poisoned {
            return Err(error);
        }
        let outcome = self.correct_domain_inner(replaced_object_id, replacement);
        self.poison(outcome)
    }

    fn correct_domain_inner(
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
            audit: None,
        });
        Ok(())
    }

    /// `object_id` selects the row to retire, so redacting it could resolve a different object.
    /// A prior failure is recorded, so a caller that discarded an `Err` cannot commit a change set that no longer describes its writes.
    pub(super) fn already_poisoned(&self) -> Option<KernelError> {
        self.poisoned
    }

    pub fn retire_domain(&mut self, object_id: &str) -> Result<(), KernelError> {
        if let Some(error) = self.poisoned {
            return Err(error);
        }
        let outcome = self.retire_domain_inner(object_id);
        self.poison(outcome)
    }

    fn retire_domain_inner(&mut self, object_id: &str) -> Result<(), KernelError> {
        let object_id = identity(object_id)?;
        let mut object = self.invalidate_domain(&object_id)?;
        object.invalidated_commit_seq = Some(self.commit_seq);
        self.changes.push(PendingChange {
            object,
            kind: "retire",
            replaced_object_id: None,
            redactions: Vec::new(),
            audit: None,
        });
        Ok(())
    }

    /// # Errors
    ///
    /// - Returns [`KernelError::InvalidInput`] when `operator_id` is empty, `remediated_at` is negative, or the target is not a domain.
    /// - Returns [`KernelError::NotFound`] when no object carries the id.
    pub fn remediate_text(
        &mut self,
        target: RemediationTarget,
        operator_id: &str,
        remediated_at: i64,
    ) -> Result<(), KernelError> {
        if let Some(error) = self.poisoned {
            return Err(error);
        }
        let outcome = self.remediate_text_inner(target, operator_id, remediated_at);
        self.poison(outcome)
    }

    fn remediate_text_inner(
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
                let object_id = identity(&object_id)?;
                // A retired or corrected domain keeps its plaintext name, so remediation must reach invalidated rows.
                let object = load_object_any_generation(self.tx, &object_id)?
                    .ok_or(KernelError::NotFound)?;
                if object.object_kind != DOMAIN_OBJECT_KIND {
                    return Err(KernelError::InvalidInput);
                }
                // `name<>?1` skips already-redacted domains; repeat remediation appends only an audit record.
                let rewritten = self
                    .tx
                    .execute(
                        "UPDATE domains SET name=?1 WHERE object_id=?2 AND name<>?1",
                        params![OPERATOR_REDACTION_PLACEHOLDER, object_id],
                    )
                    .map_err(map_sqlite)?;
                if rewritten == 0 && !domain_name_is_redacted(self.tx, &object_id)? {
                    return Err(KernelError::NotFound);
                }
                let audit = serde_json::json!({
                    "target": "canonical_domain_name",
                    "target_object_id": object_id,
                    "operator_id": operator_id.text.clone(),
                    "remediated_at": remediated_at,
                    "replacement": OPERATOR_REDACTION_PLACEHOLDER,
                });
                self.changes.push(PendingChange {
                    object,
                    kind: "operator_remediation",
                    replaced_object_id: None,
                    redactions: vec![("operator_id".to_string(), operator_id)],
                    audit: Some(audit),
                });
            }
        }
        Ok(())
    }

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
    /// `operation` holds the writer mutex for an `IMMEDIATE` transaction. Re-entering the store deadlocks; blocking work extends the single-writer window; readers opened within `operation` cannot observe uncommitted writes.
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
        commit_prepared_with_writer(
            &mut writer,
            self.lease_epoch(),
            intent,
            transaction_id,
            operation,
            after_events,
        )
    }

    /// `invalidated_commit_seq` and `superseded_by` are `None` for every returned row; `object_history_as_of` reads those columns.
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

    /// Invalidation columns are masked past `requested`, so a later correction stays invisible to an earlier snapshot.
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
        let run_sensitivity = spec.run_sensitivity();
        let candidate_sensitivity = spec.candidate_sensitivity();
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite)?;
        check_fence(&tx, self.lease_epoch())?;
        let provenance = spec.provenance_json()?;
        let existing = tx
            .query_row(
                "SELECT extractor,source_kind,source_id,source_revision,sensitivity_class,
                        provenance_witness,terminal_state,lease_expires_at,heartbeat_at
                 FROM extraction_runs WHERE extraction_run_id=?1",
                [spec.extraction_run_id.as_str()],
                |row| {
                    Ok((
                        (
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, Vec<u8>>(5)?,
                        ),
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sqlite)?;
        if let Some((stored_identity, terminal_state, lease_expires_at, heartbeat_at)) = existing {
            let expected = (
                spec.extractor.clone(),
                Some(spec.source_kind.clone()),
                Some(spec.source_id.clone()),
                Some(spec.source_revision),
                run_sensitivity.as_str().to_string(),
                provenance.clone(),
            );
            // An out-of-order producer inside the lease but behind the heartbeat would still
            // extend the run through the MAX assignments below.
            if stored_identity != expected
                || terminal_state.is_some()
                || lease_expires_at <= spec.recorded_at
                || lease_expires_at <= current_time_ms()
                // The store clock decides liveness, but an out-of-order producer inside a
                // live lease could still extend it from behind the heartbeat.
                || heartbeat_at > spec.recorded_at
            {
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
                    spec.extractor,
                    spec.source_kind,
                    spec.source_id,
                    spec.source_revision,
                    run_sensitivity.as_str(),
                    provenance,
                    b"[]".to_vec(),
                    spec.recorded_at,
                    spec.lease_expires_at,
                ],
            )
            .map_err(map_sqlite)?;
        }
        let existing_candidate = tx
            .query_row(
                "SELECT extraction_run_id,sensitivity_class,candidate_kind,payload,
                        redaction_metadata,terminal_state
                 FROM candidates WHERE candidate_id=?1",
                [spec.candidate_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Vec<u8>>(3)?,
                        row.get::<_, Vec<u8>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sqlite)?;
        if let Some((
            run_id,
            stored_class,
            stored_kind,
            stored_payload,
            stored_metadata,
            candidate_terminal,
        )) = existing_candidate
        {
            let incoming_redacted = self_detections(&spec);
            if run_id != spec.extraction_run_id
                || stored_class != candidate_sensitivity.as_str()
                || stored_kind != spec.candidate_kind.text
                || candidate_terminal.is_some()
                || incoming_redacted
                || stored_had_detections(&stored_metadata)
                || stored_payload != spec.payload.text.as_bytes()
            {
                return Err(KernelError::Conflict);
            }
            tx.execute(
                "UPDATE candidates
                 SET heartbeat_at=MAX(heartbeat_at,?1),lease_expires_at=MAX(lease_expires_at,?2)
                 WHERE candidate_id=?3",
                params![spec.recorded_at, spec.lease_expires_at, spec.candidate_id],
            )
            .map_err(map_sqlite)?;
            tx.commit().map_err(map_sqlite)?;
            return Ok(StagingCandidateRow {
                candidate_id: spec.candidate_id,
                payload: spec.payload.text,
                sensitivity: candidate_sensitivity,
            });
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
                spec.payload.text.as_bytes(),
                candidate_sensitivity.as_str(),
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
            sensitivity: candidate_sensitivity,
        })
    }

    /// A truncate-then-insert rebuild rather than an upsert. An empty `rows` is rejected so an accidental empty vector cannot erase the projection; `clear_alignment_projection` publishes an intentionally empty rebuild.
    pub fn replace_alignment_projection(
        &self,
        rows: &[AlignmentProjectionSpec],
    ) -> Result<usize, KernelError> {
        if rows.is_empty() {
            return Err(KernelError::InvalidInput);
        }
        let generation = rows[0].built_through_commit_seq;
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite)?;
        check_fence(&tx, self.lease_epoch())?;
        let published = replace_alignment_projection_tx(&tx, generation, rows)?;
        tx.commit().map_err(map_sqlite)?;
        Ok(published)
    }

    /// Publishes an empty rebuild, so a rebuild that produced no alignments can retire the previous rows instead of leaving them queryable.
    pub fn clear_alignment_projection(
        &self,
        built_through_commit_seq: i64,
    ) -> Result<usize, KernelError> {
        if built_through_commit_seq < 1 {
            return Err(KernelError::InvalidInput);
        }
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite)?;
        check_fence(&tx, self.lease_epoch())?;
        let removed = replace_alignment_projection_tx(&tx, built_through_commit_seq, &[])?;
        tx.commit().map_err(map_sqlite)?;
        Ok(removed)
    }
}

/// `generation` is separate from `rows` because an empty rebuild still has to
/// order later replacements. Callers that must reject an empty rebuild validate
/// before calling.
pub(super) fn replace_alignment_projection_tx(
    tx: &Transaction<'_>,
    generation: i64,
    rows: &[AlignmentProjectionSpec],
) -> Result<usize, KernelError> {
    let rows = rows
        .iter()
        .map(RedactedProjection::new)
        .collect::<Result<Vec<_>, _>>()?;
    if rows
        .iter()
        .any(|row| row.built_through_commit_seq != generation)
    {
        return Err(KernelError::InvalidInput);
    }
    guard_projection_generation(tx, generation)?;
    let removed = truncate_alignment_projection(tx)?;
    {
        let mut statement = tx
            .prepare(
                "INSERT INTO alignment_projection(
                     decision_id,observation_id,alignment_kind,alignment_payload,
                     built_through_commit_seq
                 ) VALUES (?1,?2,?3,?4,?5)",
            )
            .map_err(map_sqlite)?;
        for row in &rows {
            statement
                .execute(params![
                    row.decision_id,
                    row.observation_id,
                    row.alignment_kind.text,
                    row.alignment_payload
                        .as_ref()
                        .map(|field| field.text.as_bytes()),
                    row.built_through_commit_seq,
                ])
                .map_err(map_sqlite)?;
        }
    }
    for row in &rows {
        row.record(tx)?;
    }
    record_projection_generation(tx, generation)?;
    if rows.is_empty() {
        return Ok(removed);
    }
    Ok(rows.len())
}

#[allow(clippy::too_many_arguments)]
fn commit_prepared_with_writer(
    writer: &mut Connection,
    lease_epoch: u64,
    intent: RedactedIntent,
    transaction_id: String,
    operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
    after_events: impl FnOnce() -> Result<(), KernelError>,
) -> Result<CommitReceipt, KernelError> {
    let tx = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sqlite)?;
    check_fence(&tx, lease_epoch)?;

    if let Some((digest, commit_seq, result)) = tx
        .query_row(
            "SELECT request_digest,commit_seq,result_payload FROM operation_receipts
             WHERE producer=?1 AND operation_key=?2",
            params![intent.producer, intent.operation_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(map_sqlite)?
    {
        if digest != intent.request_digest {
            return Err(KernelError::Conflict);
        }
        let repair_alignment = commit_affects_alignment(&tx, commit_seq)?;
        tx.commit().map_err(map_sqlite)?;
        if repair_alignment {
            // The commit is already durable, so a repair failure cannot change its outcome.
            let _ = super::slice::rebuild_alignment_with_writer(writer, lease_epoch);
        }
        return Ok(CommitReceipt {
            commit_seq,
            result: String::from_utf8(result).map_err(|_| KernelError::Io)?,
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
            i64::try_from(lease_epoch).map_err(|_| KernelError::InvalidInput)?,
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
        poisoned: None,
    };
    let result = operation(&mut envelope)?;
    if let Some(error) = envelope.poisoned {
        return Err(error);
    }
    let rebuild_alignment = envelope.changes.iter().any(change_affects_alignment);
    let result = redact(&result);

    let payloads = envelope
        .changes
        .iter()
        .map(|change| {
            serde_json::to_vec(&ChangePayload {
                change_kind: change.kind,
                object: &change.object,
                replaced_object_id: change.replaced_object_id.as_deref(),
                audit: change.audit.as_ref(),
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
                transaction_id,
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
            result.text.as_bytes(),
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
    if rebuild_alignment {
        super::slice::rebuild_alignment_tx(&tx)?;
    }
    tx.commit().map_err(map_sqlite)?;
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

pub(super) fn commit_with_writer(
    writer: &mut Connection,
    lease_epoch: u64,
    intent: CommitIntent,
    operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
    after_events: impl FnOnce() -> Result<(), KernelError>,
) -> Result<CommitReceipt, KernelError> {
    let intent = RedactedIntent::new(intent)?;
    let transaction_id = operation_identity(&intent);
    commit_prepared_with_writer(
        writer,
        lease_epoch,
        intent,
        transaction_id,
        operation,
        after_events,
    )
}

/// The watermark is stored apart from the rows, so an empty rebuild still orders later replacements.
fn guard_projection_generation(tx: &Transaction<'_>, generation: i64) -> Result<(), KernelError> {
    let stored: Option<i64> = tx
        .query_row(
            "SELECT built_through_commit_seq FROM alignment_projection_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite)?;
    if stored.is_some_and(|stored| generation < stored) {
        return Err(KernelError::Conflict);
    }
    Ok(())
}

fn record_projection_generation(tx: &Transaction<'_>, generation: i64) -> Result<(), KernelError> {
    tx.execute(
        "INSERT INTO alignment_projection_state(singleton,built_through_commit_seq)
         VALUES (1,?1)
         ON CONFLICT(singleton) DO UPDATE SET built_through_commit_seq=excluded.built_through_commit_seq",
        [generation],
    )
    .map_err(map_sqlite)?;
    Ok(())
}

fn truncate_alignment_projection(tx: &Transaction<'_>) -> Result<usize, KernelError> {
    let removed = tx
        .execute("DELETE FROM alignment_projection", [])
        .map_err(map_sqlite)?;
    clear_owner_kind(tx, "alignment_projection")?;
    Ok(removed)
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
        if !mc_core::claim_operation::is_lower_hex(&intent.request_digest, 64)
            || intent.producer.trim().is_empty()
            || intent.operation_key.trim().is_empty()
        {
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
    name: String,
    source_kind: String,
    source_id: String,
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
        let name = identity(&spec.name)?;
        // The uniqueness index exempts the placeholder so remediated rows stop competing for a name; accepting it as input would let unlimited live domains share one canonical name.
        if name == OPERATOR_REDACTION_PLACEHOLDER {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            domain_id: identity(&spec.domain_id)?,
            object_id: identity(&spec.object_id)?,
            name,
            source_kind: identity(&spec.source_kind)?,
            source_id: identity(&spec.source_id)?,
            source_revision: spec.source_revision,
            sensitivity: spec.sensitivity,
        })
    }

    fn object_row(&self, commit_seq: i64) -> ObjectRow {
        ObjectRow {
            object_id: self.object_id.clone(),
            object_kind: DOMAIN_OBJECT_KIND.to_string(),
            domain_id: self.domain_id.clone(),
            source_kind: self.source_kind.clone(),
            source_id: self.source_id.clone(),
            source_revision: self.source_revision,
            created_commit_seq: commit_seq,
            invalidated_commit_seq: None,
            superseded_by: None,
            sensitivity: self.sensitivity,
        }
    }

    fn text_fields(&self) -> Vec<(String, RedactedField)> {
        Vec::new()
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
            spec.name,
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
            spec.source_kind,
            spec.source_id,
            spec.source_revision,
            commit_seq,
            spec.sensitivity.as_str(),
        ],
    )
    .map_err(map_sqlite)?;
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

fn load_object_any_generation(
    tx: &Transaction<'_>,
    object_id: &str,
) -> Result<Option<ObjectRow>, KernelError> {
    tx.query_row(
        "SELECT object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                created_commit_seq,sensitivity_class,invalidated_commit_seq,superseded_by
         FROM object_registry WHERE object_id=?1",
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
                invalidated_commit_seq: row.get(8)?,
                superseded_by: row.get(9)?,
                sensitivity: Sensitivity::from_stored(&sensitivity),
            })
        },
    )
    .optional()
    .map_err(map_sqlite)
}

fn domain_name_is_redacted(tx: &Transaction<'_>, object_id: &str) -> Result<bool, KernelError> {
    tx.query_row(
        "SELECT name FROM domains WHERE object_id=?1",
        [object_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map(|name| name.is_some_and(|name| name == OPERATOR_REDACTION_PLACEHOLDER))
    .map_err(map_sqlite)
}

struct RedactedCandidate {
    extraction_run_id: String,
    candidate_id: String,
    extractor: String,
    source_kind: String,
    source_id: String,
    source_revision: i64,
    candidate_kind: RedactedField,
    payload: RedactedField,
    provenance: Option<(String, String)>,
    recorded_at: i64,
    lease_expires_at: i64,
}

impl RedactedCandidate {
    fn new(spec: StagingCandidateSpec) -> Result<Self, KernelError> {
        let lease_ceiling = spec
            .recorded_at
            .checked_add(MAX_STAGING_LEASE_MS)
            .ok_or(KernelError::InvalidInput)?;
        let skew_ceiling = current_time_ms()
            .checked_add(MAX_STAGING_CLOCK_SKEW_MS)
            .ok_or(KernelError::InvalidInput)?;
        if spec.source_revision < 0
            || spec.recorded_at < 0
            || spec.recorded_at > skew_ceiling
            || spec.lease_expires_at <= spec.recorded_at
            || spec.lease_expires_at > lease_ceiling
            || spec.extraction_run_id.trim().is_empty()
            || spec.candidate_id.trim().is_empty()
            || spec.extractor.trim().is_empty()
            || spec.source_kind.trim().is_empty()
            || spec.source_id.trim().is_empty()
            || spec.candidate_kind.trim().is_empty()
        {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            extraction_run_id: identity(&spec.extraction_run_id)?,
            candidate_id: identity(&spec.candidate_id)?,
            extractor: identity(&spec.extractor)?,
            source_kind: identity(&spec.source_kind)?,
            source_id: identity(&spec.source_id)?,
            source_revision: spec.source_revision,
            candidate_kind: redact(&spec.candidate_kind),
            payload: redact(&spec.payload),
            provenance: spec
                .provenance
                .filter(|value| {
                    !value.repository_id.trim().is_empty() && !value.revision.trim().is_empty()
                })
                .map(|value| {
                    Ok::<_, KernelError>((
                        identity(&value.repository_id)?,
                        identity(&value.revision)?,
                    ))
                })
                .transpose()?,
            recorded_at: spec.recorded_at,
            lease_expires_at: spec.lease_expires_at,
        })
    }

    fn run_sensitivity(&self) -> Sensitivity {
        if self.provenance.is_some() {
            Sensitivity::Normal
        } else {
            Sensitivity::Sensitive
        }
    }

    /// A vocabulary-covered detection is secret, which is stricter than the
    /// sensitive class that unproven provenance already yields.
    fn candidate_sensitivity(&self) -> Sensitivity {
        let detected = self
            .candidate_fields()
            .into_iter()
            .any(|(_, field)| !field.detections.is_empty());
        if detected {
            Sensitivity::Secret
        } else {
            self.run_sensitivity()
        }
    }

    fn provenance_json(&self) -> Result<Vec<u8>, KernelError> {
        match &self.provenance {
            Some((repository_id, revision)) => serde_json::to_vec(&serde_json::json!({
                "kind": "repository",
                "repository_id": repository_id,
                "revision": revision,
            })),
            None => serde_json::to_vec(&serde_json::json!({"kind": "unclassified"})),
        }
        .map_err(|_| KernelError::InvalidInput)
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

    fn candidate_detection_json(&self) -> Result<Vec<u8>, KernelError> {
        self.detection_json(self.candidate_fields())
    }

    fn record(&self, tx: &Transaction<'_>) -> Result<(), KernelError> {
        clear_owner(tx, "staging_candidate", &self.candidate_id)?;
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
        if spec.built_through_commit_seq < 1
            || spec.alignment_kind.trim().is_empty()
            || spec.decision_id.trim().is_empty()
            || spec.observation_id.trim().is_empty()
        {
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

    /// A bare `decision:observation` join would alias distinct pairs when an id contains the separator.
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

/// A redacted payload is lossy, so an unchanged retry cannot be proven from stored data without keeping secret-derived material.
fn self_detections(spec: &RedactedCandidate) -> bool {
    spec.candidate_fields()
        .into_iter()
        .any(|(_, field)| !field.detections.is_empty())
}

fn stored_had_detections(metadata: &[u8]) -> bool {
    match legacy_detections(metadata) {
        Some(entries) => !entries.is_empty(),
        None => true,
    }
}

/// Reads the detection array from the current bare-array form or the parent build's `{request_digest, detections}` object.
fn legacy_detections(metadata: &[u8]) -> Option<Vec<serde_json::Value>> {
    let value: serde_json::Value = serde_json::from_slice(metadata).ok()?;
    match value {
        serde_json::Value::Array(entries) => Some(entries),
        serde_json::Value::Object(fields) => match fields.get("detections") {
            Some(serde_json::Value::Array(entries)) => Some(entries.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Rewrites any candidate metadata still carrying the parent build's digest, which is an offline verifier for the redacted payload.
///
/// `candidates` is bounded only by retention, so the rewrite runs in committed
/// batches rather than loading the table into one transaction. `secure_delete`
/// zeroes the freed pages and the WAL is truncated afterwards, which shrinks the
/// residue but does not by itself prove the old bytes are unrecoverable.
pub(super) fn strip_legacy_candidate_verifiers(
    conn: &mut rusqlite::Connection,
) -> Result<usize, KernelError> {
    const BATCH: usize = 256;
    let restore_secure_delete: i64 = conn
        .query_row("PRAGMA secure_delete", [], |row| row.get(0))
        .map_err(map_sqlite)?;
    conn.pragma_update(None, "secure_delete", "ON")
        .map_err(map_sqlite)?;
    let mut rewritten = 0;
    loop {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite)?;
        let mut statement = tx
            .prepare(
                "SELECT candidate_id,redaction_metadata FROM candidates
                 WHERE substr(CAST(redaction_metadata AS TEXT),1,1)='{'
                 LIMIT ?1",
            )
            .map_err(map_sqlite)?;
        let batch = statement
            .query_map([i64::try_from(BATCH).unwrap_or(i64::MAX)], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(map_sqlite)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(map_sqlite)?;
        drop(statement);
        if batch.is_empty() {
            tx.commit().map_err(map_sqlite)?;
            break;
        }
        for (candidate_id, metadata) in &batch {
            let detections = legacy_detections(metadata).unwrap_or_default();
            let replacement = serde_json::to_vec(&detections).map_err(|_| KernelError::Io)?;
            tx.execute(
                "UPDATE candidates SET redaction_metadata=?1 WHERE candidate_id=?2",
                params![replacement, candidate_id],
            )
            .map_err(map_sqlite)?;
        }
        rewritten += batch.len();
        tx.commit().map_err(map_sqlite)?;
    }
    if rewritten > 0 {
        conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")
            .map_err(map_sqlite)?;
    }
    conn.pragma_update(
        None,
        "secure_delete",
        if restore_secure_delete == 0 {
            "OFF"
        } else {
            "ON"
        },
    )
    .map_err(map_sqlite)?;
    Ok(rewritten)
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

/// Without a length prefix, two different field splits would produce the same preimage.
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
