# Research Plan: Inventory the Used `subc` API Surface
Created: 2026-08-17

Task: `magic-context-c50.1`

## Objective

Produce a reproducible inventory of the Rust and TypeScript `subc` API surface this repository actually requires, then choose one path:

1. Local crates with the existing `subc-*` names and compatible APIs.
2. A rewrite of the `mc-module` boundary against a repository-owned SDK.

The task ends with an evidence-backed decision recorded in `bd`. It does not implement either option.

## Deliverables

- A Rust inventory covering compile-time shape and runtime semantics for every used item from `subc-protocol`, `subc-transport`, `subc-control`, `subc-client-rs`, and `subc-core`.
- A TypeScript inventory covering imported exports, invoked methods, error contracts, and wire-visible behavior from `@cortexkit/subc-client`.
- A compatibility matrix comparing each Rust item with the latest published source.
- A binary shim-versus-rewrite decision, including rejected-option rationale and effects on `magic-context-c50.2`, `magic-context-c50.4`, and `magic-context-c50.5`.
- A complete task record in `bd` with inventory totals, evidence provenance, unknowns, and the decision.

## Scope

### Primary Rust Surface

- `crates/mc-module/Cargo.toml`
- `crates/mc-module/src/lib.rs`
- `crates/mc-module/src/main.rs`
- `crates/mc-module/src/historian.rs`
- `crates/mc-module/src/historian_producer.rs`
- `crates/mc-module/src/session_resolver.rs`
- `crates/mc-module/src/prompt_surface.rs`
- `crates/mc-module/tests/real_daemon.rs`

The repository-wide sweep must also catch fully qualified references, attribute macros, trait implementations, conditional compilation, and dependency declarations with no current call site.

### Primary TypeScript Surface

- `packages/plugin/src/hooks/magic-context/module-transport.ts`
- `packages/plugin/src/features/magic-context/memory/embedding-synapse.ts`
- `packages/plugin/src/features/magic-context/smart-notes/wake-plane.ts`

The latter two paths replace the stale locations in the bead description.

### Validation-Only TypeScript Surface

Direct consumers under `packages/plugin/scripts/` and `packages/e2e-tests/src/rust-runner/` must be classified separately. They can add compatibility requirements, but must not inflate the production surface without being labeled as tooling or test-only.

### Out of Scope

- Implementing shim crates or a replacement SDK.
- Designing the final host protocol.
- Building `mc-host`.
- Porting Synapse embedding or the smart-notes wake plane.
- Refactoring unrelated `mc-module` logic.

## Baseline Evidence

| Dependency | Locked or installed | Latest public source | Planning implication |
|---|---:|---:|---|
| `subc-protocol` | `0.12.0` | `0.10.0` | Public shapes are reference evidence, not the current contract. |
| `subc-transport` | `0.5.1` | `0.5.0` | Likely close, but every used item still needs a delta classification. |
| `subc-control` | `0.1.2` | `0.1.1` | Golden JSON fixtures can anchor control-message shapes. |
| `subc-client-rs` | `0.3.1` | `0.3.0` | Public consumer/provider traits are useful starting points. |
| `subc-core` | `0.3.1` | unpublished | Its required surface must come from call sites and compiler evidence. |
| `@cortexkit/subc-client` | `0.4.1` | exact package available | npm contains source and declarations, so no TypeScript API inference is needed. |

Both `../subconscious` and `../commons` are absent from the current checkout. The compiler-assisted Rust pass cannot produce valid closure evidence until `commons` is restored or the pass runs in an environment containing the matching sibling repository.

## Evidence Model

Each inventory row should record:

- dependency and fully qualified item;
- source file and build target;
- production, test, or tooling classification;
- required signature or data shape;
- required runtime behavior;
- published analogue and version;
- compatibility status: `exact`, `shape-compatible`, `changed`, `absent`, or `private/unknown`;
- decision weight: type-only, protocol-visible, lifecycle-critical, or error/recovery-critical.

Count API shape and semantic obligations separately. A small number of route, retry, or handler items can be more expensive to preserve than many passive structs or enums.

## Work Plan

### 1. Freeze the Evidence Set

- Record the repository revision, `Cargo.lock` versions, npm integrity, and corrected source paths.
- Enumerate every direct `@cortexkit/subc-client` import across `packages/` and classify it as primary production, test, or tooling.
- Acquire the exact npm `0.4.1` tarball and the latest published Rust crate tarballs from their registries.
- Record checksums and `.cargo_vcs_info.json` metadata where available so later comparisons are reproducible.

### 2. Build the Static Rust Inventory

