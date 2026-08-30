import { describe, expect, test } from "bun:test";
import {
    type DaemonReason,
    type DaemonResultV1,
    type LifecycleCommand,
    McHostLifecyclePolicy,
    releaseContract,
} from "@magic-context/core/shared/mc-host-lifecycle";
import { type DaemonCommandDependencies, renderDaemonHuman, runDaemonCommand } from "./daemon";

function result(
    command: LifecycleCommand,
    overrides: Partial<DaemonResultV1> = {},
): DaemonResultV1 {
    return {
        schema: "magic-context.daemon/v1",
        command,
        ok: true,
        state: "running",
        reason: "healthy",
        remediation: null,
        effects: command === "restart" ? { stop_committed: true, start_committed: true } : null,
        readiness: null,
        shared_memory: null,
        checks: [],
        versions: {
            release: "0.38.0",
            proof: "2",
            daemon: "mc-host/0.1.0",
            magic_context: "0.1.0",
            synapse: "0.1.0",
            broca: "0.1.0",
        },
        ...overrides,
    };
}

function harness(nextResult: (command: LifecycleCommand) => DaemonResultV1) {
    const calls: LifecycleCommand[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const policy = {
        start: async () => {
            calls.push("start");
            return nextResult("start");
        },
        stop: async () => {
            calls.push("stop");
            return nextResult("stop");
        },
        restart: async () => {
            calls.push("restart");
            return nextResult("restart");
        },
        status: async () => {
            calls.push("status");
            return nextResult("status");
        },
        doctor: async () => {
            calls.push("doctor");
            return nextResult("doctor");
        },
    };
    const dependencies: DaemonCommandDependencies = {
        createPolicy: () => policy,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        env: {},
    };
    return { calls, stdout, stderr, dependencies };
}

describe("daemon command contract", () => {
    test.each([
        "start",
        "stop",
        "restart",
        "status",
        "doctor",
    ] as const)("%s invokes exactly one shared lifecycle operation", async (command) => {
        const h = harness((called) => result(called));

        const exit = await runDaemonCommand([command, "--json"], h.dependencies);

        expect(exit).toBe(0);
        expect(h.calls).toEqual([command]);
        expect(h.stderr).toEqual([]);
        expect(h.stdout).toHaveLength(1);
        expect(JSON.parse(h.stdout[0] ?? "")).toEqual(result(command));
    });

    test("operational failure emits one v1 JSON object and exits 1", async () => {
        const h = harness((command) =>
            result(command, {
                ok: false,
                state: "wedged",
                reason: "native_probe_unavailable",
                remediation: "run_daemon_restart",
            }),
        );

        const exit = await runDaemonCommand(["status", "--json"], h.dependencies);

        expect(exit).toBe(1);
        expect(h.stdout).toHaveLength(1);
        expect(h.stderr).toEqual([]);
        expect(JSON.parse(h.stdout[0] ?? "")).toMatchObject({
            schema: "magic-context.daemon/v1",
            command: "status",
            ok: false,
            state: "wedged",
            reason: "native_probe_unavailable",
            remediation: "run_daemon_restart",
            effects: null,
        });
    });

    test.each([
        "start",
        "stop",
        "restart",
        "status",
        "doctor",
    ] as const)("%s preserves the shared policy no_data_dir result and effects", async (command) => {
        const h = harness((called) => result(called));
        h.dependencies.env = {
            XDG_DATA_HOME: "relative",
            MAGIC_CONTEXT_TEST_DATA_DIR: "relative",
            HOME: "relative",
        };
        h.dependencies.createPolicy = (env) => new McHostLifecyclePolicy({ env });

        const exit = await runDaemonCommand([command, "--json"], h.dependencies);

        expect(exit).toBe(1);
        const output = JSON.parse(h.stdout[0] ?? "") as DaemonResultV1;
        expect(output).toMatchObject({
            command,
            ok: false,
            state: "unavailable",
            reason: "no_data_dir",
            remediation: "set_data_directory",
            effects:
                command === "restart" ? { stop_committed: false, start_committed: false } : null,
        });
    });

    test("default human output reports an operational failure and exits 1", async () => {
        const h = harness((command) =>
            result(command, {
                ok: false,
                state: "wedged",
                reason: "native_probe_unavailable",
                remediation: "run_daemon_restart",
            }),
        );

        const exit = await runDaemonCommand(["status"], h.dependencies);

        expect(exit).toBe(1);
        expect(h.stderr).toEqual([]);
        expect(h.stdout).toHaveLength(1);
        const rendered = h.stdout[0] ?? "";
        // Human mode renders text, never the JSON object.
        expect(() => JSON.parse(rendered)).toThrow();
        expect(rendered).toContain("Daemon status: wedged (native_probe_unavailable)");
        expect(rendered).toContain("Remediation: run_daemon_restart");
    });

    test.each([
        { args: [] },
        { args: ["bogus"] },
        { args: ["start", "stop"] },
        { args: ["start", "--verbose"] },
        { args: ["start", "extra"] },
        { args: ["start", "--json", "--json"] },
    ])("usage error %# exits 2 without lifecycle invocation", async ({ args }) => {
        const h = harness((command) => result(command));

        const exit = await runDaemonCommand(args, h.dependencies);

        expect(exit).toBe(2);
        expect(h.calls).toEqual([]);
        expect(h.stdout).toEqual([]);
        expect(h.stderr.join("\n")).toContain("Usage:");
        expect(() => JSON.parse(h.stderr.join("\n"))).toThrow();
    });

    test("human rendering is defined for every closed reason and remediation", () => {
        const reasons = [
            ...releaseContract.cli.reasons.failing_by_precedence.map((entry) => entry.id),
            ...releaseContract.cli.reasons.non_failing,
        ] as DaemonReason[];

        for (const reason of reasons) {
            const rendered = renderDaemonHuman(
                result("doctor", {
                    ok: !releaseContract.cli.reasons.failing_by_precedence.some(
                        (entry) => entry.id === reason,
                    ),
                    reason,
                    remediation:
                        releaseContract.cli.reasons.failing_by_precedence.find(
                            (entry) => entry.id === reason,
                        )?.remediation ?? null,
                }),
            );
            expect(rendered).toContain(reason);
        }

        for (const remediation of releaseContract.cli.remediations) {
            const rendered = renderDaemonHuman(
                result("doctor", {
                    ok: false,
                    reason: "internal_error",
                    remediation,
                }),
            );
            expect(rendered).toContain(remediation);
        }
    });

    test("human restart output reports both committed effects", () => {
        const rendered = renderDaemonHuman(
            result("restart", {
                ok: false,
                state: "stopping",
                reason: "shutdown_timeout",
                remediation: "inspect_daemon_process",
                effects: { stop_committed: true, start_committed: false },
            }),
        );

        expect(rendered).toContain("stop_committed=true");
        expect(rendered).toContain("start_committed=false");
    });

    test("doctor renders fixed-ring identity, bounds, accounting, and lifecycle counts", () => {
        const rendered = renderDaemonHuman(
            result("doctor", {
                readiness: {
                    shared_memory: { state: "ready", reason: "healthy" },
                },
                shared_memory: {
                    state: "terminal",
                    error_class: "peer_death",
                    artifact: {
                        profile: "mc-host-test-ring-v1",
                        wire_version: 2,
                        descriptor_schema: 2,
                    },
                    bounds: {
                        descriptors: 16,
                        arena_bytes: 134_217_728,
                        leases: 16,
                        mappings: 2,
                        file_descriptors: 2,
                        workers: 1,
                        client_instances: 1,
                        pinned_workers: 0,
                    },
                    accounting: {
                        active: {
                            descriptors: 16,
                            arena_bytes: 134_217_728,
                            leases: 16,
                            mappings: 2,
                            file_descriptors: 2,
                            workers: 1,
                            client_instances: 1,
                            pinned_workers: 0,
                        },
                        quarantined: {
                            descriptors: 7,
                            arena_bytes: 8_388_608,
                            leases: 6,
                            mappings: 5,
                            file_descriptors: 4,
                            workers: 3,
                            client_instances: 2,
                            pinned_workers: 1,
                        },
                    },
                    activation: { completed: 37 },
                    peer_death: { observed: 31 },
                    reclamation: { completed: 29 },
                    exhaustion: { observed: 23 },
                },
            }),
        );

        expect(rendered).toContain("Shared memory: terminal (peer_death)");
        expect(rendered).toContain("profile=mc-host-test-ring-v1 wire=2 descriptor=2");
        expect(rendered).toContain("active_bytes=134217728");
        expect(rendered).toContain("quarantined_bytes=8388608");
        expect(rendered).toContain("activations=37");
        expect(rendered).toContain("peer_deaths=31 reclamations=29 exhaustions=23");
    });

    test("redacts lifecycle roots and secret-shaped native version text", async () => {
        const root = "/private/home/alice/data";
        const h = harness((command) =>
            result(command, {
                versions: {
                    release: "0.38.0",
                    proof: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
                    daemon: `${root}/daemon`,
                    magic_context: `mc-host/0.1.0 (payload ${root}/cortexkit/bin)`,
                    synapse: null,
                    broca: null,
                },
            }),
        );
        h.dependencies.env = { XDG_DATA_HOME: root, HOME: "/private/home/alice" };

        await runDaemonCommand(["status", "--json"], h.dependencies);

        const output = h.stdout.join("\n");
        expect(output).not.toContain(root);
        expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
        expect(output).toContain("<data-root>");
        expect(output).toContain("<REDACTED:bearer>");
        expect(output).toContain("payload <data-root>/cortexkit/bin");
    });

    test("neutralizes control characters and bounds peer version text", async () => {
        const h = harness((command) =>
            result(command, {
                versions: {
                    release: "0.38.0",
                    proof: "2",
                    daemon: `mc-host/0.1.0\u001b[2K\u001b[1;31m\nforged: line${"x".repeat(4096)}`,
                    magic_context: null,
                    synapse: null,
                    broca: null,
                },
            }),
        );

        const exit = await runDaemonCommand(["status"], h.dependencies);

        expect(exit).toBe(0);
        const output = h.stdout.join("\n");
        expect(output).not.toContain("\u001b");
        // The embedded newline must not mint a standalone forged output line.
        expect(output.split("\n").some((line) => line.startsWith("forged:"))).toBe(false);
        const versionsLine = output.split("\n").find((line) => line.startsWith("Versions:"));
        expect(versionsLine).toBeDefined();
        const daemonValue = /daemon=(.*)$/.exec(versionsLine ?? "")?.[1] ?? "";
        expect(daemonValue.length).toBeLessThanOrEqual(128);
    });

    test("redaction failures fall back per value instead of rejecting", async () => {
        const h = harness((command) =>
            result(command, {
                versions: {
                    release: "0.38.0",
                    // A non-string value makes the redaction chain throw for
                    // this entry; the command must substitute a placeholder
                    // and still emit one complete v1 object.
                    proof: 10n as unknown as string,
                    daemon: "mc-host/0.1.0",
                    magic_context: null,
                    synapse: null,
                    broca: null,
                },
            }),
        );

        const exit = await runDaemonCommand(["status", "--json"], h.dependencies);

        expect(exit).toBe(0);
        expect(h.stdout).toHaveLength(1);
        expect(h.stderr).toEqual([]);
        const output = JSON.parse(h.stdout[0] ?? "") as DaemonResultV1;
        expect(output.versions.proof).toBe("<REDACTED>");
        expect(output.versions.daemon).toBe("mc-host/0.1.0");
    });

    test("rendering failures produce bounded stderr without a partial v1 object", async () => {
        const h = harness((command) =>
            result(command, {
                // A BigInt outside the redacted versions block makes
                // JSON.stringify throw, exercising the guarded render region.
                checks: [10n] as unknown as DaemonResultV1["checks"],
            }),
        );

        const exit = await runDaemonCommand(["status", "--json"], h.dependencies);

        expect(exit).toBe(1);
        expect(h.stdout).toEqual([]);
        expect(h.stderr).toEqual([
            "Daemon status produced a result that could not be rendered safely.",
        ]);
    });

    test("policy exceptions produce bounded stderr without a partial v1 object", async () => {
        const h = harness((command) => result(command));
        h.dependencies.createPolicy = () => ({
            start: async () => {
                throw new Error("/private/home/alice token=super-secret-value");
            },
            stop: async () => result("stop"),
            restart: async () => result("restart"),
            status: async () => result("status"),
            doctor: async () => result("doctor"),
        });

        const exit = await runDaemonCommand(["start", "--json"], h.dependencies);

        expect(exit).toBe(1);
        expect(h.stdout).toEqual([]);
        expect(h.stderr).toEqual([
            "Daemon start failed before a lifecycle result could be formed.",
        ]);
    });
});
