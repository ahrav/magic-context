use std::{
    collections::BTreeSet,
    io::{self, BufRead},
    time::Instant,
};

use mc_core::redaction::{DivergenceClass, RedactionErrorKind, RedactionMode, Redactor};
use mc_secret_scanner::{ScanProfile, Scanner};
use serde::{Deserialize, Serialize};

const MAX_CAMPAIGN_SCANS: u64 = 300_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Command {
    case_id: String,
    input: String,
    repetitions: u64,
    mode: Mode,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    LegacyComparison,
    NewAuthorityLegacyShadow,
}

#[derive(Default, Serialize)]
struct Divergences {
    r#match: u64,
    legacy_only: u64,
    portable_only: u64,
    different_output: u64,
    portable_error: u64,
}

#[derive(Serialize)]
struct ResultLine {
    schema: &'static str,
    case_id: String,
    attempted: u64,
    completed: u64,
    rejected: u64,
    scanner_failures: u64,
    incomplete_reports: u64,
    invalid_spans: u64,
    observed_finding_count: usize,
    observed_rule_ids: Vec<String>,
    divergences: Divergences,
    elapsed_ns: u64,
}

fn fail(message: &'static str) -> ! {
    eprintln!("secret-scanner qualification artifact: {message}");
    std::process::exit(2);
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--identity") {
        let scanner = Scanner::new(ScanProfile::Comprehensive)
            .unwrap_or_else(|_| fail("scanner construction failed"));
        let revision = scanner.revision();
        println!(
            "{{\"schema\":\"magic-context.secret-scanner-artifact-identity/v1\",\"crate_version\":\"{}\",\"semantic_digest\":\"{}\",\"semantic_digest_version\":{},\"upstream_commit\":\"{}\"}}",
            revision.crate_version,
            hex(scanner.semantic_digest()),
            revision.semantic_digest_version,
            revision.upstream_commit
        );
        return;
    }
    let stdin = io::stdin();
    let mut total = 0_u64;
    for line in stdin.lock().lines() {
        let line = line.unwrap_or_else(|_| fail("cannot read command"));
        let command: Command =
            serde_json::from_str(&line).unwrap_or_else(|_| fail("invalid command"));
        total = total
            .checked_add(command.repetitions)
            .filter(|total| *total <= MAX_CAMPAIGN_SCANS)
            .unwrap_or_else(|| fail("campaign scan limit exceeded"));
        let result = run(command);
        println!(
            "{}",
            serde_json::to_string(&result).unwrap_or_else(|_| fail("cannot encode result"))
        );
    }
}

fn hex(bytes: [u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn classify_scanner_failure(
    kind: RedactionErrorKind,
    incomplete_reports: &mut u64,
    invalid_spans: &mut u64,
) {
    if matches!(
        kind,
        RedactionErrorKind::InputLimit
            | RedactionErrorKind::CandidateLimit
            | RedactionErrorKind::WorkLimit
    ) {
        *incomplete_reports += 1;
    }
    if matches!(
        kind,
        RedactionErrorKind::InvalidSpan | RedactionErrorKind::InvalidUtf8Boundary
    ) {
        *invalid_spans += 1;
    }
}

fn run(command: Command) -> ResultLine {
    let legacy_observation = if matches!(command.mode, Mode::LegacyComparison) {
        let scanner = Scanner::new(ScanProfile::Comprehensive)
            .unwrap_or_else(|_| fail("scanner construction failed"));
        let report = scanner
            .scan(&command.input)
            .unwrap_or_else(|_| fail("fixture scan failed"));
        Some((
            report.findings.len(),
            report
                .findings
                .into_iter()
                .map(|finding| finding.rule_id)
                .collect::<BTreeSet<_>>(),
        ))
    } else {
        None
    };
    let mode = match command.mode {
        Mode::LegacyComparison => RedactionMode::LegacyComparison,
        Mode::NewAuthorityLegacyShadow => RedactionMode::NewAuthorityLegacyShadow,
    };
    let redactor = Redactor::new(mode).unwrap_or_else(|_| fail("redactor construction failed"));
    let started = Instant::now();
    let mut completed = 0;
    let mut rejected = 0;
    let mut scanner_failures = 0;
    let mut incomplete_reports = 0;
    let mut invalid_spans = 0;
    let mut divergences = Divergences::default();
    let mut authority_observation = None;
    for _ in 0..command.repetitions {
        match redactor.redact(&command.input) {
            Ok(redaction) => {
                if matches!(command.mode, Mode::NewAuthorityLegacyShadow)
                    && authority_observation.is_none()
                {
                    authority_observation = Some((
                        redaction.detections.len(),
                        redaction
                            .detections
                            .iter()
                            .map(|detection| detection.rule_id.clone())
                            .collect::<BTreeSet<_>>(),
                    ));
                }
                completed += 1;
                match redaction.comparison.map(|comparison| comparison.divergence) {
                    Some(DivergenceClass::Match) => divergences.r#match += 1,
                    Some(DivergenceClass::LegacyOnly) => divergences.legacy_only += 1,
                    Some(DivergenceClass::PortableOnly) => divergences.portable_only += 1,
                    Some(DivergenceClass::DifferentOutput) => divergences.different_output += 1,
                    Some(DivergenceClass::PortableError(kind)) => {
                        divergences.portable_error += 1;
                        scanner_failures += 1;
                        classify_scanner_failure(kind, &mut incomplete_reports, &mut invalid_spans);
                    }
                    None => scanner_failures += 1,
                }
            }
            Err(error) => {
                rejected += 1;
                scanner_failures += 1;
                classify_scanner_failure(error.kind(), &mut incomplete_reports, &mut invalid_spans);
            }
        }
    }
    let (observed_finding_count, observed_rule_ids) = legacy_observation
        .or(authority_observation)
        .unwrap_or_default();
    ResultLine {
        schema: "magic-context.secret-scanner-artifact-result/v1",
        case_id: command.case_id,
        attempted: command.repetitions,
        completed,
        rejected,
        scanner_failures,
        incomplete_reports,
        invalid_spans,
        observed_finding_count,
        observed_rule_ids: observed_rule_ids.into_iter().collect(),
        divergences,
        elapsed_ns: u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX),
    }
}
