# bundled-engine-satisfies-the-declared-wal-reset-precondition

## Discovery trigger

`crates/mc-store/src/sqlite_runtime.rs:23-25` declares a named minimum SQLite
version with an upstream citation. Any declared minimum invites the question of
whether the shipped build meets it. It does not, and the crate knows.

## Evidence trail

The declaration:

- `sqlite_runtime.rs:23-25`:
  ```
  /// Minimum SQLite release carrying the WAL-reset fix
  /// (<https://www.sqlite.org/wal.html#walresetbug>).
  pub const SQLITE_WAL_RESET_SAFE_MIN_VERSION: [u64; 3] = [3, 47, 1];
  ```

The gate that enforces it:

- `sqlite_runtime.rs:89-108` `evaluate_sqlite_runtime_gate`. Its doc comment at
  `:89-91` states "The engine identity is authoritative: a wrapper version alone
  never passes, and an unknown `sqlite_source_id()` fails closed."
- `:94-100` compares `parse_dotted_version(&identity.sqlite_version)` against
  the constant and pushes
  `"SQLite {} predates the WAL-reset fix in 3.47.1"` on failure.
- `:101-106` additionally fails closed on an unrecognized
  `sqlite_source_id()`, using `is_well_formed_source_id` (`:66-87`).

The shipped engine, verified three independent ways:

1. `Cargo.toml:29`, a comment on the `rusqlite` dependency:
   "0.32 bundles SQLite 3.46.0 (pre-3.47.1 WAL-reset fix,
   sqlite.org/wal.html#walresetbug)."
2. `Cargo.toml:32` `rusqlite = { version = "0.32", features = ["bundled"] }`,
   and `Cargo.lock` resolves the native shim to `libsqlite3-sys 0.30.1`.
3. That crate's vendored header,
   `~/.cargo/registry/src/index.crates.io-*/libsqlite3-sys-0.30.1/sqlite3/sqlite3.h:149`:
   `#define SQLITE_VERSION        "3.46.0"`.

The test that pins the violation as expected:

- `crates/mc-store/tests/sqlite_runtime.rs:139-169`. Its comment at `:140-143`
  says the gate "reports as unsafe until the coordinated
  cortexkit-store/rusqlite bump lands (see the workspace Cargo.toml note)".
- `:144` probes the live engine via `probe_sqlite_engine_identity_off_path`.
- `:156-168` branches on the probed tuple. Because the tuple is below the
  minimum, the executed branch is `:161-168`, which asserts
  `live_reasons == vec!["SQLite 3.46.0 predates the WAL-reset fix in 3.47.1"]`.

So the failing verdict is not merely possible; it is the asserted outcome of a
passing test.

## Failure scenario

The upstream WAL-reset bug is in the code path that resets the WAL file after a
checkpoint, when the WAL wraps back to its start. Nothing in this project
configures checkpointing: a content search for `wal_autocheckpoint`,
`wal_checkpoint`, and `journal_size_limit` across `crates/` and
`cortexkit-store/src/lib.rs` finds no occurrences. So resets happen at SQLite's
default 1000-page autocheckpoint cadence, which for a store that commits on
every transform pass is routine, not rare.

The concrete failure is therefore: a store that has been running long enough to
wrap its WAL, with a concurrent reader holding a snapshot across the wrap, can
observe the reset defect. What that defect does to reads is upstream's business;
what matters here is that the crate wrote down "do not run below 3.47.1" and
then shipped 3.46.0.

## Timing windows and dependencies

- The exposure is per WAL wrap, so its frequency is a function of write volume
  and the autocheckpoint threshold, not of wall time.
- Concurrent readers are present by construction: `journal_mode = WAL` is set
  precisely for them (`cortexkit-store:285-286` comment), and three read paths
  hold multi-statement snapshots via `unchecked_transaction`
  (`crates/mc-store/src/lib.rs:5532`, `:5664`, `:8862`).
- The escape hatch is blocked by a stated coupling: `Cargo.toml:30` says
  "Raising it requires bumping cortexkit-store in the same change", and
  `Cargo.toml:24-25` explains why: "rusqlite pinned to the same
  version+features cortexkit-store uses so the Connection/Transaction types
  unify across the with_conn boundary."

## What a test must construct

The version comparison needs nothing: `tests/sqlite_runtime.rs:139-169` already
performs it. What that test does is encode the violation as expected, which is
an accurate regression pin but the opposite of a guarantee.

The property as written is checkable by inverting that assertion, which will
fail today. That is the correct outcome for a property whose guarantee is
currently unmet: the record's `Status` stays `active` and the check documents
reality.

To observe a consequence rather than the version mismatch, a test would need:

1. A store with WAL active and no checkpoint override.
2. Enough committed write volume to cross the autocheckpoint threshold and wrap
   the WAL at least twice.
3. A reader holding an `unchecked_transaction` snapshot across the wrap.
4. An oracle comparing the reader's snapshot contents against the values that
   were durable when its snapshot opened.

Step 4 is the hard part and belongs to
`/testing:crash-consistency-and-failpoint-testing` rather than to a unit test.

## Investigation log

### Q: Is the coordinated `rusqlite` / `cortexkit-store` bump tracked anywhere?

- Sources examined: `Cargo.toml:24-32`, `crates/mc-store/Cargo.toml:15-16`,
  `docs/migration-version-lanes.md`, `CHANGELOG.md` presence at the repo root.
- Findings: the coupling is stated twice in comments (`Cargo.toml:25`, `:30`)
  and once in a test comment (`tests/sqlite_runtime.rs:141-143`), so three
  places know about it. None links to a tracking item.
- Missing evidence: no issue reference, TODO with an identifier, or dated note.
  The repository's comment policy forbids ticket IDs in source, so their
  absence is not itself evidence of an untracked item.
- Conclusion: needs human input. The engineering intent is clearly recorded;
  whether it is scheduled is not knowable from the tree.

### Q: Does the `sqlite_source_id` half of the gate also fail on this build?

- Sources examined: `sqlite_runtime.rs:66-87` `is_well_formed_source_id`,
  `:101-106`, and `tests/sqlite_runtime.rs:161-168`.
- Findings: the test asserts the reasons vector equals exactly one element, the
  version message. So the source-id check passes on the bundled build; only the
  version check fails.
- Missing evidence: none.
- Conclusion: resolved with answer — one failure reason, the version. That
  matters because it means the gate is not failing for a spurious parsing
  reason; it is failing on the real precondition.
