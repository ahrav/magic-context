# clean-reclamation-is-reachable

## Discovery trigger

`docs/mc-host-shm-transport.md:87` states "These are distinct outcomes and
distinct test experiments:" and then describes clean reclamation (line 89) and
quarantine (line 90). A pair of outcomes presented as distinct experiments
implies both are reachable, so the shipped backend's cleanup was traced to see
which branches it can select.

## Evidence trail

`crates/mc-host/src/shm_provider.rs:137-152` is the only production
`RecoveryBackend` implementation:

```rust
fn cleanup(&self, _candidate_id: u64) -> CleanupOutcome {
    self.cleanups.fetch_add(1, Ordering::AcqRel);
    CleanupOutcome::Uncertain
}
```

Lines 138-141. The candidate id is discarded, no state is examined, and
`Uncertain` is returned for every input. `probe` (lines 143-147) returns `true`
unconditionally. `admission_fits` (lines 148-150) is the only method whose result
depends on anything.

The unreachability is deliberate and stated in code. The struct's doc comment at
lines 128-130 reads: "Recovery primitives for the thread-confined ring endpoint.
The rings die with their endpoint thread, so a suspect close leaves alias state
uncertain: cleanup isolates instead of reclaiming." The `probe` body carries the
matching rationale: "No shared state outlives the endpoint thread, so isolation
alone proves the provider side is clean."

The consumer of that outcome is `crates/mc-host/src/provider_recovery.rs`, at the
`match outcome` beginning line 482:

- `CleanupOutcome::Reclaimed` (arm at lines 483-490) calls `record.release()` and,
  on success, `state.incarnation += 1` at line 488 — the charge return and the
  incarnation mint that `docs:89` describes.
- `CleanupOutcome::StaleRetry | CleanupOutcome::Uncertain` (arm at lines 493-495)
  calls `record.quarantine()`.

The catalog cites this region as `481-490`; the `Reclaimed` arm itself spans
483-490, with `match outcome {` at 482 and `state.inflight = None;` at 481.

Every producer of `CleanupOutcome::Reclaimed` in the tree is a test double.
There are three `impl RecoveryBackend` blocks in all:

| Impl | Location | Nature |
| --- | --- | --- |
| `ShmRecoveryBackend` | `shm_provider.rs:137` | production; returns `Uncertain` only |
| `FakeBackend` | `provider_recovery.rs:684`, inside `#[cfg(test)]` at line 578 | unit-test double, scripted |
| `MatrixBackend` | `crates/mc-host/tests/shm_transport.rs:450` | integration-test double |

`CleanupOutcome::Reclaimed` appears as a value at lines 876, 894, 926, 1015,
1054, and 1103 of `provider_recovery.rs`, all inside the `#[cfg(test)]` module.
`clean_reclamation_returns_charges_once_and_mints_a_new_incarnation` (line 889)
reaches the branch by pushing `Scripted::Return(CleanupOutcome::Reclaimed)` at
line 894.

A second documented branch is unreachable for the same reason.
`docs:90` names two triggers for provider-wide `Quarantined` readiness: "failed
probe" and "admission-cap exhaustion". `resolve_readiness`
(`provider_recovery.rs:524-534`) computes `ready = probe() && admission_fits()`
at line 530 under a panic boundary. Since `ShmRecoveryBackend::probe()` returns
`true` and does not panic, only admission-cap exhaustion can set that readiness
on the shipped backend.

## Failure scenario

There is no misbehaviour to trigger; the gap is that one documented outcome
never occurs. Any suspect close on the shipped provider takes the
`Uncertain` path: `record.quarantine()` at line 494, charges stay visible, and no
new incarnation is minted. Over a long-running process every suspect
accumulates quarantined charges, and `admission_fits` is the only thing that can
subsequently change readiness. The documented behaviour "the record's active
charges return exactly once, a new provider incarnation is minted" is proven
only against `FakeBackend`, so a regression in the `Reclaimed` arm would be
caught by the unit test and would have no production consequence either way.

## Timing windows and dependencies

None. `cleanup` is a constant function of its argument, so no interleaving, race,
or fault changes the outcome. The property is a static reachability question
about production code.

The dependency worth naming is that this property bounds what
`dead-peer-charges-are-reclaimed-or-declared` can achieve: as long as the shipped
cleanup returns `Uncertain` unconditionally, no reclamation path exists for a
dead peer's charges regardless of how the surrounding controller behaves.

## What a test must construct

A reachability assertion, and it is expected to fail or to be recorded as
scoped:

1. Assert that some production path reaches
   `provider_recovery.rs:483-490`. With `ShmRecoveryBackend` as the only
   production backend, no construction achieves this.
2. Failing that, the property is discharged by scoping the documentation:
   assert that `docs:89` names the backends for which clean reclamation is
   reachable, and assert that the ring backend is excluded. That converts an
   unreachable branch from a silent gap into a stated limitation.
3. Independently, a case asserting that `resolve_readiness` cannot reach
   provider-wide `Quarantined` via a failed probe on the shipped backend, so the
   two triggers at `docs:90` are not presented as equally live.

Both 2 and 3 are assertions about documentation scope rather than about
behaviour, which is the correct shape when the code's stated intent is that the
branch should not be reachable.

## Investigation log

The catalog records no open question for this property. The question resolved
during the trail is logged because it determines whether this is a defect or a
scoping gap.

### Q: Is the unconditional `Uncertain` return a gap in the shipped backend, or the intended behaviour of a thread-confined ring endpoint?

- Sources examined: `crates/mc-host/src/shm_provider.rs:121-152`, including the
  struct doc comment and the `probe` rationale comment;
  `crates/mc-host/src/provider_recovery.rs:96-103` (`CleanupOutcome`),
  `:478-496` (the outcome match), `:508-545` (`after_record_resolved` and
  `resolve_readiness`); repository-wide search for `impl RecoveryBackend` and
  `CleanupOutcome::Reclaimed`; `provider_recovery.rs:889-901`;
  `docs/mc-host-shm-transport.md:85-90`.
- Findings: the intent is recorded in code, not merely inferable. The struct doc
  comment states that cleanup isolates instead of reclaiming because the rings
  die with their endpoint thread, and the `probe` comment states that isolation
  alone proves the provider side clean. So `Uncertain` is a deliberate
  consequence of the ring backend's confinement model, not an unfinished
  implementation.
- Missing evidence: none for the reachability question. What the tree does not
  record is whether `docs:89` is meant to describe the ring backend at all, or a
  future backend whose resources outlive their thread. The section header
  "Clean reclamation versus quarantine exhaustion" presents both as live for the
  provider it documents.
- Conclusion: resolved with answer. Clean reclamation is unreachable on
  production code and is unreachable by design, per the rationale recorded at
  `shm_provider.rs:128-130`. The residual defect is one of documentation scope:
  `docs:87` calls the two outcomes "distinct test experiments" without noting
  that only one has a production experiment. A second instance of the same shape
  was found independently — of the two `Quarantined` triggers at `docs:90`, only
  admission-cap exhaustion is reachable, because `probe()` is constant.
