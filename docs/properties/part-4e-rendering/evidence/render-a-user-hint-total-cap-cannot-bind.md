# render-a-user-hint-total-cap-cannot-bind

## Discovery trigger

Task: establish what bounds the rendered size and what is dropped first when a
budget binds. The user-hint path has an explicit total cap plus a `debug_assert`
on it, which looked like the clearest binding budget in 4e. Computing the maximum
composed size showed the cap sits well above it.

## Evidence trail

All references read back at `HEAD` `e447c927`, in
`crates/mc-module/src/transform.rs`.

### The caps

```
113: const USER_HINT_FRAGMENT_CHAR_CAP: usize = 80;
114: const USER_HINT_TOTAL_CHAR_CAP: usize = 800;
117: const USER_HINT_RESULT_LIMIT: usize = 3;
```

### The composition

`render_user_hint` (`:9084-9117`):

```
9088:    let lines = results
9089:        .iter()
9090:        .take(USER_HINT_RESULT_LIMIT)
9091:        .map(|result| {
9092:            let fragment =
9093:                crate::caveman::compress(&result.snippet, crate::caveman::CavemanLevel::Ultra);
9094:            format!(
9095:                "- {}",
9096:                one_line_fragment(&fragment, USER_HINT_FRAGMENT_CHAR_CAP)
9097:            )
9098:        })
...
9104:    let header = if lines.len() == 1 {
9105:        "Your memory may contain 1 related fragment:".to_string()
9106:    } else {
9107:        format!("Your memory may contain {} related fragments:", lines.len())
9108:    };
9109:    let footer = "If the fragments above seem relevant to the current request, you may run ctx_search to retrieve full context. Otherwise ignore.";
9110:    let body = [header, lines.join("\n"), footer.to_string()].join("\n");
9111:    let wrapped = format!("<ctx-search-hint>\n{body}\n</ctx-search-hint>");
...
9114:    let wrapped = truncate_hint_to_total_cap(&wrapped, USER_HINT_TOTAL_CHAR_CAP);
9115:    debug_assert!(utf16_len(&wrapped) <= USER_HINT_TOTAL_CHAR_CAP);
```

`one_line_fragment` (`:9130-9140`) guarantees each fragment is at most
`limit` UTF-16 units: it returns the normalized string when
`utf16_len(&normalized) <= limit` (`:9132-9134`), otherwise
`utf16_prefix(&normalized, limit - 1)` plus one `…` (`:9135-9139`), which is
`limit` units.

### The arithmetic

Measured in UTF-16 code units, which is what `utf16_len` (`:9064-9066`) counts:

| Component | Units |
| --- | --- |
| `"<ctx-search-hint>\n"` | 18 |
| header, worst case `"Your memory may contain 3 related fragments:"` | 44 |
| the `\n` from `[header, .., ..].join("\n")` | 1 |
| three lines of `"- "` + 80 | 3 × 82 = 246 |
| two `\n` from `lines.join("\n")` | 2 |
| the second `\n` from the outer join | 1 |
| footer | 127 |
| `"\n</ctx-search-hint>"` | 19 |
| **total** | **458** |

458 against a cap of 800. There is no input that raises it: `take(3)` bounds the
line count, `one_line_fragment` bounds each line, and the header, footer and
wrapper are constants apart from the line count digit, which is at most one
character for a maximum of three.

So the branch at `:9120` — `if utf16_len(wrapped) <= limit { return
wrapped.to_string(); }` — always returns early, and the body of
`truncate_hint_to_total_cap` (`:9123-9127`) is dead. The `debug_assert!` at
`:9115` is trivially satisfied for the same reason.

### No other caller

`grep -n "truncate_hint_to_total_cap" crates/mc-module/src/transform.rs` returns
its definition at `:9119` and the single call at `:9114`.

### Reachability of the surrounding path

`render_user_hint` is called from `:8817` inside `maybe_decide_live_user_hint`
(`:8766` onward), which `apply_once` calls at `:4442` under
`if auto_search_active` (`:4441`). `auto_search_active` is
`!req.is_subagent && req.auto_search_enabled` (`:3519`).

`auto_search_enabled` defaults to `true` on the wire:
`default_auto_search_enabled` at `:865-867` returns `true`, wired into the field's
serde default at `:713`, and into the wire struct's at `:927`. The shipped
producer sets it explicitly:
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2010` is
`auto_search_enabled: deps.autoSearch?.enabled ?? true`. That is the basis for the
`default-production` label.

## Failure scenario

Not a live defect. Two consequences:

1. A code path and a `debug_assert` that have never executed and cannot. Any bug
   in `truncate_hint_to_total_cap` — for instance the `saturating_sub` at `:9125`
   underflowing to a zero body limit for a small `limit` — is invisible.
2. A latent trap. Raising `USER_HINT_RESULT_LIMIT` past 8, or raising
   `USER_HINT_FRAGMENT_CHAR_CAP` past roughly 200, activates a path with no
   coverage on its first production pass. Because the hint is appended to a
   provider-visible user block (`append_user_hint_to_block`, `:8345-8354`), a bug
   there lands in bytes that get frozen into the prefix.

## Timing windows and dependencies

None. This is arithmetic over compile-time constants.

## What a test must construct

1. The `unreachable` check: instrument the `utf16_len(wrapped) > limit` path of
   `truncate_hint_to_total_cap` and assert it is never taken across the campaign.
2. A guard that fails loudly if the constants drift: assert
   `18 + 44 + 1 + USER_HINT_RESULT_LIMIT * (USER_HINT_FRAGMENT_CHAR_CAP + 2) +
   (USER_HINT_RESULT_LIMIT - 1) + 1 + 127 + 19 <= USER_HINT_TOTAL_CHAR_CAP`, so
   the day someone raises a limit the relationship is restated rather than
   silently inverted. If the intent is that the total cap *should* be able to bind,
   that assertion is the place to invert.
3. Direct unit coverage of `truncate_hint_to_total_cap` with a hand-built
   oversized input, since production cannot supply one. In particular
   `limit < utf16_len(open) + utf16_len(close) + 1`, where `body_limit` saturates
   to 0 and the function returns `"<ctx-search-hint>\n…\n</ctx-search-hint>"`.

## Investigation log

### Q: Can `caveman::compress` produce a fragment longer than the cap?

- Sources examined: `crates/mc-module/src/caveman.rs:1-30` (the header and
  `CavemanLevel`), `transform.rs:9092-9097`.
- Findings: irrelevant to the bound. Whatever `compress` returns is passed through
  `one_line_fragment`, which caps it at 80 UTF-16 units. `compress` is a
  shortening transform, so it cannot grow the input either, but the cap does not
  depend on that.
- Missing evidence: none.
- Conclusion: resolved with answer — the fragment cap is unconditional.

### Q: Is `truncate_hint_to_total_cap` reachable from anywhere else?

- Sources examined: grep across `crates/mc-module/src`.
- Findings: one definition (`:9119`), one call (`:9114`).
- Missing evidence: none.
- Conclusion: resolved with answer — no other caller, so the path is dead
  everywhere.

### Q: Is the header's one-fragment wording shorter, and does it change the bound?

- Sources examined: `transform.rs:9104-9108`.
- Findings: with one line the header is 43 units and there is one line rather than
  three, so the total is far below the three-line worst case. The maximum is the
  three-line form.
- Missing evidence: none.
- Conclusion: resolved with answer — 458 is the maximum.
