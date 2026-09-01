# Part 4f portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md`. Its
charter was to expose systematic gaps rather than to agree. Its verdict was
**REFUTED as finished**, and this file records that rather than softening it.

The shape of these findings differs from every sibling's, and the difference is
worth naming up front because it decides what guard would have caught them. 2d's
evaluation found verified mechanisms with assumed consequences. 4c's found checks
that could not fire on their own record's scenario. 2f's found checks that could
only pass or only fail. **4f's found something else again: four cases where a count
or a claim was aggregated across a boundary that changes its meaning.** G1 counted
three unobservable checks alongside twenty-three observable ones. G2 labelled a
record `explicit-config-only` when configuration cannot construct its state. G3
asserted a universal totality result over a domain that includes one unguarded
field. G4 summed defects across three delivery routes into one product-wide figure.
In every case the individual citations were correct — this disposition re-read all
of them and corrected none — and the aggregate was wrong.

That is the most flattering-looking failure mode in this catalog and one of the
more dangerous, because an artifact whose every line checks out reads as verified.
The aggregate is the thing nobody re-derives.

Four lenses: harness fit, coverage balance, implementability, and a wildcard pass
questioning the framing.

Every finding was re-verified against the code before acceptance. **All four
refinements were accepted and applied. None was rejected outright, but one carried
a proposed remedy that verification showed to be factually wrong, and the
alternative remedy the same finding offered was taken instead — with the reason
recorded, because the rejected remedy is the one a reader would expect.**

**A note on this part's starting position, because it changes how the disposition
reads.** `catalog.md` says at `:35-51` that it was rebuilt from `_lenses/` after
the synthesized file was lost, that every record is verbatim from its lens file,
and that "No `portfolio-evaluation.md` exists for this part, so no refinements are
applied and none are claimed". This file is that evaluation, arriving after the
reconstruction rather than before it. So the refinements below land on
reconstructed text, and two of them (G3, G4) correct claims that the lens files
made and the reconstruction faithfully carried. Faithful reconstruction of a wrong
aggregate is still a wrong aggregate, and the disposition does not treat "verbatim
from the lens" as a defence.

