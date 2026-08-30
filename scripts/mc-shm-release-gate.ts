#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CONFIG_SCHEMA = "magic-context.mc-shm-release-gate-config/v1" as const;
const RUN_SCHEMA = "magic-context.mc-shm-installed-performance-run/v1" as const;
const SUITE_SCHEMA = "magic-context.mc-shm-installed-performance-suite/v1" as const;
const REPORT_SCHEMA = "magic-context.mc-shm-release-gate-report/v1" as const;
const baselineInputs = new WeakMap<GateConfig, unknown>();

type Role = "baseline" | "candidate";

export interface RunIdentity {
    source_commit: string;
    platform: "linux-x64-gnu";
    profile: "mc-host-eventfd-ring-v2";
    wire_version: 2;
    descriptor_schema: 3;
    transferred_descriptors: 6;
    environment_watchers: 1;
    package: { name: string; version: string; sha256: string };
    runtime: { name: "bun" | "node" | "rust"; version: string; executable_sha256: string };
    host: { id_sha256: string; kernel: string; cpu: string; topology_sha256: string };
    harness_sha256: string;
    workload_sha256: string;
}

export interface RunBlock {
    block: number;
    process_id: number;
    workload: "setup" | "cold_first_frame" | "end_to_end" | "active_path" | "idle";
    connection_count: 1 | 8 | 64;
    callback_budget: number;
    state: "complete" | "interrupted" | "failed";
    completed_ops: number;
    elapsed_ns: number;
    latencies_ns: number[];
    body_copies: number;
    allocations: number;
    cpu_ns: number;
    wakeups: number;
    p99_event_loop_delay_ns: number;
    rss_bytes: number;
    pss_bytes: number;
    resident_pages: number;
    page_table_bytes: number;
    fd_count: number;
    watcher_count: number;
    eventfd_attempts: number;
    eventfd_successes: number;
    eventfd_eagain: number;
    eventfd_reads: number;
    parks: number;
    spurious_wakes: number;
    publications: number;
    tsfn_callbacks: number;
    scheduler_handoffs: number;
    reclaim_scans: number;
    reclaim_bytes: number;
    reclaim_runs: number;
    madv_remove_calls: number;
    madv_remove_pages: number;
    queue_hops: number;
}

export interface RunEvidence {
    schema: typeof RUN_SCHEMA;
    role: Role;
    transport: "tcp" | "ring";
    installed_artifact: boolean;
    state: "complete" | "interrupted" | "failed";
    identity: RunIdentity;
    blocks: RunBlock[];
}

export interface RunSuite {
    schema: typeof SUITE_SCHEMA;
    runs: RunEvidence[];
    blocked_runtimes: Array<{ runtime: "node"; reason: string }>;
}

interface FrozenBaseline {
    path: string;
    sha256: string;
    source_commit: string;
    package_sha256: string;
}

interface CandidateBinding {
    source_commit: string;
    package_name: string;
    package_version: string;
    package_sha256: string;
    package_path?: string;
    collector_path?: string;
    collector_sha256?: string;
    collector_args?: string[];
}

interface MatchedIdentity {
    runtime_name: "bun" | "node" | "rust";
    runtime_version: string;
    runtime_executable_sha256: string;
    host_id_sha256: string;
    host_topology_sha256: string;
    harness_sha256: string;
    workload_sha256: string;
}

interface FrozenContract {
    equivalence_margin_ratio: number;
    callback_budget: number;
    max_rss_bytes: number;
    max_pss_bytes: number;
    max_page_table_bytes: number;
    max_fd_count: number;
    max_watcher_count: number;
    tmpfs_bytes: number;
    cgroup_memory_bytes: number;
}

interface DesignatedHostState {
    state: "blocked" | "evidence_complete";
    blockers: string[];
}

export interface GateConfig {
    schema: typeof CONFIG_SCHEMA;
    state: "ready" | "blocked";
    blockers: string[];
    expected_blocks: number;
    required_runtimes: Array<"bun" | "node">;
    baseline: FrozenBaseline | null;
    candidate: CandidateBinding | null;
    designated_host: DesignatedHostState;
    frozen_contract: FrozenContract | null;
    matched_identities: MatchedIdentity[] | null;
}

interface Metrics {
    p50_latency_ns: number;
    p99_latency_ns: number;
    throughput_ops_per_second: number;
    body_copies: number;
    allocations: number;
    cpu_ns: number;
    wakeups: number;
}

