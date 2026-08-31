# migration-and-its-version-record-commit-together

## Discovery trigger

Task 4 asked whether migrations are transactional and whether a partially applied
migration is detectable. The runner's own doc comment claims both. Reading the
code confirmed the claim for the migration body and found two statements outside
the transaction that narrow it.

## Evidence trail

The claim, in the runner's doc comment:

- `cortexkit-store/src/lib.rs:329-332`:
  "Apply un-applied migrations for one `namespace` in ascending version order,
  each in its own transaction together with its version record, so a migration
  and the record that it ran commit atomically (a crash mid-migration leaves it
  un-recorded and it re-runs cleanly next open)."

The implementation, `cortexkit-store:336-385` `run_migrations`:

- `:341-349` `CREATE TABLE IF NOT EXISTS cortexkit_schema_version (namespace
  TEXT NOT NULL, version INTEGER NOT NULL, applied_at_unix INTEGER NOT NULL,
  PRIMARY KEY (namespace, version))`, issued with `conn.execute_batch`, **not
  inside a transaction**.
- `:351-357` `SELECT COALESCE(MAX(version), 0) FROM cortexkit_schema_version
  WHERE namespace = ?1` into `current`, **not inside a transaction**.
- `:359-360` collects and sorts by version.
- `:362-383` per migration: skip when `m.version <= current` (`:363-365`);
  `conn.transaction()` (`:366-368`); `tx.execute_batch(m.statements)`
  (`:369-374`); `INSERT INTO cortexkit_schema_version (namespace, version,
  applied_at_unix) VALUES (?1, ?2, ?3)` (`:375-380`); `tx.commit()`
  (`:381-382`).

So the migration body and its version row are in one transaction with one
`commit`. The claim holds for that pair.

Two structural notes:

1. `conn.transaction()` at `:366` is **DEFERRED**. rusqlite's `transaction()`
   uses the connection's default behaviour, which is `Deferred`. Compare
   `cortexkit-store:191`, which explicitly asks for
   `TransactionBehavior::Immediate` on the write path. So the migration takes its
   write lock at the first statement of the batch, not at `BEGIN`.
2. The version-table creation and the `MAX(version)` read at `:341-357` are
   outside any transaction, so they are two separate implicit transactions.

The caller:

- `crates/mc-store/src/lib.rs:4874` `inner.migrate(NS, MIGRATIONS)?`, where
  `NS = "mc_cache"` (`lib.rs:401`).
- `cortexkit-store:243-246` `migrate` takes the store mutex and calls
  `run_migrations`.

What is being migrated:

- `lib.rs:432-1312` `const MIGRATIONS: &[Migration] = &[Migration { version: 57,
  statements: r#" ... "# }]`. One element. `version: 57` at `:433`. The SQL
  string runs `:434-1311`, so it is roughly 878 lines of DDL.
- `lib.rs:1336-1341` explains the shape: "`MIGRATIONS` is a single consolidated
  bootstrap, not an incremental chain: its statements compose the whole schema
  from an empty `main`."

## Failure scenario

The scenario the design defends against: `SIGKILL` lands partway through
`tx.execute_batch(m.statements)` at `cortexkit-store:369`. Because the version
insert at `:375-380` has not run, `MAX(version)` on reopen is still `0`, and the
whole bootstrap re-runs against an empty `main`. Clean.

The scenario it does not defend against, and which is specific to this crate: the
bootstrap is one 878-line batch that composes the *entire* schema. If any
statement in it forces an implicit commit, the transaction is split and the
remainder runs unprotected. A partially applied bootstrap then leaves tables
present with no version row. On the next open, `refuse_pre_cutover_store`
(`lib.rs:1375-1385`) sees `recorded_mc_cache_version` return `None` (because
`:1364` filters `0` to `None`), treats the database as fresh, and lets the runner
re-apply the bootstrap. The bootstrap's first `CREATE TABLE mc_cache_state`
(`lib.rs:435`) then fails with `table mc_cache_state already exists`. That is
exactly the raw error `lib.rs:1371-1372` says the pre-cutover refusal exists to
avoid, arrived at by a different route.

