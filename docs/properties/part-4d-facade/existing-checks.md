# Part 4d existing-check inventory

Every claim-bearing check for the facade surface, note evaluation, and response
assembly: `crates/mc-module/src/lib.rs` ranges `10042-11917` and `11919-16001`,
plus four whole files the scope map assigns to this sub-part, `dispatch.rs` (511
lines), `smart_note_evaluation.rs` (1,851), `memory_tool.rs` (447) and
`project_docs.rs` (232). That is 5,959 in-`lib.rs` lines plus 3,041 file lines,
about 9,000 production lines. The sub-part owns the single facade entry point and
its eleven routed names (five `ctx_*` tools plus six claim commands), the claim
intent ledger and claim effects at `lib.rs:10068-10255`, the
`note.evaluation.*` protocol at `:10880-11481`, note delivery at `:11483-11545`,
the smart-note reducer and selector, prepared-output measurement and settlement,
the advertised tool schemas, and the status envelope.

Provenance. `HEAD` is `e447c927` ("refactor(shm): trim final review leftovers").
`.github/workflows/ci.yml` differs across `76cd6f41..HEAD`, and the one step that
matters here moved: the `mc-module` test invocation
`cargo test -p mc-module --test lifecycle_cli` is `ci.yml:168` at `76cd6f41` and
`ci.yml:172` at `HEAD`. Both were confirmed directly, the second in the working
tree and the first through `git show 76cd6f41:.github/workflows/ci.yml`, and both
are cited wherever the step appears. Two other numbers for the same step are on
record and are also real: the scope map cites `:167-168` and lens A cites
`:171-172`, which are the `name:` and `run:` lines of the same step at the two
commits. All four describe one step; only the file moved.

Three corrections to references handed to this synthesis, made per METHOD.md rule
1 and recorded rather than silently applied.

- Lens C reports the helper fixpoint running over **117** non-test functions in
  the `lib.rs` test modules. An independent recount at `HEAD` returns **119**,
  which is the figure 4c reported by the same description. The difference is a
  detector edge on `fn` lines adjacent to a test attribute and it changes no count
  in this file. The attribution section below states 117 as the number the
  fixpoint actually ran over and this correction as the recount.
- `conditioned_write_replays_recorded_response_without_live_evaluator` is at
  `lib.rs:23243`, not `:23242`; `:23242` is the `#[tokio::test(...)]` attribute.
  Lens A's `:23242-23292` and lens C's `:23243` are the same test.
- The TypeScript checkpoint guard lens C names `advanceOutboxCheckpoint` at
  `storage-claim-operations.ts:2216-2254` is
  `advanceOutboxConsumerCheckpointInCurrentTransaction`, opening at `:2214`. The
  three guards are at `:2218-2219`, `:2222-2224` and `:2241-2243`, all verified,
  and the span `:2218-2243` used below covers them.

An existing check does not remove a property from the catalog. **Every status
below is `unaudited`**: test adequacy belongs to
`/testing:invariant-test-review`, and production assertion adequacy to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## The coverage fact that frames this inventory, and how the number was obtained

**88 claim-bearing in-crate tests reach 4d, spanning `lib.rs:16041-27808`, plus 14
file-local tests in the three 4d files that carry their own test modules, so 102
in-crate checks. Ten more sit in `tests/prepared_output.rs`. None of the 112 runs
in CI.**

That is the headline. The attribution behind the 88 is mechanical rather than
asserted, and it is stated in full so a reader can reproduce it.

`lib.rs` is 30,517 lines with two flat `#[cfg(test)]` modules and no inner `mod`,
so a test's subject cannot be read off its location the way it can in a file
organised into submodules. The attribution reproduces 4c's method in four steps
so the two inventories are comparable:

1. **Enumerate.** All `#[test]`, `#[tokio::test]` and `#[tokio::test(...)]`
   attributes from `:16001` on. Re-counted independently at `HEAD`: **256**. That
   is the same 256 4c reports and reconciles with the scope map's 248 + 8.
2. **Resolve.** Each attribute resolved forward to its following `fn` line, giving
   256 test functions: **248** whose `fn` lines fall below `:30282` in `mod tests`
   and **8** in `mod release_contract_tests`. The first is
   `production_settlement_reserves_before_write_and_returns_exact_body` at
   `:16041`; the last is
   `state_sync_epoch_compatibility_requires_the_exact_numeric_epoch` at `:30488`.
   All four of those figures were re-derived at `HEAD`.
3. **Brace-match.** Each body brace-matched to its closing line with string
   literals stripped, so a test's extent is its real body rather than the gap to
   the next attribute.
4. **Fixpoint over helpers.** 4d production identifiers and method literals
   matched inside each body, then a fixpoint taken over the **117 non-test helper
   functions** in the test modules, so a test that reaches the facade only through
   a request builder or a fixture is attributed transitively. See the correction
   above: a recount of that helper population returns 119. The step is
   load-bearing rather than cosmetic, and the gap between tiers two and three
   below measures exactly how load-bearing.

The result is not one number but four tiers, and they **bracket** the truth rather
than pin it:

| Tier | Tests | What it measures |
| --- | --- | --- |
| **Reach** | **232** of 256 | Executes at least one line of 4d production code, transitively |
| **Op-specific, helper fixpoint** | **88** | Names a 4d-owned tool, claim command, note-evaluation method, settlement API, byte cap, schema, expand renderer, or smart-note contract |
| **Op-specific, direct body match** | **65** | The same rule with the fixpoint removed |
| **Name rule** | **49** | Test name matches the 4d vocabulary |

**The 232 is inflated, and the reason is structural rather than accidental.**
`PreparedOutcome` is the return type of every handler in the crate and
`mcp_text_result` and `respond` are how they all answer, so a symbol-reach tier
over 4d catches nearly every handler test in the file. This is the mirror image of
4c's inflation, which came from 82 tests entering the transform handler to assert
4b engine behaviour; here it comes from 4d owning the response vocabulary the
whole crate speaks. **The 88 is the number to use.** The 65 and the 49 bound it
from below, and the 23-test gap between 88 and 65 is the transitive-helper
contribution.

