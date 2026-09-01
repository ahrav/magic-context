# dec-a-selection-decision-order-is-total-under-hashmap-iteration

## Discovery trigger

Task 4 asks to mine determinism properties, specifically no dependence on
unordered-collection iteration order and deterministic tie-breaking, and notes that
prior parts found this repository generally uses ordered maps and explicit sorts with
two exceptions, one of which was a map-mutating loop. `selection.rs` imports
`HashMap` and `HashSet` at `:29` and stakes its cache invariant on determinism at
`:6-7`, so it is the place to look for the third exception.

## Evidence trail

The claim under test. `selection.rs:4-7`:

```
//! This is the module-owned reduction producer. It is a PURE, DETERMINISTIC function over the flat, block-granular
//! typed tail (CK#1's `ContentKind` projected 1:1 per block into [`SelItem`]).
//! Determinism is the cache invariant: same (items, frozen_keys, ctx, cfg) → same
//! decisions → the slice-3 freeze/replay stays byte-identical.
```

and the last of the enumerated structural invariants, `:26-27`:

```
//! - **deterministic merge**: exactly one decision per target; `drop` beats
//!   `edit_marker`; stable output order.
```

**Two hash-map iterations reach the output.**

The first, `selection.rs:1305`:

```
for (arc_id, shape) in &arc_shapes {
```

`arc_shapes` is `HashMap<String, ArcShape>` (`:1162`). The loop body resolves the
shape and calls `expand_arc(arc, resolved, frozen_keys, &mut out)` at `:1333`, so the
push order into `out` is hash order.

The second, `dedupe_and_sort` (`:1389-1411`):

```
let mut best: HashMap<String, ReductionDecision> = HashMap::new();
for d in decisions {
    match best.get(&d.target_id) {
        Some(existing) if rank(&existing.kind) >= rank(&d.kind) => {}
        _ => {
            best.insert(d.target_id.clone(), d);
        }
    }
}
let mut out: Vec<ReductionDecision> = best.into_values().collect();
out.sort_by(|a, b| a.target_id.cmp(&b.target_id));
out
```

`best.into_values()` is hash order, and the sort at `:1408` fixes it. Because `best`
is keyed by `target_id`, the sort key is unique across the collection, so the
comparator is a total order and the result is independent of the input order. That is
what makes both hash iterations safe.

**The residual order-dependence is the equal-rank arm.** `:1400`:

```
Some(existing) if rank(&existing.kind) >= rank(&d.kind) => {}
```

`>=` rather than `>`, so when two decisions for the same target share a rank the
first one seen wins. `rank` (`:1390-1397`) maps `drop` to `3`, `edit_marker` to `2`,
`skeleton` to `1`, anything else to `0`. Two `drop` decisions for one target with
different payloads would therefore resolve by the arrival order in `decisions`, which
for the arc-derived half is hash order.

So the property has an unstated precondition: **no two distinct arcs emit a decision
for the same `target_id`**. Checking it:

- `group_arcs` (`:297-380`) builds `arcs: HashMap<String, ToolArc>` keyed by arc id
  and, per the comment at `:299-300`, sorts at the end (`:372-379`) rather than
  relying on map order. Each `SelItem` contributes to the arc named by its own
  `arc_id`, so arcs partition items provided item ids are unique.
- `expand_arc` (`:698-733`) emits decisions only for `arc.call_inputs` ids
  (`:701`) and `arc.result_ids` (`:719-723`), which are that arc's own blocks.

So the precondition holds if and only if `SelItem` ids are unique across the tail.
Ids are the `mid#block_index` projection that `ck_wire.rs` produces, which is the
sibling lens's material, so this record states the precondition rather than proving
it.

**The agent-drop half cannot collide non-deterministically.** `select_agent_drops`
(`:908-946`) is called at `:1338`, after the arc loop, and iterates
`ctx.agent_drop_ids`, which is a `Vec<String>` (`:187`), not a set. So its push order
is the caller's order. Its payload is always `DROPPED_PLACEHOLDER` (`:943`) and its
kind always `drop` (`:942`), so two agent drops naming one target produce identical
decisions and the equal-rank arm's choice is immaterial. And because the arc loop
runs first, an arc `drop` for the same target arrives before the agent `drop` and
wins deterministically.

`ctx.agent_drop_command_ids` is a `HashMap<String, String>` (`:190`) but is only ever
probed with `get`, at `:934-935`, never iterated.

**Every internal sort has a total tie-break.** I checked each one for a final unique
key:

| Site | Comparator ends with | Unique? |
| --- | --- | --- |
| `:372-379` `group_arcs` output sort | arc identity fields | yes |
| `:447-452` adjacency message sort | `left.mid.cmp(right.mid)` | yes, message ids |
| `:741-747` `newest_ctx_reduce_arc_ids` | arc id | yes |
| `:763-770` `select_supersession` | arc id | yes |
| `:853-861` `select_tool_dedup` | `left.arc_id.cmp(&right.arc_id)` | yes |
| `:1033-1037` tier recency reserve | `b.arc_id.cmp(&a.arc_id)` | yes |
| `:1071-1075` tier candidate walk | `a.arc_id.cmp(&b.arc_id)` | yes |
| `:1290-1295` skeleton window | `b.arc_id.cmp(&a.arc_id)` | yes |
| `:1408` final output sort | `target_id` | yes, unique after `best` |

`select_tool_dedup` (`:814-869`) is the most interesting of these because it
deliberately iterates a hash map into another hash map at `:843-846`:

```
let mut groups: HashMap<String, Vec<&ToolArc>> = HashMap::new();
for (_, (arc, fingerprint)) in by_owner_arc {
    groups.entry(fingerprint).or_default().push(arc);
}
```

