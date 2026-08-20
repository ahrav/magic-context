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
