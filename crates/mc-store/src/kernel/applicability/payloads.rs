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

/// Dependency kind linking an applicability observation to the object it
/// classifies; the injection-block reducer reverse-looks-up through it.
pub const DEPENDENCY_KIND_TARGET: &str = "applicability_target";

/// Object-side applicability inputs, decoded from the owning row's frozen
/// `payload` BLOB. Absent or undecodable payloads mean the object declares
/// no affected paths and no cheap checks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectApplicabilitySpec {
    pub schema: String,
    #[serde(default)]
    pub affected_paths: Vec<String>,
    #[serde(default)]
    pub checks: Vec<CheckSpec>,
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

    /// Fail-closed decode: `None` when the payload is missing, unreadable,
    /// or carries an unknown schema. Callers treat `None` as "no declared
    /// inputs".
    pub fn decode(payload: Option<&[u8]>) -> Option<Self> {
        let decoded = serde_json::from_slice::<Self>(payload?).ok()?;
        (decoded.schema == OBJECT_APPLICABILITY_SCHEMA).then_some(decoded)
    }
}

/// One bounded cheap check. `Symbol` ships as vocabulary only: it decodes,
/// evaluates as unsupported, and renders the object uncertain until a real
/// resolver introduces the trait seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckSpec {
    FileExists { path: String },
    ConfigKey { path: String, key: String },
    Symbol { path: String, symbol: String },
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
