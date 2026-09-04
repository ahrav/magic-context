import type { Database } from "../../shared/sqlite";
import type { TagEntry } from "./types";
/**
 * Bump a tag's byte_size when a later occurrence of the same call_id
 * carries a larger payload. Used by `tagTranscript` to record the
 * tool-result payload size after the tool-use invocation already
 * reserved the tag with the args size.
 *
 * No-op if newByteSize is not strictly larger than the stored value
 * (caller should compare in memory and only call when necessary).
 */
export declare function updateTagByteSize(db: Database, sessionId: string, tagNumber: number, newByteSize: number): void;
/**
 * Per-owning-message token totals for the ACTIVE tags of a session, keyed by
 * the real message id (not the synthetic content id). Both the sidebar
 * breakdown and the protected-tail true-raw measurement index into this by the
 * message ids they already hold (their window / eligible slice), so the result
 * is window-scoped by construction — it never overcounts a still-active tag
 * that has been trimmed out of the live window.
 *
 * Owner derivation:
 *   - tool tags: `tool_owner_message_id` (the assistant message that invoked).
 *   - message/file tags: `message_id` is the content id `${msgId}:pN` /
 *     `${msgId}:fileN`; the real message id is the prefix before the last
 *     `:p`/`:file` segment.
 *
 * Each entry carries the conversation/toolCall split (reasoning always folds
 * into conversation, mirroring the live per-part walk) plus `hasNull`: true
 * when any contributing tag still has a NULL token_count (legacy row written
 * before the column existed), signalling the caller to tokenize+backfill that
 * message this pass instead of trusting the stored sum.
 */
export interface MessageTokenTotal {
    conversation: number;
    toolCall: number;
    /**
     * Tool OUTPUT tokens only (the ctx_reduce-droppable payload), excluding tool
     * input args — this is the "reclaimable" figure the nudge channels gate on,
     * matching the legacy `computeTailToolTokens` semantics (which summed
     * `state.output`). `toolCall` = this + input args, for the sidebar bucket.
     */
    toolOutput: number;
    hasNull: boolean;
}
/**
 * Session-level aggregate of ACTIVE tag token counts — the real live-tail
 * weight EXCLUDING injected m[0]/m[1] blocks (which are never tagged). This is
 * the single source for the nudge channels:
 *   - liveTail   = conversation + toolCall  (real user/assistant + tool I/O)
 *   - reclaimable = toolOutput              (non-dropped, ctx_reduce-droppable)
 *   - usable      = executeThresholdTokens − inputTokens + liveTail
 * `nullCount` > 0 means some active tags are legacy/un-backfilled this pass; the
 * caller may fall back to the byte-approx path until they converge.
 */
export interface ActiveTagTokenAggregate {
    conversation: number;
    toolCall: number;
    toolOutput: number;
    nullCount: number;
}
/**
 * @param protectedTags When > 0, the `toolOutput` (reclaimable) total EXCLUDES
 * the top-N active tag numbers — the exact set `ctx_reduce` refuses to drop (it
 * defers the N highest active tag numbers; see ctx-reduce/tools.ts). The nudge's
 * "reclaimable" figure must match what the agent can actually drop, or it nags
 * about protected tail output the agent cannot act on (re-firing forever).
 * `conversation`/`toolCall` are NOT narrowed — they feed `usable`, the full
 * working range, where protected content still counts. Default 0 = no exclusion.
 */
export declare function getActiveTagTokenAggregate(db: Database, sessionId: string, protectedTags?: number): ActiveTagTokenAggregate;
export interface ToolReclaimHintTag {
    tagNumber: number;
    toolName: string | null;
}
export interface AgeReclaimToolTag extends ToolReclaimHintTag {
    /** Cached output + input tokens; null means the legacy row has no size estimate. */
    reclaimableTokens: number | null;
}
/**
 * A reclaim hint should point at MEANINGFULLY reclaimable output, not a
 * 30-token status line or a tiny control-plane call (ctx_reduce, bash_status,
 * check_comments…). Tags whose cached token total is known AND below this are
 * skipped. A tag with NO cached token count is NOT excluded by the floor (we
 * cannot size it, so we never hide a potentially-large output).
 */
