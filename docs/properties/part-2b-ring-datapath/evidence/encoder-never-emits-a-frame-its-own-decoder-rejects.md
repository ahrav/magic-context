# encoder-never-emits-a-frame-its-own-decoder-rejects

Carried into this sub-part from the superseded `part-2b-wire-and-channels`,
where it was record 6 of `_lenses/lens-a-wire-format.md` (`L430-482`). Two
substantive corrections were made at carry time and both are recorded here: one
of the three encoders the lens treated as production is `#[cfg(test)]`, and the
lens's one open reachability question is resolved. The gap itself is unchanged.

## Discovery trigger

`decode_header` enforces eleven rules. The encoders enforce one. That asymmetry
is visible by reading the two sides next to each other, and it means the host can
construct and emit a frame it would itself refuse to accept.

## Evidence trail

**The encoders, and the correction to their count.** There are three functions
that produce header bytes, not two and not three production ones:

| Function | Line | Gate | Production? |
| --- | --- | --- | --- |
| `encode_frame` | `:542-569` | `body.len() > MAX_BODY_LEN` at `:548` | **No — `#[cfg(test)]` at `:541`** |
| `encode_owned_frame` | `:571-602` | `body.len() > MAX_BODY_LEN` at `:577` | Yes |
| `encode_split_frame` | `:608-633` | `body_len > MAX_BODY_LEN` at `:618` | Yes |

**Correction 1.** The lens wrote "All three encoders were read end to end: the
only rejection is the body-length cap at `[wire.rs:548]`, `[:577]`, `[:618]`" and
its guarantee spoke of "the production encoders", counting three. `encode_frame`
carries `#[cfg(test)]` at `:541`, and a repository-wide grep for `encode_frame(`
excluding the other two names and the declaration returns exactly two call sites:
`crates/mc-host/src/frame_channel/contract_tests.rs:93` and `:163`. So the
guarantee is over two production encoders. The finding is unaffected — the cap at
`:577` and `:618` is still the only rejection either performs — but the count and
the `:548` citation were wrong and are repaired.

`encode_split_frame` delegates bodies below `SPLIT_WRITE_MIN_BODY` (16 KiB,
`:606`) to `encode_owned_frame` at `:615`, before its own cap at `:618`, so the
two production encoders share one gate for small bodies.

**The four holes, each re-verified at carry time.**

1. **Reserved flag bits.** `Flags` is `pub struct Flags(pub u8)` at `:142`, so
   `Flags(0b1100_0000)` is constructible anywhere the type is visible. Neither
   production encoder inspects the flags byte. `decode_header` rejects it at
   `:323` with `ReservedFlagBits`.
2. **Reserved priority encoding.** `Flags(0b0000_0110)` puts `0b11` in the
   priority field. `Priority::from_bits` (`:101-108`) returns `None` for it and
   `decode_header` rejects at `:326` with `ReservedPriorityBits`. Neither encoder
   calls `priority()`.
3. **Pure-header type with a body.** `FrameType::is_pure_header` (`:86-88`)
   returns true for `Cancel`, `Ping`, `Pong` and `Goodbye`.
   `encode_owned_frame(FrameType::Ping, flags, id, body)` with a nonempty body
   writes `len = body.len()` at `:583` and `:585` and never consults
   `is_pure_header`; the only test in the function is `:577`'s cap.
   `decode_header` rejects at `:340` with `PureHeaderFrameWithBody`.
4. **Routed identity with epoch 0.** `FrameId::routed` (`:525-531`) copies
   `route.channel` to `:527` and `route.epoch` to `:528` with no pairing check.
   `decode_header` rejects `channel != 0 && epoch == 0` at `:352` with
   `ZeroEpochOnRoutedChannel`.

All four are reachable from outside the crate: `pub mod wire` at `lib.rs:39`
exposes both encoders, `Flags` and `FrameId::routed`, and `pub mod handler` at
`lib.rs:17` exposes `RouteHandle` with both fields `pub` (`handler.rs:36-40`).

**Why the in-tree host paths are safe today, by construction rather than
enforcement.** `Flags::new` (`:146-156`) builds from `bool`, `Priority` and
`bool`, so it cannot produce holes 1 or 2. Both host flag helpers go through it:
`response_flags` (`:636-638`) and `pure_header_flags` (`:642-644`). Nothing
forbids a caller from using the tuple constructor instead.

