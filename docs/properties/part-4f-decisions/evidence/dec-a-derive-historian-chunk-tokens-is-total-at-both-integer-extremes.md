# dec-a-derive-historian-chunk-tokens-is-total-at-both-integer-extremes

## Discovery trigger

Task 2 asks what happens at zero, at the maximum, and outside the intended range,
and asks to check saturating-versus-wrapping arithmetic and rounding explicitly.
`derive_historian_chunk_tokens` does all three things a totality defect needs: an
integer-to-float cast, a rounding step, and a float-to-integer cast, in four lines.

## Evidence trail

The unit. `config.rs:44-48`:

```
/// Derive the historian producer budget from its own context window, as the TS runner does.
pub fn derive_historian_chunk_tokens(context_limit_tokens: usize) -> usize {
    (((context_limit_tokens as f64) * 0.25).round() as usize)
        .clamp(MIN_HISTORIAN_CHUNK_TOKENS, MAX_HISTORIAN_CHUNK_TOKENS)
}
```

The declared range comes from two constants with documented reasons.
`config.rs:29-34`:

```
/// Minimum historian producer chunk size. The derived budget is one quarter of the model
/// context limit, but it is never allowed to fall below 8,000 tokens.
pub const MIN_HISTORIAN_CHUNK_TOKENS: usize = 8_000;
/// Maximum historian producer chunk size. The derived budget is one quarter of the model
/// context limit, but it is never allowed to exceed 50,000 tokens.
pub const MAX_HISTORIAN_CHUNK_TOKENS: usize = 50_000;
```

Both extremes, executed rather than reasoned about:

| Input | Result |
| --- | --- |
| `0` | `8_000` |
| `1` | `8_000` |
| `usize::MAX` | `50_000` |

The `usize::MAX` case is the interesting one. `usize::MAX as f64` is about
`1.8e19`, which is representable; `* 0.25` gives about `4.6e18`, also representable;
`.round()` is a no-op at that magnitude; and `as usize` on a float that exceeds
`usize::MAX` would be undefined behaviour in C but is a **saturating** cast in Rust,
so it yields `usize::MAX`. The clamp then returns `50_000`. Nothing wraps.

The clamp itself cannot panic: `f64::clamp` panics when `min > max` or either bound
is NaN, but this is `usize::clamp` over two constants with `8_000 < 50_000`.

The rounding order matters and is correct. Rounding before the clamp means the
clamp sees an integer, so a value like `31_999.6` becomes `32_000` and then passes
through, rather than being clamped as a float and then truncated. The existing test
pins the arithmetic at the mid-range:
`derive_historian_chunk_tokens(128_000) == 32_000` (`config.rs:975`), which is
exactly `0.25 * 128_000`.

The existing test, `config.rs:972-978`:

```
#[test]
fn historian_budget_derivation_clamps_at_both_bounds() {
    assert_eq!(derive_historian_chunk_tokens(1), 8_000);
    assert_eq!(derive_historian_chunk_tokens(32_000), 8_000);
    assert_eq!(derive_historian_chunk_tokens(128_000), 32_000);
    assert_eq!(derive_historian_chunk_tokens(200_000), 50_000);
    assert_eq!(derive_historian_chunk_tokens(400_000), 50_000);
}
```

Five cases covering both clamp arms and the pass-through. Neither `0` nor
`usize::MAX` is covered, which is the gap this record names.

The input's provenance. The only production argument is
`config.historian_context_limit_tokens`, whose default is
`DEFAULT_HISTORIAN_CONTEXT_LIMIT_TOKENS = 128_000` (`config.rs:35-37`, applied at
`:129`), and whose only parse is `config.rs:464-466`:

```
if let Some(limit) = positive_usize_at(user, "/historian/context_limit_tokens") {
    cfg.historian_context_limit_tokens = limit;
}
```

