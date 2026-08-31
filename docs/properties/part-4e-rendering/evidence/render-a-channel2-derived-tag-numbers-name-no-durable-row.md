# render-a-channel2-derived-tag-numbers-name-no-durable-row

## Discovery trigger

Tracking every place a tag number is assigned turned up two synthetic numbering
sites beyond the durable mint. One of them, `active_tags_for_channel2`, feeds text
that reaches the agent.

## Evidence trail

All references read back at `HEAD` `e447c927`, in
`crates/mc-module/src/transform.rs`.

### The derived numbering

`active_tags_for_channel2` (`:9282-9313`) first tries the stored path:

```
9289:    let stored = active_tags_for_nudge(core, meta, projection, tag_rows, mutation_exempt_mid);
9290:    if !stored.is_empty() {
9291:        return stored;
9292:    }
```

`active_tags_for_nudge` (`:9248-9277`) only emits an entry when a `mc_tags` row
exists for the block (`:9267`), so an empty result means no durable row survives
the tail filter. The fallback then numbers blocks itself (`:9293-9312`):

```
9294:    let mut next_tag = 1i64;
...
9305:        derived.push(ActiveTagForNudge {
9306:            tag_number: next_tag,
...
9310:        next_tag = next_tag.saturating_add(1);
```

The comment above it states the intent (`:9279-9281`): "Reuse the durable CC tag
accounting when present, and derive the same accounting basis from live CK text
for profiles that historically did not mint overlay tags. The latter keeps
OpenCode host directives useful without enabling CC-only prompt overlays."

So the fallback is deliberate, and its own justification names the condition under
which no durable row exists.

### The derived numbers reach agent-visible bytes

`channel2_pressure` (`:9380-9405`) calls `active_tags_for_channel2` at
`:9389-9395` and passes the result to `oldest_channel2_hint` at `:9396`.

`oldest_channel2_hint` (`:9534-9547`) filters to `kind == "tool_result"`, applies
the protected cutoff, requires `token_count >= 100`, takes four, and maps each to
`(tag.tag_number, "tool")`.

`build_channel2_reminder_text` (`:9549-9555`) and its host wrapper
`build_channel2_host_reminder` (`:9557-9560`) embed
`format_reclaimable_hint(hint)`.

`format_reclaimable_hint` (`:9866-9876`) renders the numbers:

```
9872:        .map(|(tag, name)| format!("§{tag}§ {name}"))
...
9875:    format!("\noldest reclaimable: {rendered}.")
```

So a directive can say `oldest reclaimable: §1§ tool · §3§ tool.` with `1` and `3`
assigned by `next_tag` in this process, not by `mc_tags`.

### Which profile takes that route

`channel2_directives` (`:9337-9378`) dispatches on the serializer profile. The
`OpencodeAiSdk` arm (`:9347-9365`) builds `HostDirectives` with
`build_channel2_host_reminder`. The `ClaudeCodeAnthropic` arm (`:9366-9375`) goes
through `claude_code_channel2_directive` (`:9435-9503`), which builds its text with
`build_channel2_reminder_text` at `:9490` — the same hint formatter. Everything
else returns `Channel2DirectiveOutput::default()` (`:9376`).

So both live profiles can render a derived number; the OpenCode profile is the one
the comment says the fallback exists for.

### The overlay does not render matching prefixes

`apply_tag_overlay_to_message` only applies a `§N§` prefix when
`overlay.tag_by_block_id` has an entry for the block (`:8234`), and
`tag_overlay_state` builds that map from durable `McTagRow`s (`:8148-8151`). The
derived numbers never enter it. So on a pass that takes the fallback, the served
array contains no `§N§` at all, and the directive still names them.

### The third synthetic numbering, for completeness

`tag_rows_for_hygiene` with `derive_when_empty` (`:9224-9243`) does the same thing
for the hygiene measurement basis, numbering taggable blocks `1..n` at `:9232`.
Those rows feed token accounting rather than rendered text, so they do not reach
the agent directly, but they are a third numbering authority and they are numbered
by a different rule than `active_tags_for_channel2` — over all taggable projection
blocks rather than over unfrozen tail blocks.

## Failure scenario

An OpenCode session accumulates 60k tokens of unreduced tool output with no
durable tags — the state the fallback comment describes. Channel-2 pressure is
due, so a host reminder is emitted saying `~60k tokens of tool output remain
unreduced ... oldest reclaimable: §1§ tool · §2§ tool.` The agent calls
`ctx_reduce` with `1-2`. The reduce surface resolves tag numbers against
`mc_tags`, where either nothing exists — so the call no-ops and the agent has been
sent on an errand it cannot complete, and will be nudged again — or rows exist
whose numbers happen to collide with `1` and `2` and point at entirely different
blocks, in which case content the agent never saw is reduced.

## Timing windows and dependencies

No temporal window. The dependency is a cross-part one: the impact turns on what
`ctx_reduce` does with an unresolvable tag number, which is `lib.rs`'s facade
surface and sub-part 4d's scope.

## What a test must construct

1. A projection with three tool results of at least 100 estimated tokens each, no
   `mc_tags` rows, `serializer_profile = "opencode-aisdk"`, and a
   `TailHygieneBaseline` whose effective `(u, t)` clears `CHANNEL2_FLOOR_TOKENS`
   and `CHANNEL2_SEVERITY_THRESHOLD` (`tail_hygiene.rs:17-18`).
2. Call the Channel-2 path and assert the emitted directive text contains a
   `§N§`.
3. Assert every `N` in that text has a `mc_tags` row for this session. That
   assertion fails today, which is the finding.
4. Coverage form, independent preconditions only: observe a pass in which
   `active_tags_for_nudge` returned empty **and** `channel2_pressure` reported
   `due`. Both are observable without knowing what the agent does next.

## Investigation log

### Q: Does `ctx_reduce` reject an unresolvable tag number?

- Sources examined: identified `parse_tag_range_string` at
  `crates/mc-module/src/lib.rs:15165-15210` and `handle_ctx_reduce_facade` at
  `:10482-10588` from the Part 4 region map; did not read them, because both are
  sub-part 4d's assigned scope and this pass must not re-derive another part's
  material.
- Findings: none beyond location.
- Conclusion: unresolved, needs 4d. The record stands on the numbering divergence,
  which is verified, not on a demonstrated wrong reduction.

### Q: Can the Claude Code profile also render a derived number?

- Sources examined: `transform.rs:9366-9375`, `:9435-9503`, `:9483`, `:9490`.
- Findings: yes. `claude_code_channel2_directive` calls `channel2_pressure` at
  `:9483` and formats with `build_channel2_reminder_text` at `:9490`, so the same
  fallback applies. In practice a Claude Code session with `tagging_active` will
  have durable rows, so `active_tags_for_nudge` is unlikely to be empty; but
  nothing in the code restricts the fallback to OpenCode despite the comment
  saying that is its purpose.
- Missing evidence: none.
- Conclusion: resolved with answer — both profiles can reach it; only OpenCode is
  the documented intent.

### Q: Are the derived numbers stable across passes?

- Sources examined: `transform.rs:9293-9312`.
- Findings: they are a positional count over the filtered projection blocks in
  projection order, so they are stable for a fixed tail and shift by one for every
  block added or removed ahead of them. So the same block can be `§2§` on one pass
  and `§3§` on the next.
- Missing evidence: none.
- Conclusion: resolved with answer — not stable across tail changes, which makes a
  cross-turn reduce request based on them additionally unsafe.