export interface ReleaseGateReport {
    schema: typeof REPORT_SCHEMA;
    local_verdict: "evidence_complete";
    designated_host_verdict: DesignatedHostState;
    claim: "paired_measurement_against_frozen_contract";
    frozen_contract: FrozenContract;
    runtime_results: Array<
        | {
              runtime: "bun" | "node";
              local_verdict: "evidence_complete";
              baseline: { identity: RunIdentity; metrics: Metrics };
              candidate: { identity: RunIdentity; metrics: Metrics };
              paired_blocks: Array<{
                  block: number;
                  workload: RunBlock["workload"];
                  connection_count: RunBlock["connection_count"];
                  callback_budget: number;
                  baseline: RunBlock;
                  candidate: RunBlock;
                  comparison: MetricComparison;
              }>;
              comparison: MetricComparison;
          }
        | { runtime: "node"; local_verdict: "blocked"; blocker: string }
    >;
}

interface MetricComparison {
    p50_ratio: number;
    p99_ratio: number;
    throughput_ratio: number;
    copies_delta: number;
    allocations_delta: number;
    cpu_ratio: number;
    wakeups_delta: number;
}

function fail(message: string): never {
    throw new Error(`mc-shm release gate: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
        fail(`${label} fields differ: expected ${expected.join(", ")}; got ${actual.join(", ")}`);
    }
}

function string(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
    return value;
}

function digest(value: unknown, label: string): string {
    const result = string(value, label);
    if (!HEX64.test(result)) fail(`${label} must be lowercase SHA-256`);
    return result;
}

function commit(value: unknown, label: string): string {
    const result = string(value, label);
    if (!HEX40.test(result)) fail(`${label} must be a full lowercase Git commit`);
    return result;
}

function integer(value: unknown, label: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${label} must be an integer >= ${minimum}`);
    return value as number;
}

function positiveNumber(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${label} must be a positive number`);
    return value;
}

function stringArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) fail(`${label} must be an array`);
    return value.map((entry, index) => string(entry, `${label}[${index}]`));
}

function readRegularFile(path: string, label: string): Buffer {
    let stat: ReturnType<typeof lstatSync>;
    try {
        stat = lstatSync(path);
    } catch {
        fail(`${label} missing at ${path}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
    return readFileSync(path);
}

function sha256File(path: string, label: string): string {
    return createHash("sha256").update(readRegularFile(path, label)).digest("hex");
}

function resolveBoundPath(configPath: string, path: string): string {
    return isAbsolute(path) ? path : resolve(dirname(configPath), path);
}

