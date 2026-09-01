# Part 4d fault-to-property map

For each property, what must actually occur for a test to be non-vacuous, and
whether the harness can produce it today.

Same rules as Parts 1 through 4c: safety checks must hold *while* their faults are
active; liveness checks need a bounded fault-free window; rare implementation
branches need deterministic injection to be reachable at all; and coverage checks
assert independent preconditions, never the violation.

Provenance as in [existing-checks.md](existing-checks.md). `HEAD` is `e447c927`.
The one CI step that matters moved across `76cd6f41..HEAD`:
`cargo test -p mc-module --test lifecycle_cli` is `ci.yml:168` at `76cd6f41` and
`ci.yml:172` at `HEAD`. Both were verified directly and both are cited.

Five framing points specific to this part.

**First, the dominant obstacle is not a missing fault.** No CI job executes any
test in this scope. The 102 in-crate checks and the 10 in `tests/prepared_output.rs`
run nowhere, and unlike 4c there is not even an integration binary that drives the
facade through a real `McHandler`: `direct_host.rs` contains zero 4d method
literals. The availability column below describes what a developer can construct
locally. Nothing in it is protected by automation.

**Second, this part is the cheapest in the catalog so far, and by a wide margin.**
Its scope is a request-shaped surface: a facade call, an argument map, a schema, a
response. **Most of this part's findings need no injected fault at all.**

**"No fault" was doing too much work, and the evaluation split it.** An earlier
version of this file said "fourteen of the 24 records need nothing beyond ordinary
state and one or two calls" and left it there. That single bucket hid real
orchestration cost, and the hidden cost differs by an order of magnitude across the
records inside it. It is now decomposed into four independent axes, recorded per
record in the map's own column rather than summarised here:

| Axis | What it measures | Why it is separate |
| --- | --- | --- |
| **Setup** | Bindings, registrations, seeded rows, and store state a test must establish before the first call | Two bound routes is a different fixture from one, and a seeded 21-tag session is different again. A record needing two bindings is not "no fault, one call" |
| **Call count** | How many facade requests the oracle needs, in order | One call, two sequential calls, and four sequential calls are three different test shapes. Sequencing is where the undercounting happened |
| **Store read** | Whether the oracle needs direct store access beyond the facade response | A response-only oracle is portable to any harness; a store read binds the test to the in-crate fixture |
| **Missing harness** | Whether any part of the record is unconstructible today | Exactly one record has this, and folding it into "no fault" made it look free |

Three corrections that motivated the split, each verified against the record it
concerns. **Route identity** needs **two bindings and three calls**, not one call:
two facade routes bound to different project roots, then `claim.intent.stage` on
route A, then `claim.intent.inspect` on route B, then `claim.intent.ack` on route B,
because the record's guarantee is about both the read and the transition.
**Dismissal** needs **four calls**: create the smart note, `dismiss` it, `read` it
back with `filter: "dismissed"`, then `update` it to confirm the refusal. An earlier
row said "three sequential facade calls" and omitted the create, which is the call
that establishes the pre-dismissal content the read half compares against.
**Full claim-effects composition** needs **the absent end-to-end harness**, and it
is now its own record rather than a clause inside the module-local one, precisely so
that the module-local half's genuine cheapness stops implying the composition is
cheap too.

**Third, exactly one capability is genuinely absent, and it is the cross-language
one.** There is no harness in which the real Rust module answers the real
TypeScript claim-effects producer. The module side has no test at all, the producer
is tested against a fake `deliver` closure, and the composition is checked nowhere
(see [existing-checks.md](existing-checks.md), the cross-language acknowledgement
section, and note that an earlier version of this framing point said "both halves
are tested against a fake of the other", which is false: nothing tests the Rust
half). No amount of in-crate work reaches that composition.

**Fourth, and this corrects a sibling part.** 4c's fault map states that the store
offers "no seam of any shape" that can fail a write
(`../part-4c-handlers/fault-map.md:33-47`, `:82`), and ranks that absence as its
only blocking capability. That claim is too strong. `execute_tag_sql_for_test`
(`crates/mc-store/src/lib.rs:6431-6439`) executes **caller-supplied SQL** through
`conn.execute_batch`, and the feature gating it is **already enabled for
`mc-module` tests**: `mc-store = { workspace = true, features = ["test-support"] }`
at `crates/mc-module/Cargo.toml:66-72`, specifically `:71`. 4c enumerated that seam
at `:6434` and described it as "narrow" — its doc comment does scope it to
trigger-backed cache invalidation — but `execute_batch` accepts any statement, so
an `AFTER INSERT ... RAISE(ABORT)` trigger on any table is installable from a
module test today, and it fails the next write to that table from inside the store
transaction. **Store-failure-beneath-an-acknowledgement is therefore implementable
today in this part.** Two caveats, stated rather than glossed: whether an aborting
trigger surfaces as the exact `McStoreError` variant a given handler matches on is
a per-site question, and the trigger has to be installed against the same
connection pool the handler uses. Neither is a missing capability. **Do not repeat
4c's claim.**

**Fifth, the sharpest record in the part needs the least, and its other half needs
what does not exist.** No test on either side of the language boundary covers
`claim.effects.apply`. The module-side obligation, that an accepted ack corresponds
to some durable module effect or to a non-advancing code, is one call plus a
before-and-after store read. The composition with the producer's checkpoint is the
part's only unconstructible record. The two are now separate records for exactly
that reason.

## Fault classes required

`F0` is listed first because it is the cheapest capability in this part and it is
not a fault at all. `F1` and `F2` are split because their records differ, even
though their cost is identical and both are zero.

