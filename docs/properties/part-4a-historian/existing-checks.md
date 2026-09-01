# Part 4a existing-check inventory

Every claim-bearing check for the historian subsystem:
`crates/mc-module/src/historian.rs`, `historian_producer.rs`,
`historian_chunk.rs`, `historian_validate.rs`, the `lib.rs` historian and wrapup
regions, and the store-side publish transaction at
`crates/mc-store/src/lib.rs:9360-9500`.

Provenance: `HEAD` = `76cd6f41`. Every `mc-module` and `mc-store` line reference
below is both the working-tree and the `HEAD` line, because
`git status --porcelain` reports `crates/mc-module` and `crates/mc-store` clean.
`.github/workflows/ci.yml` **is** modified in the working tree, so every CI
reference is stated against `HEAD` with the working-tree line noted where it
differs, per METHOD.md rule 1.

An existing check does not remove a property from the catalog. Every status below
is **unaudited**: test adequacy belongs to `/testing:invariant-test-review`, and
production assertion adequacy to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## The coverage fact that frames this inventory

**Nothing in this scope executes in CI.** That is the dominant fact of Part 4a,
and it is stronger here than in Part 3, because here a large and carefully built
test suite exists and none of it runs.

The subsystem has **141 in-crate tests**:

| Target | Tests | Executed in CI |
| --- | --- | --- |
| `historian.rs` | 51 | **No** |
| `historian_validate.rs` (`:1383-1848`) | 19 | **No** |
| `historian_chunk.rs` | 19 | **No** |
| `historian_producer.rs` | 18 | **No** |
| `lib.rs`, historian and wrapup | 34 | **No** |
| **Total in-crate** | **141** | **No** |
| `crates/mc-store/src/lib.rs`, publish transaction (`:16625-18336`) | 7 | **No** |
| `crates/mc-module/tests/` mentioning the historian | **0** | n/a |

The total is a correction. Every earlier version of this table and of the prose in
`catalog.md` and `fault-map.md` said 121, which was an arithmetic slip rather than
a miscount: 51 + 19 + 19 + 18 + 34 is 141, and each of the five per-file figures
was independently re-verified at HEAD by counting `#[test]`, `#[tokio::test]`, and
`#[tokio::test(...)]` attributes. The unprotected suite is twenty tests larger than
this part previously reported.

Three mechanical facts produce that column, each verified at `HEAD`:

1. **The only `mc-module` test invocation in any workflow is
   `cargo test -p mc-module --test lifecycle_cli`,** at `ci.yml:168` at `HEAD`
   and `ci.yml:172` in the modified working tree. `--test lifecycle_cli` selects
   one integration binary and does **not** build the `--lib` target, so no
   in-crate `mc-module` unit test is compiled in CI, let alone run. The full set
   of Rust test invocations at `HEAD` is `ci.yml:131`, `:168`, `:173`, `:174`,
   `:180`, `:181`, `:183`, and `:186`; six of the eight target `mc-host`,
   `mc-shm-native`, or `mc-shm-transport`. There is no `--workspace` test run and
   no `cargo test -p mc-module --lib` anywhere.
2. **Of the crate's 938 tests, 926 never execute.** 938 verified by counting
   `#[test]`, `#[tokio::test(`, and `#[tokio::test]` across
   `crates/mc-module/src` (900) and `crates/mc-module/tests` (38).
   `lifecycle_cli` contributes 12. The remaining 926 include all 141 named above.
3. **`mc-store` appears in no workflow at all.** Verified by searching all five
   files in `.github/workflows/` at `HEAD`: zero matches in `ci.yml`,
   `historian-eval.yml`, `retrieval-benchmark.yml`, `claude-code-review.yml`, and
   `shm-hardening-optin.yml`. The commit point of the whole subsystem therefore
   lives in a crate no automation touches.

**Zero integration tests in `crates/mc-module/tests/` mention the historian.** A
case-insensitive search for `historian` across all seven files there and both
files in `crates/mc-module/tests/support/` returns zero matches. The seven
binaries hold 38 tests between them (`boundary_counter_durability` 1,
`broca_roundtrip` 2, `direct_host` 6, `host_adapter` 4, `lifecycle_cli` 12,
`prepared_output` 10, `release_contract_conformance` 3), and not one names this
subsystem. Every check on the historian is an in-crate unit test compiled into
the `--lib` target that CI does not build.

