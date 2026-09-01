# note-b-completion-applies-only-under-the-claimed-revision-and-state-version

## Discovery trigger

My brief asked whether evaluation can select a note for an action its own
preconditions forbid. The module side asserts only the phase *name*
(`crates/mc-module/src/lib.rs:14197-14202`) and never re-checks the phase's
eligibility predicate, so I traced what else stands between a claim and a write.
The answer is a store-side version fence, which makes this a positive invariant
worth cataloging rather than the defect the question was hunting.

## Evidence trail

1. The module's only precondition check at completion is the phase name:

   ```
   if claim.phase != phase {
       return Err(format!(
           "outcome phase '{phase}' does not match the claimed phase '{}'",
           claim.phase
       ));
   }
   ```
   (`lib.rs:14197-14202`)

   Nothing here re-evaluates `check_status`, `has_compiled_check`,
   `check_quarantined_until`, or `check_next_due_at`, which are the predicates the
   due selector required to issue the claim
   (`crates/mc-module/src/smart_note_evaluation.rs:719-725`).

2. The store supplies the fence, inside the completion transaction:

   ```
   if note.source_revision != row.claim.source_revision
       || note.state_version != row.claim.state_version
       || note.status != "pending"
   {
       return stale(tx);
   }
   ```
   (`crates/mc-store/src/lib.rs:13569-13573`)

   `stale` marks the claim terminal with kind `"stale"` and returns
   `NoteEvalCompleteOutcome::Conflict { kind: "stale" }`
   (`:13552-13561`), so no note write occurs and the claim cannot be retried into
   a write.

3. A second guard rejects any reduced status outside the two legal ones:

   ```
   if !matches!(reduced.status.as_str(), "pending" | "ready") {
   ```
   (`:13594-13606`), which marks the claim `"invalid"`. So even a reducer bug
   cannot drive a note into an arbitrary status through this path.

4. The two mutation paths that can change a note's phase preconditions both bump
   the fenced counters and fence the claim explicitly.
   `NOTE_CAS_UPDATE_SQL` sets `status_version = status_version + 1, state_version
   = state_version + 1` unconditionally and `source_revision = source_revision +
   CASE WHEN ?5 THEN 1 ELSE 0 END` on a compiler edit
   (`mc-store:12846-12847`), and `update_note_cas` then calls
   `fence_active_note_claims_tx(self.tx, project_path, Some(note_id), "stale",
   now_ms)` when `compiler_edit` holds (`:4542-4544`, and the non-transaction
   variant at `:10499-10501`). `dismiss_note` bumps both versions
   (`:12584-12585` region, seen at `:4583`) and fences unconditionally
   (`:4602`, `:10558`).

5. So the phase preconditions are protected transitively: every write that could
   invalidate them also invalidates the fence. That is why the missing direct
   re-check is not a defect, and it is also why the fence is load-bearing far
   beyond note identity.

6. A note can hold at most one live claim, which removes the concurrent-completion
   case. The candidate query excludes notes with a non-terminal claim:

   ```
   AND id NOT IN (SELECT note_id FROM mc_note_eval_claims
                   WHERE project = ?1 AND terminal_kind IS NULL)
   ```
   (`:13294-13295`), and a slot already holding a live claim is rebound to that
   claim rather than issued a new one (`:13268-13288`).

7. The artifact digest is an independent second guard on the compile phase, and it
   is recomputed rather than trusted:

   ```
   let expected = smart_note_check_digest(note.surface_condition.as_deref(), artifact);
   if expected != artifact.check_hash {
       return Err("check_hash does not match the canonical artifact digest".to_string());
   }
   ```
   (`lib.rs:14213-14219`), with the intent stated at `:14189-14191`: "The digest
   for compile outcomes is recomputed from the authoritative note condition rather
   than trusted from the wire." The helper delegates to
   `mc_store::note_check_digest` (`:14176-14186`) so the admission gate and the
   store's repair path cannot disagree about the digest definition.

## Failure scenario

The scenario is what a fence regression would cause, since the fence holds today.

A smart note has `surface_condition = "the CI pipeline is green"` and a compiled
check that greps a status file. The compile phase claims it at
`source_revision = 4`, `state_version = 11`.

1. The evaluator starts a model round trip to compile the condition. This takes
   tens of seconds.
2. The user runs `ctx_note update` with
   `surface_condition = "the release branch is tagged"`.
   `update_note_cas` applies, bumps `state_version` to 12 and `source_revision`
   to 5, NULLs the whole check lifecycle (`mc-store:12849-12866`), sets
   `status = 'pending'`, and fences the claim to `"stale"`.
3. The evaluator completes with an artifact compiled against the *old* condition.

With the fence: `note.state_version` is 12 and `claim.state_version` is 11, so
`complete` returns `Conflict { kind: "stale" }` and writes nothing. The note stays
uncompiled and is recompiled against the new condition on the next compile claim.

Without the fence: the digest guard still catches this particular case, because
`smart_note_check_digest` recomputes over `note.surface_condition`, which is now
the new text, and the wire `check_hash` was computed over the old one
(`lib.rs:14213-14219`). So the compile phase has two guards.