Per-file counts for the four whole files the scope map assigns to 4d, re-counted
at `HEAD`:

| File | `#[cfg(test)]` / `mod tests` | Tests |
| --- | --- | --- |
| `smart_note_evaluation.rs` | `:951-952` | **7** |
| `project_docs.rs` | `:120-121` | **6** |
| `memory_tool.rs` | `:361-362` | **1** |
| `dispatch.rs` | none | **0** |

`dispatch.rs` is the only 4d file with no test module at all, and it is also the
file carrying the sub-part's best-tested claim; its ten checks live in the
integration binary instead. `smart_note_evaluation.rs` is the densest
claim-per-test surface in the sub-part: 7 test functions carry roughly 48 fixture
cases plus two normative matrices over about 950 production lines.

**None of the 112 runs in CI.** Three mechanical facts produce that, verified
across all five files in `.github/workflows/`:

1. **The only `mc-module` test invocation in any workflow is
   `cargo test -p mc-module --test lifecycle_cli`,** at `ci.yml:168` at
   `76cd6f41` and `:172` at `HEAD`. `--test lifecycle_cli` selects one integration
   binary and does **not** build the `--lib` target, so no in-crate `mc-module`
   test is compiled, let alone run, and no other integration binary is selected
   either. The step above it is build-only,
   `cargo build -p mc-module --bin ck-mc-host` (`:165` at `76cd6f41`, `:169` at
   `HEAD`).
2. **There is no `cargo test -p mc-module --lib`, no `cargo nextest run -p
   mc-module`, and no `--workspace` test job.** The only other `mc-module` mention
   in `ci.yml` is a comment at `:361`.
3. **`scripts/test-rust.sh` (`cargo nextest run --workspace`) exists, is wired
   into root `package.json`, and no workflow invokes it.**

The consequence for every record in this part is that `Exercised: partial` means
"a test exists on a developer's machine". METHOD.md's `Exercised` field does not
distinguish that from `not yet`. 4c raised it, the scope map raised it at `:681`,
lens A and lens C both raised it, and it is recorded here as needing human input
rather than resolved.

### Reconciling 4c's "28 tests attributed to 4d"

**That figure is a hand-off estimate, not 4d's total, and it is not an error.** 4c
subtracted 51 tests from its own 120 op-specific set by test name, of which 28
went to 4d, so its 28 is the size of the *overlap it handed over*: tests that
reach 4c production code and whose names say facade, `ctx_*`, note evaluation,
native attachment, prepared output, schemas, or byte caps. 4c said so itself, that
"its boundary is approximate at the edges"
(`../part-4c-handlers/existing-checks.md:87`).

Reproducing that rule independently from 4d's side gives two numbers and neither
is 28: **11** of this part's 4d-symbol tests also touch a 4c symbol by direct body
match, and **49** of all 256 match the 4c-stated name vocabulary. Neither
reproduces 28 exactly, because 4c applied its rule to its own 120-set rather than
to all 256. The honest statement is that 4d's independent claim-bearing count is
88, that 11 to 49 of those are shared with 4c depending on the rule, and that 28
sits inside that band. **No correction is issued to 4c.** The two numbers measure
different things and both are stated with their derivation.

## The cross-language acknowledgement dependency

This gets its own section because it is the sharpest coverage finding in the
sub-part: **the acknowledgement contract between this module and the TypeScript
claim-effects producer has no test on either side of the language boundary. The
Rust half is untested outright, the producer is tested against a fake delivery,
and the real composition is absent.**

An earlier draft of this section said "each half is checked against a fake of the
other". An independent evaluation refuted that, and the refutation is recorded here
because the wrong version overstates the Rust side's coverage. There is no Rust
test to fake anything against. The three parts are asymmetric and each is stated
separately below.

The dependency, traced end to end:

| Step | Location | What happens |
| --- | --- | --- |
| 1 | `lib.rs:10184-10255` | `handle_claim_effects_apply` validates the request, never calls `self.store()`, and returns `"ackedEffectId": previous` (`:10253`) |
| 2 | `module-wire.ts:717-735` | `decodeClaimEffectDeliveryResponse` throws `"claim effect delivery response skipped checkpoint ..."` (`:730-732`) unless the returned value equals the expected effect id |
| 3 | `module-state-sync.ts:2318-2327` | Repeats that check |
| 4 | `module-state-sync.ts:2328-2345` | Advances the durable outbox checkpoint inside a transaction |

So a value the module computes with no durable module-side effect drives a durable
checkpoint advance in the other implementation.

**The Rust half has zero coverage.** `claim_effects` appears twice in the whole
file, both in production code (`:10051` dispatch, `:10184` handler), and **zero**
times in the test modules; `claim_intent` appears 15 times and **zero** times in
the test modules. No Rust test references `handle_claim_effects_apply`, so there is
nothing on this side that a fake could be checked against.

**The TypeScript producer is CI-tested against a fake `deliver` closure.**
`ci.yml:257` runs `bun run test`, which sweeps every `*.test.ts` under the plugin
tree, so this does run on every pull request. The relevant fake is supplied inline
in the drain test:

| Site | What it installs |
| --- | --- |
| `module-state-sync.test.ts:1405-1415` | The `drainClaimEffectPrefix` call under test, whose `deliver` option is a closure returning `{ ackedEffectId: receipt.effects.at(-1)?.id ?? 0 }` (`:1414`) — the value the producer is about to require |

That covers the drain's ordering and its per-receipt checkpoint atomicity, which
are real properties. What it does not cover is any module behaviour, because the
module is not present.

**Two sites previously cited here belong to a different contract.** This is the
correction the evaluation forced, and it matters because both were counted as
claim-effects coverage:

| Site | What it actually is |
| --- | --- |
| `module-wire.test.ts:345`, `:414`, `:427` | Arguments to `decodeClaimMirrorReceiptResponse` (`module-wire.ts:737` onward). Claim-**mirror** decode tests |
| `module-state-sync.test.ts:1510` | Inside `class DeterministicClaimMirrorFacade`, opening at `:1444`. A claim-**mirror** facade fake |

