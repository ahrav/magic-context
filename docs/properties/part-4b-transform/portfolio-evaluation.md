# Part 4b portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md`. Its
charter was to expose systematic gaps rather than to agree. It produced 16
findings. The shape of them is different from Part 4a's: where that evaluation
mostly refuted availability claims on the fault map, this one mostly refuted
claims inside the records themselves. Four records were internally inconsistent,
one had a workload that cannot terminate, one asserted a production input that
cannot arrive, one inventory line was simply false, and the group structure had
fragmented 24 records across eight sections and then regrouped all of them again
in the relationship map.

Four lenses: harness fit, coverage balance, implementability, and a wildcard pass
questioning the framing.

Every finding below was re-verified against the code before acceptance. **All ten
refinements were accepted and applied; none was rejected.** Four were imprecise in
a way worth recording, and in one case the evaluator reached the right conclusion
by the wrong argument, which is recorded because the wrong argument would have led
a later reader somewhere else.

Provenance for this pass. `HEAD` is `e447c927`
("refactor(shm): trim final review leftovers"), which is what the three artifacts
already state, and `crates/mc-module` and `crates/mc-store` are byte-identical to
`76cd6f41` across that span, so every Rust line reference resolves at all three
commits the artifacts cite. Line references verified for this disposition that
lie outside those crates: `CONFIGURATION.md:165` and `:167`, the sibling
`../commons/crates/cortexkit-store/src/lib.rs:249-281`, and the pinned
`serde_json` 1.0.151 source (`Cargo.lock:1668-1669`). The sibling path carries the
same reproducibility caveat Part 3 recorded as its bias 1: this repository
resolves it by path, does not pin it, and CI provisions it as a metadata-only
stub.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 10 | 10 applied, 4 with a corrected or sharpened premise |
| gap | 6 | queued for a follow-up pass, none mined |
| bias | 2 | require human judgment |

Record count **24, unchanged**. No refinement added or removed a record. R2 and R9
narrowed one record and retyped another rather than splitting either, and R6
resolved a contradiction inside one record rather than dividing it in two.

Semantics distribution **19 `always`, 1 `always-or-unreached`, 3 `sometimes`, 0
`reachable`, 1 `unreachable`**, against 21/1/2/0/0 before. `always(!X)` is counted
as `always`, following Part 4a's convention. Two records moved: the tag-hydration
record from `always` to `sometimes` (R2, R9) and the caveman record from `always`
to `unreachable` (R6).

Types **19 safety, 4 liveness, 1 reachability**, against 21/3/0 before. The part
had no reachability record at all; it now has exactly one, and the queued gaps
record that a second one is owed at `transform.rs:3068`.

Reachability-class labels **unchanged at 22 `default-production`, 2
`explicit-config-only`, 0 `test-only`**. One record now carries an explicitly
`test-only` sub-case rather than a changed label: R4 established that the
non-finite half of `sel-budget-execute-threshold-unvalidated-from-request` is not
wire-reachable, while its out-of-range half still is, so the record keeps
`default-production` and names the narrower half inline.

Group count **8 to 4** (R10): transactionality (7 records), transition integrity
(7), liveness and bounding (4), configuration and observability (6). The
relationship map drops from ten clusters to three, keeping only the clusters that
cross a group boundary.

Fault-map totals **20 non-vacuous today, 4 partial, 0 no**, against 19/5/0 before.
The row that moved is `pass-firing-work-bounded-by-max-cas-retries`, which was
`Partial` only because it carried the unbounded tag-hydration loop as a second
half; scoped to the compare-and-swap bound it needs T1 alone, and T1 already
exists and is already used by tests.

Test counts are unchanged. 263 in-crate tests in scope, 6 store-side
transform-commit tests, 2 real-transform integration tests, and none of the 271
executes in CI. The evaluator did not dispute any count, and spot checks of the
per-file figures during this pass found no arithmetic error of the kind Part 4a
had.

## Refinements applied

### R1. The atomicity framing was wrong at the portfolio level, and the snapshot read decides what the baseline can measure

Applied in `catalog.md`, in the coverage section and in the new group 1 preamble,
and in `fault-map.md`, in the third framing point and the baseline record's map
row. `existing-checks.md`'s quiet-area heading is corrected for consistency
because it carried the same overstatement.

