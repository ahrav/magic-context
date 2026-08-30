# render-a-duplicate-tool-use-repair-is-release-only

## Discovery trigger

`enforce_unique_tool_use_ids` is one of the two functions the Part 4 scope map
names as a production output guard. Reading it to find what it actually panics on
showed that its two behaviours are selected by `debug_assertions`, and that the
test for the shipped behaviour is gated the same way.

## Evidence trail

All references read back at `HEAD` `e447c927`, in
`crates/mc-module/src/transform.rs`.

The function's own doc comment states the design (`:11227-11230`):

```
/// Last-resort provider-validity belt. The normal ingress and render paths must keep tool-use ids
/// unique; debug and test builds fail at the first violation so the originating path is fixed.
/// Release builds report every violation and remove only later owners (plus an otherwise orphaned
/// adjacent result) rather than trapping a live session in a deterministic provider-400 loop.
```

The body (`:11231-11305`):

- `:11235` — `duplicate_tool_use_locations(&messages)`, defined at `:11156-11169`.
  It scans in message-then-block order and reports every `ToolCall` id it has
  already seen, as `(id, message_index, block_index)`. `seen` is a `HashSet` used
  only through `insert`, and the output `Vec` order follows the scan, so the
  result is deterministic.
- `:11236-11238` — the common case returns the array untouched.
- `:11240-11245` — one `eprintln!` per duplicate, tagged
  `mc-module: duplicate_tool_use_id ... action=drop_later`.
- `:11246-11249` — `debug_assert!(duplicates.is_empty(), ..)`. In a debug build
  this panics, so the two lines after it never run.
- `:11251` — `#[cfg(not(debug_assertions))]` opens the repair block.
- `:11254-11257` — `remove_positions` starts as the duplicate positions.
- `:11258-11277` — for each duplicate whose owner message would be left with no
  blocks, the adjacent `ToolResult` with the same id in `message_index + 1` is
  also queued for removal. This is the orphan-avoidance step.
- `:11279-11300` — rebuild. A message with no queued removals is pushed as-is; a
  message with removals is rebuilt by `filter_map`, and **pushed only if
  `content` is non-empty** (`:11297-11299`). So a message can leave the array.
- `:11303-11304` — `#[cfg(debug_assertions)] messages`, the unmodified array. Dead
  in practice because the `debug_assert!` above already panicked.

Call site: `out = enforce_unique_tool_use_ids(out, &req.session_id)` at `:12147`,
the last statement before `BuiltOutput` is assembled at `:12150-12155`.

The tests, and their gates:

- `:11501-11509`, `duplicate_tool_use_belt_panics_in_test_builds`, carries
  `#[cfg(debug_assertions)]` at `:21501` and `#[should_panic(expected = "served
  output contains duplicate tool_use ids")]` at `:21503`.
- `:21512-21514`, `duplicate_tool_use_belt_drops_later_owner_and_result_in_release`,
  carries `#[cfg(not(debug_assertions))]` at `:21512`. Its assertions at
  `:21524-21528` check `duplicate_tool_use_locations(&healed).is_empty()`,
  `healed.len() == 2`, and that the survivors are the first call and the first
  result.

A default `cargo test` builds the test profile with `debug-assertions = true`, so
the second test does not compile into the binary. And per the scope map
(`docs/properties/part-4-module/_lenses/scope-map-and-risk-ranking.md:409-430`),
no `mc-module` lib test runs in CI at all: the only `mc-module` test invocation is
`cargo test -p mc-module --test lifecycle_cli` (`ci.yml:167-168`).

The corresponding build step, `ci.yml:164-165`, runs
`cargo build -p mc-module --bin ck-mc-host` with no `--release`, so the artifact
CI produces has `debug_assertions` on and takes the panicking arm.

Note the ordering interaction with the serialized-output cache: every
`record_output_item` call (`:11725`, `:11746`, `:11821`, `:12077`, `:12108`)
happens before `:12147`, so `cache_entries` holds the pre-repair message while
`messages` holds the repaired one.

## Failure scenario

Release build. Some upstream path — a reduction that re-emits a call, a codec
that duplicates a block, a lineage rebase — produces two `ToolCall` blocks with
the same id. The belt removes the later owner's block. That message had only that
block, so it is removed from the array, and its adjacent `ToolResult` is removed
too. Two messages leave the served context. The only trace is two stderr lines,
which a daemon's log may or may not retain, and which no response field or metric
counts. The agent's view of the conversation loses a tool exchange with no signal.

Debug build. The same input panics inside `build_output_with_tags_inner`, so the
pass fails. Whether the handler turns that into a clean error frame or an aborted
process depends on the unwind boundary, which is outside 4e's scope.

## Timing windows and dependencies

No temporal window; the belt runs once per render. The dependency that matters is
the build profile, which is fixed at compile time. The two arms are mutually
exclusive, so exactly one is ever executed by a given artifact, and the other has
no coverage in that artifact.

## What a test must construct

1. The invariant half, profile-independent: after any accepted pass, assert
   `duplicate_tool_use_locations(&built.messages).is_empty()`. This holds in both
   profiles — trivially in debug because the pass panicked instead.
2. The coverage half, asserting independent preconditions only: observe a pass in
   which `duplicate_tool_use_locations` returned non-empty at `:11235`, and record
   which profile the artifact was built with. Never assert the mismatch itself.
3. Make the release arm reachable in CI. The existing release test is correct; it
   simply is not compiled. Adding a `cargo test -p mc-module --release` job, or
   splitting the belt's repair into a profile-independent function with the
   `debug_assert` at the call site, would give both arms coverage.
4. For the reported half: assert that a repair which removes a whole message
   increments something a caller can read. It does not today.

## Investigation log

### Q: Does the debug arm ever reach the repair block?

- Sources examined: `transform.rs:11246-11249`, `:11251`, `:11303-11304`.
- Findings: no. The `debug_assert!` fires whenever `duplicates` is non-empty, and
  the repair block is `#[cfg(not(debug_assertions))]`, so in a debug build the
  function either returns early at `:11237` or panics at `:11246`. The
  `#[cfg(debug_assertions)] messages` tail expression at `:11304` is only there to
  give the function a return value under that cfg.
- Missing evidence: none.
- Conclusion: resolved with answer — the two arms are disjoint and the debug arm
  cannot repair.

### Q: Which profile does the shipped binary use?

- Sources examined: `.github/workflows/ci.yml:164-165` and `:167-168`.
- Findings: the CI build is `cargo build -p mc-module --bin ck-mc-host`, with no
  `--release`, so the CI artifact is a debug build. The scope map confirms this is
  the only `mc-module` build step in the workflow set.
- Missing evidence: whatever pipeline produces the distributed artifact, which is
  not in `.github/workflows/`.
- Conclusion: unresolved, needs the release pipeline. This matters because the arm
  that ships is the arm whose test is not compiled.

### Q: Is the removal recorded anywhere a caller can see?

- Sources examined: `transform.rs:11240-11245`, `:11001-11006` (`BuiltOutput`),
  `:11140-11154` (`record_output_item` and `SerializedOutputCacheStats`),
  `:10894-10909` (`BuildOutputTimings`).
- Findings: only the `eprintln!`. No field, counter, or timing records a repair.
- Missing evidence: none.
- Conclusion: resolved with answer — stderr only.
