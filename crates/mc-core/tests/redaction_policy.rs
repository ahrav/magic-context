use std::sync::OnceLock;

use mc_core::redaction::{redact_durable_text, RedactionErrorKind, Redactor, DETECTOR_ID};
use proptest::prelude::*;

fn redactor() -> &'static Redactor {
    static REDACTOR: OnceLock<Redactor> = OnceLock::new();
    REDACTOR.get_or_init(|| Redactor::new().unwrap())
}

#[test]
fn established_replacement_spelling_remains_stable() {
    assert_eq!(
        redact_durable_text("Authorization: Bearer abc123def456ghi789").text,
        "Authorization: Bearer <REDACTED:bearer>"
    );
    for (input, expected) in [
        (
            "x_auth_token=hunter-two",
            "x_auth_token=<REDACTED:x_auth_token>",
        ),
        (
            "client_secret=hunter-two",
            "client_secret=<REDACTED:client_secret>",
        ),
        ("aws_secret=hunter-two", "aws_secret=<REDACTED:aws_secret>"),
    ] {
        assert_eq!(redact_durable_text(input).text, expected, "{input}");
    }
}

#[test]
fn portable_scanner_is_authoritative() {
    let input =
        "provider AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE";
    let redaction = redact_durable_text(input);
    assert_eq!(redaction.text, "provider <REDACTED:secret>");
    assert!(redaction
        .detections
        .iter()
        .all(|detection| detection.detector_id == DETECTOR_ID));
}

#[test]
fn concatenated_secret_keys_remain_redacted() {
    for input in [
        "apikey=hunter-two",
        "authtoken=hunter-two",
        r#"{"apikeys":"hunter-two"}"#,
    ] {
        let redaction = redact_durable_text(input);
        assert!(!redaction.detections.is_empty(), "{input}");
        assert!(!redaction.text.contains("hunter-two"), "{input}");
    }
}

#[test]
fn scalar_values_remain_visible() {
    for input in [
        "tokens.input=45000",
        "hasUsageTokens=true",
        "max_tokens=4096",
        r#"{"max_tokens":"4096"}"#,
    ] {
        assert_eq!(redact_durable_text(input).text, input);
    }
}

#[test]
fn oversized_input_is_rejected_by_direct_scans() {
    let input = "x".repeat(mc_secret_scanner::MAX_INPUT_BYTES + 1);
    assert_eq!(
        redactor().redact(&input).unwrap_err().kind(),
        RedactionErrorKind::InputLimit
    );
}

#[test]
fn dense_maximum_input_succeeds() {
    let mut input = "password=x ".repeat(mc_secret_scanner::MAX_INPUT_BYTES / 11 + 1);
    input.truncate(mc_secret_scanner::MAX_INPUT_BYTES);
    let redaction = redactor().redact(&input).unwrap();
    assert!(!redaction.detections.is_empty());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn arbitrary_utf8_with_real_secret_has_valid_spans(
        prefix in ".{0,128}",
        suffix in ".{0,128}",
    ) {
        let input = format!("{prefix}\npassword=property-secret\n{suffix}");
        let redaction = redactor().redact(&input).unwrap();
        prop_assert!(!redaction.detections.is_empty());
        for detection in redaction.detections {
            let end = detection.offset + detection.length;
            prop_assert!(end <= input.len());
            prop_assert!(input.is_char_boundary(detection.offset));
            prop_assert!(input.is_char_boundary(end));
            prop_assert!(!detection.secret_type.is_empty());
        }
    }
}