**Correction 2: the lens's open reachability question is resolved.** The lens
asked "Can `RouteHandle` ever hold a nonzero channel with epoch 0? Route
allocation was not read in this lens" and set `Confidence:` to "high on the gap,
medium on reachability" because of it. Route allocation was read at carry time.
`RouteRegistry::reserve` is `routing.rs:113-156`:

- `:120-121` — the scan starts from `inner.cursor`, initialized to 1 at `:102`.
- `:122` — `loop {`.
- `:123` — `if candidate != 0`, so channel 0 is never allocated.
- `:124-127` — a fresh slot is inserted with `last_epoch: 0` at `:125`.
- `:128` — `if slot.occupant.is_none() && slot.last_epoch < u32::MAX`.
- `:129-130` — `let epoch = slot.last_epoch + 1; slot.last_epoch = epoch;`.
- `:145-148` — `return Some(RouteHandle { channel: candidate, epoch })`.

So the least epoch the registry can mint is 1, and it can never mint channel 0.
That is pinned by an existing in-crate test,
`reserved_channels_are_nonzero_distinct_and_start_at_epoch_one`
(`routing.rs:512`), which asserts `first.channel != 0` at `:522`,
`second.channel != 0` at `:523`, `first.epoch == 1` at `:525` and
`second.epoch == 1` at `:526`. The `force_last_epoch` helper (`:458-468`) can
fast-forward a channel's epoch but only upward, and it is doubly unavailable to
production: it is private, and it sits inside a `#[cfg(test)] impl RouteRegistry`
block opened at `:454-455`.

Conclusion: **hole 4 is not reachable through the route allocator.** It is
reachable only through a hand-constructed `RouteHandle`, which the public fields
permit. No in-tree site builds epoch 0, but hand-building a handle the allocator
would never mint is established practice: `routing.rs:715-718` builds a
stale-epoch handle and `:750-753` builds `epoch: handle.epoch + 1`, both to drive
registry rejection paths.
That narrows the hole without closing it, and it is why `Confidence:` is now
plain `high` with the narrowing stated at the record rather than `medium on
reachability`.

**No existing check.** No test in the tree feeds encoder output back through
`decode_header` plus `validate_inbound_header`. The two round-trips that come
closest, `round_trip_request` (`:680-690`) and `round_trip_all_frame_types`
(`:693-700`), both construct `EnvelopeHeader` directly rather than through an
encoder, and both build their fixture with `hdr` (`:650-652`), which derives the
epoch as `u32::from(channel != 0)` — a legal pairing by construction. So they
cannot reach the illegal region even in principle.

`tests/protocol_vectors.rs:143`
`committed_header_vectors_decode_to_their_documented_fields` asserts the
document's committed byte vectors against `raw_client::decode_header`
(`tests/support/raw_client.rs:286`), an independent oracle that reads each field
from its documented offset. That is the decode direction over fixed inputs, not
encoder refusal.

**Citation repaired.** The lens cited
`docs/mc-host-wire-protocol.md:293` for the peer's obligation. That line is blank
at `HEAD`. At `1c193ae0` it read "Clean EOF before any byte of the next header is
orderly connection close. EOF after the first header byte, truncated header/body,
unsupported version, unknown type, ...". The document went from 1,031 lines
(blob `ef17f0fa` at both `1c193ae0` and `793a973e`) to 936 (blob `bd54a864` at
`e447c927`) and that sentence was rewritten. Both its clauses now sit in `:296`:
"Clean `Goodbye` followed by joined teardown is orderly connection close.
Unexpected setup-socket EOF, an invalid ring descriptor, truncated declared
frame, unsupported version, unknown type, invalid flags, nonzero channel-0 epoch,
zero epoch on a routed channel, pure-header body, or body declaration above
64 MiB retires the connection without resynchronization or reuse of uncertain
storage." That sentence names three of this record's four holes explicitly.

**Reachability.** The two production encoders are called from
`dispatch.rs:292`, `:329` (`encode_split_frame`), `dispatch.rs:723`, `:802`,
`:1458`, `connection.rs:779`, `:866`, `client.rs:1329`, `:2092`
(`encode_owned_frame`). None is `cfg`-gated. `wire.rs`'s only `#[cfg]`
attributes are `:541` and `:646`.

## Failure scenario

The host emits a frame the peer must refuse. Take hole 3, which needs no hostile
caller at all, only a mistake: a new control path calls
`encode_owned_frame(FrameType::Ping, pure_header_flags(), id, payload)` with a
payload, perhaps to piggyback a diagnostic. The frame is emitted. The peer's
decoder hits `len != 0` on a pure-header type and, per
`docs/mc-host-wire-protocol.md:296`, retires the connection without
resynchronization and without an error frame.

