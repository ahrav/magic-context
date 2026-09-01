# Part 5c lens A: the TypeScript transform as a second implementation, and the adapter as the seam

Attention focus: what each side does with the same input, and what the adapter
assumes about the Rust side. Method contract in [../../METHOD.md](../../METHOD.md).

Provenance: code read from `/local/home/ahrav/scratch/magic-context` at `HEAD` =
`e447c927` ("refactor(shm): trim final review leftovers"). Every line reference
below was read back at that commit. Scope is the 12 units named in
[../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md:525-543](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md),
13,175 production lines, plus `module-transport.ts` (1,386) read as a boundary
file and not cataloged.

Part 4b's contract statements are cited, never re-derived. Where this lens names
a Rust behaviour it points at the Part 4b record or catalog paragraph that owns
it.

**One correction to a cited reference.** Part 4b states the TypeScript suite runs
at `ci.yml:249`. At `HEAD` the `Test` step is `ci.yml:257` with
`run: bun run test` at `:258`. Part 4b read CI at `76cd6f41` and its own
provenance note records that `ci.yml` differs by `+10` lines across that span, so
the two agree; this lens cites `:257-258`.

**Corrections made while writing evidence.** Three findings changed during the evidence
pass, and the records plus this file were updated rather than left inconsistent.
(1) Rust does not merely read the wire's `synthetic` boolean; it repairs it on ingress
from a synthetic-todo id (`transform.rs:2405-2422`, called `:3243`), which moves the
`syntheticTodoMarker` exposure from the outbound leg to the return leg. (2) The delta
arm's fingerprint guard compares against a fingerprint of the previous pass's **input**
(`:2276`), not its output, so it proves input-generation agreement rather than
output-prefix agreement; a failure scenario resting on a poisoned cache was refuted,
because `wireCaches.set` at `:2857` is success-only. (3)
`mirrorRustRenderedClaimState`'s throw is swallowed at its call site, so it is not a
rejection site; see lead L8. Each correction is recorded in the relevant evidence file's
investigation log.

## Implementation map and selection

Three roles, not two. The scope map's phrase "two TypeScript paths ship
simultaneously" is right about shipping and wrong about symmetry: only one of the
two is a renderer.

| Role | Files | Lines |
| --- | --- | --- |
| **TypeScript renderer** | `transform.ts`, `transform-postprocess-phase.ts`, `transform-compartment-phase.ts`, `transform-message-helpers.ts`, `transform-context-state.ts` | 5,646 |
| **Rust-mode adapter** | `rust-mode-transform.ts`, `module-wire.ts` | 4,545 |
| **Shared or inert** | `transform-decision-log.ts` (489), `messages-transform.ts` (308), `config/transform-mode.ts` (42), `transform-operations.ts` (14), `transform-stage-logger.ts` (12) | 865 |

`transform-operations.ts` is a pure re-export barrel and
`transform-stage-logger.ts` is a single logging helper; neither carries a
property. `transform-postprocess-phase.ts` is genuinely shared: it exports both
the TypeScript renderer's postprocess and `runRustModePostprocess` (`:357`),
which the adapter calls at `rust-mode-transform.ts:2650`.

**The code denies the "second implementation" framing, and it is half right.**
`transform.ts:818-820` states: "Rust mode is an authority adapter, not a second
implementation of the TypeScript renderer." That is accurate about
`rust-mode-transform.ts`, which renders nothing: it encodes, calls, and applies
the module's array verbatim (`:1264-1265`). The second implementation is not the
adapter, it is `mc-module/src/transform.rs`. So the drift axis is TypeScript
renderer versus Rust renderer, with the adapter as the only seam either can be
observed through. Recorded as a contract lead below because a reader who takes
`:818-820` as covering the whole part will conclude there is no drift surface.

**Selection.** One config field, resolved once at boot, then read as a plain
comparison at every dispatch site.

- Schema: `config/schema/magic-context.ts:672-677`, `z.enum(["ts","rust"])` with
  `.default("ts")` at `:674`.
- Two downgrades: `config/transform-mode.ts:22-27` forces `ts` when compaction is
  off, and `:34-39` forces `ts` unless the user tier either selected `rust` itself
  or supplies `subc`. Both emit a warning.
- Resolution happens once, at `config/index.ts:605-611`, and **overwrites the
  field**: `config.transform_mode = resolvedTransformMode.mode` (`:611`). So every
  later reader sees the resolved value, and the downgrade cannot be bypassed by
  reading the raw config.
- Dispatch: `transform.ts:672-673` builds the adapter only when
  `deps.transformMode === "rust" && deps.rustModeModuleClient`, and `:822`
  branches on `deps.transformMode === "rust"`.

**Can an install run both, either, or one?** Exactly one renderer per pass, and
the mode cannot flip mid-session because it is resolved at boot and the plugin
process holds the resolved object. But the two paths are not disjoint: three
blocks run *before* the dispatch and therefore in **both** modes, all of them
durable. `clearOpenCodePendingTransformDecision` (`:701`), the compaction-mode
reconciliation including `commitCompactionModeRecord` and an out-of-band notice
send (`:793-813`), and, inside the rust arm only,
`revalidateEnforcementArtifacts` (`:831-851`). The rust arm returns at `:854`.

**What a default install runs: the TypeScript renderer.** Three independent
pieces of evidence.

1. The schema default is `"ts"` (`magic-context.ts:674`).
2. Both downgrade arms in `config/transform-mode.ts` fail toward `ts`, never
   toward `rust`, and the consent arm at `:34` requires a **user-tier** signal, so
   a project config alone can never reach rust.
3. `docs/specs/prompt-surface/decisions/release-review-resolution.md:30-32`
   states the module surfaces "are not public-release surfaces —
   transform_mode:\"rust\" is an undocumented dev-only flag", and `:38` states
   "npm users have no module in the path."

