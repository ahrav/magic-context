import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    FileRolloutStore,
    RolloutStoreBusyError,
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
import { LOCK_OWNER_FILE } from "../prospective-holdout/lock";

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

/** `findIndex` returns -1 for an absent arm and `splice(-1, 1)` then removes the last record, so the test would exercise a different arm and could pass for the wrong reason. commentlint: allow(JUDGE) */
function storedRecord(armId: ArmId): RolloutRecord {
    return {
        schema: "paired-delta-rollout/v1",
        poolManifestFingerprint: "a".repeat(64),
        scenarioId: scenario.scenarioId,
        armId,
        replicateIndex: 0,
        repoCommit: "commit-a",
        pinnedProviderId: "mock-live",
        pinnedSnapshotId: "snapshot-2026-08-01",
        echoedProviderId: null,
        echoedModelId: null,
        baseScriptFingerprint: baseScriptFingerprint(scenario),
        intervention: interventionFor(scenario, armId),
        cell: {
            armId,
            checksPassed: 0,
            checksTotal: 0,
            criticalPassed: 0,
            criticalTotal: 0,
            invalidSuccess: false,
            runHealth: "crash",
            reasonCode: "harness-failure",
        },
        checks: [],
        usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        costUsd: 0.25,
        priorAttemptsCostUsd: 0,
        maxAttemptCostUsd: 0.25,
        costSource: "estimated",
        wallClockMs: 1,
        turns: 0,
        harnessDisposed: true,
    };
}

