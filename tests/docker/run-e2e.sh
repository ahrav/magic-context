#!/usr/bin/env bash
#
# Usage:
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="${1:-all}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

run_target() {
    local harness="$1"
    local dockerfile="$SCRIPT_DIR/Dockerfile.$harness"
    local image="mc-e2e-$harness"

    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "  Building $image image (linux/amd64)..."
    echo "════════════════════════════════════════════════════════════"
    docker build \
        --platform linux/amd64 \
        -f "$dockerfile" \
        -t "$image" \
        "$REPO_ROOT"

    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "  Running $image..."
    echo "════════════════════════════════════════════════════════════"
    if docker run --rm --platform linux/amd64 "$image"; then
        echo -e "${GREEN}✓ $harness E2E PASSED${NC}"
        return 0
    else
        echo -e "${RED}✗ $harness E2E FAILED${NC}"
        return 1
    fi
}

echo "Pre-building local dist artifacts..."
bun run --cwd "$REPO_ROOT/packages/plugin" build
bun run --cwd "$REPO_ROOT/packages/pi-plugin" build
bun run --cwd "$REPO_ROOT/packages/pi-plugin" build:e2e-argv
bun run --cwd "$REPO_ROOT/packages/cli" build


EXIT=0
case "$TARGET" in
    all)
        run_target opencode || EXIT=1
        run_target pi || EXIT=1
        run_target omp || EXIT=1
        ;;
    opencode|pi|omp)
        run_target "$TARGET" || EXIT=1
        ;;
    *)
        echo "Unknown target: $TARGET" >&2
        echo "Usage: $0 [opencode|pi|omp|all]" >&2
        exit 2
        ;;
esac

echo ""
if [[ $EXIT -eq 0 ]]; then
    echo -e "${GREEN}All requested E2E targets passed.${NC}"
else
    echo -e "${RED}One or more E2E targets failed.${NC}"
fi
exit $EXIT
