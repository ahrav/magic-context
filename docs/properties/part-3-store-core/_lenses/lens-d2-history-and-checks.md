# Lens D2: bug history and existing checks

Scope: `crates/mc-store` (21,987 lines across `src/lib.rs`, `src/claim_mirror.rs`,
`src/sqlite_runtime.rs`, and three files under `tests/`), `crates/mc-core` (1,518),
`crates/mc-tokenizer` (85).

Every status below is **unaudited**. Adequacy verdicts belong to
`/testing:invariant-test-review` for tests and
`/low-level-systems:defensive-assertions-and-invariant-guards` for production
guards.

## Revision note

The task named HEAD `ed487e11`. The working tree is three commits ahead at
`dde0c051` on branch `feat/shared-memory-release-gate-audit`. I verified that
`git diff --stat ed487e11..dde0c051` touches only
`.github/workflows/shm-hardening-optin.yml`, and that file contains no reference
to any scope crate. Every scope file and every scope line reference in this
document is therefore identical at both commits. All line references below were
read at `dde0c051`.

One correction to a stated premise, in the repo's favour. The prompt said
production code ends at line 13,930 and lines 13,932 to 20,650 are three test
modules. Verified exactly: line 13,930 closes `capped_trace_error`, 13,931 is
blank, and the three modules are `tests` (13,932 to 19,420), `shadow_tests`
(19,421 to 19,980), and `lineage_descent_tests` (19,981 to 20,650).

## Defect records

Nine genuine defects. The repository writes long, precise commit bodies that
state root cause and trigger, so most root causes below are the author's own,
confirmed against the diff. Sampling is stated honestly at the end of this
section.

### D2-1. A consolidated bootstrap ran over a populated pre-cutover schema

- Commit `1e2d89ae` (2026-08-27), `fix(claims): classify the pre-cutover module
  store and fence current families`. Enabled by `b4af7e04` (2026-08-26),
  `feat(u8): complete the direct claims cutover`.
- Files: `crates/mc-store/src/lib.rs` (+141).
- Root cause: `b4af7e04` replaced an incremental chain with a single
  consolidated bootstrap. Verified by construction: `git show
  b4af7e04^:crates/mc-store/src/lib.rs` carries `version: 1` at line 468 through
  `version: 57` at line 2725; `git show b4af7e04:crates/mc-store/src/lib.rs`
  carries only `version: 57`. The `cortexkit-store` runner applies any bundled
  version above the highest recorded one, so on a store recorded at 55 it ran the
  whole `CREATE TABLE` bootstrap against a populated schema and died on its first
  statement with `table mc_cache_state already exists`.
- Timing and fault condition: no race. The trigger is a field state. Any released
  binary that left `store.db` at `mc_cache` version below 57 is bricked on the
  next open by a post-cutover binary. This is the unrecoverable-in-the-field case
  the task flags.
- Bypass analysis: **yes, a nearby condition still bypasses this.** The guard at
  `lib.rs:1375-1385` is asymmetric:

  ```
  Some(recorded) if recorded < OLDEST_ADOPTABLE_MIGRATION_VERSION => Err(...)
  _ => Ok(())
  ```

  `OLDEST_ADOPTABLE_MIGRATION_VERSION` is `LATEST_MIGRATION_VERSION`
  (`lib.rs:1342`), which is 57 (`lib.rs:432-433`, ceiling computed at
  `lib.rs:1321-1332`). A store recorded at 58 or above falls into `_ => Ok(())`,
  then `inner.migrate(NS, MIGRATIONS)` at `lib.rs:4874` is a no-op because 57 is
  not above 58. The older binary then operates on a newer schema it does not
  understand. A newer-schema refusal exists only on the TypeScript side, at
  `packages/plugin/src/features/magic-context/storage-db.ts:651`
  (`refuseNewerSchemaFence`, called at :689 and :777). I grepped
  `crates/mc-store/src/lib.rs` for `newer`, `NewerSchema`, and `downgrade`: the
  six hits are all unrelated epoch-fence prose. So a Rust-only opener has no
  downgrade guard.
- Regression property: opening a `store.db` whose recorded `mc_cache` version is
  not exactly the shipped ceiling fails closed with a typed family refusal naming
  both versions, in **both** directions.
- Tests added alongside: yes.
  `pre_cutover_module_store_is_refused_by_family_not_by_ddl_collision`
  (`lib.rs:16088`) and
  `fresh_and_current_module_stores_open_without_a_pre_cutover_refusal`
  (`lib.rs:16139`). The refusal test loops `for version in
  1..OLDEST_ADOPTABLE_MIGRATION_VERSION` (`lib.rs:16116`), so the highest
  recorded version it ever constructs is 56. **It does not cover the above-ceiling
  direction at all.**

### D2-2. A dead identity comparison made the staging authority fence unfireable

- Commit `e8b7640c` (2026-08-26), `fix(claims): resolve the staged-intent
  authority fence from the bound route`.
- Files: `crates/mc-store/src/lib.rs`.
- Root cause: the fence looked up `mc_authority` with `context_store_uuid =
  binding.database_incarnation_id`. Those are disjoint identifier spaces: the
  host mints the context store UUID as a 36-character dashed `randomUUID()`, and
  the format marker's incarnation is 32 lowercase hex. The row was always absent,
  and because the check was `if let Some(..)` rather than `let Some(..) else`, it
  fell through to the insert.
- Timing and fault condition: none required. The fence never fired on any input.
  An intent was accepted with any caller-supplied `authorityProject` and
  `authorityGeneration`, regardless of the durable authority row. Four claim
  handlers also took no `RouteHandle`, so project scope came entirely from the
  request body.
- Bypass analysis: **yes, and the commit says so itself.** Its body records "Not
  fixed here: `set_claim_intent_transition_tx` still silently returns `Ok(())`
  when handed a non-32-hex identifier." I confirmed that survives at HEAD:
  `lib.rs:4118-4125` opens with `if !is_lower_hex(database_incarnation_id, 32) {
  return Ok(()); }`, and all **four** callers (`lib.rs:11434`, `11640`, `11738`,
  `11790`; the commit said three) pass `context_store_uuid`, the 36-character
  dashed value, into that parameter. If the host's UUID shape is as the commit
  describes, every one of those four calls is a silent no-op, so the
  `resetting` / `accepting` / `draining` transition states are never recorded in
  `mc_claim_intent_controls`. The same defect class as the one just fixed, in the
  adjacent function, acknowledged and left open.
