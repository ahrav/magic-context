# req-a-handler-concurrency-is-bounded-by-two-class-scoped-permit-pairs

## Discovery trigger

Task 2 asked what bounds concurrent handler work and what happens when that bound
binds. Task 6 asked whether handler tasks are bounded at all, since unbounded
caller-driven growth recurs in every part of this catalog.

## Evidence trail

Four semaphores, declared at `runtime.rs:113-121`:

```
/// General-class admission pools: the configured limits minus every
/// reserved-class declaration, so reserved work can never draw here.
pub pending_permits: Arc<Semaphore>,
pub task_permits: Arc<Semaphore>,
/// Reserved-class admission pools, sized by the checked declaration sums
/// (plan KTD2). Zero-permit when no module declared a reservation, and
/// then unreachable because every route is general-class.
pub reserved_pending_permits: Arc<Semaphore>,
pub reserved_task_permits: Arc<Semaphore>,
```

Constructed at `runtime.rs:905-912`:

```
pending_permits: Arc::new(Semaphore::new(
    config.limits.max_pending_requests - reservations.pending,
)),
task_permits: Arc::new(Semaphore::new(
    config.limits.max_handler_tasks - reservations.tasks,
)),
reserved_pending_permits: Arc::new(Semaphore::new(reservations.pending)),
reserved_task_permits: Arc::new(Semaphore::new(reservations.tasks)),
```

Defaults: `max_pending_requests: 1024`, `max_handler_tasks: 256`
(`config.rs:131-132`).

**The class comes from the route, never from the body.** `route_tracker` returns
`(TaskTracker, RouteClass)` (`routing.rs:326-340`), reading the class stored on the
occupant at reservation time (`routing.rs:137`). `dispatch_request` selects the
pool pair from it at `dispatch.rs:873-879`:

```
let (pending_pool, task_pool) = match class {
    crate::handler::RouteClass::General => (&shared.pending_permits, &shared.task_permits),
    crate::handler::RouteClass::Reserved => (
        &shared.reserved_pending_permits,
        &shared.reserved_task_permits,
    ),
};
```

**Both acquisitions are non-blocking and happen on the read loop**, before any
task is spawned: `dispatch.rs:884` and `:896`, both `try_acquire_owned`. The
comment at `:881-883` states the reason: "Admission is synchronous with the read
loop: acquiring permits inside the spawned task would let a client pipeline
unbounded dispatch tasks ahead of the capacity gate."

**The two permits live in different tasks, deliberately.** The pending permit
moves into the outer settling task at `dispatch.rs:933`
(`let _pending_permit = pending_permit;`). The task permit moves into the *inner*
callback task at `:990`, with the comment at `:987-989`:

> The task permit lives in the callback task, not the settling outer task:
> capacity frees when the handler finishes, so a slow client blocking terminal
> emission cannot occupy max_handler_tasks with already-finished handlers.

So under a slow peer the pending count exceeds the task count, which is the
intended behaviour: a blocked terminal holds an unsettled slot but not handler
capacity.

**The reserved class is live in production, contrary to the comment at
`runtime.rs:118-119`.** `broca/mod.rs:164-176`:

```
ResourceDeclaration {
    reserved_handler_tasks: config::RESERVED_HANDLER_TASKS,
    reserved_pending_requests: config::RESERVED_PENDING_REQUESTS,
    retained_resident_bytes: config::DECLARED_RETAINED_RESIDENT_BYTES,
    general_task_hold_bound: 0,
    route_class: RouteClass::Reserved,
}
```

with `RESERVED_PENDING_REQUESTS = 96` (`broca/config.rs:185`) and
`RESERVED_HANDLER_TASKS = 96` (`:188`). The production binary composes that exact
component: `crates/mc-module/src/bin/ck_mc_host/serve.rs:571-580` builds
`BrocaComponent::new` or `new_with_credentials` and passes it to
`StaticComposite::new` at `:575`, which reaches `mc_host::run` at `:632`. So at
defaults the general pools are 1024-96 = 928 pending and 256-96 = 160 tasks, and
the reserved pools are 96 and 96.

Startup refuses configurations that would starve the general class:
`runtime.rs:693-712` checks `reservations.pending >= max_pending_requests`,
`reservations.tasks >= max_handler_tasks`, and the parked-task sum against
`general_task_slots`.

## Failure scenario

The bound binding is the *designed* behaviour, so the failure scenario is the
absence of a bound this layer does not provide: **per-connection fairness**.

1. All four pools are fields of `HostShared`, which is one instance per host
   incarnation (`runtime.rs:96-141`). Nothing keys a permit to a generation.
2. One authenticated client opens one connection and one route, then pipelines
   161 concurrent requests.
3. It holds all 160 general task permits.
4. A second client's request on a different generation and a different route
   reaches gate 6 (`dispatch.rs:896`) and gets `server_busy`.