The consequence for every record in this part is that `Exercised: partial` means
"a test exists on a developer's machine". METHOD.md's `Exercised` field does not
yet distinguish that from `not yet`; all three lenses raise the question and it
is recorded as needing human input rather than resolved here.

## The TypeScript "historian-eval" gates test a different implementation

This section is separate because these gates are the **only** historian-adjacent
coverage that executes on every pull request, and because what they cover is a
parallel implementation of the same contract rather than the code this part
catalogs. Reading them as coverage of the Rust historian would be the single
easiest mistake to make about this subsystem.

The gate is one CI job, `historian-eval-contracts`, at `HEAD` `ci.yml:407-432`
(working tree `:415-440`). Its comment block at `HEAD` `:394-406` says the job
exists because "Nothing invoked test:historian-eval-unit" before it, and that it
declares no `needs` so an unrelated lane failing first cannot skip it. Three
steps:

| Step | `HEAD` line | Command | What it checks |
| --- | --- | --- | --- |
| Historian eval unit contracts | `ci.yml:426` | `bun run test:historian-eval-unit` | Six unit test files under `src/historian-eval/`: `contract.test.ts`, `dev-corpus.test.ts`, `mutations.test.ts`, `payload.test.ts`, `promote.test.ts`, `scorer.test.ts`. `runner.test.ts` is excluded as harness-booting (`run-test-selection.ts:59-70`, `:84`). |
| Freeze lint over the dev corpus | `ci.yml:429` | `run-historian-eval.ts --lint` | Scenario-schema and freeze conformance of the `historian-eval/dev` corpus. Corpus hygiene, not module behaviour. |
| Invalid-state mutation battery | `ci.yml:432` | `run-historian-eval.ts --mutations` | Seven mutation classes with pinned outcomes (`mutations.ts:33-56`): `speculation-promoted` and `rejected-proposal-active` must score `FAIL:false-authoritative`; `wrong-category` and `dropped-gold-fact` must score `FAIL:recall`; `near-miss-perturbation` either; `structural-overlap` must land at `validation-rejected`; `probe-wrong-answer` must fail probe comparison. The battery fails on a **stage** mismatch, not only on a PASS (`mutations.ts:5-11`). |

**These gates call no Cargo target.** Verified by reading the scorer's imports.
`scorer.ts:20-26` imports `validateHistorianOutput`,
`validateStoredCompartments`, `shouldDiscardLastHistorianCompartment`, and
`HISTORIAN_BOUNDARY_HEALING_SLACK` from
`packages/plugin/src/hooks/magic-context/compartment-runner-validation.ts`, and
`:27-28` imports `appendCompartments` and `promoteSessionFactsDurable` from the
plugin's own storage and promotion modules. `mutations.ts:14` imports the slack
constant from the same TypeScript module. The `scoreRawOutput` seam the battery
drives is TypeScript-parse, then TypeScript-validate, then publish into a Bun
SQLite temp database (`scorer.ts:715`, `:762-764`). No `mc-module`, no
`historian_validate.rs`, no `historian_producer.rs`.

**The lane's own selection code excludes the Rust producer.**
`run-test-selection.ts:73-76` states that the harness-booting tests are "TS-mode
only: `mc-module`'s Rust historian producer does not promote claims, so these
must never join a rust or pi selection." The exclusion is deliberate and
documented.

**The lane's README names its corpus as the untapped cross-language vector set.**
`historian-eval/README.md` says the frozen corpus's crafted-wrong outputs "are
also the best TS<->Rust validator differential vector set the repo has (reuse
deferred, see plan scope)." That is the repository's own assessment, recorded
here as a lead rather than as a plan.

`historian-eval.yml` is the live lane. Its README records it as
`workflow_dispatch` and `schedule` only, with manual dispatch restricted to the
default branch because the job puts an API key in the job environment. It runs no
Rust target either.