The catalog said the atomicity obligation on the two out-of-fence paths "is
currently unfalsifiable by a Rust test rather than merely untested", and the
relationship map said all three atomicity records are "currently unfalsifiable by
a Rust test without new code". That is too strong. Both writes have straight-line
in-code error paths downstream of them inside the same pass, so the split durable
state is observable today from a crafted request with no new seam:

- `store.descend_lineage` (`transform.rs:3312`) commits, and then
  `DuplicateBlockId` (`:3355`), `ReservedId` (`:3362-3365`) and
  `OrdinalViolation` (`:3367-3372`) can each reject the same pass. Verified by
  reading the straight-line order: nothing between `:3312` and `:3372` is
  conditional on a fault.
- `store.truncate_compartments_for_revert` (`:4646`) commits, re-points the pass's
  own CAS expectation (`:4651`) and adopts the new epoch (`:4652`), and the
  `CoverageGap` at `:4704` sits downstream of it.

Only an *arbitrary injected* failure, or a process kill at a chosen point, lacks a
seam, because the engine's one hook (`:2323-2333`) fires at `:5563-5564`, after
both writes. The evaluator was right that the individual records were already
honest about this, and so were `existing-checks.md`'s body text and
`fault-map.md`'s third framing point. The defect was purely in the catalog's
portfolio-level prose, which is the level a reader trusts for the summary.

**Premise sharpening.** The evaluator asked for the baseline check to be
restricted to post-snapshot errors and did not say what that restriction implies.
It removes one of the two writes from the baseline entirely. `descend_lineage` and
all three of its guards execute *before* `load_transform_snapshot` at `:3387`, so
on that arm the baseline's `(row_version, core_state, meta)` triple does not exist
yet and there is nothing to compare against; the write also lands on a *different*
session key. Only the revert truncate is inside the baseline's own window. So the
baseline record now states that exactly one of the two out-of-fence writes is an
exception it can measure, and that the lineage write remains an exception to the
part's atomicity contract while being undetectable by re-reading the triple. That
is a stronger and more useful statement than "two known exceptions live in their
own records", which is what the record said before.

### R2 and R9. The overlapping loop pair is split, and the static claim is retyped

Applied in `catalog.md` as a narrowing of one record and a retype plus rename of
the other, with matching corrections in `fault-map.md` (overlap preamble, both map
rows, totals, leverage items 3 and 8) and `existing-checks.md` (quiet area 3).
Taken together because R9 is the second half of R2.

The two records were `pass-firing-work-bounded-by-max-cas-retries` (liveness) and
`sel-cas-retry-budget-bounded-tag-hydration-unbounded` (safety). Both covered the
same two facts: the compare-and-swap loop is bounded at `MAX_CAS_RETRIES = 8`
(`:82`, compared at `:2284`) and `load_cached_tags`'s loop at `:7644` has no
counter. Three lens files had already flagged the duplication and the fault map
said "synthesis must merge them rather than catalog both"; the catalog kept both
anyway and said so explicitly, on the grounds that "the commissioning scope fixes
the record count at 24". That is a bad reason and the evaluator was right to
reject it.

The resolution keeps the count at 24 without keeping the overlap:

- `pass-firing-work-bounded-by-max-cas-retries` is scoped to the retry loop and
  nothing else. Its `Fault/timing angle` no longer reaches into `load_cached_tags`
  and now records what the loop actually does: only
  `TransformError::Store(CasConflict)` re-enters it (`:2283-2284`), every other
  error returns immediately (`:2298`), and the only value carried across the
  reload is `boundary_divergence_retry` (`:2289`).
- `sel-cas-retry-budget-bounded-tag-hydration-unbounded` becomes
  **`sel-tag-hydration-terminates-once-tag-mutation-stops`**, type `liveness`,
  semantics `sometimes`.

R9 is why the retype was necessary rather than cosmetic. The old record's check
was "`always` — assert on entry to each retry loop that an attempt counter exists
and is bounded", with the rationale "because a loop with no counter is a static
property of the code, true or false on every execution". That is source
inspection wearing runtime semantics. Nothing executes it, no campaign can fail
it, and a `grep` would settle it. The new check is a bounded liveness property:
run a tag writer that invalidates the summary on every iteration, **stop the
writer**, then assert `load_cached_tags` returns within one further iteration of
each of its two revalidation arms (`:7677-7695`, `:7683-7695`). The absence of a
counter moves to the evidence and impact fields, where it belongs.

