# cli-a-opencode-doctor-exit-code-reflects-unresolved-failures

## Discovery trigger

The task asks whether the doctor's verdict can be wrong in the dangerous
direction. Building the doctor diagnosis map put the three harnesses' exit-code
expressions side by side, and two of them derive the code from a failure count
while the third derives it from a four-arm message chain. Reading that chain
showed one arm returns success with failures outstanding.

## Evidence trail

**The OpenCode chain.** `packages/cli/src/commands/doctor-opencode.ts:1427-1441`:

```
console.log("");                                                        :1427
log.message(`Summary: PASS ${passCount} / WARN ${warnCount} / FAIL ${failCount}`);  :1429
if (issues === 0 && fixed === 0) {                                      :1430
    outro("Everything looks good! ✨");                                  :1431
} else if (issues > 0 && fixed > 0) {                                    :1432
    outro(`Found ${issues} issue(s), fixed ${fixed}. Restart OpenCode to apply.`);  :1433
} else if (fixed > 0) {                                                 :1434
    outro(`Fixed ${fixed} issue(s). Restart OpenCode to apply.`);        :1435
} else {                                                                :1436
    outro(`Found ${issues} issue(s) that need manual attention.`);       :1437
    return 1;                                                           :1438
}                                                                       :1439
                                                                        :1440
return 0;                                                               :1441
```

Only `:1438` returns 1. The `:1432` arm — failures present **and** at least one
fix applied — falls through to `:1441`. So `issues = 5, fixed = 1` prints
"Found 5 issue(s), fixed 1" and exits 0.

**The counters.** `:628-647` defines them:

- `pass` (`:635-638`) increments `passCount`.
- `warn` (`:639-642`) increments `warnCount` only, so warnings never affect the
  code. That is defensible and is not this record's concern.
- `fail` (`:643-647`) increments **both** `failCount` and `issues`.

`issues` is also incremented directly in a few places, e.g. `:1226` for a
compatibility warning and `:1237` by `issues += embeddingCheck.issues`. The
important pairing is that `fail()` moves `issues` too, so any failed check
satisfies `issues > 0`. `fixed` is incremented once per repaired condition
throughout `:767-985`.

**Both preconditions are ordinary.** `fixed++` fires for a legacy
`experimental.compaction_markers` or top-level `compaction_markers`
(`:767-985`), for a graduated experimental key, and for a legacy
`dreamer.enabled` / `sidekick.enabled` / `historian.enabled` via
`migrateLegacyAgentEnabledConfigForDoctor` (`:98-150`). Every one of those is a
config an earlier release wrote, so an upgrading user supplies one without
acting. `fail()` fires for a missing OpenCode CLI, an unexecutable binary, a
parse failure, a missing plugin entry, a non-`ok` `integrity_check`
(`:1270-1273`), an `integrity_check` that threw (`:1274-1277`), a failure to open
the shared database (`:1312-1315`), or an embedding problem via
`:1237-1238`.

**No re-check after fixing.** The OpenCode doctor writes its config fixes at
`:979-981` and never re-evaluates the checks that ran before them. So even in the
arms that do exit non-zero, the reported counts describe the pre-fix state.

**The two siblings get it right.**

- `doctor-pi.ts:1034-1085`: `runHealthChecks` returns a `{pass, warn, fail,
  repairPlan}` shape. Without `--force`, `:1084-1085` is
  `prompts.outro(first.fail > 0 ? "Doctor found failures" : "Doctor complete");
  return first.fail > 0 ? 1 : 0;`. With `--force`, `:1061-1081` repairs, **re-runs
  the health checks**, prints a second summary, and returns
  `second.fail > 0 ? 1 : 0` (`:1081`).
- `doctor-omp.ts:446-475`: `:461` is
  `if (!options.force) return first.fail === 0 ? 0 : 1;`, and after repairing it
  re-runs and returns `second.fail === 0 ? 0 : 1` (`:474`).

So the shape the OpenCode doctor lacks exists twice in the same directory.

**Nothing tests it.** `doctor-opencode.test.ts` (369 lines) contains zero
references to `runDoctor`. Its `describe` blocks cover
`migrateLegacyAgentEnabledConfigForDoctor` (`:28-75`),
`checkUserMemoriesDreamerCompatibility` (`:76-...`), the plugin cache
(`:202-...`), and helper logic (`:337-...`). `doctor-pi.test.ts` references
`runDoctor` fifteen times; `doctor-omp.test.ts` drives its own `runDoctor`.

**The command is the default one.** `dispatch.ts:151-157` routes bare `doctor` to
`commands/doctor.ts`, whose `dispatchDoctor` (`:108-127`) calls
`runOpenCodeDoctor` for an OpenCode adapter (`:110-115`). `doctor.ts:99-105`
aggregates: `if (code !== 0) anyFailure = true; ... return anyFailure ? 1 : 0`. So
the wrong 0 propagates to the process exit code unchanged.

## Failure scenario

A team wraps startup in `magic-context doctor && exec opencode`. A user upgrades
from a release that wrote `experimental.compaction_markers`. On first run:

- The deprecated key is removed and `fixed` becomes 1.
- The embedding endpoint is unreachable because the user's `{env:OPENAI_API_KEY}`
  is not exported in that shell — a case `:511-521` warns about specifically —
  so `checkEmbeddingConfig` returns `issues: 1` and `:1237-1238` moves both
  counters.
- `integrity_check` also reports a problem, adding another failure.

