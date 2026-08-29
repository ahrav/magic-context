import { makeContractPrimitives } from "../contract-primitives";

export const DREAMER_EVAL_SCENARIO_SCHEMA = "dreamer-eval-scenario/v1";
export const DREAMER_EVAL_POOL_SCHEMA = "dreamer-eval-pool/v1";
export const DREAMER_EVAL_REPORT_SCHEMA = "dreamer-eval-report/v1";

export const DREAMER_TASKS = ["verify", "verify-broad", "map-memories", "classify-memories"] as const;
export type DreamerTask = (typeof DREAMER_TASKS)[number];

export const VERIFY_RESULT_MODES = ["non-git", "full", "broad", "incremental"] as const;
export type VerifyResultMode = (typeof VERIFY_RESULT_MODES)[number];

export const ERROR_REASONS = [
    "gate-mismatch",
    "lease-lost",
    "fallback-engaged",
    "fixture-drift",
    "apply-not-applied",
    "wrong-result-mode",
    "output-length-capped",
    "provider-failure",
    "harness-failure",
] as const;
export type ErrorReason = (typeof ERROR_REASONS)[number];

export const FAIL_REASONS = [
    "wrong-archival",
    "missed-archival",
    "wrong-verdict",
    "wrong-update-content",
    "wrong-mapping",
    "wrong-independence",
    "wrong-classification",
    "invalid-output",
] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

export const RUN_FATAL_FAIL_REASONS = ["wrong-archival"] as const satisfies readonly FailReason[];

export function isRunFatalFailure(
    status: DreamerRunStatus,
    reason: ErrorReason | FailReason | null,
): boolean {
    return status === "FAIL" && RUN_FATAL_FAIL_REASONS.some((fatal) => fatal === reason);
}

export const CLAIM_SCOPES = ["project", "ecosystem", "universe"] as const;
export type ClaimScope = (typeof CLAIM_SCOPES)[number];

export const VERIFY_VERDICTS = ["verified", "update", "archive"] as const;
export type VerifyVerdict = (typeof VERIFY_VERDICTS)[number];

export const PRESSURE_ROLES = [
    "semantic-duplicate-pair",
    "near-duplicate-pair",
    "stale",
    "contradiction-pair",
    "false-fluent",
    "high-value-file-independent",
    "rejected-alternative",
    "branch-specific",
] as const;
export type PressureRole = (typeof PRESSURE_ROLES)[number];

const SCENARIO_ID_RE = /^dme-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLAIM_ID_RE = /^claim-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_ID_RE = /^run-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;

export class DreamerEvalContractError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: readonly string[]) {
        super([...diagnostics].sort().join("; "));
        this.diagnostics = [...diagnostics].sort();
    }
}

const primitives = makeContractPrimitives(DreamerEvalContractError);
const { fail, record, exact, string, staticId, enumeration, array, integer, unique } = primitives;

function boolean(value: unknown, label: string): boolean {
    if (typeof value !== "boolean") fail(`${label}: boolean-invalid`);
    return value as boolean;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
    const parsed = integer(value, label, minimum);
    if (parsed > maximum) fail(`${label}: integer-invalid`);
    return parsed;
}

function nullableString(value: unknown, label: string): string | null {
    return value === null ? null : string(value, label);
}

export interface FixtureFile {
    path: string;
    content: string;
}

export interface ScenarioClaim {
    id: string;
    content: string;
    category: string;
    importance: number;
    memoryScope: ClaimScope;
    sharing: "private" | "shareable";
    hygieneVisible: boolean;
    fileIndependent: boolean;
    fixtureFiles: FixtureFile[];
}

export interface ScenarioPressureRole {
    role: PressureRole;
    claimIds: string[];
}

export interface MappingPrecondition {
    claimId: string;
    files: string[];
}

export interface VerificationPrecondition {
    claimId: string;
    outcome: "verified" | "update" | "archive" | "stale" | "flagged";
    verifiedAt: number;
}

