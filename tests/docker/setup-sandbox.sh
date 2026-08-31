#!/usr/bin/env bash
#
#
#
# Usage:
#
#   docker run --rm -it --platform linux/amd64 mc-setup-sandbox

set -euo pipefail

IMAGE="mc-setup-sandbox"
PLATFORM="linux/amd64"
MC_VERSION="latest"
BUILD_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    --*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *) MC_VERSION="$arg" ;;
  esac
done

# The script resolves REPO_ROOT from its own location, so it works from any working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Building $IMAGE (magic-context@$MC_VERSION, fresh npm fetch)..."
docker build \
  --platform "$PLATFORM" \
  --build-arg "MC_VERSION=$MC_VERSION" \
  --build-arg "CACHE_BUST=$(date +%s)" \
  -f "$SCRIPT_DIR/Dockerfile.setup-sandbox" \
  -t "$IMAGE" \
  "$REPO_ROOT"

if [[ "$BUILD_ONLY" == "1" ]]; then
  echo "Built $IMAGE. Run interactively with:"
  echo "  docker run --rm -it --platform $PLATFORM $IMAGE"
  exit 0
fi

echo "Starting interactive shell in $IMAGE..."
exec docker run --rm -it --platform "$PLATFORM" "$IMAGE"
