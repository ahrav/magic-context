use std::sync::LazyLock;

use regex::Regex;

use super::{Detection, Redaction, RedactionError, RedactionErrorKind, DETECTOR_ID};
use super::{DetectionAction, DetectionExactness, DetectionSpanKind, ScanProvenance};

#[derive(Clone, Copy)]
enum RuleKind {
    Static(RedactionLabel),
    Bearer,
    Keyed,
}

struct Rule {
    id: &'static str,
    regex: Regex,
    kind: RuleKind,
}

impl Rule {
    fn static_pattern(id: &'static str, pattern: &str, label: RedactionLabel) -> Self {
        Self {
            id,
            regex: Regex::new(pattern).expect("redaction regex is valid"),
            kind: RuleKind::Static(label),
        }
    }
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    vec![
        Rule::static_pattern(
            "anthropic-api-key",
            r"\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{32,}",
            RedactionLabel::AnthropicApiKey,
        ),
        Rule::static_pattern(
            "openai-api-key",
            r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}",
            RedactionLabel::OpenAiApiKey,
        ),
        Rule::static_pattern(
            "github-pat",
            r"\bgithub_pat_[A-Za-z0-9_]{20,}",
            RedactionLabel::GithubPat,
        ),
        Rule::static_pattern(
            "github-token",
            r"\b(?:gh[opsu]|ghr)_[A-Za-z0-9]{30,}",
            RedactionLabel::GithubToken,
        ),
        Rule::static_pattern(
            "huggingface-token",
            r"\bhf_[A-Za-z0-9]{30,}",
            RedactionLabel::HuggingFaceToken,
        ),
        Rule::static_pattern(
            "aws-access-key-id",
            r"\b(?:AKIA|ASIA)[0-9A-Z]{16}",
            RedactionLabel::AwsAccessKeyId,
        ),
        Rule::static_pattern(
            "slack-token",
            r"\bxox[abprsuvc]-[A-Za-z0-9-]{10,}",
            RedactionLabel::SlackToken,
        ),
        Rule::static_pattern(
            "google-api-key",
            r"\bAIza[A-Za-z0-9_-]{35}",
            RedactionLabel::GoogleApiKey,
        ),
        Rule {
            id: "bearer-token",
            regex: Regex::new(
                r"(?i)\bAuthorization\s*:\s*Bearer\s+(?P<value>[A-Za-z0-9._~+/=-]{8,})",
            )
            .expect("bearer regex is valid"),
            kind: RuleKind::Bearer,
        },
        Rule::static_pattern(
            "jwt",
            r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            RedactionLabel::Jwt,
        ),
        keyed(
            "keyed-double-double",
            r#"(?i)"(?P<key>[^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*)"\s*:\s*"(?P<value>[^"']*)""#,
        ),
        keyed(
            "keyed-single-single",
            r#"(?i)'(?P<key>[^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*)'\s*:\s*'(?P<value>[^"']*)'"#,
        ),
        keyed(
            "keyed-double-single",
            r#"(?i)"(?P<key>[^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*)"\s*:\s*'(?P<value>[^"']*)'"#,
        ),
        keyed(
            "keyed-single-double",
            r#"(?i)'(?P<key>[^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*)'\s*:\s*"(?P<value>[^"']*)""#,
        ),
        keyed(
            "keyed-assignment",
            r#"(?i)\b(?P<key>[A-Za-z0-9_.-]*(?:key|token|secret|password|auth|bearer|credential)[A-Za-z0-9_.-]*)\s*=\s*(?P<value>[^\s'"`]+)"#,
        ),
    ]
});

fn keyed(id: &'static str, pattern: &str) -> Rule {
    Rule {
        id,
        regex: Regex::new(pattern).expect("keyed redaction regex is valid"),
        kind: RuleKind::Keyed,
    }
}

static SCALAR_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$").expect("scalar regex is valid")
});

pub(super) struct Candidate {
    pub(super) rule_id: String,
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) context_start: usize,
    pub(super) precedence: usize,
    pub(super) label: RedactionLabel,
}

pub(super) fn redact(input: &str) -> Result<Redaction, RedactionError> {
    let mut candidates = Vec::new();
    for (precedence, rule) in RULES.iter().enumerate() {
        for captures in rule.regex.captures_iter(input) {
            let whole = captures.get(0).ok_or_else(invalid_span)?;
            let (matched, label) = match rule.kind {
                RuleKind::Static(label) => (whole, label),
                RuleKind::Bearer => (
                    captures.name("value").ok_or_else(invalid_span)?,
                    RedactionLabel::Bearer,
                ),
                RuleKind::Keyed => {
                    let key = captures.name("key").ok_or_else(invalid_span)?;
                    let value = captures.name("value").ok_or_else(invalid_span)?;
                    if value.is_empty() || is_non_secret_scalar_value(value.as_str()) {
                        continue;
                    }
                    let Some(label) = super::label_for_secret_key(key.as_str()) else {
                        continue;
                    };
                    (value, label)
                }
            };
            candidates.push(Candidate {
                rule_id: rule.id.to_string(),
                start: matched.start(),
                end: matched.end(),
                context_start: whole.start(),
                precedence,
                label,
            });
        }
    }
    candidates.sort_by_key(|candidate| {
        (
            candidate.start,
            candidate.context_start,
            candidate.precedence,
        )
    });
    replace(input, candidates, DETECTOR_ID)
}