export interface TaskPreconditions {
    mappings: MappingPrecondition[];
    verifications: VerificationPrecondition[];
    classifiedClaimIds: string[];
}

export interface VerifyGoldClaim {
    claimId: string;
    verdict: VerifyVerdict;
    requiredUpdateAnchors: string[];
    forbiddenUpdateAnchors: string[];
}

export interface MapGoldClaim {
    claimId: string;
    files: string[];
    independent: boolean;
}

export interface ClassifyGoldClaim {
    claimId: string;
    importance: { min: number; max: number };
    scope: ClaimScope;
    shareable: boolean;
}

export type ParsedLayerGold =
    | { kind: "verify"; claims: VerifyGoldClaim[] }
    | { kind: "map"; claims: MapGoldClaim[] }
    | { kind: "classify"; claims: ClassifyGoldClaim[] };

export interface DreamerTaskScenario {
    task: DreamerTask;
    preconditions: TaskPreconditions;
    expectedInScopeClaimIds: string[];
    expectedSkippedClaimIds: string[];
    expectedResultMode: VerifyResultMode | null;
    gold: ParsedLayerGold;
}

export interface DreamerEvalScenario {
    schema: typeof DREAMER_EVAL_SCENARIO_SCHEMA;
    id: string;
    title: string;
    pressureRoles: ScenarioPressureRole[];
    pool: { claims: ScenarioClaim[] };
    tasks: DreamerTaskScenario[];
}

