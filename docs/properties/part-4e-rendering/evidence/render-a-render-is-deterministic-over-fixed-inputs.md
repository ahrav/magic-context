# render-a-render-is-deterministic-over-fixed-inputs

## Discovery trigger

The module header's cache discipline (`transform.rs:1-16`) requires that a replay
produce byte-identical output. Prior parts found this repository generally uses
ordered maps and explicit sorts, with one host-dependence exception, so this pass
audited every collection reachable from the splice to establish which pattern
holds in 4e.

## Evidence trail

All references read back at `HEAD` `e447c927`. Unqualified line numbers are
`crates/mc-module/src/transform.rs`.

### The splice itself

`build_output_with_tags_inner` (`:11678-12156`). Every collection it touches, and
how:

| Collection | Site | Ordered? | Iterated in an order-bearing way? |
| --- | --- | --- | --- |
| `out: Vec<ServedMessage>` | `:11695` | yes | it is the output |
| `cache_entries: HashMap` | `:11696` | no | never iterated here; returned and merged as a map |
| `frozen_units` index maps | `:10911-10948` | no | only `get`, plus `by_tail_mid`'s `Vec` values which are built in `core.frozen_units` order (`:10940`) |
| `reasoning_ineligible_arcs: HashSet` | `:11759-11763` | no | only `contains` (`:11934`, `:10871`) |
| `split_coverage_invocation_mids: HashSet` | `:11769-11776` | no | only `contains` (`:11792`, `:11855`) |
| `output_mids: HashSet` | `:11783-11795` | no | only `contains` (`:12526`) |
| `blocks_by_mid` | `:11796`, built by `:12520-12531` | yes, `BTreeMap` of projection-ordered `Vec`s | `get` and `contains_key` only |
| `full_drop_ids: HashSet` | `:11799`, built by `:10839-10891` | no | only `contains` (`:11089`, `:12008`) |
| `reduced: BTreeMap<usize, &FrozenUnit>` | `:11924-11943` | yes | read by `get` inside a `for block in blocks` loop (`:11947-11965`) |
| `drop_indexes: HashSet<usize>` | `:12004-12012` | no | only `contains`, inside an `enumerate` over `content` (`:12018-12020`) |
| `remove_positions: HashSet<(usize, usize)>` | `:11254-11257` | no | `contains` (`:11263`, `:11294`) and an order-independent `any` (`:11281-11284`) |

`for block in blocks` and `for msg in req.messages.iter()` are the only two loops
whose order affects output, and both iterate `Vec`s.

`duplicate_tool_use_locations` (`:11156-11169`) uses a `HashSet` only through
`insert`, and its output `Vec` order follows the message-then-block scan.

`message_output_identity` (`:11014-11096`) is the identity that gates cache reuse,
so an order-dependent hash would be as damaging as an order-dependent render. Its
inputs are: fixed-order scalar fields; `projection.identity_by_mid` entries, a
`Vec` per mid (`:11040-11045`); `frozen_units.for_tail_message`, a `Vec`
(`:11067-11071`); and `blocks`, a `Vec` (`:11075-11094`). `digest_field`
(`:11008-11011`) length-prefixes every field, so no concatenation ambiguity
either.

### The overlay inputs

`TagOverlayState` is four `BTreeMap`s (`:1722-1728`), built by `tag_overlay_state`
(`:8140-8169`) from row slices. So every overlay iteration is key-ordered.

`tag_numbers: &BTreeMap<String, u64>` (`:11621`), produced by
`tag_number_by_message` and refreshed at `:3829`.

`newest_active_tag_block_ids` (`:8082-8125`) collects candidate rows into a `Vec`
and sorts with an explicit total tie-break, descending on tag number then on block
id (`:8114-8119`), before `take(protected_tags)`. So the protected set does not
depend on row order.

`tag_mint_id_set_key` (`:7736-7745`) sorts before hashing, so the frontier memo's
`frozen_key` and `tagged_key` are order-independent even though both are computed
from `HashSet`s (`:7747-7749`, `:7841-7845`).

The nudge lists are sorted explicitly: `tag_rows_for_hygiene` ends with
`rows.sort_by_key(|row| row.tag_number)` (`:9244`), and `active_tags_for_nudge`
ends with `out.sort_by_key(|tag| tag.tag_number)` (`:9275`). Both `sort_by_key`
calls are stable, and their inputs are built by iterating `projection.blocks` and
a `BTreeMap` (`:9255-9258`), so ties resolve deterministically.

### The one order-sensitive iteration

`tail_hygiene.rs:364`:

```
354:    let mut orphan_rows = HashMap::<&str, Vec<&McTagRow>>::new();
...
364:    for (call_id, rows) in orphan_rows {
365:        if rows.len() != 1 { continue; }
366:        let candidate_arcs = projection
...
373:            .filter(|arc_id| !by_arc.contains_key(*arc_id))
374:            .collect::<BTreeSet<_>>();
375:        if candidate_arcs.len() != 1 { continue; }
...
394:            by_arc.insert(arc_id.to_string(), rows[0].tag_number);
```

This iterates a `HashMap` and the body both reads (`:373`) and writes (`:394`)
`by_arc`, so iteration order would matter if two distinct `call_id`s could contend
for the same arc.

