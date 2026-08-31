# header-rejection-effect-does-not-depend-on-the-catching-layer

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

`ver` is the one header field both layers check: `wire_header[4] != 2` in the
transport (`crates/mc-shm-transport/src/descriptor.rs:271`) and
`header_len_for_version` in the host (`crates/mc-host/src/wire.rs:301-306`,
`:316`). Tracing what each rejection actually does shows the two paths do not
converge. One sets the ring's shared quarantine byte and leaves the slot claimed;
the other releases the slot and leaves the flag clear. Both end at the same
admission-charge outcome, so the divergence is invisible in the accounting and
visible only to the peer.

## Evidence trail

**Transport-caught.** `try_receive` compare-exchanges the slot `PUBLISHED →
RECEIVER_HELD` (`backend/ring.rs:1081-1090`), snapshots the descriptor (`:1093`),
and calls `validate` (`:1095`). On any `DescriptorError`, including
`WireHeaderMismatch` from either of the two header checks, the arm at `:1097-1100`
calls `self.enter_quarantine()` and returns `RingError::Descriptor`.
`enter_quarantine` writes the `quarantined` byte in the shared lifecycle page.
`consumed` is never advanced — the advance is at `:1116`, past the error — so the
slot stays `RECEIVER_HELD` and every later `try_receive` on that lane fails its
CAS. The host maps this to `ReadClose::Corrupt("shared-memory receive failed")`
(former `shm_provider.rs:558`), a reason shared with every other `RingError`.

**Host-caught.** `decode_header` failure gives
`ReadClose::Corrupt("invalid shared-memory header")` (`ring_transport.rs:503-504`)
and `validate_inbound_header` failure gives one of `"body over interoperability
cap"`, `"invalid pure-header flags"`, or `"role-invalid frame type"`
(`frame_channel.rs:51-66`). Both propagate with `?`, which drops the local
`lease`; `ReceiveLease::Drop` calls `release_once` and discards the result
(`lease.rs:201-207`). The slot therefore moves to `RELEASE_PENDING`, `consumed`
has already advanced at `ring.rs:1116`, and the ring's `quarantined` byte is never
touched.

**Where they rejoin.** The endpoint loop computes `clean = matches!(close,
ReadClose::Cancelled | ReadClose::Overloaded)` (former `shm_provider.rs:498`), so every
`Corrupt` variant is unclean regardless of origin. It sends `Err(close)` on
`inbound` (former `:499`), cancels, and returns `false` (former `:500-502`). The spawning
thread then takes the suspect branch (former `:364-371`,
`recovery.report_suspect(custody)`). The recovery controller calls
`backend.cleanup` (former `provider_recovery.rs:450-458`), which for this provider
returns `CleanupOutcome::Uncertain` for every input (former `shm_provider.rs:138-141`),
and `Uncertain` isolates the record with its exact charges
(former `provider_recovery.rs:493-495`). So the admission outcome is identical for both
origins.

**Where the reason dies.** `connection.rs:362-365` matches `ReadClose::CleanEof`,
`Corrupt(_)`, `Io(_)`, and `Overloaded` together and returns `ReadExit::Peer`.
The `&'static str` is bound to `_`. `ReadClose` itself carries
`#[allow(dead_code)]` (`frame_channel.rs:30-32`), consistent with payloads that
no consumer reads. The four reason strings, plus the clean-EOF case, are one
observation at the connection engine; the corrupt-versus-clean distinction
survives only through the separate boolean at former `shm_provider.rs:498`.

## Failure scenario

A peer publishes a frame whose header carries `wire_header[4] == 3`. The
transport rejects it, sets the shared quarantine byte, and leaves the slot
`RECEIVER_HELD`. The host's endpoint dies, the provider quarantines the charges,
and the host's mappings unmap when the thread exits — but the shared object
survives while any peer mapping references it, which is the premise of
descriptor transfer. The peer's next `try_reserve`, `try_receive`, `release`, or
`probe` therefore returns its `Quarantined` variant, an unambiguous terminal
signal.

