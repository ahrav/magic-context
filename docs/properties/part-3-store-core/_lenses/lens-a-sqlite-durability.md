# Lens A: SQLite durability, transactions, schema, migrations

Attention focus: what an acknowledged write promises, where transactions begin
and end, how `SQLITE_BUSY` is handled, and whether schema and migrations are
all-or-nothing. Other failure families are out of scope except where they
intersect durability.

System `/local/home/ahrav/scratch/magic-context` at `ed487e11`. Every line
reference below was read at that revision.

One boundary note that shapes the whole lens. The PRAGMAs, the transaction
primitive, and the migration runner are **not** in this repository. They live in
`cortexkit-store`, resolved by `Cargo.toml:16` to
`../commons/crates/cortexkit-store` (789 lines, absolute path
`/local/home/ahrav/scratch/commons/crates/cortexkit-store/src/lib.rs`). That
file is read-only context for this lens: it is the durability contract, and
`mc-store` only consumes it. Citations to it are marked `cortexkit-store:NNN`.

`crates/mc-core` (1,518 lines) and `crates/mc-tokenizer` (85 lines) contain no
SQLite, no `rusqlite`, and no SQL. Verified by content search across both `src`
trees. They contribute nothing to this lens.

## lib.rs structure map

`crates/mc-store/src/lib.rs`, 20,650 lines. Top-level regions with verified
line ranges, so every citation below is anchored.

| Lines | Region |
| --- | --- |
| 1-13 | Crate doc comment: states the epoch-fence plus `row_version` CAS contract |
| 16-17 | `pub mod claim_mirror;` and `pub mod sqlite_runtime;` |
| 19-41 | Imports, including `cortexkit_store::{open_sqlite, Migration, SqliteStore, StoreError}` at 20 |
| 43-56 | `canonical_root` |
| 59-399 | Wire and block value types: `HarnessMeta` 59, `CkWireMessage` 86, `CkWireBlock` 192, `CkKind` 268, `CkToolOutput` 313, `CkOutputKind` 330, `ResultBlock` 357, `OpaqueBlock` 372, `MediaBlock` 381, `MediaKind` 391 |
| 401-430 | Constants and `current_time_ms`: `NS = "mc_cache"` 401, `NO_ROW = -1` 404, size caps 405-419, `current_time_ms` 425 |
| **432-1312** | **`const MIGRATIONS`** — a single `Migration`, `version: 57` at 433, one consolidated bootstrap SQL string 434-1311 |
| 1314-1342 | `LATEST_MIGRATION_VERSION` 1321-1331, `OLDEST_ADOPTABLE_MIGRATION_VERSION` 1342 |
| 1344-1385 | `recorded_mc_cache_version` 1346-1366, `refuse_pre_cutover_store` 1375-1385 |
| 1387-1411 | `normalize_authority_note_route_tx` |
| 1413-3349 | Domain DTO and state types: `HistorianPhase` 1420, `HistorianDurableState` 1461, publish request and error types 1766-1876, lineage types 1897-2071, `ModuleMeta` 2227, note types 2809-3068, claim-intent types 3071-3115, sync and import types 3250-3348 |
| 3351-3652 | Error types and conversions: `ModuleStateSyncError` 3351, `McStoreError` 3361, `Display`/`Error` impls 3447-3645, `From<StoreError> for McStoreError` 3554-3558 |
| 3654-3775 | Internal transaction-outcome enums (`CommitOutcome` 3654, `PublishTxnOutcome` 3686, `StateImportTxnOutcome` 3761) and side-channel row types 3718-3739 |
| 3776-4343 | SQL constants and free helpers: `AUTHORITY_SELECT_SQL` 3776, claim-intent helpers 3787-3962, authority helpers 3964-4197, `validate_state_import_compartments` 4199, `session_has_durable_state` 4242, `validated_seed_boundary` 4272 |
| 4345-4608 | Facade scope guards and `FacadeMutationTxn` 4388-4608 |
| 4610-4634 | `pub struct McStore` |
| 4636-4808 | Drop-seed and strip-seed materializers |
| **4810-12234** | **`impl McStore` block 1.** `open` 4816-4905, `prune_transform_session_roots` 4907-4929, `repair_note_artifacts_v51` 5069-5114, `with_note_conn_fenced` 5323-5343, `module_store_schema_version` 5348-5358, `delete_session` 5432-5475, `load` 5481, `load_transform_snapshot_with_hook` 5526, `load_session_status_snapshot` 5658, `set_todo_state` 6727-6757, `arm_soft_refresh` 6760-6778, `preflight_state_import` 7114-7139, `commit_state_import` 7145-7205, `commit` 7215-7223, `commit_with_consumed_drops` 7226-7257, `commit_transform` 7260-7609, `apply_state_sync` 7617, lineage 8177-8854, compartment writes 8887-9193, historian publish and outbox 9194-9798, notes 10033-11xxx, claim intent and mirror 11xxx-12232 |
| 12236-12825 | Free `*_tx` writer helpers and compression: `write_seed_compartment_tx` 12236, `insert_compartment_tx` 12352, `insert_historian_events_tx` 12388-12409, outbox helpers 12411-12607, `append_compartments_tx` 12609, transcript helpers 12671-12825 |
| 12827-13158 | Note SQL constants, row mappers, note-eval helpers |
| **13160-13707** | **`impl McStore` block 2** — note-evaluation claim lifecycle (acquire, renew, complete, abandon) |
| 13709-13930 | `rebind_note_eval_claim_tx` 13714, `note_check_digest` 13765, `repair_note_artifacts_tx` 13782, misc helpers to 13930 |
| 13932-19420 | `#[cfg(test)] mod tests` |
| 19422-19980 | `#[cfg(test)] mod shadow_tests` |
| 19982-20650 | `#[cfg(test)] mod lineage_descent_tests` |

Production code is therefore lines 1-13930. Everything at 13932 and beyond is
test code. That matters for reachability labelling: several of this lens's
findings are about code that exists but has no production caller.

## Observations

### Where PRAGMAs are actually set

`cortexkit-store:265-327` `open_sqlite` is the only place any PRAGMA is applied
to the real database file. It sets exactly three:

- `cortexkit-store:287` `journal_mode = WAL`
- `cortexkit-store:289` `busy_timeout(Duration::from_secs(5))`
- `cortexkit-store:291` `foreign_keys = ON`

Then `cortexkit-store:317-320` tightens file mode on the main file, `-wal`, and
`-shm`, deliberately after the WAL pragma so the siblings exist.

`synchronous` is never set. Not in `open_sqlite`, not in `McStore::open`, not
anywhere in `crates/mc-store/src`. A content search for `PRAGMA` across
`crates/` returns only: `lib.rs:5453` (a `PRAGMA table_info` introspection call
inside `delete_session`), the constant doc comments and the four verifier reads
in `sqlite_runtime.rs`, and three test files. There is no `wal_autocheckpoint`,
no `wal_checkpoint`, no `journal_size_limit`, and no `synchronous` anywhere.

### What `McStore::open` does

`lib.rs:4816-4905`, in order:

1. 4817 `open_sqlite(descriptor)` — acquires the single-writer file lease
   (`cortexkit-store:279-282`) before opening, then applies the three PRAGMAs.
2. 4825-4872 registers four scalar UDFs on the connection, before migrations,
   because migration triggers call them.
3. 4873 `refuse_pre_cutover_store(&inner)`.
4. 4874 `inner.migrate(NS, MIGRATIONS)`.
5. 4878-4881 sets the prepared-statement cache to 128.
6. 4902 `store.repair_note_artifacts_v51()`.
7. 4903 `store.prune_transform_session_roots()`.

It does **not** call `verify_sqlite_connection_contract`, does not set
`PRAGMA application_id`, does not set `PRAGMA user_version`, and does not create
or read a `mc_format_marker` row.

### Transaction primitives in use

Three, and only three.

- `SqliteStore::with_conn` (`cortexkit-store:155-161`) — raw `&Connection`
  under the store mutex, no transaction. 73 call sites in production
  `lib.rs`.
- `SqliteStore::with_conn_fenced` (`cortexkit-store:185-233`) — the write path.
  `cortexkit-store:191` uses `TransactionBehavior::Immediate`, so the write lock
  is taken at `BEGIN`, not deferred to the first write. It lazily creates
  `cortexkit_fence` (194-199), reads the stored epoch (203-209), rejects a
  superseded writer with `StoreError::Fenced` (211-218), claims the epoch when
  newer (219-227), runs the closure (229), and commits (230-231). Any `Err`
  from the closure returns early and the `Transaction` rolls back on drop. 40
  call sites in production `lib.rs`, plus the `with_note_conn_fenced` wrapper
  at `lib.rs:5323-5343`.
- `conn.unchecked_transaction()` — three sites, all read-only multi-statement
  snapshots: `lib.rs:5532` (`load_transform_snapshot_with_hook`), `lib.rs:5664`
  (`load_session_status_snapshot`), `lib.rs:8862`
  (`load_m1_revision_snapshot`). These are DEFERRED, never committed, and drop
  to rollback. For a read snapshot in WAL that is correct: the snapshot is
  pinned from the first read.

No savepoints. No nested transactions. No `BEGIN` string anywhere in production
code (the only match, `lib.rs:16711`, is a test assertion message).

### Multi-transaction methods

A scan of every production `fn` for bodies containing two or more
`with_conn`/`with_conn_fenced` calls returns exactly three:

- `lib.rs:4816-4906` `open` — two `with_conn` calls, UDF registration and
  statement-cache sizing. Neither is a durable write.
- `lib.rs:5069-5117` `repair_note_artifacts_v51` — three `with_conn` plus one
  fenced loop. This is a genuine read-modify-write spanning transactions; see
  below.
- `lib.rs:9662-9719` `deliver_historian_side_channel` — three
  `with_conn_fenced` calls, but they are **mutually exclusive match arms**
  (9684, 9697, 9706), one per side-channel kind. Each arm does the domain
  insert and `mark_historian_side_channel_delivered_tx` in the *same*
  transaction. This is a correct transactional-outbox shape, not a split
  read-modify-write.

### Read-modify-write sequences not inside one transaction

Four, with different degrees of protection.

1. `lib.rs:5069-5114` `repair_note_artifacts_v51`. Reads a completion flag
   (5071-5077), runs batched repairs each in its own fenced transaction
   (5097-5103), then inserts the flag in a *fourth*, separate transaction
   (5105-5112). The flag row is a sentinel written into `mc_cache_state` with
   `session_id = "note_artifact_repair_v51_done"`. The comment at 5093-5096
   states the batching is deliberate so a kill mid-repair keeps completed work.
   Idempotence rests on the driving query at 5083-5085 re-selecting only
   unrepaired rows.

2. `lib.rs:6727-6757` `set_todo_state`. `self.load()` in its own read
   transaction (6736), mutate in memory (6742-6745), `self.commit()` in a
   separate fenced transaction (6746). Guarded by the `row_version` CAS and a
   bounded loop of 8 attempts; exhaustion returns the last `CasConflict`, or a
   `Serde` error at 6754-6756 if none was recorded. The comment at 6725-6726
   states the CAS is what makes the split safe.

3. `lib.rs:6760-6778` `arm_soft_refresh`. Same shape, same 8-attempt bound,
   same CAS guard.

4. `lib.rs:7114-7139` `preflight_state_import` reads the completed-import row
   and the emptiness predicate in one read transaction, and the caller then
   invokes `commit_state_import`. This one is safe by construction because
   `commit_state_import` **re-evaluates both predicates inside its own fenced
   transaction**: the completed-import lookup at 7153-7159 and
   `session_has_durable_state(tx, session_id)` at 7170. The comment at
   7167-7169 says so explicitly. The preflight is an advisory fast path, not
   the decision point.

`commit_transform` is the exemplary case: `lib.rs:7352` opens the fenced
transaction, 7354-7357 reads the current `row_version` inside it, 7358-7382
decides conflict, 7390-7397 does the `INSERT ... ON CONFLICT` upsert, and every
overlay write (7474-7586) is in the same transaction, returning
`CommitOutcome::Committed` at 7598. The predicate and the writes never split.

### Migrations

`MIGRATIONS` (`lib.rs:432-1312`) is a single `Migration` with `version: 57`
(433) and one SQL string. It is a consolidated bootstrap, not an incremental
chain; `lib.rs:1336-1341` says so and explains the consequence: applying it over
a populated schema fails on the first `CREATE TABLE`.

