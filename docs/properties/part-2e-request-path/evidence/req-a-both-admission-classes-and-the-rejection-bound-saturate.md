# req-a-both-admission-classes-and-the-rejection-bound-saturate

## Discovery trigger

Task 7 asked for at least one `sometimes` situation-coverage record. The admission
map has five distinct saturation states, and existing tests reach only two of
them, so the coverage gap is concrete rather than hypothetical.

## Evidence trail

Five `try_acquire_owned` sites in this sub-part's admission paths, each with a
distinct saturation state:

| # | Pool | Site | Size at defaults |
| --- | --- | --- | --- |
| 1 | `pending_permits` (general) | `dispatch.rs:884`, `connection.rs:625` | 1024 − 96 = 928 |
| 2 | `task_permits` (general) | `dispatch.rs:896` | 256 − 96 = 160 |
| 3 | `reserved_pending_permits` | `dispatch.rs:884` via the class match at `:873-879`; `connection.rs:621` | 96 |
| 4 | `reserved_task_permits` | `dispatch.rs:896` via the same match | 96 |
| 5 | `busy_rejects` | `dispatch.rs:620`, `connection.rs:430` | 32, per generation |

Sizes derive from `config.rs:131-132` (1024, 256), `broca/config.rs:185`, `:188`
(96, 96), and `runtime.rs:905-912` for the subtraction.

**Why these are five different situations, not one branch.** The consequence
differs per state:

- Pending exhaustion returns `server_busy` while handler capacity may be fully
  idle, because the pending permit is held across the egress wait and the task
  permit is not (`dispatch.rs:933` versus `:990`).
