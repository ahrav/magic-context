# Sub-part 2b fault-to-property map

For each of the 14 records, what must actually occur for a test to be
non-vacuous, and whether the harness can produce it today.

Same rules as the earlier parts. Safety checks must hold *while* their faults are
active. Liveness checks need a bounded fault-free window, stated in the units the
code bounds. Rare implementation branches need deterministic injection to be
reachable at all. Coverage checks assert independent preconditions, never the
violation.

Three framing points specific to this sub-part.

**First, the dominant obstacle is not a missing fault. It is that nothing here
runs.** 35 in-crate tests reach this datapath and CI executes none of them,
because every `-p mc-host` invocation carries a `--test <name>` filter. The
availability column below therefore describes what a developer can construct
locally. The two `compile_fail` doctests at `frame_channel.rs:296-308` are the
sole exception, and they cover no record in this catalog.

**Second, the richest seam in this sub-part already exists and is already in
CI.** `shm_failure_modes.rs` carries a real-process SIGKILL harness that kills a
peer at three lifecycle points and runs on every relevant job. That makes more
records constructible than a reading of the record text alone suggests, and it is
why the correction below matters.

**Third, availability claims in this sub-part have now been wrong twice, both
times in the pessimistic direction.** The first is corrected in full below
because the correction changes the leverage ranking. The second was found by the
independent evaluation and is corrected at the R4 row and at leverage item 9:
this map said a peer could raise a transport quarantine only by publishing a
malformed descriptor, and therefore ranked R4 as needing a production seam. In
fact `Ring::enter_quarantine` is a public method and the test peer already holds
the ring, so the fault is one line in an existing fixture. The pattern is worth
naming because it is the same error both times: **a capability was judged absent
from the mechanism the map happened to have in mind, without enumerating the
other ways in.**

