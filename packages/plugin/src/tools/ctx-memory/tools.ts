import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { SIDEKICK_AGENT } from "../../agents/sidekick";
import { V2_MEMORY_CATEGORIES } from "../../features/magic-context/memory";
import { getProjectEmbeddingSnapshot } from "../../features/magic-context/memory/embedding";
import {
    ClaimOperationInputError,
    ClaimOperationKeyReuseError,
} from "../../features/magic-context/memory/storage-claim-operations";
import { toolCallIdFromContext } from "../../plugin/rust-tool-backends";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { executeCtxMemoryClaimAction } from "./claim-actions";
import { CTX_MEMORY_DESCRIPTION, CTX_MEMORY_TOOL_NAME } from "./constants";
import {
    CTX_MEMORY_ACTIONS,
    CTX_MEMORY_DREAMER_ACTIONS,
    type CtxMemoryAction,
    type CtxMemoryArgs,
    type CtxMemoryToolDeps,
} from "./types";

export { CTX_MEMORY_LIGHT_DESCRIPTION } from "../light-descriptions";

const mutationTokenShape = {
    tokenVersion: tool.schema.number(),
    publicClaimId: tool.schema.string(),
    revision: tool.schema.number(),
    contentDigest: tool.schema.string(),
    lifecycleSeq: tool.schema.number(),
    applicabilityHeadsDigest: tool.schema.string(),
    policyHeadsDigest: tool.schema.string(),
};

const ctxMemoryArgsShape = {
    action: tool.schema
        .enum([...CTX_MEMORY_DREAMER_ACTIONS])
        .optional()
        .describe("create, get, list, revise, archive, restore, or merge"),
    content: tool.schema.string().optional().describe("Claim content for create/revise/merge"),
    category: tool.schema
        .enum([...V2_MEMORY_CATEGORIES])
        .optional()
        .describe("Claim category for create/revise or list filter"),
    publicClaimId: tool.schema
        .string()
        .optional()
        .describe("Public claim ID for revise/archive/restore"),
    publicClaimIds: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Public claim IDs for get"),
    mutationToken: tool.schema
        .object(mutationTokenShape)
        .optional()
        .describe("Exact token returned by create/get/list"),
    mutationTokens: tool.schema
        .array(tool.schema.object(mutationTokenShape))
        .optional()
        .describe("Merge tokens ordered [target, ...sources]"),
    limit: tool.schema.number().optional().describe("Maximum list results"),
    reason: tool.schema.string().optional().describe("Lifecycle-change reason"),
};

const ctxMemoryArgsSchema = tool.schema.object(ctxMemoryArgsShape).passthrough();

function allowedActions(deps: CtxMemoryToolDeps): [CtxMemoryAction, ...CtxMemoryAction[]] {
    const allowed = deps.allowedActions?.length ? deps.allowedActions : CTX_MEMORY_ACTIONS;
    return [...allowed] as [CtxMemoryAction, ...CtxMemoryAction[]];
}

function createCtxMemoryTool(deps: CtxMemoryToolDeps): ToolDefinition {
    const primaryActions = allowedActions(deps);
    return tool({
        description: CTX_MEMORY_DESCRIPTION,
        args: ctxMemoryArgsShape,
        async execute(rawArgs: CtxMemoryArgs, toolContext) {
            try {
                const parsed = ctxMemoryArgsSchema.safeParse(rawArgs);
                let args = (parsed.success ? parsed.data : rawArgs) as CtxMemoryArgs;
                args = unwrapImitatedReducedArgs(args, ["action"], {
                    action: { type: "enum", values: CTX_MEMORY_DREAMER_ACTIONS },
                    content: "string",
                    category: { type: "enum", values: V2_MEMORY_CATEGORIES },
                    publicClaimId: "string",
                    publicClaimIds: { type: "array", items: "string", maxItems: 20 },
                    limit: "number",
                    reason: "string",
                });
                const rawAction = (args as { action?: unknown }).action;
                if (rawAction === "approve" || rawAction === "enforce") {
                    return "Error: approve and enforce are human-host-owned commands, not agent actions.";
                }
                if (toolContext.agent === SIDEKICK_AGENT) {
                    return "Error: ctx_memory is not available to the sidekick agent.";
                }
                if (
                    typeof rawAction !== "string" ||
                    !CTX_MEMORY_DREAMER_ACTIONS.includes(rawAction as CtxMemoryAction) ||
                    (toolContext.agent !== DREAMER_AGENT &&
                        !primaryActions.includes(rawAction as CtxMemoryAction))
                ) {
                    return `Error: Action '${String(rawAction)}' is not allowed in this context.`;
                }
                const action = rawAction as CtxMemoryAction;
                args.action = action;
                const projectIdentity = deps.resolveProjectPath(toolContext.directory);
                if (!projectIdentity) {
                    return "Error: Could not resolve project identity for memory action.";
                }
                await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
                const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
                if (snapshot ? !snapshot.features.memoryEnabled : deps.memoryEnabled === false) {
                    return "Cross-session memory is disabled for this project.";
                }
                const toolCallId = toolCallIdFromContext(toolContext);
                if (!toolCallId && !["get", "list"].includes(args.action)) {
                    return "Error: ctx_memory mutation requires a stable tool-call identity.";
                }
                return executeCtxMemoryClaimAction({
                    db: deps.db,
                    args,
                    projectIdentity,
                    identity: {
                        harness: "opencode",
                        sessionId: toolContext.sessionID,
                        toolCallId: toolCallId ?? "read",
                        projectIdentity,
                    },
                    actor:
                        toolContext.agent === DREAMER_AGENT
                            ? "agent:opencode:dreamer"
                            : "agent:opencode",
                });
            } catch (error) {
                if (error instanceof ClaimOperationKeyReuseError) {
                    return "Error: this tool call id was already committed with different arguments. Retry as a new call.";
                }
                if (error instanceof ClaimOperationInputError) {
                    return `Error: ${error.message}`;
                }
                throw error;
            }
        },
    });
}

export function createCtxMemoryTools(deps: CtxMemoryToolDeps): Record<string, ToolDefinition> {
    return { [CTX_MEMORY_TOOL_NAME]: createCtxMemoryTool(deps) };
}
