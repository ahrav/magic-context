# Part 4b fault-to-property map

For each property, what must actually occur for a test to be non-vacuous, and
whether the harness can produce it today.

Same rules as Parts 1 through 4a: safety checks must hold *while* their faults
are active; liveness checks need a bounded fault-free window; crash-recovery
needs a real termination; rare implementation branches need deterministic
injection to be reachable at all; and coverage checks assert independent
preconditions, never the violation.

Provenance as in
[existing-checks.md](existing-checks.md): actual `HEAD` is `e447c927`, not the
`b5dc778e` the task states, and `crates/mc-module` and `crates/mc-store` are
byte-identical to `76cd6f41` across that span, so every source line below holds
at all three commits. CI references are at `76cd6f41` with the `HEAD` line
noted.

Three framing points specific to this part.

First, **the dominant obstacle is not a missing fault.** No CI job executes any
test in this scope: 263 in-crate transform tests, 6 `mc-store` transform-commit
tests, and the two real-transform integration tests in `direct_host.rs` run
nowhere, and `mc-store` is named in no workflow at all. The availability column
below therefore describes what a developer can construct locally. Nothing in it
is protected by automation.

Second, **the seam that matters most already exists and is being used for one
thing only.** `run_transform_attempt_hook` (`transform.rs:2323-2333`, installed
at `:2303-2322`) fires at `:5563-5564`, inside the `if commit_required` block
and immediately before `store.commit_transform` at `:5565`. Existing tests use
it to force a CAS conflict. Because it fires immediately before the commit, the
same hook can land any concurrent store mutation inside the commit window, which
is what makes the Defer-fence, revert-idempotency, recut-intent and
output-cache records constructible without new infrastructure.

Third, **one distinction has to be stated precisely or the availability column
will read as more optimistic than it is.** The two out-of-transaction writes,
`store.descend_lineage` (`transform.rs:3312`) and
`store.truncate_compartments_for_revert` (`:4646`), each have reachable in-code
error paths downstream of them inside the same pass: the array-validity guards
at `:3355`, `:3362-3365` and `:3367-3372` for the first, and the `CoverageGap`
at `:4704` for the second. So the split durable state **can be observed today**
from a crafted request, with no new seam. What cannot be done is landing an
*injected* fault at a chosen point in either window, or terminating the process
there, because the only hook in the engine fires after both writes. The
atomicity obligation as the error doc states it (`:1796-1797`, `:3505-3507`) is
therefore untestable in general and observable in two specific instances. Rows
below say which form they mean.

## Fault classes required

`T0` is listed first because it is the cheapest capability in this part and it
is not a fault at all. `T8` and `T9` are additions beyond the classes the task
named; they are listed because five records cannot be made non-vacuous without
them and neither is expensive.

