# wrapup-rounds-require-observed-boundary-advance

## Discovery trigger

The task asked whether a stalled or failed run leaves the subsystem able to make
progress later, under METHOD.md's liveness rules with a bounded window. The
wrapup drain is the only place in Part 4a that loops over publishes, and its own
comment says it has no round cap. A loop with no count bound needs its progress
condition and its wall-clock bound both pinned, in the units the code actually
bounds.

## Evidence trail

### The loop and its declared bound

`crates/mc-module/src/lib.rs`:

- `:6828-6830` `let mut rounds = 0usize;` plus the failure and terminal-failure
  slots.
- `:6831-6834` the comment: "No round-count cap: the drain loops until the keep
  watermark is reached or a stop condition trips. The request budget is the ceiling
  — every round re-checks the deadline before driving, matching the TypeScript
  drain-until-target loop."
- `:6871` `let round_now = now_ms();` at the top of each round.
- `:6872-6887` a backoff check that breaks with `BackoffActive`.
- `:6889-6897` `current_end = store.max_compartment_end_ordinal(&session_id)`,
  mapped to `None` when zero, with a store error returning an error response.
- `:6898-6900` `if !wrapup_has_remaining_messages(&parsed.messages, current_end,
  target) { break; }` which is the normal exit.
- `:6905-6914` `prepare_wrapup_fire`.
- `:6915-6930` a snapshot-generation re-check after assembly, breaking with
  `SnapshotStale`.
- `:6931-6966` the `Busy`, `Nothing`, and `Failed` arms, each of which breaks.
- `:6967-6976` the `FireReady` arm, which attaches
  `WrapupSnapshotPublicationFence` and calls `run_wrapup_firing`.
- `:6977-6989` the progress check: `after_end = max_compartment_end_ordinal(...)`,
  and `if after_end <= current_end` break with `SnapshotUnavailable` and the message
  "historian completed without advancing the compartment boundary".
- `:6990-6991` `rounds += 1; wrapup_guard.set_rounds(rounds);`

### The wall-clock bound

`crates/mc-module/src/historian.rs`:

- `:947-949` `completion_wait_budget()` is 660 s.
- `:952-961` the doc for the request budget, which spells out the derivation: "one
  busy-join at entry (bounded by `completion_wait_budget`, 660s) plus producer
  rounds each bounded by `wrapup_round_wait_budget` (600s); the loop re-checks the
  remaining budget before every round, so the wall time is one join plus as many
  rounds as fit under the budget."
- `:962` `MAX_WRAPUP_REQUEST_BUDGET` is 3800 s.
- `:964-968` `wrapup_round_wait_budget()` is 600 s.

`crates/mc-module/src/lib.rs`:

- `:5481-5487` `run_wrapup_firing` returns `BudgetExhausted` when
  `remaining_wrapup_budget(deadline)` is `None`.
- `:5488` `let wait = historian::wrapup_round_wait_budget().min(remaining);` so the
  per-round wait never exceeds the remaining budget.
- `:5498-5556` the timeout arms, including `:5548-5551` which distinguishes
  budget exhaustion from a round timeout by re-checking `Instant::now() >= deadline`.
- `:5558-5574` `await_wrapup_historian_completion` applies the same
  min-with-remaining discipline to the busy-join.

### The guard that survives the loop

`crates/mc-module/src/lib.rs:4594-4612` `try_claim_wrapup_session` returns
`Err(rounds)` when a wrapup is already live, and the caller reports "wrapup already
in progress, {rounds} rounds done" (`:6680-6685` region). The `WrapupSessionGuard`'s
`Drop` (`lib.rs:3198-3220`) releases it, so a panic in the loop does not wedge the
surface.

### The two shapes that could spin

1. A publish that does not advance the boundary. Caught by `:6982-6989`, which is
   the property's `always` half.
