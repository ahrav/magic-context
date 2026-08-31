# dec-a-model-chain-dedup-is-adjacent-only

## Discovery trigger

Task 2 asks about boundary behaviour per unit, and task 3 asks for algebraic
properties the domain actually claims. `config.rs:571` is a bare
`cfg.model_chain.dedup()` at the end of the merge, which asserts a claim: the
resolved chain has no duplicates. `Vec::dedup` does not deliver that claim, and the
comment thirty lines above explains why the author cares about chain hygiene.

## Evidence trail

The call. `config.rs:568-572`, the tail of `merge_tiers_with_warnings`:

```
cfg.execute_threshold_percentage = cfg
    .execute_threshold_percentage
    .clamp(1.0, MAX_EXECUTE_THRESHOLD_PERCENTAGE);
cfg.model_chain.dedup();
(cfg, warnings)
```

`Vec::dedup` removes consecutive repeated elements only. It is the counterpart of
Unix `uniq`, not of a set insertion. `["a", "b", "a"]` is unchanged by it;
`["a", "a", "b"]` becomes `["a", "b"]`. There is no preceding sort, and sorting would
be wrong here because the chain is an ordered preference list.

How a non-adjacent duplicate arises. The module-model branch,
`config.rs:390-409`:

```
let module_model = user
    .pointer("/historian/module_model")
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|s| !s.is_empty());
if let Some(model) = module_model {
    cfg.model_chain.push(model.to_string());
    if let Some(fallbacks) = user
        .pointer("/historian/module_fallback_models")
        .and_then(Value::as_array)
    {
        cfg.model_chain.extend(
            fallbacks
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned),
        );
    }
}
```

The primary is pushed first, then the fallback array is appended in order. So a
config of

```
{ "historian": { "module_model": "a", "module_fallback_models": ["b", "a"] } }
```

produces `["a", "b", "a"]`, and `dedup()` leaves it alone. The plugin-key branch at
`:410-429` has the identical shape with `/historian/model` and
`/historian/fallback_models`, so the same holds there.

`dedup()` does catch the adjacent case, which is the one a user is most likely to
write by accident: `module_fallback_models: ["a", "c"]` with `module_model: "a"`
produces `["a", "a", "c"]` and collapses to `["a", "c"]`. So the call is not
useless; it is just narrower than it reads.

What the chain is for. `historian.rs:898` declares
`pub model_chain: &'a [String]`, and the firing loop iterates it as ordered
attempts. `historian.rs:1249`:

```
if request.model_chain.is_empty() {
```

and `:1256`:

```
for (index, model) in request.model_chain.iter().enumerate() {
```

with the remaining chain sliced as a candidate list for eligibility checks at
`:1300`, `:1380`, and `:1443` (`has_eligible_model(&request.model_chain[index + 1..],
&auth_blocked_providers)`). So position `i` and position `j` holding the same model
means the same model is attempted twice in one firing.

Why the author cares. `config.rs:384-389`, the comment immediately above the
module-model branch:

```
// while this module drives llm-runner, whose catalog uses canonical ids
// ("google/gemini-3.5-flash" + a vault auth method). When module_model is
// present it REPLACES the plugin-namespace chain entirely (no mixing — a
// half-translated chain would burn permanent-classified advances every fire);
// when absent, fall back to the plugin keys so single-namespace setups keep
// working with one set of keys.
```

The concern is spending advances on chain entries that cannot succeed. A duplicate
entry has the same shape of cost: if the model failed on its first attempt for a
reason that is not transient, the second attempt spends another advance for the same
outcome.

## Failure scenario

A user migrating to the module-model namespace writes both the primary and a
fallback list, and includes the primary in the list because that is how many
retry configurations read:

```
{
  "historian": {
    "module_model": "google/gemini-3.5-flash",
    "module_fallback_models": ["anthropic/claude-haiku-4-6", "google/gemini-3.5-flash"]
  }
}
```

The resolved chain is
`["google/gemini-3.5-flash", "anthropic/claude-haiku-4-6", "google/gemini-3.5-flash"]`.
`dedup()` changes nothing. On a firing where the first model fails for a durable
reason, for example a model id that the vault auth method cannot serve, the
historian tries Haiku and then tries the same Gemini id again.

The failure is not data loss, and the eligibility checks at `historian.rs:1443`
would exclude an auth-blocked provider on the later slice, so the cost is bounded.
The point is that the code asserts a no-duplicate invariant it does not establish,
in a list whose entries cost money and whose author documented that cost.

## Timing windows and dependencies

None. The chain is resolved once per config resolution and consumed as a slice.

## What a test must construct

One assertion, in the shape of `config.rs:1119-1137`
(`module_model_replaces_plugin_chain_entirely`), which already builds the exact
config shape:

```
let user = serde_json::json!({
    "historian": {
        "module_model": "a",
        "module_fallback_models": ["b", "a"]
    }
});
let cfg = merge_tiers(Some(&user), None);
// today: ["a", "b", "a"]
assert_eq!(cfg.model_chain, vec!["a", "b"]);
```

The adjacent case is worth pinning too, because it currently works and a future
change to a set-based dedup must preserve order:

```
let user = serde_json::json!({
    "historian": { "module_model": "a", "module_fallback_models": ["a", "c"] }
});
assert_eq!(merge_tiers(Some(&user), None).model_chain, vec!["a", "c"]);
```

## Investigation log

### Q: Is a repeated attempt actually harmful?

- Sources examined: `config.rs:384-389` (the "burn permanent-classified advances
  every fire" comment); `historian.rs:1249`, `:1256`, `:1300`, `:1380`, `:1443`;
  `historian.rs:2203` (`model_chain: models`, where the request is assembled).
- Findings: the comment is about namespace mixing, not duplication, so it
  establishes that the author treats wasted advances as a real cost without
  establishing that duplication triggers one. Whether the second attempt is wasteful
  depends on whether the first failure was transient. For a rate-limit failure a
  retry is sensible; for an unknown-model failure it is not. The chain does not
  distinguish, and the eligibility filter at `:1443` handles only auth-blocked
  providers.
- Missing evidence: the failure classification inside the firing loop, which is 4a
  scope (`historian.rs` is 4a per the scope map at `:502`). If the loop already
  skips a model that failed durably, the duplicate is harmless.
- Conclusion: needs human input. Either `dedup()` should be a full deduplication
  that preserves first occurrence, or the call should be removed and the ordered
  list documented as allowing repeats deliberately. The present state asserts the
  stronger property and delivers the weaker one.

### Q: Can the project tier introduce a duplicate?

- Sources examined: `config.rs:390-429` (both model branches are inside the
  `if let Some(user)` block at `:380`); the project block at `:514-566`, which has
  no model handling at all; `config.rs:1166-1178`
  (`module_model_is_user_tier_only`), which proves a project value is discarded.
- Findings: no. Only the user tier contributes to `model_chain`, so a duplicate has
  to come from one file. That also means the silent drop of a project-tier model
  value is a separate observation, recorded in the lens file's contract-vs-code
  leads rather than here.
- Missing evidence: none.
- Conclusion: resolved with answer. Reachability is `explicit-config-only` via the
  user tier, and the default chain is empty so the property holds trivially without
  configuration.
