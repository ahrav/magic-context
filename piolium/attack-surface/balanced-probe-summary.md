# Balanced Lite Probe Summary (L4)

Status: **complete**  
Mode: balanced, single-team, single-pass  
Commit inspected: `be500459546101a18126e2ce5f25eb06a17bb620`  
Selected slices: **2**  
Raw hypotheses: **10**  
Distinct validated findings: **1**  
Drafts written: **1** (plus one pre-existing L3 draft with the same root cause)

## Inputs Read

- `piolium/attack-surface/knowledge-base-report.md`
- `piolium/attack-surface/candidates-summary.md`
- `piolium/audit-state.json`
- Existing L3 artifacts, including `unauthenticated-surface.md` and `p4-001-project-config-enables-shell-agent.md`, were used only for deduplication and challenge context; all retained L4 evidence was re-read from current production source.

## Slice Selection

### Slice 1: DFD-1 / CFD-3 — untrusted repository content to hidden-agent capabilities

This slice was selected because it reaches the candidate scan's highest-impact sinks: command execution, dynamic agent behavior, filesystem reads/writes, and hidden control channels. The key boundary is a cloned repository and its project config crossing into background agents that run with the developer's OS authority.

Primary files:

- `packages/plugin/src/config/project-security.ts`
- `packages/plugin/src/config/index.ts`
- `packages/plugin/src/config/schema/magic-context.ts`
- `packages/plugin/src/features/magic-context/dreamer/{task-config.ts,task-scheduler.ts,task-gates.ts,task-executor.ts,task-prompts.ts}`
- `packages/plugin/src/agents/{hidden-agent-registrations.ts,permissions.ts}`
- `packages/pi-plugin/src/dreamer/index.ts`
- `packages/pi-plugin/src/subagent-runner.ts`
- `packages/plugin/src/features/magic-context/smart-notes/{compiler.ts,compiler-prompt.ts}`

### Slice 2: DFD-2 / CFD-1 — dashboard HTTP request to local workstation authority

This slice was selected because it is the only repository-owned HTTP surface that can intentionally bind beyond loopback. A successful API request can read or mutate shared SQLite state and configuration, launch fixed subprocess discovery, and perform an outbound embedding probe.

Primary files:

- `packages/dashboard/src-tauri/src/serve/{mod.rs,dispatch.rs}`
- `packages/dashboard/src-tauri/src/{config.rs,commands.rs,embedding_probe.rs}`
- `packages/dashboard/src/lib/platform.ts`

The full entry-point, route, source, sink, hidden-channel, proxy-assumption, and key-file inventory is in `piolium/attack-surface/manual-attack-surface-inventory.md`.

## Inline Reasoning and Verification

The probe acted as both reasoning models inline. “Backward” starts at a privileged sink and traces toward attacker control. “Contradiction” starts from a stated protection and looks for a path on which that protection is absent or only advisory.

