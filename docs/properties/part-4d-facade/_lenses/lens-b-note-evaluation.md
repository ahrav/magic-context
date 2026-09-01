# Part 4d Lens B: note evaluation and smart-note semantics

Attention focus: what a note is, what evaluation decides, the note lifecycle,
and the determinism, correctness, bounding, and observability properties the
code actually claims. Sibling lens
[lens-a-facade-and-assembly.md](lens-a-facade-and-assembly.md) owns the facade
envelope, response assembly, the claim-intent surface, and the `ctx_note`
argument-trust surface. This lens does not restate any of its 12 records.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Method contract in
[../../METHOD.md](../../METHOD.md).

Primary files read in full: `crates/mc-module/src/smart_note_evaluation.rs`
(1,851 lines, of which 951-1851 is the inline test module),
`crates/mc-module/src/lib.rs:2962-3020`, `:3828-3976`, `:10880-11560`,
`:13885-14285`, `:15313-15338`. Store-side lifecycle context read where it bears
on note state: `crates/mc-store/src/lib.rs:4393-4605`, `:10130-10200`,
`:10409-10520`, `:12844-12871`, `:13092-13360`, `:13548-13620`. Every line
reference below was read back individually at `HEAD`. `boundary.rs` was checked
and carries no note-lifecycle code; the note lifecycle lives in
`smart_note_evaluation.rs`, `lib.rs`, and `mc-store`. The scope map's line
ranges for this sub-part were all confirmed correct; corrections are listed at
the end.

## Note model and lifecycle map

### There are two note kinds behind one facade

`mc_notes` rows carry a `type` column. `insert_note`
(`mc-store/src/lib.rs:10130-10164`) writes `type = 'session'` with
`status = 'active'`. `insert_project_note` (`:10166-10200`) writes
`type = 'smart'` with `status = 'pending'` when a non-empty
`surface_condition` is present and `'active'` otherwise (`:10183-10189`). Only
`type = 'smart'` rows with `status = 'pending'` are ever evaluated: the
candidate query is `WHERE project_path = ?1 AND type = 'smart' AND status =
'pending'` (`:13292-13297`).

So "a note" in this lens means a smart note: durable content, a
`surface_condition` (the trigger text), and a 20-field compiled-check lifecycle
projection. The projection is `SmartNoteLifecycleState`
(`smart_note_evaluation.rs:281-302`).

### What persists

`apply_note_evaluation_outcome` (`lib.rs:14193-14277`) lifts the stored row into
`SmartNoteLifecycleState` (`:14213-14243`), runs the reducer (`:14244`), and
writes every reduced field back through `NoteEvalReducedState`
(`:14247-14276`). Nothing is discarded and nothing is derived at read time: the
whole decision is materialized into columns.

Two fields are set outside the reducer. `compiled_source_revision` and
`compiled_project_path` are stamped from the claim only when the outcome carried
an artifact, and otherwise preserved (`:14245-14252`).

### Lifecycle transitions and what each writes

| Transition | Entry point | Durable writes |
| --- | --- | --- |
| create, plain | `ctx_note` write with no condition (`lib.rs:11679-11711`) | `type='session'`, `status='active'` (`mc-store:10152-10157`) |
| create, conditioned | `ctx_note` write with condition (`lib.rs:11629-11677`) | `type='smart'`, `status='pending'`, condition, compile hints (`mc-store:10192-10199`) |
| update | `update_note_cas` (`lib.rs:11837-11871`, store `:10409-10505`) | content and/or condition, `status_version + 1`, `state_version + 1`; on a compiler edit also `source_revision + 1`, `status='pending'`, and the entire check lifecycle NULLed (`mc-store:12844-12871`) |
| supersede | none | there is no supersession relation between notes; a re-authored condition is an in-place update, not a new row |
| evaluate | `note.evaluation.complete` (`lib.rs:11334-11405`) | the 20 reduced projection fields plus the two compile-provenance fields |
| expire (claim) | `collect_note_eval_ledgers_tx` (`mc-store:13119-13157`) | claim rows only; the note row is never touched by claim expiry |
| dismiss | `dismiss_note` (`mc-store:4551-4605`, `:10507-10563`) | `status='dismissed'`, `dismissed_at`, `dismissal_resolution`, content with the resolution appended (`:4574-4577`), version bumps, and a claim fence |
| delete | `DELETE FROM mc_notes WHERE context_store_uuid = ?1 AND project_path = ?2` (`mc-store:11393`) | the row; this is session-delete / recomp territory owned by Parts 3 and 4c |

Both `update_note_cas` and `dismiss_note` call
`fence_active_note_claims_tx(..., "stale", ...)` (`mc-store:4543`, `:4602`,
`:10500`, `:10558`), so an in-flight claim cannot apply an outcome across an
edit or a dismissal.

### Which illegal transitions are representable

Three guards, each at a different layer:

1. **Phase is type-scoped.** `SmartNoteEvaluationOutcome`
   (`smart_note_evaluation.rs:338-344`) wraps a per-phase outcome enum, so a
   `CompileOutcome` cannot be handed to `reduce_due`. The header comment at
   `:337` states the intent: "a smuggled cross-phase result cannot type-check."
   The wire decoder enforces the same pairing by exhaustive match
   (`lib.rs:14089-14107`), and rejects an artifact on a non-compile phase and a
   missing artifact on a compile phase (`:14071-14077`).
2. **Phase must match the claim.** `apply_note_evaluation_outcome` rejects an
   outcome whose phase differs from `claim.phase` (`lib.rs:14197-14202`).
3. **The note must be the note that was claimed.**
   `complete_note_evaluation` refuses unless
   `note.source_revision == claim.source_revision`,
   `note.state_version == claim.state_version`, and `note.status == "pending"`
   (`mc-store:13569-13573`), and refuses any reduced status outside
   `pending | ready` (`:13594-13606`).

What is **not** re-checked at completion time is the phase's own eligibility
predicate. A `due` claim is issued only for a note with
`check_status == "compiled" && has_compiled_check`
(`smart_note_evaluation.rs:721-722`), but completion asserts only the phase
name. That gap is closed indirectly, not directly: every path that could change
`check_status` under a live claim also bumps `state_version` and fences the
claim, so the version fence is load-bearing for phase-precondition safety. See
`note-b-completion-applies-only-under-the-claimed-revision-and-state-version`.

