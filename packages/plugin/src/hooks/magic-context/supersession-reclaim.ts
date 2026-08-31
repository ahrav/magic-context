import { CTX_REDUCE_KEEP } from "../../features/magic-context/reclaim-protection";
import { type ContextDatabase, getActiveTagsBySession } from "../../features/magic-context/storage";
import type { PendingOp } from "../../features/magic-context/types";
import { isEditTool } from "./edit-marker";
import type { TagTarget } from "./tag-messages";

//
const TODOWRITE_KEEP = 1;

const ZERO_VALUE_META_TOOLS = new Set(["bash_status", "bash_kill"]);
// ctx_note write and update actions are not drop targets.
// An unreadable `ctx_note` action is not a drop target.
const CTX_NOTE_ZERO_VALUE_ACTIONS = new Set(["read", "dismiss"]);

/**
 */
export function buildSupersessionReclaimOps(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    pendingOps?: readonly PendingOp[];
}): PendingOp[] {
    const realPendingTagIds = new Set((input.pendingOps ?? []).map((op) => op.tagId));
    const tags = getActiveTagsBySession(input.db, input.sessionId);

    // Active tool tags, newest-first, so "keep newest N" = the first N seen.
    const toolTags = tags
        .filter((tag) => tag.type === "tool" && tag.status === "active")
        .sort((left, right) => right.tagNumber - left.tagNumber);

    const dropTagIds: number[] = [];
    let todowriteSeen = 0;
    let ctxReduceSeen = 0;

    for (const tag of toolTags) {
        const name = tag.toolName;
        if (!name) continue;

        let isTarget = false;
        if (name === "todowrite") {
            todowriteSeen += 1;
            isTarget = todowriteSeen > TODOWRITE_KEEP;
        } else if (name === "ctx_reduce") {
            ctxReduceSeen += 1;
            isTarget = ctxReduceSeen > CTX_REDUCE_KEEP;
        } else if (ZERO_VALUE_META_TOOLS.has(name)) {
            isTarget = true;
        } else if (name === "ctx_note") {
            const action = input.targets.get(tag.tagNumber)?.readInput?.()?.action;
            isTarget = typeof action === "string" && CTX_NOTE_ZERO_VALUE_ACTIONS.has(action);
        }
        if (isTarget) dropTagIds.push(tag.tagNumber);
    }

    const synthetic: PendingOp[] = [];
    for (const tagId of dropTagIds) {
        if (realPendingTagIds.has(tagId)) continue;
        if (input.targets.get(tagId)?.canDrop?.() !== true) continue;
        synthetic.push({
            id: 0,
            sessionId: input.sessionId,
            tagId,
            operation: "drop",
            queuedAt: 0,
        });
    }
    return synthetic;
}

/**
 * Select superseded edit/write tool calls for COMPRESSION (not full drop).
 * The selector keeps the newest active edit/write tag for each `filePath`.
 * The selector marks older edits to the same file as `edit_marker` targets.
 *
 */
export function buildEditSupersessionReclaim(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    pendingOps?: readonly PendingOp[];
}): { ops: PendingOp[]; editMarkerTagIds: Set<number> } {
    const realPendingTagIds = new Set((input.pendingOps ?? []).map((op) => op.tagId));
    const tags = getActiveTagsBySession(input.db, input.sessionId);

    // Active edit/write tags, newest-first, so the FIRST seen per file is kept.
    const editTags = tags
        .filter((tag) => tag.type === "tool" && tag.status === "active" && isEditTool(tag.toolName))
        .sort((left, right) => right.tagNumber - left.tagNumber);

    const seenFile = new Set<string>();
    const ops: PendingOp[] = [];
    const editMarkerTagIds = new Set<number>();

    for (const tag of editTags) {
        const filePath = readFilePath(input.targets.get(tag.tagNumber));
        // The selector excludes tags without a resolvable `filePath` because file identity cannot prove supersession.
        if (!filePath) continue;
        if (!seenFile.has(filePath)) {
            seenFile.add(filePath); // newest edit to this file stays full
            continue;
        }
        if (realPendingTagIds.has(tag.tagNumber)) continue;
        if (input.targets.get(tag.tagNumber)?.canDrop?.() !== true) continue;
        editMarkerTagIds.add(tag.tagNumber);
        ops.push({
            id: 0,
            sessionId: input.sessionId,
            tagId: tag.tagNumber,
            operation: "drop",
            queuedAt: 0,
        });
    }
    return { ops, editMarkerTagIds };
}

const FILE_PATH_KEYS = ["filePath", "file_path", "path"] as const;

function readFilePath(target: TagTarget | undefined): string | null {
    const input = target?.readInput?.();
    if (!input) return null;
    for (const key of FILE_PATH_KEYS) {
        const value = input[key];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
}
