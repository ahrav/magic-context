# mirror-reset-cycle-requires-a-rebuild-grant

## Discovery trigger

`ClaimMirrorError::ResetRequired` renders as "claim mirror replacement requires
begin_claim_store_rebuild" (`crates/mc-store/src/claim_mirror.rs:217-220`). An
error that names a specific method as the remedy is a strong claim about the call
graph, so the next question is who calls that method.

## Evidence trail

**The grant.** `begin_claim_store_rebuild` (`crates/mc-store/src/lib.rs:11304-11348`)
validates a real 32-hex incarnation (`:11310-11314`), refuses while any intent is
unresolved (`:11319-11327`), and otherwise upserts the singleton control row to
`transition_state = 'resetting'` (`:11328-11338`).

**The three readers that latch without it.**

1. Reseed of an existing mirror. `replace_claim_mirror_snapshot` short-circuits
   when the incoming snapshot is byte-identical to durable state
   (`claim_mirror.rs:786-805`: vector equality at `:788-790`, checkpoint equality
   at `:791-793`, sorted row equality at `:794-802`, `Ok(Ok(()))` at `:804`).
   Anything else requires the control row to say `resetting`:

   ```
   806  if !matches!(control.as_ref(), Some((_, state)) if state == "resetting") {
   807      return Ok(Err(ClaimMirrorError::ResetRequired));
   808  }
   ```

   `matches!(None, Some(_))` is `false`, so an absent control row means
   `ResetRequired`.

2. Delete. `delete_claim_mirror` (`claim_mirror.rs:1128-1151`) reads
   `transition_state = 'resetting'` as a boolean and defaults an absent row to
   `false`:

   ```
   1136 let resetting = tx.query_row(
   1138     "SELECT transition_state = 'resetting' FROM mc_claim_intent_controls WHERE id = 1", ...)
   1143     .optional()?
   1144     .unwrap_or(false);
   1145 if !resetting { return Ok(Err(ClaimMirrorError::ResetRequired)); }
   ```

3. First seed while draining. `claim_mirror.rs:810-814` refuses a first seed when
   the control row says `draining`. Not reached when the row is absent.

`clear_claim_mirror` (`claim_mirror.rs:702-708`) drops all four tables and is
reachable from exactly two places: `:816` inside the reseed, past the `:806` gate,
and `:1148` inside the delete, past the `:1145` gate. Both gates require the
control row.

**No production caller of the grant.** Every reference to
`begin_claim_store_rebuild` in `crates/` and `packages/`:

| Location | Kind |
| --- | --- |
| `crates/mc-store/src/lib.rs:11304` | the definition |
| `crates/mc-store/src/claim_mirror.rs:219` | error message text |
| `crates/mc-store/src/claim_mirror.rs:754` | doc comment on `replace_claim_mirror_snapshot` |
| `crates/mc-store/tests/claim_intent_ledger.rs:299`, `:313` | test |
| `crates/mc-store/tests/claim_mirror.rs:331`, `:454`, `:498` | test |

The facade dispatch table exposes only `claim.mirror.replace` and
`claim.mirror.apply` (`crates/mc-module/src/lib.rs:10052-10053`). There is no
handler for a rebuild grant.

**The other writer cannot supply the row either.**
`set_claim_intent_transition_tx` (`lib.rs:4118-4145`) would write `resetting` from
`authority_begin_prepare` (`:11434-11440`) and `authority_finish_prepare`
(`:11640-11651`), but its guard at `:4124-4126` returns `Ok(())` without writing
whenever the identity is not 32 lowercase hex, and all four call sites pass
`context_store_uuid`. See `intent-control-transition-write-is-silently-dropped`.

**What the tests prove and do not prove.**
`tests/claim_mirror.rs:377-458` walks the whole cycle and pins the ordering:
`delete_claim_mirror` returns `ResetBlocked { unresolved: 1 }` while an intent is
staged (`:430-433`), then `ResetRequired` once the intent is terminal but before a
grant (`:449-452`), then succeeds after `begin_claim_store_rebuild` at `:454-455`.
`:461-479` shows the byte-identical reseed is idempotent without any grant
(`:470-471`) and that a single changed checkpoint yields `ResetRequired`
(`:475-478`). `:482-517` shows the grant-delete-reseed cycle reproduces state
across a reopen. Every one of these calls the grant from test code, so they
demonstrate the protocol works while saying nothing about production reachability.

## Failure scenario

Production has no reset. Concretely:

- A mirror absorbs a receipt that leaves it diverged from the authority in a way
  admission checks did not catch — for example the omission class in
  `mirror-project-effect-chain-detects-omission`, if that check were ever
  weakened, or a `CheckpointMismatch` caused by the double-apply in
  `mirror-receipt-replay-applies-effects-once`.
- The host tries to recover by pushing a fresh full snapshot through
  `claim.mirror.replace`. Because the snapshot differs from durable state, the
  byte-equality short circuit at `claim_mirror.rs:800-805` does not fire, and
  `:806-808` returns `ResetRequired`.