What makes this expensive is the attribution, not the drop. The peer cannot send
an error, because the protocol forbids it for structural corruption. The host
sees a peer that closed. This sub-part's own
`ring-a-publish-failure-is-reported-as-a-clean-peer-close` establishes that the
host's read path collapses such a close into a clean-peer-close disposition. So a
host bug on the emit side surfaces as an unattributable connection drop, on the
peer's side of the wire, with the offending bytes already discarded.

Hole 4 has a sharper version. A `RouteHandle` with a nonzero channel and epoch 0
cannot come from the allocator, so if one appears it came from code that
constructed it by hand — a test helper promoted to production, a deserialization
path, a repair routine. `FrameId::routed` copies it unexamined and the emitted
frame is refused. The routing registry on the host side would meanwhile treat the
same handle as unmatched, so the two sides fail differently for the same value.

Holes 1 and 2 are the forward-compatibility mirror of the third carried record:
the host would be emitting into the reserved region that record's decoder
refuses, which means a conforming future peer must close on us.

## Timing windows and dependencies

None. This is a static contract gap. Both encoders are pure functions over owned
arguments.

Three dependencies are worth naming:

- On [reserved-encodings-and-identity-pairings-reject-at-decode](reserved-encodings-and-identity-pairings-reject-at-decode.md).
  That record establishes that the decoder refuses holes 1, 2 and 4. This record
  is its encode-side mirror. If the decoder ever masked instead of rejecting,
  this record's holes would stop being observable, which is a bad reason for them
  to close.
- On [accepted-header-decode-is-a-bijection-on-twenty-one-bytes](accepted-header-decode-is-a-bijection-on-twenty-one-bytes.md)
  for the round-trip machinery the check needs.
- On `validate_inbound_header` (`frame_channel.rs:58`), which is the second half
  of "passes inbound validation" in the guarantee. That function is Part 2b's and
  applies the caps, the pure-header triple and the role subset that
  `decode_header` does not. The check below should call both, in the order
  `ring_transport.rs:471-473` calls them.

## What a test must construct

One in-crate property test, plus one structural assertion.

1. **The round-trip refusal oracle.** For arbitrary `(ty, flags, id, body)`,
   assert the disjunction: either `encode_owned_frame` returns `Err`, or
   `decode_header` on its output returns `Ok` and `validate_inbound_header`
   accepts. The generator must reach the illegal region, which means it must
   build `Flags` through the tuple constructor rather than `Flags::new`, and
   `FrameId` through `routed` with a hand-built `RouteHandle` rather than through
   the registry. Both are the point: a generator restricted to the safe
   constructors proves nothing, and that restriction is exactly why the existing
   round-trips cannot reach the holes.
2. **The same for `encode_split_frame`**, with a body at or above
   `SPLIT_WRITE_MIN_BODY` (`:606`) so the delegation at `:615` is not taken and
   the split path's own header build at `:622-631` is exercised.
3. **A structural assertion that the two encoders share one gate set.** Assert
   that the set of `EncodeError` returns in `encode_owned_frame` and
   `encode_split_frame` is exactly the body cap. This is enumeration, and it is
   the assertion that would fail informatively when someone adds validation to
   one encoder and not the other.

The test will fail today. That is the correct outcome and it is why this record is
`Exercised: not yet` rather than `partial`: the property does not hold, and the
check is a specification of the fix rather than a regression guard. Whichever fix
is chosen from the open questions determines whether the test's disjunction is
satisfied by the `Err` branch or by the `Ok` branch.

No fault injection, no fixture host. Placement is in-crate, so no CI job builds
it under `R0`.

## Investigation log

### Q: Can `RouteHandle` ever hold a nonzero channel with epoch 0?

- Sources examined: `routing.rs:113-156` (`RouteRegistry::reserve`), `:96-107`
  (`RouteRegistry::new`, with `cursor: 1` at `:102`), `:31-37` (`Slot`) and
  `:39-56` (`Occupant`), `:454-468` (the `#[cfg(test)]` impl block and
  `force_last_epoch`), `:511-528`
  (`reserved_channels_are_nonzero_distinct_and_start_at_epoch_one`), `:715-718`
  and `:750-753` (test-constructed handles), `handler.rs:36-40` (`RouteHandle`),
  `lib.rs:17` (`pub mod handler`), `wire.rs:525-531` (`FrameId::routed`).
