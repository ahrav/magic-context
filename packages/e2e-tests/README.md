# @cortexkit/opencode-magic-context-e2e

End-to-end test harness for the Magic Context plugins (OpenCode and Pi). Spawns
a real `opencode serve` subprocess (or a Pi child process) pointed at a local
mock Anthropic server and drives sessions through the appropriate harness.

> Note: the package name retains its original `-e2e` suffix from when this only
> covered OpenCode; Pi e2e coverage was added alongside under `tests/pi-*.test.ts`.

## Running

Every green command resolves an exact, nonempty file list from
`mode-manifest.json`. No command relies on a test glob.

```bash
# Default supported TS green suite (OpenCode and Pi)
bun run --cwd packages/e2e-tests test

# Exact harness green suites
bun run --cwd packages/e2e-tests test:opencode-e2e
bun run --cwd packages/e2e-tests test:pi-e2e

# Incident contracts, verifiers, runner, evidence, and history fixtures
bun run --cwd packages/e2e-tests test:incident-unit

# Conservative contributor gate against mutation-bound verifier drift
bun run --cwd packages/e2e-tests validate:incident-verifiers

# Supported TS incident schedule: OpenCode plus applicable Pi variants
bun run --cwd packages/e2e-tests test:incidents --mode ts

# Provisioned-host Rust green suite and incident report
bun run --cwd packages/e2e-tests test:rust-e2e
bun run --cwd packages/e2e-tests test:incidents:rust
```

The OpenCode command includes `tests/oracle-arms-demo.test.ts`. This demo is
registered as TS-only because `seedGoldMemories` writes through the TypeScript
memory authority; it does not run in the Rust lane.

Rust commands require Unix socket support, Cargo, and this repository's own
Cargo workspace metadata for the `direct_host_fixture` example. Absent
prerequisites are unavailable, not passing. Public CI runs the supported TS
report only.

### Incident report artifacts

The TS command atomically writes
`packages/e2e-tests/artifacts/incident-pool-ts-report.json`. The provisioned
Rust command writes
`packages/e2e-tests/artifacts/incident-pool-rust-report.json`. CI uploads only
the explicit TS path.

Both files use `incident-pool-scheduled-report/v1`. Each scheduled report has a
mode, harness report count, expected/result counts, distinct family count,
`evaluation_complete`, and `completion_marker: true`. Nested
`incident-pool-report/v1` entries bind one harness to its ledger fingerprint,
selected-set digest, expected count, and terminal results.

Each result keeps three independent dimensions:

- `run_health`: `completed`, `timeout`, `crash`, `unavailable`, or `malformed`;
- `behavioral_verdict`: `pass`, `assertion_fail`, or `not_evaluated`;
- `baseline_comparison`: `expected_green`, `regression`, `expected_red`,
  `unexpected_failure`, `resolution_candidate`, or `unscored`.

Structural completion means every selected variant produced exactly one
allowlisted terminal result and publication completed atomically. Evaluation
completion means every result completed with a behavioral verdict and scored
baseline comparison. Reviewed `blocked_by` incompleteness may exit zero while
`evaluation_complete` remains false. Other incomplete results exit nonzero.

See `incidents/README.md` for approved registration and append-only rules.

## Architecture

- **`src/mock-provider/server.ts`** — Anthropic-compatible mock HTTP server. Accepts
  POST `/messages`, supports both SSE streaming (default for OpenCode) and single-shot
  JSON, lets tests script responses with precise control over
  `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`.
  Captures every request body for assertions.

- **`src/opencode-runner/spawn.ts`** — Subprocess runner that launches `opencode serve`
  with an isolated config/data/cache directory, a custom `mock-anthropic` provider
  pointed at the mock, and the magic-context plugin loaded from local source via
  `file://` spec. No npm install required; the plugin is loaded directly from
  `packages/plugin/src/index.ts`.

- **`src/pi-runner/`** + **`src/pi-harness.ts`** — Pi-flavored counterpart to the
  OpenCode runner. Spawns a real Pi child process pointed at the same mock
  Anthropic server and loads the Pi plugin from local source.

### Oracle arms

`src/oracle-arms/` provides controlled interventions for attributing a failed
scenario to retrieval, formation, or representation. The helpers operate on a
`TestHarness` unless noted otherwise:

- `seedGoldMemories({ workdir, dbPath, rows, verification })` inserts each
  `{ category, content, importance? }` through the production claim-aware write
  path and returns the inserted `Memory[]`. Use `"candidate"` for search-only R1
  rows and `"verified"` for injection-eligible R2 rows. `context.db` must already
  exist or the helper throws without creating it. Inserts commit one at a time;
  duplicate normalized content raises SQLite's `UNIQUE constraint failed` error
  and leaves earlier inserts committed. A verified row disappearing during
  promotion also throws.
