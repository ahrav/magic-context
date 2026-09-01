# Sub-part 2f portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md`. Its
charter was to expose systematic gaps rather than to agree. Its verdict was
**REFUTED as finished**, and this file records that rather than softening it.

The shape of the findings is specific to what this sub-part is. 2d's evaluation
found three cases of a verified mechanism with an assumed consequence. 4c's found
checks that could not fail on their own record's scenario. **This one found
something narrower and, for a sub-part whose main artifact is a map other
sub-parts read, worse: two of the three findings are checks that cannot decide,
and the third is that the map itself is wrong in two rows.** F1 is a check whose
load-bearing half can only pass. F2 is a check that can only fail, and which the
synthesis had already noticed could only fail and declined to fix. F3 is the
construction conditionality map, which four sub-parts cite and which called
production signal wiring future work and an escapable teardown unconditional.

The asymmetry between F1 and F2 is the part worth carrying forward, because they
are the same error in opposite directions. A check that cannot fail and a check
that cannot pass both look like checks and neither is one. Neither would have been
caught by asking "is the mechanism verified" — both mechanisms were verified
correctly, with correct citations — and both are caught immediately by asking
"what observation makes this fail, and what observation makes it pass".

Four lenses: harness fit, coverage balance, implementability, and a wildcard pass
questioning the framing.

Every finding was re-verified against the code before acceptance. **All three
refinements were accepted and applied; none was rejected. One carried a premise
this disposition narrowed, and the narrowing is recorded because it changes how
much of the record survives.**

