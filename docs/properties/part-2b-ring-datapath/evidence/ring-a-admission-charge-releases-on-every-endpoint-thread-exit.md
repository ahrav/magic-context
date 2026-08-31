# ring-a-admission-charge-releases-on-every-endpoint-thread-exit

## Discovery trigger

Part 1's two custody records rested on `crates/mc-host/src/provider_recovery.rs`,
which the refactor deleted with no successor file. The lens task asks what now
owns charge release and recovery, or whether nothing does. Reading `prepare`
answers it: charge release moved onto the endpoint OS thread, and there is no
recovery driver at all.

## Evidence trail

**Who charges.** `RingTransport::prepare` calls
`self.admission.admit(&self.profile, None)` at
`crates/mc-host/src/ring_transport.rs:223`. On failure it increments
`exhaustions` and returns `RingUnavailable` (`:224-226`). On success it holds an
`Admission` guard.

**Who owns the guard.** The guard is moved into the thread closure spawned at
`:238-240`. `prepare` does not keep a copy; `RingTransport` has no `Admission`
field (`:83-92`). So from `:240` onward the endpoint thread is the sole owner.

**Who releases.** `admission.release()` at `:276`, immediately after the
`catch_unwind` block at `:264-275` and immediately before
`done_tx.send(())` at `:277`.

