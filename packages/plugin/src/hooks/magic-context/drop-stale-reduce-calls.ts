import { isRecord } from "../../shared/record-type-guard";
import { isSentinel, makeSentinel } from "./sentinel";
import type { MessageLike } from "./tag-messages";

const STALE_TOOL_NAMES = new Set(["ctx_reduce"]);

export function isReduceToolPart(part: unknown): boolean {
    if (!isRecord(part)) return false;
    if (part.type === "tool" && typeof part.tool === "string" && STALE_TOOL_NAMES.has(part.tool))
        return true;
    if (
        part.type === "tool-invocation" &&
        typeof part.toolName === "string" &&
        STALE_TOOL_NAMES.has(part.toolName)
    )
        return true;
    if (
        part.type === "tool_use" &&
        typeof part.name === "string" &&
        STALE_TOOL_NAMES.has(part.name)
    )
        return true;
    return false;
}

function hasAnyMeaningfulPart(parts: unknown[]): boolean {
    for (const part of parts) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
            return true;
        if (
            part.type === "thinking" ||
            part.type === "reasoning" ||
            part.type === "redacted_thinking"
        )
            continue;
        if (part.type === "meta" || part.type === "step-start" || part.type === "step-finish")
            continue;
        if (part.type !== "tool" || !isReduceToolPart(part)) return true;
    }
    return false;
}

function messageHasReducePart(message: MessageLike): boolean {
    for (const part of message.parts) {
        if (isSentinel(part)) continue;
        if (isReduceToolPart(part)) return true;
    }
    return false;
}

function sentinelizeReduceParts(message: MessageLike): boolean {
    let touched = false;
    for (let j = 0; j < message.parts.length; j++) {
        const part = message.parts[j];
        if (isSentinel(part)) continue;
        if (isReduceToolPart(part)) {
            message.parts[j] = makeSentinel(part);
            touched = true;
        }
    }
    if (touched && !hasAnyMeaningfulPart(message.parts)) {
        message.parts.length = 0;
        message.parts.push(makeSentinel(undefined));
    }
    return touched;
}

export interface StaleReduceStripResult {
    /** True if any ctx_reduce part was sentinelized this pass. */
    didDrop: boolean;
    /** Message ids newly detected as aged this pass (only when detect=true). */
    newlyStrippedIds: string[];
}

/**
 * Sentinel-strip aged `ctx_reduce` tool parts using a FROZEN replay watermark.
 *
 * A defer pass must replay byte-identically.
 * Defer passes must not recompute eligibility from `messages.length - protectedCount`.
 * A live `messages.length - protectedCount` boundary moves as the conversation grows.
 * Tail growth can move a live boundary into the cached prefix.
 *
 * Instead, eligibility is an id-keyed frozen set:
 * - REPLAY (every pass): strip ctx_reduce parts in any message whose `info.id`
 *   is in `frozenIds`. Growth-invariant and compaction-safe (a missing id is a
 *   no-op). This is what makes defer passes byte-identical.
 * - DETECT (cache-busting passes only, `detect=true`): additionally scan the
 *   pre-protected region for ctx_reduce calls not yet frozen, strip them, and
 *   return their ids in `newlyStrippedIds` so the caller can advance the
 *   persisted watermark. Detection happens only on passes where the wire is
 *   already allowed to change, so it never busts a defer pass.
 *
 * Messages without a stable `info.id` are never newly detected (they cannot be
 * frozen for deterministic replay), so they are left intact rather than stripped
 * inconsistently.
 */
export function dropStaleReduceCalls(
    messages: MessageLike[],
    frozenIds: Set<string>,
    options: { detect?: boolean; protectedCount?: number } = {},
): StaleReduceStripResult {
    const detect = options.detect ?? false;
    const protectedCount = options.protectedCount ?? 0;
    const protectedStart = messages.length - protectedCount;
    const newlyStrippedIds: string[] = [];
    let didDrop = false;

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const id = typeof message.info.id === "string" ? message.info.id : undefined;

        const inFrozen = id !== undefined && frozenIds.has(id);
        const isNewDetection =
            !inFrozen &&
            detect &&
            i < protectedStart &&
            id !== undefined &&
            messageHasReducePart(message);

        if (!inFrozen && !isNewDetection) continue;

        const touched = sentinelizeReduceParts(message);
        if (touched) {
            didDrop = true;
            if (isNewDetection && id !== undefined) newlyStrippedIds.push(id);
        }
    }

    return { didDrop, newlyStrippedIds };
}
