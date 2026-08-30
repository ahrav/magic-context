# note-b-excluded-note-is-not-reportable-by-any-surface

## Discovery trigger

My brief said silent skips are a recurring finding in this repository, and that a
sibling lens had just found four ways an error path can look successful in this
same sub-part. I checked whether note evaluation shares that shape. It does, one
layer down: the successful-looking answer here is `no_work`, and the module emits
nothing at all alongside it.

## Evidence trail

1. There is no logging anywhere in the note-evaluation path.
   `crates/mc-module/src/smart_note_evaluation.rs` contains zero occurrences of
   `tracing` (whole-file grep, count 0), and no `warn!`, `debug!`, `info!`,
   `error!`, or `trace!` either. `crates/mc-module/src/lib.rs:10880-11560`, which
   spans all seven protocol handlers plus `note_evaluation_claim_scope` and
   `handle_note_delivery_value`, contains none of those macros either (verified by
   an awk scan restricted to that line range, no matches).

2. There is no counter or metric. The module declares resources
   (`lib.rs:11939-11946`) and reports health (`:12003-12046`), and neither reads
   anything from the note-evaluation path. Lens A already established that
   `DispatchHealth::report` degrades only on staleness (`:403-407`) and that the
   facade never takes a dispatch ticket at all, so a note-evaluation anomaly
   cannot reach `health()` either.

3. The only production-shaped assertion is compiled out of release builds:

   ```
   debug_assert!(
       proposed_cycle.is_some(),
       "fresh claim committed without a proposed cycle update"
   );
   ```
   (`:11251-11254`)

   Its comment names the exact failure it is guarding and concedes the guard is
   test-only: "A `None` here means the quota stopped decrementing and fair rotation
   silently starves, so surface the broken invariant in tests"
   (`:11247-11250`).

4. The response carries no attribution. `note_evaluation_acquire_response`'s
   `NoWork` arm builds:

   ```
   let mut body = json!({ "result": "no_work", "replayed": replayed });
   if cycle_exhausted {
       body["cycle_exhausted"] = json!(true);
   }
   ```
   (`:14017-14031`)

   Three fields. None names a note, a phase, a predicate, or a count. A client
   learns "nothing for you" and, when the cursor rather than the queue ended the
   pass, "poll again".

5. The claim arm is richer but only about the note that *won*
   (`:13995-14016`): claim id, note id, phase, expiry, revisions, and a snapshot.
   Nothing about the notes that lost or why.

6. The exclusion reasons are numerous and all silent. A pending smart note can be
   absent from every phase's output for any of:
   - `status != "pending"` (`smart_note_evaluation.rs:705`), though the store
     already filters that (`crates/mc-store/src/lib.rs:13293`);
   - `retina_handoff` true and `compile_status == Some("compiled")` (`:706`),
     which another registration can turn on, see
     `note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration`;
   - `check_quarantined_until > now` (`:724`);
   - `check_next_due_at > now` (`:725`, `:745`);
   - `policy_version != SMART_NOTE_CHECK_POLICY_VERSION` for the due and liveness
     phases (`:723`, `:773`);
   - `check_false_since_at` too recent, or `check_last_liveness_at` too recent
     (`:774-777`);
   - membership in the cycle's `attempted_fallback` (`:935`);
   - a spent phase quota, or a `phase_index` already advanced past the note's
     phase (`:907-915`);
   - a project-wide `wake_owned` veto that returns before selection even runs
     (`lib.rs:11166-11172`);
   - a live claim held by another slot (`mc-store:13294-13295`).

   Only the last of these is discoverable at all, and only by an operator who
   queries the claim ledger directly.

7. Two of those reasons are stuck states rather than transient ones. A note with
   `check_quarantined_until` set far in the future by a large backoff, and a note
   whose `policy_version` never gets stamped because its compile keeps failing,
   are both indefinitely invisible. `evaluation_backoff_ms` caps at 24 hours
   (`smart_note_evaluation.rs:355-360`), so a quarantine is bounded, but a
   repeated failure re-arms it each time.

8. Some state *is* durably visible, which bounds the finding honestly. The note's
   own columns are readable through `ctx_note read` with `filter: "pending"`
   (`lib.rs:11719`), and `render_notes` (`:15057-15163`) formats them. So an
   operator who already suspects a specific note can inspect its
   `check_status`, counters, and timestamps. What is not available is the reverse
   direction: given a project that is not evaluating, no surface says which notes
   were considered and rejected, or by which predicate.

## Failure scenario

A project's smart notes stop firing. The evaluator is registered and healthy, and
its logs show a steady stream of `{"result":"no_work"}`.

