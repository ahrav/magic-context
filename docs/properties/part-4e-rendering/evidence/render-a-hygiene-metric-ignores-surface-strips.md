# render-a-hygiene-metric-ignores-surface-strips

## Discovery trigger

`tail_hygiene.rs`'s header calls it the "rendered-tail hygiene metric". Checking
which render effects it actually accounts for showed it knows about reductions and
caveman replacements but not about surface strips.

## Evidence trail

All references read back at `HEAD` `e447c927`.

### What the metric measures

`measure_tail_hygiene` (`crates/mc-module/src/tail_hygiene.rs:458-603`) takes
`projection: &FlatProjection` and walks `projection.blocks` (`:499`). Its input is
the decoded ingress projection, not the output of `build_output_with_tags_inner`.

Its exclusion set at `:501-512` excludes a block when it is synthetic, is
role `system`, is at or below the coverage ordinal, belongs to a reduced or
sentinel arc, or is itself a `red:` target:

```
501:        if block.synthetic
502:            || block.role == "system"
503:            || coverage_ordinal.is_some_and(|coverage| block.ordinal <= coverage)
504:            || block
505:                .arc_id
506:                .as_deref()
507:                .is_some_and(|arc| reduced_arcs.contains(arc) || sentinel_arcs.contains(arc))
508:            || red_targets.contains(block.id.as_str())
```

`red_targets` (`:415-420`) reads `core.frozen_units` for the `red:` prefix.
`reduced_arcs` (`:475-480`) lifts that to whole arcs. `sentinel_arcs` (`:481-494`)
catches arcs whose tool output already reads as a drop sentinel.

So the metric is render-aware for three effects:

| Render effect | Accounted where |
| --- | --- |
| reduction (`red:` unit) | `:474`, `:478`, `:508` |
| caveman replacement (`cav:` unit) | `caveman_content` at `:422-429`, used at `:526` |
| Channel-1 reminder text | `strip_channel1_reminder_spans` at `:62-71`, used at `:527` and `:554` |
| an already-rendered drop sentinel | `is_drop_sentinel` at `:73-82`, used at `:528`, `:555`, `:570`, `:488` |

### What it does not account for

Surface strips. `grep -n "strip:" crates/mc-module/src/tail_hygiene.rs` returns
nothing. The file's only `strip` identifiers are
`strip_channel1_reminder_spans` (`:62`) and `str::strip_prefix` uses at `:75`,
`:418` — none of them looks at a `strip:`-keyed frozen unit.

The producer of those units is `new_frozen_strip_units`
(`crates/mc-module/src/transform.rs:10181-10339`) and `strip_unit`
(`:9880-9888`), which keys them `strip:{kind}:{mid}`. The consumer is
`apply_surface_strips` (`:10371-10458`), which for each kind does:

| Strip kind | Effect on served bytes | Site |
| --- | --- | --- |
| `placeholder`, `system_injected` | whole `content` replaced by one sentinel block | `:10383-10391` |
| `system_injected_block` | block text replaced by the unit's frozen payload | `:10404-10411` |
| reasoning age | reasoning text cleared | `:10413-10426` |
| `stale_reduce` on a reduce block | block replaced with the sentinel | `:10427-10442` |
| `processed_image` and large images | block replaced with the sentinel | `:10429-10436` |
| structural noise | block replaced with the sentinel | `:10437` |
| inline thinking in an aged assistant | text replaced | `:10443-10452` |

The sentinel is `provider_sentinel_text(req)` (`:9890-9896`): the empty string when
`request_accepts_empty_content(req)`, else `"[dropped]"`.

Neither form is visible to the metric. The metric measures the block's original
text, because `caveman_content(core, block).unwrap_or(text)` at `:526` falls back
to the projection text when no `cav:` unit exists, and `is_drop_sentinel` at `:528`
tests that original text, which is not a sentinel.

Note the near-miss: `is_drop_sentinel` (`:73-82`) tolerates a leading `§N§` before
`[dropped` or `[truncated`, so it would catch a block whose *ingress* text is
already a rendered sentinel from a previous turn. That is the replay case, and it
is why a reduction eventually stops being counted. A strip decided in this pass is
not.

### Where the number is used

