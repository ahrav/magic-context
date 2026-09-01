# hv-output-not-bound-to-chunk-identity

## Discovery trigger

Task focus: treat the historian's producer as a hostile peer. The first question
a hostile-peer frame asks is what proves the payload belongs to THIS request. In
the Part 1 shared-memory work that proof was a descriptor plus a generation. Here
the equivalent question is: what in the model's output could only have been
produced by a model that read this chunk?

Reading `validate_historian_output` (`crates/mc-module/src/historian_validate.rs:450-641`)
top to bottom, the answer is nothing. Every chunk-derived fact the gate consults
is a small integer or a lookup keyed by one.

## Evidence trail

The complete set of chunk fields the gate reads, enumerated by reading
`:450-641`, `:934-981`, and `:983-1084`:

- `chunk.start_index`, `chunk.end_index` — range bounds, checked at `:1015-1020`.
- `chunk.lines[].ordinal` — endpoint existence, `:941-948`.
- `chunk.lines[].message_id`, `chunk.lines[].anchorable` — endpoint anchorability,
  `:958-963`, then copied into the output at `:968-969`.
- `chunk.present_ordinals` — contiguity, `:990-994`, `:1021-1032`, `:1051`.
- `chunk.tool_only_ranges` — gap healing, `:918-922`.
- `chunk.completed_tool_arcs` — arc boundaries, `:526-529`, `:551-553`, `:877-885`.

Not one of these is derived from the chunk's TEXT. `chunk_transcript` and
`raw_chunk_messages` are carried past the gate untouched, straight into the
publish request (`historian.rs:1726-1727`); `validate_historian_output` never
receives them. Its signature (`:450-455`) takes `text`, `chunk`,
`prior_compartments`, `options`, and `HistorianChunk` (`:47-65`) has no text
field at all.

Searched for an echo or nonce requirement and found none:

```
rg -ni "nonce|echo_back|session_marker" \
  crates/mc-module/src/historian_prompt.rs \
  crates/mc-module/src/historian_validate.rs
# no matches
```

The prompt does not ask the model to echo anything verifiable.
`historian_prompt.rs:21` carries `HISTORIAN_TRANSCRIPT_GUARD`, which tells the
model not to obey imperative text inside `<new_messages>`. That is an injection
defence, not a binding.

The one fingerprint in the area binds the wrong pair.
`publish_validated_chunk` compares `request.predicate.chunk_fingerprint` with
`request.observed_chunk_fingerprint` (`historian.rs:449-461`) and abandons on
mismatch. `chunk_fingerprint` comes from durable firing state via
`publish_predicate` (`historian.rs:373-388`). So the fingerprint proves *the
chunk we are publishing against is the chunk this firing pinned*. It says nothing
about whether the model's words describe that chunk.

The state machine also declines to look. `output_received`
(`historian.rs:299-307`) takes the output as `_output_text` and drops it,
transitioning `AwaitingProducer -> Validating` on phase alone.

## Failure scenario

Chunk 40..=89 of session S, 50 ordinals of a conversation about a database
migration. The producer session is reused, or a provider-side response cache
hits, and the model returns a document it produced for a different chunk: three
compartments about an unrelated frontend refactor.

The document is well formed:

```
<output><compartments>
<compartment start="40" end="55" title="Sidebar layout rework" ...><p1>...</p1>...</compartment>
<compartment start="56" end="72" title="Icon set migration" ...><p1>...</p1>...</compartment>
<compartment start="73" end="89" title="Storybook cleanup" ...><p1>...</p1>...</compartment>
</compartments><meta><unprocessed_from>90</unprocessed_from></meta></output>
```

Walk the gate:

- Check 1 `:267-271`: single `<output>` root. Pass.
- Check 3 `:457-461`: our chunk is well formed. Pass.
- Checks 5, 6 `:469-483`: `start_index` 40 follows the prior stored end. Pass.
- Check 7 `:487-491`: three compartments. Pass.
- Check 8 `:941-957`: 40, 55, 56, 72, 73, 89 all exist as chunk lines. Pass.
- Check 9 `:958-963`: end lines anchorable. Pass.
- Check 10 `:1000-1008`: each has a non-blank `p1`. Pass.
- Checks 16, 17 `:1039-1049`: 40 then 56 then 73 is exactly contiguous over the
  present ordinals. Pass.
