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
        insert_scope_terms(self.tx, &spec.scope_id.text, &spec.terms)?;
        let redactions = spec.text_fields();
        for (name, field) in &redactions {
            record(
                self.tx,
                "scopes",
                &spec.scope_id.text,
                name,
                field,
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
            redactions,
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

fn insert_scope_terms(
    tx: &rusqlite::Transaction<'_>,
    scope_id: &str,
    terms: &[RedactedTerm],
) -> Result<(), KernelError> {
    for (ordinal, term) in terms.iter().enumerate() {
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
        tx.execute(
            "INSERT INTO scope_term(
                 scope_id,ordinal,dimension,operator,exact_value,set_values,range_start,
                 range_end,version_range,git_oid,git_start_oid,git_end_oid,payload
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                scope_id,
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
    Ok(())
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

// ---------------------------------------------------------------------------
// Scope algebra: closed vocabulary, canonical form, and predicates.
// ---------------------------------------------------------------------------

use std::collections::{BTreeMap, BTreeSet};

/// Marker fragment every redaction replacement token carries (for example
/// `<ANTHROPIC_API_KEY_REDACTED>`). A stored scope value containing it is a
/// redaction placeholder: distinct secrets collapse onto one token, so the
/// value can never be compared as an ordinary term value.
const REDACTION_MARKER: &str = "_REDACTED>";

fn contains_redaction_placeholder(value: &str) -> bool {
    value.contains(REDACTION_MARKER)
}

/// The ten bounded scope dimensions. Stored strings are exactly the
/// `as_str` values; anything else fails decode (fail closed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Dimension {
    Domain,
    Project,
    Entity,
    Branch,
    Environment,
    Region,
    Deployment,
    RequestClass,
    CallerClass,
    Platform,
}

impl Dimension {
    pub const ALL: [Dimension; 10] = [
        Dimension::Domain,
        Dimension::Project,
        Dimension::Entity,
        Dimension::Branch,
        Dimension::Environment,
        Dimension::Region,
        Dimension::Deployment,
        Dimension::RequestClass,
        Dimension::CallerClass,
        Dimension::Platform,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Domain => "domain",
            Self::Project => "project",
            Self::Entity => "entity",
            Self::Branch => "branch",
            Self::Environment => "environment",
            Self::Region => "region",
            Self::Deployment => "deployment",
            Self::RequestClass => "request_class",
            Self::CallerClass => "caller_class",
            Self::Platform => "platform",
        }
    }

    pub fn from_stored(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|dimension| dimension.as_str() == value)
    }
}

/// One decoded scope term value. `RedactedPlaceholder` captures values the
/// write path already replaced with a redaction token: they are unresolvable
/// inputs, never ordinary exact values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermValue {
    Exact(String),
    Set(BTreeSet<String>),
    /// Half-open `[start, end)` over the dimension's value domain
    /// (lexicographic byte order). `None` = unbounded on that side.
    Range {
        start: Option<String>,
        end: Option<String>,
    },
    /// Raw semver requirement string, validated at decode time.
    VersionRange(String),
    /// Lower-hex commit OID whose descendant cone is the value set.
    GitReachable(String),
    RedactedPlaceholder,
}

/// Why a scope failed to decode into canonical form. Malformed scopes
/// evaluate uncertain and never match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeFormError {
    UnknownDimension(String),
    UnknownOperator(String),
    DuplicateDimension(Dimension),
    MissingValue(Dimension),
    ConflictingColumns(Dimension),
    InvalidRange(Dimension),
    InvalidVersionRange(Dimension),
    InvalidOid(Dimension),
    EmptySet(Dimension),
}

impl std::fmt::Display for ScopeFormError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownDimension(value) => write!(f, "unknown scope dimension {value:?}"),
            Self::UnknownOperator(value) => write!(f, "unknown scope operator {value:?}"),
            Self::DuplicateDimension(dimension) => {
                write!(f, "duplicate scope dimension {}", dimension.as_str())
            }
            Self::MissingValue(dimension) => {
                write!(f, "scope term on {} has no value", dimension.as_str())
            }
            Self::ConflictingColumns(dimension) => write!(
                f,
                "scope term on {} sets columns its operator does not own",
                dimension.as_str()
            ),
            Self::InvalidRange(dimension) => {
                write!(
                    f,
                    "scope term on {} has an invalid range",
                    dimension.as_str()
                )
            }
            Self::InvalidVersionRange(dimension) => write!(
                f,
                "scope term on {} has an unparseable version range",
                dimension.as_str()
            ),
            Self::InvalidOid(dimension) => {
                write!(
                    f,
                    "scope term on {} has an invalid git OID",
                    dimension.as_str()
                )
            }
            Self::EmptySet(dimension) => {
                write!(f, "scope term on {} has an empty set", dimension.as_str())
            }
        }
    }
}

