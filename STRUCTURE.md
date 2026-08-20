# Codebase Structure

This repository is a monorepo containing TypeScript packages (under `packages/`) and Rust crates (under `crates/`).

## Workspace Layout

```text
[project-root]/
├── crates/                 # Harness-agnostic Rust workspace
│   ├── mc-core/            # Cache-stability core transform & classifier
│   ├── mc-store/           # Durable cache-state store (SQLite backed)
│   ├── mc-tokenizer/       # Claude BPE token estimator
│   ├── mc-host/            # Direct-linked authenticated loopback host runtime
│   └── mc-module/          # Current subc module and future mc-host adapter
├── packages/               # TypeScript packages
│   ├── plugin/             # OpenCode plugin package (published as @cortexkit/opencode-magic-context)
│   ├── pi-plugin/          # Pi plugin package (published as @cortexkit/pi-magic-context)
│   ├── cli/                # Unified setup/doctor/migrate CLI (@cortexkit/magic-context)
│   ├── dashboard/          # Dashboard (Tauri-based)
│   ├── docs/               # Project documentation website
│   └── e2e-tests/          # End-to-end integration tests
├── scripts/                # Local maintenance and install scripts
├── docs/                   # Workspace design references for major subsystems
├── Cargo.toml              # Rust workspace configuration
├── package.json            # Monorepo workspace configuration
└── STRUCTURE.md            # This file
```

## Directory Purposes

**TypeScript Plugin (`packages/plugin/`):**
All paths below are relative to `packages/plugin/` — the published OpenCode npm package.

**`src/`:**

- Purpose: Keep all runtime, tool, config, and integration code.
- Contains: TypeScript source files and co-located `*.test.ts` files.
- Key files: `src/index.ts`, `src/plugin/tool-registry.ts`, `src/hooks/magic-context/hook.ts`

**CLI Sibling Package (`packages/cli/`):**

- Purpose: Provide the unified, harness-aware setup/doctor wizard for OpenCode and Pi.
- Location: `packages/cli/src/` — published as `@cortexkit/magic-context`. Invoked as `npx @cortexkit/magic-context@latest <subcommand>`.
- Contains: Command implementations (`packages/cli/src/commands/` including `migrate.ts` and `migrate-session.ts`), per-harness adapters (`packages/cli/src/adapters/`), shared prompt/path utilities (`packages/cli/src/lib/`).
- History: prior to v0.16.1 each plugin shipped its own `opencode-magic-context` / `pi-magic-context` bin. Those were collapsed into the unified `magic-context` bin; this `packages/plugin/` tree no longer contains a `src/cli/` directory.

**`src/agents/`:**

- Purpose: Define hidden agent identifiers and shared agent prompt helpers.
- Contains: Agent-name constants and prompt-building helpers.
- Key files: `src/agents/dreamer.ts`, `src/agents/historian.ts` (declares `HISTORIAN_AGENT` and `HISTORIAN_EDITOR_AGENT`), `src/agents/sidekick.ts`, `src/agents/magic-context-prompt.ts`

**`src/config/`:**

- Purpose: Parse and validate plugin configuration.
- Contains: Config loaders, re-exports, and Zod schemas.
- Key files: `src/config/index.ts`, `src/config/schema/magic-context.ts`, `src/config/schema/agent-overrides.ts`, `src/config/project-security.ts`, `src/config/transform-mode.ts`

**`src/plugin/`:**

- Purpose: Adapt internal services to OpenCode plugin interfaces.
- Contains: Hook wrappers, tool registry setup, RPC handlers, dream-timer lifecycle, conflict-warning delivery, per-session hook construction, boot quiet period enforcement, and tool backend overrides for Rust mode.
- Key files: `src/plugin/messages-transform.ts`, `src/plugin/event.ts`, `src/plugin/tool-registry.ts`, `src/plugin/hooks/create-session-hooks.ts`, `src/plugin/rpc-handlers.ts`, `src/plugin/dream-timer.ts`, `src/plugin/conflict-warning-hook.ts`, `src/plugin/boot-quiet.ts`, `src/plugin/rust-tool-backends.ts`

**`src/hooks/`:**

