# Smart-note compiled-check parity

The compiled-check runner and SSRF guard live in `packages/plugin/src/features/magic-context/smart-notes` and are shared by OpenCode/Bun and Pi/Node via the Pi package's `@magic-context/core/*` path mapping.

Security parity coverage:

- `ssrf-guard.test.ts` exercises the fail-closed bypass classes in-process under Bun.
- `ssrf-guard.parity.test.ts` bundles the same guard module for `target: "node"` and runs the same public-vs-mixed-private DNS classification under Node. Electron uses the same Node `dns`, `https`, and `net` APIs for this module, so the Node parity test is the executable proxy for Electron.
- The guard does not use Bun-only APIs; socket connection is via Node-compatible `https.request` with a pinned `lookup` result.

## Evaluator authority boundary (protocol v2)

The evaluation lifecycle is one versioned transition contract shared by both
state authorities:

- `evaluation-state.ts` is the TypeScript reducer; `crates/mc-module/src/smart_note_evaluation.rs` is the Rust port. Both replay the frozen characterization fixture `crates/mc-module/testdata/smart-note-evaluation-golden.json` (transitions, DST schedule vectors, phase selection). Regenerate with `bun crates/mc-module/gen/gen-smart-note-evaluation-golden.ts`; a regeneration diff means a semantic change and requires review. The generator pins frozen copies of the legacy writers so neither reducer is its own oracle.
- `evaluator.ts` maps compiler/sandbox/confirmation results to semantic outcomes; cancellation is an abandonment, never a failure outcome, in both authorities.
- `runCompiledSmartNoteCheck` remains the only execution entry point for general compiled conditions in both modes. The Rust authority never executes note-authored code; it recomputes the canonical artifact digest (condition, code, manifest, cron separated by NUL bytes, SHA-256) from its authoritative condition before persisting any compile outcome.
- Worker transport: `evaluator-worker.ts` polls `note.evaluation.next` (protocol 2.0, zero wait) over a dedicated transport connection. It deliberately holds no process-wide QuickJS slot reservation across a claim: each sandbox execution serializes itself for exactly its own window, so a claim lease (minutes) never pins the shared sandbox slot across an LLM round-trip and one project's claim cannot stall another project's sweep. Registration is boot-ephemeral: module restart, route teardown, or heartbeat expiry withdraws availability, and conditioned `ctx_note` writes fail closed without a live protocol-2.0 registration.

### Downgrade / rollback provenance

The v51 store migration installs a persistent note-writer fence backed by the
`mc_note_writer_v2` SQLite function, registered in `McStore::open` before
migrations. Any pre-v51 binary of this repository (any build of commit
`b7c6ba99` or earlier, the branch point of this work) does not register that
function, so every `mc_notes` mutation it attempts against a migrated store
fails closed with "no such function". The store test
`mc_notes_writer_fence_blocks_connections_without_the_v2_function` exercises exactly
that artifact behavior by opening the migrated database with a raw connection
that lacks the function. Supported rollback is drain-to-TypeScript plus
restoring a pre-v51 store snapshot, or roll-forward; same-file binary
downgrade is read-only/degraded by design.

### Deferred ownership

- `magic-context-pml.1`: shared Rust cron/schedule primitive (the port in `smart_note_evaluation.rs` is the reference).
- `magic-context-pml.3`: Rust scheduler cadence and positive-wait polling; blocked on correlation-scoped cancellation, an independent heartbeat lane, per-slot pending-poll limits, bounded poll quotas, and cancellation-safe waiter removal.
- `magic-context-c50.5`: stricter transport send-outcome handling; this protocol stays safe across it through application-owned acquisition and completion IDs.
- `magic-context-c50.7`: `wake.create` support; the worker heartbeat reports affirmative wake ownership and the module suppresses owned work during selection without treating the evaluator as disconnected.
