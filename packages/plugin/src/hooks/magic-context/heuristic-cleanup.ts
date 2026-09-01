import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getActiveTagsBySession,
    getMaxTagNumberBySession,
    replaceSourceContent,
    updateTagDropMode,
    updateTagStatus,
} from "../../features/magic-context/storage";
import {
    getEmergencyInputSample,
    setEmergencyDropSample,
} from "../../features/magic-context/storage-meta-persisted";
import type { TagEntry } from "../../features/magic-context/types";
import { sessionLog } from "../../shared";
import { applyCavemanCleanup, type CavemanCleanupConfig } from "./caveman-cleanup";
import {
    type EmergencyDropTag,
    estimateEmergencyDropReclaimTokens,
    planEmergencyDrop,
} from "./emergency-drop";
import { stripSystemInjection } from "./system-injection-stripper";
import type { MessageLike, TagTarget } from "./tag-messages";
import { stripTagPrefix } from "./tag-part-guards";

const DEDUP_SAFE_TOOLS = new Set([
    "mcp_grep",
    "mcp_read",
    "mcp_glob",
    "mcp_ast_grep_search",
    "mcp_lsp_diagnostics",
    "mcp_lsp_symbols",
    "mcp_lsp_find_references",
    "mcp_lsp_goto_definition",
    "mcp_lsp_prepare_rename",
]);

