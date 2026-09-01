# note-b-fallback-phase-writes-no-durable-backoff

## Discovery trigger

My brief named missing reapers and unbounded caller-driven growth as recurring
findings in this repository and asked me to check both explicitly. Tabulating
what each reducer arm writes to `check_next_due_at` produced one blank row that
belongs to a phase whose own comment says it costs a model call.

## Evidence trail

1. `reduce_fallback`'s `False` arm writes three fields and no time gate:

   ```
   FallbackOutcome::False => {
       let mut next = pre.clone();
       next.last_checked_at = Some(now);
       next.updated_at = now;
       next.check_status = "fallback".to_string();
       ...
   }
   ```
   (`crates/mc-module/src/smart_note_evaluation.rs:647-656`)

   No `check_next_due_at`, no `check_quarantined_until`, no counter.

2. Its selector reads no time gate either:

   ```
   .filter(|note| eligible(note, retina_handoff) && note.check_status == "fallback")
   ```
   (`:795`)

   Compare the due selector, which requires
   `note.check_quarantined_until.is_none_or(|q| q <= now)` and
   `note.check_next_due_at.is_none_or(|d| d <= now)` (`:724-725`), and the
   liveness selector, which requires a 7-day staleness and a 24-hour recheck
   spacing (`:774-777`). The fallback selector has neither.

3. Every other phase writes a durable delay. Compile failure:
   `next.check_next_due_at = Some(now + evaluation_backoff_ms(failure_count))`
   (`:463`). Compile false and due false: the cron-plus-jitter path through
   `false_fields` (`:439`). Due logic failure: `:532`. Due network failure:
   `:544-545`, which writes both the due time and a quarantine. Fallback is the
   only arm with nothing.

4. The cost is stated in the file. `SmartNoteCycleMode::Nonbillable`'s doc
   comment says the nonbillable drain exposes "sandbox-only due and liveness
   (10/10). Compile and fallback claims launch LLM prompts and belong to the
   scheduled full-budget drain" (`:818-821`), and the same reasoning is repeated
   at the call site (`crates/mc-module/src/lib.rs:11209-11212`). So a fallback
   claim is a billable model call by the module's own account.

5. The only rate limit is in-memory and self-clearing.
   `SmartNoteSelectionCycle::attempted_fallback` is a `Vec<i64>`
   (`:874`) whose own doc comment explains the need: "A false or abandoned
   fallback note stays eligible in the store, so without this exclusion the
   deterministic ordering would hand the same note back before later fallback
   notes get an opportunity" (`:871-873`). That is an accurate description of the
   problem and a per-cycle solution to it.

6. The cycle resets on every fresh `no_work`.
   `*slot_cycle = SmartNoteSelectionCycle::new(mode)` at `lib.rs:11265`, taken
   whenever the store commits a `NoteEvalAcquireOutcome::NoWork { replayed:
   false, .. }`. `SmartNoteSelectionCycle::new` sets `attempted_fallback:
   Vec::new()` (`smart_note_evaluation.rs:883`). The registration's
   `slot_cycles` are also described as boot-ephemeral and disappearing with the
   registration entry (`lib.rs:2987-2991`), so a lease expiry, an unregister, a
   route teardown, or a process restart clears them too.

7. The store adds no per-note cooldown. The candidate query filters on
   `type = 'smart' AND status = 'pending'` and excludes notes with a live claim,
   and nothing else (`crates/mc-store/src/lib.rs:13292-13297`). The two caps in
   the acquisition path bound *in-flight* claims and *live* acquisition rows
   against `NOTE_EVAL_LEDGER_CAP` (`:13307-13313`, `:13355-13358`), which a
   claim-then-complete loop never approaches because each claim terminates before
   the next.

8. `MAX_FALLBACK_PER_RUN` is 3 (`smart_note_evaluation.rs:30`) and bounds one
   cycle, not the poll rate.

## Failure scenario

A project has exactly one note in `check_status = "fallback"`, which is the
normal state after a single check was demoted. An evaluator polls in a loop.

1. Poll 1. `Full` cycle at `phase_index` 0. Due, compile, and liveness are empty.
   Fallback selects the note. `attempted_fallback = [id]`, `remaining = 2`,
   `phase_index = 3`. The claim launches a model call.
2. The evaluator completes with `fallback false`. The note's durable state gains
   a new `last_checked_at` and nothing that gates it.
3. Poll 2. The fallback branch runs
   `get_fallback_smart_notes(...).into_iter().find(|note|
   !cycle.attempted_fallback.contains(&note.id))` (`:932-937`) and finds nothing,
   because the only fallback note is excluded. The loop ends, selection returns
   `None` (`:948`).
4. `lib.rs:11220-11229` re-runs selection against a *fresh* cycle to classify
   the empty answer. A fresh cycle has an empty `attempted_fallback`, so it
   selects the note, so `cycle_exhausted` is `true`. The store commits a fresh
   `no_work_exhausted` (`mc-store:13322-13328`).
