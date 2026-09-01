# tshist-a-output-envelope-is-rust-only

## Discovery trigger

Part 4a numbers the Rust gate's first two rejecting checks as the `<output>`
envelope and the nested-tag guard. Enumerating the divergence surface meant
looking for their TypeScript counterparts first, since check 1 is what rejects
the empty string on the Rust side. Neither exists.

## Evidence trail

All references at `HEAD` = `e447c927`.

**Rust, `crates/mc-module/src/historian_validate.rs`.** The doc comment at
`:261-263` is the most useful single line of evidence in this record:

> Require one complete historian output envelope, then use the TypeScript host
> parser's permissive extraction semantics for structures inside that root.
> Malformed inner XML yields fewer usable structures for validation to assess.

Check 1, `:267-271`:

```
let Some(root) = output_document_regex().captures(text) else {
    return Err(validation_error(
        "Historian output must be one complete <output> root document.",
    ));
};
```

`output_document_regex` (`:1156-1161`) is
`(?is)\A\s*<output(?:\s[^>]*)?>(?P<body>.*)</output\s*>\s*\z`, anchored at both
ends, so leading or trailing prose fails.

Check 2, `:276-280`: the body is re-scanned with `output_tag_regex`
(`:1163-1165`, `(?is)</?output(?:\s[^>]*)?>`) and any hit rejects with
"Historian output must contain exactly one <output> root document."

**TypeScript, `packages/plugin/src/hooks/magic-context/compartment-parser.ts`.**
`parseCompartmentOutput` spans `:162-294`. Its first action on the input is
`:166`:

```
for (const match of text.matchAll(COMPARTMENT_REGEX)) {
```

`COMPARTMENT_REGEX` (`:59`) is
`/<compartment\s+([^>]*?)\s*>(.*?)<\/compartment>/gs`. Nothing in the file
matches, requires, or counts an `<output>` tag: the module's regex constants are
`:59` through `:110` and none mentions `output`. Facts scoping uses
`FACTS_BLOCK_REGEX` and `EVENTS_BLOCK_REGEX` (`:107-108`) and, when no `<facts>`
block exists, strips events and compartment bodies from the whole text
(`:235-239`) rather than from a root body.

`validateHistorianOutput`
(`compartment-runner-validation.ts:119-183`) calls the parser at `:126` and its
only structural response is the empty check at `:127-132`, which produces
"Historian returned no usable compartments." That is Rust check 7, not check 1:
on the Rust side an empty string dies at check 1 with a different message.

**Every existing fixture wraps its input.** `compartment-parser.test.ts` opens
each case with `<output>` and closes with `</output>` (`:7` and `:33`, `:51` and
`:63`, `:69` and `:81`, and so on through `:259`/`:270`).
`compartment-runner-validation.test.ts` builds XML through a `buildXml` helper
that does the same (its output is visible at `:319` and `:322`). So no test
distinguishes the two implementations here, in either direction.

## Failure scenario

A model emits reasoning before the envelope, or wraps the envelope in a markdown
fence, or retries internally and emits two envelopes:

```
Let me work through the messages first.
<output><compartment start="1" end="40" title="t"><p1>...</p1></compartment>
<unprocessed_from>41</unprocessed_from></output>
```

TypeScript: `:166` finds the compartment, the tiers parse, `:127` passes,
`:152` sees contiguous coverage from `chunkStart`, and the pass publishes.

Rust: `:267-271` rejects, the run records a validation failure, and the repair
prompt fires.

The two-envelope variant diverges the same way, and worse: TypeScript's
`matchAll` collects compartments from *both* envelopes into one list, which
`:291` then sorts by `startMessage`, so two independent attempts are merged into
a single coverage claim.

## Timing windows and dependencies

None. This is an input-shape divergence, fully determined by the text.

The dependency worth naming is which implementation is live. The scope map
records that `config/transform-mode.ts` selects the transform path and leaves the
shipped default as an open question for 5c. That question decides whether this
divergence is currently the permissive behaviour users get or the strict one.

## What a test must construct

1. A valid compartment set with leading prose, and the same set with trailing
   prose. Assert the TypeScript verdict.
2. Two `<output>` envelopes, each internally consistent but jointly
   contradictory (for example both claiming `start="1"`). Assert what the merged
   list becomes after `:291`.
3. The bare empty string, asserting the TypeScript error message is the
   no-compartments one, so the two implementations produce different errors for
   the same input.

None needs fault injection. All three are pure function calls, which is what
makes this the cheapest divergence in the part to pin.

## Investigation log

### Q: Is the permissiveness intentional?

- Sources examined: `historian_validate.rs:261-263`, `:267-271`, `:276-280`,
  `:1156-1165`; `compartment-parser.ts:56-110`, `:162-294`; both parser test
  files; `compartment-runner-validation.ts:126-132`.
- Findings: the Rust doc comment describes the TypeScript extraction semantics as
  what it reuses *inside* the root, which reads as a deliberate addition of the
  envelope on the Rust side. No comment on the TypeScript side mentions an
  envelope, and no test asserts its absence, so there is no evidence the
  TypeScript permissiveness was a decision rather than an omission.
- Missing evidence: no design document was found stating which implementation is
  normative for input shape. `docs/specs/prompt-surface/` is Part 4e's scope and
  was not read.
- Conclusion: needs human input. The mechanical facts are settled; whether the
  Rust envelope should be backported or the Rust check relaxed is a product
  decision about which side is the contract.
