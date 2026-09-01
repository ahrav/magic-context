# sel-protected-tags-not-read-from-module-config

## Discovery trigger

Task 6 asks which selection behaviour is configurable, what the defaults are, and
whether a misconfiguration can disable a safety-relevant pass silently. The lens
brief also asks to check both the config default and the shipped setup path,
because a prior pass found those disagreeing for a neighbouring subsystem. I
enumerated every selection parameter `apply_once` reads and looked for each one in
`config.rs`.

## Evidence trail

The parameter. `protected_tags` is "Number of newest active tag rows protected
from emergency reduction" (`transform.rs:687-688`), declared
`#[serde(default = "default_protected_tags")] pub protected_tags: usize`
(`:689-690`), with the factory at `:893-895` returning `20`.

Where it is read in the selection region:

- `newest_active_tag_block_ids(.., req.protected_tags)` (`transform.rs:4177-4182`),
  building `tag_window_protected_block_ids`, which becomes half of
  `protected_block_ids` (`:4193-4196`) and is passed to `SelectionContext` as
  `tag_window_protected_block_ids` (`:4253`). `selection.rs:207-210` uses it to
  answer whether a block is protected, and `:1284-1285` counts the supersession
  arcs it withholds.
- `protected_cutoff = age_basis_tag.saturating_sub(req.protected_tags as u64)`
  (`transform.rs:6318`), the caveman exclusion window.
- `protected_tags: req.protected_tags` in the hygiene inputs (`:5534`).
- `protected_tag_cutoff(active_tags, protected_tags)` (`:9514`), the Channel-2
  nudge cutoff.

So it gates reduction, caveman compression, and the nudge surface. It is
safety-relevant in the plain sense: raising it is how a user says "do not touch my
recent work".

The module's config does not have it. `McModuleConfig` (`config.rs:82-116`) has
23 fields; `protected_tags` is not one of them.
`grep -c protected_tags crates/mc-module/src/config.rs` returns `0`, so the string
does not appear in that file at all: no field, no parse, no default, no warning.

The same holds for `clear_reasoning_age`. Declared
`#[serde(default = "default_clear_reasoning_age")] pub clear_reasoning_age: u64`
(`transform.rs:696-697`) with the constant `DEFAULT_CLEAR_REASONING_AGE = 50`
(`:119`) and factory at `:861-863`. Read at `:10178`
(`Some(max_tag.saturating_sub(req.clear_reasoning_age))`) inside `tag_age_cutoff`,
which feeds `reasoning_clear_cutoff_with_tags` (`:4473-4474`) and therefore
`new_frozen_strip_units` (`:4482-4489`). `grep` finds it nowhere in `config.rs`.

The shipped paths diverge from each other.

**OpenCode.** `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts` sends
both: `protected_tags: deps.protectedTags ?? DEFAULT_PROTECTED_TAGS` (`:2031`,
and the same expression at `:1355`) and `clear_reasoning_age: deps.clearReasoningAge`
(`:2014`). So on this leg the user's configured value reaches the module.

**Claude Code.** `apply_claude_code_config_controls` (`lib.rs:173-193`) exists
precisely because this leg does not carry the controls. Its own comment says so:
"Claude Code does not carry these controls in its transform request. Route config
is daemon-owned and frozen at bind, so it is the only authority for this transport
leg" (`:181-182`). It then sets five fields:

```
request.auto_search_enabled = config.auto_search.enabled;              // :183
request.auto_search_score_threshold = config.auto_search.score_threshold; // :184
request.auto_search_min_prompt_chars = config.auto_search.min_prompt_chars; // :185
request.caveman_enabled = config.caveman.enabled;                      // :186
request.caveman_min_chars = config.caveman.min_size;                   // :187
```

plus the guidance override at `:190-192`. It does not set `protected_tags` and does
not set `clear_reasoning_age`. It could not, because `McModuleConfig` has neither.

So on the Claude Code leg the effective values are the serde defaults, 20 and 50,
regardless of what the user configured.

The documentation says the module should read them. `CONFIGURATION.md:165`:
"`protected_tags` | `number` (1–100) | `20` | Last N active tags immune from
immediate dropping." `CONFIGURATION.md:169`: "`clear_reasoning_age` | `number` |
`50` | Clear thinking/reasoning blocks older than N tags." The example config at
`:795` sets `"protected_tags": 10`. Nothing in either row marks them as
harness-only or OpenCode-only.

`config.rs` does have a mechanism for reporting an ignored key, and uses it for
five others: `warn_ignored_project_key` (`:576-583`) pushes
`"ignoring {pointer} from project tier; setting is user-tier only"`. It is called
for `/compaction/enabled` (`:521`) and four `prompt_surface` keys (`:548-567`). It
is not called for `protected_tags`, because `config.rs` does not know the key
exists.

