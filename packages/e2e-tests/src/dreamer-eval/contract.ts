import { makeContractPrimitives } from "../contract-primitives";
import { ANTI_MEMORY_CATEGORY } from "../../../plugin/src/features/magic-context/memory/constants";
import { VERIFY_UPDATE_CONTENT_MAX_LENGTH } from "../../../plugin/src/features/magic-context/dreamer/verify";
import { hasShareabilitySensitiveText } from "../../../plugin/src/shared/redaction";

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

/**
 * Sole decision point for the run-fatal (exit 2) class. Report validation, the
 * scorer, and the mutation battery all route through this, so extending
 * RUN_FATAL_FAIL_REASONS changes every consumer at once.
 */
export function isRunFatal(status: DreamerRunStatus, reason: ErrorReason | FailReason | null): boolean {
    return (
        status === "FAIL" &&
        reason !== null &&
        (RUN_FATAL_FAIL_REASONS as readonly string[]).includes(reason)
    );
}

export const CLAIM_SCOPES = ["project", "ecosystem", "universe"] as const;
export type ClaimScope = (typeof CLAIM_SCOPES)[number];

export const VERIFY_VERDICTS = ["verified", "update", "archive"] as const;
export type VerifyVerdict = (typeof VERIFY_VERDICTS)[number];

export const VERIFICATION_OUTCOMES = ["verified", "update", "archive", "stale", "flagged"] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

const SCENARIO_ID_RE = /^dme-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLAIM_ID_RE = /^claim-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_ID_RE = /^run-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * A full Git object ID is 40 hexadecimal characters under SHA-1 and 64 under
 * SHA-256, with nothing in between. Accepting the intermediate lengths would let
 * a report name a commit that cannot exist, so the recorded source revision
 * could not be checked out or verified.
 */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Lowest verification timestamp the seeder can build a fixture around.
 * `prepareFixtureRepository` derives the fixture commit time as the earliest
 * verification minus 2_000 ms and rejects a non-positive result as
 * `fixture-drift`, so anything at or below 2_000 describes a scenario that can
 * never reach preflight or scoring.
 */
const MIN_VERIFIED_AT_MS = 2_001;

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

/**
 * Provider bytes verbatim, with `null` reserved for "nothing was captured".
 * `string` rejects a blank value, but a blank or whitespace-only manifest is
 * exactly what every scorer records as `ERROR:provider-failure`, so that
 * evidence has to round-trip through the report instead of collapsing into the
 * absence case and losing the distinction.
 */