`Admission::release` (`crates/mc-shm-transport/src/profile.rs:561-564`;
`profile.rs` was not re-swept post-#131) consumes
`self`, calls `controller.release(self.charges)`, and sets state to `Released`.
`AdmissionController::release` (`profile.rs:512-520`) takes the accounting lock,
does a `checked_sub`, and on success also calls
`accounting.release_spans(charges.spans_per_frame)`. On lock-poison it returns
silently (`:513-515`); on `checked_sub` underflow it silently does nothing
(`:516-519`).

**The three paths that never reach `:276`.** All rely on `Admission`'s `Drop`
(`profile.rs:583-589`), which releases when the state is still `Active`:

1. `:249-255` — runtime build or `DuplexRing::create` failure. Sends
   `Err(RingUnavailable)` on the init channel and `return`s from the closure.
   `admission` is a live local, so unwinding is not involved: the ordinary
   scope-exit drop runs.
2. `:256-259` — `worker_descriptor(&rings)` failure. Same shape.
3. `:261-263` — `initialized_tx.send(..).is_err()`, meaning `prepare` already
   gave up on the receive at `:282`. Same shape.

**A fourth path outside the closure.** `:279-281`: if
`std::thread::Builder::spawn` fails, the closure was never created, so the
`Admission` guard is still a local of `prepare` and its `Drop` releases at the
`return Err(RingUnavailable)`. Confirmed by reading `:223-281`: `admission` is
bound at `:223` and moved at `:240` only if `spawn` is reached, and `spawn`
consumes the closure by value, so a spawn failure means the closure — and the
guard inside it — is dropped when `spawned` is inspected at `:279`.

**The panic path.** A panic inside `run_endpoint` unwinds into the
`catch_unwind` at `:264`, whose result is discarded with `let _ =`. Execution
continues to `:276`, so the explicit release still runs. The `DuplexRing` was
moved into `run_endpoint` by value (`:265`, signature at `:359-368`), so unwinding
drops it and unmaps both mappings before `:276`. That ordering matches
`docs/mc-host-shm-transport.md:49`, "Joined endpoint teardown returns its
admission charge when the mapping is unmapped."

**What owns recovery: nothing.** `provider_recovery.rs` is gone. The surviving
observation surface is `pub(crate)` counters — post-#131 three,
`record_activation`/`record_peer_death`/`record_reclamation`
(`ring_transport.rs:198-207`), since `record_attachment` was removed by the
eventfd rewrite — called from `connection.rs`. Those are counters, not a state
machine.
`AdmissionController` has no sweeper, no timer, and no reconciliation pass: its
only mutators are `admit`, `release`, and `quarantine` (`profile.rs`), and the
last has no `mc-host` caller at all (see
`ring-a-host-never-quarantines-an-admission-charge`).

## Failure scenario

A charge stranded on any path is permanent for the host incarnation. Because
`process_limits(connections)` multiplies the per-connection charge by
the connection count with checked arithmetic — post-#131 additionally capped by
`MAX_RING_RESIDENT_BYTES` (`ring_transport.rs:60-80`) — one
stranded connection's worth of arena bytes permanently removes one connection
slot. The failure surfaces much later, on an unrelated connect, as
`admit` returning `Err` at `:223`, which becomes `RingUnavailable`, which
`connection.rs:149-164` turns into a bare `return`. Diagnostics still reports
`state: "healthy"` (`:165-179`), with the leak visible only as
`accounting.active` never returning to zero.

The realistic route to a strand is not one of the four paths above — those are
all `Drop`-covered — but a future edit that adds a fifth early return inside the
closure after the guard has been partially consumed, or a `release()` that runs
twice. A double release cannot go negative because of the `checked_sub` at
`profile.rs:516`, but it also cannot be detected, so a double release silently
frees another connection's charge and the overcount is invisible.

## Timing windows and dependencies

Window: from `admit` at `:239` to the release, which is at most the connection's
whole life. There is no narrow interleaving; the risk is path coverage, not
ordering.

Dependency: `ring-a-reclamation-count-does-not-witness-charge-release` shows
that the `reclamation.completed` counter cannot be used as the oracle for this
property, because on one path it increments before the release. So the oracle has
to be `accounting()` itself.

## What a test must construct

Per-path, with a common oracle: snapshot `accounting().active` before `prepare`,
force the path, join the endpoint thread, snapshot again, and assert equality.

- Normal exit: prepare, cancel `root`, await the `io` future, snapshot.
- `DuplexRing::create` failure: exhaust `/dev/shm` or the process fd limit so
  shared-memory object creation fails. This is the awkward one; a test-only
  injection point on `prepare` would be cheaper than the real fault.
- `worker_descriptor` failure: needs `Ring::attachment()` to fail
  (`ring_transport.rs:318-321`), which again wants injection.
- Thread-spawn failure: needs the thread limit, or injection.
- Panic in `run_endpoint`: the publish hook (`:213`, test-only) is the cheapest
  injection point already in the tree.

The `RingFactory` harness at `frame_channel/contract_tests.rs:498-521` builds a
real `RingTransport` and calls the production `prepare`, and it uses
`per_connection_limits()` as the process limit (`:501-503`), so exactly one
connection fits. That makes it a good place to assert exhaustion-then-recovery:
prepare, tear down, prepare again, and require the second to succeed.

No such test exists in the 2b file set.
`crates/mc-shm-transport/tests/contract.rs:472` covers `Admission::release` at
the transport layer only.

## Investigation log

### Q: What now owns charge release and recovery, after `provider_recovery.rs`?

- Sources examined: `ring_transport.rs:223-281` (`prepare`), `profile.rs:544-589`
  (`Admission`, its states, `release`, `quarantine`, `Drop`; `profile.rs` not
  re-swept post-#131),
  `profile.rs:512-540` (`AdmissionController::release` and `quarantine`),
  `connection.rs:187-209` (the counter call sites), the whole
  `AdmissionController` mutator set.
- Findings: **charge release is owned by the endpoint OS thread**, explicitly at
  `ring_transport.rs:276` and implicitly by `Admission`'s `Drop` on the four
  early paths. **Recovery is owned by nothing.** There is no successor to
  `provider_recovery.rs`: no sweeper, no reconciliation, no quarantine
  transition, and no state machine. What remains is four monotone counters whose
  only consumer is `diagnostics()`.
- Missing evidence: whether the removal of a recovery driver was deliberate.
  `docs/mc-host-shm-transport.md:49` still describes recovery-shaped behaviour
  ("Native aliases whose detachment fails keep their channel and mapping alive
  until cleanup succeeds"), and nothing in `mc-host` implements that retention.
- Conclusion: resolved with answer for release; for recovery, resolved with the
  answer "nothing owns it", and the question of whether that is intended is
  handed on as needs-human-input in the lens file.

### Q: Is a double release meant to be silent?

- Sources examined: `profile.rs:512-520` (`release`, `checked_sub` with a silent
  `if let Some`), `profile.rs:522-541` (`quarantine`, which by contrast returns
  `Err(AdmissionError::AccountingUnavailable)` on the same underflow at
  `:528-530`).
- Findings: the two mutators disagree. `quarantine` treats a `checked_sub`
  underflow as a reportable accounting fault; `release` swallows it. Since
  `Admission` is consumed by value in both `release` and `quarantine` and its
  `Drop` checks the state flag, a double release through the safe API is not
  constructible — the type system prevents it. So the silent branch is
  defence-in-depth for an unreachable case.
- Missing evidence: none needed for the correctness question.
- Conclusion: resolved. The silent branch is currently unreachable through the
  safe API, so it is a latent asymmetry rather than a live defect. Worth noting
  because it means the `checked_sub` guard cannot be used as a detector if a
  future path does introduce a double release.
