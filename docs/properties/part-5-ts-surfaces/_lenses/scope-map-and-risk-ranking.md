# Part 5 scope map and risk ranking

Scoping pass only. No property records, no fixes, no source or CI edits. The
deliverable is the sub-partition plan plus the measurements and CI facts that let
later lens passes cite references without re-measuring a 182,000-line package.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Method contract in
[../../METHOD.md](../../METHOD.md).

Every line reference below was read back at `HEAD`. Every line count came from
`wc -l` over an explicit file list, with `node_modules/` and `dist/` pruned.
Where a number is a sum of a measured set, the set is named.

## Stability check (what is moving, what is excluded)

The working tree is clean for all product code. `git status --porcelain` reports
only `.beads/interactions.jsonl`, `.beads/issues.jsonl`, and three untracked
paths (`2026-08-30-mc-module-perf-autoresearch.md`, `docs/properties/`,
`docs/research/`). Nothing under `packages/` or `crates/` is modified. So the
question is not uncommitted churn; it is recent committed churn from the
ring-transport refactor.

Churn was measured per package with `git diff --stat` at `HEAD~1`, `HEAD~3`,
`HEAD~5`, `HEAD~10`, and `HEAD~20` against `HEAD`.

| Package | Files touched in last 20 commits | Verdict |
| --- | --- | --- |
| `packages/plugin` | 74 at `HEAD~10`, 282 at `HEAD~20`, but **51 of the last-20 touches are `src/shared/`** | **Mixed.** Stable outside two directories |
| `packages/pi-plugin` | 0 | **Stable** |
| `packages/cli` | 2 (`src/commands/daemon.ts` + its test) | **Stable apart from one file** |
| `packages/retina-local-fs` | 0 | **Stable** |
| `packages/mc-shm-native` | 4 (`index.ts`, `src/lib.rs`, `src/setup.rs`, `tests/mechanism.ts`) at `HEAD~5` | **Moving.** Also already Part 1 |
| `packages/e2e-tests` | 2 (`scripts/run-shm-soak*.ts`) | Stable, but excluded as harness |

The churn inside `packages/plugin` is sharply localised. Grouping the last-20
diff by directory gives `src/shared` 51, `src/features` 13, `src/config` 5,
`src/plugin` 3, `src/hooks` 3, `src/index.ts` 1. Narrowing to `HEAD~6..HEAD`
gives `src/shared` 15, `src/features` 2, `src/hooks` 1. The `src/shared` figure
is entirely two subdirectories.

**Excluded as actively moving:**

- `packages/plugin/src/shared/mc-host-client/` (5,944 production lines). At
  `HEAD~10..HEAD` this directory lost `shm-grant.ts` (294),
  `shm-transport-provider.ts` (73), `tcp-frame-channel.ts` (1,129),
  `transport-negotiation.ts` (989), `transport-provider.ts` (877), and five
  test-support files totalling 2,214 lines, while gaining
  `shared-memory-failure.ts` and `owner.ts`. `owner.ts` and
  `shared-memory-failure.ts` were still being edited at `HEAD~1..HEAD`. This is
  the TypeScript half of the same collapse that
  `docs/properties/README.md:69-99` records on the Rust side, and it is the
  reason Parts 2b through 2e are parked. Scoping it now would repeat that
  mistake.
- `packages/plugin/src/shared/mc-host-lifecycle/` (4,769 production lines).
  `policy.ts`, `managed-policy.ts`, `contract.ts`, and
  `generated-contract.ts` all changed at `HEAD~5..HEAD`; `owner.ts` (341) and
  `managed-policy.ts` (251) were added inside the last 20 commits.
- `packages/mc-shm-native` (1,194 lines). Moving, and already Part 1 scope.
- `packages/cli/src/commands/daemon.ts`. Changed at `HEAD~5..HEAD` as part of
  the same refactor. Excluded from 5d; the rest of `packages/cli` is in.

Together the two excluded `plugin` directories are 10,713 production lines, or
5.9 percent of the package. Everything else in `packages/plugin` is stable: the
two `src/features` touches at `HEAD~6..HEAD` are
`features/magic-context/memory/embedding-synapse.ts` (2 deleted lines) and
`features/magic-context/smart-notes/wake-plane.ts` (5 changed lines), and the
one `src/hooks` touch is `hooks/magic-context/module-transport.ts` (19 changed
lines). `module-transport.ts` is the client-facing edge of the transport and is
therefore held out of 5b as a boundary file, noted below.

**Also excluded, for reasons other than motion:**

- `packages/e2e-tests` (34,907 production lines, 107 test files). This is the
  test harness, not product logic. It is the CI driver for several jobs and is
  cited in the CI section, but a property catalog of a harness is a category
  error.
- `packages/docs` (182 lines, 3 files). An Astro documentation site.
- `packages/mc-host-{darwin-arm64,darwin-x64,linux-x64-gnu}`. Zero TypeScript
  files each; these are prebuilt-binary carrier packages.

## What this layer owns

Verified against `HEAD`. All four surfaces named in the task exist, and the
survey found three more.

**1. A producer that advances a durable outbox checkpoint on a module
acknowledgement. Confirmed.**
`packages/plugin/src/hooks/magic-context/module-state-sync.ts` (2,635 lines).
The table is `claim_outbox_consumer_checkpoints`, joined at `:1776-1779` and
again at `:2261-2263`, both times as
`LEFT JOIN ... ON checkpoint.consumer = ? AND checkpoint.project_id =
effects.project_id` with `effects.id > COALESCE(checkpoint.acked_effect_id, 0)`.
The delivery callback at `:2215` is typed
`deliver: (receipt: ClaimEffectDeliveryReceipt) => Promise<{ ackedEffectId:
number }>`, so the checkpoint advances on a value the *consumer* returns. A
comment at `:1619` states the delivered request body must name the same
consumer or checkpoints advance wrongly. The drain has an explicit bound at
`:2059`: `throw new Error("claim mirror outbox drain exceeded 1000 receipt
groups")`. Separately, `:1343-1425` computes `acked` watermarks and the
force-resend predicates, and `:1196` and `:1575` write `acked_watermarks` into
the wire body. This is at-least-once delivery with a durable cursor, and it has
no Rust counterpart.

