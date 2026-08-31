# tshist-a-coverage-advance-ignores-ordinal-presence

## Discovery trigger

Comparing the coverage loops of the two implementations line by line while
building the divergence table. Rust advances expected coverage through a
present-ordinal set; TypeScript adds one. That is a divergence in the rejecting
direction, which is the direction the size asymmetry does not predict.

## Evidence trail

All references at `HEAD` = `e447c927`.

**TypeScript,
`packages/plugin/src/hooks/magic-context/compartment-runner-validation.ts:274-301`:**

```
let expectedStart = chunkStart;

for (const [index, compartment] of compartments.entries()) {
    ...
    if (compartment.startMessage !== expectedStart) {
        if (compartment.startMessage < expectedStart) {
            return `overlap before message ${expectedStart} (saw ...)`;
        }
        return `gap before message ${compartment.startMessage} (expected ${expectedStart})`;
    }
    expectedStart = compartment.endMessage + 1;
}
```

`:300` is plain arithmetic. There is no reference to `chunk.lines` anywhere in
`validateParsedCompartments`; its parameters are the compartments, `chunkStart`,
`chunkEnd`, and `unprocessedFrom` (`:274-279`).

**Rust, `crates/mc-module/src/historian_validate.rs:1046-1052`:**

```
            return Some(format!(
                "gap before present message {} (expected {expected})",
                compartment.start_message
            ));
        }
        expected_start = next_present_after(&chunk_ordinals, compartment.end_message);
    }
```

Two differences visible in six lines. The advance consults `chunk_ordinals`, and
the error text says "gap before present message", which is a deliberate wording
difference from TypeScript's "gap before message".

**The assumption is enforced, but somewhere else.**
`validateChunkCoverage` (`compartment-runner-validation.ts:325-347`) is exactly
the contiguity guard:

```
let expectedOrdinal = chunk.startIndex;
for (const line of chunk.lines) {
    if (line.ordinal !== expectedOrdinal) {
        return `chunk omits raw message ${expectedOrdinal} while still claiming coverage through ${chunk.endIndex}`;
    }
    expectedOrdinal += 1;
}
if (expectedOrdinal - 1 !== chunk.endIndex) {
    return `chunk coverage ends at ${expectedOrdinal - 1} but chunk end is ${chunk.endIndex}`;
}
```

It is called by the runners, not by the gate: `compartment-runner-incremental.ts:384`,
`pi-historian-runner.ts:652`, `compartment-runner-recomp.ts:360`,
`compartment-runner-partial-recomp.ts:400`. So the gate's arithmetic is valid
because a different function refuses gapped chunks upstream on the two shipped
paths, and the eval scorer synthesizes contiguous ordinals by construction
(`scorer.ts:594-597` builds `lines` from
`Array.from({ length: endIndex - startIndex + 1 })`).

**Which means the two implementations model the chunk differently.** Rust's chunk
carries a present-ordinal set and tolerates holes in it. TypeScript's chunk is
required to be hole-free. Part 4a's check 3 is Rust's own version of the
contiguity check and it validates "OUR input, not the model's", per its lens
note; the difference is that Rust validates it and then still handles holes,
while TypeScript validates it and then assumes none.

## Failure scenario

A caller hands the gate a chunk whose `lines` are ordinals 1 through 10 and 12
through 20, with `startIndex` 1 and `endIndex` 20, and a model output of one
compartment `1-10` and a second `12-20`.

TypeScript: after the first compartment `expectedStart` is 11. The second starts
at 12, so `:298` returns "gap before message 12 (expected 11)". Valid coverage
rejected.

Rust: `next_present_after(chunk_ordinals, 10)` is `Some(12)`, so the second
compartment matches and the pass proceeds.

On the two shipped paths this cannot happen, because `validateChunkCoverage`
would have failed the run earlier with a different error. So the practical impact
today is the *error the user sees*: a gapped chunk is reported as a chunk-coverage
failure, which is a plugin-side fault, rather than as a historian gap, which is a
model fault. The divergence becomes live for any caller that skips the upstream
check, and the eval scorer is such a caller.

## Timing windows and dependencies

None. Static arithmetic.

The dependency is the same one record 7 names: correctness here is a property of
the caller. The two records are distinct claims about the same seam. Record 7 is
"four checks live in the callers"; this one is "one *assumption* is enforced only
in the callers", which is worse in kind because the gate does not name it.

## What a test must construct

1. A chunk with a hole in `lines` and matching `startIndex`/`endIndex`, plus
   compartments that cover the present ordinals exactly.
2. Assert `validateHistorianOutput` returns `ok: false` with a gap message,
   documenting that valid coverage is refused.
3. Assert `validateChunkCoverage` on the same chunk returns non-null, so the
   shipped runners never reach step 2.

Steps 2 and 3 together are the honest statement: a divergence exists and the
shipped composition hides it.

## Investigation log

### Q: Can a gapped chunk arise in practice, given `readSessionChunk` builds `lineMeta` from a filtered message walk?

- Sources examined: `compartment-runner-validation.ts:274-301`, `:325-347`;
  `historian_validate.rs:1046-1052`; the four `validateChunkCoverage` call sites;
  `read-session-chunk.ts:205-207`, `:820-830`; `scorer.ts:594-599`.
- Findings: `validateChunkCoverage`'s own error text, "chunk omits raw message N
  while still claiming coverage through M", plus the comment at
  `compartment-runner-incremental.ts:391-394` saying "Previously this path was
  silent (no failure count, recovery flag unchanged), making the loop bug
  invisible in diagnostics", is strong evidence that gapped chunks *have* been
  produced in practice. Something filtered messages and left the claimed range
  intact.
- Missing evidence: the `lineMeta` construction inside `readSessionChunk` was not
  read; it sits outside 5b's file set.
- Conclusion: unresolved, needs a read of `read-session-chunk.ts` around
  `:600-800`. The existing diagnostic language makes "yes, it has happened" the
  likely answer, which raises the value of the divergence rather than lowering it.
