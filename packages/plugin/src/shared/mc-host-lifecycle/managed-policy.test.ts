import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthenticatedPeer, CatalogEntry } from "../mc-host-client";
import { evaluateCompatibility } from "./compatibility";
import { releaseContract } from "./generated-contract";
import {
    createManagedLifecyclePolicy,
    kernelReadiness,
    type ManagedCompatibilityClient,
    readCompatibilitySnapshot,
} from "./managed-policy";

function entry(moduleId: string, moduleVersion = "0.1.0"): CatalogEntry {
    return {
        module_id: moduleId,
        module_version: moduleVersion,
        roles: [],
        control_ops: [],
    };
}

const catalog = [entry("magic-context"), entry("synapse"), entry("broca")];

function peer(daemonVer = releaseContract.versions.daemon, daemonId = 7): AuthenticatedPeer {
    return {
        daemonVer,
        daemonId: new Uint8Array([daemonId]),
        proof: "current",
    };
}

/**
 */
function wireEpochs(overrides: Record<string, unknown> = {}) {
    return {
        epochs: {
            memory_render_epoch: releaseContract.epochs.memory_render,
            compartment_render_epoch: releaseContract.epochs.compartment_render,
            profile_epoch: releaseContract.epochs.profile_claude_code_anthropic,
            tagger_epoch: releaseContract.epochs.tagger,
            state_sync_epoch: releaseContract.epochs.state_sync,
            ...overrides,
        },
    };
}

function client(options: {
    authenticated?: AuthenticatedPeer;
    catalog?: CatalogEntry[];
    status?: unknown;
    calls: string[];
}): ManagedCompatibilityClient {
    return {
        authenticated: options.authenticated ?? peer(),
        catalogList: async () => {
            options.calls.push("catalog.list");
            return options.catalog ?? catalog;
        },
        hostStatus: async () => {
            options.calls.push("host.status");
            return {
                health: "ok",
                metrics: {
                    components: {
                        "magic-context": {
                            metrics: options.status ?? wireEpochs(),
                        },
                    },
                },
            };
        },
    };
}

function verdict(snapshot: Awaited<ReturnType<typeof readCompatibilitySnapshot>>) {
    return evaluateCompatibility({
        authenticatedDaemonVer: snapshot.authenticatedDaemonVersion,
        catalog: snapshot.catalog,
        epochs: snapshot.epochs,
    });
}

