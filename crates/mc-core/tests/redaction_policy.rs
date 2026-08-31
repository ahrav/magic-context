use mc_core::redaction::{
    drain_comparison_telemetry, label_for_secret_key, DivergenceClass, RedactionErrorKind,
    RedactionMode, Redactor, DETECTOR_ID,
};
use proptest::prelude::*;
use serde::Deserialize;
use std::sync::OnceLock;

fn portable_redactor() -> &'static Redactor {
    static REDACTOR: OnceLock<Redactor> = OnceLock::new();
    REDACTOR.get_or_init(|| Redactor::new(RedactionMode::NewAuthorityLegacyShadow).unwrap())
}

#[derive(Deserialize)]
struct Fixture {
    schema: String,
    content: Content,
    scalar: String,
    identity: Vec<String>,
}

#[derive(Deserialize)]
struct Content {
    input: String,
    legacy: String,
}

#[derive(Deserialize)]
struct VocabularyV2 {
    schema: String,
    shared_case_count: usize,
    cases: Vec<VocabularyV2Case>,
}

#[derive(Deserialize)]
struct VocabularyV2Case {
    name: String,
    input: String,
    legacy_expected: String,
    portable_expected: String,
    expectation: String,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/durable-field-policy-v1.json")).unwrap()
}

#[test]
fn default_migration_mode_keeps_legacy_authoritative() {
    assert_eq!(RedactionMode::default(), RedactionMode::LegacyComparison);
    let fixture = fixture();
    assert_eq!(fixture.schema, "magic-context.durable-field-policy/v1");
    let redaction = Redactor::new(RedactionMode::default())
        .unwrap()
        .redact(&fixture.content.input)
        .unwrap();
    assert_eq!(redaction.text, fixture.content.legacy);
    assert!(redaction
        .detections
        .iter()
        .all(|detection| detection.detector_id == DETECTOR_ID));
    assert!(redaction.comparison.is_some());
}

#[test]
fn scalar_exemptions_and_identity_rejection_are_distinct() {
    let fixture = fixture();
    let redactor = Redactor::new(RedactionMode::LegacyComparison).unwrap();
    assert!(redactor
        .redact(&fixture.scalar)
        .unwrap()
        .detections
        .is_empty());
    for identity in fixture.identity {
        let error = redactor.reject_secret(&identity).unwrap_err();
        assert_eq!(error.kind(), RedactionErrorKind::SecretDetected);
        assert!(!error.to_string().contains(&identity));
    }
}

#[test]
fn comparison_metadata_is_bounded_and_secret_free() {
    let input =
        "provider AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE";
    let redaction = Redactor::new(RedactionMode::LegacyComparison)
        .unwrap()
        .redact(input)
        .unwrap();
    let metadata = redaction.comparison.unwrap();
    assert_eq!(metadata.divergence, DivergenceClass::PortableOnly);
    let diagnostic = format!("{metadata:?}");
    assert!(!diagnostic.contains("AGE-SECRET"));
    assert!(!diagnostic.contains(input));
}

#[test]
fn comparison_metadata_sink_is_bounded_and_drainable() {
    drain_comparison_telemetry();
    let redactor = Redactor::new(RedactionMode::LegacyComparison).unwrap();
    for _ in 0..300 {
        redactor.redact("clean comparison input").unwrap();
    }
    let telemetry = drain_comparison_telemetry();
    assert_eq!(telemetry.records.len(), 256);
    assert!(telemetry.capacity_drops >= 44);
}

#[test]
fn shared_v2_vocabulary_pins_legacy_and_portable_outputs() {
    let fixture: VocabularyV2 = serde_json::from_str(include_str!(
        "../../../packages/plugin/src/shared/fixtures/redaction-vocabulary-v2.json"
    ))
    .unwrap();
    assert_eq!(fixture.schema, "magic-context.redaction-vocabulary/v2");
    assert!(fixture.shared_case_count > 0);
    assert_eq!(
        fixture
            .cases
            .iter()
            .filter(|case| case.expectation == "shared")
            .count(),
        fixture.shared_case_count
    );
    let legacy = Redactor::new(RedactionMode::LegacyComparison).unwrap();
    let portable = Redactor::new(RedactionMode::NewAuthorityLegacyShadow).unwrap();
    for case in fixture.cases {
        assert!(!case.name.is_empty());
        assert!(!case.input.is_empty());
        assert!(!case.legacy_expected.is_empty());
        assert!(!case.portable_expected.is_empty());
        assert!(matches!(
            case.expectation.as_str(),
            "shared" | "portable_only"
        ));
        if case.expectation == "shared" {
            assert_eq!(case.legacy_expected, case.portable_expected);
        }
        assert_eq!(
            legacy.redact(&case.input).unwrap().text,
            case.legacy_expected
        );
        assert_eq!(
            portable.redact(&case.input).unwrap().text,
            case.portable_expected
        );
    }
}

#[test]
fn key_labels_are_closed_and_token_bounded() {
    for key in ["author", "keywords", "tokenizer", "secretary"] {
        assert_eq!(label_for_secret_key(key), None, "{key}");
    }
    for key in ["api_key", "auth-token", "clientSecret", "password"] {
        assert!(label_for_secret_key(key).is_some(), "{key}");
    }
}

#[test]
fn dense_maximum_input_succeeds_in_default_and_transaction_paths() {
    let mut input = "password=x ".repeat(mc_secret_scanner::MAX_INPUT_BYTES / 11 + 1);
    input.truncate(mc_secret_scanner::MAX_INPUT_BYTES);
    let default = Redactor::new(RedactionMode::LegacyComparison)
        .unwrap()
        .redact(&input)
        .unwrap();
    assert!(!default.detections.is_empty());
    let transaction = mc_core::redaction::redact_transaction_durable_text(&input).unwrap();
    assert_eq!(transaction.text, default.text);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn arbitrary_utf8_with_real_secret_has_valid_spans_and_closed_labels(
        prefix in ".{0,128}",
        suffix in ".{0,128}",
    ) {
        let input = format!("{prefix}\npassword=property-secret\n{suffix}");
        let redaction = portable_redactor().redact(&input).unwrap();
        prop_assert!(!redaction.detections.is_empty());
        for detection in redaction.detections {
            let end = detection.offset + detection.length;
            prop_assert!(end <= input.len());
            prop_assert!(input.is_char_boundary(detection.offset));
            prop_assert!(input.is_char_boundary(end));
            prop_assert!(matches!(
                detection.secret_type.as_str(),
                "anthropic_api_key" | "openai_api_key" | "github_pat" | "github_token"
                    | "huggingface_token" | "aws_access_key_id" | "slack_token"
                    | "google_api_key" | "bearer" | "jwt" | "api_key" | "auth_token"
                    | "password" | "key" | "token" | "secret"
            ));
        }
    }

    #[test]
    fn generated_keyed_findings_use_only_closed_labels(
        key in prop_oneof![
            Just("password"),
            Just("api_key"),
            Just("auth-token"),
            Just("clientSecret"),
        ],
        value in "[A-Za-z]{1,24}",
    ) {
        let input = format!("\n{key}={value}\n");
        let redaction = portable_redactor().redact(&input).unwrap();
        prop_assert!(!redaction.detections.is_empty());
        for detection in redaction.detections {
            prop_assert!(matches!(
                detection.secret_type.as_str(),
                "api_key" | "auth_token" | "password" | "secret"
            ));
        }
    }
}