The bound is stated in loop iterations, and the record says why: the loop exposes
no attempt counter, no deadline and no interval, so METHOD.md's requirement to
state the bound in the unit the code bounds has to be met by the harness imposing
a quiescence point. That is also the honest answer to the convergence question
nobody has resolved, because a run that never quiesces cannot distinguish a
livelock from slow convergence.

### R3. A liveness workload that defeats its own wait

Applied in `catalog.md` on `sel-queued-drop-drains-within-cache-ttl-window`, and
in `fault-map.md` in that record's map row and in the `sometimes`-records section.

The record said to "poll passes until the configured `cache_ttl` plus one pass has
elapsed and assert the drop applied". That cannot terminate. Every successful
handler pass calls `record_response_observation` (`lib.rs:8563`), whose body
(`:4485-4496`) inserts `SchedulerObservation { last_response_at_ms: now,
observed_in_process: true }`. The TTL is measured from exactly that observation,
so each poll resets the clock the wait depends on and the window never elapses.
Verified by reading the call site, which sits on the success path after
`result.response` is taken at `:8521`, and by reading `observed_last_response_at_ms`
(`:4460-4483`), which returns `Some(observation.last_response_at_ms)` once
`observed_in_process` is true.

The check now says to advance the clock past the TTL **without** taking a pass and
then issue exactly one pass, with a unit-level alternative: drive `apply_once`
with `ctx.observed_last_response_at_ms` pinned and `ctx.now_ms` advanced, which
the fixture already supports (`transform.rs:14332-14333`). The `Exercised:` line
is corrected to match, since it also described polling.

**Citation correction.** The evaluator cited `lib.rs:8560-8564`. `:8560` is
`store.trace_pass_completed`; the observation block is `:8562-8565` and the call
is `:8563`. The record cites the call and the body.

### R4. A production input that cannot arrive, and the evaluator's reason for it was not the real one

Applied in `catalog.md` on `sel-budget-execute-threshold-unvalidated-from-request`,
and in `fault-map.md` in the T5 row, that record's map row, and leverage item 3.

The record listed `NaN` alongside a negative and a value above 90 as things "a
host or a compromised plugin" sends, under a `default-production` label, and its
whole `Impact` line was about `NaN` propagating through `f64::clamp` at `:4231`.
The evaluator's conclusion is right and its argument is not. It said "JSON numbers
are finite, so it is unreachable that way". JSON number *literals* are finite in
the sense that there is no `NaN` token, but `1e999` is a syntactically valid JSON
number that a naive parser could hand back as `f64::INFINITY`, which is also
non-finite and would satisfy the record's `is_finite()` clause just as well. The
real reason is stricter and lives in the parser: `serde_json` 1.0.151, pinned at
`Cargo.lock:1668-1669`, **rejects** an infinite parse result with
`ErrorCode::NumberOutOfRange`, on the `float_roundtrip` path (`de.rs:631-632`) and
on the default path (`de.rs:892-893`). So no non-finite `f64` can reach the field
from valid JSON at all, by either route. The config route cannot produce one
either, because `number_at` filters to finite (`config.rs:631-636`).

This matters beyond pedantry. Had the disposition accepted "JSON numbers are
finite" as the argument, a later reader checking `1e999` would have found a valid
literal, concluded the refinement was wrong, and restored a production claim that
is in fact false.

The record now scopes its guarantee and check to `[1, 90]`, keeps the finiteness
clause as an explicitly `test-only` direct-unit case with the reachability
argument inline, and demotes the `NaN` consequence from a production failure mode
to a unit-level fact. The negative and above-90 cases remain `default-production`
and the record's label is unchanged, which is why the reachability distribution
does not move. `sel-budget-ceiling-clamp-diverges-from-scheduler-cap` is
untouched: its enabling state is a value above 90, which is reachable.

### R5. A false inventory claim: both projection assertions do have named tests

Applied in `existing-checks.md`, in the production-assertions cluster and in quiet
area 6, with a qualification added to the `should_panic` inventory line.

The file said of the two `assert_eq!` inside `assert_prefix_projection_equivalent`
(`transform.rs:2349-2353` and `:2354-2357`): "Neither has a named test". Both do.

