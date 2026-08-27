# Context database format

`context.db` uses an exact direct format. Production openers do not run the
historical migration chain and do not import, backfill, salvage, or reinterpret
older project-memory schemas.

## Format identity

The current family is identified by:

- `PRAGMA application_id = 0x4d435458` (`MCTX`)
- `PRAGMA user_version = 1`
- one immutable `mc_format_marker` row
- a random 32-hex database-incarnation ID
- the SHA-256 digest of the build's registered schema-component manifest
- an exact `main.sqlite_schema` inventory

The schema composer owns component dependencies and object ownership. Duplicate
ownership, dependency cycles, undeclared objects, and a manifest mismatch fail
closed.

## Open behavior

A database family is accepted only when it is:

1. the exact current format; or
2. truly pristine, with no main-schema row, application marker, WAL, SHM,
   rollback journal, or reset artifact.

A pristine family is bootstrapped under `BEGIN IMMEDIATE`. The opener
reclassifies after taking the lock, creates every registered component, validates
the exact inventory, stamps the incarnation marker, and commits before enabling
WAL. Concurrent openers either observe that complete result or refuse the changed
shape.

Every other family is unsupported and remains unchanged. This includes historical
versioned databases, partial direct schemas, malformed markers, orphan sidecars,
and interrupted reset state.

## Runtime contract

Before opening `context.db`, Bun, Node, and dashboard Rust writers probe an
approved WAL-reset-safe SQLite source on an off-path database. The root Rust
module applies the same rule to `store.db`. Application connections verify:

- foreign keys enabled
- WAL activation
- configured busy timeout
- declared synchronous mode

OpenCode, Pi, CLI, dashboard, and `ck-mc` must ship and restart from the same
release. The format fence does not claim to stop a pre-cutover process that
already passed its open checks.

## Explicit reset

Reset is a separate Doctor operation, never a startup branch. Dry-run reports the
main file, WAL, SHM, rollback journal, reset marker, file identities, database
incarnation, and same-directory quarantine destination.

After explicit confirmation, reset:

1. publishes a private identity-bound marker;
2. rechecks holders and every family-file identity;
3. moves journal and sidecar files before the main file;
4. resumes or rolls back an interrupted quarantine idempotently; and
5. leaves the next supported open to create a new database incarnation.

Reset is logical abandonment. It is not migration, recovery, import, or secure
erasure. Quarantined files retain immutable history until the operator applies
their retention policy.

## Claim durability

Project memory is stored only as claims, immutable revisions, evidence,
applicability, policy, operation receipts, semantic effects, and project
generations. Session cleanup removes session-owned runtime state but preserves
claim history and unresolved staged module intents. Operation receipts remain for
the lifetime of the database incarnation and are removed only with whole-family
reset.

The old migration version ranges remain relevant only to historical source
definitions and refusal fixtures. They are not supported production inputs.
