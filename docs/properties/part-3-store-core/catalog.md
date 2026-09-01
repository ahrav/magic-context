# Part 3 property catalog: the store, its durability contract, and the core domain

Scope: three crates. `crates/mc-store` (21,987 lines across `src/lib.rs`,
`src/claim_mirror.rs`, `src/sqlite_runtime.rs`, and three files under `tests/`),
`crates/mc-core` (1,518), and `crates/mc-tokenizer` (85). Production code in
`crates/mc-store/src/lib.rs` ends at line 13,930; line 13,931 is blank and
everything from 13,932 on is test code in three modules, `tests` (13,932 to
19,420), `shadow_tests` (19,421 to 19,980), and `lineage_descent_tests` (19,981
to 20,650). That boundary matters for reachability labelling, because several
records below are about code that exists and has no production caller.

The `lib.rs` region map, reused from the durability lens because every citation
in Groups A and B is anchored to it:

| Lines | Region |
| --- | --- |
| 1-13 | Crate doc comment: states the epoch-fence plus `row_version` CAS contract |
| 16-17 | `pub mod claim_mirror;` and `pub mod sqlite_runtime;` |
| 19-41 | Imports, including `cortexkit_store::{open_sqlite, Migration, SqliteStore, StoreError}` at 20 |
| 43-56 | `canonical_root` |
| 59-399 | Wire and block value types |
| 401-430 | Constants and `current_time_ms` |
| **432-1312** | **`const MIGRATIONS`** — a single `Migration`, `version: 57` at 433, one consolidated bootstrap SQL string 434-1311 |
| 1314-1342 | `LATEST_MIGRATION_VERSION` 1321-1331, `OLDEST_ADOPTABLE_MIGRATION_VERSION` 1342 |
| 1344-1385 | `recorded_mc_cache_version` 1346-1366, `refuse_pre_cutover_store` 1375-1385 |
| 1413-3349 | Domain DTO and state types, including claim-intent types 3071-3115 |
| 3351-3652 | Error types and conversions, `From<StoreError> for McStoreError` 3554-3558 |
| 3654-3775 | Internal transaction-outcome enums and side-channel row types |
| 3776-4343 | SQL constants and free helpers, claim-intent helpers 3787-3962 |
| 4345-4608 | Facade scope guards and `FacadeMutationTxn` |
| 4610-4634 | `pub struct McStore` |
| **4810-12234** | **`impl McStore` block 1**, including `open` 4816-4905, `repair_note_artifacts_v51` 5069-5114, `delete_session` 5432-5475, `set_todo_state` 6727-6757, `arm_soft_refresh` 6760-6778, `preflight_state_import` 7114-7139, `commit_state_import` 7145-7205, `commit_transform` 7260-7609, claim intent and mirror 11xxx-12232 |
| 12236-12825 | Free `*_tx` writer helpers and compression |
| **13160-13707** | **`impl McStore` block 2** — note-evaluation claim lifecycle |
| 13709-13930 | `rebind_note_eval_claim_tx`, `note_check_digest`, `repair_note_artifacts_tx`, misc helpers |
| 13932-20650 | Three `#[cfg(test)]` modules |

One boundary fact shapes the whole part. The PRAGMAs, the transaction primitive,
and the migration runner are **not** in this repository. They live in
`cortexkit-store`, resolved by `Cargo.toml:16` to
`../commons/crates/cortexkit-store` (789 lines). That file is read-only context:
it is the durability contract, and `mc-store` only consumes it. Citations to it
are marked `cortexkit-store:NNN`, and the portfolio evaluation records as its
bias 1 that this repository resolves the sibling by path, does not pin it, and CI
replaces it with metadata-only stubs, so those citations are not reproducible
from this repository alone.

Provenance in [../README.md](../README.md). System
`/local/home/ahrav/scratch/magic-context`. The two record-proposing storage
lenses and the core-semantics lens read and verified their line references at
`ed487e11`. The history-and-checks lens read at `dde0c051`, three commits ahead,
and verified that `git diff --stat ed487e11..dde0c051` touches only
`.github/workflows/shm-hardening-optin.yml`, which references no scope crate, so
every scope line reference is identical at both commits. The portfolio
evaluation re-verified the fault-map correction at `80585c48` and at HEAD
`76cd6f41`. Workflow line numbers are given against the committed HEAD, which is
where they were verified; the working tree carries an uncommitted `+9`-line edit
to `ci.yml` that shifts them by eight.

**Reconstruction note.** This file was rebuilt from the five lens files in
`_lenses/` after the working tree was cleaned while it was untracked. Every
record's text is taken verbatim from the lens that proposed it, with formatting
normalised to match the Part 1 and Part 4a catalogs and with the refinements the
surviving `portfolio-evaluation.md` records as applied. It is not a fresh
discovery pass: no claim below was re-derived or re-verified against source
during the reconstruction, because the lens agents already verified their
references at the commits named above. The refinements applied are R2 (seven
check-semantics corrections), R3 (the reset-cycle split, which takes the record
count from 36 to 37), R4 (three records narrowed to what a workload can observe),
R5 (the schema-version record narrowed to one claim), and R6 (the tokenizer
provenance record retyped from `reachability` to `safety`). R1 and the fault-map
correction were applied to `fault-map.md` and change no record here.

## What this part is about

This is the durability floor of the system. Everything Parts 4a through 4f decide
becomes real by passing through `commit_transform`, `publish_historian_chunk`,
`apply_claim_mirror_receipt`, or `stage_claim_intent`, and each of those is one
fenced SQLite transaction in this crate. The part also covers `mc-core`, which
holds no state at all: it is the encoding, identity, and decay vocabulary both
runtimes share, so a divergence there is a wrong answer rather than a lost write.

**The transaction primitives are three, and only three.** `SqliteStore::with_conn`
(`cortexkit-store:155-161`) hands out a raw `&Connection` under the store mutex
with no transaction, on 73 production call sites. `SqliteStore::with_conn_fenced`
(`cortexkit-store:185-233`) is the write path: `TransactionBehavior::Immediate`
at `:191`, so the write lock is taken at `BEGIN` rather than deferred to the
first write; it reads the stored epoch, rejects a superseded writer with
`StoreError::Fenced`, runs the closure at `:229`, and commits at `:230-231`. Any
`Err` from the closure returns before the commit and the `Transaction` rolls back
on drop. There are 40 production call sites plus the `with_note_conn_fenced`
wrapper at `lib.rs:5323-5343`. The third is `conn.unchecked_transaction()`, on
three read-only multi-statement snapshots (`lib.rs:5532`, `:5664`, `:8862`),
DEFERRED and never committed. There are no savepoints and no nested
transactions.

**Predicates and their writes almost never split.** A scan of every production
`fn` for two or more connection acquisitions returns exactly three:
`open` (`lib.rs:4816`), `repair_note_artifacts_v51` (`:5069`), and
`deliver_historian_side_channel` (`:9662`), and the third is three mutually
exclusive match arms, each doing its domain insert and its delivery mark in one
transaction, which is a correct transactional-outbox shape. `commit_transform` is
the exemplary case: it opens the fenced transaction at `:7352`, reads the current
`row_version` inside it at `:7354-7357`, decides conflict, and every overlay
write lands in the same transaction. `commit_state_import` closes its own
preflight window by re-evaluating both predicates inside the fenced transaction
(`:7153-7159`, `:7170`), with the reasoning stated at `:7167-7169`. Group B
records this as a positive invariant precisely so a future split is caught.

### Product context

Three facts frame every `Existing check:` and `Exercised:` line below.

**No CI job runs any test in this scope.** There are 101 in-crate tests in
`crates/mc-store/src/lib.rs`, 31 in-crate tests in `crates/mc-core`, and four
integration binaries (`tests/claim_mirror.rs` with 9 tests,
`tests/claim_intent_ledger.rs` with 6, `tests/sqlite_runtime.rs` with 3, and
`crates/mc-tokenizer/tests/token_golden.rs` with 4). None of them executes.
Grepping `mc-store`, `mc-core`, and `mc-tokenizer` across all five files in
`.github/workflows/` returns exactly five hits, all in `ci.yml`, all in one job,
and the only command is `cargo check -p mc-core --no-default-features`
(`ci.yml:483-484`), which compiles and runs nothing and does not build test
targets. The other Rust test invocations name `-p mc-host`,
`-p mc-module --test lifecycle_cli`, and the `mc-shm-*` crates; there is no
`--workspace` and no `--all-targets` run anywhere. So a green CI run says almost
nothing about this scope. The portfolio evaluation's bias 2 disputes how much
weight that fact should carry, on the grounds that a property is true or false
regardless of who runs it, and that argument is recorded there rather than
resolved here.

**The store's real PRAGMAs are set in an out-of-repo sibling.**
`cortexkit-store:265-327` `open_sqlite` is the only place any PRAGMA reaches the
real database file, and it sets exactly three: `journal_mode = WAL` (`:287`),
`busy_timeout` of 5 seconds (`:289`), and `foreign_keys = ON` (`:291`). That file
is resolved by path from root `Cargo.toml:16`. `McStore::open`
(`lib.rs:4816-4905`) adds no PRAGMA of its own: it registers four scalar UDFs
before migrating because migration triggers call them, calls
`refuse_pre_cutover_store` then `inner.migrate`, sets the prepared-statement
cache to 128, and runs two post-migration repairs. It does not call
`verify_sqlite_connection_contract`, does not set `application_id` or
`user_version`, and does not read a `mc_format_marker` row.

**`PRAGMA synchronous` is never set anywhere.** Not in `open_sqlite`, not in
`McStore::open`, not anywhere in `crates/mc-store/src`. A content search for
`synchronous` across `crates/` and the sibling finds only the verifier's own read
at `sqlite_runtime.rs:133-138`, its doc comment at `:112`, and two test lines. So
the level is whatever the dependency's build default is, which for an unmodified
SQLite is `FULL`, while the documented runtime contract at
`docs/migration-version-lanes.md:50` promises a "declared synchronous mode" and
the verifier that would check it accepts the whole set `1..=3`, of which `1` is
`NORMAL` and does not fsync at commit in WAL. Under `FULL` an acknowledged commit
survives power loss; under `NORMAL` it survives only a process crash. The class
of durability every acknowledged write in this system has is therefore decided by
a dependency's build flags rather than by this project, and a toolchain change
can silently downgrade it. That is the core finding of Group A.

Two adjacent facts belong with it, because three records rest on them.
`sqlite_runtime.rs` implements the whole runtime contract correctly and has no
production caller: `verify_sqlite_connection_contract` (`:113-140`),
`evaluate_sqlite_runtime_gate` (`:92-108`), and
`probe_sqlite_engine_identity_off_path` (`:45`) are called only from
`crates/mc-store/tests/sqlite_runtime.rs`. And the crate declares
`SQLITE_WAL_RESET_SAFE_MIN_VERSION = [3, 47, 1]` (`:23-25`) while shipping the
bundled 3.46.0 engine, which the test at `tests/sqlite_runtime.rs:139-169`
asserts *fails* the gate, expecting the string "SQLite 3.46.0 predates the
WAL-reset fix in 3.47.1". The crate has written down a durability precondition,
ships a build that violates it, and never evaluates the gate on the production
open path.

### Selection principle

Stated explicitly because the portfolio evaluation's bias 3 asks for it and
cannot answer it. This is a **risk-selected slice, not representative coverage**.
Groups A and B cover the open path and the three transaction primitives, Groups C
and D the claim mirror and the intent ledger, and Groups E through G a few
thousand lines of pure functions in `mc-core` and `mc-tokenizer`. Large regions
of production `lib.rs` have no record at all: the historian publish and outbox
machinery (`:9194-9798`, which Part 4a covers from the module side), the
note-evaluation claim lifecycle (`:13160-13707`), the drop-seed and strip-seed
materializers (`:4636-4808`), and most of the DTO and state layer. Retention,
eviction, deletion, and cross-table conservation have no group at all, which the
evaluation queued as its gap G4. Read the 37 records as a baseline over the
highest-risk mechanisms, not as a clean bill for the crate.

## Index