export function applyHeuristicCleanup(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    messageTagNumbers: Map<MessageLike, number>,
    config: {
        protectedTags: number;
        /**
         * Routine execute passes do not drop tools by age.
         */
        emergency?: {
            currentTotalInputTokens: number;
            ceilingTokens: number;
        };
        /**
         * `caveman` configures age-tier Caveman text compression.
         */
        caveman?: CavemanCleanupConfig;
    },
    preloadedTags?: TagEntry[],
): {
    droppedTools: number;
    deduplicatedTools: number;
    droppedInjections: number;
    emergencyDroppedTools: number;
    emergencyReclaimedTokens: number;
    compressedTextTags: number;
    mutatedTextTags: number;
} {
    const tags = preloadedTags ?? getActiveTagsBySession(db, sessionId);
    // `maxTag` must include dropped and compacted rows so the protected cutoff anchors to the newest tag.
    // `tags` can omit dropped or compacted rows.
    // `getMaxTagNumberBySession` preserves the protected-cutoff invariant when `tags` is full or active-only.
    const maxTag = getMaxTagNumberBySession(db, sessionId);
    const protectedCutoff = maxTag - config.protectedTags;

    let droppedTools = 0;
    let emergencyDroppedTools = 0;
    let emergencyReclaimedTokens = 0;
    let deduplicatedTools = 0;
    let droppedInjections = 0;

    // The persisted watermark prevents an emergency pass from dropping the same tag twice.
    if (config.emergency) {
        const emergency = config.emergency;
        const priorInputSample = getEmergencyInputSample(db, sessionId);
        // `planEmergencyDrop` considers only tool tags whose `canDrop()` can reclaim bytes.
        // `floorTags` includes every active tag so floor accounting includes conversation and reasoning tail.
        // `planEmergencyDrop` counts only tags that can reclaim bytes, so every selected tag reclaims bytes.
        // Counting a non-reclaiming tag as reclaimed makes `planEmergencyDrop` stop early and under-evict.
        const droppableTags = tags.filter(
            (t) =>
                t.status === "active" && t.type === "tool" && targets.get(t.tagNumber)?.canDrop?.(),
        );
        const activeTags = tags.filter((t) => t.status === "active");
        const plan = planEmergencyDrop({
            tags: droppableTags as readonly EmergencyDropTag[],
            floorTags: activeTags as readonly EmergencyDropTag[],
            maxTag,
            protectedTags: config.protectedTags,
            currentTotalInputTokens: emergency.currentTotalInputTokens,
            ceilingTokens: emergency.ceilingTokens,
            priorInputSample,
            hasPriorDrop: priorInputSample > 0,
        });
        if (plan.shouldDrop) {
            const toDrop = new Set(plan.tagNumbers);
            const newestEmergencyTags = new Set(
                droppableTags
                    .slice()
                    .sort((left, right) => right.tagNumber - left.tagNumber)
                    .slice(0, 20)
                    .map((tag) => tag.tagNumber),
            );
            db.transaction(() => {
                for (const tag of tags) {
                    if (!toDrop.has(tag.tagNumber)) continue;
                    if (tag.status !== "active" || tag.type !== "tool") continue;
                    const target = targets.get(tag.tagNumber);
                    const recent = newestEmergencyTags.has(tag.tagNumber);
                    const result = recent
                        ? (target?.truncate?.() ?? target?.drop?.() ?? "absent")
                        : (target?.drop?.() ?? "absent");
                    if (result === "removed" || result === "truncated") {
                        updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
                        updateTagDropMode(
                            db,
                            sessionId,
                            tag.tagNumber,
                            recent ? "truncated" : "full",
                        );
                        droppedTools++;
                        emergencyDroppedTools++;
                        emergencyReclaimedTokens += estimateEmergencyDropReclaimTokens(tag);
                    }
                }
            })();
            sessionLog(sessionId, `emergency tiered drop: ${plan.reason}`);
        } else {
            sessionLog(sessionId, `emergency tiered drop skipped: ${plan.reason}`);
        }
        // The emergency path records every input sample, even without eligible targets, to prevent repeated cache busts on stale input.
        setEmergencyDropSample(db, sessionId, emergency.currentTotalInputTokens);
    }

    db.transaction(() => {
        for (const tag of tags) {
            if (tag.status !== "active") continue;
            if (tag.tagNumber > protectedCutoff) continue;
            if (tag.type !== "message") continue;

            const target = targets.get(tag.tagNumber);
            if (!target) continue;

            const content = target.getContent?.();
            if (!content) continue;

            const stripped = stripSystemInjection(content);
            if (stripped === null) continue;
            const strippedSource = stripTagPrefix(stripped);

            if (strippedSource.trim().length === 0) {
                const dropResult = target.drop?.() ?? "absent";
                const didReplace =
                    dropResult === "absent"
                        ? target.setContent(`[dropped §${tag.tagNumber}§]`)
                        : false;
                if (dropResult === "removed" || dropResult === "absent") {
                    replaceSourceContent(db, sessionId, tag.tagNumber, "");
                    updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
                    if (dropResult === "removed" || didReplace) {
                        droppedInjections++;
                    }
                }
            } else {
                const didSet = target.setContent(stripped);
                if (didSet) {
                    replaceSourceContent(db, sessionId, tag.tagNumber, strippedSource);
                    droppedInjections++;
                }
            }
        }
    })();

    // Deduplication drops older tool calls with the same tool and params.
    //
    // Both indexes use `<ownerMsgId>\x00<callId>` to prevent cross-owner lookup collisions.
    // Fingerprints include `ownerMsgId` so identical calls from different owners remain distinct.
    const allMessages = Array.from(messageTagNumbers.keys());
    const toolFingerprints = buildToolFingerprints(allMessages);
    if (toolFingerprints.size > 0) {
        const tagsByCompositeKey = new Map<string, TagEntry>();
        for (const tag of tags) {
            if (tag.type === "tool" && tag.status === "active" && tag.messageId) {
                const key = tag.toolOwnerMessageId
                    ? `${tag.toolOwnerMessageId}\x00${tag.messageId}`
                    : tag.messageId; // legacy fallback for unbackfilled NULL-owner rows
                tagsByCompositeKey.set(key, tag);
            }
        }

        const fingerprintGroups = new Map<string, TagEntry[]>();
        for (const [compositeKey, fingerprint] of toolFingerprints) {
            const tag = tagsByCompositeKey.get(compositeKey);
            if (!tag || tag.tagNumber > protectedCutoff) continue;
            const group = fingerprintGroups.get(fingerprint) ?? [];
            group.push(tag);
            fingerprintGroups.set(fingerprint, group);
        }

        db.transaction(() => {
            for (const [, group] of fingerprintGroups) {
                if (group.length <= 1) continue;
                group.sort((a, b) => a.tagNumber - b.tagNumber);
                for (let i = 0; i < group.length - 1; i++) {
                    const tag = group[i];
                    const target = targets.get(tag.tagNumber);
                    // Deduplication always fully drops tags; only the emergency newest-window path preserves skeleton bytes.
                    const result = target?.drop?.() ?? "absent";
                    if (result === "incomplete") continue;
                    updateTagDropMode(db, sessionId, tag.tagNumber, "full");
                    updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
                    if (result === "removed" || result === "truncated") {
                        deduplicatedTools++;
                    }
                }
            }
        })();
    }

    if (droppedTools > 0 || deduplicatedTools > 0 || droppedInjections > 0) {
        sessionLog(
            sessionId,
            `heuristic cleanup: dropped ${droppedTools} tool tags, deduplicated ${deduplicatedTools} tool calls, dropped ${droppedInjections} system injections`,
        );
    }

    // Caveman compression runs after tool dropping and injection stripping so those steps reduce its candidates.
    // check enabled.
    let compressedTextTags = 0;
    let mutatedTextTags = 0;
    if (config.caveman?.enabled) {
        const cavemanResult = applyCavemanCleanup(sessionId, db, targets, tags, {
            enabled: true,
            minChars: config.caveman.minChars,
            protectedTags: config.protectedTags,
        });
        compressedTextTags =
            cavemanResult.compressedToLite +
            cavemanResult.compressedToFull +
            cavemanResult.compressedToUltra;
        mutatedTextTags = cavemanResult.mutatedTextTags;
    }

    return {
        droppedTools,
        deduplicatedTools,
        droppedInjections,
        emergencyDroppedTools,
        emergencyReclaimedTokens,
        compressedTextTags,
        mutatedTextTags,
    };
}

