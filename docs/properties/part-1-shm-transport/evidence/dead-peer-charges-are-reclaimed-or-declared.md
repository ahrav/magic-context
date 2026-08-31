# dead-peer-charges-are-reclaimed-or-declared

## Citation refresh, 2026-08-31 (eventfd rewrite)

PR #131 (merge `5d638e3e8`) replaced the polling wake mechanism with sparse
eventfd doorbells, and the surrounding host code changed with it. Three claims
below are now historical: the endpoint no longer polls `try_receive` in a sleep
loop (it parks on the `data_ready` doorbell); `docs/mc-host-shm-transport.md` is
now 85 lines and no longer contains the retention-gap paragraph formerly at
`:106-108` or the unqualified accounting sentence formerly at `:57`; and the
pinning test `killed_victim_holding_active_charges_is_never_reclaimed` no longer
exists in `crates/mc-host/tests/shm_failure_modes.rs`. The Discovery trigger and
Investigation log are kept as history; the sections between them are rewritten
against HEAD.

## Citation refresh, 2026-08-30

The ring-transport refactor (`0f336d3c`, `d8bde128`, `793a973e`, `ed487e11`)
renamed `crates/mc-host/src/shm_provider.rs` to
`crates/mc-host/src/ring_transport.rs` and deleted `provider_recovery.rs`,
`transport_negotiation.rs`, and `transport_provider.rs`. Host-side citations below
were re-anchored against `ring_transport.rs` at `e447c927`.

Where the cited construct survives, the citation names `ring_transport.rs` and a
line re-verified against that commit. Where it does not, the original reference is
kept and prefixed `former`, so it reads as pre-refactor evidence rather than a
current location. A `former` line number is never a claim about the tree today.
Every `provider_recovery.rs` reference is `former` by definition: that module has
no successor. See the refresh note in [../catalog.md](../catalog.md).

## Discovery trigger

`docs/mc-host-shm-transport.md:57` states the accounting claim without
qualification: "Admission accounts active and quarantined descriptor, arena,
lease, mapping, and pinned-worker commitments." Reading the close path for the
provider's owner thread showed only two ways charges leave `active`, and neither
is reachable when a peer dies silently. The transport document already records
this as a gap at `:106-108`, so the record exists to make the gap a claim under
test rather than a paragraph.

## Evidence trail

- Detection is out of band at HEAD. The setup socket is kept open as the
  peer-lifetime sentinel: `crates/mc-host/src/connection.rs:179-190` spawns a
  watcher whose `observe_peer` arm records a peer death for any non-`Goodbye`
  closure (`:183-186`) and cancels the generation and read tokens (`:187-188`).
  `docs/mc-host-shm-transport.md:49` states the contract: "Unexpected closure
  records peer death, cancels ring work, and tears down the exact connection."
- The ring path alone detects nothing, by construction. A dead peer never signals
  the `data_ready` doorbell, so the endpoint arms the wait
  (`crates/mc-host/src/ring_transport.rs:429`) and parks in the readiness select
  (`:441-474`) until a cancellation token or queue event fires. `try_receive`
  returning `Ok(None)` on emptiness
  (`crates/mc-shm-transport/src/backend/ring.rs:1073-1075`) is not an error, so
  nothing quarantines. The former shape — a 50-microsecond poll loop observing
  `Ok(false)` forever — is gone; the steady state is now a parked thread.
- Release is unconditional. The endpoint thread runs `run_endpoint` under
  `catch_unwind` (`ring_transport.rs:264-274`) and then calls
  `admission.release()` (`:276`) whether the endpoint returned or panicked. The
  pre-refactor release-versus-suspect branch (former `shm_provider.rs:364-371`)
  has no successor; both a sentinel-triggered cancellation and a publish failure
  (`:479-483`) end at the same release.
- `crates/mc-host/src/config.rs:221` and `:233` — `pub liveness:
  Option<LivenessPolicy>` still defaults to `None`, so by default nothing on the
  host side writes to the ring on a timer; with outbound traffic queued, a dead
  consumer surfaces as `reserve_until` parking on `capacity_ready` and returning
  `Deadline` at `frame_deadline` (`ring.rs:1035`, `:1043-1044`).
- `crates/mc-host/tests/shm_failure_modes.rs:213-222`
  `setup_active_and_idle_sigkill_each_return_exact_capacity` — the current
  exercise. For setup, active, and idle victims it SIGKILLs a child holding a
  connection (`Victim::kill` requires a signal-9 wait status, `:154-158`) and
  then proves reclaim by readmitting at `max_connections = 1`
  (`connect_after_reclamation`, `:170-181`). `:225-255`
  `repeated_crashes_do_not_ratchet_single_connection_capacity` repeats the cycle
  twelve times against a process-resource envelope. The former pinning test that
  asserted retention is gone; the suite now asserts the opposite outcome.
- What no test asserts: a per-identity ledger. Readmission at a one-connection
  cap shows enough aggregate capacity returned; it does not show the killed
  candidate's exact tuple returned, and no accounting snapshot exposes an
  "unreclaimable" class.

## Failure scenario

