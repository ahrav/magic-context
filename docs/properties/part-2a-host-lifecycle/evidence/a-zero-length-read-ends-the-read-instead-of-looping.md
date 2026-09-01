# a-zero-length-read-ends-the-read-instead-of-looping

## Discovery trigger

`frame_read.rs:10-13` names "treating a zero-length read as end-of-stream rather
than looping" as the second of three load-bearing mechanics. The choice is three
identical three-line blocks, which is exactly the kind of thing two divergent
copies would get wrong differently, and which the module was single-sourced to
prevent.

## Evidence trail

All references at `1c193ae0`; the cited files are byte-identical to `d90e7811`.

The three sites:

- `read_exact`, `frame_read.rs:55-57`: `if read == 0 { return Err(ReadStop::Eof); }`
- `read_body`, `frame_read.rs:89-91`: same.
- `drain`, `frame_read.rs:119-121`: same.

Each is reached only with a non-empty read target, which is what makes a zero
return meaningful:

- `read_exact` loops on `filled < buf.len()` (`:46`), so `&mut buf[filled..]` at
  `:50` is non-empty.
- `drain` loops on `remaining > 0` (`:109`) and sets
  `want = remaining.min(scratch.len())` (`:110`), so `&mut scratch[..want]` at
  `:114` is non-empty.

`read_body` needs a longer argument, because `read_buf` has two `Ok(0)` causes
besides EOF. Both were checked against the versions pinned in `Cargo.lock`
(tokio 1.53.1, bytes 1.12.1):

1. *No remaining capacity.* `ReadBuf::poll` returns `Poll::Ready(Ok(0))` early
   when `!me.buf.has_remaining_mut()`
   (`tokio-1.53.1/src/io/util/read_buf.rs:46-48`). For `Vec<u8>`, `bytes`
   reports `remaining_mut() = isize::MAX as usize - self.len()` and `chunk_mut`
   calls `self.reserve(64)` when `capacity() == len()`
   (`bytes-1.12.1/src/buf/buf_mut.rs:1599-1636`). So a `Vec` reports zero
   remaining only at `len == isize::MAX`, and it grows on demand rather than
   returning a spurious zero. Ruled out.
2. *Take limit exhausted.* `limited` is `reader.take(len as u64)`
   (`frame_read.rs:79`), so it returns `Ok(0)` after `len` bytes. With `buf`
   starting empty that happens exactly when `buf.len() == len`, and the loop
   condition at `:80` has already exited. In the unreached non-empty case
   described in
   [a-body-read-consumes-exactly-the-declared-frame-boundary](a-body-read-consumes-exactly-the-declared-frame-boundary.md)
   the loop exits even earlier. So the limit is never exhausted while the loop is
   running, in either case. Ruled out.

So `read == 0` at `:89` is EOF. Note the dependency: it is EOF *because* `bytes`'
`BufMut for Vec<u8>` grows. A buffer type with fixed remaining capacity would
make `:89` reclassify "buffer full" as "peer closed", silently.

How the host distinguishes the outcomes, which is what gives the property an
oracle: `frame_close` maps `ReadStop::Eof` to `Corrupt("EOF inside frame")` and
`ReadStop::DeadlineExpired` to `Corrupt("frame deadline expired")`
(`tcp_frame_channel.rs:281-290`). `drain_close` maps `Eof` to
`Corrupt("EOF while draining oversize body")` (`:293-301`). Distinct strings, so
a test can tell a correct EOF from a looped-out deadline.

The client discards the distinction entirely: `map_err(|_| ())` at
`client.rs:1993`, `:2006`, `:2020`. So on the client side this property has no
observable other than timing.

## Failure scenario

Replace `return Err(ReadStop::Eof)` with `continue`. A peer closes the connection
after sending three bytes of a declared eight-byte body
(exactly the shape of `tcp_frame_channel.rs:599-618`).

A closed stream's `poll_read` returns `Ok(0)` immediately, and does so forever.
The loop therefore spins: poll cancellation (not ready), poll the read (ready,
zero), `continue`. No await ever pends, so the task never yields to the reactor
except through `timeout_at`'s own timer registration. The loop burns CPU on that
worker for the remainder of the frame deadline, default 30 s
(`config.rs:224`), and then returns `DeadlineExpired`.

