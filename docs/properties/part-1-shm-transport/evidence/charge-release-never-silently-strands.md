# charge-release-never-silently-strands

## Discovery trigger

A silent-failure lens over the accounting code: find every place a fallible
accounting step has no `else`, no error return, and no counter. `release()` has
two such steps in five lines, and its caller marks the admission `Released`
regardless of whether either one did anything. The catalog held this at medium
confidence because the `release()` body had not been read directly. This file
reads it.

## Evidence trail

- `crates/mc-shm-transport/src/profile.rs:482-490` is
  `AdmissionController::release`, verified by direct read. Its whole body is:

  ```rust
  fn release(&self, charges: ResourceCharges) {
      let Ok(mut accounting) = self.accounting.lock() else {
          return;
      };
      if let Some(active) = accounting.active.checked_sub(charges) {
          accounting.active = active;
          accounting.release_spans(charges.spans_per_frame);
      }
  }
  ```

  The signature returns `()`, so neither failure can be reported. The poisoned
  lock returns at `:484` and the arithmetic shortfall falls off the end of the
  `if let` at `:489` with no `else`. This confirms the catalog's reported basis.
- `profile.rs:531-534` is `Admission::release(mut self)`. It calls
  `self.controller.release(self.charges)` at `:532` and unconditionally sets
  `self.state = AdmissionState::Released` at `:533`.
- `profile.rs:550-557` is `impl Drop for Admission`. It calls `release` at `:553`
  and sets `Released` at `:554`, again unconditionally. So `AdmissionState`
  records intent, not outcome. The catalog's citation of `:550-557` is exact.
- `profile.rs:377` declares `accounting: Mutex<Accounting>`, a `std::sync::Mutex`,
  so poisoning is possible in principle.
- `profile.rs:84-93` is `ResourceCharges::checked_sub`. It applies `checked_sub`
  with `?` to `descriptors`, `arena_bytes`, `leases`, `mappings`, and
  `pinned_workers`, so a shortfall in any single field makes the whole call
  `None` and the release a complete no-op, not a partial one.
- `profile.rs:353-362` is `release_spans`. It only runs inside the successful
  branch, so a silent no-op also leaves `active_span_counts` and
  `active.spans_per_frame` stale, holding the span charge high.
- `crates/mc-host/src/provider_recovery.rs:167-179` is
  `CandidateCustody::release`. It wins the phase transition with `mem::replace`
  at `:169`, calls `admission.release()` at `:171`, and returns `true` at `:172`.
  The `true` means "this call won the terminal transition", not "the charges came
  back". A silent no-op inside `release` is invisible here.
- `crates/mc-host/src/shm_provider.rs:365` discards even that boolean:
  `let _ = custody.release();`.
- `provider_recovery.rs:487` is the other production caller,
  `if record.release() { state.incarnation += 1; }`. A silent no-op therefore
  still mints a new provider incarnation, so the accounting divergence is
  fenced in as legitimate.
- Existing check: none for either failure. `provider_recovery.rs:811`
  `custody_releases_exactly_once_and_rejects_stale_releases` asserts
  `rig.active() == ResourceCharges::ZERO` after a release at `:818`, which is the
  right oracle shape, but it never perturbs the lock or the arithmetic.

## Failure scenario

The verified route to a charge mismatch runs through a failed quarantine.

1. Accounting is in a state where `quarantined + retained` overflows in some
   field.
2. A recovery episode calls `record.quarantine()`
   (`provider_recovery.rs:494`, `:552`, or `:571`).
3. `AdmissionController::quarantine` reduces `active` at `profile.rs:497-500`,
   updates the span census at `:501`, then fails the add at `:506-509` and
   returns `Err`.
4. `provider_recovery.rs:188` discards the error with `.ok()`. The custody phase
   is already `Quarantined`, so the record is terminal.
5. Because `profile.rs:539` never ran, the `Admission` drops with
   `state == Active`, and `Drop` calls `release` at `:553` for charges that were
   already subtracted.
6. If other live admissions still hold at least `charges` in every field,
   `checked_sub` succeeds and `active` is reduced a second time. `active` now
   under-reports by `charges` permanently, and `release_spans` has run twice for
   one admission. Admission subsequently accepts candidates the host cannot
   afford.