- Regression property: authority identity is always derived server-side from the
  daemon-bound route, never from the request; and a transition write handed an
  identifier of the wrong shape fails loud rather than returning `Ok(())`.
- Tests added alongside: yes, and the commit records why the old ones were
  vacuous. "Fixtures reused one constant for both identifiers, which is what hid
  this." They now use a dashed store UUID distinct from the incarnation. The
  freeze assertions were also strengthened to read the authority state rather
  than the transition-control row.

### D2-3. A staged-intent replay skipped every fresh-insert check

- Commit `482348b0` (2026-08-27), `fix(claims): revalidate live authority before
  replaying a staged intent`.
- Files: `crates/mc-store/src/lib.rs` (+104/-36),
  `crates/mc-store/tests/claim_intent_ledger.rs` (+66).
- Root cause: `stage_claim_intent` returned an existing record after checking
  only the request digest and the stored binding, skipping the transition-control
  state, the route-resolved authority row, the `MODULE` state requirement, and
  the project and generation comparison. A replay is not a read:
  `commitModuleClaimIntent` proceeds to `commitContext` on a `staged` record, so
  the mutation runs again.
- Timing and fault condition: a crash window plus a concurrent drain. Stated in
  the commit as an exact sequence. An attempt stages at generation G and crashes
  before committing; a drain commits `DRAINING` at G+1 via
  `authority_begin_drain`; the retry presents the same identity, digest, and
  binding, takes the early return, and commits a claim under the obsolete
  generation while the authority is already draining.
- Bypass analysis: a deliberate, documented carve-out rather than an oversight.
  Only `staged` records are fenced. `context-committed`, `acknowledged`, and
  `terminal-rejected` replays stay idempotent so a crashed attempt can still be
  resolved, which
  `stale_zero_effect_result_can_settle_after_authority_drain_starts`
  (`tests/claim_intent_ledger.rs:168`) depends on. The residual question is
  whether any of those three states can also re-drive a mutation; the commit
  asserts they cannot but does not show it. Recorded as an open question.
- Regression property: a staged-intent replay revalidates the live authority row
  and refuses once the authority has begun draining.
- Tests added alongside: yes.
  `replaying_a_staged_intent_refuses_after_authority_begins_draining`
  (`tests/claim_intent_ledger.rs:345`), which the commit says fails without the
  fence. Extracting the helper also repaired
  `tests::module_authority_facade_write_uses_identity_not_route_path`, which was
  already failing on the branch.

### D2-4. An ordinary receipt wedged the next restart seed

- Commit `088534d5` (2026-08-27), `fix(claims): close reachable claim-lane and
  claim-mirror defects from review`. Fourteen findings; the ones inside scope are
  D2-4 and D2-5.
- Files: `crates/mc-store/src/claim_mirror.rs` (+38/-?),
  `crates/mc-store/src/lib.rs` (-12), `crates/mc-core/src/claim_operation.rs`
  (+7), `crates/mc-store/tests/claim_mirror.rs` (+108).
- Root cause: `apply_claim_mirror_receipt` advanced project state to the
  receipt's generation but only restamped the rows an effect named. The host
  stamps every claim in a full snapshot from the current vector, and replacement
  compares whole rows, so one untouched row left on the previous generation made
  a restarting host's seed differ from durable state.
- Timing and fault condition: no fault needed, which is what makes it severe. The
  commit is explicit: "with a stable workspace and a single ordinary receipt." A
  restart then returns `ResetRequired` and suppresses the claim lane.
- Bypass analysis: no nearby bypass found. The fix restamps every retained row in
  a touched project, which is the same set the host stamps, so the two sides now
  derive the generation identically. The residual risk is a third writer that
  stamps on a different rule, and `claim_mirror.rs` has no in-crate test module to
  pin that (see quiet areas).
- Regression property: after any accepted receipt, a restart seed computed from
  the current vector equals durable state, so no ordinary receipt can produce
  `ResetRequired`.
- Tests added alongside: yes.
  `receipt_advances_generation_stamps_on_untouched_rows_so_restart_seed_matches`
  (`tests/claim_mirror.rs:527`) and
  `receipt_rejects_equal_revision_carrying_different_content`
  (`tests/claim_mirror.rs:591`).

### D2-5. One malformed mirror row blanked all claim memory

- Commit `088534d5`, same commit as D2-4.
- Files: `crates/mc-store/src/claim_mirror.rs`.
- Root cause: `MirroredClaimMemory::try_from` errors on a non-active or
  attribute-incomplete row, and both readers collected into `Result<Vec<_>, _>`,
  so the first such row turned the entire multi-project result into `None`.
- Timing and fault condition: any single row the store legitimately accepts but
  the reader rejects. The commit names the asymmetry precisely: `read_claims`
  applies no lifecycle filter and the store accepts `archived` and `retired`, so
  the store's contract is strictly wider than its readers could tolerate.
- Bypass analysis: no nearby bypass found for the collect pattern itself, which is
  now a per-row skip. The underlying contract asymmetry is unresolved: the store
  still accepts lifecycle values the reader will skip, so the failure mode moved
  from total blanking to silent partial results with no counter. Recorded as an
  open question.
- Regression property: an unreadable mirror row is skipped individually and
  counted; it never suppresses a sibling project's claims.
- Tests added alongside: covered by the `+108` block in
  `tests/claim_mirror.rs`; I did not isolate which of the nine test functions
  there is the dedicated one.

### D2-6. A hot-journal pre-open gate refused the bootstrap's own in-flight journal

- Commit `80585c48` (2026-08-27), `fix(claims): unwedge pristine bootstrap and
  close direct-cutover review findings`.
- Files: `crates/mc-store/src/lib.rs` (-143, almost all orphan deletion; the
  behavioural fix is in `packages/cli/src/lib/database-access.ts` and the
  storage-format-epoch module).
