#!/usr/bin/env sh
set -e

dir=${1:?usage: test-shard.sh <package-dir> [shards]}
n=${2:-$(nproc 2>/dev/null || echo 4)}
if [ "$n" -lt 1 ]; then n=1; fi
if [ "$n" -gt 8 ]; then n=8; fi

cd "$(dirname "$0")/../$dir"

if ! bun test --help 2>/dev/null | grep -q -- '--shard='; then
    echo "this bun ($(bun --version)) lacks bun test --shard=<i>/<n>; running unsharded" >&2
    exec bun test
fi

# The loop avoids a GNU coreutils dependency while enumerating shards.
i=1
while [ "$i" -le "$n" ]; do
    echo "$i"
    i=$((i + 1))
done | xargs -P "$n" -I{} bun test --shard={}/"$n"