export declare const AGE_RECLAIM_MIN_TOKENS = 250;
export declare function getOldestActiveUnprotectedToolTags(db: Database, sessionId: string, protectedTags?: number, limit?: number): ToolReclaimHintTag[];
/**
 * Return age-reclaim candidates with the same persisted token estimate used by reclaim hints.
 * The newest ctx_reduce exemplars are omitted before the watermark/value checks in the caller.
 * Legacy rows with neither token column populated remain eligible for fail-safe reclaim.
 */
export declare function getActiveToolTagsForAgeReclaim(db: Database, sessionId: string): AgeReclaimToolTag[];
/**
 * Upper bound on the historian's true-raw ELIGIBLE tokens for the cheap
 * trigger pre-gate. Sums `active` AND `dropped` tags: a ctx_reduce/emergency
 * drop removes a tool output from the wire (and the active set) but its raw
 * content stays in OpenCode's DB and still counts toward the historian's
 * chunk size — an active-only bound undercounts after drops and wrongly
 * suppresses real tail-size triggers. `compacted` tags are excluded: they sit
 * before the last compartment boundary by construction, so they can't be in
 * the eligible window (including them would only make the gate uselessly
 * conservative). nullCount spans the same active+dropped set — the bound is
 * only trustworthy when every contributing row has a cached token count.
 */
export declare function getTriggerTagTokenUpperBound(db: Database, sessionId: string, floor?: number): {
    bound: number;
    nullCount: number;
};
export declare function getActiveTagTokenTotalsByMessage(db: Database, sessionId: string): Map<string, MessageTokenTotal>;
/**
 * Bump a tag's input_byte_size when a tool_use occurrence is seen
 * after the result occurrence (rare in practice; supports both
 * orderings).
 */
export declare function updateTagInputByteSize(db: Database, sessionId: string, tagNumber: number, newInputByteSize: number): void;
/**
 * Bump a tag's token_count when a later occurrence of the same call_id carries a
 * larger output payload — the token mirror of `updateTagByteSize`, called from
 * the same site so the cached token count tracks the grown tool result.
 */
export declare function updateTagTokenCount(db: Database, sessionId: string, tagNumber: number, newTokenCount: number): void;
export interface PersistedToolTagAccounting {
    byteSize: number;
    tokenCount: number | null;
    inputByteSize: number;
    inputTokenCount: number | null;
}
/** Read the authoritative accounting after an exceptional same-pass owner adoption. */
export declare function getPersistedToolTagAccounting(db: Database, sessionId: string, tagNumber: number): PersistedToolTagAccounting | null;
/**
 * Flat per-message ORIGINAL token map for the protected-tail boundary, keyed by
 * real message id. Sums every tag's stored token weight (output + input +
 * reasoning) for a message REGARDLESS of drop status, because the boundary
 * measures true-raw tokens — the original content the historian re-reads to
 * compact, which lives in opencode.db even when the wire shows a `[dropped]`
 * sentinel. (An active-only sum would undercount the eligible range whenever a
 * tool output had been ctx_reduce-dropped in the live tail.)
 *
 * A message with ANY tag still carrying a NULL token_count (legacy, not yet
 * backfilled) is reported in `nullMessageIds` and omitted from `totals`, so the
 * boundary live-tokenizes it this pass and converges to the stored path after
 * the tagger backfills. Pre-boundary (`compacted`) messages cancel out of the
 * boundary's prefix-difference math, so including them here is harmless.
 */
export declare function getAllStatusTagTokenTotalsFlat(db: Database, sessionId: string, floor?: number): {
    totals: Map<string, number>;
    nullMessageIds: Set<string>;
};
/** Bump a tag's input_token_count — the token mirror of `updateTagInputByteSize`. */
export declare function updateTagInputTokenCount(db: Database, sessionId: string, tagNumber: number, newInputTokenCount: number): void;
/**
 * True when a tag row still has a NULL token_count — i.e. it was written before
 * the token columns existed (legacy) and needs a one-time backfill. Used by the
 * tagger's DB-existing (post-restart cold) path to decide whether to invoke the
 * tokenizer thunk; populated rows skip it so a restart never re-tokenizes.
 */
