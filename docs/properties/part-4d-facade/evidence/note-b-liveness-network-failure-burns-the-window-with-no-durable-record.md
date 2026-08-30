# note-b-liveness-network-failure-burns-the-window-with-no-durable-record

## Discovery trigger

`CheckOutcome` has four variants and both the due and liveness phases accept all
four (`crates/mc-module/src/lib.rs:14099-14100` maps both phases through the same
`check` closure). Comparing `reduce_due` and `reduce_liveness` arm by arm showed
they diverge on two of the four, and the divergence on `NetworkFailed` costs a
24-hour window.

## Evidence trail

1. `reduce_liveness` stamps the liveness timestamp *before* it examines the
   outcome:

   ```
   let mut attempted = pre.clone();
   attempted.check_last_liveness_at = Some(now);
   attempted.updated_at = now;
   match outcome {
   ```
   (`crates/mc-module/src/smart_note_evaluation.rs:591-594`)

   The variable name `attempted` is honest about the intent: the timestamp
   records an attempt, not a result.

2. The `NetworkFailed` arm returns that state unchanged:

   ```
   CheckOutcome::NetworkFailed => SmartNoteReduction {
       next: attempted,
       surfaced: false,
   },
   ```
   (`:623-626`)

   No `check_network_failure_count`, no `check_quarantined_until`, no
   `check_next_due_at`, no `check_status` change. The only durable delta is
   `check_last_liveness_at` and `updated_at`.

3. `reduce_due` handles the identical outcome very differently. It routes both
   failure kinds through `reduce_check_failure`
   (`:577-580`), whose network branch writes a counter, a status, a due time, and
   a quarantine:

   ```
   let network_count = pre.check_network_failure_count + 1;
   let quarantined_until = now + evaluation_backoff_ms(network_count);
   next.check_network_failure_count = network_count;
   next.check_status = if network_count >= MAX_FAILURES_BEFORE_REAUTHOR {
       "failing".to_string()
   } else {
       "compiled".to_string()
   };
   next.check_next_due_at = Some(quarantined_until);
   next.check_quarantined_until = Some(quarantined_until);
   ```
   (`:536-546`)

