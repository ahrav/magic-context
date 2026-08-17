# Manual Attack-Surface Inventory

Phase: L4 (balanced lite probe)  
Commit inspected: `be500459546101a18126e2ce5f25eb06a17bb620`

## Selection Basis

`candidates-summary.md` ranks dynamic-code execution, command execution, filesystem access, raw SQL, hidden control channels, and SSRF-capable requests as the main candidate classes. Many top `dynamic-code-execution` matches are scanner false positives for SQLite `db.exec()` or `RegExp.exec()`, so this pass selected slices by crossed trust boundary and sink impact rather than raw match count.

## Selected High-Impact Slices

1. **DFD-1 / CFD-3: repository, conversation, and model content → hidden Pi/OMP subagents → host tool capabilities.** This slice covers the highest-impact command/file sink: attacker-influenced repository data reaches unattended agents running with the developer's OS account.
2. **DFD-2 / CFD-1: browser or network client → dashboard serve authentication/dispatch → local SQLite, configuration, subprocess, and outbound-network authority.** This is the only repository-owned network surface that can intentionally bind beyond loopback and therefore the highest-impact public-route slice.

## Entry Points

| Entry point | Location | Inputs | Reachable authority |
|---|---|---|---|
| Pi/OMP extension boot | `packages/pi-plugin/src/index.ts:723,948` | Host lifecycle, current project, merged user/project config | Registers hooks/tools, configures child-extension policy, opens shared storage, schedules hidden work |
| Pi dreamer client facade | `packages/pi-plugin/src/dreamer/index.ts:253-306` | Shared dream-task prompt body including `agent`, system prompt, and user message | Starts a hidden Pi/OMP process through `PiSubagentRunner.run` |
| Pi historian | `packages/pi-plugin/src/pi-historian-runner.ts:453,818-828` | Raw session transcript assembled into a historian prompt | Hidden child process with intended read-only tools |
| Pi sidekick command | `packages/pi-plugin/src/commands/ctx-aug.ts:93-168` | User prompt plus retrieved context | Hidden child process with intended read/search-only tools |
| Smart-note compiler/confirmation | `packages/plugin/src/features/magic-context/smart-notes/compiler.ts:70-141`; `packages/plugin/src/features/magic-context/dreamer/evaluate-smart-notes.ts:430-512` | Note content and `surface_condition`, explicitly labeled untrusted | Hidden `smart-note-compiler` child intended to have zero tools; validated output later executes in bounded QuickJS |
| Dreamer task executor | `packages/plugin/src/features/magic-context/dreamer/task-executor.ts:1160-1250` | Memory pool, project path, project docs, task prompt | Curate memory actions or maintain-docs file/bash actions through task-specific child agents |
| Dashboard serve CLI mode | `packages/dashboard/src-tauri/src/serve/mod.rs:45-116` | `--serve`, port, `--host`, `--allow-remote` | Starts Axum listener; non-loopback requires explicit acknowledgement |
| Dashboard router | `packages/dashboard/src-tauri/src/serve/mod.rs:136-163` | HTTP method/path/headers/body | Public embedded UI plus bearer-protected API subtree |
| Dashboard invoke handler | `packages/dashboard/src-tauri/src/serve/mod.rs:187-231` | JSON `{cmd,args}` up to 1 MiB | Exact command dispatch; subprocess/network commands share a 2-permit semaphore |
| Dashboard command dispatcher | `packages/dashboard/src-tauri/src/serve/dispatch.rs:285-790` | Deserialized command-specific arguments | Reads/writes shared DB, sessions, memories, notes, workspaces, logs, user/project config; discovers models; probes embedding endpoints |

## Public Routes / URLs

