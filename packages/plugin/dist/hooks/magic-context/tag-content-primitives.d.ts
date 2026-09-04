import type { ThinkingLikePart } from "./tag-messages";
export declare function stripWellFormedLeadingTagPrefix(value: string): string;
export declare function stripCompleteTagPairsGlobally(value: string): string;
export declare function stripMalformedTagNotationGlobally(value: string): string;
/** Dangling `§N<closer?>` shapes anywhere (cargo-cult cleanup). */
export declare function stripDanglingTagNotationGlobally(value: string): string;
export declare function stripTagSectionCharacters(value: string): string;
/**
 * Strip MC tag notation from assistant text at the persistence boundary
 * (`experimental.text.complete`, Pi `message_end`). Removes whole `§N§` pairs
 * (never bare leading digits), then malformed hybrids and stray `§`.
 */
export declare function stripPersistedAssistantText(value: string): string;
export declare function byteSize(value: string): number;
/**
 * Strip only §-shaped MC tag notation from the start of transform-visible text.
 * Does not remove bare leading digits — those may be legitimate user content
 * (`99 files`, `2024 roadmap`, numbered lists).
 */
export declare function stripTagPrefix(value: string): string;
/**
 * Split leading MC tag notation from the body (temporal marker injection).
 * Uses the same §-only rules as {@link stripTagPrefix}.
 */
export declare function peelLeadingMcTagNotation(value: string): {
    tagPrefix: string;
    body: string;
};
export declare function prependTag(tagId: number, value: string): string;
export declare function isThinkingPart(part: unknown): part is ThinkingLikePart;
//# sourceMappingURL=tag-content-primitives.d.ts.map