# hv-publish-accepts-unvalidated-validated-chunk

## Discovery trigger

Task item 2 asks whether rejection is fail-closed in every path. Answering it
required enumerating the routes into the durable publish, which surfaced a
different question: what makes the gate MANDATORY? The answer is a convention held
by one call site, not the type system. The name `ValidatedChunk` implies a
proof-carrying token, and it is not one.

## Evidence trail

### The type advertises a proof it does not carry

`crates/mc-module/src/historian_validate.rs:225-238`:

```rust
/// The side-effect-free publish plan produced by validation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidatedChunk {
    pub compartments: Vec<ValidatedCompartment>,
    pub facts: Vec<FactCandidate>,
    pub events: Vec<ParsedEvent>,
    pub primer_candidates: Vec<PrimerCandidate>,
    pub user_observations: Vec<UserObservationCandidate>,
    pub unprocessed_from: u64,
    pub discarded_last: bool,
}
```

Every field is `pub`. It derives `Default` AND `Deserialize`. So three independent
construction routes exist that bypass `validate_historian_output`: struct literal,
`Default::default()`, and deserialising attacker-influenced JSON.
`ValidatedCompartment` (`:202-223`) is likewise all-`pub` with `Deserialize`.

### The consumer is public and takes it on faith

`historian.rs:444`:

```rust
pub fn publish_validated_chunk(
    store: &McStore,
    request: ValidatedPublishRequest<'_>,
) -> Result<HistorianPublishResult, HistorianStateError> {
```

`ValidatedPublishRequest.validated` is `&'a ValidatedChunk` (`historian.rs:420`).
The function's first act is a fingerprint comparison (`:449-461`), which binds the
CHUNK to the FIRING, then it projects compartments (`:463-467`) with no check that
the `validated` argument came from the gate.

Both modules are public: `lib.rs:19` `pub mod historian;` and `lib.rs:23`
`pub mod historian_validate;`. So this is reachable from any crate depending on
`mc-module`, not just from inside it.

### Today's call graph is clean

Enumerated every production construction and every call:

```
rg -n "ValidatedChunk\s*\{" crates/mc-module/src/*.rs
  historian_validate.rs:227   (the definition)
  historian_validate.rs:628   (the gate's own Ok return)
  historian.rs:4476           (test code)
```

```
rg -n "publish_validated_chunk" crates/mc-module/src/historian.rs
  :444   definition
  :1714  the single production call
  :4173, :4328, :4414, :4495   test calls
```

The single production call at `:1714` is inside `publish_output_from_awaiting`,
which validates at `:1673-1678` and returns early on `Err` at `:1702`. Its two
callers are `historian.rs:1419` (reattach) and `:1592` (drive). So both production
routes are gated, and the invariant HOLDS at HEAD.

The four test call sites are the point: they demonstrate the bypass is not
hypothetical or awkward. `historian.rs:4476-4489` builds a literal `ValidatedChunk`
with a hand-written `ValidatedCompartment`, and `:4337` and `:4423` pass
`&ValidatedChunk::default()`. Constructing an unvalidated publish takes three
lines.

### The codebase already anticipates this exact failure

`historian.rs:60-62`, inside `to_stored_compartment`:

> Strict validation makes tierless output unreachable, but derive legacy from P1 so
> a future bypass cannot falsely mark a flat row as v2.

"a future bypass" names precisely this. So the risk was recognised and answered
with one field's defensive derivation rather than with a construction restriction.
That single defence covers `legacy` and nothing else: a bypassed publish would
still write arbitrary `title`, `content`, `p1`..`p4`, `importance`,
`episode_type`, `start_message`, `end_message`, `start_message_id`, and
`end_message_id`, and would still advance
`publication_floor_ordinal: validated.unprocessed_from` (`historian.rs:1725`).

### What a bypass would skip

All 22 rejecting checks. Most consequentially, the ones that protect durable
coverage: endpoint existence in the pinned chunk (`historian_validate.rs:941-957`),
endpoint anchorability (`:958-963`), range contiguity and non-overlap
(`:1039-1050`), the `<unprocessed_from>` cross-check (`:1054-1074`), the
completed-arc terminal boundary (`:525-534`), and forward progress (`:565-570`).

`Deserialize` deserves separate mention. Because `ValidatedChunk` is
`Deserialize`, a bypass does not even require Rust code: any path that
deserialises one from a file, a cache, or a wire message admits a fully attacker
chosen publish plan. No such path exists today, verified by the `rg` above, but the
derive makes the shape available.

## Failure scenario

Structural, so the scenario is a plausible future change.

A crash-recovery route is added: after an interrupted publish, reload the
`ValidatedChunk` that was serialised alongside the `Publishing` phase state and
re-drive the publish, since the validation work is already done. This is a natural
optimisation and `Serialize`/`Deserialize` on the type actively invites it.

