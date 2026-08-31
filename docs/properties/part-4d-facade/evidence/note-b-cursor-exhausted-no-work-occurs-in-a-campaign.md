# note-b-cursor-exhausted-no-work-occurs-in-a-campaign

## Discovery trigger

`select_smart_note_evaluation_cycle` returns `None` for two operationally
different reasons, and the module spends real effort distinguishing them: it
re-runs selection against a freshly constructed cycle purely to classify the empty
answer (`crates/mc-module/src/lib.rs:11220-11229`). Effort that large on a
classification implies the distinction matters, and the comment says why. That
makes the classified state a situation a campaign must actually reach, not just a
branch it must execute.

## Discovery trigger, continued: why `sometimes` and not `reachable`

The lines at `lib.rs:11220-11229` execute on *every* `no_work` path, so location
coverage is trivial and tells you nothing: a campaign can run them a thousand
times and always compute `cycle_exhausted: false`, because a campaign whose
projects are usually idle produces empty candidate sets, and an empty candidate
set makes the fresh-cycle re-run return `None` too. The operational state worth
reaching is the one where the *cursor* ended the pass while work remained, and
that is situation coverage. Per METHOD.md's rule, that is `sometimes`.

## Evidence trail

1. The classification, in full:

   ```
   None => NoteEvalSelection::NoWork {
       cycle_exhausted: select_smart_note_evaluation_cycle(
           &snapshots,
           now,
           retina_handoff,
           &SmartNoteSelectionCycle::new(mode),
       )
       .is_some(),
   },
   ```
   (`lib.rs:11220-11229`)

   The second call differs from the first in exactly one argument: a fresh cycle
   instead of the live one. So `cycle_exhausted` means "a fresh cursor would have
   found work, therefore the live cursor is what ended this pass."

2. Its comment states the failure it prevents: "An empty answer has two causes the
   caller cannot tell apart: this pass is spent, or the queue is empty. A cursor
   left mid-cycle by a deadline-truncated drain would otherwise report the next
   drain's first poll as a drained queue. Selection is pure, so re-running it
   against a fresh cycle only classifies this empty answer; the store persists the
   cause so a response-loss replay repeats it" (`lib.rs:11213-11219`).

3. The cursor's monotonicity is what creates the state. `phase_index` only ever
   moves forward within a cycle: `next.phase_index = index` where `index` comes
   from `.skip(cycle.phase_index)`
   (`crates/mc-module/src/smart_note_evaluation.rs:907`, `:941`). Its doc comment
   is explicit: "Position in the mode profile. Phases before it are passed for this
   cycle: work that becomes eligible for an earlier phase waits for the next cycle,
   matching the legacy one-pass sweep shape" (`:864-868`).

4. So there are two independent ways to reach the state:
   - **Skipped earlier phase.** The cursor is at `phase_index` 2 (liveness) or 3
     (fallback), and a note becomes due for phase 0 or 1. The loop starts at
     `cycle.phase_index` (`:907`) and never revisits the earlier phase, so it
     returns `None` while a fresh cycle would return the due note.
   - **Spent fallback quota with fallback notes remaining.** The fallback branch
     excludes `attempted_fallback` members (`:932-937`); a fresh cycle's list is
     empty (`:883`), so it selects one of them.

   The second is the easier one to construct because it needs no clock movement.

5. The cause is durable, not just in the response. The store writes
   `"no_work_exhausted"` or `"no_work"` as the acquisition decision:

   ```
   if cycle_exhausted {
       "no_work_exhausted"
   } else {
       "no_work"
   },
   ```
   (`crates/mc-store/src/lib.rs:13322-13328`)

   and the replay path decodes it back:
   `cycle_exhausted: decision == "no_work_exhausted"` (`:13309`), guarded by a
   comment that names the same failure: "a client only sees a replay after losing
   the original response, so the exhaustion cause must survive or the worker
   mistakes a reset cursor for a drained queue" (`:13304-13307`).

