# quarantine-charge-transition-is-atomic

## Discovery trigger

A fallible-step lens over the accounting transitions: for each function that
moves charges between buckets, ask what state the buckets are in on every error
return. `quarantine()` performs a subtraction, then a fallible addition, with an
early return between them.

## Evidence trail

- `crates/mc-shm-transport/src/profile.rs:492-511` is
  `AdmissionController::quarantine`. The sequence is: acquire the accounting lock
  at `:493-496`; assign `accounting.active = accounting.active.checked_sub(
  charges).ok_or(AdmissionError::AccountingUnavailable)?` at `:497-500`; call
  `accounting.release_spans(charges.spans_per_frame)` at `:501`; build `retained`
  with `pinned_workers: 0` at `:502-505`; assign `accounting.quarantined =
  accounting.quarantined.checked_add(retained).ok_or(
  AdmissionError::ChargeOverflow)?` at `:506-509`. The catalog's line citations
  for both assignments are exact.
- The mutation at `:497-500` writes through the `MutexGuard`, so it is committed
  to the shared `Accounting` before the fallible add at `:506-509` runs. When the
  add fails, `?` returns `Err(ChargeOverflow)` with `active` already reduced and
  `quarantined` never raised.
- `profile.rs:501` also matters and the catalog does not mention it.
  `release_spans` (`profile.rs:353-362`) does
  `saturating_sub(1)` on the per-span count slot and then recomputes
  `active.spans_per_frame` as the maximum over surviving slots. That side effect
  is committed before the failure too.
- `profile.rs:537-541` is `Admission::quarantine(mut self)`. It calls
  `self.controller.quarantine(self.charges)?` at `:538` and sets
  `self.state = AdmissionState::Quarantined` at `:539`. On the error path `:539`
  never runs, so `state` remains `AdmissionState::Active`.
- `profile.rs:550-557` is `impl Drop for Admission`. Because `quarantine` takes
  `self` by value, the failing call drops the `Admission` on return. `Drop` sees
  `state == Active` at `:552` and calls `self.controller.release(self.charges)`
  at `:553`. So a failed quarantine is followed immediately by a release attempt
  for the same charges. **This second-order effect is not in the catalog and it
  changes the failure shape.**
- `profile.rs:482-490` is `release`. It returns silently on a poisoned lock at
  `:483-485` and performs the subtraction inside
  `if let Some(active) = accounting.active.checked_sub(charges)` at `:486-489`
  with no `else`. So the follow-on release either double-subtracts or silently
  no-ops, depending on whether other admissions still hold enough charge.
- `profile.rs:84-93` is `ResourceCharges::checked_sub`. Every one of
  `descriptors`, `arena_bytes`, `leases`, `mappings`, and `pinned_workers` uses
  `checked_sub` with `?`, so a shortfall in any single field makes the whole
  subtraction `None`. `spans_per_frame` is passed through unchanged, with the
  comment "A maximum, not a sum: release paths recompute it from the
  per-admission span counts in `Accounting`."
- `crates/mc-host/src/provider_recovery.rs:183-197` is
  `CandidateCustody::quarantine`. The discard is at `:188`:
  `_retained: admission.quarantine().ok()`. **Correction:** the catalog cites
  `:187`, which is the `*state = CustodyState::Quarantined {` line.
- `provider_recovery.rs:127-134` declares `CustodyState`, and the comment at
  `:130-133` states: "The retained record proves the charges stay
  host-accounted. `None` only when aggregate accounting itself failed; the phase
  is still terminal and storage is never reused." So the code knowingly tolerates
  the accounting failure. It addresses terminality and storage reuse. It does not
  address where the charges went.
- `provider_recovery.rs:377-378` and `:544-546` show the intent the failure
  breaks: both comments say charges "stay visible" when readiness goes
  `Quarantined`, matching `docs/mc-host-shm-transport.md:90` and `:112`.
- Existing check: `crates/mc-shm-transport/tests/contract.rs:330`
  `host_admission_retains_quarantined_commitments` asserts the success path only.

## Failure scenario

1. Accounting reaches a state where `quarantined + retained` overflows in at
   least one field. Because `checked_add` on `ResourceCharges` (`profile.rs:73`)
   sums `descriptors`, `arena_bytes`, `leases`, and `mappings`, any of those near
   `u64::MAX` suffices.
