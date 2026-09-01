# Part 4e portfolio evaluation (reconstructed from a report)

**Read this first. All nine of the evaluation's refinements are now applied.** Two
were applied during the reconstruction of `catalog.md`. The other seven were
recorded here so they would not be lost a second time, and they were applied in a
later pass; each is listed under
[Refinements applied](#refinements-applied-all-nine) with the artifact that
changed, what changed in it, and the premise as re-verified at `HEAD`.

Outstanding refinement count: **0 of 9**.

The four queued gaps and the two biases are **unchanged and still open**. They were
not part of that pass and are not closed by it.

## What this file is, and what it is not

This is **not** the evaluator's own file. The independent evaluation of Part 4e
ran, produced nine refinements, four queued gaps and two biases, and returned a
verdict of not ready. Its `portfolio-evaluation.md` was destroyed before it
reached disk, and only two of its refinements had been applied to `catalog.md` by
then. What survived is a report of its findings, and this file is written from
that report.

The consequences of that provenance are worth stating plainly rather than
smoothing over.

- **The findings below are second-hand.** Each one's *premise* was re-verified
  against the source at `HEAD`, first when this file was written and again when the
  refinement was applied, and every line reference here was printed before being
  written. What cannot be recovered is the evaluator's own reasoning, the order it
  supplied its findings in, the options it weighed and rejected, and its
  per-finding lens attribution. Sibling parts record all four.
- **No finding numbers are reproduced.** Sibling evaluations number findings `F1`
  through `Fn` in the order the evaluator supplied them. That order is gone, so
  the seven recovered refinements are numbered `R1` through `R7` here, in the
  order the report lists them. **`R1` is not the evaluator's `F1`.**
- **Three of the seven had reached `catalog.md`'s prose and not its records.** The
  reconstruction brief that rebuilt `catalog.md` carried the disposition summary, so
  the header sections absorbed the substance of `R4`, `R5` and `R6` while the records
  they name were left untouched. For a period the file contradicted itself, with the
  correction and the withdrawn claim in the same document. That is the
  precision-does-not-propagate-sideways pattern Part 4c's evaluation named, in its
  worst form, and closing `R4`, `R5` and `R6` closed it.
- **`R3` required creating records, and they were created rather than declined.**
  It splits two records into four, which needed two new slugs and two new evidence
  files. `catalog.md` previously recorded that limit and declined to fabricate them,
  which was the right call at the time because the material to write them honestly
  had not been assembled. It has been: both new evidence files draw only on the
  parent record and the parent evidence file, and each states in its own
  "Discovery trigger" section exactly what it drew from where, so a reader can tell
  inherited evidence from new verification.

Provenance. System `/local/home/ahrav/scratch/magic-context`, `HEAD` =
`e447c927` ("refactor(shm): trim final review leftovers"), which is what
`catalog.md`, `existing-checks.md` and `fault-map.md` already state. The
evaluation covered **24 records** on rendered output, tags and the nudge overlay.
Applying `R3` took the part to **26**. Method contract in
[../METHOD.md](../METHOD.md).

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 9 | **9 applied, 0 outstanding** |
| gap | 4 | queued for a follow-up pass, none mined |
| bias | 2 | require human judgment |

Record count is now **26**, up from 24, because `R3` split two records into four.

Semantics distribution is audited in `catalog.md` under
`### Check-semantics audit`: `always` 20, `always(!X)` 2, `always-or-unreached` 1,
`sometimes` 2, `unreachable` 1. No `reachable`. The two additions are the `R3`
liveness records, both `always` evaluated once at the end of an explicit bounded
window, which is the form METHOD.md's liveness rules require and the form Parts 4b
and 4c used.

Types are **21 safety, 3 reachability, 2 liveness**, counted from `catalog.md`'s
index and confirmed against the records' own `Type:` lines. The three reachability
records are the one `unreachable` (`render-a-user-hint-total-cap-cannot-bind`) and
the two `sometimes` situation markers. **The zero liveness is gone**, which was the
subject of `R3`; bias 1 remains open, because whether the zero was a fact about this
part or a systematic snapshot bias is a question `R3` supplies evidence for and does
not answer.

Fault-map totals moved twice and for different reasons, so they are stated
separately: `R1` cleared both `Partial` verdicts, taking the original 24 records to
**24 non-vacuous / 0 partial / 0 blocked**, and `R3` then added one non-vacuous
record and one blocked one, giving **25 non-vacuous / 0 partial / 1 blocked** over
26. The single blocked record is
`nudge-b-channel1-append-row-removal-has-no-bounded-window`, and it is blocked on a
missing bound rather than on a capability, so no item on the leverage ranking
unblocks it.

## Refinements applied (all nine)

Two were applied during reconstruction and are recorded first. The seven recovered
from the report follow, in the order the report listed them, each with the artifact
that changed.

### A1. A forbidden value was retyped from `unreachable` to safety

`render-a-light-surface-fallback-notice-never-served` is now type safety with
semantics `always(!fallback)`. Both of its targets are value-producing
expressions rather than branches. `prompt_surface.rs:139-142` is the
`PromptSurfacePreset::Light` arm whose field initializer is
`fallback: light.is_none()` (`:141`), and that arm **does** execute whenever the
Light preset is configured. `tool_manifest_falls_back` (`:156-158`) evaluates
`preset == PromptSurfacePreset::Light && TOOL_LIGHT_DESCRIPTIONS.is_none()`
(`:157`) on every manifest request. What can never happen is the value `true`.
METHOD.md gives a forbidden state with no dedicated detection point `always(!X)`,
so the record asserts the forbidden value and no longer claims a forbidden
location.

### A2. The total-cap record keeps `unreachable`, restated

`render-a-user-hint-total-cap-cannot-bind` has a genuine forbidden code location.
`truncate_hint_to_total_cap` opens at `transform.rs:9119` and guards at
`:9120-9122` with `if utf16_len(wrapped) <= limit { return wrapped.to_string(); }`,
so the truncating body at `:9123-9127` is entered only by falling through that
guard, and the arithmetic says it cannot. The `Check:` line now says the
truncating body is never entered, rather than naming the branch by its condition.
The cited range `:9120-9127` spans the guard plus the body and is accurate.

### R1. The fault map's workhorse accounting double-counted a seeding class

**Applied in:** `fault-map.md`.

**What changed, part one: the seeding class is split and the count corrected.**
Leverage item 3 claimed `F7` "make six records non-vacuous", and two of the six seed
a synthetic todo pair rather than a frozen core unit. `F7` was defined as "a
`CoreState` carrying a `strip:`, `red:`, `cav:` or reduced/sentinel frozen unit".
The source keeps those two stores separate. The splice reads frozen units from
`core.frozen_units`, through `FrozenUnitIndex::new(&core.frozen_units)` or a scan
(`transform.rs:11699-11703`), while the synthetic pair is read from
`meta.synthetic_todo` (`:11805-11808`), a distinct `Option<FrozenSyntheticTodoPair>`
field on `ModuleMeta` (`mc-store/src/lib.rs:2295-2299`). Seeding one does not seed
the other. Both ranges were re-printed at `HEAD` before the edit and both are exact.

`F7` now covers **four** records: `render-a-hygiene-metric-ignores-surface-strips`,
`render-a-emptied-tail-message-drops-without-a-report`,
`render-a-orphan-tool-arc-has-no-production-detection` (the removal half), and the
weaker form of `render-a-overlay-targets-stale-indices-after-full-drop-filter` via a
whole-message strip at `:10388`. The two todo-pair records,
`nudge-b-frozen-todo-pair-retires-only-on-a-bust` and
`nudge-b-injected-todo-pair-carries-no-provider-visible-provenance`, now cite a new
class, **`F7b` module-meta synthetic-pair seeding**, which is its own row in the
fault-class table and its own rung on the leverage ranking. `F7b` is named rather
than numbered `F9` so the existing `F0` through `F8` references elsewhere in the
file keep their meaning.

**The recount moved attribution, not the totals.** Both todo-pair records stay
constructible with no fault, by seeding `ModuleMeta` instead of `CoreState`. What
changed is the instruction the leverage ranking gives a reader: one capability
unblocking six records is a different build order from two capabilities unblocking
four and two.

**What changed, part two: both `Partial` verdicts are cleared.**

- `render-a-overlay-targets-stale-indices-after-full-drop-filter` was `Partial`
  because "whether a real harness emits that message shape ... depends on the 4f
  codecs". A typed wire fixture constructs it directly:
  `user_carried_tool_result_pairs_with_prior_assistant_call`
  (`ck_wire.rs:1062-1089`, the `fn` at `:1061`) builds a `role: "user"` message
  carrying a `CkKind::ToolResult` block followed by a `CkKind::Text` block through
  `CkWireMessage::from_parts`. The row records two precisions with it. The fixture
  proves **test constructibility**, which is what a `non-vacuous today` verdict is
  about, not that a production harness emits the shape. And the comment above that
  test states the shape as real harness behaviour, "Claude Code emits the
  tool_result INSIDE the next user message ... when input arrives while a tool is
  still running", which is evidence for the production half rather than proof of it.
  **Line-reference correction:** that comment is `:1056-1059`, not `:1057-1060` as
  this file previously recorded; `#[test]` is `:1060` and the `fn` is `:1061`.
  Corrected in `fault-map.md` per METHOD.md rule 1.
- `render-a-mint-batch-block-ids-are-unique-per-pass` was `Partial` pending
  "whether the `mc_tags` SQLite triggers advance `generation` for *every* mutation,
  not only inserts". They do. Three triggers exist:
  `mc_tags_cache_generation_insert` (`mc-store/src/lib.rs:972`), `..._delete`
  (`:981`) and `..._update` (`:995`), and each sets `generation = generation + 1` on
  conflict. The update trigger does it twice, once for `OLD.session_id` and once for
  `NEW.session_id`, so a cross-session move advances both. **Line-reference
  correction:** that trigger spans `:995-1018`, not `:995-1017`; `:1018` is its
  `END;`. Corrected in `fault-map.md` per METHOD.md rule 1.

Resolving both moved the fault-map totals to `24 non-vacuous / 0 partial / 0
blocked` over the original 24 records, and the paragraph explaining the two
`Partial` rows is replaced by one recording that each question is now answered, one
inside 4e's own test tree and one in `mc-store`.

### R2. Both `sometimes` records now name their markers

**Applied in:** `catalog.md`, the `Check:` lines of
`render-a-hint-fragment-cap-binds-in-a-served-render` and
`nudge-b-one-block-carries-several-overlay-kinds`; also the compliance-review bullet
in `fault-map.md` that recorded the gap.

**What changed:** each record now names a globally unique constant marker.
`render-a-hint-fragment-cap-binds-in-a-served-render` takes
`USER_HINT_FRAGMENT_TRUNCATION_SERVED` and
`nudge-b-one-block-carries-several-overlay-kinds` takes
`OVERLAY_KINDS_COLLIDED_ON_ONE_BLOCK`. Both are the names `fault-map.md` had already
proposed, so the two files now agree rather than one proposing and the other
declining. A repository-wide grep confirmed neither name occurs anywhere else in the
catalog, so both are globally unique as METHOD.md requires, and neither is
constructed dynamically.

Both were then checked for compliance now that they are named, which is the part of
this refinement that could have failed and did not. Each marker witnesses a legal
state of a correct implementation: a served `<ctx-search-hint>` block with a
truncated fragment line, and one `block_id` present in two or more of the four
overlay maps. Neither asserts a violation, and neither has an `always(!X)` companion
anywhere in the catalog, so neither acquires the forbidden
`always(!X)`-with-`sometimes(X)` pairing that can fire only by observing the defect.
The second record additionally now states that three is the maximum by construction,
not four, which `fault-map.md` had asked for in the same bullet.

### R3. Two records that mixed safety with bounded progress are split into four

**Applied in:** `catalog.md`, two records restated and two created, plus the index,
two group preambles, the relationship map, the check-semantics audit and the
reachability counts; `fault-map.md`, three rows and the totals; and two new
`evidence/<slug>.md` files.

**What changed:**

- `nudge-b-channel1-append-rows-have-no-reaper` embedded eventual removal inside an
  `always` safety check. Its `Check:` line asserted a count bound and, in the same
  conjunction, that "a row whose target block has left the projection is eventually
  removed within a stated number of passes". The record already conceded the mix in
  its own rationale. It now keeps the count bound alone, and the removal obligation
  is
  **`nudge-b-channel1-append-row-removal-has-no-bounded-window`**, type liveness,
  `default-production`.
- `nudge-b-channel2-retirement-is-caller-asserted` embedded bounded time-to-live
  rearming. Its `Guarantee` read "retired only when it was actually delivered, **or
  else the retirement is bounded** so a lost directive is re-armed". It now keeps the
  permitted-transition set alone, with the TTL retained there as a permitted *cause*
  of the transition, and the bounded re-arm is
  **`nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl`**, type
  liveness, `explicit-config-only` inherited from its parent.

**The two new records are not symmetric, and that is the substantive result of
applying this rather than a presentational detail.** The Channel-2 record states its
bound in the unit the code bounds: `CHANNEL2_DIRECTIVE_LEASE_TTL_MS`, 10 minutes at
`transform.rs:111`, with the predicate at `:9454` and `rearm_channel2_cycle` at
`:9457`. It is constructible today, because `now_ms` is a parameter. The Channel-1
record has **no bound in the code to state**, since no removal path exists at all,
so it records that absence as the finding, proposes a one-pass window against
`is_tail`/`coverage_ordinal` while labelling the proposal as a proposal, and is the
fault map's single blocked row. Writing an unbounded "eventually" would have
satisfied the schema and violated METHOD.md's liveness rules, so it is not written.

**Evidence provenance, stated because these files were not produced by a discovery
pass.** Both draw only on the parent record in `catalog.md` and the parent's
existing evidence file, and each says so in its own "Discovery trigger" section. The
Channel-2 file inherits its retirement-path enumeration, its ten-minute window and
its test construction from the parent's "Evidence trail" section 2, "Timing windows
and dependencies", and step 4 of "What a test must construct"; the parent's third
investigation question, which established that corroboration is impossible from the
module's position, is cited as the reason the record matters rather than restated.
The Channel-1 file inherits the `DELETE` enumeration, the growth mechanism, the
stale-row analysis, the lineage-descent hazard and the seeding helper from the
parent's corresponding sections, and its two design facts, the row type's fields and
`is_tail`'s coverage test, from the parent's second and third investigation
questions. What is new in each is framing rather than discovery, plus line
references re-verified at `HEAD`. That verification produced two corrections, both
recorded in the new Channel-1 file: `channel1_by_block_id` is built at
`transform.rs:8164-8167`, not `:8161-8165` which lands on the preceding
`user_hint_by_block_id` arm, and `approx_thousands` is `:9862-9864`, not
`:9861-9863`. A third correction, `channel1_refire_tokens` at `:9623-9626` rather
than `:9624-9627`, is recorded in the parent record itself.

**This is why the part showed zero liveness, and it now shows two.** Both
bounded-progress obligations existed in the code and were cataloged, folded into
safety records where no liveness check could be derived from them. Bias 1 argues the
zero was systematic rather than a fact about this part's subject, and that argument
is unaffected by the split: applying `R3` supplies the local evidence and does not
decide whether the pattern is method or scope.

### R4. The strip-blindness record now states both failure directions

**Applied in:** `catalog.md`, the `Impact` line of
`render-a-hygiene-metric-ignores-surface-strips`; and the corresponding
`fault-map.md` row.

**What changed:** the severity error is stated as **bidirectional**. Stripped tokens
can push a band either way, depending on whether they contribute to the numerator.
`TailHygienePartMeasurement` sets `tokens` and then
`u_tokens: if active && !protected { tokens } else { 0 }`
(`tail_hygiene.rs:265-270`), so a stripped block whose tag is active inflates both
`t` and `u`, while a stripped block that is untagged or protected inflates `t` alone.
`hygiene_band` (opening `:704`) computes `severity = u as f64 / t.max(1)` (`:709`)
and ladders on it (`:710-716`), so the ratio moves up or down according to which
case the strip was.

**Why the direction matters more here than usual:** the bands were calibrated on a
post-strip measurement the code does not make.
`docs/nudge-hygiene-calibration-2026-08-16.md:10`
records that the replay setting the shipped bands "applied persisted drops **and
strip transforms**". A one-directional bias could be absorbed by moving a threshold.
A bidirectional error cannot, and `fault-map.md`'s product-decision list now says so
where it previously left "threshold adjustment requires owner sign-off" to imply that
a threshold move was the available fix.

The record's `Impact` previously said `t` and possibly `u` "overstate the served
tail" so the gates "fire on a tail that is smaller than measured", and the
`fault-map.md` row said a strip "inflates `t` and therefore depresses
`severity = u/t`". Both were the one-directional reading and both are replaced.
`catalog.md`'s `## What this part is about` already stated the bidirectional form
with both citations, so the record and the header now agree.

### R5. The provenance claim is narrowed to the missing field

**Applied in:** `catalog.md`, the `Guarantee` line of
`nudge-b-injected-todo-pair-carries-no-provider-visible-provenance`; and the
corresponding `fault-map.md` row.

**What changed:** the claim is now **"no explicit model-facing provenance field"**.
The record's guarantee previously promised that injected content is "distinguishable
from content the user or the agent authored, at the layer that consumes it", and the
distinction is real up to the last hop.

- Provenance survives in both encodings. `HarnessMeta::synthetic` is serialized
  on the CK wire (`mc-store/src/lib.rs:64-65`), and the OpenCode encoder emits a
  native marker: `render_synthetic_todo_pair` (`codec/opencode.rs:916-947`) returns a
  part carrying `"syntheticTodoMarker": true` (`:946`).
- The chain breaks at the consumer. `todo-view.ts:117-126` records that the
  OpenCode wire serializer `MessageV2.toModelMessagesEffect` "only reads
  `part.state.*`, `part.callID`, `part.tool`, and `part.metadata`", so it reads
  the call id and ignores the marker.
- The id format is deliberately distinctive. `computeSyntheticCallId`'s doc comment
  (`todo-view.ts:185-196`) states the format was "chosen to clearly distinguish from
  real provider-generated IDs" and contrasts `mc_synthetic_todo_<16 hex chars>`
  against `toolu_` and `call_`.

So a signal does reach the provider array. What is missing is a field that says
so, and the surviving signal is a tool-call id prefix nothing documents as a
provenance contract. Bias 2 asks whether the standard behind this record is a
product contract at all, and it stays open: narrowing the claim does not decide it.

**The slug is not renamed.** The evaluation offered a rename as optional. Renaming
would break the links from the index, the relationship map, the evidence file and
`fault-map.md`, and the restated `Guarantee` already carries the narrower claim, so
the cost buys no accuracy. Recorded as a decision rather than an oversight.

### R6. The 237 figure is labelled static reach candidates

**Applied in:** `existing-checks.md`, the headline and the `Reach` row of the tier
table, plus the two sampling-limit bullets that state the reasons; `fault-map.md`,
leverage item 1; and `catalog.md`, the sentence that states the number.

**What changed:** 237 is labelled **static reach candidates** wherever it appears,
not as tests that execute. Three independent reasons, all still true at `HEAD`:

- The method rests on an unpublished 62-symbol set. `existing-checks.md` concedes
  it: "The curated 62-identifier set is not reproducible from this file ... A later
  pass recomputing either number will get a different answer unless it uses the same
  list."
- It disagrees with siblings on helper and driver counts. The helper population
  is 115 by the fixpoint's own detector and 130 by an independent recount, and the
  driver count now has four values rather than two, per `R7`.
- There is no coverage instrumentation. The attribution comes "from symbol
  matching plus a helper fixpoint over parsed test bodies, not from coverage
  instrumentation, which this repository does not have".

`catalog.md` already carried the relabel in full, "These are **static reach
candidates, not measured executions**", and `existing-checks.md`'s sampling-limits
section already carried all three reasons. What was still missing was the headline,
which read "**277 in-crate tests reach this scope: 237 of the 280 tests ...**", and
the tier table row, which read `**Reach** | **237** of 280 | Drives a whole pass`.
A reader who trusted the headline and skipped the limits section got the unlabelled
number. Both now carry the label, the headline states the three reasons with links
to where each is evidenced, and the tier table's column header reads "Static reach
candidates".

### R7. Four driver detectors disagree, so the reconciliation is a bracket

**Applied in:** `existing-checks.md`, the correction bullet near the top, the
reconciliation section, the two summary tables and the sampling limit.

**What changed:** the file records that **four** driver detectors disagree, not two,
and treats the reconciliation as a bracket rather than a number. The four values and
their sources, as `part-4f-decisions/existing-checks.md:723-726` already stated them:

| Value | Detector |
| --- | --- |
| 210 | 4b's |
| 207 | 4e's lens C |
| 206 | 4b's stated literal rule, reproduced in 4f |
| 196 | a transitive helper fixpoint |

4e previously recorded only the two-way 207-versus-210 edge and turned its
reconciliation on the 210. 4f records the four-way spread and states its own reach
tier as the range `206-210` (`:152`, `:719-722`). The 4e reconciliation arithmetic
that derives `210 + 22 + 5 = 237` and `Union = 253` is exact only if 210 is exact,
so the summary table now reads `Shared | 196-210` and `Union | 253-267`, with the
210-based decomposition retained and labelled as the only detector for which bucket
sizes exist. **No correction is issued to 4b or to 4f**, and the 237 tier is not
restated: what is corrected is the claim that one number was reconciled when a range
was.

## Gaps queued for a follow-up pass

Recorded, not mined. Each premise was re-verified for this file.

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | **`caveman.rs` compatibility and its hygiene integration have no record.** 651 lines with one test, `differential_golden_matches_typescript_oracle` (`caveman.rs:626`, inside the `#[cfg(test)]` module whose attribute is `:612` and whose `mod tests` opens at `:613`, both closing at `:650`), which replays `testdata/caveman-golden.json` and asserts all three levels per case. The fixture holds **42 cases**, counted at `HEAD`. So the unit's whole claim-bearing surface is one cross-language snapshot that no workflow runs, and its integration with the hygiene metric is separately uncovered: `caveman_content` (`tail_hygiene.rs:422-429`) supplies measured text for a block, and all 12 `nudge-hygiene-golden.json` cases pass `&CoreState::default()` (`:1049-1056`), so the caveman arm (`:526`) is unreachable from the fixture that exists to stop cross-language drift. `fault-map.md` already asks for a `HYGIENE_MEASURED_A_TAIL_CONTAINING_A_CAVEMAN_UNIT` marker; no record owns the unit. |
| G2 | **Missing m0 and m1 frozen units violate documented always-present claims.** `memory_render.rs:7-14` documents both: the `<session-history>` tag "is always present (never omitted) so the provider prompt-cache has a stable breakpoint to anchor on", and the m1 block "is never fully empty because the provider prompt-cache needs a stable breakpoint". `assemble_m1`'s doc repeats it (`:320-322`): m1 "must never be fully empty, because the provider cache anchors a breakpoint at the m1 block and an empty block would shift it". Both emissions are conditional on the frozen unit existing: `transform.rs:11709-11755` pushes the m0 message only inside `if let Some(unit) = frozen_units.by_key("m0")` (`:11710`) and the m1 message only inside `if let Some(unit) = frozen_units.by_key("m1")` (`:11735`). An absent unit emits nothing, which is the shifted-bytes outcome both doc comments name as the thing to avoid. Per METHOD.md rule 3 this is a contract-versus-code disagreement with both sides cited, not a resolved defect. |
| G3 | **Release-only serving of a system-role synthetic prefix is uncataloged.** `transform.rs:12134-12144` guards the `SerializerProfile::ClaudeCodeAnthropic` arm with a `debug_assert!` (`:12139`) that no message before the first non-synthetic one carries `role == "system"`, with the message "claude-code-anthropic synthetic prefix must not contain system-role messages". A release build compiles the assertion out and serves the array. This is the part's fifth debug-versus-release content divergence and the only one with no record. |
| G4 | **The absent-frozen-unit fallback path generally.** G2 is the documented instance. The general question is what the splice serves when any expected frozen unit is missing, across every `frozen_units.by_key(...)` call site rather than the two `memory_render.rs` documents. No record covers the class. |

## Biases requiring human judgment

1. **Whether zero liveness is a fact about this part or a systematic snapshot
   bias.** By the time this evaluation ran, zero liveness had recurred in three
   consecutive parts, and the evaluator judged that systematic rather than
   per-part scope. `R3` is the local evidence: two bounded-progress obligations
   exist in 4e's code, one of them with an explicit TTL bound at
   `transform.rs:9450-9458`, and both are cataloged inside safety records where
   no liveness check can be derived from them. If the pattern is scope, then a
   rendering pass genuinely has few bounded-progress obligations and the zero is
   correct. If it is method, then a discovery pass that starts from "what must
   always hold" reliably folds bounded progress into safety, and the fix is a
   step in the pipeline rather than a refinement to this part. *Judgment
   required:* decide which, because the answer changes whether `R3` is one part's
   correction or the first instance of a standing correction across parts.

2. **Whether model-visible provenance is a product contract or an imported
   editorial standard.** Two records rest on it,
   `nudge-b-injected-todo-pair-carries-no-provider-visible-provenance` and
   `nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block`. No
   document in this repository states the obligation. What the code shows is a
   module that knows the shape of the problem and settles: the comment at
   `transform.rs:8525-8527` says CK "intentionally has no transport-origin field"
   for the system-reminder case and takes text shape as the narrowest safe
   discriminator, and `todo-view.ts:185-196` chooses a distinctive id format
   while noting that "Providers do not validate callID format". Both are
   deliberate choices, not oversights. *Judgment required:* either make
   model-visible provenance a stated product contract, in which case both records
   stand and `R5` narrows the first one to the missing field, or demote both to
   design risks. METHOD.md rule 3 forbids resolving this from the absence of a
   document, and rule 2 forbids guessing, so it stops here.

## Verdict

The evaluator's verdict was **"not ready"**. With all nine refinements applied the
honest answer is that the artifacts are now internally consistent and the part is
still not ready, for a reason no refinement touches.

What is settled. The part's only semantics misuse is closed: one forbidden value is
asserted as a forbidden value, and the one genuine forbidden code location keeps
`unreachable` with an unambiguous subject. Four artifact-level defects a reader
would have acted on are gone: the leverage ranking credits `F7` with the four
records it covers and names `F7b` for the other two (`R1`), both `Partial` verdicts
are cleared because both blocking questions are answered in the source (`R1`), both
`sometimes` records name a constant globally unique marker and were re-checked for
the forbidden pairing once named (`R2`), and the coverage headline no longer reads as
measured executions (`R6`). The self-contradiction is gone too: `R4`, `R5` and `R6`
had reached `catalog.md`'s prose while the records they correct still carried the
withdrawn claim, which is the worst shape a finding can be left in, and the records
now agree with the header. The part has its first two liveness records (`R3`), and
the more useful half of that result is that they are not symmetric: one states a
bound the code enforces, and the other records that no bound exists to state.

What is not. The four queued gaps are unmined and the two biases still need a human.
Bias 1 is now better evidenced and no closer to decided: `R3` proves two
bounded-progress obligations existed in 4e's code and were folded into safety
records, which is exactly what a systematic method bias would look like and also
what a part with genuinely few such obligations would look like. One record is
blocked on a product decision rather than a capability.

Above all of it sits the fact none of these corrections touches. Nothing in this
scope executes in CI. Every `Exercised:` line and every `Existing check:` line in
Part 4e is written against a suite no automation runs, `F0` at the top of the
leverage ranking unblocks zero records while protecting all of them, and the day
one of those tests runs, the meaning of "partial" changes across all 26 records.

## Re-evaluation trigger

A fresh evaluation pass, not a reassembly, is warranted on any of these.

- **`R3` has now been applied**, which is itself the first trigger on this list
  rather than a pending one. It created the part's first liveness records and moved
  the record count from 24 to 26, which invalidated every totals line in the three
  artifacts; all of them were recomputed in the same pass and verified mechanically
  (26 records, 26 index rows, 26 evidence files, no schema gaps). A fresh evaluator
  should treat the two new records as the least-reviewed material in the part: they
  were written from a parent record and a parent evidence file rather than from a
  lens pass, and neither has been read by anyone who did not also write it.
- **Any resolution of bias 1 that says the zero-liveness pattern is method
  rather than scope.** That makes `R3` the first instance of a correction owed
  across parts, and this part's disposition stops being the unit of work.
- **Any resolution of bias 2.** Either answer changes two records. A stated
  contract leaves both standing, with `R5`'s narrowing already in place; a
  demotion moves both out of the safety set.
- **Mining G2.** A documented always-present claim contradicted by a conditional
  emission is the part's first contract-versus-code record over the prompt-cache
  boundary rather than over a render's own bytes.
- **A stated bound for `mc_channel1_appends`.** It unblocks the part's only blocked
  record and it is a product decision, so it will arrive from outside this pipeline
  rather than from a pass.
- **Any workflow change that runs a test in this scope.** This is the same
  trigger Parts 4b and 4c recorded, unresolved, and it remains the largest single
  fact about this part.
