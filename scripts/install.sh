#!/usr/bin/env bash
set -euo pipefail

# Magic Context — Interactive Setup
# Usage: curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/main/scripts/install.sh | bash

PACKAGE="@cortexkit/magic-context"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=12

# Return 0 if system node satisfies the minimum version (Clack prompts need
# node:util.styleText which landed in Node 20.12).
check_node_version() {
  if ! command -v node &>/dev/null; then
    return 1
  fi
  local version major minor
  version=$(node -v 2>/dev/null | sed 's/^v//')
  major=$(echo "$version" | cut -d. -f1)
  minor=$(echo "$version" | cut -d. -f2)
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    return 1
  fi
  if [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -lt "$MIN_NODE_MINOR" ]; then
    return 1
  fi
  return 0
}

main() {
  echo ""
  echo "  ✨ Magic Context — Setup"
  echo "  ────────────────────────"
  echo ""

  # Always pin "@latest": without an explicit version, npx resolves from its
  # on-disk cache rather than re-resolving the npm dist-tag. A user who
  # previously installed (e.g.) v0.15.4 would keep getting the cached bundle
  # even after a patch ships. "@latest" forces a registry round-trip that
  # respects the moving npm tag.
  #
  # Stdin is redirected from /dev/tty so @clack/prompts can read interactive
  # input even when the parent shell is `curl | bash` (no stdin).
  if check_node_version && command -v npx &>/dev/null; then
    NODE_VERSION=$(node -v 2>/dev/null | sed 's/^v//')
    echo "  → Using npx (Node $NODE_VERSION)"
    echo ""
    npx -y "$PACKAGE@latest" setup </dev/tty
  else
    echo "  ✗ Node $MIN_NODE_MAJOR.$MIN_NODE_MINOR+ with npx is required."
    echo ""
    echo "  Install Node from https://nodejs.org (>= $MIN_NODE_MAJOR.$MIN_NODE_MINOR), then run:"
    echo ""
    echo "    npx $PACKAGE@latest setup"
    echo ""
    exit 1
  fi
}

main "$@"
