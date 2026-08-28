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

import { checkPlatform, type PlatformReaders } from "./bootstrap";
import {
    classifyPreNativeRoots,
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
    platformReaders?: PlatformReaders;
    admissionIo?: AdmissionIo;
    /**
     * Post-transport storage probe used by managed Magic Context demand.
     * U4 wires the real Magic Context status call. There is deliberately no
     * permissive default: an unset probe reports `unavailable`, because a
     * default of `ready` would authorize application bodies against a daemon
     * whose storage state was never examined. Explicit CLI flows are
     * unaffected — they never reach `demandStart`.
     */
    storageProbe?: (budgetMs: number) => Promise<StorageReadiness>;
    /** Dev/test payload directory forwarded to native start/restart. */
    payloadDir?: string;
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
}

export interface DemandStartOutcome {
    result: DaemonResultV1;
    /**
     * Storage readiness at return time for `magic-context` capability.
     * Callers must send no Rust application body unless this is `ready`.
     */
    storage: StorageReadiness | null;
}

export class McHostLifecyclePolicy {
    private readonly env: Record<string, string | undefined>;
    private readonly launchTarget: NativeLaunchTarget | null;
    private readonly platformReaders: PlatformReaders | undefined;
    private readonly admissionIo: AdmissionIo | undefined;
    private readonly storageProbe: (budgetMs: number) => Promise<StorageReadiness>;
    private readonly payloadDir: string | undefined;
    private readonly outerAggregateMs: number;
    private readonly inflightStarts = new Map<string, Promise<DaemonResultV1>>();

    constructor(options: LifecyclePolicyOptions = {}) {
        this.env = options.env ?? process.env;
        this.launchTarget = options.launchTarget ?? null;
        this.platformReaders = options.platformReaders;
        this.admissionIo = options.admissionIo;
        // Fail closed: an unwired probe must not assert readiness.
        this.storageProbe = options.storageProbe ?? (async () => "unavailable");
        this.payloadDir = options.payloadDir;
        this.outerAggregateMs = options.outerAggregateMs ?? OUTER_AGGREGATE_MS;
    }

    /** Count of live coalesced startups; test observability only. */
    get inflightStartCount(): number {
        return this.inflightStarts.size;
    }

    async start(): Promise<DaemonResultV1> {
        return this.mutatingCommand("start");
    }

    async stop(): Promise<DaemonResultV1> {
        return this.mutatingCommand("stop");
    }

    /** One native restart transaction; never emulated as TS stop+start. */
    async restart(): Promise<DaemonResultV1> {
        return this.mutatingCommand("restart");
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
        const startedAt = Date.now();
        const rootResolution = resolveLifecycleDataRoot(this.env);
        // The data root alone identifies the host: `start()` takes no
        // capability and one daemon serves them all, so keying on capability
        // would launch a second native start that only collides with the
        // first on the transaction lock.
        const key = rootResolution.ok ? rootResolution.root : "\u0000no-root";
        let shared = this.inflightStarts.get(key);
        if (!shared) {
            shared = this.start();
            this.inflightStarts.set(key, shared);
            void shared
                .catch(() => {})
                .finally(() => {
                    if (this.inflightStarts.get(key) === shared) this.inflightStarts.delete(key);
                });
        }
        const result = await this.raceWaiter(shared, request);
        if (request.capability !== "magic-context" || !result.ok) {
            return { result, storage: null };
        }
        const storage = await this.boundedStorageProbe(request, startedAt);
        return { result, storage };
    }