| Class | Description | Available today |
| --- | --- | --- |
| **F0** test execution in CI | Any workflow job that builds and runs `mc-module --lib`, or that runs the `prepared_output` integration binary | **No.** Verified across all five files in `.github/workflows/`. The only `mc-module` test invocation is `cargo test -p mc-module --test lifecycle_cli` (`ci.yml:168` at `76cd6f41`, `:172` at `HEAD`), which selects one integration binary and does not build `--lib`, so neither the 102 in-crate checks nor `prepared_output.rs` compiles. The step above it is build-only (`:165` / `:169`). There is no `--lib`, no `nextest -p mc-module`, and no `--workspace` test job. `scripts/test-rust.sh` (`cargo nextest run --workspace`) is wired into root `package.json` and no workflow calls it. This costs a workflow change and no new infrastructure |
| **F1** unknown-key and malformed-argument injection, per strictness tier | The same request sent with one extra or misspelled key, once per strictness tier, so each tier's actual behaviour on an unrecognised key is observed rather than assumed | **Yes, and it needs no fault.** One request per tier, and all three tiers are reachable from a facade call. Tier 1, open map clone: `facade_arguments` (`lib.rs:14419-14435`) clones the argument map with no key walk for all five `ctx_*` tools, and their advertised schemas set `additionalProperties: true` (`:15846`, `:15929`, `:15950`, `:15963`), so an unknown key is silently ignored. Tier 2, typed decode with `deny_unknown_fields`: the claim wire structs (`mc-core/src/claim_operation.rs:313,352,360,406,417,438,450,460,468,475`) and the two mirror request structs (`lib.rs:140`, `:147`). Tier 3, runtime closed schema: `note_evaluation_body` (`:13885-13905`) walks every key and rejects with `"unknown field '{key}'"` (`:13897`) and requires `v == 2` (`:13902`). The malformed-argument half is already precedented: `facade_never_panics_on_malformed_memory_arguments` (`:25713`) |
| **F2** forcing a success-shaped error path and observing what a caller can distinguish | Driving each of the six paths that deliver a failure inside a transport success, then asserting what a caller could use to tell it from a hit | **Yes for five of six with no fault; the sixth needs F3.** The five: `ctx_reduce`'s acknowledgement (`:10587`) is one call; `claim.effects.apply`'s ack (`:10253`) is one call plus a store read; `ctx_expand`'s two unrecoverable-content answers (`:10804-10809`, `:10832-10838`) need only an out-of-range ordinal or a session with no compacted compartments; the `isError`-inside-transport-success shape is observed by asserting `health()` (`:12003-12046`) stays `Ok` across a failing facade call. The dismiss-not-found ledger arm (`:11902-11907`) is also free: send `dismiss` for an absent note id carrying a `command_id`. Only the note-CAS-conflict arm (`:11865-11870`) needs contention or F3 |
| **F3** store failure beneath an acknowledging handler | An aborting store write landing under a handler that has already produced, or will produce, a success-shaped response | **Yes, via the arbitrary-SQL seam, and this is the correction above.** `execute_tag_sql_for_test` (`mc-store/src/lib.rs:6431-6439`) runs arbitrary SQL via `execute_batch`, enabled for module tests at `crates/mc-module/Cargo.toml:66-72`. An `AFTER INSERT ... RAISE(ABORT)` trigger fails the next write to the targeted table from inside the store transaction. This is what makes the digest-conflict-versus-store-fault indistinguishability record provable, because it produces the second cause the record needs to compare against. Per-site caveats in framing point four |
| **F4** process timezone variation | Two module processes whose `chrono::Local` resolves to different zones, so the same `(pre, outcome, note_id, now)` produces different durable schedule state | **Partial, and the split matters.** The *reducer differential* is free and needs no fault: `reduce_smart_note_evaluation` takes the zone as a parameter, production passes `&chrono::Local` at `lib.rs:14244`, and `chrono-tz` is already a `[dev-dependencies]` entry (`crates/mc-module/Cargo.toml:67`), so a test passes two zones and compares. The *host-dependence* half is what F4 names, and it is a property of the production call site rather than the reducer: it needs two processes under different `TZ`, which is available by running the same fixture twice, but whether `chrono::Local` re-reads `TZ` within one process was not established and `std::env::set_var` is `unsafe`. This is the class that makes the host-dependence record non-vacuous, and it is the only one in the part with an unresolved mechanism |
| **F5** caller-driven unbounded note growth | Enough conditioned `ctx_note` writes, with no evaluator draining them, that the pending candidate set grows without bound and every poll materializes all of it | **Yes, and it needs no fault.** Repeated `ctx_note` writes with a `surface_condition`, each landing as `status = 'pending'`. Verified there is no count cap in `insert_note` (`mc-store/src/lib.rs:10130-10164`) or `insert_project_note` (`:10166-10200`), and the candidate query has no `LIMIT` (`:13291-13301`). The oracle is directly observable: `smart_note_selection_snapshot` clones three vectors, so returned row count grows with the pending count |
| **F6** cursor exhaustion in a `Full`-mode slot cycle | A slot cursor advanced past at least one phase, then work newly eligible in a skipped phase, then one more poll on that slot | **Yes, and it needs no fault.** Request sequencing only. Advance the cursor with one acquisition, seed work into a skipped phase, poll again. The mechanism is documented in the code the record cites (`smart_note_evaluation.rs:864-868`, "Phases before it are passed for this" cycle), and the store persists the distinction (`mc-store/src/lib.rs:13322-13326`). The one-poll-wide window (`lib.rs:11258-11265` resets immediately) is the reason a campaign that polls once per drain never sees it, not a reason it is hard to construct |
| **F7** cross-language differential against the real TypeScript producer | The real Rust module answering the real TypeScript claim-effects producer, so a real ack advances a real durable checkpoint | **No, and nothing in this crate can supply it.** The three parts are asymmetric and an earlier version of this row flattened them into "both halves are tested against a fake of the other", which is wrong. (a) The Rust half has **no test at all**: `claim_effects` has two occurrences, both production, and zero in the test modules. (b) The producer's drain is CI-tested against an inline fake `deliver` closure at `module-state-sync.test.ts:1405-1415`, returning the required ack at `:1414`. (c) The composition is tested nowhere, and there is no facade end-to-end harness to extend: `direct_host.rs` has zero 4d method literals. Two sites previously cited in this row, `module-wire.test.ts:345` and `module-state-sync.test.ts:1510`, are claim-**mirror** tests (`decodeClaimMirrorReceiptResponse` and `class DeterministicClaimMirrorFacade` at `:1444`), not claim-effects coverage; `decodeClaimEffectDeliveryResponse` (`module-wire.ts:717`) has zero test references in `packages/plugin`. The same class covers the shared smart-note fixture, where the TypeScript replay iterates `transition_cases` only (`evaluation-state.test.ts:105`) and 25 of the fixture's 48 cases are pinned by a Rust replay that runs nowhere. Building the claim-effects harness is new infrastructure; extending the TypeScript fixture replay is a one-line loop |

Two availability caveats that cut across classes. The `drive-fault` cluster is
`explicit-config-only` — 8 tests at `:18965-19113` behind a feature Cargo.toml
warns must never reach a default set (`crates/mc-module/Cargo.toml:60-62`) — so
nothing there is a general capability. And the mutation ledger retains only the
newest 512 commands per identity scope (`mc-store/src/lib.rs:5042-5046`), which
bounds every replay-based oracle in this part: a retry must land inside that
horizon.

## Map

All 25 records: twelve from lens A, twelve from lens B, and one split off lens A's
claim-effects record by the independent evaluation. "Non-vacuous today" means a
developer can construct the required state with the current harness. It does **not**
mean the check runs anywhere; under F0 none of them do.

Every row carries an **Orchestration** column, in place of the single "no fault"
verdict an earlier version used. It reads `setup · calls · store read · harness` and
is the decomposition framing point two describes: what state must exist before the
first request, how many requests the oracle needs, whether the oracle reaches past
the response into the store, and whether any part of it is unconstructible. A row
that says `none · 1 · no · present` is genuinely free. A row that says
`2 bindings · 3 · no · present` is not, and reading both as "no fault" is what hid
the difference.

One reachability precondition is stated once rather than per row. Every facade
handler cited is reached from `handle_facade_value` (`lib.rs:10042-10060`), whose
`match name` at `:10046` routes eleven names and carries no `#[cfg]` attribute. No
handler in scope sits behind a feature gate; the only feature-gated tests in the
part are the 8 `drive-fault` cases.

### Facade surface: validation, argument sourcing, and byte caps

