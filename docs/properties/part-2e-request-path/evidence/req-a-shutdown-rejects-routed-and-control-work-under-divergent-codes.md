# req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes

## Discovery trigger

Task 1 asked whether rejection is uniform across request kinds. Building the
admission map put the two shutdown checks side by side, and they answer with
different codes for the same condition.

## Evidence trail

The condition is identical at both sites, character for character.

Routed dispatch, `dispatch.rs:844-855`:

```
if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
    drop(frame);
    emit_rejection(
        shared,
        gen,
        FrameId::routed(route, corr),
        CODE_SERVER_BUSY,
        "host is shutting down",
    )
    .await;
    return;
}
```

`route.open`, `dispatch.rs:1112-1122`:

```
if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
    emit_error_terminal(
        &shared.egress_budget,
        &gen,
        FrameId::control(corr),
        crate::control::CODE_TARGET_UNAVAILABLE,
        "host is shutting down",
    )
    .await;
    return;
}
```

Same predicate, same message, different code. The comment at `:1110-1111` says
"Same fence as routed dispatch: reject at the shutdown commit point, not only
once the later shutdown sequence stores `draining`", so the divergence is not a
different intent about *when* to reject; it is a different choice of code.

There is a third evaluation of the same fence, and it agrees with the routed
site. `dispatch.rs:1084-1092`, after `register_dispatch` refuses:

```
let (code, message) =
    if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
        (CODE_SERVER_BUSY, "host is shutting down")
    } else {
        (CODE_UNKNOWN_CHANNEL, "no live route for this channel and epoch")
    };
```

And a fourth, authoritative, under the registry lock: `routing.rs:305`,
`if !inner.accepting { return None; }`. `freeze_admission` (`routing.rs:209-211`)
sets that flag, and `handle_host_shutdown`'s write hook sets `draining` and calls
`freeze_admission` together inside the writer task (`dispatch.rs:752-753`), so the
commit point and both fences coincide.

Protocol §10.2's two rows:

| Code | Terminal | Fresh-RPC owner and rule |
| --- | --- | --- |
| `target_unavailable` | yes | "managed SDK MAY retry `route.open` with new correlation under bounded route deadline" |
| `server_busy` | yes; host proves no handler dispatch | "managed SDK MAY retry with backoff and a new correlation under its owning request deadline" |

The `target_unavailable` rule carries no backoff obligation. The `server_busy`
rule does.

Protocol §8.3 constrains which code is admissible:

> Limit exhaustion before dispatch of a routed or control request returns
> terminal `server_busy`; `target_unavailable` is reserved for route admission —
> `route.open` failures such as channel exhaustion (Section 8.2) — so each code
> keeps exactly one recovery rule in Section 10.2.

Shutdown is neither limit exhaustion nor channel exhaustion, so §8.3 does not
decide the case. §12 step 1 names `server_busy` but scopes it to "a complete,
valid routed `Request`", not to `route.open`.

## Failure scenario

1. An authenticated client sends `host.shutdown`. The commit hook fires inside
   the writer task, setting `draining` and freezing admission
   (`dispatch.rs:752-753`).
2. A second client — or the same one, pipelined — has both a routed `Request` and
   a `route.open` in flight behind that commit.
3. The routed request gets `server_busy` and, per §10.2, backs off.
4. The `route.open` gets `target_unavailable` and, per §10.2, may immediately
   retry with a new correlation inside its 30-second route deadline.
5. Each retry costs the draining host: a pending permit
   (`connection.rs:625`, class-selected), a `spawn_lifecycle` task
   (`connection.rs:721`), and a trip through `open_route` to the same rejection.

So the host sheds the traffic it can afford to shed and invites un-backed-off
retries of the traffic that costs it more, from exactly the clients it is trying
to drain.

Effect accounting is unaffected here — both codes are emitted terminals and both
prove no bind occurred, since exit 1 of `open_route` precedes `registry.reserve`.
The divergence is purely in the recovery rule the client applies.

