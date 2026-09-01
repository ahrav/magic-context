# dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list

## Discovery trigger

Task 7 asks to flag contract-versus-code disagreements with both sides cited.
`config.rs`'s own header states a per-leaf trust policy as an enumerated list,
which makes it checkable: read the list, then read the project-tier block, and
compare. The lists differ.

## Evidence trail

The stated policy. `config.rs:1-9`:

```
//! Thin mc-module JSONC config reader for autonomous historian firing.
//!
//! This intentionally reads user and project tiers directly instead of depending on a
//! daemon config plane. Per-leaf trust policy is enforced during the read: model choice
//! is user-tier only because it affects spend; project config may only raise the execute
//! threshold (fire less often), and may override trusted memory, auto-search, caveman, promotion,
//! and privacy settings. User-profile and historian budgets remain user-tier only. The Rust module
//! intentionally keeps stricter model-selection policy than the current TypeScript implementation
//! until both implementations are deliberately aligned.
```

The enumerated project-tier permissions are: raise the execute threshold, and
override memory, auto-search, caveman, promotion, and privacy.

The actual project-tier block, `config.rs:514-566`, leaf by leaf:

| Leaf | Line | In the header's list? |
| --- | --- | --- |
| `execute_threshold_percentage` (raise only) | `:515-519` | Yes |
| `compaction.enabled` | `:520` | Warns and ignores. Consistent |
| `memory.enabled` | `:521-523` | Yes ("memory") |
| `memory.auto_search.*` | `:524` | Yes ("auto-search") |
| `caveman_text_compression.*` | `:525` | Yes ("caveman") |
| `memory.injection_budget_tokens` | `:526-528` | Arguably, under "memory" |
| `memory.auto_promote` | `:529-534` | Yes ("promotion") |
| privacy gate | `:535-537` | Yes ("privacy") |
| `memory.budget_tokens` | `:538` | Warns and ignores. Consistent |
| `memory.user_profile_budget_tokens` | `:539` | Warns and ignores. Consistent |
| `historian.context_limit_tokens` | `:540` | Warns and ignores. Consistent |
| **`smart_drops`** | **`:541-543`** | **No** |
| **`dreamer.inject_docs`** | **`:544-549`** | **No** |
| **`temporal_awareness`** | **`:550-555`** | **No** |
| `prompt_surface.guidance_override_text` | `:556-560` | Warns and ignores. Consistent |
| `prompt_surface.guidance_override_path` | `:561-565` | Warns and ignores. Consistent |

Three leaves are applied from the project tier and named nowhere in the policy,
and a fourth (`memory.injection_budget_tokens`) is only arguably covered by the
word "memory" while being unbounded upward (see
`dec-a-memory-injection-budget-documented-range-has-no-implementing-code`).

Direction matters. Of the three unlisted leaves, two default to `true` and can only
be turned off by a project, which is a de-escalation:

- `inject_docs` defaults `true` (`config.rs:132`), documented `true`
  (`CONFIGURATION.md:501`).
- `temporal_awareness` defaults `true` (`config.rs:133`), documented `true`
  (`CONFIGURATION.md:650`).

One defaults `false` and can be turned **on** by a project:

- `smart_drops` defaults `false` (`config.rs:135`), documented `false`
  (`CONFIGURATION.md:752`).

And the documentation is explicit that the off default is a safety posture.
`CONFIGURATION.md:767`:

> **When to enable.** Turn it on if you run very long, edit-heavy sessions and
> want to reclaim more context without losing the agent's record of what it did.
> The default stays off while cache stability is being validated in the wild.
> Requires a restart to take effect.

What `smart_drops` gates. `config.rs:135` feeds `McModuleConfig.smart_drops`
(`:111`), which becomes `SelectionConfig.smart_drops` and gates the supersession
selector inside `select_reductions_with_outcome`: `selection.rs:1229` in the
`EmergencyForce` arm and `:1236` in the `Execute` arm, both spelled
`if cfg.smart_drops && ...`. Supersession is the selector that rewrites older
`edit`/`write` calls into `edit_marker` payloads and drops superseded arcs, which
changes the bytes served to the provider.

`CONFIGURATION.md:756-761` describes the classes it affects, including "Superseded
edits ... the newest edit stays in full and each older edit is compressed to a
marker". So a repository config can switch on a byte-changing reduction path whose
documentation says the default is off pending validation.