function parsePressureRoles(raw: unknown, label: string, poolIds: ReadonlySet<string>): ScenarioPressureRole[] {
    const roles = array(raw, label).map((entry, index) => {
        const itemLabel = `${label}[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["role", "claimIds"], itemLabel);
        const role = enumeration(item.role, PRESSURE_ROLES, `${itemLabel}.role`);
        const claimIds = parseClaimIdArray(item.claimIds, `${itemLabel}.claimIds`);
        const expectedCardinality = role.endsWith("-pair") ? 2 : 1;
        if (claimIds.length !== expectedCardinality) fail(`${itemLabel}.claimIds: role-cardinality-invalid`);
        for (const [claimIndex, claimId] of claimIds.entries()) {
            assertKnownClaim(claimId, poolIds, `${itemLabel}.claimIds[${claimIndex}]`);
        }
        return { role, claimIds };
    });
    unique(roles.map((entry) => entry.role), label);
    return roles;
}

function parseStringArray(raw: unknown, label: string): string[] {
    const values = array(raw, label).map((entry, index) => string(entry, `${label}[${index}]`));
    unique(values, label);
    return values;
}

function parseClaimIdArray(raw: unknown, label: string): string[] {
    const values = array(raw, label).map((entry, index) => staticId(entry, `${label}[${index}]`, CLAIM_ID_RE));
    unique(values, label);
    return values;
}

function parseFixtureFile(raw: unknown, label: string): FixtureFile {
    const value = record(raw, label);
    exact(value, ["path", "content"], label);
    return { path: string(value.path, `${label}.path`), content: string(value.content, `${label}.content`) };
}

function parseScenarioClaim(raw: unknown, label: string): ScenarioClaim {
    const value = record(raw, label);
    exact(
        value,
        ["id", "content", "category", "importance", "memoryScope", "sharing", "hygieneVisible", "fileIndependent", "fixtureFiles"],
        label,
    );
    const fixtureFiles = array(value.fixtureFiles, `${label}.fixtureFiles`).map((entry, index) =>
        parseFixtureFile(entry, `${label}.fixtureFiles[${index}]`),
    );
    unique(fixtureFiles.map((file) => file.path), `${label}.fixtureFiles`);
    const fileIndependent = boolean(value.fileIndependent, `${label}.fileIndependent`);
    if (fileIndependent && fixtureFiles.length > 0) fail(`${label}.fixtureFiles: independent-has-files`);
    if (!fileIndependent && fixtureFiles.length === 0) fail(`${label}.fixtureFiles: mapped-claim-has-no-file`);
    return {
        id: staticId(value.id, `${label}.id`, CLAIM_ID_RE),
        content: string(value.content, `${label}.content`),
        category: string(value.category, `${label}.category`),
        importance: boundedInteger(value.importance, `${label}.importance`, 1, 100),
        memoryScope: enumeration(value.memoryScope, CLAIM_SCOPES, `${label}.memoryScope`),
        sharing: enumeration(value.sharing, ["private", "shareable"], `${label}.sharing`),
        hygieneVisible: boolean(value.hygieneVisible, `${label}.hygieneVisible`),
        fileIndependent,
        fixtureFiles,
    };
}

function assertKnownClaim(claimId: string, poolIds: ReadonlySet<string>, label: string): void {
    if (!poolIds.has(claimId)) fail(`${label}: unknown-claim`);
}

function parsePreconditions(raw: unknown, label: string, poolIds: ReadonlySet<string>): TaskPreconditions {
    const value = record(raw, label);
    exact(value, ["mappings", "verifications", "classifiedClaimIds"], label);
    const mappings = array(value.mappings, `${label}.mappings`).map((entry, index) => {
        const itemLabel = `${label}.mappings[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["claimId", "files"], itemLabel);
        const claimId = staticId(item.claimId, `${itemLabel}.claimId`, CLAIM_ID_RE);
        assertKnownClaim(claimId, poolIds, `${itemLabel}.claimId`);
        return { claimId, files: parseStringArray(item.files, `${itemLabel}.files`) };
    });
    unique(mappings.map((entry) => entry.claimId), `${label}.mappings`);
    const verifications = array(value.verifications, `${label}.verifications`).map((entry, index) => {
        const itemLabel = `${label}.verifications[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["claimId", "outcome", "verifiedAt"], itemLabel);
        const claimId = staticId(item.claimId, `${itemLabel}.claimId`, CLAIM_ID_RE);
        assertKnownClaim(claimId, poolIds, `${itemLabel}.claimId`);
        return {
            claimId,
            outcome: enumeration(item.outcome, ["verified", "update", "archive", "stale", "flagged"], `${itemLabel}.outcome`),
            verifiedAt: integer(item.verifiedAt, `${itemLabel}.verifiedAt`),
        };
    });
    unique(verifications.map((entry) => entry.claimId), `${label}.verifications`);
    const classifiedClaimIds = parseClaimIdArray(value.classifiedClaimIds, `${label}.classifiedClaimIds`);
    for (const [index, claimId] of classifiedClaimIds.entries()) {
        assertKnownClaim(claimId, poolIds, `${label}.classifiedClaimIds[${index}]`);
    }
    return { mappings, verifications, classifiedClaimIds };
}

function parseVerifyGold(raw: unknown, label: string, pool: ReadonlyMap<string, ScenarioClaim>): ParsedLayerGold {
    const value = record(raw, label);
    exact(value, ["kind", "claims"], label);
    if (value.kind !== "verify") fail(`${label}.kind: task-gold-mismatch`);
    const claims = array(value.claims, `${label}.claims`).map((entry, index) => {
        const itemLabel = `${label}.claims[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["claimId", "verdict", "requiredUpdateAnchors", "forbiddenUpdateAnchors"], itemLabel);
        const claimId = staticId(item.claimId, `${itemLabel}.claimId`, CLAIM_ID_RE);
        const poolClaim = pool.get(claimId);
        if (poolClaim === undefined) return fail(`${itemLabel}.claimId: unknown-claim`);
        if (poolClaim.fileIndependent) fail(`${itemLabel}.claimId: file-independent-verify`);
        return {
            claimId,
            verdict: enumeration(item.verdict, VERIFY_VERDICTS, `${itemLabel}.verdict`),
            requiredUpdateAnchors: parseStringArray(item.requiredUpdateAnchors, `${itemLabel}.requiredUpdateAnchors`),
            forbiddenUpdateAnchors: parseStringArray(item.forbiddenUpdateAnchors, `${itemLabel}.forbiddenUpdateAnchors`),
        };
    });
    unique(claims.map((entry) => entry.claimId), `${label}.claims`);
    return { kind: "verify", claims };
}

