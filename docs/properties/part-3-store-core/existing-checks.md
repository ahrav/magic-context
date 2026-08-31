# Part 3 existing-check inventory

Every claim-bearing check for `crates/mc-store` (21,987 lines), `crates/mc-core`
(1,518), and `crates/mc-tokenizer` (85).

`crates/mc-store/src/lib.rs` is 20,650 lines, of which production is lines 1 to
13,930. Line 13,930 closes `capped_trace_error`, 13,931 is blank, and everything
from 13,932 on is three `#[cfg(test)]` modules. Every line reference below was
read at the working tree, and `lens-d2` verified that the three commits between
the named revision and the working tree touch only
`.github/workflows/shm-hardening-optin.yml`, which names no scope crate.

An existing check does not remove a property from the catalog. Every status below
is **unaudited**: test adequacy belongs to `/testing:invariant-test-review`, and
production assertion adequacy to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## The coverage fact that frames this inventory

**No CI job runs any test in this scope.** Not one. Verified by grepping
`mc-store`, `mc-core`, and `mc-tokenizer` across all five files in
`.github/workflows/`. There are exactly five hits, all in `ci.yml`, and all in
one job:

| Workflow line | Content |
| --- | --- |
| `ci.yml:455` | `check-rust:` |
| `ci.yml:456` | `name: Check (Rust fmt + mc-core features)` |
| `ci.yml:479` | comment: "Every workspace member takes mc-core with default features, so a plain" |
| `ci.yml:482` | comment: "mc-core does not depend on the stubbed cortexkit crates." |
| `ci.yml:483` | `- name: mc-core feature-off build` |
| `ci.yml:484` | `run: cargo check -p mc-core --no-default-features` |

`cargo check` compiles. It runs nothing, and it does not build test targets.

At authoring, every other Rust invocation in `ci.yml` named a different crate:
`cargo nextest run -p mc-host --test client`, `cargo test -p mc-module --test
lifecycle_cli`, the `-p mc-shm-native -p mc-shm-transport` and `-p mc-host
--test client --test lifecycle` pair, their macOS equivalents, and `cargo test
-p mc-host --doc`. PR #131 (merge `5d638e3e8`) removed every macOS job, so no
macOS equivalents exist at HEAD, and the surviving Linux invocations have
shifted lines (the client/lifecycle pair is now `ci.yml:167-169`, the doc run
`ci.yml:175`). The same rewrite also added runs this inventory predates, for
example `cargo test -p mc-store` at `ci.yml:232` (job `mc-host-lifecycle`), so
the executed-in-CI column below is stale for `mc-store`; re-audit rather than
trust it. There is no `--workspace` test run and no `--all-targets` test
run anywhere in any workflow.

So:

| Target | Tests | Executed in CI |
| --- | --- | --- |
| `mc-store` in-crate (`--lib`) | 101 | **No** |
| `mc-core` in-crate (`--lib`) | 31 | **No** |
| `mc-tokenizer` in-crate (`--lib`) | **0** (none exist) | n/a |
| `mc-store/tests/claim_mirror.rs` | 9 | **No** |
| `mc-store/tests/claim_intent_ledger.rs` | 6 | **No** |
| `mc-store/tests/sqlite_runtime.rs` | 3 | **No** |
| `mc-tokenizer/tests/token_golden.rs` | 4 | **No** |

**154 test functions across two library targets and four integration binaries,
none of which any CI job executes.** Counted mechanically: 101 plain `#[test]`
attributes at or after `lib.rs:13932` and zero `#[tokio::test]`; 14 + 9 + 8 in
`mc-core`; and 9 + 6 + 3 + 4 in the four integration files. There is no
`crates/mc-core/tests/` directory.

**Correction to a figure carried in from the task framing.** The count of
existing tests is 154, not 136. 136 is 101 plus 31 plus the 4 tokenizer
integration tests, which omits the 18 integration tests in
`crates/mc-store/tests/`. The larger figure is what a workflow change would
newly execute.

