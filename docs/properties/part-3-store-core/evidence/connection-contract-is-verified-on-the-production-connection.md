# connection-contract-is-verified-on-the-production-connection

## Discovery trigger

`docs/migration-version-lanes.md:47-51` states that "Application connections
verify" four specific properties. A function implementing exactly those four
exists. Its call sites are all in a test file.

## Evidence trail

The claim:

- `docs/migration-version-lanes.md:47-51`:
  "Application connections verify:
  - foreign keys enabled
  - WAL activation
  - configured busy timeout
  - declared synchronous mode"

The implementation, matching the list item for item:

- `crates/mc-store/src/sqlite_runtime.rs:113-140`
  `verify_sqlite_connection_contract(conn, expect_wal, min_busy_timeout_ms)`.
- `:119-122` reads `PRAGMA foreign_keys`, pushes `"foreign_keys is disabled"`
  when not `1`.
- `:123-126` reads `PRAGMA journal_mode`, pushes a violation when `expect_wal`
  and the mode is not WAL.
- `:127-132` reads `PRAGMA busy_timeout`, pushes a violation below the minimum.
- `:133-138` reads `PRAGMA synchronous`, pushes a violation outside `1..=3`.
- Returns every violation; empty means pass (`:112`, `:139`).

The call sites:

- A content search for `verify_sqlite_connection_contract` across the repository
  returns four lines: the definition at `sqlite_runtime.rs:113`, the import at
  `crates/mc-store/tests/sqlite_runtime.rs:7`, and three invocations at
  `tests/sqlite_runtime.rs:183`, `:189`, `:194`.
- No production call site exists. `crates/mc-store/src/lib.rs:4816-4905`
  `McStore::open` was read in full; it does not call the verifier. Production
  code in `lib.rs` ends at `:13930`.

What the existing test actually verifies:

- `tests/sqlite_runtime.rs:172-175` creates a bare
  `rusqlite::Connection::open` on a temp path. It is not a `McStore`.
- `:176-181` sets `busy_timeout=5000`, `foreign_keys=ON`, and
  `journal_mode=WAL` by hand.
- `:182-186` asserts the verifier reports no violations.
- `:187-201` then degrades the connection three ways and asserts the
  corresponding violations, including
  `"synchronous mode 0 is not in the declared set [1, 2, 3]"` at `:199`.

So the test proves the verifier's own logic against a connection it configured
itself, which is a correct unit test of the verifier and says nothing about any
connection the application uses.

## Failure scenario

The realistic failure is a PRAGMA that silently did not take effect.

`cortexkit-store:287` activates WAL with
`conn.pragma_update(None, "journal_mode", "WAL")`. `journal_mode` is one of the
pragmas that *returns the resulting mode* rather than erroring when the requested
mode cannot be set. `pragma_update` discards the returned row. SQLite refuses WAL
on filesystems that cannot support the shared-memory `-shm` mapping, and on such
a filesystem the call can succeed while leaving the database in `delete` or
`truncate` journal mode.

If that happens, three things follow. The store runs without WAL, so the
concurrent-reader assumption stated at `cortexkit-store:285-286` no longer
holds. The `-wal` and `-shm` permission tightening at `cortexkit-store:317-320`
protects files that do not exist, and its ordering comment at `:309-311`
("after the pragma that ENABLES WAL, so the sibling files exist to be
protected") is silently violated. And nothing reports any of it, because the one
function that would notice is never called.

The same shape applies to `foreign_keys`: `cortexkit-store:291` sets it, but
SQLite ignores `PRAGMA foreign_keys` changes inside an active transaction. It is
set at open before any transaction, so it should take effect, but nothing
confirms it, and the migration SQL depends on it. `crates/mc-store/src/lib.rs:1291-1294`
declares `FOREIGN KEY (database_incarnation_id, project_id) REFERENCES
mc_claim_mirror_projects(...) ON DELETE CASCADE`; with foreign keys off, that
cascade silently does not happen and rows orphan.

## Timing windows and dependencies

No window for the reachability question.

For the WAL-activation failure the dependency is the filesystem. Network
filesystems and some container overlay configurations are the usual cases. The
project already reasons about this class of environment issue elsewhere
(`sqlite_runtime.rs:1-6` describes a cross-runtime vocabulary fixture), so it is
not out of character.

## What a test must construct

For reachability:

1. Wrap or counter-instrument `verify_sqlite_connection_contract`.
2. `McStore::open` a temp-dir descriptor.
3. Assert the counter is non-zero and the returned violations are empty.

Fails today on step 3's first half.

For the WAL-refusal behaviour, which is the reason the check has value:

1. A mount where SQLite cannot enable WAL. Practical options are a filesystem
   without shared-memory support, or an `immutable`/read-only-ish mount that
   blocks `-shm` creation.
2. `McStore::open` on it.
3. Assert either a clean refusal or, once the verifier is wired, a violation
   naming `journal_mode`.

Constructing step 1 portably is the hard part. A cheaper partial oracle that
needs no special mount: after `McStore::open`, read `PRAGMA journal_mode` through
the store's own connection and assert `"wal"`. That single assertion converts the
silent case into a loud one and costs one query.

## Investigation log

### Q: Does `pragma_update` surface a refused `journal_mode` change as an error?

- Sources examined: `cortexkit-store:287-288`, which maps the result with
  `.map_err(|e| StoreError::Backend(e.to_string()))?`; the contrast with
  `crates/mc-store/tests/sqlite_runtime.rs:178-181`, which deliberately uses
  `query_row("PRAGMA journal_mode=WAL", ...)` and then asserts the returned
  string is WAL.
- Findings: the test's choice of `query_row` over `pragma_update` is itself
  evidence that the author knew the mode must be read back. Production uses
  `pragma_update`, which discards it. `pragma_update` propagates a genuine SQL
  error but a refused mode is not a SQL error; it is a different returned value.
- Missing evidence: I did not execute the case on a WAL-hostile filesystem, so I
  cannot state that WAL activation has ever silently failed here.
- Conclusion: unresolved, needs a test on a filesystem that rejects WAL. The
  asymmetry between the test's `query_row` and production's `pragma_update` is
  recorded as the concrete lead.

### Q: Does anything else in the process verify these four properties for `store.db`?

- Sources examined: content searches for `PRAGMA` across `crates/`; the four
  verifier reads in `sqlite_runtime.rs`; `crates/mc-store/src/lib.rs:5453`,
  which is a `PRAGMA table_info` introspection inside `delete_session` and
  unrelated.
- Findings: no. The only PRAGMA reads in production Rust are the four inside the
  uncalled verifier.
- Missing evidence: none for the Rust side.
- Conclusion: resolved with answer — nothing verifies them.