- `dg_goldens_exercise_incremental_native_differential_mode`
  (`differential_goldens.rs:110-204`) calls
  `assert_prefix_projection_equivalent` directly at `:202`, on an appended-tail
  incremental projection, for every differential-golden case.
- `projection_differential_catches_corrupt_first_changed_position`
  (`lib.rs:21115-21155`) is a `#[should_panic(expected = "incremental prefix
  projection byte drift")]` test that corrupts the first-changed frontier through
  `ProjectionCacheKeyMode::CorruptFrontierForTest` (`:21145`) and drives the
  assertion's failing direction.

**Two precisions.** The evaluator's ranges both end one line early: the
`differential_goldens` test closes at `:204` and the `lib.rs` test at `:21155`.
And the two assertions are not equally covered. The byte-drift assert has a
dedicated negative test; the state-drift assert at `:2354-2357` is executed only
in its passing direction, so a negative test for that specific message is still
missing. `existing-checks.md` now says both of these.

Two halves of the original observation survive and are kept: neither test runs in
CI, and no `docs/` file mentions `MC_PREFIX_PROJECTION_DIFFERENTIAL`. Quiet area 6
is rewritten so the asymmetry it describes is about documentation and release
gating rather than about test coverage.

One knock-on. `existing-checks.md` claims "**None found.** No `#[ignore]` and no
`should_panic`" for the eight scope files. That claim is still true, because
`lib.rs` is a cited adjacent surface rather than a scope file, but the file now
cites a `should_panic` test as coverage for a scope-file assertion, so the line
carries the qualification explicitly to stop a reader reading a contradiction.

### R6. A record that promised the opposite of what the code does

Applied in `catalog.md` on `sel-caveman-deeper-tier-growth-panics-in-production`,
with matching changes in `fault-map.md`'s map row and anti-pattern list.

The guarantee read: "Deepening a caveman tier never produces a longer payload than
the tier already frozen for that block, **and if it could, the pass does not
panic**." The implementation panics. `transform.rs:6366-6369` is
`assert!(compressed.len() <= existing.frozen_payload.len(), ...)`, a bare
`assert!` and not `debug_assert!`, so it is live in a release build, and the
payload choice at `:6370-6374` is reached only after the assertion has already
held. There is no graceful arm to guarantee. The record was promising a failure
mode the code does not implement while its own `Confidence` line correctly
described the assert as live in release, so it contradicted itself across two
fields, which is the same authoring failure Part 4a's evaluation named as a method
lesson.

Of the two options the evaluator offered, the record takes the `unreachable`
panic-edge form. The reasons are that it describes the code as written rather than
the code somebody might prefer, and that METHOD.md's semantics table points here
directly: this is a forbidden **code location** with a dedicated detection point,
which is the `unreachable` case and not the `always(!X)` case reserved for
forbidden states with no detection point. The type moves to `reachability`
accordingly, giving the part its first reachability record.

The change also makes the record consistent with guidance the fault map already
carried. That file forbids a `sometimes(caveman_payload_grew)` marker because it
can only fire by crashing the pass, and directs coverage at the equal-length arm
via `transform_caveman_deeper_tier_tied_on_length`. An `unreachable` check needs
no witness of the forbidden state, so the record and the marker guidance now agree
instead of pulling against each other. Whether the assertion should be a panic at
all remains in the fault map's product-decision list, untouched.

### R7. A scheduler claim that was backwards

Applied in `catalog.md` on `sel-eligibility-reads-process-local-scheduler-state`
and, because the same claim appeared there too, on
`sel-queued-drop-drains-within-cache-ttl-window`.

The record said a `None` observation sets `last_response_time_ms = 0`, "which
disables both the idle-TTL HARD (`scheduler.rs:429-431`) and the TTL arm of
`should_execute` (`:476-478`, `:498`)". The first half is right and the second is
false, and the direction inverts:

- `ttl_hard_expired` (`:429-431`) is
  `last_response_time_ms > 0 && now_ms.saturating_sub(last_response_time_ms) > ttl_ms`,
  consumed at `:726`. A zero anchor does disable it.
- `ttl_execute_fired` (`:423-425`) is
  `now_ms.saturating_sub(last_response_time_ms) > ttl_ms`, with no positivity
  guard, consumed at `:499`. With a zero anchor it reduces to `now_ms > ttl_ms`,
  which is satisfied for any realistic clock, so the arm at `:498-500` returns
  `Execute`. A zero anchor pushes toward Execute, not away from it.
