import { type SmartNotePhaseExecutors, type SmartNotePhaseSnapshot } from "./evaluator";
export type EvaluatorMethod = "note.evaluation.register" | "note.evaluation.heartbeat" | "note.evaluation.unregister" | "note.evaluation.next" | "note.evaluation.renew" | "note.evaluation.complete" | "note.evaluation.abandon";
export interface EvaluatorWorkerTransport {
    call(args: {
        method: EvaluatorMethod;
        body: unknown;
        signal?: AbortSignal;
    }): Promise<unknown>;
}
export interface EvaluatorWorkerPolicy {
    retinaHandoff: boolean;
    wakeOwned: boolean;
}
export interface SmartNoteEvaluatorWorkerDeps {
    transport: EvaluatorWorkerTransport;
    /**
     * Build the phase executors for one claimed snapshot. Executors run QuickJS
     * through `runCompiledSmartNoteCheck`, so each sandbox execution serializes
     * itself for exactly its own window. The worker deliberately holds no
     * process-wide sandbox reservation across a claim: a claim lease outlives a
     * bounded QuickJS run by orders of magnitude, so waiting behind one run is
     * cheap, whereas holding the global slot across an LLM compile or fallback
     * confirmation would stall every other project's sweep for the length of a
     * network round-trip.
     */
    executors: (snapshot: SmartNotePhaseSnapshot, signal: AbortSignal, deadline: number) => SmartNotePhaseExecutors;
    policy: () => EvaluatorWorkerPolicy;
    heartbeatMs?: number;
    log?: (message: string) => void;
}
export interface DrainResult {
    claimed: number;
    completed: number;
    abandoned: number;
    surfaced: number;
    /** True when polling stopped because the authority reported no more work. */
    drained: boolean;
}
/**
 * Client-initiated evaluator worker for the Rust note authority (protocol
 * v2.0, zero-wait polling). The worker owns explicit registration lifecycle:
 * availability exists only while registration and heartbeat are live, and a
 * host restart or route teardown withdraws it without any persisted state.
 */
export declare class SmartNoteEvaluatorWorker {
    private readonly deps;
    private readonly instanceId;
    private registration;
    private heartbeatTimer;
    private pendingAcquisitionId;
    private disposed;
    /** Whether the most recent abandon actually released the claim. */
    private lastAbandonReleased;
    /** Abort handle for the claim currently executing, if any. */
    private activeClaimController;
    /** Settlement of the claim currently executing; never rejects. */
    private activeClaimSettled;
    /** Tail of the drain queue; drains run strictly one at a time. */
    private drainChain;
    /** In-flight registration attempt shared by concurrent register() callers. */
    private registerInFlight;
    constructor(deps: SmartNoteEvaluatorWorkerDeps);
    get registered(): boolean;
    /**
     * Claim-renewal cadence. An explicit dependency override wins for tests;
     * otherwise follow the cadence the authority published at registration so a
     * lease change on the Rust side cannot silently outrun the client.
     */
    private claimRenewIntervalMs;
    private logLine;
    /**
     * Registration-identity fence accepted by every fenced method. The module
     * validates each method against a closed field set, so this carries only the
     * fields common to all of them; claim-scoped calls add `evaluator_slot`
     * through {@link claimBody}.
     */
    private fencedBody;
    /** Fence for the claim-scoped methods (next/renew/complete/abandon). */
    private claimBody;
    register(signal?: AbortSignal): Promise<boolean>;
    private registerAttempt;
    private startHeartbeat;
    private stopHeartbeat;
    heartbeat(): Promise<void>;
    private dropRegistration;
    unregister(): Promise<void>;
    dispose(): Promise<void>;
    /**
     * Zero-wait drain: poll for Rust-selected work until the authority reports
     * no_work, the deadline passes, or the signal aborts.
     *
     * Normal phase fairness lives in the authority: each (registration, slot,
     * mode) owns a bounded selection cycle (full 10/5/3/3 across
     * due/compile/liveness/fallback; nonbillable 10/10 across due/liveness).
     * The authority separates the two reasons it can report no work: a spent
     * cycle answers `cycle_exhausted` (and resets that cycle), while an empty
     * queue answers plain `no_work`. Only the latter is a drained queue. This
     * drain consumes one `cycle_exhausted` before it claims anything, so a
     * cursor left spent by an earlier truncated drain costs one poll instead of
     * this whole pass. The client-side caps below are defensive backstops for
     * recovered claims and malformed authorities, not the fairness mechanism.
     *
     * `excludeBillable` asks the authority for sandbox-only phases (due,
     * liveness); compile and fallback claims launch LLM prompts and belong to
     * the scheduled full-budget drain. `maxCompilePerRun`/`maxFallbackPerRun`
     * bound the billable claims this drain executes client-side (default: the
     * legacy per-run caps).
     */
    drainOnce(args: {
        deadline: number;
        signal?: AbortSignal;
        excludeBillable?: boolean;
        maxCompilePerRun?: number;
        maxFallbackPerRun?: number;
    }): Promise<DrainResult>;
    private drainOnceExclusive;
    private next;
    private executeClaim;
    private renew;
    /**
     * Terminally release a claim. `reason` is local telemetry only: the module's
     * abandon schema is closed and carries no reason field, so sending it would
     * reject the release and leave the claim to be re-handed out until its lease
     * expires.
     */
    private abandon;
}
//# sourceMappingURL=evaluator-worker.d.ts.map