# wal-reset-gate-runs-on-the-production-open-path

## Discovery trigger

`docs/migration-version-lanes.md:41-44` makes a two-clause claim: the TypeScript
writers probe for a WAL-reset-safe SQLite source, and "The root Rust module
applies the same rule to `store.db`." Following the second clause into
`McStore::open` found no probe.

## Evidence trail

The claim:

- `docs/migration-version-lanes.md:41-44`:
  "Before opening `context.db`, Bun and Node writers probe an approved
  WAL-reset-safe SQLite source on an off-path database. The root Rust module
  applies the same rule to `store.db`."

The implementation that exists:

- `crates/mc-store/src/sqlite_runtime.rs:43-48`
  `probe_sqlite_engine_identity_off_path`, whose doc comment at `:43-44` says
  "Probe the compiled engine on a throwaway in-memory connection, never the real
  database file." This is exactly the off-path probe the document describes.
- `sqlite_runtime.rs:33-41` `read_sqlite_engine_identity` reads
  `sqlite_version()` and `sqlite_source_id()`.
- `sqlite_runtime.rs:89-108` `evaluate_sqlite_runtime_gate` returns every
  failure reason, empty meaning pass.

The call sites:

- A content search for `probe_sqlite_engine_identity_off_path` across the whole
  repository (excluding `node_modules`) returns two lines: the definition at
  `sqlite_runtime.rs:45` and the import at
  `crates/mc-store/tests/sqlite_runtime.rs:7`.
- The same search for `evaluate_sqlite_runtime_gate` returns the definition at
  `sqlite_runtime.rs:92`, the import at `tests/sqlite_runtime.rs:6`, and five
  invocations, all inside `tests/sqlite_runtime.rs` at `:117`, `:125`, `:133`,
  `:149`, `:211`, `:223`.
- The same search for `SQLITE_WAL_RESET_SAFE_MIN_VERSION` returns the definition
  at `sqlite_runtime.rs:25`, the use inside the gate at `:95`, the test import at
  `:9`, and the test comparison at `tests/sqlite_runtime.rs:156`.

The open path that should call it:

- `crates/mc-store/src/lib.rs:4816-4905` `McStore::open`, read in full. Its
  seven steps are: `open_sqlite` (`:4817`), four `create_scalar_function`
  registrations (`:4825-4872`), `refuse_pre_cutover_store` (`:4873`),
  `inner.migrate(NS, MIGRATIONS)` (`:4874`), statement-cache sizing
  (`:4878-4881`), struct construction (`:4882-4901`),
  `repair_note_artifacts_v51` (`:4902`), and `prune_transform_session_roots`
  (`:4903`). No probe, no gate.

Production code in `lib.rs` ends at line 13930; `#[cfg(test)] mod tests` begins
at `:13932`. So there is no production caller anywhere in the crate.

## Failure scenario

The store opens on an engine that the crate itself classifies as unsafe, and
nothing reports it. Today that is not hypothetical: the bundled engine is 3.46.0
and the declared minimum is 3.47.1, so the gate would return one failure reason
on every open if it ran. See
[bundled-engine-satisfies-the-declared-wal-reset-precondition](bundled-engine-satisfies-the-declared-wal-reset-precondition.md).

The forward-looking failure is worse than the current one. If the crate later
links a system SQLite rather than the bundled build, the engine version becomes
a property of the deployment host. Without the gate, a host with an old SQLite
opens the store silently. The gate's own doc comment anticipates this at
`sqlite_runtime.rs:90-91`: "a wrapper version alone never passes, and an unknown
`sqlite_source_id()` fails closed." That fail-closed behaviour is the whole
point, and it is unreachable.

## Timing windows and dependencies

No timing window: the gate either runs at open or does not.

One ordering dependency matters if it is wired in. The probe is deliberately
off-path (`sqlite_runtime.rs:46` uses `Connection::open_in_memory`), so it can
run before `open_sqlite` acquires the file lease
(`cortexkit-store:279-282`) and before the real file is touched at
`cortexkit-store:284`. Placing it first means an unsafe engine never opens the
real database at all, which is stronger than checking afterwards.

## What a test must construct

For the reachability question, almost nothing:

1. Instrument or counter-wrap `evaluate_sqlite_runtime_gate`.
2. Call `McStore::open` on a temp-dir descriptor.
3. Assert the counter is non-zero.

This fails today. That is the correct result for a `reachable` check whose code
point is not entered.

For the behaviour once wired, the existing tests already cover the gate's logic
thoroughly: `tests/sqlite_runtime.rs:110-137` covers a safe engine, an unsafe
bundled version, and an unknown source id; `:205-227` covers additional
malformed identities. So the missing work is integration, not logic.

## Investigation log

### Q: Would wiring the gate in today make every `McStore::open` fail?

- Sources examined: `sqlite_runtime.rs:92-108`,
  `tests/sqlite_runtime.rs:139-169`, `Cargo.toml:29-32`, `Cargo.lock`.
- Findings: yes, if the gate is treated as fatal. The test at
  `tests/sqlite_runtime.rs:161-168` asserts the live probe produces exactly one
  failure reason on this build. A fatal gate would therefore refuse every open
  until the version bump lands.
- Missing evidence: whether the intended wiring is fatal or advisory. The
  function's signature returns `Vec<String>` rather than `Result`, which is
  compatible with either.
- Conclusion: resolved on the mechanics, needs human input on the policy. If the
  gate must be fatal, it cannot be enabled before the coordinated bump described
  at `Cargo.toml:30`, and the document's present-tense claim at
  `docs/migration-version-lanes.md:43` should be marked pending.

### Q: Does the TypeScript half of the claim actually do the probe, so only the Rust half is missing?

- Sources examined: content search for the shared vocabulary constants across
  `packages/`. `packages/cli/src/lib/database-access.ts:31` imports
  `MC_APPLICATION_ID` and `:262` compares against it;
  `packages/cli/src/commands/doctor-repair-db.ts:32, 355` sets
  `PRAGMA application_id`. `sqlite_runtime.rs:1-6` names the cross-runtime
  fixture as
  `packages/plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json`.
- Findings: the TypeScript side clearly participates in the shared format
  vocabulary. I did not trace whether it performs the WAL-reset-safety probe
  specifically.
- Missing evidence: the TypeScript open path was not read; it is outside this
  lens's Part 3 scope.
- Conclusion: unresolved, needs a TypeScript-side pass. It does not change the
  Rust finding, which stands on its own.
