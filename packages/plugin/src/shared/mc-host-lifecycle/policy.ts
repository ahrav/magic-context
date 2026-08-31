/**
 * `McHostLifecyclePolicy` owns data-root resolution, filesystem admission, platform gating, bootstrap trust, native lifecycle transactions, and demand-start coalescing.
 *
 * Only `managed-default` origins may call `McHostLifecyclePolicy.demandStart`.
 * Explicit connection files never call `McHostLifecyclePolicy.demandStart`.
 * Injected clients never call `McHostLifecyclePolicy.demandStart`.
 * Demand starts coalesce on one native start per data root.
 * Each caller races the shared promise against its own signal and deadline.
 * No caller cancels native work.
 *
 * Every operation returns one v1 result object.
 * Results are synthesized locally with the bounded no-follow root classifier.
 * Results contain no path, stderr text, or native error chain.
 */

import type { AuthenticatedPeer, CatalogEntry } from "../mc-host-client";
import { checkPlatform, type LifecycleFailureReason, type PlatformReaders } from "./bootstrap";
import {
    COMPATIBILITY_STAGES,
    type CompatibilityInput,
    type CompatibilityStage,
    type CompatibilityVerdict,
    compatibilityStageIndex,
    evaluateCompatibility,
    type ObservedEpochs,
} from "./compatibility";
import {
    classifyPreNativeRoots,
    type DaemonCheck,
    type DaemonCommand,
    type DaemonReadiness,
    type DaemonReason,
    type DaemonResultV1,
    type DaemonState,
    preNativeState,
    probeFallbackVerdict,
    reasonPrecedence,
    remediationForReason,
} from "./contract";
import { releaseContract } from "./generated-contract";
import {
    NativeLaunchError,
    type NativeLaunchTarget,
    type NativeLifecycleCommand,
    type NativeStartupEnvelope,
    runNativeLifecycle,
} from "./native-launcher";
import { type ConnectionOrigin, mayDemandStart } from "./ownership";
import { type AdmissionIo, admitLifecycleFilesystem, resolveLifecycleDataRoot } from "./paths";

/** Managed Magic Context demand waits at most 5,000 ms for storage. */
export const STORAGE_HARD_BUDGET_MS = 5_000;
/** Linux requests must reach authenticated transport within 60,000 ms. */
export const OUTER_AGGREGATE_MS = 60_000;
/**
 * macOS requests must reach authenticated transport within 15,000 ms.
 *
 * `release/mc-host-production-inputs.lock.json`
 * (`fresh_linux_transport_aggregate.hard`, `fresh_macos_transport_aggregate.hard`);
 */
export const OUTER_AGGREGATE_MS_DARWIN = 15_000;

/* */
export function aggregateForTarget(
    target: "linux-x64-gnu" | "darwin-arm64" | "darwin-x64",
): number {
    return target === "linux-x64-gnu" ? OUTER_AGGREGATE_MS : OUTER_AGGREGATE_MS_DARWIN;
}

export type LifecycleCommand = "start" | "stop" | "restart" | "status" | "doctor";

export type StorageReadiness = "ready" | "starting" | "unavailable";

export type { CompatibilityStage } from "./compatibility";

export interface CompatibilitySnapshot {
    authenticatedPeer: AuthenticatedPeer;
    /** Compatibility alias retained for callers reading the staged snapshot. */
    authenticatedDaemonVersion?: string;
    /** Compatibility alias retained for callers fencing from the staged snapshot. */
    authenticatedDaemonId?: Uint8Array;
    catalog: CatalogEntry[];
    epochs: ObservedEpochs;
    /** Last stage reached by the ordered authenticated compatibility probe. */
    evaluatedThrough?: CompatibilityStage;
}

export interface ObservationalHealth extends CompatibilitySnapshot {
    readiness: DaemonReadiness;
}

function compatibilityInput(snapshot: CompatibilitySnapshot): CompatibilityInput {
    return {
        authenticatedPeer: snapshot.authenticatedPeer,
        catalog: snapshot.catalog,
        epochs: snapshot.epochs,
    };
}

