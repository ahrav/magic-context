# facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes

## Discovery trigger

The task named this directly: Part 4c found two handlers returning success
without writing, and asked whether response assembly can mask that from the
caller. `ctx_reduce` is the first of the two, and the answer is that assembly
cannot mask it because assembly never sees it. The masking happens in the
handler's own choice of text and `isError` value.

## Evidence trail

`crates/mc-module/src/lib.rs:10482-10588`, `handle_ctx_reduce_facade`.

Reads only, no writes:

- `:10487` — `facade_arguments(request, &["drop"])`.
- `:10490` — `non_empty_string_arg(&args, "drop")`, else
  `tool_error_result("Error: 'drop' must be provided.")`.
- `:10493-10500` — `parse_tag_range_string(raw_drop)`. The comment at
  `:10495-10496` calls the parser "the delivery-side canonicalizer" and says its
  exact rejection is surfaced "so acknowledgement and asynchronous delivery
  cannot disagree about range syntax". So the handler is explicitly designed as
  an acknowledgement that shares a canonicaliser with a later delivery step.
- `:10501-10507` — `resolve_facade_scope(channel, Some(&args), "memories", false)`.
  The fourth argument is `bind_authority_for_write: false`, so no authority route
  is bound and the draining check at `:10455-10459` is skipped.
- `:10513` — `store.load_tags_for_session(session_id)`.
- `:10517` — `store.load_pending_agent_drops(session_id)`.
- `:10521-10551` — pure classification of the requested tag numbers into
  `unknown`, `already_queued`, and `queueable`.
- `:10552-10562` — if nothing is queueable, `tool_error_result` with
  "Refused: no valid tags to queue." That is the one path with
  `isError: true`.
- `:10564-10584` — protected-tail partition into `immediate` and `deferred`
  using `DEFAULT_PROTECTED_TAGS`, then detail strings.
- `:10585-10587` — the answer:

      // This acknowledgement validates the durable tag state but deliberately does not
      // mutate it. The response observer owns asynchronous delivery on this facade.
      mcp_text_result(format!("Queued: {}.", details.join("; ")), false)

  `is_error = false` and the leading word is "Queued".

Grepping the whole handler range for `command_id` returns nothing, so the key the
existing test supplies (`:25467`) is accepted by `facade_arguments` and never
read here.

The delivery leg that does write:

