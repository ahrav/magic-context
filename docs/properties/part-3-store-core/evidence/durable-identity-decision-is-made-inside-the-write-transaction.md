# durable-identity-decision-is-made-inside-the-write-transaction

## Discovery trigger

Three review comments on the durable-write branch claimed the same shape: an
existence read taken outside the fenced transaction decides whether an identity
is new, and nothing re-verifies that decision inside the transaction that writes.
The comments named four sites. Two were already closed, and two were live.

## Evidence trail

The decision the property is about. `PreparedFieldPolicy` at `lib.rs:2956-2960`:

- `NewIdentity` refuses a detected secret inside `prepare_field`
  (`lib.rs:3174-3176`).
- `ExistingIdentity` records the detections and preserves the bytes.
- `reject_recorded_identities` (`lib.rs:3111-3119`) converts a recorded
  `ExistingIdentity` scan into a refusal, and is called inside a fenced
  transaction after an authoritative existence check. Nine call sites use it.

### Already closed: the claim mirror

`claim_mirror.rs` has no `reject_recorded_identities` call, which two comments
cited as proof the decision is unguarded. It defers the classification itself
instead, which is equally sound:

- `replace_claim_mirror_snapshot`: `write.execute` opens the transaction at
  `claim_mirror.rs:897`, `let tx = coordinated.tx();` at `:898`,
  `existing_claim_ids_tx(tx, incarnation)?` at `:899`, and the
  `identity`-versus-`existing_identity` branch at `:902-905` — all inside the
  closure.
- `apply_claim_mirror_receipt`: the same shape at `:1067` and `:1070-1073`.
- `existing_claim_ids_tx` at `:339` takes `&rusqlite::Transaction`, so it cannot
  be called outside one.

Both comments were read against an earlier revision.

### Live: `commit_transform`

Before the change:

- `let existing_session = self.inner.with_conn(..)` read
  `EXISTS(SELECT 1 FROM mc_cache_state WHERE session_id = ?1)`.
- The `identity`-versus-`existing_identity` branch followed immediately.
- `write.execute` opened the fenced transaction ~130 lines later.

`with_conn` and `with_conn_fenced` each acquire and release
`SqliteStore::conn` (`cortexkit-store:144-152`, `:170-176`), so the mutex
serializes each call but not the read-then-write sequence. Two threads sharing
one `McStore` can interleave.

Reachability past the CAS is the discriminating question. The in-transaction CAS
at `lib.rs:9660-9666` is:

```rust
let cas_ok = match expected {
    None => current == NO_ROW,
    Some(v) => current == v as i64,
};
```

The dangerous combination needs a stale `existing_session = true` (lenient) plus
a genuine insert (`current == NO_ROW`). With `expected: Some(v)` a vanished row
fails the CAS, so the write is refused anyway. The hole was therefore
`expected: None` combined with a row present at classification time and absent at
write time, which `delete_session` constructs by deleting from every table with a
`session_id` column.

Cross-process interleaving is not available: `open_sqlite` holds an exclusive
single-writer lease for the store's lifetime (`cortexkit-store:100-106`), and
`for_test` exists because the OS lock prevents a second connection through the
supported path (`cortexkit-store:117-119`).

### Live: `with_facade_command`

Before the change, the same out-of-transaction read decided the policy for `tool`
and `action`, and `identity_scope` was always strict. The fenced transaction
queried the ledger only by the full key including `command_id`, for duplicate
replay, so it never observed whether the `(identity_scope, tool, action)` triple
was already stored.

## Change

Both sites now prepare every affected identity as `ExistingIdentity` and defer the
refusal into the transaction:

- `commit_transform`: `lib.rs:9487` prepares, `lib.rs:9670-9677` rejects when
  `current == NO_ROW` after the CAS passes.
- `with_facade_command`: `lib.rs:6765-6770` prepares `tool`, `action`, and
  `identity_scope`; `lib.rs:6820-6840` reads the triple inside the transaction and
  rejects when no row carries it.

The property now holds structurally, so it no longer depends on the
`expected: None` reachability argument. The `commit_transform` change also removes
one connection acquisition.

## Oracle

`cache_state_identity_decision_comes_from_the_write_transaction`
(`lib.rs:17309`) asserts both branches at the `commit_transform` site: a first
insert of a detected `session_id` returns `SecretDetected` and leaves no row, and
a grandfathered row seeded by raw SQL replays and keeps its bytes verbatim.

Mutation backstop, both killed at the intended assertion:

- replacing the `current == NO_ROW` gate with `false` (never reject) fails the
  first branch.
- replacing `existing_identity` with `identity` at `lib.rs:9487` (always strict)
  fails the replay branch, because `NewIdentity` refuses during `prepare_field`.

An earlier mutation run reported the always-strict mutant as surviving. That was a
misapplied mutation: 16 lines in the file read
`write.existing_identity("session_id", session_id)?;` and a first-occurrence
replacement hit `lib.rs:7880` instead of the site under test. Line-targeted
mutation kills it.

## Limits

The test pins both branches of the contract but does not construct the
interleaving, so it would not fail if a future change reintroduced an
out-of-transaction classification whose stale decision is only reachable under the
race. The facade site has no test at all. `OQ-H1` records both gaps.
