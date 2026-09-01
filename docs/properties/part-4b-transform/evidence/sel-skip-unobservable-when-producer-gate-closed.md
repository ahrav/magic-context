# sel-skip-unobservable-when-producer-gate-closed

## Discovery trigger

Task 5 asks whether an eligible pass can be skipped silently and whether the
reason for skipping is observable. The lens brief notes that silent skips with no
diagnostic are a recurring finding in this repository. `producer_gate` is the
gate that skips the most work, so I read the whole gate region for logging and
then checked every observable surface the pass produces.

## Evidence trail

The gate. `transform.rs:4120-4128`:

```
let producer_gate = tail_reclaim_enabled
    && producer_gate(
        scheduler_outcome.pass,
        !loaded.meta.initialized
            || render_config_changed
            || reconcile_hard_due
            || hard_fold_requested
            || cached_m1_missing_due,
    );
```

with `fn producer_gate(pass, hard_advisory) -> bool` at `:6113-6115` being
`!matches!(pass, Defer) || hard_advisory`.

The skip. `transform.rs:4201-4258`. The `if producer_gate` arm calls
`select_reductions_with_outcome`; the `else` arm at `:4257-4259` is
`SelectionOutcome::default()`. There is no `eprintln!`, no counter increment, and
no timings field set on the else arm. `timings.selection` is recorded either way
(`:4260`), so even the timing cannot distinguish a skip from a fast selector run.

The second, narrower skip. `ordinary_historian_veto` (`transform.rs:4098-4104`)
does not stop the selector but forces `selection_class` to `PassClass::Defer`
(`:4131-4135`), which suppresses age reclaim. No logging accompanies it either.

What the counters would have said. `SelectionOutcome`'s four counters are
`Option<usize>` and `selection.rs:1097-1098` documents the semantics exactly:
"Missing means the gate stayed shut and the selector did not run." They are
carried to the commit at `transform.rs:5585-5588` as
`scheduler_eligible_supersession_count`,
`scheduler_withheld_by_tag_window`,
`scheduler_withheld_by_exempt_message`, and
`scheduler_applied_supersession_count`. `SelectionOutcome::default()` gives all
four as `None`, and `count_to_u64` (`:4261-4262`) maps `None` to `None`. So the
durable record of the skip is an absence, indistinguishable from an older row that
predates the counters.

Worse, the commit itself may not happen. `commit_required` is
`state_changed || !consumed_drop_ids.is_empty() || !pending_overlays.is_empty()`
(`:5560-5562`). On a pure defer with a warm cache and nothing to consume, all
three are false, and the `else` arm at `:5600-5601` returns
`loaded.row_version.unwrap_or(0)` without writing anything. So on exactly the pass
where an operator most wants to know why the queue did not drain, no record is
written at all.

The stderr surface. `emit_pass_timing` (`lib.rs:13443-13465`) is unconditional
when timings are present and writes `format_pass_timing_line`
(`transform.rs:1317-1443`). I read the format string field by field
(`:1336-1360`): it carries 60-plus timing and count fields including
`selection={:.1}`, `emergency_reasoning_exclusions={}`, and
`tag_mint_candidates={}`, and it carries no field for the scheduler pass
decision, `producer_gate`, `ordinary_historian_veto`, `selection_class`, or the
pending-drop queue depth.

The response surface. `TransformResponse` (`transform.rs:1455-1535`) carries
`action`, `decision` (documented at `:1461-1462` as "duplicated from `action` for
telemetry consumers"), and `materialize_reason`. `materialize_reason` comes from
`classify_materialize_reason` (`:12561-12613`), which is called with the plan and
returns `None` when the plan is a defer, so a deferred pass reports
`decision: "defer"` and nothing else.

By contrast, `apply_once` does log five other conditions on stderr in the same
function: identity re-adoption (`:5615-5620`), boundary divergence recut
(`:5621-5630`), first divergence (`:5631-5637`), frozen-reduction heal
(`:5638-5644`), and reasoning drop-seed skips (`log_reasoning_drop_seed_skips`,
`:6694-6710`). So the file's convention is to log notable skips; this one is the
exception.

## Failure scenario

An agent calls `ctx_reduce` on three spent tool outputs. The facade queues three
`pending_agent_drops` rows. The session then goes quiet: usage sits at 40 percent,
the provider cache stays warm so no idle TTL fires, the session is initialized,
the render config is unchanged, and no reconcile is pending. Every subsequent pass
computes `scheduler_outcome.pass == Defer`, `hard_advisory == false`, therefore
`producer_gate == false`, therefore `SelectionOutcome::default()`, therefore
`reductions_pending_now == false` (`:4287-4292`), therefore `bust_opportunity`
false, therefore `PassPlan::Defer`, therefore `commit_required` false, therefore
no row written.

The agent sees the tagged content still fully present. The operator sees
`decision: "defer"` and a timing line with `selection=0.0`. Nothing in either
surface distinguishes this from "there was nothing to reduce".

## Timing windows and dependencies

The window is any defer pass with a non-empty durable queue. It persists until
something opens the gate: usage crossing the threshold, an idle TTL fire, a
config change, or a flush. See
`sel-queued-drop-drains-within-cache-ttl-window` for the drain bound.

## What a test must construct

Queue a pending drop via `handle_agent_drops_value`, then drive a transform with
usage below the threshold, `initialized: true`, unchanged render config, no
reconcile, and a warm cache. Assert the independent preconditions rather than the
violation, per METHOD.md's coverage-check rule: assert that
`store.load_pending_agent_drops(session).len() > 0` and that the pass produced
`decision == "defer"` with `committed == false`. Those two facts jointly create
the vulnerable window and remain true on a correct implementation, so the marker
still fires once a diagnostic is added. Do not assert "no diagnostic was emitted";
that can only pass by observing the defect.

## Investigation log

### Q: Is there any surface at all that names a closed producer gate?

- Sources examined: `transform.rs:4098-4258` line by line for `eprintln!`;
  `format_pass_timing_line`'s format string (`:1336-1360`);
  `TransformResponse`'s full field list (`:1455-1535`);
  `TransformTimings`'s full field list (`:1145-1312`);
  `classify_materialize_reason` (`:12561-12613`); `action_str` (`:12615`);
  `emit_pass_timing` (`lib.rs:13443-13465`); `respond_transform`
  (`lib.rs:13339-13441`) for any additional logging.
- Findings: None. The only near-miss is `timings.selection`, which is set on both
  arms and is therefore not a discriminator.
- Missing evidence: `respond_transform` is 103 lines and belongs to sub-part 4d;
  I scanned it for logging rather than reading it fully. A diagnostic emitted
  there would still not carry the gate value, because the gate is a local in
  `apply_once` and is not returned in `TransformWithProjection`
  (`:5648-5697`).
- Conclusion: resolved with answer. No surface names it, and the value is not
  even carried out of `apply_once`, so no downstream consumer could name it.

### Q: Should the counters be committed on a no-op defer?

- Sources examined: `transform.rs:5556-5601`, `selection.rs:1096-1104`.
- Findings: Committing would turn a no-op pass into a write, which is exactly what
  the `commit_required` guard exists to avoid; the surrounding code is careful
  that a pure defer writes nothing (the module header states it at
  `transform.rs:11-13` per the part-4 scope map's summary). So the fix is probably
  a stderr diagnostic or a response field, not a commit.
- Missing evidence: none for the mechanics; the trade-off is a design call.
- Conclusion: needs human input.
