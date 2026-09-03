import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { SIDEKICK_AGENT } from "../../agents/sidekick";
import {
    type AntiMemoryPayload,
    parseAntiMemoryContent,
    renderAntiMemoryContent,
} from "../../features/magic-context/memory/anti-memory-content";
import { ClaimOperationInputError } from "../../features/magic-context/memory/claim-operation-contract";
import {
    ANTI_MEMORY_CATEGORY,
    WRITABLE_MEMORY_CATEGORIES,
} from "../../features/magic-context/memory/constants";
import { getProjectEmbeddingSnapshot } from "../../features/magic-context/memory/embedding";
import { resolveProjectRootDirectory } from "../../features/magic-context/memory/project-identity";
import { toolCallIdFromContext } from "../../plugin/rust-tool-backends";
import {
    type CommitResult,
    type DecisionSpecInput,
    isAvailable,
    type KernelClient,
    type MemoryState,
    type MutationArgs,
    type ReadRow,
    renderToolStateText,
    sha256Hex,
} from "../../shared/kernel-client";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import {
    CTX_MEMORY_ANTI_MEMORY_RULE,
    CTX_MEMORY_DESCRIPTION,
    CTX_MEMORY_TOOL_NAME,
    DEFAULT_SEARCH_LIMIT,
    GET_MAX_CLAIMS,
} from "./constants";
import {
    CTX_MEMORY_ACTIONS,
    CTX_MEMORY_DREAMER_ACTIONS,
    type CtxMemoryAction,
    type CtxMemoryArgs,
    type CtxMemoryToolDeps,
} from "./types";
import { assertCtxMemoryWriteShape } from "./write-shape";

export { CTX_MEMORY_LIGHT_DESCRIPTION } from "../light-descriptions";

/** Every memory the tool writes lives in this kernel domain. */
export const CTX_MEMORY_DOMAIN_ID = "memory";
/** The lineage every tool-written decision names; revisions advance `source_revision`. */
export const CTX_MEMORY_SOURCE_ID = "ctx_memory";
export const CTX_MEMORY_ACTOR = "agent:opencode";
export const CTX_MEMORY_DREAMER_ACTOR = "agent:opencode:dreamer";

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
    objectId: tool.schema.string().optional().describe("Object id for revise/archive/restore"),
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

function normalizeLimit(limit: number | undefined): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
    return Math.max(1, Math.min(100, Math.floor(limit)));
}

function uniqueIds(ids: readonly string[] | undefined): string[] {
    return [...new Set((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0))];
}

function isMemoryRow(row: ReadRow): boolean {
    return (
        row.decision !== undefined &&
        (WRITABLE_MEMORY_CATEGORIES as readonly string[]).includes(row.decision.decision_kind)
    );
}

function memoryView(row: ReadRow): Record<string, unknown> {
    const decision = row.decision;
    const category = decision?.decision_kind ?? row.object.object_kind;
    const content = decision?.payload.summary ?? "";
    let antiMemory: AntiMemoryPayload | undefined;
    if (category === ANTI_MEMORY_CATEGORY) {
        try {
            antiMemory = parseAntiMemoryContent(content);
        } catch {
            antiMemory = undefined;
        }
    }
    return {
        objectId: row.object.object_id,
        category,
        content,
        ...(antiMemory ? { antiMemory } : {}),
        ...(decision?.payload.rationale ? { rationale: decision.payload.rationale } : {}),
        labeled: row.labeled,
        sensitivity: row.object.sensitivity,
        knownAsOf: row.token.known_as_of,
    };
}

/** Tool text for a state other than `available`; a conflict names the object to re-read. */
export function renderCtxMemoryStateText(state: MemoryState, objectIds: readonly string[]): string {
    const text = renderToolStateText(state);
    if (state.kind === "conflict" && objectIds.length > 0) {
        return `Error: ${text} Re-read ${objectIds.join(", ")} with ctx_memory get, then retry.`;
    }
    return `Error: ${text}`;
}

interface WriteIdentity {
    sessionId: string;
    toolCallId: string;
}

/**
 * Object and decision ids derive from the tool call so a replayed call
 * produces byte-identical operations and the daemon reports `replayed`
 * instead of minting a second object.
 */
function derivedId(prefix: string, identity: WriteIdentity, index: number): string {
    return `${prefix}_${sha256Hex(`${identity.sessionId}\u001f${identity.toolCallId}\u001f${prefix}\u001f${index}`).slice(0, 32)}`;
}

function contentOf(args: CtxMemoryArgs): string {
    if (args.antiMemory) return renderAntiMemoryContent(args.antiMemory);
    const content = args.content?.trim() ?? "";
    if (!content) throw new ClaimOperationInputError("content is required");
    return content;
}

function decisionSpec(
    args: CtxMemoryArgs,
    category: string,
    identity: WriteIdentity,
    sourceRevision: number,
): DecisionSpecInput {
    return {
        decision_id: derivedId("dec", identity, 0),
        object_id: derivedId("mem", identity, 0),
        domain_id: CTX_MEMORY_DOMAIN_ID,
        decision_kind: category,
        payload: { summary: contentOf(args), rationale: args.reason?.trim() ?? "" },
        source_id: CTX_MEMORY_SOURCE_ID,
        source_revision: sourceRevision,
    };
}

