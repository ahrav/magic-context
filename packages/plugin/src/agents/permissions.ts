import { log } from "../shared/logger";

/**
 * Permission rulesets for Magic Context's hidden subagents.
 *
 * # Why this exists
 *
 * Hidden agents (`historian`, `historian-editor`, `dreamer`, `sidekick`) are
 * registered with `mode: "primary"` and `hidden: true`: primary mode keeps
 * them out of OpenCode's general Task candidate list, while hidden keeps them
 * out of the UI picker. Those flags do NOT restrict which tools the spawned
 * session can call. By default a registered agent
 * inherits the FULL primary-agent tool surface: `task`, `bash`, `edit`,
 * `webfetch`, `websearch`, `read`, `grep`, `glob`, every MCP tool, etc.
 *
 * That default is wrong for our agents:
 *   - Historian should be a pure XML-emitting summarizer. It must not
 *     dispatch `task(subagent_type=explore)` to fan out, edit files,
 *     run bash, or fetch the web — its job is to read offloaded state
 *     files and emit `<compartment>` blocks.
 *   - The `task` permission only gets auto-denied when an agent is
 *     INVOKED via the parent's `task()` tool (see OpenCode's
 *     `deriveSubagentSessionPermission`). Our hidden agents are spawned
 *     directly via `client.session.prompt(...)` from the plugin
 *     runtime, so that auto-deny never fires — they get the same
 *     `task` permission as a primary `build` agent.
 *
 * # Design
 *
 * Each hidden agent's `permission` field starts with `{ "*": "deny" }`
 * and adds explicit `allow` entries for ONLY the tool ids it needs.
 * OpenCode's `Permission.fromConfig` converts this flat map into a
 * `Rule[]` ruleset where later entries override earlier ones, so the
 * named allows always win against the wildcard deny.
 *
 * This is the same pattern OpenCode's own `explore` subagent uses
 * (see `packages/opencode/src/agent/agent.ts:179-201`).
 *
 * User-supplied agent overrides (`pluginConfig.historian.permission`,
 * etc.) still merge on top via OpenCode's `Permission.merge`, so
 * advanced users can extend the allow-list without us blocking them.
 *
 * # What each agent needs
 *
 *   - **historian / historian-editor / compressor**: `read` plus the
 *     read-only AFT navigation/search tools `aft_outline`, `aft_zoom`,
 *     and `aft_search`. The runner offloads large existing-state XML to
 *     a temp file under `<project>/.opencode/magic-context/historian/`
 *     and the prompt instructs the model to read that file. AFT
 *     navigation is allowed so historian can find or verify a symbol or
 *     file structure when writing accurate compartment summaries.
 *
 *   - **dreamer**: no single allow-list. Each dreamer task runs on its
 *     own scoped agent whose allow-list lives beside it in `dreamer.ts`,
 *     so every unsupervised scheduled loop carries only the surface that
 *     one task needs. The base `dreamer` agent is curate and holds ZERO
 *     tools: it emits one XML manifest and the host validates it and
 *     applies every claim write inside a single guarded transaction. No
 *     dreamer agent holds `ctx_memory` — the host applies memory writes
 *     from the agent's manifest, so none of them needs a mutation tool.
 *     `task` stays denied across all of them: a dreamer task must never
 *     spawn subagents.
 *
 *   - **sidekick**: `ctx_search`, plus the read-only AFT
 *     navigation tools `aft_outline` and `aft_zoom`. Sidekick's job
 *     is augmenting user prompts via memory retrieval — see
 *     `features/magic-context/sidekick/agent.ts`. AFT navigation lets
 *     it pull symbol-scoped structural context for prompts that
 *     reference a specific file or symbol.
 */

/**
 * Build a `permission` map suitable for `AgentConfig.permission`. Starts
 * with a wildcard deny, then layers in the named tool allows on top.
 * OpenCode's `Permission.fromConfig` preserves insertion order and its
 * `evaluate` uses `findLast`, so named allows defeat the wildcard deny.
 *
 * Returns `Record<string, "deny" | "allow">` which the SDK's
 * `AgentConfig.permission` type accepts via its `[key: string]: unknown`
 * index signature. The same pattern is used by OpenCode's built-in
 * `explore`/`scout`/`general` agents and by Alfonso for its static
 * agent profiles.
 */
