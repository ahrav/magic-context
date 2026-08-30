# Part 4b existing-check inventory

Every claim-bearing check for the transform pass engine and the cache-state
transition: `crates/mc-module/src/transform.rs:1-7510`, `injection.rs`,
`compartment_coverage.rs`, `m0_compose.rs`, `healing.rs`, `m1_compose.rs`,
`retained_size.rs`, `divergence.rs`, plus the store-side transform commit in
`crates/mc-store/src/lib.rs` and `scheduler.rs` as cited adjacent surfaces.
About 10,124 production lines.

Provenance, with two corrections to the numbers supplied to this synthesis.
The task states actual `HEAD` = `b5dc778e`. The repository's `HEAD` is
`e447c927` ("refactor(shm): trim final review leftovers"), one commit later
still. `git diff --name-only 76cd6f41 e447c927 -- crates/mc-module crates/mc-store`
returns nothing, so every `mc-module` and `mc-store` line reference below is
identical at `76cd6f41`, `b5dc778e` and `HEAD`, and is stated without
qualification. `.github/workflows/ci.yml` **does** differ between `76cd6f41`
and `HEAD` (+9 lines, -1), so every CI reference is stated at `76cd6f41` with
the `HEAD` line noted; the working tree is clean against `HEAD` for that file,
so the "working-tree drift" the task describes is drift from `76cd6f41`, not
from `HEAD`. `packages/plugin/src/hooks/magic-context/` is unchanged across the
same span, so the TypeScript references hold at all three commits.

One reference inherited from a lens is corrected. Lens A cites
`transform_snapshot_resists_commit_between_state_and_overlay_reads` at
`mc-store/src/lib.rs:14455`; the `fn` line is `:14425`, which is what lens C
records. The `:14425` form is used below.

An existing check does not remove a property from the catalog. Every status
below is **unaudited**: test adequacy belongs to
`/testing:invariant-test-review`, and production assertion adequacy to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## The coverage fact that frames this inventory

**Nothing in this scope executes in CI.** That is the dominant fact of Part 4b,
and it is the same dominant fact Part 4a found one sub-part over
(`../part-4a-historian/existing-checks.md:22-38`). It is worse here in one
respect: the suite is more than twice the size.

The sub-part has **263 in-crate tests in scope**:

| Target | Tests in 4b scope | Executed in CI |
| --- | --- | --- |
| `transform.rs`, of 280 in the flat `mod tests` | **226** | **No** |
| `injection.rs` (`mod tests` at `:458`) | 18 | **No** |
| `compartment_coverage.rs` (`:217`) | 7 | **No** |
| `healing.rs` (`:161`) | 5 | **No** |
| `divergence.rs` (`:104`) | 7 | **No** |
| `m0_compose.rs`, `m1_compose.rs`, `retained_size.rs` | **0** | n/a |
| **Total in-crate, 4b scope** | **263** | **No** |
| `crates/mc-store/src/lib.rs`, transform commit | 6 | **No** |
| `crates/mc-module/tests/` driving a real transform | 2 | **No** |

The 226 figure is the one number in this file that is derived rather than
counted, and it carries a stated limit. `transform.rs` holds 285 test
attributes: 280 in the main flat module `mod tests` (`:12626`, attributes
`:12644-29424`, first test fn `:12645`
`claude_code_cache_ttl_mapper_is_lossy_because_provider_vocabulary_is_limited`,
last `:29425`
`channel2_directive_id_hashes_session_and_arming_watermark_deterministically`)
plus 5 in `mod nudge_formula_tests` (`:9629`), which is sub-part 4e's scope.
The flat module has no inner `mod` and is read as evidence by both 4b and 4e,
so no structural split exists. Lens C attributed it mechanically, by parsing
each test body and matching the entry points it calls:

| Bucket | Tests | Basis |
| --- | --- | --- |
| Drive a whole pass | **210** | Body calls `run(`, `transform(`, `transform_with_projection(`, or `apply_once_with_estimator(`. `run` is the shared fixture driver at `:14331-14338`, which calls `transform` at `:14334` |
| Unit-test a 4b helper only | **16** | Body names a 4b-only symbol and no 4e symbol |
| Unit-test a 4e helper only | 22 | Body names a 4e-only symbol and no 4b symbol |
| Both helper families | 5 | — |
| Neither, unclassified | 27 | Small serde, timing, geometry and TTL unit tests |

So **226 of the 280 reach 4b code**: 210 whole-pass drivers through the shared
`run` helper plus 16 4b-only unit tests. Because a pass also renders output,
the 210 traverse 4e as well and are shared evidence, not 4b-exclusive. **The
limit:** this is a symbol match over parsed test bodies, not coverage
instrumentation. The repository has no coverage measurement, so the split is
structural and the 27 unclassified tests were not hand-read.

