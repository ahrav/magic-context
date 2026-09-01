# nudge-b-frozen-todo-pair-retires-only-on-a-bust

## Discovery trigger

Task 1 asked whether an overlay can be consumed twice or never. Walking
`injection.rs` for the answer surfaced a state machine whose retirement is gated
on a pass classification the caller does not control, which is unusual in this
crate: most overlay state is gated on caller-supplied fields. That asymmetry is
worth a property on its own.

## Evidence trail

`HEAD` `e447c927`. All lines read back.

The unit is `FrozenSyntheticTodoPair`, produced by
`SyntheticTodo::freeze_at` (`crates/mc-module/src/injection.rs:81-88`) and stored
in `ModuleMeta::synthetic_todo`.

`advance_injection` (`injection.rs:300-341`) is the whole transition. Its first
statement is the defer short-circuit:

- `injection.rs:306-312` — `if !is_bust_pass { return if frozen.is_some() { Keep }
  else { None } }`. A defer pass therefore cannot build, cannot replace, and
  cannot clear.
- `injection.rs:314-318` — on a bust, a `Some(false)` availability verdict
  substitutes the literal `"[]"` for the persisted state.
- `injection.rs:322-324` — a state that fails `normalize_todo_state_json` yields
  `None`, which leaves an existing frozen unit alone.
- `injection.rs:325-331` — a state that normalizes but produces no pair (empty,
  or every todo terminal) yields `Clear` if something is frozen and `None`
  otherwise.
- `injection.rs:333-340` — an equal call id yields `Keep`; anything else yields
  `Replace`.

The capture side has the same gate. `capture_todo_state_on_bust`
(`injection.rs:206-222`) returns `false` immediately when
`!is_bust_pass || todo_tool_present == Some(false)` (`:212-214`), so a defer pass
cannot move `meta.last_todo_state` either. That matters: without it a defer pass
could leave the metadata ahead of the frozen pair and the next bust would replace
on the basis of a state observed during a pass that promised not to change
anything.

The transform wrapper is `advance_synthetic_todo`
(`crates/mc-module/src/transform.rs:7442-7475`):

- `:7458-7460` — `Replace` freezes at `tail_end_mid(req, meta.coverage_ordinal)`.
- `:7461` — `Clear` sets `meta.synthetic_todo = None`.
- `:7462-7470` — `Keep` calls
  `reanchor_kept_synthetic_todo_if_folded_or_shrunk` **only when
  `is_bust_pass`**.
- `:7471` — `None` does nothing.

The reanchor helper (`:7477-7508`) is the second retirement path. When the stored
anchor mid is no longer in the tail (`:7490-7492`) and the anchor was not folded
by a coverage advance and coverage did not shrink (`:7493-7500`), it drops the
pair, with a comment citing TypeScript parity as the reason (`:7495-7497`).

`is_bust_pass` itself is `!req.is_subagent && is_provider_prefix_mutation_pass`
(`:4439`), where the latter is `matches!(plan, Hard | MigrateHard | Soft)`
(`:4435-4438`). It is derived from the pass plan, not from a request field, so a
caller cannot force a retirement by asserting a flag.

## Failure scenario

A defer pass whose plan was misclassified as `Soft` sees a newly visible
`todowrite` in the tail, captures it, and replaces the frozen pair. The served
array's synthetic messages change bytes at a position the provider has already
cached. On Anthropic the effect is worse than a cache miss: the pair sits at a
fixed anchor inside history, so the model is shown a *different* completed
`todowrite` result at a point it has already reasoned past, with
`status: "completed"` (`injection.rs:345`) and `time: {start: 0, end: 0}`
(`:355-358`).

The mirror-image failure is the `Keep` path forgetting to reanchor. If a bust
advanced coverage past the anchor and the pair kept its stale anchor, the render
would reach `:12125-12132` and return
`TransformError::SyntheticTodoAnchorMissing`, which aborts the whole transform
rather than degrading. The reanchor helper exists to prevent exactly that.

## Timing windows and dependencies

One pass. There is no interleaving component: `advance_synthetic_todo` runs
inside the single-threaded transform body at `:5263`, and the commit at `:5560`
is CAS-fenced on the cache-state row version, so a losing pass abandons its
`meta` entirely.

Dependencies: `req.todo_tool_present` (caller), `meta.last_todo_state`
(durable), `meta.coverage_ordinal` (durable), the pass plan (module-derived).

## What a test must construct

