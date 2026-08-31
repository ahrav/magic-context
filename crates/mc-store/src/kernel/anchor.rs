//! Anchor vocabulary, typed query context, and non-git anchor evaluation.
//!
//! An anchor row is one complete effective condition. Non-git kinds evaluate
//! against an explicit [`QueryContext`] — never ambient process state. The
//! git-dependent kinds (`reachable_from`, `reachable_between`) decode into a
//! [`GitCondition`] the applicability engine resolves against a checkout
//! snapshot.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::scope::coerce_version;

/// Schema tag for capture-time anchor representations stored in the frozen
/// `anchors.payload` BLOB. The fallback ladder matches a fresh checkout
/// capture against this stored representation.
pub const ANCHOR_CAPTURE_SCHEMA: &str = "mc.anchor.capture.v1";

/// The seven anchor kinds. Stored strings are exactly the `as_str` values;
/// unknown stored kinds fail decode and evaluate uncertain (fail closed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AnchorKind {
    Exact,
    ReachableFrom,
    ReachableBetween,
    DeploymentRevision,
    ConfigRevision,
    PlatformVersion,
    WallClockInterval,
}

impl AnchorKind {
    pub const ALL: [AnchorKind; 7] = [
        AnchorKind::Exact,
        AnchorKind::ReachableFrom,
        AnchorKind::ReachableBetween,
        AnchorKind::DeploymentRevision,
        AnchorKind::ConfigRevision,
        AnchorKind::PlatformVersion,
        AnchorKind::WallClockInterval,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::ReachableFrom => "reachable_from",
            Self::ReachableBetween => "reachable_between",
            Self::DeploymentRevision => "deployment_revision",
            Self::ConfigRevision => "config_revision",
            Self::PlatformVersion => "platform_version",
            Self::WallClockInterval => "wall_clock_interval",
        }
    }

    pub fn from_stored(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }
}

/// Raw anchor columns as stored in the frozen `anchors` table.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AnchorRowSpec {
    pub anchor_id: String,
    pub anchor_kind: String,
    pub exact_value: Option<String>,
    pub reachable_from_oid: Option<String>,
    pub reachable_between_start_oid: Option<String>,
    pub reachable_between_end_oid: Option<String>,
    pub deployment_revision: Option<String>,
    pub config_revision: Option<String>,
    pub platform_version_range: Option<String>,
    pub wall_clock_start: Option<i64>,
    pub wall_clock_end: Option<i64>,
    pub payload: Option<Vec<u8>>,
}

/// Capture-time representation of one anchored commit (KTD2 fallback data):
/// written at anchor authoring, matched against fresh checkout captures by
/// the resolution ladder. Anchors without a stored patch-ID skip that rung.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnchorCapture {
    pub commit_oid: String,
    #[serde(default)]
    pub tree_oid: Option<String>,
    #[serde(default)]
    pub patch_id: Option<PatchIdCapture>,
    #[serde(default)]
    pub changed_paths: Vec<String>,
}

/// Version-tagged patch identity. Values are internal fallback keys, never
/// interchangeable with `git patch-id` output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchIdCapture {
    pub algorithm: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct AnchorCapturePayload {
    schema: String,
    #[serde(default)]
    captures: Vec<AnchorCapture>,
}

/// Decoded, typed anchor condition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnchorCondition {
    Exact {
        value: String,
    },
    Git(GitCondition),
    DeploymentRevision {
        revision: String,
    },
    ConfigRevision {
        revision: String,
    },
    PlatformVersion {
        range: String,
    },
    /// Half-open `[start, end)` in UTC milliseconds.
    WallClockInterval {
        start_ms: i64,
        end_ms: i64,
    },
}