`positive_usize_at` (`:623-629`) filters `*v > 0`, so a configured `0` is discarded
and the default survives. That means the `0` input is unreachable from configuration
and only reachable by a direct call. The `usize::MAX` input needs a configured value
above about `2e14` for the clamp to matter, which any large number achieves; the
saturating-cast case specifically needs a value near `usize::MAX`, which JSON can
express as a `u64` and `usize::try_from` will accept on a 64-bit target.

The three call sites, all inside `lib.rs`: `:4700` in `maybe_spawn_reattach`, `:5087`
in `prepare_historian_fire`, and `:5250` in `prepare_wrapup_fire`. All three pass
the config value and use the result as `token_budget` on a historian firing request.

## Failure scenario

There is no failure today. The record fixes a boundary, and the value of doing so is
that the failure mode of a regression here is quiet rather than loud.

If the cast were not saturating, or if a future change replaced `.clamp` with a
manual `if` that got the order wrong, an absurd configured limit would produce a
tiny `token_budget` rather than the documented maximum. A tiny historian chunk budget
does not error: `historian_chunk.rs` builds a pinned ordinal-range chunk sized to the
budget, so the historian would fire repeatedly on minuscule chunks, each firing
spending a model call and publishing a compartment covering almost no conversation.
The observable symptom would be an unusual number of historian fires, not a crash.

The reachable direction today is the benign one: a user who writes
`"context_limit_tokens": 100000000` gets `50_000`, which is the documented maximum
and the intended degradation.

## Timing windows and dependencies

None. The function is pure and the input is resolved at config read.

## What a test must construct

Two lines added to the existing test at `config.rs:972-978`:

```
assert_eq!(derive_historian_chunk_tokens(0), 8_000);
assert_eq!(derive_historian_chunk_tokens(usize::MAX), 50_000);
```

The second is the load-bearing one because it is the assertion that documents the
saturating cast. A reader who does not know that Rust's float-to-integer `as` cast
saturates would expect that line to be either undefined or wrapping, and pinning it
makes the reliance explicit.

A property-test form is also cheap: for any `usize`, assert the result is in
`[8_000, 50_000]`. That covers the whole domain in one assertion and would catch a
reordering of round and clamp.

## Investigation log

### Q: Is the documented quarter-of-context rule stated anywhere outside the code?

- Sources examined: `config.rs:29-34` (both constant comments state the rule and
  both bounds); `config.rs:44` ("as the TS runner does");
  `rg -n "context_limit_tokens|historian_chunk" CONFIGURATION.md` returns nothing.
- Findings: the rule and both bounds live only in the Rust doc comments, and
  `historian.context_limit_tokens` is absent from `CONFIGURATION.md` entirely. So a
  user cannot discover either the key or the derivation. That is a documentation gap
  recorded as a lead in the lens file, not a defect in this function.
- Missing evidence: whether the TypeScript runner uses the same `0.25` and the same
  bounds. `config.rs:44` asserts it does, which makes it a claim under test on the
  TypeScript side, outside 4f scope.
- Conclusion: resolved for this record's purposes. The function matches its own
  documented range; the missing external documentation is a separate lead.

### Q: Can a configured value reach the saturating-cast path?

- Sources examined: `config.rs:464-466`; `positive_usize_at` (`:623-629`), which
  chains `Value::as_u64` then `usize::try_from`.
- Findings: yes on a 64-bit target. A JSON integer up to `u64::MAX` parses through
  `as_u64`, and `usize::try_from` succeeds when `usize` is 64 bits. So a config of
  `"context_limit_tokens": 18446744073709551615` reaches the function with
  `usize::MAX`. On a 32-bit target `usize::try_from` would fail and the key would be
  discarded.
- Missing evidence: none. The record's reachability label is `default-production`
  because the function runs on every historian prepare with the default input, and
  the extreme inputs are `explicit-config-only` refinements of it; the property is
  stated over the whole domain.
- Conclusion: resolved with answer.