| Property | Required faults and enabling state | Orchestration (setup · calls · store read · harness) | Non-vacuous today |
| --- | --- | --- | --- |
| facade-a-transform-class-byte-cap-probe-diverges-from-the-router | A body **between 1 MiB and 32 MiB** carrying `method: "transform"` without `kind`, or `kind: "state_sync"` without `method`. No fault: pure input classification | none · 1 · no · present | **Yes.** One request in the 1-to-32-MiB band. `is_transform_class` (`:14298-14304`) reads `kind` for transform and `method` for state_sync while the router accepts either field, so the disagreement is a request-shaping fact. The band matters: above `MAX_TRANSFORM_FRAME_BYTES` the cap refuses a transform-class body by design (`:14382-14388`), so a test sending a 40 MiB body observes correct behaviour, not the disagreement. `:25299` already covers field precedence in the router; nothing covers the cap probe's disagreement with it |
| facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic | **None.** Any facade call with a spare key (F1, tier 1) | none, **or two cloned stores if the tool mutates** · 2 · no · present | **Yes, and on a read-only tool it is one of the two cheapest oracles in the part.** `facade_arguments` (`:14419-14435`) clones with no key walk and all four advertised schemas set `additionalProperties: true`. One constraint corrected: the two calls being compared cannot be sequential invocations against one store on a mutating tool, because `insert_note` mints a new row id into the response text (`:11690-11705`) and a `command_id` replay adds `"replayed": true` (`:15303-15306`). Use two cloned stores or compare the argument maps `facade_arguments` returns. `:25531` asserts the advertised schema is open; nothing asserts the handler's accepted key set |
| facade-a-misspelled-surface-condition-silently-writes-a-plain-note | A `ctx_note` write carrying `surfaceCondition` (or a similar near-miss) with non-empty `content`, and `has_live_note_evaluator(project, now)` false. No fault | project with no live evaluator (the default) · 1 · optional · present | **Yes.** One request plus a project with no live evaluator, which is the default state. The mechanism is F1 tier 1 meeting the fail-closed gate at `:11618`: a correctly named key with no evaluator is refused, a misspelled one is ignored and the note is written plain. The enabling state is what makes it sharp — the two outcomes diverge only when no evaluator is live. Note this record asks for a **diagnostic** where the open-key record asks for silence; the two are opposite polarities split on edit distance to a read key |
| facade-a-reduced-summary-envelope-is-an-unvalidated-argument-source | `arguments.reduced == true`, no primary field of that tool present, and `arguments.summary` a string that parses to a JSON object. No fault | none, or two cloned stores if compared through a mutating tool · 2 · no · present | **Yes.** Request shaping only, and the branch is a `let`-guarded path at `:14421-14434`. The cheapest valid form is a parser-level comparison of the two argument maps, which avoids the mutating-call problem entirely. Note the asymmetry the existing check creates: `:25333` pins the **non**-unwrap half, so the record's `Exercised: not yet` is right and its nearest check is a sibling branch rather than a gap |
| facade-a-facade-error-text-carries-absolute-route-paths-to-the-model | A route whose authority-managed project differs from its `route_project_root`, then any `ctx_note` mutation or a `memory_project` argument that disagrees. No fault | 1 route bound with a divergent authority project · 1 · no · present | **Yes.** Two-part route state plus one request. `resolve_facade_scope` rejects a disagreeing `memory_project` at `:10446-10454` and formats the route path into the returned message. The contrast is the evidence: `sanitize_status_text` (`:15423-15441`) exists and strips paths on the status surface, and the facade error path does not use it |
| facade-a-measured-length-must-equal-written-body-or-nothing-is-terminal | A prepared source whose measured and written lengths differ. Production has no such source, so a seam is required | one `inconsistent_for_test` segment · 0 facade calls, direct `dispatch` use · no · present | **Yes, and the seam already exists and is already used.** `PreparedSegment::inconsistent_for_test` (`dispatch.rs:64-71`) is that seam, consumed by `prepared_output.rs:254`. This is the best-covered claim in the sub-part, with all 10 integration tests on its family. What F0 removes is not the check but its execution |

### Facade surface: the acknowledging handlers and the mutation ledger

| Property | Required faults and enabling state | Orchestration (setup · calls · store read · harness) | Non-vacuous today |
| --- | --- | --- | --- |
| facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes | A `ctx_reduce` call with at least one queueable tag, followed by a dropped or never-issued `agent_drops.append` (F2) | seeded tag session · 1 · yes · present | **Yes.** One call plus a store read. The handler performs only reads (`load_tags_for_session` `:10513`, `load_pending_agent_drops` `:10517`) and answers `mcp_text_result(format!("Queued: {}.", ...), false)` at `:10587`. `:25445` already asserts the no-write behaviour, so what the record adds is the caller-visible half. **The record's oracle was replaced:** the earlier two-sided bound `0 <= 0 <= reported` is satisfied by the permanent-gap case it was written to catch, because this handler attempts no effect for the bound to constrain. The oracle is now a statement about what the response discloses |
| facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect | **None beyond the shipped drain path.** Module-local only | none · 1 · yes, before and after · present | **Yes.** One call plus a before-and-after store read: `handle_claim_effects_apply` (`:10184-10255`) never calls `self.store()` and returns `"ackedEffectId": previous` (`:10253`). This row was previously `Partial` because it carried the composition too; the composition is now the row below, and the module-local half on its own is fully constructible. One check-hygiene correction: the earlier precondition "no module store write occurred during the call" is the alleged violation and cannot be a coverage precondition, so the legal one is `CLAIM_EFFECTS_APPLY_ACCEPTED_A_RECEIPT` alone |
| facade-a-claim-effects-ack-and-producer-checkpoint-advance-are-never-composed | **A harness that does not exist** (F7): a real `McHandler` answering the real TypeScript drain over the real transport | a cross-language process pair · at least 1 delivery · yes, in the producer's database · **absent** | **No. This is the part's only record blocked outright,** and splitting it out is what makes that visible. `direct_host.rs` has zero 4d method literals, so there is nothing to extend. The blast radius is bounded on the far side and that bound is tested: `advanceOutboxConsumerCheckpointInCurrentTransaction` rejects a regression (`storage-claim-operations.ts:2222-2224`) and an id beyond the outbox tail (`:2241-2243`), so a module ack can skip effects the producer wrote but cannot invent ones it did not, and `storage-claim-operations.test.ts:852-1077` covers those guards under `ci.yml:257` |
| facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity | Two facade routes bound to different project roots in one module process, and a `binding` in the request naming the other route's authority project and generation. No fault | **2 bindings** · **3** · no · present | **Yes, but not as cheaply as an earlier row implied.** That row said "two bound routes and one request"; the record's guarantee covers both a read and a transition, so the sequence is `claim.intent.stage` on route A, `claim.intent.inspect` on route B, then `claim.intent.ack` on route B. `claim_route_root`'s result is discarded at `:10120-10122` and `:10154-10156` while `handle_claim_intent_stage` passes it to the store at `:10100`, so the oracle is a comparison between handlers in the same file. The store side has coverage (`crates/mc-store/tests/claim_intent_ledger.rs`); the module-side discard has none |
| facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault | A second `claim.intent.stage` reusing `(producer, operation_key)` with a body that hashes differently, **plus** a genuine store failure on the same handler, so the two causes can be compared (F3) | aborting trigger installed via F3 · 3 · no · present | **Yes, and F3 is what makes it so.** The conflict half is two sequential calls with no fault. The comparison half needs a third call against a store failure producing the same code, and an aborting trigger through `execute_tag_sql_for_test` supplies it. Without F3 the record degrades to "one cause exists" rather than "two causes are indistinguishable", which is a weaker claim than the record makes. The mechanism is `claim_intent_stage_failed` collapsing every `Err` |
| facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes | A `ctx_note` `update` with a `command_id` that loses a note CAS race, **or** a `dismiss` for a note id that is momentarily absent, then a retry with the same `command_id` | none for the dismiss arm; contention or F3 for the CAS arm · 2 · optional · present | **Yes, via the dismiss arm, with no fault.** Both arms return `Ok(facade_text_response(..., true))` from inside the ledger closure (`:11865-11870`, `:11902-11907`), and `Ok` is the ledger's commit signal, so the failure text becomes the memoized outcome. The dismiss-not-found arm needs only an absent note id; the CAS arm needs contention or F3. The retry must land inside the 512-command horizon (`mc-store/src/lib.rs:5042-5046`) |
| facade-a-replayed-facade-mutation-occurs-in-a-campaign | A `ctx_note` mutation carrying a `command_id` that commits, then the same `command_id` re-sent inside the 512-command retention horizon | none · 2 · no · present | **Yes.** Two sequential calls. `:23243` already constructs one of the three causes end to end, expiring every evaluator registration by hand at `:23265-23272` and re-sending, so the pattern is established. The lost-response and module-restart causes are uncovered. See the compliance review for one refinement on the marker |

### Note evaluation: the reducer and the durable schedule

