//! Deterministic secret redaction backed by the in-tree scanner.

mod scanner;

use std::{fmt, sync::LazyLock};

use mc_secret_scanner::{
    ConstructionError, LimitExhausted, ScanError, ScanLimits, ScanProfile, Scanner,
};

pub const DETECTOR_ID: &str = "mc-secret-scanner";

/// Longest text `redact_durable_text` can inspect.
///
/// Above this the scan fails and the whole value is replaced by one placeholder,
/// because text that cannot be inspected cannot be shown to be secret-free. A
/// caller that must preserve its content has to reject the value at this length
/// instead of redacting it, since the placeholder is not recoverable.
pub const MAX_REDACTABLE_BYTES: usize = mc_secret_scanner::MAX_INPUT_BYTES;

const LABEL_WORDS: &[&str] = &[
    "key",
    "token",
    "secret",
    "password",
    "auth",
    "authorization",
    "bearer",
    "credential",
];
const LABEL_QUALIFIERS: &[&str] = &[
    "api",
    "access",
    "private",
    "client",
    "auth",
    "authorization",
    "secret",
    "bearer",
    "session",
    "refresh",
    "service",
    "x",
    "openai",
    "anthropic",
    "google",
    "github",
    "huggingface",
    "aws",
    "azure",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detection {
    pub detector_id: &'static str,
    pub secret_type: String,
    pub offset: usize,
    pub length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redaction {
    pub text: String,
    pub detections: Vec<Detection>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedactionErrorKind {
    Construction,
    InputLimit,
    CandidateLimit,
    WorkLimit,
    InvalidSpan,
    UnknownRule,
    /// A field that must stay verbatim was found to hold a secret, so the
    /// write is refused rather than redacted: redaction would alias
    /// distinct values onto one placeholder.
    SecretDetected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RedactionError {
    pub(crate) kind: RedactionErrorKind,
}

impl RedactionError {
    #[must_use]
    pub const fn kind(self) -> RedactionErrorKind {
        self.kind
    }
}

impl fmt::Display for RedactionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self.kind {
            RedactionErrorKind::Construction => "secret redactor construction failed",
            RedactionErrorKind::InputLimit => "secret scan input limit exceeded",
            RedactionErrorKind::CandidateLimit => "secret scan candidate limit exceeded",
            RedactionErrorKind::WorkLimit => "secret scan work limit exceeded",
            RedactionErrorKind::InvalidSpan => "secret scan produced an invalid span",
            RedactionErrorKind::UnknownRule => "secret scan produced an unclassified rule",
            RedactionErrorKind::SecretDetected => "secret-bearing field was rejected",
        })
    }
}

impl std::error::Error for RedactionError {}

impl From<ConstructionError> for RedactionError {
    fn from(_: ConstructionError) -> Self {
        Self {
            kind: RedactionErrorKind::Construction,
        }
    }
}

impl From<ScanError> for RedactionError {
    fn from(error: ScanError) -> Self {
        let kind = match error {
            ScanError::InputLimitExceeded => RedactionErrorKind::InputLimit,
            ScanError::InvalidSpan => RedactionErrorKind::InvalidSpan,
        };
        Self { kind }
    }
}

pub struct Redactor {
    scanner: Scanner,
}

impl Redactor {
    pub fn new() -> Result<Self, RedactionError> {
        Self::with_limits(ScanLimits::default())
    }

    fn with_limits(limits: ScanLimits) -> Result<Self, RedactionError> {
        Ok(Self {
            scanner: Scanner::with_limits(ScanProfile::Comprehensive, limits)?,
        })
    }

    pub fn redact(&self, input: &str) -> Result<Redaction, RedactionError> {
        let report = self.scanner.scan(input)?;
        if let Some(limit) = report.limits_hit {
            return Err(RedactionError {
                kind: match limit {
                    LimitExhausted::Candidates => RedactionErrorKind::CandidateLimit,
                    LimitExhausted::Work => RedactionErrorKind::WorkLimit,
                },
            });
        }
        scanner::redact(input, &report.findings)
    }
}

static REDACTOR: LazyLock<Result<Redactor, RedactionError>> = LazyLock::new(Redactor::new);

/// Transaction bodies carry many fields at once, so they scan under higher
/// candidate and work ceilings than a single durable field. Without them a
/// large transaction would exhaust the default budget and be replaced whole.
const TRANSACTION_SCAN_LIMITS: ScanLimits = ScanLimits {
    max_input_bytes: mc_secret_scanner::MAX_INPUT_BYTES,
    max_candidates: 524_288,
    max_work_bytes: 1024 * 1024 * 1024,
};

const _: () = {
    let default = ScanLimits::DEFAULT;
    assert!(TRANSACTION_SCAN_LIMITS.max_candidates >= default.max_candidates);
    assert!(TRANSACTION_SCAN_LIMITS.max_work_bytes >= default.max_work_bytes);
    assert!(TRANSACTION_SCAN_LIMITS.max_input_bytes >= default.max_input_bytes);
};

static TRANSACTION_REDACTOR: LazyLock<Result<Redactor, RedactionError>> =
    LazyLock::new(|| Redactor::with_limits(TRANSACTION_SCAN_LIMITS));

pub fn redact_durable_text(input: &str) -> Redaction {
    redact_with(&REDACTOR, input)
}

fn redact_with(redactor: &Result<Redactor, RedactionError>, input: &str) -> Redaction {
    match redactor
        .as_ref()
        .map_err(|error| *error)
        .and_then(|redactor| redactor.redact(input))
    {
        Ok(redaction) => redaction,
        Err(_) => Redaction {
            text: "<REDACTED:secret>".to_owned(),
            detections: vec![Detection {
                detector_id: DETECTOR_ID,
                secret_type: "secret".to_owned(),
                offset: 0,
                length: input.len(),
            }],
        },
    }
}

/// Redacts a transaction body under the transaction ceilings. Fails closed
/// the same way `redact_durable_text` does.
pub fn redact_transaction_durable_text(input: &str) -> Redaction {
    redact_with(&TRANSACTION_REDACTOR, input)
}

/// Identifies the detector build that produced a redaction, for the audit
/// receipt a durable write records alongside it.
pub fn detector_revision() -> String {
    REDACTOR.as_ref().map_or_else(
        |_| "unavailable".to_owned(),
        |redactor| {
            let revision = redactor.scanner.revision();
            format!(
                "{}:{}:{}",
                revision.crate_version,
                revision.semantic_digest_version,
                revision.upstream_commit
            )
        },
    )
}

/// Digest of the rule semantics the detector ran, or `None` when the
/// detector could not be built.
pub fn detector_semantic_digest() -> Option<[u8; 32]> {
    REDACTOR
        .as_ref()
        .ok()
        .map(|redactor| redactor.scanner.semantic_digest())
}

/// Refuses `input` when the scanner classifies any of it as secret. Used
/// for fields that must stay verbatim, such as lookup keys and dedup
/// identities, where substituting a placeholder would merge distinct
/// values.
pub fn reject_secret_text(input: &str) -> Result<(), RedactionError> {
    reject(redact_durable_text(input))
}

/// Transaction-ceiling counterpart of `reject_secret_text`.
pub fn reject_transaction_secret_text(input: &str) -> Result<(), RedactionError> {
    reject(redact_transaction_durable_text(input))
}

fn reject(redaction: Redaction) -> Result<(), RedactionError> {
    if redaction.detections.is_empty() {
        Ok(())
    } else {
        Err(RedactionError {
            kind: RedactionErrorKind::SecretDetected,
        })
    }
}

/// Label for a key whose name alone marks its value secret, so a value
/// written under it is replaced even when the scanner finds nothing in it.
/// `None` when the name carries no secret word.
pub fn secret_key_label(key: &str) -> Option<String> {
    key_names_a_secret(key).then(|| redaction_type_for_key(key))
}

/// `key` and `keys` name JSON map entries rather than secrets. They are excluded
/// case-insensitively; `api_key` remains protected.
///
/// Recognition matches [`secret_shaped_json_key`], so a separator-free compound such as
/// `apikey` is protected too. A narrower test leaves that value neither substituted nor
/// refused, because the leaf scanner sees only the value and gains no key context from it.
pub fn protected_json_key_label(key: &str) -> Option<String> {
    secret_shaped_json_key(key).then(|| redaction_type_for_key(key))
}

/// Returns a label only when `key` has a credential qualifier.
///
/// `api_key` and `private_key` carry one.
/// `target_key` and `model_key` reduce to the bare `key` label and name structural rows.
pub fn qualified_secret_key_label(key: &str) -> Option<String> {
    secret_key_label(key).filter(|label| !matches!(label.as_str(), "key" | "keys"))
}

/// Whether a JSON field name has the shape the keyed scanner rules anchor on.
///
/// Keyed rules accept compound keys, unlike [`secret_key_label`].
/// Matching covers segments, the separator-free key, and qualifier-prefixed compounds.
/// Whole label words only: a substring test reads `author` as `auth`.
/// A substring test also misses `passWord`, whose split `pass_word` holds no label word.
///
/// `key` and `keys` are excluded case-insensitively, as in [`protected_json_key_label`].
pub fn secret_shaped_json_key(key: &str) -> bool {
    if matches!(key.to_ascii_lowercase().as_str(), "key" | "keys") {
        return false;
    }
    if key_names_a_secret(key) {
        return true;
    }
    let joined = separate_words(key)
        .to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>();
    if names_a_label_word(&joined) {
        return true;
    }
    LABEL_QUALIFIERS.iter().any(|qualifier| {
        joined
            .strip_prefix(qualifier)
            .is_some_and(names_a_label_word)
    })
}

/// Whether `word` is a label word, tolerating a plural suffix as the segment test does.
fn names_a_label_word(word: &str) -> bool {
    let stem = word.strip_suffix('s').unwrap_or(word);
    LABEL_WORDS.contains(&stem)
}

fn key_names_a_secret(key: &str) -> bool {
    separate_words(key)
        .to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|segment| {
            let stem = segment.strip_suffix('s').unwrap_or(segment);
            LABEL_WORDS.contains(&stem)
        })
}

