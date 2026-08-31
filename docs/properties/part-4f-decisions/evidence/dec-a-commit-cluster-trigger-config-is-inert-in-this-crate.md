# dec-a-commit-cluster-trigger-config-is-inert-in-this-crate

## Discovery trigger

Task 5 asks whether each documented key actually takes effect in this crate, and
warns that prior passes found four such keys inert. Verifying those four meant
enumerating every documented key that names behaviour `mc-module` implements. The
commit-cluster trigger is implemented entirely inside `boundary.rs`, so its
configuration keys should reach `config.rs`. They do not.

## Evidence trail

The documented contract. `CONFIGURATION.md:173` lists the block in the top-level
table:

> `commit_cluster_trigger` | `object` | See below | Controls the commit-cluster
> historian trigger.

and the expansion at `:237-238`:

> `enabled` | `boolean` | `true` | Enable commit-cluster based historian triggering.
>
> `min_clusters` | `number` | `3` | Minimum number of commit clusters in the
> unsummarized tail before historian fires. The tail must also contain at least
> one `trigger_budget` worth of tokens, where `trigger_budget = main_context ×
> execute_threshold × 5%` clamped to `[5K, 50K]`.

The decision that consumes it. `boundary.rs:850-855`:

```
if ctx.commit_cluster_trigger_enabled
    && chunk.commit_cluster_count >= ctx.min_commit_clusters
    && chunk.tokens >= trigger_budget
{
    return fire_with_progress(TriggerReason::CommitClusters, &boundary, progress.clone());
}
```

Both fields are on `TriggerContext` (`boundary.rs:263-266`) and its `Default`
supplies `true` and `DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER` (`:274-275`, constant
`3` at `:45`).

The wiring. The only production construction of `TriggerContext` is inside
`prepare_historian_fire`. `lib.rs:4962-4963`:

```
commit_cluster_trigger_enabled: DEFAULT_COMMIT_CLUSTER_TRIGGER_ENABLED,
min_commit_clusters: DEFAULT_MIN_COMMIT_CLUSTERS,
```

with the constants at `lib.rs:605` (`true`) and `:607` (`3`). Neither is
reassignable and neither reads configuration.

`config.rs` has no knowledge of the keys. `rg commit_cluster crates/mc-module/src/config.rs`
and `rg min_clusters crates/mc-module/src` both return nothing;
`McModuleConfig` (`config.rs:82-116`) has no corresponding field. The transform
request is also not a route: `rg min_commit_clusters crates/mc-module/src/transform.rs`
returns nothing, and the only other occurrences in the crate are inside `lib.rs`'s
test module at `:16500-16501`, `:16573-16574`, and `:16767-16768`.

So the documented defaults and the code defaults agree, `true` and `3` on both
sides, and only the configurability is fictional.

The documented conjunction is honoured. `derive_trigger_budget`
(`boundary.rs:338-346`) implements the documented formula exactly:
`TRIGGER_BUDGET_PERCENTAGE` is `0.05` (`:38`), `TRIGGER_BUDGET_MIN` is `5_000.0`
(`:39`), `TRIGGER_BUDGET_MAX` is `50_000.0` (`:40`), and the body is
`(context_limit * (threshold / 100.0) * 0.05).round().clamp(MIN, MAX)`. The
"must also contain" clause is the third conjunct at `boundary.rs:853`. That half of
the documentation is accurate.

## Failure scenario

A user runs long sessions in a repository with frequent commits. Their historian
fires often on the commit-cluster reason, each fire spending a model call and
replacing a span of raw conversation with generated summary text. They decide they
would rather the historian fire only on context pressure, read
`CONFIGURATION.md:237`, and write

```
{ "commit_cluster_trigger": { "enabled": false } }
```

`config.rs` never looks for the key, so `merge_tiers_with_warnings` returns without
touching anything and without a warning. `prepare_historian_fire` passes
`DEFAULT_COMMIT_CLUSTER_TRIGGER_ENABLED`, which is `true`. The trigger keeps
firing on commit clusters exactly as before.

The consequence is not cosmetic. The historian publish is the one path in the crate
that irreversibly substitutes model-generated text for the user's real
conversation, which is why the scope map ranks it first on damage
(`part-4-module/_lenses/scope-map-and-risk-ranking.md:475-480`). A user who
believes they have disabled one of the four ways it fires has not.

The `min_clusters` case is quieter: raising it to `10` to make the trigger rarer
has no effect, and the trigger continues at `3`.

## Timing windows and dependencies

None. The constants are compile-time and the context is rebuilt on every trigger
evaluation with the same values.

## What a test must construct

The divergence is provable without any session fixture: assert that a resolved
`McModuleConfig` carries the configured `commit_cluster_trigger` values, which
requires the field to exist. Stated as the property, the test asserts that for a
config containing the block, the `TriggerContext` built by
`prepare_historian_fire` reflects it.

A cheaper first assertion at the config layer: parse a config containing
`commit_cluster_trigger` and assert either a corresponding field on
`McModuleConfig` or a warning naming the key. That is the same shape as the
conformance check part-4b proposed for its four keys
(`part-4b-transform/existing-checks.md:571-574`).

The behavioural end of it needs a tail with at least three assistant commit
clusters and one `trigger_budget` of tokens. `lib.rs:16495-16501` already builds a
`TriggerContext` with `trigger_budget: Some(4_000.0)` and `min_commit_clusters: 2`,
and `boundary.rs`'s golden fixture suite drives `commit_cluster_count` through
`ChunkBuilder` (`:1682`), so both halves of the fixture exist; only the config
path is missing.

## Investigation log

### Q: Does any harness leg carry these controls in the transform request instead?

- Sources examined: `transform.rs:660-855` (`TransformRequest` and its ten serde
  defaults) searched for `commit`, `cluster`, and `min_clusters`: no field;
  `lib.rs:173-194` (`apply_claude_code_config_controls`, the function that exists
  specifically because the Claude Code leg does not carry controls in its request)
  sets `auto_search_*` and `caveman_*` at `:183-187` and nothing else;
  `lib.rs:4950-4964`, the whole `TriggerContext` construction.
- Findings: no request field exists on any leg, and the one function whose job is
  to push module config into a request does not push these. So the keys are inert
  on every transport.
- Missing evidence: whether the TypeScript leg evaluates its own commit-cluster
  trigger and honours the config there. If it does, the key works in TypeScript
  mode and silently stops working in Rust mode, which is a worse shape than being
  uniformly inert.
- Conclusion: unresolved, needs a sweep of the TypeScript trigger, which is
  outside 4f scope. The record's guarantee is about this crate and does not depend
  on the answer.

### Q: Do the documented and code defaults actually agree?

- Sources examined: `CONFIGURATION.md:237-238` (`true`, `3`); `lib.rs:605`
  (`DEFAULT_COMMIT_CLUSTER_TRIGGER_ENABLED: bool = true`); `lib.rs:607`
  (`DEFAULT_MIN_COMMIT_CLUSTERS: usize = 3`); `boundary.rs:45`
  (`DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER: usize = 3`); `boundary.rs:2226-2227`,
  which asserts the boundary constant against a golden value.
- Findings: yes, all three agree on `3` and both on `true`. Note that the constant
  is duplicated between `lib.rs:607` and `boundary.rs:45` with different names and
  the same value, so a future change has two places to miss.
- Missing evidence: none.
- Conclusion: resolved with answer. The defaults match; only configurability is
  absent. The duplicated constant is worth mentioning to synthesis but is not the
  record's subject.
