use rusqlite::{params, OptionalExtension, Transaction};

use super::{
    DecisionEventOutcome, DecisionEventSpec, DecisionSpec, DecisionWriteOutcome,
    ObservationDependencySpec, ObservationSpec, ObservationWriteOutcome, RetirementOutcome,
};
use crate::kernel::envelope::{Envelope, ObjectRow, PendingChange};
use crate::kernel::redaction::{record, redact, RedactedField};
use crate::kernel::{KernelError, Sensitivity};

struct RedactedDecision {
    decision_id: RedactedField,
    object_id: RedactedField,
    domain_id: RedactedField,
    proposition_id: Option<RedactedField>,
    scope_id: Option<RedactedField>,
    anchor_id: Option<RedactedField>,
    evidence_id: Option<RedactedField>,
    decision_kind: RedactedField,
    payload: RedactedDecisionPayload,
    source_kind: RedactedField,
    source_id: RedactedField,
    source_revision: i64,
    sensitivity: Sensitivity,
}

struct RedactedDecisionPayload {
    summary: RedactedField,
    rationale: RedactedField,
}

#[derive(Serialize)]
struct StoredDecisionPayload<'a> {
    summary: &'a str,
    rationale: &'a str,
}

struct RedactedObservation {
    observation_id: RedactedField,
    object_id: RedactedField,
    domain_id: RedactedField,
    proposition_id: Option<RedactedField>,
    scope_id: Option<RedactedField>,
    anchor_id: Option<RedactedField>,
    evidence_id: Option<RedactedField>,
    observation_kind: RedactedField,
    payload: RedactedObservationPayload,
    observed_at: i64,
    dependencies: Vec<RedactedDependency>,
    source_kind: RedactedField,
    source_id: RedactedField,
    source_revision: i64,
    sensitivity: Sensitivity,
}

struct RedactedObservationPayload {
    summary: RedactedField,
    classification: RedactedField,
}

#[derive(Serialize)]
struct StoredObservationPayload<'a> {
    summary: &'a str,
    classification: &'a str,
}

struct RedactedDependency {
    object_id: RedactedField,
    kind: RedactedField,
    payload: Option<RedactedField>,
}

struct RedactedEvent {
    kind: RedactedField,
    summary: RedactedField,
    evidence_id: Option<RedactedField>,
    recorded_at: i64,
}

#[derive(Serialize)]
struct StoredEventPayload<'a> {
    summary: &'a str,
}

use serde::Serialize;

