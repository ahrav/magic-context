import { isRecord } from "../../shared/record-type-guard";
import { isSentinel, makeSentinel } from "./sentinel";
import type { MessageLike } from "./tag-messages";

const STRUCTURAL_PART_TYPES = new Set(["meta", "step-start", "step-finish", "reasoning"]);

function isStructuralNoisePart(part: unknown): boolean {
    if (!isRecord(part) || typeof part.type !== "string") {
        return false;
    }

    if (!STRUCTURAL_PART_TYPES.has(part.type)) {
        return false;
    }

    if (part.type === "reasoning" && typeof part.text === "string" && part.text !== "[cleared]") {
        return false;
    }

    return true;
}

/**
 * `message.parts.length` remains unchanged between passes.
 * the wire.
 *
 *
 * Subsequent passes recognize sentinels and skip them without incrementing `strippedParts`.
 */
export function stripStructuralNoise(messages: MessageLike[]): number {
    let strippedParts = 0;

    for (const message of messages) {
        if (!Array.isArray(message.parts)) {
            continue;
        }

        for (let i = 0; i < message.parts.length; i++) {
            const part = message.parts[i];
            if (isSentinel(part)) continue;
            if (!isStructuralNoisePart(part)) continue;
            message.parts[i] = makeSentinel(part);
            strippedParts++;
        }
    }

    return strippedParts;
}