4. `check_last_liveness_at` is the liveness selector's spacing gate:

   ```
   && note
       .check_last_liveness_at
       .is_none_or(|l| l <= liveness_before)
   ```
   (`:775-777`), where `liveness_before = now - SMART_NOTE_CHECK_LIVENESS_RECHECK_MS`
   (`:766`) and the constant is 24 hours (`:26`, doc comment "Minimum spacing
   between liveness recheck attempts").

   So stamping it consumes the note's liveness opportunity for a full day.

5. The `LogicFailed` arm *does* record something: it sets
   `attempted.check_status = "failing"` (`:617`), with a comment explaining why
   the escalation is immediate rather than counted: "Liveness runs a previously
   healthy compiled check; a logic error here means the check itself broke, so
   reauthoring is immediate" (`:614-615`). That reasoning is specific to a logic
   error and says nothing about a network error, so the `NetworkFailed` arm is
   not covered by it.

6. Nothing else observes the failure. `SmartNoteReduction.surfaced` is `false`
   (`:625`), which is correct but carries no failure information. The
   `NoteEvalCompleteOutcome::Applied` response the client receives is the
   reducer's own response JSON (`lib.rs:11393-11395`), so the client knows it
   reported a network failure, but no other party does. There is no log, metric,
   or counter anywhere in the path: `smart_note_evaluation.rs` has zero
   `tracing`/`log` calls (whole-file grep, count 0) and so does
   `lib.rs:10880-11560`.

## Failure scenario

A compiled smart note has been false for 8 days, so it is eligible for the
liveness recheck that exists to catch a check whose logic silently stopped
matching. The compiled check calls `httpGet` against a service the evaluator
host cannot currently reach; `docs/AUDIT-KNOWN-ISSUES.md:823-830` (A50) confirms
compiled checks have an `httpGet` capability, so this is a real shape.

1. The liveness phase claims the note. The sandbox reports
   `network_failed`.
2. `reduce_liveness` writes `check_last_liveness_at = now` and nothing else.
3. The liveness selector now excludes the note for 24 hours (`:775-777`).
4. 24 hours later, the same egress problem persists. Repeat.

The note stays `check_status = "compiled"` indefinitely. An operator reading the
note's columns sees a healthy compiled check that is simply false, which is
exactly what a correctly-working stale note looks like. The escalation the
7-day staleness window was built to trigger never happens, and nothing anywhere
says why.

Contrast the due phase under the same egress failure: three network failures push
`check_status` to `"failing"` (`:539-543`), which is visible in a `ctx_note read`
and is what the compile selector acts on (`:747`).

## Timing windows and dependencies

The window is 24 hours wide per occurrence and repeats. No interleaving is
required. The enabling state has three parts, all durable and all constructible:
`check_status == "compiled"` with an artifact, `check_false_since_at` at least 7
days old (`SMART_NOTE_CHECK_MAX_STALENESS_MS`, `:24`), and
`check_last_liveness_at` either NULL or at least 24 hours old.

The fault required is a network failure inside the sandbox check, which the
protocol represents as a first-class outcome kind (`lib.rs:14185`), so no fault
injection into the module is needed: a test simply completes with
`{"phase":"liveness","kind":"network_failed"}`.

## What a test must construct

The pure oracle:

1. Build a `SmartNoteLifecycleState` with `check_status = "compiled"`,
   `check_network_failure_count = 0`, `check_last_liveness_at = None`, and a
   `check_false_since_at` 8 days in the past.
2. Reduce with
   `SmartNoteEvaluationOutcome::Liveness(CheckOutcome::NetworkFailed)`.
3. Assert either that `next.check_last_liveness_at == pre.check_last_liveness_at`
   (the window was not consumed) or that some other field records the failure,
   for instance `next.check_network_failure_count > pre.check_network_failure_count`.
   Neither holds.

The behavioural oracle, which is the one that shows the cost:

1. Same pre-state. Reduce with `Liveness(NetworkFailed)`.
2. Feed the reduced state into a `SmartNoteSelectionSnapshot` and call
   `get_stale_compiled_smart_notes(&[snapshot], now + 1, 1, false)`.
3. Assert the note is still selected. It is not, and it will not be until
   `now + 24h`.

Both forms are pure. A store-level version would drive `next` then `complete`
twice with the clock advanced by 23 hours between them and assert the second
`next` returns a claim for the same note, which it will not.

## Investigation log

### Q: Is burning the window deliberate, to damp a flapping network?

- Sources examined: the `LogicFailed` arm's explanatory comment
  (`smart_note_evaluation.rs:614-615`), the `NetworkFailed` arm (`:623-626`,
  which has no comment), `reduce_due`'s handling of the same variant
  (`:577-580`), `reduce_check_failure`'s network branch (`:536-547`), and the
  spacing constant's doc comment (`:25-26`).
- Findings: the `LogicFailed` arm is commented and the `NetworkFailed` arm is
  not, in a file where every other non-obvious decision carries a comment. The
  variable name `attempted` (`:591`) reads as a deliberate choice to record the
  attempt regardless of outcome, which is a coherent damping design. But if
  damping were the intent, `reduce_due` would do the same thing for the same
  outcome and instead it counts and quarantines. So the two phases disagree about
  what a network failure means, and only one of them explains itself.
- Missing evidence: the TypeScript reducer's liveness network arm. The golden
  fixture has 23 transition cases; I did not enumerate which outcome kinds they
  cover per phase, so I cannot say from the fixture whether
  `liveness network_failed` is exercised at all. That is a cheap check and would
  distinguish a faithful port from a divergence.
- Conclusion: needs human input on intent. The missing *record* is the finding
  regardless of the damping question: even if consuming the window is correct,
  `reduce_due` proves the codebase knows how to record a network failure, and
  liveness does not.

### Q: Does anything else eventually escalate a permanently stale note?

- Sources examined: all four selectors (`:711-806`), the four reducer entry
  points (`:661-674`), `SMART_NOTE_CHECK_MAX_STALENESS_MS` (`:24`) and its only
  reader (`:765`).
- Findings: no. The liveness phase is the only consumer of the staleness window,
  and its only escalation is the `LogicFailed` arm's immediate `"failing"`
  (`:617`). A note whose liveness attempts all fail on the network is escalated
  by nothing. The due phase continues on its own cron and will escalate on a
  *due* network failure, so a note whose cron still fires does eventually
  escalate through that path. But a note whose cron is long (up to the 24-hour
  ceiling, `:20`) escalates slowly, and the liveness path that exists to catch it
  faster is the one being consumed.
- Missing evidence: none.
- Conclusion: resolved with answer. Nothing else escalates on the liveness path;
  the due path provides a slower independent escalation only while the cron keeps
  firing.
