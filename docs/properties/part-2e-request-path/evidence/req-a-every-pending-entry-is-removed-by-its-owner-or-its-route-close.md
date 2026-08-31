# req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close

## Discovery trigger

Task 6 asked whether in-flight requests are bounded and what reaps them. Missing
reapers recur in every part of this catalog, so the question was which code owns
removal from `gen.pending` on each of the outer task's exits.

## Evidence trail

`gen.pending` is `Mutex<HashMap<PendingKey, PendingEntry>>`
(`connection.rs:95`), keyed by `(u16, u32, u64)` = `(channel, epoch, corr)`.
Insertion is a single site, `dispatch.rs:916-922`:

```
gen.pending.lock().expect("pending lock").insert(
    key,
    PendingEntry {
        cancel: cancel.clone(),
        settlement: Arc::clone(&settlement),
    },
);
```

`remove_pending` (`dispatch.rs:1097-1099`) is called from four sites inside the
outer task, covering all of its normal exits:

| Exit | Location |
| --- | --- |
| `start_rx` dropped, registration refused | `:935` |
| pre-handler cancellation already set | `:958` |
| join error that is not a panic | `:1059` |
| every other path, at the end of the task body | `:1066` |

`:1066` is the fall-through for the cancel arm, the panic arm, and all five
handler-outcome arms, because the `select!` block is followed by
`remove_pending(&gen_task, key);` at the task's last statement.

The one exit the outer task cannot cover is its own abort, because an aborted task
does not run its tail. `settle_route_work` compensates. It collects the keys under
the lock at `dispatch.rs:1332-1342`:

```
let keys: Vec<PendingKey> = gen
    .pending
    .lock()
    .expect("pending lock")
    .iter()
    .filter(|(key, _)| key.0 == handle.channel && key.1 == handle.epoch)
    .map(|(key, entry)| {
        entry.cancel.cancel();
        *key
    })
    .collect();
```

and removes them at `:1374-1380`, after the grace-then-abort-then-wait sequence,
under a comment that states the reason exactly:

```
// Aborted tasks never removed their own pending entries.
{
    let mut pending = gen.pending.lock().expect("pending lock");
    for key in keys {
        pending.remove(&key);
    }
}
```

**`force_close_all_routes` has no equivalent.** Its body is
`dispatch.rs:1421-1452`, and per route it does: abort every handle, close and
wait on the tracker, trip the fatal latch if the wait fails, then
`run_route_gone` and `finalize_close`. It never touches `gen.pending`. It also
never obtains a `gen`: `registry.force_drain()` returns
`(RouteHandle, Vec<AbortHandle>, TaskTracker)` (`routing.rs:398`), with no
`Arc<GenerationCore>`, unlike `CloseDecision::Owner` which carries one
(`routing.rs:74-78`). So the forced path structurally cannot sweep the map.

`close_generation` (`dispatch.rs:1394-1414`) removes the generation from
`shared.connections` at `:1409-1413` after all its route closes finish. That drops
the host's `Arc<GenerationCore>`, and once every other holder drops, the whole map
goes with it. `force_close_all_routes` does not call `close_generation`.

## Failure scenario

1. Host shutdown begins. The graceful drain runs until `shutdown_deadline`
   (10 s default, `config.rs:228`) expires with requests still in flight.
2. The forced path runs `force_close_all_routes`.
3. For each route it aborts the outer dispatch tasks it holds handles for.
4. Each aborted outer task does not reach `:1066`, so its pending entry stays.
5. Nothing removes it. `run_route_gone` and `finalize_close` follow; the registry
   slot is freed; the map entry remains.

The stranded entry holds a `CancellationToken` and an `Arc<Settlement>`. Two
consequences:

- `handle_cancel` for that key (`dispatch.rs:1489-1496`) becomes a live no-op
  against a dead task: it finds the entry, sees `!is_settled()`, and cancels a
  token nothing is watching.
- The `Arc<Settlement>` and `Arc`-captured state are retained for the remaining
  life of the `GenerationCore`.

This is **not** unbounded growth. The map's size is capped by the pending-permit
pools, so the worst case is 928 general plus 96 reserved entries, each holding two
`Arc`s. It is a stranded-state finding, not a leak that grows with client
behaviour.

