/**
 *
 *
 *
 *
 * bucketed 20/20/20/40:
 *
 *
 * Persisted state:
 *  - tags.caveman_depth records the applied depth
 * `source_contents.content` is unchanged.
 *  - message-part text holds the cavemaned result visible to the agent
 */
import type { ContextDatabase } from "../../features/magic-context/storage";
import { getSourceContents, updateCavemanDepth } from "../../features/magic-context/storage";
import type { TagEntry } from "../../features/magic-context/types";
import { sessionLog } from "../../shared";
import { type CavemanLevel, cavemanCompress } from "./caveman";
import type { TagTarget } from "./tag-messages";

const DEPTH_UNTOUCHED = 0;
const DEPTH_LITE = 1;
const DEPTH_FULL = 2;
const DEPTH_ULTRA = 3;

const DEPTH_TO_LEVEL: Record<number, CavemanLevel> = {
    [DEPTH_LITE]: "lite",
    [DEPTH_FULL]: "full",
    [DEPTH_ULTRA]: "ultra",
};

export interface CavemanCleanupConfig {
    enabled: boolean;
    minChars: number;
}

export interface CavemanCleanupResult {
    compressedToLite: number;
    compressedToFull: number;
    compressedToUltra: number;
    mutatedTextTags: number;
}

/**
 */
export function computeTargetDepth(positionIndex: number, totalEligible: number): number {
    if (totalEligible <= 0) return DEPTH_UNTOUCHED;
    const fraction = positionIndex / totalEligible;
    if (fraction < 0.2) return DEPTH_ULTRA;
    if (fraction < 0.4) return DEPTH_FULL;
    if (fraction < 0.6) return DEPTH_LITE;
    return DEPTH_UNTOUCHED;
}

/**
 *
 */
export function applyCavemanCleanup(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    tags: TagEntry[],
    config: CavemanCleanupConfig & { protectedTags: number },
): CavemanCleanupResult {
    const result: CavemanCleanupResult = {
        compressedToLite: 0,
        compressedToFull: 0,
        compressedToUltra: 0,
        mutatedTextTags: 0,
    };

    if (!config.enabled) return result;

    const maxTag = tags.reduce((max, t) => Math.max(max, t.tagNumber), 0);
    const protectedCutoff = maxTag - config.protectedTags;

    // `byteSize` approximates character count for the `minChars` threshold.
    const eligible = tags
        .filter(
            (tag) =>
                tag.type === "message" &&
                tag.status === "active" &&
                tag.tagNumber <= protectedCutoff &&
                tag.byteSize >= config.minChars,
        )
        .sort((a, b) => a.tagNumber - b.tagNumber);

    if (eligible.length === 0) return result;

    const tagsNeedingCompression = eligible.filter((tag, index) => {
        const target = targets.get(tag.tagNumber);
        if (!target?.getContent || !target.setContent) return false;
        const targetDepth = computeTargetDepth(index, eligible.length);
        return targetDepth > tag.cavemanDepth;
    });

    if (tagsNeedingCompression.length === 0) return result;

    const originalByTag = getSourceContents(
        db,
        sessionId,
        tagsNeedingCompression.map((t) => t.tagNumber),
    );

    // The map avoids O(n²) `findIndex` lookups in the loop.
    const positionByTag = new Map<number, number>();
    for (let i = 0; i < eligible.length; i += 1) {
        positionByTag.set(eligible[i].tagNumber, i);
    }

    db.transaction(() => {
        for (const tag of tagsNeedingCompression) {
            const originalText = originalByTag.get(tag.tagNumber);
            if (typeof originalText !== "string" || originalText.length === 0) continue;

            const positionIndex = positionByTag.get(tag.tagNumber) ?? 0;
            const targetDepth = computeTargetDepth(positionIndex, eligible.length);
            if (targetDepth <= tag.cavemanDepth) continue;

            const level = DEPTH_TO_LEVEL[targetDepth];
            if (!level) continue;

            // `applyCavemanCleanup` compresses each tag from `originalText`, not its current content.
            // Using `originalText` prevents repeated passes from recompressing prior output.
            const compressed = cavemanCompress(originalText, level);
            if (compressed.length === 0) continue;

            const target = targets.get(tag.tagNumber);
            if (!target) continue;

            // The function persists `cavemanDepth` even when `setContent` returns `false`.
            // Persisting `cavemanDepth` prevents later passes from retrying unchanged compression.
            const didMutate = target.setContent(compressed);
            if (didMutate) result.mutatedTextTags += 1;
            updateCavemanDepth(db, sessionId, tag.tagNumber, targetDepth);
            if (targetDepth === DEPTH_LITE) result.compressedToLite += 1;
            else if (targetDepth === DEPTH_FULL) result.compressedToFull += 1;
            else if (targetDepth === DEPTH_ULTRA) result.compressedToUltra += 1;
        }
    })();

    const total = result.compressedToLite + result.compressedToFull + result.compressedToUltra;
    if (total > 0) {
        sessionLog(
            sessionId,
            `caveman cleanup: compressed ${total} text tags (lite=${result.compressedToLite}, full=${result.compressedToFull}, ultra=${result.compressedToUltra})`,
        );
    }

    return result;
}

/**
 * The replay function restores persisted compressed content after `tagMessages` restores source content.
 *
 * `tagMessages` restores `source_contents.content` for every existing tag on each pass.
 * The replay function runs after source restoration so compressed tags do not revert.
 *
 * The replay function never increases `cavemanDepth`.
 *
 */
export function replayCavemanCompression(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    tags: TagEntry[],
): number {
    // The replay function pre-filters tags to avoid loading source content for every tag in the session.
    const compressedTags = tags.filter(
        (tag) =>
            tag.type === "message" &&
            tag.status === "active" &&
            tag.cavemanDepth > 0 &&
            targets.has(tag.tagNumber),
    );

    if (compressedTags.length === 0) return 0;

    const originalByTag = getSourceContents(
        db,
        sessionId,
        compressedTags.map((t) => t.tagNumber),
    );

    let replayed = 0;
    for (const tag of compressedTags) {
        const originalText = originalByTag.get(tag.tagNumber);
        if (typeof originalText !== "string" || originalText.length === 0) continue;

        const level = DEPTH_TO_LEVEL[tag.cavemanDepth];
        if (!level) continue;

        const compressed = cavemanCompress(originalText, level);
        if (compressed.length === 0) continue;

        const target = targets.get(tag.tagNumber);
        if (!target) continue;

        if (target.setContent(compressed)) {
            replayed += 1;
        }
    }

    return replayed;
}
