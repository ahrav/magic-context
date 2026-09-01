# req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired

## Discovery trigger

The task asked whether every admitted request eventually gets exactly one
response or a classified close, and whether the host can leave a client's request
unanswered without the client learning why. The admission map showed five of the
seven routed gates funnel their terminal through one function, `emit_rejection`,
so that function is the single point where the answer is decided.

## Evidence trail

`emit_rejection` (`dispatch.rs:613-641`) in full shape:

```
match gen.busy_rejects.clone().try_acquire_owned() {
    Ok(reject_permit) => {
        // spawn a tracked task that emits the error terminal
    }
    Err(_) => {
        gen.token.cancel();
        gen.writer.discard();
    }
}
```

The permit is acquired at `:620`, before the spawn at `:624`, and moved into the
task at `:625`. So the number of concurrently outstanding rejection emissions per
generation is capped by the semaphore.

The semaphore is per-generation and sized 32:
`const MAX_INFLIGHT_BUSY_REJECTS: usize = 32` at `connection.rs:42`, used at
`connection.rs:244` when the `GenerationCore` is built. (Two other constructions
exist, both in tests: `routing.rs:498` uses 4 and `runtime.rs:1319` uses 1.)

The exhaustion arm does two things, and the second one is the finding.
`gen.token.cancel()` retires the generation. `gen.writer.discard()`
(`frame_channel.rs:701-703`) flips the writer's discard token, which drops every
frame already queued — including terminals belonging to *other* correlations that
were settled successfully and are merely waiting for egress.

The comment at `:630-636` is explicit about the reasoning and about the cost:

> Past the bound, awaiting inline would stall the generation's sole reader for a
> frame deadline and starve a queued Pong into a liveness false-kill. A peer with
> 32 no-dispatch rejections already stuck on contended egress is past its
> capacity grant: retire the generation instead (O(1), no reader stall). The
> unemitted terminals become outcome_unknown, which is the documented result of
> retirement (protocol §6.3).

Callers of `emit_rejection`, all on the pre-dispatch path:

| Caller | Cause | Code |
| --- | --- | --- |
| `dispatch.rs:846` | host draining | `server_busy` |
| `dispatch.rs:863` | advisory route lookup failed | `unknown_channel` |
| `dispatch.rs:886` | pending permit exhausted | `server_busy` |
| `dispatch.rs:898` | task permit exhausted | `server_busy` |
| `dispatch.rs:1093` | authoritative registration refused | `server_busy` or `unknown_channel` |
| `connection.rs:626` | control pending permit exhausted | `server_busy` |

The read loop has a parallel bound for oversize-control rejections at
`connection.rs:430-434`, which on exhaustion does the same thing — cancel,
discard, and return `ReadExit::Peer` — with the comment at `:426-429` giving the
same reasoning.

## Failure scenario

1. A client saturates the egress byte budget, which
   `tests/dispatch.rs:788` (`egress_budget_deadline_retires_the_generation`)
   shows is reachable.
2. The client sends 33 or more requests that fail admission — trivially arranged
   by targeting a channel it has closed, which takes gate 4 at
   `dispatch.rs:861`.
3. The first 32 spawn rejection tasks, all blocked in
   `charge_frame_or_cancel` waiting on the contended budget.
4. The 33rd finds the semaphore empty, cancels the generation, and discards the
   writer queue.
5. Any other correlation whose terminal was already queued loses it.

Effect accounting: attempted rejections are 33; queued rejections are at most 32
and possibly 0 if the budget never freed; acknowledged rejections are unknown,
because rejection terminals carry no `written` hook on this path
(`emit_error_terminal` at `dispatch.rs:370-394` builds its frame through
`emit_reserved_frame`, which hard-codes `written: None` at `:358`). Terminals for
unrelated correlations move from queued to discarded, so their acknowledged count
drops to zero after their attempted count was already recorded as settled.

## Timing windows and dependencies

