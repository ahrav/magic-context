# sel-caveman-deeper-tier-growth-panics-in-production

## Discovery trigger

Reading `new_caveman_units` for the eligibility ladder
(`sel-caveman-eligibility-ladder-deterministic-over-frozen-basis`) surfaced a bare
`assert!` in the middle of the selection loop. Task 2 asks what happens on budget
exhaustion; here the budget is "the deeper tier must not be larger", and the
answer to exhaustion is a panic.

## Evidence trail

The assertion, `transform.rs:6362-6369`:

```
let payload = if let Some(existing) = existing {
    // A deeper tier is allowed to replace bytes only when it does not grow the frozen
    // payload. Equal-size output still advances depth, matching TS's persisted depth
    // behavior for text with no additional removable material.
    assert!(
        compressed.len() <= existing.frozen_payload.len(),
        "caveman deeper tier grew frozen payload for {block_id}"
    );
```

It is `assert!`, not `debug_assert!`, so it is live in a release build regardless
of the `debug-assertions` profile setting. It sits inside the per-candidate loop
at `:6347-6380`, so it fires on the first violating block.

How the compared values are produced. `existing` is
`caveman_payload(core, &block_id)` (`:6353`), the currently frozen `cav:*` unit for
that block. `compressed` is `crate::caveman::compress(&source, level)` (`:6360`),
where `source` is the block's persisted original bytes,
`String::from_utf8(row.source_bytes.clone())` (`:6338-6339`), and `level` is
`caveman_level(target_depth)` (`:6359`), one of `Lite`, `Full`, `Ultra` for depths
1, 2, 3 (`:6274-6281`).

The guard that gets here. The loop only reaches the assertion when
`target_depth > existing_depth` (`:6355-6358` skips otherwise) and
`!compressed.is_empty()` (`:6361`). So the comparison is always "a strictly deeper
level's output against a strictly shallower level's frozen output over the same
original source".

That means the assertion is a claim about `caveman.rs`'s level ladder, not about
the transform: it asserts that `compress(s, Ultra).len() <= compress(s, Full).len()`
and `compress(s, Full).len() <= compress(s, Lite).len()` for every input `s` that
reaches this point. `caveman.rs` is 651 lines with 40 inline tests and belongs to
sub-part 4e, so I did not audit whether monotone size is enforced there.

The tie behaviour, `:6370-6376`:

```
    if compressed.len() < existing.frozen_payload.len() {
        compressed.as_str()
    } else {
        existing.frozen_payload.as_str()
    }
} else {
    compressed.as_str()
};
units.push(caveman_unit(&block_id, target_depth, payload));
```

On a length tie the shallower bytes are kept while the unit is minted at
`target_depth` (`:6378`). The in-code comment at `:6366-6368` names this as
matching the TypeScript persisted-depth behaviour.

Reachability, both sides checked as the brief requires:

- **Config default.** `CavemanConfig::default()` is
  `{ enabled: false, min_size: DEFAULT_CAVEMAN_MIN_SIZE }` (`config.rs:73-79`,
  `enabled: false` at `:76`), and `McModuleConfig::default()` takes it (`:126`).
- **Request default.** `TransformRequest.caveman_enabled` is
  `#[serde(default)] pub caveman_enabled: bool` (`transform.rs:729-731`), so an
  absent field is `false`.
- **Shipped OpenCode path.**
  `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2015-2016` sends
  `caveman_enabled: !sessionMeta.isSubagent && deps.cavemanTextCompression?.enabled === true`,
  so it is false unless the user's config says exactly `true`.
- **Shipped Claude Code path.** `apply_claude_code_config_controls`
  (`lib.rs:173-193`) copies `config.caveman.enabled` into the request at `:186`,
  which is the same user config leaf.
- **Documented default.** `CONFIGURATION.md:724` gives
  `caveman_text_compression.enabled` as `boolean`, default `false`.

All five agree, so the classification is `explicit-config-only` with no
default-versus-shipped disagreement. That is worth stating because the neighbouring
subsystem's config and setup path did disagree, per the lens brief.

## Failure scenario