> **Correction: the deleted kill harness was the *precise* one, not the only
> one.** The framing handed to this synthesis was that
> `crates/mc-host/tests/support/shm_process.rs` was deleted by the refactor and
> that peer-death faults are therefore no longer constructible without rebuilding
> it. The deletion is real and was verified:
> `git log --diff-filter=D` shows `ed487e11` ("refactor(host): make ring
> transport mandatory") removed the file, and it was 911 lines. Its module doc
> describes a barrier-driven real-process crash harness with **named** crash
> points — the victim reported `idle_committed` after its commit exchange and
> `request_published` after its ring commit, and the daemon reported
> `response_published` through the provider publish hook — plus
> `RoleProcess::kill` and `reap_killed` (`:257`, `:272`) gating a bounded
> post-reap observation window that starts only after `wait` returned signal-9,
> and helpers `live_descendants` (`:415`), `proc_state` (`:446`), and
> `wait_zombie` (`:299`). The same commit deleted
> `crates/mc-host/src/provider_recovery.rs`.
>
> What is **not** true is that peer death is now unconstructible. A coarser
> harness survives at `HEAD` in `shm_failure_modes.rs` and **it runs in CI**
> (`ci.yml:133`). `Victim::spawn` (`:119-140`) re-execs the test binary with
> `--ignored --exact shm_role_client`, the child dispatches on `ROLE_ENV`
> (`:31-33`), and `Victim::kill` (`:141-147`) sends `SIGKILL` and asserts
> `status.signal() == Some(libc::SIGKILL)`. Three roles exist — `setup`,
> `active`, `idle` — synchronized by a printed `READY <role>` barrier.
>
> So the accurate statement is: **coarse peer death at a lifecycle boundary is
> available today and protected by CI; peer death at a named mid-frame crash
> point is what the refactor deleted and is not constructible without rebuilding
> it.** The distinction is exactly the one this sub-part's records need. Killing
> a peer between `request_published` and `response_published` is the fault that
> makes [ring-a-publish-failure-is-reported-as-a-clean-peer-close](catalog.md#ring-a-publish-failure-is-reported-as-a-clean-peer-close)
> and the `Corrupt`-versus-`CleanEof` asymmetry observable, and the three roles
> that survive (`setup`, `active`, `idle`) are all quiescent points. The publish
> hook the deleted harness used for `response_published` still exists
> (`ring_transport.rs:229`, reached via `support/mod.rs:597`), so the seam was
> not removed; the barrier protocol that combined it with a kill was.

## Fault classes required

`R0` is listed first because it is the cheapest capability here and it is not a
fault at all.

| Class | Description | Available today |
| --- | --- | --- |
| **R0** test execution in CI | Any workflow job that builds and runs the `mc-host` **lib** test target | **No.** Verified at `HEAD`: all 13 `mc-host` hits in `ci.yml` are `:87`, `:132`, `:133`, `:134`, `:168`, `:169`, `:178`, `:187`, `:190`, `:211`, `:361`, `:442`, `:461`; every test invocation carries `--test <name>` and `:168-169` are `cargo build`. 35 in-crate tests execute in no job. The one exception is `cargo test -p mc-host --doc` (`:190`), which runs the two `compile_fail` doctests at `frame_channel.rs:296-308`. This costs a workflow change and no new infrastructure |
| **R1** shared-memory object creation failure | `DuplexRing::create` (`ring_transport.rs:263`) or `worker_descriptor` (`:271`) failing, so `prepare` returns `RingUnavailable` from one of the four uncounted causes | **No.** There is no seam. Nothing can fail `tokio::runtime::Builder::build`, `DuplexRing::create`, `worker_descriptor`, or `thread::Builder::spawn` from a test. Exhausting `/dev/shm` or the fd limit would work in principle but is host-wide, racy under `--test-threads`, and cannot select *which* of the four causes fires, which is what the record needs. Needs an injectable failure point inside `prepare` |
| **R2** peer death without a goodbye | A peer process that dies without writing the encoded goodbye that `client.rs:1890-1893` sends on orderly teardown | **Partial, and the available half is in CI. See the correction above.** *Coarse: yes.* `Victim` (`shm_failure_modes.rs:119-147`) SIGKILLs a re-execed peer at `setup`, `active`, or `idle`, driven by `:233` and `:248`, running at `ci.yml:133`. *Mid-frame: no.* The barrier-driven harness with `request_published` and `response_published` crash points was deleted with `shm_process.rs` (`ed487e11`, 911 lines). The publish hook it used survives (`ring_transport.rs:229` via `support/mod.rs:597`); the barrier protocol does not |
| **R3** a publish failure mid-frame | `publish_one` (`:536`) returning `Err` while the connection is otherwise healthy | **Yes, and no seam is needed.** Four mechanisms reach it and the cheapest needs only a peer that attaches and stops receiving: reservation deadline expiry under a full host-to-peer ring (`ring.rs:739`), a header/length disagreement rejected by `commit_reservation` (`ring.rs:1176-1182`), a panic in the direct serializer caught at `:560-563`, and `ReservationWriter` exhaustion (`:612-617`). `raw_client.rs` already attaches through `attach_with_descriptors` (`:644`) and controls its own receive loop, so withholding receipt is a fixture choice |
| **R4** quarantine raised on a live ring | The peer-to-host ring's lifecycle page carrying `quarantined = 1` while the host holds or takes a lease on it | **Yes, and no seam is needed. This row previously said `No` and was wrong.** Two producers exist. The one this map originally named is expensive: `Ring::try_receive` failing descriptor validation, which calls `enter_quarantine()` from inside the transport (`ring.rs:808`) and needs a deliberately malformed producer, since `raw_client.rs`'s publish helpers build valid headers through `reserve_until` and `commit` (`:705`, `:750`, `:806`). The one it missed is one line: `enter_quarantine` is **public** (`crates/mc-shm-transport/src/backend/ring.rs:1034-1040`) and a test peer already owns the ring. `RingClientEndpoint` declares `pub to_host: Ring` and `pub from_host: Ring` (`ring_transport.rs:627-632`), the fixture at `tests/support/raw_client.rs:644` attaches one through `attach_with_descriptors`, and it already reaches through those fields at `:698`, `:745`, and `:788`. So `endpoint.to_host.enter_quarantine()` condemns the shared ring directly. `Ring::release` tests `is_quarantined()` before every other validation (`ring.rs:850-851`), and both directions of a duplex pair map the same object, so the host's next release on that direction fails. `crates/mc-shm-transport/tests/ring.rs:256` reaches the transport-side state but not the host's handling of it |
| **R5** a maximal 64 MiB frame | One in-flight body of `MAX_FRAME_BYTES` published through a real ring | **Partial, and the blocker is configuration rather than a seam.** The geometry was verified: `MAX_FRAME_BYTES` is `64 * 1024 * 1024` and `MIN_ARENA_BYTES` is defined as exactly `MAX_FRAME_BYTES` (`crates/mc-shm-transport/src/arena.rs:4-6`), used as `arena_bytes` at `ring_transport.rs:48`. So one maximal body consumes the whole arena and the eight descriptor slots (`DESCRIPTOR_DEPTH` at `:32`, `max_leases` at `:50`) collapse to one usable frame. `raw_client.rs:800-808` can publish an arbitrary body. What is unresolved is the ingress side: the budget is `ByteBudget::new(config.limits.max_resident_bytes - EGRESS_RESERVED_BYTES - SCRATCH_RESERVED_BYTES - catalog_resident - reservations.retained_bytes)` (`runtime.rs:896-902`), so admitting a 64 MiB frame needs `max_resident_bytes` set high enough via `TestHost::start_with`. Whether the default permits it was not determined |
| **R6** endpoint-thread panic | A panic escaping `run_endpoint`, so the outer `catch_unwind` at `:279-290` observes `Err` | **Yes, through a seam that already exists.** `TestHost::start_with_publish_hook` (`support/mod.rs:597`) installs a `PublishHook` reaching `ring_transport.rs:568-572`, which is inside the exposed window between `:563` and `:576` and outside the inner `catch_unwind`. A panicking closure enters it directly. The hook is test-only, but the record it serves is about the production `written` completion hook (`:574`, supplied through `frame_channel.rs:630`), which shares the same unprotected window |

One availability caveat cutting across R3, R4, and R6, and it is unchanged by the
R4 correction above. All three land inside
`run_endpoint`, whose outer `catch_unwind` result is discarded with `let _ =`
(`:279`) and whose `admission.release()` (`:291`) and `done_tx.send(())` (`:292`)
run regardless. So an oracle for any of them must observe the **connection
engine's** disposition or the admission snapshot, not the endpoint thread's
return value: the thread reports orderly completion on every path, which is the
finding rather than an obstacle to measuring it.

## Map

All 14 records. **"Non-vacuous today" means a developer can construct the
required state with the current harness.** It does not mean the check runs
anywhere; under R0 none of them does.

**Reachability is recorded per record in `catalog.md`, not here and not in a
blanket claim.** This map previously asserted "every record is
`default-production`, so no row repeats an enabling configuration gate", which
METHOD.md rule 4 forbids and which was also inaccurate: two records have a
subject that is compiled with **no production producer or caller at all**
(`ring-a-rejected-drain-failure-close-has-no-producer`,
`ring-a-segmented-inbound-body-has-no-production-producer`), one has a subject
with no `mc-host` caller in production or test
(`ring-a-host-never-quarantines-an-admission-charge`), and one has its subject in
client-side TypeScript rather than in the host
(`ring-a-host-doctor-emits-one-of-five-declared-terminal-classes`). Each record's
`Reachability:` line now carries its own evidence, including the
compiled-but-uncalled cases, and no row below infers a class from the absence of
a gate.

### Ownership and the discarded release identity

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| ring-a-endpoint-thread-solely-owns-both-ring-endpoints | **No fault.** The structural form is a static assertion: `DuplexRing::create` is inside the thread closure (`:263`, closure opened at `:256`), `rings` moves by value into `run_endpoint` (`:280`), `PreparedRing` (`:103-111`) has seven fields and none owns a `Ring`, and only a `serde_json::Value` plus `[OwnedFd; 2]` cross the `sync_channel` (`:247`, `:276`). A runtime form additionally needs both directions carrying traffic so a second thread would contend | **Yes** — no fault, and `#![deny(unsafe_code)]` (`lib.rs:8`) forecloses the pointer-smuggling escape the record names |
| ring-a-no-producer-retains-a-committed-release-identity | **No fault.** A call-graph enumeration over every `.commit(` site. Verified independently by this synthesis: the three non-test producers are `ring_transport.rs:591`, `:604`, `:670`, and the six test sites are `:856`, `:906`, `:943` plus `raw_client.rs:705`, `:750`, `:806`. Optionally backed by a `#[cfg(debug_assertions)]` counter on the producer-identity path, which must stay at zero | **Yes** — enumeration only; the value is discarded at every site, so no runtime observation is even possible without a code change |

### Admission accounting and the missing recovery owner

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| ring-a-admission-charge-releases-on-every-endpoint-thread-exit | One fault per exit path, and the paths split. The **clean** and **peer-death** exits are constructible now: `Victim` (R2 coarse) kills at three roles and `shm_failure_modes.rs:233` already asserts a resource baseline returns; upgrading that oracle to a `snapshot().active` delta around each connection is a fixture change. The **panic** exit is constructible through R6. The three **initialization-failure** paths that rely on `Admission`'s `Drop` rather than an explicit `release()` — `:264-270`, `:272-275`, `:276-278` — need R1, which has no seam | **Partial** — three of the interesting paths are reachable today, the three `Drop`-dependent ones are not. The `Drop` behaviour itself is verified by reading `profile.rs:581-586`, which is evidence and not a test |
| ring-a-host-never-quarantines-an-admission-charge | **No fault for the primary oracle.** The check is `unreachable` over a code location, discharged by enumeration: zero `Admission::quarantine` call sites under `crates/mc-host/src`, re-verified here (the only `quarantine` hits are the unrelated `LeaseTracker` flag, two `instance.rs` doc comments, and one tracker contract test). The derived state screen, `snapshot().quarantined == ResourceCharges::ZERO`, needs no fault either and two existing assertions already make it (`:774`, `:800`) — vacuously, which is the point. The **runtime confirmation** that a condemned ring still returns its charge as if clean needs R4, **which is now available**: condemn from the peer, then read `accounting()` and confirm the charge came back to `active` rather than to `quarantined` | **Yes** for the enumeration and the screen, and **Yes** for the runtime confirmation as well, which this row previously called `No`. What the confirmation cannot do is settle whether releasing is the *right* answer for a condemned ring; that is the release-versus-quarantine policy question and it needs a human |

### Failure attribution

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| ring-a-publish-failure-is-reported-as-a-clean-peer-close | R3, and the cheapest form needs no seam: a peer that attaches through `attach_with_descriptors` (`raw_client.rs:644`) and never receives, filling the host-to-peer ring until `reserve_until` hits its deadline (`ring.rs:739`). The oracle reads the connection engine's disposition, asserting the delivered cause is not `ReadClose::CleanEof`. To observe the **asymmetry** the record names, the same fault must also be raised from inside the ingress-budget wait, which additionally needs the ingress-wait state below | **Yes** for the main path; the asymmetry half additionally depends on the ingress-wait record |
| ring-a-endpoint-thread-panic-is-reported-as-orderly-completion | R6 through the existing hook seam: install a panicking `PublishHook` via `TestHost::start_with_publish_hook` (`support/mod.rs:597`), which fires at `:568-572`, inside the `:563`-to-`:576` window and outside the inner `catch_unwind`. The oracle must assert two things separately: the connection observes a cause other than clean completion, and no `QueuedOutboundFrame` sits at `COMPLETE` without having reached the ring, because `:567` stores `COMPLETE` before the hooks run. The narrower `on_publish()` window (`frame_channel.rs:653-655`) needs a panic there instead | **Yes** — the seam exists and one existing binary (`lifecycle.rs`) already uses it, so only the panicking closure is new |
| ring-a-ring-unavailability-fails-closed-without-a-classified-reason | Split by cause. The **fail-closed half** is constructible for admission exhaustion today, and `exact_capacity_succeeds_and_plus_one_creates_no_ring_resources` (`shm_failure_modes.rs:267`) already builds the state with `max_connections = 1`; the oracle adds an assertion that no `activate_server` ran, `connection.rs:170` being the site. The **reportability half** for the other four causes needs R1. The **timeout path** needs `prepare` to exceed `transport_setup_deadline`, which is configurable through `TestHost::start_with` | **Partial** — one of five causes plus the timeout path; four causes blocked on R1, which is also quiet area 2 in `existing-checks.md` |

### Diagnostics witnesses

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| ring-a-reclamation-count-does-not-witness-charge-release | A connection that reaches `serve_generation` and finds `shared.draining` set or `shared.shutdown` already cancelled: that is, accepted and authenticated **during** the shutdown sequence, so the early return at `connection.rs:273-276` skips the `io_task` await at `:347` and `AbortOnDropHandle` (`:190`) aborts the waiter. `TestHost` exposes `shutdown_gracefully`, so the state is reachable, but hitting the window is a timing race with no barrier: nothing signals "draining is set, now connect". The oracle reads `diagnostics()["reclamation"]["completed"]` against the count of threads that executed `:291` | **Partial** — the state is reachable and the race is unsynchronized. This is precisely the kind of named barrier the deleted `shm_process.rs` provided (`expect_record`, `wait_for_record` at `:213`, `:219`) |
| ring-a-host-doctor-emits-one-of-five-declared-terminal-classes | **Rewritten this pass; the row's premise changed with it.** The record is no longer an enumeration of five host emission points, because there are none: the terminal report is synthesized client-side by `classifySharedMemoryFailure` (`packages/plugin/src/shared/mc-host-client/shared-memory-failure.ts:10-30`) and `terminalSharedMemoryDiagnostics` (`policy.ts:854-872`), reached from `policy.ts:648-672`. The check is now `sometimes` over end-to-end doctor outcomes, so it needs **one condition per class**, and they do not share a mechanism: `missing_addon` needs 2c's S6 (a packaged-addon load, structurally suppressed by `ci.yml:193`); `identity_mismatch` needs a `connect_setup` failure carrying that message (`packages/mc-shm-native/src/lib.rs:583`); `setup_failure` is the default arm and any other native startup failure reaches it; `peer_death` needs an `ECONNRESET`/`EPIPE`/EOF error, which R2 coarse already produces; `resource_exhaustion` needs a `memory_cap` code or capacity message, which admission exhaustion produces (`ring_transport.rs:239-242`) | **Partial** — three of five classes (`setup_failure`, `peer_death`, `resource_exhaustion`) are constructible end to end today with fixtures that already exist; `identity_mismatch` needs a mismatched-identity host; `missing_addon` is blocked on 2c's S6, which is a CI-ordering change rather than a fault. Note the existing TypeScript test (`shm-frame-channel.test.ts:47-58`) reaches all five *classifications* from constructed errors, which is location coverage and cannot satisfy a `sometimes` check |

### The inbound loop

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| ring-a-lease-release-failure-is-observable-only-on-the-success-path | A held lease **and** a release failure, jointly. R4 supplies the failure and the ingress-wait state supplies the held lease: park the host inside the budget wait with a lease held, condemn the ring from the peer with `endpoint.to_host.enter_quarantine()` (`ring.rs:1035`, reached through `RingClientEndpoint`'s `pub` fields at `ring_transport.rs:627-632`), then let the wait exit on `Cancelled` or `Overloaded` where the `Result` is dropped (`lease.rs:215-221`) | **Yes. This row previously said `No` and it was the map's one blocked record; both are corrected.** R4 does have a host-reachable producer, and it is one line in the fixture at `tests/support/raw_client.rs:644` rather than a malformed producer. The record's separate observation still stands unchanged: the gap stays *latent* until `connection.rs:401-404` stops collapsing `Corrupt` and `Overloaded` into one `ReadExit`. Latency is not vacuity — the asymmetry is observable at `receive_one`'s return today |
| ring-a-cancellation-close-requires-an-empty-inbound-observation | An attached peer publishing continuously, ingress budget large enough that each `charge` future resolves immediately, and a cancellation of `root` or `read_cancel` while that traffic continues. `connection.rs:183-189`'s peer-death handler is a natural trigger, and R2 coarse can fire it. The bounded window per METHOD's liveness rule: run traffic, cancel, **stop the peer's publication and let the ring drain**, poll until the thread exits, then assert a **frame-count** bound — at most `N + 1` further `receive_one` passes for `N` frames committed before the cancellation edge, and no post-edge frame forwarded. **The wall-clock half of this row was withdrawn in the polling era and stays withdrawn post-#131.** It once said "within one `POLL_INTERVAL` of the first empty observation and within `frame_deadline` overall"; PR #131 (merge `5d638e3e8`) then removed `POLL_INTERVAL` outright and made the empty-ring wait an eventfd park, so the frame count is the only unit left: `frame_deadline` bounds only the ingress-charge wait (`:519`, `:527-532`), and the `Cancelled` report itself is an undeadlined `inbound.send(..).await` at `:402` | **Partial** — the traffic, the cancellation, and the frame-count bound are constructible; the case where the inbound channel neither closes nor drains has **no bound at all** and is recorded as unresolved rather than given a timeout. Whether `read_loop` closes the channel promptly lives in Part 2a's scope, which is why the record is `medium` confidence |
| ring-a-ingress-wait-holds-a-lease-while-servicing-egress | An ingress budget too small for the frame in hand, so the async `charge` future (`:520-521`) stays pending and the `:522-542` charge wait parks with a lease held; **and** at least one outbound frame queued while it pends, so the `queue.recv()` publish arm at `:533-540` runs. (Post-#131 the wait is a semaphore park, not a `try_charge` poll loop, and the polling-era third sub-precondition covering the `POLL_INTERVAL` sleep has no counterpart.) No fault at all: both are fixture parameters. Two existing tests are each exactly one precondition short — `copied_control_frame_records_one_host_adapter_copy` (`:961-1005`) uses `ByteBudget::new(1024)` (`:994`) so never enters the wait, and `budget_wait_observes_read_cancellation` (`:1008-1043`) uses `ByteBudget::new(0)` (`:1028`) and does park in it but has an empty sender queue (`:1023-1026`) | **Yes** — and it is the cheapest new state in the sub-part: combine the budget of the second test with a queued outbound frame from the first |

### Taxonomy arms

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| ring-a-rejected-drain-failure-close-has-no-producer | **No fault, and no runtime state either.** Static producer enumeration: `ReadClose::RejectedDrainFailed` exists at `frame_channel.rs:47` and is consumed at `connection.rs:391` and nowhere else; `ReadClose::Io` at `:45` is consumed at `connection.rs:403` and nowhere else; `ReadExit::PeerKeepQueue` is produced only at `connection.rs:397`, so `connection.rs:304-308` and the `reject_written` bookkeeping at `:385` are dead. The record's check is `reachable` over `connection.rs:397` | **No. This row previously said `Yes` and it was counting a static absence as runtime non-vacuity.** The record's own `Exercised:` line says "unconstructible; no test can reach it without a code change", and the two cannot both be true. A producer census is available today and settles the *finding*; it does not make the record's `reachable` check satisfiable, and nothing can, which is the point of the record. Whether such a census belongs in this catalog as a record at all is bias 1 in `portfolio-evaluation.md` |
| ring-a-segmented-inbound-body-has-no-production-producer | **No fault, and no runtime state either.** `InboundFrame::segmented` (`frame_channel.rs:477`) has zero call sites tree-wide, so `ReceiveBody::Segmented` (`:448`) is unconstructible, `with_lease` (`:506-513`) always takes the `Owned` arm, and `decode_contiguous`'s `None` arm (`connection.rs:586`) is dead. A body straddling the arena wrap point is constructible (`span_count == 2`, `ring.rs:816-823`), but `receive_one` collapses it with `lease.to_vec()` (`:519`) before the host sees spans, so it does not reach the record's subject either | **No. This row previously said `Yes` on the same error as the row above.** The record's `Exercised:` line says "unconstructible from any host path". The census is available and settles the finding; the `reachable` check over `frame_channel.rs:477` cannot be satisfied by any campaign. Bias 1 in `portfolio-evaluation.md` decides whether the record stays in this form |

**Totals: 7 fully non-vacuous today, 5 partial, 2 not constructible.** The seven
are the two ownership records, the quarantine enumeration and its screen, the
publish-failure record, the panic record, the ingress-wait record, and the
lease-release record. The two not constructible are
`ring-a-rejected-drain-failure-close-has-no-producer` and
`ring-a-segmented-inbound-body-has-no-production-producer`, and they are not
blocked on a capability: their `reachable` checks are unsatisfiable **by
construction**, which is what each record set out to establish.

Three movements produced those totals, and one is in the pessimistic direction.

- `ring-a-lease-release-failure-is-observable-only-on-the-success-path` moves
  `No` to `Yes` on the R4 correction. **This map no longer has a blocked record.**
- The two producer-census records move `Yes` to `No`. This map had been counting
  *static absence* as runtime non-vacuity, and their own records said the
  opposite: both read "unconstructible" in `Exercised:` while their rows read
  "Yes — enumeration only". A census that proves nothing can reach a location is
  a finding, not a satisfiable check, and calling it non-vacuous made the totals
  look better than the portfolio was.
- `ring-a-host-doctor-emits-one-of-five-declared-terminal-classes` stays
  `Partial` but for a different reason: the classes are client-side situations
  needing one condition each, not four missing host producers.

**Two further rows sit on the same question as the two demotions and are left
pending a human.** `ring-a-no-producer-retains-a-committed-release-identity` and
the enumeration half of `ring-a-host-never-quarantines-an-admission-charge` are
also discharged by census rather than by construction. They are still counted
`Yes` here, because unlike the two demoted rows their subjects *do* execute in
production — `Ring::release` runs on every lease drop and `admission.release()`
runs on every exit — so a runtime observation is meaningful even though the
cheapest oracle is a census. If bias 1 in
[portfolio-evaluation.md](portfolio-evaluation.md) resolves against keeping
static architecture assertions as records, both leave the catalog and the totals
become **5 non-vacuous, 5 partial, 0 not constructible over 10 records**. That
alternative is stated here so the recount is auditable either way.

Note the shape of the seven: **four need no fault at all** — the two ownership
records, the quarantine enumeration and screen, and the ingress-wait record,
whose two preconditions are fixture parameters rather than faults. The remaining
three need R3, R6, and R4 respectively. Counting the two demoted rows, **five of
the fourteen records are enumerations of code that is missing rather than code
that misbehaves**, which is what cataloging a post-refactor surface for the first
time produces. The doctor record was previously counted as a sixth and is not one:
its subject exists and runs, in TypeScript.

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies, so
it fires without a defect present. Names are constants, globally unique, and
never constructed dynamically.

**There are now two `sometimes` records.** The lens produced one; the portfolio
disposition produced the second by rewriting
[ring-a-host-doctor-emits-one-of-five-declared-terminal-classes](catalog.md#ring-a-host-doctor-emits-one-of-five-declared-terminal-classes)
from `reachable` to `sometimes`. That record needs a marker name, since METHOD.md
requires names to be constant and globally unique: assign
`ring_doctor_reported_a_terminal_class_from_a_produced_condition`, one firing per
class observed, with the class as a recorded attribute rather than as part of the
name. It complies with the coverage rule: a produced terminal condition is a
legal operational state, and the marker is not paired with any `always(!X)` on the
same predicate. The lens's own `sometimes` record complies too and is not
duplicated here.
[ring-a-ingress-wait-holds-a-lease-while-servicing-egress](catalog.md#ring-a-ingress-wait-holds-a-lease-while-servicing-egress)
asserts two independent preconditions jointly — a lease held with `try_charge`
having failed at least once, and the publish-from-wait branch at `:504-509`
having executed in the same invocation. Verified against the rule: it is not
paired with any `always(!X)`, and neither precondition is a violation. Both are
legal and both are the documented design response, stated in the comment at
`:501-503`. So it needs no companion marker, and the canonical name below is a
reference to that record rather than a new check.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `ring_endpoint_thread_released_its_admission_charge` | The endpoint thread executed `admission.release()` (`:291`) for a connection | The ordinary shape of every exit. It is the release-witness the reclamation counter is not |
| `ring_endpoint_thread_exited_before_run_endpoint_was_entered` | `prepare` returned `Err` from one of `:264-270`, `:272-275`, or `:276-278`, so the charge came back through `Admission`'s `Drop` rather than an explicit `release()` | Records the independent precondition of a `Drop`-dependent return without asserting the charge leaked. Legal: the three paths are deliberate early returns |
| `ring_prepare_refused_a_connection_before_activation` | A `prepare` failure was observed at `connection.rs:149-164` with no `activate_server` reached (`:170`) | The fail-closed half, which is the half that holds. Asserting it says nothing about whether a cause was recorded |
| `ring_prepare_failure_incremented_no_counter` | A `RingUnavailable` return left all five counters unchanged | The independent precondition of the unreportability finding, stated as a fact about the code path rather than as a claim that reporting is wrong. True today for four of five causes |
| `ring_diagnostics_reported_healthy_with_a_nonzero_exhaustion_count` | `diagnostics()` emitted `state: "healthy"` while `exhaustion.observed` was non-zero | Legal by construction: the `match` at `:176-190` keys on `accounting()` alone, so this is a fact about the derivation, not an outcome |
| `ring_publish_one_returned_err` | One publication failed for any of the four causes | Ordinary under a full ring or a hostile serializer. The precondition of the misattribution, without asserting which cause was delivered |
| `ring_endpoint_outer_catch_unwind_observed_a_panic` | The `catch_unwind` at `:279` returned `Err` | The independent precondition of the orderly-completion misreport. A panic on this thread is a legal, if undesired, event and the boundary exists for it |
| `ring_completion_hook_ran_after_the_complete_store` | A publish reached `:568-575` with the ticket already at `COMPLETE` from `:567` | The deliberate current ordering. Recording it is what scopes the panic record's second clause honestly, rather than asserting the ordering is wrong |
| `ring_receive_one_released_a_lease_on_the_oversize_control_path` | `:475-477` released a lease after an oversize channel-0 rejection | A legal input outcome; `MAX_CONTROL_BODY_LEN` (`wire.rs:374`) exists for it. This path has no test at all today |
| `ring_receive_one_dropped_a_lease_without_routing_a_release_error` | A `Cancelled` (`:493`, `:513`) or `Overloaded` (`:499`) return dropped its lease, so `ReceiveLease::Drop` handled the release | The independent precondition of the reporting asymmetry, and legal: the drop path is the designed teardown. It does **not** assert that a release failed |
| `ring_receive_loop_took_the_received_true_branch` | `receive_one` returned `Ok(true)` and the loop skipped the `select!` at `:422-442` | Legal and the common case under load; the comment at `:429-435` states it as intent. The precondition of the deferred cancellation report |
| `ring_generation_was_cancelled_while_inbound_was_non_empty` | `root` or `read_cancel` was cancelled while the peer-to-host ring still held a frame | Legal on any live teardown, and the state the liveness bound is measured from |
| `ring_reclamation_recorded_without_awaiting_the_io_task` | `record_reclamation` (`connection.rs:209`) ran after the early return at `:273-276` skipped the `:347` await | The independent precondition of the premature increment, stated as the control-flow fact it is. Legal: connecting during drain is a supported race |
| `ring_admission_admitted_at_process_capacity` | An `admit` succeeded when `active` reached `per_connection_limits() * max_connections` | Legal and already built by `shm_failure_modes.rs:267`. The precondition of the exhaustion cause |
| `ring_peer_exited_without_writing_a_goodbye` | A peer process terminated with no encoded goodbye on the setup socket | Legal: `Victim::kill` produces it today and CI runs it. The precondition of every peer-death path |
| `ring_frame_body_reached_the_maximum_legal_length` | One published body equalled `MAX_FRAME_BYTES` | A legal input at the documented cap. The precondition of the single-usable-frame geometry, not a claim about what `reserve_until` then does |

**Anti-patterns to avoid in this sub-part specifically.** Four pairings are
forbidden by METHOD's rule, and each is tempting here because in every case the
defect is easier to name than its precondition.

- Do not pair `always(!charge_stranded)` with `sometimes(charge_stranded)`. That
  marker can only fire by observing the leak, and the leak is permanent and
  silent because `AdmissionController::release` swallows a `checked_sub`
  underflow (`profile.rs:516-519`). Assert
  `ring_endpoint_thread_released_its_admission_charge` and
  `ring_endpoint_thread_exited_before_run_endpoint_was_entered` instead: two
  independent preconditions, both legal, both present on a correct build.
- Do not pair `always(cause_is_not_clean_eof)` with
  `sometimes(cause_is_clean_eof)`. Assert `ring_publish_one_returned_err`
  instead, which is the independent precondition and true today with the
  publication path behaving exactly as written.
- Do not pair `always(release_error_is_reported)` with
  `sometimes(release_error_dropped)`. Assert
  `ring_receive_one_dropped_a_lease_without_routing_a_release_error` instead. The
  drop path itself is legal; only a *failed* release on it is the defect, and a
  marker that requires the failure can fire only by observing it.
- Do not pair `always(quarantined == ZERO)` with `sometimes(quarantined > ZERO)`.
  The second can never fire, since no host path calls `Admission::quarantine`
  (`profile.rs:568`), so the pairing would look like passing coverage forever.
  The two existing assertions at `:774` and `:800` already make the `always`
  half and they pass vacuously; the honest addition is the enumeration in the
  record, not a marker.

One further constraint on every marker here. `run_endpoint` swallows its own
panic (`let _ =` at `:279`) and then releases and signals regardless (`:291`,
`:292`), so a marker placed *after* the `catch_unwind` cannot distinguish a
panicking exit from an orderly one. Place markers at the point where the
precondition becomes true, inside the boundary, not after the code has finished
depending on it.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability. Records-per-capability would put fault
injection at the top, and that is the wrong answer here.

**The cheapest item on this list is not a fault. It is running the 14-test
semantic contract suite that already exists** — which is also where this
sub-part's largest coverage gap lives, since four of that suite's positive
datapath contracts have no record at all (see the queued gaps in
[portfolio-evaluation.md](portfolio-evaluation.md)). State that plainly, because the
natural reading of a 14-record catalog is that new tests are the bottleneck.
They are not.

1. **R0, running the existing in-crate suite in CI.** A workflow change and
   nothing else: add an `mc-host` lib target invocation alongside the existing
   `--test` steps. It unblocks **zero** new records and protects **35 existing
   test functions**: 14 in `wire.rs`, 14 in `frame_channel/contract_tests.rs`,
   and 7 in `ring_transport.rs`. The 14 in the contract suite are the ones that
   matter most, because nine of them drive a **real** `DuplexRing` through the
   production `prepare` (`RingFactory::connect`, `contract_tests.rs:498-521`) and
   they are the only checks anywhere on FIFO ordering, saturation and reserved
   control capacity, completion-hook ordering, discard charge release, and
   graceful drain. Nothing else on this list matters until this is done, because
   anything added below is added to a suite no automation executes. The two
   `compile_fail` doctests at `frame_channel.rs:296-308` already run
   (`ci.yml:190`), which is proof the wiring cost is small: the lib **doc** target
   is built today and the lib **test** target is not.

2. **Producer-census oracles, no fault and no fixture.** Five records are
   discharged by enumerating call sites rather than by running anything:
   `ring-a-no-producer-retains-a-committed-release-identity`,
   `ring-a-host-never-quarantines-an-admission-charge` (primary oracle),
   `ring-a-rejected-drain-failure-close-has-no-producer`,
   `ring-a-segmented-inbound-body-has-no-production-producer`, and the structural
   half of `ring-a-endpoint-thread-solely-owns-both-ring-endpoints`. The doctor
   record has **left this list**: its five classes are client-side situations with
   a live classifier, not missing producers, so a census says nothing about it.
   Each remaining census costs one pass over the tree. Their value is that they
   are the sub-part's actual findings, and two of them are currently hidden by
   suppressions rather than by absence of testing: `#[allow(dead_code)]` on the
   `ReadClose` enum (`frame_channel.rs:32`) and an
   `#[allow(dead_code, reason = ...)]` whose reason is false at `HEAD` (`:476`). A
   census check in CI is cheaper than a test and catches the reintroduction case.
   Read this item together with bias 1 in
   [portfolio-evaluation.md](portfolio-evaluation.md): if census records do not belong in this
   catalog, this item shrinks to the confinement half and the ranking changes
   under it.

3. **One fixture edit, combining two tests that already exist.** The
   ingress-wait state is one precondition short in each of two inline tests: take
   `ByteBudget::new(0)` from `budget_wait_observes_read_cancellation` (`:1028`) and
   the queued outbound frame from `copied_control_frame_records_one_host_adapter_copy`,
   and the state at `:522-542` with `:533-540` executing exists. That makes
   `ring-a-ingress-wait-holds-a-lease-while-servicing-egress` non-vacuous and
   supplies the enabling state for the asymmetry half of the publish-failure
   record. Cheapest new state in the sub-part.

4. **R6, a panicking hook through the seam that exists.**
   `TestHost::start_with_publish_hook` (`support/mod.rs:597`) is already used by
   `lifecycle.rs`, so only the panicking closure is new. It makes the panic
   record non-vacuous and, because the oracle must read the connection's
   disposition rather than the thread's return, it also builds the observation
   apparatus records 5, 3, and 9 all need.

5. **R3, a peer that attaches and stops receiving.** `raw_client.rs` already
   attaches (`:644`) and owns its receive loop, so withholding receipt is a
   fixture choice with no seam. Makes the publish-failure record non-vacuous.

6. **A charge-delta oracle wrapped around the kill harness that already runs.**
   `shm_failure_modes.rs:233` and `:248` already SIGKILL a peer at three roles
   and assert a resource baseline; upgrading to a `snapshot().active` delta per
   connection converts an existing CI-protected test into a witness for
   `ring-a-admission-charge-releases-on-every-endpoint-thread-exit` on its
   clean and peer-death paths. **This is the highest-value item that is already
   inside CI**, and it is ranked below the four above only because it edits a
   test that runs rather than one that does not.

7. **R5, a maximal frame.** No seam, but it needs `max_resident_bytes` raised
   through `TestHost::start_with` and the answer to an open question: whether
   `reserve_until` blocks to the frame deadline or fails immediately when one
   body fills the arena. Worth doing because the geometry gives no slack, and
   because whichever way it resolves it routes into the publish-failure record.

8. **Rebuilding a named-crash-point kill harness (R2 mid-frame).** This is the
   expensive item and the correction above is why it appears at all.
   `shm_process.rs` was 911 lines and provided barrier-synchronized crash points
   (`request_published`, `response_published`), `reap_killed`-gated observation
   windows, and process-state helpers. Rebuilding it would unblock the mid-frame
   half of the publish-failure record and give
   `ring-a-reclamation-count-does-not-witness-charge-release` the connect-during-drain
   barrier it currently lacks. It is genuinely costly, and the coarse harness
   plus items 3 through 6 should be exhausted first.

9. **R1, which needs a new seam.** An injectable failure inside `prepare` is the
   only route to the four uncounted `RingUnavailable` causes, which is quiet area
   2 in `existing-checks.md`. It is last because a seam is a production code
   change and this catalog makes none.

   **R4 was ranked here and does not belong here.** This item previously read "R1
   and R4, which need new seams", and named R4 the sole blocker on
   `ring-a-lease-release-failure-is-observable-only-on-the-success-path`. R4 needs
   no seam: `Ring::enter_quarantine` is public (`ring.rs:1035`) and the test peer
   already holds the ring through `RingClientEndpoint`'s `pub` fields
   (`ring_transport.rs:627-632`). It belongs beside item 3, because the fault
   composes with the same ingress-wait fixture: park the host in the budget wait
   with a lease held, call `endpoint.to_host.enter_quarantine()`, and the
   `Cancelled` and `Overloaded` release paths are exercised with their `Result`
   dropped. One fixture, two records.

---

## Map addition: the four records carried from `part-2b-wire-and-channels`

Appended when the four wire-header records were carried into this sub-part; see
[catalog.md](catalog.md#group-g-the-wire-header-decode-contract). The 14-record
map above is unchanged, and so are its totals. **"Non-vacuous today" carries the
same meaning as above:** a developer can construct the required state with the
current harness. It does not mean the check runs anywhere; under `R0` none of
these does either.

**No new fault class is needed.** This is the notable thing about the group. All
four records are pure-function properties over peer-authored or caller-authored
bytes, so none of `R1` through `R6` applies to any of them, and the only class
that touches them is `R0`, test execution in CI, which is a workflow change
rather than a fault. That makes them the cheapest constructible records in the
sub-part and the ones with the least excuse for being uncovered.

**Reachability is recorded per record in `catalog.md`, not here.** All four are
`default-production`, each verified at carry time against the three production
`decode_header` call sites (`ring_transport.rs:503`, `:730`, `client.rs:1978`)
and the two production encoders (`wire.rs:571`, `:608`), not inferred from the
absence of a gate. One sub-surface named by a record is genuinely test-only and
is labelled at the record rather than here: `wire::encode_frame`
(`#[cfg(test)]` at `wire.rs:541`).

### The wire header decode contract

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| decode-header-is-total-over-arbitrary-bytes | **No fault. Arbitrary bytes are the entire enabling state.** A property test over `Vec<u8>` of arbitrary length, plus an exhaustive length sweep from 0 to 21 so gates 1 (`wire.rs:307`) and 3 (`:312`) are hit at both boundaries rather than at the two hand-picked points the existing tests use. On `Ok`, assert all eleven gate postconditions (`:307`, `:311`, `:312`, `:321`, `:323`, `:326`, `:329-331`, `:332-339`, `:340`, `:345`, `:352`). Under a harness that treats a panic as failure, the totality half needs no `catch_unwind` | **Yes** — the cheapest record in the sub-part. `decode_header` is `pub` on `pub mod wire` (`lib.rs:39`) and pure, so the oracle is a loop with no fixture host, no ring, and no peer. The one constraint is placement: the length sweep and the postcondition assertions want `wire.rs`'s own test module, which no CI job builds under `R0` |
| accepted-header-decode-is-a-bijection-on-twenty-one-bytes | **No fault.** Three oracles, all pure: a **decode-first** round-trip (`decode_header(bytes).unwrap().encode() == bytes`), a per-bit influence sweep over the 168 bits of an accepted seed, and a trailing-byte independence check. Note the direction on the first: the three existing tests (`wire.rs:680`, `:693`, `:703`) all go encode-first from a constructed `EnvelopeHeader`, which cannot reach a byte pattern the struct cannot represent, and `:703` asserts on `encode` alone. Getting an accepted seed needs `hdr_with_epoch` (`:654-671`) or an equivalent, because the eleven gates reject almost all arbitrary 21-byte inputs | **Yes** — and it shares its bit space with the totality record's structured-mutation sweep, so the two are cheapest written together. Nothing here needs a fault, a host, or a seam |
| reserved-encodings-and-identity-pairings-reject-at-decode | **A peer-authored header, which is the baseline trust model. No concurrency and no timing.** The oracle is a 256x256 sweep of the flags byte crossed with the type byte, crossed again with `(channel, epoch)` in `{(0,0), (0,1), (1,0), (1,1)}`, asserting the *specific* `DecodeError` variant per invalid combination rather than merely that it rejects. Two constraints the sweep must respect: the expectation has to be computed from the protocol tables (`docs/mc-host-wire-protocol.md:226-234`, `:240-246`, `:248`) rather than from `Flags`' own accessors, or the oracle is circular per METHOD's rule against a circular expected value; and it must model the **gate order**, since the flag and type gates precede the pairing gates, so a frame violating both reports the flag error | **Yes** — 65,536 pure calls is milliseconds, and the end-to-end half already exists in two forms (`tests/protocol_vectors.rs:351`, `:504`). The genuinely new assertion is the no-normalization one, stated over the *accepted* value: `!flags.has_reserved_bits()`, `priority().is_some()`, `admission_class().is_some()`. That is the assertion a masking regression would fail, and the existing four-input test would also catch it for its four inputs only |
| encoder-never-emits-a-frame-its-own-decoder-rejects | **No fault. A caller passing an out-of-contract value, which is the whole enabling state, and the generator has to be built to reach it.** Four holes: `Flags(0b1100_0000)` and `Flags(0b0000_0110)` through the tuple constructor at `wire.rs:142` rather than `Flags::new` (`:146-156`), which cannot produce them; `encode_owned_frame(FrameType::Ping, .., nonempty_body)` since `Ping` is in `is_pure_header`'s set (`:86-88`); and `FrameId::routed` (`:525-531`) with a hand-built `RouteHandle`. **The last needs a hand-built handle specifically, and that is a resolution rather than a gap:** `RouteRegistry::reserve` (`routing.rs:113-156`) cannot mint epoch 0 or channel 0 (`:123`, `:125`, `:129-130`, pinned at `:522-526`), so the route allocator is closed and the public fields at `handler.rs:36-40` are the only door | **Yes for construction, and the test will fail, which is the point.** Every hole is reachable with no fault, no host and no seam; the oracle is `encode_owned_frame` output fed through `decode_header` plus `validate_inbound_header` (`frame_channel.rs:58`) in the order `ring_transport.rs:503-505` uses them. But the property does **not hold at `HEAD`**, so the check is a specification of the fix rather than a regression guard, which is why the record reads `Exercised: not yet` rather than `partial`. A generator restricted to the safe constructors proves nothing, and that restriction is exactly why the two existing round-trips cannot reach the holes: both build fixtures with `hdr` (`:650-652`), which derives the epoch as `u32::from(channel != 0)` |

**Totals for the four: 4 fully non-vacuous today, 0 partial, 0 not
constructible.** The eighteen-record totals are therefore **11 fully non-vacuous,
5 partial, 2 not constructible**. Note the asymmetry the fourth row records: for
the first three, "non-vacuous" means a passing check is available and absent; for
the fourth it means a *failing* check is available and absent, because the
property is a gap rather than a guarantee. The map above has no row of that shape
and the distinction is worth keeping visible.

## Coverage checks to add: the carried four

Three entries: one thing a later pass should not do, and two markers. Both
markers are cheap, because neither needs a fault.

1. **A per-record marker on the decode path is not needed and should not be
   added.** Stated so a later pass does not add one. All three of the passing
   records' checks are `always` over a pure function, evaluated directly at the
   call rather than observed through the running host, so there is no vulnerable
   window whose preconditions a coverage marker would assert. Per METHOD's
   coverage rules, a marker here would have nothing independent to observe.
2. **`ENCODER_EMITTED_SELF_REJECTING_FRAME`.** For the encoder record only, and
   the one place a coverage check earns its keep in this group. It must not assert
   the violation, so it asserts the independent preconditions that jointly create
   the window: an emission whose `flags` value did not come from `Flags::new`, or
   whose `ty` satisfies `is_pure_header` while its body is nonempty, or whose
   `FrameId` came from `routed` with a `RouteHandle` the registry did not mint.
   Any one of those is observable at the encoder entry without knowing whether the
   decoder would reject. The marker name is constant and globally unique, per
   METHOD's coverage rules.
3. **`WIRE_DECODE_REJECTED_RESERVED_ENCODING`.** For the reserved-encoding record,
   asserting the precondition rather than the outcome: that a header carrying a
   reserved flag bit, a reserved priority or admission encoding, an unassigned
   type byte, or a mismatched pairing actually reached `decode_header` from a peer
   during the campaign. This is a `sometimes`-shaped situation marker, distinct
   from the record's own `always` check, and its value is that it distinguishes
   "the gates held" from "no peer ever tested them". Today the second is what the
   integration suite gives: `tests/protocol_vectors.rs:351` constructs the
   situation deliberately and nothing else does.

## Leverage addition: where the carried four sit

Against the ranking above, the four carried records sit at the top on cost and
near the bottom on urgency, and both halves of that should be said.

**Cheapest valid oracle in the sub-part, by a wide margin.** The 14 records above
all need at least a fixture host, and most need a fault from `R1` through `R6`,
two of which have no seam. These four need a loop. There is no ring, no peer, no
`TestHost`, no thread, and no timing. Three of the four could be written in an
afternoon in `wire.rs`'s existing test module.

**But three of the four guard properties that hold today**, and their value is
the reasoning rather than the defect: the totality record's margin between
`HEADER_LEN` and the largest constant index is exactly zero and written down
nowhere, and the bijection record's two offset maps agree by textual coincidence.
Both are regression guards for changes nobody has made.

**The fourth is different and should be ranked with the sub-part's real
findings.** `encoder-never-emits-a-frame-its-own-decoder-rejects` is a live gap,
not a guard: four argument tuples reachable from the crate's public surface
produce frames the host's own decoder refuses, and
`docs/mc-host-wire-protocol.md:296` requires the receiving peer to answer by
retiring the connection with no error frame. That failure mode composes with two
records above rather than standing alone —
[ring-a-publish-failure-is-reported-as-a-clean-peer-close](catalog.md#ring-a-publish-failure-is-reported-as-a-clean-peer-close)
and
[ring-a-endpoint-thread-panic-is-reported-as-orderly-completion](catalog.md#ring-a-endpoint-thread-panic-is-reported-as-orderly-completion)
— both of which establish that the host reports such an outcome as an orderly or
clean close. So an emit-side contract break surfaces as an unattributable peer
drop, which is the same attribution hole those two records already name from the
receive side. **That composition is the strongest reason to have carried this
group, and it is a relationship the map above could not have found, because the
codec was outside every lens that produced it.**
