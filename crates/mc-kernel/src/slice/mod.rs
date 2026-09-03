mod alignment;
mod read;
mod write;

use serde::{Deserialize, Serialize};

use super::Sensitivity;

pub use alignment::{AlignmentRebuild, AlignmentRow, AlignmentSnapshot};
pub use read::{DecisionRow, ObservationRow, SliceSnapshot};

pub(crate) use alignment::{
    rebuild_alignment_tx, rebuild_alignment_with_writer, ALIGNMENT_DEPENDENCY_KIND,
};

/// Human-readable content stored with a decision.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct DecisionPayload {
    pub summary: String,
    pub rationale: String,
}

/// Complete input for inserting a versioned decision and its object identity.
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

/// Human-readable classification and optional versioned detail for an observation.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ObservationPayload {
    pub summary: String,
    pub classification: String,
    /// Optional versioned JSON detail (applicability observations carry
    /// checkout identity, HEAD, evidence, and algorithm versions here).
    /// Absent on rows written before the field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Directed dependency recorded with an observation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservationDependencySpec {
    pub dependency_object_id: String,
    pub dependency_kind: String,
    pub dependency_payload: Option<String>,
}

/// Complete input for inserting a versioned observation and its dependencies.
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
    /// Observation timestamp in caller-defined epoch units preserved by storage.
    pub observed_at: i64,
    pub dependencies: Vec<ObservationDependencySpec>,
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: i64,
    pub sensitivity: Sensitivity,
}

/// Human-readable content attached to a decision event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DecisionEventPayload {
    pub summary: String,
}

/// Input for appending one event to a decision's ordered event stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionEventSpec {
    pub event_kind: String,
    pub payload: DecisionEventPayload,
    pub evidence_id: Option<String>,
    /// Event timestamp in caller-defined epoch units preserved by storage.
    pub recorded_at: i64,
}

/// Stable identifiers returned after a decision write commits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DecisionWriteOutcome {
    pub decision_id: String,
    pub object_id: String,
}

impl DecisionWriteOutcome {
    /// Serializes the string-only outcome; serialization cannot fail for these fields.
    pub fn result_json(&self) -> String {
        serde_json::to_string(self).expect("string-only outcome is serializable")
    }
}

/// Stable identifiers returned after an observation write commits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ObservationWriteOutcome {
    pub observation_id: String,
    pub object_id: String,
}

impl ObservationWriteOutcome {
    /// Serializes the string-only outcome; serialization cannot fail for these fields.
    pub fn result_json(&self) -> String {
        serde_json::to_string(self).expect("string-only outcome is serializable")
    }
}

/// Decision identity and ordinal assigned by storage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DecisionEventOutcome {
    pub decision_id: String,
    pub event_ordinal: i64,
}

impl DecisionEventOutcome {
    /// Serializes the string-and-integer outcome; serialization cannot fail for these fields.
    pub fn result_json(&self) -> String {
        serde_json::to_string(self).expect("string and integer outcome is serializable")
    }
}

/// Object identity returned after a retirement write commits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RetirementOutcome {
    pub object_id: String,
    pub object_kind: String,
}

impl RetirementOutcome {
    /// Serializes the string-only outcome; serialization cannot fail for these fields.
    pub fn result_json(&self) -> String {
        serde_json::to_string(self).expect("string-only outcome is serializable")
    }
}
