#!/usr/bin/env sh
# Dashboard claim-adapter suite entry point.
#
# packages/dashboard/db-adapter declares its own [workspace], so it is invisible
# to the root `cargo fmt/clippy/test --workspace` commands. It is also the only
# place the dashboard's claim_adapter.rs and sqlite_runtime.rs are compiled under
# test: src-tauri pulls the GTK/WebKit stack, which is absent from headless CI
# and most dev machines, so this crate re-includes both files via #[path] to keep
# them testable without a GUI.
#
# Run from the crate directory rather than passing --manifest-path from the repo
# root. `cargo fmt` re-resolves the workspace from the working directory, so the
# root-relative form loads the ROOT workspace and fails on `crates/mc-core`'s
# ../commons/* sibling path dependencies, which are absent unless
# provision-rust-ci-stubs.sh has run. Entering the directory makes this crate's
# own [workspace] the root, and its dependency graph genuinely excludes the
# cortexkit-* crates because it takes mc-core with default-features = false.
set -e

cd "$(dirname "$0")/../packages/dashboard/db-adapter"

cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