| ID | Model | Hypothesis | Verification | Verdict |
|---|---|---|---|---|
| PH-B1 | Backward | The `dreamer-docs` `bash`/write sink can be reached from repository-controlled project config without a per-run user decision. | Project cadence is explicitly preserved (`project-security.ts:38-42`); filtered project config is merged (`config/index.ts:567-591`); `maintain-docs` accepts cron but defaults off (`magic-context.ts:107-130,161-182,196-221`); a present Dreamer block is runnable (`agent-disable.ts:11-12`); the scheduler consumes the live schedule (`task-config.ts:12-43`; `task-scheduler.ts:153-185,530-556`); the task selects a shell-capable hidden agent (`task-executor.ts:1186-1228`; `hidden-agent-registrations.ts:125-151`). | **VALIDATED** |
| PH-B2 | Backward | OMP's discovered extension tools can reach a “zero-tool” or read-only hidden child because OMP appends extension tools after applying `--tools`/`--no-tools`. | The implementation explicitly states the caveat (`subagent-runner.ts:311-327,401-407,1700-1716`) and preserves extension discovery by default (`magic-context.ts:39-50`; `subagent-runner.ts:1628-1659`). `compiler.ts:66-79,122-135` passes untrusted smart-note text to an agent whose prompt claims it has no tools. | **NEEDS-DEEPER**: OMP source/runtime and a real tool-bearing extension were absent, so the external host contract could not be independently executed. No draft. |
| PH-B3 | Backward | A dashboard DB/config/subprocess command is reachable without the bearer through a sibling route or wildcard fallback. | The `/invoke` route and unknown `/api/*` fallback are built in one nested router, and `api_guard` is a route layer over both (`serve/mod.rs:136-164`). The guard checks Host, Origin when present, bearer, and POST content type before dispatch (`serve/mod.rs:243-263`). | **INVALIDATED** |
| PH-B4 | Backward | Dashboard embedding-probe arguments can be used for unauthenticated metadata SSRF or DNS rebinding. | The command is behind the same API guard; project scope is refused by `prepare_embedding_probe_options`; endpoint validation checks all resolved addresses for link-local/metadata forms and `reqwest` is pinned to those validated addresses with redirects not introduced on this path (`dispatch.rs:695-708`; `embedding_probe.rs:264-285,415-523`). | **INVALIDATED** for the selected anonymous/network attacker. Authenticated user-scope private/loopback probes are an intentional local-provider feature. |
| PH-B5 | Backward | Public `/assets/*path` can traverse into host files. | The handler rejects `..`, backslash, absolute spellings, and performs lookup only in the compile-time `RustEmbed` asset map (`serve/mod.rs:53-55,284-305`). | **INVALIDATED** |
| PH-C1 | Contradiction | The stated protection “a repository cannot reprogram or re-permission hidden agents” is incomplete because repository cadence can activate a pre-authorized powerful agent. | The filter removes direct prompt/tool fields (`project-security.ts:397-415`) but deliberately preserves cadence (`project-security.ts:38-42`). The supposedly docs-only restriction is prompt text (`task-prompts.ts:55-68,224-263`), while host authorization grants `bash`, `write`, and `edit` (`hidden-agent-registrations.ts:125-151,354-375`). Post-run code only restores protected regions in two docs (`task-executor.ts:1267-1272`). | **VALIDATED**, same root cause as PH-B1 |
| PH-C2 | Contradiction | The OMP path contradicts the “HARD tool allow-list” and “zero tools” claims. | The same source block calls the list HARD for Pi but says it is only an intended budget on OMP (`subagent-runner.ts:311-327`); OMP does not set `restrictToolNames` (`subagent-runner.ts:401-407`). | **NEEDS-DEEPER**, same unresolved external-contract dependency as PH-B2 |
| PH-C3 | Contradiction | Optional `Origin` checking makes dashboard API CSRF-authenticated. | `Origin` is optional, but the bearer is a separate non-ambient credential; it is generated from 32 random bytes, placed in a URL fragment, moved to module memory, removed from browser history, and sent in `Authorization` (`serve/mod.rs:444-465,500-523`; `platform.ts:18-40`). A cross-origin page does not acquire the fragment/token merely because Origin is optional. | **INVALIDATED** |
| PH-C4 | Contradiction | `--allow-remote` creates a new auth bypass because wildcard Host accepts arbitrary names. | Wildcard Host acceptance is explicit to support LAN addresses, but the bearer remains mandatory. Non-loopback binding requires `--allow-remote`, and the program warns that the transport is plain bearer HTTP (`serve/mod.rs:57-115,167-178,403-429`). | **BY DESIGN / conditional deployment risk**, not a new code defect |
| PH-C5 | Contradiction | Command strings or extra JSON fields can reach unintended subprocess arguments. | Dispatch is an exact string match; per-command argument structs use `deny_unknown_fields`; subprocess/network commands are fixed arms and share a two-permit semaphore (`dispatch.rs:15-40,224-280,281-305,683-708,763-770`; `serve/mod.rs:212-223`). | **INVALIDATED** in this pass |

## Validated Finding

### l4-001 — Repository configuration can activate an unattended shell-capable agent

- Draft: `piolium/findings-draft/l4-001-project-config-autonomous-shell-agent.md`
- Severity: **High**
- Reasoning models: backward trace PH-B1 plus contradiction PH-C1
- Attacker source: repository-controlled `.cortexkit/magic-context.jsonc` and repository content
- Sink: hidden-agent `bash`, `write`, and `edit` under the developer account
- Main protection gap: the trust-tier filter blocks direct prompt/tool overrides but intentionally preserves the schedule that activates an already powerful unattended agent
- Deduplication: this is the same root cause as pre-existing `p4-001-project-config-enables-shell-agent.md`; later phases should retain one canonical finding, not count both