function parseConfig(input: unknown): GateConfig {
    const root = record(input, "config");
    exact(root, ["schema", "state", "blockers", "expected_blocks", "required_runtimes", "baseline", "candidate", "designated_host", "frozen_contract", "matched_identities"], "config");
    if (root.schema !== CONFIG_SCHEMA) fail("unknown config schema");
    if (root.state !== "ready" && root.state !== "blocked") fail("config.state must be ready or blocked");
    const blockers = stringArray(root.blockers, "config.blockers");
    const expectedBlocks = integer(root.expected_blocks, "config.expected_blocks", 1);
    const requiredRuntimes = stringArray(root.required_runtimes, "config.required_runtimes");
    if (requiredRuntimes.length !== 2 || requiredRuntimes[0] !== "bun" || requiredRuntimes[1] !== "node") fail("config.required_runtimes must be exactly [bun, node]");
    const designated = record(root.designated_host, "config.designated_host");
    exact(designated, ["state", "blockers"], "config.designated_host");
    if (designated.state !== "blocked" && designated.state !== "evidence_complete") fail("config.designated_host.state is invalid");
    const designatedBlockers = stringArray(designated.blockers, "config.designated_host.blockers");
    if ((designated.state === "blocked") !== (designatedBlockers.length > 0)) fail("designated-host blocker state mismatch");
    const designatedHost = { state: designated.state, blockers: designatedBlockers } as DesignatedHostState;
    if (root.state === "blocked") {
        if (blockers.length === 0) fail("blocked config must name at least one blocker");
        if (root.baseline !== null || root.candidate !== null || root.frozen_contract !== null || root.matched_identities !== null) {
            fail("blocked config cannot carry partial evidence bindings");
        }
        return { schema: CONFIG_SCHEMA, state: "blocked", blockers, expected_blocks: expectedBlocks, required_runtimes: ["bun", "node"], baseline: null, candidate: null, designated_host: designatedHost, frozen_contract: null, matched_identities: null };
    }
    if (blockers.length !== 0) fail("ready config cannot carry blockers");

    const baseline = record(root.baseline, "config.baseline");
    exact(baseline, ["path", "sha256", "source_commit", "package_sha256"], "config.baseline");
    const candidate = record(root.candidate, "config.candidate");
    const requiredCandidate = ["source_commit", "package_name", "package_version", "package_sha256", "package_path"];
    const optionalCandidate = ["collector_path", "collector_sha256", "collector_args"];
    const unknownCandidate = Object.keys(candidate).filter((key) => !requiredCandidate.includes(key) && !optionalCandidate.includes(key));
    if (unknownCandidate.length > 0 || requiredCandidate.some((key) => !(key in candidate))) fail("config.candidate fields differ");
    if (!Array.isArray(root.matched_identities) || root.matched_identities.length !== 2) fail("config.matched_identities must contain Bun and Node identities");
    const matchedIdentities = root.matched_identities.map((input, index) => {
        const matched = record(input, `config.matched_identities[${index}]`);
        exact(matched, ["runtime_name", "runtime_version", "runtime_executable_sha256", "host_id_sha256", "host_topology_sha256", "harness_sha256", "workload_sha256"], `config.matched_identities[${index}]`);
        const runtimeName = string(matched.runtime_name, `config.matched_identities[${index}].runtime_name`);
        if (runtimeName !== "bun" && runtimeName !== "node") fail("matched runtime must be bun or node");
        return {
            runtime_name: runtimeName,
            runtime_version: string(matched.runtime_version, `config.matched_identities[${index}].runtime_version`),
            runtime_executable_sha256: digest(matched.runtime_executable_sha256, `config.matched_identities[${index}].runtime_executable_sha256`),
            host_id_sha256: digest(matched.host_id_sha256, `config.matched_identities[${index}].host_id_sha256`),
            host_topology_sha256: digest(matched.host_topology_sha256, `config.matched_identities[${index}].host_topology_sha256`),
            harness_sha256: digest(matched.harness_sha256, `config.matched_identities[${index}].harness_sha256`),
            workload_sha256: digest(matched.workload_sha256, `config.matched_identities[${index}].workload_sha256`),
        } satisfies MatchedIdentity;
    });
    if (matchedIdentities[0]!.runtime_name !== "bun" || matchedIdentities[1]!.runtime_name !== "node") fail("matched identities must be ordered [bun, node]");
    const frozen = record(root.frozen_contract, "config.frozen_contract");
    exact(frozen, ["equivalence_margin_ratio", "callback_budget", "max_rss_bytes", "max_pss_bytes", "max_page_table_bytes", "max_fd_count", "max_watcher_count", "tmpfs_bytes", "cgroup_memory_bytes"], "config.frozen_contract");
    const frozenContract: FrozenContract = {
        equivalence_margin_ratio: positiveNumber(frozen.equivalence_margin_ratio, "config.frozen_contract.equivalence_margin_ratio"),
        callback_budget: integer(frozen.callback_budget, "config.frozen_contract.callback_budget", 1),
        max_rss_bytes: integer(frozen.max_rss_bytes, "config.frozen_contract.max_rss_bytes", 1),
        max_pss_bytes: integer(frozen.max_pss_bytes, "config.frozen_contract.max_pss_bytes", 1),
        max_page_table_bytes: integer(frozen.max_page_table_bytes, "config.frozen_contract.max_page_table_bytes", 1),
        max_fd_count: integer(frozen.max_fd_count, "config.frozen_contract.max_fd_count", 1),
        max_watcher_count: integer(frozen.max_watcher_count, "config.frozen_contract.max_watcher_count", 1),
        tmpfs_bytes: integer(frozen.tmpfs_bytes, "config.frozen_contract.tmpfs_bytes", 1),
        cgroup_memory_bytes: integer(frozen.cgroup_memory_bytes, "config.frozen_contract.cgroup_memory_bytes", 1),
    };
    const collectorArgs = candidate.collector_args === undefined ? undefined : stringArray(candidate.collector_args, "config.candidate.collector_args");
    if ((candidate.collector_path === undefined) !== (candidate.collector_sha256 === undefined)) fail("collector_path and collector_sha256 must appear together");
    if (candidate.collector_sha256 !== undefined && matchedIdentities.some((matched) => candidate.collector_sha256 !== matched.harness_sha256)) fail("collector digest must equal every matched harness digest");
    return {
        schema: CONFIG_SCHEMA,
        state: "ready",
        blockers: [],
        expected_blocks: expectedBlocks,
        required_runtimes: ["bun", "node"],
        baseline: {
            path: string(baseline.path, "config.baseline.path"),
            sha256: digest(baseline.sha256, "config.baseline.sha256"),
            source_commit: commit(baseline.source_commit, "config.baseline.source_commit"),
            package_sha256: digest(baseline.package_sha256, "config.baseline.package_sha256"),
        },
        candidate: {
            source_commit: commit(candidate.source_commit, "config.candidate.source_commit"),
            package_name: string(candidate.package_name, "config.candidate.package_name"),
            package_version: string(candidate.package_version, "config.candidate.package_version"),
            package_sha256: digest(candidate.package_sha256, "config.candidate.package_sha256"),
            package_path: string(candidate.package_path, "config.candidate.package_path"),
            collector_path: candidate.collector_path === undefined ? undefined : string(candidate.collector_path, "config.candidate.collector_path"),
            collector_sha256: candidate.collector_sha256 === undefined ? undefined : digest(candidate.collector_sha256, "config.candidate.collector_sha256"),
            collector_args: collectorArgs,
        },
        designated_host: designatedHost,
        frozen_contract: frozenContract,
        matched_identities: matchedIdentities,
    };
}

