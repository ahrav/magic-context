import { randomUUID } from "node:crypto";

import { log as defaultLog } from "../../../shared/logger";
import type { SmartNoteEvaluationOutcome } from "./evaluation-state";
import {
    evaluateSmartNotePhase,
    type SmartNotePhaseExecutors,
    type SmartNotePhaseSnapshot,
} from "./evaluator";
import { reserveSandboxSlot, type SandboxSlotReservation } from "./sandbox-runner";

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
    /** Build the phase executors for one claimed snapshot. Executors that run
     *  QuickJS must pass sandboxLockHeld and run inside `slot.run`. */
    executors: (
        snapshot: SmartNotePhaseSnapshot,
        slot: SandboxSlotReservation,
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
}

interface ClaimResponse {
    claimId: string;
    noteId: number;
    phase: SmartNotePhaseSnapshot["phase"];
    snapshot: SmartNotePhaseSnapshot;
}

const EVALUATOR_PROTOCOL_VERSION = "2.0";
const DEFAULT_HEARTBEAT_MS = 60_000;
const MAX_CLAIMS_PER_DRAIN = 25;

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
 * Client-initiated evaluator worker for the Rust note authority (protocol
 * v2.0, zero-wait polling). The worker owns explicit registration lifecycle:
 * availability exists only while registration and heartbeat are live, and a
 * host restart or route teardown withdraws it without any persisted state.
 */
export class SmartNoteEvaluatorWorker {
    private readonly deps: SmartNoteEvaluatorWorkerDeps;
    private readonly instanceId = randomUUID();
    private registration: Registration | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private pendingAcquisitionId: string | null = null;
    private disposed = false;

    constructor(deps: SmartNoteEvaluatorWorkerDeps) {
        this.deps = deps;
    }

    get registered(): boolean {
        return this.registration !== null;
    }

    private logLine(message: string): void {
        (this.deps.log ?? defaultLog)(`[smart-note-worker] ${message}`);
    }

    private fencedBody(extra: Record<string, unknown>): Record<string, unknown> {
        if (!this.registration) throw new Error("evaluator worker is not registered");
        return {
            v: 2,
            token: this.registration.token,
            registration_generation: this.registration.generation,
            evaluator_instance: this.instanceId,
            evaluator_slot: 0,
            ...extra,
        };
    }

