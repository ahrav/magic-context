# Lens A: wire format and framing contract

Attention focus: the frame header contract in `crates/mc-host/src/wire.rs` and
the byte-budget accounting that module owns. Other failure families are ignored
except where they intersect framing.

Files read at HEAD: `wire.rs` (973 lines), `frame_channel.rs` (882),
`frame_channel/contract_tests.rs` (657), `tcp_frame_channel.rs` (1155, framing
and writer paths), `transport_provider.rs` (489), `composite.rs` (390),
`transport_negotiation.rs` (973, checked for framing surface and found to have
none). Boundary context read but not mined: `shm_provider.rs:550-615`,
`dispatch.rs:270-345`, `connection.rs:1240-1345`, `runtime.rs:712-885`,
`config.rs:18-200`, `client.rs:1945-1975` and `:2210-2240`,
`docs/mc-host-wire-protocol.md` sections 6.1 through 7.1,
`tests/protocol_vectors.rs`, `tests/support/raw_client.rs`,
`tests/handler_contract.rs:430-500`.

Every line reference below was printed from HEAD before being written. No
correction was needed.

Not re-reported here: Part 1's `wire-header-fully-validated-before-any-consumer-acts`
and `ingress-charge-matches-the-bytes-copied-from-shared-storage` (the
shared-memory ordering and the transport-side `len == body_len` check),
Part 1's `every-shm-header-consumer-applies-its-role-gate`, Part 1's
`decoder-totality-over-arbitrary-bytes` (which is about `descriptor.rs`,
`sample.rs`, and `harness.rs` in `mc-shm-transport`, not `wire::decode_header`),
and Part 2a's `close-disposition-is-a-total-function-of-the-read-exit-cause`
and `a-cancelled-emission-releases-every-permit-it-held`.

## Observations

- O1: The header is a fixed 21 bytes for version 2 (`HEADER_LEN`), of which the
  first 5 are the frozen prefix carrying `len` and `ver`
  [wire.rs:28](../../../../crates/mc-host/src/wire.rs), [wire.rs:32].
- O2: `decode_header` contains exactly 11 validation gates, one per
  `DecodeError` variant, and the variant list is exactly 11 long
  [wire.rs:220-243], [wire.rs:307], [:311], [:312], [:321], [:323], [:326],
  [:329-331], [:332-339], [:340], [:345], [:352].
- O3: `validate_inbound_header` adds 3 more gates that `decode_header` does not
  perform: the 64 MiB body cap, the pure-header flag triple, and the consumer
  role set [frame_channel.rs:59], [:62-68], [:69-74]. It is `pub(crate)` and is
  called explicitly by each transport, so it is not part of the decode
  postcondition.
- O4: The TCP reader adds 2 transport-local gates: a `ver != 2` precheck before
  the remaining 16 header bytes are read [tcp_frame_channel.rs:177-179], and the
  channel-0 control-body cap [tcp_frame_channel.rs:198-202]. Total header
  validation gates on the TCP ingress path: 16.
- O5: Because production callers always hand `decode_header` a
  `[u8; HEADER_LEN]` — [tcp_frame_channel.rs:158] and
  [shm_provider.rs:562] via `lease.wire_header()` — the two truncation gates
  ([wire.rs:307], [:312]) are statically dead in production, and the
  `UnsupportedVersion` gate ([wire.rs:311]) is dead on TCP because
  [tcp_frame_channel.rs:177] already rejected it. Part 1 recorded the same
  deadness for the shared-memory path.
- O6: `header_len_for_version` is the declared version-dispatch extension point
  and currently maps only version 2 [wire.rs:292-297]. No production caller
  exercises it as an extension point: the TCP reader reads a fixed 21-byte array
  and hardcodes the remaining-16-byte read [tcp_frame_channel.rs:180-186].
- O7: `Flags` is a public tuple struct with a public field
  [wire.rs:142](../../../../crates/mc-host/src/wire.rs), and the `wire` module is
  `pub` (doc-hidden) [lib.rs:44-45]. `Flags::new` cannot construct reserved bits,
  reserved priority, or a non-Normal admission class [wire.rs:146-156], but
  `Flags(0xFF)` can, and `encode_owned_frame` accepts it [wire.rs:571].
- O8: The encoders check exactly one thing: `body.len() > MAX_BODY_LEN`
  [wire.rs:548], [:577], [:618]. They derive `len` from `body.len()`, so
  `len == body_len` holds structurally on those paths, but nothing checks the
  channel-and-epoch pairing, the pure-header body rule, Sheddable legality,
  reserved bits, or the channel-0 control cap.
- O9: `encode_frame` is `#[cfg(test)]` [wire.rs:541]; the production encoders are
  `encode_owned_frame` [wire.rs:571] and `encode_split_frame` [wire.rs:608].
  `encode_split_frame` returns the header and body as two buffers when the body
  is at least 16 KiB [wire.rs:606], [:614], and the writer emits them as two
  `write_all` calls [tcp_frame_channel.rs:370-373].
- O10: `DirectFrame::new` takes an already-encoded header and a separate
  `body_len` and never compares them [frame_channel.rs:616-626]. `ExactWriter`
  bounds the serializer to `body_len`, not to `header.len`
  [frame_channel.rs:652-693]. The single call site derives both from one value
  [dispatch.rs:321-334].
- O11: `MAX_FRAME_BODY_LEN` [wire.rs:35] and `MAX_BODY_LEN` [wire.rs:371] are two
  public names for the same 64 MiB value. `MAX_FRAME_BODY_LEN` is the one
  re-exported from the crate root [lib.rs:97]. Part 1 recorded a third
  independent 64 MiB constant, `MAX_FRAME_BYTES` in `arena.rs`.
- O12: Three independent byte pools are carved from `max_resident_bytes` at
  startup: ingress, scratch, and egress [runtime.rs:872-880]. Ingress and egress
  do **not** share a pool. `EGRESS_RESERVED_BYTES` is exactly one maximum frame,
  `MAX_BODY_LEN + HEADER_LEN` [config.rs:28].
- O13: Ingress charges the body only, `header.len` [tcp_frame_channel.rs:210] and
  [shm_provider.rs:580]. Egress charges body plus header,
  `body.len() + HEADER_LEN` [dispatch.rs:275-277], [connection.rs:1240-1246],
  [connection.rs:1301]. The 21 header bytes an inbound frame makes resident are
  not charged to any pool.
