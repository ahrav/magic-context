import { randomUUID } from "node:crypto";

import { log as defaultLog } from "../../../shared/logger";
import type { SmartNoteEvaluationOutcome } from "./evaluation-state";
import { MAX_COMPILE_PER_RUN, MAX_FALLBACK_PER_RUN } from "./evaluation-state";
import {
    evaluateSmartNotePhase,
    type SmartNotePhaseExecutors,
    type SmartNotePhaseSnapshot,
} from "./evaluator";

export type EvaluatorMethod =
    | "note.evaluation.register"
    | "note.evaluation.heartbeat"
    | "note.evaluation.unregister"
    | "note.evaluation.next"
    | "note.evaluation.renew"
    | "note.evaluation.complete"
    | "note.evaluation.abandon";

export interface EvaluatorWorkerTransport {
    call(args: { method: EvaluatorMethod; body: unknown; signal?: AbortSignal }): Promise<unknown>;
}

export interface EvaluatorWorkerPolicy {
    retinaHandoff: boolean;
    wakeOwned: boolean;
}

export interface SmartNoteEvaluatorWorkerDeps {
    transport: EvaluatorWorkerTransport;
    /**
     * Executors run QuickJS through `runCompiledSmartNoteCheck`.
     * Each `runCompiledSmartNoteCheck` call serializes only its own sandbox execution.
     * The worker does not reserve a process-wide sandbox slot for a claim lease.
     * A claim lease outlasts a bounded QuickJS run.
     * The worker reserves the sandbox only for QuickJS execution, not LLM compilation or fallback confirmation.
     * Holding the global sandbox slot during LLM compilation or fallback confirmation would block other projects for a network round-trip.
     * network round-trip.
     */
    executors: (
        snapshot: SmartNotePhaseSnapshot,
        signal: AbortSignal,
        deadline: number,
    ) => SmartNotePhaseExecutors;
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

interface Registration {
    token: string;
    generation: number;
    /** Renewal cadence published by the authority at registration. */
    heartbeatMs: number;
}

interface ClaimResponse {
    claimId: string;
    noteId: number;
    snapshot: SmartNotePhaseSnapshot;
}

const EVALUATOR_PROTOCOL_VERSION = "2.0";
const DEFAULT_HEARTBEAT_MS = 60_000;
const MAX_CLAIMS_PER_DRAIN = 25;
/** Single-capacity worker: `capacity: 1` at registration means slot 0 is the only slot. */
const EVALUATOR_SLOT = 0;

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function outcomeWire(outcome: SmartNoteEvaluationOutcome): Record<string, unknown> {
    if (
        outcome.phase === "compile" &&
        (outcome.kind === "compiled_met" || outcome.kind === "compiled_false")
    ) {
        return {
            phase: outcome.phase,
            kind: outcome.kind,
            artifact: {
                compiled_check: outcome.artifact.compiledCheck,
                manifest_json: outcome.artifact.manifestJson,
                check_hash: outcome.artifact.checkHash,
                check_cron: outcome.artifact.checkCron,
            },
        };
    }
    return { phase: outcome.phase, kind: outcome.kind };
}

/**
 * The worker owns the registration lifecycle.
 * Availability exists only while registration and heartbeats are live.
 * A host restart or route teardown withdraws registration without persisted state.
 */
export class SmartNoteEvaluatorWorker {
    private readonly deps: SmartNoteEvaluatorWorkerDeps;
    private readonly instanceId = randomUUID();
    private registration: Registration | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private pendingAcquisitionId: string | null = null;
    private disposed = false;
    /* */
    private lastAbandonReleased = true;
    /* */
    private activeClaimController: AbortController | null = null;
    /** Settlement of the claim currently executing; never rejects. */
    private activeClaimSettled: Promise<void> | null = null;
    /** Tail of the drain queue; drains run strictly one at a time. */
    private drainChain: Promise<void> = Promise.resolve();
    /** In-flight registration attempt shared by concurrent register() callers. */
    private registerInFlight: Promise<boolean> | null = null;

    constructor(deps: SmartNoteEvaluatorWorkerDeps) {
        this.deps = deps;
    }

    get registered(): boolean {
        return this.registration !== null;
    }

    /**
     */
    private claimRenewIntervalMs(): number {
        return this.deps.heartbeatMs ?? this.registration?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    }

    private logLine(message: string): void {
        (this.deps.log ?? defaultLog)(`[smart-note-worker] ${message}`);
    }

