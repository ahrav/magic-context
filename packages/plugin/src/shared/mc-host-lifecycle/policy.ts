/**
 * Shared lifecycle ownership policy: the one place that composes data-root
 * resolution, filesystem admission, the platform gate, bootstrap trust, the
 * native lifecycle transaction, and demand-start coalescing.
 *
 * Ownership rules (KTD13/KTD17): only `managed-default` connection origin may
 * reach {@link McHostLifecyclePolicy.demandStart}; explicit connection files
 * and injected clients never construct a policy call. Concurrent managed
 * demands coalesce on one shared native start keyed by data root; each caller
 * races the shared promise against its own signal/deadline, and a detaching
 * caller never cancels the native work.
 *
 * Every operation returns one KTD12 v1 result object. Pre-native failures are
 * synthesized locally with the bounded no-follow root classifier; no raw
 * path, stderr text, or native error chain rides on any result.
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

/** Managed Magic Context demand waits at most this long for storage (R11). */
export const STORAGE_HARD_BUDGET_MS = 5_000;
/** Fresh Linux request-to-authenticated-transport outer aggregate (hard). */
export const OUTER_AGGREGATE_MS = 60_000;
export function aggregateForTarget(_target: "linux-x64-gnu"): number {
    return OUTER_AGGREGATE_MS;
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
 * Elapsed-time source for every lifecycle budget.
 *
 * `Date.now()` is a wall clock and can step in either direction: a backward
 * correction makes elapsed time negative and hands the native child more than
 * its platform's qualified aggregate, while a forward correction expires a live
 * request that has barely started. Budgets are durations, so they are measured
 * on a monotonic timeline — the same basis, and the same reason, as the client's
 * `Deadline`.
 *
 * `performance.now()` does not advance across system suspend. That is the right
 * trade here: it can never over-grant, and expiring on resume would need an
 * explicit second signal rather than a clock that also jumps for timezone and
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
     * The trusted launch target for native lifecycle commands: a retained
     * verified bootstrap descriptor in production, or the explicit test-only
     * binary injection used by this repo's dev/test path. `null` means no
     * trusted retained current-release bootstrap exists, so observational
     * commands use the no-probe classifier and mutating commands fail with
     * the package-path reason.
     */
    launchTarget?: NativeLaunchTarget | null;
    /** Pre-resolve failure for mutating commands, already reduced to a closed reason. */
    bootstrapFailure?: LifecycleFailureReason;
    platformReaders?: PlatformReaders;
    admissionIo?: AdmissionIo;
    /**
     * Post-transport storage probe used by managed Magic Context demand.
     * The default reports `ready` for explicit and test-only policy instances.
     *
     * `expectedDaemonId` is the incarnation compatibility just certified. A probe
     * that cannot observe that incarnation must reject rather than report a
     * reading from another one, because the caller fences its traffic to the
     * certified identity and would act on readiness it will never reach.
     * U4 wires the real Magic Context status call. There is no
     * permissive default: an unset probe reports `unavailable`, because a
     * default of `ready` would authorize application bodies against a daemon
     * whose storage state was never examined. Explicit CLI flows are
     * unaffected — they never reach `demandStart`.
     */
    storageProbe?: (budgetMs: number, expectedDaemonId?: Uint8Array) => Promise<StorageReadiness>;
    /** Authenticated daemon, catalog, and Magic Context epoch snapshot for demand. */
    compatibilityProbe?: (budgetMs: number, signal?: AbortSignal) => Promise<CompatibilitySnapshot>;
    /** Authenticated route-free component health for status and doctor. */
    readinessProbe?: (budgetMs: number) => Promise<ObservationalHealth>;
    /** Dev/test payload directory forwarded to native start/restart. */
    payloadDir?: string;
    /** Parent-trusted payload manifest digest paired with `payloadDir`. */
    payloadManifestDigest?: string;
    /** Deferred certified package lookup after native current validation says missing. */
    payloadDirFallback?: () => string | null;
    /** Credential-only fallback used by CLI start/restart callers. */
    defaultStartupEnvelope?: NativeStartupEnvelope;
    outerAggregateMs?: number;
}

