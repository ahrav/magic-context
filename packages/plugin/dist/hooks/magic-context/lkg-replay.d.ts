import { type LkgEntryNote, type LkgSlot } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";
export interface LkgModelKeys {
    modelKey: string | null;
    providerKey: string | null;
}
export declare function resolveLkgModelKeys(messages: MessageLike[]): LkgModelKeys;
export interface LkgEntryProjection {
    id: string | null;
    role: string | undefined;
    synthetic: boolean;
    timeCreated: number | null;
    finish: unknown;
    hasIncompleteTool: boolean;
    /** Compute the non-enumerable digest lazily so only LKG capture or replay validation hashes message content. */
    contentDigest?: () => string | null;
}
export declare function projectLkgEntry(messages: MessageLike[]): LkgEntryProjection[];
export interface LkgCaptureInput {
    sessionId: string;
    input: LkgEntryProjection[] | MessageLike[];
    output: MessageLike[];
    modelKey: string | null;
    providerKey: string | null;
    capturedAt?: number;
}
export type LkgValidationFailure = "lkg_model_mismatch" | "lkg_invalidated_reshape" | "lkg_content_mismatch" | "lkg_unsafe_seam" | "lkg_seam_invalid" | "lkg_anthropic_reasoning_run_invalid";
export declare function findLkgAnchor(messages: LkgEntryProjection[]): number | null;
/**
 * Build the replay prefix and serialize it once. The returned `jsonPrefix` is
 * the exact artifact stored in the last-known-good replay entry; callers must
 * use it as-is rather than serialize the prefix again.
 */
export declare function buildLkgPrefix(input: LkgEntryProjection[] | MessageLike[], output: MessageLike[]): {
    anchorIndex: number;
    anchorMessageId: string;
    inputIdSeq: string[];
    inputContentDigests: string[];
    jsonPrefix: string;
} | null;
export declare function captureLkgSlot(args: LkgCaptureInput): boolean;
/**
 * The Anthropic adapter merges adjacent assistant content before sending it. A
 * completed non-provider-executed tool result materializes as user content and
 * starts a new assistant run, while OpenCode's step markers do not materialize
 * on the provider wire.
 * Each resulting assistant run may contain only one leading thinking block; a
 * later signed block would invalidate its provider signature, so recovery declines
 * the entire replay instead of attempting a rewrite.
 */
export declare function validateAnthropicReasoningRuns(messages: MessageLike[]): boolean;
export declare function validateLkgSeamBoundary(prefix: MessageLike[], tail: MessageLike[]): boolean;
export declare function validateLkgSeam(prefix: MessageLike[], tail: MessageLike[], providerKey: string | null): boolean;
export declare function replayLkg(args: {
    sessionId: string;
    messages: MessageLike[];
    modelKey: string | null;
    providerKey: string | null;
    entry?: LkgEntryNote | null;
    skipSeamValidation?: boolean;
}): {
    ok: true;
    messages: MessageLike[];
} | {
    ok: false;
    reason: LkgValidationFailure;
};
export declare function validateLkgEntry(slot: LkgSlot, entryIds: string[]): boolean;
//# sourceMappingURL=lkg-replay.d.ts.map