- O14: The ingress pool capacity is `max_resident_bytes` minus egress, scratch,
  the resident catalog, and every declared retained-byte reservation
  [runtime.rs:872-878]. The subtraction cannot underflow and cannot fall below
  one maximum body, because startup rejects a configuration below
  `MIN_RESIDENT_BYTES + catalog + retained` [runtime.rs:720-728], and
  `MIN_RESIDENT_BYTES` is exactly `MAX_BODY_LEN + egress + scratch`
  [config.rs:23-24].
- O15: The only blocking ingress acquisition is `ByteBudget::charge`
  [wire.rs:412], with exactly one production caller
  [tcp_frame_channel.rs:210], raced against the frame deadline. The
  shared-memory path instead spins on `try_charge` with a sleep
  [shm_provider.rs:579-602]. Both draw on the same cloned ingress pool
  [connection.rs:183], [connection.rs:1011], [transport_provider.rs:318].
- O16: For the identical condition — the ingress budget wait outlasting the
  frame deadline — the TCP path returns `ReadClose::Corrupt("body budget wait
  exceeded frame deadline")` [tcp_frame_channel.rs:211-213] while the
  shared-memory path returns `ReadClose::Overloaded`
  [shm_provider.rs:585-589]. The `Overloaded` variant's own documentation says a
  resource wait outlasting its deadline is clean backpressure and not a
  structural fault [frame_channel.rs:40-43].
- O17: `ByteCharge` releases on drop through its held `OwnedSemaphorePermit`
  [wire.rs:446-452]. On the TCP read path the charge is a plain local
  [tcp_frame_channel.rs:204], so every `?` early return after it
  ([tcp_frame_channel.rs:219]) releases it by ownership. The producer machinery
  makes the same guarantee explicit: `ProducerReservation` holds
  `Option<C>` and drops it on constructor failure, overflow, underfill, abort,
  or ordinary drop [frame_channel.rs:121], [:222-225], and both
  `ProducerReservation` and `ProducedBody` are `#[must_use]`
  [frame_channel.rs:116], [:230]. I found no early-return path on the framing
  or writer paths that leaks a charge.
- O18: `ByteCharge::split` is total and non-destructive on failure
  [wire.rs:469-477]; `shrink_to` is monotonic and cannot inflate a charge
  [wire.rs:489-491]; `split_excess` exists so a caller can defer the release
  until after an unrelated mutex guard falls, because releasing a permit takes
  the budget's waiter lock [wire.rs:493-505].
- O19: `ByteBudget::capacity` exists specifically to separate a permanently
  unsatisfiable request from transient backpressure [wire.rs:402-407], but it has
  no caller on any framing path: its only non-test caller is a metric
  [broca/supervisor.rs:345].
- O20: `InboundFrame::into_owned` flattens a segmented body into a second
  allocation while the first is still live, and moves the single existing charge
  across without acquiring a second one [frame_channel.rs:535-553]. The
  `ByteBudget` documentation says "host-managed copies acquire a second charge"
  [wire.rs:378-379]. `InboundFrame::segmented` is `#[allow(dead_code)]` and has
  no constructor call anywhere [frame_channel.rs:492-506].
- O21: `transport_negotiation.rs` contains no framing surface at all: no
  `decode_header`, no `HEADER_LEN`, no `crate::wire` import. It is a JSON
  grammar module. `composite.rs` likewise references neither `wire` nor any
  budget.
- O22: The committed byte vectors in protocol section 6.4 are pinned only
  through the independent test oracle `raw_client`, which has its own
  `HEADER_LEN`, its own version constant, its own type constants, and its own
  encode and decode written against the documented offsets
  [tests/support/raw_client.rs:19], [:25-36], [:286-296], [:299-311]. It never
  imports `mc_host::wire`. The vector test decodes and re-encodes with the
  oracle on both sides [tests/protocol_vectors.rs:143-176].
- O23: Reachability of the two decode consumers differs.
  `TransportProviders::default()` registers no injected provider
  [config.rs:297], [transport_provider.rs:160-163], and injection is documented
  as the test path [transport_provider.rs:166-180]. So TCP is
  default-production and the shared-memory arm is explicit-config-only.

## Header field map

- F1: `len` — u32, offset 0..4, little-endian. Read at [wire.rs:319]. Gated by
  the pure-header rule at [wire.rs:340] (structural) and by the 64 MiB cap at
  [frame_channel.rs:59] and the 65,536-byte channel-0 cap at
  [tcp_frame_channel.rs:198] (both outside `decode_header`). `decode_header`
  alone accepts any `u32`.
- F2: `ver` — u8, offset 4. Read at [wire.rs:310], dispatched through
  `header_len_for_version` at [wire.rs:311]; TCP pre-rejects at
  [tcp_frame_channel.rs:177]. Structural.
- F3: `type` — u8, offset 5. Gated at [wire.rs:321] against the 12-value
  enumeration [wire.rs:68-84]. Structural. The consumer role subset
  (`Request`, `Cancel`, `Pong`, `Goodbye`) is a second, separate gate at
  [frame_channel.rs:69-74]; the protocol calls that a role violation, and the
  code classifies it `Corrupt`.
- F4: `flags` — u8, offset 6. Bit 0 binary, bits 1-2 priority, bit 3 last, bits
  4-5 admission, bits 6-7 reserved [wire.rs:131-137]. Structural gates:
  reserved bits [wire.rs:323], priority `0b11` [wire.rs:326], admission `0b11`
  [wire.rs:329-331], Sheddable on a type other than `Push` or `StreamData`
  [wire.rs:332-339]. The pure-header flag triple (binary 0, last 0, admission
  Normal) is gated outside `decode_header` at [frame_channel.rs:62-68].
- F5: `channel` — u16, offset 7..9. Read at [wire.rs:343]. Gated jointly with
  `epoch`. Structural.
- F6: `epoch` — u32, offset 9..13. Read at [wire.rs:344]. Two structural gates
  forming a biconditional: channel 0 must carry epoch 0 [wire.rs:345], and a
  nonzero channel must carry a nonzero epoch [wire.rs:352]. The second gate
  carries an explicit rationale comment [wire.rs:348-351].
- F7: `corr` — u64, offset 13..21. Read at [wire.rs:355-357]. **No gate at any
  layer.** Correlation legality is per-frame-type and is enforced, if at all, by
  a semantic consumer above the framing layer.