- The host tries `delete` — there is no facade method, and even internally
  `delete_claim_mirror` would return `ResetRequired` at `:1145`.
- The lane stays wedged for the life of the `database_incarnation_id`.

The only escape is a new incarnation, since all three data tables are keyed by it
(`lib.rs:1268`, `:1289`, `:1309`). That leaves the old rows resident forever,
because the only deletion in the tree is the unreachable `clear_claim_mirror`.

## Timing windows and dependencies

- No timing window. This is a static property of the production call graph.
- Depends on `intent-control-transition-write-is-silently-dropped`: if that guard
  were fixed so authority transitions wrote the control row, then
  `authority_begin_prepare` would set `resetting` (`lib.rs:11438`) and the reseed
  path would become reachable — but the row's incarnation column would then hold a
  `context_store_uuid`, which `claim_mirror.rs:778-785` compares for equality
  against a real incarnation ID and would reject with `IncarnationMismatch`. Fixing
  one without the other moves the wall rather than removing it.
- Interacts with `mirror-accepting-gate-is-skipped-when-control-is-absent`: the same
  absent row that blocks reseed also disables the apply gate.
- Independent of `mirror-clear-without-a-grant-is-never-entered`, its split
  sibling. That record asserts the two clear statements stay cold in a grant-free
  campaign and passes today; this one asserts they can be reached from production
  and fails today. Same two markers, opposite expectations, different campaign
  preconditions.

## What a test must construct

This record is reachability, so the test is location coverage from a production
entry point, not a behavioural assertion.

1. Markers `MIRROR_CLEAR_VIA_RESEED` at `claim_mirror.rs:816` and
   `MIRROR_CLEAR_VIA_DELETE` at `:1148`. Constant, globally unique names, shared
   with `mirror-clear-without-a-grant-is-never-entered`, which asserts the
   opposite outcome under a grant-free campaign.
2. Drive the system only through production entry points — the facade dispatch at
   `mc-module/src/lib.rs:10052-10053` and the authority lifecycle methods — and
   assert each marker is reached at least once per campaign.
3. On the current tree both markers stay cold, which is the finding. The test
   should therefore be written to fail, and its failure is the evidence, rather
   than being written to pass by calling `begin_claim_store_rebuild` directly.
4. Complementary assertion that needs no instrumentation: from a seeded mirror,
   using only facade calls, attempt a non-identical `claim.mirror.replace` and
   assert the error code. `claim_mirror_error` maps `ResetRequired` at
   `mc-module/src/lib.rs:13844-13860`; confirm the code a caller sees and record it,
   because that string is the only production signal that the mirror is stuck.
5. Also assert the intent ledger survives a delete, as
   `tests/claim_mirror.rs:457` does, since `claim_mirror.rs:1126-1127` promises it.

## Investigation log

### Q: Is `begin_claim_store_rebuild` meant to be reachable in production?

- Sources examined: `grep` for the symbol across `crates/` and `packages/`;
  `mc-module/src/lib.rs:10040-10060` (facade dispatch); `claim_mirror.rs:219`,
  `:754`, `:1126-1127` (the doc comments that name it).
- Findings: no production caller and no facade method. Three doc comments describe
  the grant as the precondition for two operations, so the protocol was designed
  and written down; only the wiring is missing. I could not find an alternative
  production mechanism that sets `transition_state = 'resetting'`, because the only
  other writer is dead per
  `intent-control-transition-write-is-silently-dropped`.
- Missing evidence: whether the host is expected to mint a fresh
  `database_incarnation_id` instead of resetting, and whether anything collects
  rows under retired incarnations.
- Conclusion: needs human input.

### Q: Does a new `database_incarnation_id` fully substitute for a reset?

- Sources examined: `lib.rs:1255-1256`, `:1262-1263`, `:1272-1274`, `:1300-1301`
  (the incarnation column on all four tables), `:1268`, `:1289`, `:1309` (primary
  keys), `claim_mirror.rs:786-814` (the reseed gates), `:770-776` (the existing-state
  read).
- Findings: partly. The reseed's `existing` probe at `:770-776` reads
  `mc_claim_mirror_state` with no incarnation predicate, and that table is a
  singleton keyed `id = 1` (`lib.rs:1252`). So a *new* incarnation still finds
  `existing.is_some()` from the old one and still hits the `:806` gate. A fresh
  incarnation therefore does **not** bypass the wall; the singleton state row is
  what blocks it. The per-incarnation keying on the three data tables only means
  old data rows would linger, unreadable via `list_claim_mirror` unless queried
  under the old incarnation.
- Missing evidence: none for the mechanism. Whether an operator is expected to
  delete `mc_cache` out of band is a deployment question.
- Conclusion: resolved with answer — no. Because `mc_claim_mirror_state` is a
  singleton with no incarnation predicate at `claim_mirror.rs:770-776`, changing the
  incarnation does not re-enable the reseed path.
