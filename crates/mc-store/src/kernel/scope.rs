use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::envelope::{Envelope, ObjectRow, PendingChange};
use super::redaction::{record, redact, RedactedField};
use super::{KernelError, Sensitivity};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeTermSpec {
    pub dimension: String,
    pub operator: String,
    pub exact_value: Option<String>,
    pub set_values: Option<Vec<String>>,
    pub range_start: Option<String>,
    pub range_end: Option<String>,
    pub version_range: Option<String>,
    pub git_oid: Option<String>,
    pub git_start_oid: Option<String>,
    pub git_end_oid: Option<String>,
    pub payload: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeSpec {
    pub scope_id: String,
    pub object_id: String,
    pub domain_id: String,
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: i64,
    pub sensitivity: Sensitivity,
    pub terms: Vec<ScopeTermSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScopeWriteOutcome {
    pub scope_id: String,
    pub object_id: String,
}

impl ScopeWriteOutcome {
    pub fn result_json(&self) -> String {
        serde_json::to_string(self).expect("string-only outcome is serializable")
    }
}

struct RedactedScope {
    scope_id: RedactedField,
    object_id: RedactedField,
    domain_id: RedactedField,
    source_kind: RedactedField,
    source_id: RedactedField,
    source_revision: i64,
    sensitivity: Sensitivity,
    terms: Vec<RedactedTerm>,
}

struct RedactedTerm {
    dimension: RedactedField,
    operator: RedactedField,
    exact_value: Option<RedactedField>,
    set_values: Option<Vec<RedactedField>>,
    range_start: Option<RedactedField>,
    range_end: Option<RedactedField>,
    version_range: Option<RedactedField>,
    git_oid: Option<RedactedField>,
    git_start_oid: Option<RedactedField>,
    git_end_oid: Option<RedactedField>,
    payload: Option<RedactedField>,
}

impl Envelope<'_> {
    pub fn insert_scope(&mut self, spec: ScopeSpec) -> Result<ScopeWriteOutcome, KernelError> {
        let spec = RedactedScope::new(spec)?;
        let domain_exists = self
            .tx
            .query_row(
                "SELECT 1 FROM domains
                 WHERE domain_id=?1 AND invalidated_commit_seq IS NULL",
                [&spec.domain_id.text],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| KernelError::Io)?
            .is_some();
        if !domain_exists {
            return Err(KernelError::NotFound);
        }
        let object = spec.object_row(self.commit_seq);
        self.tx
            .execute(
                "INSERT INTO object_registry(
                     object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                     created_commit_seq,sensitivity_class
                 ) VALUES (?1,'scope',?2,?3,?4,?5,?6,?7)",
                params![
                    object.object_id,
                    object.domain_id,
                    object.source_kind,
                    object.source_id,
                    object.source_revision,
                    self.commit_seq,
                    object.sensitivity.as_str(),
                ],
            )
            .map_err(map_write_error)?;
        for (name, field) in [
            ("object_id", &spec.object_id),
            ("domain_id", &spec.domain_id),
            ("source_kind", &spec.source_kind),
            ("source_id", &spec.source_id),
        ] {
            record(
                self.tx,
                "object_registry",
                &spec.object_id.text,
                name,
                field,
                Some(self.commit_seq),
            )?;
        }
        self.tx
            .execute(
                "INSERT INTO scopes(
                     scope_id,object_id,domain_id,created_commit_seq,sensitivity_class
                 ) VALUES (?1,?2,?3,?4,?5)",
                params![
                    spec.scope_id.text,
                    spec.object_id.text,
                    spec.domain_id.text,
                    self.commit_seq,
                    spec.sensitivity.as_str(),
                ],
            )
            .map_err(map_write_error)?;
        for (ordinal, term) in spec.terms.iter().enumerate() {
            let ordinal = i64::try_from(ordinal).map_err(|_| KernelError::InvalidInput)?;
            let set_values = term
                .set_values
                .as_ref()
                .map(|values| {
                    serde_json::to_vec(
                        &values
                            .iter()
                            .map(|value| value.text.as_str())
                            .collect::<Vec<_>>(),
                    )
                })
                .transpose()
                .map_err(|_| KernelError::InvalidInput)?;
            self.tx
                .execute(
                    "INSERT INTO scope_term(
                         scope_id,ordinal,dimension,operator,exact_value,set_values,range_start,
                         range_end,version_range,git_oid,git_start_oid,git_end_oid,payload
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                    params![
                        spec.scope_id.text,
                        ordinal,
                        term.dimension.text,
                        term.operator.text,
                        text(&term.exact_value),
                        set_values,
                        text(&term.range_start),
                        text(&term.range_end),
                        text(&term.version_range),
                        text(&term.git_oid),
                        text(&term.git_start_oid),
                        text(&term.git_end_oid),
                        term.payload.as_ref().map(|value| value.text.as_bytes()),
                    ],
                )
                .map_err(map_write_error)?;
        }
        for (name, field) in spec.text_fields() {
            record(
                self.tx,
                "scopes",
                &spec.scope_id.text,
                &name,
                &field,
                Some(self.commit_seq),
            )?;
        }
        let outcome = ScopeWriteOutcome {
            scope_id: spec.scope_id.text.clone(),
            object_id: spec.object_id.text.clone(),
        };
        self.changes.push(PendingChange {
            object,
            kind: "scope_insert",
            replaced_object_id: None,
            redactions: spec.text_fields(),
            audit: None,
        });
        Ok(outcome)
    }
}

