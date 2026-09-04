import type { Database } from "../../shared/sqlite";
export type BoundaryMode = "trigger" | "incremental-runner" | "transform-force" | "manual-full-recomp" | "manual-partial-recomp" | "manual-wrapup" | "pi-trigger" | "pi-runner";
export interface BoundaryUsage {
    percentage: number;
    inputTokens: number;
}
export interface ResolvedBoundaryContext {
    sessionId: string;
    mode: BoundaryMode;
    contextLimit: number;
    executeThresholdPercentage: number;
    triggerBudget: number;
    usage: BoundaryUsage | null;
    usageSource: "live" | "persisted" | "provisional-zero" | "manual-none";
    lastCompartmentEndOrdinal: number;
    priorBoundaryOrdinal: number;
    protectedTailPolicyVersion: number;
    migrationFloorActive: boolean;
    emergencyTailScale?: 0.5 | 0.25;
    providerShapeVersion: "opencode-v1" | "pi-folded-v1";
    cacheNamespace: string;
    createdAt?: number;
    /**
     * Durable per-message token totals (sum of the message's active tag
     * token_counts), keyed by real message id. When present, the boundary's
     * token index reads these instead of re-tokenizing the raw session — the
     * restart-durable fast path. A message missing here (or with a NULL-count
     * tag) falls back to live tokenization. Built once in resolveBoundaryContext
     * from the tag store; omitted (→ all-live) when the caller has no tag store.
     */
    storedTokenTotals?: Map<string, number>;
}
export interface ProtectedTailBoundarySnapshot {
    sessionId: string;
    mode: BoundaryMode;
    offset: number;
    offsetMessageId: string | null;
    protectedTailStart: number;
    protectedTailStartMessageId: string | null;
    eligibleEndOrdinal: number;
    eligibleEndMessageId: string | null;
    rawMessageCountAtTrigger: number;
    rawLastMessageIdAtTrigger: string | null;
    N: number;
    usagePercentage: number;
    usageInputTokens: number;
    usageSource: ResolvedBoundaryContext["usageSource"];
    contextLimit: number;
    executeThresholdPercentage: number;
    triggerBudget: number;
    priorBoundaryOrdinal: number;
    migrationFloorActive: boolean;
    emergencyTailScale?: 0.5 | 0.25;
    providerShapeVersion: "opencode-v1" | "pi-folded-v1";
    cacheNamespace: string;
    createdAt: number;
    rawRangeFingerprint: string;
    trueRawEligibleTokens: number;
    oversizeAtomicUnit: boolean;
    boundaryReason: string;
}
export interface ProtectedTailTokenTarget {
    usable: number;
    rawN: number;
    floorN: number;
    ceilingN: number;
    effectiveFloor: number;
    N: number;
    headroom: number;
    triggerBudget: number;
    reserve: number;
}
export interface RawHistoryEligibility {
    lastCompartmentEnd: number;
    offset: number;
    rawMessageCount: number;
    hasRawBeyondLastCompartment: boolean;
}
export interface ProactiveTriggerInfo {
    boundary: ProtectedTailBoundarySnapshot;
    hasProtectedEligibleHead: boolean;
    trueRawEligibleTokens: number;
    tcTokenEstimate: number;
    messageCount: number;
    commitClusterCount: number;
    isMeaningful: boolean;
}
export interface BoundarySnapshotValidationResult {
    ok: boolean;
    reason?: "stale_snapshot" | "model_or_limit_changed";
    detail?: string;
}
export interface WrapupBoundaryPlan {
    snapshot: ProtectedTailBoundarySnapshot;
    /** Raw messages (any role) after the last durable compartment, counted at command start. */
    rawMessagesAboveLastCompartment: number;
    /** Raw-message count used to anchor the keep watermark for the whole wrapup loop. */
    anchorRawMessageCount: number;
    /** First raw ordinal that remains protected by the keep watermark. */
    targetProtectedTailStart: number;
    /** Exclusive eligible end before per-run capping. */
    targetEligibleEndOrdinal: number;
}
export declare const RECOVERY_NO_HEAD_LIMIT = 2;
/** A tiny complete head is still worth summarizing at force pressure; below this, wait for a real arc/user turn. */
export declare const MIN_FORCE_ELIGIBLE_TOKENS_CAP = 1000;
export declare function deriveMinForceEligibleTokens(scaledN: number): number;
export declare function deriveProtectedTailTokenTarget(args: {
    contextLimit: number;
    executeThresholdPercentage: number;
    usagePercentage: number;
    triggerBudget?: number;
}): ProtectedTailTokenTarget;
export declare function nonEmergencyPerRunCap(usable: number, N: number): number;
export declare function force80PerRunCap(usable: number, N: number): number;
export declare function force95PerRunCap(usable: number, N: number): number;
export declare function selectPerRunCap(snapshot: Pick<ProtectedTailBoundarySnapshot, "usagePercentage" | "N" | "contextLimit" | "executeThresholdPercentage">): number;
export declare function resolveProtectedTailBoundary(ctx: ResolvedBoundaryContext): ProtectedTailBoundarySnapshot;
export declare function resolveBoundaryContext(args: {
    db: Database;
    sessionId: string;
    mode: BoundaryMode;
    contextLimit: number;
    executeThresholdPercentage: number;
    usage?: BoundaryUsage | null;
    usageSource?: ResolvedBoundaryContext["usageSource"];
    emergencyTailScale?: 0.5 | 0.25;
    providerShapeVersion?: "opencode-v1" | "pi-folded-v1";
    cacheNamespace?: string;
    /**
     * Tagger load-scoping floor (OpenCode only). When > 0, the stored-token map
     * is loaded only for tags at/above this floor (the live wire) instead of
     * scanning the whole session's tags (~100k rows → ~50ms every pass). The
     * boundary only indexes the live slice (all >= floor), and any slice message
     * the scoped map misses degrades to live tokenization of the same content,
     * so the cut point is byte-identical. Omit / 0 = full scan (Pi, recomp,
     * tests) — unchanged.
     */
    taggerFloor?: number;
}): ResolvedBoundaryContext;
export declare function resolveOpenCodeProtectedTailBoundary(args: Parameters<typeof resolveBoundaryContext>[0]): ProtectedTailBoundarySnapshot;
export declare function resolveWrapupProtectedTailBoundary(args: Parameters<typeof resolveBoundaryContext>[0] & {
    messagesToKeep: number;
    anchorRawMessageCount?: number;
}): WrapupBoundaryPlan;
export declare function getRawHistoryEligibility(db: Database, sessionId: string): RawHistoryEligibility;
export declare function hasProtectedEligibleHead(snapshot: ProtectedTailBoundarySnapshot): boolean;
export declare function hasRunnableCompartmentWindow(snapshot: ProtectedTailBoundarySnapshot): boolean;
export declare function validateBoundarySnapshot(args: {
    db: Database;
    snapshot: ProtectedTailBoundarySnapshot;
    currentContextLimit?: number;
}): BoundarySnapshotValidationResult;
export declare function recordHighPressureNoEligibleHead(db: Database, snapshot: ProtectedTailBoundarySnapshot): number;
export declare function resetHighPressureNoEligibleHead(db: Database, sessionId: string): void;
export declare function createDefaultBoundarySnapshotForTests(sessionId: string): ProtectedTailBoundarySnapshot;
//# sourceMappingURL=protected-tail-boundary.d.ts.map