### `check_false_since_at` is stamped on notes that were never false

`reduce_compile` sets `stored.check_false_since_at =
pre.check_false_since_at.or(Some(now))` at `smart_note_evaluation.rs:491`, and
that line runs for `CompiledMet` as well as `CompiledFalse`. A note whose first
compile returned met therefore carries a false-since timestamp it never earned,
and `ready_fields` (`:416-427`) does not clear it. I traced whether that can
mis-date the liveness clock and it cannot: the only route from `ready` back to
`pending` is `update_note_cas` with `compiler_edit` true
(`mc-store:4497`, `:4507-4511`), and that same statement NULLs
`check_false_since_at` (`mc-store:12865`). Recorded here as verified-safe rather
than as a property, because the failure it would cause is unreachable.

## Evaluation decision map

### Inputs

Selection reads `SmartNoteSelectionSnapshot`
(`smart_note_evaluation.rs:682-702`): 11 fields, deliberately excluding the
artifact body ("Only artifact PRESENCE affects selection", `:690-692`). It is
built from the store's narrow candidate projection by
`smart_note_selection_snapshot` (`lib.rs:13963-13985`), which defaults a NULL
`check_status` to `"uncompiled"` (`:13973-13976`) and a NULL `policy_version` to
`0` (`:13983`), so an unmigrated row lands in the compile phase rather than
being silently skipped.

Reduction reads the full `SmartNoteLifecycleState`, the phase-scoped outcome,
`note_id`, `now`, and a timezone.

### Outputs

Selection returns `Option<(note_id, phase_name, successor_cycle)>`
(`smart_note_evaluation.rs:900-949`). Reduction returns `SmartNoteReduction`
(`:347-352`): the complete next state plus a `surfaced` boolean that records
whether this transition made the note ready.

### The four phases and their gates

| Phase | Selector | Eligibility | Order key |
| --- | --- | --- | --- |
| due | `get_due_compiled_smart_note_checks` `:711-731` | pending, compiled, has artifact, on-policy, unquarantined, `check_next_due_at <= now` | `(check_next_due_at, id)` `:728` |
| compile | `get_smart_notes_needing_compilation` `:735-755` | pending, due, and (`uncompiled` or `failing` or no artifact or off-policy) | `(created_at, id)` `:752` |
| liveness | `get_stale_compiled_smart_notes` `:759-783` | pending, compiled, on-policy, false for at least 7 days, last liveness at least 24h ago | `(check_false_since_at, id)` `:780` |
| fallback | `get_fallback_smart_notes` `:788-806` | pending and `check_status == "fallback"` — **no time predicate at all** | `(last_checked_at.is_some(), last_checked_at, id)` `:797-803` |

`eligible` (`:704-707`) additionally drops a note whose `compile_status` is
already `"compiled"` when the caller set `retina_handoff`.

### Purity and determinism

The module header claims "Pure functions throughout: callers supply the
pre-state, a phase-scoped outcome, the transition clock, and a timezone"
(`smart_note_evaluation.rs:8-10`). The claim holds for the file: no `unsafe`, no
interior mutability, no global state, no clock read, and no map iteration. Every
ordering is an explicit `sort_by_key` with `id` as the final tiebreak, so the
selected note is invariant under input permutation. The store feeds candidates
in `ORDER BY id` (`mc-store:13296`). Jitter is FNV-1a over a
`{note_id}:{hash}` seed (`smart_note_evaluation.rs:262-274`), pure and
reproducible, with the JS u32-wrapping and UTF-16 semantics mirrored
deliberately.

The impurity is at the call site, not in the module. `lib.rs:14244` passes
`&chrono::Local`. That reads the process environment, so the persisted
`check_next_due_at` is a function of the evaluating host's timezone. The frozen
golden pins one zone (`testdata/smart-note-evaluation-golden.json`,
`provenance.timezone = "America/Los_Angeles"`, consumed at
`smart_note_evaluation.rs:1104-1108`), so the cross-language fixture cannot see
the divergence it would expose. See
`note-b-reducer-reads-process-local-timezone-for-durable-schedule`.

**Same note evaluated twice yields the same decision** given the same pre-state,
outcome, `note_id`, `now`, and timezone. Across two hosts with different
timezones it does not.

Two pieces of state sit outside the pure core.
`SmartNoteSelectionCycle` (`:861-875`) is a per-slot, per-mode cursor, held in
`Arc<Vec<Mutex<NoteEvaluatorSlotCycles>>>` on the registration
(`lib.rs:2992`) and described as boot-ephemeral (`:2987-2991`). The cursor
advances only on a fresh durable claim and resets only on a fresh durable
`no_work` (`lib.rs:11235-11267`), so replay, recovery, and every error arm leave
it untouched. The other is `live_note_evaluator_policy`
(`lib.rs:3889-3906`), which ORs `retina_handoff` and `wake_owned` across every
live registration in the project and therefore makes one evaluator's policy
visible in another's selection filter.

### Backoff coverage by phase

| Phase and outcome | Durable delay written |
| --- | --- |
| compile, `compilation_failed` | `check_next_due_at = now + backoff(count)` `:463` |
| compile, `compiled_false` | `check_next_due_at` from the cron plus jitter `:472-478`, `:439` |
| due, `false` | same cron-plus-jitter path `:439` |
| due, `logic_failed` | `check_next_due_at = now + backoff(count)` `:532` |
| due, `network_failed` | `check_next_due_at` and `check_quarantined_until` `:544-545` |
| liveness, `false` | cron plus jitter `:604-611` |
| liveness, `logic_failed` | none; status goes straight to `failing` `:616-622` |
| liveness, `network_failed` | none; only `check_last_liveness_at` moves `:591-593`, `:623-626` |
| fallback, `false` | **none** `:647-656` |
| any, met | none; the note leaves `pending` |