This is a strictly stronger version of the Part 2a finding rather than the same
one. In Part 2a, `mc-host`'s in-crate tests were at least gated through `--lib`.
Here nothing in scope runs at all, so the entire executed proof of this part's
durability, mirror, ledger, decay, and tokenizer claims is local-only. Note also
that Part 2a's cited workflow lines have shifted at the current HEAD; that
inventory needs its own refresh, which is out of scope here.

## In-crate tests

### `crates/mc-store/src/lib.rs`: 101 tests in three modules

No `#[ignore]` and no `should_panic` anywhere in the three modules, verified by
search across `crates/mc-store/src`, `crates/mc-store/tests`,
`crates/mc-core/src`, and `crates/mc-tokenizer`.

`mod tests` (13,932 to 19,420), **87 tests**, clustered by claim:

| Cluster | Lines | Count |
| --- | --- | --- |
| Bootstrap, session-owned deletion, row-version CAS, transform-root lineage | 14,029-14,405 | 7 |
| Transform snapshot and overlay-table atomicity under a concurrent commit | 14,424-14,638 | 4 |
| Command-id ledger, first-application marker, rollback, 512-command retention | 14,670-14,946 | 7 |
| Tag minting monotonicity, overlay ordinal watermark, wrapup ledger, todo replay | 15,012-15,359 | 4 |
| Wrapup fencing by row-version and revert-epoch, pass-trace caps | 15,407-15,500 | 3 |
| Pass-scheduler interest history: selection, ordering, byte bounds, mural upsert | 15,583-16,008 | 7 |
| Schema version probe, pre-cutover refusal, fresh-and-current open, open lease | 16,068-16,159 | 4 |
| State import: atomic bootstrap-only, per-kind preflight, rejection leaves no rows | 16,188-16,319 | 3 |
| Compartments roundtrip, tail append, overlap refusal, memory ordering | 16,339-16,540 | 5 |
| Historian publish, abandon fencing, side-channel isolation, transcript bounds | 16,624-17,096 | 9 |
| Note search scoping, CRUD, at-least-once delivery, ack scoping, paging | 17,202-17,680 | 7 |
| Note revisions, evaluation-state reset, migration v51 backfill | 17,755-18,071 | 5 |
| Artifact repair, `mc_notes` writer fence, revert truncation, recut epoch | 18,123-18,335 | 6 |
| Note-eval claim lifecycle: acquire, replay, renewal, expiry, caps, redaction, drain | 18,490-19,383 | 16 |

`mod shadow_tests` (19,421 to 19,980), **7 tests**: state-sync section
absent-versus-empty-versus-legacy (19,521); one-fenced-transaction idempotent
authority note seed (19,587); authority state machine persists generations and
drain journal (19,635); drain-begin resumes each crash journal position (19,702);
drain resume rejects a different live lease (19,789); stale coordinator token
rejected after takeover (19,819); sequence fence rejects an interleaved stale
sender (19,885).

`mod lineage_descent_tests` (19,981 to 20,650), **7 tests**: zero-based fresh
anchor accepted (20,054); mid-space anchor refused (20,089); verbatim range and
note copy without replay duplicates (20,123); newest completed constituent wins
(20,267); terminal branches durable before ack (20,376); CAS loser leaves target
and prior fence untouched (20,551); invalid source ranges abort without a partial
target (20,610).

### `crates/mc-store/src/claim_mirror.rs` (1,152 lines): none found

Zero `#[test]` and zero `#[cfg(test)]` in the file. This is the file that decides
the restart-seed contract.

### `crates/mc-store/src/sqlite_runtime.rs` (185 lines): none found

Zero `#[test]` and zero `#[cfg(test)]`. Its only Rust caller anywhere is
`crates/mc-store/tests/sqlite_runtime.rs`.

### `crates/mc-core`: 31 in-crate, 0 integration

There is no `crates/mc-core/tests/` directory, verified by `ls`. State the count
as **31 in-crate, 0 integration**, never as "no tests".

- **`src/lib.rs` (338 lines), `#[cfg(test)]` at :162, 14 tests** at :176-:325.
  The pass-classifier decision table: hard bootstrap, legacy baseline migration,
  m1 rebuild, unknown-shape rejection, epoch change, reconcile boundary present
  and absent, soft-delta gating, coalescing, defer rules.
