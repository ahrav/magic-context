# note-b-check-failure-count-carries-across-compile-and-check-phases

## Discovery trigger

`SmartNoteLifecycleState` carries two failure counters,
`check_failure_count` and `check_network_failure_count`
(`crates/mc-module/src/smart_note_evaluation.rs:294-295`), but the file declares
three failure thresholds: `MAX_COMPILATION_FAILURES` (`:36`),
`MAX_FAILURES_BEFORE_REAUTHOR` (`:38`), and the backoff exponent clamp
(`:357`). Two thresholds reading one counter is the shape that produces a
cross-phase carryover, so I traced which reducer writes which.

## Evidence trail

1. `reduce_check_failure`, the due-phase failure path, increments
   `check_failure_count` and escalates on `MAX_FAILURES_BEFORE_REAUTHOR`:

   ```
   let failure_count = pre.check_failure_count + 1;
   next.check_failure_count = failure_count;
   next.check_status = if failure_count >= MAX_FAILURES_BEFORE_REAUTHOR {
       "failing".to_string()
   } else {
       "compiled".to_string()
   };
   ```
   (`smart_note_evaluation.rs:525-531`)

2. `reduce_compile`'s `CompilationFailed` arm increments the *same* field and
   escalates on a *different* threshold:

   ```
   let failure_count = pre.check_failure_count + 1;
   let mut next = pre.clone();
   next.check_failure_count = failure_count;
   next.check_status = if failure_count >= MAX_COMPILATION_FAILURES {
       "fallback".to_string()
   } else {
       "uncompiled".to_string()
   };
   ```
   (`:455-462`)

3. The two phases are chained by the compile selector, which admits a `failing`
   note: `note.check_status == "uncompiled" || note.check_status == "failing"
   || !note.has_compiled_check || note.policy_version !=
   SMART_NOTE_CHECK_POLICY_VERSION` (`:746-749`). So a note that
   `reduce_check_failure` pushed to `failing` is exactly the note the compile
   phase will pick up next.
4. The only reset is a *successful* compile: `stored.check_failure_count = 0` at
   `:486`, on the `CompiledMet`/`CompiledFalse` path. `reduce_compile`'s failure
   arm returns before reaching it (`:465-468`). `false_fields` also resets both
   counters (`:440-441`), but a note in `failing` is not selected for the due
   phase, so it cannot reach `false_fields` until it recompiles.
5. Both thresholds are 3, confirmed against the frozen fixture's constants block:
   `max_compilation_failures: 3` and `max_failures_before_reauthor: 3` in
   `testdata/smart-note-evaluation-golden.json`, asserted equal to the Rust
   constants at `smart_note_evaluation.rs:1120-1122`. So the numbers agree
   across languages; the sharing of one column is what carries.
6. The demotion is terminal in practice. `reduce_fallback` (`:630-658`) can set
   `status = "ready"` on `Met` but never restores `check_status` to `compiled`;
   its `False` arm re-writes `check_status = "fallback"` (`:651`). The only exit
   from `fallback` is the compile selector, which admits it via
   `!note.has_compiled_check` (`:748`) since a fallback note's artifact was never
   written. So the note can recompile, but it enters that attempt with
   `check_failure_count` at 4 or higher and fails to `fallback` again on the very
   next failure.

## Failure scenario

A note's compiled check has a bug that throws under some repository states.

1. Due-phase check returns `logic_failed`. `check_failure_count` 0 to 1, status
   stays `compiled`, next due at `now + 5 minutes` (`evaluation_backoff_ms(1)` is
   `5 << 0` minutes, `:355-360`).
2. Again: count 2, status `compiled`, backoff 10 minutes.
3. Again: count 3, `3 >= MAX_FAILURES_BEFORE_REAUTHOR`, status becomes
   `failing`, backoff 20 minutes. This is the designed escalation: the check
   needs reauthoring.
4. The compile selector picks the note up (`:747`). The evaluator compiles the
   condition. The model is briefly unavailable, or the compiler prompt returns
   unparseable output, so the outcome is `compilation_failed`.
5. `reduce_compile` computes `3 + 1 = 4`, and `4 >= MAX_COMPILATION_FAILURES`,
   so status becomes `fallback`.

The note reached the read-only fallback evaluator after a single compilation
failure. A note that had never failed a check would have had three attempts. The
difference is invisible: no field records that the count came from a different
phase.

## Timing windows and dependencies

No interleaving. The dependency is a *sequence* of completions across a phase
boundary, each of which is a separate claim-complete round trip. The window
between step 3 and step 4 is the 20-minute backoff written at `:532`, so a test
must either advance a controlled clock past it or construct the pre-state
directly.

