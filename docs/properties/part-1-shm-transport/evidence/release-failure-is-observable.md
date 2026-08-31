# release-failure-is-observable

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

Two `let _ =` sites on completion paths. `ReceiveLease::Drop` discards whatever
`release_once` returns, and the host's clean-close branch discards whatever
`custody.release()` returns. Both are on paths that only run when everything else
looked fine, which is exactly where a lost signal is least likely to be noticed by
anything else.

## Evidence trail

- `crates/mc-shm-transport/src/lease.rs:215-221` — the drop-path discard:
  ```rust
  impl Drop for ReceiveLease<'_> {
      fn drop(&mut self) {
          if !self.released {
              let _ = self.release_once();
          }
      }
  }
  ```
  `release_once` (`:198-206`, corrected from the catalog's `:198-208`) calls through
  to `Ring::release`, so every error that function can produce — `Quarantined`
  (`ring.rs:851`), `WrongIncarnation` (`:854`), `WrongLane` (`:857`),
  `InvalidSequence` (`:861`, `:869`, `:883`, `:899`), `DuplicateRelease` (`:897`) —
  is silently dropped here.
- former `crates/mc-host/src/shm_provider.rs:363-371` — the clean-close branch:
  `if clean && !quarantine_next_close.swap(false, Ordering::AcqRel) { let _ = custody.release(); } else { recovery.report_suspect(custody); }`. The suspect path
  is the `else`, so on a clean close no recovery record is created regardless of what
  `release()` reported.
- **Correction to the catalog record.** The catalog describes former `:365` as discarding "a
  clean-path charge-release failure" whose reachability "depends on `AdmissionError`".
  Verified against the code, that is the wrong mechanism. `custody` is a
  `CandidateCustody` (former `crates/mc-host/src/provider_recovery.rs:141`) and
  `CandidateCustody::release(&self) -> bool` (former `:167-179`) returns a **`bool`**, not a
  `Result`: `true` when the record was `Active` and the charges were returned,
  `false` when the state was already `Released` or `Quarantined`, in which case the
  previous state is restored and aggregate counters are untouched (former `:174-177`).
  `AdmissionError` does not appear on this path at all — it is produced by
  `quarantine`, not `release` (`crates/mc-shm-transport/src/profile.rs:522`,
  `:568-569`). So the discarded signal is real, but it is "this record was not in a
  releasable state", not an error value.
- `crates/mc-shm-transport/src/profile.rs:562-565` — `Admission::release(mut self)`
  returns `()`. There is no fallible surface between custody and the controller.
- `profile.rs:512-520` — the controller's `release`, and two further silent
  discards beneath the two above: `let Ok(mut accounting) = self.accounting.lock() else { return; }` (`:513-515`) drops the charges on a poisoned mutex, and
  `if let Some(active) = accounting.active.checked_sub(charges)` (`:516`) has no
  `else`, so a charge set larger than `active` leaves the counters unchanged with no
  report. Both are relevant to `charge-release-never-silently-strands` as well.
- **Where release failure *is* observable.** The host's explicit receive-path
  releases propagate: `ring_transport.rs:475-477` and `:522-524` both use
  `lease.release().map_err(|_| ReadClose::Corrupt("shared-memory completion failed"))?`,
  and `ReadClose::Corrupt` is classified unclean at `:498`, which routes to
  `report_suspect`. On the TypeScript surface the addon path also reports: a failed
  `Ring::release` inside `detach_active` becomes
  `error("receive completion failed")` (`packages/mc-shm-native/src/lib.rs:309-313`),
  which throws through `packages/mc-shm-native/index.ts:498-505` into either
  `shm-frame-channel.ts:190-203`, where `close()` reports
  `onClosed("quarantined", error)` and rethrows, or
  `shm-frame-channel.ts:324-333`, where the poll path reports
  `onClosed("protocol_violation", error)`. So the gap is specifically the Rust
  drop path and the host's clean-close bool, not the transport as a whole.

## Failure scenario

The drop path is reachable in the shipped host topology without any injected fault:

1. `receive_one` acquires a lease at `ring_transport.rs:464-466`. The lease is alive
   and the slot is `RECEIVER_LEASED`.
2. The ingress budget is saturated, so control enters the wait loop at `:488-518`.
3. Either `read_cancel.is_cancelled()` is true and the function returns
   `Err(ReadClose::Cancelled)` (`:492-494`), or the frame deadline elapses and it
   returns `Err(ReadClose::Overloaded)` (`:586-591`). In both cases `lease` is still
   in scope and is dropped on the way out.
4. `Drop` calls `release_once`, which calls `Ring::release`. If the ring was
   quarantined in the meantime — by the peer, or by a validation failure on the other
   direction — the call returns `LeaseError::Quarantined`, discarded at
   `lease.rs:218`.
5. `run_endpoint` classifies both `Cancelled` and `Overloaded` as **clean** (former
   `shm_provider.rs:498`), so the thread takes the `custody.release()` branch at
   former `:365`. Both were deleted by `ed487e11`; the surviving host path is the
   unconditional `admission.release()` at
   `crates/mc-host/src/ring_transport.rs:291`.
6. If the custody record was already moved out of `Active` — for example by a suspect
   report on another path — `release()` returns `false` and the charges are not
   returned. That `false` is discarded.
7. Consequence: an unreclaimed frame whose slot stays `RELEASE_PENDING`-less and
   whose arena bytes head-of-line block reclamation at `ring.rs:1119-1121`, plus
   possibly a stranded charge, with no counter, no diagnostic, and no suspect record.
   The operator's only signal is that shared-memory capacity gradually stops being
   offered.

## Timing windows and dependencies

The drop-path window is the interval between `try_receive` returning a lease and the
explicit `lease.release()` at `ring_transport.rs:522-524`. In the shipped host that
interval contains the whole ingress-budget wait loop (`:488-518`), so it is not
narrow — it is as long as ingress is saturated, bounded by `frame_deadline`. The
custody-bool window is a single call at close. Configuration dependencies: none for
the drop path itself, but the *reachability* of step 2 depends on ingress budget
sizing and `frame_deadline`; and `HostConfig.liveness = None` by default
(`crates/mc-host/src/config.rs:282`, `:296`) keeps the endpoint polling rather than
failing, which lengthens the window in practice. No platform gating. This record is
the reason the other three charge-conservation properties would go unnoticed:
`quarantine-charge-transition-is-atomic`, `charge-release-never-silently-strands`,
and `custody-terminal-transition-exactly-once` all lose their evidence through these
same discards. It also overlaps `cancelled-frame-disposition-is-declared`, which owns
the *frame* loss in the same window; this record owns the *silence*.

## What a test must construct

A release that fails while the surrounding operation is otherwise clean. Two arms.
Arm 1, drop path: acquire a lease, quarantine the ring from the other side, then drop
the lease without releasing it, and assert that some counter, diagnostic, or suspect
record fires. This needs no failpoint — `Ring::enter_quarantine` is public
(`ring.rs:1035-1040`) — but it does need a second party, so a same-process two-`Ring`
arrangement or the existing two-process harness. Arm 2, custody bool: drive a clean
close on a candidate whose custody record has already been moved out of `Active`, and
assert the `false` return is surfaced rather than dropped. The oracle must be an
observation of a reporting surface, not of the ring state, because the property is
about observability. Fault class F3 is not strictly required for arm 1, which makes
this the cheapest of the group to make non-vacuous.

## Investigation log

### Q: Is silent loss on the drop path intended, given the addon `mem::forget`s leases and releases through its own table instead?

- Sources examined: `crates/mc-shm-transport/src/lease.rs:173-221`;
  `packages/mc-shm-native/src/lib.rs:296-316` (`detach_active`) and `:954-1011`
  (`poll`, with `std::mem::forget(lease)` at `:999`);
  `packages/mc-shm-native/index.ts:498-511`;
  `packages/plugin/src/shared/mc-host-client/shm-frame-channel.ts:184-205` and
  `:295-343`; former `crates/mc-host/src/shm_provider.rs:363-371`, former `:546-619`;
  former `crates/mc-host/src/provider_recovery.rs:137-179`;
  `crates/mc-shm-transport/src/profile.rs:512-520`, `:559-572`.
- Findings: the addon genuinely does not use the drop path — `poll` forgets the
  lease at `lib.rs:878` and completes through its own `active` table at `:303-307`,
  and that route *does* report failure all the way to `onClosed`. The host's
  explicit releases also report. So every deliberate completion path in the
  repository observes failure, and `Drop` is the fallback for paths that exit
  without completing. That makes the discard look like a considered choice — a
  destructor cannot return a `Result` — rather than an oversight. What it does not
  explain is why there is no counter or diagnostic at the discard site, which is a
  separate decision from not returning the error.
- Missing evidence: no comment at `lease.rs:215-221` states the reasoning; the doc
  comment on `release` at `:172` mentions reporting stale or duplicate release but
  says nothing about the drop case. `docs/mc-host-shm-transport.md` does not cover
  drop-time completion. No plan requirement was found that names it.
- Conclusion: partially resolved. The mechanism is fully traced and the catalog's
  `AdmissionError` premise is corrected — there is no fallible admission surface on
  the clean-close path, so the record's `medium` confidence rested on a
  misidentified mechanism and the actual discarded signal is a `bool` plus two
  silent returns inside the controller. Whether the *silence* is intended still
  needs human input, because the fix shape differs: returning the error is
  impossible in `Drop`, but emitting a counter is not, and choosing between them is
  a design decision rather than something the code reveals.

## Refresh outcome, 2026-08-30

`Reaches production:` moved from `yes` to `no`; `Status:` stays `active`. This
record had two discard sites and the refactor removed one of them.

The transport-side site is unchanged and verified at `e447c927`:
`ReceiveLease::Drop` calls `release_once()` and discards the result
(`crates/mc-shm-transport/src/lease.rs:215-221`).

The host-side site is gone. `let _ = custody.release()` at the former
`crates/mc-host/src/shm_provider.rs:365` is now `admission.release()` at
`crates/mc-host/src/ring_transport.rs:291`, and `Admission::release`
(`crates/mc-shm-transport/src/profile.rs:562`) takes `self` and returns `()`.
There is therefore no host-side result to discard and no clean-path host release
failure to observe. The silent-no-op risk inside `AdmissionController::release`
did not disappear; it is now wholly owned by
`charge-release-never-silently-strands`, which cites the transport crate directly.
The `recovery.report_suspect(custody)` branch named as the existing check was
deleted with `provider_recovery.rs`, so the record's existing check is now none.

Reachability moved to `no` because the surviving discard is on the transport-side
lease drop path, and no shipped configuration selects the shared-memory transport.
