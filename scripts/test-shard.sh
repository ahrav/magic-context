#!/usr/bin/env sh
# bun --parallel implies --isolate.
set -e

dir=${1:?usage: test-shard.sh <package-dir> [shards]}
n=${2:-$(nproc 2>/dev/null || echo 4)}
if [ "$n" -gt 8 ]; then n=8; fi

cd "$(dirname "$0")/../$dir"
seq 1 "$n" | xargs -P "$n" -I{} bun test --shard={}/"$n"