The cause is one of: a stray second registration turned `retina_handoff` on; a
migration left every note at `policy_version = 0` so the due and liveness phases
skip them all while the compile phase keeps failing; or a `wake_owned` heartbeat
from another instance is vetoing every poll.

What the operator can see: `no_work`. `health()` reports `Ok`. No log line, no
counter, no metric. `ctx_note read` shows notes sitting in `pending`, which is
their normal resting state and therefore says nothing.

The three causes are distinguished only by reading the note rows *and* the
in-process registration table, and the registration table is not exposed on any
surface: `note_evaluator_registrations` is a private field
(`lib.rs:2977-2993` for the entry type) with no read endpoint. So the
`retina_handoff` and `wake_owned` causes are not diagnosable from outside the
process at all. The `wake_owned` case is the partial exception, since its response
carries `wake_owned: true` (`:11170`), which is the one attribution the whole
path provides.

## Timing windows and dependencies

No window. This is a diagnosability property of the steady state. It becomes
expensive precisely when something else has already gone wrong, which is why it
compounds every other record in this lens: the fallback backoff gap, the liveness
network-failure gap, and the `policy_version` gap all present as `no_work` or as
an unchanged note, with no signal separating them.

## What a test must construct

The check is over the module's emissions, not over note state, so the harness needs
a tracing subscriber or a metrics recorder installed for the test.

1. Install a capturing `tracing` subscriber.
2. Construct an `McHandler`, register an evaluator, and insert three pending smart
   notes, each excluded by a different predicate: one with
   `check_quarantined_until` in the future, one with `policy_version = 0` and
   `check_next_due_at` in the future so the compile phase also skips it, and one
   with `check_next_due_at` in the future.
3. Call `note.evaluation.next` with a fresh `acquisition_id`.
4. Assert the response is `{"result":"no_work", ...}` and that the subscriber
   captured at least one event naming a cause. It captured nothing.

The oracle is deliberately weak: "at least one event naming a cause", not a
specific message or field. A stronger oracle would be prescribing an
observability design, which is a fix, and this pass does not propose fixes. The
weak form still fires, because the count is zero.

A companion assertion that needs no subscriber: assert the `no_work` response body
has more than the three keys at `:14017-14031`. It does not. That form is cheaper
and covers the client-facing half.

## Investigation log

### Q: Is note evaluation intended to be observable only through the evaluator
client?

- Sources examined: the response shapes (`lib.rs:13990-14047`), the absence of
  logging in the handler range and in the reducer file, the `debug_assert!` and its
  comment (`:11247-11254`), `health()` (`:12003-12046`), the private registration
  field, and Lens A's finding that `health()` reports `Ok` while every facade call
  fails.
- Findings: the client-only reading is coherent for the *claim* path, because the
  client is the party that knows the phase semantics and runs the sandbox, so it is
  the natural place to log a completion. It does not cover the *exclusion* path,
  because the client never learns which notes were considered. The candidate set
  exists only inside the store transaction's closure
  (`lib.rs:11201-11231`) and is dropped when the closure returns; not even the
  claim response carries a candidate count. So under the client-only reading there
  is still no party anywhere that could report a starved note.
- Missing evidence: whether the evaluator worker logs its own `no_work` responses
  and at what level. That would establish how much of the picture exists outside
  this crate, but it cannot establish exclusion attribution, since the worker
  receives none.
- Conclusion: needs human input on the intended observability boundary. The
  sub-conclusion is firm and does not need input: no party can currently attribute
  an exclusion, because the information is destroyed inside the transaction
  closure before any response is built.

### Q: Does the `debug_assert!` at `:11251` cover the starvation case it names?

- Sources examined: `:11239-11256`, `select_smart_note_evaluation_cycle`'s return
  contract (`smart_note_evaluation.rs:895-949`), and the store's fresh-claim
  precondition (`mc-store:13303-13345`).
- Findings: it covers the specific invariant "a fresh claim implies the selection
  closure produced a candidate, and therefore set `proposed_cycle`", which is a
  genuine coupling between two separately-computed values. It does not cover
  starvation from any of the ten exclusion reasons listed above, none of which
  involves a fresh claim. So the one guard on the path guards the one case that is
  not the finding. In release builds it guards nothing, and the `if let Some(...)`
  immediately below (`:11255-11257`) means the release behaviour on violation is a
  silently non-advancing cursor, which is exactly the starvation the comment warns
  about.
- Missing evidence: none.
- Conclusion: resolved with answer. The guard is narrow and test-only, and its
  release-mode fallback is the silent failure it describes. Whether it should be a
  release assertion is a defensive-guard question and belongs to
  `/low-level-systems:defensive-assertions-and-invariant-guards`, not to this
  catalog.