Three mechanical facts produce the "No" column, each verified against all five
files in `.github/workflows/` at `76cd6f41`:

1. **The only `mc-module` test invocation in any workflow is
   `cargo test -p mc-module --test lifecycle_cli`,** at `ci.yml:168` at
   `76cd6f41` and `:172` at `HEAD`. `--test lifecycle_cli` selects one
   integration binary and does **not** build the `--lib` target, so no in-crate
   `mc-module` unit test is compiled, let alone run. The other `mc-module` step
   is build-only: `cargo build -p mc-module --bin ck-mc-host` at `:165`
   (`HEAD` `:169`). The full set of Rust test invocations at `76cd6f41` is
   `ci.yml:131`, `:168`, `:173`, `:174`, `:180`, `:181`, `:183`, `:186`; seven
   of the eight target `mc-host`, `mc-shm-native`, or `mc-shm-transport`. There
   is no `cargo test -p mc-module --lib` and no `--workspace` test run: the only
   `--workspace` cargo commands are `cargo fmt --check` (`:477`) and, adjacent
   to it, `cargo check -p mc-core --no-default-features` (`:484`).
2. **`crates/mc-store` appears in no workflow at all.** A search for `mc-store`
   across `.github/workflows/` returns zero matches. The commit transaction that
   discharges the sub-part's whole-or-nothing claim, and its six tests, live in
   a crate no automation touches.
3. **`scripts/test-rust.sh` (`cargo nextest run --workspace`) and the
   `test:rust-e2e` lane exist and no workflow calls either.** Both are wired
   into root `package.json`, and a search of `.github/workflows/` for
   `rust-e2e`, `test:rust` and `test-rust.sh` returns zero matches. The one Rust
   end-to-end selection mode the repository has,
   `run-test-selection.ts --mode rust`, never runs.

The consequence for every record in this part is that `Exercised: partial`
means "a test exists on a developer's machine". METHOD.md's `Exercised` field
does not distinguish that from `not yet`; all three lenses raise the question
and it is recorded as needing human input rather than resolved here.

## The TypeScript gates are the only executing coverage and they do not test this code

This section is separate because these gates are the **only** transform-adjacent
coverage that executes on every pull request, and because none of it exercises
the Rust engine. Reading them as coverage of sub-part 4b is the single easiest
mistake to make about this scope.

The gate is one step, "Test", at `ci.yml:249` at `76cd6f41` (`HEAD` `:257`),
running `bun run test`, which is `sh scripts/test-shard.sh packages/plugin`
plus its siblings per root `package.json`. `test-shard.sh` runs `bun test` over
the whole `packages/plugin` tree, sharded, so every `*.test.ts` under it
executes. Three files bear directly on transform behaviour:

| File | Tests | What it actually tests |
| --- | --- | --- |
| `packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts` | **70** | The TypeScript **caller** of the Rust module. The module transport is a hand-written stub: `const moduleClient: RustModeModuleClient = { call: async ({ method }) => ... }` at `:851-859`, whose canned return is `:858`, `return method === "transform" ? { native_messages: native } : { ok: true }`. It asserts the request the TS side builds, the method sequence, the acked sequence and watermarks, and that the stubbed output reaches `output.messages`. **No Rust runs.** |
| `packages/plugin/src/hooks/magic-context/lkg-transform-replay.test.ts` | 15 | The TypeScript last-known-good replay path, via `createMessagesTransformHandler` |
| `packages/plugin/src/config/transform-mode.test.ts` | 6 | `resolveTransformMode`, including "downgrades rust to ts with one warning when compaction is off" (`:69`). This is the only executing check on the compaction-off downgrade, and it tests the TypeScript resolver |

**No plugin test invokes the module binary.** A search of
`packages/plugin/src/**/*.test.ts` for `ck-mc-host`, `mc-module`, a rust
`transform_mode` spawn, or `rustTransform` returns zero matches; there is no
`spawn`, `child_process`, or napi call in `rust-mode-transform.test.ts`. The
70 tests prove the caller builds the request the module expects, against a
transport that never fails and never disagrees.

Beside it, in the same per-PR run, sits a large suite over a **wholly separate
TypeScript transform implementation** of the same contract. Sixteen files under
`packages/plugin/src/hooks/magic-context/` hold **228 tests** between them:
`compartment-runner.test.ts`, `compartment-runner-drop-queue.test.ts`,
`compartment-runner-partial-recomp.test.ts`,
`compartment-runner-recomp-fk.test.ts`, `compartment-runner-timeout.test.ts`,
`compartment-runner-validation.test.ts`, `compartment-runner-wrapup.test.ts`,
`boundary-execution.test.ts`, `boundary-execution-integration.test.ts`,
`inject-compartments.test.ts`, `inject-compartments-mural.test.ts`,
`m0m1-taxonomy.test.ts`, `cache-busting-signals.test.ts`,
`transform-cache-busting-signals.test.ts`, `degraded-reanchor.test.ts`,
`transform-authority-flip-back.test.ts`, plus the `packages/pi-plugin`
equivalents. They cover the same cache-discipline vocabulary the Rust module
header uses, and `docs/AUDIT-KNOWN-ISSUES.md` is written about that
implementation, not this one: `A24` (`:407`) states the atomicity question this
sub-part's own error doc answers and states it about `messages-transform.ts`.
A search of that file for `apply_once`, `commit_transform` or `mc-module`
returns **zero matches**.

