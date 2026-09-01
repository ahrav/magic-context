# Part 4d portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md`. Its
charter was to expose systematic gaps rather than to agree. It produced 16
findings, and their centre of gravity is different from every part before it.
Part 4a's evaluation mostly refuted availability claims on the fault map. Part 4b's
mostly refuted claims inside the records. Part 4c's did both and added records whose
stated workload could not produce their state. This one is dominated by a fourth
category: **five oracles that pass while the defect they were written for is
present.** That is the highest-value class of finding this method produces, because
such a check does not merely fail to help, it manufactures false confidence. A
missing test is visibly missing. A green check over a live defect is not.

The remaining findings split into two overstated coverage claims, one inverted
polarity between two records that contradicted each other, one unfalsifiable bound,
one misattributed root cause, one anonymous marker, and one summary bucket that hid
an order-of-magnitude spread in orchestration cost.

Four lenses: harness fit, coverage balance, implementability, and a wildcard pass
questioning the framing.

Every finding below was re-verified against the code before acceptance. **All 13
refinements were accepted and applied; none was rejected.** Three came back
stronger than the evaluation stated them, and those strengthenings are recorded
rather than silently folded in, because in each case the evaluation's version would
have left a reader with a claim that is still partly wrong.

Provenance for this pass. `HEAD` is `e447c927` ("refactor(shm): trim final review
leftovers"), which is what the three artifacts already state, and the working tree
is clean apart from the four artifacts this disposition writes. Every `lib.rs`,
`mc-store/src/lib.rs`, `dispatch.rs`, `smart_note_evaluation.rs`, and
`packages/plugin` reference below was read back individually at that commit. Six
references outside the artifacts' existing citations were established for this
disposition and are load-bearing: `enforce_request_byte_cap` at `lib.rs:14375-14390`
including its 32 MiB refusal arm at `:14382-14388`; the full text of
`smart_note_evaluation.rs:8-10` including the parenthetical the catalog had truncated
away; `reduce_fallback`'s two arms at `:636-657`; the inline `deliver` closure at
`module-state-sync.test.ts:1405-1415`; `class DeterministicClaimMirrorFacade` opening
at `module-state-sync.test.ts:1444`; and `decodeClaimEffectDeliveryResponse` at
`module-wire.ts:717-735` together with the fact that it has zero test references
anywhere in `packages/plugin`.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 13 | 13 applied, 3 with a strengthened premise |
| gap | 2 | queued for a follow-up pass, neither mined |
| bias | 2 | require human judgment, one of them cross-part |

Record count **24 to 25**. One change accounts for it: D11 splits the claim-effects
record into a module-local half and a cross-language half. No refinement invented a
record from nothing, and no record was removed. The new record is one half of an
existing record whose two halves were provably distinguishable, by exactly the test
that matters here: one half is constructible today with one call and a store read,
and the other is the only record in the part that no harness can reach.

Semantics distribution **22 `always`, 1 `always-or-unreached`, 2 `sometimes`, 0
`reachable`, 0 `unreachable`**, against 21/1/2/0/0 before. The single change is the
new record's `always`. `always(!X)` is counted as `always`, following the convention
Parts 4a through 4c used. The part has no `reachable` and no `unreachable` record,
which is correct rather than a gap: nothing in this scope is a forbidden code
location, and both coverage records are situation coverage rather than location
coverage, which is the distinction METHOD.md's second coverage rule exists to force.

Types **23 safety, 0 liveness, 2 reachability**, against 22/0/2 before. **The zero
is the subject of bias 1 and is not a rounding artifact.** Every substantive record
in this part is a safety property or a coverage marker. Nothing anywhere in the
catalog says that finite eligible work is eventually claimed.

Reachability-class labels **25 `default-production`, 0 `explicit-config-only`, 0
`test-only`**, unchanged in kind from 24/0/0 because the new record inherits the
label and the evidence of the record it was split from. No record carries a mixed
label, which METHOD.md rule 4 forbids.

Fault-map totals **23 non-vacuous today, 1 partial, 1 blocked outright**, against
22/2/0 before. Two rows moved and neither movement is a change in the world. The
claim-effects row moved from `Partial` to `Yes` because the unconstructible half
left it, and that half became the part's one outright block. The previous `Partial`
was the less honest presentation: it let a reader believe one record was half-done,
when in fact one obligation was free and a different one was impossible.

Test counts are unchanged: 102 in-crate checks in scope, 10 in
`tests/prepared_output.rs`, and none of the 112 executing in CI. The evaluator
disputed no count. It disputed what several of those tests cover, in D10 and D13,
and it was right both times.

## Refinements applied

Applied in dependency order rather than the order supplied, because several
interact. D13 changes what the schema-comment claim supports, which D4 then builds
the polarity split on; D3 constrains the oracles of the two records D4 touches; D10
rewrites prose in all three artifacts that D11 then splits a record inside; and D12
changes the fault map's leverage ranking that D1 re-orders.

### D1. The fault map's "no-fault" bucket hid real orchestration

Applied in `fault-map.md`: framing point two is rewritten around a four-axis
decomposition, every one of the map's 25 rows gains an **Orchestration** column
reading `setup · calls · store read · harness`, the leverage ranking's preamble
replaces "fourteen of the 24 records" with a three-band table, and item 2 lists its
eleven records in ascending orchestration cost instead of as an undifferentiated
set.

The old text said "most of this part's findings need no fault at all ... fourteen of
the 24 records need nothing beyond ordinary state and one or two calls", and left it
there. The claim is true and useless at that granularity, because the records inside
the bucket differ by a factor of four in call count and by more than that in setup.
Four axes are now separated, and they are separated because they bind differently: a
test's **setup** decides how much fixture it needs, its **call count** decides
whether it is a single request or an ordered sequence, its **store read** decides
whether the oracle is portable past the facade response, and **missing harness**
decides whether it exists at all. Folding the last into the first three is what let
one impossible obligation sit inside a bucket labelled cheap.

Three specific undercounts were verified and corrected. **Route identity needs two
bindings and three calls.** The map said "two bound routes and one request", but the
record's guarantee covers both a cross-route read and a cross-route transition, so
the sequence is `claim.intent.stage` on route A, then `claim.intent.inspect` on route
B, then `claim.intent.ack` on route B. One request can observe at most half the
guarantee. **Dismissal needs four calls.** The map said three, listing dismiss, read,
and update, and omitted the create. The create is not setup: it is the call that
establishes the pre-dismissal content that the read half asserts is a prefix of the
post-dismissal content, so without it the record's first conjunct has no baseline.
**Full claim-effects composition needs the absent end-to-end harness,** which is now
its own record precisely so the module-local half's genuine cheapness stops implying
that the composition is cheap too.

### D2. The byte-cap equivalence quantified over bodies the router is right to refuse

Applied in `catalog.md` on
`facade-a-transform-class-byte-cap-probe-diverges-from-the-router`: `Exercised`,
`Guarantee`, `Check`, and `Required faults`. In `fault-map.md`: that record's map
row and its entry in leverage item 2.

The check asserted, for every body over `MAX_FACADE_FRAME_BYTES`, that
`enforce_request_byte_cap` admits it if and only if the router would select the
transform or state-sync arm. Read at `HEAD`, `enforce_request_byte_cap`
(`lib.rs:14375-14390`) has three outcomes, not two. Under 1 MiB it admits
everything (`:14376-14378`). Between 1 MiB and 32 MiB it admits transform-class
bodies (`:14382-14385`). **Above 32 MiB it refuses a transform-class body**, with
"request body exceeds the 32 MiB transform limit" (`:14386-14388`). So for a 40 MiB
body carrying `kind: "transform"`, the router would select the transform arm and the
cap correctly refuses it, and the biconditional as written is false against an
implementation doing exactly the right thing.

The fix is a range restriction, not a rewrite: the equivalence now holds over bodies
strictly above `MAX_FACADE_FRAME_BYTES` and at most `MAX_TRANSFORM_FRAME_BYTES`, and
bodies above the transform ceiling are out of scope in both directions. That band is
also where the record's actual finding lives, because it is the only band where the
probe's field choice and the router's field acceptance can disagree about a body
either would otherwise admit. The map row now says so too, so a reader who writes
the test from the fault map rather than the catalog does not reach for a 40 MiB
fixture and conclude the property is violated.

### D3. Two byte-comparison oracles could not be two sequential mutating calls

Applied in `catalog.md` on
`facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic` and
`facade-a-reduced-summary-envelope-is-an-unvalidated-argument-source`: `Check` on
both, plus the shared harness note in the relationship map's open-argument cluster.
In `fault-map.md`: both map rows.

Both records asked for a differential: send a call, send it again perturbed, compare
the responses byte for byte. On a read-only tool that works. On a mutating tool it
cannot, for two independent reasons that both had to be checked because either alone
would sink it.

First, the store mints identifiers. `ctx_note`'s plain-write arm calls `insert_note`
inside the ledger closure and formats the returned id into the response text:
`format!("Saved session note #{}.", note.id)` at `lib.rs:11704`, with the insert at
`:11690-11702`. Two sequential writes therefore differ in the response body by
construction, with no defect present.

Second, replay adds a field. If the two calls carry the same `command_id`, the second
does not execute at all: `facade_command_outcome`'s `Duplicate` arm re-parses the
stored envelope and inserts `"replayed": true` before responding
(`:15298-15306`, the insert at `:15303`). So the second response is structurally one
field larger than the first, again with no defect present.

Both records now specify the comparison level rather than the comparison operator.
Either drive the two calls against two independently cloned stores seeded to the same
state, or compare at the parser level, which for the reduced-envelope record is
strictly better anyway: asserting that the two argument maps `facade_arguments`
returns are equal tests the unwrap directly and never touches a store. The
`command_id` constraint is stated explicitly as well, because it is the kind of thing
a test author adds for realism and thereby breaks the oracle: a `command_id` must be
absent from both calls or differ between them.

### D4. The open-key record had inverted polarity and contradicted its sibling

Applied in `catalog.md` on
`facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic`
(`Exercised`, `Guarantee`, `Check`, `Existing check`, `Impact`) and on
`facade-a-misspelled-surface-condition-silently-writes-a-plain-note` (`Guarantee`,
`Check`), plus the Group A preamble, the "Facade validation is not uniform" section,
and the relationship map's open-argument cluster. In `fault-map.md`: both map rows
and the `FACADE_OPEN_SCHEMA_TOOL_RECEIVED_AN_UNKNOWN_KEY` marker row.

The open-key record guaranteed that an unread argument key "never changes the
handler's behaviour and never produces a caller-visible diagnostic", and its check
asserted a byte-identical response. The misspelled-condition record guaranteed that a
conditioned write "never reports plain-note success", and its check asserted the
response is *not* the plain success text. Both are about a key the handler does not
read. One says silence is correct and asserts it. The other says silence is the
defect and asserts against it. Run together on a `ctx_note` write carrying
`surfaceCondition`, they contradict: the first passes only if the response is
unchanged, the second passes only if it is changed.

The resolution is the line the code itself draws, and it is a real line rather than a
compromise. A key that resembles nothing the handler reads is a **compatibility
key**. Serving it silently is the advertised posture — `additionalProperties: true`
on four schemas at `lib.rs:15846`, `:15929`, `:15950`, `:15963` — and the correct
diagnostic is none. A key within one edit, one case change, or one separator change
of a key the handler does read is a **typo**. Nothing advertises tolerance for it, no
test pins it, and the correct diagnostic is one that names it. The open-key record's
check now carries the edit-distance exclusion, the misspelling record's check now
demands a diagnostic that names the unread key, and both records state which
diagnostic they expect so a later reader cannot re-merge them. The coverage marker
`FACADE_OPEN_SCHEMA_TOOL_RECEIVED_AN_UNKNOWN_KEY` gained the same exclusion, so it
stays disjoint from
`CTX_NOTE_WRITE_CARRIED_A_CONDITION_KEY_THE_HANDLER_DID_NOT_READ`.

### D5. The `ctx_reduce` oracle passed the harmful case

Applied in `catalog.md` on
`facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes`: `Guarantee` and `Check`.
In `fault-map.md`: that record's map row.

This is the sharpest of the five oracle findings, because the failed oracle was
derived from a METHOD.md rule and therefore looked principled. The check asserted
`acknowledged_queued <= observed_pending_drops <= ctx_reduce_reported_queued`, citing
the effect-accounting rule for paths where a delivering message can be lost.

The rule is right and the quantity is wrong. `handle_ctx_reduce_facade` performs only
reads and answers `mcp_text_result(format!("Queued: {}.", ...), false)` at
`lib.rs:10587`, under a comment at `:10585-10586` stating that the acknowledgement
"deliberately does not mutate" durable tag state. So `observed_pending_drops` is 0.
And in the scenario the record's own `Fault/timing angle` names — the response
observer never fires, so the gap is permanent — `acknowledged_queued` is 0 as well.
The assertion collapses to `0 <= 0 <= reported`, which holds for every reported
count. The precise case the record exists to catch is the case that satisfies it
most comfortably.

Why the rule misfired is worth recording, because the same trap is available on
several other records in this part. Effect accounting bounds observed effects between
the acknowledged and the attempted count. It is a screen on a path that *attempts* an
effect. This handler attempts none, so both bounds are zero and the screen constrains
nothing. The defect is not a lost effect at all; it is that a caller cannot tell an
acknowledgement from a delivery. The oracle is therefore a statement about what the
response discloses: for every response reporting at least one tag as queued or
deferred, the response must carry a field distinguishing accepted-pending-delivery
from queued, and a caller reading only that field must never conclude an effect
landed while `load_pending_agent_drops` for that session is empty. That assertion
fails today, which is the point.

### D6. The cursor `sometimes` record had no marker name

Applied in `catalog.md` on `note-b-cursor-exhausted-no-work-occurs-in-a-campaign`:
`Check`, plus the relationship map's situation-coverage cluster. In `fault-map.md`:
the compliance review's second bullet moves from advice to applied.

METHOD.md requires marker names to be constant and globally unique and never
constructed dynamically. The record stated its condition in prose and named nothing,
while its sibling supplied `FACADE_MUTATION_REPLAY_OBSERVED`. The marker is now
`NOTE_CYCLE_EXHAUSTED_NO_WORK_OBSERVED`, checked for uniqueness against both the
sibling record and the fault map's 29-row coverage table.

The smallest of the thirteen, and worth recording for a reason beyond its size:
`fault-map.md`'s own compliance review had **already identified this exact gap** and
written it as a refinement, and it had not been applied. That is the same failure a
sibling part's evaluation named, advice recorded in a review section not propagating
into the record it concerns. Part 4c's evaluation found five instances of it. This
part has at least two, counting D13, where a test comment's actual content was
available to the record that cited the comment.

### D7. The policy-version record mixed runtime behaviour with unobservable documentation state

Applied in `catalog.md` on `note-b-registered-policy-version-never-reaches-selection`:
`Guarantee`, `Check`, and a new open question. In `fault-map.md`: that record's map
row.

The check read: assert that for two registrations differing only in `policy_version`
the set of notes each is offered is identical, "and that this is the documented
contract". The second conjunct is not a runtime state. No harness can evaluate it,
because deciding it requires judging whether a doc comment exists and says something
adequate, which is a review outcome. A check that cannot be evaluated is worse than a
missing check, because it will be marked done when the runnable half passes.

The runtime half is kept verbatim and is a good oracle: the field is validated at
`lib.rs:10916-10919`, stored at `:10964`, bumped at `:11045`, echoed at `:11050`, and
read nowhere else, while selection compares the *note's* version
(`smart_note_evaluation.rs:723`, `:749`, `:773`), so changing the registered value
changes nothing observable. The documentation judgment became an open question marked
as needing human input, alongside the record's existing question about whether the
field is reserved or vestigial. Both now sit where METHOD.md puts decisions, and the
`Guarantee` line no longer promises something the `Check` cannot deliver.

### D8. The unbounded-candidate record declared no bound, so nothing could refute it

Applied in `catalog.md` on
`note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll`:
`Guarantee`, `Check`, and a new open question. In `fault-map.md`: that record's map
row, leverage item 6, the `SMART_NOTE_PENDING_SET_EXCEEDED_ITS_POLL_MATERIALIZATION_THRESHOLD`
marker row, one new marker row, and a new product-decision bullet.

The check asserted that the rows returned and the snapshots built per poll "are both
bounded by a declared constant". There is no such constant. Verified at `HEAD`: the
candidate query ends `ORDER BY id` with no `LIMIT` (`mc-store:13291-13301`), neither
`insert_note` (`:10130-10164`) nor `insert_project_note` (`:10166-10200`) counts
rows, and no reaper deletes notes by age or volume. A check against a constant the
product has never chosen cannot be written down, which means no finite workload could
refute the record. That is a different failure from D5's: D5's oracle could run and
always passed, this one could not be run at all.

Two exits were available and the evaluation offered both. Obtaining a product bound
is the better answer and is now the open question: pick a per-poll candidate ceiling,
add a `LIMIT`, and this becomes an ordinary `always` against a named constant. Until
someone picks that number the record needs an oracle that works today, so it is
restated as an explicit scaling relation: seed N and 2N pending notes into two
identically prepared projects, poll each, and assert that rows returned and snapshots
built are N and 2N. That is refutable in both directions. A superlinear result
refutes it, and so does a fix that makes growth sublinear, at which point the record
should be restated against whatever bound the fix introduced. The cost changed with
it, which the fault map now records: two seeded sets rather than one, and two polls
rather than one.

### D9. The fallback record covered a completion that cannot repeat

Applied in `catalog.md` on `note-b-fallback-phase-writes-no-durable-backoff`:
`Exercised`, `Guarantee`, `Check`, `Required faults`. In `fault-map.md`: that
record's map row and the `SMART_NOTE_FALLBACK_COMPLETION_WROTE_NO_DUE_TIME` marker
row.

The check demanded that "after any `fallback` completion" the note's durable state
advance at least one field its own selector reads as a time gate. `reduce_fallback`
has two arms (`smart_note_evaluation.rs:636-657`). The `False` arm (`:647-656`)
writes `last_checked_at`, `updated_at` and `check_status`, none of which
`get_fallback_smart_notes` reads as a gate, and leaves the note in `pending` — so it
is re-selectable and the record's spin scenario follows. The `Met` arm (`:637-646`)
calls `ready_fields` and returns `surfaced: true`, so the note becomes `ready`, and
the candidate query selects only `status = 'pending'` (`mc-store:13293`), so it is
never offered again. A completion that cannot recur needs no backoff. Demanding one
asserts a requirement the code is right not to satisfy, and the check would fail on
correct behaviour.

The restriction to the `False` outcome is now in the `Check`, the `Guarantee`, and the
`Required faults`. Worth noting that the record's `Confidence` line had **already**
scoped its evidence to the `False` arm and cited `:647-656` exactly; only the check
over-quantified. That is the same intra-record disagreement Part 4b's evaluation
prescribed a guard against: read each finished record end to end as one argument
before it ships. The marker row gained the same scoping, because a marker spanning
both arms would witness a situation the record does not claim.

### D10. The cross-language coverage claim was overstated, in all three artifacts

Applied in `catalog.md`: the section heading and body of "A cross-language dependency
where the Rust half is untested and the composition is absent", plus the Group C
preamble and the relationship map's effect cluster. In `existing-checks.md`: the
cross-language section's headline, its four-step table, three new sub-sections, and
two rows of the TypeScript-side gates table. In `fault-map.md`: framing point three,
framing point five, the F7 row, and leverage item 8.

All three artifacts said, in nearly identical words, that "each half is checked
against a fake of the other". Verified against `HEAD`, that is three claims and each
one needs separate treatment:

- **The Rust half is not checked against anything.** `claim_effects` appears twice in
  `lib.rs`, at `:10051` (dispatch) and `:10184` (handler), and zero times in either
  test module. There is no Rust test for a fake to be the counterparty of. "Checked
  against a fake" overstates this to a reader in the most consequential possible
  direction, because it implies a test exists.
- **The producer is checked against a fake delivery, and that part was right.** The
  fake is an inline closure, not a separate stub file: `drainClaimEffectPrefix` is
  called at `module-state-sync.test.ts:1405` with a `deliver` option whose body spans
  `:1409-1415` and returns `{ ackedEffectId: receipt.effects.at(-1)?.id ?? 0 }` at
  `:1414`. The drain's ordering and per-receipt checkpoint atomicity are genuinely
  covered. No module behaviour is.
- **The composition is absent,** which all three artifacts said correctly, and
  `direct_host.rs`'s zero 4d method literals is why there is nothing to extend.

The strengthening. Two citations that had been carried in all three artifacts as
claim-effects coverage are coverage of a **different contract**, and this was not in
the evaluation's original phrasing beyond the observation that they are mirror tests.
`module-wire.test.ts:345`, `:414` and `:427` are all arguments to
`decodeClaimMirrorReceiptResponse`, whose definition begins at `module-wire.ts:737`;
`module-state-sync.test.ts:1510` sits inside `class DeterministicClaimMirrorFacade`,
opening at `:1444`. They share the field name `ackedEffectId` with the claim-effects
path and nothing else. And the corollary is worse than the correction: the
claim-effects wire validator itself, `decodeClaimEffectDeliveryResponse`
(`module-wire.ts:717-735`, with the skipped-checkpoint throw at `:730-732`), has
**zero** test references anywhere in `packages/plugin`. So the ack equality check that
the whole contract rests on is untested on the side that was described as tested.

The three artifacts now state the three parts separately and name which citations
belong to the mirror contract, in every place the old sentence appeared.

### D11. The claim-effects record presented full composition as locally checkable

Applied in `catalog.md`: the record keeps its slug and is narrowed to the
module-local obligation, and a new record
`facade-a-claim-effects-ack-and-producer-checkpoint-advance-are-never-composed`
carries the composition, with an index row, an updated Group C preamble, and updated
relationship-map and cross-part sections. In `fault-map.md`: the map row splits in
two, the totals change, framing point five is rewritten, the anti-pattern bullet
records the violation, and leverage items 2 and 8 are re-pointed.

Two defects in one record. The first is a METHOD.md violation. The check said "Do not
assert the negation; assert instead the two independent preconditions that make the
window real: (a) the request was accepted with an `ackedEffectId` equal to the last
effect id, and (b) **no module store write occurred during the call**." Clause (b) is
the alleged violation. METHOD.md's coverage rule requires preconditions that still
hold on a correct implementation, and a correct implementation that retained the
effects would write, so (b) is satisfiable only when the defect is present. The
record had correctly recited the rule in its own prose and then broken it in the next
clause. The legal precondition is the acceptance alone, which the fault map already
carried as `CLAIM_EFFECTS_APPLY_ACCEPTED_A_RECEIPT`.

The second is scope. One record asserted both that the module writes something or
returns a non-advancing code, and that the producer's checkpoint therefore means what
it claims. The first is one call plus a before-and-after store read. The second needs
a process pair spanning two languages that does not exist. Presenting them together
produced a `Partial` availability verdict that a reader would reasonably interpret as
"half the work is done", when the truth is that one obligation is free and a
different one is impossible. Split, the module-local record is `Yes` and the
composition is the part's only outright block — which is also why this is the one
refinement that made the fault map's totals look worse while making them more useful.

Both halves link the same evidence file deliberately, so no link breaks. Per
METHOD.md step 7 that file needs to become two, and this disposition was scoped away
from `evidence/`; the new record says so at its `Confidence` line.

### D12. The timezone record misattributed a documented input to reducer impurity

Applied in `catalog.md`: the section heading and body of "Note evaluation is pure,
and its timezone is a documented call-site choice", the record's `Exercised`,
`Guarantee`, `Check`, `Required faults`, `Confidence`, and `Open questions`, and the
relationship map's purity cluster. In `fault-map.md`: that record's map row, leverage
item 5, and leverage item 7.

The record claimed the reducer's documented purity was broken by one argument at the
call site, quoting `smart_note_evaluation.rs:8-10` as "Pure functions throughout:
callers supply the pre-state, a phase-scoped outcome, the transition clock, and a
timezone". Read at `HEAD`, that quote stops one clause early. The sentence continues:
"(cron matching is a wall-clock concept; production passes the machine-local zone)".
So the timezone is a declared input of a pure function, and production's use of the
machine-local zone is documented at the same site. There is no impurity and no
undocumented behaviour. The truncated quote had turned a documented design into an
alleged violation.

What survives is smaller and better posed, and it is not nothing: whether a durable
schedule field may be host-local at all. `lib.rs:14244` passes `&chrono::Local`, so
two hosts write different `check_next_due_at` values for the same note from the same
pre-state. Per METHOD.md rule 3 the documentation establishes the contract and not
its correctness, so this is a live portability decision rather than a settled one,
and it is now framed as a call-site question with the open question rewritten to
match.

The two-process limitation is kept and, in one place, sharpened against the
evaluation. The fault map's leverage ranking had said F4 (process timezone variation)
"unblocks **zero** records" because the free reducer differential already made the
same record non-vacuous. Once the record is a call-site question, that is wrong: a
reducer differential passes two zones to a pure function and confirms documented
behaviour. It cannot observe what the call site chooses. So F4 was **promoted** to
being the only thing that makes this record non-vacuous, and item 5's value was
correspondingly downgraded to a regression pin on the schedule arithmetic. This is
the one place where applying a refinement made an availability claim worse rather
than better, and it is recorded rather than smoothed over.

### D13. The catalog's schema-comment claim proved less than it stated

Applied in `catalog.md`: the "Facade validation is not uniform" section, and the
`Existing check` and `Impact` lines of
`facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic`.

The catalog said "The silent acceptance is asserted to be intentional rather than
accidental: the inline test at `lib.rs:25636-25641` asserts that every advertised
tool except `ctx_reduce` 'must preserve compatibility arguments'." Read at `HEAD`,
`:25636-25641` is `if name != "ctx_reduce" { assert_ne!(tool.schema.get("additionalProperties"), Some(&json!(false)), "{name} must preserve compatibility arguments") }`.
It is an assertion about the advertised manifest's `additionalProperties` value. It
proves **advertised openness**: the schema must not be closed. It does not prove that
the handler ignores an unknown key, that the ignoring is silent, or that a call with a
spare key returns bytes identical to one without it. The comment above it at
`:25574-25578` is the same kind of statement about the same object.

The narrowed statement is in the section prose and in the record's `Existing check`
line, which now names the assertion's actual form so a reader cannot re-inflate it.
This matters more than a wording nit because the inflated version was the record's
entire basis for `Exercised: partial` on the runtime consequence, and it is also
what made the silence look pinned enough to guarantee — which is how the polarity
contradiction D4 fixed survived review in the first place.

### Factual correction: the tested success-shaped path is `ctx_reduce`

Applied in `catalog.md`, in the "Six error paths present as success, and one of them
has a test" section. Noted in `existing-checks.md` at the end of that section's
table, which was already right.

The catalog said "Only the second of the six has any test at all, and it is on the
other side of a language boundary." Both halves are wrong. The second of the six is
`claim.effects.apply`, which has no test on either side of the boundary — that is
D10's whole subject and `existing-checks.md`'s own table says so. The tested path is
the **first**, `ctx_reduce`, covered in this crate by
`facade_ctx_reduce_ack_validates_unknown_queued_and_protected_tags_without_committing`
(`lib.rs:25445-25474`), which drives `ctx_reduce` through the facade and asserts at
`:25474` that `load_pending_agent_drops` is empty after the acknowledgement.

Recorded here as more than a typo because it inverted the section's headline claim in
the direction that flatters the coverage: it credited the untested cross-language path
with a test and left the actually-tested path looking uncovered. `existing-checks.md`
had it right in its table and the catalog did not read its own inventory, which is the
sideways-propagation failure again.

## Gaps queued for a follow-up pass

Recorded, not mined. Each carries the evidence that makes it a gap rather than a
preference, and each was verified for this disposition.

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | **The two `ctx_expand` success-shaped failures and the health-versus-error decoupling are prose-only, with no record between them.** All three artifacts describe them and none catalogs them. `handle_ctx_expand_facade` answers two distinct unrecoverable-content cases with `mcp_text_result(..., false)`: `Ok(None)` on a single-message expand returns "Message {message} is no longer recoverable from persisted chunk transcripts" (`lib.rs:10804-10809`), and a range whose `last_compacted_ordinal < start` returns "No compacted compartments found in range {start}-{end}" (`:10832-10838`). Both are `isError: false` on the one tool whose entire purpose is recovering content the agent already lost, and the second's text is repeated in the range renderer (`:14638`, `:14717`, `:15000`). Separately, `health()` (`:12003-12046`) can report `HealthStatus::Ok` while every facade call fails, because `DispatchHealth::report` degrades only on staleness (`dispatch.rs:403-407`, `:418-421`) and the facade takes no dispatch ticket at all, unlike the wedge detector at `lib.rs:7993`. `existing-checks.md` lists all three in its six-row success-shaped table and `fault-map.md` supplies markers for them (`EXPAND_ANSWERED_AN_UNRECOVERABLE_REQUEST_WITH_IS_ERROR_FALSE`, `MODULE_HEALTH_REPORTED_OK_WHILE_A_FACADE_CALL_FAILED`), so the analysis is done and the records were never written. Both are F2-cheap: an out-of-range ordinal and a session with no compacted compartments. |
| G2 | **The response wire cap has production enforcement and boundary tests but no catalog record.** `checked_body_len` (`dispatch.rs:330-346`) sums segment lengths with `checked_add`, returns `LengthOverflow` on wrap (`:335-337`), and returns `BodyTooLarge { len, max }` when the total exceeds `MAX_WIRE_BODY_BYTES` (`:339-344`); `finish_count` (`:359-370`) applies the same two outcomes to the incremental JSON counter, with `measure_json` (`:352-357`) documented at `:348-351` as enforcing the cap "as bytes are produced, so an over-cap body fails during counting rather than after a full encode". Two integration tests pin the boundary exactly: `exactly_at_wire_cap_succeeds_without_destination_allocation` (`tests/prepared_output.rs:133-145`) asserts a body of exactly `MAX_WIRE_BODY_BYTES` measures and writes, and `cap_plus_one_and_arithmetic_overflow_fail_before_write` (`:147-179`) asserts cap-plus-one yields `BodyTooLarge` with `len == MAX_WIRE_BODY_BYTES + 1` and that a `usize::MAX` segment yields `LengthOverflow`, both from `measure()` before any write. The catalog has a record on measured-length-equals-written-body and none on the cap itself, so the inclusive boundary, the fail-during-counting property, and the overflow arm are unclaimed. This is the part's best-defended untracked behaviour, which makes it a cheap record rather than a cheap test. |

## Biases requiring human judgment

1. **Whether this portfolio's total absence of a bounded-progress contract is a
   deliberate scope choice or an omission, because the type distribution is 23
   safety plus 2 coverage markers and zero liveness.** Every record in this part says
   something must not happen, or that a campaign must reach a situation. Nothing says
   that anything must happen. That is a systematic shape rather than a coincidence,
   and the subject has an obvious progress obligation that no record states: the
   acquisition loop is a bounded-quota fair-selection cursor
   (`FULL_CYCLE_PROFILE` at `smart_note_evaluation.rs:843-848`, the cursor at
   `:854-886`, its documented contract at `:895-899`), and the module resets it on a
   fresh `no_work` (`lib.rs:11258-11265`) precisely so that work hidden by a spent
   cursor becomes reachable on the next poll. The comment at `:11245-11249` names the
   failure mode in as many words — "the quota stopped decrementing and fair rotation
   silently starves" — and its only enforcement is a `debug_assert!` at `:11250-11253`
   that is absent from release builds. The natural liveness property is therefore
   already implied by the code and by three of this part's own safety records: after
   faults stop, finite eligible work is claimed within a bounded number of polls.
   METHOD.md's liveness rules say exactly how to write it — run under load, stop the
   pressure, poll until stable within an explicit bound stated in the units the code
   bounds, which here is polls and phase quotas, and never an unbounded "eventually".
   *Judgment required:* decide whether this catalog owes a bounded-progress record.
   If it does, the bound has to be named in polls or in cursor resets, and two records
   change character: the fallback spin record becomes the safety half of a pair whose
   liveness half is missing, and the cursor coverage marker becomes the situation that
   marker's liveness sibling needs. If it does not, say so in the scope section, so a
   later reader does not read zero liveness records as an oversight in a subsystem
   whose central mechanism is a rotation that can starve.

2. **Whether the exact twelve-plus-twelve record split is a risk sample or a quota,
   because the symmetry masks uneven coverage of the named surface obligations. This
   is a cross-part bias: a sibling part received the same finding.** `fault-map.md`
   states the split as a fact — "twelve from lens A and twelve from lens B" — and Part
   4c's evaluation raised the identical concern about its own 24, where two lenses also
   produced exactly twelve each and a redundant record was kept explicitly because
   "the commissioning scope fixes the record count at 24". A round number reached
   independently in two adjacent parts is weak evidence of a portfolio being sized to
   its subject. Set against this part's own inventory, the unevenness is concrete.
   `existing-checks.md` names surfaces with zero coverage and this catalog gives them
   no record either: `handle_note_delivery_value` has 63 production lines carrying
   three rejections including a cross-session guard (`lib.rs:11483-11545`,
   quiet area 4) and no record; the claim-mirror facade handlers have 28 whole-file
   occurrences, zero test references, and module-side protocol gates at `:10279` and
   `:10317` (quiet area 5) with no record; page and seed reassembly spans
   `:13587-13784` with seven distinct continuation rejections (quiet area 6) and no
   record; `canonical_value` (`:15341-15372`) is what makes the facade command
   ledger's identity stable across argument reorderings, has zero references, and
   underpins two records that were written (quiet area 7) while having none of its own;
   and the `project_docs.rs` TOCTOU re-check is called the strongest security claim in
   the sub-part, with its threat model stated at `:7-8`, and rests on the one line no
   test exercises (quiet area 8). Meanwhile two records were written about the
   argument map's openness and two more about registration fields. *Judgment
   required:* declare what this catalog is. If it is a risk sample, say so in the
   scope section and the five surfaces above become candidates rather than debts. If
   every named surface obligation owes at least one property, the record count must be
   allowed to move to whatever that requires, and it will not be 25. Because the same
   finding landed on a sibling part, the decision should be made once for the family
   rather than twice locally; deciding it per part is how two parts arrive at
   twenty-four by coincidence.

## Verdict

The evaluator's verdict was **"not ready"**. After applying all thirteen refinements
the honest answer is still not ready, and the reason has moved in a specific
direction: the portfolio's oracles are now mostly capable of failing, and what
remains is missing coverage plus three decisions nobody has made.

What improved concretely, and it is more than the count suggests. **Five checks that
could not detect their own record's defect now can.** The `ctx_reduce` bound no
longer collapses to `0 <= 0 <= reported` on exactly the permanent-gap case it was
written for. The byte-cap equivalence no longer quantifies over 40 MiB bodies that
the cap is right to refuse. The fallback backoff check no longer demands a durable
delay after a `Met` completion that removes the note from the candidate set. The
unbounded-growth check is refutable at all, having previously asserted a constant the
product never declared. And the claim-effects check no longer uses the alleged
violation as its own coverage precondition. **Two overstated coverage claims are
withdrawn:** the cross-language "each half checked against a fake of the other" is
replaced with the three asymmetric facts in all three artifacts, and the
schema-comment claim is narrowed from silent runtime ignoring to advertised openness.
**One contradiction between two records is resolved** on a line the code itself
draws, rather than by weakening either. **One misattributed root cause is corrected**,
which shrank a finding and simultaneously promoted the capability needed to observe
it. **One anonymous marker is named.** And **one summary bucket that read as
twenty-two comparably cheap tests now shows three cost bands**, with the two
undercounted records corrected from one call to three and from three calls to four.

Ready now for test implementation, in this order. The five `none · 1` records first,
because they are the cheapest valid oracles in the catalog and one of them — the
claim-effects module half — currently has no test in either language: the byte-cap
band probe, the misspelled condition key, the facade error path's host paths, the
claim-effects module-local store read, and the unreportable exclusion. Then the
two-call differentials, taking the corrected comparison level: two cloned stores or a
parser-level assertion, never two sequential mutating calls. Then the sequenced
note-evaluation records, which need only wire-supplied outcomes and seeded rows. Then
G2, the response wire cap, because production enforcement and boundary tests both
already exist and only the record is missing, which makes it the cheapest record in
the queue rather than the cheapest test.

Not ready, for four reasons no further work of this kind resolves. G1 and G2 are both
prose-and-analysis complete with no record written, so they are bookkeeping debts
rather than research debts, but they are debts. Bias 1 is upstream of the type
distribution and cannot be settled from inside the part: a subsystem whose central
mechanism is a rotation the code itself warns can "silently starve" has no
bounded-progress record, and whether it owes one is a scope decision. Bias 2 is
upstream of the record count and now demonstrably a family-level question rather than
a local one. And above all of it sits the fact none of these corrections touches:
**nothing in this scope executes in CI.** Every record improved here is a record in a
suite no automation runs, F0 remains the top of the leverage ranking while unblocking
zero records and protecting all 112 checks, and the day one of them runs, the meaning
of `partial` changes across all 25 records.

One process caveat, stated rather than hidden. METHOD.md step 7 requires records to
equal index rows to equal evidence files. Records and index rows both equal 25 and
their order matches, verified mechanically. **Evidence files remain at 24**, because
D11 added a record and this disposition was scoped to `catalog.md`,
`existing-checks.md`, and `fault-map.md` and explicitly forbidden from touching
`evidence/`, `_lenses/`, source, tests, or CI.
`facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect.md` is
linked by both halves of the split so no link breaks, and it needs to become two
files. The new record says so at its `Confidence` line. Separately,
`note-b-reducer-reads-process-local-timezone-for-durable-schedule` keeps a slug that
D12 made imprecise: the record is no longer about the reducer reading anything. The
slug is retained deliberately so the evidence link resolves, and the record says so.

## What this evaluation says about the method

Part 4a's evaluation found absence of a named seam read as absence of a capability.
Part 4b's found records whose own fields disagreed with each other and prescribed the
guard: read each finished record end to end once, as a single argument, before it
ships. Part 4c's found the same two lessons unlearned and added a third, that
precision does not propagate sideways either — advice in a review section is not
applied, and evidence established for one record is not shared with its sibling.

This part's evaluation says the sideways lesson is still unlearned, and it adds one
that is new and sharper than all of them.

The sideways failure recurs three times. `fault-map.md`'s compliance review had
already written D6's marker refinement as advice, and it sat unapplied (D6). The
fallback record's `Confidence` line already cited the `False` arm specifically while
its `Check` quantified over both arms (D9). And `existing-checks.md`'s
success-shaped table already recorded correctly that `ctx_reduce` is the tested path,
while `catalog.md` two files away credited `claim.effects.apply` instead. In each
case the correct information was already inside the artifact set and the record that
needed it did not use it. Part 4c's proposed guard, a cross-reference pass grepping
each record's slug and cited identifiers across the other artifacts, would have
caught all three.

The new lesson concerns **quoting**. Two of the thirteen refinements exist because a
citation was truncated or paraphrased at exactly the point where the remaining text
changed the conclusion. D12's record quoted `smart_note_evaluation.rs:8-10` up to
"and a timezone" and stopped one clause before "(cron matching is a wall-clock
concept; production passes the machine-local zone)", which converted a documented
design into an alleged impurity and shaped a record, a relationship-map cluster, a
fault class, and two leverage items. D13's record paraphrased an `assert_ne!` on a
manifest field as an assertion about runtime behaviour, which inflated what the
existing check covered and made a contradictory guarantee look pinned. Both are the
same error as Part 4c's F3, where a seam was enumerated, given the adjective "narrow"
from its doc comment, and never opened. **A claim built on a quotation needs the
quotation read to its end, and a claim built on an assertion needs the assertion's
actual expression read, not its message string.**