impl Envelope<'_> {
    pub fn insert_decision(
        &mut self,
        spec: DecisionSpec,
    ) -> Result<DecisionWriteOutcome, KernelError> {
        let spec = RedactedDecision::new(spec)?;
        insert_decision(self.tx, self.commit_seq, &spec)?;
        let outcome = spec.outcome();
        self.changes.push(PendingChange {
            object: spec.object_row(self.commit_seq),
            kind: "decision_insert",
            replaced_object_id: None,
            redactions: spec.text_fields(),
            audit: None,
        });
        Ok(outcome)
    }

    pub fn insert_observation(
        &mut self,
        spec: ObservationSpec,
    ) -> Result<ObservationWriteOutcome, KernelError> {
        let spec = RedactedObservation::new(spec)?;
        insert_observation(self.tx, self.commit_seq, &spec)?;
        let outcome = spec.outcome();
        self.changes.push(PendingChange {
            object: spec.object_row(self.commit_seq),
            kind: "observation_insert",
            replaced_object_id: None,
            redactions: spec.text_fields(),
            audit: None,
        });
        Ok(outcome)
    }

    /// Appends to a live decision and allocates its next ordinal inside this envelope.
    pub fn append_decision_event(
        &mut self,
        decision_id: &str,
        spec: DecisionEventSpec,
    ) -> Result<DecisionEventOutcome, KernelError> {
        let decision_id = redact(decision_id);
        let spec = RedactedEvent::new(spec)?;
        require_live_evidence(self.tx, spec.evidence_id.as_ref())?;
        let object = load_live_decision_object(self.tx, &decision_id.text)?;
        let ordinal = self
            .tx
            .query_row(
                "SELECT COALESCE(MAX(event_ordinal),0)+1
                 FROM decision_events WHERE decision_id=?1",
                [&decision_id.text],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| KernelError::Io)?;
        let payload = serde_json::to_vec(&StoredEventPayload {
            summary: &spec.summary.text,
        })
        .map_err(|_| KernelError::InvalidInput)?;
        self.tx
            .execute(
                "INSERT INTO decision_events(
                     decision_id,event_ordinal,commit_seq,event_kind,event_payload,evidence_id,
                     recorded_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    decision_id.text,
                    ordinal,
                    self.commit_seq,
                    spec.kind.text,
                    payload,
                    spec.evidence_id.as_ref().map(|value| value.text.as_str()),
                    spec.recorded_at,
                ],
            )
            .map_err(map_write_error)?;
        let owner_id = format!("{}:{ordinal}", decision_id.text);
        let mut event_fields = vec![
            ("decision_id".to_string(), decision_id.clone()),
            ("event_kind".to_string(), spec.kind.clone()),
            ("event_payload.summary".to_string(), spec.summary.clone()),
        ];
        push_optional(&mut event_fields, "evidence_id", &spec.evidence_id);
        record_fields(
            self.tx,
            "decision_events",
            &owner_id,
            &event_fields,
            self.commit_seq,
        )?;
        self.changes.push(PendingChange {
            object,
            kind: "decision_event_append",
            replaced_object_id: None,
            redactions: event_fields,
            audit: Some(serde_json::json!({
                "decision_id": decision_id.text,
                "event_ordinal": ordinal,
                "event_kind": spec.kind.text,
            })),
        });
        Ok(DecisionEventOutcome {
            decision_id: decision_id.text,
            event_ordinal: ordinal,
        })
    }

    pub fn correct_decision(
        &mut self,
        replaced_object_id: &str,
        replacement: DecisionSpec,
    ) -> Result<DecisionWriteOutcome, KernelError> {
        let replaced_object_id = redact(replaced_object_id);
        let old = load_live_typed_object(self.tx, &replaced_object_id.text, "decision")?;
        let replacement = RedactedDecision::new(replacement)?;
        validate_successor(
            &old,
            &replacement.source_kind,
            &replacement.source_id,
            replacement.source_revision,
        )?;
        invalidate(
            self.tx,
            self.commit_seq,
            "decisions",
            "object_id",
            &replaced_object_id.text,
        )?;
        insert_decision(self.tx, self.commit_seq, &replacement)?;
        set_successor(
            self.tx,
            "decisions",
            &replaced_object_id.text,
            &replacement.object_id.text,
        )?;
        let outcome = replacement.outcome();
        self.changes.push(PendingChange {
            object: replacement.object_row(self.commit_seq),
            kind: "decision_correct",
            replaced_object_id: Some(replaced_object_id.text),
            redactions: replacement.text_fields(),
            audit: None,
        });
        Ok(outcome)
    }

    pub fn correct_observation(
        &mut self,
        replaced_object_id: &str,
        replacement: ObservationSpec,
    ) -> Result<ObservationWriteOutcome, KernelError> {
        let replaced_object_id = redact(replaced_object_id);
        let old = load_live_typed_object(self.tx, &replaced_object_id.text, "observation")?;
        let replacement = RedactedObservation::new(replacement)?;
        validate_successor(
            &old,
            &replacement.source_kind,
            &replacement.source_id,
            replacement.source_revision,
        )?;
        invalidate(
            self.tx,
            self.commit_seq,
            "observations",
            "object_id",
            &replaced_object_id.text,
        )?;
        insert_observation(self.tx, self.commit_seq, &replacement)?;
        set_successor(
            self.tx,
            "observations",
            &replaced_object_id.text,
            &replacement.object_id.text,
        )?;
        let outcome = replacement.outcome();
        self.changes.push(PendingChange {
            object: replacement.object_row(self.commit_seq),
            kind: "observation_correct",
            replaced_object_id: Some(replaced_object_id.text),
            redactions: replacement.text_fields(),
            audit: None,
        });
        Ok(outcome)
    }

    pub fn retire_decision(&mut self, object_id: &str) -> Result<RetirementOutcome, KernelError> {
        self.retire_slice_object(object_id, "decision", "decisions")
    }

    pub fn retire_observation(
        &mut self,
        object_id: &str,
    ) -> Result<RetirementOutcome, KernelError> {
        self.retire_slice_object(object_id, "observation", "observations")
    }

    fn retire_slice_object(
        &mut self,
        object_id: &str,
        object_kind: &'static str,
        table: &'static str,
    ) -> Result<RetirementOutcome, KernelError> {
        let object_id = redact(object_id);
        let mut object = load_live_typed_object(self.tx, &object_id.text, object_kind)?;
        invalidate(
            self.tx,
            self.commit_seq,
            table,
            "object_id",
            &object_id.text,
        )?;
        object.invalidated_commit_seq = Some(self.commit_seq);
        self.changes.push(PendingChange {
            object,
            kind: match object_kind {
                "decision" => "decision_retire",
                _ => "observation_retire",
            },
            replaced_object_id: None,
            redactions: vec![("object_id".to_string(), object_id.clone())],
            audit: None,
        });
        Ok(RetirementOutcome {
            object_id: object_id.text,
            object_kind: object_kind.to_string(),
        })
    }
}