| Property | Required faults and enabling state | Orchestration (setup · calls · store read · harness) | Non-vacuous today |
| --- | --- | --- | --- |
| note-b-reducer-reads-process-local-timezone-for-durable-schedule | A smart note with a non-trivial `check_cron`, a `compiled_false` or `due false` outcome, and two module processes whose `chrono::Local` resolves differently (F4) | seeded note plus **two processes under different `TZ`** · 1 per process · yes · present but awkward | **Partial, and it is the only mechanism-blocked record in the part.** The reducer differential is free — the zone is a parameter, production passes `&chrono::Local` at `:14244`, and `chrono-tz` is a dev-dependency (`Cargo.toml:67`) — but it proves nothing, because the reducer is documented to take a zone (`smart_note_evaluation.rs:8-10`, including the parenthetical "production passes the machine-local zone"). The record is a call-site portability decision, not a purity violation, so the only observation that reaches it is two processes under different `TZ`, and whether `chrono::Local` re-reads `TZ` within one process is unresolved. Two `cargo test` invocations under different `TZ` is the honest form |
| note-b-selection-is-invariant-under-candidate-permutation | At least two notes eligible for the same phase whose primary sort key ties, so the `id` tiebreak is the only thing deciding. No fault | 2 seeded notes · 0 facade calls, pure selector · no · present | **Yes.** Two seeded notes. All four `sort_by_key` calls end in `note.id` (`smart_note_evaluation.rs:728`, `:752`, `:780`, `:797-803`) and the store feeds `ORDER BY id`, so the property is provable in the pure selector, which the normative cycle traces already exercise |
| note-b-check-failure-count-carries-across-compile-and-check-phases | A compiled note whose check returns `logic_failed` three times, reaching `check_status == "failing"` with `check_failure_count == 3`, then a compile-phase claim whose outcome is `compilation_failed`. No fault | 1 compiled note · **8** (four claim-and-complete pairs) · yes · present | **Yes.** Four sequenced completions, all supplied over the wire, which is eight requests if each completion needs its own claim. `reduce_check_failure` increments the shared column (`smart_note_evaluation.rs:525-531`) and the `failing` status feeds the compile phase, so the carry-over is a sequencing fact. No fixture case drives it today, which is why the record exists |
| note-b-fallback-phase-writes-no-durable-backoff | One smart note in `check_status == "fallback"` whose fallback evaluations return **`False`**, and an evaluator polling `note.evaluation.next` in a loop. **No fault is required** | 1 seeded fallback note · a poll loop · yes · present | **Yes.** One seeded note and a poll loop. `reduce_fallback`'s `False` arm (`smart_note_evaluation.rs:647-656`) writes only `last_checked_at`, `updated_at` and `check_status`, and `get_fallback_smart_notes` has no due-time filter, so a spin is the natural consequence rather than an injected one. **The `False` restriction is required for validity:** the `Met` arm (`:637-646`) calls `ready_fields`, so the note leaves `pending` and the candidate query (`mc-store:13293`) never offers it again. A completion that cannot repeat needs no backoff, so a check over "any fallback completion" fails against correct code |
| note-b-liveness-network-failure-burns-the-window-with-no-durable-record | A compiled note false for at least 7 days and outside the 24-hour spacing, claimed for `liveness`, whose sandbox check cannot reach the network | seeded timestamps on 1 note · 2 (claim, complete) · yes · present | **Yes, with no real network fault.** The outcome is caller-supplied on the wire, so a test sends `network_failed`. The enabling state is seeded timestamps. `reduce_liveness` stamps `check_last_liveness_at = now` before matching (`:591-593`) and the `NetworkFailed` arm returns that state unmodified (`:623-626`), so the window is consumed by the stamp and no record of the failure survives |
| note-b-completion-applies-only-under-the-claimed-revision-and-state-version | An outstanding claim on a note, plus a concurrent facade mutation of that note. **No injected fault is needed** | 1 pending note · 3 (claim, interleaved `ctx_note` mutation, complete) · yes · present | **Yes.** Three requests with the mutation interleaved between claim and completion. The fence is at `mc-store/src/lib.rs:13569-13573` with the `stale` terminal at `:13552-13561`, and the four `fence_active_note_claims_tx` call sites sit on the mutation paths. The module side asserts only the phase, which is the gap. `smart_note_revision_matrix_normative_matches_mc_store` covers the matrix, not the interleaving |

### Note evaluation: registration policy, growth, and observability

| Property | Required faults and enabling state | Orchestration (setup · calls · store read · harness) | Non-vacuous today |
| --- | --- | --- | --- |
| note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll | A model or client repeatedly calling `ctx_note` with a `surface_condition` and no evaluator draining them, so each write lands as `status = 'pending'` and stays there (F5) | none · **N writes at two sizes, plus 2 polls** · yes · present | **Yes, and it needs no fault.** The oracle changed shape and the call count with it. There is no declared per-poll constant to assert against — the candidate query has no `LIMIT` (`mc-store:13291-13301`) and neither insert path counts rows — so a check against a constant is unfalsifiable. The record now asserts a **scaling relation**: seed N and 2N pending notes into two identically prepared projects, poll each, and assert rows returned and snapshots built are N and 2N. That needs two seeded sets rather than one. `smart_note_selection_snapshot` clones three vectors, so returned row count is a direct oracle. Cost is the write volume, not a capability |
| note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration | Two `note.evaluation.register` calls for the same authority project, from the same or different routes, with different `retina_handoff` or `wake_owned`. No fault | 2 registrations · 3 (two registers, one `next`) · no · present | **Yes.** `live_note_evaluator_policy` (`:3889-3906`) accumulates with `\|=` over every live entry, its one call site is `:11166`, and the per-registration fields are read nowhere else, so two registrations and one acquisition settle it |
| note-b-registered-policy-version-never-reaches-selection | Two registrations with different `policy_version` values, both non-negative, against a project holding notes at `policy_version` 0 and 1. No fault | 2 registrations plus seeded notes at two policy versions · 4 · no · present | **Yes.** The field is validated at `:10916-10919`, stored at `:10964`, bumped at `:11045`, echoed at `:11050`, and read nowhere else; selection compares the *note's* version. The oracle is that changing the registered value changes nothing observable. The record's earlier check also demanded that this "is the documented contract", which is not a runtime state and has been moved to an open question |
| note-b-excluded-note-is-not-reportable-by-any-surface | A non-empty pending set in which every note is excluded by a phase predicate, a quarantine, a future `check_next_due_at`, or the `attempted_fallback` list, plus one `note.evaluation.next` poll. No fault | fully-excluded pending set · 1 · yes · present | **Yes.** Seeded state plus one poll. The absence is verified rather than assumed: zero `tracing`, `log`, `warn!`, `debug!`, `info!`, `error!` or `trace!` calls anywhere in `smart_note_evaluation.rs`. The oracle is that a `no_work` response and a fully-excluded set are indistinguishable from outside |
| note-b-dismissed-note-is-readable-but-never-returns-to-evaluation | A smart note in `pending` or `ready`, a `ctx_note dismiss`, then a `ctx_note read` with `filter: "dismissed"` and a `ctx_note update` on the same id. No fault | none · **4** · no · present | **Yes, and the whole property is observable through the facade with no store access.** An earlier row said "three sequential facade calls" and undercounted by one: the create is a call too, and it is the one that establishes the pre-dismissal content the read half compares against, so the sequence is create, dismiss, read, update. `dismiss_note` UPDATEs and never DELETEs and appends rather than replaces the resolution, and the dismissed status is a readable filter (`lib.rs:11721`) |
| note-b-cursor-exhausted-no-work-occurs-in-a-campaign | A `Full`-mode slot cursor advanced past at least one phase (`phase_index > 0`), with work newly eligible in a skipped phase, or the fallback quota spent with fallback notes remaining, then one more `note.evaluation.next` on that slot (F6) | 1 registration plus seeded work in a skipped phase · 3 or more · no · present | **Yes.** Request sequencing only. The cursor is spent at the moment of the poll and reset immediately afterwards (`:11258-11265`), which is why a campaign polling once per drain never sees it, not why it is hard to build. The record now names its marker, `NOTE_CYCLE_EXHAUSTED_NO_WORK_OBSERVED`, which the compliance review below had asked for. `smart_note_cycle_traces_normative_matches_selection_policy` (`smart_note_evaluation.rs:1765`) covers the pure selector's exhaustion, not the durable classification or the response |