- `scriptedCtxSearchTurn(harness, sessionId, idsOrQuery)` executes one real
  `ctx_search` tool turn and returns its wire `tool_result` text. An id array may
  contain positive safe integers or objects with an `id`; it must contain 1–5
  entries and is rendered in caller order as `#id` tokens. Larger sets are
  rejected, not chunked. A string is used as the query unchanged. The helper
  propagates tool-loop infrastructure failures, including an unpublished
  `ctx_search`, and its shared driver resets the mock and removes installed
  matchers, so reinstall extra matchers before the next step.
- `goldEvidencePrompt(blocks)` renders `{ label, content }` values as
  `<gold-evidence label="...">` blocks separated by blank lines. It returns the
  prompt string for `harness.sendPrompt`; labels and content are passed through
  rather than escaped or validated.
- `mcOffOptions()` returns `{ openCodeConfigExtra: { plugin: [] } }`. There is no
  `ctx_search` tool or `<project-memory>` block in this arm.
- `naiveCompactionOptions()` returns
  `{ openCodeConfigExtra: { compaction: { auto: true } } }`. Conflict handling
  disables Magic Context and no `context.db` is initialized, so gold seeding
  fails its database precondition.
- `liveModelSpawnOptions({ apiKey, providerBlock })` returns the `extraEnv` and
  `openCodeConfigExtra` portion of raw `SpawnOptions`. It sets
  `ANTHROPIC_API_KEY` and installs the supplied provider map; it does not send a
  request or validate provider contents.

The demonstration uses this capability matrix:

| Capability | R0 | R1 | R2 | R3 | MC-off | Compaction |
|---|---|---|---|---|---|---|
| Gold rows | none | candidate | verified | none | none | unavailable: no DB |
| Scripted `ctx_search` | no | yes, by returned ids | no | no | unavailable | unavailable |
| Gold evidence prompt | no | no | no | yes | yes | yes |
| Main-agent observation | no gold | search result only; no injection | gold in `<project-memory>` | prompt verbatim | no tool or memory block | no tool or memory block |
| Preset | none | none | none | none | `mcOffOptions()` | `naiveCompactionOptions()` |

Keep these four traps explicit when building a scenario:

1. **`normalized_hash` uniqueness:** use distinct gold content. Duplicate content
   throws after any earlier rows have committed.
2. **Resolved project identity:** pass the harness workdir. Seeding applies
   `realpath` and `resolveProjectIdentity`; do not construct or copy a
   `project_path` value.
3. **`memory_block_cache`:** seed before `createSession()` so a cached empty
   memory block cannot mask gold rows. Claim-aware writes also advance the
   project memory epoch, which invalidates a session cache when mid-session
   seeding is unavoidable.
4. **`visibleMemoryIds`:** rows already injected into a session are filtered from
   `ctx_search`. Run arms in separate sessions and seed R1 rows as candidates so
   they remain explicit-search eligible without being injected.

For a live-model configuration check, compose the recipe with raw
`spawnOpencode`:

```ts
const live = liveModelSpawnOptions({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    providerBlock: {
        anthropic: {
            api: "@ai-sdk/anthropic",
            name: "Anthropic",
            npm: "@ai-sdk/anthropic",
            env: ["ANTHROPIC_API_KEY"],
            models: {},
        },
    },
});
const opencode = await spawnOpencode({ mockProviderURL: baseURL, ...live });
```

`openCodeConfigExtra` is shallowly spread, so `providerBlock` replaces the
entire default provider map. Include a complete `mock-anthropic` entry beside
the live provider if later prompts still use the mock. Also,
`RustTestHarness.restart()` drops `openCodeConfigExtra`; rebuild or reapply the
recipe after a restart. The shipped test only checks the generated config and
never calls a live model.

Callers own scoring and aggregation. Given scores R0 through R3, compute regret
as retrieval = R1 - R0, formation = R2 - R1, and representation = R3 - R2.

### Pi RPC harness

Pi e2e tests run through `pi --mode rpc`, not `pi --print --mode json`. Each
`PiTestHarness` owns one persistent Pi subprocess for its lifetime and talks to
it over strict JSONL on stdio: commands are newline-delimited JSON objects on
stdin, while stdout interleaves `type: "response"` command replies with async
agent events such as `agent_start`, `message_end`, and `agent_end`.

`harness.sendPrompt()` sends a `prompt` RPC command, collects the event slice
from `agent_start` through `agent_end`, and returns the historical
`PiRunResult` shape. Because the Pi process remains alive after each turn,
`exitCode` and `signalCode` are `null` until `harness.dispose()` shuts the
worker down. Multi-turn tests do not need `--continue`; the existing
`continueSession` option is accepted as a compatibility no-op.

