# custody-terminal-transition-exactly-once

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

A documentation-claim lens: `docs/mc-host-shm-transport.md:79` makes three
promises about custody, and each was traced to the code that enforces it. Two
are enforced. The third, about releases carrying an old provider incarnation, has
no enforcement point at all.

## Evidence trail

- former `crates/mc-host/src/provider_recovery.rs:141-145` declares
  `struct CandidateCustody` with three fields: `candidate_id: u64` at former `:142`,
  `incarnation: u64` at former `:143`, and `state: Mutex<CustodyState>` at former `:144`. The
  catalog's citation of former `:143` for the stored incarnation is exact.
- former `provider_recovery.rs:153-155` is `admitted_incarnation()`, the accessor. The
  catalog's former `:153` is exact.
- former `provider_recovery.rs:167-179` is `release`. Its signature is
  `pub fn release(&self) -> bool`. It takes **no incarnation argument**, so a
  caller cannot present one to be checked, and the body contains no comparison
  against `self.incarnation`. The exactly-once behaviour comes from
  `std::mem::replace(&mut *state, CustodyState::Released)` at former `:169`: the `Active`
  arm at former `:170-173` consumes the `Admission` and returns `true`, and the
  catch-all at former `:174-177` restores the previous state and returns `false`.
- former `provider_recovery.rs:183-197` is `quarantine`, private to the module. Same
  shape: `mem::replace` at former `:185`, `Active` arm at former `:186-191`, restore-and-false
  at former `:192-195`. Together these two functions enforce the phase clause, which is
  what the catalog cites as former `:167-197`.
- A grep for `admitted_incarnation` across the file returns exactly four hits:
  the definition at former `:153` and three test call sites at former `:858`, former `:884`, and
  former `:911`. **No production code reads it.** This confirms the catalog's claim that
  the incarnation clause is unenforced.
- former `provider_recovery.rs:337-341` shows where the value comes from:
  `admit_candidate_while_ready` builds the record with
  `incarnation: state.incarnation` at former `:339`, under the recovery lock taken at
  former `:329`. So the fact needed for a comparison is captured correctly; only the
  comparison is missing.
- former `provider_recovery.rs:483-495` is where the incarnation advances. The
  `CleanupOutcome::Reclaimed` arm does `if record.release() { state.incarnation
  += 1; }` at former `:487-489`, with the comment at former `:484-486`: "Return every active
  charge exactly once, then mint the next provider incarnation: stale releases
  and results carrying the old incarnation are rejected." The comment states the
  intent that the code does not implement for releases.
- The two production callers of `release` are on different threads.
  `crates/mc-host/src/ring_transport.rs:291` runs on the endpoint thread spawned at
  `:319-321`, and discards the result: `let _ = custody.release();`.
  former `provider_recovery.rs:487` runs on the recovery episode's thread.
- The racing terminal transition is real and also off-thread.
  former `provider_recovery.rs:557-573` is `run_deadline`, which drains the inbox and
  in-flight record and calls `record.quarantine()` at former `:571`. Two further
  quarantine sites exist at former `:381` and former `:390` inside `report_suspect`, and one at
  former `:552` in the readiness-resolution path.
- former `provider_recovery.rs:362-365` gives the only guard against a redundant
  suspect: `report_suspect` returns early if `record.phase() != CustodyPhase::
  Active`. That is a read-then-act sequence over a separate lock acquisition at
  former `:158`, so it narrows the race rather than closing it. The `mem::replace` is
  what actually makes the outcome safe.
- Existing check: former `provider_recovery.rs:811`
  `custody_releases_exactly_once_and_rejects_stale_releases`. Verified by direct
  read: it asserts `release()` then `!release()` at former `:816` and former `:820`, then
  `quarantine()` then `!release()` and `!quarantine()` at former `:824`, former `:828`, former `:829`,
  with per-step aggregate assertions. It is sequential and single-threaded, and
  it never involves a second incarnation. The catalog's former `:811` is exact.

## Failure scenario

The incarnation clause fails without any race.

1. A candidate is admitted at provider incarnation 1, so the record stores
   `incarnation: 1` (former `provider_recovery.rs:339`).
2. Another candidate becomes a suspect, the episode resolves `Reclaimed`, and
   `state.incarnation` becomes 2 at former `:488`.
3. The first candidate's endpoint thread finishes cleanly and calls
   `custody.release()` at `ring_transport.rs:291`. Its record is still
   `CustodyState::Active`, so `mem::replace` at `:169` hits the `Active` arm, the
   charges are returned, and the call returns `true`.
4. A release carrying provider incarnation 1 has therefore succeeded after
   incarnation 2 was minted, which is exactly what
   `docs/mc-host-shm-transport.md:79` says is rejected.

The consequence is a contract divergence rather than a counter corruption: the
charges do go back exactly once, because the phase clause holds. What is lost is
the fencing property the document promises, and the reason it matters is that
`:487-489` makes incarnation minting conditional on a release succeeding, so the
two mechanisms are meant to interlock.

The race scenario is separate and, on this evidence, safe. The endpoint thread at
`ring_transport.rs:291` and the deadline watcher at former `provider_recovery.rs:571` can
call `release` and `quarantine` concurrently on the same `Arc<CandidateCustody>`.
Both serialize on the `Mutex<CustodyState>` at former `:144` and both use `mem::replace`,
so exactly one wins and the loser restores the state it found and returns
`false`. The loser's `false` is discarded at both `ring_transport.rs:291` and
former `provider_recovery.rs:571`, so the outcome is invisible, which is why this
property is cataloged even though the mechanism looks correct.