| Method / URL | Authentication | Behavior |
|---|---|---|
| `GET /` | None | Returns embedded dashboard `index.html`; no-store and security headers (`serve/mod.rs:158-160,279-284,329-356`) |
| `GET /assets/*path` | None | Returns compile-time embedded assets only; rejects empty, `..`, backslash, and leading slash spellings (`serve/mod.rs:161,286-314`) |
| `GET <non-/api SPA path>` | None | Returns embedded dashboard index for GET, 404 otherwise (`serve/mod.rs:162,316-326`) |
| `POST /api/invoke` | `Authorization: Bearer <64 hex chars>` plus Host/Origin/JSON checks | Dispatches the command allowlist (`serve/mod.rs:148-156,187-231,243-261`) |
| Any `/api/*` not matched above | Same API guard | Authenticated JSON 404 (`serve/mod.rs:149-156,233-235`) |
| Launch URL `http://<host>:<port>/#token=<token>` | Token starts in URL fragment | Client JS stores it in module memory, removes the fragment with `history.replaceState`, then sends it as an Authorization header (`serve/mod.rs:513-523`; `packages/dashboard/src/lib/platform.ts:21-40`) |

The OpenCode RPC `/health`, `/rpc/*`, and `/ws` listener is documented in the knowledge base but is outside the two selected probe slices.

## Attacker Sources

### DFD-1 / hidden-agent slice

- Repository-controlled source, documentation, project text, and project configuration.
- Tool output and conversation content incorporated into raw-session/historian prompts.
- Model/provider output, including tool calls.
- Smart-note content and `surface_condition`; compiler code labels the condition as untrusted (`smart-notes/compiler.ts:70-82`).
- Persisted memories and project docs included in dream-task prompts.
- User-installed/discovered Pi or OMP extensions, including provider, AFT, MCP, or other tool registrations.

### DFD-2 / dashboard serve slice

- Network peer when non-loopback bind is explicitly enabled.
- Browser-supplied Host, Origin, Authorization, Content-Type, method/path, and JSON body.
- Bearer holder-supplied command names, IDs, project paths, config content, search values, endpoint/model/API-key values, and limits.
- DNS and HTTP responses returned by a user-scope embedding endpoint.
- Local environment, PATH, login-shell startup, config files, and SQLite files consumed after authenticated dispatch.

## Sinks

### Hidden-agent and host sinks

- Extension and built-in tool calls in spawned Pi/OMP children (`packages/pi-plugin/src/subagent-runner.ts:1607-1716`).
- Shared memory search/mutation via the lean child extension (`packages/pi-plugin/src/subagent-entry.ts:58-111`).
- Repository reads, writes, edits, and shell execution for task-specific children (`subagent-runner.ts:329-389`).
- Provider/model API calls by child hosts.
- Host-applied SQLite changes from parsed dreamer/classifier/reviewer output.
- QuickJS execution and smart-note capabilities after compiler-output validation (downstream of `smart-notes/compiler.ts:136-184`).

### Dashboard sinks

- Shared SQLite read/write operations and session transcript disclosure (`serve/dispatch.rs:285-630`).
- User configuration read/write (`serve/dispatch.rs:624-650`).
- Project configuration discovery/read/write (`serve/dispatch.rs:651-663`).
- Pi configuration read/write (`serve/dispatch.rs:665-681`).
- Model-discovery subprocesses (`serve/dispatch.rs:683-693`; `commands.rs:807-893`).
- Outbound embedding probe with optional bearer credential (`serve/dispatch.rs:695-711`; `embedding_probe.rs:264-365`).
- Memory, note, fact, workspace, and user-memory mutation (`serve/dispatch.rs:343-414,514-542,727-773`).

## Hidden Control Channels