function extractToolInfo(
    part: Record<string, unknown>,
): { toolName: string; args: unknown } | null {
    if (part.type === "tool" && typeof part.tool === "string" && DEDUP_SAFE_TOOLS.has(part.tool)) {
        const state =
            typeof part.state === "object" && part.state !== null
                ? (part.state as Record<string, unknown>)
                : {};
        return { toolName: part.tool, args: state.input ?? {} };
    }
    if (
        part.type === "tool-invocation" &&
        typeof part.toolName === "string" &&
        DEDUP_SAFE_TOOLS.has(part.toolName)
    ) {
        return { toolName: part.toolName, args: part.args ?? {} };
    }
    if (
        part.type === "tool_use" &&
        typeof part.name === "string" &&
        DEDUP_SAFE_TOOLS.has(part.name)
    ) {
        return { toolName: part.name, args: part.input ?? {} };
    }
    return null;
}

/**
 */
function buildToolFingerprints(messages: MessageLike[]): Map<string, string> {
    const fingerprints = new Map<string, string>();
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const ownerMsgId = typeof message.info.id === "string" ? message.info.id : null;
        if (!ownerMsgId) continue;
        for (const part of message.parts) {
            const record = part as Record<string, unknown>;
            const info = extractToolInfo(record);
            if (!info) continue;
            const callId = extractCallId(record);
            if (!callId) continue;
            try {
                const fingerprint = `${ownerMsgId}:${info.toolName}:${JSON.stringify(info.args)}`;
                const compositeKey = `${ownerMsgId}\x00${callId}`;
                fingerprints.set(compositeKey, fingerprint);
            } catch {}
        }
    }
    return fingerprints;
}

function extractCallId(part: Record<string, unknown>): string | null {
    if (part.type === "tool" && typeof part.callID === "string") return part.callID;
    if (part.type === "tool-invocation" && typeof part.callID === "string") return part.callID;
    if (part.type === "tool_use" && typeof part.id === "string") return part.id;
    return null;
}
