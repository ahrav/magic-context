# note-b-reducer-reads-process-local-timezone-for-durable-schedule

## Discovery trigger

The module header claims purity in strong terms: "Pure functions throughout:
callers supply the pre-state, a phase-scoped outcome, the transition clock, and a
timezone (cron matching is a wall-clock concept; production passes the
machine-local zone)"
(`crates/mc-module/src/smart_note_evaluation.rs:8-10`). The parenthetical names
the production timezone source without naming its consequence, so I traced where
the timezone comes from at the one production call site.

## Evidence trail

1. `crates/mc-module/src/lib.rs:14244` is the only production call to the
   reducer:
   `reduce_smart_note_evaluation(&pre, outcome, note.id, now, &chrono::Local)`.
   `chrono::Local` resolves the process's timezone, which on Linux comes from
   `TZ` or `/etc/localtime` and from the system tzdata.
2. The timezone reaches the durable schedule through two paths.
   `reduce_compile` passes it to `next_smart_note_check_due_at`
   (`smart_note_evaluation.rs:472-478`), and `false_fields` passes it on every
   false outcome (`:439`). `next_smart_note_check_due_at` uses it at `:246` to
   compute the next cron occurrence.
3. `next_occurrence` (`:184-210`) reads civil fields off each candidate instant
   in the supplied zone: `civil.minute()`, `civil.hour()`, `civil.month()`,
   `civil.day()`, and `civil.weekday()` at `:200-203`. So a cron such as
   `0 3 * * *` means 3 a.m. *in whatever zone the evaluating process is in*.
4. The result becomes `check_next_due_at`, a persisted column.
   `false_fields` writes it at `:439`; `reduce_compile` writes it at `:489`;
   `apply_note_evaluation_outcome` copies it into `NoteEvalReducedState` at
   `lib.rs:14268`, and the store writes it in the completion transaction
   (`crates/mc-store/src/lib.rs:13617` is the guarded UPDATE).
5. The jitter compounds the divergence rather than masking it.
   `deterministic_jitter_ms` (`smart_note_evaluation.rs:262-274`) is seeded on
   `{note_id}:{hash}`, so the seed is zone-independent, but its magnitude is
   `min(60s, floor(interval * 0.1))` where `interval` is the clamped
   zone-dependent delta (`:263`). Two zones producing different deltas therefore
   also produce different jitter bounds.
6. The frozen fixture cannot see this. `testdata/smart-note-evaluation-golden.json`
   carries `provenance.timezone = "America/Los_Angeles"`, and the test parses
   that field into a `chrono_tz::Tz` and passes it explicitly
   (`smart_note_evaluation.rs:1102-1108`). The test never uses `chrono::Local`.
7. The clamps do bound the blast radius. `next_smart_note_check_due_at` clamps
   the raw delta to `[SMART_NOTE_CHECK_FLOOR_MS, SMART_NOTE_CHECK_CEILING_MS]`
   at `:253`, and clamps again after jitter at `:255`. Those constants are 5
   minutes and 24 hours (`:18`, `:20`). So the divergence is bounded by one day,
   not unbounded.

## Failure scenario

A project's notes are evaluated by whichever host currently holds the bridge. A
note carries `check_cron = "0 3 * * *"`.

- Host A runs in `America/Los_Angeles`. At `now` = 2026-08-30T12:00 UTC, the next
  local 3 a.m. is 2026-08-31T10:00 UTC, a delta of 22 hours. Clamped to 22 hours,
  jittered by at most 60 seconds.
- Host B runs in `UTC`. The next 3 a.m. UTC is 2026-08-31T03:00 UTC, a delta of
  15 hours.

Both hosts persist their own answer to `check_next_due_at` for the same note and
the same outcome. The due-phase selector orders on that column
(`smart_note_evaluation.rs:728`), so which note a poll selects first depends on
which host last evaluated each note. Nothing detects the inconsistency, because
each write is individually valid.

The same divergence occurs on one host across a tzdata upgrade, or on a laptop
that changes zone, which is the more likely trigger for a single-host
deployment.

