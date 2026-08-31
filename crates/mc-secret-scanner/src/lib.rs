#![forbid(unsafe_code)]

mod api;
mod evaluator;
mod rules;

pub use api::{
    ConstructionError, Finding, RuleSource, ScanError, ScanLimits, ScanProfile, ScanReport,
    ScannerRevision, TextSpan, MAX_INPUT_BYTES,
};
pub use rules::{CONSERVATIVE_OVERLAY_SHA256, UPSTREAM_CORPUS_SHA256};

use evaluator::evaluate;
use rules::RuleSet;

pub struct Scanner {
    rules: RuleSet,
    profile: ScanProfile,
    limits: ScanLimits,
    semantic_digest: [u8; 32],
}

impl Scanner {
    pub fn new(profile: ScanProfile) -> Result<Self, ConstructionError> {
        Self::with_limits(profile, ScanLimits::default())
    }

    pub fn with_limits(
        profile: ScanProfile,
        limits: ScanLimits,
    ) -> Result<Self, ConstructionError> {
        limits.validate()?;
        let rules = RuleSet::from_embedded()?;
        let semantic_digest = rules.semantic_digest(profile, limits)?;
        Ok(Self {
            rules,
            profile,
            limits,
            semantic_digest,
        })
    }

    pub fn scan(&self, input: &str) -> Result<ScanReport, ScanError> {
        evaluate(
            &self.rules,
            self.profile,
            self.limits,
            self.semantic_digest,
            input,
        )
    }

    #[must_use]
    pub fn semantic_digest(&self) -> [u8; 32] {
        self.semantic_digest
    }

    #[must_use]
    pub fn profile(&self) -> ScanProfile {
        self.profile
    }

    #[must_use]
    pub const fn revision(&self) -> ScannerRevision {
        api::REVISION
    }
}
