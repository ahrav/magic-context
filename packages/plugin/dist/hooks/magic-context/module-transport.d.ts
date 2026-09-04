import type { AuthorityDrainResponse, AuthorityStatus, ChangefeedPage } from "../../features/magic-context/context-authority";
import { type ConnectionOrigin, type NativeStartupEnvelope, type StorageReadiness } from "../../shared/mc-host-lifecycle";
import { type ClaimEffectDeliveryRequest, type ClaimEffectDeliveryResponse, type ClaimIntentAckRequest, type ClaimIntentAckResponse, type ClaimIntentInspectRequest, type ClaimIntentInspectResponse, type ClaimIntentStageRequest, type ClaimIntentStageResponse, type ClaimMirrorReceiptRequest, type ClaimMirrorReceiptResponse, type ClaimMirrorSnapshotRequest, type ClaimMirrorSnapshotResponse } from "./module-wire";
/** Consumer deadline for the module's exported historian::MAX_WRAPUP_REQUEST_BUDGET. */
export declare const MAX_WRAPUP_REQUEST_BUDGET_MS = 3800000;
export interface ManagedDemandResult {
    ok: boolean;
    reason: string;
    storage: StorageReadiness | null;
}
export type ManagedDemandStart = (request: {
    origin: ConnectionOrigin;
    capability: "magic-context" | "synapse";
    signal?: AbortSignal;
    deadlineMs?: number;
    startupEnvelope?: NativeStartupEnvelope;
}) => Promise<ManagedDemandResult>;
export interface McHostModuleTransportOptions {
    connectionFile?: string;
    moduleId?: string;
    requestTimeoutMs?: number;
    routeSessionPrefix?: string;
    demandStart?: ManagedDemandStart;
}
export interface LazyManagedDemandStartOptions {
    declaringModuleUrl: string;
    parentPackageName: string;
}
declare function managedCredentialSourceVersion(env: Record<string, string | undefined>): string;
export declare function buildManagedStartupEnvelope(parentPackageName: string, env?: Record<string, string | undefined>, executable?: string, entrypoint?: string | undefined, resolvePath?: (path: string) => string): NativeStartupEnvelope;
export declare function createLazyManagedDemandStart(options: LazyManagedDemandStartOptions): ManagedDemandStart;
export declare function configureManagedDemandStart(demandStart: ManagedDemandStart | undefined): void;
/** Route errors must be recognized by wire-visible shape because plugin bundles can carry a
 *  different copy of the client from the code that originated the error. */
