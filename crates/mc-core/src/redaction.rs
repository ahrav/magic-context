//! Shared secret vocabulary and deterministic text redaction.

mod legacy;
mod scanner;

use std::{
    collections::VecDeque,
    fmt,
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex,
    },
};

use mc_secret_scanner::{
    ConstructionError, ScanError, ScanLimits, ScanProfile, Scanner, ScannerRevision,
};

pub use legacy::RedactionLabel;

#[must_use]
pub fn label_for_secret_key(key: &str) -> Option<RedactionLabel> {
    RedactionLabel::for_key(key)
}

fn is_secret_key_word(word: &str) -> bool {
    matches!(
        word,
        "key"
            | "keys"
            | "token"
            | "tokens"
            | "secret"
            | "secrets"
            | "password"
            | "passwords"
            | "auth"
            | "authorization"
            | "bearer"
            | "credential"
            | "credentials"
    )
}

fn key_tokens(key: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for part in key.split(|character: char| !character.is_ascii_alphanumeric()) {
        let bytes = part.as_bytes();
        let mut start = 0;
        for index in 1..bytes.len() {
            if bytes[index].is_ascii_uppercase()
                && (bytes[index - 1].is_ascii_lowercase()
                    || bytes.get(index + 1).is_some_and(u8::is_ascii_lowercase))
            {
                tokens.push(part[start..index].to_ascii_lowercase());
                start = index;
            }
        }
        if start < part.len() {
            tokens.push(part[start..].to_ascii_lowercase());
        }
    }
    tokens
}