The window is the 32 in-flight rejections, which persists only while the egress
budget stays contended. `charge_frame_or_cancel` (`dispatch.rs:143-168`) bounds
each wait at `gen.writer.admission_deadline()`, and a wait that expires *also*
cancels the generation (`:163`). So the window closes one of three ways: the
budget frees, the deadline expires (cancelling the generation anyway), or a 33rd
rejection arrives (cancelling the generation). All three exits either drain the
rejections or retire the generation, which is why the property's disjunction
holds.

Dependency: the bound is per-generation, so a client with many generations
multiplies its rejection concurrency by the connection count. That is bounded
separately by `connection_permits` (`runtime.rs:123`), which is sub-part 2f's
scope.

## What a test must construct

1. Start a host with a small egress budget so it saturates, as
   `tests/dispatch.rs:788` and `:712` already arrange.
2. Open a route, then close it, so subsequent requests take gate 4.
3. Pipeline 33 or more requests on the closed route without reading the socket,
   so the rejections cannot drain.
4. Assert either that a `server_busy` or `unknown_channel` terminal is queued for
   each correlation, or that the generation is cancelled — the disjunction.
5. The blast-radius arm: settle one *unrelated* request successfully just before
   the 33rd rejection, and assert its terminal is lost when `discard()` runs.

No existing test constructs `busy_rejects` saturation. `tests/dispatch.rs:271`
(`an_unknown_route_is_refused_with_zero_dispatch`) and `:295`
(`saturated_request_capacity_returns_server_busy_without_dispatch`) both exercise
the healthy single-rejection path, and neither binary is named in any CI
workflow.

## Investigation log

### Q: Is the permit acquired before or after the spawn?

- Sources examined: `dispatch.rs:620-628`; `connection.rs:430-450`.
- Findings: before, on both paths. `connection.rs:426-429` states the reason
  explicitly: "Acquired BEFORE spawning: past the bound a peer streaming
  oversize bodies would otherwise accumulate tasks, oneshots, and captured
  Arcs".
- Missing evidence: none.
- Conclusion: resolved with answer — the bound genuinely caps task creation, not
  merely concurrent emission.

### Q: Does `discard()` really drop already-queued frames for other correlations?

- Sources examined: `frame_channel.rs:701-703` (`discard` cancels the `discard`
  token), and the `FrameSender` fields at `:688-693`.
- Findings: `discard` is a `CancellationToken` on the sender, distinct from the
  `generation` and `finish` tokens. Its effect on already-queued frames is
  implemented in the writer drain, which is `frame_channel.rs` and
  `ring_transport.rs`, both Part 2b's scope. Part 2b's index contains
  `ring-a-rejected-drain-failure-close-has-no-producer` and
  `ring-a-publish-failure-is-reported-as-a-clean-peer-close`, which concern the
  drain, but I did not find a record pinning exactly which queued frames a
  `discard` drops.
- Missing evidence: the precise drop semantics of `discard` against a
  partially-drained queue.
- Conclusion: unresolved, needs Part 2b's `frame_channel.rs` drain semantics. The
  comment at `dispatch.rs:634-636` asserts the unemitted terminals become
  `outcome_unknown`, which implies they are dropped, but I am recording that as
  the code's claim rather than as verified behaviour.

### Q: Does protocol §10.2 permit an un-emitted `server_busy`?

- Sources examined: `docs/mc-host-wire-protocol.md` §10.2 row for `server_busy`
  and §8.3's finite-limits paragraph.
- Findings: §10.2 states "yes; host proves no handler dispatch (limit exhaustion
  before dispatch, Section 8.3)" without qualification. §8.3 adds "Rejection MUST
  NOT silently queue without a deadline", which the code honours — it does not
  queue at all past the bound. So the letter of §8.3 is satisfied while §10.2's
  unconditional terminal promise is not.
- Missing evidence: none.
- Conclusion: resolved with answer — a contract-versus-code disagreement,
  recorded as lead 2 in the lens file. Not resolved in the doc's favour.