function nullableRawText(value: unknown, label: string): string | null {
    if (value === null) return null;
    if (typeof value !== "string") fail(`${label}: string-invalid`);
    return value as string;
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

export interface MappingPrecondition {
    claimId: string;
    files: string[];
}

export interface VerificationPrecondition {
    claimId: string;
    outcome: VerificationOutcome;
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
    /**
     * Backing set the manifest must report. Verification applies this attribute
     * as the claim's new exact mapping, so it is scored rather than ignored; it
     * may differ from the pool's current mapping when a fixture models a file
     * that moved. An archive verdict carries no mapping.
     */
    expectedFiles: string[];
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
    pool: { claims: ScenarioClaim[] };
    tasks: DreamerTaskScenario[];
}

function parseStringArray(raw: unknown, label: string): string[] {
    const values = array(raw, label).map((entry, index) => string(entry, `${label}[${index}]`));
    unique(values, label);
    return values;
}

/**
 * A manifest carries file paths inside a comma-separated, double-quoted
 * attribute, and production splits that attribute on commas and trims each
 * entry. A path holding a comma, a quote, an angle bracket, or edge whitespace
 * therefore decodes as something other than what was authored, so no manifest
 * can ever report this path back and the scenario is unpassable by
 * construction.
 */
const UNREPRESENTABLE_PATH_RE = /[,"<>]/;

function parseFilePath(value: unknown, label: string): string {
    const path = string(value, label);
    if (path !== path.trim() || UNREPRESENTABLE_PATH_RE.test(path)) fail(`${label}: path-unrepresentable`);
    return path;
}

function parseFilePathArray(raw: unknown, label: string): string[] {
    const values = array(raw, label).map((entry, index) => parseFilePath(entry, `${label}[${index}]`));
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
    return { path: parseFilePath(value.path, `${label}.path`), content: string(value.content, `${label}.content`) };
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
    const category = string(value.category, `${label}.category`);
    // The generic claim writer refuses the anti-memory category, and the typed
    // writer that accepts it needs a structured payload this scenario shape does
    // not carry, so such a claim fails during seeding rather than at authoring.
    if (category === ANTI_MEMORY_CATEGORY) fail(`${label}.category: unsupported`);
    const hygieneVisible = boolean(value.hygieneVisible, `${label}.hygieneVisible`);
    // Hygiene visibility follows from a claim's dispositions, and no seeding
    // step produces the dispositions that hide one. A false value would declare
    // a pool the hygiene lane cannot reproduce: the read returns every active
    // row, so the task fails its gate assertion instead of running.
    if (!hygieneVisible) fail(`${label}.hygieneVisible: unsupported`);
    return {
        id: staticId(value.id, `${label}.id`, CLAIM_ID_RE),
        content: string(value.content, `${label}.content`),
        category,
        importance: boundedInteger(value.importance, `${label}.importance`, 1, 100),
        memoryScope: enumeration(value.memoryScope, CLAIM_SCOPES, `${label}.memoryScope`),
        sharing: enumeration(value.sharing, ["private", "shareable"], `${label}.sharing`),
        hygieneVisible,
        fileIndependent,
        fixtureFiles,
    };
}

function assertKnownClaim(claimId: string, poolIds: ReadonlySet<string>, label: string): void {
    if (!poolIds.has(claimId)) fail(`${label}: unknown-claim`);
}

function parsePreconditions(raw: unknown, label: string, pool: ReadonlyMap<string, ScenarioClaim>): TaskPreconditions {
    const value = record(raw, label);
    exact(value, ["mappings", "verifications", "classifiedClaimIds"], label);
    const poolIds = new Set(pool.keys());
    const mappings = array(value.mappings, `${label}.mappings`).map((entry, index) => {
        const itemLabel = `${label}.mappings[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["claimId", "files"], itemLabel);
        const claimId = staticId(item.claimId, `${itemLabel}.claimId`, CLAIM_ID_RE);
        const poolClaim = pool.get(claimId);
        if (poolClaim === undefined) return fail(`${itemLabel}.claimId: unknown-claim`);
        const files = parseFilePathArray(item.files, `${itemLabel}.files`);
        // The seeder applies a mapping only for a path the mapped claim itself
        // declares and rejects anything else as `fixture-drift`. This is
        // per-claim, unlike gold: a precondition states the claim's existing
        // mapping, so it cannot name another claim's file.
        const declared = new Set(poolClaim.fixtureFiles.map((file) => file.path));
        for (const [fileIndex, file] of files.entries()) {
            if (!declared.has(file)) fail(`${itemLabel}.files[${fileIndex}]: path-undeclared`);
        }
        return { claimId, files };
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
            outcome: enumeration(item.outcome, VERIFICATION_OUTCOMES, `${itemLabel}.outcome`),
            verifiedAt: integer(item.verifiedAt, `${itemLabel}.verifiedAt`, MIN_VERIFIED_AT_MS),
        };
    });
    unique(verifications.map((entry) => entry.claimId), `${label}.verifications`);
    const classifiedClaimIds = parseClaimIdArray(value.classifiedClaimIds, `${label}.classifiedClaimIds`);
    for (const [index, claimId] of classifiedClaimIds.entries()) {
        assertKnownClaim(claimId, poolIds, `${label}.classifiedClaimIds[${index}]`);
    }
    // The seeder applies mappings and verifications only, so a populated value
    // here would assert database state that no seeding step creates.
    if (classifiedClaimIds.length > 0) fail(`${label}.classifiedClaimIds: unsupported`);
    return { mappings, verifications, classifiedClaimIds };
}

/**
 * Every path the seeder writes and commits, collected across the whole pool
 * rather than per claim: a fixture may model a file that moved, so one claim's
 * gold set can legitimately name a path another claim declares.
 */
function declaredFixturePaths(pool: ReadonlyMap<string, ScenarioClaim>): ReadonlySet<string> {
    const paths = new Set<string>();
    for (const claim of pool.values()) {
        for (const file of claim.fixtureFiles) paths.add(file.path);
    }
    return paths;
}

/**
 * Gold file sets are restricted to declared fixture paths. Production routes
 * manifest paths through `normalizeVerificationFiles`, which canonicalizes
 * tracked paths, drops untracked ones, and rejects the manifest when none
 * survives. Gold naming an untracked path (`src/ghost.ts`) or a noncanonical
 * alias of a tracked one (`src/./file.ts`) would therefore score a green run for
 * output the host cannot apply.
 */
function parseGoldFilePathArray(raw: unknown, label: string, declared: ReadonlySet<string>): string[] {
    const values = parseFilePathArray(raw, label);
    for (const [index, value] of values.entries()) {
        if (!declared.has(value)) fail(`${label}[${index}]: path-untracked`);
    }
    return values;
}

function parseVerifyGold(raw: unknown, label: string, pool: ReadonlyMap<string, ScenarioClaim>): ParsedLayerGold {
    const value = record(raw, label);
    exact(value, ["kind", "claims"], label);
    if (value.kind !== "verify") fail(`${label}.kind: task-gold-mismatch`);
    const declared = declaredFixturePaths(pool);
    const claims = array(value.claims, `${label}.claims`).map((entry, index) => {
        const itemLabel = `${label}.claims[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["claimId", "verdict", "expectedFiles", "requiredUpdateAnchors", "forbiddenUpdateAnchors"], itemLabel);
        const claimId = staticId(item.claimId, `${itemLabel}.claimId`, CLAIM_ID_RE);
        const poolClaim = pool.get(claimId);
        if (poolClaim === undefined) return fail(`${itemLabel}.claimId: unknown-claim`);
        if (poolClaim.fileIndependent) fail(`${itemLabel}.claimId: file-independent-verify`);
        const verdict = enumeration(item.verdict, VERIFY_VERDICTS, `${itemLabel}.verdict`);
        const expectedFiles = parseGoldFilePathArray(item.expectedFiles, `${itemLabel}.expectedFiles`, declared);
        if (verdict === "archive" && expectedFiles.length > 0) {
            fail(`${itemLabel}.expectedFiles: archive-has-files`);
        }
        if (verdict !== "archive" && expectedFiles.length === 0) {
            fail(`${itemLabel}.expectedFiles: retained-claim-has-no-file`);
        }
        const requiredUpdateAnchors = parseStringArray(item.requiredUpdateAnchors, `${itemLabel}.requiredUpdateAnchors`);
        const forbiddenUpdateAnchors = parseStringArray(item.forbiddenUpdateAnchors, `${itemLabel}.forbiddenUpdateAnchors`);
        // Passing content must contain every required anchor as a substring, so
        // it is at least as long as the longest one. Production and the scorer
        // both reject an update body over VERIFY_UPDATE_CONTENT_MAX_LENGTH, which
        // makes an anchor past that length unsatisfiable by any manifest. The
        // combined length is deliberately not checked: anchors may overlap
        // inside one body, so a sum over the cap does not prove impossibility.
        for (const [anchorIndex, anchor] of requiredUpdateAnchors.entries()) {
            if (anchor.length > VERIFY_UPDATE_CONTENT_MAX_LENGTH) {
                fail(`${itemLabel}.requiredUpdateAnchors[${anchorIndex}]: anchor-exceeds-content-cap`);
            }
        }
        // Anchors are scored only for an update verdict, so an anchor on any
        // other verdict states a requirement nothing enforces.
        if (verdict !== "update" && (requiredUpdateAnchors.length > 0 || forbiddenUpdateAnchors.length > 0)) {
            fail(`${itemLabel}: anchors-require-update`);
        }
        // Anchor checks are case-insensitive substring tests, so content holding
        // a required anchor also holds any forbidden anchor contained in it. Such
        // a pair demands content that both contains and omits the same text.
        const unsatisfiable = requiredUpdateAnchors.some((required) =>
            forbiddenUpdateAnchors.some((forbidden) => required.toLowerCase().includes(forbidden.toLowerCase())),
        );
        if (unsatisfiable) fail(`${itemLabel}: anchors-overlap`);
        return {
            claimId,
            verdict,
            expectedFiles,
            requiredUpdateAnchors,
            forbiddenUpdateAnchors,
        };
    });
    unique(claims.map((entry) => entry.claimId), `${label}.claims`);
    return { kind: "verify", claims };
}

function parseMapGold(raw: unknown, label: string, pool: ReadonlyMap<string, ScenarioClaim>): ParsedLayerGold {
    const value = record(raw, label);
    exact(value, ["kind", "claims"], label);
    if (value.kind !== "map") fail(`${label}.kind: task-gold-mismatch`);
    const declared = declaredFixturePaths(pool);
    const claims = array(value.claims, `${label}.claims`).map((entry, index) => {
        const itemLabel = `${label}.claims[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["claimId", "files", "independent"], itemLabel);
        const claimId = staticId(item.claimId, `${itemLabel}.claimId`, CLAIM_ID_RE);
        const poolClaim = pool.get(claimId);
        if (poolClaim === undefined) return fail(`${itemLabel}.claimId: unknown-claim`);
        const independent = boolean(item.independent, `${itemLabel}.independent`);
        if (independent !== poolClaim.fileIndependent) fail(`${itemLabel}.independent: pool-mismatch`);
        const files = parseGoldFilePathArray(item.files, `${itemLabel}.files`, declared);
        // A manifest reports either an independent claim or a file set, never
        // both, so the opposite pairing describes an outcome no correct model
        // response can produce.
        if (independent && files.length > 0) fail(`${itemLabel}.files: independent-has-files`);
        if (!independent && files.length === 0) fail(`${itemLabel}.files: mapped-claim-has-no-file`);
        return { claimId, files, independent };
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
        const poolClaim = pool.get(claimId);
        if (poolClaim === undefined) return fail(`${itemLabel}.claimId: unknown-claim`);
        const importanceLabel = `${itemLabel}.importance`;
        const importanceValue = record(item.importance, importanceLabel);
        exact(importanceValue, ["min", "max"], importanceLabel);
        const min = boundedInteger(importanceValue.min, `${importanceLabel}.min`, 1, 100);
        const max = boundedInteger(importanceValue.max, `${importanceLabel}.max`, 1, 100);
        if (min > max) fail(`${importanceLabel}: range-invalid`);
        const shareable = boolean(item.shareable, `${itemLabel}.shareable`);
        // `applyClassifications` forces shareable to false before writing the
        // revision whenever the claim content trips the same predicate, so gold
        // asking for shareable on sensitive content describes a pool the host
        // will never produce: the model's "true" would score PASS while the
        // stored claim came out private.
        if (shareable && hasShareabilitySensitiveText(poolClaim.content)) {
            fail(`${itemLabel}.shareable: shareability-override`);
        }
        return {
            claimId,
            importance: { min, max },
            scope: enumeration(item.scope, CLAIM_SCOPES, `${itemLabel}.scope`),
            shareable,
        };
    });
    unique(claims.map((entry) => entry.claimId), `${label}.claims`);
    return { kind: "classify", claims };
}

/**
 * Order- and duplicate-insensitive set equality. Duplicates collapse, so this
 * compares membership rather than sequence; callers that need positional
 * agreement must compare arrays directly.
 */
export function sameSet(left: readonly string[], right: readonly string[]): boolean {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function parseTask(raw: unknown, label: string, pool: ReadonlyMap<string, ScenarioClaim>): DreamerTaskScenario {
    const value = record(raw, label);
    exact(value, ["task", "preconditions", "expectedInScopeClaimIds", "expectedSkippedClaimIds", "expectedResultMode", "gold"], label);
    const task = enumeration(value.task, DREAMER_TASKS, `${label}.task`);
    const poolIds = new Set(pool.keys());
    const preconditions = parsePreconditions(value.preconditions, `${label}.preconditions`, pool);
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
    if (task === "verify-broad") {
        if (expectedResultMode !== "broad") fail(`${label}.expectedResultMode: broad-required`);
        // `seedDreamerEvalTask` cannot construct the broad-cycle watermark
        // without verification history and rejects such a task as
        // `fixture-drift`, so accepting one here would admit a scenario that can
        // never run.
        if (preconditions.verifications.length === 0) {
            fail(`${label}.preconditions.verifications: broad-requires-history`);
        }
    }
    // The seeder always git-inits the workdir, commits, and calls
    // partitionVerifyScope with forceBroad false. That path returns "broad" only
    // under forceBroad, never returns "non-git" at all, and returns "full" only
    // when git change-times are unavailable — which the seeder treats as
    // fixture drift. "incremental" is the one mode a healthy fixture produces,
    // so any other value here is a scenario that deterministically terminates
    // with gate-mismatch at preflight.
    if (task === "verify" && expectedResultMode !== "incremental") {
        fail(`${label}.expectedResultMode: verify-mode-unproducible`);
    }

    const gold = task === "verify" || task === "verify-broad"
        ? parseVerifyGold(value.gold, `${label}.gold`, pool)
        : task === "map-memories"
          ? parseMapGold(value.gold, `${label}.gold`, pool)
          : parseClassifyGold(value.gold, `${label}.gold`, pool);
    if (!sameSet(gold.claims.map((entry) => entry.claimId), expectedInScopeClaimIds)) fail(`${label}.gold.claims: in-scope-mismatch`);
    return {
        task,
        preconditions,
        expectedInScopeClaimIds,
        expectedSkippedClaimIds,
        expectedResultMode,
        gold,
    };
}

export function parseScenario(raw: unknown, label = "scenario"): DreamerEvalScenario {
    const root = record(raw, label);
    exact(root, ["schema", "id", "title", "pool", "tasks"], label);
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
    const tasks = array(root.tasks, `${label}.tasks`).map((entry, index) => parseTask(entry, `${label}.tasks[${index}]`, pool));
    if (tasks.length === 0) fail(`${label}.tasks: empty`);
    unique(tasks.map((task) => task.task), `${label}.tasks`);
    return {
        schema: DREAMER_EVAL_SCENARIO_SCHEMA,
        id: staticId(root.id, `${label}.id`, SCENARIO_ID_RE),
        title: string(root.title, `${label}.title`),
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
    verificationOutcome: VerificationOutcome | null;
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

/**
 * Parsed-manifest evidence exactly as the task's scorer produced it: verify
 * parses to one record of verdict lists, while map and classify parse to one
 * entry per claim. `object` is the widest compile-time bound that accepts every
 * scorer's interface-typed result without a cast, because an interface carries
 * no implicit index signature; `parseRunReport` is the gate that admits only a
 * non-array record or an array of records.
 */
export type ParsedManifestEvidence = object;

export interface ClaimOperationReceiptOutcome {
    claimId: string;
    operation: string;
    outcome: string;
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
    parsedManifest: ParsedManifestEvidence | null;
    receiptOutcomes: ClaimOperationReceiptOutcome[];
}

function parseSnapshot(raw: unknown, label: string): ClaimSnapshotProjection {
    const value = record(raw, label);
    exact(value, ["claimId", "publicClaimId", "revisionLocator", "content", "category", "importance", "memoryScope", "sharing", "lifecycleState", "files", "verificationOutcome"], label);
    const verificationOutcome = value.verificationOutcome === null
        ? null
        : enumeration(value.verificationOutcome, VERIFICATION_OUTCOMES, `${label}.verificationOutcome`);
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

/**
 * Sole snapshot-array parser. Pool descriptors and run reports carry the same
 * projection, so identity uniqueness is enforced here rather than per caller: a
 * repeated claim inflates any consumer that counts rows while a consumer that
 * keys by id silently retains one copy.
 */
function parseSnapshotArray(raw: unknown, label: string): ClaimSnapshotProjection[] {
    const claims = array(raw, label).map((entry, index) => parseSnapshot(entry, `${label}[${index}]`));
    unique(claims.map((claim) => claim.claimId), label);
    unique(claims.map((claim) => claim.publicClaimId), `${label}.publicClaimId`);
    return claims;
}

export function parsePoolDescriptor(raw: unknown, label = "pool"): PoolDescriptor {
    const value = record(raw, label);
    exact(value, ["schema", "scenarioId", "claims"], label);
    if (value.schema !== DREAMER_EVAL_POOL_SCHEMA) fail(`${label}.schema: version-invalid`);
    return {
        schema: DREAMER_EVAL_POOL_SCHEMA,
        scenarioId: staticId(value.scenarioId, `${label}.scenarioId`, SCENARIO_ID_RE),
        claims: parseSnapshotArray(value.claims, `${label}.claims`),
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

function parseManifestEvidence(value: unknown, label: string): ParsedManifestEvidence | null {
    if (value === null) return null;
    if (Array.isArray(value)) return array(value, label).map((entry, index) => record(entry, `${label}[${index}]`));
    return record(value, label);
}

/**
 * Whether both snapshots carry the same claim identities under the same public
 * bindings. Each array is already unique on both keys, so comparing sorted
 * pairs decides set equality; NUL joins the pair because neither identifier can
 * contain it.
 */
function sameIdentityBindings(
    before: readonly ClaimSnapshotProjection[],
    after: readonly ClaimSnapshotProjection[],
): boolean {
    if (before.length !== after.length) return false;
    const bindings = (claims: readonly ClaimSnapshotProjection[]) =>
        claims.map((claim) => `${claim.claimId}\u0000${claim.publicClaimId}`).sort();
    const left = bindings(before);
    const right = bindings(after);
    return left.every((binding, index) => binding === right[index]);
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
    if (runFatal !== isRunFatal(status, reason)) fail(`${label}.runFatal: mapping-invalid`);
    const poolBefore = parseSnapshotArray(root.poolBefore, `${label}.poolBefore`);
    const poolAfter = parseSnapshotArray(root.poolAfter, `${label}.poolAfter`);
    // No evaluated task creates, deletes, or rekeys a claim — archival shows up
    // as lifecycleState on the same row — so a completed run observes the same
    // identities before and after. Drift means the report either omitted an
    // affected claim or bound one claim's result to another identity, and each
    // silently corrupts a before/after comparison. An ERROR run is exempt: it
    // may have failed before capturing the pool, so a partial capture is the
    // honest record there.
    if (status !== "ERROR" && !sameIdentityBindings(poolBefore, poolAfter)) {
        fail(`${label}.poolAfter: identity-drift`);
    }
    const receiptOutcomes = array(root.receiptOutcomes, `${label}.receiptOutcomes`).map((entry, index) => {
        const itemLabel = `${label}.receiptOutcomes[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["claimId", "operation", "outcome"], itemLabel);
        return {
            claimId: staticId(item.claimId, `${itemLabel}.claimId`, CLAIM_ID_RE),
            operation: string(item.operation, `${itemLabel}.operation`),
            outcome: string(item.outcome, `${itemLabel}.outcome`),
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
        rawManifest: nullableRawText(root.rawManifest, `${label}.rawManifest`),
        parsedManifest: parseManifestEvidence(root.parsedManifest, `${label}.parsedManifest`),
        receiptOutcomes,
    };
}

export function dreamerEvalExitCode(report: DreamerEvalRunReport | readonly DreamerEvalRunReport[]): 0 | 1 | 2 {
    const reports = Array.isArray(report) ? report : [report];
    // Every valid scenario carries at least one task, so an empty aggregation
    // means no evaluation ran. Returning 0 for it would report success for a
    // selection that silently produced nothing.
    if (reports.length === 0) return 1;
    if (reports.some((entry) => entry.runFatal)) return 2;
    if (reports.some((entry) => entry.status !== "PASS")) return 1;
    return 0;
}
