# Part 4a lens B: the validation gate as a trust boundary

One attention focus: `crates/mc-module/src/historian_validate.rs` treated as the
admission control point for language-model output that will replace the user's
served conversation. The state machine, phase durability, and publish ordering
belong to a sibling lens and are cited here only where admission depends on
them.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `76cd6f41`
("refactor(shm): simplify fixed-ring ownership"). `git status` reports no
modification to any file under `crates/mc-module/`, so every `mc-module` line
reference below is both the `HEAD` and the working-tree line. The workflow files
under `.github/workflows/` ARE modified in the working tree, so the CI claim in
section "Gate coverage" is stated against the working tree and the drift from the
scope map's line number is noted.

Method contract in [../../METHOD.md](../../METHOD.md). Region anchors from
[../../part-4-module/_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md).

Every line reference was read back individually at `HEAD`. Two corrections to
the scope map are recorded in "Contract-vs-code leads".

## Gate check inventory

The gate is two public functions plus their helpers. `parse_compartment_output`
(`historian_validate.rs:264-446`) turns text into structures.
`validate_historian_output` (`:450-641`) is the admission decision. The single
production caller is `publish_output_from_awaiting` (`historian.rs:1641-1704`),
which calls it at `:1673-1678`.

Two different dispositions matter, and the module does not name the difference:
a **reject** returns `Err` and no compartment is written; a **drop** silently
discards one structure and continues with the rest. Drops are listed separately
because they are not gate checks, they are gate holes with a `continue` in them.

### Rejecting checks

| # | Line | What it rejects |
| --- | --- | --- |
| 1 | `:267-271` | Text that is not wholly one `<output>` root. The regex at `:1159` is anchored `\A`/`\z`, so leading or trailing prose, or a missing root, rejects. This is what rejects the empty string. |
| 2 | `:276-280` | A second `<output>` open or close tag anywhere inside the root body. |
| 3 | `:457-461` | An invalid chunk, via `validate_chunk_coverage` (`:710-807`). Rejects non-strictly-increasing line ordinals or input ordinals (`:685-701`), lines outside the claimed range (`:760-768`), and a line set that does not equal the present ordinals filtered to the claimed range (`:776-804`). This validates OUR input, not the model's. |
| 4 | `:463-467` | Already-persisted ranges that are inverted or overlapping, via `validate_stored_compartments` (`:647-676`). Also our own state. |
| 5 | `:469-475` | A chunk whose `start_index` is not strictly newer than the last stored `end_message`. |
| 6 | `:476-483` | A chunk whose `start_index` is not exactly the next present ordinal after the last stored `end_message`. |
| 7 | `:487-491` | Zero usable compartments after parsing: "Historian returned no usable compartments." |
| 8 | `:506-512` -> `:949-957` | A compartment whose `start` or `end` ordinal is not present as a chunk line. |
| 9 | `:958-963` | A compartment whose end line is not `anchorable` or whose `message_id` is empty, so publication cannot mint an unanchorable coverage boundary. |
| 10 | `:514-524` -> `:1000-1008` | A compartment whose `p1` is absent, or present but whitespace-only. |
| 11 | `:1009-1014` | `end_message < start_message`. |
| 12 | `:1015-1020` | A range with any endpoint outside `chunk_start..=chunk_end`. |
| 13 | `:1021-1026` | A `start_message` that is not a present ordinal inside the chunk. |
| 14 | `:1027-1032` | An `end_message` that is not a present ordinal inside the chunk. |
| 15 | `:1033-1038` | A compartment that starts after chunk coverage has already been consumed. |
| 16 | `:1039-1045` | Overlap: `start_message` below the expected next uncovered ordinal. |
| 17 | `:1046-1049` | Gap: `start_message` above the expected next uncovered ordinal. This is the check that makes a narrative gap fatal after healing has absorbed only tool-only gaps. |
| 18 | `:1054-1060` | A declared `<unprocessed_from>` that is not the next uncovered present ordinal. |
| 19 | `:1063-1074` | A declared `<unprocessed_from>` on a fully covered chunk that is neither `chunk_end + 1` (`:1063`) nor inside the chunk (`:1066-1070`), and the residual mismatch arm (`:1071-1074`). |
| 20 | `:1077-1081` | Uncovered messages remaining with no `<unprocessed_from>` at all. |
| 21 | `:525-534` | A terminal boundary that splits a completed tool invocation/result arc, via `boundary_splits_completed_tool_arc` (`:859-862`) over `completed_tool_arc_crosses_boundary` (`boundary.rs:1204-1210`). |
| 22 | `:565-570` | No forward progress: the last surviving compartment does not end at or beyond the first ordinal after the prior stored end. |

**22 rejecting checks.** One further reject fires before the gate is entered:
`historian.rs:1666-1671` refuses an output the producer marked `length_capped`,
so a truncated document never reaches `parse_compartment_output`.

### Silent drops (parse-time, not rejects)

| Line | What is discarded, keeping the rest |
| --- | --- |
| `:289-296` | A `<compartment>` with a non-numeric or absent `start=` or `end=`. |
| `:297-303` | A `<compartment>` with an absent or empty `title=`. |
| `:309`, `:333-347` | A `<compartment>` with neither a non-empty tier body nor non-empty flat content. |
| `:364-366` | A fact category block whose open and close element names differ. |
| `:372` | A fact bullet whose content is empty after unescaping. |
| `:391`, `:410`, `:425` | An empty user observation, primer element, or primer bullet. |
| `:837-839`, `:844` | An event field whose open/close names differ, or whose value is empty. |
| `:828-830` | A whole event whose literal close tag is never found. |

