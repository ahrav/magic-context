# tshist-a-heal-rewrites-boundary-identity-without-revalidating-content

## Discovery trigger

The task asks whether the healing slack can admit output the strict path would
reject. Reading the gate's ordering answered yes for the two heals, and reading
the mapping that follows them showed the healed range also restamps the durable
end message id, which is a second effect the heal's own comment does not mention.

## Evidence trail

All references at `HEAD` = `e447c927`, in `packages/plugin/src/hooks/magic-context/`.

**The ordering is what admits.** `compartment-runner-validation.ts:136-157`:

```
healCompartmentGaps(parsed.compartments, chunk.toolOnlyRanges);
parsed.unprocessedFrom = healTerminalCompletedToolArc(
    parsed.compartments,
    parsed.unprocessedFrom,
    chunk.completedToolArcs,
    chunk.endIndex,
);

const mapped = mapParsedCompartmentsToChunk(parsed.compartments, chunk, sequenceOffset);
...
const parsedValidationError = validateParsedCompartments(
    parsed.compartments,
    chunk.startIndex,
    chunk.endIndex,
    parsed.unprocessedFrom,
);
```

Both heals run before mapping (`:144`) and before the range checks (`:152`), so
every range-shaped check sees healed ranges. Without the heal, a gap rejects at
`:298` with "gap before message N". With it, the same document passes. That is
the admission, and it is bounded.

**Gap healing, `:39-61`.** The bound is `:53-55`:

```
const fullyInsideToolOnly = toolOnlyRanges.some(
    (range) => range.start <= gapStart && range.end >= gapEnd,
);
if (fullyInsideToolOnly) {
    prev.endMessage = gapEnd;
}
```

A *single* range must cover the gap whole; a gap spanned by two adjacent ranges
does not heal. The mutation is `prev.endMessage = gapEnd` at `:58` and touches no
content field. The doc comment at `:32-35` states the policy: "Never absorb an
unclassified gap. Production replay with the lowest-calibration historian showed
contiguous narrative coverage, so there is no model-quality need for a size-based
escape hatch."

**Terminal arc healing, `:70-98`.** Bounded to `arcs.length + 1` passes (`:80`),
breaking when no change occurs (`:91`), and restricted to arcs ending inside the
chunk (`:85`). It sets `last.endMessage = nextEnd` (`:92`) and rewrites
`unprocessedFrom` to `last.endMessage + 1` only if it was already non-null
(`:95-97`). No content field is read.

**The restamp.** `compartment-runner-mapping.ts:39-52`:

```
const endLine = chunk.lines.find((line) => line.ordinal === compartment.endMessage);
...
endMessageId: endLine.messageId,
```

`compartment.endMessage` is the healed ordinal by this point, so `endMessageId`
is resolved from the healed position. `compartment-storage.ts:14` inserts it as
`end_message_id`, and `compartment-runner-incremental.ts:571` reads it back as
`lastNewEndMessageId` for the compaction marker. So the healed boundary becomes
the durable identity of the compartment, not merely its numeric range.

**What is still checked after a heal.** The healed end must map to a chunk line
(`mapping.ts:41`), the range must stay inside the chunk
(`validation.ts:291-293`), coverage must remain contiguous (`:294-299`), and the
terminal boundary must not split an arc (`:166-171`). What is not checked is
anything about the body.

**Existing coverage.** `compartment-runner-validation.test.ts` covers gap healing
at three sizes, 20, 50, and 200 messages (`:91`, `:105`, `:118`), rejection of
narrative gaps at three sizes (`:133`, `:146`, `:160`), and partial tool-only
coverage refusing to heal (`:146`). Terminal arc healing is covered at `:196` and
`:231`, and `:284-287` asserts the restamped `endMessageId` is `"m3"` after a
heal, which is the clearest existing acknowledgement that the identity moves.
None of these asserts anything about the compartment body.

## Failure scenario

A model summarizes messages 1 through 100 and 151 through 200, skipping 101
through 150 because they are tool traffic. The chunk's `toolOnlyRanges` contains
one entry `{ start: 101, end: 150 }`.

`:58` sets the first compartment's `endMessage` to 150. `mapping.ts:40` resolves
`endLine` at ordinal 150 and `:52` stamps its `messageId`. The compartment now
claims coverage of 101 through 150 with prose written about 1 through 100 only,
and its durable end identity is a message the summary never mentions.
`compartment-runner-incremental.ts:704` then advances the publication floor to
151, and `:695` queues drops through 150.

That is the intended behaviour, and it is safe exactly to the extent that
`toolOnlyRanges` really means "no durable signal here". The property is worth
recording because nothing re-examines the body, and because record 2 establishes
this side keeps no durable raw copy of what was absorbed.

## Timing windows and dependencies

No interleaving window; the heals are synchronous mutations on a local array.

The dependency is on the producer's classification.
`read-session-chunk.ts:797-806` builds `toolOnlyRanges` by merging adjacent
ranges before returning them at `:826`. The single-covering-range requirement at
`:53-55` is therefore satisfiable only because the producer merges; if merging
were incomplete, a genuinely tool-only gap would fail to heal and the run would
reject.

## What a test must construct

1. A chunk with one tool-only range covering a gap whole, and compartments that
   leave that gap.
2. Assert the pass is valid, the previous compartment's `endMessage` is the gap
   end, its `endMessageId` is the chunk line at that ordinal, and every content
   field is byte-identical to the parsed value.
3. The negative: two adjacent tool-only ranges that jointly cover the gap,
   asserting no heal and a rejection.
4. For the arc heal, an arc crossing the proposed terminal boundary with
   `arc.end <= chunkEnd`, asserting the same content-invariance.

Step 2's content assertion is the part no existing test makes.

## Investigation log

### Q: Should a gap spanned by two adjacent tool-only ranges heal?

- Sources examined: `compartment-runner-validation.ts:32-35`, `:39-61`, `:70-98`;
  `compartment-runner-mapping.ts:39-56`; `read-session-chunk.ts:797-806`,
  `:826-827`; `compartment-runner-validation.test.ts:91-193`, `:284-287`.
- Findings: the producer merges adjacent ranges before the consumer sees them
  (`:799-806` compares `last.end + 1` against the next range's start), so in
  practice a contiguous tool-only span arrives as one entry and the single-range
  requirement is not a limitation. Whether the merge is exhaustive for every
  producer, including Pi's, was not established.
- Missing evidence: the range-construction path upstream of `:797`, and the same
  path under Pi's `RawMessageProvider`.
- Conclusion: unresolved, needs confirmation that merging is exhaustive. If it is,
  `:53-55` is a correct and deliberately conservative consumer-side check. If it
  is not, valid runs reject and the failure looks like a model fault.
