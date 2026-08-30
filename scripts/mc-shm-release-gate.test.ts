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
        platform: "linux-x64-gnu" as const,
        profile: "mc-host-eventfd-ring-v2" as const,
        wire_version: 2 as const,
        descriptor_schema: 3 as const,
        transferred_descriptors: 6 as const,
        environment_watchers: 1 as const,
        package: {
            name: role === "baseline" ? "mc-host-ring-frozen" : "@cortexkit/mc-host-linux-x64-gnu",
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
        transport: "ring",
        installed_artifact: true,
        state: "complete",
        identity: identity(role, runtime),
        blocks: [
            {
                block: 1,
                process_id: 101,
                workload: "cold_first_frame",
                connection_count: 1,
                callback_budget: 64,
                state: "complete",
                completed_ops: 2,
                elapsed_ns: candidate ? 800 : 1_000,
                latencies_ns: candidate ? [125, 375] : [100, 300],
                body_copies: candidate ? 1 : 2,
                allocations: candidate ? 3 : 4,
                cpu_ns: candidate ? 560 : 700,
                wakeups: candidate ? 4 : 6,
                p99_event_loop_delay_ns: candidate ? 50 : 60,
                rss_bytes: candidate ? 1000 : 1200,
                pss_bytes: candidate ? 800 : 900,
                resident_pages: candidate ? 2 : 4,
                page_table_bytes: 4096,
                fd_count: 7,
                watcher_count: 1,
                eventfd_attempts: 4,
                eventfd_successes: 4,
                eventfd_eagain: 0,
                eventfd_reads: 4,
                parks: 4,
                spurious_wakes: 0,
                publications: 2,
                tsfn_callbacks: 2,
                scheduler_handoffs: 2,
                reclaim_scans: 1,
                reclaim_bytes: candidate ? 4096 : 0,
                reclaim_runs: candidate ? 1 : 0,
                madv_remove_calls: candidate ? 1 : 0,
                madv_remove_pages: candidate ? 1 : 0,
                queue_hops: 0,
            },
            {
                block: 2,
                process_id: 102,
                workload: "active_path",
                connection_count: 8,
                callback_budget: 64,
                state: "complete",
                completed_ops: 2,
                elapsed_ns: candidate ? 800 : 1_000,
                latencies_ns: candidate ? [250, 500] : [200, 400],
                body_copies: candidate ? 1 : 2,
                allocations: candidate ? 3 : 4,
                cpu_ns: candidate ? 560 : 700,
                wakeups: candidate ? 4 : 6,
                p99_event_loop_delay_ns: candidate ? 55 : 65,
                rss_bytes: candidate ? 2000 : 2400,
                pss_bytes: candidate ? 1600 : 1800,
                resident_pages: candidate ? 4 : 8,
                page_table_bytes: 8192,
                fd_count: 49,
                watcher_count: 1,
                eventfd_attempts: 4,
                eventfd_successes: 4,
                eventfd_eagain: 0,
                eventfd_reads: 4,
                parks: 4,
                spurious_wakes: 0,
                publications: 2,
                tsfn_callbacks: 2,
                scheduler_handoffs: 2,
                reclaim_scans: 1,
                reclaim_bytes: candidate ? 4096 : 0,
                reclaim_runs: candidate ? 1 : 0,
                madv_remove_calls: candidate ? 1 : 0,
                madv_remove_pages: candidate ? 1 : 0,
                queue_hops: 0,
            },
        ],
    };
}

function suite(role: "baseline" | "candidate"): RunSuite {
    return {
        schema: "magic-context.mc-shm-installed-performance-suite/v1",
        runs: [evidence(role, "bun"), evidence(role, "node")],
        blocked_runtimes: [],
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
        designated_host: {
            state: "blocked",
            blockers: ["designated host unavailable"],
        },
        frozen_contract: {
            equivalence_margin_ratio: 0.05,
            callback_budget: 64,
            max_rss_bytes: 4096,
            max_pss_bytes: 4096,
            max_page_table_bytes: 16384,
            max_fd_count: 64,
            max_watcher_count: 1,
            tmpfs_bytes: 536870912,
            cgroup_memory_bytes: 1073741824,
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
        expect(report.local_verdict).toBe("evidence_complete");
        expect(report.designated_host_verdict).toEqual({
            state: "blocked",
            blockers: ["designated host unavailable"],
        });
        expect(report.runtime_results.map((result) => result.runtime)).toEqual(["bun", "node"]);
        for (const result of report.runtime_results) {
            expect(result.local_verdict).toBe("evidence_complete");
            if (result.local_verdict !== "evidence_complete") throw new Error("fixture runtime unexpectedly blocked");
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
            expect(result.paired_blocks).toHaveLength(2);
            expect(result.paired_blocks.map((block) => [block.block, block.workload, block.connection_count])).toEqual([
                [1, "cold_first_frame", 1],
                [2, "active_path", 8],
            ]);
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
            ["profile", (run) => ((run.identity as { profile: string }).profile = "mc-host-test-ring-v1")],
            ["descriptor count", (run) => ((run.identity as { transferred_descriptors: number }).transferred_descriptors = 2)],
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
            /ordered Bun and eligible Node runs/,
        );

        const missingCounter = suite("candidate");
        delete (missingCounter.runs[0]!.blocks[0] as Partial<RunEvidence["blocks"][number]>).eventfd_attempts;
        expect(() => buildReleaseGateReport(config(), suite("baseline"), missingCounter)).toThrow(
            /fields differ.*eventfd_attempts/,
        );

        const pooledOrMismatched = suite("candidate");
        pooledOrMismatched.runs[0]!.blocks[0]!.connection_count = 64;
        expect(() => buildReleaseGateReport(config(), suite("baseline"), pooledOrMismatched)).toThrow(
            /paired block workload identity mismatch/,
        );
    });

    test("records Node baseline ineligibility as blocked without weakening Bun evidence", () => {
        const baseline = suite("baseline");
        baseline.runs.pop();
        baseline.blocked_runtimes.push({ runtime: "node", reason: "pre-change artifact cannot load on supported Node" });
        const candidate = suite("candidate");
        candidate.runs.pop();
        candidate.blocked_runtimes.push({ runtime: "node", reason: "paired baseline unavailable" });
        const report = buildReleaseGateReport(config(), baseline, candidate);
        expect(report.runtime_results[0]!.local_verdict).toBe("evidence_complete");
        expect(report.runtime_results[1]).toEqual({
            runtime: "node",
            local_verdict: "blocked",
            blocker: "pre-change artifact cannot load on supported Node",
        });
    });

    test("blocked config names unavailable designated host and frozen baseline", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-shm-gate-"));
        const path = join(dir, "gate.json");
        writeFileSync(
            path,
            JSON.stringify({
                schema: "magic-context.mc-shm-release-gate-config/v1",
                state: "blocked",
                blockers: ["designated host unavailable", "frozen ring baseline unavailable"],
                expected_blocks: 10,
                required_runtimes: ["bun", "node"],
                baseline: null,
                candidate: null,
                designated_host: { state: "blocked", blockers: ["designated host unavailable"] },
                frozen_contract: null,
                matched_identities: null,
            }),
        );
        const blocked = readGateConfig(path);
        expect(blocked.state).toBe("blocked");
        expect(blocked.blockers).toHaveLength(2);
        expect(() => buildReleaseGateReport(blocked, suite("baseline"), suite("candidate"))).toThrow(
            /release gate blocked.*designated host unavailable.*frozen ring baseline unavailable/,
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
