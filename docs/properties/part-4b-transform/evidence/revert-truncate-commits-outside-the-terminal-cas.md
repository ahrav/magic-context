# revert-truncate-commits-outside-the-terminal-cas

## Discovery trigger

The task asked whether a failed pass leaves partial mutation. Enumerating
`store.` calls in `apply_once` found a second durable write at
`transform.rs:4646`, roughly 900 lines above the commit point, on the
reconcile-rematerialize arm. Everything between the two is rendering that can
fail.

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

The arm is entered only when a HARD fold cannot present its minted anchor and a
reconcile is already pending:

- `transform.rs:4631-4645` — the mint-absent guard: `if let Some(coverage_end) =
  comp.coverage_ordinal { let minted = comp.boundary_id.as_str();
  validate_live_boundary_ordinal(..)?; if minted.is_empty() ||
  !boundary_available(..) {`
- `transform.rs:4642` — `if loaded.core.reconcile_pending {`
- `transform.rs:4643` — `let compartments = store.load_compartments(&req.session_id)?;`
- `transform.rs:4644-4645` — `let keep_through_seq =
  surviving_revert_prefix_seq(&compartments, &live);`
- `transform.rs:4646-4650` — `let outcome =
  store.truncate_compartments_for_revert(&req.session_id, keep_through_seq,
  commit_expected)?;`
- `transform.rs:4651` — `commit_expected = Some(outcome.row_version);`
- `transform.rs:4652` — `meta.revert_epoch = outcome.revert_epoch;`
- `transform.rs:4653` — `meta.last_recut = outcome.last_recut;`

`truncate_compartments_for_revert` (`mc-store/src/lib.rs:9015`) is its own
fenced transaction. It CAS-checks `expected_row_version` (`:9035-9042`), reads
and mutates `meta` (`:9043-9048`, `:9130-9131`), deletes from five tables
(`:9106-9138`), and bumps `row_version` (`:9139-9144`). Its doc comment
(`:9012-9014`) is accurate: "Delete every compartment after `keep_through_seq`
and bump the session revert epoch under the same row-version CAS."

What runs after that commit and before the terminal commit:

- `transform.rs:4654-4664` — `revision_signal_for_context`, a store read that
  returns `Result` and so can `?` out
- `transform.rs:4666` — `store.load_compartments`, another `?`
- `transform.rs:4668` — `coverage_bounds_from_compartments(..)?`
- `transform.rs:4676-4697` — `compose_m0_for_context(..)?`
- `transform.rs:4699-4710` — a `CoverageGap` return: "coverage gap after
  re-cut: live item {} (ordinal {}) is below coverage end {:?} but uncovered"
- `transform.rs:4712-4730` — a second mint-absent check on the re-minted anchor
- everything from `:4794` (the `core.step`) through `:5383`
  (`build_output_with_tags`) to `:5565` (the commit)

So four `?` sites and one explicit `return Err` sit between the truncate and
the commit, plus the entire output build.

The contract this contradicts is `transform.rs:1796-1798` on `TransformError`:
"Each leaves the durable frozen-set UNCHANGED (the CAS simply does not
advance)". After the truncate, five tables have lost rows and `meta.revert_epoch`
has advanced, while the CAS indeed does not advance. Both halves of the sentence
are individually true and the conjunction is misleading.

## Failure scenario

A user reverts a conversation past a folded boundary. The next pass finds
`reconcile_pending` true and a minted anchor that no live block carries, enters
the truncate arm, and deletes the compartments the revert orphaned. The
re-composed m0 then still leaves a live block below the new coverage end, so
`:4704` returns `CoverageGap`. The transform fails. Durably:
`mc_compartments`, `mc_chunk_transcripts`, `mc_compartment_events`,
`mc_primer_candidates`, `mc_user_memory_candidates` and
`mc_historian_side_channel_outbox` have lost rows; `meta.revert_epoch` and
`meta.last_recut` have advanced; `core.boundary_id` and `meta.coverage_ordinal`
still name the coverage that the deleted compartments provided.

The same split state results from a process kill anywhere in that window,
which is the more likely trigger in production because the window contains the
whole output build.

## Timing windows and dependencies

Window: `transform.rs:4650` (truncate returns) to `:5565` (commit). No
concurrent writer is required. A single-process crash or any error in the window
produces the state.

Self-healing argument, unproven: `reconcile_pending` is never cleared by the
failed pass, because clearing happens in `step_hard`
(`../commons/crates/cortexkit-cache-core/src/lib.rs:250`) and the step is at
`transform.rs:4794`, downstream of the failure. So the next pass should re-enter
the same arm, find `dropped_count == 0` (`mc-store/src/lib.rs:9053`), and
proceed with a no-op truncate. This is the reasoning; no test constructs it.

## What a test must construct

1. Seed a session with several compartments and a folded m0 so
   `meta.initialized` is true and `meta.coverage_ordinal` is set.
2. Force `core.reconcile_pending = true`, which a defer with the boundary absent
   produces naturally (cache-core `:197`).
3. Supply an array whose live blocks do not carry the stored `boundary_id`, so
   `boundary_available` (`transform.rs:7160`-region) is false and the arm is
   entered.
4. Arrange the post-truncate composition to leave an uncovered live block below
   the new coverage end, so `:4704` fires. A live block whose ordinal is below
   the surviving compartment's `end_message` but which no surviving compartment
   covers does it.
5. Assert the returned error is `CoverageGap`.
6. Assert the compartment count is unchanged and `meta.revert_epoch` is
   unchanged. Both assertions fail today.

As a coverage check instead of a violation check, assert the three independent
preconditions separately, so the marker still fires on a corrected
implementation: `reconcile_pending` observed true on entry to `:4642`, the
truncate observed to return `dropped_count > 0`, and the pass observed to reach
`:5565`. Never pair `always(!X)` with `sometimes(X)`.

## Investigation log

### Q: Is the next pass guaranteed to re-enter the same reconcile arm?

- Sources examined: `transform.rs:4642`, `:4794`, `:4805`;
  `../commons/crates/cortexkit-cache-core/src/lib.rs:197`, `:243-256`.
- Findings: `reconcile_pending` is cleared only by `step_hard` (`:250`) and by a
  defer that regains the boundary (`:197`). The failed pass reaches neither: the
  step is at `transform.rs:4794`, after the failure point. So the durable
  `reconcile_pending` stays true. Whether the next pass classifies to HARD and
  re-enters `:4642` depends on the classifier, which is the sibling lens's
  territory.
- Missing evidence: the classifier's behaviour on a session whose
  `coverage_ordinal` names a deleted compartment.
- Conclusion: unresolved, needs the pass-selection lens's result plus a
  constructed test. The reasoning supports recovery; it is not proof.

### Q: Could the truncate be moved inside the terminal transaction?

- Sources examined: `mc-store/src/lib.rs:9015-9161`, `:7260-7600`;
  `transform.rs:4651`, `:4654-4697`.
- Findings: the pass consumes the truncate's output before it can render:
  `commit_expected` (`:4651`), `meta.revert_epoch` (`:4652`), and the re-read
  compartments at `:4666` all feed `compose_m0_for_context` at `:4676`. So the
  truncate cannot simply be deferred to the commit without restructuring the
  composition to take the intended post-truncate compartment set as a value
  instead of re-reading it.
- Missing evidence: none needed for this observation.
- Conclusion: resolved with answer — not a small change. Recording the property
  is the right output here; remediation is out of scope per METHOD.md rule 6.