The two blanks are the two records
`note-b-liveness-network-failure-burns-the-window-with-no-durable-record` and
`note-b-fallback-phase-writes-no-durable-backoff`.

## Observations

1. `smart_note_evaluation.rs` contains zero `tracing`, `log`, `warn!`,
   `debug!`, or metric calls (verified by grep over the whole file, count 0).
   `lib.rs:10880-11560`, the entire note-evaluation protocol, contains zero as
   well (verified by an awk scan of that exact range). The only production
   assertion anywhere in the path is the `debug_assert!` at
   `lib.rs:11251-11254`, which is compiled out of a release build.
2. `lib.rs:11556-11563` caps five `ctx_note` string arguments;
   `MAX_NOTE_CONTENT_BYTES` is 64 KiB (`:14395`).
3. Artifact caps are enforced in `parse_note_evaluation_wire_artifact`
   (`lib.rs:14112-14172`): compiled check 64 KiB (`:14133`), manifest 32 KiB
   (`:14139`) and required to parse as a JSON object (`:14144`), `check_hash`
   exactly 64 lowercase hex (`:14150-14158`), cron at most 256 bytes and valid
   under this module's own 5-field grammar (`:14161`).
4. The artifact digest is recomputed from the authoritative note condition, not
   trusted from the wire (`lib.rs:14213-14219`, helper at `:14176-14186`), and
   the helper delegates to `mc_store::note_check_digest` so the admission gate
   and the store's repair path cannot disagree (`:14174-14176`).
5. Live registrations are capped at 32 per project
   (`NOTE_EVALUATOR_MAX_REGISTRATIONS`, `lib.rs:2969`), enforced at
   `:10951-10956`, with the reason stated inline: `evaluator_instance` is
   caller-chosen, so without the cap the O(n) expiry purge becomes superlinear
   in injected entries.
6. The claim and acquisition ledgers are both capped and reaped.
   `NOTE_EVAL_LEDGER_CAP` is 10,000 in-flight (`mc-store:2946`), checked at
   `:13307-13313` and `:13355-13358`; `collect_note_eval_ledgers_tx`
   (`:13119-13157`) deletes rows, not just columns, and says why
   (`:13143-13147`). This is the counter-example to the recurring
   missing-reaper finding: the ledgers have one.
7. `mc_notes` has **no** per-project count cap. Neither `insert_note`
   (`mc-store:10130-10164`) nor `insert_project_note` (`:10166-10200`) counts
   existing rows, and no reaper deletes notes by age or volume. The candidate
   query has no `LIMIT` (`:13291-13301`).
8. `registration.policy_version` is written at `lib.rs:10964`, incremented at
   `:11045`, and echoed at `:11050`. It is read nowhere else. Selection compares
   the *note's* `policy_version` against the module constant
   `SMART_NOTE_CHECK_POLICY_VERSION` (`smart_note_evaluation.rs:723`, `:749`,
   `:773`).
9. `registration.retina_handoff` and `registration.wake_owned` are likewise not
   read at `next`; `lib.rs:11166` takes both from the project-wide OR.
10. `check_failure_count` is a single column shared by two phases with two
    separate thresholds: `MAX_COMPILATION_FAILURES`
    (`smart_note_evaluation.rs:36`) read at `:458`, and
    `MAX_FAILURES_BEFORE_REAUTHOR` (`:38`) read at `:527` and `:539`. Both are
    3, and neither reducer resets the other's accumulation.
11. `truncate(limit.max(1))` appears in all four selectors (`:729`, `:753`,
    `:781`, `:804`). A caller asking for zero notes gets one. Production always
    passes 1 or `notes.len()` (`:918`, `:923`, `:928`, `:933`), so this is a
    latent public-API surprise rather than a live defect. The four selectors are
    `pub` in a `pub mod` (`lib.rs:35`).
12. `next_occurrence` handles the DST direction correctly: it steps epoch
    minutes and reads civil fields off each candidate, so the local-to-instant
    ambiguity never arises, and `.single()?` ends the search rather than
    panicking beyond chrono's range (`smart_note_evaluation.rs:195-208`, with
    the reason stated at `:196-198`). An existing test covers it
    (`:1557-1576`).
13. The `wake_owned` veto returns `no_work` without touching the store
    (`lib.rs:11166-11172`), so it leaves no replayable decision and does not
    reset the cycle. The response does carry `wake_owned: true`, so it is
    distinguishable from a genuine empty queue.
14. `note_evaluation_body` (`lib.rs:13885-13905`) is a closed schema: it
    rejects any key outside the per-method allow list and requires `v == 2`.
    Lens A records this as the only runtime closed-schema decode on any
    surface, and it is the note-evaluation protocol's.
15. `note.evaluate` is retired and answers with a typed error
    (`lib.rs:12281`, message at `:13862`).
16. A fresh `no_work` carries `cycle_exhausted` when re-running selection
    against a *fresh* cycle would have found work (`lib.rs:11220-11229`). The
    store persists the cause as `"no_work_exhausted"` versus `"no_work"`
    (`mc-store:13322-13328`) so a replay after response loss repeats it
    (`:13300-13310`).

## Candidate properties

### note-b-reducer-reads-process-local-timezone-for-durable-schedule

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the only reducer tests inject a fixed fixture zone.
Guarantee: The reduced lifecycle state a note persists is a function of the
supplied pre-state, outcome, note id, and clock, and not of the evaluating
process's environment.
Check: `always` — for a fixed `(pre, outcome, note_id, now)`, assert the
reduced `check_next_due_at` is byte-identical across two evaluations whose only
difference is the process timezone. `always` because the reduction is claimed
pure and must therefore hold on every reduction evaluated.
Fault/timing angle: none. The trigger is environmental, not temporal: a fleet of
mixed-timezone hosts, a laptop that changes zone, or a tzdata upgrade.
Required faults and enabling state: a smart note with a non-trivial
`check_cron` (any cron that is not effectively-never), a `compiled_false` or
`due false` outcome, and two module processes whose `chrono::Local` resolves
differently.
Confidence: high — [evidence](../evidence/note-b-reducer-reads-process-local-timezone-for-durable-schedule.md).
Verified the purity claim at `smart_note_evaluation.rs:8-10`, the `chrono::Local`
argument at `lib.rs:14244`, the timezone's path into the schedule at
`smart_note_evaluation.rs:246` and `:439`, and the fixture's pinned
`America/Los_Angeles` consumed at `:1104-1108`.
Existing check: `smart_note_evaluation_golden_matches_production_behaviour`
(`smart_note_evaluation.rs:1100-1188`) covers the schedule arithmetic under one
fixed zone. It cannot see this. Status `unaudited`. Not run in CI.
Impact: two hosts evaluating the same note write different durable
`check_next_due_at` values, so a note's next check time depends on which host
last touched it. The cross-language golden claim at
`smart_note_evaluation.rs:1-6` is scoped to one zone and does not cover it.
Open questions:
- Is host-local wall-clock cron intended to be the contract, meaning the
  divergence is by design, or should the zone be pinned per project so the
  schedule is stable across hosts? (needs human input)

