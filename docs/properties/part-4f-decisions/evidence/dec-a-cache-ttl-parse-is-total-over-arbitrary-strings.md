# dec-a-cache-ttl-parse-is-total-over-arbitrary-strings

## Discovery trigger

Task 2 asks whether each unit is total over its declared input domain, what happens
at zero, at the maximum, and outside the intended range, and asks explicitly to
check saturating-versus-wrapping arithmetic and rounding. `parse_cache_ttl` takes an
arbitrary `&str` from a user config file, does floating-point arithmetic, and casts
to `u64`, so it is the densest totality target in 4f scope.

## Evidence trail

The unit. `scheduler.rs:384-419`:

```
pub fn parse_cache_ttl(ttl: &str) -> Result<u64, CacheTtlParseError> {
    let normalized = ttl.trim();
    if normalized.eq_ignore_ascii_case("never") {
        return Ok(u64::MAX);
    }
    let (number, multiplier) =
        if !normalized.is_empty() && normalized.chars().all(|c| c.is_ascii_digit()) {
            (normalized, 1.0)
        } else {
            let Some(unit) = normalized.chars().last() else {
                return Err(CacheTtlParseError);
            };
            let number = &normalized[..normalized.len().saturating_sub(unit.len_utf8())];
            let multiplier = match unit {
                's' => 1_000.0,
                'm' => 60.0 * 1_000.0,
                'h' => 60.0 * 60.0 * 1_000.0,
                _ => return Err(CacheTtlParseError),
            };
            (number, multiplier)
        };
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return Err(CacheTtlParseError);
    }
    // JavaScript's Number() accepts the syntactically valid digit sequence and yields
    // Infinity on overflow. Saturating to u64::MAX preserves that value's practical
    // scheduler behavior (no finite elapsed time can exceed it) instead of rejecting it.
    let milliseconds = number.parse::<f64>().map_err(|_| CacheTtlParseError)? * multiplier;
    Ok(
        if !milliseconds.is_finite() || milliseconds >= u64::MAX as f64 {
            u64::MAX
        } else {
            milliseconds as u64
        },
    )
}
```

I executed this exact logic on nine inputs rather than reasoning about it. Results:

| Input | Result | Why it matters |
| --- | --- | --- |
| `"0"` | `Ok(0)` | zero boundary; accepted, not rejected |
| `"5m"` | `Ok(300000)` | the documented default |
| `"never"`, `"NEVER"`, `" never "`, `"Never"` | `Ok(u64::MAX)` | case-insensitive, trimmed |
| `"5S"` | `Err` | uppercase unit rejected while `NEVER` is accepted |
| `"5x"` | `Err` | unknown unit |
| `""` | `Err` | empty, via the `chars().last()` guard at `:395` |
| `"-5m"` | `Err` | the digits check at `:406` catches the sign |
| `"99999999999999999999h"` | `Ok(u64::MAX)` | the overflow arm at `:414-418` |
| `"5\u{20ac}"` (a euro sign) | `Err` | multi-byte trailing character |

The multi-byte case is the one that could have panicked and does not. `:397` is
`&normalized[..normalized.len().saturating_sub(unit.len_utf8())]`. Because `unit` is
`chars().last()`, subtracting its own UTF-8 length lands exactly on a character
boundary, so the slice cannot panic. Using `len() - 1` there would panic on any
multi-byte trailing character.

The overflow arm is a deliberate saturation, not an accident, and the comment at
`:410-412` says why: JavaScript parity. `f64::parse` on a twenty-digit run yields a
finite but enormous value; multiplied by `3_600_000.0` it stays finite here, and
`milliseconds >= u64::MAX as f64` catches it. The `!milliseconds.is_finite()` arm
catches the case where the multiplication does overflow to infinity. Either way the
result is `u64::MAX`, and no `as u64` cast is performed on an out-of-range float.

Both predicates then treat `u64::MAX` correctly. `scheduler.rs:422-432`:

```
pub fn ttl_execute_fired(now_ms: u64, last_response_time_ms: u64, ttl_ms: u64) -> bool {
    now_ms.saturating_sub(last_response_time_ms) > ttl_ms
}

pub fn ttl_hard_expired(now_ms: u64, last_response_time_ms: u64, ttl_ms: u64) -> bool {
    last_response_time_ms > 0 && now_ms.saturating_sub(last_response_time_ms) > ttl_ms
}
```

`saturating_sub` means a `last_response_time_ms` in the future cannot underflow, and
`elapsed > u64::MAX` is never true, which is the property
`scheduler.rs:1427-1435` already pins.

**The zero case is where the totality result turns into a hazard.** `Ok(0)` means
`ttl_hard_expired(now, last, 0)` is `last > 0 && elapsed > 0`, true for any elapsed
millisecond. `decide` uses it at `scheduler.rs:725-726`:

```
let ttl_ms = scheduler_ttl_ms(&inputs.session.cache_ttl);
let idle_ttl_fired =
    ttl_hard_expired(inputs.now_ms, inputs.session.last_response_time_ms, ttl_ms);
```