Structural versus semantic split, as implemented: everything in F2 through F6 is
rejected at decode with the generation closing silently. F1's caps and F4's
pure-header triple and F3's role subset are also generation-closing but live in
`validate_inbound_header`, one call site per transport. F7 is entirely semantic.
`StreamEnd` with a nonzero body is neither: the protocol calls it structurally
illegal, and no framing-layer gate implements it on the host side (the role gate
rejects `StreamEnd` inbound for an unrelated reason).

## Candidate properties

### decode-header-is-total-over-arbitrary-bytes

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `wire.rs:722-742` covers three specific short and
bad-version inputs, and `wire.rs:745-773` covers four bad flag or type bytes.
Missing: any sweep over arbitrary bytes, any exhaustive length sweep from 0 to
21, and any structured mutation of an accepted seed. There is no fuzz target for
this decoder anywhere in the repository (`crates/mc-shm-transport/fuzz` is the
only fuzz directory and targets the transport descriptor decoders).
Guarantee: For every byte slice, `decode_header` returns either an
`EnvelopeHeader` satisfying all eleven gate postconditions or a typed
`DecodeError`; it never panics and never allocates.
Check: `always` — call `decode_header` on arbitrary bytes of arbitrary length;
assert the call returns, and that on `Ok` every one of the eleven gate
conditions holds on the returned value. A panic is a forbidden state with no
dedicated detection point, so this is `always(!panic)`; `unreachable` is wrong
because no code location must never execute.
Fault/timing angle: none. The function is pure over one immutable slice. The
structural exposure is that every index past the first is a constant index
(`bytes[4]`, `bytes[5]`, `bytes[6]`, `bytes[7..9]`, `bytes[9..13]`,
`bytes[13..21]`) whose in-bounds-ness rests entirely on the single
`bytes.len() < need` gate at [wire.rs:312] and on `header_len_for_version`
returning 21 [wire.rs:294]. Narrowing that constant, or adding a version whose
`header_len_for_version` value is smaller than the largest constant index,
converts [wire.rs:355-357] into a panic.
Required faults and enabling state: none. Arbitrary bytes are the entire
enabling state. The property holds at HEAD and is under-evidenced, not violated.
Confidence: high — [evidence](evidence/decode-header-is-total-over-arbitrary-bytes.md).
Every gate and every index was read directly. `EnvelopeHeader` is constructed
once, after all eleven gates, at [wire.rs:359-367], and its fields are public
but the value cannot escape a rejected path. No allocation occurs: the function
returns a `Copy` struct.
Existing check: `wire.rs:722` `reject_truncated_headers_and_unsupported_versions`
and `wire.rs:745` `reject_unknown_frame_type_and_reserved_flag_encodings`, both
table-driven over single hand-picked inputs. Status unaudited.
Impact: today, none observable, because both production callers pass a
fixed-size array (O5). The value is that the reasoning keeping totality true
lives nowhere in the tree, and the moment a caller passes a variable-length
slice — a coalescing reader, a batched shared-memory descriptor, a future
version with a shorter header — the constant indexes become the only thing
between a peer and a panic in the read loop.
Open questions:
- Should `header_len_for_version` be required to return at least the largest
  constant index used by the parse body, so a future version cannot silently
  make the parse out of bounds? (needs human input)

### accepted-header-decode-is-a-bijection-on-twenty-one-bytes

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `wire.rs:703-719` pins all seven field offsets with
distinctive byte values, and `wire.rs:680-690` round-trips one header. Missing:
a per-bit influence oracle, and any assertion that `decode_header` reads nothing
past `HEADER_LEN`.
Guarantee: For every accepted header, `encode` and `decode_header` are mutually
inverse, every one of the 21 bytes influences exactly one decoded field, and no
byte at or beyond offset 21 is consumed.
Check: `always` — for every accepted 21-byte input, `decode_header(bytes)` then
`.encode()` reproduces `bytes` exactly; flipping any single bit inside the 21
bytes either changes the decoded value or causes rejection; and appending
arbitrary trailing bytes changes nothing about the result. `always` rather than
`reachable`: the condition is evaluated on every accepted decode, and the
forbidden state is an accepted header with an inert or aliased byte, which has
no dedicated detection point.
Fault/timing angle: none. The interesting axis is that `encode` writes its seven
fields by hand-written literal ranges [wire.rs:207-213] and `decode_header`
reads them back by independently hand-written literal ranges
[wire.rs:319], [:343], [:344], [:355-357]. Nothing ties the two sets of offsets
together, and a same-width transposition — `channel` against the low half of
`epoch`, or two bytes inside `corr` — is invisible to a round-trip test whose
fixture uses non-distinctive values.
Required faults and enabling state: none. Any accepted input suffices; what is
missing is the oracle.
Confidence: high — [evidence](evidence/accepted-header-decode-is-a-bijection-on-twenty-one-bytes.md).
`encode` covers `0..4`, `4`, `5`, `6`, `7..9`, `9..13`, `13..21` with no gaps and
no overlaps, and the decode side reads the identical seven ranges. The
`little_endian_and_frozen_prefix_layout` test at `wire.rs:703` does use
distinctive ascending values, so it would catch a transposition today; nothing
forbids a future fixture from losing that property, and the test asserts on
`encode` only, never on the decode direction's offsets.
Existing check: `wire.rs:703` `little_endian_and_frozen_prefix_layout` (encode
direction, distinctive values, plus `buf.len() == HEADER_LEN`); `wire.rs:680`
`round_trip_request`; `wire.rs:693` `round_trip_all_frame_types`. Status
unaudited.
Impact: this bijection is what makes the frozen-prefix promise in the module
header [wire.rs:16-18] mean anything, and it is the only reason a peer's
independently written codec can interoperate. A drifted offset that still
satisfies the eleven gates produces a frame both sides accept and interpret
differently.
Open questions:
- Should `encode` and `decode_header` be generated from one offset table so a
  transposition is impossible by construction? (needs human input)