/// Git-dependent condition the applicability engine resolves against a
/// checkout snapshot; carries capture-time representations for the fallback
/// ladder, keyed by anchored commit OID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitCondition {
    ReachableFrom {
        oid: String,
        captures: BTreeMap<String, AnchorCapture>,
    },
    /// Holds when `start` is reachable and `end` is not (half-open), decided
    /// by two independent ancestry tests, never a selected merge base.
    ReachableBetween {
        start_oid: String,
        end_oid: String,
        captures: BTreeMap<String, AnchorCapture>,
    },
}

/// Why an anchor row failed to decode. Undecodable anchors evaluate
/// uncertain, never current.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnchorDecodeError {
    UnknownKind(String),
    MissingValue(AnchorKind),
    InvalidOid(AnchorKind),
    InvalidVersionRange,
    InvalidInterval,
}

impl std::fmt::Display for AnchorDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownKind(value) => write!(f, "unknown anchor kind {value:?}"),
            Self::MissingValue(kind) => {
                write!(f, "anchor kind {} has no value", kind.as_str())
            }
            Self::InvalidOid(kind) => {
                write!(f, "anchor kind {} has an invalid git OID", kind.as_str())
            }
            Self::InvalidVersionRange => {
                f.write_str("anchor platform version range is unparseable")
            }
            Self::InvalidInterval => f.write_str("anchor wall-clock interval is not half-open"),
        }
    }
}

impl std::error::Error for AnchorDecodeError {}

fn is_lower_hex_oid(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn decode_captures(payload: Option<&[u8]>) -> BTreeMap<String, AnchorCapture> {
    // A missing or unreadable capture payload only disables the fallback
    // rungs; the primary OID and ancestry rungs still decide the anchor.
    let Some(payload) = payload else {
        return BTreeMap::new();
    };
    let Ok(decoded) = serde_json::from_slice::<AnchorCapturePayload>(payload) else {
        return BTreeMap::new();
    };
    if decoded.schema != ANCHOR_CAPTURE_SCHEMA {
        return BTreeMap::new();
    }
    decoded
        .captures
        .into_iter()
        .map(|capture| (capture.commit_oid.clone(), capture))
        .collect()
}

/// Serializes capture representations into the anchor payload shape the
/// decoder reads back. Anchor-authoring fixtures write this at capture time.
pub fn encode_anchor_captures(captures: &[AnchorCapture]) -> Vec<u8> {
    serde_json::to_vec(&AnchorCapturePayload {
        schema: ANCHOR_CAPTURE_SCHEMA.to_string(),
        captures: captures.to_vec(),
    })
    .expect("capture payload is serializable")
}

impl AnchorCondition {
    pub fn decode(row: &AnchorRowSpec) -> Result<Self, AnchorDecodeError> {
        let kind = AnchorKind::from_stored(&row.anchor_kind)
            .ok_or_else(|| AnchorDecodeError::UnknownKind(row.anchor_kind.clone()))?;
        let require = |value: &Option<String>| -> Result<String, AnchorDecodeError> {
            value
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .ok_or(AnchorDecodeError::MissingValue(kind))
        };
        let require_oid = |value: &Option<String>| -> Result<String, AnchorDecodeError> {
            let value = require(value)?;
            if !is_lower_hex_oid(&value) {
                return Err(AnchorDecodeError::InvalidOid(kind));
            }
            Ok(value)
        };
        match kind {
            AnchorKind::Exact => Ok(Self::Exact {
                value: require(&row.exact_value)?,
            }),
            AnchorKind::ReachableFrom => Ok(Self::Git(GitCondition::ReachableFrom {
                oid: require_oid(&row.reachable_from_oid)?,
                captures: decode_captures(row.payload.as_deref()),
            })),
            AnchorKind::ReachableBetween => Ok(Self::Git(GitCondition::ReachableBetween {
                start_oid: require_oid(&row.reachable_between_start_oid)?,
                end_oid: require_oid(&row.reachable_between_end_oid)?,
                captures: decode_captures(row.payload.as_deref()),
            })),
            AnchorKind::DeploymentRevision => Ok(Self::DeploymentRevision {
                revision: require(&row.deployment_revision)?,
            }),
            AnchorKind::ConfigRevision => Ok(Self::ConfigRevision {
                revision: require(&row.config_revision)?,
            }),
            AnchorKind::PlatformVersion => {
                let range = require(&row.platform_version_range)?;
                if semver::VersionReq::parse(&range).is_err() {
                    return Err(AnchorDecodeError::InvalidVersionRange);
                }
                Ok(Self::PlatformVersion { range })
            }
            AnchorKind::WallClockInterval => {
                let (Some(start_ms), Some(end_ms)) = (row.wall_clock_start, row.wall_clock_end)
                else {
                    return Err(AnchorDecodeError::MissingValue(kind));
                };
                if start_ms >= end_ms {
                    return Err(AnchorDecodeError::InvalidInterval);
                }
                Ok(Self::WallClockInterval { start_ms, end_ms })
            }
        }
    }
}

/// Explicit, typed query-side inputs for non-git anchor evaluation. A field
/// left `None` makes anchors needing it evaluate uncertain, never false.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueryContext {
    pub deployment_revision: Option<String>,
    pub config_revision: Option<String>,
    pub platform_version: Option<String>,
    /// Query instant in UTC milliseconds for wall-clock intervals.
    pub query_instant_ms: Option<i64>,
    /// Opaque token `exact` anchors compare against.
    pub exact_token: Option<String>,
}