impl RedactedDecision {
    fn new(spec: DecisionSpec) -> Result<Self, KernelError> {
        require_spec_fields(
            &[
                &spec.decision_id,
                &spec.object_id,
                &spec.domain_id,
                &spec.decision_kind,
                &spec.source_kind,
                &spec.source_id,
            ],
            spec.source_revision,
        )?;
        Ok(Self {
            decision_id: redact(&spec.decision_id),
            object_id: redact(&spec.object_id),
            domain_id: redact(&spec.domain_id),
            proposition_id: spec.proposition_id.as_deref().map(redact),
            scope_id: spec.scope_id.as_deref().map(redact),
            anchor_id: spec.anchor_id.as_deref().map(redact),
            evidence_id: spec.evidence_id.as_deref().map(redact),
            decision_kind: redact(&spec.decision_kind),
            payload: RedactedDecisionPayload {
                summary: redact(&spec.payload.summary),
                rationale: redact(&spec.payload.rationale),
            },
            source_kind: redact(&spec.source_kind),
            source_id: redact(&spec.source_id),
            source_revision: spec.source_revision,
            sensitivity: spec.sensitivity,
        })
    }

    fn object_row(&self, commit_seq: i64) -> ObjectRow {
        ObjectRow {
            object_id: self.object_id.text.clone(),
            object_kind: "decision".to_string(),
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

    fn outcome(&self) -> DecisionWriteOutcome {
        DecisionWriteOutcome {
            decision_id: self.decision_id.text.clone(),
            object_id: self.object_id.text.clone(),
        }
    }

    fn text_fields(&self) -> Vec<(String, RedactedField)> {
        let mut fields = vec![
            ("decision_id".to_string(), self.decision_id.clone()),
            ("object_id".to_string(), self.object_id.clone()),
            ("domain_id".to_string(), self.domain_id.clone()),
            ("decision_kind".to_string(), self.decision_kind.clone()),
            ("source_kind".to_string(), self.source_kind.clone()),
            ("source_id".to_string(), self.source_id.clone()),
            (
                "decision_payload.summary".to_string(),
                self.payload.summary.clone(),
            ),
            (
                "decision_payload.rationale".to_string(),
                self.payload.rationale.clone(),
            ),
        ];
        push_optional(&mut fields, "proposition_id", &self.proposition_id);
        push_optional(&mut fields, "scope_id", &self.scope_id);
        push_optional(&mut fields, "anchor_id", &self.anchor_id);
        push_optional(&mut fields, "evidence_id", &self.evidence_id);
        fields
    }
}

impl RedactedObservation {
    fn new(spec: ObservationSpec) -> Result<Self, KernelError> {
        require_spec_fields(
            &[
                &spec.observation_id,
                &spec.object_id,
                &spec.domain_id,
                &spec.observation_kind,
                &spec.source_kind,
                &spec.source_id,
            ],
            spec.source_revision,
        )?;
        if spec.observed_at < 0 {
            return Err(KernelError::InvalidInput);
        }
        let dependencies = spec
            .dependencies
            .into_iter()
            .map(RedactedDependency::new)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            observation_id: redact(&spec.observation_id),
            object_id: redact(&spec.object_id),
            domain_id: redact(&spec.domain_id),
            proposition_id: spec.proposition_id.as_deref().map(redact),
            scope_id: spec.scope_id.as_deref().map(redact),
            anchor_id: spec.anchor_id.as_deref().map(redact),
            evidence_id: spec.evidence_id.as_deref().map(redact),
            observation_kind: redact(&spec.observation_kind),
            payload: RedactedObservationPayload {
                summary: redact(&spec.payload.summary),
                classification: redact(&spec.payload.classification),
            },
            observed_at: spec.observed_at,
            dependencies,
            source_kind: redact(&spec.source_kind),
            source_id: redact(&spec.source_id),
            source_revision: spec.source_revision,
            sensitivity: spec.sensitivity,
        })
    }

