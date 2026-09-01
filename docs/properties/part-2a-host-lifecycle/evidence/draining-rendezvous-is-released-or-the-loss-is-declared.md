# draining-rendezvous-is-released-or-the-loss-is-declared

## Discovery trigger

`serve_generation` has one unbounded await on its teardown path. At
`connection.rs:341-343`:

    if shared.draining.load(Ordering::SeqCst) {
        gen.shutdown_complete.cancelled().await;
    }

No timeout, no competing `select!` arm. Tracing who cancels
`shutdown_complete` showed the only non-test writer sits at the very end of the
shutdown sequence's drain future, behind two loops that can consume the whole
deadline.

## Evidence trail

The await is verified as written: a bare `.await` on
`CancellationToken::cancelled()`, guarded only by the `draining` load. It runs
after `gen.read_tasks.wait()` at `:340` and before `close_generation` at `:345`.

The only non-test cancellation of `shutdown_complete` is `runtime.rs:1173-1175`:

    for gen in &generations {
        gen.shutdown_complete.cancel();
    }

That is the last of four sequential loops inside the `drain` future
(`runtime.rs:1144-1176`). Ahead of it: the route-settle loop at `:1145-1149`,
the read-cancel and close loop at `:1159-1162`, the `read_tasks.wait()` loop at
`:1163-1165`, the Goodbye loop at `:1167-1169`, and the token-cancel loop at
`:1170-1172`. The whole future is wrapped once at `:1177`:

    let drained_in_time = timeout_at(deadline, drain).await.is_ok();

So if the deadline expires anywhere in `:1145-1172`, the `drain` future is
dropped at that point and `:1174` never executes. Every generation parked at
`connection.rs:342` stays parked. `shutdown_complete` is a per-generation token
created fresh in `new_generation` (`connection.rs:249`) with no other writer, so
nothing else can release them.

The rescue is `shared.abort_all()` at `runtime.rs:1182`, in the
`!drained_in_time` branch. It reaches the parked connection task only because
that task was spawned with `shared.spawn_tracked` at `runtime.rs:1017`, which
registers an abort handle (`runtime.rs:151-154`). The catalog's conditional is
exact: had `runtime.rs:1017` used `spawn_lifecycle` (`:162-168`), no handle
would exist, `abort_all` would not reach the task, and the tracker wait at
`:1191` would block on a generation parked forever — with `run` holding the
instance lock. The same handle is link 1 of the writer abort chain, so one spawn
choice carries two properties.

The catalog's claim that the return value names the loss is verified but weak.
`shutdown_sequence` returns `bool`: `runtime.rs:1220` returns
`run_handler_shutdown(shared).await && drained_in_time`, and the two forced
returns at `:1215` and `:1218` return false. So a drain timeout is reported.
What is *not* distinguished is why: a drain that timed out in the route-settle
loop and a drain that timed out in the Goodbye loop produce the same `false`,
and a generation released at `:1174` is indistinguishable from one aborted
mid-rendezvous. There is no counter, no reason field, and no log — the crate has
no tracing dependency.

Corrected reference: the task brief placed `shutdown_sequence` at
`runtime.rs:1127-1195`. At HEAD it spans `:1119-1221`; `:1127-1129` is the
`draining` store inside it, and the function continues past `:1195` through the
lifecycle-chain wait at `:1200-1216` to the return at `:1220`.

## Failure scenario

1. Shutdown starts. `draining` is stored at `runtime.rs:1127-1129`.
2. A generation's read loop exits inside the drain window — peer EOF, a corrupt
   frame, or the read cancel at `:1160`. `serve_generation` reaches `:341`,
   observes `draining` true, and parks at `:342`.
3. The route-settle loop at `:1145-1149` is slow: each `settle_route` waits on
   the route's dispatch tracker under `route_close_budget`
   (`dispatch.rs:1325-1337`), and `finish_route_close` runs a route-gone
   callback bounded by `lifecycle_callback_deadline`
   (`dispatch.rs:1239-1250`). Enough routes multiply those budgets past
   `shutdown_deadline`.
4. `timeout_at` at `:1177` fires. The `drain` future is dropped mid-loop.
   `:1174` never runs. The generation is still parked at
   `connection.rs:342`.
5. `abort_all` at `:1182` aborts the connection task. The generation never
   reaches `close_generation` at `:345`, so its registry entry is never removed
   by that path, and it never runs `writer_finish.finish()` at `:354`. The
   graceful-close promise degrades to task abort, and the only signal is a
   `false` return that says nothing about which generation lost what.

## Timing windows and dependencies

Three conditions must coincide. `draining` must be true when the generation
reaches `connection.rs:341` — that is the whole interval from
`runtime.rs:1127` onward, or from the commit hook's store at
`dispatch.rs:729` on the `host.shutdown` path, so the window is wide. The read
loop must exit inside it. And the drain must consume `shutdown_deadline` before
`:1174`. The last is the real gate: the phases ahead of `:1174` are bounded by
`route_close_budget` and `lifecycle_callback_deadline` per route, multiplied by
route count, plus `read_tasks.wait()` at `:1164` which is bounded only by the
tracked emissions' own frame deadlines. This is `always-or-unreached` for a
real reason: when `draining` is false at `:341` the branch is skipped, no task
parks, and the obligation does not exist — a check that fired then would be
wrong.

## What a test must construct

A generation parked at `connection.rs:342` while the drain misses its deadline.
Construct it with a `shutdown_deadline` short relative to a deliberately slow
route-settle phase: bind a route whose `route_gone` callback sleeps, so
`finish_route_close` at `runtime.rs:1147` consumes the budget, and arrange a
second generation whose read loop exits during the window (drop its client
socket). The oracle has two halves, matching the catalog's check. After
`shutdown_sequence` returns, no task is parked at the rendezvous — observable as
the tracker wait completing and `run` returning. And the return value is
non-graceful. The second half is what makes the test meaningful: without it, an
abort-rescued hang passes as success. Add the negative control that the fatal
latch was not tripped with `runtime.rs:1213`'s message, which distinguishes
abort-rescued from unrescued.

## Investigation log

### Q: Should the rendezvous carry its own timeout, or is "escaped only by the forced sweep" the intended contract? If the latter, the connection task's choice of spawn helper is a correctness requirement rather than a style choice.

- Sources examined: `connection.rs:244-258`, `:333-362`; `runtime.rs:143-168`,
  `:211-221`, `:1017-1019`, `:1119-1221`; `dispatch.rs:721-731`,
  `:1239-1255`, `:1297-1349`, `:1391-1401`.
- Findings: the mechanism is settled. The await is unbounded, the only release
  is the last statement of a future that a single `timeout_at` can drop
  mid-flight, and the only escape is `abort_all` reaching a handle that exists
  because of one spawn-helper choice at `runtime.rs:1017`. The design comment at
  `runtime.rs:1136-1143` explains why route settlement precedes the read-side
  fence, and the comment at `connection.rs:333-337` explains why closes are
  marked before the wait, so the ordering is reasoned. Neither comment addresses
  what happens when the deadline lands inside that ordering.
- Missing evidence: nothing states whether abort is the intended escape. There
  is no comment at `connection.rs:341-343` at all, and none at
  `runtime.rs:1017` marking the spawn helper as load-bearing. The catalog's own
  severity assessment is medium for this reason, and the code cannot arbitrate:
  it is consistent with "abort is the contract" and with "this await should have
  had a timeout."
- Conclusion: needs human input. If abort is the contract, the property is a
  reachability claim about `abort_all` plus a documentation obligation at both
  sites; if not, it is a liveness defect in the rendezvous. The mechanism needs
  no further investigation either way.
