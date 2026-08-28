import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { SIDEKICK_AGENT } from "../../agents/sidekick";
import { WRITABLE_MEMORY_CATEGORIES } from "../../features/magic-context/memory";
import { getProjectEmbeddingSnapshot } from "../../features/magic-context/memory/embedding";
import {
    ClaimOperationInputError,
    ClaimOperationKeyReuseError,
} from "../../features/magic-context/memory/storage-claim-operations";
import {
    isRustAuthorityDrainingError,
    toolCallIdFromContext,
} from "../../plugin/rust-tool-backends";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import {
    assertCtxMemoryWriteShape,
    createCtxMemoryProducerIdentity,
    executeCtxMemoryClaimAction,
    executeCtxMemoryClaimActionWithCommit,
} from "./claim-actions";
import {
    CTX_MEMORY_ANTI_MEMORY_RULE,
    CTX_MEMORY_DESCRIPTION,
    CTX_MEMORY_MUTATION_TOKEN_RULE,
    CTX_MEMORY_TOOL_NAME,
} from "./constants";
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
        .describe("create, get, list, revise, archive, restore, or merge"),
    content: tool.schema.string().optional().describe("Claim content for create/revise/merge"),
    category: tool.schema
        .enum([...WRITABLE_MEMORY_CATEGORIES])
        .optional()
        .describe("Claim category for create/revise or list filter"),
    antiMemory: tool.schema
        .object(antiMemoryShape)
        .optional()
        .describe(
            "Rejected-approach payload. Required with category REJECTED_APPROACH, and content must be omitted; invalid with any other category.",
        ),
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
                    category: { type: "enum", values: WRITABLE_MEMORY_CATEGORIES },
                    antiMemory: CTX_MEMORY_ANTI_MEMORY_RULE,
                    publicClaimId: "string",
                    publicClaimIds: { type: "array", items: "string", maxItems: 20 },
                    mutationToken: CTX_MEMORY_MUTATION_TOKEN_RULE,
                    mutationTokens: {
                        type: "array",
                        items: CTX_MEMORY_MUTATION_TOKEN_RULE,
                        maxItems: 20,
                    },
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
                await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
                const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
                if (snapshot ? !snapshot.features.memoryEnabled : deps.memoryEnabled === false) {
                    return "Cross-session memory is disabled for this project.";
                }
                const toolCallId = toolCallIdFromContext(toolContext);
                const mutation = !["get", "list"].includes(args.action);
                if (!toolCallId && mutation) {
                    return "Error: ctx_memory mutation requires a stable tool-call identity.";
                }
                const actor =
                    toolContext.agent === DREAMER_AGENT
                        ? "agent:opencode:dreamer"
                        : "agent:opencode";
                const identity = {
                    harness: "opencode" as const,
                    sessionId: toolContext.sessionID,
                    toolCallId: toolCallId ?? "read",
                    projectIdentity,
                };
                const executeArgs = {
                    db: deps.db,
                    args,
                    projectIdentity,
                    identity,
                    actor,
                };
                if (mutation && deps.rustToolBackends?.memory) {
                    const authority = await deps.rustToolBackends.authorityState?.({
                        projectPath: projectIdentity,
                        projectRoot: toolContext.directory,
                        domain: "memories",
                    });
                    if (authority === "PREPARING" || authority === "DRAINING") {
                        return "Error: memory authority is transitioning; retry this tool call.";
                    }
                    if (authority === "MODULE") {
                        const producer = createCtxMemoryProducerIdentity(identity);
                        const intentRequest = {
                            action,
                            actor,
                            projectIdentity,
                            ...(args.content !== undefined ? { content: args.content } : {}),
                            ...(args.category !== undefined ? { category: args.category } : {}),
                            ...(args.antiMemory !== undefined
                                ? { antiMemory: args.antiMemory }
                                : {}),
                            ...(args.publicClaimId !== undefined
                                ? { publicClaimId: args.publicClaimId }
                                : {}),
                            ...(args.publicClaimIds !== undefined
                                ? { publicClaimIds: args.publicClaimIds }
                                : {}),
                            ...(args.mutationToken !== undefined
                                ? { mutationToken: args.mutationToken }
                                : {}),
                            ...(args.mutationTokens !== undefined
                                ? { mutationTokens: args.mutationTokens }
                                : {}),
                            ...(args.reason !== undefined ? { reason: args.reason } : {}),
                        };
                        return await deps.rustToolBackends.memory({
                            commandId: toolCallId as string,
                            sessionId: toolContext.sessionID,
                            projectRoot: toolContext.directory,
                            projectPath: projectIdentity,
                            producer: producer.producer,
                            operationKey: producer.operationKey,
                            intentRequest,
                            commitContext: () => executeCtxMemoryClaimActionWithCommit(executeArgs),
                        });
                    }
                }
                return executeCtxMemoryClaimAction(executeArgs);
            } catch (error) {
                if (error instanceof ClaimOperationKeyReuseError) {
                    return "Error: this tool call id was already committed with different arguments. Retry as a new call.";
                }
                if (error instanceof ClaimOperationInputError) {
                    return `Error: ${error.message}`;
                }
                if (isRustAuthorityDrainingError(error)) {
                    return "Error: memory authority is transitioning; retry this tool call.";
                }
                throw error;
            }
        },
    });
}

export function createCtxMemoryTools(deps: CtxMemoryToolDeps): Record<string, ToolDefinition> {
    return { [CTX_MEMORY_TOOL_NAME]: createCtxMemoryTool(deps) };
}