So: 228 executing tests plus 70 caller tests plus 15 replay tests sit next to
263 non-executing tests, and **nothing compares the two implementations.**
Unlike Part 4a, 4b has no in-crate TypeScript-oracle golden driver at all;
there is no counterpart to `historian_validate.rs:1384`
`validate_golden_matches_typescript_oracle`
(`../part-4a-historian/existing-checks.md:124-129`).

## In-crate tests, clustered with counts and line ranges

Counts obtained by matching `#[test]`, `#[tokio::test]`, and
`#[tokio::test(...)]` per file. Every count and every module-opening line below
was re-verified at `HEAD`.

| File | Tests | Test module | Notes |
| --- | --- | --- | --- |
| `transform.rs` | 280 + 5 | `:12626` (`pub(crate) mod tests`), `:9629` (`mod nudge_formula_tests`) | 226 in 4b scope; see the split above |
| `injection.rs` | **18** | `:458` | 911-line file; `#[cfg(test)]` islands also at `:11`, `:19`, `:362` |
| `compartment_coverage.rs` | **7** | `:217` | 413-line file |
| `healing.rs` | **5** | `:161` | 267-line file |
| `divergence.rs` | **7** | `:104` | 178-line file |
| `m0_compose.rs` | **0** | none | 403 lines |
| `m1_compose.rs` | **0** | none | 230 lines |
| `retained_size.rs` | **0** | none | 212 lines |
| `scheduler.rs` (adjacent) | 16 | `:919` | 1,449-line file |

### The 210 whole-pass drivers, and what they all assert by accident

The single most important structural fact about this suite is that 210 of its
tests go through one fixture helper, `run` (`transform.rs:14331-14338`). That
helper calls `transform` at `:14334` and then, unconditionally, calls
`assert_no_duplicate_tool_use_ids(response.messages())` at `:14335` and
`assert_no_orphaned_tool_arcs(response.messages())` at `:14336`.

So the two output-integrity guards, `assert_no_orphaned_tool_arcs`
(`:11172-11225`) and `enforce_unique_tool_use_ids` (`:11231-11305`), are
asserted on every response in 210 tests. They are 4e code, and they are
simultaneously the most-exercised checks anywhere near this sub-part and the
least deliberately targeted. Whether 4b's inventory should claim them or defer
wholly to 4e is an open synthesis question lens C raised and this file does not
resolve; they are listed because a reader counting 4b's coverage would
otherwise miss that 210 tests share one implicit oracle.

### `transform.rs`, 4b clusters by named test

Named tests the lenses verified by line, grouped by what they pin:

- **Commit fan-in and no-commit error paths**, 2:
  `obsolete_pending_row_commits_consumption_without_core_or_meta_changes`
  (`:24607`) pins the `commit_required` fan-in;
  `fired_divergence_with_absent_new_anchor_fails_loud_without_commit`
  (`:20909`) pins one error path that does not commit.
- **The commit fence**, 1:
  `claim_vector_commit_fence_never_publishes_interleaved_stale_bytes`
  (`:14185`) covers the claim-vector predicate. Nothing covers the compartment
  predicate's absence on a Defer.
- **Reconcile, recut and revert**, 4:
  `reconcile_rematerialize_with_unrecut_store_truncates_and_refolds_prefix`
  (`:19870`) drives the revert truncate on a success path;
  `crash_reentry_after_recut_uses_coverage_shrink_for_todo_reanchor`
  (`:21806`) covers re-entry after a committed recut;
  `boundary_divergence_recut_retries_after_interleaved_historian_publish`
  (`:20433`) constructs the publish-wins-the-CAS race;
  `stale_full_state_sync_cannot_rewind_a_committed_divergence_recut`
  (`:20841`) covers the post-commit half.
- **Divergence suppression budget**, 3: `:20699`, `:20750`, `:20769` iterate
  `BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT` (`:85`, value `3`) and assert
  escalation. None holds `historian_active` or `wrapup_active` true across the
  window, which is the arm that freezes the counter (`:3926-3928`).
- **Tag mint and served bytes**, 2:
  `first_active_render_commits_tagged_bytes_before_replay` (`:22514`) and its
  subagent twin (`:22588`) prove tags commit with the bytes. Neither compares
  the rendered number to the durable number.