    fn object_row(&self, commit_seq: i64) -> ObjectRow {
        ObjectRow {
            object_id: self.object_id.text.clone(),
            object_kind: "observation".to_string(),
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

    fn outcome(&self) -> ObservationWriteOutcome {
        ObservationWriteOutcome {
            observation_id: self.observation_id.text.clone(),
            object_id: self.object_id.text.clone(),
        }
    }

    fn text_fields(&self) -> Vec<(String, RedactedField)> {
        let mut fields = vec![
            ("observation_id".to_string(), self.observation_id.clone()),
            ("object_id".to_string(), self.object_id.clone()),
            ("domain_id".to_string(), self.domain_id.clone()),
            (
                "observation_kind".to_string(),
                self.observation_kind.clone(),
            ),
            ("source_kind".to_string(), self.source_kind.clone()),
            ("source_id".to_string(), self.source_id.clone()),
            (
                "observation_payload.summary".to_string(),
                self.payload.summary.clone(),
            ),
            (
                "observation_payload.classification".to_string(),
                self.payload.classification.clone(),
            ),
        ];
        push_optional(&mut fields, "proposition_id", &self.proposition_id);
        push_optional(&mut fields, "scope_id", &self.scope_id);
        push_optional(&mut fields, "anchor_id", &self.anchor_id);
        push_optional(&mut fields, "evidence_id", &self.evidence_id);
        for (index, dependency) in self.dependencies.iter().enumerate() {
            fields.push((
                format!("dependencies.{index}.dependency_object_id"),
                dependency.object_id.clone(),
            ));
            fields.push((
                format!("dependencies.{index}.dependency_kind"),
                dependency.kind.clone(),
            ));
            push_optional(
                &mut fields,
                &format!("dependencies.{index}.dependency_payload"),
                &dependency.payload,
            );
        }
        fields
    }
}

impl RedactedDependency {
    fn new(spec: ObservationDependencySpec) -> Result<Self, KernelError> {
        if spec.dependency_object_id.trim().is_empty() || spec.dependency_kind.trim().is_empty() {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            object_id: redact(&spec.dependency_object_id),
            kind: redact(&spec.dependency_kind),
            payload: spec.dependency_payload.as_deref().map(redact),
        })
    }
}

impl RedactedEvent {
    fn new(spec: DecisionEventSpec) -> Result<Self, KernelError> {
        if spec.event_kind.trim().is_empty() || spec.recorded_at < 0 {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            kind: redact(&spec.event_kind),
            summary: redact(&spec.payload.summary),
            evidence_id: spec.evidence_id.as_deref().map(redact),
            recorded_at: spec.recorded_at,
        })
    }
}

