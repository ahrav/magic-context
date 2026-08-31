# facade-a-measured-length-must-equal-written-body-or-nothing-is-terminal

## Discovery trigger

Sub-part 4d's third attention focus asks whether a measured length can disagree
with the bytes actually written, and what a cancellation leaves on the wire. The
answer is that the disagreement is detected, and the mechanism is worth a record
because it is the only thing standing between a double-serialization design and a
desynchronized length-prefixed wire, and its only test never runs.

## Evidence trail

### Why the serializer runs twice

`crates/mc-module/src/dispatch.rs:130-140`, the doc comment on
`PreparedOutput::measure`:

    /// JSON sources are counted, not collected. `measure` runs BEFORE the host's
    /// resident-byte reservation, so retaining the encoded body here would hold
    /// up to `MAX_WIRE_BODY_BYTES` outside the very budget the reservation
    /// exists to enforce: concurrent large responses would each own a full
    /// uncharged copy and could exhaust process memory while every one of them
    /// respected its charge. The serializer therefore runs twice — once to size
    /// the reservation, once to fill it — and `write_to`'s length check turns
    /// any disagreement between the two passes into an error rather than a
    /// short body.

The last clause is the contract this record tests.

### The three sources and their measurement

- `:96-102` `PreparedOutput::json(Value)` holds an `Arc<Value>`.
- `:105-111` `cached_bytes(Vec<u8>)` holds an `Arc<Vec<u8>>`.
- `:113-128` `transform_segments(envelope, messages)` holds an
  `Arc<TransformSegments>`, and rejects an envelope whose `ck_messages` is not
  `Value::Null` (`:120-122`).
- `:141-157` `measure` dispatches to `measure_json` (`:352-357`),
  `checked_body_len` (`:330-346`), or `measure_transform` (`:376-382`).
- All three sources are behind `Arc` and none exposes interior mutability, so the
  two passes read identical bytes. That is why the property is expected to hold.

### The cap is enforced during counting

- `:430-455` `CountingWriter::add_len` checks `checked_add` then
  `> MAX_WIRE_BODY_BYTES` before advancing, recording `CountFailure::Overflow` or
  `CountFailure::TooLarge(next)`.
- `:359-374` `finish_count` prefers the recorded failure over the serializer's
  own error, so an over-cap body reports `BodyTooLarge` rather than a serde
  message.
- `:12` `MAX_WIRE_BODY_BYTES = mc_host::MAX_FRAME_BODY_LEN as usize`, and the
  comment at `:7-11` explains the derivation rather than a literal so the module
  and host cannot disagree. `mc-host/src/wire.rs:35` sets that to 64 MiB, so the
  doc comment at `lib.rs:14281` ("The transport frame ceiling is 64 MiB") is
  accurate.

### The write-side guard

- `:251-278` `write_to` wraps the destination in `BoundedWriter::new(destination, self.len)`.
- `:489-506` `BoundedWriter::write` refuses when
  `bytes.len() > self.max_len - self.written`, returning
  `io::ErrorKind::WriteZero` with "prepared body exceeded measured length". It
  also rejects a destination that reports writing more than it was given
  (`:498-503`).
- `:270-277` after the source is streamed:

      let written = destination.written();
      if written != self.len {
          return Err(PreparedOutputError::LengthMismatch { measured: self.len, written });
      }

  So over-long is caught during the write and short is caught after it.
- `:254-265` for the JSON source, a destination io error is unwrapped out of
  serde's error type so callers keep the write-versus-serialize distinction.

### The settlement side

`crates/mc-module/src/lib.rs:12150-12205`, `settle_prepared_with`:

- `:12168-12176` a `measure` failure becomes
  `PreparedSettlement::Error{code:"encode_failed"}`.
- `:12177-12182` cancellation before reservation.
- `:12183-12191` `reserve(measured.len()).await`, and a reservation failure
  becomes `output_unavailable`.
- `:12192-12197` cancellation before encoding.
- `:12198-12203` a `write_to` failure becomes
  `PreparedSettlement::Error{code:"encode_failed"}` and the `body` binding is
  dropped without being returned.
- `:12207-12222` `settle_prepared` maps `Error` to `RequestOutcome::error(code, message)`.

So on any write failure the module returns a typed error and never a
`RequestOutcome::Response`.

### Existing coverage, and where it stops

`crates/mc-module/tests/prepared_output.rs`

- `:253-282` `inconsistent_source_reports_length_mismatch_without_emission`
  builds a segment whose bytes are `b"1"` and whose `measured_len` is `2`
  using `PreparedSegment::inconsistent_for_test` (`dispatch.rs:64-71`), then
  asserts `LengthMismatch { measured: 20, written: 19 }`, asserts the
  destination holds the 19 partial bytes (`:280`), and asserts the test's
  `terminal` stayed `None` (`:281`).
- `:233-251` `destination_failure_retains_no_partial_terminal` injects a
  destination that fails after 5 bytes and makes the same two assertions.
- `:147-179` `cap_plus_one_and_arithmetic_overflow_fail_before_write` covers
  `BodyTooLarge` at cap+1 and `LengthOverflow` via `usize::MAX`.
