import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import {
    PRIMARY_ARM_IDS,
    REGRET_ARM_IDS,
    validateCheckVector,
    type ArmId,
    type ArmedCellResult,
    type CheckResult,
    type ReasonCode,
    type ScenarioDeclaration,
} from "./contract";

export const ROLLOUT_RECORD_SCHEMA = "paired-delta-rollout/v1";

export interface TokenUsage {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
}

export interface TokenPrices {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
}

export interface InterventionDescriptor {
    kind: "none" | "scripted-retrieval" | "gold-memory" | "gold-evidence";
    value: unknown;
}

export interface RolloutCoordinate {
    poolManifestFingerprint: string;
    scenarioId: string;
    armId: ArmId;
    replicateIndex: number;
}

export interface RolloutObservation {
    checks: CheckResult[];
    claimedDone: boolean;
    absencePreconditionHeld: boolean;
    armIdentityMatches: boolean;
    echoedProviderId: string;
    echoedModelId: string;
    usage: TokenUsage;
    turns: number;
    baseScriptFingerprint: string;
    intervention: InterventionDescriptor;
}

export interface RolloutRecord extends RolloutCoordinate {
    schema: typeof ROLLOUT_RECORD_SCHEMA;
    repoCommit: string;
    pinnedProviderId: string;
    pinnedSnapshotId: string;
    echoedProviderId: string | null;
    echoedModelId: string | null;
    baseScriptFingerprint: string;
    intervention: InterventionDescriptor;
    cell: ArmedCellResult;
    checks: CheckResult[];
    usage: TokenUsage;
    costUsd: number;
    costSource: "observed" | "estimated";
    wallClockMs: number;
    turns: number;
    harnessDisposed: boolean;
}

export interface RolloutHandle {
    /** Oracle setup runs before the handle creates or uses a session in `run`. */
    prepare?(): Promise<void>;
    run(): Promise<RolloutObservation>;
    dispose(): Promise<void>;
}

export interface RolloutStore {
    list(): RolloutRecord[];
    put(record: RolloutRecord): void;
}

export interface RunnerDependencies {
    createRollout(input: {
        scenario: ScenarioDeclaration;
        coordinate: RolloutCoordinate;
        baseScriptFingerprint: string;
        intervention: InterventionDescriptor;
    }): Promise<RolloutHandle>;
    now(): number;
}

export interface RunPairedDeltaOptions {
    scenarios: readonly ScenarioDeclaration[];
    poolManifestFingerprint: string;
    repoCommit: string;
    pinnedProviderId: string;
    pinnedSnapshotId: string;
    replicateCount: number;
    deskCostCeilingUsd: number;
    maxCostUsd: number;
    deadlineEpochMs: number;
    pricesPerMillionTokens: TokenPrices;
    resume: boolean;
    store: RolloutStore;
}

export interface RegretRungs {
    retrieval?: number;
    formation?: number;
    representation?: number;
    refusedReason?: "base-fingerprint-mismatch" | "intervention-mismatch";
}

export interface CoordinateResult {
    scenarioId: string;
    replicateIndex: number;
    incomplete: boolean;
    cells: Partial<Record<ArmId, RolloutRecord>>;
    regret: RegretRungs | null;
}

export interface PairedDeltaRunResult {
    status: "completed" | "cost-cap-reached" | "deadline-reached";
    records: RolloutRecord[];
    coordinates: CoordinateResult[];
    spentUsd: number;
    reserveUsd: number;
    observedCostRollouts: number;
    estimatedCostRollouts: number;
    resumedRollouts: number;
    invalidStoredCoordinates: RolloutCoordinate[];
    exclusionCounts: Partial<Record<ArmId, Partial<Record<ReasonCode, number>>>>;
}

export class ProviderUnavailableError extends Error {}

