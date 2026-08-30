import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import payloadIndex from "../../../../../release/mc-host-payload-index.json";
import { processMcHostClient } from "../mc-host-client";
import { BootstrapError, checkPlatform, type PlatformReaders, parseTrustIndex } from "./bootstrap";
import {
    type PayloadTrustIndex,
    prepareManagedLaunchTarget,
    resolveManagedPayloadDir,
} from "./owner";
import { admitLifecycleFilesystem, connectionFilePath, resolveLifecycleDataRoot } from "./paths";
import {
    type LifecyclePolicyOptions,
    McHostLifecyclePolicy,
    type ObservationalHealth,
} from "./policy";

const MAX_PARENT_WALK = 8;
const READINESS_POLL_MS = 50;

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
    try {
        const client = await processMcHostClient({
            connectionFile: connectionFilePath(root),
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
    }
}

async function probeManagedReadiness(root: string, budgetMs: number): Promise<ObservationalHealth> {
    const deadline = Date.now() + budgetMs;
    const client = await processMcHostClient({
        connectionFile: connectionFilePath(root),
    });
    const authenticated = client.authenticated;
    if (authenticated === null) throw new Error("authenticated peer disappeared");
    const status = await client.hostStatus({
        timeoutMs: Math.max(1, deadline - Date.now()),
    });
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
        authenticatedPeer: authenticated,
        sharedMemory: status.sharedMemory,
        readiness: {
            shared_memory: {
                state: status.sharedMemory.state === "healthy" ? "ready" : "unavailable",
                reason:
                    status.sharedMemory.state === "healthy"
                        ? "healthy"
                        : "native_probe_unavailable",
            },
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
        return new McHostLifecyclePolicy({
            ...options,
            env,
            launchTarget: prepared,
            storageProbe:
                options.storageProbe ?? ((budgetMs) => probeManagedStorage(root.root, budgetMs)),
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
