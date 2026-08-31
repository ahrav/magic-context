import { readFileSync } from "node:fs";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { publishJsonAtomically } from "../incident-pool/report";
import {
    ARM_IDS,
    PRIMARY_ARM_IDS,
    PairedDeltaContractError,
    REGRET_ARM_IDS,
    RUN_HEALTHS,
    validateCheckVector,
    type ArmId,
    type ArmedCellResult,
    type CheckResult,
    type ReasonCode,
    type RunHealth,
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
    status: "completed" | "cost-cap-reached" | "deadline-reached" | "invalid-stored-records";
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

/** Thrown when an in-flight rollout outlives the run deadline. */
export class RolloutDeadlineError extends Error {}

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

const RUN_HEALTH_SET: ReadonlySet<string> = new Set(RUN_HEALTHS);
const ARM_ID_SET: ReadonlySet<string> = new Set(ARM_IDS);

/**
 * Stored records control spend caps and resume behavior. A record with a
 * non-finite or negative cost would disable the cost cap: adding NaN to the
 * spent total makes every later cap comparison false.
 */
function parseRolloutRecords(raw: unknown, path: string): RolloutRecord[] {
    if (!Array.isArray(raw)) {
        throw new Error(`rollout store ${path} must contain an array`);
    }
    raw.forEach((candidate, index) => {
        const fail = (why: string): never => {
            throw new Error(`rollout store ${path} record ${index}: ${why}`);
        };
        if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
            fail("record-not-object");
        }
        const record = candidate as Partial<RolloutRecord>;
        if (record.schema !== ROLLOUT_RECORD_SCHEMA) fail("schema-mismatch");
        if (
            typeof record.poolManifestFingerprint !== "string" ||
            typeof record.scenarioId !== "string" ||
            typeof record.armId !== "string" ||
            !ARM_ID_SET.has(record.armId) ||
            !Number.isSafeInteger(record.replicateIndex) ||
            (record.replicateIndex as number) < 0
        ) {
            fail("coordinate-invalid");
        }
        if (!Number.isFinite(record.costUsd) || (record.costUsd as number) < 0) {
            fail("cost-invalid");
        }
        if (record.costSource !== "observed" && record.costSource !== "estimated") {
            fail("cost-source-invalid");
        }
        const cell = record.cell as Partial<ArmedCellResult> | undefined;
        if (
            cell === null ||
            typeof cell !== "object" ||
            typeof cell.runHealth !== "string" ||
            !RUN_HEALTH_SET.has(cell.runHealth)
        ) {
            fail("run-health-invalid");
        }
    });
    return raw as RolloutRecord[];
}

export class FileRolloutStore implements RolloutStore {
    private records: RolloutRecord[] | null = null;
    private indexByCoordinate = new Map<string, number>();

    constructor(private readonly path: string) {}

    list(): RolloutRecord[] {
        return [...this.load()];
    }

    put(record: RolloutRecord): void {
        const records = this.load();
        const key = coordinateKey(record);
        const index = this.indexByCoordinate.get(key);
        if (index !== undefined && records[index]?.cell.runHealth === "completed") {
            throw new Error(`refusing to replace completed rollout ${key}`);
        }
        if (index !== undefined) {
            records[index] = record;
        } else {
            this.indexByCoordinate.set(key, records.length);
            records.push(record);
        }
        // The records file feeds spend and resume decisions for later runs, so
        // it stays owner-only even though report artifacts are world-readable.
        publishJsonAtomically(records, this.path, { mode: 0o600 });
    }