- The only place a zero anchor defers is the early guard at `:476-477`, and it
  requires `usage.percentage == 0.0` as well.

So the divergence the record is about is real but split in direction: on a fresh
process the same request is more likely to reach `Execute` through the TTL arm and
less likely to fire the idle HARD. Both records now say that, and the eligibility
record's workload asserts both halves rather than the one that does not hold.

### R8. A guarantee wider than its oracle

Applied in `catalog.md` on `sel-protected-tags-not-read-from-module-config`.

The guarantee covered "a user-configured `protected_tags` **and
`clear_reasoning_age`**", while the check asserted only "the effective
`protected_tags` used by the selection region equals the configured value" and the
required state was "a user config setting `protected_tags` to something other than
20". The `clear_reasoning_age` half had no oracle and no workload.

The guarantee and check are now scoped to `protected_tags`. The underlying fact
about `clear_reasoning_age` is true and is kept rather than deleted: verified for
this disposition that `apply_claude_code_config_controls` (`lib.rs:173-194`) sets
five request fields plus one conditional override and omits both keys, and that
`config.rs` contains zero occurrences of either. It is recorded in the record's
reachability note and queued as a sibling record in its open questions, because
its oracle reads a different selection input. The record's citation of the
function is also corrected from `:173-193` to `:173-194`, the closing brace.

### R10. Eight groups collapse to four, and the relationship map stops repeating them

Applied in `catalog.md`. Groups A through H become:

| Group | Records | Absorbed |
| --- | --- | --- |
| 1. transactionality | 7 | old A (the terminal CAS and its writers) + B (writes outside the fence) |
| 2. transition integrity | 7 | old C (step-machine integrity) + E (selection determinism and purity) |
| 3. liveness and bounding | 4 | old D (bounding and progress) |
| 4. configuration and observability | 6 | old F (budgets and thresholds) + G (silent skips) + H (inert configuration) |

The evaluator's complaint was structural rather than aesthetic and it verifies:
eight sections over 24 records averaged three records each, one section held a
single record, and the relationship map then re-partitioned all 24 into ten
mechanism clusters, so a reader had to hold two taxonomies at once and neither was
authoritative. The collapse merges sections that shared a mechanism (A and B are
both about the commit boundary; C and E both about whether the transition and its
inputs agree) and folds the singleton into the configuration group while keeping
its distinctness in the preamble.

The map is trimmed from ten clusters to the three that genuinely cross a group
boundary: the lease-freeze cluster (groups 3 and 2), the caveman config-gated pair
(4 and 2), and the enforced-by-convention cluster (4 and 2). Without that trim the
collapse would have moved the duplication rather than removed it. The clusters that
were dropped are named in the map with the reason, so their omission is not read as
a retraction, and the two whose substance changed carry that forward: the
"one fence, three transactions" cluster now lives in group 1's preamble with R1's
correction, and "one unbounded loop, found twice" is recorded as resolved by R2.

Records were reordered so file order matches index order: the old D block moved
after the old E block. No record text moved except the eight records edited by R1
through R8.

## Gaps queued for a follow-up pass

