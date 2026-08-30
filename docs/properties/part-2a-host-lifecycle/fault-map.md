# Part 2a fault-to-property map

For each property, what must actually occur for a test to be non-vacuous, and
whether the harness can produce it today.

Same rules as Part 1: safety checks hold *while* their faults are active; liveness
checks need a bounded fault-free window; crash-recovery needs a real termination;
rare implementation branches need deterministic injection to be reachable at all;
and coverage checks assert independent preconditions, never the violation.

## Fault classes required

| Class | Description | Available today |
| --- | --- | --- |
| H1 multi-thread scheduling | A runtime that can interleave the writer task with the read loop | **Partial, corrected after portfolio evaluation.** Multi-threaded tests exist: four in `tests/activation.rs` and three in `tests/lifecycle.rs`, plus a two-worker runtime in the echo-host helper. What is missing is narrower: the in-crate unit tests are all current-thread, including all four latch tests and the three connection tests, and `tests/transport_negotiation.rs` is current-thread throughout. A flavour attribute alone is also **not** sufficient for the mutex-order records: reaching a specific lock order needs an explicit barrier or an extracted state machine, not just more threads |
| H2 deterministic panic injection | A forced panic at a named internal point | **Partial, better than first assessed.** The frame type exposes the completion hook and the writer has a test constructor, so completion-hook panic injection is available in-crate today. Freeze-step and acknowledgement-step panics are not |
| H3 task abort at a chosen point | Aborting a task while it holds a specific handle | **No — and not applicable to the shutdown hook**, whose body is a synchronous closure with no await point, so tokio cannot cancel inside it |
| H4 storage and permission faults | Write, sync, mkdir, and rename failures on the runtime directory and the store | **No** |
| H5 clock manipulation | A wall-clock step larger than the freshness window; a pre-epoch clock | **No** — both freshness tests manipulate the record instead |
| H6 fence and filesystem plants | Hostile shapes at the lock, record, and publication names; directory replacement between pin and use | **Partial** — several plants exist; two FIFO cases are Linux-gated, but the probe test module as a whole is not |
| H7 macOS execution | Any in-crate lifecycle or generation test on macOS | **No** — the macOS library step names one unrelated filter |
| H8 slow-peer and stalled-writer | A peer that authenticates then stops reading, with queued frames | **Partial** — exists for the frame channel, not for the forced-shutdown path |
| H9 saturation | Pending, reject, and connection pools driven to their caps | **Partial** — connection permits on the candidate path only |
| H10 CI wiring | The ungated suites named in a workflow | **No** — itself a cataloged finding |

