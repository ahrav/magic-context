# refused-durable-write-leaves-no-row-and-no-receipt

## Discovery trigger

While exercising the identity-decision property, the no-row half needed an
assertion. Writing it raised the symmetric question the audit tables depend on:
does a refused write also leave no audit receipt behind?

## Evidence trail

Two refusal points with different mechanics:

- `prepare_field` (`lib.rs:3174-3176`) refuses a `NewIdentity` detection before
  any transaction opens. Nothing can have been written, so the no-row and
  no-receipt halves are trivially true.
- `reject_recorded_identities` (`lib.rs:3111-3119`) refuses inside the fenced
  transaction, and relies on the rollback. At the facade site the mutation
  callback may already have run when the refusal fires, so the rollback is doing
  real work.

The audit rows are written inside the same fenced transaction as the domain row,
so a rollback should remove both. That is the inference the property rests on; no
test observes it.

`mc_scan_detections.action` admits `'reject'` (`lib.rs:1401`), and the schema
comment above it states that rejected writes roll back with their receipts. If
that is accurate, no committed row can ever carry `action = 'reject'`, which makes
the admitted value unreachable rather than merely rare.

## Oracle

`cache_state_identity_decision_comes_from_the_write_transaction`
(`lib.rs:17309`) asserts the no-row half at the `commit_transform` site:
`SELECT COUNT(*) FROM mc_cache_state WHERE session_id = ?1` is 0 after the
refusal.

Nothing asserts the no-receipt half.

## Limits

The no-receipt half is inference, not observation, and the deferred refusal path
is where it matters. `OQ-H3` asks whether `action = 'reject'` is reachable at all;
if it is not, the property should be stated as
`unreachable(action = 'reject')` and the schema should stop admitting the value.
