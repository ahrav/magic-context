# req-a-a-routed-terminal-carries-no-delivery-acknowledgement

## Discovery trigger

METHOD's effect-accounting rule requires tracking attempted and acknowledged
effects separately on any path where a response can be lost. Part 2b established
that a publish failure is reported to the peer as a clean close, so the host's
response path is exactly such a path. The question was whether the host retains
any evidence of acknowledgement for a routed terminal.

## Evidence trail

`OutboundFrame` carries an optional local-completion hook
(`frame_channel.rs:622-631`):

```
pub struct OutboundFrame {
    pub bytes: Vec<u8>,
    pub tail: Vec<u8>,
    pub(crate) direct: Option<DirectFrame>,
    pub charge: crate::wire::ByteCharge,
    /// Local-completion hook, run after every frame byte reaches local egress.
    pub written: Option<Box<dyn FnOnce(Instant) + Send>>,
}
```

The hook fires in `publish_one` at `ring_transport.rs:573-575`, after
`completion.store(COMPLETE, Ordering::Release)` at `:567` and after the publish
hook at `:568-572`. Crucially it fires only on the success path: the early
return at `:563-565` (`if !matches!(result, Ok(Ok(())))`) skips it, dropping the
boxed closure unrun.

Every `written` construction in this sub-part, exhaustively:

| Site | Frame | Purpose |
| --- | --- | --- |
| `dispatch.rs:678-680` | `Response` for `host.shutdown` on the already-committed path | signals the settling requester |
| `dispatch.rs:743-756` | `Response` for `host.shutdown` on the owner path | the commit point itself |
| `dispatch.rs:814-816` | `Error` for an oversize control body | lets the read loop fence one authoritative frame |
| `dispatch.rs:1474-1476` | connection `Goodbye` | bounds the teardown wait |

The routed terminal emitters pass `None`:

- `emit_reserved_frame` hard-codes `written: None` at `dispatch.rs:358`. This is
  the emitter for every unary `Response` (`:447-454`), every `Error` terminal
  (`:473-480`), and every `StreamData` item (`:590-597`).
- `emit_frame` forwards `None` at `dispatch.rs:265`, which is the `StreamEnd`
  path (`:494`).

So `settle` (`dispatch.rs:399-501`) never attaches a hook on any of its four
terminal shapes. The success of `settle` is `send_before(...).await.is_ok()`
(`:455`, `:481`, `:495`), which `frame_channel.rs:715-723` documents as
admission into the writer queue, not delivery.

## Failure scenario

1. A handler completes; `settle` charges bytes, encodes, and calls
   `send_before`, which returns `Ok`. `won` is already `true`.
2. The frame sits in the writer queue behind a large earlier frame.
3. The peer stops reading, or the ring reservation fails, or the generation is
   cancelled and the writer discards.
4. The host retains: `won == true`, the pending entry removed by
   `remove_pending` at `dispatch.rs:1066`. Nothing records that the frame never
   left.
5. The client retains: no terminal, so per protocol §10.1 the outcome is
   `outcome_unknown`.

The two ends now disagree, and the host holds no data that could reconcile them.
Attempted effects equal the settlement count; acknowledged effects are
identically zero.

## Timing windows and dependencies

The gap is unbounded in wall-clock terms. `send_before`'s deadline
(`gen.writer.admission_deadline()`, `frame_channel.rs:710-712`) bounds only the
*admission* wait. Once queued, publication is the endpoint thread's business and
is bounded per frame by `frame_deadline` (`config.rs:207`, default 30 s) inside
`publish_one` at `ring_transport.rs:559`, but that deadline expiring produces a
publish failure, not a signal back to the settling task, which by then has
returned.

Dependency: this holds only because `settle` returns `true` on the
`send_before`-`Ok` path without waiting for completion. `handle_host_shutdown`
demonstrates the alternative: it pairs the hook with
`timeout_at(gen.writer.admission_deadline(), completed)` at `dispatch.rs:687-689`
to actually wait for delivery, and cancels the generation if it does not arrive
(`:691-693`). That mechanism exists in the file; the routed path does not use it.

## What a test must construct

Because the host exposes no acknowledgement signal, the only assertable form is
the negative structural one plus the client-side bound:

1. Instrument or inspect: for every routed terminal emission, `written` is
   `None`. This is statically checkable at `dispatch.rs:358` and `:265`.
2. End-to-end bound: run N requests against a peer that reads normally, count
   terminals the client observes and settlements the host recorded, and assert
   `observed <= settled`.
3. Loss arm: saturate the egress budget so a terminal is queued, cancel the
   generation, and assert the client observes strictly fewer terminals than the
   host settled, with no host-side record of which ones were lost.

Per-correlation checks are the primary oracle here, as METHOD requires: an
aggregate count can cancel a lost terminal against a duplicate, but the
one-to-one correlation contract cannot.

## Investigation log

### Q: Is there any other host-side record of delivery for a routed terminal?

- Sources examined: `dispatch.rs` in full for `written`, `COMPLETE`, and
  completion state; `frame_channel.rs:633-636` for the frame state machine
  (`QUEUED`, `CANCELLED`, `PUBLISHED`, `COMPLETE`); `ring_transport.rs:536-578`.
- Findings: `QueuedOutboundFrame.state` does reach `COMPLETE`
  (`ring_transport.rs:567`), but that `Arc<AtomicU8>` is retained only by the
  writer's own ticket machinery. `settle` uses `send_before`, which
  `frame_channel.rs:715-723` shows discards the ticket (`.map(drop)`). So no
  routed settlement path holds the state handle.
- Missing evidence: none.
- Conclusion: resolved with answer — no host-side delivery record exists for a
  routed terminal.

### Q: Would attaching a hook be free?

- Sources examined: the hook type at `frame_channel.rs:630`.
- Findings: it is `Option<Box<dyn FnOnce(Instant) + Send>>`, so one heap
  allocation per frame plus the closure's captures. At `max_pending_requests`
  1024 that is bounded, but it is a real cost on the hot path, which is a
  plausible reason for the current choice.
- Missing evidence: no benchmark or design note in the crate stating this as the
  reason.
- Conclusion: needs human input — whether the metering value justifies a boxed
  closure per routed terminal is a design decision, not a code fact.
