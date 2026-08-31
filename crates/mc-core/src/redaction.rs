//! Shared secret vocabulary and deterministic text redaction.

use std::sync::LazyLock;

use regex::Regex;

pub const DETECTOR_ID: &str = "redaction-vocabulary-v1";

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

#[derive(Clone, Copy)]
enum RuleKind {
    Static {
        secret_type: &'static str,
        replacement: &'static str,
    },
    Bearer,
    Keyed,
}

struct Rule {
    regex: Regex,
    kind: RuleKind,
}

impl Rule {
    fn static_pattern(pattern: &str, secret_type: &'static str, replacement: &'static str) -> Self {
        Self {
            regex: Regex::new(pattern).expect("redaction regex is valid"),
            kind: RuleKind::Static {
                secret_type,
                replacement,
            },
        }
    }
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    vec![
        Rule::static_pattern(
            r"\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{32,}",
            "anthropic_api_key",
            "<ANTHROPIC_API_KEY_REDACTED>",
        ),
        Rule::static_pattern(
            r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}",
            "openai_api_key",
            "<OPENAI_API_KEY_REDACTED>",
        ),
        Rule::static_pattern(
            r"\bgithub_pat_[A-Za-z0-9_]{20,}",
            "github_pat",
            "<GITHUB_PAT_REDACTED>",
        ),
        Rule::static_pattern(
            r"\b(?:gh[opsu]|ghr)_[A-Za-z0-9]{30,}",
            "github_token",
            "<GITHUB_TOKEN_REDACTED>",
        ),
        Rule::static_pattern(
            r"\bhf_[A-Za-z0-9]{30,}",
            "huggingface_token",
            "<HUGGINGFACE_TOKEN_REDACTED>",
        ),
        Rule::static_pattern(
            r"\b(?:AKIA|ASIA)[0-9A-Z]{16}",
            "aws_access_key_id",
            "<AWS_ACCESS_KEY_ID_REDACTED>",
        ),
        Rule::static_pattern(
            r"\bxox[abprsuvc]-[A-Za-z0-9-]{10,}",
            "slack_token",
            "<SLACK_TOKEN_REDACTED>",
        ),
        Rule::static_pattern(
            r"\bAIza[A-Za-z0-9_-]{35}",
            "google_api_key",
            "<GOOGLE_API_KEY_REDACTED>",
        ),
        Rule {
            regex: Regex::new(
                r"(?i)\bAuthorization\s*:\s*Bearer\s+(?P<value>[A-Za-z0-9._~+/=-]{8,})",
            )
            .expect("bearer regex is valid"),
            kind: RuleKind::Bearer,
        },
        Rule::static_pattern(
            r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            "jwt",
            "<JWT_REDACTED>",
        ),
        Rule {
            regex: Regex::new(
                r#"(?i)"(?P<key>[^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*)"\s*:\s*"(?P<value>[^"']*)""#,
            )
            .expect("double-quoted keyed regex is valid"),
            kind: RuleKind::Keyed,
        },
        Rule {
            regex: Regex::new(
                r#"(?i)'(?P<key>[^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*)'\s*:\s*'(?P<value>[^"']*)'"#,
            )
            .expect("single-quoted keyed regex is valid"),
            kind: RuleKind::Keyed,
        },
        Rule {
            regex: Regex::new(
                r#"(?i)"(?P<key>[^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*)"\s*:\s*'(?P<value>[^"']*)'"#,
            )
            .expect("double-single keyed regex is valid"),
            kind: RuleKind::Keyed,
        },
        Rule {
            regex: Regex::new(
                r#"(?i)'(?P<key>[^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*)'\s*:\s*"(?P<value>[^"']*)""#,
            )
            .expect("single-double keyed regex is valid"),
            kind: RuleKind::Keyed,
        },
        Rule {
            regex: Regex::new(
                r#"(?i)\b(?P<key>[A-Za-z0-9_.-]*(?:key|token|secret|password|auth|bearer|credential)[A-Za-z0-9_.-]*)\s*=\s*(?P<value>[^\s'"`]+)"#,
            )
            .expect("assignment regex is valid"),
            kind: RuleKind::Keyed,
        },
    ]
});

static SCALAR_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$").expect("scalar diagnostic regex is valid")
});

struct Candidate {
    start: usize,
    end: usize,
    context_start: usize,
    precedence: usize,
    secret_type: String,
    replacement: String,
}