describe("managed authenticated compatibility probe", () => {
    test("daemon mismatch sends no catalog or host status request", async () => {
        const calls: string[] = [];
        const snapshot = await readCompatibilitySnapshot(
            client({ authenticated: peer("mc-host/0.2.0"), calls }),
            Date.now() + 1_000,
        );

        expect(verdict(snapshot)).toMatchObject({
            ok: false,
            reason: "incompatible_daemon",
        });
        expect(snapshot.evaluatedThrough).toBe("daemon");
        expect(calls).toEqual([]);
    });

    test("module mismatch stops before the host status request", async () => {
        const calls: string[] = [];
        const snapshot = await readCompatibilitySnapshot(
            client({
                catalog: catalog.map((candidate) =>
                    candidate.module_id === "broca" ? entry("broca", "0.2.0") : candidate,
                ),
                calls,
            }),
            Date.now() + 1_000,
        );

        expect(verdict(snapshot)).toMatchObject({
            ok: false,
            reason: "incompatible_module",
        });
        expect(snapshot.evaluatedThrough).toBe("modules");
        expect(calls).toEqual(["catalog.list"]);
    });

    test("a fully compatible daemon reaches the epoch stage and passes", async () => {
        const calls: string[] = [];
        const snapshot = await readCompatibilitySnapshot(client({ calls }), Date.now() + 1_000);

        expect(verdict(snapshot).ok).toBe(true);
        expect(snapshot.evaluatedThrough).toBe("epochs");
        expect(snapshot.epochs).toEqual({ ...releaseContract.epochs });
        expect(calls).toEqual(["catalog.list", "host.status"]);
    });

    test("epoch mismatch uses one bounded host status request", async () => {
        const calls: string[] = [];
        const snapshot = await readCompatibilitySnapshot(
            client({
                status: wireEpochs({
                    state_sync_epoch: releaseContract.epochs.state_sync + 1,
                }),
                calls,
            }),
            Date.now() + 1_000,
        );

        expect(verdict(snapshot)).toMatchObject({
            ok: false,
            reason: "incompatible_epochs",
        });
        expect(snapshot.evaluatedThrough).toBe("epochs");
        expect(calls).toEqual(["catalog.list", "host.status"]);
    });

    test("daemon rotation rejects a mixed compatibility snapshot", async () => {
        const calls: string[] = [];
        let authenticated = peer();
        const rotating: ManagedCompatibilityClient = {
            get authenticated() {
                return authenticated;
            },
            catalogList: async () => {
                calls.push("catalog.list");
                authenticated = peer(releaseContract.versions.daemon, 8);
                return catalog;
            },
            hostStatus: async () => ({ health: "ok", metrics: {} }),
        };

        await expect(readCompatibilitySnapshot(rotating, Date.now() + 1_000)).rejects.toThrow(
            "authenticated peer changed",
        );
        expect(calls).toEqual(["catalog.list"]);
    });

    test("detachment while catalog is pending sends no host status request", async () => {
        const calls: string[] = [];
        const controller = new AbortController();
        const detaching = client({ calls });
        detaching.catalogList = async () => {
            calls.push("catalog.list");
            controller.abort(new Error("detached"));
            return catalog;
        };

        await expect(
            readCompatibilitySnapshot(detaching, Date.now() + 1_000, controller.signal),
        ).rejects.toThrow("detached");
        expect(calls).toEqual(["catalog.list"]);
    });

    test("an expired probe deadline sends no host status request", async () => {
        const calls: string[] = [];
        const expired = client({ calls });
        expired.catalogList = async () => {
            calls.push("catalog.list");
            await new Promise((resolve) => setTimeout(resolve, 5));
            return catalog;
        };

        await expect(readCompatibilitySnapshot(expired, Date.now() + 1)).rejects.toThrow(
            "deadline expired",
        );
        expect(calls).toEqual(["catalog.list"]);
    });

    test("catalog collection spends only the time left until the probe deadline", async () => {
        const calls: string[] = [];
        const timeouts: Array<number | undefined> = [];
        const bounded = client({ calls });
        bounded.catalogList = async (options) => {
            calls.push("catalog.list");
            timeouts.push(options?.timeoutMs);
            return catalog;
        };

        await readCompatibilitySnapshot(bounded, Date.now() + 40);

        expect(timeouts).toHaveLength(1);
        expect(timeouts[0]).toBeGreaterThan(0);
        expect(timeouts[0]).toBeLessThanOrEqual(40);
    });

    test("an already-expired deadline sends no catalog request", async () => {
        const calls: string[] = [];
        await expect(readCompatibilitySnapshot(client({ calls }), Date.now() - 1)).rejects.toThrow(
            "deadline expired",
        );
        expect(calls).toEqual([]);
    });
});