`LATEST_MIGRATION_VERSION` (1321-1331) is computed from the array at compile
time, and `OLDEST_ADOPTABLE_MIGRATION_VERSION` (1342) is defined equal to it, so
the adoptable window is exactly one version wide.

The runner is `cortexkit-store:336-385` `run_migrations`. Structure:

- 341-349 `CREATE TABLE IF NOT EXISTS cortexkit_schema_version(namespace,
  version, applied_at_unix, PRIMARY KEY (namespace, version))` — **outside any
  transaction**.
- 351-357 `SELECT COALESCE(MAX(version), 0) ... WHERE namespace = ?1` —
  **outside any transaction**.
- 359-360 sorts by version.
- 362-383 per migration above `current`: `conn.transaction()` (366, DEFERRED),
  `tx.execute_batch(m.statements)` (369), `INSERT INTO
  cortexkit_schema_version` (375-380), `tx.commit()` (381).

So a migration and the record that it ran do commit together, and a crash
mid-migration leaves it unrecorded so it re-runs. The doc comment at 329-332
states exactly this. Two caveats: the version table creation and the current-
version read are not in the transaction, and the per-migration `BEGIN` is
DEFERRED rather than IMMEDIATE.

The schema version is stored in `cortexkit_schema_version`, keyed by
`(namespace, version)`, and read as `MAX(version)`. It is **not** stored in
`PRAGMA user_version`. `lib.rs:5348-5358` `module_store_schema_version` reads
`MAX(version)` for namespace `mc_cache`.

`refuse_pre_cutover_store` (`lib.rs:1375-1385`) calls
`recorded_mc_cache_version` (1346-1366), which first checks whether
`cortexkit_schema_version` exists in `main.sqlite_schema` (1348-1358), then
reads `MAX(version)` (1359-1363) and maps `0` to `None` via
`filter(|v| *v > 0)`. A recorded version strictly below 57 is refused with
`McStoreError::PreCutoverModuleStore`. `None` — a fresh file, or one predating
the version table — falls through to `Ok(())` and the bootstrap runs.

### `SQLITE_BUSY`

- `busy_timeout` is 5 seconds, set once per connection at
  `cortexkit-store:289`.
- There is no application-level retry loop for busy. A content search across
  production `lib.rs` for `busy`, `Busy`, `retry`, `SQLITE_BUSY`, and
  `DatabaseBusy` finds only: an index name in the migration SQL (790),
  `NoteEvalAcquireOutcome::Busy` (2999) and `HistorianBusy` (3355, 3626, 4332,
  7663, 7925) which are domain-level lease-contention outcomes, not SQLite
  busy, and the two CAS retry loops (6755, 6776).
- Writer-writer conflict is prevented at two layers before SQLite sees it: the
  exclusive file lease acquired in `open_sqlite`
  (`cortexkit-store:279-282`, rejecting a second live writer with
  `StoreError::Lease`), and the process-local `Mutex<Connection>` taken by
  `with_conn` and `with_conn_fenced` (`cortexkit-store:159, 189`). Within one
  process, two writers cannot both be inside `BEGIN IMMEDIATE`.
- An out-of-band writer that bypasses the lease *does* hit real busy. The test
  at `lib.rs:16697-16713` proves it: a second raw `Connection` with
  `busy_timeout(ZERO)` gets `ErrorCode::DatabaseBusy` while a fenced
  transaction is open.
- When busy does surface, the code path is: `rusqlite::Error` →
  `StoreError::Backend(e.to_string())` (`cortexkit-store:192, 199, 209, 226,
  229, 231`) → `McStoreError::Store` (`lib.rs:3554-3558`). The error **code is
  discarded into a string**. No caller can classify the failure as retryable.

## Durability contract

Stating it plainly, because the pieces are spread across two crates.

**Journal mode.** WAL, set at `cortexkit-store:287`. Verified as an expectation
by `sqlite_runtime.rs:123-126`.

**Synchronous level.** Never set by any code in either crate. The connection
therefore runs at the compile-time default `SQLITE_DEFAULT_SYNCHRONOUS`, which
is `FULL` (2) in an unmodified SQLite build. The engine is the `bundled` build
from `rusqlite = { version = "0.32", features = ["bundled"] }`
(`Cargo.toml:32`), resolving to `libsqlite3-sys 0.30.1` (`Cargo.lock`), whose
vendored `sqlite3.h` declares `#define SQLITE_VERSION "3.46.0"`. I did not find
a build-flag override and did not execute a query against the built engine, so
the effective value is an inference from the absence of any setter plus the
upstream default. It is recorded as an open question rather than as fact.

**What an acknowledged write promises.** A successful return from
`with_conn_fenced` means `tx.commit()` succeeded (`cortexkit-store:230-231`),
which in WAL means the commit frame plus commit record are in the `-wal` file.
Under `synchronous=FULL` that is fsynced, so the write survives both process
crash and power loss. Under `synchronous=NORMAL` it survives process crash but
not power loss. Since nothing declares the level, the promise the code makes is
whatever the build default happens to be. That gap is the core finding of this
lens.

**Checkpointing policy.** None is configured. No `wal_autocheckpoint`, no
manual `wal_checkpoint`, no `journal_size_limit`. The database runs on SQLite's
default 1000-page autocheckpoint. Nothing in the codebase forces a checkpoint at
shutdown or on a schedule. The three `unchecked_transaction` read snapshots
(5532, 5664, 8862) pin the WAL for their duration, and
`load_transform_snapshot_with_hook` takes an `after_state_read` callback (5529)
that runs while the snapshot is open, which is a caller-controlled hold.

**Foreign keys.** `ON`, set at `cortexkit-store:291`. The migration SQL relies
on it: `mc_claim_mirror_claims` declares `FOREIGN KEY ... ON DELETE CASCADE`
(1291-1294) and several other tables do the same.