7. If they do not, `checked_sub` returns `None`, the release silently no-ops, and
   `active` is merely correct-by-accident while `quarantined` never received the
   charges at all.

The poisoning route is separate. A panic while the accounting guard is held
poisons the mutex, after which every later `release` returns at `:484` and every
`Admission::drop` still records `Released`. `active` then only ever grows, and
`snapshot()` (`profile.rs:471-480`) starts returning
`Err(AdmissionError::AccountingUnavailable)` at `:475`, so the operator loses the
counters at the same moment they stop being maintained.

## Timing windows and dependencies

Neither route needs a race. The arithmetic route needs the accounting pre-state
that `quarantine-charge-transition-is-atomic` describes, which is why these two
records are coupled: the quarantine defect is the enabling fault for this one.
The poisoning route needs a panic inside a critical section on
`profile.rs:377`'s mutex. That window is narrow by inspection: the guard is held
only inside `admit` (`:416-467`), `snapshot` (`:472-479`), `release`
(`:483-489`), and `quarantine` (`:493-509`); all arithmetic in those bodies is
`checked_*`, `release_spans` uses `saturating_sub`, and the one index into
`active_span_counts` is bounds-filtered by `span_slot`
(`profile.rs`, `.filter(|slot| *slot < MAX_SPANS)`). Note that custody's own lock
behaves differently: `provider_recovery.rs:158`, `:168`, and `:184` all use
`.expect("custody lock")`, so a poisoned custody lock panics rather than
silently degrading.

## What a test must construct

Two separate cases, both needing access to `AdmissionController` internals that
are private today.

For the arithmetic case, do not try to invent a mismatch directly. Drive the
verified sequence: seed `quarantined` near `u64::MAX` in one field, hold two live
admissions, call `Admission::quarantine()` on one and let it fail, then assert
`snapshot().active` still equals the charges of the one remaining admission. That
assertion fails today because of the second subtraction at `profile.rs:553`.

For the poisoning case, wrap a call that holds the guard in
`std::panic::catch_unwind` and force a panic inside the critical section. Since
no such panic is reachable through the current bodies, this needs a test-only
hook, for example a closure invoked while the guard is held, or a
`ResourceCharges` field whose `Debug`/`Drop` panics. Then assert that dropping
every `Admission` leaves `snapshot()` reporting an error rather than reporting
`active == ZERO`, and assert some diagnostic fires. There is no counter to assert
against today, which is the finding.

## Investigation log

### Q: Under what conditions can `checked_sub` actually fail here?

- Sources examined: `profile.rs:482-490` (`release`), `:84-93`
  (`ResourceCharges::checked_sub`), `:441-467` (`admit`, which bounds
  `active + quarantined` against the frozen limits at `:445-459`), `:492-511`
  (`quarantine`), `:531-541` (`Admission::release` and `Admission::quarantine`),
  `:550-557` (`Drop`), `provider_recovery.rs:167-197` (custody transitions),
  `:487` and `:494` (the episode's release and quarantine calls), and
  `shm_provider.rs:365`.
- Findings: one reachable construction exists, and it is not the double-release
  the catalog hypothesised. `Admission::quarantine` returning `Err` leaves
  `state == Active` (`profile.rs:539` unreached), so `Drop` at `:553` issues a
  second `release` for charges `quarantine` already subtracted at `:497-500`.
  That is a genuine charge mismatch reaching `checked_sub`. Ordinary
  double-release through the custody record is not reachable: `mem::replace` at
  `provider_recovery.rs:169` makes the phase transition exactly-once, so
  `admission.release()` at `:171` runs at most once per record, and
  `Admission::release` consumes `self`.
- Missing evidence: whether the seeding state itself is reachable in a real
  deployment. `admit` bounds committed charges against the frozen per-profile
  limits, so reaching `u64::MAX` in `quarantined` requires limits set absurdly
  high plus a long run of quarantine events, or direct injection.
- Conclusion: resolved for the mechanism. The arithmetic is reachable, through a
  failed `Admission::quarantine` followed by `Admission::drop`. The catalog's
  parenthetical "no path constructing one has been identified" should be updated,
  and the check semantics can stay `always` rather than moving to
  `always-or-unreached`. Whether the enabling accounting state is reachable
  without injection is still open and needs the intended limit ranges.
