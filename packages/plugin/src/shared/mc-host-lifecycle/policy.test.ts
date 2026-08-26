import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildManagedCredentialEnvelope } from "./managed-policy";
import { McHostLifecyclePolicy, type WaiterDetachedError } from "./policy";

function tempDir(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), prefix));
}

let counter = 0;

function startResultJson(command: string): string {
    return JSON.stringify({
        schema: "magic-context.daemon/v1",
        command,
        ok: true,
        state: "running",
        reason: command === "start" ? "started" : "healthy",
        remediation: null,
        effects: null,
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

/** A fake ck-mc-host recording each invocation and emitting one result. */
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
            `  probe) echo '${startResultJson("probe").replace("started", "healthy")}';;\n` +
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

    test("an unsupported platform fails before any native invocation", async () => {
        const root = tempDir("mc-policy-platform-");
        const { binary, invocationLog } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                platformReaders: {
                    platform: "linux",
                    arch: "x64",
                    kernelRelease: () => "4.17.0",
                    glibcVersion: () => "2.34",
                    procSelfFdUsable: () => true,
                    macosProductVersion: () => null,
                },
            });
            const result = await policy.start();
            expect(result.reason).toBe("unsupported_platform");
            expect(invocations(invocationLog)).toEqual([]);
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
                    authenticatedDaemonVersion: "mc-host/0.1.0",
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
                    ["readiness.storage", "fail"],
                    ["readiness.synapse", "fail"],
                    ["readiness.transport", "pass"],
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

    test("the caller deadline and abort signal also bound storage readiness", async () => {
        const root = tempDir("mc-policy-storage-deadline-");
        const { binary } = fakeBinary(root);
        const budgets: number[] = [];
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                storageProbe: async (budgetMs) => {
                    budgets.push(budgetMs);
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    return "ready";
                },
            });
            await expect(
                policy.demandStart({
                    origin: "managed-default",
                    capability: "magic-context",
                    deadlineMs: 20,
                }),
            ).rejects.toMatchObject({ cause_kind: "deadline" });
            expect(budgets).toHaveLength(1);
            expect(budgets[0]).toBeLessThanOrEqual(20);
        } finally {
            rmSync(root, { recursive: true, force: true });
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
});