### reserved-encodings-and-identity-pairings-reject-at-decode

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `wire.rs:745-773` covers reserved flag bit 7, reserved
priority, reserved admission, and type byte 99; `wire.rs:836-862` covers
Sheddable on all ten illegal types and both legal ones; `wire.rs:795-833` covers
both halves of the channel-and-epoch pairing. Missing: an exhaustive sweep of
all 256 flag bytes and all 256 type bytes, and any check that a rejected
encoding is never masked, defaulted, or silently normalized.
Guarantee: A header carrying a reserved flag bit, a reserved priority or
admission value, an unassigned type byte, Sheddable on a delivery-required type,
or a mismatched channel-and-epoch pairing is rejected, never accepted with the
offending field cleared or defaulted.
Check: `always` — sweep all 256 values of the flags byte crossed with all 256
values of the type byte and both channel-and-epoch classes; assert every
combination the protocol calls invalid returns the specific `DecodeError`
variant for it, and that no accepted result has reserved bits set or a reserved
enum value. `always` because the obligation is per-frame and the forbidden
state — an accepted header whose reserved region was normalized rather than
refused — has no dedicated detection point.
Fault/timing angle: none. The exposure is that `Flags::priority` and
`Flags::admission_class` return `Option` [wire.rs:169-176] while
`Flags::is_binary` and `Flags::is_last` return `bool` [wire.rs:159-166]. A
future accessor written in the `bool` style over a widened bit field would mask
rather than reject, and the only thing forcing rejection today is that
`decode_header` propagates the `None` at [wire.rs:326] and [wire.rs:329-331].
Required faults and enabling state: a peer-authored header, which is the
baseline trust model. No concurrency, no timing.
Confidence: high — [evidence](evidence/reserved-encodings-and-identity-pairings-reject-at-decode.md).
Every gate read directly. The channel-and-epoch pairing is a true biconditional:
`channel == 0 && epoch != 0` at [wire.rs:345] and `channel != 0 && epoch == 0`
at [wire.rs:352], matching protocol section 6.1's "0 on channel 0; routed epochs
are nonzero".
Existing check: `wire.rs:745`, `wire.rs:836`, `wire.rs:795`, plus the end-to-end
`tests/protocol_vectors.rs:512` `structural_corruption_closes_silently` and
`:656` `pure_header_frames_accept_any_valid_priority`. Status unaudited.
Impact: the reserved regions are the whole forward-compatibility budget. Any
implementation that masks instead of rejecting spends that budget silently: a
version-3 field placed in bits 6-7 would be ignored by a version-2 peer that
should have closed the generation.
Open questions: None.

### pure-header-frame-shape-is-split-across-two-gates

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `wire.rs:777-792` covers the `len != 0` half in
`decode_header`. The flag-triple half at `frame_channel.rs:62-68` has no direct
unit test in Part 2b scope; `tests/protocol_vectors.rs:512` exercises it
end-to-end for one shape.
Guarantee: A `Cancel`, `Ping`, `Pong`, or `Goodbye` frame is accepted only with
`len == 0`, `binary == 0`, `last == 0`, and admission class Normal, and this
holds for every consumer of the header, not only those that call both gates.
Check: `always` — for each of the four pure-header types, cross a nonzero `len`
with each of the three forbidden flag settings and assert rejection; separately
assert that every production consumer of a decoded header reaches both gates.
`always` because a malformed pure-header frame is a forbidden state with no
dedicated detection point, and the shape obligation is evaluated per frame.
Fault/timing angle: none for the gates themselves. The exposure is the split: a
consumer that calls `decode_header` alone accepts a `Ping` with `LAST` set and
Sheddable-adjacent flags, because only `len` is checked at [wire.rs:340]. There
are consumers that call `decode_header` without `validate_inbound_header`:
[shm_provider.rs:654] for a diagnostic path and [client.rs:2221] on the
negotiation read path, which instead applies its own `validate_inbound`.
Required faults and enabling state: a peer emitting a pure-header type with a
forbidden flag bit, reaching a consumer that skips the second gate.
Confidence: high — [evidence](evidence/pure-header-frame-shape-is-split-across-two-gates.md).
The two halves were read at [wire.rs:340] and [frame_channel.rs:62-68]; the
consumer inventory came from a repository-wide search for `decode_header`, which
returned exactly two production call sites inside Part 2b scope
([tcp_frame_channel.rs:188], [shm_provider.rs:562]) plus the diagnostic and
client paths above. Protocol section 6.1 states the triple as a MUST
(`docs/mc-host-wire-protocol.md:245`).
Existing check: `wire.rs:777` `reject_pure_header_frame_with_body_len` (the
`len` half only). Nothing tests the flag half in isolation. Status unaudited.
Impact: the host arm is safe today because both TCP and shared memory call both
gates in order. The property is worth pinning because the two halves of one
protocol sentence live in two crates' worth of distance apart, one of them in a
function each transport must remember to call, which is the same shape Part 1
recorded for the role gate.
Open questions:
- Should the pure-header flag triple move into `decode_header` beside the
  `len == 0` gate, so no consumer can accept a half-validated pure-header
  frame? (needs human input)

### declared-body-cap-is-not-part-of-the-decode-postcondition

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the 64 MiB cap is exercised at the exact boundary end to
end by `tests/handler_contract.rs:437`, and the channel-0 cap by the
oversize-control drain path. Missing: any assertion that a decoded-but-unvalidated
header's `len` is bounded, and any negative test at `MAX_BODY_LEN + 1` through
`decode_header` itself.
Guarantee: Every consumer that acts on a decoded header's `len` — to allocate,
to charge, or to read — first bounds it by `MAX_BODY_LEN`, and by
`MAX_CONTROL_BODY_LEN` when the frame is a channel-0 `Request`.
Check: `always` — for every production call site of `decode_header`, assert on
the path from the decode to the first use of `header.len` that a cap comparison
occurs. Equivalently, assert `decode_header(bytes)?.len <= MAX_BODY_LEN` is
**not** a theorem, and that each consumer establishes it locally. `always`
because the obligation is per-consumer and per-frame; the forbidden state is an
unbounded `len` reaching an allocation.
Fault/timing angle: none required. The window that makes it load-bearing is
between the decode and the allocation: on TCP the order is decode
[tcp_frame_channel.rs:188], cap [frame_channel.rs:59] via
[tcp_frame_channel.rs:196], control cap [:198], charge [:210], then
`Vec::with_capacity(header.len as usize)` [:217]. Moving the
`with_capacity` above the cap turns a 4 GiB declaration into a 4 GiB
allocation attempt.
Required faults and enabling state: a peer-authored header declaring `len`
above 64 MiB, and for the control arm, a channel-0 `Request` above 65,536.
Confidence: high — [evidence](evidence/declared-body-cap-is-not-part-of-the-decode-postcondition.md).
`decode_header` contains no comparison against `MAX_BODY_LEN`; the constant is
defined 3 lines after the function ends [wire.rs:371] and is referenced from
`frame_channel.rs:25` and `:59`. The control cap is applied only when
`ty == Request && channel == 0` [tcp_frame_channel.rs:198],
[shm_provider.rs:565], which is sufficient on ingress only because the role gate
admits no other body-carrying type; that coupling is undocumented at both sites.
Existing check: `tests/handler_contract.rs:437`
`retained_declaration_raises_the_resident_floor_exactly` sends a 64 MiB body at
the exact resident floor. `client.rs:2821-2829` covers the client's own
validator. Nothing covers `MAX_BODY_LEN + 1` through the host framing path.
Status unaudited.
Impact: the cap is the only bound on the first length-driven allocation in the
read loop. It is also the interoperability floor the protocol forbids a
deployment from lowering (`docs/mc-host-wire-protocol.md:287`), so it is a
two-sided constant: too high and a peer allocates; too low and v2 conformance is
lost.
Open questions:
- The control cap's sufficiency depends on the role gate admitting only
  `Request` among body-carrying types. Should that dependency be asserted, or
  should the cap be applied to every channel-0 frame regardless of type?
  (needs human input)