export declare function tagTokenCountIsNull(db: Database, sessionId: string, tagNumber: number): boolean;
/**
 * One-time backfill of a legacy tag's token columns. Guarded by
 * `token_count IS NULL` so it is idempotent and a no-op once populated (a later
 * pass / restart cannot clobber a real count). Mirrors the byte columns set at
 * insert time.
 */
export declare function backfillTagTokenCounts(db: Database, sessionId: string, tagNumber: number, counts: TagTokenCounts): void;
/**
 * Per-tag token counts (real Claude tokenizer), computed once at insert time.
 * `null` fields mean "not measured" (legacy callers / rows predating the
 * columns); readers treat NULL as a fall-back-per-call signal.
 */
export interface TagTokenCounts {
    tokenCount: number | null;
    inputTokenCount: number | null;
    reasoningTokenCount: number | null;
}
export declare function insertTag(db: Database, sessionId: string, messageId: string, type: TagEntry["type"], byteSize: number, tagNumber: number, reasoningByteSize?: number, toolName?: string | null, inputByteSize?: number, toolOwnerMessageId?: string | null, entryFingerprint?: string | null, tokenCounts?: TagTokenCounts | null): number;
export declare function updateTagStatus(db: Database, sessionId: string, tagId: number, status: TagEntry["status"]): void;
export declare function updateTagDropMode(db: Database, sessionId: string, tagNumber: number, dropMode: TagEntry["dropMode"]): void;
/**
 * Set the caveman compression depth for a tag.
 *
 * Only message tags are expected to receive non-zero depth; callers enforce
 * that. Persisted so later transform passes and restarts can resume without
 * re-compressing text that already matches its target age-tier depth.
 */
export declare function updateCavemanDepth(db: Database, sessionId: string, tagNumber: number, depth: number): void;
export declare function updateTagMessageId(db: Database, sessionId: string, tagId: number, messageId: string): void;
/** Return whether this session has any message tag bound to a fallback Pi id. */
export declare function hasPiFallbackMessageTags(db: Database, sessionId: string): boolean;
/**
 * Pi fallback-tag adoption lookup. Find the message-text tag(s) created under a
 * `pi-msg-*` fallback id for a given (session, entry_fingerprint), so the next
 * pass can migrate them onto the message's real SessionEntry id. Returns the
 * candidate rows (tag_number + current message_id) for the caller to apply the
 * per-part uniqueness guard and race-safe migrate. Scoped to `type='message'`
 * and the fallback-id shape so a real-id row is never re-adopted.
 */
export declare function findAdoptableFallbackTags(db: Database, sessionId: string, entryFingerprint: string): Array<{
    tagNumber: number;
    messageId: string;
}>;
/**
 * Race-safe migrate of a tag's `message_id` from a known old (fallback) value to
 * a new (real) value. The old value in the WHERE clause is the concurrency fence
 * (mirrors `adoptNullOwnerToolTag`'s NULL guard): if a sibling process already
 * migrated or re-keyed the row, `changes === 0` and the caller skips. Returns
 * true iff exactly this migration applied.
 */
export declare function adoptFallbackTagMessageId(db: Database, sessionId: string, tagNumber: number, oldFallbackMessageId: string, newRealMessageId: string): boolean;
export interface PiFallbackToolOwnerTag {
    tagNumber: number;
    callId: string;
    toolOwnerMessageId: string;
    status: string;
}
export type PiFallbackTagAdoptionResult = {
    action: "skipped";
} | {
    action: "rekeyed";
    tagNumber: number;
} | {
    action: "folded";
    tagNumber: number;
    deletedTagNumbers: number[];
};
export declare function hasPiFallbackToolOwnerTags(db: Database, sessionId: string): boolean;
export declare function findPiFallbackToolOwnerTags(db: Database, sessionId: string): PiFallbackToolOwnerTag[];
export declare function adoptPiFallbackToolOwnerTag(db: Database, sessionId: string, tagNumber: number, callId: string, oldOwnerMessageId: string, newOwnerMessageId: string): PiFallbackTagAdoptionResult;
export declare function adoptPiFallbackMessageTag(db: Database, sessionId: string, tagNumber: number, oldFallbackMessageId: string, newRealMessageId: string): PiFallbackTagAdoptionResult;
/**
 * Delete every tag whose source content lives on `messageId`. This is
 * the `message.removed` event handler's primary cleanup path.
 *
 * What gets deleted:
 *   - Message tags: `messageId == <removed-msg-id>` (text parts).
 *   - File tags: `messageId LIKE <removed-msg-id>:p%` /
 *     `<removed-msg-id>:file%`.
 *   - Tool tags owned by the removed message:
 *     `tool_owner_message_id == <removed-msg-id>` (v3.3.1 Layer C).
 *
 * Pre-v10 semantics: tool tags used `messageId = callId`, so a removed
 * assistant message would not match any tool tag's `messageId` field
 * (the message id was never written there for tool tags). The fix:
 * include tool tags by composite-owner identity so an assistant
 * message removal correctly cascades to the tool tags it hosted.
 *
 * Returns the tag numbers that were deleted (used by the event handler
 * to re-anchor reasoning watermarks and audit logs).
 */
