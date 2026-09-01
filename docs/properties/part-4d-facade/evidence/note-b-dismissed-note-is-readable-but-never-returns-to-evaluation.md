# note-b-dismissed-note-is-readable-but-never-returns-to-evaluation

## Discovery trigger

My brief asked directly whether a note that should be retained can be dropped, and
whether a dropped note is recoverable. Dismissal is the only user-driven drop in
the facade's vocabulary, so I traced exactly what it destroys, what it retains, and
what can undo it.

## Evidence trail

1. Dismissal is an UPDATE, never a DELETE:

   ```
   UPDATE mc_notes
      SET status = 'dismissed', content = ?1,
          status_version = status_version + 1, state_version = state_version + 1,
          updated_at_ms = ?2,
          dismissed_at = ?2, dismissal_resolution = ?3
    WHERE id = ?4 AND project_path = ?5
      AND status = ?6 AND status_version = ?7
   ```
   (`crates/mc-store/src/lib.rs:4580-4596`, and the non-transaction variant at
   `:10507-10563`)

2. Content is appended, not replaced:

   ```
   let content = resolution
       .map(|value| format!("{}\n\nResolution: {value}", current.content))
       .unwrap_or_else(|| current.content.clone());
   ```
   (`:4575-4577`)

   So the pre-dismissal content is a prefix of the post-dismissal content, and with
   no resolution it is unchanged.

3. Dismissal is gated by status and is idempotent-by-refusal. It returns `Ok(None)`
   unless the current status is one of
   `active | pending | ready | surfacing | surfaced` (`:4565-4571`), so a second
   dismissal of the same note is refused rather than applied twice. The facade turns
   that `None` into an error text (`crates/mc-module/src/lib.rs:11894-11900`).

4. The row is readable afterwards. `ctx_note read` maps
   `filter: "dismissed"` to `vec!["dismissed"]` (`lib.rs:11721`) and
   `filter: "all"` to a six-status list that includes it (`:11722-11729`). The
   default filter does not: `None => vec!["active", "ready"]` (`:11717`), narrowed
   further to `vec!["active"]` for session notes and `vec!["ready"]` for smart notes
   (`:11733-11742`). So a dismissed note is retrievable but only on request.

5. There is no facade path back. `update` loads the note and filters the status to
   `active | pending | ready | surfacing | surfaced`
   (`lib.rs:11806-11813`), which excludes `dismissed`, and returns
   "Note #N not found in your session/project or has no compatible fields to
   update" (`:11815-11818`). The store's `update_note_cas` would refuse anyway,
   because the facade passes `&current.status` as the expected status
   (`:11841`) and the CAS compares it (`mc-store:10428-10437`). The
   `ctx_note` action vocabulary is `write | read | update | dismiss` plus the
   catch-all error arm (`lib.rs:11566`, `:11914`); no un-dismiss action exists.

6. Evaluation can never see it again. The candidate query requires
   `status = 'pending'` (`mc-store:13293`), and `eligible` requires the same
   (`crates/mc-module/src/smart_note_evaluation.rs:705`). Nothing sets
   `status` back to `'pending'` from `'dismissed'`: the only writers of
   `status = 'pending'` are the two inserts (`mc-store:10187`, `:4426`), the
   completion UPDATE which itself requires `status = 'pending'` in its WHERE clause
   (`:13617`), the retired verdict path which also requires it (`:10618`,
   `:10632`), and `NOTE_CAS_UPDATE_SQL` whose WHERE clause pins the expected status
   supplied by a caller that already excluded `dismissed` (`:12871`).

7. An in-flight claim is fenced at dismissal:
   `fence_active_note_claims_tx(self.tx, project_path, Some(note_id), "stale",
   now_ms)` (`:4602`, and `:10558` in the other variant). That marks the claim
   terminal with kind `"stale"` (`:13092-13111`), so a late completion returns
   `Conflict { kind: "stale" }` rather than writing. The completion fence would
   also catch it independently, on all three of its clauses:
   `state_version` was bumped, `status` is no longer `'pending'`, and for a
   resolution-bearing dismissal the content changed
   (`:13569-13573`). So there are two independent guards.

8. Dismissal is a facade mutation and therefore goes through the command ledger
   (`lib.rs:11878-11913` wraps it in `store.with_facade_command`), which is what
   makes a lost response replayable rather than a second dismissal attempt.

## Failure scenario

The retention half is currently sound, so the scenario is a regression in the
fence, which is the half with a real failure mode.

A smart note's condition has fired and it is `status = 'ready'`. The user dismisses
it. Concurrently, an evaluator holds a `due`-phase claim on the same note issued
before it became ready.

With the fence: `dismiss_note` sets `status = 'dismissed'`, bumps
`state_version`, and marks the claim `"stale"` (`mc-store:4583`, `:4602`). The
evaluator's `complete` returns `Conflict { kind: "stale" }` and writes nothing.

