import type { TagEntry } from "../../features/magic-context/types";
import type { MessageLike } from "./tag-messages";
export interface TailHygieneDeltas {
    u: number;
    t: number;
}
export type TailHygienePartKind = "text" | "toolInput" | "toolOutput" | "file" | "excluded";
export interface TailHygienePartMeasurement {
    key: string;
    contentHash: string;
    kind: TailHygienePartKind;
    tokens: number;
    uTokens: number;
    tagNumber: number | null;
    tagStatus: TagEntry["status"] | null;
    protected: boolean;
}
export interface TailHygieneMeasurement {
    u: number;
    t: number;
    contentSignature: string;
    parts: TailHygienePartMeasurement[];
}
/**
 * Cheap served-array shape used in production to catch a write after the tail
 * walk without repeating its content hashing and token accounting.
 */
export interface TailHygieneStructuralSignature {
    messageCount: number;
    partCounts: number[];
    totalBytes: number;
}
export interface TailHygieneBaseline {
    baselineU: number;
    baselineT: number;
    turnDeltaU: number;
    turnDeltaT: number;
    baselineGeneration: number;
    computedAt: number;
    evaluable: boolean;
    generationInvalidated: boolean;
    /** Measurements from the last full walk; defer passes compare against this immutable prefix. */
    baselineParts: TailHygienePartMeasurement[];
    /** Signature of the array served by the current pass, including valid appended deltas. */
    contentSignature: string;
}
export declare function stripChannel1ReminderSpans(output: string): string;
/**
 * Capture a low-cost structural signature of the exact messages about to be
 * served. It intentionally does not hash content: production needs a cheap
 * last-writer alarm, while the full content-hash assertion remains a dev check.
 */
export declare function tailHygieneStructuralSignature(messages: readonly MessageLike[]): TailHygieneStructuralSignature;
export declare function sameTailHygieneStructuralSignature(expected: TailHygieneStructuralSignature, actual: TailHygieneStructuralSignature): boolean;
export declare function measureTailHygiene(input: {
    messages: readonly MessageLike[];
    tags: readonly TagEntry[];
    protectedTags: number;
}): TailHygieneMeasurement;
export declare function refreshTailHygieneBaseline(input: {
    messages: readonly MessageLike[];
    tags: readonly TagEntry[];
    protectedTags: number;
    cacheBusting: boolean;
    previous?: TailHygieneBaseline;
    now?: number;
}): TailHygieneBaseline;
export declare function effectiveTailHygiene(baseline: Pick<TailHygieneBaseline, "baselineU" | "baselineT" | "turnDeltaU" | "turnDeltaT">): {
    u: number;
    t: number;
};
export declare function assertTailHygieneContentUnchanged(input: {
    messages: readonly MessageLike[];
    tags: readonly TagEntry[];
    protectedTags: number;
    expectedSignature: string;
}): void;
//# sourceMappingURL=tail-hygiene-walk.d.ts.map