### note-b-selection-is-invariant-under-candidate-permutation

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the normative cycle traces
(`smart_note_evaluation.rs:1764-1851`) fix one candidate order and assert the
selected sequence; no test permutes the input.
Guarantee: The note and phase selected for a given cycle depend only on the
candidate set's contents, never on the order in which candidates are presented.
Check: `always` — assert that `select_smart_note_evaluation_cycle` returns the
same `(note_id, phase)` for a candidate slice and for every permutation of that
slice. `always` because the store's row order is an implementation detail that
must never change a decision.
Fault/timing angle: none.
Required faults and enabling state: at least two notes eligible for the same
phase whose primary sort key ties, so the `id` tiebreak is the only thing
deciding.
Confidence: high — [evidence](../evidence/note-b-selection-is-invariant-under-candidate-permutation.md).
Read all four `sort_by_key` calls (`smart_note_evaluation.rs:728`, `:752`,
`:780`, `:797-803`) and confirmed each ends in `note.id`; confirmed the store
feeds `ORDER BY id` (`mc-store:13296`); confirmed no `HashMap` or `HashSet`
iteration anywhere in the module.
Existing check: `cycle_selection_prefers_due_then_compile_then_liveness_then_fallback`
(`smart_note_evaluation.rs:1577-1716`) and the normative trace replay
(`:1764-1851`). Both fix one order. Status `unaudited`. Not run in CI.
Impact: if a tiebreak were ever dropped, the acquisition decision would depend
on SQLite's row order, and the boot-ephemeral cursor plus the durable
acquisition ledger would disagree about which note a replayed acquisition
selected.
Open questions: None.

### note-b-check-failure-count-carries-across-compile-and-check-phases

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no fixture case drives a check failure and then a
compilation failure on the same note.
Guarantee: A note's compile-retry allowance is the allowance the compile phase
declares, independent of how many check failures the note accumulated
beforehand.
Check: `always` — for every note entering the compile phase, assert the number
of consecutive `compilation_failed` outcomes required to reach
`check_status == "fallback"` equals `MAX_COMPILATION_FAILURES`. `always`
because it must hold on every compile escalation evaluated.
Fault/timing angle: none, but the enabling state is a sequence: three
`due logic_failed` outcomes, then a recompile, then one `compilation_failed`.
Required faults and enabling state: a compiled note whose check returns
`logic_failed` three times (reaching `check_status == "failing"` with
`check_failure_count == 3`), then a compile-phase claim whose outcome is
`compilation_failed`.
Confidence: high — [evidence](../evidence/note-b-check-failure-count-carries-across-compile-and-check-phases.md).
Traced `reduce_check_failure` incrementing the shared column
(`smart_note_evaluation.rs:525-531`), the `failing` status feeding the compile
selector (`:747`), and `reduce_compile` reading `pre.check_failure_count + 1`
against `MAX_COMPILATION_FAILURES` (`:455-462`). Confirmed the only reset is a
*successful* compile (`:486`).
Existing check: none. The golden's transition cases exercise each reducer arm
from a fresh pre-state, never across a phase change.
Impact: a note that reached `failing` gets one recompile attempt instead of
three, so a single transient compiler failure retires it to the read-only
fallback evaluator. Fallback never returns a note to `compiled`
(`smart_note_evaluation.rs:630-658`), so the demotion is permanent until the
condition is re-authored.
Open questions:
- Is the shared column intentional, on the reading that a note failing in either
  phase has burned the same trust budget? Both thresholds are 3, which is
  consistent with either intent. (needs human input)

### note-b-fallback-phase-writes-no-durable-backoff

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test polls a project whose only eligible note is in
fallback.
Guarantee: Every phase that consumes a billable model call writes a durable
delay before that note can consume another.
Check: `always` — assert that after any `fallback` completion the note's durable
state advances at least one field that its own selector reads as a time gate.
`always` because it must hold on every fallback completion evaluated.
Fault/timing angle: the window is the cycle reset. A spent cursor answers
`no_work`, the store commits it fresh, the module resets the cursor
(`lib.rs:11258-11265`), and the next poll re-selects the same note.
Required faults and enabling state: one smart note with
`check_status == "fallback"` and an evaluator that polls `note.evaluation.next`
in a loop. No fault is required.
Confidence: high — [evidence](../evidence/note-b-fallback-phase-writes-no-durable-backoff.md).
Confirmed `reduce_fallback`'s `False` arm writes only `last_checked_at`,
`updated_at`, and `check_status` (`smart_note_evaluation.rs:647-656`);
confirmed `get_fallback_smart_notes` has no `check_next_due_at` or
`check_quarantined_until` predicate (`:795`); confirmed the store adds no
per-note cooldown (`mc-store:13291-13301`); confirmed the fallback claim's cost
from the comment at `smart_note_evaluation.rs:818-821`.
Existing check: none. `MAX_FALLBACK_PER_RUN` (`:30`) bounds one cycle, not the
poll rate, and `attempted_fallback` (`:874`) is boot-ephemeral and reset with
the cycle.
Impact: a project with a small fallback set can be driven to one model call per
note per two polls indefinitely, with the poll rate set entirely by the
evaluator client. Every other phase has a durable delay; this one relies on an
in-memory list that a restart or a fresh `no_work` clears.
Open questions:
- Does the shipped evaluator worker impose its own inter-poll delay that bounds
  this in practice? The worker lives at
  `packages/plugin/src/features/magic-context/smart-notes/evaluator-worker.ts`
  and was not read in this pass. Unresolved, needs the worker's drain loop.