fn insert_decision(
    tx: &Transaction<'_>,
    commit_seq: i64,
    spec: &RedactedDecision,
) -> Result<(), KernelError> {
    require_parents(
        tx,
        &spec.domain_id,
        spec.proposition_id.as_ref(),
        spec.scope_id.as_ref(),
        spec.anchor_id.as_ref(),
        spec.evidence_id.as_ref(),
    )?;
    insert_registry(tx, commit_seq, &spec.object_row(commit_seq))?;
    record_registry_fields(
        tx,
        &spec.object_id.text,
        &spec.domain_id,
        &spec.object_id,
        &spec.source_kind,
        &spec.source_id,
        commit_seq,
    )?;
    let payload = serde_json::to_vec(&StoredDecisionPayload {
        summary: &spec.payload.summary.text,
        rationale: &spec.payload.rationale.text,
    })
    .map_err(|_| KernelError::InvalidInput)?;
    tx.execute(
        "INSERT INTO decisions(
             decision_id,object_id,proposition_id,scope_id,anchor_id,evidence_id,decision_kind,
             decision_payload,created_commit_seq,sensitivity_class
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            spec.decision_id.text,
            spec.object_id.text,
            optional_text(&spec.proposition_id),
            optional_text(&spec.scope_id),
            optional_text(&spec.anchor_id),
            optional_text(&spec.evidence_id),
            spec.decision_kind.text,
            payload,
            commit_seq,
            spec.sensitivity.as_str(),
        ],
    )
    .map_err(map_write_error)?;
    record_fields(
        tx,
        "decisions",
        &spec.decision_id.text,
        &spec.text_fields(),
        commit_seq,
    )
}

fn insert_observation(
    tx: &Transaction<'_>,
    commit_seq: i64,
    spec: &RedactedObservation,
) -> Result<(), KernelError> {
    require_parents(
        tx,
        &spec.domain_id,
        spec.proposition_id.as_ref(),
        spec.scope_id.as_ref(),
        spec.anchor_id.as_ref(),
        spec.evidence_id.as_ref(),
    )?;
    for dependency in &spec.dependencies {
        require_live(
            tx,
            "object_registry",
            "object_id",
            &dependency.object_id.text,
        )?;
    }
    insert_registry(tx, commit_seq, &spec.object_row(commit_seq))?;
    record_registry_fields(
        tx,
        &spec.object_id.text,
        &spec.domain_id,
        &spec.object_id,
        &spec.source_kind,
        &spec.source_id,
        commit_seq,
    )?;
    let payload = serde_json::to_vec(&StoredObservationPayload {
        summary: &spec.payload.summary.text,
        classification: &spec.payload.classification.text,
    })
    .map_err(|_| KernelError::InvalidInput)?;
    tx.execute(
        "INSERT INTO observations(
             observation_id,object_id,proposition_id,scope_id,anchor_id,evidence_id,
             observation_kind,observation_payload,observed_at,created_commit_seq,sensitivity_class
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            spec.observation_id.text,
            spec.object_id.text,
            optional_text(&spec.proposition_id),
            optional_text(&spec.scope_id),
            optional_text(&spec.anchor_id),
            optional_text(&spec.evidence_id),
            spec.observation_kind.text,
            payload,
            spec.observed_at,
            commit_seq,
            spec.sensitivity.as_str(),
        ],
    )
    .map_err(map_write_error)?;
    record_fields(
        tx,
        "observations",
        &spec.observation_id.text,
        &spec.text_fields(),
        commit_seq,
    )?;
    for dependency in &spec.dependencies {
        tx.execute(
            "INSERT INTO observation_dependencies(
                 observation_id,dependency_object_id,dependency_kind,dependency_payload
             ) VALUES (?1,?2,?3,?4)",
            params![
                spec.observation_id.text,
                dependency.object_id.text,
                dependency.kind.text,
                dependency
                    .payload
                    .as_ref()
                    .map(|value| value.text.as_bytes()),
            ],
        )
        .map_err(map_write_error)?;
    }
    Ok(())
}

