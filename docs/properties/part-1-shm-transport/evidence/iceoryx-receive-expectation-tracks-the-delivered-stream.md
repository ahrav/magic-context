# iceoryx-receive-expectation-tracks-the-delivered-stream

## Discovery trigger

The ring derives both sequence cursors from shared memory. The producer reads
`published` out of the shared producer page (`ring.rs:679`, `:688-690`) and the
receiver reads `consumed` out of the shared consumer page (`ring.rs:781`,
`:787-789`), so the two sides cannot hold different opinions about where the
stream is. The iceoryx backend keeps both cursors in process-local `Cell<u64>`
fields (`backend/iceoryx.rs:43-44`), initialized to zero at construction
(`:114-115`). Nothing writes them to shared memory and nothing reads a peer's
copy, so the question is what happens when the two counters disagree.

## Evidence trail

- **The cited mechanism is gone.** `0f336d3c` ("refactor(shm): collapse to fixed
  ring transport") deleted `crates/mc-shm-transport/src/backend/iceoryx.rs`,
  `crates/mc-shm-transport/tests/iceoryx.rs`, and the `iceoryx` Cargo feature, so
  `backend/mod.rs` now declares only `ring` and `sample`. Every `iceoryx.rs`
  citation below is kept as a record of what the removed backend did and did not
  guarantee, and resolves against `9c1eb4d1`, not HEAD. No successor backend
  exists in the tree.

- `backend/iceoryx.rs:150-176` `try_receive`. The order matters. `:151-157`
  calls `subscriber.receive()`, which **dequeues** the sample; the binding owns
  it. `:158-162` computes `expected_sequence = next_receive + 1`. `:163` builds
  the expected identity from `self.incarnation` and `self.lane`. `:165-167`
  snapshots and validates, mapping any `DescriptorError` to
  `IceoryxError::InvalidDescriptor`. `:168` advances `next_receive` — **after**
  the `?`. So a rejected sample is consumed and dropped while the expectation
  stays where it was.
- `backend/sample.rs:100-102` — the sequence comparison that fires on a gap:
  `self.identity.sequence() != expected.sequence()` yields
  `DescriptorError::InvalidSequence`. `:94-96` yields `WrongIncarnation` on an
  identity mismatch. Both collapse to one opaque `InvalidDescriptor` at the
  backend boundary.
- `backend/iceoryx.rs:266-271` and `:301` — the publish cursor. `commit` derives
  `sequence = next_publish + 1`, writes it into the prefix at `:283-285`, sends
  at `:298-300`, and only then stores `next_publish` at `:301`. A failed send
  therefore does not consume a sequence, which is correct; the exposure is on the
  success side.
- `backend/iceoryx.rs:298-300` — `sample.send()` returns
  `Result<usize, SendError>` in iceoryx2 0.9.3
  (`src/port/publisher.rs:304-321`), where the `usize` is the number of
  recipients. `commit` discards it with `.map_err(...)?`, so a send delivered to
  zero recipients is indistinguishable from a delivered publication and still
  advances `next_publish`.
- iceoryx2 0.9.3, `src/port/details/sender.rs:257-277` — three
  `ZeroCopySendError` variants are deliberately swallowed and reported as
  success: `ReceiveBufferFull`, `UsedChunkListFull`, and
  `NoConnectedReceiverAndBufferIsFull` / `ChannelIsClosed`, the last with the
  comment that skipping delivery to a disconnected subscriber "is no failure".
- `backend/iceoryx.rs` has **no quarantine**. Searching the file finds no
  lifecycle flag, no terminal state, and no `is_quarantined` equivalent. The ring
  raises exactly this state on exactly this failure: a descriptor that fails
  `validate` calls `enter_quarantine()` before returning the error
  (`ring.rs:808-811`), and every later operation then fails closed
  (`ring.rs:672-674`, `:767-769`, `:850-851`).
- `backend/iceoryx.rs:349` — `release(self)` cannot resynchronize either. It
  takes no identity and returns nothing; see
  `iceoryx-completion-is-observable-to-the-host`.

## Failure scenario

The clean derivation is the restart the process-local state invites. A fresh
`IceoryxBackend::create` sets `next_receive: Cell::new(0)` (`:115`), so a
restarted receiver expects sequence 1. A live publisher that has already
published N frames holds `next_publish == N` (`:301`) and sends N+1. The
validation at `sample.rs:100-102` compares N+1 against 1 and returns
`InvalidSequence`, so the restarted receiver rejects the sample, drops it, and
leaves its expectation at 1. Every subsequent frame carries a still-larger
sequence, so every subsequent `try_receive` fails the same way. The stream is
permanently unreadable and the backend never says so: there is no quarantine, so
`try_reserve` keeps succeeding and `try_receive` keeps returning the same opaque
`InvalidDescriptor` forever.

The same stranded state is reachable without a restart, from either direction.
A single sample whose prefix fails any check in `sample.rs:88-121` is consumed
and discarded while the expectation stands still, so the gap opens by one and
never closes. A `send()` that reports success with zero recipients advances
`next_publish` past a frame the subscriber never sees, opening the gap from the
publish side.

## Timing windows and dependencies

No window; this is a state property, and the state is absorbing. Once the
expectation trails the stream there is no path back, because the only writer of
`next_receive` is the success branch of the very call that now always fails.

The restart constructor is not reachable today, and the reason matters: a
restarted backend also mints a new random service name (`:57-69`), so it cannot
re-find the peer's service at all. That is `iceoryx-cross-process-pairing-is-
reachable-or-declared`, and it is the only thing standing between this property
and a live defect. The malformed-sample constructor needs fault class F2 aimed at
the provider's shared segment rather than at a ring control page, which no
existing harness models. The zero-recipient constructor needs either a
`Config::global_config()` override of `backpressure_strategy` to `DiscardData`,
or a subscriber disconnect; under the compiled default the buffer-full case
blocks instead, which is `iceoryx-saturation-is-bounded-non-blocking-
backpressure`.

## What a test must construct

A stream whose delivered sequence and the receiver's expectation disagree, then
an assertion about what the backend does next. Cheapest constructor available
today, needing no fault: publish one frame, receive and release it, then reach
the sample bytes through a second attachment to the same segment and rewrite the
sequence field of the next published prefix — that is F2, and it is the missing
capability. Absent F2, the honest test is the negative form on the publish side:
assert that `commit` fails, rather than advancing `next_publish`, when `send()`
reports zero recipients. The oracle is not "the frame decodes"; it is that after
any rejected receive, either the expectation advanced past the rejected sequence
or every later call reports a terminal state. Assert `identity().sequence()`
directly on the next successful lease rather than inferring progress from a body
comparison. Coverage checks to emit: `shm_iceoryx_sample_rejected_after_dequeue`
and `shm_iceoryx_send_reported_zero_recipients`.

## Investigation log

### Q: Can the local receive expectation fall behind the delivered stream, and if it does, is there any point at which the backend detects it?

- Sources examined: `backend/iceoryx.rs:36-46`, `:107-118`, `:150-176`,
  `:247-303`, `:319-355`, `:365-376`; `backend/sample.rs:41-127`;
  `backend/ring.rs:679-690`, `:761-846`, `:808-811`, `:1035-1050`;
  `tests/iceoryx.rs:122-137`; and in the vendored iceoryx2 0.9.3 sources,
  `src/port/publisher.rs:304-321` and `src/port/details/sender.rs:191-280`.
- Findings: yes to the first half, no to the second. The dequeue at `:151-157`
  is unconditional and the cursor advance at `:168` is conditional, so any
  rejection consumes a sequence from the stream without consuming one from the
  expectation. There is no detection point anywhere: no shared cursor to compare
  against, no quarantine flag, no conservation snapshot, and one opaque error
  variant covering nine distinct `DescriptorError` causes. That absence is why
  this record's check is `always(!stranded)` rather than a claim about a
  reachable code point.
- Missing evidence: whether `sequences_progress_exactly_and_wrap_attempts_fail_
  closed` (`tests/iceoryx.rs:123`) was intended to cover this. It does not: it
  commits and receives one frame per iteration, so the two counters advance in
  lockstep and never diverge, and its final assertion is `is_none()` on an empty
  stream.
- Conclusion: resolved with answer. The stranded state is forbidden, reachable
  in principle from three directions, and structurally undetectable on this
  backend. It stays unexercised pending F2 or a two-process pairing.