- Root cause: the pre-open gate treated any rollback journal beside an existing
  main file as terminal. SQLite writes a transaction's pages to the main file only
  at commit, so a bootstrap holding `BEGIN IMMEDIATE` leaves exactly `main: 0
  bytes` plus `-journal` for the whole composition.
- Timing and fault condition: two windows. First, a concurrency window: a second
  process cold-opening the same family during the winner's bootstrap refused the
  winner's own journal and never reached the `busy_timeout` wait, so pristine
  bootstrap was not actually serialized. Second, a crash window: a bootstrap
  interrupted mid-transaction stayed refused forever, even though rollback
  restores the family to pristine.
- Bypass analysis: the fix makes a journal terminal only beside a **nonempty**
  main file, and moves the rules into one `classifyPreOpenFamily` so pre-open and
  post-open verdicts cannot drift. The nearby condition worth naming is a
  partially written main file: a crash after the first page reaches `main` but
  before commit leaves a nonempty main plus a journal, which is still classified
  terminal. Whether that is correct depends on whether rollback can restore it,
  which I did not establish. Recorded as an open question. Also note this fix
  lives outside the three scope crates, so nothing in scope tests it.
- Regression property: a rollback journal beside a zero-length main file is a
  live bootstrap, not a terminal artifact, and a second opener waits on
  `busy_timeout` rather than refusing.
- Tests added alongside: in `packages/e2e-tests` and
  `packages/plugin/.../storage-db.test.ts`, not in scope.

### D2-7. A repair statement wrote a dropped column, and its fixture hid it

- Commit `80585c48`, same commit as D2-6.
- Root cause: `invalidate_all_memory_block_caches` updated
  `cached_m0_max_memory_mutation_id`, a column the cutover had dropped.
- Timing and fault condition: every invocation. The statement could only ever
  fail or no-op.
- Bypass analysis: the commit's own words are the finding: it had to "rebuild its
  fixture on the shipped column so the test stops passing vacuously." A test
  existed, executed, and asserted, and proved nothing, because the fixture
  created the dropped column. That is the bypass class that matters most here, and
  it is not specific to this one function: the migration DDL is one 881-line raw
  string literal spanning `lib.rs:432-1312`, and any test that builds its own
  fixture schema rather than opening a real store can drift from it the same way.
- Regression property: every production statement names a column present in the
  shipped bootstrap, and fixtures are composed by opening a real store rather
  than by hand-written DDL.
- Tests added alongside: the fixture was rebuilt, not added.

### D2-8. A no_work reply lost its cause on replay and ended the drain early

- Commit `095e4e5c` (2026-08-22), `fix(mc-store): persist the cycle-exhausted
  cause for no_work replay`.
- Files: `crates/mc-store/src/lib.rs` (+149/-43).
- Root cause: a fresh `no_work` carrying `cycle_exhausted` told the client to
  poll again, but the acquisition ledger recorded only a generic `no_work`.
- Timing and fault condition: a lost response. A client that lost the original
  reply replayed the acquisition, got a plain `no_work`, mistook the reset cursor
  for a drained queue, and ended the drain while eligible work remained. This is
  an effect-accounting failure under loss, so the acknowledged and attempted
  counts diverge exactly as METHOD.md's loss section describes.
- Bypass analysis: no nearby bypass found. The ledger now stores
  `no_work_exhausted` versus `no_work` and replays reproduce the recorded cause.
  The commit argues repeated `cycle_exhausted` answers are safe because a drain
  consumes at most one before claiming, which is an argument, not a proof; it is
  the kind of claim a `sometimes` check should pin.
- Regression property: a replayed acquisition reproduces the recorded no-work
  cause byte for byte, so a lost response cannot convert "poll again" into
  "queue drained".
- Tests added alongside: yes.
  `note_eval_no_work_decision_replays_after_work_appears` (`lib.rs:18577`) and
  `note_eval_exhausted_no_work_decision_survives_replay` (`lib.rs:18624`).

### D2-9. Retention pruning deleted a whole tied-timestamp group below the cap

- Commit `cb01310e` (2026-08-23), `fix(sqlite): exact retention eviction and
  statement-cache hygiene`. Review findings from PR #25.
- Files: `crates/mc-store/src/lib.rs` (+9/-3).
- Root cause: `transform_decisions` retention pruned by deleting every row at the
  minimum `ts_ms`.
- Timing and fault condition: tied timestamps. Two or more decisions recorded in
  the same millisecond at the retention boundary drop the whole group, taking the
  table below its cap. A millisecond clock plus batched writes makes ties routine
  rather than exotic.
- Bypass analysis: no nearby bypass found for this table. The fix deletes exactly
  the overage in `(ts_ms, rowid)` order, which is a total order. The pattern is
  worth auditing across the other capped tables, and the pass-scheduler history
  caps at `lib.rs:411-412` are the obvious neighbours; I did not audit them.
- Regression property: a retention prune removes exactly the overage and leaves
  the table at its cap, for any timestamp multiplicity.
- Tests added alongside: yes, the commit states it covers the tie case with a
  regression test. I did not isolate its name.

### Sampling statement

208 commits touch `crates/mc-store`, 22 touch `crates/mc-core`, 1 touches
`crates/mc-tokenizer`. I read the full body and the scope diff for 18 commits,
chosen as follows, and I did not read the remaining 190 in full.

- All 10 commits returned by `git log -S'MIGRATIONS' -- crates/mc-store/src/lib.rs`,
  because the task flags migration as the unrecoverable class.
- All 8 commits on the active claims-cutover branch tip
  (`6e9b969c`, `1e2d89ae`, `80585c48`, `482348b0`, `088534d5`, `e8b7640c`,
  `8ef978a6`, `84e4a072`), because that is where the schema currently moved.
- The durability, race, and retention commits whose subjects name a mechanism
  rather than a round number: `575debe3`, `095e4e5c`, `cb01310e`, `a2edd134`,
  `39608bda`, `412b70f1`, `abe5bc22`.

