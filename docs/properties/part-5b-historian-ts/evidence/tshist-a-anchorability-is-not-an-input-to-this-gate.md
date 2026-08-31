# tshist-a-anchorability-is-not-an-input-to-this-gate

## Discovery trigger

Part 4a's check 9 is "a compartment whose end line is not `anchorable` or whose
`message_id` is empty, so publication cannot mint an unanchorable coverage
boundary". Looking for the TypeScript counterpart meant looking at the chunk type
the gate accepts, and the field is not in it.

## Evidence trail

All references at `HEAD` = `e447c927`.

**Rust's chunk line carries the flag.**
`crates/mc-module/src/historian_validate.rs:39` is `pub anchorable: bool`, a
field of `ChunkLine`; `:51` is `pub lines: Vec<ChunkLine>` on the chunk. Part 4a
attributes check 9 to `:958-963`.

**The TypeScript chunk line does not.**
`packages/plugin/src/hooks/magic-context/compartment-runner-validation.ts:13-21`:

```
export interface HistorianValidationChunk {
    startIndex: number;
    endIndex: number;
    lines: Array<{ ordinal: number; messageId: string }>;
    /** Optional — when provided, gaps inside these ranges heal at any size. */
    toolOnlyRanges?: ReadonlyArray<{ start: number; end: number }>;
    /** Completed invocation/result arcs visible in the raw snapshot. */
    completedToolArcs?: ReadonlyArray<{ start: number; end: number }>;
}
```

Two fields per line, neither of them an anchorability signal.

**Nothing checks `messageId` either.**
`packages/plugin/src/hooks/magic-context/compartment-runner-mapping.ts:39-46`:

```
const startLine = chunk.lines.find((line) => line.ordinal === compartment.startMessage);
const endLine = chunk.lines.find((line) => line.ordinal === compartment.endMessage);
if (!startLine || !endLine) {
    return { ok: false, error: `Compartment range ... does not map to raw session lines ...` };
}
```

The predicate is `line.ordinal === ...` only. `:51-52` then copies
`startLine.messageId` and `endLine.messageId` into the candidate row with no
emptiness test, and `compartment-storage.ts:14` inserts
`end_message_id` from that value.

**Why an unresolvable end id matters downstream.**
`compaction-marker-manager.ts:26` imports `getCompartmentsByEndMessageId`
(defined at `compartment-storage.ts:285`), and
`compartment-runner-incremental.ts:571` reads `lastNewEndMessageId` from the last
persisted compartment and, on the deferring arm, writes it into the pending
marker blob at `:710`. The blob is only written when `lastNewEndMessageId` is
truthy (`:707`), so an empty id silently skips the deferred marker request rather
than failing it.

**The producer side.** `read-session-chunk.ts:205-207` declares
`toolOnlyRanges` and `completedToolArcs` on the chunk it returns, and `:823-827`
returns `lines: lineMeta` with both range arrays. So the shipped producer fills
the two optional fields; it does not and cannot fill an anchorability flag,
because the type has no slot for one.

## Failure scenario

A chunk line whose `messageId` is the empty string, at the ordinal a model
proposes as a compartment end.

`mapping.ts:40` finds the line by ordinal. `:52` stamps `endMessageId: ""`. The
compartment commits at `compartment-runner-incremental.ts:648`. The deferred
marker blob is skipped because `:707` tests `lastNewEndMessageId` for truthiness.
`getCompartmentsByEndMessageId` can never resolve the row. The coverage boundary
exists in the compartment table and is unfindable by id, so any later repair path
that works from message ids cannot see it.

On the Rust side the same input is refused before publication.

## Timing windows and dependencies

No timing window. The dependency is entirely on the producer: whether
`read-session-chunk.ts` and Pi's provider can emit an empty `messageId`, and
whether either has a notion of an unanchorable line that it currently drops
silently instead of reporting.

## What a test must construct

1. A `HistorianValidationChunk` with one line whose `messageId` is `""` at the
   ordinal the fixture's compartment ends on.
2. Assert `validateHistorianOutput` returns `ok: true` and the resulting
   candidate's `endMessageId` is `""`.
3. Assert, through the runner, that the committed row carries the empty id and
   that the deferred marker blob was skipped.

Step 1 is trivially constructible because the type permits it. That is the point:
no fault injection is needed to reach a state the Rust gate treats as fatal.

## Investigation log

### Q: Can `read-session-chunk.ts` emit a line with an empty `messageId`, and does Pi's provider differ?

- Sources examined: `compartment-runner-validation.ts:13-21`;
  `compartment-runner-mapping.ts:21-60`; `read-session-chunk.ts:205-207`,
  `:797-807`, `:820-830`; `compartment-runner-incremental.ts:571`, `:707-713`;
  `compartment-storage.ts:14`, `:285`.
- Findings: the two shipped runners both build the chunk with the same
  `readSessionChunk` (`compartment-runner-incremental.ts:353`,
  `pi-historian-runner.ts:625`), so if the answer is "no" it is no for both. The
  construction of `lineMeta` itself was not read; only the return site at `:824`
  was.
- Missing evidence: the body of `readSessionChunk` between roughly `:600` and
  `:800`, which is outside 5b's file set and was read only at the four cited
  lines.
- Conclusion: unresolved, needs a read of the `lineMeta` construction in
  `read-session-chunk.ts`. The property stands regardless: the gate cannot refuse
  the state, so the guarantee is a producer obligation with no enforcement at the
  boundary, and Rust enforces it at the boundary.