The push order into each group is hash order, and then `:853-861` sorts each group
with a comparator ending in `arc_id`, so `group.pop()` at `:864` removes a determined
element. The function returns a `HashSet`, so its own output order is irrelevant.
That is a correct use of an unordered map, and it is the pattern the earlier parts
described.

**`canonical_json` closes the payload half.** `:597-619` sorts object keys at `:601`
before serializing, so `edit_marker_payload` (`:577-595`) and `skeleton_payload`
(`:648-694`) produce byte-identical strings regardless of whether `serde_json::Map`
is backed by a `BTreeMap` or an insertion-ordered map.

**The other hash iterations do not reach ordered output.** `:461-482` in
`reasoning_adjacency_collapse_arc_ids` iterates `removable_by_arc` into a `HashSet`;
`:532` in `reasoning_ineligible_arc_ids` does the same; `:1195`, `:1199`, `:1204`,
`:1214`, `:1250` iterate `HashSet`s or `HashMap`s only to perform keyed inserts into
`arc_shapes`, where each key appears once, so the resulting map is order-independent.

## Failure scenario

Nothing fails today, which is the finding worth recording, because the cost of it
failing is high and the guard is one `sort_by`.

If the final sort at `:1408` were removed, or if the precondition on unique item ids
were violated upstream, the selector would return a different decision order or a
different equal-rank winner across two runs on identical input. The consequence is
stated in the header at `:6-7`: the freeze and replay would stop being
byte-identical. Concretely, a bust pass freezes a decision set and renders bytes; a
later defer pass replays the frozen set. If the replay computed a different payload
for one target, the served byte sequence would differ from the cached one, busting the
provider prefix cache on a pass that intended to change nothing. That is the failure
the whole cache discipline exists to prevent, and it would appear as an unexplained
cache miss rather than an error.

The most plausible route to it is not a change to `selection.rs` but a duplicate
`SelItem` id arriving from the wire projection with two different `arc_id` values,
which would put two arcs in possession of one target.

## Timing windows and dependencies

None within a pass. The window that matters is across passes: freeze happens on a
bust pass and replay on a later defer pass, and the two must agree. `selection.rs:22-24`
states the payload-purity half of that ("every payload is a pure function of (id,
immutable block bytes) with ZERO pass-varying state"), and this record covers the
ordering half.

The one cross-pass input is `frozen_keys`, applied per block inside `expand_arc`
(`:698`, and the comment at `:1149-1152`). A frozen block is skipped rather than
re-decided, so a growing `frozen_keys` set shrinks the output without reordering it.

## What a test must construct

Determinism is awkward to test directly because a single process's hash seed is fixed
per `HashMap` instance but `RandomState` is randomly seeded per process. Three
approaches, cheapest first:

1. **Repeat within a process.** Call `select_reductions` twice on the same inputs and
   assert equality. This catches nothing today because both calls build fresh maps
   with the same seed, so it is a weak test.
2. **Repeat across processes.** Run the selector in a test that is executed many
   times, or seed a distinct `RandomState` per call by constructing the maps with
   `HashMap::with_hasher`. That requires production changes and is not worth it.
3. **Assert the invariant instead of the outcome.** Two assertions:
   - the output is sorted by `target_id` and has no duplicate `target_id`, which is
     directly checkable on any input and is what makes order immaterial;
   - the precondition, that the `target_id`s emitted by any two distinct arcs are
     disjoint, checkable by instrumenting `expand_arc`'s output per arc in a test
     helper.

The third is the one to build. It converts a hard-to-test determinism claim into two
cheap structural assertions, which is the same move the code itself makes.

The existing check to extend is `selection.rs:2836` `drop_wins_over_edit_marker`,
which covers the rank precedence but not the equal-rank arm or the sort.

## Investigation log

### Q: Can duplicate `SelItem` ids reach the selector?

- Sources examined: `selection.rs:297-380` (`group_arcs`); `:1130-1142` (`live_ids`
  construction, which collects into a `HashSet<String>` and would silently absorb a
  duplicate); `:1343-1346` (`arc_by_block_id`, a `HashMap<&str, &str>` built by
  `collect`, where a duplicate id would keep the last arc silently); the scope map's
  description of `ck_wire.rs` as owning the `mid#block_index` projection
  (`part-4-module/_lenses/scope-map-and-risk-ranking.md:323`).
- Findings: nothing in `selection.rs` rejects or detects a duplicate id.
  `arc_by_block_id` at `:1343` is the clearest tell: `collect` into a `HashMap` from
  an iterator with a repeated key keeps the last entry, so a duplicate would make the
  reasoning-ineligibility filter at `:1346-1351` consult one arc rather than both.
- Missing evidence: the uniqueness contract on the projection, which is the sibling
  codec lens's scope.
- Conclusion: unresolved, needs the codec lens. The record names the precondition
  explicitly so synthesis can pair it with whatever that lens finds.

### Q: Is `serde_json::Map` ordered in this build?

- Sources examined: `selection.rs:577-595` (`edit_marker_payload` iterates
  `obj.iter_mut()`); `:597-619` (`canonical_json` sorts keys at `:601`).
- Findings: it does not matter. `edit_marker_payload`'s iteration only rewrites values
  in place, never reorders keys, and the serialization step sorts. So the output bytes
  are independent of the map's backing order, whether or not the `preserve_order`
  feature is enabled anywhere in the dependency graph.
- Missing evidence: none.
- Conclusion: resolved with answer. The key sort at `:601` is load-bearing and worth
  keeping in mind if anyone replaces `canonical_json` with `serde_json::to_string`.
