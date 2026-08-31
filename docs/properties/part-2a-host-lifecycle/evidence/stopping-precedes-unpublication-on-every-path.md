# stopping-precedes-unpublication-on-every-path

## Discovery trigger

The catalog recorded the ordering itself as verified and flagged a separate gap:
the phase write's error is discarded and teardown proceeds regardless. The lens
is fault-injection on a path whose in-code justification covers a different
failure than the one the code admits. `begin_stopping` documents itself as best
effort because "a stale phase ages to `wedged` honestly" — that reasoning holds
for a successful write followed by a hang, not for a write that never landed.

## Evidence trail

- `crates/mc-host/src/lifecycle.rs:450-453` is `begin_stopping`. The order is
  correct and total: `write_lifecycle_record(LifecyclePhase::Stopping)` at `:451`
  then `remove_publication()` at `:452`. The doc comment at `:439-449` states
  why — `classify` maps a held lock plus a `running` record with no publication
  to `wedged` — and names the discarded error explicitly at `:448-449`.
- The discard is literal: `let _ = self.write_lifecycle_record(...)` at `:451`.
  No branch inspects the result, so `remove_publication` at `:452` runs whether
  the record now reads `stopping` or still reads `running`.
- Teardown routes through `begin_stopping` at four call sites, all in
  `crates/mc-host/src/runtime.rs`: `:299` in `retain_lock_until_stopped`, `:356`
  in `StartupCleanup::finish`, `:382` in `Drop for PrePublicationCleanup`, and
  `:442` on the dropped-listener path. Each carries a comment naming itself a
  teardown and citing the demote-before-cleanup rule (protocol §12).
- The fifth unpublication route bypasses `begin_stopping` entirely.
  `crates/mc-host/src/instance.rs:393-401` is `Drop for InstanceGuard`: it calls
  `remove_publication()` at `:398` and `remove_lifecycle_record()` at `:399`,
  with no phase write. Its comment at `:395-397` says the graceful path already
  removed the publication, making this a no-op — true when a `begin_stopping`
  path ran first, and not true for a drop that reaches `Drop` without one.
- The target of the ordering is `classify`'s running arm,
  `lifecycle.rs:1144-1157`: a `running` record with no publication returns
  `Wedged` with reason `"running record without a publication"` at `:1153-1156`.
  That is the exact verdict a failed demotion produces for a clean stop.
- The paired write on the way up has the same shape and the same discard.
  `runtime.rs:833-835` writes `Running` as `let _ = ...` after `publish` at
  `:826-829`, and its comment at `:830-832` accepts that probes may then observe
  a fresh `starting` record which "ages to `wedged` honestly."

## Failure scenario

1. A daemon is serving: the record reads `running` and the publication is
   present, so `classify` returns `Running` via `:1145-1148`.
2. Graceful shutdown or a dropped listener reaches one of the four
   `begin_stopping` sites.
3. `write_lifecycle_record` fails at `lifecycle.rs:451`. The write path is
   `crate::instance::write_atomic_owner_only` (`:430-436`), an
   open/write/fsync/rename, so any of ENOSPC, EDQUOT, EROFS, EACCES, or EIO on
   the runtime directory produces this.
4. `remove_publication()` at `:452` succeeds. The on-disk state is now a
   `running` record with no publication, while the instance lock is still held
   by the draining guard.
5. A probe in that window reaches `classify`, finds `lock_free == false`, falls
   through to the running arm, and returns `Wedged` with reason `"running record
   without a publication"`.
6. The CLI's `settle_probe` (`crates/mc-module/src/bin/ck-mc-host.rs:408-418`)
   re-probes only while the state is `Starting` or `Stopping`; `Wedged` returns
   immediately at `:415`. The operator sees a fault for an orderly stop.

## Timing windows and dependencies

The window opens at `lifecycle.rs:452` and closes when the guard drops and
`remove_lifecycle_record` (`instance.rs:399`) unlinks the record — which is
bounded by the drains this teardown is waiting on, and those are deliberately
unbounded (`runtime.rs:286-290`). So the misreporting window is not short; it
lasts as long as the drain. Nothing about the timing depends on an adversary.
This record shares the discarded-write pattern with the `Running` write at
`runtime.rs:833-835`, and shares its verdict target with
`phase-evidence-outlives-a-long-phase`: both end at `classify`'s treatment of a
record the daemon could not refresh.

## What a test must construct

Fault-inject the phase write and run each of the four `begin_stopping` paths.
The injection point is `write_atomic_owner_only`; making the runtime directory
read-only after acquisition, or filling the filesystem, reaches the same failure
without a seam. Then assert one of the three disjuncts: the publication survives
until the phase is demoted, or the verdict is not `wedged`, or the failure is
surfaced. Today none holds, so the test fails as written. A second test should
cover the `Drop for InstanceGuard` route at `instance.rs:393-401` with no prior
`begin_stopping`, which is the path with no phase write at all. The success
direction is already covered by the two tests the catalog names.

## Investigation log

### Q: Do all teardown paths route through `begin_stopping`, and how many are there?

- Sources examined: complete grep for `begin_stopping` and `remove_publication`
  outside `tests/`; `runtime.rs:286-300`, `:344-360`, `:376-386`, `:430-446`;
  `instance.rs:342`, `:393-401`.
- Findings: **Correction.** The catalog says "all five teardown paths route
  through it." There are four `begin_stopping` call sites (`runtime.rs:299`,
  `:356`, `:382`, `:442`), and a fifth unpublication route —
  `Drop for InstanceGuard` at `instance.rs:398` — does not demote the phase at
  all. It is documented as a no-op after a graceful path, which is correct only
  when one of the four ran first.
- Missing evidence: whether a drop can reach `instance.rs:398` with a
  publication present and no preceding `begin_stopping`. That requires tracing
  every construction and move of `InstanceGuard` through `runtime.rs`, which
  this pass did not complete.
- Conclusion: the ordering claim holds for the four demoting paths. The count of
  five should be read as four demoting plus one non-demoting `Drop`, and the
  reachability of that fifth with a live publication is open.

### Q: Is a failed demotion meant to abort or delay publication removal?

- Sources examined: `lifecycle.rs:439-453` including the full contract comment;
  `runtime.rs:830-835` for the parallel discard on the `Running` write.
- Findings: the contract says teardown demotes before cleanup and does not say
  what a failed demotion means. Both discard sites justify themselves by ageing
  to `wedged`, which describes a stale-but-present record, not an absent
  transition.
- Missing evidence: no design note distinguishing the two cases.
- Conclusion: unresolved; needs human input, as the catalog records. Not
  answered here.
