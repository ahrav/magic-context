# Final branch code review — chore/dry-audit-exec-2026-08-29

Run: ce-code-review `mode:agent` (report-only), run-id `20260830-083502-ce99c174`.
Scope: standalone worktree review of the working tree vs merge-base `9c1eb4d1` (372 files, ~14.1k executable changed lines, includes the uncommitted `historian-dumps.ts` edit). Note: `git diff main` shows 399 files because main is 19 commits ahead of the merge-base (the mc-host release-verification stack); files such as `scripts/verify-mc-host-release-evidence.ts` are main-side additions absent from this branch, not deletions made by it — they were excluded as reverse noise.
Plan: `docs/plans/2026-08-29-1850-chore-dry-audit-remediation-plan.md` (`plan_source: explicit`, unified, implementation-ready).

Reviewer team (run inline — subagent dispatch unavailable at depth limit; noted per invocation): correctness (always-on), project-standards (root AGENTS.md + comment policy), testing (T2 oracle tests + parameterization), maintainability (structural consolidations), security (path-fence, JSONC pollution, redaction), reliability (retry/caps/transport/error paths), adversarial in-process (deletion/live-caller + weakened-guarantee attack; the cross-model peer was not started: internal host, external egress not sanctioned in this environment).

## Triage Groups

| Group | Findings | Context | Preferred Resolution | Why | Kind |
|---|---|---|---|---|---|
| Finish the U11 tail | #1, #3 | PR assembly is the only unfinished plan unit | Commit the working-tree edit first (#1), then carry the KTD11 sign-off request and cut-scope statement into the PR description (#3) | Both are branch-finalization steps the plan mandates; neither touches reviewed behavior | apply-queue |

## Findings

### P2 -- Moderate

**#1 Uncommitted working-tree simplification in historian-dumps.ts is not part of any commit** — `packages/cli/src/lib/historian-dumps.ts:94` (correctness, confidence 100, manual)
`git status --porcelain` -> ` M packages/cli/src/lib/historian-dumps.ts`. The PR is assembled from pushed commits, so this verified simplification silently drops out of the delivered branch — or, committed later, lands without the recorded final-HEAD gate evidence. The edit itself is behavior-preserving: `fileSize` keeps its try/catch returning 0, and `listDumpsInDir` keeps `} catch { return { count: 0, recent: [] }; }` (ENOENT now handled by the catch that replaced the `existsSync` guard).
Fix: commit it as its own commit before PR assembly (or revert it).

**#2 Cut-scope residuals (U8 remainder + all U10 drift anchors) are tracked only in the ledger file, not in beads** — `docs/research/dry-audit-2026-08-29/stale-findings-ledger.md:404` (project-standards + adversarial, confidence 75, manual)
Ledger: "U10 (Wave 5 drift anchors) skipped entirely per the final-resume provision: all §7 anchors remain open". `.beads/issues.jsonl` has zero entries matching CC-3, CC-5, temp-data-home, mock-provider, "drift anchor", max_frame_body_len, computeProof, or ModuleMethod — only the `awe` round-trip-fixture bead exists. AGENTS.md routes all task tracking through bd, and the plan's own KTD10 pattern excuses skipped work only because "the beads already track them". The drain_flip near-miss found during C13 recovery is exactly the drift class the missing anchors would catch.
Fix: `bd create` beads for tests CC-3, tests CC-5, pi F-7, mc-module T2-2/T2-4, and one bead for the U10 anchor set (v2 envelope vectors, `max_frame_body_len` contract entry x3, auth/`computeProof` vectors, handshake budget pin, `claim_mirror` assert, X7 `ctx_memory` spec, X6 parity tests, plus the new ModuleMethod<->Rust-dispatch anchor), mirroring the audit's own proposed Wave-4 title.

### P3 -- Low

**#3 PR description obligations from U11/KTD11 are still open** — plan `:169` (project-standards, confidence 100, manual)
The PR does not exist yet (plan defers push/PR to harness authority), so nothing is broken; but U11 mandates the description carry the tests T2-1 (`project-security.test.ts` deletion) human sign-off request (the file is currently kept — and strengthened by parameterization), the deliberate U8/U10 cut-scope statement (a KTD8 deviation), the waves/LOC summary, ledger pointer, and audit-record note (R12).

## Requirements Completeness (plan_source: explicit)

| Req | Status | Note |
|---|---|---|
| R1 T0 sweep | met | holds honored (`seed_workspace_member`, `hardware_matches` verified present) |
| R2 docs wave | met | deletes/move/consolidations + `docs/README.md` present |
| R3 T1 sub-waves + gates | met | CC-4 gate narrowed one finding (ledgered); F8d gate-failed skip (ledgered); F-6 shim handled |
| R4 Wave 3 T2 | partial (deliberate) | items 1-10 complete, one commit each with review; ungated remainder (CC-3, CC-5, F-7, T2-2, T2-4) cut under the ledgered final-resume budget rule -> finding #2 |
| R5 guards never removed | met | verified by rg; zero guarded symbols removed |
| R6 re-verify + ledger | met | comprehensive multi-run ledger |
| R7 Wave 4 beads | met | 15 beads + hygiene (8ss closed, nll/rnq comments); conditional beads correctly not filed |
| R8 Wave 5 anchors | not addressed (deliberate, ledgered) | U10 skipped entirely; deviates from KTD8 -> findings #2, #3 |
| R9 gates | met | final-HEAD gates green modulo the recorded baselines; release suites env-blocked at baseline (ledgered) |
| R10 independent review per wave | met | dispositions recorded per wave/finding |
| R11 comment policy | met | sweep of 914 added comment lines across 5,872 added code lines: zero ticket-ID/temporal/narration violations |
| R12 audit record + ledger in PR | met | directory + ledger tracked on the branch |

