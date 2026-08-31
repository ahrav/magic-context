# req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame

## Discovery trigger

The lens focus asked whether a duplicate response is possible. `dispatch.rs`
opens with a module comment claiming "First-terminal-wins settlement", so the
question was whether the claim survives four independent claimants: handler
completion, client `Cancel`, route close, and generation teardown.

## Evidence trail

`Settlement` is defined at `dispatch.rs:34-41` with three fields: `won:
AtomicBool`, `order: tokio::sync::Mutex<()>`, and `streamed: AtomicBool`.

The single mutator of `won` is the `swap` at `dispatch.rs:408`, inside `settle`,
taken after acquiring the order lock at `:407`:

```
let _order = settlement.order.lock().await;
if settlement.won.swap(true, Ordering::SeqCst) {
    return false;
}
```

Every other read is a `load`: `:53` (`is_settled`), `:521`, `:533`, `:552`,
`:564`, `:584`. None of them writes.

The five emission sites for a routed correlation, all reached only through the
order lock:

| Site | Location |
| --- | --- |
| unary `Response` | `dispatch.rs:447-460` |
| `Error` after streaming | `:418-446` |
| handler `Error` terminal | `:462-487` |
| `StreamEnd` | `:488-492`, emitted at `:494` |
| `StreamData` item | `:583-604`, lock at `:583` |

`StreamSink::send` takes the same order mutex at `:583`, rechecks `won` at
`:584`, emits, then stores `streamed` at `:599`. `_order` is a block-scoped
guard, so the store happens before the lock releases. The `has_streamed()` read
in `settle` at `:418` therefore cannot observe a stream item that was queued but
not yet marked. The comment at `:413-417` states exactly this reason: a context
escaped into a background task can queue `StreamData` after the caller's
outside-the-lock check.

The four claimants:

1. Handler completion: `dispatch.rs:1018-1063`, the `joined` arm of the select,
   calling `settle` at `:1063`.
2. Client `Cancel`: `handle_cancel` at `:1489-1496` cancels the token; the
   `cancel.cancelled()` arm at `:1001-1017` calls `settle` at `:1004`.
3. Route close: `settle_route_work` at `:1332-1342` cancels each pending
   entry's token, which reaches the same select arm.
4. Pre-handler cancellation: `:944-960`, checked after `start_rx` resolves and
   before the handler task is spawned, calling `settle` at `:945`.

All four converge on `settle`, so the `swap` arbitrates all of them.

## Failure scenario

If the order lock were not held across emission, this interleaving would produce
a forbidden sequence:

1. Handler calls `ctx.stream(item)` in a detached background task.
2. `send` passes its `won` check and begins emitting `StreamData`.
3. The handler's main body returns `RequestOutcome::Response`.
4. `settle` reads `has_streamed()` as false, because step 2 has not stored it.
5. `settle` emits `Response`.
6. Step 2 completes and stores `streamed`.

The client then observes `StreamData` followed by `Response`, which protocol
§9.1 forbids: a streaming sequence terminates only with `StreamEnd` or `Error`.
The order lock plus the store-before-release ordering closes this.

## Timing windows and dependencies

The critical section is from `order.lock()` to the end of the emitting scope,
which spans an `await` on the byte budget and an `await` on writer admission.
Both are bounded by `gen.writer.admission_deadline()`
(`frame_channel.rs:710-712`), so the lock is held for at most one admission
window per emission. It is an async mutex precisely because those awaits happen
inside it.

Dependency: correctness rests on `Settlement` being reachable only through the
`PendingEntry` in `gen.pending` (`dispatch.rs:916-922`) and the `StreamSink`
clone (`:963-970`), both of which hold the same `Arc`. There is no second
`Settlement` for a correlation, because `Settlement::new` is called exactly once
per `dispatch_request` at `:913`.

## What a test must construct

Three claimants racing one correlation:

1. Open a route to a handler whose `handle` spawns a detached task that streams
   one item after a short delay, then returns `RequestOutcome::Response`.
2. Send the routed `Request`.
3. Send a `Cancel` for that exact `(channel, epoch, corr)` inside the delay.
4. Concurrently send a route `Goodbye` for the same handle.
5. Read every frame on the generation until it closes, and assert exactly one
   frame carrying that correlation has a terminal type, and that no
   `StreamData` for it follows that frame.

The existing tests cover pairs, not the triple: `tests/dispatch.rs:358`
(`cancel_and_completion_settle_exactly_once`), `:453`
(`simultaneous_cancel_and_completion_still_emit_one_terminal`), `:504`
(`cancelling_a_stream_stops_it_with_one_terminal`), `:835`
(`closing_a_route_settles_its_admitted_work`). None of the four is named in any
CI workflow.

## Investigation log

### Q: Can `won` be set outside `settle`, bypassing the order lock?

- Sources examined: every occurrence of `won` in `dispatch.rs`
  (`:35`, `:46`, `:53`, `:408`, `:521`, `:533`, `:552`, `:564`, `:584`); the
  field is private to the module and `Settlement` is not constructed anywhere
  else in the crate.
- Findings: `:408` is the only write. All other uses are `load`.
- Missing evidence: none.
- Conclusion: resolved with answer — `won` flips only under the order lock.

### Q: Does the `streamed` flag have a torn window against `has_streamed`?

- Sources examined: `dispatch.rs:56-58`, `:418`, `:583-604`, `:1020`.
- Findings: the store at `:599` is inside `send`'s scope, which holds
  `_order`. The read at `:418` is inside `settle`'s scope, which holds the same
  guard. So they are mutually excluded. The *second* read at `:1020` is outside
  the lock, but it only selects which `Terminal` to build; `settle` re-reads
  authoritatively at `:418`, and the comment at `:413-417` says so.
- Missing evidence: none.
- Conclusion: resolved with answer — no torn window; the outside-the-lock read
  at `:1020` is an optimization, not the oracle.
