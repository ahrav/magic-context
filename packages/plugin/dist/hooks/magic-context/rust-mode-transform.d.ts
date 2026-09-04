import { type AuthorityDrainResponse, type AuthorityStatus } from "../../features/magic-context/context-authority";
import { resolveMuralWire } from "../../features/magic-context/mural/render-trigger";
import type { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import type { ContextUsage } from "../../features/magic-context/types";
import type { WindowGeometryResult } from "../../shared/window-geometry";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { type LkgContentField } from "./lkg-slot";
import { type ModuleCompartmentMirrorResponse, type ModuleStateSyncClient, type ModuleStateSyncState } from "./module-state-sync";
import { type ClaimEffectDeliveryRequest, type ClaimEffectDeliveryResponse, type ClaimIntentAckRequest, type ClaimIntentAckResponse, type ClaimIntentInspectRequest, type ClaimIntentInspectResponse, type ClaimIntentStageRequest, type ClaimIntentStageResponse, type ClaimMirrorReceiptRequest, type ClaimMirrorReceiptResponse, type ClaimMirrorSnapshotRequest, type ClaimMirrorSnapshotResponse } from "./module-wire";
import type { RawMessageOrdinalAnchor } from "./read-session-raw";
import type { TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";
export declare class MemoryAuthorityUnavailableError extends Error {
    readonly code = "MEMORY_AUTHORITY_UNAVAILABLE";
    constructor(detail: string);
}
export declare const RUST_FAILURE_PARK_THRESHOLD = 3;
export declare const RUST_PARK_RETRY_INTERVAL = 5;
export declare const RUST_EMERGENCY_WALL_PCT = 95;
export declare const RUST_PARK_PROBE_PRESSURE_BYPASS_PCT = 90;
export interface RustModeModuleClient extends ModuleStateSyncClient {
    authorityStatus?(args: {
        context_store_uuid: string;
        project: string;
        /** Bound route root for this authority query. */
        projectRoot?: string;
        domain: "memories" | "notes";
    }): Promise<{
        authority: AuthorityStatus | null;
    }>;
    authorityPrepare?(args: Record<string, unknown>): Promise<{
        authority: AuthorityStatus;
    }>;
    authoritySeed?(args: Record<string, unknown>): Promise<{
        seeded: number;
        module_row_ids?: number[];
    }>;
    authorityDrain?(args: Record<string, unknown>): Promise<AuthorityDrainResponse>;
    mirrorPull?(args: {
        domain: "memories" | "notes";
        cursor: number;
        limit: number;
        live_only?: boolean;
        projectRoot?: string;
    }): Promise<{
        page: import("../../features/magic-context/context-authority").ChangefeedPage;
    }>;
    deleteSession?(sessionId: string, projectRoot: string): Promise<void>;
    closeSession?(sessionId: string): void;
    getCompartmentsAfter?(sessionId: string, afterSequence: number): Promise<ModuleCompartmentMirrorResponse>;
    claimIntentStage?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentStageRequest;
    }): Promise<ClaimIntentStageResponse>;
    claimIntentInspect?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentInspectRequest;
    }): Promise<ClaimIntentInspectResponse>;
    claimIntentAck?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentAckRequest;
    }): Promise<ClaimIntentAckResponse>;
    claimEffectsApply?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimEffectDeliveryRequest;
    }): Promise<ClaimEffectDeliveryResponse>;
    claimMirrorReplace?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimMirrorSnapshotRequest;
    }): Promise<ClaimMirrorSnapshotResponse>;
    claimMirrorApply?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimMirrorReceiptRequest;
    }): Promise<ClaimMirrorReceiptResponse>;
}
interface MessageContentSnapshot {
    signature: string;
    fields: LkgContentField[];
}
interface RustSessionState extends ModuleStateSyncState {
    initialized: boolean;
    consecutiveFailures: number;
    passCount: number;
    parked: boolean;
    passesSincePark: number;
    warningSent: boolean;
    /** Set when the module answered need_full_sync: the next pass must send the
     * full wire array (delta eligibility bypassed) until a pass applies. Wire-layer
     * only — never triggers a state re-seed. */
    forceFullWire: boolean;
    ordinalMemoAnchor: RawMessageOrdinalAnchor | null;
    ordinalMemoStoredCount: number | null;
    ordinalMemoCanonicalCount: number;
    /** Durable prior-lineage tail returned by the module after descent. Fresh arrays
     * continue after this base instead of regenerating index+1 ordinals. */
    ordinalContinuationBase: number | null;
    failureCount: number;
    parkCount: number;
    syntheticTurnCount: number;
    lastObservedUserMessageId: string | null;
    syntheticLoopBreakerLogged: boolean;
    memoryAuthorityProject: string | null;
    memoryAuthorityRoot: string | null;
    memoryAuthorityReady: boolean;
    authorityMemorySyncSkipLogged?: boolean;
    lkgCaptureSequence: number;
    lkgLastCapturedRowVersion: number;
    lkgSyncCaptureRequired: boolean;
}
export interface RustModeTransformOptions {
    moduleClient: RustModeModuleClient;
    hostClient?: unknown;
    projectRoot?: string;
    notifyParked?: (sessionId: string, message: string) => void;
    moduleTimeoutMs?: number;
    /**
     * Invoked with each project that reaches rust-mode authority preparation, so the
     * host can lazily register per-project services (the smart-note evaluator bridge)
     * for projects other than the plugin's launch directory. `projectRoot` is the
     * route root the authority was prepared with; per-project services must bind
     * their transports and filesystem scope to it.
     */
    onProjectPrepared?: (projectPath: string, projectRoot: string) => void;
    /** Test-only escape hatch for transform-wire tests without an authority transport. */
    allowAuthorityProtocolBypassForTests?: boolean;
    /** Override only for deterministic capture scheduling in tests. */
    scheduleLkgCapture?: (capture: () => void) => void;
    /** Override only to exercise raw-fallback estimator failures in tests. */
    rawFallbackEstimatorForTests?: typeof estimateFinalWireInputTokens;
}
/** Capture an exact field snapshot plus its compact content-sensitive rolling hash. */
declare function messageContentSnapshot(message: MessageLike): MessageContentSnapshot;
declare function contentSnapshotsFor(messages: readonly MessageLike[]): MessageContentSnapshot[];
declare function messageMatchesContentSnapshot(message: MessageLike, snapshot: MessageContentSnapshot): boolean;
interface RustPassTimings {
    prefixGuard: number;
    ordinalResolve: number;
    stateSync: number;
    clone: number;
    wireBuild: number;
    wireMessages: number;
    transport: number;
    transportPages: number;
    transportBytes: number;
    apply: number;
    lkgSnapshot: number;
    mirrorPull: number;
    compartmentMirror: number;
}
declare function formatRustPassLog(args: {
    decision: string;
    reason: string;
    servedFrom: string;
    inputCount: number;
    outputCount: number;
    applied: boolean;
    elapsedMs: number;
    moduleElapsedMs: number;
    rowVersion: number;
    timings?: RustPassTimings;
}): string;
interface TransformGeometryWire {
    usable_soft: number;
    usable_hard: number;
    derivation: string;
}
declare function transformGeometryForWire(geometry: WindowGeometryResult | undefined): TransformGeometryWire | undefined;
declare function hardWallUsagePercentage(usage: ContextUsage, geometry: TransformGeometryWire | undefined): number;
declare function shouldDisarmRustEmergencyRecovery(input: {
    materialized: boolean;
    usagePercentage: number;
    recoveryOrigin: "provider_overflow" | "proactive_model_shrink" | null;
    recoveryArmedAt: number | null;
    usageEntry: {
        updatedAt: number;
        hasUsageTokens?: boolean;
    } | null | undefined;
    finalWireEstimate?: {
        tokens: number;
        trusted: boolean;
    };
    providerProvenLimitTokens: number;
}): "fresh-usage" | "trusted-final-wire" | null;
declare function directiveTextOf(response: Record<string, unknown>): string | undefined;
declare function prepareRustMemoryAuthority(args: {
    db: TransformDeps["db"];
    module: RustModeModuleClient;
    projectPath: string;
    projectRoot: string;
    state: RustSessionState;
    allowProtocolBypassForTests?: boolean;
    /** Fires after authority is ready so hosts can register per-project services. */
    onProjectPrepared?: (projectPath: string, projectRoot: string) => void;
}): Promise<void>;
export declare function applyNativeMessagesVerbatim(output: {
    messages: unknown[];
}, response: Record<string, unknown>, previous?: {
    messages: readonly unknown[];
    fingerprint: string;
}): unknown[];
declare function muralInputForWire(mural: ReturnType<typeof resolveMuralWire> | undefined): Record<string, unknown> | undefined;
declare function buildTransformBody(args: {
    sessionId: string;
    input: unknown[];
    nativeMessages: unknown[];
    passInputs: Record<string, unknown>;
    usage: Record<string, number | boolean>;
    geometry?: TransformGeometryWire;
    modelKey: string | null;
    providerId: string | null;
    systemPromptHash: string;
    upgradeState: string;
    midTurn: boolean;
    prevResponseCompletedAtMs?: number;
    requestObservedAtMs?: number;
    channel2NudgeState: string;
    emergencyRecoveryArmed: boolean;
    declaredTrim?: unknown;
    fullArrayFingerprint?: string;
    tailDelta?: {
        after: string;
        replaceFrom: number;
        nativeReplaceFrom: number;
    };
}): Record<string, unknown>;
export declare function createRustModeTransform(deps: TransformDeps, options: RustModeTransformOptions): {
    run: (sessionId: string, messages: MessageLike[], output: {
        messages: unknown[];
    }, sessionMeta: ReturnType<typeof getOrCreateSessionMeta>) => Promise<void>;
    clearSession: (sessionId: string) => void;
    invalidateWireState: (sessionId: string) => void;
    getState: (sessionId: string) => Readonly<RustSessionState>;
};
export declare function runRustModeTransform(transform: ReturnType<typeof createRustModeTransform>, sessionId: string, messages: MessageLike[], output: {
    messages: unknown[];
}, sessionMeta: ReturnType<typeof getOrCreateSessionMeta>): Promise<void>;
export declare const __rustModeTransformTest: {
    applyNativeMessagesVerbatim: typeof applyNativeMessagesVerbatim;
    contentSnapshotsFor: typeof contentSnapshotsFor;
    snapshotTags: {
        array: symbol;
        object: symbol;
        key: symbol;
        string: symbol;
        number: symbol;
        boolean: symbol;
        null: symbol;
        undefined: symbol;
    };
    messageContentSnapshot: typeof messageContentSnapshot;
    messageMatchesContentSnapshot: typeof messageMatchesContentSnapshot;
    buildTransformBody: typeof buildTransformBody;
    transformGeometryForWire: typeof transformGeometryForWire;
    hardWallUsagePercentage: typeof hardWallUsagePercentage;
    muralInputForWire: typeof muralInputForWire;
    formatRustPassLog: typeof formatRustPassLog;
    shouldDisarmRustEmergencyRecovery: typeof shouldDisarmRustEmergencyRecovery;
    createRustModeTransform: typeof createRustModeTransform;
    directiveTextOf: typeof directiveTextOf;
    prepareRustMemoryAuthority: typeof prepareRustMemoryAuthority;
};
export {};
//# sourceMappingURL=rust-mode-transform.d.ts.map