Two harms. The cheap one: 30 seconds of a busy worker per closed connection,
multiplied by up to `max_connections` (64, `config.rs:129`) peers disconnecting
mid-frame at once. The subtle one: the close reason becomes
`Corrupt("frame deadline expired")`, which blames a slow peer for what was an
orderly mid-frame disconnect. Every diagnosis downstream of that reason is then
wrong.

## Timing windows and dependencies

The whole property is about timing, and that is the important part of the test
design. A looping implementation and a correct one both end in an error, and the
error is *reachable* either way, so a test that asserts only "this fails" cannot
tell them apart. Only the elapsed time and the error class discriminate.

Dependencies: tokio 1.53.1's `read_buf` early return, and bytes 1.12.1's
`BufMut for Vec<u8>` growth. Both pinned in `Cargo.lock`, both cited above.

## What a test must construct

Three unit tests against `frame_read`, one per helper. Each is one
`tokio::io::duplex` pair, a partial write, and `drop(client)`:

1. `read_exact` with a 20-byte target after writing 3 bytes.
2. `read_body` with `len = 8` after writing 3 bytes.
3. `drain` with `declared = 8192 * 3` after writing 100 bytes, so the loop has
   iterated at least once through the scratch buffer first.

Each asserts `Err(ReadStop::Eof)`, and each asserts the call returned *promptly*
relative to its deadline. Under `#[tokio::test(start_paused = true)]` the second
assertion is exact rather than a wall-clock heuristic: pass a deadline far in the
virtual future and assert the call completes without any `advance`. A looping
implementation cannot complete without the deadline being reached, so it fails
deterministically.

For the `read_body` capacity dependency, add a case where the vector's capacity
is smaller than `len` (`Vec::new()` with `len = 100`) and assert the read still
completes with `buf.len() == len`. That pins the growth behaviour the EOF
detection relies on, so a future buffer-type change fails a test instead of
silently reclassifying.

## Investigation log

### Q: Can `read_buf` return `Ok(0)` for a reason other than EOF here?

- Sources examined: `tokio-1.53.1/src/io/util/read_buf.rs:34-60`,
  `bytes-1.12.1/src/buf/buf_mut.rs:1599-1636`, `frame_read.rs:79-92`, and
  `Cargo.lock` for both versions.
- Findings: two other causes exist in principle and both are excluded here. The
  no-remaining-capacity early return cannot fire for a `Vec`, which reports
  `isize::MAX - len` remaining and grows in `chunk_mut`. The take-limit
  exhaustion cannot fire before the loop condition exits, in either the reached
  or the unreached buffer state.
- Missing evidence: none. Both exclusions are read off the dependency source at
  the pinned versions.
- Conclusion: resolved. `read == 0` at `frame_read.rs:89` is EOF. The conclusion
  depends on the `bytes` `Vec` impl, so it is a dependency-derived fact rather
  than a local one, which is why the record carries an open question about
  pinning it.

### Q: Do the existing tests discriminate the defect, or merely the error?

- Sources examined: `tcp_frame_channel.rs:562-578`, `:580-597`, `:599-618`,
  `:810-834`, and the mappings at `:281-301`; `connection.rs:401-410`.
- Findings: unequal. `:617` asserts the exact string
  `Corrupt("EOF inside frame")`, which a looping `read_body` cannot produce, so
  that test does discriminate. `:596` asserts only `Corrupt(_)`, which a looping
  `read_exact` satisfies via `"frame deadline expired"` after burning the
  deadline, so it does not. `:810-834` reaches `drain`'s EOF but asserts
  `RejectedDrainFailed`, and `connection.rs:401-410` collapses every stop class
  into that one variant, so it cannot discriminate either. `:562-578` covers the
  clean pre-header EOF, which is `read_frame`'s own first-byte read at
  `tcp_frame_channel.rs:160-167` and not a `frame_read` path at all.
- Missing evidence: none.
- Conclusion: resolved. One of the three helpers has a discriminating check; the
  other two have error-reachability checks that a looping implementation would
  also pass. Recorded as `Exercised: partial` with the asymmetry stated.