fn require_parents(
    tx: &Transaction<'_>,
    domain_id: &RedactedField,
    proposition_id: Option<&RedactedField>,
    scope_id: Option<&RedactedField>,
    anchor_id: Option<&RedactedField>,
    evidence_id: Option<&RedactedField>,
) -> Result<(), KernelError> {
    require_live(tx, "domains", "domain_id", &domain_id.text)?;
    require_optional_live(tx, "propositions", "proposition_id", proposition_id)?;
    require_optional_live(tx, "scopes", "scope_id", scope_id)?;
    require_optional_live(tx, "anchors", "anchor_id", anchor_id)?;
    require_optional_live(tx, "evidence_meta", "evidence_id", evidence_id)
}

fn require_live_evidence(
    tx: &Transaction<'_>,
    evidence_id: Option<&RedactedField>,
) -> Result<(), KernelError> {
    require_optional_live(tx, "evidence_meta", "evidence_id", evidence_id)
}

fn require_optional_live(
    tx: &Transaction<'_>,
    table: &str,
    column: &str,
    value: Option<&RedactedField>,
) -> Result<(), KernelError> {
    match value {
        Some(value) => require_live(tx, table, column, &value.text),
        None => Ok(()),
    }
}

fn require_live(
    tx: &Transaction<'_>,
    table: &str,
    column: &str,
    value: &str,
) -> Result<(), KernelError> {
    let sql = format!("SELECT 1 FROM {table} WHERE {column}=?1 AND invalidated_commit_seq IS NULL");
    tx.query_row(&sql, [value], |_| Ok(()))
        .optional()
        .map_err(|_| KernelError::Io)?
        .ok_or(KernelError::NotFound)
}

fn insert_registry(
    tx: &Transaction<'_>,
    commit_seq: i64,
    object: &ObjectRow,
) -> Result<(), KernelError> {
    tx.execute(
        "INSERT INTO object_registry(
             object_id,object_kind,domain_id,source_kind,source_id,source_revision,
             created_commit_seq,sensitivity_class
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            object.object_id,
            object.object_kind,
            object.domain_id,
            object.source_kind,
            object.source_id,
            object.source_revision,
            commit_seq,
            object.sensitivity.as_str(),
        ],
    )
    .map(|_| ())
    .map_err(map_write_error)
}

fn record_registry_fields(
    tx: &Transaction<'_>,
    owner_id: &str,
    domain_id: &RedactedField,
    object_id: &RedactedField,
    source_kind: &RedactedField,
    source_id: &RedactedField,
    commit_seq: i64,
) -> Result<(), KernelError> {
    record_fields(
        tx,
        "object_registry",
        owner_id,
        &[
            ("domain_id".to_string(), domain_id.clone()),
            ("object_id".to_string(), object_id.clone()),
            ("source_kind".to_string(), source_kind.clone()),
            ("source_id".to_string(), source_id.clone()),
        ],
        commit_seq,
    )
}

fn record_fields(
    tx: &Transaction<'_>,
    owner_kind: &str,
    owner_id: &str,
    fields: &[(String, RedactedField)],
    commit_seq: i64,
) -> Result<(), KernelError> {
    for (name, field) in fields {
        record(tx, owner_kind, owner_id, name, field, Some(commit_seq))?;
    }
    Ok(())
}