| Class | Description | Available today |
| --- | --- | --- |
| T0 test execution in CI | Any workflow job that builds and runs `mc-module --lib` or any `mc-store` test target | **No.** Verified across all five files in `.github/workflows/` at `76cd6f41`. The only `mc-module` test invocation is `cargo test -p mc-module --test lifecycle_cli` (`ci.yml:168`, `HEAD` `:172`), which selects one integration binary and does not build `--lib`. `mc-store` has zero matches in any workflow. `scripts/test-rust.sh` (`cargo nextest run --workspace`) and `test:rust-e2e` exist in root `package.json` and no workflow calls either. This costs a workflow change and no new infrastructure |
| T1 compare-and-swap conflict injection | A conflicting row committed between this pass's read and its terminal commit, forcing `TransformError::Store(McStoreError::CasConflict)` at `:2283` and a reload | **Yes, and the seam is already built and already used.** `run_transform_attempt_hook` fires at `:5563-5564` under `#[cfg(test)]` immediately before `commit_transform` (`:5565`). `boundary_divergence_recut_retries_after_interleaved_historian_publish` (`:20433`) already drives one retry. What no test does is exercise the **bound**: `MAX_CAS_RETRIES = 8` (`:82`, compared at `:2284`) has no dedicated test, so nine attempts per firing is asserted nowhere. The same hook also lands a non-conflicting mutation, such as a compartment append, inside the commit window |
| T2 a fault between the two out-of-fence writes and the terminal commit | An injected error or a process termination at a chosen point in `:3312`-`:3371` or `:4650`-`:5565` | **No, and there is no seam of any shape.** The engine's only hook fires at `:5563-5564`, after both writes. No test in this scope terminates a process; `direct_host.rs:149` restarts a fixture host between requests, not inside a pass. The reachable in-code errors are a partial substitute and are credited per row, not to this class. Compounding it, the fenced wrapper that defines the commit boundary lives in `../commons/crates/cortexkit-store` and the cache-state machine in `../commons/crates/cortexkit-cache-core`, a path dependency at `Cargo.toml:15` checked out at a different commit, and CI provisions the siblings as metadata-only stubs (`ci.yml:160`, `HEAD` `:164`) |
| T3 store-transaction failure inside the commit | An error or a termination landing between two of the ten write groups in `commit_transform` (`mc-store/src/lib.rs:7390-7597`) | **No.** Verified over `:7260-7600`: no hook, no injectable error. Outcome-level rejection is a different matter and is available: the row-version CAS (`:7360-7367`), the claim-vector match (`:7374-7377`) and the bust-only compartment-sequence re-read (`:7378-7387`) are all reachable, and `transform_cas_conflict_leaves_every_overlay_table_empty` (`:14562`) reaches the first. What is unavailable is a **partial** commit. **No record in the catalog depends on this class**, which is itself worth recording: the all-or-nothing claim at `:7259` has no property covering its partial-commit failure mode |
| T4 process-local state variation across two processes on one store | Two module processes, or one process restarted, transforming the same session against one store, so `observed_last_response_at_ms`, `historian_active`, `wrapup_active`, `now_ms` and the process-global tag baseline cache differ between them | **Partial, and this is the pivot for the selection-purity records.** The four `ProducerContext` fields are settable per test, so a single-process test can *simulate* the divergent inputs: `observed_last_response_at_ms` returns `None` until this process has seen a response for that session (`lib.rs:4460-4483`), and `None` sets `last_response_time_ms = 0`, which disables both the idle-TTL HARD (`scheduler.rs:429-431`) and the TTL arm of `should_execute` (`:476-478`). What a single process cannot vary is the process-global tag baseline cache behind `load_cached_tags` (`transform.rs:7639-7696`), which is a `Mutex` singleton, nor `RandomState` seeding across processes. A genuine two-process form exists in principle: `direct_host.rs` already drives a fixture host over a real process boundary with a `"kind": "transform"` request (`:67`, `:110`; `:149`, `:173`). Nothing points two of them at one store |
| T5 budget and threshold boundary values | A request field or config value at or past a boundary: `effective_execute_threshold` as `NaN`, negative, or above 90; `protected_tags` other than 20 on a Claude Code route; `execute_threshold_tokens` or an object-valued `execute_threshold_percentage` in config | **Yes, and it is the cheapest capability in the part after T0.** No seam, no store state, no second process: a field value. `effective_execute_threshold` is `Option<f64>` with no validator (`transform.rs:707-709`, wire mirror `:924`), and `execute_threshold_or` (`lib.rs:1710-1712`) is a bare `unwrap_or` with no finiteness or range check, so any JSON number arrives intact at the selection ceiling's `clamp(1.0, 100.0)` (`:4231`), where `f64::clamp` returns `NaN` for a `NaN` input. The two consumers sanitize differently: `scheduler::resolve_execute_threshold` falls back to `65.0` on non-finite (`scheduler.rs:461-463`) and `min`s to `90.0` (`:464`) |
| T6 unbounded tag hydration under a concurrent tag writer | A writer mutating the session's tag summary between the two reads at `transform.rs:7657`/`:7659`, or between `:7683`/`:7684`, on every iteration of `load_cached_tags` | **Partial for the static half, unresolved for the spin.** The missing counter is verifiable statically: the `loop` at `:7644` has two exits, a `continue` at `:7678` and a fallthrough revalidation at `:7695`, and no attempt counter. Constructing repeated retries needs a second tag writer; `mint_or_get_tags` (`mc-store/src/lib.rs:6258`) is reachable only under `test` or the `test-support` feature, so a writer exists in test builds. Whether the loop is livelock-reachable is unresolved, because the `can_append` arm requires `generation - self.generation == appended`, which does not obviously progress monotonically. The store generation advances via SQLite triggers, so any tag mutation invalidates the summary |
| T7 cross-implementation differential against the TypeScript transform | Running the same input through the Rust engine and through the parallel TypeScript transform implementation and comparing served bytes | **Partial, and the missing half is wiring rather than infrastructure.** Both sides exist and both are checked in. The TypeScript twin has 228 tests across 16 files under `packages/plugin/src/hooks/magic-context/`, all executing on every pull request through `bun run test` (`ci.yml:249`, `HEAD` `:257`). The Rust side has 210 whole-pass drivers through one helper (`transform.rs:14331-14338`). Unlike Part 4a, there is **no** in-crate oracle tying them together: no counterpart to `historian_validate.rs:1384`. The blockers are decisions, not work: who owns the harness, and which documented byte-identity claims (`CONFIGURATION.md:659`, `:716`, `:763`) become failures rather than documented divergences |
| T8 crafted CK ingress array | A request whose array is well-formed enough to reach `apply_once` and then violates one ingress or coverage rule: a duplicate flat block id, a live block whose id starts with `mc_`, non-increasing non-synthetic ordinals, a replayed synthetic todo pair whose CK metadata lacks the `synthetic` marker, a stray live item below coverage end | **Yes.** The array is harness-supplied and the guards are straight-line at the top of `apply_once`: `DuplicateBlockId` (`:3355`), the `live` filter (`:3357-3361`), `ReservedId` (`:3362-3365`, over `RESERVED_ID_PREFIX` at `:91`), `OrdinalViolation` (`:3367-3372`). `CoverageGap` (`:4603`, `:4704`, `:4934`, `:5066`), `BoundaryNotPresent` (`:4723`, `:4731`, `:4954`, `:5091`), `UnknownShape` (`:2890`, `:2900`, `:3077`, `:3082`, `:4558`) and `ReductionConflict` (`:6820`) are all reachable from crafted state. The plugin sets `lineage_switched` from `passInputs` (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1404`), so the lineage-switch half is production-reachable too |
| T9 clock advance and lease state | `now_ms` past `DEFAULT_CACHE_TTL_MS` (`scheduler.rs:23`, 300,000 ms), plus `historian_active` or `wrapup_active` held true or false across a chosen number of passes | **Yes, by parameter rather than by seam.** All four are `ProducerContext` fields the fixture builds directly (`run` builds a context at `:14332` and mutates it at `:14333`), so no clock abstraction is needed. This is the one place 4b is cheaper than 4a, where the equivalent capability (H8) was unavailable and blocked two liveness records outright (`../part-4a-historian/fault-map.md:41`) |

One availability caveat that cuts across T1, T8 and T9. Two records hinge on
the caveman path, which is `explicit-config-only`: the module config default is
`CavemanConfig { enabled: false, .. }` (`config.rs:74-79`, `false` at `:76`),
the request serde default is `false` (`transform.rs:729-731`), and the shipped
OpenCode plugin sends `caveman_enabled: !isSubagent &&
deps.cavemanTextCompression?.enabled === true`
(`rust-mode-transform.ts:2015-2016`). Enabling it in a test is one field. But
the path carries an unconditional production `assert!` at `:6366-6369`, so any
test or marker that requires the deeper-tier-growth case to occur **crashes the
pass in release**. Design around it rather than into it.

## Map

All 24 records: twelve from lens A (engine and cache-state transition) and
twelve from lens B (pass selection, eligibility, budgeting). "Non-vacuous
today" means a developer can construct the required state with the current
harness. It does **not** mean the check runs anywhere; under T0 none of them
do.

Two records overlap and synthesis must merge them rather than catalog both:
lens A's `pass-firing-work-bounded-by-max-cas-retries` and lens B's
`sel-cas-retry-budget-bounded-tag-hydration-unbounded` cover the same
`MAX_CAS_RETRIES` bound and the same unbounded `load_cached_tags` loop, reached
independently. Both rows are kept below so the count matches the 24 the lenses
produced.

Two reachability preconditions are stated once here rather than per row. Every
lens A record and ten of the twelve lens B records need
`compaction_enabled == true`, which is the default (`config.rs:123`) and short-
circuits to `apply_additive_only` when false (`transform.rs:3233-3235`). The
two caveman records need the opt-in described above.

### Engine: commit point, atomicity, and the out-of-fence writes

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| engine-terminal-cas-is-the-sole-core-meta-writer | An error raised inside the mutation region `:4369`-`:5565`, then re-read the row and compare the `(row_version, core_state, meta)` triple against the one `load_transform_snapshot` (`:3387`) returned. `CoverageGap`, `BoundaryNotPresent`, `IdentityDrift` (`:5786`), `ReductionConflict` (`:6820`) and `FrozenRedTargetVanish` (`:5814`) are all reachable from a crafted array (T8) | **Yes** — for the error form. The kill form needs T2 |
| lineage-descent-write-precedes-the-array-validity-guards | A lineage-switch request (`lineage_switched: true`, `is_subagent: false`, well-formed `descent_edge_id`, `prior_conversation_key`, `constituents`) whose CK array also carries a duplicate flat block id, a live `mc_`-prefixed id, or non-increasing non-synthetic ordinals (T8). **No fault injection needed:** the guards at `:3355`-`:3372` are downstream of the `:3312` commit in straight-line code | **Yes** |
| revert-truncate-commits-outside-the-terminal-cas | `loaded.core.reconcile_pending == true` plus a minted anchor absent from the live array (`:4636-4645`), which is the post-revert shape, then the `CoverageGap` at `:4704` (T8). That error sits inside the `:4650`-`:5565` window, so the split state is observable with no seam. A process kill anywhere else in the ~900-line window needs T2 | **Yes** — for the `:4704` form only |
| revert-epoch-bumps-at-most-once-per-logical-recut | The reconcile-rematerialize arm plus a `CasConflict` on the terminal commit so attempt 2 re-enters the truncate (T1). Idempotence rests on the `dropped_count == 0` no-op arm (`mc-store/src/lib.rs:9053-9059`) returning the current epoch, and that on the recomputed `keep_through_seq` never being smaller than the surviving max sequence. Nothing covers the no-op arm today; `:18267` covers the bump path | **Yes** |
| exactly-one-core-step-executes-per-pass | **None.** Structural: instrument `CoreState::step` with a per-pass counter. The five call sites (`:4541`, `:4794`, `:5002`, `:5098`, `:5151`) are mutually exclusive by control-flow shape plus the *move* of `boundary_token: String` (`:3540-3544`) into whichever `PassInput` runs | **Yes** |
| core-fields-mutated-outside-the-step-machine | For the frozen-set half, a coverage-extending SOFT (`m1.new_coverage.is_some()`, `:5108`) with at least one frozen `red:` unit whose target the advance folds below coverage, so `prune_covered_red_units` (`:5117`) runs after the step bumped `core.version` (T8). For the latch half, a `validate_lineage_anchor` failure (`:2484-2547`, detected `:3452-3459`, handled `:4429-4433` and `:5191-5196`) on a pass whose boundary is still present. The `cav:` half additionally needs the caveman opt-in | **Yes** |

### Engine: fences, races, and cache validity

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| defer-commit-carries-no-compartment-fence | A Defer pass with `compartment_seq_changed_since_meta` true and `current_m1_digest == loaded.meta.m1_revision` (`:5156-5158`), plus a compartment append committing between the m1 revision read (`:5029`/`:5119`) and `:5565`. The hook at `:5563-5564` fires inside that window, so the append lands there (T1). The `row_version` CAS does not help: `append_compartments` (`mc-store/src/lib.rs:9167`) does not touch `mc_cache_state`, and `compartment_max_seq` is `None` on a Defer because `is_bust_pass` (`:4439`) excludes it | **Yes** |
| speculative-tag-numbering-has-two-authorities | `tagging_active` (`:3503-3504`, requires `ClaudeCodeAnthropic` or `OpencodeAiSdk` plus `tool_present`) and a mint batch containing a `block_id` already present in `mc_tags`, so the store's skip branch (`mc-store/src/lib.rs:7488-7495`) desynchronises every later number in the batch. Whether `compute_active_overlay_decisions` (`transform.rs:8574-8761`, 4e scope) can ever emit such a `block_id` is unresolved | **Partial** — the coverage form over the two numbering authorities is writable today; the mismatch needs a 4e answer first |
| pass-firing-work-bounded-by-max-cas-retries | For the retry bound, the hook at `:5563-5564` committing a conflicting row on the first three attempts, then stopping, and asserting the firing returns within `MAX_CAS_RETRIES + 1 = 9` attempts (T1). For the tag-loop half, a writer changing the tag summary on every iteration (T6) | **Partial** — the attempt bound is constructible and unasserted today; the tag-loop half is blocked on T6 |
| synthetic-strip-precedes-every-coverage-read | An OpenCode array carrying a replayed synthetic todo pair whose CK metadata lacks the `synthetic` marker, so recognition must come from the reserved call-id namespace (`is_synthetic_todo_id`, `injection.rs`), plus a harness block whose flat id starts with `mc_` for the backstop (T8). The mechanism under test is a shadow, not a copy: `let req = rebased_req.as_ref().unwrap_or(ingress_req)` at `:3342` | **Yes** |
| recut-intent-survives-the-mandatory-cas-reload | A divergence candidate from `detect_boundary_divergence_candidate` (`:6557-6600`) plus a publish committing between detection and the terminal commit, forcing the `CasConflict` at `:2283` (T1 plus T8). `transform.rs:20433` already constructs exactly this | **Yes** |
| output-cache-replace-trails-the-accepted-commit | A CAS conflict on the terminal commit with a non-empty `output_cache_entries` (T1), plus separately a reconcile-rematerialize pass that bumps the epoch mid-pass at `:4652` and then renders, so `snapshot` (`:5381`) is keyed on the post-truncate epoch and evicts on mismatch (`:423-429`) | **Yes** |

### Selection: purity, determinism, and process-local inputs

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| sel-pass-order-deterministic-under-fixed-inputs | **No fault for the in-process form:** a session with more than one eligible reduction target, then a second evaluation of the selection region over the same inputs. Every ordered artifact uses `BTreeMap`, `BTreeSet` or an explicit total sort (`:6869-6882`, `:6891-6919`, `:6410-6435`, `:6728-6731`, `:6344`), so the check is a real oracle rather than a tautology. The cross-process form, which is where a randomized `RandomState` could bite, needs T4 | **Yes** — in-process; the cross-process form is Partial |
| sel-eligibility-reads-process-local-scheduler-state | A restart, or a second module against the same store, then a transform for a session whose durable `last_committed_pass_at_ms` is older than the cache TTL, asserting the first pass in the new process does not fire the idle HARD (T4). The single-process simulation is available by setting `observed_last_response_at_ms = None`, which is what the production path produces on first observation (`lib.rs:4482`); a genuine second process sharing the store is not wired | **Partial** — the simulated form is writable today, the two-process form is the missing capability |

### Selection: budgets and thresholds

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| sel-budget-execute-threshold-unvalidated-from-request | One request field: `effective_execute_threshold` as `NaN`, a negative, or a value above 90 (T5). `lib.rs:8298-8299` prefers it over the clamped route config unconditionally, so it reaches `clamp(1.0, 100.0)` at `:4231` intact | **Yes** — the cheapest oracle in the part |
| sel-budget-ceiling-clamp-diverges-from-scheduler-cap | An effective threshold above 90 (T5), then assert the percentage used at `:4231` equals the threshold `scheduler::resolve_execute_threshold` produced for the same pass. Shares its enabling state with the record above; the defect under test is the divergent cap (`clamp(1.0, 100.0)` versus `min(90.0)` at `scheduler.rs:464`), not the missing validation | **Yes** |
| sel-protected-tags-not-read-from-module-config | A user config setting `protected_tags` to something other than 20 on a Claude Code route (T5), then assert the effective value used by `newest_active_tag_block_ids` (`:4177-4182`) and caveman's protected cutoff (`:6318`). Structural today: `config.rs` has zero occurrences of the key, so the check is over `apply_claude_code_config_controls` (`lib.rs:173-193`) omitting it | **Yes** |
| sel-per-model-and-token-thresholds-inert-in-module | A config carrying `execute_threshold_tokens` or an object-valued `execute_threshold_percentage` (T5), then assert the `SchedulerConfig` handed to `scheduler::decide` reflects the parsed shape. `scheduler_config` hardwires `execute_threshold_tokens: None` (`:6109`) and always builds `Percentage` (`:6106-6108`), so `ExecuteThresholdConfig::ByModel` (`scheduler.rs:112-113`) is unreachable from either call site (`:2814`, `:3973`) | **Yes** |

### Selection: observability, liveness, and caveman

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| sel-skip-unobservable-when-producer-gate-closed | Queue an agent drop through `handle_agent_drops_value`, then issue a transform whose usage is below the execute threshold, whose cache is warm, and which has no hard advisory, giving `producer_gate == false` and `SelectionOutcome::default()` (`:4258`) whose four counters are `None` (`selection.rs:1096-1104`). No fault class beyond ordinary state | **Yes** |
| sel-queued-drop-drains-within-cache-ttl-window | One queued pending-drop row, usage below the execute threshold on every pass, no `soft_refresh_pending`, an initialized session, no historian lease, then `now_ms` advanced past `cache_ttl` (T9). The gate can also be held shut past the bound by `last_response_time_ms == 0` after a restart (T4) or by `ordinary_historian_veto` (`:4098-4104`) | **Yes** — with the limit that lens B did not enumerate every retirement path at `:6735-6779`, so the durability of a surviving drop across many defers is unverified |
| sel-divergence-repair-bounded-by-three-pending-passes | A coverage gap with a missing or stale applied-compartment watermark so `divergence_candidate` is `Some` and `compartment_revision_matches` is false, plus no `divergence_inputs_moved` (T8), then three passes with `historian_active` and `wrapup_active` both false (T9). The uncovered arm is the freeze at `:3926-3928`, which needs a lease held true across many passes | **Yes** |
| sel-cas-retry-budget-bounded-tag-hydration-unbounded | For the static half, none: the absence of a counter in the `loop` at `:7644` is verifiable by reading the code. For the contention half, two writers on one store or an interleaving tag mint from another route (T6) | **Partial** — merges with `pass-firing-work-bounded-by-max-cas-retries` |
| sel-caveman-deeper-tier-growth-panics-in-production | Caveman enabled, a primary session, a block inside the eligible tag window, and a text block for which the deeper tier's compression is longer than the frozen payload. Whether such a block exists is a property of `caveman.rs`'s level ladder (4e scope) and is unresolved, because compression is always applied to the persisted original (`:6338-6340`) rather than to the intermediate | **Partial** — the tie arm at `:6370-6374` is constructible and is the safe coverage form; the growth case that fires the `assert!` is unresolved |
| sel-caveman-eligibility-ladder-deterministic-over-frozen-basis | Caveman enabled, a primary session, a bust pass, and at least one new tag minted in that same pass so the hydrated and final tag sets differ. `age_basis_tag` is the max *hydrated* tag number (`:4492-4497`), captured before the mint suffix is appended and persisted in the same commit; a non-bust pass reuses the prior durable value (`:4499-4501`) | **Yes** |

**Totals: 19 non-vacuous today, 5 partial, 0 no.**

The distribution differs from both neighbours, and the reason is worth naming.
Part 3 had cheap capabilities missing and records blocked on infrastructure.
Part 4a had almost everything constructible and one record blocked outright by a
missing seam inside the publish transaction
(`../part-4a-historian/fault-map.md:108`). Part 4b has **no** blocked record and
still has the same structural hole, because the hole falls on a claim no record
covers: T3, a partial commit inside `commit_transform`, is unavailable and
nothing in the catalog needs it. The five `Partial` rows cluster on three narrow
capabilities: T4 (two processes on one store, 2 rows), T6 (tag contention, 2
rows, which are the merge pair), and a 4e answer about whether a duplicate mint
`block_id` or a growing deeper caveman tier is constructible at all (2 rows).

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies,
so it fires without a defect present. Names are constants, globally unique, and
never constructed dynamically.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `transform_pass_reached_the_terminal_commit_gate` | `commit_required` (`:5559-5560`) evaluated true | The ordinary shape of every accepted pass |
| `transform_pass_returned_err_inside_the_mutation_region` | An error raised between the clone at `:4369` and the commit at `:5565` | Legal: the coverage, boundary and shape guards exist to raise exactly this. It is the precondition of the sole-writer obligation, not the violation |
| `transform_lineage_descent_committed_before_the_array_guards` | A pass observed to reach `:3312` and then reach `:3355` | A structural fact about straight-line order, true today with fully correct behaviour |
| `transform_revert_truncate_returned_a_nonzero_dropped_count` | `truncate_compartments_for_revert` (`:4646`) deleted at least one compartment | Legal; the reconcile-rematerialize arm exists for it |
| `transform_revert_truncate_returned_the_no_op_arm` | The `dropped_count == 0` arm (`mc-store/src/lib.rs:9053-9059`) taken on a later attempt | Legal, and it is the mechanism the documented idempotency claim names. Untested today |
| `transform_firing_performed_more_than_one_apply_once_attempt` | The retry loop at `:2274` iterated | Legal; `MAX_CAS_RETRIES` exists for it |
| `transform_core_step_executed_once_for_this_pass` | Exactly one `CoreState::step` call completed | The positive form of the one-step invariant, legal by construction |
| `transform_soft_step_was_followed_by_a_coverage_prune` | `prune_covered_red_units` (`:5117`) or `prune_covered_caveman_units` (`:5118`) ran after the step bumped `core.version` | Legal and is the documented ordering; recording it is what makes the "`version` is not a witness for the frozen set" finding checkable |
| `transform_defer_commit_wrote_a_compartment_watermark` | A committing Defer wrote `meta.coverage_compartment_seq` at `:5156-5159` | Legal; that is the ordinary Defer path |
| `transform_commit_withheld_the_compartment_fence` | `compartment_max_seq` was `None` at `:5574` | Legal: `is_bust_pass` excludes Defer by design, so observing `None` is a fact about the code, not an outcome |
| `transform_commit_carried_a_nonempty_tag_mint_span` | `tag_mint_count > 0`, so the commit sliced `tag_rows` at `:5591-5592` | Legal on any tagging pass |
| `transform_store_skipped_an_existing_tag_block_id_at_commit` | The store's skip branch (`mc-store/src/lib.rs:7488-7495`) was taken for at least one input | The independent precondition of the numbering desync, stated without asserting a desync |
| `transform_ingress_carried_a_replayed_synthetic_todo_pair` | An ingress array carried a synthetic pair recognised by its reserved call id rather than its CK marker | Legal OpenCode replay shape; the normalization exists for it |
| `transform_ingress_carried_a_reserved_mc_prefixed_live_id` | A live block's flat id started with `RESERVED_ID_PREFIX` (`:91`) | Legal harness input and the exact case the `:3362-3365` backstop exists to catch |
| `transform_effective_execute_threshold_arrived_outside_one_to_ninety` | The request field carried a non-finite or out-of-band value before either clamp | An input-domain outcome, legal to observe; the precondition of the clamp divergence, not the divergence |
| `transform_producer_gate_closed_with_a_nonempty_pending_drop_queue` | `producer_gate == false` while durable pending drops existed | The common steady state; the precondition of the unobservable-skip record |
| `transform_pass_observed_last_response_time_of_zero` | `last_response_time_ms == 0` on a pass, which is what `lib.rs:4482` produces on first observation in a process | Legal and deliberate; the precondition of the process-local-input record |
| `transform_caveman_deeper_tier_tied_on_length` | The equal-length arm at `:6370-6374` taken: shallower bytes kept, deeper depth recorded at `:6378` | Legal and documented in the code's own comment. **Use this and never a growth marker**, because the `assert!` at `:6366-6369` panics in release on growth |
| `transform_tag_hydration_loop_retried_at_least_once` | The `continue` at `:7678` or the fallthrough revalidation at `:7695` taken | Legal: the post-read probe exists for it. The precondition of the unbounded-loop concern, not a spin |
| `transform_divergence_pending_count_was_frozen_by_a_held_lease` | The freeze arm at `:3926-3928` taken because `historian_active` or `wrapup_active` was true | Legal and deliberate per the comment at `:3919-3923`. This is the marker that keeps the three-pass `sometimes` honest |

### The two existing `sometimes` records, checked against METHOD.md

Lens B produced the part's only two `sometimes` records. Both comply, and one
needs a guard against a specific failure mode. Neither is duplicated above.

- `sel-queued-drop-drains-within-cache-ttl-window` **complies.** It asserts a
  desired situation occurs (the drop applied) rather than a violation, no
  `always(!X)` companion exists, and the bound is stated in the unit the code
  bounds, `cache_ttl` milliseconds (`scheduler.rs:810-812`, `:429-431`).
- `sel-divergence-repair-bounded-by-three-pending-passes` **complies, with one
  refinement.** The bound is stated in passes, the unit
  `BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT` (`:85`) bounds, which is correct. The
  risk is starvation rather than illegality: the counter is *frozen*, not
  incremented, while `historian_active || wrapup_active` (`:3926-3928`), so a
  campaign that happens to hold either lease across the window never advances
  toward the repair and the marker fails for a legal reason. The three-pass
  window must therefore be constructed with both leases false, and that
  precondition should itself be witnessed by
  `transform_divergence_pending_count_was_frozen_by_a_held_lease` observed
  **false** for the counted passes. Without that, a green run and a starved run
  are indistinguishable.

### Anti-patterns to avoid in this part specifically

Five concrete pairings are forbidden by METHOD.md's rule, and each is tempting
here because the defect is easier to name than its precondition.

- Do not pair `always(!revert_epoch_bumped_twice)` with
  `sometimes(revert_epoch_bumped_twice)`. That marker can only fire by observing
  the extra bump. Assert
  `transform_firing_performed_more_than_one_apply_once_attempt` and
  `transform_revert_truncate_returned_the_no_op_arm` instead: two independent
  preconditions, both legal, both present on a correct implementation.
- Do not pair `always(!stale_compartment_watermark_committed)` with
  `sometimes(stale_compartment_watermark_committed)`. Assert
  `transform_defer_commit_wrote_a_compartment_watermark` and
  `transform_commit_withheld_the_compartment_fence` instead. The second is a
  fact about `is_bust_pass`, not an outcome.
- Do not pair `always(rendered_tag_number == durable_tag_number)` with
  `sometimes(tag_number_desync)`. Assert
  `transform_store_skipped_an_existing_tag_block_id_at_commit` instead.
- Do not pair `always(!caveman_payload_grew)` with
  `sometimes(caveman_payload_grew)`. The production `assert!` at `:6366-6369`
  **is** the enforcement and it panics, so a companion `sometimes` can only fire
  by crashing the pass in release. This is why the record is written as
  `unreachable` on the assertion's failing edge rather than as `always` over the
  size relation: `unreachable` needs no witness of the forbidden state, only
  proof that the edge is not entered. Assert
  `transform_caveman_deeper_tier_tied_on_length` for situation coverage instead.
- Do not pair `always(threshold_in_1_to_90)` with
  `sometimes(threshold_out_of_band)`. Assert
  `transform_effective_execute_threshold_arrived_outside_one_to_ninety`
  instead.

### One placement constraint on every marker in this part

Two durable writes precede the mutation region: `:3312` and `:4646`. A marker
placed after either has already been preceded by a committed transaction, so any
marker whose meaning is "nothing durable has happened yet" must sit **above**
`:3312`. Symmetrically, a marker placed after `:4652` sees an already-adopted
revert epoch, so epoch-sensitive markers must record which side of `:4652` they
are on. Place markers at the point where the precondition becomes true, not
after the code has finished depending on it.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability. Records-per-capability would put crafted
arrays at the top, and that is the wrong answer here: the two cheapest
capabilities in this part unblock **zero** new records between them and protect
or create coverage for all 24.

**State this plainly: the cheapest capabilities here are not faults.** They are
running the tests that already exist, and running one input through two
implementations that already exist. Both are wiring. Neither needs new
infrastructure, a new dependency, a subprocess harness, or a new seam.

1. **T0, running the existing 263 in-crate tests in CI.** A workflow change and
   nothing else: `cargo test -p mc-module --lib` alongside the existing
   `--test lifecycle_cli` step (`ci.yml:168` at `76cd6f41`, `:172` at `HEAD`),
   plus a first-ever `mc-store` test invocation, plus calling the
   `scripts/test-rust.sh` lane that already exists in `package.json` and that no
   workflow invokes. It unblocks **zero** new records and **protects 271
   existing test functions**: 226 in-scope tests in `transform.rs`, 18 in
   `injection.rs`, 7 in `compartment_coverage.rs`, 5 in `healing.rs`, 7 in
   `divergence.rs`, and the 6 store-side transform-commit tests at
   `mc-store/src/lib.rs:14207-18267`, plus the two real-transform integration
   tests in `direct_host.rs` (`:67`, `:149`), which are the only place a
   transform request crosses a process boundary anywhere in the repository.
   Nothing else on this list matters until this is done, because anything added
   below is added to a suite no automation executes.

2. **T7, running one input through both transform implementations.** The
   material exists on both sides and already runs on one. The TypeScript twin
   has 228 tests across 16 files that execute on every pull request through
   `bun run test` (`ci.yml:249` at `76cd6f41`, `:257` at `HEAD`); the Rust side
   has 210 whole-pass drivers funnelled through a single helper
   (`transform.rs:14331-14338`) that already normalises the response and already
   asserts two output invariants on it. Joining them is a harness step, not a
   new capability, and it buys a **differential oracle for free**. That matters
   more here than anywhere else in the catalog for two reasons. First, the three
   strongest determinism claims in the documentation
   (`CONFIGURATION.md:659`, `:716`, `:763`, all byte-identity or idempotency
   claims) have no Rust check of any kind, and a differential oracle covers
   claims nobody wrote a case for. Second, the three files that own m0 bytes, m1
   bytes and every retention estimate (`m0_compose.rs`, `m1_compose.rs`,
   `retained_size.rs`, 845 lines, zero tests) are exactly the code a byte
   comparison exercises without anyone authoring a unit test for them. Two
   things must be settled first, and both are decisions rather than work: who
   owns the harness, and which documented divergences become failures rather
   than recorded exceptions. Note the asymmetry with Part 4a: there, one side of
   the bridge already existed as a checked-in golden
   (`historian_validate.rs:1384`); here neither side has an oracle, so this is
   slightly more work than 4a's equivalent and buys more.

3. **T5, boundary values on one request field.** No fault, no seam, no store
   state, no second process, no new dependency: set
   `effective_execute_threshold` to `NaN`, to a negative, and to 95, and read
   what reaches `:4231`. It makes
   `sel-budget-execute-threshold-unvalidated-from-request` and
   `sel-budget-ceiling-clamp-diverges-from-scheduler-cap` non-vacuous outright
   and supplies the input domain for the two configuration-inertness records.
   It also has a contradiction already waiting, since `f64::clamp` returns `NaN`
   for a `NaN` input and `execute_threshold_or` (`lib.rs:1710-1712`) is a bare
   `unwrap_or`, so the sweep pays out immediately. Four further records
   (`exactly-one-core-step-executes-per-pass`,
   `sel-protected-tags-not-read-from-module-config`,
   `sel-per-model-and-token-thresholds-inert-in-module`, and the static half of
   the merged tag-hydration record) need **no** fault class at all and belong in
   the same first wave for the same reason.

4. **T1, the CAS-conflict hook that already exists.** `run_transform_attempt_hook`
   is installed (`:2303-2322`) and fired (`:5563-5564`) today, and existing
   tests already use it. Repurposing it costs nothing new and makes four records
   valid: `revert-epoch-bumps-at-most-once-per-logical-recut`,
   `defer-commit-carries-no-compartment-fence`,
   `recut-intent-survives-the-mandatory-cas-reload`, and
   `output-cache-replace-trails-the-accepted-commit`. It sits below item 3 only
   because it is a seam rather than a value. Two specific gaps it closes cheaply:
   `MAX_CAS_RETRIES = 8` has no dedicated test at all, and the truncate's no-op
   arm (`mc-store/src/lib.rs:9053-9059`), on which the whole revert-idempotency
   argument rests, has none either.

5. **T8, crafted CK ingress arrays.** More test-authoring work than items 1
   through 4, which is the only reason it sits here: the guards are all
   straight-line and the array is harness-supplied, so the seam is old and only
   the vectors are new. Five records depend on this and on nothing else, and
   they are the highest-impact five in the sub-part, because they are the ones
   that observe the two out-of-fence writes producing durable effects a rejected
   pass leaves behind.

6. **T9, clock and lease values.** Also just field values, and it sits below
   T8 only because fewer records need it. It makes both liveness records valid
   without a wall-clock wait, which is the capability Part 4a lacked entirely.

7. **T4, two processes on one store.** Two records need it, and it is the pivot
   the task names: the selection-purity records are only non-vacuous in their
   interesting form when two processes genuinely disagree, because the
   single-process simulation sets the divergent input by hand rather than
   observing it arise. The cheap half is available now; the honest half needs a
   second module process, and `direct_host.rs` already proves the fixture host
   can be driven over a process boundary, so this is wiring plus a shared store
   path rather than new infrastructure. **Before spending that wiring, settle
   bias 1.** `McStore::open` (`mc-store:4816-4818`) goes through `open_sqlite`,
   which acquires a single-writer file lease *before* opening the database and
   returns `StoreError::Lease` to a second live writer
   (`../commons/crates/cortexkit-store/src/lib.rs:249-281`, and the doc comment
   there states the intent). If that lease holds for the deployments this part
   cares about, then two live module processes on one store is not a state the
   system permits, the honest half of T4 is unbuildable by design rather than
   unbuilt, and the residual property is the single-process restart case, which is
   already available. That would also reframe the purity record from a defect into
   possibly-deliberate restart conservatism. Do not build a two-process harness
   until a human answers it.

8. **T6, tag-table contention.** Two rows, which are the merge pair. The static
   half needs nothing and should ship with item 3. The contention half needs a
   writer under the `test-support` feature and, worse, needs a convergence
   argument nobody has: whether the `can_append` arm's
   `generation - self.generation == appended` condition monotonically progresses
   is unresolved, so a failing test would not distinguish a livelock from a slow
   convergence.

9. **T2, a fault seam between the out-of-fence writes and the commit.** Unblocks
   **zero** records beyond what T8's in-code errors already reach, which is why
   it is this low despite being the sub-part's most-cited structural gap. What
   it would buy is generality: today the atomicity obligation is demonstrated at
   two specific error sites and asserted nowhere else in a roughly 900-line
   window. Making it general needs either a hook in the engine or a subprocess
   kill harness with a named kill point.

10. **T3, a fault seam inside `commit_transform`.** Last, and it is the only
    item on this list that no record needs. That is the finding, not an excuse
    to skip it: the whole-or-nothing claim at `mc-store/src/lib.rs:7259` covers
    ten write groups and no property in this catalog tests it at the
    partial-commit level. Adding one would need a hook in a sibling repository
    that CI provisions as a metadata-only stub, so it is an ownership decision
    before it is an engineering task. This is the same wall Part 4a hit for the
    publish transaction (`../part-4a-historian/fault-map.md:255-265`).

**Records that need a product decision rather than a harness.** No amount of
test infrastructure resolves these, and each is a live open question from at
least one lens:

- Whether `MC_PREFIX_PROJECTION_DIFFERENTIAL` (`transform.rs:2340`) is meant to
  be settable in production. It makes two bare `assert_eq!` (`:2349-2353`,
  `:2354-2357`) live in a release build, and no `docs/` file mentions it. If it
  is a developer switch the gate should say so; if it is an operational canary
  the panic is the contract and should be documented.
- Whether the caveman `assert!` at `:6366-6369` should be a panic at all, given
  the documentation describes caveman with no failure mode
  (`CONFIGURATION.md:720-744`) and the code's own comment at `:6366-6368`
  explains the tie behaviour without addressing the growth case.
- Whether any host can reach `apply_additive_only` (`:2711-3219`) with its
  production `unreachable!` at `:3068`, given the shipped OpenCode plugin
  downgrades `transform_mode` to `ts` when compaction is off. That decides
  whether the branch needs a record at all. Needs the 4c and 4d route-binding
  result.
- Whether `protected_tags` is host-owned or module-config-owned.
  `CONFIGURATION.md:165` documents it as a module key with a default of 20 and a
  range of 1 to 100, which argues the module should read it; `config.rs` has no
  such field.
- Whether the documented `execute_threshold_tokens` map and object-valued
  `execute_threshold_percentage` are TypeScript-leg-only features, and if so
  whether `CONFIGURATION.md` should annotate keys by leg. The same question 4a
  reached about `historian.two_pass`.
- Whether the `#[cfg(test)]` drift check at `:5451-5479` should ship in a
  sampled form, since it is the strongest check in the engine and is compiled
  out while its weaker twin ships behind an undocumented environment variable.
- Which 4b scope definition governs. If `scheduler.rs` and the `mc-store`
  transform commit are in scope rather than adjacent, the in-crate total rises
  from 263 to 279 and `scheduler.rs`'s 16 tests join the T0 protection count.
- Whether a never-executed test counts as `Exercised: partial`. It governs every
  `Existing check:` line in this part, all three lenses raise it, and it is
  unresolved.
