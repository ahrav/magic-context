# mirror-clear-without-a-grant-is-never-entered

Split from `mirror-reset-cycle-requires-a-rebuild-grant`, which conflated two
opposite claims about the same two code points: whether the valid clear path can
be entered at all, and whether the invalid one is kept out. That file keeps the
first. This one keeps the second, which is the safety side and the only one that
passes today.

## Discovery trigger

`clear_claim_mirror` (`crates/mc-store/src/claim_mirror.rs:702-708`) deletes every
row from all four mirror tables in four unconditional statements. A function with
no predicate of its own is only as safe as its callers, so the question is what
guards each call site and what those guards do when the control row they read is
absent.

## Evidence trail

**The destructive primitive.** Four unguarded deletes:

```
702 fn clear_claim_mirror(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
703     tx.execute("DELETE FROM mc_claim_mirror_receipts", [])?;
704     tx.execute("DELETE FROM mc_claim_mirror_claims", [])?;
705     tx.execute("DELETE FROM mc_claim_mirror_projects", [])?;
706     tx.execute("DELETE FROM mc_claim_mirror_state", [])?;
```

It is called from exactly two places: `:816` inside
`replace_claim_mirror_snapshot` and `:1148` inside `delete_claim_mirror`. Both
calls sit after a guard, and both guards are inside the same `with_conn_fenced`
transaction as the clear, so there is no window between the decision and the
effect.

**Guard one, the reseed.** `replace_claim_mirror_snapshot` first short-circuits
when the incoming snapshot is byte-identical to durable state
(`claim_mirror.rs:786-805`: vector equality at `:788-790`, checkpoint equality at
`:791-793`, sorted row equality at `:794-802`, `Ok(Ok(()))` at `:804`). Anything
else requires the control row to say `resetting`:

```
806  if !matches!(control.as_ref(), Some((_, state)) if state == "resetting") {
807      return Ok(Err(ClaimMirrorError::ResetRequired));
808  }
```

`matches!(None, Some(_))` is `false`, so an absent control row yields
`ResetRequired`. This guard fails closed.

**Guard two, the delete.** `delete_claim_mirror` (`claim_mirror.rs:1128-1151`)
refuses while any intent is unresolved (`:1130-1135`), then reads
`transition_state = 'resetting'` as a boolean and defaults an absent row to
`false`:

```
1136 let resetting = tx.query_row(
1138     "SELECT transition_state = 'resetting' FROM mc_claim_intent_controls WHERE id = 1", ...)
1143     .optional()?
1144     .unwrap_or(false);
1145 if !resetting {
1146     return Ok(Err(ClaimMirrorError::ResetRequired));
1147 }
1148 clear_claim_mirror(tx)?;
```

Also fails closed, by a different derivation: the reseed pattern-matches the state
string in Rust, the delete evaluates the comparison in SQL and collapses an absent
row with `unwrap_or(false)`.

**A third refusal that is not a clear guard.** `claim_mirror.rs:810-814` refuses a
*first* seed while the control row says `draining`. It protects a different
transition and is not reached when the row is absent, so it is outside this
record's claim.

**The contrast that makes this record worth stating separately.** Twelve lines
above guard one, `apply_claim_mirror_receipt` reads the same control row and
treats an absent row as *permission* rather than refusal, because its gate at
`:908-919` sits behind `if let Some(control)` with no `else`. Three readers of one
row, two fail closed and one fails open. That asymmetry is
`mirror-accepting-gate-is-skipped-when-control-is-absent`; the two clear guards are
the ones that got it right, which is exactly why they are worth pinning before a
future edit aligns them the wrong way.

**What the tests cover.** `tests/claim_mirror.rs:461-479`
(`u10_scenario_7_equivalent_restart_seed_is_idempotent`) seeds the same snapshot
twice with no grant and asserts both succeed (`:470-471`), then mutates one
checkpoint and asserts `ResetRequired` (`:474-478`). That is the reseed refusal
arm, proved by return value. Nothing covers the delete refusal arm with no grant,
and nothing observes non-entry at either clear statement, so today's evidence is
that the functions return the right error, not that the deletes did not run.

## Failure scenario

