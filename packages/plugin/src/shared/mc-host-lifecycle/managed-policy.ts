import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import payloadIndex from "../../../../../release/mc-host-payload-index.json";
import {
    type AuthenticatedPeer,
    BROCA_CREDENTIAL_NAMES,
    type CatalogEntry,
    evictProcessMcHostClient,
    type HostStatusSnapshot,
    McHostClient,
    type McHostClientOptions,
    processMcHostClient,
    sameDaemonId,
} from "../mc-host-client";
import { BootstrapError, checkPlatform, type PlatformReaders, parseTrustIndex } from "./bootstrap";
import {
    evaluateDaemonCompatibility,
    evaluateModuleCompatibility,
    observedEpochsFromMagicContextMetrics,
} from "./compatibility";
import type { NativeStartupEnvelope } from "./native-launcher";
import {
    type PayloadTrustIndex,
    prepareManagedLaunchTarget,
    resolveManagedPayloadDir,
} from "./owner";
import { admitLifecycleFilesystem, connectionFilePath, resolveLifecycleDataRoot } from "./paths";
import {
    type CompatibilitySnapshot,
    type LifecyclePolicyOptions,
    McHostLifecyclePolicy,
    type ObservationalHealth,
} from "./policy";

const MAX_PARENT_WALK = 8;
const READINESS_POLL_MS = 50;

