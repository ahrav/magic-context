# rt-a-every-published-configuration-field-changes-host-behaviour

## Discovery trigger

Part 4f found a configuration surface where 13 of 31 documented keys were inert
or divergent. The brief asks for the same treatment here. I enumerated all 21
fields an embedder can set and grepped each one repository-wide for a read site
outside its own declaration.

## Evidence trail

Twenty of twenty-one fields have at least one consumer. The full mapping is in
the lens file's configuration contract table. One field has none.

`config.rs:246-254`:

```
/// Host-owned synthetic initialization payload handed to the linked handler
/// before the listener binds (protocol §8.1 step 3-4).
#[derive(Clone, Default)]
pub struct HostInit {
    pub subc_capabilities: Vec<String>,
    /// Opaque resolved storage descriptor, when deployment configures managed
    /// storage. The handler deserializes it; the host never reads it.
    pub storage: Option<serde_json::Value>,
}
```

`subc_capabilities` has no documentation of its own and no consumer.
Repository-wide search for the identifier returns six hits, all verified:

| Site | Kind |
| --- | --- |
| `crates/mc-host/src/config.rs:250` | the declaration |
| `crates/mc-host/src/config.rs:262` | `Debug` formatting, inside the hand-written impl |
| `crates/mc-module/src/bin/ck_mc_host/serve.rs:487` | written as `Vec::new()` |
| `crates/mc-module/tests/host_adapter.rs:29` | written as `Vec::new()` |
| `crates/mc-module/tests/host_adapter.rs:88` | written as `Vec::new()` |
| `crates/mc-module/examples/direct_host_fixture.rs:577` | written as `Vec::new()` |

Four writes, all of the empty vector. Zero reads other than the `Debug` impl.

The value does travel. `runtime.rs:751` takes the whole `HostInit`:

```
let init = std::mem::take(&mut config.init);
```

with the reason at `:748-750`: "Taken, not cloned: the storage descriptor can be
arbitrarily large and must not stay owned by `config` for the incarnation,
outside every byte budget — the handler consumes the only copy." It is handed to
`initialize` at `:753`. So a handler implemented outside this repository could
read `subc_capabilities`, and `lib.rs:57` exports `HostInit` publicly.

Contrast with `storage`, the sibling field. `storage` is also never read by the
host — `config.rs:252-253` says so explicitly, "The handler deserializes it; the
host never reads it" — but it is a documented pass-through with a stated
consumer, and the `Debug` impl at `:259-264` deliberately reduces it to a
presence bit because "The storage descriptor can carry credentials or deployment
secrets". So `storage` is a designed pass-through; `subc_capabilities` is a
declared field with no stated consumer and no documentation.

The `Debug` treatment is the part that misleads. `config.rs:261-264`:

```
f.debug_struct("HostInit")
    .field("subc_capabilities", &self.subc_capabilities)
    .field("storage", &self.storage.is_some())
    .finish()
```

`subc_capabilities` is rendered in full while `storage` is reduced. In a
diagnostic dump the inert field is the more prominent of the two.

Two adjacent findings from the same enumeration, both recorded in the lens rather
than here because they are not inertness:

- `data_dir` has a consumer (`runtime.rs:660`) but no validation of any kind.
- `invalidate_on_missed` has a consumer (`connection.rs:830`) but the only value
  that reaches it in production is `false`, and `config.rs:236-238` says it must
  stay so.

## Failure scenario

An embedder integrating `mc-host` reads `lib.rs:57`, finds `HostInit` exported,
and populates `subc_capabilities` with the capability strings its deployment
should advertise — which is what the name and `config.rs:246-247`'s "Host-owned
synthetic initialization payload" invite.

Nothing happens. No capability is advertised, no error is returned, and
`HostConfig`'s derived `Debug` shows the strings present, so a diagnostic dump
confirms the embedder's belief. Whatever consumer they expected — the published
catalog, the auth exchange, `host.status` — does not read it. The catalog is
built from `handler.manifests()` (`runtime.rs:686`, `:718-724`), entirely
independently.

