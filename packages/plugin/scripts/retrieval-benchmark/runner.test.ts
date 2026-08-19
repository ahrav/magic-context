import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReviewedRelease, type ReviewedRelease } from "./index";
import { nearestRankPercentile } from "./timing";
import { type BenchmarkProfile, parseProfile, type ProfileCase } from "./profiles";
import { parseReport, passEligibility } from "./report";
import {
    aggregateReportQuality,
    type RunBenchmarkResult,
    runBenchmark,
    RunnerError,
    RunnerInterrupt,
    type RunnerHooks,
} from "./runner";

const V1_RELEASE_DIR = join(import.meta.dir, "..", "fixtures", "retrieval-benchmark", "v1");
const CI_PROFILE_PATH = join(
    import.meta.dir,
    "..",
    "fixtures",
    "retrieval-benchmark",
    "profiles",
    "v1",
    "ci.json",
);
const CLI_PATH = join(import.meta.dir, "..", "benchmark-retrieval.ts");

let release: ReviewedRelease;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

beforeAll(() => {
    release = loadReviewedRelease(V1_RELEASE_DIR);
});

afterAll(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Observed message-lane cardinality of the seeded scale-1000 fixture. */
const DENOMINATOR_1K = 327;

const WARM_STATE = {
    processVector: "warm",
    connectionStatement: "warm",
    sqlitePage: "warm",
    osPage: "warm",
} as const;
const COLD_STATE = {
    processVector: "cold",
    connectionStatement: "cold",
    sqlitePage: "cold",
    osPage: "cold",
} as const;

function fullSelectivity() {
    return {
        fraction: 1,
        predicate: {
            projectScope: "git:benchmark-fixture-project",
            sessionScope: null,
            sources: null,
            messageOrdinalCutoff: null,
            visibleMemoryIds: [],
        },
        preFilterDenominator: DENOMINATOR_1K,
        eligibleCount: DENOMINATOR_1K,
        expectedScannedCount: DENOMINATOR_1K,
    };
}

function tinyCase(id: string, over: Partial<ProfileCase> = {}): ProfileCase {
    return {
        id,
        scale: 1_000,
        dims: 128,
        candidateK: { requested: 50, effective: 50 },
        mode: "explicit",
        sourceLanes: null,
        concurrency: 1,
        cacheState: { ...WARM_STATE },
        selectivity: fullSelectivity(),
        ...over,
    } as ProfileCase;
}

function tinyProfile(overrides: {
    cases?: ProfileCase[];
    samples?: number;
    warmups?: number;
}): BenchmarkProfile {
    const cases = overrides.cases ?? [
        tinyCase("case-warm-explicit"),
        tinyCase("case-auto-lane", { mode: "automatic", sourceLanes: ["message"] }),
        tinyCase("case-cold", {
            candidateK: { requested: 5, effective: 5 },
            cacheState: { ...COLD_STATE },
        }),
    ];
    return parseProfile({
        schemaVersion: "retrieval-benchmark-profile/v1",
        id: "profile-tiny",
        description: "runner-test tiny ci-class profile",
        expectedCaseCount: cases.length,
        runtime: {
            warmups: overrides.warmups ?? 1,
            samples: overrides.samples ?? 2,
            maxWallTimeMs: 600_000,
        },
        budgets: { maxFixtureBytes: 67_108_864, maxPeakRssBytes: 1_073_741_824 },
        host: {
            class: "ci",
            cpuArchitecture: "any",
            minTotalMemoryBytes: 2_147_483_648,
            minAvailableDiskBytes: 1_073_741_824,
        },
        cases,
    });
}

/** Deterministic clocks: every monotonic read advances one tick, so any
 *  duration equals the number of interleaved clock reads, not wall time. */
function counterHooks(extra: Partial<RunnerHooks> = {}): RunnerHooks {
    let tick = 0;
    return {
        now: () => {
            tick += 1;
            return tick;
        },
        epochNow: () => 1_755_000_000_000,
        ...extra,
    };
}

async function run(
    profile: BenchmarkProfile,
    options: {
        hooks?: RunnerHooks;
        checkpointDir?: string;
        requireOsPageEvictionProof?: boolean;
        autoScoreThreshold?: number;
    } = {},
): Promise<RunBenchmarkResult> {
    return runBenchmark({
        release,
        profile,
        workDir: tempDir("rb-runner-"),
        ...(options.checkpointDir ? { checkpointDir: options.checkpointDir } : {}),
        ...(options.requireOsPageEvictionProof !== undefined
            ? { requireOsPageEvictionProof: options.requireOsPageEvictionProof }
            : {}),
        ...(options.autoScoreThreshold !== undefined
            ? { autoScoreThreshold: options.autoScoreThreshold }
            : {}),
        ...(options.hooks ? { hooks: options.hooks } : {}),
    });
}

function loadCiProfile(): BenchmarkProfile {
    return parseProfile(JSON.parse(readFileSync(CI_PROFILE_PATH, "utf8")));
}

describe("runBenchmark CI check (scenario 1)", () => {
    it(
        "executes every expected case exactly once with stable semantic identity and a run-specific digest",
        async () => {
            const profile = loadCiProfile();
            const first = await run(profile);
            const second = await run(profile);

            expect(first.report.status).toBe("complete");
            expect(second.report.status).toBe("complete");
            expect(first.report.evidence.cases.map((c) => c.caseId)).toEqual(
                profile.cases.map((c) => c.id),
            );

            const expectedIds = profile.cases.flatMap((profileCase) =>
                release.corpus.queries
                    .filter((query) => query.mode === profileCase.mode)
                    .map((query) => `${profileCase.id}:${query.id}`),
            );
            const seenIds = first.report.evidence.scenarios.map((s) => s.queryId);
            expect([...seenIds].sort()).toEqual([...expectedIds].sort());
            expect(new Set(seenIds).size).toBe(seenIds.length);

            expect(first.semanticFingerprint).toBe(second.semanticFingerprint);
            expect(
                first.report.evidence.scenarios.map((s) => [s.queryId, s.rankedPhysical]),
            ).toEqual(second.report.evidence.scenarios.map((s) => [s.queryId, s.rankedPhysical]));
            expect(first.evidenceDigest).not.toBe(second.evidenceDigest);
        },
        120_000,
    );
});

describe("mode separation (scenario 2)", () => {
    it(
        "keeps explicit and automatic aggregates in separate cells",
        async () => {
            const result = await run(tinyProfile({}), { hooks: counterHooks() });
            expect(result.report.status).toBe("complete");

            const aggregates = aggregateReportQuality(result.report);
            const cells = aggregates.map((a) => `${a.partition}:${a.mode}`);
            expect(cells).toContain("holdout:explicit");
            expect(cells).toContain("holdout:automatic");

            const scenarioCount = (mode: string, partition: string) =>
                result.report.evidence.scenarios.filter(
                    (s) => s.mode === mode && s.partition === partition,
                ).length;
            for (const aggregate of aggregates) {
                expect(aggregate.queryCount).toBe(
                    scenarioCount(aggregate.mode, aggregate.partition),
                );
            }
        },
        60_000,
    );
});

describe("closed-loop concurrency (scenario 3)", () => {
    it(
        "uses the declared worker count and keeps per-query samples and traces separate",
        async () => {
            const profile = tinyProfile({
                cases: [
                    tinyCase("case-warm-explicit", { concurrency: 2 }),
                    tinyCase("case-auto-lane", { mode: "automatic", sourceLanes: ["message"] }),
                    tinyCase("case-cold", {
                        candidateK: { requested: 5, effective: 5 },
                        cacheState: { ...COLD_STATE },
                    }),
                ],
            });
            const result = await run(profile, { hooks: counterHooks() });
            expect(result.report.status).toBe("complete");

            const byCase = new Map(result.report.evidence.cases.map((c) => [c.caseId, c]));
            expect(byCase.get("case-warm-explicit")?.workerCount).toBe(2);
            expect(byCase.get("case-auto-lane")?.workerCount).toBe(1);

            for (const scenario of result.report.evidence.scenarios) {
                expect(scenario.latencySamplesMs).toHaveLength(2);
                if (scenario.deliveryReason === "delivered") {
                    expect(scenario.timing).not.toBeNull();
                }
            }
        },
        60_000,
    );
});

describe("cache-layer lifecycle (scenario 4)", () => {
    it(
        "warm cases verify hits without resets; cold cases reset per sample on fresh connections",
        async () => {
            const invalidated: string[] = [];
            const result = await run(tinyProfile({}), {
                hooks: counterHooks({
                    cache: {
                        invalidateProcessVector: (scope) => {
                            invalidated.push(scope);
                        },
                    },
                }),
            });
            expect(result.report.status).toBe("complete");
            const byCase = new Map(result.report.evidence.cases.map((c) => [c.caseId, c]));

            const warm = byCase.get("case-warm-explicit");
            const warmLayers = new Map(warm?.cacheLayers.map((l) => [l.layer, l]));
            expect(warmLayers.get("processVector")?.declared).toBe("warm");
            expect(warmLayers.get("processVector")?.resets).toBe(0);
            expect(warmLayers.get("processVector")?.verifications).toBeGreaterThan(0);
            expect(warmLayers.get("processVector")?.status).toBe("verified");
            expect(warmLayers.get("connectionStatement")?.resets).toBe(0);
            expect(warmLayers.get("connectionStatement")?.verifications).toBeGreaterThan(0);

            const cold = byCase.get("case-cold");
            const coldLayers = new Map(cold?.cacheLayers.map((l) => [l.layer, l]));
            const coldResets = coldLayers.get("processVector")?.resets ?? 0;
            expect(coldResets).toBeGreaterThan(0);
            expect(invalidated.length).toBe(coldResets);
            expect(coldLayers.get("connectionStatement")?.mechanism).toBe(
                "fresh-read-only-connection-per-sample",
            );
            expect(coldLayers.get("connectionStatement")?.resets).toBeGreaterThan(0);
            expect(coldLayers.get("osPage")?.status).toBe("not-attempted");
        },
        60_000,
    );

    it(
        "rejects a warm case whose process-vector cache expires mid-case",
        async () => {
            let peeks = 0;
            const result = await run(tinyProfile({}), {
                hooks: counterHooks({
                    cache: {
                        peekProcessVector: () => {
                            peeks += 1;
                            return peeks <= 3;
                        },
                    },
                }),
            });
            expect(result.report.status).toBe("incomplete");
            const attempt = result.report.evidence.attempts.at(-1);
            expect(attempt?.status).toBe("failed");
            expect(attempt?.diagnostics.join(";")).toContain("cache transition inside case");
            expect(passEligibility(result.report, { compatible: true }).eligible).toBe(false);
        },
        60_000,
    );

    it(
        "rejects a cold OS-page case without eviction proof when proof is required",
        async () => {
            const required = await run(tinyProfile({}), {
                requireOsPageEvictionProof: true,
                hooks: counterHooks(),
            });
            expect(required.report.status).toBe("incomplete");
            expect(required.report.evidence.attempts.at(-1)?.diagnostics.join(";")).toContain(
                "OS-page eviction requires recorded proof",
            );

            const proven = await run(tinyProfile({}), {
                requireOsPageEvictionProof: true,
                hooks: counterHooks({
                    cache: {
                        evictOsPageCache: () => ({ attempted: true, proof: "posix-fadvise" }),
                    },
                }),
            });
            expect(proven.report.status).toBe("complete");
            const cold = proven.report.evidence.cases.find((c) => c.caseId === "case-cold");
            const os = cold?.cacheLayers.find((l) => l.layer === "osPage");
            expect(os?.status).toBe("verified");
            expect(os?.mechanism).toBe("eviction-hook:posix-fadvise");
        },
        60_000,
    );
});

describe("policy timing separation (scenario 5)", () => {
    it(
        "computes p95 from trace-disabled samples while the traced pass stays diagnostic",
        async () => {
            const profile = tinyProfile({ samples: 3 });
            const result = await run(profile, { hooks: counterHooks() });
            expect(result.report.status).toBe("complete");

            for (const scenario of result.report.evidence.scenarios) {
                expect(scenario.latencySamplesMs).toHaveLength(3);
                // Under the one-tick counter clock an untraced delivery costs
                // exactly one tick between the two external reads; the traced
                // pass consumes a tick per span edge, so its root duration can
                // never be one of the policy samples.
                for (const sample of scenario.latencySamplesMs) {
                    expect(sample).toBe(1);
                }
                expect(nearestRankPercentile(scenario.latencySamplesMs, 95)).toBe(1);
                if (scenario.timing) {
                    expect(scenario.timing.rootDurationMs).toBeGreaterThan(1);
                    expect(scenario.timing.coveredMs + scenario.timing.uncoveredMs).toBeCloseTo(
                        scenario.timing.rootDurationMs,
                        6,
                    );
                }
            }
        },
        60_000,
    );
});

describe("checkpoints and resume (scenarios 6-8)", () => {
    it(
        "an interrupted run keeps completed cases, resumes only the missing ones, and matches an uninterrupted run",
        async () => {
            const profile = tinyProfile({});

            const uninterrupted = await run(profile, {
                checkpointDir: tempDir("rb-ckpt-a-"),
                hooks: counterHooks(),
            });
            expect(uninterrupted.report.status).toBe("complete");

            const checkpointDir = tempDir("rb-ckpt-b-");
            let checkpointed = 0;
            const interrupted = await run(profile, {
                checkpointDir,
                hooks: counterHooks({
                    onCaseCheckpointed: () => {
                        checkpointed += 1;
                        if (checkpointed === 1) throw new RunnerInterrupt("simulated stop");
                    },
                }),
            });
            expect(interrupted.report.status).toBe("incomplete");
            expect(interrupted.report.evidence.attempts.at(-1)?.status).toBe("interrupted");
            expect(interrupted.report.evidence.cases).toHaveLength(1);
            expect(passEligibility(interrupted.report, { compatible: true }).eligible).toBe(
                false,
            );

            const resumed = await run(profile, {
                checkpointDir,
                hooks: counterHooks(),
            });
            expect(resumed.report.status).toBe("complete");
            expect(resumed.report.evidence.attempts).toHaveLength(2);
            expect(resumed.report.evidence.attempts[0]?.status).toBe("interrupted");
            expect(resumed.semanticFingerprint).toBe(uninterrupted.semanticFingerprint);
            expect(resumed.report.evidence.scenarios).toEqual(
                uninterrupted.report.evidence.scenarios,
            );
            expect(resumed.report.evidence.cases).toEqual(uninterrupted.report.evidence.cases);

            const cold = resumed.report.evidence.cases.find(
                (c) => c.caseId === "case-cold",
            );
            expect(
                cold?.cacheLayers.find((l) => l.layer === "processVector")?.resets,
            ).toBeGreaterThan(0);
        },
        120_000,
    );

    it(
        "rejects resume when the run identity differs (scenario 7)",
        async () => {
            const profile = tinyProfile({});
            const checkpointDir = tempDir("rb-ckpt-c-");
            const first = await run(profile, { checkpointDir, hooks: counterHooks() });
            expect(first.report.status).toBe("complete");

            const differentProfile = tinyProfile({ samples: 3 });
            await expect(
                run(differentProfile, { checkpointDir, hooks: counterHooks() }),
            ).rejects.toThrow("incompatible-resume");

            const runFile = join(checkpointDir, "run.json");
            const tampered = JSON.parse(readFileSync(runFile, "utf8"));
            tampered.identityFingerprint = "0".repeat(64);
            writeFileSync(runFile, JSON.stringify(tampered));
            await expect(
                run(profile, { checkpointDir, hooks: counterHooks() }),
            ).rejects.toThrow("incompatible-resume");
            await expect(run(profile, { checkpointDir, hooks: counterHooks() })).rejects.toThrow(
                RunnerError,
            );
        },
        120_000,
    );
});

describe("CLI surface (scenario 9)", () => {
    it(
        "keeps stdout machine-readable while diagnostics go to stderr",
        async () => {
            const profileDir = tempDir("rb-cli-profile-");
            const profilePath = join(profileDir, "tiny.json");
            writeFileSync(
                profilePath,
                `${JSON.stringify(tinyProfile({ samples: 1 }), null, 2)}\n`,
            );
            const proc = Bun.spawnSync(
                ["bun", CLI_PATH, "check", "--profile", profilePath, "--release", V1_RELEASE_DIR],
                { stdout: "pipe", stderr: "pipe" },
            );
            expect(proc.exitCode).toBe(0);
            const stderr = proc.stderr.toString();
            expect(stderr).toContain("[benchmark-retrieval]");
            const report = parseReport(JSON.parse(proc.stdout.toString()));
            expect(report.status).toBe("complete");
        },
        120_000,
    );
});