The long `mason:` tail (roughly 90 commits) is bulk-generated and I sampled it
only by subject, not by diff. It is the largest unexamined region of this lens
and I do not claim the nine defects above are exhaustive.

### Two historical defects worth naming without full records

- `abe5bc22` (2026-07-23), `fix leftover conflict marker inside migration 43 SQL
  literal`. The diff is one deleted line, and that line is a literal
  `>>>>>>> alfonso/task/bg_d41511b6-r12-perf-p0-session-tag-baseline-cache` git
  conflict marker sitting **inside** migration 43's raw SQL string. Any store
  that had to run migration 43 would have failed to parse it. The enabling
  condition is structural and still present: migration DDL is an unvalidated
  `r#"..."#` literal (now `lib.rs:432-1312`) that nothing checks at compile time.
  What retires the risk today is that three tests open a real fresh store
  (`lib.rs:16068`, `16139`, and every `McStore::open` in the suite), so a syntax
  error in the shipped bootstrap now fails loudly on the fresh-open path. The
  gap that remains is any DDL reachable only on a non-fresh path.
- `412b70f1` (2026-08-06), `fix(mc-store): adopt stale sync generations (#8342)`.
  Fixed a "rust-mode state_sync wedge" by adopting natural-key memory rows before
  source-identity upserts, and added migration 44 plus advanced the
  migration-ceiling assertions. Migration 44 no longer exists; `b4af7e04`
  consolidated it away. The runtime adoption logic presumably survives, but the
  schema step that the fix depended on is now only implicit in the v57 bootstrap,
  and I did not verify that the consolidated DDL preserves it. Recorded as an
  open question.

### Referenced ids that no longer resolve

`bd` is available (version 1.2.2). Four ids appear in scope commit messages and
**none of them resolves**:

| Id | Referenced by | `bd show` result |
| --- | --- | --- |
| `#8342` | `412b70f1` subject | `no issue found matching "8342"` |
| `#1234` | body of a `ctx_search` commit | `no issue found matching "1234"` |
| `#409` | body of an `mc_compartments` commit | `no issue found matching "409"` |
| `86e3ae26c2ea5a1b` | `78472c83` subject | `no issue found matching ...` |

Caveat, and it matters: `#1234` and `7234` appear together in prose about
id-shaped `ctx_search` queries, so that one is almost certainly an example string
rather than a tracker reference, and `#409` sits next to "note #409" in a
sentence about HTTP-shaped ids, so it is likely the same. `#8342` and
`86e3ae26c2ea5a1b` read as genuine references to work items that are gone. Also
note that PR numbers in these bodies (`PR #38`, `PR #25`, `PR #12`) are GitHub
PRs, not beads, and are not counted here. This is a weaker instance of the
"commit references a bead that no longer exists" pattern than the two prior
occurrences, and I am not claiming it is the same failure.

### Beads that do mention the scope crates

`bd list` returns four relevant entries, all open unless noted:

- `magic-context-d5l` (P2, open): "mc-store: extract notes + schema modules from
  lib.rs (20,650 LOC); record remaining seams on 3q5.28". Confirms the monolith
  is a tracked known issue and independently corroborates the 20,650 figure.
- `magic-context-8vi` (P2, open): "Decide mc-core cache-core feature: collapse or
  keep with CI check". Names `ci.yml`'s `cargo check -p mc-core
  --no-default-features` as a stopgap and cites `mc-core/Cargo.toml:12-14` and
  `mc-core/src/lib.rs:14`.
- `magic-context-3q5.28` (P3, open): "mc-store writer actor for retrieval stores".
- `magic-context-78o.5` (P1, **closed**): "U5: Migration, recovery,
  hostile-input containment tests + PARITY docs". Closed 2026-08-19 with "U5
  complete: fixtures, PARITY docs, gates run". Its migration tests predate the
  `b4af7e04` cutover by a week, so a closed migration-test bead does not cover
  the current single-bootstrap scheme.

### `docs/AUDIT-KNOWN-ISSUES.md`

**No entry in this document concerns the three Rust scope crates.** I grepped it
for `mc-store`, `mc-core`, `mc-tokenizer`, `crates/`, and `migration`. The
migration-related hits (lines 32, 236-239, 298-313, 586, 626, 761, 802, 819) all
describe the TypeScript plugin's `storage-db` migrations (v14, v22, v31, v44) and
its `initializeDatabase` / `runMigrations` path, which `b4af7e04` deleted. Line
236-239 is worth carrying forward by analogy rather than as scope evidence: it
records a "Coverage note (missing co-located migration tests)" for migrations v14
onward, saying the schema "is exercised" only indirectly. That is the same shape
as the gap in D2-1's test coverage.

## Review-hardening churn

Distinguished from the defects above because none of these had a reachable wrong
behaviour.

- `6e9b969c` (2026-08-29) touches only two lines of scope, both comment
  retargeting in `sqlite_runtime.rs` and its test. Its substance (adding the
  `check-rust` CI job) is workflow work. Not a defect.
- `80585c48`'s deletion half: dead schema-helper DDL builders, `healAllNullColumns`,
  an unreachable `OutdatedSchemaVersionError` branch, orphaned claim-policy,
  registry, applicability, and embedding helpers, `RunIdArgs`, and seven dead
  `mc-store` methods. Confirmed in the diff as pure removal.
- The same commit removed **three test seams** stranded by that deletion:
  `facade_mutation_abandon_hook`, `authority_project_resolution_fail_once`, and
  `authority_seed_resolution_pass_count`, plus the `with_facade_mutation` wrapper.
  Worth flagging for a different reason: those seams existed to inject a crash at
  a commit window and to force an authority-resolution failure. Their removal
  reduces the fault-injection surface available to future crash-window tests, so
  it is churn with a cost.
- `a2edd134` (2026-08-23): the scope change is 4 lines, swapping `prepare_cached`
  for `prepare` on per-table `PRAGMA table_info` SQL, because each table name
  makes a one-shot cache entry. Cache hygiene, not correctness. The real defect in
  that commit (a leaked telemetry handle when the `busy_timeout` PRAGMA threw) is
  TypeScript.
- `cb01310e`'s second half: three `prepare_cached` to `prepare` swaps for
  variable-arity IN-list SQL churning the 128-slot LRU. Hygiene.
- `575debe3` (2026-08-24): the described ledger read race is real, but its
  **scope** diff is +11 lines adding a `producer_harness: Option<String>` field
  with `#[serde(default)]` and a `Default` arm. The guard reorder and the harness
  scoping live outside `crates/mc-store`. Inside scope this is additive plumbing.
  I record it here rather than as a defect because no scope line was wrong before
  it.