    private load(): RolloutRecord[] {
        if (this.records) return this.records;
        let records: RolloutRecord[] = [];
        try {
            records = parseRolloutRecords(
                JSON.parse(readFileSync(this.path, "utf8")) as unknown,
                this.path,
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.records = records;
        this.indexByCoordinate = new Map(
            records.map((record, index) => [coordinateKey(record), index]),
        );
        return records;
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
    const storedByCoordinate = new Map(
        stored.map((record) => [coordinateKey(record), record]),
    );
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
    const inMatrix = (record: RolloutRecord): boolean =>
        record.poolManifestFingerprint === options.poolManifestFingerprint &&
        selectedScenarioIds.has(record.scenarioId) &&
        record.replicateIndex >= 0 &&
        record.replicateIndex < options.replicateCount;

    // A non-resume run asserts a fresh matrix; refusing before any rollout
    // keeps the run from paying for a coordinate it cannot persist.
    if (!options.resume) {
        const conflict = stored.find(inMatrix);
        if (conflict) {
            throw new Error(
                `records file already contains rollouts for this matrix ` +
                    `(${coordinateKey(conflict)}); resume the run or point ` +
                    "at a fresh records path",
            );
        }
    }

    for (const record of stored) {
        if (
            inMatrix(record) &&
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
                const existing = storedByCoordinate.get(coordinateKey(coordinate));
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
                    // Completed records are immutable evidence; re-executing
                    // one would pay for a rollout whose result the store must
                    // then discard.
                    if (existing.cell.runHealth === "completed") {
                        resumedRollouts++;
                        records.push(existing);
                        coordinateResult.cells[armId] = existing;
                        return existing;
                    }
                }
                const remainingMs = options.deadlineEpochMs - dependencies.now();
                if (remainingMs <= 0) {
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
                    const started = handle;
                    observation = await withRolloutDeadline(async () => {
                        await started.prepare?.();
                        return started.run();
                    }, remainingMs);
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
                        scenario,
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
                if (failure instanceof RolloutDeadlineError) status = "deadline-reached";
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
                    const rung = await runArm(armId);
                    if (status !== "completed") {
                        coordinateResult.incomplete = true;
                        coordinateResult.regret = computeRegretRungs(
                            scenario,
                            coordinateResult.cells,
                        );
                        coordinates.push(coordinateResult);
                        break outer;
                    }
                    if (rung?.cell.runHealth !== "completed") break;
                }
                coordinateResult.regret = computeRegretRungs(scenario, coordinateResult.cells);
            }
            coordinateResult.incomplete ||= PRIMARY_ARM_IDS.some(
                (armId) => coordinateResult.cells[armId]?.cell.runHealth !== "completed",
            );
            coordinates.push(coordinateResult);
        }
    }

    if (status === "completed" && invalidStoredCoordinates.length > 0) {
        status = "invalid-stored-records";
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
    const declarationMatches =
        observation.baseScriptFingerprint === expectedFingerprint &&
        canonicalFingerprint(observation.intervention) ===
            canonicalFingerprint(expectedIntervention);
    let reasonCode: ReasonCode | null = !observation.absencePreconditionHeld
        ? "absence-precondition-unmet"
        : !observation.armIdentityMatches || !identityMatches
            ? "arm-identity-mismatch"
            : !declarationMatches
                ? "invalid-result"
                : null;
    let runHealth: RunHealth = reasonCode === null
        ? "completed"
        : reasonCode === "invalid-result"
            ? "malformed"
            : "unavailable";
    let checks: CheckResult[] = [];
    if (runHealth === "completed") {
        try {
            validateCheckVector(scenario, coordinate.armId, observation.checks);
            checks = observation.checks;
        } catch (error) {
            if (!(error instanceof PairedDeltaContractError)) throw error;
            reasonCode = "invalid-result";
            runHealth = "malformed";
        }
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
    scenario: ScenarioDeclaration,
    fingerprint: string,
    intervention: InterventionDescriptor,
    wallClockMs: number,
    harnessDisposed: boolean,
    failure: unknown,
    reserveUsd: number,
): RolloutRecord {
    const providerUnavailable = failure instanceof ProviderUnavailableError;
    const deadlineExceeded = failure instanceof RolloutDeadlineError;
    const worstCaseUsd = tokenCostUsd(
        {
            input: scenario.modelContextLimit,
            output: scenario.modelContextLimit,
            cacheCreation: 0,
            cacheRead: 0,
        },
        options.pricesPerMillionTokens,
    );
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
            runHealth: providerUnavailable
                ? "unavailable"
                : deadlineExceeded
                    ? "timeout"
                    : "crash",
            reasonCode: providerUnavailable
                ? "provider-unavailable"
                : deadlineExceeded
                    ? "deadline-exceeded"
                    : "harness-failure",
        },
        checks: [],
        usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        costUsd: providerUnavailable ? reserveUsd : Math.max(reserveUsd, worstCaseUsd),
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

async function withRolloutDeadline<T>(
    work: () => Promise<T>,
    remainingMs: number,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = work();
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new RolloutDeadlineError(
                        `rollout still in flight after the ${remainingMs}ms deadline budget`,
                    )),
                    remainingMs,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
        // On timeout the losing promise settles later with no consumer;
        // swallow its rejection so it cannot surface as unhandled.
        pending.catch(() => {});
    }
}
