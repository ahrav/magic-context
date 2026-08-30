# Lens D1: claimed-guarantee inventory

Attention focus: every checkable guarantee that documentation, doc comments,
error and panic messages, or SQL constraints assert about durability, atomicity,
idempotency, ordering, determinism, decay, and schema compatibility. Each entry
is a lead. The documentation establishes a contractual obligation. It never
establishes that the implementation satisfies it.

Scope: `crates/mc-store`, `crates/mc-core`, `crates/mc-tokenizer`, plus the
out-of-repo `cortexkit-store` dependency resolved by root `Cargo.toml:16` to
`../commons/crates/cortexkit-store`. Citations to that crate are marked
`cortexkit-store:NNN` and resolve to
`/local/home/ahrav/scratch/commons/crates/cortexkit-store/src/lib.rs` (789
lines).

Two reference corrections, both verified before writing.

First, the task names HEAD `ed487e11`. The repository HEAD is `dde0c051`, three
commits later, with a dirty working tree. `git diff --stat ed487e11..HEAD` over
the three scope crates and `docs/migration-version-lanes.md` returns empty, and
`git status` reports no modification to any of them, so every line reference
below is identical at both revisions. Nothing in this lens depends on the
difference.

Second, the task cites `crates/mc-store/Cargo.toml:16` as the path resolution
for `cortexkit-store`. That line is `cortexkit-store-types = { workspace = true
}`. The member manifest declares `cortexkit-store = { workspace = true }` at
`crates/mc-store/Cargo.toml:15`, and the path lives in the workspace root at
`Cargo.toml:16`. The rest of the lead is confirmed.

Production code in `crates/mc-store/src/lib.rs` ends at line 13930. Lines 13932
and beyond are `#[cfg(test)]` modules. Every `lib.rs` citation below is at or
below 13930 unless it explicitly names a test.

## Claims register

Thirty claims, ordered by safety impact. Reachability is labelled per claim from
the evidence named in that claim, not asserted in a preamble.

- C1: "Application connections verify: foreign keys enabled, WAL activation,
  configured busy timeout, declared synchronous mode"
  [`docs/migration-version-lanes.md:47-50`] → implied property: an opened store
  refuses itself when any of the four connection properties did not take effect.
  Exact check: `reachable` on the verifier call site from `McStore::open`, then
  `always` on the four predicates for the returned connection.
  Implementing code: `sqlite_runtime.rs:113-140`
  `verify_sqlite_connection_contract` implements exactly these four.
  Production call site NOT FOUND. `McStore::open` (`lib.rs:4816-4905`) does not
  call it; the only callers are `crates/mc-store/tests/sqlite_runtime.rs:183,
  189, 194`. Reachability: test-only, on that evidence. Duplicates Lens A
  finding 2; recorded here because it is the doc's most load-bearing runtime
  claim.

- C2: "declared synchronous mode"
  [`docs/migration-version-lanes.md:50`] → implied property: some line of code
  chooses the synchronous level that governs every commit, so durability class
  is a project decision rather than a build default. Exact check: `always` —
  `PRAGMA synchronous` on a `McStore::open` connection equals a value a setter
  wrote. Implementing code: NOT FOUND. `grep -rn synchronous
  cortexkit-store/src/` exits 1, no match. Nothing in `crates/mc-store/src`
  sets it either. Reachability: default-production, because the omission
  applies to every open. This is the single highest-impact claim in the lens.

- C3: "Before opening `context.db`, Bun and Node writers probe an approved
  WAL-reset-safe SQLite source on an off-path database. The root Rust module
  applies the same rule to `store.db`."
  [`docs/migration-version-lanes.md:42-44`] → implied property: an engine below
  the declared WAL-reset-safe minimum is refused before `store.db` is opened for
  writing. Exact check: `reachable` on the gate call site from the Rust open
  path. Implementing code: `sqlite_runtime.rs:45` and `:92` define
  `probe_sqlite_engine_identity_off_path` and `evaluate_sqlite_runtime_gate`.
  Production call site NOT FOUND. Reachability: test-only. The Rust half of the
  sentence is unimplemented.

- C4: "Durability + concurrency pragmas: WAL for concurrent readers, a busy
  timeout so a transient lock waits rather than erroring, foreign keys on."
  [`cortexkit-store:285-286`] → implied property: the comment enumerates the
  pragmas that decide durability, so the set it lists is the set that governs
  it. Exact check: `always` — the pragmas applied to the real database file are
  exactly those the comment claims, and the set is sufficient for the word
  "durability". Implementing code: `cortexkit-store:287` `journal_mode = WAL`,
  `:289` `busy_timeout(Duration::from_secs(5))`, `:291` `foreign_keys = ON`.
  All three are set and match the comment. The claim is accurate about what it
  lists and incomplete about what it names: WAL alone fixes the journal, not
  the fsync discipline, so a comment headed "Durability" omits the pragma that
  decides it. Reachability: default-production, this is the only place any
  pragma reaches the file. See C2.

- C5: "one immutable `mc_format_marker` row"
  [`docs/migration-version-lanes.md:13`] → implied property: the family is
  identified by a marker row that cannot be rewritten after creation. Exact
  check: `always` — the row exists after a supported open and no statement
  updates or deletes it. Implementing code: NOT FOUND for `store.db`. No
  `mc_format_marker` object appears in `MIGRATIONS` (`lib.rs:432-1312`) and no
  production line references the name. Reachability: not reachable in this
  crate. See C8 for the identity mechanism that is actually used.