This resolves the scope map's open question at
`scope-map-and-risk-ranking.md:751-755` ("Which transform path is the shipped
default?"). The answer is `ts`, and the consequence for the risk rank is the
opposite of what that question feared: the never-CI-verified Rust transform is
**not** what users run, so 5c does not rise above 5b on that criterion. Every
record below labelled `default-production` is therefore a TypeScript-renderer or
shared-path record; every adapter record is `explicit-config-only`.

## Divergence surface versus the Rust transform

Part 4b names five Rust behaviours. For each, what the TypeScript side does.

**1. A commit point that is one fenced transaction.** Part 4b:
`store.commit_transform` at `transform.rs:5565` is one fenced SQLite transaction
in which ten write groups land or none do, and the engine states the contract at
`transform.rs:3505-3507` ("Decisions from this request stay in memory until the
final cache-state compare-and-swap accepts the pass"); the record is
`engine-terminal-cas-is-the-sole-core-meta-writer`
([part-4b catalog:79-95](../../part-4b-transform/catalog.md)).

**The TypeScript renderer has no equivalent and does not claim one.** There is no
pass-level transaction and no pass-level CAS. `transform.ts` contains one
`.prepare(` and it is a `SELECT` (`:417`); its durable writes go through 23
imported helper calls at `:701`, `:806`, `:1014`, `:1019`, `:1026-1027`,
`:1035-1037`, `:1073`, `:1166-1167`, `:1366`, `:1475`, `:1538`, `:1655`,
`:1732`, `:2331`, `:2377`, `:2411`, `:2421`, and `:2520`, each committing on its
own. `transform-postprocess-phase.ts` opens exactly one transaction, and it wraps
a single loop of tag-status updates (`:466-470`). Per-field CAS helpers exist
(`casChannel2NudgeState`, `transform.ts:2548`, `:2550`) but there is no
whole-pass expectation.

The substitute is an **idempotence claim**, stated at
`plugin/messages-transform.ts:181-183`: "Correctness is preserved because all
persistent state mutations inside the inner transform are idempotent across
passes." `docs/AUDIT-KNOWN-ISSUES.md:407-426` (A24) concedes the gap in the same
terms: `:421-424` says "A future hardening would stage trim+inject atomically so
a throw leaves the array fully transformed or fully untouched; that is a
core-path refactor, not a quick fix, and is deferred."

So the divergence is not "TypeScript is missing a fence". It is that the two
implementations rest on **different correctness arguments for the same contract**:
Rust on atomicity, TypeScript on idempotence. A differential that replays a pass
cannot assume either side's argument.

**2. Two writes that commit outside the fence.** Part 4b: `descend_lineage`
(`transform.rs:3312`) and `truncate_compartments_for_revert` (`:4646`) each
commit their own fenced transaction before the terminal CAS and neither is rolled
back; records `lineage-descent-write-precedes-the-array-validity-guards` and
`revert-truncate-commits-outside-the-terminal-cas`. Part 4b also corrects the
framing: both are observable today because straight-line error paths sit
downstream of each inside the same pass
([part-4b catalog:263-277](../../part-4b-transform/catalog.md)).

**On the TypeScript side the question inverts, because there is no fence for a
write to be outside of.** The comparable structure is a durable write that
precedes a validation which can still reject the pass, and the adapter has one:
`runRustModePostprocess` (`rust-mode-transform.ts:2650-2659`) mutates the served
array and writes tag-status rows and note-nudge delivery state, and
`assertNativeBoundary` (`:2662`) runs **after** it. When the assert throws, the
pass falls to LKG replay (`:2916-2921`) and the postprocess writes stay. That is
the same shape as Part 4b's two out-of-fence writes, reached through a different
mechanism, and it is a record below.

**3. Work bounded at nine attempts, with one uncounted loop.** Part 4b:
`apply_once_with_estimator_and_projection` (`transform.rs:2261-2301`) re-enters
only on `CasConflict` while `attempt < MAX_CAS_RETRIES` (`:2284`, `= 8` at
`:82`), so nine invocations; and `load_cached_tags` (`mc-store:7644`, called at
`transform.rs:3391`) is an unbounded `loop` whose exits are optimistic
revalidations and whose attempts nothing counts. Records
`pass-firing-work-bounded-by-max-cas-retries` and
`sel-tag-hydration-terminates-once-tag-mutation-stops`.

**The adapter has a different, smaller ladder, and it does not see Rust's nine at
all.** The adapter's bounds are three independent one-shot flags, not a counter:

- Page-series restart, bounded at exactly one by the `transformSeriesRestarted`
  boolean (`rust-mode-transform.ts:2439`, `:2446-2450`, `:2456-2460`).
- One full-array retry on `need_full_sync` or omitted native content
  (`:2469-2600`), guarded by `state.forceFullWire = true` (`:2483`).
- One ordinal re-resolve after a memo reset (`:2506-2518`).

Rust's `MAX_CAS_RETRIES` loop is internal to the module and invisible here: the
adapter has no `CasConflict` arm and no attempt counter, so a module that burns
all nine attempts and returns an error consumes one adapter failure, and three of
those park the session (`RUST_FAILURE_PARK_THRESHOLD = 3` at `:126`, enforced at
`:1474-1485`).

**And the TypeScript side has its own uncounted loop, in scope.**
`module-wire.ts:915-927` is a `while (true)` ordinal-paging loop whose only exits
are an empty page or a short page; nothing counts iterations. It yields to the
event loop at `:926`, so it does not block, but a session whose raw-message table
grows by exactly `MODULE_ORDINAL_PAGE_SIZE` between reads never takes either
exit. This is the structural twin of Part 4b's `load_cached_tags` finding, and
unlike that one it is inside this part's file set. Record below.

The `for (;;)` mirror-pull loop at `hook.ts:814-823` has the same shape, but
`hook.ts` is outside the 12-file set. Noted for a later part, not cataloged.

**4. Selection deterministic on collection order, and not pure.** Part 4b: every
ordered artifact comes from a `BTreeMap`, `BTreeSet`, or explicit `sort_by` with a
total tiebreak, but the decision reads `ProducerContext` state that is in neither
the request nor the store, so two processes sharing one store can select
different pass classes for byte-identical inputs. Records
`sel-pass-order-deterministic-under-fixed-inputs` and
`sel-eligibility-reads-process-local-scheduler-state`
([part-4b catalog:136-147](../../part-4b-transform/catalog.md)).

**The TypeScript renderer has the same impurity and one extra source of it: a
bounded LRU.** Two verdicts that `transform.ts` resolves per pass are memoized in
process-local `BoundedSessionMap` instances, `availabilityBySession` at
`ctx-reduce-availability.ts:91` (cap 1000) and its `todowrite` sibling. The map
is an LRU that evicts the oldest entry (`shared/bounded-session-map.ts:22`).

`transform.ts:878-879` claims the verdict "is frozen per session (first user
message's tools map) so it can never flap mid-session and bust the cache", and
`:888` repeats it ("frozen identically and never flaps mid-session"). Eviction
falsifies both: on the pass after eviction the verdict is re-resolved from the
*current* messages array (`ctx-reduce-availability.ts:148-152`), which is not the
array the first resolution saw. `bounded-session-map.ts:23-26` asserts evicted
values are "recomputable from the messages array on the next pass, or reloadable
from SQLite", which is true of a token cache and not of a first-message verdict.
Record below.

**5. A documented flag promising byte-identical output when off.** Part 4b's lens
C, claim C24: `CONFIGURATION.md:763` says smart drops "replay byte-for-byte
identically" and "**When `smart_drops` is off, the messages sent to the model are
byte-identical to the age-based-only behavior** — the entire feature is inert",
and records that "the byte-identity half has no Rust check"
([part-4b lens-c:74](../../part-4b-transform/_lenses/lens-c-claims-and-checks.md)).

**On the TypeScript side the inertness claim is structurally satisfied, and this
is the one place the TypeScript half is the stronger of the two.** All three
smart-drops builders sit inside a single `if (args.smartDrops)` block at
`transform-postprocess-phase.ts:1362-1392`: `buildSupersessionReclaimOps`
(`:1365`), `buildEditSupersessionReclaim` (`:1374`), and the two dedupe loops that
push their output. With the flag off, `syntheticPendingOps` is exactly what
`buildSyntheticToolReclaimOps` produced at `:1350`. Default is `false`
(`magic-context.ts:958-960`). So this is a genuine metamorphic relation worth
asserting on both sides, and asserting it on the TypeScript side is cheap.

The keep-counts also agree across implementations: `CTX_REDUCE_KEEP = 3`
(`features/magic-context/reclaim-protection.ts:2`) and
`CTX_REDUCE_KEEP: usize = 3` (`crates/mc-module/src/selection.rs:38`). The
documentation does not: `CONFIGURATION.md:759` says "Keep the newest 5 calls".
Contract lead below.

### The compact divergence table

| Rust behaviour (Part 4b) | TypeScript renderer | Direction |
| --- | --- | --- |
| One fenced commit, ten write groups, all-or-none (`transform.rs:5565`) | No pass transaction, no pass CAS; 23 self-committing writes in `transform.ts`; correctness rests on idempotence (`messages-transform.ts:181-183`) | **Rust-only invariant.** A live TypeScript exposure, conceded at `AUDIT-KNOWN-ISSUES.md:421-424` |
| Two durable writes commit before the CAS and are not rolled back | No fence to be outside of; the analogous shape is `runRustModePostprocess` (`:2650`) writing before `assertNativeBoundary` (`:2662`) | **Both, different mechanism** |
| Nine `apply_once` attempts on `CasConflict` (`MAX_CAS_RETRIES = 8`) | Adapter: three one-shot flags, no counter, no `CasConflict` arm; three failures park (`:126`, `:1474`) | **Diverges.** Rust's ladder is invisible to the adapter |
| One uncounted loop (`load_cached_tags`) | One uncounted loop (`module-wire.ts:915-927`), in scope | **Both** |
| Deterministic on collection order; impure via `ProducerContext` | Impure via the same class of process-local state, plus LRU eviction of a verdict documented as frozen (`transform.ts:878-879`) | **TypeScript is weaker.** Two false comments |
| `smart_drops` off is byte-identical; no Rust check | Structurally inert: all three builders inside `if (args.smartDrops)` (`:1362-1392`) | **TypeScript is stronger.** Assert here first |
| Synthetic stripped before every boundary, coverage, and tail read (`synthetic-strip-precedes-every-coverage-read`), over a flag the encoder supplies and Rust repairs on ingress (`transform.rs:2405-2422`, called `:3243`) | Three disagreeing predicates: `module-wire.ts:855-863` (`some`, plus message flag), `:1413-1421` (`every`, plus `syntheticTodoMarker`), `rust-mode-transform.ts:633-635` (`every`, no marker, no repair behind it) | **Diverges within TypeScript itself.** Outbound is doubly covered; the return leg is not |
| `mc_*` id namespace reserved; a **non-synthetic** item bearing it is rejected (`transform.rs:90-91`, `:2735-2736`, `:3357-3366` filtering at `:3360`), after the synthetic-todo repair promotes legitimate `mc_synthetic_todo_*` pairs at `:3243` | No ingress rejection anywhere in the 12 files. The encoder passes a supplied id through (`module-wire.ts:1404-1406`) | **Rust-only invariant.** The adapter has no `ReservedId` arm |

## Adapter assumptions

**What it assumes.** That the module's returned array is already correct.
`rust-mode-transform.ts:1264-1265` is explicit: "The module owns healing,
ordering, and codec fidelity. Do not clone, normalize, or otherwise inspect the
returned native message array." The array is spliced into the caller's array in
place (`replaceMessagesInPlace`, `:341-345`).

**What it validates, and what gates each check.** Four checks, and the two that
matter are conditional.

| Check | Site | Gate |
| --- | --- | --- |
| Response is an object, or has an object `result` | `responseValue`, `:657-661` | Unconditional |
| `native_messages` is a string, array, or a well-formed delta | `applyNativeMessagesVerbatim`, `:1245-1289` | Unconditional |
| The m0 head is a synthetic, session-scoped user message | `assertNativeBoundary`, `:630-654` | **Only when `response.boundary_id` is a non-empty string** (`:2660-2662`) |
| Rendered-claim state is internally consistent | `mirrorRustRenderedClaimState`, `:715-760` | **Only when the response carries `rendered_revision_locators` or `memory_snapshot_vector`** (`:720-722`), and its throw is swallowed at the call site (`:2765-2769`), so it gates the mirror write and not the pass |

Both conditional checks are **module-triggered**: the module decides whether it
gets validated by choosing which optional fields to send. A module that omits
`boundary_id` is never boundary-checked. Nothing in the adapter requires
`boundary_id` on a pass that busts the cache.

Element-level shape is not validated at all. `messageInfo` (`:347-350`) falls
back to the whole object when `.info` is absent, so a bare `{ role, parts }`
reads as a message; and `isRecord` (`:333-334`) is `value !== null && typeof
value === "object"`, which is true of arrays.

**What the CI stub could never produce, and what the adapter does with it.**
Part 4b establishes the stub returns canned objects. Reading the shapes: of the
70 tests in `rust-mode-transform.test.ts`, `boundary_id` appears in 2 (`:989`,
`:1023`) and a native array carrying `info` wrappers appears in 1 (`:973-982`).
Every other declared `native` is bare, for example `:848`
(`[{ role: "assistant", parts: [{ type: "text", text: "module output" }] }]`).

That shape trips a **third** conditional gate. `runRustModePostprocess` returns
early if *any* message lacks an `info` object
(`transform-postprocess-phase.ts:369-380`), with the comment "Test doubles and
older integrations may return the legacy bare message shape ... leave those
responses untouched instead of treating a missing `info` object as a failure."

So all three structural gates on the module's output are skipped for the exact
shape the CI stub returns: the boundary assert (no `boundary_id`), the
rendered-claim check (no locators), and the whole shared postprocess phase (no
`info`). The 70-test suite runs almost entirely through the unvalidated arm. And
the `info` guard is not test-only: one malformed message in an otherwise-good
production response silently disables marker reconciliation, note nudges,
auto-search hints, and deferred-note delivery for the whole array, with no
telemetry. Two records below.

**What it does when the native call fails.** One `catch` at `:2894` handles every
error from the whole pass body, in a fixed order.

1. If the message starts with `"rust transform wire invariant failed"`, log it
   (`:2896-2903`). Logging only; no separate handling.
2. If `emergencyFailClosed`, `markFailure` then **rethrow** as
   `EmergencyFailClosedError` (`:2904-2913`). The comment at `:2905-2906` states
   the rule: "any adapter failure aborts. Parking controls retry cadence, not
   fallback admission."
3. Otherwise, `replayLastGood` (`:2916-2921`). On success `servedFrom = "lkg"`.
4. `markFailure` (`:2924`), which increments `consecutiveFailures` and parks the
   session at 3 (`:1470-1485`), notifying the user once.
5. If LKG did not replay, `serveRawFallback` (`:2927`), which serves the
   unmodified input array (`:1806`) — unless its own estimate exceeds a trusted
   context limit, in which case it throws `RawFallbackContextLimitError`
   (`:1798-1804`), rethrown at `:2929-2932`.

So the ladder is: **LKG replay, then raw passthrough, then a loud refusal only if
raw would overflow a provider-proven limit** — with an unconditional abort ahead
of all three at 95 percent of a trusted limit
(`RUST_EMERGENCY_WALL_PCT = 95`, `:128`). The comment at `:2914-2915` names the
ordering invariant this depends on: "Validation happens before the caller-owned
array is replaced, so the original live array is still available for fail-open
replay." That is true of `assertNativeBoundary` only because
`applyNativeMessagesVerbatim` at `:2639` targets a throwaway `{ messages: [] }`
(`:2640`) rather than `output`; the real replacement happens later. It is a real
invariant and a fragile one, and it is a record.

Above the adapter, `messages-transform.ts` adds an outer fail-open: every error
except the three intentional ones returns the messages unmodified
(`:170-200`), which `AUDIT-KNOWN-ISSUES.md:407-426` documents as load-bearing
because OpenCode's `Effect.promise` turns a rejection into an unrecoverable
defect.

## Feasibility of a differential

**Feasible in principle; blocked today by three things, only one of which is a
harness gap.**

What works in favour. Both renderers are reached through **one** entry point with
**one** output convention: the closure returned by `createTransform`
(`transform.ts:688-690`) mutates `output.messages` in place, and both arms end by
having done so. Selection is a single dep field plus a client (`:672-673`,
`:822`). So one fixture genuinely can drive both arms in one process, and the
comparison target — the final `output.messages` — is well defined. That is more
than most differentials start with.

**Blocker 1: there is no in-process Rust transform to compare against.** The real
client is `new McHostModuleTransport(pluginConfig.subc?.connection_file)`
(`packages/plugin/src/index.ts:218-221`), an out-of-process transport to
`ck-mc-host` over a connection file. There is no napi or in-process binding for
the transform in the plugin package;
`grep -cE "spawn|child_process|napi" rust-mode-transform.test.ts` returns 0. The
CI `Test` step is `bun run test` (`ci.yml:257-258`) and builds no Rust host. So
today a differential can only compare the TypeScript renderer against a **stub**,
which compares nothing: the stub's output is a constant the test author wrote.
This is the harness gap, and it is the cheapest of the three to close because the
seam already exists — `RustModeModuleClient` (`rust-mode-transform.ts:185-240`)
is a plain interface, so a real implementation backed by a spawned host drops in
without touching the adapter.

**Blocker 2: the outputs are not comparable without a normalizer that does not
exist.** Four concrete mismatches, each verified:

- **Wrapper shape.** The TypeScript renderer mutates OpenCode `MessageLike`
  objects, which always carry `info`. The module's array is applied verbatim
  (`:1264-1265`) and the adapter tolerates a missing `info` by falling back to the
  object itself (`messageInfo`, `:347-350`).
- **Id namespace.** Rust mints `mc_m0`, `mc_m1`, `mc_todo:*`, and
  `mc_synthetic:*` (`transform.rs:2367-2375`). The TypeScript side uses
  `mc_synthetic_todo_` (`todo-view.ts:82`). Neither namespace is a superset of the
  other, so id equality is not the right comparator and a mapping has to be
  written.
- **Synthetic classification.** Three disagreeing predicates, listed in the
  divergence table. A normalizer has to pick one, and picking one is a design
  decision, not a mechanical step. `module-wire.ts:1413-1421` is authoritative
  *outbound*: Rust reads a single boolean `meta.synthetic` (`transform.rs:541`) that
  this encoder supplies, though it also repairs it on ingress from a synthetic-todo
  id (`normalize_synthetic_todo_ingress`, `transform.rs:2405-2422`, called `:3243`).
  Meanwhile `isSyntheticWireMessage` (`:855-863`) applies a `some` rule to the same
  array in the same file, and `assertNativeBoundary` (`:633-635`) applies a third on
  the way back, with no repair behind it.
- **Comparison depth.** The renderer mutates caller-owned objects in place, so a
  before-and-after comparison needs a deep snapshot of the input. The adapter path
  replaces the array wholesale. A differential must snapshot before dispatch or it
  will compare an array against itself.

**Blocker 3: the decision log cannot serve as the comparison oracle**, which
matters because it is the obvious candidate. It is lossy by construction and
differently populated per path:

- Writes go through a separate telemetry connection with `PRAGMA busy_timeout=0`,
  and the comment at `transform-decision-log.ts:385-390` states a locked database
  "throws SQLITE_BUSY immediately and the row is dropped by the best-effort
  caller".
- The write is deferred through `setTimeout(..., 0)`
  (`:229-241`), so it lands after the transform returns and outside anything.
- The TypeScript path normalizes its reason through `normalizeMaterializeReason`
  (`transform.ts:2425`), which returns `null` for anything not in
  `canonicalReasons` (`transform-decision-log.ts:112-132`). The rust path does a
  bare cast (`writeRustTransformDecision:167`) and never calls the normalizer;
  `grep -rn normalizeMaterializeReason` finds exactly two non-test call sites, the
  definition and `transform.ts:2425`. Its `decision` field is likewise a cast of
  `rawDecision.toLowerCase() || "unknown"` (`:158-160`). So the same column
  carries validated values on one path and arbitrary module strings on the other.

**The cheapest thing that is possible today, and worth saying because it is not
nothing.** Three of the relations below need no Rust process at all:
`smart_drops`-off inertness is a pure TypeScript metamorphic relation over one
config field; the three-predicate synthetic disagreement is decidable by feeding
one crafted array through the three functions in a unit test; and the LRU-eviction
verdict flip needs only 1001 session ids. Those are the differential's
preconditions, and closing them makes the eventual cross-language comparison
meaningful instead of noisy. The Rust-facing half stays blocked on Blocker 1.

## Observations

Numbered for reference from the records. All verified at `e447c927`.

**O1.** `config/schema/magic-context.ts:674` — `transform_mode` defaults to
`"ts"`. `config/transform-mode.ts:22-27` and `:34-39` both downgrade toward `ts`.
`config/index.ts:611` overwrites the field with the resolved value.

**O2.** `docs/specs/prompt-surface/decisions/release-review-resolution.md:30-32`,
`:38` — rust mode is "an undocumented dev-only flag"; "npm users have no module in
the path."

**O3.** `transform.ts:818-820` — "Rust mode is an authority adapter, not a second
implementation of the TypeScript renderer."

**O4.** `transform.ts:822-826` — when `transformMode === "rust"` and
`rustModeTransform` is falsy, log and `return` with messages untouched.
`transform.ts:672-673` builds the adapter from `deps.transformMode === "rust" &&
deps.rustModeModuleClient`. In the shipped wiring both derive from one condition:
`hook.ts:737-740` constructs `authorityRecoveryModuleClient` unconditionally
(`deps.rustModeModuleClient ?? (() => {...})()`), `hook.ts:812-813` assigns it to
`rustModeModuleClient` whenever the mode is rust, and `hook.ts:1463-1464` passes
both to `createTransform`.

**O5.** `transform.ts:793-813` — the compaction-mode reconciliation, including
`commitCompactionModeRecord` (`:806`) and an out-of-band notice send (`:797-804`),
runs before the dispatch and therefore in both modes.

**O6.** `transform.ts` durable-write call sites, all self-committing: `:701`,
`:806`, `:1014`, `:1019`, `:1026`, `:1027`, `:1035`, `:1036`, `:1037`, `:1073`,
`:1166`, `:1167`, `:1366`, `:1475`, `:1538`, `:1655`, `:1732`, `:2331`, `:2377`,
`:2411`, `:2421`, `:2520`. One `.prepare(` in the file and it is a `SELECT`
(`:417`). The only transaction in `transform-postprocess-phase.ts` is `:466-470`.

**O7.** `plugin/messages-transform.ts:181-183` — "Correctness is preserved because
all persistent state mutations inside the inner transform are idempotent across
passes."

**O8.** `docs/AUDIT-KNOWN-ISSUES.md:421-424` — "A future hardening would stage
trim+inject atomically so a throw leaves the array fully transformed or fully
untouched."

**O9.** `rust-mode-transform.ts:2650-2659` calls `runRustModePostprocess`;
`:2660-2663` calls `assertNativeBoundary` only when `response.boundary_id` is a
non-empty string.

**O10.** `rust-mode-transform.ts:630-654` — `assertNativeBoundary`. The head is
the first message whose `role !== "system"`; it must have `role === "user"`,
`sessionID === sessionId`, and `parts.length > 0 && parts.every(part =>
isRecord(part) && part.synthetic === true)` (`:633-635`).

**O11.** `transform-postprocess-phase.ts:369-380` — `runRustModePostprocess`
returns early if any message lacks an `info` record. `:367` also returns when
`!fullFeatureMode || compactionOff`.

**O12.** Three synthetic predicates: `module-wire.ts:855-863`
(`info.synthetic === true` or **some** part synthetic), `module-wire.ts:1413-1421`
(**every** part `synthetic === true` **or** `syntheticTodoMarker === true`),
`rust-mode-transform.ts:633-635` (**every** part `synthetic === true`). Rust reads
one boolean, `ServedMessage.meta.synthetic` (`transform.rs:541`), supplied by the
encoder, and repairs it on ingress when a content block carries an
`mc_synthetic_todo_` id (`normalize_synthetic_todo_ingress`, `transform.rs:2405-2422`,
called at `:3243`; `is_synthetic_todo_id` at `injection.rs:195-197`, prefix at
`injection.rs:23`). The comment at `transform.rs:3239-3241` states the reason:
"Older adapters did not copy that marker into CK metadata, so recognize the reserved
call-id namespace here too." The repair runs before the reserved-id rejection at
`:3357-3366`, which filters to non-synthetic blocks at `:3360`.

**O13.** `rust-mode-transform.ts:1264-1265` — "The module owns healing, ordering,
and codec fidelity. Do not clone, normalize, or otherwise inspect the returned
native message array."

**O14.** `rust-mode-transform.ts:347-350` — `messageInfo` returns `value.info`
when it is a record, otherwise `value`. `:333-334` — `isRecord` is `value !== null
&& typeof value === "object"`.

**O15.** `rust-mode-transform.ts:2914-2915` — "Validation happens before the
caller-owned array is replaced, so the original live array is still available for
fail-open replay." The mechanism: `:2639-2648` applies into a throwaway
`{ messages: [] }` (`:2640`).

**O16.** Failure ladder: `:2894` catch; `:2896-2903` wire-invariant log;
`:2904-2913` emergency rethrow; `:2916-2921` LKG replay; `:2924` `markFailure`;
`:2927-2932` raw fallback or `RawFallbackContextLimitError`. Park at
`RUST_FAILURE_PARK_THRESHOLD = 3` (`:126`), enforced `:1470-1485`.
`RUST_EMERGENCY_WALL_PCT = 95` (`:128`). `serveRawFallback` refusal predicate
`:1770-1804`; unmodified-array service `:1806`.

**O17.** Adapter retry bounds: `:2439`, `:2446-2450`, `:2456-2460`
(one page-series restart); `:2469-2600` (one full-array retry); `:2506-2518` (one
ordinal re-resolve). No `CasConflict` arm and no attempt counter anywhere in the
file.

**O18.** `module-wire.ts:915-927` — `while (true)` ordinal paging; exits are
`page.length === 0` (`:921`) and `page.length < MODULE_ORDINAL_PAGE_SIZE`
(`:925`); `await yieldToEventLoop()` at `:926`. No iteration counter.

**O19.** `transform.ts:878-879` and `:888` claim the tool-availability verdicts
are frozen per session and never flap. `ctx-reduce-availability.ts:91` is
`new BoundedSessionMap<boolean>(1000)`; `shared/bounded-session-map.ts:22` —
"Eviction drops the oldest entry"; `:23-26` claims evicted values are
recomputable. Re-resolution reads the current array at
`ctx-reduce-availability.ts:148-152`.

**O20.** `todowrite` availability is consumed with opposite polarity per path.
`transform-postprocess-phase.ts:251` suppresses only when `frozen && !callable`,
so `frozen === false` injects. `rust-mode-transform.ts:147` returns `false` unless
`availability.frozen && availability.callable`, so `frozen === false` suppresses.
The TypeScript path re-reads permission only on a cache-busting pass (`:253`); the
adapter re-reads on every pass when a client exists (`:153`).

**O21.** `transform-postprocess-phase.ts:1362-1392` — every smart-drops builder is
inside `if (args.smartDrops)`. Default `false` at `magic-context.ts:958-960`.
`CTX_REDUCE_KEEP = 3` at `features/magic-context/reclaim-protection.ts:2`;
`CTX_REDUCE_KEEP: usize = 3` at `crates/mc-module/src/selection.rs:38`;
`CONFIGURATION.md:759` says 5; `magic-context.ts:963` says 3.

**O22.** `transform-decision-log.ts:385-390` — separate telemetry handle,
`PRAGMA busy_timeout=0`, row dropped on contention. `:229-241` — write deferred
via `setTimeout(..., 0)`. `:167` — `materializeReason` cast unvalidated on the
rust path; `:158-160` — `decision` cast likewise. `:112-132` —
`normalizeMaterializeReason`, called only from `transform.ts:2425`.

**O23.** `transform.rs:90-91` — `RESERVED_ID_PREFIX = "mc_"`, "a non-synthetic
item bearing it is a contract violation"; enforced `:2735-2736` and `:3363-3364`.
No `mc_` ingress rejection in any of the 12 files; `module-wire.ts:1404-1406`
passes a supplied id through and only mints `opencode-<sha>` when it is absent.
Rust minting: `transform.rs:2367-2375`.

**O24.** `rust-mode-transform.ts:1268-1289` — the delta arm. Rejects unless a
`previous` exists, `delta.after === previous.fingerprint`, and `replace_from` is a
safe integer in `[0, previous.messages.length]`. Splice at `:1286-1289`.

**O25.** `packages/plugin/src/index.ts:218-221` — the real client is
`new McHostModuleTransport(pluginConfig.subc?.connection_file)`.

**O26.** Test inventory, `rust-mode-transform.test.ts`: 3,702 lines, 70 tests.
`boundary_id` at `:989` and `:1023` only. An `info`-bearing native array at
`:973-982` only. Bare `native` declarations at `:848`, `:954`, `:1049`, `:1548`,
`:1657`, `:1709`, `:1764`, `:1823`. `native_messages_delta` at `:3312` and
`:3331`, both direct `applyNativeMessagesVerbatim` calls, neither a module
response. Siblings: `transform.test.ts` 51 tests,
`transform-postprocess-phase.test.ts` 72, `transform-compaction-off.test.ts` 16,
`transform-operations.test.ts` 15, `lkg-transform-replay.test.ts` 15,
`transform-context-state.test.ts` 12, `module-wire.test.ts` 11,
`transform-compartment-phase.test.ts` 2, `transform-authority-flip-back.test.ts`
2. All under `bun run test` at `ci.yml:257-258`.

## Candidate properties

Thirteen records: 10 safety, 1 liveness, 2 reachability. Semantics distribution is
10 `always`, 1 `sometimes`, 1 `always-or-unreached`, 1 `reachable`, and no
`unreachable`. Reachability is 6 `default-production` and 7 `explicit-config-only`,
with no `test-only` record. In this part `default-production` means reachable in a
shipped plugin install running the **TypeScript** renderer, which O1 and O2
establish is what a default install runs; `explicit-config-only` means it needs
`transform_mode: "rust"` plus user-tier consent, which O2 records is not a
public-release surface.

### tstx-a-default-install-runs-the-typescript-renderer

Type: reachability
Reachability: default-production — this record *is* the reachability claim. O1:
`magic-context.ts:674` defaults to `"ts"`; both arms of
`config/transform-mode.ts` downgrade toward `ts`; `config/index.ts:611`
overwrites the field with the resolved value.
Status: active
Exercised: partial — `config/transform-mode.test.ts` exists and runs at
`ci.yml:257-258`; `transform-authority-flip-back.test.ts` (2 tests) covers the
rust-to-ts authority drain. Neither asserts the resolved mode of a
default-constructed config, which is the claim here.
Guarantee: A plugin install with no `transform_mode` setting resolves to the
TypeScript renderer, and no project-tier configuration can move it to rust.
Check: `reachable` — the `deps.transformMode !== "rust"` fall-through at
`transform.ts:861` onward executes for a default config, and the rust arm at
`:822` does not. `reachable` because this is location coverage: the claim is that
a specific path is the one a default install takes. It is the premise every other
record's reachability label depends on, so it is asserted rather than assumed.
Fault/timing angle: none. Resolution happens once at boot
(`config/index.ts:605-611`) and the resolved object is held for the process
lifetime, so the mode cannot change mid-session.
Required faults and enabling state: none. A config object with no
`transform_mode` key, loaded through `config/index.ts`.
Confidence: high — [evidence](../evidence/tstx-a-default-install-runs-the-typescript-renderer.md).
Read the schema default, both downgrade arms, the overwrite at `:611`, and the
two dispatch sites. Cross-checked against
`release-review-resolution.md:30-32` and `:38` (O2), which independently states
rust mode is not a public-release surface and that npm users have no module.
Existing check: `config/transform-mode.test.ts` covers `resolveTransformMode`
directly; status `unaudited`.
Impact: If wrong, every reachability label in this part is wrong, and the
scope map's fear at `scope-map-and-risk-ranking.md:751-755` — that users run the
never-CI-verified Rust transform — is realised.
Open questions:
- `magic-context.ts:675-676` describes `transform_mode` in the user-facing config
  schema, which `release-review-resolution.md:31-32` calls "an undocumented
  dev-only flag". Whether a schema-described flag counts as undocumented for
  release purposes is a policy question. (needs human input)

### tstx-a-typescript-pass-has-no-atomic-commit-point

Type: safety
Reachability: default-production — O6: all 22 write sites are in the
TypeScript arm of `transform.ts`, reached by the default mode per
`tstx-a-default-install-runs-the-typescript-renderer`.
Status: active
Exercised: not yet — no test in the 12 units' suites interrupts a pass between
two write sites. `transform.test.ts` (51 tests) and
`transform-postprocess-phase.test.ts` (72) run whole passes to completion or
assert single-helper behaviour.
Guarantee: A TypeScript transform pass that throws partway leaves durable state
that a later pass repairs, because no pass-level transaction exists to roll it
back.
Check: `always` — for every pass that throws at write site *k* of *n*, the
durable state after the throw equals the state after a successful pass truncated
at *k*, and replaying the same input to completion reaches the same state a
single uninterrupted pass would. `always` because the idempotence claim at O7 is
unconditional; it is the only thing standing where Rust has a fence, so it must
hold at every write site, not merely at the ones a test happens to reach.
Fault/timing angle: the window is the whole pass body, `transform.ts:701` through
`:2520`, with 22 commit points inside it. Rust's equivalent window is zero-width
by construction (`transform.rs:5565`).
Required faults and enabling state: a throw injected between two consecutive
write sites, then a replay of the identical input. The outer wrapper already
converts a throw to a no-op return (`messages-transform.ts:170-200`), so the
seam exists; what is missing is a way to choose *where*.
Confidence: high — [evidence](../evidence/tstx-a-typescript-pass-has-no-atomic-commit-point.md).
Counted the write sites, confirmed the single `.prepare(` in `transform.ts` is a
`SELECT` (`:417`), confirmed the one transaction in
`transform-postprocess-phase.ts` (`:466-470`) wraps only tag-status updates, and
confirmed no pass-level expectation exists (the `cas*` helpers at `:2548`,
`:2550` are per-field). Cited Part 4b for the Rust fence rather than re-deriving
it.
Existing check: none for the interrupted case. `AUDIT-KNOWN-ISSUES.md:421-424`
(O8) concedes the gap.
Impact: A throw between a tail-trim and a prepend serves a truncated history for
that pass; `AUDIT-KNOWN-ISSUES.md:419-421` names exactly this sub-case and
argues it is bounded because the next pass replays. That argument is the property
under test.
Open questions:
- Idempotence is claimed for "all persistent state mutations" (O7). Enumerating
  22 helpers against that claim is a per-helper audit larger than this lens.
  Unresolved, needs a dedicated pass over the write set.

### tstx-a-postprocess-writes-precede-the-boundary-assert

Type: safety
Reachability: explicit-config-only — O9 sits in `rust-mode-transform.ts`, reached
only under `transform_mode: "rust"` with user-tier consent (O1, O2).
Status: active
Exercised: partial — the test at `rust-mode-transform.test.ts:1011` ("fails the
pass when a present boundary lacks a synthetic session-scoped m0") reaches the
throw and asserts the array is restored (`:1038-1039`) and
`failureCount === 1` (`:1040`). It does not assert anything about what
`runRustModePostprocess` already wrote.
Guarantee: When the boundary assert rejects a module response, the durable writes
the postprocess phase already made on that same response are still present.
Check: `always` — whenever `assertNativeBoundary` throws at `:2662`, every
durable effect of `runRustModePostprocess` at `:2650` on the same array is
committed and not reverted. `always` because the ordering is unconditional in the
source; the two calls are 12 lines apart with no branch between them.
Fault/timing angle: the window is `:2650` to `:2662`. Inside it,
`reconcileMarkerRepresentation` can commit tag-status updates
(`transform-postprocess-phase.ts:466-470`) and `markNoteNudgeDelivered` (`:417`)
can mark a nudge delivered for a message the served array will not contain.
Required faults and enabling state: a module response with a non-empty
`boundary_id` whose head fails one of the three clauses at `:635-636`, and a
session whose durable state gives the postprocess something to write — a
persisted compaction marker, a note-nudge anchor, or a deferred note.
Confidence: high on the ordering, medium on the effect set —
[evidence](../evidence/tstx-a-postprocess-writes-precede-the-boundary-assert.md).
The ordering is read directly. The effect set required following
`runRustModePostprocess` into four helpers; `markNoteNudgeDelivered` is the one
whose effect is clearly not idempotent across a rejected pass, and its outcome is
checked at `:418` before the append, so a delivered-but-not-appended nudge is
representable.
Existing check: `rust-mode-transform.test.ts:1011`, status `unaudited`; it
asserts array restoration, not durable-write survival.
Impact: A note nudge marked delivered but never served is lost: the served array
came from LKG replay (O16 step 3), which cannot contain the append.
Open questions:
- Is the ordering deliberate? Moving `assertNativeBoundary` above
  `runRustModePostprocess` looks free from the source, since the assert reads only
  the array. (needs human input)

### tstx-a-boundary-assert-is-module-triggered

Type: safety
Reachability: explicit-config-only — O9.
Status: active
Exercised: partial — 2 of 70 tests supply `boundary_id` (O26). The other 68
exercise the skipped arm without asserting that it is skipped.
Guarantee: The only structural check on the module's returned array runs only
when the module chooses to send a field that triggers it.
Check: `always` — for every applied module response, `assertNativeBoundary` runs
if and only if `response.boundary_id` is a non-empty string. `always` because the
condition is evaluated on every applied response. The property is deliberately
stated as the biconditional the code implements, not as "the boundary always
holds", so it fires on a correct implementation and documents the gate rather
than assuming a defect.
Fault/timing angle: none; it is a pure control-flow property.
Required faults and enabling state: two module responses differing only in the
presence of `boundary_id`, both carrying a head that would fail the assert. The
first must be applied without complaint, the second must throw.
Confidence: high — [evidence](../evidence/tstx-a-boundary-assert-is-module-triggered.md).
Read `:2660-2663` and confirmed `boundary_id` appears nowhere else in
`rust-mode-transform.ts`, so nothing requires it on a cache-busting pass.
Existing check: `rust-mode-transform.test.ts:1011` covers the present-and-failing
case; nothing covers the absent case as a gate.
Impact: A module build that stops sending `boundary_id` silently disables the
`[m0, m1] ++ tail` check that Part 4b's
`synthetic-strip-precedes-every-coverage-read` is the Rust half of. The
TypeScript side would apply a malformed head verbatim.
Open questions:
- Should a cache-busting pass require `boundary_id`? The adapter knows
  `cacheBustingPass` at `:2669`, so the information is present. (needs human
  input)

### tstx-a-shared-postprocess-skips-any-array-with-a-bare-message

Type: safety
Reachability: explicit-config-only — O11's early return is in the function the
adapter calls at `:2650`. The `!fullFeatureMode || compactionOff` return at
`:367` is a separate gate and not this record.
Status: active
Exercised: partial, and in the wrong direction — the 68 bare-shape tests (O26) all
take this early return, so the suite's coverage of the *body* in rust mode comes
from at most the 1 test at `:973-982`. No test asserts the skip.
Guarantee: One message lacking an `info` object disables the entire shared
postprocess phase for that pass, silently.
Check: `always` — for every rust-mode pass, `runRustModePostprocess` performs no
mutation and no durable write if any element of the applied array lacks a record
`info`. `always` because `some` is evaluated over the whole array on every call.
Fault/timing angle: none. The consequence is timing-shaped, though: a note nudge
or auto-search hint that this pass would have delivered defers to a later pass
whose array may be well formed, so the effect is a delay of unbounded length
rather than a loss.
Required faults and enabling state: a module response array in which exactly one
element lacks `info`, plus durable state the body would act on — a persisted
compaction marker (`getPersistedCompactionMarkerState`), a note-nudge anchor, or
an auto-search hint decision.
Confidence: high — [evidence](../evidence/tstx-a-shared-postprocess-skips-any-array-with-a-bare-message.md).
Read `:369-380` and confirmed the predicate is `some`, not `every`, so one bad
element suppresses the whole array. Counted the bare-shape tests to establish
that the CI suite runs this arm rather than the body.
Existing check: none. The comment at `:368-370` names test doubles as the reason
for the tolerance, which is the finding.
Impact: Marker reconciliation, note nudges, auto-search hints, and deferred-note
delivery all stop, with no log line and no telemetry. Combined with
`tstx-a-boundary-assert-is-module-triggered`, both structural gates on the
module's output are off for the same input shape.
Open questions:
- Should the tolerance be narrowed to the shapes tests actually produce, or should
  the guard log? It currently cannot be distinguished from a pass with nothing to
  do. (needs human input)

### tstx-a-three-synthetic-predicates-disagree

Type: safety
Reachability: explicit-config-only — all three predicates are on the rust-mode
wire path (O12). `module-wire.ts` is reached only from the adapter.
Status: active
Exercised: not yet — `module-wire.test.ts` has 11 tests; none feeds one array
through more than one predicate.
Guarantee: The three functions that classify a message as synthetic agree on every
array that crosses the module boundary in either direction.
Check: `always` — for every message, `isSyntheticWireMessage`
(`module-wire.ts:855-863`), the encoder's rule (`:1413-1421`), and
`assertNativeBoundary`'s rule (`rust-mode-transform.ts:633-635`) return the same
verdict. `always` because every crossing message is classified by at least two of
them, so disagreement is a live inconsistency rather than a latent one.
Fault/timing angle: none. This is a shape property, decidable from one array.
Required faults and enabling state: none, and this is why the record is cheap. A
unit test can construct three discriminating arrays directly: a message with one
synthetic part and one plain part (`some` says yes, `every` says no); a message
whose parts are all `syntheticTodoMarker: true` (the encoder says yes,
`assertNativeBoundary` says no); a message with `info.synthetic === true` and zero
parts (`isSyntheticWireMessage` says yes, both `every` rules say no because they
require `parts.length > 0`).
Confidence: high — [evidence](../evidence/tstx-a-three-synthetic-predicates-disagree.md).
Read all three predicates and constructed the three discriminating cases by hand
from the source. Corrected one claim during evidence writing: Rust does not merely
read the supplied boolean, it repairs it on ingress from a synthetic-todo id
(`transform.rs:2405-2422`, called `:3243`), which makes the outbound leg doubly
covered for the `syntheticTodoMarker` case and leaves the **return** leg as the
uncovered direction, since nothing repairs `assertNativeBoundary`'s narrower rule.
Existing check: none.
Impact: On the return leg a `syntheticTodoMarker` head is synthetic to the encoder
and non-synthetic to `assertNativeBoundary`, so the module returns a head it
considers correct and the adapter rejects it, driving the failure ladder and, after
three passes, parking the session with a transport-shaped message. On the outbound
leg the row-1 case (one synthetic part, one plain) gets P1's slot treatment and P2's
non-synthetic flag, and Rust's id-keyed repair does not cover it. Part 4b's
`synthetic-strip-precedes-every-coverage-read` assumes the flag it reads is
trustworthy.
Open questions:
- Which predicate is intended as canonical? The encoder is the authority by
  construction, so the other two should probably call it. (needs human input)

### tstx-a-reserved-mc-id-namespace-is-unenforced-in-typescript

Type: safety
Reachability: default-production — the absence is in the TypeScript renderer's
ingress, which a default install runs. The *consequence* under rust mode is
`explicit-config-only`; the missing guard is not.
Status: active
Exercised: not yet — Rust has
`reserved_id_and_ordinal_violations_error` (`transform.rs:21390`), which Part 4b
establishes does not run in CI. The TypeScript side has no equivalent test.
Guarantee: No non-synthetic message reaching either renderer carries an id in the
reserved `mc_` namespace.
Check: `always` — for every message in the input array with a non-synthetic
classification, `id` does not start with `mc_`. `always` because Rust treats a
violation as a contract error on every pass (`transform.rs:90-91`,
`:2735-2736`, `:3363-3364`), so the obligation is unconditional; the question is
only which side enforces it.
Fault/timing angle: none.
Required faults and enabling state: a harness-supplied message whose
`info.id` begins with `mc_` and whose parts are not all synthetic. The harness is
the trust boundary here: the array comes from OpenCode, and
`module-wire.ts:1404-1406` passes a supplied id through unchanged.
Confidence: high on the absence, medium on the consequence —
[evidence](../evidence/tstx-a-reserved-mc-id-namespace-is-unenforced-in-typescript.md).
Grepped the 12 units for `mc_` and found only `todo-view.ts:82`'s
`mc_synthetic_todo_` constant and a log tag at `rust-mode-transform.ts:2908`; no
rejection. Confirmed the adapter has no `ReservedId` arm (grep for `reserved` in
`rust-mode-transform.ts` and `module-wire.ts` returns nothing). The consequence
is medium because whether the module's rejection reaches the adapter as a
distinguishable error depends on the transport's error mapping, which is
`module-transport.ts` and out of scope.
Existing check: `transform.rs:21390`, Rust-side, does not run in CI. Status
`unaudited`.
Impact: Under rust mode a poisoned id is a pass failure that burns one of three
park budget slots and is indistinguishable in the adapter from a transport error.
Under the default TypeScript mode the same input is processed, so whatever
`mc_m0`-shaped id collision Rust exists to prevent is unguarded on the path users
run.
Open questions:
- Does the TypeScript renderer actually have a collision to prevent? It mints
  `mc_synthetic_todo_`-prefixed call ids (`todo-view.ts:82`), so a supplied
  `mc_synthetic_todo_*` id is the concrete case. Unresolved, needs a read of
  `todo-view.ts` and `inject-compartments.ts`, both outside this file set.

### tstx-a-ordinal-paging-loop-is-uncounted

Type: liveness
Reachability: explicit-config-only — `resolveOrdinalsForModule` is called only
from the adapter (`rust-mode-transform.ts:2131`, `:2149`, `:2488`, `:2508`).
Status: active
Exercised: partial — `module-wire.test.ts` (11 tests) covers ordinal resolution
outcomes. None drives the loop past one page under concurrent growth.
Guarantee: Once the session's raw-message table stops growing, the ordinal paging
loop terminates within one page read.
Check: `always` — after the last append to the raw-message table, the loop at
`module-wire.ts:915-927` performs at most one further `readRawSessionMessageOrdinalPage`
before taking an exit. `always` on a bounded fault-free window: run appends under
load, stop them, then assert the next resolve completes within one page read.
Stated in the unit the code bounds, page reads, because it bounds nothing else.
Fault/timing angle: the loop exits on an empty page or a short page. A writer that
appends exactly `MODULE_ORDINAL_PAGE_SIZE` rows between two reads produces a full
page every time and the loop continues. `await yieldToEventLoop()` at `:926`
means it starves nothing, so the symptom is an unbounded pass, not a hang.
Required faults and enabling state: a second process appending to the same
session's raw-message table at page-size granularity while a pass resolves
ordinals. `AUDIT-KNOWN-ISSUES` and `hook.ts:829-831` both establish that several
plugin instances share one database, so the concurrent writer is real.
Confidence: high — [evidence](../evidence/tstx-a-ordinal-paging-loop-is-uncounted.md).
Read the loop and both exits, confirmed no counter exists in the function, and
confirmed the mismatch check at `:930-934` happens *after* the loop, so it cannot
break it.
Existing check: none that bounds iterations.
Impact: A pass that never returns holds the transform for that turn. The outer
wrapper's fail-open (`messages-transform.ts:170-200`) catches throws, not
non-termination.
Open questions:
- Part 4b's `sel-tag-hydration-terminates-once-tag-mutation-stops` is the same
  shape on the Rust side. Whether the two should share one bound is a design
  question. (needs human input)

### tstx-a-frozen-tool-verdict-is-evictable

Type: safety
Reachability: default-production — O19. Both verdicts are resolved in the
TypeScript arm at `transform.ts:880-881` and `:889-890`.
Status: active
Exercised: not yet — no test in the 12 units' suites drives more than 1000
distinct session ids through one process.
Guarantee: A session's `ctx_reduce` and `todowrite` availability verdicts do not
change for the lifetime of the session.
Check: `always` — for a fixed session, every resolution of
`resolveCtxReduceAvailabilityFromMessages` returns the same `callable` value.
`always` because `transform.ts:878-879` states it unconditionally ("can never
flap mid-session"). A `sometimes` marker on the eviction itself would be the
wrong shape: eviction is a precondition, and the property is the invariant it
threatens.
Fault/timing angle: the window opens when a 1001st session id is touched in one
plugin process, evicting the oldest entry
(`shared/bounded-session-map.ts:22`). The next pass for the evicted session
re-resolves from the *current* array (`ctx-reduce-availability.ts:148-152`),
which is not the array the first resolution read.
Required faults and enabling state: 1001 distinct session ids in one process,
then a further pass for the first, with a messages array whose first user
message's `tools` map differs from the original — or is simply no longer in the
array.
Confidence: high — [evidence](../evidence/tstx-a-frozen-tool-verdict-is-evictable.md).
Read the cap, the eviction, the re-resolution path, and both comments. Confirmed
`bounded-session-map.ts:23-26`'s justification ("recomputable from the messages
array on the next pass") is sound for a token cache and unsound for a
first-message verdict, which is what makes this a defect rather than a
documented trade-off.
Existing check: none. `bounded-session-map` has its own tests; they do not cover
this consumer's assumption.
Impact: A mid-session flip changes whether `§N§` prefixes and nudges are emitted,
which `transform.ts:879` says busts the cache. This is the TypeScript analogue of
Part 4b's `sel-eligibility-reads-process-local-scheduler-state`, with an extra
trigger the Rust side does not have.
Open questions: None.

### tstx-a-unfrozen-todo-verdict-decides-oppositely-per-path

Type: safety
Reachability: default-production for the TypeScript polarity (O20,
`transform-postprocess-phase.ts:251`); the rust polarity at
`rust-mode-transform.ts:147` is `explicit-config-only`. Recorded as
default-production because the divergence is observable from the default side.
Status: active
Exercised: not yet — no test drives one unfrozen verdict through both paths.
Guarantee: The same tool-availability verdict produces the same synthetic
todo-pair decision on both paths.
Check: `always` — for every `(session, messages)` whose `ToolAvailabilityVerdict`
has `frozen === false`, the TypeScript and rust paths agree on whether a
synthetic todo pair is injected. `always` because both paths evaluate their
predicate on every pass; there is no arm where the question is not asked.
Fault/timing angle: `frozen === false` is a transient state. It is returned when
the session is not yet persisted (`ctx-reduce-availability.ts:158`, `:193`), so
the window is the first pass or two of a session, and it is exactly the window in
which a first-render decision is made.
Required faults and enabling state: a session in the not-yet-persisted state, so
that the verdict resolves `{ callable: true, frozen: false }`, driven once with
`transformMode: "ts"` and once with `"rust"`.
Confidence: high — [evidence](../evidence/tstx-a-unfrozen-todo-verdict-decides-oppositely-per-path.md).
Read both predicates. `transform-postprocess-phase.ts:251` computes
`toolsMapUnavailable = frozen && !callable`, so `frozen === false` yields
`false` — available. `rust-mode-transform.ts:147` returns `false` unless
`frozen && callable`, so `frozen === false` yields `false` — unavailable. Opposite
verdicts from one input, verified by reading both expressions rather than by
inference.
Existing check: none comparing the two.
Impact: A first-pass todo pair is injected under the default renderer and
withheld under rust mode. It also makes the two paths' first served array differ
for reasons unrelated to rendering, which a differential must normalize away or
it will report this as noise on every fixture.
Open questions:
- Which polarity is intended? The rust side's is the conservative one, and the
  comment at `transform.ts:886-888` argues for conservatism ("must not replay a
  pair for a tool the model cannot call"). (needs human input)

### tstx-a-smart-drops-off-is-inert

Type: safety
Reachability: default-production — `smart_drops` defaults to `false`
(`magic-context.ts:958-960`), so the off path is what a default install runs.
Status: active
Exercised: partial — `supersession-reclaim.test.ts` and `tool-reclaim.test.ts`
cover the builders' on-behaviour, including the keep-3 rule
(`supersession-reclaim.test.ts:82`, `tool-reclaim.test.ts:42`). Neither asserts
the off-path equality.
Guarantee: With `smart_drops` off, the served messages are byte-identical to the
positional-only reclaim behaviour.
Check: `always` — for every pass, the set of pending operations applied with
`smartDrops: false` equals the set `buildSyntheticToolReclaimOps` alone produced,
and the served array is byte-identical to the same pass run without the feature
compiled in. `always` because `CONFIGURATION.md:763` states it unconditionally
("the entire feature is inert").
Fault/timing angle: none. This is a metamorphic relation over one config field.
Required faults and enabling state: none. Run one fixture twice, flipping
`smartDrops`, on a session with superseded `todowrite`, `ctx_reduce`, and repeated
edits to one file — the three classes the builders target.
Confidence: high — [evidence](../evidence/tstx-a-smart-drops-off-is-inert.md).
Read `transform-postprocess-phase.ts:1362-1392` and confirmed all three builders
and both dedupe loops are inside the single `if (args.smartDrops)`, so the off
path cannot contribute an op. This is the one relation where the TypeScript half
is structurally stronger than the Rust half; Part 4b's lens C records that the
byte-identity claim "has no Rust check".
Existing check: `supersession-reclaim.test.ts`, `tool-reclaim.test.ts`, both
`unaudited`, both on-path only.
Impact: If it fails, enabling a feature documented as inert-when-off changes
served bytes, which busts every user's prompt cache on upgrade.
Open questions: None.

### tstx-a-module-answers-with-a-delta-on-a-live-pass

Type: reachability
Reachability: explicit-config-only — the delta arm is
`rust-mode-transform.ts:1268-1289`, reached only under rust mode.
Status: active
Exercised: partial — `applyNativeMessagesVerbatim` is called directly with a
synthetic `previous` at `rust-mode-transform.test.ts:3298-3324` and the rejection
arm at `:3326-3340`. Neither reaches the function through `transform.run`: O26
confirms no module stub returns `native_messages_delta`.
Guarantee: A campaign exercises at least one pass in which the module answers
with a delta whose `after` matches the previously acknowledged output and whose
`replace_from` is strictly inside it, so the incremental splice runs against a
prefix the adapter itself produced.
Check: `sometimes` — at least once per campaign, a pass reaches `:1286-1289` with
`0 < replace_from < previous.messages.length` and a `previous` that came from a
real prior pass's `pendingWireCache.nativeOutput` (`:2649`) rather than a test
literal. `sometimes` and not `reachable`: the direct unit tests already give the
lines coverage, so location coverage is satisfied and tells us nothing. What is
absent is the operational *situation* — a live acknowledged prefix, a fingerprint
the adapter computed, and a partial replacement — which is exactly METHOD.md's
`sometimes` case.
Fault/timing angle: the delta requires state carried across two passes. `previous`
comes from `previousWireCache.nativeOutput` (`:2642-2647`, cache read at `:2040`,
promoted only on success at `:2857`), and `invalidateWireState` (`:1495-1501`) clears
it, so any wire-state invalidation between the two passes silently converts the
situation to a full send and the marker never fires. The guard's `after` check
(`:1276`) compares against `pendingWireCache.fingerprint`, which `:2276` builds from the
previous pass's **input** (`buildWireFingerprint(encodedInput)` and
`buildWireFingerprint(messages)`), while `previous.messages` is that pass's **output**.
So the guard proves input-generation agreement, not output-prefix agreement.
Required faults and enabling state: two consecutive successful rust-mode passes
against a stub that, on the second, returns a delta computed from the first
response's fingerprint. The stub must therefore read the fingerprint the adapter
sent, which no current test does.
Confidence: high — [evidence](../evidence/tstx-a-module-answers-with-a-delta-on-a-live-pass.md).
Read the delta arm, the cache write at `:2649`, the cache read at `:2642-2647`, and
confirmed by grep that both `native_messages_delta` occurrences in the test file are
direct calls. Refuted one failure scenario in the process: `wireCaches.set` is at
`:2857`, success-only, so a failed pass cannot poison the next pass's prefix. Replaced it
with the input-versus-output fingerprint provenance, which does not depend on an error
interleaving.
Existing check: `rust-mode-transform.test.ts:3298`, `:3326`, both `unaudited`,
both bypassing the pass.
Impact: The splice at `:1286-1289` reconstructs the served array from a prefix
the adapter believes is acknowledged. If the fingerprint accounting is wrong, the
served array silently contains a stale prefix, and the guard at `:1274-1284`
cannot catch it because it validates the module's claim against the adapter's own
possibly-wrong record. This is the highest-value situation in the part that no
test constructs.
Open questions: None.

### tstx-a-served-array-survives-a-rejected-response

Type: safety
Reachability: explicit-config-only — the ordering invariant is in the adapter
(O15).
Status: active
Exercised: partial — `rust-mode-transform.test.ts:1011` asserts
`output.messages).toBe(input)` and `output.messages[0]).toEqual(input[0])`
(`:1038-1039`) after a boundary rejection. That covers one rejection site.
Guarantee: When any validation rejects a module response, the caller's live
message array is still the original input, so a fail-open replay is possible.
Check: `always-or-unreached` — on every path that rejects a module response, the
caller's array is unmodified at the moment of rejection. `always-or-unreached`
rather than `always` because the rejection paths are optional: a campaign of
healthy passes never enters one, but every one that is entered must hold. That is
METHOD.md's definition exactly.
Fault/timing angle: the window is `:2639` to `:2754`, where
`replaceMessagesInPlace(output, appliedMessages)` finally replaces the caller's array.
Inside it the invariant rests on one non-obvious detail: `applyNativeMessagesVerbatim`
at `:2639` is passed a throwaway `{ messages: [] }` (`:2640`), not `output`, so its
internal `replaceMessagesInPlace` cannot touch the caller's array. Any future edit that
passes `output` there breaks the fail-open ladder at O16 steps 3 and 5 without breaking
a type.
Required faults and enabling state: one rejection at each of the six sites inside the
window — a non-object response (`:657-661`), an unparseable `native_messages` string
(`:1252-1258`), a parsed non-array (`:1261`), an absent `native_messages` with no
well-formed delta (`:1271`), a mismatched delta (`:1281-1284`), and a boundary failure
(`:652-654`) — each with a distinctive input array whose identity is then asserted.
`mirrorRustRenderedClaimState`'s throw (`:734`) is **not** in the set: its call at
`:2766` sits after the replacement and inside a catch that logs and swallows
(`:2765-2769`).
Confidence: high — [evidence](../evidence/tstx-a-served-array-survives-a-rejected-response.md).
Read `:2639-2648` and confirmed the throwaway target at `:2640`. Located the window's
close at `:2754` by grepping every `replaceMessagesInPlace(output, ...)` call. Read the
comment at `:2914-2915` that states the invariant, and confirmed the LKG and
raw-fallback arms at `:2916-2927` both depend on it: `serveRawFallback` serves
`messages` (`:1806`), which is the caller's array. Corrected the site count twice
during evidence writing, ending at six.
Existing check: `rust-mode-transform.test.ts:1011`, status `unaudited`, one site
of five.
Impact: If the array were already replaced at rejection time, the raw fallback
would serve the module's rejected output instead of the user's real history, and
the LKG replay would compute its entry snapshot from a corrupted base.
Open questions: None.

## Contract-vs-code leads

**L1. `transform.ts:818-820` says rust mode is "not a second implementation of
the TypeScript renderer".** True of the adapter, misleading about the part. The
second implementation is `mc-module/src/transform.rs` (12,468 production lines
per the scope map), and the adapter is the only seam through which either
renderer's output can be observed. A reader who takes this comment as the whole
story concludes there is no drift surface to test. Both sides cited; not resolved
in favour of the comment.

**L2. `transform.ts:878-879` and `:888` claim the tool-availability verdicts are
frozen per session and "can never flap mid-session".** Contradicted by
`ctx-reduce-availability.ts:91` (cap 1000) plus
`shared/bounded-session-map.ts:22` (LRU eviction) plus the re-resolution at
`ctx-reduce-availability.ts:148-152`. Record
`tstx-a-frozen-tool-verdict-is-evictable`.

**L3. `shared/bounded-session-map.ts:23-26` claims evicted values are
"recomputable from the messages array on the next pass, or reloadable from
SQLite".** True for the token and injection caches the docstring names, false for
a first-user-message verdict, which is not a function of the current array. The
map is sound; one consumer's use of it is not.

**L4. `CONFIGURATION.md:759` says smart drops keep "the newest 5" `ctx_reduce`
calls.** Both implementations say 3: `features/magic-context/reclaim-protection.ts:2`
and `crates/mc-module/src/selection.rs:38`. `magic-context.ts:963` also says 3.
So one documentation line disagrees with the other documentation line and with
both implementations. The unusual shape is worth noting: this is the one place in
the part where the two implementations agree and the contract is wrong.

**L5. `release-review-resolution.md:31-32` calls `transform_mode: "rust"` "an
undocumented dev-only flag", but it is a described field in the user-facing config
schema** (`magic-context.ts:672-677`, with a `.describe()` string). Whether that
counts as documented is a release-policy question, and it matters here because it
decides whether every `explicit-config-only` record in this part describes a
surface users can reach. Not resolved.

**L6. `messages-transform.ts:181-183` asserts all persistent mutations in the
inner transform are idempotent across passes**, and
`AUDIT-KNOWN-ISSUES.md:421-424` concedes the atomicity gap that claim stands in
for. The claim is the substitute for Part 4b's fenced commit and is unverified
across 22 write sites. Record
`tstx-a-typescript-pass-has-no-atomic-commit-point`; the enumeration is queued as
an open question there.

**L7. `transform-postprocess-phase.ts:368-370` justifies the `info` tolerance with
"Test doubles and older integrations may return the legacy bare message shape".**
A production tolerance introduced for test doubles, which the test doubles then
exercise instead of the body: 68 of 70 tests take the early return. Record
`tstx-a-shared-postprocess-skips-any-array-with-a-bare-message`.

**L8. `mirrorRustRenderedClaimState`'s all-or-nothing validation reads like a gate on
the module's response and is not one.** `:726-733` requires that
`rendered_revision_locators` and `memory_snapshot_vector` be present together and both
valid, throwing "module transform returned an invalid rendered-claim state" at `:734`.
But the call site at `:2766` wraps it in a catch that logs and swallows
(`:2765-2769`, "rust rendered-memory mirror write failed (ignored)"), and it sits after
the caller's array is replaced at `:2754`. So a response with a half-formed
rendered-claim state is served normally and silently skips the `session_meta` mirror
write at `:739-760`. Found while enumerating rejection sites for
`tstx-a-served-array-survives-a-rejected-response`; not made a record because whether
the swallow is correct depends on how a stale
`cached_m0_claim_snapshot_vector` is consumed, which is 5a's territory
(`storage-meta-persisted.ts`). Queued as a cross-part lead.

## Open questions

- **Should `boundary_id` be mandatory on a cache-busting pass?** The adapter has
  `cacheBustingPass` in scope at `:2669`, so requiring it costs nothing, and
  requiring it would convert `tstx-a-boundary-assert-is-module-triggered` from a
  gate-shaped property into a real invariant. (needs human input)

- **Which of the three synthetic predicates is canonical?** The encoder
  (`module-wire.ts:1413-1421`) is authoritative outbound, and Rust carries a
  redundant id-keyed repair for the one case it was known to miss
  (`transform.rs:2405-2422`). So the substantive question is the return leg: does the
  module mark synthetic messages on the wire? If it does, `assertNativeBoundary`
  should read that flag rather than re-derive from parts. That is a lookup in
  `mc-module`'s encode-back, not a design decision. (needs human input)

- **Is the `runRustModePostprocess`-before-`assertNativeBoundary` ordering
  deliberate?** The assert reads only the array, so hoisting it looks free from
  the source. If there is a reason it must run after the postprocess, the
  postprocess's writes need their own rollback. (needs human input)

- **How should `Exercised` be labelled for a cross-language pair?** The scope map
  raised this at `scope-map-and-risk-ranking.md:736-744` and left it open. This
  part needs it for the divergence table: `tstx-a-smart-drops-off-is-inert` is
  `partial` on the TypeScript side and has no Rust check at all, and
  `tstx-a-reserved-mc-id-namespace-is-unenforced-in-typescript` is the reverse.
  My reading matches the scope map's: green CI is evidence for the TypeScript path
  only. Still needs the ruling. (needs human input)

- **Does the TypeScript renderer have an `mc_`-collision to prevent?** Answering
  it needs `todo-view.ts` and `inject-compartments.ts`, both outside this file
  set. Unresolved, needs a 5b or later pass, or an explicit boundary read.

- **Is the `!rustModeTransform` fail-open at `transform.ts:823-825` dead?** O4
  shows both the mode check and the client derive from one condition in the
  shipped wiring, so it looks unreachable in production. It is not cataloged
  because "a defensive fallback is dead" is a deletion question rather than a
  property, and because proving it needs every `createTransform` call site, one of
  which (`hook.ts:1430-1436`) I read but did not trace to its dep construction.
  Unresolved, needs a `hook.ts` pass.

- **Should the mirror-pull `for (;;)` at `hook.ts:814-823` be cataloged
  somewhere?** It has the same uncounted shape as
  `tstx-a-ordinal-paging-loop-is-uncounted` and `hook.ts` is in no sub-part's file
  set. Flagged so it is not lost.
