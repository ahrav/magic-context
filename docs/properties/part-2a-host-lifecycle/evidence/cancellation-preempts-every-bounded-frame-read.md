# cancellation-preempts-every-bounded-frame-read

## Discovery trigger

`frame_read.rs:10-15` names the `biased` select as the first of three mechanics
that justify single-sourcing the module: "the `biased` select that prefers
cancellation over another read". Gap G2 in `../portfolio-evaluation.md` flagged
the module as 125 lines of shared host-and-client code with zero tests. The
question this record answers is whether the precedence is load-bearing, and
whether anything checks it.

## Evidence trail

All references at `1c193ae0`. `git diff --stat d90e7811 HEAD` over the cited
files is empty, so these lines are unchanged since the catalog's stated commit.

The mechanism, in all three helpers:

- `read_exact`, `frame_read.rs:47-54`. `biased;` at `:48`, then
  `() = cancel.cancelled() => return Err(ReadStop::Cancelled)` at `:49`, then
  the `timeout_at(deadline, reader.read(&mut buf[filled..]))` branch at `:50`.
- `read_body`, `frame_read.rs:81-88`. `biased;` at `:82`, cancellation at `:83`,
  `timeout_at(deadline, limited.read_buf(buf))` at `:84`.
- `drain`, `frame_read.rs:111-118`. `biased;` at `:112`, cancellation at `:113`,
  `timeout_at(deadline, reader.read(&mut scratch[..want]))` at `:114`.

`biased` makes `select!` poll branches in declaration order instead of a random
order, so a ready cancellation always beats a ready read.

The same pattern appears in both callers' own first-byte selects, which are
outside this module but establish that the convention is deliberate rather than
incidental: `tcp_frame_channel.rs:160-164` and `client.rs:1922-1926`.

Production cancellation sources, all reaching the token these helpers hold:

- `connection.rs:176` derives `read_cancel` as `gen_token.child_token()` and
  `:185` passes it to `TcpFrameChannel::start`, which stores it as `self.cancel`
  (`tcp_frame_channel.rs:71`, `:86`). So a generation retirement cancels reads.
- `connection.rs:305`, `gen.read_cancel.cancel()` immediately after the read
  task returns.
- `runtime.rs:1160`, the shutdown sequence: `gen.read_cancel.cancel()` for every
  registered generation, then `read_tasks.close()` and `wait()`.
- `runtime.rs:431`, the runtime's `Drop`: the same cancel for every generation.

On the client side the token is `Inner::cancel` (`client.rs:946`), cancelled by
`Inner::retire` at `:1681` and reached by `read_active_frame` at `:1943`,
`:1953`, `:1971`, `:1974`.

Coverage, established by exhaustive search rather than sampling:

- `tcp_frame_channel.rs:512-1155` is the test module, 24 `#[tokio::test]`
  functions. `awk 'NR>=512 && /cancel/'` over the file returns exactly: the
  `receiver_over` helper's `cancel` parameter (`:549`, `:556`), thirteen
  `CancellationToken::new()` constructions (`:566`, `:583`, `:602`, `:623`,
  `:654`, `:685`, `:711`, `:733`, `:783`, `:817`, `:843`, `:906`, `:948`), the
  `&cancel` argument sites, and three `assert!(generation.is_cancelled())` lines
  at `:1094`, `:1122`, `:1151`. Those three assert on the writer's generation
  token after an induced write failure and involve no read. No `.cancel()` is
  called on a read token.
- `client.rs:2401-4228` is the test module. Exactly two tests call
  `read_active_frame`: `:3650` (`idle_header_is_unbounded_then_partial_frame_has_one_deadline`)
  and `:3683` (`an_unsupported_version_fails_at_the_frozen_prefix`). Both build
  their `Inner` with `test_inner` (`:2406-2440`), whose `cancel` is a fresh
  `CancellationToken::new()` at `:2421`, and neither cancels or retires.