- **`src/claim_operation.rs` (878 lines), `#[cfg(test)]` at :672, 9 tests** at
  :684-:847. All fixture comparison: vocabulary, canonical bytes and request
  digests, non-canonical number rejection, public claim-id validation, revision
  locators, mutation tokens, applicability and policy-head digests, snapshot
  vectors, byte-identical stored-result re-encode.
- **`src/decay.rs` (302 lines), `#[cfg(test)]` at :147, 8 tests** at :154-:246.
  Tier assignment, age-monotonic demotion, importance protection, pressure
  acceleration, finite demotion at max importance, render cap, pressure
  self-tuning, and a golden comparison against the reference curve.

### `crates/mc-tokenizer/src/lib.rs` (85 lines): none found in-crate

All four of its tests are integration.

## Integration tests, per test function

### `crates/mc-store/tests/claim_mirror.rs`, 625 lines, 9 tests. Unnamed in CI.

| Line | Test | Claim it asserts |
| --- | --- | --- |
| 142 | `u10_scenario_1_full_snapshot_roundtrips_committed_claim_vocabulary` | A full snapshot roundtrips the committed claim vocabulary unchanged. |
| 176 | `u10_scenario_2_complete_receipt_group_is_atomic_and_replay_safe` | A complete receipt group applies atomically and a replay is a no-op. |
| 251 | `u10_scenario_3_versions_incarnation_generations_and_project_predecessors_are_strict` | Version, incarnation, generation, and project-predecessor comparisons are strict. |
| 342 | `u10_scenario_4_policy_only_revocation_removes_committed_row` | A policy-only revocation removes the committed row. |
| 376 | `u10_scenario_7_delete_and_reseed_require_drained_u5_intents` | Delete and reseed are refused until U5 intents have drained. |
| 460 | `u10_scenario_7_equivalent_restart_seed_is_idempotent` | An equivalent restart seed is idempotent. |
| 481 | `u10_scenario_8_reseed_reproduces_state_across_restart` | A reseed reproduces durable state across a restart. |
| 527 | `receipt_advances_generation_stamps_on_untouched_rows_so_restart_seed_matches` | A receipt restamps untouched rows so the restart seed matches durable state. Regression for the ordinary-receipt wedge. |
| 591 | `receipt_rejects_equal_revision_carrying_different_content` | An equal revision carrying different content is rejected. |

### `crates/mc-store/tests/claim_intent_ledger.rs`, 401 lines, 6 tests. Unnamed in CI.

| Line | Test | Claim it asserts |
| --- | --- | --- |
| 85 | `acknowledged_intent_survives_more_than_512_later_commands` | An acknowledged intent survives past the 512-command ledger window. |
| 132 | `staged_intent_reopens_and_rejects_binding_or_digest_reuse` | A staged intent reopens but refuses a reused binding or digest. |
| 168 | `stale_zero_effect_result_can_settle_after_authority_drain_starts` | A stale zero-effect result can still settle after a drain begins. |
| 230 | `staging_fails_closed_without_route_resolved_module_authority` | Staging fails closed when the route resolves to no MODULE authority. Regression for the dead identity comparison that made the authority fence unfireable. |
| 288 | `store_rebuild_is_refused_until_intents_drain_then_freezes_new_stages` | Rebuild is refused until intents drain, then new stages are frozen. |
| 345 | `replaying_a_staged_intent_refuses_after_authority_begins_draining` | A staged replay refuses once the authority is draining. Regression for the replay that skipped every fresh-insert check. |

### `crates/mc-store/tests/sqlite_runtime.rs`, 231 lines, 3 tests. Unnamed in CI.

| Line | Test | Claim it asserts |
| --- | --- | --- |
| 45 | `sqlite_runtime_source` | Application id, format epoch, marker and manifest digests match the cross-runtime fixture. |
| 172 | `sqlite_runtime_source_connection_contract` | `verify_sqlite_connection_contract` reports foreign keys, WAL mode, and busy-timeout violations. |
| 204 | `sqlite_runtime_source_id_gate_fails_closed_on_non_ascii_stamps` | The source-id gate fails closed on a non-ASCII version stamp. |

### `crates/mc-tokenizer/tests/token_golden.rs`, 73 lines, 4 tests. Unnamed in CI.