These drops are mostly benign because checks 16 to 20 turn a dropped compartment
into a coverage gap or an `<unprocessed_from>` mismatch, which then rejects. The
exception is the side-channel drops, which have no coverage cross-check at all.

### Admission wideners

Not checks, but they change what check 17 and check 22 see:

- `heal_compartment_gaps` (`:899-932`) extends the previous compartment's
  `end_message` across a gap when every omitted present ordinal falls inside a
  `tool_only_ranges` entry (`:926-930`).
- `heal_terminal_completed_tool_arc` (`:864-897`) extends the last
  compartment's `end_message` forward to close a completed arc and rewrites
  `unprocessed_from` (`:891-896`).
- Discard-last (`:539-558`) pops the final compartment when lookahead distance
  is at most `BOUNDARY_HEALING_SLACK = 2` (`:19`), gated on `compartments.len()
  >= 2`.

## What the gate does not check

This is the valuable list. Each item was confirmed by reading the whole
production body `:1-1304`, not by absence from one function, and by reading the
publish projection `historian.rs:38-67` and the render consumer
`decay_render.rs:80-147` to see whether anything downstream compensates.

1. **No lower bound on body size, and no relation between body size and covered
   span.** The only content requirements are a non-empty `title` (`:298-303`,
   a drop) and a non-blank `p1` (`:1000-1008`, a reject). A single-character
   `p1` covering 500 ordinals is admitted.
2. **No cross-compartment content distinctness.** Nothing compares one
   compartment's `title`/`p1`..`p4` with another's. Ranges must be contiguous
   and disjoint; bodies may be byte-identical.
3. **No binding of the output text to the chunk's identity.** The output is tied
   to the chunk only by small integer ordinals that must exist as chunk lines
   (`:941-957`). There is no nonce, no required echo, no digest of the chunk in
   the output. `rg -ni "nonce|echo_back|session_marker"` over
   `historian_prompt.rs` and `historian_validate.rs` returns nothing. The chunk
   fingerprint at `historian.rs:1449-1461` binds the chunk to the firing, not
   the model's text to the chunk.
4. **No token or byte cap on the accepted document.** The producer-side
   `length_capped` flag (`historian.rs:1666`) refuses a *truncated* document;
   there is no check that an untruncated document is not absurdly large.
5. **No range check on `importance`.** Parsed as bare `\d+` into `u64`
   (`:1195`, `:306`), then narrowed by a truncating `as i32` at
   `historian.rs:57`.
6. **No control-character or markup sanitation.** `unescape_xml` (`:1148-1154`)
   only decodes five entities; it never rejects or strips. Nothing in the gate
   looks at `char::is_control`, `\u{2028}`, or ANSI escapes.
7. **No `episode_type` allowlist.** Any attribute string is accepted verbatim
   (`:305`) and stored (`historian.rs:58`).
8. **No check that side-channel anchors are in range, only a silent filter.**
   `keep_side_channel` (`:1086-1098`) returns `false` for an out-of-range
   anchor, and the call sites (`:576-583`, `:592-598`, `:603-610`, `:616-623`)
   filter rather than reject.
9. **No cap disclosure on primer candidates.** `.take(1)` at `:611` silently
   keeps one and discards the rest, with no comment and no telemetry.
10. **No lookahead protection for a single-compartment output.** Discard-last
    requires `compartments.len() >= 2` at `:539`.
11. **No re-validation of content after a heal mutates a range.** Both heal
    functions change `end_message`, and `map_parsed_compartments_to_chunk`
    (`:934-981`) then stamps a new `end_message_id`, without touching
    `title`/`content`/`p1`..`p4`.
12. **No idempotent entity round-trip.** `unescape_xml` replaces `&amp;` first
    (`:1149`), so it double-decodes.
13. **No check on facts, events, primers, or observations content at all**
    beyond non-emptiness. No category semantics, no length, no chunk relevance.
14. **`u64` arithmetic on `sequence`.** `sequence_offset + index as u64` at
    `:965` is a plain add, unlike the `saturating_add` used everywhere else in
    the file.
15. **The state machine looks at nothing.** `output_received`
    (`historian.rs:299-307`) takes the text as `_output_text` and discards it.
16. **`ValidatedChunk` is not a proof-carrying token.** All fields are `pub`
    and it derives `Default` (`:226-238`), and `publish_validated_chunk` is
    `pub` in a `pub mod` (`historian.rs:444`, `lib.rs:19`), so the type system
    does not make validation mandatory.

The three most consequential, in order: item 3 (nothing binds the model's words
to this conversation), item 1 (nothing bounds how little the words may say), and
item 16 (nothing structural enforces that the gate ran).

## Observations

Failure mode, established by reading the production caller end to end.

- `historian.rs:1673-1678` is the only production call of
  `validate_historian_output`. Confirmed by `rg`: every other call is inside
  `#[cfg(test)]` (`historian_validate.rs:1402` etc.,
  `historian_chunk.rs:1419`).
- `historian.rs:1663-1664` moves durable state to `Validating` and persists it
  BEFORE validating. `historian.rs:1680-1704` handles the rejection: it
  computes a backoff (`:1683-1687`), persists
  `abandon_with_detail(..., Some(format!("validate rejected: {err}{cap_hint}")))`
  (`:1693-1701`), and returns `HistorianDriveError::Validation(err)`.
- **Rejection is fail-closed on the compartment path.** No arm of
  `publish_output_from_awaiting` reaches `publish_validated_chunk`
  (`:1714`) without a successful `validate_historian_output`. There is no
  best-effort, partial-accept, or force branch. The original conversation is
  preserved because nothing is written to the compartment table.
