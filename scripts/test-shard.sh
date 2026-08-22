#!/usr/bin/env sh
# bun --parallel implies --isolate.
set -e

dir=${1:?usage: test-shard.sh <package-dir> [shards]}
n=${2:-$(nproc 2>/dev/null || echo 4)}
if [ "$n" -gt 8 ]; then n=8; fi

cd "$(dirname "$0")/../$dir"
# POSIX shard enumeration: no dependency on GNU coreutils, matching the
# nproc fallback above.
i=1
while [ "$i" -le "$n" ]; do
    echo "$i"
    i=$((i + 1))
done | xargs -P "$n" -I{} bun test --shard={}/"$n"
