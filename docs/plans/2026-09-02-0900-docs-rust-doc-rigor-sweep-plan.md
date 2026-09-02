---
title: Rust Doc-Rigor Documentation Sweep
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Goal

Improve documentation in every hand-maintained, tracked Rust source file with `doc-rigor`. Documentation-only changes. Preserve comment steering and plain prose policy. Use 32 parallel workers with disjoint file ownership, then integrate, verify, review, commit, push, and open a draft PR.

# Scope

Include every tracked `*.rs` file except `release/generated/**` and `docs/evidence/**/*.rs`, which are generated or frozen evidence artifacts. Include fuzz targets and build scripts. Modify comments/doc comments only. Do not change code tokens, attributes, imports, dependencies, or CI.

# Decisions

- Use 32 workers because user requested that concurrency.
- Partition files by greedy longest-processing-time line-count bins. One file has one owner. Giant files stay single-owner.
- Use isolated worktrees for every writer. Merge worker commits sequentially into one integration branch.
- Preserve existing `// SAFETY:`, `// ponytail:`, lint attributes, license headers, and steering comments verbatim. New prose is direct, active, plain, and contains no em dashes or filler.
- Do not add missing-doc lints. Add doctests only when they are deterministic and pass; prefer text or `no_run` when examples cannot execute.
- Baseline verification before edits. Compare post-edit failures against baseline.

# Execution

1. Confirm clean tree, repository metadata, Rust workspace dependencies, and tool availability. Record baseline for `cargo fmt --check`, workspace clippy with `-D warnings`, rustdoc with `-D warnings`, workspace doctests, `bun run test:rust`, and release contract checks.
2. Create branch `docs/rust-doc-rigor-sweep` from current main.
3. Build authoritative tracked-Rust manifest with exclusions above. Greedy-pack into exactly 32 bins. Assert union and pairwise disjointness.
4. Create 32 isolated worktrees and run one worker per bin in parallel. Each worker reads assigned files fully, applies `doc-rigor`, preserves steering comments, edits only comments/doc comments in owned files, and commits its bin. No worker runs cargo builds.
5. Merge all 32 commits into integration branch. Any conflict or out-of-bin edit stops integration.
6. Run centralized verification: format, clippy, rustdoc, doctests, Rust test script, release contract check, and targeted steering-comment tests. Accept only passes or failures proven pre-existing by baseline.
7. Audit diff for deleted steering comments and non-comment changes. Run fresh-context doc-rigor accuracy review sampling at least two files per bin and all files under missing-doc-enforced transport source. Apply findings in one integration worktree and rerun affected gates.
8. Commit plan and source changes, push branch, and open draft PR to `main`. PR body includes scope, exclusions, 32-bin summary, verification evidence, steering audit, review findings, and any residuals. Do not publish or auto-merge.

# Acceptance

- All in-scope tracked Rust files reviewed.
- Diff changes comments/doc comments only.
- Steering comments preserved verbatim.
- Verification gates pass or baseline-equivalent failures are documented.
- Accuracy review completed.
- Branch pushed and draft PR URL returned.