The reverse direction also carries, and is worth noting for completeness: a note
with two compilation failures (count 2, status `uncompiled`) that then compiles
successfully resets to 0 (`:486`), so the carryover is one-directional in
practice. A note cannot accumulate compile failures and then be over-escalated
on its first check failure, because reaching the due phase requires
`check_status == "compiled"` (`:721`), which only a successful compile sets.

## What a test must construct

The cheap oracle is entirely pure. No store, no clock, no faults.

1. Build a `SmartNoteLifecycleState` with `check_status = "failing"` and
   `check_failure_count = 3`, representing a note that exhausted its check
   allowance. Every other field can be a default.
2. Reduce with
   `SmartNoteEvaluationOutcome::Compile(CompileOutcome::CompilationFailed)`.
3. Assert `next.check_status == "uncompiled"`, that is, that the note retains a
   compile allowance. It will be `"fallback"`.

The stronger form asserts the property rather than the instance: for every
starting `check_failure_count` in `0..=10` and a `check_status` of `"failing"`,
count how many consecutive `CompilationFailed` reductions are required to reach
`"fallback"`, and assert the count equals `MAX_COMPILATION_FAILURES`. That form
also catches a future threshold change that makes the two numbers differ, which
is when this becomes visible as a behaviour difference rather than only as a
shared-column smell.

To construct it end to end through the store, drive four
`note.evaluation.complete` calls: three `due logic_failed` then one
`compile compilation_failed`, each preceded by a `next` to obtain a claim, with
the clock advanced past each backoff. That exercises the phase chaining too,
which the pure form does not.

## Investigation log

### Q: Is the shared column intentional?

- Sources examined: the two reducer arms (`smart_note_evaluation.rs:455-462`,
  `:525-531`), the two constants and their doc comments (`:35-38`), the field
  declarations (`:294-295`), the fixture constants block, the module header
  (`:1-10`), and `docs/AUDIT-KNOWN-ISSUES.md` searched for a smart-note failure
  counter entry.
- Findings: the doc comments describe the two thresholds in phase-specific terms.
  `:35` says "Consecutive compilation failures before a note enters fallback" and
  `:37` says "Consecutive check failures before a compiled note needs
  reauthoring". Both say "consecutive", and both are true only if the counter is
  per-phase, which it is not: the count is consecutive across the *note*, not
  across the phase. So the comments describe a per-phase counter and the code
  implements a per-note one. That is weak evidence for unintentional, but it is
  not conclusive, because a designer could reasonably hold that a note failing in
  either phase has burned the same trust budget. Both thresholds being 3 is
  consistent with either intent and so distinguishes nothing.
  `AUDIT-KNOWN-ISSUES.md` has no entry.
- Missing evidence: the TypeScript reducer's field layout. If
  `evaluation-state.ts` uses one column too, the behaviour is a faithful port and
  the question moves upstream to the original design. I did not read it in this
  pass, and the golden fixture cannot answer it because its transition cases each
  start from a fresh pre-state and never cross a phase boundary (23 cases, all
  single-transition, read from
  `testdata/smart-note-evaluation-golden.json`).
- Conclusion: needs human input on intent. The mechanism is confirmed and the
  doc-comment wording is evidence that the comments at least are wrong, since
  "consecutive compilation failures" is not what the code counts. Reading
  `evaluation-state.ts` would settle whether this is a port fidelity question or
  a design question, and is the cheaper next step.

### Q: Can a note escape `fallback` at all?

- Sources examined: `reduce_fallback` (`:630-658`), the compile selector's
  predicates (`:743-750`), `get_fallback_smart_notes` (`:788-806`), and
  `NOTE_CAS_UPDATE_SQL` (`mc-store:12844-12871`).
- Findings: two exits. The compile selector admits a fallback note through
  `!note.has_compiled_check` (`:748`), because a note demoted to fallback never
  received an artifact, so it can be recompiled. And a `ctx_note update` with a
  compiler edit resets `check_status` to `'uncompiled'` and
  `check_failure_count` to 0 (`mc-store:12860`, `:12862`), which is the clean
  escape and the one the "needs reauthoring" status name points at.
- Missing evidence: none.
- Conclusion: resolved with answer. Fallback is escapable, but the automatic exit
  re-enters with the inflated counter, so only the user-driven re-author exit
  clears it. That is what makes the carryover matter: the note's own recovery
  path is degraded, and only a human edit restores it.
