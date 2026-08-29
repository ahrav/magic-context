/**
 * Shared lifecycle ownership policy: the one place that composes data-root
 * resolution, filesystem admission, the platform gate, bootstrap trust, the
 * native lifecycle transaction, and demand-start coalescing.
 *
 * Ownership rules (KTD13/KTD17): only `managed-default` connection origin may
 * reach {@link McHostLifecyclePolicy.demandStart}; explicit connection files
 * and injected clients never construct a policy call. Concurrent managed
 * demands coalesce on one shared native start keyed by data root plus
 * capability; each caller races the shared promise against its own
 * signal/deadline, and a detaching caller never cancels the native work.
 *
 * Every operation returns one KTD12 v1 result object. Pre-native failures are
 * synthesized locally with the bounded no-follow root classifier; no raw
 * path, stderr text, or native error chain rides on any result.
 */

import type { CatalogEntry } from "../mc-host-client";
import { checkPlatform, type LifecycleFailureReason, type PlatformReaders } from "./bootstrap";
import {
    type CompatibilityVerdict,
    evaluateCompatibility,
    evaluateDaemonCompatibility,
    evaluateEpochCompatibility,
    evaluateModuleCompatibility,
    type ObservedEpochs,
} from "./compatibility";
import {
    classifyPreNativeRoots,
    type DaemonReadiness,
    type DaemonReason,
    type DaemonResultV1,
    type DaemonState,
    preNativeState,
    probeFallbackVerdict,
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

export type LifecycleCommand = "start" | "stop" | "restart" | "status" | "doctor";

export type StorageReadiness = "ready" | "starting" | "unavailable";

export type CompatibilityStage = "daemon" | "modules" | "epochs";

export interface CompatibilitySnapshot {
    authenticatedDaemonVersion: string;
    authenticatedDaemonId: Uint8Array;
    catalog: CatalogEntry[];
    epochs: ObservedEpochs;
    /** Last stage reached by the ordered authenticated compatibility probe. */
    evaluatedThrough?: CompatibilityStage;
}

export interface ObservationalHealth extends CompatibilitySnapshot {
    readiness: DaemonReadiness;
}

function compatibilityInput(snapshot: CompatibilitySnapshot): {
    authenticatedDaemonVer: string;
    catalog: CatalogEntry[];
    epochs: ObservedEpochs;
} {
    return {
        authenticatedDaemonVer: snapshot.authenticatedDaemonVersion,
        catalog: snapshot.catalog,
        epochs: snapshot.epochs,
    };
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
     */
    storageProbe?: (budgetMs: number) => Promise<StorageReadiness>;
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

function localResult(
    command: LifecycleCommand,
    ok: boolean,
    state: DaemonState,
    reason: DaemonReason,
): DaemonResultV1 {
    return {
        schema: "magic-context.daemon/v1",
        command,
        ok,
        state,
        reason,
        remediation: remediationForReason(reason),
        effects: command === "restart" ? { stop_committed: false, start_committed: false } : null,
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
    private readonly storageProbe: (budgetMs: number) => Promise<StorageReadiness>;
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
    private readonly outerAggregateMs: number;
    private readonly inflightStarts = new Map<string, Promise<DaemonResultV1>>();
    /** One in-flight compatibility probe per data root, keyed independently of capability. */
    private readonly inflightCompatibility = new Map<string, Promise<CompatibilitySnapshot>>();

    constructor(options: LifecyclePolicyOptions = {}) {
        this.env = options.env ?? process.env;
        this.launchTarget = options.launchTarget ?? null;
        this.bootstrapFailure = options.bootstrapFailure;
        this.platformReaders = options.platformReaders;
        this.admissionIo = options.admissionIo;
        this.storageProbe = options.storageProbe ?? (async () => "ready");
        this.compatibilityProbe = options.compatibilityProbe;
        this.readinessProbe = options.readinessProbe;
        this.payloadDir = options.payloadDir;
        this.payloadManifestDigest = options.payloadManifestDigest;
        this.payloadDirFallback = options.payloadDirFallback;
        this.defaultStartupEnvelope = options.defaultStartupEnvelope;
        this.outerAggregateMs = options.outerAggregateMs ?? OUTER_AGGREGATE_MS;
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
     * origin is accepted; the shared native start is keyed by data root plus
     * capability, callers race it against their own signal/deadline, and a
     * settled promise is evicted so no rejection becomes a permanent latch.
     * For the `magic-context` capability, the outcome additionally reports
     * storage readiness after waiting at most the 5-second hard budget.
     */
    async demandStart(request: DemandStartRequest): Promise<DemandStartOutcome> {
        if (!mayDemandStart(request.origin)) {
            throw new Error(`connection origin ${request.origin} is lifecycle-neutral`);
        }
        const waiterStartedAt = Date.now();
        const rootResolution = resolveLifecycleDataRoot(this.env);
        const key = `${rootResolution.ok ? rootResolution.root : "\u0000no-root"}\u0000${request.capability}`;
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
        const result = await this.raceWaiter(shared, request);
        if (!result.ok) {
            return { result, storage: null };
        }
        const remaining = (): number | undefined =>
            request.deadlineMs === undefined
                ? undefined
                : Math.max(0, request.deadlineMs - (Date.now() - waiterStartedAt));
        let remainingMs = remaining();
        if (remainingMs === 0) throw new WaiterDetachedError("deadline");
        let compatibleResult = result;
        let authenticatedDaemonId: Uint8Array | undefined;
        if (this.compatibilityProbe !== undefined) {
            const compatibilityBudget = remainingMs ?? this.outerAggregateMs;
            let snapshot: CompatibilitySnapshot;
            try {
                snapshot = await this.raceDetached(
                    this.sharedCompatibility(
                        rootResolution.ok ? rootResolution.root : "\u0000no-root",
                        Math.max(1, compatibilityBudget),
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
            authenticatedDaemonId = Uint8Array.from(snapshot.authenticatedDaemonId);
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
        const storage = await this.raceDetached(
            this.storageProbe(storageBudget),
            request.signal,
            remainingMs,
        );
        return { result: compatibleResult, storage, authenticatedDaemonId };
    }

    /**
     * One compatibility probe per data root in flight. The snapshot describes the
     * daemon incarnation, not the requesting capability, so concurrent demands
     * share one connection and one `catalog.list`/`host.status` pair instead of
     * each opening its own. The shared probe carries no caller signal; callers
     * bound their own wait with `raceDetached`, so one detaching caller cannot
     * cancel the probe another is still awaiting.
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

    private raceWaiter(
        shared: Promise<DaemonResultV1>,
        request: DemandStartRequest,
    ): Promise<DaemonResultV1> {
        const { signal, deadlineMs } = request;
        return this.raceDetached(shared, signal, deadlineMs);
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

    private preflight(
        command: LifecycleCommand,
    ): { ok: true; root: string } | { ok: false; result: DaemonResultV1 } {
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
                result: localResult(command, false, state, "unsupported_filesystem"),
            };
        }
        return { ok: true, root };
    }

    private async mutatingCommand(
        command: "start" | "stop" | "restart",
        startupEnvelope?: NativeStartupEnvelope,
    ): Promise<DaemonResultV1> {
        const preflight = this.preflight(command);
        if (!preflight.ok) return preflight.result;
        const platform = checkPlatform(this.platformReaders);
        if (!platform.ok) {
            const state = preNativeState(classifyPreNativeRoots(preflight.root));
            return localResult(command, false, state, "unsupported_platform");
        }
        if (this.bootstrapFailure !== undefined) {
            const state = preNativeState(classifyPreNativeRoots(preflight.root));
            return localResult(command, false, state, this.bootstrapFailure);
        }
        if (this.launchTarget === null) {
            const state = preNativeState(classifyPreNativeRoots(preflight.root));
            return localResult(command, false, state, "native_payload_missing");
        }
        try {
            const invoke = (payloadDir: string | undefined) =>
                runNativeLifecycle(this.launchTarget as NativeLaunchTarget, {
                    command: command as NativeLifecycleCommand,
                    deadlineMs: this.outerAggregateMs,
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
            let native = await invoke(selectedPayloadDir);
            if (
                command === "start" &&
                this.payloadDir === undefined &&
                native.reason === "native_payload_missing" &&
                this.payloadDirFallback !== undefined
            ) {
                const fallback = this.payloadDirFallback();
                if (fallback !== null) native = await invoke(fallback);
            }
            return { ...native, command };
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
            const deadline = Date.now() + this.outerAggregateMs;
            const native = await runNativeLifecycle(this.launchTarget, {
                command: "probe",
                deadlineMs: this.outerAggregateMs,
                env: this.nativeEnv(preflight.root),
            });
            if (!native.ok || native.state !== "running" || this.readinessProbe === undefined) {
                return { ...native, command };
            }
            const observed = await this.readinessProbe(Math.max(1, deadline - Date.now()));
            const { result: compatible, verdict: compatibility } = this.applyCompatibility(
                native,
                observed,
            );
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
            const readinessFailure = [
                checksById.get("readiness.transport"),
                checksById.get("readiness.storage"),
                checksById.get("readiness.synapse"),
            ].find((check) => check?.status === "fail");
            // Compatibility outranks readiness: an incompatible daemon explains
            // the component states, so its reason is the one an operator acts on.
            const failureReason = compatibility.ok
                ? readinessFailure?.reason
                : compatibility.reason;
            return {
                ...compatible,
                command,
                ok: failureReason === undefined,
                reason: failureReason ?? "healthy",
                remediation:
                    failureReason === undefined ? null : remediationForReason(failureReason),
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
        const verdict = evaluateCompatibility(compatibilityInput(snapshot));
        const stages: ReadonlyArray<{
            stage: CompatibilityStage;
            id: "compatibility.daemon" | "compatibility.modules" | "compatibility.epochs";
            verdict: CompatibilityVerdict;
        }> = [
            {
                stage: "daemon",
                id: "compatibility.daemon",
                verdict: evaluateDaemonCompatibility(snapshot.authenticatedDaemonVersion),
            },
            {
                stage: "modules",
                id: "compatibility.modules",
                verdict: evaluateModuleCompatibility(snapshot.catalog),
            },
            {
                stage: "epochs",
                id: "compatibility.epochs",
                verdict: evaluateEpochCompatibility(snapshot.epochs),
            },
        ];
        const stageOrder: Record<CompatibilityStage, number> = {
            daemon: 0,
            modules: 1,
            epochs: 2,
        };
        const evaluatedThrough = snapshot.evaluatedThrough ?? "epochs";
        const checksById = new Map(result.checks.map((check) => [check.id, check] as const));
        for (const stage of stages) {
            if (stageOrder[stage.stage] > stageOrder[evaluatedThrough]) continue;
            const reason = stage.verdict.ok ? "healthy" : stage.verdict.reason;
            checksById.set(stage.id, {
                id: stage.id,
                status: stage.verdict.ok ? "pass" : "fail",
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
                    daemon: snapshot.authenticatedDaemonVersion,
                    magic_context: moduleVersion("magic-context"),
                    synapse: moduleVersion("synapse"),
                    broca: moduleVersion("broca"),
                },
            },
        };
    }

    private nativeEnv(root: string): Record<string, string> {
        // Minimal explicit child environment: only the admitted absolute data
        // root travels, and only through the resolver variable the native
        // binary already honors.
        return { XDG_DATA_HOME: root };
    }

    private launchFailure(command: LifecycleCommand, root: string, error: unknown): DaemonResultV1 {
        const state = preNativeState(classifyPreNativeRoots(root));
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
                    return localResult(
                        command,
                        false,
                        state === "stopped" ? "stopped" : "wedged",
                        command === "stop" ? "shutdown_timeout" : "startup_timeout",
                    );
                case "spawn_failed":
                case "signal_exit":
                case "malformed_output":
                case "exit_disagreement":
                case "usage_error":
                    return localResult(command, false, state, "internal_error");
            }
        }
        return localResult(command, false, state, "internal_error");
    }
}