6. The response surfaces it conditionally, with the instruction to the client
   spelled out: the field is added only when true (`lib.rs:14023-14030`) with the
   comment "The cursor, not the queue, ended this pass; the client may poll again.
   Durable in the acquisition ledger, so replays repeat it to clients that lost the
   original response."

7. The commit that follows resets the cursor:
   `*slot_cycle = SmartNoteSelectionCycle::new(mode)` on a fresh `NoWork`
   (`lib.rs:11258-11265`). So the state is one poll wide: the poll that observes it
   also clears it.

8. Reachability of the surrounding machinery is established for the whole lens in
   `_lenses/lens-b-note-evaluation.md`, and it applies unchanged here: the seven
   `note.evaluation.*` methods are routed with no feature gate
   (`lib.rs:12282-12296`), the shipped setup wizard writes a `dreamer` block and
   defaults its prompt to yes
   (`packages/cli/src/commands/setup-opencode.ts:262-278`, `:449`), and the default
   `evaluate-smart-notes` schedule is the non-empty `"0 3 * * *"`
   (`packages/plugin/src/config/schema/magic-context.ts:189`), so the bridge's two
   early-return gates (`packages/plugin/src/hooks/magic-context/hook.ts:1024`,
   `:1029`) both pass and the bridge registers at `:1210`.

## Failure scenario

This record asserts a state must occur, so the failure is the state never
occurring and the plumbing therefore going untested.

Concretely: a campaign runs evaluation against projects with at most one eligible
note at a time. Every `no_work` is a genuinely empty queue, so `cycle_exhausted` is
always `false`, the `"no_work_exhausted"` decision string is never written, and the
replay branch at `mc-store:13309` is never taken with a `true` value.

Now suppose the durable classification regresses, for instance by writing
`"no_work"` unconditionally. Nothing fails. The consequence appears only in
production, and it is the one the comment describes: a drain truncated by its
deadline leaves the cursor mid-cycle, the next drain's first poll returns
`no_work` with no `cycle_exhausted`, and the worker concludes the queue is drained
and stops. Notes that were eligible the whole time are never evaluated, and the
symptom is indistinguishable from "there was nothing to do", which is exactly the
silent-starvation shape recorded in
`note-b-excluded-note-is-not-reportable-by-any-surface`.

## Timing windows and dependencies

The state is one poll wide, because the poll that produces it also resets the
cursor (`lib.rs:11258-11265`). A campaign that polls once per drain and then stops
will not see it; a campaign that polls to exhaustion within a drain will.

No fault is required. The dependency is a cursor already advanced within a cycle,
which requires at least one prior successful claim on the same slot and mode, since
that is the only thing that advances it (`lib.rs:11241-11256`). The same
registration and slot must be used, because cursors are per slot and per mode
(`lib.rs:2996-3005`, `new_note_evaluator_slot_cycles` at `:3014-3021`).

The replay half needs a second dependency: two `next` calls carrying the *same*
`acquisition_id`, which is what makes the store replay the recorded decision rather
than re-deciding (`mc-store:13241-13262`).

## What a test must construct

The cheapest route uses the fallback exclusion, so no clock movement is needed.

1. Open a store, register an evaluator with `capacity: 1`, and insert two smart
   notes. Drive both to `check_status = "fallback"`, either by three compile
   failures each or by staging the column directly, as the existing revision-matrix
   test does (`smart_note_evaluation.rs:1278-1337`).
2. Poll `note.evaluation.next` on slot 0 with `acquisition_id: "a1"`. It returns a
   fallback claim for the lower-id note. Complete it with
   `{"phase":"fallback","kind":"false"}`.
3. Poll again with `acquisition_id: "a2"`. It returns the second note. Complete it
   the same way.
4. Poll a third time with `acquisition_id: "a3"`. Both notes are now in
   `attempted_fallback`, so the live cycle returns `None`, while a fresh cycle
   selects one of them.