**2. A parallel TypeScript implementation of the transform. Confirmed, and
larger than expected.** Three files carry it:
`hooks/magic-context/transform.ts` (2,624),
`hooks/magic-context/rust-mode-transform.ts` (3,005), and
`hooks/magic-context/transform-postprocess-phase.ts` (2,320), plus
`transform-compartment-phase.ts` (447), `module-wire.ts` (1,540),
`transform-message-helpers.ts` (164), `transform-context-state.ts` (91),
`config/transform-mode.ts` (42), `plugin/messages-transform.ts` (308),
`features/magic-context/transform-decision-log.ts` (489),
`transform-operations.ts` (14), and `transform-stage-logger.ts` (12). The
existence of `rust-mode-transform.ts` alongside `transform.ts` is itself the
drift surface: one file is the TypeScript transform and the other is the
TypeScript-side adapter for the Rust transform, which means both paths ship and
a divergence between them is a live product behaviour difference, not a test
artifact.

**3. A parallel TypeScript implementation of historian validation. Confirmed.**
`hooks/magic-context/compartment-runner-validation.ts` (352 lines) is the
counterpart to Rust's `historian_validate.rs` (1,869 lines). The 5.3x size
difference is the finding worth carrying forward: either the TypeScript
validator is materially weaker, or the Rust one carries obligations the
TypeScript path does not enforce. `compartment-parser.ts` (329) is the XML
parse it validates, and it has two dedicated test files
(`compartment-parser.test.ts`, `compartment-parser.lang.test.ts`).

**4. Setup wizards that decide whether subsystems are enabled by default.
Confirmed.** `packages/cli/src/commands/setup-opencode.ts:449` is
`const dreamerEnabled = await confirm("Enable dreamer?", true)` — the second
argument is the default, and it is `true`. The write path at `:262-278` is a
double negative worth a property: it `delete dreamer.enabled` at `:263`
unconditionally, then either `delete dreamer.disable` (`:265`) when enabled or
sets `dreamer.disable = true` (`:276`) when not. So enablement is encoded as the
*absence* of a `disable` key, and the wizard deletes the key a reader might
expect to be authoritative. `:281` does the same `delete sidekick.enabled` for
sidekick. Sibling wizards: `setup-pi.ts` (513), `setup-omp.ts` (152),
`setup.ts` (103), `lib/dreamer-setup.ts` (149).

**5. Storage code holding a newer-schema fence that Rust lacks. Confirmed.**
`features/magic-context/storage-db.ts` (933 lines). The fence is documented at
`:644-649` as refusing "a database carrying a persisted fence or marker epoch
newer than this binary" and enforced at `:678`, which throws a message ending
"Do not reset this database: a newer binary owns it." `:712-713` states the
policy plainly: "There is no migration lane: old databases are refused, never
migrated." `:774` notes "Object-name identity cannot see a fence a newer binary
moved without" — a stated blind spot. The constants come from
`features/magic-context/migrations.ts`, which is only 6 lines and is pure
constants: `FORK_MIGRATION_VERSION_FLOOR = 10_000` (`:2`),
`DIRECT_FORMAT_SUPERSEDED_MIGRATION_HEAD = 89` (`:4`), and
`DIRECT_FORMAT_FENCE_MIGRATION_VERSION` derived at `:6`. A refuse-to-open guard
that is the only thing preventing an older plugin from writing into a newer
database is a durability property with a data-loss consequence.

**Three more this layer owns, not named in the task:**

**6. A second complete harness integration.** `packages/pi-plugin` is 30,567
production lines with zero churn in 20 commits, and it re-implements the
context surface for the Pi harness: `context-handler.ts` (6,151 — the single
largest production TypeScript file in the repo), `inject-compartments-pi.ts`
(2,448), `index.ts` (2,383), `subagent-runner.ts` (1,910),
`pi-historian-runner.ts` (1,683), `tail-hygiene-walk-pi.ts` (755),
`heuristic-cleanup-pi.ts` (600). The `*-pi` suffixes signal a second drift axis:
`inject-compartments-pi.ts` against `plugin`'s `inject-compartments.ts` (2,958),
and `tail-hygiene-walk-pi.ts` against Rust's `tail_hygiene.rs`.

**7. Database repair and reset as a shipped operation.** `packages/cli` holds
`commands/doctor-repair-db.ts` (763) and `commands/doctor-reset-db.ts` (677),
plus `commands/migrate.ts` (1,694) and `commands/migrate-session.ts` (657).
`storage-db.ts:818` explicitly routes the refused-database case to
`doctor reset-db`, so the fence and the reset command are two halves of one
contract, and the destructive half lives in a different package.

**8. Authority arbitration in TypeScript.**
`features/magic-context/context-authority.ts` (1,484 lines) mentions outbox
state and is the TypeScript side of the authority lifecycle that Part 4c
catalogs from the Rust `McHandler` side.

## Package measurements

Production excludes `*.test.ts`, `*.spec.ts`, `*.test.tsx`, and anything under
`__tests__/`, `node_modules/`, or `dist/`.

| Package | Production lines | Production files | Test lines | Test files | In Part 5 |
| --- | --- | --- | --- | --- | --- |
| `packages/plugin` | 182,351 | 535 | 135,202 | 371 | Yes, less 10,713 moving lines |
| `packages/pi-plugin` | 30,567 | 67 | 27,853 | 74 | Yes |
| `packages/cli` | 15,325 | 52 | 9,383 | 36 | Yes, less `daemon.ts` |
| `packages/retina-local-fs` | 846 | 5 | 514 | 1 | Yes |
| `packages/e2e-tests` | 34,907 | 75 | 30,020 | 107 | No, harness |
| `packages/mc-shm-native` | 1,194 | 4 | 3 | 1 | No, Part 1 and moving |
| `packages/docs` | 182 | 3 | 0 | 0 | No, docs site |

In-scope production total: 182,351 + 30,567 + 15,325 + 846 = 229,089 lines,
less the 10,713 excluded as moving and less `cli/src/commands/daemon.ts`, so
roughly 218,000 production lines across about 655 files.

That is more than four times `mc-module`'s 52,599 production lines. Part 5
cannot be exhaustive at any sane number of sub-parts; the sub-partition below
deliberately covers the highest-risk 45,000 or so lines and names what it leaves
uncovered.

