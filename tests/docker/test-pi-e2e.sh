#!/usr/bin/env bash
# ----------------------------------------------------------------------
#
# Two scenarios:
#
#   ~/.local/share/cortexkit/magic-context/context.db
# The assertions query the shared DB rather than logs, so log formatting cannot affect their result.
# ----------------------------------------------------------------------

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
DB_PATH="$HOME/.local/share/cortexkit/magic-context/context.db"
PLUGIN_LOG="$(node -e 'console.log(require("os").tmpdir())')/pi/magic-context/magic-context.log"

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
# ----------------------------------------------------------------------
section "Phase 0: Pi installation sanity"
# Pi 0.71.x writes --version output to stderr, so capture both 2>&1.
PI_VERSION=$(pi --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
echo "  Pi version: ${PI_VERSION:-unknown}"
check "pi --version returns a value" "test -n \"$PI_VERSION\""

# ----------------------------------------------------------------------
# Dockerfile.
# ----------------------------------------------------------------------
section "Phase 1: SETUP_SMOKE — magic-context doctor --harness pi --force on a clean machine"

rm -rf "$HOME/.local/share/cortexkit" "$PLUGIN_LOG"

DOCTOR_OUT=$(magic-context doctor --harness pi --force 2>&1 || true)
echo "$DOCTOR_OUT" | tail -40

check "magic-context doctor --harness pi --force exits with a Doctor summary" \
    "echo \"\$DOCTOR_OUT\" | grep -qE 'Doctor (complete|repair complete|found failures)'"

check "Pi user config created at ~/.config/cortexkit/magic-context.jsonc" \
    "test -f $HOME/.config/cortexkit/magic-context.jsonc"

check "Pi settings.json registered the magic-context package" \
    "grep -q 'pi-magic-context' $HOME/.pi/agent/settings.json"

check "doctor confirms Pi version meets 0.71.0 floor" \
    "echo \"\$DOCTOR_OUT\" | grep -qE 'PASS Pi version meets minimum'"

# A Doctor summary with `FAIL 0` reports no failures.
check "doctor reports zero hard failures" \
    "echo \"\$DOCTOR_OUT\" | grep -qE 'FAIL 0'"

# ----------------------------------------------------------------------
# ----------------------------------------------------------------------
section "Phase 2: SESSION_SMOKE — single-turn pi --print with aimock"

# Keep the local registration so Pi does not resolve the extension through npm.
node -e '
  const fs = require("node:fs");
  const path = "/root/.pi/agent/settings.json";
  const settings = JSON.parse(fs.readFileSync(path, "utf-8"));
  if (Array.isArray(settings.packages)) {
    settings.packages = settings.packages
      .filter((p) => !String(p).includes("npm:") || !String(p).includes("pi-magic-context"))
      .concat(["file:/test/mc-pi"]);
    settings.packages = [...new Set(settings.packages)];
    fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  }
'

# SESSION_SMOKE disables subagents because it contains one main turn and configures aimock only for that turn.
mkdir -p "$HOME/.config/cortexkit"
cat > "$HOME/.config/cortexkit/magic-context.jsonc" <<'JSON'
{
  "enabled": true,
  "dreamer": { "enabled": false },
  "sidekick": { "enabled": false },
  "embedding": { "provider": "off" },
  "auto_update": false
}
JSON

# Pi reads custom OpenAI-compatible providers from `models.json`.
cat > "$HOME/.pi/agent/models.json" <<'JSON'
{
  "providers": {
    "mock": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:4010/v1",
      "apiKey": "sk-mock",
      "models": [
        {
          "id": "mock-model",
          "name": "Mock Model",
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
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

echo ""
set +e
timeout --signal=KILL 60 pi --print --mode json --no-session \
    --provider mock \
    --model "mock/mock-model" \
    "Say hello once and then stop." \
    > /tmp/pi.log 2>&1
PI_EXIT=$?
set -e
echo "  pi exit code: $PI_EXIT"
echo "  ── pi log tail ──"
tail -10 /tmp/pi.log

check "pi produced output" "test -s /tmp/pi.log"
check "magic-context plugin log exists" "test -s $PLUGIN_LOG"
check "shared SQLite DB created" "test -f $DB_PATH"

if [[ -f "$DB_PATH" ]]; then
    SESSION_META_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM session_meta WHERE harness='pi'" 2>/dev/null || echo "0")
    echo "  session_meta(harness='pi') row count: $SESSION_META_COUNT"
    check "at least one Pi session_meta row persisted" \
        "test \"$SESSION_META_COUNT\" -gt 0"

    SCHEMA_HAS_HARNESS=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM pragma_table_info('tags') WHERE name='harness'" 2>/dev/null || echo "0")
    check "shared DB schema includes the 'harness' column on tags" \
        "test \"$SCHEMA_HAS_HARNESS\" -gt 0"

    TAG_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM tags WHERE harness='pi'" 2>/dev/null || echo "0")
    echo "  tags(harness='pi') row count: $TAG_COUNT (informational)"
fi

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
section "Summary"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo ""
if [[ $FAIL -eq 0 ]]; then
    echo -e "${GREEN}All Pi E2E checks passed.${NC}"
    exit 0
else
    echo -e "${RED}Pi E2E checks failed.${NC}"
    exit 1
fi