#[must_use]
pub fn contains_redaction_token(text: &str) -> bool {
    text.contains("_REDACTED>") || text.contains("<REDACTED:")
}

pub const MAX_REDACTION_LABEL_BYTES: usize = 64;

fn redaction_type_for_key(key: &str) -> String {
    let label = separate_words(key)
        .to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|segment| is_label_segment(segment))
        .collect::<Vec<_>>()
        .join("_");
    if label.is_empty() {
        return "secret".to_owned();
    }
    if label.len() <= MAX_REDACTION_LABEL_BYTES {
        return label;
    }
    // Truncate on a segment boundary so the label stays a `_`-joined run of whole label
    // words. Cutting mid-segment would invent a word that no key contained.
    match label[..=MAX_REDACTION_LABEL_BYTES].rfind('_') {
        Some(boundary) if boundary > 0 => label[..boundary].to_owned(),
        _ => "secret".to_owned(),
    }
}

/// Splits camel case so `apiKey` yields the same segments as `api_key`.
fn separate_words(key: &str) -> String {
    let mut separated = String::with_capacity(key.len() + 8);
    let mut previous: Option<char> = None;
    for character in key.chars() {
        if character.is_ascii_uppercase()
            && previous
                .is_some_and(|earlier| earlier.is_ascii_lowercase() || earlier.is_ascii_digit())
        {
            separated.push('_');
        }
        separated.push(character);
        previous = Some(character);
    }
    separated
}