**Totals: 23 non-vacuous today, 1 partial, 1 blocked outright.**

Against 22 / 2 / 0 before this disposition. Two rows moved and one is new. The
claim-effects row moved from `Partial` to `Yes` because the half that was not
constructible is no longer inside it, and the half that is left is one call plus a
before-and-after store read. The composition became its own record and is the
part's one outright block, which is a more honest presentation than a `Partial`
that let a reader believe the whole record was half-done. Net record count 24 to
25, and the availability picture is neither better nor worse than before; it is
stated at the right granularity.

That distribution is still the most favourable in the catalog, and the reason is
worth naming precisely rather than celebrating. Part 4c had three records blocked on
one missing store seam. This part has one, and it is not a seam but a harness that
would span two languages, partly because the seam 4c wanted turns out to exist in a
wider form than 4c recorded (framing point four), and mostly because 4d's surface is
request-shaped: an argument map, a schema, a response envelope. The one remaining
`Partial` is a mechanism question about `chrono::Local` and `TZ`, on a record whose
subject is now a call-site decision rather than a purity violation. **The binding
constraint here is F0, not any fault class.** Twenty-three constructible records
against a suite no automation executes is a worse position than fewer records under
a running gate.

**One thing the orchestration column changes about how to read this section.**
Twenty-three rows saying `Yes` looked, in the earlier version, like twenty-three
comparably cheap tests. They are not. The cheapest are `none · 1 · no · present`.
The most expensive constructible ones are `2 bindings · 3`, `none · 4`, and
`1 compiled note · 8`, and one needs `N writes at two sizes`. Cheapness is still
this part's defining property; it is just not uniform, and the leverage ranking
below is ordered by the decomposed cost rather than by the single verdict.

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies, so
it fires without a defect present. Names are constants, globally unique, and never
constructed dynamically. Markers duplicating the two existing `sometimes` records
are deliberately absent.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `FACADE_OPEN_SCHEMA_TOOL_RECEIVED_AN_UNKNOWN_KEY` | A `ctx_*` call whose argument map carried a key outside the advertised property set **and outside one edit of any key the handler reads**, cloned through `facade_arguments` (`:14419-14435`) | Legal and deliberate: all four schemas set `additionalProperties: true`, and `:25531` asserts that openness. It is a fact about the input, not about the outcome. The edit-distance clause keeps it disjoint from `CTX_NOTE_WRITE_CARRIED_A_CONDITION_KEY_THE_HANDLER_DID_NOT_READ` below, which witnesses the opposite polarity: there, silence is the defect |
| `NOTE_EVALUATION_CLOSED_SCHEMA_REJECTED_AN_UNKNOWN_KEY` | `note_evaluation_body` returned `"unknown field '{key}'"` at `:13897` | Legal and is the decoder's purpose. Witnessing the strict tier alongside the open one is what makes the tier comparison checkable |
| `CLAIM_WIRE_TYPED_DECODE_REJECTED_AN_UNKNOWN_FIELD` | A claim handler's `serde_json::from_value` failed on `deny_unknown_fields` | Legal; the derive exists for it. The third tier, so all three are witnessed independently |
| `CTX_NOTE_WRITE_CARRIED_A_CONDITION_KEY_THE_HANDLER_DID_NOT_READ` | A `ctx_note` write whose arguments contained a key differing from `surface_condition` only by case or separator, and whose `string_arg("surface_condition")` returned `None` | An input-domain fact, legal to observe, and it does not assert that a plain note was written. The independent precondition of the near-miss record |
| `CTX_NOTE_WRITE_RAN_WITH_NO_LIVE_EVALUATOR` | `has_live_note_evaluator(project, now)` false at `:11618` on a write pass | Legal and is the default state of any project with no registered evaluator. Pairing it with the marker above is what distinguishes the two divergent outcomes without asserting either |
| `FACADE_REDUCED_ENVELOPE_BECAME_THE_ARGUMENT_MAP` | The branch at `:14421-14434` taken, so `arguments.summary` parsed to an object and supplied the arguments | Legal: the branch is deliberate code with its own guards. The precondition of the unvalidated-source record, and it does not assert the resulting arguments were wrong |
| `FACADE_BYTE_CAP_CLASSIFIED_A_BODY_AS_TRANSFORM_CLASS` | `is_transform_class` (`:14298-14304`) returned true for a body over `MAX_FACADE_FRAME_BYTES` | Legal and is the ordinary shape of every large transform request. The precondition of the probe-versus-router record, stated without asserting a disagreement |
| `FACADE_ROUTER_SELECTED_AN_ARM_FROM_THE_OTHER_ENVELOPE_FIELD` | The `match name` at `:10046` resolved through `kind` where `method` was absent, or the reverse | A structural fact about field precedence, true today with fully correct behaviour. `:25299` already asserts the precedence; this records which side the campaign took |
| `FACADE_RESPONSE_CARRIED_IS_ERROR_INSIDE_A_TRANSPORT_SUCCESS` | A `PreparedOutcome::Response` whose body had `isError: true` | Legal and is how every facade failure is delivered. The independent precondition of the success-shaped-path family, asserted without claiming the caller was misled |
| `MODULE_HEALTH_REPORTED_OK_WHILE_A_FACADE_CALL_FAILED` | `health()` (`:12003-12046`) returned `HealthStatus::Ok` on a pass where the marker above also fired | Legal by design: the facade never takes a dispatch ticket, so `consecutive_errors` cannot degrade. Two independent facts, neither a violation |
| `CTX_REDUCE_ACKNOWLEDGED_WITHOUT_A_STORE_WRITE` | `:10587` reached after only the two reads at `:10513` and `:10517` | Legal and stated in the code's own comment at `:10585-10586`. `:25445` already asserts it; the marker records that the campaign took the path |
| `CLAIM_EFFECTS_APPLY_ACCEPTED_A_RECEIPT` | `handle_claim_effects_apply` reached `:10253` and returned an `ackedEffectId` | Legal on every accepted delivery. The precondition of the checkpoint record, and it does not assert the checkpoint advanced wrongly |
| `CLAIM_HANDLER_RESOLVED_A_ROUTE_ROOT_IT_DID_NOT_USE` | `claim_route_root` returned `Ok` at `:10120-10122`, `:10154-10156` or `:10185-10187` and the value went out of scope | A structural fact about three call sites, true today. The precondition of the discarded-identity record, stated as a location fact rather than a trust violation |
| `CLAIM_INTENT_STAGE_REUSED_AN_OPERATION_KEY` | A second `claim.intent.stage` carrying a `(producer, operation_key)` already present | Legal input: reuse with an identical body is the idempotent case. The precondition of the digest-conflict record, without asserting which code came back |
| `CLAIM_INTENT_HANDLER_COLLAPSED_AN_ERR_INTO_ITS_SINGLE_CODE` | Any `Err` on a claim-intent handler surfaced as `claim_intent_stage_failed`, `claim_intent_inspect_failed` or `claim_intent_ack_failed` | Legal: one code per handler is the shipped design. Pairing this with the marker above is how indistinguishability becomes checkable without inducing the defect |
| `LEDGER_CLOSURE_RETURNED_OK_CARRYING_AN_ERROR_TEXT` | `:11865-11870` or `:11902-11907` returned `Ok(facade_text_response(..., true))` from inside the ledger closure | Legal as written and is the arm the record questions. It asserts the return shape, not that the memoization was wrong |
| `PREPARED_OUTPUT_MEASURED_AND_WROTE_EQUAL_LENGTHS` | `write_to` compared `written == self.len` and returned the terminal | The ordinary success path of every reply. The precondition that makes the mismatch arm's absence meaningful |
| `EXPAND_ANSWERED_AN_UNRECOVERABLE_REQUEST_WITH_IS_ERROR_FALSE` | `:10804-10809` or `:10832-10838` reached | Legal: an out-of-range ordinal is legal input. An observation about the classification, not a claim that the caller was harmed |
| `SMART_NOTE_REDUCER_RAN_WITH_A_NON_LOCAL_ZONE` | `reduce_smart_note_evaluation` called with a zone other than `chrono::Local` | Legal: the zone is a parameter. The precondition of the host-dependence record, and it records that the campaign varied the zone at all rather than asserting a divergence |
| `SMART_NOTE_SELECTION_TIEBREAK_DECIDED_THE_WINNER` | Two candidates in one phase whose primary sort key tied, so `note.id` decided | Legal and is what the tiebreak exists for. The precondition of the permutation-invariance record |
| `SMART_NOTE_CHECK_FAILURE_COUNT_WAS_NONZERO_ENTERING_COMPILE` | A note entering the compile phase whose `check_failure_count` was already positive | Legal: the column is shared by construction. The precondition of the carry-over record, without asserting a wrong backoff |
| `SMART_NOTE_FALLBACK_COMPLETION_WROTE_NO_DUE_TIME` | `reduce_fallback`'s **`False`** arm (`:647-656`) ran, writing only `last_checked_at`, `updated_at` and `check_status` | A structural fact about which columns the arm sets, true today. It does not assert a poll loop occurred. Scoped to the `False` arm deliberately: the `Met` arm (`:637-646`) calls `ready_fields`, so the note leaves `pending` and cannot be re-selected, and a marker spanning both arms would witness a situation the backoff record does not claim |
| `SMART_NOTE_LIVENESS_STAMPED_ITS_WINDOW_BEFORE_MATCHING` | `check_last_liveness_at = now` assigned at `:591-593` on a pass that then reached the `NetworkFailed` arm at `:623-626` | Legal and unconditional by construction. The precondition of the burned-window record, stated as statement order |
| `SMART_NOTE_COMPLETION_ARRIVED_AGAINST_A_MUTATED_NOTE` | An applied completion whose claim revision was taken before a concurrent facade mutation | Legal input, and the fence at `mc-store/src/lib.rs:13569-13573` exists for it. The precondition of the revision-fence record |
| `SMART_NOTE_PENDING_SET_EXCEEDED_ITS_POLL_MATERIALIZATION_THRESHOLD` | A candidate query returning more than a chosen constant number of rows, with the constant fixed in code rather than derived per run | Legal: there is no cap, so any count is correct behaviour. The precondition of the growth record, asserted as a count rather than as an exhaustion. Note the threshold here is a **marker** threshold picked by the campaign, not a product bound; the record itself asserts a linear scaling relation precisely because no product bound exists |
| `SMART_NOTE_POLL_MATERIALIZED_TWO_DISTINCT_PENDING_SET_SIZES` | Two polls in one campaign whose candidate queries returned different row counts, against identically prepared projects | Legal on every implementation: the count is whatever the caller wrote. The precondition of the growth record's scaling oracle, which needs two sizes to say anything at all, and it does not assert that growth was linear |
| `NOTE_EVALUATOR_PROJECT_POLICY_ACCUMULATED_OVER_TWO_REGISTRATIONS` | `live_note_evaluator_policy` (`:3889-3906`) folded two or more live entries at `:11166` | Legal and is the accumulation the code performs. The precondition of the project-wide-policy record |
| `NOTE_EVALUATOR_REGISTERED_A_POLICY_VERSION_UNEQUAL_TO_THE_NOTES` | A registration whose `policy_version` (validated `:10916-10919`, stored `:10964`) differed from the version on the project's notes | Legal input. The precondition of the never-reaches-selection record, and it does not assert selection ignored it |
| `NOTE_ACQUISITION_RETURNED_NO_WORK_OVER_A_NON_EMPTY_PENDING_SET` | A `no_work` decision committed while the pending set was non-empty and every note was excluded | Legal and is the correct answer when everything is excluded. The precondition of the unreportable-exclusion record, and it is distinct from the cursor marker: this one requires `cycle_exhausted` **false** |
| `NOTE_DISMISSAL_LEFT_THE_ROW_READABLE` | A dismissed note still returned by a `ctx_note read` with `filter: "dismissed"` (`:11721`) | Legal and deliberate: dismissal UPDATEs rather than DELETEs. The precondition of the never-returns-to-evaluation record |

