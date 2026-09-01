# Part 5b lens B: claims and checks for the TypeScript historian and compartment pipeline

Claim-and-check lens only. No property records, no evidence files, no fixes, no
source or CI edits. Method contract in [../../METHOD.md](../../METHOD.md).

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Every line and file reference
below was read back at `HEAD`. Corrections to references supplied in the task
are recorded inline where they occur.

Claim sources swept: doc comments and diagnostic strings across the sixteen 5b
scope files; the historian-eval lane's own `README.md` and its selection code
(`packages/e2e-tests/scripts/run-test-selection.ts`); `docs/AUDIT-KNOWN-ISSUES.md`;
and a `docs/` grep for files describing historian or compartment behaviour.

## The framing this lens inherits

Unlike Parts 1 through 4, the tests in this sub-part **run**. One CI step,
`ci.yml:256-257` (`bun run test`), executes 482 of the repository's 596 test
files, which is 100 percent of the test files in every package Part 5 scopes.
"Not covered" is therefore rarely the finding here.

**The 482-of-596 figure, verified independently.** Counting `*.test.ts`,
`*.test.tsx`, and `*.spec.ts` at `HEAD` with `node_modules/` and `dist/` pruned:
596 total, made of 371 `packages/plugin`, 107 `packages/e2e-tests`, 74
`packages/pi-plugin`, 36 `packages/cli`, 6 root `scripts/`, 1
`packages/mc-shm-native`, 1 `packages/retina-local-fs`. The numerator is
371 + 74 + 36 + 1 = 482. This confirms the sibling correction: the scope map's
"482 of the repo's 590" at
[scope map:311](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)
undercounts the denominator by the six root `scripts/` files, which it
inventories separately at `ci.yml:55`, `:80`, and `:381`. 482 and the
100-percent claim are both correct.

So this lens reports two things instead of coverage absence: what the running
tests **cannot** catch, and where a check exists on one side of the
TypeScript/Rust boundary only.

## Claims register

Capped at 20 by consequence. `Implementing code` is the shipped mechanism that
would have to be wrong for the claim to be false. `Executing check` is a check
that runs in CI at `HEAD`.