impl std::error::Error for ScopeFormError {}

/// Canonical scope: at most one term per dimension, ordered by dimension.
/// The only constructor is `from_term_specs`, so every value of this type
/// is canonical by construction and predicates can require it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalScope {
    terms: BTreeMap<Dimension, TermValue>,
}

impl CanonicalScope {
    /// Decodes raw term rows (any order) into canonical form. Duplicate
    /// dimensions, unknown vocabulary, and undecodable payloads are
    /// malformed.
    pub fn from_term_specs(terms: &[ScopeTermSpec]) -> Result<Self, ScopeFormError> {
        let mut canonical = BTreeMap::new();
        for term in terms {
            let dimension = Dimension::from_stored(&term.dimension)
                .ok_or_else(|| ScopeFormError::UnknownDimension(term.dimension.clone()))?;
            let value = decode_term_value(dimension, term)?;
            if canonical.insert(dimension, value).is_some() {
                return Err(ScopeFormError::DuplicateDimension(dimension));
            }
        }
        Ok(Self { terms: canonical })
    }

    /// The empty scope constrains nothing and matches every context.
    pub fn unconstrained() -> Self {
        Self {
            terms: BTreeMap::new(),
        }
    }

    pub fn terms(&self) -> impl Iterator<Item = (Dimension, &TermValue)> {
        self.terms
            .iter()
            .map(|(dimension, value)| (*dimension, value))
    }

    pub fn term(&self, dimension: Dimension) -> Option<&TermValue> {
        self.terms.get(&dimension)
    }

    fn has_placeholder(&self) -> bool {
        self.terms
            .values()
            .any(|value| matches!(value, TermValue::RedactedPlaceholder))
    }
}

