use std::collections::BTreeSet;

use regex::bytes::{Regex, RegexBuilder, RegexSet, RegexSetBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{ConstructionError, RuleSource, ScanLimits, ScanProfile};

pub const UPSTREAM_CORPUS_SHA256: &str =
    "2f1292b50148d38afe3ebdb7c489449d103b75b7df464e06da0d5d7c89ac2820";
pub const CONSERVATIVE_OVERLAY_SHA256: &str =
    "8d04fbe0c261ab42bb0370138a42e25437889e8048620b0601bfb9619da140a9";

const UPSTREAM_BYTES: &[u8] = include_bytes!("../default_rules.yaml");
const OVERLAY_BYTES: &[u8] = include_bytes!("../conservative_overlay.yaml");

const CONTEXT_SAFELIST: &[&str] = &[
    r"(?i)\b(?:placeholder|dummy|fake|sample|example|test)[-_ ]{0,3}(?:key|token|secret|password)\b|\b(?:key|token|secret|password)[-_ ]{0,3}(?:placeholder|dummy|fake|sample|example|test)\b",
    r"\bAKIA[0-9A-Z]{9}EXAMPLE\b",
    r"\*{3,}",
    r"[:=]\s*(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)",
    r"(?i)\$\((?:openssl|uuidgen)\b[^)]*\)",
    r"(?i)[:=]\s*(?:null|changeme|todo|fixme)\b",
    r"(?i)\bhunter2\b",
    r"(?i)\b(?:0123456789|abcdefghij)\b",
    r#"(?i)\b(?:classpath:[^\s"'`]+|xsi:schemaLocation\b|xmlns(?::[A-Za-z0-9_-]+)?=)"#,
    r"(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{\{[A-Za-z_][A-Za-z0-9_]*\}\})",
    r#"(?i)\b(?:https?|ssh)://(?:localhost|(?:[A-Za-z0-9-]+\.)*example(?:\.[A-Za-z]{2,})?)(?::\d+)?(?:/[^\s"']*)?"#,
    r"(?i)(?:<\s*/?\s*(?:secret|token|password)\s*>|(?:secretmanager|vault)://|secret(?:manager)?[:=])",
    r"(?i)\b(?:for example|sample config|example config)\b",
    r"(?i)\b(?:INSERT[_\s-]?YOUR|REPLACE[_\s-]?WITH)[A-Z0-9_\s-]*\b",
    r"(?:ZXhhbXBsZQ==|c2FtcGxl={0,2}|dGVzdA==)",
    r"(?m)^(?:<{7}|={7}|>{7})(?: .*)?$",
    r"(?i)\b(?:__tests?__|fixtures?|mocks?)\b",
    r"(?i)\b(?:sha(?:1|224|256|384|512)|md5)\s*[:=]\s*[A-Fa-f0-9]{8,}\b",
];

const VALUE_SAFELIST: &[&str] = &[
    r"(?i)^(?:placeholder|dummy|fake|sample|example|test)[-_ ]{0,3}(?:key|token|secret|password)$|^(?:key|token|secret|password)[-_ ]{0,3}(?:placeholder|dummy|fake|sample|example|test)$",
    r"^AKIA[0-9A-Z]{9}EXAMPLE$",
    r"\*{3,}",
    r"(?i)^(?:null|changeme|todo|fixme)$",
    r"(?i)^hunter2$",
    r"(?i)^(?:0123456789|abcdefghij)$",
    r"(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{\{[A-Za-z_][A-Za-z0-9_]*\}\})",
    r"(?i)^(?:INSERT[_\s-]?YOUR|REPLACE[_\s-]?WITH)[A-Z0-9_\s-]*$",
    r"(?:ZXhhbXBsZQ==|c2FtcGxl={0,2}|dGVzdA==)",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RuleDocument {
    rules: Vec<RuleDeclaration>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuleDeclaration {
    pub name: String,
    pub regex: String,
    pub anchors: Vec<String>,
    pub radius: usize,
    #[serde(default)]
    pub must_contain: Option<String>,
    #[serde(default)]
    pub keywords_any: Option<Vec<String>>,
    #[serde(default)]
    pub value_suppressors_any: Option<Vec<String>>,
    #[serde(default)]
    pub entropy: Option<EntropySpec>,
    #[serde(default)]
    pub char_class: Option<CharClassSpec>,
    #[serde(default)]
    pub two_phase: Option<TwoPhaseSpec>,
    #[serde(default)]
    pub local_context: Option<LocalContextSpec>,
    #[serde(default)]
    pub offline_validation: Option<OfflineValidationSpec>,
    #[serde(default)]
    pub secret_group: Option<u16>,
    #[serde(default)]
    pub uuid_format_secret: bool,
    #[serde(default)]
    pub min_confidence: Option<i8>,
    #[serde(default)]
    pub key_group: Option<String>,
    #[serde(default)]
    pub value_group: Option<String>,
    #[serde(default)]
    pub reject_scalars: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EntropySpec {
    pub min_bits_per_byte: f32,
    pub min_len: usize,
    pub max_len: usize,
    #[serde(default)]
    pub min_entropy_bits_per_byte: Option<f32>,
    #[serde(default)]
    pub digit_penalty: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CharClassSpec {
    pub max_lower_pct: u8,
    pub min_window_len: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TwoPhaseSpec {
    pub seed_radius: usize,
    pub full_radius: usize,
    pub confirm_any: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LocalContextSpec {
    pub lookbehind: usize,
    pub lookahead: usize,
    #[serde(default)]
    pub require_same_line_assignment: bool,
    #[serde(default)]
    pub require_quoted: bool,
    #[serde(default)]
    pub key_names_any: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OfflineValidationSpec {
    #[serde(rename = "type")]
    pub kind: OfflineValidationKind,
    #[serde(default)]
    pub prefix_skip: Option<u8>,
    #[serde(default)]
    pub payload_len: Option<u8>,
    #[serde(default)]
    pub checksum_len: Option<u8>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OfflineValidationKind {
    Crc32Base62,
    GithubFineGrainedPat,
    GrafanaServiceAccount,
    AwsAccessKey,
    SentryOrgToken,
    PypiToken,
    SlackToken,
}

pub(crate) struct Rule {
    pub source: RuleSource,
    pub declaration: RuleDeclaration,
    pub regex: Regex,
}

pub(crate) struct RuleSet {
    rules: Vec<Rule>,
    context_safelist: RegexSet,
    value_safelist: RegexSet,
}

impl RuleSet {
    pub fn from_embedded() -> Result<Self, ConstructionError> {
        Self::from_sources(
            UPSTREAM_BYTES,
            UPSTREAM_CORPUS_SHA256,
            OVERLAY_BYTES,
            CONSERVATIVE_OVERLAY_SHA256,
        )
    }

    fn from_sources(
        upstream: &[u8],
        upstream_digest: &str,
        overlay: &[u8],
        overlay_digest: &str,
    ) -> Result<Self, ConstructionError> {
        verify_digest(
            upstream,
            upstream_digest,
            ConstructionError::CorpusDigestMismatch,
        )?;
        verify_digest(
            overlay,
            overlay_digest,
            ConstructionError::OverlayDigestMismatch,
        )?;

        let mut rules = parse_document(upstream, RuleSource::Upstream)?;
        rules.extend(parse_document(overlay, RuleSource::ConservativeOverlay)?);
        let mut identities = BTreeSet::new();
        for rule in &rules {
            if rule.declaration.name.is_empty() || !identities.insert(rule.declaration.name.clone())
            {
                return Err(ConstructionError::InvalidRuleIdentity);
            }
        }
        rules.sort_by(|left, right| {
            (left.source, left.declaration.name.as_str())
                .cmp(&(right.source, right.declaration.name.as_str()))
        });
        let context_safelist = build_regex_set(CONTEXT_SAFELIST)?;
        let value_safelist = build_regex_set(VALUE_SAFELIST)?;
        Ok(Self {
            rules,
            context_safelist,
            value_safelist,
        })
    }

    pub fn active(&self, profile: ScanProfile) -> impl Iterator<Item = &Rule> {
        self.rules.iter().filter(move |rule| {
            profile == ScanProfile::Comprehensive || rule.source == RuleSource::ConservativeOverlay
        })
    }

    pub fn context_is_safelisted(&self, bytes: &[u8]) -> bool {
        self.context_safelist.is_match(bytes)
    }

    pub fn value_is_safelisted(&self, bytes: &[u8]) -> bool {
        self.value_safelist.is_match(bytes)
    }

    pub fn semantic_digest(
        &self,
        profile: ScanProfile,
        limits: ScanLimits,
    ) -> Result<[u8; 32], ConstructionError> {
        self.semantic_digest_with_version(
            profile,
            limits,
            crate::api::REVISION.semantic_digest_version,
        )
    }

    fn semantic_digest_with_version(
        &self,
        profile: ScanProfile,
        limits: ScanLimits,
        evaluator_version: u8,
    ) -> Result<[u8; 32], ConstructionError> {
        let mut hash = Sha256::new();
        hash.update(b"magic-context.secret-scanner.semantics\0");
        hash.update(b"direct-evaluator\0");
        hash.update([evaluator_version]);
        hash.update(UPSTREAM_CORPUS_SHA256.as_bytes());
        hash.update(CONSERVATIVE_OVERLAY_SHA256.as_bytes());
        hash.update([profile.tag()]);
        hash.update((limits.max_input_bytes as u64).to_le_bytes());
        hash.update((limits.max_candidates as u64).to_le_bytes());
        hash.update((limits.max_work_bytes as u64).to_le_bytes());
        for pattern in CONTEXT_SAFELIST.iter().chain(VALUE_SAFELIST) {
            hash.update((pattern.len() as u64).to_le_bytes());
            hash.update(pattern.as_bytes());
        }
        let mut active: Vec<_> = self.active(profile).collect();
        active.sort_by(|left, right| {
            (left.source, left.declaration.name.as_str())
                .cmp(&(right.source, right.declaration.name.as_str()))
        });
        for rule in active {
            encode_rule(&mut hash, rule)?;
        }
        Ok(hash.finalize().into())
    }
}

fn build_regex_set(patterns: &[&str]) -> Result<RegexSet, ConstructionError> {
    let mut builder = RegexSetBuilder::new(patterns);
    builder.unicode(false).size_limit(16 * 1024 * 1024);
    builder
        .build()
        .map_err(|_| ConstructionError::InvalidRulePattern)
}

fn parse_document(bytes: &[u8], source: RuleSource) -> Result<Vec<Rule>, ConstructionError> {
    let text = std::str::from_utf8(bytes).map_err(|_| ConstructionError::InvalidRuleDocument)?;
    let document: RuleDocument =
        serde_norway::from_str(text).map_err(|_| ConstructionError::InvalidRuleDocument)?;
    if document.rules.is_empty() {
        return Err(ConstructionError::InvalidRuleDocument);
    }
    document
        .rules
        .into_iter()
        .map(|declaration| compile_rule(source, declaration))
        .collect()
}

fn compile_rule(
    source: RuleSource,
    declaration: RuleDeclaration,
) -> Result<Rule, ConstructionError> {
    validate_policy(&declaration)?;
    let mut builder = RegexBuilder::new(&declaration.regex);
    builder.unicode(false).size_limit(128 * 1024 * 1024);
    let regex = builder
        .build()
        .map_err(|_| ConstructionError::InvalidRulePattern)?;
    if declaration
        .secret_group
        .is_some_and(|group| usize::from(group) >= regex.captures_len())
    {
        return Err(ConstructionError::InvalidRulePattern);
    }
    let capture_names: BTreeSet<_> = regex.capture_names().flatten().collect();
    if declaration
        .key_group
        .as_deref()
        .is_some_and(|name| !capture_names.contains(name))
        || declaration
            .value_group
            .as_deref()
            .is_some_and(|name| !capture_names.contains(name))
    {
        return Err(ConstructionError::InvalidRulePattern);
    }
    Ok(Rule {
        source,
        declaration,
        regex,
    })
}

fn validate_policy(rule: &RuleDeclaration) -> Result<(), ConstructionError> {
    if rule.name.is_empty()
        || rule.anchors.is_empty()
        || rule.anchors.iter().any(String::is_empty)
        || rule.must_contain.as_ref().is_some_and(String::is_empty)
        || rule
            .keywords_any
            .as_ref()
            .is_some_and(|values| values.is_empty() || values.iter().any(String::is_empty))
        || rule
            .value_suppressors_any
            .as_ref()
            .is_some_and(|values| values.is_empty() || values.iter().any(String::is_empty))
    {
        return Err(ConstructionError::InvalidRulePolicy);
    }
    if let Some(entropy) = &rule.entropy {
        if !entropy.min_bits_per_byte.is_finite()
            || !(0.0..=8.0).contains(&entropy.min_bits_per_byte)
            || entropy.min_len == 0
            || entropy.min_len > entropy.max_len
            || entropy
                .min_entropy_bits_per_byte
                .is_some_and(|value| !value.is_finite() || !(0.0..=8.0).contains(&value))
        {
            return Err(ConstructionError::InvalidRulePolicy);
        }
    }
    if rule
        .char_class
        .as_ref()
        .is_some_and(|spec| spec.max_lower_pct > 100 || spec.min_window_len < 16)
        || rule.two_phase.as_ref().is_some_and(|spec| {
            spec.seed_radius > spec.full_radius
                || spec.confirm_any.is_empty()
                || spec.confirm_any.iter().any(String::is_empty)
        })
        || rule.local_context.as_ref().is_some_and(|spec| {
            spec.lookbehind > 1024
                || spec.lookahead > 1024
                || spec
                    .key_names_any
                    .as_ref()
                    .is_some_and(|values| values.is_empty() || values.iter().any(String::is_empty))
        })
        || rule
            .min_confidence
            .is_some_and(|value| !(0..=10).contains(&value))
    {
        return Err(ConstructionError::InvalidRulePolicy);
    }
    if let Some(spec) = &rule.offline_validation {
        let valid = match spec.kind {
            OfflineValidationKind::Crc32Base62 => {
                spec.prefix_skip.is_some()
                    && spec.payload_len.is_some_and(|value| value > 0)
                    && spec
                        .checksum_len
                        .is_some_and(|value| (1..=6).contains(&value))
            }
            _ => {
                spec.prefix_skip.is_none()
                    && spec.payload_len.is_none()
                    && spec.checksum_len.is_none()
            }
        };
        if !valid {
            return Err(ConstructionError::InvalidRulePolicy);
        }
    }
    Ok(())
}

fn digest_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

fn verify_digest(
    bytes: &[u8],
    expected: &str,
    error: ConstructionError,
) -> Result<(), ConstructionError> {
    if digest_hex(bytes) == expected {
        Ok(())
    } else {
        Err(error)
    }
}

fn encode_rule(hash: &mut Sha256, rule: &Rule) -> Result<(), ConstructionError> {
    hash.update([match rule.source {
        RuleSource::Upstream => 1,
        RuleSource::ConservativeOverlay => 2,
    }]);
    let encoded =
        serde_json::to_vec(&rule.declaration).map_err(|_| ConstructionError::InvalidRulePolicy)?;
    hash.update((encoded.len() as u64).to_le_bytes());
    hash.update(encoded);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_sources_match_expected_digests() {
        assert_eq!(digest_hex(UPSTREAM_BYTES), UPSTREAM_CORPUS_SHA256);
        assert_eq!(digest_hex(OVERLAY_BYTES), CONSERVATIVE_OVERLAY_SHA256);
    }

    #[test]
    fn malformed_rules_return_typed_errors() {
        assert_eq!(
            parse_document(b"rules:\n- name: bad\n", RuleSource::Upstream).err(),
            Some(ConstructionError::InvalidRuleDocument)
        );
    }

    #[test]
    fn construction_wiring_rejects_source_tampering() {
        assert_eq!(
            RuleSet::from_sources(
                b"changed corpus",
                UPSTREAM_CORPUS_SHA256,
                OVERLAY_BYTES,
                CONSERVATIVE_OVERLAY_SHA256,
            )
            .err(),
            Some(ConstructionError::CorpusDigestMismatch)
        );
        assert_eq!(
            RuleSet::from_sources(
                UPSTREAM_BYTES,
                UPSTREAM_CORPUS_SHA256,
                b"changed overlay",
                CONSERVATIVE_OVERLAY_SHA256,
            )
            .err(),
            Some(ConstructionError::OverlayDigestMismatch)
        );
    }

    #[test]
    fn semantic_digest_ignores_corpus_order() {
        let mut rules = RuleSet::from_embedded().unwrap();
        let expected = rules
            .semantic_digest(ScanProfile::Comprehensive, ScanLimits::default())
            .unwrap();
        rules.rules.reverse();
        assert_eq!(
            rules
                .semantic_digest(ScanProfile::Comprehensive, ScanLimits::default())
                .unwrap(),
            expected
        );
    }

    #[test]
    fn finding_affecting_rule_changes_change_semantic_digest() {
        let mut rules = RuleSet::from_embedded().unwrap();
        let expected = rules
            .semantic_digest(ScanProfile::Comprehensive, ScanLimits::default())
            .unwrap();
        rules.rules[0].declaration.radius += 1;
        assert_ne!(
            rules
                .semantic_digest(ScanProfile::Comprehensive, ScanLimits::default())
                .unwrap(),
            expected
        );
    }

    #[test]
    fn every_scan_limit_changes_semantic_digest() {
        let rules = RuleSet::from_embedded().unwrap();
        let base = ScanLimits::default();
        let expected = rules
            .semantic_digest(ScanProfile::Comprehensive, base)
            .unwrap();
        for limits in [
            ScanLimits {
                max_input_bytes: base.max_input_bytes - 1,
                ..base
            },
            ScanLimits {
                max_candidates: base.max_candidates - 1,
                ..base
            },
            ScanLimits {
                max_work_bytes: base.max_work_bytes - 1,
                ..base
            },
        ] {
            assert_ne!(
                rules
                    .semantic_digest(ScanProfile::Comprehensive, limits)
                    .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn evaluator_version_changes_semantic_digest() {
        let rules = RuleSet::from_embedded().unwrap();
        let limits = ScanLimits::default();
        let expected = rules
            .semantic_digest(ScanProfile::Comprehensive, limits)
            .unwrap();
        assert_ne!(
            rules
                .semantic_digest_with_version(
                    ScanProfile::Comprehensive,
                    limits,
                    crate::api::REVISION.semantic_digest_version + 1,
                )
                .unwrap(),
            expected
        );
    }
}