So: the executing per-PR coverage measures a TypeScript implementation of the
same contract. The only artifact tying the Rust implementation to it is one
in-crate test, `validate_golden_matches_typescript_oracle`
(`historian_validate.rs:1384`), driven by a checked-in
`testdata/validate-golden.json` with 16 cases, and that test does not run in CI
either. **Nothing executing anywhere compares the two implementations.**

## In-crate tests, clustered with counts and line ranges

Counts obtained by matching `#[test]`, `#[tokio::test]`, and `#[tokio::test(...)]`
in each file, then listing each following `fn` line. Every count below was
re-verified at `HEAD`.

| File | Tests | Attribute range | First / last test fn |
| --- | --- | --- | --- |
| `historian.rs` | **51** (13 sync, 38 tokio) | `:1862-4646` | `:1863` `stored_compartment_legacy_flag_tracks_p1_presence` / `:4647` `restart_mid_publishing_with_committed_tx_detects_idle` |
| `historian_validate.rs` | **19** (all sync) | `:1383-1848` | `:1384` `validate_golden_matches_typescript_oracle` / `:1849` `force_keep_last_preserves_final_compartment_and_side_channels` |
| `historian_chunk.rs` | **19** (all sync) | `:1299-2044` | `:1300` `chunk_uses_flat_block_ids_and_covers_system_ordinals_without_their_text` / `:2045` `fixture_builder_drives_boundary_chunk_assembly` |
| `historian_producer.rs` | **18** (2 sync, 16 tokio) | `:1711-2288` | `:1712` `start_opens_expected_identity_and_sends_once` / `:2289` `a_successful_drain_returns_text_and_the_length_cap` |
| `lib.rs`, historian and wrapup | **34** | within the test module opening at `:15993` | `:16445` `historian_trigger_token_reuse_matches_retokenized_production_shape` / `:30037` `status_diagnostics_surface_pending_historian_side_channel_failure` |

### `historian.rs`, 51 tests, six clusters

- **Pure state machine and projection**, 5: `:1863`, `:4213`, `:4243`
  (`pure_state_machine_happy_path_and_single_flight`), `:4286`, `:4379`.
- **Lineage and session-id isolation**, 3: `:2146`
  (`full_lineage_hash_separates_keys_that_collided_at_32_bits`), `:2163`
  (`producer_session_ids_are_lineage_scoped_under_one_project`), `:3011`
  (`concurrent_lineages_reattach_and_publish_in_isolated_sessions`).
- **The wired happy path and content-drift fences**, 7: `:2272`, `:2323`
  (`selected_range_identity_drift_during_await_rejects_without_cooldown`),
  `:2369` (`tail_identity_extension_during_await_still_publishes`), `:4061`,
  `:4314` (`fingerprint_mismatch_at_publish_abandons_and_releases_single_flight`),
  `:4401`, `:4451`
  (`compartment_generation_fence_releases_overlapped_publish_to_idle`).
- **The fallback chain and error classification**, the largest cluster at 14:
  `:2410`-`:2850`, plus `:3895` and `:3938`.
- **Reattach and timeout recovery**, `:2881`-`:3610` plus `:4533`: includes
  `reattach_terminal_redrains_from_start_without_second_send` (`:2881`),
  `reattach_equal_length_identity_drift_rejects_before_publish` (`:2942`),
  `reattach_redrains_full_run_from_start` (`:3138`),
  `reattach_fingerprint_mismatch_recovers_to_idle_and_releases_routes` (`:3776`),
  and `reattach_carries_durable_revert_epoch_to_publish` (`:4533`).
- **Cancellation-proof and cleanup discipline**, 5: `:3329`, `:3389`
  (`unconfirmed_cancellation_stops_the_fallback_chain`), `:3444`
  (`uncertain_cancel_send_outcomes_stop_the_fallback_chain`), `:3498`
  (`a_terminal_cancel_error_never_authorizes_fallback`), `:3542`. All three
  cancellation-proof tests cover the **output** branch; none covers the
  start-failure branch.
- **Restart load**, 2: `:4596` (`restart_mid_awaiting_exposes_reattach_ids`),
  `:4647` (`restart_mid_publishing_with_committed_tx_detects_idle`). Both
  simulate a restart in process; neither terminates one.

