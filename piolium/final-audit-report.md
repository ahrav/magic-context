# Security Audit Report: Magic Context
======================================

## Executive Summary

This assessment identified one **Medium**-severity vulnerability in Magic Context. An untrusted repository can use project configuration to activate a normally disabled, scheduled documentation-maintenance task. The task invokes an unattended agent that has shell and file-mutation capabilities and is directed to read repository-controlled content. A successful exploit still depends on a configured model following an indirect prompt injection, so the assessment does not claim deterministic code execution. Nevertheless, the design crosses a material trust boundary: a repository contributor can cause attacker-controlled content to be processed by an agent acting with the developer's local authority. No Critical or High findings were confirmed in the reviewed scope.

## Findings by Severity

### Critical

No Critical findings were confirmed.

### High

No High findings were confirmed.

### Medium

| ID | Finding | PoC Status | Finding Report |
|---|---|---|---|
| M1 | Repository configuration enables an unattended shell-capable agent | Theoretical, source-grounded | [`M1-project-config-autonomous-shell-agent/report.md`](findings/M1-project-config-autonomous-shell-agent/report.md) |

## Technical Findings Detail

### M1 — Repository configuration enables an unattended shell-capable agent

- **Severity:** Medium
- **Summary:** A malicious repository can supply `.cortexkit/magic-context.jsonc` that activates and schedules the normally disabled `dreamer.tasks.maintain-docs` task, causing an unattended, shell-capable agent to process repository-controlled content.
- **Impact:** If the selected model follows an indirect prompt injection in repository content, it can invoke already-authorized `bash`, `write`, or `edit` tools as the developer. This can cause commands or file changes beyond the intended documentation files. On the Pi execution path, the child process inherits the parent environment, which can increase impact where credentials or tokens are present.
- **Root Cause:** Project configuration is recognized as untrusted, but the trust filter removes only direct hidden-agent prompt, permission, tool, and system-prompt fields. It allows `dreamer.disable` and nested task schedules to survive a project-over-user merge. Those fields control whether a background task launches an agent with broad host capabilities; the task's natural-language instructions and post-run document restoration are not host-enforced confinement for shell effects or arbitrary writes.
- **Key Code References:**
  - `packages/plugin/src/config/project-security.ts:397-410` filters only the direct hidden-agent escalation fields and leaves Dreamer activation/cadence fields intact.
  - `packages/plugin/src/config/index.ts:562-588` merges the filtered project configuration over user configuration.
  - `packages/plugin/src/features/magic-context/dreamer/task-scheduler.ts:523-556` executes due, activity-gated tasks without a per-run repository-trust confirmation.
  - `packages/plugin/src/agents/hidden-agent-registrations.ts:125-151` grants `dreamer-docs` the `bash`, `write`, and `edit` tools.
  - `packages/pi-plugin/src/subagent-runner.ts:946-959` launches the Pi child in the project directory with the parent environment merged into it.
- **PoC Status:** Theoretical, source-grounded. The supplied script validates the configuration-to-scheduler-to-capability chain but intentionally does not invoke a model, execute a shell command through Magic Context, or access credentials. Model compliance with attacker-authored repository instructions remains an exploitation precondition.
- **Proof of Concept:** [`piolium/findings/M1-project-config-autonomous-shell-agent/poc.py`](findings/M1-project-config-autonomous-shell-agent/poc.py)
- **Detailed Report:** [`piolium/findings/M1-project-config-autonomous-shell-agent/report.md`](findings/M1-project-config-autonomous-shell-agent/report.md)

**Recommended remediation priority:** Treat project-controlled agent activation, disablement, and task scheduling as privileged settings. A project must not be able to turn on a disabled unattended task or override a user-level disable. Require trusted user opt-in for unattended tasks with shell or general file-write authority, and enforce any remaining task scope in the host or a sandbox rather than only through model instructions.

## Attack Surface Summary

The audit modeled Magic Context as a multi-surface developer tool: OpenCode and Pi/OMP plugins, unattended Dreamer tasks, a Tauri dashboard and optional dashboard HTTP server, local RPC and SQLite state, smart-note QuickJS evaluation, CLI utilities, and TypeScript-to-Rust/subc integration. The most security-sensitive reviewed boundary was untrusted repository content and configuration reaching hidden-agent tools operating with developer authority. The dashboard's guarded API and dispatch path were also examined because it can reach local data, configuration, subprocess, and network operations when explicitly exposed.

| Artifact | What it records |
|---|---|
| [`piolium/attack-surface/knowledge-base-report.md`](attack-surface/knowledge-base-report.md) | Project model, trust boundaries, DFD/CFD slices, threat model, static-analysis results, and the complete documented coverage limitations. |
| [`piolium/attack-surface/manual-attack-surface-inventory.md`](attack-surface/manual-attack-surface-inventory.md) | Reviewed entry points, public routes, attacker sources, high-impact sinks, hidden control channels, and selected high-impact slices. |
| [`piolium/attack-surface/unauthenticated-surface.md`](attack-surface/unauthenticated-surface.md) | Best-effort anonymous/pre-auth HTTP and API surface inventory. |
| [`piolium/attack-surface/source-sink-flows-all-severities.md`](attack-surface/source-sink-flows-all-severities.md) | Candidate-family disposition and source/sink-flow review across retained and rejected candidate classes. |
| [`piolium/attack-surface/advisory-summary.md`](attack-surface/advisory-summary.md) | Advisory and direct-dependency intelligence, including four version-affected Astro entries that were not shown reachable in the observed static documentation configuration. |
| [`piolium/attack-surface/balanced-probe-summary.md`](attack-surface/balanced-probe-summary.md) | Manual probe coverage, defensive evidence that invalidated dashboard hypotheses, and runtime-test limitations. |
| [`piolium/attack-surface/balanced-chamber-summary.md`](attack-surface/balanced-chamber-summary.md) | Review-chamber adversarial analysis, false-positive gates, severity calibration, and finding deduplication. |
| [`piolium/codeql-artifacts/`](codeql-artifacts/) | Retained fallback structural inventory: entry points, sinks, syntactic source/sink pairs, SARIF, and diagrams. These artifacts are not a CodeQL database or taint proof. |

