# decode-header-is-total-over-arbitrary-bytes

Carried into this sub-part from the superseded `part-2b-wire-and-channels`,
where it was record 1 of `_lenses/lens-a-wire-format.md` (`L195-242`). Every
citation below was re-verified against `HEAD` = `e447c927` at carry time; the
one repair is recorded in the trail.

## Discovery trigger

`wire::decode_header` is the first thing that touches peer-authored bytes on the
host's inbound path, and its doc comment at `wire.rs:305` states the obligation
outright: "Never panics on malformed input — returns a typed `DecodeError`."
That is a claim under test, per METHOD rule 3. The body parses by constant index
after a single length gate, so the whole totality argument rests on one
comparison and one constant.

## Evidence trail

**The function.** `decode_header` is `wire.rs:306-368`. It has eleven gates, each
read directly and re-read at carry time:

| # | Line | Gate |
| --- | --- | --- |
| 1 | `:307` | `bytes.len() < FROZEN_PREFIX_LEN` (5) |
| 2 | `:311` | `header_len_for_version(ver)` returns `None` |
| 3 | `:312` | `bytes.len() < need` |
| 4 | `:321` | `FrameType::from_u8(bytes[5])` returns `None` |
| 5 | `:323` | `flags.has_reserved_bits()` |
| 6 | `:326` | `flags.priority().is_none()` |
| 7 | `:329-331` | `flags.admission_class()` returns `None` |
| 8 | `:332-339` | Sheddable on a type outside `{Push, StreamData}` |
| 9 | `:340` | `ty.is_pure_header() && len != 0` |
| 10 | `:345` | `channel == 0 && epoch != 0` |
| 11 | `:352` | `channel != 0 && epoch == 0` |

`EnvelopeHeader` is constructed exactly once, after all eleven, at `:359-367`.
No value escapes a rejected path.

**The constant indexes.** After gate 3 the function indexes `bytes[4]` (`:310`),
`bytes[0..3]` (`:319`), `bytes[5]` (`:321`), `bytes[6]` (`:322`), `bytes[7]` and
`bytes[8]` (`:343`), `bytes[9..12]` (`:344`), and `bytes[13..20]` (`:355-357`).
The largest is 20. `header_len_for_version` (`:292-297`) returns
`Some(HEADER_LEN)` for `PROTOCOL_VERSION` at `:294` and `None` otherwise;
`HEADER_LEN` is 21 (`:28`) and `PROTOCOL_VERSION` is 2 (`:25`). So gate 3
guarantees at least 21 bytes and the largest index is 20. The margin is exactly
zero: any version whose `header_len_for_version` value drops below 21 turns
`:355-357` into a panic, and nothing in the tree forbids that.

**No allocation.** The return type is `Result<EnvelopeHeader, DecodeError>` and
`EnvelopeHeader` derives `Copy` (`wire.rs:185-186`). `DecodeError` is likewise
a `Copy` enum (`:219-220`). No `Vec`,
`String`, `format!` or `Box` appears in the body.

**Reachability.** Three production call sites, all ungated:

- `ring_transport.rs:503`, in `receive_one`, paired with
  `validate_inbound_header` at `:505`. Reached because `RingTransport` is
  constructed unconditionally at `runtime.rs:876`, stored non-optionally as
  `HostShared.ring` (`:104`), and `ring.prepare(...)` is called by every
  authenticated connection at `connection.rs:148`.
- `ring_transport.rs:730`, in `RingClientEndpoint::try_recv_with` (declared at
  `:723`), reached in production from `client.rs:1903`.
- `client.rs:1978`, in `decode_outbound` (declared at `:1973`).

A fourth site, `ring_transport.rs:593`, sits inside `if let Some(hook)` at
`:592` and is reached only through the test-only `PublishHook`. `wire.rs` has
exactly two `#[cfg]` attributes, `:541` and `:646`, and neither is on this path.

**Existing coverage.** Two in-file tests, both table-driven over hand-picked
inputs:

- `reject_truncated_headers_and_unsupported_versions` (`:722-742`) covers three
  inputs: a 4-byte slice (`TooShortForPrefix`), a 10-byte slice with a valid
  version (`TooShortForHeader`), and a 21-byte slice with `ver = 1`
  (`UnsupportedVersion`). Gates 1, 3 and 2.
- `reject_unknown_frame_type_and_reserved_flag_encodings` (`:745-774`) covers
  four: type byte 99, flags `0b1000_0000`, flags `0b0000_0110`, flags
  `0b0011_0000`. Gates 4, 5, 6 and 7.

So seven hand-picked inputs across seven of the eleven gates. Nothing sweeps
arbitrary bytes, nothing sweeps lengths 0 through 21, and nothing mutates an
accepted seed. Neither test runs in CI, under this sub-part's `R0`.

