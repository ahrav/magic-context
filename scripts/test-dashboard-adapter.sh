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
# root, so this crate's own [workspace] is the resolution root for clippy and
# test. `cargo fmt` still walks up past it to the repository root, whose members
# reference the ../commons/* siblings, so a bare checkout needs
# provision-rust-ci-stubs.sh to have run first — the CI job does that, and a dev
# checkout already has the real siblings. The crate's own dependency graph
# excludes the cortexkit-* crates, because it takes mc-core with
# default-features = false; the stubs only satisfy workspace resolution.
set -e

cd "$(dirname "$0")/../packages/dashboard/db-adapter"

cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
