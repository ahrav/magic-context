use mc_secret_scanner::{RuleSource, ScanError, ScanLimits, ScanProfile, Scanner};
use proptest::prelude::*;
use std::sync::OnceLock;

fn comprehensive_scanner() -> &'static Scanner {
    static SCANNER: OnceLock<Scanner> = OnceLock::new();
    SCANNER.get_or_init(|| Scanner::new(ScanProfile::Comprehensive).unwrap())
}

#[test]
fn conservative_profile_returns_exact_utf8_spans() {
    let scanner = Scanner::new(ScanProfile::Conservative).unwrap();
    let input = "π prefix password=hunter2 suffix";
    let report = scanner.scan(input).unwrap();
    let finding = report
        .findings
        .iter()
        .find(|finding| finding.rule_id == "magic-keyed-assignment")
        .unwrap();

    assert_eq!(finding.rule_source, RuleSource::ConservativeOverlay);
    assert_eq!(
        input.get(finding.full_span.start()..finding.full_span.end()),
        Some("password=hunter2")
    );
    assert_eq!(
        input.get(finding.value_span.start()..finding.value_span.end()),
        Some("hunter2")
    );
    let key = finding.key_span.unwrap();
    assert_eq!(input.get(key.start()..key.end()), Some("password"));
}

#[test]
fn short_quoted_values_are_kept_and_scalars_are_rejected() {
    let scanner = Scanner::new(ScanProfile::Conservative).unwrap();
    for input in [r#"{"password":"x"}"#, "'api_token': 'xy'"] {
        assert!(!scanner.scan(input).unwrap().findings.is_empty(), "{input}");
    }
    for input in [
        "tokens.input=45000",
        "password=true",
        "password=false",
        "password=null",
        "password=undefined",
        "password=-1.5e10",
    ] {
        assert!(scanner.scan(input).unwrap().findings.is_empty(), "{input}");
    }
}

#[test]
fn empty_keyed_values_and_secret_substrings_are_not_findings() {
    let scanner = Scanner::new(ScanProfile::Conservative).unwrap();
    for input in [
        r#"{"password":""}"#,
        "'api_token': ''",
        "password=",
        "author=hunter-two",
        "keywords=hunter-two",
        "tokenizer=hunter-two",
        "secretary=hunter-two",
    ] {
        assert!(scanner.scan(input).unwrap().findings.is_empty(), "{input}");
    }
    for input in [
        "auth_token=hunter-two",
        "api-key=hunter-two",
        r#"{"clientSecret":"hunter-two"}"#,
    ] {
        assert!(!scanner.scan(input).unwrap().findings.is_empty(), "{input}");
    }
}

#[test]
fn repeated_scans_are_deterministic_and_independent() {
    let scanner = Scanner::new(ScanProfile::Comprehensive).unwrap();
    let first = scanner.scan("password=first-secret").unwrap();
    let other = scanner.scan("nothing to detect").unwrap();
    let repeated = scanner.scan("password=first-secret").unwrap();
    assert_eq!(first, repeated);
    assert!(other.findings.is_empty());
}

#[test]
fn every_limit_returns_a_typed_error() {
    let input_limited = Scanner::with_limits(
        ScanProfile::Conservative,
        ScanLimits {
            max_input_bytes: 4,
            ..ScanLimits::default()
        },
    )
    .unwrap();
    assert_eq!(
        input_limited.scan("12345").unwrap_err(),
        ScanError::InputLimitExceeded
    );

    let candidate_limited = Scanner::with_limits(
        ScanProfile::Conservative,
        ScanLimits {
            max_candidates: 1,
            ..ScanLimits::default()
        },
    )
    .unwrap();
    assert_eq!(
        candidate_limited
            .scan("password=one password=two")
            .unwrap_err(),
        ScanError::CandidateLimitExceeded
    );

    let work_limited = Scanner::with_limits(
        ScanProfile::Conservative,
        ScanLimits {
            max_work_bytes: 1,
            ..ScanLimits::default()
        },
    )
    .unwrap();
    assert_eq!(
        work_limited.scan("password=secret").unwrap_err(),
        ScanError::WorkLimitExceeded
    );
}

#[test]
fn diagnostics_do_not_include_scanned_text() {
    let sentinel = "privacy-sentinel-password=secret";
    let scanner = Scanner::with_limits(
        ScanProfile::Conservative,
        ScanLimits {
            max_work_bytes: 1,
            ..ScanLimits::default()
        },
    )
    .unwrap();
    let error = scanner.scan(sentinel).unwrap_err().to_string();
    assert!(!error.contains(sentinel));
    assert!(!error.contains("secret"));
}

#[test]
fn maximum_supported_input_has_a_defined_outcome() {
    let scanner = Scanner::new(ScanProfile::Comprehensive).unwrap();
    let input = "x".repeat(mc_secret_scanner::MAX_INPUT_BYTES);
    let report = scanner.scan(&input).unwrap();
    assert!(report.findings.is_empty());
}

#[test]
fn maximum_supported_dense_input_succeeds_with_default_limits() {
    let scanner = Scanner::new(ScanProfile::Comprehensive).unwrap();
    let mut input = "password=x ".repeat(mc_secret_scanner::MAX_INPUT_BYTES / 11 + 1);
    input.truncate(mc_secret_scanner::MAX_INPUT_BYTES);
    while !input.is_char_boundary(input.len()) {
        input.pop();
    }
    let report = scanner.scan(&input).unwrap();
    assert!(!report.findings.is_empty());
    assert!(report.work_bytes <= ScanLimits::default().max_work_bytes);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn arbitrary_utf8_with_real_secret_returns_valid_spans(
        prefix in ".{0,128}",
        suffix in ".{0,128}",
    ) {
        let input = format!("{prefix}\npassword=property-secret\n{suffix}");
        let scanner = comprehensive_scanner();
        let report = scanner.scan(&input).unwrap();
        prop_assert!(!report.findings.is_empty());
        for finding in report.findings {
            prop_assert!(finding.full_span.end() <= input.len());
            prop_assert!(finding.value_span.end() <= input.len());
            prop_assert!(input.is_char_boundary(finding.full_span.start()));
            prop_assert!(input.is_char_boundary(finding.full_span.end()));
            prop_assert!(input.is_char_boundary(finding.value_span.start()));
            prop_assert!(input.is_char_boundary(finding.value_span.end()));
            prop_assert!(!finding.value_span.is_empty());
            if let Some(key) = finding.key_span {
                prop_assert!(key.end() <= input.len());
                prop_assert!(input.is_char_boundary(key.start()));
                prop_assert!(input.is_char_boundary(key.end()));
            }
        }
    }
}