- C6: "`PRAGMA application_id = 0x4d435458` (`MCTX`)" and "`PRAGMA user_version
  = 1`" [`docs/migration-version-lanes.md:11-12`] → implied property: the file
  carries an in-header family stamp that a non-owner can read without parsing
  the schema. Exact check: `always` — both pragmas hold the declared values on
  a supported store. Implementing code: NOT FOUND for `store.db`. `McStore::open`
  sets neither. Reachability: not reachable in this crate.

- C7: "the SHA-256 digest of the build's registered schema-component manifest"
  and "an exact `main.sqlite_schema` inventory"
  [`docs/migration-version-lanes.md:15-16`] → implied property: an opened store
  whose schema objects differ from the build's declared set is refused rather
  than queried. Exact check: `always` — the live `main.sqlite_schema` inventory
  equals the object set the shipped bootstrap declares. Implementing code:
  `sqlite_runtime.rs:156-167` `compute_schema_manifest_digest` exists for
  exactly this comparison. Production call site NOT FOUND. Reachability:
  test-only. Consequence: a schema and version disagreement surfaces as a
  missing-table error at first use.

- C8: "The old migration version ranges remain relevant only to historical
  source definitions and refusal fixtures. They are not supported production
  inputs." [`docs/migration-version-lanes.md:82-83`] → implied property: a
  store recording any schema version other than the shipped one is refused at
  open. Exact check: `always` — open succeeds only when the recorded `mc_cache`
  version is absent or exactly `LATEST_MIGRATION_VERSION`. Implementing code:
  `lib.rs:1342` sets `OLDEST_ADOPTABLE_MIGRATION_VERSION =
  LATEST_MIGRATION_VERSION`; `lib.rs:1375-1385` `refuse_pre_cutover_store`;
  `lib.rs:433` `version: 57`. Reachability: default-production, called at
  `lib.rs:4873`. Partially implemented: the guard is `recorded <
  OLDEST_ADOPTABLE`, so it refuses older and admits newer. A store written by a
  newer binary opens silently under the older binary's expectations. The doc
  claims a fence; the code is a floor.

- C9: "Duplicate ownership, dependency cycles, undeclared objects, and a
  manifest mismatch fail closed."
  [`docs/migration-version-lanes.md:18-20`] → implied property: four distinct
  composition faults each abort the open rather than degrade. Exact check:
  `always` — each of the four conditions produces a refusal. Implementing code:
  NOT FOUND for `store.db`. There is no schema composer in these three crates:
  `MIGRATIONS` is one flat SQL string (`lib.rs:434-1311`), so component
  ownership and dependency order are not modelled and cannot be violated or
  checked. The claim describes the `context.db` composer, not this store.

- C10: "A pristine family is bootstrapped under `BEGIN IMMEDIATE`... Concurrent
  openers either observe that complete result or refuse the changed shape."
  [`docs/migration-version-lanes.md:30-34`] → implied property: bootstrap takes
  the write lock at `BEGIN`, so a racing opener cannot interleave. Exact check:
  `always` — the bootstrap transaction is IMMEDIATE and no read outside it
  decides the bootstrap. Implementing code: partial. `with_conn_fenced` does use
  `TransactionBehavior::Immediate` (`cortexkit-store:191`), but the migration
  runner uses `conn.transaction()` at `cortexkit-store:366`, which is DEFERRED,
  and the version-table creation and current-version read at
  `cortexkit-store:341-357` precede any transaction. Reachability:
  default-production. The claim is true of writes and false of bootstrap.

- C11: "each in its own transaction together with its version record, so a
  migration and the record that it ran commit atomically (a crash mid-migration
  leaves it un-recorded and it re-runs cleanly next open)"
  [`cortexkit-store:329-332`] → implied property: migration statements and the
  version row are all-or-nothing. Exact check: `always` — after any crash and
  reopen, presence of the version row implies every object it creates exists,
  and absence implies none does. Implementing code: `cortexkit-store:366`
  `conn.transaction()`, `:369` `execute_batch`, `:375-380` version insert,
  `:381` single `commit()`. The transaction does span both. Reachability:
  default-production. Accurate as written; the residual risk is whether any
  statement in the 878-line batch forces an implicit commit, which this lens
  did not enumerate.

- C12: "writes go through `cortexkit-store`'s epoch-fenced transaction (rejects
  a superseded lease handover) AND an app-level `row_version` CAS inside that
  same transaction. The epoch fence only rejects a STRICTLY-NEWER writer (lease
  handover) — an equal-epoch writer is NOT fenced — so the row_version CAS is
  what catches a same-epoch second writer." [`lib.rs:6-10`] → implied property:
  two same-epoch writers cannot both commit a state change to one session row;
  exactly one observes a CAS conflict. Exact check: `always` — for concurrent
  commits on one `session_id`, committed count is 1 and the loser receives
  `CasConflict`. Implementing code: `lib.rs:3369` `CasConflict` variant,
  `lib.rs:3651` commit outcome, `lib.rs:7354-7357` reads `row_version` inside
  the fenced transaction before the upsert at `7390`. Reachability:
  default-production. The doc comment is unusually precise about its own limit,
  which makes it a good claim rather than a lead.

- C13: "It is conditional: a pass writes ONLY when durable state actually
  changed (a pure SoftPlus replay mutates nothing and writes nothing), so the
  no-write-on-defer guarantee holds." [`lib.rs:10-12`] → implied property: a
  pass that changes nothing performs no durable write and does not advance
  `row_version`. Exact check: `always` — for a replay whose decision is a
  defer, the row's `row_version` and bytes are unchanged. Implementing code:
  `lib.rs:1650` documents an audit trail "without advancing the cache
  row_version"; `lib.rs:2739` `Updated { row_version }` distinguishes the
  written case. Reachability: default-production. Needs a check that reads
  `row_version` across a deferring pass; the guarantee is stated but its
  negative case is the interesting one.

- C14: "Session cleanup removes session-owned runtime state but preserves claim
  history and unresolved staged module intents."
  [`docs/migration-version-lanes.md:77-79`] → implied property: a session
  delete never removes a claim revision or an unresolved staged intent. Exact
  check: `always` — after `delete_session`, every `mc_claim_intents` row in
  state `staged` and every claim-mirror revision that existed before still
  exists. Implementing code: `lib.rs:5432-5475` `delete_session`, which at
  `lib.rs:5453` uses `PRAGMA table_info` to discover tables carrying a
  `session_id` column and deletes across them in a loop (`5448-5472`).
  Reachability: default-production. This is a discovery-driven delete, so the
  claim's scope depends on which tables happen to carry that column rather
  than on an explicit preserve list. Any future table gaining a `session_id`
  column joins the delete set silently.

- C15: "Operation receipts remain for the lifetime of the database incarnation
  and are removed only with whole-family reset."
  [`docs/migration-version-lanes.md:79-80`] → implied property: no code path
  short of reset deletes a receipt row. Exact check: `always(!X)` where X is a
  receipt row disappearing without a reset. Implementing code: the table is
  `mc_claim_mirror_receipts` (`lib.rs:1298-1309`), keyed
  `(database_incarnation_id, receipt_id)` at `1309`. Implementing enforcement
  NOT FOUND: no `DELETE` guard and no trigger prevents removal, and the table
  has no `session_id` column, so C14's discovery loop does not reach it. The
  retention claim rests on the absence of a deleting caller, which is a
  convention, not a constraint. Reachability: default-production.

- C16: "Reset is a separate Doctor operation, never a startup branch."
  [`docs/migration-version-lanes.md:57`] → implied property: no open path can
  quarantine or abandon a database. Exact check: `unreachable` on any reset
  entry point from `McStore::open`. Implementing code: `McStore::open`
  (`lib.rs:4816-4905`) contains no reset call; its only mutating post-migration
  steps are `repair_note_artifacts_v51` at `4902` and
  `prune_transform_session_roots` at `4903`. Reachability: the guarantee holds
  in this crate on that evidence. The reset implementation itself is outside
  this scope.

- C17: "resumes or rolls back an interrupted quarantine idempotently"
  [`docs/migration-version-lanes.md:66`] → implied property: reset run twice, or
  killed and rerun, reaches the same final state. Exact check: `always` — final
  file layout after N interrupted attempts equals that after one clean run.
  Implementing code: NOT FOUND in this scope. No quarantine or marker logic
  appears in the three crates. Reachability: out of scope; recorded so the
  claim is not lost.

- C18: "DETERMINISM is the load-bearing property... The vocab is VENDORED and
  frozen, and tiktoken-rs + fancy-regex are version-pinned, so the same text
  tokenizes identically across runs and machines."
  [`crates/mc-tokenizer/src/lib.rs:13-17`] → implied property: `estimate_tokens`
  and `encode_ordinary` are pure functions of the input string, stable across
  processes and hosts. Exact check: `always` — same input yields the same token
  ID sequence across a rebuild and a different machine. Implementing code:
  vocab embedded at build time via `include_str!` at
  `crates/mc-tokenizer/src/lib.rs:37`; single `OnceLock` build at `:47-67`;
  `tiktoken-rs = "=0.11.0"` exactly pinned at
  `crates/mc-tokenizer/Cargo.toml:19`. Reachability: default-production. One
  qualification: `fancy-regex` is claimed as "version-pinned" but is a
  transitive dependency with no `=` pin in any manifest. It is pinned only by
  `Cargo.lock` (tracked, `fancy-regex 0.17.0` at `Cargo.lock:563-565`), which
  the manifest comment at `Cargo.toml:17-18` acknowledges by saying "Cargo.lock
  is the pin". The claim holds for workspace binary builds and would not hold
  for a consumer resolving this crate as a library dependency.

- C19: "Embedded at build time so there is no runtime file read or network fetch
  (both would break the determinism guarantee on resume)."
  [`crates/mc-tokenizer/src/lib.rs:34-36`] → implied property: tokenization
  performs no I/O. Exact check: `always` — no file or socket syscall occurs
  during `estimate_tokens`. Implementing code: `include_str!` at `:37` is the
  only vocab source; the crate's dependency set is `tiktoken-rs`, `base64`,
  `rustc-hash` (`Cargo.toml:19-25`), none of which opens the asset at runtime.
  Reachability: default-production. Verified by construction, so this is a
  satisfied claim rather than a lead.

- C20: "Tier demotion is byte-deterministic at render time, driven by
  compartment age, an emitted importance... and live budget pressure — no LLM
  call." [`crates/mc-core/src/decay.rs:4-7`] → implied property: tier selection
  is a pure total function of its numeric inputs. Exact check: `always` — equal
  inputs yield equal tiers within one binary. Implementing code:
  `crates/mc-core/src/decay.rs:99-104` `should_archive`,
  `:109-123` `rendered_tier`, `:129-140` `compute_budget_pressure`; all take
  values and return values with no I/O, and the crate sets
  `#![forbid(unsafe_code)]` at `crates/mc-core/src/lib.rs:9`. Reachability:
  default-production.