Provenance for this pass. Read-only source system
`/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927` ("refactor(shm):
trim final review leftovers"), confirmed with `git log -1`, which is what the
three artifacts already state. The working tree is clean apart from untracked
directories. Every line reference below was printed individually at that commit.
References verified for this disposition: `runtime.rs:1-5`, `:340-345`, `:351-365`,
`:375-393`, `:395-417`, `:419-476`, `:920-960`, `:1144-1244`, `:1246-1253`,
`:1255-1297`; `serve.rs:570-637`; `harness_closure.rs:21-32`, `:231`, `:413-479`,
`:491`, `:554`, `:571`, `:826`, `:859`, `:872`, `:897`, `:907`, `:919`, `:928`;
`config.rs:294`; `connection.rs:279`. One grep is load-bearing for F3 and is
recorded as a fact rather than an impression: `serve.rs` installs
`SignalKind::terminate` at `:617-619` and `SignalKind::interrupt` at `:620-622`,
both before `mc_host::run` at `:632`.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 3 | 3 applied, 1 with a narrowed premise |
| gap | 2 | queued for a follow-up pass, not mined |
| bias | 1 | requires human judgment |

Record count **14 to 14**. Nothing was added, nothing was invalidated, and nothing
was renamed. Two record bodies were edited, which breaks the synthesis convention
that record text stays verbatim from lens A; the convention is a synthesis choice,
not a METHOD rule, and F2 is a case where preserving it had already cost a
correction the synthesis knew was needed.

Semantics distribution **11 `always`, 1 `always-or-unreached`, 2 `sometimes`,
0 `reachable`, 0 `unreachable`**, unchanged. F1 might have been expected to move
it, since the record's fast-path half is now explicitly not a check. It does not:
the record's assertable conjunct is `always` and the record keeps that label. The
alternative was to demote the whole record's semantics to describe its weaker
half, which would have understated the half that does decide.

Types **12 safety, 2 reachability, 0 liveness**, unchanged. The zero in the
liveness column is not a distribution artifact; it is gap G1 below.

Reachability-class labels **13 `default-production`, 1 `explicit-config-only`,
0 `test-only`**, unchanged. **This is the answer to the question F3 raises, and it
is stated here as well as in the catalog because the natural inference from "the
map is unreliable" is that the labels resting on it must move.** They do not, and
the reason is structural rather than lucky: METHOD's three reachability classes
encode whether a *configuration or a test* is needed to reach a state, and both of
F3's errors are about *control flow* — who installs the signal handler, and who
keeps polling the future. Neither error touches a config key or a `cfg` gate, and
those are what the labels depend on. Two labels are strengthened in their
justification without moving: see F3.

Fault-map totals **9 non-vacuous today, 4 partial, 1 not constructible**, against
11/3/1 before — reading the pre-disposition text's "2 partial" plus its own
separately-stated blocked row as 11/2/1, which is how it was written. Two rows
moved from `Yes` to `Partial`, both pessimistic, both from F1 and F2. No row
improved. That direction is worth naming: this disposition found no capability the
synthesis had missed, only two oracles it had overcounted.

Test counts are unchanged and were not disputed: 11 in-crate tests across 3,246
lines, 10 in `config.rs` and 1 in `runtime.rs`, zero doctests, zero CI-executed
source-resident checks, and four claim-bearing integration binaries that CI names
none of.

## Refinements applied

Applied in the order the evaluation supplied. F2 and F3 interact: F3's discovery
of `AbandonGuard::drop` supplies the second `force_close_all_routes` call site that
F2's per-branch accounting has to exclude, and both feed quiet area 4.

### F1. The fixed-probe record's load-bearing half is a measurement wearing a check's clothes

Applied in `catalog.md`: the record's `Check:` line is rewritten into two named
conjuncts, its `Fault/timing angle:` and `Required faults` lines are amended to say
which conjunct needs which half of the fixture, its `Confidence:` line is qualified
to distinguish mechanism confidence from implementability, its open question is
restated as a choice between two named bound forms, and the pre-existing synthesis
note on the `:1051-1071` span is updated now that the span is corrected in the
record itself. In `fault-map.md`: the map row moves from `Yes` to `Partial`, and
the coverage-check section's pairing argument is amended to say which conjunct the
marker pairs with.

The record's guarantee is that the probe cadence is "a stated function of the
component-reported activation state rather than an unbounded override of operator
configuration". Its check then asked an oracle to assert the `else` branch and to
"record the number of consecutive iterations that selected 50 ms so a campaign can
bound it". **Recording a number is not a check.** Every observation satisfies it,
so it cannot fail, and a marker that cannot fail cannot witness the property the
record exists for — which is the override, not the non-override.

**Premise narrowed, in the direction that costs the finding something.** The
evaluation said the record "has no pass/fail bound". That is true of the half that
matters and false of the record as a whole: the `else`-branch conjunct is a genuine
pass/fail assertion — `interval == shared.timing.health_interval` whenever
`activation_in_progress` is false — and it is non-vacuous as soon as
`tests/lifecycle.rs:165` stops setting `health_interval` to exactly 50 ms. So the
record is not unfalsifiable; it is half falsifiable, and the falsifiable half is
the one that proves the *absence* of the override rather than its bound. Stating it
as two conjuncts is more useful than stating it as a defect, because it tells an
implementer that one oracle can be written today and the other cannot.

**Why "mark it partial pending a product decision" rather than invent a bound.**
The evaluation offered "define the intended bound or mark it partial". Defining one
would mean choosing a number the code does not contain. The two candidate forms are
now named in the record so the decision is a choice rather than an open field: a
count bound `consecutive_fast_probes <= K`, which needs a `K` that no field of
`HostTiming` and no constant in `runtime.rs` supplies; or a duration bound against
an existing knob, which needs a decision about which knob ought to govern
activation, and `config.rs:216-232` supports none. METHOD rule 2 forbids
fabricating an answer to close an open question, and picking either would be
fabricating one. The honest state is one assertable conjunct plus an instrumented
count reported as a measurement.

**What this costs, stated rather than hidden.** The record can no longer reach
`Exercised: yes` by fixture work alone, and the fault map says so. Its 600-fold
callback-frequency finding is unaffected — that is arithmetic on verified
constants — but the finding is now explicitly a *described* hazard with a partial
oracle rather than a bounded one.

### F2. The forced-shutdown record's bound is the bound of the exit that does the least work, and "floor" is the wrong word for all of it

Applied in `catalog.md`: the record's `Guarantee:`, `Check:`, `Fault/timing
angle:`, `Required faults`, `Confidence:`, `Existing check:`, and `Impact:` lines
are rewritten, a second open question is added, the pre-existing synthesis note
after the record is replaced by a disposition note explaining why the earlier pass
declined the fix, the "Two fixed bounds judge configurable ones" section's second
finding is rewritten with a per-exit table, the lens-reconciliation bullet in the
header is rewritten, and quiet area 3 is amended. In `fault-map.md`: the map row
moves from `Yes` to `Partial`, the `F7` class row's availability verdict is split
into state-availability and oracle-availability, and the totals paragraph is
rewritten.

Three separate errors, and they compound.

**The omission.** `shutdown_sequence` has three exits, not one. The check bounded
"the forced path" at `shutdown_deadline + 2 * lifecycle_callback_deadline`, which
is the bound of the exit at `runtime.rs:1238` — the fatal-latch branch, and the
**only** one of the three that never calls `run_handler_shutdown`, because
`:1234-1238` returns before `:1240`. The other two exits both pay
`run_handler_shutdown`, each under its own fresh
`timeout(lifecycle_callback_deadline, ...)` at `:1276`. So the graceful exit at
`:1243` is `shutdown_deadline + lifecycle_callback_deadline`, the forced exit at
`:1241` is `shutdown_deadline + 3 * lifecycle_callback_deadline`, and the stated
bound belongs to neither. At defaults that is 40 s, 70 s, and 100 s. An oracle
written to the old bound fails on a correct build as soon as the handler callback
takes appreciable time.

**The terminology.** The catalog called the composed total a "floor" in three
places, and the number is a **ceiling** — a sum of per-stage maxima on one branch.
Every stage returns as soon as its awaited future resolves:
`timeout(lifecycle_chain, tracker.wait())` at `:1224` returns the instant the
tracker drains, and `run_handler_shutdown` returns the instant the callback task
joins. Calling 100 s a floor asserts that every forced shutdown takes at least
that long, which is false and is the *opposite* of the defect. The defect is that a
knob documented as 10 s admits a ceiling of roughly ten times that.

**The condition nobody stated, and it is why the ceilings are not guarantees.**
Every bound is a `tokio::time::timeout` or `timeout_at` over a future, and a
timeout cannot preempt a future that does not yield. `run_handler_shutdown` calls
the handler's `shutdown()` through `redact_sync` at `:1273` and awaits at `:1274`;
a callback that blocks its worker thread is never interrupted by `:1276`. The
function's own doc comment says so at `:1256-1258`: the callback "is never aborted:
a deadline overrun trips the fatal latch and returns non-graceful while the
still-tracked task keeps running". The same holds for both `tracker.wait()` calls.
So the honest statement is that the configured deadlines bound the host's *waiting*
and not the host's *lifetime*.

**The consequence for the fixture, which is the finding the fault map most needed
and did not have.** `F7`'s availability row said `tests/lifecycle.rs:678` and
`:714-715` "build the non-yielding-callback shape" and reported that as `Yes`. A
non-yielding callback is precisely the input against which no finite ceiling holds.
So **the one fixture that reaches the forced path is the one that cannot bound
it**, and what no test builds is a callback that is slow *and* yielding, plus a
second variant that drains inside the doubled chain so `:1241` is separable from
`:1238`. That is why the row is now `Partial`: the state is free and the oracle's
input is not.

**Process point, recorded because it is the reusable one.** The synthesis *knew*
this check was wrong. Its own note said an oracle written to the check "would
**fail** on a correct build" and then declined to fix it "because the record text
is preserved verbatim". A convention that preserves a known-broken check is worse
than the drift it prevents, and a disposition pass is where it yields. The
verbatim rule is now qualified in the catalog's grouping preamble, which names the
two records that are no longer verbatim.

### F3. The construction conditionality map is wrong in two rows, and four sub-parts read it

Applied in `catalog.md`: the map's headline is rewritten, rows 19, 24, 25, and 26
are rewritten, row 26 is added, the three conclusions become four, a new subsection
enumerates every dependent claim and its status, the header's "two residuals" item
is rewritten and split, the reachability section's preamble and facts 1 and 2 are
amended, quiet area 3 is amended, and quiet area 4 is added. In
`existing-checks.md`: register row 11 is reclassified, the residuals section is
rewritten, the quiet-areas count goes from three to four, and quiet area 4 is
added. In `fault-map.md`: a closing note records that the table has no fault class
for the newly visible path.

**Error 1: production installs the signal handlers.** The catalog said
`runtime.rs:3-5` was a forward reference to unbuilt work and that "no signal
handling was deleted because none has been written". The crate comment is accurate
about the crate and stale about production. `serve.rs:617-619` installs a `SIGTERM`
stream and `:620-622` a `SIGINT` stream, each failing startup on installation
failure; `:623-631` spawns a task that cancels the `CancellationToken` on the first
of the two; and all of it precedes `mc_host::run` at `:632`. The comment at
`serve.rs:604-616` states why the ordering is mandatory — registering inside the
spawned task would race `run`, and a signal arriving first would take the default
disposition and kill the daemon outright. So the register row moves from "no
implementing code" to "implemented by the caller".

**Error 2: the shutdown sequence is escapable.** The map called
`shutdown_sequence` at `:936` unconditional. It is reached only if the caller polls
`run` past `:934`. If the `run` future is dropped at any point after `:929` — a
supervisor aborting the task, a `select!` arm losing — `AbandonGuard::drop`
(`:419-476`) runs instead: it cancels the token and every generation's three tokens
(`:424-434`), calls `abort_all` (`:435`), demotes the phase (`:442`), then spawns a
detached task running `force_close_all_routes` (`:450`), `tracker.close()`, an
**explicitly unbounded** `tracker.wait()` (`:457`, with the comment at `:452-456`
stating the unboundedness deliberately), `run_handler_shutdown` (`:467`), and a
second unbounded `tracker.wait()` (`:471`). No graceful drain, no connection
Goodbyes, no `shutdown_deadline`, no bound of any kind. **The evidence that this is
a live interleaving rather than a theoretical one was inside the crate the whole
time**: `run_handler_shutdown`'s once-latch comment at `:1260-1264` exists
specifically because "the abandon-path cleanup can fire after a `run` future was
dropped mid-shutdown-sequence".

**The dependent-label answer, which the evaluation asked for explicitly.** Every
claim resting on the map was re-derived rather than assumed. Part 2a's three
`explicit-config-only` liveness records rest on conclusion 3, untouched, and were
re-verified at `config.rs:294`, `connection.rs:279`, `serve.rs:593`. 2b's and 2d's
`RingTransport`-is-unconditional citation is map row 17, above the abandon window
and uncoloured by either error. 2e's citation of "nothing is `cfg`-gated"
(`../part-2e-request-path/catalog.md:406-407`) is conclusion 1, which survives
verification unchanged. **No label moved, in this sub-part or in any of the three
that cite the map.**

Two 2f labels are *strengthened without moving*, which is the only real change.
`rt-a-an-initialized-handler-drains-without-publishing` gives its cheapest entry as
cancelling the shutdown token between `initialize`'s return and the `is_cancelled`
check at `:831`; before this correction that read as a test-only injection, and it
is now an operator `SIGINT` during startup. The same applies to
`rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline`. Both were already
`default-production`, so the distribution is unchanged and only the justification
improves.

One dependent claim is *incomplete rather than wrong*, and it is worth separating
from the two errors. 2e's synthesis note at
`../part-2e-request-path/catalog.md:690-698` cites `shutdown_sequence` calling
`force_close_all_routes` twice and argues its own open question is answerable only
from `runtime.rs:1144-1244`. Every fact it cites is correct. What it could not know
is that there is a **third** call site at `:450` on the drop path, so the census
that question needs covers three sites. Its `medium` confidence and its open
question both stand; this is an addition, not a correction, and it is recorded in
the map's dependent-claims subsection rather than edited into 2e's file.

## Gaps queued for a follow-up pass

Recorded, not mined. Both verified for this disposition.

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | **Shutdown has no bounded fault-free liveness record, in a sub-part whose type distribution is 12 safety, 2 reachability, and zero liveness.** METHOD's liveness rules require a bounded fault-free window stated in the units the code bounds, and shutdown is the one place in 2f where that shape applies: cancel the token, stop the pressure, and assert the host reaches a terminal state within an explicit bound. Fourteen records and none of them states it. The two candidates are different in kind. **On the `shutdown_sequence` path** the bound exists but is per exit, at `shutdown_deadline + k * lifecycle_callback_deadline` for `k` in `{1, 2, 3}` (`runtime.rs:1148`, `:1223-1224`, `:1276`), and the forced-shutdown record now states those as ceilings on *elapsed time* — which is a safety bound on a maximum, not a liveness claim that the terminal state is reached at all. Those are different properties: the safety bound is refuted by taking too long, the liveness claim by never finishing. **On the `AbandonGuard::drop` path there is no bound to state**, because `:457` and `:471` are unbounded `tracker.wait()` calls by explicit design (`:452-456`), and METHOD forbids writing an unbounded "eventually" — so a record here must either bound the wait in some unit the code does not currently use, or record that no finite test can refute the current design, which is itself a finding. Cancellation cleanup is the specific hole: nothing asserts that a cancelled-token teardown reaches a terminal state, releases the instance lock, and runs the handler shutdown callback exactly once across *both* paths, which is what the once-latch at `:1265-1270` exists to arrange. |
| G2 | **`harness_closure.rs` is 1,122 lines and is represented in the catalog by exactly one record, about the reporting of `open`'s failure — and `open` is one function of fifty-odd.** `rt-a-a-closure-store-open-failure-is-classified-not-swallowed` covers `HarnessClosureStore::open` (`:491`) and the classification of its error, and that is the whole of 2f's coverage of the file. Uncatalogued, verified by reading the function inventory at `HEAD`: **manifest validation** (`validate_manifest`, `:231-410`, with `validate_identifier` `:435`, `validate_relative_path` `:447`, `validate_hash` `:463`, and the `require_existing_node` and `require_root` helpers at `:413` and `:423`) enforcing five hard caps (`MAX_MANIFEST_BYTES` 16 MiB, `MAX_NODES` 65,536, `MAX_PATH_BYTES` 4096, `MAX_STRING_BYTES` 1024, `:25-28`) over untrusted input, with `:400`'s `.expect` turning a validation gap into a panic rather than a rejection; **materialization** (`materialize`, `:501`, through `create_temp` `:611`, `stage_candidate` `:626`, `open_source_roots` `:665`, `copy_node` `:687`, `same_file_snapshot` `:753`, `create_parent_dirs` `:764`, `validate_tree` `:784`); **pruning** (`prune`, `:554-609`, alongside `validate` at `:571`); and **filesystem integrity** (`verify_node_file` `:826`, `verify_secure_file` `:859`, `open_relative_file` `:872`, `open_direct_file` `:897`, `open_owned_dir` `:907`, `verify_owned_directory` `:919-925`, plus `verify_safe_ancestor` `:1088` and the sticky-bit and non-regular-file guards at `:29-32`). The file has zero in-crate tests, its one integration binary (`tests/harness_closure.rs`, 15 tests) is named by no CI job, and its two production constructions are `.ok()` in a file outside this crate. This is a security-relevant untrusted-input surface with one record on its front door. |

## Biases requiring human judgment

1. **Whether the closure store is in 2f's scope at all, because the answer decides
   whether G2 is a gap in this sub-part or a whole missing sub-part.** The
   evaluator raised the closure store as under-covered and this disposition agrees,
   but the framing question underneath it is not the evaluator's to settle and is
   not settleable from inside 2f. The facts pull both ways and both are verified.
   *For inclusion:* `harness_closure.rs` is in the scope list at the top of
   `catalog.md`, it is `pub mod` in `lib.rs:18` with no `#[doc(hidden)]`, and it is
   a third of the sub-part's line count. *Against:* the crate never constructs the
   store — zero references to `HarnessClosureStore`, `ClosureCandidate`, or
   `HarnessClosureStore::open` anywhere under `crates/mc-host/src`, which the map
   already records — so every production path through those 1,122 lines begins at
   `serve.rs:162` or `:349`, in `mc-module`, and the one record 2f does have is
   `medium` confidence *precisely because* its call sites are outside the
   footprint. *Judgment required:* decide whether 2f owns the closure store's
   behaviour or only its host-facing surface. If it owns the behaviour, G2 is a
   large gap in this catalog and the sub-part is under-recorded by perhaps six to
   ten records on manifest validation, materialization, pruning, and filesystem
   integrity, none of which is about runtime assembly or configuration — the two
   things the sub-part is named for. If it owns only the surface, then the honest
   statement is that a 1,122-line untrusted-input filesystem module belongs to
   **no sub-part in this catalog**, since the `mc-module` binary pass that would
   own it is unscheduled, and that is a coverage hole at the level of the plan
   rather than of this artifact. Either answer is defensible; leaving it implicit
   means G2 reads as a to-do inside a finished sub-part when it may be a sub-part
   nobody has opened.

## Verdict

The evaluator's verdict was **REFUTED as finished**. After applying all three
refinements the sub-part is not finished, and the reason has changed shape: the two
undecidable checks are now decidable or honestly marked partial, the map is
corrected, and what remains is one missing property type, one under-recorded file,
and a scope question nobody has answered.

What improved concretely. Two of the sub-part's fourteen records had checks that
could not decide, one in each direction, and both now say what they can and cannot
assert. The forced-shutdown bound is stated per exit at 40, 70, and 100 seconds of
configured units instead of as one figure belonging to no exit, the exit that skips
the handler callback is identified, and the ceiling-versus-floor confusion is
corrected in all three places it appeared. The construction conditionality map — the
artifact three sibling sub-parts read for their own labels — no longer calls
production signal wiring future work or an escapable teardown unconditional, and
every dependent claim is enumerated with its status. One whole teardown path,
`AbandonGuard::drop`, went from invisible to recorded as a quiet area in two
artifacts. And the fault map's `F7` capability claim is split into state
availability and oracle availability, which is what turns "the fixture exists" into
"the fixture exists and cannot measure the thing".

Ready now for test implementation, in this order. The three Group A records, whose
oracles are an assertion battery at `runtime.rs:882` plus a pure-function sweep
over `validate`, all constructible today from `tests/handler_contract.rs` fixtures
that exist. Then the fixed-probe record's **first** conjunct, which needs only the
`tests/lifecycle.rs:165` value change away from 50 ms. Then the pre-publication
drain record, whose cheapest entry is a test handler that cancels the shutdown token
inside its own `initialize`, and which F3 has now shown to have a production
producer as well.

Not ready, for four reasons no further work of this kind resolves. The fast-probe
bound is a product decision, and until it is made the record's load-bearing half is
a measurement. The forced-shutdown record needs a fixture nobody has written — slow
and yielding, in two variants — and its ceilings are conditional on cooperative
cancellability in a way `config.rs` documents nowhere. G1 is a missing property
type rather than a missing detail, and on the abandon path there may be no bound to
state, which is itself the finding. And the scope bias above sits upstream of G2:
until it is answered, nobody can say whether this sub-part is fourteen records
short of nothing or ten records short of a security surface.

The largest fact about 2f is untouched by every correction above and was not
disputed: **11 in-crate tests reach 3,246 lines, none of them executes in any CI
job, there are zero doctests, and CI names none of the four integration binaries
that carry this sub-part's claims** — while `ci.yml:190` runs
`cargo test -p mc-host --doc` and `config.rs`, `harness_closure.rs`, and `lib.rs`
are all `pub mod`, so a doctest added to any 2f file would execute today. For a
sub-part whose entire configuration contract is doc comments, the one CI lane it
could reach is the one it does not use.

One process caveat, stated rather than hidden. METHOD step 7 requires records to
equal index rows to equal evidence files. Records and index rows both equal 14 and
their order matches; evidence files remain 14 and every link resolves. But **two
evidence files now understate their records**, because F1 and F2 moved material
into the catalog that `evidence/rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval.md`
and `evidence/rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline.md`
do not carry: the two-conjunct split and the two candidate bound forms in the first
case, and the three-exit table, the non-yielding-callback condition, and the
ceiling-versus-floor correction in the second. This disposition was scoped to
`catalog.md`, `existing-checks.md`, and `fault-map.md`, and was forbidden from
touching `evidence/`, `_lenses/`, source, tests, or CI. A second, smaller caveat:
[../README.md](../README.md) lists this sub-part as owing
`portfolio-evaluation.md`, which this file discharges, and its per-part record
count of 14 is still correct; neither line was edited, because README is outside
this disposition's file footprint.

## What this evaluation says about the method

2d's evaluation named the guard "for this record's stated consequence, what code
produces the state it needs? Name the producer." That guard would not have caught
any of these three. F1's and F2's producers exist and were correctly identified;
F3's error was in the opposite place, a producer that exists in production and was
recorded as absent.

**This part's lesson is about checks rather than about consequences: a check must
be able to fail and able to pass, and neither is implied by the mechanism being
verified.** F1's check can only pass, because recording a count satisfies itself.
F2's check can only fail, because its bound omits a stage that runs on two of three
exits. In both cases the mechanism reading was correct, the citations were right,
and the arithmetic in F2's case was right to within the stage it forgot. The guard
is a two-part question with two concrete answers, asked of every `Check:` line
before the record ships: *what observation makes this fail on a defective build, and
what observation makes it pass on a correct one?* A check that cannot answer both is
a description.

The second lesson is 4c's and 2d's, recurring for the fourth part in a row, and F2
is the sharpest instance yet: **the correction was already inside the artifact.**
Not merely implied by it — *written in it*. The synthesis note after the
forced-shutdown record said in as many words that an oracle written to the check
"would **fail** on a correct build", and then declined to act on the grounds that
record text is preserved verbatim. The information was not missing, the inference
was not missing, and the conclusion was not missing. What was missing was
permission to edit. So the prescription is narrower than the earlier parts'
cross-reference pass, and it is procedural rather than analytical: **when a
synthesis note contradicts the record it annotates, the note wins and the record
gets edited.** A convention that preserves provenance at the cost of shipping a
check known to be wrong has inverted its own purpose.

Third, and specific to artifacts that other artifacts read: **an artifact cited by
four sub-parts needs its rows verified at the same standard as a record's `Check:`
line, and the construction conditionality map's were not.** Rows 24 and 25 said
"Unconditional" where the correct answer required asking who polls the future, a
question the rest of the map never has to ask because rows 1 through 18 all run
inside a single synchronous startup path. The row that changed character got the
verdict of the rows that did not. The mitigation is cheap: for any row asserting
"unconditional", name the thing that would make it not run, and check that the
answer is "nothing" rather than "nothing I looked for".

## Re-evaluation trigger

A fresh pass is warranted once the closure-store scope bias is resolved, because
either answer changes the record set rather than the record contents. If 2f owns
the closure store's behaviour, the sub-part gains six to ten records on a surface
with zero in-crate tests and the catalog's shape changes from configuration to
configuration-plus-filesystem-security. If it does not, the honest output is a
note that the file belongs to no scheduled pass.

Four other triggers, each firing independently:

- **Any resolution of the fast-cadence bound question.** It converts F1's second
  conjunct from a measurement into a check, moves the fixed-probe record's fault-map
  row from `Partial` back to `Yes`, and is the only one of these triggers that
  needs a decision rather than code.
- **Any record written against `AbandonGuard::drop`.** It would be the sub-part's
  first property over a teardown path that honours no configured deadline, and
  METHOD's prohibition on unbounded "eventually" means writing it forces the
  question of what unit bounds `:457` and `:471` — which is a design question the
  code currently answers with "nothing, deliberately".
- **Any fixture that builds a slow-but-yielding lifecycle callback.** It is the
  input the forced-shutdown record's three ceilings are conditional on, it separates
  the `:1241` exit from the `:1238` one, and it unblocks the only stopwatch oracle
  in the sub-part.
- **Any workflow change that runs the `mc-host` lib target or adds one doctest to a
  2f file.** Every `Exercised:` line here is written against checks no automation
  executes, and `config.rs` could reach CI today through a lane that already runs.
  This is the same trigger 2b, 2d, and 4c recorded, unresolved, and it remains the
  largest single fact about this sub-part.