The failure is silent, and the diagnostic evidence actively supports the wrong
conclusion.

## Timing windows and dependencies

No timing dimension. This is a static property of the wiring, evaluated once per
field.

The dependency worth naming is the handler boundary. `HostInit` crosses out of
this crate at `runtime.rs:753`, so "no consumer" is a claim about this repository
only. `McHostHandler::initialize` takes the payload, and any handler could read
it. The three in-repository handlers — the composite at `composite.rs`, the
adapter in `mc-module/tests/host_adapter.rs`, and the example at
`mc-module/examples/direct_host_fixture.rs` — do not.

That is why the record's reachability label is `explicit-config-only` rather than
`default-production`: the field's default is `Vec::new()` and only an explicit
non-empty setting exposes the gap.

## What a test must construct

An enumeration, not a runtime scenario. The natural form is a single test that
lists every public configuration field beside its consumer's file and line, and
fails to compile or fails to run when a field has no entry. Rust has no
reflection for this, so the practical forms are:

1. A hand-maintained table test asserting one consumer per field, which drifts.
2. A review gate: any new public field on `HostConfig`, `HostLimits`,
   `HostTiming`, `LivenessPolicy`, or `HostInit` must be accompanied by a test
   that observes its effect.
3. For the pass-through fields specifically, a behavioural assertion: set
   `subc_capabilities` to a non-empty value and assert *some* observable differs.
   Today none does, so this test would fail, which is the point — it converts a
   silent gap into a failing check.

Form 3 is the only one that is genuinely mechanical. It asserts the precondition
that a settable field is observable, not the defect.

`config.rs` already has the shape for the validation half; `defaults_validate` at
`:467-470` is a one-line existence check of the same kind.

## Investigation log

### Q: is `subc_capabilities` referenced by the protocol specification under another name?

- Sources examined: `docs/mc-host-wire-protocol.md`, searched for
  `subc_capabilities`, `capabilities`, and the §8.1 initialization steps the
  doc comment cites.
- Findings: no occurrence of `subc_capabilities`. The doc comment at
  `config.rs:247` cites "protocol §8.1 step 3-4", which describes initialization
  ordering rather than a capability list. `:290` and `:296` mention capability
  caches on the *client* side ("Client MUST immediately invalidate its routes,
  pending correlations, capability/catalog caches") but those are populated from
  the catalog, which comes from `handler.manifests()`.
- Missing evidence: none.
- Conclusion: resolved with answer — the field has no counterpart in the wire
  contract. Whatever it was for is not in the specification.

### Q: is it a placeholder for scheduled work?

- Sources examined: `config.rs:1-6`, which defers CLI and config-file exposure to
  `magic-context-c50.8`; `config.rs:236-238`, which defers
  `invalidate_on_missed` to `magic-context-c50.4`; `runtime.rs:3-5`, which defers
  signal wiring to `magic-context-c50.4`.
- Findings: this crate has an established convention of naming the bead that will
  activate a deferred surface, in a doc comment on the surface itself. Three
  examples above. `subc_capabilities` carries no such comment and no bead
  reference.
- Missing evidence: whether a bead exists for it.
- Conclusion: needs human input. The convention's absence is suggestive of an
  omission rather than a planned deferral, but that is an inference about intent
  and I will not resolve it. The record stands either way: the field is inert
  today.

### Q: does any field have a consumer only inside `#[cfg(test)]`?

- Sources examined: the per-field grep results for all 21 fields.
- Findings: none. Every consumer found is in non-test code. `liveness` is the
  closest case — its consumer at `connection.rs:279` is production code, but the
  only configurations that make it `Some` are tests, which is a reachability
  question rather than an inertness one and is recorded separately as
  `rt-a-the-default-configuration-arms-no-liveness-probe`.
- Missing evidence: none.
- Conclusion: resolved with answer — one inert field, no test-only consumers.
