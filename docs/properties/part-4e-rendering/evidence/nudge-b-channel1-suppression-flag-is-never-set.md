# nudge-b-channel1-suppression-flag-is-never-set

## Discovery trigger

Reading `maybe_append_channel1_nudge` for the overlay lifecycle. It reads a
suppression flag, clears it, and returns `None` with no record. Chasing the writer
found none, and then found that the field's own doc comment names a writer that
does not exist.

## Evidence trail

`HEAD` `e447c927`. All lines read back.

### The contract

`crates/mc-store/src/lib.rs:2458-2461`:

```
    /// Set by ctx_reduce after the agent has acted on a reminder. The next transform
    /// suppresses new Channel-1 appends while still replaying every stored append row.
    #[serde(default)]
    pub channel1_reduce_suppressed: bool,
```

Two claims. The second one is accurate: the flag only guards the new-append path,
and stored rows do keep replaying, because `tag_overlay_state`
(`crates/mc-module/src/transform.rs:8161-8165`) never consults it. The first claim
is the problem.

### Every occurrence in the worktree

`git grep reduce_suppressed` returns exactly six lines:

1. `crates/mc-store/src/lib.rs:2461` — the field declaration.
2. `crates/mc-module/src/transform.rs:9156` —
   `let was_suppressed = meta.channel1_reduce_suppressed;`
3. `crates/mc-module/src/transform.rs:9157` —
   `meta.channel1_reduce_suppressed = false;`
4. `crates/mc-module/src/transform.rs:9565` — inside `decide_channel1`:
   `let reset_cycle = meta.channel1_reduce_suppressed || reclaimable_tokens <
   meta.channel1_last_nudge_undropped.max(0);`
5. `crates/mc-module/src/transform.rs:9593` — inside `decide_channel1`:
   `if meta.channel1_reduce_suppressed { return quiet(0, String::new()); }`
6. `crates/mc-module/src/transform.rs:23577` — inside
   `#[test] fn channel1_hygiene_ratio_nudge_replays_and_suppresses_refire`:
   `loaded.meta.channel1_reduce_suppressed = true;`

Occurrence 6 is the only assignment to `true` anywhere, and it is in a test that
writes it straight into the store and commits
(`:23576-23579`). A search for a camelCase equivalent
(`reduceSuppressed`) across the TypeScript packages returns nothing, so no host
writes it either.

### The read sites, in order

`maybe_append_channel1_nudge` (`:9142-9177`):

```
9146:    let active_tags = active_tags_for_nudge(...);
9153:    let decision = decide_channel1(input.baseline, meta);
9154:    meta.channel1_last_nudge_undropped = decision.next_last_nudge;
9155:    meta.channel1_last_nudge_level = decision.next_last_level;
9156:    let was_suppressed = meta.channel1_reduce_suppressed;
9157:    meta.channel1_reduce_suppressed = false;
9158:    if was_suppressed || !decision.fire {
9159:        return None;
9160:    }
```

Three observations. The memo fields at `:9154-9155` are written before the fire
check, so a quiet pass still mutates `meta`. The clear at `:9157` is unconditional,
so if the flag were ever set it would be a single-pass token. And the `return None`
at `:9159` covers both "suppressed" and "did not fire" with no way to tell them
apart afterwards, which is the same shape the sibling lens recorded for a dropped
message.

The clear is also gated on `tagging_active` reaching `:5335`. If tagging goes
inactive, a set flag would never be cleared, so the suppression would become
permanent rather than single-pass. Moot while nothing sets it, but it is a real
asymmetry between the setter's implied lifetime and the clearer's reachability.

### What happens instead of suppression

`decide_channel1`'s `reset_cycle` at `:9565-9566`:

```
let reset_cycle = meta.channel1_reduce_suppressed
    || reclaimable_tokens < meta.channel1_last_nudge_undropped.max(0);
```

An agent that complies with a reminder reduces tool output, which lowers
`reclaimable_tokens` below the memo. So the second disjunct fires, and
`:9567-9578` sets `last_nudge = 0` and `last_level = None`. With `last_level` at
`None`, `escalated` is `last_level.is_none_or(...)` which is `true` (`:9608`), so
the next time pressure clears the floors the nudge fires again at `Gentle` with no
cadence requirement.

The two behaviours are therefore opposite. The documented one suppresses the next
append. The implemented one re-arms the ladder from the bottom, so compliance
guarantees the next nudge rather than preventing it. Both are defensible designs;
they are not the same design.

## Failure scenario

The agent reads a `<system-reminder>` telling it that ~40k tokens of tool output
are unreduced, and calls `ctx_reduce` on the named tags. Reclaimable mass drops.
`reset_cycle` fires, the memo zeroes, and the level resets to none. As soon as
enough new tool output accumulates to clear `CHANNEL1_FLOOR_TOKENS` (25_000,
`tail_hygiene.rs:16`) and `CHANNEL1_GENTLE_FRACTION` (0.20,
`transform.rs:110`), a fresh `Gentle` nudge fires on a new block, adding a new
`mc_channel1_appends` row.