impl RedactedScope {
    fn new(spec: ScopeSpec) -> Result<Self, KernelError> {
        if spec.source_revision < 0
            || [
                &spec.scope_id,
                &spec.object_id,
                &spec.domain_id,
                &spec.source_kind,
                &spec.source_id,
            ]
            .into_iter()
            .any(|value| value.trim().is_empty())
        {
            return Err(KernelError::InvalidInput);
        }
        let terms = spec
            .terms
            .into_iter()
            .map(RedactedTerm::new)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            scope_id: redact(&spec.scope_id),
            object_id: redact(&spec.object_id),
            domain_id: redact(&spec.domain_id),
            source_kind: redact(&spec.source_kind),
            source_id: redact(&spec.source_id),
            source_revision: spec.source_revision,
            sensitivity: spec.sensitivity,
            terms,
        })
    }

    fn object_row(&self, commit_seq: i64) -> ObjectRow {
        ObjectRow {
            object_id: self.object_id.text.clone(),
            object_kind: "scope".to_string(),
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
        let mut fields = vec![
            ("scope_id".to_string(), self.scope_id.clone()),
            ("object_id".to_string(), self.object_id.clone()),
            ("domain_id".to_string(), self.domain_id.clone()),
            ("source_kind".to_string(), self.source_kind.clone()),
            ("source_id".to_string(), self.source_id.clone()),
        ];
        for (ordinal, term) in self.terms.iter().enumerate() {
            fields.extend(term.text_fields(i64::try_from(ordinal).unwrap_or(i64::MAX)));
        }
        fields
    }
}

impl RedactedTerm {
    fn new(spec: ScopeTermSpec) -> Result<Self, KernelError> {
        if spec.dimension.trim().is_empty() || spec.operator.trim().is_empty() {
            return Err(KernelError::InvalidInput);
        }
        Ok(Self {
            dimension: redact(&spec.dimension),
            operator: redact(&spec.operator),
            exact_value: spec.exact_value.as_deref().map(redact),
            set_values: spec
                .set_values
                .map(|values| values.iter().map(|value| redact(value)).collect()),
            range_start: spec.range_start.as_deref().map(redact),
            range_end: spec.range_end.as_deref().map(redact),
            version_range: spec.version_range.as_deref().map(redact),
            git_oid: spec.git_oid.as_deref().map(redact),
            git_start_oid: spec.git_start_oid.as_deref().map(redact),
            git_end_oid: spec.git_end_oid.as_deref().map(redact),
            payload: spec.payload.as_deref().map(redact),
        })
    }

    fn text_fields(&self, ordinal: i64) -> Vec<(String, RedactedField)> {
        let prefix = format!("terms.{ordinal}");
        let mut fields = vec![
            (format!("{prefix}.dimension"), self.dimension.clone()),
            (format!("{prefix}.operator"), self.operator.clone()),
        ];
        for (name, value) in [
            ("exact_value", &self.exact_value),
            ("range_start", &self.range_start),
            ("range_end", &self.range_end),
            ("version_range", &self.version_range),
            ("git_oid", &self.git_oid),
            ("git_start_oid", &self.git_start_oid),
            ("git_end_oid", &self.git_end_oid),
            ("payload", &self.payload),
        ] {
            if let Some(value) = value {
                fields.push((format!("{prefix}.{name}"), value.clone()));
            }
        }
        if let Some(values) = &self.set_values {
            for (index, value) in values.iter().enumerate() {
                fields.push((format!("{prefix}.set_values.{index}"), value.clone()));
            }
        }
        fields
    }
}

fn text(field: &Option<RedactedField>) -> Option<&str> {
    field.as_ref().map(|value| value.text.as_str())
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
