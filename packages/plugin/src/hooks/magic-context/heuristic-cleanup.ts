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
         * Tiered target-headroom emergency drop. Provided only on the the derived force band
         * force-materialize (cache-busting) pass; undefined on routine execute
         * passes (Phase 2 removed routine age-based tool drops entirely). When
         * present, the emergency drop runs before dedup/injection-strip.
         */
        emergency?: {
            currentTotalInputTokens: number;
            ceilingTokens: number;
        };
        /**
         * Age-tier caveman text compression settings. Caller is responsible
         * for forwarding this only for primary sessions where caveman is enabled.
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
    // All work in this function short-circuits on `tag.status !== "active"`,
    // so callers can pass active-only tags without behavior change. When no
    // preload is provided we now load active-only directly (the partial
    // index makes this O(active rows) instead of O(all rows)).
    const tags = preloadedTags ?? getActiveTagsBySession(db, sessionId);
    // `maxTag` must reflect the true session max (including dropped/compacted
    // rows) so the protected-cutoff window stays anchored to the most recent
    // tag regardless of status. Previous code computed this from `tags`,
    // which was correct only when `tags` was the full set; we now look up
    // the authoritative max via an O(log N) backward index seek so the
    // contract holds whether `tags` is full or active-only.
    const maxTag = getMaxTagNumberBySession(db, sessionId);
    const protectedCutoff = maxTag - config.protectedTags;

    let droppedTools = 0;
    let emergencyDroppedTools = 0;
    let emergencyReclaimedTokens = 0;
    let deduplicatedTools = 0;
    let droppedInjections = 0;

    // ── Tiered target-headroom emergency drop (Phase 2) ──
    // Replaces the old need-blind routine age-drop + `dropAllTools` nuke. Runs
    // only when the caller supplies `emergency` (i.e. the derived force band force-materialize
    // cache-busting pass). Selection is pure (`planEmergencyDrop`); we apply the
    // returned plan and advance the persisted watermark so each tag drops once.
    if (config.emergency) {
        const emergency = config.emergency;
        const priorInputSample = getEmergencyInputSample(db, sessionId);
        // Plan ONLY over tags that are in the live window AND would ACTUALLY
        // reclaim bytes (canDrop excludes absent/incomplete entries that drop()
        // would no-op on). This keeps the floor math equal to the on-wire tail
        // and guarantees every selected tag reclaims — no phantom tag counted as
        // reclaimed (which makes the plan stop early and under-evict).
        const droppableTags = tags.filter(
            (t) =>
                t.status === "active" && t.type === "tool" && targets.get(t.tagNumber)?.canDrop?.(),
        );
        // Floor accounting needs the FULL active live-window set (all types) —
        // narrowing it to the droppable subset folds real conversation/
        // reasoning tail into the "irreducible prefix" and under-evicts.
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
        // Record every acting emergency sample, including a pass where the selector
        // found no eligible target. This prevents repeated cache busts on stale input.
        setEmergencyDropSample(db, sessionId, emergency.currentTotalInputTokens);
    }

    db.transaction(() => {
        // Strip or drop system injections (task-list continuation, skill reminders, etc.)
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

    // Deduplication: auto-drop older identical tool calls (same tool + same params)
    //
    // v3.3.1 Layer C — plan §5 + Finding 1:
    //   - Both the tag-side index AND the fingerprint-side map key on
    //     composite key `<ownerMsgId>\x00<callId>` so cross-owner pairs
    //     don't collapse into one bucket on lookup.
    //   - The fingerprint VALUE includes ownerMsgId too. Without it, two
    //     assistant turns with same `(toolName, args)` from different
    //     owners would share a fingerprint bucket and be merged. With
    //     it, cross-owner pairs are correctly NOT merged (semantically
    //     distinct invocations). Within-same-owner duplicates still
    //     dedup as expected.
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

        // Group tags by fingerprint
        const fingerprintGroups = new Map<string, TagEntry[]>();
        for (const [compositeKey, fingerprint] of toolFingerprints) {
            const tag = tagsByCompositeKey.get(compositeKey);
            if (!tag || tag.tagNumber > protectedCutoff) continue;
            const group = fingerprintGroups.get(fingerprint) ?? [];
            group.push(tag);
            fingerprintGroups.set(fingerprint, group);
        }

        // For each group with duplicates, drop all but the newest
        db.transaction(() => {
            for (const [, group] of fingerprintGroups) {
                if (group.length <= 1) continue;
                group.sort((a, b) => a.tagNumber - b.tagNumber);
                // Keep the newest (last), drop the rest
                for (let i = 0; i < group.length - 1; i++) {
                    const tag = group[i];
                    const target = targets.get(tag.tagNumber);
                    // Deduplication remains a full drop; only the emergency newest-window
                    // arm preserves skeleton bytes.
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

    // Age-tier caveman text compression. Runs LAST so tool drops and
    // injection stripping above can shrink the message set before we pick
    // text tags to compress. Caller guarantees config.caveman is provided
    // only for primary sessions where caveman is enabled; we still defensively
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
    // OpenCode format: { type: "tool", tool: "name", callID: "...", state: { input: {...}, output: "..." } }
    if (part.type === "tool" && typeof part.tool === "string" && DEDUP_SAFE_TOOLS.has(part.tool)) {
        const state =
            typeof part.state === "object" && part.state !== null
                ? (part.state as Record<string, unknown>)
                : {};
        return { toolName: part.tool, args: state.input ?? {} };
    }
    // Tool-invocation format: { type: "tool-invocation", toolName: "name", args: {...} }
    if (
        part.type === "tool-invocation" &&
        typeof part.toolName === "string" &&
        DEDUP_SAFE_TOOLS.has(part.toolName)
    ) {
        return { toolName: part.toolName, args: part.args ?? {} };
    }
    // Tool-use format: { type: "tool_use", name: "name", input: {...} }
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
 * v3.3.1 Layer C — plan §5: build a per-(owner, callId) fingerprint
 * map. Both key (composite `<ownerMsgId>\x00<callId>`) and value
 * (`<ownerMsgId>:<toolName>:<args>`) include the owner so cross-owner
 * pairs with same `(toolName, args)` produce DISTINCT fingerprints
 * and are NOT merged by the dedup pass. Within-same-owner duplicates
 * still group correctly because their owner is identical and the
 * callId differs (Pi parallel-tool-calls).
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
                // Owner in BOTH key AND value (Finding 1 in plan v3.3.1).
                const fingerprint = `${ownerMsgId}:${info.toolName}:${JSON.stringify(info.args)}`;
                const compositeKey = `${ownerMsgId}\x00${callId}`;
                fingerprints.set(compositeKey, fingerprint);
            } catch {
                // Skip if args can't be stringified
            }
        }
    }
    return fingerprints;
}

function extractCallId(part: Record<string, unknown>): string | null {
    // OpenCode format: { type: "tool", callID: "call_xxx" }
    if (part.type === "tool" && typeof part.callID === "string") return part.callID;
    // tool-invocation format: { type: "tool-invocation", callID: "call_xxx" }
    if (part.type === "tool-invocation" && typeof part.callID === "string") return part.callID;
    // tool_use format: { type: "tool_use", id: "call_xxx" }
    if (part.type === "tool_use" && typeof part.id === "string") return part.id;
    return null;
}