**The verifier that is not wired in.** `sqlite_runtime.rs:113-140`
`verify_sqlite_connection_contract` checks precisely the four things the runtime
contract in `docs/migration-version-lanes.md:47-51` promises: foreign keys
enabled (119-122), WAL activation (123-126), busy timeout at or above a minimum
(127-132), and synchronous in the declared set (133-138). A content search for
its name finds two call sites, both in `crates/mc-store/tests/sqlite_runtime.rs`
(183, 189, 194). The same holds for `evaluate_sqlite_runtime_gate` and
`probe_sqlite_engine_identity_off_path`: test-only. The entire module is a
correct implementation with no production caller.

**The WAL-reset gate the shipped engine fails.**
`sqlite_runtime.rs:23-25` declares `SQLITE_WAL_RESET_SAFE_MIN_VERSION =
[3, 47, 1]`, citing the upstream WAL-reset bug.
`evaluate_sqlite_runtime_gate` (92-108) fails any engine below it. The bundled
engine is 3.46.0. This is not an inference: `Cargo.toml:29` says so in a
comment, and the test at `tests/sqlite_runtime.rs:139-169` *asserts the failing
branch*, expecting exactly `"SQLite 3.46.0 predates the WAL-reset fix in
3.47.1"`. So the crate declares a durability precondition, ships an engine that
violates it, and never evaluates the gate on the production open path.

## Candidate properties

### acknowledged-commit-survives-process-crash

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:16927` `historian_side_channel_outbox_recovers_after_restart` and `lib.rs:14717` `first_application_marker_is_atomic_and_survives_reopen` reopen the store in-process after a clean drop. Neither kills a process mid-commit.
Guarantee: When `with_conn_fenced` returns `Ok`, the committed rows are present after the process is killed without cleanup and the store is reopened.
Check: `always` — for every fenced write that returned `Ok`, after `SIGKILL` and reopen, the row is readable with the committed `row_version`. `always` because every acknowledged write makes this promise; there is no path on which the promise is conditional.
Fault/timing angle: the window is between `tx.commit()` returning at `cortexkit-store:230-231` and the caller observing `Ok`. A kill inside `commit()` must yield either the whole transaction or none of it, which is SQLite's contract, not this code's. The code-level risk is the missing `synchronous` declaration: at `NORMAL` the commit is in the WAL but unfsynced, so a process kill is survived and a power loss is not.
Required faults and enabling state: `SIGKILL` to the writer between commit and acknowledgement, then reopen through `McStore::open`. To separate process crash from power loss the test needs a second variant that loses the page cache, which a user-space test cannot do; that variant needs `dm-flakey` or equivalent.
Confidence: high on the transaction shape, low on the power-loss half — [evidence](../evidence/acknowledged-commit-survives-process-crash.md). Verified `with_conn_fenced` commits at `cortexkit-store:230-231` and that no `synchronous` pragma exists in either crate.
Existing check: `lib.rs:16189` `state_import_is_atomic_bootstrap_only_and_durably_idempotent` and `lib.rs:16927` cover reopen-after-clean-drop. Status `unaudited`.
Impact: an acknowledged commit that vanishes makes the `row_version` CAS unsound across restart, because the caller's cached expectation no longer matches durable state.
Open questions:
- Does the `libsqlite3-sys 0.30.1` bundled build override `SQLITE_DEFAULT_SYNCHRONOUS`? Not resolved by reading; needs a query against the built engine.

### synchronous-level-is-explicitly-declared-not-inherited

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test reads `PRAGMA synchronous` from a connection produced by `McStore::open`.
Guarantee: The connection `McStore::open` returns runs at a synchronous level the code chose, not one inherited from the build's compile-time default.
Check: `always` — on a connection from `McStore::open`, `PRAGMA synchronous` equals a value some line of code set. `always` because the level governs every commit on that connection, so it must hold at every observation, not merely once at open.
Fault/timing angle: none. This is a static configuration property. The interesting part is the interaction with the verifier: `sqlite_runtime.rs:133-138` accepts any value in `1..=3`, and `1` is `NORMAL`, which in WAL mode does not fsync on commit. So the verifier as written would pass a connection that cannot survive power loss, while `docs/migration-version-lanes.md:50` calls this a "declared synchronous mode".
Required faults and enabling state: none. Open a store and read the pragma.
Confidence: high — [evidence](../evidence/synchronous-level-is-explicitly-declared-not-inherited.md). Verified by exhaustive content search for `synchronous` across `crates/` and `cortexkit-store/src/lib.rs`: the only occurrences are the verifier reads at `sqlite_runtime.rs:133-138`, its doc comment at 112, and two test lines.
Existing check: `crates/mc-store/tests/sqlite_runtime.rs:192-200` proves the verifier rejects `synchronous=OFF`, on a hand-built connection. It never inspects a `McStore` connection. Status `unaudited`.
Impact: the durability class of every acknowledged write is decided by the dependency's build flags rather than by this project, and a future toolchain change can silently downgrade it.
Open questions:
- Is `NORMAL` intended to be acceptable? If yes the doc's durability language needs narrowing to process-crash survival; if no the verifier's accepted set is wrong. (needs human input)

### bundled-engine-satisfies-the-declared-wal-reset-precondition

Type: safety
Reachability: default-production
Status: active
Exercised: yes — `crates/mc-store/tests/sqlite_runtime.rs:139-169` probes the live engine and asserts the *failing* branch, expecting `"SQLite 3.46.0 predates the WAL-reset fix in 3.47.1"`.
Guarantee: The SQLite engine compiled into the shipping binary is at or above `SQLITE_WAL_RESET_SAFE_MIN_VERSION`, the version the crate declares as the minimum for safe WAL reset.
Check: `always` — `parse_dotted_version(sqlite_version()) >= [3, 47, 1]` for the engine actually linked. `always` rather than `reachable`, because the precondition governs every WAL reset the database performs, not one code point.
Fault/timing angle: the vulnerable event is a WAL reset, which happens when the WAL wraps after a checkpoint. With no checkpoint policy configured, resets occur on the default 1000-page autocheckpoint cadence, so the exposure is routine rather than rare.
Required faults and enabling state: no fault needed to observe the version mismatch. To observe a consequence a test would need to drive enough write volume to wrap the WAL repeatedly with a concurrent reader.
Confidence: high — [evidence](../evidence/bundled-engine-satisfies-the-declared-wal-reset-precondition.md). Verified three ways: `Cargo.toml:29` states 3.46.0, `Cargo.lock` pins `libsqlite3-sys 0.30.1`, and that crate's vendored `sqlite3/sqlite3.h:149` declares `#define SQLITE_VERSION "3.46.0"`.
Existing check: `tests/sqlite_runtime.rs:139-169`, which encodes the violation as the expected outcome. That is an accurate regression pin for today's state, not a guarantee. Status `unaudited`.
Impact: the crate has written down a durability precondition and ships a build that does not meet it. Whatever the WAL-reset bug can do to this database, it can do today.
Open questions:
- `Cargo.toml:30` says raising `rusqlite` requires bumping `cortexkit-store` in the same change. Is that coordinated bump tracked anywhere? (needs human input)