- **Caveman**, a cluster at `:25463-25490`, `:25606`, `:25660-25684`, plus
  `:25479-25490` on empty and non-empty cases and `:25752-25760` on the
  protected-window exclusion. All set `caveman_min_chars = 1`. None constructs
  a deeper tier whose output is longer than the frozen payload, which is the
  case the production `assert!` at `:6366-6369` panics on.
- **Reduction GC and the frozen set**, 1:
  `reverted_orphan_reduction_gcd_on_surviving_prefix_reconcile_hard`
  (`:25052`).
- **Gate truth table**, 1:
  `producer_gate_runs_on_execute_force_and_hard_advisory_never_plain_defer`
  (`:15795`) covers the gate's truth table, not its observability.
- **Pending rewrite and ingress isolation**, 1:
  `pending_rewrite_passes_isolate_ingress_meta_usage_and_reconcile`
  (`:20079`).
- **Output cache**, 1:
  `serialized_output_cache_revert_epoch_bump_evicts_session` (`:28884`).
- **Pending drops**, 1: `:23678-23690` exercises a pending drop across a
  false-window case. No test bounds the drain time.

### The store-side transform commit, 6 tests

In `crates/mc-store/src/lib.rs`. All six re-verified by name and `fn` line at
`HEAD`:

| Line | Test |
| --- | --- |
| `:14207` | `transform_session_root_lineage_is_cache_committed_and_pruned_on_reopen` |
| `:14282` | `transform_session_roots_canonicalize_writes_and_match_legacy_symlink_rows` |
| `:14425` | `transform_snapshot_resists_commit_between_state_and_overlay_reads` |
| `:14479` | `transform_snapshot_keeps_row_version_and_overlays_from_one_commit` |
| `:14562` | `transform_cas_conflict_leaves_every_overlay_table_empty` |
| `:18267` | `truncate_compartments_for_revert_deletes_suffix_and_bumps_epoch` |

`:14562` is the closest existing check to the all-or-nothing commit claim, and
`:14425` with `:14479` are the closest to the read-linearization half. `:18267`
covers the revert truncate's bump path; **nothing covers its no-op arm**
(`mc-store/src/lib.rs:9053-9059`), which is the mechanism the
revert-idempotency record depends on.

### `#[ignore]`, `should_panic`, and property tooling

**None found in the eight scope files.** No `#[ignore]` and no `should_panic` in
any of them. One qualification, because this file now cites a `should_panic` test
as coverage for a scope-file assertion: `projection_differential_catches_corrupt_first_changed_position`
(`lib.rs:21115-21155`) is a `should_panic` test and it drives
`assert_prefix_projection_equivalent` (`transform.rs:2344-2358`), but it lives in
`lib.rs`, which is a cited adjacent surface rather than one of the eight, so the
per-file claim above stands as written. No `loom`, `shuttle`, `miri`, `proptest`,
`quickcheck`, or `arbitrary` anywhere in the 4b path. Every check is a
hand-written fixture case. There is no coverage measurement, so every placement
observation in this file is structural, not measured.

## Integration and CI status

**Integration tests in `crates/mc-module/tests/` that drive a real transform:
two, neither in CI.** Test counts per binary re-verified at `HEAD`: 38 across
seven files.

| File | Tests | Transform relevance | In CI |
| --- | --- | --- | --- |
| `direct_host.rs` | 6 | `:67` `readiness_permissions_catalog_and_real_unary_transform` and `:149` `direct_primary_replays_transform_state_across_fixture_restart` drive a real `"kind": "transform"` request (`:110`, `:173`) through the fixture host | **No** |
| `prepared_output.rs` | 10 | `:35` `transform_segments_preserve_existing_golden_bytes` plus three more, all against `PreparedOutput::transform_segments`, the 4d response encoder rather than the pass engine | **No** |
| `host_adapter.rs` | 4 | `:163-172` asserts on the **text of the production source** (`split("fn respond_transform")`, then `contains`/`!contains`), so it is a source-shape gate, not an execution test | **No** |
| `boundary_counter_durability.rs` | 1 | `mc_core::CoreState` only; adjacent | **No** |
| `lifecycle_cli.rs` | 12 | **Zero** mentions of `transform` | **Yes** (`ci.yml:168` at `76cd6f41`, `:172` at `HEAD`) |
| `broca_roundtrip.rs` | 2 | none | **No** |
| `release_contract_conformance.rs` | 3 | none | **No** |

The one integration binary CI runs is the one with no transform coverage.
`direct_host.rs` is the only place in the repository where a real transform
request crosses a process boundary into the module, and it does not run.

## Production assertions and guards, clustered

**Panicking sites in production code: four, clustered by liveness.** Named
explicitly because three of them can fire in a release build.

