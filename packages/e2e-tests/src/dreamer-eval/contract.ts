import { makeContractPrimitives } from "../contract-primitives";
import { ANTI_MEMORY_CATEGORY } from "../../../plugin/src/features/magic-context/memory/constants";
import {
    isValidPublicClaimId,
    parseRevisionLocator,
} from "../../../plugin/src/features/magic-context/memory/claim-operation-contract";
import { normalizeMemoryContent } from "../../../plugin/src/features/magic-context/memory/normalize-hash";
import { sha256Utf8Hex } from "../../../plugin/src/features/magic-context/memory/storage-claims";
import { VERIFY_BATCH_SIZE, VERIFY_UPDATE_CONTENT_MAX_LENGTH } from "../../../plugin/src/features/magic-context/dreamer/verify";
import { MAP_BATCH_SIZE } from "../../../plugin/src/features/magic-context/dreamer/map-memories";
import { CLASSIFY_CHUNK_SIZE } from "../../../plugin/src/features/magic-context/dreamer/classify";
import { parseVerifyManifest } from "../../../plugin/src/features/magic-context/dreamer/verify-prompt";
import { parseMapMemoriesManifest } from "../../../plugin/src/features/magic-context/dreamer/map-memories-prompt";
import { parseClassifyManifest } from "../../../plugin/src/features/magic-context/dreamer/classify-prompt";
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
const DIGEST_RE = /^[0-9a-f]{64}$/;

/** The report contract's own identity predicates. A caller overriding either value
 *  can reject it before a live run rather than after `parseRunReport` refuses the
 *  artifact that run produced. */
export function isValidRunId(value: string): boolean {
    return RUN_ID_RE.test(value);
}

export function isValidRepoCommitSha(value: string): boolean {
    return SHA_RE.test(value);
}

