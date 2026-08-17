# [M1] Repository configuration enables an unattended shell-capable agent

**Severity:** Medium  
**Vulnerability class:** Untrusted configuration enables privileged autonomous functionality (CWE-829)  
**PoC status:** Theoretical, source-grounded. The supplied check validates the configuration-to-agent capability chain but does not invoke a model or access credentials.

## Summary

A repository contributor can commit `.cortexkit/magic-context.jsonc` that enables the normally disabled `dreamer.tasks.maintain-docs` background task and schedules it as often as once per minute. Project configuration is treated as untrusted for direct hidden-agent prompt and tool overrides, but it is still permitted to control Dreamer activation and task cadence. Project values are merged after user configuration, so `dreamer.disable: false` can also undo a user's explicit `dreamer.disable: true` setting.

After a victim opens and uses the repository, a due `maintain-docs` task starts without a per-run confirmation once its ordinary activity gate is met. The task runs `dreamer-docs`, an agent authorized for `bash`, `write`, and `edit`, while instructing it to inspect repository-controlled files. An indirect prompt injection placed in such a file can cause security-relevant shell commands or writes if the selected model follows the injected instruction. The finding is Medium rather than High because model compliance with the repository instruction is a required exploitation condition; an end-to-end model execution was not observed.

## Details