- Purpose: Hold hook implementations and hook-specific helpers.
- Contains: The `magic-context` runtime, the auto-update checker, and the Rust-mode execution adapter.
- Key files: `src/hooks/magic-context/hook.ts`, `src/hooks/magic-context/transform.ts`, `src/hooks/magic-context/transform-postprocess-phase.ts`, `src/hooks/magic-context/strip-content.ts`, `src/hooks/auto-update-checker/checker.ts`, `src/hooks/magic-context/rust-mode-transform.ts`, `src/hooks/magic-context/module-state-sync.ts`, `src/hooks/magic-context/module-wire.ts`, `src/hooks/magic-context/compaction-off-transition.ts`, `src/hooks/magic-context/child-session-spawn.ts`

**`src/tui/`:**

- Purpose: Render Magic Context sidebar and `/ctx-status` / `/ctx-recomp` dialogs inside OpenCode's TUI.
- Contains: TUI entrypoint, sidebar slot composition, RPC-backed data layer, type declarations.
- Key files: `src/tui/index.tsx` (registered via `./tui` export in `package.json`), `src/tui/slots/`, `src/tui/data/`, `src/tui/types/`
- Notes: Ships as raw TypeScript source, not bundled into `dist/index.js`. Loaded by OpenCode TUI via `tui.json` configuration.

**`src/features/`:**

- Purpose: Group reusable subsystem logic by feature.
- Contains: Magic-context services (storage, scheduler, tagger, search, message-index, overflow detection, compaction markers, session-project storage and backfill, clone-state copying), dreamer runtime, sidekick support, memory system, user-memory pipeline, git-commit indexer, tool-definition token measurement, schema migrations, built-in commands, and the smart-notes evaluation engine.
- Key subdirs: `src/features/magic-context/dreamer/`, `src/features/magic-context/memory/`, `src/features/magic-context/mural/`, `src/features/magic-context/sidekick/`, `src/features/magic-context/user-memory/`, `src/features/magic-context/git-commits/`, `src/features/magic-context/smart-notes/`, `src/features/builtin-commands/`
- Key files: `src/features/magic-context/storage-db.ts`, `src/features/magic-context/fail-closed-block.ts`, `src/features/magic-context/storage-schema-helpers.ts`, `src/features/magic-context/storage-clone.ts`, `src/features/magic-context/storage.ts` (barrel), `src/features/magic-context/migrations.ts`, `src/features/magic-context/message-index.ts`, `src/features/magic-context/search.ts`, `src/features/magic-context/session-project-storage.ts`, `src/features/magic-context/session-project-backfill.ts`, `src/features/magic-context/overflow-detection.ts`, `src/features/magic-context/context-authority.ts`, `src/features/magic-context/storage-identity-merge.ts`, `src/features/magic-context/schema-fence-probe.ts`, `src/features/magic-context/dreamer/task-executor.ts`, `src/features/magic-context/dreamer/lease.ts`, `src/features/magic-context/dreamer/manifest-parser.ts`, `src/features/magic-context/dreamer/provider-output-failure.ts`, `src/features/magic-context/memory/project-identity.ts`, `src/features/magic-context/memory/storage-memory.ts`, `src/features/magic-context/memory/embedding-synapse.ts`, `src/features/magic-context/mural/render-mural.ts`, `src/features/magic-context/user-memory/storage-user-memory.ts`, `src/features/magic-context/smart-notes/wake-plane.ts`, `src/features/builtin-commands/commands.ts`

**`src/tools/`:**

- Purpose: Define the agent-facing tool surface.
- Contains: One directory per tool with constants, types, implementation, and tests. Five tools: `ctx-reduce`, `ctx-expand`, `ctx-note`, `ctx-memory`, `ctx-search`. Includes light tool description presets in `src/tools/light-descriptions.ts`.
- Key files: `src/tools/ctx-reduce/tools.ts`, `src/tools/ctx-expand/tools.ts`, `src/tools/ctx-note/tools.ts`, `src/tools/ctx-memory/tools.ts`, `src/tools/ctx-search/tools.ts`, `src/tools/light-descriptions.ts`

**`src/shared/`:**

