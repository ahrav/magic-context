# render-a-orphan-tool-arc-has-no-production-detection

## Discovery trigger

The Part 4 scope map names two fail-loud production guards on the output path.
Reading the first one to determine exactly what it panics on showed the attribute
directly above it is `#[cfg(test)]`.

## Evidence trail

All references read back at `HEAD` `e447c927`, in
`crates/mc-module/src/transform.rs`.

The guard:

```
11171: #[cfg(test)]
11172: fn assert_no_orphaned_tool_arcs(messages: &[ServedMessage]) {
```

It checks two conditions over the emitted array (`:11172-11225`):

1. Every `ToolResult` id must have an outstanding `ToolCall` of the same id
   already seen, tracked as a decrementing count in `seen_calls`
   (`:11198-11211`). Message: "unexpected tool_use_id found in tool_result
   blocks".
2. Every `ToolCall` with `provider_executed: false` must have a matching
   `ToolResult` in the same message or the immediately following one
   (`:11213-11223`). Message: "tool_use ids were found without tool_result blocks
   immediately after".

The only call site outside the inline test module (`:12625-29439`) is:

```
5486: #[cfg(test)]
5487: assert_no_orphaned_tool_arcs(&ck_messages);
```

so the call is itself compiled out of a non-test build, and `ck_messages` there is
the post-repair array destructured from `built_output` at `:5480-5485`.

Grep for every reference at `HEAD`:

| Line | Context |
| --- | --- |
| `:5487` | the `#[cfg(test)]` call in `apply_once` |
| `:11172` | the definition, under `#[cfg(test)]` |
| `:14314`, `:14321` | negative tests, wrapped in `catch_unwind` to assert the guard fires |
| `:14328`, `:14336` | positive tests on a well-formed array and on a real render |
| `:27418`, `:27427` | positive tests after a repair and after its replay |

So the guard has real coverage inside the test module and zero presence in a
shipped artifact.

What does run in production is the sibling belt, `enforce_unique_tool_use_ids`
(`:11231-11305`, called at `:12147`). It addresses duplicate ids, not orphans, and
its release repair explicitly removes an adjacent `ToolResult` when its owner
empties (`:11258-11277`) precisely so it does not create an orphan. That is the
only orphan-awareness in production code on this path.

The paths that could create an orphan are all in scope and all deliberate about
it, which is why the guard exists:

- `split_coverage_tool_arcs` (`:10545-10617`) and
  `projection_reasoning_ineligible_arc_ids` (`:10497-10544` region) exist to keep
  arcs intact across the coverage boundary. `keep_split_invocation` in the
  retention filter (`:11855`, `:11859`) retains a covered invocation so its
  uncovered result is not orphaned.
- `full_drop_tool_ids` (`:10839-10891`) removes both halves of an arc by tool id,
  and its comment at `:10878-10880` explains the skeleton and edit-marker
  exception that keeps a call paired with its result shell.
- The release duplicate repair, above.

The scope map's claim
(`docs/properties/part-4-module/_lenses/scope-map-and-risk-ranking.md:441-443`)
is therefore half wrong: `enforce_unique_tool_use_ids` is production,
`assert_no_orphaned_tool_arcs` is not.

## Failure scenario

A coverage advance folds a tool call behind `m0` while its result stays in the
tail, and the `keep_split_invocation` path misses it — for example because
`renderer_transition_active` is false, which is exactly the condition under which
`split_coverage_invocation_mids` is left empty (`:11769-11776`). The served array
contains a `ToolResult` with no preceding `ToolCall`. Anthropic rejects the whole
request with a 400. Because the render is deterministic, every retry produces the
same array, so the session is wedged until the message array itself changes. In
production nothing detects the shape; the first signal is the provider error, at
which point the module has already committed the cache state that reproduces it.

## Timing windows and dependencies

No temporal window. The dependency is the composition: an orphan is a property of
the final array, and the only place it can be observed cheaply is right where the
test-only guard sits.

Note that `renderer_transition_active` gates two of the arc-preserving inputs
(`:11759-11763` for `reasoning_ineligible_arcs` and `:11769-11776` for
`split_coverage_invocation_mids`). Both fall back to an empty set when it is
false, which widens rather than narrows the retention filter for
`keep_split_invocation` — an empty set means no message is retained on that
ground.

## What a test must construct

The oracle already exists; what is missing is a production detection point. A
test that proves the property rather than the guard needs:

1. A request whose coverage ordinal falls between a tool call and its result, with
   `renderer_transition_active` false so `split_coverage_invocation_mids` is
   empty.
2. Render, and assert the pairing conditions of `:11172-11225` over
   `built.messages`, using the same two rules but as an assertion in the test, not
   by calling the `#[cfg(test)]` helper from production code.
3. Repeat with a frozen `red:` unit of kind `drop` on only one half of an arc, to
   attack `full_drop_tool_ids`'s pairing logic from the other side.
4. For the production-detection gap, the check to add is the guard itself behind a
   cheap gate, or a counter on the two conditions. Either makes the forbidden state
   observable; today it is not.

## Investigation log

### Q: Is the guard test-only deliberately, for cost?

- Sources examined: `transform.rs:11172-11225`, `:11231-11305`, `:11156-11169`.
- Findings: the guard rebuilds two `Vec<String>` per message via the
  `external_calls` and `external_results` closures, and calls `external_results`
  twice per message plus once for the next message (`:11204`, `:11213-11217`), so
  it is roughly O(messages x blocks) with allocation per message. The production
  belt `duplicate_tool_use_locations` is O(messages x blocks) with one `HashSet`
  and no per-message allocation. So the guard is more expensive, but the same
  order. Neither carries a comment about cost.
- Missing evidence: author intent.
- Conclusion: needs human input. The asymmetry is plausible on cost grounds and
  plausible as an oversight, and nothing in the source distinguishes them.

### Q: Does anything else in production check arc pairing?

- Sources examined: grep for `orphan` across `crates/mc-module/src`, plus
  `:10497-10617` and `:11258-11277`.
- Findings: `projection_reasoning_ineligible_arc_ids`, `split_coverage_tool_arcs`
  and the duplicate repair all *avoid* creating orphans. None of them verifies the
  final array. `divergence.rs` attributes a first divergence between served block
  sequences, which is a different question.
- Missing evidence: none within 4e's scope.
- Conclusion: resolved with answer — no production verification of the emitted
  array exists.
