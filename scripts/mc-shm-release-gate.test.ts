import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    buildReleaseGateReport,
    readGateConfig,
    type GateConfig,
    type RunEvidence,
    type RunSuite,
} from "./mc-shm-release-gate";

const hex = (value: string): string => createHash("sha256").update(value).digest("hex");

function identity(role: "baseline" | "candidate", runtime: "bun" | "node") {
    return {
        source_commit: role === "baseline" ? "1".repeat(40) : "2".repeat(40),
        package: {
            name: role === "baseline" ? "mc-host-tcp-frozen" : "@cortexkit/mc-host-linux-x64-gnu",
            version: role === "baseline" ? "0.37.0" : "0.38.0",
            sha256: role === "baseline" ? "3".repeat(64) : "4".repeat(64),
        },
        runtime: {
            name: runtime,
            version: runtime === "bun" ? "1.4.0" : "24.0.0",
            executable_sha256: runtime === "bun" ? "5".repeat(64) : "b".repeat(64),
        },
        host: {
            id_sha256: "6".repeat(64),
            kernel: "Linux 6.12",
            cpu: "fixture cpu",
            topology_sha256: "7".repeat(64),
        },
        harness_sha256: "8".repeat(64),
        workload_sha256: "9".repeat(64),
    };
}

function evidence(role: "baseline" | "candidate", runtime: "bun" | "node" = "bun"): RunEvidence {
    const candidate = role === "candidate";
    return {
        schema: "magic-context.mc-shm-installed-performance-run/v1",
        role,
        transport: role === "baseline" ? "tcp" : "ring",
        installed_artifact: true,
        state: "complete",
        identity: identity(role, runtime),
        blocks: [
            {
                block: 1,
                process_id: 101,
                state: "complete",
                completed_ops: 2,
                elapsed_ns: candidate ? 800 : 1_000,
                latencies_ns: candidate ? [125, 375] : [100, 300],
                body_copies: candidate ? 1 : 2,
                allocations: candidate ? 3 : 4,
                cpu_ns: candidate ? 560 : 700,
                wakeups: candidate ? 4 : 6,
            },
            {
                block: 2,
                process_id: 102,
                state: "complete",
                completed_ops: 2,
                elapsed_ns: candidate ? 800 : 1_000,
                latencies_ns: candidate ? [250, 500] : [200, 400],
                body_copies: candidate ? 1 : 2,
                allocations: candidate ? 3 : 4,
                cpu_ns: candidate ? 560 : 700,
                wakeups: candidate ? 4 : 6,
            },
        ],
    };
}

function suite(role: "baseline" | "candidate"): RunSuite {
    return {
        schema: "magic-context.mc-shm-installed-performance-suite/v1",
        runs: [evidence(role, "bun"), evidence(role, "node")],
    };
}

function config(): GateConfig {
    return {
        schema: "magic-context.mc-shm-release-gate-config/v1",
        state: "ready",
        blockers: [],
        expected_blocks: 2,
        required_runtimes: ["bun", "node"],
        baseline: {
            path: "baseline.json",
            sha256: "a".repeat(64),
            source_commit: "1".repeat(40),
            package_sha256: "3".repeat(64),
        },
        candidate: {
            source_commit: "2".repeat(40),
            package_name: "@cortexkit/mc-host-linux-x64-gnu",
            package_version: "0.38.0",
            package_sha256: "4".repeat(64),
        },
        matched_identities: [
            {
                runtime_name: "bun",
                runtime_version: "1.4.0",
                runtime_executable_sha256: "5".repeat(64),
                host_id_sha256: "6".repeat(64),
                host_topology_sha256: "7".repeat(64),
                harness_sha256: "8".repeat(64),
                workload_sha256: "9".repeat(64),
            },
            {
                runtime_name: "node",
                runtime_version: "24.0.0",
                runtime_executable_sha256: "b".repeat(64),
                host_id_sha256: "6".repeat(64),
                host_topology_sha256: "7".repeat(64),
                harness_sha256: "8".repeat(64),
                workload_sha256: "9".repeat(64),
            },
        ],
    };
}

