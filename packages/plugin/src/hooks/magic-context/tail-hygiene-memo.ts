/**
 * Shared tail-hygiene measurement primitives.
 *
 * The plugin and Pi tail-hygiene walks hash and tokenize the same content
 * shapes and compare measured prefixes with the same rules. The hash, the
 * bounded content memo, and the prefix comparison live here so the two
 * walks cannot drift apart on the values that gate defer-pass reuse.
 */

import { stableStringify } from "../../shared/stable-json";
import { estimateTokens } from "./read-session-formatting";
import type { TailHygienePartKind, TailHygienePartMeasurement } from "./tail-hygiene-walk";

export interface ContentMemoEntry {
    hash: string;
    tokens: number;
    keyBytes: number;
}

const MAX_CONTENT_MEMO_ENTRIES = 100_000;
const MAX_CONTENT_MEMO_BYTES = 64 * 1024 * 1024;
const contentMemo = new Map<string, ContentMemoEntry>();
let contentMemoBytes = 0;
const FNV1A_32_OFFSET = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;

/** Leading `§N§` transcript tag marker (capture group: the tag number). */
export const TAG_PREFIX = /^§(\d+)§\s*/;

export function fnv1a32(value: string): string {
    let hash = FNV1A_32_OFFSET;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, FNV1A_32_PRIME) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/**
 * Hash + token measurement for one part, memoized under a bounded
 * insertion-order eviction budget (entry count and approximate bytes).
 */
export function memoizedContent(kind: TailHygienePartKind, content: string): ContentMemoEntry {
    const key = `${kind}\0${content}`;
    const cached = contentMemo.get(key);
    if (cached) return cached;
    const measured = {
        hash: fnv1a32(key),
        tokens: kind === "excluded" ? 0 : estimateTokens(content),
        keyBytes: key.length * 2 + 32,
    };
    contentMemo.set(key, measured);
    contentMemoBytes += measured.keyBytes;
    while (
        contentMemo.size > MAX_CONTENT_MEMO_ENTRIES ||
        contentMemoBytes > MAX_CONTENT_MEMO_BYTES
    ) {
        const oldest = contentMemo.keys().next().value;
        if (typeof oldest !== "string") break;
        const removed = contentMemo.get(oldest);
        if (removed) contentMemoBytes -= removed.keyBytes;
        contentMemo.delete(oldest);
    }
    return measured;
}

export function memoizedTokens(kind: TailHygienePartKind, content: string): number {
    return memoizedContent(kind, content).tokens;
}

export function partHash(kind: TailHygienePartKind, content: string): string {
    return memoizedContent(kind, content).hash;
}

/**
 * A measured baseline prefix is reusable only when every baseline part is
 * unchanged in identity, content, and attribution; a part leaving
 * protection may advance the boundary by its tokens, anything else
 * invalidates the baseline.
 */
export function sameMeasuredPrefix(
    baseline: readonly TailHygienePartMeasurement[],
    current: readonly TailHygienePartMeasurement[],
): { valid: boolean; boundaryAdvanceU: number } {
    if (current.length < baseline.length) return { valid: false, boundaryAdvanceU: 0 };
    let boundaryAdvanceU = 0;
    for (let index = 0; index < baseline.length; index += 1) {
        const before = baseline[index];
        const after = current[index];
        if (
            before.key !== after.key ||
            before.contentHash !== after.contentHash ||
            before.kind !== after.kind ||
            before.tokens !== after.tokens ||
            before.tagNumber !== after.tagNumber ||
            before.tagStatus !== after.tagStatus
        ) {
            return { valid: false, boundaryAdvanceU: 0 };
        }
        if (!before.protected && after.protected) return { valid: false, boundaryAdvanceU: 0 };
        if (before.protected && !after.protected) {
            if (after.tagStatus !== "active") return { valid: false, boundaryAdvanceU: 0 };
            boundaryAdvanceU += after.tokens;
        } else if (before.uTokens !== after.uTokens) {
            return { valid: false, boundaryAdvanceU: 0 };
        }
    }
    return { valid: true, boundaryAdvanceU };
}

/**
 * Hash-facing serialization for measured content: absent values hash as
 * empty, strings hash raw, and everything else uses the shared code-point
 * stableStringify contract.
 */
export function safeStableStringify(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try {
        return stableStringify(value);
    } catch {
        return String(value);
    }
}

/** Signature over the ordered measured parts; gates defer-pass reuse. */
export function contentSignature(parts: readonly TailHygienePartMeasurement[]): string {
    return fnv1a32(parts.map((part) => `${part.key}:${part.contentHash}`).join("\0"));
}
