import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    FileRolloutStore,
    ProviderUnavailableError,
    baseScriptFingerprint,
    computeRegretRungs,
    interventionFor,
    runPairedDelta,
    verifyDualMockResolution,
    type RolloutHandle,
    type RolloutObservation,
    type RolloutRecord,
    type RolloutStore,
    type RunPairedDeltaOptions,
    type RunnerDependencies,
} from "./runner";
import type { ArmId, ScenarioDeclaration } from "./contract";

const scenario: ScenarioDeclaration = {
    scenarioId: "var-runner-smoke",
    familyId: "fam-runner",
    title: "Runner smoke",
    expectedAnswer: "alpha-17",
    answerMatch: "case-insensitive",
    checks: ["check-ladder", "check-primary"],
    criticalCheckIds: ["check-ladder"],
    turnScript: [
        { id: "turn-evidence", role: "user", content: "The identifier is alpha-17." },
        { id: "turn-probe", role: "user", content: "Return the identifier." },
    ],
    interventions: {
        r1: {
            insertAfterTurnId: "turn-evidence",
            locatorIds: ["mem-alpha"],
        },
        r2: { memories: [{ claim: "Identifier", evidence: "alpha-17" }] },
    },
    absencePrecondition: { evidenceTurnId: "turn-evidence", minimumBallastBytes: 1024 },
    modelContextLimit: 4096,
    restartArms: [],
    verifier: () => [],
};

class MemoryStore implements RolloutStore {
    constructor(readonly records: RolloutRecord[] = []) {}
    list(): RolloutRecord[] {
        return [...this.records];
    }
    put(record: RolloutRecord): void {
        const index = this.records.findIndex((candidate) =>
            candidate.poolManifestFingerprint === record.poolManifestFingerprint &&
            candidate.scenarioId === record.scenarioId &&
            candidate.armId === record.armId &&
            candidate.replicateIndex === record.replicateIndex);
        if (index >= 0 && this.records[index]?.cell.runHealth === "completed") {
            throw new Error("completed rollout replaced");
        }
        if (index >= 0) this.records[index] = record;
        else this.records.push(record);
    }
}

function options(store = new MemoryStore()): RunPairedDeltaOptions {
    return {
        scenarios: [scenario],
        poolManifestFingerprint: "a".repeat(64),
        repoCommit: "commit-a",
        pinnedProviderId: "mock-live",
        pinnedSnapshotId: "snapshot-2026-08-01",
        replicateCount: 1,
        deskCostCeilingUsd: 0.25,
        maxCostUsd: 100,
        deadlineEpochMs: 10_000,
        pricesPerMillionTokens: {
            input: 1,
            output: 2,
            cacheCreation: 1.25,
            cacheRead: 0.1,
        },
        resume: true,
        store,
    };
}

function observation(
    armId: ArmId,
    passed = true,
): RolloutObservation {
    return {
        checks: scenario.checks.map((id) => ({ id, passed })),
        claimedDone: true,
        absencePreconditionHeld: true,
        armIdentityMatches: true,
        echoedProviderId: "mock-live",
        echoedModelId: "snapshot-2026-08-01",
        usage: { input: 100, output: 10, cacheCreation: 20, cacheRead: 30 },
        turns: 2,
        baseScriptFingerprint: baseScriptFingerprint(scenario),
        intervention: interventionFor(scenario, armId),
    };
}

function dependencies(
    behavior: (armId: ArmId) => RolloutObservation | Error = (armId) =>
        observation(armId),
    events: string[] = [],
    disposeBehavior: (armId: ArmId) => Error | void = () => {},
): RunnerDependencies {
    return {
        now: () => 100,
        async createRollout({ coordinate, intervention }): Promise<RolloutHandle> {
            events.push(`create:${coordinate.armId}`);
            return {
                async prepare() {
                    events.push(`prepare:${coordinate.armId}:${intervention.kind}`);
                },
                async run() {
                    events.push(`run:${coordinate.armId}`);
                    const result = behavior(coordinate.armId);
                    if (result instanceof Error) throw result;
                    return result;
                },
                async dispose() {
                    events.push(`dispose:${coordinate.armId}`);
                    const failure = disposeBehavior(coordinate.armId);
                    if (failure instanceof Error) throw failure;
                },
            };
        },
    };
}