Units: U1-U7 complete; U8 partial (ledgered cut list); U9 complete; U10 not executed (ledgered); U11 partial — pending PR assembly (#1, #3).

## Verified-clean checks (evidence spot-log)

- Wire/shm/auth untouched: `git diff` empty for `crates/mc-host/src/wire.rs`, `crates/mc-shm-transport/`, `protocol.ts`, `auth.ts`.
- `authority.drain_flip` present in the consolidated `ModuleMethod` union (`module-wire.ts:1576`) and matches the Rust dispatch arm (`mc-module/src/lib.rs:12276`).
- C16 tier table: constants unchanged (250k/500k/750k), tuples (2,0.25,100k / 3,0.35,150k / 4,0.5,250k) identical to the three replaced functions; NaN/out-of-domain falls to the same non-emergency tier as the old else-branch.
- Conflict-warning reroute: `sendIgnoredMessageNow` preserves the title-safety guard (`waitForSafeNotificationTarget`), the mid-turn queue (checked twice), prompt-context pinning, and returns "failed" instead of throwing — the four senders keep their old swallow-and-log behavior; `forcePersist` skips only the toast path.
- Path-fence: union-of-roots strictly widens rejection (relative XDG additionally fences the cwd-relative tree; relative/empty HOME ignored like the daemon).
- JSONC: `sanitizeParsedJson` rejects `__proto__`/`constructor`/`prototype` and non-plain prototypes on every config construction path; the migration comparator strip pipeline is fingerprint-only (no object use).
- Redaction consolidation is `escapeRegex`-only; no pattern narrowed.
- Claims schema files: logic unchanged; deleted exports (`APPEND_ONLY_CLAIMS_TABLES`, `assertClaimsSchemaForeignKeys`, three type aliases) have zero remaining references.
- Deleted files all caller-free: `source-trust.ts` (one DDL doc-comment mention only), hooks `format-bytes.ts` (callers import the shared copy), fm-oc `.md` fixtures (`.json` twins live, no `.md` loader), `embedding.test.ts` (tests rehomed).
- Fake-peer second oracle intact (imports nothing from production client; own encoders); tui vs tui-compiled path logic in sync.
- `project-security.test.ts`: kept (KTD11); 32 old cases = 27 its + 5 `it.each` rows, per-row assertions strengthened (sibling preservation + warning).
- Parameterization spot-checks (5 files incl. a pi twin): it/row counts identical old vs new.
- Loader-parity and jsonc-strip-differential tests use genuine independent oracles (two real loader implementations; reference comparison).
- `ordinalMemoOf` projects per call and passes the live entries Map (no stale capture).

## Coverage

- Personas run inline by the orchestrator (subagent depth limit 1); cross-model adversarial peer skipped (internal host, egress not sanctioned) — in-process adversarial lens ran instead.
- Validator batch not run (same dispatch limit); all 3 findings were orchestrator-verified directly against the tree with quoted evidence; no P0/P1 exists, so nothing is validation-degraded.
- Pre-existing failure baselines honored (plugin shard 31; Rust 7; env-dependent release/e2e) — no finding rests on them.
- Untracked excluded from scope: `undefined/` stray dir (pre-existing, ledger-noted).
- Settlement: session-settled KTD1-KTD6 extracted; no reviewer finding conflicted with a settled decision — zero `settled_conflict` stamps.
- Residual risks: transformBodyBase hoist has no pin test (reviewer-verified only); union historian oracle is strictly wider than either predecessor (bounded by the drift pin); release suites env-blocked at baseline; branch is 19 commits behind main (rebase not verified here).
- Testing gaps: ModuleMethod<->Rust dispatch anchor absent (ledger-acknowledged, feeds #2); CC-2 sibling DDL drift copies remain (ledgered).

---

## Verdict

**Ready with fixes.** The remediation work itself is clean: every consolidation checked preserved semantics, every T2 fix is real and test-backed, no guarded or live-caller code was deleted, sensitive subsystems are untouched or strengthened, and the comment-policy sweep is clean. The three findings are branch-finalization items, not code defects: commit the uncommitted `historian-dumps.ts` edit (#1), file beads for the ledgered U8/U10 cut-scope residuals (#2), and carry the KTD11 sign-off request plus cut-scope statement into the PR description (#3). R8 (Wave 5 anchors) and part of R4 are unimplemented by deliberate, ledgered cut — acceptable per the session's cut-scope decision provided #2 and #3 land.
