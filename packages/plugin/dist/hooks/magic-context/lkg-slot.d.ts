import type { MessageLike } from "./transform-operations";
export interface LkgSlot {
    jsonPrefix: string;
    inputIdSeq: string[];
    inputContentDigests: string[];
    /** Cheap content signatures aligned with `inputIdSeq`, used to reuse digests. */
    inputContentSignatures?: string[];
    lastInputMessageId: string;
    modelKey: string | null;
    providerKey: string | null;
    capturedAt: number;
    rowVersion?: number;
    captureSequence?: number;
}
export interface LkgEntryNote {
    pristineTail: MessageLike[];
    entryInputIds: string[];
    entryContentDigests: string[];
    anchorIndex: number;
}
export type LkgContentField = string | number | boolean | symbol;
export declare const LKG_SNAPSHOT_ARRAY: unique symbol;
export declare const LKG_SNAPSHOT_OBJECT: unique symbol;
export declare const LKG_SNAPSHOT_KEY: unique symbol;
export declare const LKG_SNAPSHOT_STRING: unique symbol;
export declare const LKG_SNAPSHOT_NUMBER: unique symbol;
export declare const LKG_SNAPSHOT_BOOLEAN: unique symbol;
export declare const LKG_SNAPSHOT_NULL: unique symbol;
export declare const LKG_SNAPSHOT_UNDEFINED: unique symbol;
/** Flatten a value into typed tokens while retaining strings without deep copies. */
export declare function lkgContentFields(value: unknown): LkgContentField[] | null;
export declare function lkgContentDigestFromFields(fields: readonly LkgContentField[]): string;
export interface LkgDigestEntry {
    id: string;
    signature: string;
    fields: readonly LkgContentField[];
}
export interface LkgDigestPrior {
    ids: readonly string[];
    signatures: readonly string[];
    digests: readonly string[];
}
/**
 * Reuse prior digests for the unchanged id+signature prefix and hash only from
 * the first changed entry. Digest values must match a full recompute.
 */
export declare function incrementalLkgContentDigests(entries: readonly LkgDigestEntry[], prior?: LkgDigestPrior): {
    digests: string[];
    reusedPrefix: number;
};
/** Digest the full message tree to detect input drift before an LKG replay. */
export declare function lkgContentDigest(message: MessageLike): string | null;
export declare function captureSlot(sessionId: string, slot: LkgSlot): boolean;
export declare function getSlot(sessionId: string): LkgSlot | undefined;
export declare function dropSlot(sessionId: string, _reason?: string): void;
export declare function noteEntry(sessionId: string, messages: MessageLike[]): LkgEntryNote | null;
export declare function resetLkgSlotsForTest(): void;
export declare function getLkgSlotStatsForTest(): {
    totalBytes: number;
    count: number;
};
export declare const __resetLkgSlotStoreForTest: typeof resetLkgSlotsForTest;
//# sourceMappingURL=lkg-slot.d.ts.map