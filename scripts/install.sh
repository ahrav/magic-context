#!/usr/bin/env bash
set -euo pipefail

# Run the installer with `curl -fsSL https://raw.githubusercontent.com/ahrav/magic-context/main/scripts/install.sh | bash`.

PACKAGE="@cortexkit/magic-context"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=12

# Clack prompts require `node:util.styleText`, introduced in Node 20.12.
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

  # Use `@latest` so npx resolves the current npm dist-tag instead of reusing its cache.
  #
  # Redirect stdin from `/dev/tty` so `@clack/prompts` stays interactive under `curl | bash`.
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