- Findings: the registry cannot mint one. Channel 0 is skipped at `:123`; epoch
  starts from `last_epoch: 0` at `:125` and is minted as `last_epoch + 1` at
  `:129-130`, so it is at least 1; `force_last_epoch` (`:458-468`) only moves the
  history forward, is private, and is inside a `#[cfg(test)]` impl block
  (`:454-455`). An existing test pins both facts at `:522-526`.
  But `RouteHandle`'s two fields are `pub` on a `pub mod`, so any caller inside or
  outside the crate can construct `RouteHandle { channel: 5, epoch: 0 }`. No
  in-tree site does, but synthetic handles carrying values the allocator would not
  mint are already built at `:715-718` (stale epoch) and `:750-753`
  (`handle.epoch + 1`).
- Missing evidence: none for the allocator. Not examined: whether any
  deserialization, persistence, or IPC path reconstructs a `RouteHandle` from
  wire or stored bytes rather than from `reserve`. A grep for `RouteHandle {`
  under `crates/mc-host/src` returns `routing.rs:145`, `:351`, `:367`, `:424`,
  and `handler.rs:36`, all registry-internal, but a type-level survey of every
  crate was not done.
- Conclusion: resolved with answer. The allocator cannot produce an epoch-0
  routed handle, so hole 4 is not reachable on the ordinary bind path. It remains
  reachable through a hand-constructed handle, which the public fields permit.
  This is why `Confidence:` moved from "medium on reachability" to plain `high`
  with the narrowing stated, rather than to a claim that the hole is closed.

### Q: Should the encoders validate, or should the illegal region be made unconstructible by removing the public field from `Flags` and by giving pure-header types a body-free encoder?

- Sources examined: `wire.rs:142` (`Flags(pub u8)`), `:146-156` (`Flags::new`),
  `:86-88` (`is_pure_header`), `:525-531` (`FrameId::routed`), `:571-602` and
  `:608-633` (the two production encoders), `:636-644` (the two host flag
  helpers), `lib.rs:17` and `:39` (both modules public),
  `handler.rs:36-40` (`RouteHandle`'s public fields).
- Findings: both routes are viable and they differ in blast radius. Validation in
  the encoders is local, costs a branch per emission on a path that already
  copies the body, and turns four silent misuses into `EncodeError`. Making the
  region unconstructible is stronger and wider: it means making `Flags`' field
  private (a breaking change to `pub mod wire`), splitting a body-free encoder for
  the four pure-header types, and either making `RouteHandle`'s fields private or
  giving `FrameId::routed` a fallible signature. The third of those interacts with
  the resolution above — the allocator already guarantees the invariant, so
  private fields would make `FrameId::routed` infallible by construction, which is
  the cleanest end state and the largest change.
- Missing evidence: whether `wire` and `handler` are intended as stable public
  API or are public only because the module tree needed them. `pub mod
  ring_transport` next to them carries `#[doc(hidden)]` at `lib.rs:20` and these
  two do not, which is weak evidence that they are intended to be public, but it
  is not decisive and no crate-level API-stability document was found.
- Conclusion: needs human input. The choice turns on the public-API question,
  which is not answerable from the tree.

### Q: Should `encode_frame`'s `#[cfg(test)]` gate be reconsidered?

- Sources examined: `wire.rs:541-569` (`encode_frame` and its gate), the two call
  sites `frame_channel/contract_tests.rs:93` and `:163`, `:571-602`
  (`encode_owned_frame`, the owned-body production analogue).
- Findings: `encode_frame` is the only encoder taking `&[u8]` rather than an owned
  `Vec<u8>`, and it is used only by the contract-test suite. That means the
  semantic contract suite exercises an encoder no production path uses, which is a
  fidelity gap: the suite's frames are built by a function whose body-handling
  differs from the production one. `encode_owned_frame` does exact-size growth
  (`:597-600`) with a comment at `:594-596` explaining that amortized `reserve`
  would double a full-capacity body and break the caller's byte-budget charge.
  `encode_frame` has no such constraint because it allocates fresh. So the two
  differ precisely on the property the byte budget depends on.
- Missing evidence: whether the contract tests would still pass if rewritten
  against `encode_owned_frame`. Not attempted — this catalog does not edit tests
  (METHOD rule 6).
- Conclusion: needs human input. Flagged as a lead rather than a defect: the gate
  is not wrong, but the fidelity gap between the test-only and production
  encoders is worth a decision, and it sits next to the byte-budget accounting
  this sub-part already tracks.
