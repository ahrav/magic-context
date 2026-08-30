# dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller

## Discovery trigger

Task 6 asks whether an out-of-range or malformed configuration value is rejected,
clamped, or silently accepted, and whether the caller learns which. The answer in
`config.rs` is uniform: every value is clamped, and no caller learns. The task
brief notes that silent clamping diverging from a documented bound is a recurring
shape here, which is what made it worth enumerating rather than sampling.

## Evidence trail

Every value bound in `config.rs`, with what the documentation says about each.

**Execute threshold.** `config.rs:568-570`:

```
cfg.execute_threshold_percentage = cfg
    .execute_threshold_percentage
    .clamp(1.0, MAX_EXECUTE_THRESHOLD_PERCENTAGE);
```

Documented `20-90` (`CONFIGURATION.md:167`). Covered separately by
`dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1`.

**Auto-search score threshold.** `config.rs:590-592`:

```
if let Some(threshold) = number_at(value, "/memory/auto_search/score_threshold") {
    config.score_threshold = threshold.clamp(0.3, 0.95);
}
```

The clamp matches the documented range, which appears in prose rather than the
table. `CONFIGURATION.md:683` gives only `number` and default `0.6`, and `:706`
gives the range:

> `score_threshold`: minimum top-hit cosine score for the hint to fire (0.3–0.95,
> default 0.6).

So the bound is documented and implemented. The gap is only that exceeding it is
silent.

**Auto-search minimum prompt characters.** `config.rs:593-596`:

```
if let Some(min_prompt_chars) = positive_usize_at(value, "/memory/auto_search/min_prompt_chars")
{
    config.min_prompt_chars = min_prompt_chars.clamp(5, 500);
}
```

