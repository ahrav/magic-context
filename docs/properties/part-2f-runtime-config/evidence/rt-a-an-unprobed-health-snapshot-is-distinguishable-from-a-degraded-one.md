# rt-a-an-unprobed-health-snapshot-is-distinguishable-from-a-degraded-one

## Discovery trigger

The task brief asks whether an absent configuration is distinguishable from an
empty one. `HostConfig` has no file form, so there is no literal absent-versus-
empty case. The structural analogue in this sub-part is the health snapshot: a
value seeded at construction that looks exactly like a real observation.

## Evidence trail

The seed, `runtime.rs:889-893`, verified verbatim:

```
health_snapshot: RwLock::new(HealthReport {
    status: HealthStatus::Degraded,
    detail: None,
    metrics: Some(serde_json::json!({"components": {}})),
}),
```

The field's doc comment, `runtime.rs:101-103`:

> Last completed sanitized component health snapshot. Authenticated
> `host.status` reads this without invoking a lifecycle callback.

"Last completed" is the claim. At construction there has been no completed
probe, and the field nevertheless holds a fully-formed `HealthReport`.

The reader, `connection.rs:686-698`, under `ControlAction::HostStatus`:

```
let report = shared_task
    .health_snapshot
    .read()
    .unwrap_or_else(std::sync::PoisonError::into_inner)
    .clone();
let body = crate::control::host_status_response_json(
    &report,
    shared_task.ring.diagnostics(),
);
```

No freshness check, no "has a probe run" flag, no timestamp.

The only writer is `runtime.rs:1120-1123`, inside the health loop's
`Ok(Some(report))` arm.

Ordering. `spawn_health_task` is called at `runtime.rs:933`; `accept_loop` at
`:934`. The health task's loop body (`:1079` onward) has no initial sleep, so the
first probe is issued immediately, but it is issued on a *spawned* task
(`:1078`), and the accept loop begins on the next line. So a client can
authenticate and issue `host.status` before the first probe stores anything.

The probe's own bound is `lifecycle_callback_deadline` (`:1084`, applied at
`:1101`), 30 s at defaults, and `lifecycle_join` (`:1117`) applies the same
deadline again around the join. So the window is up to 30 s under a slow
`handler.health`.

**The distinguishing signal exists but is incidental.** A real report always
carries at least one component:

- `build_target_index` refuses an empty manifest set (`runtime.rs:500`), so a
  started host has one to three modules.
- `composite.rs:334` builds `let mut components = serde_json::Map::new();` and
  populates one entry per component, wrapped at `:348` as
  `serde_json::json!({"components": components})`.

So `components: {}` is producible only by the seed. Nothing states that, and no
test asserts it. `HealthStatus::Degraded` itself is a legitimate steady-state
value: `docs/mc-host-wire-protocol.md:685` says "Waiting for a predecessor's
storage lease reports `degraded` without making transport unready."

One consequence of the empty map worth recording: the activation predicate at
`runtime.rs:1051-1074` reads `metrics.components` and calls `.values().any(..)`.
On an empty map that is `false`. The seed is never passed to the predicate
(only real reports are, at `:1119`), so this is latent rather than active, but it
means the seed would read as "activation not in progress" if it ever were.

## Failure scenario

A supervisor or readiness gate polls `host.status` after the connection file
appears and treats `degraded` as "do not send traffic yet" or, worse, as
"restart".

The host is healthy. Its handler's first `health` callback is slow, because it is
interrogating a store that is itself opening — the exact case
`docs/mc-host-wire-protocol.md:685` sanctions. The supervisor reads the seeded
`Degraded`, concludes the host is unhealthy, and withholds traffic or cycles the
process. Cycling makes it worse: the successor pays the same slow first probe,
and `AlreadyRunning` from the lock retry loop (`runtime.rs:667-671`, four
attempts over 75 ms) may add a start failure on top.

The signal that would prevent this — `components` being empty — requires the
supervisor to know that a never-probed host emits an empty map, which is stated
nowhere.

