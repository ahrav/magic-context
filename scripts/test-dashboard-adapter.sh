#!/usr/bin/env sh
# Dashboard claim-adapter suite entry point.
#
# packages/dashboard/db-adapter declares its own [workspace], so it is invisible
# to the root `cargo fmt/clippy/test --workspace` commands and needs an explicit
# manifest path. It is also the only place the dashboard's claim_adapter.rs and
# sqlite_runtime.rs are compiled under test: src-tauri pulls the GTK/WebKit
# stack, which is absent from headless CI and most dev machines, so this crate
# re-includes both files via #[path] to keep them testable without a GUI.
#
# The crate builds standalone: it takes mc-core with default-features = false,
# which drops the cortexkit-* sibling path dependencies, so it needs no
# provision-rust-ci-stubs.sh run.
set -e

MANIFEST=packages/dashboard/db-adapter/Cargo.toml

cargo fmt --manifest-path "$MANIFEST" --all --check
cargo clippy --manifest-path "$MANIFEST" --all-targets -- -D warnings
cargo test --manifest-path "$MANIFEST"
