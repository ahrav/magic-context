# ring-a-endpoint-thread-panic-is-reported-as-orderly-completion

## Discovery trigger

`crates/mc-host/src/ring_transport.rs:279` wraps the whole of `run_endpoint` in
`std::panic::catch_unwind` and discards the result with `let _ =`. Reading what
runs after it — `admission.release()` at `:291` and `done_tx.send(())` at `:292`
— showed that the panic and the orderly exit produce identical observable
effects. A second, narrower `catch_unwind` inside `publish_one` (`:560-563`)
then raised the question of what sits outside it.

## Evidence trail

**Two nested `catch_unwind` scopes, with a gap between them.**

Inner (`:560-563`): wraps only the reserve-fill-commit block.

```
let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match direct {
    Some(direct) => publish_direct(ring, direct, deadline),
    None => publish_owned(ring, &bytes, &tail, deadline),
}));
if !matches!(result, Ok(Ok(()))) {
    return Err(());
}
```

So a panic in the serializer becomes `Err(())`, which routes into
`ring-a-publish-failure-is-reported-as-a-clean-peer-close`. That is handled.

The gap is `:567-576`, after the inner scope closes:

```
completion.store(COMPLETE, Ordering::Release);   // :567
if let Some(hook) = publish_hook {               // :568
    if let Some(header) = wire_header.and_then(|header| decode_header(&header).ok()) {
        hook(header.ty, header.channel);         // :570
    }
}
if let Some(written) = written {                 // :573
    written(Instant::now());                     // :574
}
drop(charge);                                    // :576
```

`hook` is a `PublishHook = Arc<dyn Fn(FrameType, u16) + Send + Sync>` (`:39`).
`written` is `Option<Box<dyn FnOnce(Instant) + Send>>`
(`frame_channel.rs:630`). Both are caller-supplied closures called with no
boundary. `panic_boundary::redact_sync` wraps only the direct serializer
(`:586-589`), inside the inner scope, not these.

Outer (`:279-290`): wraps `runtime.block_on(run_endpoint(..))`. Its result is
discarded. Then:

```
admission.release();     // :291
let _ = done_tx.send(());// :292
```

**What the connection engine observes on that path.** `done_tx` is the sender
half of the oneshot created at `:248`; the `io` future is
`async move { let _ = done_rx.await; }` (`:301-303`). `connection.rs:190`
spawns it as `AbortOnDropHandle` and `connection.rs:347` awaits it. A completed
oneshot means the `io` future resolves, so the join at `:347` succeeds exactly as
it would after an orderly exit.

**What is not cancelled.** On this path neither `queue.retired` nor `root` is
cancelled. Contrast the two paths that do cancel: `:402-403` (inbound close) and
`:448-449` (publish failure). So after the panic the `FrameSender` is still live:
`FrameSender::is_retired` (`frame_channel.rs:755-757`) returns false, and
`send_ticket_before` (`:727-753`) keeps admitting frames into the mpsc until
either the channel fills or `timeout_at(deadline, ..)` expires at `:742-750`,
at which point it cancels `retired` and `generation` itself.

**The `COMPLETE` store ordering.** `:567` stores `COMPLETE` before the hooks
run. The constant is `pub(crate) const COMPLETE: u8 = 3`
(`frame_channel.rs:636`). So a frame whose `written` hook panics is already
recorded complete, and the panic then loses the thread. The frame did reach the
ring, so `COMPLETE` is truthful; the problem is the thread, not the flag.

**The narrower second window.** `begin_publication`
(`frame_channel.rs:645-657`) does the `compare_exchange(QUEUED -> PUBLISHED)`
first and *then* calls `on_publish()`:

```
if self.state.compare_exchange(QUEUED, PUBLISHED, Ordering::AcqRel, Ordering::Acquire).is_err() {
    return false;
}
if let Some(on_publish) = self.on_publish.take() {
    on_publish();
}
true
```

A panic inside `on_publish()` leaves the state at `PUBLISHED` with nothing
written to the ring. `FrameSendTicket::cancel` (`frame_channel.rs:674-682`)
then finds the exchange from `QUEUED` failing and returns
`SendOutcome::PossibleSend`. `docs/mc-host-wire-protocol.md:60` defines
`not_sent` as "sender proves the request frame was not published to the ring" —
here the frame provably was not published, and the host reports
`PossibleSend`. That is conservative, so it is safe, but it is a false negative
on a guarantee the doc states as a proof.

## Failure scenario

A `written` completion hook panics. `dispatch.rs` supplies these hooks through
`OutboundFrame::written`, so the panicking code is host code, reachable by any
defect in the completion path.

