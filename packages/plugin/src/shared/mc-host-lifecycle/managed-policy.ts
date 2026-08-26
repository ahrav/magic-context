import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import payloadIndex from "../../../../../release/mc-host-payload-index.json";
import {
    type AuthenticatedPeer,
    BROCA_CREDENTIAL_NAMES,
    type CatalogEntry,
    type HostStatusSnapshot,
    McHostClient,
} from "../mc-host-client";
import { BootstrapError, checkPlatform, type PlatformReaders, parseTrustIndex } from "./bootstrap";
import {
    evaluateCompatibility,
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
import { connectionFilePath, resolveLifecycleDataRoot } from "./paths";
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

async function probeManagedStorage(
    root: string,
    budgetMs: number,
): Promise<"ready" | "starting" | "unavailable"> {
    const deadline = Date.now() + budgetMs;
    let client: McHostClient | null = null;
    try {
        client = await McHostClient.connect({
            connectionFile: connectionFilePath(root),
            handshakeTimeoutMs: Math.max(1, budgetMs),
            requestTimeoutMs: Math.max(1, budgetMs),
        });
        for (;;) {
            const state = storageState(
                (
                    await client.hostStatus({
                        timeoutMs: Math.max(1, deadline - Date.now()),
                    })
                ).metrics,
            );
            if (state !== "starting" || Date.now() >= deadline) return state;
            await new Promise((resolve) =>
                setTimeout(
                    resolve,
                    Math.min(READINESS_POLL_MS, Math.max(1, deadline - Date.now())),
                ),
            );
        }
    } catch {
        return Date.now() >= deadline ? "starting" : "unavailable";
    } finally {
        await client?.closeAsync().catch(() => {});
    }
}

export interface ManagedCompatibilityClient {
    readonly authenticated: AuthenticatedPeer | null;
    catalogList(): Promise<CatalogEntry[]>;
    hostStatus(options?: { timeoutMs?: number }): Promise<HostStatusSnapshot>;
}

function samePeer(left: AuthenticatedPeer | null, right: AuthenticatedPeer): boolean {
    if (
        left === null ||
        left.daemonVer !== right.daemonVer ||
        left.proof !== right.proof ||
        left.daemonId === null ||
        right.daemonId === null ||
        left.daemonId.length !== right.daemonId.length
    ) {
        return false;
    }
    return left.daemonId.every((byte, index) => byte === right.daemonId?.[index]);
}

interface CompatibilityProbeResult {
    snapshot: CompatibilitySnapshot;
    status: HostStatusSnapshot | null;
}

async function readCompatibilityProbe(
    client: ManagedCompatibilityClient,
    deadline: number,
    signal?: AbortSignal,
): Promise<CompatibilityProbeResult> {
    const authenticated = client.authenticated;
    if (authenticated === null || authenticated.daemonId === null) {
        throw new Error("authenticated peer disappeared");
    }
    const daemon = evaluateDaemonCompatibility(authenticated.daemonVer);
    if (!daemon.ok) {
        return {
            snapshot: {
                authenticatedDaemonVersion: authenticated.daemonVer,
                authenticatedDaemonId: Uint8Array.from(authenticated.daemonId),
                catalog: [],
                epochs: {},
                evaluatedThrough: "daemon",
            },
            status: null,
        };
    }
    const catalog = await client.catalogList();
    if (!samePeer(client.authenticated, authenticated)) {
        throw new Error("authenticated peer changed during compatibility probe");
    }
    if (signal?.aborted) throw signal.reason ?? new Error("compatibility probe aborted");
    const modules = evaluateModuleCompatibility(catalog);
    if (!modules.ok) {
        return {
            snapshot: {
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
    const snapshot = {
        authenticatedDaemonVersion: authenticated.daemonVer,
        authenticatedDaemonId: Uint8Array.from(authenticated.daemonId),
        catalog,
        epochs: observedEpochsFromMagicContextMetrics(magicContextMetrics),
        evaluatedThrough: "epochs" as const,
    };
    evaluateCompatibility({
        authenticatedDaemonVer: snapshot.authenticatedDaemonVersion,
        catalog: snapshot.catalog,
        epochs: snapshot.epochs,
    });
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
): Promise<CompatibilitySnapshot> {
    const deadline = Date.now() + budgetMs;
    const client = await McHostClient.connect({
        connectionFile: connectionFilePath(root),
        handshakeTimeoutMs: Math.max(1, budgetMs),
        requestTimeoutMs: Math.max(1, budgetMs),
    });
    try {
        return await readCompatibilitySnapshot(client, deadline, signal);
    } finally {
        await client.closeAsync().catch(() => {});
    }
}

async function probeManagedReadiness(root: string, budgetMs: number): Promise<ObservationalHealth> {
    const deadline = Date.now() + budgetMs;
    const client = await McHostClient.connect({
        connectionFile: connectionFilePath(root),
        handshakeTimeoutMs: Math.max(1, budgetMs),
        requestTimeoutMs: Math.max(1, budgetMs),
        identity: {
            project_root: root,
            harness: "mc-host-lifecycle",
            session: "compatibility",
        },
    });
    try {
        const { snapshot: compatibility, status } = await readCompatibilityProbe(client, deadline);
        if (status === null) {
            return {
                ...compatibility,
                readiness: {
                    transport: { state: "ready", reason: "healthy" },
                    storage: { state: "unavailable", reason: "storage_unavailable" },
                    synapse: { state: "degraded", reason: "synapse_degraded" },
                },
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
    } finally {
        await client.closeAsync().catch(() => {});
    }
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
        return new McHostLifecyclePolicy({
            ...options,
            env,
            launchTarget: prepared,
            defaultStartupEnvelope: buildManagedCredentialEnvelope(env),
            storageProbe:
                options.storageProbe ?? ((budgetMs) => probeManagedStorage(root.root, budgetMs)),
            compatibilityProbe:
                options.compatibilityProbe ??
                ((budgetMs, signal) => probeManagedCompatibility(root.root, budgetMs, signal)),
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