## Defensive Evidence That Invalidated Dashboard Hypotheses

- Remote bind is opt-in and rejected without an explicit acknowledgement (`serve/mod.rs:105-108`).
- All `/api` routes, including unknown routes, share the same route-layer guard (`serve/mod.rs:148-159`).
- The bearer is 256 bits from `getrandom`, compared without early byte mismatch, and accepted only in the Authorization header (`serve/mod.rs:444-465,500-504`).
- API bodies are capped at 1 MiB and subprocess/network probes at two concurrent operations (`serve/mod.rs:136-156,212-220`).
- Static assets come from a compile-time embedded map, not a request-selected host path (`serve/mod.rs:53-55,284-305`).
- Command arguments are deserialized into command-specific `deny_unknown_fields` structs and dispatched by exact command names (`serve/dispatch.rs:15-280,281-760`).
- Project-config writes canonicalize the project root, reject symlink/non-regular targets, revalidate before atomic replacement, and use no-follow temporary creation (`config.rs:115-261`).
- Embedding probe DNS results are checked and pinned before connection (`embedding_probe.rs:264-285,415-523`).

## Commands and Dynamic Verification

A source-invariant verification script was run and retained transiently at:

`piolium/tmp/piolium/balanced-probe/l4-static-proof.txt`

It checked ten invariants spanning the project filter, merge, schema, hidden-agent authorization, task selection/gate, post-run enforcement, and Pi environment inheritance. All ten passed.

The dashboard serve tests were also attempted:

```text
cargo test --manifest-path packages/dashboard/src-tauri/Cargo.toml serve::tests:: -- --nocapture
```

Compilation stopped in `libdbus-sys` because this host lacks `dbus-1.pc` / the DBus development package. No test binary ran. Bun is not installed, so TypeScript unit tests could not run. These are verification limitations, not evidence against the source-grounded finding.

## Coverage Summary

| Entry point / boundary | Reviewed | Result |
|---|:---:|---|
| Project config filter and merge | Yes | Schedule activation gap validated |
| Dreamer task schema/config inheritance | Yes | Project cron reaches runtime config |
| Scheduler due-selection and activity gate | Yes | Unattended path confirmed; normal compartment precondition documented |
| OpenCode hidden-agent authorization | Yes | `bash`/write/edit are explicitly allowed |
| Pi dreamer facade and child spawn | Yes | Agent id/cwd reach runner; full parent environment inherited |
| OMP extension-tool filtering | Partial | Source declares a gap; external host implementation/runtime unavailable |
| Smart-note compiler untrusted-input path | Partial | Source path traced to OMP caveat; not dynamically executed |
| Dashboard serve bind/route tree | Yes | No missing guard found |
| Dashboard Host/Origin/bearer/content-type controls | Yes | No bypass found |
| Dashboard static routes/assets | Yes | No traversal or sensitive pre-auth sink found |
| Dashboard exact command dispatcher | Yes, class-level | Sensitive command classes reviewed; every DB query arm was not audited individually |
| Dashboard config write path | Yes | Canonical/no-follow checks block the tested traversal/symlink hypotheses |
| Dashboard embedding probe | Yes | Project scope and metadata/rebinding hypotheses blocked |
| Dashboard runtime integration tests | Blocked | Missing DBus development dependency |

## Limits and Stop Reason

- This was the required one-team, one-pass L4 probe; no deep-team loops or subagents were used.
- OMP itself and tool-bearing extension implementations are external to the checkout. The OMP extension-tool hypothesis remains for a later real-host check.
- The dashboard command allowlist is broad. This pass traced representative file, config, process, network, and database classes rather than every SQL statement.
- No live model was asked to follow a prompt injection, so exploit reliability was not measured. The validated defect is the host-side trust/capability transition that permits such an unattended attempt.
- Stop reason: both selected slices received backward and contradiction review; the repository-to-agent path produced one source-validated High draft, while dashboard hypotheses reached blocking controls or documented operator choices.
