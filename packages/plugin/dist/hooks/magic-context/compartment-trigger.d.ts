import type { ContextUsage, SessionMeta, TagEntry } from "../../features/magic-context/types";
import type { Database } from "../../shared/sqlite";
import { type ProtectedTailBoundarySnapshot } from "./protected-tail-boundary";
import { type InMemoryMessageView, type RawMessage } from "./read-session-raw";
declare const POST_DROP_TARGET_RATIO = 0.75;
declare const BLOCK_UNTIL_DONE_PERCENTAGE = 95;
export { BLOCK_UNTIL_DONE_PERCENTAGE, POST_DROP_TARGET_RATIO };
export interface CompartmentTriggerResult {
    shouldFire: boolean;
    reason?: "projected_headroom" | "force_band" | "commit_clusters" | "tail_size";
    /**
     * The protected-tail boundary snapshot the decision was computed from.
     * Present whenever the tail inspection ran. Callers that start the
     * historian in the SAME pass (transform path) should hand this to
     * runCompartmentPhase so it doesn't re-resolve the boundary — one
     * resolution per pass, and the historian sees exactly the snapshot the
     * decision saw.
     */
    boundarySnapshot?: ProtectedTailBoundarySnapshot;
}
/**
 * In-memory tail source for the trigger — the transform's `args.messages`
 * converted to absolute-ordinal RawMessages (via `buildInMemoryTailRawMessages`
 * with `anchorFound=true`). When supplied, the tail inspection primes the
 * raw-message cache from memory and performs ZERO opencode.db reads on the hot
 * path. Callers must only pass an ANCHORED conversion — an unanchored one has
 * assumed ordinals; leave it undefined to fall through to the DB-primed path.
 */
export interface InMemoryTailSource {
    messages: RawMessage[];
    absoluteMessageCount: number;
}
/**
 * Wire capability for projecting reclaimable reasoning bytes. OpenCode derives
 * this from the provider's empty-sentinel support; Pi overrides it because its
 * serializers safely omit cleared thinking for every provider.
 */
export interface ReasoningProjectionCapability {
    providerID?: string;
    canClearReasoning?: boolean;
}
/**
 * Deferred tail conversion for callers that have already tagged the live wire.
 * The trigger's cheap gate can use the caller-provided tag floor without building
 * RawMessages; the factory runs only when authoritative tail inspection is needed.
 */
export type LazyInMemoryTailSource = () => InMemoryTailSource | undefined;
/**
 * Convert the transform's in-memory `args.messages` into a trigger tail source,
 * applying the anchored-only gate:
 *
 * - Compartments exist + boundary has a message id → require the anchor to be
 *   FOUND in the array (`anchorFound`). OpenCode's `filterCompacted` stops at
 *   our compaction marker (the boundary message), so the anchor is normally the
 *   array head; when the marker drain lags, the anchor sits a few messages in
 *   and the converter drops the already-compartmentalized prefix. If it isn't
 *   present at all (deleted, or the marker advanced past it), ordinal
 *   assignment would be an unverified guess → return undefined so the caller
 *   falls through to the DB-primed read.
 * - Compartments exist but the boundary row has NO message id (legacy rows) →
 *   undefined (DB path, as before).
 * - No compartments (#132 early-session) → the whole array is the session;
 *   ordinals from 1, no anchor needed.
 *
 * Live-verified byte-identical to the DB path on every boundary decision field
 * (offset, protectedTailStart, eligibleEndOrdinal, N, trueRawEligibleTokens,
 * arc fencing) across real sessions before the cutover.
 */
export declare function buildTriggerInMemoryTail(db: Database, sessionId: string, messages: readonly InMemoryMessageView[]): InMemoryTailSource | undefined;
export declare function getProactiveCompartmentTriggerPercentage(executeThresholdPercentage: number): number;
export declare function checkCompartmentTrigger(db: Database, sessionId: string, sessionMeta: SessionMeta, usage: ContextUsage, _previousPercentage: number, executeThresholdPercentage: number, triggerBudget: number, clearReasoningAge?: number, commitClusterTrigger?: {
    enabled: boolean;
    min_clusters: number;
}, preloadedActiveTags?: readonly TagEntry[], contextLimit?: number, inMemoryTail?: InMemoryTailSource | LazyInMemoryTailSource, taggerFloorOverride?: number, reasoningProjection?: ReasoningProjectionCapability): CompartmentTriggerResult;
//# sourceMappingURL=compartment-trigger.d.ts.map