Recorded, not mined. Each carries the evidence that makes it a gap rather than a
preference, and each was verified for this disposition.

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | **No reachability record covers the production `unreachable!` at `transform.rs:3068`, and it is genuinely forbidden.** `PassPlan::Reject(_) => unreachable!("reject returned before composition")` sits in `apply_additive_only`'s composition match. It is forbidden by construction rather than by hope: the same function returns `Err(TransformError::UnknownShape(message))` for `PassPlan::Reject` at `:2889-2891`, roughly 180 lines earlier, so a `Reject` plan cannot survive to the match. That is exactly METHOD.md's `unreachable` case, a forbidden code location with a dedicated detection point, and after R6 the part has the vocabulary for it. Verified both sites at `HEAD`. The branch is `explicit-config-only` and may be unreachable on the shipped OpenCode leg, which downgrades `transform_mode` to `ts` when compaction is off; that affects the record's reachability label, not whether it is owed. |
| G2 | **The two release-live projection assertions have no record.** R5 established that `transform.rs:2337-2358` and its call site at `:3270-3271` do have named tests. They have no property. The gate `prefix_projection_differential_enabled` (`:2337-2342`) is `cfg!(test) \|\| MC_PREFIX_PROJECTION_DIFFERENTIAL == "1"`, so both `assert_eq!` are live in a release build under an environment variable that no `docs/` file mentions, and the call at `:3270-3271` fires only when a reusable projection exists. What is missing is a property over the equivalence claim itself, that an incremental prefix projection is byte-identical and state-identical to a full projection of the same messages, and a decision about whether the panic is the intended production contract. |
| G3 | **`m0_compose.rs`, `m1_compose.rs` and `retained_size.rs` carry determinism and accounting claims across 845 lines with zero tests and zero records.** Verified: 403, 230 and 212 lines, and no `#[test]` or `#[tokio::test]` attribute in any of the three. `existing-checks.md` records this as quiet area 4; the catalog has no record. Between them these files own m0 bytes, m1 bytes and every retention accounting number in the sub-part, and `m0_compose.rs:6-9` states the purity claim the frozen-m0 cache depends on while `m1_compose.rs` has neither tests nor doc comments and is the producer for the m1 digest-completeness claim stated 279 lines away at `transform.rs:509-512`. |
| G4 | **The documented lower bound on `execute_threshold_percentage` is not captured.** `CONFIGURATION.md:167` documents the key as `number` (20-90). `config.rs:568-570` enforces `clamp(1.0, MAX_EXECUTE_THRESHOLD_PERCENTAGE)` where the constant is `90.0` (`config.rs:28`), so the documented lower bound of 20 is enforced as 1. Verified both sides. `existing-checks.md` names it inside quiet area 10 as one of four documentation-versus-config divergences; no record covers it, and it is the one of the four where the code silently accepts a value the documentation forbids rather than silently ignoring a key. |
| G5 | **The store transform transaction's partial-failure atomicity has no property.** `mc-store/src/lib.rs:7259` documents `commit_transform` as committing "accepted cache state and its speculative overlays in one CAS transaction", and the body writes ten groups across `:7390-7597`. `fault-map.md` already records that no catalog record depends on fault class T3, a fault landing between two of those groups, and its leverage ranking puts T3 last precisely because nothing needs it. That is the finding rather than the excuse: the sub-part's whole-or-nothing claim covers ten write groups and no property tests it at the partial-commit level. `transform_cas_conflict_leaves_every_overlay_table_empty` (`:14562`) tests outcome-level rejection, which is a different obligation. |
| G6 | **Reachability records are near-absent from a subsystem with a live panic path.** Before this disposition the part had zero; after R6 it has exactly one, and the gap is narrower than the evaluator stated but not closed. Four panicking sites are in production code (`existing-checks.md`, production-assertions cluster) and three can fire in a release build: the caveman `assert!` at `:6366-6369`, now covered; the two projection `assert_eq!` behind an environment variable, which are G2; and the `unreachable!` at `:3068`, which is G1. So the residual gap is precisely G1 plus G2, and it is recorded separately because the framing matters: a subsystem whose invariants live in guard clusters returning `Result` needs reachability records for the few places that panic instead, and until G1 and G2 land the part reasons about two of its three release-live panics without a property. |

## Biases requiring human judgment

1. **Whether cross-process selection impurity is a defect at all, or deliberate
   restart conservatism over a store that permits only one live writer.** The
   catalog frames `sel-eligibility-reads-process-local-scheduler-state` as a
   defect, and its `Impact` line says "in a shared-store deployment the two
   processes disagree about whether a pass busts, which produces two different
   frozen renders for the same conversation state". That premise is in doubt.
   `McStore::open` (`mc-store:4816-4818`) opens through `open_sqlite`, which
   acquires a single-writer file lease **before** opening the database and returns
   `StoreError::Lease` to a second live writer
   (`../commons/crates/cortexkit-store/src/lib.rs:249-281`). The doc comment there
   states the intent directly, and says the lease is derived from the descriptor
   path so the one-lease-per-database invariant is structural. If that holds for
   the deployments this part cares about, two live module processes on one store is
   not a reachable state, the "two processes disagree" half of the impact
   evaporates, and what remains is the single-process restart case, where
   `observed_last_response_at_ms` returning `None` for one pass may be deliberate
   conservatism rather than an oversight. *Judgment required:* two answers, in
   order. First, is restart equivalence contractual, meaning is the first pass in a
   fresh process required to reach the same decision the old process would have
   reached, or is a one-pass conservative deferral of the idle fold the intended
   behaviour? Second, are multi-writer stores ever supported, on any deployment,
   including a future one? The second answer decides whether the fault map's T4
   capability is worth building at all, and `fault-map.md` leverage item 7 now says
   not to build a two-process harness until this is settled. Note that the existing
   open question on `lib.rs:4482`, whether discarding the durable
   `last_committed_pass_at_ms` anchor is intentional, is the same question asked
   from inside the record, and answering this bias answers it.