- `:12280` — the router's `"agent_drops.append"` arm.
- `:5776-5890` — `handle_agent_drops_value` (4c's range). The existing test drives
  it directly at `:25478-25487` and asserts
  `json!({ "ok": true, "queued": 2 })`, then a retry with the same `command_id`
  yields `json!({ "ok": true, "queued": 0, "duplicate": true })`
  (`:25497-25501`). So the delivery leg both writes and reports a replay marker.

The existing test pins the no-write behaviour:

- `:25445-25446` — the test name is
  `facade_ctx_reduce_ack_validates_unknown_queued_and_protected_tags_without_committing`.
- `:25471-25473` — asserts the acknowledgement text contains
  `drop §1§`, `deferred drop §21§`, and `tags 99, 100 not found`.
- `:25474` — `assert!(store.load_pending_agent_drops("ses").unwrap().is_empty());`

## Failure scenario

The acknowledgement and the effect are two separate requests, and only the
second one writes. Between them:

- If the response observer never issues `agent_drops.append`, the drop never
  happens. The caller was told "Queued: drop 1; deferred drop 21." with
  `isError: false` and has no field, code, or marker to distinguish that from a
  completed queue.
- If the observer issues it but the module has restarted, or the route has been
  unbound, or the store is unavailable, the same gap opens.
- The tag numbers the acknowledgement reports as queued are computed from a
  snapshot of `load_tags_for_session` at acknowledgement time. If the tag set
  moves before delivery, the delivery leg queues a different set. The test's own
  comment at `:25476-25477` describes this as intended: "It queues only known
  tags, leaving acknowledgement validation side-effect free."

This is why the property is stated as a two-sided effect bound rather than an
equality. The acknowledgement is the ATTEMPTED count and the delivery leg's
`queued` value is the ACKNOWLEDGED count, and METHOD.md's effect-accounting rule
applies: observed pending drops are at least the acknowledged count and at most
the attempted count. Aggregate totals can cancel across sessions, so the check
must be per session id.

## Timing windows and dependencies

The window is between `:10587` returning and the observer's
`agent_drops.append` landing. It is unbounded from the module's side: nothing in
`handle_ctx_reduce_facade` records that an acknowledgement was issued, so the
module cannot detect an acknowledgement that was never delivered. There is no
timer, no pending-acknowledgement table, and no reconciliation pass.

Dependencies for reachability:

- Advertised in a default build: `manifest` (`:15977-15991`) through
  `prompt_surface::module_tools` (`prompt_surface.rs:160-230`), with the default
  preset `Full` (`prompt_surface.rs:112-122`).
- `ctx_reduce` does not consult `memory_enabled`, unlike `ctx_memory`
  (`:10608-10610`), so the `config.rs:124` default is irrelevant to this path.
- The plugin's `ctx-reduce-availability.ts:82` and `reclaim-protection.ts:15`
  both name the tool, so the shipped surface uses it.

## What a test must construct

1. A bound route, a store, and a seeded tag set. `:25453-25461` shows the shape:
   21 `TagMintInput` rows through `seed_tags_for_test`.
2. Call `ctx_reduce` with a `drop` range that has at least one queueable tag.
   Record the tag numbers the response text names as queued.
3. Assert `load_pending_agent_drops` is empty, which is the ATTEMPTED-only state.
4. Do NOT deliver. Assert the two-sided bound at that point:
   acknowledged (0) <= observed (0) <= attempted (the reported count). The bound
   holds trivially, which is the point: it is the cheap screen.
5. Deliver once and assert the bound again with acknowledged equal to the
   delivery leg's `queued` value.
6. The primary oracle is per-tag, not aggregate: for each tag number the
   acknowledgement named as immediate, assert that after delivery either that
   tag's `block_id` is pending or the delivery leg reported it as not found. That
   catches a case the counts cannot, where one tag is queued and a different one
   is dropped.
7. To make the record non-vacuous, the campaign must reach the state where an
   acknowledgement is issued and delivery does not follow. Without that state the
   property is only ever evaluated on the happy path.

## Investigation log

### Q: Should the acknowledgement carry a delivery-pending marker so the caller can distinguish acknowledgement from effect?

- Sources examined: `lib.rs:10585-10587`, the comment and the response;
  `lib.rs:10552-10561`, the refusal path, which does use `isError: true`;
  `lib.rs:15290-15311`, `facade_command_outcome`, which shows the codebase
  already has a convention for marking a response that did not execute
  (`"replayed": true` at `:15303`); `lib.rs:25445-25500`, the existing test, which
  asserts the text but never asserts the absence of a pending marker;
  `packages/plugin/src/hooks/magic-context/ctx-reduce-availability.ts:82` and
  `packages/plugin/src/features/magic-context/reclaim-protection.ts:15`, the two
  plugin sites that name the tool, to see whether either consumes a marker.
- Findings: the refusal path proves the handler is willing to use `isError` when
  it declines, so the `false` at `:10587` is a deliberate statement that the call
  succeeded. `facade_command_outcome`'s `replayed` field proves the response
  envelope tolerates an extra sibling key alongside `content` and `isError`
  without breaking the MCP shape, so adding a marker is mechanically available.
  Neither plugin site reads anything from the acknowledgement body beyond
  availability gating. The `§n§` tag notation in the text (`:25471`) is the
  module's own tag rendering, so the text is already module-controlled.
- Missing evidence: whether any consumer would act on a pending marker. The
  model is the primary reader of `content[0].text`, and whether a marker changes
  model behaviour usefully is a prompt-surface question, not a code question.
- Conclusion: needs human input. The mechanism is available and the codebase has
  a precedent for it; whether the model should be told "queued, delivery pending"
  rather than "Queued" is a prompt-surface decision owned outside this lens.
