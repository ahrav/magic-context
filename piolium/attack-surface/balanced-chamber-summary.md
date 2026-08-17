# Balanced Review Chamber Summary

Phase: L5 (Single Review Chamber + FP Check)  
Repository commit: `be500459546101a18126e2ce5f25eb06a17bb620`  
Completed: 2026-08-17T00:51:21Z  
Status: **CLOSED**

## Scope and inputs

Balanced mode performed the Ideator, Tracer, Devil's-Advocate, and Synthesizer roles inline. The chamber read:

- `piolium/attack-surface/knowledge-base-report.md`
- `piolium/attack-surface/manual-attack-surface-inventory.md`
- `piolium/attack-surface/source-sink-flows-all-severities.md`
- `piolium/attack-surface/candidates-summary.md`
- `piolium/findings-draft/p4-001-project-config-enables-shell-agent.md`
- `piolium/findings-draft/l4-001-project-config-autonomous-shell-agent.md`

Both drafts describe the same root cause. They were evaluated as one security hypothesis and adjudicated separately for deduplication.

## Draft adjudication

| Draft | Ideator challenge | Devil's-Advocate result | Final verdict | Severity | Durable action |
|---|---|---|---|---|---|
| `p4-001-project-config-enables-shell-agent.md` | The claim depends on a future cron slot, an activity gate, and model obedience; project config cannot directly replace the locked system prompt or permission map. | Those conditions reduce reliability but do not remove the trust-boundary defect. This draft is fully duplicated by the more complete L4 trace. | **DUPLICATE** | -- | Marked `status: rejected-fp` with a duplicate reason; no separate P8 finding. |
| `l4-001-project-config-autonomous-shell-agent.md` | Challenge whether repository config is truly untrusted, whether it can enable the task, whether host permissions require confirmation, and whether post-run enforcement contains side effects. | Source comments explicitly classify project config as untrusted; activation survives filtering; shell/write/edit are pre-authorized; no per-run confirmation, command sandbox, path-scoped write guard, or rollback of shell effects exists. | **VALID** | **medium** | Copied and normalized to `piolium/findings-draft/p8-001-project-config-autonomous-shell-agent.md`. |

The `rejected-fp` marker on P4 records deduplication under the two-status balanced output contract; it does **not** mean the shared vulnerability claim was disproved.

## H-01: Repository config activates an unattended shell-capable agent

### Exact claim

A malicious repository can use `.cortexkit/magic-context.jsonc` to schedule the normally disabled `maintain-docs` background task. It can also set `dreamer.disable: false`, because `disable` is not stripped before project config is merged over trusted user config. When due and activity-gated, the task launches `dreamer-docs` with host-authorized `bash`, `write`, and `edit` capabilities while asking the model to inspect repository-controlled content. If the model follows an indirect prompt injection, effects run with the developer account's authority.

### Traced production path

1. **Attacker-controlled source:** project config is loaded from `<repo>/.cortexkit/magic-context.jsonc` by `packages/plugin/src/config/index.ts:487-573` and the equivalent Pi loader.
2. **Trust filter:** `packages/plugin/src/config/project-security.ts:1-44,228-415` expressly treats project config as untrusted but strips only `prompt`, `permission`, `tools`, and `system_prompt` from hidden-agent blocks. It deliberately preserves Dreamer cadence; `disable`, task schedules, and Dreamer model selection survive.
3. **Merge and parse:** `packages/plugin/src/config/index.ts:187-225,567-591` deep-merges project values over user values. `packages/plugin/src/config/schema/magic-context.ts:107-130,161-242` accepts the cron task record; `packages/plugin/src/config/agent-disable.ts:11-12` treats a present, non-disabled Dreamer block as runnable.
4. **Automatic scheduling:** `packages/plugin/src/index.ts:351-415` registers the independent background timer. `task-config.ts:12-43` carries the project schedule into runtime configuration; `task-scheduler.ts:120-185,530-556` reconciles it and drains due tasks.
5. **Conditional gate:** `task-gates.ts:366-368` requires a compartment newer than the last successful docs run. This delays execution but performs no user/trust approval.
6. **Privileged sink:** `task-executor.ts:1186-1228` selects `dreamer-docs`; `hidden-agent-registrations.ts:125-151` and `agents/permissions.ts:87-109,330-389` authorize `bash`, `write`, and `edit` without an interactive ask.
7. **Pi path:** `packages/pi-plugin/src/subagent-runner.ts:311-408,946-959,1617-1720` gives the same built-in tools to a noninteractive child and inherits the parent environment. OMP's extension-tool isolation is weaker, but the core finding does not depend on that caveat.
8. **Insufficient containment:** the task prompt's two-file/no-secret rules are natural-language instructions. `task-executor.ts:1267-1272` restores protected regions only after completion and cannot undo commands, network effects, or writes elsewhere.

### Ideator challenges