| # | Claim | Source | Implementing code | Executing check |
| --- | --- | --- | --- | --- |
| 1 | The lane "measures whether the historian forms truthful durable memory from conversation — and refuses to promote speculation or rejected proposals — from a hand-audited scenario suite with fully deterministic scoring" | `historian-eval/README.md:3-6` | `src/historian-eval/scorer.ts`, `mutations.ts` | **Yes.** `ci.yml:434` (`test:historian-eval-unit`), `:437` (freeze lint), `:440` (mutation battery) |
| 2 | The golden generator "Drives the real TypeScript parser/validator from packages/plugin via Bun.resolveSync" to produce "the differential historian OUTPUT VALIDATION golden for the Rust mc-module port" | `crates/mc-module/gen/gen-validate-golden.ts:1-10` | `gen:17-18` (`Bun.resolveSync` of `compartment-parser` and `compartment-runner-validation`) | **None.** See lead L1 |
| 3 | The Rust validator matches the TypeScript oracle case for case | `crates/mc-module/src/historian_validate.rs:1384` (`fn validate_golden_matches_typescript_oracle`) | `historian_validate.rs:1385-1400+` | **None.** See lead L2 |
| 4 | "The frozen corpus's crafted-wrong outputs are also the best TS<->Rust validator differential vector set the repo has (reuse deferred, see plan scope)" | `README.md:98-99` | None. The reuse is explicitly deferred | **None**, by the claim's own terms |
| 5 | "Never absorb an unclassified gap." Only a gap proven fully inside `toolOnlyRanges` heals, at any size; a narrative gap rejects and the runner re-reads those raw messages | `compartment-runner-validation.ts:23-37` | `:39-61`, heal arm at `:53-59`; rejection at `:294-299` | **Yes.** `compartment-runner-validation.test.ts` (19 cases) |
| 6 | "Do not discard the last historian compartment when that would leave the persisted end boundary inside a completed tool invocation/result pair" | `compartment-runner-validation.ts:100-103` | `shouldDiscardLastHistorianCompartment` `:104-117`, guard clause `:115` | **Yes.** `compartment-runner-validation.test.ts:227` covers the sibling terminal-arc rejection at `:166-171` |
| 7 | A terminal boundary that splits a completed tool arc is rejected outright | `compartment-runner-validation.ts:169` (diagnostic string) | `:165-171` | **Yes.** `compartment-runner-validation.test.ts:227` |
| 8 | Three consecutive failures is the escalation point; "The historian retries on every turn and silently iterates its whole fallback chain, so a single failure is almost always a transient blip". "3 mirrors the dreamer circuit-breaker threshold" | `compartment-runner-validation.ts:185-193` | `HISTORIAN_PERSISTENT_FAILURE_THRESHOLD = 3` at `:194`, branch at `:211` | **Partial.** `compartment-runner-validation.test.ts:24-30` asserts the escalated notice names the threshold. Nothing asserts the dreamer constant equals it |
| 9 | "Nothing is lost and your conversation continues normally" on a sub-threshold historian failure | `compartment-runner-validation.ts:225` | The retry path in `compartment-runner-incremental.ts` | **Partial.** The string is asserted; the no-loss behaviour is not asserted against this notice |
| 10 | The failure notice is "Shared by both harnesses so the wording (and the transient/persistent contract) never drifts between OpenCode and Pi" | `compartment-runner-validation.ts:207-208` | One exported function, called from `compartment-runner-incremental.ts:209`, `:396`, `:493`, `:547`, `:912` and `pi-plugin/src/pi-historian-runner.ts:502`, `:665`, `:981`, `:1093`, `:1448` | **Yes, structurally.** Single definition; verified there is no second implementation |
| 11 | "P1 is the required v2 boundary. Missing P2-P4 deliberately retain the parser's denser-tier fallbacks; only the flat v1 shape must retry" | `compartment-runner-validation.ts:283-284` | `:285-287` (`!compartment.p1?.trim()`) | **Yes.** Reached by `compartment-runner-validation.test.ts` and by `gen-validate-golden.ts`'s `comp()` helper shape |
| 12 | `unprocessed_from === chunkEnd + 1` means "fully processed — historian consumed all messages and reported the next ordinal" | `compartment-runner-validation.ts:304-305` | `:306-307` | **Yes.** Golden case "wrong unprocessed_from rejects" plus the validation unit tests |
| 13 | A tier body "must never swallow a following tier's opener", and the bound is procedural because "some models mismatch the closing digit (e.g. `<p1>…</p2>`)" | `compartment-parser.ts:67-70`, `:80-85`, `:135` | `TIER_OPEN_ANY_REGEX` `:85`, applied in `extractTier` | **Yes.** `compartment-parser.test.ts` + `compartment-parser.lang.test.ts`, 22 cases |
| 14 | "Self-closing v2 compartments are invalid (a compartment must have ≥1 tier or flat content), so we only match the paired form" | `compartment-parser.ts:60-61` | `COMPARTMENT_REGEX` `:59` matches the paired form only | **Yes.** Golden case "malformed xml rejects with no usable compartments"; parser tests |
| 15 | The v2 taxonomy is exactly five categories; "legacy 9-cat names are accepted at the ctx_memory layer (E3 aliases), not here" | `compartment-parser.ts:86-88` | `CATEGORY_BLOCK_REGEX` `:88-89` | **Partial.** Parser tests assert the five; nothing in 5b asserts the ctx_memory layer still accepts the legacy nine |
| 16 | `scenarioFingerprint` is the "canonical fingerprint over everything authored — the semantic payload plus the scenario's name (id and title) — which is what approvals and tombstones bind to" | `src/historian-eval/contract.ts:762-768` | `:769-780` | **Yes.** `contract.test.ts` (114 cases), `promote.test.ts` (39 cases) |
| 17 | Trigger pressure is excluded from the scenario fingerprint on purpose, and the omission is not inert: "a report can claim the revised recipe was executed while scoring a snapshot the old one produced" — hence a separate whole-recipe fingerprint | `contract.ts:782-801` | The separate trigger fingerprint below `:801` | **Yes.** `contract.test.ts` |
| 18 | Re-scoring is "guarded by the record's own identity, not just its bytes": `scoreRunRecord` refuses a record whose schema, scenario id, `scenarioFingerprint`, or historian-run inventory disagrees | `README.md:75-81` | `scorer.ts` record-integrity reasons enumerated at `README.md:109-112` | **Yes.** `scorer.test.ts` (99 cases) |
| 19 | "No release is frozen yet — `historian-eval/` holds only `dev` — so the release form is the shape to use once `promote.ts` has published a `vN`, not a command that runs today" | `README.md:41-43` | Verified: `packages/e2e-tests/historian-eval/` contains `README.md` and `dev` only; `historian-eval.yml:103-106` offers exactly one corpus arm | **Yes.** `historian-eval.yml:105` fails closed on an unknown corpus |
| 20 | The state file "lives INSIDE the project directory" so "historian runs never trigger a permission prompt", and "The caller MUST delete the file in `finally{}`" | `historian-state-file.ts:21-29` | `getProjectMagicContextHistorianDir` at `:55`; `cleanupHistorianStateFile` `:68-75` | **Partial.** `historian-state-file.test.ts`, 8 cases. See lead L6 for the `MUST` |

## Contract-vs-code leads

Both sides cited. Not resolved in favour of the documentation, per METHOD.md
rule 3.

### L1. The generator that claims to be the differential runs nowhere

`gen-validate-golden.ts:1-10` states its purpose as generating "the differential
historian OUTPUT VALIDATION golden for the Rust mc-module port," and `:9` gives
the invocation: `bun crates/mc-module/gen/gen-validate-golden.ts`.

Verified at `HEAD`: a repository-wide grep for `gen-validate-golden` across
`*.ts`, `*.rs`, `*.json`, `*.yml`, `*.sh`, and `*.md` (excluding
`node_modules/` and `dist/`) returns **exactly one hit, its own doc comment at
`:9`**. It appears in no workflow, no root or package `package.json` script, and
no shell script. Broadening the search: no file under `crates/mc-module/gen/`
is referenced by any `package.json` script or workflow. The one wrapper that
exists, `gen/regenerate-differential-golden.sh`, is itself unreferenced outside
its own body.

So the artifact is hand-run, at an operator's discretion, with no freshness gate.

### L2. The golden's only consumer never compiles

`historian_validate.rs:1384` is `fn validate_golden_matches_typescript_oracle`,
an in-crate `#[test]` under `crates/mc-module/src/`. Compiling it requires the
`--lib` target.

Verified: the only `mc-module` invocations in any workflow are
`cargo build -p mc-module --bin ck-mc-host` (`ci.yml:169`) and
`cargo test -p mc-module --test lifecycle_cli` (`ci.yml:172`). The latter selects
one integration binary and does not build `--lib`, so no in-crate unit test
compiles. `ci.yml:719-721` states the reason for the wider absence directly:
"Rust is intentionally absent from public CI because its private ../commons and
../subconscious path-deps are not provisioned here; the local release gate runs
that host group."

Nothing executing compares the two validators. **This confirms the task's lead
as stated.**

### L3. The checked-in golden can no longer be produced by the generator, and was last hand-edited to agree with Rust

This is the sharpest lead in the sub-part and it was found while verifying L1.