describe("managed observational platform gate", () => {
    test("policy construction preserves each unsupported platform verdict", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-managed-platform-"));
        try {
            for (const platformReaders of [
                {
                    platform: "linux" as const,
                    arch: "x64",
                    kernelRelease: () => "4.17.0",
                    glibcVersion: () => "2.34",
                    procSelfFdUsable: () => true,
                },
                {
                    platform: "darwin" as const,
                    arch: "arm64",
                    kernelRelease: () => "23.0.0",
                    glibcVersion: () => null,
                    procSelfFdUsable: () => false,
                },
                {
                    platform: "linux" as const,
                    arch: "arm64",
                    kernelRelease: () => "6.8.0",
                    glibcVersion: () => "2.39",
                    procSelfFdUsable: () => true,
                },
            ]) {
                const policy = createManagedLifecyclePolicy({
                    mode: "observational",
                    declaringModuleUrl: import.meta.url,
                    parentPackageName: "@cortexkit/magic-context",
                    env: { XDG_DATA_HOME: root },
                    platformReaders,
                });
                for (const result of [await policy.status(), await policy.doctor()]) {
                    expect(result.reason).toBe("unsupported_platform");
                    expect(result.remediation).toBe("use_supported_platform");
                }
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("kernel readiness from host.status metrics", () => {
    const readyBlock = {
        kernel_state: "ready",
        sampled_at_ms: 1_700_000_000_000,
        core_file_bytes: 4096,
        core_file_warn: false,
        artifact_usage_bytes: 0,
        artifact_cap_bytes: 1_048_576,
        artifact_warn: false,
        outbox_position_lag: 0,
        oldest_unconsumed_age_ms: 0,
        retained_outbox_rows: 0,
        required_consumer_count: 1,
        lag_threshold_tripped: false,
    };
    const metricsWith = (kernel: unknown) => ({
        components: {
            "magic-context": {
                metrics: {
                    storage_state: "ready",
                    ...(kernel === undefined ? {} : { kernel }),
                },
            },
        },
    });

    test("a missing block is unknown, never absent or healthy", () => {
        expect(kernelReadiness(metricsWith(undefined))).toEqual({
            state: "unavailable",
            reason: "kernel_unavailable",
        });
        expect(kernelReadiness({})).toEqual({
            state: "unavailable",
            reason: "kernel_unavailable",
        });
    });

    test("a block without a valid kernel_state is unavailable", () => {
        expect(kernelReadiness(metricsWith({}))).toEqual({
            state: "unavailable",
            reason: "kernel_unavailable",
        });
        expect(kernelReadiness(metricsWith({ kernel_state: "degraded" }))).toEqual({
            state: "unavailable",
            reason: "kernel_unavailable",
        });
        expect(kernelReadiness(metricsWith("ready"))).toEqual({
            state: "unavailable",
            reason: "kernel_unavailable",
        });
    });

    test("starting and unavailable states pass through with their reasons", () => {
        expect(kernelReadiness(metricsWith({ kernel_state: "starting" }))).toEqual({
            state: "starting",
            reason: "kernel_starting",
        });
        expect(
            kernelReadiness(
                metricsWith({
                    kernel_state: "unavailable",
                    unavailable_reason: "store_unsupported",
                }),
            ),
        ).toEqual({ state: "unavailable", reason: "kernel_unavailable" });
    });

    test("a ready block with lag past threshold warns as kernel_lagging", () => {
        expect(
            kernelReadiness(
                metricsWith({
                    ...readyBlock,
                    outbox_position_lag: 5000,
                    lag_threshold_tripped: true,
                }),
            ),
        ).toEqual({ state: "ready", reason: "kernel_lagging" });
    });

    test("lag outranks an empty required-consumer set", () => {
        expect(
            kernelReadiness(
                metricsWith({
                    ...readyBlock,
                    required_consumer_count: 0,
                    lag_threshold_tripped: true,
                }),
            ),
        ).toEqual({ state: "ready", reason: "kernel_lagging" });
    });

    test("either capacity flag warns as kernel_capacity_warn", () => {
        expect(kernelReadiness(metricsWith({ ...readyBlock, core_file_warn: true }))).toEqual({
            state: "ready",
            reason: "kernel_capacity_warn",
        });
        expect(kernelReadiness(metricsWith({ ...readyBlock, artifact_warn: true }))).toEqual({
            state: "ready",
            reason: "kernel_capacity_warn",
        });
    });

    test("warn reasons rank lagging over capacity over no required consumer", () => {
        expect(
            kernelReadiness(
                metricsWith({
                    ...readyBlock,
                    artifact_warn: true,
                    required_consumer_count: 0,
                    lag_threshold_tripped: true,
                }),
            ),
        ).toEqual({ state: "ready", reason: "kernel_lagging" });
        expect(
            kernelReadiness(
                metricsWith({ ...readyBlock, artifact_warn: true, required_consumer_count: 0 }),
            ),
        ).toEqual({ state: "ready", reason: "kernel_capacity_warn" });
    });

    test("a ready block with no required consumer warns as no_required_consumer", () => {
        expect(kernelReadiness(metricsWith({ ...readyBlock, required_consumer_count: 0 }))).toEqual(
            { state: "ready", reason: "no_required_consumer" },
        );
    });

    test("a ready block within threshold and with a consumer is healthy", () => {
        expect(kernelReadiness(metricsWith(readyBlock))).toEqual({
            state: "ready",
            reason: "healthy",
        });
        // The sanitizer may drop invalid numeric fields; a bare ready state is
        // still healthy because neither warn signal is asserted.
        expect(kernelReadiness(metricsWith({ kernel_state: "ready" }))).toEqual({
            state: "ready",
            reason: "healthy",
        });
    });
});
