# dec-a-model-key-lookup-walk-has-two-implementations-that-disagree

## Discovery trigger

Task 3 asks for algebraic and metamorphic properties the domain actually claims,
and task 7 asks to flag contract-versus-code disagreements. `config.rs:113-114`
claims a *shared* resolution walk, and `CONFIGURATION.md:70` states that walk once
as a single contract for two different per-model config surfaces. A claim that two
consumers behave identically is a differential property, so I read both.

## Evidence trail

The documented contract, stated once for the whole system.
`CONFIGURATION.md:70`:

> Model keys use the same progressive, case-sensitive lookup walk as `cache_ttl`:
> exact `provider/model` keys, less-specific model variants, then the literal
> `provider/*` wildcard and `default`. The first slash separates the provider;
> additional slashes remain part of the model ID. Missing provider/model
> components fall back to `default`.

Four steps: exact, less-specific variants, `provider/*` wildcard, `default`.

The code claims the walk is shared. `config.rs:112-115`:

```
pub cache_ttl: String,
/// Per-model TTL overrides from the object config shape. Resolution uses the
/// shared exact, bare, dash-stripped, provider-wildcard, then default walk.
pub cache_ttl_by_model: std::collections::BTreeMap<String, String>,
```

**Implementation one**, `config.rs:159-200`, `resolve_cache_ttl_with_provenance`:

```
if let Some(ttl) = model_key.and_then(|key| self.cache_ttl_by_model.get(key)) {
    return explicit(ttl);
}
let Some((provider, mut model_id)) = model_key.and_then(|key| key.split_once('/')) else {
    return default();
};
if provider.is_empty() || model_id.is_empty() {
    return default();
}

loop {
    let exact = format!("{provider}/{model_id}");
    if let Some(ttl) = self.cache_ttl_by_model.get(&exact) { return explicit(ttl); }
    if let Some(ttl) = self.cache_ttl_by_model.get(model_id) { return explicit(ttl); }

    let Some(last_dash) = model_id.rfind('-').filter(|index| *index > 0) else { break };
    model_id = &model_id[..last_dash];
}

if let Some(ttl) = self.cache_ttl_by_model.get(&format!("{provider}/*")) {
    return explicit(ttl);
}
default()
```

All four documented steps are present: the whole-key exact check at `:171`, the
qualified and bare variants inside the loop at `:182-188`, the dash-stripping at
`:190-193`, the `provider/*` wildcard at `:196`, and the default at `:199`. It also
carries provenance, so a caller can tell an explicit match from a fallback
(`:143-152`).

**Implementation two**, `scheduler.rs:849-870`, `model_key_lookup_order`:

```
fn model_key_lookup_order(model_key: &str) -> Vec<String> {
    let slash = model_key.find('/');
    let provider = slash.map_or("", |idx| &model_key[..idx]);
    let mut model_id = slash.map_or(model_key, |idx| &model_key[idx + 1..]);
    let mut keys = Vec::new();

    while !model_id.is_empty() {
        if !provider.is_empty() {
            keys.push(format!("{provider}/{model_id}"));
        }
        keys.push(model_id.to_string());
        let Some(last_dash) = model_id.rfind('-') else { break };
        if last_dash == 0 { break }
        model_id = &model_id[..last_dash];
    }
    keys
}
```

Exact and dash-stripped variants: present. `provider/*` wildcard: **absent**. Its
two consumers fall straight from the candidate list to `"default"`:
`resolve_percentage_match` (`:818-829`) ends with `values.get("default").copied()`,
and `resolve_tokens_match` (`:832-847`) ends with
`tokens.values.get("default").map(...)`.

The two implementations agree on the dash-stripping termination condition even
though they spell it differently: `config.rs:190` uses
`rfind('-').filter(|index| *index > 0)`, and `scheduler.rs:865-868` uses `rfind('-')`
followed by `if last_dash == 0 { break }`. Both refuse to strip a leading dash and
both shrink `model_id` monotonically, so both terminate.

They differ in a second, smaller way. `config.rs:171` checks the *whole key* before
splitting, with the comment at `:169-170` explaining why: "Check an exact key
before splitting into provider and model parts, so a bare key cannot silently fall
back to the default TTL." `scheduler.rs` has no such pre-check; for a key with no
slash it sets `provider = ""` and `model_id = model_key`, so the bare key is the
first candidate anyway, which reaches the same result by a different route.

## Failure scenario

A user writes a per-model configuration keyed only by a provider wildcard, which
`CONFIGURATION.md:70` says works:

```
{ "cache_ttl": { "default": "5m", "anthropic/*": "300m" } }
```

