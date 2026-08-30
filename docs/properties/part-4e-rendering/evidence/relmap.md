## Relationship map

Grouped by shared mechanism rather than by lens or by group heading, because the
mechanism is what decides whether one check can stand in for another. Every
dominance statement is a hypothesis, not a finding.

- **One index space, three stages allowed to shrink it.**
  [render-a-overlay-targets-stale-indices-after-full-drop-filter](#render-a-overlay-targets-stale-indices-after-full-drop-filter),
  [render-a-emptied-tail-message-drops-without-a-report](#render-a-emptied-tail-message-drops-without-a-report),
  [render-a-composition-order-is-fixed-and-each-unit-appears-once](#render-a-composition-order-is-fixed-and-each-unit-appears-once).
  All three turn on the same fact: `apply_surface_strips` (`transform.rs:10388`),
  the full-drop filter (`:12014-12021`) and
  `remove_frozen_historical_reasoning` (`:12035`) may shorten `content`, and the
  overlay that follows still addresses blocks by their pre-removal `block_index`
  (`:8227-8231`). One fixture serves all three: a retained tail message with a
  removable block followed by two taggable blocks. Hypothesis: the composition
  record dominates neither of the others, because a subsequence-and-uniqueness
  check over mids cannot see a within-message index shift or an emptied message
  that never reaches `out`. The index record and the drop record are the two
  outcomes of one shrink, split by whether the shift lands inside the array
  (misattribution) or off its end (a skipped overlay at `:8227`), so a single
  harness that records `(block_id, overlay_string)` pairs before and after the
  filter answers both.
- **A whole message leaves the array and nothing names it.**
  [render-a-emptied-tail-message-drops-without-a-report](#render-a-emptied-tail-message-drops-without-a-report),
  [nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report](#nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report),
  [render-a-duplicate-tool-use-repair-is-release-only](#render-a-duplicate-tool-use-repair-is-release-only).
  Three producers of one outcome, at three different points in the pass:
  reclassification at ingress (`transform.rs:2419`, excluded from the tail loop at
  `:11842-11845`), the `present` gate mid-loop (`:12037-12039`), and the release
  repair at the very end (`:11297-11299`). Hypothesis: no dominance, because the
  oracles differ in kind. The first needs a forged tool-call id, the second needs
  a strip or a reasoning removal, the third needs a duplicate id and a release
  build. What they share is the detection strategy: count retained mids against
  emitted mids per pass and refuse to read the answer off the return type, which
  is the same strategy 4c and 4d arrived at for missing durable writes.
- **The only defence is compiled out or compiled test-only.**
  [render-a-duplicate-tool-use-repair-is-release-only](#render-a-duplicate-tool-use-repair-is-release-only),
  [render-a-orphan-tool-arc-has-no-production-detection](#render-a-orphan-tool-arc-has-no-production-detection).
  Two halves of one function pair at `transform.rs:11171-11305`, and the pairing
  is economic as well as diagnostic: `enforce_unique_tool_use_ids` runs in
  production at a cost comparable to the guard that does not, which is what makes
  the asymmetry look unintentional rather than a considered trade. Hypothesis: the
  orphan record dominates the duplicate record's *consequence* but not its
  *check*, because the duplicate repair is itself a producer of orphans
  (`:11258-11277` removes an adjacent result), so an arc check running in
  production would catch a bad repair while a duplicate check would not catch an
  arc broken by a strip. Both must state the build profile, and no other record in
  this part does.
- **A tag number that names nothing.**
  [render-a-mint-batch-block-ids-are-unique-per-pass](#render-a-mint-batch-block-ids-are-unique-per-pass),
  [render-a-channel2-derived-tag-numbers-name-no-durable-row](#render-a-channel2-derived-tag-numbers-name-no-durable-row).
  Both are about a `§N§` the agent cannot resolve, from opposite directions. The
  mint record is the property expected to hold, and it is what makes the durable
  numbering trustworthy; the Channel-2 record is a deliberate process-local
  numbering (`transform.rs:9279-9281` says so) that reaches agent-visible bytes
  through `format_reclaimable_hint` (`:9872`). Hypothesis: neither dominates,
  because the mint record's oracle is a pre-commit comparison against `mc_tags`
  and the Channel-2 record's oracle is a post-render scan of served text against
  the same table. What they share is the table, so one fixture that renders a pass
  and then reads `mc_tags` back serves both, and both are blocked on the same
  unresolved question about the store's generation triggers.
- **A path the arithmetic or the build makes dead.**
  [render-a-user-hint-total-cap-cannot-bind](#render-a-user-hint-total-cap-cannot-bind),
  [render-a-light-surface-fallback-notice-never-served](#render-a-light-surface-fallback-notice-never-served),
  [nudge-b-todo-availability-fail-open-is-unreachable](#nudge-b-todo-availability-fail-open-is-unreachable).
  Three dead paths with three different keepers: a computed maximum of 458 UTF-16
  units against a cap of 800, two `Option` constants that are unconditionally
  `Some`, and a normalizing wrapper (`todo_synthesis_verdict`,
  `transform.rs:2626-2630`) that collapses the `Option` before the documented
  fail-open branch can see it. Hypothesis: no dominance, and the grouping's value
  is that a reviewer reading them together sees the same failure mode three times:
  a comment or a constant describing behaviour the build forbids, with a
  `debug_assert!` or a doc comment as the only witness. The third is the most
  dangerous of the three, because its documentation would tell a future caller to
  manufacture a synthetic tool call without host authority, which
  `transform.rs:739-741` says must never happen.
- **An overlay that stops, and one that does not.**
  [nudge-b-frozen-todo-pair-retires-only-on-a-bust](#nudge-b-frozen-todo-pair-retires-only-on-a-bust),
  [nudge-b-channel1-append-first-applies-without-a-frontier-gate](#nudge-b-channel1-append-first-applies-without-a-frontier-gate),
  [nudge-b-channel1-append-rows-have-no-reaper](#nudge-b-channel1-append-rows-have-no-reaper).
  Three points on one axis: an overlay with a strict retirement rule, an overlay
  with no first-apply gate, and the same overlay with no retirement at all.
  Hypothesis: the frontier-gate record dominates the reaper record's *first* cost
  and not its second. A check asserting that every newly inserted overlay row's
  `block_id` is absent from `served_output_fingerprint` also bounds how often a row
  can be created against a served block, but it says nothing about accumulation
  over a long session, and nothing at all about a stale row resurfacing on a
  reconstructed block id. The todo-pair record is the control in this cluster: it
  is the one injected thing with a retirement rule that actually holds, and it is
  the only one whose absent placement is a hard error
  (`SyntheticTodoAnchorMissing`, `transform.rs:12125-12133`) rather than an
  absorbed skip.
- **Idempotence delegated to the caller.**
  [nudge-b-opencode-channel2-arm-has-no-module-side-latch](#nudge-b-opencode-channel2-arm-has-no-module-side-latch),
  [nudge-b-channel2-retirement-is-caller-asserted](#nudge-b-channel2-retirement-is-caller-asserted).
  The two Channel-2 arms, and they are opposites rather than variants: one keeps a
  durable directive id, an arming watermark and a 10-minute lease
  (`transform.rs:9435-9513`), the other writes nothing at all (`:9347-9365`).
  Hypothesis: the OpenCode record is the more urgent by a wide margin, because it
  is the profile the shipped host sends (`rust-mode-transform.ts:1339`) and its
  failure mode is a `<system-reminder>` on every pass while pressure is high,
  while the Claude Code record's damage is bounded to one arming cycle by the TTL.
  Neither dominates the other as a check, since they need different profiles, and
  the pair is what makes the finding legible: the arm with the protocol is the arm
  nothing in this tree exercises, and the two module rearm helpers
  (`:9412-9433`) clear state the live arm never reads.
- **Unmarked authorship.**
  [nudge-b-injected-todo-pair-carries-no-provider-visible-provenance](#nudge-b-injected-todo-pair-carries-no-provider-visible-provenance),
  [nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block](#nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block).
  One harness serves both: render a pass with a frozen pair and a non-empty hint
  decision, then ask of every emitted message whether it corresponds to an ingress
  message or carries a marker its consumer reads. Hypothesis: the hint record
  dominates the pair record's check but not its consequence. The hint's envelope is
  demonstrably forgeable, and the module's own
  `has_stacked_user_hint_augmentation` (`transform.rs:8989-8997`) is the proof, so
  a check that rejects text-only markers rejects the pair's `mc_synthetic_todo_`
  id prefix for the same reason. The consequence runs the other way: the pair is a
  whole assistant turn the model never took, with a `completed` status, which is a
  heavier misattribution than a paragraph appended to a message the user did send.
- **A decision with no counter.**
  [nudge-b-overlay-suppression-and-firing-are-unreportable](#nudge-b-overlay-suppression-and-firing-are-unreportable),
  [nudge-b-channel1-suppression-flag-is-never-set](#nudge-b-channel1-suppression-flag-is-never-set),
  [render-a-hygiene-metric-ignores-surface-strips](#render-a-hygiene-metric-ignores-surface-strips).
  Hypothesis: the unreportable record dominates the never-set-flag record's
  *detectability* and neither its cause nor its cure. `TransformTimings` counts
  `tag_mint_new` (`:1218`) and nothing else about overlays, so adding the seven
  counters the unreportable record asks for would make a missing suppression
  observable; it would not make the flag get written, and the actual behaviour
  after a compliant reduction is worse than absent suppression, because lowering
  reclaimable tokens takes the `reset_cycle` arm (`:9565-9566`) and re-arms the
  ladder from `Gentle`. The hygiene record is grouped here and is a different
  animal: it is the only record in the part where a number *is* reported and is
  wrong, and it is the only one whose consequence is amplified by a second
  document, because the bands were calibrated on the measurement the code does not
  make.
- **Situation coverage against vacuous passes.**
  [render-a-hint-fragment-cap-binds-in-a-served-render](#render-a-hint-fragment-cap-binds-in-a-served-render),
  [nudge-b-one-block-carries-several-overlay-kinds](#nudge-b-one-block-carries-several-overlay-kinds),
  [render-a-render-is-deterministic-over-fixed-inputs](#render-a-render-is-deterministic-over-fixed-inputs).
  The two `sometimes` markers plus the property they protect. Hypothesis: the
  multiply-overlaid-block marker is the more urgent, because it gates the
  index-shift cluster above and the fixed mutator order at `:8233-8254`, and
  because three overlay kinds on one user text block is an ordinary state that no
  existing test constructs. The fragment-cap marker gates the only budget in 4e
  that binds in ordinary operation, which is why it is worth a marker at all
  rather than a unit test on `one_line_fragment`. The determinism record sits with
  them because it is what the markers are ultimately protecting: the cache
  discipline in the module header (`transform.rs:1-16`) rests on a replay
  producing identical bytes, and the one order-sensitive site
  (`tail_hygiene.rs:364`) is order-independent only because of an arc-id
  assignment in 4f (`ck_wire.rs:440-451`) that nothing local enforces.

### Cross-part relationships

Two ties are strong enough to state as relationships rather than resemblances,
and one of them closes a sibling part's open question.

**Tag numbering with multiple authorities was first found in 4b, and lens A shut
the projection route.** 4b's
[`speculative-tag-numbering-has-two-authorities`](../part-4b-transform/catalog.md#speculative-tag-numbering-has-two-authorities)
records that the engine assigns numbers in memory as `max(loaded tag_number) +
offset + 1` (`transform.rs:8029`) while the store re-reads `MAX(tag_number)` per
row and **skips** any input whose `block_id` already exists
(`mc-store/src/lib.rs:7488-7500`), so one skipped input desynchronises every later
number in the batch. That record named two possible triggers and left the choice
to 4e: a duplicate `block_id` inside one batch, or a batch whose
`existing_tag_ids` filter is computed from a stale baseline. Its open question was
explicit: "Can `compute_active_overlay_decisions` emit a `block_id` that already
has a tag? Unresolved, needs 4e."

**Lens A answers the first half: not from the projection.** `apply_once` returns
`TransformError::DuplicateBlockId` at `transform.rs:3354-3356`, and that check
runs before the mint at `:3806`, so a duplicate projection block id cannot reach
the batch. Worth stating precisely, because the mint loop would not have caught it
on its own: the loop's `existing_tag_ids` filter is a snapshot taken at
`:8595-8598` and never updated as rows are appended (`:7898-7920`). So one of 4b's
two doors is shut by an upstream guard rather than by the mint, and the surviving
trigger is the stale-baseline route.
[render-a-mint-batch-block-ids-are-unique-per-pass](#render-a-mint-batch-block-ids-are-unique-per-pass)
carries that residue and narrows it further: both cached hydration paths in
`load_cached_tags` are fenced on a SQLite-trigger-backed `generation` (`:7529`,
`:7540`), which a delete-and-reinsert advances even when count and max are
unchanged, so the remaining question is entirely about the triggers themselves.
That is a Part 3 read and it is recorded as unresolved on both sides rather than
answered here. The net effect on 4b is that its record's reachability now rests on
one condition instead of two, which is a narrowing, not an invalidation.

**The unbounded-with-no-reaper shape recurs in Parts 3, 4c and 4d, and this part
adds two more tables.** A prior evaluation cautioned against overstating this kind
of correspondence, so what is shared and what is not is stated separately.

What is genuinely shared is one sentence: a structure grows on caller-driven
traffic, its declared bound is either absent or does not bind, and nothing removes
an entry whose purpose is spent. Part 3 has it as unbounded session-history
retention where the render budget guard becomes the only backstop
([`core-decay-archive-termination-bound`](../part-3-store-core/catalog.md#core-decay-archive-termination-bound)).
Part 4c has a whole group of it, above all a session map with no removal path
whose growth then disables the pending-count half of its own budget
([`stagelc-transform-page-session-map-has-no-removal-path`](../part-4c-handlers/catalog.md#stagelc-transform-page-session-map-has-no-removal-path))
and completed replay results charged to no budget and reaped by no TTL
([`stagelc-completed-replay-results-are-uncharged-and-unexpiring`](../part-4c-handlers/catalog.md#stagelc-completed-replay-results-are-uncharged-and-unexpiring)).
Part 4d has it as a note count with no cap and no reaper, fully materialized per
poll
([`note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll`](../part-4d-facade/catalog.md#note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll)).
This part adds `mc_channel1_appends` and `mc_temporal_marks`
([nudge-b-channel1-append-rows-have-no-reaper](#nudge-b-channel1-append-rows-have-no-reaper)).

Four differences matter, and each changes what a test would do. First, the medium:
Parts 3, 4c and 4d are about resident memory or a rendered budget, where the cost
is paid continuously by the running process, while this part's rows are on disk,
where the cost is paid at load time and the row is otherwise inert. Second, the
second-order cost: 4c's session map converts unbounded growth into a *disabled
cap*, which is a strictly worse shape than accumulation, and nothing here does
that. Third, the resurfacing hazard is this part's alone: a stale overlay row is
inert only while its block is out of the projection, so the interesting failure is
not size but a reminder reappearing and quoting a token count from a session state
that no longer exists, which is why the record's second open question is a 4b
question about block-id reconstruction rather than a capacity question. Fourth,
the local contrast is sharper here than in the other parts: the third table in the
same family, `mc_user_hints`, *does* have a reaper (`mc-store/src/lib.rs:7736-7760`),
which makes the other two an omission rather than a uniform design decision.

Three smaller ties are recorded without being resolved. 4b's
`output-cache-replace-trails-the-accepted-commit` sits next to lens C's claim 13,
that the serialized-output cache records what was built rather than what was
served, since every `record_output_item` call precedes
`enforce_unique_tool_use_ids`; the two need a joint reading of the cache's
contract rather than a fix on one side. 4d owns `parse_tag_range_string`
(`lib.rs:15165-15210`) and `handle_ctx_reduce_facade` (`:10482-10588`), which
decide whether
[render-a-channel2-derived-tag-numbers-name-no-durable-row](#render-a-channel2-derived-tag-numbers-name-no-durable-row)
is a no-op or a misattributed reduction; lens A left that open for 4d. And 4f owns
both `ck_wire.rs:440-451`, which is what keeps
[render-a-render-is-deterministic-over-fixed-inputs](#render-a-render-is-deterministic-over-fixed-inputs)
true today, and the codec question behind
[nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report](#nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report),
namely whether any production path lets a non-module actor choose a tool-call id.
