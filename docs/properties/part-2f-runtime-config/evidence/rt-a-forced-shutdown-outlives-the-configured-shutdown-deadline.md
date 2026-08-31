# rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline

## Discovery trigger

Tracing every consumer of `shutdown_deadline` for the configuration table. It
has exactly one read site, `runtime.rs:1148`, which computes a single absolute
`Instant`. Two `timeout_at` calls use it. Then a third wait appears at `:1224`
that does not.

## Evidence trail

The single absolute deadline, `runtime.rs:1148`:

```
let deadline = Instant::now() + shared.timing.shutdown_deadline;
```

Used twice as intended:

- `:1200` — `timeout_at(deadline, drain).await.is_ok()` bounds the whole route
  settle, read-fence, and Goodbye sequence.
- `:1214` — `timeout_at(deadline, shared.tracker.wait())` bounds the tracker
  drain after closure.

Then, inside the `:1214` failure branch, `runtime.rs:1223-1227`:

```
let lifecycle_chain = shared.timing.lifecycle_callback_deadline.saturating_mul(2);
if timeout(lifecycle_chain, shared.tracker.wait())
    .await
    .is_err()
{
```

This is `timeout`, not `timeout_at`. It arms a fresh relative budget at a moment
when `deadline` has already passed. At the defaults in `config.rs:225` (30 s) and
`:228` (10 s), the sequence is: 10 s absolute deadline expires, then a further
60 s is granted, so `shutdown_sequence` can return up to 70 s after shutdown
began. `run_handler_shutdown` at `:1240` then adds up to one more
`lifecycle_callback_deadline` (`:1276`), for 100 s total.

The justification is written out at `runtime.rs:1217-1222`:

> Abort-exempt lifecycle work self-bounds: a bind wrapper chains two callbacks
> (bind, then route-gone), each capped at `lifecycle_callback_deadline`. Wait out
> that chain before returning: `run` releases the instance lock when it returns,
> and releasing it while a callback still owns the handler would let a successor
> start against the predecessor's in-flight cleanup.

That reasoning is correct and the constraint is real. The factor of two is
derived from a specific chain length, not chosen arbitrarily.

The rule it contradicts, `docs/mc-host-wire-protocol.md:731`:

> Every operation owns one absolute deadline; per-stage timers MUST NOT multiply
> it.

And §12 (`:749-757`) states the host's shutdown obligations without any value, so
`shutdown_deadline`'s meaning is defined only by `config.rs:214-215` ("Whole
graceful-shutdown drain") and by this code.

Note the word "graceful" in `config.rs:214`. The forced path is not the graceful
drain, so a narrow reading says `shutdown_deadline` never claimed to bound it.
The counter-reading is that `:1148` computes one deadline for the entire
function, uses it for both graceful phases, and then abandons it — and that a
supervisor budgeting a stop has no other number to use.

If shutdown never expires, none of this runs: `:1243` returns
`run_handler_shutdown(shared).await && drained_in_time` on the normal path.

`saturating_mul(2)` also means a `lifecycle_callback_deadline` above half of
`MAX_CONFIG_DURATION` yields a derived budget of roughly 730 days, which
`validate` would reject as an input (`config.rs:360-362`). It cannot overflow or
panic, so this is an internal coherence gap rather than a defect.

There are three further unbounded waits on adjacent paths, all deliberate and
all documented:

- `retain_lock_until_drained` (`:257-271`), two `tracker.wait()` calls with no
  bound. Justified at `:252-256`.
- `retain_lock_until_stopped` (`:291-309`), `task.await` with no bound. Justified
  at `:281-290`.
- `AbandonGuard::drop`'s spawned cleanup (`:449-474`), two `tracker.wait()`
  calls. Justified at `:452-457`.

Those run on detached tasks after `run` returns, so they do not extend `run`'s
own duration. `:1224` does.

## Failure scenario

A supervisor is configured to send a stop signal and hard-kill after a grace
period. The natural grace period is `shutdown_deadline` plus margin — the only
shutdown number the host exposes — so it picks 15 s for a 10 s deadline.

A route's bind wrapper is inside a non-yielding poll. `:1214` expires at 10 s.
`:1205-1206` aborts what it can and force-closes routes, but the abort-exempt
lifecycle callback (spawned via `spawn_lifecycle` at `:167`, which deliberately
retains no abort handle) keeps running. `:1224` grants 60 s more.