On the `cache_ttl` surface this resolves. `config.rs:496-508` parses the object
shape into `cache_ttl_by_model` (with `"default"` extracted to the scalar at
`:502-503`), and `resolve_cache_ttl_with_provenance` matches the wildcard at
`:196`, returning `300m` with `Explicit` provenance.

The same user then writes the analogous per-model execute threshold, which
`CONFIGURATION.md:167` also says is supported:

```
{ "execute_threshold_percentage": { "default": 70, "anthropic/*": 80 } }
```

Two things go wrong, and only the second is this record's subject. First, the object
form is not parsed at all: `number_at` (`config.rs:631-636`) uses `Value::as_f64`,
which returns `None` for an object, so the whole key is dropped and the default
`65` survives. That is 4b's `sel-per-model-and-token-thresholds-inert-in-module`.

Second, if that parse gap were fixed and the map reached
`ExecuteThresholdConfig::ByModel`, `resolve_percentage_match` would build the
candidate list from `model_key_lookup_order`, find no wildcard entry among the
candidates, and fall to `"default"`, returning `70` instead of `80`. The
documentation states one walk for both surfaces; the code has two walks that
disagree on the wildcard step.

So today the divergence is latent. It becomes live the moment anyone wires the
per-model threshold path, which is exactly what the parse-gap fix would do, and the
documentation would have told them the wildcard works.

## Timing windows and dependencies

None. Both walks are pure functions over a key and a `BTreeMap`. Both are
order-deterministic because `BTreeMap` iteration and lookup are ordered and neither
walk iterates the map: they probe it with computed keys.

## What a test must construct

A differential test, which is the cheapest possible shape here because both
functions are pure and take small inputs.

Build a set of `(model_key, map)` pairs and assert both implementations select the
same entry. The interesting keys are:

- `"anthropic/claude-opus-4-8"` against a map holding only `"anthropic/*"`. This is
  the case that differs today.
- `"anthropic/claude-opus-4-8"` against maps holding the exact key, the bare
  `claude-opus-4-8`, the dash-stripped `claude-opus-4`, and `default`, which are
  the cases that agree.
- `"bare-model-id"` with no slash, which exercises `config.rs:171` against
  `scheduler.rs:852`'s `provider = ""` path.
- `"provider/"` and `"/model"`, the empty-component cases, which `config.rs:177-179`
  sends to `default` explicitly.

The existing test to extend is `config.rs:760-785`
`cache_ttl_resolution_matches_shared_typescript_vectors`, which already pins one
implementation against a shared vector set. Adding the second implementation to the
same vector loop turns it into the differential test.

## Investigation log

### Q: Is the scheduler walk reachable at all today?

- Sources examined: `transform.rs:6104-6111` `scheduler_config`, whose only
  parameter is an `f64` and which constructs
  `ExecuteThresholdConfig::Percentage(...)` with `execute_threshold_tokens: None`;
  its two call sites at `transform.rs:3973` and `:2814`; `scheduler.rs:434-465`
  `resolve_execute_threshold`, where the `ByModel` arm is at `:458-460` and the
  tokens arm at `:441-451`.
- Findings: no. `ByModel` cannot be constructed from within this crate, and
  `execute_threshold_tokens` is hardwired to `None`, so both consumers of
  `model_key_lookup_order` are dead in production. Part 4b established this in
  `evidence/sel-per-model-and-token-thresholds-inert-in-module.md`.
- Missing evidence: none.
- Conclusion: resolved with answer. Reachability is `explicit-config-only`: the
  reachable half of the property is the `cache_ttl` walk, which requires the object
  config shape; the scheduler half is unreachable, which is why the record's impact
  is stated as latent.

### Q: Should the two walks be one function?

- Sources examined: both implementations; `config.rs:113-114`, which already calls
  the walk "shared"; the repository's duplication-prevention posture, which the
  agent instructions state as policy.
- Findings: they agree on three of four steps and on the termination rule, differ
  on the wildcard, and differ in return type (`config.rs` returns a matched value
  with provenance; `scheduler.rs` returns a candidate-key list). The candidate-list
  shape is the more reusable one and would let `config.rs` keep its provenance
  wrapper.
- Missing evidence: whether the wildcard step is deliberately absent from the
  threshold surface for a reason not stated anywhere. `CONFIGURATION.md:70` says the
  opposite, and no comment in `scheduler.rs` mentions the wildcard.
- Conclusion: needs human input. Either the scheduler walk gains the wildcard step
  or the documentation stops claiming one walk. The record does not choose.