### encoder-never-emits-a-frame-its-own-decoder-rejects

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test feeds encoder output back through
`decode_header` plus `validate_inbound_header` over anything but hand-chosen
legal inputs. The existing round-trips at `wire.rs:680` and `:693` construct
`EnvelopeHeader` directly, and `hdr` derives a legal epoch from the channel
(`wire.rs:650-652`), so they cannot reach the illegal region.
Guarantee: For every argument tuple the production encoders accept, the emitted
bytes decode successfully and pass inbound validation on a conforming peer.
Check: `always` — for arbitrary `(ty, flags, id, body)`, either
`encode_owned_frame` returns `Err`, or `decode_header` on its output returns
`Ok` and the result satisfies the pure-header, Sheddable, channel-and-epoch, and
reserved-bit rules. `always` because it must hold on every emission, and the
forbidden state — a frame the local decoder would reject — has no detection
point on the emitting side.
Fault/timing angle: none; this is a static contract gap. Four concrete holes,
all reachable from the crate's public surface (O7): `Flags(0b1100_0000)` sets
reserved bits; `Flags(0b0000_0110)` sets reserved priority;
`encode_owned_frame(FrameType::Ping, .., body)` with a nonempty body emits
`len != 0` on a pure-header type, which [wire.rs:340] rejects; and
`FrameId::routed` [wire.rs:525-531] copies `RouteHandle`'s channel and epoch
without checking that a nonzero channel carries a nonzero epoch, which
[wire.rs:352] rejects.
Required faults and enabling state: none beyond a caller passing an
out-of-contract value. For the `FrameId::routed` hole specifically, a
`RouteHandle` with a nonzero channel and epoch 0; whether the route allocator
can mint one is an open question below.
Confidence: high on the gap, medium on reachability —
[evidence](evidence/encoder-never-emits-a-frame-its-own-decoder-rejects.md). All
three encoders were read end to end: the only rejection is the body-length cap
at [wire.rs:548], [:577], [:618]. `Flags::new` [wire.rs:146-156] cannot produce
the illegal flag values, and the two host flag helpers `response_flags`
[wire.rs:636-638] and `pure_header_flags` [wire.rs:642-644] both go through it,
so the in-tree host emission paths are safe today by construction rather than by
enforcement. Medium on reachability because I did not audit route allocation for
an epoch-0 handle.
Existing check: none. `tests/protocol_vectors.rs` asserts the doc's bytes
against the independent oracle, not encoder refusal. Status: none found.
Impact: this is the encode side of the framing contract, and it is entirely
unenforced. A host that emits a frame its own decoder would reject produces
stream-alignment corruption at the peer, which the protocol requires the peer to
answer by closing the generation with no error frame
(`docs/mc-host-wire-protocol.md:293`) — an unattributable connection drop.
Open questions:
- Can `RouteHandle` ever hold a nonzero channel with epoch 0? Route allocation
  was not read in this lens. (partial)
- Should the encoders validate, or should the illegal region be made
  unconstructible by removing the public field from `Flags` and by giving
  pure-header types a body-free encoder? (needs human input)

### emitted-frame-declares-exactly-the-bytes-written

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `frame_channel/contract_tests.rs:517`
`exact_commit_covers_empty_boundary_segmented_and_maximum_bodies` and `:526`
`producer_failures_never_publish_and_return_each_charge_once` cover the producer
reservation's exact-length commit. Missing: any assertion that a `DirectFrame`'s
encoded header `len` equals the `body_len` its `ExactWriter` bounds.
Guarantee: Every frame reaching the socket declares in its header exactly the
number of body bytes that follow it.
Check: `always` — for every emitted frame, decode the header from the bytes
actually written and assert `header.len` equals the count of body bytes that
follow before the next header. `always` because the protocol states it as a
writer MUST evaluated per frame (`docs/mc-host-wire-protocol.md:295`), and the
forbidden state is a mismatched frame on the wire, which has no detection point
on the emitting side.
Fault/timing angle: no interleaving needed for the direct path. The exposure is
the two-value construction at [frame_channel.rs:616-626]: `DirectFrame::new`
receives an already-encoded 21-byte header and a separate `body_len`, and
`into_owned` reserves `HEADER_LEN + self.body_len` [frame_channel.rs:641] and
bounds the serializer to `self.body_len` [frame_channel.rs:644-646] — never to
the `len` inside the header it already holds. The single call site derives both
from `body.len` [dispatch.rs:321-334], so the property holds at HEAD by
derivation, not by check. A second call site, or a caller that computes the
header from one source and the length from another, breaks it silently.
Required faults and enabling state: none to state the property. To exhibit the
failure, a `DirectFrame` whose header `len` and `body_len` disagree.
Confidence: high — [evidence](evidence/emitted-frame-declares-exactly-the-bytes-written.md).
The other two paths are safe by construction: `encode_owned_frame` and
`encode_split_frame` compute `len` from `body.len()` and then move that same
buffer [wire.rs:582-583], [:617-621]. `ExactWriter::finish` rejects an
underfill and `write` rejects an overrun [frame_channel.rs:665-688], so the
serializer cannot deviate from `body_len` — only `body_len` itself can deviate
from the header.
Existing check: `frame_channel/contract_tests.rs:517` and `:526` for the
producer path; `tests/protocol_vectors.rs:311-326` asserts
`decoded.len as usize == vector.body.len()` for the committed vectors, through
the oracle. Nothing for `DirectFrame`. Status unaudited.
Impact: a mismatch makes the peer read body bytes as the next header, which is
exactly the stream-alignment corruption the protocol names as unrecoverable
(`docs/mc-host-wire-protocol.md:295`). The failure is silent at the emitter and
appears at the peer as an unexplained close.
Open questions:
- Should `DirectFrame::new` take an `EnvelopeHeader` and derive `body_len` from
  `header.len`, eliminating the second parameter? (needs human input)