### note-b-liveness-network-failure-burns-the-window-with-no-durable-record

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test drives `liveness network_failed`.
Guarantee: A liveness attempt that failed for an environmental reason does not
consume the note's liveness opportunity, and is distinguishable in durable state
from an attempt that ran.
Check: `always` — assert that after a `liveness network_failed` completion
either `check_last_liveness_at` is unchanged or some other durable field records
the failure. `always` because it must hold on every liveness network failure
evaluated.
Fault/timing angle: the 24-hour `SMART_NOTE_CHECK_LIVENESS_RECHECK_MS` spacing
(`smart_note_evaluation.rs:26`) is what makes the consumed window expensive; the
next attempt is blocked for a day.
Required faults and enabling state: a compiled note false for at least 7 days
and outside the 24-hour spacing, claimed for `liveness`, whose sandbox check
cannot reach the network.
Confidence: high — [evidence](../evidence/note-b-liveness-network-failure-burns-the-window-with-no-durable-record.md).
Confirmed `reduce_liveness` stamps `check_last_liveness_at = now` before
matching (`smart_note_evaluation.rs:591-593`) and that the `NetworkFailed` arm
returns that state unmodified (`:623-626`); contrasted with `reduce_due`'s
`NetworkFailed`, which routes through `reduce_check_failure` and writes a
counter and a quarantine (`:577-580`, `:536-547`); confirmed the spacing
predicate reads `check_last_liveness_at` (`:775-777`).
Existing check: none.
Impact: an evaluator with intermittent egress silently defers every staleness
escalation by 24 hours per blip, and nothing in the note, the response, or a log
says so. A note that should have been escalated to `failing` can stay
`compiled` and stale indefinitely while the operator sees a healthy check
status.
Open questions:
- Is burning the window deliberate, to keep a flapping network from hammering
  the liveness path? If so the missing record is still the finding, because
  `reduce_due` records the same condition and liveness does not. (needs human
  input)

### note-b-completion-applies-only-under-the-claimed-revision-and-state-version

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `smart_note_revision_matrix_normative_matches_mc_store`
(`smart_note_evaluation.rs:1189-1526`) drives a revision and state-version
matrix against the real store.
Guarantee: An evaluation outcome is applied only to the exact note revision the
claim was issued against, so a note edited or dismissed mid-evaluation cannot
receive a decision computed from its old content.
Check: `always` — assert that for every applied completion,
`note.source_revision == claim.source_revision`,
`note.state_version == claim.state_version`, and `note.status == "pending"` held
at apply time, and that any mismatch yields a `stale` conflict with no note
write. `always` because it is the fence every other phase-precondition
guarantee rests on.
Fault/timing angle: the window is between the claim and the completion, which
spans a sandbox execution and, for compile and fallback, a model round trip. The
interleaving to construct is a `ctx_note update` or `dismiss` inside that
window.
Required faults and enabling state: an outstanding claim on a note, plus a
concurrent facade mutation of that note. No injected fault is needed.
Confidence: high — [evidence](../evidence/note-b-completion-applies-only-under-the-claimed-revision-and-state-version.md).
Read the fence at `mc-store:13569-13573`, the `stale` terminal it produces
(`:13552-13561`), the reduced-status guard (`:13594-13606`), and the four
`fence_active_note_claims_tx` call sites on the mutation paths (`:4543`,
`:4602`, `:10500`, `:10558`). Confirmed the module side asserts only the phase
name (`lib.rs:14197-14202`), so the store fence is the sole protection for the
phase's eligibility predicate.
Existing check: `smart_note_revision_matrix_normative_matches_mc_store`
(`smart_note_evaluation.rs:1189-1526`), replaying
`testdata/smart-note-evaluation-normative.json`. Status `unaudited`. Not run in
CI.
Impact: if the fence regressed, a `due met` outcome computed against the old
condition would set `status = "ready"` and a host-derived `ready_reason` on a
note whose trigger text had since changed, surfacing the wrong note for the
wrong reason.
Open questions: None.

### note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test writes a large pending set and measures a poll.
Guarantee: The work an acquisition poll performs is bounded independently of how
many notes a caller has written.
Check: `always` — assert that the number of rows the candidate query returns and
the number of `SmartNoteSelectionSnapshot` values built per poll are both
bounded by a declared constant. `always` because it must hold on every poll
evaluated.
Fault/timing angle: none. The growth is caller-driven and monotone.
Required faults and enabling state: a model or client that repeatedly calls
`ctx_note` with a `surface_condition`, and no evaluator draining them. Each
write lands as `status = 'pending'` and stays there.
Confidence: high — [evidence](../evidence/note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll.md).
Confirmed no count cap in `insert_note` (`mc-store:10130-10164`) or
`insert_project_note` (`:10166-10200`); confirmed the candidate query has no
`LIMIT` (`:13291-13301`); confirmed `smart_note_selection_snapshot` clones three
`String`s per note per poll (`lib.rs:13963-13985`); confirmed no reaper deletes
notes by age or volume, in contrast with the ledger reaper at
`mc-store:13119-13157`.
Existing check: none for note volume. `MAX_NOTE_CONTENT_BYTES` (`lib.rs:14395`)
bounds one note at 64 KiB, and `NOTE_EVAL_LEDGER_CAP` (`mc-store:2946`) bounds
in-flight claims. Neither bounds the pending note count.
Impact: per-poll cost is linear in the pending set with no ceiling, and the
pending set has no eviction. The snapshot's own doc comment
(`smart_note_evaluation.rs:690-692`) shows the per-poll cost was considered and
optimized, which makes the absent count cap the residual gap rather than an
oversight of the whole shape.
Open questions:
- Is there a cap or reaper elsewhere, for instance in a dreamer maintenance
  task outside this crate? I searched `mc-store` and `mc-module` and found
  none. Unresolved, needs a sweep of the plugin's maintenance tasks.

