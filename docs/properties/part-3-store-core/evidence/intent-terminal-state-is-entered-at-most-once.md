# intent-terminal-state-is-entered-at-most-once

## Discovery trigger

`ClaimIntentState` has four variants but `is_unresolved` names only two
(`crates/mc-core/src/claim_operation.rs:399-401`), so `acknowledged` and
`terminal-rejected` are the terminal pair. Every reset in the system gates on that
pair, so whether a terminal state can be re-entered or overwritten decides whether
a reset can ever be granted.

## Evidence trail

**The four states and the resolved split.**

```
372 pub enum ClaimIntentState { Staged, ContextCommitted, Acknowledged, TerminalRejected }
399 pub fn is_unresolved(self) -> bool {
400     matches!(self, Self::Staged | Self::ContextCommitted)
401 }
```

(`mc-core/src/claim_operation.rs:372-377`, `:399-401`.) The schema mirrors the four
values (`crates/mc-store/src/lib.rs:1224-1226`) and adds a CHECK tying
`result_json` to the state:

```
1231 CHECK (
1232     (state = 'staged' AND result_json IS NULL)
1233     OR (state <> 'staged' AND result_json IS NOT NULL)
1234 )
```

(`lib.rs:1231-1234`.) So leaving `staged` always writes a result, and no non-staged
row can have a NULL result.

**The whole transition table is one `match`.** `lib.rs:11225-11255`, enumerated
against all twelve `(ClaimIntentAckKind, ClaimIntentState)` pairs:

| Ack kind | `staged` | `context-committed` | `acknowledged` | `terminal-rejected` |
| --- | --- | --- | --- | --- |
| `ContextCommitted` | to `context-committed` (`:11226-11228`) | no-op if `result_json` matches (`:11237`), else `Transition` | no-op if matches (`:11238`), else `Transition` | `Transition` (`:11244`) |
| `Acknowledged` | `Transition` (`:11244`) | to `acknowledged` (`:11232-11234`) | no-op (`:11235`) | no-op (`:11236`) |
| `TerminalRejected` | to `terminal-rejected` (`:11229-11231`) | `Transition` (`:11244`) | `Transition` (`:11244`) | no-op if matches (`:11239`), else `Transition` |

Three facts follow:

1. `terminal-rejected` is unreachable from `context-committed` and from
   `acknowledged`. A claim whose context mutation committed can never be
   retroactively recorded as rejected.
2. `acknowledged` is reachable only from `context-committed`. There is no
   `staged` to `acknowledged` shortcut.
3. Both terminal states absorb. Every arm that lands on a terminal row yields
   either `None` (no-op) or a `Transition` error.

**No-op means literally no write.** `next_state` is an `Option`, and the `UPDATE`
is inside `if let Some(next_state)`:

```
11256 if let Some(next_state) = next_state {
11257     tx.execute("UPDATE mc_claim_intents
11258                    SET state = ?1, result_json = COALESCE(?2, result_json), updated_at_ms = ?3
11260                  WHERE producer = ?4 AND operation_key = ?5", ...)?;
...
11277     return Ok(ClaimIntentTxnOutcome::Applied(... replayed: false ...));
11281 }
11282 Ok(ClaimIntentTxnOutcome::Applied(ClaimIntentMutationOutcome { record, replayed: true }))
```

(`lib.rs:11256-11285`.) The `None` path returns the row it already read, unmodified,
with `replayed: true`. Not even `updated_at_ms` moves, so a retry leaves no trace.

**The idempotent-replay arms are guarded on result bytes.** `:11237-11243` is
`if record.result_json.as_deref() == result_json`. When the state matches but the
bytes differ the guard fails and control reaches `_` at `:11244-11254`, which
reports `Transition { expected: <"staged" or "context-committed">, found: <actual> }`
— naming a state discrepancy for what is actually a result-bytes discrepancy. That
is lead L5 in the lens; it is a diagnosis problem, not a safety problem, because
the row is still not written.

