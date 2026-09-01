# the-writer-task-is-abortable-through-a-stated-owner

## Discovery trigger

The forced shutdown path is `shared.abort_all()` at `runtime.rs:1182` and again
at `:1192`, and it iterates `abort_handles` — the registry that only
`spawn_tracked` writes (`runtime.rs:151-154`). Checking which connection-path
tasks are missing from that registry found the writer: it is the one task on the
default TCP path that the forced sweep cannot abort directly, while the tracker
wait at `runtime.rs:1191` still blocks on it.

## Evidence trail

The spawn form is unambiguous. `connection.rs:187`:

    let writer_task = AbortOnDropHandle::new(shared.tracker.spawn(channel_io));

`shared.tracker.spawn` is `TaskTracker::spawn` called directly on the field, not
`shared.spawn_tracked`. The two helpers differ by exactly one action:
`spawn_tracked` (`runtime.rs:146-155`) calls `self.tracker.spawn(future)` and
then pushes `handle.abort_handle()` into `abort_handles`; `spawn_lifecycle`
(`runtime.rs:162-168`) calls `self.tracker.spawn(future)` and stops. Site `:187`
takes neither helper, so it lands in the same state as `spawn_lifecycle` —
tracked, no abort handle — but without `spawn_lifecycle`'s documented
abort-exempt rationale. The promoted arm repeats the shape at `:210`, re-wrapping
the candidate I/O handle that `:1081` created; that one *is* in `abort_handles`,
because `:1081` uses `spawn_tracked`.

Consequences, both verified. The writer is covered by
`shared.tracker.wait()` (`runtime.rs:1191`), because `TaskTracker::spawn`
enters the tracker. It is not covered by `abort_all`, because no handle was
registered.

The three-link abort chain, traced end to end:

1. **Sweep aborts the connection task.** The connection task is spawned at
   `runtime.rs:1017` with `shared.spawn_tracked`, so its abort handle *is* in
   the registry, and `abort_all` (`runtime.rs:211-221`) reaches it.
2. **The connection task's drop drops the handle.** `writer_task` is a local
   `AbortOnDropHandle` in `run_connection` (`connection.rs:187`), moved into
   `serve_generation` as the `io_task` parameter (`:193`, `:267`). Aborting the
   connection task drops that frame, dropping the handle.
3. **The handle's drop aborts the writer.** That is `AbortOnDropHandle`'s only
   contract.

Where the writer would otherwise park: `write_frames` (`tcp_frame_channel.rs:313`)
awaits `queue.recv()` at `:329` or the write itself at `:366-378`. The write arm
is wrapped in `timeout(write_deadline, ..)`, so a stalled peer is bounded per
frame at `frame_deadline`; the `queue.recv()` arm is not bounded and parks
indefinitely until every `FrameSender` drops. `serve_generation` closes that arm
explicitly with `writer_finish.finish()` at `connection.rs:354` before joining
the writer at `:361`, which is the graceful exit.

What breaks if either link changes. If `runtime.rs:1017` switched to
`spawn_lifecycle`, link 1 disappears: the connection task is tracked but not
abortable, so it stays parked at `connection.rs:361` awaiting a writer that is
itself parked, and `runtime.rs:1191` never returns. If `connection.rs:187`
switched from `AbortOnDropHandle::new(..)` to a bare `JoinHandle`, link 3
disappears: aborting the connection task drops a handle that does not abort, so
the writer survives its owner and the tracker wait blocks on it. Either way the
failure is the same: `run` holds the instance lock past the deadline.

Existing check: none for the forced path, confirmed. The in-crate writer tests
`tcp_frame_channel.rs:1062` `stalled_consumer_write_retires_generation_and_frees_charges`
and `:1130` `writer_failure_retires_generation` both drive
writer-*initiated* retirement — the writer decides to stop — not an external
abort arriving through the chain. They also use the `#[cfg(test)]`
`spawn_writer` helper (`tcp_frame_channel.rs:409-421`), whose `tokio::spawn` at
`:419` bypasses both the tracker and the abort registry, so they cannot observe
the chain at all.