/// Verdict for one anchor condition against one query context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorEvaluation {
    Holds,
    /// The condition definitely does not hold. `historical` marks conditions
    /// whose validity window has been exited (interval end reached), as
    /// opposed to a context that simply differs.
    DoesNotHold {
        historical: bool,
    },
    /// Missing context, unparseable values: never a match, never a failure.
    Uncertain,
    /// Git-dependent condition; the applicability engine resolves it against
    /// a checkout snapshot.
    NeedsGitResolution,
}

/// Evaluates a non-git anchor condition against the typed context. Git
/// conditions report [`AnchorEvaluation::NeedsGitResolution`].
pub fn evaluate_non_git(condition: &AnchorCondition, ctx: &QueryContext) -> AnchorEvaluation {
    let compare = |expected: &str, actual: &Option<String>| match actual.as_deref() {
        Some(actual) => holds(actual == expected),
        None => AnchorEvaluation::Uncertain,
    };
    match condition {
        AnchorCondition::Git(_) => AnchorEvaluation::NeedsGitResolution,
        AnchorCondition::Exact { value } => compare(value, &ctx.exact_token),
        AnchorCondition::DeploymentRevision { revision } => {
            compare(revision, &ctx.deployment_revision)
        }
        AnchorCondition::ConfigRevision { revision } => compare(revision, &ctx.config_revision),
        AnchorCondition::PlatformVersion { range } => {
            let Some(raw) = ctx.platform_version.as_deref() else {
                return AnchorEvaluation::Uncertain;
            };
            let Some(version) = coerce_version(raw) else {
                return AnchorEvaluation::Uncertain;
            };
            let Ok(req) = semver::VersionReq::parse(range) else {
                return AnchorEvaluation::Uncertain;
            };
            holds(req.matches(&version))
        }
        AnchorCondition::WallClockInterval { start_ms, end_ms } => {
            let Some(instant) = ctx.query_instant_ms else {
                return AnchorEvaluation::Uncertain;
            };
            if instant >= *end_ms {
                AnchorEvaluation::DoesNotHold { historical: true }
            } else if instant < *start_ms {
                AnchorEvaluation::DoesNotHold { historical: false }
            } else {
                AnchorEvaluation::Holds
            }
        }
    }
}

fn holds(value: bool) -> AnchorEvaluation {
    if value {
        AnchorEvaluation::Holds
    } else {
        AnchorEvaluation::DoesNotHold { historical: false }
    }
}
