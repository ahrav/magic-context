# nudge-b-channel1-append-row-removal-has-no-bounded-window

## Discovery trigger

Not a lens pass. This record was created by refinement `R3` of the Part 4e
portfolio evaluation, which found that `nudge-b-channel1-append-rows-have-no-reaper`
embedded eventual removal inside an `always` safety check. Its `Check:` line
asserted a count bound and, in the same conjunction, that "a row whose target block
has left the projection is eventually removed within a stated number of passes",
and the record conceded the mix in its own rationale: "the removal half needs the
bound stated in passes, per the liveness rule, and no such bound exists in the code
today". A conjunction that cannot be written is not a weaker check, it is two
claims, so the removal half became this record.

Provenance of the material below, stated because this file was not produced by a
discovery pass. The `DELETE` enumeration, the growth mechanism, the "what a stale
row does" analysis, the reappearance hazard and the seeding helper are all drawn
from the parent record in `catalog.md` and from
`evidence/nudge-b-channel1-append-rows-have-no-reaper.md`, specifically its "Every
DELETE against them" section, its "What a stale row does" section, its "Failure
scenario" second paragraph on lineage descent, and step 2 of its "What a test must
construct". The two design facts that make a bound expressible or not, the row
type's fields and `is_tail`'s coverage test, come from that file's second and third
investigation questions. Nothing here is new discovery. What is new is the
separation of retention from size, the proposal of a unit for the missing bound, and
line references re-verified at `HEAD` for this file.

## Evidence trail

`HEAD` `e447c927`. All lines read back for this file.

### There is no removal path to bound

`crates/mc-store/src/lib.rs`, every statement touching the three overlay tables.
Exactly two `DELETE`s exist and neither removes a spent row:

1. `:7754-7759`, the user-hint replace-delete, guarded by
   `if request.user_hints_replace_session` (`:7736`). It is host-driven, it applies
   only to `mc_user_hints`, and its purpose per the flag's own doc (`:3263-3268`) is
   to stop replaying hints the host can no longer validate. It is not a bound and it
   does not touch `mc_channel1_appends` or `mc_temporal_marks`.
2. `:8642-8654`, the lineage-descent wipe of the *target* key, immediately undone by
   the copy from the source key at `:8736-8751` (`mc_temporal_marks` `:8736-8739`,
   `mc_user_hints` `:8742-8745`, `mc_channel1_appends` `:8748-8751`). A descent
   therefore preserves rows rather than removing them.

No age predicate, no count cap, no byte cap, no TTL column, and no row-count
trigger exists for either table. So this record is not about a reaper that is too
slow; it is about a window that has no implementation to measure. That is why the
`Check:` states the bound as absent rather than proposing a generous timeout, which
METHOD.md's liveness rules forbid: a timeout cannot distinguish one removal pass
from a thousand, and here it cannot distinguish either from zero.

### What the schema can and cannot express

`Channel1AppendRow` (`:2617-2621`) carries exactly `block_id`, `reminder_text` and
`fired_at_ms`. Two consequences for the bound:

- An **age-keyed** window is expressible today, because `fired_at_ms` is stored.
- A **coverage-keyed** window is not, because the row carries no ordinal. A reaper
  keyed on coverage would have to resolve ordinals from the projection at commit
  time, or the row type would have to change.

This is a fact about the schema and is recorded as one. It is not a recommendation:
the parent record's second open question, which asks whether the reaper should key
on the overlay frontier, on tag retirement or on compartment coverage, remains a
design decision and is inherited here as this record's first open question.

### Why passes is nonetheless the natural unit

The module already decides, on every pass, whether a block is below coverage.
`is_tail(ordinal, coverage)` (`crates/mc-module/src/transform.rs:6471-6473`) is
`coverage.is_none_or(|c| ordinal > c)`, and `meta.coverage_ordinal`
(`mc-store/src/lib.rs:2250`) is the comparison's other side. A block at or below
coverage can never be selected for a new append again, because the selector
consults `is_tail` at the site the parent record cites. So the removable set is
already decidable at the moment the transaction commits, and a coverage-keyed
reaper has no reason to need a second pass. That is the whole argument for the
one-pass proposal in the `Check:` line, and it is offered as a proposal precisely
because the schema fact above says the row type cannot carry it yet.

### What a surviving row costs while it survives

Nothing, while its block is out of the projection. `tag_overlay_state` builds
`channel1_by_block_id` from every loaded row
(`crates/mc-module/src/transform.rs:8164-8167`; the parent record and its evidence
file both cite `:8161-8165`, which lands on the preceding `user_hint_by_block_id`
arm, and the reference is corrected here per METHOD.md rule 1), but
`apply_tag_overlay_to_message` writes into `message.content[block.block_index]`
only for blocks passed in for that mid (guard at `:8227`, write at `:8231`), so a
row for a comparted block never fires. The cost arrives when the block id is
reconstructed. Block ids are `ck_wire::block_id(&message_id, block_index)`, a
deterministic pair, so a message re-entering the request with the same mid and
block layout matches the old row and the reminder is re-applied, quoting
`approx_thousands(reclaimable_tokens)` (`:9862-9864`; the parent cites `:9861-9863`,
one line early, corrected here) captured from a session state that no longer
exists.

## Failure scenario

The one that is not about size, which is the reason this record is separate from
its parent.