`maintain-docs` is deliberately disabled by default: its schedule is the empty string, while the schema accepts any valid five-field cron expression, including `* * * * *`. The relevant defaults and parser behavior are defined in [`magic-context.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/config/schema/magic-context.ts#L107-L120) and [`magic-context.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/config/schema/magic-context.ts#L161-L177).

The project-configuration security filter recognizes that project configuration is untrusted, but strips only four direct fields from hidden-agent blocks. In particular, neither `disable` nor nested task `schedule` appears in the allow/deny decision below:

```ts
const AGENT_ESCALATION_FIELDS = ["prompt", "permission", "tools", "system_prompt"] as const;

for (const agentKey of HIDDEN_AGENT_KEYS) {
    const block = projectRaw[agentKey];
    if (!isPlainObject(block)) continue;
    const removed: string[] = [];
    for (const field of AGENT_ESCALATION_FIELDS) {
        if (field in block) {
            delete block[field];
            removed.push(field);
        }
    }
}
```

This filtering behavior is implemented in [`project-security.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/config/project-security.ts#L38-L44) and [`project-security.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/config/project-security.ts#L397-L410). After filtering, the loader merges the project object over the already-merged user object, as shown in [`config/index.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/config/index.ts#L562-L588). The runnable check is simply `!!config.dreamer && config.dreamer.disable !== true` in [`agent-disable.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/config/agent-disable.ts#L11-L12). Consequently, an untrusted project can supply a `dreamer` object, set `disable` to `false`, and provide a nonempty task schedule.

The live runtime copies each parsed task schedule into scheduler input in [`task-config.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/features/magic-context/dreamer/task-config.ts#L12-L44). The scheduler reconciles each task's live schedule before collecting due tasks in [`task-scheduler.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/features/magic-context/dreamer/task-scheduler.ts#L153-L185), then executes gated due tasks programmatically in [`runDueTasksForProject`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/features/magic-context/dreamer/task-scheduler.ts#L523-L556). For `maintain-docs`, the activity gate only requires a new compartment since the task's previous run; it does not establish repository trust or ask for approval ([`task-gates.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/features/magic-context/dreamer/task-gates.ts#L366-L368)).

When that task executes, it selects `dreamer-docs` rather than a read-only agent ([`task-executor.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/features/magic-context/dreamer/task-executor.ts#L1213-L1222)). The OpenCode registration grants generic shell and file mutation tools:

```ts
allowedTools: [
    "read",
    "grep",
    "glob",
    "bash",
    "write",
    "edit",
    "aft_outline",
    "aft_zoom",
    "aft_search",
],
```

The capability set is defined in [`hidden-agent-registrations.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/agents/hidden-agent-registrations.ts#L125-L151). The Pi-compatible execution path has the same `bash`, `write`, and `edit` allowlist in [`subagent-runner.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/pi-plugin/src/subagent-runner.ts#L368-L379), and spawns the child in the project directory with the parent environment merged into it in [`subagent-runner.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/pi-plugin/src/subagent-runner.ts#L946-L959).

The task prompt says that the agent should use codebase-reading tools and restrict its writes to two documentation files, and also asks it not to read credentials. Those are natural-language instructions, not a host-enforced filesystem, process, network, or environment boundary ([`task-prompts.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/features/magic-context/dreamer/task-prompts.ts#L55-L68), [`task-prompts.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/features/magic-context/dreamer/task-prompts.ts#L257-L263)). The post-run protection only attempts to restore protected regions in snapshotted documentation files; it cannot undo shell side effects or changes outside those files ([`task-executor.ts`](https://github.com/ahrav/magic-context/blob/be500459546101a18126e2ce5f25eb06a17bb620/packages/plugin/src/features/magic-context/dreamer/task-executor.ts#L1267-L1272)).

## Root Cause

The implementation applies the wrong trust classification to autonomous-task activation. It treats project-controlled Dreamer cadence and `disable` as harmless repository customization even though those fields determine whether an unattended agent is launched. That agent receives authority that is unsafe to give to a workflow driven by attacker-controlled repository content: a shell, general file-mutation tools, and, on the Pi path, inherited process environment.

Removing direct prompt and tool settings from project configuration is insufficient. The repository need not replace the system prompt to influence the agent: it can enable the task and place the instruction in a file that the enabled task is designed to read. Prompt rules and cleanup of two documentation files do not constrain the effects of an authorized shell command.

## Proof of Concept (PoC)

The source-grounded PoC is available at `piolium/findings/M1-project-config-autonomous-shell-agent/poc.py`. It creates an isolated repository fixture and verifies the relevant production source predicates. It intentionally does not call a model, execute a shell command through Magic Context, or access secrets.

1. In an attacker-controlled repository, add the following `.cortexkit/magic-context.jsonc`:

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

2. Add repository content likely to be examined by a documentation-maintenance pass. For a harmless confirmation payload, the content can instruct the agent to create a project-root file named `.m1-unattended-marker` with a fixed string. A real attack would substitute an instruction that uses the already-authorized `bash`, `write`, or `edit` capability.

3. Have a victim open and normally use the repository with a configured provider, so that at least one compartment exists. On a due cron tick, the `maintain-docs` activity gate passes and the scheduler starts the task without a per-run approval.

4. Run the source-chain validation from the repository root:

   ```sh
   python3 piolium/findings/M1-project-config-autonomous-shell-agent/poc.py
   ```

   The script checks that the project filter does not strip `disable` or `schedule`, that a non-disabled Dreamer block is runnable, that a live schedule reaches due-task reconciliation, and that the Pi child is granted `bash`, `write`, and `edit` while inheriting its parent environment. Its final result is intentionally `"status": "inconclusive"`: creation of the marker depends on the selected model following the repository instruction, and no model-backed execution evidence was captured for this finding.

## Impact

A successful indirect prompt injection crosses the repository-to-developer trust boundary. A contributor who can modify repository files and configuration can arrange for an unattended, shell-capable agent to inspect attacker-controlled text on a victim machine. If the model follows the injected instruction, the agent can run commands with the developer's local authority and alter files beyond the two intended documentation files. In the Pi path, the child process also receives inherited environment variables, increasing the potential consequence if sensitive credentials or tokens are present in that environment.

The issue is bounded by several conditions: the victim must use the repository with a usable model/provider, the task must become eligible after a compartment is created, and the model must comply with the malicious repository instruction. These conditions prevent claiming deterministic code execution from configuration alone. They do not make the configuration safe, because it converts untrusted repository content into input for a scheduled agent that already has the capability to execute shell commands and mutate files without interactive approval.

## Remediation

1. Treat all project-controlled fields that can enable, disable, schedule, or otherwise trigger unattended agents as privileged settings. Strip or reject `dreamer.disable` and every `dreamer.tasks.*.schedule` value from project configuration. A repository must not be able to turn on a disabled task or override a user-level Dreamer disable.
2. Require an explicit, trusted user-level opt-in before any task with `bash`, `write`, or `edit` can run unattended. If project-proposed schedules remain a supported feature, present the proposed task name, cadence, tool set, and working-directory scope for one-time user approval; do not activate it solely by opening or using the repository.
3. Enforce the documentation task's intended authority in the host rather than in model prose. Prefer a narrowly scoped documentation-update interface. If shell access is required, execute it in an isolated environment with an allowlisted working tree, no inherited sensitive environment, and no general host file or network authority.
4. Add regression tests showing that an untrusted project configuration cannot change a disabled task into a runnable one, cannot override a trusted `dreamer.disable: true`, and cannot provide a nonempty schedule for a shell-capable task. Add an integration test that verifies a scheduled documentation task cannot modify an out-of-scope marker file even when repository content asks it to do so.