#[must_use]
pub fn redact_secret_text(input: &str) -> Redaction {
    let mut candidates = Vec::new();

    for (precedence, rule) in RULES.iter().enumerate() {
        for captures in rule.regex.captures_iter(input) {
            let whole = captures.get(0).expect("every capture has a whole match");
            let (matched, secret_type, replacement) = match rule.kind {
                RuleKind::Static {
                    secret_type,
                    replacement,
                } => (whole, secret_type.to_owned(), replacement.to_owned()),
                RuleKind::Bearer => (
                    captures
                        .name("value")
                        .expect("bearer rule captures its value"),
                    "bearer".to_owned(),
                    "<REDACTED:bearer>".to_owned(),
                ),
                RuleKind::Keyed => {
                    let key = captures.name("key").expect("keyed rule captures its key");
                    let value = captures
                        .name("value")
                        .expect("keyed rule captures its value");
                    if is_non_secret_scalar_value(value.as_str()) {
                        continue;
                    }
                    let secret_type = redaction_type_for_key(key.as_str());
                    let replacement = format!("<REDACTED:{secret_type}>");
                    (value, secret_type, replacement)
                }
            };
            candidates.push(Candidate {
                start: matched.start(),
                end: matched.end(),
                context_start: whole.start(),
                precedence,
                secret_type,
                replacement,
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

    let mut text = String::with_capacity(input.len());
    let mut detections = Vec::new();
    let mut cursor = 0;
    for candidate in candidates {
        if candidate.start < cursor {
            continue;
        }
        text.push_str(&input[cursor..candidate.start]);
        text.push_str(&candidate.replacement);
        detections.push(Detection {
            detector_id: DETECTOR_ID,
            secret_type: candidate.secret_type,
            offset: candidate.start,
            length: candidate.end - candidate.start,
        });
        cursor = candidate.end;
    }
    text.push_str(&input[cursor..]);

    Redaction { text, detections }
}

/// A value containing a replacement token must not participate in equality,
/// matching, or deduplication.
#[must_use]
pub fn contains_redaction_token(text: &str) -> bool {
    text.contains("_REDACTED>") || text.contains("<REDACTED:")
}

fn is_non_secret_scalar_value(value: &str) -> bool {
    let value = value.trim();
    matches!(value, "true" | "false" | "null" | "undefined") || SCALAR_VALUE.is_match(value)
}

fn redaction_type_for_key(key: &str) -> String {
    const SECRET_WORDS: &[&str] = &[
        "key",
        "keys",
        "token",
        "tokens",
        "secret",
        "secrets",
        "password",
        "passwords",
        "auth",
        "auths",
        "authorization",
        "authorizations",
        "bearer",
        "bearers",
        "credential",
        "credentials",
    ];
    const QUALIFIERS: &[&str] = &[
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

    let normalized = key
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let vocabulary = normalized
        .split('_')
        .filter(|segment| SECRET_WORDS.contains(segment) || QUALIFIERS.contains(segment))
        .collect::<Vec<_>>();
    if vocabulary.is_empty() {
        "secret".to_owned()
    } else {
        vocabulary.join("_")
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Vocabulary {
        schema: String,
        cases: Vec<FixtureCase>,
        exemptions: Vec<String>,
        known_misses: Vec<String>,
    }

    #[derive(Deserialize)]
    struct FixtureCase {
        name: String,
        input: String,
        expected_redacted: String,
        detections: Vec<FixtureDetection>,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct FixtureDetection {
        secret_type: String,
        offset: usize,
        length: usize,
    }

    fn vocabulary() -> Vocabulary {
        serde_json::from_str(include_str!(
            "../../../packages/plugin/src/shared/fixtures/redaction-vocabulary-v1.json"
        ))
        .expect("shared redaction fixture is valid")
    }

    #[test]
    fn shared_vocabulary_matches() {
        let vocabulary = vocabulary();
        assert_eq!(vocabulary.schema, "magic-context.redaction-vocabulary/v1");

        for fixture in vocabulary.cases {
            let result = redact_secret_text(&fixture.input);
            assert_eq!(result.text, fixture.expected_redacted, "{}", fixture.name);
            let actual: Vec<_> = result
                .detections
                .iter()
                .map(|detection| FixtureDetection {
                    secret_type: detection.secret_type.clone(),
                    offset: detection.offset,
                    length: detection.length,
                })
                .collect();
            assert_eq!(actual, fixture.detections, "{}", fixture.name);
            assert!(result
                .detections
                .iter()
                .all(|detection| detection.detector_id == DETECTOR_ID));
        }
    }

    #[test]
    fn every_fixture_replacement_is_detected_as_a_redaction_token() {
        let vocabulary = vocabulary();
        for fixture in vocabulary.cases {
            let result = redact_secret_text(&fixture.input);
            if result.detections.is_empty() {
                continue;
            }
            assert!(
                contains_redaction_token(&result.text),
                "{}: redacted output {:?} not recognized as a placeholder",
                fixture.name,
                result.text
            );
        }
    }

    #[test]
    fn scalar_exemptions_and_known_misses_remain_unchanged() {
        let vocabulary = vocabulary();
        for input in vocabulary
            .exemptions
            .into_iter()
            .chain(vocabulary.known_misses)
        {
            assert_eq!(redact_secret_text(&input).text, input);
        }
    }
}