- **The gate is not, however, side-effect free for the caller.** Two durable
  `persist_historian_state` writes happen around a rejection: the `Validating`
  transition at `:1664` and the abandon at `:1693`. The module doc's claim that
  decisions are resolved "before any database write is possible" (`:1-9`) is
  true of the *compartment* write and false of the *phase* write. See
  contract-vs-code lead 1.
- **Rejection is observable, but weakly.** The reason lands in
  `HistorianDurableState.last_failure` and surfaces through
  `historian_status_summary` (`lib.rs:15464-15478`) and `HistorianDiagnostics`
  (`lib.rs:5313`). Two dulling effects: `last_no_fire` is checked first
  (`lib.rs:15468-15470`), so once a later pass records the `backoff` no-fire
  reason (`lib.rs:5048`, `record_no_fire` at `lib.rs:5323-5336`) the one-line
  summary reads `no fire: backoff` and the validation reason disappears from
  it; and the machine-readable status block exposes only
  `consecutive_publish_failures` and `publish_health_degraded`
  (`lib.rs:6358-6360`).
- **A validation rejection does not count as a publish failure.**
  `abandon_with_detail` copies `consecutive_publish_failures` forward unchanged
  (`historian.rs:358`). The only increments are in `mc-store`
  (`mc-store/src/lib.rs:9264-9268` under a `count_publish_failure` flag, and
  `:9323-9326`), neither of which the module-side validation-rejection path
  reaches. So `publish_health_degraded` at `lib.rs:6360` stays false through
  unlimited validation rejections.
- **Retry within one firing is bounded by the model chain.**
  `historian.rs:1440-1450` treats `HistorianDriveError::Validation` as
  "model-local output failure" and continues to the next eligible model
  (`has_eligible_model`) before returning the rejection.
- **Retry across firings is bounded only by time.** The sole gate is
  `failure_backoff_at_ms` (`lib.rs:5042-5047`), which records the no-fire
  reason `backoff` and declines. `HISTORIAN_FAILURE_BACKOFF_MS` is 60_000
  (`historian.rs:30`) and the completion-time backoff preserves the configured
  cooldown (`historian.rs:1145-1154`) rather than escalating it. There is no
  attempt counter, no cap, and no escalation, so a persistently
  invalid-output model retries every 60 seconds indefinitely with no health
  signal.
