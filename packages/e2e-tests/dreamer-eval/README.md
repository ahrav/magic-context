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
`variance.json` artifact for the set. A run that produced no verdict for a
claim counts in that claim's histogram under the `missing` bucket, so sparse
outputs stay visible; `repeatCount` counts the reports actually aggregated.

`<output-dir>/coverage.json` records what the invocation set out to observe: every
selected scenario/task group with its `requestedRuns`, the `archivedRuns` written
under it, and whether its `variance.json` exists. It is written for every outcome,
so the archive alone distinguishes a group a filter excluded — absent — from one
selected and then skipped, which appears with `archivedRuns: 0`, and shows a group
truncated after one of three repeats as `requestedRuns: 3, archivedRuns: 1` rather
than as a complete one-repeat experiment. `complete` is false whenever a requested
run or a variance file is missing. It is a separate artifact because the report and
variance contracts are archived evidence older tooling must keep parsing, and
because a wholly skipped group has no report to aggregate and so can carry no
variance artifact at all.

`--output-dir` must be empty or absent, and the run refuses before spending model
credits when it is not. Run ids are per-run UUIDs, so a reused directory
accumulates reports instead of replacing them: `archivedRuns` would count only the
newest invocation's reports while the directory held an earlier one's,
`variance.json` would be rewritten as an aggregate of just those newest reports,
and a group directory left by an earlier filtered run would sit beside a
`coverage.json` that does not list it. Keeping one invocation's evidence per tree
is what makes `archivedRuns` checkable by counting files. Remove the directory or
pass a fresh path to rerun.

There is no deadline by default. `--deadline-minutes <n>` bounds the live loop
for callers running under an external timeout: before each run after the
first, the script checks that the longest completed run still fits in the
remaining budget, so a run is never started that the enclosing workflow
timeout would kill mid-flight. Deadline truncation exits `1`.

Every report records the plugin entrypoint and a digest of everything the run's
outcome depends on that the commit does not pin: the loaded bundle's bytes when a
bundle is loaded, plus every working-tree deviation from HEAD with its content, so
an edited untracked module moves the digest too. The scope is the whole repository
because the runner, scorers, contract, seeder, and corpus decide a result as much
as the plugin does. The harness prefers `packages/plugin/dist/index.js` when it
exists and falls back to `packages/plugin/src/index.ts`, so the commit alone does
not identify what ran, and without the digest two runs of different
implementations would aggregate as repeats of one experiment. The run's own output tree is excluded, since outputs are not inputs and a report
written between repeats would otherwise give every repeat a different tuple. The
tuple also records `process.platform`, because path handling is separator-aware and
a case-insensitive filesystem changes which paths resolve. Variance refuses a set
whose reports disagree on any part of that tuple, or whose run ids repeat, so a run
from a dirty tree is comparable only against runs from the same tree and one
invocation cannot be counted as several agreeing repeats.

Reports also record the fixture repository's tracked files, read with `git
ls-files` after seeding. That is the universe production resolves an observed
mapping path against, so both the scorer and the variance encoder use it to decide
which paths the host would actually store.

Exit codes are `0` when every run passes, `1` for any ordinary FAIL or ERROR,
and `2` when any run archives a gold-true claim. Missing credentials, invalid
filters, malformed scenarios, a non-empty output directory, deadline truncation,
and artifact failures exit `1`.

## Authoring scenarios

Add one JSON file per scenario under `dev/`; its filename must match its id.
Every pool has 10-50 hygiene-visible ordinary claims. Gold uses logical claim
ids from the pool, while the runner resolves production public ids after
seeding. Verify gold excludes file-independent claims. Map and classify gold
include them. Every task declares the exact in-scope and skipped partition that
the production gate must return before a model request is allowed.

Every scenario also declares `pressureRoles`. Valid roles are
`semantic-duplicate-pair`, `near-duplicate-pair`, `stale`,
`contradiction-pair`, `false-fluent`, `high-value-file-independent`,
`rejected-alternative`, and `branch-specific`. Pair roles name exactly two claim
ids; other roles name one. Use an empty array when no pressure role applies.

Scenarios are checked-in source, not archived evidence: the runner parses them
only from this `dev/` directory, so every instance travels in the same commit as
the parser and a rerun of an older scenario checks out its own contract. That is
why the scenario parser requires each field exactly rather than defaulting a
missing one, and why adding a required field needs no schema bump — an omitted
`pressureRoles` is an authoring mistake to reject, and `[]` is how a scenario
says it has no pressure role. Run reports and variance artifacts are the
opposite: they leave the repository as uploaded artifacts, so their schemas are
versioned and their field sets change only with a version.

`dme-core-pool` covers semantic duplicates, load-bearing near duplicates,
stale and contradictory claims, false-but-fluent text, a file-independent
constraint, a rejected alternative, and branch-specific context.
`dme-verify-broad-history` is the dedicated broad-cycle scenario. It seeds
verification history and requires `broad` result mode.

Curate end-state scoring is phase 2 and is not implemented here. Run reports
retain pre-run and post-run snapshots, raw and parsed manifests, receipts, and
the system tuple needed to add that scorer without rerunning the model.