function dropRecord(store: MemoryStore, armId: ArmId): void {
    const index = store.records.findIndex((record) => record.armId === armId);
    if (index < 0) throw new Error(`missing ${armId} record`);
    store.records.splice(index, 1);
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
        // The stale completed record cannot be replaced and the coordinate key
        // carries no binding, so the other arms could never be compared with it:
        // the run stops the coordinate instead of paying for them.
        expect(store.records).toHaveLength(1);
        expect(store.records[0]?.echoedModelId).toBe("different-snapshot");
        expect(result.coordinates[0]?.incomplete).toBe(true);
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

    it("blocks a coordinate before any arm pays when a later arm is stale", async () => {
        const first = await runPairedDelta(options(), dependencies());
        // The stale record belongs to `compaction`, which the primary order reaches last.
        const stale = structuredClone(
            first.records.find(({ armId }) => armId === "compaction")!,
        );
        stale.echoedModelId = "different-snapshot";
        // `mc-on` is missing, so without a preflight it runs and pays first.
        const store = new MemoryStore([stale]);
        const events: string[] = [];

        const result = await runPairedDelta(options(store), dependencies(undefined, events));

        expect(result.status).toBe("invalid-stored-records");
        expect(result.invalidStoredCoordinates).toContainEqual({
            poolManifestFingerprint: "a".repeat(64),
            scenarioId: scenario.scenarioId,
            armId: "compaction",
            replicateIndex: 0,
        });
        // No arm may run for a coordinate whose comparison can never be valid.
        expect(events.filter((event) => event.startsWith("create:"))).toEqual([]);
        expect(result.records).toHaveLength(0);
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

    it("does not start the rollout when preparation outlives the deadline", async () => {
        const calls: string[] = [];
        const result = await runPairedDelta(
            { ...options(), deadlineEpochMs: Date.now() + 25 },
            {
                now: Date.now,
                async createRollout({ coordinate }): Promise<RolloutHandle> {
                    return {
                        async prepare() {
                            calls.push(`prepare:${coordinate.armId}`);
                            // Preparation resolves after the deadline; `run()` must not start.
                            await new Promise((resolve) => setTimeout(resolve, 60));
                        },
                        async run(): Promise<RolloutObservation> {
                            calls.push(`run:${coordinate.armId}`);
                            throw new Error("run must not start after the deadline");
                        },
                        async dispose() {
                            calls.push(`dispose:${coordinate.armId}`);
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
        expect(calls).toEqual(["prepare:mc-on", "dispose:mc-on"]);

        // The late `prepare()` completion must not call `run()` after `dispose()`.
        await new Promise((resolve) => setTimeout(resolve, 90));
        expect(calls).toEqual(["prepare:mc-on", "dispose:mc-on"]);
    });

    it("bounds rollout creation with the run deadline and disposes a late handle", async () => {        const disposedArms: string[] = [];
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
        dropRecord(store, "mc-on");
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

    it("reports an unreclaimed harness when disposal never settles", async () => {
        const result = await runPairedDelta(
            { ...options(), deadlineEpochMs: Date.now() + 25 },
            {
                now: Date.now,
                async createRollout({ coordinate }): Promise<RolloutHandle> {
                    return {
                        async run() {
                            return observation(coordinate.armId);
                        },
                        async dispose() {
                            // Never settles; the run must not wait on it forever.
                            await new Promise<void>(() => {});
                        },
                    };
                },
            },
        );

        expect(result.status).toBe("harness-unreclaimed");
        expect(result.records[0]?.cell).toMatchObject({
            runHealth: "crash",
            reasonCode: "harness-failure",
        });
        // The paid record is still written rather than lost to the hang.
        expect(result.records).toHaveLength(1);
    }, 20_000);

    it("persists a malformed rollout whose intervention cannot be serialized", async () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-unserializable-"));
        try {
            const path = join(root, "records.json");
            const store = new FileRolloutStore(path);
            const result = await runPairedDelta(
                { ...options(), store },
                dependencies((armId) => {
                    const value = observation(armId);
                    if (armId === "mc-off") {
                        value.intervention = { kind: "none", value: 1n as unknown as null };
                    }
                    return value;
                }),
            );
            const malformed = result.records.find(({ armId }) => armId === "mc-off");

            expect(malformed?.cell).toMatchObject({
                runHealth: "malformed",
                reasonCode: "invalid-result",
            });
            // The store had to be able to write it, or the paid coordinate is
            // repeated on the next resume.
            expect(new FileRolloutStore(path, { readOnly: true }).list().filter(({ armId }) => armId === "mc-off"))
                .toHaveLength(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses non-boolean observation gates", async () => {
        for (const patch of [
            { absencePreconditionHeld: "false" as unknown as boolean },
            { armIdentityMatches: "false" as unknown as boolean },
            { claimedDone: "yes" as unknown as boolean },
        ]) {
            const result = await runPairedDelta(
                options(),
                dependencies((armId) => {
                    const value = observation(armId);
                    if (armId === "mc-off") Object.assign(value, patch);
                    return value;
                }),
            );

            expect(result.records.find(({ armId }) => armId === "mc-off")?.cell).toMatchObject({
                runHealth: "malformed",
                reasonCode: "invalid-result",
            });
        }
    });

    it("refuses stored evidence whose declaration or disposal cannot be trusted", async () => {
        const seed = async () => {
            const store = new MemoryStore();
            await runPairedDelta(options(store), dependencies());
            return store;
        };

        for (const corrupt of [
            (record: RolloutRecord) => {
                record.baseScriptFingerprint = "f".repeat(64);
            },
            (record: RolloutRecord) => {
                record.intervention = { kind: "gold-memory", value: null };
            },
            (record: RolloutRecord) => {
                record.harnessDisposed = false;
            },
        ]) {
            const store = await seed();
            const stored = store.records.find(({ armId }) => armId === "mc-on");
            if (!stored) throw new Error("missing fixture record");
            corrupt(stored);
            const events: string[] = [];

            const result = await runPairedDelta(options(store), dependencies(undefined, events));

            expect(result.status).toBe("invalid-stored-records");
            expect(result.records.some(({ armId }) => armId === "mc-on")).toBe(false);
            expect(events).not.toContain("create:mc-on");
        }
    });

    it("classifies an arm identity mismatch as malformed", async () => {
        const result = await runPairedDelta(
            options(),
            dependencies((armId) => {
                const value = observation(armId);
                if (armId === "mc-off") value.armIdentityMatches = false;
                return value;
            }),
        );

        // The contract admits this reason only with a malformed health.
        expect(result.records.find(({ armId }) => armId === "mc-off")?.cell).toMatchObject({
            runHealth: "malformed",
            reasonCode: "arm-identity-mismatch",
        });
    });

    it("refuses a live route that duplicates the fixture provider", async () => {
        // The fixture provider selects the mock endpoint, whatever model is named under it.
        for (const liveModelId of ["mock-sonnet", "some-other-model"]) {
            await expect(
                verifyDualMockResolution({
                    liveProviderId: "mock-anthropic",
                    liveModelId,
                    modelContextLimit: 4096,
                    async sendPrompt(route) {
                        return { ...route, contextLimit: 4096 };
                    },
                }),
            ).rejects.toThrow(/duplicates the fixture provider/);
        }
    });

    it("persists a rollout whose other observation fields are not JSON-safe", async () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-unwritable-"));
        try {
            const path = join(root, "records.json");
            const store = new FileRolloutStore(path);
            const result = await runPairedDelta(
                { ...options(), store },
                dependencies((armId) => {
                    const value = observation(armId);
                    if (armId === "mc-off") {
                        value.turns = 2n as unknown as number;
                        value.echoedModelId = { id: "snapshot" } as unknown as string;
                    }
                    return value;
                }),
            );
            const malformed = result.records.find(({ armId }) => armId === "mc-off");

            expect(malformed?.cell).toMatchObject({
                runHealth: "malformed",
                reasonCode: "invalid-result",
            });
            expect(malformed?.turns).toBe(0);
            expect(malformed?.echoedModelId).toBeNull();
            store.release();
            expect(new FileRolloutStore(path, { readOnly: true }).list().filter(({ armId }) => armId === "mc-off"))
                .toHaveLength(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a records path a live foreign holder still owns", () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-foreign-lock-"));
        const live = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
        try {
            const path = join(root, "records.json");
            // The owner record another process would have written: a live pid, a
            // foreign nonce, and a lease that has not expired.
            mkdirSync(`${path}.lock`, { recursive: true });
            writeFileSync(
                join(`${path}.lock`, LOCK_OWNER_FILE),
                `${JSON.stringify({ pid: live.pid, nonce: "foreign-nonce", acquiredAt: Date.now() })}\n`,
            );

            expect(() => new FileRolloutStore(path).list()).toThrow(RolloutStoreBusyError);

            live.kill();
        } finally {
            live.kill();
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    it("reclaims a records path whose holder died and whose lease expired", () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-abandoned-lock-"));
        try {
            const path = join(root, "records.json");
            // A crashed run cannot release its lock, and must not wedge the next.
            mkdirSync(`${path}.lock`, { recursive: true });
            writeFileSync(
                join(`${path}.lock`, LOCK_OWNER_FILE),
                `${JSON.stringify({
                    pid: 2147483646,
                    nonce: "dead-nonce",
                    acquiredAt: Date.now() - 10 * 60_000,
                })}\n`,
            );

            const store = new FileRolloutStore(path);
            expect(() => store.list()).not.toThrow();
            store.release();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    it("marks a coordinate incomplete when a ladder rung never ran", async () => {
        const store = new MemoryStore();
        // Seed a full ladder, then age R1's completed record so it is refused.
        await runPairedDelta(
            options(store),
            dependencies((armId) => observation(armId, armId !== "mc-on")),
        );
        const r1 = store.records.find(({ armId }) => armId === "r1");
        if (!r1) throw new Error("missing r1 record");
        r1.pinnedSnapshotId = "another-snapshot";

        const result = await runPairedDelta(
            options(store),
            dependencies((armId) => observation(armId, armId !== "mc-on")),
        );

        // Only the primary arms feed the `incomplete` derivation, so a skipped
        // rung would otherwise report a complete coordinate.
        expect(result.status).toBe("invalid-stored-records");
        expect(result.coordinates[0]?.incomplete).toBe(true);
    });

    it("rejects impossible stored cells the contract validator catches", () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-cell-"));
        try {
            const path = join(root, "records.json");
            const base = {
                schema: "paired-delta-rollout/v1",
                poolManifestFingerprint: "a".repeat(64),
                scenarioId: "var-runner-smoke",
                armId: "mc-on",
                replicateIndex: 0,
                repoCommit: "commit-a",
                pinnedProviderId: "mock-live",
                pinnedSnapshotId: "snapshot-2026-08-01",
                echoedProviderId: "mock-live",
                echoedModelId: "snapshot-2026-08-01",
                baseScriptFingerprint: "b".repeat(64),
                intervention: { kind: "none", value: null },
                checks: [{ id: "check-ladder", passed: true }],
                usage: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 },
                costUsd: 0.01,
                priorAttemptsCostUsd: 0,
                maxAttemptCostUsd: 0.01,
                costSource: "observed",
                wallClockMs: 1,
                turns: 1,
                harnessDisposed: true,
            };
            const cell = {
                armId: "mc-on",
                checksPassed: 1,
                checksTotal: 1,
                criticalPassed: 1,
                criticalTotal: 1,
                invalidSuccess: false,
                runHealth: "completed",
                reasonCode: null,
            };

            // Shapes the contract's own validator rejects and a local copy missed.
            for (const patch of [
                { criticalTotal: 50, criticalPassed: 10, checksPassed: 1, checksTotal: 2 },
                { runHealth: "crash", reasonCode: null },
                { runHealth: "timeout", reasonCode: "provider-unavailable" },
            ]) {
                writeFileSync(path, JSON.stringify([{ ...base, cell: { ...cell, ...patch } }]));
                expect(() => new FileRolloutStore(path, { readOnly: true }).list())
                    .toThrow(/cell-invalid/);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("reserves the dearest attempt, not the sum of cheap ones", async () => {
        const store = new MemoryStore();
        const cheap = {
            ...options(store),
            deskCostCeilingUsd: 0,
            pricesPerMillionTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        };
        // Three cheap failures at one coordinate, each priced from the scenario's
        // context limit at a nominal price.
        for (let attempt = 0; attempt < 3; attempt++) {
            await runPairedDelta(
                {
                    ...cheap,
                    pricesPerMillionTokens: {
                        input: 0.001,
                        output: 0,
                        cacheCreation: 0,
                        cacheRead: 0,
                    },
                },
                dependencies((armId) =>
                    armId === "mc-off" ? new Error("still failing") : observation(armId)),
            );
        }
        const failed = store.records.find(({ armId }) => armId === "mc-off");
        if (!failed) throw new Error("missing failed record");

        expect(failed.priorAttemptsCostUsd).toBeGreaterThan(failed.maxAttemptCostUsd);

        const resumed = await runPairedDelta(
            {
                ...cheap,
                pricesPerMillionTokens: { input: 0.001, output: 0, cacheCreation: 0, cacheRead: 0 },
            },
            dependencies(),
        );

        // The cumulative total would have inflated the reserve into a budget the
        // next rollout cannot fit.
        expect(resumed.reserveUsd).toBeCloseTo(failed.maxAttemptCostUsd, 12);
        expect(resumed.reserveUsd).toBeLessThan(failed.priorAttemptsCostUsd);
    });

    it("counts a zero-cost stored attempt as a started matrix", async () => {
        const store = new MemoryStore();
        const free = {
            ...options(store),
            deskCostCeilingUsd: 0,
            pricesPerMillionTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        };
        const first = await runPairedDelta(free, dependencies());

        expect(first.records.every(({ costUsd }) => costUsd === 0)).toBe(true);

        // Drop one arm so the resumed run has work, and give it a reserve the cap
        // cannot accommodate.
        dropRecord(store, "compaction");
        const events: string[] = [];
        const resumed = await runPairedDelta(
            { ...free, deskCostCeilingUsd: 5, maxCostUsd: 1 },
            dependencies(undefined, events),
        );

        // A zero-cost history is still a started matrix, so the first-rollout
        // exemption is spent.
        expect(resumed.status).toBe("cost-cap-reached");
        expect(events).not.toContain("create:compaction");
    });

    it("keeps the unusable-records warning over a later cap stop", async () => {
        const store = new MemoryStore();
        const first = await runPairedDelta(options(store), dependencies());
        const stale = store.records.find(({ armId }) => armId === "mc-on");
        if (!stale || first.records.length !== 3) throw new Error("missing fixture records");
        stale.echoedModelId = "another-snapshot";
        // Two coordinates: the first is blocked by the stale record, the second
        // must then hit the cap.
        const spent = store.records.reduce((sum, { costUsd }) => sum + costUsd, 0);

        const result = await runPairedDelta(
            {
                ...options(store),
                scenarios: [scenario, { ...scenario, scenarioId: "var-runner-second" }],
                maxCostUsd: spent,
            },
            dependencies(),
        );

        // A cap stop invites a resume; unusable records forbid one until the file
        // is inspected, so the stronger warning has to survive.
        expect(result.invalidStoredCoordinates.length).toBeGreaterThan(0);
        expect(result.status).toBe("invalid-stored-records");
    });

    it("releases the records path when the file cannot be parsed", () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-unparseable-"));
        try {
            const path = join(root, "records.json");
            writeFileSync(path, JSON.stringify([{ schema: "other/v1" }]));

            expect(() => new FileRolloutStore(path).list()).toThrow(/schema-mismatch/);
            // The failed claim must not wedge the corrected retry.
            expect(() => new FileRolloutStore(path).list()).toThrow(/schema-mismatch/);

            writeFileSync(path, JSON.stringify([]));
            const store = new FileRolloutStore(path);
            expect(store.list()).toEqual([]);
            store.release();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("pays for no ladder rung once the coordinate is blocked", async () => {
        const store = new MemoryStore();
        // mc-on completes with a failing critical check, so the ladder is due;
        // mc-off's stored record is then aged so it blocks the coordinate.
        await runPairedDelta(
            options(store),
            dependencies((armId) => observation(armId, armId !== "mc-on")),
        );
        const blocked = store.records.find(({ armId }) => armId === "mc-off");
        if (!blocked) throw new Error("missing mc-off record");
        blocked.echoedModelId = "another-snapshot";
        for (const armId of ["r1", "r2", "r3"] as const) {
            const index = store.records.findIndex((record) => record.armId === armId);
            if (index >= 0) store.records.splice(index, 1);
        }
        const events: string[] = [];

        const result = await runPairedDelta(
            options(store),
            dependencies((armId) => observation(armId, armId !== "mc-on"), events),
        );

        // The ladder is entered from mc-on's own completed record, so the block has
        // to be seen before a rung is created rather than after it has been paid.
        expect(result.status).toBe("invalid-stored-records");
        expect(events.filter((event) => event.startsWith("create:"))).toEqual([]);
        expect(result.coordinates[0]?.incomplete).toBe(true);
    });

    it("derives the summary counters from the records it reports", async () => {
        const store = new MemoryStore();
        await runPairedDelta(
            options(store),
            dependencies((armId) =>
                armId === "mc-off" ? new Error("first attempt failed") : observation(armId)),
        );

        const resumed = await runPairedDelta(options(store), dependencies());
        const observed = resumed.records.filter(({ costSource }) => costSource === "observed");
        const estimated = resumed.records.filter(({ costSource }) => costSource === "estimated");

        // Counters that summarize `records` are read off `records`, so a resumed
        // record and a freshly run one cannot be counted by different rules.
        expect(resumed.observedCostRollouts).toBe(observed.length);
        expect(resumed.estimatedCostRollouts).toBe(estimated.length);
        expect(resumed.observedCostRollouts + resumed.estimatedCostRollouts)
            .toBe(resumed.records.length);
        expect(resumed.exclusionCounts).toEqual(
            resumed.records.reduce<Record<string, Record<string, number>>>((counts, record) => {
                if (record.cell.reasonCode === null) return counts;
                const byReason = counts[record.armId] ??= {};
                byReason[record.cell.reasonCode] = (byReason[record.cell.reasonCode] ?? 0) + 1;
                return counts;
            }, {}),
        );
    });

    it("keeps an overflowing price out of the persisted attempt maximum", async () => {
        const store = new MemoryStore();
        // Prices whose worst-case estimate is finite, so the run is admitted, but
        // whose product with a safe counter is not.
        const result = await runPairedDelta(
            {
                ...options(store),
                // Large enough that the earlier arms' own costs do not trip the cap
                // before mc-off runs.
                maxCostUsd: 1e308,
                pricesPerMillionTokens: {
                    input: 1e300,
                    output: 0,
                    cacheCreation: 0,
                    cacheRead: 0,
                },
            },
            dependencies((armId) => {
                const value = observation(armId);
                if (armId === "mc-off") {
                    value.usage = { ...value.usage, input: Number.MAX_SAFE_INTEGER };
                }
                return value;
            }),
        );
        const malformed = result.records.find(({ armId }) => armId === "mc-off");

        expect(malformed?.cell.reasonCode).toBe("invalid-result");
        // `Infinity` here serializes as `null` and fails the next resume's parse.
        expect(Number.isFinite(malformed?.maxAttemptCostUsd)).toBe(true);
        expect(malformed?.maxAttemptCostUsd).toBe(malformed?.costUsd);
        // The next resume has to be able to parse what this run wrote.
        expect(JSON.stringify(store.records)).not.toContain("null,\"costSource\"");
    });

    it("honours a deadline beyond the timer limit", async () => {
        const result = await runPairedDelta(
            // Past the 32-bit millisecond limit, which `setTimeout` truncates to
            // fire almost immediately.
            { ...options(), deadlineEpochMs: Date.now() + 2_147_483_647 + 60_000 },
            {
                now: Date.now,
                async createRollout({ coordinate }): Promise<RolloutHandle> {
                    return {
                        async run() {
                            // Long enough that a truncated timer would win the race.
                            await new Promise((resolve) => setTimeout(resolve, 50));
                            return observation(coordinate.armId);
                        },
                        async dispose() {},
                    };
                },
            },
        );

        expect(result.status).toBe("completed");
        expect(result.records.map(({ armId }) => armId)).toEqual([
            "mc-on",
            "mc-off",
            "compaction",
        ]);
    }, 20_000);

    it("refuses to publish once its lock has been taken over", () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-fence-"));
        try {
            const path = join(root, "records.json");
            const store = new FileRolloutStore(path);
            store.list();
            // Another owner's record in place of ours, which is what a lost
            // takeover race leaves behind.
            writeFileSync(
                join(`${path}.lock`, LOCK_OWNER_FILE),
                `${JSON.stringify({ pid: process.pid, nonce: "foreign", acquiredAt: Date.now() })}\n`,
            );

            // Publishing a whole-file snapshot is what would erase the other
            // runner's records, so it refuses rather than proceeding.
            expect(() => store.put({} as unknown as RolloutRecord))
                .toThrow(RolloutStoreBusyError);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("merges into the file rather than overwriting another owner's records", () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-merge-"));
        try {
            const path = join(root, "records.json");
            const store = new FileRolloutStore(path);
            store.list();

            const mine = storedRecord("mc-on");
            store.put(mine);

            // Another owner writes a coordinate this instance has never seen,
            // which its cached snapshot therefore cannot contain.
            const theirs = storedRecord("mc-off");
            writeFileSync(path, JSON.stringify([mine, theirs]));

            store.put(storedRecord("compaction"));

            const written = new FileRolloutStore(path, { readOnly: true }).list();
            expect(written.map(({ armId }) => armId).sort()).toEqual([
                "compaction",
                "mc-off",
                "mc-on",
            ]);
            store.release();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a records file whose spend total overflows across records", async () => {
        // Each record's own attempt total is finite. The sum across records is what the
        // pre-scan accumulates.
        const half = Number.MAX_VALUE * 0.6;
        const store = new MemoryStore([
            { ...storedRecord("mc-on"), costUsd: half, maxAttemptCostUsd: half },
            { ...storedRecord("mc-off"), costUsd: half, maxAttemptCostUsd: half },
        ]);

        expect(store.list().every(({ costUsd, priorAttemptsCostUsd }) =>
            Number.isFinite(priorAttemptsCostUsd + costUsd)
        )).toBe(true);

        await expect(runPairedDelta(options(store), dependencies())).rejects.toThrow(
            /spend total overflows the finite range/,
        );
    });

    it("rejects a stored attempt total that cannot be summed", () => {        const root = mkdtempSync(join(tmpdir(), "paired-delta-total-"));
        try {
            const path = join(root, "records.json");
            // Both figures are finite; their sum is what the pre-scan adds.
            writeFileSync(
                path,
                JSON.stringify([{
                    ...storedRecord("mc-on"),
                    costUsd: Number.MAX_VALUE,
                    priorAttemptsCostUsd: Number.MAX_VALUE,
                }]),
            );

            expect(() => new FileRolloutStore(path, { readOnly: true }).list())
                .toThrow(/attempt-cost-total-invalid/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("frees the claim when a non-resume run finds the matrix occupied", async () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-occupied-"));
        try {
            const path = join(root, "records.json");
            writeFileSync(path, JSON.stringify([storedRecord("mc-on")]));

            const store = new FileRolloutStore(path);
            await expect(
                runPairedDelta({ ...options(), store, resume: false }, dependencies()),
            ).rejects.toThrow(/already contains rollouts for this matrix/);

            // A corrected call in the same process would otherwise hit `RolloutStoreBusyError`.
            const resumed = new FileRolloutStore(path);
            const result = await runPairedDelta(
                { ...options(), store: resumed, resume: true },
                dependencies(),
            );
            expect(result.status).toBe("completed");
            resumed.release();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a records file total that cannot be summed and frees the claim", () => {
        const root = mkdtempSync(join(tmpdir(), "paired-delta-file-total-"));
        try {
            const path = join(root, "records.json");
            const half = Number.MAX_VALUE * 0.6;
            writeFileSync(
                path,
                JSON.stringify([
                    { ...storedRecord("mc-on"), costUsd: half, maxAttemptCostUsd: half },
                    { ...storedRecord("mc-off"), costUsd: half, maxAttemptCostUsd: half },
                ]),
            );

            const store = new FileRolloutStore(path);
            expect(() => store.list()).toThrow(/spend-total-invalid/);
            // Parsing releases the claim, so a corrected path is usable in this process.
            writeFileSync(path, JSON.stringify([storedRecord("mc-on")]));
            const retried = new FileRolloutStore(path);
            expect(retried.list()).toHaveLength(1);
            retried.release();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("reserves the failure estimate before starting an arm", async () => {
        const store = new MemoryStore();
        // A first arm priced far below the scenario's full-context fallback.
        const cheap = {
            ...options(store),
            deskCostCeilingUsd: 0,
            pricesPerMillionTokens: { input: 1, output: 0, cacheCreation: 0, cacheRead: 0 },
        };
        const worstCase = (scenario.modelContextLimit * 1) / 1_000_000;
        const events: string[] = [];

        const result = await runPairedDelta(
            // Room for the first arm's own cost but not for a second arm's
            // failure charge.
            { ...cheap, maxCostUsd: worstCase, store },
            dependencies(undefined, events),
        );

        expect(result.status).toBe("cost-cap-reached");
        expect(events.filter((event) => event.startsWith("create:"))).toEqual(["create:mc-on"]);
    });

    it("reserves the failure estimate from cache pricing when it is the dearest rate", async () => {
        const store = new MemoryStore();
        // A build billed only for cached prompt tokens: the input and output rates are zero,
        // so cache pricing is the whole charge.
        const cached = {
            ...options(store),
            deskCostCeilingUsd: 0,
            pricesPerMillionTokens: { input: 0, output: 0, cacheCreation: 3, cacheRead: 1 },
        };
        const worstCase = (scenario.modelContextLimit * 3) / 1_000_000;
        expect(worstCase).toBeGreaterThan(0);
        const events: string[] = [];

        const result = await runPairedDelta(
            { ...cached, maxCostUsd: worstCase, store },
            dependencies(undefined, events),
        );

        // Ignoring the cache counters priced this fallback at zero, which admitted every arm.
        expect(result.status).toBe("cost-cap-reached");
        expect(events.filter((event) => event.startsWith("create:"))).toEqual(["create:mc-on"]);
    });

    it("records a rollout whose run throws synchronously without leaving the deadline armed", async () => {
        const store = new MemoryStore();
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown): void => {
            rejections.push(reason);
        };
        process.on("unhandledRejection", onRejection);
        try {
            const result = await runPairedDelta(
                { ...options(store), deadlineEpochMs: Date.now() + 30 },
                {
                    now: Date.now,
                    async createRollout(): Promise<RolloutHandle> {
                        return {
                            // Throws before returning a promise at all.
                            run: (() => {
                                throw new Error("run exploded");
                            }) as unknown as () => Promise<RolloutObservation>,
                            async dispose() {},
                        };
                    },
                },
            );

            expect(result.records[0]?.cell.runHealth).toBe("crash");
            // An armed timer outliving the arm rejects later with no consumer.
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(rejections).toEqual([]);
        } finally {
            process.off("unhandledRejection", onRejection);
        }
    });

    it("records a rollout whose disposal throws synchronously", async () => {
        const store = new MemoryStore();
        const result = await runPairedDelta(
            options(store),
            {
                now: () => 100,
                async createRollout({ coordinate }): Promise<RolloutHandle> {
                    return {
                        async run() {
                            return observation(coordinate.armId);
                        },
                        // Throws before returning a promise at all.
                        dispose: (() => {
                            throw new Error("harness disposal exploded");
                        }) as unknown as () => Promise<void>,
                    };
                },
            },
        );

        expect(result.status).toBe("harness-unreclaimed");
        expect(result.records[0]?.cell).toMatchObject({
            runHealth: "crash",
            reasonCode: "harness-failure",
        });
        // The paid rollout still reaches the store.
        expect(store.records).toHaveLength(1);
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
        dropRecord(store, "compaction");
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
    it("floors failure cost estimates at one full-context request", async () => {
        const expensive = {
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

            expect(new FileRolloutStore(path, { readOnly: true }).list()).toEqual([record]);
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
            expect(() => new FileRolloutStore(path, { readOnly: true }).list()).toThrow(/cost-invalid/);

            writeFileSync(path, JSON.stringify([{ ...record, costUsd: -1 }]));
            expect(() => new FileRolloutStore(path, { readOnly: true }).list()).toThrow(/cost-invalid/);

            writeFileSync(path, JSON.stringify([{ ...record, schema: "other/v1" }]));
            expect(() => new FileRolloutStore(path, { readOnly: true }).list()).toThrow(/schema-mismatch/);

            writeFileSync(
                path,
                JSON.stringify([{
                    ...record,
                    cell: { ...record.cell, runHealth: "sideways" },
                }]),
            );
            expect(() => new FileRolloutStore(path, { readOnly: true }).list())
                .toThrow(/cell-invalid: cell\.runHealth/);

            writeFileSync(path, JSON.stringify([{ ...record, priorAttemptsCostUsd: -1 }]));
            expect(() => new FileRolloutStore(path, { readOnly: true }).list())
                .toThrow(/prior-attempts-cost-invalid/);

            // `put` protects completed evidence by coordinate index, which a
            // duplicate would silently point away from.
            writeFileSync(path, JSON.stringify([record, record]));
            expect(() => new FileRolloutStore(path, { readOnly: true }).list()).toThrow(/duplicate-coordinate/);

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
                expect(() => new FileRolloutStore(path, { readOnly: true }).list())
                    .toThrow(/cell-invalid/);
            }

            writeFileSync(
                path,
                JSON.stringify([{ ...record, cell: { ...record.cell, reasonCode: "made-up" } }]),
            );
            expect(() => new FileRolloutStore(path, { readOnly: true }).list())
                .toThrow(/cell-invalid: cell\.reasonCode/);

            for (const checks of [
                "none",
                [{ id: "check-ladder" }],
                [{ id: "check-ladder", passed: true }, { id: "check-ladder", passed: true }],
            ]) {
                writeFileSync(path, JSON.stringify([{ ...record, checks }]));
                expect(() => new FileRolloutStore(path, { readOnly: true }).list()).toThrow(/checks-invalid/);
            }

            for (const patch of [
                { cell: { ...record.cell, reasonCode: "harness-failure" } },
                { cell: { ...record.cell, invalidSuccess: true } },
                { cell: { ...record.cell, checksTotal: 0, checksPassed: 0 } },
                { checks: [] as typeof record.checks },
            ]) {
                writeFileSync(path, JSON.stringify([{ ...record, ...patch }]));
                expect(() => new FileRolloutStore(path, { readOnly: true }).list())
                    .toThrow(/completed-cell-invalid|cell-invalid/);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
