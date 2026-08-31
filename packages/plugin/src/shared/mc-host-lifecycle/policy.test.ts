import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CatalogEntry } from "../mc-host-client";
import type { PlatformReaders } from "./bootstrap";
import { releaseContract } from "./generated-contract";
import { buildManagedCredentialEnvelope } from "./managed-policy";
import {
    aggregateForTarget,
    McHostLifecyclePolicy,
    OUTER_AGGREGATE_MS,
    OUTER_AGGREGATE_MS_DARWIN,
    type WaiterDetachedError,
} from "./policy";

function tempDir(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* */
function authenticatedPeerAt(daemonVer: string) {
    return { daemonVer, daemonId: new Uint8Array([7]), proof: "current" as const };
}

let counter = 0;

function startResultJson(command: string): string {
    return JSON.stringify({
        schema: "magic-context.daemon/v1",
        command,
        ok: true,
        state: "running",
        reason: command === "start" || command === "restart" ? "started" : "healthy",
        remediation: null,
        // A successful restart requires commit evidence.
        effects: command === "restart" ? { stop_committed: true, start_committed: true } : null,
        readiness: { transport: { state: "ready", reason: "healthy" } },
        checks: [],
        versions: {
            release: "0.38.0",
            proof: "current",
            daemon: "mc-host/0.1.0",
            magic_context: null,
            synapse: null,
            broca: null,
        },
    });
}

function missingPayloadResultJson(): string {
    return JSON.stringify({
        schema: "magic-context.daemon/v1",
        command: "start",
        ok: false,
        state: "stopped",
        reason: "native_payload_missing",
        remediation: "install_native_payload",
        effects: null,
        readiness: null,
        checks: [],
        versions: {
            release: "0.38.0",
            proof: null,
            daemon: null,
            magic_context: null,
            synapse: null,
            broca: null,
        },
    });
}

function restartResultJson(): string {
    return JSON.stringify({
        ...JSON.parse(startResultJson("restart")),
        reason: "started",
        effects: { stop_committed: true, start_committed: true },
    });
}

function harnessUnavailableResultJson(): string {
    return JSON.stringify({
        ...JSON.parse(startResultJson("start")),
        ok: false,
        state: "running",
        reason: "harness_unavailable",
        readiness: null,
    });
}

/* */
function fakeBinary(
    dir: string,
    options: { sleepSeconds?: number } = {},
): {
    binary: string;
    invocationLog: string;
} {
    counter += 1;
    const invocationLog = path.join(dir, `invocations-${counter}.log`);
    writeFileSync(invocationLog, "");
    const binary = path.join(dir, `fake-ck-mc-host-${counter}.sh`);
    const sleep = options.sleepSeconds ? `sleep ${options.sleepSeconds}\n` : "";
    writeFileSync(
        binary,
        `#!/bin/sh\necho "$1" >> ${invocationLog}\n${sleep}case "$1" in\n` +
            // The fake binary returns `status` for `probe` to verify command translation.
            // Returning `probe` would not verify the client's translation to `status`.
            // itself.
            `  probe) echo '${startResultJson("status").replace("started", "healthy")}';;\n` +
            // Restart success requires `effects`, which the `sed` replacement cannot add.
            `  restart) echo '${startResultJson("restart")}';;\n` +
            `  *) echo '${startResultJson("start")}' | sed "s/\\"command\\":\\"start\\"/\\"command\\":\\"$1\\"/";;\n` +
            "esac\nexit 0\n",
    );
    chmodSync(binary, 0o700);
    return { binary, invocationLog };
}

function invocations(logPath: string): string[] {
    return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

function policyFor(
    options: ConstructorParameters<typeof McHostLifecyclePolicy>[0],
): McHostLifecyclePolicy {
    return new McHostLifecyclePolicy(options);
}

function catalogEntry(moduleId: string, moduleVersion = "0.1.0"): CatalogEntry {
    return {
        module_id: moduleId,
        module_version: moduleVersion,
        roles: [],
        control_ops: [],
    };
}

const compatibleCatalog = [
    catalogEntry("magic-context"),
    catalogEntry("synapse"),
    catalogEntry("broca"),
];

function compatibleObservation() {
    return {
        authenticatedPeer: authenticatedPeerAt(releaseContract.versions.daemon),
        catalog: compatibleCatalog,
        epochs: { ...releaseContract.epochs },
    };
}

/* */
function unsupportedPlatformReaders(): PlatformReaders {
    return {
        platform: "linux",
        arch: "x64",
        kernelRelease: () => "4.17.0",
        glibcVersion: () => "2.34",
        procSelfFdUsable: () => true,
        macosProductVersion: () => null,
    };
}

describe("pre-native outcomes", () => {
    test("no absolute root: unavailable/no_data_dir, restart effects false,false", async () => {
        const policy = policyFor({ env: { HOME: "relative-home" } });
        for (const op of ["start", "stop", "status", "doctor"] as const) {
            const result = await policy[op]();
            expect(result.state).toBe("unavailable");
            expect(result.reason).toBe("no_data_dir");
            expect(result.remediation).toBe("set_data_directory");
            expect(result.ok).toBe(false);
            expect(result.effects).toBeNull();
        }
        const restart = await policy.restart();
        expect(restart.state).toBe("unavailable");
        expect(restart.effects).toEqual({ stop_committed: false, start_committed: false });
    });

    test("a rejected filesystem is unsupported_filesystem with the classifier state", async () => {
        const root = tempDir("mc-policy-fs-");
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                admissionIo: {
                    platform: "linux",
                    readMounts: () => `remote:/x / nfs4 rw 0 0\n`,
                },
            });
            const result = await policy.status();
            expect(result.reason).toBe("unsupported_filesystem");
            expect(result.remediation).toBe("set_data_directory");
            expect(result.state).toBe("stopped");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("unsupported platforms fail every command before native invocation", async () => {
        const root = tempDir("mc-policy-platform-");
        const { binary, invocationLog } = fakeBinary(root);
        try {
            for (const platformReaders of [
                {
                    platform: "linux" as const,
                    arch: "x64",
                    kernelRelease: () => "4.17.0",
                    glibcVersion: () => "2.34",
                    procSelfFdUsable: () => true,
                    macosProductVersion: () => null,
                },
                {
                    platform: "darwin" as const,
                    arch: "arm64",
                    kernelRelease: () => "23.0.0",
                    glibcVersion: () => null,
                    procSelfFdUsable: () => false,
                    macosProductVersion: () => "13.4",
                },
                {
                    platform: "linux" as const,
                    arch: "arm64",
                    kernelRelease: () => "6.8.0",
                    glibcVersion: () => "2.39",
                    procSelfFdUsable: () => true,
                    macosProductVersion: () => null,
                },
            ]) {
                const policy = policyFor({
                    env: { XDG_DATA_HOME: root },
                    launchTarget: { kind: "test-binary", path: binary },
                    platformReaders,
                });
                for (const operation of ["start", "status", "doctor"] as const) {
                    const result = await policy[operation]();
                    expect(result.reason).toBe("unsupported_platform");
                    expect(result.remediation).toBe("use_supported_platform");
                }
            }
            expect(invocations(invocationLog)).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("filesystem rejection keeps precedence over unsupported platform", async () => {
        const root = tempDir("mc-policy-platform-fs-precedence-");
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                admissionIo: {
                    platform: "linux",
                    readMounts: () => "remote:/x / nfs4 rw 0 0\n",
                },
                platformReaders: unsupportedPlatformReaders(),
            });
            for (const operation of ["status", "doctor"] as const) {
                expect((await policy[operation]()).reason).toBe("unsupported_filesystem");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("an unsupported platform gates status and doctor too", async () => {
        const root = tempDir("mc-policy-platform-observational-");
        const { binary, invocationLog } = fakeBinary(root);
        try {
            const gated = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                platformReaders: unsupportedPlatformReaders(),
            });
            for (const op of ["status", "doctor"] as const) {
                const result = await gated[op]();
                expect(result.reason).toBe("unsupported_platform");
                expect(result.remediation).toBe("use_supported_platform");
                expect(result.ok).toBe(false);
            }
            expect(invocations(invocationLog)).toEqual([]);
            // The probe rejects an unrunnable host before classifying absent probe output.
            const noTarget = policyFor({
                env: { XDG_DATA_HOME: root },
                platformReaders: unsupportedPlatformReaders(),
            });
            const status = await noTarget.status();
            expect(status.reason).toBe("unsupported_platform");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("observational commands without a trusted bootstrap (U3 scenario 21)", () => {
    test("wholly absent roots are stopped/not_running with no mutation", async () => {
        const root = tempDir("mc-policy-absent-");
        try {
            const policy = policyFor({ env: { XDG_DATA_HOME: root } });
            const status = await policy.status();
            expect(status.state).toBe("stopped");
            expect(status.reason).toBe("not_running");
            const doctor = await policy.doctor();
            expect(doctor.state).toBe("stopped");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("residual roots are wedged/native_probe_unavailable and untouched", async () => {
        const root = tempDir("mc-policy-residual-");
        try {
            const coordination = path.join(root, ".mc-host-coordination");
            mkdirSync(coordination);
            writeFileSync(path.join(coordination, "transaction.lock"), "");
            const before = readFileSync(path.join(coordination, "transaction.lock"));
            const policy = policyFor({ env: { XDG_DATA_HOME: root } });
            const status = await policy.status();
            expect(status.state).toBe("wedged");
            expect(status.reason).toBe("native_probe_unavailable");
            expect(status.remediation).toBe("run_daemon_restart");
            expect(readFileSync(path.join(coordination, "transaction.lock"))).toEqual(before);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("mutating commands without any launch target fail with the package reason", async () => {
        const root = tempDir("mc-policy-nopayload-");
        try {
            const policy = policyFor({ env: { XDG_DATA_HOME: root } });
            const result = await policy.start();
            expect(result.reason).toBe("native_payload_missing");
            expect(result.remediation).toBe("install_native_payload");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("native invocation mapping", () => {
    test("managed credential envelopes include only bounded Broca credential names", () => {
        expect(
            buildManagedCredentialEnvelope({
                OPENAI_API_KEY: "secret",
                PATH: "/poisoned",
                EMPTY: "",
            }),
        ).toEqual({
            schema: 1,
            credentials: { OPENAI_API_KEY: "secret" },
        });
    });

    test("native current validation precedes one deferred certified package lookup", async () => {
        const root = tempDir("mc-policy-fallback-");
        const invocationLog = path.join(root, "fallback-invocations.log");
        const binary = path.join(root, "fallback-ck-mc-host.sh");
        writeFileSync(
            binary,
            `#!/bin/sh\necho "$*" >> ${invocationLog}\n` +
                `if [ "$2" != "--payload-dir" ]; then echo '${missingPayloadResultJson()}'; exit 1; fi\n` +
                `echo '${startResultJson("start")}'\nexit 0\n`,
        );
        chmodSync(binary, 0o700);
        let lookups = 0;
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                payloadDirFallback: () => {
                    lookups += 1;
                    return "/qualified/package";
                },
            });

            const result = await policy.start();

            expect(result.reason).toBe("started");
            expect(lookups).toBe(1);
            expect(readFileSync(invocationLog, "utf8").trim().split("\n")).toEqual([
                "start",
                "start --payload-dir /qualified/package",
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("the fallback retry spends what the first launch left, not a fresh aggregate", async () => {
        // `start` shares one request-to-transport aggregate across the initial `native_payload_missing` launch and package-lookup retry; resetting it would double the qualified budget.
        // The initial launch and package lookup share the `start` aggregate budget.
        const root = tempDir("mc-policy-fallback-budget-");
        const invocationLog = path.join(root, "budget-invocations.log");
        const binary = path.join(root, "budget-ck-mc-host.sh");
        // The first launch consumes 1 second before returning `native_payload_missing`; the `--payload-dir` retry succeeds immediately.
        writeFileSync(
            binary,
            `#!/bin/sh\necho "$*" >> ${invocationLog}\n` +
                `if [ "$2" != "--payload-dir" ]; then sleep 1; echo '${missingPayloadResultJson()}'; exit 1; fi\n` +
                `echo '${startResultJson("start")}'\nexit 0\n`,
        );
        chmodSync(binary, 0o700);
        const LOOKUP_MS = 500;
        const AGGREGATE_MS = 20_000;
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                outerAggregateMs: AGGREGATE_MS,
                payloadDirFallback: () => {
                    // Package resolution and hashing are synchronous in production.
                    const until = Date.now() + LOOKUP_MS;
                    while (Date.now() < until) {
                        /* `sleepSeconds` consumes aggregate budget before the retry. */
                    }
                    return "/qualified/package";
                },
            });

            const started = Date.now();
            const result = await policy.start();
            const elapsed = Date.now() - started;

            expect(result.reason).toBe("started");
            expect(readFileSync(invocationLog, "utf8").trim().split("\n")).toEqual([
                "start",
                "start --payload-dir /qualified/package",
            ]);
            // `start` uses one aggregate across both attempts.
            expect(elapsed).toBeLessThan(AGGREGATE_MS);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    test("status and doctor route through the native probe of the trusted target", async () => {
        const root = tempDir("mc-policy-native-");
        const { binary, invocationLog } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
            });
            const status = await policy.status();
            expect(status.command).toBe("status");
            expect(status.state).toBe("running");
            const doctor = await policy.doctor();
            expect(doctor.command).toBe("doctor");
            expect(invocations(invocationLog)).toEqual(["probe", "probe"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("status and doctor derive health from authenticated component readiness", async () => {
        const root = tempDir("mc-policy-readiness-");
        const { binary } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                readinessProbe: async () => ({
                    ...compatibleObservation(),
                    readiness: {
                        transport: { state: "ready", reason: "healthy" },
                        storage: { state: "unavailable", reason: "storage_unavailable" },
                        synapse: { state: "degraded", reason: "synapse_degraded" },
                    },
                }),
            });

            for (const result of [await policy.status(), await policy.doctor()]) {
                expect(result.ok).toBe(false);
                expect(result.reason).toBe("storage_unavailable");
                expect(result.readiness?.storage?.state).toBe("unavailable");
                expect(result.readiness?.synapse?.state).toBe("degraded");
                expect(result.versions.daemon).toBe("mc-host/0.1.0");
                expect(result.checks.map((check) => [check.id, check.status])).toEqual([
                    ["compatibility.daemon", "pass"],
                    ["compatibility.epochs", "pass"],
                    ["compatibility.modules", "pass"],
                    ["readiness.storage", "fail"],
                    ["readiness.synapse", "fail"],
                    ["readiness.transport", "pass"],
                ]);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("status and doctor surface authenticated daemon, module, and epoch mismatches", async () => {
        const cases = [
            {
                reason: "incompatible_daemon",
                observation: {
                    ...compatibleObservation(),
                    authenticatedPeer: authenticatedPeerAt("mc-host/0.2.0"),
                },
                failedCheck: "compatibility.daemon",
            },
            {
                reason: "incompatible_module",
                observation: {
                    ...compatibleObservation(),
                    catalog: compatibleCatalog.map((entry) =>
                        entry.module_id === "magic-context"
                            ? catalogEntry("magic-context", "0.2.0")
                            : entry,
                    ),
                },
                failedCheck: "compatibility.modules",
            },
            {
                reason: "incompatible_epochs",
                observation: {
                    ...compatibleObservation(),
                    epochs: {
                        ...releaseContract.epochs,
                        state_sync: releaseContract.epochs.state_sync + 1,
                    },
                },
                failedCheck: "compatibility.epochs",
            },
        ] as const;

        for (const { reason, observation, failedCheck } of cases) {
            const root = tempDir(`mc-policy-${reason}-`);
            const { binary, invocationLog } = fakeBinary(root);
            try {
                const policy = policyFor({
                    env: { XDG_DATA_HOME: root },
                    launchTarget: { kind: "test-binary", path: binary },
                    readinessProbe: async () => ({
                        ...observation,
                        readiness: {
                            transport: { state: "ready", reason: "healthy" },
                            storage: { state: "ready", reason: "healthy" },
                            synapse: { state: "ready", reason: "healthy" },
                        },
                    }),
                });

                for (const result of [await policy.status(), await policy.doctor()]) {
                    expect(result.ok).toBe(false);
                    expect(result.state).toBe("running");
                    expect(result.reason).toBe(reason);
                    expect(result.remediation).toBe("align_versions");
                    expect(result.checks.find((check) => check.id === failedCheck)).toMatchObject({
                        status: "fail",
                        reason,
                    });
                }
                expect(invocations(invocationLog)).toEqual(["probe", "probe"]);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        }
    });

    test("a short-circuited probe reports no check for an unobserved component", async () => {
        const root = tempDir("mc-policy-unobserved-");
        const { binary } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                // When the daemon stage fails, the probe reports only handshake-proven transport state and does not call `host.status`.
                readinessProbe: async () => ({
                    ...compatibleObservation(),
                    authenticatedPeer: authenticatedPeerAt("mc-host/0.2.0"),
                    catalog: [],
                    epochs: {},
                    evaluatedThrough: "daemon" as const,
                    readiness: { transport: { state: "ready", reason: "healthy" } },
                }),
            });

            for (const result of [await policy.status(), await policy.doctor()]) {
                expect(result.reason).toBe("incompatible_daemon");
                const ids = result.checks.map((check) => check.id);
                expect(ids).toContain("compatibility.daemon");
                // Unobserved stages must not produce failures that override the version-mismatch remediation.
                expect(ids).not.toContain("readiness.storage");
                expect(ids).not.toContain("readiness.synapse");
                // Stages the probe never reached emit no verdict.
                expect(ids).not.toContain("compatibility.modules");
                expect(ids).not.toContain("compatibility.epochs");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a failing readiness probe keeps the observation it already proved", async () => {
        // A readiness failure must not replace a validated observation with an internal error.
        // A readiness failure degrades status without erasing a validated observation.
        // A failed storage probe must degrade status without erasing a successful observation.
        const root = tempDir("mc-policy-readiness-failure-");
        const { binary } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                readinessProbe: async () => {
                    throw new Error("route collapsed mid-probe");
                },
            });
            for (const result of [await policy.status(), await policy.doctor()]) {
                expect(result.ok).toBe(true);
                expect(result.state).toBe("running");
                expect(result.reason).not.toBe("internal_error");
                // A readiness failure adds no probe-derived readiness components.
                expect(result.readiness?.storage).toBeUndefined();
                expect(result.readiness?.synapse).toBeUndefined();
                expect(result.checks.some((check) => check.id.startsWith("readiness."))).toBe(
                    false,
                );
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("the readiness probe is bounded by what the probe child left of the aggregate", async () => {
        // The aggregate bounds both the request and the transport child.
        // The probe receives the aggregate's remaining budget, not a fresh full budget.
        // The client does not start a readiness probe with a 1 ms budget.
        const root = tempDir("mc-policy-readiness-residual-");
        const CHILD_MS = 1_000;
        const AGGREGATE_MS = 20_000;
        const { binary } = fakeBinary(root, { sleepSeconds: CHILD_MS / 1_000 });
        const budgets: number[] = [];
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                outerAggregateMs: AGGREGATE_MS,
                readinessProbe: async (budgetMs) => {
                    budgets.push(budgetMs);
                    return {
                        ...compatibleObservation(),
                        readiness: {
                            transport: { state: "ready", reason: "healthy" },
                        },
                    };
                },
            });
            const result = await policy.status();
            expect(result.ok).toBe(true);
            expect(budgets).toHaveLength(1);
            // The child's second of runtime came out of the aggregate.
            expect(budgets[0]).toBeLessThan(AGGREGATE_MS - CHILD_MS + 1);
            expect(budgets[0]).toBeGreaterThan(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("an authenticated daemon outside the supported range is never healthy", async () => {
        // Readiness reports component service, not client-daemon compatibility.
        // Compatibility prevents unsupported daemons from reporting `healthy`.
        // `proof: "current"` must not endorse an unsupported daemon version.
        const root = tempDir("mc-policy-incompatible-daemon-");
        const { binary } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                readinessProbe: async () => ({
                    ...compatibleObservation(),
                    authenticatedPeer: authenticatedPeerAt("mc-host/9.9.9"),
                    readiness: {
                        transport: { state: "ready", reason: "healthy" },
                        storage: { state: "ready", reason: "healthy" },
                    },
                }),
            });
            for (const result of [await policy.status(), await policy.doctor()]) {
                expect(result.ok).toBe(false);
                expect(result.reason).toBe("incompatible_daemon");
                expect(result.remediation).toBe("align_versions");
                expect(
                    result.checks.find((check) => check.id === "compatibility.daemon")?.status,
                ).toBe("fail");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("the reported readiness reason follows contract precedence, not check-id order", async () => {
        const root = tempDir("mc-policy-readiness-precedence-");
        const { binary } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                readinessProbe: async () => ({
                    ...compatibleObservation(),
                    readiness: {
                        // `authentication_failed` outranks `storage_unavailable` in failing-reason precedence.
                        transport: { state: "unavailable", reason: "authentication_failed" },
                        storage: { state: "unavailable", reason: "storage_unavailable" },
                        synapse: { state: "degraded", reason: "synapse_degraded" },
                    },
                }),
            });

            for (const result of [await policy.status(), await policy.doctor()]) {
                expect(result.ok).toBe(false);
                expect(result.reason).toBe("authentication_failed");
                expect(result.remediation).toBe("inspect_daemon_process");
                // The check list is lexicographically sorted by `id`.
                // Check IDs are unique and lexicographically sorted.
                expect(result.checks.map((check) => check.id)).toEqual([
                    "compatibility.daemon",
                    "compatibility.epochs",
                    "compatibility.modules",
                    "readiness.storage",
                    "readiness.synapse",
                    "readiness.transport",
                ]);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    test("restart resolves the certified payload before one native transaction", async () => {
        const root = tempDir("mc-policy-restart-payload-");
        const invocationLog = path.join(root, "restart-invocations.log");
        const binary = path.join(root, "restart-ck-mc-host.sh");
        writeFileSync(
            binary,
            `#!/bin/sh\necho "$*" >> ${invocationLog}\necho '${restartResultJson()}'\nexit 0\n`,
        );
        chmodSync(binary, 0o700);
        let lookups = 0;
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                payloadDirFallback: () => {
                    lookups += 1;
                    return "/qualified/package";
                },
            });
            const result = await policy.restart();
            expect(result.effects).toEqual({
                stop_committed: true,
                start_committed: true,
            });
            expect(lookups).toBe(1);
            expect(readFileSync(invocationLog, "utf8").trim()).toBe(
                "restart --payload-dir /qualified/package",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a joiner with a non-finite deadline is rejected without cancelling the start", async () => {
        // Joiners reject non-finite budgets before calling `raceWaiter`.
        // A non-finite budget survives residual subtraction and reaches `setTimeout`.
        // A shared start that settles within one microtask drain lets an invalid-budget joiner adopt its result.
        // An invalid-budget joiner must reject even when a shared result is available.
        // Invalid-budget calls must not depend on whether another demand is in flight.
        // `launchTarget: null` makes `start()` return a local result.
        // without spawning.
        const root = tempDir("mc-policy-joiner-deadline-");
        try {
            const policy = policyFor({ env: { XDG_DATA_HOME: root }, launchTarget: null });
            // Creating the demands in the same tick leaves the local start in flight for the joiners.
            const creator = policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
                deadlineMs: 20_000,
            });
            expect(policy.inflightStartCount).toBe(1);

            const joinerOutcomes: string[] = [];
            for (const deadlineMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
                try {
                    const outcome = await policy.demandStart({
                        origin: "managed-default",
                        capability: "magic-context",
                        deadlineMs,
                    });
                    joinerOutcomes.push(`adopted:${outcome.result.reason}`);
                } catch (error) {
                    joinerOutcomes.push(`detached:${(error as WaiterDetachedError).cause_kind}`);
                }
            }
            expect(joinerOutcomes).toEqual([
                "detached:deadline",
                "detached:deadline",
                "detached:deadline",
                "detached:deadline",
            ]);

            // Rejecting a joiner detaches it without cancelling the creator's start.
            const outcome = await creator;
            expect(outcome.result.reason).toBe("native_payload_missing");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    test("an already-inactive first demand never spawns the daemon", async () => {
        // `start()` reaches `spawn()` through `runNativeLifecycle` before its first `await`.
        // Detaching only in `raceWaiter` leaves a mutating child running after its caller exits.
        const root = tempDir("mc-policy-inactive-demand-");
        try {
            const { binary, invocationLog } = fakeBinary(root);
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
            });
            const aborted = AbortSignal.abort();
            let abortKind: string | null = null;
            try {
                await policy.demandStart({
                    origin: "managed-default",
                    capability: "magic-context",
                    signal: aborted,
                });
            } catch (error) {
                abortKind = (error as WaiterDetachedError).cause_kind;
            }
            expect(abortKind).toBe("aborted");

            let deadlineKind: string | null = null;
            try {
                await policy.demandStart({
                    origin: "managed-default",
                    capability: "magic-context",
                    deadlineMs: 0,
                });
            } catch (error) {
                deadlineKind = (error as WaiterDetachedError).cause_kind;
            }
            expect(deadlineKind).toBe("deadline");

            // `NaN` remains non-finite after residual subtraction.
            // `setTimeout` coerces non-finite delays.
            // setTimeout coerces Infinity to a 1 ms delay, so the waiter detaches immediately.
            // The detached waiter leaves the start unowned.
            for (const deadlineMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
                let kind: string | null = null;
                try {
                    await policy.demandStart({
                        origin: "managed-default",
                        capability: "magic-context",
                        deadlineMs,
                    });
                } catch (error) {
                    kind = (error as WaiterDetachedError).cause_kind;
                }
                expect(kind).toBe("deadline");
            }

            expect(invocations(invocationLog)).toEqual([]);
            expect(policy.inflightStartCount).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("preflight time is deducted from the native aggregate", async () => {
        // The aggregate bounds request-to-transport time, so synchronous preflight consumes the child's budget.
        // Synchronous preflight reduces the child's aggregate budget rather than starting a fresh budget.
        // If preflight exhausts the aggregate, the command times out before launch.
        // Because no child was spawned, restart reports no committed effects rather than unknown effects.
        const root = tempDir("mc-policy-preflight-budget-");
        try {
            const { binary, invocationLog } = fakeBinary(root);
            const SYNC_MS = 300;
            const slowGate: PlatformReaders = {
                platform: "linux",
                arch: "x64",
                kernelRelease: () => "6.1.0",
                glibcVersion: () => {
                    const until = Date.now() + SYNC_MS;
                    while (Date.now() < until) {
                        /* The stub replaces Darwin's `sw_vers` fallback. */
                    }
                    return "2.34";
                },
                procSelfFdUsable: () => true,
                macosProductVersion: () => null,
            };
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                platformReaders: slowGate,
                // outerAggregateMs is smaller than the synchronous preflight cost, so no residual budget remains.
                outerAggregateMs: SYNC_MS / 3,
            });
            const result = await policy.start();
            expect(result.reason).toBe("startup_timeout");
            expect(result.ok).toBe(false);
            expect(invocations(invocationLog)).toEqual([]);

            const restartPolicy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                platformReaders: slowGate,
                outerAggregateMs: SYNC_MS / 3,
            });
            const restart = await restartPolicy.restart();
            expect(restart.reason).toBe("startup_timeout");
            expect(restart.effects).toEqual({ stop_committed: false, start_committed: false });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("each qualified target gets the aggregate it was qualified for", () => {
        // release/mc-host-production-inputs.lock.json qualifies
        // The Linux hard aggregate is 60 s and the macOS hard aggregate is 15 s.
        // Applying the 60 s Linux aggregate on Darwin allows startup to exceed Darwin's 15 s budget by four times.
        expect(aggregateForTarget("linux-x64-gnu")).toBe(60_000);
        expect(aggregateForTarget("darwin-arm64")).toBe(15_000);
        expect(aggregateForTarget("darwin-x64")).toBe(15_000);
        expect(OUTER_AGGREGATE_MS_DARWIN).toBeLessThan(OUTER_AGGREGATE_MS);
    });

    test("an explicit aggregate still overrides the platform default", async () => {
        // The explicit override takes precedence over the platform-derived value.
        const root = tempDir("mc-policy-aggregate-override-");
        try {
            const { binary } = fakeBinary(root, { sleepSeconds: 30 });
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                outerAggregateMs: 400,
            });
            const started = Date.now();
            const result = await policy.start();
            // The injected 400 ms deadline kills the child before either platform default.
            expect(Date.now() - started).toBeLessThan(10_000);
            expect(result.reason).toBe("startup_timeout");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("restart is one native transaction, never TS stop+start", async () => {
        const root = tempDir("mc-policy-restart-");
        const { binary, invocationLog } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
            });
            const result = await policy.restart();
            expect(result.command).toBe("restart");
            // `command` alone cannot prove native restart acceptance because `launchFailure` copies the caller's `command` into its `internal_error` result.
            // `ok`, `reason`, and `effects` prove native restart acceptance.
            expect(result.ok).toBe(true);
            expect(result.reason).toBe("started");
            expect(result.effects).toEqual({ stop_committed: true, start_committed: true });
            expect(invocations(invocationLog)).toEqual(["restart"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("restart sends the default credential envelope", async () => {
        const root = tempDir("mc-policy-restart-envelope-");
        const envelopeLog = path.join(root, "restart-envelope.json");
        const binary = path.join(root, "restart-envelope-ck-mc-host.sh");
        writeFileSync(
            binary,
            `#!/bin/sh\ncat > ${envelopeLog}\necho '${restartResultJson()}'\nexit 0\n`,
        );
        chmodSync(binary, 0o700);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                defaultStartupEnvelope: {
                    schema: 1,
                    credentials: { OPENAI_API_KEY: "preserved-secret" },
                },
            });
            const result = await policy.restart();
            expect(result.ok).toBe(true);
            expect(JSON.parse(readFileSync(envelopeLog, "utf8"))).toEqual({
                schema: 1,
                credentials: { OPENAI_API_KEY: "preserved-secret" },
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("demand-start coalescing and detachment (U3 scenarios 15-16)", () => {
    test("compatibility mismatch blocks readiness without stop, restart, or a second start", async () => {
        const cases = [
            {
                reason: "incompatible_daemon",
                observation: {
                    ...compatibleObservation(),
                    authenticatedPeer: authenticatedPeerAt("mc-host/0.2.0"),
                },
            },
            {
                reason: "incompatible_module",
                observation: {
                    ...compatibleObservation(),
                    catalog: compatibleCatalog.map((entry) =>
                        entry.module_id === "synapse" ? catalogEntry("synapse", "0.2.0") : entry,
                    ),
                },
            },
            {
                reason: "incompatible_epochs",
                observation: {
                    ...compatibleObservation(),
                    epochs: {
                        ...releaseContract.epochs,
                        memory_render: releaseContract.epochs.memory_render - 1,
                    },
                },
            },
        ] as const;

        for (const { reason, observation } of cases) {
            const root = tempDir(`mc-policy-demand-${reason}-`);
            const { binary, invocationLog } = fakeBinary(root);
            let storageProbes = 0;
            try {
                const policy = policyFor({
                    env: { XDG_DATA_HOME: root },
                    launchTarget: { kind: "test-binary", path: binary },
                    compatibilityProbe: async () => observation,
                    storageProbe: async () => {
                        storageProbes += 1;
                        return "ready";
                    },
                });
                const outcome = await policy.demandStart({
                    origin: "managed-default",
                    capability: "magic-context",
                });

                expect(outcome.result.ok).toBe(false);
                expect(outcome.result.state).toBe("running");
                expect(outcome.result.reason).toBe(reason);
                expect(outcome.result.remediation).toBe("align_versions");
                expect(outcome.storage).toBeNull();
                expect(storageProbes).toBe(0);
                expect(invocations(invocationLog)).toEqual(["start"]);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        }
    });

    test("concurrent demands share one compatibility probe", async () => {
        const root = tempDir("mc-policy-probe-coalesce-");
        const { binary } = fakeBinary(root);
        let probes = 0;
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                compatibilityProbe: async () => {
                    probes += 1;
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    return compatibleObservation();
                },
            });

            // Snapshots describe daemon incarnations, not capabilities, so distinct capabilities share one probe.
            const outcomes = await Promise.all([
                policy.demandStart({ origin: "managed-default", capability: "magic-context" }),
                policy.demandStart({ origin: "managed-default", capability: "synapse" }),
            ]);

            for (const outcome of outcomes) {
                expect(outcome.result.ok).toBe(true);
                expect(outcome.authenticatedDaemonId).toEqual(new Uint8Array([7]));
            }
            expect(probes).toBe(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("the shared compatibility probe budget does not come from the creating waiter", async () => {
        const root = tempDir("mc-policy-probe-budget-");
        const { binary } = fakeBinary(root);
        const budgets: number[] = [];
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                outerAggregateMs: 30_000,
                compatibilityProbe: async (budgetMs) => {
                    budgets.push(budgetMs);
                    return compatibleObservation();
                },
            });
            const outcome = await policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
                deadlineMs: 5_000,
            });

            // A nearly expired caller must not create a probe that long-lived waiters join.
            // Long-lived waiters would treat a truncated probe failure as unproven compatibility.
            // `raceDetached` bounds each caller's wait by that caller's deadline.
            expect(budgets).toEqual([30_000]);
            expect(outcome.result.ok).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a failed compatibility probe becomes a typed closed result, not a raw rejection", async () => {
        const root = tempDir("mc-policy-probe-failure-");
        const { binary, invocationLog } = fakeBinary(root);
        let storageProbes = 0;
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                compatibilityProbe: async () => {
                    throw new Error("authenticated peer changed during compatibility probe");
                },
                storageProbe: async () => {
                    storageProbes += 1;
                    return "ready";
                },
            });
            const outcome = await policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
            });

            // An unproven compatibility claim authorizes no application traffic.
            // Callers receive a typed reason instead of a raw rejection.
            expect(outcome.result.ok).toBe(false);
            expect(outcome.result.reason).toBe("native_probe_unavailable");
            expect(outcome.result.remediation).toBe("run_daemon_restart");
            expect(outcome.authenticatedDaemonId).toBeUndefined();
            expect(outcome.storage).toBeNull();
            expect(storageProbes).toBe(0);
            expect(invocations(invocationLog)).toEqual(["start"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("storage readiness read on another incarnation is refused, not reported", async () => {
        const root = tempDir("mc-policy-storage-rotation-");
        const { binary, invocationLog } = fakeBinary(root);
        const expectations: Array<Uint8Array | undefined> = [];
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                compatibilityProbe: async () => compatibleObservation(),
                storageProbe: async (_budgetMs, expectedDaemonId) => {
                    expectations.push(expectedDaemonId);
                    throw new Error(
                        "storage probe observed a different daemon than compatibility certified",
                    );
                },
            });
            const outcome = await policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
            });

            // The probe receives the certified daemon incarnation.
            // A readiness failure does not invalidate compatibility.
            // Unavailable storage blocks application traffic.
            expect(expectations).toEqual([new Uint8Array([7])]);
            expect(outcome.result.ok).toBe(true);
            expect(outcome.storage).toBe("unavailable");
            expect(outcome.authenticatedDaemonId).toEqual(new Uint8Array([7]));
            expect(invocations(invocationLog)).toEqual(["start"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("managed harness mismatch never preempts the running daemon", async () => {
        const root = tempDir("mc-policy-converge-");
        const invocationLog = path.join(root, "converge-invocations.log");
        const binary = path.join(root, "converge-ck-mc-host.sh");
        writeFileSync(
            binary,
            `#!/bin/sh\necho "$1" >> ${invocationLog}\n` +
                `if [ "$1" = "start" ]; then echo '${harnessUnavailableResultJson()}'; exit 1; fi\n` +
                `echo '${restartResultJson()}'\nexit 0\n`,
        );
        chmodSync(binary, 0o700);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
            });
            const outcome = await policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
                startupEnvelope: {
                    schema: 1,
                    credentials: { OPENAI_API_KEY: "shared-secret" },
                },
            });
            expect(outcome.result.command).toBe("start");
            expect(outcome.result.reason).toBe("harness_unavailable");
            expect(outcome.result.effects).toBeNull();
            expect(invocations(invocationLog)).toEqual(["start"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("non-managed origins are refused before any work", async () => {
        const policy = policyFor({ env: { HOME: "/nonexistent-home" } });
        for (const origin of ["explicit", "injected"] as const) {
            let rejected = false;
            try {
                await policy.demandStart({ origin, capability: "magic-context" });
            } catch {
                rejected = true;
            }
            expect(rejected).toBe(true);
        }
    });

    test("concurrent managed demands share one native start", async () => {
        const root = tempDir("mc-policy-coalesce-");
        const { binary, invocationLog } = fakeBinary(root, { sleepSeconds: 1 });
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                storageProbe: async () => "ready",
            });
            const [a, b, c] = await Promise.all([
                policy.demandStart({ origin: "managed-default", capability: "magic-context" }),
                policy.demandStart({ origin: "managed-default", capability: "magic-context" }),
                policy.demandStart({ origin: "managed-default", capability: "magic-context" }),
            ]);
            expect(a.result.reason).toBe("started");
            expect(b.result.reason).toBe("started");
            expect(c.result.reason).toBe("started");
            expect(a.storage).toBe("ready");
            expect(invocations(invocationLog)).toEqual(["start"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("demands for different capabilities share the one host of their data root", async () => {
        const root = tempDir("mc-policy-coalesce-capability-");
        const { binary, invocationLog } = fakeBinary(root, { sleepSeconds: 1 });
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                storageProbe: async () => "ready",
            });
            const [magic, synapse] = await Promise.all([
                policy.demandStart({ origin: "managed-default", capability: "magic-context" }),
                policy.demandStart({ origin: "managed-default", capability: "synapse" }),
            ]);
            expect(magic.result.reason).toBe("started");
            expect(synapse.result.reason).toBe("started");
            // One daemon serves every capability.
            // A capability-keyed second start would race the first for the transaction lock.
            expect(invocations(invocationLog)).toEqual(["start"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("a detaching waiter neither cancels the start nor blocks later waiters", async () => {
        const root = tempDir("mc-policy-detach-");
        const { binary, invocationLog } = fakeBinary(root, { sleepSeconds: 1 });
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
            });
            const controller = new AbortController();
            const cancelled = policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
                signal: controller.signal,
            });
            const deadline = policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
                deadlineMs: 50,
            });
            const survivor = policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
            });
            controller.abort();
            let cancelledKind: string | null = null;
            try {
                await cancelled;
            } catch (error) {
                cancelledKind = (error as WaiterDetachedError).cause_kind;
            }
            let deadlineKind: string | null = null;
            try {
                await deadline;
            } catch (error) {
                deadlineKind = (error as WaiterDetachedError).cause_kind;
            }
            expect(cancelledKind).toBe("aborted");
            expect(deadlineKind).toBe("deadline");
            const outcome = await survivor;
            expect(outcome.result.reason).toBe("started");
            expect(invocations(invocationLog)).toEqual(["start"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("the caller deadline also bounds storage readiness", async () => {
        // An expired waiter releases its timer and abort listener while the shared start continues.
        // The storage probe needs its own bound after the waiter detaches.
        // Without its own bound, the storage probe can keep the shared start pending after the waiter detaches.
        // Caller expiry detaches the caller even after the shared start succeeds.
        // The shared start can succeed after the caller expires.
        const root = tempDir("mc-policy-storage-deadline-");
        const { binary } = fakeBinary(root);
        const budgets: number[] = [];
        const CALLER_BUDGET_MS = 1_000;
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                storageProbe: async (budgetMs) => {
                    budgets.push(budgetMs);
                    // The shared start outlasts both the caller budget and `STORAGE_HARD_BUDGET_MS`.
                    await new Promise((resolve) => setTimeout(resolve, 30_000));
                    return "ready";
                },
            });
            await expect(
                policy.demandStart({
                    origin: "managed-default",
                    capability: "magic-context",
                    deadlineMs: CALLER_BUDGET_MS,
                }),
            ).rejects.toMatchObject({
                name: "WaiterDetachedError",
                cause_kind: "deadline",
            });
            // The caller's residual budget bounded the probe, not the 5s hard cap.
            expect(budgets).toHaveLength(1);
            expect(budgets[0]).toBeLessThanOrEqual(CALLER_BUDGET_MS);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("caller cancellation during storage readiness stays detached", async () => {
        const root = tempDir("mc-policy-storage-abort-");
        const { binary } = fakeBinary(root);
        const controller = new AbortController();
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                storageProbe: () => {
                    queueMicrotask(() => controller.abort());
                    return new Promise<never>(() => {});
                },
            });

            await expect(
                policy.demandStart({
                    origin: "managed-default",
                    capability: "magic-context",
                    signal: controller.signal,
                }),
            ).rejects.toMatchObject({
                name: "WaiterDetachedError",
                cause_kind: "aborted",
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("the waiter budget is spent from the call, not from after preflight", async () => {
        // `start()` runs its synchronous prefix before returning its promise.
        // Measure `deadlineMs` before `start()` because its synchronous prefix consumes caller budget.
        // `this.start()` runs its synchronous prefix before the waiter receives its promise.
        // Arming the full `deadlineMs` after `this.start()` would ignore time spent in its synchronous prefix.
        // A caller whose budget expires before waiter attachment must not receive a successful result.
        const root = tempDir("mc-policy-residual-");
        try {
            const { binary } = fakeBinary(root, {});
            const SYNC_MS = 400;
            const slowGate: PlatformReaders = {
                platform: "linux",
                arch: "x64",
                kernelRelease: () => "6.1.0",
                glibcVersion: () => {
                    const until = Date.now() + SYNC_MS;
                    while (Date.now() < until) {
                        /* The synchronous prefix can exhaust the caller's budget before the waiter attaches. */
                    }
                    return "2.34";
                },
                procSelfFdUsable: () => true,
                macosProductVersion: () => null,
            };
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                platformReaders: slowGate,
            });
            let kind: string | null = null;
            let accepted: string | null = null;
            try {
                const outcome = await policy.demandStart({
                    origin: "managed-default",
                    capability: "magic-context",
                    deadlineMs: SYNC_MS / 4,
                });
                accepted = outcome.result.reason;
            } catch (error) {
                kind = (error as WaiterDetachedError).cause_kind;
            }
            // If the budget is exhausted when the waiter attaches, the waiter must detach.
            // The waiter must detach rather than accept a start that resolves after its budget expires.
            expect(accepted).toBeNull();
            expect(kind).toBe("deadline");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("an already-expired deadline detaches instead of taking a settled result", async () => {
        // The guard rejects a shared start that settles during `start()`'s synchronous prefix.
        // Only the guard can prevent a waiter from accepting a shared start settled before attachment.
        // The guard must prevent the shared start's microtask from beating the timer.
        const policy = policyFor({ env: { HOME: "relative-home" } });
        for (const deadlineMs of [0, -50]) {
            let kind: string | null = null;
            try {
                await policy.demandStart({
                    origin: "managed-default",
                    capability: "magic-context",
                    deadlineMs,
                });
            } catch (error) {
                kind = (error as WaiterDetachedError).cause_kind;
            }
            expect(kind).toBe("deadline");
        }
    });

    test("settled shared promises are evicted: a later demand starts again", async () => {
        const root = tempDir("mc-policy-evict-");
        const { binary, invocationLog } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
            });
            await policy.demandStart({ origin: "managed-default", capability: "magic-context" });
            expect(policy.inflightStartCount).toBe(0);
            await policy.demandStart({ origin: "managed-default", capability: "magic-context" });
            expect(invocations(invocationLog)).toEqual(["start", "start"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("storage readiness rides the outcome for magic-context capability only", async () => {
        const root = tempDir("mc-policy-storage-");
        const { binary } = fakeBinary(root);
        try {
            const probes: number[] = [];
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                storageProbe: async (budgetMs) => {
                    probes.push(budgetMs);
                    return "starting";
                },
            });
            const magic = await policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
            });
            expect(magic.storage).toBe("starting");
            expect(probes).toEqual([5_000]);
            const synapse = await policy.demandStart({
                origin: "managed-default",
                capability: "synapse",
            });
            expect(synapse.storage).toBeNull();
            expect(probes).toEqual([5_000]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("an unwired storage probe reports unavailable, never ready", async () => {
        const root = tempDir("mc-policy-storage-default-");
        const { binary } = fakeBinary(root);
        try {
            // Without `storageProbe`, the gate must not authorize a body because storage was never examined.
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
            });
            const outcome = await policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
            });
            expect(outcome.result.ok).toBe(true);
            expect(outcome.storage).toBe("unavailable");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("a hanging storage probe detaches at the caller deadline", async () => {
        const root = tempDir("mc-policy-storage-hang-");
        const { binary } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                // The hanging probe never settles; the policy deadline ends the wait.
                storageProbe: () => new Promise<never>(() => {}),
            });
            await expect(
                policy.demandStart({
                    origin: "managed-default",
                    capability: "magic-context",
                    deadlineMs: 250,
                }),
            ).rejects.toMatchObject({
                name: "WaiterDetachedError",
                cause_kind: "deadline",
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("a rejecting storage probe still returns the successful start result", async () => {
        const root = tempDir("mc-policy-storage-reject-");
        const { binary } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                storageProbe: async () => {
                    throw new Error("probe exploded");
                },
            });
            const outcome = await policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
            });
            expect(outcome.result.reason).toBe("started");
            expect(outcome.storage).toBe("unavailable");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("a synchronously throwing storage probe degrades to unavailable", async () => {
        const root = tempDir("mc-policy-storage-throw-sync-");
        const { binary } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                // `storageProbe()` can throw before `.then()` attaches a rejection handler.
                storageProbe: () => {
                    throw new Error("probe exploded synchronously");
                },
            });
            const outcome = await policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
            });
            expect(outcome.result.reason).toBe("started");
            expect(outcome.storage).toBe("unavailable");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);
});

describe("native result labeling and indeterminate effects", () => {
    test("a child answering a different command is internal_error, not relabeled", async () => {
        const root = tempDir("mc-policy-mislabel-");
        try {
            // For a `start` request, the responder returns `stop`, so the label check detects the mismatch.
            // A `stop` response passes the contract's command union before the label check rejects it.
            // The label check, rather than payload parsing, rejects the mismatched command.
            // schema.
            const binary = path.join(root, "mislabeling-host.sh");
            writeFileSync(
                binary,
                `#!/bin/sh\necho '${startResultJson("stop").replace("started", "stopped")}'\nexit 0\n`,
            );
            chmodSync(binary, 0o700);
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
            });
            const result = await policy.start();
            expect(result.command).toBe("start");
            expect(result.ok).toBe(false);
            expect(result.reason).toBe("internal_error");
            // The responder must not return a `restart` payload with a `start` label.
            expect(result.effects).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("a restart killed at the deadline reports unknown effects, not false,false", async () => {
        const root = tempDir("mc-policy-restart-timeout-");
        try {
            const binary = path.join(root, "hanging-host.sh");
            writeFileSync(binary, "#!/bin/sh\nsleep 30\n");
            chmodSync(binary, 0o700);
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                outerAggregateMs: 250,
            });
            const result = await policy.restart();
            expect(result.command).toBe("restart");
            expect(result.reason).toBe("startup_timeout");
            // SIGKILL interrupted the native transaction; the stop may have committed, so its effects are unknown.
            // The stop may already have committed, so its effects are unknown.
            expect(result.effects).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("a child killed at the deadline reports the reason its command earned", async () => {
        const root = tempDir("mc-policy-timeout-reasons-");
        try {
            const binary = path.join(root, "hanging-host.sh");
            writeFileSync(binary, "#!/bin/sh\nsleep 30\n");
            chmodSync(binary, 0o700);
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                outerAggregateMs: 250,
            });
            const expected = {
                start: "startup_timeout",
                restart: "startup_timeout",
                stop: "shutdown_timeout",
                // A read-only probe ran out of time; no startup was attempted.
                status: "native_probe_unavailable",
                doctor: "native_probe_unavailable",
            } as const;
            for (const op of ["start", "restart", "stop", "status", "doctor"] as const) {
                const result = await policy[op]();
                expect(result.command).toBe(op);
                expect(result.reason).toBe(expected[op]);
                // wholly absent.
                expect(result.state).toBe("stopped");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);
});
