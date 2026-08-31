# hv-tierless-stored-row-arm-must-stay-unreachable

## Discovery trigger

Task item 6 asks for doc comments claiming a guarantee the code may not implement.
`historian.rs:60-62` makes an explicit unreachability claim about the publish
projection, and METHOD.md rule 3 says a documented guarantee is a claim under
test. This is the cleanest `unreachable` candidate in the lens: a named code
location the code's own comment says cannot execute.

## Evidence trail

### The claim and the location

`crates/mc-module/src/historian.rs:38-67`, inside `to_stored_compartment`:

```rust
        // Strict validation makes tierless output unreachable, but derive legacy
        // from P1 so a future bypass cannot falsely mark a flat row as v2.
        legacy: if c.p1.as_deref().is_some_and(|p1| !p1.trim().is_empty()) {
            0
        } else {
            1
        },
```

The `else` arm at `:65` is the forbidden location. The comment states both the
claim ("Strict validation makes tierless output unreachable") and the reason the
arm exists anyway ("so a future bypass cannot falsely mark a flat row as v2"). So
the code is already written as defence-in-depth against exactly the failure this
record catalogs, which is why the record's value is in pinning the claim rather
than reporting a defect.

### The gate side of the claim, verified

The predicate in the `legacy` expression is `c.p1` non-blank after trim. The gate's
check at `historian_validate.rs:1000-1008`:

```rust
match compartment.p1.as_deref() {
    Some(p1) if !p1.trim().is_empty() => {}
    _ => { return Some(format!("compartment {} is missing the tiered paraphrase structure ...", index + 1)); }
}
```

Identical predicate: `Some` and non-blank after `trim`. So the gate rejects
exactly the inputs that would take the `1` arm.

The value the projection sees is the value the gate checked. Chain verified:

- `ParsedCompartment.p1` is set at `historian_validate.rs:323`
  (`p1: Some(p1_value)`) or `:340` (`p1: None` for the flat v1 shape).
- `map_parsed_compartments_to_chunk` copies it at `:972`
  (`p1: compartment.p1.clone()`), so `ValidatedCompartment.p1` (`:212`) is the
  same value.
- `validate_parsed_compartments` (`:514-524`) runs on `&parsed.compartments`, the
  SAME structs whose `p1` was cloned. So the checked field and the projected field
  are the same value, not two independently derived ones.

One ordering subtlety, checked because it could have broken the argument:
`map_parsed_compartments_to_chunk` runs at `:506`, BEFORE
`validate_parsed_compartments` at `:514`. So the `ValidatedCompartment` values are
built before the tier check runs. That does not weaken the claim, because
`validate_historian_output` returns `Err` at `:521-523` and the mapped vector is
dropped. Both must pass before the `Ok` at `:628`.

The flat v1 path is genuinely reachable at the PARSE layer and rejected at the
VALIDATE layer, which is what makes the arm defensible rather than dead by
construction: `parse_compartment_output:333-347` builds a `ParsedCompartment` with
`p1: None` when the compartment has flat content and no tier. So a tierless
compartment exists as a value inside the module and is stopped one function later.

### Test coverage of the claim's two halves

- The gate half IS covered:
  `tierless_compartments_reject_while_p1_only_output_keeps_soft_fallbacks`
  (`historian_validate.rs:1463`) and
  `mismatched_tier_close_parses_leniently_while_tierless_output_still_rejects`
  (`:1483`). Both assert the reject.
- The projection half is NOT covered. Grepped for a `legacy` assertion:
  `to_stored_compartment` has no direct test, and no test asserts the `1` arm is
  unreached. So `Exercised: partial` is the honest label.

### The bypass the comment anticipates

`hv-publish-accepts-unvalidated-validated-chunk` documents it: `ValidatedChunk`
(`historian_validate.rs:226-238`) has all-`pub` fields and derives `Default`, and
`publish_validated_chunk` is `pub fn` (`historian.rs:444`) inside `pub mod
historian` (`lib.rs:19`). Four existing tests already construct the bypass shape
(`historian.rs:4173`, `:4328`, `:4414`, `:4495`), and `:4476-4489` builds a
literal `ValidatedChunk`. So the "future bypass" the comment guards against is
already trivially constructible in test code, which is exactly the situation the
defensive derivation was written for.

## Failure scenario

The arm fires only via a bypass, so the scenario is a future change rather than a
current input.

Suppose a new publish route is added, for example a recovery or import path that
reconstructs compartments from a durable artifact and calls
`publish_validated_chunk` directly. If any reconstructed compartment has
`p1: None` (a legacy row read back from an older store, say), then:

- `to_stored_compartment` takes the `1` arm and writes `legacy = 1`.
- At render, `is_tiered_row` (`decay_render.rs:154-156`) returns false for that
  row, so `legacy_tier` is selected (`decay_render.rs:288-289` region).
- `legacy_body_for_tier` (`decay_render.rs:195-203`) renders P1 as full content,
  P2 truncated to 1200 characters and P3 to 420 via `truncate_with_ellipsis`
  (`:185-192`).

So the consequence of the arm firing is silent tier degradation: the row renders
through the legacy ladder with hard truncation instead of the model's authored
paraphrase tiers. No panic, no error, no log. The `legacy` derivation is doing its
job (it does not falsely claim v2), and the failure is confined to render fidelity.

That is a mild consequence, and it is the reason this record is worth having: an
`unreachable` location whose firing is silent and mild is exactly the kind that
stays broken for a long time.

## Timing windows and dependencies

No timing. The dependency is entirely structural: the arm's unreachability is a
property of the CALL GRAPH (only two production paths reach
`publish_validated_chunk`, both through `publish_output_from_awaiting`), not of
the type system. Verified both paths: `historian.rs:1419` (the reattach route) and
`historian.rs:1592` (the drive route), each calling
`publish_output_from_awaiting`, which validates at `:1673`.

## What a test must construct

The `unreachable` semantics want a coverage marker at the location, not an input
that reaches it. Per METHOD.md's coverage rules the marker must assert independent
preconditions rather than the violation, and here the location IS the violation,
so a location marker is the right instrument:

1. Place a constant, globally unique marker inside the `1` arm at
   `historian.rs:65`. Under the project's assertion conventions a
   `debug_assert!(false, ...)` or a counted marker both work; the arm must keep
   returning `1` in release so the defensive behaviour survives.
2. Assert across every campaign that the marker count is zero.

Two supporting tests that are cheap and do not require the marker:

- Pin the gate half more tightly than the existing tests do: assert that for a
  compartment with `p1: Some("   ")` (whitespace only, not `None`) the gate
  rejects. The existing tests use the flat v1 shape (`p1: None`); the whitespace
  case exercises the `trim` in both predicates and is the input where the two
  predicates could most easily drift apart.
- Pin the projection: call `to_stored_compartment` with `p1: None` and assert
  `legacy == 1`, and with `p1: Some("x")` and assert `legacy == 0`. This makes the
  defensive derivation itself a tested contract, so a future refactor cannot
  quietly change it to a constant `0`.

The second is the one that matters most, because the comment's whole value is that
the derivation cannot falsely mark a flat row as v2, and nothing asserts that
today.

## Investigation log

### Q: Are the gate predicate and the projection predicate genuinely identical, or only similar?

- Sources examined: `historian_validate.rs:1000-1001`
  (`Some(p1) if !p1.trim().is_empty()`), `historian.rs:63`
  (`c.p1.as_deref().is_some_and(|p1| !p1.trim().is_empty())`),
  `historian_validate.rs:212` and `:972` (the field type and the clone),
  `decay_render.rs:154-156` (`is_tiered_row`, a THIRD predicate:
  `c.p1.as_deref().is_some_and(|p| !p.is_empty())`).
- Findings: The gate and the projection predicates are semantically identical, both
  trimming. The renderer's `is_tiered_row` does NOT trim: it tests
  `!p.is_empty()`. So a `p1` of `"   "` would be "tiered" to the renderer and
  "tierless" to the other two. That divergence is unreachable through the gate
  (which rejects whitespace-only `p1`), but it is a third copy of the predicate
  with different semantics, and `decay_render.rs:149-153`'s own comment discusses
  "the malformed pseudo-v2 state left by an interrupted upgrade — `legacy=0` but
  tiers never populated", which is precisely a state where these predicates
  disagree.
- Missing evidence: whether any store migration can produce `p1 = "   "`.
- Conclusion: resolved with answer for this record — gate and projection agree, so
  the unreachability claim holds. The renderer's non-trimming variant is a
  three-way predicate duplication worth flagging to the render lens (Part 4e or
  Part 3, since `decay_render.rs` is shared) rather than resolving here.

### Q: Does any test already assert the arm is unreached?

- Sources examined: all 19 tests in `historian_validate.rs:1305-1868`; the
  `historian.rs` test module hits for `legacy` and for
  `to_stored_compartment`.
- Findings: `historian_validate.rs:1463` and `:1483` assert the GATE rejects
  tierless output. No test names `legacy` as an assertion target, and
  `to_stored_compartment` has no direct test. So the claim's second half is
  unasserted.
- Missing evidence: none needed.
- Conclusion: resolved with answer — no. `Exercised: partial` is correct, and the
  missing half is the projection.
