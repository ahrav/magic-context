import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthenticatedPeer, CatalogEntry } from "../mc-host-client";
import { evaluateCompatibility } from "./compatibility";
import { releaseContract } from "./generated-contract";
import {
    createManagedLifecyclePolicy,
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
 * Host-health metrics carry wire epoch names, which differ from the contract
 * names; building the fixture from the wire spelling is what makes the probe's
 * mapping observable instead of silently yielding an empty epoch set.
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

        // Without a per-request bound the client would start a fresh full-length
        // request budget here, letting the probe overrun the aggregate deadline
        // its caller promised.
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
