use mc_secret_scanner::Finding;

use super::{legacy, Redaction, RedactionError, PORTABLE_DETECTOR_ID};

pub(super) fn replace(input: &str, findings: &[Finding]) -> Result<Redaction, RedactionError> {
    let mut candidates = Vec::with_capacity(findings.len());
    for finding in findings {
        let value = finding.value_span;
        let (rule_label, precedence) = rule_metadata(&finding.rule_id);
        input
            .get(value.start()..value.end())
            .ok_or_else(legacy::invalid_span)?;
        let label = match finding.key_span {
            Some(key) => {
                let key = input
                    .get(key.start()..key.end())
                    .ok_or_else(legacy::invalid_span)?;
                let Some(label) = super::label_for_secret_key(key) else {
                    continue;
                };
                label
            }
            None => rule_label,
        };
        candidates.push(legacy::Candidate {
            rule_id: finding.rule_id.clone(),
            start: value.start(),
            end: value.end(),
            context_start: finding.full_span.start(),
            precedence,
            label,
        });
    }
    candidates.sort_by_key(|candidate| {
        (
            candidate.start,
            candidate.context_start,
            candidate.precedence,
        )
    });
    legacy::replace(input, candidates, PORTABLE_DETECTOR_ID)
}

fn rule_metadata(rule_id: &str) -> (legacy::RedactionLabel, usize) {
    match rule_id {
        "magic-anthropic-api-key" => (legacy::RedactionLabel::AnthropicApiKey, 0),
        "magic-openai-api-key" => (legacy::RedactionLabel::OpenAiApiKey, 1),
        "magic-github-pat" => (legacy::RedactionLabel::GithubPat, 2),
        "magic-github-token" => (legacy::RedactionLabel::GithubToken, 3),
        "magic-huggingface-token" => (legacy::RedactionLabel::HuggingFaceToken, 4),
        "magic-aws-access-key-id" => (legacy::RedactionLabel::AwsAccessKeyId, 5),
        "magic-slack-token" => (legacy::RedactionLabel::SlackToken, 6),
        "magic-google-api-key" => (legacy::RedactionLabel::GoogleApiKey, 7),
        "magic-bearer-token" => (legacy::RedactionLabel::Bearer, 8),
        "magic-jwt" => (legacy::RedactionLabel::Jwt, 9),
        _ => (legacy::RedactionLabel::Secret, 10),
    }
}
