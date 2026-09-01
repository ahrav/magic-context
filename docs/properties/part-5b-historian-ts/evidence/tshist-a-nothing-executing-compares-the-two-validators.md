# tshist-a-nothing-executing-compares-the-two-validators

## Discovery trigger

Task 3 asks what currently enforces agreement between the two implementations.
Part 4a already established that the Rust gate's parity tests never run. The
question left open was whether anything on the *TypeScript* side closes the loop,
since the TypeScript side is the one CI executes.

## Evidence trail

All references at `HEAD` = `e447c927`.

**The artifact built for the comparison exists.**
`crates/mc-module/gen/gen-validate-golden.ts`, 665 lines. Its docstring, `:1-9`:

> Generate the differential historian OUTPUT VALIDATION golden for the Rust
> mc-module port. Drives the real TypeScript parser/validator from
> packages/plugin via Bun.resolveSync, then applies the pure publication-time
> discard-last rule that currently lives in the incremental runner. [...]
> Run: bun crates/mc-module/gen/gen-validate-golden.ts

It really does drive the real implementation: `:17-18` are
`await import(resolve("./src/hooks/magic-context/compartment-parser"))` and
`await import(resolve("./src/hooks/magic-context/compartment-runner-validation"))`,
resolved against `packages/plugin` (`:14-15`). `:662-663` writes the result to
`crates/mc-module/testdata/validate-golden.json`, and `:665` logs the case count.

**The golden is checked in and is 16 cases.** Parsed at `HEAD`:
`crates/mc-module/testdata/validate-golden.json` is a 16-element array whose
elements carry `input`, `label`, `parsed`, and `validation`.

**Its consumer never executes.**
`crates/mc-module/src/historian_validate.rs:1384-1387`:

```
fn validate_golden_matches_typescript_oracle() {
    let raw = include_str!("../testdata/validate-golden.json");
    let cases: Vec<GoldenCase> = serde_json::from_str(raw).expect("parse validate golden");
    assert!(!cases.is_empty(), "empty validate golden");
```

Part 4a establishes that no in-crate `mc-module` unit test is compiled in CI:
the only `mc-module` invocation in any workflow is
`cargo test -p mc-module --test lifecycle_cli`, which selects one integration
binary and does not build `--lib`. Two sibling parity tests sit beside it,
`five_message_narrative_gap_rejects_like_typescript_validator` (`:1426`) and
`twenty_message_tool_only_gap_heals_like_typescript_validator` (`:1443`), and are
ungated for the same reason. Cited from Part 4a, not re-derived.

**Nothing regenerates or freshness-checks the golden.** Searched
`.github/`, the root `package.json`, `crates/mc-module/Cargo.toml`, and
`scripts/` for `gen-validate-golden` and `validate-golden`: zero hits. The only
occurrence of the generator's name outside its own file is in
`piolium/attack-surface/candidates.jsonl`, an unrelated scan artifact. So the
golden is a manual snapshot with no staleness gate.

**Two structural holes in the artifact, independent of staleness.**

1. Its chunk shape omits completed tool arcs. `:39-45`:

```
interface ChunkJson {
    start_index: number;
    end_index: number;
    lines: Array<{ ordinal: number; message_id: string }>;
    tool_only_ranges: Array<{ start: number; end: number }>;
}
```

`tool_only_ranges` at `:44`, used at `:192` and `:224`, and no arc field
anywhere in the file. Rust check 21 and both heal paths that depend on
`completed_tool_arcs` (`historian_validate.rs:64`) therefore cannot appear in any
of the 16 cases.

2. It hardcodes the healing slack. `:38` is
`const BOUNDARY_HEALING_SLACK = 2;`, used at `:358`, while
`compartment-runner-validation.ts:11` exports
`export const HISTORIAN_BOUNDARY_HEALING_SLACK = 2;`. The generator imports the
parser and the validator through `Bun.resolveSync` but not this constant, so
changing the slack in the plugin leaves the golden generated against the old
value.

**The nearest executing check is a single pinned string.**
`compartment-runner-validation.test.ts:215-229` is titled "rejects the exact Rust
error when the completed result is beyond the chunk" and asserts

```
expect(result).toEqual({
    ok: false,
    error: "Historian terminal boundary splits a completed tool invocation/result arc",
});
```

That runs at `ci.yml:257`. It pins one error string against a value copied from
Rust by hand. It executes no Rust and would not notice a Rust-side behaviour
change that kept the string.

## Failure scenario

Somebody edits `compartment-runner-validation.ts:306` to fix the
`unprocessed_from` ordering (record 5). Full CI goes green: the plugin suite runs
and passes, the freeze lint's fingerprints do not move (record 10), and the
mutation battery's baseline assertion still holds because the change makes the
gate *stricter* on a shape no baseline uses. The Rust gate is untouched and now
agrees. Nothing reports either the divergence or its repair.

The inverse is worse. Somebody makes the TypeScript gate more permissive. Same
green CI, and the divergence widens silently.

## Timing windows and dependencies

No timing window. This is a pipeline property, evaluated per commit.

The dependency is the missing step: a CI job that regenerates the golden and
either fails on a diff or feeds both implementations the same corpus and compares
verdicts. Part 4a's fault map already ranks joining the two lanes second by
leverage.

## What a test must construct

Not a test but a gate, in two parts.

1. Freshness: run `bun crates/mc-module/gen/gen-validate-golden.ts` in CI and fail
   on a non-empty `git diff` of `crates/mc-module/testdata/validate-golden.json`.
   That catches TypeScript drift against the snapshot.
2. Agreement: build the golden's chunk shape to include `completed_tool_arcs`,
   import the slack from `compartment-runner-validation.ts` instead of
   hardcoding it, and execute the Rust consumer, which requires compiling
   `mc-module`'s `--lib` target in some job.

Part 2 is the one that does not exist today. Part 1 is one workflow step and
would answer the open question below as a side effect.

## Investigation log

### Q: Would regenerating the golden today change it?

- Sources examined: `gen-validate-golden.ts:1-45`, `:38`, `:192`, `:224`,
  `:358`, `:662-665`; `crates/mc-module/testdata/validate-golden.json` (16 cases,
  four keys each); `historian_validate.rs:1384-1387`, `:1426`, `:1443`; searches
  for the generator's name across `.github/`, `package.json`,
  `crates/mc-module/Cargo.toml`, and `scripts/`.
- Findings: nothing invokes the generator automatically, so any TypeScript change
  since the last manual run is unreflected. The git history of the two files was
  not compared, which is the cheap way to bound the staleness.
- Missing evidence: a generator run in a clean tree, and a `git log` comparison of
  the last modification dates of `validate-golden.json` against
  `compartment-runner-validation.ts` and `compartment-parser.ts`.
- Conclusion: unresolved, needs a generator run. This is the single cheapest
  measurement in the part of how far the two implementations have already drifted,
  and it is one command. I did not run it because the method contract forbids
  modifying the source tree, and the generator writes into it.
