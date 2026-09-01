# retirement-discards-only-through-the-discard-token

Verified at `1c193ae0`. The catalog cites `d90e7811`; HEAD moved to the merge
commit `1c193ae0` and `git diff d90e7811 HEAD` is empty for `connection.rs`,
`frame_channel.rs`, `tcp_frame_channel.rs`, and `dispatch.rs`.

## Discovery trigger

`FrameSender` carries four cancellation tokens, not one. Reading which of them the
admission path actually consults shows that `discard()` — the signal retirement
uses to mean "drop what is queued" — is invisible to admission. So the guarantee
"no byte reaches the socket after the close decision" is not enforced where you
would look for it. It is enforced one layer down, in the writer's biased select,
and only because that select checks `discard` before it checks the queue.

## Evidence trail

- `frame_channel.rs:760-767` — `FrameSender`'s fields: `tx`, `retired`,
  `generation`, `discard`, `finish`, `admission_timeout`. Four distinct tokens with
  four distinct meanings; `SenderQueue` at `:838-844` holds the receiver side of the
  same four.
- `frame_channel.rs:774-776` `pub fn discard(&self) { self.discard.cancel(); }` —
  it cancels `discard` and nothing else. `retired` is untouched, so
  `is_retired()` at `:828-830` still returns false after a discard.
- `frame_channel.rs:800-826` `send_ticket_before` — the single admission path
  (`send` at `:779-781` and `send_before` at `:788-796` both delegate to it, each
  labelled "Legacy admission adapter"). Its `tokio::select!` at `:812-825` is
  `biased` and its first arm is `:814`
  `() = self.retired.cancelled() => Err(WriterGone)`. There is no arm for
  `discard` and none for `generation`. **Correction:** the catalog cites
  `:812-825`, which is the select block; the function spans `:800-826` and the gate
  itself is the single line `:814`.
- `frame_channel.rs:820-821` — the only place admission *writes* a token: on an
  admission-deadline expiry it cancels `retired` and `generation` itself.
- `tcp_frame_channel.rs:313-404` `write_frames` is the enforcer. Two biased
  selects, `discard` first in both:
  - `:320-333`, the dequeue select: `:322` `() = discard.cancelled() => break`
    precedes the `finish` arm at `:325` and `queue.recv()` at `:329`. A discard
    observed here exits the loop without dequeuing, so a queued frame is never
    seen.
  - `:366-378`, the mid-write select: `:368` `() = discard.cancelled() => None`,
    which falls into `:379-382` (`retired.cancel()`, `generation.cancel()`,
    `break`). A discard landing while bytes are going out abandons that frame.
  - `:400-403` after the loop: the comment states "Dropping the queue receiver
    here frees any still-queued frames and their charges", then
    `queue.retired.cancel()` at `:402` and `stream.shutdown()` at `:403`.
  **Correction:** the catalog and task brief cite the writer loop as "~305-403";
  the doc comment starts at `:303`, the function at `:313`, and its body ends at
  `:404`.
- `frame_channel.rs:718-730` `begin_publication` — the irreversible boundary, a
  `compare_exchange(QUEUED, PUBLISHED, AcqRel, Acquire)`. Once it succeeds the
  frame is committed to the socket; `FrameSendTicket::cancel` at `:747-755` CASes
  `QUEUED → CANCELLED` and reports `PossibleSend` if it loses.
- The retirement call sites, both two statements: `connection.rs:319-320` (the
  `PeerKeepQueue` arm) and `:329-330` (the silent arm), each
  `gen.token.cancel();` then `gen.writer.discard();`. `dispatch.rs:1371-1376`
  `close_generation` cancels the token only — no discard — which is what lets the
  drain paths flush.
- Existing checks, confirmed: `tcp_frame_channel.rs:1062`
  `stalled_consumer_write_retires_generation_and_frees_charges` and `:1130`
  `writer_failure_retires_generation`. Both drive retirement *from* the writer
  (stall deadline, I/O failure) and assert the generation token ends cancelled.
  Neither admits a frame after an external cancel.

## Failure scenario

The gap is that retirement is two statements, and admission gates on neither of
them:

1. An off-reader producer — a slow handler's response terminal, a capacity
   rejection — passes its precheck (`dispatch.rs:195`, `:267`, `:311`, or `:690`,
   each `if gen.writer.is_retired() || gen.token.is_cancelled()`), then yields on
   the byte-budget charge inside `charge_frame_or_cancel`
   (`dispatch.rs:143-168`).
2. The read loop exits peer-driven. `connection.rs:329` runs
   `gen.token.cancel()`. The producer's `charge_frame_or_cancel` select at
   `:159` observes the generation token and returns `None`, so *that* producer
   fails closed — this is the covered case.
3. The uncovered case is a producer already past its charge and inside
   `send_ticket_before`. `connection.rs:329` has run but `:330` has not. The
   admission select at `frame_channel.rs:814` tests `retired`, which is still
   live; `tx.send` succeeds and the frame is in the queue.
