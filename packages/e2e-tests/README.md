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

Rust commands require `../commons`, `../subconscious`, Cargo, and `ck-mc`.
Absent prerequisites are unavailable, not passing. Public CI runs the supported
TS report only.

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