- `39608bda` (2026-08-25), `fix(u5): prevent divergent claim replay after
  crashes`: its only scope change is 27 lines in
  `tests/claim_intent_ledger.rs`. The production fix is in `crates/mc-module` and
  `packages/plugin`. A genuine defect, but not one located in this scope.
- The `mason:` tail is, on subject inspection, dominated by this category. I did
  not verify that claim by diff.

## Existing-check inventory

### In-crate tests (clustered, counts and line ranges)

**`crates/mc-store/src/lib.rs`: 101 tests in three modules.** Verified by counting
`#[test]` and `#[tokio::test]` attributes from line 13,932 onward; the total
matches `grep -c '#\[test\]'` over the same range. No `#[ignore]` and no
`should_panic` anywhere in the three modules.

`mod tests` (13,932 to 19,420), 87 tests, clustered by claim:

| Cluster | Lines | Count |
| --- | --- | --- |
| Bootstrap, session-owned deletion, row-version CAS, transform-root lineage | 14,029-14,405 | 7 |
| Transform snapshot and overlay-table atomicity under a concurrent commit | 14,424-14,638 | 4 |
| Command-id ledger, first-application marker, rollback, 512-command retention | 14,670-14,946 | 7 |
| Tag minting monotonicity, overlay ordinal watermark, wrapup ledger, todo replay | 15,012-15,359 | 4 |
| Wrapup fencing by row-version and revert-epoch, pass-trace caps | 15,407-15,500 | 3 |
| Pass-scheduler interest history: selection, ordering, byte bounds, mural upsert | 15,583-16,008 | 7 |
| **Schema version probe, pre-cutover refusal, fresh-and-current open, open lease** | **16,068-16,159** | **4** |
| State import: atomic bootstrap-only, per-kind preflight, rejection leaves no rows | 16,188-16,319 | 3 |
| Compartments roundtrip, tail append, overlap refusal, memory ordering | 16,339-16,540 | 5 |
| Historian publish, abandon fencing, side-channel isolation, transcript bounds | 16,624-17,096 | 9 |
| Note search scoping, CRUD, at-least-once delivery, ack scoping, paging | 17,202-17,680 | 7 |
| Note revisions, evaluation-state reset, **migration v51 backfill** | 17,755-18,071 | 5 |
| Artifact repair, `mc_notes` writer fence, revert truncation, recut epoch | 18,123-18,335 | 6 |
| Note-eval claim lifecycle: acquire, replay, renewal, expiry, caps, redaction, drain | 18,490-19,383 | 16 |

`mod shadow_tests` (19,421 to 19,980), 7 tests: state-sync section
absent-versus-empty-versus-legacy (19,521); one-fenced-transaction idempotent
authority note seed (19,587); authority state machine persists generations and
drain journal (19,635); drain-begin resumes each crash journal position (19,702);
drain resume rejects a different live lease (19,789); stale coordinator token
rejected after takeover (19,819); sequence fence rejects an interleaved stale
sender (19,885).

`mod lineage_descent_tests` (19,981 to 20,650), 7 tests: zero-based fresh anchor
accepted (20,054); mid-space anchor refused (20,089); verbatim range and note copy
without replay duplicates (20,123); newest completed constituent wins (20,267);
terminal branches durable before ack (20,376); CAS loser leaves target and prior
fence untouched (20,551); invalid source ranges abort without partial target
(20,610).

**`crates/mc-store/src/claim_mirror.rs` (1,152 lines): none found.** No `#[test]`
and no `#[cfg(test)]` anywhere in the file.

**`crates/mc-store/src/sqlite_runtime.rs` (185 lines): none found.** Same.

**`crates/mc-core`: 31 in-crate, 0 integration.** There is no
`crates/mc-core/tests/` directory (verified: `ls` returns "No such file or
directory"). The 31 split as the task stated:

- `src/lib.rs` (338 lines), `#[cfg(test)]` at :162, **14 tests** at :176-:325.
  Pass-classifier decision table: hard bootstrap, legacy baseline migration, m1
  rebuild, unknown-shape rejection, epoch change, reconcile boundary present and
  absent, soft-delta gating, coalescing, defer rules.
- `src/claim_operation.rs` (878 lines), `#[cfg(test)]` at :672, **9 tests** at
  :684-:847. All fixture-comparison: vocabulary, canonical bytes and request
  digests, non-canonical number rejection, public claim-id validation, revision
  locators, mutation tokens, applicability and policy-head digests, snapshot
  vectors, byte-identical stored-result re-encode.
- `src/decay.rs` (302 lines), `#[cfg(test)]` at :147, **8 tests** at :154-:246.
  Tier assignment, age-monotonic demotion, importance protection, pressure
  acceleration, finite demotion at max importance, render cap, pressure
  self-tuning, and a golden comparison against the reference curve.

**`crates/mc-tokenizer/src/lib.rs` (85 lines): none found in-crate.** All four of
its tests are integration.

### Integration tests (per test fn: name, claim, CI status)

**CI status, verified against all five files in `.github/workflows/`: every scope
test binary is UNNAMED, and no CI job runs any scope test at all.**

I grepped `mc-store`, `mc-core`, and `mc-tokenizer` across
`.github/workflows/{ci,claude-code-review,historian-eval,retrieval-benchmark,shm-hardening-optin}.yml`.
There are exactly five hits, all in `ci.yml`, and all in one job:

| Workflow line | Content |
| --- | --- |
| `ci.yml:456` | `name: Check (Rust fmt + mc-core features)` |
| `ci.yml:479` | comment: "Every workspace member takes mc-core with default features, so a plain" |
| `ci.yml:482` | comment: "mc-core does not depend on the stubbed cortexkit crates." |
| `ci.yml:483` | `- name: mc-core feature-off build` |
| `ci.yml:484` | `run: cargo check -p mc-core --no-default-features` |

`cargo check` compiles; it runs nothing and it does not build test targets. The
only other Rust test invocations in `ci.yml` are `ci.yml:131`
(`cargo nextest run -p mc-host --test client`), `ci.yml:168`
(`cargo test -p mc-module --test lifecycle_cli`), `ci.yml:172-175`
(`-p mc-shm-native -p mc-shm-transport`, and `-p mc-host`), `ci.yml:180-183`
(macOS equivalents), and `ci.yml:186` (`cargo test -p mc-host --doc`). There is no
`--workspace` test run and no `--all-targets` test run anywhere. So:

- All 101 in-crate `mc-store` tests: **not executed in CI.**
- All 31 in-crate `mc-core` tests: **not executed in CI.**
- All 3 integration binaries in `crates/mc-store/tests/`: **unnamed, not executed.**
- `crates/mc-tokenizer/tests/token_golden.rs`: **unnamed, not executed.**

This is a stronger version of the part 2a finding, not the same one. In part 2a
`mc-host`'s in-crate tests were at least gated through `--lib`. Here nothing in
scope runs. Note also that part 2a's cited workflow lines (`ci.yml:122`, `:167`,
`:178`, `:179`, `:183`) have all shifted at HEAD; that inventory needs a
refresh, which is outside this lens.