| Line | Test | Claim it asserts |
| --- | --- | --- |
| 26 | `encode_ordinary_matches_ai_tokenizer_ids` | Ordinary encoding produces the same ids as `ai-tokenizer`. |
| 47 | `estimate_tokens_matches_golden_counts` | `estimate_tokens` matches the golden counts. |
| 59 | `empty_text_is_zero` | Empty input estimates zero tokens. |
| 64 | `deterministic_across_calls` | Repeated calls return identical counts. |

## Production assertions and guards

**Live Rust assertions in `crates/mc-store` production code, meaning lines 1 to
13,930 of `lib.rs` plus both submodules: effectively zero.** For a 13.9k-line
file that is the headline. Verified counts over exactly that range: 2
`debug_assert!`, 1 bare `assert!`, 0 `assert_eq!`, 0 `panic!`, 2 `unreachable!`,
0 `todo!`, 0 `unimplemented!`, 5 `.expect(`, 0 `.unwrap()`.

Clustered:

- **`unreachable!`, 2, both genuine.** `lib.rs:3919` ("claim mutation transaction
  cannot return a rebuild outcome") and `lib.rs:11346` ("rebuild transaction
  returns only granted or blocked"). Both discharge a match over
  `ClaimIntentTxnOutcome`. Both are forbidden-code-point guards and both abort in
  release, so the failure mode is a process abort inside a write transaction
  rather than a returned error.
- **`debug_assert!`, 2, and both are dead.** `lib.rs:6878` and `lib.rs:6988` are
  each `debug_assert!(valid_disposition)` placed **after** an
  `if !valid_disposition { return Err(...) }` on the preceding lines. The early
  return already establishes the condition, so neither can fire even in a debug
  build. They are restatements, not checks.
- **`assert!`, 1, and it is not production.** `lib.rs:5250` asserts a known
  historian side-channel kind, but it sits inside
  `fail_next_historian_side_channel_for_test`, gated `#[cfg(any(test, feature =
  "test-support"))]`. Reachability class: test-only.
- **`.expect(`, 5.** Three are test-support hook mutexes (`lib.rs:5287`, `:5298`,
  `:9250`). Two are live production invariant claims and both panic if the
  precondition fails: `lib.rs:8545`
  `request.anchor.expect("eligible descent has an anchor")` and `lib.rs:12104`
  `row.snapshot.as_object().expect("validated note seed object")`.
- **`unwrap_or_else(|poisoned| poisoned.into_inner())`, 15 occurrences.** A
  uniform policy of continuing through a poisoned mutex rather than propagating.
  Consistent, and worth naming as a check in its own right, because it converts a
  panic that already happened inside a critical section into silent use of
  possibly-inconsistent state.
- **Typed fail-closed refusals, roughly 20 `McStoreError` variants**, which are
  the real guard layer alongside the four `validate_*` functions (`lib.rs:3816`,
  `:3924`, `:4013`, `:4199`). Variants include `PreCutoverModuleStore`,
  `CasConflict`, `AuthorityStateMismatch`, `AuthorityGenerationMismatch`,
  `AuthorityFeedHeadAdvanced`, `NoteCasConflict`, `NoteOwnershipMismatch`,
  `CompartmentRangeOverlap`, `FacadeProjectVocabularyMismatch`, and six
  `ClaimIntent*` variants.
- **The open-path preflight is two calls.** `McStore::open` runs
  `refuse_pre_cutover_store(&inner)?` at `lib.rs:4873` and
  `inner.migrate(NS, MIGRATIONS)?` at `lib.rs:4874`, then
  `store.repair_note_artifacts_v51()?` and
  `store.prune_transform_session_roots()?` at the end of the constructor. The
  refusal at `lib.rs:1375-1385` is asymmetric: it errors on `recorded <
  OLDEST_ADOPTABLE_MIGRATION_VERSION` and falls through to `_ => Ok(())` for
  everything else, and `OLDEST_ADOPTABLE_MIGRATION_VERSION` is
  `LATEST_MIGRATION_VERSION` (`lib.rs:1342`), which is 57. A store recorded above
  57 is admitted and then migrated by a no-op.
- **`crates/mc-core`: one production `.expect`,** `claim_operation.rs:73`
  (`"constant fits in u64"`). `decay.rs` and `lib.rs` have **no** production
  assertions; everything a naive grep finds sits inside the three `#[cfg(test)]`
  modules.
- **`crates/mc-tokenizer`: 5 `.expect(` at `src/lib.rs:55, 56, 59, 60, 66`,** all
  on the vendored `assets/claude.tiktoken` parse and `CoreBPE` construction. They
  panic at load time on a malformed vendored asset. Reachability class:
  default-production, but only reachable through a corrupted build artifact.

## The 361 SQL constraints as existing checks

This is where the store's invariants actually live, and it is the largest body of
existing checks in the part by an order of magnitude.

`MIGRATIONS` at `lib.rs:432-1312` is one `Migration`, `version: 57` at
`lib.rs:433`, and one consolidated SQL string at `434-1311`. Counted mechanically
over exactly that range:

| Declaration | Count |
| --- | --- |
| `NOT NULL` | 249 |
| `CHECK` (lines matching the keyword) | 58 |
| `PRIMARY KEY` | 42 |
| `UNIQUE` (3 standalone `CREATE UNIQUE INDEX` plus 8 inline column or table constraints) | 11 |
| `FOREIGN KEY` | **1** |
| **Total declared constraints** | **361** |
| `CREATE TABLE` | 42 |
| `CREATE TRIGGER` | 15 |

The `CHECK` figure counts lines matching the keyword. A few multi-line `CHECK (`
bodies mean the number of distinct check constraints is slightly lower, so treat
58 as an upper bound on distinct checks. An earlier lens pass reported 56 in
production with 49 inside the DDL; the discrepancy is a counting-scope artifact
and 58 is the figure verified over `lib.rs:432-1312` exactly.

These constraints are enforced by SQLite at write time, not by Rust, so a
violation surfaces as a `rusqlite` error rather than a typed `McStoreError`
refusal. That matters for any test asserting a specific refusal shape.

**Referential integrity is almost entirely conventional.** 42 tables and exactly
**one** `FOREIGN KEY`, at `lib.rs:1291`: `FOREIGN KEY (database_incarnation_id,
project_id) REFERENCES mc_claim_mirror_projects(database_incarnation_id,
project_id)`. `foreign_keys = ON` is set at `cortexkit-store:291`, so the pragma is
enabled and has exactly **one edge to enforce**. Every other cross-table
relationship in the schema, including every claim, note, compartment, and
historian linkage, is maintained by application code and by convention with no
database-level enforcement. Enabling the pragma is therefore close to a no-op as
a safety measure, and its presence should not be read as evidence that
referential integrity is checked.

Constraint strength is uneven in a way worth recording:

- The strongest are the two partial unique indexes on `mc_note_eval_claims`:
  `idx_mc_note_eval_claims_active_note` (`lib.rs:1196-1197`) and
  `idx_mc_note_eval_claims_active_slot` (`lib.rs:1199-1201`). These are the
  mutual-exclusion guarantee for note evaluation, and both are dual-enforced by
  app-side reads inside the same fenced transaction.
- The strongest dual-enforced value constraint is the staged-result `CHECK` on
  `mc_claim_intents` (`lib.rs:1231-1234`): SQL requires presence, and
  `validate_claim_result_json` (`lib.rs:3924-3937`) additionally requires
  canonical bytes.
- Several constraints pin an **alphabet but not a transition graph**. The intent
  `state` check (`lib.rs:1224-1226`) forbids an unknown state but permits
  `acknowledged` returning to `staged`; no `CHECK` or trigger encodes lifecycle
  ordering. The same is true of the four status ladders at `lib.rs:553`, `:699`,
  `:704`, and the phase check. Ordering is app-only.
- `length(database_incarnation_id) = 32` appears on six tables (`lib.rs:1218`,
  `1243`, `1256`, `1263`, `1273`, `1301`), but the stricter app-side
  `is_lower_hex(x, 32)` appears at only four sites (`lib.rs:3820`, `4124`,
  `11310`, `claim_mirror.rs:253`). SQL accepts any 32 characters where Rust
  demands lowercase hex, and the two sets do not line up.
- One constraint is constraint-only with no located pre-check:
  `UNIQUE(note_id, session_id, delivered_pass_fingerprint)` (`lib.rs:752`), the
  at-most-once note-delivery guarantee. The insert's conflict handling is the real
  contract there.

Status for all 361: **unaudited**. Nothing asserts that the shipped bootstrap
composes the schema the code expects. `compute_schema_manifest_digest`
(`sqlite_runtime.rs:156`) exists precisely to express that and is called from no
production path.

## Test support helpers

**None found.** There is no `tests/support/` directory and no shared helper
module in either `crates/mc-store/tests/` or `crates/mc-tokenizer/tests/`. Each
of the four integration files is self-contained.

One property of the in-crate fixtures is worth recording as a hazard rather than
a helper. A repaired defect established that a test can execute, assert, and
still prove nothing when its fixture builds its own schema: a repair statement
wrote a column the cutover had dropped, and the test passed because the fixture
had created that column. The commit had to "rebuild its fixture on the shipped
column so the test stops passing vacuously." Because the migration DDL is one
881-line raw string literal that nothing validates at compile time, any fixture
composed by hand-written DDL rather than by opening a real store can drift the
same way.

## Concurrency and property-testing tooling

**None found.** No `loom`, `shuttle`, `miri`, `proptest`, `quickcheck`, or
`arbitrary` in `crates/mc-store/Cargo.toml`, `crates/mc-core/Cargo.toml`, or
`crates/mc-tokenizer/Cargo.toml`. Every existing check in this part is a
hand-written fixture case or a hand-written loop. There is no coverage
measurement either; the placement observations below are structural, not
measured.

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any executed check
proves.

1. **The WAL-reset gate and the connection contract are never called in
   production.** `sqlite_runtime.rs` exports six public functions (`:34`, `:45`,
   `:92`, `:113`, `:156`, `:170`), including `evaluate_sqlite_runtime_gate`
   (`:92`), which enforces `SQLITE_WAL_RESET_SAFE_MIN_VERSION = [3, 47, 1]`
   (`:25`), and `verify_sqlite_connection_contract` (`:113`). The only Rust caller
   of any of the six anywhere in the workspace is
   `crates/mc-store/tests/sqlite_runtime.rs`. `lib.rs` contains no reference to
   `sqlite_runtime::` beyond the `pub mod` declaration at `lib.rs:17`. So
   `McStore::open` never evaluates the gate and never checks journal mode. The
   module's doc comment at `sqlite_runtime.rs:1-6` presents it as the contract for
   "`store.db` writers"; the code makes it, as consumed from Rust, effectively
   test-only. Contract and code disagree and both sides are reported here without
   resolution.

2. **The migration path is guarded in one direction and tested in one
   direction.** Three facts compound. `refuse_pre_cutover_store`
   (`lib.rs:1375-1385`) refuses `recorded < 57` and admits everything else, so
   `recorded > 57` reaches a no-op `migrate`. The only test of the refusal
   (`lib.rs:16088`) loops `for version in 1..OLDEST_ADOPTABLE_MIGRATION_VERSION`
   (`lib.rs:16113`), so the highest recorded version it ever constructs is 56 and
   nothing constructs 58. And the 881-line consolidated DDL is validated only by
   being executed on a fresh open. Given that a schema-version mismatch is
   unrecoverable in the field, the above-ceiling direction being both unguarded
   and untested is the single highest-leverage gap in this part.

3. **`claim_mirror.rs` decides the restart-seed contract with no in-crate
   check.** 1,152 lines, zero `#[test]`, zero `#[cfg(test)]`. It hosts
   `apply_claim_mirror_receipt`, whose generation-stamping rule must agree exactly
   with the host's full-snapshot stamping or a restart returns `ResetRequired` and
   suppresses the claim lane. That failure needed no fault at all: a stable
   workspace and one ordinary receipt. Its regression test lives in
   `tests/claim_mirror.rs`, which no CI job runs. The counterpart is implemented
   in TypeScript, so the agreement is cross-language, and unlike
   `mc-core/src/claim_operation.rs` there is no shared `testdata` fixture proving
   it.

4. **The post-migration open repair is a cluster of four separate problems.**
   `repair_note_artifacts_v51` (`lib.rs:5069`) runs on every open at
   `lib.rs:4902`. Its doc comment at `lib.rs:5064-5066` says the repair replays on
   every open including already-upgraded stores, but the body at `lib.rs:5071-5080`
   returns early when a completion flag row exists, so it runs at most once, and
   the comment's first paragraph describes route normalization rather than
   artifact repair. The completion flag is a fake session row: `lib.rs:5106-5110`
   inserts into `mc_cache_state` with `session_id =
   "note_artifact_repair_v51_done"` and empty-string `core_state` and `meta`,
   which are not valid JSON, and which makes
   `has_cache_state("note_artifact_repair_v51_done")` true even though
   `has_cache_state` (`lib.rs:5362`) is documented as a provenance check that a
   client-supplied label cannot satisfy. The helper is named for a migration that
   no longer exists, and its three tests (`lib.rs:18071`, `:18124`, `:18905`)
   target a v51 step the v57 consolidation absorbed. And none of those three tests
   runs in CI.

5. **Regions of the monolith with no executed check at all.** 87 tests over
   13,930 production lines is roughly one per 160 lines, and the distribution is
   uneven: notes, note-eval claims, and the historian account for 43 of the 87.
   Sparse by comparison: the `MIGRATIONS` DDL itself (881 lines) has no structural
   assertion, only incidental execution; and the authority state-machine and
   drain-journal logic around `lib.rs:11300-11900`, including the four
   `set_claim_intent_transition_tx` call sites at `:11434`, `:11640`, `:11738`,
   and `:11790`, is covered only by the 7 in-crate `shadow_tests`. If the residual
   identifier-shape bypass in that function is real, those seven tests pass while
   the transition rows are never written at all.

6. **Three fault-injection seams were deleted and not replaced.**
   `facade_mutation_abandon_hook`, `authority_project_resolution_fail_once`, and
   `authority_seed_resolution_pass_count`, plus the `with_facade_mutation`
   wrapper, were removed as orphans stranded by a dead-code deletion. Those seams
   existed to inject a crash at a commit window and to force an
   authority-resolution failure. Their removal is churn with a cost: it shrank the
   fault-injection surface available to exactly the crash-window tests this part
   most needs.

## Tracker state

`docs/AUDIT-KNOWN-ISSUES.md` contains **no entry concerning the three Rust scope
crates**. Its migration-related entries all describe the TypeScript plugin's
`storage-db` migrations and its `initializeDatabase` / `runMigrations` path, which
the direct-claims cutover deleted. One of those entries is worth carrying forward
by analogy rather than as scope evidence: it records a "Coverage note (missing
co-located migration tests)" saying the schema "is exercised" only indirectly,
which is the same shape as the gap in item 2 above.