**Result bytes are validated before the transaction.**
`validate_claim_result_json` (`lib.rs:3924-3961`) requires canonical encoding
(`:3932-3938`), requires a `ContextCommitted` result to be `Applied` or `Noop`
(`:3939-3949`), and requires a `TerminalRejected` result to be `Stale` with zero
effects and zero generations (`:3950-3958`). The kind-to-payload pairing is
enforced too: `Acknowledged` must supply no `result_json` and the others must supply
one (`lib.rs:11180-11193`). So a terminal row's stored result is structurally
constrained by the transition that created it.

**Terminal rows are never deleted.** No `DELETE` against `mc_claim_intents` exists
anywhere in the tree, and `claim_mirror.rs:1126-1127` states the ledger survives a
mirror delete, which `tests/claim_mirror.rs:457` asserts. So a terminal row is
permanent for the life of the database.

**Test coverage.** `tests/claim_intent_ledger.rs:86-131` walks `staged` to
`context-committed` (`:94-103`) to `acknowledged` (`:104-113`) and then stages 600
further commands (`:115-...`) to prove the row survives.
`:169-228` and `:346-401` each reach `terminal-rejected` from `staged` and assert
`unresolved_claim_intent_count() == 0` afterwards (`:227`). No test attempts an
illegal transition out of a terminal state, and no test asserts that a repeated
acknowledgement of a terminal row leaves the row byte-identical.

**Reachability.** `acknowledge_claim_intent` is a public `McStore` method reached
from the module facade; the transition table is on the unconditional path of every
call. Nothing is gated on configuration.

## Failure scenario

Two shapes, both invisible to the caller.

**A rejection overwrites a commitment.** If `(TerminalRejected,
ContextCommitted)` fell through to the `UPDATE` instead of `Transition`, a late
"stale" acknowledgement — the shape
`tests/claim_intent_ledger.rs:216-226` legitimately sends after a drain begins —
would overwrite a row whose context mutation already committed. The ledger would
then report the claim as rejected while the effect exists in `context.db`, and the
mirror would faithfully project the effect. Reconciling that afterwards is
impossible from the store side, because the intent's own record of what happened
has been destroyed.

**A retry rewrites `result_json` under a caller that already read it.** If the
`:11237-11243` guard were dropped, an acknowledgement retry carrying different
result bytes would `COALESCE` them into place at `:11259`. A caller that read the
first value and a caller that reads the second would disagree about the outcome of
one operation, with no error on either side.

A third, milder shape is already present rather than hypothetical: because
`(Acknowledged, TerminalRejected)` is a silent no-op (`:11236`), nothing records
that a rejection was ever delivered to its producer. `unresolved_claim_intent_count`
already counts the row as resolved (`:11290-11301`, and the identical query at
`claim_mirror.rs:693-700`), so a reset can be granted whether or not the producer
ever learned of the rejection.

## Timing windows and dependencies

- Window: a lost acknowledgement response causing a retry. The retry must be a
  no-op, and a *different* acknowledgement arriving late must be an error. Both land
  in the same `match`, so the discrimination is entirely the `(kind, state)` pair
  plus the result-bytes guard.
- The whole read-decide-write sequence is inside one `with_conn_fenced` IMMEDIATE
  transaction (`lib.rs:11195`,
  `../commons/crates/cortexkit-store/src/lib.rs:185-192`), so two concurrent
  acknowledgements cannot both observe `staged` and both write.
- Depended on by every reset gate:
  `begin_claim_store_rebuild:11319-11327`,
  `replace_claim_mirror_snapshot` via `claim_mirror.rs:764-769`, and
  `delete_claim_mirror` via `:1130-1135`. If a terminal row could revert to
  unresolved, a granted reset could be invalidated mid-flight.

## What a test must construct