The second new observation is about which findings pay. Five of the thirteen
refinements are checks that pass while the defect is present, and they cluster around
three recognisable shapes worth turning into a checklist question. A **degenerate
bound**, where a two-sided inequality collapses because both ends are zero on the
scenario in question (D5). An **over-quantified universal**, where a check ranges over
inputs the implementation is right to treat differently (D2, D9). And an
**undeclared constant**, where the check names a bound the product has never chosen
(D8). To Part 4c's promoted question — *given this record's own Fault/timing angle,
can this check fail?* — this part adds a second: *on the exact scenario in the
record's Impact line, substitute the values and evaluate the check by hand.* For the
`ctx_reduce` bound that takes one line and yields `0 <= 0 <= 21`.

## Re-evaluation trigger

A fresh pass is warranted once bias 1 is resolved in favour of a bounded-progress
record, because that adds a property class the part does not have. Every current
record is a safety property or a situation marker; a liveness record would be the
first thing in this part whose oracle is a bounded fault-free window rather than an
invariant over one observation, and METHOD.md's liveness rules would govern it rather
than its coverage rules. It also changes two existing records' character, as bias 1
sets out.

Five other triggers, each firing independently:

- **Any resolution of bias 2 that says every named surface obligation owes a
  property.** That moves the record count from a number this disposition preserved to
  a number derived from the subject, and it makes `handle_note_delivery_value`, the
  claim-mirror gates, page and seed reassembly, `canonical_value`, and the
  `project_docs.rs` TOCTOU re-check debts rather than candidates. Because a sibling
  part carries the same bias, a resolution there should fire this trigger here too.