- C21: "the cache-stability invariant this layer must satisfy is INTRA-module
  determinism... which f64 gives for free (same code, same result). Bit-exact
  agreement with the reference TS is a development cross-check... not a runtime
  invariant" [`crates/mc-core/src/decay.rs:15-19`] → implied property: the
  determinism obligation is scoped to one binary, and cross-runtime divergence
  is explicitly not a violation. Exact check: `always` within a process;
  cross-language equality is a `sometimes` development check, not a runtime
  assertion. Implementing code: the golden test at
  `crates/mc-core/src/decay.rs:249-253` loads `decay-golden.json` and is the
  named cross-check. Reachability: the runtime half is default-production, the
  golden is test-only. Worth contrasting with C18: the tokenizer claims
  cross-machine determinism, decay deliberately claims only intra-binary. Two
  layers of one pipeline assert different determinism strengths, and the
  pipeline's guarantee is the weaker one.

- C22: "the model's invariants (age/importance monotonicity, finite demotion
  even at importance 100, append stability, O(H) render cost, budget
  self-tuning) hold by the same construction."
  [`crates/mc-core/src/decay.rs:10-13`] → implied property: five named
  mathematical invariants of the decay curve. Exact check: `always` per
  invariant, as a property test over the input domain. Implementing code:
  four are asserted in the crate's own tests at
  `crates/mc-core/src/decay.rs:159` (finite demotion at importance 100),
  `:170` (age monotonicity), `:181` (importance monotonicity), `:190` (pressure
  protection), `:219-220` (budget self-tuning). Reachability: the invariants are
  default-production; their checks are test-only. Append stability and O(H)
  render cost have no located check. "Hold by the same construction" is an
  appeal to the reference implementation, not a proof in this crate.