### The two existing `sometimes` records, checked against METHOD.md

Each lens produced exactly one `sometimes` record. **Both comply,** and each carries
one refinement rather than an objection. Neither is duplicated in the table above.

- **`facade-a-replayed-facade-mutation-occurs-in-a-campaign` complies.** The marker
  `FACADE_MUTATION_REPLAY_OBSERVED` is a named constant, and it fires on two
  independent preconditions that hold on a correct implementation: the `Duplicate`
  arm taken in `facade_command_outcome` and the stored envelope re-parsing
  successfully. Neither asserts a violation, and no `always(!X)` companion exists,
  so the forbidden pairing is absent. Choosing `sometimes` over `reachable` is
  right for the stated reason: executing the arm's lines with a hand-built
  `Duplicate` value proves nothing, because the property is that a real second call
  with a committed first attempt occurred. **Refinement:** the ledger retains only
  the newest 512 commands per identity scope (`mc-store/src/lib.rs:5042-5046`), so
  a long campaign can evict the first attempt and leave the marker silent for a
  reason unrelated to coverage. Record the retention horizon and the observed
  command count alongside the marker, or a green run cannot be distinguished from
  one whose replays all fell outside the window. This is the same failure mode 4c
  recorded for its restart marker.

- **`note-b-cursor-exhausted-no-work-occurs-in-a-campaign` complies.** The two
  conjuncts are independent preconditions on a correct implementation: a fresh
  `no_work` carrying `cycle_exhausted: true`, and the project holding at least one
  note a fresh cycle would select. The second is the guard that prevents the
  vacuous drained-queue pass, which is exactly the shape METHOD.md's rule exists to
  force. `sometimes` over `reachable` is justified in the record's own words: a
  campaign can execute `lib.rs:11220-11229` and always compute `false`. No
  `always(!X)` companion exists. **Refinement, applied:** the record named no
  marker constant, which METHOD.md's marker rule does not allow, and its sibling
  supplied one. It is now `NOTE_CYCLE_EXHAUSTED_NO_WORK_OBSERVED`, a constant of
  the same shape, so the assertion is no longer anonymous. This refinement was
  recorded here as advice in the previous revision and not applied; applying it
  closes the loop, and the pattern is worth noting because a sibling part found the
  same failure of advice to propagate from a review section into a record.
  Note also that the marker above,
  `NOTE_ACQUISITION_RETURNED_NO_WORK_OVER_A_NON_EMPTY_PENDING_SET`, is deliberately
  the complement: it requires `cycle_exhausted` **false**, so the two never fire on
  the same response and neither subsumes the other.

### Anti-patterns to avoid in this part specifically

Five pairings are forbidden by METHOD.md's rule, and each is tempting here because
in this part the defect is almost always easier to name than its precondition.

- Do not pair `always(!plain_note_written_for_a_conditioned_request)` with
  `sometimes(misspelled_condition_wrote_a_plain_note)`. That marker fires only by
  producing the silently-degraded write. Assert
  `CTX_NOTE_WRITE_CARRIED_A_CONDITION_KEY_THE_HANDLER_DID_NOT_READ` and
  `CTX_NOTE_WRITE_RAN_WITH_NO_LIVE_EVALUATOR` instead: two independent, legal
  facts whose conjunction is the vulnerable window.