### note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the protocol tests register a single evaluator; none
registers two with conflicting policy.
Guarantee: An evaluator's acquisition decisions are governed by the policy that
evaluator registered, not by another registration's policy.
Check: `always` — with two live registrations for one project whose
`wake_owned` and `retina_handoff` differ, assert each `next` uses the calling
registration's own values. `always` because it must hold on every acquisition
evaluated.
Fault/timing angle: none, but the enabling state is a race in practice: two
plugin instances, or two worktrees of one repository, both bridging the same
project identity.
Required faults and enabling state: two `note.evaluation.register` calls for the
same authority project, from either the same or different routes, with
different `retina_handoff` or `wake_owned`.
Confidence: high — [evidence](../evidence/note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration.md).
Read `live_note_evaluator_policy` accumulating with `|=` over every live entry
(`lib.rs:3889-3906`), its single call site at `:11166`, and confirmed
`registration.retina_handoff` and `registration.wake_owned` are read nowhere in
`handle_note_evaluation_next`. Confirmed registrations are keyed per project in
a `Vec` allowing up to 32 entries (`:2969`, `:10951-10956`).
Impact: one evaluator setting `wake_owned` vetoes every other evaluator's
acquisitions for that project (`lib.rs:11166-11172`), and one setting
`retina_handoff` narrows every other evaluator's eligibility filter through
`eligible` (`smart_note_evaluation.rs:704-707`). The hook comment at
`packages/plugin/src/hooks/magic-context/hook.ts:1030-1033` shows two worktrees
sharing one project identity is an anticipated configuration.
Open questions:
- Is the project-wide OR the intended semantics, on the reading that
  `wake_owned` describes a project-level wake plane rather than one evaluator's
  preference? The `NoteEvaluatorRegistration` doc comment (`lib.rs:2974-2976`)
  scopes the *project* to the route but says nothing about policy scope. (needs
  human input)

### note-b-registered-policy-version-never-reaches-selection

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test registers a `policy_version` that disagrees with
the module constant and checks the effect.
Guarantee: A field the protocol validates and echoes either affects behaviour or
is documented as informational.
Check: `always` — assert that for two registrations differing only in
`policy_version`, the set of notes each is offered is identical, and that this
is the documented contract. `always` because it must hold on every acquisition
evaluated.
Fault/timing angle: none.
Required faults and enabling state: two registrations with different
`policy_version` values, both non-negative, against a project holding notes at
`policy_version` 0 and 1.
Confidence: high — [evidence](../evidence/note-b-registered-policy-version-never-reaches-selection.md).
Grepped every `policy_version` occurrence in `lib.rs:10880-11500`: the field is
validated at `:10916-10919`, stored at `:10964`, bumped at `:11045`, and echoed
at `:11050`, and read nowhere else. Selection compares the *note's*
`policy_version` against the module constant
(`smart_note_evaluation.rs:723`, `:749`, `:773`).
Existing check: none.
Impact: an evaluator running an older or newer compiled-check policy is admitted
and offered notes regardless, and the module has no way to refuse a mismatched
evaluator. A registration that echoes an accepted `policy_version` reads as a
negotiated contract and is not one. The bump at `:11045` further overwrites the
caller's registered value on any policy change, so the echoed number is not even
the value the caller sent.
Open questions:
- Is `policy_version` reserved for a future compiled-check policy negotiation,
  or is it vestigial from the retired `note.evaluate` protocol? (needs human
  input)

### note-b-excluded-note-is-not-reportable-by-any-surface

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — nothing asserts any observability on this path.
Guarantee: When an acquisition returns no work while eligible-looking notes
exist, the reason is attributable from outside the module.
Check: `always` — for every fresh `no_work` decision committed against a
non-empty candidate set, assert at least one durable or emitted signal names the
excluding cause. `always` because it must hold on every such decision
evaluated.
Fault/timing angle: none.
Required faults and enabling state: a non-empty pending smart-note set in which
every note is excluded by a phase predicate, a quarantine, a
`check_next_due_at` in the future, or the `attempted_fallback` list, plus one
`note.evaluation.next` poll.
Confidence: high — [evidence](../evidence/note-b-excluded-note-is-not-reportable-by-any-surface.md).
Verified zero `tracing`, `log`, `warn!`, `debug!`, `info!`, `error!`, or
`trace!` calls in `smart_note_evaluation.rs` (whole-file grep, count 0) and in
`lib.rs:10880-11560` (range scan, no matches). Confirmed the only signals a
caller receives are `result: "no_work"`, `replayed`, and the optional
`cycle_exhausted` flag (`lib.rs:14017-14031`), none of which names a note or a
predicate. Confirmed the sole assertion is a `debug_assert!` at `:11251-11254`,
absent from release builds.
Existing check: none.
Impact: a note starved by an off-policy `policy_version`, a stuck quarantine, or
a mis-set `retina_handoff` from another registration is indistinguishable from a
note that is legitimately not due, from every surface an operator has. Lens A
found four ways an error path can look successful in this same part; this is the
same shape one layer down, where the successful-looking answer is `no_work`.
Open questions:
- Is note evaluation intended to be observable only through the evaluator
  client's own logging, given the client is the one that knows the phase
  semantics? If so, the module still cannot report a starved note, because the
  client never learns which notes were considered. (needs human input)