- Task exhaustion returns the same `server_busy` code for a materially different
  reason: 160 handlers are actually executing. The client cannot distinguish the
  two, because both produce `CODE_SERVER_BUSY` with different messages
  ("pending request capacity exhausted" at `:891` versus "handler task capacity
  exhausted" at `:903`), and protocol §7.1 makes the message diagnostic only.
- Reserved exhaustion is the state the carve-out exists to survive; if it is never
  reached, the second half of the isolation guarantee is unverified.
- `busy_rejects` exhaustion is the only one of the five whose consequence is
  **generation retirement plus queue discard** rather than a terminal
  (`dispatch.rs:637-638`).

**Why `sometimes` and not `reachable`.** METHOD's rule: `reachable` is location
coverage, `sometimes` is situation coverage, and a campaign can execute a branch's
lines while never producing the operational state the branch represents. Here that
distinction is sharp. Sites 1 and 2 are the *same two lines* for general and
reserved classes — the pool is selected by the match at `:873-879` and the
acquisition code is shared — so line coverage of `:884` and `:896` says nothing
about which class saturated. And `busy_rejects` exhaustion requires not just the
counter reaching zero but the 32 emissions being genuinely stuck, which requires a
contended egress budget as well.

**What existing tests reach.** Verified by reading each:

- `tests/dispatch.rs:295` (`saturated_request_capacity_returns_server_busy_without_dispatch`)
  sets `config.limits.max_pending_requests = 1`, parks one handler with
  `mode_body(json!({"mode": "hang"}))`, waits for `dispatch_count() != 0`, then
  sends a second request and asserts `server_busy` with `dispatch_count()`
  unchanged. That is **state 1**.
- `tests/dispatch.rs:976` (`saturated_broca_reserve_cannot_consume_a_general_slot`)
  and `:1074` (`saturated_general_capacity_cannot_consume_the_broca_reserve`) are
  the isolation pair. Between them they saturate the reserved and general pending
  pools, so **state 3** is reached.
- **States 2, 4, and 5 are reached by no test.** Grep for `max_handler_tasks` in
  `tests/` returns hits only in `handler_contract.rs`, where `:323`, `:375`, and
  `:408` assert *startup validation* of the declarations, never runtime task
  saturation. `busy_rejects` appears in no test file.

## Failure scenario

The absence of coverage, not a code defect.

**State 2 uncovered.** Task exhaustion is the state that a module with a missing
internal timeout produces (see
`req-a-a-handler-outliving-every-host-deadline-is-reached`). If it is never
constructed, the assertion that task exhaustion rejects rather than queues rests
on reading `try_acquire_owned` rather than on evidence, and a future refactor to
`acquire_owned` — one character's difference in intent — would convert every
capacity rejection into an unbounded queue on the read loop, which is exactly what
the comment at `:881-883` warns against, with no test to catch it.

**State 4 uncovered.** `runtime.rs:118-119` claims the reserved pools may be
"unreachable because every route is general-class". That claim is false in
production (Broca declares `RouteClass::Reserved`), and it is the kind of comment
that, left unchallenged by a test, propagates into a future decision to delete the
reserved task pool as dead code. State 3's coverage protects the pending half;
nothing protects the task half.

**State 5 uncovered.** This is the one with the largest blast radius, because
`gen.writer.discard()` drops other correlations' queued terminals. It is also the
hardest to construct, needing simultaneous egress saturation and a rejection flood.

## Timing windows and dependencies

State 2 is harder to reach than state 1 by construction: the task permit releases
when the handler returns (`:990`), so reaching 160 concurrent *executing* handlers
requires 160 handlers that are simultaneously parked. State 1 needs only 928
requests whose terminals are unqueued, which a slow reader produces without any
handler cooperation.

State 5 needs two conditions at once:

1. 32 pre-dispatch rejections in flight on one generation. Easiest source is gate
   4 (`dispatch.rs:861`) against a closed route, which needs no capacity at all.
2. A contended egress budget so those 32 stay blocked in
   `charge_frame_or_cancel` (`:200`) rather than draining.
   `tests/dispatch.rs:788` (`egress_budget_deadline_retires_the_generation`) and
   `:712` (`concurrent_handler_output_is_reserved_before_allocation`) both already
   arrange a tight egress budget, so the fixture exists.

Note the interaction: `charge_frame_or_cancel`'s deadline arm cancels the
generation at `:163`, so a test that waits too long gets a retirement for the wrong
reason. The window is bounded by `gen.writer.admission_deadline()`, and the 33rd
rejection must arrive inside it.

Dependency: all five states need a shrunk configuration to be cheap. `HostLimits`
is `pub` (`config.rs:95-160`) and `TestHost::start_with` already takes a config
mutator, so shrinking is available.

## What a test must construct

One campaign observing all five, with a marker per state. Marker names must be
constant and globally unique per METHOD's coverage rules, so:

1. `admission_general_pending_saturated` — shrink `max_pending_requests`, park
   handlers, assert `server_busy` with unchanged `dispatch_count()`. Exists as
   `tests/dispatch.rs:295`.
2. `admission_general_task_saturated` — shrink `max_handler_tasks` below
   `max_pending_requests` so the task pool binds first, park that many handlers,
   assert `server_busy` and that the message is "handler task capacity exhausted"
   rather than the pending one, distinguishing state 2 from state 1.
3. `admission_reserved_pending_saturated` — exists as `tests/dispatch.rs:976`.
4. `admission_reserved_task_saturated` — shrink Broca's effective task reserve,
   park that many Broca-route requests, assert `server_busy` on a Broca route
   while a general route still dispatches.
5. `rejection_bound_saturated` — tight egress budget, closed route, pipeline 33+
   requests without reading, assert the generation retires and a previously
   settled unrelated terminal is lost.

These are preconditions, not violations, so each marker fires on a correct
implementation. None asserts that saturation is *wrong*; each asserts the state was
entered.

## Investigation log

### Q: Which of the five states do existing tests reach?

- Sources examined: `tests/dispatch.rs:295-354`, `:976-1073`, `:1074-1160`;
  `tests/handler_contract.rs:323-436`; grep for `max_handler_tasks` and
  `busy_rejects` across `crates/mc-host/tests/`.
- Findings: states 1 and 3 are reached. `max_handler_tasks` appears in
  `handler_contract.rs` only in startup-validation tests. `busy_rejects` appears in
  no test file at all.
- Missing evidence: none.
- Conclusion: resolved with answer — three of five states are unconstructed.

### Q: Do states 1 and 2 produce distinguishable client-visible evidence?

- Sources examined: `dispatch.rs:884-895` and `:896-907`; protocol §7.1's "Error
  `code` is stable; `message` is diagnostic" sentence.
- Findings: both emit `CODE_SERVER_BUSY`. The messages differ ("pending request
  capacity exhausted" versus "handler task capacity exhausted") but the protocol
  designates the message as diagnostic, so a conforming client must not branch on
  it. The two states are therefore indistinguishable to a conforming client, and a
  test must use the message or host-side instrumentation to tell them apart.
- Missing evidence: none.
- Conclusion: resolved with answer — the test must assert on the message or on
  host state, and must not treat message-matching as a client-side capability.

### Q: Is state 4 reachable without modifying Broca?

- Sources examined: `broca/config.rs:183-188` (constants, not limits — the comment
  at `broca/mod.rs:169-170` says "Constants rather than limits so a test-shrunken
  supervisor still declares the product contract"), `runtime.rs:537-560`
  (declaration validation), `handler.rs:565-567` (the trait default).
- Findings: Broca's declaration is hard-coded to 96/96 and deliberately not
  configurable. So reaching state 4 with the real Broca requires 96 concurrently
  parked Broca-route requests. The alternative is a test composite with a
  reserved-class child declaring a small reserve, which is how
  `tests/dispatch.rs:976` reaches state 3 — worth checking whether it uses the
  real Broca or a substitute.
- Missing evidence: whether `tests/dispatch.rs:976`'s fixture uses
  `tests/support/broca.rs`'s substitute (which `tests/support/broca.rs:184`
  composes) or the real component.
- Conclusion: unresolved, needs a read of `tests/support/broca.rs`. Either way the
  path to state 4 exists; which fixture is cheaper is an implementation choice for
  the test author.
