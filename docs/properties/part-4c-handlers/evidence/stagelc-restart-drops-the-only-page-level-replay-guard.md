# stagelc-restart-drops-the-only-page-level-replay-guard

## Discovery trigger

Having established that no staged state survives a restart, the follow-on
question from the task was whether resuming can double-apply a step that already
committed. That required finding what protects against a redriven final page, and
whether that protection is durable.

## Evidence trail

All lines read back at `HEAD` = `b5dc778e`;
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty.

The guard, and the fact that it is the only page-level one:

- `:9446-9461` — at the top of `handle_transform_page_value`, before staging, the
  handler consults `transforms.completed(&binding.session, &transform_id)`. On a
  match of `completed.generation == generation && page_complete &&
  completed.final_digest == page_digest` (`:9449-9451`) it returns
  `PreparedOutcome::Response(completed.result.clone())` (`:9453`) without
  re-running anything. On a digest mismatch it returns `digest_mismatch`
  (`:9455-9459`).
- `:1165-1170` — `TransformPageCoordinator::completed` looks up the session and
  filters on `completed.transform_id == transform_id`.
- `:1042-1047` — `CompletedTransformPage` is an in-memory struct holding a
  `PreparedOutput`.
- `:9558-9568` — where it is stored, after the terminal step returns.

Why it does not survive a restart:

- `:2947` — the coordinator is a plain `Mutex<TransformPageCoordinator>` field on
  `McHandler`.
- `:1075-1085` — `Default` starts with an empty `sessions` map, so a fresh process
  has no `completed` slots.
- `:12097` — `shutdown` overwrites the coordinator with `Default`, discarding
  every slot.

There is no durable page-level dedup. Compare the state-import path, which does
have one:

- `:5678-5686` — `store.preflight_state_import(&parsed.session_id, &parsed.import_id)`
  returning `StateImportPreflight::Duplicate { imported }` short-circuits with
  `"duplicate": true`. That record lives in the store, so it survives a restart.
  The existing test `state_import_id_is_durable_and_wins_before_nonempty_check`
  (`:26967`) names the durability explicitly.
- Nothing analogous exists keyed on `transform_page_id`. The terminal step for
  pages is `handle_transform_unpaged_value` (`:9528-9536`), whose own durable
  protection is a cache-state compare-and-swap, not a request-identity record.

A second, restart-independent hole in the same guard:

- `:9537-9540` — `completed_result` is `Some(bytes)` only for
  `PreparedOutcome::Response`; both `PreparedOutcome::Error { .. }` and
  `PreparedOutcome::Streamed` yield `None`.
- `:9558` — the slot is therefore stored only on the `Some` branch. An errored or
  streamed final page leaves no guard at all, even with no restart involved.
- `:9549-9572` — and the `Applying` phase is released regardless (`:9554`), so the
  session returns to `Idle` and a redriven final page re-enters `stage` normally.

Reachability, both sides per METHOD.md rule 4:

- Config default: none. Both the guard read (`:9446`) and the store (`:9558`) are
  on the unconditional paged-transform path, dispatched on field presence at
  `:7985-7986`.
- Shipped setup path: `packages/plugin/src/hooks/magic-context/module-wire.ts:1097`
  pages any body over `MODULE_PAGE_MAX_BYTES` = `512 * 1024`
  (`module-wire.ts:20`).
- Class: `default-production`.

## Failure scenario

A five-page series' final page arrives. `handle_transform_unpaged_value` runs and
commits its cache-state transition. Before the response reaches the caller, or
before the caller records success, the process restarts. The caller redrives the
final page against the fresh process.

The fresh process has no `completed` slot, so the guard at `:9446-9460` does not
fire. But note the redrive cannot succeed on its own: a lone final page arrives at
the `Idle` arm with `page_index == 4`, fails `page_index != 0` (`:1197`), and gets
`attempt_mismatch`. So the caller must re-send the whole series, and it is the
*re-sent series' final page* that reaches
`handle_transform_unpaged_value` a second time.

Whether that second call produces a second durable effect depends entirely on the
cache-state CAS inside `handle_transform_unpaged_value` (`:8007-8615`), which this
lens does not own. This is why the record is stated as an obligation with an open
question rather than as a confirmed double-apply.

