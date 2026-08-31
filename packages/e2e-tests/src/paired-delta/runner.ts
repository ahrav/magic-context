import { readFileSync } from "node:fs";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { publishJsonAtomically } from "../atomic-publish";
import {
    ARM_IDS,
    PRIMARY_ARM_IDS,
    PairedDeltaContractError,
    r3PromptEvidence,
    REASON_CODES,
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
    /** Spend on earlier attempts at this coordinate, which replacement would otherwise erase from the file the next resume reconstructs spend from. commentlint: allow(JUDGE) */
    priorAttemptsCostUsd: number;
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
    status:
        | "completed"
        | "cost-cap-reached"
        | "deadline-reached"
        | "invalid-stored-records"
        | "harness-unreclaimed";
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

const LATE_DISPOSAL_GRACE_MS = 5_000;

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
const REASON_CODE_SET: ReadonlySet<string> = new Set(REASON_CODES);

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
        if (
            !Number.isFinite(record.priorAttemptsCostUsd) ||
            (record.priorAttemptsCostUsd as number) < 0
        ) {
            fail("prior-attempts-cost-invalid");
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
        const armedCell = cell as ArmedCellResult;
        const counts = [
            armedCell.checksPassed,
            armedCell.checksTotal,
            armedCell.criticalPassed,
            armedCell.criticalTotal,
        ];
        if (
            armedCell.armId !== record.armId ||
            typeof armedCell.invalidSuccess !== "boolean" ||
            counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
            armedCell.checksPassed > armedCell.checksTotal ||
            armedCell.criticalPassed > armedCell.criticalTotal
        ) {
            fail("cell-invalid");
        }
        if (
            armedCell.reasonCode !== null &&
            (
                typeof armedCell.reasonCode !== "string" ||
                !REASON_CODE_SET.has(armedCell.reasonCode)
            )
        ) {
            fail("reason-code-invalid");
        }
        const checks = record.checks ?? null;
        if (
            !Array.isArray(checks) ||
            checks.some((check) =>
                check === null ||
                typeof check !== "object" ||
                typeof (check as CheckResult).id !== "string" ||
                typeof (check as CheckResult).passed !== "boolean"
            ) ||
            new Set(checks.map((check) => (check as CheckResult).id)).size !== checks.length
        ) {
            fail("checks-invalid");
        }
        /** A completed record suppresses its live rollout, so its cell must be a shape a completed rollout could actually produce: a reason code, a zero denominator, or a check vector that disagrees with the counts marks storage that was corrupted or hand-edited, and regret scoring would divide by it. commentlint: allow(JUDGE) */
        const vector = checks as CheckResult[];
        if (armedCell.runHealth === "completed") {
            if (
                armedCell.reasonCode !== null ||
                armedCell.checksTotal === 0 ||
                vector.length !== armedCell.checksTotal ||
                vector.filter((check) => check.passed).length !== armedCell.checksPassed
            ) {
                fail("completed-cell-invalid");
            }
        }
    });
    /** `put` indexes by coordinate and refuses to replace completed evidence, so a duplicate makes both wrong at once: the pre-scan bills every copy, and the index points at whichever landed last rather than at the completed record it must protect. commentlint: allow(JUDGE) */
    const seen = new Set<string>();
    (raw as RolloutRecord[]).forEach((record, index) => {
        const key = coordinateKey(record);
        if (seen.has(key)) {
            throw new Error(
                `rollout store ${path} record ${index}: duplicate-coordinate ${key}`,
            );
        }
        seen.add(key);
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
            return { kind: "scripted-retrieval", value: structuredClone(scenario.interventions.r1) };
        case "r2":
            return { kind: "gold-memory", value: structuredClone(scenario.interventions.r2) };
        case "r3":
            return { kind: "gold-evidence", value: r3PromptEvidence(scenario) };
        default:
            return { kind: "none", value: null };
    }
}

/** A stored record binds to the run's commit and pinned model, and a completed one also echoes them back; anything else is re-run rather than rehydrated. Pre-scan accounting and rehydration share this test so a record cannot be charged as resumed and then executed again. commentlint: allow(JUDGE) */
function bindingMatches(record: RolloutRecord, options: RunPairedDeltaOptions): boolean {
    return record.repoCommit === options.repoCommit &&
        record.pinnedProviderId === options.pinnedProviderId &&
        record.pinnedSnapshotId === options.pinnedSnapshotId;
}

