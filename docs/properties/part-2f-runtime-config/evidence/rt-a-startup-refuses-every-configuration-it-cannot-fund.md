# rt-a-startup-refuses-every-configuration-it-cannot-fund

## Discovery trigger

Mapping construction order for `runtime.rs:641-961`. Between the instance lock
and `HostShared` construction there are eight distinct refusal points, spread
over 190 lines, and their joint purpose is not stated anywhere: they exist so
that the permit and byte arithmetic in the `HostShared` literal cannot produce a
negative or out-of-range value. Nothing names that conjunction.

## Evidence trail

The gates, in order, all verified at `e447c927`:

1. `config.rs:147-193` `HostLimits::validate` — nonzero and
   `<= Semaphore::MAX_PERMITS` for the six count limits (`:156-167`),
   `max_routes <= u16::MAX` (`:168-174`), `max_resident_bytes` within
   `[MIN_RESIDENT_BYTES, min(Semaphore::MAX_PERMITS, u32::MAX)]`
   (`:175-191`).
2. `runtime.rs:500-509` — manifest count in `1..=3`, declaration count equal.
3. `runtime.rs:519-529` — canonical module id, no duplicate id.
4. `runtime.rs:535-554` — `route_class` and reserved counts must agree in both
   directions.
5. `runtime.rs:555-578` — four `checked_add` sums: `pending`, `tasks`,
   `general_task_holds`, `retained_bytes`. Each overflow is `InitFailed`.
6. `runtime.rs:693-702` — `reservations.pending < max_pending_requests` and
   `reservations.tasks < max_handler_tasks`, strict, so a general slot survives.
7. `runtime.rs:707-715` — `general_task_holds < max_handler_tasks - tasks`.
8. `runtime.rs:733-740` — `max_resident_bytes >= MIN_RESIDENT_BYTES + catalog + retained`,
   built with `saturating_add` so a saturating sum rejects rather than wraps.

The consumers those gates protect, all in the `HostShared` literal:

- `runtime.rs:896-902` `ingress_budget` — four chained subtractions, unchecked.
- `runtime.rs:905-907` `pending_permits` — `max_pending_requests - reservations.pending`.
- `runtime.rs:908-910` `task_permits` — `max_handler_tasks - reservations.tasks`.
- `runtime.rs:913-914` — `Semaphore::new` on `max_handshakes` and
  `max_connections`, both validated against `MAX_PERMITS`.

`ByteBudget::new` (`wire.rs:394-400`) casts `u64` to `usize` and calls
`Semaphore::new`, which panics above `MAX_PERMITS`. So a wrapped subtrahend at
`:896` reaches a panic, not an error.

Arithmetic verified independently from `wire.rs:28` (`HEADER_LEN = 21`) and
`wire.rs:35`/`:371` (`MAX_BODY_LEN = 67,108,864`):
`EGRESS_RESERVED_BYTES` = 67,108,885, `SCRATCH_RESERVED_BYTES` = 184,616,192,
`MIN_RESIDENT_BYTES` = 318,833,941, default `max_resident_bytes` = 385,942,805.
Admission at defaults, before catalog and retained, is 134,217,728, exactly
twice `MAX_BODY_LEN`.

## Failure scenario

A handler is changed to declare `retained_resident_bytes` just under the
remaining headroom, and a later change adds a fifth subtrahend to `:896-902`
without adding it to `resident_floor` at `:733-735`. A release build wraps the
`u64`, `ByteBudget::new` receives a value near `u64::MAX`, the `as usize` keeps
it, and `Semaphore::new` panics inside the `HostShared` literal at `:882`.

That panic lands *after* `bind_owner_only` (`:836`), `publish` (`:842`), and the
`Running` lifecycle record (`:847-849`). So discovery has already advertised the
endpoint. A client reads a valid connection file, connects to the setup socket,
and finds nothing listening, because `accept_loop` (`:934`) is never reached.
The instance lock is held by `guard`, which was handed back at `:865` and is not
yet inside `AbandonGuard` (`:929`), so an unwind drops it directly rather than
through the ordered cleanup.

## Timing windows and dependencies

No concurrency window. Startup is sequential from `:647` to `:934`, and all
eight gate inputs are fixed by `:732`.

The real window is a maintenance one: gate 8 and its consumer at `:896` are 160
lines apart, and the identity that makes the subtraction safe lives in a third
file (`config.rs:23-24`, where `MIN_RESIDENT_BYTES` is defined as
`MAX_BODY_LEN + EGRESS_RESERVED_BYTES + SCRATCH_RESERVED_BYTES`). Three files
must agree and none asserts the agreement.

Dependencies: `crate::control::CatalogCache::resident_len` supplies
`catalog_resident` (`:732`); `build_target_index` supplies
`reservations.retained_bytes`. Both are handler-derived, so the floor is
handler-dependent and cannot move into `config.rs`.

## What a test must construct

A composite whose declarations sit exactly at each gate's boundary, then one
step past it, asserting `Err(HostError::InitFailed(_))` for the failing side and
a successful startup for the boundary side. `handler_contract.rs:302-320`
already provides `broca_declaration` and `three_child_composite` for this.

The missing piece is the joint assertion. A `debug_assert` block immediately
before `runtime.rs:882` stating all four preconditions would fire on a correct
implementation and would catch any of the three files drifting. Per the
coverage-check rules, it asserts the independent preconditions, not the
violation.

## Investigation log

### Q: can `saturating_add` at `:733-735` mask a real overflow into an accept?

- Sources examined: `runtime.rs:732-740`, `config.rs:175-191`.
- Findings: `saturating_add` saturates at `u64::MAX`. The comparison at `:736`
  is `max_resident_bytes < resident_floor`. Since `validate` already caps
  `max_resident_bytes` at `min(Semaphore::MAX_PERMITS, u32::MAX)`, a saturated
  floor always exceeds it, so the branch rejects.
- Missing evidence: none.
- Conclusion: resolved with answer — it fails closed. `saturating_add` is the
  correct choice here precisely because the comparison is a lower bound.

### Q: is `Semaphore::MAX_PERMITS` ever the binding cap rather than `u32::MAX`?

- Sources examined: `config.rs:181-191`, and the arithmetic above.
- Findings: on a 64-bit target `MAX_PERMITS` is `usize::MAX >> 3`, far above
  `u32::MAX`, so `u32::MAX` binds. On a 32-bit target `MAX_PERMITS` is
  536,870,911, below `u32::MAX`, so it binds and leaves only 150,928,106 bytes
  of headroom above the default.
- Missing evidence: whether any 32-bit target is supported. I found no target
  list.
- Conclusion: unresolved, needs a supported-target list. The `min` at `:185` is
  either load-bearing on a real target or dead code with a misleading comment.