### `historian_validate.rs`, 19 tests

Clusters: one TypeScript-oracle golden driver (`:1384`) plus a determinism check
(`:1417`); gap and healing behaviour (`:1426`
`five_message_narrative_gap_rejects_like_typescript_validator`, `:1443`
`twenty_message_tool_only_gap_heals_like_typescript_validator`, `:1683`, `:1710`,
`:1730`); tier parsing and the p1-only fallback (`:1463`, `:1483`, `:1512`);
our-own-input validation (`:1531`, `:1576`); discard-last and its guards
(`:1633` `discard_last_progress_guard_boundary_k1_vs_k2`, `:1748`, `:1849`);
envelope and anchorability (`:1653`, `:1665`
`compartment_end_must_be_anchorable`); side-channel suppression (`:1774`
`zero_side_channel_anchor_is_suppressed`, `:1815`).

The 19 count and the `:1384-1849` fn-line span are correct; the attribute lines
are `:1383-1848` and the last test body runs to the file end at `:1869`.

### `historian_chunk.rs`, 19 tests

Chunk construction and ordinal coverage (`:1300`, `:1368`, `:1391`, `:1498`,
`:1651`); tool-arc and duplicate-id resolution (`:1432`, `:1818`); the substance
floor and its bypasses (`:1772`, `:1784`
`fold_only_fires_below_substance_floor_without_emergency`, `:1793`
`below_budget_refuses_normally_but_fires_in_emergency`); budget, truncation, and
multibyte handling (`:1854`, `:1887`, `:1920`, `:1933`); two golden-fixture
drivers (`:1962`, `:2045`).

### `historian_producer.rs`, 18 tests

The ambiguous-send replay fence is the densest cluster in the subsystem, seven
tests at `:1712`-`:1978`, including
`same_daemon_and_identity_resends_exact_bytes_once` (`:1734`),
`second_unknown_outcome_stops_without_third_attempt` (`:1754`),
`changed_daemon_returns_typed_unknown_without_resend` (`:1772`), and
`any_semantic_identity_change_prevents_resend` (`:1793`). Then route and
connection cleanup (`:2021`, `:2070`, `:2100`, `:2135`); the closed wire
vocabulary (`:2175` `run_state_mapping_is_closed_over_known_states`, `:2222`,
`:2247`); budget and drain (`:2193`, `:2289`).

### `lib.rs`, 34 historian and wrapup tests

Dominated by `session.wrapup`, roughly twenty tests from `:27928` to `:29335`,
covering the drain to the keep watermark, budget bounds, terminal replay,
snapshot leases, and epoch fencing. Then the handler-level autonomous cycle
(`:26660`), status and diagnostics (`:26623`, `:27246`, `:30037`), seeded-phase
recovery (`:29822`, `:29827`, `:29832`), backoff (`:30010`), trigger behaviour
(`:16445`, `:16518`, `:16720`), and shutdown of spawned historian work
(`:16932`, `:17007`, `:17017`).

### The store-side publish transaction, 7 tests

In `crates/mc-store/src/lib.rs`, which holds 101 tests in total. All seven were
re-verified by name and line at `HEAD`:

| Line | Test |
| --- | --- |
| `:16625` | `historian_publish_failure_counter_accumulates_and_success_state_resets` |
| `:16688` | `matching_historian_abandon_fences_predicate_and_update_for_both_backoffs` |
| `:16781` | `publish_historian_chunk_rejects_overlapping_compartment_as_typed_error` |
| `:16984` | `publish_historian_chunk_persists_transcript_inside_cas` |
| `:17017` | `publish_historian_chunk_cas_conflict_leaves_no_transcript_row` |
| `:18221` | `publish_historian_chunk_fails_loud_from_non_publish_state` |
| `:18336` | `publish_historian_chunk_rejects_recut_epoch_mismatch_as_conflict` |

Plus two side-channel outbox tests at `:16829` and `:16927` and two fixture
helpers at `:16583` and `:16666`. So the commit point is not untested; it is
untested **in CI**, and per lens A none of the seven asserts that all six writes
in the transaction land or none do.