Output: `Summary: PASS 9 / WARN 1 / FAIL 2`, then "Found 3 issue(s), fixed 1.
Restart OpenCode to apply." Exit code 0. The wrapper launches the harness. Two
real failures were reported on screen and asserted as success to the shell. On the
**second** run the deprecated key is already gone, `fixed` is 0, the `:1436` arm
is taken, and the exit code becomes 1 — so the same install fails the gate it just
passed, which is the symptom most likely to get this noticed.

## Timing windows and dependencies

No timing angle. Two dependencies:

- The defect needs `fixed > 0`, which is a one-shot condition per deprecated key:
  once written back at `:979-981` the key is gone and later runs cannot re-fix it.
  So the wrong exit code appears on the first run after an upgrade and disappears
  afterwards — a shape that makes it easy to dismiss as a transient.
- `doctor.ts:34-51` returns 1 before any harness doctor runs when a reset marker
  is pending, and `:46-51` explains why. That path is unaffected.

## What a test must construct

The blocker is that `runDoctor` in `doctor-opencode.ts:617` takes only
`{force, issue}` and imports `log`, `note`, `outro`, `spinner`, and `confirm`
directly at `:33-…`, plus `detectOpenCodeInstallations`, `getAvailableModels`,
`fetchNpmLatest`, and `probeEmbeddingEndpoint`. `doctor-pi.ts` by contrast takes a
`deps` object (`:107-131`) which is exactly why it is testable. So either the
OpenCode doctor grows a `deps` seam, or the test mocks modules.

Given a seam or mocks:

1. Fixture: a `magic-context.jsonc` containing
   `{"experimental": {"compaction_markers": true}}` — a real legacy shape that
   `:767-985` removes.
2. Force one independent failure. The cheapest is a `context.db` whose
   `PRAGMA integrity_check` is not `ok`, which routes through `:1270-1273`.
   Alternatively stub the embedding probe to return `network_error`, which
   routes through `:1237-1238`.
3. Run `runDoctor({})`.
4. Assert the deprecated key is gone from the file, confirming `fixed > 0` without
   reaching into internals.
5. Assert the return value is **1**. At `HEAD` it is 0.
6. Assert the printed summary line's `FAIL` count is greater than zero and agrees
   with the exit code, so a fix that silences the summary instead of correcting
   the code does not pass.
7. Sibling pins, cheap and worth having so the three doctors cannot drift again:
   assert `doctor-pi.ts`'s `runDoctor` returns 1 for a `first.fail > 0` fixture
   and `doctor-omp.ts`'s returns 1 for the same, both of which the existing test
   files can already express.

A narrower unit-level alternative, if the seam is not built: extract `:1427-1441`
into an exported `summariseDoctorRun({issues, fixed, passCount, warnCount,
failCount})` returning `{message, code}` and table-test it. That converts the
whole record into a pure-function test and matches how the rest of this file is
already tested.

## Investigation log

### Q: Should the OpenCode doctor adopt the sibling shape, or is "we changed something, restart and re-run" not a failure?

- Sources examined: `doctor-opencode.ts:1430-1441`, `:1433` (the message),
  `:979-981` (the config write-back), `:628-647` (the counters);
  `doctor-pi.ts:1061-1081`, `:1084-1085`; `doctor-omp.ts:461`, `:466-474`.
- Findings: the message at `:1433` — "Found N issue(s), fixed M. Restart OpenCode
  to apply." — reads as though the intent were "a run that changed something is
  not a failure, because the user has an action to take." That is a coherent
  position for the `:1434` arm, where `fixed > 0` and `issues === 0`: everything
  found was fixed, so exit 0 is right. It is not coherent for `:1432`, where
  `issues > 0` explicitly means some issues were **not** fixed, and the message
  itself says so. The two siblings resolve the ambiguity by re-running the checks
  and deriving the code from the second pass, which also fixes the reporting: a
  fix that resolves a failure removes it from the second count, so `fail > 0`
  after repair means genuinely unresolved. That is the shape to adopt, and it is
  strictly more informative than patching the conditional.
- Missing evidence: no comment in `doctor-opencode.ts` explains the arm. The
  comment at `:630-631` says the summary format is "Aligned with Pi doctor" — the
  alignment was applied to the printed summary and not to the exit code, which
  suggests an incomplete port rather than a deliberate divergence.
- Conclusion: needs human input on whether to re-run checks (the sibling shape,
  larger change, better reporting) or to correct the conditional (one line). The
  evidence points at an incomplete port, so the sibling shape is likely the
  intent.

### Q: Do the summary counts and `issues` ever disagree, so the printed FAIL count could be zero while the exit code is 1?

- Sources examined: `:628-647`; every `issues++` and `issues +=` site, notably
  `:1226` (a compatibility warning that increments `issues` via a `log.warn`
  path) and `:1237` (`issues += embeddingCheck.issues`), against `:1238`
  (`if (embeddingCheck.issues > 0) failCount += embeddingCheck.issues`).
- Findings: `fail()` always moves both, and the embedding path at `:1237-1238`
  moves both. `:1224-1227` is the one place that increments `issues` beside a
  `log.warn` without touching `failCount`, so a run whose only problem is that
  compatibility warning would print `FAIL 0` and take the `:1436` arm, exiting 1.
  That is the opposite direction from this record's defect — over-reporting a
  failure — and it is the safe direction, but it does mean the summary line and
  the exit code are computed from two different tallies.
- Missing evidence: none; the two counters are independent by construction.
- Conclusion: resolved with answer — yes, they can disagree, in the safe
  direction, via `:1224-1227`. Recorded because a fix that unifies the tallies
  addresses both this and the record's defect, and because step 6 of the test plan
  must not assume the two are equal today.