- **Live in release, unconditionally: one.** `transform.rs:6366-6369`, a bare
  `assert!` (not `debug_assert!`) inside `new_caveman_units`:
  `assert!(compressed.len() <= existing.frozen_payload.len(), "caveman deeper
  tier grew frozen payload for {block_id}")`. Verified at `HEAD` over
  production lines. Reachable only with caveman enabled, which defaults to
  `false` (`config.rs:76`). The relation it guards is the documentation's
  "never compresses an already-compressed payload"; `:6370-6374` keeps the
  shallower bytes on a length tie while `:6378` still records the deeper depth.
  `CONFIGURATION.md:720-744` documents caveman with **no failure mode at all**.
- **Live in release under an environment variable: two.**
  `transform.rs:2349-2353`, `assert_eq!(incremental.differential_bytes(),
  full.differential_bytes(), "incremental prefix projection byte drift")`, and
  `:2354-2357`, `assert_eq!(incremental, &full, "incremental prefix projection
  state drift")`, both inside `assert_prefix_projection_equivalent`
  (`:2344-2358`). The gate is `prefix_projection_differential_enabled`
  (`:2337-2342`) = `cfg!(test) || MC_PREFIX_PROJECTION_DIFFERENTIAL == "1"`,
  read from the environment at `:2340`. The env arm makes both asserts live in
  a release build. **Correction: both do have named tests.** An earlier version
  of this line said neither did, and that was false.
  `dg_goldens_exercise_incremental_native_differential_mode`
  (`differential_goldens.rs:110-204`) calls
  `assert_prefix_projection_equivalent` directly at `:202` on an appended-tail
  projection for every differential-golden case, which executes both asserts in
  their passing direction, and
  `projection_differential_catches_corrupt_first_changed_position`
  (`lib.rs:21115-21155`) is a `#[should_panic(expected = "incremental prefix
  projection byte drift")]` test that deliberately corrupts the first-changed
  frontier (`ProjectionCacheKeyMode::CorruptFrontierForTest`, `:21145`) and
  drives the failing direction. So the byte-drift assert at `:2349-2353` has a
  dedicated negative test and the state-drift assert at `:2354-2357` is executed
  but only positively; a negative test for the state-drift message specifically
  is still missing. Neither test runs in CI, and no `docs/` file mentions the
  environment variable, so the two halves of the original observation that
  survive are the CI gap and the documentation gap.
- **Live in release, in the compaction-off engine: one.**
  `transform.rs:3068`, `PassPlan::Reject(_) => unreachable!("reject returned
  before composition")`, inside `apply_additive_only` (`:2711-3219`). This is
  the branch least likely to be exercised in production and the only one
  carrying a hard `unreachable!`: the shipped OpenCode plugin downgrades
  `transform_mode` from `rust` to `ts` when compaction is off
  (`packages/plugin/src/config/transform-mode.ts:22-27`, called from
  `packages/plugin/src/config/index.ts:605`, stated at
  `CONFIGURATION.md:427`), so on that leg the Rust engine is not the serving
  path precisely when this branch would be selected.
- **Compiled out of release: one.** `transform.rs:7506`,
  `debug_assert!(folded_by_advance || coverage_shrunk_on_bust)` in
  `reanchor_kept_synthetic_todo_if_folded_or_shrunk`. The comment at
  `:7502-7505` explains the invariant it stands in for.
- **`#[cfg(test)]`-only: one.** `transform.rs:5478`,
  `assert_eq!(cached_bytes, fresh_bytes, "serialized output cache drift")`,
  inside the block opening at `:5451`. Lens A calls it the strongest check in
  the engine and it cannot fire in production. Its near-twin
  (`assert_prefix_projection_equivalent`) ships. The pair is inverted relative
  to what a release build wants.

**The other seven scope files have almost nothing.** Verified per file over
production lines only: `injection.rs` (production `1-456`),
`compartment_coverage.rs` (`1-215`), `healing.rs` (`1-159`), `divergence.rs`
(`1-102`), and `m0_compose.rs`, `m1_compose.rs`, `retained_size.rs`
(all-production). Zero `assert!`, zero `debug_assert!`, zero `panic!`, zero
`unreachable!`. Two infallible-by-construction `expect`s:
`compartment_coverage.rs:196` `.expect("non-empty checked above")` and
`retained_size.rs:67` `.expect("CK wire values must serialize for
accounting")`. `scheduler.rs` (adjacent) has two, both static regex
compilation (`:875`, `:910`).

**`transform.rs:1-7510` has 20 `unwrap`/`expect` in production**, and every one
sampled is infallible-by-construction: JSON serialization of a
`serde_json::Value` (`:181`, `:183`, `:206`, `:3602`, `:3641`, `:3716`),
`write!` into a `String` (`:2474`, `:2541`), and mutex acquisition (`:497`,
`:2318`, `:2327`). None depends on untrusted runtime data.