Both share the field name `ackedEffectId` with the claim-effects path and nothing
else. Verified at `HEAD`: `decodeClaimEffectDeliveryResponse`, the claim-effects
wire validator at `module-wire.ts:717`, has **zero** test references anywhere in
`packages/plugin`. So the wire-level ack check on this contract is untested too.

**State it plainly: the module's ack is checked by nothing, the producer's drain
and checkpoint advance are checked against a closure in the test file, and the
composition — a real module ack advancing a real durable checkpoint — is checked
nowhere.** There is no harness that could check it: `direct_host.rs` contains
**zero** 4d method literals, so the facade has no end-to-end coverage through a
real `McHandler` at all.

**Mitigation, and it is real.** The checkpoint advance is not unbounded.
`advanceOutboxConsumerCheckpointInCurrentTransaction`
(`packages/plugin/src/features/magic-context/memory/storage-claim-operations.ts:2214`
onward) rejects a non-safe-integer or negative id (`:2218-2219`), rejects a
regression against the stored cursor (`:2222-2224`), and rejects an id beyond the
outbox tail (`:2241-2243`), with the reason for that last guard written out in the
comment above it: a future cursor makes the prune boundary that future id, and
effects allocated below it afterwards are deleted having never been published. So
a module ack cannot advance the checkpoint past effects the producer has not
written; it can only skip effects the producer has. Those guards are themselves
covered — `storage-claim-operations.test.ts` carries 12 `ackedEffectId` sites at
`:852-1077` — under `ci.yml:257`. The mitigation narrows the blast radius to
*skipped* effects rather than fabricated ones. It does not close the gap, and it
lives entirely on the side that is not the one making the claim.

The same shape appears once more, on the shared smart-note fixture, and there the
asymmetry is sharper because the fixture is shared rather than parallel. See
suspiciously quiet area 7.

## In-crate tests, clustered with counts and line ranges

Clusters as lens C produced them, by direct or transitive-helper reference to the
named tool, method literal, or type. Every cited `fn` line was re-read at `HEAD`.

| Cluster | Tests | Line range | Notes |
| --- | --- | --- | --- |
| native attachment plumbing | 20 | `:19261-21839` | Largest cluster in scope. The caches are 4c's; the plumbing at `:12450-13055` is 4d's |
| note-evaluation protocol | 17 | `:23111-24290` | Best-covered 4d-owned protocol; 12 of the 17 name a cycle or quota rule |
| `ctx_note` | 14 | `:17067-25531` | Includes the ledger-replay test at `:23243` |
| `ctx_reduce` | 9 | `:17067-27570` | Five are the `command_id` family at `:27555-27808`, which 4c also claims |
| `respond_transform` and status helpers | 8 | `:16198-19294` | `usage_numbers`, `projected_post_drop_percentage`; two historian-trigger tests are 4a assertions reaching a 4d helper |
| `drive-fault` | 8 | `:18965-19113` | Feature-gated, `explicit-config-only` |
| `ctx_memory` | 7 | `:17067-25762` | Includes the mutation-refusal gate at `:25762` |
| `ctx_search` | 6 | `:17067-25531` | |
| `ctx_expand` | 6 | `:17067-25657` | Includes both budget checks, `:24517` and `:25657` |
| smart-note selection types | 6 | `:23904-24241` | Reach `SmartNoteCycleMode` / `SmartNoteSelectionCycle` |
| prepared settlement | 4 | `:16041-16150` | The only tests of `settle_prepared_with` |
| tool schemas and manifest | 4 | `:17067-25931` | `:25531` is the contract gate |
| request byte caps | 3 | `:17542-17589` | `:17542`, `:17567`, and one transitive |
| facade argument extraction | 1 | `:25333` | `facade_arguments_preserve_decorated_reduced_fields` |

Named tests the lens records lean on, verified by name and `fn` line at `HEAD`:

| Line | Test | Pins |
| --- | --- | --- |
| `:16041` | `production_settlement_reserves_before_write_and_returns_exact_body` | Reserve-before-write ordering |
| `:16150` | `production_settlement_cancellation_and_denial_emit_no_body` | The cancellation and reserve-denial arms |
| `:17542` | `request_byte_cap_widens_for_transform_class_only` | The two-tier cap, on small bodies only |
| `:17567` | `value_footprint_counts_nodes_outside_strings_only` | The footprint bound's counting rule |
| `:23111` | `smart_note_writes_require_a_live_protocol_v2_registration` | The fail-closed conditioned-write gate |
| `:23243` | `conditioned_write_replays_recorded_response_without_live_evaluator` | A recorded **success** replaying past the liveness gate |
| `:23295` | `note_evaluator_registration_rejects_wrong_versions_and_stale_credentials` | The four-way identity match at `:13877` |
| `:23381` | `note_evaluator_route_teardown_withdraws_registrations` | The boot-ephemeral registration claim |
| `:23524` | `note_evaluation_rejects_forged_oversized_and_phase_smuggled_completions` | The digest recompute plus the phase pairing at `:14086`, `:14105` |
| `:23904` | `note_evaluation_replayed_and_recovered_claims_leave_cycles_unchanged` | The cursor's replay-idempotence half |
| `:23976` | `note_evaluation_fresh_no_work_resets_and_replayed_no_work_does_not` | The cursor reset rule |
| `:24048` | `note_evaluation_spent_cycle_no_work_reports_cycle_exhausted` | The `cycle_exhausted` distinction |
| `:24290` | `note_evaluation_fallback_rotates_before_reclaiming_checked_notes` | Fallback rotation determinism |
| `:24341` | `ctx_expand_and_ctx_note_facades_are_session_scoped` | Facade session scoping |
| `:24901` | `note_evaluate_verdict_writes_are_protocol_retired` | The `protocol_retired` code |
| `:25028` | `note_facade_pages_ready_notes_beyond_one_hundred_with_shared_offset_semantics` | The advertised paging contract |
| `:25299` | `facade_flat_envelope_precedence_keeps_kind_arm_and_gates_ctx_reduce_name` | `method`/`kind` precedence over `name` |
| `:25325` | `ctx_reduce_range_parser_rejects_unbounded_and_oversized_ranges` | `MAX_RANGE_ELEMENTS` (`:15166`) |
| `:25333` | `facade_arguments_preserve_decorated_reduced_fields` | The **non**-unwrap half of the reduced envelope |
| `:25445` | `facade_ctx_reduce_ack_validates_unknown_queued_and_protected_tags_without_committing` | `ctx_reduce`'s no-write behaviour |
| `:25531` | `ctx_manifest_schemas_accept_unknown_args_without_advertising_reduced_fields` | The whole schema contract: the authorizer-pinned `ctx_reduce` bytes, the derived category enum, the per-tool field sets, the open-schema posture, and the absence of `reduced`/`summary` from `properties`. Lens A's `:25632-25641` and `:25652-25653` are both inside this one test, which runs to about `:25654` |
| `:25657` | `expand_output_is_bounded_to_the_typescript_token_budget` | The expand byte bound, not the token claim |
| `:25713` | `facade_never_panics_on_malformed_memory_arguments` | Total-function behaviour on bad arguments |
| `:25762` | `facade_advertises_anti_memory_but_keeps_mutation_host_owned` | The `ctx_memory` mutation refusal, asserting `isError == true` and the message text at `:25786-25790` |