/**
 * Lifecycle budgets use a monotonic elapsed-time source.
 *
 * A backward wall-clock correction makes elapsed time negative.
 * A backward wall-clock correction can give the native child more than its platform aggregate.
 * A forward wall-clock correction can expire a live request early.
 * `Deadline`.
 *
 * `performance.now()` excludes suspended time.
 * NTP corrections.
 */
function monotonicNow(): number {
    return performance.now();
}

export class WaiterDetachedError extends Error {
    constructor(readonly cause_kind: "aborted" | "deadline") {
        super(`managed startup waiter detached: ${cause_kind}`);
        this.name = "WaiterDetachedError";
    }
}

export interface LifecyclePolicyOptions {
    env?: Record<string, string | undefined>;
    /**
     * Production uses a retained verified bootstrap descriptor as the trusted launch target.
     * Development and test use explicit test-only binary injection as the trusted launch target.
     * `null` means no trusted retained current-release bootstrap exists.
     * Without a trusted retained current-release bootstrap, observational commands use the no-probe classifier.
     * Without a trusted retained current-release bootstrap, mutating commands fail with the package-path reason.
     * Mutating commands receive a closed reason when pre-resolution fails.
     */
    launchTarget?: NativeLaunchTarget | null;
    /* */
    bootstrapFailure?: LifecycleFailureReason;
    platformReaders?: PlatformReaders;
    admissionIo?: AdmissionIo;
    /**
     * Managed Magic Context demand uses `probeFallbackVerdict` after transport.
     * The default readiness is `ready` for explicit and test-only policy instances.
     *
     * `expectedDaemonId` identifies the certified incarnation.
     * A probe that cannot observe `expectedDaemonId` must reject.
     * The caller fences its traffic to the certified identity.
     * Otherwise, the caller would act on readiness that its fenced traffic cannot reach.
     * An unset probe reports `unavailable`.
     * A default of `ready` would authorize application bodies against an unexamined daemon.
     * Explicit CLI flows never reach `demandStart`.
     */
    storageProbe?: (budgetMs: number, expectedDaemonId?: Uint8Array) => Promise<StorageReadiness>;
    /** Demand uses this authenticated daemon, catalog, and Magic Context epoch snapshot. */
    compatibilityProbe?: (budgetMs: number, signal?: AbortSignal) => Promise<CompatibilitySnapshot>;
    /** Status and doctor use this authenticated route-free component health. */
    readinessProbe?: (budgetMs: number) => Promise<ObservationalHealth>;
    /** Native start and restart receive this dev/test payload directory. */
    payloadDir?: string;
    /** This parent-trusted manifest digest is paired with `payloadDir`. */
    payloadManifestDigest?: string;
    /** Native current validation invokes this certified package lookup only when the package is missing. */
    payloadDirFallback?: () => string | null;
    /** CLI start and restart callers use this credential-only fallback. */
    defaultStartupEnvelope?: NativeStartupEnvelope;
    outerAggregateMs?: number;
}

/**
 *
 * `effectsKnown` is false when a native transaction may have committed effects.
 * `effectsKnown` is true when the native binary was never invoked.
 * A native transaction killed mid-flight has an unknown outcome.
 * Only failures with known effects may report `stop_committed` or `start_committed`.
 * A SIGKILLed restart reports `null` because `false` could falsely claim that the old incarnation still serves.
 * The stop may have committed before SIGKILL.
 */
function localResult(
    command: LifecycleCommand,
    ok: boolean,
    state: DaemonState,
    reason: DaemonReason,
    effectsKnown = true,
): DaemonResultV1 {
    return {
        schema: "magic-context.daemon/v1",
        command,
        ok,
        state,
        reason,
        remediation: remediationForReason(reason),
        effects:
            command === "restart" && effectsKnown
                ? { stop_committed: false, start_committed: false }
                : null,
        readiness: null,
        checks: [],
        versions: {
            release: releaseContract.release.version,
            proof: null,
            daemon: null,
            magic_context: null,
            synapse: null,
            broca: null,
        },
    };
}

/**
 * `TIMEOUT_REASON` maps each caller-facing command to the reason for a child killed at its deadline.
 * `status` and `doctor` run only a read-only probe.
 * A killed `status` or `doctor` probe leaves the daemon unobserved.
 * `status` and `doctor` do not leave the daemon mid-transaction.
 */
