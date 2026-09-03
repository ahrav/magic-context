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

# Integration receipt

Status: complete for local integration and verification. Publication remains outside this integration task.

## Merge evidence

- All 32 worker commits are ancestors of the integration tip. Bins 21 through 32 were merged once from `e0d1fdfa`, `b45be059`, `2fef6eef`, `b335f973`, `d19c7263`, `bc42435e`, `1417ef4a`, `e6d3ebfc`, `4dfeacd5`, `de9d7342`, `44d9dcd7`, and `407618c5`.
- Pre-merge checks rejected out-of-bin paths, non-comment changed lines, missing commits, duplicate ancestry, and steering-comment deletion.
- Bins 21, 22, and 26 overlapped previously reviewed transport documentation. Git reported conflicts in `src/lib.rs`, `src/lifecycle.rs`, and `tests/fuzz_corpus.rs`. Integration retained the existing, more complete transport wording and all `commentlint` steering directives while merging every non-conflicting bin change. No code tokens changed.

## Audit and review evidence

- Diff audit against `main` found zero non-comment changed Rust lines and zero deleted `SAFETY`, `ponytail`, `commentlint`, copyright, or SPDX steering lines.
- Fresh review sampled two changed files from each of bins 21 through 32 and inspected public documentation throughout `crates/mc-shm-transport/src/**`.
- Review fixed one inaccurate `Incarnation::into_bytes` description and added field documentation needed to keep `rustfmt` stable in `control.rs` and `dispatch.rs`.
- Targeted transport rustdoc with warnings denied and transport doctests pass after review fixes.

## Verification evidence

- `cargo fmt --all -- --check`: pass after review fixes.
- `RUSTDOCFLAGS='-D warnings' cargo doc -p mc-shm-transport --no-deps`: pass.
- `cargo test -p mc-shm-transport --doc`: pass, with zero doctests defined.
- `bun run release:contract:check`: pass for release `0.38.0`, digest `ab3b41c0f4f99f917dc4ac03515a2a36f50d5cb0dde603b4518cf47480e975e2`.
- Workspace clippy, workspace rustdoc, workspace doctests, and `bun run test:rust` remain blocked by pre-existing compilation failures. `mc-store` produces the same 135 indexed errors on `main` and this branch under `cargo check -p mc-store`, led by `E0308`, missing `GuardedConn` methods, and dependent inference errors. The scanner benchmark's eight `E0277`/`E0308` errors are also reproducible on `main`. Main's workspace clippy additionally fails the transport missing-doc gate that this branch fixes.