Sequence: frame published to the ring, peer can see it, `COMPLETE` stored, hook
panics, unwind through `publish_one` and `run_endpoint`, `DuplexRing` dropped
during unwind (it is owned by `run_endpoint`'s frame, `:365`), `catch_unwind`
swallows, charge released, `done_tx` fired, thread gone.

Now the connection has no transport thread and does not know it. Inbound: the
`inbound` sender was dropped during unwind, so `ShmReceiver::recv` yields
`Err(ReadClose::CleanEof)` (`:359`) and the read loop retires as
`ReadExit::Peer` — the same misattribution as
`ring-a-publish-failure-is-reported-as-a-clean-peer-close`. Outbound: frames
admitted between the panic and the read loop noticing sit in the mpsc and each
eventually fails its own admission deadline.

Diagnostics: `state: "healthy"`, all five counters unchanged. Nothing anywhere
records that a thread panicked.

## Timing windows and dependencies

Two windows.

- `:567` to `:576`, one publication wide. Entered on every published frame that
  has a hook. The panic must originate in `hook` (`:570`) or `written` (`:574`).
- `frame_channel.rs:648` to `:655`, inside `begin_publication`. Entered on every
  frame that carries an `on_publish` callback.

Dependencies: Part 2a owns `no-writer-hook-panic-poisons-a-generation-lock`,
which covers completion-hook panics on the *writer task*. This is a different
owner — the endpoint OS thread — with a different boundary, namely none. The two
records are complementary and neither subsumes the other. Part 2a also owns
`a-cancelled-emission-releases-every-permit-it-held`; note that on this path the
`charge` local of `publish_one` (`:550`) is dropped by the unwinding machinery, so
the byte charge does return, which is worth stating because it is the one thing
the panic path gets right by accident.

## What a test must construct

The publish hook is the injection point already in the tree, and it is honest
about being test-only (`:225-231`, `#[doc(hidden)]`, doc comment "Test hook").

1. Build a host through `runtime::run_with_publish_hook`
   (`runtime.rs:643-648`), which is how `tests/support/mod.rs:597` and `:614`
   already install hooks.
2. Install a hook that panics on its first invocation.
3. Drive one frame to publication.
4. Assert three things: the connection observes a cause other than `CleanEof`;
   `FrameSender::is_retired()` becomes true within a bounded interval rather
   than only after `frame_deadline`; and `diagnostics()` records the event.

Today all three fail.

For the `begin_publication` window, the construction is a `send_ticket_before`
with a panicking `on_publish` (`frame_channel.rs:727-732` accepts it), followed
by `FrameSendTicket::cancel` on a second reference to the same ticket, asserting
`NotSent`. Today it returns `PossibleSend`.

Note that the production `written` hook cannot be made to panic from a test
without a `dispatch.rs` injection point, so the publish hook is a proxy for it.
That is a coverage caveat worth recording rather than papering over: the test
proves the boundary is missing, using a test-only closure, for a production
closure in the same position.

## Investigation log

### Q: Should the `COMPLETE` store move after the hooks, or should the hooks move inside the inner `catch_unwind`?

- Sources examined: `ring_transport.rs:560-577` (both scopes and the gap),
  `:586-589` (`redact_sync` around the serializer only),
  `frame_channel.rs:633-636` (the four state constants),
  `frame_channel.rs:645-657` (`begin_publication`),
  `frame_channel.rs:674-682` (`FrameSendTicket::cancel`).
- Findings: the two options are not equivalent. Moving `COMPLETE` after the
  hooks would make a hook panic leave the frame at `PUBLISHED` — but the frame
  really did reach the ring, so `PUBLISHED`-not-`COMPLETE` would then be a lie in
  the other direction, and any waiter on `COMPLETE` would hang. Moving the hooks
  inside a `catch_unwind` preserves the truthful `COMPLETE` and converts the
  panic into the publish-failure path, which at least cancels `retired` and
  `root`. So the second option is the coherent one, and it composes with the
  cause-carrying change discussed in
  `ring-a-publish-failure-is-reported-as-a-clean-peer-close`.
- Missing evidence: whether any host code waits on `COMPLETE` specifically
  rather than on the `written` hook. `COMPLETE` is `pub(crate)` and its only
  writer is `:567`; I did not enumerate its readers outside this file.
- Conclusion: unresolved on the fix, resolved on the analysis: wrapping the
  hooks is the coherent option and moving the store is not. The remaining gap is
  the `COMPLETE` reader enumeration, which sits in Part 2a's `dispatch.rs` and
  `connection.rs` territory.

### Q: Does the outer `catch_unwind` swallow a panic that `panic_boundary` would otherwise have reported?

- Sources examined: `ring_transport.rs:279-290`; `lib.rs:30` (`mod
  panic_boundary`, private); `runtime.rs` installs it via
  `crate::panic_boundary::install()` at `runtime.rs:647`.
- Findings: `panic_boundary::install()` installs a process panic hook, and a
  panic hook runs *before* unwinding begins, so it fires even when the panic is
  later caught. So the panic is not entirely invisible: the hook sees it. What is
  invisible is the *consequence* — the loss of the transport thread — because
  nothing correlates the hook's output with the connection.
  `panic_boundary.rs` is Part 2a scope (66 lines) and I did not read it.
- Missing evidence: whether the installed hook records enough to attribute a
  panic to a connection, and whether Part 2a's
  `the-panic-hook-cannot-itself-fail` and
  `every-callback-invocation-is-inside-the-redaction-guard` already cover the
  reporting half.
- Conclusion: unresolved, needs a read of `panic_boundary.rs` against Part 2a's
  two panic-hook records. The property as stated is about the *connection's*
  observation, which is unaffected either way, so this does not change the
  record; it changes how bad the impact is.
