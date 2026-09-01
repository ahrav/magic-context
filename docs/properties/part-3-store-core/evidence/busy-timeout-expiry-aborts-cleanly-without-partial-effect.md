# busy-timeout-expiry-aborts-cleanly-without-partial-effect

## Discovery trigger

Task 3 asked for the `SQLITE_BUSY` and lock-handling map: busy timeout, retry
policy, whether a retry can duplicate an effect, and what a writer-writer
conflict does. The answer to "retry policy" is that there is none, and the answer
to "what does a writer-writer conflict do" turned out to be governed by two
layers above SQLite.

## Evidence trail

The timeout, set once:

- `cortexkit-store/src/lib.rs:289` `conn.busy_timeout(Duration::from_secs(5))`.
  The comment at `:285-286` explains the intent: "a busy timeout so a transient
  lock waits rather than erroring".
- `crates/mc-store/src/sqlite_runtime.rs:127-132` reads it back and flags a value
  below a caller-supplied minimum. `crates/mc-store/tests/sqlite_runtime.rs:183`
  passes `5000`, matching the 5 seconds. The verifier is not called in
  production; see
  [connection-contract-is-verified-on-the-production-connection](connection-contract-is-verified-on-the-production-connection.md).

The absence of a retry policy:

- A content search across production `crates/mc-store/src/lib.rs` (lines 1-13930)
  for `busy`, `Busy`, `retry`, `Retry`, `SQLITE_BUSY`, and `DatabaseBusy` returns:
  an index name in the migration SQL (`:790`
  `idx_mc_note_deliveries_retry`); `NoteEvalAcquireOutcome::Busy` (`:2999`);
  `McStoreError::HistorianBusy` and `ModuleStateSyncError::HistorianBusy`
  (`:3355`, `:3626`, `:4332`, `:7663`, `:7925`); prose in doc comments (`:1796`,
  `:2411`, `:5168`, `:6148`, `:6190`, `:6726`, `:6862`, `:6913`, `:6937`,
  `:6977`); and the two CAS retry-limit messages (`:6755`, `:6776`).
- Every `Busy` in that list is a domain-level lease-contention outcome, not
  SQLite busy. `HistorianBusy` carries a `HistorianPhase` (`:3355`), and
  `NoteEvalAcquireOutcome::Busy` is a note-evaluation claim conflict. None
  originates from `SQLITE_BUSY`.
- So no code retries a SQLite busy failure.

Why writer-writer conflict rarely reaches SQLite:

- `cortexkit-store:279-282` acquires an exclusive file lease *before* the
  connection is opened, and `:254-255` says "The lease is acquired BEFORE the
  file is opened, so a second live writer is rejected (`StoreError::Lease`)
  rather than corrupting a shared file."
- `cortexkit-store:159` (`with_conn`) and `:189` (`with_conn_fenced`) take a
  process-local `Mutex<Connection>`. So within one process, two writers cannot
  both be inside `BEGIN IMMEDIATE`.
- `with_conn_fenced` uses `TransactionBehavior::Immediate` (`:191`), which takes
  the write lock at `BEGIN`. That is the important detail for this property: busy,
  when it occurs, is overwhelmingly reported by `BEGIN` before any statement has
  written, which is the safe failure.

What does reach SQLite, proven by test:

- `crates/mc-store/src/lib.rs:16697-16713`. Inside an
  `abandon_historian_hook` that fires while a fenced transaction is open, the
  test opens a second raw `rusqlite::Connection` on the same path (`:16702`),
  sets `busy_timeout(Duration::ZERO)` (`:16703`), issues an `UPDATE
  mc_cache_state`, and asserts the error is
  `rusqlite::Error::SqliteFailure` with
  `error.code == rusqlite::ErrorCode::DatabaseBusy` (`:16706-16713`). The
  assertion message at `:16705` is
  `"BEGIN IMMEDIATE must block a competing writer"`.

The error path when busy does surface:

- rusqlite `Error` → `StoreError::Backend(e.to_string())` at
  `cortexkit-store:192`, `:199`, `:209`, `:226`, `:229`, or `:231` depending on
  where it happened.
- `StoreError::Backend` → `McStoreError::Store(e)` at
  `crates/mc-store/src/lib.rs:3554-3558`.
- The SQLite error *code* is discarded into a string at the first hop.

## Failure scenario

**The clean case, which is the guarantee.** A fenced write's `BEGIN IMMEDIATE`
cannot get the write lock within 5 seconds. `transaction_with_behavior` at
`cortexkit-store:190` returns `Err`, mapped at `:192`, and no statement of the
closure has run. Nothing is durable, nothing is partial. This is the common case
precisely because of the `IMMEDIATE` choice.