- Scan imports and fully qualified paths across the library, binary, unit tests, and integration tests.
- Expand grouped imports to one inventory row per item.
- Capture attribute macros such as `async_trait`, trait method contracts, associated types, constructors, enum variants, constants, and public field access.
- Distinguish declared-only dependencies such as an unused or test-only `subc-core` edge from APIs required by production code.
- Link every item to the behavior that makes it necessary, rather than treating the import statement as sufficient evidence.

### 3. Build the TypeScript Inventory

- Inventory package exports used by the three primary files.
- Inventory methods called on `SubcClient` and route handles, including connect, route open, request, managed call, catalog list, route close, and client close where applicable.
- Record error identity and wire-visible fallback requirements, including stale-route detection, socket timeout/closure, reconnect classification, and `SubcCallError.kind`.
- Record option and identity shapes that cross the boundary, including priority, admission class, route target, bind identity, timeout, and connection-file discovery.
- Repeat the scan for scripts and E2E providers, keeping those requirements in a separate section.

### 4. Close the Rust Surface with Disposable Stubs

- Restore the matching `commons` sibling first; if it remains unavailable, report the compiler pass as blocked rather than claiming closure from static analysis.
- Use a disposable worktree or repository copy and redirect only the five `subc-*` dependencies to minimal same-name crates.
- Compile the library, binary, unit-test, and integration-test targets independently.
- Add only the signatures or shapes demanded by each compiler error, and map every addition back to an inventory row.
- Continue until no remaining diagnostic is caused by a missing or incompatible `subc` item.
- Preserve the stub source and compiler-error ledger as evidence only; neither is production implementation for `magic-context-c50.4`.

### 5. Compare Published Sources

- Compare each used Rust item against the corresponding published source and golden fixtures.
- Separate version drift from private-only additions.
- For changed items, record whether compatibility needs only a shape adjustment or requires daemon behavior.
- Do not infer `subc-core` internals from adjacent crates; mark unsupported claims as `private/unknown`.
- Use the exact npm source and declarations to verify the TypeScript inventory and error contracts.

### 6. Make the Binary Decision

| Criterion | Favors compatible shims | Favors boundary rewrite |
|---|---|---|
| Surface breadth | Small, stable set of passive types and narrow traits | Broad cross-crate surface or many private-only items |
| Semantic depth | Behavior maps directly onto the single-module host | Compatibility recreates routing, flow control, supervision, or general daemon policy |
| Published-source delta | Most critical items are exact or shape-compatible | Critical items are absent or materially changed |
| Ownership boundary | Existing handler boundary remains coherent | `subc` concepts leak through core module logic and obstruct a smaller SDK |
| Verification cost | Compiler closure plus focused contract tests can prove compatibility | Compatibility needs system-level emulation of unavailable infrastructure |

Choose shims only when all lifecycle-critical and error/recovery-critical rows can be implemented as a thin adapter over the planned host. Choose a boundary rewrite when compatibility would amount to maintaining a second partial `subc` daemon. Do not introduce a third option; any tactical adapter belongs inside the selected path.

### 7. Record and Hand Off

- Put the inventory summary, version matrix, unresolved unknowns, decision, and rationale in `magic-context-c50.1`.
- If a companion decision document is needed for large tables, store it in the repository and include its repo-relative path in the bead; the bead must still contain the decisive evidence and recommendation.
- State the resulting constraints for protocol design (`magic-context-c50.2`), Rust compatibility work (`magic-context-c50.4`), and the TypeScript client boundary (`magic-context-c50.5`).
- Close `magic-context-c50.1` only after the inventory and decision satisfy its acceptance criteria.

## Verification

- A fresh repository-wide search yields no unclassified `subc` references.
- Every compiler-discovered requirement maps to exactly one inventory row.
- Every used Rust item has a published-source status or an explicit `private/unknown` marker.
- TypeScript exports, methods, options, and error semantics reconcile with the exact npm `0.4.1` source.
- The selected option is justified by semantic complexity and migration blast radius, not symbol count alone.
- The `bd` record contains enough evidence for downstream tasks to proceed without repeating the spike.

## Contingencies

- If `commons` cannot be restored, finish the static and source-diff work but keep the task open with compiler closure explicitly blocked.
- If published sources conflict with current call sites, trust current repository call sites for required behavior and label the public source as stale reference evidence.
- If a requirement appears only in tests or diagnostics, retain it with that classification rather than silently promoting or dropping it.
- If the inventory exposes unrelated feature gaps, create separate beads under `magic-context-c50`; do not expand this spike into implementation.
