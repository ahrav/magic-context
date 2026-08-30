# Part 4b property catalog: the transform pass engine and its cache-state transition

Scope: the transform pass engine and the cache-state transition it drives, eight
units totalling 10,124 lines. `src/transform.rs:1-7510` (7,510) holds the contract
types, the untrusted `Deserialize`, the entry points, `apply_additive_only`,
`apply_once`, block identity, coverage and boundary resolution, the caveman and
reduction units, the pending pass-through arms, and the synthetic-todo handling.
The seven smaller units are `src/injection.rs` (911),
`src/compartment_coverage.rs` (413), `src/m0_compose.rs` (403),
`src/healing.rs` (267), `src/m1_compose.rs` (230), `src/retained_size.rs` (212),
and `src/divergence.rs` (178).

Two surfaces outside that scope definition are cited throughout rather than
paraphrased, because the part cannot be described without them:
`src/scheduler.rs`, which owns the pass-band decision the engine consumes, and
the store-side transform commit in `crates/mc-store/src/lib.rs`, which is where
the commit point actually lives. The scope map places `scheduler.rs` in 4f and
does not assign `mc-store` to Part 4 at all; all three lens agents took the same
posture of treating them as cited adjacent surfaces, and the discrepancy is
recorded rather than resolved. Two further out-of-scope surfaces are load-bearing:
`crates/mc-module/src/lib.rs:8322`, the only production caller, and
`transform.rs:7511-8046`, the tag baseline cache and the speculative mint
numbering, which is 4e's territory but which the commit predicate depends on.

The cache-state machine itself is **not in this repository**. `Cargo.toml:15`
points `cortexkit-cache-core` at `../commons/crates/cortexkit-cache-core`, a
separate checkout at commit `d2208eda`, and the fenced-transaction wrapper that
defines this part's commit boundary is `../commons/crates/cortexkit-store/src/lib.rs:185-231`.
The transition rules mapped below, and the guard at cache-core `:227` whose own
comment says it is "enforced in the core, not assumed", can change with no diff in
this repository and no CI signal here. Part 3 recorded that as its bias 1 and it
is unresolved; treat every `cortexkit-*:NNN` citation as needing re-verification at
the start of any follow-up pass.

