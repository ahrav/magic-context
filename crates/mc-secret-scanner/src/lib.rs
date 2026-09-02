#![forbid(unsafe_code)]

#[cfg(test)]
mod anchor_proof;
mod api;
mod evaluator;
#[cfg(test)]
mod kernels;
mod rules;

pub use api::{
    ConstructionError, Finding, LimitExhausted, RuleSource, ScanError, ScanLimits, ScanProfile,
    ScanReport, ScannerRevision, TextSpan, MAX_INPUT_BYTES,
};
pub use rules::{CONSERVATIVE_OVERLAY_SHA256, UPSTREAM_CORPUS_SHA256};

use evaluator::evaluate;
use rules::RuleSet;
use std::sync::{Arc, LazyLock};

static EMBEDDED_RULES: LazyLock<Result<Arc<RuleSet>, ConstructionError>> =
    LazyLock::new(|| RuleSet::from_embedded().map(Arc::new));
static DEFAULT_DIGESTS: LazyLock<Result<[[u8; 32]; 2], ConstructionError>> = LazyLock::new(|| {
    let rules = EMBEDDED_RULES.as_ref().map_err(|error| *error)?;
    let limits = ScanLimits::default();
    Ok([
        rules.semantic_digest(ScanProfile::Conservative, limits)?,
        rules.semantic_digest(ScanProfile::Comprehensive, limits)?,
    ])
});

pub struct Scanner {
    rules: Arc<RuleSet>,
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
        let rules = EMBEDDED_RULES
            .as_ref()
            .map(Arc::clone)
            .map_err(|error| *error)?;
        let semantic_digest = if limits == ScanLimits::default() {
            DEFAULT_DIGESTS
                .as_ref()
                .map(|digests| {
                    digests[match profile {
                        ScanProfile::Conservative => 0,
                        ScanProfile::Comprehensive => 1,
                    }]
                })
                .map_err(|error| *error)?
        } else {
            rules.semantic_digest(profile, limits)?
        };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanners_share_compiled_embedded_rules() {
        let first = Scanner::new(ScanProfile::Conservative).unwrap();
        let second = Scanner::new(ScanProfile::Comprehensive).unwrap();
        assert!(Arc::ptr_eq(&first.rules, &second.rules));
    }
}
