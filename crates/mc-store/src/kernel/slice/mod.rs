mod write;

use serde::Serialize;

use super::Sensitivity;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DecisionPayload {
    pub summary: String,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionSpec {
    pub decision_id: String,
    pub object_id: String,
    pub domain_id: String,
    pub proposition_id: Option<String>,
    pub scope_id: Option<String>,
    pub anchor_id: Option<String>,
    pub evidence_id: Option<String>,
    pub decision_kind: String,
    pub payload: DecisionPayload,
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: i64,
    pub sensitivity: Sensitivity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ObservationPayload {
    pub summary: String,
    pub classification: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservationDependencySpec {
    pub dependency_object_id: String,
    pub dependency_kind: String,
    pub dependency_payload: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservationSpec {
    pub observation_id: String,
    pub object_id: String,
    pub domain_id: String,
    pub proposition_id: Option<String>,
    pub scope_id: Option<String>,
    pub anchor_id: Option<String>,
    pub evidence_id: Option<String>,
    pub observation_kind: String,
    pub payload: ObservationPayload,
    pub observed_at: i64,
    pub dependencies: Vec<ObservationDependencySpec>,
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: i64,
    pub sensitivity: Sensitivity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DecisionEventPayload {
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionEventSpec {
    pub event_kind: String,
    pub payload: DecisionEventPayload,
    pub evidence_id: Option<String>,
    pub recorded_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DecisionWriteOutcome {
    pub decision_id: String,
    pub object_id: String,
}

impl DecisionWriteOutcome {
    pub fn result_json(&self) -> String {
        serde_json::to_string(self).expect("string-only outcome is serializable")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ObservationWriteOutcome {
    pub observation_id: String,
    pub object_id: String,
}

impl ObservationWriteOutcome {
    pub fn result_json(&self) -> String {
        serde_json::to_string(self).expect("string-only outcome is serializable")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DecisionEventOutcome {
    pub decision_id: String,
    pub event_ordinal: i64,
}

impl DecisionEventOutcome {
    pub fn result_json(&self) -> String {
        serde_json::to_string(self).expect("string and integer outcome is serializable")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RetirementOutcome {
    pub object_id: String,
    pub object_kind: String,
}

impl RetirementOutcome {
    pub fn result_json(&self) -> String {
        serde_json::to_string(self).expect("string-only outcome is serializable")
    }
}