Provenance for this pass. Read-only source system
`/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927` ("refactor(shm):
trim final review leftovers"), confirmed with `git log -1`, which is what
`catalog.md` already states. Every line reference below was printed individually at
that commit. Verified for this disposition: `boundary.rs:322-346`, `:348-402`,
`:750-805`; `config.rs:250-279`, `:425-435`, `:620-636`; `scheduler.rs:105-120`,
`:448-462`, `:840-870`; `lib.rs:600-610`, `:4950-4968`, `:16500-16501`,
`:16573-16574`, `:16767-16768`; `codec/opencode.rs:240-270`, `:460-470`;
`caveman.rs:610-651`; `transform.rs:676-700`;
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1355`, `:1398`,
`:2014`, `:2031`; `CONFIGURATION.md:160-172`, `:230-240`. Four greps are
load-bearing and are recorded as facts rather than impressions:
`grep -rn 'ByModel' --include='*.rs'` over the whole tree returns exactly two hits,
both in `scheduler.rs` (`:115`, `:456`); `grep -rn 'commit_cluster\|min_clusters'
crates/mc-module/src/` returns no request field; `historian_timeout_ms`,
`history_budget_percentage`, and `output_reserve` each return TypeScript consumers
under `packages/`; and `tail_size_bar` returns `lib.rs:4982` and `:5002` as its
consumers.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 4 | 4 applied, 1 with its proposed remedy replaced by its own alternative |
| gap | 2 | queued for a follow-up pass with an owner assigned, not mined |
| bias | 1 | requires human judgment |
| upheld | 2 | verified correct and recorded as correct |

Record count **26 to 27**. One record was added by splitting
`dec-a-boundary-budget-derivation-is-total-over-non-finite-input` into the guarded
derivations it does establish and the unguarded passthrough it does not. Nothing
was invalidated and nothing was renamed. Splitting rather than amending was the
right call here and is argued under G3.

Semantics distribution **26 `always`, 0 `always-or-unreached`, 0 `sometimes`,
1 `reachable`, 0 `unreachable`**, against 25/0/0/1/0 before. The new record is
`always(!X)` over a forbidden state with no dedicated detection point, per METHOD's
first check-semantics rule, and the malformed-config record's rewritten check is the
same shape. Three of the twenty-six are now `always(!...)` forms. **The
distributions were not recorded in `catalog.md` at all before this pass**, which
METHOD step 7 requires; they are stated there now, so this is a first statement
rather than a correction.

Types **26 safety, 1 reachability, 0 liveness**, against 25/1/0. The zero in the
liveness column was challenged and is upheld; see below.

Reachability-class labels **16 `default-production`, 7 `explicit-config-only`,
4 `test-only`**, against 16/8/2. Two labels moved, both away from
`explicit-config-only`, and both for the same reason: no configuration can
construct the state. G2 moved the model-walk record; the new trigger-budget record
is `test-only` because production passes `None` and the only `Some` sites are two
test literals.

Fault-map totals **23 non-vacuous today, 4 partial, 0 blocked outright** over 27
records, against **26 non-vacuous, 0 partial, 0 blocked** over 26. The headline
"4f reaches 26 of 26 because its surface is argument-shaped" becomes 23 of 27. The
direction is entirely pessimistic: this disposition found no capability the
synthesis had missed, three oracles it had overcounted, and one new oracle that is
the cheapest falsifying check in the part.

Configuration-contract headline **replaced rather than recounted**. The old figure
was "13 documented keys either do nothing here or disagree with their own
documentation". The new statement is route-scoped: **24 keys parsed by the Rust
config reader with 7 divergent, 2 keys request-supplied, 6 documented keys honoured
only in TypeScript, and 0 truly absent.** G4 explains why the old sum was the wrong
shape rather than the wrong arithmetic.

Test counts are unchanged and were not disputed: 192 in-crate tests reaching full
scope-map 4f, 164 restricted to the brief's named files, zero in CI, zero
integration tests in scope, `codec/sidecar.rs` at zero tests across 339 lines, and
both harness goldens a single case each.

## Refinements applied

Applied in the order the evaluation supplied. G3 and G4 do not interact; G1 and G2
both touch reachability and observability and were applied together so the
distributions could be recomputed once.

### G1. Three of the twenty-six counted checks have no runtime observability, and the 26-of-26 tally was the part's headline

Applied in `catalog.md`: the commit-cluster record's `Check:`, `Required faults`,
`Confidence:`, `Impact:`, and open question are rewritten; the malformed-config
record's `Check:` is replaced with an implementable substitute and a second open
question is added; the decoder-totality record's `Check:` and `Required faults`
lines separate the allocation clause out and downgrade it. In `fault-map.md`: three
map rows move from `Yes` to `Partial`, the totals paragraph is rewritten with the
recount and the reasoning, and the "26 of 26" framing paragraph becomes "23 of 27".

Three unrelated mechanisms, one shared error.

**Commit-trigger inertness needs a non-default config *and* a trigger workload, and
at defaults the configured value equals the hardcoded one.** The record's check is
that the `TriggerContext` built at `lib.rs:4962-4963` carries the *configured*
`enabled` and `min_clusters`. `CONFIGURATION.md:237-238` documents `enabled: true`
and `min_clusters: 3`; `lib.rs:605` and `:607` hardwire `true` and `3`. Both
printed and confirmed. So on a default build a context built from the constants
satisfies "carries the configured value", and the assertion has no content. The
record's `Required faults` line said "none for the divergence itself; it holds on a
default build", and the fault map went further, claiming the assertion "fails with
no fault at all". It does not fail at defaults. Non-vacuity needs a non-default
value — `min_clusters: 2` is what `lib.rs:16500-16501` already uses for the
boundary logic — plus, for the behavioural half, a tail carrying at least that many
commit clusters and one `trigger_budget` of tokens.

**The malformed-config warning has no observable return channel, and the record
asked an oracle to observe it.** The check was: whenever `fs::read_to_string`
succeeds and `serde_json::from_str` fails, the resolution emits a warning naming
the path. `read_tier_cached` (`config.rs:254-266`) is
`fn(&mut TierConfig, PathBuf) -> Option<Value>`. No warnings sink, no `Result`, and
`:261-264` maps the parse error and the read error alike to `None`. By the time
`merge_tiers_with_warnings` builds the warning vector that the sibling clamp
records assert against, an unparseable file and an absent file are the same `None`
and cannot be distinguished. And `emit_warnings` (`:275-279`) only `eprintln!`s,
which the sibling record
`dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller` already
flags as possibly discarded under the daemon host — so even a warning that existed
would not necessarily be observable. The record now asserts the *consequence*
instead: the resolved config equals `McModuleConfig::default()`, which it does, so
the assertion fails on the current build and that is the record's purpose. The
mechanism half becomes a static enumeration of the signature, which needs no
fixture. A second open question is added, because the fix is a signature change
across the config module rather than a missing `eprintln!` — which is why the
original check was not merely unwritten but unwritable.

**The decoder allocation bound needs allocation observation, not one function
call.** The check bundled three clauses: the call returns, the lengths are
consistent, and "allocation is bounded by a constant multiple of input size". The
first two are non-vacuous over an arbitrary `Vec<Value>` and stay so. The third
cannot be witnessed by a decode call: both decoders return
`DecodedHarnessMessages` and expose no allocation accounting, so proving a multiple
of input size needs a counting `#[global_allocator]`, a `dhat`-style profiler, or a
`Vec::capacity` sweep over the returned structure. The tree has none of the three.
The clause is now recorded as discharged by reading — the largest allocations are
`raw_message.clone()` at `codec/opencode.rs:232` and `raw_entry.clone()` at
`codec/pi.rs:114`, one per input message, which the record's `Confidence:` line
already established — and explicitly not counted as an oracle a call satisfies.

**The shared error, named because it is cheap to guard against.** All three counted
a check as observable when the observation channel does not exist: a value
indistinguishable from its own default, a warning with no return path, and an
allocation with no accounting. Constructibility of the *input* was verified in
every case and mistaken for constructibility of the *oracle*. That is a different
failure from 4d's and 4e's, whose demotions were missing fixtures, and it is
cheaper to catch: name the value the oracle reads, and the code path that returns
it to the test.

### G2. The model-walk record is labelled for a route that cannot construct its state, and the evaluator's proposed relabel overstates what exists

Applied in `catalog.md`: the record's `Reachability:` moves from
`explicit-config-only` to `test-only`, its `Exercised:` line moves from `partial` to
`not yet` with the reason, its `Required faults` and `Impact:` lines are amended,
and a disposition note after the record sets out the two halves, the census fact,
and why a second record was considered and rejected. In `fault-map.md`: the first
reachability caveat is rewritten with the census.

The record's check is a *differential*: for every model key and every map,
`config.rs`'s walk and `scheduler::model_key_lookup_order` select the same entry.
Reaching the scheduler side of that comparison with a per-model map requires
`ExecuteThresholdConfig::ByModel` (`scheduler.rs:456-458`). **Configuration cannot
build that variant.** `number_at` (`config.rs:631-636`) is
`value.pointer(p).and_then(Value::as_f64).filter(|v| v.is_finite())` and returns
`None` for an object; the one assignment to `execute_threshold_percentage`
(`:430-432`) consumes that `f64` directly. So an object-form
`execute_threshold_percentage` in a config file is discarded before any enum is
chosen, and `explicit-config-only` asserts precisely the thing that cannot happen.

**Premise verified, remedy replaced — and this is the one place the disposition
departs from what the evaluation asked for, so the reasoning is given in full.**
The evaluation offered two remedies: relabel `test-only`, or split the latent
differential from the production path. Its preferred phrasing was the relabel.
Verification shows the relabel is *factually overstated in the same direction as
the label it replaces*: `grep -rn 'ByModel' --include='*.rs'` over the entire tree
returns exactly two hits, the variant declaration at `scheduler.rs:115` and the
match arm at `:456`. **Nothing constructs `ByModel` anywhere — not production, not
a test, not a fixture.** So "test-only" names a route no test currently takes.

The relabel is nonetheless correct and is applied, because METHOD's three-way
vocabulary labels the *class* of route by which a state can be reached, not the
census of who currently reaches it, and the only reachable route here is a direct
in-crate call: `ExecuteThresholdConfig` is `pub` at `:111` with
`#[serde(untagged)] Deserialize`, while `model_key_lookup_order` at `:849` is
private, so an in-crate `#[cfg(test)]` caller is the whole reachable set. The
overstatement is recorded at the record rather than silently absorbed, because a
reader who takes `test-only` to mean "a test does this" would be wrong.

**The split is recorded in prose and a second record was rejected, with a reason.**
The record bundles two claims of different reachability: (a) the `config.rs` walk
resolves a wildcard-keyed `cache_ttl` map correctly, which genuinely is
`explicit-config-only`; and (b) the two walks agree, which is `test-only` and
unconstructed. The `Guarantee:` and `Check:` are both (b), so (b) governs the
label. A second record for (a) was considered and rejected because it would assert
that one implementation matches an external vector set, which is exactly what
`config.rs:760-785` `cache_ttl_resolution_matches_shared_typescript_vectors`
already does — a record with no gap behind it. Splitting would take the part to 28
for no new obligation.

### G3. The universal floating-point totality claim is false, and the record's own evidence file already said its test fails

Applied in `catalog.md`: the leading "no totality defect was found" paragraph is
rewritten; the budget-derivation record's `Guarantee:`, `Check:`, `Confidence:`,
`Impact:`, and open questions are scoped to the fields it validates; a new record
`dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic`
is added after it and to the index; the Group C heading and preamble go from six
records with one exception to seven with two; the decision-unit table's purity
verdict for the two derivations is qualified; and the relationship map's "a guard
that is also a door" cluster becomes a two-record cluster with the shapes
contrasted. In `fault-map.md`: the budget row is narrowed and a row for the new
record is added. In `existing-checks.md`: a qualification is added to the
profile-independence guard list, which reads as complete and is not.

**The mechanism.** `derive_trigger_budget` (`boundary.rs:338-346`) guards
`context_limit` for `is_finite` and non-positive, and takes
`execute_threshold_percentage.max(0.0)`, so a NaN threshold becomes `0.0` and the
result clamps to `TRIGGER_BUDGET_MIN`. Total.
`derive_protected_tail_token_target` (`:362-402`) guards `context_limit` at
`:363-367`, `execute_threshold_percentage` at `:368-372`, and `usage_percentage`
through `clamp_percentage` at `:376`. **It does not guard `ctx.trigger_budget`**,
which it reads at `:377-379` through `unwrap_or_else` with no check on the `Some`
arm. That is one field out of four, and the odd one out.

**Where the NaN goes, traced precisely, because the two paths differ and only one
propagates.** In `derive_protected_tail_token_target` the NaN is absorbed:
`:383`'s `(trigger_budget + reserve).min((usable * 0.5).floor())` returns the
non-NaN operand, so `headroom`, `ceiling_n`, and `n` all stay finite and the
function's own postcondition survives — but `:399` stores the raw NaN into the
returned struct's `trigger_budget` field. In `check_compartment_trigger_with_index`
the NaN escapes: `:756-761` performs the same unguarded read, `:780-781`'s
`MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE.max(...)` absorbs it for `scan_budget`, and then
`:802`'s `tail_size_bar: trigger_budget * TAIL_SIZE_TRIGGER_MULTIPLIER` is a bare
multiply with nothing to absorb it. `TriggerProgress.tail_size_bar` is NaN.
`TriggerProgress`'s own doc comment at `:322-324` says it is "Surfaced through the
transform response's historian diagnostics so a stalled rig drive is diagnosable
per pass"; it is carried out at `lib.rs:4982` and divided and rounded at `:5002`.
`serde_json` renders a NaN as `null`, so the wire form is an absent number rather
than a visible error.

**The evidence was already written, which is what makes this a disposition rather
than a discovery.** The budget record's evidence file lists this exact case as
test-plan item 4 and states, in its own words, that it "fails today"
(`evidence/dec-a-boundary-budget-derivation-is-total-over-non-finite-input.md:184-187`).
The record turned that into an open question — "It is test-only today, so this is a
latent-hazard question, not a defect" — which is the move the disposition reverses.
A known-failing oracle is a defect with a latent reachability, not a question.

**Why split rather than amend, and why this one is different from G2's rejected
split.** Two reasons, and both are about what a reader does with the record. First
the semantics differ: the guarded half is `always` over an input domain, the
unguarded half is `always(!X)` over a forbidden state, and METHOD gives those
different rules. Second the *status* differs: the guarded half passes today and is
recorded to fix a boundary so a later change is visible, while the unguarded half
fails today. Folding a failing assertion into a record whose stated purpose is
"the guard holds" produces a record that is half true and reads as false, which is
worse than two records. G2's rejected split failed the opposite test: there, both
halves had the same status and one already had a test, so the second record carried
no obligation.

**The leading claim, corrected because of what it was compared against.** The
catalog said "No totality defect was found, unlike the sibling crate in Part 3."
That sentence was doing real work — Part 3 carries **three** such defects, and the
comparison is what made a zero notable — which is exactly why it needed checking
rather than inheriting. It now reads that one defect was found, states which
derivations remain guarded, and says that the defect class is present in shape,
unreachable on the guarded derivations, and reachable on the one unguarded
passthrough. The four Group C guards still hold and are still worth recording.

### G4. The inert-and-divergent count is route-scoped and was framed as a product-wide defect count

Applied in `catalog.md`: the configuration-contract framing paragraph is replaced
with a route-aware matrix and the two errors are named; the five affected rows of
the contract table are rewritten (`protected_tags`, `clear_reasoning_age`, and the
three "absent everywhere" keys), plus the two `commit_cluster_trigger` rows; and
the `### Totals` section is restructured into a documentation-shaped view and a
route-aware view with the old "13" explicitly retired.

**Error 1: two keys called inert are request-supplied.** `protected_tags` and
`clear_reasoning_age` are carried on the transform request and consumed as Rust
request fields. `transform.rs:682-684` declares `protected_tags` as
`#[serde(default = "default_protected_tags")] pub protected_tags: usize` and
`:693-697` declares `clear_reasoning_age` the same way. The TypeScript sender fills
both on two call paths: `rust-mode-transform.ts:1355` and `:2031` for
`protected_tags`, `:1398` and `:2014` for `clear_reasoning_age`. So "parsed
nowhere, with the behaviour hardwired or missing" is false for both; `config.rs`
correctly does not parse them because they do not travel that way. **The catalog
already had this fact and mislabelled the column**: the `clear_reasoning_age` row
read "Present in `mc-module/src` only as a request field, never as a config
pointer" while its verdict column said **No**.

**Error 2: three keys called absent everywhere have workspace consumers.** The
"absent everywhere" bucket was defined as zero occurrences in
`crates/mc-module/src`, and then named as absence. `historian_timeout_ms` is read at
`pi-plugin/src/index.ts:676` and threaded through `:1297`, `:1313`, `:1332`;
`history_budget_percentage` at `:693` and `:1229`; `output_reserve` through
`setOutputReserveConfig` at `pi-plugin/src/config/index.ts:427` and `:600`. Checked
per key. The bucket is empty once the search leaves one crate.

**The replacement, and why the axis matters more than the number.** The matrix cuts
by *which channel carries the key to the Rust reader*: 24 parsed by the Rust config
reader, of which 7 are divergent; 2 request-supplied; 6 documented keys honoured
only in TypeScript, verified per key (the `commit_cluster_trigger` pair is parsed by
`plugin/src/config/schema/magic-context.ts` and consumed by
`pi-plugin/src/context-handler.ts` while Rust hardwires the constants and never
reads either); and 0 truly absent. **This matters more under the Rust-first
decision, which is the reason the evaluation raised it rather than filing it as a
tidy-up.** The request-supplied pair is exactly what the migration must preserve,
because the sender is the component being replaced — and a hardwired Rust constant
standing in for a request field, like `DEFAULT_PROTECTED_TAGS` at `lib.rs:603`, is a
fallback for a missing request field rather than a config gap. The TypeScript-only
six are the class the decision actively threatens: keys that work today only because
a TypeScript component is in the path. Summed into one figure, those two groups look
like the same defect; they are opposite ones.

**What the old number was made of.** 7 real divergences, plus 4 TypeScript-only
keys and 2 request-supplied keys misfiled as inert. The arithmetic was right and the
denominator was three different things.

## What the evaluation upheld, and it is recorded as upheld

A portfolio evaluation that records only faults misrepresents the artifact, so both
upheld findings are stated with the same specificity as the refinements. Both were
independently re-verified for this disposition.

**1. The release-behaviour account is correct, including the counter-intuitive part,
and a prior pass had already corrected it.** The catalog says three `debug_assert!`
sites exist in the 4f production halves, all in `codec/opencode.rs`, and that the
dangerous one is not the obvious one. Verified line by line at `HEAD`. The
out-of-range index at `:251` is `debug_assert!(replace_from <= messages.len())`, and
`:258`'s `&messages[replace_from..]` panics on the same condition in **every**
profile, so the assertion only buys a better message and a violation is loud
everywhere. `:252` is `debug_assert!(replace_from <= prior.order.len())` and **is**
the silent one, because the only consumer of that bound is `:265`'s
`prior.order.iter().take(replace_from)`, and `take` saturates rather than panicking
— so a violated precondition becomes a silently truncated sidecar. The third site,
`:466` inside `assert_unique_tool_use_ids`, has one arm rather than 4e's two, so the
function becomes a no-op in release while `duplicate_tool_use_locations` at `:465`
still runs and its result is discarded. And the supporting negative holds: no
`cfg(not(debug_assertions))` exists anywhere in 4f, so there is no release-arm
counterpart for any of the three. **Two adjacent lines with opposite release
behaviour is the kind of claim that is usually wrong, and this one is right.** It is
recorded as upheld because getting it right required noticing that the *consumer*
of each bound, not the assertion, decides whether the violation is loud.

**2. The zero-liveness position is defensible, and the argument is not "no liveness
record was written".** 4f has 27 records and none is `Type: liveness`, which in most
sub-parts would be a gap. Here it is a property of the subject. `scheduler::decide`
(`scheduler.rs:706-800`) is an immediate pure state transition: it takes
`SchedulerInputs` including `now_ms` as a parameter rather than reading a clock,
returns a `SchedulerOutcome` with `PassDecision` in a closed four-variant enum, and
has no loop, no await, and no progress obligation. There is no `Pending` to justify
and no eventual state to bound, so METHOD's liveness rules — a bounded fault-free
window stated in the units the code bounds — have nothing to attach to. The paging
loop that *would* carry a progress obligation belongs to another sub-part, and 4f
correctly does not reach for it. The semantics distribution says the same thing from
the other side: **zero `sometimes` records across 27**, because an argument-shaped
surface produces obligations over all inputs rather than obligations that an
operational state must occur. So the zero is a consequence of what 4f is, not an
omission, and the catalog's index now says so where a reader will find it.

## Gaps queued for a follow-up pass

Recorded, not mined, and both now have an owner. Both verified for this disposition.

The ownership ambiguity was the actual cause of both gaps and is the thing the
evaluation asked to have removed, so the assignment rule is stated once and applies
to both: **4f owns the decision, the other sub-part owns the application.** Each
record will need a cross-part citation into `transform.rs`; a citation is not shared
ownership. The full entries are in
[existing-checks.md](existing-checks.md#registered-claims-that-no-record-owns).

| # | Gap | Owner | Evidence |
| --- | --- | --- | --- |
| G-a | **The caveman path-independence claim never became a record.** `CONFIGURATION.md:740` claims that when a tag shifts deeper, caveman compresses the *original* text at the new depth rather than the already-cavemaned intermediate, so "repeated tier shifts converge to exactly the same output as direct compression at the final depth". Registered in full at `_lenses/lens-c1-claims-and-config.md:360-378`, mechanism identified, and then no record. | **4f**, because the claim is about what `caveman::compress` returns for a given depth and `caveman.rs` is in 4f's brief-named file set. | The mechanism is real and lives outside 4f: `transform.rs:6339` reads `row.source_bytes` and `:6358` calls `caveman::compress(&source, level)` on the pristine text, with `:6352-6354` refusing a non-increasing depth. The property is asserted nowhere. `caveman.rs`'s only test, `differential_golden_matches_typescript_oracle` (`:626`, extent `:626-650`), replays 42 cases from `caveman-golden.json` against `Lite`, `Full`, and `Ultra` **independently** — verified by reading the body — and never composes two compressions. The claim is load-bearing precisely because `compress` is not idempotent by construction: `apply_ultra_connectives` (`:472`) and `apply_ultra_abbreviations` (`:501`) rewrite words into symbols a second pass would read as different input. So a record needs one oracle over pairs of depths, and the interesting inequality is `compress(compress(t, Lite), Ultra) != compress(t, Ultra)` with the guarantee that the production path never takes the left-hand form. `safety`, direct call, no fault. |
| G-b | **The `smart_drops` byte-equality claim never became a record, and it is the strongest testable statement in the whole configuration document.** `CONFIGURATION.md:763` claims that with the flag off "the messages sent to the model are byte-identical to the age-based-only behavior — the entire feature is inert". Registered at `_lenses/lens-c1-claims-and-config.md:379-384` with `NOT FOUND` as its implementing check. | **4f**, because the claim is about what a flag resolved by `config.rs` does to output and `config.rs` is 4f's. | A single flag flip gives a free differential oracle over the emitted message array, with no fixture beyond two resolutions of one config: the flag defaults `false` (`config.rs:135`) and is settable from either tier (`:467-469`, `:541-543`). Nothing takes it. Note the interaction with `dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list`, which covers *who may set* the flag against `CONFIGURATION.md:767`'s statement that it is intentionally off while cache stability is validated; this gap covers *what the flag does* when unset. The two are complementary and neither subsumes the other. |

## Biases requiring human judgment

1. **Whether 4f's boundary is the crate or the product, because the same fact is a
   defect on one reading and a correct division of labour on the other — and G4
   makes the question unavoidable rather than academic.** The evaluator raised the
   route-scoping as a framing error and this disposition agrees on the facts, but
   the framing question underneath it is not settleable from inside 4f. The
   catalog's scope statement is a file list in one crate, and its search rule for
   "absent" was zero occurrences in `crates/mc-module/src` — a crate-scoped rule
   producing a product-scoped word. Both readings are defensible and each makes a
   different set of findings real. *On the crate reading*, six documented keys that
   the Rust config reader cannot honour is exactly correct as a statement about this
   crate, `commit_cluster_trigger` genuinely is inert **here**, and the TypeScript
   consumers are somebody else's artifact. *On the product reading*, those six keys
   work today and the finding is not that they are broken but that they are
   load-bearing on a component the Rust-first decision removes — which is a
   migration risk register, not a defect list. *Judgment required:* declare which
   boundary the catalog is written against, because it decides three concrete
   things. Whether `dec-a-commit-cluster-trigger-config-is-inert-in-this-crate`'s
   slug is accurate or misleading — the word "inert" is true of the crate and false
   of the product, and the slug was left unchanged only because renaming it would
   break the index, the evidence filename, and two sibling citations. Whether the 8
   TypeScript-side parity claims among the register's 13 `NOT FOUND` entries are
   findings or out of scope, which is the register's dominant shape by the catalog's
   own account. And whether a conformance harness for this part reads
   `CONFIGURATION.md` against `config.rs` alone or against `config.rs` plus the
   request struct plus the TypeScript schema — three very different harnesses. Either
   answer is defensible; leaving it implicit is what produced G4, and it will produce
   G4 again in the next part that shares a documented contract with a TypeScript
   twin.

## Verdict

The evaluator's verdict was **REFUTED as finished**. After applying all four
refinements the part is not finished, and the reason has changed shape: the
overcounted aggregates are corrected, the concealed defect is recorded as a defect,
and what remains is two queued claims, a boundary question nobody has declared, and
a coverage position that no refinement touches.

What improved concretely. The part's two loudest numbers were both wrong in the
optimistic direction and both are now right: 26-of-26 non-vacuous becomes 23-of-27,
and "no totality defect was found" becomes one found, with the guarded derivations
still recorded as guarded. A defect that the part's own evidence file described as
failing is now a record with an `always(!X)` check, `test-only` reachability, and
the cheapest falsifying oracle in the whole part — one struct literal and one call.
Two reachability labels moved off `explicit-config-only` because configuration
cannot construct their states, and one of those relabels carries an explicit note
that the replacement label overstates what exists, so a reader is not misled twice.
The configuration headline is route-aware, which turns a flat 13 into the two groups
the Rust-first migration treats oppositely: 2 request-supplied keys to preserve and
6 TypeScript-only keys at risk. And the distributions METHOD step 7 requires are
recorded in `catalog.md` for the first time.

Ready now for test implementation, in this order. The new trigger-budget record,
because it is one `BoundaryContext` literal with `trigger_budget: Some(f64::NAN)`
and one call, it fails today, and its evidence trail is already written. Then the
four Group C guards plus the determinism record, which are five pure-function
properties over an input domain with no faults and no seams. Then the
table-driven configuration conformance check the relationship map proposes, which
dominates five Group A records at once — now with the route matrix telling it which
three tables it has to read rather than one.

Not ready, for four reasons no further work of this kind resolves. The boundary bias
above is upstream of G4, of one record's slug, and of 8 of the register's 13
`NOT FOUND` entries. Both queued claims need a cross-part citation into
`transform.rs`, which is a different part's file, so writing them means reaching
across a boundary this catalog has otherwise respected. Three of the 27 records are
now `Partial` on observability grounds, and two of those three need a channel that
does not exist — a diagnostic return path in `config.rs`, and allocation accounting
anywhere in the tree. And `codec/sidecar.rs` remains at zero tests across 339 lines
while owning the block identity every downstream decision keys on, which the
evaluation did not dispute and no refinement above touches.

The largest fact about 4f is untouched by every correction and was not disputed:
**192 in-crate tests, none in CI, zero doctests, zero integration tests in scope, and
both harness goldens a single case each with an oracle derived from the test's own
input and one required block class declared missing so the coverage gate passes
without it.** `tests/release_contract_conformance.rs` does not run, while its own
header at `:1-8` argues that its equalities are load-bearing at runtime and that
"the drift must fail the build, not the deployment".

Two process caveats, stated rather than hidden.

**METHOD step 7's three-way equality is broken by one, deliberately.** Records and
index rows both equal 27 and their order matches, and every link resolves. Evidence
files remain **26**, because the record G3 added shares its sibling's evidence file
at `evidence/dec-a-boundary-budget-derivation-is-total-over-non-finite-input.md`.
That is defensible on the merits — the shared file already contains the new record's
entire evidence trail, including the failing-test statement at `:184-187` that the
split acts on — and it follows 2d's precedent of leaving a link resolving rather
than breaking it. It still needs a dedicated evidence file in an evidence pass, and
until then the new record's `Confidence:` line names the shared file explicitly so
the sharing is visible rather than inferred. Separately, four evidence files now
understate their records, because G1 and G4 moved material into `catalog.md` that
`evidence/dec-a-commit-cluster-trigger-config-is-inert-in-this-crate.md`,
`evidence/dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian.md`,
`evidence/codec-b-harness-decoders-accept-every-input-with-no-rejection-channel.md`,
and
`evidence/dec-a-model-key-lookup-walk-has-two-implementations-that-disagree.md`
do not carry. This disposition was scoped to `catalog.md`, `existing-checks.md`, and
`fault-map.md`, and was forbidden from touching `evidence/`, `_lenses/`, source,
tests, or CI.

**[../README.md](../README.md) is now stale in two rows and was not edited**,
because it is outside this disposition's file footprint. Its missing-artifacts table
at `:178` lists 4f as owing `existing-checks.md`, `fault-map.md`, and
`portfolio-evaluation.md`; all three exist, the first two predating this pass and
the third being this file. Its record-count table at `:216` gives 4f as 26 records
with 26 carrying a `Reachability:` line; the correct figures are 27 and 27. Both
need a README pass.

## What this evaluation says about the method

2d's evaluation named the guard "name the producer of the state your consequence
needs". 2f's named "a check must be able to fail and able to pass". Neither would
have caught any of these four, because 4f's records name their producers correctly
and its checks — the twenty-three that survive — can both fail and pass.

**This part's lesson is about aggregates: every count and every universal claim is
a separate assertion from the facts it summarises, and it needs its own
verification.** All four findings are the same error at four scales. G1's 26 was
correct about twenty-three rows and counted three whose oracle channel does not
exist. G2's `explicit-config-only` was correct about the record's cheap half and
wrong about the half the record actually asserts. G3's "no totality defect" was
correct about three guarded fields and wrong about the fourth. G4's 13 was correct
about seven divergences and summed six more across two routes with opposite
consequences. In every case the cited lines check out — this disposition re-read all
of them and corrected none — and in every case re-deriving the aggregate from those
same lines produces a different number.

The guard is one question, asked of every count, every "no X was found", and every
label in a finished artifact: **which of the things I counted does this claim
actually hold for, enumerated one by one?** G1 needed three rows named. G3 needed
four fields named, and `derive_protected_tail_token_target` has exactly four float
inputs, three gated and one not, so the enumeration takes one screen. G4 needed
thirteen keys named and would have split into 7 + 4 + 2 immediately. None of the
four needed new evidence; all four needed the summary re-derived rather than carried.

The second lesson is 4c's, 2d's, and 2f's, recurring for the fifth part in a row,
and G3 is the most literal instance the catalog has produced: **the correction was
already inside the artifact.** Not implied by it, not inferable from it — written in
it, as a sentence, in the record's own evidence file: test-plan item 4, "That case
fails today, which is why the record's open question asks whether the field should
be validated." The evidence file knew. The record turned it into an open question
and the catalog's framing paragraph turned it into a zero. 4c prescribed a
cross-reference pass over the other artifacts for each record's slug; G3 shows the
pass has to include the record's **own** evidence file, and specifically its test
plan, because a test plan that says a case fails is a defect report in the wrong
field.

Third, specific to reconstructed artifacts. `catalog.md` was rebuilt from
`_lenses/` and states that every record is verbatim and that no refinements are
claimed. Both statements are honest and neither is protective. G3's and G4's errors
came through the lens files and were faithfully preserved, and faithful
preservation of a wrong aggregate reproduces it with the reconstruction's
provenance attached — which reads, to the next reader, as corroboration. A
reconstruction should re-derive the aggregates even when it copies the records,
because the aggregates are the part of the artifact that no individual citation
protects.

## Re-evaluation trigger

A fresh pass is warranted once the crate-versus-product boundary bias is resolved,
because either answer changes the record set rather than the record contents. On the
crate reading, the register's 8 TypeScript-side parity claims leave 4f entirely and
the part shrinks to the Rust-parsed route plus the codecs. On the product reading,
they become findings with no owner, the conformance harness has to read three
sources rather than one, and one record's slug is actively misleading.

Four other triggers, each firing independently:

- **Any construction of `ExecuteThresholdConfig::ByModel`, anywhere.** It would be
  the first in the repository. It makes the model-walk differential constructible,
  turns 4b's `sel-per-model-and-token-thresholds-inert-in-module` from latent to
  live, and — because the two walks disagree only on the wildcard step
  (`config.rs:196` has it, `scheduler.rs:849-870` does not) — a wildcard-keyed
  config would resolve differently on the two paths on the day it lands.
- **Any caller that passes `trigger_budget: Some(..)` from production.**
  `lib.rs:4957` passes `None` today and the only `Some` sites are two test literals,
  which is what makes the new record `test-only`. A production `Some` moves it to
  `default-production` and converts a latent defect into an active one, in a
  diagnostic field an operator reads to explain why the historian did not fire.
- **Any Rust-first migration step that removes a TypeScript component from the
  request path.** The route matrix's 2 request-supplied keys and 6 TypeScript-only
  keys are the exposure, and the matrix exists to be re-derived at that moment
  rather than trusted from this commit.
- **Any test added to `codec/sidecar.rs`.** It is the part's quietest area at zero
  tests across 339 lines, every exercise it gets is transitive through the two
  one-case goldens, and `block_is_unchanged` (`:192`) decides whether native extras
  replay verbatim — so a fingerprint that silently collides changes served bytes. The
  day it has a direct test, several `Exercised:` lines across Group F change meaning.
