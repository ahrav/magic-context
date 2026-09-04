/**
 * Harness-agnostic tagging over the Transcript interface.
 *
 * This is a deliberately minimal alternative to the OpenCode-specific
 * `tag-messages.ts` that operates on `MessageLike[]`. The OpenCode flow
 * carries 380+ lines of accumulated complexity:
 *
 *   - source-content persistence (for cross-pass detag/restore behavior),
 *   - tool-call indexing across separate "tool" and "tool_result" parts,
 *   - reasoning-byte tracking for historian projection,
 *   - file-part stable IDs,
 *   - existing-tag resolver with content-id fallback.
 *
 * Most of that is OpenCode-specific (cache stability across multi-pass
 * transforms, AI SDK part-id semantics, file part shapes). Pi's
 * `pi.on("context", ...)` fires once per LLM call with a complete
 * `AgentMessage[]`, so we can use a simpler tagging contract:
 *
 *   1. Walk the transcript in order.
 *   2. For each tag-eligible part (text, tool_use, tool_result), assign
 *      a tag number via the shared `Tagger`.
 *   3. Inject `§N§ ` prefix into the visible text (unless skipped).
 *   4. Build a `TagTarget` so `applyPendingOperations` from
 *      `apply-operations.ts` can replace this part with a sentinel when
 *      a queued drop fires.
 *
 * Tool drops aggregate by call_id across both invocation and result
 * occurrences (mirrors OpenCode tag-messages.ts:196-220). When a drop
 * fires for a tool tag, BOTH the assistant `toolCall`/`tool_use` part
 * and the user `toolResult`/`tool_result` part are mutated together so
 * the LLM sees consistent dropped state. Without this aggregation:
 *
 *   - Tool tag byte_size reflects only the args (~58 bytes for a `read`)
 *     because the FIRST occurrence (invocation) is tagged first and
 *     `assignTag` short-circuits the SECOND occurrence (result, ~4KB)
 *     to the same tag without updating byte_size.
 *   - Drops touch only the second occurrence (last write wins on
 *     `targets.set`), leaving the first in original form.
 *
 * Reuses unchanged from the OpenCode path:
 *
 *   - `Tagger` (DB-backed counter + assignment store).
 *   - `applyPendingOperations` (operates on `Map<number, TagTarget>`).
 *   - `applyFlushedStatuses` (same).
 *   - Tag prefix primitives (`prependTag`, `stripTagPrefix`, `byteSize`).
 */
import type { ContextDatabase } from "../features/magic-context/storage";
import { type Tagger } from "../features/magic-context/tagger";
import type { TagTarget } from "../hooks/magic-context/tag-messages";
import type { Transcript } from "./transcript";
export declare const TEXT_TAG_IDENTITY_MARKER = ":mc-text-v1:";
export interface TagTranscriptOptions {
    /**
     * When true, skip injecting `§N§` prefix into visible text. Tags
     * still get assigned in the DB so historian/drops can reference
     * them; the agent just doesn't see the markers. Used when the session's
     * tool surface has no `ctx_reduce` tool to act on the markers. Cache-safe
     * because the availability verdict is frozen per session.
     */
    skipPrefixInjection?: boolean;
    /**
     * Pi-only: map of messageId → raw-message fingerprint. When a NEW message
     * text tag is created, its fingerprint is persisted on the tag row so a
     * later pass can adopt the fallback-id tag onto the real SessionEntry id
     * (keeping tag_number/§N§ stable). OpenCode omits this → tags store NULL
     * → adoption never fires. Keyed by the bare messageId (not the `:pN`
     * contentId) since all parts of a message share one fingerprint.
     */
    entryFingerprintByMessageId?: ReadonlyMap<string, string>;
    /**
     * Stable Pi message ids observed on a prior pass. Their immutable parts may
     * reuse tag assignments while this pass still reapplies visible prefixes and
     * rebuilds the complete set of messages affected by each tag.
     */
    reuseMessageIds?: ReadonlySet<string>;
    /**
     * Pi message ids whose persisted text-part vector no longer matches the
     * current vector. Their parts use content-derived identities instead of
     * positional `:pN` keys, so sibling insertion/deletion cannot rebind an
     * older durable tag to different text.
     */
    textIdentityDriftMessageIds?: ReadonlySet<string>;
    /** Source-content cache shared with Pi's batched identity preflight. */
    textIdentitySourceCache?: Map<number, string>;
    /** Exact text/count pairs retained by Pi for safe lazy-token backfill reuse. */
    textTokenCache?: Map<string, {
        text: string;
        tokenCount: number;
    }>;
    /** Exact tool-result text/count pairs retained under composite tag identity. */
    toolTokenCache?: Map<string, {
        text: string;
        tokenCount: number;
    }>;
    /** Optional process-local benchmark callback; production callers omit it. */
    onTiming?: (phase: "identity" | "prefix" | "targets" | "tokenCounting", elapsedMs: number) => void;
}
export interface TagTranscriptResult {
    targets: Map<number, TagTarget>;
}
export declare function tagTranscript(sessionId: string, transcript: Transcript, tagger: Tagger, db: ContextDatabase, options?: TagTranscriptOptions): TagTranscriptResult;
//# sourceMappingURL=tag-transcript.d.ts.map