5. `lib.rs:11258-11265` sees `NoWork { replayed: false, .. }` and resets the
   cycle. `attempted_fallback` is empty again.
6. Poll 3 is poll 1. One model call per two polls, forever.

The `cycle_exhausted: true` flag in the poll-2 response is, by its own comment,
an instruction to poll again: "The cursor, not the queue, ended this pass; the
client may poll again" (`lib.rs:14024-14027`). So the protocol actively invites
step 6.

## Timing windows and dependencies

No interleaving and no fault. The loop rate is set entirely by the evaluator
client's polling cadence, which is outside this crate. The state is a steady
state, not a transient: nothing about the note changes in a way that reduces its
eligibility, because `check_status` stays `"fallback"` by construction
(`:651`) and `last_checked_at` is not read by the fallback filter, only by its
sort key (`:797-803`).

Two or more fallback notes soften but do not remove it. With N fallback notes and
a quota of 3, a cycle claims `min(N, 3)` of them before exhausting, and the
rotation is fair because `last_checked_at` ordering puts the least recently
checked first (`:797-803`, with the intent stated at `:785-787`). So the
per-note rate falls as N grows, but the aggregate rate does not: the project
still sustains up to 3 model calls per cycle with no durable floor on the cycle
period.

## What a test must construct

The structural oracle is pure and cheap:

1. Build a `SmartNoteLifecycleState` with `check_status = "fallback"`.
2. Reduce with
   `SmartNoteEvaluationOutcome::Fallback(FallbackOutcome::False)`.
3. Assert that at least one of `next.check_next_due_at` or
   `next.check_quarantined_until` advanced past `now`. Neither will have.

The behavioural oracle needs the store, because the reset is in the handler:

1. Open a store, register an evaluator, insert one smart note, and drive it to
   `check_status = "fallback"` (three compile failures, or stage the column
   directly as the existing revision-matrix test does at
   `smart_note_evaluation.rs:1278-1337`).
2. Loop: `note.evaluation.next`, then `complete` with `fallback false` if a claim
   came back.
3. Run the loop with a *frozen* clock, so no backoff anywhere could explain the
   behaviour, for 20 iterations.
4. Assert the number of `result: "claim"` responses is bounded by a declared
   constant. It will be about 10, one per two polls, and it grows with the
   iteration count without limit.

The frozen clock is the key detail: it removes every other explanation and
isolates the missing gate.

## Investigation log

### Q: Does the shipped evaluator worker rate-limit its own polling?

- Sources examined: `lib.rs:11136-11145` (the `wait_ms` field, which protocol
  v2.0 restricts to exactly 0, rejecting anything else with
  `positive_wait_unsupported` at `:11140-11145`), the bridge construction at
  `packages/plugin/src/hooks/magic-context/hook.ts:1015-1213`, and the file list
  of `packages/plugin/src/features/magic-context/smart-notes/`, which contains
  `evaluator-worker.ts`.
- Findings: the module cannot impose a wait. `wait_ms` must be 0, so the module
  answers immediately and every pacing decision belongs to the client. The
  comment at `hook.ts:1026-1029` says "the timer drain is unconditional once a
  bridge exists", which implies the drain is timer-driven rather than a tight
  loop, and that would bound the rate in the shipped configuration. But that is
  an inference from a comment, not from the drain loop.
- Missing evidence: `evaluator-worker.ts`'s drain loop, specifically whether it
  polls until `no_work` within one drain and how often a drain fires. If a drain
  polls to exhaustion, the `cycle_exhausted` flag makes "exhaustion" recede one
  note at a time and a single drain could issue many fallback calls.
- Conclusion: unresolved, needs the worker's drain loop. This determines whether
  the finding is a live cost problem or a latent one. It does not change the
  module-side property, which is that the module offers no durable gate and
  delegates the entire rate decision to a client it does not control.

### Q: Is the absent gate deliberate, on the reading that fallback is cheap?

- Sources examined: `smart_note_evaluation.rs:818-821` and
  `lib.rs:11209-11212` (both state fallback claims launch LLM prompts),
  `:785-787` (the fallback rotation's stated purpose), `:871-873`
  (`attempted_fallback`'s stated purpose).
- Findings: the two comments that describe fallback's cost both say it is
  billable, and the two comments that describe its rate limiting both frame the
  problem as *fairness between notes* rather than *rate over time*. So the
  design thought carefully about which note goes next and did not address how
  often. That is a coherent reading of the code: the omission looks like a scope
  boundary, not a decision.
- Missing evidence: whether `storage.ts`, the TypeScript original, writes a
  fallback delay. The golden fixture's selection cases would not show it, because
  they test selection, not reduction.
- Conclusion: unresolved, needs `storage.ts`. The comments are strong evidence
  that the cost was known and the rate was not considered, which is enough to
  catalog the property.
