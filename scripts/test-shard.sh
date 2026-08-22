#!/usr/bin/env sh
# bun --parallel implies --isolate.
set -e

dir=${1:?usage: test-shard.sh <package-dir> [shards]}
n=${2:-$(nproc 2>/dev/null || echo 4)}
# Floor before cap: a zero (explicit argument, or a quota-constrained nproc)
# would otherwise skip the shard loop entirely and exit 0 with no tests run.
if [ "$n" -lt 1 ]; then n=1; fi
if [ "$n" -gt 8 ]; then n=8; fi

cd "$(dirname "$0")/../$dir"

# Older Bun silently ignores unknown flags, so an unsupported --shard would
# run N complete copies of the suite concurrently instead of N disjoint
# shards. Probe for the exact equals form used below and run the suite once
# when it is missing.
if ! bun test --help 2>/dev/null | grep -q -- '--shard='; then
    echo "this bun ($(bun --version)) lacks bun test --shard=<i>/<n>; running unsharded" >&2
    exec bun test
fi

# POSIX shard enumeration: no dependency on GNU coreutils, matching the
# nproc fallback above.
i=1
while [ "$i" -le "$n" ]; do
    echo "$i"
    i=$((i + 1))
done | xargs -P "$n" -I{} bun test --shard={}/"$n"
