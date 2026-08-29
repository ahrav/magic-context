# Documentation-debt audit — Markdown corpus

Repo: `/local/home/ahrav/scratch/magic-context` @ `9c1eb4d1` (merge of PR #85, `remove-tauri-dashboard`)
Date: 2026-08-29. Read-only audit. No files were modified; no `git stash` was used.

## Scope actually found

**111 tracked `*.md` files** outside `node_modules/` and `target/`, totalling **1,366,978 B (1335 KB)**.
The brief said 122; the delta is explained below and is not missing evidence:

- `docs/plans/` is **gitignored** (`.gitignore:112`). Ten plan docs exist on disk (395 KB, incl.
  `2026-08-24-1500-feat-iceoryx2-shared-memory-transport-plan.md` and
  `2026-08-29-0736-refactor-remove-tauri-dashboard-plan.md`) but **none are tracked**, so none are
  deletion candidates. `docs/fork-hardening-audit.md` is gitignored the same way.
- `autoresearch-results.tsv` is **untracked** (`git ls-files --error-unmatch` fails).
- Only one untracked non-ignored file exists repo-wide: this audit's own `.beads-guard.txt`.

## Summary table

| Class | Files | Bytes | KB | Notes |
|---|---:|---:|---:|---|
| **DELETE** (tracked) | 6 | 1,980 | 1.9 | `mutations/fm-oc-{1..6}.md` boilerplate stubs |
| **DELETE** (untracked stray) | 1 | 806 | 0.8 | `autoresearch-results.tsv` |
| **CONSOLIDATE** (absorbed) | 4 | 19,527 | 19.1 | into 3 surviving canonicals |
| **MOVE** (not delete) | 1 | 10,394 | 10.2 | root spike plan → `docs/` — TRACKED(c50.1) |
| **STALE-CONTENT** (keep + fix) | 7 | 170,099 | 166.1 | counted inside KEEP |
| **KEEP** | 100 | 1,345,471 | 1313.9 | incl. the 7 STALE-CONTENT files |
| *Total tracked md* | *111* | *1,366,978* | *1335.0* | |

Recoverable now: **22.6 KB** hard (delete) + **19.1 KB** by consolidation = **41.7 KB**, ~3.1 % of the
corpus. The corpus is not bloated by dead files; its real debt is **166 KB of load-bearing docs that
contradict the tree**, concentrated in `STRUCTURE.md` and `ARCHITECTURE.md`.

Largest subtrees for context: `piolium/` 277.7 KB (11 md), `packages/docs/src/**` 146.0 KB (19 md),
`docs/perf/**` 86.4 KB (8 md).

---

## DELETE list

### D1. `packages/e2e-tests/mutations/fm-oc-1.md` … `fm-oc-6.md` (6 files, 1,980 B)

Last touched 2026-08-07. **Inbound refs = 0** (proof: `rg -n 'fm-oc-1\.md'` over the repo excluding
`node_modules` returns nothing; the only `mutations/*.md` string anywhere in code is
`thinking-block-adjudication.md`).

Evidence it is safe:

1. **The loader cannot read them.** `packages/e2e-tests/src/incident-pool/evidence.ts:169-171`:
   ```ts
   const mutationsDir = resolve(e2eRoot, "mutations");
   const files = readdirSync(mutationsDir)
       .filter((name) => name.endsWith(".json"))
   ```
   The mutation-evidence view is `.json`-only. These six `.md` files are never parsed, digested, or
   asserted on.
2. **Not digest-pinned.** `packages/e2e-tests/incidents/source-inventory.json` pins exactly five
   `.md` source paths — `AUDITOR.md`, `docs/AUDIT-KNOWN-ISSUES.md`,
   `packages/e2e-tests/incidents/pi-todo-provenance.md`,
   `packages/e2e-tests/mutations/thinking-block-adjudication.md`,
   `packages/e2e-tests/parity-findings-s2.md`. The `fm-oc-*` entries it pins are `fm-oc-N.**json**`.
3. **The convention was abandoned.** `mutations/` holds 20 `.json` records; only `fm-oc-1..6` have a
   `.md` sibling. `fm-pi-1`, `fm-pi-4`, `goldens-dg-1..3`, `rust-ctx-reduce-roundtrip`,
   `rust-historian-producer`, and `shm-hardening-u1..u7` have none.
4. **Zero unique content.** All six are byte-identical templates differing only in one digit, and each
   says so itself: *"The canonical applied-diff, captured test output, exit status, and reverted green
   rerun are in `fm-oc-N.json`."*

No open bead references them (`fm-oc` appears in no bead in the 107-issue guard set).
Related landed commit: the records were produced by `scripts/run-rust-fm-mutation.ts`, which still
exists and still writes the `.json`.

### D2. `autoresearch-results.tsv` (untracked, root, 806 B)

**Inbound refs = 0** (`rg -n 'autoresearch'` repo-wide returns nothing).

Evidence it is safe: it is a 7-row ledger of SQLite perf experiments, and **every row's commit is
already merged**, verified individually:

| Row | Commit | Landed |
|---|---|---|
| 1 | `20184d11` | 2026-08-22 `experiment(mc-store): v53 index mc_memories(project_path, updated_at DESC, id ASC)` |
| 2 | `d0fdf3df` | 2026-08-22 `experiment(mc-store): v54 index mc_primer_candidates(session_id, id)` |
| 3 | `da97e321` | 2026-08-22 `experiment(mc-store): prepared-statement cache for hot per-pass statements` |
| 4 | `18c1fbff` | 2026-08-22 `experiment(mc-store): v55 partial render-order index on visible statuses` |
| 5 | `c32bc245` | 2026-08-22 `experiment(plugin): reuse one non-blocking telemetry connection per DB path` |
| 6 | `4e35348f` | 2026-08-22 `experiment(plugin): min-evict retention prune for transform_decisions` |
| 7 | `faad45dd` | 2026-08-22 `experiment(plugin): cache the session_meta hot-read statement per connection` |

All rows are `status=keep`. The file is a tool scratch ledger whose content is reconstructable with
`git log --grep '^experiment('`. It is untracked, so removal is a local `rm`, not a commit.

**No other orphaned non-md artifact exists at repo root.** The remaining non-md root files are all
load-bearing: `.gitattributes`, `.gitignore`, `Cargo.lock`, `Cargo.toml`, `LICENSE`, `bun.lock`,
`bunfig.toml`, `package.json`.

### Explicitly NOT deleted (brief's hypotheses, refuted)

- **`docs/perf/synapse-tail-run-*.md` are not stale duplicates of a newer run.** They are the
  *landing summaries* for the *full* reports in `docs/perf/runs/<epoch>/report.md`; both are
  deliberately tracked. `.gitignore:117-121` states the frozen contract requires `docs/perf/` to
  retain the run report, manifest, environment and hashes, and only ignores `docs/perf/runs/*/*/`
  bulk sample subdirs. Three epochs coexist by design, not by accident: `6e5ffc03` (pilot,
  INCOMPLETE), `af8ef126` (INCONCLUSIVE), `881be45b` (provisional `a+c` K=1). `881be45b`'s own text
  says *"Prior epochs 6e5ffc03 (pilot) and af8ef126 (inconclusive) untouched"* and
  `runs/synapse-tail-881be45b/manifest.json:7-8` links both as retained context. Downgraded to
  CONSOLIDATE. TRACKED(ll1, bux).
- **`piolium/` is not deletable and, contrary to the guard note, is not digest-pinned.** `rg -c
  'piolium' packages/e2e-tests/incidents/source-inventory.json` → no match; no `sha256:` literal
  appears anywhere in `piolium/`. The pins the guard means are on `AUDITOR.md` and
  `docs/AUDIT-KNOWN-ISSUES.md`, and `evidence.ts:430-454` computes those digests **live from file
  bytes** rather than comparing stored literals. `piolium/` is nonetheless KEEP: its sole Medium
  finding M1 is the open P1 bug `magic-context-c7t`, and M1's code citation is still accurate
  (`packages/plugin/src/config/project-security.ts:397-410` is the live `HIDDEN_AGENT_KEYS` ×
  `AGENT_ESCALATION_FIELDS` strip loop). TRACKED(c7t).
- **`CHANGELOG.md` is not abandoned mid-history.** It is a deliberate 314-B redirect to Git history +
  GitHub Releases + upstream releases, established by `be500459 chore: remove stale fork
  scaffolding` after `3a038a17 docs: v0.21.7 release notes + refresh stale CHANGELOG.md`. The repo
  is at plugin version 0.38.0 and releases are the recorded channel. KEEP as-is.

---

## CONSOLIDATE list

### C1. Synapse-tail run docs → one canonical report per epoch + an index

| Role | File |
|---|---|
| **Survivor** | `docs/perf/runs/synapse-tail-<epoch>/report.md` (3 files, 29.3 KB) |
| Absorb | `docs/perf/synapse-tail-run-881be45b.md` (3,879 B) |
| Absorb | `docs/perf/synapse-tail-run-af8ef126.md` (2,371 B) |
| Missing | no landing doc exists for epoch `6e5ffc03` |

Evidence for consolidation: both landing docs have **0 inbound refs** (precise full-path `rg`), the
naming is inconsistent with the directory form, and coverage is asymmetric (2 landing docs for 3
epochs) — which is what an accreting convention looks like. Add `docs/perf/runs/README.md` as the
epoch index (pilot → inconclusive → provisional selection) and fold each landing doc's unique
material into its own `report.md`. `881be45b`'s "Warmup re-analysis" section is unique to the landing
doc and must be carried over, not dropped.
TRACKED(ll1 — next epoch validation; bux — U8 confirmatory run + docs landing; qm0 — harness cleanups).

### C2. Rust-transform perf docs → one round-4 canonical

| Role | File | Inbound |
|---|---|---:|
| **Survivor** | `docs/rust-transform-perf-round4-2026-08-16.md` (10,053 B) | 0 |
| Absorb | `docs/rust-transform-r4-native-roll-forward-2026-08-16.md` (3,955 B) | 0 |
| Absorb | `docs/native-attachment-incremental-cache-2026-08-10.md` (9,322 B) | 0 |

Evidence: all three describe one work stream (the r4 transform/native-attachment pass); the
roll-forward doc is literally the incident follow-up to the round-4 doc; and the 08-10 design doc is
**superseded on a load-bearing constant** — see S3 below. All three have 0 inbound references. Keep
`docs/rust-mode-transport-overhead-2026-08-10.md` **out** of this merge: it is explicitly retained by
`docs/mc-host-wire-protocol.md:1031` as *"measured framing-cost evidence only"*.

### C3. `docs/` has no index

`docs/` holds 17 top-level entries and no `README.md`. Ten of the tracked md files under `docs/` have
0 inbound references, which is the mechanical consequence. One `docs/README.md` map would make the
"nobody links to it" signal meaningful instead of ambient.

### C4. Mutation-record stubs (only if D1 is rejected)

If the six `fm-oc-*.md` files are kept for human readability, collapse them into one
`packages/e2e-tests/mutations/README.md` explaining the `.json` record shape and the
`run-rust-fm-mutation.ts` procedure once, rather than six copies of the same sentence.

---

## MOVE list

### M1. `2026-08-17-0505-subc-api-surface-spike-plan.md` → into `docs/` (do **not** delete)

Root-level dated spike plan, 10,394 B, last touched 2026-08-17.

- **Inbound refs = 1**: `docs/subc-api-surface-inventory-2026-08-17.md:5` — `` Plan:
  `2026-08-17-0505-subc-api-surface-spike-plan.md` ``. Deleting it breaks that citation.
- Its owning task **`magic-context-c50.1` is IN_PROGRESS**, not closed (`bd show`), even though its
  Decision block is recorded. Siblings c50.2/.3/.4/.5/.7/.10/.12 are closed; c50.6/.8 in progress;
  c50.9/.11 open.
- Its deliverable `docs/subc-api-surface-inventory-2026-08-17.md` is actively load-bearing: cited by
  `docs/mc-host-wire-protocol.md:1029`, `docs/evidence/subc-compiler-closure/README.md:10,95`,
  `compiler-error-ledger.md:8`, and `docs/evidence/subc-compiler-closure/stubs/subc-protocol/Cargo.toml:6`.

Recommendation: `git mv` to `docs/plans-archive/` (a **tracked** path — note `docs/plans/` itself is
gitignored, so moving it there would silently untrack it) and update the one citation in the same
commit. TRACKED(c50, c50.1).

---

## STALE-CONTENT list

### S1. `STRUCTURE.md` (38,318 B, touched 2026-08-29, 73 inbound) — 6 verified wrong claims

Cited by `AUDITOR.md` as the authority for "where to add new code", so drift here is load-bearing.

1. **`crates/mc-module/src/main.rs` does not exist.** `STRUCTURE.md:140` — *"`crates/mc-module/src/main.rs`:
   Entry point for the current `subc` daemon module"*. Actual entry point:
   `crates/mc-module/src/bin/ck-mc-host.rs` (plus `src/bin/ck_mc_host/`). `ls crates/mc-module/src/`
   shows no `main.rs`.
2. **`docs/cache-policy/` does not exist anywhere in the tree.** `STRUCTURE.md:107` lists it as a key
   `docs/` location. `find` for it returns nothing.
3. **`packages/plugin/scripts/backfill-embeddings.ts` does not exist.** `STRUCTURE.md:100` lists it as
   a key scripts file. Not present in `packages/plugin/scripts/`.
4. **`src/features/magic-context/migrations-v11.test.ts` does not exist.** `STRUCTURE.md:243` gives it
   as the naming-convention exemplar. The dir has `migrations.ts` and `harness-migration.test.ts`.
5. **The Workspace Layout tree omits two real Cargo members and five real packages.**
   `Cargo.toml:3` = `["crates/mc-core", "crates/mc-store", "crates/mc-host", "crates/mc-module",
   "crates/mc-tokenizer", "crates/mc-shm-transport", "packages/mc-shm-native"]`.
   `STRUCTURE.md:6-14` lists 5 crates (no `mc-shm-transport`) and 5 packages, while `ls packages/`
   shows 10 — missing `mc-shm-native`, `mc-host-darwin-arm64`, `mc-host-darwin-x64`,
   `mc-host-linux-x64-gnu`, `retina-local-fs`. The iceoryx2 shm transport shipped
   (`crates/mc-shm-transport/Cargo.toml:9-16`, `iceoryx2 = "=0.9.3"`) and is invisible in the layout doc.
6. **`mc-module` is described as a subc module although subc is gone from it.**
   `STRUCTURE.md:13` — *"Current subc module and future mc-host adapter"*. `rg 'subc'
   crates/mc-module/Cargo.toml` and `crates/mc-module/src/lib.rs` both return **zero** matches after
   `df745a3b refactor: remove private subc runtime dependency`. `STRUCTURE.md` still contains 11
   `subc` mentions.

*Verified-correct and deliberately not flagged:* the bulk `src/...` paths are relative to
`packages/plugin/` per the doc's own preamble and resolve; `src/broca/` and `src/synapse/` resolve
under `crates/mc-host/src/`; the note that `src/cli/` no longer exists is accurate.

### S2. `ARCHITECTURE.md` (59,080 B, touched 2026-08-29, 114 inbound) — internal contradiction + a missing subsystem

1. **The file contradicts itself about subc.** `ARCHITECTURE.md:15` — *"`McHandler`, Synapse, and Broca
   compose directly under that host with no provider process or private `subc-*` runtime
   dependency."* `ARCHITECTURE.md:33` still opens — *"**Rust subc Module** (`crates/mc-module/`):
   Integrate with the current `subc` daemon"*. Line 33 is the wrong one: `crates/mc-module/Cargo.toml`
   has no subc dependency and `crates/mc-module/src/lib.rs` has no subc reference.
2. **`mc-shm-transport` is absent from the architecture document entirely.** `rg -c 'mc-shm-transport'
   ARCHITECTURE.md` → no match, while the crate is a workspace member with a pinned iceoryx2
   dependency and its own fuzz workspace (`Cargo.toml:3,8`). The shm transport's own doc exists
   (`docs/mc-host-shm-transport.md`) but nothing in the top-level architecture points at it.
   TRACKED(ymc — shared-memory IPC epic, OPEN).

### S3. `docs/native-attachment-incremental-cache-2026-08-10.md` (9,322 B, 0 inbound) — superseded constant

Line 5 claims: *"`McHandler` owns one **64 MiB** process-local LRU budget shared by all cached
sessions."*

Contradicted by code: `crates/mc-module/src/transform.rs:143`
`pub(crate) const SERIALIZED_OUTPUT_CACHE_BUDGET_BYTES: usize = 256 * 1024 * 1024;` — and the comment
immediately above it (`transform.rs:141`) records exactly why the old figure is wrong: *"Real 5k-message
sessions retain 24-55 MiB of canonical output plus typed CK trees. A 64 MiB [ceiling is insufficient]"*.
`docs/rust-transform-perf-round4-2026-08-16.md` already documents the change (*"The serialized-output
cache budget is 256 MiB… The old 64 MiB output-cache ceiling could not retain that single real
session"*). Fold per C2; do not leave both figures in `docs/`.

### S4. `docs/prompt-surface-registration-fixture.md` (1,622 B, 0 inbound) — all three line citations drifted

The doc pins line ranges but, unlike its sibling `cc-manifest-epoch-fixture.md`, records **no source
revision**, so the ranges read as current and are wrong:

| Claim | Actual |
|---|---|
| `tool-registry.ts:51-171` `createToolRegistry` | declared at **:54**; file is 194 lines |
| `pi-plugin/src/tools/index.ts:69-144` `registerMagicContextTools` | declared at **:74**; file is 178 lines |
| `pi-plugin/src/index.ts:839-2317` `startPiMagicContextRuntime` | **defined at :853** (:839 is a call site); file is 2383 lines |

Fix: add a `Source revision:` pin (the pattern `cc-manifest-epoch-fixture.md` already uses) or
re-anchor to symbol names instead of line numbers.

### S5. `docs/specs/prompt-surface/decisions/README.md` (1,126 B) — contradicts its own sibling records

README: *"Current records are intentionally `PENDING-RATIFICATION`; S3 light authorship is blocked
until Ufuk replaces the pending decision/timestamp with a ratification."*

Both records are already ratified:
- `budget-ratification.md`: `status: RATIFIED`, `ratificationTimestamp: 2026-08-08T18:44:57Z`,
  `decision: ACCEPT — floor(0.50 × mutable-prose baseline), ceiling 1825`.
- `checklist-ratification.md`: `status: RATIFIED`, same timestamp, `decision: ACCEPT`.

The ratified 1825-token ceiling is downstream-live (`ARCHITECTURE.md:33` cites "a ratified 1825-token
budget ceiling"), so the README is the only stale artifact. The records themselves carry
`artifactRevisionOrDigest: sha256:…` pins and are KEEP.

### S6. `docs/specs/context-window-geometry.md` (7,730 B, 0 inbound) — stale forward reference

Line 3: *"the curation and serving of this data class is planned to move to the Fusiform module once
Magic Context runs fully **on subc**."* The `subc` runtime is being removed, not adopted: epic
`magic-context-c50` is *"Hand-rolled Rust module host: **replace** private subc daemon"*, and
`df745a3b refactor: remove private subc runtime dependency` has landed. Re-word the milestone to the
mc-host boundary. The document body (provider geometry classes, evidence-class tagging) is current
and valuable — KEEP the file.

### S7. `AUDITOR.md` + `docs/AUDIT-KNOWN-ISSUES.md` — dashboard described as live — **TRACKED(rnq)**

Already owned by open bead `magic-context-rnq`; recorded here for completeness with fresh proof.

- `AUDITOR.md:13` scope cell still reads *"Cross-cutting / OpenCode-core / **dashboard** findings"*.
  Last touched **2026-06-06** — the oldest tracked md in the repo.
- `docs/AUDIT-KNOWN-ISSUES.md` (58,442 B, last touched **2026-07-06**, 11 inbound) has ~10 entries
  presented as live behavior. Two now cite deleted code:
  - `:278` *"Dashboard bulk-restore epoch TOCTOU (`db.rs bulk_update_memory_status`)"* — `rg
    bulk_update_memory_status` matches **only this doc line**; the Rust symbol is gone.
  - `:866-867` A53 cites `embedding_probe.rs` — `find -name embedding_probe.rs` returns nothing.
  - Also `:663` A41, `:695` A45, `:283`, `:286`, `:169-171`, `:522`, `:803`.
- `packages/dashboard/` no longer exists (`ls packages/`); removed across
  `a37f2187..2bae8911` (`97c43498 refactor: drop dashboard scan roots…`, `2bae8911 docs: remove
  dashboard from user-facing and internal docs`), merged as `9c1eb4d1` / PR #85. That range deleted
  `packages/docs/src/content/docs/reference/dashboard.md` (152 lines) and cleaned 15 other docs.

Per rnq: **mark entries retired in place, do not delete**, so `claim-audit-*` ids stay resolvable.
Correction to the guard's premise: `source-inventory.json` stores **no** digest literals for these
files — `evidence.ts:430,438` hash the file bytes at runtime — so an edit needs no digest
regeneration step, but it *will* change every derived claim digest and must land with the incident-pool
tests in one change.

*User-facing and top-level docs are already clean:* `ARCHITECTURE.md`, `README.md`, `STRUCTURE.md`,
`CONFIGURATION.md`, `docs/migration-version-lanes.md` and all 19 `packages/docs/src/**` pages have
**zero** `dashboard`/`tauri` matches. Remaining hits outside rnq's scope are legitimate historical
prose: `packages/pi-plugin/PARITY.md:601`, `prompt-surface-a1-golden.md` (frozen golden fixture
strings), `historian-prompt.source.md:232` (frozen prompt example).

---

## TRACKED list — protected by open beads, do not delete

| Path(s) | Bead | Why protected |
|---|---|---|
| `AUDITOR.md`, `docs/AUDIT-KNOWN-ISSUES.md` | **TRACKED(rnq)** | Dashboard entries must be *retired in place*; both are runtime-digested by `packages/e2e-tests/incidents/source-inventory.json` via `evidence.ts:430,438` |
| `piolium/**` (11 md, 277.7 KB) | **TRACKED(c7t)** | `findings/M1-…/report.md` is the source for open P1 bug c7t; M1's `project-security.ts:397-410` citation still resolves |
| `docs/perf/runs/synapse-tail-*/report.md`, `docs/perf/synapse-tail-run-*.md`, `docs/perf/synapse-tail-contract.md` | **TRACKED(ll1, bux, qm0)** | ll1 = next epoch must validate schedule identity; bux = U8 confirmatory run + docs landing; qm0 = harness cleanups. Consolidate only, never delete |
| `docs/perf/mc-host-baseline.md`, `mc-host-ipc-budget.md`, `mc-shm-hardware-envelope.md` | **TRACKED(a9p, u51, nlw, z00, ds8)** | Measurement/benchmark-corpus tasks consume these as inputs |
| `docs/mc-host-shm-transport.md` | **TRACKED(ymc)** | Shared-memory IPC epic OPEN; doc is the live contract for the non-default shm profile |
| `docs/evidence/subc-compiler-closure/**` (2 md) | **TRACKED(c50, c50.12)** | Supports the subc replacement; cited by `mc-host-wire-protocol.md:1029` |
| `docs/subc-api-surface-inventory-2026-08-17.md` | **TRACKED(c50.1)** | 5 inbound refs incl. a stub `Cargo.toml` description |
| `2026-08-17-0505-subc-api-surface-spike-plan.md` | **TRACKED(c50.1)** | c50.1 IN_PROGRESS; **MOVE, do not delete** (see M1) |
| `docs/specs/prompt-surface/**` (11 md) | **TRACKED(3q5 epic)** | Ratified budget/checklist records carry `sha256:` artifact pins; the 1825 ceiling is cited in `ARCHITECTURE.md:33` |
| `packages/e2e-tests/parity-findings-s2.md`, `mutations/thinking-block-adjudication.md`, `incidents/pi-todo-provenance.md` | **TRACKED(rnq-adjacent)** | Digest-pinned in `source-inventory.json`; read by `evidence.ts:53` and `adjudicate-thinking-block.sh:6` |
| `packages/plugin/src/features/magic-context/smart-notes/PARITY.md`, `packages/pi-plugin/PARITY.md` | **TRACKED(pml epic)** | Rust-parity porting tasks use them as the divergence ledger |

---

## KEEP (one line each)

**Root / agent contracts**
- `README.md` — user entry point, 36 inbound, dashboard-clean, updated 2026-08-29.
- `ARCHITECTURE.md` — cache-stability model authority, 114 inbound; **see S2**.
- `STRUCTURE.md` — layout authority cited by `AUDITOR.md`, 73 inbound; **see S1**.
- `CONFIGURATION.md` — hand-maintained config reference; all 66 documented keys resolve in `packages/plugin/src/config/` (verified leaf-by-leaf); no removed/dashboard config.
- `AUDITOR.md` — audit-scope router; **see S7**, TRACKED(rnq).
- `AGENTS.md` / `CLAUDE.md` — agent instruction contracts, load-bearing by definition.
- `CHANGELOG.md` — intentional redirect stub, not abandoned (see refutation above).
- `LICENSE`-adjacent metadata files — out of md scope, all load-bearing.

**Beads plumbing**
- `docs/beads.md`, `.beads/PRIME.md`, `.beads/README.md`, `.agents/skills/beads/SKILL.md` — task-tracking contract required by `AGENTS.md`.

**`docs/` subsystem references**
- `docs/mc-host-wire-protocol.md` — 99.5 KB, 13 inbound, the wire authority; cites and thereby pins three other docs.
- `docs/mc-host-shm-transport.md` — shm contract, TRACKED(ymc).
- `docs/migration-version-lanes.md` — version-lane policy, updated 2026-08-29, dashboard-clean.
- `docs/synapse-model-bundle.md` — bundle certification contract, cited from `ARCHITECTURE.md:31`.
- `docs/rust-mode-transport-overhead-2026-08-10.md` — explicitly retained as measured evidence by `mc-host-wire-protocol.md:1031`.
- `docs/rust-transform-perf-round4-2026-08-16.md` — C2 survivor.
- `docs/nudge-hygiene-calibration-2026-08-16.md` — report-only replay of a frozen formula with a reproduction command; 0 inbound but self-contained and cheap (1.9 KB).
- `docs/specs/git-dedup-heuristic.md` — active spec, 1 inbound.
- `docs/specs/context-window-geometry.md` — measured provider geometry, body current; **see S6**.
- `docs/specs/prompt-surface/**` — ratified decision records with `sha256:` pins + fixtures, TRACKED(3q5).
- `docs/specs/prompt-surface/cc-manifest-epoch-fixture.md` — correctly revision-pinned to `5a031ea3`; its reference to `mc-module/src/main.rs` is valid *at that revision* and is not drift.
- `docs/evidence/subc-compiler-closure/**` — TRACKED(c50).
- `docs/perf/**` — frozen-contract evidence, TRACKED(ll1/bux/qm0/a9p/u51/nlw/z00/ds8).

**Docs site (`packages/docs/src/**`, 19 files, 146 KB)**
- All KEEP; all dashboard-clean post-PR-#85; `reference/configuration.md` is **generated** by `packages/plugin/scripts/build-config-docs.ts:12,280` and is in sync (spot-checked `subc.connection_file`, still live at `schema/magic-context.ts:887`).
- `reference/tui-sidebar.md` — oldest site page (2026-07-01) but verified current: `packages/plugin/src/tui/` exists with `index.tsx`, `slots/`, `data/`, `types/`.
- Note: no CI job regenerates or diffs `reference/configuration.md` (`rg build-config-docs .github/workflows package.json` → no match). Low-cost hardening opportunity, not debt.

**Package + test docs**
- `packages/e2e-tests/README.md` (36 inbound), `historian-eval/README.md`, `incidents/README.md`, `prospective-holdout/README.md` — active harness docs.
- `packages/e2e-tests/mutations/thinking-block-adjudication.md`, `parity-findings-s2.md`, `incidents/pi-todo-provenance.md` — digest-pinned evidence.
- `packages/pi-plugin/README.md`, `PARITY.md`, `scripts/experiments/perf/README.md`; `packages/plugin/.../smart-notes/PARITY.md`.
- `packages/plugin/src/hooks/magic-context/historian-prompt.source.md` — **build input**, compiled to `historian-prompt.generated.ts`; not prose.
- `packages/plugin/src/shared/prompt-surface-a1-golden.md` — frozen golden fixture with a system-prompt hash baseline; its `dashboard` strings are fixture bytes and must not be edited.
- `packages/docs/README.md`, `packages/docs/STYLE.md`; `packages/mc-host-{darwin-arm64,darwin-x64,linux-x64-gnu}/README.md` (npm platform-package readmes); `packages/retina-local-fs/README.md`.
- `scripts/drive-rig/README.md`, `tests/docker/README.md` — tool usage docs.

**`piolium/**`** — security audit artifact set, TRACKED(c7t); zero external inbound refs but M1 is an open P1 and the report's code citation still resolves.

---

## Method (reproducible)

```sh
# corpus
git ls-files '*.md' | grep -v node_modules | grep -v '^target/'
# staleness
git log -1 --format=%ad --date=short -- <file>
# inbound refs (precise, full path, self-excluded)
rg -c --no-filename -F "<path>" --glob '!node_modules' --glob '!target' --glob '!<path>' .
# STRUCTURE.md path claims (with the packages/plugin/ relative-root fallback)
rg -o -N '`[a-z0-9][a-zA-Z0-9_.*-]*(/[a-zA-Z0-9_.*-]+)+/?`' STRUCTURE.md | tr -d '`' | sort -u
# CONFIGURATION.md key claims vs schema
rg -o -N '^\| `([a-zA-Z][a-zA-Z0-9_.]*)`' CONFIGURATION.md   # then leaf-grep packages/plugin/src/config/
# dashboard-removal range
git log --oneline a37f2187..2bae8911 ; git diff --stat a37f2187..2bae8911
```

Basename-based inbound counts are unreliable in this repo — 16 files are named `README.md` and 3 are
named `report.md`. Every inbound count above uses the full repo-relative path.