fn is_lower_hex_oid(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn decode_term_value(
    dimension: Dimension,
    term: &ScopeTermSpec,
) -> Result<TermValue, ScopeFormError> {
    let extra_columns = |allowed: [bool; 6]| -> bool {
        let present = [
            term.exact_value.is_some(),
            term.set_values.is_some(),
            term.range_start.is_some() || term.range_end.is_some(),
            term.version_range.is_some(),
            term.git_oid.is_some(),
            term.git_start_oid.is_some() || term.git_end_oid.is_some(),
        ];
        present
            .iter()
            .zip(allowed.iter())
            .any(|(present, allowed)| *present && !*allowed)
    };
    match term.operator.as_str() {
        "exact" => {
            if extra_columns([true, false, false, false, false, false]) {
                return Err(ScopeFormError::ConflictingColumns(dimension));
            }
            let value = term
                .exact_value
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or(ScopeFormError::MissingValue(dimension))?;
            if contains_redaction_placeholder(value) {
                return Ok(TermValue::RedactedPlaceholder);
            }
            Ok(TermValue::Exact(value.to_string()))
        }
        "set" => {
            if extra_columns([false, true, false, false, false, false]) {
                return Err(ScopeFormError::ConflictingColumns(dimension));
            }
            let values = term
                .set_values
                .as_ref()
                .ok_or(ScopeFormError::MissingValue(dimension))?;
            if values.is_empty() || values.iter().any(|value| value.is_empty()) {
                return Err(ScopeFormError::EmptySet(dimension));
            }
            if values
                .iter()
                .any(|value| contains_redaction_placeholder(value))
            {
                return Ok(TermValue::RedactedPlaceholder);
            }
            Ok(TermValue::Set(values.iter().cloned().collect()))
        }
        "range" => {
            if extra_columns([false, false, true, false, false, false]) {
                return Err(ScopeFormError::ConflictingColumns(dimension));
            }
            let start = term.range_start.clone();
            let end = term.range_end.clone();
            if start.is_none() && end.is_none() {
                return Err(ScopeFormError::MissingValue(dimension));
            }
            if start.as_deref() == Some("") || end.as_deref() == Some("") {
                return Err(ScopeFormError::InvalidRange(dimension));
            }
            if let (Some(start), Some(end)) = (&start, &end) {
                if start >= end {
                    return Err(ScopeFormError::InvalidRange(dimension));
                }
            }
            if start.as_deref().is_some_and(contains_redaction_placeholder)
                || end.as_deref().is_some_and(contains_redaction_placeholder)
            {
                return Ok(TermValue::RedactedPlaceholder);
            }
            Ok(TermValue::Range { start, end })
        }
        "version_range" => {
            if extra_columns([false, false, false, true, false, false]) {
                return Err(ScopeFormError::ConflictingColumns(dimension));
            }
            let raw = term
                .version_range
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or(ScopeFormError::MissingValue(dimension))?;
            if semver::VersionReq::parse(raw).is_err() {
                return Err(ScopeFormError::InvalidVersionRange(dimension));
            }
            Ok(TermValue::VersionRange(raw.to_string()))
        }
        "git_reachable" => {
            if extra_columns([false, false, false, false, true, false]) {
                return Err(ScopeFormError::ConflictingColumns(dimension));
            }
            let oid = term
                .git_oid
                .as_deref()
                .ok_or(ScopeFormError::MissingValue(dimension))?;
            if !is_lower_hex_oid(oid) {
                return Err(ScopeFormError::InvalidOid(dimension));
            }
            Ok(TermValue::GitReachable(oid.to_string()))
        }
        other => Err(ScopeFormError::UnknownOperator(other.to_string())),
    }
}

// ---------------------------------------------------------------------------
// Scope predicates.
// ---------------------------------------------------------------------------

/// Answers ancestry questions against a frozen graph snapshot. `None` means
/// the oracle cannot decide the pair (an OID outside the snapshot), which
/// routes the caller into the approximation rule: `scope_subsumes` and
/// `scope_equivalent` under-approximate (false), `scope_overlaps`
/// over-approximates (true), and `scope_matches` reports uncertain.
pub trait GraphOracle {
    /// `Some(true)` when `ancestor` is an ancestor of, or equal to,
    /// `descendant` in the commit DAG.
    fn is_ancestor_or_equal(&self, ancestor: &str, descendant: &str) -> Option<bool>;
}

/// Oracle for callers with no graph: every git comparison is unknown.
pub struct UnknownGraph;

impl GraphOracle for UnknownGraph {
    fn is_ancestor_or_equal(&self, _ancestor: &str, _descendant: &str) -> Option<bool> {
        None
    }
}

/// Three-valued match verdict. `Uncertain` covers unresolvable inputs:
/// redaction placeholders, missing context values, unparseable versions,
/// and graph pairs the oracle cannot decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchOutcome {
    Matches,
    DoesNotMatch,
    Uncertain,
}

impl MatchOutcome {
    fn and(self, other: MatchOutcome) -> MatchOutcome {
        match (self, other) {
            (Self::DoesNotMatch, _) | (_, Self::DoesNotMatch) => Self::DoesNotMatch,
            (Self::Uncertain, _) | (_, Self::Uncertain) => Self::Uncertain,
            _ => Self::Matches,
        }
    }
}

/// Resolved query-side values the scope predicates compare against, one text
/// value per dimension plus the checkout HEAD for git-reachability terms.
/// Values are resolved before predicate evaluation (never ambient state).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeMatchContext {
    values: BTreeMap<Dimension, String>,
    head_commit: Option<String>,
}

impl ScopeMatchContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_value(mut self, dimension: Dimension, value: impl Into<String>) -> Self {
        self.values.insert(dimension, value.into());
        self
    }

    pub fn with_head_commit(mut self, oid: impl Into<String>) -> Self {
        self.head_commit = Some(oid.into());
        self
    }

    pub fn value(&self, dimension: Dimension) -> Option<&str> {
        self.values.get(&dimension).map(String::as_str)
    }
}

