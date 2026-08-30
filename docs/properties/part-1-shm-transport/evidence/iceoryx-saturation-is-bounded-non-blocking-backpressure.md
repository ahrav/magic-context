# iceoryx-saturation-is-bounded-non-blocking-backpressure

## Discovery trigger

The ring backend answers every capacity limit with a bounded, non-terminal code.
A full descriptor set is `ProducerError::Exhausted` (`ring.rs:685-687`), which
`reserve_until` converts to `Deadline` after the profile's scheduling budget
(`ring.rs:755`). A full lease set is `Ok(None)`, and the doc comment states the
rule explicitly: "A full lease set is backpressure, not a fault" and "Errors are
reserved for faults that end the channel" (`ring.rs:763-779`). The iceoryx
backend has no descriptor set, no lease counter, and no deadline parameter, so
the question is what it returns instead when the same two limits bind.

## Evidence trail

- **The cited mechanism is gone.** `0f336d3c` ("refactor(shm): collapse to fixed
  ring transport") deleted `crates/mc-shm-transport/src/backend/iceoryx.rs`,
  `crates/mc-shm-transport/tests/iceoryx.rs`, and the `iceoryx` Cargo feature, so
  `backend/mod.rs` now declares only `ring` and `sample`. Every `iceoryx.rs`
  citation below is kept as a record of what the removed backend did and did not
  guarantee, and resolves against `9c1eb4d1`, not HEAD. No successor backend
  exists in the tree.

- `crates/mc-shm-transport/src/backend/mod.rs:1-6` — there is **no shared
  backend trait**. At `9c1eb4d1` the module was four declarations whose line 1
  asserted in prose that "Backends use same direct producer and scoped receive
  ownership"; `0f336d3c` cut it to `ring` and `sample` and rewrote that line.
  Nothing
  in the type system holds either backend to it, so every parity claim below is
  a prose claim only.
- `backend/iceoryx.rs:78-80` — the service is built with
  `subscriber_max_buffer_size(profile.descriptor_depth())`,
  `subscriber_max_borrowed_samples(profile.max_leases())`, and
  `enable_safe_overflow(false)`. `:86` sets the subscriber's own
  `buffer_size(profile.descriptor_depth())`. Both caps are configured and
  neither is ever read again by this file.
- `backend/iceoryx.rs:89-106` — the publisher builder sets
  `initial_max_slice_len`, `max_loaned_samples(1)`, and `allocation_strategy`.
  It never calls `.backpressure_strategy(...)`, so the publisher inherits the
  compiled default.
- iceoryx2 0.9.3, `src/config.rs:317-320` and `:344` — the default is
  `BackpressureStrategy::RetryUntilDelivered`, and the field's own
  documentation says it "defines the deliver strategy of the Publisher when the
  Subscriber's buffer is full" **if safe overflow is deactivated**. That is
  exactly the configuration at `iceoryx.rs:80`.
  `src/service/port_factory/publisher.rs:170` copies `defaults` into the port
  config; the setter at `:209` is never called from this repository.
- iceoryx2 0.9.3, `src/port/details/sender.rs:235-252` — with no backpressure
  handler installed, `DiscardData` takes `try_send` and `RetryUntilDelivered`
  takes `blocking_send`. iceoryx2-cal 0.9.3,
  `src/zero_copy_connection/common.rs:749-751` gates on
  `!enable_safe_overflow && submission_queue.is_full()`, then `:762` enters
  `AdaptiveWait::wait_while`, and `:779-787` resolves the no-handler
  `FollowBackpressureyStrategy` against the strategy action `Retry`, setting
  `retry_until_delivered = true` and returning `WAIT_CONTINUE`. `:772-773` then
  returns `WAIT_CONTINUE` unconditionally on every later iteration. The loop
  exits only when the queue drains, the peer disconnects, or the channel closes.
- `backend/iceoryx.rs:298-300` — `commit` calls `sample.send()` and maps any
  error to `PublicationFailed`. There is no deadline, no scheduling mode, and no
  `Exhausted` equivalent on this path. `try_reserve` does have one
  (`:132-135`, loan failure to `Exhausted`), but the loan is not the limit that
  binds first.
- `backend/iceoryx.rs:45` — `_not_send: PhantomData<Rc<()>>`. The backend owns
  **both** ports (`:39-40`) and is `!Send`, so the publisher and the subscriber
  are pinned to one thread.
- iceoryx2 0.9.3, `src/port/details/receiver.rs:558-577` — on the receive side,
  a connection that has data but whose `borrow_count` has reached
  `max_borrowed_samples` is skipped; if every channel with data is in that
  state, `receive` returns `Err(ReceiveError::ExceedsMaxBorrows)`. With no
  queued data it returns `Ok(None)`.
- `backend/iceoryx.rs:151-157` and `:371` — every `receive()` error becomes
  `IceoryxError::ReceiveFailed`, displayed as "iceoryx receive failed". There is
  no branch that maps borrow saturation to `Ok(None)`.

## Failure scenario

Two independent scenarios, neither needing a fault, a second process, or
concurrency.

Publish side. Create the backend, then `try_reserve` + `commit` without ever
calling `try_receive`. Each commit fills one submission-queue slot. Once the
subscriber buffer configured at `:78` and `:86` is full, the next `commit`
enters `blocking_send` and spins forever, because the only party that could
drain the queue is the same thread now blocked inside `send()`. The ring answers
the same state with `Exhausted` and hands the caller back control.

Receive side. Publish up to the buffer bound, receive every frame and hold the
leases, then publish one more. `try_receive` now sees a channel with data whose
borrow count is at the cap and returns `Err(ReceiveFailed)`. The ring answers
the same state with `Ok(None)` and has a test pinning it,
`lease_limit_reports_backpressure_then_recovers_after_release`
(`tests/ring.rs:279`).

## Timing windows and dependencies

No window. Both are state conditions, reached by counting operations, and both
are permanent while the state holds. The publish-side block is unbounded in
wall-clock time and unbreakable on a single thread; it is not a slow path that
eventually completes. The frame index at which each binds depends on the
profile: the contract test profile uses `descriptor_depth: 8` and
`max_leases: 8` (`tests/iceoryx.rs:32`, `:36`), the bench arm uses 4 and 4
(`benches/hardware_envelope.rs:553`, `:556`). The publish-side block also
depends on the publisher inheriting the compiled default strategy; a
`Config::global_config()` override to `DiscardData` would convert the block into
silent frame loss, which is the enabling condition for
`iceoryx-receive-expectation-tracks-the-delivered-stream` rather than a fix.

## What a test must construct

Publish side: a bounded-time assertion. Reserve and commit
`descriptor_depth + 1` frames with no intervening receive, on a thread the test
can abandon, and assert the final `commit` returns within a deadline — as
`Exhausted`, as a `Deadline` equivalent, or as any bounded error. A plain
`#[test]` that simply calls it will hang, so the harness needs
`slow-timeout` with `terminate-after` (fault class F3 is not required; nextest
configuration is enough). Receive side: publish to the buffer bound, receive and
retain `max_leases` leases in a `Vec`, publish once more, and assert
`try_receive()` is `Ok(None)` rather than `Err(ReceiveFailed)`; then drop one
lease and assert the next `try_receive` yields the queued frame. Coverage checks
to emit, both preconditions rather than violations:
`shm_iceoryx_subscriber_buffer_full` and `shm_iceoryx_borrow_cap_saturated`.

## Investigation log

### Q: When the two configured caps bind, does the iceoryx backend return a bounded backpressure code the way the ring does?

- Sources examined: `backend/iceoryx.rs:50-118`, `:121-144`, `:150-176`,
  `:247-303`; `backend/ring.rs:664-736`, `:739-759`, `:761-779`;
  `backend/mod.rs:1-9`; `tests/iceoryx.rs:16-43`, `:122-137`;
  `benches/hardware_envelope.rs:531-598`; and in the vendored iceoryx2 0.9.3
  and iceoryx2-cal 0.9.3 sources, `src/config.rs:300-350`,
  `src/service/port_factory/publisher.rs:160-215`,
  `src/port/details/sender.rs:191-280`,
  `src/port/details/receiver.rs:540-580`,
  `src/zero_copy_connection/common.rs:737-800`.
- Findings: no. The publish side blocks indefinitely and the receive side
  returns a channel-ending fault code. Both configured caps
  (`subscriber_max_buffer_size`, `subscriber_max_borrowed_samples`) are handed
  to the provider and never consulted locally, so the backend cannot report
  saturation in its own vocabulary. The absence of a shared trait in
  `backend/mod.rs` is why neither divergence is a compile error.
- Missing evidence: whether the deployed `Config::global_config()` on any
  designated host overrides `backpressure_strategy`. No repository file sets it,
  and no test asserts the effective value.
- Conclusion: resolved with answer. Both halves are reachable with no fault and
  no concurrency, and neither is covered by any existing test, because every
  test in `tests/iceoryx.rs` receives and releases immediately after each
  commit.