- C23: "Monotonic absolute ordinal — strictly increasing across the lineage,
  NEVER positional (the window start moves; the ordinal does not)."
  [`crates/mc-core/src/lib.rs:28-30`] → implied property: for any two items in
  one lineage, later implies strictly greater `ordinal()`. Exact check:
  `always` — over a loaded lineage, `ordinal` is strictly increasing. Implementing
  code: NOT FOUND as an enforcement point. This is a trait-method contract on
  `CkItem` (`crates/mc-core/src/lib.rs:23-37`); `mc-core` never constructs an
  item and cannot check it. Enforcement is the implementor's duty in
  `mc-module`, outside this scope. Reachability: default-production obligation
  with no in-scope guard. See the conventionally-enforced-only section.

- C24: "Synthetic items are stripped before boundary/coverage/tail computation —
  they must never masquerade as the real boundary."
  [`crates/mc-core/src/lib.rs:31-34`] → implied property: no boundary,
  coverage, or tail value is ever derived from an item whose `synthetic()` is
  true. Exact check: `always(!X)` where X is a boundary id belonging to a
  synthetic item. Implementing code: the trait declares `synthetic()` with a
  `false` default at `crates/mc-core/src/lib.rs:35-37`. The stripping itself is
  NOT FOUND in `mc-core`. A defaulted-to-`false` predicate means an implementor
  that forgets to override it silently classifies module blocks as real
  conversation items, which is the exact failure the comment forbids.

- C25: "This is a faithful port of the council-validated model. The
  hyperparameters, tier-cost constants, and log-cost boundary values are
  reproduced exactly from the reference implementation."
  [`crates/mc-core/src/decay.rs:9-11`] → implied property: eleven named
  constants equal the reference values. Exact check: `always` — each constant
  equals its reference value. Implementing code: `H50 = 24.0` at
  `crates/mc-core/src/decay.rs:23`, `D = 25.0` at `:25`, `G = 2.0` at `:27`,
  `Z1..Z4` at `:31, 33, 35, 37`, `P_FLOOR = 0.1` at `:39`, `TIER_COST` at
  `:42`. The values are present; equality with the reference is asserted only
  by the golden test named in C21. Reachability: default-production.

- C26: "Both runtimes are proven against the golden corpus
  `memory/fixtures/claim-operation-contract-v1.json`."
  [`crates/mc-core/src/claim_operation.rs:3-4`] → implied property: the Rust
  and TypeScript canonical encoders agree byte-for-byte on a shared corpus.
  Exact check: `always` over the corpus — Rust canonical output equals the
  recorded expectation. Implementing code: the canonical encoder and its rules
  are at `crates/mc-core/src/claim_operation.rs:6-18` (doc) with
  `MAX_SAFE_INTEGER = 9_007_199_254_740_991` at `:43` and
  `number_as_safe_integer` at `:66-72`. Reachability: default-production
  encoder; the proof is a test-only corpus whose path is outside these three
  crates. The word "proven" is doing more work than a golden corpus supports:
  it pins agreement on the enumerated cases, not on the value domain.

- C27: "This is independent from request/result encoding versions so transport
  evolution cannot silently reinterpret persisted command bytes."
  [`crates/mc-core/src/claim_operation.rs:29-31`] → implied property: a
  transport-version change cannot alter the meaning of a stored request.
  Exact check: `always` — a stored intent decodes under the encoding version it
  recorded, independent of the intent protocol version. Implementing code:
  `CLAIM_REQUEST_ENCODING_VERSION = 1` at
  `crates/mc-core/src/claim_operation.rs:27`,
  `CLAIM_RESULT_ENCODING_VERSION = 1` at `:28`,
  `CLAIM_INTENT_PROTOCOL_VERSION = 1` at `:32`; the storage side pins the
  encoding version with a SQL constraint, see S6. Reachability:
  default-production. All three constants are currently `1`, so the
  independence the comment claims has never been exercised by a divergence.

