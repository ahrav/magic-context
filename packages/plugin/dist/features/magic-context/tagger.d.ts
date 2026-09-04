import type { Database } from "../../shared/sqlite";
import { type TagTokenCounts } from "./storage-tags";
import type { TagEntry } from "./types";
export declare function makeToolCompositeKey(ownerMsgId: string, callId: string): string;
/**
 * Narrowed type for non-tool tag operations. The compile-time exclusion
 * of `"tool"` here is the v3.3.1 Layer C contract: every tool path MUST
 * use `assignToolTag`/`getToolTag` so composite identity propagates.
 *
 * Any caller passing `"tool"` to `assignTag` or `getTag` triggers a TS
 * compile error at the call site. Defense-in-depth: the runtime body
 * also throws if it ever sees a "tool" type at runtime (caught by
 * `as any` casts in legacy code).
 */
type NonToolTagType = Exclude<TagEntry["type"], "tool">;
export interface ToolTagAccounting {
    byteSize: number;
    tokenCount: number | null;
    inputByteSize: number;
    inputTokenCount: number | null;
}
export interface Tagger {
    /**
     * Assign a tag for a non-tool entity (message text or file part).
     *
     * Tool tags MUST use {@link assignToolTag}; the `type` parameter
     * here is narrowed at compile time to forbid `"tool"`.
     */
    assignTag(sessionId: string, messageId: string, type: NonToolTagType, byteSize: number, db: Database, reasoningByteSize?: number, toolName?: string | null, inputByteSize?: number, 
    /**
     * Pi-only: fingerprint of the raw message this tag is created for,
     * persisted on the tag row so a later pass can adopt a fallback-id tag
     * onto the real SessionEntry id. OpenCode passes undefined → column
     * stays NULL → no behavior change.
     */
    entryFingerprint?: string | null, 
    /**
     * Lazy per-tag token computation, invoked by the tagger ONLY on the
     * fresh-insert branch (never when an existing tag is rebound). This is
     * what keeps tokenization "compute once, ever" — steady-state passes
     * pay nothing. Returns the real-tokenizer counts for this tag's content.
     */
    tokenThunk?: () => TagTokenCounts): number;
    /**
     * Look up the tag number for a non-tool entity.
     *
     * The `type` parameter is required (and narrowed to non-tool) so a
     * future tool-tag lookup can't accidentally fall through here. Use
     * {@link getToolTag} for tool lookups.
     */
    getTag(sessionId: string, messageId: string, type: NonToolTagType): number | undefined;
    /**
     * Assign a tag for a tool invocation. Composite identity
     * `(sessionId, callId, ownerMsgId)` is mandatory — pre-v3.3.1 the
     * tagger keyed tool tags by bare callId, and two assistant turns
     * reusing the same callId would silently bind to the same tag,
     * inheriting the older tag's drop status.
     *
     * `ownerMsgId` is the assistant message id that hosts the tool
     * invocation. For Pi parallel-tool-calls without `part.id`, callers
     * pass a synthetic locator equal to the contentId (owner == callId)
     * to satisfy the contract while preserving the legacy "each part
     * gets its own tag" behavior.
     */
    assignToolTag(sessionId: string, callId: string, ownerMsgId: string, byteSize: number, db: Database, reasoningByteSize?: number, toolName?: string | null, inputByteSize?: number, 
    /** Lazy token computation — invoked only on fresh insert (see assignTag). */
    tokenThunk?: () => TagTokenCounts): number;
    /**
     * Look up the tag number for a tool invocation by composite
     * identity.
     */
    getToolTag(sessionId: string, callId: string, ownerMsgId: string): number | undefined;
    /** Persisted accounting loaded in the same scan as tool-tag identities. */
    getToolTagAccounting(sessionId: string, callId: string, ownerMsgId: string): ToolTagAccounting | undefined;
    /** Keep the loaded accounting mirror synchronized with same-connection writes. */
    setToolTagAccounting(sessionId: string, tagNumber: number, accounting: ToolTagAccounting): void;
    bindTag(sessionId: string, messageId: string, tagNumber: number): void;
    /**
     * Remove a stale in-memory assignment key. Used by Pi fallback-tag
     * adoption after a tag's message_id is migrated from the pi-msg-*
     * fallback to the real id: the old fallback key must be dropped so it
     * doesn't linger as an alias to the same tag number.
     */
    unbindTag(sessionId: string, messageId: string): void;
    /**
     * Bind a tool tag by composite key. The in-memory map keys this as
     * `${ownerMsgId}\x00${callId}`.
     */
    bindToolTag(sessionId: string, callId: string, ownerMsgId: string, tagNumber: number): void;
    /**
     * Remove a stale tool composite assignment. Used by Pi fallback-owner
     * adoption when a tool tag moves from a synthetic pi-msg-* owner to the
     * real SessionEntry id (or when a duplicate real-owner row is folded away).
     */
    unbindToolTag(sessionId: string, ownerMsgId: string, callId: string): void;
    getAssignments(sessionId: string): ReadonlyMap<string, number>;
    resetCounter(sessionId: string, db: Database): void;
    getCounter(sessionId: string): number;
    initFromDb(sessionId: string, db: Database, floor?: number): void;
    cleanup(sessionId: string): void;
}
export declare function createTagger(): Tagger;
export {};
//# sourceMappingURL=tagger.d.ts.map