### File-local tests in the 4d files

A category 4c did not have to handle: three of the four whole files assigned to 4d
carry their own test modules, which no `lib.rs` count reaches.

| File | Tests | What they cover |
| --- | --- | --- |
| `smart_note_evaluation.rs` | **7** | `:1101` replays the shared golden (13 constants, the backoff ladder, 23 transitions at `:1132`, 16 schedules at `:1145`, 9 selections at `:1156`); `:1190` and `:1765` replay `smart-note-evaluation-normative.json` (revision matrix, cycle traces); `:1528` and `:1549` the UTF-16 truncation rule; `:1558` extreme cron instants; `:1578` phase preference |
| `project_docs.rs` | **6** | `:132` empty, `:139` render and hash, `:152` canonicalization, `:168` symlink skip, `:188` size skip, `:212` golden |
| `memory_tool.rs` | **1** | `:396` `list_committed_claims_excludes_anti_memory_even_when_requested` |
| `dispatch.rs` | **0** | Its only checks are the integration binary below |

That is **14 file-local tests**, giving 102 in-crate checks for 4d. The four
fixture-group counts in the golden were re-derived from
`crates/mc-module/testdata/smart-note-evaluation-golden.json` at `HEAD`: 13
constants, 23 `transition_cases`, 16 `schedule_cases`, 9 `selection_cases`.

### Targets in scope with zero test-module references

Re-counted by matching each identifier across the whole file and again over
`:16001-30517` only.

| Target | Occurrences in file | In the test modules |
| --- | --- | --- |
| `claim_intent` (all four handlers, `:10068-10182`) | 15 | **0** |
| `claim_effects` (`handle_claim_effects_apply`, `:10184-10255`) | 2 | **0** |
| `claim.mirror` / `claim_mirror` (`:10257-10337`) | 28 / 20 | **0** (Part 3 covers the store side) |
| `note.delivery` / `handle_note_delivery_value` (`:11483-11545`) | 5 / 3 | **0** |
| `with_facade_command` | 5 | **0** |
| `facade_command_outcome` (`:15290-15311`) | 6 | **0** |
| `command_id_from_facade_request` (`:15246`) | 2 | **0** |
| `assemble_transform_page*` (`:13587-13699`) | 4 | **0** |
| `assemble_state_sync_seed` (`:13701-13784`) | 2 | **0** |
| `canonical_value` (`:15341-15372`) | 6 | **0** |
| `module_tools` | 1 | **0** |
| `project_docs` | 1 | **0** in `lib.rs`; 6 file-local |
| `smart_note_evaluation` | 6 | **0** in `lib.rs`; 7 file-local |

The mutation-ledger row needs a note so a later pass does not repeat either of two
opposite mistakes. `with_facade_command`, `facade_command_outcome` and
`command_id_from_facade_request` have zero symbol references in the test modules,
yet the ledger **is** exercised, through the `ctx_note` request path, by `:23243`.
A symbol scan alone would have called it untested; a behavioural claim alone would
have called it covered. It has behavioural coverage of the success-replay arm and
no unit coverage of anything.

### `#[ignore]`, `should_panic`, and property tooling

**`#[ignore]`: none found.** Zero occurrences in `lib.rs` or in the four 4d files.

**`should_panic`: 2**, both in 4d's native-attachment plumbing: `:20646` and
`:20695`, both asserting `"incremental native attachment cache drift"`, which is
the message of the production `assert_eq!` at `:13004-13007`. They are the only
tests in scope whose oracle is a panic rather than a value comparison.

**Property, mutation and concurrency tooling: none found.** Zero occurrences of
`proptest`, `quickcheck`, `loom`, `shuttle` or `miri` in `lib.rs` or the four 4d
files. No `mutants.toml`. No coverage configuration, so every placement statement
in this file is structural rather than measured. No `mc-module` entry in
`.config/nextest.toml`, so no 4d test is serialized, grouped, or
timeout-adjusted. The nearest thing to generated coverage is the pair of
table-driven fixtures, `smart-note-evaluation-golden.json` and
`smart-note-evaluation-normative.json`.

## Integration tests and CI status

**One integration binary is in 4d scope, it carries the strongest check in the
sub-part, and CI does not run it.**

`tests/prepared_output.rs` (282 lines, **10 tests**, both re-counted at `HEAD`)
imports only
`mc_module::dispatch::{PreparedOutcome, PreparedOutput, PreparedOutputError,
PreparedSegment, MAX_WIRE_BODY_BYTES}` (`:5-7`) and nothing else from the crate.
It tests `dispatch.rs`, which the scope map assigns to 4d, and 4c correctly
declined it (`../part-4c-handlers/existing-checks.md:128`, `:524`).