const TIMEOUT_REASON: Record<LifecycleCommand, DaemonReason> = {
    start: "startup_timeout",
    restart: "startup_timeout",
    stop: "shutdown_timeout",
    status: "native_probe_unavailable",
    doctor: "native_probe_unavailable",
};

export interface DemandStartRequest {
    origin: ConnectionOrigin;
    capability: "magic-context" | "synapse";
    signal?: AbortSignal;
    deadlineMs?: number;
    startupEnvelope?: NativeStartupEnvelope;
}

export interface DemandStartOutcome {
    result: DaemonResultV1;
    /**
     */
    storage: StorageReadiness | null;
    /* */
    authenticatedDaemonId?: Uint8Array;
}

export class McHostLifecyclePolicy {
    private readonly env: Record<string, string | undefined>;
    private readonly launchTarget: NativeLaunchTarget | null;
    private readonly bootstrapFailure: LifecycleFailureReason | undefined;
    private readonly platformReaders: PlatformReaders | undefined;
    private readonly admissionIo: AdmissionIo | undefined;
    private readonly storageProbe: (
        budgetMs: number,
        expectedDaemonId?: Uint8Array,
    ) => Promise<StorageReadiness>;
    private readonly compatibilityProbe:
        | ((budgetMs: number, signal?: AbortSignal) => Promise<CompatibilitySnapshot>)
        | undefined;
    private readonly readinessProbe:
        | ((budgetMs: number) => Promise<ObservationalHealth>)
        | undefined;
    private readonly payloadDir: string | undefined;
    private readonly payloadManifestDigest: string | undefined;
    private readonly payloadDirFallback: (() => string | null) | undefined;
    private readonly defaultStartupEnvelope: NativeStartupEnvelope | undefined;
    private readonly outerAggregateMs: number | undefined;
    private readonly inflightStarts = new Map<string, Promise<DaemonResultV1>>();
    /* */
    private readonly inflightCompatibility = new Map<string, Promise<CompatibilitySnapshot>>();

    constructor(options: LifecyclePolicyOptions = {}) {
        this.env = options.env ?? process.env;
        this.launchTarget = options.launchTarget ?? null;
        this.bootstrapFailure = options.bootstrapFailure;
        this.platformReaders = options.platformReaders;
        this.admissionIo = options.admissionIo;
        this.storageProbe = options.storageProbe ?? (async () => "unavailable");
        this.compatibilityProbe = options.compatibilityProbe;
        this.readinessProbe = options.readinessProbe;
        this.payloadDir = options.payloadDir;
        this.payloadManifestDigest = options.payloadManifestDigest;
        this.payloadDirFallback = options.payloadDirFallback;
        this.defaultStartupEnvelope = options.defaultStartupEnvelope;
        // On Darwin, `checkPlatform` can call `sw_vers`, so the constructor does not resolve the default.
        this.outerAggregateMs = options.outerAggregateMs;
    }

    /* */
    get inflightStartCount(): number {
        return this.inflightStarts.size;
    }

    async start(
        startupEnvelope: NativeStartupEnvelope | undefined = this.defaultStartupEnvelope,
    ): Promise<DaemonResultV1> {
        return this.mutatingCommand("start", startupEnvelope);
    }

    async stop(): Promise<DaemonResultV1> {
        return this.mutatingCommand("stop");
    }

    /* */
    async restart(
        startupEnvelope: NativeStartupEnvelope | undefined = this.defaultStartupEnvelope,
    ): Promise<DaemonResultV1> {
        return this.mutatingCommand("restart", startupEnvelope);
    }

    async status(): Promise<DaemonResultV1> {
        return this.observationalCommand("status");
    }

    async doctor(): Promise<DaemonResultV1> {
        return this.observationalCommand("doctor");
    }

