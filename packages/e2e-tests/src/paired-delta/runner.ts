import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { publishJsonAtomically } from "../atomic-publish";
import { HoldoutContractError } from "../prospective-holdout/contract";
import { acquireRecoverableLock } from "../prospective-holdout/lock";
import {
    ARM_IDS,
    PRIMARY_ARM_IDS,
    PairedDeltaContractError,
    parseArmedCellResult,
    r3PromptEvidence,
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
    /** The dearest single attempt at this coordinate. The reserve needs the price of one call, which a sum of several cheap failures overstates. commentlint: allow(JUDGE) */
    maxAttemptCostUsd: number;
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
    const fixtureRoute = { providerId: "mock-anthropic", modelId: "mock-sonnet" };
    /** The gate exists to prove two distinct routes resolve independently. A live route equal to the fixture route makes the check pass while every supposedly live rollout can run on the fixture provider. commentlint: allow(JUDGE) */
    if (
        input.liveProviderId === fixtureRoute.providerId &&
        input.liveModelId === fixtureRoute.modelId
    ) {
        throw new Error(
            "dual-mock live route duplicates the fixture route " +
                `${fixtureRoute.providerId}/${fixtureRoute.modelId}`,
        );
    }
    const routes = [
        fixtureRoute,
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
        for (const [label, value] of [
            ["prior-attempts-cost", record.priorAttemptsCostUsd],
            ["max-attempt-cost", record.maxAttemptCostUsd],
        ] as const) {
            if (!Number.isFinite(value) || (value as number) < 0) fail(`${label}-invalid`);
        }
        if (record.costSource !== "observed" && record.costSource !== "estimated") {
            fail("cost-source-invalid");
        }
        /** `parseArmedCellResult` is the contract's own validator, so the store cannot drift from it: it enforces the cross-field rules a local copy kept missing — `criticalTotal <= checksTotal`, `criticalPassed <= checksPassed`, a reason code exactly when the health is not completed, and the reason-to-health pairings `REASON_CODE_HEALTHS` admits. commentlint: allow(JUDGE) */
        const armedCell = ((): ArmedCellResult => {
            try {
                return parseArmedCellResult(record.cell);
            } catch (error) {
                if (!(error instanceof PairedDeltaContractError)) throw error;
                return fail(`cell-invalid: ${error.diagnostics.join(",")}`);
            }
        })();
        if (armedCell.armId !== record.armId) fail("cell-invalid: arm-mismatch");
        if (typeof record.harnessDisposed !== "boolean") {
            fail("harness-disposed-invalid");
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
        const vector = checks as CheckResult[];
        /** A completed record suppresses its live rollout, so its counts must agree with the vector stored beside them: `parseArmedCellResult` validates the cell alone and cannot see the checks. commentlint: allow(JUDGE) */
        if (armedCell.runHealth === "completed") {
            if (
                /** A live record sets this flag only for a claimed success that failed a critical check, so the combination cannot have been produced by a run and would inflate invalid-success counts. commentlint: allow(JUDGE) */
                (armedCell.invalidSuccess && armedCell.criticalPassed >= armedCell.criticalTotal) ||
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

/** Two runners over one records path each cache the pre-run array and publish a private snapshot, so the later rename erases the other's record after both paid calls happened — and the erased spend is then repeated on resume. The lock is taken before the first read, because by the time a write conflicts the money is already gone. commentlint: allow(JUDGE) */
export class RolloutStoreBusyError extends Error {}

/** Read-only stores never claim ownership, so inspecting a records file never conflicts with the run that owns it. commentlint: allow(JUDGE) */
const ownedRecordPaths = new Set<string>();


export class FileRolloutStore implements RolloutStore {
    private records: RolloutRecord[] | null = null;
    private indexByCoordinate = new Map<string, number>();
    private readonly lockPath: string;
    private readonly claim: string;
    private readonly readOnly: boolean;
    private held: { release(): void } | null = null;
    private readonly releaseOnExit = () => this.release();

    constructor(private readonly path: string, options?: { readOnly?: boolean }) {
        this.lockPath = `${path}.lock`;
        this.claim = resolve(path);
        this.readOnly = options?.readOnly === true;
    }

    list(): RolloutRecord[] {
        this.acquire();
        try {
            return [...this.load()];
        } catch (error) {
            /** A records file this store cannot parse leaves nothing to release the claim: the run throws, and only an explicit `release()` — which the caller never reaches — would free the path for the corrected retry. commentlint: allow(JUDGE) */
            this.release();
            throw error;
        }
    }

    /** Removes this process's claim on the records path. Safe to call when no lock is held. commentlint: allow(JUDGE) */
    release(): void {
        const held = this.held;
        if (held === null) return;
        this.held = null;
        ownedRecordPaths.delete(this.claim);
        process.off("exit", this.releaseOnExit);
        held.release();
    }

    private acquire(): void {
        /** A read-only store observes the file without claiming it, so a report or an assertion can read records the owning run is still writing. commentlint: allow(JUDGE) */
        if (this.readOnly || this.held !== null) return;
        /** `acquireRecoverableLock`'s nonce is per module, not per instance, so a second store in this process would read its own nonce back and believe it owns the lock. commentlint: allow(JUDGE) */
        if (ownedRecordPaths.has(this.claim)) {
            throw new RolloutStoreBusyError(
                `rollout store ${this.path} is already owned in this process`,
            );
        }
        /** The records path's directory is created by the first publish, so the lock cannot assume it exists. commentlint: allow(JUDGE) */
        mkdirSync(dirname(this.lockPath), { recursive: true });
        try {
            this.held = acquireRecoverableLock(this.lockPath, {
                busyCode: `rollout-store-busy:${this.path}`,
            });
        } catch (error) {
            if (error instanceof HoldoutContractError) {
                throw new RolloutStoreBusyError(`rollout store ${this.path} is in use`);
            }
            throw error;
        }
        ownedRecordPaths.add(this.claim);
        process.on("exit", this.releaseOnExit);
    }

    put(record: RolloutRecord): void {
        if (this.readOnly) {
            throw new Error(`rollout store ${this.path} was opened read-only`);
        }
        this.acquire();
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

/** Completed evidence must be scorable against the declaration it is standing in for, so the vector is revalidated and its aggregates recomputed rather than trusted from the file. The script fingerprint and intervention are compared here as well: only the regret ladder reaches `computeRegretRungs`, so a primary record would otherwise carry a drifted declaration straight into the analysis. A record that cannot show its harness was reclaimed is refused for the same reason a live one is. commentlint: allow(JUDGE) */
function resumableEvidence(record: RolloutRecord, scenario: ScenarioDeclaration): boolean {
    if (record.harnessDisposed !== true) return false;
    if (record.baseScriptFingerprint !== baseScriptFingerprint(scenario)) return false;
    const declared = interventionFingerprint(interventionFor(scenario, record.armId));
    if (declared === null || interventionFingerprint(record.intervention) !== declared) {
        return false;
    }
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

/** Every rejection here describes an experiment that cannot produce the measurements it would report: an empty matrix, a cap no comparison can trip, or a price that makes a cost unwritable. commentlint: allow(JUDGE) */
function validateRunOptions(options: RunPairedDeltaOptions): void {
    if (options.scenarios.length === 0) {
        throw new Error("scenarios must not be empty");
    }
    const ids = new Set(options.scenarios.map(({ scenarioId }) => scenarioId));
    /** The loop visits every declaration while the coordinate map is keyed by id, so a repeated id would pay for a coordinate the store already holds completed evidence for and then fail to record it. commentlint: allow(JUDGE) */
    if (ids.size !== options.scenarios.length) {
        throw new Error("scenarios contain a duplicate scenarioId");
    }
    /** A non-positive or fractional count silently produces a matrix with no measurements — or one the loop rounds up — and the run would still report `completed`. commentlint: allow(JUDGE) */
    if (!Number.isSafeInteger(options.replicateCount) || options.replicateCount < 1) {
        throw new Error("replicateCount must be a positive integer");
    }
    /** A negative price makes a rollout's cost negative, which subtracts from `spentUsd` and lets the cap admit calls after the real spend passed it. commentlint: allow(JUDGE) */
    if (
        Object.values(options.pricesPerMillionTokens).some(
            (price) => !Number.isFinite(price) || price < 0,
        )
    ) {
        throw new Error("pricesPerMillionTokens must be finite and non-negative");
    }
    /** Every cap comparison against `NaN` is false, so an unchecked cap pays for the whole matrix; the same holds for the deadline's remaining-time test. commentlint: allow(JUDGE) */
    for (const [label, value] of [
        ["maxCostUsd", options.maxCostUsd],
        ["deskCostCeilingUsd", options.deskCostCeilingUsd],
    ] as const) {
        if (!Number.isFinite(value) || value < 0) {
            throw new Error(`${label} must be finite and non-negative`);
        }
    }
    if (!Number.isFinite(options.deadlineEpochMs)) {
        throw new Error("deadlineEpochMs must be finite");
    }
    /** The failure estimate is priced from a scenario's context limit, so a price that is finite on its own can still make the fallback `Infinity`, which JSON writes as `null` and the next resume rejects. commentlint: allow(JUDGE) */
    for (const scenario of options.scenarios) {
        if (!Number.isFinite(worstCaseUsd(scenario, options.pricesPerMillionTokens))) {
            throw new Error(
                `pricesPerMillionTokens overflow the worst-case estimate for ${scenario.scenarioId}`,
            );
        }
    }
}

export async function runPairedDelta(
    options: RunPairedDeltaOptions,
    dependencies: RunnerDependencies,
): Promise<PairedDeltaRunResult> {
    /** Option-only validation runs before `store.list()`, which claims the records path for this process: a call rejected after that claim would leave the path owned until exit and fail the corrected retry with `RolloutStoreBusyError`. commentlint: allow(JUDGE) */
    validateRunOptions(options);
    const stored = options.store.list();
    const storedByCoordinate = new Map(
        stored.map((record) => [coordinateKey(record), record]),
    );
    const records: RolloutRecord[] = [];
    const coordinates: CoordinateResult[] = [];
    const invalidStoredCoordinates: RolloutCoordinate[] = [];
    let spentUsd = 0;
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
        /** The reserve is the expected price of the next single call, so it takes the dearest attempt this coordinate has seen — not the cumulative total, which several cheap failures would inflate into a budget the next rollout cannot fit. commentlint: allow(JUDGE) */
        reserveUsd = Math.max(reserveUsd, record.costUsd, record.maxAttemptCostUsd);
        spentUsd += record.priorAttemptsCostUsd + record.costUsd;
        /** A stored attempt means this matrix has already started, whatever it was billed: a zero-cost first arm would otherwise keep the first-rollout exemption and let the next arm start with the reserve already over budget. commentlint: allow(JUDGE) */
        startedAny = true;
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
            /** A completed record from another binding cannot be replaced and the coordinate key carries no binding, so any arm executed beside it could never form a valid comparison; the coordinate stops rather than paying for evidence it cannot use. commentlint: allow(JUDGE) */
            let coordinateBlocked = false;
            const runArm = async (armId: ArmId): Promise<RolloutRecord | null> => {
                /** Checked before anything is created: a blocked coordinate can be reached from the ladder as well as the primary loop, and the caller's own check runs only after this call would have paid. commentlint: allow(JUDGE) */
                if (coordinateBlocked) return null;
                const coordinate: RolloutCoordinate = {
                    poolManifestFingerprint: options.poolManifestFingerprint,
                    scenarioId: scenario.scenarioId,
                    armId,
                    replicateIndex,
                };
                const existing = storedByCoordinate.get(coordinateKey(coordinate));
                const boundToRun = existing !== undefined && bindingMatches(existing, options);
                if (existing) {
                    if (!boundToRun || !completedIdentityMatches(existing, options)) {
                        /** Only completed evidence is immutable: `put` replaces a non-completed record, so a failure left by another commit or model is re-run rather than abandoning the coordinate and leaving the comparison incomplete. commentlint: allow(JUDGE) */
                        if (existing.cell.runHealth === "completed") {
                            invalidStoredCoordinates.push(coordinate);
                            coordinateBlocked = true;
                            return null;
                        }
                    }
                    // Completed records are immutable evidence; re-executing
                    // one would pay for a rollout whose result the store must
                    // then discard.
                    /** A stored vector is only unique strings to the parser, which has no declaration; an id set that does not belong to this scenario would be rehydrated as evidence and can leave `score()` dividing by an empty selection. commentlint: allow(JUDGE) */
                    if (
                        boundToRun && isResumable(existing, options) &&
                        !resumableEvidence(existing, scenario)
                    ) {
                        invalidStoredCoordinates.push(coordinate);
                        coordinateBlocked = true;
                        return null;
                    }
                    if (boundToRun && isResumable(existing, options)) {
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
                /** The previous attempt's spend is retained on the replacement record because `put` keeps one record per coordinate, so the file a later resume reads would otherwise show only the last attempt. commentlint: allow(JUDGE) */
                /** Only spend on this run's own binding carries forward; an attempt priced under a different commit or model was never charged to this run's ledger. commentlint: allow(JUDGE) */
                const priorAttemptsCostUsd = existing && boundToRun
                    ? existing.priorAttemptsCostUsd + existing.costUsd
                    : 0;
                const priorMaxAttemptCostUsd = existing && boundToRun
                    ? Math.max(existing.maxAttemptCostUsd, existing.costUsd)
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
                        /** A `dispose()` that never settles would hold the run open with the paid record unwritten, so cleanup is bounded like a late handle's and a hang is reported as an unreclaimed harness rather than waited on. commentlint: allow(JUDGE) */
                        const outcome = await settleDisposal(handle);
                        if (outcome === "reclaimed") disposed = true;
                        else {
                            /** A harness left running outranks whatever ended the rollout: the deadline only bounded this arm, while an unreclaimed harness threatens every arm after it. commentlint: allow(JUDGE) */
                            disposalFailed = true;
                            failure ??= outcome.error;
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
                        priorMaxAttemptCostUsd,
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
                        priorMaxAttemptCostUsd,
                        disposalFailed,
                    );
                options.store.put(record);
                records.push(record);
                coordinateResult.cells[armId] = record;
                spentUsd += record.costUsd;
                reserveUsd = Math.max(reserveUsd, record.costUsd);
                /** A harness that would not dispose may still be holding its workspace and session, so the next arm would measure a contaminated environment; the run ends rather than producing arms whose comparison cannot be trusted. commentlint: allow(JUDGE) */
                if (disposalFailed) status = "harness-unreclaimed";
                else if (failure instanceof RolloutDeadlineError) status = "deadline-reached";
                return record;
            };

            for (const armId of PRIMARY_ARM_IDS) {
                const record = await runArm(armId);
                if (coordinateBlocked) {
                    coordinateResult.incomplete = true;
                    break;
                }
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
                    if (coordinateBlocked) {
                        coordinateResult.incomplete = true;
                        break;
                    }
                    if (status !== "completed") {
                        coordinateResult.incomplete = true;
                        coordinateResult.regret = computeRegretRungs(
                            scenario,
                            coordinateResult.cells,
                            fingerprint,
                        );
                        coordinates.push(coordinateResult);
                        break outer;
                    }
                    /** A rung that ran and failed stops the ladder as designed, but one that never ran — an invalid stored record — leaves the coordinate short of the evidence it claims, and only the primary arms feed the `incomplete` derivation below. commentlint: allow(JUDGE) */
                    if (rung === null) coordinateResult.incomplete = true;
                    if (rung?.cell.runHealth !== "completed") break;
                }
                coordinateResult.regret = computeRegretRungs(
                    scenario,
                    coordinateResult.cells,
                    fingerprint,
                );
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

    /** A cap or deadline stop invites a resume; unusable stored records forbid one until the file is inspected, so the stronger warning wins. An unreclaimed harness outranks both, because a live process has to be dealt with before anything is rerun. commentlint: allow(JUDGE) */
    if (status !== "harness-unreclaimed" && invalidStoredCoordinates.length > 0) {
        status = "invalid-stored-records";
    }

    /** Derived from `records` at the end rather than counted along the way: every field they summarize already lives on each record, and a future path that pushes one — a new arm, another resume branch — cannot forget to update a counter it does not touch. commentlint: allow(JUDGE) */
    return {
        status,
        records,
        coordinates,
        spentUsd,
        reserveUsd,
        observedCostRollouts: records.filter(({ costSource }) => costSource === "observed").length,
        estimatedCostRollouts: records.filter(({ costSource }) => costSource === "estimated").length,
        resumedRollouts,
        invalidStoredCoordinates,
        exclusionCounts: exclusionCountsOf(records),
    };
}

function interventionFingerprint(value: unknown): string | null {
    try {
        return canonicalFingerprint(value);
    } catch {
        return null;
    }
}

/** The contract owns which health each reason may carry, and it exposes that as a validator rather than a table, so the pairing is discovered by asking `parseArmedCellResult` instead of restating its rules here: a narrowed admissible set, or a new reason code, changes this answer without an edit. `preferred` is tried first, so a reason admitting several healths keeps the one that describes how the rollout actually ended. commentlint: allow(JUDGE) */
function healthFor(reasonCode: ReasonCode | null, preferred: RunHealth): RunHealth {
    if (reasonCode === null) return "completed";
    const candidates = [
        preferred,
        ...RUN_HEALTHS.filter((health) => health !== "completed" && health !== preferred),
    ];
    return candidates.find((runHealth) => contractAdmits(reasonCode, runHealth)) ?? preferred;
}

function contractAdmits(reasonCode: ReasonCode, runHealth: RunHealth): boolean {
    try {
        parseArmedCellResult({
            armId: "mc-on",
            checksPassed: 0,
            checksTotal: 0,
            criticalPassed: 0,
            criticalTotal: 0,
            invalidSuccess: false,
            runHealth,
            reasonCode,
        });
        return true;
    } catch (error) {
        if (!(error instanceof PairedDeltaContractError)) throw error;
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
    priorMaxAttemptCostUsd: number,
    disposalFailed: boolean,
): RolloutRecord {
    const identityMatches =
        observation.echoedProviderId === options.pinnedProviderId &&
        observation.echoedModelId === options.pinnedSnapshotId;
    /** The intervention comes back from the rollout adapter, so it can hold a value `canonicalFingerprint` refuses; a throw here would escape `runArm` after the provider call and lose the paid coordinate instead of recording it. commentlint: allow(JUDGE) */
    const observedInterventionFingerprint = interventionFingerprint(observation.intervention);
    const declarationMatches = observation.baseScriptFingerprint === expectedFingerprint &&
        observedInterventionFingerprint !== null &&
        observedInterventionFingerprint === interventionFingerprint(expectedIntervention);
    const observedUsage = finiteUsage(observation.usage);
    /** The counters can be individually safe and still price beyond the float range once multiplied, so the computed cost is what has to be finite. commentlint: allow(JUDGE) */
    const observedCostUsd = observedUsage === null
        ? null
        : tokenCostUsd(observedUsage, options.pricesPerMillionTokens);
    const usage = observedCostUsd === null ||
            !Number.isFinite(observedCostUsd) ||
            observedCostUsd < 0
        ? null
        : observedUsage;
    /** Every field copied onto the record crosses the adapter boundary, and one value `JSON.stringify` refuses makes the whole record unwritable — which loses the paid coordinate instead of recording it as malformed. commentlint: allow(JUDGE) */
    const echoesAreStrings = (observation.echoedProviderId === null ||
        typeof observation.echoedProviderId === "string") &&
        (observation.echoedModelId === null || typeof observation.echoedModelId === "string");
    const shapeIsWritable = echoesAreStrings &&
        typeof observation.baseScriptFingerprint === "string" &&
        Number.isSafeInteger(observation.turns) &&
        (observation.turns as number) >= 0;
    /** These gates decide whether the rollout counts as evidence, and a JSON-derived `"false"` is truthy, so a non-boolean would pass the exclusion it is supposed to trip. commentlint: allow(JUDGE) */
    const gatesAreBoolean = typeof observation.absencePreconditionHeld === "boolean" &&
        typeof observation.armIdentityMatches === "boolean" &&
        typeof observation.claimedDone === "boolean";
    /** A harness that would not dispose may still be running and contaminating later arms, so its result cannot stand as evidence however well the rollout itself went. Non-finite usage is checked next because a cost derived from it would poison `spentUsd` for every later cap comparison. commentlint: allow(JUDGE) */
    let reasonCode: ReasonCode | null = disposalFailed
        ? "harness-failure"
        : usage === null || !gatesAreBoolean || !shapeIsWritable
            ? "invalid-result"
            : !observation.absencePreconditionHeld
                ? "absence-precondition-unmet"
                : !observation.armIdentityMatches || !identityMatches
                    ? "arm-identity-mismatch"
                    : !declarationMatches
                        ? "invalid-result"
                        : null;
    let runHealth: RunHealth = healthFor(reasonCode, reasonCode === "harness-failure"
        ? "crash"
        : "unavailable");
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
        echoedProviderId: echoesAreStrings ? observation.echoedProviderId : null,
        echoedModelId: echoesAreStrings ? observation.echoedModelId : null,
        baseScriptFingerprint: typeof observation.baseScriptFingerprint === "string"
            ? observation.baseScriptFingerprint
            : expectedFingerprint,
        /** A descriptor the canonicalizer refuses is also one `JSON.stringify` refuses, and the store must be able to write this record: an unwritable malformed record loses the paid coordinate. It is never read as evidence, because only completed records reach the regret comparison. commentlint: allow(JUDGE) */
        intervention: observedInterventionFingerprint === null
            ? expectedIntervention
            : observation.intervention,
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
        costUsd: usage === null || observedCostUsd === null
            ? Math.max(reserveUsd, worstCaseUsd(scenario, options.pricesPerMillionTokens))
            : observedCostUsd,
        priorAttemptsCostUsd,
        maxAttemptCostUsd: Math.max(priorMaxAttemptCostUsd, observedCostUsd ?? 0),
        costSource: usage === null ? "estimated" : "observed",
        wallClockMs,
        turns: Number.isSafeInteger(observation.turns) && observation.turns >= 0
            ? observation.turns
            : 0,
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
    priorMaxAttemptCostUsd: number,
    disposalFailed: boolean,
): RolloutRecord {
    /** Reported ahead of the rollout's own failure for the same reason the status is: a timeout bounded this arm, an unreclaimed harness threatens the ones after it. commentlint: allow(JUDGE) */
    const providerUnavailable = !disposalFailed && failure instanceof ProviderUnavailableError;
    const deadlineExceeded = !disposalFailed && failure instanceof RolloutDeadlineError;
    const reasonCode: ReasonCode = providerUnavailable
        ? "provider-unavailable"
        : deadlineExceeded
            ? "deadline-exceeded"
            : "harness-failure";
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
            runHealth: healthFor(
                reasonCode,
                providerUnavailable ? "unavailable" : deadlineExceeded ? "timeout" : "crash",
            ),
            reasonCode,
        },
        checks: [],
        usage: ZERO_USAGE,
        costUsd: providerUnavailable ? reserveUsd : Math.max(reserveUsd, worstCase),
        priorAttemptsCostUsd,
        maxAttemptCostUsd: Math.max(
            priorMaxAttemptCostUsd,
            providerUnavailable ? reserveUsd : Math.max(reserveUsd, worstCase),
        ),
        costSource: "estimated",
        wallClockMs,
        turns: 0,
        harnessDisposed,
    };
}

export function computeRegretRungs(
    scenario: ScenarioDeclaration,
    records: Partial<Record<ArmId, RolloutRecord>>,
    /** The run computes this once per scenario; recomputing it hashes the whole turn script again on every coordinate whose ladder fires. commentlint: allow(JUDGE) */
    scriptFingerprint = baseScriptFingerprint(scenario),
): RegretRungs {
    const completed = REGRET_ARM_IDS.map((armId) => records[armId]).filter(
        (record): record is RolloutRecord => record?.cell.runHealth === "completed",
    );
    const expectedFingerprint = scriptFingerprint;
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
    /** Safe integers rather than merely finite ones: a counter near `Number.MAX_VALUE` prices to `Infinity`, which JSON writes as `null` and the next resume rejects as `cost-invalid`. commentlint: allow(JUDGE) */
    if (counters.some((value) => !Number.isSafeInteger(value) || (value as number) < 0)) {
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

function exclusionCountsOf(
    records: readonly RolloutRecord[],
): PairedDeltaRunResult["exclusionCounts"] {
    const counts: PairedDeltaRunResult["exclusionCounts"] = {};
    for (const { armId, cell } of records) {
        if (cell.reasonCode === null) continue;
        const byReason = counts[armId] ??= {};
        byReason[cell.reasonCode] = (byReason[cell.reasonCode] ?? 0) + 1;
    }
    return counts;
}

function coordinateKey(coordinate: RolloutCoordinate): string {
    return [
        coordinate.poolManifestFingerprint,
        coordinate.scenarioId,
        coordinate.armId,
        coordinate.replicateIndex,
    ].join(":");
}

/** Resolves `"reclaimed"`, or the failure that prevented it, bounded by `LATE_DISPOSAL_GRACE_MS` so a `dispose()` that never settles cannot hold the run open. commentlint: allow(JUDGE) */
async function settleDisposal(
    handle: RolloutHandle,
): Promise<"reclaimed" | { error: unknown }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<{ error: unknown }>((resolve) => {
        timer = setTimeout(
            () => resolve({ error: new Error("harness disposal did not settle") }),
            LATE_DISPOSAL_GRACE_MS,
        );
    });
    try {
        return await Promise.race([
            handle.dispose().then(() => "reclaimed" as const, (error: unknown) => ({ error })),
            grace,
        ]);
    } finally {
        clearTimeout(timer);
    }
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