- Check 18 `:1054-1060`: `expected_start` after 89 is `None`; falls to `:1063`,
  and `unprocessed_from == chunk_end + 1 == 90`. Pass.
- Check 21 `:525-534`: no arcs configured. Pass.
- Check 22 `:565-570`: 89 >= offset. Pass.

`discarded_last` is false because lookahead distance is `89 - 89 = 0`, which is
at most `BOUNDARY_HEALING_SLACK`, so the last compartment IS popped at `:555` and
`unprocessed_from` becomes 73. That does not save the run: the first two
compartments still publish with the wrong content.

Consequence: ordinals 40..=72 of a database-migration conversation are served
thereafter as summaries of a frontend refactor. The agent reads m0 and believes
the session discussed Storybook. The durable raw record survives in
`raw_chunk_messages` (`historian.rs:435-436`, `:1727`), so the bytes are
recoverable by a verbose expand, but no automated path ever notices the
substitution.

## Timing windows and dependencies

No interleaving is required, which is what makes this severe: it is a pure
input-admission property, reachable on the first firing of a fresh session.

The realistic triggers are producer-session reuse and provider caching.
`historian.rs:1001-1003` notes that the firing sequence is part of the run id
"so a fallback model attempt never resumes a firing", which addresses run
identity but not response content. The intra-firing model fallback at
`historian.rs:1440-1450` also means a single firing can accept output from the
second or third model in the chain, widening the set of producers whose output
must be trusted.

## What a test must construct

A unit test over `validate_historian_output` directly, which needs no store and
no async runtime:

1. Build a chunk with `chunk(40, 89)` shaped like the helper at `:1350-1366`.
2. Build a document whose compartment ranges partition 40..=89 contiguously,
   with `<unprocessed_from>90</unprocessed_from>`, and whose titles and `p1`
   bodies are drawn from an unrelated corpus.
3. Assert the current behaviour is `Ok`, which documents the gap.

To assert the PROPERTY rather than the gap, the test needs a binding to exist
first. The coverage-check form, per METHOD.md's rule against asserting the
violation, is to assert the independent preconditions that create the window:
mark that a firing published a compartment set whose accepted fields contain no
value derivable from the chunk text, and separately that the chunk text was
non-empty. Both fire on a correct implementation once a binding is added, because
the marker then observes the binding field's presence.

## Investigation log

### Q: Is a chunk-derived echo requirement compatible with the byte-identical TypeScript oracle the golden test pins?

- Sources examined: `historian_validate.rs:1384-1414` (the golden test and its
  divergence carve-out at `:1391-1399`), `testdata/validate-golden.json`
  (16 cases), `historian_prompt.rs:72-77` (the vendored system prompt kept
  "byte-identical so both implementations drive the model with the same role
  guidance"), `historian_prompt.rs:1-4`.
- Findings: The golden test asserts that Rust's parse and validate verdicts equal
  the recorded TypeScript verdicts for all 16 cases, tolerating divergence only
  for malformed envelopes. Adding a required echo field would change the verdict
  for the 10 currently-passing cases, all of which lack such a field, so the
  golden would have to be regenerated on the TypeScript side first. The system
  prompt is a vendored copy with a `--check` drift gate, so the prompt change is
  also upstream-first.
- Missing evidence: The TypeScript validator and prompt generator sources are not
  in the paths this pass read. Whether the upstream project would accept the
  change is a product decision.
- Conclusion: needs human input. The mechanism is clear and cheap (a chunk digest
  echoed in `<meta>`); the blocker is cross-implementation coordination, not
  Rust-side feasibility.

### Q: Does anything downstream of publish detect a content substitution?

- Sources examined: `historian.rs:444-540` (`publish_validated_chunk`),
  `historian.rs:38-67` (`to_stored_compartment`), `decay_render.rs:1-300`,
  `historian_prompt.rs:218-278` (the session-references block that feeds prior
  compartments back into the next run).
- Findings: `to_stored_compartment` copies title, content, and tiers verbatim.
  `decay_render` selects a tier and escapes it; it never compares content to raw
  history. The session-references block shows the model its own prior
  compartments, so a substituted summary becomes the calibration context for the
  next run rather than being contradicted by it.
- Missing evidence: none needed for this conclusion.
- Conclusion: resolved with answer — no. The substitution is undetected at every
  stage after the gate, and the prior-compartment feedback loop propagates it.