The test-to-production ratio is the other headline. `packages/plugin` carries
135,202 test lines against 182,351 production, `pi-plugin` 27,853 against
30,567, `cli` 9,383 against 15,325. Compare `mc-module`, where the tests exist
in similar proportion but almost none execute.

## Monolith region maps (line ranges)

The twenty largest production files in scope, measured:

| Lines | File |
| --- | --- |
| 6,151 | `pi-plugin/src/context-handler.ts` |
| 3,507 | `plugin/src/features/magic-context/project-embedding-registry.ts` |
| 3,005 | `plugin/src/hooks/magic-context/rust-mode-transform.ts` |
| 2,958 | `plugin/src/hooks/magic-context/inject-compartments.ts` |
| 2,735 | `plugin/src/features/magic-context/storage-meta-persisted.ts` |
| 2,635 | `plugin/src/hooks/magic-context/module-state-sync.ts` |
| 2,624 | `plugin/src/hooks/magic-context/transform.ts` |
| 2,448 | `pi-plugin/src/inject-compartments-pi.ts` |
| 2,443 | `plugin/src/features/magic-context/search.ts` |
| 2,383 | `pi-plugin/src/index.ts` |
| 2,341 | `plugin/src/features/magic-context/memory/storage-claim-operations.ts` |
| 2,320 | `plugin/src/hooks/magic-context/transform-postprocess-phase.ts` |
| 2,102 | `plugin/src/features/magic-context/storage-tags.ts` |
| 1,910 | `pi-plugin/src/subagent-runner.ts` |
| 1,886 | `plugin/src/features/magic-context/memory/embedding-synapse.ts` |
| 1,776 | `plugin/src/hooks/magic-context/hook.ts` |
| 1,756 | `plugin/src/shared/mc-host-client/client.ts` (excluded, moving) |
| 1,694 | `cli/src/commands/migrate.ts` |
| 1,683 | `pi-plugin/src/pi-historian-runner.ts` |
| 1,540 | `plugin/src/hooks/magic-context/module-wire.ts` |

Directory-level map of `packages/plugin/src`, production lines:

| Directory | Lines | Files |
| --- | --- | --- |
| `features/` | 69,311 | 186 |
| `hooks/` | 48,406 | 111 |
| `shared/` | 21,015 | 82 |
| `tui-compiled/` | 4,068 | 7 |
| `config/` | 3,984 | 11 |
| `plugin/` | 3,897 | 17 |
| `tui/` | 3,407 | 7 |
| `tools/` | 2,906 | 26 |
| `agents/` | 1,081 | 8 |

`features/` is almost entirely one subtree: `features/magic-context/` is 69,247
of the 69,311. Its own subdirectories are `memory/` 14,556, `dreamer/` 10,818,
`smart-notes/` 3,792, `mural/` 2,172, `git-commits/` 1,408, `user-memory/`
1,268, `git-anchors/` 460, `sidekick/` 205, and 16,231 lines of top-level
`storage-*.ts` files. `hooks/` is likewise one subtree: `hooks/magic-context/`
47,308 of 48,406, with `hooks/auto-update-checker/` the 1,098-line remainder.

Measured groups inside `hooks/magic-context/`, used by the sub-partition:

- `transform*.ts`, 7 files, 5,672 lines. Largest: `transform.ts` 2,624,
  `transform-postprocess-phase.ts` 2,320, `transform-compartment-phase.ts` 447,
  `transform-message-helpers.ts` 164, `transform-context-state.ts` 91,
  `transform-operations.ts` 14, `transform-stage-logger.ts` 12.
  `rust-mode-transform.ts` (3,005) does not match the `transform*` glob.
- `module-*.ts`, 3 files, 5,561 lines: `module-state-sync.ts` 2,635,
  `module-wire.ts` 1,540, `module-transport.ts` 1,386.
- `compartment*.ts` plus `historian*.ts`, 13 files, 6,061 lines:
  `compartment-runner-incremental.ts` 932, `historian-prompt.generated.ts` 790,
  `compartment-trigger.ts` 772, `compartment-runner-historian.ts` 743,
  `compartment-runner-recomp.ts` 651,
  `compartment-runner-partial-recomp.ts` 542,
  `compartment-runner-validation.ts` 352, `compartment-parser.ts` 329,
  `compartment-runner.ts` 306, `compartment-runner-types.ts` 214,
  `compartment-prompt.ts` 148, `compartment-runner-drop-queue.ts` 78,
  `compartment-runner-mapping.ts` 60, `historian-state-file.ts` 75.

No single TypeScript file here approaches `mc-module`'s 30,517-line `lib.rs`, so
intra-file line-range scoping is not needed. Part 5 sub-parts are whole-file
sets, which makes them cheaper to verify than Part 4's.

## CI reality (which TS suites actually run)

Verified against all five files in `.github/workflows/`: `ci.yml`,
`claude-code-review.yml`, `historian-eval.yml`, `retrieval-benchmark.yml`,
`shm-hardening-optin.yml`. All TypeScript test invocations are in `ci.yml`.

**The load-bearing line is `ci.yml:257`.**

```
.github/workflows/ci.yml:256      - name: Test
.github/workflows/ci.yml:257        run: bun run test
```

That is in the `check-plugin` job (`ci.yml:225-226`, `runs-on: ubuntu-latest` at
`:227`). Root `package.json` defines `test` as:

```
sh scripts/test-shard.sh packages/plugin
  && bun run --cwd packages/pi-plugin test
  && bun run --cwd packages/cli test
  && bun run --cwd packages/retina-local-fs test
```

Each package's own `test` script is bare `bun test`, which discovers every
`*.test.ts` under the package. `scripts/test-shard.sh` shards `packages/plugin`
across `nproc` workers, floored at 1 and capped at 8, and falls back to a single
unsharded `bun test` if the installed Bun lacks `--shard=` (the probe is an
explicit `bun test --help | grep -q -- '--shard='`). Either way the whole suite
runs.

So one CI step executes **482 of the repo's 590 test files**: 371 in
`packages/plugin`, 74 in `pi-plugin`, 36 in `cli`, 1 in `retina-local-fs`. That
is 81.7 percent of all TypeScript test files, and it covers 100 percent of the
test files in every package Part 5 scopes.