## Timing windows and dependencies

The fence is checked advisorily twice per request kind and authoritatively once
under the registry lock, so the window between the advisory check and the
authoritative one is real but closed: a routed request that passes
`dispatch.rs:844` and then loses the race is caught at `routing.rs:305` and
answered by `dispatch.rs:1084-1092`, which picks `server_busy`. A `route.open`
that passes `dispatch.rs:1112` and then loses the race is caught by
`registry.reserve`'s own `!inner.accepting` check (`routing.rs:115`) and answered
at `dispatch.rs:1127-1137` with `target_unavailable` and the message "route
capacity exhausted" — which is now a *third* inconsistency, because the cause is
frozen admission, not capacity.

That third case is worth stating precisely: `reserve` returns `None` for three
distinct reasons (`routing.rs:115`) — frozen admission, a cancelled generation, or
`live >= max_routes` — and `open_route` reports all three as "route capacity
exhausted".

Dependency: `handle_host_shutdown`'s commit hook is what makes the fence
atomic with the commit point. If the hook is dropped unrun (every failure path at
`dispatch.rs:718-760` does drop it), `draining` is never set by that path and the
fence only engages once the later shutdown sequence stores it.

## What a test must construct

1. Start a host with a handler that can be held mid-request.
2. Send `host.shutdown` and wait for its `Response`.
3. On a second generation, send one routed `Request` and one `route.open`.
4. Assert the routed request's terminal code is `server_busy` and the
   `route.open`'s is `target_unavailable`, and record that both were caused by
   the same fence.
5. Separately: freeze admission without exhausting `max_routes`, send a
   `route.open`, and assert the message is "route capacity exhausted" even though
   capacity was not the cause — the third inconsistency.

No existing test compares the two codes. `tests/routing.rs:570`
(`route_capacity_exhaustion_is_refused_without_binding`) covers the genuine
capacity cause only, and it is not in CI.

## Investigation log

### Q: Is the message text also part of the contract?

- Sources examined: protocol §7.4, "Error `code` is stable; `message` is
  diagnostic unless this document states exact text" (§7.1 carries the same
  sentence).
- Findings: the message is explicitly diagnostic, so "route capacity exhausted"
  for a frozen-admission cause is not a contract violation. It is still a
  misleading operator signal.
- Missing evidence: none.
- Conclusion: resolved with answer — only the code choice is a contract question;
  the message mismatch is a diagnostics-quality finding.

### Q: Which code does the protocol intend for a `route.open` during shutdown?

- Sources examined: §8.3's reservation sentence, §12 step 1, §10.2's two rows,
  §7.2.
- Findings: §8.3 reserves `target_unavailable` for route-admission failures and
  gives channel exhaustion as the example, which shutdown is not. §12 step 1
  names `server_busy` and scopes it to routed requests, explicitly saying "stop
  accepting connections and route opens" without naming a code for the latter.
  Neither section decides it.
- Missing evidence: any protocol statement covering `route.open` during
  shutdown.
- Conclusion: needs human input. The design question is whether a draining host
  wants `route.open` clients to back off (favouring `server_busy`) or to retry
  quickly against a possible successor (favouring `target_unavailable`).

### Q: Could the divergence be deliberate, with `target_unavailable` chosen so clients retry against a restarted host?

- Sources examined: `dispatch.rs:1110-1111`'s comment; §10.2's
  `target_unavailable` row; §12's reconnect paragraph.
- Findings: the comment justifies the fence's *placement*, not the code. Nothing
  in the file or the doc argues for the code choice. §12 does say the client
  "MUST immediately invalidate its routes" on retirement, which suggests a fresh
  `route.open` after reconnect is expected — but that is after a reconnect, not
  an immediate retry against a draining host.
- Missing evidence: a design note or commit message explaining the code choice.
- Conclusion: unresolved, needs the author's intent. Recorded as lead 3.