### `#[ignore]`, `should_panic`, and property tooling

**None found.** No `#[ignore]` and no `should_panic` in the four scope files. No
`loom`, `shuttle`, `miri`, `proptest`, `quickcheck`, or `arbitrary` anywhere in
the historian path, so every check in this part is a hand-written fixture case or
a hand-written loop. There is no coverage measurement, so every placement
observation in this file is structural, not measured.

## Production assertions and guards, clustered

**Explicit `assert!` or `debug_assert!` in the four scope files: none found.**
Verified per file over production lines only, cutting each file at its last
`#[cfg(test)]`: `historian.rs` (`:1821`), `historian_producer.rs` (`:1486`),
`historian_chunk.rs` (`:1171`), `historian_validate.rs` (`:1305`). Zero
assertions of either kind. All invariant enforcement is by `Result`-returning
guards.

**Panicking sites in the four scope files: two, both narrow, both unaudited.**

- `historian.rs:1492`, `RestartAction::ReattachProducer { .. } => unreachable!()`.
  Verified as the only `unreachable!`, `panic!`, or `todo!` in production code
  across the four files; the eight other `unreachable!()` occurrences in
  `historian.rs` (`:2903`, `:2964`, `:3045`, `:3160`, `:3213`, `:3802`, `:4552`,
  `:4613`) are all inside the test module that opens at `:1862`.
- `historian_validate.rs:929`,
  `.expect("non-empty omitted present ordinals checked above")`, the only
  `.expect` in the four files, inside the gap-healing path.

Neither has a named test.

**Infallible-by-construction unwraps.** 27 in `historian_validate.rs` and 8 in
`historian_chunk.rs`; every one sampled is a static regex compilation inside a
`OnceLock::get_or_init` (`historian_validate.rs:1159-1195`,
`historian_chunk.rs:1133-1168`). None depends on runtime data. Zero unwraps in
`historian.rs` and `historian_producer.rs` production paths.

**`debug_assert!` in the in-scope `lib.rs` regions: three.** All compiled out of
release builds.

- `lib.rs:5068-5074`, "fold-only profile must not carry frozen tail reductions":
  asserts no `red:*` frozen unit exists when `fold_is_only_reclaim` is true.
- `lib.rs:6478-6481`: pins the wrapup disposition to
  `"completed" | "nothing_to_compact" | "failed"`, the machine-readable contract
  a consumer parses.
- `lib.rs:7065-7069`: the wrapup drain reached the keep watermark unless a failure
  stopped it. The comment at `:7061-7064` states the design choice explicitly:
  "compartments never shrink, so a failure-free exit has reached the keep
  watermark. Assert the invariant instead of carrying a round-cap fallback." A
  `debug_assert!` is standing in for the round cap the loop deliberately does not
  have.

**The `mc-store` publish transaction has no assertions of any kind.** Verified
across `crates/mc-store/src/lib.rs:9340-9560`: zero `assert!`,
`debug_assert!`, `.unwrap()`, or `.expect()`. Every failure is a typed
`PublishTxnOutcome` variant.

**Guard clusters, all unaudited.** These are where the subsystem's invariants
actually live, since there are no assertions:

- **The seven store-side publish gates** (`mc-store:9373-9455`): row-version CAS
  (`:9373-9382`), durable phase (`:9389-9396`), predicate identity over five
  fields (`:9398-9407`), content freshness over `selected_range_identities`
  including the empty-vector rejection (`:9413-9425`), revert epoch
  (`:9427-9434`), compartment-set generation re-read inside the transaction
  (`:9436-9455`), and the range-overlap backstop in `append_compartments_tx`
  (`:12634-12652`).
- **The 22 rejecting validation checks** enumerated by lens B
  (`historian_validate.rs:267-1081`), plus one reject that fires before the gate
  is entered: `historian.rs:1666-1671` refuses an output the producer marked
  `length_capped`.
- **The nine silent parse-time drops** (`historian_validate.rs:289-296`,
  `:297-303`, `:309`/`:333-347`, `:364-366`, `:372`, `:391`/`:410`/`:425`,
  `:828-830`, `:837-839`/`:844`), which are gate holes with a `continue` in them
  rather than checks.