export function readGateConfig(path: string): GateConfig {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        fail(`cannot read config: ${error instanceof Error ? error.message : String(error)}`);
    }
    const config = parseConfig(parsed);
    if (config.state === "blocked") return config;
    const baselinePath = resolveBoundPath(path, config.baseline!.path);
    const baselineBytes = readRegularFile(baselinePath, "frozen baseline");
    if (createHash("sha256").update(baselineBytes).digest("hex") !== config.baseline!.sha256) fail("frozen baseline digest does not match current bytes");
    try {
        baselineInputs.set(config, JSON.parse(baselineBytes.toString("utf8")));
    } catch (error) {
        fail(`frozen baseline is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const packagePath = resolveBoundPath(path, config.candidate!.package_path!);
    if (sha256File(packagePath, "candidate package") !== config.candidate!.package_sha256) fail("candidate package digest does not match current bytes");
    if (config.candidate!.collector_path !== undefined) {
        if (config.candidate!.collector_sha256 === undefined) fail("collector path requires collector_sha256");
        const collectorPath = resolveBoundPath(path, config.candidate!.collector_path);
        if (sha256File(collectorPath, "installed-path collector") !== config.candidate!.collector_sha256) fail("collector digest does not match current bytes");
    }
    return config;
}

function parseIdentity(input: unknown, label: string): RunIdentity {
    const value = record(input, label);
    exact(value, ["source_commit", "platform", "profile", "wire_version", "descriptor_schema", "transferred_descriptors", "environment_watchers", "package", "runtime", "host", "harness_sha256", "workload_sha256"], label);
    if (value.platform !== "linux-x64-gnu" || value.profile !== "mc-host-eventfd-ring-v2" || value.wire_version !== 2 || value.descriptor_schema !== 3 || value.transferred_descriptors !== 6 || value.environment_watchers !== 1) fail(`${label} fixed release identity mismatch`);
    const pkg = record(value.package, `${label}.package`);
    exact(pkg, ["name", "version", "sha256"], `${label}.package`);
    const runtime = record(value.runtime, `${label}.runtime`);
    exact(runtime, ["name", "version", "executable_sha256"], `${label}.runtime`);
    const runtimeName = string(runtime.name, `${label}.runtime.name`);
    if (runtimeName !== "bun" && runtimeName !== "node" && runtimeName !== "rust") fail(`${label}.runtime.name is unsupported`);
    const host = record(value.host, `${label}.host`);
    exact(host, ["id_sha256", "kernel", "cpu", "topology_sha256"], `${label}.host`);
    return {
        source_commit: commit(value.source_commit, `${label}.source_commit`),
        platform: "linux-x64-gnu",
        profile: "mc-host-eventfd-ring-v2",
        wire_version: 2,
        descriptor_schema: 3,
        transferred_descriptors: 6,
        environment_watchers: 1,
        package: { name: string(pkg.name, `${label}.package.name`), version: string(pkg.version, `${label}.package.version`), sha256: digest(pkg.sha256, `${label}.package.sha256`) },
        runtime: { name: runtimeName, version: string(runtime.version, `${label}.runtime.version`), executable_sha256: digest(runtime.executable_sha256, `${label}.runtime.executable_sha256`) },
        host: { id_sha256: digest(host.id_sha256, `${label}.host.id_sha256`), kernel: string(host.kernel, `${label}.host.kernel`), cpu: string(host.cpu, `${label}.host.cpu`), topology_sha256: digest(host.topology_sha256, `${label}.host.topology_sha256`) },
        harness_sha256: digest(value.harness_sha256, `${label}.harness_sha256`),
        workload_sha256: digest(value.workload_sha256, `${label}.workload_sha256`),
    };
}

function parseRun(input: unknown, expectedRole: Role): RunEvidence {
    const value = record(input, `${expectedRole} run`);
    exact(value, ["schema", "role", "transport", "installed_artifact", "state", "identity", "blocks"], `${expectedRole} run`);
    if (value.schema !== RUN_SCHEMA || value.role !== expectedRole) fail(`${expectedRole} run schema or role mismatch`);
    if (value.transport !== "tcp" && value.transport !== "ring") fail(`${expectedRole} transport is invalid`);
    if (typeof value.installed_artifact !== "boolean") fail(`${expectedRole} installed_artifact must be boolean`);
    if (value.state !== "complete" && value.state !== "interrupted" && value.state !== "failed") fail(`${expectedRole} run state is invalid`);
    if (!Array.isArray(value.blocks)) fail(`${expectedRole} blocks must be an array`);
    const blocks = value.blocks.map((input, index) => {
        const block = record(input, `${expectedRole}.blocks[${index}]`);
        exact(block, ["block", "process_id", "workload", "connection_count", "callback_budget", "state", "completed_ops", "elapsed_ns", "latencies_ns", "body_copies", "allocations", "cpu_ns", "wakeups", "p99_event_loop_delay_ns", "rss_bytes", "pss_bytes", "resident_pages", "page_table_bytes", "fd_count", "watcher_count", "eventfd_attempts", "eventfd_successes", "eventfd_eagain", "eventfd_reads", "parks", "spurious_wakes", "publications", "tsfn_callbacks", "scheduler_handoffs", "reclaim_scans", "reclaim_bytes", "reclaim_runs", "madv_remove_calls", "madv_remove_pages", "queue_hops"], `${expectedRole}.blocks[${index}]`);
        if (block.state !== "complete" && block.state !== "interrupted" && block.state !== "failed") fail(`${expectedRole}.blocks[${index}].state is invalid`);
        if (!Array.isArray(block.latencies_ns)) fail(`${expectedRole}.blocks[${index}].latencies_ns must be an array`);
        const completedOps = integer(block.completed_ops, `${expectedRole}.blocks[${index}].completed_ops`, 1);
        const workload = string(block.workload, `${expectedRole}.blocks[${index}].workload`);
        if (!["setup", "cold_first_frame", "end_to_end", "active_path", "idle"].includes(workload)) fail(`${expectedRole}.blocks[${index}].workload is invalid`);
        const connectionCount = integer(block.connection_count, `${expectedRole}.blocks[${index}].connection_count`, 1);
        if (connectionCount !== 1 && connectionCount !== 8 && connectionCount !== 64) fail(`${expectedRole}.blocks[${index}].connection_count must be 1, 8, or 64`);
        const latencies = block.latencies_ns.map((entry, i) => integer(entry, `${expectedRole}.blocks[${index}].latencies_ns[${i}]`, 1));
        if (latencies.length !== completedOps) fail(`${expectedRole}.blocks[${index}] latency count must equal completed_ops`);
        return {
            block: integer(block.block, `${expectedRole}.blocks[${index}].block`, 1),
            process_id: integer(block.process_id, `${expectedRole}.blocks[${index}].process_id`, 1),
            workload: workload as RunBlock["workload"],
            connection_count: connectionCount as RunBlock["connection_count"],
            callback_budget: integer(block.callback_budget, `${expectedRole}.blocks[${index}].callback_budget`, 1),
            state: block.state,
            completed_ops: completedOps,
            elapsed_ns: integer(block.elapsed_ns, `${expectedRole}.blocks[${index}].elapsed_ns`, 1),
            latencies_ns: latencies,
            body_copies: integer(block.body_copies, `${expectedRole}.blocks[${index}].body_copies`),
            allocations: integer(block.allocations, `${expectedRole}.blocks[${index}].allocations`),
            cpu_ns: integer(block.cpu_ns, `${expectedRole}.blocks[${index}].cpu_ns`, 1),
            wakeups: integer(block.wakeups, `${expectedRole}.blocks[${index}].wakeups`),
            p99_event_loop_delay_ns: integer(block.p99_event_loop_delay_ns, `${expectedRole}.blocks[${index}].p99_event_loop_delay_ns`, 1),
            rss_bytes: integer(block.rss_bytes, `${expectedRole}.blocks[${index}].rss_bytes`),
            pss_bytes: integer(block.pss_bytes, `${expectedRole}.blocks[${index}].pss_bytes`),
            resident_pages: integer(block.resident_pages, `${expectedRole}.blocks[${index}].resident_pages`),
            page_table_bytes: integer(block.page_table_bytes, `${expectedRole}.blocks[${index}].page_table_bytes`),
            fd_count: integer(block.fd_count, `${expectedRole}.blocks[${index}].fd_count`),
            watcher_count: integer(block.watcher_count, `${expectedRole}.blocks[${index}].watcher_count`),
            eventfd_attempts: integer(block.eventfd_attempts, `${expectedRole}.blocks[${index}].eventfd_attempts`),
            eventfd_successes: integer(block.eventfd_successes, `${expectedRole}.blocks[${index}].eventfd_successes`),
            eventfd_eagain: integer(block.eventfd_eagain, `${expectedRole}.blocks[${index}].eventfd_eagain`),
            eventfd_reads: integer(block.eventfd_reads, `${expectedRole}.blocks[${index}].eventfd_reads`),
            parks: integer(block.parks, `${expectedRole}.blocks[${index}].parks`),
            spurious_wakes: integer(block.spurious_wakes, `${expectedRole}.blocks[${index}].spurious_wakes`),
            publications: integer(block.publications, `${expectedRole}.blocks[${index}].publications`),
            tsfn_callbacks: integer(block.tsfn_callbacks, `${expectedRole}.blocks[${index}].tsfn_callbacks`),
            scheduler_handoffs: integer(block.scheduler_handoffs, `${expectedRole}.blocks[${index}].scheduler_handoffs`),
            reclaim_scans: integer(block.reclaim_scans, `${expectedRole}.blocks[${index}].reclaim_scans`),
            reclaim_bytes: integer(block.reclaim_bytes, `${expectedRole}.blocks[${index}].reclaim_bytes`),
            reclaim_runs: integer(block.reclaim_runs, `${expectedRole}.blocks[${index}].reclaim_runs`),
            madv_remove_calls: integer(block.madv_remove_calls, `${expectedRole}.blocks[${index}].madv_remove_calls`),
            madv_remove_pages: integer(block.madv_remove_pages, `${expectedRole}.blocks[${index}].madv_remove_pages`),
            queue_hops: integer(block.queue_hops, `${expectedRole}.blocks[${index}].queue_hops`),
        } as RunBlock;
    });
    return { schema: RUN_SCHEMA, role: expectedRole, transport: value.transport, installed_artifact: value.installed_artifact, state: value.state, identity: parseIdentity(value.identity, `${expectedRole}.identity`), blocks };
}

function assertRun(config: GateConfig, run: RunEvidence, role: Role): void {
    if (run.state !== "complete") fail(`${role} run is ${run.state}`);
    if (!run.installed_artifact) fail(`${role} run must exercise an installed artifact`);
    if (run.transport !== "ring") fail(`${role} transport must be ring`);
    if (run.blocks.length !== config.expected_blocks || run.blocks.some((block) => block.state !== "complete")) fail(`${role} run expected ${config.expected_blocks} complete blocks`);
    const ids = run.blocks.map((block) => block.block).sort((a, b) => a - b);
    if (ids.some((block, index) => block !== index + 1)) fail(`${role} blocks must be unique and contiguous`);
    const processIds = new Set(run.blocks.map((block) => block.process_id));
    if (processIds.size !== run.blocks.length) fail(`${role} blocks must come from independent processes`);
    for (const block of run.blocks) {
        if (block.callback_budget !== config.frozen_contract!.callback_budget) fail(`${role} callback budget mismatch`);
        if (block.eventfd_attempts !== block.eventfd_successes + block.eventfd_eagain) fail(`${role} eventfd accounting mismatch`);
    }
}

function assertIdentity(config: GateConfig, matched: MatchedIdentity, baseline: RunIdentity, candidate: RunIdentity): void {
    const frozen = config.baseline!;
    const expected = config.candidate!;
    if (baseline.source_commit !== frozen.source_commit || baseline.package.sha256 !== frozen.package_sha256) fail("baseline commit or package identity mismatch");
    if (candidate.source_commit !== expected.source_commit || candidate.package.name !== expected.package_name || candidate.package.version !== expected.package_version || candidate.package.sha256 !== expected.package_sha256) fail("candidate commit or package identity mismatch");
    const checks: Array<[unknown, unknown, string]> = [
        [baseline.runtime.name, matched.runtime_name, "baseline runtime name"],
        [candidate.runtime.name, matched.runtime_name, "candidate runtime name"],
        [baseline.runtime.version, matched.runtime_version, "baseline runtime version"],
        [candidate.runtime.version, matched.runtime_version, "candidate runtime version"],
        [baseline.runtime.executable_sha256, matched.runtime_executable_sha256, "baseline runtime executable"],
        [candidate.runtime.executable_sha256, matched.runtime_executable_sha256, "candidate runtime executable"],
        [baseline.host.id_sha256, matched.host_id_sha256, "baseline host identity"],
        [candidate.host.id_sha256, matched.host_id_sha256, "candidate host identity"],
        [baseline.host.topology_sha256, matched.host_topology_sha256, "baseline host topology"],
        [candidate.host.topology_sha256, matched.host_topology_sha256, "candidate host topology"],
        [baseline.harness_sha256, matched.harness_sha256, "baseline harness"],
        [candidate.harness_sha256, matched.harness_sha256, "candidate harness"],
        [baseline.workload_sha256, matched.workload_sha256, "baseline workload"],
        [candidate.workload_sha256, matched.workload_sha256, "candidate workload"],
    ];
    for (const [actual, wanted, label] of checks) if (actual !== wanted) fail(`${label} mismatch`);
    if (baseline.host.kernel !== candidate.host.kernel || baseline.host.cpu !== candidate.host.cpu) fail("baseline and candidate host description mismatch");
}

function percentile(sorted: readonly number[], percentile: number): number {
    return sorted[Math.ceil(percentile * sorted.length) - 1]!;
}

function metrics(run: RunEvidence): Metrics {
    const latencies = run.blocks.flatMap((block) => block.latencies_ns).sort((a, b) => a - b);
    const sum = (field: keyof Pick<RunBlock, "completed_ops" | "elapsed_ns" | "body_copies" | "allocations" | "cpu_ns" | "wakeups">) =>
        run.blocks.reduce((total, block) => total + block[field], 0);
    return {
        p50_latency_ns: percentile(latencies, 0.5),
        p99_latency_ns: percentile(latencies, 0.99),
        throughput_ops_per_second: (sum("completed_ops") * 1_000_000_000) / sum("elapsed_ns"),
        body_copies: sum("body_copies"),
        allocations: sum("allocations"),
        cpu_ns: sum("cpu_ns"),
        wakeups: sum("wakeups"),
    };
}

function blockMetrics(block: RunBlock): Metrics {
    const latencies = [...block.latencies_ns].sort((a, b) => a - b);
    return {
        p50_latency_ns: percentile(latencies, 0.5),
        p99_latency_ns: percentile(latencies, 0.99),
        throughput_ops_per_second: (block.completed_ops * 1_000_000_000) / block.elapsed_ns,
        body_copies: block.body_copies,
        allocations: block.allocations,
        cpu_ns: block.cpu_ns,
        wakeups: block.wakeups,
    };
}

function compare(base: Metrics, next: Metrics): MetricComparison {
    return {
        p50_ratio: next.p50_latency_ns / base.p50_latency_ns,
        p99_ratio: next.p99_latency_ns / base.p99_latency_ns,
        throughput_ratio: next.throughput_ops_per_second / base.throughput_ops_per_second,
        copies_delta: next.body_copies - base.body_copies,
        allocations_delta: next.allocations - base.allocations,
        cpu_ratio: next.cpu_ns / base.cpu_ns,
        wakeups_delta: next.wakeups - base.wakeups,
    };
}

export function buildReleaseGateReport(config: GateConfig, baselineInput: unknown, candidateInput: unknown): ReleaseGateReport {
    if (config.state === "blocked") fail(`release gate blocked: ${config.blockers.join("; ")}`);
    const parseSuite = (input: unknown, role: Role) => {
        const suite = record(input, `${role} suite`);
        exact(suite, ["schema", "runs", "blocked_runtimes"], `${role} suite`);
        if (suite.schema !== SUITE_SCHEMA || !Array.isArray(suite.runs) || !Array.isArray(suite.blocked_runtimes)) fail(`${role} suite schema or runs mismatch`);
        const runs = suite.runs.map((run) => parseRun(run, role));
        const blockers = suite.blocked_runtimes.map((input, index) => {
            const blocker = record(input, `${role}.blocked_runtimes[${index}]`);
            exact(blocker, ["runtime", "reason"], `${role}.blocked_runtimes[${index}]`);
            if (blocker.runtime !== "node") fail(`${role} may block only Node performance evidence`);
            return { runtime: "node" as const, reason: string(blocker.reason, `${role}.blocked_runtimes[${index}].reason`) };
        });
        if (blockers.length > 1) fail(`${role} has duplicate Node blockers`);
        const names = runs.map((run) => run.identity.runtime.name);
        const expected = blockers.length === 0 ? ["bun", "node"] : ["bun"];
        if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) fail(`${role} suite must contain ordered Bun and eligible Node runs`);
        return { runs, blockers };
    };
    const baselineSuite = parseSuite(baselineInput, "baseline");
    const candidateSuite = parseSuite(candidateInput, "candidate");
    const runtimeResults = config.required_runtimes.map((runtime, index) => {
        const blocker = baselineSuite.blockers[0] ?? candidateSuite.blockers[0];
        if (runtime === "node" && blocker) return { runtime, local_verdict: "blocked" as const, blocker: blocker.reason };
        const baseline = baselineSuite.runs[index]!;
        const candidate = candidateSuite.runs[index]!;
        assertRun(config, baseline, "baseline");
        assertRun(config, candidate, "candidate");
        assertIdentity(config, config.matched_identities![index]!, baseline.identity, candidate.identity);
        const base = metrics(baseline);
        const next = metrics(candidate);
        const pairedBlocks = baseline.blocks.map((baselineBlock, blockIndex) => {
            const candidateBlock = candidate.blocks[blockIndex]!;
            if (candidateBlock.block !== baselineBlock.block) fail("paired block identity mismatch");
            if (candidateBlock.workload !== baselineBlock.workload || candidateBlock.connection_count !== baselineBlock.connection_count || candidateBlock.callback_budget !== baselineBlock.callback_budget) fail("paired block workload identity mismatch");
            const baselineMetrics = blockMetrics(baselineBlock);
            const candidateMetrics = blockMetrics(candidateBlock);
            return {
                block: baselineBlock.block,
                workload: baselineBlock.workload,
                connection_count: baselineBlock.connection_count,
                callback_budget: baselineBlock.callback_budget,
                baseline: baselineBlock,
                candidate: candidateBlock,
                comparison: compare(baselineMetrics, candidateMetrics),
            };
        });
        return {
            runtime,
            local_verdict: "evidence_complete" as const,
            baseline: { identity: baseline.identity, metrics: base },
            candidate: { identity: candidate.identity, metrics: next },
            paired_blocks: pairedBlocks,
            comparison: compare(base, next),
        };
    });
    return {
        schema: REPORT_SCHEMA,
        local_verdict: "evidence_complete",
        designated_host_verdict: config.designated_host,
        claim: "paired_measurement_against_frozen_contract",
        frozen_contract: config.frozen_contract!,
        runtime_results: runtimeResults,
    };
}

function readJson(path: string, label: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        fail(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function blockedReport(config: GateConfig) {
    return {
        schema: REPORT_SCHEMA,
        local_verdict: "blocked",
        local_blockers: config.blockers,
        designated_host_verdict: config.designated_host,
        baseline: null,
        candidate: null,
        comparison: null,
    };
}

function complete(config: GateConfig, candidateInput: unknown, outPath: string): void {
    const baselineInput = baselineInputs.get(config);
    if (!baselineInputs.has(config)) fail("frozen baseline is unreadable: validated bytes unavailable");
    const report = buildReleaseGateReport(config, baselineInput, candidateInput);
    try {
        writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            fail(`refusing to overwrite report ${outPath}`);
        }
        throw error;
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function main(): void {
    const [commandName, configArg, evidenceArg, outArg] = Bun.argv.slice(2);
    if (!commandName || !configArg) fail("usage: mc-shm-release-gate.ts status <config> | verify <config> <candidate.json> <report.json> | run <config> <report.json>");
    const configPath = resolve(configArg);
    const config = readGateConfig(configPath);
    if (commandName === "status") {
        process.stdout.write(`${JSON.stringify(config.state === "blocked" ? blockedReport(config) : { schema: REPORT_SCHEMA, local_verdict: "ready", designated_host_verdict: config.designated_host }, null, 2)}\n`);
        return;
    }
    if (config.state === "blocked") {
        process.stdout.write(`${JSON.stringify(blockedReport(config), null, 2)}\n`);
        process.exitCode = 1;
        return;
    }
    if (commandName === "verify") {
        if (!evidenceArg || !outArg) fail("verify requires candidate evidence and report paths");
        complete(config, readJson(resolve(evidenceArg), "candidate evidence"), resolve(outArg));
        return;
    }
    if (commandName === "run") {
        if (!evidenceArg || outArg) fail("run requires one report path");
        const candidate = config.candidate!;
        if (!candidate.package_path || !candidate.collector_path || !candidate.collector_sha256) fail("run requires package_path and digest-bound collector fields");
        const collectorPath = resolveBoundPath(configPath, candidate.collector_path);
        const packagePath = resolveBoundPath(configPath, candidate.package_path);
        const result = Bun.spawnSync([collectorPath, ...(candidate.collector_args ?? [])], {
            cwd: dirname(packagePath),
            env: { ...process.env, MC_SHM_PERF_PACKAGE: packagePath },
            stdout: "pipe",
            stderr: "inherit",
        });
        if (result.exitCode !== 0) fail(`installed-path collector exited ${result.exitCode}`);
        let candidateInput: unknown;
        try {
            candidateInput = JSON.parse(result.stdout.toString());
        } catch {
            fail("installed-path collector emitted malformed JSON");
        }
        complete(config, candidateInput, resolve(evidenceArg));
        return;
    }
    fail(`unknown command ${commandName}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
