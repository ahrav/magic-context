# sel-caveman-eligibility-ladder-deterministic-over-frozen-basis

## Discovery trigger

Caveman is the one sub-pass whose eligibility depends on data the same pass can
mutate: the tag rows. Its own doc comment makes the claim explicit, so it is a
claim under test: "`age_basis_tag` is captured durably by the caller with the same
commit as these units, so newly minted tags cannot change this cycle's eligible
population" (`transform.rs:6298-6300`).

## Evidence trail

The gate, `transform.rs:6312-6314`:

```
if !is_bust_pass || !req.caveman_enabled || req.is_subagent || age_basis_tag == 0 {
    return Vec::new();
}
```

Four conjuncts, all cheap and all evaluated before any store or compression work.
`is_bust_pass` is `!req.is_subagent && is_provider_prefix_mutation_pass`
(`:4439`), where the latter is
`matches!(plan, PassPlan::Hard | PassPlan::MigrateHard | PassPlan::Soft)`
(`:4435-4438`). So caveman runs only on a pass that is already rewriting the
provider prefix, which is the cache-safety argument
`CONFIGURATION.md:742` makes ("Runs only on execute-threshold heuristic passes
(same gate as automatic tool drops), so the single cache-busting pass materializes
both tool drops and caveman compression together").

The basis capture, `transform.rs:4491-4501`:

```
let caveman_age_basis_tag = if is_bust_pass && req.caveman_enabled {
    let basis = tag_rows
        .iter()
        .filter_map(|row| u64::try_from(row.tag_number).ok())
        .max()
        .unwrap_or(0);
    meta.caveman_age_basis_tag = basis;
    basis
} else {
    loaded.meta.caveman_age_basis_tag
};
```

`tag_rows` at this point is the hydrated set from `load_cached_tags` (`:3391`)
plus whatever this pass appended. The pass appends via `append_tag_mint_rows`
(`:8023`) and tracks the boundary with `hydrated_tag_count` (`:3392`), which is
used elsewhere to slice off the same-pass suffix:
`suppress_bootstrap_reduction_tag_overlay` selects `&tag_rows[..hydrated_tag_count]`
at `:4173-4174`. The comment there states the reason: "Same-pass bootstrap mints
have never been provider-visible and must not protect a block from reduction before
its first render."

The basis capture at `:4492-4497` iterates the full `tag_rows`, not the hydrated
prefix. Whether that matters depends on the order of `append_tag_mint_rows` relative
to line `:4491`, which is why it is the open question below.

The protected cutoff, `transform.rs:6318`:

```
let protected_cutoff = age_basis_tag.saturating_sub(req.protected_tags as u64);
```

and the per-candidate filter at `:6336`:

```
if tag_number > protected_cutoff || row.source_bytes.len() < req.caveman_min_chars {
    return None;
}
```

So the newest `protected_tags` tag positions are excluded, and blocks shorter than
`caveman_min_chars` bytes are excluded. Defaults: `protected_tags` 20
(`:893-895`), `caveman_min_chars` 500 (`:120`, factory at `:889-891`).

The candidate filter, `:6323-6342`, also excludes synthetic blocks, blocks at or
under coverage (`!is_tail`), blocks with a frozen `red:*` unit, roles other than
user and assistant, and non-`Text` kinds. `frozen_red` comes from
`frozen_red_targets(core)` (`:6320`) and is used only with `contains` (`:6327`).

The order, `:6344`:

```
candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
```

keyed on `(tag_number, block_id)`. Both are total orders, so no ties survive. The
position ladder then reads the sorted index:

```
fn caveman_target_depth(position: usize, total: usize) -> u8 {
    if total == 0 { return 0; }
    let fraction = position as f64 / total as f64;
    if fraction < 0.2 { 3 } else if fraction < 0.4 { 2 }
    else if fraction < 0.6 { 1 } else { 0 }
}
```

(`:6283-6297`). That matches the documented table at
`CONFIGURATION.md:731-738`.

`tags_by_block` (`:6321`) is a `HashMap<&str, &McTagRow>` used only for `get`
(`:6333`), so its iteration order never reaches the output.

Reachability, both sides. Identical to
`sel-caveman-deeper-tier-growth-panics-in-production`: config default `false`
(`config.rs:76`), request serde default `false` (`transform.rs:729-731`), OpenCode
plugin sends `=== true` only (`rust-mode-transform.ts:2015-2016`), Claude Code leg
copies the same config leaf (`lib.rs:186`), documented default `false`
(`CONFIGURATION.md:724`). No disagreement between the config default and either
shipped setup path.

## Failure scenario

Suppose the basis were taken after the same pass's mints. A bust pass that mints
five new tags would raise `age_basis_tag` by five, which raises `protected_cutoff`
by five (`:6318`), which admits five previously protected tag positions into the
candidate set on this very pass. Those blocks would be compressed before they had
ever been served at their new tag numbers, and the compression would freeze into
`cav:*` units. On the next pass the same computation over the persisted basis would
produce a different population, so the frozen set would not be reproducible from
the durable state. The failure is the same class as a hash-order divergence: frozen
bytes that a later pass cannot reconstruct.

The position ladder has a second, milder sensitivity that appears to be by design.
Adding one candidate changes `total`, which shifts every other candidate's fraction
and can move a block from depth 2 to depth 1. `:6355-6358` skips when
`target_depth <= existing_depth`, so a block that moves shallower keeps its
existing deeper unit rather than being re-rendered. That is deliberate monotonicity
(a frozen unit is never weakened), but it means the persisted depth is a high-water
mark rather than a function of the current population.

## Timing windows and dependencies

The window is a single bust pass that also mints tags. There is no concurrency
dependency; both the mint and the basis capture are inside one pass.

## What a test must construct

Drive a bust pass on a session with, say, 30 tagged blocks where the pass mints
three new tags. Assert two things. First, every returned unit's block has a tag
number at or below `max(hydrated tag numbers) - protected_tags`, computed from the
hydrated prefix only. Second, run the same pass twice from the same durable state
and assert the returned unit vector is equal element by element, including depths.

For the position-ladder sensitivity, add a candidate to a fixed population and
assert that no existing block's persisted depth decreases.

Fixtures exist: `transform.rs:25463-25490` builds tags and calls
`new_caveman_units` with `age_basis_tag` 1; `:25752-25760` covers the protected
window; `:25699-25715` covers the subagent exclusion; `:25728-25739` covers the
reasoning exclusion. None of them mints during the pass.

## Investigation log

### Q: Does `append_tag_mint_rows` run before or after line `:4491`?

- Sources examined: `transform.rs:4491-4501` (the basis capture);
  `:8023` (`append_tag_mint_rows`); `:3392` (`hydrated_tag_count`);
  `:4168-4183` (the protection-set slice that uses `hydrated_tag_count`); the
  `pending_overlays.tag_mint_start` / `tag_mint_count` slice at the commit
  (`:5591-5592`).
- Findings: The commit slices `&tag_rows[pending_overlays.tag_mint_start ..
  tag_mint_start + tag_mint_count]`, which proves mints are appended to the same
  `tag_rows` vector during the pass. The protection-set code at `:4173-4174`
  deliberately slices to `hydrated_tag_count`, which proves the author was aware
  the suffix exists and must sometimes be excluded. The basis capture at `:4492`
  does not slice.
- Missing evidence: I did not establish the line at which the mint append happens
  relative to `:4491`. `tag_overlay_state` and the overlay computation region
  (`:8140`, `:8574-8761`) belong to sub-part 4e and are called from the tag-overlay
  phase of `apply_once`, whose position relative to `:4491` I did not pin down.
  `timings.tag_overlay` and `timings.unit_mint` are separate fields
  (`format_pass_timing_line` at `:1348`), so the phases are distinct, but the
  format string's ordering is not evidence of execution order.
- Conclusion: unresolved, needs the execution order of the tag-mint append relative
  to `transform.rs:4491`. If the mint happens later, the basis is hydrated-only and
  the doc comment at `:6298-6300` holds. If earlier, the doc comment is false and
  this record's guarantee is violated. This is the single fact that decides the
  record, and it should be resolved before the record is promoted to the catalog.

### Q: Is a stale deeper unit after a shallower re-target intended?

- Sources examined: `:6355-6358`, `:6400-6435` (`surviving_caveman_units`),
  `:6385-6398` (`prune_covered_caveman_units`).
- Findings: `surviving_caveman_units` keeps any existing `cav:*` unit whose target
  is still live tail (`:6414-6425`) and merges the new units over it by key
  (`:6426-6433`), so a block whose target depth dropped keeps its deeper unit.
  `prune_covered_caveman_units` removes units only when the target left the tail
  (`:6390-6397`).
- Missing evidence: no comment states the high-water-mark intent, though the
  monotonicity is consistent with the frozen-unit immutability the module claims
  throughout.
- Conclusion: resolved with answer, by construction: a deeper unit is retained.
  Whether that is the intended semantics is a design question, and
  `CONFIGURATION.md:742` ("tier assignments are persisted in `tags.caveman_depth`
  so the next pass re-compresses only the tags that have shifted tiers") is
  consistent with a high-water mark.