    /**
     * Run the storage probe under the policy's own bound rather than trusting
     * it to honor the budget it is handed.
     *
     * `raceWaiter` has already cleared its timer and detached the abort
     * listener by the time the start resolves, so without this the probe would
     * be both unbounded and uncancellable: a hanging probe would keep
     * `demandStart` pending forever with the caller's signal and deadline no
     * longer watching. Expiry, abort, and probe failure — rejected or thrown
     * synchronously — all degrade to `unavailable`, never to `ready`, and the
     * already-successful start result is still returned.
     */
    private async boundedStorageProbe(
        request: DemandStartRequest,
        startedAt: number,
    ): Promise<StorageReadiness> {
        const remaining =
            request.deadlineMs === undefined
                ? STORAGE_HARD_BUDGET_MS
                : Math.min(STORAGE_HARD_BUDGET_MS, request.deadlineMs - (Date.now() - startedAt));
        if (remaining <= 0) return "unavailable";
        let timer: ReturnType<typeof setTimeout> | null = null;
        let onAbort: (() => void) | null = null;
        try {
            return await new Promise<StorageReadiness>((resolve) => {
                let settled = false;
                const finish = (value: StorageReadiness): void => {
                    if (settled) return;
                    settled = true;
                    resolve(value);
                };
                timer = setTimeout(() => finish("unavailable"), remaining);
                if (request.signal) {
                    if (request.signal.aborted) {
                        finish("unavailable");
                        return;
                    }
                    onAbort = () => finish("unavailable");
                    request.signal.addEventListener("abort", onAbort, { once: true });
                }
                // A probe that throws before returning its promise fails the
                // same way a rejection does; letting it escape the executor
                // would reject `demandStart` instead of reporting readiness.
                try {
                    this.storageProbe(remaining).then(
                        (value) => finish(value),
                        () => finish("unavailable"),
                    );
                } catch {
                    finish("unavailable");
                }
            });
        } finally {
            if (timer !== null) clearTimeout(timer);
            if (onAbort !== null) request.signal?.removeEventListener("abort", onAbort);
        }
    }

    private raceWaiter(
        shared: Promise<DaemonResultV1>,
        request: DemandStartRequest,
    ): Promise<DaemonResultV1> {
        const { signal, deadlineMs } = request;
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
        return { ok: true, root };
    }

    private async mutatingCommand(command: "start" | "stop" | "restart"): Promise<DaemonResultV1> {
        const preflight = this.preflight(command);
        if (!preflight.ok) return preflight.result;
        if (this.launchTarget === null) {
            const state = preNativeState(classifyPreNativeRoots(preflight.root));
            return localResult(command, false, state, "native_payload_missing");
        }
        try {
            const native = await runNativeLifecycle(this.launchTarget, {
                command: command as NativeLifecycleCommand,
                deadlineMs: this.outerAggregateMs,
                env: this.nativeEnv(preflight.root),
                ...(this.payloadDir !== undefined && command !== "stop"
                    ? { payloadDir: this.payloadDir }
                    : {}),
            });
            return this.relabel(native, command, command);
        } catch (error) {
            return this.launchFailure(command, preflight.root, error);
        }
    }

    private async observationalCommand(command: "status" | "doctor"): Promise<DaemonResultV1> {
        const preflight = this.preflight(command);
        if (!preflight.ok) return preflight.result;
        if (this.launchTarget === null) {
            // No trusted retained current-release bootstrap: only the bounded
            // no-follow classifier may speak, and it authorizes nothing.
            const verdict = probeFallbackVerdict(classifyPreNativeRoots(preflight.root));
            const ok = false;
            return localResult(command, ok, verdict.state, verdict.reason);
        }
        try {
            const native = await runNativeLifecycle(this.launchTarget, {
                command: "probe",
                deadlineMs: this.outerAggregateMs,
                env: this.nativeEnv(preflight.root),
            });
            return this.relabel(native, "probe", command);
        } catch (error) {
            return this.launchFailure(command, preflight.root, error);
        }
    }

    /**
     * Restamp a native result with the caller-facing command, first proving the
     * child answered the command it was actually sent.
     *
     * `parseDaemonResult` validates the restart-only `effects` invariant
     * against the child's own `command`, so blindly overwriting that field can
     * publish a `restart` result carrying `effects` under a `stop` or `start`
     * label. A disagreement means the child answered a different command than
     * requested — a real version-skew signal — so it becomes `internal_error`
     * rather than being silently relabeled. Observational commands legitimately
     * map the native read-only `probe` onto `status`/`doctor`.
     */
    private relabel(
        native: DaemonResultV1,
        sent: NativeLifecycleCommand,
        command: LifecycleCommand,
    ): DaemonResultV1 {
        if (native.command !== sent) {
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