A future edit aligns the two clear guards with the apply gate's `if let
Some(control)` shape, on the reasonable-sounding argument that a store with no
control row has no ledger to fence. Because no production path writes the control
row today
(`intent-control-transition-write-is-silently-dropped`), the absent row is the
production norm, so the guard would be permanently open rather than occasionally
open.

Then any caller that reaches `replace_claim_mirror_snapshot` with a snapshot that
differs from durable state — the ordinary shape of a host restart seed after the
authority advanced — drops all four tables and rebuilds from the incoming
snapshot. If that snapshot is itself incomplete, the mirror silently loses every
claim it held that the snapshot omits, with no error to the caller. The mirror is
a projection with no local authority, so recovery requires a full reseed from the
source, and `mirror-reset-cycle-requires-a-rebuild-grant` shows production cannot
perform one.

## Timing windows and dependencies

- No timing window inside the operation. Each guard and its clear share one
  `with_conn_fenced` transaction, so the decision cannot go stale before the
  effect.
- Depends on `intent-control-transition-write-is-silently-dropped` for its risk
  profile rather than its correctness. That defect is what makes the absent row
  the norm, which is what turns a fail-open regression here from rare into total.
- Contrasts with `mirror-accepting-gate-is-skipped-when-control-is-absent`, which
  is the same row read with the opposite default twelve lines away.
- Independent of `mirror-reset-cycle-requires-a-rebuild-grant`. That record fails
  today and this one passes; neither dominates the other, because one asks whether
  a location is reachable and the other asks whether it is kept out.

## What a test must construct

Location coverage of a forbidden location, under a stated campaign precondition.

1. Markers `MIRROR_CLEAR_VIA_RESEED` at `claim_mirror.rs:816` and
   `MIRROR_CLEAR_VIA_DELETE` at `:1148`. Constant, globally unique names, and the
   same two markers `mirror-reset-cycle-requires-a-rebuild-grant` asserts warm.
   One instrumentation, two records, opposite expectations under different
   campaign preconditions.
2. Scope the campaign explicitly: no call to `begin_claim_store_rebuild` anywhere
   in it. That precondition is what makes this a location claim rather than a
   compound state, per METHOD.md's rule that a forbidden state with no dedicated
   detection point uses `always(!X)` instead.
3. Seed a mirror, then drive both destructive entry points with the grant absent
   and assert both markers stay cold:
   - `replace_claim_mirror_snapshot` with a snapshot differing in the vector, in a
     checkpoint, and in a claim row, each separately, expecting `ResetRequired`.
   - `delete_claim_mirror` with no unresolved intents, expecting `ResetRequired`
     rather than `ResetBlocked`, so the refusal is attributable to the missing
     grant and not to the unresolved-intent check above it.
4. Repeat both with a control row present in every non-`resetting` state, so the
   absent-row case and the wrong-state case are distinguished. Writing the control
   row needs a 32-lowercase-hex incarnation (F8).
5. Do not assert the violation. The oracle is marker non-entry plus the returned
   error, never "the tables were cleared".

## Investigation log

### Q: Should the two guards share one derivation of `resetting`?

- Sources examined: `claim_mirror.rs:806` (the reseed's `matches!` on the state
  string), `:1136-1144` (the delete's SQL boolean with `unwrap_or(false)`),
  `claim_intent_control` (the shared reader the reseed uses), and `:908-919` (the
  apply gate's third shape).
- Findings: all three readers consume the same singleton row and derive their
  verdict differently. The two clear guards agree on the outcome today by
  coincidence of two correct-but-independent implementations, not by construction.
  The delete does not use `claim_intent_control` at all; it issues its own query.
- Missing evidence: no design note explains why three derivations exist. Nothing
  states which is canonical.
- Conclusion: unresolved, needs a design decision on a single canonical reader.
  Recording it here because a shared reader would make this record structurally
  true rather than incidentally true, and would also decide the fail-open question
  in `mirror-accepting-gate-is-skipped-when-control-is-absent`.

### Q: Is a clear reachable through any path other than these two?

- Sources examined: repository grep for `clear_claim_mirror` across `crates/` and
  `packages/`; the four table names in `MIGRATIONS` (`lib.rs:432-1312`) checked for
  `ON DELETE CASCADE`.
- Findings: two call sites only, `:816` and `:1148`. Of 42 tables in the bootstrap,
  only two carry a `REFERENCES` clause and two an `ON DELETE` clause, and the one
  mirror foreign key is `mc_claim_mirror_claims` referencing
  `mc_claim_mirror_projects`. So a cascade cannot empty the mirror from outside
  these two functions. `delete_session` (`lib.rs:5432-5476`) deletes by
  `session_id` across every table that carries that column, and no mirror table
  does.
- Missing evidence: none for in-tree paths. An out-of-band raw connection can
  delete anything and is out of scope for a reachability claim about this call
  graph.
- Conclusion: resolved with answer — no. The two guarded call sites are the only
  in-tree paths to a mirror clear.