## Timing windows and dependencies

The incarnation defect has no window; it is a missing comparison and holds for
any release issued after any incarnation bump. The race window is the interval
between a suspect being reported and the endpoint thread reaching
`ring_transport.rs:291`, bounded in practice by the episode deadline referenced at
`docs/mc-host-shm-transport.md:106` as 30 seconds. Reaching it requires a
liveness or failure path that makes the same candidate both a suspect and a
clean close, so it interacts with
`dead-peer-charges-are-reclaimed-or-declared`: with
`HostConfig.liveness = None` the endpoint never becomes a suspect and the race is
unreachable. It also interacts with `charge-release-never-silently-strands`,
because `release()` returning `true` says the phase transition won, not that
`AdmissionController::release` (`crates/mc-shm-transport/src/profile.rs:482-490`)
actually moved any counter.

## What a test must construct

For the incarnation clause, no concurrency is needed and the existing rig
already has the pieces. Extend the pattern at former `provider_recovery.rs:846-885`:
admit a record at incarnation 1, drive a second record through a `Reclaimed`
episode so `state.incarnation` becomes 2 (the test at former `:846` already waits for
readiness to return to `Ready`), then call `release()` on the first record and
assert it is rejected while its phase is still `Active`. That assertion fails
today, which is the point.

For the race, two threads must call `release()` and `quarantine()` on one
`Arc<CandidateCustody>` with their entry synchronized by a barrier rather than a
sleep. The oracle is per-record and aggregate: exactly one call returns `true`,
the final phase matches the winner, and `active + quarantined` equals the
record's charges exactly once. Because `quarantine` is private
(former `provider_recovery.rs:183`), the race test must live in the crate's own test
module, as former `:811` does.

## Investigation log

### Q: On preparation failure, charges are returned through `Admission::drop` while the custody phase stays `Active`. Is bypassing `custody.release()` intended?

- Sources examined: former `shm_provider.rs:299-302` (the `Arc<CandidateCustody>` is
  created and is the only handle the provider holds), former `:321` (`move ||` takes it
  into the endpoint closure), former `:331-337` (runtime or ring creation failure sends
  `Err` and returns), former `:339-342` (descriptor failure), former `:343-345` (a dead
  initialization channel returns), former `:365` and former `:370` (the only two paths that
  reach custody), former `provider_recovery.rs:323-342`
  (`admit_candidate_while_ready` returns the `Arc` and retains no copy), a grep
  confirming **no `impl Drop for CandidateCustody` exists**, and
  `crates/mc-shm-transport/src/profile.rs:550-557` (`Admission`'s `Drop`).
- Findings: the premise is confirmed. On each of the three early returns the
  closure ends without touching custody, the last `Arc` drops, `CustodyState::
  Active(Admission)` drops, and `Admission::drop` at `profile.rs:553` returns the
  charges. The phase is never observed as `Released`, and the record is gone, so
  nothing can observe it afterwards. `CandidateCustody` deliberately has no
  `Drop`, so the return depends entirely on `Admission`'s.
- Missing evidence: no comment, plan requirement, or test covers the
  preparation-failure path's accounting. The comment at former `shm_provider.rs:346-350`
  discusses precisely this hazard for the panic case ("instead of letting
  `Admission`'s drop return the charges as clean capacity while ring mappings may
  still exist") and is the reason `catch_unwind` exists at former `:351`, but it does not
  mention the pre-initialization returns above it.
- Conclusion: unresolved, needs human input. The mechanism is fully established.
  Whether the pre-initialization returns are safe by construction, because no
  ring mapping exists yet at former `:335` and former `:341`, or an inconsistency with the
  exactly-once framing, is a design call. Note the asymmetry as evidence for
  whoever answers: at former `:344` the send failure occurs **after** `DuplexRing::
  create` succeeded at former `:329`, so at that one point mappings do exist and the
  charges are still returned as clean capacity by `Admission::drop`.

## Refresh outcome, 2026-08-30

Status moved to `superseded-by-refactor`. The mechanism this record was written
about no longer exists in any form. `ed487e11` deleted
`crates/mc-host/src/provider_recovery.rs`, taking with it `CandidateCustody`, the
`Active`/`Released`/`Quarantined` phase machine enforced by `mem::replace`, the
`admitted_incarnation()` accessor, `ProviderRecovery`, `report_suspect`, and the
covering test `custody_releases_exactly_once_and_rejects_stale_releases`. A search
of the tree at `e447c927` for `custody`, `report_suspect`, `ProviderRecovery`,
`CleanupOutcome`, `ProviderReadiness`, and `PreflightEligibility` returns no hits
outside this documentation.

What now owns the obligation: nothing arbitrates competing terminal transitions,
because there is only one. The host holds a single `Admission` per connection and
calls the infallible `Admission::release`
(`crates/mc-shm-transport/src/profile.rs:562`) exactly once from the endpoint
thread at `crates/mc-host/src/ring_transport.rs:291`, after `catch_unwind`
returns. There is no deadline watcher, no second transition, and no return value,
so the race the record describes is designed out rather than checked. The
`Admission::drop` accounting hazard recorded in the investigation log above is
unaffected and remains live in the transport crate; it is tracked by
`charge-release-never-silently-strands`.

The documentation half of the finding survives the refactor and is now purely a
doc defect: `docs/mc-host-shm-transport.md:79` still describes rejecting releases
"carrying an old provider incarnation", a protocol that never existed and whose
surrounding machinery has since been deleted.
