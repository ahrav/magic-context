# Sub-part 2d portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md`. Its
charter was to expose systematic gaps rather than to agree. Its verdict was
**REFUTED**, and this file records that honestly rather than softening it: the
evaluator did not find a portfolio needing polish, it found five load-bearing
premises that do not hold.

The shape of the findings differs from the sibling parts. Part 4a's evaluation
mostly refuted availability claims on the fault map. Part 4b's mostly refuted
claims inside the records. Part 4c's did both and added records whose stated
workload could not produce their state. This one is different again: **three of
the five findings are cases where the catalog asserted a consequence it had not
established**, and the code says the consequence does not occur. An impossible
enabling branch presented as merely unresolved (D1). A misattribution presented
as proved when the mechanism prevents it (D2). A host behaviour presented as a
suspected defect when the host has no path that produces it (D5). The other two
are accounting errors, one arithmetic and one an unread test (D3, D4).

Four lenses: harness fit, coverage balance, implementability, and a wildcard pass
questioning the framing.

Every finding below was re-verified against the code before acceptance. **All five
refinements were accepted and applied; none was rejected.** Two carried a premise
this disposition sharpened, and one carried a premise that turned out to be
*stronger* than the evaluator stated, which is recorded because the stronger
version changes what survives.

Provenance for this pass. `HEAD` is `e447c927` ("refactor(shm): trim final review
leftovers"), which is what the three artifacts already state. The working tree of
the read-only source system is clean apart from untracked directories. Every
`client.rs` reference below was read back individually at that commit. References
outside `client.rs` verified for this disposition: `wire.rs:540-602` and `:45-89`
and `:336-346`; `connection.rs:70-103` and `:185-210`; `dispatch.rs:1160-1239`;
`routing.rs:112` and `:191-205`; `setup_socket.rs:81-85`; `synapse/mod.rs:960-963`;
`control.rs:15-16`; `tests/shm_soak.rs:1-120`; `tests/shm_failure_modes.rs:185-244`;
`.github/workflows/ci.yml:105-200`; `docs/mc-host-wire-protocol.md:689-693`. One
grep is load-bearing for D5 and is recorded as a fact rather than an impression:
`rg 'module_timeout' crates/` returns exactly one hit, `client.rs:518`.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 5 | 5 applied, 2 with a sharpened premise, 1 stronger than stated |
| gap | 1 | queued for a follow-up pass, not mined |
| bias | 1 | requires human judgment |

Record count **14 to 14**. Nothing was added and nothing was invalidated. One
record was reframed and renamed rather than invalidated, which is the choice D1
asked for and which is justified below.

Semantics distribution **12 `always`, 0 `always-or-unreached`, 1 `sometimes`,
0 `reachable`, 1 `unreachable`**, against 11/1/1/0/1 before. The single move is
D1's: the sub-part's only `always-or-unreached` became `always` once its optional
branch was proved impossible rather than merely unreached. That is the correct
outcome rather than a loss of nuance — `always-or-unreached` exists for a path that
*may* never run, and this path *cannot* run, so the semantics were describing
uncertainty that does not exist.

Types **11 safety, 2 reachability, 1 liveness**, unchanged. D1 kept its record in
safety, and D2's demotion changed a record's consequence without changing what kind
of claim it is.

Reachability-class labels **14 `default-production`, 0 `explicit-config-only`,
0 `test-only`**, unchanged. No finding touched a label; the four-fact argument in
the catalog's reachability section was not disputed and was spot-checked here
(`Client::connect` is `pub` and ungated at `client.rs:306`).

Fault-map totals **10 non-vacuous today, 3 partial, 1 not constructible**, against
8/3/3 before. Four rows moved: three to `Yes` (D1, D3, D5) and one from `Yes` to
`Partial` (D2). The pessimistic move is the only one, and it is the one that
matters most, because it is a consequence being withdrawn rather than a capability
being found.

The count of rows needing no fault at all moved from a stated **six to eight**,
which is D3's arithmetic correction. Every one of the eight rows that already
carried `Yes` opens with the words "No fault"; the text that summarised them said
six.

Test counts are unchanged and were not disputed: 40 in-crate tests in
`client.rs`'s single `mod tests`, 6 integration tests in
`crates/mc-host/tests/client.rs`, 0 doctests, 24 integration binaries of which 8
touch `client.rs`. What changed is what two of those binaries are credited with
covering (D4).

## Refinements applied

Applied in the order the evaluation supplied, because two interact: D2 and D4 both
edit the bridge-thread material, and D4's correction supplies the partial credit
that D2's surviving half needs.

### D1. The dropped-`Pong` record rested on an impossible branch, and is reframed rather than invalidated

Applied in `catalog.md`: the record is renamed
`client-a-a-dropped-pong-is-never-observable-to-the-client` to
`client-a-a-failed-pong-enqueue-retires-the-generation-as-a-local-fault`, with a
new `Guarantee`, `Check`, `Fault/timing angle`, `Required faults`, `Confidence`,
`Existing check`, `Impact`, and open question; the index row's slug and confidence
change; the Group D heading and preamble are rewritten; and the relationship map's
first cluster is updated. In `fault-map.md`: the map row moves from `No` to `Yes`,
the coverage-check marker is renamed and retargeted, and the totals change.

The original record claimed that a `Pong` the client fails to enqueue "for a reason
that does not retire the generation" leaves no trace. There is no such reason.
`send_control` has exactly three failure paths (`client.rs:1326-1362`) and the
class the record needed is empty:

- The encode branch (`:1329-1335`) **cannot be entered for a `Pong`**.
  `encode_owned_frame` (`wire.rs:571-601`) returns `Err` on one condition,
  `body.len() > MAX_BODY_LEN` (`:577-583`), and the `Pong` call passes `Vec::new()`
  (`client.rs:1329`). Zero is not greater than 64 MiB. The record's own open
  question asked whether this branch was reachable and marked it unresolved; the
  answer is no, and it needed one file read to get.
- The charge branch (`:1340-1347`) calls `self.retire("control_capacity_exhausted")`
  before returning.
- The try-send branch (`:1355-1361`) does the same.
- The early return at `:1326-1327` fires only when `retired` is *already* true, so
  the record's premise that "the client still believes it is healthy" is false
  there by construction.

**The choice made, and why.** The evaluation offered invalidation or reframing.
Reframing was chosen, for three reasons. First, a live and checkable property sits
on the same mechanism: a failure to answer a host liveness probe is escalated to a
full-generation teardown carrying a code that names the *pool* rather than the
probe, and the `let _ =` at `:1390` means the `Ping` arm proceeds as though it
answered. That is falsifiable, it is `always` over a total disjunction, and it is
not what the original record said. Second, invalidating would have discarded the
one part of the original that survives intact: the `let _ =` at `:1390` is real and
it is the reason the teardown is unattributed. Third, the reframed record has an
*existing partial fixture* — `control_exhaustion_retires_and_releases_all_queued_bytes`
(`:3196`) already drives the charge branch to retirement from a different caller —
so it moves from the fault map's blocked column to constructible, which
invalidation would have thrown away.

**What the reframing costs, stated rather than hidden.** The record is less
alarming than it was. The original said the client silently believes it is healthy
while the host retires it; the truth is that the client tears its own generation
down. The finding is now about attribution, which folds it into
`client-a-a-retired-generation-forgets-why-it-retired` rather than standing alone,
and the record says so.

**Process caveat.** The evidence file is still
`evidence/client-a-a-dropped-pong-is-never-observable-to-the-client.md` and its
name no longer matches its record. The link is deliberately left resolving, per
Part 4c's precedent for renamed records, and the file needs retitling in an
evidence pass. This disposition was not scoped to `evidence/`.

### D2. Two bridge-departure records overclaimed, and the over-count direction does not exist

Applied in `catalog.md`: the second framing fact in "What this part is about" is
split and rewritten, the Group B heading and preamble are rewritten, the
ring-failure record's `Guarantee`, `Check`, `Fault/timing angle`, `Required
faults`, `Confidence`, `Impact`, and open questions are edited, and the
close-ordering record's `Guarantee`, `Required faults`, `Confidence`,
`Existing check`, `Impact`, and open questions are edited. In `fault-map.md`: the
ring-failure row moves from `Yes` to `Partial` and the close-ordering row is
recharacterised.

Two claims were wrong and they were wrong in different ways.

**The under-count direction is unproven, not disproved.** The catalog said a client
whose ring collapsed "departs looking clean", so the host skips `record_peer_death`.
The *attempt* is unconditional and that part holds: `:1890-1893` sits outside every
`break`. But `:1890` is `if let Ok(goodbye)` and `:1891` is
`let _ = setup.write_all(&goodbye)`, so neither the encode nor the write is proved
to have happened — the result is discarded, which `existing-checks.md` already
recorded in its `let _ =` cluster without connecting it to this record. And the
host's watcher is a `biased` select whose *first* arm is
`peer_read_cancel.cancelled()` (`connection.rs:196-198`); a generation already
retired from ring evidence never reaches the `close != PeerClose::Goodbye`
comparison at all. So the consequence needs two facts this sub-part cannot
establish, and the row is `Partial`.

**The over-count direction does not occur.** The catalog said a clean owner close
can outrun its goodbye and "present to the host as an abrupt EOF". It cannot, for
two independent reasons, either of which alone is sufficient:

1. `close` sends a ring channel-0 `Goodbye` through `send_control_wait` (`:702`)
   *before* `cancel.cancel()` at `:711`, and that call returns only after the
   writer's per-frame completion channel resolved `Ok(Ok(Ok(())))` and the `ack`
   fired (`:1957-1971`). So the goodbye is published to the ring before the close
   proceeds. The host retires from that, which trips `read_cancel` and takes the
   watcher's first select arm.
2. The setup socket is *moved into the thread closure* at `:1854`. `close`
   returning closes nothing. There is no EOF for the host to observe at that
   instant, abrupt or otherwise.

**Premise strengthening, in the honest direction.** The evaluation said the
close-before-write case "does not create an abrupt EOF, because the bridge still
owns the socket and close already sends a ring goodbye". Both halves are correct
and the second is stronger than stated: it is not merely that close sends a ring
goodbye, it is that close *waits for it to be published* before cancelling. That
matters because it closes the remaining doubt — one might otherwise ask whether a
goodbye enqueued but unpublished leaves the host's watcher armed. It does not, on
the `Ok` path. The record's new second open question records the one residual: the
`close` that times out waiting for its goodbye returns `Err`, so it does not
satisfy the record's own precondition (a).

**What survives, and it is worth keeping.** `close` returns while a detached OS
thread still holds the setup socket, the ring attach, and the write-completion
channel. Protocol `:691` says connection close is "followed by joined ring teardown
and setup-socket close". This teardown is not joined. That is a contract gap and it
is exactly the gap queued below; it is not a peer-death miscount, and the record no
longer says it is.

### D3. The harness accounting was wrong twice, once arithmetically and once against its own leverage ranking

Applied in `fault-map.md`: the totals paragraph is rewritten, the third framing
point is rewritten, the `C5` class row's duplicate-bind half inverts, the
duplicate-bind map row moves from `Partial` to `Yes`, and leverage items 5 and 9
are corrected.

**The arithmetic.** The totals paragraph said "six of them need no fault at all".
Counting the rows is unambiguous: of the eight rows that carried `Yes`, every
single one opens with the words "No fault" —
`client-a-a-retired-generation-forgets-why-it-retired`, the ring-failure departure
record, both in-flight-work records, the route-bound record, the `host_shutdown`
predicate, and both inbound-classification records. Eight, not six. Counting the
whole table for rows that prescribe no fault or a pure enumeration gives ten of
fourteen. The corrected text says eight of the (now ten) `Yes` rows and ten of
fourteen overall.

**The self-contradiction.** The duplicate-bind row said its two-successful-opens
clause "needs `C5`'s duplicate half, which needs a host answering two correlations
with one `(channel, epoch)`", and `C5` said that needs "the fake host this tree
lacks". Leverage item 5 of the *same file* (`:326-331` in the pre-disposition text)
proposed the answer: forge the response instead of soliciting it. Leverage item 5
was right, and the map row was wrong. The mechanism already exists in the suite:
`an_abandoned_control_open_releases_a_late_bound_route` (`client.rs:3503-3584`)
hand-builds `{"op":"route.open","route_channel":9,"route_epoch":3}` at `:3547-3552`
and feeds it to `inner.dispatch` at `:3553-3565`. Two `open_route` futures over a
`Client` built on a synthetic `Inner` — the struct literal at `:431` is reachable
from `mod tests`, which is a child module — plus two such forged responses carrying
one `(channel, epoch)` produces the state. No fake host, no ring.

This is the same failure mode Part 4c's evaluation named: **precision does not
propagate sideways**. Advice recorded in one section of an artifact was not applied
to the table in another section of the same artifact. The corrected map row cites
leverage item 5 explicitly so the two cannot drift apart again.

### D4. Two CI-executed tests observe the bridge thread, and the inventory said nothing did

Applied in `existing-checks.md`: quiet area 1 is rewritten, a note is added under
the fixture-binary table, the "entire CI-executed coverage" sentence is corrected,
and the sampling-limits bullet about counting fixture binaries by occurrence is
rewritten to own the consequence. In `catalog.md`: the sixth framing fact is
rewritten, the CI-coverage sentence is corrected, the relationship-map preamble is
qualified, and the close-ordering record's `Exercised` and `Existing check` lines
change.

The claim was that the bridge thread "is tested at no level" and that "no
integration test observes the thread or the socket". The second half is true of the
six `tests/client.rs` tests. Both are false of the tree.

`tests/shm_soak.rs` runs a real `Client::connect` / `open_route` / `request` /
`close_route` / `close` cycle (`:54-92`) and then calls `wait_for_envelope`
(`:35-52`), which polls until `counts.threads == baseline.threads` or a 10-second
budget expires. `tests/shm_failure_modes.rs` does the same through
`assert_resources_return_to` (`:193-210`), called twice by
`clean_close_returns_exact_single_connection_capacity` (`:218-230`) around a real
connect and close. The client's detached bridge thread is one of the process's
threads. A thread that never left its loop at `:1866` holds the count above
baseline and fails both assertions.

Both run in CI. `ci.yml:130-135` is a single "Mandatory ring client suite" step
whose three commands are `cargo nextest run -p mc-host --test client`,
`cargo test -p mc-host --test shm_failure_modes -- --test-threads=1` (unfiltered,
so `:218` runs), and `cargo test -p mc-host --test shm_soak
short_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded -- --exact`, which is
the test that calls `run_soak` and therefore `cycle`.

**Precision the evaluation did not state, and it decides how much of the quiet area
survives.** What these tests observe is *termination*, not departure. They say
nothing about which of the five `break`s fired, whether `:1891` wrote anything,
whether the goodbye's content distinguished the cause, or the 50-microsecond spin.
So the seam is narrower and still real, and one of the three normative claims it
carries changes status rather than being covered: connection close as a bounded
joined teardown (`:691`, `:741`) is now **contradicted** rather than unchecked,
because `join_tasks_until` demonstrably does not join this thread while these tests
demonstrate it does eventually exit.

**Why it was missed, recorded because the mechanism is reusable.** The inventory's
own sampling-limits section says the seven fixture binaries "were counted by
`Client::connect` occurrences, not read". Counting occurrences classified both
binaries as fixture users and closed the question. The evidence for the correction
was in this file's own table the whole time.

### D5. The route-retry record's premise has no producer, and the record is restated

Applied in `catalog.md`: the record's `Exercised`, `Guarantee`, `Fault/timing
angle`, `Required faults`, `Confidence` (medium to high), `Existing check`,
`Impact`, and both open questions are rewritten, its index confidence changes, and
the Group F preamble is amended. In `fault-map.md`: the map row moves from `No` to
`Yes` and leverage item 9's cautions are rewritten.

The original record's recipe was a peer that answers `route.open` with a retried
terminal *and* binds a route. The current host has no such exit. `dispatch.rs`'s
bind path (`:1177-1238`) has four outcomes and every one of them is safe:

- `Accept` plus `BindInstall::Installed` installs the bind and emits the success
  response (`:1178-1193`). A bind always comes with a success.
- `Accept` plus `BindInstall::CloseWins` publishes nothing (`:1195-1202`).
- `Reject` calls `shared.registry.take_rejected_bind(handle)` at `:1219`, which
  cancels the occupant and marks it `Closing` (`routing.rs:191-205`), and only then
  runs route-gone and emits the error terminal (`:1220-1236`). The bind is cleaned
  *before* the code the client will retry on.
- The stopped-callback arm takes the rejected bind and emits nothing (`:1164-1170`).

And the codes reachable at all are emitted either pre-bind or post-cleanup:
`unknown_module` and `target_unavailable` are pre-bind classification
(`control.rs:15-16`, with capacity exhaustion documented as happening "without any
handler bind" at `routing.rs:112`), and `module_reloading` is a handler bind
rejection (`synapse/mod.rs:960-963`) that takes the `Reject` arm.

**The finding that survives is sharper than the one it replaces.** `module_timeout`
— the code the whole original recipe was built on — has **no producer anywhere in
the tree**. `rg 'module_timeout' crates/` returns one hit, and it is the client's
own allowlist at `client.rs:518`. So the client retries on a code its own host
cannot send. That is a concrete, cheap, enumerable defect on this side of the
boundary, and it replaces a suspected defect on the other side.

**Restated rather than marked gone, and why.** The evaluation offered either. The
premise is not gone; it is *satisfied by a host-side ordering the client neither
checks nor is told about*. That is a real cross-part coupling: nothing in
`client.rs` derives the retry allowlist from the host's emitted code set, and a
future host that emitted a retried code after installing a bind would strand a
route and channel permit per retry. Recording it as a coupling keeps the property
falsifiable and raises confidence from `medium` to `high`, because the question the
original could not answer is now answered against the current host.

## Gaps queued for a follow-up pass

Recorded, not mined. Verified for this disposition.

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | **No property requires `close` to join the bridge thread before returning.** The catalog has fourteen records and none of them states the obligation the protocol states. `join_tasks_until` (`client.rs:1677-1695`) iterates exactly `[&self.writer, &self.reader]` at `:1682`; the bridge thread's `JoinHandle` is discarded at `:1895` and `Inner` (`:934-960`) has no field for it. Protocol `:691` reads "Connection close is Goodbye on channel 0, epoch 0, correlation 0, followed by joined ring teardown and setup-socket close", printed and confirmed. So `close` returning `Ok` is compatible with a live OS thread holding the socket, the ring attach, and the sole write-completion producer. The close-ordering record describes the *window* as reachable, which is a `sometimes` claim about an ordering; it does not assert the *obligation* that the window should not exist. Those are different properties with different semantics and different oracles: the second is `always` over every `close` that returns `Ok`, and its oracle is a thread-identity check rather than a race observation. D2 removed the misattribution that had been standing in for this obligation, which is what makes the absence visible. |

## Biases requiring human judgment

1. **Whether a Byzantine host is in scope, because several records demand the
   client defend itself against a lying host and that conflates two different
   obligations.** The evaluator raised this as a framing bias and judged that the
   framing "does surface real teardown defects", so the frame is not worthless —
   that assessment is recorded here rather than paraphrased away, because it is the
   reason this is a bias and not a refutation. Four records rest on a host that
   violates the protocol:
   `client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle` needs a
   host that answers two correlations with one `(channel, epoch)`;
   `client-a-host-shutdown-success-rests-only-on-a-json-echo` needs a host that
   echoes `{"op":"host.shutdown"}` and keeps serving;
   `client-a-a-host-originated-cancel-retires-the-generation` needs a host emitting
   a frame the role table arguably forbids; and after D5,
   `client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind`
   needs a host that answers a retried terminal after installing a bind, which no
   conforming host does. Each of these is simultaneously a client-hardening claim
   and a host-conformance claim, and the catalog does not say which it is filing.
   The distinction is not cosmetic, because it decides three concrete things: what
   the fake-host fixture at leverage item 9 is *for*, whether a "defect" here is a
   defect in this crate or a missing conformance vector against a hypothetical
   peer, and whether the `Cancel` strictness at `validate_inbound:2067` is a
   feature or a bug. *Judgment required:* declare the threat model. If a
   non-conforming host is in scope — which is defensible, since `mc-module`
   connects to a host it did not build and protocol `:296` already enumerates
   client-side retirement causes — then these four records stand, the fake host is
   a conformance harness, and the client's strictness is correct by construction.
   If it is not in scope, then the host-conformance halves belong in a
   host-conformance artifact and what remains here is only the teardown material,
   which the evaluator specifically judged to be real: the erased retirement cause,
   the unjoined thread, the unbounded route cache, and the dead `module_timeout`
   allowlist entry. Either answer is defensible. Leaving it implicit means the next
   reader cannot tell a hardening catalog from a conformance catalog, and the
   fake-host fixture keeps looking like a prerequisite when for three of the four
   records it is only an end-to-end confirmation.

## Verdict

The evaluator's verdict was **REFUTED**. After applying all five refinements the
honest verdict is still not ready, and the reason has changed shape: the catalog's
overclaims are gone, and what remains is a threat-model decision nobody has made
plus one missing obligation.

What improved concretely. One record no longer rests on a branch that cannot
execute, and it moved from the fault map's blocked column to constructible with an
existing fixture behind it. Two records no longer assert consequences the code
prevents: the peer-death signal is now recorded as under-reporting *conditionally*
and over-reporting *not at all*, which is one direction rather than two. One
record's premise was resolved against the current host, raising its confidence and
turning a suspected host defect into a concrete client-side one — the
`module_timeout` allowlist entry with no producer anywhere in the tree. Two
accounting errors are fixed: eight rows need no fault rather than six, and the
duplicate-bind clause is constructible today by a mechanism the same file's own
leverage ranking had already identified. And the bridge thread is no longer
described as untested at every level, which matters beyond the correction itself:
it converts one normative claim from unchecked to contradicted.

Ready now for test implementation, in this order. The two enumeration oracles D5
and D3 unblocked, because both are a single pass over code that is already read:
the host's bind-exit ordering plus the `module_timeout` census, and the forged
duplicate `route.open` on the synthetic inner. Then the reframed `Pong` record,
which needs a `Ping` delivered into an exhausted `control_budget` and has half its
fixture at `:3196` already. Then the three direct-call oracles the fault map's
tier 3 lists, which remain the highest-value tier and were not disputed.

Not ready, for four reasons no further work of this kind resolves. The threat-model
bias is upstream of four of the fourteen records and cannot be settled from inside
the part. G1 is a missing obligation rather than a missing detail, and D2 is what
made it visible by removing the claim that had been occupying its place. The
`eof`-comparison record still needs a ring-fault seam (`C2`) that does not exist,
and 2b's fault map records the host-side analogue as equally unavailable. And the
largest fact about this sub-part is untouched by every correction above: 40 of its
46 claim-bearing tests execute in no CI job, there are zero doctests, and the
workflow change at the top of the leverage ranking still unblocks zero records
while protecting forty test functions.

One process caveat, stated rather than hidden. METHOD step 7 requires records to
equal index rows to equal evidence files. Records and index rows both equal 14 and
their order matches. Evidence files remain at 14, but one is now misnamed:
`evidence/client-a-a-dropped-pong-is-never-observable-to-the-client.md` documents a
record now called
`client-a-a-failed-pong-enqueue-retires-the-generation-as-a-local-fault`. The link
is left resolving deliberately, following Part 4c's precedent for renamed records,
and the file needs retitling and a content pass in an evidence pass. Three other
evidence files now understate their records' content, because D2, D4, and D5 moved
material into the catalog that their evidence files do not carry: the
ring-failure, close-ordering, and route-retry records. This disposition was scoped
to `catalog.md`, `existing-checks.md`, and `fault-map.md`, and was forbidden from
touching `evidence/`, `_lenses/`, source, tests, or CI.

A second process note on scope. The disposition brief named four files to edit.
Six were edited: both artifacts' `catalog.md` and `fault-map.md` as expected, plus
both `existing-checks.md` files, because D4 and its 2e counterpart explicitly
instruct "correct the inventory" and the inventory is `existing-checks.md`. The
count in the brief and the corrections it mandates were inconsistent, and the
mandated corrections were followed.

## What this evaluation says about the method

Part 4a's evaluation found absence of a named seam read as absence of the
capability. Part 4b's found records whose own fields disagreed with each other.
Part 4c's found both plus checks that could not fail on their own record's
scenario, and named the guard: read each finished record end to end as a single
argument. This part's evaluation says a fourth thing, and it is the sharpest of
the four because it is about *consequences* rather than about mechanisms.

Three of five findings here are the same error: **the mechanism was verified and
the consequence was assumed.** D1 verified that the result is bound to `_` and
assumed the failure it swallows can occur. D2 verified that the goodbye write is
unconditional and assumed the host therefore classifies it as clean, and verified
that `close` joins only two tasks and assumed the host therefore sees an EOF. D5
verified the retry predicate and assumed a host could produce the state it makes
dangerous. In every case the mechanism reading was correct and careful, the
citation was right, and the sentence after it was not checked. The guard is a
question with a yes-or-no answer, and it is different from Part 4c's: *for this
record's stated consequence, what code produces the state it needs?* Name the
producer. For the swallowed `Pong` there is none. For the abrupt EOF there is none.
For the retried-terminal-after-bind there is none. Each took one file read to
settle, and each had been left as an open question or asserted as fact instead.

The second lesson is Part 4c's, recurring unchanged in D3 and D4, and it is now
seen three parts in a row: the correction was already inside the artifact. The
fault map's leverage item 5 contradicted the fault map's own table. The
existing-checks fixture table listed the two binaries whose bodies refute the
existing-checks quiet area. Part 4c prescribed a cross-reference pass — for each
record, grep the other artifacts for its slug and its identifiers, and read what
comes back — and this part shows the pass is still not being run. D3 and D4 would
both have been caught by it.

## Re-evaluation trigger

A fresh pass is warranted once the threat-model bias is resolved, because either
answer changes the record set rather than the record contents. If a non-conforming
host is in scope, the fake-host fixture becomes a conformance harness and four
records gain a shared oracle they currently lack. If it is not, four records lose
their host-side halves and the part shrinks to teardown and accounting, which is a
different catalog.

Four other triggers, each firing independently:

- Any resolution of G1 into a record. A joined-teardown obligation would be the
  part's first `always` claim over `close`'s postcondition rather than over a
  window, and its oracle is a thread-identity check, which is a kind of oracle the
  part does not currently have.
- Any retained `JoinHandle` or test-only bridge-thread status signal. It supplies
  precondition (b) of the close-ordering record and simultaneously closes the
  window that record describes, so it changes both the record and its own remedy in
  one edit.
- Any ring-fault seam inside `RingClientEndpoint::send` or `try_recv_with`. It is
  the only route to the `eof` comparison and to the runtime half of the demoted
  ring-failure record, and D2's demotion means it now has two facts to establish
  rather than one.
- Any workflow change that runs the `mc-host` lib target. Every `Exercised:` line
  on the 40 in-crate tests is written against a suite no automation executes, and
  the day one runs, "partial" changes meaning across the part. This is the same
  trigger Parts 2b and 4c recorded, unresolved, and it remains the largest single
  fact about this sub-part.