## Failure scenario

A user working through Claude Code sets `"protected_tags": 60` in
`~/.config/cortexkit/magic-context.jsonc` because they want the last 60 tagged
items untouchable. The daemon loads the config, `merge_tiers` ignores the key
silently, `McModuleConfig` carries no such field,
`apply_claude_code_config_controls` cannot copy it, and the request's serde default
of 20 stands.

On the next force or emergency pass, `newest_active_tag_block_ids` protects 20 tag
positions instead of 60, and tags 21 through 60 become eligible for reduction. The
selector drops them. The rendered output replaces them with placeholders, and the
frozen `red:*` units make that permanent for the session, because a frozen unit
replays verbatim and `validate_reduction_monotonicity` (`:6813-6826`) forbids
re-supplying different bytes.

No warning is emitted. The user's configuration file is syntactically valid and
semantically documented. The only observable is that content they expected to be
protected is gone.

The `clear_reasoning_age` variant is milder but the same shape: a user who sets it
to 200 to keep reasoning around gets 50, and signed thinking blocks are cleared
earlier than configured.

## Timing windows and dependencies

None. The value is resolved at route bind and read on every pass. The condition
persists for the life of the configuration.

## What a test must construct

A config-to-effective-value round trip on the Claude Code leg. Build an
`McModuleConfig` from a user config that sets `protected_tags` to a non-default
value, bind a route with `SerializerProfile::ClaudeCodeAnthropic`, issue a
transform whose request omits `protected_tags`, and assert the effective value the
selection region used equals the configured one. The assertion needs a reader:
`SelectionContext.tag_window_protected_block_ids` size is an indirect proxy, and
`protected_tag_cutoff` (`:9514`) is a more direct one.

The existing tests are close but stop short.
`lib.rs:18123-18170` has three `apply_claude_code_config_controls` cases;
`:18142-18155` sets `configured.caveman.enabled = true` and
`configured.caveman.min_size = 900` and asserts
`default_request.caveman_enabled` and
`default_request.caveman_min_chars == 900`. Adding two lines asserting
`protected_tags` and `clear_reasoning_age` would be the minimal regression test,
and it would fail today.

## Investigation log

### Q: Is `protected_tags` deliberately host-owned?

- Sources examined: `config.rs:82-116` (the full field list),
  `grep -c protected_tags crates/mc-module/src/config.rs` (result 0),
  `lib.rs:173-193` in full, `CONFIGURATION.md:165`, `:169`, `:795`,
  `rust-mode-transform.ts:1355`, `:2031`, `pi-plugin/src/context-handler.ts:1060`
  and `:1089` (which discuss `protected_tags` as a project-config concern:
  "`.cortexkit/magic-context.jsonc` (different protected_tags, thresholds, ...)").
- Findings: The Pi plugin's comments treat `protected_tags` as an ordinary config
  key with per-project variation, and `CONFIGURATION.md` documents it as one. Both
  TypeScript legs resolve it themselves and send it. The Rust module's config
  simply does not model it. The most likely history is that the field was
  TypeScript-only when written, and the Claude Code leg (which routes through the
  daemon rather than through a TypeScript plugin) was added later without
  extending `McModuleConfig`.
- Missing evidence: no design note. `docs/` holds no transform specification; the
  part-4 scope map resolved that question at
  `_lenses/scope-map-and-risk-ranking.md:685-700`, so `CONFIGURATION.md` is the
  only external contract statement and it says the module should honour the key.
- Conclusion: needs human input. The gap is verified on both sides; whether it is
  a documentation bug or a code bug is a design decision.

### Q: Does any other selection parameter share this gap?

- Sources examined: every `req.<field>` read in the selection region
  (`transform.rs:4098-4260`, `:4435-4510`) checked against `McModuleConfig`'s
  field list.
- Findings: `smart_drops` is in the config (`config.rs:114` region) and reaches
  the selector through `ctx.smart_drops` (`lib.rs:8303`, consumed at
  `transform.rs:4255-4257`), so that one is wired. `auto_search_*`,
  `caveman_enabled`, and `caveman_min_chars` are in the config and are copied on
  the Claude Code leg. `protected_tags` and `clear_reasoning_age` are the two that
  are not.
- Missing evidence: `tool_present` and `todo_tool_present` are host verdicts by
  design and correctly absent from config; `apply_claude_code_config_controls`
  documents the `todo_tool_present` case at `:188-189`.
- Conclusion: resolved with answer. Exactly two selection parameters are
  unreachable from the module's own config.