A user sets `caveman_text_compression.enabled: true`. A session accumulates a long
user message whose text has some property that makes `Ultra` produce more bytes
than `Full`: a plausible candidate is a level that substitutes multi-character
replacements for shorter source tokens, which the CONFIGURATION.md description of
memory fragments hints at ("stop words stripped, common verbs replaced",
`CONFIGURATION.md:700`). The block is already frozen at depth 2 from an earlier
bust. On a later bust it shifts into the top 20 percent of the candidate list, so
`caveman_target_depth` returns 3 (`:6285-6297`), the depth guard passes, and
`compress(source, Ultra)` comes back longer than the frozen `Full` bytes.

`apply_once` panics inside `new_caveman_units` with
`caveman deeper tier grew frozen payload for <block_id>`. The pass does not commit.
Whether the panic reaches the host as a crash or is caught depends on the dispatch
path, which is sub-part 4c and 4d territory; `TransformDispatchTicket`'s `Drop`
(`lib.rs:497-508`) suggests the dispatch layer does expect to observe an abnormal
exit.

The session is then stuck: every subsequent bust pass re-enters the same candidate
list, re-derives the same target depth, and panics again, because nothing about the
frozen state changed. The only escapes are the candidate's position shifting (which
requires the tag window to move) or the user disabling the feature.

## Timing windows and dependencies

None in the concurrency sense. The dependency is entirely on `caveman.rs`'s level
ladder and on the candidate's position in the sorted list, which is a function of
the tag window.

## What a test must construct

Two layers. At the `caveman.rs` layer, a property test over the three levels
asserting `compress(s, Ultra).len() <= compress(s, Full).len() <= compress(s, Lite).len()`
for arbitrary `s`. That is the real proof and it belongs to sub-part 4e.

At this layer, a regression test that freezes a `cav:*` unit at depth 2 with a
deliberately short payload, then drives a bust in which the same block targets
depth 3 with a longer compression result, and asserts the pass returns an error
rather than panicking. The existing fixtures are close: `transform.rs:25660-25684`
already builds a `core` with a pre-existing caveman unit and calls
`new_caveman_units(&core, &request, &tags, &live, None, true, 1)`. What is missing
is a source string for which the deeper level grows, which the test would have to
either find or inject by stubbing the compressor.

## Investigation log

### Q: Can `caveman::compress` at a deeper level produce more bytes?

- Sources examined: `caveman_level` (`transform.rs:6274-6281`) for the depth-to-level
  map; the call at `:6360`; `CONFIGURATION.md:720-744` for the documented tier
  ladder; `CONFIGURATION.md:731-738` for the position-to-level table.
- Findings: The documented ladder is Lite, Full, Ultra by increasing aggression,
  which implies monotone shrinking. `CONFIGURATION.md:700` describes the technique
  as stop-word stripping plus common-verb replacement. Replacement is the operation
  that could grow output if any replacement string is longer than its source token.
- Missing evidence: `caveman.rs` was not read; it is 651 lines and belongs to 4e.
  Its 40 inline tests may already pin monotone size, in which case the `assert!` is
  defence in depth over a proven property and the panic is unreachable.
- Conclusion: unresolved, needs a read of `caveman.rs`'s level ladder. The record's
  Confidence is `medium` for exactly this reason: the assertion's existence and its
  release-build liveness are verified; the reachability of the panic is not.

### Q: Does the assertion contradict CONFIGURATION.md?

- Sources examined: `CONFIGURATION.md:740` in full, `transform.rs:6362-6376`.
- Findings: `CONFIGURATION.md:740` claims "repeated tier shifts converge to exactly
  the same output as direct compression at the final depth". The tie branch at
  `:6372-6374` keeps the *shallower* bytes at the deeper recorded depth, which is
  not the same output as direct compression at the final depth unless the two are
  byte-identical, and the code only knows they are equal in length. So the
  documented convergence claim is stronger than the code delivers.
- Missing evidence: whether equal length implies equal bytes for this compressor.
  Unlikely in general.
- Conclusion: resolved as a contract-versus-code disagreement, recorded as lead 5
  in the lens file with both sides cited. Not resolved in the documentation's
  favour, per METHOD.md rule 3.