The harness also exposes thin RPC helpers for tests that need persistent-process
state directly: `getState()`, `getMessages()`, `getSessionStats()`,
`compactNow()`, and `newSession()`.

RPC mode is available in the installed Pi peer range. The current peer is
`@earendil-works/pi-coding-agent@^0.71.0`; the lockfile resolves `0.71.1`, whose
packaged docs specify the JSONL RPC protocol, and the changelog shows the
current JSON protocol was introduced in `0.16.0`.

- **`tests/*.test.ts`** — Test suites. OpenCode-flavored suites use `harness.ts` /
  `opencode-runner`; Pi-flavored suites (`tests/pi-*.test.ts`) use `pi-harness.ts` /
  `pi-runner`. Each test creates a session, sends prompts, and asserts against
  SQLite state, log output, and captured mock requests.

- **`tests/rust-*.test.ts`** — Rust-mode lane. Starts the repository-local
  `direct_host_fixture`, then drives OpenCode → plugin → `McHostModuleTransport`
  → real `McHandler`. `src/rust-runner/hermetic-mc-host.ts` owns fixture build,
  managed-client readiness, bounded backend controls, and teardown. Run the broad
  lane separately:

  ```bash
  # From repo root
  bun run --cwd packages/e2e-tests test:rust-e2e
  ```

  U7 qualifies only the focused fixture, smoke, and historian scenarios. Broad
  Rust-mode matrix, mutation, performance, and release qualification remain
  downstream work.

### Rust-mode lane: how it works

The harness builds the `mc-module` `direct_host_fixture` example and starts it
under each test's owner-only data directory. Fixture directly composes real Magic
Context, Synapse, and Broca components. Readiness requires its private control
socket, version-2 connection publication, and a successful managed-client catalog
probe. Closed JSONL controls select backend success, blocking, release, typed
failure, counters, or graceful shutdown. Host crash, restart, pause, and resume
controls act on the whole direct host.

`RustTestHarness.detectPrereqs()` checks Unix socket support, Cargo, and current
repository metadata. Missing sibling checkouts and removed binaries do not affect
this lane.

**Pressure technique (load-bearing apparatus rule):** scenarios reach high fill
by SHRINKING the context limit against REAL message bytes, never by inflating
reported usage. The two techniques are not interchangeable: inflated usage moves
only fill-keyed conditions (execute thresholds, force bands) while every
real-byte-keyed condition (reclaimable-tail pressure, tail-size trigger floors,
chunk substance) stays silently unreachable — a harness built that way passes
every fill-keyed test honestly while structurally unable to exercise the other
axis, with nothing announcing the gap. (Observed live 2026-08-14 in a peer
gateway's drive container: 44 passes, fill 80→86%, `eligible_chunk_tokens`
pinned at exactly 0.0 the whole time.) If a scenario needs a shortcut, shrink
the window; if you must inflate, document which asserted conditions become
unreachable.

### CI

The broad Rust-mode lane is not part of the default host suite. Focused direct-host
coverage runs with Cargo and this repository; broader matrix qualification remains
separate from U7.

## Requirements

- `opencode` CLI available on PATH for OpenCode suites (`which opencode`).
- Pi CLI installed for Pi suites (see `packages/pi-plugin/README.md`).
- Bun.
- For the Rust-mode lane (`tests/rust-*.test.ts`): Unix sockets, `cargo` on PATH,
  and the current repository checkout. Fixture builds on demand.
- No `OPENCODE_SERVER_PASSWORD` required — the spawner explicitly strips it so the
  test server runs unsecured on a random localhost port.

## Writing a test

```ts
import { MockProvider } from "../src/mock-provider/server";
import { spawnOpencode } from "../src/opencode-runner/spawn";

const mock = new MockProvider();
const { baseURL } = await mock.start();
const opencode = await spawnOpencode({ mockProviderURL: baseURL });

// Script exactly what the main agent should return on each turn.
mock.script([
    { text: "response 1", usage: { input_tokens: 10_000, output_tokens: 50 } },
    { text: "response 2", usage: { input_tokens: 50_000, output_tokens: 50, cache_read_input_tokens: 10_000 } },
]);

// Drive the session via the SDK.
const { createOpencodeClient } = await import("@opencode-ai/sdk");
const client = createOpencodeClient({ baseUrl: opencode.url });
const { data: session } = await client.session.create({ query: { directory: opencode.env.workdir } });
await client.session.prompt({
    path: { id: session!.id },
    body: {
        model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
        parts: [{ type: "text", text: "turn 1" }],
    },
});

// Assert against captured requests and plugin state.
expect(mock.requests().length).toBe(1);

await opencode.kill();
await mock.stop();
```