## Timing windows and dependencies

No interleaving is required. The dependency is environmental: two processes whose
`chrono::Local` differ, or one process whose zone changes between two
evaluations of the same note. The clamp at `smart_note_evaluation.rs:253` and
`:255` bounds the divergence to the 5-minute-to-24-hour band, so the worst case
is a note checked up to a day earlier or later than the other host intended.

A cron that is `*` in every field, or absent, or invalid, produces
`SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS` (`:251`) and is zone-independent. So the
property only bites for a cron that pins an hour, a day, a month, or a weekday.

## What a test must construct

1. Build a `SmartNoteLifecycleState` with `check_cron = Some("0 3 * * *")` and a
   fixed `check_hash`.
2. Call `reduce_smart_note_evaluation` twice with identical `(pre, outcome,
   note_id, now)` and two different `chrono_tz::Tz` values, for instance
   `America/Los_Angeles` and `UTC`, chosen so the pinned hour falls on opposite
   sides of the clamp.
3. Assert `next.check_next_due_at` is equal. It will not be, which is the point:
   the test documents that the reduction is zone-dependent.

The stronger form asserts the production shape rather than the pure function: run
`apply_note_evaluation_outcome` under two `TZ` environment values and compare the
`NoteEvalReducedState`. That requires either a process-level `TZ` manipulation
(hazardous under a parallel test runner, and the repo already has
`temp-env`-style concerns elsewhere) or threading the timezone through
`apply_note_evaluation_outcome` as a parameter. The parameter change is a fix,
not a test, so the pure-function form is the implementable oracle and the
production form is the one that needs a design decision.

## Investigation log

### Q: Is host-local wall-clock cron intended to be the contract?

- Sources examined: `smart_note_evaluation.rs:8-10` (the purity and timezone
  claim), `:180-183` (`next_occurrence`'s doc comment, which says "First instant
  strictly after `after_ms` whose LOCAL civil time in `tz` matches `cron`" and
  that "DST transitions are handled by construction"), `lib.rs:14244` (the
  `chrono::Local` argument), the golden fixture's `provenance` block, and
  `docs/AUDIT-KNOWN-ISSUES.md` searched for a timezone entry.
- Findings: the code is internally consistent and deliberate about wall-clock
  semantics. The doc comment at `:180-183` shows the author thought carefully
  about the zone, specifically about DST, and chose the stepping construction to
  handle it. Nothing anywhere states whether the zone is expected to be stable
  across hosts. No configuration path pins a per-project timezone; a grep for a
  timezone config leaf found none. `AUDIT-KNOWN-ISSUES.md` has no entry on this.
- Missing evidence: the TypeScript reducer's own timezone source. If the
  TypeScript side also uses the machine-local zone, then the two
  implementations agree per host and the cross-language fixture claim holds, and
  the finding is purely about cross-host consistency. If the TypeScript side
  pins a zone, the two authorities disagree per host too. I did not read
  `packages/plugin/src/features/magic-context/smart-notes/schedule.ts` in this
  pass.
- Conclusion: needs human input. The mechanism is confirmed; whether it is a
  defect depends on a design intent that is not written down. The narrower
  sub-question (does the TypeScript side pin a zone) is resolvable and worth
  answering first, because it decides whether this is one finding or two.

### Q: Can `chrono::Local` fail or shift mid-process?

- Sources examined: `next_occurrence`'s `.single()?` at
  `smart_note_evaluation.rs:199` and its comment at `:196-198`.
- Findings: the comment states the reasoning: "An in-range instant maps to
  exactly one civil time; an instant beyond chrono's representable date range
  maps to none, which ends the search as 'no occurrence' instead of panicking."
  That is correct for the instant-to-civil direction used here; the ambiguity in
  the civil-to-instant direction is never exercised. An existing test covers the
  extreme-instant path (`:1557-1576`). So there is no panic and no DST bug; the
  only issue is which zone is read.
- Missing evidence: none.
- Conclusion: resolved with answer. `chrono::Local` does not fail here and DST
  is handled correctly. The property is about zone *identity*, not zone
  arithmetic.
