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

/// An AWS access key ID with a shape the corpus rule accepts and no safelisted word.
const AWS_KEY: &str = "AKIAQYLPMN5HGZ3ABCDE";
const AGE_KEY: &str = "AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE";

#[test]
fn overlapping_findings_collapse_to_one_placeholder_over_their_union() {
    // A keyed value class admits `-`, so the keyed span reaches past the provider or
    // upstream shape nested inside it. Replacing per finding would emit a second
    // placeholder for the trailing bytes and leave them described as their own secret.
    for (input, expected, secret_type) in [
        (
            format!("token={AWS_KEY}-prod"),
            "token=<REDACTED:token>",
            "token",
        ),
        (
            format!("password={AGE_KEY}-prod"),
            "password=<REDACTED:password>",
            "password",
        ),
    ] {
        let redaction = redact_durable_text(&input);
        assert_eq!(redaction.text, expected, "{input}");
        assert_eq!(redaction.detections.len(), 1, "{input}");
        let detection = &redaction.detections[0];
        assert_eq!(detection.secret_type, secret_type, "{input}");
        // The detection covers the whole redacted region, so a consumer reading it
        // back against the pre-redaction text sees the bytes that were replaced.
        let value_start = input.find('=').unwrap() + 1;
        assert_eq!(detection.offset, value_start, "{input}");
        assert_eq!(detection.length, input.len() - value_start, "{input}");
        assert!(!redaction.text.contains("-prod"), "{input}");
    }
}

#[test]
fn a_key_name_supersedes_a_value_shape_on_the_same_span() {
    // The key name states the operator's intent for the value, so it outranks a
    // provider shape that matches the same bytes. Without a declared precedence the
    // winner would follow incidental finding order and flip on a regex edit.
    let redaction = redact_durable_text(&format!("token={AWS_KEY}"));
    assert_eq!(redaction.text, "token=<REDACTED:token>");
    assert_eq!(redaction.detections.len(), 1);
    assert_eq!(redaction.detections[0].secret_type, "token");
}

#[test]
fn a_value_shape_keeps_its_own_label_without_a_key_name() {
    for (input, expected, secret_type) in [
        (AWS_KEY, "<AWS_ACCESS_KEY_ID_REDACTED>", "aws_access_key_id"),
        (AGE_KEY, "<REDACTED:secret>", "secret"),
    ] {
        let redaction = redact_durable_text(input);
        assert_eq!(redaction.text, expected, "{input}");
        assert_eq!(redaction.detections.len(), 1, "{input}");
        assert_eq!(redaction.detections[0].secret_type, secret_type, "{input}");
    }
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
        // Valid spans alone would also hold for an engine that reported the secret and
        // then emitted it verbatim, so assert the replacement actually happened.
        prop_assert!(redaction.text.contains("<REDACTED:password>"));
        prop_assert!(!redaction.text.contains("password=property-secret"));
        for detection in redaction.detections {
            let end = detection.offset + detection.length;
            prop_assert!(end <= input.len());
            prop_assert!(input.is_char_boundary(detection.offset));
            prop_assert!(input.is_char_boundary(end));
            prop_assert!(!detection.secret_type.is_empty());
        }
    }
}