They cannot, given how arcs are assigned. `ck_wire.rs:441-445`:

```
441:                    let arc_id = if call_counts.get(id.as_str()).copied().unwrap_or(0) > 1 {
442:                        tool_arc_id(&msg.mid, id)
443:                    } else {
444:                        block_id.clone()
445:                    };
```

with `tool_arc_id(mid, call_id) = format!("{mid}#call:{call_id}")`
(`ck_wire.rs:643-645`). A repeated call id yields an arc id containing that call
id; a singleton yields the call block's own block id. The result block inherits
the same arc through `pending_calls` (`ck_wire.rs:446-453`, consumed by
`arc_for_block` at `ck_wire.rs:460-466`). Either way, every block in one arc
carries one `tool_call_id`, and `candidate_arcs` is filtered by
`block.tool_call_id.as_deref() == Some(call_id)` (`tail_hygiene.rs:371`). So the
candidate sets for distinct call ids are disjoint and the `!by_arc.contains_key`
filter cannot be perturbed by another iteration's insert.

`candidate_arcs` is itself a `BTreeSet` (`:374`) and the owner index is a `min`
(`:379-384`), so the within-iteration choices are ordered.

`bounds_by_message` (`:321`) is a `HashMap` read only by key
(`:298`, `:301`), and `projection_message_indexes` (`:282-289`) assigns indexes by
walking `projection.blocks` in order, so its values are deterministic even though
the container is a `HashMap`.

So the conclusion for 4e matches what prior parts found elsewhere: ordered maps
and explicit sorts throughout, plus one `HashMap` iteration whose order
independence is real but rests on an invariant established in another module and
not restated locally.

### The impurity that does exist

The splice is pure over its arguments except for `Instant::now()` timing
(`:11693`, `:11698`, `:11881`, `:11903`, `:11911`, `:12124`, `:12149`) and the
`eprintln!` in the duplicate belt (`:11241-11245`). Neither affects bytes. The
*arguments*, however, come from process-global mutable caches:
`tag_baseline_cache()` (`:7597-7600`) via `load_cached_tags`,
`tag_mint_frontier_cache()` (`:8014-8021`) via
`compute_active_overlay_decisions`, and the serialized-output cache snapshot. All
three are validated against the store or against a content key before use, which
is the subject of the separate baseline record.

## Failure scenario

A future change iterates one of the `HashSet`s directly — for example emitting
blocks in `drop_indexes` order, or building the overlay from a `HashMap` instead
of the current `BTreeMap`. Two processes rendering identical state then produce
different byte orders. Every restart of the daemon busts the provider prefix cache
on the first pass, and `assert_prefix_projection_equivalent` (`:2303-2359`
region) would not catch it because both renders are internally consistent.

## Timing windows and dependencies

None inside the splice. The cross-process dependency is the `RandomState` seed,
which differs per process, so the failure mode is invisible to any single-process
test. That is why the check below has to run two processes.

## What a test must construct

1. Freeze a full input set — `core`, `meta`, a projection, a request, a
   `TagOverlayState`, `tag_numbers` — into a fixture.
2. Render it in two separately spawned processes and compare the serialized array
   byte for byte, plus every overlay-bearing block's text.
3. Separately, pin the assumption the one `HashMap` iteration depends on: assert
   that for any projection, every arc id maps to exactly one distinct
   `tool_call_id`. That is the local statement of `ck_wire`'s invariant and it is
   cheap.
4. As a cheaper screen than two processes, run the render twice in one process with
   the caches cleared between runs and compare. That catches accidental
   order-dependence on anything other than the hash seed.

## Investigation log

### Q: Is `for_tail_message`'s two implementations equivalent?

- Sources examined: `transform.rs:10927-10941` (the `Indexed` build) and
  `:10980-10996` (the `Scan` arm).
- Findings: both derive a target mid from a `red:` or `cav:` prefix via
  `split_block_id`, falling back to a `strip:` key. The indexed arm takes the
  segment after the last colon (`rsplit_once(':')`, `:10936-10937`); the scan arm
  tests `key.ends_with(&format!(":{mid}"))` (`:10992`). For keys of the form
  `strip:{kind}:{mid}` with no colon inside `mid`, these agree. Both preserve
  `core.frozen_units` order in their results.
- Missing evidence: whether a mid can contain a colon. `block_id` is
  `{mid}#{index}` (`ck_wire.rs`), and `split_block_id` splits on `#`, so a
  colon-bearing mid is not obviously excluded.
- Conclusion: unresolved for the colon-bearing-mid edge, and immaterial for
  determinism because the `Scan` arm is only reachable from
  `build_output_with_tags_unindexed`, which is `#[cfg(test)]` (`:11644-11645`).

### Q: Does the serialized-output cache introduce order dependence?

- Sources examined: `:11098-11109` (`cached_output_item`), `:11140-11154`
  (`record_output_item`), `:327-502` (the cache itself).
- Findings: the cache is keyed by string and read by key. `cache_entries` is a
  `HashMap` that is returned as a map, never iterated for output. A hit substitutes
  a previously built `ServedMessage` at the same position in the loop, so position
  comes from `req.messages`, not from the cache.
- Missing evidence: none.
- Conclusion: resolved with answer — no order dependence from the cache.
