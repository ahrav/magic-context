# generation-registry-entry-released-on-every-connection-exit

Verified at `1c193ae0`. The catalog cites `d90e7811`; HEAD moved to the merge
commit `1c193ae0` and `git diff d90e7811 HEAD` is empty for `connection.rs`,
`dispatch.rs`, and `runtime.rs`.

## Discovery trigger

Insert and remove are 100 lines and one function apart, on opposite sides of the
whole read lifetime, and nothing between them is unwind-protected. The registry
holds an `Arc<GenerationCore>`, so a leaked entry is not just a stale key — it
keeps the writer sender, the pending map, the pings map, and the busy-reject
semaphore alive for the rest of the host's life, and it stays visible to a
shutdown that will then try to drain it.

## Evidence trail

- Insert: `connection.rs:288` `connections.insert(gen.id, Arc::clone(&gen));`,
  inside the lock taken at `:280`. Repo-wide grep confirms this is the only insert.
- Removal: `dispatch.rs:1386-1390`, the tail of `close_generation`
  (`:1371-1391`), which locks `shared.connections` and calls
  `.remove(&gen.id)`. Repo-wide grep confirms this is the only removal — the two
  other readers of the map (`runtime.rs:425-430` in `AbandonGuard::drop`,
  `runtime.rs:1151-1157` in the drain snapshot) iterate values and never remove.
- The single call to `close_generation` from the connection path is
  `connection.rs:345`, and it is *late*: it runs after `read_task.await` (`:304`),
  after the disposition match (`:306-332`), after
  `begin_close_generation` (`:338`), after `read_tasks.close()` and
  `read_tasks.wait().await` (`:339-340`), and after the shutdown rendezvous
  `gen.shutdown_complete.cancelled().await` (`:341-343`) when draining.
- Nothing guards the interval. There is no `catch_unwind` on this stack — repo-wide
  grep for `catch_unwind` in `crates/mc-host/src/` returns 9 hits, and the only one
  in `connection.rs` is `:907`, inside `handle_negotiate`'s eligibility callback,
  which contains a *handler* panic rather than protecting the registry. No `Drop`
  guard owns the registry entry: `GenerationCore` (`connection.rs:96-125`) has no
  `Drop` impl, and the only RAII on the stack is `AbortOnDropHandle` for the I/O
  task.
- The connection task is spawned at `runtime.rs:1017-1019` via `spawn_tracked`
  (`runtime.rs:146-155`), which is `tracker.spawn` plus an abort-handle push. A
  panic is therefore contained at the tokio task boundary — the process survives,
  the `JoinHandle` carries the `JoinError`, and nobody reads it (`:1017-1019`
  discards the handle). So a panicking connection task fails silently.
- What the leaked `Arc` retains: `connection.rs:97-124` — `writer: FrameSender`,
  `membership`, `pending`, `pings`, `busy_rejects`, and `liveness` (holding a
  `JoinHandle`). The `pending` map holds `Arc<Settlement>` per in-flight request
  (`:82-85`).
- What shutdown then does with it: `runtime.rs:1151-1157` snapshots the map, then
  `:1159-1162` cancels `read_cancel` and calls `read_tasks.close()`, `:1163-1165`
  awaits `read_tasks.wait()`, `:1167-1169` calls `send_connection_goodbye`
  (`dispatch.rs:1434-1452`, whose result is discarded at `:1442`), `:1170-1175`
  cancels the token and the `shutdown_complete` rendezvous. All of it against a
  generation whose task no longer exists.
- Existing check: none, confirmed. No test in scope induces a panic or abort
  between `:288` and `dispatch.rs:1390`.

## Failure scenario

1. A connection registers at `connection.rs:288`.
2. A panic occurs on the `serve_generation` stack. Reachable sites, all of which
   unwind rather than return: any `.expect()` on a poisoned or contended lock
   (`:280` `"connections lock"`, `:302` `"liveness lock"`, `:505` `"pings lock"`),
   the `read_loop` body and everything it calls inline —
   `handle_control` (`:626`), `handle_negotiate` (`:839`), `grant_candidate`
   (`:1001`) — or `close_generation` itself before it reaches `dispatch.rs:1386`.
   Note the distinction: a panic in a *spawned* tracked task (the rejection
   emission at `connection.rs:452-464`, the route-close task at `:567-575`) does
   **not** unwind this stack, so those do not leak the entry.
3. The unwind drops `serve_generation`'s locals: the tracked `read_task` future,
   `writer_finish`, the `AbortOnDropHandle` (aborting the writer task), and the
   local `Arc<GenerationCore>`. It does not reach `:345`.
4. The unwind continues through `run_connection`, dropping `_connection_permit`
   (`:167`) — so capacity *is* returned — and the task dies. `shared.connections`
   still holds its `Arc`.