Without the fence, and with the completion comparison also relaxed: the evaluator
completes with `due met`. `reduce_due`'s `Met` arm calls `ready_fields`
(`smart_note_evaluation.rs:558-565`), which sets
`state.status = "ready"` unconditionally (`:421`). The dismissed note is
resurrected into `ready`, and `ready` is in the default read filter for smart notes
(`lib.rs:11742`), so it reappears in the model's note list with a fresh
`ready_at` and a `ready_reason` asserting its check returned true. The user's
dismissal is silently undone, and the `dismissed_at` and `dismissal_resolution`
columns are left populated on a note whose status is `ready`, which is an
internally inconsistent row that nothing detects.

The store's reduced-status guard would not catch it either, because `"ready"` is one
of the two permitted values (`mc-store:13594`).

## Timing windows and dependencies

The retention assertions need no window at all: dismiss, then read, then attempt an
update.

The evaluation-exclusion assertion has a window equal to the claim's lifetime,
which for a `due` claim is one sandbox execution and for `compile` or `fallback`
includes a model round trip. The interleaving to construct is a `ctx_note dismiss`
landing between a `note.evaluation.next` and its matching
`note.evaluation.complete`. Both are ordinary API calls; no fault injection is
required.

## What a test must construct

Three assertions, in increasing cost.

1. Retention, no store fixture beyond a note. Write a smart note with a condition,
   `dismiss` it with a resolution string, then `read` with `filter: "dismissed"`.
   Assert the note is returned, and assert the original content is a prefix of the
   returned content. Then `read` with the default filter and assert it is absent, so
   the test pins both halves of the visibility rule.
2. Irreversibility, same fixture. After dismissal, call `update` with new content
   and assert the error text, and call `dismiss` again and assert the
   already-dismissed error text (`lib.rs:11894-11900`). Assert the row's `status` is
   still `dismissed` and its `status_version` advanced exactly once across both
   attempts, which proves the refusals were refusals and not silent no-op writes.
3. Exclusion under a live claim, needs the protocol. Register an evaluator, insert a
   pending smart note, `note.evaluation.next` to obtain a claim, `ctx_note dismiss`,
   then `note.evaluation.complete` with `{"phase":"due","kind":"met"}`. Assert the
   response is `{"result":"stale"}` and that the note's `status` is still
   `dismissed`, `ready_at` is NULL, and `ready_reason` is NULL. The last three are
   the assertions that would catch a resurrection; asserting only the response kind
   would pass even if the write leaked through on a different path.

## Investigation log

### Q: Is the absence of an un-dismiss action deliberate?

- Sources examined: the `ctx_note` action dispatch (`lib.rs:11566-11570` deriving
  the action, `:11605-11915` the match arms, `:11914` the catch-all), the advertised
  schema `ctx_note_schema` (`:15790-15991` region contains the four `ctx_*`
  schemas), the `update` status filter (`:11806-11813`), the store's
  `dismiss_note_cas` (`mc-store:10565`), and
  `docs/specs/prompt-surface/load-bearing-rules-checklist.md:1125`, which describes
  the vocabulary as "write saves, read lists, update changes, and dismiss retires
  notes".
- Findings: the checklist's wording, "dismiss retires notes", is consistent with a
  deliberate one-way retirement. The read path's explicit `dismissed` filter is
  further evidence: someone chose to keep dismissed notes retrievable rather than
  hiding them, which is the shape you build if retirement is meant to be auditable
  but final. Against that, nothing states the intent as a contract, and a user who
  dismisses by mistake must re-author the note, losing its id, its
  `created_at`, and its compiled artifact.
- Missing evidence: whether the TypeScript authority offers an un-dismiss or
  restore action. If it does, the two authorities diverge on the note vocabulary,
  which would matter for the cross-language claim at
  `smart_note_evaluation.rs:1-6`, though that claim is scoped to the evaluation
  fixture and not to the facade vocabulary.
- Conclusion: needs human input on whether one-way is intended. The behaviour is
  confirmed and internally coherent; the checklist's "retires" is suggestive but is
  a description, not a contract.

### Q: Does anything other than dismissal remove a note from evaluation without
deleting it?

- Sources examined: every writer of `mc_notes.status` in `mc-store/src/lib.rs`
  (the two inserts at `:4426`/`:10187`, `NOTE_CAS_UPDATE_SQL` at `:12846`,
  `dismiss_note` at `:4582`, the retired verdict path at `:10623`, and the
  completion UPDATE at `:13617`), plus the two `DELETE FROM mc_notes` sites
  (`:8675`, `:11393`).
- Findings: two more, both legitimate and neither a silent drop. A `met` outcome
  moves a note to `ready` (`smart_note_evaluation.rs:421`), which removes it from
  the candidate set, and that is the success path. A compiler edit moves it back to
  `pending` and clears the check lifecycle
  (`mc-store:12849-12866`), which returns it to evaluation rather than removing it.
  The two DELETEs are session-scoped teardown (`:8675`, keyed on
  `session_id` and `type = 'session'`, so it cannot touch a smart note) and
  store-scoped teardown (`:11393`, keyed on `context_store_uuid`), which Parts 3
  and 4c own.
- Missing evidence: none.
- Conclusion: resolved with answer. Dismissal is the only user-driven removal from
  evaluation, the `ready` transition is the only automatic one, and neither is
  silent. Notably the session-note DELETE at `:8675` is filtered to
  `type = 'session'`, so a recomp cannot drop a smart note, which is worth stating
  because it was the most plausible candidate for an unintended drop.