**Guard clusters. This is where 4b's invariants actually live, because there
are almost no assertions.** All unaudited.

- **The four ingress-validity guards**, in straight-line order at the top of
  `apply_once`: `DuplicateBlockId` (`:3355`), the `live` non-synthetic filter
  (`:3357-3361`), `ReservedId` (`:3362-3365`, the reserved-namespace backstop
  over `RESERVED_ID_PREFIX` at `:91`), and `OrdinalViolation` (`:3367-3372`).
  All four sit **after** `descend_lineage` (`:3312`).
- **The monotonicity guard**, `validate_reduction_monotonicity`
  (`:6813-6825`), called at `:4283` on every pass before `classify`. This is
  the fail-loud guard the error doc at `:6809-6812` describes, raising
  `TransformError::ReductionConflict` (`:1811`) rather than serving a stale
  frozen payload.
- **The coverage and boundary rejections**: `CoverageGap` at `:4603`, `:4704`,
  `:4934`, `:5066`; `BoundaryNotPresent` at `:4723`, `:4731`, `:4954`,
  `:5091`. These implement the unbounded-phantom-HARD prevention documented at
  `:1827-1831`. `:4704` sits downstream of the revert truncate.
- **The shape rejections**, `UnknownShape` at `:2890`, `:2900`, `:3077`,
  `:3082`, `:4558`, backed by `valid_m0m1_shape` / `cached_m1_missing`
  (`:6200`), including the "rejected, never cleared" half.
- **The strict-ordering check** in `resolve_coverage`
  (`compartment_coverage.rs:180`), which rejects `next.start <= prev.end`
  (`:177`) while deliberately allowing coordinate gaps.
- **The bounded CAS retry**, `MAX_CAS_RETRIES = 8` (`:82`) compared at `:2284`,
  with the sticky recut intent `boundary_divergence_retry |=
  boundary_divergence_detected` at `:2289`.
- **The store-side commit predicates**: row-version CAS
  (`mc-store/src/lib.rs:7360-7367`), claim-vector match (`:7374-7377`), and the
  bust-only compartment-sequence re-read inside the transaction
  (`:7378-7387`). The last is the one a Defer skips, because
  `compartment_max_seq: is_bust_pass.then_some(..)` at `transform.rs:5574` and
  `is_bust_pass` (`:4439`) requires `Hard | MigrateHard | Soft`
  (`:4435-4438`).
- **The two output-integrity guards** (`:11172-11225`, `:11231-11305`), 4e
  code, asserted on every response by all 210 pass-driving tests through `run`.

## Test support and fault-injection seams

**One seam, and it is test-only.** `run_transform_attempt_hook`
(`transform.rs:2323-2333`, installed at `:2303-2322`), fired at `:5563-5564`
under `#[cfg(test)]`, inside the `if commit_required` block and immediately
before `store.commit_transform` at `:5565`. It is the seam a CAS-conflict test
uses, and because it fires immediately before the commit it can also land a
concurrent store mutation there, which is what makes the Defer-fence and
recut-intent records constructible.

**No seam between the two out-of-transaction writes and the terminal commit.**
`store.descend_lineage` (`:3312`) and
`store.truncate_compartments_for_revert` (`:4646`) both commit their own fenced
transactions before `:5565`, and the only hook in the engine fires after both.
This is the same structural gap Part 4a recorded for the publish transaction
(`../part-4a-historian/existing-checks.md:395-402`).

**No seam inside `commit_transform`.** Verified over
`mc-store/src/lib.rs:7260-7600`: no hook, no injectable error. The
whole-or-nothing claim at `:7259` is therefore not falsifiable at the
partial-commit level by any Rust test; `transform_cas_conflict_leaves_every_overlay_table_empty`
(`:14562`) tests outcome-level rejection, which is a different obligation.

**Clock and lease seams: present, by parameter.** `now_ms`,
`observed_last_response_at_ms`, `historian_active` and `wrapup_active` are all
`ProducerContext` fields the fixture builds directly (`run` builds a context
via `pctx(..)` at `:14332` and mutates it at `:14333`), so cache-TTL and lease
states are settable without a clock abstraction. What is not settable in one
process is the process-global tag baseline cache behind `load_cached_tags`
(`:7639-7696`).

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any executed check
proves.

1. **The whole sub-part is the quietest thing in it.** 263 in-crate tests, 6
   store-side commit tests, and 2 real-transform integration tests execute
   nowhere. The one `mc-module` binary CI runs, `lifecycle_cli`, contains zero
   mentions of `transform`. `mc-store` is in no workflow. `scripts/test-rust.sh`
   and `test:rust-e2e` both exist and neither is invoked. Everything below is
   second-order until this changes, because anything added is added to a suite
   no automation executes.