5. Consequence: the entry is permanent, since the only remover is on the stack that
   just died. At shutdown, `runtime.rs:1163-1165` awaits `read_tasks.wait()` on a
   tracker whose tracked future was dropped during the unwind, so it returns; then
   `send_connection_goodbye` at `:1168` tries to admit a frame on a writer whose
   task was aborted at step 3. Because the abort drops the `SenderQueue` receiver,
   `tx.send` fails and `send_ticket_before` returns `WriterGone`
   (`frame_channel.rs:815-818`), which `:1442` discards — so the drain completes,
   but it has spent a pass on a dead generation and the retained `Arc` (pending
   settlements, pings, semaphore permits) is never freed.

## Timing windows and dependencies

The window is the entire served lifetime of a connection — `connection.rs:288` to
`dispatch.rs:1390` — which is the longest-lived window in Group A: seconds to
hours, not instructions. Every await inside it is a point at which an abort can
land, and every `.expect()` inside it is a point at which a panic can. There is no
configuration dependency. One interaction is load-bearing: if the panic occurs
while `shared.connections`'s `Mutex` is *held* (i.e. between `:280` and `:289`),
the lock is poisoned, and every subsequent `.expect("connections lock")` — at
`:280`, `dispatch.rs:1389`, `runtime.rs:1154`, `runtime.rs:428` — panics in turn,
so a single unlucky panic converts a leaked entry into a host-wide failure of every
registration, every close, and the drain snapshot. This record is a precondition
for `no-task-outlives-the-generation-it-serves` (a leaked entry is exactly a
generation whose task is gone) and for
`draining-rendezvous-is-released-or-the-loss-is-declared` (the drain waits on the
leaked entry's rendezvous).

## What a test must construct

A panic or an abort strictly between the insert and the removal (fault classes H2,
deterministic panic injection, partial — callback panics are injectable through the
test handler but internal points are not; and H3, task abort at a chosen point,
unavailable). Concretely, two tests:

- Panic: a failpoint on the `serve_generation` stack after `:288` — the cheapest
  real one available today is a handler callback that panics during `route.open`,
  since that path runs inline through `handle_control`. Drive one connection to a
  registered state, fire the panic, then assert `shared.connections` no longer
  contains the id. Assert it directly on the map, not via a shutdown that
  completes: the drain completing proves nothing, because it tolerates a dead
  generation silently.
- Abort: `spawn_tracked` retains an abort handle (`runtime.rs:151-153`), so
  `shared.abort_all()` can be aimed at a connection task parked in the read loop.
  Assert the same postcondition.

Both need a second oracle for the retained `Arc`: hold a `Weak<GenerationCore>` in
the test and assert `upgrade()` returns `None` after the task ends, which catches
the retention even if some future code path removes the map key but leaks a clone
elsewhere. A third, cheap assertion worth adding with no new machinery: after the
panic, assert `shared.connections.lock()` still succeeds, which distinguishes a
leaked entry from a poisoned map. Coverage checks to emit:
`host_panic_between_generation_insert_and_remove` and
`host_generation_core_dropped_after_task_exit`.

## Investigation log

The catalog records no open question. The claims worth verifying are that
`close_generation` is the sole remover and that nothing protects the interval.

### Q: Is `dispatch.rs:1390` the only removal, and does any unwind path between insert and removal reach it?

- Sources examined: `crates/mc-host/src/connection.rs:96-125`, `:142-236`,
  `:263-363`, `:452-464`, `:567-575`, `:900-915`;
  `crates/mc-host/src/dispatch.rs:1371-1391`, `:1434-1452`;
  `crates/mc-host/src/runtime.rs:130-140`, `:146-160`, `:418-436`, `:1010-1021`,
  `:1119-1177`; `crates/mc-host/src/frame_channel.rs:800-826`, `:838-854`;
  repo-wide `grep -rn "connections" crates/mc-host/src/` and `grep -rn
  "catch_unwind" crates/mc-host/src/`.
- Findings: confirmed on both counts. Exactly one insert (`connection.rs:288`),
  exactly one remove (`dispatch.rs:1390`), and the two other accessors iterate
  without removing. No `catch_unwind`, no `Drop` impl, and no `scopeguard`-style
  RAII owns the entry; `GenerationCore` is a plain struct. The `AbandonGuard::drop`
  path at `runtime.rs:419-435` is the closest thing to a safety net and it
  deliberately does not remove — it cancels `read_cancel`, `shutdown_complete`, and
  `token` for every entry and then calls `abort_all()`, which is teardown of a
  dying host rather than release of one entry. One refinement to the catalog's
  Fault/timing angle: it lists "a panic in the read loop, control handling, grant,
  or close-route decision", but the close-route decision at `connection.rs:567-575`
  runs in a *spawned* tracked task, so a panic there does not unwind
  `serve_generation` and does not leak the entry. The leaking set is the inline
  stack only.
- Missing evidence: no executed proof. There is no internal panic injection point
  and no abort-at-a-chosen-point facility, so the leak is a reading of the
  structure rather than an observation, and the poisoned-lock escalation in
  particular is untested in either direction.
- Conclusion: resolved with answer — the single-remover structure is confirmed, the
  interval is unguarded, and an unwind on the inline stack leaks the entry and the
  `Arc` it holds. The catalog's list of panic sites needs the narrowing above.