At 15 s the supervisor sends `SIGKILL`. The host dies inside a lifecycle callback
that still owns the handler. The instance lock dies with the process, which
`:1222` and `:454-457` both note is acceptable for the lock itself. What is lost
is the ordered handler drop the comment at `:939-941` describes ("Handler drop
precedes lock release ... protocol §12 steps 6-8"), and any component-owned work
the shutdown callback would have drained (`:461-466`).

So the supervisor's kill lands precisely in the window the code went to trouble
to protect, because the host publishes a 10 s number and can take 100 s.

## Timing windows and dependencies

Sequential phases inside `shutdown_sequence`:

1. `:1150-1155` freeze admission; `:1159` demote phase. No budget.
2. `:1169-1200` the drain, bounded by the absolute `deadline`.
3. `:1202-1207` on failure, `abort_all` then `force_close_all_routes`. Unbounded
   in itself; `force_close_all_routes` is `dispatch.rs`'s, so its internal budget
   is 2e's question.
4. `:1212-1214` close the tracker, bounded by the same absolute `deadline`, which
   by now may already be in the past — in which case `timeout_at` returns
   immediately with `Err`.
5. `:1223-1239` the fresh `2 * lifecycle_callback_deadline` budget.
6. `:1240` or `:1243` `run_handler_shutdown`, itself bounded by one
   `lifecycle_callback_deadline` at `:1276`.

Phase 4's immediate expiry is worth naming: if the drain in phase 2 consumed the
whole deadline, phase 4 gets zero time before falling into phase 5. So the
practical shape is "10 s of graceful drain, then 60 s, then 30 s".

Dependency: the `AbandonGuard` (`:929-931`) is still armed while
`shutdown_sequence` runs, since `disarm` happens at `:937`. If the `run` future
is dropped during phase 5, the guard's `Drop` (`:419-477`) takes over with its
own unbounded waits, and `run_handler_shutdown`'s once-latch (`:1265-1270`)
decides which path invokes the callback.

## What a test must construct

A tracked, abort-exempt task that outlives `shutdown_deadline`, then a
measurement of elapsed virtual time from cancellation to `run`'s return.

The ingredients exist. `tests/lifecycle.rs:678` and `:714-715` already set
`lifecycle_callback_deadline` to 300 ms and `shutdown_deadline` to 3 s, so the
forced path is reachable and the two values are distinguishable. A handler whose
`on_route_gone` or bind callback does not yield produces the abort-exempt
survivor.

Under `#[tokio::test(start_paused = true)]`, assert elapsed is at most
`shutdown_deadline + 2 * lifecycle_callback_deadline + lifecycle_callback_deadline`
and strictly greater than `shutdown_deadline`. The second half of that assertion
is the one that documents the surprise.

The cheapest production guard is a single log or metric at `:1223` recording that
the deadline was exceeded and by how much, so an operator sizing a supervisor
grace period has the real number rather than the configured one.

## Investigation log

### Q: is `saturating_mul(2)` reachable with a value that would overflow?

- Sources examined: `runtime.rs:1223`, `config.rs:81`, `:356-363`.
- Findings: `lifecycle_callback_deadline` is validated at most
  `MAX_CONFIG_DURATION` = 365 days, so `* 2` is at most 730 days, far below
  `Duration`'s range. `saturating_mul` never saturates in practice. The derived
  value exceeds what `validate` would accept as an input whenever the configured
  value is above ~182 days.
- Missing evidence: none.
- Conclusion: resolved with answer — cannot overflow or panic. It is an internal
  coherence gap only, and `saturating_mul` is defensive rather than load-bearing.

### Q: does the `config.rs:214` wording "graceful-shutdown drain" exempt the forced path?

- Sources examined: `config.rs:213-215`, `runtime.rs:1142-1148`,
  `docs/mc-host-wire-protocol.md:749-757`.
- Findings: the doc comment says "Whole graceful-shutdown drain".
  `shutdown_sequence`'s own doc (`:1142-1143`) says "Graceful shutdown in
  protocol order (§12). Returns whether every host task was reaped in time." So
  the field's stated scope is the graceful path, and `:1223` is on the forced
  path. §12 in the specification gives the host's obligations with no value at
  all.
- Missing evidence: none.
- Conclusion: resolved with answer, and it cuts both ways. The narrow reading is
  defensible: `shutdown_deadline` never promised to bound forced shutdown. The
  property is still worth holding, because the number a supervisor needs is the
  total, and no field, comment, or specification line states it. The record's
  guarantee is phrased as "a stated function of the configured deadlines" rather
  than "at most `shutdown_deadline`" for exactly this reason.

### Q: do the three unbounded waits extend `run`'s duration?

- Sources examined: `runtime.rs:257-271`, `:291-309`, `:448-475`, `:951`.
- Findings: all three spawn onto `tokio::runtime::Handle::try_current()` and are
  not awaited by `run`. `:951` calls `retain_lock_until_drained` and then falls
  through to `:954`, returning immediately.
- Missing evidence: none.
- Conclusion: resolved with answer — no. Only `:1224` extends `run`. The detached
  reapers hold the instance lock past `run`'s return, which is a separate property
  and belongs to Part 2a's lifecycle territory.
