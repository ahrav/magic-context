# fence-a-rust-ships-the-fence-vocabulary-uncalled

## Discovery trigger

While establishing whether Rust has any equivalent of the TypeScript marker
epoch, a search for `format_epoch` across `crates/` turned up
`crates/mc-store/src/sqlite_runtime.rs`, a module whose header says it shares the
direct-format vocabulary with the TypeScript host. Checking who calls it returned
nothing outside tests.

## Evidence trail

`crates/mc-store/src/sqlite_runtime.rs:1-6`, the module header:

```
//! Off-path SQLite runtime probe and connection-contract checks for `store.db`
//! writers, sharing one vocabulary (application ID, format epoch, marker and
//! manifest digests) with the TypeScript host. The fixture
//! `packages/plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json`
//! is the cross-runtime source of truth; the `sqlite_runtime` integration test
//! proves this module against it.
```

What it defines:

| Item | Line | TypeScript counterpart |
| --- | --- | --- |
| `MC_APPLICATION_ID = 0x4D43_5458` | `:12` | `expected.applicationId`, compared at `storage-format-epoch.ts:224-228` |
| `DIRECT_FORMAT_EPOCH: i64 = 1` | `:14-15` | `DIRECT_FORMAT_EPOCH = 1`, `storage-format-epoch.ts:45` |
| `DIRECT_FORMAT_MARKER_TABLE = "mc_format_marker"` | `:17` | the table `readDirectFormatMarker` reads, `storage-format-epoch.ts:188-190` |
| `FORMAT_MARKER_DIGEST_PROTOCOL` | `:20` | the protocol line in `computeMarkerDigest` |
| `SCHEMA_MANIFEST_PROTOCOL` | `:22` | the manifest digest protocol |
| `SQLITE_WAL_RESET_SAFE_MIN_VERSION = [3, 47, 1]` | `:24-26` | the WAL-reset gate at `storage-db.ts:526-535` |
| `compute_schema_manifest_digest` | `:156-168` | `computeExpectedDirectFormat`'s digest |
| `compute_marker_digest` | `:170-184` | `computeMarkerDigest` |

`compute_marker_digest` (`:170-184`) shows the shared line encoding explicitly:
`FORMAT_MARKER_DIGEST_PROTOCOL`, then `application_id=`, `format_epoch=`,
`database_incarnation_id=`, `component_manifest_digest=`, `created_at_ms=`, joined
with newlines and SHA-256'd. That is field-for-field the same set
`storage-format-epoch.ts:209-232` validates.

### The wiring gap

The module is declared `pub mod sqlite_runtime;` at
`crates/mc-store/src/lib.rs:17`. That is the only reference to it from production
Rust. A search for `sqlite_runtime::` across `crates/`, excluding
`crates/mc-store/tests/`, returns zero hits.

Its only consumer is `crates/mc-store/tests/sqlite_runtime.rs`, which imports
`DIRECT_FORMAT_EPOCH`, `DIRECT_FORMAT_MARKER_TABLE`,
`FORMAT_MARKER_DIGEST_PROTOCOL`, `MC_APPLICATION_ID`, `SCHEMA_MANIFEST_PROTOCOL`
and `SQLITE_WAL_RESET_SAFE_MIN_VERSION` at `:8-9`, then asserts them against the
shared fixture at `:51`, `:56`, `:59`, `:95` and `:103`.

So the vocabulary is proven to **agree** with the TypeScript side and is never
used to **gate** anything.

### What the `format_epoch` hits in `lib.rs` actually are

`crates/mc-store/src/lib.rs` mentions `format_epoch` at `:1219` (a column
declaration with `CHECK (format_epoch > 0)`), `:3784` and `:3804` (a select and a
row read), `:3825` (`if binding.format_epoch < 1`), `:3863-3864` (a mismatch
report), and `:11089-11097` (an insert). These belong to the claim-intent binding,
which carries a `format_epoch` field per claim
(`crates/mc-core/src/claim_operation.rs:363`). That is per-operation binding
validation, not a database-open fence, and it is a different concern from the
marker epoch on the database itself.

### Why this matters

