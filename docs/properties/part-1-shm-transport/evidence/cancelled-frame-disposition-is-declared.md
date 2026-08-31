# cancelled-frame-disposition-is-declared

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

Commit `3bf6c22b` changed endpoint cancellation during the ingress-budget wait
from a corrupt close to a clean one, with the stated reason that under
single-candidate limits quarantining there "permanently blocked every later
shared-memory candidate". That fixed the charge question. Reading the same path
for what happens to the frame already in hand showed the lease is still live at
that point, and its `Drop` returns the slot without the body ever reaching the
inbound channel.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:825-828` — the commit point for
  acquisition. Inside one `unsafe` block, `try_receive` stores
  `SLOT_RECEIVER_LEASED` (`:826`), stores `consumed = sequence` with `Release`
  (`:827`), and increments `active_leases` (`:828`). All three happen before the
  lease value is constructed at `:835-847` and returned.
- `crates/mc-shm-transport/src/lease.rs:215-221` — `impl Drop for ReceiveLease`
  calls `release_once()` if `!self.released`, discarding the result with
  `let _ =`. Dropping a lease is a full release, not an abandonment.
- `crates/mc-shm-transport/src/backend/ring.rs:903-910` — `release` stores the
  `completion_sequence` and decrements `active_leases`, which makes the slot
  eligible for `reclaim_completed`. Nothing records that the body was never read.
- `crates/mc-host/src/ring_transport.rs:464-470` — `receive_one` binds the lease.
  From here the lease is a local whose scope ends at every `return`.
- `crates/mc-host/src/ring_transport.rs:487-518` — the ingress-charge loop, entered
  with the lease still live. `:583-584` returns `Err(ReadClose::Cancelled)` when
  `read_cancel.is_cancelled()`; `:588-590` returns `Err(ReadClose::Overloaded)`
  on the frame deadline. Both drop the lease.
- `crates/mc-host/src/ring_transport.rs:519-524` — the only path that reads the
  body: `lease.to_vec()` then an explicit `lease.release()`. Reaching it requires
  the charge loop to have broken with a charge.
- former `crates/mc-host/src/shm_provider.rs:498` — `let clean = matches!(close,
  ReadClose::Cancelled | ReadClose::Overloaded);` classifies exactly these two
  as clean.
- former `crates/mc-host/src/shm_provider.rs:499-502` — the close is reported as
  `inbound.send(Err(close))`, then `queue.retired.cancel()` and `root.cancel()`.
  The consumer learns the generation retired; it learns nothing about a specific
  lost sequence.
- former `crates/mc-host/src/shm_provider.rs:364-365` — `clean` reaches
  `custody.release()`, so the charges return and the channel's close is recorded
  as ordinary retirement.
- `docs/mc-host-shm-transport.md:96-104` — the documented failure and close
  contract covers generation retirement and charge classification. It does not
  state a disposition for an acquired-but-undelivered frame.

## Failure scenario

A frame is published, `try_receive` succeeds, `consumed` advances past its
sequence, and the ingress budget is momentarily saturated. Cancellation arrives
inside the wait. `receive_one` returns `Err(ReadClose::Cancelled)`, the lease
drops, the slot releases and is later reclaimed, and the body is discarded. The
sequence is permanently consumed: `consumed` never moves backwards and there is
no replay path, so no later receiver can obtain it. The close classifies clean,
the charges return, and readiness stays healthy. From the outside this is
indistinguishable from a cancellation that arrived before the frame existed.

## Timing windows and dependencies

The window opens at `ring.rs:827` when `consumed` advances and closes at
`ring_transport.rs:520` when `to_vec` runs. Its width is the duration of the
ingress-charge loop, which is bounded above by `frame_deadline` but is not
bounded below and is zero-width on an uncontended budget. That is why the window
needs deterministic injection rather than load. `Overloaded` widens it to the
full `frame_deadline` by construction. Depends on
`release-exactly-once-per-sequence` for the drop-release itself being sound; it
is not in tension with it — the release is correct, the frame accounting is what
is missing.

## What a test must construct

A frame acquired by a successful `try_receive`, then cancellation or budget
exhaustion delivered before the ingress charge is granted. Doing this reliably
needs a failpoint at the top of the charge loop, because on an idle budget
`try_charge` succeeds on the first iteration. The oracle is per-sequence effect
accounting, not aggregate charge conservation: for the acquired sequence, assert
either exactly one delivery to `inbound`, or one explicit loss report that names
it. A coverage check `shm_cancel_after_frame_acquired` should witness the
precondition, since both events are legal individually.

## Investigation log

### Q: Is losing one acquired-but-undelivered frame on cancel or overload an accepted contract term?

- Sources examined: `git log -1 --format=%B 3bf6c22b`, which states the
  cancellation change in terms of admission charges only;
  `docs/mc-host-shm-transport.md:96-112` for the documented failure, fallback,
  and close contract; former `crates/mc-host/src/shm_provider.rs:475-503` for the
  classification; the three failure-hardening and release-gate plans listed in
  `../README.md` for a lossless-until-close requirement.
- Findings: the commit reasoning is entirely about charges. The document
  describes generation retirement without replay for a daemon restart, but says
  nothing about a frame already acquired from the ring when a local cancellation
  lands. `inbound.send(Err(close))` does deliver an error to the consumer, so
  the loss is not wholly invisible at the channel level; it is unattributable at
  the frame level.
- Missing evidence: any requirement text stating whether the shared-memory
  channel is lossless up to close. Without it, "the frame may be dropped" and
  "the frame must be delivered or reported" are both consistent with the code.
- Conclusion: needs human input. If the channel is meant to be lossless up to
  close, the commit point is wrong — `consumed` advances before delivery. If
  single-frame loss on retirement is in contract, the record reduces to a
  documentation gap and the check becomes an assertion that the loss is reported.
