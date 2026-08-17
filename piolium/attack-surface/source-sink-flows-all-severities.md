# Source/Sink Flows — All Severities

## Scope and tool availability

Phase L3 first reviewed `candidates-summary.md` and all records in `candidates.jsonl`, then prioritized precise/high-score production files and hidden control channels near authentication, routing, proxy, debug/admin/preview, and cache behavior.

- Candidate pre-scan: **730 files / 5,084 matches**.
- CodeQL: **unavailable** (`codeql: command not found`). No database or CodeQL reachability proof was produced.
- Semgrep / Semgrep Pro: **unavailable** (`semgrep: command not found`). This was a missing executable, not an authentication/licensing failure; no OSS downgrade was possible.
- Required fallback: `rg` + source review, plus the deterministic `piolium/codeql-artifacts/structural-fallback.py` extractor.
- Java baseline: not applicable; the repository contains TypeScript/JavaScript and Rust, not Java.
- GitHub Actions AI-agent audit: one workflow, zero AI action instances, zero agentic-action findings.

The candidate pre-scan's highest scores were noisy for this codebase: JavaScript `RegExp.exec()` and SQLite `db.exec()` were repeatedly classified as dynamic/command execution. Those matches were manually separated from real VM, subprocess, SQL, HTTP, and filesystem sinks.

## Structural inventory

The fallback extractor scanned **726 production-like files** (tests and generated/build directories excluded):

| Artifact | Count | Meaning |
|---|---:|---|
| Entry-point signals | 2,917 | Exported APIs, HTTP/RPC routes, CLI/stdin handlers, Tauri commands, plugin tools, and workflow triggers. This is syntactic and intentionally broad. |
| Sink signals | 4,519 | Process, dynamic-code, HTTP, file, SQL, deserialization, and host-tool syntax. |
| Reachable slices | 500 (cap) | Source and sink syntax in the same brace-balanced function. This is **not** interprocedural reachability. |

Sink signals by kind: 2,262 SQL execution, 840 host-tool actions, 426 process execution, 372 deserialization, 360 file reads, 199 file writes, 49 HTTP requests, 7 dynamic-code execution, and 4 explicit shell-execution patterns.

Raw machine-readable inventories are in:

- `piolium/codeql-artifacts/entry-points.json`
- `piolium/codeql-artifacts/sinks.json`
- `piolium/codeql-artifacts/call-graph-slices.json`
- `piolium/codeql-artifacts/flow-paths-raw.sarif`
- `piolium/codeql-artifacts/flow-paths-all-severities.md`

## High-risk DFD/CFD review

| Slice | Source | Sink / decision | Static result | Severity / disposition |
|---|---|---|---|---|
| DFD-1 + CFD-2/3 | Repository `.cortexkit/magic-context.jsonc`, repository text | Project schedule enables hidden `dreamer-docs`; agent receives `bash`, `write`, `edit`; Pi child inherits `process.env` | Confirmed cross-component path. Project filtering deliberately preserves Dreamer cadence and executor selects the shell-capable agent. | **High — keep as `p4-001`** |
| DFD-2 + CFD-1 | Remote/local HTTP headers and JSON `{cmd,args}` | Dashboard dispatch to DB, config writes, network probe, process discovery | All `/api` paths are nested under `api_guard`; Host, optional Origin, bearer, JSON content type, 1 MiB Axum body limit, exact command match, and subprocess semaphore are present. No forwarded/admin/debug/tenant/method-override headers were found. | No finding |
| DFD-3 | Model-produced `compiled_check` | `QuickJSAsyncContext.evalCodeAsync`, guarded read/Git/HTTPS capabilities | Flow exists. Source is capped at 64 KiB; each context has memory/stack/interrupt limits; asyncify runs serialize; host calls receive abort; ambient `eval`/`Function` are removed; context is disposed. File-read + public egress is the documented A50 capability tradeoff. | Medium candidate — drop as accepted capability, no missing guard proved |
| DFD-4 + CFD-4 | Subc JSON/wire requests and route binding | Rust store reads/writes and authority transitions | Numerous protocol/deserialization/SQL/file signals exist, but sibling transport crates are absent and no interprocedural analyzer was available. In-repo checks fail closed on route/session/root/epoch mismatches. | No finding; coverage gap retained |
| DFD-5 | One stdin JSON request with caller paths, refs, needles | Local file/stat/read and argument-vector Git | Strict schema and canonical path fence/revalidation are present; Git uses fixed executable/argv and suppresses system/global config. The caller is local and already holds equivalent OS read authority. | Low/env candidate — dropped |
| Config/env secrets | User config/env/file substitutions | Provider HTTP and child processes | Project destination and secret-substitution fields are stripped before merge. Runtime embedding permits private/loopback by design, blocks direct metadata/link-local forms and redirects, but does not DNS-pin. Destination remains user-tier. | Medium candidate — drop as trusted-user configuration |
| CLI argv | Local operator input | Files, SQLite repair/migration, subprocesses | Real subprocess calls use fixed commands or argument vectors except fixed-string login-shell/diagnostic probes. Dynamic SQL clauses reviewed were constants, generated placeholders, numeric clamps, or quoted/allowlisted identifiers. | Low/env candidate — dropped |
| Build plane | Workflow/action metadata and remote installer | GitHub Actions runner command execution | Mutable action tags and two `curl ... | bash` installer steps were confirmed. They are CI-only and therefore excluded by L3 enrichment drop criteria, though retained as supply-chain hardening gaps. | Medium environment/CI — dropped |

