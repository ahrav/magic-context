import { log } from "../shared/logger";

/**
 *
 *
 *
 * Historian may only read offloaded state files and emit `<compartment>` blocks.
 * Direct `client.session.prompt(...)` sessions retain the primary `build` agent's `task` permission.
 *
 * # Design
 *
 * Place named allows after `{ "*": "deny" }` because `Permission.evaluate` uses `findLast`.
 *
 * (see `packages/opencode/src/agent/agent.ts:179-201`).
 *
 * User permission overrides merge after the default allow-list and can extend it.
 *
 *
 * `historian`, `historian-editor`, and `compressor` use `aft_search` to navigate existing-state XML.
 * The runner stores large existing-state XML under `<project>/.opencode/magic-context/historian/`.
 *
 * Each dreamer task uses a scoped agent so scheduled loops receive only task-required tools.
 * The base `dreamer` agent has no tools; the host validates its XML manifest before applying claim writes.
 * The host applies manifest memory writes, so dreamer agents do not receive `ctx_memory`.
 * Dreamer agents must not receive `task` because dreamer tasks must not spawn subagents.
 *     spawn subagents.
 *
 * Sidekick uses AFT navigation to retrieve structural context for prompt-referenced symbols and files.
 */

/**
 *
 * The returned record is compatible with `AgentConfig.permission`.
 * agent profiles.
 */
export function buildAllowOnlyPermission(
    allowedTools: readonly string[] | undefined,
    agentLabel?: string,
): Record<string, "deny" | "allow"> {
    const permission: Record<string, "deny" | "allow"> = { "*": "deny" };
    if (allowedTools === undefined) {
        log(
            `[magic-context] buildAllowOnlyPermission: allow-list UNDEFINED for ${agentLabel ?? "unknown agent"} — registering deny-all (defensive)`,
            { stackHead: new Error().stack?.split("\n").slice(1, 6).join("\n") },
        );
    }
    for (const tool of allowedTools ?? []) {
        permission[tool] = "allow";
    }
    return permission;
}

type PermissionAction = "ask" | "allow" | "deny";

function isPermissionAction(value: unknown): value is PermissionAction {
    return value === "ask" || value === "allow" || value === "deny";
}

function isPermissionMap(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 *
 * OpenCode accepts either a whole-permission action or a pattern map for `permission.task`.
 * `permission.task` uses the last matching rule.
 * The function appends exact agent-ID denies after user task patterns and the `*` rule.
 */
export function denyTaskRoutingToAgents(
    permission: unknown,
    internalAgentIds: readonly string[],
): Record<string, unknown> {
    const configured = isPermissionAction(permission)
        ? { "*": permission }
        : isPermissionMap(permission)
          ? permission
          : {};
    const { task, ...otherPermissions } = configured;
    const configuredTask = isPermissionAction(task)
        ? { "*": task }
        : isPermissionMap(task)
          ? task
          : {};
    const internalAgentIdSet = new Set(internalAgentIds);
    const retainedTask = Object.fromEntries(
        Object.entries(configuredTask).filter(([agentId]) => !internalAgentIdSet.has(agentId)),
    );

    return {
        ...otherPermissions,
        task: {
            ...retainedTask,
            ...Object.fromEntries(internalAgentIds.map((agentId) => [agentId, "deny"])),
        },
    };
}

const BUILTIN_TASK_CALLER_IDS = ["build", "plan"] as const;

function isTaskRoutingCaller(agentId: string, config: Record<string, unknown>): boolean {
    const mode = config.mode;
    // OpenCode compatibility:
    // Agents that may execute as Task children retain their existing permissions because explicit task permissions alter OpenCode's default anti-nesting behavior.
    if (mode === "primary") return true;
    if (mode === "subagent" || mode === "all") return false;
    return agentId === "build" || agentId === "plan";
}

/**
 *
 * A top-level `permission.task` rule suppresses the Task tool's default deny for ordinary subagents.
 */
export function denyTaskRoutingToCallerAgents(
    agentConfigs: Record<string, Record<string, unknown>>,
    internalAgentIds: readonly string[],
): Record<string, Record<string, unknown>> {
    const result = { ...agentConfigs };
    const candidateIds = new Set([...BUILTIN_TASK_CALLER_IDS, ...Object.keys(agentConfigs)]);

    for (const agentId of candidateIds) {
        const agentConfig = agentConfigs[agentId] ?? {};
        if (!isTaskRoutingCaller(agentId, agentConfig)) continue;
        result[agentId] = {
            ...agentConfig,
            permission: denyTaskRoutingToAgents(agentConfig.permission, internalAgentIds),
        };
    }

    return result;
}

/**
 *
 * Historian runners offload large `<existing_state>` XML to disk.
 * Historian runners instruct the model to `read` the stored XML before emitting summary XML.
 * Historian runners require `read` to load offloaded `<existing_state>` XML.
 * Historian and compressor agents use `aft_outline` and `aft_zoom` to inspect offloaded XML without mutation.
 * AFT navigation lets historian and compressor agents inspect symbols or file structure without reading whole files.
 *
 * Historian agents summarize supplied input rather than explore the repository.
 */
export const HISTORIAN_ALLOWED_TOOLS = ["read", "aft_outline", "aft_zoom", "aft_search"] as const;

/**
 */
export function applyDisallowedTools(
    defaults: readonly string[],
    disallowed: readonly string[],
): readonly string[] {
    if (disallowed.includes("*")) return [];
    return defaults.filter((t) => !disallowed.includes(t));
}

/**
 *
 *
 */

export const DREAMER_RETROSPECTIVE_ALLOWED_TOOLS = ["ctx_search"] as const;

/**
 */
export const DREAMER_PRIMER_INVESTIGATOR_ALLOWED_TOOLS = [
    "read",
    "grep",
    "glob",
    "aft_outline",
    "aft_zoom",
    "aft_search",
    "ctx_search",
] as const;

/**
 */
export const SMART_NOTE_COMPILER_ALLOWED_TOOLS = [] as const;

export const SIDEKICK_ALLOWED_TOOLS = ["ctx_search", "aft_outline", "aft_zoom"] as const;
