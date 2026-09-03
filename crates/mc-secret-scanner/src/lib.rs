#![forbid(unsafe_code)]

//! Deterministic secret scanning backed by an embedded, shared rule set.
//!
//! Construction validates resource limits and binds a semantic digest to rules,
//! profile, and limits. Embedded rules and default-profile digests initialize
//! once and are shared across threads.

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
// Each profile owns its own cell, so constructing one profile never initializes the other profile's digest.
static CONSERVATIVE_DIGEST: LazyLock<Result<[u8; 32], ConstructionError>> =
    LazyLock::new(|| default_limits_digest(ScanProfile::Conservative));
static COMPREHENSIVE_DIGEST: LazyLock<Result<[u8; 32], ConstructionError>> =
    LazyLock::new(|| default_limits_digest(ScanProfile::Comprehensive));

fn default_limits_digest(profile: ScanProfile) -> Result<[u8; 32], ConstructionError> {
    let rules = EMBEDDED_RULES.as_ref().map_err(|error| *error)?;
    rules.semantic_digest(profile, ScanLimits::default())
}

pub struct Scanner {
    rules: Arc<RuleSet>,
    profile: ScanProfile,
    limits: ScanLimits,
    semantic_digest: [u8; 32],
}

impl Scanner {
    /// Uses default resource limits and the profile-specific cached semantic digest.
    ///
    /// Returns [`ConstructionError`] when embedded rules or their semantic digest
    /// cannot be constructed.
    pub fn new(profile: ScanProfile) -> Result<Self, ConstructionError> {
        Self::with_limits(profile, ScanLimits::default())
    }

    /// Validates resource limits before binding them into scanner semantics.
    ///
    /// Default limits reuse a lazily cached digest per profile. Custom limits
    /// compute their digest during construction. Invalid limits or rules return
    /// [`ConstructionError`].
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
            let cached = match profile {
                ScanProfile::Conservative => &CONSERVATIVE_DIGEST,
                ScanProfile::Comprehensive => &COMPREHENSIVE_DIGEST,
            };
            cached.as_ref().copied().map_err(|error| *error)?
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

    /// Scans UTF-8 input under the configured profile and limits.
    ///
    /// Returns [`ScanError`] only for input over the byte ceiling or an invalid span.
    /// Exhausting `max_candidates` or `max_work_bytes` returns `Ok` with `ScanReport::limits_hit` set, so callers must inspect it before treating an empty finding list as clean.
    pub fn scan(&self, input: &str) -> Result<ScanReport, ScanError> {
        evaluate(
            &self.rules,
            self.profile,
            self.limits,
            self.semantic_digest,
            input,
        )
    }

    /// Identifies the rule semantics, profile, and limits used for findings.
    #[must_use]
    pub fn semantic_digest(&self) -> [u8; 32] {
        self.semantic_digest
    }

    /// Reports which rule profile controls evaluation.
    #[must_use]
    pub fn profile(&self) -> ScanProfile {
        self.profile
    }

    /// Reports the scanner API and rule-semantics revision.
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