- Purpose: Keep cross-feature utilities small and dependency-light.
- Contains: Logging, path helpers, JSONC parsing, model helpers, runtime-detected SQLite backend (`bun:sqlite` / `node:sqlite`), harness identification, RPC server/client/types/utils/notifications, conflict detection & fixer, fallback chain resolver, models.dev cache, tag-transcript primitive shared with Pi, model-suggestion-retry helper, subagent runner (Pi-only), the commit-detection utility, harness-specific provider translation, process-wide exit-abort coordination, diagnostics numeric redaction, prompt surface preset resolution, and export-aware TUI runtime import specifiers mapping.
- Key files: `src/shared/logger.ts`, `src/shared/data-path.ts`, `src/shared/jsonc-parser.ts`, `src/shared/sqlite.ts`, `src/shared/rpc-server.ts`, `src/shared/rpc-client.ts`, `src/shared/conflict-detector.ts`, `src/shared/model-suggestion-retry.ts`, `src/shared/resolve-fallbacks.ts`, `src/shared/harness.ts`, `src/shared/tag-transcript.ts`, `src/shared/commit-detection.ts`, `src/shared/harness-provider-map.ts`, `src/shared/exit-abort-registry.ts`, `src/shared/redaction.ts`, `src/shared/escalation-bands.ts`, `src/shared/context-limit-provenance.ts`, `src/shared/storage-permissions.ts`, `src/shared/tui-runtime-specifiers.ts`, `src/shared/prompt-surface.ts`, `src/shared/prompt-surface-runtime.ts`, `src/shared/prompt-surface-a1-golden.ts`

**`scripts/`:**

- Purpose: Support local inspection, installation, and maintenance outside the plugin runtime.
- Contains: Bun and shell scripts for dumps and installation; package-specific inspection and benchmark scripts live under `packages/plugin/scripts/`.
- Key files: `scripts/context-dump.ts`, `scripts/install.sh`, `scripts/install.ps1`, `packages/plugin/scripts/tail-view.ts`, `packages/plugin/scripts/backfill-embeddings.ts`, `packages/plugin/scripts/build-schema.ts`, `packages/plugin/scripts/benchmark-tag-queries.ts`, `packages/plugin/scripts/benchmark-message-fts.ts`, `packages/plugin/scripts/export-project-identities.ts`
- Retrieval benchmark harness: `packages/plugin/scripts/benchmark-retrieval.ts` is the single CLI (`check`, `matrix`, `baseline-create`, `regression`; also exposed as the `bench:retrieval` / `bench:retrieval:check` package scripts) over the focused modules in `packages/plugin/scripts/retrieval-benchmark/` (`seed.ts`, `profiles.ts`, `metrics.ts`, `timing.ts`, `report.ts`, `runner.ts`, `regression.ts`). Versioned immutable artifact directories live under `packages/plugin/scripts/fixtures/retrieval-benchmark/`: `v1/` (reviewed release), `profiles/v1/` (`ci`, `arm-neon`, `x86-avx2`), and `baselines/v1/` (regression policy + quality/latency baselines; published atomically, never overwritten). CI runs the deterministic `ci` profile in `.github/workflows/ci.yml`; the reference-host matrix runs in `.github/workflows/retrieval-benchmark.yml` on self-hosted ARM64/X64 runners.

**`docs/`:**

- Purpose: Keep longer-lived subsystem design references, specs, and operational audit notes separate from root operational docs.
- Contains: `AUDIT-KNOWN-ISSUES.md` (known issues and audit notes), `cache-policy/` (cache invalidation specs), and `specs/` (subsystem specification drafts).
- Key files: `docs/AUDIT-KNOWN-ISSUES.md`, `docs/cache-policy/`, `docs/specs/`

**Rust Workspace (`crates/`):**

- Purpose: Implement the harness-agnostic core transform, tokenizer, state database, direct-linked host runtime, and current subc communication module in Rust.
- Contains: The following Rust packages:
  - `crates/mc-core/`: Core cache-stability transform and classification logic.
  - `crates/mc-store/`: Durable SQLite session database schema, metadata, and CAS transitions.
  - `crates/mc-tokenizer/`: tiktoken BPE-based token count estimator.
  - `crates/mc-host/`: Generic direct-linked host library. Owns secure instance publication, HMAC authentication, wire-v2 framing, control/catalog handling for the fixed two-target profile, process-global routes and epochs, bounded request settlement, Ping/Pong capability, and ordered shutdown behind repo-owned handler types. `src/composite.rs` dispatches routes across the two static components, and `src/synapse/` serves the certified offline embedding lane (bundle validation, dynamic ONNX Runtime, four-operation protocol, bounded ephemeral jobs). Production `McHandler` adaptation and client cutover are not in this crate.
  - `crates/mc-module/`: The current `subc` protocol adapter, autonomous historian coordinator, and client; a later task adds the one-way adapter from `mc-module` to `mc-host`.

