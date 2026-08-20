# Context database migration version lanes

The shared `context.db` migration bookkeeping uses two reserved ranges:

- Upstream Magic Context migrations use versions below `10000`.
- Downstream forks and sibling plugins sharing `context.db` use versions `10000` and above.

The boundary isolates migration **bookkeeping** only. A fork's DDL must remain compatible with the upstream tables; version ranges cannot make incompatible DDL safe. Multiple sibling forks must coordinate their own subranges. Magic Context provides one downstream lane, not an allocator.

A fork that does not use the downstream range continues to be treated like stock, so it gets today's status quo, not worse. Rows inserted by hand at versions `>= 10000` are fence-invisible by design, so upstream schema fences and probes report only the upstream lane. Migration pendingness checks each candidate in the pending upstream range directly, preserving downstream rows while shared-core migrations run.

The `crates/mc-store` migration chain is out of scope: it uses a separate database with namespace-keyed primary keys and already has its own owner design.

## v82 claims-and-evidence rollout order

Migration v82 creates the authoritative claims domain (`projects`, `project_aliases`, `episodes`, `source_spans`, `observations`, `claims`, `claim_revisions`, `claim_evidence`, `claim_conflicts`, `verification_events`) and seeds the numeric project registry from existing identities. It writes nothing to `memories` or any other legacy table.

- **Binary order:** ship the OpenCode plugin, Pi plugin, CLI, and `ck-mc` from the same source revision **before** any process opens a database at v82. The first v82-capable process migrates on open; the schema fence then refuses older binaries.
- **Runtime SQLite gate:** `node packages/plugin/scripts/smoke-node-sqlite.ts` records `sqlite_version()` per shipped engine and exercises the v82 create/append CAS path. An engine older than SQLite 3.51.3 without an approved vendor backport falls under the WAL-reset advisory and blocks rollout through a separate runtime-upgrade decision.
- **Session cleanup vs erasure:** `clearSession()` removes runtime session state only. Durable evidence rows keep `source_session_id` as provenance and deliberately survive session deletion; the claims tables are append-only at the database boundary, so ordinary deletion is rejected. A privacy-erasure requirement for that durable evidence needs the deferred privileged-purge design before deployment.

## v83 memories-to-claims compatibility rollout order

Migration v83 creates the memories-to-claims compatibility contract: the `legacy_memory_claims` crosswalk, `claim_revision_memory_metadata`, the audit-only `claim_merge_lineage`, the `claim_operations` idempotency envelope, `claim_change_outbox`, `claim_project_generations`, `claim_backfill_failures`, and the transaction-scoped `claim_compatibility_write_state` capability. It also installs semantic write guards over `memories` and `memory_verifications` and records the backfill boundary, expected row count, mode, phase, and v22-takeover state in `schema_migrations_meta` (`claims_backfill_*` keys). An empty corpus completes synchronously inside the migration; a nonempty corpus records pending lazy state for the backfill runner.

- **Object ownership:** every v83 object is migration-owned (`packages/plugin/src/features/magic-context/storage-memory-claims-schema.ts`); `initializeDatabase()` stays at the legacy baseline. The transaction-local write kernel lives in `memory/storage-memory-claims.ts` over the `memory/storage-memory-projection.ts` leaf; `storage-memory.ts` and harness adapters depend on the kernel, never the reverse.
- **Binary order:** ship the OpenCode plugin, Pi plugin, CLI, and `ck-mc` from the same source revision **before** any process opens a database at v83. The first v83-capable process migrates on open; the schema fence (`LATEST_SUPPORTED_VERSION = 83`) then refuses older binaries.
- **Held-open-writer guard:** the schema fence protects new opens, not old handles. The v83 triggers reject INSERT, DELETE, semantic-column UPDATE on `memories`, and every `memory_verifications` write from any connection that does not hold the claims-write capability, so a held-open v82 binary fails before changing semantic fields. Telemetry (`memory_stats`), mural-cue columns, `classified_at` stamps, and embeddings stay outside the guard. Rows at or below the recorded boundary additionally require a crosswalk link before deletion or identity movement, even with the capability held.
- **Capability scope:** `claim_compatibility_write_state` is enabled only inside the owning write transaction and cleared before commit; it is deliberately separate from the module-authority `context_privilege_state`, and privileged module mirror transactions hold both.
- **Backfill mode:** production eager cutoff is zero until full 1K/10K/100K/1M Bun and Node reference-host evidence is run and reviewed. Current bounded evidence is `docs/evidence/claims-backfill/v83-threshold.json`; omitted scales and runtimes are explicit and never extrapolated into policy.
- **v22 takeover and recovery:** v83 owns pending v22 identity work. OpenCode and Pi schedule the shared startup helper once; it resolves v22 takeover before treating a claims `complete` phase as a no-op. Inspect with `magic-context doctor --check-claims-backfill`; repair with `magic-context doctor --retry-claims-backfill`, then restart every running harness.
- **Completion:** cursors only accelerate bounded row and relationship batches. Completion publishes reconciliation version and final outbox watermark only after expected-count, crosswalk, evidence, metadata, lineage-disposition, outbox, generation, failure, and v22 anti-join checks pass in one immediate transaction.
- **Backup:** copy `context.db` only through SQLite-consistent backup, or while all writers are stopped after a checkpoint; copying the main file without its WAL can omit committed state.
- **Downgrade:** refused by the fence. A pre-commit v83 migration failure rolls back to a complete v82 database and reruns; after commit the database rolls forward only.