### wal-reset-gate-runs-on-the-production-open-path

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — the gate has no production caller to exercise.
Guarantee: `evaluate_sqlite_runtime_gate` is evaluated against the real engine identity before `store.db` is opened for writing, so an unsafe engine is refused rather than used.
Check: `reachable` — the gate call site must execute on the `McStore::open` path. `reachable` because this is location coverage: the question is whether a specific code point is entered at all, and today it is not.
Fault/timing angle: none. The check either runs at open or does not.
Required faults and enabling state: none. Instrument `evaluate_sqlite_runtime_gate` and call `McStore::open`.
Confidence: high — [evidence](../evidence/wal-reset-gate-runs-on-the-production-open-path.md). Verified that `McStore::open` (`lib.rs:4816-4905`) contains no call, and that a content search for `evaluate_sqlite_runtime_gate` and `probe_sqlite_engine_identity_off_path` across the repository finds definitions in `sqlite_runtime.rs:45, 92` and call sites only in `crates/mc-store/tests/sqlite_runtime.rs`.
Existing check: none in production. The test file exercises the function directly. Status `unaudited`.
Impact: `docs/migration-version-lanes.md:41-44` says "Bun and Node writers probe an approved WAL-reset-safe SQLite source on an off-path database. The root Rust module applies the same rule to `store.db`." The Rust half of that sentence is not implemented.
Open questions:
- Would wiring the gate in today make `McStore::open` fail outright, given the engine is 3.46.0? If so the gate cannot be enabled before the version bump, and the doc claim should be marked pending rather than current. (needs human input)

### connection-contract-is-verified-on-the-production-connection

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — verified only on hand-built test connections.
Guarantee: `verify_sqlite_connection_contract` runs against the connection `McStore::open` produces, so a store whose PRAGMAs did not take effect is refused.
Check: `reachable` — the verifier call site must execute on the `McStore::open` path with the store's own connection. `reachable` because it is location coverage for a specific code point that must be entered.
Fault/timing angle: none for the reachability question. The failure it would catch is a PRAGMA that silently did not apply, for example `journal_mode = WAL` being refused on a filesystem that cannot support shared memory, which returns the prior mode rather than erroring.
Required faults and enabling state: none for reachability. To make the check meaningful, a store opened on a filesystem where WAL cannot be enabled.
Confidence: high — [evidence](../evidence/connection-contract-is-verified-on-the-production-connection.md). Verified `McStore::open` has no call, and the only call sites are `crates/mc-store/tests/sqlite_runtime.rs:183, 189, 194`.
Existing check: `tests/sqlite_runtime.rs:171-202` proves the verifier's own logic on a connection the test configures by hand. It does not test any `McStore` connection. Status `unaudited`.
Impact: `docs/migration-version-lanes.md:47-51` promises that "Application connections verify: foreign keys enabled, WAL activation, configured busy timeout, declared synchronous mode." No application connection in this crate verifies any of the four.
Open questions:
- `cortexkit-store:287` uses `pragma_update` for `journal_mode`, which discards the returned mode. Does that mask a refused WAL activation? Not resolved; needs a test on a filesystem that rejects WAL.

### failed-fenced-transaction-leaves-no-partial-state

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `cortexkit-store:691-712` `fenced_write_rolls_back_on_error` forces a closure error after a write and asserts rollback. That is the dependency's own test, on the dependency's shape, not on any `mc-store` multi-statement writer.
Guarantee: When a closure passed to `with_conn_fenced` returns `Err` at any statement, none of its earlier statements in that transaction are durable.
Check: `always` — after any fenced write that returned `Err`, every table the closure touched is byte-identical to its pre-call state. `always` because every fenced write makes this promise unconditionally.
Fault/timing angle: the interesting closures are the multi-statement ones, where the window between the first and last statement is real: `commit_transform` writes cache state then up to eight overlay tables (`lib.rs:7390-7586`); `delete_session` deletes from every discovered table in a loop (`lib.rs:5448-5472`); `commit_state_import` inserts N compartments then the import record (`lib.rs:7177-7190`); `append_compartments_tx` (`lib.rs:12609`). An injected error must land *between* statements, not before the first.
Required faults and enabling state: an error injected at statement k of an n-statement closure, for k strictly between 1 and n. The existing `historian_side_channel_fail_once` hook (`lib.rs:9667-9678`) is the only injection point of this shape and it fires before any write.
Confidence: high on the mechanism, medium on coverage — [evidence](../evidence/failed-fenced-transaction-leaves-no-partial-state.md). Verified the early return at `cortexkit-store:229` precedes `tx.commit()` at 230, and rusqlite's `Transaction` defaults to rollback on drop.
Existing check: `cortexkit-store:691-712` in the dependency. Nothing in `mc-store` injects a mid-closure failure. Status `unaudited`.
Impact: a partially applied `commit_transform` would leave overlay tables ahead of the cache row's `row_version`, so the next CAS would accept a state the overlays already contradict.
Open questions: None.