/// Coerces a platform-version style string into a semver `Version`: missing
/// minor/patch components pad with zero, a `+build` suffix is dropped, and a
/// non-numeric vendor suffix becomes a pre-release identifier. Returns `None`
/// when no leading numeric component exists.
pub fn coerce_version(raw: &str) -> Option<semver::Version> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(version) = semver::Version::parse(raw) {
        return Some(version);
    }
    let (core, _build) = match raw.split_once('+') {
        Some((core, build)) => (core, Some(build)),
        None => (raw, None),
    };
    let (numeric, suffix) = match core.split_once('-') {
        Some((numeric, suffix)) => (numeric, Some(suffix)),
        None => (core, None),
    };
    let mut components = [0u64; 3];
    let mut count = 0usize;
    let mut trailing_suffix: Option<String> = None;
    for part in numeric.split('.') {
        if count == 3 {
            return None;
        }
        match part.parse::<u64>() {
            Ok(value) => {
                components[count] = value;
                count += 1;
            }
            Err(_) => {
                // A vendor suffix glued to the last numeric component, such
                // as "3ubuntu1", splits into the digits and a pre-release.
                let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
                let rest = &part[digits.len()..];
                if digits.is_empty() || rest.is_empty() {
                    return None;
                }
                components[count] = digits.parse().ok()?;
                count += 1;
                trailing_suffix = Some(rest.trim_start_matches(['-', '.', '_']).to_string());
                break;
            }
        }
    }
    if count == 0 {
        return None;
    }
    let pre_source = trailing_suffix.or_else(|| suffix.map(str::to_string));
    let pre = match pre_source {
        Some(suffix) if !suffix.is_empty() => {
            let sanitized: String = suffix
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                        c
                    } else {
                        '-'
                    }
                })
                .collect();
            semver::Prerelease::new(&sanitized).ok()?
        }
        _ => semver::Prerelease::EMPTY,
    };
    let mut version = semver::Version::new(components[0], components[1], components[2]);
    version.pre = pre;
    Some(version)
}

/// Half-open-ish version interval derived from a conjunctive `VersionReq`.
/// `None` bounds are unbounded. Bounds are `(version, inclusive)`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct VersionInterval {
    lo: Option<(semver::Version, bool)>,
    hi: Option<(semver::Version, bool)>,
}

impl VersionInterval {
    fn full() -> Self {
        Self { lo: None, hi: None }
    }

    fn is_empty(&self) -> bool {
        match (&self.lo, &self.hi) {
            (Some((lo, lo_inc)), Some((hi, hi_inc))) => {
                lo > hi || (lo == hi && !(*lo_inc && *hi_inc))
            }
            _ => false,
        }
    }

    fn intersect(self, other: Self) -> Self {
        let lo = match (self.lo, other.lo) {
            (None, bound) | (bound, None) => bound,
            (Some((a, a_inc)), Some((b, b_inc))) => {
                if a > b || (a == b && !a_inc && b_inc) {
                    Some((a, a_inc))
                } else {
                    Some((b, b_inc))
                }
            }
        };
        let hi = match (self.hi, other.hi) {
            (None, bound) | (bound, None) => bound,
            (Some((a, a_inc)), Some((b, b_inc))) => {
                if a < b || (a == b && !a_inc && b_inc) {
                    Some((a, a_inc))
                } else {
                    Some((b, b_inc))
                }
            }
        };
        Self { lo, hi }
    }

    /// `self` contains `other` as sets of versions.
    fn contains(&self, other: &Self) -> bool {
        if other.is_empty() {
            return true;
        }
        if self.is_empty() {
            return false;
        }
        let lo_ok = match (&self.lo, &other.lo) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some((a, a_inc)), Some((b, b_inc))) => a < b || (a == b && (*a_inc || !*b_inc)),
        };
        let hi_ok = match (&self.hi, &other.hi) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some((a, a_inc)), Some((b, b_inc))) => a > b || (a == b && (*a_inc || !*b_inc)),
        };
        lo_ok && hi_ok
    }

    fn overlaps(&self, other: &Self) -> bool {
        if self.is_empty() || other.is_empty() {
            return false;
        }
        let below =
            |hi: &Option<(semver::Version, bool)>, lo: &Option<(semver::Version, bool)>| match (
                hi, lo,
            ) {
                (Some((hi, hi_inc)), Some((lo, lo_inc))) => {
                    hi < lo || (hi == lo && !(*hi_inc && *lo_inc))
                }
                _ => false,
            };
        !below(&self.hi, &other.lo) && !below(&other.hi, &self.lo)
    }
}

fn next_major(v: u64) -> Option<u64> {
    v.checked_add(1)
}