5. The second client, per protocol §10.2, backs off and retries. The first client
   keeps its permits as long as its handlers run.

`connection_permits` (`runtime.rs:123`) bounds the *number* of connections, not
each connection's dispatch share. So the only isolation this layer provides is
between the two route classes, and there are exactly two.

Effect accounting is clean on this path: a request that fails to acquire either
permit is dropped before the pending entry exists and before any task is spawned
(`dispatch.rs:885`, `:897` both `drop(frame)` first), so attempted handler
invocations equal acquired task permits exactly, and zero handler dispatch is
provable. `tests/dispatch.rs:295` asserts precisely that with a
`dispatch_count()` comparison.

## Timing windows and dependencies

No window on the acquisition itself: `try_acquire_owned` is synchronous and the
read loop is the sole caller, so two requests on one generation cannot race each
other. Two generations can race, and the semaphore is the arbiter.

The divergence window between the pending count and the task count is the egress
wait, bounded per frame by `gen.writer.admission_deadline()`. At
`max_pending_requests` 928 general and a saturated egress budget, up to 928
requests can be settled-but-unqueued while zero task permits are held.

Dependency on the route surviving: the class is read from the occupant at
`dispatch.rs:861` and the permits are drawn immediately after. If the route closes
between the two, `register_dispatch` refuses at `:1069` and both permits are
released when the outer task returns early at `:934-937`. So a close cannot leak a
permit.

## What a test must construct

1. **Task-permit exhaustion**, which no existing test reaches: shrink
   `max_handler_tasks` to a small value, park that many handlers, and assert the
   next request gets `server_busy` with `dispatch_count()` unchanged.
2. **Class isolation both ways**, which two tests already do:
   `tests/dispatch.rs:976` (`saturated_broca_reserve_cannot_consume_a_general_slot`)
   and `:1074` (`saturated_general_capacity_cannot_consume_the_broca_reserve`).
3. **Acquisition-before-spawn**, which no test asserts directly: pipeline more
   requests than the pool holds without reading the socket, and assert the host's
   task count does not grow past the pool size. This is the property the comment
   at `:881-883` claims and nothing verifies.
4. **The pending/task divergence**: saturate egress, settle many requests, and
   assert the task pool frees while the pending pool does not.
5. **Per-connection unfairness**, as a documented observation rather than a
   violation: two generations, one greedy, assert the second is rejected.

`tests/handler_contract.rs:323` (`reservations_must_leave_one_general_slot_in_each_pool`),
`:375`, `:408`, and `:636` cover the startup checked-sum. None of
`tests/dispatch.rs` or `tests/handler_contract.rs` is named in any CI workflow.

## Investigation log

### Q: Is `RouteClass::Reserved` production or test-only?

- Sources examined: `runtime.rs:117-121` (the comment claiming possible
  unreachability), `broca/mod.rs:164-176`, `broca/config.rs:183-188`,
  `crates/mc-module/src/bin/ck_mc_host/serve.rs:560-580` and `:632`,
  `composite.rs:11-14` (the fixed occupant list).
- Findings: Broca declares 96/96 with `route_class: RouteClass::Reserved`, and the
  production binary composes it. The `runtime.rs` comment describes a
  configuration that does not ship. This is the third misleading in-crate comment
  this catalog has hit, after the three the ring resolution had to overcome, so it
  was checked against the binary rather than believed.
- Missing evidence: none.
- Conclusion: resolved with answer — `default-production`.

### Q: Is a control request bounded by a task permit too?

- Sources examined: `connection.rs:600-727` (`handle_control`) in full.
- Findings: only `pending_permits` (or `reserved_pending_permits` for a
  reserved-target `route.open`, `:616-624`). No task permit is acquired on any
  channel-0 path. The control operations spawn tasks — `:644`, `:662`, `:681`,
  `:689`, `:721` — but each holds only the pending permit.
- Missing evidence: none.
- Conclusion: resolved with answer — control work is bounded by one pool, routed
  work by two. Recorded as an asymmetry in the lens file's admission map.

### Q: Is per-connection handler-capacity fairness owned anywhere?

- Sources examined: `HostShared`'s fields (`runtime.rs:96-141`);
  `GenerationCore`'s fields (`connection.rs:77-103`).
- Findings: `GenerationCore` holds exactly one per-generation bound relevant to
  admission, `busy_rejects` (`:101`), and that bounds rejection emissions, not
  dispatch. Nothing per-generation bounds dispatch.
- Missing evidence: whether `runtime.rs`'s accept loop or `config.rs`'s validation
  imposes a per-connection share; both are sub-part 2f.
- Conclusion: unresolved, needs sub-part 2f. From this sub-part's files, no such
  bound exists.