describe("paired-delta runner", () => {
    it("runs the three primary arms with observed four-class cost and disposal", async () => {
        const events: string[] = [];
        const result = await runPairedDelta(options(), dependencies(undefined, events));

        expect(result.status).toBe("completed");
        expect(result.records.map(({ armId }) => armId)).toEqual([
            "mc-on",
            "mc-off",
            "compaction",
        ]);
        expect(result.records.every(({ harnessDisposed }) => harnessDisposed)).toBe(true);
        expect(result.observedCostRollouts).toBe(3);
        expect(result.estimatedCostRollouts).toBe(0);
        expect(events.filter((event) => event.startsWith("dispose:"))).toHaveLength(3);
    });

    it("classifies a thrown rollout as harness failure, charges reserve, and disposes", async () => {
        const result = await runPairedDelta(
            options(),
            dependencies((armId) =>
                armId === "mc-off" ? new Error("prompt timeout") : observation(armId)),
        );
        const failed = result.records.find(({ armId }) => armId === "mc-off");

        expect(failed?.cell).toMatchObject({
            runHealth: "crash",
            reasonCode: "harness-failure",
            checksTotal: 0,
        });
        expect(failed?.costSource).toBe("estimated");
        expect(failed?.costUsd).toBe(0.25);
        expect(failed?.harnessDisposed).toBe(true);
        expect(result.coordinates[0]?.incomplete).toBe(true);
        expect(result.exclusionCounts["mc-off"]?.["harness-failure"]).toBe(1);
    });

    it("resumes completed records without replacing them and rehydrates reserve", async () => {
        const firstStore = new MemoryStore();
        const first = await runPairedDelta(options(firstStore), dependencies());
        const stored = first.records[0];
        if (!stored) throw new Error("missing fixture record");
        stored.costUsd = 2;
        const store = new MemoryStore([stored]);
        const events: string[] = [];

        const result = await runPairedDelta(options(store), dependencies(undefined, events));

        expect(result.resumedRollouts).toBe(1);
        expect(result.reserveUsd).toBe(2);
        expect(events).not.toContain("create:mc-on");
        expect(store.records.filter(({ armId }) => armId === "mc-on")).toHaveLength(1);
    });

    it("refuses a non-resume run over records for the same matrix", async () => {
        const store = new MemoryStore();
        await runPairedDelta(options(store), dependencies());
        const events: string[] = [];

        await expect(
            runPairedDelta(
                { ...options(store), resume: false },
                dependencies(undefined, events),
            ),
        ).rejects.toThrow(/resume the run or point at a fresh records path/);
        expect(events).toHaveLength(0);
    });

    it("retries and replaces non-completed records on resume", async () => {
        const store = new MemoryStore();
        await runPairedDelta(
            options(store),
            dependencies((armId) =>
                armId === "mc-off" ? new Error("first attempt failed") : observation(armId)),
        );
        const events: string[] = [];

        const result = await runPairedDelta(options(store), dependencies(undefined, events));

        expect(events).toContain("create:mc-off");
        expect(result.records.find(({ armId }) => armId === "mc-off")?.cell.runHealth)
            .toBe("completed");
        expect(store.records.filter(({ armId }) => armId === "mc-off")).toHaveLength(1);
    });

    it("invalidates a stored snapshot mismatch without replacing the record", async () => {
        const first = await runPairedDelta(options(), dependencies());
        const stale = first.records[0];
        if (!stale) throw new Error("missing fixture record");
        stale.echoedModelId = "different-snapshot";
        const store = new MemoryStore([stale]);

        const result = await runPairedDelta(options(store), dependencies());

        expect(result.status).toBe("invalid-stored-records");
        expect(result.invalidStoredCoordinates).toContainEqual({
            poolManifestFingerprint: "a".repeat(64),
            scenarioId: scenario.scenarioId,
            armId: "mc-on",
            replicateIndex: 0,
        });
        expect(store.records).toHaveLength(3);
        expect(store.records[0]?.echoedModelId).toBe("different-snapshot");
    });

    it("does not charge stale or out-of-matrix records to the resumed run", async () => {
        const first = await runPairedDelta(options(), dependencies());
        const stale = structuredClone(first.records[0]!);
        stale.repoCommit = "stale-commit";
        stale.costUsd = 50;
        const unrelated = structuredClone(first.records[1]!);
        unrelated.scenarioId = "var-unrelated";
        unrelated.costUsd = 25;

        const result = await runPairedDelta(
            options(new MemoryStore([stale, unrelated])),
            dependencies(),
        );

        expect(result.reserveUsd).toBe(0.25);
        expect(result.spentUsd).toBeLessThan(1);
        expect(result.invalidStoredCoordinates).toHaveLength(1);
    });

    it("always starts the first rollout then stops between rollouts at the cost cap", async () => {
        const constrained = { ...options(), maxCostUsd: 0 };
        const result = await runPairedDelta(constrained, dependencies());

        expect(result.status).toBe("cost-cap-reached");
        expect(result.records).toHaveLength(1);
        expect(result.coordinates[0]?.cells["mc-on"]).toBeDefined();
    });

    it("stops before the first rollout when the deadline has elapsed", async () => {
        const expired = { ...options(), deadlineEpochMs: 99 };
        const result = await runPairedDelta(expired, dependencies());

        expect(result.status).toBe("deadline-reached");
        expect(result.records).toHaveLength(0);
    });

    it("bounds an in-flight rollout with the run deadline and still disposes", async () => {
        const disposedArms: string[] = [];
        const result = await runPairedDelta(
            { ...options(), deadlineEpochMs: Date.now() + 25 },
            {
                now: Date.now,
                async createRollout({ coordinate }): Promise<RolloutHandle> {
                    return {
                        async run() {
                            return await new Promise<RolloutObservation>(() => {});
                        },
                        async dispose() {
                            disposedArms.push(coordinate.armId);
                        },
                    };
                },
            },
        );

        expect(result.status).toBe("deadline-reached");
        expect(result.records[0]?.cell).toMatchObject({
            runHealth: "timeout",
            reasonCode: "deadline-exceeded",
        });
        expect(result.records[0]?.harnessDisposed).toBe(true);
        expect(disposedArms).toEqual(["mc-on"]);
    });

    it("bounds rollout creation with the run deadline and disposes a late handle", async () => {
        const disposedArms: string[] = [];
        const lateHandle = (disposeFails: boolean) =>
            async (armId: string): Promise<RolloutHandle> => {
                // Creation outlives the deadline, then resolves while the run is
                // settling the handle it abandoned.
                await new Promise((resolve) => setTimeout(resolve, 60));
                return {
                    async run() {
                        throw new Error("run must not start after the deadline");
                    },
                    async dispose() {
                        if (disposeFails) throw new Error("harness would not stop");
                        disposedArms.push(armId);
                    },
                };
            };

        const reclaimed = await runPairedDelta(
            { ...options(), deadlineEpochMs: Date.now() + 25 },
            {
                now: Date.now,
                createRollout: ({ coordinate }) => lateHandle(false)(coordinate.armId),
            },
        );

        expect(reclaimed.status).toBe("deadline-reached");
        expect(reclaimed.records[0]?.cell).toMatchObject({
            runHealth: "timeout",
            reasonCode: "deadline-exceeded",
        });
        expect(reclaimed.records[0]?.harnessDisposed).toBe(false);
        // The harness the abandoned creation owns is still reclaimed, and the run
        // does not report until it knows.
        expect(disposedArms).toEqual(["mc-on"]);

        const unreclaimed = await runPairedDelta(
            { ...options(), deadlineEpochMs: Date.now() + 25 },
            {
                now: Date.now,
                createRollout: ({ coordinate }) => lateHandle(true)(coordinate.armId),
            },
        );

        // A late handle that will not dispose reaches the caller as contamination
        // rather than as silence.
        expect(unreclaimed.status).toBe("harness-unreclaimed");
    });

    it("gives the rollout only the deadline left after creation", async () => {
        let now = 1_000;
        const result = await runPairedDelta(
            { ...options(), deadlineEpochMs: now + 100 },
            {
                now: () => now,
                async createRollout({ coordinate }): Promise<RolloutHandle> {
                    // Creation consumes 90 of the run's 100ms budget, leaving 10.
                    now += 90;
                    return {
                        async run() {
                            // Longer than the 10ms that remain, shorter than the
                            // 100ms measured before creation.
                            await new Promise((resolve) => setTimeout(resolve, 40));
                            return observation(coordinate.armId);
                        },
                        async dispose() {},
                    };
                },
            },
        );

        expect(result.status).toBe("deadline-reached");
        expect(result.records[0]?.cell).toMatchObject({
            runHealth: "timeout",
            reasonCode: "deadline-exceeded",
        });
    });

    it("counts only the rollouts it reports when the cap stops the run", async () => {
        const store = new MemoryStore();
        const seeded = await runPairedDelta(options(store), dependencies());

        expect(seeded.records).toHaveLength(3);

        // Drop the first arm so the resumed run must execute before it reaches
        // the two stored coordinates behind it.
        store.records.splice(store.records.findIndex(({ armId }) => armId === "mc-on"), 1);
        const spentBefore = store.records.reduce((sum, { costUsd }) => sum + costUsd, 0);
        const resumed = await runPairedDelta(
            { ...options(store), maxCostUsd: spentBefore },
            dependencies(),
        );

        expect(resumed.status).toBe("cost-cap-reached");
        expect(resumed.observedCostRollouts + resumed.estimatedCostRollouts)
            .toBe(resumed.records.length);
    });

    it("keeps a replaced attempt's price as a reserve floor across resumes", async () => {
        const store = new MemoryStore();
        // Prices that put the failure estimate above the desk ceiling, so the
        // floor cannot come from `deskCostCeilingUsd` instead.
        const expensive = {
            ...options(store),
            pricesPerMillionTokens: { input: 100, output: 200, cacheCreation: 1, cacheRead: 1 },
        };
        await runPairedDelta(
            expensive,
            dependencies((armId) =>
                armId === "mc-off" ? new Error("first attempt failed") : observation(armId)),
        );
        const failedEstimate = store.records.find(({ armId }) => armId === "mc-off")?.costUsd;
        if (failedEstimate === undefined) throw new Error("missing failed record");

        expect(failedEstimate).toBeGreaterThan(expensive.deskCostCeilingUsd);

        // The retry is cheaper, so after replacement the expensive attempt's
        // price survives only in `priorAttemptsCostUsd`.
        const second = await runPairedDelta(expensive, dependencies());
        const retried = second.records.find(({ armId }) => armId === "mc-off");
        const third = await runPairedDelta(expensive, dependencies());

        expect(retried?.costUsd).toBeLessThan(failedEstimate);
        expect(second.reserveUsd).toBeGreaterThanOrEqual(failedEstimate);
        expect(third.reserveUsd).toBeGreaterThanOrEqual(failedEstimate);
    });

    it("records an uncanonicalizable intervention instead of losing the rollout", async () => {
        const store = new MemoryStore();
        const result = await runPairedDelta(
            options(store),
            dependencies((armId) => {
                const value = observation(armId);
                if (armId === "mc-off") {
                    value.intervention = { kind: "none", value: 1n as unknown as null };
                }
                return value;
            }),
        );
        const malformed = result.records.find(({ armId }) => armId === "mc-off");

        expect(result.status).toBe("completed");
        expect(malformed?.cell).toMatchObject({
            runHealth: "malformed",
            reasonCode: "invalid-result",
        });
        expect(store.records.filter(({ armId }) => armId === "mc-off")).toHaveLength(1);
        expect(result.exclusionCounts["mc-off"]?.["invalid-result"]).toBe(1);
    });

    it("reports an unreclaimed harness even when the rollout timed out first", async () => {
        const result = await runPairedDelta(
            { ...options(), deadlineEpochMs: Date.now() + 25 },
            {
                now: Date.now,
                async createRollout(): Promise<RolloutHandle> {
                    return {
                        async run() {
                            return await new Promise<RolloutObservation>(() => {});
                        },
                        async dispose() {
                            throw new Error("harness would not stop");
                        },
                    };
                },
            },
        );

        // The deadline bounded this arm; the harness threatens the ones after it.
        expect(result.status).toBe("harness-unreclaimed");
        expect(result.records[0]?.cell).toMatchObject({
            runHealth: "crash",
            reasonCode: "harness-failure",
        });
        expect(result.records[0]?.harnessDisposed).toBe(false);
    });

    it("refuses a stored vector that does not fit the scenario it would stand in for", async () => {
        const store = new MemoryStore();
        const first = await runPairedDelta(options(store), dependencies());
        const stored = store.records.find(({ armId }) => armId === "mc-on");
        if (!stored || !first.records.length) throw new Error("missing fixture record");

        // Unique, parser-valid ids that belong to no check the scenario declares.
        stored.checks = stored.checks.map((check, index) => ({
            ...check,
            id: `check-drifted-${index}`,
        }));
        const events: string[] = [];
        const result = await runPairedDelta(options(store), dependencies(undefined, events));

        expect(result.status).toBe("invalid-stored-records");
        expect(result.invalidStoredCoordinates).toContainEqual({
            poolManifestFingerprint: "a".repeat(64),
            scenarioId: scenario.scenarioId,
            armId: "mc-on",
            replicateIndex: 0,
        });
        expect(result.records.some(({ armId }) => armId === "mc-on")).toBe(false);
        expect(events).not.toContain("create:mc-on");
    });

    it("refuses a stored cell whose aggregates disagree with its own vector", async () => {
        const store = new MemoryStore();
        await runPairedDelta(options(store), dependencies());
        const stored = store.records.find(({ armId }) => armId === "mc-on");
        if (!stored) throw new Error("missing fixture record");

        stored.cell = { ...stored.cell, criticalPassed: 0 };
        const result = await runPairedDelta(options(store), dependencies());

        expect(result.status).toBe("invalid-stored-records");
        expect(result.records.some(({ armId }) => armId === "mc-on")).toBe(false);
    });

    it("hands the adapter its own intervention copy", async () => {
        const declared = structuredClone(scenario.interventions.r1);
        const result = await runPairedDelta(
            options(),
            {
                now: () => 100,
                async createRollout({ coordinate, intervention }): Promise<RolloutHandle> {
                    // An adapter resolving locator handles mutates what it was
                    // given; neither the declaration nor the expected value may
                    // follow it.
                    if (intervention.kind === "scripted-retrieval") {
                        (intervention.value as { locatorIds: string[] }).locatorIds =
                            ["mcm_resolved"];
                    }
                    return {
                        async run() {
                            // mc-on fails its critical check, so the ladder runs
                            // and R1 is actually created.
                            const value = observation(coordinate.armId, coordinate.armId !== "mc-on");
                            value.intervention = intervention;
                            return value;
                        },
                        async dispose() {},
                    };
                },
            },
        );

        expect(scenario.interventions.r1).toEqual(declared);
        // The mutated descriptor no longer matches the declaration, so R1 is an
        // exclusion instead of evidence.
        expect(result.records.find(({ armId }) => armId === "r1")?.cell).toMatchObject({
            runHealth: "malformed",
            reasonCode: "invalid-result",
        });
    });

    it("classifies a malformed check vector as an exclusion and continues", async () => {
        const result = await runPairedDelta(
            options(),
            dependencies((armId) => {
                const value = observation(armId);
                if (armId === "mc-off") {
                    value.checks = [{ id: "check-unknown", passed: true }];
                }
                return value;
            }),
        );
        const malformed = result.records.find(({ armId }) => armId === "mc-off");

        expect(result.status).toBe("completed");
        expect(result.records).toHaveLength(3);
        expect(malformed?.cell).toMatchObject({
            runHealth: "malformed",
            reasonCode: "invalid-result",
            checksTotal: 0,
        });
        expect(result.exclusionCounts["mc-off"]?.["invalid-result"]).toBe(1);
    });

    it("refuses a rollout whose harness would not dispose and re-runs it on resume", async () => {
        const store = new MemoryStore();
        const events: string[] = [];
        const first = await runPairedDelta(
            options(store),
            dependencies(undefined, events, (armId) =>
                armId === "mc-on" ? new Error("harness still running") : undefined),
        );
        const undisposed = first.records.find(({ armId }) => armId === "mc-on");

        expect(undisposed?.cell).toMatchObject({
            runHealth: "crash",
            reasonCode: "harness-failure",
            checksTotal: 0,
            criticalTotal: 0,
            invalidSuccess: false,
        });
        expect(undisposed?.harnessDisposed).toBe(false);
        expect(first.coordinates[0]?.incomplete).toBe(true);
        // The harness may still hold its workspace, so no later arm is measured
        // against a possibly contaminated environment.
        expect(first.status).toBe("harness-unreclaimed");
        expect(first.records).toHaveLength(1);
        expect(events.filter((event) => event.startsWith("create:"))).toEqual(["create:mc-on"]);
        // A rollout that may have contaminated the arm is not evidence, so the
        // regret ladder never scores it.
        expect(first.coordinates[0]?.regret).toBeNull();

        const resumeEvents: string[] = [];
        const resumed = await runPairedDelta(options(store), dependencies(undefined, resumeEvents));

        expect(resumeEvents).toContain("create:mc-on");
        expect(resumed.status).toBe("completed");
        expect(resumed.records.find(({ armId }) => armId === "mc-on")?.cell.runHealth)
            .toBe("completed");
        expect(store.records.filter(({ armId }) => armId === "mc-on")).toHaveLength(1);
    });

    it("classifies a non-finite or missing usage counter as malformed and prices it", async () => {
        for (const usage of [
            { input: Number.NaN, output: 10, cacheCreation: 20, cacheRead: 30 },
            { input: Number.POSITIVE_INFINITY, output: 10, cacheCreation: 20, cacheRead: 30 },
            { input: 100, output: 10, cacheCreation: 20 } as unknown as RolloutObservation["usage"],
            { input: -1, output: 10, cacheCreation: 20, cacheRead: 30 },
        ]) {
            const result = await runPairedDelta(
                options(),
                dependencies((armId) => {
                    const value = observation(armId);
                    if (armId === "mc-off") value.usage = usage;
                    return value;
                }),
            );
            const malformed = result.records.find(({ armId }) => armId === "mc-off");

            expect(malformed?.cell).toMatchObject({
                runHealth: "malformed",
                reasonCode: "invalid-result",
            });
            expect(malformed?.usage).toEqual({
                input: 0,
                output: 0,
                cacheCreation: 0,
                cacheRead: 0,
            });
            expect(malformed?.costSource).toBe("estimated");
            expect(Number.isFinite(malformed?.costUsd)).toBe(true);
            // One NaN cost would make every later cap comparison false.
            expect(Number.isFinite(result.spentUsd)).toBe(true);
            expect(result.exclusionCounts["mc-off"]?.["invalid-result"]).toBe(1);
        }
    });

    it("applies the cost cap to the first rollout after a resume restores spend", async () => {
        const store = new MemoryStore();
        const first = await runPairedDelta(options(store), dependencies());
        const restored = store.records.filter(({ cell }) => cell.runHealth === "completed");

        expect(restored.length).toBeGreaterThan(0);
        expect(first.records).toHaveLength(3);

        // Drop one coordinate so the resumed run still has an arm to execute.
        store.records.splice(store.records.findIndex(({ armId }) => armId === "compaction"), 1);
        const spentBefore = store.records.reduce((sum, { costUsd }) => sum + costUsd, 0);
        const events: string[] = [];
        const resumed = await runPairedDelta(
            { ...options(store), maxCostUsd: spentBefore },
            dependencies(undefined, events),
        );

        expect(resumed.status).toBe("cost-cap-reached");
        expect(events).not.toContain("create:compaction");
        expect(resumed.spentUsd).toBeCloseTo(spentBefore, 12);
    });

    it("bills every attempt at a retried coordinate exactly once", async () => {
        const store = new MemoryStore();
        await runPairedDelta(
            options(store),
            dependencies((armId) =>
                armId === "mc-off" ? new Error("first attempt failed") : observation(armId)),
        );
        const failedEstimate = store.records.find(({ armId }) => armId === "mc-off")?.costUsd;
        if (failedEstimate === undefined) throw new Error("missing failed record");

        const resumed = await runPairedDelta(options(store), dependencies());
        const retried = resumed.records.find(({ armId }) => armId === "mc-off");

        // Counters cover records reported by this run; a rerun counts once, not
        // once per attempt.
        expect(resumed.observedCostRollouts + resumed.estimatedCostRollouts)
            .toBe(resumed.records.length);
        // Spend is lifetime, so the failed attempt is billed alongside the retry
        // and the estimate it was priced at stays a reserve floor.
        expect(retried?.priorAttemptsCostUsd).toBeCloseTo(failedEstimate, 12);
        expect(resumed.spentUsd).toBeCloseTo(
            resumed.records.reduce((sum, { costUsd }) => sum + costUsd, 0) + failedEstimate,
            12,
        );
        expect(retried?.costUsd).toBeLessThan(failedEstimate);
        expect(resumed.reserveUsd).toBeGreaterThanOrEqual(failedEstimate);

        // A third run reconstructs the same lifetime spend.
        const third = await runPairedDelta(options(store), dependencies());

        expect(third.spentUsd).toBeCloseTo(resumed.spentUsd, 12);
        expect(third.observedCostRollouts + third.estimatedCostRollouts)
            .toBe(third.records.length);
    });
    it("floors failure cost estimates at one full-context request", async () => {        const expensive = {
            ...options(),
            pricesPerMillionTokens: {
                input: 100,
                output: 200,
                cacheCreation: 1,
                cacheRead: 1,
            },
        };
        const result = await runPairedDelta(
            expensive,
            dependencies((armId) =>
                armId === "mc-off" ? new Error("mid-run crash") : observation(armId)),
        );
        const failed = result.records.find(({ armId }) => armId === "mc-off");

        expect(failed?.costSource).toBe("estimated");
        expect(failed?.costUsd).toBeCloseTo(
            (scenario.modelContextLimit * (100 + 200)) / 1_000_000,
            12,
        );
    });

    it("classifies absence and arm identity contradictions as exclusions", async () => {
        const result = await runPairedDelta(
            options(),
            dependencies((armId) => {
                const value = observation(armId);
                if (armId === "mc-on") value.absencePreconditionHeld = false;
                if (armId === "mc-off") value.armIdentityMatches = false;
                return value;
            }),
        );

        expect(result.coordinates[0]?.cells["mc-on"]?.cell.reasonCode).toBe(
            "absence-precondition-unmet",
        );
        expect(result.coordinates[0]?.cells["mc-off"]?.cell.reasonCode).toBe(
            "arm-identity-mismatch",
        );
        expect(result.coordinates[0]?.cells["mc-on"]?.checks).toEqual([]);
    });

    it("fires oracle arms only for completed critical failure and prepares R2 before run", async () => {
        const events: string[] = [];
        const result = await runPairedDelta(
            options(),
            dependencies(
                (armId) => observation(armId, armId !== "mc-on"),
                events,
            ),
        );

        expect(result.records.map(({ armId }) => armId)).toEqual([
            "mc-on",
            "mc-off",
            "compaction",
            "r1",
            "r2",
            "r3",
        ]);
        expect(events.indexOf("prepare:r2:gold-memory")).toBeLessThan(
            events.indexOf("run:r2"),
        );
        expect(result.coordinates[0]?.regret).toEqual({
            retrieval: 1,
            formation: 0,
            representation: 0,
        });
    });

    it("schedules no oracle rollout for passing or incomplete MC-on", async () => {
        const passing = await runPairedDelta(options(), dependencies());
        expect(passing.records).toHaveLength(3);

        const incomplete = await runPairedDelta(
            options(),
            dependencies((armId) =>
                armId === "mc-on" ? new Error("failed") : observation(armId)),
        );
        expect(incomplete.records).toHaveLength(3);
    });

    it("stops the ladder when R2 is unavailable instead of paying for R3", async () => {
        const events: string[] = [];
        const result = await runPairedDelta(
            options(),
            dependencies((armId) => {
                if (armId === "r2") return new ProviderUnavailableError("unavailable");
                return observation(armId, armId !== "mc-on");
            }, events),
        );

        expect(result.coordinates[0]?.regret).toEqual({ retrieval: 1 });
        expect(result.coordinates[0]?.cells.r2?.cell.reasonCode).toBe(
            "provider-unavailable",
        );
        expect(result.coordinates[0]?.cells.r3).toBeUndefined();
        expect(events).not.toContain("create:r3");
    });
});