**No fuzz target exists.** `find -type d -name fuzz` over the repository returns
exactly one directory, `crates/mc-shm-transport/fuzz`, whose three targets are
`frame_descriptor.rs`, `provider_grant.rs` and `provider_sample.rs`. All three
are transport decoders and none reaches `mc-host`'s `decode_header`.

**Citation repaired.** The lens wrote `wire.rs:745-773` for the second test and
the closing brace is at `:774`; `:773` is the `);` of the last `assert_eq!`. Off
by one line, no effect on the finding. The lens also wrote "both production
callers pass a fixed-size array" and there are three; see the failure scenario
for why the count matters and the conclusion does not change.

## Failure scenario

The property holds at `HEAD`. The failure it guards is a two-step regression
that no check would catch.

Step one: a caller starts passing a slice whose length is not statically 21.
Today all three production callers pass an exactly-21-byte array —
`ring_transport.rs:503` and `:729` pass `&lease.wire_header()`, typed
`[u8; WIRE_V2_HEADER_BYTES]` at `crates/mc-shm-transport/src/lease.rs:152` with
that constant equal to 21 at `descriptor.rs:10`, and `client.rs:1908` passes
`header_bytes: &[u8; HEADER_LEN]` narrowed by the `try_into` at `:1907`. A
coalescing reader that hands `decode_header` its whole buffer, or a batched
descriptor that yields a short tail, breaks that.

Step two: a version 3 whose `header_len_for_version` returns anything below 21,
or a narrowing of `HEADER_LEN` itself. Gate 3 then admits a slice shorter than
the largest constant index and `:355-357` panics inside the read loop on
peer-controlled input. Because `run_endpoint`'s outer `catch_unwind` result is
discarded with `let _ =` (`ring_transport.rs:264`) and `admission.release()`
(`:276`) runs regardless, the panic is reported to the connection engine as
orderly completion — which is this sub-part's own
`ring-a-endpoint-thread-panic-is-reported-as-orderly-completion`. So a decoder
panic would surface as an unattributable peer close, not as a crash.

## Timing windows and dependencies

None. `decode_header` is pure over one immutable slice: no interior mutability,
no shared state, no await, no lock. The dependency is structural rather than
temporal, and it is the coupling between one constant (`HEADER_LEN`), one
function (`header_len_for_version`), and six literal index expressions that no
type or assertion ties together.

## What a test must construct

A property test over `Vec<u8>` of arbitrary length, in-crate because
`decode_header` is reachable through `pub mod wire` but the cheapest home for a
sweep is `wire.rs`'s own test module.

1. **Totality.** For arbitrary bytes, the call returns. Under a harness that
   treats a panic as failure, this is the whole assertion; no `catch_unwind` is
   needed.
2. **Postcondition on `Ok`.** Assert all eleven gate conditions on the returned
   `EnvelopeHeader`: `ver == PROTOCOL_VERSION`, `!flags.has_reserved_bits()`,
   `flags.priority().is_some()`, `flags.admission_class().is_some()`, Sheddable
   only on `Push` or `StreamData`, `len == 0` whenever `ty.is_pure_header()`, and
   `(channel == 0) == (epoch == 0)`.
3. **Exhaustive length sweep.** Lengths 0 through 21 inclusive, so gates 1 and 3
   are hit at every boundary rather than at two hand-picked points.
4. **Structured mutation.** Start from an accepted 21-byte seed and flip each of
   the 168 bits, asserting the result is either accepted with a changed value or
   rejected. This overlaps the bijection record's per-bit oracle and the two are
   cheapest to write together.

No fault injection and no fixture host. The cost is that the test lands in the
lib target, which no CI job builds.

## Investigation log

### Q: Should `header_len_for_version` be required to return at least the largest constant index used by the parse body, so a future version cannot silently make the parse out of bounds?

- Sources examined: `wire.rs:292-297` (`header_len_for_version`), `:306-368`
  (the parse body and all six constant index expressions), `:25` and `:28`
  (`PROTOCOL_VERSION`, `HEADER_LEN`), `docs/mc-host-wire-protocol.md:222-234`
  (§6.1 Header, the offset table).
- Findings: the invariant is real and unstated. `header_len_for_version` returns
  21 for the one supported version and the largest index is 20, so the margin is
  exactly zero and correct. Nothing enforces it: the function is a `match` over
  `ver` with no relationship to the parse body, and the indexes are literals.
  A `const` assertion tying `HEADER_LEN` to the largest offset would be
  mechanical, but choosing whether future versions may shrink the header is a
  protocol decision, not a code one — §6.1's frozen prefix guarantees only that
  `len` and `ver` keep their positions, and says nothing about the total width
  being monotonic.
- Missing evidence: none technical. What is missing is a protocol intent.
- Conclusion: needs human input. The invariant should be written down either way;
  whether the enforcement belongs in a `const` assertion or in a versioned parse
  table depends on whether a narrower future header is permitted.