export function buildAllowOnlyPermission(
    allowedTools: readonly string[] | undefined,
    agentLabel?: string,
): Record<string, "deny" | "allow"> {
    const permission: Record<string, "deny" | "allow"> = { "*": "deny" };
    // Defensive: never throw on an undefined allow-list. A `for..of` on undefined
    // crashes with "undefined is not an object (evaluating 'allowedTools')", and
    // because this runs inside the plugin's `config` hook a throw there fails the
    // ENTIRE plugin load — disabling the transform/compaction. Degrade to a
    // deny-all agent instead of taking Magic Context down.
    if (allowedTools === undefined) {
        // Observed only inside OpenCode's plugin loader (never in an isolated
        // import of the same dist), so capture WHICH agent + a stack to pin the
        // real cause on the next natural restart. Should never fire.
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
 * Add final `permission.task` denies for Magic Context's internal workers.
 *
 * OpenCode accepts either a whole-permission action or a pattern map for
 * `permission.task`; its evaluator uses the last matching rule. Normalize the
 * whole-permission form, retain every unrelated user rule, then append our
 * exact agent-id denies after both the user's task patterns and any `*` rule.
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
    // Only strictly-primary callers receive explicit Task routing rules.
    // Agents that may execute as Task children are left untouched,
    // because explicit task permissions can alter OpenCode's default anti-nesting
    // behavior in the currently supported permission model.
    if (mode === "primary") return true;
    if (mode === "subagent" || mode === "all") return false;
    return agentId === "build" || agentId === "plan";
}

/**
 * Apply Task routing denies only to agents that can act as Task callers.
 *
 * A top-level permission rule is merged into every OpenCode agent. Adding one
 * there would suppress the Task tool's default deny for ordinary subagents, so
 * seed only the built-in interactive callers and configured primary agents.
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
 * Tools the historian + historian-editor + compressor agents need.
 *
 * Historian runners offload large `<existing_state>` XML to disk and
 * tell the model to `read` it before emitting the summary XML. The
 * core need is `read`; we also allow the read-only AFT navigation
 * tools `aft_outline` and `aft_zoom` so that if a historian/compressor
 * ever needs to verify a symbol or skim a file's structure to write
 * an accurate compartment summary, it can do so token-efficiently
 * instead of pulling whole files via `read`.
 *
 * Still denied: bash, edit, write, task, grep/glob, webfetch/
 * websearch. Historian's job is summarizing the input it was given,
 * not exploring the repo.
 */
export const HISTORIAN_ALLOWED_TOOLS = ["read", "aft_outline", "aft_zoom", "aft_search"] as const;

/**
 * Subtract `disallowed` from the default historian allow-list. `"*"` removes
 * all tools. Unknown tool names are silently ignored (the Zod enum in the
 * config schema rejects them at parse time, so this is defense-in-depth).
 */
export function applyDisallowedTools(
    defaults: readonly string[],
    disallowed: readonly string[],
): readonly string[] {
    if (disallowed.includes("*")) return [];
    return defaults.filter((t) => !disallowed.includes(t));
}

// There is no combined dreamer allow-list: each dreamer task runs on its own
// scoped agent, holding the narrowest surface that task needs. Curate uses
// DREAMER_CURATE_ALLOWED_TOOLS, which is empty — it emits one XML manifest and
// the host validates it and applies every claim write inside a single guarded
// transaction, so granting ctx_memory would expose
// list/create/revise/archive/restore/merge to the model and let a run mutate
// claims outside that transaction. maintain-docs uses
// DREAMER_DOCS_ALLOWED_TOOLS (file read/write/bash, no memory). Both live in
// `dreamer.ts` alongside the other per-task allow-lists (mapper/classifier/etc).

/**
 * Tools the sidekick agent needs. Sidekick is a read-only memory
 * retriever for `/ctx-aug` — it queries the project's memory store
 * through `ctx_search` only. Keep `ctx_memory` out of this list because
 * its OpenCode tool definition is mutation-capable for primary agents.
 *
 * Also allow `aft_outline` and `aft_zoom` so sidekick can pull
 * lightweight structural context about a file or symbol when the
 * user's prompt references it directly — token-efficient navigation
 * without dragging in whole files.
 *
 * Still denied: spawning subagents, edits, bash, web fetches.
 */

export const DREAMER_RETROSPECTIVE_ALLOWED_TOOLS = ["ctx_search"] as const;

/**
 * The refresh-primers code investigator: read + navigate + search the CURRENT
 * source to answer a primer question. NO write/edit/bash (could corrupt user
 * source) and NO ctx_memory/ctx_note (a ctx_memory mutation bumps the project
 * memory epoch → busts m[0], breaking the primers cache-neutral contract).
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
 * The smart-note compiler consumes untrusted note text and emits code that will
 * later run in the QuickJS sandbox. It must not have ambient tools: all I/O is
 * performed only when the compiled check runs through the host capability API.
 */
export const SMART_NOTE_COMPILER_ALLOWED_TOOLS = [] as const;

export const SIDEKICK_ALLOWED_TOOLS = ["ctx_search", "aft_outline", "aft_zoom"] as const;
