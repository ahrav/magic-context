# clock-anomalies-do-not-invalidate-live-evidence

## Discovery trigger

The catalog recorded this at high confidence because "the saturating collapses
and the wall-clock comparison are literal," with the note that both existing
freshness tests manipulate the record rather than the clock. The lens is
fault-injection at a boundary the code does not model: `now_ms` cannot fail, so
it swallows two distinct clock anomalies as ordinary `u64` values, and every
downstream comparison treats them as trustworthy timestamps.

## Evidence trail

- `now_ms` is `crates/mc-host/src/lifecycle.rs:400-405`. It has both saturating
  collapses, and neither is signalled:
  - **Pre-epoch to zero.** `.unwrap_or(0)` at `:404` covers the outer
    `SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)` at `:401-402`,
    which returns `Err` exactly when the wall clock reads before 1970. The
    function then returns `0`.
  - **Unrepresentable to maximum.** `u64::try_from(d.as_millis()).unwrap_or(u64::MAX)`
    at `:403`. `Duration::as_millis` returns `u128`, so a count exceeding
    `u64::MAX` collapses to `u64::MAX`.
- The comparison is `timestamp_fresh` at `:1029-1033`:
  `written_at_ms <= now.saturating_add(window_ms) && now.saturating_sub(written_at_ms) <= window_ms`,
  with `now = now_ms()` at `:1030` and `window_ms = 60_000` for the shipped
  window. The first conjunct is the future-side bound, the second the age-side
  bound.
- The window is **60 seconds**, `Duration::from_secs(60)`, configured in `impl
  Default for ProbeFreshness` at `:770-776`, value at `:773`. The sole production
  caller passes `ProbeFreshness::default()` at
  `crates/mc-module/src/bin/ck-mc-host.rs:402`, so 60 s is the only value that
  ships and it is not exposed as a flag, a `HostTiming` field, or an env var.
- **No monotonic source is used for this comparison.** A grep for `Instant`,
  `monotonic`, and `CLOCK_MONO` across `lifecycle.rs` returns nothing, and the
  only `SystemTime` uses are `:401-402` in `now_ms` and `:2508` in a test. The
  same wall clock feeds the writer (`written_at_ms: now_ms()` at `:427`) and the
  reader (`:1030`), so a step between the two is invisible to both. `Instant` is
  used in the CLI, but only for `settle_probe`'s deadline
  (`ck-mc-host.rs:408-418`), never for freshness.
- There is no skew allowance beyond the window itself: `window_ms` at `:1031` is
  the sole tolerance, and the same 60 s serves as both the expiry bound and the
  future bound.

Concretely, with `window_ms = 60_000` and a genuine record whose
`written_at_ms` is a current epoch-millisecond count near `1.7e12`:

- **Collapse to zero.** `now = 0`. Future-side becomes
  `written_at_ms <= 0 + 60_000`, i.e. `1.7e12 <= 60_000`, which is **false**, so
  the conjunction is false. Age-side would have passed (`0 - 1.7e12` saturates to
  `0`, and `0 <= 60_000`). The verdict flips to `Wedged` with reason `"starting
  record expired"` (`:1141`) or `"stopping record expired"` (`:1165`) — but the
  rejection actually came from the *future* bound, so the emitted reason
  misdescribes the cause.
- **Collapse to maximum.** `now = u64::MAX`. Future-side becomes
  `written_at_ms <= u64::MAX.saturating_add(60_000)` = `written_at_ms <=
  u64::MAX`, always **true**. Age-side becomes `u64::MAX - 1.7e12 <= 60_000`,
  i.e. roughly `1.8e19 <= 60_000`, which is **false**. Same two reasons, this
  time reached through the age bound, which is directionally accurate.

Both collapses therefore drive `timestamp_fresh` to `false` and both produce
`Wedged`. Neither can manufacture a false *fresh* verdict, so the failure
direction is closed rather than open: the property fails toward alarm, not toward
admitting a dead host as live.