export declare function deleteTagsByMessageId(db: Database, sessionId: string, messageId: string): number[];
export declare function getMaxTagNumberBySession(db: Database, sessionId: string): number;
/**
 * Look up the tag_number assigned to a specific (session_id, message_id).
 *
 * Used by the tagger's recovery path to bind an existing DB-assigned tag back
 * into the in-memory assignment map without bumping the counter past the DB's
 * actual max. Returns null when no tag exists for that message yet.
 */
export declare function getTagNumberByMessageId(db: Database, sessionId: string, messageId: string): number | null;
/**
 * Lowest `tag_number` among the message/file content-ids of a single raw
 * message id, used to derive the tagger load-scoping floor from the first
 * message(s) in the live wire.
 *
 * message/file tags key on the synthetic content-id `${rawId}:p${n}` /
 * `${rawId}:file${n}`. The half-open range `[rawId+':', rawId+';')` captures
 * exactly one rawId's content-ids: ':' (0x3A) is the field separator and ';'
 * (0x3B) is its immediate successor, so a different rawId (even a prefix like
 * `msg_abc` vs `msg_abcd`) diverges before the ':' and sorts outside the
 * range. This is a sargable index range scan on idx_tags_session_message_id
 * (no LIKE, no wildcard escaping). Tool tags are NOT matched (their message_id
 * is the callId, not `${rawId}:…`) — intentional: the floor bounds message/file
 * tags; tool straddle is handled separately.
 *
 * Returns null when the rawId has no message/file tag yet (untagged synthetic
 * leader) or, defensively, when the rawId itself contains ':' (which would
 * break the delimiter proof — never true for OpenCode `msg_*` ids).
 */
export declare function getMinMessageTagNumberForRawId(db: Database, sessionId: string, rawId: string): number | null;
export declare const TAGGER_FLOOR_SCAN_MESSAGES = 8;
export declare const TAGGER_FLOOR_MAX_PROBES = 64;
export declare const TAGGER_FLOOR_SAFETY_MARGIN = 256;
export declare const TAGGER_FLOOR_PER_SKIP_MARGIN = 64;
/**
 * Derive the tagger/scan load-scoping floor from the leading wire message ids:
 * roughly the minimum message/file tag number across the leading messages,
 * minus a safety margin (clamped to 0). Shared by the tagger's `initFromDb` and
 * the compartment trigger's tag scans so both scope to the same live-wire range.
 * Returns 0 when nothing resolves → callers fall back to the full-session scan.
 *
 * `getMinMessageTagNumberForRawId` matches ONLY a message's `:p`/`:file` tags,
 * never its tool tags (those key on the callId). So the wire head — which after
 * a compaction marker is frequently a run of tool-only assistant turns and/or
 * tagless ghost/synthetic leaders — returns all-NULL. The old code capped at the
 * first 8 ID-BEARING probes and took their MIN, so such a head exhausted the
 * budget on NULLs → Infinity → floor 0 → the full ~100k-tag scan we are trying
 * to avoid (the live ~66ms compartmentTrigger oscillation).
 *
 * Fix: keep probing PAST NULL leaders until SCAN_HITS messages resolve (bounded
 * by MAX_PROBES). A skipped tool-only leader's tool tags sit just BELOW the
 * first `:p` tag we land on, so we widen the margin by PER_SKIP_MARGIN for every
 * leader skipped before the first hit — the floor still only ever errs LOWER
 * (loads a few extra tags), never higher (never drops a live-wire tag).
 */