## Map

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| generation-id-strictly-increases-and-is-never-reused | Concurrent accepts; promotions for the two-per-socket case (H1) | No — every test hand-builds one id |
| at-most-one-registered-generation-per-connection | A committed non-TCP grant plus a drain landing in the bootstrap-to-promoted transfer window (H1) | No |
| close-disposition-is-a-total-function-of-the-read-exit-cause | Each of the eleven read-exit sites with queued emissions in flight | Partial — proven only by two ungated integration files |
| retirement-discards-only-through-the-discard-token | A producer suspended between its cancel precheck and its send, with the cancel landing between (H1) | No |
| a-retired-generation-emits-nothing-and-mutates-nothing | An in-flight off-reader emission concurrent with a peer-driven close (H1) | Partial — one shape |
| generation-registry-entry-released-on-every-connection-exit | A panic or abort between insert and removal (H2, H3) | No |
| disconnect-releases-every-resource-keyed-to-the-connection | A committed shutdown between commit completion and promoted registration (H1) | No |
| request-correlation-strictly-increases-per-generation | A repeated or lower correlation; and a mutation weakening the watermark for the insert clause | Partial — watermark covered, insert not |
| promoted-generation-refuses-the-setup-correlations | A client pipelining a low correlation behind its commit request | Partial — pre-promotion only |
| ping-and-consumer-correlations-cannot-cross-settle | A numerically equal consumer correlation | **Yes** — but in an ungated file |
| pong-preanswer-rejected-in-every-mutex-order | A pre-answering peer, writer preemption so the hook wins the lock, and a configured liveness policy (H1) | No |
| host-ping-correlation-exhaustion-retires-the-generation | None constructible; the record exists because a documented MUST has no code | No |
| no-task-outlives-the-generation-it-serves | A shutdown whose response is admitted; the interesting case is a second shutdown while the first watchdog still holds a reference | No |
| the-writer-task-is-abortable-through-a-stated-owner | A stalled peer with queued frames plus a drain that misses its deadline (H8) | No for the forced path |
| draining-rendezvous-is-released-or-the-loss-is-declared | Draining true, a read loop exiting in the drain window, and a route-settle phase slow enough to consume the deadline | No |
| no-generation-registers-after-the-drain-snapshot | A socket accepted and authenticated between the draining store and the snapshot (H1) | No |
| read-task-quiescence-implies-no-further-registration | A read cancellation while an emission task is mid-flight | Partial — the existing fence tests hand-roll the producer |
| a-cancelled-emission-releases-every-permit-it-held | Pools at saturation plus a forced sweep or cancellation while emissions are parked (H9, H3) | Partial |
| no-writer-hook-panic-poisons-a-generation-lock | A configured liveness policy plus an injected panic in a completion hook (H2) | No |
| shutdown-commits-exactly-once-on-write-ack | Two requesters plus a pre-acknowledgement failure on the first | **Yes** — four in-crate tests, though all current-thread |
| admission-freeze-precedes-the-shutdown-commit | A socket accepted between the token cancellation and the freeze (H1) | No — the latch tests have no registry |
| shutdown-commit-effects-are-all-or-nothing | A shutdown reaching write completion plus a panic or abort inside the hook (H2, H3) | No |
| latch-wake-cannot-be-lost | Two concurrent requests plus a pre-acknowledgement failure, on a multi-thread runtime (H1) | Partial — the protocol is unit-tested, the interleaving is not |
| probe-never-reports-stopped-while-either-fence-is-held | A live daemon plus namespace replacement, or a probe inside the acquisition window (H6) | **Yes** — five tests, Linux-only |
| stopping-precedes-unpublication-on-every-path | A storage or permission failure on the runtime directory at teardown, with a publication present (H4) | No — success path only |
| phase-evidence-outlives-a-long-phase | A slow filesystem, large payload, or throttled process making a phase exceed the freshness window (H4) | No — existing tests assert the opposite direction |
| clock-anomalies-do-not-invalidate-live-evidence | A clock step exceeding the window, or a pre-epoch clock, during starting or stopping (H5) | No |
| legacy-incumbent-classification-needs-an-unforgeable-witness | A planted empty-digest record plus a matching publication with the runtime lock held (H6) | Partial — one test, using the forgeable shape |
| an-observed-wedge-cause-reaches-the-operator | Any wedge other than the one forwarded reason; two are already fixtured | No |
| current-profile-never-names-an-unvalidatable-generation | Storage exhaustion at each write and sync point, a delayed-allocation filesystem, and power loss between the two renames (H4) | No — no fault injection, no crash test |
| validation-and-enumeration-address-one-directory-object | A directory replacement between the pin and the walk (H6) | Partial — the two fixed instances have regressions |
| an-undecidable-quarantine-witness-fails-closed | An oversize record or manifest, or any I/O or permission failure on it (H4) | Partial — oversize manifest only |
| persisted-state-quarantine-caps-agree | None; statically checkable, and currently false | No |
| every-declared-cli-reason-id-has-a-producer | A data root on a filesystem lacking atomic exchange, with a corrupt occupant at the digest name | No |
| every-callback-invocation-is-inside-the-redaction-guard | A panicking callback plus a concurrently panicking unrelated task on the same worker (H1, H2) | Partial — the not-over-broad direction only |
| the-panic-hook-cannot-itself-fail | A callback panic concurrent with a write failure on standard error, or a non-draining consumer (H2, H4) | No |
| authentication-and-capacity-rejections-are-observable | An authentication failure, a capacity exhaustion, and a drain refusal | No |
| the-largest-lifecycle-proof-runs-in-ci | None (H10) | No — this record *is* the check |