### header-length-version-dispatch-has-no-production-driver

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — no test constructs a second version, and no production
caller can reach a non-21 header length.
Guarantee: The frozen-prefix extension point can actually admit a version whose
header length differs from 21, without editing each transport's reader.
Check: `reachable` — a campaign must execute `header_len_for_version` returning
a length other than `HEADER_LEN`, and the resulting header must be read and
decoded by the production TCP reader. `reachable` rather than `sometimes`: the
claim is about a code path that must be executable, namely the non-`HEADER_LEN`
arm of the dispatch, which does not exist today.
Fault/timing angle: none. This is a structural claim about the extension point.
The TCP reader defeats it three ways: it declares a fixed `[u8; HEADER_LEN]`
[tcp_frame_channel.rs:158], it rejects any `ver != PROTOCOL_VERSION` before the
dispatch can run [tcp_frame_channel.rs:177-179], and it reads exactly
`header_bytes[FROZEN_PREFIX_LEN..]`, a compile-time 16 bytes
[tcp_frame_channel.rs:180-186]. The shared-memory path is worse: it receives a
fixed-width `lease.wire_header()` [shm_provider.rs:562], and Part 1 recorded
that the transport validates offsets 0..5 with no version awareness.
Required faults and enabling state: adding a second arm to
`header_len_for_version` and a peer that speaks it. Nothing else.
Confidence: high — [evidence](evidence/header-length-version-dispatch-has-no-production-driver.md).
`header_len_for_version` has exactly one call site, [wire.rs:311], and one arm,
[wire.rs:294]. The module header claims the frozen prefix keeps fixed meaning
"in every future version" and that "`decode_header` enforces that discipline"
[wire.rs:16-18]; the enforcement exists, the ability to use it does not.
Existing check: none. Status: none found.
Impact: the frozen prefix is the protocol's stated forward-compatibility
mechanism (`docs/mc-host-wire-protocol.md:233`), and the cost of a version 3 is
therefore not "add an arm" but "edit every transport reader", which is exactly
the coupling the frozen prefix was meant to remove. Part 1 raised the same
concern from the transport side as an open question on
`wire-header-fully-validated-before-any-consumer-acts`; this record states it as
a property so the two halves are one finding.
Open questions:
- Should the TCP reader read the prefix, call `header_len_for_version`, and then
  read the remainder into a buffer sized by the dispatch, rather than
  pre-rejecting on `ver`? That would also delete the duplicated version check.
  (needs human input)

