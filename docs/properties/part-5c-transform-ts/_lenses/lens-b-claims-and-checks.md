# Part 5c lens B: claims and checks for the TypeScript transform and the Rust-mode adapter

Claim-and-check lens only. No property records, no evidence files, no fixes, no
source or CI edits. Method contract in [../../METHOD.md](../../METHOD.md).

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Every line and file reference
below was read back at `HEAD`. Corrections to references supplied in the task
are recorded inline where they occur.

Claim sources swept: doc comments and diagnostic strings across the twelve 5c
scope files; `docs/AUDIT-KNOWN-ISSUES.md`;
`docs/specs/prompt-surface/decisions/release-review-resolution.md`; and the
configuration documentation surfaces that describe transform mode
(`packages/plugin/src/config/schema/magic-context.ts`, `CONFIGURATION.md`,
`ARCHITECTURE.md`, `packages/docs/src/content/docs/concepts/session-modes.md`,
`assets/magic-context.schema.json`).

## The framing this lens inherits

The tests in this sub-part **run**. One CI step, `ci.yml:256-257`
(`bun run test`), executes 482 of the repository's 596 test files, which is 100
percent of the test files in every package Part 5 scopes.

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

So the findings here are not coverage absence. They are: what the running tests
**cannot** catch, and where a check exists on one side of the TypeScript/Rust
boundary only.