### migration-and-its-version-record-commit-together

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test kills a process mid-migration. `cortexkit-store:528` `open_runs_migrations_and_seeds_once` and `:580` `later_migration_applies_on_top_of_earlier` cover the happy path.
Guarantee: For any migration, either its statements and its `cortexkit_schema_version` row are both durable, or neither is.
Check: `always` — after any crash and reopen, `EXISTS(row for version v)` implies every object version v creates is present, and the absence of the row implies none of them is. `always` because it must hold at every reopen.
Fault/timing angle: the window is `cortexkit-store:366-383`, between `conn.transaction()` and `tx.commit()`. A kill anywhere inside rolls the whole thing back and the migration re-runs. Two structural notes narrow the guarantee: the `CREATE TABLE IF NOT EXISTS cortexkit_schema_version` at 341-349 and the `MAX(version)` read at 351-357 are outside any transaction, so a crash between them and the first migration transaction leaves an empty version table, which is indistinguishable from a fresh database; and `conn.transaction()` at 366 is DEFERRED, so the write lock is taken at the first statement of the migration rather than at `BEGIN`.
Required faults and enabling state: `SIGKILL` during `tx.execute_batch(m.statements)` on a fresh database, then reopen. Because `MIGRATIONS` is one 878-line statement batch, the kill point is easy to hit but hard to place precisely.
Confidence: high — [evidence](../evidence/migration-and-its-version-record-commit-together.md). Verified the transaction spans both the batch (369) and the version insert (375-380) with a single `commit()` at 381.
Existing check: `lib.rs:16140` `fresh_and_current_module_stores_open_without_a_pre_cutover_refusal` and `cortexkit-store:528`. Both happy-path. Status `unaudited`.
Impact: a recorded-but-unapplied version would make `refuse_pre_cutover_store` pass a database whose schema does not exist, and the first query would fail on a missing table.
Open questions:
- Does SQLite roll back a partially executed `execute_batch` of DDL inside an explicit transaction in all cases, including implicit commits from statements that cannot run transactionally? I found no such statement in the batch, but did not enumerate all 878 lines against the list of statements that force a commit.

### recorded-schema-version-cannot-disagree-with-the-actual-schema

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:16069` `schema_version_probe_reads_the_live_store_and_matches_the_shipped_ceiling` asserts the probe equals `LATEST_MIGRATION_VERSION` on a freshly created store. It does not check that the schema objects match.
Guarantee: If `module_store_schema_version()` returns 57, every object the version-57 bootstrap declares exists in `main.sqlite_schema` with the declared shape.
Check: `always` — compare the live `main.sqlite_schema` inventory against the object set the bootstrap SQL declares. `always` because any query against the store depends on the agreement holding at that moment.
Fault/timing angle: three ways they can diverge. First, a crash between the migration commit and the post-migration repairs at `lib.rs:4902-4903`, which alter data rather than schema but are part of what version 57 is supposed to have produced. Second, an out-of-band writer that alters the schema without touching `cortexkit_schema_version`; nothing prevents this because the version lives in an ordinary table, not in `PRAGMA user_version`. Third, `recorded_mc_cache_version` mapping a recorded `0` to `None` at `lib.rs:1364`, so a database with a version row of literal `0` is treated as pristine.
Required faults and enabling state: for the out-of-band case, a raw connection that drops a table and reopens. For the third case, a store seeded with `(mc_cache, 0)`.
Confidence: medium — [evidence](../evidence/recorded-schema-version-cannot-disagree-with-the-actual-schema.md). Verified the version storage and read path at `cortexkit-store:341-357` and `lib.rs:5348-5358`. Did not build the full declared-object inventory from the 878-line bootstrap.
Existing check: `lib.rs:16069`, `lib.rs:16089` `pre_cutover_module_store_is_refused_by_family_not_by_ddl_collision`. Neither compares the inventory. Status `unaudited`.
Impact: `docs/migration-version-lanes.md:11-17` promises "an exact `main.sqlite_schema` inventory" as part of format identity and says a manifest mismatch fails closed. For `store.db` there is no inventory check, so the failure surfaces as a missing-table error at first use.
Open questions:
- `sqlite_runtime.rs:156-167` `compute_schema_manifest_digest` exists to make exactly this comparison cheap. Is there a plan to wire it into `McStore::open`? (needs human input)

### post-migration-open-repair-is-resumable-and-effect-idempotent

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:18124` `note_artifact_repair_verifies_digest_or_clears_compiled_state` and `lib.rs:18905` `v51_repair_keeps_a_legacy_artifact_that_has_no_recorded_digest` cover the repair's semantics. Neither kills the process between a batch commit and the flag insert.
Guarantee: `repair_note_artifacts_v51` produces the same final state whether it runs once to completion or is killed and restarted any number of times, and it never advances a note revision.
Check: `always-or-unreached` — the repair body only runs while the sentinel flag row is absent, so on most opens it is skipped entirely; when it does run it must be idempotent. `always-or-unreached` rather than `always` precisely because the skip at `lib.rs:5078-5080` makes the path optional.
Fault/timing angle: two windows. Between a batch commit at `lib.rs:5099` and the next loop iteration, restart re-selects only unrepaired rows via `compiled_source_revision IS NULL` at 5084, so work already done is not redone. Between the last batch and the flag insert at 5105-5112, restart re-runs the whole selection, finds nothing, and inserts the flag. Both are safe by re-selection, not by transaction.
Required faults and enabling state: a store with more than `NOTE_ARTIFACT_REPAIR_BATCH` (500, `lib.rs:2948`) unrepaired note rows spread across at least two projects, and a kill after the first batch commits.
Confidence: high — [evidence](../evidence/post-migration-open-repair-is-resumable-and-effect-idempotent.md). Verified the flag read (5071-5077), the batch loop (5097-5103), and the separate flag-insert transaction (5105-5112) are four distinct transactions, and that the driving query filters on `compiled_source_revision IS NULL`.
Existing check: `lib.rs:18124`, `lib.rs:18905`, `lib.rs:18072` `migration_v51_backfill_initializes_revisions_and_normalizes_check_status`. Status `unaudited`.
Impact: a non-idempotent repair would either advance note revisions on every boot, invalidating downstream compiled artifacts, or loop forever on a row it cannot repair.
Open questions:
- The completion flag is a sentinel row in `mc_cache_state` with `session_id = "note_artifact_repair_v51_done"` (`lib.rs:5070, 5107-5109`). `delete_session` (`lib.rs:5432`) deletes by `session_id` across every table with that column. Can any caller pass the sentinel key and clear the flag? Not resolved; needs a caller audit outside this lens's scope.