function parseMapGold(raw: unknown, label: string, pool: ReadonlyMap<string, ScenarioClaim>): ParsedLayerGold {
    const value = record(raw, label);
    exact(value, ["kind", "claims"], label);
    if (value.kind !== "map") fail(`${label}.kind: task-gold-mismatch`);
    const claims = array(value.claims, `${label}.claims`).map((entry, index) => {
        const itemLabel = `${label}.claims[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["claimId", "files", "independent"], itemLabel);
        const claimId = staticId(item.claimId, `${itemLabel}.claimId`, CLAIM_ID_RE);
        const poolClaim = pool.get(claimId);
        if (poolClaim === undefined) return fail(`${itemLabel}.claimId: unknown-claim`);
        const independent = boolean(item.independent, `${itemLabel}.independent`);
        if (independent !== poolClaim.fileIndependent) fail(`${itemLabel}.independent: pool-mismatch`);
        return { claimId, files: parseStringArray(item.files, `${itemLabel}.files`), independent };
    });
    unique(claims.map((entry) => entry.claimId), `${label}.claims`);
    return { kind: "map", claims };
}

function parseClassifyGold(raw: unknown, label: string, pool: ReadonlyMap<string, ScenarioClaim>): ParsedLayerGold {
    const value = record(raw, label);
    exact(value, ["kind", "claims"], label);
    if (value.kind !== "classify") fail(`${label}.kind: task-gold-mismatch`);
    const claims = array(value.claims, `${label}.claims`).map((entry, index) => {
        const itemLabel = `${label}.claims[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["claimId", "importance", "scope", "shareable"], itemLabel);
        const claimId = staticId(item.claimId, `${itemLabel}.claimId`, CLAIM_ID_RE);
        if (!pool.has(claimId)) fail(`${itemLabel}.claimId: unknown-claim`);
        const importanceLabel = `${itemLabel}.importance`;
        const importanceValue = record(item.importance, importanceLabel);
        exact(importanceValue, ["min", "max"], importanceLabel);
        const min = boundedInteger(importanceValue.min, `${importanceLabel}.min`, 1, 100);
        const max = boundedInteger(importanceValue.max, `${importanceLabel}.max`, 1, 100);
        if (min > max) fail(`${importanceLabel}: range-invalid`);
        return {
            claimId,
            importance: { min, max },
            scope: enumeration(item.scope, CLAIM_SCOPES, `${itemLabel}.scope`),
            shareable: boolean(item.shareable, `${itemLabel}.shareable`),
        };
    });
    unique(claims.map((entry) => entry.claimId), `${label}.claims`);
    return { kind: "classify", claims };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry) => right.includes(entry));
}