| Line | Test | Pins |
| --- | --- | --- |
| `:18` | `json_measurement_matches_small_and_facade_sized_bytes` | Measurement equals encoded length at two sizes |
| `:35` | `transform_segments_preserve_existing_golden_bytes` | Segment bytes replayed verbatim |
| `:87` | `cached_bytes_copy_only_after_destination_reservation` | No copy before reservation |
| `:104` | `typed_errors_and_stream_markers_have_no_prepared_body` | `Error` and `Streamed` reserve nothing |
| `:134` | `exactly_at_wire_cap_succeeds_without_destination_allocation` | The cap boundary, inclusive |
| `:148` | `cap_plus_one_and_arithmetic_overflow_fail_before_write` | Cap+1 and overflow fail during counting |
| `:200` | `cancellation_before_reservation_or_write_emits_nothing` | Both cancellation windows |
| `:207` | `reserve_denial_emits_nothing` | The denial arm |
| `:234` | `destination_failure_retains_no_partial_terminal` | A write error yields no terminal |
| `:254` | `inconsistent_source_reports_length_mismatch_without_emission` | The measure-equals-write claim, via `PreparedSegment::inconsistent_for_test` |

All ten are on one claim family, and the file re-implements the settlement loop by
hand (`:181-196`) because `settle_prepared_with` is private.

**The other six binaries are out of scope for 4d,** by 4d method-literal and
type-name count in each: `boundary_counter_durability.rs` 0,
`broca_roundtrip.rs` 0, `direct_host.rs` **0**, `host_adapter.rs` 1,
`lifecycle_cli.rs` 0, `release_contract_conformance.rs` 0.

That `direct_host.rs` count is the finding. 4c counts `direct_host.rs` as its best
end-to-end coverage, including a process restart with real state present, and it
never touches a facade name. **The facade has no end-to-end coverage through a
real `McHandler`.** 4d has ten integration tests, all on `dispatch.rs`, and zero
on the eleven routed facade names.

**CI, verified at `HEAD` against all five workflow files:** the only `mc-module`
test invocation is `cargo test -p mc-module --test lifecycle_cli`, `ci.yml:168` at
`76cd6f41` and `ci.yml:172` at `HEAD`. It selects `lifecycle_cli` and nothing
else, so `prepared_output.rs` is not built either. **All 102 in-crate checks and
all 10 `prepared_output.rs` checks run only on a developer's machine.**

## TypeScript-side gates

`ci.yml:257` runs `bun run test`, sweeping every `*.test.ts` under the plugin
tree. Four TypeScript files gate contracts this sub-part implements and **none of
them tests this Rust code.** Whether each is a parallel implementation or a fake
of the module is stated per row, because that distinction decides what the CI
green light means.

| File | Relationship to 4d | What it actually tests |
| --- | --- | --- |
| `smart-notes/evaluation-state.test.ts` (136 lines, 3 blocks) | **Parallel implementation, shared fixture.** The one genuine cross-language gate in scope | Loads `crates/mc-module/testdata/smart-note-evaluation-golden.json` (`:54`) and iterates `transition_cases` only (`:105`). Re-verified at `HEAD`: `schedule_cases` and `selection_cases` appear nowhere in the file |
| `magic-context/storage-notes.test.ts` | Parallel implementation, shared normative fixture | References `smart-note-evaluation-normative.json` (`:206`), the fixture the Rust `:1190` and `:1765` tests replay |
| `hooks/magic-context/module-state-sync.test.ts` | **Producer tested against a fake delivery.** Not a fake of this module's claim-effects handler, because the handler has no counterpart test to pair with | `:1400` and `:1424` call `drainClaimEffectPrefix` with an inline `deliver` closure (`:1405-1415`) returning the ack the producer requires (`:1414`). Separately, `:1510` is inside `class DeterministicClaimMirrorFacade` (`:1444`), which is claim-**mirror**, not claim-effects |
| `hooks/magic-context/module-wire.test.ts` | **Claim-mirror decode tests only.** Contains no test of the claim-effects wire validator | `ackedEffectId: 30` / `31` at `:345`, `:414`, `:427` are all arguments to `decodeClaimMirrorReceiptResponse`. `decodeClaimEffectDeliveryResponse` (`module-wire.ts:717`) has zero test references in `packages/plugin` |

The asymmetry 4c found holds here and is sharper, because the smart-note fixture
is **shared** rather than parallel. `PARITY.md:16` claims "Both replay the frozen
characterization fixture ... (transitions, DST schedule vectors, phase
selection)", and `smart_note_evaluation.rs:5-6` restates it as "lifecycle behavior
cannot drift between languages". That holds only if both replays run. One runs on
every pull request over 23 of the fixture's 48 cases; the other runs nowhere and
is the one covering the remaining 25.

The fixture-regeneration gate is documentation only. `PARITY.md:16` instructs
regeneration with `bun crates/mc-module/gen/gen-smart-note-evaluation-golden.ts`
and states that "a regeneration diff means a semantic change and requires
review". No workflow regenerates the fixture and diffs it, so a fixture that
drifts from the legacy writers it was generated from is caught by review alone.

## Production assertions and guards, clustered

Measured over production lines only: `lib.rs:10042-11917` and `:11919-16001`, plus
the four whole 4d files.

**Runtime assertions: three, of which two are compiled out of release.**

| Site | Guard | In release? |
| --- | --- | --- |
| `lib.rs:11250-11253` | `debug_assert!(proposed_cycle.is_some(), "fresh claim committed without a proposed cycle update")`, the sole enforcement of the fair-selection cursor invariant, with the failure it exists to catch named at `:11248-11249`: "stopped decrementing and fair rotation silently starves" | **No** |
| `lib.rs:13127-13130` | `debug_assert!(response.native_messages.is_some() \|\| response.native_messages_delta.is_some(), "successful serve_native response must carry full or delta native content")` | **No** |
| `lib.rs:13004-13007` | `assert_eq!(incremental_bytes, full_bytes, "incremental native attachment cache drift")`, the differential check behind the two `should_panic` tests | **Yes** |