1. Drive one intent to `acknowledged`. Then attempt, in turn,
   `ContextCommitted` with matching bytes, `ContextCommitted` with different bytes,
   `TerminalRejected`, and `Acknowledged`. Assert the outcome variant for each and,
   after every attempt, assert the row is byte-identical including `updated_at_ms`.
   The `updated_at_ms` assertion is what proves the `None` path writes nothing.
2. Drive a second intent to `terminal-rejected`. Repeat the same four attempts.
   `TerminalRejected` with matching bytes must be `replayed: true`;
   `ContextCommitted` and `Acknowledged`-after-rejection must behave per the table,
   and `Acknowledged` specifically must be a silent no-op, which is the arm worth
   pinning because it is a design question rather than an obvious rule.
3. The two forbidden downgrades explicitly:
   `(TerminalRejected, ContextCommitted)` and `(TerminalRejected, Acknowledged)`.
   Both must be `ClaimIntentTransition`, and the test should record the `expected`
   and `found` strings it observes, because L5 shows those strings can be
   misleading.
4. `(Acknowledged, Staged)` must be `Transition`, proving there is no shortcut past
   `context-committed`.
5. The result-bytes guard. Drive to `context-committed`, then acknowledge
   `ContextCommitted` again with a *different but individually valid* result
   payload. Assert the row is unchanged and record which error variant is returned.
   No test covers this arm today.
6. Concurrency. Two threads acknowledging the same `staged` row with different
   kinds. Exactly one must succeed and the other must see `Transition`; assert the
   final state is one of the two terminals and that `result_json` matches whichever
   transition won.
7. Reset interaction. After every row is terminal, assert
   `unresolved_claim_intent_count() == 0` and that `begin_claim_store_rebuild`
   succeeds; then assert no subsequent acknowledgement can move a row back into
   `staged` or `context-committed`.

## Investigation log

### Q: Is settlement of a rejection meant to be observable?

- Sources examined: `lib.rs:11235-11236` (`(Acknowledged, Acknowledged)` and
  `(Acknowledged, TerminalRejected)` both yield `None`),
  `mc-core/src/claim_operation.rs:368-369` (the doc: "`acknowledged` is transport
  settlement, not a second semantic claim state"), `lib.rs:11290-11301`
  (`unresolved_claim_intent_count`), `claim_mirror.rs:693-700` (the same query used
  by both reset gates).
- Findings: the doc comment argues the no-op is deliberate. `acknowledged` is
  described as transport settlement, and `terminal-rejected` is already terminal, so
  there is no second semantic state to move to. The consequence is that "the
  producer was told about this rejection" is recorded nowhere: the row looks
  identical before and after the acknowledgement, `updated_at_ms` included. Any
  operator trying to distinguish "rejected and delivered" from "rejected and the
  response was lost" cannot. Whether that matters depends on whether anything
  retries deliveries of rejections, which is above this layer.
- Missing evidence: whether the facade or host tracks delivery of rejection
  results separately.
- Conclusion: unresolved, needs the facade's rejection-delivery path.

### Q: Can a terminal row ever become unresolved again?

- Sources examined: the full transition `match` at `lib.rs:11225-11255`, the
  `UPDATE` at `:11256-11268`, and a search for any other statement writing
  `mc_claim_intents.state`.
- Findings: no. `stage_claim_intent`'s `INSERT` hardcodes `'staged'`
  (`lib.rs:11092`) and is reached only when no row exists (`:11048` guards it), so
  it cannot reset an existing row. The acknowledgement `UPDATE` is the only other
  writer, and `next_state` can only be `ContextCommitted`, `Acknowledged`, or
  `TerminalRejected` — never `Staged`, since no arm produces it. There is no
  `DELETE`, so a row cannot be removed and re-inserted as `staged` either.
- Missing evidence: none.
- Conclusion: resolved with answer — no. `staged` is write-once at insert, and no
  transition produces it.