A peer commits a candidate, holds it idle, and is killed. Under the eventfd
mechanism the ring goes silent rather than busy: the endpoint is parked on the
`data_ready` doorbell and nothing on the ring path will ever wake it on the
peer's behalf. The guarantee now rests entirely on the out-of-band chain: kernel
closes the setup socket, the sentinel watcher observes non-`Goodbye` closure and
cancels (`connection.rs:183-188`), the endpoint's select wakes on the
cancellation token (`ring_transport.rs:448`, `:473`), the thread joins, and
`admission.release()` returns the charges (`:276`). A defect anywhere in that
chain — the watcher not spawned, the cancellation arm not wired, the endpoint
parked outside the select, or release skipped on a panic path — strands the
charges silently: readiness stays healthy, the parked endpoint is
indistinguishable from an idle one, and with single-candidate limits the next
admit is refused, permanently ending shared-memory eligibility for the process.

## Timing windows and dependencies

The reclaim window is bounded by the sentinel, not the ring: it opens at the
kernel's socket-closure edge on peer exit and closes when `admission.release()`
runs after the endpoint thread joins. The join itself is bounded because every
select arm the endpoint can park in is cancellation-aware
(`ring_transport.rs:441-474`) and the one synchronous wait, `reserve_until`,
is deadline-bounded by `frame_deadline` (`ring.rs:1035`, `:1043-1044`); so the
fault-free bound is one socket-closure delivery plus at most one
`frame_deadline`. Nothing polls for peer liveness on the ring, and the ring
carries no holder count, attach epoch, heartbeat, or peer pid a reaper could
read. Depends on `custody-terminal-transition-exactly-once` for release being
correct at all, and shares its root cause with
`attach-reconciles-or-refuses-stale-shared-cursors` and
`crashed-producer-does-not-wedge-the-sequence`.

## What a test must construct

An actual `SIGKILL` of a process holding a committed candidate, with signal-9
wait status required — the harness in `crates/mc-host/tests/shm_failure_modes.rs`
already does this (`:154-158`). The oracle must be a per-identity charge ledger,
not an aggregate: after reap, either the killed candidate's exact tuple returns
to free capacity, or the snapshot exposes it under a distinct unreclaimable
class that the admission contract subtracts from its cap. The existing SIGKILL
tests assert readmission at a one-connection cap, which is the aggregate form of
the first arm only. A complete test also bounds the window: assert the
readmission succeeds within an explicit bound anchored to the reap (one
socket-closure delivery plus one `frame_deadline` plus recorded slack), so a
teardown that leaks the endpoint thread and only releases at daemon exit fails
rather than passes slowly. The idle-victim arm matters most under eventfd,
because it is the arm where the ring provides no wake at all and the sentinel
chain is the only mechanism under test.

## Investigation log

### Q: Which behaviour is normative when a liveness policy is configured — retention, or quarantine via a failed publish?

- Sources examined: `crates/mc-host/src/config.rs:234-296` and `:370-381` for
  the policy shape and its default; `crates/mc-host/src/connection.rs:291-301`
  for where a liveness loop is spawned per generation;
  former `crates/mc-host/src/shm_provider.rs:475-503` and former `:538-541` for both close
  classifications; `docs/mc-host-shm-transport.md:96-112` for the documented
  failure and close contract; `bd show magic-context-ymc.12`.
- Findings: both outcomes are reachable and neither is written down. The
  document describes the retention outcome only, and does so as a gap rather
  than as a contract. `magic-context-ymc.12` is the umbrella T3 transport task
  in `IN_PROGRESS`, not a defect record for this behaviour; its description and
  notes do not mention dead-peer reclamation or a retained-tuple manifest, so
  the document's "pending the frozen retained-tuple manifest
  (`magic-context-ymc.12`)" points at a task that does not itself scope the
  work.
- Missing evidence: any statement of intent that ranks the two outcomes. No
  plan, manifest, or bead expresses a preference, and
  `crates/mc-shm-transport/benches/manifests/v1.json` carries an empty
  retained-tuple list rather than a policy.
- Conclusion: needs human input. The catalog record should keep both outcomes
  listed as reachable; a test cannot be written until one is chosen, because the
  two arms have opposite oracles.

### 2026-08-31: re-derivation against the eventfd doorbell mechanism

- Sources examined: `crates/mc-host/src/ring_transport.rs:238-276`, `:359-485`,
  `:479-483`; `crates/mc-host/src/connection.rs:170-199`;
  `crates/mc-host/src/config.rs:221-233`;
  `crates/mc-shm-transport/src/backend/ring.rs:828-854`, `:980-1048`,
  `:1073-1075`; `crates/mc-host/tests/shm_failure_modes.rs:118-166`, `:170-199`,
  `:212-255`; `docs/mc-host-shm-transport.md` (whole file, 85 lines).
- Findings: the record's original premise — an endpoint that polls
  `try_receive → Ok(false)` forever and never becomes a suspect — has no referent
  at HEAD. Under eventfd a dead peer looks like a parked endpoint: no doorbell
  signal, no poll, no ring-path detection ever. Detection and reclaim moved
  wholly out of band to the setup-socket sentinel
  (`connection.rs:183-188`), and release became unconditional at
  `ring_transport.rs:276`, so the former release-versus-suspect open question is
  resolved by code change: both close classifications end in release. The suite
  flipped with it — the retention-pinning test is gone and
  `setup_active_and_idle_sigkill_each_return_exact_capacity` now asserts reclaim
  by readmission. The guarantee survives with the reclaim arm exercised in
  aggregate; the declared-exception arm has no remaining code mechanism and no
  remaining documented claim to test against.
- Missing evidence: a per-identity charge ledger oracle, and any measured bound
  on sentinel-to-release latency to anchor the window assertion.
- Conclusion: resolved with answer for the mechanism (sentinel plus unconditional
  release, both cited); the per-identity oracle remains the open test gap carried
  in the catalog record.