Applying METHOD.md's effect-accounting rule, the honest statement is per
identity. For one `(session, transform_page_id, generation)`:

- attempted final-page deliveries: 2 in the scenario above.
- acknowledged final-page responses: 0, because the first response was lost.
- committed cache-state transitions must be at least 0 and at most 2.

The per-identity count is the primary oracle. The aggregate bounds are a cheap
screen only, because in a one-to-one contract an aggregate over-count on one
identity can cancel an under-count on another.

## Timing windows and dependencies

The window is between the durable commit inside `handle_transform_unpaged_value`
and the caller observing the response. A restart inside that window loses the
acknowledgement and the guard simultaneously, which is what makes the two
failures coincide rather than being independent.

The streamed and errored variants at `:9537-9540` widen the exposure: for those
outcomes the guard is absent with no restart at all, so the window becomes simply
"the caller redrives after a non-`Response` outcome".

Dependency: confirming or refuting the record needs the sibling lens's finding on
the CAS predicate. Until then the confidence is `medium` and the Status stays
`active` rather than being resolved either way.

## What a test must construct

1. Build handler H1 over a fixed store directory. Bind route 1 to session A.
2. Send a three-page series to completion. Capture the response and the resulting
   durable cache state, including its generation.
3. Assert `sessions["A"].completed.is_some()`, establishing the guard exists.
4. Redrive the final page against H1. Assert the response is byte-identical to
   the captured one and that the durable cache state did not change. This is the
   in-process arm and should pass today.
5. Drive `H1.shutdown()`. Build H2 over the same store. Re-send the whole series.
6. Per-identity oracle: assert the number of committed cache-state transitions
   for that `(session, transform_page_id, generation)` is exactly 1 across both
   processes.
7. Separate arm for the non-`Response` hole: arrange for the terminal step to
   return `PreparedOutcome::Error`, then redrive the series in the *same* process
   and apply the same per-identity oracle. The `drive-fault` feature block at
   `:13229-13337` exists to inject handler faults and is the natural lever, though
   it is absent from a default build.

Step 4 is the control that proves the guard works when present; step 6 is the
finding.

## Investigation log

### Q: Does the cache-state CAS in `handle_transform_unpaged_value` reject a second application at the same generation?

- Sources examined: the call site (`:9528-9536`) and the method's declared range
  (`:8007-8615`), plus the scope map's description of the CAS as living at the end
  of `transform.rs`'s `apply_once` (`transform.rs:3222-5697`, described in
  `part-4-module/_lenses/scope-map-and-risk-ranking.md`).
- Findings: the CAS exists and is generation-keyed, which makes rejection
  plausible. But the predicate's exact form, and specifically whether it compares
  the pre-state or only the generation counter, is inside `apply_once`, which is
  sub-part 4b's territory and the per-handler atomicity lens's within 4c.
- Missing evidence: the CAS predicate itself. Reading it would mean reading
  2,476 lines outside this lens's focus, and the sibling lens is already assigned
  to it.
- Conclusion: unresolved, needs the sibling 4c per-handler atomicity finding. If
  the CAS rejects, this record downgrades to a redundancy note saying the
  in-process guard is an optimisation rather than a correctness guard. If it does
  not, this is a double-apply across a restart.

### Q: Is a paged transform ever answered with `PreparedOutcome::Streamed`?

- Sources examined: the match at `:9537-9540`, the `PreparedOutcome` variants as
  used across the handler, and `respond_transform` (`:13339-13441`) plus
  `settle_prepared_with` (`:12150-12205`), which is where the streamed arm is
  handled.
- Findings: the handler code explicitly enumerates `Streamed` at `:9539`, which
  means the author considered it possible on this path. Whether it actually occurs
  depends on the response-assembly logic in sub-part 4d.
- Missing evidence: the conditions under which `respond_transform` yields
  `Streamed`.
- Conclusion: unresolved, needs the 4d response-assembly finding. Recorded as an
  open question on the record. If `Streamed` is reachable here, the guard is
  absent on that path with no restart required, which would be a strictly cheaper
  reproduction than the restart scenario.
