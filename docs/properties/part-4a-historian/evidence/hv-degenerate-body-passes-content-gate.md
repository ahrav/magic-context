# hv-degenerate-body-passes-content-gate

## Discovery trigger

Task item 4 asks concretely what a maximally unhelpful but well-formed model
output gets past the gate, starting with empty or near-empty output. The empty
string is genuinely rejected, so the interesting question is where the floor
actually sits. Tracing every line that touches compartment text put the floor at
one non-whitespace character.

## Evidence trail

Three content-touching sites exist in the whole module. There are no others in
`crates/mc-module/src/historian_validate.rs:1-1304`.

1. `:297-303` — the title. `capture_string(attr_title_regex(), attrs)` matched
   against `Some(v) if !v.is_empty()`. A title of `"x"` passes. Note this is a
   `continue`, a silent drop of the compartment, not a rejection.
2. `:308-331` — tier presence. `extract_tier(inner, 0)` is filtered by
   `.filter(|s| !s.is_empty())` at `:309`. A `<p1>.</p1>` yields `Some(".")`,
   which is non-empty, so the v2 branch is taken. `:313-316` then backfills `p2`
   from `p1` and `p3` from `p2`-or-`p1`, and `:317` defaults `p4` to empty. So a
   one-character `p1` produces a compartment with `p1 == p2 == p3 == "."`.
3. `:1000-1008` — the only content REJECT in the module:

```rust
match compartment.p1.as_deref() {
    Some(p1) if !p1.trim().is_empty() => {}
    _ => { return Some(format!("compartment {} is missing the tiered ...", index + 1)); }
}
```

`".".trim()` is `"."`, non-empty, so this passes.

What does not exist, confirmed by reading all of `:450-641` and `:983-1084`:

- No comparison of any body's length to `end_message - start_message`.
- No absolute minimum length on `title`, `content`, or any tier.
- No maximum either. The only size defence is the producer-side truncation flag
  `output.length_capped`, refused at `historian.rs:1666-1671`, which detects a
  document cut off mid-stream, not a short one.
- No check that `p1`, `p2`, and `p3` differ, which matters because `:313-316`
  actively makes them identical when the model omits the denser tiers.

The publish projection copies the body through unchanged:
`to_stored_compartment` at `historian.rs:38-67` clones `title`, `content`, and
`p1`..`p4` with no inspection (`:52-56`).

At render, `decay_render.rs:158-179` picks a tier and falls back to a denser one;
`legacy_body_for_tier` (`:195-203`) truncates long bodies but has no floor. So a
one-character body renders as a one-character history block.

## Failure scenario

Chunk 1..=500, a long working session. The producer returns:

```
<output><compartments>
<compartment start="1" end="500" title="Work" episode_type="feature" importance="50"><p1>.</p1></compartment>
</compartments><meta><unprocessed_from>501</unprocessed_from></meta></output>
```

Gate walk: check 1 passes (single root); check 7 passes (one compartment);
check 8 passes if lines 1 and 500 exist; check 9 passes if line 500 is
anchorable; check 10 passes (`"."` is non-blank); checks 16 and 17 pass (the
single compartment starts at the first present ordinal); check 18 falls through
to `:1063` and `501 == 500 + 1` passes; check 22 passes.

Discard-last does NOT fire: `:539` requires `compartments.len() >= 2` and there
is one. So `discarded_last` stays false and the compartment publishes.

Result: 500 raw messages are represented in m0 by the single character `.`.
Coverage advances to 500, so every subsequent transform pass folds those 500
ordinals behind the watermark and serves the `.` in their place.

The raw text is still durable. `publish_validated_chunk` stores
`chunk_transcript` and `raw_chunk_messages` (`historian.rs:1726-1727`), the
latter documented at `:435-436` as "Original CK messages for exact durable
full-message and verbose recovery". So this is a served-context failure, not
irreversible destruction. The agent's working memory of 500 messages is `.`
until someone runs a verbose range expand by hand.

## Timing windows and dependencies

None. This is pure input admission on a single firing, reachable the first time a
session grows large enough to trigger the historian.

Two amplifiers, both verified:

- The single-compartment shape also escapes the lookahead protection
  (`:539`), so the weakest content AND the weakest boundary coincide. See
  `hv-single-compartment-skips-lookahead-discard.md`.
- Because `keep_side_channel` returns `true` for unanchored items when
  `discarded_last` is false (`:1094-1097`), the facts and events from this
  degenerate run are also kept, so the run looks productive in the fact table
  while the compartment says nothing.

## What a test must construct

Direct unit test, no store or runtime needed:

1. Chunk `1..=500` using the shape of the helper at `:1350-1366`, so
   `present_ordinals` is dense and every line is anchorable.
2. The document above.
3. Assert `Ok`, and assert `validated.compartments[0].p1.as_deref() == Some(".")`
   and `validated.discarded_last == false`. That records the reachability finding
   precisely: publish is reached, with a one-character body, and without the
   discard protection.

For the coverage form, the marker asserts the independent preconditions rather
than a quality judgement: a publish occurred, the covered span was at least K
ordinals, and the accepted `p1` length was at most L bytes. Both preconditions
are observable on a correct implementation once a floor exists, because the floor
would reject and the marker then never sees the pair.

## Investigation log

### Q: Does the project want a span-relative floor, or is body adequacy delegated to the historian-eval lane?

- Sources examined: `.github/workflows/ci.yml:402-440` (the
  `historian-eval-contracts` job and its comment block),
  `.github/workflows/historian-eval.yml:1-70` (the live lane's header),
  `historian_validate.rs:1-9` (the module's own statement of what it validates).
- Findings: The module doc lists exactly four concerns: "malformed ranges, stale
  chunks, bad message-id endpoints, and boundary-healing decisions". Body
  adequacy is not among them, which is consistent with a deliberate split. The
  eval lane exists and runs a scorer, and its deterministic parts (contract lint,
  scorer tests, mutation battery) DO run per-PR at `ci.yml:434-440`. So there is
  a structural home for quality judgement outside the gate.
- Missing evidence: whether the eval scorer has a floor on body length or
  information content, and whether a failing score blocks anything. The scorer is
  TypeScript under `packages/e2e-tests/` and was not read in this pass.
- Conclusion: needs human input. The architecture plausibly delegates adequacy to
  the eval lane, but the eval lane is scheduled/dispatch-only for live runs
  (`historian-eval.yml:12-26`), so nothing blocks a degenerate output at publish
  time on a real session.

### Q: Is the raw conversation genuinely recoverable after a degenerate publish?

- Sources examined: `historian.rs:428-437` (the `ValidatedPublishRequest` fields
  and their doc comments), `historian.rs:1726-1727` (the call site),
  `historian.rs:1-6` (the module header's claim that publish writes surface only
  through the m1 watermark).
- Findings: `raw_chunk_messages` is documented as "Original CK messages for exact
  durable full-message and verbose recovery" and is passed on every publish. So
  the raw bytes are stored alongside the summary.
- Missing evidence: whether any retention or trim policy later deletes those rows,
  and whether the verbose expand path can address them for an arbitrary older
  chunk. Those live in `mc-store` and `lib.rs:14519-15055`, outside this lens.
- Conclusion: resolved with answer for this record's purposes — the raw text is
  written durably at publish, so impact is scoped to the served context. The
  retention question is recorded for a store-layer pass rather than assumed.
