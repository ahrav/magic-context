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
     * Build the phase executors for one claimed snapshot. Executors run QuickJS
     * through `runCompiledSmartNoteCheck` without `sandboxLockHeld`, so each
     * sandbox execution serializes itself for exactly its own window. The worker
     * deliberately holds no process-wide sandbox reservation across a claim: a
     * claim lease outlives a bounded QuickJS run by orders of magnitude, so
     * waiting behind one run is cheap, whereas holding the global slot across an
     * LLM compile or fallback confirmation would stall every other project's
     * sweep for the length of a network round-trip.
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
    /** Whether the most recent abandon actually released the claim. */
    private lastAbandonReleased = true;
    /** Abort handle for the claim currently executing, if any. */
    private activeClaimController: AbortController | null = null;
    /** Settlement of the claim currently executing; never rejects. */
    private activeClaimSettled: Promise<void> | null = null;
    /** Tail of the drain queue; drains run strictly one at a time. */
    private drainChain: Promise<void> = Promise.resolve();

    constructor(deps: SmartNoteEvaluatorWorkerDeps) {
        this.deps = deps;
    }

    get registered(): boolean {
        return this.registration !== null;
    }

    /**
     * Claim-renewal cadence. An explicit dependency override wins for tests;
     * otherwise follow the cadence the authority published at registration so a
     * lease change on the Rust side cannot silently outrun the client.
     */
    private claimRenewIntervalMs(): number {
        return this.deps.heartbeatMs ?? this.registration?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    }

    private logLine(message: string): void {
        (this.deps.log ?? defaultLog)(`[smart-note-worker] ${message}`);
    }

    /**
     * Registration-identity fence accepted by every fenced method. The module
     * validates each method against a closed field set, so this carries only the
     * fields common to all of them; claim-scoped calls add `evaluator_slot`
     * through {@link claimBody}.
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

    /** Fence for the claim-scoped methods (next/renew/complete/abandon). */
    private claimBody(extra: Record<string, unknown>): Record<string, unknown> {
        return this.fencedBody({ evaluator_slot: EVALUATOR_SLOT, ...extra });
    }

    async register(signal?: AbortSignal): Promise<boolean> {
        if (this.disposed) return false;
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
            // A transient transport failure stays local: callers treat false as
            // "unavailable, retry on the next drain", while a throw here would
            // propagate out of drainOnce and abort the caller's whole sweep tick.
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
            // Disposal raced the in-flight registration. Installing the token
            // would start a heartbeat that keeps the module advertising an
            // evaluator no drain path will ever service; release it instead.
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
        // Follow the authority's published renewal cadence; fall back only when
        // the field is absent so the lease and the client cannot drift apart.
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
                this.dropRegistration();
            }
        } catch (error) {
            // A throw is the module's error-frame path (bad_request,
            // registration_unknown after a module restart), which means the lease
            // is not renewed. Retaining the registration here would make
            // `registered` report a liveness the module has already dropped and
            // would stop `drainOnce` from ever re-registering.
            this.logLine(`heartbeat failed; dropping registration: ${error}`);
            this.dropRegistration();
        }
    }

    private dropRegistration(): void {
        this.registration = null;
        this.stopHeartbeat();
        // Without credentials the running claim can neither complete nor
        // abandon (claimBody requires a registration), so letting its executor
        // finish only burns the prompt; the claim replays after re-registration.
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
        // Abort in-flight claim work and wait for its terminal release while
        // the registration is still live: unregistering first would strand the
        // claim active until lease expiry with its executor still running.
        this.activeClaimController?.abort(new Error("evaluator worker disposed"));
        await this.activeClaimSettled;
        await this.unregister();
    }

    /**
     * Zero-wait drain: poll for Rust-selected work until the authority reports
     * no_work, the deadline passes, or the signal aborts.
     */
    async drainOnce(args: { deadline: number; signal?: AbortSignal }): Promise<DrainResult> {
        // Serialize drains: the timer sweep, the scheduled dreamer task, and a
        // manual /ctx-dream can all reach this worker concurrently, and the
        // acquisition id, evaluator slot 0, and active-claim fields are shared
        // per-instance state. Interleaved drains would replay one durable
        // claim into two executors.
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
        // A false fallback confirmation leaves the note pending with
        // check_status='fallback', and fallback selection has no next-due gate,
        // so the authority re-selects the same note on the very next poll. One
        // confirmation prompt per note per drain bounds the billable loop.
        const fallbackAttempted = new Set<number>();
        // The authority's per-poll selection caps only truncate one candidate
        // list; each subsequent poll admits the next note. Enforce the same
        // caps across the whole drain so one pass launches at most
        // MAX_COMPILE_PER_RUN compiler prompts and MAX_FALLBACK_PER_RUN
        // confirmation prompts, matching the legacy sweep's per-run bounds.
        let compileClaims = 0;
        let fallbackClaims = 0;
        for (let i = 0; i < MAX_CLAIMS_PER_DRAIN; i++) {
            if (this.disposed || args.signal?.aborted || Date.now() >= args.deadline) break;
            const next = await this.next(args.signal);
            if (next === "no_work") {
                result.drained = true;
                break;
            }
            if (next === "retry") continue;
            if (next === "stop") break;
            result.claimed += 1;
            if (next.snapshot.phase === "compile") {
                compileClaims += 1;
                if (compileClaims > MAX_COMPILE_PER_RUN) {
                    this.lastAbandonReleased = await this.abandon(
                        next.claimId,
                        "compile cap reached this drain",
                    );
                    result.abandoned += 1;
                    break;
                }
            }
            if (next.snapshot.phase === "fallback") {
                fallbackClaims += 1;
                if (fallbackClaims > MAX_FALLBACK_PER_RUN || fallbackAttempted.has(next.noteId)) {
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
            if (done === "failed") break;
            if (done === "abandoned") {
                result.abandoned += 1;
                // A claim we could not terminally release is still active, so the
                // authority would hand the same phase back on the next poll.
                // Stop instead of re-running it until the lease expires.
                if (!this.lastAbandonReleased) break;
                continue;
            }
            result.completed += 1;
            if (done === "surfaced") result.surfaced += 1;
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
                    body: this.claimBody({ acquisition_id: acquisitionId, wait_ms: 0 }),
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
                // The authority already granted a durable claim under this
                // acquisition id. Keep the id so the next poll replays that
                // decision instead of minting a fresh UUID and stranding the
                // leased note until its lease expires.
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
        this.pendingAcquisitionId = null;
        if (result === "no_work" || result === "expired") return "no_work";
        if (result === "busy") return "stop";
        this.logLine(`next returned ${String(result)}`);
        return "stop";
    }

    private async executeClaim(
        claim: ClaimResponse,
        args: { deadline: number; signal?: AbortSignal },
    ): Promise<"completed" | "surfaced" | "abandoned" | "failed"> {
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
                // `applied` returns the note payload flat; `replayed` nests the
                // recovered payload under `response`, so unwrap before reading
                // the status or a replayed surface is miscounted as a plain
                // completion.
                const applied = result === "replayed" ? asRecord(response.response) : response;
                return applied.status === "ready" ? "surfaced" : "completed";
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

    private async renew(claimId: string, controller: AbortController): Promise<void> {
        if (!this.registration || this.disposed) return;
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
        }
    }

    /**
     * Terminally release a claim. `reason` is local telemetry only: the module's
     * abandon schema is closed and carries no reason field, so sending it would
     * reject the release and leave the claim to be re-handed out until its lease
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
