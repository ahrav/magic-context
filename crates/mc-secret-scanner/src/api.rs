use std::fmt;

pub const MAX_INPUT_BYTES: usize = 512 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanProfile {
    Conservative,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RuleSource {
    Upstream,
    ConservativeOverlay,
}

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

    #[must_use]
    pub const fn start(self) -> usize {
        self.start
    }

    #[must_use]
    pub const fn end(self) -> usize {
        self.end
    }

    #[must_use]
    pub const fn len(self) -> usize {
        self.end - self.start
    }

    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.start == self.end
    }

    pub(crate) const fn contains(self, other: Self) -> bool {
        self.start <= other.start && other.end <= self.end
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub rule_id: String,
    pub rule_source: RuleSource,
    pub full_span: TextSpan,
    pub value_span: TextSpan,
    pub key_span: Option<TextSpan>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScannerRevision {
    pub crate_version: &'static str,
    pub semantic_digest_version: u8,
    pub upstream_commit: &'static str,
}

/// Which bound stopped a scan before the rule set was exhausted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitExhausted {
    Candidates,
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanReport {
    pub findings: Vec<Finding>,
    pub revision: ScannerRevision,
    pub semantic_digest: [u8; 32],
    pub candidates_evaluated: usize,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScanLimits {
    pub max_input_bytes: usize,
    pub max_candidates: usize,
    pub max_work_bytes: usize,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_input_bytes: MAX_INPUT_BYTES,
            max_candidates: 262_144,
            max_work_bytes: 512 * 1024 * 1024,
        }
    }
}

impl ScanLimits {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConstructionError {
    CorpusDigestMismatch,
    OverlayDigestMismatch,
    InvalidRuleDocument,
    InvalidRuleIdentity,
    InvalidRulePattern,
    InvalidRulePolicy,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanError {
    InputLimitExceeded,
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
    semantic_digest_version: 4,
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