fn load_live_decision_object(
    tx: &Transaction<'_>,
    decision_id: &str,
) -> Result<ObjectRow, KernelError> {
    tx.query_row(
        "SELECT r.object_id,r.object_kind,r.domain_id,r.source_kind,r.source_id,
                r.source_revision,r.created_commit_seq,r.sensitivity_class
         FROM decisions d JOIN object_registry r ON r.object_id=d.object_id
         WHERE d.decision_id=?1 AND d.invalidated_commit_seq IS NULL
           AND r.invalidated_commit_seq IS NULL",
        [decision_id],
        row_to_object,
    )
    .optional()
    .map_err(|_| KernelError::Io)?
    .ok_or(KernelError::NotFound)
}

fn load_live_typed_object(
    tx: &Transaction<'_>,
    object_id: &str,
    object_kind: &str,
) -> Result<ObjectRow, KernelError> {
    tx.query_row(
        "SELECT object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                created_commit_seq,sensitivity_class
         FROM object_registry
         WHERE object_id=?1 AND object_kind=?2 AND invalidated_commit_seq IS NULL",
        params![object_id, object_kind],
        row_to_object,
    )
    .optional()
    .map_err(|_| KernelError::Io)?
    .ok_or(KernelError::NotFound)
}

fn row_to_object(row: &rusqlite::Row<'_>) -> rusqlite::Result<ObjectRow> {
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
}

fn invalidate(
    tx: &Transaction<'_>,
    commit_seq: i64,
    table: &str,
    column: &str,
    object_id: &str,
) -> Result<(), KernelError> {
    let changed = tx
        .execute(
            "UPDATE object_registry SET invalidated_commit_seq=?1
             WHERE object_id=?2 AND invalidated_commit_seq IS NULL",
            params![commit_seq, object_id],
        )
        .map_err(|_| KernelError::Io)?;
    if changed != 1 {
        return Err(KernelError::NotFound);
    }
    let sql = format!(
        "UPDATE {table} SET invalidated_commit_seq=?1
         WHERE {column}=?2 AND invalidated_commit_seq IS NULL"
    );
    if tx
        .execute(&sql, params![commit_seq, object_id])
        .map_err(|_| KernelError::Io)?
        != 1
    {
        return Err(KernelError::NotFound);
    }
    Ok(())
}

fn set_successor(
    tx: &Transaction<'_>,
    table: &str,
    old_object_id: &str,
    new_object_id: &str,
) -> Result<(), KernelError> {
    tx.execute(
        "UPDATE object_registry SET superseded_by=?1 WHERE object_id=?2",
        params![new_object_id, old_object_id],
    )
    .map_err(|_| KernelError::Io)?;
    let sql = format!("UPDATE {table} SET superseded_by=?1 WHERE object_id=?2");
    tx.execute(&sql, params![new_object_id, old_object_id])
        .map_err(|_| KernelError::Io)?;
    Ok(())
}

fn validate_successor(
    old: &ObjectRow,
    source_kind: &RedactedField,
    source_id: &RedactedField,
    source_revision: i64,
) -> Result<(), KernelError> {
    if old.source_kind != source_kind.text || old.source_id != source_id.text {
        return Err(KernelError::InvalidInput);
    }
    if source_revision <= old.source_revision {
        return Err(KernelError::Conflict);
    }
    Ok(())
}

fn require_spec_fields(fields: &[&str], source_revision: i64) -> Result<(), KernelError> {
    if source_revision < 0 || fields.iter().any(|field| field.trim().is_empty()) {
        return Err(KernelError::InvalidInput);
    }
    Ok(())
}

fn optional_text(field: &Option<RedactedField>) -> Option<&str> {
    field.as_ref().map(|value| value.text.as_str())
}

fn push_optional(
    fields: &mut Vec<(String, RedactedField)>,
    name: &str,
    field: &Option<RedactedField>,
) {
    if let Some(field) = field {
        fields.push((name.to_string(), field.clone()));
    }
}

fn map_write_error(error: rusqlite::Error) -> KernelError {
    match error {
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::ConstraintViolation,
                ..
            },
            _,
        ) => KernelError::Conflict,
        _ => KernelError::Io,
    }
}