- The raw material is retained. `publish_validated_chunk` stores
  `chunk_transcript` and `raw_chunk_messages` (`historian.rs:1726-1727`,
  documented at `:435-436` as "Original CK messages for exact durable
  full-message and verbose recovery"). So a degenerate accepted summary
  degrades the **served** context; it does not by itself destroy the durable
  raw record. Every impact statement below is scoped accordingly.
- Downstream sanitation exists but is asymmetric and lives in the renderer, not
  the gate. `decay_render.rs:104-121` strips control characters and
  `\u{2028}`/`\u{2029}` from titles and XML-escapes them;
  `decay_render.rs:138-147` guards only a body's `\n## ` markdown-heading
  sequence; bodies are XML-escaped (`:235`, `:245`) but never control-stripped.
- Feeding prior compartments back into the next run's prompt IS escaped
  (`historian_prompt.rs:218-265`), and the transcript carries an explicit
  injection guard string (`historian_prompt.rs:21`). So the prompt feedback loop
  is defended; the gate still stores unsanitized bytes.
- `keep_side_channel` has a dead arm. `:1091-1093` returns early when
  `discarded_last` is true, so the `None => !discarded_last` at `:1096` can only
  ever evaluate to `true`.
- `map_parsed_compartments_to_chunk` (`:506`) runs BEFORE
  `validate_parsed_compartments` (`:514`), so endpoint mapping and sequence
  assignment happen on a list that has not yet passed the contiguity, tier, or
  `unprocessed_from` checks. Both must pass before publish, so this is ordering
  noise today rather than a hole, but it means the `Err` at `:949-957` reports a
  mapping failure for input that a later check would have described better.

## Candidate properties

### hv-output-not-bound-to-chunk-identity

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test supplies a well-formed output whose ranges fit the chunk but whose prose describes different material.
Guarantee: A published compartment set is bound to the specific chunk it summarizes by something the model must have read, not only by integer ordinals that any output covering the same span satisfies.
Check: `always` — for every accepted `ValidatedChunk`, at least one accepted field carries a value derivable only from the pinned chunk's content (a nonce echo, a chunk digest, or a quoted anchor). Semantics are `always` because admission is evaluated on every publish and the binding must hold on each one.
Fault/timing angle: A producer session reused across two chunks, or a provider-side cache hit, returns text for the previous chunk while the current chunk's fingerprint still matches the firing.
Required faults and enabling state: A configured historian model chain; a producer that returns a document whose compartment ranges are contiguous over `chunk.start_index..=chunk.end_index` and whose `<unprocessed_from>` is `chunk_end + 1`, with bodies describing unrelated content.
Confidence: high — [evidence](../evidence/hv-output-not-bound-to-chunk-identity.md). Read every check in `:450-641` and `:983-1084`; the only chunk-derived facts consulted are `start_index`, `end_index`, `lines[].ordinal`, `lines[].message_id`, `lines[].anchorable`, `present_ordinals`, `tool_only_ranges`, `completed_tool_arcs`. Grepped for a nonce or echo requirement and found none.
Existing check: none. The chunk fingerprint at `historian.rs:1449-1461` and `:444-455` binds chunk to firing, not text to chunk.
Impact: The served conversation prefix is replaced by a summary of something else. The raw record survives in `raw_chunk_messages`, so this is a wrong-context failure rather than data destruction, but every later pass reads the wrong m0.
Open questions:
- Is a chunk-derived echo requirement compatible with the byte-identical TypeScript oracle the golden test pins (`historian_validate.rs:1384`)? (needs human input)

### hv-degenerate-body-passes-content-gate

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — the 19 inline tests all use bodies generated from the compartment title (`:1367-1375`), never a degenerate one.
Guarantee: The publish path can be reached with a compartment body that carries essentially no information about the ordinals it replaces.
Check: `reachable` — the `to_stored_compartment` call at `historian.rs:1738` (via `publish_validated_chunk`, `historian.rs:471-475`) is reached with `p1.trim().chars().count() == 1` and `end_message - start_message` at least 100. Semantics are `reachable` because the finding is that this code location is attainable, not that a forbidden state is entered.
Fault/timing angle: None. No interleaving needed.
Required faults and enabling state: A configured historian model chain and a producer returning one well-formed compartment with a one-character `p1`, a non-empty `title`, and a matching `<unprocessed_from>`.
Confidence: high — [evidence](../evidence/hv-degenerate-body-passes-content-gate.md). Traced every content-touching line: `:298-303` (title non-empty, a drop), `:309-331` (tier presence), `:1000-1008` (p1 non-blank). No length, ratio, or span-relative check exists in `:1-1304`.
Existing check: `:1000-1008` rejects a blank `p1`, which is the strongest content requirement in the module.
Impact: A long stretch of real conversation is served as a near-empty summary. Compounded by hv-single-compartment-skips-lookahead-discard, because a one-compartment output also skips the discard-last protection.
Open questions:
- Does the project want a span-relative floor, or is body adequacy deliberately delegated to the historian-eval scorer lane (`ci.yml:415-440`)? (needs human input)

### hv-no-cross-compartment-content-distinctness

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test emits two compartments with identical bodies.
Guarantee: Two compartments published in one run that cover disjoint ordinal ranges do not carry byte-identical bodies.
Check: `always` — for every accepted `ValidatedChunk`, no two elements of `compartments` share the same `(title, p1, p2, p3, p4)` tuple. `always` because it is a property of each admitted set, evaluated at every publish.
Fault/timing angle: None.
Required faults and enabling state: A producer returning N contiguous compartments whose ranges partition the chunk and whose bodies are copies of one another.
Confidence: high — [evidence](../evidence/hv-no-cross-compartment-content-distinctness.md). `validate_parsed_compartments` (`:983-1084`) iterates compartments and compares only `p1` presence and ordinals; no cross-element content comparison exists anywhere in `:1-1304`.
Existing check: none.
Impact: The rendered m0 shows the same paraphrase repeated for each distinct topic, so the agent sees one topic where the user had N. Ordinal coverage is still correct, so nothing later detects it.
Open questions: None.

### hv-importance-unbounded-then-truncating-cast

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — every fixture uses `importance="50"` or `"60"`.
Guarantee: A published compartment's stored `importance` lies in the documented 1..=100 band that the decay curve consumes, or the output is rejected.
Check: `always` — for every `StoredCompartment` produced by `to_stored_compartment`, `1 <= importance <= 100`. `always` because the invariant must hold for every published row.
Fault/timing angle: None.
Required faults and enabling state: A producer emitting `importance="4294967296"` or any value above `i32::MAX` on an otherwise valid compartment.
Confidence: high — [evidence](../evidence/hv-importance-unbounded-then-truncating-cast.md). Parsed as unbounded `\d+` at `:1195`, captured to `u64` at `:306` via `capture_u64` (`:1106-1110`), narrowed by `as i32` at `historian.rs:57`. Confirmed no clamp in `mc-store` (schema default only, `mc-store/src/lib.rs:455`; insert at `:12288` casts back to `i64`). The only clamp is at render, `decay_render.rs:269-272`.
Existing check: `decay_render.rs:271` `.clamp(1, 100)` at render time, which converts a wrapped negative into the LOWEST importance rather than rejecting it.
Impact: A compartment the model marked maximally important is stored with a wrapped value and rendered as least important, so it decays to the densest tier first. Silent, and the stored row is wrong for any consumer that does not clamp.
Open questions:
- Are there stored-compartment consumers besides `decay_render.rs` that read `importance` without clamping? Unresolved, needs a sweep of `mc-store` readers in a Part 3 or 4d pass.

### hv-control-characters-reach-durable-rows

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no fixture contains a control character.
Guarantee: Model-authored text admitted by the gate cannot carry control characters or line/paragraph separators into durable compartment rows.
Check: `always` — for every accepted compartment, no character of `title`, `content`, or `p1`..`p4` satisfies `char::is_control()` or is `\u{2028}`/`\u{2029}`. `always` because it must hold for each admitted compartment.
Fault/timing angle: None.
Required faults and enabling state: A producer emitting a compartment whose `p1` body or `title` attribute contains `\u{2028}`, `\r`, or an ANSI escape introducer.
Confidence: high — [evidence](../evidence/hv-control-characters-reach-durable-rows.md). Read all of `:1-1304`: the only text transform is `unescape_xml` (`:1148-1154`), which decodes five entities and strips nothing. Confirmed the compensating control exists downstream and is asymmetric: `decay_render.rs:104-121` strips controls from TITLES only; `decay_render.rs:138-147` guards only `\n## ` in bodies.
Existing check: `decay_render.rs:104-121` for titles at render time, marked in its own comment as "Historian-authored titles are untrusted". Bodies have no equivalent.
Impact: Durable rows hold unsanitized bytes. Any consumer that does not replicate `decay_render`'s title handling renders them raw. The m0 path is defended for titles and XML-escaped for bodies, so the exposure is to other readers of the same rows.
Open questions:
- Should the gate be the sanitation point, or is renderer-side sanitation the deliberate design? The title comment suggests the latter was chosen consciously. (needs human input)

### hv-unescape-xml-double-decodes-entities

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `historian_prompt.rs:430-431` tests the escape direction only; nothing tests the round trip.
Guarantee: Text that survives the gate is the text the model wrote: applying `unescape_xml` to correctly escaped input reproduces the original exactly.
Check: `always` — for all `s`, `unescape_xml(escape_xml_content(s)) == s`. `always` because the gate applies `unescape_xml` on every admitted field.
Fault/timing angle: None.
Required faults and enabling state: A model body containing the literal five-character sequence `&lt;` as prose, which the producer correctly escapes to `&amp;lt;`.
Confidence: high — [evidence](../evidence/hv-unescape-xml-double-decodes-entities.md). `unescape_xml` (`:1148-1154`) replaces `&amp;` -> `&` FIRST, then `&lt;` -> `<`, so `&amp;lt;` becomes `&lt;` becomes `<`. The counterpart `escape_xml_content` (`decay_render.rs:80-84`, `historian_prompt.rs:104-108`) escapes `&` first and is therefore correct; only the inverse is wrong.
Existing check: `historian_prompt.rs:427-432` asserts the escape functions, never the inverse.
Impact: Model text that legitimately discusses entity syntax is corrupted, and specifically GAINS raw `<`/`>` that were not markup in the source. The m0 renderer re-escapes, so the damage is stored-text corruption rather than markup injection.
Open questions:
- Does the TypeScript host parser have the same ordering, making this a faithful port of an upstream defect rather than a divergence? Unresolved, needs the TypeScript parser source.

### hv-single-compartment-skips-lookahead-discard

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `discard_last_progress_guard_boundary_k1_vs_k2` (`:1633`) covers the k1/k2 lookahead boundary with two compartments; no test covers the one-compartment case.
Guarantee: A compartment whose terminal boundary was chosen with less than `BOUNDARY_HEALING_SLACK` ordinals of lookahead is withheld for re-derivation, regardless of how many compartments the run produced.
Check: `always` — whenever `chunk.end_index - last.end_message <= BOUNDARY_HEALING_SLACK`, `in_emergency` is false, and `force_keep_last_compartment` is false, the accepted set does not contain that last compartment. `always` because the protection is claimed on every non-emergency publish.
Fault/timing angle: The window is a chunk whose narrative ends within two ordinals of the chunk end, so the final boundary is guessed without real lookahead.
Required faults and enabling state: A chunk whose content yields a single compartment ending at or within two ordinals of `chunk.end_index`, with `in_emergency` and `force_keep_last_compartment` both false.
Confidence: high — [evidence](../evidence/hv-single-compartment-skips-lookahead-discard.md). The guard at `:539` requires `compartments.len() >= 2`; with one compartment the whole block `:539-558` is skipped and `discarded_last` stays false. `BOUNDARY_HEALING_SLACK = 2` at `:19`, applied at `:554`.
Existing check: `:539-558` for two or more compartments; tests at `:1633`, `:1730`, `:1748`, `:1849`.
Impact: The weakest-lookahead boundary in the system is published unprotected in exactly the case where the model had the least evidence. A wrong boundary freezes into durable coverage.
Open questions:
- Is the `>= 2` guard intentional (popping the only compartment would fail the `:565-570` forward-progress check and reject the run) or accidental? The interaction suggests intentional; no comment says so. (needs human input)

### hv-side-channel-anchor-out-of-range-drops-silently

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `zero_side_channel_anchor_is_suppressed` (`:1774`) and `events beyond persisted compartment count are filtered` (golden case) cover the filtering; nothing asserts the drop is reported.
Guarantee: A side-channel item whose declared anchor does not name a persisted compartment is either rejected with the run or reported, never silently discarded.
Check: `always` — for every input side-channel item with `origin_compartment_index` or `at_compartment` outside `1..=persisted_count`, the run either returns `Err` or records a counted drop. `always` because it must hold for each admitted output.
Fault/timing angle: None.
Required faults and enabling state: A producer emitting a fact, event, or primer anchored to a compartment index above the count that survives discard-last.
Confidence: high — [evidence](../evidence/hv-side-channel-anchor-out-of-range-drops-silently.md). `keep_side_channel` (`:1086-1098`) returns `false`; the four call sites (`:576-583`, `:592-598`, `:603-610`, `:616-623`) use `.filter`, so the item vanishes. `.take(1)` at `:611` additionally discards all but the first surviving primer with no comment. Confirmed no counter or log on any of these paths.
Existing check: `:1094-1097` bounds the anchor. Its disposition is a filter, not a reject or a metric.
Impact: Extracted facts the model did produce are lost with no signal, so a degrading extraction looks identical to a model that extracted nothing. `user_observations` are additionally gated off by default (`config.rs:127`), so the practical exposure is facts, events, and primers.
Open questions:
- Should `.take(1)` on primers be a documented cap or a reject when more than one survives? (needs human input)

### hv-validation-rejection-retry-has-no-attempt-bound

Type: liveness
Reachability: default-production
Status: active
Exercised: not yet — no test drives repeated validation rejections across firings.
Guarantee: After the fault-free window opens, a session whose producer keeps returning invalid output stops re-firing within a bounded number of attempts, or reports degraded publish health.
Check: `always` — poll for a bounded window of `N` firing opportunities after the last configuration change; after `N` consecutive validation rejections, either `historian.failure_backoff_at_ms` has escalated beyond `HISTORIAN_FAILURE_BACKOFF_MS` or `publish_health_degraded` is true. Stated in attempts, not in an unbounded "eventually", per the liveness rules.
Fault/timing angle: The window is the 60-second backoff at `historian.rs:30`, re-evaluated at `lib.rs:5042-5047`. Each expiry admits one more firing, each costing a full model chain of live calls.
Required faults and enabling state: A configured model chain; a producer that returns a well-formed document the gate rejects on every attempt, for every model in the chain.
Confidence: high — [evidence](../evidence/hv-validation-rejection-retry-has-no-attempt-bound.md). Traced the whole rejection path: `historian.rs:1680-1703` abandons with a backoff; `abandon_with_detail` (`:352-361`) copies `consecutive_publish_failures` unchanged; the only increments are in `mc-store/src/lib.rs:9264-9268` and `:9323-9326`, which this path does not reach; `completion_failure_backoff_at_ms` (`historian.rs:1145-1154`) preserves rather than escalates the cooldown; the intra-firing fallback at `historian.rs:1440-1450` bounds attempts per firing only.
Existing check: `lib.rs:5042-5047` enforces the 60-second cooldown, and `lib.rs:6258-6261` reports degradation from a counter this path never increments.
Impact: Unbounded live model spend and log noise, and a session that never compacts while its status block reports healthy publishing. Distinct from a bad publish: no data is corrupted.
Open questions:
- Should a validation rejection increment `consecutive_publish_failures`, or does that counter deliberately mean "store-side publish failure only"? The name suggests the latter but the health signal is the only one users see. (needs human input)

### hv-tierless-stored-row-arm-must-stay-unreachable

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tierless_compartments_reject_while_p1_only_output_keeps_soft_fallbacks` (`:1463`) proves the gate rejects tierless output; nothing asserts the `legacy: 1` arm is never taken.
Guarantee: The legacy-row arm of the publish projection never executes, because validation rejects every tierless compartment before publish.
Check: `unreachable` — the `1` arm of the `legacy` expression at `historian.rs:65` must never be evaluated during a publish. Semantics are `unreachable` because this is a specific code location the code's own comment says cannot be reached, not a state without a detection point.
Fault/timing angle: None.
Required faults and enabling state: Reached only if a caller constructs a `ValidatedChunk` without the gate, which is why this record and hv-publish-accepts-unvalidated-validated-chunk are paired.
Confidence: high — [evidence](../evidence/hv-tierless-stored-row-arm-must-stay-unreachable.md). `historian.rs:60-62` states the claim: "Strict validation makes tierless output unreachable, but derive legacy from P1 so a future bypass cannot falsely mark a flat row as v2." Verified the gate's side: `:1000-1008` rejects an absent or blank `p1`, and `ValidatedCompartment.p1` is a clone of the parsed value (`:972`), so the projection sees the validated field.
Existing check: `historian.rs:63-67` is itself the defensive derivation; `:1463` covers the gate side.
Impact: If the arm ever fires, a flat row is written and `decay_render.rs:154-156` renders it through the legacy tier path with `truncate_with_ellipsis` bounds (`:185-192`), so the failure is silent tier degradation rather than a crash.
Open questions: None.

### hv-publish-accepts-unvalidated-validated-chunk

Type: safety
Reachability: default-production
Status: active
Exercised: partial — four tests call `publish_validated_chunk` directly with hand-built input (`historian.rs:4173`, `:4328`, `:4414`, `:4495`), demonstrating the bypass is trivially constructible, but no test asserts the production invariant.
Guarantee: Every set of compartments that reaches the durable publish transaction was produced by `validate_historian_output` from the same output text and the same pinned chunk.
Check: `always` — every execution of `publish_validated_chunk` (`historian.rs:444`) is preceded in the same call chain by a successful `validate_historian_output` over the text that produced its `validated` argument. `always` because the obligation applies to each publish; the forbidden state has no single detection point, so per the coverage rules this is `always(...)`, not `unreachable`.
Fault/timing angle: None. This is a structural, not a timing, property.
Required faults and enabling state: None in the current tree; the record documents that the type system does not enforce the invariant. A second call site added later is the enabling change.
Confidence: high — [evidence](../evidence/hv-publish-accepts-unvalidated-validated-chunk.md). `ValidatedChunk` at `:226-238` has all-`pub` fields and derives `Default`; `historian.rs:444` is `pub fn` inside `pub mod historian` (`lib.rs:19`), and `historian_validate` is also `pub` (`lib.rs:23`). Confirmed by `rg` that the only production constructions of a `ValidatedChunk` are `historian_validate.rs:628` (the gate's own return) and test code at `historian.rs:4476`.
Existing check: convention only. Both production paths (`historian.rs:1419`, `:1592`) funnel through `publish_output_from_awaiting`, which validates at `:1673`.
Impact: A future publish route, or an external crate depending on `mc-module`, can write model text into durable compartments with zero validation. This is the mechanism that would make hv-tierless-stored-row-arm-must-stay-unreachable fire.
Open questions:
- Should `ValidatedChunk` carry a private field so only the gate can construct it? That is an API change with a `pub` surface cost. (needs human input)

### hv-heal-extends-range-without-revalidating-content

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `twenty_message_tool_only_gap_heals_like_typescript_validator` (`:1443`) and `terminal_unprocessed_boundary_closes_a_completed_arc_forward` (`:1683`) cover the range mutation; neither asserts anything about the body relative to the widened range.
Guarantee: When healing widens a compartment's ordinal range, the widened range still contains only ordinals whose content the compartment's body is entitled to claim.
Check: `always` — for every accepted compartment whose `end_message` differs from the parsed value, every newly covered present ordinal lies inside `chunk.tool_only_ranges` or inside a `chunk.completed_tool_arcs` entry that the terminal heal closed. `always` because it must hold for each healed compartment in each publish.
Fault/timing angle: The window is between parse and mapping: `heal_compartment_gaps` (`:493-497`) and `heal_terminal_completed_tool_arc` (`:498-504`) mutate ranges at `:493-504`, before mapping at `:506` and before validation at `:514`.
Required faults and enabling state: A chunk with `tool_only_ranges` or `completed_tool_arcs` populated by `historian_chunk.rs`, and a model output that leaves a gap inside one of them.
Confidence: high — [evidence](../evidence/hv-heal-extends-range-without-revalidating-content.md). `heal_compartment_gaps` sets `compartments[i - 1].end_message` at `:927-930` and touches no content field; `heal_terminal_completed_tool_arc` sets `last.end_message` at `:889` and rewrites `unprocessed_from` at `:891-896`. `map_parsed_compartments_to_chunk` then stamps a NEW `end_message_id` from the healed ordinal (`:945-948`, `:969`), so the durable boundary identity changes too. The healed end is still checked for anchorability at `:958-963`, and a non-tool-only gap still rejects at `:1046-1049`.
Existing check: `:918-926` restricts gap healing to fully tool-only gaps; `:880` restricts arc healing to arcs ending at or before `chunk_end`; `:958-963` requires the healed end to be anchorable.
Impact: The stored compartment asserts coverage of raw messages its summary never described, and its `end_message_id` names a block the model never saw as its boundary. The module's own comment at `:923-925` accepts this for tool-only noise; the record exists so the premise ("Production replay showed contiguous narrative coverage") is a claim under test rather than a settled fact.
Open questions:
- Are `tool_only_ranges` and `completed_tool_arcs` themselves derived only from module-side classification, with no model influence? `historian_chunk.rs` builds them, so they appear trustworthy, but the derivation was not audited in this pass. Unresolved, needs the chunk-construction lens.

## Gate coverage

The scope map's claim is verified with one line-number correction.

- **19 tests, count confirmed.** `grep -c "#\[test\]"` over
  `historian_validate.rs` restricted to lines after the test-module opener at
  `:1305` returns exactly 19. All are synchronous `#[test]`; there are no
  `#[tokio::test]` in this file. They begin at `:1384` and end at `:1849`.
- **CI status confirmed: none of them run.** The only `mc-module` test
  invocation in `.github/workflows/` is
  `cargo test -p mc-module --test lifecycle_cli` at `ci.yml:172`. There is no
  `cargo test -p mc-module --lib`, no `cargo nextest run -p mc-module`, and no
  workspace-wide test job. `--test lifecycle_cli` selects only the integration
  binary `crates/mc-module/tests/lifecycle_cli.rs`, so inline `src/` unit tests
  are not built by it. The four other workflows were checked:
  `shm-hardening-optin.yml`, `retrieval-benchmark.yml`,
  `claude-code-review.yml`, and `historian-eval.yml` name no Rust `mc-module`
  test target. `historian-eval.yml` is `workflow_dispatch`/`schedule` only and
  runs a Bun harness; its per-PR deterministic counterpart is the
  `historian-eval-contracts` job at `ci.yml:415-440`, which runs
  `bun run test:historian-eval-unit` and two `run-historian-eval.ts` modes.
  Those are TypeScript-side gates, not this module's tests.
- **Line-number drift, recorded per METHOD.md rule 1.** The scope map cites the
  mc-module CI step at `ci.yml:167-168`; in the working tree it is at
  `ci.yml:169` (build) and `ci.yml:172` (test). The substance is unchanged. The
  workflow files are modified in the working tree, so this reference should be
  re-verified once they are committed.

### Checks from the inventory with no test at all

Mapped by reading all 19 test bodies (`:1384-1868`) and the 16 golden cases in
`testdata/validate-golden.json`. "No test" means neither an inline test nor a
golden case exercises the check.

| Check | Covered by |
| --- | --- |
| 1 root envelope | `parser_requires_one_complete_output_root` (`:1653`); golden "malformed xml", "empty output" |
| 2 nested `<output>` | **no test** |
| 3 chunk coverage | `chunk_coverage_rejects_duplicate_and_decreasing_ordinals` (`:1576`); golden "missing trailing line". The out-of-range-line arm (`:760-768`) and the two tail arms (`:792-804`) have **no test** |
| 4 stored ranges | `stored_compartment_validation_is_basis_agnostic_and_allows_sparse_gaps` (`:1531`) |
| 5 chunk not strictly newer | **no test**. Golden "prior live adjacency rejects skipped present raw ordinal" exercises check 6, not check 5 |
| 6 next-present adjacency | golden "prior live adjacency" pair |
| 7 no usable compartments | golden "malformed xml", "empty output" |
| 8 endpoint maps to a line | **no test** |
| 9 end line anchorable | `compartment_end_must_be_anchorable` (`:1665`) |
| 10 `p1` required | `tierless_compartments_reject...` (`:1463`), `mismatched_tier_close...` (`:1483`) |
| 11 inverted range | **no test** |
| 12 range outside chunk | **no test** |
| 13 start not present | **no test** |
| 14 end not present | **no test** |
| 15 starts after coverage ended | **no test** |
| 16 overlap | golden "overlapping ranges reject" |
| 17 gap | `five_message_narrative_gap_rejects_like_typescript_validator` (`:1426`); golden "large narrative gap", "five-message non-tool gap" |
| 18 `unprocessed_from` mismatch | golden "wrong unprocessed_from rejects" |
| 19 `unprocessed_from` arms on a covered chunk | `:1063` covered by most passing cases; the `:1066-1070` and `:1071-1074` arms have **no test** |
| 20 uncovered with no `unprocessed_from` | **no test** |
| 21 terminal splits an arc | `completed_arc_past_chunk_end_rejects_instead_of_publishing_half` (`:1710`) |
| 22 no forward progress | `discard_last_progress_guard_boundary_k1_vs_k2` (`:1633`); golden "discard-last suppressed for k1 progress guard" |

Ten of the 22 rejecting checks have no test at all, and three more have untested
arms. Every one of the 22, tested or not, has zero CI coverage. Per the scope
map's unresolved question about `Exercised` labelling, the records above use
`partial` where a test exists and `not yet` where none does, and this section is
the place a reader learns that "partial" here means "a test exists on a
developer's machine".

## Contract-vs-code leads

1. **"before any database write is possible" versus two durable writes around a
   rejection.** `historian_validate.rs:6-9` states the module keeps
   "persistence code fail-closed: malformed ranges, stale chunks, bad
   message-id endpoints, and boundary-healing decisions are resolved before any
   database write is possible." The production caller persists the `Validating`
   phase at `historian.rs:1664` before validating and persists the abandon at
   `historian.rs:1693-1701` after rejecting. The claim holds for the
   *compartment* write and not for the *phase* write. The phase writes are
   deliberate (the comment at `historian.rs:1709-1713` explains why a pre-check
   must not return early), so the doc sentence is imprecise rather than the code
   being wrong.
2. **"re-emit with all four tiers" versus a p1-only requirement.** The error
   text at `:1004` tells the model to "re-emit with all four tiers", and the
   comment directly above at `:998-999` says the opposite: "P1 is the required
   v2 boundary. Missing P2-P4 deliberately keep the parser's denser-tier
   fallbacks." The code agrees with the comment: `:313-316` backfills `p2` from
   `p1` and `p3` from `p2`-or-`p1`, and `:317` defaults `p4` to empty. So the
   gate accepts a p1-only compartment and then reports a message demanding four
   tiers. `tierless_compartments_reject_while_p1_only_output_keeps_soft_fallbacks`
   (`:1463`) pins the code behaviour, which makes the message the odd one out.
3. **"callers surface them in repair prompts" with no repair prompt.**
   `:240-242` justifies the plain-string error type: "Validation failures are
   plain, serializable messages because callers surface them in repair prompts
   and telemetry." `rg -n "repair"` over `historian_validate.rs`,
   `historian.rs`, `historian_prompt.rs`, and `lib.rs` finds no repair-prompt
   construction; the only other hits are unrelated (`lib.rs:5407`,
   `lib.rs:14177`). The error string does reach telemetry, via `last_failure`.
   The repair-prompt half of the sentence describes something that does not
   exist in this crate.
4. **"Strict validation makes tierless output unreachable" is a claim, not a
   proof.** `historian.rs:60-62`. It is true of the two current call paths and
   is not enforced by any type or assertion; see
   hv-publish-accepts-unvalidated-validated-chunk.
5. **The doc-comment purity claim is accurate.** `:5-7` says the functions are
   "deliberately pure. They receive the raw historian text plus caller-provided
   chunk/store metadata". Verified: `historian_validate.rs` imports only
   `BTreeMap`, `OnceLock`, `regex`, `serde`, and
   `crate::boundary::completed_tool_arc_crosses_boundary` (`:11-17`); there is
   no clock, store, filesystem, or environment access in `:1-1304`. Recorded as
   a claim that survives this pass, so a later pass does not re-derive it.
6. **Scope-map correction.** The scope map's Part 4a rationale says the
   historian publish is "gated solely by in-crate validation" whose "19 tests
   never execute in CI". Both halves verified. Its CI reference `ci.yml:167-168`
   has drifted to `ci.yml:169`/`:172` in the working tree.

## Open questions

- Does the TypeScript host parser share `unescape_xml`'s `&amp;`-first ordering?
  If it does, lead 6's defect is a faithful port and fixing it in Rust breaks
  the golden oracle at `:1384`. Unresolved, needs the TypeScript parser source,
  which is not in the paths this pass read.
- The golden file records TypeScript's error strings for malformed envelopes
  (`"Historian returned no usable compartments."` for the empty input) while
  Rust returns the root-document error, and the test deliberately tolerates the
  divergence at `:1391-1399`. Is that carve-out meant to be permanent, or is it
  a known drift to close? (needs human input)
- Is `historian_chunk.rs`'s derivation of `tool_only_ranges` and
  `completed_tool_arcs` free of model influence? Both are admission wideners,
  so their provenance decides whether the healing paths are attacker-reachable.
  Unresolved, needs the chunk-construction lens.
- Should the gate own content sanitation, or is renderer-side sanitation
  (`decay_render.rs:104-121`) the deliberate architecture? The asymmetry between
  titles and bodies suggests the split was not designed as a whole.
  (needs human input)
- `handle_session_status_value` exposes no validation-rejection signal at all
  (`lib.rs:6358-6360`). Is the intended operator surface the one-line
  `historian_status_summary`, which `last_no_fire` masks
  (`lib.rs:15468-15470`)? (needs human input)