**Pi Sibling Package (`packages/pi-plugin/`):**

- Purpose: Provide the Pi plugin implementation, mirroring OpenCode semantics and runtime features.
- Contains: Context transform pipeline, subagent runners, custom system-prompt caching, Pi-specific commands, and session state clone inheritance (`packages/pi-plugin/src/clone-inheritance.ts`).

## Key File Locations

Unless specified otherwise, TypeScript paths are relative to `packages/plugin/` and Rust paths are relative to the project root.

**Entry Points:**

- `src/index.ts`: Register the plugin, hidden agents (`historian`, `historian-editor`, `dreamer`, `sidekick`), hooks, commands, tools, RPC server, dream-schedule timer, and the auto-update checker.
- `src/tui/index.tsx`: Register TUI command-palette entries and the sidebar slot for OpenCode TUI.
- `packages/cli/src/index.ts`: Unified setup/doctor/migrate entry for the separate `@cortexkit/magic-context` package.
- `packages/cli/src/commands/migrate-session.ts`: Re-home OpenCode sessions across working directories/projects and database boundaries with domain authority verification.
- `packages/cli/src/commands/migrate.ts`: Migrate OpenCode sessions to Pi or OMP format with phase-tracked `migration_pending` recovery journaling.
- `packages/cli/src/lib/embedding-runtime.ts`: Probe the presence of the `onnxruntime-node` package and native platform binaries to verify local embedding runtime health.
- `packages/pi-plugin/src/index.ts`: Entry point for the Pi-specific plugin registering context handlers and hooks.
- `crates/mc-host/src/`: Generic host ownership boundaries (`instance`, `wire`, `control`, `routing`, `dispatch`, `connection`, `runtime`, and `composite`) plus the public handler and limit contracts; `synapse/` holds the embedding lane (`bundle`, `inference`, `protocol`, `jobs`).
- `crates/mc-host/tests/`: Independent raw-client, protocol-vector, filesystem-security, routing, dispatch, lifecycle, composite-routing, synapse bundle/protocol/job, and real-loopback composition tests, with the committed `fixtures/synapse-tiny/` model bundle.
- `crates/mc-module/src/main.rs`: Entry point for the current `subc` daemon module; direct-host production wiring remains deferred.

**Configuration:**

- `src/config/index.ts`: Load and merge config files with field-level fallback for invalid leaves; collect warnings rather than disable the plugin.
- `src/config/schema/magic-context.ts`: Define defaults and schema rules.
- `src/config/schema/agent-overrides.ts`: Define overridable built-in agents.
- `src/config/transform-mode.ts`: Resolve transform mode (TS vs Rust) based on configuration and system capabilities.
- `src/shared/prompt-surface.ts` and `src/shared/prompt-surface-runtime.ts` (with golden accessors in `src/shared/prompt-surface-a1-golden.ts`): Resolve prompt surface presets ("full" vs "light", 1825-token ceiling) and guidance selection.
- `assets/magic-context.schema.json`: Generated JSON schema, kept in sync via `packages/plugin/scripts/build-schema.ts`.

**Core Logic:**