So the one unconditional runtime assertion in about 9,000 production lines is a
differential equality on the native attachment path, and it sits inside a
differential block whose enabling flag this inventory did not trace. **Zero
compile-time `const _` assertions in scope**, unlike 4c's budget ceiling. The
cursor invariant that `PARITY.md:36-40` spends seventeen lines specifying is held
up by a `debug_assert!` alone.

**Panicking sites: two `unreachable!`, and nothing else.** Zero `panic!`, zero
`todo!`, zero `unimplemented!`, zero `.unwrap()` in either `lib.rs` range.
`:12165` fires on `PreparedOutcome::Response` in `settle_prepared_with`'s
re-match, and it is genuinely unreachable as written because the outer `let ...
else` already excluded that variant; it sits on the response path every reply
passes through, so a refactor of the `else` block converts a compile-time
impossibility into a production panic. `:15735`,
`unreachable!("the connect-failure CAS loop returns from both attempts")`, is the
sole written statement of that loop's invariant. Neither has a named test.

**`.expect(`: 40 across the two `lib.rs` ranges** — 4 in `:10042-11917`
(`:10946`, `:11022`, `:11082`, `:11186`, all four note-evaluator mutex labels) and
36 in `:11919-16001`, concentrated in the health and status envelope
(`:12053-12099`, 14 sites) and the native serializers (`:12588`, `:13003`,
`:13005`). The three named non-mutex labels are `"full native output must
serialize"`, `"incremental native output must serialize"` and `"OpenCode sidecar
metadata must serialize"`. **None has a named test.**

**The four 4d files.** `dispatch.rs` is the safest: 2 `.expect(`, zero `unwrap`,
zero `panic!`, zero assertions, and the guard it relies on is a returned `Err`.
`smart_note_evaluation.rs` carries 19 `.expect(`, 19 `.unwrap()` and 14 `panic!`,
all inside the test module at `:951-952` and its fixture parsing, so the
production half of the file has none. `project_docs.rs` has 1 `.expect(` and 15
`.unwrap()`, all in the test module at `:120-121`. `memory_tool.rs` has 3
`.unwrap()`.

**Typed rejection guards: about 35 distinct error codes, and this is where the
invariants live.** With one release-time assertion in 9,000 lines, every other
guarantee is a `Result` or a typed code, so a violated invariant becomes a code a
caller may or may not surface. Counted over `:10042-16001`, the most-used are
`note_store_failed` (5 sites, collapsing every store failure on the
note-evaluation protocol), `encode_failed` (4), `route_unbound` (3),
`claim_intent_encode_failed` (3) and `bad_request` (3). The note-evaluation
protocol contributes `protocol_unsupported`, `protocol_retired`,
`positive_wait_unsupported` and `registration_unknown`. **The claim ledger's three
codes are one per handler** — `claim_intent_stage_failed`,
`claim_intent_inspect_failed`, `claim_intent_ack_failed` — each collapsing every
`Err` including an identity conflict, which is why a digest conflict and a store
fault are indistinguishable to a caller. Two codes exist purely to convert a
nominally successful transform into a typed error,
`transform_native_response_omitted` and `transform_delta_unexpanded`
(`respond_transform`, `:13366-13381`), which is the shape the facade itself lacks.

**Closed-schema decode: exactly one runtime site.** `note_evaluation_body`
(`:13885-13905`) walks every key and rejects anything outside its allow list
(`"unknown field '{key}'"`, `:13897`) and requires the protocol marker
(`"'v' must be 2"`, `:13902`). The claim wire structs use `deny_unknown_fields`
(`mc-core/src/claim_operation.rs:313,352,360,406,417,438,450,460,468,475`, plus
`lib.rs:140` and `:147`). All five `ctx_*` tools go through `facade_arguments`
(`:14419-14435`), which clones the argument map with no key walk, and their four
advertised schemas match that openness deliberately, `additionalProperties: true`
at `:15846`, `:15929`, `:15950` and `:15963`. Three strictness tiers, one surface.

**Response fields carrying a semantic promise: seven.** Counted over
`:10042-16001`: `ok` (6 sites), `replayed` (5), `wake_owned` (5), `dismissed` (4),
`ackedEffectId` (2), `isError` (2, the two constructors at `:13791-13800`),
`cycle_exhausted` (1). `replayed` is the only idempotency signal on the facade and
it appears on three of the eleven routed names; `cycle_exhausted` is a single-site
field carrying a two-cause distinction `PARITY.md:41-52` spends twelve lines on.

**Discarded results: three `let _` sites**, all in `:11919-16001` — `:12337`,
`:12539`, `:12617` — and **zero in `:10042-11917`**. Lower than 4c's six. Whether
each is licensed by a comment was not read; `:12539` is `let _ = mode;`, which is
a parameter suppression rather than a discarded fallible call.

**Conventionally-enforced-only claims: eight.**

1. Four hand-written mutex labels on the note-evaluator registry, `"note
   evaluator registrations mutex"` (`:10946`, `:11022`, `:11082`) and `"note
   evaluator slot cycle mutex"` (`:11186`). Same shape as 4c's 36 labels at a
   twelfth the count.
2. `ctx_note`'s five unadvertised-but-honoured keys. The handler caps and reads
   `compiled_provider`, `compiled_config`, `compiled_at` and `compile_status`
   (`:11558-11560`, `:14456-14474`) and accepts `command_id` (`:11592-11599`),
   while the advertised property set is asserted to be exactly eight keys
   (`:25559-25571`, asserted at `:25650`). The convention "the schema is the
   compatibility surface, the handler is wider" is stated only as that assertion.
3. `MAX_TRANSFORM_FRAME_BYTES`. "Half of 64 MiB" lives in prose at
   `:14280-14283`; the constant at `:14284` is the literal `32 * 1024 * 1024`.
   This is the exact drift `dispatch.rs:7-11` was written to prevent, one file
   over, where `MAX_WIRE_BODY_BYTES` is derived from `mc_host::MAX_FRAME_BODY_LEN`
   at `dispatch.rs:12` instead. `MAX_FACADE_FRAME_BYTES` (`:14279`) has no stated
   derivation at all.