1. Seed `meta.last_todo_state` with an active todo state and freeze the matching
   pair. `frozen_for` (`injection.rs:510-514`) is the existing helper.
2. Run a pass with a plan outside `{Hard, MigrateHard, Soft}` and a tail carrying
   a *different* active `todowrite`. Assert `meta.synthetic_todo` is byte-equal
   before and after, and assert `meta.last_todo_state` is unchanged. The existing
   `defer_after_capture_replays_frozen_bytes` (`:739-771`) does exactly this at
   the `injection.rs` level; the gap is doing it through `run_transform`.
3. Run a bust pass with an all-terminal tail and assert the pair is gone. The
   `injection.rs`-level version is `defer_never_clears_but_bust_does`
   (`:600-613`).
4. For the reanchor arm: freeze at anchor `m-a`, then run a bust whose coverage
   advances past `m-a` and assert the anchor moved to the new tail end rather
   than the pass failing.

The load-bearing assertion in all four is byte equality of the two emitted
synthetic messages, not just equality of the call id, because
`freeze_at` carries `anchor_mid` alongside the messages and only the messages
reach the provider.

## Investigation log

### Q: The stale-anchor arm drops the pair on a bust. Can the anchor vanish on a defer pass, where the reanchor helper is not called?

- Sources examined: `transform.rs:7462-7470` (the `Keep` arm's `is_bust_pass`
  guard), `:7477-7508` (the helper), `:12091-12121` (the anchored insertion
  site), `:12125-12132` (the hard error), `tail_contains_mid` and
  `anchor_folded_by_coverage` call sites at `:7490` and `:7492`.
- Findings: on a defer pass the pair keeps whatever `anchor_mid` it had. The
  anchored insertion site requires
  `synthetic_todo_render_anchor.as_deref() == Some(msg.mid.as_str())` (`:12094`),
  where the render anchor is computed by
  `synthetic_todo_render_anchor_mid(projection, anchor)` (`:11838-11839`,
  fn at `:10640-10642`). If the anchor mid is absent from the request entirely,
  the loop never matches and `:12127-12131` returns
  `SyntheticTodoAnchorMissing`. So the defer path fails loud rather than
  dropping.
- Missing evidence: whether a defer pass can present a message set that omits a
  mid the previous pass carried. That is a pass-plan and delta-expansion
  question, and `tail_delta` handling is 4b scope.
- Conclusion: unresolved, needs 4b. The consequence is bounded and visible (a
  `TransformError`, not silent corruption), so it does not change this record's
  check.

### Q: Can a caller force a retirement?

- Sources examined: `transform.rs:4435-4439` (`is_bust_pass`),
  `:2626-2630` (`todo_synthesis_verdict`), the four production call sites
  (`:4155`, `:4529`, `:4826`, `:7454`).
- Findings: two caller-supplied inputs reach the transition.
  `req.todo_tool_present == Some(false)` forces the `"[]"` substitution
  (`injection.rs:314-318`) and therefore a `Clear`, but only on a pass that is
  already a bust. `req.is_subagent` can suppress `is_bust_pass` entirely
  (`:4439`), which makes every pass behave as a defer and freezes the pair. So a
  caller can *prevent* retirement indefinitely by claiming to be a subagent, and
  can *cause* retirement only on a pass the module already classified as
  bust-worthy.
- Missing evidence: none.
- Conclusion: resolved. Retirement is module-gated; suppression of retirement is
  caller-reachable. The suppression direction is the safe one for this property
  (frozen bytes stay frozen), so it is noted rather than recorded separately.

### Q: Is `Keep` genuinely byte-stable, or does it rebuild?

- Sources examined: `injection.rs:333-340`, `transform.rs:7462-7470`,
  `same_state_bust_is_idempotent` (`injection.rs:615-624`),
  `ck_pair_byte_determinism_golden` (`:866-904`).
- Findings: `Keep` carries no payload, and the `Keep` arm in
  `advance_synthetic_todo` touches only `anchor_mid`, never the messages
  (`:7503-7506`). `disabled_verdict_replays_until_bust_then_clears_without_recapture`
  (`:661-704`) additionally asserts `frozen == frozen_before` after a defer pass
  with an explicit comment saying "defer must keep the frozen pair byte-stable"
  (`:678-680`).
- Missing evidence: none.
- Conclusion: resolved with answer. `Keep` never rebuilds; the only mutation on
  that path is the anchor, and only on a bust.
