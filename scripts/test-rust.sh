#!/usr/bin/env sh
# cargo nextest run does not run doctests, so run cargo test --doc after it.
# cargo test --workspace runs doctests.
set -e

if cargo nextest --version >/dev/null 2>&1; then
    cargo nextest run --workspace
    cargo test --workspace --doc
else
    echo "cargo-nextest not found (install: cargo install cargo-nextest --locked); using cargo test" >&2
    cargo test --workspace
fi
