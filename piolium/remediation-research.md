# M1 Remediation Research: Untrusted Project Config → Autonomous Agent Authority

Generated: `2026-08-17T01:49:18Z`  
Repository commit: `be500459546101a18126e2ce5f25eb06a17bb620`  
Finding: `piolium/findings/M1-project-config-autonomous-shell-agent/report.md`

## Decision

Ship two controls in order:

1. **Immediate security fix:** make the entire project-tier `dreamer` block non-authoritative. Only trusted user config may create/enable Dreamer, select models, or schedule autonomous tasks. Ignore repository-supplied `dreamer` configuration with one warning. This is the smallest reliable patch.
2. **Containment follow-up:** remove general `bash`, `write`, and `edit` authority from `dreamer-docs`. Replace it with host-enforced, project-root-scoped read operations and a dedicated documentation patch/apply operation restricted to `ARCHITECTURE.md` and `STRUCTURE.md`. Until this exists, scheduled `maintain-docs` should remain a trusted-user opt-in.

If project-local Dreamer restrictions are a required product feature, add a typed **restrictive-only merge** later: project config may disable Dreamer/tasks, but may not create Dreamer, re-enable anything, choose a model/provider, increase cadence, broaden tools, or increase budgets. Do not delay the immediate fix for this compatibility layer.

Confidence: **high** for the immediate fix; **medium-high** for the containment design because OpenCode, Pi, and OMP expose different tool-enforcement mechanisms.

## Why this is the right boundary

Project config is repository-controlled and explicitly classified as untrusted in `packages/plugin/src/config/project-security.ts`. Current logic removes direct prompt/tool/permission fields but deliberately preserves Dreamer model and cadence fields. The filtered project object is then merged over trusted user config in `packages/plugin/src/config/index.ts` and `packages/pi-plugin/src/config/index.ts`.

Three details make a narrow `disable`/`schedule` patch unsafe:

1. `dreamer` is optional, and its mere presence makes `isDreamerRunnable()` true unless `disable === true` (`packages/plugin/src/config/agent-disable.ts`).
2. Parsing any surviving project `dreamer` object fills `tasks` with default schedules (`packages/plugin/src/config/schema/magic-context.ts`). Removing only an attacker-supplied schedule can therefore still leave default scheduled tasks.
3. The current filter is denylist-based. Any future security-relevant Dreamer field is allowed unless someone remembers to add it to `AGENT_ESCALATION_FIELDS`.

Therefore, the emergency fix should drop the full project `dreamer` block. This fails closed and avoids trying to infer cron restrictiveness or field semantics during a security patch.

## Current authority chain

```text
repo .cortexkit/magic-context.jsonc
  → project config load
  → stripUnsafeProjectConfigFields() leaves Dreamer activation/cadence/model
  → project object deep-merges over user object
  → Zod fills missing Dreamer task defaults
  → isDreamerRunnable() accepts present non-disabled block
  → scheduler reconciles nonempty cron
  → maintain-docs selects dreamer-docs
  → OpenCode/Pi grant read + bash + write + edit
  → Pi child inherits process.env
```

Relevant files:

- `packages/plugin/src/config/project-security.ts`
- `packages/plugin/src/config/index.ts`
- `packages/pi-plugin/src/config/index.ts`
- `packages/plugin/src/config/schema/magic-context.ts`
- `packages/plugin/src/config/agent-disable.ts`
- `packages/plugin/src/features/magic-context/dreamer/task-config.ts`
- `packages/plugin/src/features/magic-context/dreamer/task-scheduler.ts`
- `packages/plugin/src/features/magic-context/dreamer/task-executor.ts`
- `packages/plugin/src/agents/hidden-agent-registrations.ts`
- `packages/pi-plugin/src/subagent-runner.ts`

## External evidence

### Repository trust must gate automatic execution

VS Code Workspace Trust opens unfamiliar folders in Restricted Mode and disables or limits AI agents, terminals, tasks, debugging, workspace settings, and extensions until the user trusts the folder. Its task guidance calls out the exact risk here: committed repository task definitions can be malicious and unknowingly executed by anyone who clones the repository.

Source: [VS Code Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust)

Applicability: Magic Context project config is equivalent to a committed workspace setting that can start background work. It must not grant execution authority by itself.

### Prompts are not an authorization boundary

OWASP LLM01 recommends privilege control, least privilege, human approval for high-risk actions, and segregation of untrusted content. OWASP LLM08 identifies excessive functionality, permissions, and autonomy as the root causes of harmful agent actions and specifically recommends narrower plugins/credentials or manual approval.

Sources:

- [OWASP LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [OWASP LLM08: Excessive Agency](https://genai.owasp.org/llmrisk2023-24/llm08-excessive-agency/)

Applicability: `MAINTAIN_DOCS_SYSTEM_PROMPT` says “only two docs” and “never read secrets,” but the host grants open-ended shell and generic file tools. Model prose cannot prove those restrictions.

### Sandboxing and approval are separate controls

OpenAI Codex documentation separates sandbox mode (technical capability) from approval policy (when the user must decide). Default local guidance uses workspace-scoped writes and network-off execution; cloud secrets are removed before the agent phase. VS Code similarly describes OS-level sandboxing as stronger than auto-approval rules for prompt-injection threats.

Sources:

- [Codex agent approvals and security](https://developers.openai.com/codex/agent-approvals-security)
- [Codex sandbox](https://developers.openai.com/codex/concepts/sandboxing)
- [VS Code AI security](https://code.visualstudio.com/docs/agents/run/security)

Applicability: Magic Context currently has neither an OS-enforced docs-task sandbox nor an approval boundary around repository-triggered activation.

### Untrusted project settings must not disable containment

Claude Code sandbox guidance makes filesystem and network isolation independent, restricts writes to the current working directory by default, supports credential environment scrubbing, and explicitly refuses to honor filesystem-isolation disablement from project settings. Its permissions model also applies deny-first precedence across scopes.

Sources:

- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code security](https://docs.anthropic.com/en/docs/claude-code/security)

Applicability: Magic Context should use the same monotonic rule: lower-trust project settings may narrow trusted user authority, never widen or disable containment.

## Remediation options

| Option | Closes M1 | Compatibility | Complexity | Verdict |
| --- | ---: | ---: | ---: | --- |
| Strip only `dreamer.disable` and `tasks.*.schedule` | Not reliably | High | Low | Reject. A surviving `dreamer` object can acquire default schedules during parse; model/budget fields still cross the boundary. |
| Make project `dreamer` entirely user-only | Yes | Existing project Dreamer tuning stops working | Low | **Ship now.** Fail-closed, auditable, smallest reliable patch. |
| Restrictive-only typed merge | Yes | Preserves project disable/narrowing controls | Medium | Good follow-up if project-local restrictions are required. |
| Per-project user trust grants | Yes if correctly bound/revoked | Preserves trusted project tuning | High | Defer. Requires durable identity, UX, revocation, clone/fork semantics, and audit state. |
| Sandbox only; leave project activation | Reduces impact, does not fix authorization | High | High | Defense-in-depth only. Untrusted config would still spend tokens and trigger autonomous behavior. |
| User approval on every scheduled run | Yes for side effects | Poor unattended UX; approval fatigue | Medium | Not preferred. Use one trusted opt-in plus enforced containment. |

## Immediate patch specification

### Policy

For project-tier config:

- Ignore `dreamer` wholesale.
- Emit one warning: project config cannot enable, schedule, model-select, or reconfigure autonomous agents; move reviewed settings to user config.
- Never copy project values into user config automatically.
- Keep trusted user config behavior unchanged.

This can be implemented in `stripUnsafeProjectConfigFields()` with one block deletion. It should occur before merge in both OpenCode and Pi loaders, which already call the shared helper.

### Required tests

Add shared tests in `packages/plugin/src/config/project-security.test.ts`:

1. Project-only `dreamer` is removed.
2. Project `dreamer.disable: false` cannot override user `disable: true`.
3. Project nonempty `maintain-docs` schedule cannot override trusted `""`.
4. Project model/fallback/thinking/timeout fields are ignored.
5. Unknown future Dreamer fields do not survive.
6. One warning is emitted without serializing project values.

Add loader integration tests:

- `packages/plugin/src/config/index.test.ts`: user + project merge keeps trusted user Dreamer exactly.
- `packages/pi-plugin/src/config/index.test.ts`: same effective result.
- `packages/pi-plugin/src/config/project-security.test.ts`: mirror the shared boundary assertion.

The most important case is **no user Dreamer + project `{ dreamer: { inject_docs: false } }`**. Effective config must still have no Dreamer. This catches the default-filling bypass that a field-only patch can miss.

### Documentation and release

Update:

- `CONFIGURATION.md`
- `packages/plugin/scripts/build-config-docs.ts`
- generated `packages/docs/src/content/docs/reference/configuration.md`
- generated `assets/magic-context.schema.json` descriptions if scope metadata is represented there
- `CHANGELOG.md`

State plainly: Dreamer configuration is user-level only. Existing repository Dreamer blocks are ignored with a warning. Users must review and move desired values manually.

Release as a security patch. Do not wait for the containment redesign.

## Restrictive-only follow-up

If project-local policy remains necessary, replace “project overrides user” for trust-sensitive fields with a typed policy table or explicit merge function. Default policy for new fields must be **user-only**, not allowed.

Suggested policy classes:

| Class | Merge rule | Examples |
| --- | --- | --- |
| User-only authority | Project value ignored | agent presence/enablement, nonempty schedules, model/fallback/provider, prompts, tools, permissions, network/egress, extension loading |
| Restrictive boolean | Effective value can move only toward disabled | `enabled`, `memory.enabled`, `memory.auto_promote`; project `false` allowed, project `true` cannot override user `false` |
| Disable-only task | Project may set schedule to `""`, never to nonempty | `dreamer.tasks.*.schedule` |
| Bounded numeric restriction | Field-specific min/max relation | lower timeout/tool-step/token budget; higher promotion threshold |
| Harmless project customization | Normal project override | display-only or repository-local formatting fields with no cost, destination, authority, persistence, or prompt effect |

Do not compare cron expressions to decide which is “less frequent.” Cron partial ordering is complex and error-prone. Treat all nonempty schedules as trusted-user values; project config may only disable with `""`.

A project must not create a Dreamer block when the trusted user config has none. If trusted user Dreamer exists, a future restrictive merge may reconstruct the effective block from the trusted value, then apply only explicit narrowing operations.

The local `docs/fork-hardening-audit.md` already describes this broader direction as `MC-HARD-012`: a monotonic trust lattice where project config may disable but not re-enable, and model/egress/cadence are user-only unless a named project capability is granted.

## Containment follow-up for `maintain-docs`

Trusted activation alone closes M1's authorization defect, but the task remains overpowered for prompt-injected repository content.

### Remove general shell authority

Replace model-controlled `bash` with deterministic host-provided data:

- recent commit list/diff metadata from fixed-argv `git` calls;
- bounded repository tree listing;
- bounded text/symbol search;
- project-root-fenced file reads.

The model does not need an arbitrary shell to run `git log`, `find`, or `grep`.

### Replace generic write/edit with one semantic operation

Expose a dedicated docs update operation that:

- accepts only `ARCHITECTURE.md` or `STRUCTURE.md`;
- resolves and revalidates the project root and target path;
- rejects symlinks and path traversal;
- enforces maximum input/output bytes;
- preserves protected regions before committing the write;
- writes atomically;
- returns a diff for review/audit;
- cannot execute hooks, subprocesses, network calls, or touch other paths.

Prefer proposal → deterministic validation → host apply. The model proposes text or a patch; the host owns authorization.

### Child-process containment

For Pi/OMP children:

- do not rely on `process.env` inheritance as a security boundary;
- scrub nonessential credentials from any tool subprocess environment;
- keep network off for docs maintenance;
- disable discovered extensions for security-sensitive hidden agents unless explicitly user-allowlisted;
- verify OMP behavior separately because current comments state `--tools` narrows built-ins but does not hard-isolate extension tools.

Provider authentication may require environment access in the child agent process. If so, prevent tools from inheriting that environment or broker provider credentials outside the tool execution context. Removing `bash` is the fastest way to eliminate direct environment disclosure while that architecture is unresolved.

## Validation matrix

| Scenario | Expected result |
| --- | --- |
| No user Dreamer; project adds Dreamer | Dreamer absent; warning emitted |
| User disables Dreamer; project sets `disable:false` | Still disabled |
| User leaves maintain-docs off; project schedules it | Still off |
| User schedules maintain-docs; project sets `schedule:""` | Immediate patch: project block ignored. Restrictive follow-up: task disabled for this project |
| Project chooses model/fallback/thinking level | Trusted user values retained |
| Malicious repo file asks docs agent to write `.marker` | Dedicated tool rejects target; no marker |
| Malicious repo file asks docs agent to print env or curl endpoint | No shell/network tool exists; request cannot be expressed |
| Symlinked docs target escapes project | Rejected after `lstat`/`realpath` revalidation |
| OMP has unrelated discovered extensions | Hidden docs child cannot see them, or scheduled docs is refused until hard isolation exists |
| Security policy warning | Names ignored key class, never logs values/secrets |

## Rollout and rollback

1. Land immediate project-Dreamer block strip and tests.
2. Regenerate docs/schema; add migration warning and changelog entry.
3. Release patch version.
4. Monitor ignored-project-Dreamer warnings and support reports; do not add an unsafe compatibility bypass.
5. Build scoped docs tools and adversarial tests.
6. Only then consider a restrictive project merge or user-owned per-project trust grant.

Rollback must not restore project authority. If compatibility is severe, disable scheduled `maintain-docs` globally while a safe user-owned per-project configuration mechanism is built.

## Acceptance criteria

M1 is remediated when all are true:

- A repository cannot create or enable Dreamer without trusted user configuration.
- A repository cannot override `dreamer.disable: true`.
- A repository cannot provide a nonempty autonomous-task schedule or choose its model.
- OpenCode and Pi produce the same effective configuration for all trust-boundary vectors.
- Ignored widening attempts are visible but do not leak values.
- Scheduled `maintain-docs` is either trusted-user-only with explicitly documented residual risk, or uses host-enforced path/tool/environment containment.

Full defense-in-depth is complete when the docs agent has no general shell, no unrestricted file mutation, no ambient network, no access to unrelated credentials, and no unapproved extension tools.

## Non-goals

- Do not solve arbitrary prompt injection with better prompt wording.
- Do not auto-trust repositories based on Git remote popularity or organization name.
- Do not auto-promote repository config into user config.
- Do not implement cron-frequency comparison.
- Do not build a durable project-trust database unless product requirements justify its identity, revocation, fork, clone, and migration complexity.