2. A fence rejection, which abandons **without** arming the failure cooldown
   (`historian.rs:533-547`). The next round's backoff check at `lib.rs:6872-6887`
   therefore does not stop it, and `run_wrapup_firing` maps
   `FenceRejected` to `RetryableWrapupReason::SnapshotStale` (`:5519-5526`), which
   is a `break`. So a fence rejection ends the drain rather than looping. That
   resolves the first-order worry, but the snapshot-generation re-check at
   `:6915-6930` is a separate break on the same condition, so both paths exit.

## Failure scenario

A drain that neither advances nor stops would hold a `session.wrapup` request open
for up to 3800 s while spending one model call per round. The consumer's deadline is
set to `MAX_WRAPUP_REQUEST_BUDGET` verbatim (`historian.rs:952-961`), so it would
wait the whole time and then see a retryable failure. Worse, each round is a
billable producer run, so the cost is bounded only by 3800 s divided by the round
latency.

The absence of a round cap is deliberate and correct for the intended case, a large
multi-chunk drain. The risk is entirely in whether every non-progress path breaks.

## Timing windows and dependencies

The bound is a wall-clock budget, not an attempt count, which is what METHOD.md
requires be stated in the code's own units. Two dependencies:

- Every loop path must re-check the deadline before driving. `:6871` recomputes
  `round_now` and `run_wrapup_firing` re-checks at `:5481`, but I traced the
  documented arms rather than every statement in a 539-line method, so this is the
  weak point in the evidence.
- `max_compartment_end_ordinal` must be the right progress signal. It reads the
  store, so it observes a committed publish and nothing else, which is the correct
  granularity.

## What a test must construct

1. The progress break: a producer double that publishes a fold whose compartment
   ends at or before `current_end`. Assert the loop breaks with the
   "historian completed without advancing the compartment boundary" reason and that
   `rounds` did not increment.
2. Bounded termination: inject a compressed deadline, since the budget is a
   constant, and assert the handler returns within it under a producer double that
   always times out. The test must drive the deadline rather than wait, so the
   handler needs the deadline to be injectable; `wrapup_operation_budget`
   (`lib.rs:5445-5460`) has a `#[cfg(test)]` override, which is the seam.
3. Multi-round success: two chunks, two rounds, assert `rounds == 2` and that the
   boundary advanced on each.
4. Fence-rejection exit: hold the transform-snapshot generation moving during a
   drain and assert the loop breaks with `SnapshotStale` rather than looping. This
   is the one the open question below is about.

## Investigation log

### Q: Can a fence rejection with no cooldown recur every round until the budget expires?

- Sources examined: `crates/mc-module/src/historian.rs:533-547` and `:1786-1801`
  (abandon without cooldown); `crates/mc-module/src/lib.rs:5519-5526`
  (`FenceRejected` maps to `SnapshotStale`), `:6915-6930` (the post-assembly
  generation re-check), `:6872-6887` (the backoff check), `:6249-6266` region for
  `ready_generation_matches` usage, and `lib.rs:3296-3322`
  (`WrapupSnapshotPublicationFence`).
- Findings: `SnapshotStale` is a `break`, not a `continue`, so a fence rejection
  ends the drain in the current code. The comment at `historian.rs:534-537`
  justifies the missing cooldown on the grounds that "an immediate retry on a fresh
  snapshot is admitted instead of reading backoff_active for a minute", which is
  about the *next request*, not the next round. So the no-cooldown choice and the
  loop's break are consistent.
- Missing evidence: whether a client that immediately re-issues `session.wrapup`
  after a `SnapshotStale` response can loop across requests indefinitely while a
  transform keeps retiring snapshots. That is outside the loop but inside the same
  liveness question, and it depends on consumer retry behaviour I did not read.
- Conclusion: resolved for the in-loop case, which cannot spin on fence rejections.
  Unresolved for the cross-request case, which needs the consumer's retry policy.
  The record's `medium` confidence reflects the untraced statements in the 539-line
  method rather than this question.