**The mid-transaction case, which is the interesting one.** A fenced transaction
holds the write lock and begins writing. A reader that opened its snapshot after
the `BEGIN` is still holding it, blocking the WAL from being reset or a page from
being written back. A statement partway through the closure blocks and exhausts
the 5 seconds. The `?` at `cortexkit-store:229` returns and the transaction rolls
back on drop, so the guarantee still holds — but this is the path where the
guarantee has content, and nothing tests it.

The three long-lived read snapshots are the plausible blockers:
`crates/mc-store/src/lib.rs:5532` (`load_transform_snapshot_with_hook`), `:5664`
(`load_session_status_snapshot`), `:8862` (`load_m1_revision_snapshot`). The first
is the most concerning because it takes an `after_state_read: impl FnOnce()`
callback (`:5529`) that runs *while the snapshot is open*, so the hold duration
is caller-controlled and unbounded from the store's point of view.

**The consequence that is not about partial state.** Because the error code is
discarded at `cortexkit-store:229`, a busy failure arrives at the caller as
`McStoreError::Store(StoreError::Backend("database is locked"))`. There is no way
to classify it. A caller that wants to retry transient contention must
string-match, and a caller that treats all `Backend` errors as fatal will surface
a five-second lock wait as a hard failure. This is the practical impact of the
property even when the abort itself is clean.

## Timing windows and dependencies

- The window is exactly the 5 seconds configured at `cortexkit-store:289`. It is
  a per-statement budget, not a per-transaction one, so a closure with many
  statements can wait considerably longer in total.
- Depends on the `IMMEDIATE` behaviour at `:191` for the safe-failure bias. If
  that ever changed to `DEFERRED`, mid-transaction busy would become the common
  case rather than the rare one.
- Depends on the exclusive lease holding. Once a writer bypasses the lease — as
  `lib.rs:16702` shows is expressible — both layers of protection are gone and
  real SQLite contention is the norm.

## What a test must construct

The existing test at `lib.rs:16697-16713` already builds the out-of-band writer
and proves busy is reachable. It does the opposite of what this property needs:
it sets `busy_timeout(ZERO)` on the *competitor* so the competitor fails fast.

To exercise the property, invert the roles:

1. Open a raw `Connection` outside the lease and hold `BEGIN IMMEDIATE` for more
   than 5 seconds.
2. From the store, issue a multi-statement fenced write, for example
   `commit_transform`, which writes up to nine table shapes
   (`lib.rs:7390-7586`).
3. Assert the call returns `Err`.
4. Assert every one of those nine tables is byte-identical, per identity, to its
   pre-call contents.

For the mid-transaction variant, the holder must arrive *after* the store's
`BEGIN` rather than before, which requires a hook inside the closure. The
existing `set_before_max_compartment_end_read_hook` (`lib.rs:5283`) and
`set_abandon_historian_hook` (`:5294`) are the hooks of this shape; neither fires
inside `commit_transform`.

A cheaper coverage check that asserts preconditions rather than the violation:
assert that `busy_timeout` on the store's connection is at least 5000, that
`journal_mode` is WAL, and that a read snapshot can be held across a write
attempt. Those three jointly create the window and all three hold on a correct
implementation.

## Investigation log

### Q: Is a retry of a busy-failed write idempotent, given there is no retry loop?

- Sources examined: the search results above showing no retry loop; the two CAS
  loops at `lib.rs:6727-6757` and `:6760-6778`, which retry on `CasConflict`
  only and return immediately on any other error (`:6751`, `:6772`).
- Findings: the question is vacuous at the store layer, because the store never
  retries a busy failure. The CAS loops explicitly do *not* retry it: their match
  arms are `Err(error @ McStoreError::CasConflict { .. })` to continue and
  `Err(error) => return Err(error)` otherwise, and a busy failure arrives as
  `McStoreError::Store`, so it exits the loop.
- Missing evidence: whether any caller above `mc-store` retries. That is outside
  this lens's scope.
- Conclusion: resolved with answer for this layer — no store-level busy retry
  exists, so no store-level duplicate effect is possible from one. The risk moves
  up to callers, who cannot classify the error, which is recorded as the record's
  `Impact`.

### Q: Is `IMMEDIATE` on every fenced write manufacturing contention that a `DEFERRED` read path would avoid?

- Sources examined: `cortexkit-store:185-233`, noting that
  `with_conn_fenced` unconditionally creates `cortexkit_fence` (`:194-199`) and
  reads the epoch (`:203-209`) before running the closure, so even a
  read-mostly closure passed to it takes the write lock at `BEGIN`; the 40
  production call sites of `with_conn_fenced` / `with_note_conn_fenced` in
  `lib.rs`.
- Findings: the design is deliberate — the fence read must be serialized against
  a competing epoch claim, so `IMMEDIATE` is required for the fence itself, not
  merely for the closure's writes. Reads that do not need the fence use
  `with_conn` instead, and there are 73 of those.
- Missing evidence: no measurement of lock-hold duration or contention rate.
- Conclusion: resolved with answer on the design rationale; unresolved on whether
  it costs anything measurable. Not a durability question, so left as a note.
