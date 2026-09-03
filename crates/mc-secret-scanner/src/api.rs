//! Public scanner inputs, limits, findings, and errors.

use std::fmt;

/// Hard ceiling for one scanner input, in bytes.
pub const MAX_INPUT_BYTES: usize = 512 * 1024;

/// Selects the active secret-detection rule set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanProfile {
    /// Runs upstream rules plus the conservative overlay.
    Conservative,
    /// Runs the comprehensive upstream rule set.
    Comprehensive,
}

impl ScanProfile {
    pub(crate) const fn tag(self) -> u8 {
        match self {
            Self::Conservative => 1,
            Self::Comprehensive => 2,
        }
    }
}

/// Identifies the corpus that supplied a matching rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RuleSource {
    /// Rule imported from the pinned upstream corpus.
    Upstream,
    /// Rule added by the local conservative overlay.
    ConservativeOverlay,
}

/// Half-open UTF-8 byte range within scanner input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct TextSpan {
    start: usize,
    end: usize,
}

impl TextSpan {
    pub(crate) fn new(input: &str, start: usize, end: usize) -> Result<Self, ScanError> {
        if start > end || end > input.len() {
            return Err(ScanError::InvalidSpan);
        }
        if !input.is_char_boundary(start) || !input.is_char_boundary(end) {
            return Err(ScanError::InvalidSpan);
        }
        Ok(Self { start, end })
    }

    /// Widens `start` and `end` to the enclosing character boundaries.
    ///
    /// Byte-class matches can end inside a multi-byte character. Widening keeps
    /// the span a valid `str` index pair and never reports fewer bytes than
    /// matched, so a caller redacting the span cannot leave part of a secret
    /// exposed.
    pub(crate) fn snapped(input: &str, start: usize, end: usize) -> Result<Self, ScanError> {
        if start > end || end > input.len() {
            return Err(ScanError::InvalidSpan);
        }
        let mut start = start;
        while start > 0 && !input.is_char_boundary(start) {
            start -= 1;
        }
        let mut end = end;
        while end < input.len() && !input.is_char_boundary(end) {
            end += 1;
        }
        Self::new(input, start, end)
    }

    /// Returns the inclusive starting byte offset.
    #[must_use]
    pub const fn start(self) -> usize {
        self.start
    }

    /// Returns the exclusive ending byte offset.
    #[must_use]
    pub const fn end(self) -> usize {
        self.end
    }

    /// Returns the span length in bytes.
    #[must_use]
    pub const fn len(self) -> usize {
        self.end - self.start
    }

    /// Returns whether the start and end offsets are equal.
    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.start == self.end
    }

    pub(crate) const fn contains(self, other: Self) -> bool {
        self.start <= other.start && other.end <= self.end
    }
}

/// One secret match and its source locations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    /// Stable rule identifier.
    pub rule_id: String,
    /// Corpus that supplied the rule.
    pub rule_source: RuleSource,
    /// Range covering the complete match.
    pub full_span: TextSpan,
    /// Range covering the secret value.
    pub value_span: TextSpan,
    /// Optional range covering an associated key.
    pub key_span: Option<TextSpan>,
}

/// Version identifiers that define scanner semantics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScannerRevision {
    /// Scanner crate version.
    pub crate_version: &'static str,
    /// Version of the semantic digest encoding.
    pub semantic_digest_version: u8,
    /// Commit of the embedded upstream rule corpus.
    pub upstream_commit: &'static str,
}

/// Which bound stopped a scan before the rule set was exhausted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitExhausted {
    /// Candidate evaluation count reached its configured ceiling.
    Candidates,
    /// Charged input work reached its configured byte ceiling.
    Work,
}

impl fmt::Display for LimitExhausted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Candidates => "scanner candidate limit reached",
            Self::Work => "scanner work limit reached",
        })
    }
}

/// Findings and accounting produced by one scan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanReport {
    /// Findings sorted by input position.
    pub findings: Vec<Finding>,
    /// Scanner and corpus revision used for this scan.
    pub revision: ScannerRevision,
    /// Digest of semantics that affect scan results.
    pub semantic_digest: [u8; 32],
    /// Number of candidate matches evaluated.
    pub candidates_evaluated: usize,
    /// Total bytes charged while evaluating rules.
    pub work_bytes: usize,
    /// `Some` when a bound stopped the scan early, so absence of a finding
    /// proves nothing.
    ///
    /// The retained findings are an arbitrary subset of a complete report, not a prefix.
    /// Evaluation stops in rule order while `findings` is sorted by position, so a
    /// rule that never ran could have matched ahead of everything retained.
    pub limits_hit: Option<LimitExhausted>,
}