describe("installed shared-memory release gate", () => {
    test("records every R12 metric without inventing a performance verdict", () => {
        const report = buildReleaseGateReport(config(), suite("baseline"), suite("candidate"));
        expect(report.verdict).toBe("evidence_complete");
        expect(report.runtime_results.map((result) => result.runtime)).toEqual(["bun", "node"]);
        for (const result of report.runtime_results) {
            expect(result.baseline.metrics).toEqual({
                p50_latency_ns: 200,
                p99_latency_ns: 400,
                throughput_ops_per_second: 2_000_000,
                body_copies: 4,
                allocations: 8,
                cpu_ns: 1_400,
                wakeups: 12,
            });
            expect(result.candidate.metrics).toEqual({
                p50_latency_ns: 250,
                p99_latency_ns: 500,
                throughput_ops_per_second: 2_500_000,
                body_copies: 2,
                allocations: 6,
                cpu_ns: 1_120,
                wakeups: 8,
            });
            expect(result.comparison).toEqual({
                p50_ratio: 1.25,
                p99_ratio: 1.25,
                throughput_ratio: 1.25,
                copies_delta: -2,
                allocations_delta: -2,
                cpu_ratio: 0.8,
                wakeups_delta: -4,
            });
        }
        expect("pass" in report || "winner" in report).toBeFalse();
    });

    test("rejects mixed identities, interrupted runs, and missing blocks", () => {
        const mutations: Array<[string, (run: RunEvidence) => void]> = [
            ["source commit", (run) => (run.identity.source_commit = "f".repeat(40))],
            ["package name", (run) => (run.identity.package.name = "other-package")],
            ["package version", (run) => (run.identity.package.version = "9.9.9")],
            ["package digest", (run) => (run.identity.package.sha256 = "f".repeat(64))],
            ["runtime name", (run) => (run.identity.runtime.name = "node")],
            ["runtime version", (run) => (run.identity.runtime.version = "0.0.0")],
            ["runtime executable", (run) => (run.identity.runtime.executable_sha256 = "f".repeat(64))],
            ["host identity", (run) => (run.identity.host.id_sha256 = "f".repeat(64))],
            ["host kernel", (run) => (run.identity.host.kernel = "Linux 0.0")],
            ["host cpu", (run) => (run.identity.host.cpu = "other cpu")],
            ["host topology", (run) => (run.identity.host.topology_sha256 = "f".repeat(64))],
            ["harness", (run) => (run.identity.harness_sha256 = "f".repeat(64))],
            ["workload", (run) => (run.identity.workload_sha256 = "f".repeat(64))],
        ];
        for (const [label, mutate] of mutations) {
            const mixed = suite("candidate");
            mutate(mixed.runs[0]!);
            expect(() => buildReleaseGateReport(config(), suite("baseline"), mixed), label).toThrow();
        }

        const interrupted = suite("candidate");
        interrupted.runs[0]!.state = "interrupted";
        expect(() => buildReleaseGateReport(config(), suite("baseline"), interrupted)).toThrow(
            /candidate run is interrupted/,
        );

        const missing = suite("candidate");
        missing.runs[0]!.blocks.pop();
        expect(() => buildReleaseGateReport(config(), suite("baseline"), missing)).toThrow(
            /expected 2 complete blocks/,
        );

        const missingRuntime = suite("candidate");
        missingRuntime.runs.pop();
        expect(() => buildReleaseGateReport(config(), suite("baseline"), missingRuntime)).toThrow(
            /exactly ordered Bun and Node runs/,
        );
    });

    test("blocked config names unavailable designated host and frozen baseline", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-shm-gate-"));
        const path = join(dir, "gate.json");
        writeFileSync(
            path,
            JSON.stringify({
                schema: "magic-context.mc-shm-release-gate-config/v1",
                state: "blocked",
                blockers: ["designated host unavailable", "frozen TCP baseline unavailable"],
                expected_blocks: 10,
                required_runtimes: ["bun", "node"],
                baseline: null,
                candidate: null,
                matched_identities: null,
            }),
        );
        const blocked = readGateConfig(path);
        expect(blocked.state).toBe("blocked");
        expect(blocked.blockers).toHaveLength(2);
        expect(() => buildReleaseGateReport(blocked, suite("baseline"), suite("candidate"))).toThrow(
            /release gate blocked.*designated host unavailable.*frozen TCP baseline unavailable/,
        );
    });

    test("candidate cannot reintroduce TCP or masquerade as source-tree evidence", () => {
        const tcp = suite("candidate");
        tcp.runs[0]!.transport = "tcp";
        expect(() => buildReleaseGateReport(config(), suite("baseline"), tcp)).toThrow(
            /candidate transport must be ring/,
        );
        const sourceTree = suite("candidate");
        sourceTree.runs[0]!.installed_artifact = false;
        expect(() => buildReleaseGateReport(config(), suite("baseline"), sourceTree)).toThrow(
            /installed artifact/,
        );
    });

    test("baseline bytes are bound by the frozen digest", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-shm-gate-"));
        const baselinePath = join(dir, "baseline.json");
        const packagePath = join(dir, "candidate.tgz");
        const baselineBytes = `${JSON.stringify(suite("baseline"))}\n`;
        const packageBytes = "candidate package fixture";
        writeFileSync(baselinePath, baselineBytes);
        writeFileSync(packagePath, packageBytes);
        const cfg = config();
        cfg.baseline = {
            ...cfg.baseline!,
            path: "baseline.json",
            sha256: hex(baselineBytes),
        };
        cfg.candidate = {
            ...cfg.candidate!,
            package_path: "candidate.tgz",
            package_sha256: hex(packageBytes),
        };
        const configPath = join(dir, "gate.json");
        writeFileSync(configPath, JSON.stringify(cfg));
        expect(readGateConfig(configPath).baseline?.sha256).toBe(hex(baselineBytes));
        writeFileSync(packagePath, `${packageBytes} `);
        expect(() => readGateConfig(configPath)).toThrow(/candidate package digest/);
        writeFileSync(packagePath, packageBytes);
        writeFileSync(baselinePath, `${baselineBytes} `);
        expect(() => readGateConfig(configPath)).toThrow(/frozen baseline digest/);
    });
});