Complete inventory of TypeScript test and typecheck invocations, with verified
references:

| Reference | Command | Covers |
| --- | --- | --- |
| `ci.yml:55` | `bun test scripts/check-mc-shm-architecture.test.ts` | 1 root-script file |
| `ci.yml:80` | `bun test scripts/validate-shm-hardening-matrix.test.ts` | 1 root-script file |
| `ci.yml:198` | `bun run --cwd packages/mc-shm-native test:bun` | Part 1 scope |
| `ci.yml:203` | `bun run --cwd packages/mc-shm-native test:node` | Part 1 scope |
| `ci.yml:207-208` | `mc-shm-native test:capability:bun` / `:node` | Part 1 scope |
| `ci.yml:211` | `bun test packages/plugin/src/shared/mc-host-client` | The excluded moving directory |
| `ci.yml:214` | `bun run --cwd packages/plugin test:mc-shm:node` | **See the defect note below** |
| `ci.yml:217` | `bun run --cwd packages/plugin typecheck` | Type-level only |
| `ci.yml:245` | `bun run typecheck` | plugin + pi-plugin + cli + retina-local-fs, type-level only |
| **`ci.yml:257`** | **`bun run test`** | **482 test files across all four Part 5 packages** |
| `ci.yml:308` | `bun run --cwd packages/pi-plugin typecheck` | Type-level only |
| `ci.yml:317` | `bun run --cwd packages/pi-plugin test` | pi-plugin's 74 files, a second time |
| `ci.yml:338` | `bun run test:prospective-unit` | `e2e-tests` selection |
| `ci.yml:344` | `bun run --cwd packages/e2e-tests typecheck` | Type-level only |
| `ci.yml:381` | `bun run test:release` | 6 root-script test files |
| `ci.yml:434` | `bun run test:historian-eval-unit` | `e2e-tests` selection |
| `ci.yml:461` | `bun run --cwd packages/plugin test:mc-host-client:node` | Smoke, one script |
| `ci.yml:722` | `bun run --cwd packages/e2e-tests test:opencode-e2e` | `e2e-tests`, `--mode ts` |
| `ci.yml:771` | `bun run --cwd packages/e2e-tests test:pi-e2e` | `e2e-tests`, `--mode ts` |
| `ci.yml:815` | `bun run --cwd packages/e2e-tests test:incident-unit` | `e2e-tests` selection |
| `ci.yml:824` | `bun run --cwd packages/e2e-tests test:incidents --mode ts` | `e2e-tests` incident pool |

Five non-test smoke steps also run in `check-plugin` and are worth naming
because each exists to cover a gap `bun test` structurally cannot reach, and
each is therefore an existing check a lens pass should inventory rather than
rediscover: `node packages/plugin/scripts/smoke-node-sqlite.ts` (the
`node:sqlite` branch of `shared/sqlite.ts`, since `bun test` only exercises
`bun:sqlite` — the comment at `ci.yml:259-262` names the `transaction()` shim,
the `readonly`-to-`readOnly` mapping, and array-bind normalisation as what would
otherwise ship unverified), `smoke-smartnote-wasm.ts` (the QuickJS sandbox's
~1MB WASM surviving bundling), `smoke-tui-import.ts` and
`smoke-tui-pack-install.ts` (the OpenTUI/Solid JSX entry, dev path and packed
path), and `smoke-tokenizer-pack-install.ts` (lazy tokenizer resolution from a
compiled Bun host).

**A CI defect found while verifying `ci.yml:214`.** That step runs
`bun run --cwd packages/plugin test:mc-shm:node`, but `packages/plugin/
package.json` has no `test:mc-shm:node` script. Its mc-host and mc-shm scripts
are exactly `test:mc-host-client:node`, `smoke:mc-host-client:bun`,
`smoke:mc-host-client:node`, `smoke:mc-host-synapse:bun`, and
`smoke:mc-host-synapse:node`; `grep -c "mc-shm:node"` on the manifest returns 0.
I cannot observe CI from here, so I record the disagreement rather than
concluding the job is red. It sits in `shm-source-build`, which is
ring-refactor territory, so the likely reading is a rename that outran the
workflow. Carried to Open questions.

**What this inverts.** Part 4 recorded that 926 of `mc-module`'s 938 tests never
run in CI, and that six of seven integration binaries are never invoked. Part 5
is the mirror image: every test file in every package it scopes runs on every
push, and `pi-plugin`'s run twice (`:257` and `:317`). The risk multiplier that
dominated Part 4 is absent here.

That has two consequences for how Part 5 must be ranked. First, executing
coverage stops being the discriminator, because it is uniformly present, so the
ranking has to lean on durable-state ownership, trust boundaries, and drift.
Second, and less obviously, the *asymmetry* becomes the hazard in its own right.
Where a TypeScript file and a Rust file implement the same contract, the
TypeScript side is continuously verified and the Rust side is not, so the two
can diverge silently and CI will stay green. Every duplicated-logic pair found
above is therefore a drift property, and the drift is one-directional: green CI
constrains only the TypeScript half.

`METHOD.md:42` defines `Exercised` in terms of what a campaign covers. Part 4
left open whether a never-executed test counts as `partial`. Part 5 raises the
converse: a TypeScript test that runs every push is genuine `partial` or `yes`
evidence for the TypeScript path and **no** evidence for the Rust counterpart,
even when both replay the same frozen fixture. Part 4's
`smart_note_evaluation.rs` cross-language fixture claim is exactly this shape.

## Risk ranking (criteria applied)

Six criteria, from the task. "Executing coverage" is near-uniform, so it
separates little; "duplicates Rust logic" does most of the work.