### note-b-dismissed-note-is-readable-but-never-returns-to-evaluation

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test dismisses a smart note and then reads it back with
`filter: "dismissed"`.
Guarantee: Dismissal is a retrievable retirement, not a destruction: the content
survives and is readable, and the note is permanently removed from evaluation.
Check: `always` — assert that after a successful dismissal the row still exists
with its pre-dismissal content as a prefix of its current content, that a
`ctx_note read` with `filter: "dismissed"` returns it, and that no facade action
returns it to `pending`, `ready`, or `active`. `always` because both halves must
hold on every dismissal evaluated.
Fault/timing angle: none for the read half. For the evaluation half the window
is a live claim at dismissal time, which `fence_active_note_claims_tx` must
close.
Required faults and enabling state: a smart note in `pending` or `ready`, a
`ctx_note dismiss`, then a `ctx_note read` with `filter: "dismissed"` and a
`ctx_note update` on the same id.
Confidence: high — [evidence](../evidence/note-b-dismissed-note-is-readable-but-never-returns-to-evaluation.md).
Confirmed `dismiss_note` UPDATEs and never DELETEs, and appends rather than
replaces the resolution (`mc-store:4574-4596`); confirmed the dismissed status
is a readable filter (`lib.rs:11721`) and is inside the `filter: "all"` set
(`:11722-11729`); confirmed `update` rejects a dismissed note by filtering the
loaded status to `active | pending | ready | surfacing | surfaced`
(`lib.rs:11806-11813`, store `:10529`); confirmed the candidate query only ever
sees `status = 'pending'` (`mc-store:13293`); confirmed the claim fence at
`mc-store:4602`.
Existing check: none found for the dismissed round trip. Lens A records the
dismiss-not-found arm at `lib.rs:11902-11907` as an error text memoized as a
command success; that is its record, not this one.
Impact: this is the answer to "is a dropped note recoverable": yes for reading,
no for evaluation. If the fence at `mc-store:4602` regressed, a late `met`
completion would set `status = "ready"` on a dismissed note and resurrect it
into the surfacing path.
Open questions:
- Is the absence of an un-dismiss action deliberate? A user who dismisses by
  mistake can read the note but must re-author it. (needs human input)

### note-b-cursor-exhausted-no-work-occurs-in-a-campaign

Type: reachability
Reachability: default-production
Status: active
Exercised: partial — the normative cycle traces
(`smart_note_evaluation.rs:1764-1851`) drive cursor exhaustion in the pure
selector; nothing drives it through the store and the response.
Guarantee: A campaign reaches the state where an acquisition returns no work
because the fair-selection cursor is spent while real work remains, and the
`cycle_exhausted` flag is what distinguishes it from a drained queue.
Check: `sometimes` — assert that at least once per campaign a fresh `no_work`
response carries `cycle_exhausted: true` while the project holds at least one
note that a fresh cycle would select. `sometimes` because this is situation
coverage, not location coverage: a campaign can execute
`lib.rs:11220-11229` and always compute `false`, never producing the operational
state the branch exists for.
Fault/timing angle: the window is one poll wide. The cursor is spent at the
moment of the poll and reset immediately afterwards
(`lib.rs:11258-11265`), so a campaign that polls once per drain never sees it.
Required faults and enabling state: a `Full`-mode slot cursor advanced past at
least one phase (so `phase_index > 0`, permanently skipping earlier phases for
this cycle, documented at `smart_note_evaluation.rs:864-868`), with work newly
eligible in a skipped phase, or the fallback quota spent with fallback notes
remaining. Then one more `note.evaluation.next` on that slot.
Confidence: high — [evidence](../evidence/note-b-cursor-exhausted-no-work-occurs-in-a-campaign.md).
Traced the flag's computation from a *fresh* cycle (`lib.rs:11220-11229`), the
store persisting `"no_work_exhausted"` versus `"no_work"`
(`mc-store:13314-13328`), the replay decoding it back
(`mc-store:13300-13310`), and the response field (`lib.rs:14023-14030`).
Existing check: `smart_note_cycle_traces_normative_matches_selection_policy`
(`smart_note_evaluation.rs:1764-1851`) replaying
`testdata/smart-note-evaluation-normative.json`. It covers the pure selector's
exhaustion, not the durable classification or the response. Status `unaudited`.
Not run in CI.
Impact: without this state in a campaign, the `cycle_exhausted` plumbing is
untested end to end, and its failure mode is silent starvation. The comment at
`lib.rs:11215-11219` states the consequence directly: a cursor left mid-cycle by
a deadline-truncated drain would otherwise report the next drain's first poll as
a drained queue.
Open questions: None.

## Contract-vs-code leads

1. **`AUDIT-KNOWN-ISSUES.md` A51 contradicts the Rust update path.**
   `docs/AUDIT-KNOWN-ISSUES.md:841-847` records as a verified false positive
   that a content edit leaves a smart note's compiled check intact, on the
   ground that `updateNote` "resets the whole compiled-check lifecycle ONLY when
   `surface_condition` changes", and concludes "a body edit doesn't change what
   the check tests, so re-compiling would be wasted work." The Rust authority
   does the opposite: `update_note_cas` computes
   `compiler_edit = condition_changed || content_changed`
   (`mc-store/src/lib.rs:4497`), and `NOTE_CAS_UPDATE_SQL` NULLs the entire
   check lifecycle and forces `check_status = 'uncompiled'` whenever
   `compiler_edit` is true (`:12849-12866`). The Rust code comment at
   `lib.rs:11820-11827` agrees with the code and therefore with neither the doc
   nor the TypeScript. Consequence, if the doc is the intended contract: every
   content-only edit of a conditioned note discards a valid compiled artifact
   and buys a fresh compile, which is exactly the wasted work A51 says the
   design avoids. Consequence, if the code is the intended contract: A51's
   reasoning is stale for the Rust authority and the module header's claim that
   "lifecycle behavior cannot drift between languages"
   (`smart_note_evaluation.rs:1-6`) is scoped narrower than it reads, because
   the update path is outside the fixture's coverage.
2. **The purity claim's scope.** `smart_note_evaluation.rs:8-10` says "Pure
   functions throughout" and lists the timezone as a caller-supplied input,
   parenthesizing that "production passes the machine-local zone." That is
   accurate about the module and silent about the consequence: the durable
   schedule is host-dependent. Record
   `note-b-reducer-reads-process-local-timezone-for-durable-schedule`.
3. **The cross-language fixture's scope.** `smart_note_evaluation.rs:4-6` says
   both implementations replay the frozen fixture "so lifecycle behavior cannot
   drift between languages." The fixture covers the reducer, the schedule
   arithmetic, and the selectors (23 transition, 16 schedule, and 9 selection
   cases, read from `testdata/smart-note-evaluation-golden.json`). It does not
   cover the update path, the dismiss path, the registry, the protocol handlers,
   or the timezone, all of which are lifecycle behaviour. The stateful cycle
   behaviour is explicitly carved out to a separate hand-authored fixture
   (`:809-812`), which is the right disclosure; the update and dismiss paths get
   no equivalent note.