- **The fingerprint re-check at the commit point** (`historian.rs:448-460`).
- **The four differentiated abandon arms and their cooldown policy**
  (`historian.rs:533-593`).
- **The closed `run.status` wire vocabulary** and **the send-replay fence**
  (`historian_producer.rs:929`, `:949`, fenced at `:999-1000`).
- **The cancellation-proof predicate** on the output branch
  (`historian.rs:1401`), which has no counterpart on the start-failure branch
  (`:1290-1329`).
- **The substance floor and its two bypasses**, and the chunk budget and
  truncation bounds (`historian_chunk.rs`).
- **The wrapup per-round progress check** (`lib.rs:6977-6989`) and the deadline
  re-check before each round (`:6831-6834`).
- **Restart-load phase mapping** (`historian.rs:648-653`) and **the side-channel
  anchor filter** (`historian_validate.rs:1086-1098`).

## Test support and fault-injection seams

**Producer doubles: available and heavily used.** The producer is a trait, and
`historian_producer.rs`'s 18 tests plus `historian.rs`'s wired-path tests are
built on doubles. This is the richest seam in the subsystem.

**Commit-window hooks around the store call: two, and both fire on the wrong
side of the boundary.** `after_store_publish` is a field on both publication
fences (`lib.rs:3293` and `:3329`, fired at `:3313` and `:3350`, wired at
`:4667` and `:6974`). Both fire **after** the store call returns, so neither can
land a fault between the compartment append (`mc-store:9457-9471`) and the
row-version bump (`:9491-9500`).

**A fault seam inside the publish transaction: none found, and for a process kill
that is the end of it. For a SQL error it is not.** Verified over
`mc-store:9340-9560`: no hook, no injectable error, no counter. But a seam is only
required for a *kill*. A late SQL error needs no seam, because the closure's own
error propagation is the mechanism: `with_conn_fenced` evaluates
`let out = f(&tx).map_err(...)?;` and reaches `tx.commit()` only on `Ok`
(`../commons/crates/cortexkit-store/src/lib.rs:229-231`), and the closure's last
write, the `mc_cache_state` UPDATE at `mc-store:9496-9500`, propagates its
`rusqlite` error through a bare `?` after three earlier writes have already applied
to the transaction. A `BEFORE UPDATE ON mc_cache_state` trigger raising `ABORT`,
installed in the main schema from a second connection to the same file, therefore
forces the rollback. The technique is already in use: the abandon-hook test at
`:16688` extracts the SQLite path from the descriptor (`:16691-16694`) and opens a
raw `rusqlite::Connection` to it (`:16704`). So the transaction's atomicity claim is
**partly** falsifiable by a Rust test today, and this file previously overstated it
as wholly unfalsifiable. Only the process-death half needs a subprocess harness.

**Clock and deadline seams for the historian: two exist, and both are already
exercised.** This section previously said "none found in this pass", which was
wrong on both halves.

- **The wrapup deadline is injectable.** `wrapup_operation_budget`
  (`lib.rs:5445-5457`) checks a `#[cfg(test)]` override before falling back to
  `MAX_WRAPUP_REQUEST_BUDGET - WRAPUP_REQUEST_MARGIN`. The field is declared at
  `:2915` and initialised to `None` at `:3445` and `:3747`.
  `wrapup_budget_bounds_busy_join_without_double_drive` (`:29236`) sets it to 40 ms
  at `:29245-29248`, asserts the `budget_exhausted` retryable disposition, then
  restores `None` at `:29273-29276`. So the 3800-second budget never has to be
  waited out.
- **The failure backoff is expirable, and the gate reads an injected `now`.** The
  60-second cooldown is enforced by comparing the durable
  `failure_backoff_at_ms` against a caller-supplied `now`
  (`lib.rs:5042-5047`), and `now` arrives through `HistorianPrepareContext` into
  `prepare_historian_fire` (`:4808-4821`) rather than being read inside the gate.
  The test helper `expire_historian_backoff` (`:29784-29791`) commits
  `Some(now_ms() - 1)` to expire it directly, and
  `assert_seeded_phase_recovers_then_refires_after_backoff` (`:29793`) drives a
  refire through that helper. So N firing opportunities cost no wall clock.

