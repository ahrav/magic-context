# req-a-three-control-rejection-paths-carry-three-different-bounds

## Discovery trigger

Task 1 asked whether rejection is uniform across request kinds. Within channel 0
alone there turned out to be three distinct emission paths with three distinct
bounds and three distinct delivery guarantees, which is a finer split than the
routed-versus-control asymmetry.

## Evidence trail

**Path 1: semantic rejection.** `ControlAction::Reject` from `parse_control`
reaches `connection.rs:638-655`:

```
ControlAction::Reject { code, message } => {
    let shared_task = Arc::clone(shared);
    let gen_task = Arc::clone(gen);
    shared.spawn_tracked(gen.read_tasks.track_future(async move {
        let _pending_permit = pending_permit;
        emit_error_terminal(
            &shared_task.egress_budget,
            &gen_task,
            FrameId::control(corr),
            code,
            &message,
        )
        .await;
    }));
}
```

The bound is the pending permit acquired at `connection.rs:625`, drawn from
`pending_permits` or `reserved_pending_permits` (`:616-624`). That is a
**host-global** pool of 928 at defaults. No `written` hook.

**Path 2: capacity rejection.** When the pending permit itself cannot be acquired,
`connection.rs:625-635` calls `emit_rejection`, which draws on the
per-generation `busy_rejects` semaphore of 32 (`dispatch.rs:620`,
`connection.rs:42`, `:244`). No `written` hook. Past the bound it cancels the
generation and discards the writer queue (`dispatch.rs:637-638`).

**Path 3: oversize rejection.** A channel-0 body above the 65,536-byte profile cap
is refused in the transport and surfaces as `InboundEvent::Rejected`
(`connection.rs:408`). The read loop acquires a `busy_rejects` permit at `:430`,
creates a oneshot at `:435`, and spawns `emit_authoritative_rejection`
(`:441-449`), which is the **only** control rejection carrying a completion hook
(`dispatch.rs:814-816`):

```
written: Some(Box::new(move |_completed_at| {
    let _ = written_tx.send(());
})),
```

The receiver is stored in `reject_written` (`connection.rs:436`) and consumed at
`:396-399`, where a subsequent `ReadClose::RejectedDrainFailed` returns
`ReadExit::PeerKeepQueue(terminal_rx)` instead of `ReadExit::Peer`. That is the
mechanism that fences exactly one authoritative frame past an otherwise silent
close, and it exists because protocol §7.1 makes the early terminal authoritative
"even if the declared body then truncates, stalls, or EOFs".

Summary of the three:

| Path | Bound | Scope | `written` hook | Past-bound behaviour |
| --- | --- | --- | --- | --- |
| semantic | `pending_permits` (928) | host-global | no | `server_busy` via path 2 |
| capacity | `busy_rejects` (32) | per generation | no | cancel + discard |
| oversize | `busy_rejects` (32) | per generation | yes | cancel + discard (`connection.rs:431-433`) |

Note paths 2 and 3 share one counter, so oversize traffic and capacity rejections
contend for the same 32 slots.

## Failure scenario

**Semantic-rejection amplification.** The interesting one, because its bound is
global.

1. A client sends malformed control bodies as fast as the ring allows. Each is a
   valid frame with an invalid body, so it passes framing and reaches
   `parse_control`.
2. Each acquires a pending permit at `connection.rs:625` and spawns a task holding
   it until the error terminal is queued.
3. Under a contended egress budget, `charged_error_body`'s
   `charge_frame_or_cancel` (`dispatch.rs:200`) blocks for up to one admission
   window per rejection.
4. Up to 928 general pending permits are held by malformed-traffic rejections.
5. Every routed request on **every other generation** then fails gate 5
   (`dispatch.rs:884`) and gets `server_busy`.

So malformed control traffic on one connection degrades application throughput on
all of them, while a capacity-rejection flood from the same client is contained to
its own generation by the 32-slot counter.

**Shared-counter interference.** Paths 2 and 3 share `busy_rejects`, so a client
streaming oversize control bodies consumes the same slots that capacity rejections
need. When the 32 are gone, the next arrival of *either* kind cancels the
generation — `connection.rs:431-433` for oversize, `dispatch.rs:637-638` for
capacity. Both also call `gen.writer.discard()`, so both drop other correlations'
queued terminals.

