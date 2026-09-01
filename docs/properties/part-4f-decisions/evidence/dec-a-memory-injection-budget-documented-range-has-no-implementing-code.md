# dec-a-memory-injection-budget-documented-range-has-no-implementing-code

## Discovery trigger

Task 5 asks for every configuration key in scope with its default, where the
default is defined, and whether the documented default matches the code default.
Task 6 asks whether an out-of-range value is rejected, clamped, or silently
accepted. Working the key table for `config.rs` produced a match on the default
and a miss on the range, in a key that the project tier can write.

## Evidence trail

The documented contract. `CONFIGURATION.md:591`, inside the `memory` table:

> `injection_budget_tokens` | `number` (500–20000) | `4000` | Token budget for
> memory injection into `<session-history>`.

The default matches. `config.rs:20-22`:

```
/// Default token budget for project-memory injection. This is the twin of
/// `packages/plugin/src/config/schema/magic-context.ts` and must stay at 4,000 tokens.
pub const DEFAULT_MEMORY_BUDGET_TOKENS: f64 = 4_000.0;
```

used in `McModuleConfig::default` at `:130`.

The range does not. There are two parse sites and both apply the same asymmetric
floor and no ceiling.

User tier, `config.rs:441-445`:

```
if let Some(budget) = number_at(user, "/memory/injection_budget_tokens") {
    cfg.memory_budget_tokens = budget.max(1.0);
} else if let Some(budget) = number_at(user, "/memory/budget_tokens") {
    cfg.memory_budget_tokens = budget.max(1.0);
}
```

Project tier, `config.rs:526-528`:

```
if let Some(budget) = number_at(project, "/memory/injection_budget_tokens") {
    cfg.memory_budget_tokens = budget.max(1.0);
}
```

`.max(1.0)` is the only bound. `500` is not enforced, `20000` is not enforced, and
`number_at` (`:631-636`) accepts any finite `f64`, so a fractional or enormous
value passes.

The contrast with the neighbouring leaf is instructive. The user-profile budget
is user-tier only and the project tier is told so.
`config.rs:452-454` parses it on the user tier and `:539` warns on the project
tier:

```
warn_ignored_project_key(project, "/memory/user_profile_budget_tokens", &mut warnings);
```

So the author distinguished the two budgets deliberately: the injection budget is
project-writable, the user-profile budget is not. The file header states the
policy at `:6-7`: "User-profile and historian budgets remain user-tier only."

Where the value lands. `lib.rs:8293`:

```
memory_budget_tokens: binding.config.memory_budget_tokens,
```

That is the bind-time module config with no request override, so the value takes
effect on every harness leg. Inside the transform it is a trim ceiling.
`transform.rs:2657`:

```
trim_claims_to_budget(claims, ctx.memory_budget_tokens, estimate_tokens)
```

and it is threaded to the `m0` composition inputs at `:3024`, `:4583`, `:4686`,
`:4873`, and `:4919`. Raising it means more mirrored-claim and memory bytes inside
the frozen `m0` baseline, which every later pass replays verbatim.

## Failure scenario

A repository ships `.cortexkit/magic-context.jsonc` containing

```
{ "memory": { "injection_budget_tokens": 200000 } }
```

either because someone wanted "all the memory" or because a value was copied from
a different unit. `config.rs:526-528` accepts `200000.0`. On the next transform
pass, `trim_claims_to_budget` is handed a ceiling far above the whole context
window, so it trims nothing. The `m0` baseline grows to hold every claim, the
usable window shrinks, and because `m0` is frozen between HARD folds the inflated
block is replayed on every subsequent pass rather than reconsidered.

The documentation told the author that `20000` was the maximum, so nobody looking
at the config file would suspect the value is honoured. There is no warning, and
`emit_warnings` (`config.rs:275-279`) has nothing to print because no warning was
pushed.

The low end is milder but also silent: `injection_budget_tokens: 10` becomes `10`,
not `500`, and the memory block trims to almost nothing.

## Timing windows and dependencies

None. The value is resolved at route bind (`lib.rs:4427-4436`) and read from the
binding on each pass at `lib.rs:8293`. It is stable for the life of the config
file's mtime.

## What a test must construct

Two assertions in the existing tier-merge style. `config.rs:851-874` is the
closest existing shape, `memory_injection_budget_uses_standard_key_and_deprecated_user_fallback`.

1. `merge_tiers_with_warnings(None, Some(&json!({"memory": {"injection_budget_tokens":
   200000}})))` and assert either `memory_budget_tokens == 20000.0` or a warning
   naming `/memory/injection_budget_tokens`.
2. The same with `10` and assert `500.0` or a warning.

Both are single-expression tests against a function that already returns the
warning vector (`config.rs:373-376`, `:572`).

An end-to-end assertion is possible but not necessary to establish the defect:
build a producer context with a large `memory_budget_tokens` and assert that
`trim_claims_to_budget` retains every claim. That belongs to 4b's `m0`
composition material rather than here.

## Investigation log

### Q: Is the project tier supposed to be able to write this key at all?

- Sources examined: `config.rs:6-7` (the header's allow-list: "may override
  trusted memory, auto-search, caveman, promotion, and privacy settings. User-profile
  and historian budgets remain user-tier only"); `:526-528` (project parse);
  `:539` (the user-profile budget's project-tier warning); `:538` (the deprecated
  `/memory/budget_tokens` project-tier warning); `CONFIGURATION.md:591`, which
  carries no user-only marker for this key.
- Findings: the header's phrasing is compatible with the injection budget being
  project-writable, because it names only the user-profile and historian budgets
  as user-tier. So the tiering is intentional. The missing range is a separate
  question from the tiering.
- Missing evidence: none needed for the record. The record's guarantee is about
  the range, not the tier.
- Conclusion: resolved with answer. The tiering is deliberate; the absent range is
  the defect. Reachability is `explicit-config-only` because the key must be
  present in a config file for the divergence to have any effect; the default
  `4000` is inside the documented range.

### Q: Does the deprecated key share the missing range?

- Sources examined: `config.rs:443-445` (the `/memory/budget_tokens` fallback,
  user tier only), `:446-451` (its deprecation warning), `:538` (the project-tier
  ignore).
- Findings: yes, the same `.max(1.0)` applies. The deprecated key does at least
  produce a warning naming itself, which is the one place in this area where the
  caller is told something.
- Missing evidence: none.
- Conclusion: resolved with answer. The record's check covers both keys because
  both write the same field, and the assertion is on the resolved field.