- The `client.rs` tests that do cancel are the eleven `inner.retire("test_done")`
  calls (`:2495`, `:3331`, `:3443`, `:3520`, `:3565`, `:3641`, `:3813`, `:3857`,
  `:3942`, `:4003`, `:4060`, `:4122`) and the direct `inner.cancel.cancel()` at
  `:2646`. None has a read in flight. `:2646` stops a `writer_loop`; that test
  binds the socket's read half to `_read` at `:2634` and never reads from it. No
  in-crate test spawns `reader_loop` at all.

## Failure scenario

Remove `biased;`. `select!` then chooses randomly among ready branches. Take a
retiring generation whose peer has already pipelined a full frame, so the read
branch is ready on every poll and the cancellation branch is ready too.

`read_exact` loops until `filled == buf.len()`. Each iteration has about a 50%
chance of taking the read branch, so a 20-byte header read over several
iterations almost surely completes and returns `Ok(())`. `read_frame` then
proceeds to `validate_inbound_header` at `tcp_frame_channel.rs:196`, charges the
ingress budget at `:204-215`, reads the body, and returns
`ReadEvent::Frame`. `read_loop` (`connection.rs:417`) dispatches it.

So a generation the host has decided to retire admits a frame, charges resident
bytes against the shared ingress budget, and starts work. Repeat per frame while
the peer keeps writing, and shutdown is delayed by up to one frame deadline per
admitted frame.

The `drain` case is quieter but the same shape: a cancelled drain that keeps
draining spends the deadline discarding bytes for a generation that is closing.

## Timing windows and dependencies

One `select!` poll in which both branches are ready. Under `biased` the outcome
is deterministic and no scheduler control is needed to observe it.

The property is independent of the deadline: `timeout_at` wraps only the read
branch, so a cancellation is never subject to it.

Dependency: tokio's documented `biased` semantics (poll in declaration order).
The repo pins tokio 1.53.1 in `Cargo.lock`.

## What a test must construct

Three unit tests directly against `frame_read`, no host and no client:

1. `tokio::io::duplex`; write more bytes than the target needs into the peer
   half so the read is unconditionally ready.
2. `let cancel = CancellationToken::new(); cancel.cancel();` before the call, so
   the ordering is fixed without scheduler control.
3. Call the helper with a far-future deadline. Assert `Err(ReadStop::Cancelled)`.
4. Assert the reader consumed nothing: read from the same reader afterwards and
   check the first byte is the one the peer wrote first. This is the load-bearing
   assertion. A `Cancelled` return *after* a completed read is the defect, and
   the return value alone cannot distinguish the two.

For `read_exact` add a multi-iteration variant: feed the bytes one at a time so
the loop must iterate, cancelling after the first iteration, and assert the
partial `filled` progress is abandoned rather than returned.

This is where the property meets
[no-framed-read-resumes-after-a-read-stop](no-framed-read-resumes-after-a-read-stop.md):
the consumed bytes a cancellation abandons are exactly why no resume is
permitted.

## Investigation log

### Q: Does any in-crate test ever cancel a read token?

- Sources examined: the full `#[cfg(test)]` module of
  `tcp_frame_channel.rs` (`:512-1155`) and of `client.rs` (`:2401-4228`), via
  `awk` over every line containing `cancel`, plus the definition of
  `Inner::retire` at `client.rs:1674-1682` to establish that `retire` cancels.
- Findings: no. Every read-reaching test constructs a fresh token and never
  cancels it. The only cancellations in either module are on the writer path
  (`tcp_frame_channel.rs:1094`, `:1122`, `:1151` assert on the generation token;
  `client.rs:2646` stops a `writer_loop`) or in tests with no reader
  (`client.rs`'s eleven `retire("test_done")` calls).
- Missing evidence: integration tests were not enumerated line by line. They do
  cancel `read_cancel` through the real shutdown path (`runtime.rs:1160`), so
  the branch is executed incidentally there. None of them asserts anything about
  precedence, and `../existing-checks.md` records that the largest of them,
  `tests/lifecycle.rs`, runs in no CI job.
- Conclusion: resolved. No in-crate test cancels a read token. The precedence
  has no oracle anywhere in the repository, only incidental execution.