| Area | Durable state or DB writes | Can lose or corrupt user data | Trust boundary | Duplicates Rust | Gates enablement | Executing coverage |
| --- | --- | --- | --- | --- | --- | --- |
| **Storage fence, claim outbox, authority** | Yes: the SQLite database itself, `claim_outbox_consumer_checkpoints`, persisted meta, claim rows, tags | **Irreversibly.** `storage-db.ts:678` refusing to open is the only thing stopping an older binary writing a newer database, and `:712-713` states old databases are refused and never migrated, so a fence misjudgement is unrecoverable in place. The outbox cursor at `:1776-1779` advances on a consumer-returned `ackedEffectId`, so a wrong ack silently drops effects | Yes: the database is shared with other plugin instances of unknown version, which is precisely what the fence exists to police | **Partly, and asymmetrically.** The fence has no Rust equivalent at all, which is itself the risk: Rust opens the same file without the guard | No | Yes, `storage-db.test.ts` and `storage-claim-operations.test.ts` both run at `:257` |
| **TS transform and the Rust-mode adapter** | Yes: transform decision log, module wire state, compartment phase writes | Yes: wrong bytes in the served context, wrong messages dropped, a poisoned cache state | Yes: consumes harness-supplied message arrays | **Yes, the largest surface.** 13,175 lines against `mc-module`'s `transform.rs` (12,468 production). Two TypeScript paths ship simultaneously (`transform.ts` and `rust-mode-transform.ts`), so drift is a product behaviour difference, not just a test gap | `config/transform-mode.ts` selects the path | Yes, extensive, all at `:257` |
| **Historian and compartment pipeline** | Yes: compartments, historian runs, drop queue | **Irreversibly.** Raw conversation is replaced by model-generated summary text | **Yes, the worst.** `compartment-parser.ts` parses language-model XML and `compartment-runner-validation.ts` is the only gate before persistence | **Yes, and suspiciously.** 352 TypeScript validation lines against 1,869 Rust lines in `historian_validate.rs` | No | Yes, incl. two parser test files and `compartment-runner-validation.test.ts`, all at `:257`, plus `test:historian-eval-unit` at `:434` |
| **CLI wizards, doctor, migrate, reset** | Yes: writes harness config, and `doctor-reset-db.ts` destroys the database | **Yes, by design.** `doctor-reset-db.ts` (677) and `doctor-repair-db.ts` (763) are destructive, and `storage-db.ts:818` routes users to reset when the fence fires | Yes: reads and rewrites user and project config files | No | **Yes, uniquely.** `setup-opencode.ts:449` defaults dreamer on, and `:263-278` encodes enablement as the absence of `disable` | Yes, 36 `cli` test files at `:257`, incl. `setup-opencode.test.ts` (216), `setup-pi.test.ts` (470), `setup-omp.test.ts` (209) |
| **pi-plugin harness surface** | Indirectly, through shared storage | Yes: `inject-compartments-pi.ts` and `context-handler.ts` decide what the model sees | Yes: parses Pi session transcripts | **Yes, on a second axis:** `*-pi` files against both their `plugin` twins and Rust (`tail-hygiene-walk-pi.ts` against `tail_hygiene.rs`) | No | Yes, and twice (`:257` and `:317`) |
| **Memory, embedding, dreamer, smart-notes** | Yes: embedding registry, memory rows, dreamer task state | Yes but narrower and mostly derived state that a later pass can rebuild | Yes: `smart-notes` runs user expressions in a QuickJS sandbox; the dreamer consumes model output | Partly | `dreamer.disable` set by the wizard | Yes, plus the WASM bundling smoke at `check-plugin` |

Ranking, highest first: storage fence and claim outbox; historian and
compartment pipeline; TS transform and Rust-mode adapter; CLI wizards and
destructive doctor commands; pi-plugin harness surface; memory and dreamer.