The observable effect is that a compliant agent sees reminders at least as often
as a non-compliant one, and possibly more often, because the non-compliant agent's
`reclaimable_tokens` keeps rising and so keeps failing the
`reclaimable_tokens < last_nudge` test that triggers the reset.

## Timing windows and dependencies

If the flag were ever set, the window would be from the `ctx_reduce` commit to the
next `tagging_active` transform pass, and the clear at `:9157` would consume it on
that pass. Since nothing sets it, there is no window.

Dependencies: the `ctx_reduce` facade handler, which is 4d scope, and
`ModuleMeta` serialization, which honours a stored `true` because of
`#[serde(default)]` (`mc-store/src/lib.rs:2460`).

## What a test must construct

The property is `always`, so the test needs the antecedent.

1. Drive a `ctx_reduce` call that freezes at least one reduction. The facade
   handler is `handle_ctx_reduce_facade` in `lib.rs`, which is 4d scope, so this
   test crosses a sub-part boundary.
2. Drive the next `tagging_active` transform pass for the same session.
3. Assert `decide_channel1` took the suppressed arm. Since `decide_channel1` is
   private and returns a struct, the observable proxy is that
   `meta.channel1_last_nudge_undropped == 0` and
   `meta.channel1_last_nudge_level.is_empty()` after the pass, which is what
   `quiet(0, String::new())` (`:9594`) produces, and that no new append row was
   written.

That assertion fails today. The cheaper intermediate test, which is worth having
regardless, is the one the existing suite almost does: assert that
`meta.channel1_reduce_suppressed` is `true` after a reducing `ctx_reduce` commit.
That is a single field read and it isolates the missing writer from everything
downstream.

`channel1_hygiene_ratio_nudge_replays_and_suppresses_refire`
(`:23551-23590`) is the existing check and it covers the *effect*, not the cause:
it writes the flag directly at `:23577`, then asserts the older block keeps its
reminder while the new block gets none (`:23586-23587`) and the row count stays at
1 (`:23588`). That is a good test of the suppression semantics and no test at all
of whether suppression can happen.

## Investigation log

### Q: Was the writer removed, or never written?

- Sources examined: the six occurrences above; `ModuleMeta`'s serde attributes
  (`mc-store/src/lib.rs:2460`); the TypeScript packages, searched for
  `reduceSuppressed` and `reduce_suppressed`, both returning nothing.
- Findings: the field is `#[serde(default)]`, so a `true` written by any past
  writer would still round-trip through the store and be honoured. That is
  consistent with either history. The doc comment's specificity ("Set by
  ctx_reduce after the agent has acted on a reminder") reads like a description of
  code that existed rather than a design note for code that did not.
- Missing evidence: repository history, which would settle it.
- Conclusion: needs human input.

### Q: Does the `reset_cycle` path make the flag redundant?

- Sources examined: `:9565-9578` (`reset_cycle` and its two consequences),
  `:9593-9595` (the suppression arm), `:9608-9613` (the escalation and cadence
  gates).
- Findings: not redundant, and not equivalent. `reset_cycle` zeroes the memo and
  therefore *enables* the next fire by making `escalated` true. The suppression arm
  returns `quiet(0, String::new())` which does the same zeroing, but
  `maybe_append_channel1_nudge` also returns `None` for this pass (`:9158-9160`),
  so the flag buys exactly one pass of silence on top of the reset. The flag is a
  one-pass mute; `reset_cycle` is a ladder reset. Having both makes sense: mute
  the pass immediately after the reduce, then let the ladder climb again.
- Missing evidence: none.
- Conclusion: resolved with answer. The design is coherent; only the writer is
  missing.

### Q: Is the unconditional clear at `:9157` safe if a stored `true` arrives?

- Sources examined: `:5334-5335` (the `tagging_active` gate on the call),
  `:3503-3504` (how `tagging_active` is computed), `:9157`.
- Findings: the clear only runs when `tagging_active`. A session that stored
  `true` and then lost the tagging surface, for example because
  `tool_present` went false, would keep the flag set indefinitely, and
  `decide_channel1` would keep returning `quiet(0, ..)` on every pass where it is
  consulted. But `decide_channel1` is only reached from
  `maybe_append_channel1_nudge`, which is behind the same gate, so the stale flag
  would have no effect until tagging returned, at which point the first pass would
  clear it. So it is self-healing.
- Missing evidence: none.
- Conclusion: resolved with answer. Safe, though the asymmetry between a setter
  outside the tagging gate and a clearer inside it is worth noting if a writer is
  ever added.