and `idle_ttl_fired` forces `PassDecision::Execute` at `:734-739`. So
`cache_ttl: "0"` makes every pass after the first an Execute, which is a cache-busting
pass.

`config.rs` lets `"0"` through. `:486-491`:

```
Some(Value::String(cache_ttl)) => {
    if !cache_ttl.trim().is_empty() {
        cfg.cache_ttl = cache_ttl.trim().to_string();
    }
}
```

Any non-empty trimmed string is accepted; there is no attempt to parse it at config
time. The object shape at `:496-509` is the same: `if ttl.trim().is_empty() { continue }`
is the only validation.

**And an unparseable string is swallowed.** `scheduler_ttl_ms`
(`scheduler.rs:810-812`):

```
fn scheduler_ttl_ms(cache_ttl: &str) -> u64 {
    parse_cache_ttl(cache_ttl).unwrap_or(DEFAULT_CACHE_TTL_MS)
}
```

with `DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000` at `:23`. So `"5S"` silently becomes
five minutes, and neither the config layer nor the scheduler reports it. There is a
comment in `config.rs:492-495` about a related bug that was fixed, silently ignoring
the object shape, which shows the author has already been bitten once by a silent
TTL fallback.

## Failure scenario

A user wants Magic Context to apply pending operations promptly and writes

```
{ "cache_ttl": "0" }
```

reading `CONFIGURATION.md:163` ("Time after a response before applying pending
ops") as a delay to minimise. `config.rs:488-490` accepts the string.
`parse_cache_ttl` returns `Ok(0)`. From the second pass onward `ttl_hard_expired` is
true, so `decide` returns `Execute` regardless of context usage, and every pass
busts the provider prefix cache. The user has turned off exactly the mechanism the
crate exists to protect, by writing the smallest number.

A second user writes `"5S"`, capitalising the unit. `parse_cache_ttl` returns `Err`,
`scheduler_ttl_ms` substitutes five minutes, and the user's intended five seconds
never applies. Nothing says so.

## Timing windows and dependencies

The parse has none. The consequence depends on `now_ms` and
`last_response_time_ms`, both parameters rather than clock reads, so the decision is
reproducible from a recorded pair. `last_response_time_ms == 0` is the fresh-session
guard in `ttl_hard_expired`, which is why the zero-TTL effect starts on the second
pass rather than the first; `scheduler.rs:1366` pins that fresh-session behaviour.

## What a test must construct

The totality half is a table test over strings, asserting no panic and the expected
`Result`. The nine inputs above are the set worth pinning; the existing test
(`scheduler.rs:1417-1424`) already covers four of them.

The hazard half needs two assertions:

1. `parse_cache_ttl("0") == Ok(0)` plus a decision-level assertion that a
   `SessionMeta` with `cache_ttl: "0"`, `last_response_time_ms: 1`, and a `now_ms`
   one millisecond later yields `PassDecision::Execute`. `scheduler.rs:1437` already
   builds the mirror-image fixture for `never`, so the harness exists.
2. A config-level assertion that an unparseable `cache_ttl` string is reported.
   `config.rs:786-796` (`string_cache_ttl_shape_still_parses`) is the existing shape;
   the new case supplies `"5S"` and asserts a warning naming `/cache_ttl`.

## Investigation log

### Q: Is `cache_ttl: "0"` intended as "always expire"?

- Sources examined: `CONFIGURATION.md:163` (`cache_ttl` | `string` or `object` |
  `"5m"` | "Time after a response before applying pending ops. String or per-model
  map."), which documents no zero semantics; `scheduler.rs:22-23`
  (`DEFAULT_CACHE_TTL_MS`); `:384-419`; `:422-432`; the `never` handling, which is an
  explicit sentinel with its own tests at `:1417-1445`.
- Findings: `never` has a deliberate sentinel and three tests. Zero has neither, and
  it produces the maximally aggressive behaviour rather than the maximally
  conservative one. The asymmetry suggests zero was not considered rather than
  deliberately chosen.
- Missing evidence: whether the TypeScript twin rejects `0`. The overflow comment at
  `:410-412` shows the author matched JavaScript `Number()` semantics deliberately,
  so the twin is the reference for this function's edge behaviour.
- Conclusion: needs human input. Either `0` should be rejected at config time or
  documented as "expire immediately".

### Q: Does the uppercase-unit asymmetry matter?

- Sources examined: `:386-387` (`eq_ignore_ascii_case("never")`); `:399-404` (the
  exact-match unit table).
- Findings: it is a real inconsistency in one function: the word is
  case-insensitive, the unit is not. Because the failure is swallowed by
  `scheduler_ttl_ms`, a user gets the default rather than an error.
- Missing evidence: none.
- Conclusion: resolved with answer. The asymmetry is confirmed by execution and is
  folded into this record's impact rather than given its own; the load-bearing part
  is that a rejected string becomes a silent default.