### ingress-capacity-never-below-the-declared-body-cap

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/handler_contract.rs:437` bisects the
handler-dependent floor with a 64 MiB retained declaration, rejects one byte
below it, and then sends a 64 MiB body at the exact floor.
`config.rs:527` `the_resident_cap_splits_into_three_non_overlapping_pools`
pins the constant arithmetic. Missing: a second holder of ingress bytes
concurrently with the maximum-size frame, and any check that a fourth pool or a
new subtrahend cannot break the floor.
Guarantee: The ingress pool's capacity is always at least `MAX_BODY_LEN`, so a
conforming maximum-size frame is never permanently unsatisfiable.
Check: `always` — at every startup, assert
`ingress_budget.capacity() >= MAX_BODY_LEN as usize`. `always` because it is
evaluated once per incarnation and must hold for the whole incarnation; the
forbidden state is a running host whose ingress ceiling is below the frame cap,
which has no detection point today because nothing on the read path reads
`capacity()` (O19).
Fault/timing angle: none to establish. The consequence is timing-shaped: if the
capacity fell below `MAX_BODY_LEN`, `budget.charge(header.len)`
[tcp_frame_channel.rs:210] would be a permanently unsatisfiable acquisition, and
the only thing terminating it is the frame-deadline arm at
[tcp_frame_channel.rs:211-213]. A peer would then get a full frame deadline of
stall per attempt, and the close would be branded structural corruption for what
is a configuration error.
Required faults and enabling state: none for the invariant. To exhibit the
failure, a configuration whose catalog plus declared retained bytes eat the
ingress slice, which the startup gate at [runtime.rs:720-728] currently forbids.
Confidence: high — [evidence](evidence/ingress-capacity-never-below-the-declared-body-cap.md).
Derived arithmetically and verified by reading all four terms:
`MIN_RESIDENT_BYTES = MAX_BODY_LEN + EGRESS_RESERVED_BYTES + SCRATCH_RESERVED_BYTES`
[config.rs:23-24]; startup requires
`max_resident_bytes >= MIN_RESIDENT_BYTES + catalog + retained`
[runtime.rs:720-728]; ingress is
`max_resident_bytes - EGRESS - SCRATCH - catalog - retained`
[runtime.rs:872-878]. Substituting gives `ingress >= MAX_BODY_LEN` exactly, and
the same substitution shows the `u64` subtraction cannot underflow.
Existing check: `tests/handler_contract.rs:437` and `config.rs:527`. Status
unaudited.
Impact: this single inequality is what makes the blocking ingress acquisition
terminate for a reason other than the deadline, and it is what backs the
protocol's non-negotiable acceptance requirement for one maximum-size frame
(`docs/mc-host-wire-protocol.md:287`). It is currently held together by three
constants in two files plus one startup comparison, with `capacity()` — the
accessor written specifically to detect the permanent case
[wire.rs:402-407] — unused on the path that would need it.
Open questions:
- Should the read path compare `header.len` against `budget.capacity()` and
  reject permanently rather than waiting out the deadline, given the accessor
  exists for exactly that distinction? (needs human input)

### ingress-budget-exhaustion-has-one-close-classification

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the shared-memory arm's `Overloaded` return has no test in
Part 2b scope, and the TCP arm's `Corrupt` return is not exercised at all: the
only budget-pressure contract test holds the pool against the *writer*
(`frame_channel/contract_tests.rs:156`), not against a blocked reader.
Guarantee: The ingress budget wait outlasting the frame deadline produces one
declared close disposition, identical across transports.
Check: `always` — construct a saturated ingress pool, deliver a frame whose
declared body cannot be charged before the frame deadline, and assert the
`ReadClose` variant is the same for every transport. `always` because the
mapping from exit cause to disposition is evaluated at every read exit; the
forbidden state is two transports disagreeing, which has no detection point.
Fault/timing angle: the whole property is a timing window. The enabling state is
a saturated ingress pool held by another connection for longer than one frame
deadline, with a frame in flight whose `len` is nonzero. TCP loses this race at
[tcp_frame_channel.rs:211-213] and returns
`Corrupt("body budget wait exceeded frame deadline")`; shared memory loses it at
[shm_provider.rs:585-589] and returns `Overloaded`, with a comment stating that
the peer and transport are healthy so the retirement must not be branded
corrupt.
Required faults and enabling state: a concurrent holder of the ingress pool, and
one connection per transport reading a body-carrying frame.
Confidence: high — [evidence](evidence/ingress-budget-exhaustion-has-one-close-classification.md).
Both sites read directly. `ReadClose::Overloaded`'s own documentation
[frame_channel.rs:40-43] defines the intended classification: "A resource wait
(ingress budget) outlasted its deadline: the peer and the transport are healthy,
so retirement is clean backpressure, not a structural fault." The TCP arm
contradicts that definition for the identical condition. The two arms also
differ in acquisition style (O15), which is a second, independent divergence.
Existing check: `frame_channel/contract_tests.rs:156`
`saturation_holds_at_frame_bound_and_spares_control_capacity` covers writer-side
saturation and asserts charge-free control frames stay admissible. Nothing
covers reader-side budget exhaustion on either transport. Status unaudited.
Impact: Part 2a established that close disposition is a total function of the
read-exit cause; this record says the function is not well defined, because one
cause has two images depending on which transport observed it. Downstream, the
`Corrupt` branding turns a capacity event into a corruption signal, which is the
signal an operator uses to distinguish a hostile or buggy peer from an
overloaded host.
Open questions:
- Which classification is normative for a lost ingress-budget race? Both
  behaviours exist at HEAD for the same condition. (needs human input)
- The shared-memory arm is `explicit-config-only` (O23); does that make the
  divergence latent rather than live? (partial)

### byte-charge-covers-every-copy-it-accounts

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `wire.rs:889` `try_charge_is_exact_and_all_or_none`,
`wire.rs:907` `split_preserves_total_and_shrink_releases_only_the_delta`,
`wire.rs:939` `split_or_take_falls_back_to_the_whole_charge`, and `wire.rs:955`
`body_charge_and_reservation_share_one_ingress_pool` cover the permit algebra
thoroughly. Missing: any check that the charge equals the bytes a frame actually
makes resident, across the header and across a flattening copy.
Guarantee: For every frame in flight, the bytes charged to a pool are at least
the bytes that frame holds resident at once.
Check: `always` — for every inbound frame, assert
`charge.bytes() >= body_len + HEADER_LEN` when the header bytes are retained,
and for every path that produces a second live copy of a body, assert a second
charge exists. `always` for the accounting obligation; the copy arm is
`always-or-unreached` in practice because the segmented constructor has no
production caller (O20), so an oracle must tolerate the path never running.
Fault/timing angle: none. Two concrete gaps. First, ingress charges
`header.len` only [tcp_frame_channel.rs:210], [shm_provider.rs:580], while
egress charges `body.len() + HEADER_LEN` [dispatch.rs:275-277],
[connection.rs:1240], [connection.rs:1301]; the 21 header bytes an inbound frame
retains inside `InboundFrame.header` are unaccounted, a fixed per-in-flight-frame
undercount bounded by the connection and queue limits. Second,
`InboundFrame::into_owned` flattens a segmented body into a second live
allocation and moves the single charge across without acquiring a second one
[frame_channel.rs:535-553], against the module's stated rule that host-managed
copies acquire a second charge [wire.rs:378-379].
Required faults and enabling state: for the header undercount, none — it is
every frame. For the copy gap, a transport that constructs
`InboundFrame::segmented`, which no shipped code does.
Confidence: high on both gaps, low on their severity —
[evidence](evidence/byte-charge-covers-every-copy-it-accounts.md). All charge
sites were enumerated by a repository-wide search for `try_charge`, `.charge(`,
`split_or_take`, `shrink_to`, and `split_excess`. The header undercount is
arithmetic; the copy gap is a direct read of `into_owned`. Severity is low
confidence because `max_resident_bytes` is documented as an accounting cap over
named logical payloads and not an exact RSS claim (`config.rs:105-110`), so a
21-byte-per-frame undercount may be deliberate.
Existing check: the permit algebra tests above, plus Part 1's
`ingress-charge-matches-the-bytes-copied-from-shared-storage` for the
shared-memory body copy. Nothing for the header bytes or the flattening copy.
Status unaudited.
Impact: the ingress pool is the mechanism that keeps a peer from making the host
resident in its own memory, and the accounting is off by a fixed amount per
in-flight frame in one direction and by a whole body on a path that is currently
dead. The dead path matters because it is the declared extension point for
segmented shared-memory backends [frame_channel.rs:492].
Open questions:
- Is the 21-byte header deliberately outside the accounting cap? Egress charges
  it and ingress does not, which reads as an inconsistency rather than a
  decision. (needs human input)

### documented-byte-vectors-pin-the-production-codec

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the committed vectors are round-tripped only through the
independent test oracle, so the assertion cannot fail on a production codec
change.
Guarantee: The byte vectors committed in the protocol document are reproduced by
the production encoder and accepted by the production decoder, not only by the
test oracle.
Check: `always` — for each committed hex vector, assert
`EnvelopeHeader { .. }.encode()` equals the vector's bytes and
`decode_header(vector)` yields the documented field values. `always` because it
must hold for every committed vector on every build; the forbidden state is a
production codec that has drifted from the document while the vector test still
passes.
Fault/timing angle: none; this is an oracle-independence gap. The oracle is a
complete second implementation with its own `HEADER_LEN = 21`
[tests/support/raw_client.rs:19], its own type constants [:25-36], its own
`header` encoder written "by writing each field at its documented offset"
[:285-296], and its own `decode_header` [:298-311]. It never imports
`mc_host::wire`. The vector test encodes and decodes with the oracle on both
sides [tests/protocol_vectors.rs:143-176], so a transposition inside
`wire::EnvelopeHeader::encode` leaves it green.
Required faults and enabling state: none. The gap is static.
Confidence: high — [evidence](evidence/documented-byte-vectors-pin-the-production-codec.md).
Verified by reading the oracle's imports (no `mc_host::wire`; its only
`mc_host` references are `transport_negotiation::NEGOTIATION_VERSION` at
[tests/support/raw_client.rs:408] and [:426]) and by reading the vector test's
two assertions, both of which call `raw_client::decode_header` and
`raw_client::header`. `wire.rs:703` pins the production offsets against
hand-written expectations, never against the document's hex.
Existing check: `tests/protocol_vectors.rs:143`
`committed_header_vectors_decode_to_their_documented_fields` and `:221`
`committed_negotiation_vectors_pin_bodies_and_headers`, both through the oracle.
`wire.rs:703` `little_endian_and_frozen_prefix_layout` for the production
encoder, against its own expectations. Status unaudited.
Impact: the second implementation is genuinely valuable — it is what makes the
vectors an independent check of the *document* — but there is no third assertion
tying the production codec to either. A drift in `wire.rs` is caught only by
`wire.rs`'s own fixture, and a drift in the document is caught only by the
oracle. Nothing catches a coordinated drift, and nothing catches a `wire.rs`
change whose fixture is updated alongside it.
Open questions:
- Should the vector test assert both codecs against the same committed hex, so
  the oracle's independence is preserved and the production codec is pinned?
  (needs human input)

## Contract-vs-code leads

Cited from both sides, not resolved.

- L1: Illegal correlation. `docs/mc-host-wire-protocol.md:283` says "Any
  structurally illegal channel, epoch, correlation, body, or direction closes the
  generation", and the section 6.2 table at `:270-281` gives a required
  correlation per frame type. But `:293`'s enumeration of what corrupts stream
  alignment omits correlation entirely, and no framing gate reads `corr`
  ([wire.rs:355-357] is the only access; F7). Two doc sentences disagree with
  each other, and the code follows the second.
- L2: Channel-0 body cap on egress. `docs/mc-host-wire-protocol.md:318` says
  "The direct profile caps a channel-0 body at 65,536 bytes even though framing
  permits more" as a property of channel 0, not of requests. The host enforces it
  only on inbound channel-0 `Request` [tcp_frame_channel.rs:198],
  [shm_provider.rs:565]. On egress, `emit_catalog_response` checks only
  `MAX_BODY_LEN` [connection.rs:1283-1289], and the host's own client applies the
  65,536 cap to a channel-0 response it reads
  ([client.rs:2225-2232], with a comment saying section 7.1's cap applies). So
  the host may emit a channel-0 body its own client would reject.
- L3: Overload classification versus the declared taxonomy.
  `frame_channel.rs:40-43` defines `Overloaded` as the disposition for a resource
  wait outlasting its deadline; [tcp_frame_channel.rs:211-213] returns `Corrupt`
  for exactly that. See `ingress-budget-exhaustion-has-one-close-classification`.
- L4: FIFO fairness of the shared ingress pool. `wire.rs:379-382` claims "Tokio's
  semaphore is FIFO, so a queued maximum-size acquisition cannot be starved by
  later small ones". The TCP reader uses the FIFO `charge()`
  [tcp_frame_channel.rs:210]; the shared-memory reader spins on `try_charge`
  [shm_provider.rs:579-602]; both draw on the same cloned pool
  [runtime.rs:872]. Whether `try_acquire_many_owned` can barge ahead of a queued
  waiter depends on Tokio internals I did not read, so this is unresolved rather
  than a finding. Needs the pinned Tokio version's `batch::Semaphore::try_acquire`
  semantics.
- L5: One logical write. `docs/mc-host-wire-protocol.md:295` says a writer SHOULD
  submit header plus body as one logical write. `encode_split_frame` deliberately
  returns two buffers for bodies at or above 16 KiB [wire.rs:606-632], and the
  writer issues two `write_all` calls [tcp_frame_channel.rs:370-373]. This is a
  SHOULD and the serialization requirement in the same paragraph is satisfied, so
  it is a lead only.
- L6: `StreamEnd` with a body. `docs/mc-host-wire-protocol.md:283` calls a
  nonzero-body `StreamEnd` structurally illegal while stating it is not a
  pure-header frame at the framing layer. `is_pure_header` correctly excludes it
  [wire.rs:87], and no host-side framing gate implements the direct-profile rule;
  inbound `StreamEnd` is rejected as role-invalid instead
  [frame_channel.rs:69-74], for a different reason and with a different message.
  The host's client does implement it [client.rs:2079].
- L7: Duplicate 64 MiB constants. `MAX_FRAME_BODY_LEN` [wire.rs:35] and
  `MAX_BODY_LEN` [wire.rs:371] are the same value under two public names, the
  first re-exported at the crate root [lib.rs:97] and the second used by the
  validator [frame_channel.rs:25]. Part 1 recorded a third,
  `MAX_FRAME_BYTES` in the transport's `arena.rs`. Three names, one protocol
  constant, no static tie between them.

## Open questions

- Q1: Can `RouteHandle` hold a nonzero channel with epoch 0? That determines
  whether `FrameId::routed` [wire.rs:525-531] can produce a header its own
  decoder rejects in production, or only through a hand-built handle. Route
  allocation was outside this lens. (partial)
- Q2: Is the 21-byte header deliberately excluded from ingress accounting while
  egress includes it? (needs human input)
- Q3: Which close classification is normative for a lost ingress-budget race?
  (needs human input)
- Q4: Does the pinned Tokio version's `try_acquire_many_owned` respect the
  waiter queue? Required to resolve L4. (unresolved, needs the vendored Tokio
  source or the version's `batch.rs`)
- Q5: Should the pure-header flag triple and the body caps move inside
  `decode_header`, making the decode postcondition the whole structural
  contract? This is the same question Part 1 asked about the role gate, from a
  different side. (needs human input)

## Deferred candidate, preserved with citations

Not counted among the twelve because its call sites lie outside Part 2b scope,
but the guarantee is declared in `wire.rs` and is worth a record in whichever
part owns `synapse` and `broca`:

- `no-byte-charge-is-released-under-an-unrelated-mutex`. `wire.rs:493-497`
  states that releasing a permit takes the budget's own waiter lock and wakes
  queued waiters, "which must not happen underneath an unrelated mutex", and
  `split_excess` [wire.rs:498-505] exists so a caller can defer the release past
  a guard. `broca/supervisor.rs:12` repeats the rule in its module header. The
  deferred-release pattern appears at `broca/supervisor.rs:842`, `:922`,
  `:1113`, and `synapse/jobs.rs:522-523`, `:562-563`. The property is
  `always(!X)` over drop sites: no `ByteCharge` is dropped while a lock the
  budget's waiters could contend is held. No existing check was found.
