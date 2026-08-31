//! Deterministic secret redaction backed by the in-tree scanner.

mod scanner;

use std::{fmt, sync::LazyLock};

use mc_secret_scanner::{
    ConstructionError, LimitExhausted, ScanError, ScanLimits, ScanProfile, Scanner,
};

pub const DETECTOR_ID: &str = "mc-secret-scanner";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedactionLabel {
    ApiKey,
    AuthToken,
    Password,
    Key,
    Token,
    Secret,
}

impl RedactionLabel {
    #[must_use]
    pub const fn marker(self) -> &'static str {
        match self {
            Self::ApiKey => "<REDACTED:api_key>",
            Self::AuthToken => "<REDACTED:auth_token>",
            Self::Password => "<REDACTED:password>",
            Self::Key => "<REDACTED:key>",
            Self::Token => "<REDACTED:token>",
            Self::Secret => "<REDACTED:secret>",
        }
    }
}

fn is_secret_key_word(word: &str) -> bool {
    matches!(
        word,
        "key"
            | "keys"
            | "token"
            | "tokens"
            | "secret"
            | "secrets"
            | "password"
            | "passwords"
            | "auth"
            | "authorization"
            | "bearer"
            | "credential"
            | "credentials"
    )
}

#[must_use]
pub fn label_for_secret_key(key: &str) -> Option<RedactionLabel> {
    let words = key_tokens(key);
    if !words.iter().any(|word| is_secret_key_word(word)) {
        return None;
    }
    if words.iter().any(|word| word == "api")
        && words
            .iter()
            .any(|word| matches!(word.as_str(), "key" | "keys"))
    {
        Some(RedactionLabel::ApiKey)
    } else if words
        .iter()
        .any(|word| matches!(word.as_str(), "auth" | "authorization"))
        && words
            .iter()
            .any(|word| matches!(word.as_str(), "token" | "tokens"))
    {
        Some(RedactionLabel::AuthToken)
    } else if words
        .iter()
        .any(|word| matches!(word.as_str(), "password" | "passwords"))
    {
        Some(RedactionLabel::Password)
    } else if words
        .iter()
        .any(|word| matches!(word.as_str(), "key" | "keys"))
    {
        Some(RedactionLabel::Key)
    } else if words
        .iter()
        .any(|word| matches!(word.as_str(), "token" | "tokens"))
    {
        Some(RedactionLabel::Token)
    } else {
        Some(RedactionLabel::Secret)
    }
}

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
    pub detector_revision: String,
    pub rule_id: String,
    pub exactness: DetectionExactness,
    pub span_kind: DetectionSpanKind,
    pub action: DetectionAction,
    pub secret_type: String,
    pub offset: usize,
    pub length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redaction {
    pub text: String,
    pub detections: Vec<Detection>,
    pub provenance: ScanProvenance,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetectionExactness {
    Exact,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetectionSpanKind {
    Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetectionAction {
    Substitute,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanProvenance {
    pub detector_id: &'static str,
    pub detector_revision: String,
    pub semantic_digest: Option<[u8; 32]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedactionErrorKind {
    Construction,
    InputLimit,
    CandidateLimit,
    WorkLimit,
    InvalidSpan,
    UnknownRule,
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
        scanner::redact(input, report)
    }
}

static REDACTOR: LazyLock<Result<Redactor, RedactionError>> = LazyLock::new(Redactor::new);

pub fn redact_durable_text(input: &str) -> Result<Redaction, RedactionError> {
    REDACTOR
        .as_ref()
        .map_err(|error| *error)
        .and_then(|redactor| redactor.redact(input))
}

pub fn redact_transaction_durable_text(input: &str) -> Result<Redaction, RedactionError> {
    redact_durable_text(input)
}

pub fn reject_secret_text(input: &str) -> Result<(), RedactionError> {
    reject_redaction(redact_durable_text(input)?)
}

pub fn reject_transaction_secret_text(input: &str) -> Result<(), RedactionError> {
    reject_secret_text(input)
}

fn reject_redaction(redaction: Redaction) -> Result<(), RedactionError> {
    if redaction.detections.is_empty() {
        Ok(())
    } else {
        Err(RedactionError {
            kind: RedactionErrorKind::SecretDetected,
        })
    }
}

#[must_use]
pub fn contains_redaction_token(text: &str) -> bool {
    text.contains("_REDACTED>") || text.contains("<REDACTED:")
}

fn redaction_type_for_key(key: &str) -> String {
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

    let label = separated
        .to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|segment| is_label_segment(segment))
        .collect::<Vec<_>>()
        .join("_");
    if label.is_empty() {
        "secret".to_owned()
    } else {
        label
    }
}

fn key_tokens(key: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for part in key.split(|character: char| !character.is_ascii_alphanumeric()) {
        let bytes = part.as_bytes();
        let mut start = 0;
        for index in 1..bytes.len() {
            if bytes[index].is_ascii_uppercase()
                && (bytes[index - 1].is_ascii_lowercase()
                    || bytes.get(index + 1).is_some_and(u8::is_ascii_lowercase))
            {
                tokens.push(part[start..index].to_ascii_lowercase());
                start = index;
            }
        }
        if start < part.len() {
            tokens.push(part[start..].to_ascii_lowercase());
        }
    }
    tokens
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
        let redaction = redact_durable_text("π password=hunter-two").unwrap();
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
    fn durable_redaction_rejects_scanner_failure() {
        let input = "password=sentinel".repeat(mc_secret_scanner::MAX_INPUT_BYTES);
        assert_eq!(
            redact_durable_text(&input).unwrap_err().kind(),
            RedactionErrorKind::InputLimit
        );
    }
}