- **A product decision on a per-poll candidate ceiling.** It converts
  `note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll` from a
  scaling oracle back into an ordinary `always` against a declared constant, which is
  a stronger property and a cheaper test, and it retires the two-size seeding the
  record currently needs.
- **Any harness in which a real `McHandler` answers a real facade request.** It moves
  `facade-a-claim-effects-ack-and-producer-checkpoint-advance-are-never-composed`
  from blocked to constructible, which is the part's only outright block, and it
  would be the first end-to-end coverage of any of the eleven routed facade names.
  The cheap adjacent change fires the same trigger for a different record set:
  extending `evaluation-state.test.ts` past `transition_cases` (`:105`) to iterate
  `schedule_cases` and `selection_cases` puts 25 of the shared fixture's 48 cases
  under automation for the first time, in a file that already loads the fixture at
  `:54` and already runs under `ci.yml:257`.
- **Any resolution of the timezone portability question.** If host-local wall-clock
  cron is declared the durable contract, the record narrows to a documentation fix
  and F4 stops mattering. If it is not, the record stands and F4 is the only way to
  observe it, which is the promotion D12 recorded.
- **Any workflow change that runs any test in this scope.** Every `Exercised:` line
  and every `Existing check:` line in this part is written against a suite no
  automation executes, and the day one of them runs, the meaning of `partial` changes
  across all 25 records. This is the same trigger Parts 4b and 4c recorded,
  unresolved, and it remains the largest single fact about this part.
