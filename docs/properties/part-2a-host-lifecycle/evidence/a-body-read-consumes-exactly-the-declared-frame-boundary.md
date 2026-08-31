# a-body-read-consumes-exactly-the-declared-frame-boundary

## Discovery trigger

`frame_read.rs:63-68` documents the cap as load-bearing: "`take` caps the read
at the frame boundary even when the allocated capacity exceeds `len` — without
that cap a pipelined next header would be read as this frame's body." The module
doc repeats it at `:12-14`. Reading the loop next to the cap shows the two are
measured in different units.

## Evidence trail

All references at `1c193ae0`; the cited files are byte-identical to `d90e7811`.

`read_body`, `frame_read.rs:69-94`. The two lines that matter:

```
:79     let mut limited = reader.take(len as u64);
:80     while buf.len() < len {
:84             result = timeout_at(deadline, limited.read_buf(buf)) => ...
```

`:79` caps the total bytes drawn through `limited` at `len`. That is what makes
the over-read direction impossible: `Take::poll_read` shrinks its target to the
remaining limit, so once `len` bytes have passed it returns `Ok(0)` regardless of
how much capacity `buf` has or how many bytes are buffered on the reader. The
doc's claim is verified. A pipelined next header physically cannot be consumed as
this frame's body.

`:80` measures `buf.len()`, the buffer's absolute length. That is not the bytes
this call consumed. The two agree only when `buf` starts empty.

The under-read arithmetic, with `buf` entering with `k` bytes and `0 < k < len`:
the loop needs `buf.len() >= len`, so it appends `len - k` bytes and exits.
`limited` has drawn `len - k` bytes, so `k` of the frame's body bytes remain on
the wire. The function returns `Ok(())`. The returned buffer is `k` stale bytes
followed by `len - k` body bytes, so the body content is wrong too. With
`k >= len` the loop body never executes and the call consumes nothing, also
returning `Ok(())`.

Both call sites pass a freshly allocated empty vector:

- Host: `tcp_frame_channel.rs:217`,
  `let mut body = Vec::with_capacity(header.len as usize);`, then `:219`
  `read_body_deadline(reader, &mut body, header.len as usize, deadline, cancel)`.
  The wrapper at `:264-277` forwards `buf: &mut Vec<u8>` unchanged.
- Client: `client.rs:1997-2008`. The wrapper itself allocates at `:2003`,
  `let mut body = Vec::with_capacity(len);`, calls `read_body` at `:2004`, and
  returns the vector at `:2007`. The client's callers cannot supply a buffer at
  all, so the client side is structurally immune.

So the vulnerable precondition is unreached today, and the host's forwarding
wrapper is the only surface through which it could be reached.

One incidental confirmation of the doc's "appends into spare capacity" claim:
`bytes`' `chunk_mut` for `Vec<u8>` returns `capacity - len` bytes
(`bytes-1.12.1/src/buf/buf_mut.rs:1622-1636`). With `Vec::with_capacity(len)`
and an empty start, the first chunk is exactly `len` bytes and the take limit is
exactly `len`, so the vector never reallocates on the happy path.

## Failure scenario

A future caller reuses a body buffer across frames as an allocation optimization
and forgets to clear it, or clears it only on the success path. Frame N's body
leaves `k` bytes in the buffer; frame N+1 declares `len` and under-reads by `k`.

`read_frame` returns `ReadEvent::Frame` with a body whose first `k` bytes belong
to the previous frame. `read_loop` (`connection.rs:417`) dispatches it. The next
`read_frame` call reads its first header byte at `tcp_frame_channel.rs:160-163`
from frame N+1's body, so the peer's body content chooses the host's next
header: its length, version, type, channel, epoch, and correlation.

The version check at `:177-179` and `validate_inbound_header` at `:196` will
usually reject that, closing the generation with
`Corrupt("unsupported version")` or similar. That is the benign outcome. The
harmful one is a body crafted so its bytes at offset 0 form a valid header: the
peer then controls a frame identity the host believes it read from the wire, on a
stream it believes is aligned.

## Timing windows and dependencies

None. This is a pure precondition bug with no interleaving and no fault
required. That is what makes it cheap to test and easy to miss: no fault
injection reaches it, only a call with a non-empty buffer.

Dependency: `AsyncReadExt::take` semantics (tokio 1.53.1). `limited` is rebuilt
on every call at `:79`, so the limit never carries across calls.

## What a test must construct

Two unit tests directly against `read_body`.

Positive, the property as stated:

1. Write `len` body bytes followed by a complete valid header onto a
   `tokio::io::duplex` peer.
2. Call `read_body` with an empty `Vec` and a generous capacity, larger than
   `len`, so the cap and not the capacity decides.
3. Assert `buf.len() == len` and that the bytes are the body's.
4. Assert the pipelined header is still intact: read `HEADER_LEN` bytes and
   compare to what was written. This is the assertion that discriminates the
   cap. Step 3 alone passes on a capacity-bounded implementation that read too
   much and truncated.

Negative, the unreached precondition:

1. Pre-fill the buffer with `k` bytes, `0 < k < len`.
2. Same wire layout.
3. `read_body` returns `Ok(())` today. Assert instead that either exactly `len`
   bytes were consumed, or the call did not return `Ok`. Under the current
   implementation this test fails, which is the point: it pins the contract the
   signature currently allows a caller to break.

An `assert!(buf.is_empty())` at the top of `read_body`, or clearing `buf` on
entry, would make the negative test unnecessary by making the state
unrepresentable. That is the open question on the record and it is a design
decision.

## Investigation log

### Q: Is the non-empty-buffer case reachable from any current caller?

- Sources examined: every `read_body` call site, found by
  `grep -rn frame_read crates`, which gives exactly two:
  `tcp_frame_channel.rs:274` (wrapper) reached from `:219`, and
  `client.rs:2004` (wrapper) reached from `:1974`. Both allocation sites read at
  `tcp_frame_channel.rs:217` and `client.rs:2003`.
- Findings: no. Both allocate a fresh `Vec` immediately before the call. The
  client's wrapper owns the allocation internally so its callers cannot supply a
  buffer; the host's wrapper takes and forwards `&mut Vec<u8>`, so the host's
  single call site is the only place the precondition could ever be broken.
- Missing evidence: none for the current tree.
- Conclusion: resolved. Unreached today, hence `always-or-unreached`. The
  asymmetry between the two wrappers is worth recording: only one of them can be
  misused.

### Q: Can the cap ever be bypassed, making the over-read direction reachable?

- Sources examined: `frame_read.rs:79-92`, and `Take`'s contract in tokio
  1.53.1.
- Findings: no. `limited` is the only path to the reader inside the loop, and
  the cap is set from `len` on the same line it is created. `buf`'s capacity is
  irrelevant to it.
- Missing evidence: none.
- Conclusion: resolved. The doc's claim at `frame_read.rs:63-68` is accurate;
  the over-read direction is structurally impossible and only the under-read
  direction is open.