2. **The two out-of-transaction writes have no fault seam, so the atomicity
   contract is untestable rather than merely untested.** `descend_lineage`
   (`:3312`) commits 43 lines before the guards that reject the same pass
   (`:3355`, `:3362-3365`, `:3367-3372`), and
   `truncate_compartments_for_revert` (`:4646`) commits about 900 lines before
   `:5565`, re-points the pass's own CAS expectation at `:4651` and adopts the
   new epoch at `:4652`, with a `CoverageGap` at `:4704` inside that window.
   The distinction matters and is worth stating precisely. The *specific*
   in-code error paths inside both windows are reachable from a crafted array,
   so the split state can be observed. What no test can do is land an
   *injected* fault at a chosen point in either window, or terminate the
   process there, because the only hook (`:5563-5564`) fires after both writes.
   The surrounding prose says otherwise on both sides: `:1796-1797` says every
   `TransformError` leaves durable state alone because "the CAS simply does not
   advance", and `:3505-3507` says decisions "stay in memory until the final
   cache-state compare-and-swap accepts the pass". Read against
   `core.frozen_units` both hold; read as written both are false on these two
   paths. Compounding it, the fenced-transaction wrapper that defines the
   commit boundary lives in a sibling repository (`cortexkit-store`), and the
   cache-state machine the transition rules depend on lives in another
   (`../commons/crates/cortexkit-cache-core`, a path dependency at
   `Cargo.toml:15`, checked out at a different commit), so neither can change
   with a diff visible to this repository's CI.

3. **The unbounded `load_cached_tags` loop is the one place a claim substitutes
   for a bound.** Its doc (`:7636-7638`) names a post-read probe as the
   correctness mechanism: "A post-read probe makes a concurrent mutation retry
   before its bytes reach the transform." It states the retry as the mechanism
   and **states no bound on it**. The `loop` at `:7644` has two exits, a
   `continue` at `:7678` and a fallthrough revalidation at `:7695`, and no
   attempt counter, 5,000 lines below the explicitly bounded CAS loop
   (`MAX_CAS_RETRIES = 8` at `:82`, compared at `:2284`). It is called on every
   compaction-enabled pass at `:3391`. No test drives concurrent tag mutation
   against it. The dispatch wedge detector at `lib.rs:353-508` exists for
   exactly this symptom class, which suggests hangs on this path have been
   seen. Both sibling lenses reached this independently
   (`pass-firing-work-bounded-by-max-cas-retries` and
   `sel-cas-retry-budget-bounded-tag-hydration-unbounded`); synthesis must
   merge them rather than catalog both.

4. **`m0_compose.rs`, `m1_compose.rs` and `retained_size.rs` carry determinism
   claims across 845 lines with zero tests.** `m0_compose.rs` (403 lines)
   claims "It is pure given the store contents + `now_ms` + `budget`: same
   inputs -> same bytes, the property the frozen-m0 cache depends on" (`:6-9`).
   `m1_compose.rs` (230 lines) has zero tests **and zero doc comments**, yet it
   is the producer for the strongest untested claim in the register, that
   `revision` is "a digest over ALL byte-affecting m1 render inputs such that
   `render` is a pure function of what the digest covers"
   (`transform.rs:509-512`), stated 279 lines away from the file that must
   satisfy it. `retained_size.rs` (212 lines) claims "the numbers are
   estimates, but they cannot diverge between those paths" (`:6`) and feeds
   every cache budget in the sub-part. Between them these three files own m0
   bytes, m1 bytes, and every retention accounting number, and no check of any
   kind touches them.

5. **The Defer commit's watermark write is guarded by nothing on the path that
   writes it.** `:5156-5159` writes `meta.coverage_compartment_seq` from a read
   taken outside any predicate, while `:5574` withholds the compartment fence
   from exactly that pass class. The nearest existing check,
   `claim_vector_commit_fence_never_publishes_interleaved_stale_bytes`
   (`:14185`), covers the claim-vector predicate instead.

6. **The strongest drift check in the engine is compiled out, and its sibling
   ships with no documentation.** `:5451-5479` re-renders every cached output
   and asserts byte equality under `#[cfg(test)]`;
   `assert_prefix_projection_equivalent` (`:2344-2358`) does the analogous
   thing and is live in release under `MC_PREFIX_PROJECTION_DIFFERENTIAL`, a
   variable no `docs/` file mentions. The asymmetry is in documentation and
   release gating, not in test coverage: the projection pair is named by two
   tests (`differential_goldens.rs:110-204` and `lib.rs:21115-21155`) while the
   output-cache drift assert at `:5478` is reached only incidentally, by
   whichever of the 210 whole-pass drivers renders a cached output.