function parseTask(raw: unknown, label: string, pool: ReadonlyMap<string, ScenarioClaim>): DreamerTaskScenario {
    const value = record(raw, label);
    exact(value, ["task", "preconditions", "expectedInScopeClaimIds", "expectedSkippedClaimIds", "expectedResultMode", "gold"], label);
    const task = enumeration(value.task, DREAMER_TASKS, `${label}.task`);
    const poolIds = new Set(pool.keys());
    const expectedInScopeClaimIds = parseClaimIdArray(value.expectedInScopeClaimIds, `${label}.expectedInScopeClaimIds`);
    const expectedSkippedClaimIds = parseClaimIdArray(value.expectedSkippedClaimIds, `${label}.expectedSkippedClaimIds`);
    for (const [index, claimId] of expectedInScopeClaimIds.entries()) assertKnownClaim(claimId, poolIds, `${label}.expectedInScopeClaimIds[${index}]`);
    for (const [index, claimId] of expectedSkippedClaimIds.entries()) assertKnownClaim(claimId, poolIds, `${label}.expectedSkippedClaimIds[${index}]`);
    if (expectedInScopeClaimIds.some((claimId) => expectedSkippedClaimIds.includes(claimId))) fail(`${label}: partition-overlap`);
    if (!sameSet([...expectedInScopeClaimIds, ...expectedSkippedClaimIds], [...poolIds])) fail(`${label}: partition-incomplete`);

    let expectedResultMode: VerifyResultMode | null;
    if (value.expectedResultMode === null) expectedResultMode = null;
    else expectedResultMode = enumeration(value.expectedResultMode, VERIFY_RESULT_MODES, `${label}.expectedResultMode`);
    if ((task === "map-memories" || task === "classify-memories") && expectedResultMode !== null) {
        fail(`${label}.expectedResultMode: task-mode-mismatch`);
    }
    if (task === "verify-broad" && expectedResultMode !== "broad") fail(`${label}.expectedResultMode: broad-required`);
    if (task === "verify" && expectedResultMode === null) fail(`${label}.expectedResultMode: verify-mode-required`);

    const gold = task === "verify" || task === "verify-broad"
        ? parseVerifyGold(value.gold, `${label}.gold`, pool)
        : task === "map-memories"
          ? parseMapGold(value.gold, `${label}.gold`, pool)
          : parseClassifyGold(value.gold, `${label}.gold`, pool);
    if (!sameSet(gold.claims.map((entry) => entry.claimId), expectedInScopeClaimIds)) fail(`${label}.gold.claims: in-scope-mismatch`);
    return {
        task,
        preconditions: parsePreconditions(value.preconditions, `${label}.preconditions`, poolIds),
        expectedInScopeClaimIds,
        expectedSkippedClaimIds,
        expectedResultMode,
        gold,
    };
}

export function parseScenario(raw: unknown, label = "scenario"): DreamerEvalScenario {
    const root = record(raw, label);
    exact(root, ["schema", "id", "title", "pressureRoles", "pool", "tasks"], label);
    if (root.schema !== DREAMER_EVAL_SCENARIO_SCHEMA) fail(`${label}.schema: version-invalid`);
    const poolValue = record(root.pool, `${label}.pool`);
    exact(poolValue, ["claims"], `${label}.pool`);
    const claims = array(poolValue.claims, `${label}.pool.claims`).map((entry, index) =>
        parseScenarioClaim(entry, `${label}.pool.claims[${index}]`),
    );
    if (claims.length > 50) fail(`${label}.pool.claims: count-invalid`);
    if (claims.filter((claim) => claim.hygieneVisible).length < 10) fail(`${label}.pool.claims: hygiene-visible-count-invalid`);
    unique(claims.map((claim) => claim.id), `${label}.pool.claims`);
    const pool = new Map(claims.map((claim) => [claim.id, claim]));
    const pressureRoles = parsePressureRoles(root.pressureRoles, `${label}.pressureRoles`, new Set(pool.keys()));
    const tasks = array(root.tasks, `${label}.tasks`).map((entry, index) => parseTask(entry, `${label}.tasks[${index}]`, pool));
    if (tasks.length === 0) fail(`${label}.tasks: empty`);
    unique(tasks.map((task) => task.task), `${label}.tasks`);
    return {
        schema: DREAMER_EVAL_SCENARIO_SCHEMA,
        id: staticId(root.id, `${label}.id`, SCENARIO_ID_RE),
        title: string(root.title, `${label}.title`),
        pressureRoles,
        pool: { claims },
        tasks,
    };
}

export function serializeScenario(scenario: DreamerEvalScenario): string {
    return `${JSON.stringify(scenario, null, 2)}\n`;
}