- `src/hooks/magic-context/transform.ts`: Run the turn transform; orchestrate tagging, replay paths, prepareCompartmentInjection, and downstream postprocess hand-off.
- `src/hooks/magic-context/transform-postprocess-phase.ts`: Apply pending ops, heuristic cleanup, deferred-note nudges, **synthetic-todowrite injection (B7)**, and auto-search hints.
- `src/hooks/magic-context/hook.ts`: Compose runtime services.
- `src/hooks/magic-context/strip-content.ts`: Strip and replay reasoning, inline thinking, structural noise, dropped placeholders, merged-assistant reasoning, processed images, and system-injected messages.
- `src/hooks/magic-context/caveman.ts`: Experimental age-tier text compression for primary sessions.
- `src/hooks/magic-context/todo-view.ts`: Build the deterministic synthetic todowrite tool part and compute its hash-based `call_id`.
- `src/hooks/magic-context/supersession-reclaim.ts`: Select superseded spent control-plane tool outputs (oldest todowrite, ctx_reduce, zero-value meta calls) and older edit/write calls for the same file under the `smart_drops` configuration flag.
- `src/hooks/magic-context/tool-drop-target.ts`: Candidate selection for tool output reduction, protecting open tool arcs via `partHasCompletedResult` while reclaiming completed or errored arcs.
- `src/hooks/magic-context/sentinel.ts`: Decide provider predicates (such as `modelAcceptsEmptyContent` and `variantChangeBustsProviderCache`) controlling strip/flush behavior.
- `src/hooks/magic-context/hook-handlers.ts`: Prompt hook event handlers, provider-aware reasoning-variant flushes, and tool execution lifecycle hooks.
- `src/hooks/magic-context/edit-marker.ts`: Implement `edit_marker` mode to compress superseded edits, keeping the `filePath` and a region-hint prefix while dropping the bulky output content.
- `src/hooks/magic-context/module-transport.ts`: Send live Rust transform, authority, and tool requests over the subc protocol using `SubcClient` and `RouteHandle`, with bounded serialized request handling.
- `src/hooks/magic-context/rust-mode-transform.ts`: Orchestrate the experimental Rust transform mode, coordinating state sync and LKG (Last Known Good) fallback/replay logic.
- `src/hooks/magic-context/module-state-sync.ts`: Synchronize database state (memories, commits, tags, markers) between host (TS SQLite) and subc (Rust).
- `src/hooks/magic-context/module-wire.ts`: Translate wire messages, ordinals, and normalizations between host and Rust formats.
- `src/hooks/magic-context/lkg-slot.ts` and `src/hooks/magic-context/lkg-replay.ts`: Capture and replay the Last Known Good (LKG) transformed state on failure/parking.
- `src/hooks/magic-context/pass-outcome.ts`: Track the outcome of transform passes.
- `src/hooks/magic-context/emergency-fail-closed.ts`: Handle fail-closed cases under emergency context limit situations.
- `src/plugin/boot-quiet.ts`: Quiet background maintenance logging on startup.
- `src/plugin/rust-tool-backends.ts`: Define overrides for tool backends (`ctx_reduce`, `ctx_memory`) when running in Rust mode.
- `src/hooks/magic-context/inject-compartments.ts`: m[0]/m[1] history layout — `renderM0`/`renderM1`/`materializeM0`/`mustMaterialize` (mirrored in Pi's `inject-compartments-pi.ts`).
- `src/hooks/magic-context/decay-curve.ts`: Council-validated deterministic tier-decay math (half-life, log-cost tier boundaries, budget pressure).
- `src/hooks/magic-context/decay-render.ts`: Shared OpenCode+Pi compartment renderer built on the decay curve (replaces the removed LLM compressor).
- `src/hooks/magic-context/compartment-runner-incremental.ts`: v2 historian publish path — bounded reference blocks, tiered/scored compartments, faithful per-chunk facts, discard-last, events + `p1_embedding` on publish.
- `src/hooks/magic-context/wrapup-orchestrator.ts`: Orchestrate the manual `/ctx-wrapup` history compaction loop across sequential token-capped chunks.
- `src/hooks/magic-context/reference-retrieval.ts` (+ `reference-seeds.generated.ts`): 4 rotating seed compartments + last-6 recency references for the historian prompt.
- `src/hooks/magic-context/historian-prompt.generated.ts`: Generated v8.7.4 historian system prompt (source: `src/hooks/magic-context/historian-prompt.source.md`; re-exported via `compartment-prompt.ts`).
- `src/features/magic-context/memory/memory-migration.ts`: `/ctx-session-upgrade` 9-cat→5-cat memory re-eval (active-only, permanent-safe, epoch-bumping).
- `src/features/magic-context/memory/project-identity.ts`: Resolve stable project identities (`git:<sha>` or fallback `dir:<md5-12>`) using git root commits or directory hashes, caching directory fallbacks, and utilizing a cooldown period for transient git errors. Supported by `storage-identity-merge.ts` for row-level identity merging with durable audit logging (`identity_merge_log`), and `packages/plugin/scripts/export-project-identities.ts` for registry seed exports.
- `src/features/magic-context/context-authority.ts`: Manage domain authority states (`TS`, `PREPARING`, `MODULE`, `DRAINING`) and changefeed synchronization for shared memory and note state between TS host and Rust module.
- `src/features/magic-context/memory/embedding-synapse.ts`: The Synapse embedding provider client, which communicates with the `subc` daemon using RPC endpoints for certified local embedding generation.
- `src/features/magic-context/storage-db.ts`: Create durable storage; run versioned migrations; resolve runtime SQLite backend.
- `src/features/magic-context/storage-clone.ts`: Implement transaction-locked session state copy helpers for clone forks.
- `src/features/magic-context/storage-schema-helpers.ts`: Implement schema-mutation and NULL-healing helpers to avoid dependency cycles between database creation and migrations.
- `src/features/magic-context/storage-meta-persisted.ts`: Read and write per-session persisted scalars and JSON blobs.
- `src/features/magic-context/fail-closed-block.ts`: Implement loud fail-closed blocking when Magic Context cannot operate on a session, classifying active blocking processes across server, CLI/TUI, and Pi process kinds.
- `src/features/magic-context/schema-fence-probe.ts`: Probe schema version fence for child session spawns.
- `src/hooks/magic-context/compaction-off-transition.ts`: Reconcile per-session compaction mode records and process off/on mode transitions.
- `src/hooks/magic-context/child-session-spawn.ts`: Enforce child session spawn choke point with schema fence validation.
- `src/shared/escalation-bands.ts`: Derive context limit escalation bands and threshold bounds.
- `src/features/magic-context/migrations.ts`: Versioned schema migrations v1–v80 (`LATEST_SUPPORTED_VERSION` in `storage-db.ts` must track the highest; `schema-version-fence.test.ts` asserts they stay in lockstep). v79 adds the derived `notes_fts` trigram projection plus `notes_search_view` and its maintenance triggers, used only to prune note-search candidates. v80 adds the `memory_stats` telemetry side table (seen/retrieval counters and event timestamps, FK-cascading on memory deletion), the `memories_stats_ai` insert trigger, the retained-column freeze guard, and the value-sensitive `memories_au` FTS trigger; `memory_stats` is migration-owned and deliberately absent from `initializeDatabase`/`ensureColumn`.
- `src/features/magic-context/message-index.ts`: FTS-backed raw-message index for `ctx_search`.
- `src/features/magic-context/search.ts`: Unified retrieval over memories, raw messages, git commits, and session/smart notes.
- `src/features/magic-context/search-bounds.ts`: Fixed hard bounds for every search entry point — query byte/token/atom caps with explicit-reject vs automatic-truncate overflow modes, result-limit clamping (1–50), and the 150-candidate lane ceiling.
- `src/tools/ctx-search/render.ts`: Shared OpenCode/Pi explicit-result renderer — token-packs complete result blocks under 4,096 estimated tokens and bounds every dynamic field to 1 KiB before tokenization.
- `src/hooks/magic-context/auto-search-prompt.ts`: Shared bounded automatic-query extraction — single-pass streaming markup stripper (plugin blocks drop with content, user markup keeps inner text) retaining at most 16 KiB, then deterministic truncation to the query caps.
- `src/shared/token-estimator.ts`: Claude-encoding token estimation with a latched character-heuristic fallback (re-exported from `hooks/magic-context/read-session-formatting.ts` for compatibility).
- `src/features/magic-context/session-project-storage.ts`: Persist session-to-project bindings and repair mis-scoped compartment chunk embeddings.
- `src/features/magic-context/session-project-backfill.ts`: Run the background session-project backfill task (gated on the plugin enabled state).
- `src/features/magic-context/smart-notes/sandbox-runner.ts`: Run smart-note JS check expressions within a serialized process-wide QuickJS WASM sandbox.
- `src/features/magic-context/smart-notes/wake-plane.ts`: Discover fleet scheduled-wake plane capability (`wake.create`) via subc catalog probes and gate standalone smart-note condition evaluation.
- `src/shared/commit-detection.ts`: Unified git commit hash and verb detection logic, shared across the historian trigger and note-nudge detectors.
- `src/shared/harness-provider-map.ts`: Translate provider prefixes between canonical (OpenCode) and Pi configuration models.
- `src/shared/exit-abort-registry.ts`: Provide a process-wide coordinator to abort active controllers without exceeding listener caps.
- `packages/pi-plugin/src/context-handler.ts`: Core context transform and hook handler for the Pi plugin.
- `packages/pi-plugin/src/clone-inheritance.ts`: Intercept Pi `session_start` fork events and inherit filtered session compartments, tags, and markers.
- `packages/pi-plugin/src/subagent-runner.ts`: Win32/POSIX-safe subagent executor with command-line length cap mitigations.
- `packages/pi-plugin/src/commands/ctx-wrapup.ts`: Implement the `/ctx-wrapup` command and orchestrator for Pi sessions.
- `packages/pi-plugin/src/dreamer/pi-session-api.ts`: Resolve `pi-coding-agent` module and session APIs, using a memoized resolution ladder to support symlinked or nonstandard Pi installs.
- `packages/pi-plugin/scripts/experiments/perf/`: Run performance benchmarks and regression checks against production-registered context transform hooks.
- `crates/mc-module/src/transform.rs`: Evaluates transform passes, applies modifications like metadata tag injection and history compaction in Rust, renders temporal overlays (tag numbers and time gap markers), self-heals boundary divergence, and strips leading model-authored tag imitation prefixes from assistant messages.
- `crates/mc-module/src/historian.rs`: Evaluates pressure and schedules/runs incremental historian summarizations in Rust.
- `crates/mc-module/src/injection.rs`: Builds the `m0`/`m1` structures and injects synthetic message parts in Rust.
- `crates/mc-module/src/boundary.rs`: Resolves the boundary between compactable history and the protected tail in Rust.
- `crates/mc-module/src/session_resolver.rs`: Resolves incoming MCP facade requests to their backing project and session.
- `crates/mc-module/src/lib.rs`: Route subc client requests, implement MCP tool facade routing (supporting `agent_drops.append` queue drops with server-side range parsing and command-id idempotency checks), serve prompt guidance, manage durable pass tracing for transform passes, orchestrate `session.status`, `session.wrapup`, and `session.delete` operations (utilizing structured status fields, machine-readable dispositions, and process-local per-session latches under a `MAX_WRAPUP_REQUEST_BUDGET` deadline, with `session.delete` atomically removing session-owned rows from SQLite tables), track transform dispatch health metrics and heartbeat reporting, manage LRU-bounded `InFlight` snapshot caching, and coordinate bootstrap state imports using `StateImportCoordinator`.
- `crates/mc-module/src/historian_producer.rs`: Implement the Rust subc historian producer client using the wire v2 protocol with `OpenedRoute` targeting (channel and epoch routing).
- `crates/mc-store/src/lib.rs`: Define durable session schemas and migrations (including the `mc_reduce_command_ledger` table in migration 16 for idempotency, `mc_project_mural_artifacts` in migration 49 for project mural artifacts, and `raw_messages_deflate` in migration 50 on `mc_chunk_transcripts` for durable `ctx_expand` recovery), handle metadata, and run CAS transitions.
- `crates/mc-module/src/codec/`: Decode harness-specific JSON messages (OpenCode, Pi) into canonical `CkIngressMessage` values and encode them back using harness model codecs.
- `crates/mc-module/src/caveman.rs`: Age-tier caveman text compression ported to Rust.
- `crates/mc-module/src/divergence.rs`: Per-pass transform output divergence tracking and attribution.
- `crates/mc-module/src/healing.rs`: Define serializer healing profiles and gate tail mutations for verbatim-tail consumers to prevent phantom reclaims.
- `crates/mc-module/src/selection.rs`: Implement tail-reduction selection to decide which tail items to reduce and produce their `ReductionDecision`s.
- `crates/mc-module/src/retained_size.rs`: Calculate allocator-oriented retained-size estimates for memory-budgeted module holders.
- `crates/mc-module/src/differential_goldens.rs`: Validate in-process Rust transform outputs against TS-generated wire fixtures (DG-1..3 goldens).

**Tests:** Co-locate tests with source as `src/**/*.test.ts`, for example `src/hooks/magic-context/hook.test.ts`, `src/tools/ctx-memory/tools.test.ts`, and `src/features/magic-context/migrations-v11.test.ts`. End-to-end coverage lives in the separate `packages/e2e-tests/` workspace.

## Naming Conventions

**Files:** Use kebab-case for multiword module files and reserve `index.ts` for barrel exports or package entry modules: `transform-postprocess-phase.ts`, `storage-memory.ts`, `compartment-runner-historian.ts`, `index.ts`.

**Test co-location:** Test files use the `.test.ts` suffix and sit next to the source they cover. Migration tests use a `migrations-v<N>.test.ts` convention.

**Directories:** Group by feature first, then by tool or subsystem name: `src/features/magic-context/dreamer/`, `src/features/magic-context/memory/`, `src/tools/ctx-memory/`, `src/hooks/magic-context/`.

## Where to Add New Code

**New CLI command:** add it in `packages/cli/src/commands/` (the unified `@cortexkit/magic-context` package) and wire it from `packages/cli/src/index.ts`.

**New OpenCode hook adapter:** add the adapter in `src/plugin/` and keep the runtime logic in `src/hooks/magic-context/`.

**New magic-context transform or event helper:** add it under `src/hooks/magic-context/` and wire it through `src/hooks/magic-context/hook.ts`.

**New tool:** add `src/tools/[tool-name]/`, export it from the tool entry, and register it in `src/plugin/tool-registry.ts`. Remember to wire conditional schema narrowing for primary-vs-dreamer-only actions inside `tools.ts` if the tool has restricted actions.

**New built-in slash command:** add the command definition in `src/features/builtin-commands/commands.ts` and handle execution in `src/hooks/magic-context/command-handler.ts`. If the command needs a native TUI dialog, also push a notification via `pushNotification()` in `src/plugin/rpc-handlers.ts` and consume it in `src/tui/index.tsx`.

**New Rust transform logic or state mutation:** add it in `crates/mc-core/src/` if it is general cache-stability or classification math, or `crates/mc-store/src/` if it affects durable schemas or database mutations, or `crates/mc-module/src/transform.rs` if it is a transform pass operation.

**New Rust handler operation:** add module business logic in `crates/mc-module/src/lib.rs`. Keep socket framing, authentication, route allocation, correlations, settlement, and shutdown ownership in `crates/mc-host/`. Production adapter or binary wiring belongs in `mc-module`; `mc-host` must not depend on `mc-module`.

**New direct-host protocol behavior:** add it at the owning boundary in `crates/mc-host/src/` and prove it with the independent raw client under `crates/mc-host/tests/`. Do not add client-only retry policy or module business logic to the host.

**New Pi-plugin specific hook or adapter:** add it in `packages/pi-plugin/src/` (and ensure parity with OpenCode counterparts under `packages/plugin/`).

**New feature service:** add it under `src/features/magic-context/[feature-area]/` (preferred for cohesive subsystems like the message index, git-commits, user-memory) or as a focused single-file module under `src/features/magic-context/` when it stays small.

**New hidden agent:** add the agent constant in `src/agents/[agent-name].ts`, add prompt text near the owning feature (e.g. `src/features/magic-context/dreamer/task-prompts.ts`, `src/hooks/magic-context/compartment-prompt.ts`), and register it from `src/index.ts` via `buildHiddenAgentConfig`.

**New schema migration:** add a new versioned entry in `src/features/magic-context/migrations.ts` (next version number after the current highest) and add a co-located `migrations-v<N>.test.ts`. **Bump `LATEST_SUPPORTED_VERSION` in `storage-db.ts` to the new version** — it is the schema-fence ceiling, and a stale value makes the DB refuse to open after the migration applies (real bug caught during v2 work). Update the fresh-DB schema in `storage-db.ts` so new installs start at the latest shape without needing migration replay. Add `ensureColumn()` calls in `storage-db.ts` initialization for new columns so upgraded DBs catch up reliably even if a migration row is lost. If the new table/column is session-scoped, add it to `clearSession()` so it doesn't leak orphaned rows on session deletion.

**New RPC endpoint:** register the handler in `src/plugin/rpc-handlers.ts`, declare types in `src/shared/rpc-types.ts`, and consume from TUI via `src/tui/data/` modules.

**Shared utility:** add it in `src/shared/` only when at least two subsystems use it. Cross-runtime utilities (Bun/Node/Electron) belong here so the SQLite backend selector and harness identification stay in one place.

**Tests:** add a co-located `*.test.ts` file beside the implementation you change. For end-to-end coverage across OpenCode/Pi sessions, add scenarios under `packages/e2e-tests/tests/`.
