#!/usr/bin/env bash
# ----------------------------------------------------------------------
# This script runs Magic Context OpenCode end-to-end tests inside Docker.
#
# Two scenarios:
# SETUP_SMOKE tests the fresh-install path with `doctor --force`.
# SESSION_SMOKE runs one `opencode run` turn against aimock.
#
# SETUP_SMOKE and SESSION_SMOKE query `~/.local/share/cortexkit/magic-context/context.db`.
#   ~/.local/share/cortexkit/magic-context/context.db
# The scenarios query SQLite instead of parsing logs.
# ----------------------------------------------------------------------

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
DB_PATH="$HOME/.local/share/cortexkit/magic-context/context.db"
PLUGIN_LOG="$(node -e 'console.log(require("os").tmpdir())')/opencode/magic-context/magic-context.log"

check() {
    local label="$1"
    local condition="$2"
    if eval "$condition"; then
        echo -e "  ${GREEN}PASS${NC} [$label]"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${NC} [$label]"
        FAIL=$((FAIL + 1))
    fi
}

section() {
    echo ""
    echo -e "${BLUE}─── $1 ───${NC}"
    echo ""
}

# ----------------------------------------------------------------------
# The test installs the local plugin to avoid npm's published package.
# ----------------------------------------------------------------------
section "Phase 0: install Magic Context locally"
cd /test/mc-opencode
npm install --no-audit --no-fund --omit=dev 2>&1 | tail -5
npm link --silent --no-audit --no-fund 2>&1 | tail -3 || true
test -d node_modules/@opencode-ai/plugin \
    || { echo -e "${RED}@opencode-ai/plugin missing after install${NC}"; exit 1; }
cd /test/project

# ----------------------------------------------------------------------
# `doctor --force` does not create `opencode.json`, so this test seeds an empty file.
# ----------------------------------------------------------------------
section "Phase 1: SETUP_SMOKE — doctor --force on a fresh OpenCode install"

rm -rf "$HOME/.config/opencode" "$HOME/.local/share/cortexkit" "$PLUGIN_LOG"
mkdir -p "$HOME/.config/opencode"
echo '{}' > "$HOME/.config/opencode/opencode.json"

DOCTOR_OUT=$(magic-context doctor --harness opencode --force 2>&1 || true)
echo "$DOCTOR_OUT" | tail -30

# Doctor emits exactly one of four outro formats.
# Doctor can print `Everything looks good!`.
# Doctor can print `Found N issue(s), fixed M. Restart OpenCode to apply.`
# Doctor can print `Fixed M issue(s). Restart OpenCode to apply.`
# Doctor can print `Found N issue(s) that need manual attention.`
# The first three outro formats match the success regex; the manual-attention format does not.
check "doctor --force completed without hard failures" \
    "echo \"\$DOCTOR_OUT\" | grep -qE '(Everything looks good|Fixed [0-9]+ issue|Found [0-9]+ issue\\(s\\), fixed)'"

check "OpenCode config still exists at ~/.config/opencode/opencode.json" \
    "test -f $HOME/.config/opencode/opencode.json"

check "Plugin entry registered in OpenCode config" \
    "grep -qE '@cortexkit/opencode-magic-context' $HOME/.config/opencode/opencode.json"

# Magic Context creates its DB on first plugin load; `doctor` can complete without creating it.
check "doctor did not leave issues that need manual attention" \
    "! echo \"\$DOCTOR_OUT\" | grep -qE 'need manual attention'"

# ----------------------------------------------------------------------
# Two assertions:
# ----------------------------------------------------------------------
section "Phase 2: SESSION_SMOKE — single-turn opencode run with aimock"

# `file:///test/mc-opencode` forces OpenCode to load the working-tree plugin instead of its cached `@latest` npm package.
cat > "$HOME/.config/opencode/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///test/mc-opencode"],
  "compaction": { "auto": false, "prune": false },
  "provider": {
    "mock": {
      "api": "openai",
      "name": "aimock",
      "options": { "baseURL": "http://127.0.0.1:4010/v1" },
      "models": { "mock-model": { "name": "Mock Model" } }
    }
  }
}
JSON

# Local embeddings and the mock historian model keep background historian requests off external APIs.
cat > "$HOME/.config/opencode/magic-context.jsonc" <<'JSON'
{
  "enabled": true,
  "historian": { "model": "mock/mock-model" },
  "dreamer": { "enabled": false },
  "sidekick": { "enabled": false },
  "embedding": { "provider": "off" },
  "auto_update": false
}
JSON

node /test/aimock-server.cjs > /tmp/aimock.log 2>&1 &
AIMOCK_PID=$!
# shellcheck disable=SC2064
trap "kill $AIMOCK_PID 2>/dev/null || true" EXIT

for _ in $(seq 1 15); do
    if curl -fsS http://127.0.0.1:4010/v1/models > /dev/null 2>&1; then
        break
    fi
    sleep 1
done
check "aimock /v1/models responds" \
    "curl -fsS http://127.0.0.1:4010/v1/models > /dev/null"

# The 60-second timeout prevents a hung mock request from blocking CI.
echo ""
set +e
OPENAI_API_KEY=sk-mock-e2e-test \
    timeout --signal=KILL 60 opencode run \
        --model "mock/mock-model" \
        "Say hello once and then stop." \
        > /tmp/opencode.log 2>&1
OC_EXIT=$?
set -e
echo "  opencode exit code: $OC_EXIT"
echo "  ── opencode log tail ──"
tail -20 /tmp/opencode.log

check "opencode produced a log file" "test -s /tmp/opencode.log"

check "magic-context plugin log exists" "test -s $PLUGIN_LOG"

check "shared SQLite DB created" "test -f $DB_PATH"

if [[ -f "$DB_PATH" ]]; then
    SESSION_META_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM session_meta WHERE harness='opencode'" 2>/dev/null || echo "0")
    echo "  session_meta(harness='opencode') row count: $SESSION_META_COUNT"
    check "at least one OpenCode session_meta row persisted" \
        "test \"$SESSION_META_COUNT\" -gt 0"

    # The test requires `session_meta.harness='opencode'` rather than `tags` rows because the 60-second SIGKILL can interrupt tag persistence after `session_meta` is written.
    SCHEMA_HAS_HARNESS=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM pragma_table_info('tags') WHERE name='harness'" 2>/dev/null || echo "0")
    check "shared DB schema includes the 'harness' column on tags" \
        "test \"$SCHEMA_HAS_HARNESS\" -gt 0"

    TAG_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM tags WHERE harness='opencode'" 2>/dev/null || echo "0")
    echo "  tags(harness='opencode') row count: $TAG_COUNT (informational)"
fi

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
section "Summary"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo ""
if [[ $FAIL -eq 0 ]]; then
    echo -e "${GREEN}All OpenCode E2E checks passed.${NC}"
    exit 0
else
    echo -e "${RED}OpenCode E2E checks failed.${NC}"
    exit 1
fi