### busy-timeout-expiry-aborts-cleanly-without-partial-effect

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:16697-16713` proves a competing raw writer receives `SQLITE_BUSY` while a fenced transaction holds the write lock, using `busy_timeout(ZERO)`. Nothing exercises the 5-second expiry on the store's own connection.
Guarantee: When a statement inside a fenced transaction exhausts the 5-second busy timeout, the transaction is abandoned with no statement durable, and the caller receives an error rather than a silent partial write.
Check: `always` — for any fenced write that failed with an underlying `SQLITE_BUSY`, the touched tables are unchanged. `always` because the abort promise is unconditional.
Fault/timing angle: the window is the 5 seconds set at `cortexkit-store:289`. Because `with_conn_fenced` uses `BEGIN IMMEDIATE` (`cortexkit-store:191`), the write lock is taken at `BEGIN`, so busy is much more likely to be reported by `BEGIN` than by a mid-transaction statement. That is the safer failure: nothing has been written yet. Mid-transaction busy requires a reader that arrives after `BEGIN` and blocks a checkpoint or page write.
Required faults and enabling state: a lock holder outside the file lease, held for longer than 5 seconds, contending with a multi-statement fenced write. `lib.rs:16697` already builds the out-of-band writer; the test needs it to hold rather than fail fast.
Confidence: medium — [evidence](../evidence/busy-timeout-expiry-aborts-cleanly-without-partial-effect.md). Verified there is no retry loop anywhere in production `lib.rs`, and that the error path returns before `tx.commit()`. Did not construct a mid-transaction busy.
Existing check: `lib.rs:16697-16713`. Status `unaudited`.
Impact: because `StoreError::Backend(e.to_string())` (`cortexkit-store:229`) discards the SQLite error code, a busy failure reaches the caller as an opaque string. The caller cannot tell a retryable lock contention from a corrupt database, so it will either retry a permanent failure forever or surface a transient one as fatal.
Open questions:
- Is `IMMEDIATE` on every fenced write, including read-mostly ones, taking the write lock more often than needed and manufacturing contention that a `DEFERRED` read path would avoid? Not measured.

### bounded-cas-retry-never-duplicates-an-effect

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:14153` `boundary_divergence_counter_cas_loser_does_not_double_increment_and_survives_reopen` covers a different CAS site. No test drives `set_todo_state` or `arm_soft_refresh` through a losing attempt.
Guarantee: The read-modify-write loops in `set_todo_state` and `arm_soft_refresh` terminate within 8 attempts and apply their effect at most once, even when every intermediate attempt loses the CAS.
Check: `always` — attempt count never exceeds 8, and the observed effect count for one logical call is exactly 0 or 1. `always` because both bounds must hold on every call.
Fault/timing angle: the window is between `self.load()` (`lib.rs:6736`, `6763`) and `self.commit()` (`6746`, `6769`), which are separate transactions. A concurrent transform committing in that window bumps `row_version` and the CAS rejects, so the loop re-reads. The loop is what makes the split safe, per the comment at `lib.rs:6725-6726`. Two things make an effect non-duplicable: `set_todo_state` short-circuits to `Noop` when the owner and hash already match (6737-6741), and `arm_soft_refresh` short-circuits when the flag is already set (6764-6766).
Required faults and enabling state: 8 or more successful competing commits landing between one caller's load and commit. A test needs a hook in the load-to-commit window; `set_before_max_compartment_end_read_hook` (`lib.rs:5283`) is the existing hook of this shape but on a different path.
Confidence: high — [evidence](../evidence/bounded-cas-retry-never-duplicates-an-effect.md). Verified both loops are `for _ in 0..8` (6735, 6762), both short-circuit before writing, both convert exhaustion into an error at 6754-6756 and 6775-6777.
Existing check: `lib.rs:14153` for a sibling CAS site. Status `unaudited`.
Impact: exhaustion returns `McStoreError::Serde` with a prose message (`lib.rs:6755, 6776`), which is a misclassification: a contention outcome surfaces as a serialization error, so a caller cannot retry it correctly.
Open questions:
- Why 8? No comment justifies the bound, and there is no backoff between attempts, so a steady writer can starve the loop deterministically. (needs human input)

