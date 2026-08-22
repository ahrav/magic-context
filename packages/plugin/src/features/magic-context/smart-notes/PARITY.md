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

### Fair selection cycles

The Rust authority owns multi-acquisition phase fairness through bounded
selection cycles scoped to one `(registration, slot, mode)`:

- A full-budget cycle grants fresh-claim quotas of 10 due, 5 compile, 3
  liveness, and 3 fallback, in that order. An `exclude_billable` (nonbillable)
  cycle exposes only due and liveness with quotas of 10 and 10. Empty phases
  and exhausted quotas advance to the next phase; once a phase is passed,
  newly eligible earlier-phase work waits for the next cycle, matching the
  legacy one-pass sweep shape.
- Cycle state is boot-ephemeral and lives on the registration slot. It
  survives interrupted drains, deadlines, and transport failures; unregister,
  lease expiry, route teardown, replacement registration, or process restart
  discards it. Restart-spanning fairness is out of scope.
- The cursor advances exactly once per fresh committed claim and resets only
  on a fresh durable `no_work`. Replayed claims, recovered slot claims,
  replayed `no_work`, `busy`, expiry, terminal replay, invalid identity,
  authority change, and store failures leave it unchanged, so acquisition
  replay stays idempotent.
- A fresh `no_work` therefore means "this mode's cycle is spent or nothing is
  eligible right now", not "the global queue is empty"; the worker treats it
  as a pass boundary and the next drain starts a new cycle.
- Fallback selection is deterministic in both authorities: unchecked notes
  first, then oldest `last_checked_at`, then note ID, and a cycle never claims
  the same fallback note twice (bounded in-cycle exclusion). Together these
  let every fallback note eventually receive a confirmation opportunity while
  false completions keep committing.
- Fixture ownership: the generated golden (`smart-note-evaluation-golden.json`)
  characterizes lifecycle transitions and the individual one-phase selectors,
  including fallback ordering and the named liveness quota. The hand-authored
  `cycle_trace_cases` in `smart-note-evaluation-normative.json` are the oracle
  for the stateful cycle policy (quotas, ordering across phases, exclusion,
  replay/reset rules) and are written from the requirements, never generated
  from either selector.
- The worker's client-side caps and duplicate-fallback guard remain as
  defenses against recovered claims (including a billable claim recovered by a
  nonbillable drain, which it abandons) and malformed authorities; normal
  quota exhaustion is answered authority-side with `no_work` instead of an
  over-cap claim-and-abandon.

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
- `magic-context-c50.7` (settled): direct `mc-host` is final-decision unsupported for `wake.create` and never advertises it; the worker heartbeat's affirmative wake-ownership report and owned-work suppression stay reserved for a deployment that owns the complete wake lifecycle (durable scheduling, agent-callable lifecycle operations, backlog adoption, and readiness withdrawal). Against the direct host, `wake_owned` stays false and standalone evaluation remains active in both authority modes.