## Failure scenario

A user clones a repository that ships `.cortexkit/magic-context.jsonc` containing

```
{ "smart_drops": true }
```

The user has never enabled smart drops, has read `CONFIGURATION.md:767` and
decided to wait, and has read `config.rs`'s policy header (or its equivalent in
release notes) which does not list `smart_drops` as project-overridable.

On the next transform pass in that project, `config.rs:541-543` applies the project
value. `selection.rs:1236` admits the supersession selector. Older `edit` and
`write` calls in the tail are rewritten to `edit_marker` payloads. The served byte
sequence changes for reasons the user did not choose, in a path the documentation
describes as still being validated.

`temporal_awareness: false` and `inject_docs: false` from a project are the
de-escalating direction, so their failure mode is a missing overlay or a missing
`<project-docs>` block rather than an escalation. They are still outside the stated
policy and still silent.

## Timing windows and dependencies

None. The tiers are merged on every config resolution
(`config.rs:228-238`), and the project path is
`project_root.join(".cortexkit").join("magic-context.jsonc")` (`:229`), so the file
is picked up as soon as the project root is bound.

## What a test must construct

The policy is an enumerated list, so the test is an enumeration too. The existing
tests already cover the intended half:

- `config.rs:913-928` `compaction_enabled_defaults_true_and_is_user_tier_only`
- `config.rs:876-911` `rust_only_budget_leaves_are_user_tier_only_and_warn_when_project_supplies_them`
- `config.rs:930-970` `auto_search_and_caveman_config_follow_user_then_project_tiers`
- `config.rs:981-997` `docs_and_temporal_flags_follow_user_then_project_tiers`
- `config.rs:1096-1117` `historian_gates_follow_tiers_but_context_limit_remains_user_tier_only`

Note that `:981-997` pins `inject_docs` and `temporal_awareness` as project-tier
overridable, so the code's behaviour is deliberate and tested; the policy header is
the side that is out of date, or the behaviour is.

The missing assertion is the closed-set one: for a project value supplied for every
leaf of `McModuleConfig`, assert that exactly the documented set changes and every
other leaf either keeps the user value or produces a warning. Written as a table
test over leaf name, that is one test rather than one per leaf.

The `smart_drops` case additionally deserves its own assertion because it is the
one permissive direction: a project tier alone setting `smart_drops: true` with no
user value, asserting the resolved value.

## Investigation log

### Q: Is `smart_drops` intended to be project-overridable?

- Sources examined: `config.rs:6-7` (the allow-list, which omits it);
  `config.rs:467-469` (user tier) and `:541-543` (project tier), which are
  symmetric and therefore look deliberate; `CONFIGURATION.md:752` (default
  `false`) and `:767` (the "stays off while cache stability is being validated"
  rationale); `selection.rs:1229` and `:1236` (the gates).
- Findings: the code is symmetric and tested, which argues for deliberate. The
  header and `CONFIGURATION.md:767` argue that enabling it is a decision the user
  makes knowingly. Those two positions are in tension for a repository-supplied
  config, which the user does not author.
- Missing evidence: whether the TypeScript leg applies the same tiering. The
  repository has a `packages/plugin/src/config/project-security.ts` whose name
  suggests a per-leaf project policy exists there; reading it is outside 4f scope
  and would settle whether the two legs agree.
- Conclusion: needs human input. Either the header should name the three leaves or
  the project block should stop applying `smart_drops`.

### Q: Are the other two leaves harmful from a project tier?

- Sources examined: `config.rs:132-133` (both default `true`); the consumers,
  `inject_docs` gating the `<project-docs>` sub-block (`project_docs.rs` per the
  scope map at `:342`) and `temporal_awareness` gating the temporal gap overlay
  (`transform.rs:8172-8206` `temporal_gap_prefix`).
- Findings: a project can only turn them off, which removes content rather than
  adding it. `inject_docs: false` from a project means the repository declines to
  have its own `ARCHITECTURE.md` and `STRUCTURE.md` injected, which is a coherent
  thing for a repository to want.
- Missing evidence: none.
- Conclusion: resolved with answer. Both are outside the stated policy but neither
  is an escalation, so the record's impact statement rests on `smart_drops` and
  the memory budget.