2. A suspect resolves as `Uncertain` or `StaleRetry`, or the deadline fires, so
   the recovery path calls `record.quarantine()` (`provider_recovery.rs:494`,
   `:552`, `:571`, `:381`, or `:390`).
3. `CandidateCustody::quarantine` replaces the state with `Quarantined` at
   `:185` and calls `admission.quarantine()` at `:188`.
4. Inside, `active` is reduced at `profile.rs:497-500` and the span census is
   updated at `:501`. The add at `:506-509` fails and returns
   `Err(ChargeOverflow)`.
5. `.ok()` at `provider_recovery.rs:188` discards it. `_retained` becomes `None`
   and the phase stays `Quarantined`, so the record is terminal.
6. The `Admission` drops with `state == Active`, so `Drop` calls `release` again
   (`profile.rs:553`). If other admissions still hold at least `charges` in every
   field, the subtraction succeeds and `active` is reduced a second time. If not,
   `checked_sub` returns `None` and the release silently no-ops.

Either branch loses the charges from `quarantined` entirely. The double-subtract
branch additionally makes `active` under-report by `charges`, and calls
`release_spans` twice for one admission, which under-counts that span class in
`active_span_counts` and can lower `active.spans_per_frame` below the true
maximum.

## Timing windows and dependencies

No concurrency is required. The whole sequence runs under one `MutexGuard` on
`profile.rs:377`'s `Mutex<Accounting>`, and the failure is arithmetic. The
enabling state is the only hard dependency: `quarantined` must be high enough
that adding `retained` overflows. That state is not reachable through ordinary
admission, because `admit` bounds `active + quarantined` against the frozen
limits at `profile.rs:445-459`, so it needs either a seeded accounting pre-state
(fault class F9 in the fault map) or an injected failure at `:506-509`. This
property is the upstream half of
`charge-release-never-silently-strands`: the failed quarantine is a verified
construction of the charge mismatch that record's open question asks for.

## What a test must construct

Construct an `AdmissionController` whose `quarantined` bucket is already near
`u64::MAX` in one field, admit one candidate, snapshot
`active + quarantined` per field through `AdmissionController::snapshot`
(`profile.rs:471-480`), then call `Admission::quarantine()` and assert it returns
`Err(AdmissionError::ChargeOverflow)`. Then snapshot again and assert the
per-field sum `active + quarantined` is unchanged. Because `quarantined` is
private and `admit` refuses to overshoot the limits, seeding requires either a
test-only constructor for `Accounting` or a limits configuration high enough that
repeated admit-then-quarantine cycles walk `quarantined` up to the boundary. A
second case should hold a second live admission across the failing quarantine so
the `Drop`-driven `release` at `profile.rs:553` succeeds, and assert `active`
was not reduced twice.

## Investigation log

The catalog records no open questions for this property. Two findings surfaced
while verifying it and are recorded here as new questions rather than left
implicit.

### Q: Is the `Drop`-driven second release after a failed `Admission::quarantine` intended?

- Sources examined: `profile.rs:537-541` (`Admission::quarantine` signature and
  body), `:550-557` (`Drop`), `:482-490` (`release`), `:84-93`
  (`ResourceCharges::checked_sub`), `:353-362` (`release_spans`).
- Findings: `quarantine` takes `mut self`, and the `?` at `:538` returns before
  `state` is updated at `:539`, so `Drop` unavoidably runs with
  `state == Active`. There is no `ManuallyDrop`, no `mem::forget`, and no
  compensating branch. The behaviour follows directly from the ownership and the
  early return.
- Missing evidence: no comment or test addresses the error path of
  `Admission::quarantine` at all.
- Conclusion: resolved as a mechanism, unresolved as intent. The second release
  is certain to occur; whether it was considered needs the author.

### Q: Is the `AccountingUnavailable` variant at `profile.rs:500` the right classification for a `checked_sub` shortfall?

- Sources examined: `profile.rs:497-500`, the variant list at `:633-635`, and
  the descriptions at `:653-654` ("host admission accounting unavailable").
- Findings: `:500` maps an arithmetic shortfall in `active` to
  `AccountingUnavailable`, while the structurally similar failure at `:509` maps
  to `ChargeOverflow`. A caller cannot distinguish "the lock was unusable" from
  "the charges did not match" from the error alone.
- Missing evidence: none needed for the property; this is an observability
  point, and the catalog's `charge-release-never-silently-strands` record owns
  the observability angle.
- Conclusion: resolved as an observation. It does not change this property's
  check, and it is recorded so the shared cause is not rediscovered.