    /**
     * Every fenced method validates the registration identity.
     */
    private fencedBody(extra: Record<string, unknown>): Record<string, unknown> {
        if (!this.registration) throw new Error("evaluator worker is not registered");
        return {
            v: 2,
            token: this.registration.token,
            registration_generation: this.registration.generation,
            evaluator_instance: this.instanceId,
            ...extra,
        };
    }

    /** The registration fence applies to claim-scoped methods: next, renew, complete, and abandon. */
    private claimBody(extra: Record<string, unknown>): Record<string, unknown> {
        return this.fencedBody({ evaluator_slot: EVALUATOR_SLOT, ...extra });
    }

    async register(signal?: AbortSignal): Promise<boolean> {
        if (this.disposed) return false;
        if (this.registration) return true;
        // Concurrent `register()` callers share one attempt to prevent successful registrations from overwriting each other's tokens.
        // Concurrent successful registrations would overwrite one token and leave it without heartbeats.
        if (this.registerInFlight) return this.registerInFlight;
        const attempt = this.registerAttempt(signal);
        this.registerInFlight = attempt;
        try {
            return await attempt;
        } finally {
            this.registerInFlight = null;
        }
    }

    private async registerAttempt(signal?: AbortSignal): Promise<boolean> {
        const policy = this.deps.policy();
        let response: Record<string, unknown>;
        try {
            response = asRecord(
                await this.deps.transport.call({
                    method: "note.evaluation.register",
                    body: {
                        v: 2,
                        evaluator_instance: this.instanceId,
                        protocol_version: EVALUATOR_PROTOCOL_VERSION,
                        policy_version: 0,
                        capacity: 1,
                        retina_handoff: policy.retinaHandoff,
                        wake_owned: policy.wakeOwned,
                    },
                    signal,
                }),
            );
        } catch (error) {
            // Return `false` after a transport failure so callers can continue without surfacing the failure.
            // Throwing would abort the `drainOnce` sweep tick.
            this.logLine(`registration failed: ${error}`);
            return false;
        }
        const token = response.token;
        const generation = response.registration_generation;
        if (typeof token !== "string" || typeof generation !== "number") {
            this.logLine(`registration rejected: ${JSON.stringify(response).slice(0, 200)}`);
            return false;
        }
        if (this.disposed) {
            // Disposal can race an in-flight registration.
            // Installing the token would start a heartbeat that advertises an unserviceable evaluator.
            // No drain path services the evaluator; unregister the token.
            try {
                await this.deps.transport.call({
                    method: "note.evaluation.unregister",
                    body: {
                        v: 2,
                        token,
                        registration_generation: generation,
                        evaluator_instance: this.instanceId,
                    },
                });
            } catch (error) {
                this.logLine(`post-dispose unregister failed (lease will expire): ${error}`);
            }
            return false;
        }
        const publishedHeartbeat = response.heartbeat_ms;
        this.registration = {
            token,
            generation,
            heartbeatMs:
                typeof publishedHeartbeat === "number" && publishedHeartbeat > 0
                    ? publishedHeartbeat
                    : DEFAULT_HEARTBEAT_MS,
        };
        this.lastAbandonReleased = true;
        this.startHeartbeat();
        // Callers sharing `register()`'s in-flight promise can change policy after the request captures policy.
        // Republishing prevents stale wake/retina policy until the next periodic heartbeat.
        const current = this.deps.policy();
        if (
            current.wakeOwned !== policy.wakeOwned ||
            current.retinaHandoff !== policy.retinaHandoff
        ) {
            await this.heartbeat();
        }
        return true;
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        const interval = this.claimRenewIntervalMs();
        this.heartbeatTimer = setInterval(() => {
            void this.heartbeat();
        }, interval);
        if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    async heartbeat(): Promise<void> {
        const registration = this.registration;
        if (!registration || this.disposed) return;
        const policy = this.deps.policy();
        try {
            const response = asRecord(
                await this.deps.transport.call({
                    method: "note.evaluation.heartbeat",
                    body: this.fencedBody({
                        retina_handoff: policy.retinaHandoff,
                        wake_owned: policy.wakeOwned,
                    }),
                }),
            );
            if (response.ok !== true) {
                this.logLine("heartbeat rejected; dropping registration");
                this.dropRegistration(registration);
            }
        } catch (error) {
            this.logLine(`heartbeat failed; dropping registration: ${error}`);
            this.dropRegistration(registration);
        }
    }

    private dropRegistration(checked: Registration): void {
        // The identity check ignores heartbeat failures from replaced registrations.
        // A slow failure for an old registration must not tear down its replacement.
        // A heartbeat failure for an old registration must not abort the replacement's claim.
        if (this.registration !== checked) return;
        this.registration = null;
        this.stopHeartbeat();
        // Without registration, a running claim cannot complete or abandon.
        this.activeClaimController?.abort(new Error("evaluator registration dropped"));
    }

    async unregister(): Promise<void> {
        this.stopHeartbeat();
        const registration = this.registration;
        this.registration = null;
        if (!registration) return;
        try {
            await this.deps.transport.call({
                method: "note.evaluation.unregister",
                body: {
                    v: 2,
                    token: registration.token,
                    registration_generation: registration.generation,
                    evaluator_instance: this.instanceId,
                },
            });
        } catch (error) {
            this.logLine(`unregister failed: ${error}`);
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.activeClaimController?.abort(new Error("evaluator worker disposed"));
        await this.activeClaimSettled;
        await this.unregister();
    }

    /**
     *
     *
     */
    async drainOnce(args: {
        deadline: number;
        signal?: AbortSignal;
        excludeBillable?: boolean;
        maxCompilePerRun?: number;
        maxFallbackPerRun?: number;
    }): Promise<DrainResult> {
        // Interleaved drains would replay one durable claim to two executors.
        const run = this.drainChain.then(
            () => this.drainOnceExclusive(args),
            () => this.drainOnceExclusive(args),
        );
        this.drainChain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private async drainOnceExclusive(args: {
        deadline: number;
        signal?: AbortSignal;
        excludeBillable?: boolean;
        maxCompilePerRun?: number;
        maxFallbackPerRun?: number;
    }): Promise<DrainResult> {
        const result: DrainResult = {
            claimed: 0,
            completed: 0,
            abandoned: 0,
            surfaced: 0,
            drained: false,
        };
        if (!this.registration) {
            if (!(await this.register(args.signal))) return result;
        }
        // The authority excludes notes claimed during the current fallback cycle.
        // The authority returns each fallback note at most once per cycle.
        // Recovered claims and malformed authorities can return a repeated fallback note.
        // One confirmation prompt per note per drain bounds repeated billable fallback prompts.
        const fallbackAttempted = new Set<number>();
        // Authority-side quota exhaustion returns `no_work` before the client-side caps bind.
        // The client-side caps prevent recovered claims and malformed authorities from exceeding per-run prompt limits.
        // A drain runs at most `maxCompile` compiler prompts.
        // A drain runs at most `maxFallback` confirmation prompts.
        let compileClaims = 0;
        let fallbackClaims = 0;
        // A cursor spent by an earlier truncated drain returns `cycle_exhausted` on the next pass's first poll.
        // The drain consumes one `cycle_exhausted` only before claiming work.
        // After the drain claims work, `cycle_exhausted` marks a real pass boundary.
        // The drain must not allocate phase quotas twice.
        let cycleResetConsumed = false;
        const maxCompile = args.maxCompilePerRun ?? MAX_COMPILE_PER_RUN;
        const maxFallback = args.maxFallbackPerRun ?? MAX_FALLBACK_PER_RUN;
        for (let i = 0; i < MAX_CLAIMS_PER_DRAIN; i++) {
            if (this.disposed || args.signal?.aborted || Date.now() >= args.deadline) break;
            const next = await this.next(args.signal, args.excludeBillable === true);
            if (next === "cycle_exhausted") {
                if (result.claimed === 0 && !cycleResetConsumed) {
                    cycleResetConsumed = true;
                    continue;
                }
                // The drain must not reset phase quotas after it exhausts its own cycle.
                result.drained = true;
                break;
            }
            if (next === "no_work") {
                result.drained = true;
                break;
            }
            if (next === "retry") continue;
            if (next === "stop") break;
            result.claimed += 1;
            if (this.disposed || args.signal?.aborted || !this.registration) {
                // dispose() or a failed heartbeat can remove the registration while next() is in flight.
                // Executing after registration loss can start a billable claim with no credentials to complete or abandon it.
                // If the registration is gone, abandon() relies on server-side lease expiry.
                this.lastAbandonReleased = await this.abandon(
                    next.claimId,
                    "registration lost during poll",
                );
                result.abandoned += 1;
                break;
            }
            if (next.snapshot.phase === "compile") {
                compileClaims += 1;
                if (compileClaims > maxCompile) {
                    this.lastAbandonReleased = await this.abandon(
                        next.claimId,
                        "compile cap reached this drain",
                    );
                    result.abandoned += 1;
                    break;
                }
            }
            if (next.snapshot.phase === "fallback") {
                // A repeated fallback note ends the drain without consuming a fallback budget slot.
                if (fallbackAttempted.has(next.noteId)) {
                    this.lastAbandonReleased = await this.abandon(
                        next.claimId,
                        "fallback already attempted this drain",
                    );
                    result.abandoned += 1;
                    break;
                }
                fallbackClaims += 1;
                if (fallbackClaims > maxFallback) {
                    this.lastAbandonReleased = await this.abandon(
                        next.claimId,
                        "fallback cap reached this drain",
                    );
                    result.abandoned += 1;
                    break;
                }
                fallbackAttempted.add(next.noteId);
            }
            const running = this.executeClaim(next, args);
            this.activeClaimSettled = running.then(
                () => undefined,
                () => undefined,
            );
            let done: Awaited<typeof running>;
            try {
                done = await running;
            } finally {
                this.activeClaimSettled = null;
            }
            if (done === "conflict") {
                // A conflict is counted as abandoned because the claim was not completed.
                result.abandoned += 1;
                continue;
            }
            if (done === "failed") break;
            if (done === "abandoned") {
                result.abandoned += 1;
                // The drain stops polling after `abandon()` cannot release a claim to avoid reclaiming the active phase.
                if (!this.lastAbandonReleased) break;
                continue;
            }
            result.completed += 1;
            if (done === "surfaced") result.surfaced += 1;
        }
        return result;
    }

    private async next(
        signal: AbortSignal | undefined,
        excludeBillable: boolean,
    ): Promise<ClaimResponse | "no_work" | "cycle_exhausted" | "retry" | "stop"> {
        const acquisitionId = this.pendingAcquisitionId ?? randomUUID();
        this.pendingAcquisitionId = acquisitionId;
        let response: Record<string, unknown>;
        try {
            response = asRecord(
                await this.deps.transport.call({
                    method: "note.evaluation.next",
                    body: this.claimBody({
                        acquisition_id: acquisitionId,
                        wait_ms: 0,
                        ...(excludeBillable ? { exclude_billable: true } : {}),
                    }),
                    signal,
                }),
            );
        } catch (error) {
            // The client retains the acquisition ID after an unknown outcome so the next poll recovers any durable decision instead of leasing a second note.
            this.logLine(`next failed (will replay acquisition): ${error}`);
            return "stop";
        }
        const result = response.result;
        if (result === "claim") {
            const snapshot = asRecord(response.snapshot);
            const phase = response.phase;
            if (
                typeof response.claim_id !== "string" ||
                typeof response.note_id !== "number" ||
                (phase !== "compile" &&
                    phase !== "due" &&
                    phase !== "liveness" &&
                    phase !== "fallback")
            ) {
                // The client retains the acquisition ID after an unknown outcome so the next poll can replay a durable decision.
                this.logLine("next returned a malformed claim (will replay acquisition)");
                return "stop";
            }
            this.pendingAcquisitionId = null;
            return {
                claimId: response.claim_id,
                noteId: response.note_id,
                snapshot: {
                    phase,
                    noteId: response.note_id,
                    content: typeof snapshot.content === "string" ? snapshot.content : "",
                    surfaceCondition:
                        typeof snapshot.surface_condition === "string"
                            ? snapshot.surface_condition
                            : null,
                    compiledCheck:
                        typeof snapshot.compiled_check === "string"
                            ? snapshot.compiled_check
                            : null,
                },
            };
        }
        if (result === "no_work") {
            // A recorded or replayed durable decision consumes the acquisition ID.
            this.pendingAcquisitionId = null;
            // The client resets the cursor on `cycle_exhausted` so deadline-truncated drains preserve the next pass; absent fields use the plain path.
            return response.cycle_exhausted === true ? "cycle_exhausted" : "no_work";
        }
        if (result === "expired") {
            // The client discards an expired replay acquisition ID and polls with a fresh ID because work availability is unknown.
            this.pendingAcquisitionId = null;
            return "retry";
        }
        if (
            result === "applied" ||
            result === "abandoned" ||
            result === "stale" ||
            result === "invalid"
        ) {
            // The client treats a lost claim response as unresolved until the client recovers the claim's terminal state.
            // A recovered terminal state (`completed`, `released`, or fenced by a note edit) replays its terminal kind.
            // Consume the acquisition ID after a terminal decision; retaining it would replay the decision forever and wedge the worker.
            this.pendingAcquisitionId = null;
            return "retry";
        }
        if (result === "authority_changed") {
            // Terminal replay and live authority transitions consume the acquisition, so the drain stops polling through the handover.
            this.pendingAcquisitionId = null;
            return "stop";
        }
        // `busy` records no durable decision. An unrecognized result retains the acquisition ID so the next poll can replay any durable decision instead of leasing a second note.
        if (result === "busy") return "stop";
        this.logLine(`next returned ${String(result)}`);
        return "stop";
    }

    private async executeClaim(
        claim: ClaimResponse,
        args: { deadline: number; signal?: AbortSignal },
    ): Promise<"completed" | "surfaced" | "abandoned" | "conflict" | "failed"> {
        const controller = new AbortController();
        this.activeClaimController = controller;
        const abortFromCaller = () => controller.abort(args.signal?.reason);
        if (args.signal?.aborted) abortFromCaller();
        else args.signal?.addEventListener("abort", abortFromCaller, { once: true });
        const renewTimer = setInterval(() => {
            void this.renew(claim.claimId, controller);
        }, this.claimRenewIntervalMs());
        if (typeof renewTimer.unref === "function") renewTimer.unref();
        try {
            const evaluated = await evaluateSmartNotePhase(
                claim.snapshot,
                this.deps.executors(claim.snapshot, controller.signal, args.deadline),
            );
            if (!evaluated.ok) {
                this.lastAbandonReleased = await this.abandon(claim.claimId, evaluated.reason);
                return "abandoned";
            }
            const response = asRecord(
                await this.deps.transport.call({
                    method: "note.evaluation.complete",
                    body: this.claimBody({
                        claim_id: claim.claimId,
                        completion_id: randomUUID(),
                        outcome: outcomeWire(evaluated.outcome),
                    }),
                }),
            );
            const result = response.result;
            if (result === "applied" || result === "replayed") {
                // `applied` returns the note payload flat, but `replayed` nests it under `response`; unwrap the replayed payload before reading its status.
                // Unwrapping the replayed payload prevents a replayed surface from being miscounted as a plain surface.
                // completion.
                const applied = result === "replayed" ? asRecord(response.response) : response;
                return applied.status === "ready" ? "surfaced" : "completed";
            }
            if (result === "stale" || result === "expired") {
                // A concurrent edit or dismissal can fence the claim, and a lapsed lease is terminal server-side; the drain can move to unrelated work.
                // A lapsed lease is terminal server-side, so the drain can move to unrelated work.
                this.logLine(`completion for note #${claim.noteId} superseded: ${String(result)}`);
                return "conflict";
            }
            this.logLine(`completion for note #${claim.noteId} rejected: ${String(result)}`);
            return "failed";
        } catch (error) {
            this.logLine(`claim ${claim.claimId} failed: ${error}`);
            this.lastAbandonReleased = await this.abandon(claim.claimId, String(error));
            return "abandoned";
        } finally {
            clearInterval(renewTimer);
            args.signal?.removeEventListener("abort", abortFromCaller);
            this.activeClaimController = null;
        }
    }

    private async renew(
        claimId: string,
        controller: AbortController,
        isRetry = false,
    ): Promise<void> {
        if (!this.registration || this.disposed || controller.signal.aborted) return;
        try {
            const response = asRecord(
                await this.deps.transport.call({
                    method: "note.evaluation.renew",
                    body: this.claimBody({ claim_id: claimId }),
                }),
            );
            if (response.result !== "renewed") {
                controller.abort(new Error(`claim renewal lost: ${String(response.result)}`));
            }
        } catch (error) {
            this.logLine(`renew failed: ${error}`);
            if (isRetry) {
                // Abort after the retry renewal fails to avoid billing work another drain may own.
                controller.abort(new Error("claim lease renewal failing"));
                return;
            }
            const retryTimer = setTimeout(() => {
                void this.renew(claimId, controller, true);
            }, 5_000);
            if (typeof retryTimer.unref === "function") retryTimer.unref();
        }
    }

    /**
     * expires.
     */
    private async abandon(claimId: string, reason: string): Promise<boolean> {
        this.logLine(`abandoning claim ${claimId}: ${reason.slice(0, 200)}`);
        try {
            const response = asRecord(
                await this.deps.transport.call({
                    method: "note.evaluation.abandon",
                    body: this.claimBody({ claim_id: claimId }),
                }),
            );
            const result = response.result;
            if (result === "abandoned" || result === "replayed") return true;
            this.logLine(`abandon for claim ${claimId} rejected: ${String(result)}`);
            return false;
        } catch (error) {
            this.logLine(`abandon failed (claim will expire): ${error}`);
            return false;
        }
    }
}