**A second arithmetic correction, found while building the inventory.** The
scope map sizes 5c at "12 units, 13,175 lines"
([scope map:527](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)),
and repeats 13,175 in the risk table at `:398` ("13,175 lines against
`mc-module`'s `transform.rs` (12,468 production)") and in the rationale at
`:545-546`. Summing the twelve files it lists, at `HEAD`, gives **11,056**:
2,624 + 3,005 + 2,320 + 1,540 + 447 + 489 + 308 + 164 + 91 + 42 + 14 + 12. Each
individual figure in the scope map's list is correct; only the total is not.
Adding the held-out boundary file `module-transport.ts` (1,386) gives 12,442, so
that is not the source of the 2,119-line gap either, and I could not reconstruct
it. The comparison against `transform.rs` at `:398` therefore reads as
11,056-against-12,468, which reverses its direction: the TypeScript side is
smaller, not larger.

## Claims register

Capped at 20 by consequence. `Implementing code` is the shipped mechanism that
would have to be wrong for the claim to be false. `Executing check` is a check
that runs in CI at `HEAD`.

| # | Claim | Source | Implementing code | Executing check |
| --- | --- | --- | --- | --- |
| 1 | `transform_mode` defaults to `"ts"`; `"rust"` is "Experimental: routes the project through the direct mc-host Rust runtime (requires the user-level `subc.connection_file` path)" | `config/schema/magic-context.ts:672-677` | `.default("ts")` at `:674`, resolved at `config/index.ts:605-611` | **None for the default.** See lead L1 |
| 2 | `transform_mode: "rust"` "is an undocumented dev-only flag" and "npm users have no module in the path" | `docs/specs/prompt-surface/decisions/release-review-resolution.md:31-32`, `:38` | The two downgrade arms at `config/transform-mode.ts:22-27` and `:34-39` | **Partial.** `config/transform-mode.test.ts`, 6 cases; `config/index.test.ts:145`, `:160` |
| 3 | Rust mode requires user-tier consent because it "may demand-start the managed native host and hand it the user's provider credentials. Project (repo-controlled) config alone must not activate that" | `config/transform-mode.ts:29-33` | `:34-39` | **Yes.** `config/transform-mode.test.ts:32` ("falls back to ts when only project config selects rust without user-tier consent"); `config/project-security.test.ts:79-90` |
| 4 | "compaction-off mode does not support rust transform mode; using the TypeScript transform" | `config/transform-mode.ts:12-13` (the warning string) | `:22-27` | **Yes.** `config/transform-mode.test.ts:69`; `config/index.test.ts:145-158` asserts exactly one warning |
| 5 | Smart-drops off → "messages sent to the model are byte-identical to the age-based-only behavior" | `hooks/magic-context/transform.ts:523-525`, restated at `config/schema/magic-context.ts:962` | One guard: `transform-postprocess-phase.ts:1362` | **None.** See lead L4 |
| 6 | Smart-drops "Only acts on passes already busting the cache, so it never originates a cache bust. Honors the protected-tag reserve" | `config/schema/magic-context.ts:962` | `transform-postprocess-phase.ts:1364-1391`; the protected set is threaded at `:1399` | **Partial.** `transform-cache-busting-signals.test.ts`, 22 cases |
| 7 | A non-synthetic item bearing the reserved `mc_` prefix "is a contract violation" | `crates/mc-module/src/transform.rs:90-91` | `transform.rs:2734-2738`, `:3362-3366`, both `Err(TransformError::ReservedId)` | **None in TypeScript.** See lead L5 |
| 8 | The wire head must be "a synthetic m0 user message scoped to session `<sessionId>`" | `rust-mode-transform.ts:652-654` (the diagnostic) | `assertNativeBoundary` `:630-655`, one caller at `:2662` | **Yes**, but only on the rust path. See lead L6 |
| 9 | "The module owns healing, ordering, and codec fidelity. Do not clone, normalize, or otherwise inspect the returned native message array" | `rust-mode-transform.ts:1265-1266` | `applyNativeMessagesVerbatim` `:1245-1290`; the untouched array path at `:1264-1268` | **Partial.** `rust-mode-transform.test.ts`, 70 cases, all against stubs |
| 10 | A `native_messages_delta` is admitted only when it matches the acknowledged output: `delta.after === previous.fingerprint`, `replace_from` a safe integer in `[0, previous.messages.length]` | `rust-mode-transform.ts:1282-1284` (the diagnostic) | `:1273-1289` | **Yes.** Within `rust-mode-transform.test.ts` |
| 11 | The message-transform wrapper "fails OPEN (catch → unmodified messages) on purpose"; the catch "is **load-bearing and cannot be removed**" because OpenCode's `Effect.promise` turns a rejection into an unrecoverable defect. "Do not 'fix' this by rethrowing" | `docs/AUDIT-KNOWN-ISSUES.md:407-425`, `plugin/messages-transform.ts:45-79` | The tiered catch in `messages-transform.ts` | **Yes.** `messages-transform.test.ts`, 14 cases |
| 12 | "Correctness is preserved because all persistent state mutations inside the inner transform are idempotent across passes" | `plugin/messages-transform.ts:81-82` | No single mechanism; a property of every writer the transform reaches | **None.** See lead L3 |
| 13 | Three named errors are "Intentional loud aborts. Rethrown so the TUI surfaces the message and the turn does not silently fall through to native compaction or a provider-rejected raw prompt" | `plugin/messages-transform.ts:53-55` | The rethrow arm for `FailClosedBlockingError`, `EmergencyFailClosedError`, `RawFallbackContextLimitError` | **Yes.** `messages-transform.test.ts` |
| 14 | A non-BUSY error is persisted to `session_meta.last_transform_error` at the outer boundary because "an error thrown early enough bypasses [`runPostTransformPhase`'s catch] entirely. Writing it here at the outer boundary guarantees observability" | `plugin/messages-transform.ts:62-71` | The non-BUSY arm | **Yes.** `messages-transform.test.ts` |
| 15 | "Large individual values are split so one message cannot exceed a page", at `MODULE_PAGE_MAX_BYTES = 512 * 1024` with a `64 * 1024` continuation chunk | `hooks/magic-context/module-wire.ts:19-22` | `:20`, `:22`, `:25`; splitter and reassembler below | **Partial.** `module-wire.test.ts`, 11 cases against 1,540 production lines |
| 16 | The provenance-label byte bound is "shared with the module's `validate_claim` (`claim_mirror.rs`). Both sides must measure the same unit or a label can pass here and be rejected there, which suppresses the mirror lane" | `module-wire.ts:31-34` | `CLAIM_PROVENANCE_LABEL_MAX_BYTES = 512` at `:34` | **Agreement verified, no gate.** See cross-language claim X4 |
| 17 | "Numeric storage identities never cross this wire" | `module-wire.ts:141` | The `ClaimIntentBinding` shape at `:36-40` and the row types below it | **Partial.** No test named for the negative |
| 18 | The decoder independently re-checks that the ack equals the last delivered effect id | `module-wire.ts:729-733` (per `part-5a-storage/existing-checks.md:246`) | `:729-733` | **Yes**, per 5a's inventory |
| 19 | "Reasoning-variant flips ... check `variantChangeBustsProviderCache`; Anthropic-family providers flush pending ops to ride the natural prompt cache bust, while implicit-prefix providers defer flushes to avoid gratuitous busts" | `ARCHITECTURE.md:26` | `hooks/magic-context/hook-handlers.ts`, `sentinel.ts` (both outside 5c scope) | **Partial.** `transform-cache-busting-signals.test.ts` |
| 20 | "When `transform_mode` is set to `"rust"`, delegates execution to `rust-mode-transform.ts` which synchronizes database state via `module-state-sync.ts`, maps message ordinals via `module-wire.ts`, and falls back to LKG ... on failures" | `ARCHITECTURE.md:26` | `rust-mode-transform.ts`; `lkg-slot.ts`, `lkg-replay.ts` | **Partial.** `lkg-transform-replay.test.ts`, 15 cases |

## Contract-vs-code leads

Both sides cited. Not resolved in favour of the documentation, per METHOD.md
rule 3.

### L1. The default install runs the TypeScript renderer, and nothing checks the default

This is the highest-consequence claim in the sub-part, and the task is right
that it is load-bearing: it means the Rust transform Parts 4b and 4e cataloged
is not what users run.

Verified chain, all four links:

1. **The schema default is `"ts"`.** `config/schema/magic-context.ts:672-674`:
   `transform_mode: z.enum(["ts", "rust"]).default("ts")`. The type is declared
   non-optional at `:478` (`transform_mode: "ts" | "rust"`), so the resolved
   config always carries a value.
2. **Resolution runs on every load.** `config/index.ts:605-611` calls
   `resolveTransformMode` with four inputs and writes the result back over
   `config.transform_mode` at `:611`, appending any warnings at `:612`.
3. **Both downgrade arms fail toward ts.** `config/transform-mode.ts:22-27`
   returns `{ mode: "ts" }` when rust is configured and compaction is off;
   `:34-39` returns `{ mode: "ts" }` when rust is configured without user-tier
   consent. The only path that yields `"rust"` is the pass-through at `:41`,
   reached when `configured === "rust"` **and** compaction is on **and**
   (`userTierConfiguredRust || userTierHasSubc`).
4. **Rust requires user-tier consent.** `:34`, with the reason stated at
   `:29-33`: rust mode "may demand-start the managed native host and hand it the
   user's provider credentials," so project config alone must not activate it.

Corroborated from outside the code:
`release-review-resolution.md:31-32` calls `transform_mode:"rust"` "an
undocumented dev-only flag," and `:38` states "npm users have no module in the
path." Documentation corroborates the same shape from a different angle:
`CONFIGURATION.md` has **no `transform_mode` section at all** — verified against
its heading list; the only occurrence is one incidental sentence at `:427`
inside the compaction-off section. `ARCHITECTURE.md:16` calls it an
"Experimental Rust runtime mode."

**The gap.** No check anywhere asserts the default. Verified: a grep across
`config/schema/magic-context.test.ts`, `config/index.test.ts`, and
`config/transform-mode.test.ts` for `transform_mode` combined with `default` or
`parse({})` returns nothing. `magic-context.test.ts:223-228` parses both modes
explicitly and `:285-286` rejects `"wasm"`, but neither asks what an empty
config yields. All six `transform-mode.test.ts` cases (`:10`, `:21`, `:32`,
`:46`, `:57`, `:69`) pass `configured` explicitly. So the single most
consequential fact about this sub-part — which of two shipping transform
implementations a default install executes — rests on one `.default("ts")` call
with no test naming it.

### L2. The 70-case rust-mode suite runs no Rust

**Reference correction.** The task cites `ci.yml:249`. Line 249 is blank; `:247`
is `- name: Lint` and `:248` is `run: bun run lint`. The suite runs at
`ci.yml:256-257` (`bun run test`), like every other `packages/plugin` test file.

Verified counts: `rust-mode-transform.test.ts` is 3,702 lines and **70** cases,
against `rust-mode-transform.ts`'s 3,005 production lines. **The task's 70
figure is confirmed.**

Every case supplies its own `RustModeModuleClient` object literal. The type is
declared at `rust-mode-transform.ts:185-210` as an all-optional-method interface
extending `ModuleStateSyncClient`, and the test file constructs it inline at
least 20 times — `:274`, `:562`, `:620`, `:716`, `:744`, `:775`, `:851`, `:880`,
`:930`, `:955`, `:983`, `:1017`, `:1052`, `:1096`, `:1153`, `:1188`, `:1268`,
and onward — threaded through a single `makeDeps` helper at `:193`. The bodies
return canned values or throw canned errors; `:275-277` is representative
(`call: async () => { throw new Error("stop after authority preparation"); }`),
as is `:3004` (`call: async () => ({ ok: true })`).

Beside it, `transform.test.ts` is 3,263 lines and 51 cases covering
`transform.ts`, a wholly separate TypeScript implementation of the same
contract. **Nothing compares them.** Verified: `crates/mc-module/testdata/`
holds 34 golden files, and the only one named for a differential,
`differential-golden.json`, is not one. Its generator's own header
(`gen-differential-golden.ts:4-6`) states "The reference side intentionally owns
only canonical JSON and wire-visible fields... neither side derives expected
bytes from the other," and its three hand-authored cases at `:17-36` each carry
`output: { status: "ok", action: "passthrough", ... }`. So the expected outputs
are literals a human typed, not anything the TypeScript transform produced, and
all three are passthrough.

`ci.yml:719-721` states why the Rust half is absent from the e2e lanes: "Rust is
intentionally absent from public CI because its private ../commons and
../subconscious path-deps are not provisioned here; the local release gate runs
that host group."

### L3. The wrapper's idempotence claim and the audit entry that scopes it disagree

`messages-transform.ts:81-82` states a general guarantee: "Correctness is
preserved because all persistent state mutations inside the inner transform are
idempotent across passes."

`AUDIT-KNOWN-ISSUES.md:419-422` (A24) states a narrower one and names an
exception: "The genuinely risky sub-case — a throw *between*
`prepareCompartmentInjection`'s tail-trim and `injectM0M1`'s prepend, which would
drop history for that one pass — is bounded (the next pass replays correctly) and
the content strips are idempotent. A future hardening would stage trim+inject
atomically so a throw leaves the array fully transformed or fully untouched;
that is a core-path refactor, not a quick fix, and is deferred."

So the doc comment asserts idempotence over all persistent mutations, while the
audit entry concedes a non-atomic window between two of them and defers the fix.
The two are reconcilable only if "bounded, the next pass replays correctly" is
read as satisfying "correctness is preserved" — which is a different guarantee
from idempotence. Recorded rather than resolved.

Neither statement has an implementing mechanism to point at: idempotence here is
a distributed property of every writer the transform reaches, not a guard. No
check constructs the named window.

### L4. Smart-drops off is documented as byte-identical and is structurally inert

The claim appears twice, in near-identical words:
`transform.ts:523-525` ("Off → messages sent to the model are byte-identical to
the age-based-only behavior") and `config/schema/magic-context.ts:962` ("when off
the wire is byte-identical to the positional-only reclaim").

The implementation is one guard. `transform-postprocess-phase.ts:1362` opens
`if (args.smartDrops) {` and `:1392` closes it. Everything smart-drops does —
`buildSupersessionReclaimOps` (`:1364-1375`) and `buildEditSupersessionReclaim`
(`:1376-1391`) — is inside. `:1393` (`autoReclaimTargetCount =
syntheticPendingOps.length`) resumes the shared path, whose input
`syntheticPendingOps` was built by `buildSyntheticToolReclaimOps` at `:1349`
regardless of the flag.

**This confirms the task's lead**, and the precise consequence is worth stating.
The off-direction claim reduces to "the block is guarded," which the single `if`
at `:1362` establishes by construction. It is not falsifiable as written: there
is no separate mechanism that could diverge, so no test can be written that
would fail if the guarantee were violated without the guard itself having been
deleted. The claim is therefore not a check, and the risk it appears to cover —
that some smart-drops effect leaks past the guard — has no guard of its own.
Verified that the whole feature is inside the `if`: `smartDrops` reaches
`transform-postprocess-phase.ts` only through the field at `:650`, threaded from
`transform.ts:2247` (`smartDrops: deps.smartDrops === true`), which comes from
`hook.ts:1250` (`smartDrops: deps.config.smart_drops === true`).

The default is off (`config/schema/magic-context.ts:960`, `.default(false)`), so
per METHOD.md rule 4 the reachability class of everything inside the guard is
`explicit-config-only`.

### L5. The reserved `mc_` id namespace is unenforced in TypeScript

`transform.rs:87-91` declares the contract: "Reserved synthetic-block ids (never
carried by a real conversation item)... The reserved id prefix: a non-synthetic
item bearing it is a contract violation." Rust enforces it at two points, both
scanning the non-synthetic subset and both returning
`Err(TransformError::ReservedId)`: `:2734-2738` over `live` blocks, and
`:3362-3366` over `projection.blocks.iter().filter(|i| !i.synthetic())`
(`:3357-3361`).

Verified in TypeScript: a grep across `hooks/magic-context/`, `plugin/`, and
`config/` for `ReservedId`, `reserved id`, `RESERVED_ID`, and
`startsWith("mc_")`, excluding tests, returns **nothing**. The prefix exists on
the TypeScript side only as a producer: `todo-view.ts:82` defines
`SYNTHETIC_CALL_ID_PREFIX = "mc_synthetic_todo_"`. Nothing rejects an inbound
item that carries it.

**This confirms the task's lead.** Per the direction rule the scope map sets at
`:378-381`, a Rust-only guard is a live TypeScript defect, not a drift risk:
green CI constrains only the TypeScript half, and the TypeScript half is what a
default install runs (L1). So the poison-resistance invariant Part 4b records
for Rust is absent from the shipped default path.

### L6. Three synthetic predicates disagree, and the strongest guard sits on the non-default path

Three predicates decide "is this message synthetic?" inside the 5c scope. They
disagree pairwise.

| Predicate | Location | Requires id absent | Accepts `ignored === true` | Requires `sessionID` match |
| --- | --- | --- | --- | --- |
| `isSyntheticHeadMessage` | `transform-postprocess-phase.ts:140-155` | **Yes** (`:150`) | No (`:154`) | No |
| `isSyntheticUserMessage` | `rust-mode-transform.ts:601-611` | **No** | **Yes** (`:608`) | No |
| `assertNativeBoundary`'s inline test | `rust-mode-transform.ts:630-636` | **No** | No (`:635`) | **Yes** (`:636`) |

A fourth, outside 5c scope, widens the disagreement further:
`tail-hygiene-walk.ts:208-217` accepts `info.summary === true` or
`info.id === TODO_HEAD_ANCHOR_ID` as synthetic in addition to the structural
shape. **This confirms the task's lead that three synthetic predicates disagree
with each other.**

`transform-postprocess-phase.ts:141-149` documents why the id-absence clause is
load-bearing and records the incident that produced it: "Persisted OpenCode rows
always carry an id, so no persisted or foreign row can satisfy this regardless
of its metadata... The TS lane additionally sets `info.syntheticHead`, but the
Rust encode does not — requiring the flag here made the head walk stop at index 0
on rust-mode output and splice the compaction summary AHEAD of m0, failing the m0
wire invariant on every pass for sessions with persisted marker state." So the
predicates were deliberately loosened to accommodate the Rust encoder, and the
loosening is not uniform across the three.

The Rust side uses one notion throughout: `msg.ck.meta.synthetic`
(`transform.rs:2743`, `:3368`) and `FlatBlock::synthetic()` (`:3360`).

The second half of this lead is the reachability finding.
`assertNativeBoundary` is the only one of the three that throws, and it has
exactly one caller, `rust-mode-transform.ts:2662`, on the rust path. Its
diagnostic (`:652-654`) is careful and its rationale (`:637-640`) cites "a live
incident [that] required a binary bisect that a single log line would have
answered." So the strongest structural guard in 5c never fires on a default
install.

### L7. The published JSON schema has no freshness gate

`assets/magic-context.schema.json:36-44` carries `transform_mode` with
`"default": "ts"` and a description byte-identical to
`config/schema/magic-context.ts:676`. The file is published by URL — its `$id`
at `:3` is the raw GitHub path — and the CLI writes that URL into user configs
at `commands/doctor-omp.ts:327` and `commands/doctor-pi.ts:871`.

Verified: nothing regenerates or diffs it. A grep of the root and package
`package.json` files, all five workflow files, and `scripts/` for `schema.json`
or `magic-context.schema` returns no build, test, or CI reference. The only hits
in the tree are its own `$id`, the two CLI URL literals, and Part 4e's lens
citations.

This matters because `check:tui-compiled` (`ci.yml:254`,
`packages/plugin/package.json:40`) proves the repository knows how to write
exactly this gate: it copies `src/tui-compiled/`, rebuilds, and `diff -ru`s,
failing on drift. The pattern exists; the schema does not use it.

## Cross-language claims (what one side asserts about the other)

The characteristic defect shape in Part 5. Recorded separately per the task.

| # | Asserting side | The claim about the other side | Verified status |
| --- | --- | --- | --- |
| X1 | Rust: `transform.rs:90-91` | A non-synthetic item bearing `mc_` "is a contract violation" — an obligation on whoever produces the item, which on the default path is TypeScript | **Enforced only in Rust** (`:2734-2738`, `:3362-3366`). Unenforced in TypeScript (L5) |
| X2 | TypeScript: `rust-mode-transform.ts:1265-1266` | "The module owns healing, ordering, and codec fidelity. Do not clone, normalize, or otherwise inspect the returned native message array" | **Honoured as written** (`:1264-1268` returns the array untouched), and therefore a pure trust delegation to code no CI job runs |
| X3 | TypeScript: `transform-postprocess-phase.ts:145-146` | "The TS lane additionally sets `info.syntheticHead`, but the Rust encode does not" | **Verified true**, and the accommodation is why the predicates diverge (L6) |
| X4 | TypeScript: `module-wire.ts:31-34` | The 512-byte provenance-label bound is "shared with the module's `validate_claim` (`claim_mirror.rs`). Both sides must measure the same unit or a label can pass here and be rejected there, which suppresses the mirror lane" | **Agreement verified at `HEAD`, no gate.** `crates/mc-store/src/claim_mirror.rs:354` tests `label.len() > 512` and `:357` reads "provenance label must contain 1..=512 bytes." But Rust uses a bare `512` literal, not a shared constant, so the two are independently authored and can drift silently |
| X5 | TypeScript: `module-wire.ts:23-25` | "The module-side reassembler recognizes this continuation envelope for authority state sync and live transform requests" | **Unverified as a pair.** The key `__shadow_item_continuation` (`:25`) is asserted to be understood by the module; no executing check exercises both encoders |
| X6 | Doc: `release-review-resolution.md:30-33` | "the module surfaces (rust transform mode, CC-leg manifest) are not public-release surfaces — `transform_mode:"rust"` is an undocumented dev-only flag" | **Corroborated.** `CONFIGURATION.md` has no `transform_mode` section (L1) |
| X7 | Doc: `release-review-resolution.md:36-38` | On version skew, "old module still HARD-folds on the salted hash; light falls back to full with an explicit notice — degrades safe, never silent." "npm users have no module in the path" | **A structural argument, not a check.** The document says so itself at `:35-36` ("For hypothetical skew the structural argument stands") |
| X8 | CI: `ci.yml:719-721` | "Rust is intentionally absent from public CI because its private ../commons and ../subconscious path-deps are not provisioned here; the local release gate runs that host group" | **Verified.** The only `mc-module` invocations in any workflow are `ci.yml:169` (`--bin ck-mc-host`) and `:172` (`--test lifecycle_cli`), neither of which builds `--lib` |
| X9 | Rust: `crates/mc-module/gen/gen-differential-golden.ts:4-6` | "The reference side intentionally owns only canonical JSON and wire-visible fields. Rust consumes the exact request fixtures in-process; neither side derives expected bytes from the other" | **Verified true, and it is the point.** The three cases at `:17-36` are hand-authored literals, all `passthrough`. This is not a transform differential (L2) |

### The direction rule, applied

The scope map's rule at
[scope map:378-381](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)
is that a TypeScript-only guard is an unverified Rust obligation, while a
Rust-only guard is a live TypeScript defect. Part 5a found only the first kind
(`part-5a-storage/existing-checks.md:341-342`). **5c finds the second kind**:
X1 is a Rust guard with no TypeScript counterpart, on a contract the default
path must satisfy. That is the sub-part's distinguishing finding relative to 5a.

## Conventionally-enforced-only claims

Claims resting on discipline, a comment, or an operator, with no mechanical gate.

- **The default itself.** L1. One `.default("ts")` at
  `config/schema/magic-context.ts:674`, asserted nowhere.
- **The published schema's agreement with the Zod schema.** L7. Two independent
  copies of the same enum and description, no diff gate, and the copy that users
  see is the ungated one.
- **The reserved `mc_` namespace on the default path.** L5. Enforced in Rust,
  documented in Rust, absent in TypeScript.
- **The 512-byte provenance bound.** X4. A named TypeScript constant and a bare
  Rust literal, agreeing at `HEAD` by coincidence of authorship.
- **The smart-drops off guarantee.** L4. True by construction, unfalsifiable as
  written, so it functions as a comment rather than a check.
- **The inner-transform idempotence guarantee.** L3. A property of every writer
  the transform reaches, with the one known non-atomic window documented as
  deferred at `AUDIT-KNOWN-ISSUES.md:422-424`.
- **Cross-harness parity for the transform's neighbours.**
  `AUDIT-KNOWN-ISSUES.md:353-362` (A19) states the general enforcement model:
  "Parity is currently enforced by PARITY.md discipline + nine rounds of
  cross-harness audits rather than an automated equivalence test. A test feeding
  identical DB state through both paths and asserting byte-identical m[0] is a
  worthwhile future addition; the divergence risk is documented, not unguarded."
  `:13` routes all Pi↔OpenCode mechanism differences to
  `packages/pi-plugin/PARITY.md`.
- **The fail-open catch's own preservation.**
  `AUDIT-KNOWN-ISSUES.md:424-425`: "Do not 'fix' this by rethrowing." Enforced by
  a sentence in an audit document, not by a test that fails when the catch is
  removed. The document's preamble at `:8-11` states the enforcement model:
  "the items below are NOT bugs to re-report... If you believe one is genuinely
  wrong, argue against the **reasoning** recorded here."
- **The generator directory.** Verified at `HEAD`: none of the 14 `gen-*.ts`
  files under `crates/mc-module/gen/` is referenced by any workflow or any
  `package.json` script, and the one wrapper that exists,
  `regenerate-differential-golden.sh`, is itself unreferenced outside its own
  body. Their 34 outputs under `crates/mc-module/testdata/` are consumed by
  in-crate `#[test]`s that `ci.yml:172` does not compile.
- **The `variantChangeBustsProviderCache` provider families.**
  `ARCHITECTURE.md:26` names the Anthropic-family and implicit-prefix behaviours;
  the deciding code is in `hook-handlers.ts` and `sentinel.ts`, both outside 5c
  scope, and the claim is stated only in prose.

## Existing-check inventory

Status is `unaudited` for every entry, per METHOD.md. An existing check never
removes a property from the catalog.

### Test files and counts in scope (with CI status and workflow line refs)

Production lines are `wc -l` at `HEAD`. Cases are top-level `it(`/`test(`
declarations, so `it.each` and table-driven expansion are undercounted.

| Scope file | Prod | Sibling test | Test lines | Cases | CI |
| --- | --- | --- | --- | --- | --- |
| `hooks/magic-context/rust-mode-transform.ts` | 3,005 | `rust-mode-transform.test.ts` | 3,702 | **70** | `ci.yml:257` |
| `hooks/magic-context/transform.ts` | 2,624 | `transform.test.ts` | 3,263 | 51 | `ci.yml:257` |
| `hooks/magic-context/transform-postprocess-phase.ts` | 2,320 | `transform-postprocess-phase.test.ts` | 3,670 | 72 | `ci.yml:257` |
| `hooks/magic-context/module-wire.ts` | 1,540 | `module-wire.test.ts` | 465 | 11 | `ci.yml:257` |
| `hooks/magic-context/transform-compartment-phase.ts` | 447 | `transform-compartment-phase.test.ts` | 248 | 2 | `ci.yml:257` |
| `features/magic-context/transform-decision-log.ts` | 489 | `transform-decision-log.test.ts` | 147 | 8 | `ci.yml:257` |
| `plugin/messages-transform.ts` | 308 | `messages-transform.test.ts` | 326 | 14 | `ci.yml:257` |
| `hooks/magic-context/transform-message-helpers.ts` | 164 | **none found** | 0 | 0 | n/a |
| `hooks/magic-context/transform-context-state.ts` | 91 | `transform-context-state.test.ts` | 210 | 12 | `ci.yml:257` |
| `config/transform-mode.ts` | 42 | `transform-mode.test.ts` | 82 | 6 | `ci.yml:257` |
| `hooks/magic-context/transform-operations.ts` | 14 | `transform-operations.test.ts` | 608 | 15 | `ci.yml:257` |
| `hooks/magic-context/transform-stage-logger.ts` | 12 | **none found** | 0 | 0 | n/a |
| **Totals** | **11,056** | **10** | **12,721** | **261** | |

Non-sibling test files whose subject is the 5c transform pipeline, counted the
same way. All run at `ci.yml:257`:

| File | Lines | Cases |
| --- | --- | --- |
| `hooks/magic-context/transform-cache-busting-signals.test.ts` | 901 | 22 |
| `hooks/magic-context/transform-compaction-off.test.ts` | 900 | 16 |
| `hooks/magic-context/transform-todo-state.test.ts` | 863 | 19 |
| `hooks/magic-context/lkg-transform-replay.test.ts` | 439 | 15 |
| `hooks/magic-context/transform-index-staleness.test.ts` | 423 | 4 |
| `hooks/magic-context/transform-heuristic-cleanup-persistence.test.ts` | 246 | 2 |
| `hooks/magic-context/transform-authority-flip-back.test.ts` | 167 | 2 |
| **Subtotal** | **3,939** | **80** |

Config-side checks bearing on transform-mode selection, all at `ci.yml:257`:

| Location | What it covers |
| --- | --- |
| `config/transform-mode.test.ts:10`, `:21` | Rust is kept when the user tier selected rust, or when trusted user-level `subc` is present |
| `config/transform-mode.test.ts:32` | Project-only rust without user-tier consent falls back to ts |
| `config/transform-mode.test.ts:46`, `:57` | Ts is kept without warnings; rust is kept in compaction-on mode without a warning |
| `config/transform-mode.test.ts:69` | Rust downgrades to ts with exactly one warning when compaction is off |
| `config/index.test.ts:145-158` | The same downgrade through `loadPluginConfig`, asserting the warning list equals exactly `[RUST_COMPACTION_OFF_WARNING]` |
| `config/index.test.ts:160-173` | Rust survives when compaction is on |
| `config/index.test.ts:927-939` | Rust resolution with `subc` and with user-tier rust |
| `config/schema/magic-context.test.ts:223-228` | Both modes parse |
| `config/schema/magic-context.test.ts:285-286` | An unknown mode (`"wasm"`) throws |
| `config/project-security.test.ts:79-90` | Project-tier `transform_mode` is allowed through the project-security strip and raises no warning |

Cross-language artifacts, for completeness, none of which executes:

| Artifact | Consumer | CI |
| --- | --- | --- |
| `crates/mc-module/testdata/differential-golden.json` (3 cases) | in-crate `#[test]` under `crates/mc-module/src/` | **None.** `ci.yml:172` selects `--test lifecycle_cli`, which does not build `--lib` |
| `crates/mc-module/gen/gen-differential-golden.ts` | `regenerate-differential-golden.sh` | **None.** Neither is referenced by any workflow or script |
| The other 33 files in `crates/mc-module/testdata/` | in-crate `#[test]`s | **None**, same reason |

### What the running tests cannot catch

The three the task asks for, plus the rest, in consequence order.

**1. Any divergence between the two shipping transform implementations.** This
is structural. `rust-mode-transform.test.ts`'s 70 cases exercise the TypeScript
caller against 20-plus hand-written `RustModeModuleClient` literals returning
canned values, so no Rust code runs (L2). `transform.test.ts`'s 51 cases
exercise a wholly separate TypeScript implementation. No artifact compares them:
the only file named for a differential holds three hand-authored passthrough
cases and says outright that "neither side derives expected bytes from the
other" (`gen-differential-golden.ts:4-6`). And the Rust half could not be
compared even if a vector set existed, because no in-crate `mc-module` test
compiles in CI (X8). The consequence is one-directional in the way L5 makes
concrete: a Rust-only invariant is a live defect on the path a default install
runs, and CI stays green.

**2. Which transform a default install actually selects.** L1. Every existing
check names `transform_mode` explicitly, so the `.default("ts")` at
`config/schema/magic-context.ts:674` is unconstrained. A change to that literal,
or to the resolution write-back at `config/index.ts:611`, passes the whole
suite. This also means the suite cannot detect that the invariant guard at
`rust-mode-transform.ts:2662` never fires in production (L6), because nothing
asserts the production path.

**3. A disagreement between the three synthetic predicates.** L6. Each predicate
is exercised only through its own caller's tests — `isSyntheticHeadMessage`
through `transform-postprocess-phase.test.ts`, the other two through
`rust-mode-transform.test.ts` — and no test feeds one message shape to all
three and asserts they agree. The shapes that discriminate them are precisely
the ones the comment at `transform-postprocess-phase.ts:141-149` says arose from
a live incident: an id-bearing message whose parts are all synthetic, and a part
marked `ignored` rather than `synthetic`.

Also uncatchable by the running suite:

- **A `mc_`-prefixed non-synthetic item reaching the wire on the default path.**
  L5. There is no TypeScript check to fail, so nothing can be asserted about it
  short of adding the guard.
- **Drift between `assets/magic-context.schema.json` and the Zod schema.** L7.
  The file users are pointed at has no gate, while a sibling artifact
  (`src/tui-compiled/`) has exactly the gate it lacks.
- **Drift in the 512-byte provenance bound.** X4. The TypeScript constant and
  the Rust literal are independent; no test reads both.
- **The named non-atomic window between tail-trim and prepend.** L3 and
  `AUDIT-KNOWN-ISSUES.md:419-422`. No check constructs a throw inside it.
- **Whether the module-side reassembler understands
  `__shadow_item_continuation`.** X5. `module-wire.test.ts`'s 11 cases exercise
  the TypeScript encoder only.
- **Anything requiring a real `mc-host`.** `ci.yml:719-721` documents the
  exclusion, and `run-test-selection.ts:115-123` (`rustStandaloneFiles`)
  confirms the Rust selection is gated behind a prerequisite probe absent from a
  public checkout.

### Type-level and lint gates

Neither is behavioural. Both run on every push.

| Gate | Reference | What it can and cannot see |
| --- | --- | --- |
| `bun run typecheck` | `ci.yml:245` (root: plugin + pi-plugin + cli + retina-local-fs) and `ci.yml:217` (plugin only) | `packages/plugin/tsconfig.json:10` sets `"strict": true`. It does **not** set `noUncheckedIndexedAccess`, which matters directly here: `rust-mode-transform.ts:1287-1288` slices and spreads `previous.messages`, and `transform-postprocess-phase.ts:152-154` indexes `message.parts`, both under non-optional element types. The plugin script also covers `tsconfig.scripts.json`, so `crates/mc-module/gen/*.ts` is **not** type-checked by any `packages/` config |
| `bun run lint` | `ci.yml:248` | `biome check .` per package (`packages/plugin/package.json:48`). `packages/plugin/biome.json` enables `recommended`, with `noExplicitAny` and `noNonNullAssertion` at `warn` rather than `error`, and `noForEach` off. `rust-mode-transform.ts` traffics in `unknown[]` and `Record<string, unknown>` at the module boundary (`:1245-1248`), so the lint has little to say about the wire seam |
| `bun run build` | `ci.yml:251` | Bundles with `--external bun:sqlite --external node:sqlite` and emits declarations (`packages/plugin/package.json:38`). Catches a resolution or declaration break, not a semantic one |
| `check:tui-compiled` | `ci.yml:254` | The freshness gate that `assets/magic-context.schema.json` lacks. `packages/plugin/package.json:40` copies `src/tui-compiled/`, rebuilds, `diff -ru`s, and exits on drift |

The type system does carry one real 5c invariant worth naming:
`config/schema/magic-context.ts:478` declares `transform_mode: "ts" | "rust"`
non-optional, so `resolveTransformMode`'s `configured` argument
(`config/transform-mode.ts:4`) can never be `undefined` and the function is
total over the enum. That is a genuine type-level guarantee. It says nothing
about which of the two values a default install holds.

## Suspiciously quiet areas

Where durable consequence over check density is worst.

- **`module-wire.ts`, 1,540 lines against 465 test lines and 11 cases.** 3.3
  production lines per test line, the worst ratio among the scope files that
  have a test, and the file is the encode/decode seam for everything crossing to
  the module: the page bound (`:20`), the continuation envelope (`:22-25`), four
  protocol version constants (`:27-30`), the shared byte bound (`:31-34`), and
  the claim-intent binding (`:36-40`). 5a's inventory already leans on two of its
  guards (`part-5a-storage/existing-checks.md:246-247`) without this sub-part
  having tested the file as a unit. The one cross-language byte bound it declares
  (X4) is verified only by my reading it against `claim_mirror.rs`, not by any
  check.
- **`transform-compartment-phase.ts`, 447 lines against 248 test lines and 2
  cases.** Two cases for the phase that splices compartment injection into the
  served array. It is also one half of the non-atomic window A24 names at
  `AUDIT-KNOWN-ISSUES.md:419-421`.
- **`transform-message-helpers.ts`, 164 lines, no sibling test file.** Its doc
  comments carry real reasoning about where a synthetic anchor may be placed —
  `:89` ("aborted assistants from the wire; anchoring a synthetic tool call there
  would...") and `:146` ("synthetic todo part there would lose it when the
  summary is replaced") — so it holds placement constraints for exactly the
  synthetic machinery L6 shows is inconsistently defined, and nothing tests it
  directly.
- **`transform-decision-log.ts`, 489 lines against 147 test lines and 8 cases.**
  3.3 to 1, and it is the durable record of what a pass decided. Its own
  comments concede fragility: `:387` notes a row "is dropped by the best-effort
  caller" on `SQLITE_BUSY`, and `:334` describes an at-most-one-per-session row
  "overwritten by the next bust." A durable audit record that silently drops
  rows under contention, with eight cases, is the quietest durable-state area in
  5c.
- **`transform-stage-logger.ts`, 12 lines, no sibling test file.** Trivial in
  size, but it is the only structured record of stage timings, and
  `rust-mode-transform.ts:595-598` builds a 20-field timing line whose
  `other:` residual is computed by subtraction (`:595`, "must not be subtracted
  into `other` or they would hide leftover serve work"). Nothing asserts the
  residual is non-negative or that the fields sum.
- **The three synthetic predicates as a set.** L6. Each is covered; the set is
  not. There is no file that owns "what synthetic means," which is why four
  definitions accumulated in three files.
- **The default-install path as a whole.** L1 plus L6. The rust path has 70
  dedicated cases and a throwing wire-invariant guard; the ts path has 51 and no
  equivalent guard. The sub-part's check density is inverted relative to its
  reachability: the better-instrumented implementation is the one users do not
  get.
- **`crates/mc-module/gen/` and `crates/mc-module/testdata/`.** 14 generators, 34
  goldens, zero references from any workflow or `package.json` script, and no
  `tsconfig` under `packages/` type-checks the generators. 5c owns one generator
  and one golden of that set; the pattern is the finding, and it is the same one
  `part-5b-historian-ts/_lenses/lens-b-claims-and-checks.md` records for
  `gen-validate-golden.ts`.

## Open questions

- Does `transform_mode: "rust"` ship enabled for anyone? L1 establishes the
  default is `"ts"` and that project config alone cannot flip it, and
  `release-review-resolution.md:38` says "npm users have no module in the path."
  What remains unresolved is whether the managed CC deployment
  (`release-review-resolution.md:32-34`, "the CC leg is our own managed
  deployment... The one real deployment (prod ck-mc) carries S5") sets user-tier
  rust. If it does, the Rust transform has real users and 5c's risk rank should
  rise; if not, the Rust transform Parts 4b and 4e cataloged has none. I cannot
  observe a deployment from the tree. (needs human input)
- Should the 2,119-line discrepancy in the scope map's 5c total (see framing) be
  corrected in place, or recorded only? The individual file figures are all
  correct, so no scoping decision changes; but `:398`'s comparison against
  `transform.rs`'s 12,468 lines reverses direction once the sum is fixed, and
  that comparison is part of the stated rationale for 5c's risk rank. Recorded
  here rather than edited, per METHOD.md rule 5. (needs human input)
- Is the absence of a TypeScript `mc_`-prefix check (L5) deliberate? Two
  readings are consistent with the tree: the TypeScript lane may never construct
  ids from untrusted input, making the guard unnecessary there, or the guard was
  added to Rust as a hardening and never backported. Part 4b's record of the
  `[m0, m1] ++ tail` contract would say which. Unresolved, needs a Part 4b
  cross-check of whether the reserved namespace is stated as a producer
  obligation or a consumer defence.
- Does anything downstream depend on the three synthetic predicates agreeing
  (L6)? `assertNativeBoundary` throws on disagreement at the wire head, so at
  least one disagreement is fatal on the rust path. Whether a disagreement
  between `isSyntheticHeadMessage` and `isSyntheticUserMessage` is reachable on
  the ts path was not traced in this pass. Unresolved, needs a caller trace of
  `transform-postprocess-phase.ts:140` against the head-walk it feeds.
- What does the module-side reassembler actually accept for
  `__shadow_item_continuation` (X5)? `module-wire.ts:23-25` asserts recognition;
  the Rust reassembler is Part 4c or 4d scope. Unresolved, needs a cross-part
  check of the key's spelling and the chunk size on the Rust side.
- Should `Exercised:` read `partial` for a record proven only by
  `rust-mode-transform.test.ts`? The 70 cases drive real shipped TypeScript
  against a hand-written transport stub, so they are genuine evidence for the
  caller and none at all for the callee. This is the within-language analogue of
  the question
  [scope map:736-744](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)
  raised for cross-language fixture pairs, and 5a resolved the same shape for its
  own `deliver` closures at
  `part-5a-storage/existing-checks.md:293-301` by naming the stub. Adopting 5a's
  treatment here would be consistent, but it affects every rust-path record.
  (needs human input)