### write-predicates-are-re-evaluated-inside-the-write-transaction

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:16189` `state_import_is_atomic_bootstrap_only_and_durably_idempotent` covers the import path's idempotence. No test races a bootstrap against an import.
Guarantee: Every predicate that gates a durable write is evaluated inside the same transaction as that write, so no state observed by an earlier read transaction can change the decision.
Check: `always` — for each gated write, the predicate's read and the write share one transaction handle. `always` because a split predicate is unsound at every evaluation, not only under contention.
Fault/timing angle: the window is between a preflight read transaction and the write transaction. `commit_state_import` closes it correctly: it re-reads the completed-import row at `lib.rs:7153-7159` and re-evaluates `session_has_durable_state(tx, ...)` at 7170 inside the fenced transaction, with the comment at 7167-7169 stating why. `preflight_state_import` (`lib.rs:7114-7139`) reads the same two predicates in a separate transaction and is advisory only. `commit_transform` reads `row_version` inside the fenced transaction at `lib.rs:7354-7357` before its upsert at 7390. The two CAS loops deliberately split and compensate with the CAS. The one genuinely split predicate is `refuse_pre_cutover_store` at `lib.rs:4873`, which reads the recorded version in its own transaction, and `inner.migrate` at 4874, which re-reads it in the runner at `cortexkit-store:351-357`, also outside a transaction.
Required faults and enabling state: a second writer committing between the predicate read and the write. Within one process this is prevented by the `Mutex<Connection>` at `cortexkit-store:159, 189`; across processes it is prevented by the file lease at `cortexkit-store:279-282`. So the fault requires a writer that bypasses the lease, which is the same enabling state `lib.rs:16697` already constructs.
Confidence: high — [evidence](../evidence/write-predicates-are-re-evaluated-inside-the-write-transaction.md). Verified by scanning every production `fn` for bodies with two or more connection acquisitions; only three exist (`lib.rs:4816`, `5069`, `9662`) and the third is mutually exclusive match arms.
Existing check: `lib.rs:16189`, `lib.rs:14717` `first_application_marker_is_atomic_and_survives_reopen`. Status `unaudited`.
Impact: the codebase is in good shape here, which is worth recording as a positive invariant so a future split is caught. The residual risk is the open-path pair at `lib.rs:4873-4874`, where a database that changes family between the refusal check and the migration would be migrated after passing a check that no longer describes it.
Open questions: None.

## Contract-vs-code leads

Each of these is a documented obligation with an implementation that does not
meet it. Both sides are cited. None is resolved in the doc's favour.

1. **The Rust runtime probe is not implemented.**
   `docs/migration-version-lanes.md:41-44`: "Before opening `context.db`, Bun and
   Node writers probe an approved WAL-reset-safe SQLite source on an off-path
   database. The root Rust module applies the same rule to `store.db`."
   `probe_sqlite_engine_identity_off_path` and `evaluate_sqlite_runtime_gate`
   exist (`sqlite_runtime.rs:45, 92`) and have no production caller.
   `McStore::open` (`lib.rs:4816-4905`) does not call them.

2. **Application connections do not verify anything.**
   `docs/migration-version-lanes.md:47-51` lists four properties that
   "Application connections verify". `verify_sqlite_connection_contract`
   (`sqlite_runtime.rs:113-140`) implements exactly those four and is called
   only from `crates/mc-store/tests/sqlite_runtime.rs:183, 189, 194`.

3. **The shipped engine violates the crate's own declared minimum.**
   `sqlite_runtime.rs:23-25` declares `[3, 47, 1]`. The bundled engine is
   3.46.0 (`Cargo.toml:29`, `Cargo.lock`, and
   `libsqlite3-sys-0.30.1/sqlite3/sqlite3.h:149`). The test at
   `tests/sqlite_runtime.rs:156-168` asserts the failing verdict, so the
   violation is pinned as expected behaviour.

4. **"Declared synchronous mode" is not declared.**
   `docs/migration-version-lanes.md:50` lists a "declared synchronous mode".
   No code sets `PRAGMA synchronous`. The verifier accepts `1..=3`
   (`sqlite_runtime.rs:133-138`), and `1` is `NORMAL`, which in WAL does not
   fsync at commit.

5. **The format identity is not applied to `store.db`.**
   `docs/migration-version-lanes.md:9-17` defines the family by
   `PRAGMA application_id = 0x4d435458`, `PRAGMA user_version = 1`, one
   immutable `mc_format_marker` row, a 32-hex incarnation ID, a manifest digest,
   and an exact `main.sqlite_schema` inventory. For `store.db` none of these are
   set or checked: identity is the `cortexkit_schema_version` table's
   `MAX(version)` for namespace `mc_cache` (`cortexkit-store:351-357`,
   `lib.rs:5348-5358`). The TypeScript side does apply
   `application_id` (`packages/cli/src/commands/doctor-repair-db.ts:355`) and
   reads it (`packages/cli/src/lib/database-access.ts:262`), so the two runtimes
   identify their databases by different mechanisms.

6. **"Bootstrapped under `BEGIN IMMEDIATE`" is true for writes, not for
   migrations.** `docs/migration-version-lanes.md:30-34` says a pristine family
   is bootstrapped under `BEGIN IMMEDIATE` and that "Concurrent openers either
   observe that complete result or refuse the changed shape."
   `with_conn_fenced` does use `IMMEDIATE` (`cortexkit-store:191`), but the
   migration runner uses `conn.transaction()`, which is DEFERRED
   (`cortexkit-store:366`), and the version-table creation and current-version
   read precede any transaction (`cortexkit-store:341-357`).

7. **"Migration version ranges are not supported production inputs" is enforced
   with a one-version-wide window.** `docs/migration-version-lanes.md:82-83`
   says old ranges are historical only. The code enforces this by setting
   `OLDEST_ADOPTABLE_MIGRATION_VERSION = LATEST_MIGRATION_VERSION`
   (`lib.rs:1342`), so any recorded version other than exactly 57 is refused.
   That is stricter than the doc and worth stating: there is no forward
   compatibility either. A `store.db` written by a *newer* binary records a
   version above 57, `refuse_pre_cutover_store` does not refuse it because the
   guard is `recorded < OLDEST_ADOPTABLE` (`lib.rs:1377`), and
   `run_migrations` skips every bundled version at or below `current`
   (`cortexkit-store:363-365`). So an older binary opens a newer database
   silently and queries it with the older binary's expectations.

## Open questions

Grouped by what would resolve them.

**Resolvable by executing a query, which this lens did not do.**

- What is `PRAGMA synchronous` on a connection returned by `McStore::open`? The
  inference is `2` (`FULL`, the upstream default, since nothing sets it), but
  `libsqlite3-sys 0.30.1` build flags were not audited.
- What is `PRAGMA wal_autocheckpoint`? Inferred as the 1000-page default, since
  nothing sets it.
- Does `pragma_update(None, "journal_mode", "WAL")` at `cortexkit-store:287`
  surface a refused WAL activation as an error, or does it silently retain the
  prior mode? `journal_mode` returns the resulting mode, and `pragma_update`
  discards results.

**Resolvable by a code audit outside this lens's scope.**

- Can any caller reach `delete_session` with `session_id =
  "note_artifact_repair_v51_done"` and clear the repair completion flag?
- Does any statement in the 878-line version-57 bootstrap force an implicit
  commit, which would break the migration's all-or-nothing property?
- Is `journal_size_limit` set anywhere in the process, for example by the
  TypeScript openers on the same file? The two runtimes open different
  databases (`context.db` versus `store.db`) per
  `docs/migration-version-lanes.md:41-44`, but that separation was not verified.

**Design decisions, needing human input.**

- Is `synchronous=NORMAL` an acceptable durability class for `store.db`? The
  answer decides whether the verifier's accepted set or the doc's language is
  wrong.
- Is the `rusqlite` 0.32 to WAL-reset-safe bump tracked? `Cargo.toml:30`
  says it must be coordinated with `cortexkit-store`.
- Should the gate and the connection-contract verifier be wired into
  `McStore::open` before the engine bump? Wiring them today would presumably
  make every open fail.
- Should `store.db` adopt the `application_id` / `user_version` /
  `mc_format_marker` identity the doc describes and the TypeScript side already
  uses, or should the doc be narrowed to `context.db`?
- What should an older binary do when it opens a `store.db` recorded above 57?
  Today it proceeds silently.
- Why is the CAS retry bound 8, and why is there no backoff?
