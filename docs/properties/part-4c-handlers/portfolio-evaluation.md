# Part 4c portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md`. Its
charter was to expose systematic gaps rather than to agree. It produced 19
findings. The shape of them differs again from the two parts before. Part 4a's
evaluation mostly refuted availability claims on the fault map; Part 4b's mostly
refuted claims inside the records themselves. This one did both at once and added a
third category: two records whose stated workload cannot produce the state they
describe, three checks that cannot fail on the very scenario their record is about,
two labels that contradicted a sibling record on an identical code path, one
semantics choice that misused `unreachable`, one headline claim that overstated
what the evidence supports, and one flatly false capability claim that had shaped
the fault map's totals, its blocked-record narrative, and the bottom of its leverage
ranking.

Four lenses: harness fit, coverage balance, implementability, and a wildcard pass
questioning the framing.

Every finding below was re-verified against the code before acceptance. **All 16
refinements were accepted and applied; none was rejected.** Four carried a premise
that was imprecise enough to record, one of them a line range that overshoots by
two lines, because the wrong range would have sent a later reader into a fourth
handler that has nothing to do with the claim.

Provenance for this pass. `HEAD` is `e447c927` ("refactor(shm): trim final review
leftovers"), which is what the three artifacts already state, the working tree is
clean apart from the two artifacts this disposition edits, and every `lib.rs` and
`mc-store/src/lib.rs` reference below was read back individually at that commit.
Two references outside those crates were verified for this disposition:
`crates/mc-module/Cargo.toml:66` (`[dev-dependencies]`) and `:71`
(`mc-store = { workspace = true, features = ["test-support"] }`). One behavioural
fact was verified by execution rather than by reading, and it is load-bearing for
F3: `RAISE(ABORT, ...)` in a `BEFORE INSERT` trigger aborts an `INSERT OR IGNORE`
and an `INSERT ... ON CONFLICT ... DO UPDATE`, so the outer statement's
conflict-resolution clause does not swallow it. Both statement forms appear among
the four writes F3 turns on.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 16 | 16 applied, 4 with a corrected or sharpened premise |
| gap | 3 | queued for a follow-up pass, none mined |
| bias | 2 | require human judgment |

Record count **24 to 25**. Three changes net to plus one: F1 removes one record and
replaces it with prose, F7 splits one record into two, and F13 splits another into
two. No refinement invented a record from nothing; every new record is half of an
existing one whose two halves were provably distinguishable.

Semantics distribution **20 `always`, 2 `always-or-unreached`, 3 `sometimes`, 0
`reachable`, 0 `unreachable`**, against 19/2/2/0/1 before. `always(!X)` is counted
as `always`, following the convention Parts 4a and 4b used. The part now has no
`unreachable` record, which is the correct outcome rather than a loss: F1 established
that its one `unreachable` was not a forbidden code location at all.

Types **19 safety, 3 liveness, 3 reachability**, against 19/2/3 before. Liveness
gains one from the F7 split. Reachability keeps three but they are different three:
it loses the ledger record and gains the second restart marker.

Reachability-class labels **22 `default-production`, 3 `explicit-config-only`, 0
`test-only`**, against 23/1/0 before with one record carrying a mixed label. All
three `explicit-config-only` records are now on `handle_state_import_value` and share
one piece of evidence, which is the state the part should have been in from the
start: F8 corrected a record that claimed `default-production` while its sibling on
the identical dispatch path claimed `explicit-config-only`, and F7's split removed
the mixed label METHOD.md rule 4 forbids.

Fault-map totals **22 non-vacuous today, 3 partial, 0 no**, against 18/3/3 before.
Three rows moved from `No` to `Yes` and one from `Partial` to `Yes` on F3 alone;
one row moved from `Yes` to `Partial` on F2, which is the only movement in the
pessimistic direction and the only new capability request this pass produced.

Test counts are unchanged: 256 test functions in the crate, 69 claim-bearing on 4c,
three integration tests reaching 4c through a real `McHandler`, and none of them
executing in CI. The evaluator disputed no count. It did dispute what two of those
tests cover, in F4, and it was right.

## Refinements applied

Applied in the order the evaluation supplied, because several interact: F1 changes
what Group B's preamble and the relationship map say, F3 changes four records'
availability and the fault map's totals, F7 and F8 both move reachability labels,
and F14 and F15 both edit the prose F1 rewrote.

### F1. The ledger record was not a valid `unreachable`, and is now prose

Applied in `catalog.md`: the record is removed, the index row with it, and the
sub-part prose section "No handler in scope uses the claim intent ledger" is
rewritten as "Architectural note: no handler in scope uses the claim intent
ledger", stating why it is not a record. Group B's preamble drops from three
records to two, the relationship map's identity cluster drops from three to two,
and the cross-part section stops citing the record. `fault-map.md` loses its map
row and the mention in leverage item 2.

The record claimed `unreachable` over `memory_tool::stage_claim_intent`,
`inspect_claim_intents` and `acknowledge_claim_intent`, on the reasoning that
`unreachable` is what METHOD.md reserves for "three specific code locations never
being entered from this scope". Two things are wrong with that. METHOD.md reserves
`unreachable` for a **forbidden** code location, and these locations are not
forbidden by anyone: `handle_facade_value` (`:10042`) dispatches all three method
names at `:10048-10050`, and the handlers they reach are ordinary facade paths that
production traffic is expected to enter. Nothing must never execute them. And what
the record actually asserts is the absence of a *call edge* from one line range to
another, which is static architecture. No execution witnesses it.

**The choice made, and why.** The evaluation offered two options, prose or a
contextual `always` if a checkable condition survives. One does survive: a check
could compare the claim-intent tables before and after each 4c durable request and
assert they are unchanged. It was rejected. That check asserts the status quo, so a
green run means "still not using the ledger", and the day a handler adopted the
ledger the check would fail on the improvement. A property whose passing condition
is the absence of a mechanism someone may reasonably add is not a property, it is a
freeze. The catalog's own text had already conceded the substance: the record's
`Impact` called it "the answer to the lens's second task rather than a defect on
its own", and the relationship map called it "a scoping fact" that "cannot fire on
a per-request defect". A finding that cannot fire is prose. All of its content is
preserved, including the per-handler identity spread and the missing request digest,
and the open question about whether the handlers should adopt the ledger is kept and
still marked as needing human input.

**Premise correction.** The evaluation cited the ledger handlers as `:10082-10184`.
That overshoots by two lines and lands inside a fourth, unrelated function. The
three claim-intent handlers are `handle_claim_intent_stage` (`:10082`),
`handle_claim_intent_inspect` (`:10115`) and `handle_claim_intent_ack` (`:10153`),
the last of which closes at `:10182`; `:10184` opens
`handle_claim_effects_apply`, which is a different facade operation. The original
catalog's `:10082-10182` was right and is kept. The dispatch arms are `:10048-10050`,
also as originally written.

### F2. The state-sync split-state workload cannot produce the split

Applied in `catalog.md` on
`h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together`:
`Exercised`, `Fault/timing angle`, `Required faults`, `Confidence` and a new open
question. In `fault-map.md`: that record's map row moves from `Yes` to `Partial`,
framing point four is qualified, the totals and the blocked-record prose change, and
a new leverage item 11 is added.

The record's window is `:9241` (commit) to `:9288-9291` (capability set), and it
offered two ways in: a lost response followed by a retry, and the existing
`state_sync_before_apply_hook`. Neither works. The hook fires at `:9232-9240`,
**before** the commit, so anything it runs precedes both effects. And the two
effects are synchronous: `:9287` opens the `Ok(result)` arm, `:9288-9291` sets the
capability, `:9292` calls `respond`, with no `await`, no fallible call and no lock
acquisition in between. So the flag is already set before any caller can observe any
response, and a retry cannot split what the first delivery completed.

What survives is narrower and still real: a process kill or panic landing strictly
between those statements. Constructing that deterministically needs a post-commit
hook symmetric with the pre-apply one, which the file does not have. The record now
says so, keeps the fenced-rejection half as the part that is observable today, and
carries an open question about whether the hook should exist. This is the one
refinement that made the portfolio look worse, and it is also the only one that
identified a capability genuinely missing.

### F3. The "missing capability" claim was false, and it had shaped three sections

Applied in `catalog.md` on four records' `Required faults and enabling state`
(recomp, authority prepare, state import commit, dreamer). In `fault-map.md`:
framing point three is rewritten, the H3 row inverts, four map rows change verdict,
the totals change, the blocked-record narrative after the totals is replaced, and
leverage item 10 is demoted from "first on consequence" to a clarity improvement.

The fault map said: "exactly one capability is missing and it blocks exactly one
thing. There is no store-side write-failure injector", and it supported that by
enumerating every `_for_test` and `_hook` in `mc-store`. The enumeration was
complete and one entry was mislabelled. `execute_tag_sql_for_test` was called "the
narrow `execute_tag_sql_for_test` (`:6434`)". Its body, at `:6431-6440`, is
`self.inner.with_conn(|conn| { conn.execute_batch(sql)?; Ok(()) })`. That is an
arbitrary SQL batch, including `CREATE TRIGGER`. It is gated
`#[cfg(any(test, feature = "test-support"))]` at `:6433`, `mc-module` enables that
feature in `[dev-dependencies]` (`Cargo.toml:66`, `:71`), and `mc-module`'s own tests
already call it, at `lib.rs:23768` and `:23795`. The seam is present, enabled, and
in use.

All four writes the map called unreachable are ordinary table writes an aborting
trigger can fail: `mc_authority_route_bindings` (`mc-store:5124-5132`),
`mc_recomp_commands` (`:6816-6822`), `mc_dream_task_commands` (`:6945-6951`),
`mc_state_imports` (`:7180-7190`). Three things were checked before accepting the
route, because any of them could have killed it. `RAISE(ABORT)` is not swallowed by
`INSERT OR IGNORE` or by `ON CONFLICT ... DO UPDATE`, verified by execution against
SQLite, and those are the two statement forms in play.
`bind_authority_route` writes through `with_note_conn_fenced`, which reads as though
it might address a separate notes database; it does not, `:5323-5343` delegates to
the same `inner.with_conn_fenced` and only sets a caller-project scope, so a trigger
installed through the seam is in the same schema. And the seam's own unfenced
`with_conn` is fine for the purpose, because a trigger is schema state rather than a
fenced write.

**Premise sharpening, in the honest direction.** The evaluation said to mark the
records implementable and correct the H3 row, and did not say what the mechanism
costs. Two limits are recorded rather than glossed. The seam is named and documented
for tag-cache SQL, so using it as a general fault injector is off-label and a reader
of such a test has to reconstruct the mechanism; four named failpoints would be
clearer, which is what leverage item 10 now asks for instead of a capability. And a
blanket trigger is coarser than a call site: it cannot select the second of two calls
to the same function. That matters only for `record_recomp_command`, called at
`:6060` and `:6114`, and there it does not bite, because those two calls are on
mutually exclusive branches. Where it would bite, a `WHEN` clause on row content
closes it. Both limits are stated in the H3 row and in the records.

The methodological point is recorded in `fault-map.md` as well, because it is a
repeat: Part 4a's evaluation found absence of a named seam read as absence of the
capability, three times. This is the same error in a harder-to-spot form. The seam
was in the enumeration. It was given an adjective from its doc comment and never
read.

### F4. The guidance no-row path already has a check

Applied in `catalog.md` on
`h4c-guidance-date-returns-success-without-persisting`: `Exercised` and
`Existing check`. Also in the Group A preamble and in the "Two handlers return
success without writing" prose, which both leaned on the path being unobserved. In
`fault-map.md`: the H4a row, that record's map row, and leverage item 2.

The record said "none drives two consecutive CAS conflicts **or a session with no
`row_version`**". The second half is false.
`guidance_get_freezes_hashes_and_advances_only_on_busting_commit` (`:22935`) binds a
second route at `:22991`, never commits a row for that session, dispatches
`guidance.get` at `:22996-23005`, matches a `PreparedOutcome::Response`, and asserts
`store.load("other").unwrap().row_version.is_none()` at `:23008`. That is the
`:7746-7748` arm, driven through the handler, with the assertion made against the
store rather than against the response, which is exactly the oracle the record asks
for. It is even the same test the record cited for something else.

One precision the evaluation did not state, and it decides how much of the record
survives: the existing assertion proves no row exists, not that the response failed
to disclose it. So the record's second clause, that the response says the date is
unpersisted, remains unchecked, and the record keeps that half plus the whole
compare-and-swap window. `Exercised` now names which half is covered and which is
not, rather than claiming neither is.

### F5. The side-channel check did not test the distinction its guarantee claims

Applied in `catalog.md` on
`h4c-side-channel-drain-result-is-discarded-by-the-caller`, and in `fault-map.md` as
a new coverage-check row.

The guarantee promises that attempted and succeeded counts are "distinguished". The
check asserted that when a drain reports `failed > 0`, "some surface reports a
nonzero pending or failed count". A pending count is a backlog depth. It cannot
separate a pass that attempted ten and succeeded zero from one that attempted ten
and succeeded ten, which is the loss the record's `Impact` correctly describes as
"the per-pass rate". So the check could pass while the guarantee failed, on the
existing operator surface, which is presumably why the record's own `Existing check`
line reads as satisfied.

The check now requires that some surface report that drain's `attempted` and
`succeeded` as separate values. The store already computes all three counters per
row, at `mc-store:9572`, `:9575` and `:9581`, so the check compares a surface against
values that exist and are discarded by `let _` at `lib.rs:8252`. A matching coverage
marker, `side_channel_drain_attempted_more_than_it_succeeded`, is added to the fault
map as the precondition, stated as a fact about the drain rather than about the
surface.

### F6. The dreamer check was false on three correct paths, and its duplicate half needs concurrency

Applied in `catalog.md` on `h4c-dreamer-failure-path-ledger-write-is-unchecked`:
`Check`, `Fault/timing angle`, `Required faults`. In `fault-map.md`: that record's
map row, leverage item 4, and a new coverage-check row.

The check read: "after any `dreamer.run_task` response, `load`ing the dream task
command returns a row". Three response paths are supposed to leave no row.
Argument rejection returns before the ledger is touched; the authority gate at
`:9684-9698` returns before it; and the in-flight duplicate guard returns
`dreamer_run_failed` at `:9803-9809` with no write **by design**, which the code
documents at `:9786-9789` as "the loser returns without any ledger write; its retry
replays the winner's recorded response". So the check was false against a correct
implementation on paths the code deliberately built. It is now conditioned on
responses that consumed a model attempt, which is where the obligation actually
lives.

The second half is a harness error the fault map inherited. It called the
duplicate-guard observation "pure H1", two sequential deliveries. That cannot reach
it. The key is inserted into `inflight_dream_commands` at `:9802` and
`DreamCommandGuard` (`:9811-9814`) removes it when the call returns, so a second
delivery beginning after the first has finished never sees the key. Reaching `:9803`
needs two overlapping in-flight calls, which means two tasks and a way to hold the
first inside its run. Both the record and the map row now say concurrency, and
leverage item 4 withdraws the H1 claim.

### F7. The combined reaper record is split in two

Applied in `catalog.md`: `stagelc-seed-and-import-reapers-only-run-on-fresh-traffic`
becomes `stagelc-seed-reaper-only-runs-on-fresh-traffic` and
`stagelc-state-import-reaper-only-runs-on-fresh-traffic`, with two index rows, an
updated Group E preamble, and updated relationship-map clusters. In `fault-map.md`:
two map rows and a rewritten leverage item 5.

The combined record's only cited coverage, `lib.rs:27013-27072`, exercises the
**import** reaper and touches nothing on the seed path, so its `Exercised: partial`
was true of one half and false of the other. It also carried both reachability
classes in a single label, `default-production` for the seed reaper and
`explicit-config-only` for the import reaper, which METHOD.md rule 4 does not allow
and which no mechanical check can validate.

Splitting was chosen over adding a bounded import check to one record, because the
two halves differ in more than coverage. Their reachability classes differ, their
TTLs differ (10 minutes at `:627` versus 5 at `:654`), the mechanism for crossing
the window differs (`state_sync_seed_now` at `:2921` versus `stale_after` at
`:1346`), and their existing coverage differs completely. Each record now names its
own bound, its own clock seam, its own label with its own evidence, and its own
`Existing check`, which for the seed half is honestly "none". The import half's
label also sharpens its impact: the only production sender is a script that runs
once and stops, so "abandoned" and "no further traffic of this kind" are the same
case there.

### F8. A reachability label that contradicted its sibling

Applied in `catalog.md` on
`h4c-state-import-commit-clears-staging-on-every-outcome`, whose label moves from
`default-production` to `explicit-config-only`, and in the preamble's reachability
provenance. Noted in the record's `fault-map.md` row.

Both this record and
`stagelc-state-import-discard-runs-before-the-binding-check` are on
`handle_state_import_value`, reached by the same `state_import` dispatch arm at
`:12279`, whose only shipped-tree sender is
`packages/plugin/scripts/drive-preseed.ts:48`. The sibling record cited that
evidence and labelled itself `explicit-config-only`; this one labelled itself
`default-production` and cited nothing. Two labels for one dispatch path cannot both
be right. The record now carries the sibling's evidence, states that the earlier
label was wrong, and keeps the observation that it is constructible in a test
regardless of the production class.

With F7's split this makes three `explicit-config-only` records, all three on the
same handler and all three sharing one piece of evidence, which is a more legible
state than one exception plus one mixed label.

### F9. The page-map removal check ignored multi-route sessions

Applied in `catalog.md` on
`stagelc-transform-page-session-map-has-no-removal-path`: `Check` and
`Required faults`. In `fault-map.md`: that record's map row, leverage item 3, and a
new coverage-check row.

The check read "after `unbind_route` has run for a session, that session has no
entry in `transform_pages.sessions`". `unbind_route` (`:4232-4256`) computes
`last_session_route` by scanning the remaining bindings for another channel on the
same session (`:4242-4247`) and enters the session-scoped cleanup block only when
none is found (`:4256`). So a session with two bound routes legitimately keeps its
entry after one closes, and the check would fail against a correct implementation.
It is now conditioned on the final binding, which leaves the record's real claim
intact and sharper: even on the last binding,
`discard_transform_pages_for_route` (`:4268`) clears the phase and the `completed`
slot and leaves the key, while the seed coordinator on the adjacent line calls
`evict` (`:4267`), which does `sessions.remove` (`:999-1002`). The workload changes
from "unbind the route" to "unbind every route for that session", and a new marker,
`transform_page_session_had_no_remaining_bindings`, records the precondition.

### F10. The completed-replay check proved neither charging nor expiry

Applied in `catalog.md` on
`stagelc-completed-replay-results-are-uncharged-and-unexpiring`: `Check` and
`Required faults`. Noted in that record's `fault-map.md` row.

The guarantee has two limbs, charged **or** released within a bounded window. The
check asserted that retained result bytes plus phase bytes are at most
`max_staged_bytes`. That proves neither limb. The inequality is satisfied trivially
whenever the retained result is small, and it holds for a coordinator that charges
nothing and expires nothing, which is precisely the state the record documents. The
check now has one conjunct per limb: `total_staged_bytes` is at least the size of the
retained result after a `completed` slot is assigned, or the slot is cleared within
an explicit bounded window. Comparing retained bytes against the charged counter is
what makes the accounting claim falsifiable.

### F11. Two attempts, two commits, still passing

Applied in `catalog.md` on
`stagelc-restart-drops-the-only-page-level-replay-guard`: `Check`. Noted in that
record's `fault-map.md` row.

The check bounded committed cache-state transitions below by acknowledged
final-page responses and above by attempted deliveries. The record's own scenario is
one commit, a lost acknowledgement, and a redrive: two attempts, zero
acknowledgements. Two commits satisfy `0 <= commits <= 2`, so the check cannot fail
on the double-apply it exists to catch. A per-identity ceiling of one is now stated
explicitly as the primary oracle, with the attempted and acknowledged bounds kept as
the cheap screen. That is what METHOD.md's effect-accounting rule already says: the
per-identity check is the primary oracle and the aggregate bounds are the screen. The
record had the sentence and not the assertion.

### F12. A situation marker satisfiable by a different session's bytes

Applied in `catalog.md` on `stagelc-a-coordination-is-observed-mid-sequence`:
conjunct (c). In `fault-map.md`, the compliance review's refinement is marked
applied rather than advised.

Conjunct (c) read `total_staged_bytes`, which is a coordinator-global sum over
every session. With two series in flight, or one abandoned collection left from an
earlier case, it is satisfied by bytes belonging to a session other than the one
under test, so the marker could fire while nothing was genuinely mid-sequence. It
now reads the observed session's own `phase_bytes` (`:1108-1114`). This was the one
refinement the fault map had already identified and recorded as advice; applying it
closes the loop.

### F13. The restart marker let graceful coverage stand in for a crash

Applied in `catalog.md`: `stagelc-a-restart-is-observed-with-staged-state-present`
becomes `stagelc-a-graceful-shutdown-is-observed-with-staged-state-present` and
`stagelc-an-abrupt-restart-is-observed-with-staged-state-present`, with two index
rows, an updated Group H preamble, and updated relationship-map clusters. In
`fault-map.md`: two map rows, the compliance review, and leverage item 6.

Conjunct (c) accepted either `shutdown` returning or a fresh `McHandler` with zero
`total_staged_bytes`. Only the graceful path executes the reset at `:12095-12099`,
and the record's own fault angle said both boundary forms should be covered, so a
campaign that only ever shut down gracefully satisfied the marker and a green run
could not say which boundary was tested. Recording which side the campaign took was
the cheaper option and was rejected, because the two forms are not two ways of
reaching one situation: they run different code, they cost differently (in-process
versus a real process), and each safety record leans on a different one. The design
record is about the reset a graceful shutdown performs; the replay-guard record is
about a crash that loses the acknowledgement and the in-memory guard together. Two
markers say that; one marker with a disjunction hides it.

### F14. The cross-part equivalence claim was too wide by one site

Applied in `catalog.md`, in the "Cross-part relationship" section and in the "Two
handlers return success without writing" prose.

The catalog said three sites share one shape, "a write path that reports success
without persisting". Two of them do. Part 3's `set_claim_intent_transition_tx`
returns `Ok(())` when its `is_lower_hex` guard fails
(`mc-store:4118-4126`, guard at `:4124-4126`, skipped `tx.execute` from `:4127`), and
`guidance_date_for_session` returns `Ok(date_line)` at `:7746-7748` and `:7757-7763`.
Both report success while the implied write did not happen.

`handle_dreamer_run_task` does not. At `:9989-9994` it discards the *result* of a
write, and at `:9995-9998` it returns `PreparedOutcome::Error`. The caller is told
the operation failed. That is a different defect, unchecked persistence on an error
path, and it has a different oracle: for the two success-without-write sites the
oracle is to compare the response against a re-read of the store, whereas for the
dreamer the response already says `error`, so re-reading it proves nothing and the
oracle is to re-read the ledger after a failed run. The section now says both, and
the sentence "this part finds it twice one layer up" is corrected to once. The
dreamer record itself is unchanged; only its membership in the equivalence is.

### F15. The headline contrast is kept and deflated

Applied in `catalog.md`, in the "Two handlers return success without writing" prose
and in the Group A preamble, both of which called this the part's "clearest lesson".

The claim was that the same silent-skip shape is a defect in `guidance_date_for_session`
and a design in `bind_authority_route`, and "the only thing that distinguishes them is
four lines of prose". That reads better than it holds, for two reasons now recorded.
The guidance path is not undocumented-and-unobserved: F4 established that a test
drives it and asserts against the store, so the behaviour is pinned, and a test is a
weaker contract than prose but not nothing. And per METHOD.md rule 3, documentation
does not settle defectness in either direction: `bind_authority_route`'s doc
establishes an obligation, not that the obligation is right, and the missing guidance
doc establishes that nobody wrote one, not that the code is wrong. The contrast is
kept because the asymmetry is real and worth a reader's attention. What replaces the
"clearest lesson" claim is a statement of what is actually unresolved: whether serving
an unpersisted date line to a session with no row is acceptable, and whether the
response should carry a persistence field. Both were already open questions on the
record; the prose now agrees with them instead of pre-empting them.

### F16. The fault map contradicted itself on compare-and-swap exhaustion

Applied in `fault-map.md`: the framing correction, the H4b row, and leverage item 2.

The framing correction at the top of the file already said the right thing, that
"exhausting two compare-and-swap attempts is a seeded-state unit test" is true of
the no-row arm and not of the loop, because the loop reloads at `:7731` each
iteration so a conflicting writer must land between `:7731` and `:7751` twice.
Leverage item 2 then said "Exhausting the guidance handler's silent-success path is
a seeded-state unit test against a session that was never committed", which uses the
verb from the claim being corrected and re-merges the two arms. Both places now use
"the no-row arm" for the free half and reserve "exhausting" for the contention half,
and the framing correction says explicitly that it governs the leverage ranking too.
This is the smallest of the sixteen and worth applying because a reader who trusts
the ranking and skips the framing gets the withdrawn claim.

## Gaps queued for a follow-up pass

Recorded, not mined. Each carries the evidence that makes it a gap rather than a
preference, and each was verified for this disposition.

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | **The paged-transform wire protocol has no property at all, on any of its four obligations.** Nothing in the catalog covers page ordering, digest replay equivalence, exact assembly of the collected pages, or the generation protocol. The asymmetry is the sharpest coverage fact in the sub-part and all three artifacts state half of it without producing a record: the receiver, `handle_transform_page_value` (`:9335-9578`, 244 lines), has **zero** tests on either side, while its TypeScript sender carries nine CI-gated `transform_page_id` assertions in `rust-mode-transform.test.ts` that run on every pull request via `ci.yml:257`. Paging is `default-production` with no config gate (`module-wire.ts:20`, `:1097`, `:1131`; Rust dispatch on field presence at `:7985-7986`). The four obligations are visible in the code and unclaimed by any record: page index monotonicity and the `AttemptMismatch` rejection (`:1197-1199`), the `completed` replay guard's exact `generation` plus `final_digest` comparison (`:9446-9460`), assembly and its failure path (`:9524`), and the `Ack(next_index)` contract (`:1313-1315`). The existing records touch this handler only for staging *lifecycle*: bytes, maps, phases and reapers. Not one of them says the assembled body equals what the sender sent. |
| G2 | **`apply_state_sync_wire`'s sequence fence and rejection arms have no property.** `handle_state_sync_value` delegates to `apply_state_sync_wire` (`:9127-9333`), whose `expected_shadow_seq` fence is the mechanism three other records lean on: the state-sync record cites `AuthoritySeqMismatch` at `:9316-9318` as the reason its second effect can never be retried, the paged-seed replay argument rests on the same fence, and `fault-map.md` lists `state_sync_returned_authority_seq_mismatch` as a coverage marker. No record states the fence's own obligation, that a wire whose `expected_shadow_seq` does not match the stored sequence is rejected without partial application, and no record covers the other rejection arms in that function. The fence is load-bearing for the part's reasoning and is itself unclaimed. |
| G3 | **The authority lifecycle has no transition coverage across prepare, status, and all eleven drain arms.** The dispatcher exposes `authority.prepare` (`:12255`), eleven `authority.drain.*` arms (`:12257-12267`) and `authority.status`, and the catalog holds exactly two authority records, one on `prepare`'s second transaction (`h4c-authority-prepare-route-bind-is-a-second-transaction`) and one on a single drain arm's input trust (`h4c-authority-drain-finish-compares-two-caller-supplied-checksums`). Nothing covers the state machine those arms walk: which transitions are legal from which state, whether the generation advances exactly once per accepted transition, whether an arm applied out of order is rejected rather than partially applied, or whether `authority.status` reports a state consistent with the transitions that landed. `handle_authority_status_value` (`:7134-7167`) is listed in the catalog as a read-only handler "carrying no records", which is a scope statement rather than an argument that its consistency needs none. Eleven arms with two records between them is thin for a durable state machine that gates note evaluation. |

## Biases requiring human judgment

1. **Whether this catalog is risk sampling or owes per-handler coverage, because
   the twelve-plus-twelve split looks quota-driven rather than risk-driven.** Two
   lenses produced exactly twelve records each, the fault map states that split as a
   fact ("twelve from lens A and twelve from lens B"), and Part 4b's evaluation found
   the same catalog family keeping a redundant record explicitly because "the
   commissioning scope fixes the record count at 24". A round number reached twice
   independently is weak evidence of a target being hit rather than a portfolio being
   sized to its subject. The type mix points the same way: after this disposition
   19 of 25 records are safety, with three liveness and three reachability, and the
   three reachability records are all vacuity markers rather than coverage of a
   forbidden or required code point. Set against the subject, fourteen mutating
   handlers, the coverage is uneven in a way the record count hides. `session.flush`,
   `agent_drops.append` and `authority.seed` have no record at all;
   `handle_transform_page_value` has records about its coordinator's memory and none
   about its protocol (G1); the authority drain has one record across eleven arms
   (G3). *Judgment required:* decide what this catalog is for. If it is risk
   sampling, say so in the scope section, and the gaps above are candidates rather
   than debts. If every durable handler owes at least one property, then five
   handlers are missing and the record count should be allowed to move to whatever
   that requires. Either answer is defensible; leaving it implicit means the next
   reader cannot tell a deliberate sample from an incomplete sweep, and the
   twelve-plus-twelve symmetry will keep suggesting the latter.

2. **Whether the guidance handler's no-row path is intentionally ephemeral, which
   must be settled before it is called a defect.** F4 and F15 narrowed the record
   but did not resolve it, and the question is upstream of the record's severity.
   `guidance_date_for_session` returns a date line without persisting it whenever
   `loaded.row_version` is `None` (`:7746-7748`), which `mc-store:5500-5505` produces
   for any session with no row. Two readings fit the code equally well. Either the
   date belongs in `meta.guidance_date` and skipping the write for an uncommitted
   session is an oversight, in which case the fix is to create the row or to report
   the omission in the response. Or a session with no row has no durable state to
   attach a date to, the in-process memo at `:7739-7745` is the intended home until
   the session commits something, and the behaviour is deliberate ephemerality that
   nobody documented. The evidence is genuinely balanced: there is no doc comment on
   the function, which favours neither reading; a test asserts the no-row outcome at
   `:23008`, which suggests somebody considered the state and accepted it, but that
   test's subject is hash freezing rather than persistence, so it may have recorded
   the behaviour incidentally. *Judgment required:* answer the ephemerality question
   first, then the response-field question. If the path is deliberate, the record
   narrows to "the response does not disclose which of the two it did", which is a
   much smaller finding and probably a documentation fix. If it is not, the record
   stands and the compare-and-swap window joins it. METHOD.md rule 3 forbids
   resolving this from the absence of documentation, and rule 2 forbids guessing, so
   it stops here.

## Verdict

The evaluator's verdict was **"not ready"**. After applying all sixteen refinements
the honest answer is still not ready, and the reason has shifted in a specific way:
the portfolio's internal contradictions are largely gone, and what remains is
missing coverage plus two decisions nobody has made.

What improved concretely. Four checks that could not fail on their own record's
scenario now can: the dreamer check no longer demands a ledger row on three paths
the code deliberately leaves empty, the page-map check no longer contradicts
`unbind_route`'s last-binding condition, the completed-replay check compares
retained bytes against the charged counter instead of restating a budget ceiling,
and the restart-replay check caps commits at one per identity instead of permitting
two. Two records no longer describe workloads that cannot produce their state: the
state-sync record now names the post-commit hook it needs rather than pointing at a
pre-commit hook, and the dreamer's duplicate half now asks for concurrency rather
than two sequential calls. One semantics misuse is gone, and with it the part's only
`unreachable`. Two reachability labels now match the dispatch paths they describe,
and no record carries a mixed label. One test that was said not to exist has been
linked, and one that was said to cover something covers half of it. And the fault
map's central capability claim has been withdrawn: three records moved from blocked
to constructible, the count of records blocked outright is zero, and the leverage
ranking's last item changed from "first on consequence" to a readability
improvement.

Ready now for test implementation, in this order. The four records F3 unblocked,
because they are the part's sharpest atomicity findings and the mechanism is a
`CREATE TRIGGER` statement away: recomp's reset-then-ledger window, authority
prepare's transition-then-bind window, the state-import commit's cleared staging,
and the dreamer's unchecked ledger write. Then the two no-fault oracles, sending
`session.delete` twice and reading the guidance response against the store, of which
the second is half-done already. Then the coordinator-internals cluster that
`:18730` already proves inspectable, taking the corrected multi-route workload for
the map-removal record. Then the seed reaper via `state_sync_seed_now`, which is an
unused injectable clock and the half of the split reaper pair with no coverage at
all.

Not ready, for four reasons no further work of this kind resolves. The three queued
gaps are all missing categories rather than missing detail: the paged-transform wire
protocol has no property on any of its four obligations while its sender is
CI-gated (G1), the sequence fence that three records lean on has no property of its
own (G2), and an eleven-arm authority state machine has two records between all of
them (G3). Bias 1 is upstream of the record count itself and cannot be settled from
inside the part. Bias 2 is upstream of one record's severity, and METHOD.md forbids
resolving it from the absence of a doc comment. And above all of it sits the fact
none of these corrections touch: nothing in this scope executes in CI, so every
record improved here is a record in a suite no automation runs, and the H0 item at
the top of the leverage ranking still unblocks zero records while protecting all 25.

One process caveat, stated rather than hidden. METHOD.md step 7 requires records to
equal index rows to equal evidence files. Records and index rows both equal 25 and
their order matches. Evidence files remain at 24 and three are now misnamed or
stale. `h4c-no-handler-in-scope-uses-the-claim-intent-ledger.md` documents a record
that no longer exists; its content is largely preserved in the catalog's
architectural note, and the file should be retired or repointed.
`stagelc-seed-and-import-reapers-only-run-on-fresh-traffic.md` is linked
deliberately by both halves of the F7 split so no link breaks, and needs to become
two files. `stagelc-a-restart-is-observed-with-staged-state-present.md` is linked by
both halves of the F13 split for the same reason, and needs the same treatment. The
affected records say so at their `Confidence:` lines. This disposition was scoped to
`catalog.md` and `fault-map.md` and explicitly forbidden from touching `evidence/`,
`_lenses/`, source, tests, or CI.

## What this evaluation says about the method

Part 4a's evaluation found absence of a named seam read as absence of the
capability, three times. Part 4b's found records whose own fields disagreed with
each other, four times, and prescribed the guard: read each finished record end to
end once, as a single argument, before it ships. This part's evaluation says both
lessons went unlearned, and adds a third.

F3 is Part 4a's lesson exactly, in a form that is harder to catch and therefore
worse. The seam was not missed. It was enumerated, given the adjective "narrow" from
its doc comment, and never opened. One line of its body says `execute_batch(sql)`.
The claim that grew out of that adjective then propagated into the fault map's
totals, its comparative framing against three sibling parts, and the bottom of its
leverage ranking, where it became "last on cost and first on consequence" and shaped
what a reader would do next. **A capability claim needs the body read, not the
signature and the doc comment.**

Part 4b's lesson recurs in F5, F6, F10 and F11: four checks that contradicted their
own record's guarantee, scenario, or cited rule. Two are the same specific error,
a check that cannot fail on the situation the record was written to describe, which
is a sharper test than "read the record as an argument". It is worth promoting to a
question with a yes-or-no answer: *given this record's own Fault/timing angle, can
this check fail?* For the dreamer, the completed-replay slot and the restart replay
guard, the answer was no, and each would have taken one minute to see.

The third pattern is new and is the one worth carrying forward. Five of the sixteen
refinements are cases where the artifacts already contained the correction
somewhere and the record or the summary did not use it. The fault map's framing
correction said the compare-and-swap loop needs contention while its own leverage
ranking said seeded state (F16). The fault map's compliance review had already
written both marker refinements as advice and neither had been applied (F12, F13).
The state-import discard record cited the reachability evidence its sibling on the
same handler lacked (F8). The guidance record cited, for a different purpose, the
very test that covers the arm it called uncovered (F4). Part 4b observed that
"precision does not propagate upward on its own"; this part shows it does not
propagate sideways either. Advice recorded in a review section is not applied,
evidence established for one record is not shared with its sibling, and a citation
made for one purpose is not re-read for another. The cheap guard is a
cross-reference pass before shipping: for each record, grep the other artifacts for
its slug and for the identifiers it cites, and read what comes back.

## Re-evaluation trigger

A fresh pass is warranted once G1 is mined, because it adds a category rather than
adding inside one. The paged-transform wire protocol would be the part's first
property over a message format rather than over a handler's durable effects, its
oracle is a different kind of thing from every oracle now in the part, comparing an
assembled body against what a sender sent, and it is the one place where a CI-gated
TypeScript contract already exists to compare against. G3 fires the same trigger for
a different reason: a state machine's transition coverage would be the part's first
property over a sequence of requests rather than over one or two.

Four other triggers, each firing independently:

- Any resolution of bias 1 that says every durable handler owes a property. That
  changes the record count from a number this disposition preserved to a number
  derived from the subject, and it makes the five uncovered handlers debts rather
  than candidates.
- Any resolution of bias 2. Either answer changes
  `h4c-guidance-date-returns-success-without-persisting`: one narrows it to a
  disclosure gap and probably a doc fix, the other leaves it standing with both
  windows live. It also decides whether F15's deflated framing is the end of that
  discussion or the start of it.
- Any post-commit hook added to `handle_state_sync_value`, or any injectable panic
  on that path. It is the only capability this pass found genuinely missing, and it
  moves the state-sync record from `Partial` to `Yes`, which is the one row F2 moved
  in the pessimistic direction.
- Any workflow change that runs any test in this scope. Every `Exercised:` line and
  every `Existing check:` line in this part is written against a suite no automation
  executes, and the day one of them runs, the meaning of "partial" changes across
  all 25 records. This is the same trigger Part 4b recorded, unresolved, and it
  remains the largest single fact about this part.