`refresh_tail_hygiene_baseline` (`:636-690`) turns the measurement into a
baseline, `effective_tail_hygiene` (`:692-702`) sums baseline plus turn delta, and
`hygiene_band` (`:704` onward) plus `decide_channel1`
(`transform.rs:9562-9621`) and `channel2_pressure` (`:9380-9405`) gate on it. The
rendered reminder text quotes it: `approx_thousands(reclaimable_tokens)` at
`transform.rs:9846` and `:9550`.

## Failure scenario

A session accumulates several large `[SYSTEM DIRECTIVE: ...]` injections that
`new_frozen_strip_units` freezes as `strip:system_injected:` units, so the render
replaces each with an empty sentinel. The hygiene metric still counts their
original tokens in `t` and, for the tool-output ones, in `u`. `t` crosses
`CHANNEL1_MIN_TOKENS` (60,000, `tail_hygiene.rs:15`) and `u` crosses
`CHANNEL1_FLOOR_TOKENS` (25,000, `:16`) on a tail that the render has already
shrunk below both. A Channel-1 reminder fires telling the agent it has "~30k
tokens of unreduced tool output" that is not in the array it can see. The agent
either cannot find it or reduces something else.

## Timing windows and dependencies

No temporal window. Both the strip decision and the measurement happen in the same
pass from the same `core.frozen_units`, so the divergence is deterministic given
the frozen set. The one ordering fact that matters: strips are frozen and the
metric is measured from the same loaded `core`, so a strip frozen on an earlier
pass is present in `core.frozen_units` for every later measurement and diverges
every time.

## What a test must construct

1. A tail with one large assistant text block and one large tool result.
2. A `core.frozen_units` entry keyed `strip:stale_reduce:<mid>` for the tool
   result's message, so `apply_surface_strips` replaces it (`:10427-10442`).
3. Render, and separately call `measure_tail_hygiene` with the same projection and
   core.
4. Assert `measured.t` equals the estimated tokens of the *served* blocks. It does
   not; it includes the stripped block's original tokens. That is the finding.
5. Cheaper screen: assert `measured.t` is at most the sum of estimated tokens over
   the served array's non-excluded blocks. A bound rather than an equality avoids
   having to replicate the metric's per-kind arms in the test.

## Investigation log

### Q: Is the omission bounded, and could it dominate?

- Sources examined: `transform.rs:10383-10391` (the whole-message arm),
  `:10181-10339` (`new_frozen_strip_units`).
- Findings: a `placeholder` or `system_injected` strip replaces the entire message
  content, so the overstatement for that message is its whole token count. There is
  no cap on how many such units a session accumulates; `surviving_strip_units`
  (`:10460-10494`) deliberately keeps `strip:merged_reasoning:`,
  `strip:reasoning_age:` and both trailing-blank classes durable across requests.
- Missing evidence: a measurement on a real session, which this pass cannot run.
- Conclusion: unresolved, needs a measurement. The divergence is unbounded in
  principle.

### Q: Does the reasoning-age strip matter for the metric?

- Sources examined: `tail_hygiene.rs:583-585`, `transform.rs:10413-10426`.
- Findings: no. The metric already excludes `Reasoning`, `RedactedReasoning` and
  `Opaque` blocks unconditionally (`:583-585`), and the header comment at
  `transform.rs:9529-9530` states reasoning is excluded from both reclaimable and
  total mass. So clearing reasoning text cannot cause a divergence.
- Missing evidence: none.
- Conclusion: resolved with answer — reasoning strips are already consistent. The
  divergence is confined to the sentinel-replacing and payload-replacing kinds.

### Q: Is the header's wording defensible on another reading?

- Sources examined: `tail_hygiene.rs:1`, and the scope map's restatement at
  `docs/properties/part-4-module/_lenses/scope-map-and-risk-ranking.md:94-96`.
- Findings: "rendered-tail" could be read as "the tail as it will be rendered,
  approximately" rather than "measured from the rendered bytes". The three
  render-aware adjustments show the author intended some fidelity to the render.
  Nothing states which effects are in scope for that fidelity.
- Missing evidence: author intent.
- Conclusion: needs human input on whether the strip classes are an intentional
  omission. The disagreement between the header and the code is recorded either
  way.