/// Maps one comparator (with empty pre-release) to an interval. `None` when
/// the comparator shape has no interval reading, which routes callers into
/// the approximation rule.
fn comparator_interval(comparator: &semver::Comparator) -> Option<VersionInterval> {
    use semver::Op;
    if !comparator.pre.is_empty() {
        return None;
    }
    let major = comparator.major;
    let minor = comparator.minor;
    let patch = comparator.patch;
    let version = |ma: u64, mi: u64, pa: u64| semver::Version::new(ma, mi, pa);
    let lo_exact = version(major, minor.unwrap_or(0), patch.unwrap_or(0));
    let interval = match comparator.op {
        Op::Exact | Op::Wildcard => match (minor, patch) {
            (Some(mi), Some(pa)) => VersionInterval {
                lo: Some((version(major, mi, pa), true)),
                hi: Some((version(major, mi, pa), true)),
            },
            (Some(mi), None) => VersionInterval {
                lo: Some((version(major, mi, 0), true)),
                hi: Some((version(major, mi.checked_add(1)?, 0), false)),
            },
            (None, _) => VersionInterval {
                lo: Some((version(major, 0, 0), true)),
                hi: Some((version(next_major(major)?, 0, 0), false)),
            },
        },
        Op::Greater => match (minor, patch) {
            (Some(mi), Some(pa)) => VersionInterval {
                lo: Some((version(major, mi, pa), false)),
                hi: None,
            },
            (Some(mi), None) => VersionInterval {
                lo: Some((version(major, mi.checked_add(1)?, 0), true)),
                hi: None,
            },
            (None, _) => VersionInterval {
                lo: Some((version(next_major(major)?, 0, 0), true)),
                hi: None,
            },
        },
        Op::GreaterEq => VersionInterval {
            lo: Some((lo_exact, true)),
            hi: None,
        },
        Op::Less => VersionInterval {
            lo: None,
            hi: Some((lo_exact, false)),
        },
        Op::LessEq => match (minor, patch) {
            (Some(mi), Some(pa)) => VersionInterval {
                lo: None,
                hi: Some((version(major, mi, pa), true)),
            },
            (Some(mi), None) => VersionInterval {
                lo: None,
                hi: Some((version(major, mi.checked_add(1)?, 0), false)),
            },
            (None, _) => VersionInterval {
                lo: None,
                hi: Some((version(next_major(major)?, 0, 0), false)),
            },
        },
        Op::Tilde => match (minor, patch) {
            (Some(mi), _) => VersionInterval {
                lo: Some((lo_exact, true)),
                hi: Some((version(major, mi.checked_add(1)?, 0), false)),
            },
            (None, _) => VersionInterval {
                lo: Some((lo_exact, true)),
                hi: Some((version(next_major(major)?, 0, 0), false)),
            },
        },
        Op::Caret => {
            let hi = if major > 0 || minor.is_none() {
                version(next_major(major)?, 0, 0)
            } else if minor != Some(0) || patch.is_none() {
                version(0, minor?.checked_add(1)?, 0)
            } else {
                version(0, 0, patch?.checked_add(1)?)
            };
            VersionInterval {
                lo: Some((lo_exact, true)),
                hi: Some((hi, false)),
            }
        }
        _ => return None,
    };
    Some(interval)
}

/// Normalizes a validated requirement string into one interval. `None` when
/// any comparator resists the interval reading (pre-release comparators or
/// unknown operators).
fn version_req_interval(raw: &str) -> Option<VersionInterval> {
    let req = semver::VersionReq::parse(raw).ok()?;
    let mut interval = VersionInterval::full();
    for comparator in &req.comparators {
        interval = interval.intersect(comparator_interval(comparator)?);
    }
    Some(interval)
}

fn version_req_matches(raw: &str, value: &str) -> Option<bool> {
    let req = semver::VersionReq::parse(raw).ok()?;
    let version = coerce_version(value)?;
    Some(req.matches(&version))
}