impl ScanReport {
    /// Whether every active rule ran to completion.
    #[must_use]
    pub const fn is_complete(&self) -> bool {
        self.limits_hit.is_none()
    }
}

/// Resource ceilings for one scan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScanLimits {
    /// Maximum accepted input length in bytes.
    pub max_input_bytes: usize,
    /// Maximum candidate matches evaluated.
    pub max_candidates: usize,
    /// Maximum bytes charged across rule evaluation.
    pub max_work_bytes: usize,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

impl ScanLimits {
    /// Exposed as a `const` so callers deriving their own limits can compare against it
    /// in a `const` assertion rather than at run time.
    pub const DEFAULT: Self = Self {
        max_input_bytes: MAX_INPUT_BYTES,
        max_candidates: 262_144,
        max_work_bytes: 512 * 1024 * 1024,
    };

    pub(crate) fn validate(self) -> Result<(), ConstructionError> {
        if self.max_input_bytes == 0 || self.max_input_bytes > MAX_INPUT_BYTES {
            return Err(ConstructionError::InvalidLimits);
        }
        if self.max_candidates == 0 || self.max_work_bytes == 0 {
            return Err(ConstructionError::InvalidLimits);
        }
        Ok(())
    }
}

/// Failure to validate embedded rules or configured limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConstructionError {
    /// Embedded upstream corpus does not match its pinned digest.
    CorpusDigestMismatch,
    /// Embedded conservative overlay does not match its pinned digest.
    OverlayDigestMismatch,
    /// Embedded rule document cannot be decoded.
    InvalidRuleDocument,
    /// Rule identity is missing or invalid.
    InvalidRuleIdentity,
    /// Rule pattern cannot be compiled.
    InvalidRulePattern,
    /// Rule policy is invalid.
    InvalidRulePolicy,
    /// One or more scan limits are zero or exceed the hard input ceiling.
    InvalidLimits,
}

impl fmt::Display for ConstructionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::CorpusDigestMismatch => "embedded scanner corpus digest mismatch",
            Self::OverlayDigestMismatch => "embedded scanner overlay digest mismatch",
            Self::InvalidRuleDocument => "invalid embedded scanner rule document",
            Self::InvalidRuleIdentity => "invalid embedded scanner rule identity",
            Self::InvalidRulePattern => "invalid embedded scanner rule pattern",
            Self::InvalidRulePolicy => "invalid embedded scanner rule policy",
            Self::InvalidLimits => "invalid scanner limits",
        })
    }
}

impl std::error::Error for ConstructionError {}

/// Failure while scanning one input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanError {
    /// Input exceeds the configured byte ceiling.
    InputLimitExceeded,
    /// A matched range is out of bounds or not on UTF-8 boundaries.
    InvalidSpan,
}

impl fmt::Display for ScanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InputLimitExceeded => "scanner input limit exceeded",
            Self::InvalidSpan => "scanner produced an invalid span",
        })
    }
}

impl std::error::Error for ScanError {}

pub(crate) const REVISION: ScannerRevision = ScannerRevision {
    crate_version: env!("CARGO_PKG_VERSION"),
    semantic_digest_version: 5,
    upstream_commit: "3d2869011138cd7812a12f893dc93635a961b0d7",
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapping_widens_interior_offsets_to_character_boundaries() {
        let input = "aé";
        assert!(!input.is_char_boundary(2));
        let span = TextSpan::snapped(input, 0, 2).unwrap();
        assert_eq!((span.start(), span.end()), (0, 3));
        assert_eq!(input.get(span.start()..span.end()), Some("aé"));

        let span = TextSpan::snapped(input, 2, 3).unwrap();
        assert_eq!((span.start(), span.end()), (1, 3));
        assert_eq!(input.get(span.start()..span.end()), Some("é"));
    }

    #[test]
    fn snapping_keeps_boundary_offsets_and_rejects_out_of_range() {
        let input = "abc";
        let span = TextSpan::snapped(input, 1, 2).unwrap();
        assert_eq!((span.start(), span.end()), (1, 2));
        assert_eq!(
            TextSpan::snapped(input, 0, 4).unwrap_err(),
            ScanError::InvalidSpan
        );
        assert_eq!(
            TextSpan::snapped(input, 2, 1).unwrap_err(),
            ScanError::InvalidSpan
        );
    }
}