4. **The registration's `policy_version`.** `lib.rs:10891` lists it as a
   required closed-schema field and `:10916-10919` validates it, which reads as
   a negotiated policy handshake. Nothing consumes it. Record
   `note-b-registered-policy-version-never-reaches-selection`.
5. **`NoteEvaluatorRegistration`'s scope comment.** `lib.rs:2974-2976` states
   "The project key is resolved from the server-side route binding, never from a
   request body", which `resolve_note_evaluator_project` (`:3908-3936`)
   honours. The comment says nothing about *policy* scope, and policy is read
   project-wide across registrations. Record
   `note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration`.
6. **The snapshot's stated cost model.**
   `smart_note_evaluation.rs:690-692` says the snapshot "avoids copying the
   artifact body for every pending note on every acquisition poll", which
   accurately describes an optimization and implicitly concedes that every
   pending note *is* visited on every poll. No cap bounds that set. Record
   `note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll`.

## Open questions

- Does the shipped evaluator worker rate-limit its own `note.evaluation.next`
  polling? That determines whether the missing fallback backoff is a live cost
  problem or a latent one. `evaluator-worker.ts` was not read in this pass.
  Unresolved, needs the worker's drain loop.
- `smart_note_evaluation.rs` has no production assertions at all, and the one
  `debug_assert!` in the protocol (`lib.rs:11251-11254`) guards exactly the
  invariant whose failure is silent starvation, with the comment saying so
  ("fair rotation silently starves, so surface the broken invariant in tests").
  Should that be a release assertion or a metric? This lens catalogs the
  observability gap and does not rule on the guard.
  (needs human input)
- The four phase selectors are `pub` in a `pub mod` (`lib.rs:35`) and all four
  clamp `limit` with `limit.max(1)` (`smart_note_evaluation.rs:729`, `:753`,
  `:781`, `:804`), so an external caller asking for zero notes receives one.
  Production never passes zero. Is the public export intentional API, or should
  the selectors be `pub(crate)` like `select_smart_note_evaluation_cycle`
  (`:900`)? (needs human input)
- Is a `wake_owned` veto meant to leave the cursor untouched? It returns before
  the store call (`lib.rs:11166-11172`), so it neither advances nor resets the
  cycle. That looks correct given the comment's reasoning, but it means a
  project under a long wake-owned window accumulates no cursor progress and no
  durable record of the vetoed polls. Unresolved, needs the wake-plane contract
  in `packages/plugin/src/features/magic-context/smart-notes/wake-plane.ts`.
- METHOD.md's `Exercised` values do not settle how to score a test that exists
  but never runs in CI. Lens A raised the same question. I used `partial` where
  a test asserts the exact behaviour and `not yet` otherwise, and named the CI
  status in every `Existing check` line. (needs human input)

## Reachability derivation, checked once and applied per record

Every record above is labelled `default-production`. The derivation, because the
task required checking both the config default and the shipped setup path:

- The seven `note.evaluation.*` methods are routed with no `cfg` and no Cargo
  feature (`lib.rs:12282-12296`), so no build flag hides them.
- Reaching the reducer additionally requires a live registration, because a
  claim is the only thing `complete` will apply
  (`mc-store:13569-13573`), and registration requires `MODULE` notes authority
  on the bound route (`lib.rs:3908-3936`).
- The shipped registrant is the plugin's bridge
  (`packages/plugin/src/hooks/magic-context/hook.ts:1015-1213`, registering at
  `:1210`). It returns early unless `dreamerRunnable` (`:1024`) and unless the
  `evaluate-smart-notes` task schedule is non-empty (`:1029`).
- `isDreamerRunnable` requires the `dreamer` block to be *present* and not
  disabled (`packages/plugin/src/config/agent-disable.ts:11-13`).
- The schema does **not** default it: `dreamer: DreamerConfigSchema.optional()`
  (`packages/plugin/src/config/schema/magic-context.ts:707`), with no
  `.default()`.
- The shipped setup wizard writes the block unconditionally
  (`packages/cli/src/commands/setup-opencode.ts:262-278`), and defaults the
  prompt to yes (`confirm("Enable dreamer?", true)`, `:449`). When enabled it
  leaves `tasks` unset so the schema default applies (`:269-274`), and that
  default is the non-empty `"0 3 * * *"`
  (`packages/plugin/src/config/schema/magic-context.ts:189`).

So a config produced by the shipped setup with the default answers reaches every
path in this lens, which is why `default-production` is correct. The caveat
worth recording: a hand-authored config with no `dreamer` block at all leaves
the whole subsystem dormant, and the module fails closed rather than open in
that case, refusing conditioned writes at `lib.rs:11618-11626` with the
`has_live_note_evaluator` gate. The hook comments at `:1019-1029` state that
fail-closed intent explicitly.

## Corrections to references I was handed

- The task placed `handle_note_evaluation_next` inside `lib.rs:10880-11481` via
  the scope map's row, which cites `next` at `:11097-11276`. At `HEAD` the
  function begins at `:11097`, which matches. Every other line range the scope
  map gave for this sub-part (`:2962-3020`, `:3828-3976`, `:10880-10980`,
  `:10982-11052`, `:11334-11407`, `:11483-11545`, `:11547-11916`,
  `:13885-14277`, `:13990-14047`, `:14051-14110`, `:14112-14172`,
  `:14193-14277`) was verified correct by reading each endpoint.
- `boundary.rs` (3,053 lines) was in my brief "only where it bears on note
  lifecycle." It bears on none. A case-insensitive grep for `note` in that file
  returns exactly one hit, a test-fixture message body at `boundary.rs:2890`.
  The note lifecycle is entirely in `smart_note_evaluation.rs`, `lib.rs`, and
  `mc-store`. Reporting the absence rather than manufacturing a link.