    /**
     * `demandStart` coalesces starts by data root.
     * Each caller races the shared start against its own signal and deadline.
     * `demandStart` evicts settled promises so rejected starts do not become permanent latches.
     * For `magic-context`, `demandStart` reports storage readiness after the shared start.
     * `demandStart` waits at most 5 seconds for storage readiness.
     */
    async demandStart(request: DemandStartRequest): Promise<DemandStartOutcome> {
        if (!mayDemandStart(request.origin)) {
            throw new Error(`connection origin ${request.origin} is lifecycle-neutral`);
        }
        const startedAt = monotonicNow();
        // `demandStart` validates every caller before looking up the shared start.
        // A caller with no live interest must not create a start.
        // `start()` reaches `spawn()` before its first `await`.
        // `start()` would launch a mutating child with no waiting caller.
        // A caller joining an existing start must also have a finite positive deadline.
        // `raceWaiter` preserves `NaN` after subtracting elapsed time.
        // `setTimeout` coerces `NaN` and `Infinity` to a 1ms delay.
        // A non-finite deadline schedules detachment with a 1 ms delay.
        // A shared start that settles immediately can produce a result for an invalid deadline.
        // The same invalid request could resolve or reject based on whether a shared start is already in flight.
        //
        // Rejecting one caller does not cancel the shared start or affect other waiters.
        if (request.signal?.aborted) throw new WaiterDetachedError("aborted");
        if (
            request.deadlineMs !== undefined &&
            (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0)
        ) {
            throw new WaiterDetachedError("deadline");
        }
        const rootResolution = resolveLifecycleDataRoot(this.env);
        // `demandStart` keys starts by data root because `start()` has no capability argument.
        // One daemon serves all capabilities.
        // Keying by capability would launch a second native start.
        // The second start would collide with the first on the transaction lock.
        const key = rootResolution.ok ? rootResolution.root : "\u0000no-root";
        let shared = this.inflightStarts.get(key);
        if (!shared) {
            shared = this.start(request.startupEnvelope);
            this.inflightStarts.set(key, shared);
            void shared
                .catch(() => {})
                .finally(() => {
                    if (this.inflightStarts.get(key) === shared) this.inflightStarts.delete(key);
                });
        }
        const result = await this.raceWaiter(shared, request, startedAt);
        if (!result.ok) {
            return { result, storage: null };
        }
        const remaining = (): number | undefined =>
            request.deadlineMs === undefined
                ? undefined
                : Math.max(0, request.deadlineMs - (monotonicNow() - startedAt));
        let remainingMs = remaining();
        if (remainingMs === 0) throw new WaiterDetachedError("deadline");
        let compatibleResult = result;
        let authenticatedDaemonId: Uint8Array | undefined;
        if (this.compatibilityProbe !== undefined) {
            let snapshot: CompatibilitySnapshot;
            try {
                snapshot = await this.raceDetached(
                    this.sharedCompatibility(
                        rootResolution.ok ? rootResolution.root : "\u0000no-root",
                        this.compatibilityAggregateMs(),
                    ),
                    request.signal,
                    remainingMs,
                );
            } catch (error) {
                // A caller's deadline or signal detaches only that caller and throws a control outcome.
                // A probe failure produces a typed closed result.
                if (error instanceof WaiterDetachedError) throw error;
                return {
                    result: {
                        ...result,
                        ok: false,
                        reason: "native_probe_unavailable",
                        remediation: remediationForReason("native_probe_unavailable"),
                    },
                    storage: null,
                };
            }
            const applied = this.applyCompatibility(result, snapshot);
            compatibleResult = applied.result;
            if (!applied.verdict.ok) return { result: compatibleResult, storage: null };
            authenticatedDaemonId = Uint8Array.from(snapshot.authenticatedPeer.daemonId);
            remainingMs = remaining();
            if (remainingMs === 0) throw new WaiterDetachedError("deadline");
        }
        if (request.capability !== "magic-context") {
            return { result: compatibleResult, storage: null, authenticatedDaemonId };
        }
        const storageBudget =
            remainingMs === undefined
                ? STORAGE_HARD_BUDGET_MS
                : Math.min(STORAGE_HARD_BUDGET_MS, remainingMs);
        let storage: StorageReadiness;
        try {
            storage = await this.raceDetached(
                this.storageProbe(storageBudget, authenticatedDaemonId),
                request.signal,
                storageBudget,
            );
        } catch (error) {
            if (error instanceof WaiterDetachedError) throw error;
            // A failed storage observation only prevents this demand from publishing application traffic.
            // application traffic.
            return { result: compatibleResult, storage: "unavailable", authenticatedDaemonId };
        }
        return { result: compatibleResult, storage, authenticatedDaemonId };
    }