/**
 * Synthesize a pre-native v1 result.
 *
 * `effectsKnown` distinguishes a failure that provably committed nothing —
 * the native binary was never invoked — from one whose native transaction was
 * killed mid-flight and whose outcome is therefore unknown. Only the former
 * may state `stop_committed`/`start_committed`; the latter reports `null`,
 * because asserting `false` for a SIGKILLed restart would tell an operator the
 * old incarnation is still serving when the stop may already have committed.
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
 * Reason for a native command whose child was killed at the deadline, keyed by
 * the caller-facing command. `status` and `doctor` run no startup or shutdown:
 * the killed child was the read-only probe, so the daemon was left unobserved
 * rather than left mid-transaction.
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
     * Storage readiness at return time for `magic-context` capability.
     * Callers must send no Rust application body unless this is `ready`.
     */
    storage: StorageReadiness | null;
    /** Authenticated incarnation that passed compatibility; bind application traffic to it. */
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
    /** One in-flight compatibility probe per data root, keyed independently of capability. */
    private readonly inflightCompatibility = new Map<string, Promise<CompatibilitySnapshot>>();

    constructor(options: LifecyclePolicyOptions = {}) {
        this.env = options.env ?? process.env;
        this.launchTarget = options.launchTarget ?? null;
        this.bootstrapFailure = options.bootstrapFailure;
        this.platformReaders = options.platformReaders;
        this.admissionIo = options.admissionIo;
        // Fail closed: an unwired probe must not assert readiness.
        this.storageProbe = options.storageProbe ?? (async () => "unavailable");
        this.compatibilityProbe = options.compatibilityProbe;
        this.readinessProbe = options.readinessProbe;
        this.payloadDir = options.payloadDir;
        this.payloadManifestDigest = options.payloadManifestDigest;
        this.payloadDirFallback = options.payloadDirFallback;
        this.defaultStartupEnvelope = options.defaultStartupEnvelope;
        this.outerAggregateMs = options.outerAggregateMs;
    }

    /** Count of live coalesced startups; test observability only. */
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

    /** One native restart transaction; never emulated as TS stop+start. */
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
     * Managed demand-start with KTD17 coalescing. Only `managed-default`
     * origin is accepted; the shared native start is keyed by data root,
     * callers race it against their own signal/deadline, and a settled promise
     * is evicted so no rejection becomes a permanent latch. For the
     * `magic-context` capability, the outcome additionally reports storage
     * readiness after waiting at most the 5-second hard budget.
     */
    async demandStart(request: DemandStartRequest): Promise<DemandStartOutcome> {
        if (!mayDemandStart(request.origin)) {
            throw new Error(`connection origin ${request.origin} is lifecycle-neutral`);
        }
        const startedAt = monotonicNow();
        // Validated at entry, for every caller, before the shared start is even
        // looked up. A caller with no live interest must not create a start —
        // `start()`'s synchronous prefix reaches `spawn()` before any await, so
        // it would launch a mutating child nobody is waiting for. And a caller
        // *joining* an existing start must not be admitted either: `raceWaiter`
        // subtracts elapsed time and `NaN` stays `NaN`, while `setTimeout`
        // coerces both `NaN` and `Infinity` to a 1ms delay, so a non-finite
        // budget yields either a ~1ms detach or — if the shared start settles
        // within one microtask drain — a result adopted on an invalid budget.
        // Identical input would then resolve or reject depending only on whether
        // another demand happened to be in flight.
        //
        // Rejecting a caller is not cancelling: the shared promise stays in the
        // map untouched, so every other waiter is unaffected, which is the
        // detach-only guarantee this design actually requires.
        if (request.signal?.aborted) throw new WaiterDetachedError("aborted");
        if (
            request.deadlineMs !== undefined &&
            (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0)
        ) {
            throw new WaiterDetachedError("deadline");
        }
        const rootResolution = resolveLifecycleDataRoot(this.env);
        // The data root alone identifies the host: `start()` takes no
        // capability and one daemon serves them all, so keying on capability
        // would launch a second native start that only collides with the
        // first on the transaction lock.
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
                // Detachment is the caller's own deadline or signal and stays a
                // thrown control outcome. Any other probe failure is an unproven
                // compatibility claim, so it becomes a typed closed result rather
                // than an unclassified rejection callers cannot act on.
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
            // Compatibility is already proven. A failed storage observation
            // cannot erase that proof; it only means this demand may not publish
            // application traffic.
            return { result: compatibleResult, storage: "unavailable", authenticatedDaemonId };
        }
        return { result: compatibleResult, storage, authenticatedDaemonId };
    }

    /**
     * One compatibility probe per data root in flight. The snapshot describes the
     * daemon incarnation, not the requesting capability, so concurrent demands
     * share one connection and one `catalog.list`/`host.status` pair instead of
     * each opening its own. The shared probe carries no caller signal; callers
     * bound their own wait with `raceDetached`, so one detaching caller cannot
     * cancel the probe another is still awaiting.
     *
     * Its budget is the policy's own aggregate, never the creating caller's
     * remaining deadline: a nearly expired waiter arriving first would otherwise
     * mint a probe too short for the long-lived waiters that join it, and they
     * would read that truncated failure as an unproven compatibility claim while
     * still holding ample time.
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
        // Subtract elapsed preflight time so it counts against the caller's deadline.
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
                // Detachment only: the shared native start keeps running for
                // other and later waiters.
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
                // An already-expired budget detaches here: a timer of 0 fires
                // in a later macrotask, so an already-settled shared start
                // would resolve this waiter through the microtask queue first
                // and hand it a result it had no time left to wait for.
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
    // Shared preflight and native invocation.
    // ------------------------------------------------------------------

    /**
     * Root resolution, filesystem admission, and the platform gate: the
     * pre-native checks every command shares.
     *
     * Observational commands gate on the platform too. A host outside the
     * supported target table has no retained-descriptor exec path, so probing
     * it or answering with the no-probe classifier would report a daemon state
     * for a host the release cannot run on at all.
     */
    private preflight(
        command: LifecycleCommand,
    ): { ok: true; root: string; deadlineMs: number } | { ok: false; result: DaemonResultV1 } {
        // Preflight cost counts against the request-to-transport aggregate.
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
        // The gate already resolved which qualified target this host is, so the
        // aggregate comes from that rather than from a Linux-shaped default.
        const aggregate = this.outerAggregateMs ?? aggregateForTarget(platform.target);
        const deadlineMs = aggregate - (monotonicNow() - startedAt);
        if (deadlineMs <= 0) {
            // Preflight consumed the whole budget, so the operation is out of
            // time before the child exists. That is this command's timeout, not
            // an internal error: nothing was spawned, so a restart reports no
            // committed effects rather than unknown ones.
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
            // The aggregate is one request-to-transport bound for the whole
            // command, not per native invocation. The certified-package lookup
            // and a first launch that answers `native_payload_missing` both spend
            // from it, so each invocation gets the residual. Handing
            // `preflight.deadlineMs` to both would let a fallback retry run a
            // second full aggregate — twice the budget the platform was
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
                // The lookup consumed the command's budget before any child
                // existed, so nothing was spawned and nothing committed.
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
                    // With no budget left the retry cannot be attempted, and the
                    // first launch already answered. Reporting its real result
                    // beats replacing a completed observation with a synthetic
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
            // No trusted retained current-release bootstrap: only the bounded
            // no-follow classifier may speak, and it authorizes nothing.
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
            // The readiness probe shares the command's aggregate with the probe
            // child that just ran, so it gets only what that child left behind.
            // An exhausted budget means there is nothing left to observe with:
            // granting a 1ms floor would start a probe that can only fail.
            const remaining = preflight.deadlineMs - (monotonicNow() - startedAt);
            if (remaining <= 0) return relabeled;
            // A readiness failure must not erase an observation that already
            // succeeded. Letting it reach the outer `catch` would answer
            // `internal_error` for a daemon this call verifiably observed, so it
            // degrades to the native result — the same rule `boundedStorageProbe`
            // applies to a storage probe that expires or throws.
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
            // The check list is ordered by id because the v1 result requires
            // lexicographically sorted unique check ids. The reported reason is
            // NOT that order: the release contract ships one precedence list for
            // failing reasons, and a lower-precedence readiness failure must
            // never mask a higher-precedence one just because its check id
            // sorts earlier (`readiness.storage` before `readiness.transport`).
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
            // Only stages the probe actually reached are reported; a check for
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
     * Restamp a native result with the caller-facing command, first proving the
     * child answered the command this call is willing to accept.
     *
     * `parseDaemonResult` validates the restart-only `effects` invariant
     * against the child's own `command`, so blindly overwriting that field can
     * publish a `restart` result carrying `effects` under a `stop` or `start`
     * label. A disagreement means the child answered a different command than
     * requested — a real version-skew signal — so it becomes `internal_error`
     * rather than being silently relabeled.
     *
     * `expected` is the command the child must *report*, which is not always the
     * argv it was *sent*. Observational commands send the `probe` argv, but the
     * contract's command union is exactly start/stop/restart/status/doctor, so
     * the binary answers the read-only observation as `status` and a `probe`
     * response would be rejected by every contract-validating consumer.
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
        // Minimal explicit child environment: only the admitted absolute data
        // root travels, and only through the resolver variable the native
        // binary already honors.
        return { XDG_DATA_HOME: root };
    }

    private launchFailure(command: LifecycleCommand, root: string, error: unknown): DaemonResultV1 {
        const state = preNativeState(classifyPreNativeRoots(root));
        // A launcher that already reduced the failure to a closed lifecycle
        // reason speaks for itself; re-deriving one from the error code would
        // discard the more specific classification it made.
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
                    // The child was SIGKILLed mid-flight, so whatever it had
                    // committed is unknown, not `false`.
                    return localResult(command, false, state, TIMEOUT_REASON[command], false);
                case "unsupported_platform":
                    // The platform has no retained-descriptor exec path; the
                    // binary was never invoked, so nothing committed.
                    return localResult(command, false, state, "unsupported_platform");
                case "signal_exit":
                case "output_cap_exceeded":
                case "exit_disagreement":
                case "malformed_output":
                    // The child ran and was cut short or disagreed with itself;
                    // its effects are equally unknown.
                    return localResult(command, false, state, "internal_error", false);
                case "spawn_failed":
                case "usage_error":
                    // The binary never ran, or rejected its invocation before
                    // touching anything, so nothing committed.
                    return localResult(command, false, state, "internal_error");
            }
        }
        return localResult(command, false, state, "internal_error");
    }
}