One limit on the second point, so it is not overread. There is no global clock
injection: the transform entry point reads the real clock at
`pass_now = now_ms()` (`lib.rs:8206`) and passes that value down. Neither liveness
record needs a movable clock, because both are gated on durable fields a test can
write, but a property that depended on `now` itself advancing would still have no
seam.

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any executed check
proves.

1. **The quietest thing in this scope is the whole subsystem.** 141 in-crate
   tests, 7 `mc-store` publish tests, and 19 gate tests execute nowhere. 926 of
   the crate's 938 tests never run, `mc-store` is absent from all five workflows,
   and no integration test in `crates/mc-module/tests/` mentions the historian.
   The only executing per-PR coverage is the TypeScript lane, which exercises a
   different implementation of the same contract. Everything below is a second-
   order concern until this changes, because anything added is added to a suite
   no automation executes.

2. **Nothing executing anywhere compares the Rust validator to the TypeScript
   one, and the two are documented as a matched pair.** Five in-crate test names
   assert TypeScript parity by construction:
   `validate_golden_matches_typescript_oracle` (`historian_validate.rs:1384`),
   `five_message_narrative_gap_rejects_like_typescript_validator` (`:1426`),
   `twenty_message_tool_only_gap_heals_like_typescript_validator` (`:1443`), and
   the two golden-fixture drivers in `historian_chunk.rs` (`:1962`, `:2045`). All
   are ungated. Meanwhile the TypeScript lane's frozen corpus is described in its
   own README as the best TS-to-Rust validator differential vector set the repo
   has, with reuse deferred. The differential harness is one CI step away from
   existing and does not exist.

3. **Ten of the validation gate's 22 rejecting checks have no test at any level,
   and three more have untested arms.** Per lens B's per-check mapping, the
   untested checks are: nested `<output>` tags (check 2); compartment endpoint
   maps to a chunk line (8); inverted range (11); range outside the chunk (12);
   start ordinal not present (13); end ordinal not present (14); starts after
   coverage ended (15); chunk not strictly newer than the last stored end (5);
   uncovered messages with no `<unprocessed_from>` (20); and the covered-chunk
   `unprocessed_from` arms at `:1066-1074` (19). The three with untested arms are
   check 3's out-of-range-line arm (`:760-768`) and two tail arms (`:792-804`),
   and check 19's residual mismatch. Checks 11 through 15 are the ordinal-sanity
   family, precisely the checks that stop a model from claiming coverage of a
   range it did not summarize.

4. **The publish transaction's atomicity is untested, and half of it is
   untestable.** Seven tests reach `publish_historian_chunk`, none asserts that all
   six writes land or none do, and the transaction contains zero assertions. The
   ranking of this quiet area is corrected: it previously said the claim was
   "currently untestable" outright, on the grounds that the only nearby hooks
   (`lib.rs:3313`, `:3350`) fire after the store call returns. That argument holds
   only for a kill. The rollback-on-late-SQL-error half needs no seam at all, per
   the seams section above, so it is untested by choice rather than by obstruction.
   What remains genuinely untestable is process death inside the window, and it is
   compounded by the same ownership problem as before: the `tx.commit()` that
   defines the transaction's boundary is in a sibling repository that CI provisions
   as a metadata-only stub (`ci.yml:159-160` at `HEAD`), so even the compile path
   does not see the real wrapper.

5. **`historian.rs` has 51 tests and zero production assertions.** The most
   consequential file in the subsystem enforces every invariant through `Result`,
   so a violated invariant becomes a typed error a caller may or may not surface,
   never a loud failure. The one place the code reaches for an assertion instead
   of a mechanism (`lib.rs:7065`) uses `debug_assert!`, which is compiled out of
   release, and it is standing in for a round cap the loop deliberately omits.