| Channel | Effect | Evidence |
|---|---|---|
| Host identity (Pi vs OMP) | Changes model-provider naming, supported startup flags, tool-name translation, and whether `--tools` is a hard registry filter | `packages/pi-plugin/src/subagent-runner.ts:211-261,311-438,1618-1646` |
| `pi.subagent_extensions` | `undefined` preserves host extension discovery; any configured list, including an empty list, adds `--no-extensions` and explicitly loads only listed entries | `packages/plugin/src/config/schema/magic-context.ts:39-50`; `subagent-runner.ts:263-277,580-602,1651-1665` |
| `MAGIC_CONTEXT_PI_SUBAGENT=1` | Prevents the full Magic Context entry from recursively registering in a child; does not disable unrelated discovered extensions | `subagent-runner.ts:951-959,1633-1637`; `subagent-entry.ts:9-18` |
| Child `agent` identifier | Selects the intended strict tool list and whether the lean `ctx_*` extension is loaded | `subagent-runner.ts:329-399,1684-1716` |
| OMP `--tools` implementation | Filters OMP built-ins but does not set `restrictToolNames`; discovered extension tools are appended later | `subagent-runner.ts:324-327,402-407,1700-1702` |
| Host header | Loopback/explicit binds require a configured Host; wildcard binds accept any non-empty Host | `serve/mod.rs:387-413` |
| Origin header | Checked only when present; wildcard mode requires `Origin == http://<Host>` | `serve/mod.rs:415-432` |
| Authorization header | Sole dashboard API identity; exact case-sensitive `Bearer ` prefix and constant-time token comparison | `serve/mod.rs:444-466` |
| Content-Type and method | POST requests under `/api` require `application/json`; only `POST /api/invoke` dispatches | `serve/mod.rs:148-150,256-261,468-476` |
| `--allow-remote` and bind address | Permit plain-HTTP non-loopback exposure after an explicit warning | `serve/mod.rs:83-111,175-179` |
| Command string | Selects an exact dispatcher arm and whether the shared subprocess/network semaphore is acquired | `serve/mod.rs:203-214`; `serve/dispatch.rs:285-790,792-800` |

## Middleware / Proxy Assumptions

- The dashboard API guard is a route layer on the entire nested `/api` router; both `/invoke` and unknown `/api/*` routes pass through it (`serve/mod.rs:148-156`).
- `Forwarded`, `X-Forwarded-*`, original-URL, and method-override headers are not trusted or reconstructed. A reverse proxy is not an application authentication layer.
- Wildcard bind accepts arbitrary Host values so operators can use a LAN address; the bearer remains the identity boundary (`serve/mod.rs:403-411`).
- Origin is a browser-CSRF signal, not client authentication; non-browser clients may omit it (`serve/mod.rs:415-429`).
- Remote serve mode has no in-process TLS. Confidentiality relies on loopback, a trusted network, SSH tunneling, or an operator-managed secure proxy (`serve/mod.rs:105-108,175-177,523`).
- The dashboard client obtains its bearer from a URL fragment, not query parameters, and sends it in each API Authorization header (`platform.ts:21-40`).
- Pi is assumed to apply `--tools` as a final registry restriction. OMP is explicitly known not to apply that contract to extension-provided tools (`subagent-runner.ts:311-327,402-407`).
- Project config cannot set `pi.subagent_extensions`; the field is stripped before merge (`packages/plugin/src/config/project-security.ts:220-221,325-330`). The default user configuration leaves the field absent and therefore preserves discovery.

## Key Files

- `packages/pi-plugin/src/subagent-runner.ts`
- `packages/pi-plugin/src/subagent-entry.ts`
- `packages/pi-plugin/src/dreamer/index.ts`
- `packages/pi-plugin/src/pi-historian-runner.ts`
- `packages/pi-plugin/src/commands/ctx-aug.ts`
- `packages/plugin/src/agents/hidden-agent-registrations.ts`
- `packages/plugin/src/config/schema/magic-context.ts`
- `packages/plugin/src/config/project-security.ts`
- `packages/plugin/src/features/magic-context/smart-notes/compiler.ts`
- `packages/plugin/src/features/magic-context/dreamer/evaluate-smart-notes.ts`
- `packages/plugin/src/features/magic-context/dreamer/task-executor.ts`
- `packages/dashboard/src-tauri/src/serve/mod.rs`
- `packages/dashboard/src-tauri/src/serve/dispatch.rs`
- `packages/dashboard/src-tauri/src/config.rs`
- `packages/dashboard/src-tauri/src/commands.rs`
- `packages/dashboard/src-tauri/src/embedding_probe.rs`
- `packages/dashboard/src/lib/platform.ts`
