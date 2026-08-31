#!/usr/bin/env sh
# Exit 0 prints `in-sync`. Failures reported through `fail` exit 1 after printing one of:
#   fetch-unavailable         cannot reach upstream repository
#   missing-ref               pinned commit or watched branch did not resolve
#   source-inventory-mismatch inventory validation failed
#   source-drift              watched source differs from the pinned digest
#
# Fetches land in a scratch git directory, so this repository is never written to.
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
inventory="$repo_root/crates/mc-secret-scanner/SOURCE-INVENTORY.md"
upstream_url="https://github.com/ahrav/gossip-rs"
watched_branch="main"

watched_sources="crates/scanner-engine/default_rules.yaml
crates/scanner-engine/src/api.rs
crates/scanner-engine/src/rules/yaml.rs
crates/scanner-engine/src/engine/helpers/entropy.rs
crates/scanner-engine/src/engine/offline_validate.rs
crates/scanner-engine/src/engine/safelist.rs
crates/scanner-engine/src/engine/window_validate.rs
LICENSE"

fail() {
    printf '%s: %s\n' "$1" "$2" >&2
    exit 1
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

recorded_digest() {
    awk -F'|' -v path="$1" '
        $0 ~ /^\|/ {
            gsub(/[ `]/, "", $2)
            if ($2 == path) {
                gsub(/[ `]/, "", $4)
                print $4
                exit
            }
        }
    ' "$inventory"
}

[ -f "$inventory" ] || fail source-inventory-mismatch "missing $inventory"

pinned_commit=$(sed -n 's/^Pinned commit: `\([0-9a-f]\{40\}\)`.*$/\1/p' "$inventory" | head -n1)
if [ -z "$pinned_commit" ]; then
    fail source-inventory-mismatch "no pinned commit recorded"
fi

# The overlay digest is recorded as prose, not as a table row.
overlay_recorded=$(grep -o '`[0-9a-f]\{64\}`' "$inventory" | tr -d '`' | tail -n1)
overlay_actual=$(sha256_of "$repo_root/crates/mc-secret-scanner/conservative_overlay.yaml")
if [ "$overlay_recorded" != "$overlay_actual" ]; then
    fail source-inventory-mismatch "conservative_overlay.yaml hashes to $overlay_actual"
fi

corpus_recorded=$(recorded_digest crates/scanner-engine/default_rules.yaml)
corpus_actual=$(sha256_of "$repo_root/crates/mc-secret-scanner/default_rules.yaml")
if [ "$corpus_recorded" != "$corpus_actual" ]; then
    fail source-inventory-mismatch "default_rules.yaml hashes to $corpus_actual"
fi

for source in $watched_sources; do
    if [ -z "$(recorded_digest "$source")" ]; then
        fail source-inventory-mismatch "no digest recorded for $source"
    fi
done

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
GIT_DIR="$scratch/upstream.git"
export GIT_DIR
git init --quiet --bare "$GIT_DIR"

if ! git ls-remote --quiet "$upstream_url" >/dev/null 2>&1; then
    fail fetch-unavailable "cannot reach $upstream_url"
fi

fetch_ref() {
    if ! git fetch --quiet --depth=1 "$upstream_url" "$1" >/dev/null 2>&1; then
        fail missing-ref "$1 is not present in $upstream_url"
    fi
    if ! git rev-parse --verify --quiet FETCH_HEAD >"$scratch/resolved"; then
        fail missing-ref "$1 did not resolve"
    fi
    cat "$scratch/resolved"
}

pinned_head=$(fetch_ref "$pinned_commit")
watched_head=$(fetch_ref "$watched_branch")

upstream_digest() {
    if ! git cat-file blob "$1:$2" >"$scratch/blob" 2>/dev/null; then
        echo absent
        return 0
    fi
    sha256_of "$scratch/blob"
}

drift=""
for source in $watched_sources; do
    expected=$(recorded_digest "$source")
    pinned_digest=$(upstream_digest "$pinned_head" "$source")
    if [ "$pinned_digest" != "$expected" ]; then
        fail source-inventory-mismatch "$source at $pinned_commit hashes to $pinned_digest"
    fi
    watched_digest=$(upstream_digest "$watched_head" "$source")
    if [ "$watched_digest" != "$expected" ]; then
        printf 'source-drift: %s is %s on %s\n' "$source" "$watched_digest" "$watched_branch" >&2
        drift="$drift $source"
    fi
done

if [ -n "$drift" ]; then
    fail source-drift "record a disposition in crates/mc-secret-scanner/UPSTREAM-DISPOSITIONS.md for:$drift"
fi

printf 'in-sync: watched sources match %s and %s\n' "$pinned_commit" "$watched_branch"