The generator's `cases` array names two prior-store cases "prior store
contiguity accepts next raw ordinal" (`gen:516`) and "prior store contiguity
rejects skipped raw ordinal" (`gen:525`). The checked-in
`crates/mc-module/testdata/validate-golden.json` names them "prior live
adjacency accepts next present raw ordinal" (`:794`) and "prior live adjacency
rejects skipped present raw ordinal" (`:878`). The generator emits the error
string `...expected next raw message ${expectedStart}` (`gen:338`); the golden
holds `...expected next present raw message 3` (`:931`), which is the Rust
wording at `historian_validate.rs:479`.

Provenance, verified with `git log`:

- `validate-golden.json` last changed in `0c04f838`, 2026-07-21, "mason:
  complete historian parity gates and side channels".
- `gen-validate-golden.ts` last changed in `3b9f6ec7`, 2026-07-14. The golden is
  therefore the **newer** file.
- `0c04f838` touched `crates/mc-module/src/historian_validate.rs` (141 lines),
  `crates/mc-module/testdata/validate-golden.json` (17 lines), and five other
  Rust files. It did **not** touch `gen-validate-golden.ts`.

The golden diff in that commit is worth quoting because it inverts the
artifact's stated direction. For the "discard-last fires on weak lookahead and
filters anchored tail" case it deleted the expected TypeScript output's kept
event and kept primer:

```
-        "events": [ { "kind": "causal_incident", "at_compartment": 1, ... } ],
-        "primer_candidates": [ { "question": "How does the kept compartment work?", ... } ],
+        "events": [],
+        "primer_candidates": [],
```

That region now reads `"events": []` and `"primer_candidates": []` at
`validate-golden.json:1056-1057`. But the generator at `HEAD` would emit them:
after discard-last `persistedCount` is 1, the event filter at `gen:372-374`
keeps `at_compartment === null || at_compartment <= persistedCount`, and the
primer filter at `gen:375-380` uses `keepSideChannel(anchor, persistedCount,
discardedLast)` which is `anchor <= persistedCount` (`gen:311`), so
`at_compartment: 1` satisfies both.

The consequence: the expected TypeScript verdict was rewritten by hand, in a
commit changing Rust, so that Rust would agree. Running the generator today
would silently revert the edit. The artifact is no longer a generated
TypeScript oracle; it is a hand-maintained Rust expectation wearing the
generator's provenance comment. Nothing detects this, because the generator
never runs and the consumer never compiles.

### L4. The golden's chunk shape omits the input dimension the production validator branches on

**Reference correction.** The task cites `gen:44` for the omission. Line 44 is
`tool_only_ranges: Array<{ start: number; end: number }>;`, the last field of
`ChunkJson`. The omission is what follows it: nothing. The accurate citations
are `gen:40-45` (`ChunkJson`) and `gen:47-52` (`TsChunk`), neither of which
carries `completedToolArcs`.