pub(super) fn replace(
    input: &str,
    candidates: Vec<Candidate>,
    detector_id: &'static str,
) -> Result<Redaction, RedactionError> {
    let mut text = String::with_capacity(input.len());
    let mut detections = Vec::new();
    let mut cursor = 0;
    for candidate in candidates {
        if candidate.start < cursor {
            continue;
        }
        let unchanged = input
            .get(cursor..candidate.start)
            .ok_or_else(invalid_span)?;
        input
            .get(candidate.start..candidate.end)
            .ok_or_else(invalid_span)?;
        text.push_str(unchanged);
        text.push_str(candidate.label.marker());
        detections.push(Detection {
            detector_id,
            detector_revision: detector_id.to_string(),
            rule_id: candidate.rule_id,
            exactness: DetectionExactness::Exact,
            span_kind: DetectionSpanKind::Value,
            action: DetectionAction::Substitute,
            secret_type: candidate.label.secret_type().to_owned(),
            offset: candidate.start,
            length: candidate
                .end
                .checked_sub(candidate.start)
                .ok_or_else(invalid_span)?,
        });
        cursor = candidate.end;
    }
    text.push_str(input.get(cursor..).ok_or_else(invalid_span)?);
    Ok(Redaction {
        text,
        detections,
        provenance: ScanProvenance {
            detector_id,
            detector_revision: detector_id.to_string(),
            semantic_digest: None,
        },
        comparison: None,
    })
}

fn is_non_secret_scalar_value(value: &str) -> bool {
    let value = value.trim();
    matches!(value, "true" | "false" | "null" | "undefined") || SCALAR_VALUE.is_match(value)
}

pub(super) const fn invalid_span() -> RedactionError {
    RedactionError {
        kind: RedactionErrorKind::InvalidSpan,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedactionLabel {
    AnthropicApiKey,
    OpenAiApiKey,
    GithubPat,
    GithubToken,
    HuggingFaceToken,
    AwsAccessKeyId,
    SlackToken,
    GoogleApiKey,
    Bearer,
    Jwt,
    ApiKey,
    AuthToken,
    Password,
    Key,
    Token,
    Secret,
}

impl RedactionLabel {
    pub(super) fn for_key(key: &str) -> Option<Self> {
        let words = super::key_tokens(key);
        if !words.iter().any(|word| super::is_secret_key_word(word)) {
            return None;
        }
        if words.iter().any(|word| word == "api")
            && words
                .iter()
                .any(|word| matches!(word.as_str(), "key" | "keys"))
        {
            Some(Self::ApiKey)
        } else if words
            .iter()
            .any(|word| matches!(word.as_str(), "auth" | "authorization"))
            && words
                .iter()
                .any(|word| matches!(word.as_str(), "token" | "tokens"))
        {
            Some(Self::AuthToken)
        } else if words
            .iter()
            .any(|word| matches!(word.as_str(), "password" | "passwords"))
        {
            Some(Self::Password)
        } else if words
            .iter()
            .any(|word| matches!(word.as_str(), "key" | "keys"))
        {
            Some(Self::Key)
        } else if words
            .iter()
            .any(|word| matches!(word.as_str(), "token" | "tokens"))
        {
            Some(Self::Token)
        } else {
            Some(Self::Secret)
        }
    }

    pub const fn secret_type(self) -> &'static str {
        match self {
            Self::AnthropicApiKey => "anthropic_api_key",
            Self::OpenAiApiKey => "openai_api_key",
            Self::GithubPat => "github_pat",
            Self::GithubToken => "github_token",
            Self::HuggingFaceToken => "huggingface_token",
            Self::AwsAccessKeyId => "aws_access_key_id",
            Self::SlackToken => "slack_token",
            Self::GoogleApiKey => "google_api_key",
            Self::Bearer => "bearer",
            Self::Jwt => "jwt",
            Self::ApiKey => "api_key",
            Self::AuthToken => "auth_token",
            Self::Password => "password",
            Self::Key => "key",
            Self::Token => "token",
            Self::Secret => "secret",
        }
    }

    pub const fn marker(self) -> &'static str {
        match self {
            Self::AnthropicApiKey => "<ANTHROPIC_API_KEY_REDACTED>",
            Self::OpenAiApiKey => "<OPENAI_API_KEY_REDACTED>",
            Self::GithubPat => "<GITHUB_PAT_REDACTED>",
            Self::GithubToken => "<GITHUB_TOKEN_REDACTED>",
            Self::HuggingFaceToken => "<HUGGINGFACE_TOKEN_REDACTED>",
            Self::AwsAccessKeyId => "<AWS_ACCESS_KEY_ID_REDACTED>",
            Self::SlackToken => "<SLACK_TOKEN_REDACTED>",
            Self::GoogleApiKey => "<GOOGLE_API_KEY_REDACTED>",
            Self::Bearer => "<REDACTED:bearer>",
            Self::Jwt => "<JWT_REDACTED>",
            Self::ApiKey => "<REDACTED:api_key>",
            Self::AuthToken => "<REDACTED:auth_token>",
            Self::Password => "<REDACTED:password>",
            Self::Key => "<REDACTED:key>",
            Self::Token => "<REDACTED:token>",
            Self::Secret => "<REDACTED:secret>",
        }
    }
}