5. Assert the response is `{"result":"no_work","replayed":false,"cycle_exhausted":true}`.
6. Assert the durable cause: query the acquisition ledger for `a3` and assert
   `decision == "no_work_exhausted"`.
7. Assert the replay: poll a fourth time with `acquisition_id: "a3"` again, and
   assert the response is `{"result":"no_work","replayed":true,"cycle_exhausted":true}`.

Steps 6 and 7 are what make this more than a response-shape test. Step 5 alone
would pass if the flag were computed correctly and persisted wrongly; step 6 pins
the persistence and step 7 pins the decode.

The marker name for the coverage check, if the campaign harness uses named markers,
must be a constant and globally unique. `note_eval_cursor_exhausted_no_work` is
suggested. Per METHOD.md's coverage rules the marker asserts the independent
preconditions, which here are: the candidate set is non-empty, the live cursor
returned no selection, and a fresh cursor returned one. All three are observable
inside the selection closure without observing any defect, so the marker fires on a
correct implementation.

## Investigation log

### Q: Is `cycle_exhausted`'s polarity right?

- Sources examined: the computation (`lib.rs:11220-11229`), the field name, the
  comment (`:11213-11219`), the store's encoding (`mc-store:13322-13328`), the
  decode (`:13309`), and the response comment (`lib.rs:14024-14027`).
- Findings: yes, though the name reads backwards on first encounter. The value is
  `select(fresh_cycle).is_some()`, so `true` means "a fresh cycle finds work",
  which means "the live cycle is exhausted". The field is named for the live
  cycle's condition, not for the fresh cycle's result. Every comment on the path
  describes it correctly, and the response comment states the client's obligation
  ("the client may poll again"), which is the actionable form.
- Missing evidence: none.
- Conclusion: resolved with answer. Correct, and the naming is worth noting for
  whoever writes the test, because an assertion written from the name alone could
  be inverted.

### Q: Can the state be reached without a prior claim on the same slot?

- Sources examined: `SmartNoteSelectionCycle::new` (`smart_note_evaluation.rs:878-885`),
  the two cursor mutation sites (`lib.rs:11254-11256` for advance and `:11265` for
  reset), and `new_note_evaluator_slot_cycles` (`:3014-3021`).
- Findings: no. A fresh cycle has `phase_index: 0`, `remaining` equal to the first
  phase's quota, and an empty `attempted_fallback` (`:880-884`). Selection against a
  fresh cycle and against a fresh cycle are identical by construction, so
  `cycle_exhausted` is necessarily `false` on the first poll of a new cursor. Since
  `new_note_evaluator_slot_cycles` builds fresh cursors at registration time
  (`:3014-3021`), every registration starts unable to reach the state, and one
  successful claim on the target slot and mode is a hard prerequisite.
- Missing evidence: none.
- Conclusion: resolved with answer. At least two polls on the same slot and mode
  are required, the first of which must produce a fresh claim. That is why the test
  recipe above completes step 2 before asserting anything.

### Q: Does the nonbillable mode reach it too?

- Sources examined: `NONBILLABLE_CYCLE_PROFILE`
  (`smart_note_evaluation.rs:849-852`) and `cycle_profile` (`:888-893`).
- Findings: yes, and it is harder to construct. The nonbillable profile has only
  due and liveness, both with a quota of 10 (`NONBILLABLE_PHASE_QUOTA`, `:34`), and
  no fallback phase, so the `attempted_fallback` shortcut is unavailable. Reaching it
  needs either 10 due claims in one cycle with an eleventh note becoming due, or the
  cursor advanced to liveness with a note becoming due afterwards. The latter needs
  clock movement.
- Missing evidence: none.
- Conclusion: resolved with answer. Reachable in both modes; the `Full` mode
  fallback route is the cheap one and is what the recipe uses. A campaign that only
  ever drains with `exclude_billable: true` would need the harder construction, which
  is worth knowing if the harness defaults to the nonbillable path.
