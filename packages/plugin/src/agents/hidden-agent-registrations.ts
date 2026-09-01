import { applyDisallowedTools, buildAllowOnlyPermission } from "./permissions";

/**
 *
 *
 *
 */

// Hidden-agent caps are 40 for historian and sidekick and 150 for dreamer.
function clampHiddenAgentStepLimit(value: unknown, cap: number): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(value, cap) : cap;
}

/**
 *
 *
 *
 *
 * diverge.
 */
export const HIDDEN_AGENT_DESCRIPTION_MARKER = "Internal Magic Context";
const HIDDEN_AGENT_DESCRIPTION =
    "Internal Magic Context maintenance agent. Not for general tasks — do not select for user work.";

export interface HiddenAgentRegistration {
    id: string;
    /** OpenCode's task registry excludes primary agents from general subagent routing. */
    mode: "primary";
    /** Hidden agents stay out of the UI picker while remaining directly resolvable. */
    hidden: true;
    /** Description used by OpenCode's automatic name/description-based task router; keep it generic so this hidden agent is not selected for unrelated tasks. */
    description: string;
    prompt: string | undefined;
    allowedTools: readonly string[];
    maxSteps: number;
    overrides?: Record<string, unknown>;
    /** `lockPermissions` drops user `permission` overrides for privacy-critical agents. */
    lockPermissions?: boolean;
}

/**
 */
export function buildHiddenAgentRegistrations(args: {
    dreamerPrompt: string | undefined;
    smartNoteCompilerPrompt?: string | undefined;
    historianPrompt: string | undefined;
    historianRecompPrompt?: string | undefined;
    historianEditorPrompt: string | undefined;
    sidekickPrompt: string | undefined;
    dreamerOverrides?: Record<string, unknown>;
    historianOverrides?: Record<string, unknown>;
    sidekickOverrides?: Record<string, unknown>;
    historianDisallowed: readonly string[];
}): HiddenAgentRegistration[] {
    const historianAllowedTools = applyDisallowedTools(
        ["read", "aft_outline", "aft_zoom", "aft_search"],
        args.historianDisallowed,
    );
    return [
        {
            id: "dreamer",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // The host validates Curate's XML manifest and applies all claim writes in one guarded transaction.
            // The guarded transaction is Curate's only claim-write path.
            // Granting `ctx_memory` would let a run mutate claims outside that transaction.
            // Curate reads no code because a separate verify task checks memory against code.
            // `DREAMER_CURATE_ALLOWED_TOOLS` must match this literal byte-for-byte.
            allowedTools: [],
            // high cap.
            maxSteps: 150,
            overrides: args.dreamerOverrides,
            // `lockPermissions` prevents user dreamer `tools` and `permission` overrides from granting Curate any tools.
            // still apply.
            lockPermissions: true,
        },
        {
            id: "dreamer-docs",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // Documentation maintenance does not require memory access.
            // agent-registration-drift.test.ts requires this literal to match DREAMER_DOCS_ALLOWED_TOOLS byte-for-byte.
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
            maxSteps: 60,
            overrides: args.dreamerOverrides,
            // lockPermissions prevents user overrides from adding memory tools.
            lockPermissions: true,
        },
        {
            id: "dreamer-reviewer",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // The host applies the reviewer's verdict, so the reviewer needs no tools.
            allowedTools: [],
            maxSteps: 4,
            overrides: args.dreamerOverrides,
            lockPermissions: true,
        },
        {
            id: "dreamer-retrospective",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            allowedTools: ["ctx_search"],
            maxSteps: 40,
            overrides: args.dreamerOverrides,
            // The child reads raw user text from other sessions.
            // lockPermissions prevents permission overrides from broadening the agent's ctx_search-only access.
            lockPermissions: true,
        },
        {
            id: "dreamer-primer-investigator",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // The agent investigates the current source to answer a primer without modifying it.
            allowedTools: [
                "read",
                "grep",
                "glob",
                "aft_outline",
                "aft_zoom",
                "aft_search",
                "ctx_search",
            ],
            // maxSteps is 40 to cap the cost of each targeted primer investigation.
            maxSteps: 40,
            overrides: args.dreamerOverrides,
            lockPermissions: true,
        },
        {
            id: "dreamer-memory-mapper",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // The agent checks local source for map-memories and verify without modifying it.
            // ctx_memory mutations bump the project memory epoch and invalidate cached map-memory results.
            // The host applies the manifest's database writes, so the agent does not need ctx_memory.
            // Map-memory and verify tasks compare local source, so they cannot use `ctx_search`.
            // recall).
            allowedTools: ["read", "grep", "glob", "aft_outline", "aft_zoom", "aft_search"],
            // maxSteps is 40 to cap the cost of each targeted map or verify batch.
            maxSteps: 60,
            overrides: args.dreamerOverrides,
            // lockPermissions prevents user permission and tools overrides from restoring denied write, bash, or ctx_memory access.
            lockPermissions: true,
        },
        {
            id: "dreamer-classifier",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // `lockPermissions` prevents user overrides from granting tools.
            allowedTools: [],
            maxSteps: 4,
            overrides: args.dreamerOverrides,
            lockPermissions: true,
        },
        {
            id: "smart-note-compiler",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.smartNoteCompilerPrompt,
            allowedTools: [],
            maxSteps: 8,
            overrides: args.dreamerOverrides,
            // `lockPermissions` prevents user dreamer overrides from granting compiler tools.
            lockPermissions: true,
        },
        {
            id: "historian",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.historianPrompt,
            allowedTools: historianAllowedTools,
            maxSteps: 40,
            overrides: args.historianOverrides,
        },
        {
            id: "historian-recomp",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.historianRecompPrompt ?? args.historianPrompt,
            allowedTools: historianAllowedTools,
            maxSteps: 40,
            overrides: args.historianOverrides,
        },
        {
            id: "historian-editor",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.historianEditorPrompt,
            allowedTools: historianAllowedTools,
            maxSteps: 40,
            overrides: args.historianOverrides,
        },
        {
            id: "sidekick",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.sidekickPrompt,
            allowedTools: ["ctx_search", "aft_outline", "aft_zoom"],
            maxSteps: 40,
            overrides: args.sidekickOverrides,
        },
    ];
}

