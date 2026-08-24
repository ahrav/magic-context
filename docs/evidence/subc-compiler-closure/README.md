# subc Compiler Closure — Evidence

Task: `magic-context-c50.12` · Plan: `2026-08-24-0115-fix-subc-compiler-closure-plan.md`
Date: 2026-08-24

## What this proves

The five `subc-*` dependencies of `mc-module` were redirected to strict,
behaviorless stub crates whose public surface is exactly the rows of
`docs/subc-api-surface-inventory-2026-08-17.md`. Every Cargo-discovered
`mc-module` target then compiled. Therefore the inventory is a **complete**
enumeration of the Rust `subc-*` API surface the current `mc-module` code
requires at compile time — closing the completeness gap that
`magic-context-c50.1` left open and un-gating `magic-context-c50.4`.

Two gaps were found and reconciled (see `compiler-error-ledger.md`):
`FrameType::Ping` (the deliberate positive-control omission, demanded by
`tests/broca_roundtrip.rs:544`) and `PartialEq` on `manifest::ConsumerRole`
(demanded by a lib unit test). Both are satisfied by the published MIT crates,
so the closure does not alter the original c50.1 shim-vs-rewrite analysis.
Note the operative decision has since been superseded (`magic-context-c50.1`,
2026-08-22): the boundary is being ported directly to the mc-host SDK with no
`subc-*` compatibility shims (`magic-context-c50.4`); this pass proves the
inventory that port relies on is complete.

## Environment

- Worktree: disposable git worktree created as a **direct sibling** of
  `magic-context` so `../commons` and `../subconscious` path dependencies
  resolve identically. The pass ran twice: first at revision
  `e1a09a549e6560543b906e73521f484c01010fb8`, then — after `main` advanced via
  the PR #28 merge — repeated end-to-end at the current tip
  `574569d5` (log sections `[rerun-*]`), with identical results and no
  additional demanded items.
- Toolchain: `rustc 1.97.1 (8bab26f4f 2026-07-14)`, `cargo 1.97.1`.
- Stubs compiled from an external sibling copy
  (`../subc-closure-stubs/<crate>`); the copies here under `stubs/` are the
  final evidence artifacts.
- Discovered `mc-module` targets (`cargo metadata --no-deps`): lib
  `mc_module`, bin `ck-mc`, tests `boundary_counter_durability`,
  `broca_roundtrip`, `real_daemon`.

## Procedure and commands (all output in `compiler-closure.log`)

1. **Baseline (`[baseline]`)** — every target compiled against the real
   sibling dependencies before any redirection:
   `cargo build -p mc-module --lib`, `cargo build -p mc-module --bin ck-mc`,
   `cargo test -p mc-module --lib --no-run`, and
   `cargo test -p mc-module --test <target> --no-run` for each of the three
   integration targets. All green.
2. **Redirection (`[stub-redirect]`)** — only the five
   `[workspace.dependencies]` path edges `subc-protocol`, `subc-control`,
   `subc-transport`, `subc-client-rs`, `subc-core` were repointed at the
   stubs, in the worktree manifest only. No `[patch]` was used. The logged
   `cargo metadata` output shows both version families resolving
   simultaneously and separately:
   - stub paths: `subc-protocol 0.12.0`, `subc-control 0.1.2`,
     `subc-transport 0.5.1`, `subc-client-rs 0.3.1`, `subc-core 0.3.1`;
   - crates.io registry (mc-host's dev-graph pins, untouched):
     `subc-protocol 0.10.0`, `subc-control 0.1.1`, `subc-transport 0.5.0`.
3. **Stub pass (`[stub-pass ...]`)** — targets compiled one at a time. Each
   failure was recorded before the stub changed (ledger entries 1 and 2),
   including the expected missing-`Ping` E0599 from `broca_roundtrip` before
   the variant was added.
4. **Final matrix (`[final-matrix]`, `[strict-derives final-matrix]`)** — with
   the final stubs, all five targets recompiled independently, then the
   feature-closure gate
   `cargo test -p mc-module --all-targets --all-features --no-run` passed
   (also logged pre-matrix as `[feature-closure]`). `--all-features` covers
   the one non-default feature, `drive-fault`.
5. **Derive-strictness sweep (`[strict-derives ...]`)** — a review of the
   first pass found the seeded stubs over-derived relative to inventory rows.
   All un-demanded derives and trait impls were stripped and the pass
   repeated: rustc then demanded the genuine trait surface (ledger entry 3),
   each demand was captured pre-fix, and two impls were proven un-demanded
   and removed. All demanded traits exist in the published sources, so no row
   changed status.
6. **Teardown** — the worktree and the external stub copy were removed;
   production `Cargo.toml`, `Cargo.lock`, and Rust sources in the primary
   checkout are unchanged. Only this evidence directory, the inventory, and
   the published-source probe/verifier artifacts were modified.

## Execution safety

No binary or test linked against the stubs was ever run: all verification used
`build` or `test --no-run`. Every stub function body is
`unimplemented!()` except the pure `ErrorBody::new` constructor
(`stubs/subc-protocol/src/lib.rs`), which carries its trivial field-assignment
body; it was never executed, like the rest of the stubs.

## Result

- Inventory totals move to **87 Rust rows: 83 exact / 3 changed / 0 absent /
  1 private-unknown** (`subc-core`, the daemon binary edge, unchanged).
- `docs/subc-api-surface-inventory-2026-08-17.md` updated: `Ping` row added,
  `ConsumerRole` row amended, totals and closure section reconciled.
- `docs/evidence/verify-rust-surface.py` re-run against the published crate
  sources with the two new checks; `verify-rust-surface.out` regenerated.
  Its 86 results map one-to-one onto the 86 published-crate rows (the 87-row
  total minus `subc-core`, the unpublished daemon edge): 84 present, 2 absent —
  the two `changed` rows whose text probes cannot appear in the published
  source; the third `changed` row, `ModuleManifest`, probes present. The
  amended `ConsumerRole` row carries one combined presence-plus-`PartialEq`
  probe rather than a second result.
- `docs/evidence/subc-surface-probe/tests/test_only_surface.rs` extended with
  the `Ping` and `ConsumerRole` equality shapes plus compile-time assertions
  for every trait bound the closure pass added to inventory rows (`Debug`,
  `Clone`, `PartialEq`, `std::error::Error` on the named types);
  `cargo check --all-targets` against the published crates passes.