## Coverage checks to add

Each asserts a precondition a correct system still satisfies, so it fires without
a defect present. Names must be constant and globally unique.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `host_two_generations_live_on_one_socket` | A candidate promoted, so one socket minted two generation ids | Legal and expected on the negotiated path |
| `host_drain_landed_in_generation_transfer` | Draining became true between bootstrap close and promoted registration | Both facts legal; the window is ordinary |
| `host_pong_arrived_before_write_completion` | A pong was parked because its ping's completion had not been recorded | The documented park case, legal by design |
| `host_emission_inflight_at_close_decision` | An off-reader emission was queued when the close decision ran | Legal; the drain paths exist for it |
| `host_latch_waiter_observed_wait` | A shutdown requester lost the latch race and parked | Legal; the latch is designed for it |
| `host_latch_reopened_before_commit` | A pre-acknowledgement failure returned ownership to open | Legal failure ordering |
| `host_phase_exceeded_half_the_freshness_window` | A starting or stopping phase ran past half the window | Legal on a slow host; witnesses the property is being approached |
| `host_probe_sampled_single_fence_held` | A probe observed exactly one of the two fences held | The documented transient the grace budget exists for |
| `host_store_promoted_over_an_occupied_digest` | Promotion encountered an existing occupant | Legal; the repair path exists for it |
| `host_pending_pool_saturated` | The pending pool reached its cap | Backpressure is a legal state |

Anti-pattern to avoid here specifically: do not assert
`sometimes(pong_preanswer_accepted)` beside
`always(!pong_preanswer_accepted)`. That coverage check can only fire by
observing the defect. Assert `host_pong_arrived_before_write_completion` and
`host_two_generations_live_on_one_socket` instead — the independent preconditions.

## Highest-leverage missing capability

Ranked after portfolio evaluation, which refuted the original ranking. The
original put multi-thread scheduling first on the grounds that it unblocked the
most records for the least work. That is wrong twice over: multi-threaded tests
already exist in two of the scope's test files, and more threads alone does not
reach a specific lock order. The corrected ranking is by **cheapest valid
oracle**, not by records-per-capability.

1. **Cheap in-crate units available right now, no new capability needed.** Seed
   the ping counter near its maximum; inject a panicking completion hook through
   the exposed frame hook; saturate the permit pools and abort; assert the two
   quarantine caps; enumerate declared reason ids against producers. Five records
   move from unexercised to exercised with no infrastructure.
2. **H10, wiring the three ungated suites into CI.** Unblocks nothing new but
   *protects* roughly 20 existing checks, including the regression tests for ten
   repaired defects and three of the multi-threaded tests.
3. **Barriers or extracted state machines**, not merely a multi-thread flavour, for
   the mutex-order and drain-snapshot records. This is the real shape of what H1
   was reaching for.
4. **H4, storage and permission faults.** Unblocks 4 records concentrated in the
   store's durability argument, currently proven only on the success path.
5. **H5, an injectable clock.** Unblocks 2 records and is trivial once the
   freshness window is constructible rather than a hardcoded default.
6. **H7, macOS execution.** Removes a whole platform from the unobserved column,
   including the macOS atomic-exchange branch that has never executed under
   observation.

Records that need a **product decision rather than a harness**: the long-phase
coupling, the clock-anomaly semantics, the all-or-nothing commit shape, and the
observability records. No amount of test infrastructure resolves them.
