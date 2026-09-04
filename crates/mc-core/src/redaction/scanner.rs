use std::{cmp::Reverse, mem};

use mc_secret_scanner::{Finding, RuleSource};

use super::{
    redaction_type_for_key, Detection, Redaction, RedactionError, RedactionErrorKind, DETECTOR_ID,
};

/// Stable classification and replacement text for a provider-specific rule.
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

/// Precedence among findings that cover overlapping bytes; the lowest value wins.
///
/// A key name states the operator's own intent for the value, so it outranks a
/// value-shape guess. An unclassified upstream shape ranks last because its
/// label carries no provider or key information.
const KEYED_PRECEDENCE: u8 = 0;
const PROVIDER_PRECEDENCE: u8 = 1;
const GENERIC_PRECEDENCE: u8 = 2;

#[derive(Debug)]
pub(super) struct Replacement {
    start: usize,
    end: usize,
    /// Lowest `specificity` supplies the label when findings overlap.
    specificity: u8,
    secret_type: String,
    replacement: String,
}

/// Describes each finding in `input` as a replacement positioned at `base +
/// span`, so findings from one scan window can be rendered against the text
/// that window was cut from.
///
/// Detection offsets and lengths are UTF-8 byte positions in `input`. Findings
/// may arrive in any order. Returns [`RedactionErrorKind::InvalidSpan`] when
/// any span is not a valid string range, and [`RedactionErrorKind::UnknownRule`]
/// for an unclassified conservative-overlay rule.
pub(super) fn describe_findings(
    input: &str,
    findings: &[Finding],
    base: usize,
) -> Result<Vec<Replacement>, RedactionError> {
    let mut replacements = Vec::with_capacity(findings.len());
    for finding in findings {
        let value = finding.value_span;
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
            base.checked_add(value.start()).ok_or_else(invalid_span)?,
            base.checked_add(value.end()).ok_or_else(invalid_span)?,
        )?);
    }
    Ok(replacements)
}

/// Replaces all described spans and reports one detection per overlapping
/// cluster. Keyed labels win provider labels, which win generic labels.
pub(super) fn render(
    input: &str,
    mut replacements: Vec<Replacement>,
) -> Result<Redaction, RedactionError> {
    sort_for_clustering(&mut replacements);
    render_sorted(input, replacements)
}

/// Collapses every overlapping cluster into one replacement covering its union, labelled by its winner.
///
/// Rendering the result is identical to rendering the input, so a windowed scan can merge after every
/// window and count detections rather than raw findings.
pub(super) fn merge(mut replacements: Vec<Replacement>) -> Vec<Replacement> {
    sort_for_clustering(&mut replacements);
    let mut merged: Vec<Replacement> = Vec::with_capacity(replacements.len());
    for replacement in replacements {
        match merged.last_mut() {
            Some(cluster) if replacement.start < cluster.end => {
                cluster.end = cluster.end.max(replacement.end);
                if replacement.specificity < cluster.specificity {
                    cluster.specificity = replacement.specificity;
                    cluster.secret_type = replacement.secret_type;
                    cluster.replacement = replacement.replacement;
                }
            }
            _ => merged.push(replacement),
        }
    }
    merged
}

/// Widest span first so a cluster's union is known from its first member, then
/// most specific, so the cluster walk can pick a winner without rescanning.
fn sort_for_clustering(replacements: &mut [Replacement]) {
    replacements.sort_by(|left, right| {
        (left.start, Reverse(left.end), left.specificity).cmp(&(
            right.start,
            Reverse(right.end),
            right.specificity,
        ))
    });
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
            specificity: KEYED_PRECEDENCE,
            replacement: format!("<REDACTED:{secret_type}>"),
            secret_type,
        });
    }
    if let Some(label) = provider_label(rule_id) {
        return Ok(Replacement {
            start,
            end,
            specificity: PROVIDER_PRECEDENCE,
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
        specificity: GENERIC_PRECEDENCE,
        secret_type: "secret".to_owned(),
        replacement: "<REDACTED:secret>".to_owned(),
    })
}

/// Renders replacements sorted by start, descending end, then precedence.
///
/// Touching spans remain separate. Transitively overlapping spans form one
/// maximal cluster whose full byte union is replaced once.
fn render_sorted(
    input: &str,
    mut replacements: Vec<Replacement>,
) -> Result<Redaction, RedactionError> {
    // Reserving the whole upper bound keeps the buffer from doubling on its
    // first byte past `input.len()`, which for a payload near the cap would
    // hold twice the payload while the input is still resident.
    let bound = input.len()
        + replacements
            .iter()
            .map(|replacement| replacement.replacement.len())
            .sum::<usize>();
    let mut text = String::with_capacity(bound);
    let mut detections = Vec::with_capacity(replacements.len());
    let mut cursor = 0;
    let mut index = 0;
    while index < replacements.len() {
        // One placeholder covers the whole union of an overlapping cluster. Emitting
        // per finding instead would repeat a placeholder for bytes an earlier finding
        // already replaced, and leave any byte past that finding's end in cleartext.
        let start = replacements[index].start;
        let mut end = replacements[index].end;
        let mut winner = index;
        let mut next = index + 1;
        while next < replacements.len() && replacements[next].start < end {
            if replacements[next].specificity < replacements[winner].specificity {
                winner = next;
            }
            end = end.max(replacements[next].end);
            next += 1;
        }

        // A cluster is maximal, so `start` never precedes `cursor`; a span that
        // violated that would make this range invalid and fail the redaction closed.
        text.push_str(input.get(cursor..start).ok_or_else(invalid_span)?);
        text.push_str(&replacements[winner].replacement);
        detections.push(Detection {
            detector_id: DETECTOR_ID,
            secret_type: mem::take(&mut replacements[winner].secret_type),
            offset: start,
            length: end.checked_sub(start).ok_or_else(invalid_span)?,
        });
        cursor = end;
        index = next;
    }
    text.push_str(input.get(cursor..).ok_or_else(invalid_span)?);
    debug_assert!(text.capacity() == bound, "rendering must not reallocate");
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
    fn rendering_reserves_its_bound_once_and_never_grows() {
        // Every one-byte span becomes a 17-byte placeholder, so the output is
        // far longer than the input.
        let input = "x".repeat(64);
        let replacements: Vec<Replacement> = (0..64)
            .map(|start| Replacement {
                start,
                end: start + 1,
                specificity: GENERIC_PRECEDENCE,
                secret_type: "secret".to_owned(),
                replacement: "<REDACTED:secret>".to_owned(),
            })
            .collect();
        let bound = input.len() + 64 * "<REDACTED:secret>".len();
        let redaction = render(&input, replacements).unwrap();
        assert_eq!(redaction.text.len(), 64 * "<REDACTED:secret>".len());
        assert_eq!(redaction.text.capacity(), bound);
        assert_eq!(redaction.detections.len(), 64);
    }

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
