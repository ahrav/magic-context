//! Versioned payload shapes and vocabulary constants for applicability.
//!
//! These constants are the cross-task contract: sibling slices (visibility
//! evaluation, replay proofs) cite this module rather than re-deriving kind
//! strings or JSON shapes. Payloads live in frozen BLOB columns; the schema
//! tag inside each payload versions the shape.

use serde::{Deserialize, Serialize};

/// Schema tag for the object-side applicability payload carrying affected
/// paths and cheap-check specifications.
pub const OBJECT_APPLICABILITY_SCHEMA: &str = "mc.applicability.object.v1";

/// Schema tag for applicability observation payloads.
pub const OBSERVATION_APPLICABILITY_SCHEMA: &str = "mc.applicability.observation.v1";

/// Observation kind vocabulary for applicability read repair. The reducer
/// treats the latest of these per (object, checkout) as authoritative.
pub const OBSERVATION_KIND_CURRENT: &str = "applicability.current";
pub const OBSERVATION_KIND_HISTORICAL: &str = "applicability.historical";
pub const OBSERVATION_KIND_UNCERTAIN: &str = "applicability.uncertain";
pub const OBSERVATION_KIND_STALE: &str = "applicability.stale";
pub const OBSERVATION_KIND_OUT_OF_SCOPE: &str = "applicability.out_of_scope";
pub const OBSERVATION_KIND_DIRTY_TREE_UNCERTAIN: &str = "applicability.dirty_tree_uncertain";
pub const OBSERVATION_KIND_LIFECYCLE_INVALIDATED: &str = "applicability.lifecycle_invalidated";

/// Dependency kind linking an applicability observation to the object it
/// classifies; the injection-block reducer reverse-looks-up through it.
pub const DEPENDENCY_KIND_TARGET: &str = "applicability_target";

/// Object-side applicability inputs, decoded from the owning row's frozen
/// `payload` BLOB.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectApplicabilitySpec {
    pub schema: String,
    #[serde(default)]
    pub affected_paths: Vec<String>,
    #[serde(default)]
    pub checks: Vec<CheckSpec>,
}

/// `Absent` and `Undecodable` license different verdicts: an absent payload
/// declares nothing, while an unreadable payload leaves staleness unknown.
/// `Undecodable` carries the JSON or schema error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayloadDecode {
    Absent,
    Present(ObjectApplicabilitySpec),
    Undecodable(String),
}

impl ObjectApplicabilitySpec {
    pub fn new(affected_paths: Vec<String>, checks: Vec<CheckSpec>) -> Self {
        Self {
            schema: OBJECT_APPLICABILITY_SCHEMA.to_string(),
            affected_paths,
            checks,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("object applicability payload is serializable")
    }

    pub fn decode(payload: Option<&[u8]>) -> PayloadDecode {
        let Some(payload) = payload else {
            return PayloadDecode::Absent;
        };
        let decoded = match serde_json::from_slice::<Self>(payload) {
            Ok(decoded) => decoded,
            Err(error) => {
                return PayloadDecode::Undecodable(format!(
                    "object applicability payload did not parse: {error}"
                ));
            }
        };
        if decoded.schema != OBJECT_APPLICABILITY_SCHEMA {
            return PayloadDecode::Undecodable(format!(
                "object applicability payload schema {:?} is not {OBJECT_APPLICABILITY_SCHEMA}",
                decoded.schema
            ));
        }
        PayloadDecode::Present(decoded)
    }
}

/// `Unrecognized` preserves `CheckSpec` deserialization when `kind` has an
/// unknown tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckSpec {
    FileExists {
        path: String,
    },
    ConfigKey {
        path: String,
        key: String,
    },
    Symbol {
        path: String,
        symbol: String,
    },
    #[serde(other)]
    Unrecognized,
}

/// Durable payload of one applicability observation: enough to identify the
/// checkout, the evidence, and the algorithm versions that produced it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicabilityObservationPayload {
    pub schema: String,
    pub checkout_identity: String,
    pub head: String,
    pub dirty_fingerprint: String,
    pub patch_id_algorithm: String,
    pub state: String,
    pub evidence: String,
}
