# cli-a-doctor-fixes-and-fails-in-the-same-pass

## Discovery trigger

`cli-a-opencode-doctor-exit-code-reflects-unresolved-failures` is a
code-reading finding: the `issues > 0 && fixed > 0` arm at
`doctor-opencode.ts:1432-1433` falls through to `return 0`. A code-reading finding
about a conditional is easy to dismiss as contrived, so the campaign needs a
record that forces the operational state to occur. This is that record, and it
also answers the framing question about whether the state is common: it is what an
upgrading user produces on their first doctor run.

## Evidence trail

The two preconditions are independent and each has multiple ordinary sources.

**Precondition (a), `fixed > 0`.** Every site that increments `fixed` in
`packages/cli/src/commands/doctor-opencode.ts`:

- The deprecated-key migration block, `:767-985`. It parses
  `magic-context.jsonc` (`:769-770`), mutates the object, and writes it back at
  `:979-981` when `mcChanged`. Inside it:
  - `experimental.compaction_markers` removed (`:834-841` region; the comment
    block at `:773-792` explains that the flag lived in two places and that the
    feature is mandatory as of v0.21.4).
  - top-level `compaction_markers` removed.
  - graduated `experimental.*` keys migrated to their new homes, logging
    "Migrated experimental.<key> → <dest><key> (graduated)".
  - `migrateLegacyAgentEnabledConfigForDoctor` (`:98-150`) removing
    `dreamer.enabled`, `sidekick.enabled`, or `historian.enabled` and, for the
    two agents, converting a legacy `enabled === false` into `disable = true`.
    Its `fixes` counter (`:103`, `:113`, returned at `:150`) is added to `fixed` by the caller.
  - the Dreamer v2 on-disk migration via
    `packages/cli/src/lib/migrate-dreamer-v2-doctor.ts`, which converts the v1
    window schedule, `tasks` array, `user_memories`, `pin_key_files`,
    `task_timeout_minutes`, and `max_runtime_minutes` into the v2 per-task record
    and deletes the legacy keys (`:271-275`).

Every one of those is a shape an earlier release wrote, so an upgrading user
supplies at least one without doing anything. `migrateLegacyAgentEnabledConfigForDoctor`
is the most likely in the field, because the plugin loader has been migrating
`dreamer.enabled` in memory and telling users to "run doctor to persist"
(`packages/plugin/src/config/agent-disable.ts:68`) — so users have been
instructed to produce exactly this state.

**Precondition (b), a failure the run does not repair.** `fail()` (`:643-647`)
increments both `failCount` and `issues`. Sites reachable on an ordinary install:

- OpenCode CLI found but not executable (`:695`).
- `magic-context.jsonc` parse failure (`:738-741`) or load failure (`:759-763`).
- Missing or wrong plugin entry in `opencode.jsonc` (`:987-1084`).
- `PRAGMA integrity_check` not `ok` (`:1270-1273`) or throwing (`:1274-1277`).
- Failure to open the shared database (`:1312-1315`).
- Version-lane fence alarm (`:1261-1262`, `:1305-1311`).
- Embedding problems via `:1237-1238`, including a broken `onnxruntime-node`
  under the **default** local provider. `checkLocalEmbeddingRuntimeForDoctor`
  (`:406-422`) returns `{issues: 1, localRuntimeBroken: true}` when
  `isLocalEmbeddingRuntimeBroken(runtime)` holds, and the comment at `:399-405`
  records why this matters: on Windows the native binary download is sometimes
  interrupted, and the plugin's static `import "onnxruntime-node"` then throws on
  every embedding. `checkEmbeddingConfig:428-432` routes the **no-config** case
  through the same helper because local is the default provider.

**Independence.** (a) is a property of the contents of `magic-context.jsonc`.
(b) is a property of the environment: an npm install, a filesystem, a network, a
database file. Nothing couples them, which is what makes this a legitimate
coverage record under METHOD.md's rule that a coverage check asserts the
independent preconditions rather than the violation.

**The arm's condition is exactly the conjunction.** `:1432` is
`} else if (issues > 0 && fixed > 0) {`. Because `fail()` moves `issues` and every
`fixed++` site moves `fixed`, any (a)-and-(b) pair satisfies it. No third
condition is involved.

**Nothing observes it today.** `doctor-opencode.test.ts` (369 lines) contains no
reference to `runDoctor`, so no test has ever executed `:1427-1441` at all, let
alone with both counters positive. The `fixed`-only arm at `:1434-1435` and the
`issues`-only arm at `:1436-1438` are equally unobserved.

## Failure scenario

This record's "failure" is the campaign never producing the state, so the defect in
`cli-a-opencode-doctor-exit-code-reflects-unresolved-failures` stays theoretical
and gets triaged as low priority.

The operational state it must produce, concretely: a user upgrades Magic Context.
Their `magic-context.jsonc` still carries `dreamer: {enabled: false}` because a
previous plugin run told them to run doctor to persist the migration. Their
`onnxruntime-node` install is broken from an interrupted download. They run
`magic-context doctor`. The doctor migrates `dreamer.enabled=false` to
`dreamer.disable=true` and writes the file (`fixed = 1`, with a `log.warn` at
`:125-128` because that particular migration also disables manual `/ctx-dream`),
and it warns that the local embedding runtime is broken (`issues = 1`,
`failCount = 1`). Summary: `PASS n / WARN m / FAIL 1`. Message: "Found 1 issue(s),
fixed 1. Restart OpenCode to apply." Exit code 0.

## Timing windows and dependencies

No timing angle. Both preconditions are static properties of the fixture and the
environment.

Two dependencies:

- (a) is **one-shot**. Once `:979-981` writes the migrated config, the key is gone
  and a second run cannot re-fix it. So a campaign that runs the doctor twice
  against the same fixture observes the state on run one and the `issues`-only arm
  on run two. A test must therefore either use a fresh fixture per run or assert
  both runs, which is a stronger check: it pins that the same install yields
  different exit codes on consecutive runs.
- The fixture must not accidentally satisfy (b) through the *same* config file
  that supplies (a). A parse failure at `:738-741` would prevent the deprecated-key
  block from parsing at `:769-770` too — its `catch` at `:982-984` warns "Could not
  migrate deprecated config keys in magic-context.jsonc" — so `fixed` would stay 0.
  The failure source must be independent of the config file. That is why the
  scenario above pairs a config-shape fix with an environment failure rather than
  two config problems.

## What a test must construct

1. Fixture config: `{"dreamer": {"enabled": false}}` in `magic-context.jsonc`,
   valid JSONC. This is the highest-fidelity (a) because the plugin has been
   telling users to create it.
2. Fixture environment for (b), choose one that does not touch the config file:
   - a `context.db` whose `PRAGMA integrity_check` is not `ok`, reaching
     `:1270-1273`; or
   - a stubbed embedding probe returning `network_error`, reaching `:1237-1238`;
     or
   - a plugin cache with a broken `onnxruntime-node`, reaching `:406-422`.
   The integrity-check route is the most deterministic and needs no network.
3. Run the doctor once. Assert **both** preconditions independently, without
   reading private counters:
   - (a) `magic-context.jsonc` no longer contains `dreamer.enabled` and now
     contains `dreamer.disable === true`.
   - (b) the captured output contains the failure line for the chosen source.
4. Assert the marker state occurred: the run satisfied (a) **and** (b)
   simultaneously. Per METHOD.md's coverage rule, do **not** assert the exit code
   here — that belongs to
   `cli-a-opencode-doctor-exit-code-reflects-unresolved-failures`. A marker with a
   constant, globally unique name such as
   `doctor_run_applied_fix_with_unresolved_failure` is what this record wants, and
   because it fires on the two preconditions rather than on the wrong exit code, it
   keeps firing after the defect is fixed.
5. Run the doctor a second time against the same directory and assert (a) no
   longer holds while (b) still does, which demonstrates the one-shot nature and
   is the cheapest way to show the exit code changing between two runs of an
   unchanged install.

The seam problem is the same as for the exit-code record: `runDoctor`
(`doctor-opencode.ts:617-619`) takes only `{force, issue}` and imports its
prompts and detectors directly, so this needs either a `deps` object in the style
of `doctor-pi.ts:107-131` or module mocks. Because step 3 asserts only file
contents and captured output, module mocks are sufficient here — no return-value
inspection is needed.

## Investigation log

### Q: Which (a) key should the fixture use?

- Sources examined: `doctor-opencode.ts:98-150`
  (`migrateLegacyAgentEnabledConfigForDoctor`), `:122-140` (the dreamer arm and
  its `logs.warn` vs `logs.success` split), `:767-985` (the whole block),
  `:773-792` (the `compaction_markers` comment);
  `packages/cli/src/lib/migrate-dreamer-v2-doctor.ts:1-13` (its own doc, stating
  it mirrors the plugin's in-memory migration and is idempotent), `:271-275`;
  `packages/plugin/src/config/agent-disable.ts:64-73` (the in-memory migration
  whose warning text tells the user to "run doctor to persist").
- Findings: `dreamer.enabled = false` is the best fixture for three reasons.
  First, users are actively instructed to create it by the plugin's own warning.
  Second, it is the only `fixed++` path that emits `logs.warn` rather than
  `logs.success` (`:125-128`), because the migration also disables manual
  `/ctx-dream` — so the fixture exercises a warning-and-fix path rather than a
  plain fix, which is closer to the messy real case. Third, it is a two-line
  fixture. `experimental.compaction_markers` is equally valid and slightly
  simpler but has no warning arm. The Dreamer v2 migration is the richest but
  needs a full v1 dreamer block, which makes the fixture harder to read and
  couples the test to a second module.
- Missing evidence: no data on which legacy shape is actually most common in the
  field; the reasoning above is from the code's own guidance, not from telemetry.
- Conclusion: unresolved, needs a fixture decision, with
  `dreamer.enabled = false` recommended and the reasoning recorded so the choice
  does not have to be re-litigated.

### Q: Can (a) and (b) be satisfied by one config file, which would make the record's independence claim wrong?

- Sources examined: `doctor-opencode.ts:726-764` (the parse and load checks),
  `:739-742` (`fail` on parse failure), `:757-761` (`fail` on load failure),
  `:750-756` (the warning path for `configWarnings`), `:767-985` and its
  `catch` at `:982-984`.
- Findings: a config that fails to **parse** blocks both, since `:769-770` parses
  the same file and its `catch` warns rather than fixing, so `fixed` stays 0 and
  (a) fails. But a config that parses and fails to **load through the schema** at
  `:757-761` does satisfy both from one file: `loadPluginConfig` throwing gives
  `fail()`, while `parse` succeeding lets the deprecated-key block run and fix.
  A config with an invalid leaf that produces `configWarnings` takes the `warn`
  path at `:750-754` instead, which does not move `issues`, so that variant does
  not work.
- Missing evidence: what input makes `loadPluginConfig` throw rather than
  degrade. `:744-747` documents that it "recovers from invalid leaf settings
  field-by-field and surfaces soft warnings via configWarnings", so a throw
  requires something coarser than a bad leaf; not established here.
- Conclusion: resolved with answer — the independence claim holds as stated for
  the recommended fixture, and a single-file variant exists in principle via the
  load-failure path but is harder to construct and less representative. Use the
  two-source fixture.
