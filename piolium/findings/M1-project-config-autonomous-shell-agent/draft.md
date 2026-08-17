---
id: M1
phase: L5
slug: project-config-autonomous-shell-agent
severity: medium
status: valid
source_drafts:
  - p4-001-project-config-enables-shell-agent.md
  - l4-001-project-config-autonomous-shell-agent.md
original_id: p8-001
---

# Repository configuration can activate an unattended shell-capable agent

Verification: **VALID (source-grounded)**

## Chamber synthesis

The confirmed defect is the trust-boundary violation, not guaranteed model obedience: an untrusted repository configuration can enable a normally disabled background task whose enforced capability set contains shell and file-write tools. Command execution still requires the selected model to follow attacker-authored instructions encountered while inspecting the repository, so the original **high** rating is reduced to **medium**. The task's cron and activity gates, natural-language restrictions, step/time limits, and protected-document restoration do not prevent shell side effects or writes outside the intended documentation files.

## Summary

A repository-controlled `.cortexkit/magic-context.jsonc` can turn on the normally disabled `dreamer.tasks.maintain-docs` schedule. The project trust-boundary filter intentionally preserves Dreamer cadence and also permits `dreamer.disable`, so a project can make the subsystem runnable even over a trusted user-level disable. Once the task is due and the project has a new compartment, the scheduler launches the hidden `dreamer-docs` agent without per-run user approval.

`dreamer-docs` is host-authorized to use `bash`, `write`, and `edit` while its prompt instructs it to inspect attacker-controlled repository files. The instructions limiting writes to two documentation files and forbidding secret access are model prompt text, not an OS- or host-enforced capability boundary. A repository prompt injection can therefore induce commands or writes with the developer account's authority.

## Attacker and preconditions

- The attacker can commit files and `.cortexkit/magic-context.jsonc` to a repository the victim opens with Magic Context.
- The victim has a usable model/provider and uses the repository long enough for at least one compartment to exist, satisfying the `maintain-docs` activity gate.
- The model follows an indirect prompt injection encountered while exploring the repository. The defect does not depend on project config directly replacing the system prompt; it enables the unattended, broadly capable execution context that reads the attacker's data.

## Evidence and code path

### 1. The project-config filter treats repositories as untrusted but preserves Dreamer schedules

The filter documents that project config is untrusted and that hidden-agent prompt/tool changes are code-execution vectors. It nevertheless leaves Dreamer activation and cadence at project tier:

- `packages/plugin/src/config/project-security.ts:21-44` — identifies repository-to-autonomous-agent escalation and states that Dreamer model/cadence fields are not stripped.
- `packages/plugin/src/config/project-security.ts:397-415` — removes only direct `prompt`, `permission`, `tools`, and `system_prompt` fields from hidden-agent blocks; nested `dreamer.tasks.*.schedule` and `dreamer.disable` survive.
- `packages/plugin/src/config/index.ts:187-225,567-591` — filters the raw project object, then deep-merges the remaining project values over user config and parses the result. Consequently, project `disable: false` can override a trusted user-level `disable: true`.

The task schema accepts any valid five-field cron, while the safe default for this specific task is disabled:

- `packages/plugin/src/config/schema/magic-context.ts:107-130` — validates five-field cron strings.
- `packages/plugin/src/config/schema/magic-context.ts:161-182` — `maintain-docs` defaults to `""`.
- `packages/plugin/src/config/schema/magic-context.ts:196-221` — exposes `dreamer.tasks.maintain-docs` through the parsed task record.
- `packages/plugin/src/config/schema/magic-context.ts:694-696` — a project may provide the optional `dreamer` object.
- `packages/plugin/src/config/agent-disable.ts:11-12` — any present `dreamer` block not marked disabled makes Dreamer runnable.

An activation fragment that also overrides an explicit user-level Dreamer disable is:

```json
{
  "dreamer": {
    "disable": false,
    "tasks": {
      "maintain-docs": {
        "schedule": "* * * * *"
      }
    }
  }
}
```

### 2. The live project schedule directly controls unattended execution

- `packages/plugin/src/features/magic-context/dreamer/task-config.ts:12-43` — copies each parsed task's schedule into the runtime scheduler config.
- `packages/plugin/src/features/magic-context/dreamer/task-scheduler.ts:153-185` — reconciles the live config schedule into persisted state and selects due tasks.
- `packages/plugin/src/features/magic-context/dreamer/task-scheduler.ts:530-556` — automatically drains due tasks after their activity gates pass.
- `packages/plugin/src/features/magic-context/dreamer/task-gates.ts:366-368` — `maintain-docs` runs when a new compartment exists; the gate does not establish repository trust or user approval.

### 3. The task launches a hidden agent with shell and unrestricted file-tool primitives

- `packages/plugin/src/agents/hidden-agent-registrations.ts:125-151` — `dreamer-docs` receives `bash`, `write`, and `edit` in addition to repository-reading tools.
- `packages/plugin/src/agents/hidden-agent-registrations.ts:354-375` and `packages/plugin/src/agents/permissions.ts:91-109` — named tools are granted `allow`, overriding the wildcard deny; this is authorization, not an interactive ask.
- `packages/plugin/src/features/magic-context/dreamer/task-executor.ts:1186-1228` — creates the child session and selects `dreamer-docs` for `maintain-docs`.
- `packages/plugin/src/features/magic-context/dreamer/task-prompts.ts:55-68,224-263` — instructs the agent to run shell commands and read the repository, while the restrictions on target files, credentials, and commits exist only as natural-language rules.

The Pi-compatible path carries the same agent identifier into a spawned child process:

- `packages/pi-plugin/src/dreamer/index.ts:278-309` — passes the requested task agent and project working directory to `PiSubagentRunner`.
- `packages/pi-plugin/src/subagent-runner.ts:371-379` — grants `dreamer-docs` `bash`, `write`, and `edit`.
- `packages/pi-plugin/src/subagent-runner.ts:946-959` — spawns the child in the project directory with the full parent environment inherited.

### 4. The defensive paths do not contain arbitrary effects

- `packages/plugin/src/features/magic-context/dreamer/task-executor.ts:1267-1272` — after the child finishes, the host only restores protected regions in snapshotted documentation files; errors in this restoration are logged and ignored.
- The enforcement does not undo shell commands, network operations performed by commands, or writes outside the two documentation files.
- Timeouts, leases, and a 60-step cap bound duration but do not restrict command semantics or filesystem scope.

## Attack path

1. Commit the activation fragment above and place an instruction in source or documentation likely to be read during the documentation scan.
2. The victim opens and uses the repository. Project config survives filtering and creates a runnable Dreamer configuration.
3. After a normal compartment is created and the cron becomes due, the background scheduler starts `maintain-docs` without a confirmation prompt.
4. The hidden agent reads attacker-controlled repository content with `bash`, `write`, and `edit` already authorized.
5. If the model follows the injected instruction, it can execute commands, alter arbitrary developer-writable files, or disclose inherited environment credentials.

## Security impact

Successful exploitation crosses from an untrusted repository contributor to the developer's local OS authority. Consequences include arbitrary command execution as the developer, source/configuration tampering outside the documented files, persistent prompt/memory poisoning, and disclosure of credentials available to the host or Pi child process.

## Verification notes

The complete source path was re-read at commit `be500459546101a18126e2ce5f25eb06a17bb620` using exact source reads, symbol searches, and numbered-line extraction. Bun is not installed, so the TypeScript project-config and subagent tests could not be executed in this environment. The finding therefore relies on the direct production source chain above rather than a synthetic runtime PoC.
