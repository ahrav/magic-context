import { createHash } from "node:crypto";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { parseRangeString } from "../../features/magic-context/range-parser";
import {
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import { getErrorMessage } from "../../shared/error-message";
import type { Database } from "../../shared/sqlite";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_REDUCE_DESCRIPTION } from "./constants";
import type { CtxReduceArgs } from "./types";

export { CTX_REDUCE_LIGHT_DESCRIPTION } from "../light-descriptions";

export interface CtxReduceToolDeps {
    db: Database;
    protectedTags: number;
    getSessionTokens?: (sessionId: string) => number;
    rustToolBackends?: RustToolBackends;
}

function formatRawDropForAck(rawDrop: string): string {
    return rawDrop
        .trim()
        .split(",")
        .map((token) => {
            const trimmed = token.trim();
            return /^\d+$/.test(trimmed) ? `§${trimmed}§` : trimmed;
        })
        .join(", ");
}

const ctxReduceArgsShape = {
    drop: tool.schema
        .string()
        .optional()
        .describe("Tag IDs to drop entirely. Ranges: '3-5', '1,2,9'"),
};
// Accepts fields outside ctxReduceArgsShape.
const ctxReduceArgsSchema = tool.schema.object(ctxReduceArgsShape).passthrough();

function createCtxReduceTool(deps: CtxReduceToolDeps): ToolDefinition {
    let fallbackCommandSequence = 0;

    const commandIdForInvocation = (sessionId: string, toolContext: unknown): string => {
        const context =
            toolContext !== null && typeof toolContext === "object"
                ? (toolContext as Record<string, unknown>)
                : {};
        const callId =
            (typeof context.callID === "string" && context.callID.trim()) ||
            (typeof context.callId === "string" && context.callId.trim());
        if (callId) {
            const stableId = `oc-${sessionId}-${callId}`;
            if (Buffer.byteLength(stableId) <= 128) return stableId;
            return `oc-${createHash("sha256").update(stableId).digest("hex")}`;
        }
        fallbackCommandSequence += 1;
        const monotonicId = `oc-${sessionId}-${fallbackCommandSequence}`;
        return Buffer.byteLength(monotonicId) <= 128
            ? monotonicId
            : `oc-${createHash("sha256").update(monotonicId).digest("hex")}`;
    };

    return tool({
        description: CTX_REDUCE_DESCRIPTION,
        args: ctxReduceArgsShape,
        async execute(rawArgs: CtxReduceArgs, toolContext) {
            const parsedArgs = ctxReduceArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxReduceArgs;
            args = unwrapImitatedReducedArgs(args, ["drop"], { drop: "string" });
            const sessionId = toolContext.sessionID;

            if (!args.drop) {
                return "Error: 'drop' must be provided.";
            }

            const rustReduce = deps.rustToolBackends?.reduce;
            if (rustReduce) {
                try {
                    const response = await rustReduce({
                        sessionId,
                        projectRoot: toolContext.directory,
                        drop: args.drop,
                        commandId: commandIdForInvocation(sessionId, toolContext),
                    });
                    const value =
                        response !== null && typeof response === "object" && "result" in response
                            ? (response as { result?: unknown }).result
                            : response;
                    const record =
                        value !== null && typeof value === "object"
                            ? (value as Record<string, unknown>)
                            : null;
                    if (record === null || record.ok !== true) {
                        const error =
                            record && "error" in record
                                ? (record as { error?: unknown }).error
                                : undefined;
                        const errorRecord =
                            error !== null && typeof error === "object"
                                ? (error as { message?: unknown })
                                : undefined;
                        const message =
                            (typeof error === "string" && error.trim() ? error : undefined) ??
                            (typeof errorRecord?.message === "string" && errorRecord.message.trim()
                                ? errorRecord.message
                                : undefined) ??
                            (typeof record?.message === "string" && record.message.trim()
                                ? record.message
                                : "module rejected agent_drops.append");
                        return `Error: Failed to queue ctx_reduce operations. ${message}`;
                    }
                    const queued = typeof record.queued === "number" ? record.queued : 0;
                    if (queued <= 0) {
                        return "All requested tags were already queued or processed. No new action is needed.";
                    }
                    return `Queued: drop ${formatRawDropForAck(args.drop)}.`;
                } catch (error) {
                    return `Error: Failed to queue ctx_reduce operations. ${getErrorMessage(error)}`;
                }
            }

            let dropIds: number[] = [];

            try {
                dropIds = parseRangeString(args.drop);
            } catch (e) {
                return `Error: Invalid range syntax. ${(e as Error).message}`;
            }

            const allIds = [...new Set(dropIds)];

            const allTags = getTagsBySession(deps.db, sessionId);
            const foundSet = new Set(allTags.map((tag) => tag.tagNumber));
            const unknownIds = allIds.filter((id) => !foundSet.has(id));
            if (unknownIds.length > 0) {
                return `Error: Unknown tag(s) ${formatIds(unknownIds)}. Check available tags in conversation.`;
            }

            const activeTags = allTags.filter((tag) => tag.status === "active");
            const protectedTagIds = activeTags
                .map((tag) => tag.tagNumber)
                .sort((left, right) => right - left)
                .slice(0, deps.protectedTags);
            const protectedSet = new Set(protectedTagIds);

            const tagStatusMap = new Map(allTags.map((tag) => [tag.tagNumber, tag.status]));

            const pendingOps = getPendingOps(deps.db, sessionId);
            const pendingMap = new Map(pendingOps.map((op) => [op.tagId, op.operation]));

            const conflicts: string[] = [];
            for (const id of dropIds) {
                if (tagStatusMap.get(id) === "compacted") {
                    conflicts.push(`§${id}§ is from before compaction`);
                }
            }
            if (conflicts.length > 0) {
                return `Error: Conflicting operations — ${conflicts.join("; ")}.`;
            }

            const preFilterDropCount = dropIds.length;
            dropIds = dropIds.filter(
                (id) => tagStatusMap.get(id) !== "dropped" && pendingMap.get(id) !== "drop",
            );
            const skippedCount = preFilterDropCount - dropIds.length;

            if (dropIds.length === 0) {
                return "All requested tags were already queued or processed. No new action is needed.";
            }

            try {
                deps.db.transaction(() => {
                    const now = Date.now();
                    for (const id of dropIds) {
                        queuePendingOp(deps.db, sessionId, id, "drop", now);
                    }
                })();
            } catch (error) {
                const errorMessage = getErrorMessage(error);
                return `Error: Failed to queue ctx_reduce operations. ${errorMessage}`;
            }

            const currentInputTokens =
                deps.getSessionTokens?.(sessionId) ??
                getOrCreateSessionMeta(deps.db, sessionId).lastInputTokens;
            updateSessionMeta(deps.db, sessionId, { lastNudgeTokens: currentInputTokens });

            const immediateDropIds = dropIds.filter((id) => !protectedSet.has(id));
            const deferredDropIds = [...new Set(dropIds.filter((id) => protectedSet.has(id)))];
            const skippedNote =
                skippedCount > 0
                    ? ` ${skippedCount} requested tag${skippedCount === 1 ? " was" : "s were"} already queued and need no action.`
                    : "";
            const parts: string[] = [];
            if (immediateDropIds.length > 0) parts.push(`drop ${formatIds(immediateDropIds)}`);
            if (deferredDropIds.length > 0)
                parts.push(`deferred drop ${formatIds(deferredDropIds)}`);
            return `Queued: ${parts.join(", ")}.${skippedNote}`;
        },
    });
}

export function formatIds(ids: number[]): string {
    return ids.map((id) => `§${id}§`).join(", ");
}

export function createCtxReduceTools(deps: CtxReduceToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_reduce: createCtxReduceTool(deps),
    };
}
