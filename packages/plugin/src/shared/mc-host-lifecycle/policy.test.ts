import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatformReaders } from "./bootstrap";
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
            // The real binary accepts the `probe` argv but answers `status`,
            // the contracted name for the read-only observation. A fixture that
            // echoed `probe` back would only prove the client agrees with
            // itself.
            `  probe) echo '${startResultJson("status").replace("started", "healthy")}';;\n` +
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

/** A Linux host whose kernel sits below the contract floor. */
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

    test("an unsupported platform fails before any native invocation", async () => {
        const root = tempDir("mc-policy-platform-");
        const { binary, invocationLog } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                platformReaders: unsupportedPlatformReaders(),
            });
            const result = await policy.start();
            expect(result.reason).toBe("unsupported_platform");
            expect(invocations(invocationLog)).toEqual([]);
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
            // Without a launch target the platform rejection still outranks the
            // no-probe classifier: an unrunnable host has no daemon state.
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
});

describe("demand-start coalescing and detachment (U3 scenarios 15-16)", () => {
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
            // One daemon serves every capability, so a capability-keyed second
            // start would race the first for the transaction lock.
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

    test("the waiter budget is spent from the call, not from after preflight", async () => {
        // `start()` is async, but its synchronous prefix — root resolution,
        // filesystem admission, and the platform gate — runs inside the
        // `this.start()` call, before the promise reaches the waiter. If the
        // waiter armed the full `deadlineMs` at that point, a caller whose
        // budget was already spent would still be handed a successful result.
        const root = tempDir("mc-policy-residual-");
        try {
            const { binary } = fakeBinary(root, {});
            const SYNC_MS = 400;
            const slowGate: PlatformReaders = {
                platform: "linux",
                arch: "x64",
                kernelRelease: () => "6.1.0",
                glibcVersion: () => {
                    // Synchronous, like the darwin `sw_vers` fallback this
                    // stands in for.
                    const until = Date.now() + SYNC_MS;
                    while (Date.now() < until) {
                        /* burn the caller's budget before the waiter attaches */
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
            // The budget was already gone when the waiter attached, so it must
            // detach rather than accept the start that lands right after.
            expect(accepted).toBeNull();
            expect(kind).toBe("deadline");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("an already-expired deadline detaches instead of taking a settled result", async () => {
        // This root resolution fails synchronously, so the shared start is
        // already settled when the waiter attaches and only the guard can stop
        // its microtask from beating the timer.
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
            // No storageProbe: the gate must not authorize a body on a daemon
            // whose storage state was never examined.
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

    test("a hanging storage probe is bounded and degrades to unavailable", async () => {
        const root = tempDir("mc-policy-storage-hang-");
        const { binary } = fakeBinary(root);
        try {
            const policy = policyFor({
                env: { XDG_DATA_HOME: root },
                launchTarget: { kind: "test-binary", path: binary },
                // Never settles; the policy's own bound must end the wait.
                storageProbe: () => new Promise<never>(() => {}),
            });
            const outcome = await policy.demandStart({
                origin: "managed-default",
                capability: "magic-context",
                deadlineMs: 250,
            });
            expect(outcome.result.ok).toBe(true);
            expect(outcome.storage).toBe("unavailable");
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
                // Throws before it ever returns a promise, so no rejection
                // handler on the probe can catch it.
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
            // Always answers `stop`, whatever it was asked. `stop` is inside the
            // contract's command union, so the payload parses and the
            // disagreement is caught by the label check rather than by the
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
            // Never a `restart` payload wearing a `start` label.
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
            // The native transaction was SIGKILLed mid-flight: the stop may
            // already have committed, so its effects are unknown.
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
                // The classifier state travels unchanged: these roots are
                // wholly absent.
                expect(result.state).toBe("stopped");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);
});