## Hidden control channels

A narrow production scan found only:

- `Authorization` in the loopback Bun RPC server;
- `Host`, `Origin`, `Authorization`, and `Content-Type` in the Axum dashboard guard;
- response `Content-Type` inspection in the embedding client.

No production `Forwarded`/`X-Forwarded-*`, tenant, admin, debug, preview, method/path override, or request-header cache-key channel was found. The dashboard's four request headers are handled in a single pre-dispatch middleware layer; API responses are `Cache-Control: no-store`.

## Candidate-family adjudication

| Candidate family | Representative evidence | Classification | Reachability | Verdict |
|---|---|---|---|---|
| Repository-enabled shell agent | `project-security.ts:38-39` → task schema → `hidden-agent-registrations.ts:126-144` → `task-executor.ts:1218` | likely security | No CodeQL slice; direct cross-file proof | **keep (`p4-001`)** |
| QuickJS generated-code evaluation | `compiler.ts` → `sandbox-runner.ts:307` | security-sensitive accepted capability | Same-function sink enumerated; no interprocedural proof | drop as no defect after guard review |
| Runtime embedding SSRF | `embedding-openai.ts:285` | likely environment/admin-only | Same-function HTTP source/sink candidate | drop: endpoint is trusted user-tier; private/loopback support intentional |
| RPC `req.text()` before length check | `rpc-server.ts:291-303` | likely robustness | Same-function remote/deserialization candidate | drop: loopback + bearer; same-user attacker already has equivalent local authority |
| Dynamic SQL interpolation | SQLite helpers/migrations/storage | likely correctness/robustness | Many same-function SQL candidates | drop: checked samples use constants, placeholders, clamps, or allowlisted/quoted identifiers |
| Variable process/PATH resolution | CLI/dashboard/agent launchers | likely environment/tooling | Same-function CLI/process candidates | drop: fixed argv/commands or same-user PATH/login-shell control |
| Weak MD5 / `Math.random()` | prompt fingerprints, project identity, jitter/temp suffix | likely correctness | No security source-to-sensitive sink | drop: non-security hashes/jitter; not authentication or cryptographic tokens |
| Secret literals | test fixture API keys only | test-only | not production | drop immediately |
| Mutable Actions / remote installer | `.github/workflows/ci.yml` | likely environment/tooling/CI-only | workflow-only | drop from Phase 10; retain hardening note |

## Custom analysis artifacts

- `piolium/semgrep-rules/magic-context-custom.yml` — 13 repository-specific structural rules covering dynamic requests, child processes, QuickJS, headers, project privilege fields, hidden shell agents, SQL, body limits, Rust process/header use, and workflow supply-chain patterns. YAML structure was validated with PyYAML; rules could not execute without Semgrep.
- `piolium/codeql-queries/` — four JavaScript structural queries plus a custom suite/pack for VM/process, HTTP/header, SQL/file, and project-config privilege surfaces. They could not be compiled or run without CodeQL.

## Draft findings

1. `piolium/findings-draft/p4-001-project-config-enables-shell-agent.md` — repository configuration can activate an autonomous shell-capable hidden agent.

No other Medium-or-higher candidate survived runtime, trust-boundary, and actual-use validation. Low, test-only, CI-only, same-user-equivalent, and correctness-only candidates were dropped rather than forwarded.
