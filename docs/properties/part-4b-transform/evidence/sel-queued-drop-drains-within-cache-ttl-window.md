# sel-queued-drop-drains-within-cache-ttl-window

## Discovery trigger

Task 4 asks whether a pass that is always eligible but never selected is
possible, and what prevents indefinite deferral. `producer_gate`
(`transform.rs:4120-4128`) is false on every plain defer without a hard advisory,
and a durably queued agent drop is precisely work that is always eligible in the
sense that its target is still in the live tail. So the question is what forces
the gate open.

## Evidence trail

The queue survives. `load_pending_agent_drops` is called once per pass
(`transform.rs:3834`). Rows are retired only by `consumed_pending_drop_ids`
(`:6735-6779`), which retires a row only when it was applied this pass, was
already frozen, is at or under the coverage watermark, or targets a reasoning
block. The comment at `:6759-6765` states the discipline explicitly: "Retirement
must be PROVEN, not inferred from absence." So a drop whose target stays a live
unfrozen tail block is never consumed, and it does not age out.

The gate stays shut on a plain defer. With `pass == Defer` and `hard_advisory`
false, `producer_gate(pass, false)` is `!matches!(Defer, Defer) || false` =
`false` (`:6113-6115`). The selector does not run, so
`reductions_pending(&core, &[], &live, coverage)` (`:6829-6846`) is false over an
empty decision list, so `bust_opportunity` (`:4297`) is false unless
`independent_bust_opportunity` is true, which on a plain defer it is not
(`:4293-4296`). The classifier returns `PassPlan::Defer`.

What forces the gate open. Four paths, from `scheduler::decide`:

1. **Pressure.** `usage.percentage >= threshold` returns
   `BaseDecision::Execute` (`scheduler.rs:494-496`), and the force and emergency
   bands escalate further (`:743-757`). Bounded by usage growth, not by time.
2. **Idle TTL.** `idle_ttl_fired = ttl_hard_expired(now, last_response, ttl)`
   (`scheduler.rs:726-727`), which forces `PassDecision::Execute` (`:738-741`).
   `ttl` comes from `scheduler_ttl_ms(&session.cache_ttl)` (`:810-812`), which is
   `parse_cache_ttl(cache_ttl).unwrap_or(DEFAULT_CACHE_TTL_MS)` with the constant
   `5 * 60 * 1000` (`:23`). **This is the time bound.**
3. **A deferred execute intent.** `inputs.deferred_execute.is_some()` also forces
   Execute (`scheduler.rs:738-740`). That intent is set by
   `apply_boundary_deferral` when a mid-tool-use tail demoted an Execute
   (`:545-550`), so it converts a one-pass demotion into a guaranteed Execute on
   the following pass. Bound: one pass.
4. **A flush.** `loaded.meta.soft_refresh_pending` promotes a plain Defer to
   Execute (`transform.rs:4034-4038`).

Two conditions defeat the time bound:

- **`last_response_time_ms == 0`.** `ttl_hard_expired` requires
  `last_response_time_ms > 0` (`scheduler.rs:429-431`), and
  `should_execute` returns `Defer` immediately when
  `usage.percentage == 0.0 && last_response_time_ms == 0` (`:476-478`). That zero
  arises whenever `ProducerContext.observed_last_response_at_ms` is `None`
  (`transform.rs:3979-3983`), which `lib.rs:4482` returns for the first
  observation of a session in this process. See
  `sel-eligibility-reads-process-local-scheduler-state`.
- **`ordinary_historian_veto`.** Even with `pass == Execute`, the veto
  (`transform.rs:4098-4104`) forces `selection_class` to `PassClass::Defer`
  (`:4131-4135`) and removes the ordinary arm from
  `independent_bust_opportunity` (`:4293-4295`). The selector still runs because
  `producer_gate` is true, so a queued drop can still be applied; what is
  suppressed is age reclaim. The comment at `:4128-4130` states this: "only
  context pressure reported by the scheduler enables age reclaim."

So the drain bound for a queued agent drop is: one cache-TTL interval measured
from the last in-process response observation, plus one pass, provided this
process has observed a response for the session.

## Failure scenario

An agent queues three drops. The session then receives no further responses (the
user walks away) and the module process restarts. The next pass has
`last_response_time_ms == 0`, so neither the idle TTL nor the TTL arm of
`should_execute` fires, and usage is whatever the last committed pass recorded. If
that usage is below the threshold, the pass defers, no state changes, and
`commit_required` is false, so `last_committed_pass_at_ms` is not refreshed
either. `record_response_observation` (`lib.rs:4485`) runs on the response, so the
*second* pass in the new process does have an observation, and the TTL then
measures from that moment rather than from the real last response. The effect is
that a restart resets the idle clock, extending the wait by up to one full TTL.

## Timing windows and dependencies

Window one: the configured `cache_ttl` in milliseconds, default 300,000
(`scheduler.rs:23`). Window two: the historian lease duration, which affects age
reclaim rather than the queue drain and which `transform.rs:601-603` does not
bound. Window three: one pass, for the mid-tool-use deferral.

## What a test must construct

A bounded liveness test, per METHOD.md's liveness rules. Queue a drop whose target
is a live unfrozen tail block. Drive one pass to establish an in-process response
observation. Then hold usage below the execute threshold and advance the module's
clock past `cache_ttl + 1` millisecond, driving a pass at each step. Assert that
by the pass following TTL expiry the drop is applied, meaning the target appears
in `frozen_red_targets` and the pending row is in `consumed_drop_ids`. State the
bound as `cache_ttl` milliseconds, not as a generous timeout: a timeout cannot
distinguish one idle fire from a thousand deferred passes.

`set_guidance_now_ms_for_test` (`lib.rs:4427-4532` group) and
`inject_reductions_for_test` (`:4536-4541`) exist as clock and selection seams.
The pending-drop fixture pattern is at `transform.rs:23678-23690`.

## Investigation log

### Q: Is the historian veto bounded for this purpose?

- Sources examined: `transform.rs:4098-4104`, `:601-606` (the doc comments on
  `historian_active` and `wrapup_active`), `:3919-3928` (the parallel freeze in
  the divergence counter, which cites the 3,800-second wrapup budget).
- Findings: `wrapup_active` is documented as bounded by
  `historian::MAX_WRAPUP_REQUEST_BUDGET`, 3,800 seconds
  (`transform.rs:604-606`), and released on every terminal path.
  `historian_active` has no stated bound at this call site.
- Missing evidence: `historian.rs` is 4,682 lines and belongs to sub-part 4a. The
  lease's maximum duration is not visible from the 4b slice.
- Conclusion: unresolved, needs the 4a lens. Note that the veto does not block a
  queued agent drop, only age reclaim, so the drain bound in this record survives
  the open question; what does not survive is a bound on age-based reclaim.

### Q: Can a queued drop be lost rather than deferred?

- Sources examined: `consumed_pending_drop_ids` (`transform.rs:6735-6779`) in
  full, including both retirement predicates.
- Findings: The `obsolete` arm retires a row when the target is at or under
  coverage, or is a reasoning block. Coverage only advances, so a target that
  folds behind coverage is genuinely unappliable and the retirement is correct.
  The reasoning arm is justified at `:6767-6769`.
- Missing evidence: `handle_session_recomp_value` and
  `handle_session_delete_value` (`lib.rs:5995-6161`) can destroy session state
  and belong to sub-part 4c; whether they clear the queue was not checked.
- Conclusion: resolved with answer for the transform path. A drop is deferred, not
  lost, unless its target folds behind coverage first, in which case losing it is
  correct.