Now the same peer publishes a frame whose header carries a `Response` type. The
transport accepts it — type is not one of its two fields. The host rejects it at
`frame_channel.rs:61-66`. The charges quarantine exactly as before, but the ring's
quarantine byte stays clear and the slot is released. The peer receives no
terminal signal at all. It keeps publishing into a ring nobody drains, and its
symptom is eventual `Exhausted` followed by `Deadline` — backpressure codes,
indistinguishable from a slow consumer.

Two closely related malformed headers, one accounting outcome, two entirely
different peer-visible outcomes, and in neither case any record of which field
failed.

## Timing windows and dependencies

No timing window on the rejection itself. There is one on observability: the
peer can read the quarantine byte only while it holds a mapping, and the host's
side of the object goes away when the endpoint thread exits, so the window for
the peer to notice is bounded by its own lifetime rather than the host's.

This record shares a root with
[quarantine-authority-survives-peer-writes](quarantine-authority-survives-peer-writes.md):
the quarantine byte lives in peer-writable shared memory, so the signal the
transport path emits is also the signal a peer can erase. It inherits the
`Uncertain`-only cleanup from
[clean-reclamation-is-reachable](clean-reclamation-is-reachable.md), which is why
both origins land on quarantine rather than reclamation. It is the third leg of
the composition alongside
[wire-header-validation-precedes-every-consumer-action](wire-header-validation-precedes-every-consumer-action.md)
and
[wire-header-field-authority-is-partitioned-and-coupled](wire-header-field-authority-is-partitioned-and-coupled.md).

## What a test must construct

A matched pair over the one field both layers own, plus an observation the
existing test does not make.

Publish a frame with `wire_header[4]` set to a value other than 2 and a frame
with an otherwise-identical header carrying a role-invalid type. For each,
observe from the peer side after the close: the result of the peer's next ring
operation, and the ring's reported quarantine state. Today those differ, and no
test looks. The pre-#131 `crates/mc-host/tests/shm_failure_modes.rs:195`
`corrupt_peer_frame_quarantines_exact_charges_and_returns_ready` already built
the second frame — a `Response` with `len: 0` — and asserted the quarantined
charge tuple and the return to `Ready`; that test is absent from the rewritten
post-#131 file, it never inspected the ring or the peer's
next operation, and it had no counterpart for a transport-caught header.

Separately, to pin the lost reason: assert that the failing field, or at least
the distinction between a clean EOF and a corrupt header, is observable somewhere
outside the endpoint thread. Nothing currently is, so this assertion fails today
and states the gap rather than proving it closed.

## Investigation log

### Q: Do the two origins really diverge, or does the host path also quarantine the ring indirectly?

- Sources examined: `backend/ring.rs:1051-1137` for both exits;
  `lease.rs:184-207`; former `shm_provider.rs:473-505`, former `:546-619`, former `:138-152`,
  former `:364-371`; former `provider_recovery.rs:450-500`; `connection.rs:350-366`.
- Findings: they diverge. `enter_quarantine` is called from exactly one place
  inside `try_receive`, the descriptor-validation arm at `ring.rs:1098`. No host
  code path reaches it — the host never calls a quarantine method on the ring, it
  only stops reading and lets the mapping drop. The admission-side quarantine at
  former `provider_recovery.rs:494` is a different mechanism on a different object: it
  isolates the custody record's charges, not the ring.
- Missing evidence: whether the peer-visible difference is intentional. The
  documented close ordering (pre-#131 `docs/mc-host-shm-transport.md:63`) said
  unknown alias state quarantines storage, which describes the transport path;
  the trimmed post-#131 document keeps only the alias-detachment sentence at
  `:49` and still does not say what a host-side protocol rejection should do to
  the ring.
- Conclusion: the divergence is established by direct read. Whether the
  transport path's ring quarantine is the intended behaviour for all header
  rejections, or an artifact of descriptor validation happening to live below the
  trust boundary, is a design question.
