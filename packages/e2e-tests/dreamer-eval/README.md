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
  --output-dir artifacts/dreamer-eval
```

Each task repeat gets a fresh harness database and fixture repository. The
command runs in its own Bun process so the runner's temporary keep-subagents
setting cannot leak into a shared test process. Output is grouped under
`<output-dir>/<scenario>/<task>/`: one versioned run report per repeat and one
`variance.json` artifact for the set.

Every report records the plugin entrypoint and a digest of the bytes the harness
loaded, alongside the commit. The harness prefers `packages/plugin/dist/index.js`
when it exists and falls back to `packages/plugin/src/index.ts`, so the commit
alone does not identify what ran: a dirty tree or a stale bundle would otherwise
let two runs of different implementations aggregate as repeats of one experiment.
Variance refuses a set whose reports disagree on any part of that tuple. Build
the bundle, or remove it, before a run whose repeats must be comparable.

Exit codes are `0` when every run passes, `1` for any ordinary FAIL or ERROR,
and `2` when any run archives a gold-true claim. Missing credentials, invalid
filters, malformed scenarios, and artifact failures exit `1`.

## Authoring scenarios

Add one JSON file per scenario under `dev/`; its filename must match its id.
Every pool has 10-50 hygiene-visible ordinary claims. Gold uses logical claim
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