2. **The TypeScript-suite observation now appears in all three artifacts without
   becoming a property, and it needs either a commissioned property or demotion to
   one line.** The fact is well established and undisputed: a TypeScript transform
   suite named after this Rust code runs on every pull request and runs no Rust
   (`rust-mode-transform.test.ts`, 70 tests against a hand-written transport stub),
   and beside it 228 tests over a wholly separate TypeScript transform
   implementation of the same contract also run, and nothing compares the two.
   `catalog.md` spends roughly 40 lines on it in the coverage section,
   `existing-checks.md` gives it a dedicated section plus quiet area 12, and
   `fault-map.md` makes it fault class T7 and ranks it second by leverage. Three
   artifacts, one observation, zero records. *Judgment required:* pick one. Either
   commission a differential-equivalence property, in which case the two decisions
   `fault-map.md` already names have to be answered first, who owns the harness and
   which documented byte-identity claims (`CONFIGURATION.md:659`, `:716`, `:763`)
   become failures rather than recorded divergences; or reduce the material to a
   single coverage note in `existing-checks.md` and stop restating it. **This
   refrain risk is not local to Part 4b.** Part 4a recorded the same observation as
   its queued gap G5, with the difference that 4a at least has an in-crate
   TypeScript-oracle golden (`historian_validate.rs:1384`) and 4b has no
   counterpart. Two parts have now independently produced the same unresolved
   finding and neither has produced a property, which suggests the decision belongs
   above the part level, as a single cross-part call rather than as a paragraph
   each part writes again.

## Verdict

The evaluator's verdict was **"not ready" pending these corrections**. After
applying all ten refinements the honest answer is still not ready, but the reason
has changed and the portfolio is materially more trustworthy than it was.

What improved concretely. Four records that contradicted themselves or their cited
code no longer do: the caveman record no longer promises graceful handling of a
case that panics, the eligibility record no longer inverts the scheduler's
behaviour, the protected-tags record no longer guarantees more than it checks, and
the tag-hydration record is no longer a static source claim wearing a runtime
`always`. One liveness workload that could never terminate is now executable. One
production input that cannot arrive is demoted to a direct-unit case with the
parser evidence recorded. One false inventory line is corrected and two named
tests are linked. The part's central atomicity framing is corrected from
"unfalsifiable" to "unfalsifiable in general, observable at two specific error
sites", which changes what a test author does next. And the structure went from
eight groups plus a ten-cluster map to four groups plus a three-cluster map, with
file order matching index order.

Ready now for test implementation, in this order. The out-of-range half of the
execute-threshold sweep and the clamp-divergence record, which need one field value
and pay out immediately at `clamp(1.0, 100.0)` versus `min(90.0)`. The four records
served by the existing CAS-conflict hook, including
`pass-firing-work-bounded-by-max-cas-retries` now that it needs T1 alone, and the
truncate's no-op arm at `mc-store:9053-9059`, which the revert-idempotency argument
rests on and which nothing covers. The two out-of-fence observations at their
in-code error sites, which R1 establishes need no new seam. And the corrected
drop-drain workload, which needs only a clock advance and one pass.

Not ready, for four reasons that no further work of this kind resolves. The six
queued gaps include two whole missing categories: reachability coverage of the
release-live panic path (G1, G2, G6) and any property at all over the 845 lines
that own m0 bytes, m1 bytes and every retention number (G3). Bias 1 is upstream of
a record's severity and of a fault-map capability, and answering it either deletes
half of one record's impact statement or authorises building a two-process harness;
guessing costs one of those. Bias 2 has now recurred across two parts and needs a
call above the part level. And the eight product decisions `fault-map.md` lists
separately are unchanged by this pass, including whether
`MC_PREFIX_PROJECTION_DIFFERENTIAL` is meant to be settable in production, which
G2 now depends on. Above all of it sits the fact none of these corrections touch:
nothing in this scope executes in CI, so every record improved here is a record in
a suite no automation runs.

