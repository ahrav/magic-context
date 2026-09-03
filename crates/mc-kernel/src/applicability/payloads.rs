//! Versioned payload shapes and vocabulary constants for applicability.
//!
//! These constants are the cross-task contract: sibling slices (visibility
//! evaluation, replay proofs) cite this module rather than re-deriving kind
//! strings or JSON shapes. Payloads live in frozen BLOB columns; the schema
//! tag inside each payload versions the shape.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Schema tag for the object-side applicability payload carrying affected
/// paths and cheap-check specifications.
pub const OBJECT_APPLICABILITY_SCHEMA: &str = "mc.applicability.object.v1";

/// Schema tag for applicability observation payloads.
///
/// v2 stores a digest of the checkout identity where v1 stored the identity
/// itself. The identity is a filesystem path, and the durable-text redactor
/// rewrites a path carrying a secret-shaped segment, which left the stored
/// value unable to match the caller's.
pub const OBSERVATION_APPLICABILITY_SCHEMA: &str = "mc.applicability.observation.v2";

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
///
/// `deny_unknown_fields` because `affected_paths` and `checks` both default to commentlint: allow(JUDGE)
/// empty: a producer that misspells one, or writes a field this schema commentlint: allow(JUDGE)
/// version does not define, would otherwise decode as an object declaring commentlint: allow(JUDGE)
/// nothing and classify `Current`. A shape change takes a new schema tag, commentlint: allow(JUDGE)
/// which [`Self::decode`] already rejects. commentlint: allow(JUDGE)
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// No payload was stored.
    Absent,
    /// Payload decoded with the current schema.
    Present(ObjectApplicabilitySpec),
    /// Payload JSON or schema was invalid.
    Undecodable(String),
}

/// A derived `Default` would leave `schema` empty, and [`Self::decode`]
/// rejects that, so the default spec has to carry the schema tag.
impl Default for ObjectApplicabilitySpec {
    fn default() -> Self {
        Self::new(Vec::new(), Vec::new())
    }
}

impl ObjectApplicabilitySpec {
    /// Creates a specification tagged with the current object schema.
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

    /// Rejects unknown schema tags instead of interpreting them as the current shape.
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
/// unknown tag, so one unknown check kind degrades to unsupported instead of
/// voiding the payload.
///
/// `deny_unknown_fields` still applies inside a *recognized* variant: an extra commentlint: allow(JUDGE)
/// field there is a constraint this build would silently drop, so the payload commentlint: allow(JUDGE)
/// fails closed rather than enforcing weaker semantics than its producer commentlint: allow(JUDGE)
/// wrote. The two compose — an unknown `kind` still reaches `Unrecognized`. commentlint: allow(JUDGE)
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
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
///
/// The repair commit revalidates `head` and the object revision, both single commentlint: allow(JUDGE)
/// indexed reads. It leaves `dirty_fingerprint` unchecked: revalidating that commentlint: allow(JUDGE)
/// would put a whole worktree walk inside the single-writer window and still commentlint: allow(JUDGE)
/// leave the worktree free to change immediately afterwards. A worktree that commentlint: allow(JUDGE)
/// does change yields a different fingerprint on the next evaluation, which is commentlint: allow(JUDGE)
/// both a classification-cache miss and a different repair generation, so that commentlint: allow(JUDGE)
/// evaluation appends a superseding record. commentlint: allow(JUDGE)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicabilityObservationPayload {
    pub schema: String,
    /// [`checkout_identity_digest`] of the checkout this verdict describes.
    pub checkout_identity_digest: String,
    pub head: String,
    pub dirty_fingerprint: String,
    pub patch_id_algorithm: String,
    pub state: String,
    pub evidence: String,
}

/// Digest of a checkout identity, for the durable payload and the reducer that
/// matches against it.
///
/// The identity is a filesystem path, so a segment shaped like a secret makes
/// the durable-text redactor rewrite it and the stored value stop matching the
/// caller's. Hex has nothing for the redactor to detect, and a durable payload
/// carries no path.
#[must_use]
pub fn checkout_identity_digest(identity: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"mc-applicability-checkout-v1\0");
    digest.update(identity.as_bytes());
    format!("{:x}", digest.finalize())
}