- C28: "compartment seq must be strictly increasing: {current} followed
  {previous}" [`lib.rs:3565`] → implied property: compartment sequence numbers
  form a strictly increasing series per session. Exact check: `always` — for
  consecutive persisted compartments, `sequence` strictly increases.
  Implementing code: the error variant is constructed in `McStoreError`
  (`lib.rs:3361`) and formatted at `3565`; ordering is also validated for the
  seed path at `lib.rs:4289` ("seeded compartment ordinal ranges must be
  non-negative and ordered"). Reachability: default-production. Note the SQL
  side does not encode it: `mc_compartments` has no `CHECK` on `sequence`
  monotonicity, only the uniqueness at S9.

- C29: "acknowledged transition must not supply result_json" and "result_json is
  required for this transition" [`lib.rs:11184`, `lib.rs:11190`] → implied
  property: the presence of a result envelope is determined by the transition
  kind. Exact check: `always` — for each transition kind, `result_json` presence
  matches the kind's requirement. Implementing code: the match at
  `lib.rs:11180-11190` enforces it in application code before the write, and
  `validate_claim_result_json` at `lib.rs:3924-3937` additionally requires the
  stored bytes be canonical, comparing at `3934`. Reachability:
  default-production. This claim is dual-enforced; see S7.

- C30: "claim mutation transaction cannot return a rebuild outcome"
  [`lib.rs:3919`, an `unreachable!`] → implied property: a specific outcome
  variant is unconstructible on this path. Exact check: `unreachable` on that
  code location, which is the correct semantics because it names a code point
  that must not execute rather than a forbidden state. Implementing code: the
  `unreachable!` at `lib.rs:3919` is itself the guard. Reachability:
  default-production panic site. A panic is the enforcement, so if the
  invariant is wrong the failure mode is a process abort inside a write
  transaction rather than a returned error.

## SQL-level invariants (constraints as claims)

`MIGRATIONS` at `lib.rs:432-1312` is one `Migration`, `version: 57` at
`lib.rs:433`, one consolidated SQL string at `434-1311`. Mechanically counted
over exactly that range: 42 `CREATE TABLE`, 15 `CREATE TRIGGER`, and 361
declared constraints, broken down as 249 `NOT NULL`, 58 `CHECK` lines, 42
`PRIMARY KEY`, 11 `UNIQUE` (3 standalone `CREATE UNIQUE INDEX` plus 8 inline
column or table constraints), and 1 `FOREIGN KEY`. The `CHECK` figure counts
lines matching the keyword; a few multi-line `CHECK (` bodies mean the number of
distinct check constraints is slightly lower.

The single most notable structural fact: 42 tables and exactly one
`FOREIGN KEY`. Referential integrity is almost entirely conventional here even
though `foreign_keys = ON` is set (`cortexkit-store:291`), so the pragma has
almost nothing to enforce.

- S1: `CREATE UNIQUE INDEX idx_mc_note_eval_claims_active_note ON
  mc_note_eval_claims(project, note_id) WHERE terminal_kind IS NULL`
  [`lib.rs:1196-1197`] — encodes: at most one live evaluation claim per note per
  project, with `terminal_kind IS NULL` as the liveness predicate. Also enforced
  in app code: yes, and redundantly. The candidate query excludes already-claimed
  notes with `id NOT IN (SELECT note_id FROM mc_note_eval_claims WHERE project =
  ?1 AND terminal_kind IS NULL)` at `lib.rs:13293-13296`. That read and the
  subsequent insert are inside one fenced transaction, so the app check is sound
  and the index is the backstop. Highest-safety constraint in the schema: it is
  the mutual-exclusion guarantee for note evaluation.

- S2: `CREATE UNIQUE INDEX idx_mc_note_eval_claims_active_slot ON
  mc_note_eval_claims(project, evaluator_instance, evaluator_slot) WHERE
  terminal_kind IS NULL` [`lib.rs:1199-1201`] — encodes: an evaluator slot holds
  at most one live claim, so a worker cannot double-book itself. Also enforced in
  app code: yes. `lib.rs:13269-13274` selects the slot's live claim first and
  rebinds it via `rebind_note_eval_claim_tx` (`lib.rs:13714`) rather than
  inserting a second, which is what makes acquisition idempotent under a lost
  response.

- S3: `UNIQUE (project, acquisition_id)` on `mc_note_eval_claims`
  [`lib.rs:1193`] — encodes: an acquisition id is consumed at most once per
  project, the deduplication key for a retried acquire. Also enforced in app
  code: partially. The replay path at `lib.rs:13245-13262` returns a
  `NoWork { replayed: true }` outcome for a recognised acquisition rather than
  inserting, but the uniqueness itself is the constraint's job.

- S4: `PRIMARY KEY (producer, operation_key)` on `mc_claim_intents`
  [`lib.rs:1230`] — encodes: one staged intent per producer and operation key,
  which is the idempotency key for claim operations. Also enforced in app code:
  yes, via the upsert at `lib.rs:1259` (`SET state = ?1, result_json =
  COALESCE(?2, result_json)`) and the replay short-circuit at `lib.rs:11240`
  that returns the existing record when `result_json` already matches.

- S5: `CHECK ((state = 'staged' AND result_json IS NULL) OR (state <> 'staged'
  AND result_json IS NOT NULL))` on `mc_claim_intents` [`lib.rs:1231-1234`] —
  encodes: a staged intent carries no result and any resolved intent carries one,
  so a half-written transition cannot persist. Also enforced in app code: yes, at
  `lib.rs:11180-11190`, with the stronger canonicality requirement at
  `lib.rs:3924-3937`. This is the strongest dual-enforced invariant in the
  schema: SQL requires presence, app code requires presence and canonical bytes.

- S6: `request_encoding_version INTEGER NOT NULL CHECK
  (request_encoding_version = 1)` on `mc_claim_intents` [`lib.rs:1222`] —
  encodes: schema compatibility, in that this build persists and accepts exactly
  encoding version 1. Also enforced in app code: yes, as the constant
  `CLAIM_REQUEST_ENCODING_VERSION = 1` at
  `crates/mc-core/src/claim_operation.rs:27`. Note the compatibility direction:
  an equality check means a version-2 row cannot be written by a newer binary
  into a database this binary also opens, so the constraint refuses forward
  data rather than tolerating it. Same shape at `mirror_version = 1` and
  `vector_version = 1` on `mc_claim_mirror_state` (`lib.rs:1252-1253`).

- S7: `state TEXT NOT NULL CHECK (state IN ('staged', 'context-committed',
  'acknowledged', 'terminal-rejected'))` on `mc_claim_intents`
  [`lib.rs:1223-1225`] — encodes: the closed state vocabulary of the intent
  lifecycle. Also enforced in app code: yes, by the `ClaimIntentAckKind` enum
  imported at `lib.rs:25` and the transition match at `lib.rs:11180-11190`. The
  constraint pins the alphabet, not the transition graph: no `CHECK` or trigger
  forbids `acknowledged` moving back to `staged`. Ordering of the lifecycle is
  app-only.

- S8: `length(database_incarnation_id) = 32` on six tables
  [`lib.rs:1218`, `1243`, `1256`, `1263`, `1273`, `1301`] — encodes: the
  32-character database-incarnation ID from
  `docs/migration-version-lanes.md:14`, tying every claim-mirror and intent row
  to one database incarnation so a restored or reset file cannot silently adopt
  another incarnation's rows. Also enforced in app code: yes and more strictly,
  but not uniformly. `is_lower_hex(x, 32)` appears at `lib.rs:3820`, `4124`,
  `11310`, and `claim_mirror.rs:253`, and requires lowercase hex where SQL
  accepts any 32 characters. Four validation sites against six constrained
  tables is an asymmetry worth resolving; see the open questions.

- S9: `UNIQUE(session_id, block_id)` on the compartment block table
  [`lib.rs:557`] and `UNIQUE(session_id, target_id)` [`lib.rs:500`] — encodes:
  one row per block or target within a session, the append-idempotency key for
  compartment writes. Also enforced in app code: the writers are
  `insert_compartment_tx` (`lib.rs:12352`) and `append_compartments_tx`
  (`lib.rs:12609`); ordering is separately validated at `lib.rs:4289-4294`
  ("seeded compartment sequences must be unique"), which duplicates the
  uniqueness claim in app code for the seed path only.

- S10: `UNIQUE(note_id, session_id, delivered_pass_fingerprint)`
  [`lib.rs:752`] — encodes: a note is delivered at most once per session per
  pass fingerprint, which is the at-most-once delivery guarantee for note
  surfacing. Also enforced in app code: not located as a pre-check. This one
  appears to be constraint-only, which makes the insert's conflict handling the
  real contract.

- S11: `UNIQUE (database_incarnation_id, revision_locator)` on
  `mc_claim_mirror_claims` [`lib.rs:1290`] — encodes: a revision locator
  identifies exactly one claim per incarnation, so an immutable revision cannot
  be reused for a second claim. Also enforced in app code: the upsert at
  `claim_mirror.rs:588-601` targets the primary key
  `(database_incarnation_id, public_claim_id)` (`lib.rs:1289`) and rewrites
  `revision_locator`, so a locator collision across two claim ids is caught by
  this constraint rather than by app code.

- S12: `FOREIGN KEY (database_incarnation_id, project_id) REFERENCES
  mc_claim_mirror_projects(database_incarnation_id, project_id) ON DELETE
  CASCADE` [`lib.rs:1291-1293`] — encodes: a mirror claim cannot outlive its
  project row, and removing a project removes its claims atomically. Also
  enforced in app code: no. This is the schema's only foreign key, and its
  cascade is the only referential action in 42 tables. It is therefore the only
  place `foreign_keys = ON` (`cortexkit-store:291`) changes behaviour, which
  makes that pragma's blast radius exactly one edge.

- S13: `id INTEGER PRIMARY KEY CHECK (id = 1)` on
  `mc_claim_intent_controls` [`lib.rs:1241`] and `mc_claim_mirror_state`
  [`lib.rs:1252`] — encodes: a singleton control row, so there is exactly one
  transition state and one mirror state per database. Also enforced in app code:
  the constraint is the enforcement; no app-side singleton guard was located.
  This is a clean structural invariant: the table cannot hold a second row.

- S14: `last_effect_id INTEGER NOT NULL CHECK (last_effect_id >=
  first_effect_id)` with `expected_effect_count > 0` and `first_effect_id > 0`
  on `mc_claim_mirror_receipts` [`lib.rs:1303-1305`] — encodes: a receipt covers
  a non-empty, correctly ordered effect range. Also enforced in app code: not
  located. Note what is not encoded: nothing ties `expected_effect_count` to
  `last_effect_id - first_effect_id + 1`, so a receipt can declare a count that
  contradicts its own range and satisfy every constraint. That gap is the
  effect-accounting invariant the schema stops just short of.

- S15: `json_valid(...)` on `attributes_json`, `applicability_json`,
  `policy_json` [`lib.rs:1280`, `1284`, `1285`] and
  `generation_vector_json` [`lib.rs:1307`] — encodes: stored JSON columns parse.
  Also enforced in app code: yes and more strictly. `claim_mirror.rs:581-584`
  runs `canonical_json_encode` on all three before the insert, so app code
  demands canonical form where SQL demands only validity. The lead is the error
  mapping: all three `map_err(|_| rusqlite::Error::InvalidQuery)` at
  `claim_mirror.rs:581-584`, which discards the reason a value was
  non-canonical.

- S16: `content_digest TEXT NOT NULL CHECK (length(content_digest) = 64)` and
  `group_digest` likewise [`lib.rs:1279`, `1306`], with
  `request_digest` at [`lib.rs:1222`] — encodes: digests are SHA-256 hex width.
  Also enforced in app code: for `request_digest` yes, `is_lower_hex(digest,
  64)` at `lib.rs:11175` with the message "request digest must be 64 lowercase
  hex characters" at `11177`. For `content_digest` and `group_digest` the SQL
  length check is the only located guard, so an uppercase or non-hex 64-char
  value satisfies the schema.

- S17: `public_claim_id TEXT NOT NULL CHECK (length(public_claim_id) = 36)`
  [`lib.rs:1275`] — encodes: the public claim id is 36 characters. Also enforced
  in app code: yes, `is_valid_public_claim_id` is imported at
  `claim_mirror.rs:11`, and `PUBLIC_CLAIM_ID_PREFIX = "mcm_"` at
  `crates/mc-core/src/claim_operation.rs:41` means the app form is a prefixed
  id. SQL checks only width, so it cannot see a missing prefix.

- S18: `CHECK (kind IN ('message', 'tool_call', 'tool_result'))`
  [`lib.rs:553`], `CHECK (type IN ('session', 'smart'))` [`lib.rs:699`],
  `CHECK (status IN ('active', 'pending', 'ready', 'surfacing', 'surfaced',
  'dismissed'))` [`lib.rs:704`], `CHECK (phase IN ('compile', 'due',
  'liveness', 'fallback'))` [`lib.rs:1177`], and roughly twenty further
  enumeration checks — encodes: closed vocabularies for kind, status, phase, and
  disposition columns. Also enforced in app code: mostly yes, via matching Rust
  enums such as `HistorianPhase` (`lib.rs:1420`) and `CkKind` (`lib.rs:268`).
  As with S7, these pin alphabets and never transitions: the six-state `status`
  ladder has no constraint preventing `dismissed` returning to `pending`.

- S19: `authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0)`
  and `format_epoch INTEGER NOT NULL CHECK (format_epoch > 0)`
  [`lib.rs:1221`, `1220`, and repeats at `1244`, `1265-1267`] — encodes:
  generation and epoch counters are non-negative, with epochs strictly positive
  so `0` is reserved as absent. Also enforced in app code: the positivity of
  `format_epoch` is checked at `lib.rs:3826-3827` with the message "format epoch
  must be positive". Monotonicity is not encoded anywhere in SQL: no constraint
  or trigger prevents a generation counter moving backwards, which is the
  invariant an epoch fence actually depends on.

- S20: `WITHOUT ROWID` on `mc_claim_mirror_projects`, `mc_claim_mirror_claims`,
  and `mc_claim_mirror_receipts` [`lib.rs:1270`, `1295`, `1309`] — encodes a
  physical-layout decision rather than a logical invariant, but it has a logical
  consequence worth recording: these tables have no stable `rowid`, so nothing
  outside them can hold a rowid reference, and identity is exactly the declared
  primary key.

## Contract-vs-code leads

Each lead states the documented obligation and the implementation position, both
cited. None is resolved in the documentation's favour.

1. `docs/migration-version-lanes.md:50` requires a "declared synchronous mode"
   and `cortexkit-store:285-286` heads its pragma block "Durability +
   concurrency pragmas". No code in either crate sets `PRAGMA synchronous`
   (`grep -rn synchronous cortexkit-store/src/` exits 1). The pragma that
   decides whether an acknowledged commit survives power loss is chosen by the
   dependency's build defaults. This is the highest-impact disagreement in the
   lens because it silently sets the durability class of every write.

2. `docs/migration-version-lanes.md:47-50` states that "Application connections
   verify" four properties. `verify_sqlite_connection_contract`
   (`sqlite_runtime.rs:113-140`) implements exactly those four and has no
   production caller; `McStore::open` (`lib.rs:4816-4905`) does not call it. No
   application connection in this crate verifies any of the four. The verifier
   would also accept `synchronous = 1` (`NORMAL`), which does not fsync at
   commit in WAL, so wiring it in as written would not settle lead 1.

3. `docs/migration-version-lanes.md:9-17` defines format identity by
   `application_id`, `user_version`, an immutable `mc_format_marker` row, a
   manifest digest, and an exact `main.sqlite_schema` inventory. For `store.db`
   none of the five is set or checked: identity is the `MAX(version)` of
   `cortexkit_schema_version` (`cortexkit-store:351-357`, read at
   `lib.rs:5348-5358`), and no `mc_format_marker` object exists in `MIGRATIONS`
   (`lib.rs:432-1312`). The document describes a format fence the Rust store
   does not implement.

4. `docs/migration-version-lanes.md:82-83` says old version ranges are not
   supported production inputs. `refuse_pre_cutover_store` (`lib.rs:1375-1385`)
   guards on `recorded < OLDEST_ADOPTABLE_MIGRATION_VERSION`
   (`lib.rs:1342`), which refuses older versions and admits newer ones, while
   `run_migrations` skips any bundled version at or below the recorded one
   (`cortexkit-store:363-365`). An older binary therefore opens a
   newer-than-shipped database silently.

5. `docs/migration-version-lanes.md:30-34` says a pristine family is
   bootstrapped under `BEGIN IMMEDIATE` and that concurrent openers observe the
   complete result or refuse. The bootstrap runs through `run_migrations`, whose
   per-migration transaction is `conn.transaction()` and therefore DEFERRED
   (`cortexkit-store:366`), with the version-table creation and current-version
   read outside any transaction (`cortexkit-store:341-357`). `IMMEDIATE` is used
   on the write path (`cortexkit-store:191`) but not on the path the sentence
   describes.

6. `docs/migration-version-lanes.md:18-20` promises that duplicate ownership,
   dependency cycles, undeclared objects, and a manifest mismatch fail closed.
   No schema composer exists in these crates; `MIGRATIONS` is a flat SQL string
   (`lib.rs:434-1311`). Three of the four faults are not expressible against
   this store, and the fourth has an unwired implementation
   (`sqlite_runtime.rs:156-167`).

7. `crates/mc-tokenizer/src/lib.rs:15-17` claims `fancy-regex` is
   "version-pinned". It is a transitive dependency with no `=` requirement in
   any manifest; `Cargo.toml:19` pins only `tiktoken-rs = "=0.11.0"`, and
   `Cargo.toml:17-18` concedes "Cargo.lock is the pin". The determinism claim
   at `:13-17` therefore holds for workspace binary builds and not for any
   consumer that resolves this crate as a library.

8. `crates/mc-core/src/lib.rs:31-34` says synthetic items "must never
   masquerade as the real boundary", and the `synthetic()` trait method defaults
   to `false` (`crates/mc-core/src/lib.rs:35-37`). A forgotten override produces
   exactly the forbidden outcome, and the default direction is the unsafe one.

9. `docs/migration-version-lanes.md:79-80` says operation receipts are removed
   only with whole-family reset. `mc_claim_mirror_receipts`
   (`lib.rs:1298-1309`) has no delete guard, no trigger, and no `session_id`
   column. The retention guarantee rests on no caller issuing a delete, which
   the schema does not enforce.

## Conventionally-enforced-only claims

Claims with no mechanical enforcement located in scope. Each is a real
obligation carried by convention, review, or an out-of-scope implementor.

- Ordinal monotonicity (C23). `CkItem::ordinal` documents "strictly increasing
  across the lineage" (`crates/mc-core/src/lib.rs:28-30`). `mc-core` never
  constructs an item, so nothing in scope can check it. No SQL constraint
  encodes it either: `mc_compartments` constrains uniqueness (S9) but not
  ordering, and the only ordering enforcement is the error text at
  `lib.rs:3565` on the compartment sequence, which is a different value.

- Generation and epoch monotonicity (S19). Every generation and epoch column is
  constrained non-negative and never monotonic. An epoch fence depends on
  counters not moving backwards, and that direction is unconstrained in the
  schema.

- Lifecycle transition legality (S7, S18). Roughly twenty-five enumeration
  checks pin closed alphabets; none constrains a transition. `dismissed` to
  `pending`, or `acknowledged` to `staged`, satisfies every declared
  constraint. Transition legality lives entirely in Rust match arms such as
  `lib.rs:11180-11190`.

- Referential integrity (S12). One `FOREIGN KEY` across 42 tables. Every other
  cross-table reference, including the `session_id` fan-out that
  `delete_session` discovers at runtime via `PRAGMA table_info`
  (`lib.rs:5453`), is conventional.

- Receipt count and range agreement (S14). `expected_effect_count` is
  unconstrained against `first_effect_id` and `last_effect_id`, so a receipt
  can contradict itself and still commit.

- Digest character-set validity for stored digests (S16). `content_digest` and
  `group_digest` are width-checked only. `request_digest` gets the stronger
  `is_lower_hex` treatment at `lib.rs:11175`; the other two do not.

- Receipt retention (C15) and the reset idempotency claim (C17), both by absence
  of an implementation in scope rather than by a guard.

- Append stability and O(H) render cost, two of the five decay invariants named
  at `crates/mc-core/src/decay.rs:10-13`, have no located check while the other
  three do (`:170`, `:181`, `:219-220`).

## Open questions

Grouped by what would resolve each one.

**Resolvable by a code audit outside this lens's scope.**

- Six tables constrain `length(database_incarnation_id) = 32` (S8) and only four
  app sites call `is_lower_hex(x, 32)` (`lib.rs:3820`, `4124`, `11310`,
  `claim_mirror.rs:253`). Which insert paths into `mc_claim_mirror_claims`
  (`lib.rs:1273`) and `mc_claim_mirror_receipts` (`lib.rs:1301`) reach SQL
  without a lowercase-hex check? Unresolved; needs a per-writer audit of
  `claim_mirror.rs`.

- Does any caller reach `delete_session` (`lib.rs:5432`) with a `session_id`
  that names a sentinel rather than a session? The repair completion flag is
  stored as a `mc_cache_state` row keyed
  `session_id = "note_artifact_repair_v51_done"` (`lib.rs:5107`), and
  `delete_session` deletes by `session_id` across every table carrying that
  column. This bears on C14's preservation claim.

- Which writer, if any, enforces the at-most-once note delivery invariant S10
  (`UNIQUE(note_id, session_id, delivered_pass_fingerprint)`,
  `lib.rs:752`) before reaching SQL? Not located.

**Resolvable by executing a query, which this lens did not do.**

- What is `PRAGMA synchronous` on a connection returned by `McStore::open`? The
  inference from the absence of any setter is the compile-time default, but the
  `libsqlite3-sys` build flags were not audited. This decides C2 and lead 1.

- Do the 58 `CHECK` lines in `MIGRATIONS` resolve to 58 distinct constraints, or
  fewer because of multi-line bodies such as `lib.rs:1231-1234`? The count
  reported above is of matching lines. A `SELECT sql FROM sqlite_schema` on a
  built store would settle the exact figure.

**Design decisions, needing human input.**

- Is the format identity in `docs/migration-version-lanes.md:9-17` intended to
  apply to `store.db` at all, or does the document describe `context.db` only?
  Leads 3 and 6 have opposite remedies depending on the answer: either the Rust
  store gains a marker, an `application_id`, and an inventory check, or the
  document is narrowed. (needs human input)

- Should schema compatibility be an equality fence or a floor? S6 pins
  `request_encoding_version = 1` by equality while
  `refuse_pre_cutover_store` implements a floor (lead 4). The two directions
  disagree about whether newer data is refused or admitted. (needs human input)

- Is the tokenizer's cross-machine determinism claim (C18) meant to survive this
  crate being consumed as a library, given it is `publish = false`
  (`crates/mc-tokenizer/Cargo.toml:5`) and the pin is `Cargo.lock`? If yes,
  `fancy-regex` needs an explicit `=` requirement. (needs human input)

- C21 scopes decay determinism to one binary while C18 claims determinism across
  machines. Both feed one rendering pipeline. Which strength is the pipeline's
  actual contract? (needs human input)