Four beads mention the scope crates. `magic-context-d5l` (P2, open) tracks
extracting notes and schema modules from `lib.rs` and independently corroborates
the 20,650-line figure. `magic-context-8vi` (P2, open) names `ci.yml`'s `cargo
check -p mc-core --no-default-features` as a stopgap. `magic-context-3q5.28` (P3,
open) tracks a writer actor. `magic-context-78o.5` (P1, **closed**) claimed
"Migration, recovery, hostile-input containment tests + PARITY docs" complete,
but its migration tests predate the cutover by a week, so a closed migration-test
bead does not cover the current single-bootstrap scheme.

Four ids referenced in scope commit messages resolve to nothing under `bd show`:
`#8342`, `#1234`, `#409`, and `86e3ae26c2ea5a1b`. On reading the surrounding
prose, `#1234` and `#409` are almost certainly example strings rather than
references. `#8342` and `86e3ae26c2ea5a1b` read as genuine references to work
items that are gone.

## Sampling limit on this inventory

Nine defect records were derived from 18 commits read in full, out of 208 that
touch `crates/mc-store`, 22 that touch `crates/mc-core`, and 1 that touches
`crates/mc-tokenizer`. Roughly 90 bulk-generated commits were sampled by subject
only. The defect set behind this inventory is not claimed to be exhaustive, and
that tail is the largest unexamined region.