Provenance in [../README.md](../README.md). System
`/local/home/ahrav/scratch/magic-context`. The two record-proposing lenses read
and verified their line references at `76cd6f41` ("refactor(shm): simplify
fixed-ring ownership"). The claims-and-checks lens read at `b5dc778e` ("fix(shm):
close lifecycle and evidence gaps"), one commit later, and verified that
`git diff --stat 76cd6f41 b5dc778e` touches no file under `crates/mc-module` or
`crates/mc-store`; `.github/workflows/ci.yml` does differ by `+10` lines, so CI
references are given at `76cd6f41`. The portfolio evaluation ran at `e447c927`
("refactor(shm): trim final review leftovers") and confirmed `crates/mc-module`
and `crates/mc-store` are byte-identical across that whole span, so every Rust
line reference below resolves at all three commits.

**Reconstruction note.** This file was rebuilt from the three lens files in
`_lenses/` after the working tree was cleaned while it was untracked. Every
record's text is taken verbatim from the lens that proposed it, with formatting
normalised to match the Part 1 and Part 4a catalogs and with the refinements the
surviving `portfolio-evaluation.md` records as applied. It is not a fresh
discovery pass: no claim below was re-derived or re-verified against source during
the reconstruction, because the lens agents already verified their references at
the commits named above. All ten refinements the evaluation records were applied:
R1 (the atomicity framing corrected from "unfalsifiable" to "unfalsifiable in
general, observable at two specific error sites", and the baseline record narrowed
to the one out-of-fence write it can measure), R2 and R9 together (the overlapping
loop pair split, with `sel-cas-retry-budget-bounded-tag-hydration-unbounded`
retyped to bounded liveness and renamed
`sel-tag-hydration-terminates-once-tag-mutation-stops`), R3 (a liveness workload
that reset its own wait, corrected), R4 (a non-finite threshold demoted to a
`test-only` sub-case on parser evidence), R6 (the caveman record retyped to
`reachability` with `unreachable` panic-edge semantics), R7 (a backwards scheduler
claim corrected in two records), R8 (a guarantee narrowed to match its oracle),
and R10 (eight groups collapsed to four, the relationship map trimmed from ten
clusters to three, and file order aligned with index order). R5 corrected a false
inventory line in `existing-checks.md` and changes no record here. The record
count is unchanged at 24.

## What this part is about

This is the crate's reason to exist, and the place where one wrong decision either
corrupts the served context or wedges the durable cache state for every subsequent
pass. A pass is one call to `apply_once` (`transform.rs:3222-5697`), a single
linear 2,476-line body with no inner functions, taking the harness's CK array plus
per-pass scalars, a resolved config plus `now_ms`, the durable session row, and two
optional in-process caches, and returning the rewritten array. Five facts frame
every record below.

**The commit point is a single fenced transaction, but a pass is up to three
transactions.** The terminal commit is `store.commit_transform` at
`transform.rs:5565`, guarded by `commit_required` at `:5559-5561` and carrying
`expected: commit_expected` at `:5569`. It is one fenced SQLite transaction
(`mc-store/src/lib.rs:7260`, wrapper at `cortexkit-store:185`, which takes the
process-wide connection mutex at `:189` and runs an IMMEDIATE transaction), and
inside it ten write groups land or none do: `mc_cache_state`
(`mc-store:7388-7400`), `mc_pass_trace` (`:7402-7468`),
`mc_transform_session_roots` (`:7470-7481`), new `mc_tags` rows (`:7483-7515`),
`mc_temporal_marks` (`:7527-7541`), `mc_user_hints` (`:7542-7558`),
`mc_channel1_appends` (`:7559-7571`), `mc_overlay_frontiers` (`:7572-7580`),
`mc_reduce_command_ledger` first-applied stamps (`:7582-7591`), and
`pending_agent_drops` deletions (`:7592-7597`). The pure region opens at
`let mut core = loaded.core.clone()` (`:4369`) and `let mut meta = loaded.meta.clone()`
(`:4371`), and the code states the contract itself at `:3505-3507`: "Decisions from
this request stay in memory until the final cache-state compare-and-swap accepts
the pass."

**Two durable writes break that contract, and neither is rolled back.**
`store.descend_lineage` (`:3312`) commits its own fenced transaction on a
lineage-switch pass, copying compartments, chunk transcripts, tags, temporal marks
and user hints into the target session key and bumping that key's `row_version`.
`store.truncate_compartments_for_revert` (`:4646`) commits its own fenced
transaction on the reconcile-rematerialize arm, deleting compartments past the
surviving prefix, bumping `meta.revert_epoch`, and bumping `row_version`; the
engine then re-points its own CAS expectation at the new version (`:4651`) and
adopts the new epoch (`:4652`). Both are decisions from this request that become
durable before the CAS, and `transform.rs:1796-1798` claims the opposite, that
every `TransformError` leaves durable state alone so "the CAS simply does not
advance". Read narrowly as a claim about `core.frozen_units` that is true; read as
written it is false for both paths. Three other commits exist in the engine and
each is an early `return`, so at most one of them and the terminal one can run per
pass: `:3609` and `:3720` (the two `pending_rewrite` pass-through arms) and `:3113`
(the additive-only engine).

**Work per firing is bounded at nine `apply_once` invocations, with one uncounted
loop.** The retry wrapper `apply_once_with_estimator_and_projection`
(`:2261-2301`) is a `loop` that re-enters `apply_once` on
`TransformError::Store(McStoreError::CasConflict)` only, while
`attempt < MAX_CAS_RETRIES` (`:2284`, `MAX_CAS_RETRIES = 8` at `:82`); every other
error returns immediately (`:2298`), each invocation re-reads all state from
scratch, and the only value carried across the reload is
`boundary_divergence_retry`, accumulated with `|=` at `:2289`. Four other budgets
sit beside it and all four degrade gracefully rather than failing: the selection
ceiling (`:4230-4232`), the pass bands in `scheduler.rs:716-757`, the
three-pass divergence-suppression limit (`:85`, `:3925-3947`), and the
five-minute cache idle TTL (`scheduler.rs:23`, `:810-812`). One budget is missing:
`load_cached_tags` (`:7644`, called from the engine at `:3391`) is an unbounded
`loop` whose two exits are optimistic revalidations, and nothing counts its
attempts. Its body is 4e's scope; the unbounded call from the engine is 4b's.

**Selection is deterministic on collection order and is not pure.** Every ordered
artifact in the slice comes from a `BTreeMap`, a `BTreeSet`, or an explicit
`sort_by` with a total tiebreak, and every `HashMap` or `HashSet` in the slice is a
membership or lookup structure whose iteration order never reaches an output
ordering; the one queue order that does reach selection comes from
`ORDER BY p.queued_at ASC, p.id ASC` (`mc-store:6233`). But the decision is a
function of `(request, store row, ProducerContext)`, and `ProducerContext` carries
process-local mutable state that is in neither the request nor the store:
`observed_last_response_at_ms` (`lib.rs:4460-4483`, which returns `None` until this
process has seen a response for that session), `historian_active` and
`wrapup_active` (process-local leases, `lib.rs:8311-8312`), and `now_ms`. Two
processes sharing one store can therefore select different pass classes for
byte-identical inputs. Whether that state is reachable is itself in question: the
portfolio evaluation's bias 1 records that `open_sqlite` acquires a single-writer
file lease before opening and returns `StoreError::Lease` to a second live writer
(`cortexkit-store:249-281`), which if it holds for the deployments this part cares
about leaves only the single-process restart case.

**Coverage: 263 in-crate tests, 6 store-side, zero in CI, and a TypeScript suite
that runs every pull request and executes no Rust.** The in-crate figure is 226
in-scope `transform.rs` tests plus 18 in `injection.rs`, 7 in
`compartment_coverage.rs`, 5 in `healing.rs`, and 7 in `divergence.rs`; three scope
files have no tests at all (`m0_compose.rs` 403 lines, `m1_compose.rs` 230,
`retained_size.rs` 212). The six store-side transform-commit tests are
`mc-store/src/lib.rs:14207`, `:14282`, `:14425`, `:14479`, `:14562`, and `:18267`.
Two real-transform integration tests bring the total to 271, and **none of the 271
executes in CI**: the only `mc-module` binary CI runs is `lifecycle_cli`, which
contains zero mentions of `transform`, and `mc-store` is named in no workflow.
Beside that,
`packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts` runs on every
pull request with 70 tests, and it tests the TypeScript **caller**: the module
transport is a hand-written stub returning canned objects
(`:851-859`), and the assertions are about the request the TypeScript side builds,
the method sequence, the acked sequence and watermarks, and that the stubbed output
reaches `output.messages`. A search of `packages/plugin/src/**/*.test.ts` for
`ck-mc-host`, `mc-module`, a rust `transform_mode` spawn, or `rustTransform` returns
zero matches, and there is no `spawn`, `child_process`, or napi call in that file.
So the suite named after this Rust code runs no Rust code. Separately, a large
executing suite covers a **parallel TypeScript transform implementation** of the
same contract, and nothing compares the two. Every `Existing check:` line below is
therefore a local-only check, and "partial" in an `Exercised:` line means "a test
exists on a developer's machine". The portfolio evaluation's bias 2 says this
observation now appears in three artifacts without becoming a property, and needs
either a commissioned differential property or demotion to one line, as a
cross-part call rather than a paragraph each part writes again.

**A production panic path exists, and three of its four sites are live in a release
build.** `transform.rs:6366-6369` is a bare `assert!`, not `debug_assert!`, on
`compressed.len() <= existing.frozen_payload.len()` with the message "caveman
deeper tier grew frozen payload for {block_id}", so it is enabled in release
regardless of the profile's `debug-assertions` setting; it is the subject of
`sel-caveman-deeper-tier-growth-panics-in-production`. Two `assert_eq!` inside
`assert_prefix_projection_equivalent` (`:2349-2353` "incremental prefix projection
byte drift" and `:2354-2357` "incremental prefix projection state drift") sit behind
`prefix_projection_differential_enabled` (`:2337-2342`), which is
`cfg!(test) || MC_PREFIX_PROJECTION_DIFFERENTIAL == "1"`, so both are live in a
release build under an environment variable that no `docs/` file mentions; they have
named tests but no property, which the evaluation queued as its gap G2. And
`transform.rs:3068` is `PassPlan::Reject(_) => unreachable!("reject returned before
composition")` inside `apply_additive_only`'s composition match, forbidden by
construction because the same function returns
`Err(TransformError::UnknownShape(message))` for `PassPlan::Reject` roughly 180
lines earlier at `:2889-2891`; it has no record and is the evaluation's gap G1. This
matters for how the part is read: a subsystem whose invariants otherwise live in
guard clusters returning `Result` needs reachability records for the few places that
panic instead, and only one of the three release-live panics has one.

### The legal transitions, and what the engine does outside them

Durable state is two JSON blobs in one row plus `row_version`. Exactly three
transitions exist, all in the out-of-repo core (`cache-core:154-165`): `SoftPlus`
(defer) queues `pending_changes` and sets
`reconcile_pending = !boundary_match && !boundary_id.is_empty()` (`:197`) without
bumping `version`; `Soft` requires `boundary_match && !reconcile_pending` to advance
`boundary_id` (`:227`), freezes rendered units, and bumps `version` (`:232`); `Hard`
drains all `pending_changes` into this bust, mints `boundary_id`, clears
`reconcile_pending` (`:250`), and bumps `version`. Note that defer both **sets and
clears** the latch at `:197`, so a defer that finds the boundary again clears it with
no rematerialize, which the core acknowledges in prose at `:221-222` while
`:214-215` says `reconcile_pending` "is cleared only by a HARD rematerialize, never a
SOFT"; a reader who takes `:214-215` as the general rule will mis-model the machine.

The engine reaches exactly one `core.step` per pass, from five mutually exclusive
call sites (`:4541` subagent, `:4794` Hard/MigrateHard, `:5002` and `:5098` the two
Soft arms, `:5151` Defer), and the compiler helps because `boundary_token: String`
(`:3540-3544`) is *moved* into whichever `PassInput` runs. But an illegal transition
is representable: `CoreState`'s fields are all `pub`, and the engine writes three of
them directly outside `step` — `core.reconcile_pending = true` at `:4430` on
lineage-anchor validation failure, and `core.frozen_units.retain(..)` through
`prune_covered_red_units` (`:5117`) and `prune_covered_caveman_units` (`:5118`), both
called *after* the Soft step has already bumped `core.version`. Every `core.step`
call also discards its `StepResult`, so the `reconcile_pending` the machine reports is
never compared against what the engine believes.

## Index

| Slug | Type | Confidence |
| --- | --- | --- |
| [engine-terminal-cas-is-the-sole-core-meta-writer](#engine-terminal-cas-is-the-sole-core-meta-writer) | safety | high |
| [revert-truncate-commits-outside-the-terminal-cas](#revert-truncate-commits-outside-the-terminal-cas) | safety | high |
| [lineage-descent-write-precedes-the-array-validity-guards](#lineage-descent-write-precedes-the-array-validity-guards) | safety | high |
| [revert-epoch-bumps-at-most-once-per-logical-recut](#revert-epoch-bumps-at-most-once-per-logical-recut) | safety | medium |
| [defer-commit-carries-no-compartment-fence](#defer-commit-carries-no-compartment-fence) | safety | high |
| [speculative-tag-numbering-has-two-authorities](#speculative-tag-numbering-has-two-authorities) | safety | medium |
| [output-cache-replace-trails-the-accepted-commit](#output-cache-replace-trails-the-accepted-commit) | safety | high |
| [exactly-one-core-step-executes-per-pass](#exactly-one-core-step-executes-per-pass) | safety | high |
| [core-fields-mutated-outside-the-step-machine](#core-fields-mutated-outside-the-step-machine) | safety | high |
| [synthetic-strip-precedes-every-coverage-read](#synthetic-strip-precedes-every-coverage-read) | safety | high |
| [recut-intent-survives-the-mandatory-cas-reload](#recut-intent-survives-the-mandatory-cas-reload) | safety | high |
| [sel-pass-order-deterministic-under-fixed-inputs](#sel-pass-order-deterministic-under-fixed-inputs) | safety | high |
| [sel-eligibility-reads-process-local-scheduler-state](#sel-eligibility-reads-process-local-scheduler-state) | safety | high |
| [sel-caveman-eligibility-ladder-deterministic-over-frozen-basis](#sel-caveman-eligibility-ladder-deterministic-over-frozen-basis) | safety | high |
| [pass-firing-work-bounded-by-max-cas-retries](#pass-firing-work-bounded-by-max-cas-retries) | liveness | high |
| [sel-tag-hydration-terminates-once-tag-mutation-stops](#sel-tag-hydration-terminates-once-tag-mutation-stops) | liveness | high |
| [sel-queued-drop-drains-within-cache-ttl-window](#sel-queued-drop-drains-within-cache-ttl-window) | liveness | medium |
| [sel-divergence-repair-bounded-by-three-pending-passes](#sel-divergence-repair-bounded-by-three-pending-passes) | liveness | high |
| [sel-budget-execute-threshold-unvalidated-from-request](#sel-budget-execute-threshold-unvalidated-from-request) | safety | high |
| [sel-budget-ceiling-clamp-diverges-from-scheduler-cap](#sel-budget-ceiling-clamp-diverges-from-scheduler-cap) | safety | high |
| [sel-per-model-and-token-thresholds-inert-in-module](#sel-per-model-and-token-thresholds-inert-in-module) | safety | high |
| [sel-protected-tags-not-read-from-module-config](#sel-protected-tags-not-read-from-module-config) | safety | high |
| [sel-caveman-deeper-tier-growth-panics-in-production](#sel-caveman-deeper-tier-growth-panics-in-production) | reachability | medium |
| [sel-skip-unobservable-when-producer-gate-closed](#sel-skip-unobservable-when-producer-gate-closed) | safety | high |

---

## Group 1: transactionality

Seven records on the commit boundary and on everything that crosses it. The first is
the baseline obligation, that a failed pass leaves the row exactly as it was read,
and it is stated first because the next two are its exceptions: the revert truncate
and the lineage descent each commit their own transaction before the terminal CAS
and neither is rolled back. The remaining four are the boundary's other edges: the
epoch bump that must survive nine attempts idempotently, the one pass class that
commits without a compartment fence, the tag numbers that two independent
authorities assign, and the in-process cache that must trail the accepted commit
rather than lead it.

One framing correction belongs here rather than in a record, because it changes what
a test author does next. The obligation on the two out-of-fence paths is
**unfalsifiable in general and observable at two specific error sites**, not
unfalsifiable outright. Both writes have straight-line in-code error paths
downstream of them inside the same pass, so the split durable state can be
constructed today from a crafted request with no new seam: `descend_lineage`
(`:3312`) commits and then `DuplicateBlockId` (`:3355`), `ReservedId` (`:3362-3365`)
and `OrdinalViolation` (`:3367-3372`) can each reject the same pass, with nothing
conditional on a fault in between; and `truncate_compartments_for_revert` (`:4646`)
commits and the `CoverageGap` at `:4704` sits downstream of it. What genuinely lacks
a seam is an *arbitrary injected* failure or a process kill at a chosen point,
because the engine's one hook (`:2323-2333`) fires at `:5563-5564`, after both
writes.

### engine-terminal-cas-is-the-sole-core-meta-writer

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `obsolete_pending_row_commits_consumption_without_core_or_meta_changes`
(`transform.rs:24607`) pins the `commit_required` fan-in, and
`fired_divergence_with_absent_new_anchor_fails_loud_without_commit` (`:20909`) pins
one no-commit error path. Neither runs in CI.
Guarantee: On the compaction-enabled engine, a pass that returns `Err` leaves the
session's `row_version`, `core_state` and `meta` exactly as
`load_transform_snapshot` returned them.
Check: `always` — for every `apply_once` invocation returning `Err` **from an error
raised after `load_transform_snapshot` at `:3387`**, re-read the row and assert the
`(row_version, core_state, meta)` triple equals the triple captured at `:3387` for
that attempt. `always` because the obligation is evaluated on every failed pass, not
on an optional path.

The window restriction is a refinement, and it removes one of the two out-of-fence
writes from this record entirely. `descend_lineage` (`:3312`) and all three of its
guards execute *before* `load_transform_snapshot`, so on that arm the baseline triple
does not exist yet and there is nothing to compare against; the write also lands on a
**different** session key. So exactly one of the two out-of-fence writes, the revert
truncate at `:4646`, is an exception this record can measure, and it is measured by
`revert-truncate-commits-outside-the-terminal-cas`. The lineage write remains an
exception to the part's atomicity contract while being undetectable by re-reading
this triple, which is why
`lineage-descent-write-precedes-the-array-validity-guards` asserts against the target
key instead.
Fault/timing angle: The window is `:4369` (clone) to `:5565` (commit). Any error
raised inside it must not have mutated the row.
Required faults and enabling state: An error inside the mutation region.
`CoverageGap` (`:4593`, `:5065`, `:4703`), `BoundaryNotPresent` (`:5091`),
`IdentityDrift` (`:5786`), `ReductionConflict` (`:6820`), `FrozenRedTargetVanish`
(`:5814`) are all reachable from a crafted array.
Confidence: high —
[evidence](evidence/engine-terminal-cas-is-the-sole-core-meta-writer.md). Traced
every `store.` call in `:3222-5697` and confirmed only `:3312`, `:4646`, `:3609`,
`:3720`, `:5565` write.
Existing check: `transform.rs:20909` asserts one error path does not commit. No check
covers the general obligation.
Impact: A partial mutation that survives a rejected pass makes the next pass compute
against a state no pass ever accepted, which is the wedged-cache failure the module
doc's poison-resistance invariants exist to prevent.
Open questions:

- Should `apply_additive_only` be held to the same obligation as a separate record,
  given it is `explicit-config-only`? (needs human input)

### revert-truncate-commits-outside-the-terminal-cas

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `reconcile_rematerialize_with_unrecut_store_truncates_and_refolds_prefix`
(`transform.rs:19870`) drives the truncate on a success path only.
`crash_reentry_after_recut_uses_coverage_shrink_for_todo_reanchor` (`:21806`) covers
re-entry after a *committed* recut, not after a failed one. Neither runs in CI.
Guarantee: The reconcile-rematerialize truncate and the pass that ordered it either
both take effect or neither does.
Check: `always(!X)` where X is "compartments deleted and `revert_epoch` bumped while
`core.boundary_id` and `meta.coverage_ordinal` still name the pre-truncate coverage".
`always(!X)` and not `unreachable`, because this is a forbidden durable **state** with
no dedicated detection point in the code.
Fault/timing angle: The window is `:4650` (truncate returns) to `:5565` (commit).
Roughly 900 lines of rendering sit inside it, including `compose_m0_for_context`
(`:4676`), the CoverageGap guard at `:4703`, `build_output_with_tags` (`:5390`+) and
the two output integrity guards. A process kill or any error in that span leaves the
split state.
Required faults and enabling state: `loaded.core.reconcile_pending == true` plus a
minted anchor that is not available in the live array (`:4636-4645`), which is the
post-revert shape. Then either a `CoverageGap` at `:4703`, an error from
`compose_m0_for_context`, or a process kill. Coverage-check form: assert the
independent preconditions — `reconcile_pending` observed true on entry, the truncate
observed to return `dropped_count > 0`, and the pass observed to reach `:5565` —
rather than the split state itself.
Confidence: high —
[evidence](evidence/revert-truncate-commits-outside-the-terminal-cas.md). Confirmed
`truncate_compartments_for_revert` is its own fenced transaction that bumps
`row_version` and writes `meta`.
Existing check: `transform.rs:19870` and `:21806` cover the committed path.
Impact: `meta.coverage_ordinal` claims coverage through an ordinal whose compartments
no longer exist. The next pass's `first_uncovered_live_block` guard (`:4699`) or
`resolve_boundary_state` must repair it; if the repair path itself needs the deleted
compartments the session cannot fold.
Open questions:

- Is the next pass guaranteed to re-enter the same reconcile arm, given
  `reconcile_pending` was never cleared? The reasoning says yes, but no test
  constructs it.

### lineage-descent-write-precedes-the-array-validity-guards

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test drives a malformed array through a lineage-switch pass
and then asserts the target key is untouched.
Guarantee: A `TransformError` raised by the array-validity guards leaves no durable
lineage-descent effect on the target session key.
Check: `always-or-unreached` — on a pass with `lineage_switched && !is_subagent`
whose array fails `DuplicateBlockId`, `ReservedId` or `OrdinalViolation`, assert the
target key's `row_version`, compartment count and tag count are unchanged.
`always-or-unreached` because a lineage switch is optional per pass but the obligation
is absolute when one occurs.
Fault/timing angle: The window is `:3312` (descend_lineage commits) to `:3371` (last
validity guard). 59 lines, no fault injection needed: the guards are downstream of the
write in straight-line code.
Required faults and enabling state: A lineage-switch request (`lineage_switched: true`,
`is_subagent: false`, well-formed `descent_edge_id`, `prior_conversation_key`,
`constituents`) whose CK array also contains a duplicate flat block id, a live block
whose id starts with `mc_`, or non-increasing non-synthetic ordinals. The plugin sets
`lineage_switched` from `passInputs`
(`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1404`), and the array
is harness-supplied, so both halves are production-reachable.
Confidence: high —
[evidence](evidence/lineage-descent-write-precedes-the-array-validity-guards.md). Read
the straight-line order and confirmed `descend_lineage` commits its own fenced
transaction.
Existing check: none.
Impact: Compartments, chunk transcripts and tags are copied into the target key and its
`row_version` advanced, while the caller receives a hard error and the host serves the
raw array. The copy is not idempotent-by-construction across a later retry with a valid
array; it is protected only by `descend_lineage`'s own disposition logic.
Open questions:

- Does `descend_lineage` treat a repeat of the same `edge_id` as a no-op, so a retry
  after fixing the array is safe? Unresolved, needs a read of
  `mc-store/src/lib.rs:8177-8500` at the disposition level, which is 4c/4a territory.

### revert-epoch-bumps-at-most-once-per-logical-recut

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test forces a CAS conflict after the truncate and then counts
epoch bumps.
Guarantee: One transform firing advances `meta.revert_epoch` by at most one, even when
it performs up to nine `apply_once` attempts each of which re-enters the truncate arm.
Check: `always` — across one call to `transform_with_projection_cached`, assert
`revert_epoch_after - revert_epoch_before <= 1`. `always` because the bound must hold on
every firing, and idempotence is the property, not the mere absence of a crash.
Fault/timing angle: The retry loop at `:2274-2299` re-runs `apply_once` from scratch.
Attempt 2 re-reads the already-truncated compartments at `:4643`, recomputes
`surviving_revert_prefix_seq` (`:7275-7284`) over that shorter list, and calls the
truncate again. Idempotence rests entirely on `dropped_count == 0`
(`mc-store/src/lib.rs:9053`) returning the current epoch. That in turn rests on the
recomputed `keep_through_seq` being no smaller than the surviving max sequence.
Required faults and enabling state: The reconcile-rematerialize arm plus a
`CasConflict` on the terminal commit, which the `#[cfg(test)]` hook at `:5563-5564`
(`run_transform_attempt_hook`) exists to inject.
Confidence: medium —
[evidence](evidence/revert-epoch-bumps-at-most-once-per-logical-recut.md). The no-op arm
is verified. Whether `surviving_revert_prefix_seq` is a fixpoint after truncation is
argued, not proven: it is a `take_while` over compartments whose `end_message_id` is
live, and truncation removes a suffix, so the prefix length can only stay or grow. Not
tested.
Existing check: none.
Impact: `revert_epoch` keys the serialized-output cache (`:5381`, `:421-427`). Extra
bumps evict the cache repeatedly and, more seriously, an epoch that advances without an
accepted pass makes the epoch a poor generation witness for anything downstream that
compares it.
Open questions:

- Can a retry's `keep_through_seq` ever be *smaller* than the previous attempt's,
  causing a second real truncation? That needs the `live` set to be identical across
  attempts, which it is within one firing, so the answer is probably no. Unresolved,
  needs a constructed test.

### defer-commit-carries-no-compartment-fence

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `claim_vector_commit_fence_never_publishes_interleaved_stale_bytes`
(`transform.rs:14185`) covers the claim-vector predicate; nothing covers the compartment
predicate's absence on Defer.
Guarantee: A committing Defer pass does not persist a compartment watermark that a
concurrent publish has already invalidated.
Check: `always` — whenever a Defer commit writes `meta.coverage_compartment_seq`, assert
the value equals `MAX(sequence)` of `mc_compartments` for that session as observed inside
the commit transaction. `always` because a stale watermark is wrong every time it is
written, not only under a specific interleaving.
Fault/timing angle: `compartment_max_seq` is passed only when `is_bust_pass` (`:5574`),
and `is_bust_pass` excludes Defer (`:4439`, `:4435-4438`). So the store's compartment
check (`mc-store/src/lib.rs:7378-7387`) is skipped, while `:5155-5157` writes the
watermark from a read taken outside any predicate. A historian publish landing in that
window is not detected.
Required faults and enabling state: A Defer pass with
`compartment_seq_changed_since_meta` true and
`current_m1_digest == loaded.meta.m1_revision` (`:5155-5156`), plus a compartment append
committing between the m1 revision read and `:5565`. The `row_version` CAS does not help:
`append_compartments` (`mc-store/src/lib.rs:9169`) does not touch `mc_cache_state`.
Confidence: high — [evidence](evidence/defer-commit-carries-no-compartment-fence.md).
Verified `is_bust_pass` excludes Defer, verified `append_compartments` writes no
`row_version`.
Existing check: none.
Impact: `coverage_compartment_seq` is the watermark `compartment_revision_matches`
(`:3913-3918`) and `compartment_seq_changed_since_meta` (`:3951`) read to decide whether
new compartments need folding. A stale value recorded by a Defer can suppress the next
SOFT that would have folded them.
Open questions:

- Does any other writer append compartments concurrently with a live transform for the
  same session, or does the historian's publication fence serialize them? Unresolved,
  needs the 4a publish-fence result.

### speculative-tag-numbering-has-two-authorities

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `first_active_render_commits_tagged_bytes_before_replay`
(`transform.rs:22514`) and its subagent twin (`:22588`) prove tags commit with the bytes.
Neither compares the rendered number to the durable number.
Guarantee: The tag number rendered into the served bytes on the pass that mints it equals
the tag number the commit transaction assigns.
Check: `always` — for every accepted pass with `tag_mint_count > 0`, assert each rendered
`§N§` prefix's N equals the `tag_number` of the corresponding `mc_tags` row after the
commit. `always` because a mismatch corrupts the served prefix on the very pass that froze
it.
Fault/timing angle: The engine assigns numbers in memory at `:8029` as
`max(loaded tag_number) + offset + 1`. The store assigns them at
`mc-store/src/lib.rs:7496-7500` as `MAX(tag_number) + 1` read fresh per row, and **skips**
any input whose `block_id` already exists (`:7488-7495`). One skipped input desynchronises
every later number in the batch. The `row_version` CAS covers a concurrent transform or
`descend_lineage`, so the reachable trigger is a duplicate `block_id` inside one batch, or
a batch whose `existing_tag_ids` filter (`:8611`) is computed from a stale baseline-cache
read.
Required faults and enabling state: `tagging_active` (`:3503-3504`, requires
`ClaudeCodeAnthropic` or `OpencodeAiSdk` plus `tool_present`) and a mint batch containing a
`block_id` already present in `mc_tags`. Coverage-check form: assert the preconditions — a
non-empty mint batch committed, and at least one batch observed where the store's `exists`
branch was taken — rather than the mismatch.
Confidence: medium —
[evidence](evidence/speculative-tag-numbering-has-two-authorities.md). Both numbering sites
read and verified. Whether the `existing_tag_ids` filter can ever admit a duplicate is not
established; `compute_active_overlay_decisions` (`:8574-8761`) is 4e's scope.
Existing check: `transform.rs:22514`, `:22588`.
Impact: A rendered tag prefix that names a number the store gave to a different block
breaks the tag-to-block mapping the reduction and nudge surfaces key on, and it does so in
bytes already frozen into the provider prefix.
Open questions:

- Can `compute_active_overlay_decisions` emit a `block_id` that already has a tag?
  Unresolved, needs 4e.

### output-cache-replace-trails-the-accepted-commit

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `serialized_output_cache_revert_epoch_bump_evicts_session`
(`transform.rs:28884`) covers the epoch eviction. Nothing asserts the ordering against the
commit.
Guarantee: The in-process serialized-output cache never holds entries produced by a pass
the store rejected, and never serves entries from a superseded revert epoch.
Check: `always` — assert `SerializedOutputCache::replace` is reached only on a path where
`commit_transform` either succeeded or was not required, and that every `snapshot` call
passes the same `revert_epoch` the pass will commit. `always` because a stale cache hit
produces wrong served bytes on every subsequent pass that hits it.
Fault/timing angle: `replace` is at `:5604-5613`, after the commit at `:5565` and after the
`?` that propagates a `CasConflict`. `snapshot` is at `:5381` and is keyed on
`meta.revert_epoch`, which by then already reflects a mid-pass truncate (`:4652`), so a
post-revert render cannot reuse pre-revert entries. `snapshot` evicts on mismatch at
`:421-427`.
Required faults and enabling state: A CAS conflict on the terminal commit with a non-empty
`output_cache_entries`, plus separately a reconcile-rematerialize pass that bumps the epoch
mid-pass and then renders.
Confidence: high —
[evidence](evidence/output-cache-replace-trails-the-accepted-commit.md). Read `snapshot`
(`:421-437`) and `replace` (`:441-471`) and confirmed the call ordering.
Existing check: `transform.rs:28884`; also the `#[cfg(test)]` drift assertion at
`:5551-5577`-region (`"serialized output cache drift"`, `:5479`) which re-renders without the
cache and compares canonical bytes.
Impact: A cache holding rejected-pass entries would serve bytes no accepted pass ever
produced, which is indistinguishable downstream from a byte-stability violation and would
bust the provider prefix.
Open questions:

- `replace` silently drops the whole entry set when it exceeds `max_retained_bytes`
  (`:445-447`). Is a session whose output always exceeds the budget permanently uncached, and
  does anything observe that? Suggest one record in 4c's cache-validity focus rather than
  here.

## Group 2: transition integrity

Seven records on whether the transition and the inputs that chose it agree. The first four
are the step machine itself: that exactly one transition runs per pass, that the fields the
machine owns are only changed the way its rules permit, that the synthetic strip really
precedes every read the transition depends on, and that a divergence proven on one attempt
survives the mandatory reload. The last three are the inputs: selection is deterministic on
collection order, it is not pure because it reads process-local state, and the caveman
eligibility ladder must be frozen against a basis this pass's own commit records. The
grouping is deliberate: a correct transition over inputs that differ between two evaluations
produces the same failure as an incorrect transition over identical inputs.

### exactly-one-core-step-executes-per-pass

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the arm structure is exercised incidentally by all 280 inline transform
tests; nothing asserts the count.
Guarantee: One `apply_once` invocation applies at most one cache-core transition.
Check: `always` — instrument `CoreState::step` with a per-pass counter and assert it never
exceeds one per `apply_once`. `always` because a second transition on one pass would
double-bump `version` and double-drain `pending_changes`, and that must never happen.
Fault/timing angle: none. This is structural.
Required faults and enabling state: None. The property is worth recording because it is
enforced only by control-flow shape plus the move of `boundary_token` (`:3540-3544`) into
whichever `PassInput` is built. A future refactor that clones the token instead of moving it
silently removes the compiler's help.
Confidence: high — [evidence](evidence/exactly-one-core-step-executes-per-pass.md).
Enumerated all five call sites (`:4541`, `:4794`, `:5002`, `:5098`, `:5151`) and confirmed
mutual exclusion.
Existing check: none as an explicit assertion.
Impact: A second `Hard` step on one pass drains `pending_changes` twice and re-applies units;
`apply_units` replaces by key (cache-core `:261-270`) so the bytes may survive, but `version`
and the drain accounting would not.
Open questions: None.

### core-fields-mutated-outside-the-step-machine

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `reverted_orphan_reduction_gcd_on_surviving_prefix_reconcile_hard`
(`transform.rs:25052`) covers the orphan GC that the prunes complement. No test asserts the
frozen set only changes through documented mechanisms.
Guarantee: Every durable change to `core.frozen_units` and `core.reconcile_pending` is one
the cache-state machine's documented rules permit.
Check: `always` — for each committed pass, assert the committed `core` is reproducible by
replaying the pass's declared action plus the declared coverage-prune rule from
`loaded.core`. `always` because the machine's invariants are what the byte-stability contract
rests on.
Fault/timing angle: The relevant ordering is that `prune_covered_red_units` (`:5117`) and
`prune_covered_caveman_units` (`:5118`) run **after** `step_soft` has bumped `core.version`
(cache-core `:232`), so the committed `version` does not identify the committed frozen set.
Required faults and enabling state: A coverage-extending SOFT (`m1.new_coverage.is_some()`,
`:5107`) with at least one frozen `red:` or `cav:` unit whose target the advance folds below
coverage. Also, separately, a lineage-anchor validation failure (`validate_lineage_anchor` at
`:2484-2547`, failure handled at `:4429-4433`) which sets `reconcile_pending` directly.
Confidence: high — [evidence](evidence/core-fields-mutated-outside-the-step-machine.md). Read
both prune bodies and confirmed they `retain` on `core.frozen_units`; confirmed `:4430`
assigns the field; confirmed all five `step` calls discard `StepResult`.
Existing check: `transform.rs:25052` for the HARD-fold orphan GC.
Impact: The out-of-repo core enforces its guards (cache-core `:227`) precisely because it is
"a shared cache-stability primitive, so the guard is enforced in the core, not assumed".
Direct field writes route around that reasoning, and the discarded `StepResult` means the
engine never cross-checks the machine's own verdict.
Open questions:

- Is the discarded `StepResult.reconcile_pending` ever different from what the engine
  assumes? A cheap assertion would answer it. (needs human input on whether to propose a
  guard)

### synthetic-strip-precedes-every-coverage-read

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `pending_rewrite_passes_isolate_ingress_meta_usage_and_reconcile`
(`transform.rs:20079`) and the injection module's bust-only freeze tests cover parts. No test
asserts the ordering itself.
Guarantee: No boundary, coverage, selection or tail computation in `apply_once` observes a
synthetic block, and no live block can carry a reserved `mc_` id.
Check: `always` — assert that every collection reaching `resolve_boundary_state`,
`resolve_coverage`, the selection input and the output splice is derived from `live`
(`:3358-3361`), and that `live` contains no block with `synthetic()` true or an
`mc_`-prefixed id. `always` because the module header states it as an unconditional invariant
(`:12-15`).
Fault/timing angle: The mechanism is a shadow, not a copy: `normalize_synthetic_todo_ingress`
(`:3243`, body `:2405-2422`) marks flags on a clone, and
`let req = rebased_req.as_ref().unwrap_or(ingress_req)` at `:3342` rebinds `req` so every
later `req.messages` read (for example the ordinal check at `:3368`, the continuation-base
first-live check at `:3441-3446`, and `mutation_exempt_mid` at `:3378`) sees the normalized
flags. If a future edit moves a read above `:3342`, the invariant silently breaks for that
read with no error.
Required faults and enabling state: An OpenCode array carrying a replayed synthetic todo pair
whose CK metadata lacks the `synthetic` marker, so recognition must come from the reserved
call-id namespace (`is_synthetic_todo_id`, `injection.rs`). Plus, for the backstop, a harness
block whose flat id starts with `mc_`.
Confidence: high — [evidence](evidence/synthetic-strip-precedes-every-coverage-read.md).
Enumerated every `ingress_req` use (`:3244`-`:3342`) and every `req.messages` use after
`:3342`, confirming the shadow covers all of them at `HEAD`.
Existing check: `transform.rs:20079`; the `RESERVED_ID_PREFIX` guard at `:3363-3365` is itself
a production check.
Impact: This is the PRIMARY of the two poison-resistance invariants named in the module
header. A synthetic block reaching coverage lets an injected pair masquerade as the real
boundary, which is the exact wedge the backstop exists to catch second.
Open questions: None.

### recut-intent-survives-the-mandatory-cas-reload

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `boundary_divergence_recut_retries_after_interleaved_historian_publish`
(`transform.rs:20433`) constructs exactly this race. It does not run in CI.
Guarantee: A boundary divergence proven on attempt N is still repaired on attempt N+1, even
though the reload observes a newer m1 watermark that would otherwise classify the pass as an
ordinary defer.
Check: `always` — on any firing whose attempt N set `boundary_divergence_detected`, assert
the accepted pass carries `materialize_reason == "boundary_divergence_recut"` (`:4361`).
`always` because forgetting proven damage is wrong on every occurrence.
Fault/timing angle: The mechanism is
`boundary_divergence_retry |= boundary_divergence_detected` at `:2289`, a sticky OR across the
loop. On the retry, `:3889` skips the revalidation and `:3942` short-circuits the recut
filter. Also, `boundary_divergence_pending_count` (`:3925-3939`) is reset to zero on a
retry-driven recut (`:3947-3949`), so the three-pass suppression budget (`:85`) is not
consumed by the retry.
Required faults and enabling state: A divergence candidate from
`detect_boundary_divergence_candidate` (`:6557-6600`), plus a historian publish committing
between the detection and the terminal commit, which is what forces the `CasConflict` at
`:2283`.
Confidence: high — [evidence](evidence/recut-intent-survives-the-mandatory-cas-reload.md).
Traced the flag from `:2270` through `:3232`, `:3889`, `:3942`, `:3953`, `:2289`.
Existing check: `transform.rs:20433`, and
`stale_full_state_sync_cannot_rewind_a_committed_divergence_recut` (`:20841`) for the
post-commit half.
Impact: Without the sticky flag, a session with a damaged coverage row alternates between
detecting the damage and being told by a fresh watermark that a publish is legitimately ahead,
so the repair never fires and the served prefix stays wrong.
Open questions:

- `active_legitimate_publication_window` (`:3924`) retains prior evidence rather than
  incrementing, bounded by "the 3,800-second wrapup request budget documented on the context"
  (`:3919-3923`). Is that budget enforced anywhere reachable from the transform, or only by the
  wrapup handler? Unresolved, needs 4a.

### sel-pass-order-deterministic-under-fixed-inputs

Type: safety
Reachability: default-production — every transform pass with `compaction_enabled` runs the
selection region. `compaction_enabled` defaults to `true` (`config.rs:123`) and reaches
`ProducerContext` at `lib.rs:8302`; the disabled arm returns early at
`transform.rs:3233-3235`.
Status: active
Exercised: not yet — no test replays one fixed pass input repeatedly across processes and
compares the selected decision list and its order byte for byte.
Guarantee: For a fixed request, store row, and producer context, the set of selected
reductions, caveman units, and strip units and their order are identical on every evaluation,
and no ordering depends on the iteration order of a `HashMap` or `HashSet`.
Check: `always` — assert on every pass that a second evaluation of the selection region over
the same inputs yields an equal decision vector in the same order. These semantics because
determinism is the stated cache invariant (`selection.rs` header, quoted in the part-4 scope
map at `_lenses/scope-map-and-risk-ranking.md:313`): a single divergence produces
non-replayable frozen bytes, so there is no tolerated window.
Fault/timing angle: none. This is a pure-ordering property over one pass.
Required faults and enabling state: none. It needs only a session with more than one eligible
reduction target so that an order exists to disagree about, plus a randomized `RandomState`
across processes, which is the default.
Confidence: high — [evidence](evidence/sel-pass-order-deterministic-under-fixed-inputs.md). I
enumerated every `HashMap` and `HashSet` construction in `transform.rs:1-7510` and checked each
use site; all are membership or lookup. Every ordered artifact uses `BTreeMap`, `BTreeSet`, or
an explicit total sort.
Existing check: `transform.rs` inline tests around `new_caveman_units` (`:25479-25490`,
`:25684`) assert unit contents but not cross-process order stability. None of them runs in CI.
Impact: A divergence changes frozen bytes between two passes over identical inputs, which busts
the provider prefix cache and, because the frozen unit is then re-supplied with different bytes,
trips `validate_reduction_monotonicity` (`:6813-6826`) and fails the pass.
Open questions: None.

### sel-eligibility-reads-process-local-scheduler-state

Type: safety
Reachability: default-production — `lib.rs:8309-8312` populates
`observed_last_response_at_ms`, `historian_active`, and `wrapup_active` from process-local
structures on the ordinary transform path.
Status: active
Exercised: not yet — no test drives two `McHandler` instances against one store and compares
the selected pass class for the same request.
Guarantee: The pass class and sub-pass eligibility for a firing are a function of the request
and the durable store row only, or else every process-local input that changes them is recorded
durably so a second process reaches the same decision.
Check: `always` — on each pass, assert that the inputs which decide the pass class are all
derivable from the request plus the loaded row. These semantics because the module's own header
calls the transform's decisions store-derived and caller-independent (`transform.rs:655-658`),
and any pass may be the one that diverges. The workload must assert **both** directions of the
divergence, not one: on a fresh process the same request is *more* likely to reach `Execute`
through the TTL arm and *less* likely to fire the idle HARD.
Fault/timing angle: The window is a fresh process, or a second process sharing the store.
`observed_last_response_at_ms` returns `None` for a session until this process records a
response (`lib.rs:4460-4483`), and `None` sets `last_response_time_ms = 0`. The consequence
splits in direction, and the direction was previously stated backwards for one of the two arms.
`ttl_hard_expired` (`scheduler.rs:429-431`) is
`last_response_time_ms > 0 && now_ms.saturating_sub(last_response_time_ms) > ttl_ms`, consumed
at `:726`, so a zero anchor does disable the idle HARD. But `ttl_execute_fired` (`:423-425`) is
`now_ms.saturating_sub(last_response_time_ms) > ttl_ms` with **no positivity guard**, consumed
at `:499`, so with a zero anchor it reduces to `now_ms > ttl_ms`, which any realistic clock
satisfies, and the arm at `:498-500` returns `Execute`. The only place a zero anchor defers is
the early guard at `:476-477`, and that also requires `usage.percentage == 0.0`.
Required faults and enabling state: Restart the module process, or run a second module against
the same store, then issue a transform for a session whose durable
`last_committed_pass_at_ms` is older than the cache TTL. Assert both halves: the first pass in
the new process must not fire the idle HARD, and it must reach `Execute` through the TTL arm.
Confidence: high —
[evidence](evidence/sel-eligibility-reads-process-local-scheduler-state.md). I traced all four
process-local `ProducerContext` fields to their producers and confirmed
`observed_last_response_at_ms` deliberately discards the durable anchor it reads
(`lib.rs:4470-4482`).
Existing check: none found for the cross-process case. `lib.rs` has tests that set
`execute_threshold_percentage: 65.0` directly (`:16488`, `:16561`, `:16753`) and bypass the
resolution path.
Impact: A daemon restart silently changes the pass decision for one pass per session, in both
directions: the idle-TTL fold does not fire, and the TTL execute arm fires that would not have.
In a shared-store deployment the two processes disagree about whether a pass busts, which
produces two different frozen renders for the same conversation state. The portfolio
evaluation's bias 1 puts that second half in doubt, because `open_sqlite` acquires a
single-writer file lease and refuses a second live writer (`cortexkit-store:249-281`), which
would leave only the single-process restart case.
Open questions:

- Is discarding the durable `last_committed_pass_at_ms` anchor at `lib.rs:4482` intentional
  conservatism, or an oversight? The code reads the anchor, stores it in the observation, and
  returns `None` anyway. (needs human input)
- Is restart equivalence contractual at all, and are multi-writer stores ever supported? Both
  are the portfolio evaluation's bias 1, and answering them decides whether this record
  describes a defect or documented conservatism. (needs human input)

### sel-caveman-eligibility-ladder-deterministic-over-frozen-basis

Type: safety
Reachability: explicit-config-only — the config default is
`CavemanConfig { enabled: false, .. }` (`config.rs:74-79`, `false` at `:76`), the shipped
OpenCode path sends
`caveman_enabled: !isSubagent && deps.cavemanTextCompression?.enabled === true`
(`rust-mode-transform.ts:2015-2016`), and the request serde default is also `false`
(`transform.rs:729-731`). So both the config default and the shipped path are off unless a
user opts in.
Status: active
Exercised: partial — `transform.rs:25479-25490` asserts the empty and non-empty cases;
`:25752-25760` covers the protected-window exclusion. No test asserts that a same-pass tag mint
cannot change the eligible population.
Guarantee: The caveman eligible population and each block's target depth are determined by the
tag basis frozen in this pass's own commit, so a tag minted during the same pass cannot change
which blocks are compressed or how deeply.
Check: `always` — assert that every candidate's tag number is at or below
`caveman_age_basis_tag`, and that the position ladder is computed over the sorted candidate
list. `always` because the basis is captured on every bust pass and a leak would corrupt the
frozen bytes for that pass.
Fault/timing angle: The window is a bust pass that also mints new tags. `age_basis_tag` is the
max *hydrated* tag number (`:4492-4497`), taken before the mint suffix is appended, and it is
persisted in `meta.caveman_age_basis_tag` in the same commit. On a non-bust pass the prior
durable value is reused (`:4499-4501`).
Required faults and enabling state: Caveman enabled, a primary session, a bust pass, and at
least one new tag minted in that same pass so the hydrated and final tag sets differ.
Confidence: high —
[evidence](evidence/sel-caveman-eligibility-ladder-deterministic-over-frozen-basis.md). The
gate, the basis capture, the explicit `sort_by((tag_number, block_id))` at `:6344`, and the
position ladder at `:6283-6297` are all read at `HEAD`.
Existing check: the caveman tests named above, none in CI.
Impact: A basis leak makes the compressed set depend on mint timing, so two passes over the same
conversation produce different frozen caveman payloads and bust the prefix cache.
Open questions:

- `caveman_target_depth` (`:6283-6297`) partitions by fractional position, so adding one
  candidate can shift every other candidate's tier. The units are keyed by block id and depth,
  and a deeper tier is allowed. Does a candidate that moves *shallower* (because the population
  grew) leave a stale deeper unit frozen? `:6355-6358` skips when
  `target_depth <= existing_depth`, which suggests yes by design. Unresolved, needs confirmation
  that a stale deeper unit is intended.

## Group 3: liveness and bounding

Four records, and they are exactly the four `liveness`-typed records in the part. Two are
about loops on the pass path: the retry loop, which has an explicit attempt budget, and the
tag-hydration loop, which has none. Two are about progress a session must make: a durably
queued agent drop must drain within one cache-TTL interval of quiet, and a proven boundary
divergence must be repaired within three passes taken outside a publication window. Both of
the second pair are bounded by a lease whose own duration nothing in this part establishes,
which is why both carry the same unresolved question pointing at Part 4a.

### pass-firing-work-bounded-by-max-cas-retries

Type: liveness
Reachability: default-production
Status: active
Exercised: not yet — no test bounds the work of one firing.
Guarantee: One transform request performs at most nine `apply_once` invocations and then
returns, so the handler cannot be pinned by the retry loop.
Check: `always` — instrument the loop at `:2274` and assert the attempt count never exceeds
`MAX_CAS_RETRIES + 1 = 9` per firing. Then, for the liveness half: under a writer that forces
a CAS conflict on the first three attempts and is then stopped, poll until the firing returns
and assert it returns within nine attempts. `always` for the bound, with the bounded
fault-free window stated in attempts because attempts are the unit `:2284` actually bounds. No
wall-clock "eventually".
Fault/timing angle: The loop is narrow and this record is scoped to it. Only
`TransformError::Store(CasConflict)` re-enters it (`:2283-2284`); every other error returns
immediately (`:2298`); each re-entry re-reads all state from scratch; and the only value
carried across the reload is `boundary_divergence_retry`, accumulated with `|=` at `:2289`.

The scope is a refinement. This record previously carried the unbounded
`load_cached_tags` loop as a second half, which duplicated
`sel-tag-hydration-terminates-once-tag-mutation-stops` and made the record `Partial` on the
fault map for a reason that had nothing to do with the CAS bound. The tag loop is now that
record's alone, and this one needs only the existing attempt hook.
Required faults and enabling state: The `#[cfg(test)]` attempt hook at `:5563-5564` committing
a conflicting row.
Confidence: high — [evidence](evidence/pass-firing-work-bounded-by-max-cas-retries.md).
`MAX_CAS_RETRIES = 8` at `:82`, comparison at `:2284`, no other bounded loop in `apply_once`.
Existing check: `boundary_divergence_recut_retries_after_interleaved_historian_publish`
(`transform.rs:20433`) exercises one retry, not the bound.
Impact: An unbounded retry loop would occupy a tokio worker thread indefinitely, because
`run_transform` (`lib.rs:8322`) is called inline and not under `spawn_blocking`. The bound is
what makes a CAS storm degrade into an error rather than a hang.
Open questions: None.

### sel-tag-hydration-terminates-once-tag-mutation-stops

Type: liveness
Reachability: default-production — `load_cached_tags` is called on every compaction-enabled
pass (`transform.rs:3391`).
Status: active
Exercised: not yet — no test drives concurrent tag mutation against `load_cached_tags` to
force repeated retries.
Guarantee: Once tag mutation stops, `load_cached_tags` returns rather than continuing to
revalidate, so a firing terminates whether or not concurrent writers were converging.
Check: `sometimes` with a bounded fault-free window: run a tag writer that invalidates the
summary on every iteration, **stop the writer**, then assert `load_cached_tags` returns within
one further iteration of each of its two revalidation arms (`:7677-7695`, `:7683-7695`). The
bound is stated in loop iterations, and it has to be, because the loop exposes no attempt
counter, no deadline and no interval, so METHOD.md's requirement to state the bound in the
unit the code bounds is met by the harness imposing the quiescence point instead. That is also
the honest answer to the unresolved convergence question: a run that never quiesces cannot
distinguish a livelock from slow convergence.

Both the type and the semantics are corrections, and the record was renamed from
`sel-cas-retry-budget-bounded-tag-hydration-unbounded`. Its old check was "`always` — assert
on entry to each retry loop that an attempt counter exists and is bounded", with the rationale
"because a loop with no counter is a static property of the code, true or false on every
execution". That is source inspection wearing runtime semantics: nothing executes it, no
campaign can fail it, and a `grep` would settle it. The absence of a counter is a fact about
the code and now lives in the evidence and impact fields, where it belongs.
Fault/timing angle: The window is a concurrent tag-table writer. `load_cached_tags` retries
when the `can_append` fast path fails its post-read verification (`:7677`) or when the full
reload's summary does not match the rows read (`:7684-7695`). Both arms `continue` with no
counter, so a writer that mutates tags faster than the read converges spins the pass thread
inside a store loop.
Required faults and enabling state: Two writers on one store, or a single process where tag
mints from another route interleave with a transform pass on this route, then a quiescence
point. The store generation advances via SQLite triggers (`:7513-7514`), so any tag mutation
invalidates the summary.
Confidence: high —
[evidence](evidence/sel-cas-retry-budget-bounded-tag-hydration-unbounded.md), which still
carries the pre-rename slug and the superseded static framing; the link is deliberate so no
link breaks, and the file needs a rename and a rewrite in a follow-up pass. The CAS bound at
`:2284` and the unbounded loop at `:7641` are both read at `HEAD`. I did not construct the
livelock.
Existing check: `MAX_CAS_RETRIES` has no dedicated test I located. `transform.rs:2303-2322`
installs an attempt hook used by CAS-conflict tests. Nothing exercises the tag-hydration loop
under contention.
Impact: A transform pass can hang without a timeout, holding whatever locks the handler took.
The loop has no attempt counter at all, in contrast to the explicitly bounded CAS loop 5,000
lines above it, and the dispatch wedge detector in `lib.rs:353-508` exists for exactly this
class of symptom, which suggests hangs on this path have been seen.
Open questions:

- Is the tag-hydration loop provably convergent because each retry observes a strictly newer
  generation? The `can_append` arm requires `generation - self.generation == appended`
  (`:7539`), which does not obviously monotonically progress. Unresolved, needs a convergence
  argument or a counter.
- Is `load_cached_tags`'s loop livelock-reachable in production, given the default build's only
  other `mc_tags` writers are `commit_transform` and `descend_lineage`? `mint_or_get_tags`
  (`mc-store/src/lib.rs:6258`) is marked as reachable only under `test` or the `test-support`
  feature (`:6255-6257`), so this needs the 4c concurrency result.

### sel-queued-drop-drains-within-cache-ttl-window

Type: liveness
Reachability: default-production — the idle-TTL fire is the default drain path;
`DEFAULT_CACHE_TTL_MS` is `5 * 60 * 1000` (`scheduler.rs:23`) and applies whenever the
`cache_ttl` string fails to parse (`:810-812`).
Status: active
Exercised: not yet — no test queues a drop, advances the clock past the TTL without taking a
pass, and then issues one pass.
Guarantee: A durably queued agent drop whose target stays in the live tail is applied within
one cache-TTL interval of quiet, measured from the last observed response, and not deferred
indefinitely.
Check: `sometimes` for the drain, with a bounded fault-free window: queue a drop, **advance
the clock past `cache_ttl` without taking a pass**, then issue exactly one pass and assert the
drop applied. The bound is stated in the unit the code bounds, `cache_ttl` milliseconds
(`scheduler.rs:810-812`, `:429-431`), never an unbounded eventually, per METHOD.md's liveness
rules. A unit-level alternative is available and cheaper: drive `apply_once` with
`ctx.observed_last_response_at_ms` pinned and `ctx.now_ms` advanced, which the fixture already
supports (`transform.rs:14332-14333`).

The workload is a correction, and the old one could never terminate. It said to "poll passes
until the configured `cache_ttl` plus one pass has elapsed". Every successful handler pass
calls `record_response_observation` (`lib.rs:8563`), whose body (`:4485-4496`) inserts
`SchedulerObservation { last_response_at_ms: now, observed_in_process: true }`, and the TTL is
measured from exactly that observation. So each poll resets the clock the wait depends on and
the window never elapses.
Fault/timing angle: The window is the interval between the last recorded response observation
and the next pass. Two things can hold the gate shut past the bound.
`ordinary_historian_veto` (`transform.rs:4098-4104`) suppresses the ordinary Execute arm while
a historian lease is held. And a process restart leaves `last_response_time_ms == 0`
(`lib.rs:4482`), which disables the idle-TTL HARD (`scheduler.rs:429-431`) — but note it does
*not* disable the TTL execute arm, which has no positivity guard (`:423-425`, consumed at
`:499`) and with a zero anchor reduces to `now_ms > ttl_ms`. A zero anchor therefore pushes
toward `Execute` and away from the idle HARD, which is the opposite of what this record
previously claimed for the second arm.
Required faults and enabling state: One queued pending-drop row, usage below the execute
threshold on every pass, no `soft_refresh_pending`, an initialized session, and no historian
lease. Then advance the clock past the TTL without taking an intervening pass.
Confidence: medium — [evidence](evidence/sel-queued-drop-drains-within-cache-ttl-window.md).
The gate chain and the TTL predicate are verified. I have not verified that a drop surviving a
`consumed_pending_drop_ids` pass stays durable across an arbitrary number of defers;
`:6735-6779` retires rows on coverage or reasoning grounds, and I did not enumerate every
retirement path.
Existing check: `transform.rs:23678-23690` exercises a pending drop across a "false-window"
case. No test bounds the drain time. It does not run in CI.
Impact: An agent that called `ctx_reduce` sees its reclaim never take effect, with no
diagnostic (see `sel-skip-unobservable-when-producer-gate-closed`), and the context keeps
growing until pressure forces a pass.
Open questions:

- Is the historian veto bounded for this purpose? `ctx.wrapup_active` is documented as bounded
  by `historian::MAX_WRAPUP_REQUEST_BUDGET` (3,800 seconds, `transform.rs:604-606`), but
  `ctx.historian_active` has no stated bound at this call site. Unresolved, needs the 4a lens's
  finding on historian lease duration.

### sel-divergence-repair-bounded-by-three-pending-passes

Type: liveness
Reachability: default-production — the divergence counter is evaluated on every non-subagent
compaction-enabled pass (`transform.rs:3925-3947`).
Status: active
Exercised: partial — `transform.rs:20699`, `:20750`, and `:20769` iterate the limit constant
and assert escalation, but none of them holds `historian_active` or `wrapup_active` true across
the window.
Guarantee: A detected boundary-coverage divergence is repaired by a recut within
`BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT` passes that are taken outside a legitimate
publication window, and the pending count neither escapes that bound nor resets without a
repair.
Check: `sometimes` with a bounded window of three passes: construct the divergence, take three
passes with no historian or wrapup lease held, and assert the recut fired. Three attempts is
the unit the code bounds (`transform.rs:85`), so the bound is stated in that unit rather than
in wall-clock time.
Fault/timing angle: The count is frozen, not incremented, while
`ctx.historian_active || ctx.wrapup_active` (`:3924-3928`). A process that holds a historian
lease across many passes therefore takes an unbounded number of passes without advancing
toward repair, and the three-pass bound is a bound on a subsequence, not on the pass sequence.
Required faults and enabling state: A coverage gap with a missing or stale applied-compartment
watermark, so `divergence_candidate` is `Some` and `compartment_revision_matches` is false,
plus no `divergence_inputs_moved`.
Confidence: high —
[evidence](evidence/sel-divergence-repair-bounded-by-three-pending-passes.md). I read the full
counter expression and the recut filter; the freeze arm is the first arm of the `if` at
`:3926-3928`, so it takes priority over both the increment and the reset.
Existing check: three inline tests named above, none in CI.
Impact: A genuinely damaged row waits indefinitely while a historian lease is held. The comment
at `:3919-3923` argues this is deliberate, so the property under test is whether the "bounded
by the wrapup budget" claim holds for the `historian_active` half too.
Open questions:

- The comment at `transform.rs:3919-3923` bounds the wait by the wrapup request budget, but the
  freeze condition ORs in `ctx.historian_active`, which that budget does not cover. Is the
  historian lease independently bounded? Unresolved, needs the 4a lens.

## Group 4: configuration and observability

Six records on values that arrive from outside the engine and on what the engine says about
the decisions it makes with them. The first two are one number read twice with two different
sanitizations, from a request field with no validator. The next two are documented config keys
the module does not implement or does not read on one transport leg, so a user's setting is
silently ignored. The fifth is the part's only `unreachable` record, a bare release-live
`assert!` on a config-gated path, and it sits here rather than with the other caveman record
because its enabling state is a user opt-in. The sixth is the group's odd one out and is kept
distinct deliberately: it is not about a wrong value but about a correct decision that leaves
no trace, so an operator cannot tell a gate closing by design from a selector that found
nothing from a selector that crashed.

### sel-budget-execute-threshold-unvalidated-from-request

Type: safety
Reachability: default-production — the OpenCode plugin sends
`effective_execute_threshold` on every pass
(`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2009`), and
`lib.rs:8298-8299` prefers it over the clamped route config unconditionally.
Status: active
Exercised: not yet — no test sends an out-of-range `effective_execute_threshold` and asserts
either a rejection or a clamp.
Guarantee: The execute threshold that reaches the selection ceiling is inside `[1, 90]`,
matching the range the module's own config enforces.
Check: `always` — assert `(1.0..=90.0).contains(&ctx.execute_threshold_percentage)` at the top
of the selection region. `always` because the value is read on every pass and a bad value is
not a transient condition, it is a stuck configuration. A finiteness clause,
`ctx.execute_threshold_percentage.is_finite()`, is worth asserting as an explicitly
**`test-only`** direct-unit case, because no non-finite value can arrive over the wire.

The scoping is a correction, and the reason matters more than the verdict. This record
previously listed `NaN` alongside a negative and an above-90 value as things a host or a
compromised plugin sends, under a `default-production` label, and its whole impact statement
was about `NaN` propagating through `f64::clamp`. It cannot arrive. The tempting argument,
"JSON numbers are finite", does not hold: there is no `NaN` token, but `1e999` is a
syntactically valid JSON number a naive parser could hand back as `f64::INFINITY`, which is
also non-finite. The real reason lives in the parser: `serde_json` 1.0.151, pinned at
`Cargo.lock:1668-1669`, **rejects** an infinite parse result with
`ErrorCode::NumberOutOfRange`, on the `float_roundtrip` path (`de.rs:631-632`) and on the
default path (`de.rs:892-893`). The config route cannot produce one either, because
`number_at` filters to finite (`config.rs:631-636`). The negative and above-90 cases remain
`default-production`, which is why the record's label is unchanged.
Fault/timing angle: none. It is a single unvalidated field read per pass.
Required faults and enabling state: A host or a compromised plugin that sends
`effective_execute_threshold` as a negative or a value above 90. The serde field is
`Option<f64>` with no validator (`transform.rs:707-709`, wire mirror `:924`), so any JSON
number in range arrives intact. For the `test-only` finiteness case, construct the
`ProducerContext` directly with `f64::NAN`.
Confidence: high —
[evidence](evidence/sel-budget-execute-threshold-unvalidated-from-request.md).
`execute_threshold_or` (`lib.rs:1710-1712`) is a bare `unwrap_or`; I confirmed config.rs clamps
its own value (`:568-570`) and the request path does not go through that code.
Existing check: `scheduler.rs:461-464` sanitizes for the scheduler only. `scheduler.rs:1127`
has a `resolve_execute_threshold` table test. Neither covers the request field. None runs in
CI.
Impact: A value above 90 makes the selection ceiling admit more history than any pass class
will ever bust to reclaim, which is the live production consequence and is what
`sel-budget-ceiling-clamp-diverges-from-scheduler-cap` measures. At the unit level, `NaN`
propagates through `clamp` at `transform.rs:4231` into `ceiling_tokens`, so every ceiling
comparison in the selector is false and pressure-driven reclaim silently stops; that is a fact
about the code reachable only by a direct call.
Open questions:

- Does any comparison in `selection.rs` treat a `NaN` ceiling as unbounded rather than as
  zero? Resolving this decides whether the unit-level failure mode is "never reclaims" or
  "reclaims everything". Unresolved, needs a read of the ceiling comparisons in `selection.rs`.

### sel-budget-ceiling-clamp-diverges-from-scheduler-cap

Type: safety
Reachability: default-production — both clamps execute on every compaction-enabled pass.
Status: active
Exercised: not yet — no test asserts that the ceiling used by the selector and the threshold
used by the band logic derive from the same number.
Guarantee: The selection ceiling and the scheduler band threshold are computed from the same
effective threshold value, so a pass cannot select reductions against a budget the scheduler
would never authorize.
Check: `always` — assert that the percentage used at `transform.rs:4231` equals the threshold
`scheduler::resolve_execute_threshold` produced for the same pass. `always` because both are
computed on every pass and the disagreement is structural, not situational.
Fault/timing angle: none.
Required faults and enabling state: An effective threshold above 90. That is reachable only via
the unvalidated request field, so this record shares its enabling state with
`sel-budget-execute-threshold-unvalidated-from-request`; it is recorded separately because the
defect is the divergent cap, not the missing validation.
Confidence: high —
[evidence](evidence/sel-budget-ceiling-clamp-diverges-from-scheduler-cap.md). Verified both
clamp sites: `transform.rs:4231` uses `clamp(1.0, 100.0)`, `scheduler.rs:464` uses
`min(MAX_EXECUTE_THRESHOLD_PERCENTAGE)` where that constant is `90.0` (`scheduler.rs:17`).
Existing check: none found.
Impact: The selector believes it has up to ten percent more usable window than the scheduler
will ever declare pressure over, so the age-reclaim batch it sizes can be larger than the band
that authorized the pass. The observable symptom is over-dropping on a force pass.
Open questions:

- Is the 100 in `clamp(1.0, 100.0)` deliberate, on the theory that the ceiling is a raw window
  fraction rather than a scheduler threshold? The comment above the call
  (`transform.rs:4204-4206`) explains a different point and does not address the cap. (needs
  human input)

### sel-per-model-and-token-thresholds-inert-in-module

Type: safety
Reachability: default-production — `scheduler_config` is called on both `scheduler::decide`
paths (`transform.rs:2814`, `:3973`) and always builds the same shape.
Status: active
Exercised: not yet — no Rust test asserts that a config carrying `execute_threshold_tokens` or
an object-valued `execute_threshold_percentage` changes the module's decision.
Guarantee: The documented `execute_threshold_tokens` map and the object form of
`execute_threshold_percentage` either affect the module's pass decision, or a config carrying
them is reported as ignored.
Check: `always` — assert that the `SchedulerConfig` handed to `scheduler::decide` reflects the
parsed config's threshold shape. `always` because the config is resolved once per route and
read on every pass, so the condition never varies within a route's life.
Fault/timing angle: none.
Required faults and enabling state: A user config that sets `execute_threshold_tokens` or an
object-valued `execute_threshold_percentage`, on a route whose threshold is not overridden by
the request's `effective_execute_threshold`. That is the Claude Code leg, which
`lib.rs:181-182` describes as route-config-authoritative.
Confidence: high —
[evidence](evidence/sel-per-model-and-token-thresholds-inert-in-module.md). `scheduler_config`
hardwires `execute_threshold_tokens: None` (`transform.rs:6109`) and
`ExecuteThresholdConfig::Percentage` (`:6106-6108`); `McModuleConfig` has no tokens field
(`config.rs:82-116`); and `number_at` (`:631-636`) returns `None` for an object with no
warning, while the neighbouring project-tier keys do warn (`:576-583`).
Existing check: `scheduler.rs:1127` table-tests `resolve_execute_threshold` directly, and
`scheduler.rs:1056-1061` pins the two constants against a golden. Neither reaches the config or
transform path. The TypeScript leg does implement the feature and has its own tests. None of
the Rust tests run in CI.
Impact: A user who sets a per-model token threshold to work around a provider that limits
effective prompt size below its advertised window (the exact use case
CONFIGURATION.md:321 gives) gets no effect on the Claude Code leg and no warning. The
consequence is compaction firing at the wrong point, and on the paths described in
`docs/specs/context-window-geometry.md` that means provider overflow.
Open questions:

- Is the intended design that the host always resolves the threshold and sends
  `effective_execute_threshold`, making the module's own config a pure legacy fallback? If so,
  `config.rs`'s threshold parsing and `CONFIGURATION.md`'s documentation of the object and
  tokens shapes are both describing a TypeScript-only feature, and the module's silent drop is
  correct but undocumented. (needs human input)

### sel-protected-tags-not-read-from-module-config

Type: safety
Reachability: default-production for the Claude Code leg. The evidence for both sides:
`config.rs` contains zero occurrences of `protected_tags` (verified with `grep -c`), so the
module config default does not exist; and the shipped Claude Code setup path,
`apply_claude_code_config_controls` (`lib.rs:173-194`), sets five request fields plus one
conditional override and omits `protected_tags` and `clear_reasoning_age`, so those fall back
to the serde defaults `20` (`transform.rs:893-895`) and `50` (`:119`, `:861-863`). The
OpenCode leg does send both (`rust-mode-transform.ts:2031`, `:2014`), so this is leg-specific.
Status: active
Exercised: not yet — `lib.rs:18142-18155` asserts the caveman fields are applied but does not
assert anything about `protected_tags`.
Guarantee: A user-configured `protected_tags` takes effect on every transport leg, or a
misconfiguration on a leg that ignores it is reported.
Check: `always` — assert that the effective `protected_tags` used by the selection region
equals the configured value for the bound route. `always` because the value is read on every
pass; a leg that ignores it ignores it always.

The scope is a correction. The guarantee previously covered "a user-configured
`protected_tags` **and `clear_reasoning_age`**" while the check and the required state named
only `protected_tags`, so the second key had no oracle and no workload. The underlying fact
about `clear_reasoning_age` is true and is kept rather than deleted:
`apply_claude_code_config_controls` omits both keys and `config.rs` contains zero occurrences
of either. It is queued as a sibling record in the open questions below, because its oracle
reads a different selection input.
Fault/timing angle: none. It is a missing field assignment.
Required faults and enabling state: A user config setting `protected_tags` to something other
than 20, on a Claude Code route. The Claude Code leg does not carry these controls in its
request, which is the stated reason `apply_claude_code_config_controls` exists at all
(`lib.rs:181-182`).
Confidence: high — [evidence](evidence/sel-protected-tags-not-read-from-module-config.md).
`grep -c protected_tags crates/mc-module/src/config.rs` returns 0, and I read the full body of
`apply_claude_code_config_controls`.
Existing check: `lib.rs:18123-18170` has three `apply_claude_code_config_controls` cases. None
asserts `protected_tags`. None runs in CI.
Impact: `protected_tags` is safety-relevant: it is the count of newest tags immune from
dropping, and it feeds `newest_active_tag_block_ids` (`transform.rs:4177-4182`) and
`caveman`'s protected cutoff (`:6318`). A user who raises it to protect recent work gets the
default 20 on the Claude Code leg with no warning, so content they expected to be protected
becomes eligible for reduction. This is a misconfiguration that silently weakens a
safety-relevant gate.
Open questions:

- Is `protected_tags` intended to be host-owned rather than module-config-owned?
  CONFIGURATION.md:165 documents it as a module config key with a default of 20 and a range of
  1 to 100, which argues the module should read it. (needs human input)
- `clear_reasoning_age` has the same defect on the same leg and needs its own record, because
  its oracle reads a different selection input. Queued rather than folded in here.

### sel-caveman-deeper-tier-growth-panics-in-production

Type: reachability
Reachability: explicit-config-only — the config default is
`CavemanConfig { enabled: false, .. }` (`config.rs:74-79`, `false` at `:76`). The shipped setup
path agrees: the OpenCode plugin sends
`caveman_enabled: !isSubagent && deps.cavemanTextCompression?.enabled === true`
(`rust-mode-transform.ts:2015-2016`), and the Claude Code leg copies the same config field at
`lib.rs:186`. The request serde default is also `false` (`transform.rs:729-731`). So both the
config default and the shipped path are off unless a user opts in.
Status: active
Exercised: partial — `transform.rs:25463-25490`, `:25606`, `:25660-25684` set
`caveman_min_chars = 1` and drive `new_caveman_units`, but none constructs a deeper tier whose
output is longer than the shallower frozen payload.
Guarantee: The caveman size assertion never fires, so no pass panics on a deeper tier whose
payload grew.
Check: `unreachable` — the panic edge of the `assert!` at `transform.rs:6366-6369` must never
be taken. `unreachable` because this is a forbidden **code location** with a dedicated
detection point, which is exactly METHOD.md's `unreachable` case rather than the `always(!X)`
case reserved for forbidden states with no detection point. An `unreachable` check needs no
witness of the forbidden state, which also means no coverage marker may be written as
`sometimes(caveman_payload_grew)`: such a marker could only fire by crashing the pass.
Coverage belongs on the adjacent equal-length arm instead.

Both the type and the guarantee are corrections, and the old pair contradicted itself across
two fields. The guarantee read "Deepening a caveman tier never produces a longer payload than
the tier already frozen for that block, **and if it could, the pass does not panic**", while
the confidence line correctly described the `assert!` as live in release. The implementation
panics: `:6366-6369` is a bare `assert!` and not `debug_assert!`, and the payload choice at
`:6370-6374` is reached only after the assertion has already held, so there is no graceful arm
to guarantee.
Fault/timing angle: none. It is a single comparison per candidate block.
Required faults and enabling state: A text block for which `caveman::compress(source, Ultra)`
is longer than `caveman::compress(source, Full)`, or than whatever depth is already frozen,
plus caveman enabled and the block inside the eligible tag window. Because the compression is
always applied to the persisted original (`:6338-6340`) rather than to the intermediate, the
relation is a property of `caveman.rs`'s level ladder, not of the transform.
Confidence: medium —
[evidence](evidence/sel-caveman-deeper-tier-growth-panics-in-production.md), which still
argues the superseded `always` size-relation framing and was not rewritten in this
disposition. The `assert!` is verified at `:6366-6369` and is a hard assert, not
`debug_assert!`, so it is live in release. I did not audit `caveman.rs` (651 lines, 40 tests,
owned by 4e) to establish whether a growing deeper tier is constructible, so the reachability
of the panic itself is unresolved.
Existing check: the caveman tests named above. None runs in CI.
Impact: A panic inside `apply_once` on a user-opted-in feature. The pass does not commit, and
whether the panic escapes to the host or is caught depends on the dispatch path, which is 4c
and 4d territory.
Open questions:

- Can `caveman::compress` at a deeper level ever produce more bytes than at a shallower level
  for the same input? Unresolved, needs a read of `caveman.rs`'s level ladder or a property test
  over it.
- CONFIGURATION.md:740 claims repeated tier shifts "converge to exactly the same output as
  direct compression at the final depth", but `transform.rs:6370-6374` keeps the shallower bytes
  when the deeper tier ties on length while still recording the deeper depth. Both sides cited;
  the divergence is between the code's own comment at `:6366-6368`, which accepts this as
  matching TypeScript's persisted-depth behaviour, and CONFIGURATION.md.
- Whether the assertion should be a panic at all is a product decision and remains on the fault
  map's list. (needs human input)

### sel-skip-unobservable-when-producer-gate-closed

Type: safety
Reachability: default-production — `producer_gate` is evaluated on every compaction-enabled
pass and is false on every plain defer without a hard advisory, which is the common steady
state.
Status: active
Exercised: not yet — no test asserts that a skipped selection emits a distinguishable
diagnostic.
Guarantee: When an eligible reduction is not selected because a gate closed, the reason is
observable from the response or the emitted diagnostics.
Check: `always` — assert that on any pass where the durable pending-drop queue is non-empty and
no reduction was applied, the response or the timing line names the gate that closed. `always`
rather than `unreachable` because the forbidden condition is a *state* (a skip with no
diagnostic), not a code location that must not execute; METHOD.md's first check-semantics rule
applies directly.
Fault/timing angle: none. The window is any defer pass with queued work.
Required faults and enabling state: Queue an agent drop through
`handle_agent_drops_value`, then issue a transform whose usage is below the execute threshold,
whose cache is warm, and which has no hard advisory. That gives `producer_gate == false` and
`SelectionOutcome::default()`, whose four counters are `None` (`selection.rs:1096-1104`).
Confidence: high —
[evidence](evidence/sel-skip-unobservable-when-producer-gate-closed.md). I read the whole gate
region (`transform.rs:4098-4258`) for logging and found none, checked
`format_pass_timing_line` (`:1317-1360`) field by field, and confirmed the counters are only
committed when `commit_required` (`:5560-5562`, else arm `:5600-5601`).
Existing check: `transform.rs:15795`
`producer_gate_runs_on_execute_force_and_hard_advisory_never_plain_defer` covers the gate's
truth table, not its observability. It does not run in CI.
Impact: An operator watching a session whose queued drops never apply has no signal
distinguishing "gate closed by design" from "selector ran and found nothing" from "selector
crashed and returned default". The scope map records silent skips as a recurring finding in
this repo, and this is one.
Open questions:

- Should the four supersession counters be committed even when `commit_required` is false,
  given that a no-op defer is exactly the pass an operator most wants explained? (needs human
  input)

## Relationship map

Trimmed deliberately to the three clusters that genuinely cross a group boundary. Eight
sections over 24 records previously became ten mechanism clusters here, which forced a reader
to hold two taxonomies at once with neither authoritative; the four groups above are the
authoritative partition, and repeating them here would move the duplication rather than remove
it. Every dominance statement below is a **hypothesis** about which oracle subsumes which,
offered to guide ordering, not a verified claim; none has been tested, because nothing in this
scope executes in CI.

- **The lease that freezes progress (groups 3 and 2).**
  [sel-queued-drop-drains-within-cache-ttl-window](#sel-queued-drop-drains-within-cache-ttl-window),
  [sel-divergence-repair-bounded-by-three-pending-passes](#sel-divergence-repair-bounded-by-three-pending-passes),
  [sel-eligibility-reads-process-local-scheduler-state](#sel-eligibility-reads-process-local-scheduler-state).
  Three records over one pair of process-local flags. `ctx.historian_active` and
  `ctx.wrapup_active` suppress the ordinary Execute arm through `ordinary_historian_veto`
  (`:4098-4104`) and freeze the divergence pending count outright (`:3924-3928`), and
  `ctx.observed_last_response_at_ms` decides whether the idle-TTL predicates can fire at all.
  So both liveness bounds in group 3 are bounds on a *subsequence* of passes, selected by state
  that group 2's record says is not in the request or the store. `wrapup_active` has a stated
  bound of 3,800 seconds (`transform.rs:604-606`); `historian_active` has none at this call
  site, which is why both group 3 records carry the same unresolved question pointing at Part
  4a. Hypothesis: the eligibility record *hypothetically dominates* neither liveness record but
  is a precondition for stating either bound honestly, because a harness that cannot pin
  `observed_last_response_at_ms` cannot construct the quiet window the drop-drain record needs.
  One harness serves all three: pin the three context fields and advance `now_ms`, which the
  fixture already supports (`transform.rs:14332-14333`).
- **The caveman pair, split by what each asks (groups 4 and 2).**
  [sel-caveman-deeper-tier-growth-panics-in-production](#sel-caveman-deeper-tier-growth-panics-in-production),
  [sel-caveman-eligibility-ladder-deterministic-over-frozen-basis](#sel-caveman-eligibility-ladder-deterministic-over-frozen-basis).
  Both are gated on the same opt-in and both are the part's only two
  `explicit-config-only` records, but they ask different kinds of question, which is why they
  sit in different groups. The panic record is a reachability claim about one code location and
  its answer lives in `caveman.rs`'s level ladder, which is 4e's file. The ladder record is a
  determinism claim about the eligible population and its answer lives in the basis capture at
  `:4492-4497` and the sort at `:6344`. Hypothesis: no dominance in either direction. They
  share only the config gate and the same three tests (`:25463-25490`, `:25606`,
  `:25660-25684`), so one enabling fixture serves both while the oracles have nothing in
  common. Note the deliberate asymmetry in their coverage guidance: the panic record forbids a
  `sometimes` marker on the forbidden state, because such a marker could only fire by crashing
  the pass, and directs coverage at the equal-length tie arm instead.
- **Invariants enforced by convention rather than by a mechanism (groups 4 and 2).**
  [exactly-one-core-step-executes-per-pass](#exactly-one-core-step-executes-per-pass),
  [core-fields-mutated-outside-the-step-machine](#core-fields-mutated-outside-the-step-machine),
  [sel-budget-execute-threshold-unvalidated-from-request](#sel-budget-execute-threshold-unvalidated-from-request),
  [sel-budget-ceiling-clamp-diverges-from-scheduler-cap](#sel-budget-ceiling-clamp-diverges-from-scheduler-cap).
  Four records whose shared shape is that the thing which would enforce them does not exist.
  One transition per pass is enforced by control-flow shape plus a `String` move
  (`:3540-3544`), which a refactor that clones instead of moves silently removes. The
  machine's own guard at cache-core `:227` is routed around by three direct writes to `pub`
  fields, and every `step` call discards the `StepResult` that would let the engine cross-check
  the machine's verdict. And one threshold number is read twice with two different
  sanitizations, `clamp(1.0, 100.0)` at `transform.rs:4231` against
  `min(90.0)` at `scheduler.rs:464`, from a request field whose serde type is a bare
  `Option<f64>`. Hypothesis: adding one validation at the top of the selection region
  *hypothetically dominates* both budget records, since a single in-range assertion makes the
  clamp divergence unreachable rather than merely detectable; nothing dominates the two
  step-machine records, because their enforcement point is in a repository this one does not
  pin.

Five clusters were dropped rather than retracted, and the reasons are recorded so their
absence is not read as a withdrawal. **"One fence, three transactions"** now lives in group 1's
preamble, carrying the correction that the two out-of-fence writes are observable at two
specific in-code error sites and unfalsifiable only for an arbitrary injected fault. **"One
unbounded loop, found twice"** is resolved rather than dropped: the overlap between the retry
bound and the tag-hydration loop was a genuine duplication, and it is now one record each with
the loop belonging solely to
`sel-tag-hydration-terminates-once-tag-mutation-stops`. The remaining three fell entirely
inside a single group after the collapse — the commit-boundary cluster inside group 1, the
poison-resistance and recut cluster inside group 2, and the silent-configuration cluster
inside group 4 — so their preambles say what the clusters said, and repeating them here would
be the duplication this map was trimmed to remove.