One process caveat on the verification step, stated rather than hidden. METHOD.md
step 7 requires records to equal index rows to equal evidence files. Records and
index rows both equal 24 and their order now matches. Evidence files remain at 24
but one is misnamed: `sel-cas-retry-budget-bounded-tag-hydration-unbounded.md`
still carries the pre-R2 slug and the pre-R9 static framing, and the renamed record
links to it deliberately so no link breaks. Two evidence files need a follow-up
pass before the mechanical check is clean: that one needs a rename and a rewrite,
and `sel-caveman-deeper-tier-growth-panics-in-production.md` still argues the
`always` size-relation framing that R6 replaced with an `unreachable` panic edge.
The affected records say so at their `Confidence:` lines. This disposition was
scoped to the three artifacts and explicitly forbidden from touching `evidence/`.

## What this evaluation says about the method

Part 4a's evaluation found that absence of a named seam had been read as absence of
the capability, three times. This one found a different and more uncomfortable
pattern: **four of ten refinements are cases where a record's own fields disagreed
with each other, and one is a case where a claim was correct in three artifacts and
wrong in the fourth.**

The field-level disagreements are R6 (a guarantee promising no panic beside a
confidence line describing a live release `assert!`), R8 (a guarantee naming two
config keys beside a check naming one), R9 (a `safety` type and an `always`
semantics over a claim the record itself calls "a static property of the code"),
and R3 (a bounded-window workload whose bound is reset by the action the workload
performs). Part 4a's evaluation already named this failure mode and prescribed the
guard: read each finished record end to end once, as a single argument, before it
ships. That guard was not applied here. It is cheap and it would have caught all
four, so it is worth promoting from a lesson to a step.

The cross-artifact case is R1 and it is the more interesting one. The distinction
between "an injected fault has no seam" and "the split state cannot be observed"
was stated correctly in `existing-checks.md`'s body, correctly in `fault-map.md`'s
framing, and correctly in each individual record, then overstated in the one place
a reader goes for the summary. Precision does not propagate upward on its own. When
a part's headline finding is assembled from records that each hedge correctly, the
hedge is what gets dropped, and the summary is the text most likely to be quoted.

A third, smaller observation. R4 is the only finding where the evaluator reached
the right verdict by an argument that does not hold, and it took reading a pinned
third-party crate's parser to see it. A fresh-context evaluator is good at noticing
that a claim smells wrong and is not necessarily right about why. Verifying the
verdict is not the same as verifying the reasoning, and the reasoning is what the
next reader inherits.

## Re-evaluation trigger

A fresh pass is warranted once G1 or G3 is mined, because each adds a category
rather than adding inside one. G1 would give the part its second reachability
record and, with G2, its first coherent account of the release-live panic path. G3
would be the part's first property over the three files that own m0 bytes, m1 bytes
and every retention estimate, and its oracle is a different kind of thing from
every oracle now in the part. The corrections above do not warrant one: they
repaired records, resolved one overlap, moved one row on the fault map, and
restructured the presentation, without changing the portfolio's shape or its
record count.

Four other triggers, each firing independently:

- Any resolution of bias 1 that declares multi-writer stores supported. That makes
  the fault map's T4 capability worth building and restores the impact statement
  the single-writer lease currently undercuts. A resolution in the other direction
  fires no trigger but should be written into the eligibility record, because it
  converts a defect into documented conservatism.
- Any resolution of bias 2 that commissions a differential-equivalence property.
  Its oracle would cover the three documented byte-identity claims that have no
  Rust check and, incidentally, most of G3, so it would change what several other
  records are worth.
- Any workflow change that runs any test in this scope. Every `Exercised:` line and
  every `Existing check:` line in this part is written against a suite no
  automation executes, and the day one of them runs, the meaning of "partial"
  changes across all 24 records.
- Any change to `../commons/crates/cortexkit-store` at the sibling path, which this
  repository resolves by path and does not pin, and which CI provisions as a
  metadata-only stub. Bias 1's evidence rests on `:249-281` there, and the fenced
  transaction that defines this part's commit boundary is `:185-231`. Part 3
  recorded this as its bias 1 and it is unresolved; treat every
  `cortexkit-store:NNN` citation as needing re-verification at the start of any
  follow-up pass.