    async register(signal?: AbortSignal): Promise<boolean> {
        if (this.disposed) return false;
        const policy = this.deps.policy();
        const response = asRecord(
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
        const token = response.token;
        const generation = response.registration_generation;
        if (typeof token !== "string" || typeof generation !== "number") {
            this.logLine(`registration rejected: ${JSON.stringify(response).slice(0, 200)}`);
            return false;
        }
        this.registration = { token, generation };
        this.startHeartbeat();
        return true;
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        const interval = this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
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
        if (!this.registration || this.disposed) return;
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
                this.registration = null;
                this.stopHeartbeat();
            }
        } catch (error) {
            this.logLine(`heartbeat failed: ${error}`);
        }
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
                    evaluator_slot: 0,
                },
            });
        } catch (error) {
            this.logLine(`unregister failed: ${error}`);
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.unregister();
    }

    /**
     * Zero-wait drain: poll for Rust-selected work until the authority reports
     * no_work, the deadline passes, or the signal aborts.
     */
    async drainOnce(args: { deadline: number; signal?: AbortSignal }): Promise<DrainResult> {
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
        for (let i = 0; i < MAX_CLAIMS_PER_DRAIN; i++) {
            if (this.disposed || args.signal?.aborted || Date.now() >= args.deadline) break;
            // The slot is reserved before requesting work so a granted claim
            // never waits behind another QuickJS execution.
            const slot = await reserveSandboxSlot();
            let claim: ClaimResponse | null = null;
            try {
                const next = await this.next(args.signal);
                if (next === "no_work") {
                    result.drained = true;
                    break;
                }
                if (next === "retry") continue;
                if (next === "stop") break;
                claim = next;
            } finally {
                if (!claim) slot.release();
            }
            result.claimed += 1;
            const done = await this.executeClaim(claim, slot, args);
            if (done === "abandoned") result.abandoned += 1;
            else if (done === "failed") break;
            else {
                result.completed += 1;
                if (done === "surfaced") result.surfaced += 1;
            }
        }
        return result;
    }

    private async next(
        signal?: AbortSignal,
    ): Promise<ClaimResponse | "no_work" | "retry" | "stop"> {
        const acquisitionId = this.pendingAcquisitionId ?? randomUUID();
        this.pendingAcquisitionId = acquisitionId;
        let response: Record<string, unknown>;
        try {
            response = asRecord(
                await this.deps.transport.call({
                    method: "note.evaluation.next",
                    body: this.fencedBody({ acquisition_id: acquisitionId, wait_ms: 0 }),
                    signal,
                }),
            );
        } catch (error) {
            // Unknown outcome: keep the acquisition id so the durable decision
            // is recovered instead of leasing a second note.
            this.logLine(`next failed (will replay acquisition): ${error}`);
            return "stop";
        }
        const result = response.result;
        if (result === "claim") {
            this.pendingAcquisitionId = null;
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
                return "stop";
            }
            return {
                claimId: response.claim_id,
                noteId: response.note_id,
                phase,
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
        this.pendingAcquisitionId = null;
        if (result === "no_work" || result === "expired") return "no_work";
        if (result === "busy") return "stop";
        this.logLine(`next returned ${String(result)}`);
        return "stop";
    }

    private async executeClaim(
        claim: ClaimResponse,
        slot: SandboxSlotReservation,
        args: { deadline: number; signal?: AbortSignal },
    ): Promise<"completed" | "surfaced" | "abandoned" | "failed"> {
        const controller = new AbortController();
        const abortFromCaller = () => controller.abort(args.signal?.reason);
        if (args.signal?.aborted) abortFromCaller();
        else args.signal?.addEventListener("abort", abortFromCaller, { once: true });
        const renewTimer = setInterval(() => {
            void this.renew(claim.claimId, controller);
        }, this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
        if (typeof renewTimer.unref === "function") renewTimer.unref();
        try {
            const evaluated = await evaluateSmartNotePhase(
                claim.snapshot,
                this.deps.executors(claim.snapshot, slot, controller.signal, args.deadline),
            );
            slot.release();
            if (!evaluated.ok) {
                await this.abandon(claim.claimId, evaluated.reason);
                return "abandoned";
            }
            const response = asRecord(
                await this.deps.transport.call({
                    method: "note.evaluation.complete",
                    body: this.fencedBody({
                        claim_id: claim.claimId,
                        completion_id: randomUUID(),
                        outcome: outcomeWire(evaluated.outcome),
                    }),
                }),
            );
            const result = response.result;
            if (result === "applied" || result === "replayed") {
                return response.status === "ready" ? "surfaced" : "completed";
            }
            this.logLine(`completion for note #${claim.noteId} rejected: ${String(result)}`);
            return "failed";
        } catch (error) {
            slot.release();
            this.logLine(`claim ${claim.claimId} failed: ${error}`);
            await this.abandon(claim.claimId, String(error));
            return "abandoned";
        } finally {
            clearInterval(renewTimer);
            args.signal?.removeEventListener("abort", abortFromCaller);
        }
    }

    private async renew(claimId: string, controller: AbortController): Promise<void> {
        if (!this.registration || this.disposed) return;
        try {
            const response = asRecord(
                await this.deps.transport.call({
                    method: "note.evaluation.renew",
                    body: this.fencedBody({ claim_id: claimId }),
                }),
            );
            if (response.result !== "renewed") {
                controller.abort(new Error(`claim renewal lost: ${String(response.result)}`));
            }
        } catch (error) {
            this.logLine(`renew failed: ${error}`);
        }
    }

    private async abandon(claimId: string, reason: string): Promise<void> {
        try {
            await this.deps.transport.call({
                method: "note.evaluation.abandon",
                body: this.fencedBody({ claim_id: claimId, reason: reason.slice(0, 200) }),
            });
        } catch (error) {
            this.logLine(`abandon failed (claim will expire): ${error}`);
        }
    }
}
