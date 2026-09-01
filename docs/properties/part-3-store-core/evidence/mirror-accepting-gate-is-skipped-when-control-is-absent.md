# mirror-accepting-gate-is-skipped-when-control-is-absent

## Discovery trigger

`apply_claim_mirror_receipt` and `delete_claim_mirror` both consult the singleton
`mc_claim_intent_controls` row, twelve lines apart in behaviour, and they disagree
about what an absent row means. One treats absence as permission, the other as
refusal, and no comment explains the difference.

## Evidence trail

**The apply gate, fail-open.**

```
908  let control = claim_intent_control(tx)?;
909  if let Some((control_incarnation, state)) = control {
910      if control_incarnation != *incarnation {
911          return Ok(Err(ClaimMirrorError::IncarnationMismatch { ... }));
915      }
916      if state != "accepting" {
917          return Ok(Err(ClaimMirrorError::ResetRequired));
918      }
919  }
```

(`crates/mc-store/src/claim_mirror.rs:908-919`.) The whole gate is inside
`if let Some(...)`. When `claim_intent_control` returns `None` — which it does via
`.optional()` when the row is missing (`claim_mirror.rs:683-691`) — control falls
straight through to the dedup lookup at `:921` and the receipt is applied.

**The delete gate, fail-closed.**

```
1136 let resetting = tx
1137     .query_row(
1138         "SELECT transition_state = 'resetting'
1139            FROM mc_claim_intent_controls WHERE id = 1", [], |row| row.get::<_, bool>(0))
1143     .optional()?
1144     .unwrap_or(false);
1145 if !resetting { return Ok(Err(ClaimMirrorError::ResetRequired)); }
```

(`claim_mirror.rs:1136-1147`.) `unwrap_or(false)` converts absence to
not-resetting, and the guard refuses.

**The reseed gate, also fail-closed.**

```
806  if !matches!(control.as_ref(), Some((_, state)) if state == "resetting") {
807      return Ok(Err(ClaimMirrorError::ResetRequired));
808  }
```

(`claim_mirror.rs:806-808`.) `matches!(None, Some(_))` is `false`, so absence
refuses.

So two of three readers in the same file fail closed and one fails open. The
staging fence in the ledger makes the same fail-open choice:
`claim_intent_stage_fence` uses `transition.filter(|state| state != "accepting")`
(`crates/mc-store/src/lib.rs:4052-4061`), and `None.filter(..)` is `None`, so an
absent row passes the fence.

**Why absence is the production default.** The row has two writers and neither
fires in production. `set_claim_intent_transition_tx` returns `Ok(())` without
writing when the identity is not 32 lowercase hex (`lib.rs:4124-4126`) and all four
call sites pass `context_store_uuid` (`:11436`, `:11642`, `:11740`, `:11792`); see
`intent-control-transition-write-is-silently-dropped`.
`begin_claim_store_rebuild` writes it correctly (`:11328-11338`) but has no
production caller; see `mirror-reset-cycle-requires-a-rebuild-grant`. So every
production apply runs through the fall-through branch and no test asserts that it
does.

**What the gate would protect.** The `accepting` state is set in exactly one place
that production can reach: the tail of a successful reseed, which flips
`resetting` to `accepting` (`claim_mirror.rs:849-856`). So the intended cycle is
grant `resetting`, delete, reseed, and the reseed re-opens the gate. During the
`resetting` window the gate at `:916-918` is what stops a pre-reset receipt from
landing on a mirror that is about to be replaced.

**Reachability.** The apply path is `claim.mirror.apply`, dispatched at
`crates/mc-module/src/lib.rs:10053` and calling `store.apply_claim_mirror_receipt`
at `:10326`, outside any test module. So the fall-through branch is
default-production; the gated branch is only reachable once something writes the
control row, which today is test-only.

## Failure scenario

Latent today, live the moment the grant is wired.

1. The host mints receipt 9 and sends `claim.mirror.apply`. The request is slow.
2. An operator begins a rebuild. `begin_claim_store_rebuild` sets `resetting`
   (`lib.rs:11328-11338`) after confirming no intent is unresolved.
3. Receipt 9 arrives. With the control row present, `:916-918` refuses it with
   `ResetRequired`, and the reset proceeds against a stable mirror.
4. With the row absent — today's production state — receipt 9 is applied. Its
   effects advance `acked_effect_id` and the generation vector, and the dedup row
   is inserted (`claim_mirror.rs:1097-1113`).