The storage fence ranks first on the criterion that separates recoverable from
unrecoverable, and it ranks above the historian for one specific reason. The
historian destroys the content of one conversation and is guarded by a validator
that at least exists on both sides. The fence guards the *container*: if it
misjudges, an older binary writes into a database a newer binary owns, and
`storage-db.ts:712-713` has already foreclosed the repair path by refusing to
migrate. `:774` admits a known blind spot in the detection ("Object-name
identity cannot see a fence a newer binary moved without"). And the Rust side
has no equivalent guard, so the protection is only as good as the TypeScript
path being the only writer, which the claim outbox in `module-state-sync.ts`
demonstrates it is not.

## Proposed sub-partition

Five sub-parts, 46,062 production lines, sized by production lines because
TypeScript test files sit beside their subjects and a pass reads both. Each
sub-part is a whole-file set; no intra-file line-range scoping is needed.

This covers roughly 21 percent of the in-scope 218,000 production lines. That is
deliberate. The uncovered remainder is named at the end of this section so a
later part can pick it up rather than assume it was considered and dismissed.

### 5a Storage fence, claim outbox, and authority — risk 1

Files, 10 units, 11,698 lines:

- `packages/plugin/src/features/magic-context/storage-db.ts` (933)
- `packages/plugin/src/features/magic-context/migrations.ts` (6)
- `packages/plugin/src/features/magic-context/storage-meta-persisted.ts` (2,735)
- `packages/plugin/src/features/magic-context/storage.ts` (324)
- `packages/plugin/src/features/magic-context/storage-claim-memory-schema.ts` (464)
- `packages/plugin/src/features/magic-context/memory/storage-claim-operations.ts` (2,341)
- `packages/plugin/src/features/magic-context/memory/storage-claim-policy.ts` (776)
- `packages/plugin/src/features/magic-context/context-authority.ts` (1,484)
- `packages/plugin/src/hooks/magic-context/module-state-sync.ts` (2,635)
- `packages/plugin/src/features/magic-context/storage-historian-runs.ts` (138) — read as boundary only; 5c owns its writers

Rationale: the only path in the TypeScript layer that can render a user's
database permanently unopenable, plus the durable at-least-once cursor whose
advance is decided by a value the consumer returns.

Attention focuses:

1. **Fence admission and the stated blind spot.** `storage-db.ts:644-712`
   refuses a database whose persisted fence or marker epoch is newer, and
   `:712-713` forecloses migration. Establish exactly which epochs are compared,
   whether the comparison is total (a fence the binary has never heard of, a
   missing fence row, a fence present but a marker absent), and what `:774`'s
   admission that object-name identity cannot see a moved fence lets through.
   The pristine-versus-direct-format-versus-newer three-way verdict sketched at
   `:815-818` is the decision to attack.
2. **Outbox checkpoint monotonicity under a lying or lost ack.** The cursor
   advances on the consumer's returned `ackedEffectId` (`:2215`) and is read
   through `effects.id > COALESCE(checkpoint.acked_effect_id, 0)`
   (`:1779`, `:2263`). Ask whether a consumer can advance the cursor past
   effects it never applied, whether the checkpoint can move backwards, what the
   consumer-identity requirement at `:1619` protects against, and what the
   1000-group drain bound at `:2059` leaves undrained when it throws.
3. **Watermark ack versus force-resend.** `:1343-1425` computes `acked` and the
   resend predicates, including the `Object.hasOwn(acked, "workspace_fingerprint")`
   test at `:1382`, which distinguishes an absent key from a null value. Check
   whether a partially-acked watermark set can suppress a resend that a later
   pass needs, and whether `:1196` and `:1575` can write an `acked_watermarks`
   body that disagrees with the durable checkpoint.

### 5b Historian and compartment pipeline — risk 2

Files, 16 units, 11,510 lines:

- `packages/plugin/src/hooks/magic-context/compartment-runner-validation.ts` (352)
- `packages/plugin/src/hooks/magic-context/compartment-parser.ts` (329)
- `packages/plugin/src/hooks/magic-context/compartment-runner.ts` (306)
- `packages/plugin/src/hooks/magic-context/compartment-runner-historian.ts` (743)
- `packages/plugin/src/hooks/magic-context/compartment-runner-incremental.ts` (932)
- `packages/plugin/src/hooks/magic-context/compartment-runner-recomp.ts` (651)
- `packages/plugin/src/hooks/magic-context/compartment-runner-partial-recomp.ts` (542)
- `packages/plugin/src/hooks/magic-context/compartment-runner-types.ts` (214)
- `packages/plugin/src/hooks/magic-context/compartment-runner-drop-queue.ts` (78)
- `packages/plugin/src/hooks/magic-context/compartment-runner-mapping.ts` (60)
- `packages/plugin/src/hooks/magic-context/compartment-trigger.ts` (772)
- `packages/plugin/src/hooks/magic-context/compartment-prompt.ts` (148)
- `packages/plugin/src/hooks/magic-context/historian-state-file.ts` (75)
- `packages/plugin/src/features/magic-context/compartment-storage.ts` (758)
- `packages/plugin/src/hooks/magic-context/inject-compartments.ts` (2,958)
- `packages/pi-plugin/src/pi-historian-runner.ts` (1,683)

Excluded from the set: `historian-prompt.generated.ts` (790) and
`historian-prompt.source.md`, which are frozen prompt assets and overlap Part
4e. See Overlaps.

Rationale: the trust boundary where language-model XML becomes durable
compartment rows, gated by a 352-line TypeScript validator against Rust's
1,869-line equivalent.

Attention focuses:

1. **The 5.3x validator asymmetry.** Enumerate what
   `compartment-runner-validation.ts` actually checks and diff that against
   `historian_validate.rs`'s obligations as Part 4a records them: range
   monotonicity, ranges inside the pinned chunk, endpoints naming ids present in
   the snapshot, duplicate or absent compartments, fingerprint verification. For
   each obligation the Rust side enforces, decide whether the TypeScript side
   enforces it, enforces it weakly, or does not enforce it. A missing check here
   is a live defect on the CI-verified path, not a drift risk.
2. **Adversarial model output through the parser.** Treat
   `compartment-parser.ts` as parsing hostile input: malformed or unclosed XML,
   nested or duplicated compartment elements, ranges outside the chunk,
   overlapping ranges, entity and encoding tricks. Two dedicated test files
   exist (`compartment-parser.test.ts`, `compartment-parser.lang.test.ts`) and
   both run at `:257`, so inventory them before proposing anything.
3. **Runner state durability across the four recomp paths.** `compartment-runner`
   plus `-incremental`, `-recomp`, `-partial-recomp`, `-drop-queue`, and
   `historian-state-file.ts`: what a crash between phases leaves on disk, whether
   two runners can fire for one session, and whether the drop queue can lose or
   double-apply a drop. Compare against the Rust five-phase machine in Part 4a
   without re-deriving it.

### 5c TypeScript transform and the Rust-mode adapter — risk 2

Files, 12 units, 13,175 lines:

- `packages/plugin/src/hooks/magic-context/transform.ts` (2,624)
- `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts` (3,005)
- `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts` (2,320)
- `packages/plugin/src/hooks/magic-context/module-wire.ts` (1,540)
- `packages/plugin/src/hooks/magic-context/transform-compartment-phase.ts` (447)
- `packages/plugin/src/features/magic-context/transform-decision-log.ts` (489)
- `packages/plugin/src/plugin/messages-transform.ts` (308)
- `packages/plugin/src/hooks/magic-context/transform-message-helpers.ts` (164)
- `packages/plugin/src/hooks/magic-context/transform-context-state.ts` (91)
- `packages/plugin/src/config/transform-mode.ts` (42)
- `packages/plugin/src/hooks/magic-context/transform-operations.ts` (14)
- `packages/plugin/src/hooks/magic-context/transform-stage-logger.ts` (12)

Held out as a boundary file: `hooks/magic-context/module-transport.ts` (1,386),
which changed 19 lines at `HEAD~6..HEAD`. Read it, do not catalog it.

Rationale: 13,175 CI-verified lines implementing the same contract as 12,468
lines of never-CI-verified Rust, with both TypeScript paths shipping at once.

Attention focuses:

1. **Which transform actually runs, and what selects it.**
   `config/transform-mode.ts` (42 lines) is the switch. Establish the default,
   whether it can change mid-session, and whether `transform.ts` and
   `rust-mode-transform.ts` can both act on one pass. A mode flip that changes
   served bytes is a property regardless of which side is correct.
2. **Drift against the Rust `[m0, m1] ++ tail` contract.** Part 4b establishes
   the Rust contract and its two named poison-resistance invariants: synthetic
   items stripped before any boundary, coverage, or tail computation, and the
   `mc_*` id namespace reserved. Check whether the TypeScript path enforces both.
   Since only the TypeScript path is CI-verified, a TypeScript-only invariant is
   an unverified Rust obligation and a Rust-only invariant is a live TypeScript
   defect. Record the direction for each.
3. **Wire encoding and the decision log.** `module-wire.ts` (1,540) is the
   encode and decode seam and `transform-decision-log.ts` (489) is the durable
   record of what a pass decided. Check whether the log can disagree with the
   bytes served, whether a partial write leaves it readable, and whether the wire
   round-trips every shape the Rust side emits.

### 5d CLI wizards, doctor, and destructive database commands — risk 3

Files, 15 units, 9,262 lines:

- `packages/cli/src/commands/migrate.ts` (1,694)
- `packages/cli/src/commands/doctor-opencode.ts` (1,442)
- `packages/cli/src/commands/doctor-pi.ts` (1,098)
- `packages/cli/src/lib/diagnostics-opencode.ts` (947)
- `packages/cli/src/commands/doctor-repair-db.ts` (763)
- `packages/cli/src/commands/doctor-reset-db.ts` (677)
- `packages/cli/src/commands/migrate-session.ts` (657)
- `packages/cli/src/commands/setup-opencode.ts` (604)
- `packages/cli/src/lib/diagnostics-pi.ts` (581)
- `packages/cli/src/commands/setup-pi.ts` (513)
- `packages/cli/src/commands/doctor-omp.ts` (475)
- `packages/cli/src/lib/database-access.ts` (362)
- `packages/cli/src/lib/migrate-dreamer-v2-doctor.ts` (279)
- `packages/cli/src/commands/setup-omp.ts` (152) and `setup.ts` (103)
- `packages/cli/src/lib/dreamer-setup.ts` (149)

Excluded: `packages/cli/src/commands/daemon.ts`, moving.

Rationale: the only material in Part 5 that gates whether subsystems are on by
default, and the only material that deletes a user's database on purpose.

Attention focuses:

1. **Enablement encoded as an absent key.** `setup-opencode.ts:263` deletes
   `dreamer.enabled` unconditionally, then `:265` deletes `dreamer.disable` or
   `:276` sets it true; `:281` does the same for sidekick. Establish what the
   runtime reads. If anything still reads `enabled`, the wizard's delete silently
   changes behaviour. Check the default at `:449` (`confirm("Enable dreamer?",
   true)`) against what a non-interactive or aborted run leaves written.
2. **Destructive command preconditions.** `doctor-reset-db.ts` (677) and
   `doctor-repair-db.ts` (763) are the documented remedy for the 5a fence
   (`storage-db.ts:818` names `doctor reset-db`). Ask what each verifies before
   destroying, whether reset can run against a database a newer binary owns —
   the exact case the fence message at `:678` says not to reset — and whether
   repair can half-succeed.
3. **Migration idempotency and interruption.** `migrate.ts` (1,694) and
   `migrate-session.ts` (657) against a storage layer that
   `storage-db.ts:712-713` says has no migration lane. Reconcile those two
   statements, then check re-run safety and interrupted-run state.

### 5e pi-plugin harness surface — risk 3

Files, 8 units, 16,417 lines. At the top of the band; if a pass runs long, split
at the injection seam into 5e-i context handling (`context-handler.ts`,
`read-session-pi.ts`, `transcript-pi.ts`, `index.ts`, 12,052) and 5e-ii
injection and hygiene (`inject-compartments-pi.ts`, `tail-hygiene-walk-pi.ts`,
`heuristic-cleanup-pi.ts`, `subagent-runner.ts`, 5,713).

- `packages/pi-plugin/src/context-handler.ts` (6,151)
- `packages/pi-plugin/src/inject-compartments-pi.ts` (2,448)
- `packages/pi-plugin/src/index.ts` (2,383)
- `packages/pi-plugin/src/subagent-runner.ts` (1,910)
- `packages/pi-plugin/src/transcript-pi.ts` (926)
- `packages/pi-plugin/src/tail-hygiene-walk-pi.ts` (755)
- `packages/pi-plugin/src/config/index.ts` (637)
- `packages/pi-plugin/src/heuristic-cleanup-pi.ts` (600)

Excluded: `pi-historian-runner.ts` (1,683), scoped in 5b with the historian
pipeline.

Rationale: a second complete harness integration with zero churn in 20 commits
and a triple drift axis — against its `plugin` twins, against Rust, and against
the OpenCode harness's behaviour.

Attention focuses:

1. **Twin drift.** `inject-compartments-pi.ts` (2,448) against
   `inject-compartments.ts` (2,958), and `tail-hygiene-walk-pi.ts` (755) against
   Rust's `tail_hygiene.rs` (1,278). Identify contracts one side enforces and the
   other does not. Note Part 4 assigns tokenizer determinism to Part 3; cite, do
   not re-derive.
2. **Transcript parsing as untrusted input.** `transcript-pi.ts` (926) and
   `read-session-pi.ts` (592) parse harness session state written by another
   process. Malformed, truncated, and concurrently-written sessions.
3. **Config trust tiering.** `pi-plugin/src/config/index.ts` (637) against the
   per-leaf trust policy Part 4f attributes to Rust `config.rs`, which Part 4
   already records as having a documented TypeScript divergence. Establish
   whether that divergence is here.

**Not covered by any sub-part.** About 172,000 production lines, chiefly
`features/magic-context/memory/` (14,556), `features/magic-context/dreamer/`
(10,818), `features/magic-context/smart-notes/` (3,792),
`project-embedding-registry.ts` (3,507), `search.ts` (2,443),
`storage-tags.ts` (2,102), `storage-session-runtime-schema.ts` (1,264),
`hook.ts` (1,776), `features/magic-context/mural/` (2,172), the `tui/` and
`tui-compiled/` trees (7,475), `tools/` (2,906), `agents/` (1,081), and
`packages/retina-local-fs` (846). The smart-notes QuickJS sandbox is the highest-
risk single item in that remainder: it executes user-authored expressions, and
its only CI evidence beyond `:257` is a WASM bundling smoke. It is a strong
candidate for a Part 6 alongside the memory and dreamer subtrees.

## Overlaps with existing parts (do not duplicate)

Verified by reading the Part 1, 2a, 2b, and 4 material at `HEAD`, plus Part 3's
evidence and lens files. Note two stale index rows:
`docs/properties/README.md:60-62` still lists Parts 3, 4, and 5 as "Not
started", but Part 3 has `evidence/` and `_lenses/`, Part 4 has a full
`_lenses/scope-map-and-risk-ranking.md`, and this file is Part 5's first
artifact.

All four overlaps the task named are confirmed:

- **Outbox-checkpoint producer, cataloged from the module side in Part 4d.**
  Confirmed as a boundary, not a duplicate. Part 4d owns
  `mc-module`'s claim-intent and claim-mirror handlers
  (`lib.rs:10068-10337`) and the note-evaluation claim protocol. Part 5a owns
  the TypeScript producer and the `claim_outbox_consumer_checkpoints` table.
  These are the two ends of one contract, so 5a must cite Part 4d for the
  consumer's obligations and catalog only the producer's. Part 3 additionally
  owns claim-mirror receipt semantics (see below), which 5a must not re-derive.
- **TypeScript historian validator, referenced in Part 4a's coverage findings.**
  Confirmed. Part 4a owns `historian_validate.rs` and its 19 never-executed
  tests. Part 5b owns `compartment-runner-validation.ts` (352) and must frame its
  work as the diff against Part 4a's enumerated obligations rather than
  re-deriving them.
- **Transform caller stub, appearing in Part 4b's findings.** Confirmed. Part 4b
  owns `transform.rs:1-7510` and the `[m0, m1] ++ tail` contract. Part 5c owns
  the TypeScript transform and `rust-mode-transform.ts`. 5c cites Part 4b for the
  contract statement and catalogs only TypeScript-side conformance and drift.
- **Frozen prompt-surface assets, appearing in Part 4e's findings.** Confirmed,
  and acted on: `historian-prompt.generated.ts` (790) and
  `historian-prompt.source.md` are excluded from 5b for this reason. Part 4e's
  external references include the whole of `docs/specs/prompt-surface/`, and
  `mc-module/src/prompt_surface.rs` (385) is 4e scope. If 5b needs the prompt
  text it cites 4e. `packages/plugin/scripts/build-historian-prompt.ts` is the
  generator and is likewise 4e's concern.

Checked the remaining index tables for overlaps the task did not name:

- **Part 1** (`mc-shm-transport`, `packages/mc-shm-native`). Overlaps only on
  material Part 5 already excludes as moving: `packages/mc-shm-native` and
  `packages/plugin/src/shared/mc-host-client/`. No conflict.
- **Part 2a** (`mc-host` lifecycle). Its TypeScript-facing counterpart is
  `packages/plugin/src/shared/mc-host-lifecycle/`, excluded as moving. Part 2a's
  `the-largest-lifecycle-proof-runs-in-ci` record is the one place it reasons
  about CI; Part 4 already corrected its reference from `ci.yml:149` to
  `:167-168`. Part 5 does not re-touch it.
- **Part 2b through 2e.** Parked. 2b retains four lens files describing the
  pre-refactor wire surface. No Part 5 overlap beyond the excluded directories.
- **Part 3** (`mc-store`, `mc-core`, `mc-tokenizer`). Three real boundaries.
  Its five `mirror-*` records own claim-mirror generation advance, receipt
  replay and conflict, the accepting gate, and the rebuild grant; 5a must cite
  them for mirror receipt semantics and catalog only the outbox cursor. Its
  `mirror-staleness-undetectable-on-memory-tool-read-path` record establishes
  that the read path takes no expected vector, which bears on 5a's authority
  work. Its `tokenizer-cross-process-determinism` record owns tokenizer
  determinism, which 5e must cite rather than re-derive for
  `tail-hygiene-walk-pi.ts`.
- **Part 4c and 4f.** 4c owns `mc-module`'s state-sync and state-import
  handlers, including `apply_state_sync_wire`; 5a and 5c own the TypeScript
  producers of those same wire bodies (`module-state-sync.ts`,
  `module-wire.ts`). Same two-ends-of-one-contract treatment. 4f owns Rust
  `config.rs` and its documented TypeScript divergence, which 5e's third
  attention focus is scoped to test from the TypeScript side.

## Open questions

- Does `ci.yml:214` work? It runs `bun run --cwd packages/plugin
  test:mc-shm:node`, and `packages/plugin/package.json` defines no such script
  (`grep -c "mc-shm:node"` returns 0; the nearest name is
  `test:mc-host-client:node`). Either the job is failing, or `bun run` resolves
  it by a route I have not found. I cannot observe CI from here. The step sits in
  `shm-source-build`, which is ring-refactor territory, so a rename outrunning
  the workflow is the likely reading. (needs human input)
- How should `Exercised` be labelled when a TypeScript test runs every push and
  its Rust counterpart never runs, and both replay the same frozen fixture? Part
  4 asked the converse question and left it open. Part 5 needs a ruling that
  covers cross-language fixture pairs specifically, because
  `smart_note_evaluation.rs` and every 5b, 5c, and 5e drift record depend on it.
  My reading is that green CI is evidence for the TypeScript path only, and a
  shared fixture proves agreement at the fixture's inputs and nothing beyond
  them, but this affects enough records to need confirmation. (needs human
  input)
- Is `packages/plugin/src/shared/mc-host-client/` expected to settle soon? The
  churn is decelerating (51 files at `HEAD~20`, 15 at `HEAD~6`, 2 at `HEAD~1`),
  and `ci.yml:211` already runs `bun test packages/plugin/src/shared/mc-host-client`
  every push, so it is well covered once stable. It plus `mc-host-lifecycle/` is
  10,713 lines and would make a natural Part 5f. Unresolved, needs the refactor
  to land.
- Which transform path is the shipped default? `config/transform-mode.ts` is 42
  lines and 5c's first attention focus, but the answer changes 5c's risk rank: if
  `rust-mode-transform.ts` is the default then the CI-verified TypeScript
  transform is largely dead code and the never-CI-verified Rust transform is what
  users run, which would raise 5c above 5b. Unresolved, needs 5c's first pass.
- Is there a specification for the outbox delivery contract outside
  `module-state-sync.ts`? Part 4 established that `mc-module` has no transform or
  historian specification outside its own doc comments. If the outbox is the same
  — contract stated only in code comments such as `:1619` and `:1675` — then
  every 5a guarantee is a claim with no independent source. Unresolved, needs a
  `docs/` sweep at 5a authoring time.
- Should `packages/retina-local-fs` (846 production lines, 1 test file of 514
  lines) be folded into 5d or left for a later part? It is stable and small, but
  a filesystem abstraction with one test file is a thin-coverage signal that does
  not fit any of the five sub-parts cleanly. Suggest deferring rather than
  padding 5d.