/** Claims current-state projection retained in pool descriptors and run records. */
export interface ClaimSnapshotProjection {
    claimId: string;
    publicClaimId: string;
    revisionLocator: string;
    content: string;
    category: string;
    importance: number;
    memoryScope: ClaimScope;
    sharing: "private" | "shareable";
    lifecycleState: "active" | "archived" | "retired";
    files: string[];
    verificationOutcome: "verified" | "update" | "archive" | "stale" | "flagged" | null;
}

export interface PoolDescriptor {
    schema: typeof DREAMER_EVAL_POOL_SCHEMA;
    scenarioId: string;
    claims: ClaimSnapshotProjection[];
}

export interface DreamerSystemTuple {
    repoCommitSha: string;
    bunVersion: string;
    opencodeVersion: string;
    modelId: string;
    parserImpl: "ts";
}

export type DreamerRunStatus = "PASS" | "FAIL" | "ERROR";

export interface ClaimOperationReceiptOutcome {
    requestDigest: string;
    operationKey: string;
    outcome: string;
    affectedClaimIds: string[];
}

export interface DreamerEvalRunReport {
    schema: typeof DREAMER_EVAL_REPORT_SCHEMA;
    scenarioId: string;
    task: DreamerTask;
    runId: string;
    nowMs: number;
    status: DreamerRunStatus;
    reason: ErrorReason | FailReason | null;
    runFatal: boolean;
    system: DreamerSystemTuple;
    poolBefore: ClaimSnapshotProjection[];
    poolAfter: ClaimSnapshotProjection[];
    rawManifest: string | null;
    parsedManifest: Record<string, unknown> | unknown[] | null;
    receiptOutcomes: ClaimOperationReceiptOutcome[];
}

function parseSnapshot(raw: unknown, label: string): ClaimSnapshotProjection {
    const value = record(raw, label);
    exact(value, ["claimId", "publicClaimId", "revisionLocator", "content", "category", "importance", "memoryScope", "sharing", "lifecycleState", "files", "verificationOutcome"], label);
    const verificationOutcome = value.verificationOutcome === null
        ? null
        : enumeration(value.verificationOutcome, ["verified", "update", "archive", "stale", "flagged"], `${label}.verificationOutcome`);
    return {
        claimId: staticId(value.claimId, `${label}.claimId`, CLAIM_ID_RE),
        publicClaimId: string(value.publicClaimId, `${label}.publicClaimId`),
        revisionLocator: string(value.revisionLocator, `${label}.revisionLocator`),
        content: string(value.content, `${label}.content`),
        category: string(value.category, `${label}.category`),
        importance: boundedInteger(value.importance, `${label}.importance`, 1, 100),
        memoryScope: enumeration(value.memoryScope, CLAIM_SCOPES, `${label}.memoryScope`),
        sharing: enumeration(value.sharing, ["private", "shareable"], `${label}.sharing`),
        lifecycleState: enumeration(value.lifecycleState, ["active", "archived", "retired"], `${label}.lifecycleState`),
        files: parseStringArray(value.files, `${label}.files`),
        verificationOutcome,
    };
}

export function parsePoolDescriptor(raw: unknown, label = "pool"): PoolDescriptor {
    const value = record(raw, label);
    exact(value, ["schema", "scenarioId", "claims"], label);
    if (value.schema !== DREAMER_EVAL_POOL_SCHEMA) fail(`${label}.schema: version-invalid`);
    const claims = array(value.claims, `${label}.claims`).map((entry, index) => parseSnapshot(entry, `${label}.claims[${index}]`));
    unique(claims.map((claim) => claim.claimId), `${label}.claims`);
    unique(claims.map((claim) => claim.publicClaimId), `${label}.claims.publicClaimId`);
    return {
        schema: DREAMER_EVAL_POOL_SCHEMA,
        scenarioId: staticId(value.scenarioId, `${label}.scenarioId`, SCENARIO_ID_RE),
        claims,
    };
}

