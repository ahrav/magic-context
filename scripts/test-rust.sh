#!/usr/bin/env sh
# Rust suite entry point. nextest is preferred for execution speed but is not
# part of the standard toolchain, so a clean checkout falls back to cargo
# test. nextest does not run doctests; its branch runs them separately, while
# plain cargo test already includes them.
set -e

if cargo nextest --version >/dev/null 2>&1; then
    cargo nextest run --workspace
    cargo test --workspace --doc
else
    echo "cargo-nextest not found (install: cargo install cargo-nextest --locked); using cargo test" >&2
    cargo test --workspace
fi
