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
import type { AuthenticatedPeer } from "../mc-host-client/types";
import { type LifecycleFailureReason, type PlatformReaders } from "./bootstrap";
import { type DaemonReadiness, type DaemonResultV1 } from "./contract";
import { type NativeLaunchTarget, type NativeStartupEnvelope } from "./native-launcher";
import { type ConnectionOrigin } from "./ownership";
import { type AdmissionIo } from "./paths";
/** Managed Magic Context demand waits at most this long for storage (R11). */
export declare const STORAGE_HARD_BUDGET_MS = 5000;
/** Fresh Linux request-to-authenticated-transport outer aggregate (hard). */
export declare const OUTER_AGGREGATE_MS = 60000;
/**
 * Fresh macOS request-to-authenticated-transport outer aggregate (hard).
 *
 * Darwin is qualified against a far tighter bound than Linux, so applying the
 * Linux aggregate universally lets a hung macOS startup run four times past the
 * budget it was qualified for. Both values mirror
 * `release/mc-host-production-inputs.lock.json`
 * (`fresh_linux_transport_aggregate.hard`, `fresh_macos_transport_aggregate.hard`);
 * the generated contract does not carry them yet, so changing one there means
 * changing it here.
 */
export declare const OUTER_AGGREGATE_MS_DARWIN = 15000;
/** The qualified outer aggregate for a platform-gate target. */
export declare function aggregateForTarget(target: "linux-x64-gnu" | "darwin-arm64" | "darwin-x64"): number;
export type LifecycleCommand = "start" | "stop" | "restart" | "status" | "doctor";
export type StorageReadiness = "ready" | "starting" | "unavailable";
export interface ObservationalHealth {
    readiness: DaemonReadiness;
    /**
     * The peer the probe authenticated, not just its version string. The
     * compatibility gate is applied to it here, so handing over only the version
     * would let an observation report `healthy` for a daemon outside the
     * supported range while stamping that version with `proof: "current"`.
     */
    authenticatedPeer: AuthenticatedPeer;
}
export declare class WaiterDetachedError extends Error {
    readonly cause_kind: "aborted" | "deadline";
    constructor(cause_kind: "aborted" | "deadline");
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
     * U4 wires the real Magic Context status call. There is deliberately no
     * permissive default: an unset probe reports `unavailable`, because a
     * default of `ready` would authorize application bodies against a daemon
     * whose storage state was never examined. Explicit CLI flows are
     * unaffected — they never reach `demandStart`.
     */
    storageProbe?: (budgetMs: number) => Promise<StorageReadiness>;
    /** Authenticated route-free component health for status and doctor. */
    readinessProbe?: (budgetMs: number) => Promise<ObservationalHealth>;
    /** Dev/test payload directory forwarded to native start/restart. */
    payloadDir?: string;
    /** Parent-trusted payload manifest digest paired with `payloadDir`. */
    payloadManifestDigest?: string;
    /** Deferred certified package lookup after native current validation says missing. */
    payloadDirFallback?: () => string | null;
    outerAggregateMs?: number;
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
}
export declare class McHostLifecyclePolicy {
    private readonly env;
    private readonly launchTarget;
    private readonly bootstrapFailure;
    private readonly platformReaders;
    private readonly admissionIo;
    private readonly storageProbe;
    private readonly readinessProbe;
    private readonly payloadDir;
    private readonly payloadManifestDigest;
    private readonly payloadDirFallback;
    private readonly outerAggregateMs;
    private readonly inflightStarts;
    constructor(options?: LifecyclePolicyOptions);
    /** Count of live coalesced startups; test observability only. */
    get inflightStartCount(): number;
    start(startupEnvelope?: NativeStartupEnvelope): Promise<DaemonResultV1>;
    stop(): Promise<DaemonResultV1>;
    /** One native restart transaction; never emulated as TS stop+start. */
    restart(): Promise<DaemonResultV1>;
    status(): Promise<DaemonResultV1>;
    doctor(): Promise<DaemonResultV1>;
    /**
     * Managed demand-start with KTD17 coalescing. Only `managed-default`
     * origin is accepted; the shared native start is keyed by data root,
     * callers race it against their own signal/deadline, and a settled promise
     * is evicted so no rejection becomes a permanent latch. For the
     * `magic-context` capability, the outcome additionally reports storage
     * readiness after waiting at most the 5-second hard budget.
     */
    demandStart(request: DemandStartRequest): Promise<DemandStartOutcome>;
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
    private boundedStorageProbe;
    private raceWaiter;
    /**
     * Root resolution, filesystem admission, and the platform gate: the
     * pre-native checks every command shares.
     *
     * Observational commands gate on the platform too. A host outside the
     * supported target table has no retained-descriptor exec path, so probing
     * it or answering with the no-probe classifier would report a daemon state
     * for a host the release cannot run on at all.
     */
    private preflight;
    private mutatingCommand;
    private observationalCommand;
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
    private relabel;
    private nativeEnv;
    private launchFailure;
}
//# sourceMappingURL=policy.d.ts.map