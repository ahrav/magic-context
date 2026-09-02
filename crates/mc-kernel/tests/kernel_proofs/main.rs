//! Kernel replay/repair correctness proofs: one binary carrying the shared
//! canonical-state oracle, the proof harness, the randomized operation model,
//! per-obligation proofs, and the policy-matrix registry.
//!
//! Every submodule is declared here so the binary links once; code other test
//! binaries share lives under `tests/support/` and is `#[path]`-included.

#![cfg(feature = "test-support")]

#[path = "../support/canonical_state.rs"]
mod canonical_state;
#[path = "../support/git_fixtures.rs"]
mod git_fixtures;

mod fixtures;
mod harness;
mod model;
mod obligations;
mod oracle;