export function isValidNowMs(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Lowest verification timestamp the seeder can build a fixture around.
 * `prepareFixtureRepository` derives the fixture commit time as the earliest
 * verification minus 2_000 ms and rejects a non-positive result as
 * `fixture-drift`, so anything at or below 2_000 describes a scenario that can
 * never reach preflight or scoring.
 */
const MIN_VERIFIED_AT_MS = 2_001;

/**
 * Latest commit second git will accept: 2099-12-31T23:59:59Z. Git 2.50.1 rejects
 * 2100-01-01T00:00:00Z with `fatal: invalid date format` in both ISO and raw
 * `<seconds> <tz>` form, so the ceiling belongs to git's own date handling rather
 * than to one input spelling — reformatting cannot lift it.
 */
const MAX_GIT_COMMIT_SECONDS = 4_102_444_799;

/**
 * Highest verification timestamp a scenario may author. The seeder derives the
 * fixture commit as the earliest verification minus 2_000 ms and formats it with
 * second precision, so the last acceptable verification is the final millisecond
 * of git's last acceptable second, plus that offset. Bounding it here keeps a
 * `RangeError` from `toISOString` and git's own date rejection out of the run:
 * both would land before any typed seeder check.
 */
const MAX_VERIFIED_AT_MS = (MAX_GIT_COMMIT_SECONDS + 1) * 1_000 + 2_000 - 1;

/**
 * `extractCompleteManifestBody` ends the verify body at the first case-insensitive occurrence of `VERIFY_ROOT_CLOSE_TAG`.
 * body short.
 */
const VERIFY_ROOT_CLOSE_TAG = "</verify>";

/**
 * Smallest pool a scenario may declare, and therefore the smallest a completed
 * run can have observed.
 */
const MIN_POOL_CLAIMS = 10;

/** Largest pool a scenario may declare, and therefore the largest a capture can hold. */
export const MAX_POOL_CLAIMS = 50;

/**
 * Claims production dispatches to one child session per task. The runner
 * captures a task's children by matching every in-scope public claim id in one
 * transcript and compares the match count against `ceil(inScope / batchSize)`,
 * so it can only score a task production sends as a single batch: with the pool
 * partitioned, no child carries the whole id set, every child is rejected, and
 * the run terminates as harness failure rather than a scored experiment.
 *
 * `MAX_POOL_CLAIMS` is at or below every size here, so a scenario the pool
 * parser accepts is already single-batch. `partitionUnsupported` keeps that
 * true if either side moves: raising the pool cap past a task's batch size, or
 * production lowering one, fails the affected scenario here instead of
 * producing runs that spend model credits and report harness failure.
 *
 * The classify chunker also splits on rendered prompt bytes, but only on the
 * module route; the child route this lane drives passes an infinite byte budget
 * and chunks by count alone.
 */
export const TASK_BATCH_SIZE: Record<DreamerTask, number> = {
    verify: VERIFY_BATCH_SIZE,
    "verify-broad": VERIFY_BATCH_SIZE,
    "map-memories": MAP_BATCH_SIZE,
    "classify-memories": CLASSIFY_CHUNK_SIZE,
};

/**
 * FAIL reasons each task's scorer can actually produce. A report naming another
 * one attributes an impossible outcome — and, for `wrong-archival`, run-fatal
 * exit 2 — to an experiment that could never reach it.
 */
const TASK_FAIL_REASONS: Record<DreamerTask, readonly FailReason[]> = {
    verify: [
        "wrong-archival",
        "missed-archival",
        "wrong-verdict",
        "wrong-mapping",
        "wrong-update-content",
        "invalid-output",
    ],
    "verify-broad": [
        "wrong-archival",
        "missed-archival",
        "wrong-verdict",
        "wrong-mapping",
        "wrong-update-content",
        "invalid-output",
    ],
    "map-memories": ["wrong-independence", "wrong-mapping", "invalid-output"],
    "classify-memories": ["wrong-classification", "invalid-output"],
};

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

export interface ScenarioPressureRole {
    role: PressureRole;
    claimIds: string[];
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

/**
 * Manifest file paths use comma-separated, double-quoted attributes.
 * Production splits manifest file paths on commas and trims each entry.
 * Paths containing commas, quotes, angle brackets, or edge whitespace cannot round-trip through the manifest.
 * A NUL survives validation and `resolve`, but `writeFileSync` throws an untyped `TypeError`.
 */
const UNREPRESENTABLE_PATH_RE = /[,"<>\0]/;

function parseFilePath(value: unknown, label: string): string {
    const path = string(value, label);
    if (path !== path.trim() || UNREPRESENTABLE_PATH_RE.test(path)) fail(`${label}: path-unrepresentable`);
    return path;
}

/**
 * An absolute host path, not a manifest path. The fixture worktree lives under the
 * host temp directory, which may legitimately contain a comma, a quote, or edge
 * whitespace — characters `parseFilePath` forbids because a manifest lists paths
 * comma-separated inside an XML attribute. Applying that rule here would reject an
 * otherwise valid report for the shape of the machine's temp directory.
 */
function parseHostDirectory(value: unknown, label: string): string {
    const path = string(value, label);
    if (!/^(?:[/\\]|[A-Za-z]:[/\\])/.test(path)) fail(`${label}: path-not-absolute`);
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
    // Anti-memory claims fail during seeding because no required structured payload is provided.
    if (category === ANTI_MEMORY_CATEGORY) fail(`${label}.category: unsupported`);
    const hygieneVisible = boolean(value.hygieneVisible, `${label}.hygieneVisible`);
    // No seeding step creates dispositions that hide hygiene-visible claims.
    // A false `hygieneVisible` value makes the hygiene lane fail its gate assertion before it runs.
    // The hygiene read returns every active row, so a hidden claim fails the gate assertion.
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
        // Unlike gold mappings, mapping preconditions describe existing claim mappings and cannot name another claim's files.
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
            verifiedAt: boundedInteger(
                item.verifiedAt,
                `${itemLabel}.verifiedAt`,
                MIN_VERIFIED_AT_MS,
                MAX_VERIFIED_AT_MS,
            ),
        };
    });
    unique(verifications.map((entry) => entry.claimId), `${label}.verifications`);
    const classifiedClaimIds = parseClaimIdArray(value.classifiedClaimIds, `${label}.classifiedClaimIds`);
    for (const [index, claimId] of classifiedClaimIds.entries()) {
        assertKnownClaim(claimId, poolIds, `${label}.classifiedClaimIds[${index}]`);
    }
    // `classifiedClaimIds` must be empty because the seeder creates no classifications.
    if (classifiedClaimIds.length > 0) fail(`${label}.classifiedClaimIds: unsupported`);
    return { mappings, verifications, classifiedClaimIds };
}

/**
 * The declared-path set includes every path the seeder writes and commits across the pool.
 * Gold mappings may name paths declared by another claim to model moved files.
 */