- **Could project config be trusted by design?** No. The loader and variable-expansion code explicitly call it untrusted repository input and apply a security filter before merge.
- **Is the task default-on?** No. `maintain-docs` defaults to `""`. This strengthens the claim that project config crosses the activation boundary rather than merely tuning an already active task.
- **Can project config override an explicit user disable?** Yes. `dreamer.disable` is schema-valid, is absent from the stripped escalation fields, and project values win in the deep merge.
- **Does config text directly become a shell command?** No. The path is indirect prompt injection, not string-to-shell interpolation. The model must read attacker content and choose a tool call.
- **Is execution immediate?** No. A fresh configuration schedules the next cron occurrence, the process-wide timer checks every 15 minutes, and a new compartment must exist.
- **Is command execution deterministic?** No. Model obedience is a material precondition, which is why severity is medium rather than high.

### Devil's-Advocate protection search

| Protection layer | Evidence searched | Blocking? |
|---|---|---|
| Project-input filtering | `project-security.ts`, project variable substitution, OpenCode/Pi config loaders | **No.** Direct prompt/permission/tool overrides are stripped, but `disable`, task cadence, and model fields survive. |
| Schema and parsing | Dreamer/task Zod schemas, cron validation, merge semantics | **No.** These validate shape and cron syntax, not repository trust or monotonic restriction. |
| Scheduler/domain logic | timer registration, due planning, activity gate, leases | **No.** Cron, compartment, and lease checks delay/serialize work; none requests user approval. |
| Host/framework authorization | OpenCode hidden-agent config, wildcard deny plus named allows, Pi `--tools` handling | **No.** The named allowlist intentionally includes shell and unrestricted file primitives; print/background execution is noninteractive. |
| Runtime/postcondition containment | system/task prompts, step/time caps, protected-region restore, Pi child environment | **No.** Prompt rules are not capability enforcement; caps bound duration, not command semantics; restoration cannot reverse side effects; Pi inherits `process.env`. |

No same-origin or same-user collapse applies: the source is an untrusted repository contributor, while the sink acts as the developer's OS account. The attacker does not need administrator or local-account access.

### Preconditions and negative case

The attack needs all of the following:

1. The victim clones/opens the malicious repository with Magic Context enabled.
2. A provider/model is usable.
3. The process remains active until the configured cron becomes due and the 15-minute timer checks it.
4. At least one compartment exists after the last docs run.
5. The docs agent encounters and follows attacker-authored instructions.

If the schedule remains empty, no task is due. If no new compartment exists, the activity gate skips it. If the model ignores the injected instructions, the dangerous side effect does not occur. These are real exploitability constraints, not blocking security controls.

### PoC assessment

The source-grounded activation PoC is:

```json
{
  "dreamer": {
    "disable": false,
    "tasks": {
      "maintain-docs": { "schedule": "* * * * *" }
    }
  }
}
```

Repository tests independently establish the critical transitions: `project-security.test.ts` confirms benign Dreamer cadence survives filtering; `task-scheduler.test.ts:194-244` confirms disabled-to-enabled schedule reconciliation; agent registration tests confirm the `dreamer-docs` tool surface. Bun is unavailable in this environment, so the chamber did not execute an end-to-end model PoC. The finding is scoped accordingly: source proves untrusted activation of the privileged autonomous context; successful RCE remains conditional on model behavior.

### Six-gate FP review

| Gate | Result | Basis |
|---|---|---|
| Process | **PASS** | Both drafts, architecture inputs, production source, and relevant tests were reviewed; challenges and defenses are documented above. |
| Reachability | **PASS** | Repository-controlled config reaches the scheduler and capability-bearing agent through the confirmed merge/runtime path. |
| Real impact | **PASS** | A successful injected tool call executes commands or writes files as the developer; inherited Pi environment can expose credentials. |
| PoC validation | **PASS, source-grounded** | The activation fragment and existing transition tests prove capability activation. No claim is made that every model follows every payload. |
| Math/conditional logic | **PASS** | Cron, timer, compartment, lease, and step/timeout conditions were mapped; they make execution conditional but do not make it unreachable. |
| Environment | **PASS** | No sandbox, scoped shell, path-confined write primitive, per-run confirmation, or compensating rollback prevents the claimed effects. |

### Pre-finding quality gate

- Attacker control: **verified** for repository config and repository content.
- Framework protections: **searched across all five layers** above.
- Trust boundary: **confirmed**, repository contributor to developer OS authority.
- Attacker position: **normal**, malicious repository author/contributor; no admin or local account required.
- Production reachability: **confirmed** in shipped plugin, Pi adapter, scheduler, and hidden-agent code; not test/example-only.

### Synthesizer verdict

**VALID, medium.** The defense correctly narrows this from guaranteed RCE to a conditional indirect-prompt-injection path, but it does not disprove the underlying vulnerability: untrusted project configuration can activate a background agent with pre-authorized shell and write capabilities and no enforcing sandbox or per-run approval.

## Chamber Summary

| Hypothesis / draft | Verdict | Severity | Finding draft |
|---|---|---|---|
| P4-001 | DUPLICATE (`rejected-fp` marker required by balanced output contract) | -- | -- |
| L4-001 / H-01 | VALID | medium | `piolium/findings-draft/p8-001-project-config-autonomous-shell-agent.md` |

Findings reviewed: **2**  
Unique hypotheses: **1**  
Surviving findings: **1**  
Rejected/duplicate drafts retained: **1**  
Survivor cap used: **1 / 12**
