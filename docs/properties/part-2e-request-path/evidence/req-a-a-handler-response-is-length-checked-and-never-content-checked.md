# req-a-a-handler-response-is-length-checked-and-never-content-checked

## Discovery trigger

The task named the pattern to hunt: Parts 4c and 4d found handlers returning
success without writing, and six error paths presenting as success. Those live in
`mc-module`, on the other side of this boundary. The question here is what this
layer does with a handler result — does it validate it, and can a handler failure
reach the client as a success.

## Evidence trail

Terminal selection is the `match joined` at `dispatch.rs:1019-1062`. The
`Response` arms are:

```
Ok(RequestOutcome::Response { .. }) if settlement.has_streamed() => Terminal::Error { .. }   // :1020
Ok(RequestOutcome::Response { body, binary })
    if body.len() <= crate::wire::MAX_BODY_LEN as usize => Terminal::Response { body, binary } // :1031
Ok(RequestOutcome::Response { .. }) => Terminal::Error { .. }                                 // :1035
```

The only predicate on an accepted `Response` is `body.len() <= MAX_BODY_LEN`.
There is no lower bound, no emptiness check, and no comparison of written length
against the reservation.

`OutputBuffer::len()` (`handler.rs:361-366`):

```
pub fn len(&self) -> usize {
    self.direct
        .as_ref()
        .map_or(self.body.len(), |body| body.len)
}
```

For an owned buffer this is the *written* length. For a direct buffer it is the
*declared* `exact_len`. So the guard measures different things depending on shape,
and in neither case does it compare the two.

A handler can reach the accepted arm with zero bytes written. `reserve_output`
(`handler.rs:466-468`) delegates to `StreamSink::reserve`
(`dispatch.rs:515-543`), which returns a buffer with
`body: Vec::with_capacity(max_len + HEADER_LEN)` at `:538` — capacity, not
length. `OutputBuffer::extend_from_slice` and `resize` (`handler.rs:381-396`)
refuse to exceed `max_len` but nothing obliges the handler to call either. So
`RequestOutcome::Response { body: <reserved, unwritten>, binary: false }` is a
well-typed value that passes the guard with `body.len() == 0`.

The empty body then encodes cleanly. `encode_owned_frame` (`wire.rs:571-602`)
rejects only `body.len() > MAX_BODY_LEN` and handles `body_len == 0` by
resizing to `HEADER_LEN` and copying the header in. `encode_split_frame`
(`wire.rs:608-632`) routes bodies under `SPLIT_WRITE_MIN_BODY` (16 KiB) to
`encode_owned_frame`, so an empty body takes that path.

The decoder accepts it too. The pure-header rule at `wire.rs:340` is:

```
if ty.is_pure_header() && len != 0 {
    return Err(DecodeError::PureHeaderFrameWithBody { ty, len });
}
```

and `is_pure_header` (`wire.rs:86-88`) covers only `Cancel`, `Ping`, `Pong`, and
`Goodbye`. There is no converse rule requiring a `Response` to have a nonzero
`len`. A zero-length `Response` is a well-formed frame in this protocol.

For contrast, the one handler-side failure the layer *does* shape correctly:
`composite.rs:277-287` returns `RequestOutcome::error(CODE_INTERNAL_ERROR,
"route is not mapped to a component")` for an unmapped route. That is an error,
and it becomes an `Error` terminal.

## Failure scenario

1. A handler reserves 64 KiB with `ctx.reserve_output(65536)`.
2. It begins serializing, hits an error branch, and takes an early return.
3. The early return builds `RequestOutcome::Response { body, binary: false }`
   from the reserved-but-unwritten buffer, because that is the value in scope and
   the type permits it.
4. `dispatch.rs:1031` accepts it: `0 <= MAX_BODY_LEN`.
5. `settle` emits a `Response` terminal with `len = 0` and the `last` flag set
   (`response_flags(binary, true)`, `dispatch.rs:450`).
6. The client receives a successful terminal. Per protocol §10.1 that is
   `terminal`, and §10.2 gives no retry for an application success.

The client cannot distinguish this from a legitimately empty result. It will not
retry and will not surface an error. The handler's failure has become a success.

Variant: the handler writes a *prefix* of its intended output and returns
`Response`. The client receives a truncated body that is a valid frame and a
successful terminal, and must detect the truncation from the body's own
structure, which for a JSON body means a parse error and for a binary body may
mean nothing at all.

## Timing windows and dependencies

None. This is a static gap in the guard, not a race. It holds on every unary
success on every generation.

Dependency: the guard is the *only* validation between the handler and the wire
for a unary success. `emit_reserved_frame` (`dispatch.rs:315-364`) rechecks
generation liveness but not content. `encode_split_frame` rechecks only the
upper length bound. So there is no second line of defence.

## What a test must construct

1. A handler mode that reserves `N` bytes, writes nothing, and returns
   `RequestOutcome::Response`.
2. Send one routed request; assert the client observes a `Response` terminal
   (not an `Error`) for that correlation with `len == 0`.
3. A second mode that writes `N/2` bytes of an intended `N` and returns
   `Response`; assert the client observes a successful terminal with a truncated
   body.
4. The paired negative: assert that the *streaming* equivalent is caught, since
   `dispatch.rs:1020` does convert a post-stream `Response` into
   `internal_error`, so the layer is not uniformly permissive.

`tests/dispatch.rs:665` (`oversized_handler_output_cannot_corrupt_framing`)
covers only the ceiling, and it is not in CI. Nothing covers the floor.

## Investigation log

### Q: Is a zero-length `Response` actually legal on the wire, or does something reject it?

- Sources examined: `wire.rs:86-88` (`is_pure_header`), `:330-350` (decode
  validation), `:575-602` (`encode_owned_frame`), `:608-632`
  (`encode_split_frame`); `tests/protocol_vectors.rs` was not read.
- Findings: the pure-header rule constrains only the four header-only types.
  No rule requires a body-bearing type to have a nonzero `len`. Encoding and
  decoding both accept it.
- Missing evidence: whether `tests/protocol_vectors.rs` pins a golden vector that
  would catch this. I did not read it.
- Conclusion: resolved with answer — legal on the wire. The remaining question is
  client behaviour, below.

### Q: Does any client treat an empty-body `Response` as a violation?

- Sources examined: none in depth. `client.rs` is Part 2d's scope and
  `packages/plugin` is Part 5's.
- Findings: Part 2d's index does not contain a record about empty or truncated
  response bodies, so it appears uncovered there too.
- Missing evidence: the client-side terminal handling for a zero-length body.
- Conclusion: unresolved, needs a client-side check. If no client rejects it,
  this is an end-to-end silent-success path rather than a host-side gap alone.

### Q: Should the host enforce a content check at all?

- Sources examined: `handler.rs:207-235` (`RequestOutcome` docs), `:326-336`
  (`OutputBuffer` docs), protocol §9.1 ("Transport never parses routed
  application bodies").
- Findings: §9.1 forbids the host from parsing the body, so a semantic check is
  out. But a *structural* check — written length equals reserved length, or at
  least nonzero — needs no parsing, and the type system already tracks both
  numbers (`body.len()` and `max_len`, both fields of `OutputBuffer`).
- Missing evidence: whether any legitimate handler returns a deliberately empty
  unary success, which would make a nonzero-length rule wrong.
- Conclusion: needs human input — whether an empty unary success is a legitimate
  application outcome determines which structural check is admissible.
