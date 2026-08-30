# sel-pass-order-deterministic-under-fixed-inputs

## Discovery trigger

The lens brief names hash-map iteration order as a classic defect source for
pass selection, so I enumerated every hash-based collection in the 4b slice
(`transform.rs:1-7510`) rather than sampling. The module's own documentation
makes determinism the load-bearing claim: the part-4 scope map records
`selection.rs` as producing decisions where "determinism is stated as the cache
invariant, because the same inputs must yield byte-identical freeze and replay"
(`docs/properties/part-4-module/_lenses/scope-map-and-risk-ranking.md:82-85`).

## Evidence trail

Hash collections constructed in `transform.rs:1-7510`, with the use each one is
put to:

| Line | Collection | Use |
| --- | --- | --- |
| `:4136` | `HashMap<&str, usize>` tag tokens | lookup in `sel_item_from_flat` (`:7031`) |
| `:4175`, `:4187`, `:4191` | `HashSet<String>` protection sets | `contains` (`selection.rs:208-209`) |
| `:4218` | `HashMap` agent-drop command ids | `get` (`selection.rs:934-935`) |
| `:4223` | `HashSet` first-applied ids | `contains` (`selection.rs:918`, `:930`) |
| `:6171` | `HashSet<&str>` completed arcs | `contains` (`:6180`) |
| `:6321` | `HashMap` tags by block | `get` (`:6333`) |
| `:6389` | `HashMap` live ordinals | `get` (`:6396`) |
| `:6410`, `:6446` | `HashSet<&str>` live tail / tail mids | `contains` |
| `:6636` | `HashSet<String>` seen | dedup only; output pushed to a `Vec` in `req.messages` order (`:6637-6653`) |
| `:6684` | `HashSet<String>` frozen red targets | `contains`, and `.iter().any(..)` at `:5552-5554` |
| `:6756`, `:6765` | `HashSet<&str>` covered / reasoning | `contains` (`:6773-6775`) |
| `:6836`, `:6856`, `:6865` | `HashSet<&str>` tail / reasoning targets | `contains` |

Ordered artifacts, all order-stable by construction:

- `new_reduction_units` collects into `BTreeMap<String, FrozenUnit>` then
  `into_values` (`:6869-6882`). The doc comment at `:6845-6846` states
  "deduped by target, deterministic order".
- `effective_reductions` returns a `BTreeMap` (`:6891-6919`); the doc comment at
  `:6884-6886` says "Keyed by target_id → (kind, payload), deterministic".
- `surviving_caveman_units` uses `BTreeMap<String, FrozenUnit>` (`:6410-6435`).
- `new_caveman_units` sorts candidates explicitly:
  `candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)))`
  at `:6344`, keying on `(tag_number, block_id)`. Both components are total, so
  the tiebreak is complete.
- `first_applied_pending_command_ids` funnels through
  `.collect::<BTreeSet<_>>().into_iter().collect()` (`:6728-6731`).
- `selection.rs:1291-1296` sorts arcs by `(ordinal desc, arc_id desc)`.

The one queue order that enters selection from outside is `agent_drop_ids`
(`transform.rs:4207-4210`), built by mapping over `pending_agent_drops` in the
order the store returned. `mc-store/src/lib.rs:6226-6234` is
`ORDER BY p.queued_at ASC, p.id ASC`, and `p.id` is a row id, so the order is
total.

## Failure scenario

If any of the above became an iteration over a hash collection, two passes over
identical inputs would order the frozen `red:*` units differently. The frozen
payload for a given target would be unchanged, but the *set* minted in one pass
could differ if a cap were applied mid-iteration, and the replayed byte order
would differ. `validate_reduction_monotonicity` (`:6813-6826`) compares the
frozen payload for a target against the newly selected payload and returns
`TransformError::ReductionConflict` on a mismatch, so the symptom would be a
pass that fails outright rather than one that serves wrong bytes. That is the
better of the two failure modes, but it fails the whole pass.

## Timing windows and dependencies

None. This is a per-pass ordering property with no interleaving. The dependency
is on `RandomState`'s per-process seed, which differs across processes by
default, so a single-process test cannot refute the property even if it were
false.

## What a test must construct

A session whose live tail holds at least three eligible reduction targets, so a
non-trivial order exists. Then, in one process, run the selection region twice
over the same `(request, store row, ProducerContext)` and compare the decision
vector element by element, not as a set. To catch a cross-process divergence the
test needs either two processes or a controlled `RandomState`; the practical
substitute is a golden file recording the expected order, regenerated only
deliberately. `testdata/render-golden.json` is the existing fixture of that
shape.

## Investigation log

### Q: Does any hash-collection iteration order reach an output ordering in the 4b slice?

- Sources examined: `transform.rs:1-7510` for every `HashMap` and `HashSet`
  construction (18 sites, listed above); each use site traced;
  `selection.rs:180-210`, `:900-940`, `:1268-1300` for the sets passed across
  the boundary; `mc-store/src/lib.rs:6221-6250` for the queue order.
- Findings: No. Every hash collection is a membership or lookup structure. The
  only site that iterates a hash collection at all,
  `frozen_red_targets(&core).iter().any(..)` at `:5552-5554`, computes a boolean,
  which is order-independent. `covered_system_messages_for_coverage` (`:6630-6656`)
  looks like a counterexample but iterates `req.messages` and uses the set only
  for dedup.
- Missing evidence: `selection.rs` is 3,365 lines and belongs to sub-part 4f. I
  checked the three regions where the 4b-supplied sets are consumed, not the
  whole file. A hash iteration deeper inside the selector would not be visible
  from here.
- Conclusion: resolved with answer for the 4b slice. Unresolved for
  `selection.rs` as a whole; that belongs to the 4f lens, and this record's
  guarantee is stated over the whole selection so 4f should confirm it.