## Coverage Gaps

The absence of additional confirmed findings must not be interpreted as exhaustive assurance. The most material limitations were:

1. **No CodeQL or Semgrep execution.** Neither executable was available in the assessment environment. The audit retained a regex/structural fallback, but its 500 same-function source/sink pairs are not interprocedural taint or reachability analysis.
2. **No end-to-end model-backed exploit.** M1's host-side configuration and capability path was source-validated, but no model was asked to follow an injected instruction. Exploit reliability therefore remains unmeasured and the PoC is correctly classified as theoretical.
3. **External host-framework behavior was not independently verified.** OpenCode, Pi, and OMP plugin-loader, permission-merge, tool-registry, hook-ordering, and session/directory-identity contracts were reviewed through adapter code and locked versions rather than live-host execution. OMP extension-tool enforcement was specifically only partially reviewed.
4. **Missing sibling Rust workspaces.** `../commons` and `../subconscious` were absent, preventing verification of subc transport framing, connection-file permissions, peer credentials, handshake semantics, and certain exact dependency revisions.
5. **Dynamic integration coverage was blocked or incomplete.** Dashboard integration tests could not build because the host lacked DBus development files; TypeScript tests could not run because Bun was unavailable. Browser/WebView behavior, reverse-proxy behavior, generated Tauri/Astro artifacts, duplicate-header parsing, and route/auth behavior were not observed dynamically.
6. **Authorization and dependency scope were bounded.** The large Tauri/dashboard command surface was reviewed by sensitive command class rather than exhaustively by command and SQL statement. Dependency intelligence was direct-component focused; transitive npm/Cargo/native dependencies, ONNX, bundled SQLite, WebView, libvips, downloaded models, OS packages, and externally installed agent hosts were not independently scanned.
7. **Environmental assumptions remain material.** Internet exposure, shared-host use, data sensitivity, remote dashboard deployment, trusted-group storage, release controls, and user/provider configuration were not clarified during the audit. A deployment-layer proxy could also introduce forwarding or header-trust behavior that does not exist in this source tree.

## Methodology Notes

- **Intelligence gathering and architecture inventory:** The audit collected direct dependency/advisory intelligence and reconstructed the component inventory, execution modes, trust boundaries, and high-value assets from repository source and manifests. See [`piolium/attack-surface/advisory-summary.md`](attack-surface/advisory-summary.md) and the [knowledge base](attack-surface/knowledge-base-report.md).
- **Threat modeling and attack-surface analysis:** The assessment documented DFD/CFD slices for repository-to-agent capabilities, dashboard request handling, smart-note evaluation, TypeScript-to-Rust authority transitions, and local predicate providers. It selected the repository-to-hidden-agent and dashboard HTTP-to-local-authority paths for focused manual review.
- **Static review:** A candidate pre-scan covered 730 files and 5,084 matches. Because CodeQL and Semgrep Pro were unavailable, the audit used retained structural fallback artifacts and targeted source review. Dynamic CodeQL and Semgrep results are therefore not represented as completed coverage.
- **Adversarial review chamber:** One balanced review chamber evaluated two drafts representing one unique hypothesis. One draft was retained as the confirmed Medium finding; the duplicate draft was preserved as a deduplication record. The chamber performed attack-ideation, code-tracing, protection search, and false-positive checks. See the [chamber summary](attack-surface/balanced-chamber-summary.md).
- **Proof-of-concept assessment:** The retained PoC for M1 checks the source-level activation and authority chain. It does not execute an LLM, run an agent-issued shell command, or access secrets; the final severity and PoC wording preserve that distinction.
- **Variants and attack-pattern registry:** No promoted finding contains variant metadata, so no variants are reported. No retained `piolium/attack-pattern-registry.json` was present at report assembly; consequently, no separate registry pattern count is claimed.

## Conclusion

Magic Context has a security-relevant trust-boundary weakness around unattended agent activation: repository-controlled configuration can enable a scheduled task with developer-authority shell and file tools. This should be addressed before treating repository configuration as a safe customization channel for autonomous tasks. The remaining reviewed dashboard protections and several candidate classes had defensive controls sufficient to prevent confirmation within the assessed scope, but key assurance gaps remain because core SAST tooling, dynamic tests, external host behavior, and sibling transport code were unavailable. Remediation should prioritize preventing untrusted project settings from enabling privileged unattended work, host-enforced containment for any task that processes repository content, and a follow-up assessment with CodeQL/Semgrep, live Pi/OpenCode/OMP hosts, and the missing Rust sibling workspaces.
