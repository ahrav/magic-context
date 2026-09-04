import type { ContextDatabase } from "../../features/magic-context/storage";
import { getPendingOps } from "../../features/magic-context/storage";
import type { PendingOp, TagEntry } from "../../features/magic-context/types";
import type { TagTarget } from "./tag-messages";
/**
 * Agent-initiated (ctx_reduce) drops of a tool call within the newest N tool
 * calls keep a structural skeleton — the tool_use/tool_result pair survives
 * with the canonical `[dropped §N§]` placeholder as its output — instead of
 * being removed outright. (Long input arg VALUES are separately clamped with
 * `...[truncated]`: that's value-shortening, not a drop, so it keeps its own
 * marker.)
 *
 * WHY: when every recent tool call vanishes from the wire, models (especially
 * smaller ones) lose the anchors showing what they actually did and start
 * hallucinating fake tool-call shapes (the §N§ cargo-culting failure mode).
 * Keeping skeletons in the recent band structurally prevents that class.
 * Older drops still remove the full structure — deep history needs no anchors.
 *
 * CACHE SAFETY: the mode is decided once, at drop time (always a
 * cache-busting pass), persisted in `tags.drop_mode`, and replayed
 * byte-identically by `applyFlushedStatuses` on every later pass. A skeleton
 * is NEVER demoted to a full drop afterwards — that second mutation would be
 * a mid-prefix rewrite on some later pass (the volatile-boundary bust class).
 * Emergency drops use the same newest-window skeleton rule as agent drops;
 * heuristic dedup stays full-drop because dedup keeps the newest duplicate's
 * full content as the nearby anchor.
 */
export declare const RECENT_TOOL_SKELETON_WINDOW = 20;
export declare function buildReplacementContent(tagId: number): string;
export declare function applyPendingOperations(sessionId: string, db: ContextDatabase, targets: Map<number, TagTarget>, protectedTags?: number, preloadedTags?: TagEntry[], preloadedPendingOps?: ReturnType<typeof getPendingOps>, syntheticPendingOps?: PendingOp[], 
/**
 * Smart-drops: tag ids to compress as an edit_marker (an edit/write
 * superseded by a later edit to the same file) instead of a full/skeleton
 * drop. Synthetic-only: these are selected for the current apply pass;
 * replay reads the frozen drop_mode, not this set.
 */
editMarkerTagIds?: ReadonlySet<number>): boolean;
export declare function applyFlushedStatuses(sessionId: string, db: ContextDatabase, targets: Map<number, TagTarget>, preloadedTags?: TagEntry[]): boolean;
//# sourceMappingURL=apply-operations.d.ts.map