- `:181-196` `settle_with_cancellation` RE-IMPLEMENTS the settlement sequence by
  hand rather than calling `settle_prepared_with`, because that function is
  private to the crate. So `:199-211`'s cancellation tests assert the test's own
  model, not the production function.
- `lib.rs:16044-16200` does exercise `settle_prepared_with` directly at six call
  sites, including a cancellation-before-reserve case at `:16153`, a
  cancellation-before-write case at `:16170`, and a reserve-denial case at
  `:16185`. Those are inline, so they cover the real function.
- `.github/workflows/ci.yml:171-172` runs only
  `cargo test -p mc-module --test lifecycle_cli`. Neither the integration binary
  nor the inline module runs in CI.

## Failure scenario

A prepared source whose second pass produces a different byte count than the
first. Production has no such source, which is the reason to state the property
rather than to expect a defect: the guard is what makes the double-serialization
design safe, and the design is load-bearing for the resident-byte budget.

If the guard were absent or wrong, a short body on a length-prefixed frame stream
desynchronizes the reader: the host reserved N bytes, the module wrote N-1, and
the next frame's header is read from inside the previous frame's payload. That is
a whole-connection failure, not a single-request failure.

The realistic route to a disagreement is not a mutation of the source. It is a
new `PreparedSource` variant whose measure and write paths are written separately.
`measure_transform` (`:376-382`) and `write_transform` (`:384-392`) already share
`write_transform_envelope` (`:394-422`) with a per-message callback, precisely so
the two passes cannot diverge on the envelope. A fourth variant added without
that discipline is the plausible regression, and the guard is what would catch
it.

The partial-bytes detail is the part that needs a cross-part answer. On
`LengthMismatch` the reserved buffer already contains the bytes written before the
mismatch was detected; `tests/prepared_output.rs:280` asserts exactly that. The
module's contract is "do not treat it as terminal", which `settle_prepared`
honours by returning `RequestOutcome::error`. Whether the host discards the
reserved output frame is `mc-host`'s obligation.

## Timing windows and dependencies

The window is between `measure()` (`lib.rs:12168`) and `write_to`
(`:12198`), spanning an `await` on `reserve` (`:12183`). Anything that could
mutate the prepared source during that await breaks the property. Nothing can
today: all three sources are `Arc`-held immutable values and
`ServedMessage::canonical_bytes` (`dispatch.rs:76`) returns a borrow of already
computed bytes.

Two cancellation checks sit inside that window (`:12177`, `:12192`). They are
about not emitting at all, not about length, but they share the window and a test
covering one should cover both.

Reachability: default-production. Every response the module returns passes
through `settle_prepared` (`:11965`, `:11980`, `:11987`, `:11989`, `:11996`).

## What a test must construct

1. The existing tests already construct the disagreement. What is missing is that
   they run. The highest-value action for this property is to get
   `cargo test -p mc-module --test prepared_output` into CI, which is a CI change
   and out of scope for this pass.
2. A property form worth adding: for an arbitrary `PreparedOutput` built from an
   arbitrary `Value`, assert
   `write_to` returns `Ok(n)` with `n == measure().len()`. Run it under
   `proptest` over nested JSON including non-ASCII strings, floats that
   round-trip oddly, and deeply nested arrays, since `measure_json` and the write
   path both go through `serde_json::to_writer` and must agree on every escape and
   float rendering.
3. A regression guard for the new-variant scenario: a test that enumerates
   `PreparedSource` variants and fails if a variant's measure and write paths do
   not share a common traversal. That is a structural assertion and may be better
   expressed as a comment plus a review rule than as a test.
4. For the cancellation arms, prefer the inline tests at `lib.rs:16153-16200`
   over the integration binary's hand-rolled model at
   `tests/prepared_output.rs:181-196`, and consider deleting or rewriting the
   latter so it cannot drift from the function it imitates.

## Investigation log

### Q: On `LengthMismatch` the reserved buffer holds partial bytes. Does the host discard the reserved output frame when the module returns `RequestOutcome::error`?

- Sources examined: `lib.rs:12183-12204`, where `body` is bound from
  `reserve(...)` and then dropped on the error paths without being returned;
  `lib.rs:12207-12222`, `settle_prepared`, which returns
  `RequestOutcome::error(code, message)`; `tests/prepared_output.rs:266-282`, which
  makes the "partial bytes present, terminal absent" distinction explicit and is
  clearly written by someone who knew this question mattered;
  `dispatch.rs:469-511`, `BoundedWriter`, which never truncates or rewinds the
  inner destination.
- Findings: the module's half of the contract is complete and deliberate. It never
  returns a `Response` when the write failed, and the test asserts the
  "terminal" value stays `None`. Nothing in `mc-module` can rescind bytes already
  handed to the reserved destination, so the discard must happen in the host.
- Missing evidence: the `mc-host` reservation and output contract, specifically
  whether `RequestCtx::reserve_output` yields a buffer that is only transmitted on
  a `Response` outcome, or one that is transmitted regardless. Part 2b owns the
  wire and channel layer.
- Conclusion: unresolved, needs the `mc-host` reservation contract. Record the
  module-side property as stated; flag the cross-part obligation so Part 2b's
  synthesis can pair it with the host-side guarantee.