## Failure scenario

1. A peer authenticates, opens a route, then stops reading its socket while the
   host has queued frames.
2. Graceful shutdown starts. The drain at `runtime.rs:1144-1176` queues
   Goodbyes at `:1168` and cancels tokens at `:1171`, but the writer is parked
   inside its per-frame `write_all` behind the stalled peer.
3. The drain misses `deadline`, so `drained_in_time` is false at `:1177` and the
   forced branch at `:1179-1184` runs.
4. `abort_all` aborts the connection task. Its frame drops, dropping
   `writer_task`, which aborts the writer. The tracker wait at `:1191` then
   completes.
5. If either link were broken, `:1191` would instead time out into the
   lifecycle-chain wait at `:1201`, and on a second expiry trip the fatal latch
   at `:1211-1214` and return false — with the instance lock still held, so a
   successor incarnation observes `AlreadyRunning`.

## Timing windows and dependencies

No narrow window; the dependency is on reaching the forced branch at all. That
needs a peer that authenticates and then stops reading, at least one queued
frame, and a drain slower than `shutdown_deadline`. The writer's own
`write_deadline` is `frame_deadline` (`tcp_frame_channel.rs:80`, default 30s per
`config.rs:224`), so one stalled frame alone can consume a shorter
`shutdown_deadline` and force the branch. Note the writer's stall bound applies
per frame, not to the whole drain: a peer reading one byte per deadline keeps
resetting it, which is the case where the chain is the only thing that
terminates shutdown.

## What a test must construct

A peer that completes authentication and then never reads, plus enough queued
frames that the writer parks inside `write_all`. Then a graceful shutdown whose
deadline is short enough to miss, so the forced branch runs. The oracle is that
the host tracker's wait completes and `run` returns — the catalog's phrasing,
"assert the host tracker's wait completes." Two negative controls make the test
prove the chain rather than incidental timing: assert that the *graceful* result
is non-graceful (so the forced branch really ran), and assert the fatal latch
was not tripped with "lifecycle callback did not stop before handler shutdown"
(`runtime.rs:1213`), which is the signature of link failure. This must not use
`spawn_writer`; it needs the real `run_connection` path, because the chain lives
in the handle ownership that `spawn_writer` bypasses.

## Investigation log

### Q: Is the omission deliberate, so the writer survives the sweep long enough to flush terminals and Goodbye? If so the compensating chain belongs in a comment.

- Sources examined: `connection.rs:178-196`, `:207-235`, `:263-278`, `:333-362`;
  `runtime.rs:143-168`, `:211-221`, `:1017-1019`, `:1119-1221`;
  `tcp_frame_channel.rs:64-92`, `:303-404`, `:406-421`, tests at `:1061`,
  `:1129`; `frame_channel.rs:758-882`.
- Findings: the reading is coherent and the code supports it. `abort_all` fires
  at `runtime.rs:1182`, *before* `force_close_all_routes` at `:1183` and before
  the tracker close at `:1190`. A writer exempt from the sweep can therefore
  still drain frames those later steps queue. That is the same rationale
  `runtime.rs:157-161` gives for `spawn_lifecycle`, and the comment at
  `connection.rs:355-360` explicitly argues against bounding the writer join
  with `route_close_budget` because it "could abort a drain that graceful
  shutdown promised to flush." So a deliberate exemption is consistent with the
  surrounding design.
- Missing evidence: no comment at `connection.rs:187` says so, and the site does
  not use `spawn_lifecycle`, which is the crate's declared way to spell
  "tracked but abort-exempt." Using the raw field instead of the named helper is
  what leaves the intent unrecorded. Nothing states whether the abort chain is a
  relied-upon mechanism or an accident of `AbortOnDropHandle` being convenient.
- Conclusion: needs human input. The mechanism and the chain are established and
  need no further investigation. Whether the record should assert "the writer is
  abort-exempt and flushes" or "the writer is reachable through the chain"
  depends on the answer, and those are different oracles.