fn is_label_segment(segment: &str) -> bool {
    let stem = segment.strip_suffix('s').unwrap_or(segment);
    LABEL_WORDS.contains(&stem) || LABEL_QUALIFIERS.contains(&segment)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanner_is_the_only_redaction_path() {
        let redaction = redact_durable_text("π password=hunter-two");
        assert_eq!(redaction.text, "π password=<REDACTED:password>");
        assert!(redaction
            .detections
            .iter()
            .all(|detection| detection.detector_id == DETECTOR_ID));
    }

    #[test]
    fn established_key_labels_remain_stable() {
        for (key, expected) in [
            ("x_auth_token", "x_auth_token"),
            ("client_secret", "client_secret"),
            ("aws_secret", "aws_secret"),
            ("apiKey", "api_key"),
            ("apikey", "secret"),
        ] {
            assert_eq!(redaction_type_for_key(key), expected, "{key}");
        }
    }

    #[test]
    fn scanner_limits_fail_closed() {
        let redactor = Redactor::with_limits(ScanLimits {
            max_work_bytes: 1,
            ..ScanLimits::default()
        })
        .unwrap();
        assert_eq!(
            redactor.redact("password=secret").unwrap_err().kind(),
            RedactionErrorKind::WorkLimit
        );
    }

    #[test]
    fn diagnostics_never_include_input() {
        let sentinel = "privacy-sentinel-password=secret";
        let input = format!(
            "{sentinel}{}",
            "x".repeat(mc_secret_scanner::MAX_INPUT_BYTES)
        );
        let error = Redactor::new()
            .unwrap()
            .redact(&input)
            .unwrap_err()
            .to_string();
        assert!(!error.contains(sentinel));
        assert!(!error.contains("secret="));
    }

    #[test]
    fn durable_redaction_hides_the_entire_field_on_scanner_failure() {
        let input = "password=sentinel".repeat(mc_secret_scanner::MAX_INPUT_BYTES);
        let redaction = redact_durable_text(&input);
        assert_eq!(redaction.text, "<REDACTED:secret>");
        assert_eq!(redaction.detections[0].length, input.len());
        assert!(!redaction.text.contains("sentinel"));
    }

    #[test]
    fn secret_shaped_keys_match_whole_label_words() {
        for key in [
            "passWord",
            "apikey",
            "authtoken",
            "api_key",
            "client_secret",
            "Authorization",
            "bearerToken",
        ] {
            assert!(
                secret_shaped_json_key(key),
                "expected {key} to be protected"
            );
        }
        for key in [
            "author",
            "authored_by",
            "key",
            "keys",
            "monkey",
            "keyboard",
            "display_path",
        ] {
            assert!(
                !secret_shaped_json_key(key),
                "expected {key} to stay writable"
            );
        }
    }

    #[test]
    fn only_qualified_key_names_mark_a_credential() {
        for key in [
            "api_key",
            "private_key",
            "access_key",
            "apiKey",
            "aws_secret_access_key",
        ] {
            assert!(
                qualified_secret_key_label(key).is_some(),
                "expected {key} to name a credential"
            );
        }
        for key in [
            "key",
            "keys",
            "last_model_key",
            "lineage_descent_target_key",
            "lineage_descent_source_key",
        ] {
            assert!(
                qualified_secret_key_label(key).is_none(),
                "expected {key} to name a structural row"
            );
        }
    }
}