6. **The user-facing failure signal has no producer and its counter has no
   increment.** Two independent breaks in one chain. A validation rejection never
   increments `consecutive_publish_failures`, because `abandon_with_detail` copies
   it forward unchanged (`historian.rs:358`) and the only increments are in
   `mc-store` (`:9264-9268`, `:9323-9326`), which that path does not reach. And no
   TypeScript reader of `publish_health_degraded` (`lib.rs:6360`) or
   `consecutive_publish_failures` exists; the only callers of
   `buildHistorianFailureNotice` (`compartment-runner-validation.ts:210`) are in
   `compartment-runner-incremental.ts`, the TypeScript runner. The only tests near
   it (`lib.rs:26623`, `:26639`, `:26656`) assert the flag flips inside the Rust
   status block, not that anything consumes it.

7. **The start-failure fallback branch has no test and no cancellation proof.**
   All three cancellation-proof tests (`historian.rs:3389`, `:3444`, `:3498`)
   cover the output branch, which demands
   `cancellation_confirmed_stopped` (`:1401`). The start-failure branch
   (`:1290-1329`) never calls `cancel`, never inspects the send outcome, and has
   no test, while `HistorianSendOutcome::OutcomeUnknown`
   (`historian_producer.rs:78-82`) exists precisely to describe a start that may
   have reached the provider.

8. **The three consumer deadline budgets are cross-language constants with one
   hand-written mirror and no cross-check.** `MAX_WRAPUP_REQUEST_BUDGET`
   (`historian.rs:962`, `Duration::from_secs(3_800)`) is duplicated by hand as
   `MAX_WRAPUP_REQUEST_BUDGET_MS = 3_800_000` at `module-transport.ts:72-73`.
   `MAX_EMERGENCY_REQUEST_BUDGET` (`historian.rs:983`, 1500 s) appears to have no
   TypeScript mirror at all. The Rust comments explain in detail what breaks when
   a consumer gets these wrong (`:974-982`). One assertion
   (`command-handler.test.ts:895`) pins the TypeScript side to its own constant,
   not to the Rust one.

9. **Two documented configuration keys have no implementation and no test that
   would notice.** `historian.two_pass` (`CONFIGURATION.md:454`) and
   `historian_timeout_ms` (`CONFIGURATION.md:170`) have no identifier anywhere in
   `crates/mc-module/src`. `two_pass` carries the stronger safety claim of the
   two, "so it can never regress behavior", for a feature absent on this leg. A
   configuration-reference conformance check comparing documented `historian.*`
   keys against `config.rs` parsing would catch both; none exists.

10. **`historian_chunk.rs`'s two golden fixtures are the only guard on chunk
    assembly, and assembly is what pins the raw messages.** `raw_chunk_messages`
    is built at `historian_chunk.rs:717-727` and is the sole durable copy of the
    folded conversation inside this store. Its two drivers (`:1962`, `:2045`)
    compare against checked-in fixtures, so a change that alters what is captured
    fails a fixture rather than an invariant, and neither runs in CI.

11. **The subsystem's only two panic sites have no named test.**
    `historian.rs:1492` and `historian_validate.rs:929` are each reachable only
    through a state the author believed impossible, which is exactly the class a
    fresh test should attack.

12. **`docs/AUDIT-KNOWN-ISSUES.md` contains no historian publish, validation, or
    producer entry.** The file mentions the historian only in passing. None of the
    contract-versus-code gaps recorded by the three lenses is tracked there.

## Sampling limits on this inventory

Three limits are worth stating so a later pass does not read absence as absence
of risk.

- **Two claims in the register are unverified rather than confirmed.** The
  `run.status` production mapping (`historian_producer.rs`) has a test asserting
  it is closed over the wire vocabulary (`:2175`) but the production mapping was
  not read end to end. And the store-side honouring of
  `collect_user_memory_candidates` (`historian.rs:421`) was traced into the
  publish request but not into the write path. The second is a privacy claim.
- **`ctx_expand`'s read side is outside this scope.** `raw_chunk_messages` is
  verified as written; nothing here verifies it is served.
- **Coverage of the 16 golden cases in `testdata/validate-golden.json` is
  reported from lens B's reading rather than re-derived here.** The per-check
  mapping in quiet area 3 inherits that provenance.