export async function verifyDualMockResolution(input: {
    liveProviderId: string;
    liveModelId: string;
    modelContextLimit: number;
    sendPrompt(route: {
        providerId: string;
        modelId: string;
    }): Promise<{ providerId: string; modelId: string; contextLimit: number }>;
}): Promise<void> {
    const routes = [
        { providerId: "mock-anthropic", modelId: "mock-sonnet" },
        { providerId: input.liveProviderId, modelId: input.liveModelId },
    ];
    const resolved = await Promise.all(routes.map((route) => input.sendPrompt(route)));
    for (let index = 0; index < routes.length; index++) {
        const expected = routes[index];
        const actual = resolved[index];
        if (
            actual?.providerId !== expected?.providerId ||
            actual.modelId !== expected.modelId
        ) {
            throw new Error(`dual-mock route mismatch for ${expected?.providerId}`);
        }
    }
    if (resolved[1]?.contextLimit !== input.modelContextLimit) {
        throw new Error(
            `dual-mock context limit mismatch: expected ${input.modelContextLimit}, ` +
                `received ${resolved[1]?.contextLimit}`,
        );
    }
}

export class FileRolloutStore implements RolloutStore {
    constructor(private readonly path: string) {}

    list(): RolloutRecord[] {
        try {
            const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
            if (!Array.isArray(raw)) throw new Error("rollout store must contain an array");
            return raw as RolloutRecord[];
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
    }

    put(record: RolloutRecord): void {
        const records = this.list();
        const index = records.findIndex((candidate) => sameCoordinate(candidate, record));
        if (index >= 0 && records[index]?.cell.runHealth === "completed") {
            throw new Error(`refusing to replace completed rollout ${coordinateKey(record)}`);
        }
        if (index >= 0) records[index] = record;
        else records.push(record);
        mkdirSync(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.tmp-${process.pid}-${crypto.randomUUID()}`;
        writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, this.path);
    }
}

export function tokenCostUsd(usage: TokenUsage, prices: TokenPrices): number {
    return (
        usage.input * prices.input +
        usage.output * prices.output +
        usage.cacheCreation * prices.cacheCreation +
        usage.cacheRead * prices.cacheRead
    ) / 1_000_000;
}

export function baseScriptFingerprint(scenario: ScenarioDeclaration): string {
    return canonicalFingerprint(
        scenario.turnScript.map(({ id, role, content }) => ({ id, role, content })),
    );
}

export function interventionFor(
    scenario: ScenarioDeclaration,
    armId: ArmId,
): InterventionDescriptor {
    switch (armId) {
        case "r1":
            return { kind: "scripted-retrieval", value: scenario.interventions.r1 };
        case "r2":
            return { kind: "gold-memory", value: scenario.interventions.r2 };
        case "r3":
            return { kind: "gold-evidence", value: scenario.interventions.r3 };
        default:
            return { kind: "none", value: null };
    }
}

export async function runPairedDelta(
    options: RunPairedDeltaOptions,
    dependencies: RunnerDependencies,
): Promise<PairedDeltaRunResult> {
    const stored = options.store.list();
    const records: RolloutRecord[] = [];
    const coordinates: CoordinateResult[] = [];
    const invalidStoredCoordinates: RolloutCoordinate[] = [];
    const exclusionCounts: PairedDeltaRunResult["exclusionCounts"] = {};
    let spentUsd = 0;
    let observedCostRollouts = 0;
    let estimatedCostRollouts = 0;
    let resumedRollouts = 0;
    let reserveUsd = options.deskCostCeilingUsd;
    let status: PairedDeltaRunResult["status"] = "completed";
    let startedAny = false;
    const selectedScenarioIds = new Set(options.scenarios.map(({ scenarioId }) => scenarioId));

    for (const record of stored) {
        if (
            record.poolManifestFingerprint === options.poolManifestFingerprint &&
            selectedScenarioIds.has(record.scenarioId) &&
            record.replicateIndex >= 0 &&
            record.replicateIndex < options.replicateCount &&
            record.repoCommit === options.repoCommit &&
            record.pinnedProviderId === options.pinnedProviderId &&
            record.pinnedSnapshotId === options.pinnedSnapshotId &&
            (
                record.cell.runHealth !== "completed" ||
                (
                    record.echoedProviderId === options.pinnedProviderId &&
                    record.echoedModelId === options.pinnedSnapshotId
                )
            )
        ) {
            spentUsd += record.costUsd;
            reserveUsd = Math.max(reserveUsd, record.costUsd);
            if (record.costSource === "observed") observedCostRollouts++;
            else estimatedCostRollouts++;
        }
    }

    outer:
    for (const scenario of options.scenarios) {
        const fingerprint = baseScriptFingerprint(scenario);
        for (let replicateIndex = 0; replicateIndex < options.replicateCount; replicateIndex++) {
            const coordinateResult: CoordinateResult = {
                scenarioId: scenario.scenarioId,
                replicateIndex,
                incomplete: false,
                cells: {},
                regret: null,
            };
            const runArm = async (armId: ArmId): Promise<RolloutRecord | null> => {
                const coordinate: RolloutCoordinate = {
                    poolManifestFingerprint: options.poolManifestFingerprint,
                    scenarioId: scenario.scenarioId,
                    armId,
                    replicateIndex,
                };
                const existing = stored.find((record) => sameCoordinate(record, coordinate));
                if (existing) {
                    const bindingMatches =
                        existing.repoCommit === options.repoCommit &&
                        existing.pinnedProviderId === options.pinnedProviderId &&
                        existing.pinnedSnapshotId === options.pinnedSnapshotId;
                    const completedIdentityMatches =
                        existing.cell.runHealth !== "completed" ||
                        (
                            existing.echoedProviderId === options.pinnedProviderId &&
                            existing.echoedModelId === options.pinnedSnapshotId
                        );
                    if (!bindingMatches || !completedIdentityMatches) {
                        invalidStoredCoordinates.push(coordinate);
                        return null;
                    }
                    if (options.resume && existing.cell.runHealth === "completed") {
                        resumedRollouts++;
                        records.push(existing);
                        coordinateResult.cells[armId] = existing;
                        return existing;
                    }
                }
                if (dependencies.now() >= options.deadlineEpochMs) {
                    status = "deadline-reached";
                    return null;
                }
                if (startedAny && spentUsd + reserveUsd > options.maxCostUsd) {
                    status = "cost-cap-reached";
                    return null;
                }
                startedAny = true;
                const intervention = interventionFor(scenario, armId);
                const startedAt = dependencies.now();
                let handle: RolloutHandle | null = null;
                let observation: RolloutObservation | null = null;
                let failure: unknown;
                let disposed = false;
                try {
                    handle = await dependencies.createRollout({
                        scenario,
                        coordinate,
                        baseScriptFingerprint: fingerprint,
                        intervention,
                    });
                    await handle.prepare?.();
                    observation = await handle.run();
                } catch (error) {
                    failure = error;
                } finally {
                    if (handle) {
                        try {
                            await handle.dispose();
                            disposed = true;
                        } catch (error) {
                            failure ??= error;
                        }
                    }
                }
                const wallClockMs = Math.max(0, dependencies.now() - startedAt);
                const record = observation
                    ? completedRecord(
                        options,
                        coordinate,
                        scenario,
                        observation,
                        fingerprint,
                        intervention,
                        wallClockMs,
                        disposed,
                    )
                    : failedRecord(
                        options,
                        coordinate,
                        fingerprint,
                        intervention,
                        wallClockMs,
                        disposed,
                        failure,
                        reserveUsd,
                    );
                options.store.put(record);
                records.push(record);
                coordinateResult.cells[armId] = record;
                spentUsd += record.costUsd;
                reserveUsd = Math.max(reserveUsd, record.costUsd);
                if (record.costSource === "observed") observedCostRollouts++;
                else estimatedCostRollouts++;
                if (record.cell.reasonCode) incrementExclusion(exclusionCounts, armId, record.cell.reasonCode);
                return record;
            };

            for (const armId of PRIMARY_ARM_IDS) {
                const record = await runArm(armId);
                if (status !== "completed") {
                    coordinateResult.incomplete = true;
                    coordinates.push(coordinateResult);
                    break outer;
                }
                if (!record) coordinateResult.incomplete = true;
            }
            const mcOn = coordinateResult.cells["mc-on"];
            if (
                mcOn?.cell.runHealth === "completed" &&
                mcOn.cell.criticalPassed < mcOn.cell.criticalTotal
            ) {
                for (const armId of REGRET_ARM_IDS.slice(1)) {
                    await runArm(armId);
                    if (status !== "completed") {
                        coordinateResult.incomplete = true;
                        coordinateResult.regret = computeRegretRungs(
                            scenario,
                            coordinateResult.cells,
                        );
                        coordinates.push(coordinateResult);
                        break outer;
                    }
                }
                coordinateResult.regret = computeRegretRungs(scenario, coordinateResult.cells);
            }
            coordinateResult.incomplete ||= PRIMARY_ARM_IDS.some(
                (armId) => coordinateResult.cells[armId]?.cell.runHealth !== "completed",
            );
            coordinates.push(coordinateResult);
        }
    }

    return {
        status,
        records,
        coordinates,
        spentUsd,
        reserveUsd,
        observedCostRollouts,
        estimatedCostRollouts,
        resumedRollouts,
        invalidStoredCoordinates,
        exclusionCounts,
    };
}

function completedRecord(
    options: RunPairedDeltaOptions,
    coordinate: RolloutCoordinate,
    scenario: ScenarioDeclaration,
    observation: RolloutObservation,
    expectedFingerprint: string,
    expectedIntervention: InterventionDescriptor,
    wallClockMs: number,
    harnessDisposed: boolean,
): RolloutRecord {
    const identityMatches =
        observation.echoedProviderId === options.pinnedProviderId &&
        observation.echoedModelId === options.pinnedSnapshotId;
    const reasonCode: ReasonCode | null = !observation.absencePreconditionHeld
        ? "absence-precondition-unmet"
        : !observation.armIdentityMatches || !identityMatches
            ? "arm-identity-mismatch"
            : null;
    const runHealth = reasonCode === null ? "completed" : "unavailable";
    let checks: CheckResult[] = [];
    if (runHealth === "completed") {
        validateCheckVector(scenario, coordinate.armId, observation.checks);
        checks = observation.checks;
    }
    const applicableCritical = new Set(
        scenario.checks
            .filter(({ appliesToArms }) => appliesToArms.includes(coordinate.armId))
            .map(({ id }) => id)
            .filter((id) => scenario.criticalCheckIds.includes(id)),
    );
    const checksPassed = checks.filter(({ passed }) => passed).length;
    const criticalPassed = checks.filter(
        ({ id, passed }) => passed && applicableCritical.has(id),
    ).length;
    const usage = normalizeUsage(observation.usage);
    return {
        schema: ROLLOUT_RECORD_SCHEMA,
        ...coordinate,
        repoCommit: options.repoCommit,
        pinnedProviderId: options.pinnedProviderId,
        pinnedSnapshotId: options.pinnedSnapshotId,
        echoedProviderId: observation.echoedProviderId,
        echoedModelId: observation.echoedModelId,
        baseScriptFingerprint: observation.baseScriptFingerprint,
        intervention: observation.intervention,
        cell: {
            armId: coordinate.armId,
            checksPassed,
            checksTotal: checks.length,
            criticalPassed,
            criticalTotal: runHealth === "completed" ? applicableCritical.size : 0,
            invalidSuccess:
                runHealth === "completed" &&
                observation.claimedDone &&
                criticalPassed < applicableCritical.size,
            runHealth,
            reasonCode,
        },
        checks,
        usage,
        costUsd: tokenCostUsd(usage, options.pricesPerMillionTokens),
        costSource: "observed",
        wallClockMs,
        turns: observation.turns,
        harnessDisposed,
    };
}

function failedRecord(
    options: RunPairedDeltaOptions,
    coordinate: RolloutCoordinate,
    fingerprint: string,
    intervention: InterventionDescriptor,
    wallClockMs: number,
    harnessDisposed: boolean,
    failure: unknown,
    reserveUsd: number,
): RolloutRecord {
    const providerUnavailable = failure instanceof ProviderUnavailableError;
    return {
        schema: ROLLOUT_RECORD_SCHEMA,
        ...coordinate,
        repoCommit: options.repoCommit,
        pinnedProviderId: options.pinnedProviderId,
        pinnedSnapshotId: options.pinnedSnapshotId,
        echoedProviderId: null,
        echoedModelId: null,
        baseScriptFingerprint: fingerprint,
        intervention,
        cell: {
            armId: coordinate.armId,
            checksPassed: 0,
            checksTotal: 0,
            criticalPassed: 0,
            criticalTotal: 0,
            invalidSuccess: false,
            runHealth: providerUnavailable ? "unavailable" : "crash",
            reasonCode: providerUnavailable ? "provider-unavailable" : "harness-failure",
        },
        checks: [],
        usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        costUsd: reserveUsd,
        costSource: "estimated",
        wallClockMs,
        turns: 0,
        harnessDisposed,
    };
}

export function computeRegretRungs(
    scenario: ScenarioDeclaration,
    records: Partial<Record<ArmId, RolloutRecord>>,
): RegretRungs {
    const completed = REGRET_ARM_IDS.map((armId) => records[armId]).filter(
        (record): record is RolloutRecord => record?.cell.runHealth === "completed",
    );
    const expectedFingerprint = baseScriptFingerprint(scenario);
    if (completed.some(({ baseScriptFingerprint }) =>
        baseScriptFingerprint !== expectedFingerprint)) {
        return { refusedReason: "base-fingerprint-mismatch" };
    }
    if (completed.some((record) =>
        canonicalFingerprint(record.intervention) !==
        canonicalFingerprint(interventionFor(scenario, record.armId)))) {
        return { refusedReason: "intervention-mismatch" };
    }
    const ids = scenario.checks
        .filter(({ appliesToArms }) => REGRET_ARM_IDS.every((arm) => appliesToArms.includes(arm)))
        .map(({ id }) => id);
    const score = (armId: ArmId): number | null => {
        const record = records[armId];
        if (record?.cell.runHealth !== "completed") return null;
        const selected = record.checks.filter(({ id }) => ids.includes(id));
        return selected.filter(({ passed }) => passed).length / selected.length;
    };
    const r0 = score("mc-on");
    const r1 = score("r1");
    const r2 = score("r2");
    const r3 = score("r3");
    return {
        ...(r0 !== null && r1 !== null ? { retrieval: r1 - r0 } : {}),
        ...(r1 !== null && r2 !== null ? { formation: r2 - r1 } : {}),
        ...(r2 !== null && r3 !== null ? { representation: r3 - r2 } : {}),
    };
}

function normalizeUsage(usage: TokenUsage): TokenUsage {
    return Object.fromEntries(
        Object.entries(usage).map(([key, value]) => [key, Math.max(0, value)]),
    ) as unknown as TokenUsage;
}

function incrementExclusion(
    counts: PairedDeltaRunResult["exclusionCounts"],
    armId: ArmId,
    reasonCode: ReasonCode,
): void {
    const byReason = counts[armId] ??= {};
    byReason[reasonCode] = (byReason[reasonCode] ?? 0) + 1;
}

function coordinateKey(coordinate: RolloutCoordinate): string {
    return [
        coordinate.poolManifestFingerprint,
        coordinate.scenarioId,
        coordinate.armId,
        coordinate.replicateIndex,
    ].join(":");
}

function sameCoordinate(a: RolloutCoordinate, b: RolloutCoordinate): boolean {
    return coordinateKey(a) === coordinateKey(b);
}