4. The writer is at `tcp_frame_channel.rs:328` awaiting `queue.recv()`. Because
   `discard` has not yet been cancelled, the biased arm at `:320` does not fire; it
   dequeues the frame, `begin_publication` at `:339` CASes `QUEUED → PUBLISHED`,
   and `write_all` at `:367` puts the bytes on the socket.
5. Consequence: one frame reaches a peer after the close decision. For a
   peer-driven exit that is the silent-close violation the wire protocol forbids —
   and for the `PeerKeepQueue` arm it is worse, because `:319-320` promised
   *exactly one* frame and a second has now gone out.

## Timing windows and dependencies

The window is the two statements at `connection.rs:329-330` (and `:319-320`),
which are adjacent non-atomic operations on two independent
`CancellationToken`s, plus whatever the writer task does concurrently on another
core. It is narrow in instructions but entered on every peer-driven close, and it
requires no fault — only that the writer be at `:328` and a producer at `:814` in
the same instant. It is unreachable on a current-thread runtime, which is exactly
why no test sees it (fault class H1). No configuration dependency, though a large
`writer_queue_frames` (`connection.rs:181`) makes it likelier the writer is parked
at `recv()` rather than mid-write. The separate assertion the catalog asks for —
that `token.cancel()` alone does *not* stop queued frames — is confirmed by
`dispatch.rs:1371-1376`: `close_generation` deliberately omits the discard, and
the drain paths depend on that, so a test that strengthens admission to gate on
the generation token would break graceful shutdown. Depends on
`close-disposition-is-a-total-function-of-the-read-exit-cause`, which decides
whether `discard()` is called at all; dominated by nothing.

## What a test must construct

A producer suspended between its cancel precheck and its send, with the cancel
landing in between (fault class H1, plus a scheduling point that does not exist
today). Concretely: a multi-thread runtime; a deterministic yield inserted after
the `retired` check at `frame_channel.rs:814` and before `tx.send`; an off-reader
emission held there; then a peer-driven read exit driven to `connection.rs:329`
and held between the two statements; then release the producer, then release
`:330`. The oracle is on the peer socket, not on internal state: record every byte
the peer receives, and assert that no byte belonging to a frame admitted after
`:329` appears. Assert the same for the `PeerKeepQueue` arm with the stronger
oracle — exactly one frame, and it is the authoritative terminal named by
`reject_written`. A second, cheaper test worth having with no new fault machinery:
call `token.cancel()` without `discard()`, admit a frame, and assert it *does*
reach the socket — that pins the drain dependency so a future "fix" to admission
fails loudly. Coverage checks to emit:
`host_frame_admitted_after_generation_cancel` and
`host_writer_observed_discard_before_dequeue`.

## Investigation log

The catalog records no open question. The claim worth verifying is the one the
record's Fault/timing angle asserts: that admission does not consult the
generation token or `discard`, so the writer is the sole enforcer.

### Q: Is there any path by which a frame admitted after `gen.token.cancel()` is stopped before the socket other than the writer's biased `discard` arm?

- Sources examined: `crates/mc-host/src/frame_channel.rs:758-830` (every
  `FrameSender` method), `:706-756` (the state machine and ticket),
  `:838-854` (`SenderQueue`, which has no `Drop` impl);
  `crates/mc-host/src/tcp_frame_channel.rs:303-400` (the whole writer loop);
  `crates/mc-host/src/dispatch.rs:143-168`, `:195`, `:262-270`, `:306-313`,
  `:686-696`, `:1371-1391`; `crates/mc-host/src/connection.rs:306-332`.
- Findings: three mechanisms can stop an admitted frame, and only one applies
  here. (a) The writer's `discard` arms at `tcp_frame_channel.rs:322` and `:368` —
  the enforcer this record names. (b) `FrameSendTicket::cancel`
  (`frame_channel.rs:747-755`), which needs a caller holding the ticket; the
  retirement path at `connection.rs:329-330` holds none, so it is irrelevant to
  this window. (c) Queue closure — if every `FrameSender` had dropped, `tx.send`
  would fail — but the generation still holds one at `connection.rs:329`, and
  `writer_finish.finish()` is not reached until `:354`. So the answer is no: past
  `frame_channel.rs:814` the writer's biased arm is the only gate, exactly as the
  record states.
- Missing evidence: no executed proof in either direction. The window's existence
  is a reading of two adjacent statements and a biased select, not an observation,
  and there is no failpoint after `:814` and no multi-thread test in scope to
  construct it.
- Conclusion: resolved with answer — admission gates on `retired` alone, `discard`
  is a separate token, and enforcement is downstream in the writer. The residual
  hazard is the non-atomic `cancel()`-then-`discard()` pair, which is unexercised
  and needs H1 plus a scheduling point.