| Slug | Type | Confidence |
| --- | --- | --- |
| [acknowledged-commit-survives-process-crash](#acknowledged-commit-survives-process-crash) | safety | high/low |
| [synchronous-level-is-explicitly-declared-not-inherited](#synchronous-level-is-explicitly-declared-not-inherited) | safety | high |
| [bundled-engine-satisfies-the-declared-wal-reset-precondition](#bundled-engine-satisfies-the-declared-wal-reset-precondition) | safety | high |
| [wal-reset-gate-runs-on-the-production-open-path](#wal-reset-gate-runs-on-the-production-open-path) | reachability | high |
| [connection-contract-is-verified-on-the-production-connection](#connection-contract-is-verified-on-the-production-connection) | reachability | high |
| [failed-fenced-transaction-leaves-no-partial-state](#failed-fenced-transaction-leaves-no-partial-state) | safety | high/medium |
| [busy-timeout-expiry-aborts-cleanly-without-partial-effect](#busy-timeout-expiry-aborts-cleanly-without-partial-effect) | safety | medium |
| [bounded-cas-retry-never-duplicates-an-effect](#bounded-cas-retry-never-duplicates-an-effect) | safety | high |
| [write-predicates-are-re-evaluated-inside-the-write-transaction](#write-predicates-are-re-evaluated-inside-the-write-transaction) | safety | high |
| [migration-and-its-version-record-commit-together](#migration-and-its-version-record-commit-together) | safety | high |
| [recorded-schema-version-cannot-disagree-with-the-actual-schema](#recorded-schema-version-cannot-disagree-with-the-actual-schema) | safety | medium |
| [post-migration-open-repair-is-resumable-and-effect-idempotent](#post-migration-open-repair-is-resumable-and-effect-idempotent) | safety | high |
| [mirror-receipt-replay-applies-effects-once](#mirror-receipt-replay-applies-effects-once) | safety | high |
| [mirror-receipt-conflict-rejects-divergent-replay](#mirror-receipt-conflict-rejects-divergent-replay) | safety | high |
| [mirror-project-effect-chain-detects-omission](#mirror-project-effect-chain-detects-omission) | safety | high |
| [mirror-generation-advances-exactly-one-per-touched-project](#mirror-generation-advances-exactly-one-per-touched-project) | safety | high |
| [mirror-read-fence-relies-on-generation-advance](#mirror-read-fence-relies-on-generation-advance) | safety | medium |
| [mirror-reset-cycle-requires-a-rebuild-grant](#mirror-reset-cycle-requires-a-rebuild-grant) | reachability | high |
| [mirror-clear-without-a-grant-is-never-entered](#mirror-clear-without-a-grant-is-never-entered) | reachability | high |
| [mirror-accepting-gate-is-skipped-when-control-is-absent](#mirror-accepting-gate-is-skipped-when-control-is-absent) | safety | high |
| [mirror-staleness-undetectable-on-memory-tool-read-path](#mirror-staleness-undetectable-on-memory-tool-read-path) | safety | high |
| [intent-control-transition-write-is-silently-dropped](#intent-control-transition-write-is-silently-dropped) | safety | high |
| [intent-identity-is-producer-and-operation-key](#intent-identity-is-producer-and-operation-key) | safety | high |
| [intent-terminal-state-is-entered-at-most-once](#intent-terminal-state-is-entered-at-most-once) | safety | high |
| [intent-staged-replay-produces-one-context-effect](#intent-staged-replay-produces-one-context-effect) | safety | medium |
| [core-decay-newest-compartment-tier-floor](#core-decay-newest-compartment-tier-floor) | safety | high |
| [core-decay-tier-ladder-monotone-and-archive-agreement](#core-decay-tier-ladder-monotone-and-archive-agreement) | safety | high |
| [core-decay-budget-pressure-range-totality](#core-decay-budget-pressure-range-totality) | safety | high |
| [core-decay-archive-termination-bound](#core-decay-archive-termination-bound) | safety | high |
| [core-canonical-encoding-crossruntime-parity](#core-canonical-encoding-crossruntime-parity) | safety | high |
| [core-result-decode-acceptance-boundary](#core-result-decode-acceptance-boundary) | safety | high |
| [core-applicability-heads-order-independence](#core-applicability-heads-order-independence) | safety | high |
| [core-revision-locator-roundtrip-inverse](#core-revision-locator-roundtrip-inverse) | safety | high |
| [core-intent-ack-transition-legality-gap](#core-intent-ack-transition-legality-gap) | safety | medium |
| [core-pass-classifier-destructive-clear-guard](#core-pass-classifier-destructive-clear-guard) | safety | high |
| [tokenizer-cross-process-determinism](#tokenizer-cross-process-determinism) | safety | high |
| [tokenizer-golden-oracle-provenance](#tokenizer-golden-oracle-provenance) | safety | high |

---

## Group A: durability and the connection contract

Five records on what an acknowledged write actually promises and on the three
verification mechanisms that would establish it. The first two are the promise
itself and the missing declaration underneath it. The third is a precondition the
crate wrote down and then violated in its own build. The last two are reachability
claims: the runtime gate and the connection-contract verifier both exist, both
implement exactly what `docs/migration-version-lanes.md:41-51` promises, and
neither has a production caller.

### acknowledged-commit-survives-process-crash

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:16927`
`historian_side_channel_outbox_recovers_after_restart` and `lib.rs:14717`
`first_application_marker_is_atomic_and_survives_reopen` reopen the store
in-process after a clean drop. Neither kills a process mid-commit.
Guarantee: When `with_conn_fenced` returns `Ok`, the committed rows are present
after the process is killed without cleanup and the store is reopened.
Check: `always` — for every fenced write that returned `Ok`, after `SIGKILL` and
reopen, the row is readable with the committed `row_version`. `always` because
every acknowledged write makes this promise; there is no path on which the promise
is conditional.
Fault/timing angle: the window is between `tx.commit()` returning at
`cortexkit-store:230-231` and the caller observing `Ok`. A kill inside `commit()`
must yield either the whole transaction or none of it, which is SQLite's contract,
not this code's. The code-level risk is the missing `synchronous` declaration: at
`NORMAL` the commit is in the WAL but unfsynced, so a process kill is survived and
a power loss is not.
Required faults and enabling state: `SIGKILL` to the writer between commit and
acknowledgement, then reopen through `McStore::open`. To separate process crash
from power loss the test needs a second variant that loses the page cache, which a
user-space test cannot do; that variant needs `dm-flakey` or equivalent.
Confidence: high on the transaction shape, low on the power-loss half —
[evidence](evidence/acknowledged-commit-survives-process-crash.md). Verified
`with_conn_fenced` commits at `cortexkit-store:230-231` and that no `synchronous`
pragma exists in either crate.
Existing check: `lib.rs:16189`
`state_import_is_atomic_bootstrap_only_and_durably_idempotent` and `lib.rs:16927`
cover reopen-after-clean-drop. Status `unaudited`.
Impact: an acknowledged commit that vanishes makes the `row_version` CAS unsound
across restart, because the caller's cached expectation no longer matches durable
state.
Open questions:

- Does the `libsqlite3-sys 0.30.1` bundled build override
  `SQLITE_DEFAULT_SYNCHRONOUS`? Not resolved by reading; needs a query against the
  built engine.

### synchronous-level-is-explicitly-declared-not-inherited

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test reads `PRAGMA synchronous` from a connection produced
by `McStore::open`.
Guarantee: The connection `McStore::open` returns runs at a synchronous level the
code chose, not one inherited from the build's compile-time default.
Check: `always` — on a connection obtained from `McStore::open`, read
`PRAGMA synchronous` and assert it equals the exact value the project has decided
on, recorded as a constant in this repository. `always` because the level governs
every commit on that connection, so it must hold at every observation, not merely
once at open.

The oracle is a correction. This record previously asked that the pragma "equals a
value some line of code set", which no workload can decide: there is no runtime
difference between a level this code set and the identical level inherited from
`SQLITE_DEFAULT_SYNCHRONOUS`. Provenance is not observable, so the check is an
exact-value comparison against a declared expectation instead. Note that
`verify_sqlite_connection_contract` cannot serve as that oracle: it accepts the
whole set `1..=3` (`sqlite_runtime.rs:133-136`), and `1` is `NORMAL`.
Fault/timing angle: none. This is a static configuration property. The interesting
part is the interaction with the verifier: `sqlite_runtime.rs:133-138` accepts any
value in `1..=3`, and `1` is `NORMAL`, which in WAL mode does not fsync on commit.
So the verifier as written would pass a connection that cannot survive power loss,
while `docs/migration-version-lanes.md:50` calls this a "declared synchronous
mode".
Required faults and enabling state: none. Open a store and read the pragma.
Confidence: high —
[evidence](evidence/synchronous-level-is-explicitly-declared-not-inherited.md).
Verified by exhaustive content search for `synchronous` across `crates/` and
`cortexkit-store/src/lib.rs`: the only occurrences are the verifier reads at
`sqlite_runtime.rs:133-138`, its doc comment at 112, and two test lines.
Existing check: `crates/mc-store/tests/sqlite_runtime.rs:192-200` proves the
verifier rejects `synchronous=OFF`, on a hand-built connection. It never inspects
a `McStore` connection. Status `unaudited`.
Impact: the durability class of every acknowledged write is decided by the
dependency's build flags rather than by this project, and a future toolchain
change can silently downgrade it.
Open questions:

- Is `NORMAL` intended to be acceptable? If yes the doc's durability language
  needs narrowing to process-crash survival; if no the verifier's accepted set is
  wrong. (needs human input)

### bundled-engine-satisfies-the-declared-wal-reset-precondition

Type: safety
Reachability: default-production
Status: active
Exercised: yes — `crates/mc-store/tests/sqlite_runtime.rs:139-169` probes the live
engine and asserts the *failing* branch, expecting `"SQLite 3.46.0 predates the
WAL-reset fix in 3.47.1"`.
Guarantee: The SQLite engine compiled into the shipping binary is at or above
`SQLITE_WAL_RESET_SAFE_MIN_VERSION`, the version the crate declares as the minimum
for safe WAL reset.
Check: `always` — `parse_dotted_version(sqlite_version()) >= [3, 47, 1]` for the
engine actually linked. `always` rather than `reachable`, because the precondition
governs every WAL reset the database performs, not one code point.
Fault/timing angle: the vulnerable event is a WAL reset, which happens when the WAL
wraps after a checkpoint. With no checkpoint policy configured, resets occur on the
default 1000-page autocheckpoint cadence, so the exposure is routine rather than
rare.
Required faults and enabling state: no fault needed to observe the version
mismatch. To observe a consequence a test would need to drive enough write volume
to wrap the WAL repeatedly with a concurrent reader.
Confidence: high —
[evidence](evidence/bundled-engine-satisfies-the-declared-wal-reset-precondition.md).
Verified three ways: `Cargo.toml:29` states 3.46.0, `Cargo.lock` pins
`libsqlite3-sys 0.30.1`, and that crate's vendored `sqlite3/sqlite3.h:149`
declares `#define SQLITE_VERSION "3.46.0"`.
Existing check: `tests/sqlite_runtime.rs:139-169`, which encodes the violation as
the expected outcome. That is an accurate regression pin for today's state, not a
guarantee. Status `unaudited`.
Impact: the crate has written down a durability precondition and ships a build that
does not meet it. Whatever the WAL-reset bug can do to this database, it can do
today.
Open questions:

- `Cargo.toml:30` says raising `rusqlite` requires bumping `cortexkit-store` in the
  same change. Is that coordinated bump tracked anywhere? (needs human input)

### wal-reset-gate-runs-on-the-production-open-path

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — the gate has no production caller to exercise.
Guarantee: `evaluate_sqlite_runtime_gate` is evaluated against the real engine
identity before `store.db` is opened for writing, so an unsafe engine is refused
rather than used.
Check: `reachable` — the gate call site must execute on the `McStore::open` path.
`reachable` because this is location coverage: the question is whether a specific
code point is entered at all, and today it is not.
Fault/timing angle: none. The check either runs at open or does not.
Required faults and enabling state: none. Instrument
`evaluate_sqlite_runtime_gate` and call `McStore::open`.
Confidence: high —
[evidence](evidence/wal-reset-gate-runs-on-the-production-open-path.md). Verified
that `McStore::open` (`lib.rs:4816-4905`) contains no call, and that a content
search for `evaluate_sqlite_runtime_gate` and
`probe_sqlite_engine_identity_off_path` across the repository finds definitions in
`sqlite_runtime.rs:45, 92` and call sites only in
`crates/mc-store/tests/sqlite_runtime.rs`.
Existing check: none in production. The test file exercises the function directly.
Status `unaudited`.
Impact: `docs/migration-version-lanes.md:41-44` says "Bun and Node writers probe an
approved WAL-reset-safe SQLite source on an off-path database. The root Rust module
applies the same rule to `store.db`." The Rust half of that sentence is not
implemented.
Open questions:

- Would wiring the gate in today make `McStore::open` fail outright, given the
  engine is 3.46.0? If so the gate cannot be enabled before the version bump, and
  the doc claim should be marked pending rather than current. (needs human input)

### connection-contract-is-verified-on-the-production-connection

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — verified only on hand-built test connections.
Guarantee: `verify_sqlite_connection_contract` runs against the connection
`McStore::open` produces, so a store whose PRAGMAs did not take effect is refused.
Check: `reachable` — the verifier call site must execute on the `McStore::open`
path with the store's own connection. `reachable` because it is location coverage
for a specific code point that must be entered.
Fault/timing angle: none for the reachability question. The failure it would catch
is a PRAGMA that silently did not apply, for example `journal_mode = WAL` being
refused on a filesystem that cannot support shared memory, which returns the prior
mode rather than erroring.
Required faults and enabling state: none for reachability. To make the check
meaningful, a store opened on a filesystem where WAL cannot be enabled.
Confidence: high —
[evidence](evidence/connection-contract-is-verified-on-the-production-connection.md).
Verified `McStore::open` has no call, and the only call sites are
`crates/mc-store/tests/sqlite_runtime.rs:183, 189, 194`.
Existing check: `tests/sqlite_runtime.rs:171-202` proves the verifier's own logic
on a connection the test configures by hand. It does not test any `McStore`
connection. Status `unaudited`.
Impact: `docs/migration-version-lanes.md:47-51` promises that "Application
connections verify: foreign keys enabled, WAL activation, configured busy timeout,
declared synchronous mode." No application connection in this crate verifies any
of the four.
Open questions:

- `cortexkit-store:287` uses `pragma_update` for `journal_mode`, which discards the
  returned mode. Does that mask a refused WAL activation? Not resolved; needs a
  test on a filesystem that rejects WAL.

## Group B: transactions and migrations

Seven records on the boundary between a decision and its durable effect. The first
two are the two ways a fenced transaction can fail, a late error inside the closure
and a busy timeout at `BEGIN`, and both claim the same thing: nothing partial
survives. The third and fourth are the two read-modify-write shapes that
deliberately split across transactions and compensate, one with a bounded CAS loop
and one by re-evaluating its predicate inside the write. The last three are the
open path: whether a migration and the record that it ran are one atom, whether the
recorded version can disagree with the schema it names, and whether the repair that
runs after migration is safe to interrupt.

### failed-fenced-transaction-leaves-no-partial-state

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `cortexkit-store:691-712` `fenced_write_rolls_back_on_error`
forces a closure error after a write and asserts rollback. That is the dependency's
own test, on the dependency's shape, not on any `mc-store` multi-statement writer.
Guarantee: When a closure passed to `with_conn_fenced` returns `Err` at any
statement, none of its earlier statements in that transaction are durable.
Check: `always-or-unreached` — after any fenced write that returned `Err`, every
table the closure touched is byte-identical to its pre-call state.
`always-or-unreached` rather than `always` because the condition is evaluable only
on a closure that returned `Err`, which is an optional outcome a campaign may not
produce; the promise must hold whenever it does.
Fault/timing angle: the interesting closures are the multi-statement ones, where
the window between the first and last statement is real: `commit_transform` writes
cache state then up to eight overlay tables (`lib.rs:7390-7586`); `delete_session`
deletes from every discovered table in a loop (`lib.rs:5448-5472`);
`commit_state_import` inserts N compartments then the import record
(`lib.rs:7177-7190`); `append_compartments_tx` (`lib.rs:12609`). An injected error
must land *between* statements, not before the first.
Required faults and enabling state: an error injected at statement k of an
n-statement closure, for k strictly between 1 and n. A late SQL error suffices and
needs no new infrastructure: in-crate tests already reach
`store.inner.with_conn(...)`, `with_conn_fenced` takes an arbitrary closure,
`foreign_keys = ON` (`cortexkit-store:291`), and the bootstrap carries `CHECK`,
`NOT NULL`, and `UNIQUE` constraints. One caveat: `commit_state_import` validates
*before* its insert loop (`lib.rs:7172-7174`), so in that closure the error must
come from a constraint rather than from `validate_state_import_compartments`. The
existing `historian_side_channel_fail_once` hook (`lib.rs:9667-9678`) fires before
any write and is therefore not this shape.
Confidence: high on the mechanism, medium on coverage —
[evidence](evidence/failed-fenced-transaction-leaves-no-partial-state.md).
Verified the early return at `cortexkit-store:229` precedes `tx.commit()` at 230,
and rusqlite's `Transaction` defaults to rollback on drop.
Existing check: `cortexkit-store:691-712` in the dependency. Nothing in `mc-store`
injects a mid-closure failure. Status `unaudited`.
Impact: a partially applied `commit_transform` would leave overlay tables ahead of
the cache row's `row_version`, so the next CAS would accept a state the overlays
already contradict.
Open questions: None.

### busy-timeout-expiry-aborts-cleanly-without-partial-effect

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:16697-16713` proves a competing raw writer receives
`SQLITE_BUSY` while a fenced transaction holds the write lock, using
`busy_timeout(ZERO)`. Nothing exercises the 5-second expiry on the store's own
connection.
Guarantee: When a statement inside a fenced transaction exhausts the 5-second busy
timeout, the transaction is abandoned with no statement durable, and the caller
receives an error rather than a silent partial write.
Check: `always-or-unreached` — for any fenced write that failed with an underlying
`SQLITE_BUSY`, the touched tables are unchanged. `always-or-unreached` rather than
`always` because the antecedent is a busy expiry, which a campaign may never
produce; the abort promise must hold whenever one occurs.
Fault/timing angle: the window is the 5 seconds set at `cortexkit-store:289`.
Because `with_conn_fenced` uses `BEGIN IMMEDIATE` (`cortexkit-store:191`), the
write lock is taken at `BEGIN`, so busy is much more likely to be reported by
`BEGIN` than by a mid-transaction statement. That is the safer failure: nothing has
been written yet. Mid-transaction busy requires a reader that arrives after `BEGIN`
and blocks a checkpoint or page write.
Required faults and enabling state: a lock holder outside the file lease, held for
longer than 5 seconds, contending with a multi-statement fenced write.
`lib.rs:16697` already builds the out-of-band writer; the test needs it to hold
rather than fail fast.
Confidence: medium —
[evidence](evidence/busy-timeout-expiry-aborts-cleanly-without-partial-effect.md).
Verified there is no retry loop anywhere in production `lib.rs`, and that the error
path returns before `tx.commit()`. Did not construct a mid-transaction busy.
Existing check: `lib.rs:16697-16713`. Status `unaudited`.
Impact: because `StoreError::Backend(e.to_string())` (`cortexkit-store:229`)
discards the SQLite error code, a busy failure reaches the caller as an opaque
string. The caller cannot tell a retryable lock contention from a corrupt database,
so it will either retry a permanent failure forever or surface a transient one as
fatal.
Open questions:

- Is `IMMEDIATE` on every fenced write, including read-mostly ones, taking the
  write lock more often than needed and manufacturing contention that a `DEFERRED`
  read path would avoid? Not measured.

### bounded-cas-retry-never-duplicates-an-effect

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:14153`
`boundary_divergence_counter_cas_loser_does_not_double_increment_and_survives_reopen`
covers a different CAS site. No test drives `set_todo_state` or `arm_soft_refresh`
through a losing attempt.
Guarantee: The read-modify-write loops in `set_todo_state` and `arm_soft_refresh`
terminate within 8 attempts and apply their effect at most once, even when every
intermediate attempt loses the CAS.
Check: `always` — attempt count never exceeds 8, and the observed effect count for
one logical call is exactly 0 or 1. `always` because both bounds must hold on every
call.
Fault/timing angle: the window is between `self.load()` (`lib.rs:6736`, `6763`) and
`self.commit()` (`6746`, `6769`), which are separate transactions. A concurrent
transform committing in that window bumps `row_version` and the CAS rejects, so the
loop re-reads. The loop is what makes the split safe, per the comment at
`lib.rs:6725-6726`. Two things make an effect non-duplicable: `set_todo_state`
short-circuits to `Noop` when the owner and hash already match (6737-6741), and
`arm_soft_refresh` short-circuits when the flag is already set (6764-6766).
Required faults and enabling state: 8 or more successful competing commits landing
between one caller's load and commit. A test needs a hook in the load-to-commit
window; `set_before_max_compartment_end_read_hook` (`lib.rs:5283`) is the existing
hook of this shape but on a different path.
Confidence: high —
[evidence](evidence/bounded-cas-retry-never-duplicates-an-effect.md). Verified both
loops are `for _ in 0..8` (6735, 6762), both short-circuit before writing, both
convert exhaustion into an error at 6754-6756 and 6775-6777.
Existing check: `lib.rs:14153` for a sibling CAS site. Status `unaudited`.
Impact: exhaustion returns `McStoreError::Serde` with a prose message
(`lib.rs:6755, 6776`), which is a misclassification: a contention outcome surfaces
as a serialization error, so a caller cannot retry it correctly.
Open questions:

- Why 8? No comment justifies the bound, and there is no backoff between attempts,
  so a steady writer can starve the loop deterministically. (needs human input)

### write-predicates-are-re-evaluated-inside-the-write-transaction

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:16189`
`state_import_is_atomic_bootstrap_only_and_durably_idempotent` covers the import
path's idempotence. No test races a bootstrap against an import.
Guarantee: At each of the enumerated gated-write sites, the predicate that decides
the write is evaluated inside the same transaction as the write, so no state
observed by an earlier read transaction can change the decision.
Check: `always` — one clause per enumerated site, each with an observable
consequence rather than a claim about source structure. For
`commit_state_import`, a bootstrap committed between the preflight and the commit
must be observed by the commit and must convert the import into a refusal
(`lib.rs:7153-7159`, `:7170`). For `commit_transform`, a competing commit landing
after the caller's snapshot must produce a `CasConflict` rather than an accepted
upsert (`:7354-7358`, `:7390`). For `set_todo_state` and `arm_soft_refresh`, the
split is deliberate and the CAS is the compensation, so the clause is the one in
`bounded-cas-retry-never-duplicates-an-effect`. For the open-path pair, a database
whose recorded family changes between `refuse_pre_cutover_store` (`:4873`) and
`inner.migrate` (`:4874`) must not be migrated. `always` because each clause must
hold at every evaluation of its site, not only under contention.

The scope is a correction. This record previously asserted the universal form,
that *every* gated write shares one transaction handle with its predicate, and its
own confidence line admitted that was verified "by scanning every production `fn`".
That is a property of source structure, not something a workload observes, so the
universal form belongs in a lint or a review checklist. The enumerated sites and
their consequences are what a test can assert.
Fault/timing angle: the window is between a preflight read transaction and the
write transaction. `commit_state_import` closes it correctly, with the comment at
`lib.rs:7167-7169` stating why, and `preflight_state_import` (`:7114-7139`) is
advisory only. The one genuinely split predicate is the open-path pair at `:4873`
and `:4874`, where the runner re-reads the version outside any transaction
(`cortexkit-store:351-357`).
Required faults and enabling state: a second writer committing between the
predicate read and the write. Within one process this is prevented by the
`Mutex<Connection>` at `cortexkit-store:159, 189`; across processes it is prevented
by the file lease at `cortexkit-store:279-282`. So the fault requires a writer that
bypasses the lease, which is the same enabling state `lib.rs:16697` already
constructs.
Confidence: high —
[evidence](evidence/write-predicates-are-re-evaluated-inside-the-write-transaction.md).
Verified by scanning every production `fn` for bodies with two or more connection
acquisitions; only three exist (`lib.rs:4816`, `5069`, `9662`) and the third is
mutually exclusive match arms.
Existing check: `lib.rs:16189`, `lib.rs:14717`
`first_application_marker_is_atomic_and_survives_reopen`. Status `unaudited`.
Impact: the codebase is in good shape here, which is worth recording as a positive
invariant so a future split is caught. The residual risk is the open-path pair at
`lib.rs:4873-4874`, where a database that changes family between the refusal check
and the migration would be migrated after passing a check that no longer describes
it.
Open questions: None.

### migration-and-its-version-record-commit-together

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test kills a process mid-migration.
`cortexkit-store:528` `open_runs_migrations_and_seeds_once` and `:580`
`later_migration_applies_on_top_of_earlier` cover the happy path.
Guarantee: For any migration, either its statements and its
`cortexkit_schema_version` row are both durable, or neither is.
Check: `always` — after any crash and reopen, `EXISTS(row for version v)` implies
every object version v creates is present, and the absence of the row implies none
of them is. `always` because it must hold at every reopen.
Fault/timing angle: the window is `cortexkit-store:366-383`, between
`conn.transaction()` and `tx.commit()`. A kill anywhere inside rolls the whole thing
back and the migration re-runs. Two structural notes narrow the guarantee: the
`CREATE TABLE IF NOT EXISTS cortexkit_schema_version` at 341-349 and the
`MAX(version)` read at 351-357 are outside any transaction, so a crash between them
and the first migration transaction leaves an empty version table, which is
indistinguishable from a fresh database; and `conn.transaction()` at 366 is
DEFERRED, so the write lock is taken at the first statement of the migration rather
than at `BEGIN`.
Required faults and enabling state: `SIGKILL` during
`tx.execute_batch(m.statements)` on a fresh database, then reopen. Because
`MIGRATIONS` is one 878-line statement batch, the kill point is easy to hit but
hard to place precisely. No seam exists in either crate and the runner is
out-of-repo, so this is a subprocess kill or a new hook in a sibling repository.
Confidence: high —
[evidence](evidence/migration-and-its-version-record-commit-together.md). Verified
the transaction spans both the batch (369) and the version insert (375-380) with a
single `commit()` at 381.
Existing check: `lib.rs:16140`
`fresh_and_current_module_stores_open_without_a_pre_cutover_refusal` and
`cortexkit-store:528`. Both happy-path. Status `unaudited`.
Impact: a recorded-but-unapplied version would make `refuse_pre_cutover_store` pass
a database whose schema does not exist, and the first query would fail on a missing
table.
Open questions:

- Does SQLite roll back a partially executed `execute_batch` of DDL inside an
  explicit transaction in all cases, including implicit commits from statements that
  cannot run transactionally? I found no such statement in the batch, but did not
  enumerate all 878 lines against the list of statements that force a commit.

### recorded-schema-version-cannot-disagree-with-the-actual-schema

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:16069`
`schema_version_probe_reads_the_live_store_and_matches_the_shipped_ceiling`
asserts the probe equals `LATEST_MIGRATION_VERSION` on a freshly created store. It
does not check that the schema objects match.
Guarantee: If `module_store_schema_version()` returns 57, every object the
version-57 bootstrap declares exists in `main.sqlite_schema` with the declared
shape.
Check: `always` — compare the live `main.sqlite_schema` inventory for `store.db`
against an **independently derived** expected object set, and assert agreement.
`always` because any query against the store depends on the agreement holding at
that moment. The expected set must be derived independently of the bootstrap
string the check audits; re-deriving it from that same string would be a tautology.

The scope is a correction, in two directions. This record previously mixed four
divergence mechanisms into one claim; two of them have moved. A crash between the
migration commit and the post-migration repairs at `lib.rs:4902-4903` alters *data*
rather than schema and belongs to
`post-migration-open-repair-is-resumable-and-effect-idempotent`, which already owns
resumability. `recorded_mc_cache_version` mapping a recorded `0` to `None` at
`lib.rs:1364`, so a database with a literal `0` version row is treated as pristine,
is a version-admission question and is queued as a gap in
`portfolio-evaluation.md` alongside the missing refusal for a version above 57. The
record now stands on the out-of-band divergence risk alone. Also: the document this
record leaned on is scoped to a different database. The "exact `main.sqlite_schema`
inventory" promise at `docs/migration-version-lanes.md:11-17` sits under "Format
identity" in a file titled "Context database format", so it governs `context.db`.
Only the "Runtime contract" section (`:41-48`) extends to `store.db`, and it names
foreign keys, WAL, busy timeout, and synchronous mode, with no inventory.
Fault/timing angle: an out-of-band writer that alters the schema without touching
`cortexkit_schema_version`. Nothing prevents this, because the version lives in an
ordinary table rather than in `PRAGMA user_version`.
Required faults and enabling state: a raw connection that drops or alters a table,
then a reopen through `McStore::open` and a schema-inventory comparison.
Confidence: medium —
[evidence](evidence/recorded-schema-version-cannot-disagree-with-the-actual-schema.md).
Verified the version storage and read path at `cortexkit-store:341-357` and
`lib.rs:5348-5358`. Did not build the full declared-object inventory from the
878-line bootstrap.
Existing check: `lib.rs:16069`, `lib.rs:16089`
`pre_cutover_module_store_is_refused_by_family_not_by_ddl_collision`. Neither
compares the inventory. Status `unaudited`.
Impact: for `store.db` there is no inventory check, so a divergence surfaces as a
missing-table error at first use rather than as a refusal at open.
Open questions:

- Is a cheap manifest comparison available? Not from
  `compute_schema_manifest_digest` (`sqlite_runtime.rs:156-167`), which this
  record's earlier open question credited with exactly that. Verified it does not:
  it digests a supplied component manifest of `name`/`dependsOn`/`provides` tuples
  and never reads `main.sqlite_schema`, so it compares declarations to
  declarations. An independent inventory has to come from somewhere else. (needs
  human input)

### post-migration-open-repair-is-resumable-and-effect-idempotent

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:18124`
`note_artifact_repair_verifies_digest_or_clears_compiled_state` and `lib.rs:18905`
`v51_repair_keeps_a_legacy_artifact_that_has_no_recorded_digest` cover the repair's
semantics. Neither kills the process between a batch commit and the flag insert.
Guarantee: `repair_note_artifacts_v51` produces the same final state whether it
runs once to completion or is killed and restarted any number of times, and it
never advances a note revision.
Check: `always-or-unreached` — the repair body only runs while the sentinel flag
row is absent, so on most opens it is skipped entirely; when it does run it must be
idempotent. `always-or-unreached` rather than `always` precisely because the skip at
`lib.rs:5078-5080` makes the path optional.
Fault/timing angle: two windows. Between a batch commit at `lib.rs:5099` and the
next loop iteration, restart re-selects only unrepaired rows via
`compiled_source_revision IS NULL` at 5084, so work already done is not redone.
Between the last batch and the flag insert at 5105-5112, restart re-runs the whole
selection, finds nothing, and inserts the flag. Both are safe by re-selection, not
by transaction.
Required faults and enabling state: no kill is needed. The repair holds no
in-memory progress across batches: the project list is re-derived on every open,
and all progress lives in `compiled_source_revision IS NULL` (`lib.rs:5084`) plus
the sentinel row (`:5070-5077`). So the four committed-prefix states a kill could
leave are constructible directly by SQL and then reopened. The realistic fixture is
a store with more than `NOTE_ARTIFACT_REPAIR_BATCH` (500, `lib.rs:2948`) unrepaired
note rows spread across at least two projects, with the first batch's effects
already committed.
Confidence: high —
[evidence](evidence/post-migration-open-repair-is-resumable-and-effect-idempotent.md).
Verified the flag read (5071-5077), the batch loop (5097-5103), and the separate
flag-insert transaction (5105-5112) are four distinct transactions, and that the
driving query filters on `compiled_source_revision IS NULL`.
Existing check: `lib.rs:18124`, `lib.rs:18905`, `lib.rs:18072`
`migration_v51_backfill_initializes_revisions_and_normalizes_check_status`. Status
`unaudited`.
Impact: a non-idempotent repair would either advance note revisions on every boot,
invalidating downstream compiled artifacts, or loop forever on a row it cannot
repair.
Open questions:

- The completion flag is a sentinel row in `mc_cache_state` with
  `session_id = "note_artifact_repair_v51_done"` (`lib.rs:5070, 5107-5109`).
  `delete_session` (`lib.rs:5432`) deletes by `session_id` across every table with
  that column. Can any caller pass the sentinel key and clear the flag? Not
  resolved; needs a caller audit outside this lens's scope.

## Group C: the claim mirror projection

Nine records on a projection of an authority that lives outside this store. The
mirror is not a cache and not a second source of truth: every mutation is push-only
from the source, there is no fill path and no method that derives a mirror row from
anything in `mc_cache`, and the only two writers, `replace_claim_mirror_snapshot`
(`claim_mirror.rs:756-860`) and `apply_claim_mirror_receipt` (`:863-1124`), both
take a fully hydrated payload minted elsewhere. Divergence from the source is
therefore *prevented at admission*, never *detected after the fact*: the first four
records are the four admission checks, the next two are the read fences that
consumers rely on, and the last three are the reset cycle and the control row that
gates it, which production never populates. There is no reconciliation pass, no
digest comparison against the source, and no repair path.

### mirror-receipt-replay-applies-effects-once

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_mirror.rs:177-250` applies one receipt and
replays the identical bytes, asserting `applied_effect_count` then `replayed`. It
does not cover a replay interleaved with an intervening receipt, a replay after
reopen, or a replay racing a concurrent apply.
Guarantee: For one `(database_incarnation_id, receipt_id)`, the mirror absorbs that
receipt's effects exactly once no matter how many times
`apply_claim_mirror_receipt` is called with the same bytes.
Check: `always` — after any number of applies of a fixed receipt, per public claim
ID the mirror row equals the row implied by applying the effect set once, and the
project's `acked_effect_id` equals the receipt's last effect ID for that project;
count `replayed: false` returns and assert exactly one. `always` because the dedup
lookup at `claim_mirror.rs:921-928` runs on every call, so the property is evaluable
at every apply rather than only on an optional path.
Fault/timing angle: The window is between the caller issuing the apply and observing
its result. A lost response makes the caller retry with identical bytes, which is
the whole reason the dedup row exists. Because the dedup insert
(`claim_mirror.rs:1097-1113`) and the effects share one IMMEDIATE transaction
(`:885`), a crash cannot leave effects applied without the dedup row.
Required faults and enabling state: A seeded mirror (`replace_claim_mirror_snapshot`
first, or `NotSeeded` at `:894-896`). Then a dropped or delayed apply response, and
a caller retry. To exercise the interesting variant, apply receipt N, apply receipt
N+1, then replay N.
Confidence: high — [evidence](evidence/mirror-receipt-replay-applies-effects-once.md).
Read the dedup lookup, the digest computation over the whole canonical group, and
the single-transaction boundary; confirmed `with_conn_fenced` is one IMMEDIATE
transaction.
Existing check: `crates/mc-store/tests/claim_mirror.rs:177-250`
(`u10_scenario_2_complete_receipt_group_is_atomic_and_replay_safe`), status
`unaudited`.
Impact: A replayed receipt applied twice would double-advance `acked_effect_id`,
which then rejects the genuine next receipt with `CheckpointMismatch` and wedges the
claim lane for that project until a reseed, which
`mirror-reset-cycle-requires-a-rebuild-grant` shows production cannot perform.
Open questions:

- Does the facade retry `claim.mirror.apply` on a lost response, and with
  byte-identical bytes? `mc-module/src/lib.rs:10326` is the call site; the retry
  policy above it was not traced in this pass.

### mirror-receipt-conflict-rejects-divergent-replay

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test reuses a receipt ID with different bytes.
`tests/claim_mirror.rs:223-232` replays identical bytes only; `:592-624` covers a
different guard (equal revision, different content, fresh receipt).
Guarantee: A second receipt presenting an already-recorded `receipt_id` with any
different byte is refused with `ReceiptConflict` and mutates nothing.
Check: `always-or-unreached` — for every apply whose `receipt_id` is already
present, the result is `ReceiptConflict` unless the recomputed group digest equals
the stored one, and the mirror is byte-identical before and after the refused call.
`always-or-unreached` because the antecedent is a reused receipt ID, which most
campaigns never produce.

The rationale is a correction, and the old one was a category error rather than a
slip. It argued `always` "because the comparison at `claim_mirror.rs:929-939` is on
the same unconditional path as the accepted-replay case". The dedup *lookup* at
`:920-927` does run on every apply, but the comparison arm is entered only through
`if let Some(stored_digest) = replay` at `:928`. An unconditional lookup is not an
unconditional comparison.
Fault/timing angle: None required. This is an admission check, not a race. The
relevant hazard is a source that reuses receipt IDs across a rebuild it did not
announce.
Required faults and enabling state: A seeded mirror with receipt R applied. Then
apply a group with `receipt_id = R` and any altered field: a changed effect payload,
a different vector, a different `expected_effect_count`.
Confidence: high —
[evidence](evidence/mirror-receipt-conflict-rejects-divergent-replay.md). Verified
the digest at `claim_mirror.rs:501-505` covers the serialized whole group, so no
field is outside the comparison.
Existing check: none for the conflict arm. The identical-replay arm is covered at
`tests/claim_mirror.rs:223-232`, status `unaudited`.
Impact: Without it, a source that restarted its receipt numbering would have its new
effects silently swallowed as a replay, and the mirror would diverge from the
authority with no error and no detection point.
Open questions: None.

### mirror-project-effect-chain-detects-omission

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_mirror.rs:304-320` skips one effect and asserts
`CheckpointMismatch`. Only the single-project, single-gap case; no multi-project
interleave where another project occupies the intervening global effect IDs, which
is the case the design comment at `claim_mirror.rs:100-102` names as the reason the
field exists.
Guarantee: A receipt that omits an effect, reorders effects, or starts from the
wrong position is refused, so the mirror's `acked_effect_id` only ever advances
along the source's per-project effect chain with no gap.
Check: `always` — for each effect in receipt order, `previous_project_effect_id`
equals the running checkpoint for that project, seeded from the stored
`acked_effect_id`; the whole group is refused otherwise. `always` because
`claim_mirror.rs:992-1006` walks every effect of every accepted receipt.
Fault/timing angle: None. Admission-time structural check. It is the mirror's only
defence against a source that drops an effect while still numbering the rest
correctly, since the group-level count check (`claim_mirror.rs:426-433`) only catches
a count that disagrees with the array length.
Required faults and enabling state: A seeded mirror with at least two projects.
Build a receipt whose effects for project A skip one of A's outbox positions while
project B's effects occupy the intervening global IDs, so the contiguous-global-ID
check at `claim_mirror.rs:435-448` still passes and only the per-project chain can
catch it.
Confidence: high —
[evidence](evidence/mirror-project-effect-chain-detects-omission.md). Traced both
the contiguity check and the per-project chain and confirmed they catch different
classes.
Existing check: `crates/mc-store/tests/claim_mirror.rs:304-320`, status `unaudited`.
Impact: A silently accepted omission leaves the mirror missing a claim the authority
has, with `acked_effect_id` advanced past it, so no future receipt can repair it.
That is the "omits one it does have" divergence, made permanent.
Open questions:

- `previous_project_effect_id` is validated only as `0 <= value < effect_id`
  (`claim_mirror.rs:454-461`). Is a source permitted to emit `0` for a project's
  first effect after a reseed whose checkpoint is nonzero? The reseed sets
  `acked_effect_id` from `project_checkpoints` (`:842`), so a nonzero checkpoint plus
  a `0` predecessor is a `CheckpointMismatch`. Whether the host can produce that pair
  is a host-side question. (needs human input)

### mirror-generation-advances-exactly-one-per-touched-project

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_mirror.rs:290-303` asserts one wrong generation is
refused, and `:528-591` asserts untouched rows are restamped. Neither covers the
untouched-project arm, where a receipt must present `stored + 0` for a project it
does not touch.
Guarantee: An accepted receipt advances each touched project's `project_generation`
and `policy_generation` by exactly one and leaves untouched projects unchanged, so
the mirror's generation vector is a faithful counter of receipts applied per
project.
Check: `always` — for every accepted receipt, for every project the mirror tracks,
the receipt's generation equals the stored generation plus one when the receipt names
that project and plus zero when it does not, and the same for policy generation.
`always` because `claim_mirror.rs:963-990` iterates every stored project on every
accepted apply.
Fault/timing angle: None directly. The property matters because two *other*
mechanisms depend on it: the reseed row-equality comparison
(`claim_mirror.rs:794-805`) and the optimistic read fence at `transform.rs:2008`
(see `mirror-read-fence-relies-on-generation-advance`).
Required faults and enabling state: A seeded mirror with two projects at known
generations. Submit receipts that touch one, the other, and neither, and submit
off-by-one and off-by-two vectors in each direction.
Confidence: high —
[evidence](evidence/mirror-generation-advances-exactly-one-per-touched-project.md).
Read the `increment = i64::from(touched.contains(project_id))` construction and both
mismatch arms.
Existing check: `crates/mc-store/tests/claim_mirror.rs:252-342` and `:528-591`,
status `unaudited`.
Impact: A generation that advances by the wrong amount breaks the reseed comparison,
producing a permanent `ResetRequired` that production cannot clear, and silently
weakens the read fence that consumers rely on to notice a mirror change.
Open questions:

- Policy generation is required to move in lockstep with project generation
  (`claim_mirror.rs:972-989`), yet `ClaimMirrorChangeKind` distinguishes an
  `Applicability` or `Verification` change from an `Upsert` (`:58-68`). Is a
  policy-only change really required to bump the project generation too? Nothing in
  this crate explains why the two counters cannot move independently. (needs human
  input)

### mirror-read-fence-relies-on-generation-advance

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — nothing constructs a mirror mutation that changes
`acked_effect_id` without changing a generation, which is the only case that would
distinguish the two fence strengths.
Guarantee: The optimistic double-read fence in `transform.rs` detects every mirror
mutation that lands between its two state reads, even though it compares only the
canonical snapshot vector and not `acked_effect_id`.
Check: `always` — for every mirror mutation, the canonical snapshot vector before
and after differ. Equivalently: no accepted mutation changes any project's
`acked_effect_id` while leaving that project's generation pair unchanged. `always`
because it must hold for every mutation for the fence to be sound; there is no
optional path.
Fault/timing angle: The window is `transform.rs:1978` to `:2004`, three separate
store calls with no shared transaction. A receipt applied concurrently in that window
must be caught by the `:2008` comparison. `historian_chunk.rs:605` compares the whole
`ClaimMirrorState` and so does not depend on this property; `transform.rs` does.
Required faults and enabling state: A seeded mirror and a concurrent
`apply_claim_mirror_receipt` landing between the two `claim_mirror_state()` calls.
The coverage form asserts the independent preconditions: the fence executed both
reads, and at least one receipt committed between them.
Confidence: medium —
[evidence](evidence/mirror-read-fence-relies-on-generation-advance.md). The coupling
holds in the code as read: `:963-990` forces a generation bump for touched projects
and `:1064-1096` restamps only touched projects. Confidence is medium because neither
site documents the dependency and I could not find a design note stating it is
intended to be permanent.
Existing check: none. `transform.rs:1978-2011` is the mechanism, not a check of it.
Impact: If a future mutation advanced a checkpoint without a generation bump,
`transform.rs` would serve claim memory assembled from a mirror that changed
mid-read, and the mismatch would be invisible. `historian_chunk.rs` would still catch
it, so the two paths would disagree.
Open questions:

- Why do `transform.rs:2008` and `historian_chunk.rs:605` compare different things?
  If the full-state comparison is correct, transform's is weaker than intended; if
  the vector comparison is correct, historian's is needlessly strict and will bail
  out more often. (needs human input)

### mirror-reset-cycle-requires-a-rebuild-grant

Type: reachability
Reachability: test-only
Status: active
Exercised: yes — `tests/claim_mirror.rs:377-458` and `:482-517` drive the whole
cycle, and `tests/claim_intent_ledger.rs:288-335` drives the grant. Every one of
these calls `begin_claim_store_rebuild` directly from test code.
Guarantee: The mirror's destructive paths — dropping all four tables and reseeding
with different content — are reachable at all from a production entry point, which
requires `begin_claim_store_rebuild` to have set `transition_state = 'resetting'`.
Check: `reachable` — the reseed's clear-and-insert at `claim_mirror.rs:816` and the
delete's clear at `:1148` are each executed at least once per campaign by a path that
begins at a production entry point. `reachable` and not `always` because this is
location coverage: the claim under test is that these two code points can be reached
at all from something production can call.

Scope note. This record was split. It previously carried two opposite claims about
the same two code points: whether the valid clear path can be entered, and whether
the invalid one is kept out. This record keeps the first, which fails today. Its
sibling `mirror-clear-without-a-grant-is-never-entered` keeps the second, which
passes today. They share the same two markers and expect opposite outcomes under
different campaign preconditions, which is why one record could not hold both.
Fault/timing angle: None. This is a reachability claim about the production call
graph, not a race.
Required faults and enabling state: None. It needs a production caller of
`begin_claim_store_rebuild`, and searching `crates/` and `packages/` finds none: the
only references are `tests/claim_intent_ledger.rs:299,313`,
`tests/claim_mirror.rs:331,454,498`, and two doc comments at
`claim_mirror.rs:219,754`.
Confidence: high — [evidence](evidence/mirror-reset-cycle-requires-a-rebuild-grant.md).
Verified the absence of a production caller by grep across both source trees, and
verified the two fail-closed readers latch when the control row is absent:
`claim_mirror.rs:806-808` and `:1136-1147` with its `unwrap_or(false)`.
Existing check: `crates/mc-store/tests/claim_mirror.rs:377-458`, `:461-479`,
`:482-517`; `crates/mc-store/tests/claim_intent_ledger.rs:288-335`. All status
`unaudited`. Every one supplies the grant from test code, so none of them witnesses
production reachability.
Impact: In production the mirror is write-once per incarnation. Once seeded, any
snapshot that is not byte-identical returns `ResetRequired`
(`claim_mirror.rs:806-808`) and `delete_claim_mirror` always returns
`ResetRequired`. A mirror that has diverged, or a source that wants to re-baseline,
has no recovery short of a new `database_incarnation_id`. The doc comments at
`claim_mirror.rs:754-755` and `:1126-1127` describe an operable reset cycle that
production cannot enter.
Open questions:

- Is `begin_claim_store_rebuild` intended to be reachable from the host, and if so
  through which facade method? Nothing in `mc-module` exposes it. (needs human input)
- Does a new `database_incarnation_id` fully substitute for a reset? The data tables
  are all keyed by incarnation (`lib.rs:1268`, `:1289`, `:1309`), so a fresh
  incarnation gives a clean namespace, but `replace_claim_mirror_snapshot` also
  compares the control row's incarnation (`claim_mirror.rs:778-785`), and old rows are
  never garbage-collected.

### mirror-clear-without-a-grant-is-never-entered

Type: reachability
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_mirror.rs:461-479`
(`u10_scenario_7_equivalent_restart_seed_is_idempotent`) seeds the same snapshot
twice with no grant and asserts both succeed (`:470-471`), then mutates one
checkpoint and asserts `ResetRequired` (`:474-478`). That is the reseed refusal arm
proved by return value. Nothing covers the delete refusal arm with no grant, and
nothing observes non-entry at either clear statement.
Guarantee: Within a campaign that never calls `begin_claim_store_rebuild`, neither
destructive clear of the four mirror tables executes.
Check: `unreachable` — under the stated campaign precondition that
`begin_claim_store_rebuild` is never called, the clear statements at
`claim_mirror.rs:816` and `:1148` must never execute. `unreachable` rather than
`always(!X)` because the campaign precondition makes this a code-location claim
rather than the compound durable state METHOD.md sends to `always(!X)`: two named
statements must stay cold, and the oracle is marker non-entry plus the returned
error, never an observation that the tables were cleared.
Fault/timing angle: None inside the operation. Each guard and its clear share one
`with_conn_fenced` transaction, so the decision cannot go stale before the effect.
Required faults and enabling state: A seeded mirror, then both destructive entry
points driven with the grant absent: `replace_claim_mirror_snapshot` with a snapshot
differing in the vector, in a checkpoint, and in a claim row, each separately,
expecting `ResetRequired`; and `delete_claim_mirror` with no unresolved intents,
expecting `ResetRequired` rather than `ResetBlocked` so the refusal is attributable
to the missing grant rather than to the unresolved-intent check above it. Repeat both
with a control row present in every non-`resetting` state, which needs a
32-lowercase-hex incarnation and is therefore blocked on
`intent-control-transition-write-is-silently-dropped`.
Confidence: high —
[evidence](evidence/mirror-clear-without-a-grant-is-never-entered.md).
`clear_claim_mirror` (`:702-708`) drops all four tables in four unconditional
statements and has exactly two call sites; the reseed guard at `:806-808` fails
closed because `matches!(None, Some(_))` is false; the delete guard at `:1136-1147`
fails closed through `.optional()?.unwrap_or(false)`. Also verified no cascade can
empty the mirror from outside those two functions: of 42 tables in the bootstrap only
two carry a `REFERENCES` clause, and no mirror table carries a `session_id` column
for `delete_session` to reach.
Existing check: `tests/claim_mirror.rs:461-479` for the reseed arm. Status
`unaudited`.
Impact: A future edit that aligns these two guards with the apply gate's
`if let Some(control)` shape would make them permanently open, because no production
path writes the control row. Then an ordinary host restart seed that differs from
durable state would drop all four tables and rebuild from the incoming snapshot,
silently losing every claim the snapshot omits, with no error to the caller and no
production reset path to recover through.
Open questions:

- Should the two guards share one derivation of `resetting`? The same singleton row
  has three independent derivations: a Rust `matches!` in the reseed (`:806`), a SQL
  boolean with `unwrap_or(false)` in the delete (`:1136-1144`), and an
  `if let Some(control)` with no `else` in the apply (`:908-919`). Two fail closed,
  one fails open, and no design note says which is canonical. A shared reader would
  make this record structurally true rather than incidentally true. (needs human
  input)

### mirror-accepting-gate-is-skipped-when-control-is-absent

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test applies a receipt while the control row says
`draining`, and no test asserts that an absent control row permits an apply. The
absent-row case is the production default
(`mirror-reset-cycle-requires-a-rebuild-grant`), so every existing apply test runs
through it without asserting it.
Guarantee: A receipt is applied only when the intent ledger is not mid-reset, and
when the ledger's state cannot be determined the mirror refuses rather than
proceeds.
Check: `always` — whenever the control row exists, an apply succeeds only if
`transition_state = 'accepting'`; when it does not exist, the apply must be refused.
`always` because the check asserts a required outcome for **both** the present and
the absent control row, so the two arms are total and the property is evaluable on
every apply rather than only when the gate at `claim_mirror.rs:908-919` is entered.

The semantics are a correction, in the direction of strength. This record previously
carried `always-or-unreached` on the grounds that the gate sits behind
`if let Some(control)`. That framing scoped the property to the arm that exists. The
absent-row arm is the one that fails today, since `if let Some(control)` has no
`else` and an absent row is treated as permission, and a failing arm is a claim under
test rather than a reason to weaken the semantics.
Fault/timing angle: The window is a reset in progress: `begin_claim_store_rebuild`
has set `resetting`, and a receipt minted before the reset arrives afterwards. With
the row present the gate refuses it with `ResetRequired`. With the row absent there
is no gate.
Required faults and enabling state: A seeded mirror. Case one: set the control to
`draining` or `resetting`, then apply a valid receipt, and assert `ResetRequired`.
Case two: no control row at all, then apply, and observe that it succeeds.
Confidence: high —
[evidence](evidence/mirror-accepting-gate-is-skipped-when-control-is-absent.md).
Read the `if let Some(control)` shape and compared it against the two fail-closed
readers. `delete_claim_mirror:1143-1144` uses `.optional()?.unwrap_or(false)`, which
treats an absent row as not-resetting and refuses; `apply_claim_mirror_receipt:908-919`
treats an absent row as permission. The asymmetry is in one file, twelve lines apart
in behaviour.
Existing check: none.
Impact: Today the absent row is the production norm and no reset ever runs, so the
hole is latent. If `begin_claim_store_rebuild` is ever wired to production, this
becomes the difference between a reset that fences in-flight receipts and one that
races them.
Open questions:

- Is fail-open correct here on the reasoning that a store with no control row has no
  ledger to fence? If so, the reasoning is nowhere in the file, and the neighbouring
  `delete_claim_mirror` chose the opposite default.

### mirror-staleness-undetectable-on-memory-tool-read-path

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test reads through `list_committed_claims` with a mirror
deliberately behind the authority, because nothing in the store can express "behind
the authority".
Guarantee: Every production consumer of committed mirror claims either verifies the
mirror's snapshot vector against an expected value or is documented as accepting
arbitrarily stale data.
Check: `always` — for every production read of `list_claim_mirror`, the reading
function either compares the mirror's canonical snapshot vector against a
caller-supplied expected vector, or carries an explicit statement that staleness is
acceptable. `always` because it is a property of the whole read surface, evaluable at
every read site.

One scoping note the check needs. Only the read-surface enumeration is checkable in
this tree. The consequence half, that a caller observed claims from a mirror that was
actually behind the authority, is **not** expressible anywhere in these three crates,
because "behind the authority" is a fact about a store this repository does not read.
Any assertion about observed staleness is blocked on a cross-language contract rather
than on effort, and the fault map records it as such.
Fault/timing angle: The window is unbounded: there is no freshness bound anywhere.
`mc_claim_mirror_state.updated_at_ms` is written at `claim_mirror.rs:827` and
`:1114-1117` and never read by any statement in the tree, so age is not even
observable.
Required faults and enabling state: A seeded mirror plus a source that stops
delivering receipts, for example because a receipt was refused with
`CheckpointMismatch` and the lane wedged. Then read through `list_committed_claims`.
Confidence: high —
[evidence](evidence/mirror-staleness-undetectable-on-memory-tool-read-path.md).
Enumerated the production read sites: `lib.rs:7368-7377` (atomic, in-transaction),
`transform.rs:1978-2011` (optimistic double-read against an expected vector),
`historian_chunk.rs:563-608` (same, stronger comparison), and `memory_tool.rs:57-67`
(no comparison). Verified `updated_at_ms` is written but never selected.
Existing check: none for the unfenced path. The fenced paths are mechanisms, not
checks.
Impact: `list_committed_claims` can surface committed claim memory from a wedged
mirror indefinitely, with no error and no signal to the caller, while the two assembly
paths correctly go quiet. The system degrades inconsistently: some surfaces notice,
one does not.
Open questions:

- Is `list_committed_claims` a tool-facing read where the caller already knows the
  mirror may lag? Its signature takes no expected vector, so it cannot check even if it
  wanted to. Whether that is intended is a design decision. (needs human input)

## Group D: the claim intent ledger

Four records on the durable row that records a claim command staged *before* the host
mutated `context.db`. An intent is keyed by `(producer, operation_key)` alone
(`lib.rs:1230`), carries a request digest and a four-field binding that are verified
but not keyed, and moves through four states whose whole transition table is one
`match` at `lib.rs:11225-11255`. The first record is the ledger's own control row,
whose only working writer has no production caller and whose other writer returns
success without writing; the remaining three are identity, absorption of the terminal
states, and the one window where a crash can produce a second context effect. Note
that the ledger's drain fence survives the broken control row, because
`claim_intent_stage_fence` also resolves the live authority from the bound route
(`lib.rs:4062-4073`), so Group D's control-row defect is a mirror problem rather than
a ledger problem.

### intent-control-transition-write-is-silently-dropped

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test asserts that a control row appears after an authority
transition. `tests/claim_intent_ledger.rs:178-179` and `:169-228` deliberately assert
the *authority-row* fence instead, and the comment at `:11-15` shows the fixture was
built to make the control row absent.
Guarantee: A request to move the intent ledger's transition state either records the
new state or reports a failure. It never returns success having written nothing.
Check: `always` — for every call to `set_claim_intent_transition_tx` that returns
`Ok`, `mc_claim_intent_controls` afterwards holds the requested `transition_state`.
`always` because the function has exactly one success contract and the property must
hold on every call.
Fault/timing angle: None. It is an unconditional early return, not a race.
Required faults and enabling state: None beyond an authority transition on the
`memories` domain with a `context_store_uuid` that is not 32 lowercase hex.
`authority_begin_prepare` (`lib.rs:11434-11440`), `authority_finish_prepare`
(`:11640-11651`), and both `authority_begin_drain` arms (`:11738-11744`,
`:11790-11796`) all pass `context_store_uuid`. A dashed UUID is the production shape
per `tests/claim_intent_ledger.rs:11-15`.
Confidence: high —
[evidence](evidence/intent-control-transition-write-is-silently-dropped.md).
Verified `is_lower_hex` requires exactly 32 chars of `[0-9a-f]`
(`mc-core/src/claim_operation.rs:173-178`), verified all four call sites pass
`context_store_uuid`, and verified the test suite's own comment states production
mints that value as `randomUUID()`.
Existing check: none.
Impact: The `draining` and `accepting` states are never recorded from authority
transitions, so three of the mirror's four control-row readers never see the state the
authority is actually in. The visible consequences are
`mirror-reset-cycle-requires-a-rebuild-grant` and
`mirror-accepting-gate-is-skipped-when-control-is-absent`. A second consequence is
that the column named `database_incarnation_id` (`lib.rs:1242-1243`) would, if the
guard ever passed, hold a `context_store_uuid`, which `claim_mirror.rs:778-785` and
`:909-915` compare for equality against a real incarnation ID and would reject.
Open questions:

- Is the early return a deliberate "callers may pass a non-incarnation identity,
  ignore it" contract, or an unnoticed mismatch between the parameter's name and what
  every caller supplies? The parameter is named `database_incarnation_id` and every call
  site passes `context_store_uuid`, which `lib.rs:4062-4065` explicitly says are minted
  independently. (needs human input)

### intent-identity-is-producer-and-operation-key

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_intent_ledger.rs:133-166` covers restart survival
(`:148-151`), an incarnation binding mismatch (`:153-161`), and a digest conflict
(`:162-165`). `format_epoch`, `authority_project`, and `authority_generation`
mismatches on an existing row are not covered, and neither is a second producer using
the same `operation_key`.
Guarantee: One intent is identified by `(producer, operation_key)` alone; a second
request under that key is accepted as a replay only if its request digest and all four
binding fields match the stored row, and is otherwise refused without mutating it.
Check: `always-or-unreached` — for every stage or acknowledge against an existing key,
the call returns `IdentityConflict` on a digest mismatch, `BindingMismatch` on any
binding field mismatch, and only otherwise proceeds; the stored row is unchanged in
both refusal cases. `always-or-unreached` rather than `always` because the antecedent
is a recurring key, and a campaign of first-time stages never evaluates it; the
refusal contract must hold whenever a key recurs.
Fault/timing angle: None required for the identity checks. The identity matters under
retry: a producer that reuses an operation key for a semantically different request
must be refused rather than silently served the earlier result.
Required faults and enabling state: A staged intent. Then re-stage the same key with a
different request body, with each of the four binding fields altered in turn, and
acknowledge with a wrong digest.
Confidence: high —
[evidence](evidence/intent-identity-is-producer-and-operation-key.md). Read the
primary key, both refusal sites, and `require_claim_intent_binding`'s field list.
Existing check: `crates/mc-store/tests/claim_intent_ledger.rs:133-166`, status
`unaudited`.
Impact: If the digest check were bypassed, a reused operation key would return another
request's committed result to the caller, which is a wrong-answer bug rather than a
lost-work bug. `producer` is caller-supplied and unvalidated beyond length
(`lib.rs:1216`, `:3838-3847`), so the namespace's integrity is entirely the caller's
to maintain.
Open questions:

- Is `producer` authenticated anywhere above this layer? Within `mc-store` it is an
  opaque 1..=256-byte string, so any caller can stage into any producer's namespace. Not
  traced in this pass.

### intent-terminal-state-is-entered-at-most-once

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_intent_ledger.rs:85-131` walks staged to
context-committed to acknowledged, and `:169-228` and `:346-401` reach
terminal-rejected. No test attempts an illegal transition out of a terminal state, and
none asserts that a repeated acknowledge of a terminal row is a no-op rather than a
rewrite.
Guarantee: `acknowledged` and `terminal-rejected` are absorbing: once entered, no
acknowledgement changes the row's state or its `result_json`, and a committed intent
can never become rejected.
Check: `always-or-unreached` — for every acknowledge against a row already in a
terminal state, either the call returns `replayed: true` with the row byte-identical,
or it returns a `Transition` error; the row's `state` and `result_json` are unchanged in
both cases. `always-or-unreached` rather than `always` because the antecedent is a row
already terminal, which a campaign that never re-acknowledges never produces; the
absorption must hold whenever it does.
Fault/timing angle: The window is a lost acknowledgement response causing a retry,
which must be a no-op, versus a genuinely late duplicate acknowledgement of a different
kind, which must be an error. Both land in the same `match`.
Required faults and enabling state: A staged intent. Drive it to each terminal state
and then attempt every combination of `ClaimIntentAckKind` against it, including
`TerminalRejected` against `context-committed` and against `acknowledged`, which must
both fail.
Confidence: high —
[evidence](evidence/intent-terminal-state-is-entered-at-most-once.md). Enumerated all
twelve `(kind, state)` pairs against the `match` arms and confirmed the `UPDATE` at
`:11256-11268` is reached only when `next_state` is `Some`.
Existing check: `crates/mc-store/tests/claim_intent_ledger.rs:85-131`, `:169-228`,
`:346-401`. All status `unaudited`.
Impact: A terminal state that could be re-entered or overwritten would let a rejection
replace a committed result, or let a retry rewrite `result_json` under a caller that
already read the first value.
Open questions:

- `(Acknowledged, TerminalRejected)` returns `replayed: true` and writes nothing
  (`lib.rs:11235-11236`), so the fact that a rejection was delivered to its producer is
  recorded nowhere. Is settlement of a rejection meant to be observable? The doc at
  `mc-core/src/claim_operation.rs:368-369` calls `acknowledged` "transport settlement,
  not a second semantic claim state", which argues the no-op is deliberate, but then a
  rejection's settlement is simply unobservable.

### intent-staged-replay-produces-one-context-effect

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_intent_ledger.rs:337-401` proves a staged replay is
refused once the authority is draining, which is the fence, not the effect count.
Nothing in this crate observes the context effect, because the effect lands in a
different database.
Guarantee: A crash between staging an intent and recording its context commit is
recoverable, and the recovery replay produces at most one durable context effect for
that intent.
Check: `always-or-unreached` — per `(producer, operation_key)`, the number of durable
context effects attributable to that intent is at most the number of stage attempts
that passed the fence and at least the number of intents that reached
`context-committed`. Per-identity equality against the intent's own `result_json`
effect list is the primary oracle; the attempted-versus-acknowledged bounds are the
cheap screen. `always-or-unreached` rather than `always` because the antecedent is a
replay of an already-staged intent, which is an optional event; per-identity because
aggregate effect totals cancel across intents.
Fault/timing angle: Two distinct windows, and only the second is dangerous. Staging
commits in one `with_conn_fenced` transaction in `mc_cache` (`lib.rs:11037`); the
context mutation lands in `context.db`; the acknowledgement is a third transaction
(`:11195`). A crash after staging and before the mutation leaves `staged`, and the
replay correctly re-runs the mutation. A crash **after** the mutation and before the
acknowledgement also leaves `staged`, and the replay re-runs the mutation a second
time. The comment at `lib.rs:11064-11070` states plainly that "a replay goes on to
execute the context mutation", so the store deliberately does not make this decision;
idempotence must come from the context mutation being keyed by the same identity.
Required faults and enabling state: A route at `MODULE` authority. No crash seam is
needed: the post-crash state is exactly a persisted `staged` row, which
`tests/claim_intent_ledger.rs` already constructs, and re-driving the stage enters the
replay path at `lib.rs:11048-11073`. What remains genuinely unavailable is the oracle:
counting durable effects requires reading `context.db`, which is outside these three
crates.
Confidence: medium —
[evidence](evidence/intent-staged-replay-produces-one-context-effect.md). The two
windows and the replay path are verified in this crate. Confidence is medium because
the effect side lives in `context.db` behind the host, which this pass did not read, so
whether the mutation is idempotent under the same operation key is unresolved.
Existing check: `crates/mc-store/tests/claim_intent_ledger.rs:337-401` covers the drain
fence on replay, status `unaudited`. No check covers the effect count.
Impact: If the context mutation is not idempotent under the operation key, a crash in
the second window produces a duplicate claim effect, and the mirror will faithfully
project it. The ledger records one intent, so the duplication is invisible from the
store side.
Open questions:

- Is the context mutation keyed by `(producer, operation_key)` such that re-execution
  is a no-op? Unresolved; needs the host's claim-apply path, which is outside this
  scope. (needs human input)
- Should the ledger record an intermediate "mutation attempted" state to close the
  second window? That is a design decision. (needs human input)

## Group E: core decay and totality

Four records on `crates/mc-core/src/decay.rs`, a 302-line pure-function module whose
whole contract is a total function from `(compartment_index, importance,
budget_pressure, anchor_overlap)` to a render tier. The decay curve is
default-production: the only in-tree caller is
`crates/mc-module/src/decay_render.rs:19`, which calls `compute_budget_pressure` at
`:279` behind a `history_budget > 0.0` gate, calls `rendered_tier` at `:291` with a
hardcoded `anchor_overlap` of `0.0` (`:295`), and pre-clamps importance to `1..100`
with a default of 50 (`:270-272`). So the curve runs on every render, while two of its
four degrees of freedom are not reachable from `mc-module` today. All four records were
measured empirically by extracting the kernel into a scratch program, and two of them
record contradictions of the module's own documented invariants that are already
waiting for a test.

### core-decay-newest-compartment-tier-floor

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `decay.rs:154-162` asserts `tier(1, imp, p) == 1` for `imp` in
`{1, 50, 100}` and `p` in `{0.1, 1.0, 5.0}` only, so the non-finite pressure case is
unexercised.
Guarantee: the newest compartment always renders at tier 1, for every importance and
every pressure value the public API accepts.
Check: `always` — for all `importance: i32` and all `budget_pressure: f64` including
non-finite values, `tier(1, importance, budget_pressure) == 1` and
`rendered_tier(1, importance, budget_pressure, 0.0) == 1`. `always` is right because
`tier` is a total pure function evaluated on every render pass; there is no optional
path and no situation to reach, only an input domain to cover.
Fault/timing angle: none. Pure arithmetic, no interleaving.
Required faults and enabling state: `budget_pressure = f64::INFINITY`, which
`compute_budget_pressure` (`decay.rs:130-145`) returns when `history_budget` is
positive but subnormal (measured at `5e-324`). No fault injection needed; the input
alone is the enabling state.
Confidence: high — [evidence](evidence/core-decay-newest-compartment-tier-floor.md).
I extracted the exact kernel from `decay.rs:56-124` into a scratch program and measured
`tier(1, 50, f64::INFINITY) == 5`, `should_archive == false`, `rendered_tier == 4`,
with `z = 0.0/0.0 = NaN`.
Existing check: `crates/mc-core/src/decay.rs:154` `newest_compartment_is_tier_1`
covers three finite pressures. Status `unaudited`.
Impact: the newest, most relevant compartment renders as an anchor-level P4 summary
instead of the verbose P1 form, silently dropping the most recent session content from
the prompt. Because `rendered_tier` returns 4 while `tier` returns 5, the two functions
also disagree, so any caller that reads `tier` directly to decide archival diverges from
the renderer.
Open questions:

- Is a subnormal `history_budget` reachable from configuration, or is the budget always
  a whole-token count bounded well away from zero? Requires tracing
  `history_budget_tokens` back to its config surface, which is `mc-module` territory.
  (unresolved, needs an `mc-module` config trace)
- Should `tier` reject or clamp a non-finite `budget_pressure` at the API boundary
  rather than relying on `f64::max`? (needs human input)

### core-decay-tier-ladder-monotone-and-archive-agreement

Type: safety
Reachability: default-production
Status: active
Exercised: partial — monotonicity is sampled at three fixed slices (`decay.rs:165`,
`:176`, `:186`) and the tier cap at one slice (`decay.rs:201`); no test walks the joint
grid.
Guarantee: the tier ladder is monotone in all three arguments, and `rendered_tier`
returns 5 exactly when `should_archive` is true and at most 4 otherwise.
Check: `always` — over a swept grid of `index`, `importance`, and finite `pressure`:
(a) `tier` is non-decreasing in `index`, (b) non-increasing in `importance`, (c)
non-decreasing in `pressure`, and (d) `rendered_tier(i, m, p, o) == 5` if and only if
`should_archive(i, m, p, o)`, else `rendered_tier(i, m, p, o) <= 4`. `always` because
every clause must hold at every evaluation; these are not optional paths.
Fault/timing angle: none.
Required faults and enabling state: none. Plain input sweep. The grid must include the
intended disagreement window where `tier == 5` but `should_archive == false`, which
needs `anchor_overlap > 0`.
Confidence: high —
[evidence](evidence/core-decay-tier-ladder-monotone-and-archive-agreement.md). I
confirmed the disagreement window empirically: at `importance = 50`, `pressure = 1.0`,
`anchor_overlap = 1.0`, indices 64 through 119 give `tier == 5`,
`should_archive == false`, `rendered_tier == 4`, which is the documented P4 protection at
`decay.rs:94` and `:107-108`.
Existing check: `crates/mc-core/src/decay.rs:165`, `:176`, `:186`, `:201`. Status
`unaudited`.
Impact: a monotonicity break means a compartment gets *more* verbose as it ages or
*less* protected as its importance rises, which is a direct contradiction of the
council-validated model at `decay.rs:12-13`. An agreement break means the renderer and
any archival consumer disagree about whether a compartment is retired.
Open questions:

- Is `tier() == 5` a legitimate public answer, or should the archive-candidate boundary
  be expressed only through `should_archive`? The two disagree by design today. (needs
  human input)

### core-decay-budget-pressure-range-totality

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `decay.rs:208-221` asserts only that a tighter budget raises
pressure and that the loose case is at least `P_FLOOR`.
Guarantee: `compute_budget_pressure` is total, never returns NaN, and always returns a
value at or above `P_FLOOR`.
Check: `always` — for every compartment slice and every `history_budget: f64` including
0, negative, subnormal, `f64::MAX`, `+inf`, and NaN:
`!result.is_nan() && result >= P_FLOOR`. Additionally record whether
`result.is_finite()`; if the contract intends finiteness, assert it too. `always`
because the function is called once per render pass and its output feeds every
subsequent tier decision.
Fault/timing angle: none.
Required faults and enabling state: none for the NaN and non-positive cases. The `+inf`
output needs a positive subnormal budget.
Confidence: high — [evidence](evidence/core-decay-budget-pressure-range-totality.md).
Measured: `history_budget` of NaN and `+inf` both yield exactly `0.1` (`P_FLOOR`), so
the NaN clause holds; `5e-324` and `f64::MIN_POSITIVE` both yield `+inf`, so the
finiteness clause does not hold. `TIER_COST` indexing at `decay.rs:141` is guarded by
`decay.rs:140` and cannot panic.
Existing check: `crates/mc-core/src/decay.rs:208` `pressure_self_tunes_toward_budget`.
Status `unaudited`.
Impact: an `+inf` pressure propagates into `z_value` and produces the
`core-decay-newest-compartment-tier-floor` failure. A NaN pressure would be worse,
collapsing every comparison, but the `f64::max` at `decay.rs:144` already prevents it.
Open questions:

- Does the contract intend `compute_budget_pressure` to be finite, or is `+inf` an
  accepted "archive everything" signal? The doc at `decay.rs:127-129` discusses overshoot
  but not saturation. (needs human input)

### core-decay-archive-termination-bound

Type: safety
Reachability: test-only
Status: active
Exercised: partial — `decay.rs:194-198` asserts termination at one point,
`should_archive(100_000, 100, 1.0, 0.0)`, with `anchor_overlap` fixed at 0.
Guarantee: every compartment eventually archives; no input produces an immortal row.
Check: `always` — for every `importance` and every finite `pressure >= P_FLOOR` and
every `anchor_overlap` the API accepts, there exists a finite `index` at which
`should_archive` is true; equivalently, assert
`should_archive(u32::MAX, importance, pressure, overlap)` holds for the whole swept
parameter set. `always` rather than a liveness check because the quantity is a pure
function of an ordinal index, not a process that must make progress over time; there is
no fault-free window to bound.
Fault/timing angle: none.
Required faults and enabling state: `anchor_overlap = f64::NAN`. Rust's `f64::clamp`
propagates NaN, so the clamp at `decay.rs:102` returns NaN, the comparison
`z >= Z4 + G * NaN` is false for every `z`, and nothing archives.
Confidence: high — [evidence](evidence/core-decay-archive-termination-bound.md).
Measured: `f64::NAN.clamp(0.0, 1.0)` returns NaN, and
`should_archive(100_000, 100, 1.0, f64::NAN) == false`, directly contradicting the
"finite demotion even at importance 100" invariant at `decay.rs:12-13`. Reachability is
`test-only` because the sole in-tree caller,
`crates/mc-module/src/decay_render.rs:295`, hardcodes `0.0`; only a direct library call
can supply NaN today.
Existing check: `crates/mc-core/src/decay.rs:194` `finite_demotion_at_max_importance`,
one point, `anchor_overlap = 0.0`. Status `unaudited`.
Impact: unbounded retention. Session history never archives, so the rendered prompt
grows without limit and the budget guard at
`crates/mc-module/src/decay_render.rs:331-347` becomes the only backstop. If anchors
become a first-class primitive as `decay.rs:94` anticipates, a NaN or uninitialised
overlap becomes production-reachable.
Open questions:

- When anchor overlap becomes a real storage primitive, where should the overlap value
  be validated: at the storage boundary or inside `should_archive`? (needs human input)

## Group F: core operation semantics and encoding

Six records on `crates/mc-core/src/claim_operation.rs` (878 lines) and
`crates/mc-core/src/lib.rs` (338). This module is an encoding and identity contract,
not a state machine: it defines closed enums and no transition function, and every
staged claim command digests through it. Four records are pure-function laws with a
cross-runtime counterpart in TypeScript, so a divergence produces a wrong digest rather
than a lost write. The fifth records that transition legality is documented in the type
names and modelled nowhere. The sixth is the pass classifier, an eleven-boolean total
function with no production caller, which makes an exhaustive 2,048-point oracle the
cheapest complete check in the whole part.

### core-canonical-encoding-crossruntime-parity

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the fixture pins 5 canonicalization cases and 2 rejection cases
(`claim_operation.rs:718-747`), including one astral key-order case that genuinely
discriminates code-point from UTF-16 ordering.
Guarantee: the Rust and TypeScript canonical encoders accept exactly the same values and
emit byte-identical output, so a digest computed on either side fences correctly against
the other.
Check: `always` — for every value in the shared canonical vocabulary,
`canonical_json_encode(v)` in Rust equals `canonicalJsonEncode(v)` in TypeScript byte
for byte, and the accepted sets coincide: both accept a value or both reject it.
Restrict the comparison to values Rust can represent, since Rust `&str` cannot hold a
lone surrogate that TypeScript can. `always` because every staged command digests
through this path.
Fault/timing angle: none. This is a cross-runtime equivalence, not a race.
Required faults and enabling state: a generator that emits values spanning the
discriminating regions: object keys straddling the BMP/astral boundary
(`U+E000`..`U+FFFF` versus `U+10000`+), keys differing only past a shared prefix,
integers at exactly `±(2^53 - 1)` and `±2^53`, `-0`, floats with zero fraction such as
`1e3`, control characters `U+0000`..`U+001F`, `U+2028`, `U+2029`, and
unpaired-surrogate-free astral text.
Confidence: high —
[evidence](evidence/core-canonical-encoding-crossruntime-parity.md). I read the
TypeScript twin and confirmed it uses an explicit `compareCodePoints` (TS `:53-63`) at
TS `:120`, not the default sort, so the agreement with Rust's `BTreeMap` ordering
(`claim_operation.rs:124`) is deliberate. I decoded the `astral-key-order` fixture keys
as `U+0041`, `U+FFFD`, `U+1F600` and confirmed the pinned canonical output is in
code-point order, which UTF-16 order would reverse for the last two.
Existing check: `crates/mc-core/src/claim_operation.rs:718`
`canonical_bytes_and_request_digests_match_fixture` and `:737`
`non_canonical_numbers_are_rejected`, both fixture-driven. Status `unaudited`.
Impact: a divergence means the two runtimes compute different request digests for the
same semantic command, so the intent ledger's replay detection and the mutation-token
fence both misfire: a replay looks like a new command, or two different commands collide
on one identity.
Open questions:

- Is the `U+FFFD` key in the `astral-key-order` fixture deliberate, or is it a mangled
  `U+E000` or lone surrogate from an earlier generator run? It discriminates correctly
  either way, but the intent matters for future edits. (unresolved, needs the fixture
  generator's history)
- Only two `invalidCanonical` cases exist (`1.5` and `9007199254740993`). Is the
  rejection surface intended to be that narrow? (needs human input)

### core-result-decode-acceptance-boundary

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `claim_operation.rs:847-877` covers 2 valid and 5 invalid fixture
envelopes. Neither valid case has a non-canonical payload, and no case pairs an
`applied` outcome with a non-null `staleReason`.
Guarantee: `decode_claim_operation_result` accepts exactly the envelopes the canonical
encoder can produce, and the accepted envelope is internally consistent.
Check: `always` — for every input string `s`: if `decode_claim_operation_result(s)`
succeeds then (a) `canonical_json_encode(serde_json::from_str(s))` also succeeds, and
(b) the decoded `stale_reason` is `Some` if and only if the decoded outcome is `Stale`.
Both clauses are stated as `always(!X)` style conditions on the accepted value, not as
`unreachable`, because the forbidden thing is a *state* (an accepted-but-non-canonical
envelope) with no dedicated code point that must not execute.
Fault/timing angle: none.
Required faults and enabling state: a stored envelope whose `payload` contains a
fractional number, a number beyond `±(2^53 - 1)`, or a nested object with such a
number. Writing such an envelope requires a producer that does not canonicalize, which
is the interesting fault: an older writer, a hand-repaired row, or a future encoding
version.
Confidence: high — [evidence](evidence/core-result-decode-acceptance-boundary.md).
Verified by reading: `claim_operation.rs:666` clones `payload` with no validation, while
`:107-109` rejects the same value inside `canonical_json_encode`. `staleReason` at
`:638-646` is validated only for type. I confirmed the two fixture valid cases have
payloads `{"claim":{...},"kind":"revised"}` and `null`, both canonical, and that
`staleReason` is null on `applied` and a string on `stale`, so the fixture happens to be
consistent and therefore cannot detect the missing rule.
Existing check: `crates/mc-core/src/claim_operation.rs:847`
`stored_results_decode_and_reencode_byte_identically`. Status `unaudited`.
Impact: a non-canonical payload round-trips through the ledger and then fails at
re-encoding time in whatever layer next digests it, turning a write-time validation miss
into a later, harder-to-attribute failure. An `applied` outcome carrying a stale reason,
or a `stale` outcome carrying none, misleads every consumer that branches on the pair,
including `crates/mc-store/src/lib.rs:3943` which treats `Applied | Noop` as one class.
Open questions:

- Is `payload` intentionally opaque, so that non-canonical payloads are legal by design
  and only the envelope is canonical? The module doc at `claim_operation.rs:6-15`
  describes one vocabulary for all values, which suggests not. (needs human input)
- Should `staleReason` be modelled as data on the `Stale` variant rather than a sibling
  field, making the inconsistent pair unrepresentable? (needs human input)

### core-applicability-heads-order-independence

Type: safety
Reachability: default-production
Status: active
Exercised: partial — 2 fixture cases (`claim_operation.rs:803-822`): the empty list and
one two-element list. No case permutes the same list, so the invariance is asserted
nowhere.
Guarantee: the applicability-heads digest depends only on the set of
`(streamKey, seq)` pairs, not on the order in which they are supplied, when stream keys
are distinct.
Check: `always` — for every head list with pairwise-distinct stream keys and every
permutation of it, `compute_applicability_heads_digest` returns the same digest. Scoped
to distinct keys deliberately: the sort at `claim_operation.rs:276` compares the key only
and `sort_by` is stable, so duplicate keys make the digest order-sensitive by
construction, and asserting invariance there would assert a law the code does not claim.
Fault/timing angle: none.
Required faults and enabling state: none. A permutation generator over distinct-key
lists. A separate `sometimes` marker should record whether a duplicate-key list ever
reaches the function in production, since that is the case where the property is
genuinely undefined.
Confidence: high —
[evidence](evidence/core-applicability-heads-order-independence.md). Verified by reading
`claim_operation.rs:275-281`: the sort key is `left.0.cmp(&right.0)`, the stream key
alone. Confirmed the TypeScript twin uses the same key-only comparator over a copied
array (TS `:243-245`) and that `Array.prototype.sort` is stable in ES2019 and later, so
the two runtimes agree on duplicate handling as well as on the distinct-key case.
Existing check: `crates/mc-core/src/claim_operation.rs:803`
`applicability_and_policy_head_digests_match_fixture`. Status `unaudited`.
Impact: an order-sensitive digest makes the mutation token
(`claim_operation.rs:238-246`) fence on an accident of enumeration order, so a caller
that lists the same heads in a different order sees a spurious fence mismatch and
retries or rejects a legitimate mutation.
Open questions:

- Can a duplicate stream key occur in a real head list? If it can, the digest is
  ill-defined and the function should dedupe or reject rather than silently depend on
  input order. Resolving it needs the head-collection query in `mc-store`, which is a
  sibling lens's file. (unresolved, needs the `mc-store` head-collection query)

### core-revision-locator-roundtrip-inverse

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the fixture (`claim_operation.rs:760-786`) asserts
`format(parse(s)) == s` for each valid case and rejection for 8 invalid strings, but
never asserts `parse(format(l)) == Some(l)` for a generated locator.
Guarantee: `format_revision_locator` and `parse_revision_locator` are mutually inverse
on the valid domain, and both reject exactly the same invalid domain.
Check: `always` — for every `RevisionLocator` value: if `format_revision_locator(&l)` is
`Some(s)` then `parse_revision_locator(&s) == Some(l)`; and for every string `s`, if
`parse_revision_locator(s)` is `Some(l)` then
`format_revision_locator(&l) == Some(s.to_string())`. `always` because both directions
are evaluated on every effect row that carries a locator
(`claim_operation.rs:564-579`).
Fault/timing angle: none.
Required faults and enabling state: none. A generator over the three components,
including `revision` at 0, 1, `MAX_SAFE_INTEGER`, `MAX_SAFE_INTEGER + 1`, and
`i64::MAX`; digests of length 63, 64, 65; digests with uppercase hex; and ids with the
wrong prefix or wrong length.
Confidence: high — [evidence](evidence/core-revision-locator-roundtrip-inverse.md).
Verified by reading both functions: the range check
`(1..=MAX_SAFE_INTEGER).contains(&revision)` appears identically at
`claim_operation.rs:199` and `:224`; the leading-zero and non-digit rejections at `:220`
exclude exactly the strings `format` cannot emit; `is_lower_hex` (`:173-178`) is shared
by both. The parse of a very long digit run overflows and is caught by `.ok()?` at
`:223`, so there is no panic.
Existing check: `crates/mc-core/src/claim_operation.rs:760`
`revision_locators_match_fixture`. Status `unaudited`.
Impact: a locator that formats but does not parse, or parses but reformats differently,
breaks effect-row validation at `claim_operation.rs:564-579`, where a stored locator is
re-parsed and the envelope is rejected if the parse fails. A one-sided inverse turns a
valid stored effect into a `MalformedResult`.
Open questions: None.

### core-intent-ack-transition-legality-gap

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — nothing in `mc-core` asserts transition legality, because
`mc-core` does not model it. `crates/mc-store/tests/claim_intent_ledger.rs` exercises
acknowledgements, and Group D's `intent-terminal-state-is-entered-at-most-once` is where
that coverage is audited.
Guarantee: an acknowledgement only advances an intent along a legal edge; a resolved
intent is never reopened and a terminal state is never left.
Check: `always` — for every observed acknowledgement, the pair `(state_before, kind)`
lies in the legal set
`{(Staged, ContextCommitted), (Staged, TerminalRejected),
(ContextCommitted, Acknowledged), (ContextCommitted, TerminalRejected)}`, plus whatever
idempotent replay edges the design intends. Expressed as `always(pair in legal_set)`,
not `unreachable`, because the forbidden thing is a *state pair* with no dedicated code
point in `mc-core` that must not execute; there is no transition function to place a
marker in.
Fault/timing angle: a concurrent or replayed acknowledgement. Two acknowledgements for
the same `(producer, operation_key)` racing, or one retried after its response was lost,
is exactly the window where a backwards edge appears. `ClaimIntentAckRequest`
(`claim_operation.rs:437-446`) carries no expected-current-state, so the request itself
cannot express the fence.
Required faults and enabling state: a lost acknowledgement response followed by a retry
with a different `kind`; two producers acknowledging the same command identity; an
acknowledgement arriving after the intent already reached `Acknowledged` or
`TerminalRejected`.
Confidence: medium — [evidence](evidence/core-intent-ack-transition-legality-gap.md).
High confidence that `mc-core` does not model the relation: I read every line of
`claim_operation.rs` and there is no transition function, no guard, and no
expected-state field; `is_unresolved` (`:399-401`) is the only state predicate. Medium
overall because whether the *system* enforces legality depends on `mc-store`, which this
lens did not read; the sibling lens confirmed it does, in the single `match` at
`lib.rs:11225-11255`.
Existing check: none in `mc-core`. `crates/mc-store/tests/claim_intent_ledger.rs:85-131`,
`:169-228`, and `:346-401` touch acknowledgements. Status `unaudited`.
Impact: a backwards or terminal-escaping transition makes the intent ledger lie about
whether a command's context mutation happened, which is the ledger's entire purpose. A
reopened `TerminalRejected` intent could be re-applied; an `Acknowledged` intent knocked
back to `ContextCommitted` could be double-applied.
Open questions:

- Is transition legality enforced in `mc-store` SQL, and if so is the guard a `CHECK`, a
  conditional `UPDATE ... WHERE state = ?`, or application logic? The sibling lens found
  application logic in one `match` with no SQL guard, so the legality lives entirely in
  Rust control flow. (resolved with answer: application logic)
- Should `ClaimIntentAckRequest` carry an expected-current-state so the fence is
  expressible in the wire contract rather than only in storage? (needs human input)

### core-pass-classifier-destructive-clear-guard

Type: safety
Reachability: test-only
Status: active
Exercised: partial — 14 hand-written cases at `lib.rs:176-337` cover each rule at least
once, including `unknown_shape_rejects_never_clears` (`:207`), but the 2048-point input
domain is never enumerated.
Guarantee: the destructive clear-then-Hard plan fires only on the exact legacy
single-baseline shape, and a `Soft` plan never fires without the boundary present.
Check: `always` — enumerate all `2^11 = 2048` `ClassifierInput` values and assert: (a)
`classify(i) == MigrateHard` implies `i.is_legacy_baseline`; (b)
`classify(i) == Reject(_)` implies `i.initialized && !i.is_legacy_baseline &&
!i.cached_m1_missing && !i.valid_m0m1_shape`; (c) `classify(i) == Soft` implies
`i.boundary_present && i.bust_opportunity && (i.m1_revision_changed ||
i.reductions_pending)`; (d) `!i.boundary_present` implies `classify(i) != Soft`.
`always` over an exhaustively enumerated finite domain, which makes this the cheapest
complete oracle in the whole part.
Fault/timing angle: none. `classify` is a pure total function of 11 booleans.
Required faults and enabling state: none. Exhaustive enumeration only.
Confidence: high —
[evidence](evidence/core-pass-classifier-destructive-clear-guard.md). I read all eight
guards and confirmed the ordering claims at `lib.rs:99-115` match the code at `:118`,
`:122`, `:126`, `:130`, `:134`, `:138`, `:142`, `:146`, `:152`, `:159`. Reachability is
`test-only`: a repo-wide `rg` for `ClassifierInput|PassPlan|mc_core::classify` over
`*.rs` returns hits only inside `crates/mc-core/src/lib.rs`; the `classify` symbols found
in `crates/mc-module/src/classify.rs` and
`crates/mc-host/tests/support/perf_measurement.rs:426` are unrelated functions.
Existing check: `crates/mc-core/src/lib.rs:176-337`, 14 tests. Status `unaudited`.
Impact: if `MigrateHard` ever escaped its guard, a session with an unrecognised
frozen-set shape would have its durable frozen units cleared rather than cleanly
rejected, which is the exact outcome `lib.rs:53-56` and `:129-130` are written to
prevent. Because the classifier has no production caller, today the blast radius is
confined to whatever adopts it next, which is precisely when an exhaustive check is
cheapest to install.
Open questions:

- Is `classify` dead code awaiting adoption, or has `mc-module` diverged with a second
  copy of this routing logic? If the latter, the two must be compared, because a silent
  divergence between an unused reference implementation and the live router is worse than
  no reference at all. (unresolved, needs an `mc-module` routing comparison)

## Group G: tokenizer determinism

Two records on `crates/mc-tokenizer` (85 lines), the smallest crate in the part and the
one with the strictest contract: `mc-tokenizer/src/lib.rs:13-19` states that a resume
must produce byte-identical m0, and `crates/mc-module/src/tail_hygiene.rs:85` plus the
m0 composer use `estimate_tokens` for budget fitting, so a per-process count difference
changes a truncation decision, changes the rendered bytes, and busts the cached provider
prefix. The crate has no clock, no randomness, no file read, and no network, and embeds
its 64,995-line vocab with `include_str!`. The two records are the two halves of the
determinism claim: that the encoder is reproducible across processes and builds, and that
the golden fixture which pins agreement with the TypeScript oracle records what it is
agreeing with.

### tokenizer-cross-process-determinism

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `token_golden.rs:64-73` repeats 1000 calls in a single process
after the `OnceLock` is warm, which proves memoised purity and nothing about a second
process or a second build.
Guarantee: for fixed text, `estimate_tokens` and `encode_ordinary` return identical
results across processes, machines, and rebuilds of the same pinned dependency set.
Check: `always` — for a corpus of texts, the encoding produced in a freshly spawned
process equals the encoding recorded from a prior process, and the first call in a
process equals every later call. Pair it with a `sometimes` marker that the corpus
actually exercised a cold first call, since that is a situation, not a location.
Fault/timing angle: the cold-start window. The `OnceLock` at
`mc-tokenizer/src/lib.rs:47` builds the encoder exactly once per process, so any
build-order sensitivity is observable only on the first call and is invisible to an
in-process repeat loop.
Required faults and enabling state: a second process, and ideally a second target. A
dependency-bump scenario is the realistic fault: `fancy-regex` is transitive and pinned
only by `Cargo.lock`, so a `cargo update` can move `\p{L}` and `\p{N}` classification.
Confidence: high — [evidence](evidence/tokenizer-cross-process-determinism.md). I
verified the vocab has 64,995 lines, all with exactly two fields, zero duplicate
token-byte keys, and zero duplicate ranks, so the `insert` at
`mc-tokenizer/src/lib.rs:61` is order-insensitive and the encoder build is reproducible.
I confirmed there is no clock, no randomness, no file read, and no network in the crate,
and that the vocab is embedded with `include_str!` (`:37`).
Existing check: `crates/mc-tokenizer/tests/token_golden.rs:64`
`deterministic_across_calls`. Status `unaudited`.
Impact: `crates/mc-module/src/tail_hygiene.rs:85` and the m0 composer use
`estimate_tokens` for budget fitting, and `mc-tokenizer/src/lib.rs:13-19` states that a
resume must produce byte-identical m0. A per-process count difference changes the tier or
truncation decision, changes the rendered m0 bytes, and busts the cached prefix on
resume, which is the failure the whole cache-stability core exists to prevent.
Open questions:

- Is `f64`-free integer counting enough to make the tokenizer bit-portable across
  architectures, or does `fancy-regex` carry any target-dependent behaviour? Nothing I
  read suggests it does, but nothing establishes it either. (unresolved, needs a
  second-architecture run)

### tokenizer-golden-oracle-provenance

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the fixture records only `{label, text, ids}` per case, verified by
enumerating the key union across all 36 cases. The fixture itself carries no version and
no vocab digest, and the test does not read the lockfile.
Guarantee: The differential golden's recorded provenance agrees with the artifacts
actually in use: the `ai-tokenizer` version the fixture was generated from equals the
version the runtime resolves, and the vocab digest the fixture records equals the digest
of the embedded `assets/claude.tiktoken`.
Check: `always` — the fixture carries the resolved `ai-tokenizer` version and a digest of
`assets/claude.tiktoken`, and the test asserts both against the current artifacts: the
recorded digest equals the embedded asset's actual digest, and the recorded version equals
the version the runtime pin resolves. `always` because the agreement must hold at every
run of the golden; a stale recorded value is wrong on every execution, not only when a
particular step is entered.

Both the type and the check are corrections. This record was `Type: reachability` with
`reachable` semantics, framed as "a specific verification step must execute". That framing
tests the presence of a step rather than the property the step exists for. The property is
an agreement between recorded and actual values, which is `always` safety.

One premise also needed correcting, in the repository's favour. This record previously said
"no version, no vocab digest, no generator stamp", which overstates the case for the version
half: `bun.lock:793` pins `ai-tokenizer@1.0.6` with a sha512 integrity hash, so provenance is
not absent from the repository. What is true is narrower and still a gap. The generator
resolves `ai-tokenizer` by module specifier through `Bun.resolveSync`
(`crates/mc-tokenizer/gen/gen-token-golden.ts:17-19`) and stamps no version anywhere, so the
lockfile provides the pin and the generator provides only the specifier, with nothing binding
the fixture to either.
Fault/timing angle: none at runtime. The window is the development workflow: regenerating the
fixture after an upstream change.
Required faults and enabling state: an upstream `ai-tokenizer` change plus a regeneration of
the fixture, or an edit to the vendored vocab, with the test still green. Two facts make that
reachable rather than hypothetical. The binding is unverified: the fixture's key union across
all 36 cases is exactly `{label, text, ids}` and `token_golden.rs:14-19` deserialises only
those three fields, so even if provenance were added it would be ignored. And the runtime pin
is a caret range: `ai-tokenizer` is `"^1.0.6"` under **`dependencies`** in both
`packages/plugin/package.json:65` and `packages/pi-plugin/package.json:45`, so a consumer
installing a published package resolves any `1.x` and the lockfile does not travel with it.
Confidence: high — [evidence](evidence/tokenizer-golden-oracle-provenance.md), which still
carries the superseded `reachable` framing and was not rewritten in this disposition. I
enumerated the fixture's key union across all 36 cases and it is exactly
`{label, text, ids}`. The fixture is generated from the TypeScript reference by
`gen/gen-token-golden.ts` (`token_golden.rs:3-4`), which is the regeneration path that would
absorb an oracle change.
Existing check: `crates/mc-tokenizer/tests/token_golden.rs:26`, `:47`, `:59`, `:64`. All four
compare against the fixture; none validates the fixture's own provenance. Status `unaudited`.
Impact: the golden's stated purpose (`mc-tokenizer/src/lib.rs:16-19`) is faithfulness to the
TypeScript tokenizer. Without a verified binding the test proves only self-consistency with
the last regeneration, so a silent upstream drift plus a routine regeneration leaves a green
suite and a Rust port that is now faithful to a different oracle than the plugin runs.
Combined with 0.87% vocab coverage (564 of 64,995 token IDs across the 36 cases), the residual
risk is larger than the green check suggests.
Open questions:

- The generator's own doc comment calls `ai-tokenizer` "a DEV-only dependency", which
  contradicts both package manifests, where it sits under `dependencies` with a caret range.
  Either the caret range is the bug or the comment is. (needs human input)
- Does `ai-tokenizer` expose a version constant the generator can stamp into the fixture?
  (unresolved, needs the `ai-tokenizer` package surface)
- Should the vocab asset carry a checked-in digest so an accidental edit fails the build
  rather than silently changing every count? (needs human input)

## Relationship map

Grouped by shared mechanism rather than by the section headings above, because several
of the sharpest relationships cross groups. Every dominance statement below is a
**hypothesis** about which oracle subsumes which, offered to guide ordering, not a
verified claim; none of them has been tested, because no record in this part has an
executing check.

- **One commit boundary, three promises.**
  [acknowledged-commit-survives-process-crash](#acknowledged-commit-survives-process-crash),
  [failed-fenced-transaction-leaves-no-partial-state](#failed-fenced-transaction-leaves-no-partial-state),
  [busy-timeout-expiry-aborts-cleanly-without-partial-effect](#busy-timeout-expiry-aborts-cleanly-without-partial-effect).
  All three rest on the same five lines in the sibling: the closure runs at
  `cortexkit-store:229`, an `Err` returns before `tx.commit()` at `:230-231`, and the
  `Transaction` rolls back on drop. They are separated by *what fails*, which is what
  decides their cost. The late-SQL-error record is constructible today with no new
  seam, because `with_conn_fenced` takes an arbitrary closure and the bootstrap carries
  `CHECK`, `NOT NULL`, and `UNIQUE` constraints, so a k-of-n failure is one bad
  statement away. The busy record needs an out-of-band lock holder, which
  `lib.rs:16697` already builds and only needs to hold. The crash record needs a real
  `SIGKILL` inside the dependency, after the commit and before the caller observes
  `Ok`; no in-process hook can supply it, and the fault map's per-record table names a
  subprocess harness. Hypothesis: the late-error record *dominates* nothing but is the
  cheapest of the three by a wide margin and should be built first, because the
  multi-statement closures it targets (`commit_transform`, `delete_session`,
  `commit_state_import`, `append_compartments_tx`) are the same closures the other two
  records care about.
- **The declaration that is missing under all of it.**
  [synchronous-level-is-explicitly-declared-not-inherited](#synchronous-level-is-explicitly-declared-not-inherited),
  [acknowledged-commit-survives-process-crash](#acknowledged-commit-survives-process-crash),
  [bundled-engine-satisfies-the-declared-wal-reset-precondition](#bundled-engine-satisfies-the-declared-wal-reset-precondition).
  This is the part's central finding attacked from three sides, and the relationship is
  a dependency rather than a dominance. The crash record's own fault/timing line says
  the code-level risk *is* the missing declaration: at `FULL` an acknowledged commit
  survives power loss, at `NORMAL` it does not, and nothing in either crate chooses. So
  the durability class the crash record is trying to test is not yet decided, and the
  pragma record is the one that decides it. The engine record is adjacent rather than
  underneath: it is about a *different* declared precondition the same build violates,
  and it is the only record in the part whose `Exercised:` line is `yes`, because
  `tests/sqlite_runtime.rs:139-169` pins the violation as the expected outcome.
  Hypothesis: none of the three dominates another, and all three are answered by one
  human decision about what durability class `store.db` is contracted to provide.
- **Three verifiers, zero production callers.**
  [wal-reset-gate-runs-on-the-production-open-path](#wal-reset-gate-runs-on-the-production-open-path),
  [connection-contract-is-verified-on-the-production-connection](#connection-contract-is-verified-on-the-production-connection),
  [recorded-schema-version-cannot-disagree-with-the-actual-schema](#recorded-schema-version-cannot-disagree-with-the-actual-schema).
  The first two are `reachable` claims on code that already exists and already
  implements exactly what `docs/migration-version-lanes.md:41-51` promises; both are
  expected to fail, which is the point, and both are cheap because the oracle is one
  marker at one call site. The schema-version record is the third leg of the same
  contract-versus-code gap, and it is the expensive one: after its narrowing it needs
  an *independently derived* object inventory, and the helper the record used to credit
  with making that cheap, `compute_schema_manifest_digest`, does not read
  `main.sqlite_schema` at all. Hypothesis: wiring the connection-contract verifier
  *hypothetically dominates* nothing here but would convert the pragma record's oracle
  from a bespoke read into an existing code path; wiring the WAL-reset gate dominates
  the engine record's *consequence* while making every open fail, which is why the
  order between the gate and the engine bump is a decision rather than a task.
- **Divergence prevented at admission, never detected after.**
  [mirror-receipt-replay-applies-effects-once](#mirror-receipt-replay-applies-effects-once),
  [mirror-receipt-conflict-rejects-divergent-replay](#mirror-receipt-conflict-rejects-divergent-replay),
  [mirror-project-effect-chain-detects-omission](#mirror-project-effect-chain-detects-omission),
  [mirror-generation-advances-exactly-one-per-touched-project](#mirror-generation-advances-exactly-one-per-touched-project).
  Four admission checks inside one function, running in a fixed order on every apply,
  and they catch four different classes: an identical replay, a receipt ID reused with
  different bytes, an effect dropped *inside* an accepted receipt, and a generation
  vector that does not advance by exactly one. The design comment at
  `claim_mirror.rs:100-102` explains why the per-project chain exists separately from
  the contiguous-global-ID check at `:435-448`, and that distinction is the one thing
  the existing single-project test cannot see. Hypothesis: no dominance, because each
  check is the *only* defence against its class; what they share is a harness, since
  one seeded two-project mirror plus a receipt builder serves all four, which makes
  this the cheapest cluster in the part by leverage.
- **The control row nobody writes.**
  [intent-control-transition-write-is-silently-dropped](#intent-control-transition-write-is-silently-dropped),
  [mirror-reset-cycle-requires-a-rebuild-grant](#mirror-reset-cycle-requires-a-rebuild-grant),
  [mirror-clear-without-a-grant-is-never-entered](#mirror-clear-without-a-grant-is-never-entered),
  [mirror-accepting-gate-is-skipped-when-control-is-absent](#mirror-accepting-gate-is-skipped-when-control-is-absent).
  The most consequential cluster in the part, and it is one defect with three
  consequences. `set_claim_intent_transition_tx` returns `Ok` having written nothing
  whenever its `database_incarnation_id` argument is not 32 lowercase hex
  (`lib.rs:4124-4126`), and all four call sites pass `context_store_uuid`, which the
  same file says at `:4062-4065` is minted independently. The only writer that
  validates properly, `begin_claim_store_rebuild`, has no production caller. So
  `mc_claim_intent_controls` is never populated in production, and the three readers of
  that row split: two fail closed and latch, so the mirror is write-once per
  incarnation and the documented reset cycle cannot be entered; one fails open, so the
  `accepting` gate is skipped entirely. Note the pairing inside the split records:
  `mirror-reset-cycle-requires-a-rebuild-grant` and
  `mirror-clear-without-a-grant-is-never-entered` share the same two markers at
  `claim_mirror.rs:816` and `:1148` and expect opposite outcomes under different
  campaign preconditions, so one instrumentation serves both. Hypothesis: fixing the
  identity mismatch in `set_claim_intent_transition_tx` *hypothetically dominates* all
  four, because it is the single change that makes the control row exist; but it
  changes which arm of the accepting-gate record fails rather than making that record
  pass, since the absent-row default would then simply stop being the norm.
- **Two fences over one non-atomic read, and one surface with none.**
  [mirror-read-fence-relies-on-generation-advance](#mirror-read-fence-relies-on-generation-advance),
  [mirror-staleness-undetectable-on-memory-tool-read-path](#mirror-staleness-undetectable-on-memory-tool-read-path),
  [mirror-generation-advances-exactly-one-per-touched-project](#mirror-generation-advances-exactly-one-per-touched-project).
  Four production read paths of the same tables, at three different strengths:
  `lib.rs:7368-7377` re-reads the vector inside the fenced commit and converts a
  mismatch to `CasConflict`, which is the only genuinely atomic check;
  `transform.rs:1978-2011` and `historian_chunk.rs:563-608` are optimistic double-reads
  against a caller-supplied expected value, and they compare *different things*, a
  canonical vector versus the whole `ClaimMirrorState`; and `memory_tool.rs:57-67`
  compares nothing. The generation record is load-bearing under the weaker of the two
  double-reads: transform's vector comparison is a sufficient change-detector only
  because every touched project's generation must advance, and neither site states the
  coupling. Hypothesis: the generation record *hypothetically dominates* the read-fence
  record, since a proof that generations advance per touched project is exactly the
  premise transform's fence rests on. The staleness record is outside that relation
  entirely: its read-surface enumeration is checkable here, and its consequence half is
  blocked on a cross-language contract rather than on effort.
- **Two windows around one durable effect in another database.**
  [intent-staged-replay-produces-one-context-effect](#intent-staged-replay-produces-one-context-effect),
  [intent-identity-is-producer-and-operation-key](#intent-identity-is-producer-and-operation-key),
  [intent-terminal-state-is-entered-at-most-once](#intent-terminal-state-is-entered-at-most-once),
  [core-intent-ack-transition-legality-gap](#core-intent-ack-transition-legality-gap).
  Staging, the context mutation, and the acknowledgement are three separate
  transactions across two databases, and only the second window is dangerous: a crash
  after the mutation and before the acknowledgement leaves `staged`, and the replay
  re-runs the mutation, which `lib.rs:11064-11070` states outright. The other three
  records are what stops that replay from doing damage: identity refuses a reused key
  carrying a different request, absorption refuses a late acknowledgement of the wrong
  kind, and the `mc-core` record records that neither the type system nor the wire
  request can express the transition fence at all, since `ClaimIntentAckRequest` carries
  no expected-current-state. Hypothesis: the `mc-core` legality record is *dominated*
  by `intent-terminal-state-is-entered-at-most-once`, because the store's single `match`
  at `lib.rs:11225-11255` is where legality actually lives and an enumeration of all
  twelve `(kind, state)` pairs against it subsumes the `mc-core` claim; the two are kept
  separate because they are checks on different crates and the `mc-core` half is what a
  future second consumer of the vocabulary would rely on.
- **Pure functions with measured contradictions already waiting.**
  [core-decay-newest-compartment-tier-floor](#core-decay-newest-compartment-tier-floor),
  [core-decay-budget-pressure-range-totality](#core-decay-budget-pressure-range-totality),
  [core-decay-archive-termination-bound](#core-decay-archive-termination-bound),
  [core-decay-tier-ladder-monotone-and-archive-agreement](#core-decay-tier-ladder-monotone-and-archive-agreement).
  One chain, not four independent records. A positive subnormal `history_budget` makes
  `compute_budget_pressure` return `+inf`, which makes `z` become `NaN`, which makes
  `tier(1, ..)` return 5 instead of 1 while `rendered_tier` returns 4, so the newest
  compartment renders as an anchor summary *and* the two functions disagree. Separately,
  a NaN `anchor_overlap` propagates through `f64::clamp` and makes `should_archive` false
  for every index, contradicting the "finite demotion even at importance 100" invariant
  the module states at `decay.rs:12-13`. Both were measured, not argued. Hypothesis: the
  totality record *hypothetically dominates* the tier-floor record, because bounding
  `compute_budget_pressure` to a finite range removes the tier-floor failure's only
  enabling input; the archive-termination record is independent, since its input is a
  different argument and is `test-only` today because `decay_render.rs:295` hardcodes
  `0.0`. All four share one oracle shape, a swept input grid over a pure function with no
  faults and no interleavings, which makes this the cheapest group in the part and the
  one the portfolio evaluation named as ready for implementation now.
- **One vocabulary, two runtimes, four laws.**
  [core-canonical-encoding-crossruntime-parity](#core-canonical-encoding-crossruntime-parity),
  [core-result-decode-acceptance-boundary](#core-result-decode-acceptance-boundary),
  [core-applicability-heads-order-independence](#core-applicability-heads-order-independence),
  [core-revision-locator-roundtrip-inverse](#core-revision-locator-roundtrip-inverse).
  Four pure-function laws whose shared consequence is a digest, and a wrong digest is a
  wrong *answer*: the intent ledger's replay detection and the mutation-token fence both
  misfire, so a replay looks like a new command or two commands collide on one identity.
  Hypothesis: the parity record *hypothetically dominates* the other three on the
  cross-runtime axis only, because a generator that spans the discriminating regions and
  compares both encoders byte for byte would also catch an ordering or acceptance
  divergence; it dominates none of them on the *intra*-Rust axis, since the locator
  inverse, the heads permutation invariance, and the decoder's internal consistency are
  laws Rust must satisfy on its own and none of them involves TypeScript. Note the one
  place the group is deliberately silent: the heads record scopes itself to
  pairwise-distinct stream keys, because the sort compares the key alone and asserting
  invariance over duplicates would assert a law the code does not claim.
- **Two determinism claims, one green and one hollow.**
  [tokenizer-cross-process-determinism](#tokenizer-cross-process-determinism),
  [tokenizer-golden-oracle-provenance](#tokenizer-golden-oracle-provenance),
  [core-canonical-encoding-crossruntime-parity](#core-canonical-encoding-crossruntime-parity).
  The tokenizer's contract is byte-identical m0 across a resume, and the existing check
  proves the weakest thing that could look like it: 1000 repeat calls in one process
  after the `OnceLock` is warm. The determinism record's real target is the cold first
  call in a second process, which no in-process loop can reach. The provenance record is
  the sharper of the two, because it is about what the green test *means*: with only
  `{label, text, ids}` in the fixture and a `^1.0.6` caret range under `dependencies`, a
  silent upstream drift plus a routine regeneration leaves the suite green and the Rust
  port faithful to a different oracle than the plugin runs. The parity record appears here
  too because it is the same failure shape one layer up, two implementations of one
  contract with a fixture that could absorb a divergence instead of reporting it.
  Hypothesis: no dominance; the provenance record is a precondition for trusting the
  determinism record's oracle, since the corpus it would compare against is the same
  fixture whose binding is unverified.
- **The classifier that nothing calls.**
  [core-pass-classifier-destructive-clear-guard](#core-pass-classifier-destructive-clear-guard).
  Deliberately outside every dominance chain, and the only record in the part whose value
  comes from the absence of a caller rather than from the presence of one. `classify` is a
  total function of eleven booleans, so its input domain is 2,048 points and an exhaustive
  oracle is complete rather than sampled, which makes it the cheapest complete check
  anywhere in this catalog. Its blast radius today is confined to whatever adopts it next,
  and that is exactly when the check is cheapest to install. The open question is the part
  that matters more than the check: whether this is dead code awaiting adoption or a second
  copy of routing logic `mc-module` already implements, because a silent divergence between
  an unused reference implementation and the live router is worse than having no reference.