describe("dual-mock resolution gate", () => {
    it("routes each provider independently and resolves the declared live limit", async () => {
        const requests = new Map<string, number>();
        await verifyDualMockResolution({
            liveProviderId: "mock-live",
            liveModelId: "snapshot-2026-08-01",
            modelContextLimit: 4096,
            async sendPrompt(route) {
                requests.set(route.providerId, (requests.get(route.providerId) ?? 0) + 1);
                return {
                    ...route,
                    contextLimit: route.providerId === "mock-live" ? 4096 : 200_000,
                };
            },
        });

        expect(requests).toEqual(new Map([
            ["mock-anthropic", 1],
            ["mock-live", 1],
        ]));
    });

    it("rejects a live route that resolves the wrong context limit", async () => {
        await expect(
            verifyDualMockResolution({
                liveProviderId: "mock-live",
                liveModelId: "snapshot-2026-08-01",
                modelContextLimit: 4096,
                async sendPrompt(route) {
                    return { ...route, contextLimit: 200_000 };
                },
            }),
        ).rejects.toThrow(/context limit mismatch/);
    });
});

describe("regret decomposition", () => {
    it("excludes a rollout whose base script diverges from the declaration", async () => {
        const result = await runPairedDelta(
            options(),
            dependencies((armId) => {
                const value = observation(armId, armId !== "mc-on");
                if (armId === "r3") value.baseScriptFingerprint = "b".repeat(64);
                return value;
            }),
        );
        const coordinate = result.coordinates[0];

        expect(coordinate?.cells.r3?.cell).toMatchObject({
            runHealth: "malformed",
            reasonCode: "invalid-result",
        });
        expect(coordinate?.regret).toEqual({ retrieval: 1, formation: 0 });
    });

    it("excludes a rollout whose intervention diverges and stops the ladder", async () => {
        const result = await runPairedDelta(
            options(),
            dependencies((armId) => {
                const value = observation(armId, armId !== "mc-on");
                if (armId === "r1") value.intervention = { kind: "none", value: null };
                return value;
            }),
        );
        const coordinate = result.coordinates[0];

        expect(coordinate?.cells.r1?.cell).toMatchObject({
            runHealth: "malformed",
            reasonCode: "invalid-result",
        });
        expect(coordinate?.cells.r2).toBeUndefined();
        expect(coordinate?.regret).toEqual({});
    });

    it("refuses stored records that diverge from the declaration", async () => {
        const result = await runPairedDelta(
            options(),
            dependencies((armId) => observation(armId, armId !== "mc-on")),
        );
        const cells = result.coordinates[0]?.cells;
        if (!cells) throw new Error("missing fixture cells");

        const staleScript = structuredClone(cells);
        staleScript.r3!.baseScriptFingerprint = "b".repeat(64);
        expect(computeRegretRungs(scenario, staleScript)).toEqual({
            refusedReason: "base-fingerprint-mismatch",
        });

        const staleIntervention = structuredClone(cells);
        staleIntervention.r1!.intervention = { kind: "none", value: null };
        expect(computeRegretRungs(scenario, staleIntervention)).toEqual({
            refusedReason: "intervention-mismatch",
        });
    });

    it("telescopes over the ladder intersection", async () => {
        const result = await runPairedDelta(
            options(),
            dependencies((armId) => observation(armId, armId === "r2" || armId === "r3")),
        );
        const records = result.coordinates[0]?.cells ?? {};
        const rungs = computeRegretRungs(scenario, records);

        expect((rungs.retrieval ?? 0) + (rungs.formation ?? 0) + (rungs.representation ?? 0))
            .toBe(1);
    });
});