    /**
     * Only one compatibility probe per data root runs at a time.
     * The snapshot identifies the daemon incarnation, not the requesting capability.
     * Each caller bounds its wait with `raceDetached`; detaching cannot cancel the shared probe.
     *
     * The shared probe uses the policy aggregate rather than the creating caller's remaining deadline.
     * A nearly expired first waiter must not set a budget too short for long-lived waiters joining the probe.
     * Long-lived waiters could treat a truncated failure as unproven compatibility despite having sufficient time.
     */
    private sharedCompatibility(root: string, budgetMs: number): Promise<CompatibilitySnapshot> {
        const probe = this.compatibilityProbe;
        if (probe === undefined) {
            return Promise.reject(new Error("compatibility probe is unavailable"));
        }
        const existing = this.inflightCompatibility.get(root);
        if (existing) return existing;
        const shared = probe(budgetMs);
        this.inflightCompatibility.set(root, shared);
        const evict = (): void => {
            if (this.inflightCompatibility.get(root) === shared) {
                this.inflightCompatibility.delete(root);
            }
        };
        void shared.then(evict, evict);
        return shared;
    }

    private compatibilityAggregateMs(): number {
        if (this.outerAggregateMs !== undefined) return this.outerAggregateMs;
        const platform = checkPlatform(this.platformReaders);
        return platform.ok ? aggregateForTarget(platform.target) : OUTER_AGGREGATE_MS;
    }