function declaredFixturePaths(pool: ReadonlyMap<string, ScenarioClaim>): ReadonlySet<string> {
    const paths = new Set<string>();
    for (const claim of pool.values()) {
        for (const file of claim.fixtureFiles) paths.add(file.path);
    }
    return paths;
}

/**
 * Gold entries must name declared canonical fixture paths because the host drops untracked and noncanonical paths.
 */
function parseGoldFilePathArray(raw: unknown, label: string, declared: ReadonlySet<string>): string[] {
    const values = parseFilePathArray(raw, label);
    for (const [index, value] of values.entries()) {
        if (!declared.has(value)) fail(`${label}[${index}]: path-untracked`);
    }
    return values;
}

/**
 *
 */
function disjointAnchorLength(anchors: readonly string[]): number | null {
    const cost = new Map<string, number>();
    for (const anchor of anchors) {
        const folded = anchor.toLowerCase();
        const weight = Math.min(anchor.length, folded.length);
        cost.set(folded, Math.min(cost.get(folded) ?? weight, weight));
    }
    const maximal = [...cost.keys()].filter(
        (anchor) => ![...cost.keys()].some((other) => other !== anchor && other.includes(anchor)),
    );
    for (const left of maximal) {
        for (const right of maximal) {
            if (left === right) continue;
            for (let size = Math.min(left.length, right.length); size > 0; size -= 1) {
                if (left.endsWith(right.slice(0, size))) return null;
            }
        }
    }
    return maximal.reduce((total, anchor) => total + (cost.get(anchor) ?? 0), 0);
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
        // A combined anchor length over the cap does not prove impossibility because anchors can overlap in one body.
        for (const [anchorIndex, anchor] of requiredUpdateAnchors.entries()) {
            const edgePadding =
                (/^\s/.test(anchor) ? 1 : 0) + (/\s$/.test(anchor) ? 1 : 0);
            if (anchor.length + edgePadding > VERIFY_UPDATE_CONTENT_MAX_LENGTH) {
                fail(`${itemLabel}.requiredUpdateAnchors[${anchorIndex}]: anchor-exceeds-content-cap`);
            }
            //
            // The battery synthesizes inert spellings; rejecting them would refuse satisfiable gold.
            if (anchor.toLowerCase().includes(VERIFY_ROOT_CLOSE_TAG)) {
                fail(`${itemLabel}.requiredUpdateAnchors[${anchorIndex}]: anchor-holds-root-close-tag`);
            }
        }
        // Individually capped anchors can still be jointly impossible when they cannot overlap.
        // Two non-overlapping anchors require a body at least as long as their combined length.
        const disjointLength = disjointAnchorLength(requiredUpdateAnchors);
        if (disjointLength !== null && disjointLength > VERIFY_UPDATE_CONTENT_MAX_LENGTH) {
            fail(`${itemLabel}.requiredUpdateAnchors: anchors-exceed-content-cap`);
        }
        // Anchors require an `update` verdict.
        if (verdict !== "update" && (requiredUpdateAnchors.length > 0 || forbiddenUpdateAnchors.length > 0)) {
            fail(`${itemLabel}: anchors-require-update`);
        }
        // Anchor checks use case-insensitive substring matching.
        // A required anchor containing a forbidden anchor makes the pair unsatisfiable.
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
        // `applyClassifications` overrides explicit `shareable: true` for sensitive claims but preserves omitted values; gold can require shareable only when the stored claim is already shareable.
        if (shareable && poolClaim.sharing !== "shareable" && hasShareabilitySensitiveText(poolClaim.content)) {
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
 * Set equality ignores order and duplicates; compare arrays for positional equality.
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
    // A task whose gate selects no inputs cannot yield a PASS.
    // successful artifact.
    if (expectedInScopeClaimIds.length === 0) {
        fail(`${label}.expectedInScopeClaimIds: scope-empty`);
    }
    if (expectedInScopeClaimIds.length > TASK_BATCH_SIZE[task]) {
        fail(`${label}.expectedInScopeClaimIds: partition-unsupported`);
    }
    if (task === "classify-memories" && expectedSkippedClaimIds.length > 0) {
        fail(`${label}.expectedSkippedClaimIds: classify-skips-nothing`);
    }
    if (task === "classify-memories") {
        // `stale` and `flagged` dispositions exclude claims from the hygiene pool.
        // `expectedInScopeClaimIds` cannot equal the full hygiene pool after either disposition.
        for (const [index, entry] of preconditions.verifications.entries()) {
            if (entry.outcome === "stale" || entry.outcome === "flagged") {
                fail(`${label}.preconditions.verifications[${index}].outcome: classify-hidden-disposition`);
            }
        }
    }
    if (task === "verify-broad") {
        if (expectedResultMode !== "broad") fail(`${label}.expectedResultMode: broad-required`);
        // never run.
        if (preconditions.verifications.length === 0) {
            fail(`${label}.preconditions.verifications: broad-requires-history`);
        }
    }
    if (task === "verify" && expectedResultMode !== "incremental") {
        fail(`${label}.expectedResultMode: verify-mode-unproducible`);
    }
    if (task === "verify" || task === "verify-broad") {
        const mappedClaimIds = new Set(
            preconditions.mappings.flatMap((entry) => (entry.files.length > 0 ? [entry.claimId] : [])),
        );
        // every verification.
        const verifiedClaimIds = new Set(
            preconditions.verifications.flatMap((entry) => (entry.outcome === "verified" ? [entry.claimId] : [])),
        );
        const derived = [...poolIds].filter(
            (claimId) =>
                mappedClaimIds.has(claimId) &&
                (task === "verify-broad" || !verifiedClaimIds.has(claimId)),
        );
        if (!sameSet(expectedInScopeClaimIds, derived)) {
            fail(`${label}.expectedInScopeClaimIds: verify-scope-mismatch`);
        }
    }
    if (task === "map-memories") {
        // repository.
        const seededFiles = new Map(preconditions.mappings.map((entry) => [entry.claimId, entry.files]));
        for (const [index, claimId] of expectedSkippedClaimIds.entries()) {
            if (!seededFiles.has(claimId)) {
                fail(`${label}.expectedSkippedClaimIds[${index}]: map-scope-unmapped`);
            }
        }
        for (const [index, claimId] of expectedInScopeClaimIds.entries()) {
            if ((seededFiles.get(claimId)?.length ?? 0) > 0) {
                fail(`${label}.expectedInScopeClaimIds[${index}]: map-scope-already-mapped`);
            }
        }
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
    exact(root, ["schema", "id", "title", "pressureRoles", "pool", "tasks"], label);
    if (root.schema !== DREAMER_EVAL_SCENARIO_SCHEMA) fail(`${label}.schema: version-invalid`);
    const poolValue = record(root.pool, `${label}.pool`);
    exact(poolValue, ["claims"], `${label}.pool`);
    const claims = array(poolValue.claims, `${label}.pool.claims`).map((entry, index) =>
        parseScenarioClaim(entry, `${label}.pool.claims[${index}]`),
    );
    if (claims.length > MAX_POOL_CLAIMS) fail(`${label}.pool.claims: count-invalid`);
    if (claims.filter((claim) => claim.hygieneVisible).length < MIN_POOL_CLAIMS) fail(`${label}.pool.claims: hygiene-visible-count-invalid`);
    unique(claims.map((claim) => claim.id), `${label}.pool.claims`);
    unique(
        claims.map((claim) => `${claim.category}\u0000${normalizeMemoryContent(claim.content)}`),
        `${label}.pool.claims.content`,
    );
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

/** Pool descriptors and run records retain current claim state. */
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

export const PLUGIN_RUNTIME_SOURCES = ["dist", "src"] as const;
export type PluginRuntimeSource = (typeof PLUGIN_RUNTIME_SOURCES)[number];

export interface DreamerSystemTuple {
    repoCommitSha: string;
    bunVersion: string;
    opencodeVersion: string;
    modelId: string;
    /**
     * `process.platform`. `canonicalObservedPath` and production's own path
     * handling are deliberately separator-aware, and a case-insensitive
     * filesystem changes which paths production resolves, so the same manifest
     * can score differently across platforms. Without this, reports from two
     * platforms would read as one system and mix harness behaviour into model
     * variance.
     */
    platform: string;
    parserImpl: "ts";
    /**
     * Which plugin entrypoint the harness loaded. `spawn.ts` prefers
     * `packages/plugin/dist/index.js` when it exists and falls back to
     * `packages/plugin/src/index.ts`, so the commit alone does not say which
     * bytes ran.
     */
    pluginEntry: PluginRuntimeSource;
    /**
     * Digest of everything the run's outcome depends on that the commit does not
     * pin: the loaded bundle's bytes when a bundle is loaded, plus every working-
     * tree deviation from `repoCommitSha` — content included, so editing an
     * untracked module changes it. `repoCommitSha` describes the checkout, not the
     * runtime, and a dirty tree or a stale bundle makes two runs at one commit
     * execute different plugin and evaluator code. Without this they would share a
     * system tuple and aggregate as repeats of one experiment.
     */
    runtimeDigest: string;
}

export type DreamerRunStatus = "PASS" | "FAIL" | "ERROR";

/**
 * `object` accepts every scorer result without a cast because interfaces lack implicit index signatures.
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
    /**
     * Every path the fixture repository tracks, read with `git ls-files` after
     * seeding — the universe production's own lookup resolves an observed mapping
     * path against, so it includes the seeder's `.dreamer-eval-fixture` marker.
     *
     * Recorded rather than rederived because a claim's projected files come from
     * its seeded mapping: a task with no mapping preconditions projects none, and
     * a consumer deriving the universe from `poolBefore` would resolve map runs
     * against an empty set.
     */
    trackedFiles: string[];
    /**
     * Absolute path of that fixture repository. `normalizeVerificationFiles`
     * resolves an observed path against the session directory before matching it,
     * so an absolute path inside the fixture is accepted and stored relative —
     * reproducing that needs the root, and it differs per run, so each report
     * carries its own. Null when the run failed before the fixture existed, which
     * is the same partial capture an ERROR report is already allowed to hold.
     */
    fixtureRoot: string | null;
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
    // Production predicates reject storage identities that cannot name existing claims.
    // A scorer or report using an invalid identity attributes a result to a claim no run can reproduce.
    // `revisionLocator` canonically embeds `publicClaimId`.
    // `revisionLocator` and `publicClaimId` must identify the same claim even when each is valid.
    const publicClaimId = string(value.publicClaimId, `${label}.publicClaimId`);
    if (!isValidPublicClaimId(publicClaimId)) fail(`${label}.publicClaimId: id-invalid`);
    const revisionLocator = string(value.revisionLocator, `${label}.revisionLocator`);
    const locator = parseRevisionLocator(revisionLocator);
    if (locator === null) return fail(`${label}.revisionLocator: locator-invalid`);
    if (locator.publicClaimId !== publicClaimId) {
        fail(`${label}.revisionLocator: locator-claim-mismatch`);
    }
    const content = string(value.content, `${label}.content`);
    // The third `revisionLocator` segment equals `sha256Utf8Hex(content)`.
    // A digest over bytes other than `content` identifies a different revision.
    if (locator.contentDigest !== sha256Utf8Hex(content)) {
        fail(`${label}.revisionLocator: locator-digest-mismatch`);
    }
    return {
        claimId: staticId(value.claimId, `${label}.claimId`, CLAIM_ID_RE),
        publicClaimId,
        revisionLocator,
        content,
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
 */
function parseSnapshotArray(raw: unknown, label: string): ClaimSnapshotProjection[] {
    const claims = array(raw, label).map((entry, index) => parseSnapshot(entry, `${label}[${index}]`));
    unique(claims.map((claim) => claim.claimId), label);
    unique(claims.map((claim) => claim.publicClaimId), `${label}.publicClaimId`);
    if (claims.length > MAX_POOL_CLAIMS) fail(`${label}: pool-size-invalid`);
    unique(
        claims.flatMap((claim) =>
            claim.lifecycleState === "active"
                ? [`${claim.category}\u0000${normalizeMemoryContent(claim.content)}`]
                : [],
        ),
        `${label}.content`,
    );
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
    exact(
        value,
        [
            "repoCommitSha",
            "bunVersion",
            "opencodeVersion",
            "modelId",
            "platform",
            "parserImpl",
            "pluginEntry",
            "runtimeDigest",
        ],
        label,
    );
    return {
        repoCommitSha: staticId(value.repoCommitSha, `${label}.repoCommitSha`, SHA_RE),
        bunVersion: string(value.bunVersion, `${label}.bunVersion`),
        opencodeVersion: string(value.opencodeVersion, `${label}.opencodeVersion`),
        modelId: string(value.modelId, `${label}.modelId`),
        platform: string(value.platform, `${label}.platform`),
        parserImpl: enumeration(value.parserImpl, ["ts"], `${label}.parserImpl`),
        pluginEntry: enumeration(value.pluginEntry, PLUGIN_RUNTIME_SOURCES, `${label}.pluginEntry`),
        runtimeDigest: staticId(value.runtimeDigest, `${label}.runtimeDigest`, DIGEST_RE),
    };
}

/**
 * actually produces.
 *
 *
 * different experiment.
 */
function parseManifestEvidence(
    value: unknown,
    label: string,
    task: DreamerTask,
    observedPublicIds: ReadonlySet<string> | null,
): ParsedManifestEvidence | null {
    if (value === null) return null;
    const collected: string[] = [];
    const entryId = (entry: Record<string, unknown>, entryLabel: string): void => {
        const publicClaimId = string(entry.publicClaimId, `${entryLabel}.publicClaimId`);
        if (!isValidPublicClaimId(publicClaimId)) fail(`${entryLabel}.publicClaimId: id-invalid`);
        if (observedPublicIds !== null && !observedPublicIds.has(publicClaimId)) {
            fail(`${entryLabel}.publicClaimId: unobserved-claim`);
        }
        collected.push(publicClaimId);
    };
    const filesOf = (entry: Record<string, unknown>, entryLabel: string): void => {
        for (const [index, file] of array(entry.files, `${entryLabel}.files`).entries()) {
            string(file, `${entryLabel}.files[${index}]`);
        }
    };
    if (task === "verify" || task === "verify-broad") {
        const root = record(value, label);
        exact(root, ["verified", "updated", "archived"], label);
        let entries = 0;
        for (const [index, entry] of array(root.verified, `${label}.verified`).entries()) {
            const entryLabel = `${label}.verified[${index}]`;
            const item = record(entry, entryLabel);
            exact(item, ["publicClaimId", "files"], entryLabel);
            entryId(item, entryLabel);
            filesOf(item, entryLabel);
            entries += 1;
        }
        for (const [index, entry] of array(root.updated, `${label}.updated`).entries()) {
            const entryLabel = `${label}.updated[${index}]`;
            const item = record(entry, entryLabel);
            exact(item, ["publicClaimId", "files", "content"], entryLabel);
            entryId(item, entryLabel);
            filesOf(item, entryLabel);
            if (typeof item.content !== "string") fail(`${entryLabel}.content: string-invalid`);
            entries += 1;
        }
        for (const [index, entry] of array(root.archived, `${label}.archived`).entries()) {
            const entryLabel = `${label}.archived[${index}]`;
            const item = record(entry, entryLabel);
            exact(item, ["publicClaimId", "reason"], entryLabel);
            entryId(item, entryLabel);
            if (typeof item.reason !== "string") fail(`${entryLabel}.reason: string-invalid`);
            entries += 1;
        }
        if (entries === 0) fail(`${label}: evidence-empty`);
        if (new Set(collected).size !== collected.length) fail(`${label}: duplicate`);
        return root;
    }
    const entries = array(value, label).map((entry, index) => {
        const entryLabel = `${label}[${index}]`;
        const item = record(entry, entryLabel);
        entryId(item, entryLabel);
        if (task === "map-memories") {
            exact(item, ["publicClaimId", "files", "independent"], entryLabel);
            filesOf(item, entryLabel);
            boolean(item.independent, `${entryLabel}.independent`);
            return item;
        }
        for (const key of Object.keys(item)) {
            if (!["publicClaimId", "importance", "scope", "shareable"].includes(key)) {
                fail(`${entryLabel}: fields-invalid`);
            }
        }
        if (item.importance !== undefined) boundedInteger(item.importance, `${entryLabel}.importance`, 1, 100);
        if (item.scope !== undefined) enumeration(item.scope, CLAIM_SCOPES, `${entryLabel}.scope`);
        if (item.shareable !== undefined) boolean(item.shareable, `${entryLabel}.shareable`);
        if (item.importance === undefined && item.scope === undefined && item.shareable === undefined) {
            fail(`${entryLabel}: classification-empty`);
        }
        return item;
    });
    if (entries.length === 0) fail(`${label}: evidence-empty`);
    const covered = new Set(entries.map((entry) => entry.publicClaimId as string));
    if (covered.size !== entries.length) fail(`${label}: duplicate`);
    if (task === "classify-memories" && observedPublicIds !== null) {
        if (covered.size !== observedPublicIds.size) fail(`${label}: coverage-incomplete`);
    }
    return entries;
}

/**
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


/** Canonical encoding compares evidence by value regardless of object key order. */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const fields = Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
        return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/**
 */
function reparseManifest(task: DreamerTask, rawManifest: string): ParsedManifestEvidence | null {
    try {
        if (task === "verify" || task === "verify-broad") {
            return parseVerifyManifest(rawManifest, new Set()) as unknown as ParsedManifestEvidence;
        }
        if (task === "map-memories") {
            return parseMapMemoriesManifest(rawManifest) as unknown as ParsedManifestEvidence;
        }
        return parseClassifyManifest(rawManifest) as unknown as ParsedManifestEvidence;
    } catch {
        return null;
    }
}

export function parseRunReport(raw: unknown, label = "report"): DreamerEvalRunReport {
    const root = record(raw, label);
    exact(root, ["schema", "scenarioId", "task", "runId", "nowMs", "status", "reason", "runFatal", "system", "trackedFiles", "fixtureRoot", "poolBefore", "poolAfter", "rawManifest", "parsedManifest", "receiptOutcomes"], label);
    if (root.schema !== DREAMER_EVAL_REPORT_SCHEMA) fail(`${label}.schema: version-invalid`);
    const task = enumeration(root.task, DREAMER_TASKS, `${label}.task`);
    const status = enumeration(root.status, ["PASS", "FAIL", "ERROR"], `${label}.status`);
    let reason: ErrorReason | FailReason | null = null;
    if (status === "PASS") {
        if (root.reason !== null) fail(`${label}.reason: pass-reason-invalid`);
    } else if (status === "ERROR") {
        const errorReason = enumeration(root.reason, ERROR_REASONS, `${label}.reason`);
        // Only `verify` and `verify-broad` permit `wrong-result-mode`.
        if (
            errorReason === "wrong-result-mode" &&
            !(task === "verify" || task === "verify-broad")
        ) {
            fail(`${label}.reason: task-reason-mismatch`);
        }
        reason = errorReason;
    } else {
        const failReason = enumeration(root.reason, FAIL_REASONS, `${label}.reason`);
        // Each task runs one scorer, and a scorer emits only its own reasons.
        if (!TASK_FAIL_REASONS[task].includes(failReason)) {
            fail(`${label}.reason: task-reason-mismatch`);
        }
        reason = failReason;
    }
    const runFatal = boolean(root.runFatal, `${label}.runFatal`);
    if (runFatal !== isRunFatal(status, reason)) fail(`${label}.runFatal: mapping-invalid`);
    const poolBefore = parseSnapshotArray(root.poolBefore, `${label}.poolBefore`);
    const poolAfter = parseSnapshotArray(root.poolAfter, `${label}.poolAfter`);
    // Archival changes `lifecycleState` without changing claim identity.
    // Completed runs require identical claim identities before and after.
    if (status !== "ERROR") {
        // Without the minimum pool size, a report can omit every claim and still satisfy binding equality.
        if (poolBefore.length < MIN_POOL_CLAIMS) fail(`${label}.poolBefore: pool-capture-incomplete`);
        if (!sameIdentityBindings(poolBefore, poolAfter)) fail(`${label}.poolAfter: identity-drift`);
    }
    const receiptOutcomes = array(root.receiptOutcomes, `${label}.receiptOutcomes`).map((entry, index) => {
        const itemLabel = `${label}.receiptOutcomes[${index}]`;
        const item = record(entry, itemLabel);
        exact(item, ["claimId", "operation", "outcome"], itemLabel);
        const claimId = staticId(item.claimId, `${itemLabel}.claimId`, CLAIM_ID_RE);
        // ERROR runs may have partial pool captures.
        // ERROR runs are exempt from pool-binding equality because their pool capture may be partial.
        if (status !== "ERROR" && !poolBefore.some((claim) => claim.claimId === claimId)) {
            fail(`${itemLabel}.claimId: unobserved-claim`);
        }
        return {
            claimId,
            operation: string(item.operation, `${itemLabel}.operation`),
            outcome: string(item.outcome, `${itemLabel}.outcome`),
        };
    });
    const rawManifest = nullableRawText(root.rawManifest, `${label}.rawManifest`);
    const parsedManifest = parseManifestEvidence(
        root.parsedManifest,
        `${label}.parsedManifest`,
        task,
        status === "ERROR" ? null : new Set(poolBefore.map((claim) => claim.publicClaimId)),
    );
    // A scorer reaches PASS only after a nonblank manifest survives validation
    // PASS requires parsed evidence.
    // ERROR:provider-failure may retain blank manifest bytes.
    // ERROR:provider-failure records.
    if (status === "PASS" && (rawManifest === null || rawManifest.trim().length === 0 || parsedManifest === null)) {
        fail(`${label}.parsedManifest: pass-requires-evidence`);
    }
    // `precheck` admits FAIL only with a nonblank manifest.
    // `FAIL` reports require parsed evidence unless `reason` is `invalid-output`.
    // `provider-failure` and `output-length-capped` cannot have parsed evidence; post-parse errors may retain it.
    // `apply-not-applied` may retain parsed evidence.
    if (
        status === "ERROR" &&
        (reason === "provider-failure" || reason === "output-length-capped") &&
        parsedManifest !== null
    ) {
        fail(`${label}.parsedManifest: prevalidation-error-has-evidence`);
    }
    // An `archived` entry with a matching `poolAfter` claim requires that claim's `lifecycleState` to be `archived`.
    if (status === "PASS" && parsedManifest !== null && !Array.isArray(parsedManifest)) {
        const archived = (parsedManifest as Record<string, unknown>).archived;
        if (Array.isArray(archived)) {
            for (const [index, entry] of archived.entries()) {
                const publicClaimId = (entry as Record<string, unknown>).publicClaimId;
                const after = poolAfter.find((claim) => claim.publicClaimId === publicClaimId);
                if (after !== undefined && after.lifecycleState !== "archived") {
                    fail(`${label}.poolAfter: archive-not-applied[${index}]`);
                }
            }
        }
    }
    if (status === "FAIL") {
        if (rawManifest === null || rawManifest.trim().length === 0) {
            fail(`${label}.rawManifest: fail-requires-evidence`);
        }
        if (reason === "invalid-output") {
            if (parsedManifest !== null) fail(`${label}.parsedManifest: invalid-output-has-evidence`);
        } else if (parsedManifest === null) {
            fail(`${label}.parsedManifest: fail-requires-evidence`);
        }
    }
    // Parsed evidence must equal the manifest parsed from `rawManifest`.
    //
    // `invalid-output` may contain parseable `rawManifest` bytes without parsed evidence.
    if (parsedManifest !== null) {
        if (rawManifest === null || rawManifest.trim().length === 0) {
            fail(`${label}.rawManifest: evidence-without-bytes`);
        }
        const reparsed = reparseManifest(task, rawManifest as string);
        if (reparsed === null) fail(`${label}.rawManifest: evidence-unparseable`);
        if (canonicalJson(reparsed) !== canonicalJson(parsedManifest)) {
            fail(`${label}.parsedManifest: evidence-mismatch`);
        }
    }
    return {
        schema: DREAMER_EVAL_REPORT_SCHEMA,
        scenarioId: staticId(root.scenarioId, `${label}.scenarioId`, SCENARIO_ID_RE),
        task,
        runId: staticId(root.runId, `${label}.runId`, RUN_ID_RE),
        nowMs: integer(root.nowMs, `${label}.nowMs`),
        status,
        reason,
        runFatal,
        system: parseSystem(root.system, `${label}.system`),
        trackedFiles: parseFilePathArray(root.trackedFiles, `${label}.trackedFiles`),
        fixtureRoot: root.fixtureRoot === null ? null : parseHostDirectory(root.fixtureRoot, `${label}.fixtureRoot`),
        poolBefore,
        poolAfter,
        rawManifest,
        parsedManifest,
        receiptOutcomes,
    };
}

export function dreamerEvalExitCode(report: DreamerEvalRunReport | readonly DreamerEvalRunReport[]): 0 | 1 | 2 {
    const reports = Array.isArray(report) ? report : [report];
    // An empty report aggregation means no evaluation ran; return 1 rather than reporting success.
    if (reports.length === 0) return 1;
    if (reports.some((entry) => entry.runFatal)) return 2;
    if (reports.some((entry) => entry.status !== "PASS")) return 1;
    return 0;
}