describe("file rollout store", () => {
    async function fixtureRecords(): Promise<RolloutRecord[]> {
        const { records } = await runPairedDelta(options(), dependencies());
        return records;
    }

    it("round-trips records and refuses to replace a completed rollout", async () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-store-"));
        try {
            const path = join(root, "nested", "records.json");
            const [record] = await fixtureRecords();
            if (!record) throw new Error("missing fixture record");
            const store = new FileRolloutStore(path);
            store.put(record);

            expect(new FileRolloutStore(path).list()).toEqual([record]);
            expect(() => store.put({ ...record })).toThrow(
                /refusing to replace completed rollout/,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects stored records that cannot back admission decisions", async () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-store-"));
        try {
            const path = join(root, "records.json");
            const [record] = await fixtureRecords();
            if (!record) throw new Error("missing fixture record");

            writeFileSync(path, JSON.stringify([{ ...record, costUsd: "free" }]));
            expect(() => new FileRolloutStore(path).list()).toThrow(/cost-invalid/);

            writeFileSync(path, JSON.stringify([{ ...record, costUsd: -1 }]));
            expect(() => new FileRolloutStore(path).list()).toThrow(/cost-invalid/);

            writeFileSync(path, JSON.stringify([{ ...record, schema: "other/v1" }]));
            expect(() => new FileRolloutStore(path).list()).toThrow(/schema-mismatch/);

            writeFileSync(
                path,
                JSON.stringify([{
                    ...record,
                    cell: { ...record.cell, runHealth: "sideways" },
                }]),
            );
            expect(() => new FileRolloutStore(path).list()).toThrow(/run-health-invalid/);

            writeFileSync(path, JSON.stringify([{ ...record, priorAttemptsCostUsd: -1 }]));
            expect(() => new FileRolloutStore(path).list())
                .toThrow(/prior-attempts-cost-invalid/);

            // `put` protects completed evidence by coordinate index, which a
            // duplicate would silently point away from.
            writeFileSync(path, JSON.stringify([record, record]));
            expect(() => new FileRolloutStore(path).list()).toThrow(/duplicate-coordinate/);

            // A completed cell suppresses its live rollout, so an impossible one
            // must not be accepted as evidence.
            for (const cell of [
                { armId: "r2" },
                { invalidSuccess: "yes" },
                { checksTotal: -1 },
                { checksPassed: 99 },
                { criticalPassed: 99 },
            ]) {
                writeFileSync(
                    path,
                    JSON.stringify([{ ...record, cell: { ...record.cell, ...cell } }]),
                );
                expect(() => new FileRolloutStore(path).list()).toThrow(/cell-invalid/);
            }

            writeFileSync(
                path,
                JSON.stringify([{ ...record, cell: { ...record.cell, reasonCode: "made-up" } }]),
            );
            expect(() => new FileRolloutStore(path).list()).toThrow(/reason-code-invalid/);

            for (const checks of [
                "none",
                [{ id: "check-ladder" }],
                [{ id: "check-ladder", passed: true }, { id: "check-ladder", passed: true }],
            ]) {
                writeFileSync(path, JSON.stringify([{ ...record, checks }]));
                expect(() => new FileRolloutStore(path).list()).toThrow(/checks-invalid/);
            }

            for (const patch of [
                { cell: { ...record.cell, reasonCode: "harness-failure" } },
                { cell: { ...record.cell, checksTotal: 0, checksPassed: 0 } },
                { checks: [] as typeof record.checks },
            ]) {
                writeFileSync(path, JSON.stringify([{ ...record, ...patch }]));
                expect(() => new FileRolloutStore(path).list())
                    .toThrow(/completed-cell-invalid|cell-invalid/);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