Production's `HistorianValidationChunk` declares it at
`compartment-runner-validation.ts:19-20` ("Completed invocation/result arcs
visible in the raw snapshot"), and three code paths branch on it:
`healTerminalCompletedToolArc` (`:70-98`, called at `:137-142`),
`shouldDiscardLastHistorianCompartment`'s guard (`:115`), and the terminal
rejection at `:165-171`.

Because the generator's chunk never supplies the field, all sixteen golden
cases take the `undefined` default at `:65` and `:73`, and every one of those
three paths is inert across the entire vector set. So the differential — even
if it ran — could not compare the two implementations on the tool-arc
dimension at all.

The same blind spot is present in the executing lane:
`packages/e2e-tests/src/historian-eval/scorer.ts:598-599` builds every synthetic
chunk with `toolOnlyRanges: []` and `completedToolArcs: []`. Since `:598` is
also always empty, the only healing arm in `healCompartmentGaps` (`:53-59`)
never fires there either.

Only `compartment-runner-validation.test.ts` reaches these paths: it threads
both fields through a helper at `:73-85` and asserts the terminal rejection at
`:227`. A repository-wide grep for `completedToolArcs` returns five files:
`scorer.ts`, `compartment-runner-validation.ts`, its test,
`compartment-runner-wrapup.test.ts`, and `read-session-chunk.ts`. So the
dimension is unit-tested on the TypeScript side and untested on the Rust side,
with no vector set that could bridge them.

### L5. The generator reimplements discard-last rather than calling it, and the copy has diverged

`gen:5-7` says the generator "applies the pure publication-time discard-last
rule that currently lives in the incremental runner." It does so with its own
constant `BOUNDARY_HEALING_SLACK = 2` (`gen:38`) and its own predicate at
`gen:355-362`:

```
if (!options.in_emergency && emitted.length >= 2) {
    const lookaheadMargin = spec.chunk.end_index - last.end_message;
    if (lookaheadMargin <= BOUNDARY_HEALING_SLACK) { ... }
```

Production exports both the constant
(`HISTORIAN_BOUNDARY_HEALING_SLACK = 2`, `compartment-runner-validation.ts:11`)
and the predicate (`shouldDiscardLastHistorianCompartment`, `:104-117`). The
predicate carries a second conjunct the copy does not:
`&& !boundarySplitsCompletedToolArc(previous.endMessage + 1, chunk.completedToolArcs)`
at `:115`.

So the copy is the pre-guard version of the rule. **The task's lead that the
generator "hardcodes the healing slack (`:38`)" is confirmed, and the divergence
is larger than the constant**: the value still matches, the predicate does not.

### L6. `validateHistorianOutput` ignores the prior compartments it is handed, so two golden cases test only the generator

`validateHistorianOutput`'s signature at `compartment-runner-validation.ts:119-125`
takes `_priorCompartments: StoredCompartmentRange[]` and `_sessionId: string`,
both underscore-prefixed and both unread in the body (`:126-183`). The
prior-store contiguity check is not in the validator.

Verified: the diagnostic string `existing compartments end at` occurs in exactly
three places at `HEAD` — `gen-validate-golden.ts:338`,
`historian_validate.rs:472` and `:479`, and `validate-golden.json:931`. It
occurs **nowhere in shipped TypeScript**. The generator implements the check
itself at `gen:333-341`.

Consequence: the golden's two prior-store cases (`gen:516-531`) compare Rust
against the *generator's* reimplementation, not against any shipped TypeScript
behaviour. And `historian_validate.rs:472` carries a third arm
("expected a strictly newer raw message") that the generator has no case for at
all, so it is unconstrained on both counts.

### L7. `historian-state-file.ts` states a `MUST` its own deleter cannot enforce

`:28-29`: "The caller MUST delete the file in `finally{}` via
`cleanupHistorianStateFile`." The deleter at `:68-75` swallows every error
(`catch { // best-effort cleanup }`, `:72-74`), and the writer at `:62-64`
likewise returns `undefined` on any failure. So the obligation has no
enforcement point and no detector: a process crash between `writeFileSync`
(`:60`) and the caller's `finally` leaves a `state-<sessionId>-<epochMs>.xml`
file with no owner and no sweeper.

`AUDIT-KNOWN-ISSUES.md:468-477` (A28) documents a **second** writer to the same
directory, `compartment-runner-historian.ts` (`mkdirSync` at `:720`,
`writeFileSync` at `:726`), whose whole point is retention: "failed-run
retention is the whole point, and a future enhancement could TTL-GC the dumps."
Verified that the two do not collide destructively —
`cleanupHistorianStateFile` unlinks one exact path (`:71`), not a glob — so this
is an unbounded-growth and content-residency lead, not a deletion lead. Both
writers land under `<project>/.opencode/magic-context/historian/`, and A28
concedes "In a shared repo / CI these dumps could contain session content."

### L8. The mutation battery reacts in one direction, and only one class reaches the validator

**Reference correction.** The task cites `mutations.ts:431-449`. `:431` is the
doc comment "Construction invariant: semantic-class fixtures must be
validator-clean" and the function it introduces,
`assertBaselineValidates`, spans `:432-455`; `:449` falls inside its first
failure return. The accurate citations are `:431-455` for the baseline and
`:50-58` for the class-to-outcome map.

The map at `EXPECTED_OUTCOMES` (`:50-58`) assigns each of the seven classes at
`MUTATION_CLASSES` (`:33-41`) an expected outcome. Exactly one,
`structural-overlap` (`:56`), expects `{ stage: "validation-rejected" }`. The
other six expect a scored FAIL (`false-authoritative`, `recall`, or the
either-of pair at `:55`) or a probe-comparison failure (`:57`). **This confirms
the task's lead**: only one of the seven classes reaches a validator rejection.

On directionality: every one of the seven asserts that a *degraded* output is
caught. The single accept-direction fixture is the hand-authored baseline at
`:432-437`, which asserts `scoreRawOutput` reaches `stage === "scored"` and
`verdict === "PASS"`. That is one fixture, and `:431` labels it a construction
invariant rather than a mutation class — it exists so the semantic classes are
exercisable, not to test the accept path. Nothing constructs a
correct-but-different valid output and asserts it is admitted. So the battery
constrains false negatives across seven classes and false positives across one
hand-written shape.

### L9. The freeze lint binds the corpus, not the code that interprets it

`scenarioFingerprint` (`contract.ts:769-780`) hashes exactly seven fields:
`schema`, `id`, `title`, `families`, `transcript`,
`trigger.expectedHistorianRuns`, `gold`, `probes`. It hashes no validator
version, no plugin bundle identity, and no parser implementation.

`README.md:58-63` states that the *report* records a system tuple including
"parser implementation" — but that is the run record's identity, not the
approval's. Approvals and tombstones bind to `scenarioFingerprint`
(`contract.ts:764-765`), so a semantic change in `compartment-parser.ts` or
`compartment-runner-validation.ts` that preserves the frozen scenario bytes
leaves every approval valid and the freeze lint green. **This confirms the
task's lead as stated** (`contract.ts:769-780`).

`README.md:41-43` sharpens it: no release is frozen at `HEAD`, so the freeze
lint at `ci.yml:437` currently runs over the `dev` split only, and the
approval-binding mechanism the fingerprint exists for has no live consumer yet.

## Cross-language claims (what one side asserts about the other)

The characteristic defect shape in Part 5. Recorded separately per the task.

| # | Asserting side | The claim about the other side | Verified status |
| --- | --- | --- | --- |
| X1 | Rust: `historian_validate.rs:1384` | Rust's validator produces the same verdict as the TypeScript oracle for all sixteen golden cases | **Unverifiable at `HEAD`.** The test never compiles (L2), and its input no longer matches the generator (L3) |
| X2 | Rust: `historian_validate.rs:1393-1397` | "only malformed envelopes may diverge from the permissive TypeScript parser" — Rust may reject an input TypeScript accepts, but only when Rust's error message contains `<output> root document` | **Never executed.** Corroborated on the TypeScript side: `compartment-parser.ts:59` matches `<compartment>` blocks anywhere, with no `<output>` root requirement, so the permissiveness the claim names is real |
| X3 | TypeScript: `gen-validate-golden.ts:2` | The TypeScript validator is the reference for "the Rust mc-module port" | **Inverted at `HEAD` by L3.** The last edit to the golden moved the TypeScript expectation to match Rust |
| X4 | TypeScript: `gen-validate-golden.ts:387-391` | The parser was "genuinely part of the oracle path", enforced by throwing when `parsedTs.compartments.length === 0 && emitted.length > 0` | **Never executed.** A real guard, in a script nothing runs |
| X5 | Lane: `README.md:98-99` | The frozen corpus is "the best TS<->Rust validator differential vector set the repo has" | **True and unused.** No frozen release exists (`README.md:41-43`) and the reuse is deferred by the same sentence |
| X6 | Lane selection: `run-test-selection.ts:72-75` | "`mc-module`'s Rust historian producer does not promote claims, so these must never join a rust or pi selection" | **Verified as written.** `HISTORIAN_EVAL_HARNESS_TESTS` (`:84`) is excluded from `historianEvalUnitFiles` (`:66`) and claimed by `tsOpenCodeStandaloneFiles` (`:111`); `test:opencode-e2e` runs `--mode ts` (`e2e-tests/package.json:9`) |
| X7 | CI: `ci.yml:719-721` | "Rust is intentionally absent from public CI because its private ../commons and ../subconscious path-deps are not provisioned here; the local release gate runs that host group" | **Verified.** No workflow invokes `mc-module` beyond `ci.yml:169` and `:172` |
| X8 | TypeScript: `compartment-runner-validation.ts:207-208` | The failure notice wording and the transient/persistent contract "never drifts between OpenCode and Pi" | **Verified structurally.** One definition, ten call sites across both harnesses, no second implementation |

### The central coverage claim, stated precisely

The task asks for this stated exactly, so here it is with the qualifications the
evidence supports.

The historian-eval lane is the only coverage that executes in CI and reaches the
historian's *semantic* contract at all. What it actually executes is the real
**TypeScript** production code: `scorer.ts:715` calls the shipped
`validateHistorianOutput`, and `:762-764` publishes through the shipped
`appendCompartments` and `promoteSessionFactsDurable` (imported at `:27-28`).
`README.md:88-99` names this the `scoreRawOutput` seam.

It reaches **no Rust code**, and not by accident. `run-test-selection.ts:72-75`
excludes the harness-booting historian-eval test from any rust or pi selection,
in a comment giving the reason as a property of the Rust producer: it "does not
promote claims." So the lane's own selection code excludes the Rust historian
producer by name.

The precise statement is therefore: **the executing coverage adjacent to the
Rust historian exercises only the TypeScript implementation of the same
contract, and the exclusion of the Rust producer is written into the selection
code rather than being a gap.** Green CI constrains the TypeScript half and says
nothing about the Rust half — the same one-directional asymmetry
`part-5a-storage/existing-checks.md:338-342` records for the storage fence.

One reachability caveat, since METHOD.md rule 4 requires it per claim: the lane
is `default-production` for the *validator* it drives (that is the shipped code
path) and `test-only` for its scenario corpus, its verification bridge
(`README.md:156-165`), and its claim-memory schema workaround
(`README.md:166-172`). Those last two are lane-owned deviations that no
production path performs.

## Conventionally-enforced-only claims

Claims resting on discipline, a comment, or an operator, with no mechanical
gate.

- **The golden's freshness.** L1 plus L3. Nothing regenerates it, nothing
  compares it to the generator, and nothing fails when they disagree. Its
  agreement with shipped TypeScript is enforced by whoever last remembered to
  run `bun crates/mc-module/gen/gen-validate-golden.ts`.
- **The generator's discard-last copy tracking production.** L5. Two
  implementations of one rule, one constant duplicated, one conjunct missing,
  no test asserting equality.
- **The operator gates.** `README.md:134-152` lists three the document itself
  says are "not automatable from CI": the U2 prototype gate (one dev scenario
  must promote gold facts live), the U5 3-run stability audit ("each scenario's
  verdict identical across three live dev runs"), and the freeze procedure
  (two hand-authored approval files bound to the release-tuple fingerprint).
  All three require live-model access.
- **Live-lane cadence.** `historian-eval.yml:24-26` schedules the live lane
  weekly (`cron: "41 4 * * 2"`); `:12-23` allows manual dispatch. So the only
  check that observes a real historian is not per-PR, and `:37-39` restricts
  dispatch to the default branch. A red scheduled run is triaged by
  re-dispatch (`:8-9`, "each run is an independent report (no repeat-count
  machinery)").
- **The three-versus-dreamer threshold.** `compartment-runner-validation.ts:192`
  asserts in prose that "3 mirrors the dreamer circuit-breaker threshold."
  Nothing imports the dreamer constant or asserts equality, so the two can
  drift silently.
- **Compartment lease atomicity.** `AUDIT-KNOWN-ISSUES.md:456-466` (A27):
  `compartment-lease.ts` uses one `INSERT … ON CONFLICT DO UPDATE` rather than
  `BEGIN IMMEDIATE`, and the entry accepts it because "a duplicate historian run
  is itself defended by the per-process `activeRuns` check and the publish
  transaction's own lease re-verification. No duplicate-run has been observed in
  multi-process dogfood." Enforcement is the absence of an observation.
- **Historian dump hygiene.** A28 (`:468-477`). Retention is deliberate, GC is
  "a future enhancement," and the containment argument is that the path is
  project-local.
- **The `finally{}` obligation.** L7. A `MUST` in a doc comment with a
  best-effort deleter.
- **Pi parity for the historian runner.** `AUDIT-KNOWN-ISSUES.md:13` routes
  Pi↔OpenCode mechanism differences to `packages/pi-plugin/PARITY.md`, and
  `:353-362` (A19) states the general enforcement model for this class:
  "Parity is currently enforced by PARITY.md discipline + nine rounds of
  cross-harness audits rather than an automated equivalence test." A19 is about
  `inject-compartments-pi`, but `pi-historian-runner.ts` (1,683 lines) sits under
  the same regime, sharing only `buildHistorianFailureNotice` and
  `historian-state-file.ts` with the OpenCode runner.
- **The published artifact path.** `README.md:83-86`: "`contextDbSnapshotPath` is
  still an absolute runner-local path, so a downloaded artifact does not
  re-score in place." Tracked as `magic-context-x20`, so the archive step at
  `historian-eval.yml:144-150` produces evidence that cannot be replayed
  without hand-editing.

## Existing-check inventory

Status is `unaudited` for every entry, per METHOD.md. An existing check never
removes a property from the catalog.

### Test files and counts in scope (with CI status and workflow line refs)

Production lines are `wc -l` at `HEAD`. Test files are attributed by filename
sibling. Cases are top-level `it(`/`test(` declarations, so `it.each` and
table-driven expansion are undercounted.

| Scope file | Prod | Test files | Test lines | Cases | CI |
| --- | --- | --- | --- | --- | --- |
| `hooks/magic-context/compartment-runner-validation.ts` | 352 | 1 (`compartment-runner-validation.test.ts`) | 392 | 19 | `ci.yml:257` |
| `hooks/magic-context/compartment-parser.ts` | 329 | 2 (`.test.ts`, `.lang.test.ts`) | 569 | 22 | `ci.yml:257` |
| `hooks/magic-context/compartment-runner.ts` | 306 | 3 (`.test.ts`, `-timeout.test.ts`, `-wrapup.test.ts`) | 3,445 | 45 | `ci.yml:257` |
| `hooks/magic-context/compartment-runner-historian.ts` | 743 | **0** | 0 | 0 | n/a |
| `hooks/magic-context/compartment-runner-incremental.ts` | 932 | **0** | 0 | 0 | n/a |
| `hooks/magic-context/compartment-runner-recomp.ts` | 651 | 1 (`-recomp-fk.test.ts`) | 44 | 4 | `ci.yml:257` |
| `hooks/magic-context/compartment-runner-partial-recomp.ts` | 542 | 1 | 279 | 23 | `ci.yml:257` |
| `hooks/magic-context/compartment-runner-types.ts` | 214 | **0** | 0 | 0 | n/a |
| `hooks/magic-context/compartment-runner-drop-queue.ts` | 78 | 1 | 248 | 4 | `ci.yml:257` |
| `hooks/magic-context/compartment-runner-mapping.ts` | 60 | **0** | 0 | 0 | n/a |
| `hooks/magic-context/compartment-trigger.ts` | 772 | 1 | 767 | 15 | `ci.yml:257` |
| `hooks/magic-context/compartment-prompt.ts` | 148 | 1 | 49 | 3 | `ci.yml:257` |
| `hooks/magic-context/historian-state-file.ts` | 75 | 1 | 106 | 8 | `ci.yml:257` |
| `features/magic-context/compartment-storage.ts` | 758 | 2 (`-atomic.test.ts`, `-v6.test.ts`) | 270 | 8 | `ci.yml:257` |
| `hooks/magic-context/inject-compartments.ts` | 2,958 | 2 (`.test.ts`, `-mural.test.ts`) | 2,808 | 65 | `ci.yml:257` |
| `pi-plugin/src/pi-historian-runner.ts` | 1,683 | 1 | 955 | 31 | `ci.yml:257` **and** `:317` |
| **Totals** | **10,601** | **17** | **9,932** | **247** | |

Four scope files have no sibling test: `compartment-runner-historian.ts` (743),
`compartment-runner-incremental.ts` (932), `compartment-runner-types.ts` (214),
and `compartment-runner-mapping.ts` (60). `compartment-runner-types.ts` is type
declarations, so its zero is not a gap. The other three are; see Suspiciously
quiet areas.

The scope-map total for 5b is 11,510 lines over 16 units; the 10,601 above is
the same set measured at `HEAD` with `compartment-runner-*.test.ts` attribution
resolved per file rather than by glob.

**The historian-eval lane, counted separately** because it is not a sibling of
any scope file yet is the only lane that drives the validator end to end.
`historianEvalUnitFiles` (`run-test-selection.ts:59-70`) globs
`src/historian-eval/**/*.test.ts` and filters out `HISTORIAN_EVAL_HARNESS_TESTS`
(`:66`, `:84`):

| File | Lines | Cases | Selected by | CI |
| --- | --- | --- | --- | --- |
| `src/historian-eval/contract.test.ts` | 1,625 | 114 | `--historian-eval-unit` | `ci.yml:434` |
| `src/historian-eval/scorer.test.ts` | 2,715 | 99 | `--historian-eval-unit` | `ci.yml:434` |
| `src/historian-eval/promote.test.ts` | 1,049 | 39 | `--historian-eval-unit` | `ci.yml:434` |
| `src/historian-eval/mutations.test.ts` | 270 | 15 | `--historian-eval-unit` | `ci.yml:434` |
| `src/historian-eval/payload.test.ts` | 154 | 11 | `--historian-eval-unit` | `ci.yml:434` |
| `src/historian-eval/dev-corpus.test.ts` | 172 | 8 | `--historian-eval-unit` | `ci.yml:434` |
| `src/historian-eval/runner.test.ts` | 575 | 27 | **excluded** at `:66`; claimed by `tsOpenCodeStandaloneFiles` at `:111` | `ci.yml:722`, `--mode ts` only |
| **Unit subtotal** | **5,985** | **286** | | |

Two more deterministic gates run in the same job, `historian-eval-contracts`,
which declares no `needs` deliberately (`ci.yml:408-414`, "a gate placed in a
separate job downstream of check-plugin is skipped whenever check-plugin
fails"): the freeze lint at `:437` and the mutation battery at `:440`, both over
the dev corpus, both credential-free. The live lane runs only from
`historian-eval.yml` (`:12-26`), weekly or by dispatch, and re-applies both
deterministic gates before spending a token (`:110-117`, `README.md:47-50`).

Also in the inventory, not a sibling and not previously named:
`mapParsedCompartmentsToChunk` (`compartment-runner-mapping.ts:21-59`) is
exercised only indirectly through `validateHistorianOutput:144`, plus one
non-obvious direct importer, `packages/pi-plugin/src/read-session-pi.test.ts`.

### What the running tests cannot catch

The three the task asks for, plus the rest, in consequence order.

**1. Any disagreement between the TypeScript and the Rust validator.** This is
structural, not an oversight, and it has four independent causes stacked. The
generator runs in no workflow or script (L1). Its Rust consumer never compiles
(L2). The checked-in golden can no longer be produced by the generator and was
last hand-edited to match Rust (L3). And the generator reimplements
discard-last rather than calling it, so even a green comparison would be
comparing Rust against a copy, not against production (L5). The one vector set
`README.md:98-99` nominates for the job is deferred and, per `:41-43`, does not
exist yet.

**2. Anything on the completed-tool-arc dimension.** Both executing lanes pass
it empty. The generator's chunk type omits the field entirely (L4, `gen:40-45`
and `:47-52`), and `scorer.ts:598-599` hardcodes `completedToolArcs: []` and
`toolOnlyRanges: []`. So three production branches —
`healTerminalCompletedToolArc` (`:70-98`), the discard-last guard conjunct
(`:115`), and the terminal rejection (`:165-171`) — plus the only heal arm in
`healCompartmentGaps` (`:53-59`) are unreached by the differential and by the
eval lane alike. `compartment-runner-validation.test.ts` covers them
(`:227`, `:273`, `:312`), which is exactly what makes the omission visible: the
dimension is testable, and the two lanes that could compare implementations
both decline to supply it.

**3. A real historian's output.** Every per-PR check feeds hand-authored or
mutated XML. `README.md:114-121` is explicit that a live historian whose every
attempt is rejected is model behaviour scored as `FAIL:invalid-output`, and that
the scorer's run inventory "admits only a success or a `validation: `-prefixed
failure and reports anything else as `ERROR:record-runs-incomplete`." That
discrimination only happens in the live lane, which is weekly or dispatched
(`historian-eval.yml:24-26`), never per-PR. So the per-PR gates cannot catch a
prompt or parser change that makes real model output stop validating — the
mutation battery's inputs are synthesised from `payload.ts`, not sampled.

Also uncatchable by the running suite:

- **A semantic change that preserves frozen corpus bytes.** L9. The
  fingerprint's seven fields (`contract.ts:769-780`) contain no code identity.
- **Crash residue.** No check constructs a process kill between
  `maybeWriteHistorianStateFile`'s `writeFileSync` (`historian-state-file.ts:60`)
  and the caller's `finally`, so the orphaned-state-file window (L7) is
  unobserved. Similarly nothing asserts what a crash between the four recomp
  paths leaves on disk.
- **The un-sibling'd runners' own logic.** `compartment-runner-incremental.ts`
  (932) is where the discard-last rule and the repair-retry loop live in
  production, and it has no sibling test file at all; it is reached only
  transitively through `compartment-runner.test.ts`.
- **Whether the ctx_memory layer still accepts the legacy nine categories.**
  Claim 15's second half. `compartment-parser.ts:86-88` asserts it about another
  layer; nothing in 5b checks it.
- **The dreamer-threshold equality.** Claim 8, second half.
- **Report replay from a downloaded artifact.** `README.md:83-86`.

### Type-level and lint gates

Neither is behavioural. Both run on every push.

| Gate | Reference | What it can and cannot see |
| --- | --- | --- |
| `bun run typecheck` | `ci.yml:245` (root: plugin + pi-plugin + cli + retina-local-fs) and `ci.yml:217` (plugin only) | `packages/plugin/tsconfig.json:10` sets `"strict": true`. It does **not** set `noUncheckedIndexedAccess`, so `chunk.lines[i]` and `compartments[index]` are typed non-optional and an out-of-range read type-checks. Both patterns occur in scope (`compartment-runner-validation.ts:282`, `compartment-runner-mapping.ts:38-40`). The plugin `typecheck` script also type-checks `tsconfig.scripts.json`, so the generator is **not** covered — it lives under `crates/`, which no `tsconfig` in `packages/` includes |
| `bun run lint` | `ci.yml:248` | `biome check .` per package (`packages/plugin/package.json:48`). `packages/plugin/biome.json` enables `recommended`, with `noExplicitAny` and `noNonNullAssertion` at `warn` (not `error`) and `noForEach` off. So an `any` at the parser boundary is a warning, not a failure |
| `bun run build` | `ci.yml:251` | Bundles; catches a resolution break, not a semantic one |
| `check:tui-compiled` | `ci.yml:254` | Freshness gate for the compiled TUI, proving this repository knows how to write a generated-artifact freshness check. **No equivalent gate exists for `validate-golden.json`**, which is the mechanism L1 and L3 are missing |

The `check:tui-compiled` row is the load-bearing one. `packages/plugin/package.json:40`
copies `src/tui-compiled/`, rebuilds it, and `diff -ru`s the result, failing on
any drift. The pattern that would catch L3 is already implemented in this
repository for a different artifact.

## Suspiciously quiet areas

Where durable consequence over check density is worst.

- **`compartment-runner-incremental.ts`, 932 lines, no sibling test file.** The
  largest file in the sub-part after `inject-compartments.ts`, and the one
  `gen-validate-golden.ts:5-7` names as the home of the publication-time
  discard-last rule. It also holds five of the ten
  `buildHistorianFailureNotice` call sites (`:209`, `:396`, `:493`, `:547`,
  `:912`), so the entire escalation ladder of claim 8 lives here untested
  directly. This is the quietest area in 5b.
- **`compartment-runner-historian.ts`, 743 lines, no sibling test file.** It
  invokes the model and, per `AUDIT-KNOWN-ISSUES.md:470-472`, writes the full
  model response to disk on failure (`mkdirSync` `:720`, `writeFileSync`
  `:726`). A file that both calls an external model and writes session content
  to the project directory, with no test of its own, is the worst
  consequence-to-coverage ratio in the set.
- **`compartment-runner-mapping.ts`, 60 lines, no sibling test file.** Small,
  but it is the single point where a parsed ordinal becomes a durable
  `startMessageId`/`endMessageId` (`:39-52`) — the exact obligation Part 4a
  enumerates for the Rust side as "endpoints naming ids present in the
  snapshot." Its only rejection (`:41-46`) is reached transitively through
  `validateHistorianOutput:144-150` and directly only from
  `packages/pi-plugin/src/read-session-pi.test.ts`, a file whose name gives no
  hint that it is the mapper's coverage.
- **`compartment-runner-recomp.ts`, 651 lines against 44 test lines and 4
  cases.** 14.8 production lines per test line, the worst ratio in the scope
  set by a wide margin (compare `compartment-runner-validation.ts` at 0.90 and
  `compartment-trigger.ts` at 1.01). The one test file is named
  `-recomp-fk.test.ts` and is scoped to a foreign-key concern, so the recomp
  path itself is effectively uncovered at file granularity.
- **`compartment-storage.ts`, 758 lines against 270 test lines and 8 cases.**
  2.8 to 1, and it is the publish target: `scorer.ts:762` calls its
  `appendCompartments` as the production path. One of its two test files is
  named `-atomic.test.ts`, so atomicity is at least addressed, but eight cases
  is thin for the sub-part's single irreversible write.
- **`compartment-prompt.ts`, 148 lines against 49 test lines and 3 cases.** The
  prompt is the input contract the validator then polices. Part 4e owns the
  frozen prompt assets, and `historian-prompt.generated.ts` (790) is excluded
  from 5b for that reason, but the 148 lines that assemble the prompt are 5b's
  and are barely tested.
- **The generator directory as a whole.** `crates/mc-module/gen/` holds 14
  `gen-*.ts` files and one wrapper shell script. Verified at `HEAD`: **none** is
  referenced by any workflow or any `package.json` script. Their outputs are 34
  files under `crates/mc-module/testdata/`, all consumed by in-crate `#[test]`s
  that `ci.yml:172` does not compile. 5b owns one of the 14; the pattern is the
  finding.
- **The `<project>/.opencode/magic-context/historian/` directory.** Two writers
  with opposite lifetimes: `historian-state-file.ts` writes transient state that
  a `MUST`-delete obligation is supposed to remove (L7), and
  `compartment-runner-historian.ts:726` writes failure dumps that A28 says are
  deliberately retained with no GC. `ensureCortexKitArtifactGitignore`
  (`historian-state-file.ts:58`) keeps them out of `git status`, which also keeps
  their growth out of a user's view. No check bounds the directory's size or
  age.

## Open questions

- Was `validate-golden.json`'s hand-edit in `0c04f838` (L3) deliberate — a
  decision that Rust's discard-last side-channel filtering is correct and the
  TypeScript behaviour is the defect — or an oversight while making a Rust test
  pass? The commit message ("complete historian parity gates and side channels")
  is consistent with either. The answer decides whether the finding is "the
  golden is stale" or "the TypeScript validator has an unfixed side-channel
  defect that Rust already corrects." I cannot determine intent from the tree.
  (needs human input)
- Would running `bun crates/mc-module/gen/gen-validate-golden.ts` at `HEAD`
  succeed, or would its own assertions fail first? `gen:617-642` throws when a
  case's label disagrees with the oracle's verdict, and `gen:657-660` throws
  when there are no rejecting or no discard-last cases. I did not run it,
  because doing so writes `crates/mc-module/testdata/validate-golden.json` and
  METHOD.md rule 6 forbids source edits. Unresolved, needs an operator to run
  it in a throwaway checkout and report the diff.
- Does `HISTORIAN_PERSISTENT_FAILURE_THRESHOLD = 3`
  (`compartment-runner-validation.ts:194`) still equal the dreamer
  circuit-breaker threshold its comment at `:192` claims to mirror? The dreamer
  constant is outside 5b scope and I did not locate it in this pass.
  Unresolved, needs a `features/magic-context/dreamer/` sweep.
- Should the `Exercised:` label for a 5b record be `partial` when the
  historian-eval lane drives the shipped validator per-PR but only over
  hand-authored XML, never over live model output? This is the same question
  [scope map:736-744](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)
  raised for cross-language fixture pairs, narrowed to a within-language case:
  real code, synthetic input. My reading is `partial` with the input class named,
  but it affects every record anchored in the lane. (needs human input)
- Is there any specification for the compartment output format outside the
  prompt asset and the validator's own doc comments? Part 4 established that
  `mc-module` has no historian specification outside its doc comments, and this
  sweep found none on the TypeScript side either: `docs/` has no historian or
  compartment format document, and `docs/specs/prompt-surface/` is Part 4e's.
  If the format is stated only in `historian-prompt.generated.ts` (Part 4e) and
  `compartment-parser.ts`, then every 5b format guarantee is a claim with no
  independent source. Unresolved, needs a Part 4e cross-check.
- Does anything bound the growth of
  `<project>/.opencode/magic-context/historian/`? A28
  (`AUDIT-KNOWN-ISSUES.md:475-476`) says TTL-GC is "a future enhancement," which
  reads as "no." I verified there is no sweeper in the four files that write or
  clean that directory, but did not sweep the CLI's doctor commands, which are
  5d scope. Unresolved, needs a 5d cross-check.