**`crates/mc-store/tests/claim_mirror.rs`, 625 lines, 9 tests. Unnamed in CI.**

| Line | Test | Claim |
| --- | --- | --- |
| 142 | `u10_scenario_1_full_snapshot_roundtrips_committed_claim_vocabulary` | A full snapshot roundtrips the committed claim vocabulary unchanged. |
| 176 | `u10_scenario_2_complete_receipt_group_is_atomic_and_replay_safe` | A complete receipt group applies atomically and a replay is a no-op. |
| 251 | `u10_scenario_3_versions_incarnation_generations_and_project_predecessors_are_strict` | Version, incarnation, generation, and project-predecessor comparisons are strict. |
| 342 | `u10_scenario_4_policy_only_revocation_removes_committed_row` | A policy-only revocation removes the committed row. |
| 376 | `u10_scenario_7_delete_and_reseed_require_drained_u5_intents` | Delete and reseed are refused until U5 intents have drained. |
| 460 | `u10_scenario_7_equivalent_restart_seed_is_idempotent` | An equivalent restart seed is idempotent. |
| 481 | `u10_scenario_8_reseed_reproduces_state_across_restart` | A reseed reproduces durable state across a restart. |
| 527 | `receipt_advances_generation_stamps_on_untouched_rows_so_restart_seed_matches` | Regression for D2-4: a receipt restamps untouched rows so the restart seed matches. |
| 591 | `receipt_rejects_equal_revision_carrying_different_content` | An equal revision carrying different content is rejected. |

**`crates/mc-store/tests/claim_intent_ledger.rs`, 401 lines, 6 tests. Unnamed in CI.**

| Line | Test | Claim |
| --- | --- | --- |
| 85 | `acknowledged_intent_survives_more_than_512_later_commands` | An acknowledged intent survives past the 512-command ledger window. |
| 132 | `staged_intent_reopens_and_rejects_binding_or_digest_reuse` | A staged intent reopens but refuses a reused binding or digest. |
| 168 | `stale_zero_effect_result_can_settle_after_authority_drain_starts` | A stale zero-effect result can still settle after a drain begins. |
| 230 | `staging_fails_closed_without_route_resolved_module_authority` | Staging fails closed when the route resolves to no MODULE authority. Regression for D2-2. |
| 288 | `store_rebuild_is_refused_until_intents_drain_then_freezes_new_stages` | Rebuild is refused until intents drain, then new stages are frozen. |
| 345 | `replaying_a_staged_intent_refuses_after_authority_begins_draining` | Regression for D2-3: a staged replay refuses once the authority is draining. |

**`crates/mc-store/tests/sqlite_runtime.rs`, 231 lines, 3 tests. Unnamed in CI.**

| Line | Test | Claim |
| --- | --- | --- |
| 45 | `sqlite_runtime_source` | Application id, format epoch, marker and manifest digests match the cross-runtime fixture. |
| 172 | `sqlite_runtime_source_connection_contract` | `verify_sqlite_connection_contract` reports foreign keys, WAL mode, and busy timeout violations. |
| 204 | `sqlite_runtime_source_id_gate_fails_closed_on_non_ascii_stamps` | The source-id gate fails closed on a non-ASCII version stamp. |

**`crates/mc-tokenizer/tests/token_golden.rs`, 73 lines, 4 tests. Unnamed in CI.**

| Line | Test | Claim |
| --- | --- | --- |
| 26 | `encode_ordinary_matches_ai_tokenizer_ids` | Ordinary encoding produces the same ids as `ai-tokenizer`. |
| 47 | `estimate_tokens_matches_golden_counts` | `estimate_tokens` matches the golden counts. |
| 59 | `empty_text_is_zero` | Empty input estimates zero tokens. |
| 64 | `deterministic_across_calls` | Repeated calls return identical counts. |

### Production assertions and guards (clustered)

**Live Rust assertions in `crates/mc-store` production code (lines 1 to 13,930 of
`lib.rs`, plus both submodules): effectively zero.** For a 13.9k-line file this is
the headline. Verified counts over that range: 2 `debug_assert!`, 1 `assert!`, 0
`assert_eq!`, 0 `panic!`, 2 `unreachable!`, 0 `todo!`, 0 `unimplemented!`, 5
`.expect(`, 0 `.unwrap()`.

