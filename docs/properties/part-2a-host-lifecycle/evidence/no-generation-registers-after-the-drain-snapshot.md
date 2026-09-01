# no-generation-registers-after-the-drain-snapshot

## Discovery trigger

`shutdown_sequence` snapshots the connection registry exactly once
(`runtime.rs:1151-1157`) and then waits on every generation in that snapshot,
including the `shutdown_complete` rendezvous each parked generation depends on
(`:1174`). A generation registered after the snapshot would park at
`connection.rs:342` with nothing left to release it. Checking what stops that
found two orderings that both hold and neither of which is asserted.

## Evidence trail

The snapshot is one-shot and non-refreshing:

    let generations: Vec<Arc<GenerationCore>> = shared
        .connections
        .lock().expect("connections lock")
        .values().cloned().collect();

`runtime.rs:1151-1157`. The four loops that follow (`:1159-1175`) all iterate
`&generations`. The forced branch at `:1179-1184` does not re-snapshot either; it
calls `abort_all` and `force_close_all_routes`, neither of which touches
`connections`.

The registration gate is `connection.rs:279-289`, and the whole check plus insert
sit inside one lock scope:

    let mut connections = shared.connections.lock().expect("connections lock");
    if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
        return None;
    }
    connections.insert(gen.id, Arc::clone(&gen));

That is the second of the catalog's two orderings, and it is the load-bearing
one. Because the check and the insert share the scope, and the snapshot takes the
same mutex, the two are serialized: either the insert wins and the generation is
in the snapshot, or the snapshot wins and the later check reads a `draining`
value stored before it.

The first ordering is the store. `runtime.rs:1127-1129` stores `draining` with
`Ordering::SeqCst` before anything else in the sequence, and the snapshot at
`:1151` happens after. So a registration that acquires the lock after the
snapshot cannot read `false`.

One refinement to the catalog's phrasing. It says the store precedes the snapshot
"with an await between." At HEAD there is no unconditional await there: between
`:1129` and `:1151` sit `freeze_admission()` (`:1130`), `begin_stopping()`
(`:1134`), and the route-settle loop at `:1145-1149` whose body awaits only if
`shared.registry.all_routes()` is non-empty. With zero live routes the store and
the snapshot are separated by synchronous code only. This does not weaken the
property: the SeqCst store plus the shared mutex is what serializes the two, and
the await is not load-bearing. Recorded because a test written to rely on the
await would be testing the wrong thing.

The catalog's note that the second `draining` writer is a writer task, not the
shutdown path, is verified. `dispatch.rs:720-733` installs the `host.shutdown`
response's completion hook, and its body runs inside the writer task
(`tcp_frame_channel.rs:393-395`):

    shared.draining.store(true, Ordering::SeqCst);
    shared.registry.freeze_admission();
    commit.acknowledge();

So `draining` becomes true at the commit point, before `shutdown_sequence` runs
at all, and it is a writer task that stores it. That is why
`connection.rs:285` reads `shutdown.is_cancelled()` as well: `commit.acknowledge()`
cancels the shutdown token, and the in-code comment at `connection.rs:281-284`
records exactly that window.

Existing check: none, confirmed. The comment at `connection.rs:281-284` documents
only the token half of the window — the gap between a committed `host.shutdown`
and the sequence storing `draining`. Nothing in code or comment states the
snapshot half, which is the obligation this property names.

Corrected reference: the task brief placed `shutdown_sequence` at
`runtime.rs:1127-1195`; at HEAD it spans `:1119-1221`.

## Failure scenario

The scenario is what the two orderings prevent, stated so a test can try to
reach it.

1. A socket is accepted at `runtime.rs:997` and its task spawned at `:1017`.
2. `shutdown_sequence` stores `draining` at `:1127-1129`.
3. The connection completes authentication (`connection.rs:143-160`), acquires
   the connection permit at `:165`, mints a generation at `:188`, and reaches the
   registration gate at `:279`.
4. Suppose the load at `:285` read stale `false` — with `Relaxed` instead of
   `SeqCst`, or with the check outside the lock scope. The insert lands after the
   snapshot at `:1151`.
5. The generation is absent from `generations`, so `:1160` never cancels its
   read, `:1161` never closes its `read_tasks`, and `:1174` never cancels its
   `shutdown_complete`. Its read loop exits later, observes `draining` true at
   `connection.rs:341`, and parks at `:342` forever.
6. The connection task is in `abort_handles`, so `abort_all` at `:1182` rescues
   it on the forced path only. If the drain succeeded, the forced branch never
   runs, and the tracker wait at `:1191` blocks on the parked task until it
   times out into `:1201` and then trips the fatal latch at `:1211-1214`. One
   violation is a permanent hang, as the catalog states.

## Timing windows and dependencies

The window is from the `draining` store — at `runtime.rs:1127-1129`, or earlier
at `dispatch.rs:729` on the committed-`host.shutdown` path — to the snapshot at
`:1151`. A socket must be accepted before the store (accepts stop once
`shared.shutdown` is cancelled, `runtime.rs:996`) and complete authentication
inside the window, which is bounded by `auth_deadline`
(`connection.rs:153`). The interesting interleaving needs a multi-thread runtime:
on a current-thread runtime the shutdown task and the connection task cannot be
inside the two lock acquisitions concurrently, so the race is unreachable and a
current-thread test proves nothing.

## What a test must construct

A socket accepted and authenticated concurrently with the store-to-snapshot
interval, on `#[tokio::test(flavor = "multi_thread")]`. Because the window is
narrow, a plain race is unreliable; the honest form is to widen it deliberately —
insert at least one route so the settle loop at `:1145-1149` awaits, and make its
`route_gone` slow — then start a fresh connection during that phase. The oracle
is the catalog's: every generation that inserts either appears in the snapshot or
completed its close before the snapshot was taken. Observing that needs
instrumentation, since `generations` is a local. Two proxies are available
without it: graceful shutdown returns true (so no generation was left parked and
abort-rescued), and the tracker wait at `:1191` completes on the first attempt
rather than falling into `:1201`. Both are necessary; neither alone excludes a
generation that registered late and was rescued by abort.

## Investigation log

The catalog records no open questions for this property, and the investigation
did not raise one. Both orderings were traced to their sources and hold as
written; the only correction is the "await between" refinement above, which is
recorded in the evidence trail rather than left open.

- Sources examined: `runtime.rs:1119-1221`, `:988-1021`, `:143-168`,
  `:211-221`; `connection.rs:143-196`, `:244-258`, `:263-304`, `:333-345`;
  `dispatch.rs:641-757`; `tcp_frame_channel.rs:303-404`.
- Findings: the store at `runtime.rs:1127-1129` is `SeqCst` and precedes the
  snapshot at `:1151`. The check at `connection.rs:285` and the insert at `:288`
  share one lock scope, and the snapshot takes the same mutex. The gate reads
  both `draining` and `shutdown.is_cancelled()`, which closes the earlier
  commit-point window that `dispatch.rs:729-730` opens from a writer task. The
  snapshot is never refreshed, including on the forced path.
- Missing evidence: none for the mechanism. What is absent is any assertion:
  neither the in-code comment nor a test states the snapshot obligation, which
  is what the property exists to pin.
- Conclusion: resolved. The property holds at HEAD by two independent
  orderings, and the finding is that it is unchecked rather than unsound.