Part 3 concluded independently that "For `store.db` none of these are set or
checked: identity is the `cortexkit_schema_version` table's `MAX(version)` ...
so the two runtimes identify their databases by different mechanisms"
([lens-a:529-539](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).
Part 3 also left an open question on the adjacent function: "`sqlite_runtime.rs:156-167`
`compute_schema_manifest_digest` exists to make exactly this comparison cheap. Is
there a plan to wire it into `McStore::open`?"
([lens-a:432](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).

This record names the mechanism that makes the gap easy to miss: a shared fixture
plus a passing cross-runtime test creates a reasonable impression that both sides
enforce one format identity, when only one does.

## Failure scenario

There is no runtime failure to trigger. The failure is in reasoning about the
system:

1. An engineer verifying cross-runtime format agreement finds
   `direct-format-vocabulary-v1.json`, the Rust `sqlite_runtime` module, and a
   passing integration test proving them consistent.
2. They conclude that both runtimes enforce the direct-format identity.
3. They ship a change whose safety depends on the Rust side refusing a
   foreign-vintage `store.db`.
4. Nothing refuses it, because the enforcement never existed.

Compounding this, Part 4 records that `mc-module`'s tests do not run in CI, so
even the agreement half is unverified per push on the Rust side. The fixture pins
the vocabulary; the test that checks the pin does not execute.

## Timing windows and dependencies

No timing window. This is a static wiring gap, unconditional at `HEAD`.

Dependency worth naming: if `sqlite_runtime` were wired into `McStore::open`, the
epoch collapse recorded in `fence-a-malformed-marker-reads-as-epoch-zero` would
need a decision on the Rust side too, because a Rust implementation reading a
marker it cannot parse faces the same three-way choice. Fixing the asymmetry
without fixing the collapse would reproduce the defect in a second runtime.

## What a test must construct

The property's check is a static one, so the cheapest oracle is a build-time or
CI assertion rather than a runtime test:

1. A test that asserts `sqlite_runtime`'s marker and manifest helpers are reached
   from `McStore::open`. In Rust this is awkward to assert directly; a practical
   proxy is a runtime test: create a `store.db`, write an `mc_format_marker` table
   with `format_epoch = 2`, and assert `McStore::open` refuses. Under the current
   code it succeeds, because nothing reads the table.
2. A companion assertion that `PRAGMA application_id` on a `store.db` created by
   `McStore::open` equals `MC_APPLICATION_ID`. Part 3 records it is not set
   ([lens-a:529-539](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)),
   so this would fail and document the gap.

Both are Rust-side tests in a crate whose tests do not run in CI, which is worth
stating in the fault map: the cheapest oracle for this property lands in the one
place the campaign does not execute.

## Investigation log

### Q: Is `sqlite_runtime` genuinely uncalled from production Rust?

- Sources examined: `grep -rn "sqlite_runtime" crates/mc-store/src/lib.rs
  crates/mc-module/src/lib.rs`, which returned only `lib.rs:17`
  (`pub mod sqlite_runtime;`); `grep -rn "sqlite_runtime::" crates/` filtered to
  exclude `crates/mc-store/tests/`, which returned zero hits; the full
  `DIRECT_FORMAT_MARKER_TABLE` / `MC_APPLICATION_ID` / `format_epoch` search
  across `crates/`.
- Findings: the only production reference is the module declaration. Every
  functional reference is in `crates/mc-store/tests/sqlite_runtime.rs`.
- Missing evidence: I searched the two largest crates by name plus a
  crate-wide symbol search. A call through a re-export under a different alias,
  or a `use crate::sqlite_runtime::{...}` followed by bare identifiers, would be
  caught by the symbol search for the item names, which I ran. A call from another
  crate in the workspace would need `mc_store::sqlite_runtime::`, which the
  crate-wide search for `sqlite_runtime::` would have caught.
- Conclusion: resolved with answer. No production Rust path calls it.

### Q: Is `sqlite_runtime` staged for a later wiring?

- Sources examined: the module header at `:1-6`, which describes it as
  "connection-contract checks for `store.db` writers" — present tense, as if
  already in use; Part 3's open question at
  [lens-a:432](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md).
- Findings: the header's phrasing implies current use. Part 3 asked the same
  question about `compute_schema_manifest_digest` specifically and left it open,
  so this is now the second lens to arrive at it independently, which raises its
  priority.
- Missing evidence: a tracking issue or design doc. Not searched; the repository
  uses beads for task tracking and I did not query it.
- Conclusion: needs human input. Two independent lenses have now flagged it.

### Q: Does the shared fixture prove anything useful?

- Sources examined: `crates/mc-store/tests/sqlite_runtime.rs:8-9`, `:51-103`;
  the header's claim at `:3-6`.
- Findings: it proves the two runtimes' constants and digest encodings agree, which
  is genuinely valuable and is a precondition for any future enforcement. It does
  not prove enforcement, and the header does not claim it does. The impression of
  enforcement comes from the header's present-tense framing plus the existence of
  a passing test, not from a false statement.
- Missing evidence: none.
- Conclusion: resolved with answer. The fixture proves agreement at the fixture's
  values. Per the Part 5 scope map's open question on cross-language fixture pairs
  (`docs/properties/part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md:736-744`),
  a shared fixture "proves agreement at the fixture's inputs and nothing beyond
  them", which is exactly the reading that applies here.