The stored plan is now the trust boundary. Whatever wrote it is trusted. If the
serialisation happened before some future check was added, or if the state row is
editable by anything with store access, the re-driven publish writes compartments
that no gate ever saw. `publish_validated_chunk` compares the chunk fingerprint
(`:449-461`) and would still catch a stale CHUNK, but it cannot catch compartment
content or ranges that were never validated against that chunk.

Consequence: arbitrary ranges and content in durable compartments, plus a
`publication_floor_ordinal` from the same unvalidated source, so coverage advances
to wherever the plan says. The one defence that fires is `legacy` being derived
honestly from `p1` (`historian.rs:63-67`), and its consequence when it fires is
mild tier degradation, not a stop. See
`hv-tierless-stored-row-arm-must-stay-unreachable.md`.

## Timing windows and dependencies

No timing. The dependency is the call graph, and the property's whole value is
that a call-graph invariant is currently unenforced by any mechanism a compiler or
reviewer would catch. Adding a second call site is a small, locally-plausible diff
with no compile error and no test failure.

## What a test must construct

A test cannot easily assert a call-graph property, so the right instruments are a
lint-shaped check plus a marker.

1. A structural test that fails when a new caller appears. The cheapest honest
   version asserts the count of production callers: parse
   `crates/mc-module/src/historian.rs`, count occurrences of
   `publish_validated_chunk(` outside the `#[cfg(test)]` module, and assert the
   count is 1. Brittle in the usual way, and the brittleness is the point: a new
   caller must be a deliberate decision that updates the count. The crate already
   has precedent for artifact-level contract tests
   (`lib.rs:30281-30517`, `release_contract_tests`).
2. A coverage marker at the gate, per METHOD.md's rule to assert independent
   preconditions rather than the violation. Mark two things separately: that a
   publish transaction was entered, and that `validate_historian_output` returned
   `Ok` for the same firing sequence. Then assert the publish-entered count never
   exceeds the validation-passed count. Both markers fire on a correct
   implementation, so the check is valid; it can only be violated by a real bypass.
   The firing sequence is available on both sides (`predicate.firing_seq` at
   `historian.rs:381`, and the durable `firing_seq` the gate's caller holds), so the
   correlation key exists.

The remediation this record points at is a private field on `ValidatedChunk` plus a
constructor, but that is out of scope. The record's job is to state that the
mandatory-gate invariant is currently held by convention.

## Investigation log

### Q: Should ValidatedChunk carry a private field so only the gate can construct it?

- Sources examined: `historian_validate.rs:226-238` (the derives and field
  visibility), `:202-223` (`ValidatedCompartment`, same shape), `historian.rs:4337`,
  `:4423`, `:4476-4489` (the three test construction sites),
  `historian_chunk.rs:1419-1428` (a test that builds one via the gate).
- Findings: A private zero-sized witness field would break all three test
  construction sites and would remove `Default`, which two tests rely on
  (`historian.rs:4337`, `:4423`). It would also break `Deserialize`, and whether
  that derive is load-bearing is unclear: nothing in `mc-module` deserialises a
  `ValidatedChunk` today, but the derive is on nearly every type in the file, so it
  may exist for uniformity or for an external consumer.
- Missing evidence: whether any consumer outside this workspace deserialises
  `ValidatedChunk`. The type is `pub` in a `pub mod`, so the answer is not derivable
  from this repository alone.
- Conclusion: needs human input. The change is mechanically simple and its cost is
  a handful of test rewrites plus a decision about whether `Serialize`/`Deserialize`
  on the publish plan is part of the public contract.

### Q: Is rejection fail-closed in every current path, independent of the type question?

- Sources examined: `historian.rs:1641-1745` (`publish_output_from_awaiting` in
  full), `:1419-1436` (the reattach caller), `:1560-1618` (the drive caller and its
  `publish_result?` at `:1612`), `:1440-1450` (the validation-rejection fallback
  arm), `:1663-1664` (the pre-validation phase persist), `:1666-1671` (the
  length-cap short-circuit).
- Findings: Every path from a producer output to a compartment write passes through
  `:1673`. The `Err` arm at `:1682-1703` returns before `:1706`
  (`validation_ok`) and therefore before `:1714`. There is no force flag, no
  partial-accept, and no best-effort branch. The `length_capped` case is stricter
  still: it never calls the gate and synthesises a rejection at `:1667-1671`.
- Missing evidence: none needed.
- Conclusion: resolved with answer — yes, fail-closed at HEAD on the compartment
  path. Two durable PHASE writes do occur around a rejection (`:1664`, `:1693`),
  which is a precision issue with the module doc's wording and is recorded as
  contract-vs-code lead 1 in the lens file rather than as a fail-open finding.