- Do not pair `always(every_ack_has_a_durable_module_effect)` with
  `sometimes(ack_without_effect)`. Assert `CLAIM_EFFECTS_APPLY_ACCEPTED_A_RECEIPT`
  instead and keep the `always` on the durable side. The `sometimes` form is also
  operationally wrong here, because the effect it would witness lands in the other
  language's database. **This rule was violated by the record itself and has been
  fixed:** the claim-effects record listed "no module store write occurred during
  the call" as one of two independent preconditions, which is the alleged violation
  wearing a precondition's clothes. A correct implementation that retained the
  effects would write, so that clause can only be satisfied by the defect being
  present. The acceptance alone is the legal precondition.
- Do not pair `always(claim_handler_used_the_bound_route)` with
  `sometimes(route_identity_discarded)`. Assert
  `CLAIM_HANDLER_RESOLVED_A_ROUTE_ROOT_IT_DID_NOT_USE` instead, which is a fact
  about three call sites rather than about a trust boundary being crossed.
- Do not pair `always(distinguishable_error_causes)` with
  `sometimes(digest_conflict_indistinguishable_from_store_fault)`. Assert
  `CLAIM_INTENT_STAGE_REUSED_AN_OPERATION_KEY` and
  `CLAIM_INTENT_HANDLER_COLLAPSED_AN_ERR_INTO_ITS_SINGLE_CODE` instead. Both are
  legal and both are present on a correct implementation.
- Do not pair `always(durable_schedule_is_host_independent)` with
  `sometimes(two_hosts_produced_different_schedules)`. The divergence marker can
  only fire by writing a host-dependent durable row. Assert
  `SMART_NOTE_REDUCER_RAN_WITH_A_NON_LOCAL_ZONE` instead, which records that the
  campaign varied the zone, and keep the `always` on the comparison.

### Placement constraints on markers in this part

Four, and they differ from 4c's because this part's boundary is a response
envelope rather than a durable write.

1. **"Nothing durable has happened yet" is not the top of the `ctx_note` handler.**
   `resolve_facade_scope` (`:10387-10480`) optionally binds the authority route for
   writes at `:10434-10438`, so it is itself a durable act. A marker meaning
   "pre-mutation" on `ctx_note` must sit after the scope resolution at `:11568` and
   before the vocabulary recheck at `:11584-11591`, not above either.
2. **The six claim handlers have no scope-resolution point.** None of them calls
   `resolve_facade_scope`. `claim_route_root` (`:10068-10080`) is the only
   equivalent, three of four handlers discard its result, and the two mirror
   handlers do not call it at all (`:10262`, `:10300`). No marker on a claim
   handler may be read as meaning "this request was scope-authorised".
3. **A marker meaning "this response was executed" must sit inside the ledger
   closure.** `facade_command_outcome` inserts `"replayed": true` at `:15303`, so a
   replay and a fresh execution leave the closure with the same envelope shape. A
   marker placed after `with_facade_command` returns cannot distinguish them.
4. **A marker meaning "the command failed" must not sit after the ledger closure.**
   The two error-text arms return `Ok` from inside it (`:11865-11870`,
   `:11902-11907`), and `Ok` is the commit signal, so anything downstream sees a
   committed success. Place the failure marker where the failure is decided, not
   where the outcome is read.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability. Records-per-capability would put F1 or F2 at the
top; that is the wrong answer, because the single cheapest capability here unblocks
**zero** records and protects all 112 checks.

**State this plainly: most of this part's findings need no injected fault at all.**
Each strictness tier is a single request with an extra key. Most success-shaped
error paths are one or two calls plus a store read. Neither needs a seam, a second
process, a clock, or a new dependency.

What that sentence used to hide, and no longer does, is the spread inside "no
fault". An earlier version said "fourteen of the 24 records are in that category"
and stopped. Decomposed by the map's orchestration column, the no-injected-fault
records fall into three bands rather than one:

| Band | Orchestration | Records |
| --- | --- | --- |
| **Free** | `none · 1 · no` or `none · 1 · yes` | the byte-cap band probe, the misspelled condition key, the facade error path, the claim-effects module half, the unreportable exclusion |
| **Sequenced** | 2 to 4 calls, or setup beyond one seeded row | the open-key differential and the reduced envelope (two calls, and two cloned stores if the tool mutates), the replay marker (2), the mutation ledger's dismiss arm (2), the route-identity record (**2 bindings, 3 calls**), dismissal (**4 calls**), the two-registration pair (3 to 4), the revision fence (3), the cursor marker (3 or more) |
| **Volume or repetition** | N writes, a poll loop, or eight sequenced requests | unbounded growth (**N and 2N writes plus two polls**), fallback spin (a poll loop), the shared failure counter (**8 requests**) |

The bands, not the single verdict, are what the ranking below is ordered by.

1. **F0, running the existing checks in CI.** A workflow change and nothing else:
   `cargo test -p mc-module --lib` alongside the existing `--test lifecycle_cli`
   step (`ci.yml:168` at `76cd6f41`, `:172` at `HEAD`), plus `--test
   prepared_output`, plus calling the `scripts/test-rust.sh` lane that already
   exists in `package.json` and that no workflow invokes. It unblocks **zero** new
   records and **protects 112 existing checks**: 88 in-crate claim-bearing tests
   spanning `:16041-27808`, 14 file-local tests in the three 4d files that have
   test modules, and the 10 in `tests/prepared_output.rs`. **Nothing else on this
   list matters until this is done,** because anything added below is added to a
   suite no automation executes. One blocker is named and bounded: `ci.yml:719-721`
   states Rust is absent from the e2e lanes because private `../commons` and
   `../subconscious` path-deps are not provisioned, and `ci.yml:163-164` provisions
   metadata-only stubs. `prepared_output.rs` imports only
   `mc_module::dispatch::{...}`, so whether that constraint reaches it is an open
   question rather than a settled no.
2. **F1 and F2, the no-injected-fault tier, which is the largest single block of
   value in the part.** Eleven records become non-vacuous with no new
   infrastructure at all. They are listed in ascending orchestration cost rather
   than as one undifferentiated set, because the cheapest and the dearest of them
   differ by a factor of four in call count:
   `facade-a-transform-class-byte-cap-probe-diverges-from-the-router` (one request
   in the 1-to-32-MiB band),
   `facade-a-misspelled-surface-condition-silently-writes-a-plain-note` (one
   request),
   `facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect`
   (one call, before-and-after store read),
   `facade-a-facade-error-text-carries-absolute-route-paths-to-the-model` (one
   request, one divergent route),
   `note-b-excluded-note-is-not-reportable-by-any-surface` (one poll, seeded
   exclusions),
   `facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes` (one call, seeded
   tags, store read),
   `facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic`
   (two calls, and two cloned stores if driven through a mutating tool),
   `facade-a-reduced-summary-envelope-is-an-unvalidated-argument-source` (two
   calls, cheapest at the parser level),
   `facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes`
   (dismiss arm, two calls),
   `facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity` (**two
   bindings and three calls**, not one as an earlier version said), and
   `note-b-dismissed-note-is-readable-but-never-returns-to-evaluation` (**four
   calls**, not three). The `claim.effects.apply` module half is the one on this
   list with no test in either language, and it is also among the cheapest, which is
   why it belongs first among the substantive items.