Effect accounting: the aborted requests are the same ones that take
`dispatch.rs:1058-1061` when their inner task is aborted, so they emit no
terminal. Attempted terminals for them are zero; the client's outcome is
`outcome_unknown`, which protocol §12 permits on the forced path ("Forced shutdown
may skip wire Goodbyes but MUST preserve local exactly-once route-gone and
handler-drop ordering"). So the *protocol* obligation is met; the *state hygiene*
obligation is the open one.

## Timing windows and dependencies

The window is the whole forced-shutdown path, which begins only after
`shutdown_deadline` expires. Reaching it requires a drain that does not complete
in 10 seconds at defaults.

Dependency on generation drop: if the `GenerationCore` is dropped promptly after
`force_close_all_routes`, the stranded entries are unobservable and the finding
collapses to a non-issue. I could not verify that. `force_close_all_routes` is
called from the shutdown sequence in `runtime.rs` or `harness_closure.rs`, both
sub-part 2f, and `close_generation`'s removal at `:1409-1413` is the only site in
*this* sub-part that drops the host's reference.

Dependency on the abort actually landing: `AbortHandle::abort` takes effect only
at an await point. `force_close_all_routes` waits on the tracker afterwards
(`:1433-1445`) and trips the fatal latch if the wait fails, so a non-yielding
handler makes the incarnation fatal rather than proceeding — which is the same
rule the graceful path applies at `:1358-1372`.

## What a test must construct

1. A handler that parks on a token the test does not release.
2. Send several routed requests so entries exist in `gen.pending`.
3. Trigger shutdown with a shrunk `shutdown_deadline` so the graceful drain
   cannot finish and the forced path runs.
4. Assert, after `force_close_all_routes` returns, that `gen.pending` is empty.
   This requires crate-internal access, since `pending` is `pub` on
   `GenerationCore` but `GenerationCore` is reachable only through
   `shared.connections`, which is also `pub` — so an in-crate integration test can
   reach it, but `tests/` cannot without an accessor.
5. The paired positive: run the same scenario through the *graceful* path and
   assert the map empties via `settle_route_work`'s sweep, confirming the
   asymmetry is between the two paths and not a general defect.

No existing test inspects `gen.pending` at all.

## Investigation log

### Q: Does `force_close_all_routes` have any path to `gen.pending`?

- Sources examined: `dispatch.rs:1421-1452` in full; `routing.rs:398-433`
  (`force_drain`'s return type and body); `routing.rs:69-84` (`CloseDecision`).
- Findings: `force_drain` returns no generation reference. `CloseDecision::Owner`
  carries `gen: Arc<GenerationCore>` and that is how `settle_route_work` reaches
  the map. The forced path deliberately returns less, presumably because it does
  not need to cancel entries (it aborts instead).
- Missing evidence: none.
- Conclusion: resolved with answer — structurally impossible on the forced path as
  written. Fixing it would require `force_drain` to return the generation.

### Q: Are all five outer-task exits covered on the graceful path?

- Sources examined: `dispatch.rs:932-1067`, tracing every `return` and the tail.
- Findings: `:935` and `:958` are explicit early returns with removal. `:1059` is
  the non-panic join-error arm with removal. `:1066` is the tail, reached by the
  cancel arm and by all other handler-outcome arms. So every non-abort exit
  removes.
- Missing evidence: none.
- Conclusion: resolved with answer — full coverage on non-abort exits.

### Q: Is the graceful path's sweep complete, or can an entry be inserted after the collection?

- Sources examined: `dispatch.rs:1332-1342` (collection), `:1374-1380` (removal),
  `routing.rs:255-269` (`begin_close_for`'s `Live` arm, which sets `Closing`,
  cancels, and removes membership under the registry lock),
  `routing.rs:294-320` (`register_dispatch`, which refuses unless
  `state == OccState::Live`).
- Findings: the transition to `Closing` happens under the registry lock *before*
  `settle_route_work` runs, and `register_dispatch` refuses any dispatch on a
  non-`Live` occupant. So no new entry for that route can be inserted after the
  decision was taken. A request already past `register_dispatch` is in the
  tracker, which the sweep waits on.
- Missing evidence: none.
- Conclusion: resolved with answer — the sweep is complete for its route, because
  the registry transition fences insertion.

### Q: Does the forced path always drop the `GenerationCore` immediately after?

- Sources examined: `dispatch.rs:1409-1413` (`close_generation`'s removal);
  callers of `force_close_all_routes` are outside this sub-part.
- Findings: `close_generation` is the only site here that drops the host's
  reference, and `force_close_all_routes` does not call it.
- Missing evidence: the shutdown sequence's ordering in `runtime.rs` or
  `harness_closure.rs`.
- Conclusion: unresolved, needs sub-part 2f. This is why the record's confidence
  is `medium` rather than `high`.
