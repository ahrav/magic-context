# Lens pass: gap G2, shared frame-read mechanics and the oversize drain

Targeted pass closing gap G2 from
[../portfolio-evaluation.md](../portfolio-evaluation.md): `frame_read.rs` names
three mechanics as load-bearing in its own module doc, has zero tests, and no
existing record covers it directly.

System `/local/home/ahrav/scratch/magic-context` at `1c193ae0`. Every file this
pass cites is byte-identical between `d90e7811` (the catalog's stated commit) and
`1c193ae0`, verified with `git diff --stat d90e7811 HEAD` over `frame_read.rs`,
`tcp_frame_channel.rs`, `client.rs`, `frame_channel.rs`, `wire.rs`, and
`connection.rs`: empty output. Every line reference below was read at
`1c193ae0`.

## Scope and the complete caller set

`frame_read.rs` is 125 lines and exports three helpers plus one stop enum
(`frame_read.rs:25-33`):

- `read_exact` (`frame_read.rs:36-61`) fills a `&mut [u8]`.
- `read_body` (`frame_read.rs:69-94`) appends exactly `len` bytes to a `&mut Vec<u8>`.
- `drain` (`frame_read.rs:98-125`) discards exactly `declared` bytes through an
  8 KiB stack scratch buffer (`frame_read.rs:107`).

`grep -rn frame_read crates` gives the complete caller set. There are exactly
two callers, each wrapping all three helpers:

| Helper | Host wrapper | Client wrapper |
| --- | --- | --- |
| `read_exact` | `read_exact_deadline`, `tcp_frame_channel.rs:249-261` | `read_exact_until`, `client.rs:1985-1994` |
| `read_body` | `read_body_deadline`, `tcp_frame_channel.rs:264-277` | `read_body_until`, `client.rs:1997-2008` |
| `drain` | `drain_declared_body`, `tcp_frame_channel.rs:234-246` | `drain_until`, `client.rs:2012-2021` |

The host maps every stop onto `ReadClose` through `frame_close`
(`tcp_frame_channel.rs:281-290`) and `drain_close`
(`tcp_frame_channel.rs:293-301`). The client discards the stop class entirely
with `map_err(|_| ())` at `client.rs:1993`, `:2006`, and `:2020`, so every stop
is one indistinguishable failure there.

Reachability of the module itself: `tcp_frame_channel::read_frame` is the read
path for every accepted TCP connection (`connection.rs:178-186` constructs the
channel in `run_connection`, the default and only shipped provider), and
`client.rs:reader_loop` is the client's only inbound path
(`client.rs:1890-1908`). So `frame_read` is **default-production** on both
sides. This is verified, not assumed, and it is why five of the six records
below carry that label.

## Observations

### O1. The module doc names three mechanics as load-bearing

`frame_read.rs:10-15` states the reason the module is single-sourced: "the
`biased` select that prefers cancellation over another read, treating a
zero-length read as end-of-stream rather than looping, and capping the body read
at the frame boundary so a pipelined next header is never consumed as body. Two
copies of that drifting apart reintroduces exactly the bugs the comments around
them describe."

Three named mechanics, zero tests. `../existing-checks.md:124` records
`frame_read` at **0** tests and `:214` states its three loops are exercised only
indirectly. Confirmed: `frame_read.rs` has no `#[cfg(test)]` module and no
`#[test]` anywhere in its 125 lines.

### O2. Cancellation precedence is real, and no in-crate test ever exercises it

All three helpers open their read select with `biased;`:
`frame_read.rs:47-49`, `:81-83`, `:111-113`. In each, the first branch is
`() = cancel.cancelled() => return Err(ReadStop::Cancelled)` and the second is
the `timeout_at(deadline, ...)` read. `biased` polls branches in declaration
order, so when both a cancellation and a completed read are ready, cancellation
wins deterministically.

Without `biased`, tokio's `select!` picks a random ready branch. The read branch
would then win about half the time, consume bytes, and let the loop continue —
so a cancelled `read_exact` could still return `Ok(())`, and the host would
admit and charge a frame on a generation that is already retiring. That is the
failure the bias prevents, and it is adjacent to but not covered by
[a-retired-generation-emits-nothing-and-mutates-nothing](../catalog.md#a-retired-generation-emits-nothing-and-mutates-nothing),
which is about the emit and charge paths after cancel, not about the read loop
that feeds them.

The production cancellation sources exist and fire while a read is in flight:
`connection.rs:305` after the read task returns, `runtime.rs:1160` in the
shutdown sequence (cancel, then close and wait the read tasks), and
`runtime.rs:431` in the runtime's `Drop`. The token passed to the channel is
`gen.token.child_token()` (`connection.rs:176`, forwarded at `:185`), so a
generation retirement also cancels reads.

**Verified: no in-crate test in `mc-host` ever cancels a token while a
`frame_read` helper is running.** The evidence, exhaustively:

- `tcp_frame_channel.rs`'s test module is `:512-1155`, 24 `#[tokio::test]`
  functions. Twelve of them reach a read path, and each constructs a fresh
  `CancellationToken::new()` and passes it by reference: `:566`, `:583`, `:602`,
  `:623`, `:654`, `:685`, `:711`, `:733`, `:783`, `:817`, `:843`, `:906`,
  `:948`. `awk 'NR>=512 && /cancel/'` over that module returns only those
  constructions, the `&cancel` argument sites, and three
  `assert!(generation.is_cancelled())` lines at `:1094`, `:1122`, `:1151` that
  assert on the *writer's* generation token after a write failure. There is no
  `.cancel()` call on a read token anywhere in the module.
- `client.rs`'s test module is `:2401-4228`. Exactly two tests call
  `read_active_frame`: `:3650` and `:3683`. Both use the `test_inner` helper
  (`:2406-2440`), whose `cancel` field is a fresh `CancellationToken::new()`
  (`:2421`), and neither cancels or retires it.
- The `client.rs` tests that *do* cancel the token are the eleven
  `inner.retire("test_done")` calls (`retire` cancels at `:1681`) plus the
  direct `inner.cancel.cancel()` at `:2646`. None of them has a read in flight:
  `:2646` exists to stop a `writer_loop` whose socket read half is bound to
  `_read` and never fed to a reader, and no in-crate test spawns `reader_loop`
  at all (`awk 'NR>=2401 && /reader_loop/'` over `client.rs` returns nothing).

So the precedence is exercised only incidentally, by integration tests that
shut a real host down while a reader is parked. Those assert nothing about
precedence, and per `../existing-checks.md` the largest of them
(`tests/lifecycle.rs`) runs in no CI job.

### O3. The body read's loop condition and its cap disagree

`read_body` (`frame_read.rs:69-94`) is the only helper whose completion test is
not expressed in bytes consumed:

```rust
let mut limited = reader.take(len as u64);   // :79  caps bytes READ at len
while buf.len() < len {                       // :80  tests bytes IN THE BUFFER
```

The cap at `:79` limits the total bytes drawn through `limited` to `len`, which
is what makes the frame boundary safe: a pipelined next header physically cannot
be read as this frame's body no matter what the loop does. The doc at
`frame_read.rs:63-68` states exactly this and it is correct.

But `:80` measures `buf.len()`, which is the buffer's *absolute* length, not the
bytes this call consumed. With an incoming `buf` already holding `k > 0` bytes,
the loop stops once `buf.len() >= len`, having appended only `len - k` bytes. It
returns `Ok(())` with `k` of the frame's body bytes still on the wire, where the
next `read_frame` parses them as a header. The returned buffer is also wrong: it
is `k` stale bytes followed by `len - k` body bytes. With `k >= len` the loop
never runs and the call consumes nothing at all. Both are silent successes.

Both callers pass a freshly allocated empty vector, so `k` is always 0 today:
`tcp_frame_channel.rs:217` (`let mut body = Vec::with_capacity(header.len as usize);`,
used at `:219`) and `client.rs:2003` (`let mut body = Vec::with_capacity(len);`
inside the wrapper itself, so the client cannot pass a dirty buffer even by
mistake). That makes this `always-or-unreached`: safe today, and the signature
invites the unsafe call.

Note the asymmetry worth recording: the client's wrapper owns the allocation and
therefore cannot be misused; the host's wrapper takes `buf: &mut Vec<u8>`
(`tcp_frame_channel.rs:264-277`) and forwards it, so the host's call site is
where a future caller could pass a partially filled buffer.

### O4. Zero-length reads mean EOF in all three helpers, and that is unambiguous

`frame_read.rs:55-57`, `:89-91`, and `:119-121` each convert `read == 0` into
`ReadStop::Eof` rather than looping. Each is reached only with a non-empty
target: `read_exact` guards `filled < buf.len()` at `:46`, so `buf[filled..]` is
non-empty; `drain` guards `remaining > 0` at `:109` and clamps `want` at `:110`,
so `want >= 1`.

`read_body` is the one that needs an argument, because `read_buf` can return
`Ok(0)` for reasons other than EOF. Two were checked against the pinned
dependency versions (`Cargo.lock`: tokio 1.53.1, bytes 1.12.1):

1. *No spare capacity.* tokio's `ReadBuf::poll` returns `Ok(0)` early when
   `!buf.has_remaining_mut()` (`tokio-1.53.1/src/io/util/read_buf.rs:46-48`).
   For `Vec<u8>`, `bytes`' impl reports `remaining_mut() = isize::MAX - len`
   and `chunk_mut` calls `self.reserve(64)` when `capacity() == len()`
   (`bytes-1.12.1/src/buf/buf_mut.rs:1599-1636`). So a `Vec` never reports zero
   remaining at any realistic length, and the vector grows rather than
   returning a false EOF.
2. *Take limit exhausted.* `Take::poll_read` returns `Ok(0)` once `len` bytes
   have passed. With `buf` starting empty that happens exactly when
   `buf.len() == len`, at which point `:80` has already exited the loop. In the
   unreached non-empty case of O3 the loop exits even earlier. So the take limit
   is never exhausted while the loop is still running, in either case.

So `read == 0` at `:89` is EOF, and it is not a coincidence: it depends on the
`bytes` `BufMut for Vec<u8>` growth behaviour. If the buffer type ever changed
to one with fixed remaining capacity, `:89` would silently reclassify "buffer
full" as "peer closed".

The wrong choice here is worth naming precisely. Looping on a zero read would
not hang: a closed stream returns `Ok(0)` immediately and forever, so the loop
would spin hot on the CPU until `timeout_at` fired, then report
`DeadlineExpired`. The host would map that to
`Corrupt("frame deadline expired")` instead of `Corrupt("EOF inside frame")`
(`tcp_frame_channel.rs:284-287`), so an orderly mid-frame close would be
misreported as a slow peer after burning a full frame deadline of CPU. This is
the one mechanic with real existing coverage: see O7.

### O5. No helper keeps an offset, so a stopped read cannot be resumed

Each helper's progress lives in a local: `filled` in `read_exact`
(`frame_read.rs:45`), the caller's `buf` in `read_body`, and `remaining` in
`drain` (`frame_read.rs:108`). On any `Err`, `read_exact` and `drain` discard
their locals; `read_body` leaves the partial bytes in the caller's buffer with
no record of how many belong to this frame. Nothing in the module records a
stream offset. The `Take` wrapper at `frame_read.rs:79` is rebuilt on every call,
so even its residual limit is lost.

Therefore a second framed read on the same reader after a stop would begin
mid-frame. The module doc at `frame_read.rs:5-8` assigns the policy to the
callers ("whether a short read is corruption or an orderly close, stays with
each caller") but never states the obligation itself. Both callers do satisfy
it, verified:

- **Host.** `read_loop` (`connection.rs:382-415`) matches `channel.recv()` and
  every `Err` arm returns: `ReadClose::Cancelled` at `:400`,
  `RejectedDrainFailed` at `:401-410`, and `CleanEof | Corrupt(_) | Io(_) |
  Overloaded` at `:411-414`. There is no `continue`. The four arms are
  exhaustive over `ReadClose`, so a new variant cannot be added without a
  compile error, which makes the obligation structurally enforced rather than
  conventional.
- **Client.** `reader_loop` (`client.rs:1890-1908`) breaks on `Err(())` at
  `:1897-1900` after `inner.retire("protocol_violation")`, and also breaks on
  `Ok(None)` (clean EOF) at `:1894-1897`.

One residual hazard, at the transport layer rather than the caller: `recv`
(`tcp_frame_channel.rs:96-131`) takes `pending_drain` at `:97` before running
the drain, so a failed drain clears the pending state. If any future caller
retried `recv` after `Err(RejectedDrainFailed)` it would read a misaligned
stream with no pending drain left to realign it. `connection.rs:401-410` is the
only thing preventing that.

### O6. The oversize-control drain charges no ingress budget, and nothing states what bounds it

The path, in order:

1. `read_frame` returns `ReadEvent::OversizeControl` from the header alone when a
   channel-0 `Request` declares more than `MAX_CONTROL_BODY_LEN`
   (`tcp_frame_channel.rs:198-202`). This is *before* the budget charge at
   `:204-215`, so no ingress permit is ever acquired.
2. `recv` stores a `PendingDrain` and returns `InboundEvent::Rejected`
   (`:123-129`).
3. The next `recv` runs `drain_declared_body` first (`:97-112`) under the
   rejected frame's own absolute deadline, then reads the next frame.

The declared length is bounded above by `MAX_BODY_LEN`, not by the control cap:
`validate_inbound_header` (`frame_channel.rs:58-61`) rejects only
`len > MAX_BODY_LEN`, and it runs at `tcp_frame_channel.rs:196`, before the
oversize branch. `MAX_BODY_LEN = MAX_FRAME_BODY_LEN = 64 * 1024 * 1024`
(`wire.rs:35`, `:371`) and `MAX_CONTROL_BODY_LEN = 65_536` (`wire.rs:374`). So
one oversize control declaration can force the host to read and discard up to
**64 MiB** while holding zero ingress budget, not the control cap. The gap
description's "up to the control cap" understates it; the control cap is the
floor that triggers the branch, not the ceiling on the work.

What actually bounds it:

- **Per frame: the absolute frame deadline.** `deadline` is set once at
  `tcp_frame_channel.rs:169` as `Instant::now() + frame_deadline` from the first
  header byte, and the same value is carried into `PendingDrain` at `:126` and
  spent by the drain. Default `frame_deadline` is 30 s (`config.rs:224`). The
  drain's effective window is smaller than that, because the header read and
  the engine's rejection emission consume part of it first.
- **Per host: the connection permit semaphore.** `run_connection` acquires from
  `shared.connection_permits` at `connection.rs:165-169`, a
  `Semaphore::new(config.limits.max_connections)` (`runtime.rs:890`, field at
  `:123`), default 64 (`config.rs:129`). So at most 64 of these loops run
  concurrently.
- **Per generation, but only over the emissions:** the rejection emission
  acquires from `gen.busy_rejects` at `connection.rs:443-447` and retires the
  generation on exhaustion. `MAX_INFLIGHT_BUSY_REJECTS = 32`
  (`connection.rs:53`). The comment at `connection.rs:437-442` says this
  semaphore "is what bounds these emissions" and that is accurate, but the
  permit releases when the emission completes, so it bounds concurrently
  unwritten rejections and not the reject-then-drain cycle rate. Nothing
  acquires a permit for the drain itself.
- **Per frame, the correlation watermark.** `connection.rs:426-429` closes the
  generation unless each `Request` correlation strictly increases, so the frames
  must be distinct. `u64` makes that no practical limit.

Per-cycle work is bounded and allocation-free: 8 KiB of stack scratch reused per
iteration (`frame_read.rs:107`), so the cost is one `memcpy` per 8 KiB and no
heap traffic. But the reject-then-drain cycle is serialized per connection with
nothing throttling its repetition, so the aggregate bound is link bandwidth and
the deadline, which is precisely the quantity the ingress byte budget
(`wire.rs:385-397`) exists to bound for every other body.

None of this is stated anywhere. What *is* documented is the deliberate design
goal, in three places: `tcp_frame_channel.rs:42-46` ("the next `recv` drains
them under the rejected frame's own absolute deadline"), `:199-200` ("The header
alone proves the violation; never buffer the body"), and the assertion at
`:803-807`, "an oversize declaration must never hold ingress budget". The
zero-budget property is intended and tested. Its cost, and what replaces the
budget as the bound, is not written down.

One observability gap falls out of the same reading: `drain` never touches the
`CopyCounter`. `record_copy` is called only at `frame_channel.rs:376` (inside
`InboundFrame::contiguous`) and `shm_provider.rs:611`, and a drained body never
constructs an `InboundFrame`. So drained bytes are invisible to the only
transport-byte counter in the crate.

### O7. Existing coverage, precisely

Three in-crate tests reach `frame_read`'s EOF branches through the host wrapper,
and one reaches the drain:

| Test | Line | Reaches |
| --- | --- | --- |
| `eof_after_first_header_byte_is_corruption` | `tcp_frame_channel.rs:580-597` | `read_exact` EOF, but asserts only `Corrupt(_)` at `:596` |
| `eof_inside_a_declared_body_is_corruption` | `:599-618` | `read_body` EOF, asserts the exact string `Corrupt("EOF inside frame")` at `:617` |
| `receiver_reports_failed_drain_as_rejected_drain_failure` | `:810-834` | `drain` EOF via a truncated body, asserts `RejectedDrainFailed` |
| `drain_discards_exactly_declared_bytes_and_realigns` | `:730-770` | `drain` success plus realignment, via a following `Goodbye` |
| `receiver_reports_rejection_then_drains_without_allocation_and_realigns` | `:772-808` | the full reject-then-drain cycle, with the zero-budget assertion at `:803-807` |

The strongest of these is `:617`: asserting the exact `"EOF inside frame"`
string does discriminate the EOF mechanic, because a looping implementation
would produce `"frame deadline expired"` instead. `:596` does not discriminate,
because `Corrupt(_)` accepts both.

Nothing reaches cancellation precedence (O2), nothing reaches the non-empty
buffer case (O3), and nothing tests the helpers directly.

### O8. The client's budget-refusal drain call is unreachable

`client.rs:1970-1973` drains and fails when `read_budget.charge` refuses. The
comment at `:1965-1969` claims this can never fire: "The reservation covers the
framing maximum and belongs to the reader alone... A refusal here therefore
means the header declared more than the framing maximum, which
`validate_inbound` has already rejected — it survives only as the structural
guard for that invariant."

Per rule 3 of `../../METHOD.md` that is a claim, not a fact. It checks out, on four
verified steps:

1. The cap equals the framing maximum:
   `CLIENT_INBOUND_FRAME_BYTES = MAX_BODY_LEN as usize` (`client.rs:88`), and the
   counter is built with it at `:403` and `:2429`.
2. `validate_inbound` rejects `header.len > MAX_BODY_LEN` at `:2040`, and it runs
   at `:1957`, before the charge at `:1970`.
3. `ByteCounter::charge` refuses only on `checked_add` overflow or
   `used + bytes > cap` (`:1770-1781`). So a refusal needs `used > 0`.
4. `used` is zero at every read. The charge is created at `:1970`, moves into
   `InboundFrame` at `:1975-1979`, and is consumed by `dispatch` at `:1393`,
   which runs synchronously in `reader_loop` at `:1903` before the next read.
   Every `dispatch` arm releases it: explicit `drop(charge)` at `:1433`
   (terminals) and `:1530` (stream data), and ownership drop at function exit
   for the `Ping`, `Goodbye`, `Push`, and early-`return` arms (`:1431`, `:1479`).
   Retained stream bytes are charged to the separate `retained_budget`
   (`:1523`), which the comment at `:956-961` documents as the reason for the
   split.

So `drain_until` has exactly one call site and that site cannot execute. Two
consequences: `drain_until`'s own doc claim at `client.rs:2010-2011` (the
failure "is reported against a stream still aligned on a header boundary")
describes a realignment no code depends on, and even if it fired,
`read_active_frame` returns `Err(())` immediately after, which retires the
connection at `client.rs:1897-1899` — so the realignment would be discarded
anyway. It is a guard, correctly labelled as one, whose *value* is entirely as a
tripwire for step 4 breaking.

## Records

Six records, in the METHOD.md schema, ready for synthesis into `catalog.md`.
Their `[evidence](evidence/<slug>.md)` links are written catalog-relative, so
they resolve once transplanted to `catalog.md` at the part root; from this file
they need one `../`. Every evidence file exists at
`../evidence/<slug>.md` today.

### cancellation-preempts-every-bounded-frame-read

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no in-crate test cancels a token while any `frame_read`
helper is running, so the precedence branch has no oracle anywhere. Integration
shutdown tests execute it incidentally and assert nothing about it.
Guarantee: When a bounded frame read's cancellation token is cancelled, the read
returns `ReadStop::Cancelled` and performs no further read, even when input
bytes are simultaneously available.
Check: `always` — with the token cancelled and a full read's worth of bytes
already buffered on the reader, each of `read_exact`, `read_body`, and `drain`
returns `Err(ReadStop::Cancelled)`, and the reader's unconsumed byte count is
unchanged. `always`, not `always-or-unreached`: cancellation fires on every
production shutdown and every generation retirement, so this is evaluated on
ordinary paths rather than on an optional one. Assert the byte count, not just
the return value, because a `Cancelled` return after a completed read is the
defect and the return value alone cannot see it.
Fault/timing angle: the window is exactly one `select!` poll in which both the
token and the read are ready. Under `biased` that is deterministic; without it,
tokio picks a random ready branch, so the defect appears about half the time per
iteration and a multi-iteration `read_exact` almost surely completes and returns
`Ok(())` on a cancelled generation.
Required faults and enabling state: a reader with bytes buffered and ready, plus
a token cancelled before the poll. Both are constructible with
`tokio::io::duplex`: write the bytes, cancel the token, then call the helper. No
scheduler control is needed because the ordering is established before the call.
Confidence: high — [evidence](evidence/cancellation-preempts-every-bounded-frame-read.md).
Verified the `biased;` keyword and branch order at `frame_read.rs:47-49`,
`:81-83`, `:111-113`; the production cancellation sources at `connection.rs:305`,
`runtime.rs:1160`, and `runtime.rs:431`; and by exhaustive `awk` over both test
modules that no in-crate test cancels a read token.
Existing check: none. The 24 tests in `tcp_frame_channel.rs:512-1155` and the two
`read_active_frame` tests at `client.rs:3650` and `:3683` all construct a fresh
`CancellationToken::new()` and never cancel it.
Impact: a retiring generation keeps consuming frames. Each completed read admits
a frame and charges the ingress budget on a generation the host has already
decided to stop, which contradicts
[a-retired-generation-emits-nothing-and-mutates-nothing](../catalog.md#a-retired-generation-emits-nothing-and-mutates-nothing)
on the read side, and delays shutdown by up to one frame deadline per admitted
frame.
Open questions: None.

### a-body-read-consumes-exactly-the-declared-frame-boundary

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test passes a non-empty buffer, and no test asserts the
consumed-byte count rather than the buffer contents.
Guarantee: A successful `read_body(reader, buf, len, ..)` consumes exactly `len`
bytes from the reader: never more, so a pipelined next header cannot be read as
this frame's body, and never fewer, so the stream stays aligned.
Check: `always-or-unreached` — for an empty `buf`, assert both that
`buf.len() == len` and that exactly `len` bytes were consumed from the reader,
with a following pipelined header still intact and readable. For a non-empty
`buf` holding `k` bytes, either the call consumes `len` bytes or it must not
return `Ok`. `always-or-unreached` because both current call sites allocate a
fresh empty vector immediately before calling
(`tcp_frame_channel.rs:217`, `client.rs:2003`), so the non-empty case is
unreached today while remaining callable through the host's forwarding wrapper
at `tcp_frame_channel.rs:264-277`.
Fault/timing angle: none for the over-read direction; the `take` at
`frame_read.rs:79` makes it physically impossible. The under-read direction has
no timing window either. It is a pure precondition: the loop at
`frame_read.rs:80` tests `buf.len() < len`, an absolute buffer length, while the
cap at `:79` counts bytes read, so any non-empty incoming buffer makes the two
disagree and the call under-reads by exactly `k`, returning `Ok(())`.
Required faults and enabling state: no fault. Call `read_body` directly with a
buffer pre-filled with `k` bytes, `0 < k < len`, and a reader holding `len` body
bytes followed by a valid header. The observable is that the header no longer
parses on the next read.
Confidence: high — [evidence](evidence/a-body-read-consumes-exactly-the-declared-frame-boundary.md).
The cap and the loop condition were read at `frame_read.rs:79-80`; the
freshness of both callers' buffers was verified at `tcp_frame_channel.rs:217`
and `client.rs:2003`; the `take` semantics were confirmed against tokio 1.53.1.
Existing check: partial and indirect.
`tcp_frame_channel.rs:836-896`, `fragmented_and_coalesced_frames_preserve_alignment`,
proves alignment survives fragmentation and coalescing for empty buffers, which
covers the over-read direction end to end. Nothing covers the non-empty case.
Status unaudited.
Impact: silent stream desynchronization with an `Ok` return. `k` body bytes are
parsed as the next header, so a peer's body content chooses the host's next
header, and the frame handed up contains `k` bytes that are not its body.
Open questions:
- Should `read_body` take `&mut Vec<u8>` at all? The client wrapper already owns
  its allocation (`client.rs:2003`), so only the host's forwarding wrapper needs
  the out-parameter. Either clearing `buf` on entry, asserting `buf.is_empty()`,
  or returning an owned `Vec` would make the disagreement unrepresentable rather
  than merely unreached. (needs human input)

### a-zero-length-read-ends-the-read-instead-of-looping

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `read_body`'s EOF is proven by an exact-string assertion,
`read_exact`'s only by a wildcard that cannot discriminate the defect, and
`drain`'s only through the `RejectedDrainFailed` mapping.
Guarantee: A read returning zero bytes with the target unfilled terminates the
helper as `ReadStop::Eof` rather than continuing the loop.
Check: `always` — for each of the three helpers, close the peer mid-target and
assert the helper returns `Err(ReadStop::Eof)` promptly, well inside the
deadline. Assert the deadline is *not* consumed, because that is what separates
this property from a looping implementation: both return an error, and only the
timing and the error class distinguish them. `always`, since every orderly
mid-frame peer close reaches it.
Fault/timing angle: the whole property is about timing. A looping
implementation does not hang: a closed stream returns `Ok(0)` immediately and
forever, so it would spin hot until `timeout_at` fired and then report
`DeadlineExpired`, mapped by the host to `Corrupt("frame deadline expired")`
instead of `Corrupt("EOF inside frame")` (`tcp_frame_channel.rs:284-287`). So a
correct diagnosis costs a full frame deadline of spun CPU when it is wrong.
Required faults and enabling state: a mid-target peer close, three times: after
one header byte (`read_exact`), after a partial declared body (`read_body`), and
after a partial drained body (`drain`). All three are one `drop(client)` on a
`tokio::io::duplex` pair.
Confidence: high — [evidence](evidence/a-zero-length-read-ends-the-read-instead-of-looping.md).
Read the three `if read == 0` sites at `frame_read.rs:55-57`, `:89-91`,
`:119-121`, and verified the non-empty-target guards at `:46`, `:109-110`. The
`read_body` case needed dependency evidence, since `read_buf` has two other
`Ok(0)` causes: both were ruled out against `tokio-1.53.1/src/io/util/read_buf.rs:46-48`
and `bytes-1.12.1/src/buf/buf_mut.rs:1599-1636` at the versions pinned in
`Cargo.lock`.
Existing check: three tests, of unequal strength.
`tcp_frame_channel.rs:599-618` asserts the exact string
`Corrupt("EOF inside frame")` and does discriminate a looping `read_body`.
`:580-597` asserts only `Corrupt(_)`, which a looping `read_exact` would also
satisfy. `:810-834` covers `drain` through `RejectedDrainFailed`, which
collapses every stop class into one variant (`connection.rs:401-410`) and so
cannot discriminate either. Status unaudited.
Impact: a hot spin for the whole frame deadline on every orderly mid-frame
close, plus a close reason that blames a slow peer for a clean disconnect.
Open questions:
- `read_body`'s EOF detection depends on `bytes`' `BufMut for Vec<u8>` growing
  on demand. Should that dependency be pinned by a comment or an assertion at
  `frame_read.rs:89`? A buffer type with fixed remaining capacity would silently
  reclassify "buffer full" as "peer closed". (needs human input)

### no-framed-read-resumes-after-a-read-stop

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the host's obligation is structurally enforced by an
exhaustive match, which is stronger than a test; the client's is enforced by
code inspection only, and no test drives a stop and then attempts a second read.
Guarantee: After any `ReadStop`, no caller performs another framed read on the
same reader. All three helpers abandon partially consumed frames and keep no
offset, so a resumed read would begin mid-frame.
Check: `always` — for every `Err` exit of the host's `recv` and the client's
`read_active_frame`, the enclosing loop terminates without calling the reader
again. The compile-time form is stronger and already present on the host side:
the `ReadClose` match at `connection.rs:398-415` is exhaustive with every arm
returning, so a new variant cannot be handled by falling through. `always`
rather than `unreachable`, because the forbidden thing is a *state* (a second
read after a stop) reached from many call sites, not one code location.
Fault/timing angle: the sharpest case is the transport layer rather than a
caller. `recv` takes `pending_drain` at `tcp_frame_channel.rs:97` before running
the drain, so a failed drain both leaves the stream misaligned and clears the
state that would realign it. A retry of `recv` after `Err(RejectedDrainFailed)`
would read body bytes as a header with no pending drain left.
`connection.rs:401-410` is the only thing preventing that.
Required faults and enabling state: any stop class, then an attempted second
read. Cheapest construction: a truncated declared body for EOF, a paused clock
for the deadline, a cancelled token for cancellation.
Confidence: high — [evidence](evidence/no-framed-read-resumes-after-a-read-stop.md).
Verified that no helper retains an offset (`frame_read.rs:45`, `:79`, `:108`),
and that both callers stop: the host's four exhaustive `Err` arms at
`connection.rs:400`, `:401-410`, `:411-414`, and the client's `break` at
`client.rs:1897-1900` plus its clean-EOF `break` at `:1894-1897`.
Existing check: `connection.rs:398-415` is a production structural guard rather
than a test, and covers the host completely. The client has neither a test nor a
guard, only `reader_loop`'s shape. Status unaudited.
Impact: a resumed read parses body bytes as a header. Every downstream identity
decision — correlation, channel, epoch, frame type — is then made from
attacker-chosen bytes on a stream the host believes is aligned.
Open questions:
- The obligation is not written down. `frame_read.rs:5-8` assigns short-read
  *policy* to the callers but never states that no resume is permitted. Should
  the module doc state it, given that the type system cannot?
  (needs human input)

### oversize-control-drain-work-is-bounded-without-ingress-budget

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the zero-budget property is asserted, its cost bound is
not. `tcp_frame_channel.rs:803-807` proves an oversize declaration holds no
ingress budget; nothing bounds how much read-and-discard work one peer can
provoke.
Guarantee: An early-rejected oversize control frame is drained without charging
the ingress byte budget, and the work it costs is bounded by the rejected
frame's own absolute frame deadline, by the connection permit semaphore, and by
nothing else.
Check: `always` — across a sustained reject-then-drain cycle, the ingress
budget's available permits return to their starting value after every cycle
(the intended property, already asserted once), and each drain completes or
fails within the deadline armed at the rejected frame's first header byte. State
the bound in the units the code bounds: the absolute deadline from
`tcp_frame_channel.rs:169`, carried into `PendingDrain` at `:126`, default 30 s
(`config.rs:224`); and `max_connections` concurrent loops, default 64
(`config.rs:129`, `runtime.rs:890`). Do not assert a byte-rate ceiling, because
there is none.
Fault/timing angle: the deadline is armed at the *first header byte*, not at the
drain's start, and is spent by the header read and by the engine's rejection
emission before the drain begins (`connection.rs:433-462` spawns the emission
between the two `recv` calls). So a host slow to emit shortens its own drain
window and converts the drain into `RejectedDrainFailed`, which closes the
generation. That makes the loop self-limiting under host slowness but not under
host health.
Required faults and enabling state: a peer sending channel-0 `Request` headers
with strictly increasing correlations (`connection.rs:426-429`) declaring
`len > MAX_CONTROL_BODY_LEN`, each followed by the declared bytes, repeated. To
observe the aggregate, run `max_connections` of them.
Confidence: high on the mechanism, medium on whether the cost is a defect —
[evidence](evidence/oversize-control-drain-work-is-bounded-without-ingress-budget.md).
Verified that the oversize branch at `tcp_frame_channel.rs:198-202` precedes the
budget charge at `:204-215`; that the ceiling is `MAX_BODY_LEN` and not the
control cap, because `validate_inbound_header` (`frame_channel.rs:58-61`) runs
first at `:196` (`wire.rs:35`, `:371`, `:374`); and that the only permits in the
path are `connection_permits` (`connection.rs:165-169`) and `busy_rejects`
(`:443-447`, cap 32 at `:53`), the latter bounding the emissions rather than the
drain, exactly as its comment at `:437-442` says.
Existing check: `tcp_frame_channel.rs:772-808` covers one reject-then-drain cycle
and asserts the zero-budget property at `:803-807` with a deliberately tiny
budget. `:730-770` covers realignment. Neither repeats the cycle, and no check
bounds the cost. Status unaudited.
Impact: a peer can force up to 64 MiB of read-and-discard per frame per
connection, and up to `max_connections` of those concurrently, while holding no
resident-byte budget. Those bytes are also unobserved: `drain` never touches the
`CopyCounter`, whose only producers are `frame_channel.rs:376` and
`shm_provider.rs:611`, so no counter in the crate sees them.
Open questions:
- Is the unbudgeted cost acceptable, or should the drain hold a nominal charge
  or a dedicated permit? The zero-budget property is deliberate and correct as a
  *resident-memory* property (never buffer the body); the open question is
  whether the same reasoning should extend to the bandwidth and CPU the discard
  costs. (needs human input)
- Should the reject-then-drain cycle be counted? The gap here is a missing
  bound, and today no signal would show the loop running at all.
  (needs human input)

### the-client-body-budget-refusal-drain-is-never-entered

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — nothing observes the branch, so it could start firing
without notice.
Guarantee: The client's inbound read reservation is exclusively the reader's and
sized to the framing maximum, so the budget-refusal branch at
`client.rs:1970-1973` never executes.
Check: `unreachable` — the `else` arm at `client.rs:1970` must not be entered.
`unreachable` and not `always(!X)` because this is one specific code location
with a natural detection point, exactly the case the semantics table reserves
`unreachable` for. Entering it means the reservation is no longer
reader-exclusive: either a `ByteCharge` outlived its `dispatch` call, or the cap
and `MAX_BODY_LEN` diverged. A `debug_assert!(false)` or a counter on that arm
is the whole check.
Fault/timing angle: none today. The reservation is released synchronously inside
`dispatch` before the next read (`client.rs:1393` called from `:1903`), so no
interleaving can leave `used > 0` at a read. The branch becomes reachable the
moment a `dispatch` arm retains a read charge across an await, or a stream item
borrows the read charge instead of `retained_budget` (`:1523`).
Required faults and enabling state: to *prove* unreachability, none: it follows
from the four verified steps in the evidence. To detect a regression, instrument
the arm and run the ordinary inbound suite.
Confidence: high — [evidence](evidence/the-client-body-budget-refusal-drain-is-never-entered.md).
Verified all four steps the claim rests on: the cap equals the framing maximum
(`client.rs:88`, `:403`); `validate_inbound` rejects a larger `len` first
(`:2040`, called at `:1957`); `ByteCounter::charge` refuses only when
`used > 0` or on overflow (`:1770-1781`); and `used` is zero at every read
because every `dispatch` arm releases the charge (`:1433`, `:1530`, and
ownership drop at `:1431`, `:1479`, and function exit) while retained stream
bytes go to `retained_budget` (`:1523`, documented at `:956-961`).
Existing check: none. The comment at `client.rs:1965-1969` states the invariant
in prose and correctly labels the branch as a structural guard, but nothing
enforces or observes it.
Impact: low today and that is the finding. Two dead claims hang off it:
`drain_until`'s doc at `client.rs:2010-2011` promises a realignment that no code
consumes, and even if the branch fired, `read_active_frame` returns `Err(())`
immediately after, which retires the connection at `:1897-1899` and discards the
realignment. If the branch ever does fire it signals a real regression in the
reader-exclusive reservation, and nothing would report it.
Open questions:
- Should the branch keep its drain, or return the error directly? The drain's
  only stated purpose is a realignment the sole caller discards. Removing it
  would delete the client's only `frame_read::drain` call site and make the
  guard a bare error return. (needs human input)