    private raceDetached<T>(
        shared: Promise<T>,
        signal: AbortSignal | undefined,
        deadlineMs: number | undefined,
    ): Promise<T> {
        if (!signal && deadlineMs === undefined) return shared;
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const detach = (kind: "aborted" | "deadline"): void => {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                reject(new WaiterDetachedError(kind));
            };
            const onAbort = (): void => detach("aborted");
            if (signal) {
                if (signal.aborted) {
                    detach("aborted");
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
            }
            if (deadlineMs !== undefined) {
                if (deadlineMs <= 0) {
                    detach("deadline");
                    return;
                }
                timer = setTimeout(() => detach("deadline"), deadlineMs);
            }
            shared.then(
                (value) => {
                    if (settled) return;
                    settled = true;
                    if (timer !== null) clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    resolve(value);
                },
                (error: unknown) => {
                    if (settled) return;
                    settled = true;
                    if (timer !== null) clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    reject(error instanceof Error ? error : new Error(String(error)));
                },
            );
        });
    }

    private raceWaiter(
        shared: Promise<DaemonResultV1>,
        request: DemandStartRequest,
        startedAt: number,
    ): Promise<DaemonResultV1> {
        const { signal } = request;
        // `deadlineMs` starts at `startedAt`, including time before compatibility probing.
        // `deadlineMs` is measured from `startedAt` because `this.start()` performs synchronous root resolution, admission, and platform checks before returning its promise.
        const deadlineMs =
            request.deadlineMs === undefined
                ? undefined
                : request.deadlineMs - (monotonicNow() - startedAt);
        if (!signal && deadlineMs === undefined) return shared;
        return new Promise<DaemonResultV1>((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const detach = (kind: "aborted" | "deadline"): void => {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                // The shared native start continues after this waiter detaches.
                reject(new WaiterDetachedError(kind));
            };
            const onAbort = (): void => detach("aborted");
            if (signal) {
                if (signal.aborted) {
                    detach("aborted");
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
            }
            if (deadlineMs !== undefined) {
                // If `deadlineMs <= 0`, detach synchronously because a zero-delay timer runs after shared-promise microtasks and could resolve an expired waiter.
                if (deadlineMs <= 0) {
                    detach("deadline");
                    return;
                }
                timer = setTimeout(() => detach("deadline"), deadlineMs);
            }
            shared.then(
                (value) => {
                    if (settled) return;
                    settled = true;
                    if (timer !== null) clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    resolve(value);
                },
                (error: unknown) => {
                    if (settled) return;
                    settled = true;
                    if (timer !== null) clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    reject(error instanceof Error ? error : new Error(String(error)));
                },
            );
        });
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    /**
     * `preflight` performs the pre-native checks shared by every command.
     *
     * Observational commands must pass the platform gate because unsupported hosts lack a retained-descriptor exec path; probing or applying the no-probe classifier would report a daemon state for a host that cannot run the release.
     */
    private preflight(
        command: LifecycleCommand,
    ): { ok: true; root: string; deadlineMs: number } | { ok: false; result: DaemonResultV1 } {
        // `checkPlatform` can spend up to two seconds in `sw_vers`, so the child receives only the request-to-transport residual.
        const startedAt = monotonicNow();
        const rootResolution = resolveLifecycleDataRoot(this.env);
        if (!rootResolution.ok) {
            return { ok: false, result: localResult(command, false, "unavailable", "no_data_dir") };
        }
        const root = rootResolution.root;
        const admission = admitLifecycleFilesystem(root, this.admissionIo);
        if (!admission.ok) {
            const state = preNativeState(classifyPreNativeRoots(root));
            return {
                ok: false,
                result: localResult(command, false, state, admission.reason),
            };
        }
        const platform = checkPlatform(this.platformReaders);
        if (!platform.ok) {
            const state = preNativeState(classifyPreNativeRoots(root));
            return {
                ok: false,
                result: localResult(command, false, state, platform.reason),
            };
        }
        // `aggregateForTarget` uses `platform.target` because platform gating identifies the host target.
        const aggregate = this.outerAggregateMs ?? aggregateForTarget(platform.target);
        const deadlineMs = aggregate - (monotonicNow() - startedAt);
        if (deadlineMs <= 0) {
            // `preflight` returns the command timeout when it exhausts the budget; no child was spawned, so `restart` reports no committed effects.
            const state = preNativeState(classifyPreNativeRoots(root));
            return {
                ok: false,
                result: localResult(command, false, state, TIMEOUT_REASON[command]),
            };
        }
        return { ok: true, root, deadlineMs };
    }

    private async mutatingCommand(
        command: "start" | "stop" | "restart",
        startupEnvelope?: NativeStartupEnvelope,
    ): Promise<DaemonResultV1> {
        const preflight = this.preflight(command);
        if (!preflight.ok) return preflight.result;
        if (this.bootstrapFailure !== undefined) {
            const state = preNativeState(classifyPreNativeRoots(preflight.root));
            return localResult(command, false, state, this.bootstrapFailure);
        }
        if (this.launchTarget === null) {
            const state = preNativeState(classifyPreNativeRoots(preflight.root));
            return localResult(command, false, state, "native_payload_missing");
        }
        const launchTarget = this.launchTarget;
        try {
            // Each native invocation receives the residual deadline because the certified-package lookup and `native_payload_missing` fallback consume the request-to-transport aggregate; reusing `preflight.deadlineMs` would allow a second full budget.
            // qualified for.
            const startedAt = monotonicNow();
            const remaining = (): number => preflight.deadlineMs - (monotonicNow() - startedAt);
            const invoke = (payloadDir: string | undefined, deadlineMs: number) =>
                runNativeLifecycle(launchTarget, {
                    command: command as NativeLifecycleCommand,
                    deadlineMs,
                    env: this.nativeEnv(preflight.root),
                    ...(payloadDir !== undefined && command !== "stop" ? { payloadDir } : {}),
                    ...(command !== "stop" && this.payloadManifestDigest !== undefined
                        ? { payloadManifestDigest: this.payloadManifestDigest }
                        : {}),
                    ...(startupEnvelope === undefined || command === "stop"
                        ? {}
                        : { envelope: startupEnvelope }),
                });
            let selectedPayloadDir = this.payloadDir;
            if (
                command === "restart" &&
                selectedPayloadDir === undefined &&
                this.payloadDirFallback !== undefined
            ) {
                selectedPayloadDir = this.payloadDirFallback() ?? undefined;
            }
            const firstBudget = remaining();
            if (firstBudget <= 0) {
                // No child was spawned, so the command committed nothing.
                const state = preNativeState(classifyPreNativeRoots(preflight.root));
                return localResult(command, false, state, TIMEOUT_REASON[command]);
            }
            let native = await invoke(selectedPayloadDir, firstBudget);
            if (
                command === "start" &&
                this.payloadDir === undefined &&
                native.reason === "native_payload_missing" &&
                this.payloadDirFallback !== undefined
            ) {
                const fallback = this.payloadDirFallback();
                if (fallback !== null) {
                    const retryBudget = remaining();
                    // When no retry can start before the deadline, the fallback preserves the first launch result.
                    // timeout.
                    if (retryBudget > 0) native = await invoke(fallback, retryBudget);
                }
            }
            return this.relabel(native, command, command);
        } catch (error) {
            return this.launchFailure(command, preflight.root, error);
        }
    }

    private async observationalCommand(command: "status" | "doctor"): Promise<DaemonResultV1> {
        const preflight = this.preflight(command);
        if (!preflight.ok) return preflight.result;
        const platform = checkPlatform(this.platformReaders);
        if (!platform.ok) {
            const state = preNativeState(classifyPreNativeRoots(preflight.root));
            return localResult(command, false, state, "unsupported_platform");
        }
        if (this.launchTarget === null) {
            const verdict = probeFallbackVerdict(classifyPreNativeRoots(preflight.root));
            const ok = false;
            return localResult(command, ok, verdict.state, verdict.reason);
        }
        try {
            const startedAt = monotonicNow();
            const native = await runNativeLifecycle(this.launchTarget, {
                command: "probe",
                deadlineMs: preflight.deadlineMs,
                env: this.nativeEnv(preflight.root),
            });
            const relabeled = this.relabel(native, "status", command);
            if (
                !relabeled.ok ||
                relabeled.state !== "running" ||
                this.readinessProbe === undefined
            ) {
                return relabeled;
            }
            // The readiness probe uses the budget left by the native probe child.
            // Granting a 1ms floor would exceed the command deadline.
            const remaining = preflight.deadlineMs - (monotonicNow() - startedAt);
            if (remaining <= 0) return relabeled;
            // A readiness failure preserves a successful native observation.
            // Letting a readiness failure reach the outer `catch` would return `internal_error`.
            let observed: ObservationalHealth;
            try {
                observed = await this.readinessProbe(remaining);
            } catch {
                return relabeled;
            }
            const { result: compatible } = this.applyCompatibility(relabeled, observed);
            const checksById = new Map(
                compatible.checks.map((check) => [check.id, check] as const),
            );
            const addCheck = (
                id: "readiness.transport" | "readiness.storage" | "readiness.synapse",
                record: NonNullable<DaemonReadiness[keyof DaemonReadiness]>,
            ): void => {
                const status =
                    record.state === "ready"
                        ? "pass"
                        : record.state === "unsupported"
                          ? "skip"
                          : "fail";
                checksById.set(id, {
                    id,
                    status,
                    reason: record.reason,
                    remediation: remediationForReason(record.reason),
                });
            };
            if (observed.readiness.transport) {
                addCheck("readiness.transport", observed.readiness.transport);
            }
            if (observed.readiness.storage) {
                addCheck("readiness.storage", observed.readiness.storage);
            }
            if (observed.readiness.synapse) {
                addCheck("readiness.synapse", observed.readiness.synapse);
            }
            const checks = [...checksById.values()].sort((left, right) =>
                left.id.localeCompare(right.id),
            );
            // The v1 result requires lexicographically sorted unique check IDs.
            // The reported reason uses the failure-reason precedence list, not check-ID order.
            // A lower-precedence readiness failure cannot mask a higher-precedence failure.
            checks.sort((left, right) => left.id.localeCompare(right.id));
            const failed = checks
                .filter((check) => check.status === "fail")
                .reduce<DaemonCheck | undefined>((winner, check) => {
                    if (!winner) return check;
                    const winning = reasonPrecedence(winner.reason) ?? Number.MAX_SAFE_INTEGER;
                    const candidate = reasonPrecedence(check.reason) ?? Number.MAX_SAFE_INTEGER;
                    return candidate < winning ? check : winner;
                }, undefined);
            return {
                ...compatible,
                command,
                ok: failed === undefined,
                reason: failed?.reason ?? "healthy",
                remediation: failed?.remediation ?? null,
                readiness: observed.readiness,
                checks,
            };
        } catch (error) {
            return this.launchFailure(command, preflight.root, error);
        }
    }

    private applyCompatibility(
        result: DaemonResultV1,
        snapshot: CompatibilitySnapshot,
    ): { result: DaemonResultV1; verdict: CompatibilityVerdict } {
        const input = compatibilityInput(snapshot);
        const verdict = evaluateCompatibility(input);
        const evaluatedThroughIndex = compatibilityStageIndex(
            snapshot.evaluatedThrough ?? "epochs",
        );
        const checksById = new Map(result.checks.map((check) => [check.id, check] as const));
        for (const [index, stage] of COMPATIBILITY_STAGES.entries()) {
            // The result reports only stages the probe reached.
            // an unevaluated stage would assert an observation never made.
            if (index > evaluatedThroughIndex) continue;
            const stageVerdict = stage.evaluate(input);
            const reason = stageVerdict.ok ? "healthy" : stageVerdict.reason;
            checksById.set(stage.checkId, {
                id: stage.checkId,
                status: stageVerdict.ok ? "pass" : "fail",
                reason,
                remediation: remediationForReason(reason),
            });
        }
        const moduleVersion = (moduleId: string): string | null =>
            snapshot.catalog.find((entry) => entry.module_id === moduleId)?.module_version ?? null;
        return {
            verdict,
            result: {
                ...result,
                ok: result.ok && verdict.ok,
                reason: verdict.ok ? result.reason : verdict.reason,
                remediation: verdict.ok ? result.remediation : remediationForReason(verdict.reason),
                checks: [...checksById.values()].sort((left, right) =>
                    left.id.localeCompare(right.id),
                ),
                versions: {
                    ...result.versions,
                    proof: "current",
                    daemon: snapshot.authenticatedPeer.daemonVer,
                    magic_context: moduleVersion("magic-context"),
                    synapse: moduleVersion("synapse"),
                    broca: moduleVersion("broca"),
                },
            },
        };
    }

    /**
     *
     *
     */
    private relabel(
        native: DaemonResultV1,
        expected: DaemonCommand,
        command: LifecycleCommand,
    ): DaemonResultV1 {
        if (native.command !== expected) {
            return localResult(command, false, "wedged", "internal_error", false);
        }
        return { ...native, command };
    }

    private nativeEnv(root: string): Record<string, string> {
        return { XDG_DATA_HOME: root };
    }

    private launchFailure(command: LifecycleCommand, root: string, error: unknown): DaemonResultV1 {
        const state = preNativeState(classifyPreNativeRoots(root));
        // The launcher-provided lifecycle reason takes precedence over an error-code-derived reason.
        if (
            error !== null &&
            typeof error === "object" &&
            "reason" in error &&
            [
                "unsupported_platform",
                "unsupported_install_layout",
                "native_payload_missing",
                "native_payload_invalid",
                "insufficient_storage",
                "internal_error",
            ].includes(String((error as { reason?: unknown }).reason))
        ) {
            return localResult(
                command,
                false,
                state,
                (error as { reason: LifecycleFailureReason }).reason,
            );
        }
        if (error instanceof NativeLaunchError) {
            switch (error.code) {
                case "timeout":
                    return localResult(command, false, state, TIMEOUT_REASON[command], false);
                case "unsupported_platform":
                    return localResult(command, false, state, "unsupported_platform");
                case "signal_exit":
                case "output_cap_exceeded":
                case "exit_disagreement":
                case "malformed_output":
                    // The child's effects are unknown after signal exit, output-cap exhaustion, or invalid result reporting.
                    return localResult(command, false, state, "internal_error", false);
                case "spawn_failed":
                case "usage_error":
                    return localResult(command, false, state, "internal_error");
            }
        }
        return localResult(command, false, state, "internal_error");
    }
}