export function buildManagedCredentialEnvelope(
    env: Record<string, string | undefined>,
): NativeStartupEnvelope {
    const credentials = Object.fromEntries(
        BROCA_CREDENTIAL_NAMES.flatMap((name) => {
            const value = env[name];
            return value === undefined || value.length === 0 ? [] : [[name, value]];
        }),
    );
    return {
        schema: 1,
        ...(Object.keys(credentials).length === 0 ? {} : { credentials }),
    };
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function storageState(metrics: Record<string, unknown>): "ready" | "starting" | "unavailable" {
    const components = asRecord(metrics.components);
    const magicContext = asRecord(components?.["magic-context"]);
    const componentMetrics = asRecord(magicContext?.metrics);
    const state = componentMetrics?.storage_state;
    return state === "ready" || state === "unavailable" ? state : "starting";
}

/**
 * The storage probe observed an incarnation other than the one compatibility
 * certified. It escapes `probeManagedStorage`'s catch-all because it is not a
 * storage observation at all: reducing it to `unavailable` would blame storage
 * for a rotation and send remediation at the wrong component.
 */
class StorageProbeDaemonMismatchError extends Error {
    constructor() {
        super("storage probe observed a different daemon than compatibility certified");
        this.name = "StorageProbeDaemonMismatchError";
    }
}

function assertStorageProbePeer(
    client: McHostClient,
    expectedDaemonId: Uint8Array | undefined,
): void {
    if (expectedDaemonId === undefined) return;
    const daemonId = client.authenticated?.daemonId ?? null;
    if (daemonId === null || !sameDaemonId(daemonId, expectedDaemonId)) {
        throw new StorageProbeDaemonMismatchError();
    }
}

/**
 * Poll storage readiness on its own connection until it leaves `starting`.
 *
 * `expectedDaemonId` binds the observation to the incarnation compatibility
 * certified. The probe cannot share the compatibility connection because it
 * waits across restarts of `host.status`, so it re-checks identity after the
 * handshake and after every response instead: a rotation mid-poll makes the
 * reading describe a daemon the caller will never publish to.
 */
async function probeManagedStorage(
    root: string,
    budgetMs: number,
    expectedDaemonId?: Uint8Array,
): Promise<"ready" | "starting" | "unavailable"> {
    const deadline = Date.now() + budgetMs;
    const options: McHostClientOptions = {
        connectionFile: connectionFilePath(root),
        handshakeTimeoutMs: Math.max(1, budgetMs),
        requestTimeoutMs: Math.max(1, budgetMs),
    };
    let client: McHostClient | undefined;
    try {
        client = await processMcHostClient(options);
        assertStorageProbePeer(client, expectedDaemonId);
        for (;;) {
            const snapshot = await client.hostStatus({
                timeoutMs: Math.max(1, deadline - Date.now()),
            });
            assertStorageProbePeer(client, expectedDaemonId);
            const state = storageState(snapshot.metrics);
            if (state !== "starting" || Date.now() >= deadline) return state;
            await new Promise((resolve) =>
                setTimeout(
                    resolve,
                    Math.min(READINESS_POLL_MS, Math.max(1, deadline - Date.now())),
                ),
            );
        }
    } catch (error) {
        if (error instanceof StorageProbeDaemonMismatchError) throw error;
        return Date.now() >= deadline ? "starting" : "unavailable";
    } finally {
        // The connected channel holds a referenced interval, so a one-shot caller stays alive until this client closes. Evict before closing because the owner cache retains resolved clients. commentlint: allow(JUDGE)
        if (client !== undefined) {
            const probed = client;
            await evictProcessMcHostClient(options, probed);
            await probed.closeAsync().catch(() => undefined);
        }
    }
}

export interface ManagedCompatibilityClient {
    readonly authenticated: AuthenticatedPeer | null;
    catalogList(options?: { timeoutMs?: number }): Promise<CatalogEntry[]>;
    hostStatus(options?: { timeoutMs?: number }): Promise<HostStatusSnapshot>;
}

function samePeer(left: AuthenticatedPeer | null, right: AuthenticatedPeer): boolean {
    if (left === null || left.daemonVer !== right.daemonVer || left.proof !== right.proof) {
        return false;
    }
    return sameDaemonId(left.daemonId, right.daemonId);
}

interface CompatibilityProbeResult {
    snapshot: CompatibilitySnapshot;
    status: HostStatusSnapshot | null;
}

/**
 * Read one ordered daemon/modules/epochs observation from a single authenticated
 * peer, stopping at the first stage that cannot pass and re-checking the peer
 * across every await so a rotation cannot produce a mixed snapshot.
 *
 * The returned snapshot is an observation, not a verdict: `evaluatedThrough`
 * names the last stage actually reached, and the policy layer owns the verdict
 * so one place decides precedence and remediation. `status` is null exactly when
 * the probe short-circuited before `host.status`, meaning storage and Synapse
 * were never observed.
 *
 * Every request is bounded by the time left until `deadline`, not by the
 * client-wide request timeout, so a slow handshake cannot leave a later stage
 * free to spend another full budget past the aggregate the caller promised.
 */
async function readCompatibilityProbe(
    client: ManagedCompatibilityClient,
    deadline: number,
    signal?: AbortSignal,
): Promise<CompatibilityProbeResult> {
    const authenticated = client.authenticated;
    if (authenticated === null || authenticated.daemonId === null) {
        throw new Error("authenticated peer disappeared");
    }
    const daemon = evaluateDaemonCompatibility(authenticated);
    if (!daemon.ok) {
        return {
            snapshot: {
                authenticatedPeer: {
                    ...authenticated,
                    daemonId: Uint8Array.from(authenticated.daemonId),
                },
                authenticatedDaemonVersion: authenticated.daemonVer,
                authenticatedDaemonId: Uint8Array.from(authenticated.daemonId),
                catalog: [],
                epochs: {},
                evaluatedThrough: "daemon",
            },
            status: null,
        };
    }
    const catalogMs = deadline - Date.now();
    if (catalogMs <= 0) throw new Error("compatibility probe deadline expired");
    const catalog = await client.catalogList({ timeoutMs: catalogMs });
    if (!samePeer(client.authenticated, authenticated)) {
        throw new Error("authenticated peer changed during compatibility probe");
    }
    if (signal?.aborted) throw signal.reason ?? new Error("compatibility probe aborted");
    const modules = evaluateModuleCompatibility(catalog);
    if (!modules.ok) {
        return {
            snapshot: {
                authenticatedPeer: {
                    ...authenticated,
                    daemonId: Uint8Array.from(authenticated.daemonId),
                },
                authenticatedDaemonVersion: authenticated.daemonVer,
                authenticatedDaemonId: Uint8Array.from(authenticated.daemonId),
                catalog,
                epochs: {},
                evaluatedThrough: "modules",
            },
            status: null,
        };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("compatibility probe deadline expired");
    const status = await client.hostStatus({
        timeoutMs: remainingMs,
    });
    if (!samePeer(client.authenticated, authenticated)) {
        throw new Error("authenticated peer changed during compatibility probe");
    }
    if (signal?.aborted) throw signal.reason ?? new Error("compatibility probe aborted");
    const components = asRecord(status.metrics.components);
    const magicContextMetrics = asRecord(asRecord(components?.["magic-context"])?.metrics);
    // The probe only reports what it observed; the compatibility verdict is
    // owned by exactly one place, `McHostLifecyclePolicy.applyCompatibility`.
    const snapshot = {
        authenticatedPeer: {
            ...authenticated,
            daemonId: Uint8Array.from(authenticated.daemonId),
        },
        authenticatedDaemonVersion: authenticated.daemonVer,
        authenticatedDaemonId: Uint8Array.from(authenticated.daemonId),
        catalog,
        epochs: observedEpochsFromMagicContextMetrics(magicContextMetrics),
        evaluatedThrough: "epochs" as const,
    };
    return { snapshot, status };
}

export async function readCompatibilitySnapshot(
    client: ManagedCompatibilityClient,
    deadline: number,
    signal?: AbortSignal,
): Promise<CompatibilitySnapshot> {
    return (await readCompatibilityProbe(client, deadline, signal)).snapshot;
}

async function probeManagedCompatibility(
    root: string,
    budgetMs: number,
    signal?: AbortSignal,
): Promise<CompatibilityProbeResult> {
    const deadline = Date.now() + budgetMs;
    const client = await McHostClient.connect({
        connectionFile: connectionFilePath(root),
        handshakeTimeoutMs: Math.max(1, budgetMs),
        requestTimeoutMs: Math.max(1, budgetMs),
    });
    try {
        return await readCompatibilityProbe(client, deadline, signal);
    } finally {
        await client.closeAsync().catch(() => {});
    }
}

async function probeManagedReadiness(root: string, budgetMs: number): Promise<ObservationalHealth> {
    const deadline = Date.now() + budgetMs;
    const client = await processMcHostClient({
        connectionFile: connectionFilePath(root),
        handshakeTimeoutMs: Math.max(1, budgetMs),
        requestTimeoutMs: Math.max(1, budgetMs),
        identity: {
            project_root: root,
            harness: "mc-host-lifecycle",
            session: "compatibility",
        },
    });
    const { snapshot: compatibility, status } = await readCompatibilityProbe(client, deadline);
    if (status === null) {
        // The probe short-circuited at the daemon or module stage, so
        // `host.status` never ran and storage and Synapse were never
        // observed. Report only what the handshake proved and leave the
        // unobserved components absent rather than asserting failures that
        // would point remediation away from the version mismatch.
        return {
            ...compatibility,
            readiness: { transport: { state: "ready", reason: "healthy" } },
        };
    }
    const components = asRecord(status.metrics.components);
    const storage = storageState(status.metrics);
    const synapseMetrics = asRecord(asRecord(components?.synapse)?.metrics);
    const synapseState = synapseMetrics?.synapse_state;
    const synapse =
        synapseState === "ready"
            ? { state: "ready" as const, reason: "healthy" as const }
            : synapseState === "unsupported"
              ? {
                    state: "unsupported" as const,
                    reason: "synapse_unsupported" as const,
                }
              : synapseState === "starting"
                ? { state: "starting" as const, reason: "synapse_starting" as const }
                : synapseState === undefined
                  ? // The status payload omits a component whose state it
                    // cannot report: the daemon skips any module missing from
                    // `components`, missing a usable `status`, or missing its
                    // state key. Absence means the lane is not offered, so it
                    // reports `unsupported` — the one non-failing readiness
                    // state, which `addCheck` maps to a skipped check. Calling
                    // it `degraded` would make `status` and `doctor` answer
                    // `ok: false` for a daemon that is serving correctly and
                    // simply has no Synapse lane, which is the normal shape on
                    // every platform the model lane does not cover.
                    {
                        state: "unsupported" as const,
                        reason: "synapse_unsupported" as const,
                    }
                  : { state: "degraded" as const, reason: "synapse_degraded" as const };
    return {
        ...compatibility,
        readiness: {
            transport: { state: "ready", reason: "healthy" },
            storage: {
                state: storage,
                reason:
                    storage === "ready"
                        ? "healthy"
                        : storage === "starting"
                          ? "storage_starting"
                          : "storage_unavailable",
            },
            synapse,
        },
    };
}

export interface ManagedLifecyclePolicyOptions
    extends Omit<LifecyclePolicyOptions, "launchTarget" | "payloadDir" | "bootstrapFailure"> {
    mode: "mutating" | "observational";
    declaringModuleUrl: string;
    parentPackageName: string;
    explicitExternalRoot?: string;
    trustIndex?: PayloadTrustIndex;
}

function findDeclaringParentRoot(moduleUrl: string, packageName: string): string {
    let current = dirname(fileURLToPath(moduleUrl));
    for (let depth = 0; depth <= MAX_PARENT_WALK; depth += 1) {
        const packagePath = join(current, "package.json");
        if (existsSync(packagePath)) {
            try {
                const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
                if (
                    parsed !== null &&
                    typeof parsed === "object" &&
                    !Array.isArray(parsed) &&
                    (parsed as Record<string, unknown>).name === packageName
                ) {
                    return current;
                }
            } catch {
                // Keep walking; malformed or unrelated ancestors are not authority.
            }
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    throw new BootstrapError(
        "unsupported_install_layout",
        "declaring parent package root is unavailable",
    );
}

/**
 * Build the shared policy lazily at a real lifecycle demand site. Importing
 * this module performs no filesystem or package lookup.
 */
export function createManagedLifecyclePolicy(
    options: ManagedLifecyclePolicyOptions,
): McHostLifecyclePolicy {
    const env = options.env ?? process.env;
    const root = resolveLifecycleDataRoot(env);
    if (!root.ok) return new McHostLifecyclePolicy({ ...options, env });

    const readers: PlatformReaders | undefined = options.platformReaders;
    const platform = checkPlatform(readers);
    if (!platform.ok) return new McHostLifecyclePolicy({ ...options, env });

    // Admission runs before anything is prepared, because preparation WRITES:
    // `prepareManagedLaunchTarget` can resolve the payload and call
    // `stageBootstrap`, which creates directories and copies an executable into
    // the data root. Admission otherwise happened for the first time in
    // `preflight()`, at command time, so a root on an unsupported filesystem —
    // NFS, or a `noexec` mount — was mutated by the very call that was about to
    // reject it. A rejection that claims to be pre-native must leave no trace.
    //
    // The verdict itself is deliberately not reported here. Returning a policy
    // with no launch target keeps `preflight()` the single authority on the
    // outcome: it re-runs admission and answers with `admission.reason`, so the
    // caller still sees `unsupported_filesystem` rather than a substitute.
    if (!admitLifecycleFilesystem(root.root, options.admissionIo).ok) {
        return new McHostLifecyclePolicy({ ...options, env });
    }

    try {
        const declaringParentRoot = findDeclaringParentRoot(
            options.declaringModuleUrl,
            options.parentPackageName,
        );
        const trustIndex = options.trustIndex ?? parseTrustIndex(payloadIndex);
        const prepared = prepareManagedLaunchTarget({
            dataRoot: root.root,
            declaringParentRoot,
            target: platform.target,
            trustIndex,
            allowPackageLookup: options.mode === "mutating",
            ...(options.explicitExternalRoot === undefined
                ? {}
                : { explicitExternalRoot: options.explicitExternalRoot }),
        });
        // The default compatibility probe's `host.status` reply already
        // carries the storage state, so the demand path's storage probe can
        // consume that observation instead of opening a second connection and
        // re-issuing `host.status`. The observation is single-use and only a
        // terminal state short-circuits; a `starting` observation still runs
        // the polling probe so it can wait out startup within its own budget.
        //
        // The observation is tagged with the daemon incarnation whose
        // `host.status` produced it and is only consumed by a demand that
        // certified that same incarnation. Concurrent probes share this slot:
        // `sharedCompatibility` dedupes per data root, so a real-root and a
        // no-root key can be in flight together, and a non-`magic-context`
        // demand writes an observation it never consumes. Untagged reuse would
        // let a waiter read a state observed on a different request or daemon
        // generation and publish module traffic against it.
        let observedStorage: {
            daemonId: Uint8Array;
            state: "ready" | "starting" | "unavailable";
        } | null = null;
        const defaultCompatibilityProbe = async (
            budgetMs: number,
            signal?: AbortSignal,
        ): Promise<CompatibilitySnapshot> => {
            const probe = await probeManagedCompatibility(root.root, budgetMs, signal);
            observedStorage =
                probe.status === null
                    ? null
                    : {
                          daemonId: Uint8Array.from(probe.snapshot.authenticatedPeer.daemonId),
                          state: storageState(probe.status.metrics),
                      };
            return probe.snapshot;
        };
        const defaultStorageProbe = (
            budgetMs: number,
            expectedDaemonId?: Uint8Array,
        ): Promise<"ready" | "starting" | "unavailable"> => {
            const observed = observedStorage;
            observedStorage = null;
            if (
                expectedDaemonId !== undefined &&
                observed !== null &&
                sameDaemonId(observed.daemonId, expectedDaemonId) &&
                (observed.state === "ready" || observed.state === "unavailable")
            ) {
                return Promise.resolve(observed.state);
            }
            return probeManagedStorage(root.root, budgetMs, expectedDaemonId);
        };
        return new McHostLifecyclePolicy({
            ...options,
            env,
            launchTarget: prepared,
            defaultStartupEnvelope: buildManagedCredentialEnvelope(env),
            storageProbe: options.storageProbe ?? defaultStorageProbe,
            compatibilityProbe: options.compatibilityProbe ?? defaultCompatibilityProbe,
            readinessProbe:
                options.readinessProbe ??
                ((budgetMs) => probeManagedReadiness(root.root, budgetMs)),
            ...(prepared?.payloadDir === undefined ? {} : { payloadDir: prepared.payloadDir }),
            ...(prepared === null ? {} : { payloadManifestDigest: prepared.payloadManifestDigest }),
            ...(options.mode === "mutating" && prepared?.payloadDir === undefined
                ? {
                      payloadDirFallback: () =>
                          resolveManagedPayloadDir({
                              declaringParentRoot,
                              target: platform.target,
                              trustIndex,
                              ...(options.explicitExternalRoot === undefined
                                  ? {}
                                  : {
                                        explicitExternalRoot: options.explicitExternalRoot,
                                    }),
                          }),
                  }
                : {}),
        });
    } catch (error) {
        return new McHostLifecyclePolicy({
            ...options,
            env,
            launchTarget: null,
            bootstrapFailure: error instanceof BootstrapError ? error.reason : "internal_error",
        });
    }
}
