# Sub-part 2e portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md`. Its
charter was to expose systematic gaps rather than to agree. Its verdict was
**REFUTED**, and this file records that honestly: the evaluator did not find a
portfolio needing polish, it found that the sub-part had understated its own
coverage twice, overstated one finding, carried an ordinal it admitted was
unverified, and blurred five distinct code exits into one list.

The shape differs from 2d's, which was evaluated in the same pass. 2d's findings
were mostly consequences asserted without a producer. 2e's are mostly **the
artifacts contradicting evidence they already contained**: a CI-named binary in the
inventory's own table holds a test that asserts a record whose `Existing check:`
read `none` (E1); a `pub` field and an existing in-crate constructor make a
"blocked" record constructible (E2); the catalog's own preamble marks an ordinal
unverified and then uses it as a headline (E4). Two findings are substantive rather
than clerical: one record's framing claims more than the code supports (E3), and
one enumeration needs classifying before it can be reasoned about (E5).

Four lenses: harness fit, coverage balance, implementability, and a wildcard pass
questioning the framing.

Every finding below was re-verified against the code before acceptance. **All five
refinements were accepted and applied; none was rejected.** Two carried a premise
this disposition sharpened. One line reference in the brief was off by a small
amount and is corrected in place rather than silently followed.

Provenance for this pass. `HEAD` is `e447c927` ("refactor(shm): trim final review
leftovers"), which is what the three artifacts already state. Every reference below
was read back individually at that commit: `dispatch.rs:396-435`, `:530-549`,
`:1018-1079`, `:1160-1239`; `handler.rs:200-259`, `:330-379`; `wire.rs:45-89`,
`:336-346`, `:540-602`; `connection.rs:70-103`, `:934-975`; `client.rs:2015-2035`;
`lib.rs:1-40`; `routing.rs:191-205`; `tests/lifecycle.rs:570-664`;
`.github/workflows/ci.yml:105-200`. One correction to the brief: it cites the
`lifecycle` CI steps as `ci.yml:174-187`, which spans two steps; the exact
invocations are `:178-179` (step "Rust contracts and lifecycle (Linux)" opening at
`:174`) and `:187` (step "Fixed-ring contracts (macOS)" opening at `:181`). Both
run `--test client --test lifecycle`. The artifacts now cite `:178-179` and `:187`.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 5 | 5 applied, 2 with a sharpened premise, 1 line reference corrected |
| gap | 3 | queued for a follow-up pass, none mined |
| bias | 2 | require human judgment |

Record count **14 to 14**. Nothing was added, invalidated, split, or renamed. Every
refinement changed a record's fields, its coverage attribution, or a framing
section; none changed the record set. That is worth stating because the two sibling
parts evaluated before this one both moved their counts.

Semantics distribution **12 `always`, 2 `sometimes`, 0 `always-or-unreached`,
0 `reachable`, 0 `unreachable`**, unchanged. E3 narrowed a record's *claim* without
changing its check semantics, because "the only predicate at `:1031` is the upper
bound" is `always` over every unary success either way. E2 changed a record's
constructability, not its semantics.

Types **12 safety, 2 reachability, 0 liveness**, unchanged. Reachability-class
labels **14 `default-production`**, unchanged; the three-fact argument in the
catalog's reachability section was not disputed and its `RouteClass::Reserved`
half was spot-checked here.

Confidence **13 high, 1 medium**, unchanged. E2 was expected to raise the
pending-entry record from `medium`, and it does not: the record's `medium` rests on
a *second* unresolved question — whether the forced path drops the `GenerationCore`
immediately — which E2 does not touch and which is answerable only from sub-part
2f. The record's observability premise was corrected while its confidence stayed
put, and the record now says which of its two premises moved.

Fault-map totals **11 non-vacuous today, 3 partial, 0 not constructible**, against
10/3/1 before. One row moved, on E2. **No record in this sub-part is blocked
outright**, which is a genuinely different position from 2b's and 2d's and is
recorded as such.

One row is now in a category the fault map did not previously have: the
divergent-codes record is not merely constructible, it is **already asserted and
CI-executed**. It is the only such row here and the only one in any of the three
sibling parts.

Test counts are unchanged and were not disputed: 37 in-crate, 84 integration across
six subject binaries, 4 CI-executed `compile_fail` doctests, 121 claim-bearing
checks in total. What changed is the conclusion drawn from them. "Zero executed by
CI" is true of those 121 and false of the sub-part's *record coverage*, which is
the distinction E1 turns on.

## Refinements applied

Applied in the order the evaluation supplied. E3 and E4 interact: E3's narrowing is
one of the three reasons E4's ordinal is deleted rather than verified.

### E1. One record has a CI-executed check, and three artifacts said none did

Applied in `catalog.md`: the divergent-codes record's `Exercised` moves from
`not yet` to `yes`, its `Existing check` from `none` to the test and its two CI
invocations, and its `Impact` gains the consequence of being pinned by a CI test;
the coverage framing paragraph gains a correction block; and the relationship-map
preamble's "none can be tested by anything CI runs today" is qualified. In
`existing-checks.md`: a correction block is added under the integration-test
section, the record-named integration table gains a row, and the heading claim is
rewritten. In `fault-map.md`: the map row, the `C0` caveat, and leverage item 5 are
corrected.

`tests/lifecycle.rs:576-657` `shutdown_refuses_new_routes_and_new_routed_work`
asserts this record exactly, and in the record's own shape rather than
incidentally. It starts a host with a shrunk `lifecycle_callback_deadline`
(`:578-581`), blocks route-gone (`:582`), opens a route (`:584-587`), parks a
handler in "hang" mode to hold the drain open and waits until it is running
(`:590-606`), spawns the shutdown (`:611`), waits for the publication to be
unlinked so the freeze is observable (`:614-621`), then sends a `route.open` and
asserts `open_error.error_code() == "target_unavailable"` (`:626-638`) and sends a
routed request on the still-live route and asserts
`request_error.error_code() == "server_busy"` (`:640-657`). Two codes, one draining
host, one test, in the record's own required enabling state.

And `lifecycle` is CI-named twice: `ci.yml:178-179` runs
`cargo nextest run -p mc-host --test client --test lifecycle` under
`if: runner.os == 'Linux'`, and `:187` runs the same pair under
`if: runner.os == 'macOS'`. So the check runs on two platforms.

**Why it was missed, recorded because the mechanism is reusable and is not
carelessness.** The inventory counts by *binary subject*. It identified six
binaries whose subject is the request path and correctly found CI names none of
them; `lifecycle`'s subject is the host lifecycle, so it was classified as
out-of-scope for 2e and listed only in the CI-name table. The record it happens to
assert nevertheless belongs to 2e. Counting by subject rather than by assertion is
the error, and it is invisible from inside the subject taxonomy.

**Consequence beyond the correction.** This changes the record's `Impact`, not just
its bookkeeping. The code divergence is not an unnoticed inconsistency; it is
current intended behaviour, pinned on two platforms, and changing it means changing
that test. The record now says so, which converts its open question from "is this
right?" to "is this deliberate, given something asserts it?".

### E2. The one blocked record is not blocked

Applied in `catalog.md`: the pending-entry record's `Exercised`, `Required faults`,
`Confidence`, `Existing check`, and open questions change. In `fault-map.md`: the
third framing point, the `C9` class row, the cross-class observability caveat, the
map row, the totals, and leverage item 10 change.

The record was the sub-part's only fully blocked one, on the stated grounds that
"`gen.pending` is private to the crate, no in-crate test constructs a
`GenerationCore`, and no integration test can reach the map". The first clause needs
splitting and the second is false.

- `mod connection` is private (`lib.rs:24`, verified against the `pub mod` list at
  `:10-22`). So no integration test can name `GenerationCore`. That half holds.
- `pending` is a **`pub` field** on it: `connection.rs:95` reads
  `pub pending: Mutex<HashMap<PendingKey, PendingEntry>>`, inside
  `pub struct GenerationCore` at `:77`. Readable and insertable from any in-crate
  test.
- **An in-crate test already constructs a complete `GenerationCore`.**
  `connection.rs:946-963`, `shutdown_registration_rejection_leaves_no_graceful_drain_work`,
  builds all eleven fields — using `frame_sender` for the writer at `:950` and
  empty maps for `membership`, `pending`, and `pings` — and asserts against it at
  `:967-973`.

So the postcondition is assertable today. What survives is a **placement
constraint**: the oracle must live in-crate, which is a lane CI does not run, so
the record trades observability against CI reach. That is a real cost and the
record now records it, along with a new open question about whether a test-only
accessor is worth a production edit to move the oracle into an integration binary.

**Premise sharpening, and it is why the confidence did not move.** The evaluation
said "integration placement is inconvenient rather than unobservable", which is
exactly right. It did not say what that does to the record's `medium` confidence,
and the answer is nothing: the `medium` rests on the *second* unresolved question,
whether `force_close_all_routes` is always followed by the `GenerationCore` being
dropped — which would make the leak unobservable because it would not exist long
enough to matter. That is answerable only from `runtime.rs:1144-1244`, sub-part 2f,
and the synthesis note already attached to this record establishes that 2f's
existing pass does *not* answer it. Two premises, one corrected, one still open.

**Cross-artifact consequence.** `C9` was grouped with `C4` and `C6` under a shared
"observability problem, not an injection problem" caveat. It no longer belongs
there, because `C4` and `C6` land on exits that emit nothing anywhere while `C9`'s
postcondition is a readable field. The caveat now says so, and the sub-part's claim
to have "one thing it cannot observe" is withdrawn.

### E3. The handler-failure framing is narrowed to empty-response acceptance

Applied in `catalog.md`: the third framing fact in "What this part is about" is
rewritten and gains two explicit scope corrections; the Group C preamble is
amended; and the record's `Exercised`, `Guarantee`, `Required faults`,
`Confidence`, `Impact`, and both open questions are rewritten. In `fault-map.md`:
the map row and the `req_output_buffer_was_reserved_and_unwritten` coverage check
are narrowed and the marker is renamed.

What the code supports is that an **empty success is accepted end to end**, and
that is verified at five independent points, each read back for this disposition:

1. An owned reservation starts empty. `RequestCtx::reserve_output`'s tail is
   `dispatch.rs:537-542`, constructing `OutputBuffer { body: Vec::with_capacity(..),
   direct: None, .. }` with no writes.
2. `OutputBuffer::len()` (`handler.rs:361-366`) is
   `self.direct.as_ref().map_or(self.body.len(), |body| body.len)`, so an owned
   buffer reports the *written* length and a direct one the *declared* length.
3. The gate accepts zero. `dispatch.rs:1031-1034` guards only
   `body.len() <= MAX_BODY_LEN`.
4. Decode imposes no minimum. `Response` is not pure-header
   (`wire.rs:86-88`: `matches!(self, Cancel | Ping | Pong | Goodbye)`), and the only
   body-versus-type rule is `if ty.is_pure_header() && len != 0`
   (`wire.rs:340-342`).
5. The Rust client imposes none either. `validate_inbound`'s `Response | Error` arm
   (`client.rs:2022-2031`) checks `corr != 0` and rejects a binary flag on channel
   0, and says nothing about length.

What is **not** supported is calling this a handler *failure* surfacing as a
success. `handler.rs:220-225` documents `RequestOutcome::Response` as "Unary
success; the host emits one `Response` terminal", and a handler that returns it has
explicitly selected that variant. Nothing observable distinguishes an abandoned
reservation from a deliberate empty result — which is the record's real content,
and is a narrower and more defensible claim than the one it replaces.

**Second scope correction, which the evaluation supplied and which decides how much
of the record is even about this gate.** The *direct*-output form is caught. A
declared `exact_len` that the serializer never satisfies passes the gate (because
`len()` reports the declared value) and then fails at publication, where
`reservation.commit(body_len)` returns `ProducerError::Underfill`. That is
[req-a-a-response-publication-failure-never-reaches-the-settling-path](catalog.md#req-a-a-response-publication-failure-never-reaches-the-settling-path)'s
subject,
not this one. So the gap here is specifically the **owned** path, where declared and
written are the same field and zero is legal. The record, its fault-map row, and
the renamed coverage marker `req_owned_output_buffer_was_reserved_and_unwritten`
now all say owned.

**What the narrowing costs.** The record loses its headline. It was the sub-part's
most quotable finding and is now a precise statement about a missing lower bound
whose severity depends entirely on an unanswered contract question. The existing
open question — is a zero-length `Response` a defect or a supported outcome? — is
promoted to the record and to the biases below, because after the narrowing it is no
longer a detail of the record, it *is* the record's severity. One weak piece of
evidence was added on the "supported" side: `OutputBuffer::is_empty()`
(`handler.rs:368-370`) is public API, which suggests emptiness is a state callers
are expected to reason about. Per METHOD rule 3 that does not settle it.

### E4. The "fourth part" ordinal is deleted, not verified

Applied in `catalog.md`: the paragraph asserting the ordinal is replaced with a
cross-part note that names each site and its oracle and carries no count.

The catalog claimed this was "the fourth part in this catalog to find an error path
presenting to its caller as a success" and, four sentences later, conceded that the
count was inherited from a lens and never re-derived, "unconfirmed in the same way
the lenses treat the 'fourth misleading comment' ordinal in `runtime.rs`". The
evaluation asked for verification across the named parts or deletion of the
ordinal. **Deletion was chosen, on three grounds, and each is independently
sufficient.**

First, METHOD rule 2. An unverified count is an open question, and asserting it as a
headline while conceding it in the body is exactly the shape the rule forbids.
Verifying it would require an ordering over parts and a shared definition of "error
path presenting as success" applied consistently across every catalog part, which
is a whole-catalog audit and not something this sub-part can do from inside itself.

Second, after E3 the 2e instance is not an error path. It is an empty success that
every layer accepts, with no established failure behind it. A member of the set was
removed by the same disposition that would have had to count the set.

Third, and decisively, the sites the ordinal grouped do not share an oracle, so the
grouping was not a finding about one pattern. Part 4c's and 4d's are write paths
that report success without persisting; their oracle is to re-read the store after a
successful response. Part 2d's `host_shutdown` accepts a JSON echo of its own
operation name; its oracle is to answer the echo, keep serving, and show the
caller's next call succeeds. This one is an empty body nothing rejects; its oracle
is a census of the gate. **Part 4c's own disposition made exactly this correction
one layer up** — its F14 removed a third site from a three-site equivalence
precisely because that site's oracle differed — so the precedent for splitting on
oracle rather than on shape is already in this catalog.

What replaces the ordinal is a cross-part note that names the three sites, states
each one's distinct oracle, and says the recurring *shape* is worth a reader's
attention while the count is not. That preserves everything the ordinal was
gesturing at and removes the number that made it unverifiable.

### E5. The five silent exits are classified, and one of them is owned by nothing

Applied in `catalog.md`: the first framing fact is rewritten with the arbiter's
full span and a per-exit classification, and the relationship map's "five silent
exits" cluster is corrected. In `existing-checks.md`: quiet area 2 gains an
ownership correction. In `fault-map.md`: the first anti-pattern is rewritten to
assign a marker per exit class and to flag the unowned one.

The at-most-one framing is correct and is verified: `settle` (`dispatch.rs:399-500`)
opens with `let _order = settlement.order.lock().await` at `:407` and
`if settlement.won.swap(true, Ordering::SeqCst) { return false; }` at `:408`, so the
swap under the order lock is the whole arbiter. All five silent exits satisfy
at-most-one by emitting zero. But the original list read as five instances of one
thing, and they are three different things:

- **`:1058` — the only exit about an admitted routed request's settlement.** It is
  the `Err(_)` arm of the join match, and it `return`s at `:1060`, *before* the
  `settle(&settlement, ..)` call at `:1063`. An aborted handler task settles
  nothing.
- **`:637-638` — pre-dispatch.** The rejection never became an admitted request and
  no `Settlement` exists for it. Its blast radius reaches other correlations
  through `gen.writer.discard()`, which is why it cannot be described as confined
  to the request that triggered it.
- **`:1164`, `:1174`, `:1199` — three control `route.open` exits**, all inside
  `open_route`'s bind handling, all on channel 0.

**And no record asserts silence at `:1058`.** The relationship map claimed the
pending-entry record covered "the abort that produces `:1058`". It does not: it
cites `:1059`, the `remove_pending` on the same arm, which is the entry's removal
and not the missing terminal. The two are different obligations — one is about a
map, one is about a frame — and the record's `Check` is an emptiness postcondition
on `gen.pending`, which says nothing about what the client received. The fault map
already proposes a marker for the exit
(`req_request_join_error_was_not_a_panic`), so the sub-part has coverage machinery
for a property it never wrote. That is queued as a gap.

## Gaps queued for a follow-up pass

Recorded, not mined. Each was verified for this disposition.

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | **The non-panic join-error silence at `dispatch.rs:1053-1061` has no record.** E5 established that this is the only one of the five silent exits concerning an admitted routed request's settlement, and that nothing asserts it. The arm is `Err(_) => { remove_pending(&gen_task, key); return; }`, reached when the handler task was aborted rather than panicking, which `:1053`'s `join_err.is_panic()` guard separates out and answers with `internal_error`. Its producer is `force_close_all_routes` (`:1421-1452`), which aborts before waiting. The pending-entry record covers `:1059` (the map) and the fault map proposes `req_request_join_error_was_not_a_panic` (the marker), so the exit has an owner for its side effect and for its reachability and none for its silence. The missing property is that an admitted routed request whose task is aborted receives no terminal, which per protocol §10.1 makes it `outcome_unknown` client-side while the host records nothing at all — the same reconciliation gap `req-a-a-routed-terminal-carries-no-delivery-acknowledgement` describes, arriving by a different route. |
| G2 | **There is no bounded request-path progress or permit-reclamation property.** The catalog has no `liveness` record at all, which its own index states, and this is the hole that produces. `req-a-a-handler-outliving-every-host-deadline-is-reached` is a `sometimes` reachability record: it asserts that the unbounded state *occurs*, which is the opposite of a bound. Nothing states what must eventually happen. The four permit pools are reclaimed only by handler cooperation, client `Cancel`, route close, or generation teardown (`dispatch.rs:990` for the task permit, `:933` for the pending permit), and `HostTiming` (`config.rs:199-218`) has no field bounding a request's lifetime, which the catalog verifies field by field. So the obvious candidate property — after load stops, all four pools return to full within an explicit bound — is stated nowhere, and METHOD's liveness rule would require that bound to be named in the units the code bounds. The code bounds nothing here, which is precisely why the property is worth writing: its bound would have to come from the handler contract or from a new host deadline, and choosing which is the open design question in `req-a-a-handler-outliving-every-host-deadline-is-reached`'s own open question. |
| G3 | **Four host-global permit pools have no per-connection fairness property.** `runtime.rs:905-914` constructs `pending_permits`, `task_permits`, `reserved_pending_permits`, and `reserved_task_permits` once, on `HostShared`, from `config.limits` minus reservations — verified by reading the four `Arc::new(Semaphore::new(..))` calls. The permit-pair record's `Impact` states the consequence (one connection can hold every general permit) and the synthesis note attached to it establishes, from 2f's 21-key enumeration, that **no layer supplies per-connection fairness**. That is a resolved fact with no record. What makes it notable rather than merely absent is the interaction with G2: because no request deadline exists anywhere, a single misbehaving module holding all 256 general task permits is bounded by nothing at all, and every other route's traffic receives `server_busy` while the host reports itself healthy. Two absences that are each survivable compose into one that is not, and no record names the composition. |

## Biases requiring human judgment

Both surfaced by this disposition rather than by the evaluator, and labelled as
such. The evaluator's five findings were all refinements; these are the two
questions the refinements exposed and cannot answer.

1. **Whether a zero-length `Response` is a defect or a supported outcome, which
   after E3 is the whole severity of one record.** Before the narrowing, the record
   claimed a handler failure reaches the client as a success, which is a defect
   whatever the contract says. After it, what is established is that an empty
   success is accepted at every layer that could reject it, and whether that is
   wrong depends entirely on an intent nobody wrote down. The evidence is genuinely
   balanced and both directions have something. For "defect": a reserved-and-never-
   written owned buffer is indistinguishable at `dispatch.rs:1031` from a
   deliberate empty body, the adjacent arms at `:1020` and `:1035` show the author
   guarding other malformed shapes in the same match, and the direct-output
   equivalent *is* caught at `commit`, which is an asymmetry someone should either
   justify or close. For "supported": `OutputBuffer::is_empty()`
   (`handler.rs:368-370`) is public API, so emptiness is a state callers are
   expected to reason about; nothing in `handler.rs:220-235` forbids it; and no
   consumer rejects it, including the Rust client (`client.rs:2022-2031`, verified).
   METHOD rule 3 forbids resolving this from the absence of documentation in either
   direction. *Judgment required:* answer the intent question first. If empty is
   supported, the record narrows again to "the response cannot disclose which of the
   two it did", which is probably a documentation fix. If it is not, the record
   stands as a missing lower bound and the direct-output asymmetry becomes a second
   finding.

2. **What `Exercised: partial` means now that one record is genuinely CI-executed
   and thirteen are not.** All three sibling inventories carry the unresolved
   question of whether a never-executed test makes a record `partial` or `not yet`,
   and 2e inherited the convention that a test's existence is enough. E1 makes the
   question sharper rather than answering it, because the catalog now contains both
   kinds: the divergent-codes record is `yes` on the strength of a test that runs on
   two platforms every time CI does, and twelve records are `partial` on the
   strength of tests that run when a developer types a command. Those are not the
   same claim and one word carries both. The distinction is load-bearing for anyone
   reading the catalog to decide what to work on: a `partial` backed by a
   CI-executed assertion is protected against regression, and a `partial` backed by
   an unexecuted assertion is a description of intent. *Judgment required:* either
   ratify the current convention and add a separate CI-execution field or marker per
   record, or split `partial` into two values. The second is cheaper to read and
   more expensive to retrofit across every part. Whichever is chosen, this is the
   first part in the catalog where the ambiguity has a concrete cost rather than a
   theoretical one, because it is the first where the two cases coexist.

## Verdict

The evaluator's verdict was **REFUTED**. After applying all five refinements the
honest verdict is not ready, and the reason has changed character: the sub-part's
findings and accounting are now accurate, and what remains is three missing
categories plus two decisions nobody has made.

What improved concretely. The sub-part's coverage position is better than it
claimed twice over: one record is CI-executed on two platforms, and the record that
was blocked outright is constructible from an in-crate test using a `pub` field and
a constructor that already exists in the tree. So **no record here is blocked**,
which none of the three sibling parts can say. One record's framing no longer claims
more than the code supports, and in narrowing it the disposition also established
which sibling record owns the case it gave up — the direct-output underfill, caught
at `commit` rather than at the gate. One unverifiable ordinal is gone and what it
was gesturing at survives as three named sites with three named oracles. And the
five silent exits are now three classes rather than one list, which immediately
exposed that the highest-consequence class, the one about admitted routed
settlement, is owned by no record at all.

Ready now for test implementation, in this order. Audit the CI-executed check E1
surfaced, because it is the only assertion in this sub-part that automation
protects and its adequacy is unaudited — that is
`/testing:invariant-test-review`'s job, not this method's, and it is the cheapest
valuable thing on the list. Then the in-crate pending-entry oracle E2 unblocked,
which is a fixture over `connection.rs:946-963`'s existing construction pattern.
Then tier 3's hostile handler, unchanged and still the highest-value tier, now with
E3's narrowing telling it to reserve an *owned* buffer specifically. Then tier 2's
five enumeration oracles, which were not disputed.

Not ready, for five reasons no further work of this kind resolves. The three queued
gaps are all missing categories rather than missing detail: an unowned silent exit
(G1), no liveness or reclamation property anywhere in a catalog about admission and
response obligations (G2), and a resolved unfairness fact with no record that
composes with G2 into an unbounded failure (G3). Bias 1 is upstream of one record's
severity and METHOD forbids resolving it from a missing doc comment. Bias 2 is
upstream of twelve records' `Exercised:` lines and is now the first place in the
catalog where the ambiguity costs something. And the fact none of these corrections
touches: 121 of this sub-part's 122 claim-bearing checks execute in no CI job, the
four doctests that do run bear on none of its records, and the workflow change at
the top of the leverage ranking still unblocks zero records while protecting all
121.

One process caveat. METHOD step 7 requires records to equal index rows to equal
evidence files. Records and index rows both equal 14 and their order matches;
evidence files remain at 14 and none was renamed. Four evidence files now understate
their records, because E1, E2, E3, and E5 moved verified material into the catalog
that the evidence files do not carry: the divergent-codes, pending-entry,
empty-response, and — through the framing section — the at-most-one records. This
disposition was scoped to `catalog.md`, `existing-checks.md`, and `fault-map.md`,
and was forbidden from touching `evidence/`, `_lenses/`, source, tests, or CI.

A second process note on scope, identical to 2d's. The brief named four files to
edit and six were edited: both parts' `catalog.md` and `fault-map.md`, plus both
`existing-checks.md` files, because E1 and 2d's D4 explicitly instruct "correct the
inventory" and the inventory is `existing-checks.md`. The brief's file count and
the corrections it mandates were inconsistent; the mandated corrections were
followed.

## What this evaluation says about the method

Part 4c's evaluation named a pattern and prescribed a guard: five of its sixteen
refinements were cases where the artifacts already contained the correction
somewhere and the record or summary did not use it, and the guard was a
cross-reference pass — for each record, grep the other artifacts for its slug and
its identifiers, and read what comes back. **Three of this part's five findings are
that pattern again, and two of them are its purest form yet.**

E1 is the sharpest. `existing-checks.md` lists `lifecycle` in its CI-name table,
twice, with line numbers. `catalog.md`'s divergent-codes record says
`Existing check: none`. A grep for `lifecycle` across the artifacts returns the
CI-name table; a grep for `server_busy` or `target_unavailable` across the test tree
returns the test. Neither was run. E4 is the same in one file: the catalog states
the ordinal as a headline and marks it unverified in the same paragraph. E2 is the
same against source rather than artifacts: the claim "no in-crate test constructs a
`GenerationCore`" is refuted by a `grep -n 'GenerationCore {' crates/mc-host/src/`.

The new lesson is about *classification units*, and it comes from E1 and E5
together. E1's error is invisible from inside its own taxonomy: an inventory that
enumerates binaries by subject cannot see a record asserted by a binary with a
different subject, no matter how carefully it counts. E5's error is the mirror
image: an enumeration that lists five code sites under one heading cannot see that
one of them is about a different thing, no matter how carefully each site is
verified. Both are correct enumerations of the wrong unit. The guard is a question:
*is this list grouped by what I am claiming, or by where the code lives?* For the
inventory the claim is "which records does CI protect" and the grouping was by
binary subject. For the silent exits the claim is "what fails to get a terminal"
and the grouping was by textual adjacency in one file. Re-grouping by the claim
found a missing record in one case and a miscredited test in the other, and neither
needed any new code reading.

## Re-evaluation trigger

A fresh pass is warranted once G2 is mined, because it adds a category rather than
adding inside one. A bounded progress or reclamation property would be this
sub-part's first `liveness` record, its bound would have to be stated in units the
code does not currently bound — which forces the design question in
`req-a-a-handler-outliving-every-host-deadline-is-reached`'s open question into the
open — and its oracle is a post-load quiescence measurement, which is a kind of
oracle no record here has. G3 fires the same trigger for a related reason: a
fairness property would be the sub-part's first over *two connections* rather than
over one request or one generation.

Four other triggers, each firing independently:

- Any resolution of bias 1. Either answer changes
  `req-a-a-handler-response-is-length-checked-and-never-content-checked`: one
  narrows it to a disclosure gap and probably a doc fix, the other leaves it
  standing as a missing lower bound and promotes the direct-output asymmetry to a
  finding of its own.
- Any resolution of bias 2. It changes twelve `Exercised:` lines here and the same
  field across every sibling part, and it is the first time the ambiguity has a
  concrete cost.
- Any `written` hook added to a routed terminal, or any per-exit counter at the five
  silent exits. The first gives two Group C records the evidence they say they
  lack; the second gives G1 an observation point and the reachability half of three
  existing records at once.
- Any workflow change that names one of the six subject binaries, or runs the
  `mc-host` lib target. `tests/dispatch.rs` alone holds 20 tests that are the real
  coverage for this sub-part's arbitration claims, and the day CI names it, the
  meaning of `partial` changes across twelve records and bias 2 partly answers
  itself.