export declare function deriveTagLoadFloor(db: Database, sessionId: string, rawIds: Iterable<string | null | undefined>): number;
export declare function getTagsBySession(db: Database, sessionId: string): TagEntry[];
/**
 * Return only the tags whose status is 'active' for this session.
 *
 * Backed by the partial index `idx_tags_active_session_tag_number` so the
 * scan touches only active rows instead of every tag in the session.
 *
 * Use this in: heuristic cleanup, nudger, caveman replay scope, anywhere
 * that filters `tags.filter(t => t.status === "active")` on the result of
 * `getTagsBySession`.
 *
 * The returned shape matches `TagEntry` exactly so callers can swap with
 * no behavior change beyond seeing fewer (active-only) rows.
 */
export declare function getActiveTagsBySession(db: Database, sessionId: string): TagEntry[];
/**
 * Attribution rows for final rendered-tail accounting. Active, non-protected
 * rows identify reclaimable token mass (U). Legacy tool rows with no owner are
 * included regardless of status so duplicate call IDs remain visible and the
 * orphan resolver can reject ambiguous matches.
 */
export declare function getTailHygieneTags(db: Database, sessionId: string): TagEntry[];
/**
 * Return only dropped tags for a session. The partial dropped-tag index avoids
 * loading active and compacted history when a force seed only needs drop state.
 */
export declare function getDroppedTagsBySession(db: Database, sessionId: string): TagEntry[];
/**
 * Return the tags whose tag_number is in `tagNumbers` for this session.
 *
 * Used by `applyFlushedStatuses` (and similar replay loops) to fetch the
 * subset of tags that match the current pass's visible target set rather
 * than scanning every tag in the session.
 *
 * The IN-list is built dynamically because SQLite caches prepared
 * statements per query string, but we still get prepared-statement reuse
 * for any given list size that happens twice in a row (which is the
 * common case during long sessions).
 *
 * Returns an empty array when `tagNumbers` is empty (avoids generating
 * `IN ()` which is an SQL syntax error).
 */
export declare function getTagsForPendingOperations(db: Database, sessionId: string, pendingTagNumbers: readonly number[], protectedTags: number, recentToolWindow: number): TagEntry[];
export declare function getTagsByNumbers(db: Database, sessionId: string, tagNumbers: readonly number[]): TagEntry[];
/** Return only dropped tags whose numbers are visible replay targets. */
export declare function getDroppedTagsByNumbers(db: Database, sessionId: string, tagNumbers: readonly number[]): TagEntry[];
/**
 * Return the maximum tag_number among tags whose status is 'dropped' for
 * this session, or 0 if no dropped tags exist.
 *
 * Replaces the full-array iteration `for (tag of tags) if (dropped &&
 * tag_number > max) max = tag_number` with a single SQL aggregate.
 * Backed by the partial index `idx_tags_dropped_session_tag_number` so
 * SQLite resolves the MAX with a backward index seek (O(log N)).
 */
export declare function getMaxDroppedTagNumber(db: Database, sessionId: string): number;
export declare function getTagById(db: Database, sessionId: string, tagId: number): TagEntry | null;
export declare function getTopNBySize(db: Database, sessionId: string, n: number): TagEntry[];
/**
 * Look up the tag_number for a specific composite tool identity.
 *
 * Returns null when no tag exists for `(sessionId, callId, ownerMsgId)`.
 * This is the fast path for the runtime tagger after a tagger restart
 * or cache eviction.
 */
export declare function getToolTagNumberByOwner(db: Database, sessionId: string, callId: string, ownerMsgId: string): number | null;
/**
 * Find a NULL-owner tool tag row for `(sessionId, callId)`.
 *
 * Used by the lazy-adoption fast path: when the runtime tagger sees a
 * tool with composite key `(ownerMsgId, callId)` that has no
 * corresponding row in `assignments`, but the underlying callId already
 * exists in DB with NULL owner (legacy pre-v10 row), we want to adopt
 * the orphan rather than allocate a fresh tag. This preserves
 * cache-stable tag numbers across the v9 → v10 upgrade.
 *
 * Returns the lowest-numbered NULL-owner row deterministically. The
 * caller is expected to follow up with `adoptNullOwnerToolTag` to
 * atomically claim ownership; if that returns false, another writer
 * adopted first and the caller must re-check the composite-key fast
 * path or allocate a fresh tag.
 */