Effect accounting: for paths 1 and 2, attempted rejections equal the emissions
that reached `send_before` and acknowledged rejections are unobservable, because
neither carries a hook. For path 3, attempted and acknowledged are separately
observable, which is exactly why §7.1's authoritativeness claim is implementable
there and not on the other two.

## Timing windows and dependencies

Path 1's window is the egress wait per rejection, bounded by
`gen.writer.admission_deadline()`. The amplification requires many rejections
concurrently in that wait, which requires a contended budget.

Path 3's fence has a precise window: the oneshot must be created before the next
`channel.recv()` (`connection.rs:388`), because that call is where
`ReadClose::RejectedDrainFailed` surfaces. The code satisfies this by storing
`reject_written` at `:436` inside the same loop iteration that spawns the emitter,
before the loop continues. `reject_written` is overwritten by each subsequent
oversize rejection (`:436` assigns unconditionally), so only the **most recent**
authoritative frame can be fenced — which matches §7.1, since only the frame
whose body drain then failed matters.

Dependency: path 1's bound is the same pool that funds real requests, by design.
Protocol §8.3 says "Every channel-0 request — including semantic rejections — is
one consumer request against the global unsettled bound", and the comment at
`connection.rs:606-609` restates it. So the global charge is intentional; what is
not stated anywhere is that it makes malformed traffic a cross-connection
throughput lever.

## What a test must construct

1. **Semantic amplification**: shrink `max_pending_requests`, saturate the egress
   budget, flood malformed control bodies on generation A, and assert a routed
   request on generation B gets `server_busy`. This proves the cross-generation
   coupling.
2. **Capacity containment**: the same flood but past the pending bound, and assert
   generation A is retired while generation B keeps serving — the contrast that
   makes the asymmetry visible.
3. **Shared-counter interference**: interleave oversize control bodies and
   capacity rejections on one generation and assert the 33rd of the combined total
   retires it, not the 33rd of either kind.
4. **The fence**: send one oversize control body, then truncate the declared body
   so the drain fails, and assert the client receives the
   `invalid_control_request` terminal before the close. Part 2a holds
   `oversize-control-drain-work-is-bounded-without-ingress-budget` and
   `the-client-body-budget-refusal-drain-is-never-entered`, so the fence is partly
   covered there.

Existing coverage: `tests/routing.rs:212`
(`malformed_control_bodies_are_refused_before_handler_work`) and `:98`
(`unsupported_operations_leave_the_generation_usable`) exercise single semantic
rejections. Neither saturates anything. `tests/routing.rs` is named in no CI
workflow.

## Investigation log

### Q: Do paths 2 and 3 really share one counter?

- Sources examined: `connection.rs:101` (the field's doc comment), `:244`
  (construction with `MAX_INFLIGHT_BUSY_REJECTS`), `:430` (path 3's acquisition),
  `dispatch.rs:620` (path 2's acquisition).
- Findings: one `Arc<Semaphore>` field on `GenerationCore`, two acquisition sites.
  The field's doc says it "Bounds concurrent off-reader `server_busy` rejection
  emissions", which describes path 2 only and does not mention path 3, even though
  path 3 uses it.
- Missing evidence: none.
- Conclusion: resolved with answer — shared counter, and the field doc
  under-describes its own use. A fourth in-crate comment that does not match the
  code.

### Q: Is `reject_written` overwriting a problem?

- Sources examined: `connection.rs:385` (declaration), `:436` (assignment),
  `:396-399` (consumption via `take()`).
- Findings: each oversize rejection overwrites the previous receiver, dropping it.
  Dropping a `oneshot::Receiver` does not affect the sender's frame, only the
  ability to observe it. Since only the frame whose drain failed needs fencing,
  and the drain failure surfaces on the very next `recv`, the most recent receiver
  is the correct one to keep.
- Missing evidence: none.
- Conclusion: resolved with answer — correct as written.

### Q: Is charging malformed traffic to the global pool the intended reading of §8.3?

- Sources examined: protocol §8.3's finite-limits paragraph;
  `connection.rs:606-615`'s comment.
- Findings: §8.3 says a control request, including a semantic rejection, is one
  request against "the global unsettled bound". The code matches the words. The
  doc does not discuss whether "global" was meant to be host-wide or
  connection-scoped, and it does not discuss the cross-connection consequence.
- Missing evidence: any protocol statement on per-connection isolation of control
  rejections.
- Conclusion: needs human input. The code implements the doc's letter; whether the
  doc intended the resulting blast radius is a design question.
