# Sub-part 2b portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the
discovery reasoning, against `catalog.md`, `existing-checks.md`, and
`fault-map.md`. Its charter was to expose systematic gaps rather than to agree.
Four lenses: harness fit, coverage balance, implementability, and a wildcard pass
questioning the framing. **Its verdict was REFUTED**, and that is recorded here
without softening: the evaluator did not find a portfolio needing polish, it
found one whose headline claim contradicted its own records, whose totals counted
a static absence as runtime coverage, whose one blocked record was not blocked,
and whose only liveness bound did not hold.

The shape of the findings differs from Part 4c's, which was the last part to get
this treatment. Part 4c's evaluation mostly found checks that could not fail on
their own record's scenario. This one found something closer to the root: **four
of the six findings are cases where the artifacts asserted an absence they had
not enumerated.** Recovery was said to be owned by nothing when two of its three
duties have owners. Quarantine was said to be unraisable from the host when a
public method raises it. Two records were said to be non-vacuous when their own
`Exercised:` lines said unconstructible. And a liveness bound was said to be
stated "in the units the code bounds" when the code bounds only one of the three
things the bound named.

Provenance for this pass. `HEAD` is `e447c927` ("refactor(shm): trim final review
leftovers"), which is what the three artifacts already state, and the code was
read read-only from `/local/home/ahrav/scratch/magic-context` at that commit.
Every line reference this disposition adds or repeats was opened individually.
Two files that the artifacts cite by a shortened name were located precisely for
this pass, because the short name is ambiguous in the tree: `ring.rs` is
`crates/mc-shm-transport/src/backend/ring.rs` (there are three files named
`ring.rs`), and `profile.rs` is `crates/mc-shm-transport/src/profile.rs`.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 6 | 6 applied, 2 with a corrected or sharpened premise |
| shared refinement | 2 | 2 applied (S1 reachability evidence, S2 line references) |
| gap | 1 | queued for a follow-up pass, not mined |
| bias | 2 | require human judgment, and one of them decides a recount |

Record count is **unchanged at 14**. No refinement removed, added, or split a
record. Two records changed type or semantics in place.

Types **8 safety, 5 reachability, 1 liveness**, against 7/6/1 before.
`ring-a-no-producer-retains-a-committed-release-identity` moved from
`reachability` to `safety` under B1.

Semantics **8 `always`, 1 `always-or-unreached`, 2 `sometimes`, 2 `reachable`, 1
`unreachable`**, against 7/1/1/3/2 before. `always(!X)` counts as `always`,
following the convention Parts 4a through 4c used. Two moves: the release-identity
record from `unreachable` to `always` (B1), and the doctor record from `reachable`
to `sometimes` (B2). The part keeps one `unreachable`, on
`ring-a-host-never-quarantines-an-admission-charge`, and that one is now flagged
rather than defended — see bias 1.

Reachability-class labels: **10 `default-production`, 2
`compiled-with-no-production-producer`, 1 mixed
production-plus-no-host-caller, 1 mixed host-production-plus-client-side-subject,
0 `test-only`**, against a blanket "all 14 `default-production`" before. The
blanket claim was in both the catalog's framing and the fault map's map preamble,
which METHOD.md rule 4 forbids by name. Every record now carries its own evidence
clause, and the four non-uniform cases say what they are instead of defaulting.

Fault-map totals **7 non-vacuous today, 5 partial, 2 not constructible**, against
8/5/1 before. One row moved `No` to `Yes` (B4) and two moved `Yes` to `No` (B3).
The part no longer has a record that nothing can construct for want of a
capability; the two `No` rows are unsatisfiable by construction, which is what
those records set out to prove. **The recount is conditional on bias 1**, and the
alternative total is stated in `fault-map.md` rather than hidden: if census
records do not belong in the catalog, four records leave and the totals become
5/5/0 over 10.

Test counts are unchanged and the evaluator disputed none of them: 35 in-crate
tests reaching the sub-part, none in CI, two `compile_fail` doctests in CI
(`ci.yml:190` over `frame_channel.rs:296-308`), and ten integration binaries
using `support::TestHost` of which four are named in CI.

## Refinements applied

Applied in the order the evaluation supplied, because several interact: B6 rewrites
the framing that B3's and B4's rows lean on, B2 and B4 both change fault-class
availability, and S1 touches all 14 records.

### B1. The release-identity record misused `unreachable`, and is now safety

Applied in `catalog.md` on
`ring-a-no-producer-retains-a-committed-release-identity`: `Type`, `Check`,
`Reachability`, `Exercised`, `Required faults`, `Confidence`, the index row, and
the relationship map's "Ownership as the premise" cluster.

The record claimed `unreachable` over `Ring::release` (`ring.rs:849`) "never
entered with an identity that originated from `commit`", and defended the choice
as "a statement about a specific code location being unentered on a specific
argument provenance". That defence contains its own refutation. METHOD.md reserves
`unreachable` for a code location that must never execute, and `Ring::release`
executes constantly: `ring_release_callback` (`ring.rs:1255-1262`) calls it on
every lease drop, carrying a lease-derived identity, which the record itself says
one sentence later. A location that runs on every frame is not an unentered
location. What the property restricts is the **provenance of an argument** at a
shared function, and provenance is a state with no dedicated detection point, so
METHOD.md's rule gives `always(!X)`.

**The choice made, and why.** The evaluation offered two options: retype as safety
with `always`, or keep it explicitly as a static architecture assertion. Safety
with `always` was chosen. The deciding fact is that this property has a
consequence a runtime check could observe, unlike the two census records in Group
F. A producer that retained its identity and called `release` would release a
sequence a consumer may still hold a lease on, which is an authority violation
with a live victim; a `#[cfg(debug_assertions)]` counter on the producer-identity
path expresses exactly that and must stay at zero. That is a safety invariant on
who may release, not coverage of a code point, so the `Type` moves to `safety` as
well as the semantics to `always`. Keeping it as a declared static assertion was
rejected because it would put a genuinely falsifiable claim in the same category
as `ring-a-rejected-drain-failure-close-has-no-producer`, whose check no execution
can satisfy at all, and that conflation is what bias 1 exists to resolve.

**What did not change.** The finding, the enumeration, and Part 1's carried-over
verdict are untouched. `commit` still returns `Result<ReleaseIdentity,
ProducerError>` (`ring.rs:1354`), all nine call sites still discard it, and Part
1's `release-authority-bound-to-lease-ownership` and
`release-exactly-once-per-sequence` still keep their producer-side reachability
labels.

### B2. The doctor record had the wrong boundary and the wrong semantics

Applied in `catalog.md` on
`ring-a-host-doctor-emits-one-of-five-declared-terminal-classes`: `Reachability`,
`Exercised`, `Guarantee`, `Check`, `Fault/timing angle`, `Required faults`,
`Confidence`, `Existing check`, `Impact`, and the open question. Also in the Group
D preamble, and in the relationship map, where the record leaves the
"machinery with no input that reaches it" cluster and its entry in the "cause that
existed and was thrown away" cluster is rewritten. In `fault-map.md`: the map row,
the coverage-check section (which now names two `sometimes` records and assigns
the second a marker name), and leverage item 2.

The record asserted `reachable` over "five distinct emission points" in the host
and reported the finding that "four of the five points do not exist at all". The
premise is wrong in a way that changes the record's subject. The five points do
not exist because the host was never supposed to have them: the terminal report is
built **client-side**. `classifySharedMemoryFailure`
(`packages/plugin/src/shared/mc-host-client/shared-memory-failure.ts:10-30`) maps
an observed error to a `SharedMemoryTerminalClass` (`types.ts:68-73`), and
`policy.ts:648-672` passes the result to `terminalSharedMemoryDiagnostics`
(`policy.ts:854-872`), which constructs the entire terminal object — `state`,
`error_class`, zeroed `bounds`, `accounting: null`, and both derived counters —
without consulting the host. So `reachable` was location coverage over locations
that were never meant to be there, and the record was hunting in the wrong
language.

The semantics is the second error and it survives the first. The five classes are
**situations**: an addon that will not load, an identity that does not match, a
setup that failed, a peer that died, a resource that ran out. METHOD.md's rule is
that situation coverage is `sometimes`, and this case is the rule's own example: a
campaign can execute every line of the classifier while never producing any of the
conditions. That is not hypothetical. `shm-frame-channel.test.ts:47-58` reaches
all five classifications from nine hand-built `new NativeStartupError(...)` and
`new Error(...)` values, so the classifier's lines are covered and not one class
is witnessed. The record is now `sometimes` over end-to-end doctor outcomes
produced by real conditions.

**Premise sharpening.** The evaluation said "there are no Rust emission points to
reach". There is exactly one: `"setup_failure"` at `ring_transport.rs:187`. It is
not a member of the client taxonomy that happens to live in Rust — it is the
host's own poisoned-`Mutex` arm, reached only when `AdmissionController::snapshot`
returns `Err` (`profile.rs:501-505`), which no host path causes. Recording it
matters because it is the one thing an oracle on the host side could ever observe,
and because the record's old `Required faults` line was about it.

### B3. Static absence was being counted as runtime non-vacuity

Applied in `fault-map.md` on the rows for
`ring-a-rejected-drain-failure-close-has-no-producer` and
`ring-a-segmented-inbound-body-has-no-production-producer`, on the totals, and on
the relationship map's "machinery with no input that reaches it" cluster in
`catalog.md`, which now states the consequence for their `Exercised` lines.

Both rows read "**Yes** — enumeration only" while both records read
`Exercised: not yet — unconstructible`. Those cannot both be true. The rows were
counting the availability of a **census** as the constructibility of the
**check**, and the check in each case is `reachable` over a location
(`connection.rs:397`, `frame_channel.rs:477`) that no input can reach. A census
settles the finding and can go in CI cheaply, which is worth saying and is said in
leverage item 2; what it cannot do is satisfy a `reachable` assertion, and a
portfolio that counts it as satisfied overstates its own coverage by two records.

Recount: **7 non-vacuous, 5 partial, 2 not constructible**, from 8/5/1, after
combining this with B4's movement in the other direction.

**The recount is explicitly conditional, and that is bias 1.** Two further rows
rest on the same census-versus-construction question:
`ring-a-no-producer-retains-a-committed-release-identity` and the enumeration half
of `ring-a-host-never-quarantines-an-admission-charge`. They were left at `Yes`
for a stated reason rather than by omission: unlike the two demoted rows, their
subjects *execute* in production, so a runtime observation of them is meaningful
even where a census is cheaper. If bias 1 resolves against keeping census records
at all, four records leave the catalog and the totals become 5/5/0 over 10. Both
totals are in `fault-map.md` so the next reader can audit either.

### B4. The one blocked record was not blocked

Applied in `catalog.md` on
`ring-a-lease-release-failure-is-observable-only-on-the-success-path`:
`Exercised`, `Required faults`, `Confidence`, and a new open question. Also on
`ring-a-host-never-quarantines-an-admission-charge`, whose `Required faults` line
gains the cheap producer. In `fault-map.md`: the R4 fault-class row, that record's
map row, the quarantine record's row, the totals, framing point three, and
leverage item 9.

The map said R4 was unavailable because "the transport raises it; nothing in
`mc-host` does", and that producing a quarantine means "writing a deliberately
malformed producer". That enumerates one route and stops.
`Ring::enter_quarantine` is a **public** method
(`crates/mc-shm-transport/src/backend/ring.rs:1034-1040`) that stores `1` into the
shared lifecycle page with `Ordering::Release`. A test peer already holds the ring
it would call it on: `RingClientEndpoint` declares `pub to_host: Ring` and
`pub from_host: Ring` (`ring_transport.rs:627-632`), and the fixture at
`tests/support/raw_client.rs:644` attaches one and already reaches through those
fields at `:698`, `:745`, and `:788`. So the fault is
`endpoint.to_host.enter_quarantine()`.

Three things were checked before accepting it, because any one could have killed
the route. `Ring::release` tests `is_quarantined()` **first**, before incarnation,
lane, and sequence validation (`ring.rs:850-851`), so a quarantined ring fails
every release rather than only some. `is_quarantined` reads the same lifecycle
page with `Ordering::Acquire` (`ring.rs:1042-1049`), and both directions of one
duplex pair map the same object, so a store by the peer is observed by the host's
consumer. And the held-lease half still needs the ingress-wait state, which the
map already ranks as the cheapest new state in the sub-part, so the two records
compose into one fixture instead of needing two capabilities.

**Premise correction.** The evaluation cited `ring.rs:1034-1048`. That range
overshoots: `enter_quarantine` is `:1034-1040` including its doc comment, and
`:1042-1049` is `is_quarantined`, a different method. Both matter to the argument
and both are now cited separately, because a reader sent to `:1048` lands in the
predicate rather than the mutator.

**A consequence worth stating, and it is a new open question rather than a
resolved one.** If a peer can condemn the shared ring unilaterally through a
public method while the host holds a lease, that is peer authority over host
resource state. It is the cheapest route to this record's fault and simultaneously
a capability the threat model may not want. The record now asks the question and
does not answer it.

### B5. The cancellation record's liveness bound was invented

Applied in `catalog.md` on
`ring-a-cancellation-close-requires-an-empty-inbound-observation`: `Guarantee`,
`Check`, `Fault/timing angle`, `Required faults`, `Confidence`, and the open
questions. In `fault-map.md`: that record's map row.

The check asserted exit "within one `POLL_INTERVAL` of the first empty inbound
observation and within the connection's `frame_deadline` overall", and defended
itself with "the bound is stated in the units the code bounds". It is not.
`frame_deadline` bounds exactly one construct: the ingress-charge loop inside
`receive_one`, where `let deadline = StdInstant::now() + frame_deadline` at `:487`
is tested at `:495` and exits `Overloaded` at `:499`. Nothing else in the endpoint
loop consults it. The cancellation report specifically does not:
`:395-397` is `inbound.send(Err(ReadClose::Cancelled)).await` on a bounded `mpsc`
channel of `queue_frames` capacity, with no deadline, so if the connection task is
not draining, the report parks indefinitely. The two frame-delivery sends at
`:478-482` and `:525-530` have the same shape. And `POLL_INTERVAL` is the sleep in
the empty-queue arms (`:511-514`, `:442`), not a bound on reporting.

**The choice made.** The evaluation allowed either a frame-count bound or an
explicit "unresolved", and both were used, because the property splits cleanly
into a part the code does bound and a part it does not. The bound is now stated in
frames: at most `N + 1` further `receive_one` passes for `N` frames committed
before the cancellation edge, one pass per `Ok(true)` through `:409-415` plus the
empty observation that reaches the `read_cancel` check at `:394`, and no post-edge
frame forwarded. The window closes by stopping the peer's publication, per
METHOD.md's requirement for a bounded fault-free window. The residual — the case
where the inbound channel neither closes nor drains, where there is no bound at
all — is recorded as unresolved in the open questions and as a new question about
whether those three sends should carry deadlines. A generous timeout in its place
would have been unrefutable, which is the specific thing METHOD.md's liveness rule
forbids.

### B6. "Recovery is owned by nothing" was too broad and self-contradictory

Applied in `catalog.md` in the leading section, which is rewritten; in the Group B
heading and preamble; on
`ring-a-host-never-quarantines-an-admission-charge` (`Impact` and `Reachability`);
and in the relationship map's "one charge, four ways to lose track of it" cluster.

The claim was the sub-part's headline and it swept up three duties. Two have
owners, and both were re-read at `HEAD`. **Peer-death teardown** is owned by the
sentinel task at `connection.rs:195-207`: `observe_peer` returns, a non-`Goodbye`
close calls `record_peer_death()` (`:200-202`), and both the generation token and
the read-cancel token are cancelled (`:203-204`). **Capacity reclamation** is
owned by the endpoint thread at `ring_transport.rs:279-292`: `admission.release()`
(`:291`) and `done_tx.send(())` (`:292`) sit outside the `catch_unwind` at
`:279-290`, so they run on every exit including a swallowed panic.

The internal contradiction is worse than the overreach. This catalog's own
`ring-a-admission-charge-releases-on-every-endpoint-thread-exit` guarantees that
every exit path returns the full charge, and its `Impact` treats a stranded charge
as the failure. A headline saying recovery is owned by nothing denies the record
directly below it.

What is actually unowned is **admission-quarantine accounting**, and every
statement of the claim is narrowed to that. The narrow version survives
verification cleanly: a `quarantine` grep over `crates/mc-host/src` at `HEAD`
returns only unrelated hits — the `LeaseTracker` flag (`frame_channel.rs:392`,
`:420-433`), two `instance.rs` doc comments (`:67`, `:250`), and one tracker
contract test (`contract_tests.rs:690`) — so `Admission::quarantine`
(`profile.rs:568`) has no host caller in production or in test, while
`docs/mc-host-shm-transport.md:21`, `:65`, and `:79` present the accounting as
live.

**Premise sharpening.** The evaluation framed the surviving gap as a missing
owner. It is better described as a missing **distinction**: `:291` is an owner and
the charge does come back, so what is absent is any accounting difference between
a clean recycle and a condemned one. That reframing is what makes bias 2 the real
blocker, because "add an owner" has an obvious answer and "should these two cases
be accounted differently" does not.

### S1. `default-production` was applied by blanket preamble

Applied in `catalog.md` on all 14 records' `Reachability:` lines, and in
`fault-map.md` where the map's preamble asserted the blanket claim.

METHOD.md rule 4 requires the class to be verified per record with its evidence,
and names the blanket-preamble error as one that "has already been made once and
cost a whole revision". Both artifacts made it again: the catalog argued the class
once in its framing section and the fault map wrote "every record is
`default-production`, so no row repeats an enabling configuration gate".

Each record now carries its own clause naming the call path and the absence of a
gate. Four are not plain `default-production`, and saying so is the substance of
this refinement rather than its bookkeeping:

- `ring-a-rejected-drain-failure-close-has-no-producer` and
  `ring-a-segmented-inbound-body-has-no-production-producer` are labelled
  **compiled with no production producer**. Both subjects are compiled into every
  build and reachable from no input, in production or in test.
- `ring-a-host-never-quarantines-an-admission-charge` is production on the release
  path it contrasts against and **compiled with no `mc-host` caller** on the
  subject itself.
- `ring-a-host-doctor-emits-one-of-five-declared-terminal-classes` is production
  on the host counters and has its **subject in client-side TypeScript**.

The panic record's clause also now separates the two hooks in the same window
rather than leaning on the framing section: the production `written` hook (`:574`,
supplied through `frame_channel.rs:630`) is the subject, and the test-only
`PublishHook` (`:570`, reached only via `run_with_publish_hook` at
`runtime.rs:641`) is named as the cheapest injection point.

### S2. Line references the artifacts admitted were wrong

Applied directly, and the two synthesis notes that carried the corrections as
prose are removed now that the corrections are in the text.

- `catalog.md:417-418`: `Admission::quarantine` is `profile.rs:568`, not `:566`.
  Verified by grep at `HEAD`. The record's own trailing note said so and the check
  line still said `:566`.
- `catalog.md:456-460`: the note itself. Its second correction is also applied —
  the in-crate assertion is at `ring_transport.rs:800`, so the record's `:799-800`
  spanned the assertion plus its preceding line, and the second assertion of the
  same fact at `:774` is now named in the `Existing check` line rather than in a
  footnote.

Two further references were found off while verifying these and are corrected
under rule 1, with the correction noted here because neither was in the
evaluation's list. `Admission`'s `Drop` is `profile.rs:581-586` (impl at `:581`,
body at `:583-586`); the cited `:583-589` overshoots past the impl into the
`QuarantineRecord` doc comment. And the `AdmissionState`/`Admission` pair is
`:546-557`, not `:544-557`, which began on a blank line. Both appear in
`ring-a-admission-charge-releases-on-every-endpoint-thread-exit`.

One reference was checked and deliberately **not** changed:
`connection.rs:130-133` for the authorization gate ends on a blank line, since the
`if auth.is_err() { return; }` block is `:130-132`. It points correctly, it is
cited in both this sub-part and 2c, and churning it would risk more than it fixes.
It is recorded here so a later reader does not re-derive it as an error.

## Gap queued for a follow-up pass

Recorded, not mined.

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | **The positive datapath contracts that the 14-test contract suite already covers have no records at all.** Every record in this catalog is about a failure, an erasure, or an absence. Not one states what the datapath is supposed to *do*. Meanwhile `frame_channel/contract_tests.rs` carries 14 tests whose names are the missing properties: `contract_concurrent_send_receive_preserves_fifo_admission` (`:418`), `contract_saturation_holds_at_frame_bound_and_spares_control_capacity` (`:423`), `contract_completion_hooks_fire_once_in_order_without_claiming_receipt` (`:428`), `contract_graceful_finish_drains_admitted_frames_before_close` (`:443`), `contract_discard_drops_queued_frames_and_releases_charges` (`:448`), and `exact_commit_covers_empty_boundary_segmented_and_maximum_bodies` (`:584`). Nine of the 14 drive a **real** `DuplexRing` through the production `prepare` (`RingFactory::connect`, `:498-521`), so these are not unit stubs. METHOD.md is explicit that "an existing check never removes a property from the catalog": the correct treatment is to catalog FIFO ordering, reserved control capacity, graceful drain, and the maximum legal frame as properties, link each existing test, and mark its status `unaudited`. Today the suite is cited only as leverage item 1's argument for running the lib target, which uses the tests as a reason to change CI while leaving their claims unrecorded. The asymmetry also distorts the part's type mix: 8 of 14 records are safety records about misattribution or absence, and a reader cannot tell from the catalog whether the datapath has any stated positive contract. |

## Biases requiring human judgment

1. **Whether static architecture assertions belong in this catalog at all, which
   decides B3's recount.** Four records are discharged by enumerating call sites
   rather than by running anything:
   `ring-a-no-producer-retains-a-committed-release-identity`,
   `ring-a-host-never-quarantines-an-admission-charge`,
   `ring-a-rejected-drain-failure-close-has-no-producer`, and
   `ring-a-segmented-inbound-body-has-no-production-producer`. Part 4c faced the
   identical question and answered it one way: its evaluation's F1 removed a
   static-architecture record and replaced it with an architectural note, on the
   reasoning that "a property whose passing condition is the absence of a
   mechanism someone may reasonably add is not a property, it is a freeze". Two of
   the four here are exactly that shape. `RejectedDrainFailed` and
   `InboundFrame::segmented` are machinery a future transport may legitimately
   use, and a check asserting they stay unused would fail on the improvement. The
   other two are not obviously that shape: the release-identity record forbids an
   authority violation with a live victim, and the quarantine record's subject is a
   mechanism the documentation says should be live, so asserting its absence is
   asserting a documented contract is unmet rather than freezing a status quo.
   B1's disposition already split them on that basis, retyping the first as safety
   and leaving the quarantine record's `unreachable` flagged rather than defended.
   *Judgment required:* decide whether this catalog admits census records. If it
   does not, all four become prose, the record count drops to 10, and the
   fault-map totals become 5 non-vacuous, 5 partial, 0 not constructible. If it
   does, the two Group F records need a stated answer to "what would make this
   check fail, other than someone fixing the gap", and the quarantine record's
   `unreachable` needs either a defence or a move to `always(!X)` — because
   METHOD.md reserves `unreachable` for a *forbidden* location and
   `Admission::quarantine` is not forbidden by anyone. Both totals are recorded so
   neither answer requires re-deriving the map.

2. **The release-versus-quarantine policy question, which must be settled before
   the charge records can be made consistent.** `admission.release()`
   (`ring_transport.rs:291`) is unconditional and outside the `catch_unwind`, so a
   connection whose ring was condemned returns its charge on exactly the same line
   as a clean one. Two readings fit the code equally well and the catalog
   currently holds both. Either releasing is correct, because `run_endpoint`
   dropping the `DuplexRing` genuinely unmaps the storage, in which case
   `docs/mc-host-shm-transport.md:21`, `:65`, and `:79` are describing a mechanism
   that should be deleted rather than repaired, and
   `ring-a-host-never-quarantines-an-admission-charge` narrows to a documentation
   defect. Or a condemned ring's arena bytes should be retained against the
   process bound until teardown, which is what `Admission::quarantine`
   (`profile.rs:568`) exists to do and what Part 1's
   `quarantine-charge-transition-is-atomic` was anchored to before
   `provider_recovery.rs` was deleted, in which case `:291` is a defect on the
   condemned path and
   `ring-a-admission-charge-releases-on-every-endpoint-thread-exit` needs an
   exception it does not currently have. **The two records cannot both be right as
   written**: one requires the charge to come back on every exit, the other asks
   whether one exit is an exception. The evidence is genuinely balanced. The
   mapping really is released, which favours the first reading; the transport
   really does distinguish the states atomically and the docs really do promise
   the distinction in three places, which favours the second. METHOD.md rule 3
   forbids resolving it in the documentation's favour and rule 2 forbids guessing.
   *Judgment required:* answer the accounting question first. Then the charge
   records can be made consistent, and B4's new question — whether a peer should
   be able to condemn the shared ring at all through the public
   `Ring::enter_quarantine` — becomes answerable, because it is the same question
   about who owns quarantine authority seen from the peer's side.

## Verdict

The evaluator's verdict was **REFUTED**. After applying all six refinements plus
the two shared ones, the honest verdict is that the refutation was correct and the
portfolio is better but still not ready, and the reason has moved: the internal
contradictions are gone, and what remains is one missing category plus two
decisions nobody has made.

What improved concretely. The headline claim no longer contradicts the record
below it. Two semantics choices that METHOD.md's own rules forbid are corrected,
one of them a misuse of `unreachable` on a function that runs on every frame. The
part's only liveness bound is now stated in frames the code counts, with the
unbounded residual recorded as unresolved instead of covered by a wall-clock
number that does not hold. The one record the map called unconstructible is
constructible in one line of an existing fixture, and the fault class it needed is
no longer ranked as requiring a production seam. Two records that were counted as
non-vacuous while their own text said unconstructible are counted honestly, which
made the totals worse and the portfolio more accurate. And the reachability
labels stop asserting uniformity that four of the fourteen records do not have.

Ready now for test implementation, in this order. The ingress-wait fixture first,
because it is one edit combining two existing inline tests
(`ByteBudget::new(0)` from `budget_wait_observes_read_cancellation` at `:949`, a
queued outbound frame from `copied_control_frame_records_one_host_adapter_copy`)
and it is the enabling state for two other records. Then
`endpoint.to_host.enter_quarantine()` on top of it, which lands the lease-release
record and the runtime half of the quarantine record together. Then the panicking
`PublishHook` through `TestHost::start_with_publish_hook`, which builds the
connection-disposition observation apparatus three other records need. Then the
charge-delta oracle wrapped around the kill harness that already runs in CI
(`shm_failure_modes.rs:233`, `:248`), which is the highest-value item already
inside an executing job.

Not ready, for four reasons no further work of this kind resolves. G1 is a missing
category rather than missing detail: the datapath has no positive contract in this
catalog while 14 tests assert one. Bias 1 is upstream of the record count and of
the fault-map totals, and cannot be settled from inside the part. Bias 2 is
upstream of whether two records are mutually consistent. And above all of it sits
the fact none of these corrections touches: **no inline test in this sub-part runs
in CI**, so every record improved here is a record in a suite no automation
executes, and R0 at the top of the leverage ranking still unblocks zero records
while protecting all 35 test functions.

One process caveat, stated rather than hidden. METHOD.md step 7 requires records
to equal index rows to equal evidence files. All three are 14 and the order
matches. But two evidence files now describe records whose type, semantics, or
central claim changed under this disposition:
`ring-a-no-producer-retains-a-committed-release-identity.md` documents an
`unreachable` reachability record that is now a safety record with `always`, and
`ring-a-host-doctor-emits-one-of-five-declared-terminal-classes.md` documents a
`reachable` check over host emission points that do not exist. A third,
`ring-a-lease-release-failure-is-observable-only-on-the-success-path.md`, records
its fault as unavailable. All three need updating and none was touched: this
disposition was scoped to `catalog.md` and `fault-map.md` plus this file, and was
not permitted to edit `evidence/`, `_lenses/`, source, tests, or CI.

## What this evaluation says about the method

Part 4a's evaluation found absence of a named seam read as absence of the
capability, three times. Part 4c's found the same error in a harder form: the seam
was enumerated, given an adjective from its doc comment, and never opened. Its
lesson was stated as "a capability claim needs the body read, not the signature
and the doc comment".

This part shows the lesson generalizing past capabilities, and the generalization
is the finding worth carrying forward. **Four of this pass's six refinements are
unenumerated absence claims.** B6 said recovery was owned by nothing without
enumerating the owners, and two of three duties had one. B4 said quarantine was
unraisable from the host without enumerating the ways to raise it, and a public
method raised it. B2 said four of five emission points did not exist without
enumerating where they were supposed to be, and they were in TypeScript by design.
B5 said a bound was stated in the units the code bounds without enumerating what
`frame_deadline` actually bounds, and it bounds one loop out of three awaits. The
common shape is not "a seam was missed" — it is that **an absence was asserted
from one failed search**. A capability, an owner, a producer, and a bound are all
existential claims, and a negative existential needs the search space named, not
just one probe reported.

The cheap guard follows directly and is different from 4c's: before writing "X is
owned by nothing", "X cannot be produced", or "X is bounded by Y", write down the
set you searched and the search you ran. All four of these findings would have
been caught by that one sentence, because in each case the search that was
actually run was narrower than the claim it supported. B6's search was for a file
named `provider` or `recovery`; the owners were in `connection.rs` and
`ring_transport.rs`. B4's was for host code calling `quarantine`; the caller could
be the peer. B2's was for five literals in Rust; four were in TypeScript. B5's was
for the identifier `frame_deadline`; the question was which awaits consult it.

A second, smaller pattern repeats from 4c and is worth one line: the artifacts
again contained their own corrections and did not use them. Both S2 references
were already written out in a note attached to the very record whose check line
still carried the wrong number, and both B3 rows contradicted the `Exercised:`
line of the record they described. 4c called this "precision does not propagate
sideways". Here it did not propagate a single paragraph.

## Re-evaluation trigger

A fresh pass is warranted once G1 is mined, because it adds a category rather than
adding inside one. A positive datapath contract would be this part's first
property about what the transport delivers rather than about how it misreports,
its oracle would be a comparison of what was sent against what arrived rather than
an inspection of a close cause or a counter, and it is the one place where nine
existing tests already drive a real ring through the production `prepare` to
compare against.

Four other triggers, each firing independently:

- Any resolution of bias 1. Either answer changes the record count and the
  fault-map totals, and one of them changes four records into prose. Until it is
  answered, the part's coverage numbers have two legitimate readings.
- Any resolution of bias 2. It decides whether
  `ring-a-host-never-quarantines-an-admission-charge` is a documentation defect or
  a code defect, whether
  `ring-a-admission-charge-releases-on-every-endpoint-thread-exit` needs an
  exception, and whether the peer's access to `Ring::enter_quarantine` is a
  capability or a hazard.
- Any answer to whether `read_loop` closes the inbound channel promptly on
  `read_cancel`. That is Part 2a's scope, and it converts the cancellation
  record's unresolved residual into either a real bound or a real defect. It is
  also the reason that record is `medium` rather than `high`.
- Any workflow change that runs the `mc-host` lib target. Every `Exercised:` line
  and every `Existing check:` line here is written against a suite no automation
  executes, and the day one of them runs, the meaning of "partial" changes across
  all 14 records. This is the same trigger Parts 4b and 4c recorded, unresolved,
  and it remains the largest single fact about this sub-part.
