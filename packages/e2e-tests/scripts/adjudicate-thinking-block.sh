#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
E2E_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
ARTIFACT="$E2E_DIR/mutations/thinking-block-adjudication.md"
mkdir -p "$(dirname -- "$ARTIFACT")"

pass_count=0
fail_count=0
failure_output=""
for run in $(seq 1 20); do
  output=""
  status=0
  output=$(cd "$E2E_DIR" && MC_E2E_MODE=ts NODE_ENV="" bun test --timeout 600000 --max-concurrency=1 tests/thinking-block-safety.test.ts 2>&1) || status=$?
  if ! printf '%s\n' "$output" | grep -qE "[1-9][0-9]* fail" && printf '%s\n' "$output" | grep -qE "[1-9][0-9]* pass"; then
    pass_count=$((pass_count + 1))
  else
    fail_count=$((fail_count + 1))
    failure_output+=$'\n### Invocation '\"$run\"$' (exit '\"$status\"$')\n\n```text\n'"$output"$'\n```\n'
  fi
done

if [[ "$fail_count" -eq 0 ]]; then
  verdict="No failure was observed in 20 serialized invocations; this run neither reproduces a flake nor provides evidence of a real failure."
elif [[ "$pass_count" -gt 0 ]]; then
  verdict="Flake: $fail_count of 20 invocations failed while $pass_count passed; the mixed result is intermittent. The repeated assertion output is recorded below, and no test or product code was changed."
else
  verdict="Real failure: all 20 invocations failed; the failure is stable. The output is recorded below, and no test or product code was changed."
fi

cat > "$ARTIFACT" <<EOF

The suite was invoked serially 20 times. This artifact records the observed
verdict without changing the suite or the harness to make a failure disappear.

- Command: MC_E2E_MODE=ts NODE_ENV="" bun test --timeout 600000 --max-concurrency=1 tests/thinking-block-safety.test.ts
- Pass count: $pass_count
- Fail count: $fail_count
- Verdict: $verdict

${failure_output:-No failure output; all 20 invocations produced a passing summary.}
EOF

printf 'thinking-block adjudication: %s pass, %s fail\n' "$pass_count" "$fail_count"
[[ "$fail_count" -eq 0 ]]