export declare function getNullOwnerToolTag(db: Database, sessionId: string, callId: string): {
    id: number;
    tagNumber: number;
} | null;
/**
 * Atomically adopt a NULL-owner tool tag row by setting
 * `tool_owner_message_id = ownerMsgId`. Returns true if exactly one
 * row was updated (we won the race), false if zero (someone else
 * adopted between our SELECT and UPDATE).
 *
 * The NULL guard makes this concurrent-safe with both the backfill
 * pass and concurrent runtime adoptions in other plugin processes.
 */
export declare function adoptNullOwnerToolTag(db: Database, rowId: number, ownerMsgId: string): boolean;
/**
 * Returns the candidate tool-tag owner ids for `(sessionId, callId)` —
 * every tag with a non-NULL owner. Used by the result-only-window
 * fallback in `tag-messages.ts`: the caller resolves wall-clock times
 * for every candidate against the OpenCode DB (via
 * `getMessageTimesFromOpenCodeDb`) and picks the most recent one whose
 * `time_created` precedes the current result message.
 *
 * The picking logic lives in the caller because resolving message times
 * requires the OpenCode read-only DB handle, which lives in the hooks
 * tree. Keeping that import one-way (hooks → features) avoids what
 * would otherwise be a cycle through the storage barrel.
 *
 * Returns an empty array when no candidates exist; the caller falls back
 * to `messageId` (the result's own id) in that case so the runtime
 * still allocates a stable composite key.
 */
export declare function getCandidateToolOwners(db: Database, sessionId: string, callId: string): string[];
/**
 * Pick the most recent (by OpenCode `time_created`) candidate owner
 * whose message strictly precedes `currentMessageId`. Tie-break on
 * lexicographic id, matching the legacy single-statement ordering
 * (`ORDER BY time_created DESC, id DESC` limited to rows where
 * `time_created < currentTime`).
 *
 * Returns null when:
 *   - The candidate list is empty
 *   - `currentMessageId` is not present in `times`
 *   - No candidate predates `currentMessageId` in OC time
 *
 * This helper is independent of any DB handle — the caller resolves the
 * `times` map (typically via `getMessageTimesFromOpenCodeDb`) and passes
 * it in. Splitting the lookup from the picking keeps `storage-tags.ts`
 * free of any OpenCode-DB import.
 */
export declare function pickNearestPriorOwner(candidates: readonly string[], currentMessageId: string, times: ReadonlyMap<string, number>): string | null;
/**
 * Legacy alias kept for the rare runtime call site that hasn't been
 * migrated to the split lookup-then-pick form. Always returns null
 * (no message-time data available without a DB handle the function
 * itself can't reach). New call sites should use `getCandidateToolOwners`
 * + `getMessageTimesFromOpenCodeDb` + `pickNearestPriorOwner` directly.
 *
 * Why we keep this name: the v3.3.1 plan documents this as the public
 * entry point for the result-only-window fallback. Removing it would
 * require touching `.alfonso/plans/tag-owner-fix-plan.md` and migrating
 * the test fixtures that exercise it. Leaving the symbol present with
 * a noop body keeps existing test scaffolds working while the actual
 * pick happens in the hooks-tree caller.
 */
export declare function getPersistedToolOwnerNearestPrior(_db: Database, _sessionId: string, _callId: string, _currentMessageId: string): string | null;
/**
 * Delete every tool tag owned by `ownerMsgId` in the session. Used by
 * `message.removed` cleanup to scope the deletion correctly: pre-v10
 * a removed assistant message would `deleteTagsByMessageId(messageId)`
 * which only matched `message_id = messageId` (the contentId for text
 * parts), missing tool tags whose `message_id` is the callID. Post-v10
 * the owner column gives us the right scope.
 *
 * Returns the number of rows deleted. NULL-owner legacy rows are not
 * matched by this helper — they remain reachable via `message_id`-only
 * deletion paths until adopted or backfilled.
 */
export declare function deleteToolTagsByOwner(db: Database, sessionId: string, ownerMsgId: string): number;
//# sourceMappingURL=storage-tags.d.ts.map