/// Whether every context matched by `b` is matched by `a`, per the
/// cross-operator matrix. `None` = no decision procedure for the pair.
fn term_subsumes(a: &TermValue, b: &TermValue, oracle: &dyn GraphOracle) -> Option<bool> {
    use TermValue::*;
    match (a, b) {
        (RedactedPlaceholder, _) | (_, RedactedPlaceholder) => None,
        (Exact(u), Exact(v)) => Some(u == v),
        (Exact(u), Set(s)) => Some(s.len() == 1 && s.contains(u)),
        (Exact(_), _) => Some(false),
        (Set(t), Exact(v)) => Some(t.contains(v)),
        (Set(t), Set(s)) => Some(s.is_subset(t)),
        (Set(_), _) => Some(false),
        (Range { start, end }, Exact(v)) => Some(range_contains(start, end, v)),
        (Range { start, end }, Set(s)) => {
            Some(s.iter().all(|value| range_contains(start, end, value)))
        }
        (Range { start: ps, end: pe }, Range { start: rs, end: re }) => {
            Some(range_bound_le(ps, rs) && range_bound_ge(pe, re))
        }
        (Range { .. }, _) => Some(false),
        (VersionRange(q), Exact(v)) => version_req_matches(q, v),
        (VersionRange(q), Set(s)) => {
            let mut all = true;
            for value in s {
                match version_req_matches(q, value) {
                    Some(true) => {}
                    Some(false) => {
                        all = false;
                        break;
                    }
                    None => return None,
                }
            }
            Some(all)
        }
        (VersionRange(q), VersionRange(vr)) => {
            if q == vr {
                return Some(true);
            }
            let outer = version_req_interval(q)?;
            let inner = version_req_interval(vr)?;
            Some(outer.contains(&inner))
        }
        (VersionRange(_), _) => Some(false),
        (GitReachable(h), GitReachable(g)) => {
            if h == g {
                return Some(true);
            }
            // descendants(h) ⊇ descendants(g) exactly when h is an ancestor
            // of g in the DAG.
            oracle.is_ancestor_or_equal(h, g)
        }
        (GitReachable(_), _) => Some(false),
    }
}

/// Whether the two value sets can intersect. `None` = no decision procedure.
fn term_overlaps(a: &TermValue, b: &TermValue, oracle: &dyn GraphOracle) -> Option<bool> {
    use TermValue::*;
    match (a, b) {
        (RedactedPlaceholder, _) | (_, RedactedPlaceholder) => None,
        (Exact(u), Exact(v)) => Some(u == v),
        (Exact(u), Set(s)) | (Set(s), Exact(u)) => Some(s.contains(u)),
        (Exact(u), Range { start, end }) | (Range { start, end }, Exact(u)) => {
            Some(range_contains(start, end, u))
        }
        (Exact(u), VersionRange(q)) | (VersionRange(q), Exact(u)) => version_req_matches(q, u),
        (Set(t), Set(s)) => Some(!t.is_disjoint(s)),
        (Set(s), Range { start, end }) | (Range { start, end }, Set(s)) => {
            Some(s.iter().any(|value| range_contains(start, end, value)))
        }
        (Set(s), VersionRange(q)) | (VersionRange(q), Set(s)) => {
            let mut any = false;
            for value in s {
                match version_req_matches(q, value) {
                    Some(true) => {
                        any = true;
                        break;
                    }
                    Some(false) => {}
                    None => return None,
                }
            }
            Some(any)
        }
        (Range { start: ps, end: pe }, Range { start: rs, end: re }) => {
            Some(ranges_overlap(ps, pe, rs, re))
        }
        (VersionRange(q), VersionRange(vr)) => {
            if q == vr {
                let interval = version_req_interval(q)?;
                return Some(!interval.is_empty());
            }
            let left = version_req_interval(q)?;
            let right = version_req_interval(vr)?;
            Some(left.overlaps(&right))
        }
        (GitReachable(h), GitReachable(g)) => {
            if h == g {
                return Some(true);
            }
            // Cones intersect when either commit is an ancestor of the
            // other; incomparable commits may still share a descendant, so
            // a double-negative is not decidable from ancestry alone.
            match (
                oracle.is_ancestor_or_equal(h, g),
                oracle.is_ancestor_or_equal(g, h),
            ) {
                (Some(true), _) | (_, Some(true)) => Some(true),
                _ => None,
            }
        }
        // Cross-domain pairs (git vs text, range vs version_range) have no
        // shared decision procedure.
        _ => None,
    }
}

fn range_contains(start: &Option<String>, end: &Option<String>, value: &str) -> bool {
    start.as_deref().is_none_or(|start| value >= start)
        && end.as_deref().is_none_or(|end| value < end)
}