function parseSystem(raw: unknown, label: string): DreamerSystemTuple {
    const value = record(raw, label);
    exact(value, ["repoCommitSha", "bunVersion", "opencodeVersion", "modelId", "parserImpl"], label);
    return {
        repoCommitSha: staticId(value.repoCommitSha, `${label}.repoCommitSha`, SHA_RE),
        bunVersion: string(value.bunVersion, `${label}.bunVersion`),
        opencodeVersion: string(value.opencodeVersion, `${label}.opencodeVersion`),
        modelId: string(value.modelId, `${label}.modelId`),
        parserImpl: enumeration(value.parserImpl, ["ts"], `${label}.parserImpl`),
    };
}

export function parseRunReport(raw: unknown, label = "report"): DreamerEvalRunReport {
    const root = record(raw, label);
    exact(root, ["schema", "scenarioId", "task", "runId", "nowMs", "status", "reason", "runFatal", "system", "poolBefore", "poolAfter", "rawManifest", "parsedManifest", "receiptOutcomes"], label);
    if (root.schema !== DREAMER_EVAL_REPORT_SCHEMA) fail(`${label}.schema: version-invalid`);
    const status = enumeration(root.status, ["PASS", "FAIL", "ERROR"], `${label}.status`);
    let reason: ErrorReason | FailReason | null = null;
    if (status === "PASS") {
        if (root.reason !== null) fail(`${label}.reason: pass-reason-invalid`);
    } else if (status === "ERROR") {
        reason = enumeration(root.reason, ERROR_REASONS, `${label}.reason`);
    } else {
        reason = enumeration(root.reason, FAIL_REASONS, `${label}.reason`);
    }
    const runFatal = boolean(root.runFatal, `${label}.runFatal`);
    if (runFatal !== isRunFatalFailure(status, reason)) fail(`${label}.runFatal: mapping-invalid`);
    const poolBefore = array(root.poolBefore, `${label}.poolBefore`).map((entry, index) => parseSnapshot(entry, `${label}.poolBefore[${index}]`));
    const poolAfter = array(root.poolAfter, `${label}.poolAfter`).map((entry, index) => parseSnapshot(entry, `${label}.poolAfter[${index}]`));
    const receiptOutcomes = array(root.receiptOutcomes, `${label}.receiptOutcomes`).map((entry, index) => {
        const itemLabel = `${label}.receiptOutcomes[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["requestDigest", "operationKey", "outcome", "affectedClaimIds"], itemLabel);
        return {
            requestDigest: staticId(item.requestDigest, `${itemLabel}.requestDigest`, /^[0-9a-f]{64}$/),
            operationKey: string(item.operationKey, `${itemLabel}.operationKey`),
            outcome: string(item.outcome, `${itemLabel}.outcome`),
            affectedClaimIds: parseClaimIdArray(item.affectedClaimIds, `${itemLabel}.affectedClaimIds`),
        };
    });
    return {
        schema: DREAMER_EVAL_REPORT_SCHEMA,
        scenarioId: staticId(root.scenarioId, `${label}.scenarioId`, SCENARIO_ID_RE),
        task: enumeration(root.task, DREAMER_TASKS, `${label}.task`),
        runId: staticId(root.runId, `${label}.runId`, RUN_ID_RE),
        nowMs: integer(root.nowMs, `${label}.nowMs`),
        status,
        reason,
        runFatal,
        system: parseSystem(root.system, `${label}.system`),
        poolBefore,
        poolAfter,
        rawManifest: nullableString(root.rawManifest, `${label}.rawManifest`),
        parsedManifest:
            root.parsedManifest === null
                ? null
                : Array.isArray(root.parsedManifest)
                  ? root.parsedManifest
                  : record(root.parsedManifest, `${label}.parsedManifest`),
        receiptOutcomes,
    };
}

export function dreamerEvalExitCode(report: DreamerEvalRunReport | readonly DreamerEvalRunReport[]): 0 | 1 | 2 {
    const reports = Array.isArray(report) ? report : [report];
    if (reports.some((entry) => entry.runFatal)) return 2;
    if (reports.some((entry) => entry.status !== "PASS")) return 1;
    return 0;
}