function requireTarget(args: CtxMemoryArgs): string {
    const objectId = args.objectId?.trim();
    if (!objectId) {
        throw new ClaimOperationInputError(
            `'objectId' is required when action is '${String(args.action)}'`,
        );
    }
    return objectId;
}

function renderCommit(action: CtxMemoryAction, result: CommitResult, targets: string[]): string {
    if (!isAvailable(result)) return renderCtxMemoryStateText(result.state, targets);
    return JSON.stringify({
        action,
        outcome: result.receipt.replayed ? "already applied" : "applied",
        commitSeq: result.receipt.commit_seq,
        knownAsOf: result.known_as_of,
        objects: result.tokens.map((token) => token.object_id),
    });
}

interface ExecuteArgs {
    client: KernelClient;
    args: CtxMemoryArgs;
    action: CtxMemoryAction;
    identity: WriteIdentity;
    actor: string;
}

async function readMemoryRows(
    client: KernelClient,
): Promise<{ ok: true; rows: ReadRow[]; knownAsOf: number } | { ok: false; state: MemoryState }> {
    const read = await client.read({ surface: "explicit_search", gated: false });
    if (!isAvailable(read)) return { ok: false, state: read.state };
    return { ok: true, rows: read.rows.filter(isMemoryRow), knownAsOf: read.known_as_of };
}

/** The category a revision keeps unless the call names another; `rationale` follows the same rule. */
function revisionArgs(args: CtxMemoryArgs, predecessors: readonly ReadRow[]): CtxMemoryArgs {
    const first = predecessors[0];
    const inherited = {
        ...(args.category === undefined && first?.decision
            ? { category: first.decision.decision_kind }
            : {}),
        ...(args.content === undefined && args.antiMemory === undefined && first?.decision
            ? { content: first.decision.payload.summary }
            : {}),
        ...(args.reason === undefined && first?.decision?.payload.rationale
            ? { reason: first.decision.payload.rationale }
            : {}),
    };
    return { ...args, ...inherited };
}

function nextSourceRevision(predecessors: readonly ReadRow[]): number {
    return predecessors.reduce((max, row) => Math.max(max, row.object.source_revision), 0) + 1;
}

async function executeCtxMemory(input: ExecuteArgs): Promise<string> {
    const { client, args, action, identity, actor } = input;
    const mutation: MutationArgs = { actor, cause: identity.toolCallId };

    if (action === "get" || action === "list") {
        const read = await readMemoryRows(client);
        if (!read.ok) return renderCtxMemoryStateText(read.state, []);
        if (action === "get") {
            const wanted = uniqueIds(args.objectIds).slice(0, GET_MAX_CLAIMS);
            if (wanted.length === 0) {
                return "Error: 'objectIds' is required when action is 'get'.";
            }
            const found = read.rows.filter((row) => wanted.includes(row.object.object_id));
            const foundIds = new Set(found.map((row) => row.object.object_id));
            return JSON.stringify({
                action,
                knownAsOf: read.knownAsOf,
                memories: found.map(memoryView),
                missingObjectIds: wanted.filter((id) => !foundIds.has(id)),
            });
        }
        const category = args.category?.trim();
        const listed = read.rows
            .filter((row) => !category || row.decision?.decision_kind === category)
            .sort((left, right) => (left.object.object_id < right.object.object_id ? -1 : 1))
            .slice(0, normalizeLimit(args.limit));
        return JSON.stringify({
            action,
            knownAsOf: read.knownAsOf,
            memories: listed.map(memoryView),
        });
    }

    if (action === "create") {
        const category = args.category?.trim() ?? "";
        const spec = decisionSpec(args, category, identity, 1);
        return renderCommit(action, await client.create(spec, mutation), []);
    }

    if (action === "archive") {
        const target = requireTarget(args);
        return renderCommit(action, await client.archive(target, mutation), [target]);
    }

    if (action === "revise" || action === "restore") {
        const target = requireTarget(args);
        const read = await readMemoryRows(client);
        if (!read.ok) return renderCtxMemoryStateText(read.state, [target]);
        const predecessors = read.rows.filter((row) => row.object.object_id === target);
        const merged = revisionArgs(args, predecessors);
        assertCtxMemoryWriteShape({ ...merged, action: "revise" });
        const category = merged.category?.trim();
        if (!category) {
            throw new ClaimOperationInputError(`${action} requires a category for ${target}`);
        }
        const spec = decisionSpec(merged, category, identity, nextSourceRevision(predecessors));
        const result =
            action === "revise"
                ? await client.revise(target, spec, mutation)
                : await client.restore(target, spec, mutation);
        return renderCommit(action, result, [target]);
    }

    const targets = uniqueIds(args.objectIds);
    if (targets.length < 2) {
        throw new ClaimOperationInputError("merge requires at least two objectIds");
    }
    const read = await readMemoryRows(client);
    if (!read.ok) return renderCtxMemoryStateText(read.state, targets);
    const predecessors = read.rows.filter((row) => targets.includes(row.object.object_id));
    const merged = revisionArgs(args, predecessors);
    assertCtxMemoryWriteShape({ ...merged, action: "revise" });
    const category = merged.category?.trim();
    if (!category) throw new ClaimOperationInputError("merge requires a category");
    const spec = decisionSpec(merged, category, identity, nextSourceRevision(predecessors));
    return renderCommit(action, await client.merge(targets, spec, mutation), targets);
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