/// `a` (a start bound) is at or below `b`. `None` = unbounded start.
fn range_bound_le(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(a), Some(b)) => a <= b,
    }
}

/// `a` (an end bound) is at or above `b`. `None` = unbounded end.
fn range_bound_ge(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(a), Some(b)) => a >= b,
    }
}

fn ranges_overlap(
    a_start: &Option<String>,
    a_end: &Option<String>,
    b_start: &Option<String>,
    b_end: &Option<String>,
) -> bool {
    let starts_before_end = |start: &Option<String>, end: &Option<String>| match (start, end) {
        (Some(start), Some(end)) => start < end,
        _ => true,
    };
    starts_before_end(a_start, b_end) && starts_before_end(b_start, a_end)
}

fn term_matches(
    term: &TermValue,
    dimension: Dimension,
    ctx: &ScopeMatchContext,
    oracle: &dyn GraphOracle,
) -> MatchOutcome {
    if matches!(term, TermValue::RedactedPlaceholder) {
        return MatchOutcome::Uncertain;
    }
    if let TermValue::GitReachable(oid) = term {
        let Some(head) = ctx.head_commit.as_deref() else {
            return MatchOutcome::Uncertain;
        };
        return match oracle.is_ancestor_or_equal(oid, head) {
            Some(true) => MatchOutcome::Matches,
            Some(false) => MatchOutcome::DoesNotMatch,
            None => MatchOutcome::Uncertain,
        };
    }
    let Some(value) = ctx.value(dimension) else {
        return MatchOutcome::Uncertain;
    };
    if contains_redaction_placeholder(value) {
        return MatchOutcome::Uncertain;
    }
    match term {
        TermValue::Exact(expected) => bool_outcome(expected == value),
        TermValue::Set(values) => bool_outcome(values.contains(value)),
        TermValue::Range { start, end } => bool_outcome(range_contains(start, end, value)),
        TermValue::VersionRange(req) => match version_req_matches(req, value) {
            Some(holds) => bool_outcome(holds),
            None => MatchOutcome::Uncertain,
        },
        TermValue::GitReachable(_) | TermValue::RedactedPlaceholder => unreachable!(),
    }
}

fn bool_outcome(value: bool) -> MatchOutcome {
    if value {
        MatchOutcome::Matches
    } else {
        MatchOutcome::DoesNotMatch
    }
}

/// Whether `scope` matches the resolved context: the conjunction of its
/// terms, with absent dimensions matching everything.
pub fn scope_matches(
    scope: &CanonicalScope,
    ctx: &ScopeMatchContext,
    oracle: &dyn GraphOracle,
) -> MatchOutcome {
    scope
        .terms()
        .map(|(dimension, term)| term_matches(term, dimension, ctx, oracle))
        .fold(MatchOutcome::Matches, MatchOutcome::and)
}

/// Sound, not complete: `true` guarantees every context matched by `b` is
/// matched by `a`; pairs without a decision procedure answer `false`.
pub fn scope_subsumes(a: &CanonicalScope, b: &CanonicalScope, oracle: &dyn GraphOracle) -> bool {
    a.terms()
        .all(|(dimension, term_a)| match b.term(dimension) {
            Some(term_b) => term_subsumes(term_a, term_b, oracle).unwrap_or(false),
            // `a` constrains a dimension `b` leaves open: some context outside
            // `a`'s value set matches `b`.
            None => false,
        })
}

/// Over-approximates: `false` guarantees disjoint value sets; pairs without
/// a decision procedure answer `true`.
pub fn scope_overlaps(a: &CanonicalScope, b: &CanonicalScope, oracle: &dyn GraphOracle) -> bool {
    a.terms()
        .all(|(dimension, term_a)| match b.term(dimension) {
            Some(term_b) => term_overlaps(term_a, term_b, oracle).unwrap_or(true),
            None => true,
        })
}

/// Mutual subsumption, with a fast path on canonical-form equality for
/// scopes free of unresolvable placeholder terms.
pub fn scope_equivalent(a: &CanonicalScope, b: &CanonicalScope, oracle: &dyn GraphOracle) -> bool {
    if a == b && !a.has_placeholder() {
        return true;
    }
    scope_subsumes(a, b, oracle) && scope_subsumes(b, a, oracle)
}
