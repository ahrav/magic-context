# dead-peer-charges-are-reclaimed-or-declared

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

- former `crates/mc-host/src/shm_provider.rs:351-363` — the owner thread runs
  `run_endpoint` inside `catch_unwind` and reduces the whole endpoint lifetime to
  one boolean: `.unwrap_or(false)`.
- former `crates/mc-host/src/shm_provider.rs:364-371` — the only two dispositions.
  `clean` plus no forced hook calls `custody.release()` (former `:365`); anything else
  calls `recovery.report_suspect(custody)` (former `:370`). There is no third branch
  for "the peer is gone".
- former `crates/mc-host/src/shm_provider.rs:475-503` — the endpoint loop. A dead peer
  makes `receive_one` return `Ok(false)`, which falls into `Ok(false) => {}`
  (former `:477`) and loops again. Only an `Err(close)` reaches the classification at
  former `:498`.
- `crates/mc-host/src/ring_transport.rs:464-470` — `receive_one` calls
  `rings.second.try_receive()` and returns `Ok(false)` on `None`.
- `crates/mc-shm-transport/src/backend/ring.rs:783-785` — `try_receive` returns
  `Ok(None)` when `consumed == published`. A dead producer publishes nothing, so
  this is the steady state forever. It is not an error, so nothing quarantines.
- `crates/mc-host/src/config.rs:282` and `:296` — `pub liveness:
  Option<LivenessPolicy>` defaults to `None`, so by default nothing on the host
  side ever writes to the ring on a timer.
- `crates/mc-host/src/ring_transport.rs:447-450` — the other reachable outcome. If
  something does queue an outbound frame, `publish_one` failure returns `false`,
  which is an unclean close and quarantines instead of retaining.
- `crates/mc-host/tests/shm_failure_modes.rs:150-187` —
  `killed_victim_holding_active_charges_is_never_reclaimed`. It reaches the
  `barrier idle_committed` state, kills, reaps, then asserts `stats.active ==
  held` ten times at 50 ms intervals plus once after a further roundtrip, with
  `quarantined == [0; 4]` and `readiness == "Ready"` throughout.
- `crates/mc-host/tests/shm_failure_modes.rs:67` — `one_candidate_charges()`
  supplies the exact `held` tuple the test compares against.
- `docs/mc-host-shm-transport.md:106-108` — the declared gap, naming the pinning
  test and pointing at `magic-context-ymc.12`.

## Failure scenario

A peer commits a candidate, holds it idle, and is killed. Its exact admission
charges stay in `active` for the daemon's remaining lifetime. With
`single_candidate_limits` (former `shm_provider.rs:103-113`), the descriptor, arena,
lease, and mapping caps equal one candidate's charges, so the next admit is
refused and shared-memory eligibility ends for the process. Readiness still
reports `Ready`, so no operator signal distinguishes this from an idle healthy
candidate.

## Timing windows and dependencies

The retention window is unbounded: it closes only when the daemon closes.
Nothing polls for peer liveness, and the ring carries no holder count, attach
epoch, heartbeat, or peer pid that a reaper could read
(`ring.rs:116-127`). The outcome is configuration-dependent, not
fault-dependent: the same kill retains charges under the default
`liveness = None`, and quarantines them under a configured policy once the ring
fills and `publish_one` fails at `ring_transport.rs:447-450`. Depends on
`custody-terminal-transition-exactly-once` for release being correct at all, and
shares its root cause with `attach-reconciles-or-refuses-stale-shared-cursors`
and `crashed-producer-does-not-wedge-the-sequence`.

## What a test must construct

An actual `SIGKILL` of a process holding a committed candidate, with signal-9
wait status required and the observation window anchored to the reap — the
harness in `crates/mc-host/tests/support/shm_process.rs` already does this. The
oracle must be a per-identity charge ledger, not an aggregate: after reap,
either the killed candidate's exact tuple returns to free capacity, or the
snapshot exposes it under a distinct unreclaimable class that the admission
contract subtracts from its cap. The existing test asserts the second half of
neither; it asserts retention. A test for the desired behaviour needs both the
`liveness = None` and the configured-policy arms, because they produce different
outcomes for the same fault.

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
