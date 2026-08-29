# Dreamer manifest eval lane

This lane checks dreamer `verify`, `verify-broad`, `map-memories`, and
`classify-memories` manifests against hand-authored structural gold. It never
uses an LLM judge. Archiving a claim whose gold verdict is true is run-fatal.

## Layout

```text
dreamer-eval/dev/                 development scenario JSON
src/dreamer-eval/contract.ts     scenario and per-run report contracts
src/dreamer-eval/scorer.ts       pure manifest scorers
src/dreamer-eval/seeder.ts       fresh pool and production gate preflight
src/dreamer-eval/runner.ts       direct live task invocation and run record
src/dreamer-eval/variance.ts     repeat-run claim histograms
scripts/run-dreamer-eval.ts      live operator command
```

## Commands

Run deterministic checks without credentials:

```sh
bun run test:dreamer-eval-unit
bun run typecheck
```

Run the live lane from `packages/e2e-tests`:

```sh
ANTHROPIC_API_KEY=... \
DREAMER_EVAL_MODEL=anthropic/claude-sonnet-4-5 \
bun scripts/run-dreamer-eval.ts --repeat 3
```

Filters can be repeated. With no filters, the command runs every task declared
by every development scenario.

```sh
bun scripts/run-dreamer-eval.ts \
  --scenario dme-core-pool \
  --task verify \
  --repeat 3 \
  --deadline-minutes 280 \
  --output-dir artifacts/dreamer-eval
```

Each task repeat gets a fresh harness database and fixture repository. The
command runs in its own Bun process so the runner's temporary keep-subagents
setting cannot leak into a shared test process. Output is grouped under
`<output-dir>/<scenario>/<task>/`: one versioned run report per repeat and one
`variance.json` artifact for the set. `observedRuns` counts manifests that
included a claim, while `missingRuns` includes sparse outputs and repeats skipped
after the script-level deadline. `repeatCount` remains the requested repeat count.
The deadline is checked between paid runs, leaving time for variance writes and
artifact upload before the enclosing workflow timeout.

Exit codes are `0` when every run passes, `1` for any ordinary FAIL or ERROR,
and `2` when any run archives a gold-true claim. Missing credentials, invalid
filters, malformed scenarios, and artifact failures exit `1`.

## Authoring scenarios

Add one JSON file per scenario under `dev/`; its filename must match its id.
Every pool has at most 50 ordinary claims, including at least 10 hygiene-visible claims. Gold uses logical claim
ids from the pool, while the runner resolves production public ids after
seeding. Verify gold excludes file-independent claims. Map and classify gold
include them. Every task declares the exact in-scope and skipped partition that
the production gate must return before a model request is allowed.

`dme-core-pool` covers semantic duplicates, load-bearing near duplicates,
stale and contradictory claims, false-but-fluent text, a file-independent
constraint, a rejected alternative, and branch-specific context.
`dme-verify-broad-history` is the dedicated broad-cycle scenario. It seeds
verification history and requires `broad` result mode.

Curate end-state scoring is phase 2 and is not implemented here. Run reports
retain pre-run and post-run snapshots, raw and parsed manifests, receipts, and
the system tuple needed to add that scorer without rerunning the model.
