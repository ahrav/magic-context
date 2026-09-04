import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { SIDEKICK_AGENT } from "../../agents/sidekick";
import { ClaimOperationInputError } from "../../features/magic-context/memory/claim-operation-contract";
import { WRITABLE_MEMORY_CATEGORIES } from "../../features/magic-context/memory/constants";
import { getProjectEmbeddingSnapshot } from "../../features/magic-context/memory/embedding";
import { resolveProjectRootDirectory } from "../../features/magic-context/memory/project-identity";
import { toolCallIdFromContext } from "../../plugin/rust-tool-backends";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import {
    CTX_MEMORY_ANTI_MEMORY_RULE,
    CTX_MEMORY_DESCRIPTION,
    CTX_MEMORY_TOOL_NAME,
} from "./constants";
import { CTX_MEMORY_ACTOR, CTX_MEMORY_DREAMER_ACTOR, executeCtxMemory } from "./execute";
import {
    CTX_MEMORY_ACTIONS,
    CTX_MEMORY_DREAMER_ACTIONS,
    type CtxMemoryAction,
    type CtxMemoryArgs,
    type CtxMemoryToolDeps,
} from "./types";
import { assertCtxMemoryWriteShape } from "./write-shape";

export { CTX_MEMORY_LIGHT_DESCRIPTION } from "../light-descriptions";

const antiMemoryShape = {
    trigger: tool.schema.string(),
    rejectedStrategy: tool.schema.string(),
    rejectionReason: tool.schema.string(),
    saferAlternative: tool.schema.string().nullable().optional(),
    preconditions: tool.schema.string().nullable().optional(),
    attemptedApproach: tool.schema.string().nullable().optional(),
    observedFailure: tool.schema.string().nullable().optional(),
    rootCause: tool.schema.string().nullable().optional(),
    recovery: tool.schema.string().nullable().optional(),
    nonApplicableWhen: tool.schema.string().nullable().optional(),
};

const ctxMemoryArgsShape = {
    action: tool.schema
        .enum([...CTX_MEMORY_DREAMER_ACTIONS])
        .optional()
        .describe("create, get, list, revise, archive, or merge"),
    content: tool.schema.string().optional().describe("Memory content for create/revise/merge"),
    category: tool.schema
        .enum([...WRITABLE_MEMORY_CATEGORIES])
        .optional()
        .describe("Memory category for create/revise/merge or list filter"),
    antiMemory: tool.schema
        .object(antiMemoryShape)
        .optional()
        .describe(
            "Rejected-approach payload. Required with category REJECTED_APPROACH, and content must be omitted; invalid with any other category.",
        ),
    objectId: tool.schema.string().optional().describe("Object id for revise/archive"),
    objectIds: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Object ids for get, or the objects merge folds into one survivor"),
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
                    category: { type: "enum", values: WRITABLE_MEMORY_CATEGORIES },
                    antiMemory: CTX_MEMORY_ANTI_MEMORY_RULE,
                    objectId: "string",
                    objectIds: { type: "array", items: "string", maxItems: 20 },
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
                assertCtxMemoryWriteShape(args);
                const projectIdentity = deps.resolveProjectPath(toolContext.directory);
                if (!projectIdentity) {
                    return "Error: Could not resolve project identity for memory action.";
                }
                const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
                if (snapshot ? !snapshot.features.memoryEnabled : deps.memoryEnabled === false) {
                    return "Cross-session memory is disabled for this project.";
                }
                const toolCallId = toolCallIdFromContext(toolContext);
                const mutation = !["get", "list"].includes(action);
                if (!toolCallId && mutation) {
                    return "Error: ctx_memory mutation requires a stable tool-call identity.";
                }
                const client = deps.kernelClient({
                    sessionId: toolContext.sessionID,
                    projectRoot: resolveProjectRootDirectory(toolContext.directory),
                });
                return await executeCtxMemory({
                    client,
                    args,
                    action,
                    identity: {
                        sessionId: toolContext.sessionID,
                        toolCallId: toolCallId ?? "read",
                    },
                    actor:
                        toolContext.agent === DREAMER_AGENT
                            ? CTX_MEMORY_DREAMER_ACTOR
                            : CTX_MEMORY_ACTOR,
                    ...(toolContext.agent === DREAMER_AGENT
                        ? { sourceKind: "dreamer" as const }
                        : {}),
                });
            } catch (error) {
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