A Channel-1 reminder fires on a tool result block. The session continues, the block
falls below coverage, and the reminder is inert. Nothing removes the row, because
nothing removes any row. Later a lineage descent copies every row forward
(`mc-store/src/lib.rs:8748-8751`) into a session that can re-present earlier
messages. The copied row's `block_id` resolves against a re-presented block, and a
reminder from before the descent is appended to it, telling the agent about roughly
40k reclaimable tokens in a session whose tail is now 5k.

The parent record owns the slow version of this: unbounded rows, unbounded read
cost, one row of roughly 300 reminder bytes per firing forever. Both costs share a
cause and neither fix addresses the other. A stated ceiling on the row count would
still permit a single spent row to survive to reconstruction, and a bounded removal
window bounds the count as a side-effect without anyone having to pick a ceiling.
That asymmetry is the argument for splitting rather than weakening.

## Timing windows and dependencies

Not a race. The window is the quiescent period after the target block leaves the
projection, and the fault-free requirement inside it is that nothing re-presents
the block: a reappearance during the window makes a surviving row *correct* rather
than stale, which would make the test pass for the wrong reason.

The window has no stated length, which is the finding. Its natural start is the
first pass on which `is_tail` is false for the row's block. Its natural unit is
passes, for the reason in the evidence trail. Its natural implementation is
`fired_at_ms`, for the schema reason in the evidence trail. Those three do not
agree, and reconciling them is the product decision.

Dependencies: `tagging_active` (`transform.rs:3503-3504`) for Channel-1,
`temporal_active` (`:3525`) for the temporal table, and the length of the session.
Nothing caller-supplied is needed.

## What a test must construct

The removal oracle cannot be written until a bound exists. What can be written
today is the negative form, which pins current behaviour and makes the missing
window measurable rather than theoretical. This is step 2 of the parent record's
test construction, extended past the firing pass:

1. Seed a row directly with `seed_channel1_append_for_test`
   (`mc-store/src/lib.rs:6664`, gated `#[cfg(feature = "test-support")]` at
   `:6663`, so the test must enable that feature), which avoids having to generate
   enough token mass to clear the cadence gate. The parent record notes the fixture
   cost of the real path: `"word ".repeat(40_000)` per result at
   `transform.rs:23556`.
2. Advance the projection so the seeded row's block is at or below
   `meta.coverage_ordinal`, and assert `is_tail` is false for it. This is the point
   at which the window should start.
3. Drive N further `tagging_active` passes with no new tool output, then assert
   whether `load_channel1_appends(session)` still contains the `block_id`. Today it
   does, for every N. Asserting that fact is the honest test: it records that the
   window is unbounded rather than pretending to measure it.
4. For the hazard the window would close: present a request whose projection
   contains that `block_id` again and assert whether the reminder is re-applied.
   That converts the reappearance question from theoretical to observed, whichever
   way it comes out.

The cheapest valid oracle is a row count plus a `contains` check, which is one
query. The expensive part of the parent's version, generating cadence mass, is
avoided entirely by the seeding helper.

## Investigation log

### Q: What is the bound, and in what unit?

- Sources examined: `Channel1AppendRow` (`mc-store/src/lib.rs:2617-2621`),
  `meta.coverage_ordinal` (`:2250`), `is_tail`
  (`crates/mc-module/src/transform.rs:6471-6473`), and the parent evidence file's
  second investigation question, which reached the same three candidates.
- Findings: three answers exist and they do not agree. Passes is the unit the
  module's own removability test is evaluated in. Milliseconds via `fired_at_ms` is
  the unit the schema already stores. Compartment coverage is the semantically
  correct key and is the one the row type cannot express. A record cannot choose
  between them, because the choice determines whether the row type changes.
- Missing evidence: none needed for the observation; what is missing is a decision.
- Conclusion: needs human input. This is the parent record's second open question
  arriving in the place where it actually blocks something: without it, this
  record's `Check:` has no oracle.

### Q: Does a lineage descent reset the window?

- Sources examined: the descent copy (`mc-store/src/lib.rs:8736-8751`), the
  target-key wipe that precedes it (`:8642-8654`), and `fired_at_ms` on the copied
  row.
- Findings: the copy carries `fired_at_ms` forward, so an age-keyed window would
  continue to run across a descent while a coverage-keyed window would restart,
  because the descended session's coverage is its own. A descended session can also
  re-present earlier messages, which is what makes a copied row dangerous rather
  than merely old. Whether a mid can reappear after leaving the projection depends
  on the projection cache's mid-stability contract.
- Missing evidence: that contract, which is 4b's.
- Conclusion: unresolved, needs 4b. This is the same dependency the parent record's
  first open question records, and it is not narrowed by the split.

### Q: Does `mc_user_hints` having a reaper supply a bound this record could borrow?

- Sources examined: `mc-store/src/lib.rs:7736-7760`,
  `ModuleStateSyncRequest::user_hints_replace_session` (`:3263-3268`), and the
  parent evidence file's third investigation question.
- Findings: no. The parent file already concluded that the hint reaper is "safer,
  not safe": it runs only when the host sets the flag and supplies its complete
  decision list, so a host that never sets it gets no reaping at all. More
  decisively for this record, a replace-delete is not a window. It removes rows
  absent from a caller-supplied set at a caller-chosen moment, which bounds nothing
  in time or in passes and cannot be transplanted onto a table whose rows no caller
  enumerates.
- Missing evidence: none.
- Conclusion: resolved with answer. The one existing reaper in the family supplies
  no borrowable bound, so the missing window has to be stated rather than copied.