`CONFIGURATION.md:684` gives `number`, default `20`; `:707` gives the semantics
("minimum user message length to trigger auto-search (default 20). Short prompts
like 'yes' or 'ok' don't get a hint") and no range. So `5..=500` is undocumented.

**Caveman minimum characters.** `config.rs:606-608`:

```
if let Some(min_chars) = positive_usize_at(value, "/caveman_text_compression/min_chars") {
    config.min_size = min_chars.clamp(100, 10_000);
}
```

`CONFIGURATION.md:725` gives `number`, default `500`, and no range. So `100..=10_000`
is undocumented.

**The three asymmetric floors.** `config.rs:442`, `:444`, `:453`, and `:527` all
apply `.max(1.0)` to a token budget with no ceiling.

**Zero is discarded rather than clamped.** `positive_usize_at`
(`config.rs:623-629`):

```
fn positive_usize_at(value: &Value, pointer: &str) -> Option<usize> {
    value
        .pointer(pointer)
        .and_then(Value::as_u64)
        .and_then(|v| usize::try_from(v).ok())
        .filter(|v| *v > 0)
}
```

The `filter` at `:628` turns `0` into `None`, which means the `if let` does not
fire and the default survives. This affects three keys:
`/memory/auto_search/min_prompt_chars` (`:593`),
`/caveman_text_compression/min_chars` (`:606`), and
`/historian/context_limit_tokens` (`:464`). For `min_prompt_chars` this is the
sharp case: `0` is the natural spelling of "hint on every prompt", and it silently
becomes `20`.

`number_at` (`:631-636`) has the analogous behaviour for floats: it filters
`v.is_finite()`, so a non-finite value would be discarded rather than clamped.
JSON cannot carry `NaN` or `Infinity` in `serde_json`'s default configuration, so
this arm is defensive rather than reachable from a config file.

**The warning channel exists and is not used for values.**
`merge_tiers_with_warnings` returns `(McModuleConfig, Vec<String>)`
(`config.rs:373-376`, `:572`). `warn_ignored_project_key` (`:575-581`) pushes a
warning and is called six times: `:520`, `:538`, `:539`, `:540`, `:556`, `:561`.
One more warning is pushed by hand for the deprecated memory key at `:446-451`.
None of the eight value clamps pushes anything.

**And the vector never reaches a caller.** `emit_warnings` (`:275-279`) prints each
warning with `eprintln!` and consumes the vector. `effective_for_paths`
(`:228-238`) calls it at `:236` and returns `McModuleConfig` at `:237`. The
`#[cfg(test)] merge_tiers` wrapper (`:268-273`) does the same, which is why every
existing tier test asserts values and none asserts a warning: `:797-802`,
`:811-825`, `:829-835`, `:930-970`, `:1166-1178`.

## Failure scenario

A user finds that auto-search hints fire too rarely. They read
`CONFIGURATION.md:707` and decide short prompts should get hints too, so they
write

```
{ "memory": { "auto_search": { "min_prompt_chars": 0 } } }
```

`positive_usize_at` discards `0` at `config.rs:628`. `min_prompt_chars` stays at
the default `20`. Nothing changes and nothing is reported. The user tries `1`,
which survives `positive_usize_at` and is then raised to `5` by the clamp at
`:595`. Still nothing is reported, and the behaviour at `1` and at `5` is
identical, which reads like the setting is ignored.

The same user tunes `score_threshold` to `0.99` to make hints rarer. It is clamped
to `0.95` at `:591`. Hints keep firing at `0.95`, and the config file says `0.99`.

Both are recoverable by reading the source. Neither is discoverable from the
documentation or from any output the module produces, because the only channel is
an `eprintln!` in a daemon component.

## Timing windows and dependencies

None. Clamping happens during every config resolution.

There is one dependency worth naming: because the clamps are applied inside
`apply_auto_search_config` (`:583-597`) and `apply_caveman_config` (`:599-609`),
and both functions are called once for the user tier (`:439-440`) and once for the
project tier (`:524-525`), a project value is clamped independently of the user
value. So the tiers cannot combine to escape a clamp.

## What a test must construct

Eight assertions, one per bound, in the shape of the existing
`auto_search_and_caveman_config_follow_user_then_project_tiers`
(`config.rs:930-970`). Each supplies a value outside the bound and asserts either
the clamped result plus a warning naming the key, or a rejection.

The `positive_usize_at` cases need a distinct assertion because the outcome is not
a clamp: supply `0` for `min_prompt_chars` and assert that the result is
distinguishable from omitting the key. Today it is not, so the assertion has to be
on a warning.

The one structural test worth adding is that `emit_warnings` is not the only
consumer: assert that `effective_for_paths` surfaces the warning count, which
requires a signature change. Stated as a property rather than a fix, the test
asserts "when the resolved value differs from the supplied value, the resolution
reports the key". `merge_tiers_with_warnings` already satisfies that shape for
project-tier ignores, so the test can be written against it without touching
`effective_for_paths`.

## Investigation log

### Q: Is the stderr line from `emit_warnings` visible anywhere?

- Sources examined: `config.rs:275-279`; `lib.rs:4427-4436`
  (`effective_config`, which holds the `ConfigCache` behind a `Mutex` and returns
  only the config); the scope map's description of the module as a component
  plugged into `mc-host` (`part-4-module/_lenses/scope-map-and-risk-ranking.md:44-46`).
- Findings: the module runs as a lifecycle component under a host process. Whether
  its stderr is captured, logged, or discarded is a property of the host's process
  wiring, which Part 2a owns. Six warnings are already routed through this channel
  for project-tier ignores, so the author treats it as a real output; that does not
  establish that a user sees it.
- Missing evidence: the host's stdio handling for the module component.
- Conclusion: unresolved, needs Part 2a's process-wiring material. The record's
  guarantee is about the resolution reporting the key, which is independent of
  where a report would be printed.

### Q: Do any of the clamps disagree with a documented bound?

- Sources examined: `CONFIGURATION.md:167`, `:591`, `:683`, `:684`, `:706`,
  `:707`, `:725`; `config.rs:568-570`, `:591`, `:595`, `:607`, `:442`, `:453`,
  `:527`.
- Findings: one disagrees (`execute_threshold_percentage`, lower bound `20` versus
  `1`), one matches (`score_threshold`, `0.3-0.95` in prose at `:706`), one is
  documented as a range and not implemented at all
  (`memory.injection_budget_tokens`, `500-20000`), and two clamps are undocumented
  (`min_prompt_chars` `5..=500`, caveman `min_chars` `100..=10_000`).
- Missing evidence: none.
- Conclusion: resolved with answer. Two of the five are separate records; this one
  owns the reporting gap that all five share, plus the two undocumented clamps and
  the zero-discard behaviour.
