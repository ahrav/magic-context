# custody-terminal-transition-exactly-once

## Discovery trigger

A documentation-claim lens: `docs/mc-host-shm-transport.md:79` makes three
promises about custody, and each was traced to the code that enforces it. Two
are enforced. The third, about releases carrying an old provider incarnation, has
no enforcement point at all.

## Evidence trail

- `crates/mc-host/src/provider_recovery.rs:141-145` declares
  `struct CandidateCustody` with three fields: `candidate_id: u64` at `:142`,
  `incarnation: u64` at `:143`, and `state: Mutex<CustodyState>` at `:144`. The
  catalog's citation of `:143` for the stored incarnation is exact.
- `provider_recovery.rs:153-155` is `admitted_incarnation()`, the accessor. The
  catalog's `:153` is exact.
- `provider_recovery.rs:167-179` is `release`. Its signature is
  `pub fn release(&self) -> bool`. It takes **no incarnation argument**, so a
  caller cannot present one to be checked, and the body contains no comparison
  against `self.incarnation`. The exactly-once behaviour comes from
  `std::mem::replace(&mut *state, CustodyState::Released)` at `:169`: the `Active`
  arm at `:170-173` consumes the `Admission` and returns `true`, and the
  catch-all at `:174-177` restores the previous state and returns `false`.
- `provider_recovery.rs:183-197` is `quarantine`, private to the module. Same
  shape: `mem::replace` at `:185`, `Active` arm at `:186-191`, restore-and-false
  at `:192-195`. Together these two functions enforce the phase clause, which is
  what the catalog cites as `:167-197`.
- A grep for `admitted_incarnation` across the file returns exactly four hits:
  the definition at `:153` and three test call sites at `:858`, `:884`, and
  `:911`. **No production code reads it.** This confirms the catalog's claim that
  the incarnation clause is unenforced.
- `provider_recovery.rs:337-341` shows where the value comes from:
  `admit_candidate_while_ready` builds the record with
  `incarnation: state.incarnation` at `:339`, under the recovery lock taken at
  `:329`. So the fact needed for a comparison is captured correctly; only the
  comparison is missing.
- `provider_recovery.rs:483-495` is where the incarnation advances. The
  `CleanupOutcome::Reclaimed` arm does `if record.release() { state.incarnation
  += 1; }` at `:487-489`, with the comment at `:484-486`: "Return every active
  charge exactly once, then mint the next provider incarnation: stale releases
  and results carrying the old incarnation are rejected." The comment states the
  intent that the code does not implement for releases.
- The two production callers of `release` are on different threads.
  `crates/mc-host/src/shm_provider.rs:365` runs on the endpoint thread spawned at
  `:319-321`, and discards the result: `let _ = custody.release();`.
  `provider_recovery.rs:487` runs on the recovery episode's thread.
- The racing terminal transition is real and also off-thread.
  `provider_recovery.rs:557-573` is `run_deadline`, which drains the inbox and
  in-flight record and calls `record.quarantine()` at `:571`. Two further
  quarantine sites exist at `:381` and `:390` inside `report_suspect`, and one at
  `:552` in the readiness-resolution path.
- `provider_recovery.rs:362-365` gives the only guard against a redundant
  suspect: `report_suspect` returns early if `record.phase() != CustodyPhase::
  Active`. That is a read-then-act sequence over a separate lock acquisition at
  `:158`, so it narrows the race rather than closing it. The `mem::replace` is
  what actually makes the outcome safe.
- Existing check: `provider_recovery.rs:811`
  `custody_releases_exactly_once_and_rejects_stale_releases`. Verified by direct
  read: it asserts `release()` then `!release()` at `:816` and `:820`, then
  `quarantine()` then `!release()` and `!quarantine()` at `:824`, `:828`, `:829`,
  with per-step aggregate assertions. It is sequential and single-threaded, and
  it never involves a second incarnation. The catalog's `:811` is exact.

## Failure scenario

The incarnation clause fails without any race.

1. A candidate is admitted at provider incarnation 1, so the record stores
   `incarnation: 1` (`provider_recovery.rs:339`).
2. Another candidate becomes a suspect, the episode resolves `Reclaimed`, and
   `state.incarnation` becomes 2 at `:488`.
3. The first candidate's endpoint thread finishes cleanly and calls
   `custody.release()` at `shm_provider.rs:365`. Its record is still
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
`shm_provider.rs:365` and the deadline watcher at `provider_recovery.rs:571` can
call `release` and `quarantine` concurrently on the same `Arc<CandidateCustody>`.
Both serialize on the `Mutex<CustodyState>` at `:144` and both use `mem::replace`,
so exactly one wins and the loser restores the state it found and returns
`false`. The loser's `false` is discarded at both `shm_provider.rs:365` and
`provider_recovery.rs:571`, so the outcome is invisible, which is why this
property is cataloged even though the mechanism looks correct.

## Timing windows and dependencies

The incarnation defect has no window; it is a missing comparison and holds for
any release issued after any incarnation bump. The race window is the interval
between a suspect being reported and the endpoint thread reaching
`shm_provider.rs:365`, bounded in practice by the episode deadline referenced at
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
already has the pieces. Extend the pattern at `provider_recovery.rs:846-885`:
admit a record at incarnation 1, drive a second record through a `Reclaimed`
episode so `state.incarnation` becomes 2 (the test at `:846` already waits for
readiness to return to `Ready`), then call `release()` on the first record and
assert it is rejected while its phase is still `Active`. That assertion fails
today, which is the point.

For the race, two threads must call `release()` and `quarantine()` on one
`Arc<CandidateCustody>` with their entry synchronized by a barrier rather than a
sleep. The oracle is per-record and aggregate: exactly one call returns `true`,
the final phase matches the winner, and `active + quarantined` equals the
record's charges exactly once. Because `quarantine` is private
(`provider_recovery.rs:183`), the race test must live in the crate's own test
module, as `:811` does.

## Investigation log

### Q: On preparation failure, charges are returned through `Admission::drop` while the custody phase stays `Active`. Is bypassing `custody.release()` intended?

- Sources examined: `shm_provider.rs:299-302` (the `Arc<CandidateCustody>` is
  created and is the only handle the provider holds), `:321` (`move ||` takes it
  into the endpoint closure), `:331-337` (runtime or ring creation failure sends
  `Err` and returns), `:339-342` (descriptor failure), `:343-345` (a dead
  initialization channel returns), `:365` and `:370` (the only two paths that
  reach custody), `provider_recovery.rs:323-342`
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
  preparation-failure path's accounting. The comment at `shm_provider.rs:346-350`
  discusses precisely this hazard for the panic case ("instead of letting
  `Admission`'s drop return the charges as clean capacity while ring mappings may
  still exist") and is the reason `catch_unwind` exists at `:351`, but it does not
  mention the pre-initialization returns above it.
- Conclusion: unresolved, needs human input. The mechanism is fully established.
  Whether the pre-initialization returns are safe by construction, because no
  ring mapping exists yet at `:335` and `:341`, or an inconsistency with the
  exactly-once framing, is a design call. Note the asymmetry as evidence for
  whoever answers: at `:344` the send failure occurs **after** `DuplexRing::
  create` succeeded at `:329`, so at that one point mappings do exist and the
  charges are still returned as clean capacity by `Admission::drop`.