3. **F3, store failure beneath an acknowledging handler, which is implementable
   today.** `execute_tag_sql_for_test` (`mc-store/src/lib.rs:6431-6439`) runs
   arbitrary SQL through `execute_batch` and the feature is already enabled for
   module tests (`crates/mc-module/Cargo.toml:66-72`, `:71`), so an `AFTER INSERT
   ... RAISE(ABORT)` trigger gives an aborting write with no new seam and no change
   to `mc-store`. It is third rather than second only because installing a trigger
   is more test-authoring work than sending a request, and because matching a
   specific `McStoreError` variant is a per-site question. It supplies the
   comparison half of
   `facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault`
   and the CAS half of the mutation-ledger record. **A sibling part's fault map
   ranks this capability last on cost and calls it absent
   (`../part-4c-handlers/fault-map.md:419-436`); that is the one claim in this
   file that contradicts a sibling, and the contradiction is deliberate.**
4. **F6 and the sequencing-only note-evaluation records.** Request ordering with no
   fault, no seam, and no clock: advance a slot cursor, seed work into a skipped
   phase, poll again. It makes
   `note-b-cursor-exhausted-no-work-occurs-in-a-campaign` valid and supplies the
   situation the two normative-fixture records already half-cover. The same
   sequencing shape makes `note-b-check-failure-count-carries-across-compile-and-
   check-phases`, `note-b-liveness-network-failure-burns-the-window-with-no-
   durable-record`, `note-b-fallback-phase-writes-no-durable-backoff`,
   `note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration`,
   `note-b-registered-policy-version-never-reaches-selection` and
   `note-b-completion-applies-only-under-the-claimed-revision-and-state-version`
   valid, all on wire-supplied outcomes and seeded rows.
5. **The reducer zone differential, which needs a dev-dependency already
   present.** `chrono-tz` is in `[dev-dependencies]` (`crates/mc-module/Cargo.toml:67`)
   and the zone is a reducer parameter, so two zones and a comparison is cheaper
   than most items above. It sits fifth for cost and its **value has been
   downgraded**: since the reducer documents the timezone as a supplied input
   (`smart_note_evaluation.rs:8-10`, including "production passes the machine-local
   zone"), a two-zone differential confirms documented behaviour rather than
   exposing anything. It is worth writing as a regression pin on the schedule
   arithmetic, and it does not make
   `note-b-reducer-reads-process-local-timezone-for-durable-schedule` non-vacuous;
   only F4 does.
6. **F5, caller-driven note growth, now against a scaling oracle.** No fault, and
   the oracle is a row count. It is sixth on cost because it needs write volume,
   and the volume doubled: the record can no longer assert a bound against a
   declared constant, because none exists (`mc-store/src/lib.rs:13291-13301` has no
   `LIMIT`), so it asserts linear growth instead and needs **two** seeded sets of N
   and 2N conditioned `ctx_note` writes plus a poll on each. It makes
   `note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll`
   refutable and nothing else. The better fix is a product decision on a per-poll
   ceiling, which would turn it back into an ordinary constant bound.
7. **F4, process timezone variation.** Two `cargo test` invocations under different
   `TZ`, or one spawned child process. **It is the only thing that makes
   `note-b-reducer-reads-process-local-timezone-for-durable-schedule` non-vacuous,**
   which is a promotion from the previous revision: that revision said F4 "unblocks
   zero records" because item 5 already covered the same record, and that was wrong
   once the record was reframed as a call-site portability decision rather than a
   reducer impurity. A reducer differential cannot observe a call site. It stays
   seventh on cost, and one mechanism question is unresolved: whether
   `chrono::Local` re-reads `TZ` within a process, and `std::env::set_var` is
   `unsafe`.
8. **F7, the cross-language differential, last on cost and first on consequence,
   and now the part's one outright block.** This is the tension worth stating rather
   than hiding. It has two halves with very different prices. The **cheap half** is
   the shared smart-note fixture: extending `evaluation-state.test.ts` past
   `transition_cases` (`:105`)
   to iterate `schedule_cases` and `selection_cases` is a one-line loop in a file
   that already loads the fixture (`:54`) and already runs on every pull request
   under `ci.yml:257`, and it would put 25 of the fixture's 48 cases under
   automation for the first time. That is arguably the single highest
   value-per-line change on this list and it belongs beside item 1. The **expensive
   half** is the claim-effects pairing, which since this disposition is its own
   record, `facade-a-claim-effects-ack-and-producer-checkpoint-advance-are-never-composed`:
   it needs a harness in which the real module
   answers the real producer, and none exists — `direct_host.rs` has zero 4d method
   literals, so there is nothing to extend. Until it exists, the honest statement is
   the one an earlier version of this item got wrong. It said "both halves of that
   contract are green against a fake of the other". They are not. The Rust half is
   **untested**, with `claim_effects` appearing zero times in either test module; the
   producer's drain is green against a fake `deliver` closure at
   `module-state-sync.test.ts:1405-1415`; and the composition is tested nowhere. The
   two other citations that item carried, `module-wire.test.ts:345` and
   `module-state-sync.test.ts:1510`, are claim-**mirror** tests
   (`decodeClaimMirrorReceiptResponse`, and `class DeterministicClaimMirrorFacade` at
   `:1444`), so they were never evidence about this contract at all. The exposure is
   bounded only by the TypeScript checkpoint guards at
   `storage-claim-operations.ts:2218-2243`.

**Records that need a product decision rather than a harness.** No amount of test
infrastructure resolves these, and each is a live open question from at least one
lens.

- Whether `claim.effects.apply` is intended as a protocol-conformance ack rather
  than an effect. The module's own doc says nothing about it being validation-only,
  and the answer decides whether the record is a defect or a naming problem.
- **What per-poll candidate ceiling the product wants.** Without a number, the
  unbounded-growth record can only assert a scaling relation, because a check
  against an undeclared constant is unfalsifiable. A chosen ceiling plus a `LIMIT`
  on the candidate query turns it into an ordinary bound.
- **Whether `policy_version` should be documented as informational.** This was
  previously folded into that record's check, where no harness could evaluate it. It
  is a documentation decision and it decides whether a client is right to read the
  echoed value as a negotiated contract.
- **Whether the composition of the module ack with the producer's checkpoint is
  worth a real cross-language harness,** or whether replaying recorded real module
  responses into the existing TypeScript fake is an acceptable substitute. The second
  is far cheaper and strictly weaker.
- Whether the three claim handlers that discard `claim_route_root`'s result should
  use it. `handle_claim_intent_stage` passes it to the store at `:10100` and the
  other three do not, with no stated reason for the asymmetry.
- Whether the TypeScript golden replay should be extended to `schedule_cases` and
  `selection_cases`, or whether the Rust-only replay of those two groups is
  deliberate because the TypeScript reducer does not own scheduling. `PARITY.md:87`
  lists "shared Rust cron/schedule primitive" as *deferred* ownership, which
  suggests the asymmetry is known.
- Whether the durable smart-note schedule may depend on the host's timezone at all,
  which decides whether the host-dependence record is a defect or a documented
  constraint.
- Whether the two error-text arms recording a failure as a command's durable
  success (`:11865-11870`, `:11902-11907`) are deliberate. The ledger commits on
  `Ok` and both arms return `Ok`.
- Whether each claim-intent handler's single error code should be split, so a
  digest conflict is distinguishable from a store fault.
- Which side of the advertised-versus-enforced `maxLength` mismatch is the
  contract, characters or bytes. Three advertised values match their byte caps
  numerically, so the mismatch fires only on multi-byte input, and fixing either
  side is a breaking change.
- Whether `ctx_search`'s advertised project-memory and git-commit corpora are
  planned or abandoned, and whether `ctx_memory` should stay advertised as
  `Mutating` while refusing every mutation.
- Whether the repository wants a check tying `handle_facade_value`'s eleven match
  arms to `module_tools`, given `:25531` already proves the schema side is
  gate-able.
- Whether a never-executed test counts as `Exercised: partial`. It governs every
  `Existing check:` line in this part, all three lenses raise it, and it is
  unresolved.