## Timing windows and dependencies

The window opens at `runtime.rs:933` and closes on the first successful store at
`:1120-1123`. Its length is the handler's first `health` latency, bounded by
`lifecycle_callback_deadline`.

`accept_loop` starting at `:934` makes the window client-visible. Before it, no
socket is accepted, so nothing can read the snapshot.

Two ways the window never closes:

- `Ok(None)` at `:1126` returns from the loop. That arises from shutdown
  cancellation (`:1100`) or a probe deadline expiry that tripped the fatal latch
  (`:1105-1108`). In the second case the snapshot stays seeded for the rest of
  the incarnation, while the fatal latch drives shutdown.
- `Err(_)` at `:1127` returns likewise, after `lifecycle_join` tripped the latch
  (`:192-193` or `:204-205`).

So on either failure path the snapshot is permanently the seed, and `host.status`
reports `Degraded` with an empty component map for as long as connections are
still served during the shutdown drain.

Lock discipline: `RwLock` with `unwrap_or_else(PoisonError::into_inner)` at both
`:1123` and `connection.rs:694`, so a poisoned lock does not deny reads. That is
consistent with Part 2a's panic-containment territory and I do not restate it.

## What a test must construct

A handler whose first `health` callback blocks for a controllable interval, then
a client that authenticates and issues `host.status` inside that interval.

`tests/lifecycle.rs:579` already sets `lifecycle_callback_deadline` to 10 s for a
slow-callback scenario, so the shape exists. The addition is a `health`
implementation that awaits a test-controlled signal on its first call and returns
promptly thereafter.

The oracle: assert the response's `metrics.components` is empty when
`status == "degraded"` and no probe has completed, and non-empty once one has.
That asserts the distinguishing precondition rather than the defect.

The stronger fix, which the check should be written to accommodate, is an
explicit marker. Either seed the snapshot with a distinct status, or add a
`probed: bool` or a `first_probe_at` field so a client does not have to infer
freshness from an empty map. Deciding that is not this pass's business.

## Investigation log

### Q: does `host_status_response_json` add any freshness information?

- Sources examined: `control.rs:551`, `:601`, and the call at
  `connection.rs:696-699`.
- Findings: `:601` emits `"metrics": {"components": components}`, so the response
  carries the component map through. `:551` reads `components` for its own
  purposes. I did not read the whole function; it is `control.rs`, which belongs
  to sub-part 2e.
- Missing evidence: whether `host_status_response_json` adds a timestamp or a
  staleness field of its own.
- Conclusion: unresolved, needs 2e. If it does add one, the property is already
  satisfied and this record downgrades to an observation. The seed's own shape is
  verified either way.

### Q: can a real composite report ever be empty, making the signal useless?

- Sources examined: `runtime.rs:500`, `composite.rs:305-348`.
- Findings: `build_target_index` returns `InitFailed` for `manifests.is_empty()`,
  so a running host has one to three modules. `composite.rs:334-348` inserts one
  entry per component, including a `panicked` placeholder at `:313-317` for a
  component whose callback panicked, which still occupies a key.
- Missing evidence: none.
- Conclusion: resolved with answer — a real report is never empty, so
  `components: {}` uniquely identifies the seed today. It is an emergent property
  of two unrelated code paths and is asserted by neither.

### Q: is the window actually reachable, or does the first probe always win the race?

- Sources examined: `runtime.rs:933-934`, `:1076-1092`.
- Findings: the health task is spawned, not awaited. `accept_loop` runs on the
  same task as `run`. Under a multi-thread runtime both proceed concurrently; the
  probe must complete a `spawn_lifecycle` round trip plus the handler callback
  before storing. A client still has to connect, authenticate, and send a control
  frame, which is slower in the common case. So with a fast handler the window is
  narrow.
- Missing evidence: none.
- Conclusion: resolved with answer — reachable but narrow by default, and wide
  exactly when it matters, which is a slow or blocked first probe. That is why the
  record's required enabling state is a blocking `health` rather than a race.