The phase that has *only* the fence is `due`. A note claimed for `due` while
`check_status == "compiled"`, then edited so `check_status` becomes
`'uncompiled'` and its artifact is NULLed, would with no fence receive
`reduce_due`'s `Met` reduction: `ready_fields` with
`due_ready_reason(note_id, pre.manifest_json)` (`smart_note_evaluation.rs:558-565`).
`pre.manifest_json` is now `None`, so `manifest_signal_or_summary` returns `None`
(`:400`) and the reason falls back to "compiled check returned met=true"
(`:371-372`). The note surfaces as ready, with a reason asserting a compiled check
returned true, for a note that has no compiled check and whose trigger text is
different from the one that was evaluated.

## Timing windows and dependencies

The window spans the claim's whole lifetime. That is long by construction: a
compile or fallback claim includes a model round trip, and the lease is renewable
(`lib.rs:11305-11332`), so the window is bounded by the evaluator's own
completion time rather than by a short constant.

The interleaving to construct is a facade mutation landing inside that window.
Both participants are ordinary API calls, so no fault injection is needed. The
two mutations to try are `ctx_note update` with a changed `surface_condition`
(bumps all three fenced values) and `ctx_note update` with changed content only
(bumps `status_version` and `state_version`, and also `source_revision` because
`compiler_edit` includes `content_changed` at `mc-store:4497`), plus
`ctx_note dismiss` (bumps both versions and changes `status` away from
`'pending'`, so all three fence clauses fire).

## What a test must construct

The existing test already builds most of this, so the work is to extend it rather
than start over.

1. `smart_note_revision_matrix_normative_matches_mc_store`
   (`smart_note_evaluation.rs:1189-1526`) opens a real store
   (`:1230-1256`), inserts a note (`:1257-1277`), stages a
   `(source_revision, state_version)` pair (`:1278-1325`), stages an artifact
   (`:1326-1337`), and stages a claim (`:1338-1360`). That is the whole fixture.
2. The extension is a per-phase matrix rather than a per-revision one: for each of
   the four phases, stage a claim, then mutate exactly one of
   `source_revision`, `state_version`, `status`, and assert
   `NoteEvalCompleteOutcome::Conflict { kind: "stale" }` with no change to the
   note's projection columns.
3. The negative case matters as much: with none of the three mutated, assert
   `Applied` and assert the projection columns changed as the reducer specifies.
   Without it the test could pass by always returning `stale`.
4. The interleaved form, which is the one that proves the fence rather than the
   comparison: hold a claim, call `ctx_note update` through the facade, then
   complete. That exercises `fence_active_note_claims_tx` as well as the
   comparison, and those are two independent mechanisms that both have to work.

## Investigation log

### Q: Is the missing direct phase-precondition re-check reachable as a defect?

- Sources examined: `lib.rs:14197-14202` (the only module-side check), the four
  selectors' predicates (`smart_note_evaluation.rs:711-806`), the store fence
  (`mc-store:13569-13573`), all four `fence_active_note_claims_tx` call sites
  (`:4543`, `:4602`, `:10500`, `:10558`), the candidate query's live-claim
  exclusion (`:13294-13295`), and the slot rebind path (`:13268-13288`).
- Findings: not reachable. To change a phase precondition under a live claim, some
  writer must change `check_status`, `has_compiled_check`,
  `check_quarantined_until`, or `check_next_due_at`. Those columns are written by
  exactly two things: `NOTE_CAS_UPDATE_SQL`, which bumps `state_version` and
  fences, and the completion UPDATE itself, which requires a claim and there can
  be only one. `dismiss_note` also changes `status` away from `'pending'`, which
  the fence checks directly.
- Missing evidence: whether any migration, repair, or maintenance path writes the
  check columns without bumping `state_version`. I saw a reference to a "v51
  artifact repair" in the digest helper's comment (`lib.rs:14174-14176`) and did
  not read it. If that repair writes `check_hash` or `compiled_check` without
  bumping `state_version`, it would be a third writer and the analysis above
  would need extending.
- Conclusion: resolved with answer for the two facade paths, unresolved for the
  v51 repair path. Needs a read of the v51 artifact repair in `mc-store`. The
  property is worth cataloging either way, because it is the invariant everything
  else rests on and its regression is silent.

### Q: Does the fence distinguish its three clauses in the response?

- Sources examined: `mc-store:13552-13573`, `lib.rs:11397-11399`.
- Findings: no. All three produce the same `"stale"` kind, and the module
  forwards it as `respond(json!({ "result": kind }))` (`lib.rs:11399`). So a
  client cannot tell a content edit from a dismissal from a status change. That is
  probably fine, because the client's correct response to all three is identical:
  drop the work and poll again.
- Missing evidence: none.
- Conclusion: resolved with answer. Undifferentiated by design, and the
  undifferentiated answer is actionable, so this is not a diagnosability gap of
  the kind recorded in
  `note-b-excluded-note-is-not-reportable-by-any-surface`.