## Failure scenario

1. An incarnation writes a `starting` or `stopping` record; `written_at_ms` is a
   normal epoch count (`lifecycle.rs:427`).
2. The wall clock moves — an NTP step, a manual `date` correction, a VM suspend
   and resume, or a clock set before 1970 — by more than 60 s in either
   direction, or far enough to trigger one of the two collapses.
3. A probe calls `timestamp_fresh` at `:1138` or `:1162`. Whichever conjunct the
   step or collapse violates, the result is `false`.
4. `classify` returns `Wedged`. The CLI's `settle_probe` stops re-probing on a
   non-transitional state (`ck-mc-host.rs:415`), so the flip is terminal, and
   the operator-visible reason collapses to a bare `"wedged"` at `:605`.
5. The healthy incarnation is reported incoherent until it writes its next
   transition record, which for a long phase may be never.

## Timing windows and dependencies

Any step larger than 60 s while a record reads `starting` or `stopping`
suffices; `running` records are immune because that arm compares publication
identity (`:1144-1157`) and never calls `timestamp_fresh`. The collapses are the
extreme endpoints of the same wall-clock sensitivity, not a separate mechanism.
This record shares the 60 s window and the same two reason strings with
`phase-evidence-outlives-a-long-phase`: that record attacks the window from the
duration side, this one from the clock side.

## What a test must construct

A live coherent incarnation whose probe verdict is invariant to wall-clock
adjustments larger than the window. That needs a clock seam, which the code does
not have: `now_ms` reads `SystemTime::now()` directly at `:401`. Without one,
the reachable substitutes are an injected `written_at_ms` at each collapse value
— `0` and `u64::MAX` — which exercises the same two conjuncts from the record
side, and a container or namespace whose clock can be stepped. The existing tests
cover neither: `expired_starting_and_stopping_evidence_is_wedged`
(`lifecycle.rs:1537-1551`) shrinks the *window* to `Duration::ZERO`, and
`future_timestamps_beyond_the_window_are_wedged` (`:1554-1568`) rewrites
`written_at_ms` to `now_ms() + 3_600_000`. Neither moves the clock, and neither
distinguishes a forged record from a stepped clock.

## Investigation log

### Q: Does the millisecond helper have both saturating collapses, and what does each do to the freshness comparison?

- Sources examined: `lifecycle.rs:400-405` in full; `timestamp_fresh`
  `:1029-1033`; the two call sites `:1138` and `:1162`; `ProbeFreshness`
  `:765-776`; `ck-mc-host.rs:402`.
- Findings: both collapses confirmed — `unwrap_or(0)` at `:404` for a pre-epoch
  clock and `unwrap_or(u64::MAX)` at `:403` for an unrepresentable count.
  Against a real `written_at_ms`, zero fails the future-side conjunct while the
  age-side would pass; maximum fails the age-side conjunct while the future-side
  passes. Both yield `false`, hence `Wedged`. The window is 60 s at `:773`, and
  the reason string emitted for the zero case misattributes the cause to expiry.
- Missing evidence: none.
- Conclusion: resolved. Both collapses fail closed toward `wedged`; neither can
  produce a spurious `fresh`.

### Q: Is any monotonic source used for this comparison?

- Sources examined: grep for `Instant`, `monotonic`, `CLOCK_MONO`, and
  `SystemTime` across `lifecycle.rs`; `ck-mc-host.rs:46-49` and `:408-418`.
- Findings: no monotonic source anywhere in `lifecycle.rs`. `SystemTime` appears
  only at `:401-402` and in a test at `:2508`. `Instant` appears only in the CLI
  and only for `settle_probe`'s deadline, never in freshness.
- Missing evidence: none.
- Conclusion: confirmed. The comparison is wall-clock on both sides, with the
  60 s window as its only tolerance.