pub const DETECTOR_ID: &str = "redaction-vocabulary-v1";
pub const PORTABLE_DETECTOR_ID: &str = "mc-secret-scanner";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetectionExactness {
    Exact,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetectionSpanKind {
    Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetectionAction {
    Substitute,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanProvenance {
    pub detector_id: &'static str,
    pub detector_revision: String,
    pub semantic_digest: Option<[u8; 32]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detection {
    pub detector_id: &'static str,
    pub detector_revision: String,
    pub rule_id: String,
    pub exactness: DetectionExactness,
    pub span_kind: DetectionSpanKind,
    pub action: DetectionAction,
    pub secret_type: String,
    pub offset: usize,
    pub length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redaction {
    pub text: String,
    pub detections: Vec<Detection>,
    pub provenance: ScanProvenance,
    pub comparison: Option<ComparisonMetadata>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RedactionMode {
    LegacyAuthority,
    #[default]
    LegacyComparison,
    NewAuthorityLegacyShadow,
}

impl RedactionMode {
    const fn portable_failure_is_non_authoritative(self) -> bool {
        matches!(self, Self::LegacyComparison)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputSizeClass {
    Tiny,
    Small,
    Medium,
    Large,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DivergenceClass {
    Match,
    LegacyOnly,
    PortableOnly,
    DifferentOutput,
    PortableError(RedactionErrorKind),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComparisonMetadata {
    pub legacy_detector_id: &'static str,
    pub portable_revision: Option<ScannerRevision>,
    pub portable_semantic_digest: Option<[u8; 32]>,
    pub legacy_detection_count: usize,
    pub portable_detection_count: usize,
    pub input_size_class: InputSizeClass,
    pub divergence: DivergenceClass,
}

const COMPARISON_METADATA_CAPACITY: usize = 256;
static COMPARISON_METADATA: Mutex<VecDeque<ComparisonMetadata>> = Mutex::new(VecDeque::new());
static COMPARISON_CAPACITY_DROPS: AtomicU64 = AtomicU64::new(0);
static COMPARISON_CONTENTION_DROPS: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ComparisonTelemetry {
    pub records: Vec<ComparisonMetadata>,
    pub capacity_drops: u64,
    pub contention_drops: u64,
}

/// Returns and clears comparison records and loss counters for telemetry export.
pub fn drain_comparison_telemetry() -> ComparisonTelemetry {
    let mut metadata = COMPARISON_METADATA
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    take_comparison_telemetry(
        &mut metadata,
        &COMPARISON_CAPACITY_DROPS,
        &COMPARISON_CONTENTION_DROPS,
    )
}

fn take_comparison_telemetry(
    metadata: &mut VecDeque<ComparisonMetadata>,
    capacity_drops: &AtomicU64,
    contention_drops: &AtomicU64,
) -> ComparisonTelemetry {
    ComparisonTelemetry {
        records: metadata.drain(..).collect(),
        capacity_drops: capacity_drops.swap(0, Ordering::Relaxed),
        contention_drops: contention_drops.swap(0, Ordering::Relaxed),
    }
}

fn attach_comparison(mut redaction: Redaction, comparison: ComparisonMetadata) -> Redaction {
    let Ok(mut metadata) = COMPARISON_METADATA.try_lock() else {
        COMPARISON_CONTENTION_DROPS.fetch_add(1, Ordering::Relaxed);
        redaction.comparison = Some(comparison);
        return redaction;
    };
    if retain_comparison(&mut metadata, comparison.clone()) {
        COMPARISON_CAPACITY_DROPS.fetch_add(1, Ordering::Relaxed);
    }
    redaction.comparison = Some(comparison);
    redaction
}

fn retain_comparison(
    metadata: &mut VecDeque<ComparisonMetadata>,
    comparison: ComparisonMetadata,
) -> bool {
    let dropped = metadata.len() == COMPARISON_METADATA_CAPACITY;
    if dropped {
        metadata.pop_front();
    }
    metadata.push_back(comparison);
    dropped
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedactionErrorKind {
    Construction,
    InputLimit,
    CandidateLimit,
    WorkLimit,
    InvalidSpan,
    InvalidUtf8Boundary,
    SecretDetected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RedactionError {
    pub(crate) kind: RedactionErrorKind,
}

impl RedactionError {
    #[must_use]
    pub const fn kind(self) -> RedactionErrorKind {
        self.kind
    }
}

impl fmt::Display for RedactionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self.kind {
            RedactionErrorKind::Construction => "secret redactor construction failed",
            RedactionErrorKind::InputLimit => "secret scan input limit exceeded",
            RedactionErrorKind::CandidateLimit => "secret scan candidate limit exceeded",
            RedactionErrorKind::WorkLimit => "secret scan work limit exceeded",
            RedactionErrorKind::InvalidSpan => "secret scan produced an invalid span",
            RedactionErrorKind::InvalidUtf8Boundary => {
                "secret scan produced a non-UTF-8 span boundary"
            }
            RedactionErrorKind::SecretDetected => "secret-bearing field was rejected",
        })
    }
}

impl std::error::Error for RedactionError {}

impl From<ConstructionError> for RedactionError {
    fn from(_: ConstructionError) -> Self {
        Self {
            kind: RedactionErrorKind::Construction,
        }
    }
}

impl From<ScanError> for RedactionError {
    fn from(error: ScanError) -> Self {
        let kind = match error {
            ScanError::InputLimitExceeded => RedactionErrorKind::InputLimit,
            ScanError::CandidateLimitExceeded => RedactionErrorKind::CandidateLimit,
            ScanError::WorkLimitExceeded => RedactionErrorKind::WorkLimit,
            ScanError::InvalidSpan => RedactionErrorKind::InvalidSpan,
            ScanError::InvalidUtf8Boundary => RedactionErrorKind::InvalidUtf8Boundary,
        };
        Self { kind }
    }
}

pub struct Redactor {
    mode: RedactionMode,
    portable: Option<Scanner>,
    portable_construction_error: bool,
}

impl Redactor {
    pub fn new(mode: RedactionMode) -> Result<Self, RedactionError> {
        Self::with_limits(mode, ScanLimits::default())
    }

    fn with_limits(mode: RedactionMode, limits: ScanLimits) -> Result<Self, RedactionError> {
        let scanner = (mode != RedactionMode::LegacyAuthority)
            .then(|| Scanner::with_limits(ScanProfile::Comprehensive, limits));
        Self::from_portable(mode, scanner)
    }

    fn from_portable(
        mode: RedactionMode,
        scanner: Option<Result<Scanner, ConstructionError>>,
    ) -> Result<Self, RedactionError> {
        let (portable, portable_construction_error) = match scanner {
            None => (None, false),
            Some(result) => match result {
                Ok(scanner) => (Some(scanner), false),
                Err(_) if mode.portable_failure_is_non_authoritative() => (None, true),
                Err(error) => return Err(error.into()),
            },
        };
        Ok(Self {
            mode,
            portable,
            portable_construction_error,
        })
    }

    pub fn redact(&self, input: &str) -> Result<Redaction, RedactionError> {
        let legacy = legacy::redact(input)?;
        let Some(portable) = &self.portable else {
            if self.portable_construction_error {
                let metadata =
                    comparison_failure(input, None, &legacy, 0, RedactionErrorKind::Construction);
                return Ok(attach_comparison(legacy, metadata));
            }
            return Ok(legacy);
        };
        let report = match portable.scan(input) {
            Ok(report) => report,
            Err(error) if self.mode.portable_failure_is_non_authoritative() => {
                let metadata = comparison_failure(
                    input,
                    Some(portable),
                    &legacy,
                    0,
                    RedactionError::from(error).kind(),
                );
                return Ok(attach_comparison(legacy, metadata));
            }
            Err(error) => return Err(error.into()),
        };
        self.finish_report(input, legacy, portable, report)
    }

    fn finish_report(
        &self,
        input: &str,
        legacy: Redaction,
        portable: &Scanner,
        report: mc_secret_scanner::ScanReport,
    ) -> Result<Redaction, RedactionError> {
        let mut portable_redaction = match scanner::replace(input, &report.findings) {
            Ok(redaction) => redaction,
            Err(error) if self.mode.portable_failure_is_non_authoritative() => {
                let metadata = comparison_failure(
                    input,
                    Some(portable),
                    &legacy,
                    report.findings.len(),
                    error.kind(),
                );
                return Ok(attach_comparison(legacy, metadata));
            }
            Err(error) => return Err(error),
        };
        let detector_revision = format!(
            "{}:{}:{}",
            report.revision.crate_version,
            report.revision.semantic_digest_version,
            report.revision.upstream_commit
        );
        for detection in &mut portable_redaction.detections {
            detection.detector_revision.clone_from(&detector_revision);
        }
        portable_redaction.provenance = ScanProvenance {
            detector_id: PORTABLE_DETECTOR_ID,
            detector_revision,
            semantic_digest: Some(report.semantic_digest),
        };
        let metadata = comparison(input, &legacy, &portable_redaction, &report);
        match self.mode {
            RedactionMode::LegacyAuthority => Ok(legacy),
            RedactionMode::LegacyComparison => Ok(attach_comparison(legacy, metadata)),
            RedactionMode::NewAuthorityLegacyShadow => {
                Ok(attach_comparison(portable_redaction, metadata))
            }
        }
    }

    pub fn reject_secret(&self, input: &str) -> Result<(), RedactionError> {
        reject_redaction(self.redact(input)?)
    }
}

fn comparison(
    input: &str,
    legacy: &Redaction,
    portable: &Redaction,
    report: &mc_secret_scanner::ScanReport,
) -> ComparisonMetadata {
    let divergence =
        if normalized_spans(&legacy.detections) == normalized_spans(&portable.detections) {
            DivergenceClass::Match
        } else if legacy.detections.is_empty() {
            DivergenceClass::PortableOnly
        } else if portable.detections.is_empty() {
            DivergenceClass::LegacyOnly
        } else {
            DivergenceClass::DifferentOutput
        };
    ComparisonMetadata {
        legacy_detector_id: DETECTOR_ID,
        portable_revision: Some(report.revision),
        portable_semantic_digest: Some(report.semantic_digest),
        legacy_detection_count: legacy.detections.len(),
        portable_detection_count: portable.detections.len(),
        input_size_class: input_size_class(input.len()),
        divergence,
    }
}

fn comparison_failure(
    input: &str,
    portable: Option<&Scanner>,
    legacy: &Redaction,
    portable_detection_count: usize,
    kind: RedactionErrorKind,
) -> ComparisonMetadata {
    ComparisonMetadata {
        legacy_detector_id: DETECTOR_ID,
        portable_revision: portable.map(Scanner::revision),
        portable_semantic_digest: portable.map(Scanner::semantic_digest),
        legacy_detection_count: legacy.detections.len(),
        portable_detection_count,
        input_size_class: input_size_class(input.len()),
        divergence: DivergenceClass::PortableError(kind),
    }
}

fn normalized_spans(detections: &[Detection]) -> Vec<(usize, usize)> {
    let mut spans = detections
        .iter()
        .map(|detection| (detection.offset, detection.offset + detection.length))
        .collect::<Vec<_>>();
    spans.sort_unstable();
    let mut normalized: Vec<(usize, usize)> = Vec::with_capacity(spans.len());
    for (start, end) in spans {
        if let Some((_, previous_end)) = normalized.last_mut() {
            if start <= *previous_end {
                *previous_end = (*previous_end).max(end);
                continue;
            }
        }
        normalized.push((start, end));
    }
    normalized
}

const fn input_size_class(bytes: usize) -> InputSizeClass {
    match bytes {
        0..=256 => InputSizeClass::Tiny,
        257..=4096 => InputSizeClass::Small,
        4097..=65_536 => InputSizeClass::Medium,
        _ => InputSizeClass::Large,
    }
}

static DEFAULT_REDACTOR: LazyLock<Result<Redactor, RedactionError>> =
    LazyLock::new(|| Redactor::new(RedactionMode::LegacyComparison));

const TRANSACTION_SCAN_LIMITS: ScanLimits = ScanLimits {
    max_input_bytes: mc_secret_scanner::MAX_INPUT_BYTES,
    max_candidates: 131_072,
    max_work_bytes: 1024 * 1024 * 1024,
};
static TRANSACTION_REDACTOR: LazyLock<Result<Redactor, RedactionError>> = LazyLock::new(|| {
    Redactor::with_limits(RedactionMode::LegacyComparison, TRANSACTION_SCAN_LIMITS)
});

pub fn redact_durable_text(input: &str) -> Result<Redaction, RedactionError> {
    DEFAULT_REDACTOR
        .as_ref()
        .map_err(|error| *error)?
        .redact(input)
}

pub fn redact_transaction_durable_text(input: &str) -> Result<Redaction, RedactionError> {
    TRANSACTION_REDACTOR
        .as_ref()
        .map_err(|error| *error)?
        .redact(input)
}

pub fn reject_secret_text(input: &str) -> Result<(), RedactionError> {
    reject_redaction(redact_durable_text(input)?)
}

pub fn reject_transaction_secret_text(input: &str) -> Result<(), RedactionError> {
    reject_redaction(redact_transaction_durable_text(input)?)
}

fn reject_redaction(redaction: Redaction) -> Result<(), RedactionError> {
    if redaction.detections.is_empty() {
        Ok(())
    } else {
        Err(RedactionError {
            kind: RedactionErrorKind::SecretDetected,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Vocabulary {
        schema: String,
        cases: Vec<FixtureCase>,
        exemptions: Vec<String>,
        known_misses: Vec<String>,
    }

    #[derive(Deserialize)]
    struct FixtureCase {
        name: String,
        input: String,
        expected_redacted: String,
        detections: Vec<FixtureDetection>,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct FixtureDetection {
        secret_type: String,
        offset: usize,
        length: usize,
    }

    fn vocabulary() -> Vocabulary {
        serde_json::from_str(include_str!(
            "../../../packages/plugin/src/shared/fixtures/redaction-vocabulary-v1.json"
        ))
        .expect("shared redaction fixture is valid")
    }

    #[test]
    fn shared_vocabulary_remains_legacy_authoritative() {
        let vocabulary = vocabulary();
        assert_eq!(vocabulary.schema, "magic-context.redaction-vocabulary/v1");
        for fixture in vocabulary.cases {
            let result = redact_durable_text(&fixture.input).unwrap();
            assert_eq!(result.text, fixture.expected_redacted, "{}", fixture.name);
            let actual: Vec<_> = result
                .detections
                .iter()
                .map(|detection| FixtureDetection {
                    secret_type: detection.secret_type.clone(),
                    offset: detection.offset,
                    length: detection.length,
                })
                .collect();
            assert_eq!(actual, fixture.detections, "{}", fixture.name);
            assert!(result.comparison.is_some());
        }
    }

    #[test]
    fn scalar_exemptions_and_known_misses_remain_unchanged() {
        let vocabulary = vocabulary();
        for input in vocabulary
            .exemptions
            .into_iter()
            .chain(vocabulary.known_misses)
        {
            assert_eq!(redact_durable_text(&input).unwrap().text, input);
        }
    }

    #[test]
    fn unicode_and_invalid_spans_are_fallible() {
        let input = "π password=hunter-two";
        assert_eq!(
            redact_durable_text(input).unwrap().text,
            "π password=<REDACTED:password>"
        );
        let candidate = legacy::Candidate {
            rule_id: "invalid-span-test".to_string(),
            start: 1,
            end: 2,
            context_start: 0,
            precedence: 0,
            label: RedactionLabel::Secret,
        };
        assert_eq!(
            legacy::replace(input, vec![candidate], DETECTOR_ID)
                .unwrap_err()
                .kind(),
            RedactionErrorKind::InvalidSpan
        );
    }

    #[test]
    fn diagnostics_never_include_input() {
        let sentinel = "privacy-sentinel-password=secret";
        let input = format!(
            "{sentinel}{}",
            "x".repeat(mc_secret_scanner::MAX_INPUT_BYTES)
        );
        let error = Redactor::new(RedactionMode::NewAuthorityLegacyShadow)
            .unwrap()
            .redact(&input)
            .unwrap_err()
            .to_string();
        assert!(!error.contains(sentinel));
        assert!(!error.contains("secret="));
    }

    #[test]
    fn legacy_comparison_falls_back_for_real_construction_scan_and_finding_faults() {
        let input = "password=legacy-fallback";
        let expected = legacy::redact(input).unwrap().text;
        let construction = Redactor::from_portable(
            RedactionMode::LegacyComparison,
            Some(Err(ConstructionError::InvalidRuleDocument)),
        )
        .unwrap()
        .redact(input)
        .unwrap();
        assert_eq!(construction.text, expected);
        assert_eq!(
            construction.comparison.unwrap().divergence,
            DivergenceClass::PortableError(RedactionErrorKind::Construction)
        );

        let scan = Redactor::with_limits(
            RedactionMode::LegacyComparison,
            ScanLimits {
                max_work_bytes: 1,
                ..ScanLimits::default()
            },
        )
        .unwrap()
        .redact(input)
        .unwrap();
        assert_eq!(scan.text, expected);
        assert_eq!(
            scan.comparison.unwrap().divergence,
            DivergenceClass::PortableError(RedactionErrorKind::WorkLimit)
        );

        let portable = Scanner::new(ScanProfile::Comprehensive).unwrap();
        let report = portable.scan(input).unwrap();
        let finding = Redactor::new(RedactionMode::LegacyComparison)
            .unwrap()
            .finish_report("x", legacy::redact("x").unwrap(), &portable, report)
            .unwrap();
        assert_eq!(finding.text, "x");
        assert_eq!(
            finding.comparison.unwrap().divergence,
            DivergenceClass::PortableError(RedactionErrorKind::InvalidSpan)
        );
    }

    #[test]
    fn new_authority_fails_closed_for_real_scanner_and_finding_faults() {
        assert!(Redactor::from_portable(
            RedactionMode::NewAuthorityLegacyShadow,
            Some(Err(ConstructionError::InvalidRuleDocument)),
        )
        .is_err());
        let redactor = Redactor::with_limits(
            RedactionMode::NewAuthorityLegacyShadow,
            ScanLimits {
                max_work_bytes: 1,
                ..ScanLimits::default()
            },
        )
        .unwrap();
        assert_eq!(
            redactor
                .redact("password=new-authority")
                .unwrap_err()
                .kind(),
            RedactionErrorKind::WorkLimit
        );
        let portable = Scanner::new(ScanProfile::Comprehensive).unwrap();
        let report = portable.scan("password=new-authority").unwrap();
        assert_eq!(
            Redactor::new(RedactionMode::NewAuthorityLegacyShadow)
                .unwrap()
                .finish_report("x", legacy::redact("x").unwrap(), &portable, report)
                .unwrap_err()
                .kind(),
            RedactionErrorKind::InvalidSpan
        );
    }

    #[test]
    fn transaction_legacy_comparison_keeps_portable_work_failure_non_authoritative() {
        let redactor = Redactor::with_limits(
            RedactionMode::LegacyComparison,
            ScanLimits {
                max_work_bytes: 1,
                ..ScanLimits::default()
            },
        )
        .unwrap();
        assert_eq!(
            redactor
                .redact("xx")
                .unwrap()
                .comparison
                .unwrap()
                .divergence,
            DivergenceClass::PortableError(RedactionErrorKind::WorkLimit)
        );
    }

    #[test]
    fn comparison_uses_semantic_spans_not_replacement_spelling() {
        let input = "password=secret";
        let legacy = Redaction {
            text: "legacy replacement".to_string(),
            detections: vec![Detection {
                detector_id: DETECTOR_ID,
                detector_revision: DETECTOR_ID.to_string(),
                rule_id: "legacy-test".to_string(),
                exactness: DetectionExactness::Exact,
                span_kind: DetectionSpanKind::Value,
                action: DetectionAction::Substitute,
                secret_type: "legacy".to_string(),
                offset: 9,
                length: 6,
            }],
            provenance: ScanProvenance {
                detector_id: DETECTOR_ID,
                detector_revision: DETECTOR_ID.to_string(),
                semantic_digest: None,
            },
            comparison: None,
        };
        let portable = Redaction {
            text: "portable replacement".to_string(),
            detections: vec![Detection {
                detector_id: PORTABLE_DETECTOR_ID,
                detector_revision: PORTABLE_DETECTOR_ID.to_string(),
                rule_id: "portable-test".to_string(),
                exactness: DetectionExactness::Exact,
                span_kind: DetectionSpanKind::Value,
                action: DetectionAction::Substitute,
                secret_type: "portable".to_string(),
                offset: 9,
                length: 6,
            }],
            provenance: ScanProvenance {
                detector_id: PORTABLE_DETECTOR_ID,
                detector_revision: PORTABLE_DETECTOR_ID.to_string(),
                semantic_digest: None,
            },
            comparison: None,
        };
        let scanner = Scanner::new(ScanProfile::Comprehensive).unwrap();
        let report = scanner.scan(input).unwrap();
        assert_eq!(
            comparison(input, &legacy, &portable, &report).divergence,
            DivergenceClass::Match
        );
    }

    #[test]
    fn comparison_window_retains_newest_records_and_drain_resets_every_counter() {
        let mut records = VecDeque::new();
        for index in 0..(COMPARISON_METADATA_CAPACITY + 3) {
            let dropped = retain_comparison(
                &mut records,
                ComparisonMetadata {
                    legacy_detector_id: DETECTOR_ID,
                    portable_revision: None,
                    portable_semantic_digest: None,
                    legacy_detection_count: index,
                    portable_detection_count: 0,
                    input_size_class: InputSizeClass::Tiny,
                    divergence: DivergenceClass::Match,
                },
            );
            assert_eq!(dropped, index >= COMPARISON_METADATA_CAPACITY);
        }
        assert_eq!(records.len(), COMPARISON_METADATA_CAPACITY);
        assert_eq!(records.front().unwrap().legacy_detection_count, 3);
        assert_eq!(
            records.back().unwrap().legacy_detection_count,
            COMPARISON_METADATA_CAPACITY + 2
        );

        let capacity_drops = AtomicU64::new(3);
        let contention_drops = AtomicU64::new(2);
        let drained = take_comparison_telemetry(&mut records, &capacity_drops, &contention_drops);
        assert_eq!(drained.records.len(), COMPARISON_METADATA_CAPACITY);
        assert_eq!(drained.capacity_drops, 3);
        assert_eq!(drained.contention_drops, 2);
        assert_eq!(
            take_comparison_telemetry(&mut records, &capacity_drops, &contention_drops,),
            ComparisonTelemetry::default()
        );
    }
}