A second, narrower window: a crash between the version-table creation at `:341`
and the first migration transaction leaves an empty `cortexkit_schema_version`
table. That is indistinguishable from a fresh database, which is benign here, but
it means the presence of the table is not evidence that any migration ran.
`recorded_mc_cache_version` accounts for this: it checks table existence at
`lib.rs:1348-1358` *and* maps a recorded `0` to `None` at `:1364`.

## Timing windows and dependencies

- The protected window is `cortexkit-store:366` to `:381`. For this crate that is
  the duration of one 878-line DDL batch plus one insert.
- The unprotected windows are `:341` to `:351` and `:351` to `:366`. Both are
  short and both are benign given the `None`-mapping above.
- Concurrency is not a factor: `migrate` holds the store mutex
  (`cortexkit-store:244`) and `open_sqlite` already holds the exclusive file
  lease (`:279-282`), so no second writer is in the database. The DEFERRED begin
  therefore cannot produce a lock-upgrade failure in practice, though it would if
  the lease were ever relaxed.

## What a test must construct

1. A fresh temp-dir descriptor.
2. `McStore::open` in a child process, killed with `SIGKILL` during the migration
   batch. Because the batch is one call, the kill point cannot be placed
   precisely without a hook; a timing-based kill with a loop over many attempts is
   the practical approach.
3. Reopen in the parent and assert one of exactly two states: either
   `cortexkit_schema_version` has no `mc_cache` row and no bootstrap table
   exists, or it has version 57 and every bootstrap object exists. Any third
   state is a violation.

The oracle for "every bootstrap object exists" needs the declared object
inventory. `sqlite_runtime.rs:156-167` `compute_schema_manifest_digest` exists to
make exactly that comparison cheap, and is currently unused in production; see
[recorded-schema-version-cannot-disagree-with-the-actual-schema](recorded-schema-version-cannot-disagree-with-the-actual-schema.md).

A cheaper partial test that needs no process kill: wrap the migration in a
deliberately failing batch by adding an invalid trailing statement in a test-only
`Migration`, and assert no object from the earlier statements survives. That
proves the transaction spans the whole batch, which is the load-bearing half.

## Investigation log

### Q: Does any statement in the version-57 bootstrap force an implicit commit?

- Sources examined: `lib.rs:432-1312`. I read the head (`:434-450`), the tail
  (`:1290-1311`), and scanned for statement kinds. The batch is composed of
  `CREATE TABLE`, `CREATE INDEX`, and (per `lib.rs:4823-4824`, "migrations create
  triggers that call these functions") `CREATE TRIGGER`. All of those are
  transactional in SQLite.
- Findings: no `VACUUM`, no `PRAGMA journal_mode`, no `ATTACH`, and no
  `CREATE VIRTUAL TABLE` were observed in the regions I read. Those are the usual
  implicit-commit or transaction-hostile statements.
- Missing evidence: I did not enumerate all 878 lines statement by statement
  against the full list of statements that cannot run inside a transaction.
- Conclusion: unresolved, needs a mechanical scan of the batch. The probability is
  low given the statement kinds observed, but this is the single assumption the
  all-or-nothing property rests on, so it should be checked rather than assumed.

### Q: Is the DEFERRED begin at `cortexkit-store:366` a real risk?

- Sources examined: `cortexkit-store:191` for the contrasting explicit
  `Immediate` on the write path; `:243-246` `migrate` taking the mutex; `:279-282`
  the file lease acquired before the connection is opened.
- Findings: with the exclusive lease plus the process-local mutex, no other
  writer can be present, so the lock upgrade at the batch's first statement
  cannot fail with `SQLITE_BUSY_SNAPSHOT`. The asymmetry with `:191` looks like
  an inconsistency rather than a defect.
- Missing evidence: whether any deployment ever opens `store.db` outside
  `open_sqlite` and thus outside the lease. `lib.rs:16697-16713` shows a test
  doing exactly that with a raw `Connection`, so the pattern is at least
  expressible.
- Conclusion: resolved with answer — not a risk under the current lease
  invariant, but it is load-bearing on that invariant and worth noting because the
  write path does not rely on it.