7. **The compaction-off engine holds a production `unreachable!` and may be
   unreachable on the shipped leg.** `:3068`, inside a 509-line branch
   (`:2711-3219`) whose enabling flag causes the shipped OpenCode plugin to
   stop calling the Rust transform at all. The only executing check anywhere
   near it tests the TypeScript resolver
   (`packages/plugin/src/config/transform-mode.test.ts:69`).

8. **The caveman `assert!` is the sub-part's only unconditional production
   panic and has no test that reaches it.** `:25463-25490`, `:25606` and
   `:25660-25684` drive `new_caveman_units` with `caveman_min_chars = 1`; none
   constructs a deeper tier whose output is longer than the frozen payload.
   Whether that is constructible is a property of `caveman.rs`'s level ladder
   (4e scope), and the documentation describes caveman with no failure mode.

9. **`docs/AUDIT-KNOWN-ISSUES.md` has no Rust transform entry.** Fifty-one
   transform-adjacent lines, all about the TypeScript pipeline, in a file whose
   own framing (`:3-14`) instructs auditors not to re-report what it lists.
   `A24` (`:407`) discusses the atomicity question this sub-part answers and
   discusses it about the other implementation. A search for `apply_once`,
   `commit_transform` or `mc-module` returns zero matches. None of lens A's
   five leads, lens B's eight, or lens C's seven is tracked there.

10. **Four documented configuration keys have no implementation here and no
    check that would notice.** `protected_tags` (`CONFIGURATION.md:165`,
    example `:795`) has zero occurrences in `config.rs`; its only source is the
    request serde default `20` (`transform.rs:893-895`), and
    `apply_claude_code_config_controls` (`lib.rs:173-193`) does not set it.
    `execute_threshold_tokens` (`:168`, `:319-338`) has no `McModuleConfig`
    field and `scheduler_config` hardwires `execute_threshold_tokens: None`
    (`transform.rs:6109`). The object form of `execute_threshold_percentage`
    (`:167`, example `:791`) is read with `number_at` (`config.rs:430-431`,
    `:515-517`), which is `as_f64` filtered to finite (`:631-636`), so an
    object yields `None` silently. The documented lower bound `20` (`:167`) is
    enforced as `1` (`config.rs:568-570`). `protected_tags` is the
    safety-relevant one: it is the count of newest tags immune from dropping,
    feeding `newest_active_tag_block_ids` (`transform.rs:4177-4182`) and
    caveman's protected cutoff (`:6318`). A configuration-reference conformance
    check comparing documented keys against `config.rs` parsing would catch all
    four; none exists.

11. **Three CONFIGURATION.md idempotency and byte-identity claims have no Rust
    check.** Markers are "idempotent by regex detection ... re-running the
    injector on any transform pass produces the same output" (`:659`); the user
    hint is "replayed exactly (from a deterministic per-message cache), so the
    append is idempotent and never rewrites cached content" (`:716`); smart
    drops mean "defer passes replay byte-for-byte identically" and, when off,
    "the messages sent to the model are byte-identical to the age-based-only
    behavior" (`:763`). These are the strongest determinism statements in the
    documentation for this sub-part, and lens C could trace none of them to an
    assertion, guard, or test name in Rust.

12. **There is no TypeScript-oracle golden driver for the transform.** Part 4a
    at least has `validate_golden_matches_typescript_oracle`, ungated though it
    is. 4b has no counterpart, while 228 tests over the TypeScript twin run on
    every pull request.

## Sampling limits on this inventory

Four limits, stated so a later pass does not read absence as absence of risk.

- **The 226-of-280 in-scope split is a symbol match, not measured coverage,**
  and 27 tests remain unclassified. A precise number would require adding
  coverage instrumentation, which the repository does not have. Every count in
  the framing table other than that one was obtained by direct attribute
  counting at `HEAD`.
- **Whether the two output-integrity guards count as 4b coverage is
  unresolved.** They are 4e code asserted by 210 4b tests through one shared
  helper. They are listed here rather than claimed.
- **Scope is contested.** The task names `scheduler.rs` and the `mc-store`
  transform commit as 4b; the scope map's own 4b entry
  (`../part-4-module/_lenses/scope-map-and-risk-ranking.md:521-533`) lists
  eight units including neither and assigns `scheduler.rs` to 4f. This file
  follows the scope map and cites both as adjacent, which is the posture all
  three lenses took. If the wider scope is authoritative, `scheduler.rs`'s 16
  tests and the six `mc-store` commit tests move from cited to in-scope and the
  in-crate total rises from 263 to 279.
- **`load_cached_tags`'s body is 4e scope.** The scope map assigns
  `transform.rs:7511-12623` to 4e, so the loop at `:7644` is catalogued here
  only through its unbounded call from the engine at `:3391`. The 228-test
  TypeScript figure and the 70-test caller figure were counted by matching
  top-level `it(`/`test(` and are lower bounds if any suite nests further.
