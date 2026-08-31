use mc_secret_scanner::{Finding, RuleSource};

use super::{
    redaction_type_for_key, Detection, Redaction, RedactionError, RedactionErrorKind, DETECTOR_ID,
};

struct RuleLabel {
    secret_type: &'static str,
    replacement: &'static str,
}

fn provider_label(rule_id: &str) -> Option<RuleLabel> {
    let (secret_type, replacement) = match rule_id {
        "magic-anthropic-api-key" => ("anthropic_api_key", "<ANTHROPIC_API_KEY_REDACTED>"),
        "magic-openai-api-key" => ("openai_api_key", "<OPENAI_API_KEY_REDACTED>"),
        "magic-github-pat" => ("github_pat", "<GITHUB_PAT_REDACTED>"),
        "magic-github-token" => ("github_token", "<GITHUB_TOKEN_REDACTED>"),
        "magic-huggingface-token" => ("huggingface_token", "<HUGGINGFACE_TOKEN_REDACTED>"),
        "magic-aws-access-key-id" => ("aws_access_key_id", "<AWS_ACCESS_KEY_ID_REDACTED>"),
        "magic-slack-token" => ("slack_token", "<SLACK_TOKEN_REDACTED>"),
        "magic-google-api-key" => ("google_api_key", "<GOOGLE_API_KEY_REDACTED>"),
        "magic-bearer-token" => ("bearer", "<REDACTED:bearer>"),
        "magic-jwt" => ("jwt", "<JWT_REDACTED>"),
        _ => return None,
    };
    Some(RuleLabel {
        secret_type,
        replacement,
    })
}

#[cfg(test)]
const KEYED_RULE_IDS: &[&str] = &[
    "magic-keyed-assignment",
    "magic-keyed-assignment-double-quoted",
    "magic-keyed-assignment-single-quoted",
    "magic-keyed-double-quoted",
    "magic-keyed-single-quoted",
    "magic-keyed-double-single",
    "magic-keyed-single-double",
];

#[cfg(test)]
fn is_known_rule(rule_id: &str) -> bool {
    provider_label(rule_id).is_some() || KEYED_RULE_IDS.contains(&rule_id)
}

#[derive(Debug)]
struct Replacement {
    start: usize,
    end: usize,
    /// Lowest `specificity` wins when findings share a span.
    specificity: u8,
    secret_type: String,
    replacement: String,
}

pub(super) fn redact(input: &str, findings: &[Finding]) -> Result<Redaction, RedactionError> {
    let mut replacements = Vec::with_capacity(findings.len());
    for finding in findings {
        let value = finding.value_span;
        input
            .get(finding.full_span.start()..finding.full_span.end())
            .ok_or_else(invalid_span)?;
        input
            .get(value.start()..value.end())
            .ok_or_else(invalid_span)?;
        let key = match finding.key_span {
            Some(span) => Some(
                input
                    .get(span.start()..span.end())
                    .ok_or_else(invalid_span)?,
            ),
            None => None,
        };
        replacements.push(describe(
            &finding.rule_id,
            finding.rule_source,
            key,
            value.start(),
            value.end(),
        )?);
    }
    replacements
        .sort_by_key(|replacement| (replacement.start, replacement.end, replacement.specificity));
    render(input, replacements)
}

fn describe(
    rule_id: &str,
    source: RuleSource,
    key: Option<&str>,
    start: usize,
    end: usize,
) -> Result<Replacement, RedactionError> {
    if let Some(key) = key {
        let secret_type = redaction_type_for_key(key);
        return Ok(Replacement {
            start,
            end,
            specificity: 0,
            replacement: format!("<REDACTED:{secret_type}>"),
            secret_type,
        });
    }
    if let Some(label) = provider_label(rule_id) {
        return Ok(Replacement {
            start,
            end,
            specificity: 0,
            secret_type: label.secret_type.to_owned(),
            replacement: label.replacement.to_owned(),
        });
    }
    if source == RuleSource::ConservativeOverlay {
        return Err(RedactionError {
            kind: RedactionErrorKind::UnknownRule,
        });
    }
    Ok(Replacement {
        start,
        end,
        specificity: 1,
        secret_type: "secret".to_owned(),
        replacement: "<REDACTED:secret>".to_owned(),
    })
}

fn render(input: &str, replacements: Vec<Replacement>) -> Result<Redaction, RedactionError> {
    let mut text = String::with_capacity(input.len());
    let mut detections = Vec::with_capacity(replacements.len());
    let mut cursor = 0;
    for replacement in replacements {
        if replacement.end <= cursor {
            continue;
        }
        let start = replacement.start.max(cursor);
        text.push_str(input.get(cursor..start).ok_or_else(invalid_span)?);
        text.push_str(&replacement.replacement);
        detections.push(Detection {
            detector_id: DETECTOR_ID,
            secret_type: replacement.secret_type,
            offset: start,
            length: replacement
                .end
                .checked_sub(start)
                .ok_or_else(invalid_span)?,
        });
        cursor = replacement.end;
    }
    text.push_str(input.get(cursor..).ok_or_else(invalid_span)?);
    Ok(Redaction { text, detections })
}

const fn invalid_span() -> RedactionError {
    RedactionError {
        kind: RedactionErrorKind::InvalidSpan,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_overlay_rule_is_classified() {
        let overlay = include_str!("../../../mc-secret-scanner/conservative_overlay.yaml");
        let mut seen = 0;
        for line in overlay.lines() {
            let trimmed = line.trim_start();
            let Some(name) = trimmed
                .strip_prefix("- name:")
                .or_else(|| trimmed.strip_prefix("name:"))
            else {
                continue;
            };
            let name = name.trim().trim_matches('"');
            if !name.starts_with("magic-") {
                continue;
            }
            seen += 1;
            assert!(is_known_rule(name), "unclassified overlay rule: {name}");
        }
        assert!(seen > 0, "overlay exposed no magic-* rules");
    }

    #[test]
    fn unmapped_overlay_rule_is_rejected() {
        assert_eq!(
            describe(
                "magic-renamed-provider",
                RuleSource::ConservativeOverlay,
                None,
                0,
                4
            )
            .unwrap_err()
            .kind(),
            RedactionErrorKind::UnknownRule
        );
    }

    #[test]
    fn unmapped_upstream_rule_uses_the_generic_label() {
        let replacement = describe("age-secret-key", RuleSource::Upstream, None, 0, 4).unwrap();
        assert_eq!(replacement.secret_type, "secret");
        assert_eq!(replacement.replacement, "<REDACTED:secret>");
    }

    #[test]
    fn keyed_finding_without_a_known_label_still_redacts() {
        let replacement = describe(
            "magic-keyed-assignment",
            RuleSource::ConservativeOverlay,
            Some("apikey"),
            0,
            4,
        )
        .unwrap();
        assert_eq!(replacement.secret_type, "secret");
        assert_eq!(replacement.replacement, "<REDACTED:secret>");
    }
}