declare function isStaleOrDeadRouteFailure(error: unknown): boolean;
declare function isConnectionFailure(error: unknown): boolean;
export interface ModuleTransportGenerationChangedResult {
    transport_status: "connection_generation_changed";
    previous_generation: number;
    current_generation: number;
}
export declare function isModuleTransportGenerationChangedResult(value: unknown): value is ModuleTransportGenerationChangedResult;
export declare class McHostModuleTransport {
    private readonly connectionFile;
    private readonly connectionOrigin;
    private readonly demandStart;
    private readonly moduleId;
    private readonly requestTimeoutMs;
    private readonly routeSessionPrefix;
    private client;
    private routes;
    private routeOpenings;
    private canonicalRootCache;
    private sessionLanes;
    private queuedLaneWaiters;
    private wrapupSessions;
    private nextProbeMs;
    private connectionPromise;
    private authorityProjectRoot;
    /**
     * Filesystem root used to bind authority/mirror routes. Authority request
     * bodies carry the MC project IDENTITY (git:<sha> / dir:<hash>), which is not
     * a path — the daemon validates BindIdentity.project_root against the real
     * filesystem and rejects identity strings outright.
     */
    private authorityBindRoot;
    private backoffMs;
    private connectionGeneration;
    private stateSyncCapabilityCache;
    /** Returns the capability snapshot for the currently live SUBC connection. */
    getCachedStateSyncCapabilities(): {
        state_sync_deltas?: boolean;
    } | undefined;
    /** Clears the snapshot after a module signal that can change its wire capabilities. */
    invalidateStateSyncCapabilities(): void;
    stateSyncCapabilities(args: {
        sessionId: string;
        projectRoot: string;
    }): Promise<{
        state_sync_deltas?: boolean;
    }>;
    constructor(connectionFileOrOptions?: string | McHostModuleTransportOptions, moduleId?: string, requestTimeoutMs?: number, routeSessionPrefix?: string);
    private deadlineError;
    private laneTimeoutError;
    private connectionChangedError;
    private beforeDeadline;
    private cleanupLane;
    private laneRelease;
    private dispatchNextLaneWaiter;
    private queueFullError;
    private acquireCorrectnessLane;
    call(args: {
        sessionId: string;
        projectRoot: string;
        method: "state_sync" | "transform" | "session.status" | "session.delete" | "session.flush" | "session.recomp" | "session.wrapup" | "todo_state.set" | "agent_drops.append" | "authority.status" | "authority.prepare" | "authority.seed" | "authority.drain.begin" | "authority.drain.finish" | "authority.drain_seed" | "authority.drain_memories" | "authority.drain_notes" | "authority.drain_compartments" | "authority.drain_reconcile" | "authority.drain_verify" | "authority.drain_flip" | "authority.drain_finish" | "mirror.pull" | "ctx_note" | "ctx_memory" | "claim.intent.stage" | "claim.intent.inspect" | "claim.intent.ack" | "claim.effects.apply" | "claim.mirror.replace" | "claim.mirror.apply" | "note.evaluate" | "note.evaluation.register" | "note.evaluation.heartbeat" | "note.evaluation.unregister" | "note.evaluation.next" | "note.evaluation.renew" | "note.evaluation.complete" | "note.evaluation.abandon" | "transform.ack" | "transform.nack" | "dreamer.run_task" | "memory.set_classification";
        body: unknown;
        signal?: AbortSignal;
        /** Do not retry after reconnecting; let the caller rebuild for the new connection. */
        generationSensitive?: boolean;
        /** Producer-backed calls can outlive the default transport budget. */
        timeoutMs?: number;
    }): Promise<unknown>;
    private authorityRequest;
    setAuthorityBindRoot(root: string): void;
    private bindRootForAuthority;
    authorityStatus(args: {
        context_store_uuid: string;
        project: string;
        projectRoot?: string;
        domain: "memories" | "notes";
    }): Promise<{
        authority: AuthorityStatus | null;
    }>;
    authorityPrepare(args: Record<string, unknown>): Promise<{
        authority: AuthorityStatus;
    }>;
    authoritySeed(args: Record<string, unknown>): Promise<{
        seeded: number;
        module_row_ids?: number[];
    }>;
    authorityDrain(args: Record<string, unknown>): Promise<AuthorityDrainResponse>;
    mirrorPull(args: {
        domain: "memories" | "notes";
        cursor: number;
        limit: number;
        live_only?: boolean;
        projectRoot?: string;
    }): Promise<{
        page: ChangefeedPage;
    }>;
    claimIntentStage(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentStageRequest;
    }): Promise<ClaimIntentStageResponse>;
    claimIntentInspect(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentInspectRequest;
    }): Promise<ClaimIntentInspectResponse>;
    claimIntentAck(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentAckRequest;
    }): Promise<ClaimIntentAckResponse>;
    claimEffectsApply(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimEffectDeliveryRequest;
    }): Promise<ClaimEffectDeliveryResponse>;
    claimMirrorReplace(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimMirrorSnapshotRequest;
    }): Promise<ClaimMirrorSnapshotResponse>;
    claimMirrorApply(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimMirrorReceiptRequest;
    }): Promise<ClaimMirrorReceiptResponse>;
    deleteSession(sessionId: string, projectRoot: string): Promise<void>;
    closeSession(sessionId: string): void;
    private ensureRoute;
    private dropRoute;
    /** Resolve symlinks with per-instance memoization; keep the input spelling when the
     *  path is gone (canonicalization must never fail a request). */
    private canonicalRoot;
    private connectClient;
    private demandManagedReadiness;
    private ensureConnected;
    private invalidateConnection;
}
export declare const __moduleTransportTest: {
    isConnectionFailure: typeof isConnectionFailure;
    isStaleOrDeadRouteFailure: typeof isStaleOrDeadRouteFailure;
    managedCredentialSourceVersion: typeof managedCredentialSourceVersion;
};
export {};
//# sourceMappingURL=module-transport.d.ts.map