/**
 * User overrides may lower `steps` and `maxSteps` but cannot raise either above the built-in cap.
 */
export function buildHiddenAgentConfig(
    prompt: string,
    allowedTools: readonly string[],
    maxSteps: number,
    overrides?: Record<string, unknown>,
    agentLabel?: string,
    lockPermissions = false,
    description?: string,
) {
    const {
        permission: overridePermission,
        tools: overrideTools,
        // Destructuring `prompt` and `system` lets locked configs discard them and prevents `...rest` from overwriting `prompt`.
        prompt: overridePrompt,
        system: overrideSystem,
        ...rest
    } = (overrides ?? {}) as {
        permission?: Record<string, unknown>;
        tools?: Record<string, boolean>;
        prompt?: unknown;
        system?: unknown;
        [key: string]: unknown;
    };
    // When `lockPermissions` is true, excluding user `tools`, `prompt`, and `system` overrides prevents users from re-enabling denied tools or replacing configured prompts.
    // A user `tools` override could otherwise re-enable a tool denied by `basePermission`.
    const promptOverrides: Record<string, unknown> = lockPermissions
        ? {}
        : {
              ...(overridePrompt !== undefined ? { prompt: overridePrompt } : {}),
              ...(overrideSystem !== undefined ? { system: overrideSystem } : {}),
          };
    const restOverrides: Record<string, unknown> = lockPermissions
        ? { ...rest, ...promptOverrides }
        : {
              ...rest,
              ...promptOverrides,
              ...(overrideTools !== undefined ? { tools: overrideTools } : {}),
          };
    const basePermission = buildAllowOnlyPermission(allowedTools, agentLabel);
    return {
        prompt,
        // User-supplied `fallback_models` passes through `restOverrides`; no built-in fallback is added.
        ...restOverrides,
        steps: clampHiddenAgentStepLimit(restOverrides.steps, maxSteps),
        maxSteps: clampHiddenAgentStepLimit(restOverrides.maxSteps, maxSteps),
        // `permission` follows `restOverrides` so `restOverrides` cannot override the deny baseline.
        // When `lockPermissions` is true, excluding `overridePermission` preserves the denied tools in `basePermission`.
        permission: {
            ...basePermission,
            ...(lockPermissions ? {} : (overridePermission ?? {})),
        },
        mode: "primary" as const,
        hidden: true,
        ...(description !== undefined ? { description } : {}),
    };
}
