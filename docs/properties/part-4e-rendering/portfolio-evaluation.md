# Part 4e portfolio evaluation (reconstructed from a report)

**Read this first. Two of the evaluation's nine refinements are applied in
`catalog.md`. The other seven were never applied, and this file exists so they
are not lost a second time.** They are listed as actionable work under
[Refinements not applied](#refinements-not-applied-seven-outstanding), each with
the target artifact, the change, and the evidence re-verified at `HEAD`.

Outstanding refinement count: **7 of 9**.

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
  against the source at `HEAD` for this file, and every line reference here was
  printed before being written. What cannot be recovered is the evaluator's own
  reasoning, the order it supplied its findings in, the options it weighed and
  rejected, and its per-finding lens attribution. Sibling parts record all four.
- **No finding numbers are reproduced.** Sibling evaluations number findings `F1`
  through `Fn` in the order the evaluator supplied them. That order is gone, so
  the seven outstanding refinements are numbered `R1` through `R7` here, in the
  order the report lists them. **`R1` is not the evaluator's `F1`.**
- **Three of the seven are already reflected in `catalog.md`'s prose and not in
  its records.** The reconstruction brief that rebuilt `catalog.md` carried the
  disposition summary, so the header sections absorbed the substance of `R4`,
  `R5` and `R6` while the records they name were left untouched. Each entry below
  says exactly which artifact still needs the change. This is the
  precision-does-not-propagate-sideways pattern Part 4c's evaluation named, in
  its worst form: the correction is in the same file as the record it corrects.
- **`R3` cannot be applied without creating records.** It splits two records into
  four, which needs two new slugs and two new evidence files. `catalog.md`
  already records that limit under
  `### Refinements applied after the portfolio evaluation` and declines to
  fabricate them. That decision stands; the work is real and stays queued.

Provenance. System `/local/home/ahrav/scratch/magic-context`, `HEAD` =
`e447c927` ("refactor(shm): trim final review leftovers"), which is what
`catalog.md`, `existing-checks.md` and `fault-map.md` already state. The
evaluation covered **24 records** on rendered output, tags and the nudge overlay.
Method contract in [../METHOD.md](../METHOD.md).

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 9 | **2 applied, 7 outstanding** |
| gap | 4 | queued for a follow-up pass, none mined |
| bias | 2 | require human judgment |

Record count stays at **24**. Applying `R3` takes it to 26.

Semantics distribution is unchanged by this file and is audited in
`catalog.md` under `### Check-semantics audit`: `always` 18, `always(!X)` 2,
`always-or-unreached` 1, `sometimes` 2, `unreachable` 1. No `reachable`.

Types **21 safety, 3 reachability, 0 liveness**, counted from `catalog.md`'s index
and confirmed against the records' own `Type:` lines. The three reachability
records are the one `unreachable`
(`render-a-user-hint-total-cap-cannot-bind`) and the two `sometimes` situation
markers. The zero liveness is the subject of `R3` and of bias 1.

## Refinements applied (two)

Both are in `catalog.md`, named there under
`### Refinements applied after the portfolio evaluation`, and both were
re-verified for this file.

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

## Refinements not applied (seven outstanding)

Actionable as written. Each entry names the target artifact, the change, and the
premise as re-verified at `HEAD`.

### R1. The fault map's workhorse accounting double-counts a seeding class

**Target:** `fault-map.md`, the `F7` row (`:79`) and leverage item 3 (`:372-387`).
Also the two `Partial` verdicts at `:111` and `:114` and the totals line at
`:154`.

**Change, part one: split the seeding class and recount.** Leverage item 3 claims
`F7` "make six records non-vacuous", and two of the six seed a synthetic todo
pair rather than a frozen core unit. `F7` is defined at `:79` as "a `CoreState`
carrying a `strip:`, `red:`, `cav:` or reduced/sentinel frozen unit". The source
keeps those two stores separate. The splice reads frozen units from
`core.frozen_units`, through `FrozenUnitIndex::new(&core.frozen_units)` or a scan
(`transform.rs:11699-11703`), while the synthetic pair is read from
`meta.synthetic_todo` (`:11805-11808`), a distinct `Option<FrozenSyntheticTodoPair>`
field on `ModuleMeta` (`mc-store:2295-2299`). Seeding one does not seed the other.

So `F7` as defined covers **four** records:
`render-a-hygiene-metric-ignores-surface-strips`,
`render-a-emptied-tail-message-drops-without-a-report`,
`render-a-orphan-tool-arc-has-no-production-detection` (the removal half), and
the weaker form of `render-a-overlay-targets-stale-indices-after-full-drop-filter`
via a whole-message strip at `:10388`. The two todo-pair records,
`nudge-b-frozen-todo-pair-retires-only-on-a-bust` and
`nudge-b-injected-todo-pair-carries-no-provider-visible-provenance`, need a
distinct `ModuleMeta.synthetic_todo` seeding class.

**This recount moves attribution, not the totals.** Both todo-pair records stay
constructible with no fault, by seeding `ModuleMeta` instead of `CoreState`, so
`22 non-vacuous / 2 partial / 0 blocked` still holds. What changes is the claim
that one capability unblocks six records, which is what the leverage ranking
tells a reader to do first.

**Change, part two: two `Partial` rows are not genuinely partial.**

- `render-a-overlay-targets-stale-indices-after-full-drop-filter` (`:111`) is
  `Partial` because "whether a real harness emits that message shape ... depends
  on the 4f codecs". A typed wire fixture constructs it directly:
  `user_carried_tool_result_pairs_with_prior_assistant_call`
  (`ck_wire.rs:1062-1089`) builds a `role: "user"` message carrying a
  `CkKind::ToolResult` block followed by a `CkKind::Text` block through
  `CkWireMessage::from_parts`. Two precisions belong with it. The fixture proves
  **test constructibility**, which is what a `non-vacuous today` verdict is
  about, not that a production harness emits the shape. And the comment above
  that test (`:1057-1060`) states the shape as real harness behaviour: "Claude
  Code emits the tool_result INSIDE the next user message ... when input arrives
  while a tool is still running", which is evidence for the production half
  rather than proof of it.
- `render-a-mint-batch-block-ids-are-unique-per-pass` (`:114`) is `Partial`
  pending "whether the `mc_tags` SQLite triggers advance `generation` for *every*
  mutation, not only inserts". They do. Three triggers exist:
  `mc_tags_cache_generation_insert` (`mc-store:972`),
  `..._delete` (`:981`) and `..._update` (`:995`), and each sets
  `generation = generation + 1` on conflict. The update trigger does it twice,
  once for `OLD.session_id` and once for `NEW.session_id` (`:995-1017`), so a
  cross-session move advances both. The `mc-store` question the row defers is
  answered in `mc-store`.

Resolving both moves the fault-map totals to `24 non-vacuous / 0 partial / 0
blocked` and empties the paragraph at `:161-163` that explains the two `Partial`
rows.

### R2. Both `sometimes` records omit their marker names

**Target:** `catalog.md`, the `Check:` lines of
`render-a-hint-fragment-cap-binds-in-a-served-render` and
`nudge-b-one-block-carries-several-overlay-kinds`.

**Change:** give each a globally unique constant marker name. METHOD.md's
coverage-check rules require it: "Marker names are constant and globally unique.
Never construct them dynamically." Both records state their situation in prose
and name nothing. The gap is visible inside `fault-map.md`, whose 19 coverage
checks are all named constants in the required form, and whose own note says
markers duplicating the two existing `sometimes` records are "deliberately
absent" (`:170-172`). So the fault map declined to name them on the grounds that
the records own them, and the records did not name them either.

### R3. Two records mix safety with bounded progress

**Target:** `catalog.md`, two records, splitting each into a safety half and a
bounded liveness half. Also the index, the group preambles, the relationship map,
the semantics audit, and two new `evidence/<slug>.md` files.

**Change:**

- `nudge-b-channel1-append-rows-have-no-reaper` embeds eventual removal inside an
  `always` safety check. Its `Check:` line asserts a count bound and, in the same
  conjunction, that "a row whose target block has left the projection is
  eventually removed within a stated number of passes". The record already
  concedes the mix in its own rationale, that "the removal half needs the bound
  stated in passes, per the liveness rule, and no such bound exists in the code
  today". Removal-within-a-bound is liveness and needs its own record.
- `nudge-b-channel2-retirement-is-caller-asserted` embeds bounded time-to-live
  rearming. Its `Guarantee` reads "retired only when it was actually delivered,
  **or else the retirement is bounded** so a lost directive is re-armed", and its
  `always` check lists the lease TTL as one of three permitted transitions. The
  mechanism is at `transform.rs:9450-9458`: when
  `now_ms.saturating_sub(pending.armed_at_ms) >= CHANNEL2_DIRECTIVE_LEASE_TTL_MS`
  (`:9453-9454`) the code calls `rearm_channel2_cycle(meta)` (`:9457`). That is a
  bound stated in the unit the code bounds, which is what METHOD.md's liveness
  rules require, and it does not belong inside a safety check.

**This is why the part shows zero liveness.** The two bounded-progress
obligations exist in the code and are cataloged, folded into safety records where
no liveness check can be derived from them. Bias 1 argues the zero is systematic
rather than a fact about this part's subject.

**Blocked, and honestly so.** Applying it creates two records that never existed
as records, with no evidence files to carry forward. `catalog.md` records that
limit rather than inventing them. Closing it needs a fresh pass over the two
records concerned, not a reassembly.

### R4. The strip-blindness record states one failure direction

**Target:** `catalog.md`, `render-a-hygiene-metric-ignores-surface-strips`, its
`Impact` line. Also `fault-map.md:122`.

**Change:** state the severity error as **bidirectional**. Stripped tokens can
push a band either way, depending on whether they contribute to the denominator.
`TailHygienePartMeasurement` sets `tokens` and then
`u_tokens: if active && !protected { tokens } else { 0 }`
(`tail_hygiene.rs:265-272`), so a stripped block whose tag is active inflates
both `t` and `u`, while a stripped block that is untagged or protected inflates
`t` alone. `hygiene_band` (`:704-712`) computes `severity = u as f64 / t.max(1)`
(`:709`) and ladders on it, so the ratio moves up or down according to which case
the strip was.

**Why the direction matters more here than usual:** the bands were calibrated on
a post-strip measurement the code does not make. `fault-map.md:122` cites
`docs/nudge-hygiene-calibration-2026-08-16.md:10` for the replay that set the
shipped bands having "applied persisted drops **and strip transforms**". A
one-directional bias could be absorbed by moving a threshold. A bidirectional
error cannot.

**Already reflected in prose, not in the record.** `catalog.md`'s
`## What this part is about` states the bidirectional form with both citations.
The record's `Impact` says `t` and possibly `u` "overstate the served tail" so
the gates "fire on a tail that is smaller than measured", which is the
one-directional reading. `fault-map.md:122` says a strip "inflates `t` and
therefore depresses `severity = u/t`", which is the same single direction.

### R5. The provenance claim is overstated

**Target:** `catalog.md`,
`nudge-b-injected-todo-pair-carries-no-provider-visible-provenance`, its
`Guarantee` line and, if a rename is accepted, its slug.

**Change:** restate the claim as **"no explicit model-facing provenance field"**.
The record's guarantee promises that injected content is "distinguishable from
content the user or the agent authored, at the layer that consumes it", and the
distinction is real up to the last hop.

- Provenance survives in both encodings. `HarnessMeta::synthetic` is serialized
  on the CK wire (`mc-store:64`), and the OpenCode encoder emits a native marker:
  `render_synthetic_todo_pair` (`codec/opencode.rs:916-947`) returns a part
  carrying `"syntheticTodoMarker": true` (`:946`).
- The chain breaks at the consumer. `todo-view.ts:117-126` records that the
  OpenCode wire serializer `MessageV2.toModelMessagesEffect` "only reads
  `part.state.*`, `part.callID`, `part.tool`, and `part.metadata`", so it reads
  the call id and ignores the marker.
- The id format is deliberately distinctive.
  `computeSyntheticCallId`'s doc comment (`todo-view.ts:185-196`) states the
  format was "chosen to clearly distinguish from real provider-generated IDs" and
  contrasts `mc_synthetic_todo_<16 hex chars>` against `toolu_` and `call_`.

So a signal does reach the provider array. What is missing is a field that says
so, and the surviving signal is a tool-call id prefix nothing documents as a
provenance contract. Bias 2 asks whether the standard behind this record is a
product contract at all.

**Already reflected in prose, not in the record.** `catalog.md`'s
`## What this part is about` opens the paragraph with "Injected content has no
explicit model-facing provenance field. State it that way rather than as
'indistinguishable'", and carries all three citations. The record still asserts
the wide form.

### R6. The 237 figure is static reach candidates, not measured executions

**Target:** `existing-checks.md`, the headline at `:74-78` and the `Reach` row of
the tier table at `:117`. Also `fault-map.md:334`, which reads "237 whole-pass".

**Change:** relabel 237 as **static reach candidates** wherever it appears, not
as tests that execute. Three independent reasons, all still true at `HEAD`:

- The method rests on an unpublished 62-symbol set. `existing-checks.md:816-820`
  concedes it: "The curated 62-identifier set is not reproducible from this
  file ... A later pass recomputing either number will get a different answer
  unless it uses the same list."
- It disagrees with siblings on helper and driver counts. The helper population
  is 115 by the fixpoint's own detector and 130 by an independent recount, and
  the driver count is 207 by lens C's detector against 210 by 4b's
  (`existing-checks.md:830-834`).
- There is no coverage instrumentation. `existing-checks.md:806-810` states the
  attribution comes "from symbol matching plus a helper fixpoint over parsed test
  bodies, not from coverage instrumentation, which this repository does not
  have".

**Partly reflected already, and the headline is the part still missing.**
`catalog.md:220` carries the relabel in full: "These are **static reach
candidates, not measured executions**." `existing-checks.md`'s sampling-limits
section carries all three reasons. But `existing-checks.md:74-78`, which that
file itself calls "the headline", still reads "**277 in-crate tests reach this
scope: 237 of the 280 tests ...**", and the tier table row still reads
`**Reach** | **237** of 280 | Drives a whole pass`. A reader who trusts the
headline and skips the limits section gets the unlabelled number.

### R7. Four driver detectors disagree, so the reconciliation is a bracket

**Target:** `existing-checks.md`, the reconciliation section at `:146-181` and
the sampling limit at `:830-834`.

**Change:** record that **four** driver detectors disagree, not two, and treat
the reconciliation as a bracket rather than a number. The four values and their
sources, as `part-4f-decisions/existing-checks.md:723-724` already states them:

| Value | Detector |
| --- | --- |
| 210 | 4b's |
| 207 | 4e's lens C |
| 206 | 4b's stated literal rule, reproduced in 4f |
| 196 | a transitive helper fixpoint |

4e currently records the two-way 207-versus-210 edge (`:57-60`, `:176-180`,
`:830-834`) and turns its reconciliation on the 210. 4f records the four-way
spread and states its reach tier as the range `206-210` (`:152`, `:720`). The 4e
reconciliation arithmetic that derives `210 + 22 + 5 = 237` and `Union = 253`
(`:159`, `:165-168`) is exact only if 210 is exact.

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

The evaluator's verdict was **"not ready"**, and with seven refinements
outstanding the honest answer is further from ready than the evaluation left it.

What is settled. Two records' semantics are now correct: one forbidden value is
asserted as a forbidden value, and the one genuine forbidden code location keeps
`unreachable` with an unambiguous subject. That closes the part's only
semantics misuse.

What is not. Four artifact-level defects survive in the artifacts a reader acts
on: a leverage ranking that credits one capability with six records when it
covers four (`R1`), two `Partial` verdicts whose blocking questions are answered
in the source (`R1`), two `sometimes` records with no marker names (`R2`), and a
coverage headline that reads as measured executions (`R6`). One correction cannot
be applied without a fresh pass (`R3`), and it is the same one that explains the
part's zero liveness. Two more are recorded in prose while the records they
correct still carry the wrong version (`R4`, `R5`), which is the worst shape a
finding can be left in: a reader who reads the record and not the header gets the
withdrawn claim, from the same file.

Above all of it sits the fact none of these corrections touches. Nothing in this
scope executes in CI. Every `Exercised:` line and every `Existing check:` line in
Part 4e is written against a suite no automation runs, `F0` at the top of the
leverage ranking unblocks zero records while protecting all of them, and the day
one of those tests runs, the meaning of "partial" changes across all 24 records.

## Re-evaluation trigger

A fresh evaluation pass, not a reassembly, is warranted on any of these.

- **Applying `R3`.** It creates the part's first liveness records and changes the
  record count from 24 to 26. A count that moves for a substantive reason
  invalidates every totals line in the three artifacts.
- **Any resolution of bias 1 that says the zero-liveness pattern is method
  rather than scope.** That makes `R3` the first instance of a correction owed
  across parts, and this part's disposition stops being the unit of work.
- **Any resolution of bias 2.** Either answer changes two records. A stated
  contract leaves both standing and narrows the first to a missing field; a
  demotion moves both out of the safety set.
- **Mining G2.** A documented always-present claim contradicted by a conditional
  emission is the part's first contract-versus-code record over the prompt-cache
  boundary rather than over a render's own bytes.
- **Any workflow change that runs a test in this scope.** This is the same
  trigger Parts 4b and 4c recorded, unresolved, and it remains the largest single
  fact about this part.
