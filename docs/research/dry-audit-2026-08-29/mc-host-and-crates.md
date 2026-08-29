# DRY / code-reduction audit — mc-host, mc-store, mc-shm-transport, mc-core, mc-tokenizer

Audited at HEAD `9c1eb4d1` on 2026-08-29. Read-only: no source file was modified.

Scope and size:

| Crate | LOC (all `.rs`) | src LOC | Notes |
| --- | --- | --- | --- |
| mc-host | 75,819 | 39,890 | 39 src files; largest `client.rs` 4,228 |
| mc-store | 23,244 | 22,428 | **`src/lib.rs` alone is 20,650 LOC** |
| mc-shm-transport | 6,975 | 4,742 | last touched 2026-08-26 — active ground |
| mc-core | 1,518 | 1,518 | 3 files |
| mc-tokenizer | 158 | 85 | — |

## Summary

| Tier | Count | Est. net LOC delta |
| --- | --- | --- |
| T0 | 9 | −220 |
| T1 | 10 | −420 |
| T2 | 6 | −760 |
| T3 | 3 | −60 (plus large structural reorganisation, LOC-neutral) |
| TRACKED | 6 | do not remove |
| Do not unify yet | 7 | 0 |

Realistically deletable **now**, at T0+T1 only: **≈ 640 LOC**.
Deletable including T2 (needs a `thiserror` dependency decision and touches sensitive paths): **≈ 1,400 LOC**.

Headline: mc-store's `src/lib.rs` is the centre of gravity for this audit. It is 20,650 LOC in one file, 203 of the last 300 commits on that path touch it, and it contains an entire duplicated write-path surface (`FacadeMutationTxn` vs `impl McStore`) that has **already diverged semantically** — that is finding **F1** and it is the only finding in this report with a correctness consequence.

---

## Findings by tier

### T0

#### F3a — `hex` duplicated verbatim inside mc-host
- **Members:** `crates/mc-host/src/instance.rs:867` (`pub(crate) fn hex`), `crates/mc-host/src/harness_closure.rs:1112` (`fn hex`)
- **Common core:** identical 9-line nibble→ASCII loop with the same `const HEX: &[u8; 16]` table.
- **Differences:** local binding named `out` vs `output`. Nothing else.
- **Clone type:** exact (modulo one identifier).
- **Call sites:** `harness_closure.rs:191, 575, 614`.
- **Why this is trivially safe:** `crates/mc-host/src/generation.rs:27-31` *already* does the right thing — it imports `hex, io_err, is_safe_ancestor, is_secure_regular, mode_bits, read_all_fd, write_all_fd, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG` from `crate::instance`. `harness_closure.rs` imports nothing from `instance` and re-derives the same primitives. The fix is "follow the convention the sibling module already follows".
- **Est. net LOC:** −9
- **Lane:** text.

#### F3b — `mode_bits` duplicated verbatim (both `cfg` arms)
- **Members:** `crates/mc-host/src/instance.rs:716` + `:721`, `crates/mc-host/src/harness_closure.rs:1103` + `:1108`
- **Common core:** the macOS/non-macOS `st_mode` width bridge, byte-identical.
- **Clone type:** exact.
- **Est. net LOC:** −6
- **Lane:** text.

#### F3c — `owner_uid` triplicated, and `geteuid()` inlined 6 more times
- **Members:** `crates/mc-host/src/generation.rs:407`, `crates/mc-host/src/harness_closure.rs:1098`; plus raw `rustix::process::geteuid().as_raw()` at `instance.rs:552, 779, 791`, `lifecycle.rs:140, 732`, `connection_file.rs:290`.
- **Clone type:** exact (the two `fn`s), structural (the inline uses).
- **Est. net LOC:** −6 (fold both `fn`s onto one `pub(crate)` in `instance.rs`).
- **Lane:** text.

#### F3d — `S_IFMT` / `S_IFDIR` / `S_IFREG` / `S_ISVTX` redeclared
- **Members:** `crates/mc-host/src/instance.rs:709-713`, `crates/mc-host/src/harness_closure.rs:27-30`
- **Differences:** `instance.rs` also has `S_IFLNK`; `S_ISVTX` is private in `instance.rs` and would need `pub(crate)`.
- **Est. net LOC:** −4
- **Lane:** text.

#### F2a — exact duplicate 41-line commit tail in `lineage_descent`
- **Members:** `crates/mc-store/src/lib.rs:8298-8338` and `crates/mc-store/src/lib.rs:8389-8429`
- **Common core:** **41 of 41 lines byte-identical** — `next_version` computation, two `serde_json::to_string` + `LineageDescentTxnOutcome::Serde` arms, the `INSERT INTO mc_cache_state … ON CONFLICT(session_id) DO UPDATE SET` upsert with its 5 params, and the `return Ok(LineageDescentTxnOutcome::Committed(LineageDescentOutcome { … }))`.
- **Differences:** none.
- **Clone type:** exact. Verified by line-by-line comparison, not by eye.
- **Est. net LOC:** −41 on its own; see F2b for the combined fix.
- **Lane:** structural.

#### F12 — dead `pub` items (zero references anywhere in `crates/` or `packages/`)

Verified by extracting all 599 `pub fn` + all `pub struct/enum/trait/const/type` in scope, then counting every occurrence of each identifier across all Rust in `crates/` and `packages/` and all TypeScript in `packages/`. Only these have a count of exactly 1 (the definition itself). mc-host/mc-store are path dependencies consumed only by `mc-module` (which builds the `ck-mc-host` binary that `packages/cli` and `packages/plugin` invoke), so zero in-workspace references means unreachable — there is no external crate consumer.

| Item | LOC | Note |
| --- | --- | --- |
| `crates/mc-store/src/lib.rs:8051` `load_compartments_after` | 46 | Sole non-test constructor of `CompartmentPage`; the other construction site is `lib.rs:5733`, so `CompartmentPage` itself survives. Its 17-column SELECT is member #4 of F8a. |
| `crates/mc-store/src/lib.rs:10991` `seed_workspace_member` | 26 | The `mc_workspaces`/`mc_workspace_members` seed path. Cross-check bead `magic-context-6bd` (*workspace member prune protocol for the native memory mirror*) and `magic-context-a7v` before deleting — if either intends to write members from Rust this is a precursor. Not otherwise reachable. |
| `crates/mc-host/src/broca/mod.rs:114` `route_index` | 8 | Doc comment claims "cloned by tests before the component moves into a composite" — no test does. The comment is itself stale (see C5). |
| `crates/mc-host/src/frame_channel.rs:283` `into_charge` | 7 | `ProducedBody::into_charge`. Note `frame_channel.rs:32` already carries an `#[allow(dead_code)]` on `ReadClose`, so this module already tolerates unused surface. |
| `crates/mc-shm-transport/src/descriptor.rs:210` `hardware_matches` | 5 | **Sensitive crate → treat as T2, see F13b.** Listed here only for the reference count. |

- **Est. net LOC:** −87 for the four non-sensitive items.
- **Lane:** typed-semantic (compiler proves removal).