5. The reseed then arrives with a snapshot minted *before* receipt 9. It compares
   unequal at `:800-802`, and without a `resetting` row it returns `ResetRequired`
   (`:806-808`). With the row it clears and replaces, discarding receipt 9's
   effects — which is correct, since the snapshot is the new baseline — but the
   host's belief about what the mirror contains was wrong for the whole window.

The second-order hazard is the incarnation comparison at `:910-914`. If the
control row is ever populated by `set_claim_intent_transition_tx`, its
`database_incarnation_id` column would hold a `context_store_uuid`, which
`lib.rs:4062-4065` states is minted independently of the real incarnation. Every
apply would then fail `IncarnationMismatch` permanently. So fixing the write guard
without fixing the argument turns a fail-open hole into a total outage.

## Timing windows and dependencies

- Window: between a control row entering `resetting` or `draining` and the reset
  completing. In production the window does not exist because the row never
  appears.
- Dependency: `intent-control-transition-write-is-silently-dropped` and
  `mirror-reset-cycle-requires-a-rebuild-grant` jointly explain why absence is the
  default. This record is the consequence, not the cause.
- Dependency: `claim_intent_control` (`claim_mirror.rs:683-691`) uses `.optional()`,
  so a missing row is `None` rather than an error. That is what makes the
  `if let Some` shape silent.

## What a test must construct

1. Gated branch, present row. Seed a mirror. Write the control row via
   `begin_claim_store_rebuild` so it says `resetting`. Apply a valid receipt.
   Assert `ClaimMirrorError::ResetRequired` and assert the mirror is byte-identical
   before and after.
2. Same with `draining`. Today there is no production way to reach `draining`
   without the dead writer, so this arm needs either a direct SQL fixture or a
   fixed writer. Note which, because it is itself evidence about reachability.
3. `accepting`. Complete the grant-delete-reseed cycle so `:849-856` sets
   `accepting`, then apply a receipt and assert it succeeds. This pins that the
   gate discriminates rather than always refusing.
4. Absent row, the production default. Seed a mirror with no control row, apply a
   receipt, and assert the current behaviour explicitly, whatever the team decides
   it should be. Writing this assertion down is the point: today the behaviour is
   untested and therefore free to change silently.
5. Incarnation arm. With a control row whose incarnation differs from the mirror's,
   apply a receipt and assert `IncarnationMismatch { expected, found }` with the
   right operands. This documents the trap described in the failure scenario.
6. Asymmetry regression. In one test, with no control row, assert that
   `apply_claim_mirror_receipt` succeeds while `delete_claim_mirror` returns
   `ResetRequired`. That single test captures the whole finding in one place.

## Investigation log

### Q: Is fail-open correct here on the reasoning that a store with no control row has no ledger to fence?

- Sources examined: `claim_mirror.rs:908-919` (the gate), `:1136-1147` and
  `:806-808` (the two fail-closed readers), `lib.rs:4052-4061` (the staging fence,
  also fail-open), `claim_mirror.rs:693-700` (`unresolved_claim_intents`, which
  counts rows in `mc_claim_intents` and does not consult the control row at all).
- Findings: there is a defensible reading. Both reset paths *also* count unresolved
  intents independently (`claim_mirror.rs:764-769` and `:1130-1135`), so the
  "ledger is drained" precondition does not depend on the control row. Under that
  reading the control row is purely a transition marker, and absence genuinely
  means "no transition in progress", which makes fail-open correct for apply and
  the fail-closed reseed and delete gates deliberately conservative about
  destructive operations. That reading is coherent. It is also nowhere in the file,
  and the two neighbouring readers chose the opposite default without comment.
- Missing evidence: any comment, doc, or commit message stating the intended
  meaning of an absent control row. `claim_mirror.rs:1126-1127` documents the
  delete precondition but not the absence case.
- Conclusion: unresolved, needs a design statement about what an absent control row
  means. The behaviour is defensible; the inconsistency between three readers in one
  file is not explained.

### Q: Can `claim_intent_control` return an error rather than `None` for a missing row?

- Sources examined: `claim_mirror.rs:683-691`.
- Findings: no. It uses `.optional()` on the `query_row`, which maps
  `QueryReturnedNoRows` to `Ok(None)`. Any other SQLite error still propagates and
  aborts the transaction, so a genuinely broken table is not silently treated as
  absent.
- Missing evidence: none.
- Conclusion: resolved with answer — a missing row is `None`; a broken read is an
  error.