- **`unreachable!`, 2.** `lib.rs:3919` ("claim mutation transaction cannot return
  a rebuild outcome") and `lib.rs:11346` ("rebuild transaction returns only
  granted or blocked"). Both discharge a match over `ClaimIntentTxnOutcome`. Both
  are genuine forbidden-code-point guards and both abort in release.
- **`debug_assert!`, 2, and both are dead.** `lib.rs:6878` and `lib.rs:6988` are
  each `debug_assert!(valid_disposition)` placed **after** an
  `if !valid_disposition { return Err(...) }` on the preceding lines. The early
  return already establishes the condition, so neither can fire even in a debug
  build. They are restatements, not checks.
- **`assert!`, 1, and it is not production.** `lib.rs:5250` asserts a known
  historian side-channel kind, but it sits inside
  `fail_next_historian_side_channel_for_test`, gated
  `#[cfg(any(test, feature = "test-support"))]`. Reachability class: test-only.
- **`.expect(`, 5.** Three are test-support hook mutexes (`lib.rs:5287`, `:5298`,
  `:9250`). Two are live production invariant claims:
  `lib.rs:8545` `request.anchor.expect("eligible descent has an anchor")` and
  `lib.rs:12104` `row.snapshot.as_object().expect("validated note seed object")`.
  Both encode a precondition established elsewhere and both panic if it fails.
- **`unwrap_or_else(|poisoned| poisoned.into_inner())`, 15 occurrences.** A
  uniform policy of continuing through a poisoned mutex rather than propagating.
  Consistent, and worth a record: it converts a panic that already happened
  inside a critical section into silent use of possibly-inconsistent state.
- **SQL `CHECK` constraints, 56 in production, 49 of them inside the `MIGRATIONS`
  DDL at `lib.rs:432-1312`.** This is where the store's invariants actually live:
  32-character incarnation ids, positive receipt and effect ids,
  `last_effect_id >= first_effect_id`, 64-character digests,
  `json_valid(generation_vector_json)`. They are enforced by SQLite at write
  time, not by Rust, so they surface as `rusqlite` errors rather than typed
  refusals.
- **Typed fail-closed refusals, roughly 20 `McStoreError` variants** including
  `PreCutoverModuleStore`, `CasConflict`, `AuthorityStateMismatch`,
  `AuthorityGenerationMismatch`, `AuthorityFeedHeadAdvanced`, `NoteCasConflict`,
  `NoteOwnershipMismatch`, `CompartmentRangeOverlap`,
  `FacadeProjectVocabularyMismatch`, and six `ClaimIntent*` variants. Together
  with the four `validate_*` functions (`lib.rs:3816`, `:3924`, `:4013`, `:4199`)
  these are the real guard layer.
- **`crates/mc-core`: one production `.expect`,** `claim_operation.rs:73`
  (`"constant fits in u64"`). Everything else counted by a naive grep sits inside
  the three `#[cfg(test)]` modules. `decay.rs` and `lib.rs` have **no** production
  assertions.
- **`crates/mc-tokenizer`: 5 `.expect(` at `src/lib.rs:55, 56, 59, 60, 66`,** all
  on the vendored `assets/claude.tiktoken` parse and `CoreBPE` construction. They
  panic at load time on a malformed vendored asset. Reachability class:
  default-production, but only reachable through a corrupted build artifact.

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any executed check
proves.

### 1. The WAL-reset gate and the connection contract are never called in production

`crates/mc-store/src/sqlite_runtime.rs` exports six public functions
(`:34`, `:45`, `:92`, `:113`, `:156`, `:170`), including
`evaluate_sqlite_runtime_gate` (`:92`), which enforces
`SQLITE_WAL_RESET_SAFE_MIN_VERSION = [3, 47, 1]` (`:25`) against the SQLite
WAL-reset bug, and `verify_sqlite_connection_contract` (`:113`), which checks
foreign keys, `journal_mode = wal`, and the busy timeout.

I grepped the whole workspace for callers of all six symbols. **The only Rust
caller of any of them is `crates/mc-store/tests/sqlite_runtime.rs`.**
`crates/mc-store/src/lib.rs` contains no reference to `sqlite_runtime::` beyond
the `pub mod sqlite_runtime;` declaration at `lib.rs:17`.

So `McStore::open` never evaluates the WAL-reset gate. Its entire pre-flight is
`refuse_pre_cutover_store(&inner)?` at `lib.rs:4873` and
`inner.migrate(NS, MIGRATIONS)?` at `lib.rs:4874`. A Rust process can open
`store.db` on a SQLite older than 3.47.1 with no journal-mode check. The gate is
real, tested, and enforced only by the TypeScript host. That makes the module's
reachability class, as consumed from Rust, effectively test-only, while its
doc comment at `sqlite_runtime.rs:1-6` presents it as the contract for
"`store.db` writers". Contract and code disagree; I am reporting both sides, not
resolving it.

### 2. The migration path is guarded in one direction and tested in one direction

Three facts compound:

- `refuse_pre_cutover_store` (`lib.rs:1375-1385`) refuses `recorded < 57` and
  lets everything else through, so `recorded > 57` reaches
  `inner.migrate` as a no-op. See D2-1's bypass analysis.
- The only test of the refusal (`lib.rs:16088`) constructs recorded versions
  `1..57`, so its maximum is 56. Nothing constructs 58.
- The 881-line consolidated DDL (`lib.rs:432-1312`) is validated only by being
  executed on a fresh open. There is no test that asserts the bootstrap composes
  a schema matching a recorded manifest, even though
  `compute_schema_manifest_digest` (`sqlite_runtime.rs:156`) exists precisely to
  express that and is called from no production path.

Given that a schema-version mismatch is unrecoverable in the field, the
above-ceiling direction being both unguarded and untested is the single highest
leverage gap this lens found.

### 3. `claim_mirror.rs` decides the restart-seed contract with no in-crate check

1,152 lines, zero `#[test]`, zero `#[cfg(test)]`. It hosts
`apply_claim_mirror_receipt`, whose generation-stamping rule must agree exactly
with the host's full-snapshot stamping or a restart returns `ResetRequired` and
suppresses the claim lane. That is D2-4, and it fired with no fault at all, on a
stable workspace, from one ordinary receipt. Its regression test lives in
`tests/claim_mirror.rs`, which no CI job runs. The comparison is against a host
implemented in TypeScript, so the agreement is cross-language and there is no
shared fixture proving it the way `mc-core/src/claim_operation.rs` proves its
vocabulary against `testdata`.

### 4. The post-migration repair helpers

`repair_note_artifacts_v51` (`lib.rs:5069`) runs unconditionally on every open at
`lib.rs:4902`, and delegates to `repair_note_artifacts_tx` (`lib.rs:13782`), which
is also reached from a second caller at `lib.rs:12171`.
`normalize_authority_note_route_tx` (`lib.rs:1391`) is invoked at `lib.rs:5137`.
Four problems:

- **Its doc comment contradicts its code.** `lib.rs:5064-5066` says "replay this
  idempotent repair on every store open, including stores that already recorded
  the upgraded schema version." The body (`lib.rs:5071-5080`) returns early when
  a completion flag row exists, so it runs at most once. The first paragraph of
  that comment describes route normalization, not artifact repair, and no function
  named `complete_authority_route_normalization` exists. This is a misattached doc
  block orphaned by a deletion, the same class `80585c48` claimed to fix
  elsewhere.
- **The completion flag is a fake session row.** `lib.rs:5106-5110` does
  `INSERT OR IGNORE INTO mc_cache_state (session_id, row_version, core_state,
  meta) VALUES (?1, 0, '', '')` with `session_id =
  "note_artifact_repair_v51_done"` (`lib.rs:5070`). Meanwhile `has_cache_state`
  (`lib.rs:5362`) is documented as a provenance check whose comment claims "a
  client-supplied harness label cannot create this row". The sentinel makes
  `has_cache_state("note_artifact_repair_v51_done")` true. Worse, `core_state`
  and `meta` are empty strings, which are not valid JSON, so any path that loads
  that row and deserializes them fails. `last_activity_at` is omitted and defaults
  to 0 per the DDL, so the `mc_transform_session_roots` GC at `lib.rs:4917-4923`
  is unaffected; that one is safe.
- **It is named for a migration that no longer exists.** Three tests
  (`lib.rs:18071` `migration_v51_backfill_...`, `lib.rs:18124`
  `note_artifact_repair_verifies_digest_or_clears_compiled_state`, `lib.rs:18905`
  `v51_repair_keeps_a_legacy_artifact_that_has_no_recorded_digest`) target a v51
  step that the v57 consolidation absorbed. Whether the pre-v51 rows these
  helpers repair can still exist in any store the pre-cutover refusal admits is
  unresolved. If they cannot, this is dead code running on every open. If they
  can, the refusal at `lib.rs:1375` is admitting a store it should not.
- **None of its three tests runs in CI.**

### 5. Regions of the monolith with no executed check at all

87 tests over 13,930 production lines is roughly one test per 160 lines, and the
distribution is uneven. The 87 cluster heavily on notes, note-eval claims, and
the historian, which together account for 43 of them. Sparse by comparison, and
worth targeted attention:

- The `MIGRATIONS` DDL itself (`lib.rs:432-1312`, 881 lines) has no structural
  assertion, only incidental execution.
- Authority state-machine and drain-journal logic around `lib.rs:11300-11900`
  (the four `set_claim_intent_transition_tx` call sites at `:11434`, `:11640`,
  `:11738`, `:11790`) is covered only by the 7 `shadow_tests`, all of which are
  in-crate and none of which runs in CI. If D2-2's residual bypass is real, those
  tests pass while the transition rows are never written.
- Bead `magic-context-d5l` independently flags this file as needing extraction and
  records 8 further seam candidates, which is corroboration that the quiet
  regions are known but unmapped.

I did not compute line coverage. These are structural observations from test
placement, not a coverage measurement, and a coverage run would sharpen or refute
them.

## Open questions

- Does `context_store_uuid` actually carry a 36-character dashed value at every
  one of the four `set_claim_intent_transition_tx` call sites? `e8b7640c`'s body
  asserts the host mints it with `randomUUID()`, and the parameter is validated as
  32-lower-hex, which would make all four writes silent no-ops. Confirming this
  requires reading the host's mint path outside these three crates. If confirmed
  it is a live, acknowledged, unfixed defect and the highest priority item here.
- Can a `context-committed`, `acknowledged`, or `terminal-rejected` intent replay
  re-drive a mutation? `482348b0` fences only `staged` and asserts the other three
  are safe, but does not show it. If any of them can, D2-3's fix is incomplete.
- Is a store recorded at `mc_cache` version above 57 reachable in the field, and
  what should the Rust store do about it? Adding a Rust-side newer-schema refusal
  is a design decision about which layer owns the fence, given the TypeScript one
  already exists. (needs human input)
- Can the pre-v51 rows that `repair_note_artifacts_v51` exists to repair still
  occur in any store the pre-cutover refusal admits? Either answer indicates a
  defect: dead code on every open, or a refusal that is too permissive.
- Should the completion flag move out of `mc_cache_state` into its own table? It
  currently pollutes a session-keyed table with a row whose `core_state` and
  `meta` are invalid JSON, and it falsifies `has_cache_state`'s documented
  provenance claim. (needs human input)
- What is the intended reachability of `crates/mc-store/src/sqlite_runtime.rs`
  from Rust? Its doc claims it is the contract for `store.db` writers; no Rust
  production path calls it. Either `McStore::open` should enforce it or the doc
  should say the host owns it. (needs human input)
- Does the v57 consolidated DDL preserve the schema step that `412b70f1`'s
  migration 44 added for stale-sync-generation adoption? The runtime logic
  survives; the migration does not.
- Do the other capped tables share D2-9's tied-timestamp pruning bug? The
  pass-scheduler history caps at `lib.rs:411-412` are the obvious neighbours and I
  did not audit them.
- Are `#8342` and `86e3ae26c2ea5a1b` references to work items that were deleted,
  or to a tracker other than beads? Neither resolves under `bd show`. `#1234` and
  `#409` are, on reading their surrounding prose, almost certainly example
  strings rather than references, and I am not counting them.
- Roughly 90 `mason:` commits were sampled by subject only, not by diff. The nine
  defect records above are not claimed to be exhaustive, and that tail is the
  largest unexamined region of this lens.
