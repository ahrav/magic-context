use mc_secret_scanner::{RuleSource, ScanProfile, Scanner};

#[test]
fn provider_canaries_return_stable_rule_ids_and_value_spans() {
    let scanner = Scanner::new(ScanProfile::Comprehensive).unwrap();
    let cases = [
        (
            "A3-0A1B2C-3D4E5F6G7H8-9I0J1-2K3L4-5M6N7",
            "1password-secret-key",
        ),
        (
            "AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE",
            "age-secret-key",
        ),
    ];
    for (input, rule_id) in cases {
        let report = scanner.scan(input).unwrap();
        let finding = report
            .findings
            .iter()
            .find(|finding| finding.rule_id == rule_id)
            .unwrap_or_else(|| panic!("missing canary rule {rule_id}"));
        assert_eq!(finding.rule_source, RuleSource::Upstream);
        assert_eq!(
            input.get(finding.value_span.start()..finding.value_span.end()),
            Some(input)
        );
    }
}

#[test]
fn profile_and_finding_semantics_change_the_digest() {
    let conservative = Scanner::new(ScanProfile::Conservative).unwrap();
    let comprehensive = Scanner::new(ScanProfile::Comprehensive).unwrap();
    assert_ne!(
        conservative.semantic_digest(),
        comprehensive.semantic_digest()
    );
}
