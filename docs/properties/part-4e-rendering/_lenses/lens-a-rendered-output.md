# Part 4e lens A: rendered output fidelity and tag/overlay composition

One attention focus: whether the rendered artifact faithfully represents the
underlying state, and what the composition can silently drop, duplicate, or
misattribute. The nudge overlay's own lifecycle belongs to a sibling lens; this
pass owns rendering and tags.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Method contract in
[../../METHOD.md](../../METHOD.md). Scope and region maps taken from
[../../part-4-module/_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md),
sub-part 4e: `transform.rs:7511-12623`, `tail_hygiene.rs`, `decay_render.rs`,
`caveman.rs`, `memory_render.rs`, `classify.rs`, `prompt_surface.rs`.

Every line reference below was read back at `HEAD` before it was written. The
region map's line numbers for `transform.rs` still hold at `e447c927`: the
anchors `build_output_with_tags_inner` (`:11678`), `apply_surface_strips`
(`:10371`), `compute_active_overlay_decisions` (`:8574`) and `load_cached_tags`
(`:7639`) are all exactly where the map says. One correction to the map is
recorded under [Contract-vs-code leads](#contract-vs-code-leads).

## Rendering pipeline map

### Inputs

`build_output_with_tags_inner` (`transform.rs:11678-12156`) is the single
byte-producing splice. Its inputs are:

| Input | Origin | Mutability |
| --- | --- | --- |
| `core: &CoreState` | the loaded cache state; supplies `frozen_units` | read-only borrow |
| `meta: &ModuleMeta` | coverage ordinal, anchor block id, synthetic todo pair | read-only borrow |
| `projection: &FlatProjection` | `ck_wire` projection of `req.messages` | read-only borrow |
| `req: &TransformRequest` | the harness's decoded CK array plus profile flags | read-only borrow |
| `tag_overlay: Option<&TagOverlayState>` | built by `tag_overlay_state` (`:8140-8169`) from durable tag, temporal, user-hint and Channel-1 rows | read-only borrow |
| `tag_numbers: &BTreeMap<String, u64>` | per-message tag numbers | read-only borrow |
| `cache_snapshot: Option<&SerializedOutputCacheSnapshot>` | a copy taken from the process-global serialized-output cache | read-only borrow of a copy |
| `prefix_dirty`, `reasoning_watermark`, `renderer_transition_active`, `synthetic_todo_enabled`, `mutation_exempt_mid`, `use_frozen_unit_index` | caller-computed scalars | by value |

So the splice itself takes no store handle and no lock. It is pure over its
arguments up to two things that do not reach the bytes: `Instant::now()` for
`BuildOutputTimings` (`:11693`, `:11698`, and the per-stage timers), and
`eprintln!` in the duplicate-id belt (`:11241-11245`).

The **inputs are not pure**, and this is where mutable process state enters.
`tag_overlay` and `tag_numbers` derive from `load_cached_tags`
(`:7639-7697`), which reads and writes the process-global
`tag_baseline_cache()` singleton (`:7597-7600`), and the mint decision reads and
writes the process-global `tag_mint_frontier_cache()` singleton (`:8014-8021`)
inside `compute_active_overlay_decisions` (`:8601-8619`). Both are `OnceLock<Mutex<..>>`
with a 64 MiB budget each (`:144-145`). `cache_snapshot` is likewise a copy of a
process-global cache. So: **the render is a pure function of its arguments; the
arguments are computed by reading mutable process-global state.**

### Composition order

`out` is built in exactly this order (`Vec::with_capacity(4 + req.messages.len())`,
`:11695`):

1. **`m0`** — only when `!req.is_subagent` and a frozen unit keyed `"m0"` exists
   (`:11709-11734`). Cache key `"synthetic:m0"`; the identity folds in the mural
   unit's `reset_rule` (`:11713-11716`).
2. **`m1`** — same gate, frozen unit `"m1"`, cache key `"synthetic:m1"`, identity
   the constant `"m1"` (`:11735-11755`).
3. **Unanchored synthetic todo pair** — when `synthetic_todo_enabled` and
   `meta.synthetic_todo.anchor_mid.is_none()`, the assistant call then the tool
   result (`:11804-11833`).
4. **The tail loop**, in `req.messages` order, skipping `ck.meta.synthetic`
   messages (`:11842-11846`). A message is emitted only if it passes the
   retention filter at `:11856-11862`: `is_tail(ordinal, output_coverage)`, or
   `keep_leading_system` (non-Claude-Code profile only), or `keep_lineage_anchor`,
   or `keep_split_invocation`.
5. **Anchored synthetic todo pair** — inserted immediately after the message
   whose mid equals `synthetic_todo_render_anchor` (`:12091-12121`), guarded so it
   is inserted at most once (`inserted_synthetic_todo`).
6. **`enforce_unique_tool_use_ids(out, &req.session_id)`** (`:12147`) — the last
   transformation, applied to the whole array.

`output_coverage` is `None` for a subagent (`:11764-11768`), so a subagent render
carries every message and never gets an `m0`/`m1` prefix.

### What each stage may add or remove, per tail message

Inside the tail loop, for one retained message, in order:

| Step | Site | May add | May remove |
| --- | --- | --- | --- |
| identity hash | `:11882-11897` (`message_output_identity`, `:11014-11096`) | nothing | nothing |
| cache lookup | `:11904` (`cached_output_item`, `:11098-11109`) | a whole previously-served message | nothing; but a cached `Some(None)` replays "this message renders to nothing" |
| reduced-block replacement | `:11945-11966` | `[dropped §N§]` display payload (`:11949-11956`) | replaces a block in place, index-stable |
| caveman replacement | `:11967-11990` | nothing | replaces text in place, index-stable |
| `apply_surface_strips` | `:11992-12003` (`:10371-10458`) | a provider sentinel | **collapses `content` to a single sentinel block** on a whole-message strip (`:10388-10391`) or a fully-emptied stale reduce (`:10454-10457`); otherwise index-stable |
| full-drop filter | `:12004-12023` | nothing | **removes blocks and re-indexes `content`** |
| `apply_tag_overlay_to_message` | `:12024-12031` (`:8208-8269`) | `§N§ ` prefix, temporal comment, user hint, Channel-1 reminder | nothing |
| `remove_frozen_historical_reasoning` | `:12035` | nothing | reasoning blocks |
| `present` gate | `:12037-12039` | nothing | **the whole message** |
| serializer residual / trailing blank | `:12041-12059` | a canonical blank block | a merged reasoning block |
| `enforce_unique_tool_use_ids` | `:12147` | nothing | duplicate `tool_use` blocks, and any message they empty (release builds only) |

### Final artifact shape

`BuiltOutput` (`:11001-11006`): `messages: Vec<ServedMessage>`, plus
`cache_entries: HashMap<String, SerializedOutputCacheEntry>`,
`cache_stats`, and `timings`. The array shape is the module doc's
`[m0, m1] ++ tail` (`transform.rs:1-16`). Two shape guards fire at the end:
a `debug_assert!` that the Claude-Code synthetic prefix holds no system-role
message (`:12134-12145`), and `SyntheticTodoAnchorMissing` as a hard error when
an anchored todo pair could not be placed (`:12125-12133`). The second is the
only place in the splice where a placement failure is reported rather than
absorbed.

## Tag and overlay composition map

### Numbering

Two numbering authorities exist for durable tags, and the sibling part already
owns that finding: see
[`speculative-tag-numbering-has-two-authorities`](../../part-4b-transform/catalog.md#speculative-tag-numbering-has-two-authorities).
In-memory, `append_tag_mint_rows` (`:8023-8044`) assigns
`max(loaded tag_number) + offset + 1`; in the commit transaction the store
re-reads `MAX(tag_number)` per row and skips a `block_id` that already exists.
That record's open question was whether `compute_active_overlay_decisions` can
emit a duplicate `block_id`. **This lens answers it: not from the projection.**
`apply_once` rejects a projection with duplicate block ids at
`transform.rs:3354-3356` (`TransformError::DuplicateBlockId`), and that check
runs before the mint at `:3806`. The mint loop's own filter is a snapshot
(`:8595-8598`) that is never updated as rows are appended (`:7898-7920`), so it
would not have caught an in-batch duplicate on its own. Record 6 below states
the resulting property and names the one remaining door.

Two further numbering authorities exist that are **not** durable and are
process-local:

- `tag_rows_for_hygiene` with `derive_when_empty` (`:9224-9243`) numbers taggable
  projection blocks `1..n` for the hygiene metric.
- `active_tags_for_channel2` (`:9282-9313`) numbers taggable tail blocks `1..n`
  when no stored row survives, explicitly so OpenCode host directives stay
  useful (comment at `:9279-9281`).

The second one reaches agent-visible bytes through `oldest_channel2_hint`
(`:9534-9547`) and `format_reclaimable_hint` (`:9866-9876`), which renders
`§{tag}§ tool`. Record 7 below.

### Resolution and stability across renders

- The tag baseline is hydrated by `load_cached_tags` (`:7639-7697`) with three
  paths: exact match on `(namespace, generation, count, max)` (`:7652-7654`),
  append-only tail (`:7655-7679`), cold reload (`:7682-7695`). Both cached paths
  are fenced on a SQLite-trigger-backed `generation` (`:7511-7515`,
  `:7527-7541`), which is what closes the count-plus-max blind spot the sibling
  record worried about.
- The mint frontier memo (`:7712-7727`) keys on per-block content hashes, the
  frozen-target set, and a `tagged_key` over the assumed-durable tag id set
  (`:7841-7845`), so a rejected pass invalidates the memo rather than skipping
  untagged blocks.
- Stability across renders: a tag number, once minted and committed, is read back
  by block id, so a replay renders the same `§N§`. `newest_active_tag_block_ids`
  (`:8082-8125`) additionally requires `row.kind` and `row.source_bytes` to still
  match the live carrier before a row may occupy a protected slot, and it sorts
  descending on `(tag_number, block_id)` (`:8114-8119`) rather than relying on
  row order.

### Overlay application

`apply_tag_overlay_to_message` (`:8208-8269`) walks `blocks` (projection blocks
for this mid) and writes into `message.content[block.block_index]` (`:8231`),
guarded only by `block_index >= message.content.len()` (`:8227-8229`). Every
mutator returns `bool` and the function calls `mark_modified()` on both block and
message when anything changed (`:8255-8268`); the comment at `:8256-8260`
explains why: `Serialize` prefers retained ingress bytes, so an uncleared block
silently serializes its pre-mutation form.

Order of mutators per block: tag prefix, temporal prefix, user hint, Channel-1
reminder (`:8233-8254`). A reduced block is skipped entirely (`:8230`).

### Imitation defence

`strip_leading_tag_imitations` (`:8413-8452`) strips runs of well-formed `§N§`
tokens at the start of any non-code line, applied only to assistant text
(`:8286-8290`). `well_formed_tag_suffix` (`:8475-8490`) requires `§`, at least
one ASCII digit, `§`, and then whitespace, ASCII punctuation, or end of string,
so malformed text is never partially consumed. Fenced code and inline-code spans
are tracked and passed through verbatim (`:8415-8432`, `:8454-8473`). Mint
provenance still hashes the verbatim ingress bytes (comment at `:8283-8285`),
which is what keeps `newest_active_tag_block_ids`'s `source_bytes` comparison at
`:8111` consistent.

## Observations

`file:line` for everything. All read back at `HEAD` `e447c927`.

1. `transform.rs:11171` — `assert_no_orphaned_tool_arcs` carries `#[cfg(test)]`,
   and its only non-test-module call site is also `#[cfg(test)]`
   (`:5486-5487`). It cannot execute in a production build. The scope map calls
   it a production guard.
2. `transform.rs:11251` and `:11303-11304` — `enforce_unique_tool_use_ids`
   behaves differently per build profile. Debug builds panic on the
   `debug_assert!` at `:11246-11249`; release builds run the repair block and
   return a modified array. The two arms are mutually exclusive, so exactly one
   of them is compiled.
3. `transform.rs:11297-11299` — the release repair drops a whole message from the
   array when the block removal empties it. The only report is the `eprintln!`
   at `:11241-11245`; nothing in `BuiltOutput` records it.
4. `transform.rs:12004-12023` then `:12024-12031` — the full-drop filter rebuilds
   `rebuilt.content` with `filter_map`, which re-indexes it, and the overlay that
   follows still addresses blocks by their pre-removal `block_index`.
5. `transform.rs:10388-10391` — `apply_surface_strips` can replace the whole
   `content` with a single sentinel block, shrinking the array before the same
   two index-based consumers run.
6. `transform.rs:12037-12039` — `present` is false when `content` is empty, the
   message is not synthetic, and the mid *is* in `blocks_by_mid`; `:12085-12087`
   then `continue`s. A retained tail message can leave the array with no error
   and no field in the response naming it.
7. `transform.rs:12077-12084` versus `:12147` — every `record_output_item` call
   happens before `enforce_unique_tool_use_ids` runs, so a `tail:{mid}` cache
   entry can hold the pre-repair message while the served array holds the
   repaired one. On a later pass the repair re-runs over the rebuilt array, so
   the served bytes stay consistent, but the cache entry is not what was served.
   See the open questions.
8. `transform.rs:11098-11109` — `cached_output_item` returns
   `Option<Option<ServedMessage>>`. The inner `None` is a cached "renders to
   nothing", so a drop decision is itself cached and replayed.
9. `transform.rs:11014-11096` — `message_output_identity` folds in the four
   overlay strings per block (`:11077-11086`), the message tag number
   (`:11059-11060`), the reasoning-watermark verdict (`:11061-11064`), and every
   frozen unit targeting this mid (`:11067-11071`). Nothing in it is
   collection-order dependent: `for_tail_message` yields a `Vec` in
   `core.frozen_units` order (`:10940`, `:10980-10996`) and `blocks` is a `Vec`
   in projection order (`:12520-12531`).
10. `transform.rs:1722-1728` — `TagOverlayState`'s four maps are all `BTreeMap`,
    so every overlay iteration is key-ordered.
11. `transform.rs:9244` and `:9275` — the hygiene and nudge tag lists are sorted
    explicitly by `tag_number` after being built.
12. `tail_hygiene.rs:364` — `for (call_id, rows) in orphan_rows` iterates a
    `HashMap`, and the loop body reads state it also writes
    (`!by_arc.contains_key` at `:373`, `by_arc.insert` at `:394`). Order
    independence holds only because candidate arc sets are disjoint per call id;
    see record 9.
13. `tail_hygiene.rs:1` — the header calls this the "rendered-tail hygiene
    metric", but `measure_tail_hygiene` (`:458-603`) measures `projection`
    blocks. It is render-aware for `red:` units (`:474`, `:508`), `cav:` units
    (`:526`, `:422-429`), Channel-1 reminder spans (`:527`, `:554`) and drop
    sentinels (`:528`, `:555`). There is no `strip:` prefix anywhere in the file.
14. `transform.rs:9890-9896` — a surface strip replaces content with `""` or
    `"[dropped]"`. Neither is visible to the hygiene metric, so tokens the render
    removed are still counted in `t`.
15. `transform.rs:9114-9115` — `render_user_hint` truncates to
    `USER_HINT_TOTAL_CHAR_CAP` (800, `:114`) and `debug_assert!`s the result. The
    inputs are capped at 3 fragments (`:117`, applied `:9090`) of 80 UTF-16 units
    each (`:113`, applied `:9096`), so the wrapped maximum is 458 UTF-16 units.
    The 800 cap cannot bind. Record 10.
16. `transform.rs:9070-9082` — `utf16_prefix` measures in UTF-16 units but slices
    on whole scalars, so no truncation can emit a lone surrogate.
17. `transform.rs:9119-9128` — `truncate_hint_to_total_cap` rebuilds the
    `<ctx-search-hint>` envelope around the truncated body, so a truncated hint
    is still a balanced element. Same for `one_line_fragment` (`:9130-9140`),
    which appends `…` inside the list item.
18. `transform.rs:8443-8445` — when a whole line consists only of tag
    imitations, `rest` is empty and the trailing newline is not re-emitted, so
    two authored lines merge. This is a content change beyond removing the tags.
19. `prompt_surface.rs:33-37` — `GUIDANCE_LIGHT_PRIMARY`,
    `GUIDANCE_LIGHT_NO_REDUCE` and `TOOL_LIGHT_DESCRIPTIONS` are
    `Option` constants that are unconditionally `Some`. So
    `guidance_asset`'s `fallback` (`:141`) is always false and
    `tool_manifest_falls_back` (`:156-158`) always returns false, which makes
    `LIGHT_FALLBACK_NOTICE` (`:28`) and both of its consumers
    (`lib.rs:7600-7601`, `:7718`) dead.
20. `memory_render.rs:8-14` — `M0_EMPTY_BODY` and `M1_PLACEHOLDER` exist so the
    m0 and m1 blocks are never absent or empty, because an absent block would
    shift later bytes and bust the provider prefix cache. This is the fidelity
    contract the splice at `transform.rs:11709-11755` depends on: it pushes m0
    and m1 only if the frozen units exist, so an absent unit means an absent
    block, not an empty one.
21. `decay_render.rs:330-348` — the history budget guard demotes tiers
    oldest-first until the body fits, and tier 5 renders empty
    (`:319-322`), so under a binding budget whole compartments leave the
    rendered artifact. Part 3 owns the ladder and the termination bound; noted
    here only because it is the one place in the m0 body where a bound removes
    content.

## Candidate properties

### render-a-composition-order-is-fixed-and-each-unit-appears-once

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `historical_full_drop_replays_byte_identically_through_output_cache` (`transform.rs:27150`) and `tag_overlay_replays_stably_and_new_tail_gets_next_number` (`:23307`) assert byte equality of whole renders, which would catch a duplicated or reordered unit. Neither asserts the ordering rule directly, and neither runs in CI.
Guarantee: The served array is `m0?`, `m1?`, then the retained non-synthetic tail in request order, with each retained unit present exactly once and the synthetic todo pair placed at exactly one position.
Check: `always` — for every accepted pass, assert the emitted sequence's non-synthetic elements are a subsequence of `req.messages` in the same relative order, that no `mid` appears twice, and that the synthetic todo pair appears exactly zero or one time. `always` because a reorder or a duplicate is wrong on every pass, not only under an interleaving.
Fault/timing angle: None. The splice is single-threaded over borrowed inputs.
Required faults and enabling state: None. Any transform pass exercises it.
Confidence: high — [evidence](evidence/render-a-composition-order-is-fixed-and-each-unit-appears-once.md). Read the whole of `build_output_with_tags_inner` and confirmed `out.push` happens at exactly five sites (`:11733`, `:11754`, `:11830`, `:12089`, `:12117`), all inside straight-line control flow over `req.messages`.
Existing check: `transform.rs:27150`, `:23307`; both inline, neither runs in CI.
Impact: A duplicated or reordered message is a provider-visible prefix change, which busts the prompt cache at best and produces an invalid conversation at worst.
Open questions:
- Can the anchored and unanchored synthetic-todo branches both fire in one pass? The anchored branch requires `anchor_mid.is_some()` and the unanchored branch requires `anchor_mid.is_none()` on the same `meta.synthetic_todo`, so no. Recorded as resolved in the evidence file.

### render-a-emptied-tail-message-drops-without-a-report

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — nothing asserts the drop is observable.
Guarantee: When the render empties a retained tail message and therefore omits it, the omission is observable to the caller.
Check: `always` — for every accepted pass, assert that the count of retained tail mids equals the count of emitted tail messages, or else that the response carries a field naming each omitted mid. `always` because an unreported omission is a fidelity failure whenever it happens.
Fault/timing angle: None. It is a per-message decision inside one pass.
Required faults and enabling state: A retained tail message whose blocks are all removed or emptied. The reachable producers are `apply_surface_strips` collapsing to an empty sentinel when `request_accepts_empty_content(req)` makes the sentinel the empty string (`:9890-9896`, `:10388`, `:10439`), `remove_frozen_historical_reasoning` (`:12035`), and the full-drop filter (`:12013-12023`).
Confidence: high — [evidence](evidence/render-a-emptied-tail-message-drops-without-a-report.md). Verified the `present` predicate at `:12037-12039` and the `continue` at `:12085-12087`, and verified `BuiltOutput` (`:11001-11006`) has no field for an omitted message.
Existing check: none.
Impact: A message the module intended to keep leaves the served context silently. If it was an authored user message, the agent loses a directive with no signal that it happened.
Open questions:
- Is the omission intended for every producer, or only for the strip path? The `present` predicate accepts a message absent from `blocks_by_mid`, which suggests the author's target was messages with no projected blocks, not messages emptied by strips. Needs the author. (needs human input)

### render-a-overlay-targets-stale-indices-after-full-drop-filter

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `duplicate_tool_full_drop_replays_byte_identically_through_output_cache` (`transform.rs:27216`) and `non_reasoning_adjacency_keeps_full_drop_mode` (`:27131`) exercise the full-drop path, but neither constructs a message with two overlay-eligible blocks after a dropped index.
Guarantee: Every overlay string is applied to the block whose id it was computed for.
Check: `always` — after `apply_tag_overlay_to_message` returns, assert that for every `(block_id, overlay_string)` the overlay applied, the receiving block's projected id equals `block_id`. `always` because an overlay on the wrong block misattributes content every time it happens.
Fault/timing angle: None. The hazard is a within-message index shift, not a race.
Required faults and enabling state: One message must contain a block that the full-drop filter removes (`full_drop_tool_ids` returns its tool id, `:10839-10891`, which needs a frozen `red:` unit of kind `drop`) followed by at least two overlay-eligible blocks. Whether that shape occurs is the open question. A whole-message strip collapsing `content` to one block (`:10388`) creates the same shift with a smaller footprint. The `block_index >= content.len()` guards at `:8227` and `:10400` convert the out-of-range half of the hazard into a silently skipped overlay, which is a separate failure mode with the same cause.
Confidence: medium — [evidence](evidence/render-a-overlay-targets-stale-indices-after-full-drop-filter.md). The index shift is verified from source: `filter_map` rebuilds `content` at `:12014-12021` and the overlay at `:12024-12031` passes the same unmodified `blocks` slice. What is not established is whether a real harness emits a message with a full-drop tool block followed by two taggable blocks.
Existing check: `transform.rs:27216`, `:27131`; neither runs in CI.
Impact: A `§N§` prefix on the wrong block breaks the tag-to-block mapping that `ctx_reduce` resolves against, so the agent's reduce request hits content it did not choose. The bytes are already frozen into the provider prefix by the time it could be noticed.
Open questions:
- Can one CK message carry a full-drop tool block followed by two or more taggable blocks? Depends on the harness codecs, which are 4f scope. Unresolved, needs 4f.

### render-a-duplicate-tool-use-repair-is-release-only

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `duplicate_tool_use_belt_panics_in_test_builds` (`transform.rs:21504`) covers the debug arm. `duplicate_tool_use_belt_drops_later_owner_and_result_in_release` (`:21514`) covers the release arm but carries `#[cfg(not(debug_assertions))]` (`:21512`), so it does not compile under a default `cargo test`, and no `mc-module` lib test runs in CI at all.
Guarantee: The served array contains no duplicate `tool_use` id, and the repair that guarantees it removes only the later owner and its otherwise-orphaned result.
Check: `always` — on every accepted pass, assert `duplicate_tool_use_locations(&messages).is_empty()` for the returned array. `always` because a duplicate id is a deterministic provider rejection every time. Pair it with a coverage check asserting the independent preconditions: a pass observed in which `duplicate_tool_use_locations` returned non-empty *before* `:12147`, and the build profile under test.
Fault/timing angle: None. The belt runs once, at the end of the splice.
Required faults and enabling state: Two `ToolCall` blocks with the same id reaching `:12147`. The doc comment at `:11227-11230` states the normal ingress and render paths must keep them unique, so this is a last-resort belt whose trigger is another path's defect.
Confidence: high — [evidence](evidence/render-a-duplicate-tool-use-repair-is-release-only.md). Verified the `#[cfg]` split at `:11251` and `:11303-11304`, verified the release arm drops an emptied message at `:11297-11299`, and verified the release test's own `#[cfg]` gate at `:21512`.
Existing check: `transform.rs:21504` (debug only), `:21514` (release only, does not compile in a debug test run).
Impact: The two profiles disagree about what a duplicate does: debug aborts the pass, release silently removes content and continues. Whichever profile ships is the only one whose behaviour was ever executed, and today neither arm's test runs in CI.
Open questions:
- Which profile does the shipped `ck-mc-host` use? `ci.yml:164-165` builds it without `--release`, so the CI artifact is a debug build with the panicking arm. Whether the distributed artifact matches is unresolved, needs the release pipeline.

### render-a-orphan-tool-arc-has-no-production-detection

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `assert_no_orphaned_tool_arcs` is asserted on real render output at `transform.rs:14336` and `:27418`, `:27427`, and negatively at `:14314`, `:14321`. All of it is inline test code that CI does not run.
Guarantee: The served array never contains a `tool_result` without a preceding `tool_use` of the same id, and never a `tool_use` whose result is not in the same or the next message.
Check: `always(!orphan)` — assert the pairing condition over the emitted array. `always(!X)` and not `unreachable`, because the forbidden thing is a state of the output array and there is no production code point that must not be entered; per METHOD.md the `unreachable` form is only for a code location.
Fault/timing angle: None.
Required faults and enabling state: A reduction, strip, full drop, or duplicate repair that removes one half of a tool arc. `split_coverage_tool_arcs` (`:10545-10617`) and `projection_reasoning_ineligible_arc_ids` exist specifically to keep arcs intact, and the release duplicate repair at `:11258-11277` explicitly removes an adjacent result when the owner empties, which is the same concern handled in one place.
Confidence: high — [evidence](evidence/render-a-orphan-tool-arc-has-no-production-detection.md). Verified `#[cfg(test)]` at `:11171` on the function and at `:5486` on the only call site outside the test module, and grepped every reference.
Existing check: `transform.rs:5486-5487` (test builds only), plus the test-module assertions listed above.
Impact: An orphaned arc is a deterministic provider 400 for the whole session until the array changes. In production nothing detects it, so the first signal is the provider error.
Open questions:
- Is the guard test-only deliberately, on the argument that its cost is O(messages × blocks) per pass? The sibling `enforce_unique_tool_use_ids` runs in production with a comparable cost, so the asymmetry looks unintentional. Needs the author. (needs human input)

### render-a-mint-batch-block-ids-are-unique-per-pass

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tag_baseline_cache_matches_cold_passes_across_drop_reset_and_remint` (`transform.rs:23364`) and `tag_baseline_cache_keeps_interleaved_sessions_isolated` (`:23466`) cover the baseline paths. Nothing asserts uniqueness of `block_id` within one mint batch.
Guarantee: A single tag-mint batch never contains the same `block_id` twice, and never contains a `block_id` that already has a durable `mc_tags` row.
Check: `always` — before the commit, assert `tag_mint_work.inputs` has distinct `block_id`s and that none of them is present in the store's `mc_tags` for this session. `always` because the store's skip branch desynchronises every later number in the batch whenever it fires.
Fault/timing angle: The in-memory numbering at `:8029-8035` and the store's per-row numbering are separated by the whole pass; the `row_version` CAS closes the concurrent-writer window. The residual window is logical: whether the batch's `existing_tag_ids` snapshot (`:8595-8598`) matched the store.
Required faults and enabling state: `tag_mint_enabled`, plus either a duplicate projection block id or a stale baseline. The first is impossible: `apply_once` returns `TransformError::DuplicateBlockId` at `:3354-3356`, before the mint at `:3806`. The second requires `load_cached_tags` to serve rows whose block-id set differs from the store's; both cached paths are additionally fenced on the trigger-backed `generation` (`:7529`, `:7540`), which a delete-and-reinsert advances even when count and max are unchanged.
Confidence: medium — [evidence](evidence/render-a-mint-batch-block-ids-are-unique-per-pass.md). Verified the projection guard, the mint loop's non-updating filter, and both generation fences. Not verified: that the SQLite triggers advance `generation` for *every* `mc_tags` mutation, which is `mc-store` and outside 4e.
Existing check: `transform.rs:23364`, `:23466`; neither runs in CI.
Impact: This is the enabling condition for the sibling record [`speculative-tag-numbering-has-two-authorities`](../../part-4b-transform/catalog.md#speculative-tag-numbering-has-two-authorities). If it holds, that record's divergence is unreachable through the public path; if the generation trigger has a gap, it is reachable.
Open questions:
- Do the `mc_tags` SQLite triggers advance `generation` on delete and on update, not only on insert? Unresolved, needs an `mc-store` read.

### render-a-channel2-derived-tag-numbers-name-no-durable-row

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `nudge_formula_tests` (`transform.rs:9628-9783`) covers the band arithmetic, not the hint's tag numbers.
Guarantee: Every `§N§` a nudge or directive renders names a tag number the agent can use, meaning one that a `mc_tags` row holds for the block the text is pointing at.
Check: `always` — whenever `format_reclaimable_hint` produces a non-empty string, assert each rendered `N` matches a durable `mc_tags.tag_number` for this session. `always` because a directive naming a non-existent handle is wrong every time it is rendered.
Fault/timing angle: None.
Required faults and enabling state: `SerializerProfile::OpencodeAiSdk` (so `channel2_directives` takes the host-directive arm at `:9347-9365`), Channel-2 pressure due, and `active_tags_for_nudge` returning empty so `active_tags_for_channel2` falls through to the derived numbering at `:9293-9312`. The comment at `:9279-9281` says that fallthrough is deliberate for profiles that "historically did not mint overlay tags", which is exactly the state in which no durable row exists.
Confidence: medium — [evidence](evidence/render-a-channel2-derived-tag-numbers-name-no-durable-row.md). Verified the derived numbering, verified it reaches `oldest_channel2_hint` (`:9396`) and `format_reclaimable_hint` (`:9872`), and verified the rendered form is `§N§ tool`. Not verified: what `ctx_reduce` does with a tag number that has no row, which is 4d's surface.
Existing check: none.
Impact: The agent is told to reduce `§3§` when no `§3§` exists, so a compliant `ctx_reduce` either no-ops or resolves to a different block. The second is a misattributed reduction.
Open questions:
- Does `ctx_reduce` reject an unresolvable tag number or silently resolve it? `parse_tag_range_string` is `lib.rs:15165-15210`, which is 4d scope. Unresolved, needs 4d.

### render-a-hygiene-metric-ignores-surface-strips

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `recurring_raw_call_id_orphan_is_conservative_t_only` (`tail_hygiene.rs:1211`) and the surrounding suite cover exclusion for `red:`, caveman and sentinel content. Nothing covers a `strip:` unit.
Guarantee: The tail-hygiene metric's total `t` counts only tokens the render actually serves.
Check: `always` — for a pass with at least one `strip:` frozen unit whose target is in the measured tail, assert `measure_tail_hygiene`'s `t` excludes the stripped block's original tokens. `always` because the number is wrong on every pass where a strip is active.
Fault/timing angle: None; both are computed in the same pass from the same `core`.
Required faults and enabling state: Any frozen unit keyed `strip:placeholder:`, `strip:system_injected:`, `strip:system_injected_block:`, `strip:stale_reduce:` or `strip:processed_image:` whose target block is inside the measured tail. `new_frozen_strip_units` (`transform.rs:10181-10339`) is the producer.
Confidence: high — [evidence](evidence/render-a-hygiene-metric-ignores-surface-strips.md). Verified `measure_tail_hygiene`'s exclusion set at `:499-512` and its per-kind arms at `:522-587`, and verified by grep that `tail_hygiene.rs` contains no `strip:` literal anywhere.
Existing check: `tail_hygiene.rs:1211` and its neighbours; none run in CI.
Impact: `t` and possibly `u` overstate the served tail, so `hygiene_band` (`:704`) and both nudge gates fire on a tail that is smaller than measured. The agent is told about tokens that are not there.
Open questions:
- Is the divergence bounded? A whole-message strip replaces every block, so the overstatement is the whole message. Whether any strip class can dominate the tail is unresolved, needs a measurement on a real session.

### render-a-render-is-deterministic-over-fixed-inputs

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the byte-equality replay tests (`transform.rs:27150`, `:27216`, `:23307`, `:28622`) all assert determinism across passes within one process. Nothing asserts it across processes, which is where a `HashMap` seed would differ.
Guarantee: Identical `(core, meta, projection, req, overlay, tag_numbers)` renders byte-identical output, in any process.
Check: `always` — render the same fixed inputs in two independently seeded processes and assert byte equality of the served array and of every overlay-bearing block. `always` because a seed-dependent render busts the prefix cache on the very next pass.
Fault/timing angle: None for the splice. The one audited order-sensitive site is `tail_hygiene.rs:364`, whose loop body reads `by_arc` at `:373` and writes it at `:394`.
Required faults and enabling state: To make the `tail_hygiene.rs:364` site actually order-dependent you would need two distinct orphan raw call ids whose single unclaimed candidate arc is the same arc. `ck_wire.rs:441-445` assigns a singleton call's arc id as the call block's own block id and a repeated call's arc id as `mid#call:{id}`, so all blocks in one arc carry one `tool_call_id` and the candidate sets are disjoint. The order therefore does not matter today, but nothing local enforces that.
Confidence: high — [evidence](evidence/render-a-render-is-deterministic-over-fixed-inputs.md). Audited every collection in the splice: `TagOverlayState` is four `BTreeMap`s (`:1722-1728`), `projection_blocks_by_mid_for_output` returns a `BTreeMap` of projection-ordered `Vec`s (`:12520-12531`), `reduced` is a `BTreeMap` (`:11924`), the nudge lists are explicitly sorted (`:9244`, `:9275`), and every `HashSet`/`HashMap` in the splice is used only for `contains`, `get`, or an order-independent `any`.
Existing check: `transform.rs:27150`, `:27216`, `:23307`, `:28622`; none run in CI.
Impact: The whole cache discipline in the module header (`transform.rs:1-16`) rests on a replay producing identical bytes. A seed-dependent render would bust the provider prefix cache on every process restart.
Open questions:
- None. The one `HashMap` iteration is order-independent for the reason recorded above; a regression test pinning the disjointness assumption would be cheap.

### render-a-user-hint-total-cap-cannot-bind

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — `user_hint_query_keeps_terms_beyond_the_old_character_cap` (`transform.rs:23128`) covers the query path, not the render cap.
Guarantee: `truncate_hint_to_total_cap` is never entered from `render_user_hint`, because the composed hint cannot exceed `USER_HINT_TOTAL_CHAR_CAP`.
Check: `unreachable` — instrument the `utf16_len(wrapped) > limit` branch of `truncate_hint_to_total_cap` (`:9120-9127`) and assert it is never taken. `unreachable` and not `always`, because the subject is a specific code location that the arithmetic says cannot execute.
Fault/timing angle: None.
Required faults and enabling state: `auto_search_active`, which is `!req.is_subagent && req.auto_search_enabled` (`:3519`) and defaults to `true` on the wire (`default_auto_search_enabled`, `:865-867`) and in the shipped producer (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2010`).
Confidence: high — [evidence](evidence/render-a-user-hint-total-cap-cannot-bind.md). Computed the maximum: 18 (`<ctx-search-hint>\n`) + 44 (three-fragment header) + 1 + 3 × 82 + 2 + 1 + 127 (footer) + 19 = 458 UTF-16 units against a cap of 800. `USER_HINT_RESULT_LIMIT` is 3 (`:117`, applied `:9090`) and `one_line_fragment` caps each fragment at 80 UTF-16 units (`:113`, applied `:9096`, enforced `:9132-9139`).
Existing check: none. The only guard is the `debug_assert!` at `:9115`, which is trivially satisfied.
Impact: A dead truncation path plus a `debug_assert` that can never fail. It is also a latent trap: raising `USER_HINT_RESULT_LIMIT` or the fragment cap silently activates a path that has never executed.
Open questions:
- Is `truncate_hint_to_total_cap` reachable from any other caller? Grep found only `:9114`. Recorded as resolved in the evidence file.

### render-a-hint-fragment-cap-binds-in-a-served-render

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — no test observes a truncated fragment inside a served array.
Guarantee: A campaign reaches a render in which the user-hint fragment cap actually binds, and the served bytes are still a balanced `<ctx-search-hint>` element with no broken scalar.
Check: `sometimes` — at least once per campaign, observe a served array containing a `<ctx-search-hint>` block whose body has a line ending in `…`, and assert on that same render that the element is balanced, that every fragment line is at most `USER_HINT_FRAGMENT_CHAR_CAP + 2` UTF-16 units, and that the whole message is valid UTF-8 with no lone surrogate. `sometimes` and not `reachable`, because executing `one_line_fragment`'s truncation branch in a unit test proves nothing about a render that actually carried a truncated hint into the provider array.
Fault/timing angle: None.
Required faults and enabling state: `auto_search_active` (default true, see the record above), an authored user tail that is the last message (`:8776-8780`), no existing hint row for its block, and at least one memory search result whose caveman-compressed snippet exceeds 80 UTF-16 units. The last is the ordinary case for a real memory hit, since `caveman::compress` at `Ultra` shortens but does not cap.
Confidence: high — [evidence](evidence/render-a-hint-fragment-cap-binds-in-a-served-render.md). Verified the cap application at `:9096`, the truncation at `:9135-9139`, the whole-scalar slicing at `:9070-9082`, and the envelope construction at `:9111`.
Existing check: none.
Impact: This is the only budget in 4e that binds in ordinary operation. Without a `sometimes` record a campaign can run for hours, execute the truncation lines from a unit test, and never once serve a truncated hint, so the envelope and scalar guarantees stay unproven on real data.
Open questions:
- None.

### render-a-light-surface-fallback-notice-never-served

Type: reachability
Reachability: explicit-config-only
Status: active
Exercised: yes — `light_slots_serve_authored_guidance_and_descriptions` (`prompt_surface.rs:329`) asserts `!light.fallback` and `!tool_manifest_falls_back(..)` for both presets at `:333-342`.
Guarantee: No served prompt surface or guidance response carries `LIGHT_FALLBACK_NOTICE`, and no `light` selection silently serves `full` bytes.
Check: `unreachable` — instrument `guidance_asset`'s `fallback: light.is_none()` arm (`:141`) and `tool_manifest_falls_back`'s `true` result (`:156-158`) and assert neither is ever produced. `unreachable` because both are specific code points that the `Option` constants at `:33-37` make unproducible; if either fires, the light assets were dropped from the build.
Fault/timing angle: None.
Required faults and enabling state: `PromptSurfacePreset::Light`, which is not the serde default (`Full` is, `:74-76`), so it requires explicit configuration. That is the basis for the `explicit-config-only` label. The consumers are `lib.rs:7594-7601` (`handle_prompt_surface_manifest_value`) and `lib.rs:7688-7720` (`handle_guidance_value`).
Confidence: high — [evidence](evidence/render-a-light-surface-fallback-notice-never-served.md). Verified `GUIDANCE_LIGHT_PRIMARY`, `GUIDANCE_LIGHT_NO_REDUCE` and `TOOL_LIGHT_DESCRIPTIONS` are unconditionally `Some` at `:33-37`, and that `docs/specs/prompt-surface/light-mapping.md` maps every `compressed`-applicable checklist rule to a named line in the shipped light asset.
Existing check: `prompt_surface.rs:329-342`; does not run in CI.
Impact: Low on its own. It matters as a documentation artifact: the notice text says light assets "are not available yet", which is stale, and a reader who trusts it will conclude the light preset is inert when the mapping document and the assets show it is not.
Open questions:
- None.

## Contract-vs-code leads

1. **The scope map calls `assert_no_orphaned_tool_arcs` a production guard; it is
   `#[cfg(test)]`.**
   Contract side:
   [`../../part-4-module/_lenses/scope-map-and-risk-ranking.md:441-443`](../../part-4-module/_lenses/scope-map-and-risk-ranking.md)
   — "Two production guards worth naming now because they are explicit fail-loud
   checks on the output path: `transform.rs:11172-11225 assert_no_orphaned_tool_arcs`
   and `transform.rs:11231-11305 enforce_unique_tool_use_ids`."
   Code side: `transform.rs:11171` is `#[cfg(test)]`, and the only non-test-module
   call site is guarded by `#[cfg(test)]` at `:5486`. The second function named
   is genuinely production, so the sentence is half right. Do not resolve in
   favour of the map: the code wins here and record 5 carries the consequence.

2. **`tail_hygiene.rs` calls itself the "rendered-tail" metric but measures the
   projection.**
   Contract side: `tail_hygiene.rs:1` — "Shared rendered-tail hygiene metric for
   the module's Channel-1 and Channel-2 nudges." The scope map repeats it
   (`scope-map-and-risk-ranking.md:94-96`, "It measures the rendered tail").
   Code side: `measure_tail_hygiene(projection, core, ..)` (`:458-465`) walks
   `projection.blocks`, and the file contains no reference to any `strip:` frozen
   unit. It is render-aware for reductions and caveman only. Record 8.

3. **`LIGHT_FALLBACK_NOTICE` asserts a state the build makes impossible.**
   Contract side: `prompt_surface.rs:28` — "built-in light assets are not
   available yet ... until light assets ship."
   Code side: `:33-37` compile the light assets in unconditionally, and
   `docs/specs/prompt-surface/light-mapping.md` maps the shipped light lines rule
   by rule. The notice and both of its consumers are dead. Record 12.

4. **The serialized-output cache records what was built, not what was served.**
   Contract side: the module header's render-once discipline
   (`transform.rs:1-16`), and the in-pass assertion "serialized output cache
   drift" at `:5478`, both read as "the cache holds the served bytes".
   Code side: every `record_output_item` call (`:11725`, `:11746`, `:11821`,
   `:12077`, `:12108`) precedes `enforce_unique_tool_use_ids` at `:12147`, which
   can remove blocks and whole messages from `out` without touching
   `cache_entries`. This is only a live defect if a later pass can hit the cached
   entry while the duplicate is gone; see the open questions.

5. **`decay_render.rs` and `memory_render.rs` each define
   `DEFAULT_HISTORY_BUDGET_TOKENS` with different types.**
   `decay_render.rs:23` declares `pub const DEFAULT_HISTORY_BUDGET_TOKENS: u32 =
   60_000;` and `memory_render.rs:16` declares `pub const
   DEFAULT_HISTORY_BUDGET_TOKENS: f64 = 60_000.0;`. Same name, same value, two
   modules, and the renderer's own entry points take `f64`
   (`decay_render.rs:70`). Not a behaviour difference today. Flagged because a
   future change to one is invisible to the other, and because the `u32` copy has
   no caller inside 4e's scope.

## Open questions

- Can one CK message carry a full-drop tool block followed by two or more
  overlay-eligible blocks? This decides whether record 3 is a live
  misattribution or only a skipped overlay. It depends on the harness codecs,
  which are 4f scope. Unresolved, needs 4f.
- Does `ctx_reduce` reject a tag number with no `mc_tags` row, or resolve it to
  something? This decides the impact of record 7. `parse_tag_range_string`
  (`lib.rs:15165-15210`) and `handle_ctx_reduce_facade` (`lib.rs:10482-10588`)
  are 4d scope. Unresolved, needs 4d.
- Do the `mc_tags` SQLite triggers advance the cache generation for deletes and
  updates as well as inserts? This is the last door for the sibling's
  two-authority divergence. Unresolved, needs an `mc-store` read.
- Which build profile does the distributed `ck-mc-host` use? `ci.yml:164-165`
  builds without `--release`, which selects the panicking duplicate-id arm. If
  the shipped artifact is a release build, the arm that ships is the one whose
  test does not compile under `cargo test`. Unresolved, needs the release
  pipeline.
- Is the silent omission of an emptied tail message intended for every producer
  or only for messages with no projected blocks? The `present` predicate's third
  disjunct suggests the latter. (needs human input)
- Is `assert_no_orphaned_tool_arcs` test-only on purpose? Its production sibling
  `enforce_unique_tool_use_ids` has a comparable cost and does run. (needs human
  input)
- METHOD.md's `Exercised` vocabulary does not fit this part cleanly. Every
  existing check in 4e is an inline test that CI never runs
  (`scope-map-and-risk-ranking.md:409-430`), and one of them
  (`transform.rs:21514`) does not even compile under a default `cargo test`. This
  lens used `partial` for "a test exists and would catch it" and named the CI gap
  in the same line. The scope map already queued this as needing a ruling
  (`scope-map-and-risk-ranking.md:681`); it is still open.