#### C1–C4 — bead IDs and roadmap tense in code comments
See [Comment violations](#comment-violations). −4 LOC of comment text, 4 edits.

---

### T1

#### F1 → see T2. Listed there because it changes a `pub` surface and has a correctness consequence.

#### F2b — third, near-miss copy of the `lineage_descent` commit tail
- **Members:** `crates/mc-store/src/lib.rs:8298-8338`, `:8389-8429` (exact pair, F2a), `:8466-8506`
- **Common core:** the same 41-line block.
- **Differences (block C only, 3 lines of 41):** `disposition,` → `disposition: LineageDescentDisposition::PendingBuildSkew,`; `source_key: None,` → `source_key: Some(source_key),`; `acknowledge: true,` → `acknowledge: false,`.
- **Call sites / module spread:** all three are `return` tails inside one function in one file.
- **Clone type:** near-miss (3-parameter difference).
- **Priority signals:** `mc-store/src/lib.rs` took 203 of the last 300 commits on its own path — the hottest file in the audited scope. Bead `magic-context-lcb` (*revert-aligned memory epochs: roll MC state back on harness revert*) will touch lineage descent again.
- **Fix:** one private `fn commit_lineage_disposition(tx, request, target_core, target_meta, current_target_version, disposition, source_key, acknowledge) -> rusqlite::Result<LineageDescentTxnOutcome>`. That is 8 params, so it needs `#[allow(clippy::too_many_arguments)]` — acceptable here because it is one fully-specified commit, the same justification `broca/pi.rs:209` already documents for `run_pi`.
- **Est. net LOC:** −70 (123 duplicated → ~44 helper + ~9 at three call sites).
- **Lane:** structural.

#### F5 — `open_rel_nofollow` / `open_rel_dir_nofollow` differ only in the final component's flags
- **Members:** `crates/mc-host/src/generation.rs:363-382`, `crates/mc-host/src/generation.rs:387-406`
- **Common core:** split `rel` on `/`, reject empty/`.`/`..`, `openat` each component from the previous pinned fd with `NOFOLLOW | CLOEXEC | RDONLY`, `None` on any error.
- **Differences:** `open_rel_nofollow` opens the *last* component with `RDONLY | NOFOLLOW | CLOEXEC | NONBLOCK` (file); `open_rel_dir_nofollow` opens *every* component including the last with `DIRECTORY | RDONLY | NOFOLLOW | CLOEXEC`. `open_rel_nofollow` uses a `peekable` iterator to detect "last", the dir variant does not need to.
- **Call sites:** `open_rel_nofollow` at `generation.rs:329, 636, 675, 958`; `open_rel_dir_nofollow` at `generation.rs:871` (one site).
- **Clone type:** parameterized.
- **Fix:** one `fn open_rel_nofollow(dir, rel, final_is_dir: bool)`, or keep both names as two-line wrappers over a shared walk. Note the `NONBLOCK` on the final file open is load-bearing — `lifecycle.rs:798-804` documents exactly why (a planted FIFO passes `O_NOFOLLOW` and would block a probe uncancellably). Any collapse must preserve it.
- **Sensitivity:** secure path opens are on the sensitive list, but this pair is *inside one file*, both are private, and both walk a relative path under an already-pinned and already-validated fd — they perform no ancestor validation of their own. That is materially less load-bearing than the F4 family. Rated T1, with the `NONBLOCK` note as the review gate.
- **Est. net LOC:** −18
- **Lane:** structural.

#### F7 — six pure-forwarding wrappers over `frame_read`'s three primitives
- **Members:**
  - `crates/mc-host/src/tcp_frame_channel.rs:234` `drain_declared_body` → `frame_read::drain(…).map_err(drain_close)`
  - `crates/mc-host/src/tcp_frame_channel.rs:249` `read_exact_deadline` → `frame_read::read_exact(…).map_err(frame_close)`
  - `crates/mc-host/src/tcp_frame_channel.rs:264` `read_body_deadline` → `frame_read::read_body(…).map_err(frame_close)`
  - `crates/mc-host/src/client.rs:1985` `read_exact_until` → `frame_read::read_exact(…).map_err(|_| ())`
  - `crates/mc-host/src/client.rs:1999` `read_body_until` → `Vec::with_capacity` + `frame_read::read_body(…).map_err(|_| ())`
  - `crates/mc-host/src/client.rs:~2010` `drain_until` → `frame_read::drain(…).map_err(|_| ())`
- **Common core:** call the shared primitive, map `ReadStop` onto the local error type. Zero other logic.
- **Differences:** the error map only. `read_body_until` also allocates the `Vec`.
- **Call sites:** 2, 1, 2 (tcp) and 2, 1, 1 (client) — **9 call sites for 6 wrappers**.
- **Clone type:** structural (six instances of one shape).
- **Honest ranking:** this is genuine pure forwarding (AGENTS.md "pure forwarding of a parameter through 2+ intermediate functions"), but the wrappers *are* the naming layer that keeps `frame_close` vs `drain_close` classification at one place per layer, and inlining `.map_err(frame_close)` at 3 sites is a wash. The three `client.rs` ones (`map_err(|_| ())`) are the clear win: the mapping is `()`, so it carries no information a call site would have to restate. Collapse those three; **leave the `tcp_frame_channel.rs` three alone** — `frame_close`/`drain_close` encode "which phase lost alignment" and that is worth a named wrapper.
- **Est. net LOC:** −22 (client side only).
- **Lane:** text.

#### F8a — the 17-column compartment SELECT list written out 5 times
- **Members:** `crates/mc-store/src/lib.rs:5720, 7965, 8028, 8066, 8103` — each spelling out
  `sequence, start_message, end_message, start_message_id, end_message_id, start_date, end_date, title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at` across 4 wrapped lines.
- **Common core:** the exact column list, in the exact order that `Self::stored_compartment_from_row` (6 uses) reads positionally.
- **Differences:** the `WHERE`/`ORDER BY`/`LIMIT` tails.
- **Why this matters more than the LOC:** the row mapper indexes by position. Reordering or inserting a column in 4 of the 5 sites and missing the 5th silently mis-maps fields — it does not fail to compile and does not fail to parse.
- **Established idiom to reuse:** `lib.rs:3783 CLAIM_INTENT_COLUMNS`, `lib.rs:12838 NOTE_SELECT_COLUMNS`, `lib.rs:12928 NOTE_EVAL_CLAIM_COLUMNS`, `lib.rs:12938 NOTE_EVAL_CANDIDATE_COLUMNS` already do exactly this with `format!("SELECT {CONST} FROM …")`.
- **Est. net LOC:** −12 (one `const` + 5 `format!`), plus one site deleted outright by F12.
- **Lane:** text.

#### F8b — `NOTE_SELECT_COLUMNS` and `NOTE_INSERT_COLUMNS` are hand-maintained in parallel
- **Members:** `crates/mc-store/src/lib.rs:12838`, `crates/mc-store/src/lib.rs:12839`
- **Verified:** 42 columns vs 41 columns; the only difference is `id`; and `select[1..] == insert` exactly, in order. Two ~1,100-character single-line string literals that must stay in lockstep.
- **Fix:** define `NOTE_INSERT_COLUMNS` as the tail of a single source list, or invert (`NOTE_SELECT_COLUMNS = concat!("id, ", NOTE_INSERT_COLUMNS)` — `concat!` accepts literals only, so this needs the list as one literal plus a `const` slice, or a tiny `const fn`/build-time split).
- **Est. net LOC:** −1 line, but removes a 41-way parallel-maintenance hazard.
- **Lane:** text.

#### F8c — `mc_cache_state` reads spelled out 12 times
- **Members:** `"SELECT row_version, meta FROM mc_cache_state WHERE session_id = ?1"` at `lib.rs:6994, 8582, 8924, 9024, 9224, 9302, 9363` (7×); `"SELECT row_version, core_state, meta FROM mc_cache_state WHERE session_id = ?1"` at `lib.rs:5485, 5536, 5667, 7626, 8185` (5×).
- **Clone type:** exact string literals.
- **Est. net LOC:** ~0 (two `const`s replace 12 literals) — this is drift-proofing, not deletion. Include it in the same pass as F8a/F8b or skip it.
- **Lane:** text.

#### F8d — the 40-column `json_object(…)` note projection duplicated across two triggers
- **Members:** `crates/mc-store/src/lib.rs:1051-1094` (`mc_notes_feed_insert`), `crates/mc-store/src/lib.rs:1114-1157` (`mc_notes_feed_update`)
- **Common core:** the full `json_object('id', NEW.id, 'type', NEW.type, … 'compile_status', NEW.compile_status)` changefeed snapshot.
- **Differences:** insert vs update trigger header and the `'insert'`/`'update'` op literal. The update trigger additionally carries a ~25-clause `WHEN NEW.x IS NOT OLD.x OR …` guard (`lib.rs:1088-1112`) that enumerates the *same* column set a third time.
- **Why this matters:** adding a column to `mc_notes` today requires four coordinated edits — `NOTE_SELECT_COLUMNS`, `NOTE_INSERT_COLUMNS`, both `json_object` projections, and the `WHEN` guard. Missing the projections silently drops the column from the changefeed snapshot that the module mirror consumes.
- **Fix:** build the schema DDL string from one Rust-side column list (this is `CREATE TRIGGER` text in a Rust `const`/`&str`, so a `format!` over a shared list is available). **Schema DDL is a migration surface** — changing the emitted trigger text changes the schema fingerprint, so this needs the migration-lane check in `docs/migration-version-lanes.md` and must produce byte-identical DDL. That constraint is what keeps it at T1-with-a-gate rather than a free win.
- **Est. net LOC:** −45
- **Lane:** structural.

#### F10 — five copies of the mc-store `StorageDescriptor` test fixture
- **Members:**
  - `crates/mc-store/src/lib.rs:13937` `tests::descriptor` — `module_id: "magic-context-test"`, `to_string_lossy().to_string()`
  - `crates/mc-store/src/lib.rs:19426` `shadow_tests::store` — same descriptor inlined + `.unwrap()`
  - `crates/mc-store/src/lib.rs:19986` `lineage_descent_tests::store` — `module_id: "magic-context-lineage-test"`
  - `crates/mc-store/tests/claim_mirror.rs:20` `descriptor` — `module_id: "magic-context-claim-mirror-test"`, `into_owned()`
  - `crates/mc-store/tests/claim_intent_ledger.rs:18` `descriptor` — `module_id: "magic-context-test"`, `into_owned()`
- **Common core:** `StorageDescriptor { module_id, storage_namespace: "mc_cache", isolation: Isolation::Module, backend: StorageBackend::Sqlite { path: dir.join("store.db") } }`.
- **Differences:** `module_id` string; `to_string()` vs `into_owned()` on the same `Cow`; two of them also `McStore::open(…).unwrap()`.
- **Module spread:** 3 inline test modules + 2 integration test binaries.
- **Fix:** mc-store already has a `test-support` feature (`Cargo.toml:27`, consumed by `mc-module/Cargo.toml:71`) and already exposes `seed_tags_for_test` / `seed_channel1_append_for_test` under it (`lib.rs:6653, 6663`). Add `#[cfg(feature = "test-support")] pub fn open_for_test(dir: &Path, module_id: &str) -> McStore` next to them. The pattern and the gate both already exist.
- **Est. net LOC:** −45
- **Lane:** structural.

#### F11 — `TransformCommit { … }` 20-field literal written out 10 times in tests
- **Members:** `crates/mc-store/src/lib.rs:13977, 14220, 14299, 14375, 14514, 14600, 14731, 15230, 15295, 15970` (10 test sites; production sites are `:7236` and the destructure at `:7265`).
- **Common core:** ~18 of ~20 fields are the same "nothing happened" values every time — `consumed_drop_ids: &[]`, `first_applied_command_ids: &[]`, `claim_snapshot_vector: None`, `compartment_max_seq: None`, `project_root: None`, `first_divergence: None`, and the eight `scheduler_*` fields (`scheduler_applied_reductions:` appears 12 times total).
- **Differences:** `expected`, `core`, `meta`, and usually one or two scheduler/overlay fields per test.
- **Clone type:** parameterized.
- **Fix:** `fn base_commit<'a>(expected: Option<u64>, core: &'a CoreState, meta: &'a ModuleMeta) -> TransformCommit<'a>` in the test module; tests then mutate the two or three fields they exercise. `TransformCommit` holds `&[T]` and `Option<_>` fields (both have sensible zero values) plus three borrowed non-`Default` fields, which is exactly the shape a 3-arg constructor handles.
- **Est. net LOC:** −105
- **Lane:** structural.
- **See also:** T-2 in [Test findings](#test-findings) — this is the same clone class viewed as a test-quality problem.

---

### T2

#### F1 — `FacadeMutationTxn` is a second, already-diverged copy of the `McStore` note write path
**This is the top finding in the report.**

- **Members (paired):**

| Facade (`impl FacadeMutationTxn<'a>`, `lib.rs:4392-4608`) | `impl McStore` twin | Error type |
| --- | --- | --- |
| `insert_note` `lib.rs:4393-4415` (23 LOC) | `insert_note` `lib.rs:10130-10163` (34 LOC) | `String` vs `McStoreError` |
| `insert_project_note` `lib.rs:4417-4458` (42 LOC) | `insert_project_note` `lib.rs:10166-10221` (56 LOC) | `String` vs `McStoreError` |
| `update_note_cas` `lib.rs:4460-4549` (90 LOC) | `update_note_cas` `lib.rs:10409-10503` (95 LOC) | `String` vs `McStoreError` |
| `dismiss_note` `lib.rs:4551-4607` (57 LOC) | `dismiss_note` `lib.rs:10507-10563` (57 LOC) | `String` vs `McStoreError` |

- **Common core:** identical SQL and identical `params![…]` blocks. Confirmed mechanically by a 14-line sliding-window clone detector, which reports `lib.rs:4516 ≡ lib.rs:10476` (`NOTE_CAS_UPDATE_SQL` + the 14-element `params!`) and `lib.rs:4581 ≡ lib.rs:10538` (the `UPDATE mc_notes SET status = 'dismissed' …` statement). Both pairs also share the `content.trim()` + empty rejection, the `pending`-vs-`active` status derivation, the `changed == 0 → Conflict` re-read, and the `if compiler_edit { fence_active_note_claims_tx(…) }` tail.

- **Differences — and this is the finding, not the LOC:**

  1. **The CAS "did the condition change?" predicate has diverged.**
     - `lib.rs:4497` (facade): `let condition_changed = surface_condition.is_some();`
     - `lib.rs:10525` (McStore): `let condition_changed = surface_condition.is_some() && next_condition != current_condition;`

     The `McStore` version carries an explicit comment at `lib.rs:10520-10523`: *"Presence alone is not an edit: an update that re-supplies the existing condition unchanged must not invalidate the compiled artifact, reset a ready note to pending, or fence active claims."* The facade version does the exact thing that comment forbids.

  2. **The mutation-neutral early return exists on only one side.**
     `lib.rs:10529-10534` returns `Applied(current)` without writing when `!compiler_edit`, with the comment *"bumping the versions would fence an active evaluation claim and re-run billable work for compiler inputs that did not change."* The facade path has no such branch: it always executes the UPDATE, always bumps `status_version`/`state_version`, and always calls `fence_active_note_claims_tx` when `compiler_edit` is true — which, given (1), is true on any request that carries a `surface_condition` at all.

  So a facade-routed note update that re-supplies an unchanged condition invalidates the compiled artifact, resets `ready` → `pending`, fences the active evaluation claim, and re-triggers billable compile work. The same request through `McStore::update_note_cas` is a no-op. This is a live behavioural fork, not a stylistic duplicate.

- **Call sites:** all 5 production callers use the `McStore` method — `crates/mc-store/src/lib.rs:10391`, `crates/mc-module/src/lib.rs:11849`, `crates/mc-module/src/smart_note_evaluation.rs:1281`, `:1412`. Plus 10 test sites in `lib.rs`. The **facade** methods are reached through `with_facade_command` (`lib.rs:4966`) — i.e. the command-aware / response-ledger path, which is the one the claims cutover is moving onto.

- **Module spread:** one file, but ~5,900 lines apart, which is precisely why the drift went unnoticed.

- **Clone type:** near-miss with semantic divergence. The `insert_note` / `insert_project_note` / `dismiss_note` pairs are still structural clones (same SQL, same params, different error type and transaction acquisition); `update_note_cas` has already broken.

- **Priority signals:** `mc-store/src/lib.rs` absorbed **203 of the last 300 commits** on its own path — the highest-churn file in scope. Both copies are current (not one legacy + one new). Beads `magic-context-3q5.8` (*U7: direct claims cutover for memory storage*), `magic-context-3q5.9`, and `magic-context-3q5.10` (*verify direct cutover and remove legacy surfaces*) will rewrite exactly this surface, which makes the divergence a hazard *now* and the consolidation cheap to fold into that work.

- **Fix:** the codebase already has the right idiom — free `*_tx(tx: &rusqlite::Transaction, …)` functions: `load_note_tx`, `fence_active_note_claims_tx`, `mark_note_eval_claim_terminal_tx` (`lib.rs:13072`), `normalize_authority_note_route_tx` (`lib.rs:1391`). Extract `insert_note_tx`, `insert_project_note_tx`, `update_note_cas_tx`, `dismiss_note_tx`. `FacadeMutationTxn` keeps `.map_err(|e| e.to_string())`; `McStore` keeps `with_note_conn_fenced` + `require_note_project` / `enforce_facade_project_vocabulary`. The `McStore` semantics (the commented ones) become the single definition.

- **Est. net LOC:** −170.
- **Lane:** typed-semantic. **Requires a decision, not just a refactor:** confirm the facade's looser predicate is a bug and not an intentional command-path difference before unifying. If it is intentional, that intent belongs in a comment on both sides — right now nothing marks the fork.
- **T2 because:** it changes a `pub` method surface on `FacadeMutationTxn`, and correcting the divergence changes observable behaviour on the facade path.

#### F4 — the mc-host `O_NOFOLLOW` component-walk exists **six** times
**TRACKED(magic-context-nll)** — the bead names two of the six.

- **Members:**

| Location | Shape | Creates? | Ancestor check | Final check | Error type |
| --- | --- | --- | --- | --- | --- |
| `instance.rs:465` `secure_runtime_dir` | absolute path walk | yes (`mkdirat` + `chmodat` + `fchmod` 0700) | `is_safe_ancestor` | dir + owner, then `fchmod` 0700 | `InstanceError` |
| `instance.rs:414` `open_secure_dir_existing` | absolute path walk | no | `is_safe_ancestor` | left to caller | `InstanceError`, `Ok(None)` = absent |
| `lifecycle.rs:675` `open_validated_dir` | absolute path walk | no | `is_safe_ancestor` | dir + owner + `mode & 0o077 == 0` | `InstanceError`, `Ok(None)` = absent |
| `connection_file.rs:252-275` (inline in `read_for_client`) | absolute path walk | no | `validate_directory` | separate | `ConnectionFileError` |
| `harness_closure.rs:1034-1082` `open_or_create_store_path` | absolute path walk | yes (`mkdirat` 0700) | `verify_safe_ancestor` | `verify_owned_directory` (0700 exact) | `HarnessClosureError` |
| `generation.rs:363` / `:387` | *relative* walk under a pinned fd | no | none | none | `Option` |

- **Common core:** classify components (reject `..`/`Prefix`/empty), open a safe anchor (`/` or `.`), then `openat(previous_fd, name, DIRECTORY|RDONLY|NOFOLLOW|CLOEXEC)` per component, proving every intermediate is replacement-proof before pinning the next.
- **Differences:** create-vs-observe, the final-component predicate, the error type, and whether `Ok(None)` means "absent". `connection_file.rs:245-250` already documents the split explicitly: *"Anchor open, ancestor-safety proof, and component classification are shared with `instance::secure_runtime_dir`. The walks themselves are not… Only the hardening rules are common, and those are the part that must never drift."*
- **What the bead covers:** `magic-context-nll` — *"mc-host: share the O_NOFOLLOW component-walk between `secure_runtime_dir` and `open_validated_dir`"*. Rows 1 and 3 only.
- **What this audit adds:** rows 2, 4, and 5 belong to the same class. `harness_closure.rs:1034` (row 5) is the one the bead's framing misses entirely — it is a *creating* walk, like `secure_runtime_dir`, and it re-derives `verify_safe_ancestor` (`harness_closure.rs:1085`) as a byte-equivalent copy of `instance::is_safe_ancestor` (`instance.rs:774`): both check `mode & S_IFMT == S_IFDIR`, `uid ∈ {ours, root}`, and `mode & 0o022 == 0 || S_ISVTX`. Two independently maintained copies of one security predicate.
- **Priority signals:** `instance.rs` (22 commits) and `lifecycle.rs` (20) co-change heavily in the last 300 commits on these paths — strong support for the bead's pairing. `harness_closure.rs` has only 3 commits and co-changes with `generation.rs` twice, so row 5 is *weakly* coupled — which is the argument for it, not against it: a hardening fix landing in `instance.rs` will not reach it.
- **Est. net LOC:** −150 across the family if `is_safe_ancestor` becomes the single predicate and the walk becomes one function parameterised by (create-or-not, final predicate, error mapping).
- **Lane:** typed-semantic.
- **Recommendation:** **do not re-propose the walk unification** — reference `magic-context-nll`. Do add to that bead: (a) `open_secure_dir_existing` and the `connection_file.rs` inline walk as additional members, and (b) `harness_closure::verify_safe_ancestor` as a *predicate* duplicate that should collapse onto `instance::is_safe_ancestor` independently of the walk work. Item (b) is separable and is the T0 slice of this family (see F3).

#### F6 — the wire envelope header is constructed three times in `encode_*`
- **Members:** `crates/mc-host/src/wire.rs:542` `encode_frame` (`#[cfg(test)]`), `:571` `encode_owned_frame`, `:608` `encode_split_frame`
- **Common core:** each repeats verbatim
  ```
  if body.len() > MAX_BODY_LEN as usize { return Err(EncodeError { body_len }) }
  let len = u32::try_from(body_len).map_err(|_| EncodeError { body_len })?;
  let header = EnvelopeHeader { len, ver: PROTOCOL_VERSION, ty, flags,
                                channel: id.channel, epoch: id.epoch, corr: id.corr };
  ```
- **Differences:** how the header meets the body. `encode_frame` builds a fresh `Vec` (test-only oracle path). `encode_owned_frame` does an in-place `reserve_exact` + `resize` + `copy_within` prefix shift, with a load-bearing comment at `:594-597`: *"Exact-size growth: amortized `reserve` may double a full-capacity body (a 64 MiB response would hold 128 MiB), exceeding what the caller's byte-budget charge accounts for."* `encode_split_frame` returns `(header.to_vec(), body)` above `SPLIT_WRITE_MIN_BODY` (16 KiB) and delegates to `encode_owned_frame` below it.
- **Call sites:** `encode_frame` 9× (all tests, `tcp_frame_channel.rs` and `frame_channel/contract_tests.rs`); `encode_owned_frame` 9× production (`client.rs:1336, 2125, 2167`; `dispatch.rs:700, 779, 1435`; `connection.rs:1248, 1325, 1412`); `encode_split_frame` 2× (`dispatch.rs:280, 317`).
- **Clone type:** near-miss — one shared prologue, three distinct epilogues.
- **Fix:** `fn frame_header(ty, flags, id, body_len) -> Result<[u8; HEADER_LEN], EncodeError>` doing validation + `EnvelopeHeader::encode()`. All three then differ only in their epilogue, which is where they *should* differ.
- **Sensitivity:** wire framing → T2 minimum. **Impact note:** the byte-budget invariant in `encode_owned_frame` (allocation must be exactly `HEADER_LEN + body_len`, never amortised-doubled) is not expressible in the shared prologue and must survive untouched; `benches/ipc_budget.rs` and `tests/protocol_vectors.rs` are the guards. Adjacent to **TRACKED(magic-context-kp5)** — *"give outgoing-frame byte accounting one owner in wire.rs"* — same file, same functions, different axis (kp5 owns the `ByteBudget`/`ByteCharge` accounting at `wire.rs:384-507`; this finding is header construction). Sequence F6 after kp5 or fold it in; do not land them independently.
- **Est. net LOC:** −25
- **Lane:** structural.

#### F9 — 856 LOC of hand-written `Display` / `Error` / `From` across 84 impl blocks; no `thiserror` in the workspace
- **Members:** 84 blocks across the audited crates. Verified: the workspace has **no** `thiserror` dependency in any `Cargo.toml`. Largest offenders:

| Block | LOC |
| --- | --- |
| `crates/mc-store/src/lib.rs:3447` `Display for McStoreError` | 106 |
| `crates/mc-host/src/connection_file.rs:136` `Display for ConnectionFileError` | 43 |
| `crates/mc-host/src/config.rs:423` `Display for ConfigError` | 43 |
| `crates/mc-host/src/wire.rs:245` `Display for DecodeError` | 42 |
| `crates/mc-host/src/auth.rs:572` `Display for AuthError` | 41 |
| `crates/mc-store/src/lib.rs:1818` `Display for HistorianPublishError` | 41 |
| `crates/mc-store/src/claim_mirror.rs:184` `Display for ClaimMirrorError` | 40 |
| `crates/mc-host/src/instance.rs:79` `Display for InstanceError` | 39 |
| … 76 more | 461 |

- **Clone type:** structural — 84 instances of `match self { Variant{..} => write!(f, "…") }` plus `impl Error for X {}` plus `impl From<Y> for X { fn from(e: Y) -> Self { X::Y(e) } }`.
- **Est. net LOC:** −570 (856 → roughly 280 lines of `#[error("…")]` / `#[from]` / `#[source]` attributes). `thiserror` handles the long multi-line operator-facing remediation strings (e.g. `McStoreError::PreCutoverModuleStore` at `lib.rs:3459-3466`) in an `#[error("…")]` attribute without loss, and handles the `Error::source` forwarding that `mc-shm-transport`'s enums do by hand.
- **Priority signals:** this is the single largest LOC win in the report and it is almost entirely mechanical.
- **T2 because:** it adds a workspace dependency (a policy decision, not a refactor), it crosses all five crates, and it changes the `Display` text if done carelessly. Two guardrails: mc-host has `#![deny(unsafe_code)]` and mc-shm-transport `#![warn(missing_docs)]` + `#![deny(unsafe_op_in_unsafe_fn)]` — `thiserror` is compatible with all three. `mc-shm-transport`'s enums are `#[derive(Clone, Copy, PartialEq, Eq)]` with `Display` written as `write_str(match self { … })`; `thiserror` output is equivalent but the derive interacts with the manual `Debug`-forwards-to-`Display` pattern (see F13a), so do those two together in that crate.
- **Recommendation:** land it crate-by-crate, mc-store first (that is 250 of the 856 LOC and the hottest file), with a test that snapshots each error's `to_string()` before and after.
- **Lane:** typed-semantic.

#### F13a — `impl Debug { Display::fmt }` copied 8 times in mc-shm-transport
- **Members:** `backend/ring.rs:1476` (`ProducerError`), `:1540` (`RingError`), `descriptor.rs:~569` (`DescriptorError`), `profile.rs:~593` (`ProfileError`), `:~638` (`AdmissionError`), `backend/iceoryx.rs:~378` (`IceoryxError`), `:~421` (`IceoryxProducerError`), plus `lease.rs` / `arena.rs` / `lifecycle.rs` equivalents.
- **Common core:** `impl fmt::Debug for X { fn fmt(&self, f) -> fmt::Result { fmt::Display::fmt(self, f) } }` — 5 LOC, byte-identical modulo the type name. Also the `Debug` redaction shims: `TransportDescriptor` (`descriptor.rs:~215`), `ValidatedFrame` (`descriptor.rs:~491`), `SpanPlan` (`arena.rs:~175`), `Mapping` (`ring.rs:295`), `RuntimeDir` (`ring.rs:384`), `RingGrant` (`ring.rs:490`), `RingAttachment` (`ring.rs:518`), `Ring` (`ring.rs:1247`), `ProducerReservation` (`ring.rs:1391`), `DuplexRing` (`ring.rs:1429`) — 10 more `formatter.write_str("X(<redacted>)")` blocks.
- **Clone type:** exact (parameterised only by type name).
- **Fix:** two small local macros — `impl_debug_via_display!(ProducerError, RingError, …)` and `impl_debug_redacted!(Ring, "Ring")`.
- **Sensitivity:** mc-shm-transport (epic `magic-context-ymc`, last commit 2026-08-26) → T2 minimum. **Impact note:** the redaction shims are a *confidentiality* control — they exist so a `Debug`-logged descriptor cannot leak shared-memory offsets or grant material. A macro must not accidentally derive a real `Debug` for any of them. Prefer `impl_debug_redacted!` over `#[derive]`-anything, and keep a test asserting `format!("{:?}", …).contains("<redacted>")` for each type (the pattern already exists — `connection_file.rs:479 debug_redacts_key`).
- **Est. net LOC:** −55 (8 × 5 + 10 × ~3, minus ~15 of macro).
- **Lane:** structural.

#### F13b — dead `hardware_matches` in mc-shm-transport
- **Location:** `crates/mc-shm-transport/src/descriptor.rs:210`, 5 LOC. Zero references workspace-wide (verified against all Rust in `crates/` and all TS in `packages/`).
- **Sensitivity:** the hardware-profile identity is part of the transport admission gate; the underlying `self.hardware.matches(expected)` is presumably still used elsewhere. Confirm before removing whether this accessor is a precursor to the hardware-envelope gate work — `benches/hardware_envelope.rs` exists and `magic-context-ymc.12` is the retained-provider bead. **T2, and verify against epic ymc first.** If it is a precursor, mark it TRACKED and leave it.
- **Est. net LOC:** −5.

---

### T3

#### D1 — `mc-store/src/lib.rs` is 20,650 LOC in one file; identify the seams
This is the file the whole audit keeps landing in: **203 of the last 300 commits** on its own path, 415 SQL statements, 429 `prepare`/`execute`/`query_row`/`query_map` calls, ~200 `pub` types, and two `impl McStore` blocks — `lib.rs:4810-13159` (**8,350 LOC**) and `lib.rs:13160-13931` (770 LOC) — plus 5,700 LOC of inline tests in three modules (`tests` at `:13932`, `shadow_tests` at `:19421`, `lineage_descent_tests` at `:19981`, 101 `#[test]` fns, 102 `TempDir` constructions).

The seams are already visible in the table vocabulary — these are cohesive families, not an arbitrary split:

| Candidate module | Tables (occurrence count) | Existing anchors |
| --- | --- | --- |
| `notes` | `mc_notes` (71), `mc_note_deliveries` (10), `mc_note_writer_v` (7), `mc_note_caller_project` (6) | `NOTE_SELECT_COLUMNS`, `NOTE_INSERT_COLUMNS`, `NOTE_CAS_UPDATE_SQL`, `load_note_tx`, `with_note_conn_fenced`, `FacadeMutationTxn` (F1) |
| `note_eval` | `mc_note_eval_claims` (20), `mc_note_eval_acquisitions` (8) | `NOTE_EVAL_CLAIM_COLUMNS`, `NOTE_EVAL_CANDIDATE_COLUMNS`, `collect_note_eval_ledgers_tx`, the whole second `impl McStore` at `:13160` is already almost exclusively this |
| `cache_state` / `transform` | `mc_cache_state` (45), `mc_overlay_frontiers` (12), `mc_transform_session_roots` (7) | `TransformCommit`, `commit_transform`, F8c |
| `compartments` / `lineage` | `mc_compartments` (40), `mc_compartment_events` (7) | F2, F8a, `stored_compartment_from_row` |
| `pass_trace` / `scheduler` | `mc_pass_trace` (36) | `PassSchedulerObservation`, `serialize_scheduler_observation` |
| `tags` | `mc_tags` (31), `mc_tag_cache_generations` (6) | `mint_or_get_tags`, `seed_tags_for_test` |
| `authority` | `mc_authority` (27), `mc_authority_route_bindings` (10), `mc_authority_seed_rows` (4) | `AuthorityTransitionError`, `authority_drain_step`, `authority_finish_drain` |
| `claim_intents` | `mc_claim_intents` (12), `mc_claim_intent_controls` (4) | `CLAIM_INTENT_COLUMNS`, `claim_intent_record_from_row`, and `claim_mirror.rs` is *already* a separate module |
| `historian` | `mc_historian_side_channel_outbox` (13), `mc_primer_candidates` (9), `mc_user_memory_candidates` (7) | `HistorianPublishError`, `HistorianDurableState` |
| `schema` (DDL) | `CREATE TABLE`/`CREATE TRIGGER` text, `lib.rs:~430-1350` | F8d, `recorded_mc_cache_version`, `refuse_pre_cutover_store` |

- **Observations that make the split cheap:** `claim_mirror.rs` (1,152 LOC) and `sqlite_runtime.rs` (185 LOC) prove the crate already tolerates submodules. The `*_tx(tx, …)` free-function idiom (`load_note_tx`, `fence_active_note_claims_tx`, `mark_note_eval_claim_terminal_tx`, `normalize_authority_note_route_tx`, `collect_note_eval_ledgers_tx`) means most SQL is *already* expressed as transaction-scoped free functions that do not need `&self` — those move with zero signature change. The `with_conn` / `with_conn_fenced` / `with_note_conn_fenced` (`lib.rs:5323`) wrappers are the only `&self` coupling most methods have.
- **Observations that make it risky:** the three inline test modules use `use super::*` and reach private items freely; splitting requires either moving tests alongside their module or widening `pub(crate)`. And `mc-store` is mid-cutover under epic `magic-context-3q5` (U7–U30, ~30 open sub-beads, including `magic-context-3q5.28` *"U27: Storage actor in mc-store"* which will restructure this crate anyway).
- **Recommendation:** **do not do a general split now.** Extract exactly two modules, both of which the current work already wants:
  1. `notes` — because it is the largest family, it owns the F1 divergence, and `magic-context-3q5.8`/`.9`/`.10` are about to rewrite it. Extracting it is the natural container for the F1 fix.
  2. `schema` (the DDL `&str`s) — because F8d needs one column list and the DDL is otherwise interleaved with runtime code.

  Defer the other eight to `magic-context-3q5.28`, and note the seam list on that bead so it is not rediscovered.
- **Est. net LOC:** ~−60 (mostly from F1/F8d landing inside it); the value is reviewability, not deletion.
- **Lane:** structural.

#### D2 — `generation.rs` and `harness_closure.rs` are two implementations of one content-addressed store
- **Members:** `crates/mc-host/src/generation.rs` (2,114 LOC) and `crates/mc-host/src/harness_closure.rs` (1,120 LOC).
- **Common core:** both are "immutable, content-addressed, digest-named store under a hardened directory". Both implement: canonical JSON manifest committing per-file `{path, mode, size, sha256}`; staged temp directory with a `.tmp-`/`.tmp` prefix; atomic install by rename/exchange; digest verification on read; a prune/GC sweep; hardened `O_NOFOLLOW` opens with mode validation; recursive tree removal.
- **Evidence — same-named private helpers in both files** (found by cross-indexing every non-test `fn` name per crate):
  `hex`, `owner_uid`, `mode_bits`, `digest`, `path`, `open`, `manifest`, `validate`, `validate_manifest`, `invalid`, `prune`, `remove_tree`, `write_new_file`.
- **Verified near-miss pairs:**
  - `remove_tree`: `generation.rs:1354` vs `harness_closure.rs:1003`. Identical recursive algorithm — `unlinkat`, treat `NOENT` as success, treat `ISDIR`/`PERM` as "it's a directory" (both carry the same Linux-`EPERM`-on-directory workaround), open the child dir, recurse over names, `unlinkat(REMOVEDIR)`. Differences: error type and message text only.
  - `read_dir_names` (`generation.rs:1382`) vs `list_names` (`harness_closure.rs:926`): same `Dir::read_from` enumeration, same `.`/`..` drop, same UTF-8 validation. `harness_closure`'s returns a `BTreeSet` and rejects duplicates; `generation`'s returns a `Vec`.
  - `write_new_file`: `generation.rs:1175` vs `harness_closure.rs:967`. Same `CREATE|EXCL|WRONLY|NOFOLLOW|CLOEXEC` open, same `fchmod`-after-create, same write + `fsync`. **Divergence worth noting:** `generation.rs` classifies `NOSPC`/`DQUOT` into a typed `GenerationError::InsufficientStorage` (and checks `is_storage_exhausted` on the write too); `harness_closure.rs` collapses both to a generic `invalid("closure metadata file creation failed")`. So harness-closure staging under a full disk reports a corruption-shaped error rather than a storage-shaped one.
  - `read_bounded` (`harness_closure.rs:953`) vs `instance::read_all_fd` (`instance.rs:852`): same "read up to cap, fail if over" with the same `cap + 1` trick.
- **Priority signals:** **weak co-change** — over the last 400 commits touching `generation.rs`, only **2** also touch `harness_closure.rs`. `generation.rs` has 12 commits and `harness_closure.rs` 3 in the last-300 window over these paths. That cuts both ways: they have not been fixed in lockstep, which is why the `write_new_file` ENOSPC handling already differs.
- **Recommendation:** **do not merge the two stores.** Their manifests, schemas, and lifecycles are genuinely different (`magic-context.mc-host-harness-closure/v1` vs generation manifests, and generations participate in the lifecycle-root protocol while closures do not). Instead extract the **leaf filesystem layer** into one place — `instance.rs` is already that place and `generation.rs` already imports from it (`generation.rs:27-31`). Move `remove_tree`, directory enumeration, `write_new_file`, and `read_bounded` there as `pub(crate)` generics over an error mapper, or accept a small amount of error-type duplication and share only the byte mechanics. Fold the ENOSPC classification into the shared version so `harness_closure` inherits it.
- **Est. net LOC:** −60 for the leaf helpers (F3 is the T0 slice: `hex`, `mode_bits`, `owner_uid`, the `S_IF*` consts, and `verify_safe_ancestor`).
- **Lane:** structural.

#### D3 — `mc-shm-transport`: two backends with parallel surfaces and no shared trait
- **Members:** `crates/mc-shm-transport/src/backend/ring.rs` (1,800 LOC) and `crates/mc-shm-transport/src/backend/iceoryx.rs` (443 LOC, `#[cfg(feature = "iceoryx")]`).
- **Evidence:** identical method vocabulary on both sides — `try_reserve` (`iceoryx.rs:121` / `ring.rs:662`), `try_receive` (`:150` / `:764`), `write` (`:226` / `:1338`), `commit` (`:247` / `:1352`), `capacity` (`:211` / `:1276`), `remaining` (`:221` / `:1286`), `written` (`:216` / `:1281`), `segment` (`:344` / `:1296`), `segment_count` (`:339` / `:1291`), `release` (`:349` / `:847`), `identity`, `is_empty`, `len`. Plus twinned error enums (`IceoryxError`/`RingError`, `IceoryxProducerError`/`ProducerError`) with overlapping variants (`Quarantined`, `SequenceExhausted`).
- **What is missing:** `backend/mod.rs` is 9 lines — it declares the three modules and nothing else. There is no trait, so nothing structurally forces the two backends to agree, and `mc-host/src/shm_provider.rs` presumably selects between them by `cfg`.
- **Recommendation:** **do not unify yet.** mc-shm-transport's last commit is 2026-08-26 (three days before this audit) and the recent history is entirely failure-hardening and release-gate work (`643225b6`, `073258b2`, `a9da6cd4`, `f5146283`). Epic `magic-context-ymc` is active and `magic-context-ymc.12` (retained-provider work) will change the ownership model. Introducing a backend trait now would freeze a contract that is still moving, and the `iceoryx` backend is feature-gated and not on the default path. Record the parallel-surface observation on epic `ymc` so the trait is designed *once*, when the retained-provider semantics settle — not retrofitted twice.
- **Est. net LOC:** 0 now.

---

## TRACKED

Do not remove or restructure. Each is a precursor to, or is owned by, an open bead.

| Item | Bead | Note |
| --- | --- | --- |
| The `O_NOFOLLOW` component-walk family — `instance.rs:465` `secure_runtime_dir`, `lifecycle.rs:675` `open_validated_dir` | **magic-context-nll** | Do not remove — precursor to `magic-context-nll`. This audit adds three further members (`instance.rs:414`, `connection_file.rs:252`, `harness_closure.rs:1034`) and one predicate duplicate (`harness_closure.rs:1085` `verify_safe_ancestor` ≡ `instance.rs:774` `is_safe_ancestor`); see F4. Add them to the bead rather than filing new work. |
| `wire.rs:384-507` — `ByteBudget`, `ByteCharge`, `charge`, `try_charge`, `ByteCharge::none` | **magic-context-kp5** | Do not remove — precursor to `magic-context-kp5` (*"give outgoing-frame byte accounting one owner in wire.rs"*). F6 (header construction) touches the same three `encode_*` functions; sequence F6 after kp5. |
| `lifecycle.rs:216` `LifecycleTransactionLock::acquire` and the transaction-lock path | **magic-context-89q** | Do not remove — precursor to `magic-context-89q` (*anchor lifecycle transaction lock to the evidence namespace*). `NamespaceAnchor` (`lifecycle.rs:~600-670`) and its `verify` are part of that surface. |
| `mc-core/Cargo.toml:13-17` — `default = ["cache-core"]`, `cache-core = ["dep:cortexkit-cache-core"]`, and the `#[cfg(feature = "cache-core")]` re-export at `mc-core/src/lib.rs:14` | **magic-context-8vi** | Do not remove — `magic-context-8vi` (*decide mc-core cache-core feature: collapse or keep with CI check*) owns this decision. The feature is on by default and gates only a `pub use` of 6 `cortexkit_cache_core` types; nothing in the workspace builds with it off, so it is currently untested. Flagging only: the decision is the bead's. |
| `mc-core/src/claim_operation.rs:197` `format_revision_locator`, `:238` `ClaimMutationToken`, `:248` `token_value`, `:260` `canonical_claim_mutation_token`, `:264` `compute_claim_mutation_token_digest`, `:272` `compute_applicability_heads_digest`, `:287` `PolicyHeadCounts`, `:296` `compute_policy_heads_digest` | **magic-context-3q5** (U7–U10), **magic-context-cjs** | **Would otherwise read as dead code.** Each is referenced exactly twice: its definition, and one assertion in `mc-core`'s own `#[cfg(test)] mod tests`. They are *not* dead — they are the Rust half of a cross-language digest contract pinned against the shared TS golden fixture `packages/plugin/src/features/magic-context/memory/fixtures/claim-operation-contract-v1.json` (`claim_operation.rs:676`), asserted by `mutation_tokens_match_fixture` (`:789`) and `applicability_and_policy_head_digests_match_fixture` (`:803`). They exist so the Rust port provably matches TS *before* the claims cutover routes traffic through it. Do not remove. |
| `recordDispositionEventInCurrentTransaction` | **magic-context-cjs** | Out of audit scope — it lives in `packages/plugin/src/features/magic-context/memory/storage-claim-policy.ts:212`, not in Rust. Checked: no Rust analogue exists, so nothing in this report touches it. Noted so the guard is visibly satisfied. |

---

## Do not unify yet

| Item | Reason |
| --- | --- |
| `tests/support/raw_client.rs:19-49` re-declaring `HEADER_LEN = 21`, `WIRE_VERSION = 2`, `TY_REQUEST`…`TY_GOODBYE`, `FLAGS_*`, `SERVER_DOMAIN`, `CLIENT_DOMAIN` — shadowing `mc_host::wire::{HEADER_LEN, PROTOCOL_VERSION, FrameType, Flags}` | **Correct by design, and documented.** `raw_client.rs:1-7`: *"This oracle deliberately re-implements framing, header layout, and proof computation from the literal values in `docs/mc-host-wire-protocol.md`. It must never call `mc-host`'s encoders or proof helpers: expected bytes produced by the code under test prove only self-consistency (protocol §14.1)."* Unifying these would destroy the independence that makes `tests/protocol_vectors.rs` meaningful. Recorded here so a future audit does not "fix" it. Note the benches already share it correctly via `#[path = "../tests/support/raw_client.rs"]` (`benches/ipc_budget.rs:18`) — the sharing that *should* happen already does. |
| `mc-store/src/lib.rs:13168` `acquire_note_evaluation` forwarding to `:13191` `acquire_note_evaluation_with_cap` (22 LOC of pure forwarding, 8th param) | Reads like flag-plumbing, but `_with_cap` is called with a non-default `ledger_cap` by 7 tests (`lib.rs:18887, 19282, 19297, 19313, 19331, 19348, 19367`). It is a legitimate dependency-injection seam for a bound that is otherwise impossible to exercise (`NOTE_EVAL_LEDGER_CAP = 10_000`). Leave it. |
| `arena.rs:204` `ArenaCounts::conserves` vs `descriptor.rs:518` `DescriptorCounts::conserves` | Same `try_fold(0u64, u64::checked_add) == Some(total)` shape over a field array, but the field sets are deliberately different (8 vs 7 — `pad` exists only for bytes, not descriptor slots). A shared `conserves_exactly(&[u64], total)` saves ~8 LOC while making each conservation invariant's field list less locally auditable. Both are load-bearing byte/slot conservation proofs in a sensitive crate. Not worth it. |
| `arena.rs:150-170` `SpanPlan::{allocation_start, allocation_len, span_count, span}` vs `descriptor.rs:471-489` `ValidatedFrame::{…}` | `ValidatedFrame` is the deliberate post-validation twin of `SpanPlan`; the parallel accessor sets are the point (an unvalidated plan and a validated frame must not be interchangeable). Sensitive crate, active epic. |
| `backend/ring.rs` ↔ `backend/iceoryx.rs` parallel method surface with no trait | D3 — mc-shm-transport last touched 2026-08-26, epic `magic-context-ymc` active, `iceoryx` feature-gated and off the default path. Design the trait once when retained-provider semantics settle. |
| `mc-core/src/claim_operation.rs:379-405` `ClaimIntentState::{as_str, parse}` and `:490-508` `ClaimResultOutcome::{as_str, parse}` | Two parallel string-enum codecs, ~40 LOC total. A macro would save ~15 LOC and obscure the wire vocabulary these pin against the shared TS fixture. Both are contract surfaces; explicitness wins. |
| `generation.rs` ↔ `harness_closure.rs` as *stores* (as opposed to their leaf filesystem helpers) | D2 — different manifests, different schemas, different lifecycles, and only 2 co-changing commits in 400. Share the byte mechanics (F3, D2), not the stores. |

---

## Dead code

Method: extracted all 599 `pub fn` and all `pub struct`/`enum`/`trait`/`const`/`type` declarations outside `#[cfg(test)]` across the five crates, then counted every occurrence of each identifier across **all** Rust in `crates/` (including tests, benches, examples, fuzz targets, and `mc-module`) **and** all TypeScript in `packages/`. Count == 1 means definition-only.

Exposure check: mc-host and mc-store are path dependencies. Their only Rust consumer is `mc-module`, which builds the `ck-mc-host` binary (`mc-module/Cargo.toml:20-22`) that `packages/cli` and `packages/plugin` invoke over the wire. There is no external crate consumer, so zero in-workspace references means unreachable — with the one exception documented under TRACKED (mc-core's fixture-pinned contract surface, which is referenced by its own tests and is a deliberate precursor).

**Confirmed dead, safe to delete:**

| Location | Item | LOC | Notes |
| --- | --- | --- | --- |
| `crates/mc-store/src/lib.rs:8051` | `pub fn load_compartments_after` | 46 | `CompartmentPage` survives (still built at `lib.rs:5733`). Removes one of F8a's 5 column-list copies for free. |
| `crates/mc-host/src/broca/mod.rs:114` | `pub fn route_index` | 8 | Doc claims tests clone it; no test does. Delete the fn and the stale doc together (C5). |
| `crates/mc-host/src/frame_channel.rs:283` | `pub fn ProducedBody::into_charge` | 7 | |

**Dead but check a bead first:**

| Location | Item | LOC | Check |
| --- | --- | --- | --- |
| `crates/mc-store/src/lib.rs:10991` | `pub fn seed_workspace_member` | 26 | `magic-context-6bd` (workspace member prune protocol for the native memory mirror) and `magic-context-a7v` (prune policy-hidden foreign workspace rows). If either writes members from Rust, this is a precursor → TRACKED, not dead. |
| `crates/mc-shm-transport/src/descriptor.rs:210` | `pub fn hardware_matches` | 5 | Epic `magic-context-ymc` / `ymc.12`. Sensitive crate → T2 (F13b). |

**`#[allow(dead_code)]` inventory** (3 in scope, all defensible):

| Location | Verdict |
| --- | --- |
| `crates/mc-host/src/frame_channel.rs:32` (on `ReadClose`) | Legitimate — `ReadClose` variants are constructed by `tcp_frame_channel.rs` and the shm path but not all are matched in every build configuration. Would become unnecessary if `into_charge` is removed and the enum tightened; low priority. |
| `crates/mc-host/tests/perf_budget_runner.rs:27` | Test harness with per-binary unused helpers — standard for `#[path]`-shared test support. |
| `crates/mc-host/examples/synapse_perf.rs:10` | Same, in an example. |

**Stale `cfg`/feature branches:** only two feature gates exist in scope — `cache-core` in mc-core (TRACKED, `magic-context-8vi`) and `iceoryx` in mc-shm-transport (live, epic `ymc`). `test-support` in mc-store is consumed by `mc-module`. No stale gates found. No `TODO`/`FIXME`/`XXX`/`HACK` markers in any `src/` file in scope (the single `rg` hit, `control.rs:131`, is the literal string `\uXXXX` in a JSON-escape doc comment).

---

## Test findings

I own in-crate `#[cfg(test)]` findings for these crates.

### T-1 (T1) — five copies of the mc-store store/descriptor fixture
Same as **F10**. `crates/mc-store/src/lib.rs:13937`, `:19426`, `:19986`, `crates/mc-store/tests/claim_mirror.rs:20`, `crates/mc-store/tests/claim_intent_ledger.rs:18`. Copy-pasted setup wanting one helper; the `test-support` feature and the `*_for_test` naming convention already exist (`lib.rs:6653, 6663`). −45 LOC.

### T-2 (T1) — `TransformCommit` 20-field literal copy-pasted 10 times
Same as **F11**. `crates/mc-store/src/lib.rs:13977, 14220, 14299, 14375, 14514, 14600, 14731, 15230, 15295, 15970`. Two 14-line windows are byte-identical across 4 of the sites (`:14518 ≡ :14604 ≡ :15234 ≡ :15299`). Wants a 3-arg `base_commit(expected, core, meta)` helper so each test shows only the fields it actually exercises — right now the signal is buried in 18 lines of `None`/`&[]`/`false`. −105 LOC, and a real readability gain: today you cannot tell from the literal which field a given test is about.

### T-3 (T0) — borderline tautological: constants asserted against their own literals
- `crates/mc-host/src/wire.rs:672` `canonical_env_names_are_pinned` — asserts `SUBC_MODULE_ID_ENV == "SUBC_MODULE_ID"` and `SUBC_LAUNCH_NONCE_ENV == "SUBC_LAUNCH_NONCE"`, where both consts are defined 640 lines above in the same file (`wire.rs:40, 44`).
- `crates/mc-host/src/client.rs:4223` `outcome_spellings_are_exact` — asserts `SendOutcome::NotSent.as_str() == "not_sent"` etc.

**Verdict: keep both, but know what they are.** These are protocol-vocabulary freezes, and a freeze test that lives next to the thing it freezes is the weakest possible form: it catches nothing an in-file rename would not also update. The stronger version already exists elsewhere in this repo — `mc-core/src/claim_operation.rs:684` `vocabulary_matches_fixture` asserts the Rust constants against the **shared TS golden fixture**, so a drift between the two languages fails. If the wire vocabulary matters across the Rust/TS boundary (it does — `SUBC_MODULE_ID_ENV` is injected by the host and read by module-side code), these two tests should assert against `docs/mc-host-wire-protocol.md`'s vector fixture, the way `tests/protocol_vectors.rs` does. Either upgrade them or accept them as documentation. Do not delete without the upgrade. No LOC claimed.

### T-4 (T0) — subsumed pair in `connection.rs`
- `crates/mc-host/src/connection.rs:1599` `shutdown_fence_queues_started_catalog_before_goodbye` — body is exactly `assert_started_producer_precedes_goodbye(FencedProducer::Catalog).await;`
- `crates/mc-host/src/connection.rs:1604` `shutdown_fence_queues_started_capacity_rejection_before_goodbye` — exactly `assert_started_producer_precedes_goodbye(FencedProducer::CapacityRejection).await;`

**Verdict: not subsumed — keep both.** They exercise distinct `FencedProducer` variants and the shared assertion helper is already extracted. This is what a well-factored parameterized pair looks like; two `rstest` cases would be equivalent, not better. Listed to close the question. No LOC claimed.

### T-5 (T1) — three inline test modules in one 20k file, all using `use super::*`
`tests` (`lib.rs:13932-19420`, ~5,490 LOC), `shadow_tests` (`:19421-19980`), `lineage_descent_tests` (`:19981-20650`). 101 `#[test]`s, 102 `TempDir::new` calls. The three modules each rebuild their own fixtures (T-1) and each reach into private items via `use super::*`, which is the main mechanical obstacle to D1's module split. Consolidating the fixtures (T-1) is a prerequisite for the split and should land first.

### Coverage gap worth noting
`crates/mc-store/src/lib.rs:4392-4608` — the entire `FacadeMutationTxn` impl (F1) has no test that pairs its behaviour against the `McStore` twin. That absence is why the `update_note_cas` divergence went unnoticed. Whatever shape the F1 fix takes, it needs one test that drives the same "re-supply an unchanged `surface_condition`" request down both paths and asserts the same outcome. Cross-reference bead `magic-context-mwx` (*add workspace Rust test coverage to CI*).

---

## Comment violations

Per AGENTS.md: comments must not carry task/bead IDs, must not use roadmap tense, and must stand alone without the tracker.

| # | Location | Text | Violation |
| --- | --- | --- | --- |
| C1 | `crates/mc-host/src/runtime.rs:4` | `//! CancellationToken; future production wiring in magic-context-c50.4` | Bead ID + future tense. Rewrite to describe what `runtime.rs` *is* today (a cancellation-driven serve loop), and drop the forward reference — the bead already tracks the wiring. |
| C2 | `crates/mc-host/src/handler.rs:3` | `//! magic-context-c50.4 will adapt McHandler onto this boundary. It is …` | Bead ID + "will". Describe the boundary's contract; delete the sentence. |
| C3 | `crates/mc-host/src/config.rs:6` | `//! (magic-context-c50.8), not this crate.` | Bead ID. The *statement* ("config resolution belongs to the binary, not this crate") is worth keeping; the ID is not. |
| C4 | `crates/mc-host/src/config.rs:237` | `/// answer Ping (magic-context-c50.4); enabling it before then would kill …` | Bead ID + "before then" (temporal). The mechanism ("enabling this before the handler answers Ping would kill healthy connections") stands alone once the ID and "before then" go. |
| C5 | `crates/mc-host/src/broca/mod.rs:113` | `/// Shared route-map handle for teachdown observation, cloned before the component moves into its composite like [BrocaComponent::supervisor]; metrics carry no route-mapping count. commentlint: allow(JUDGE)` | **Factually wrong** — no test or caller clones it (the fn is dead, F12). Delete with the fn. Note it carries a `commentlint: allow(JUDGE)` escape hatch, which is how an untrue claim survived lint. |

**Not violations** (checked and cleared, so a future pass does not churn them):
- The ~25 `//! … (plan R6)` / `(plan U1)` / `protocol §4.1` references across `lifecycle.rs`, `instance.rs`, `transport_provider.rs`, `provider_recovery.rs`, `broca/backend.rs`. `protocol §` cites `docs/mc-host-wire-protocol.md`, a committed stable spec — that is a legitimate standalone reference. `(plan R…)`/`(plan U…)` cite `docs/plans/`; also committed, also in-repo, so a reader with no tracker access can follow them. They are spec citations, not timeline tracking.
- The ~25 `currently` / `not yet` hits from the temporal scan (e.g. `routing.rs:342` *"Routes currently owned by one generation"*, `synapse/jobs.rs:213` *"Charges detached from the table but not yet released"*). These describe **runtime state**, not project state — present-tense descriptions of what a value means at a moment in execution. Correct as written.
- `crates/mc-host/tests/shm_soak.rs:5`, `tests/support/shm_process.rs:4`, `tests/shm_failure_modes.rs:148` reference `magic-context-ymc.12` — these are *test* files pinning a frozen manifest and an explicitly deferred known gap, and `shm_failure_modes.rs:148` carries `commentlint: allow(JUDGE)` with a precise justification (*"real reclamation must fail these exact-value assertions and force this claim to be updated"*). That is a deliberate tripwire tied to an open bead, in test code, not a tracking comment in production source. Leave them.

---

## Suggested execution order

Ordered by (risk × blast radius) ascending, with dependencies respected.

1. **F3a–F3d** (T0, mc-host leaf helpers) — `hex`, `mode_bits`, `owner_uid`, `S_IF*` consts, then `harness_closure::verify_safe_ancestor` → `instance::is_safe_ancestor`. Follows the convention `generation.rs` already uses. −25 LOC. Also the T0 slice of F4/D2, so it de-risks both.
2. **F12** (T0, dead code) — 3 confirmed items, −61 LOC; hold the 2 bead-check items.
3. **C1–C5** (T0, comments) — 5 edits.
4. **F2a+F2b** (T1, mc-store lineage tail) — one function, one file. −70 LOC.
5. **F10 / T-1** then **F11 / T-2** (T1, mc-store test fixtures) — −150 LOC, and a prerequisite for D1.
6. **F5** (T1, `generation.rs` walk pair) — −18 LOC, with the `NONBLOCK` review gate.
7. **F7** (T1, client-side `frame_read` wrappers only) — −22 LOC.
8. **F8a–F8d** (T1, mc-store SQL consolidation) — −58 LOC; F8d needs the migration-lane check.
9. **F1** (T2) — the divergence decision first, then the `*_tx` extraction. −170 LOC. Fold into `magic-context-3q5.8`.
10. **D1** (T3) — extract `notes` and `schema` only, after step 9. Record the remaining seams on `magic-context-3q5.28`.
11. **F9** (T2, `thiserror`) — dependency decision, then crate-by-crate starting with mc-store. −570 LOC.
12. **F6** (T2, wire header) — after `magic-context-kp5`, or as part of it.
13. **F13a** (T2, mc-shm-transport `Debug` macros) — after epic `ymc` quiesces, with the redaction tests as the gate.

Not scheduled: **F4** (belongs to `magic-context-nll` — extend that bead), **D2** stores (share leaves only), **D3** (defer to epic `ymc`).