function completedIdentityMatches(
    record: RolloutRecord,
    options: RunPairedDeltaOptions,
): boolean {
    return record.cell.runHealth !== "completed" ||
        (
            record.echoedProviderId === options.pinnedProviderId &&
            record.echoedModelId === options.pinnedSnapshotId
        );
}

/** Completed evidence must be scorable against the declaration it is standing in for, so the vector is revalidated and its aggregates recomputed rather than trusted from the file. commentlint: allow(JUDGE) */
function resumableEvidence(record: RolloutRecord, scenario: ScenarioDeclaration): boolean {
    try {
        validateCheckVector(scenario, record.checks);
    } catch (error) {
        if (!(error instanceof PairedDeltaContractError)) throw error;
        return false;
    }
    const critical = new Set(scenario.criticalCheckIds);
    const criticalPassed = record.checks.filter(
        ({ id, passed }) => passed && critical.has(id),
    ).length;
    return record.cell.checksTotal === scenario.checks.length &&
        record.cell.checksPassed === record.checks.filter(({ passed }) => passed).length &&
        record.cell.criticalTotal === critical.size &&
        record.cell.criticalPassed === criticalPassed;
}

function isResumable(record: RolloutRecord, options: RunPairedDeltaOptions): boolean {
    return options.resume &&
        record.cell.runHealth === "completed" &&
        bindingMatches(record, options) &&
        completedIdentityMatches(record, options);
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
    /** A creation that lost its deadline race still yields a handle that owns a live harness. Its disposal is settled before the run returns so an unreclaimed one reaches the caller as `harness-unreclaimed` rather than as silence. commentlint: allow(JUDGE) */
    const lateDisposals: Promise<boolean>[] = [];
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

    /** The pre-scan restores spend and the reserve floor only. The rollout counters are incremented where a record enters `records` — at rehydration or after a rollout runs — because a run that stops at the cap or the deadline never reaches its later coordinates, and counting them here would report rollouts absent from the result. commentlint: allow(JUDGE) */
    for (const record of stored) {
        /** A record from another commit or pinned model priced a different build, so it informs neither this run's reserve nor its spend. commentlint: allow(JUDGE) */
        if (!inMatrix(record) || !bindingMatches(record, options)) continue;
        const attemptsCostUsd = record.priorAttemptsCostUsd + record.costUsd;
        /** A replaced attempt's own price survives only in `priorAttemptsCostUsd`, so the floor is taken over the cumulative figure too: a reserve below a demonstrated per-rollout cost would admit a call that overshoots `maxCostUsd`. commentlint: allow(JUDGE) */
        reserveUsd = Math.max(reserveUsd, record.costUsd, record.priorAttemptsCostUsd);
        spentUsd += attemptsCostUsd;
        /** Restored spend is billed spend, so the next rollout meets the cost cap instead of being admitted as this run's first. commentlint: allow(JUDGE) */
        if (attemptsCostUsd > 0) startedAny = true;
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
                    if (
                        !bindingMatches(existing, options) ||
                        !completedIdentityMatches(existing, options)
                    ) {
                        invalidStoredCoordinates.push(coordinate);
                        return null;
                    }
                    // Completed records are immutable evidence; re-executing
                    // one would pay for a rollout whose result the store must
                    // then discard.
                    /** A stored vector is only unique strings to the parser, which has no declaration; an id set that does not belong to this scenario would be rehydrated as evidence and can leave `score()` dividing by an empty selection. commentlint: allow(JUDGE) */
                    if (isResumable(existing, options) && !resumableEvidence(existing, scenario)) {
                        invalidStoredCoordinates.push(coordinate);
                        return null;
                    }
                    if (isResumable(existing, options)) {
                        resumedRollouts++;
                        records.push(existing);
                        if (existing.costSource === "observed") observedCostRollouts++;
                        else estimatedCostRollouts++;
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
                /** The previous attempt's spend is retained on the replacement record because `put` keeps one record per coordinate, so the file a later resume reads would otherwise show only the last attempt. commentlint: allow(JUDGE) */
                const priorAttemptsCostUsd = existing
                    ? existing.priorAttemptsCostUsd + existing.costUsd
                    : 0;
                let handle: RolloutHandle | null = null;
                let creation: Promise<RolloutHandle> | null = null;
                let observation: RolloutObservation | null = null;
                let failure: unknown;
                let disposed = false;
                let disposalFailed = false;
                try {
                    /** Creation spawns the harness, so it is inside the deadline: a hung create would otherwise outlive `deadlineEpochMs` unbounded. The handle is captured off the promise rather than the race result, so one that arrives after the deadline is still disposed instead of leaking a live harness. commentlint: allow(JUDGE) */
                    creation = dependencies.createRollout({
                        scenario,
                        coordinate,
                        baseScriptFingerprint: fingerprint,
                        /** The adapter resolves symbolic locator handles, so it gets its own copy: mutating the descriptor the comparison keeps would make the declaration-match check accept whatever the adapter produced. commentlint: allow(JUDGE) */
                        intervention: structuredClone(intervention),
                    });
                    const pendingCreation = creation;
                    pendingCreation.then((created) => {
                        handle = created;
                    }, () => {});
                    const started = await withRolloutDeadline(() => pendingCreation, remainingMs);
                    handle = started;
                    /** Creation consumed part of the budget, so the rollout gets what is left rather than the allowance measured before it. commentlint: allow(JUDGE) */
                    const runMs = options.deadlineEpochMs - dependencies.now();
                    if (runMs <= 0) throw new RolloutDeadlineError("deadline reached before run");
                    observation = await withRolloutDeadline(async () => {
                        await started.prepare?.();
                        return started.run();
                    }, runMs);
                } catch (error) {
                    failure = error;
                } finally {
                    if (handle) {
                        try {
                            await handle.dispose();
                            disposed = true;
                        } catch (error) {
                            /** A harness left running outranks whatever ended the rollout: the deadline only bounded this arm, while an unreclaimed harness threatens every arm after it. commentlint: allow(JUDGE) */
                            disposalFailed = true;
                            failure ??= error;
                        }
                    } else {
                        /** A handle that lost the creation race still owns a harness, so it is disposed when it arrives; nothing waits on it because a hung creation is what the deadline is for. commentlint: allow(JUDGE) */
                        if (creation) lateDisposals.push(disposeLateHandle(creation));
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
                        reserveUsd,
                        priorAttemptsCostUsd,
                        disposalFailed,
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
                        priorAttemptsCostUsd,
                        disposalFailed,
                    );
                options.store.put(record);
                records.push(record);
                coordinateResult.cells[armId] = record;
                spentUsd += record.costUsd;
                reserveUsd = Math.max(reserveUsd, record.costUsd);
                if (record.costSource === "observed") observedCostRollouts++;
                else estimatedCostRollouts++;
                if (record.cell.reasonCode) incrementExclusion(exclusionCounts, armId, record.cell.reasonCode);
                /** A harness that would not dispose may still be holding its workspace and session, so the next arm would measure a contaminated environment; the run ends rather than producing arms whose comparison cannot be trusted. commentlint: allow(JUDGE) */
                if (disposalFailed) status = "harness-unreclaimed";
                else if (failure instanceof RolloutDeadlineError) status = "deadline-reached";
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

    if (lateDisposals.length > 0) {
        const reclaimed = await Promise.all(lateDisposals);
        if (reclaimed.some((ok) => !ok)) status = "harness-unreclaimed";
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

function canonicalizes(observed: unknown, expected: InterventionDescriptor): boolean {
    try {
        return canonicalFingerprint(observed) === canonicalFingerprint(expected);
    } catch {
        return false;
    }
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
    reserveUsd: number,
    priorAttemptsCostUsd: number,
    disposalFailed: boolean,
): RolloutRecord {
    const identityMatches =
        observation.echoedProviderId === options.pinnedProviderId &&
        observation.echoedModelId === options.pinnedSnapshotId;
    /** The intervention comes back from the rollout adapter, so it can hold a value `canonicalFingerprint` refuses; a throw here would escape `runArm` after the provider call and lose the paid coordinate instead of recording it. commentlint: allow(JUDGE) */
    const declarationMatches = observation.baseScriptFingerprint === expectedFingerprint &&
        canonicalizes(
            observation.intervention,
            expectedIntervention,
        );
    const usage = finiteUsage(observation.usage);
    /** A harness that would not dispose may still be running and contaminating later arms, so its result cannot stand as evidence however well the rollout itself went. Non-finite usage is checked next because a cost derived from it would poison `spentUsd` for every later cap comparison. commentlint: allow(JUDGE) */
    let reasonCode: ReasonCode | null = disposalFailed
        ? "harness-failure"
        : usage === null
            ? "invalid-result"
            : !observation.absencePreconditionHeld
                ? "absence-precondition-unmet"
                : !observation.armIdentityMatches || !identityMatches
                    ? "arm-identity-mismatch"
                    : !declarationMatches
                        ? "invalid-result"
                        : null;
    let runHealth: RunHealth = reasonCode === null
        ? "completed"
        : reasonCode === "harness-failure"
            ? "crash"
            : reasonCode === "invalid-result"
                ? "malformed"
                : "unavailable";
    let checks: CheckResult[] = [];
    if (runHealth === "completed") {
        try {
            validateCheckVector(scenario, observation.checks);
            checks = observation.checks;
        } catch (error) {
            if (!(error instanceof PairedDeltaContractError)) throw error;
            reasonCode = "invalid-result";
            runHealth = "malformed";
        }
    }
    const applicableCritical = new Set(scenario.criticalCheckIds);
    const checksPassed = checks.filter(({ passed }) => passed).length;
    const criticalPassed = checks.filter(
        ({ id, passed }) => passed && applicableCritical.has(id),
    ).length;
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
        usage: usage ?? ZERO_USAGE,
        /** Usage the provider never reported cannot be priced, so an unusable counter falls back to the same worst-case reserve a crashed rollout is charged. commentlint: allow(JUDGE) */
        costUsd: usage === null
            ? Math.max(reserveUsd, worstCaseUsd(scenario, options.pricesPerMillionTokens))
            : tokenCostUsd(usage, options.pricesPerMillionTokens),
        priorAttemptsCostUsd,
        costSource: usage === null ? "estimated" : "observed",
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
    priorAttemptsCostUsd: number,
    disposalFailed: boolean,
): RolloutRecord {
    /** Reported ahead of the rollout's own failure for the same reason the status is: a timeout bounded this arm, an unreclaimed harness threatens the ones after it. commentlint: allow(JUDGE) */
    const providerUnavailable = !disposalFailed && failure instanceof ProviderUnavailableError;
    const deadlineExceeded = !disposalFailed && failure instanceof RolloutDeadlineError;
    const worstCase = worstCaseUsd(scenario, options.pricesPerMillionTokens);
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
        usage: ZERO_USAGE,
        costUsd: providerUnavailable ? reserveUsd : Math.max(reserveUsd, worstCase),
        priorAttemptsCostUsd,
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
    const ids = scenario.checks;
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

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

/** An observation crosses a process boundary, so its counters are untrusted: a missing field or a `NaN` makes `tokenCostUsd` return `NaN`, which turns `spentUsd` into `NaN` and makes every later cost-cap comparison false. JSON also serializes a non-finite number as `null`, so the corruption would survive into the next resume. commentlint: allow(JUDGE) */
function finiteUsage(usage: TokenUsage): TokenUsage | null {
    const counters = [usage?.input, usage?.output, usage?.cacheCreation, usage?.cacheRead];
    if (counters.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        return null;
    }
    return {
        input: usage.input,
        output: usage.output,
        cacheCreation: usage.cacheCreation,
        cacheRead: usage.cacheRead,
    };
}

/** Prices a rollout whose real usage is unknown at the scenario's context limit in and out. commentlint: allow(JUDGE) */
function worstCaseUsd(scenario: ScenarioDeclaration, prices: TokenPrices): number {
    return tokenCostUsd(
        {
            input: scenario.modelContextLimit,
            output: scenario.modelContextLimit,
            cacheCreation: 0,
            cacheRead: 0,
        },
        prices,
    );
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

/** Resolves false when a late handle could not be reclaimed. A creation that never settles is bounded by `LATE_DISPOSAL_GRACE_MS` because the deadline it already missed is the reason it is being abandoned. commentlint: allow(JUDGE) */
async function disposeLateHandle(creation: Promise<RolloutHandle>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"unreclaimed">((resolve) => {
        timer = setTimeout(() => resolve("unreclaimed"), LATE_DISPOSAL_GRACE_MS);
    });
    try {
        const outcome = await Promise.race([
            creation.then(
                async (handle) => {
                    await handle.dispose();
                    return "reclaimed" as const;
                },
                () => "reclaimed" as const,
            ),
            grace,
        ]);
        return outcome === "reclaimed";
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
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
