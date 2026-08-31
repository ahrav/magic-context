# tshist-a-unprocessed-from-chunk-end-plus-one-short-circuits-coverage

## Discovery trigger

Walking the divergence surface check by check. Part 4a numbers the
`unprocessed_from` family as checks 18, 19, and 20, and flags check 19's arms as
untested on the Rust side. Reading the two implementations side by side showed
they test the same three conditions in a different order, and the order decides
the verdict.

## Evidence trail

All references at `HEAD` = `e447c927`.

**TypeScript,
`packages/plugin/src/hooks/magic-context/compartment-runner-validation.ts:303-322`:**

```
if (unprocessedFrom !== null) {
    // Treat unprocessed_from === chunkEnd + 1 as "fully processed" —
    // historian consumed all messages and reported the next ordinal.
    if (unprocessedFrom === chunkEnd + 1) {
        return null;
    }
    if (unprocessedFrom < chunkStart || unprocessedFrom > chunkEnd) {
        return `<unprocessed_from> ${unprocessedFrom} is outside chunk ...`;
    }
    if (unprocessedFrom !== expectedStart) {
        return `<unprocessed_from> ${unprocessedFrom} does not match next uncovered message ${expectedStart}`;
    }
    return null;
}

if (expectedStart <= chunkEnd) {
    return `output left uncovered messages ${expectedStart}-${chunkEnd} without <unprocessed_from>`;
}
```

`expectedStart` is set by the loop above: initialised to `chunkStart` (`:280`)
and advanced by `expectedStart = compartment.endMessage + 1` (`:300`).

**Rust, `crates/mc-module/src/historian_validate.rs:1054-1075`:**

```
if let Some(unprocessed_from) = unprocessed_from {
    if let Some(expected) = expected_start {
        if unprocessed_from != expected {
            return Some(format!(
                "<unprocessed_from> {unprocessed_from} does not match next uncovered message {expected}"
            ));
        }
        return None;
    }
    if unprocessed_from == chunk_end.saturating_add(1) {
        return None;
    }
    ...
```

`expected_start` there is an `Option`, advanced by
`next_present_after(&chunk_ordinals, compartment.end_message)` (`:1051`), which
is `None` once coverage is complete.

**The difference.** Rust asks "is coverage incomplete?" first, and only allows
`chunk_end + 1` when `expected_start` is `None`. TypeScript asks "is the declared
value `chunkEnd + 1`?" first and returns `null` unconditionally, before either
the range check or the `expectedStart` comparison, and therefore also before the
uncovered-suffix check at `:318-320`.

**The downstream effect, traced.** `validateHistorianOutput` does not return
`unprocessedFrom` at all: the success shape at `:173-182` carries
`compartments`, `facts`, `userObservations`, `primerCandidates`, and `events`. The
runner derives its boundary from the last compartment instead:
`lastNewEnd` at `compartment-runner-incremental.ts:534`, `lastCompartmentEnd` at
`:570`, the floor at `:704`, and the queued drops at `:695`, all from
`lastCompartmentEnd`. The next run's `offset` comes from the last stored
compartment end (`:214-217`). So the uncovered suffix is re-read on the next
firing rather than skipped.

`telemetry.unprocessedFrom` is set to `lastCompartmentEnd + 1` (`:768`), not to
the declared value, so even the telemetry records the derived figure.

**Test coverage.** `compartment-runner-validation.test.ts` covers the gap and
overlap arms at `:133`, `:146`, and `:160`, and contiguous acceptance at `:172`
and `:186`. No case declares `unprocessed_from` alongside an uncovered trailing
suffix.

## Failure scenario

Chunk 1 through 200. The model emits one compartment covering 1 through 150 and
declares `<unprocessed_from>201</unprocessed_from>`, that is, it claims full
processing while summarizing three quarters of the range.

TypeScript: the loop ends with `expectedStart = 151`. `:306` sees
`unprocessedFrom === 201 === chunkEnd + 1` and returns `null`. The pass is valid.

Rust: `expected_start` is `Some(151)`, `151 != 201`, so `:1056-1060` rejects with
"does not match next uncovered message 151".

Same document, opposite verdicts. That is the whole finding, and it is why the
frozen corpus cannot be authoritative for both implementations.

## Timing windows and dependencies

None. Both are pure functions over the parsed shape. The divergence is static
branch ordering.

## What a test must construct

1. A chunk `1..N` and a model output covering `1..k` with `k < N`, declaring
   `<unprocessed_from>N + 1</unprocessed_from>`.
2. Assert `validateHistorianOutput` returns `ok: true`.
3. Assert the runner's derived floor is `k + 1`, not `N + 1`, so the suffix is
   re-read. That second assertion is what keeps the impact statement honest: the
   divergence is real and the data loss is not.
4. As a differential, feed the same fixture to the Rust gate and assert the
   rejection. That requires the harness record 9 says does not exist.

## Investigation log

### Q: Does any consumer besides telemetry read the declared `unprocessed_from`?

- Sources examined: `compartment-runner-validation.ts:173-182` (the success
  shape), `:303-322`; `compartment-runner-incremental.ts:534`, `:570`, `:695`,
  `:704`, `:768`; `compartment-parser.ts:251-252` (where it is parsed) and
  `:293` (where it is returned from the parser).
- Findings: the parser returns `unprocessedFrom` in `ParsedCompartmentOutput`
  (`:51`, `:293`), and `validateHistorianOutput` consumes it internally at `:137`
  and `:156` but omits it from its own result. Within `packages/plugin` no
  publish-path consumer reads a declared value.
- Missing evidence: `pi-historian-runner.ts` was read only at its five validator
  call sites and its chunk construction. Its own telemetry may or may not derive
  `unprocessedFrom` the same way.
- Conclusion: unresolved, needs a Pi-side sweep. For the OpenCode path the answer
  is settled: nothing downstream reads it, which bounds the impact to an
  accepted-set divergence.