4. The `dispatch.rs` no-content-in-diagnostics discipline. All three `Debug` impls
   print lengths and kind tags only (`:81-88`, `:192-203`, `:212-224`). Applied
   three times, stated nowhere, and the response path does the opposite.
5. The advertised-versus-accepted name set. Nothing ties `handle_facade_value`'s
   eleven match arms (`:10046-10057`) to `module_tools`, and the only prose
   statement of the set (`:12344-12351`, "Only ctx_memory and ctx_search are
   accepted on that surface") names two.
6. `context_db_schema_version` is null because the module never attaches the file
   (`:15447-15455`). The prohibition is a whole-crate absence claim with no guard.
7. The `"raw-only fence"` marker (`:13208`) and `"recorded dreamer response is not
   valid JSON"` (`:13184`). Both name contracts; neither appears in any test.
8. `ExecutionMode` as a mutation declaration. Nothing checks a handler against its
   declared mode, and `ctx_memory` is the counter-example: declared `Mutating`
   (`prompt_surface.rs:209`), refuses every mutation
   (`"Error: claim mutations require the host claim-operation commit path."`,
   `lib.rs:10692-10694`).

## Test support and fault-injection seams

**In-scope seams: one, and it is the only reason the measure-equals-write claim is
provable.** `PreparedSegment::inconsistent_for_test` (`dispatch.rs:64-71`, doc at
`:64`: "Constructs a deliberately inconsistent segment for length-check tests"),
consumed by `prepared_output.rs:254`. Production has no source whose measured and
written lengths differ, so without this seam the length check would be
unfalsifiable.

**Injectable zone on the reducer.** `reduce_smart_note_evaluation` takes the
timezone as a parameter; production passes `&chrono::Local` at `lib.rs:14244`, and
`chrono-tz` is already a `[dev-dependencies]` entry
(`crates/mc-module/Cargo.toml:67`). So a two-zone differential on the reducer needs
no seam and no process manipulation. What that does **not** reach is the
host-dependence half, which is a property of the production call site.

**Store-side seam relevant to this part: the arbitrary-SQL seam, and it is wider
than a sibling part recorded.** `execute_tag_sql_for_test`
(`crates/mc-store/src/lib.rs:6431-6439`) runs caller-supplied SQL through
`conn.execute_batch`, and the feature it sits behind is **enabled for `mc-module`
tests**: `mc-store = { workspace = true, features = ["test-support"] }` in
`crates/mc-module/Cargo.toml:66-72`, specifically `:71`. Its doc comment scopes it
to "proving trigger-backed cache invalidation", but `execute_batch` accepts any
statement, so an `AFTER INSERT ... RAISE(ABORT)` trigger on any table is
installable from a module test today. See `fault-map.md` for what that unblocks
and for the correction it forces on 4c's framing.

**Other store-side seams, none of which is a named write-failure injector.**
`fail_next_historian_side_channel_for_test` (`mc-store/src/lib.rs:5249`),
`set_before_max_compartment_end_read_hook` (`:5283`),
`set_abandon_historian_hook` (`:5294`), the read-only counters
`tag_number_query_count_for_test` (`:6426`) and
`authority_seed_transaction_count_for_test` (`:11992`), and two seeders (`:6654`,
`:7083`).

**Dead test hooks in 4d scope: none found.**

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any check proves.

1. **The claim intent ledger and claim effects are the quietest thing in 4d, and
   they contain the one success-shaped path untested in both languages.**
   `claim_intent` has 15 whole-file occurrences and **0** in the test modules;
   `claim_effects` has 2 and **0**. That is `:10068-10255`, **188 production
   lines** routing **four** facade names, three of which call `claim_route_root`
   and then discard its result (`:10120-10122`, `:10154-10156`, `:10185-10187`)
   despite the function's own doc at `:10062-10067` calling the bound route "the
   only trustworthy authority identity on the request". Of the six success-shaped
   error paths, `claim.effects.apply` is the one with no test on either side of
   the language boundary, and the module's own doc says nothing about the ack
   being validation-only. Contrast the neighbouring
   `handle_claim_intent_stage`, which does pass the route root to the store at
   `:10100` — one of four, with no stated reason for the asymmetry.

2. **Six success-shaped error paths, one tested.** An error delivered inside a
   transport success, with `isError: false` or with no field distinguishing it
   from a hit:

   | Path | Location | Tested? |
   | --- | --- | --- |
   | `isError` inside a successful transport response | Every `tool_error_result` is a `PreparedOutcome::Response`; `health()` (`:12003-12046`) reports `Ok` while every facade call fails | **No.** No test asserts `health()` stays `Ok` while the facade fails |
   | `ctx_reduce`'s queued acknowledgement | `mcp_text_result(format!("Queued: {}.", ...), false)` at `:10587`, after the comment at `:10585-10586` states it "deliberately does not mutate" | **Yes**, `:25445` asserts the no-write behaviour |
   | `claim.effects.apply`'s ack | `:10184-10255`, returning `"ackedEffectId": previous` at `:10253` with no store call | **No**, on either side. Item 1 |
   | Note CAS conflict recorded as the command's durable outcome | `Ok(facade_text_response(..., true))` at `:11865-11870`, inside the ledger closure | **No.** `:23243` proves a recorded **success** replays; nothing replays a recorded failure |
   | Dismiss-not-found recorded the same way | `:11902-11907` | **No** |
   | `ctx_expand`'s two unrecoverable-content answers | `:10804-10809` and `:10832-10838`; the second's text is rendered at `:14638`, and the sibling `"No messages found in range"` at `:14717` and `:15000` | **No** as *classification*. `:24517` and `:25657` cover the budget, not the `isError` value |

   One of six has a check, and it is the one whose behaviour was deliberate. Two of
   the six are on `ctx_expand`, whose entire purpose is recovering content the
   agent already lost. The tested one is the **first** row, `ctx_reduce`, covered
   in this crate at `lib.rs:25445-25474`. `catalog.md` previously attributed that
   coverage to the second row and placed it across a language boundary; this table
   was right and the catalog has been corrected to match it.

3. **The daylight-saving schedule and phase-selection halves of the shared
   cross-language fixture are pinned by one replay that runs nowhere.** The
   fixture exists to prevent cross-language drift and `PARITY.md:16` names all
   three case groups. 16 `schedule_cases` and 9 `selection_cases` are asserted
   only by `smart_note_evaluation.rs:1145` and `:1156`, in a test module CI never
   compiles, while the TypeScript half replays the 23 `transition_cases` on every
   pull request (`evaluation-state.test.ts:105`) and touches neither other group.
   So 25 of the fixture's 48 cases are enforced by a check that runs on no
   machine but a developer's, and the claim that lifecycle behaviour "cannot
   drift between languages" rests on them.

4. **`handle_note_delivery_value` has zero references.** 63 production lines
   (`:11483-11545`) carrying three rejections including `"delivery
   acknowledgement session_id does not match the channel binding"` (`:11516`),
   which is a cross-session guard. `note.delivery` appears 5 times in the file and
   0 in the tests. This is the delivery half of the note lifecycle whose
   acquisition half has 17 tests.

5. **The claim mirror facade handlers have zero module-side references.**
   `claim.mirror` appears 28 times in the file and 0 in the test modules. Part 3
   owns the store side and the scope map records that boundary, but the
   module-side protocol-version gates at `:10279` and `:10317` and the
   presence-only route checks at `:10262` and `:10300` are on 4d's side of it, and
   nothing in either crate covers them.

6. **Page and seed reassembly has zero references and seven distinct
   rejections.** `assemble_transform_page*` (4 occurrences, 0 in tests) and
   `assemble_state_sync_seed` (2, 0) span `:13587-13784`, with continuation-marker
   rejections at `:13584`, `:13601`, `:13606`, `:13612`, `:13619`, `:13627` and
   `:13655`. 4c found the paged-transform *protocol* to be its quietest surface,
   with a CI-gated TypeScript sender; the reassembly half sits in 4d and is
   equally quiet. The two halves of one protocol are unowned in two adjacent
   sub-parts.

7. **`canonical_value` has zero references** (6 occurrences, `:15341-15372`).
   Canonicalization is what makes the facade command ledger's identity stable
   across argument reorderings. Nothing pins it, and the ledger's `command_id`
   replay contract depends on it.

8. **The project-docs TOCTOU re-check has no test.** `project_docs.rs:10-11`,
   restated at `:59-60`, claims "the regular-file + size check is RE-DONE at read
   time to close the TOCTOU gap between fingerprint and read", and the threat
   model is stated at `:7-8` as exfiltrating `~/.ssh/id_rsa` into the trusted m0
   baseline. The file has six tests, including `symlinked_doc_is_skipped` (`:168`)
   and `oversized_doc_is_skipped` (`:188`), and none of them swaps the path
   between the `symlink_metadata` at `:69` and the `fs::read_to_string` at `:73`.
   The strongest security claim in the sub-part rests on the one line no test
   exercises.

9. **`facade_arguments`' unwrap branch is unreached and its sibling is tested.**
   `:25333` proves the precedence half — with a primary field present, the
   `reduced`/`summary` envelope is preserved verbatim and a stray key survives —
   and no test drives the branch where the envelope becomes the argument map
   (`:14421-14434`).

10. **The facade has no end-to-end coverage through a real `McHandler`.**
    `direct_host.rs` has zero 4d method literals; `host_adapter.rs` has one. 4c
    could point at three integration tests driving real handlers, one across a
    process restart. 4d has ten integration tests, all on `dispatch.rs`, and zero
    on the eleven routed facade names.

11. **One unconditional runtime assertion in about 9,000 production lines**, and
    it is a differential equality on the native attachment path (`:13004`). The
    other two guards are `debug_assert!`, and one of them is the sole enforcement
    of the cursor invariant `PARITY.md` specifies over seventeen lines.

12. **Four hand-written mutex labels with no consistency check.** Same shape as
    4c's finding at a twelfth the count. Listed because the enforcement is zero,
    not because the consequence is large.

## Sampling limits on this inventory

Six limits, stated so a later pass does not read absence as absence of risk.

- **The four-tier attribution brackets rather than pins.** 232 / 88 / 65 / 49
  comes from symbol matching plus a helper fixpoint over parsed test bodies, not
  from coverage instrumentation, which this repository does not have. The 256
  attribute count, the 248 + 8 split, the first and last `fn` lines, the four
  per-file test counts, the four fixture group sizes, the ten
  `prepared_output.rs` tests and both `ci.yml` line numbers were obtained
  directly at `HEAD`.
- **The 232 reach tier is shared evidence, not 4d evidence.** `PreparedOutcome`
  and `mcp_text_result` are crate-wide vocabulary. A reader counting 4d coverage
  must not mistake reach for claim, in either direction: the 88 excludes 144 tests
  that execute 4d lines.
- **The 88-versus-28 reconciliation is a band, not a number.** 4c's 28 measures a
  hand-off, this part's 88 measures a total, and the shared subset is 11 by direct
  symbol match and up to 49 by 4c's name rule. Both figures are correct for what
  they measure and no correction is issued.
- **The helper population is 117 by the fixpoint's own detector and 119 by an
  independent recount.** Neither figure changes a count in this file. It is
  recorded because 4c reported 119 by the same description, so a later pass
  comparing the two inventories would otherwise see an unexplained difference.
- **Two boundaries are contested and both are named at every citation.** The
  native-attachment caches are 4c's while the plumbing at `:12450-13055` is 4d's,
  so the 20-test cluster is shared. The claim-mirror store side is Part 3's while
  the module-side gates are 4d's. Neither is settled here.
- **Whether a never-executed test counts as `Exercised: partial` is unresolved,
  and it governs all 112 checks inventoried above.** 4c raised it, the scope map
  raised it at `:681`, lens A and lens C raised it. It needs a human ruling, not
  a synthesis decision.
