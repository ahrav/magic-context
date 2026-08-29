import { makeContractPrimitives } from "../contract-primitives";
import { ANTI_MEMORY_CATEGORY } from "../../../plugin/src/features/magic-context/memory/constants";
import {
    isValidPublicClaimId,
    parseRevisionLocator,
} from "../../../plugin/src/features/magic-context/memory/claim-operation-contract";
import { normalizeMemoryContent } from "../../../plugin/src/features/magic-context/memory/normalize-hash";
import { sha256Utf8Hex } from "../../../plugin/src/features/magic-context/memory/storage-claims";
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
 * `parseVerifyManifest` ends an update entry at the first literal occurrence of
 * this tag, matched case-sensitively.
 */
const UPDATE_CLOSE_TAG = "</update>";

/**
 * `extractCompleteManifestBody` ends the verify body at the first occurrence of
 * this tag and matches the root case-insensitively, so any case variant cuts the
 * body short.
 */
const VERIFY_ROOT_CLOSE_TAG = "</verify>";

/**
 * `parseVerifyManifest` scans the whole body for each entry shape, so one of
 * these inside an update's content parses as a real sibling entry. Matched
 * case-sensitively, like the parser's own regexes.
 */
const VERIFY_ENTRY_OPEN_RE = /<(?:verified|update|archive)\b/;

/**
 * Smallest pool a scenario may declare, and therefore the smallest a completed
 * run can have observed.
 */
const MIN_POOL_CLAIMS = 10;

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
 * construction. A NUL is unrepresentable for a different reason: it survives
 * every string check here and `resolve`, then `writeFileSync` rejects it with a
 * raw `TypeError` that escapes the typed fixture-drift path.
 */
const UNREPRESENTABLE_PATH_RE = /[,"<>\0]/;

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

/**
 * A sound lower bound on the shortest update body that can contain every
 * required anchor, or null when no bound is provable here.
 *
 * The true minimum is the shortest-common-superstring length, which is NP-hard,
 * so this decides only the case where the anchors provably cannot share
 * characters: anchors contained in another ride along for free and drop out, and
 * if no ordered pair of the rest overlaps — no suffix of one is a prefix of the
 * other — then every occurrence is disjoint and the minimum is exactly the sum.
 * Anchor matching is case-insensitive, so overlap is judged folded.
 */
function disjointAnchorLength(anchors: readonly string[]): number | null {
    // Case folding can lengthen a string — `"İ".toLowerCase()` is two code units
    // — so folded spellings decide identity and overlap while the cost of
    // carrying an anchor is measured on what a body actually holds: the authored
    // spelling, or its folded form when that is somehow shorter.
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
            // The parser stops the update body at the first `</update>`, so
            // parsed content cannot retain an anchor holding that tag no matter
            // what the provider emits.
            if (anchor.includes(UPDATE_CLOSE_TAG)) {
                fail(`${itemLabel}.requiredUpdateAnchors[${anchorIndex}]: anchor-holds-close-tag`);
            }
            // The root extraction runs first and is case-insensitive, so any
            // spelling of the closing root tag truncates the body before the
            // entry parser sees it.
            if (anchor.toLowerCase().includes(VERIFY_ROOT_CLOSE_TAG)) {
                fail(`${itemLabel}.requiredUpdateAnchors[${anchorIndex}]: anchor-holds-root-close-tag`);
            }
            // The parser collects each entry shape from the whole body, so one
            // spelled inside the update content becomes a sibling entry carrying
            // an id the pool does not have, and coverage validation then rejects
            // every manifest that satisfies the anchor.
            if (VERIFY_ENTRY_OPEN_RE.test(anchor)) {
                fail(`${itemLabel}.requiredUpdateAnchors[${anchorIndex}]: anchor-holds-entry`);
            }
        }
        // Individually capped anchors can still be jointly impossible: two that
        // cannot overlap need a body at least as long as their sum.
        const disjointLength = disjointAnchorLength(requiredUpdateAnchors);
        if (disjointLength !== null && disjointLength > VERIFY_UPDATE_CONTENT_MAX_LENGTH) {
            fail(`${itemLabel}.requiredUpdateAnchors: anchors-exceed-content-cap`);
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
        // revision whenever the claim content trips the same predicate — but only
        // when the entry explicitly reports `true`. An entry that omits the field
        // preserves the stored value, so gold asking for shareable is achievable
        // for a sensitive claim already stored that way, and unachievable for one
        // stored private: the model's "true" would score PASS while the stored
        // claim came out private.
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
    // Classify reads the hygiene surface, which returns every active row, and
    // runs only once the pool reaches CLASSIFY_MIN_POOL. Parsing rejects
    // `hygieneVisible: false` and requires at least ten claims, so the
    // production gate always selects the whole pool and a scenario skipping any
    // claim terminates with gate-mismatch at preflight.
    if (task === "classify-memories" && expectedSkippedClaimIds.length > 0) {
        fail(`${label}.expectedSkippedClaimIds: classify-skips-nothing`);
    }
    if (task === "classify-memories") {
        // Recording `stale` or `flagged` sets the claim's stale or disputed
        // disposition, and the maintenance_hygiene surface admits a claim only
        // when both are clear. Such a claim leaves the hygiene pool the classify
        // gate reads, so the whole-pool expectation above can no longer hold.
        for (const [index, entry] of preconditions.verifications.entries()) {
            if (entry.outcome === "stale" || entry.outcome === "flagged") {
                fail(`${label}.preconditions.verifications[${index}].outcome: classify-hidden-disposition`);
            }
        }
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
    if (task === "verify" || task === "verify-broad") {
        // The gate keeps a normal claim only when it has mapped files, and only
        // an explicit mapping precondition seeds one — declaring fixtureFiles
        // does not. The anti-memory category, the one kind admitted without a
        // mapping, is already refused at the claim level.
        const mappedClaimIds = new Set(
            preconditions.mappings.flatMap((entry) => (entry.files.length > 0 ? [entry.claimId] : [])),
        );
        // `verifiedAt` reports a timestamp only for a latest outcome of
        // "verified" and 0 for every other one, and the seeder pins the fixture
        // commit before every seeded verification with no later file change, so
        // incremental skips exactly the claims carrying a verified outcome.
        // Broad re-sweeps all of them, because the seeded watermark sits above
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
        // `selectMapMemoryInputs` always selects a claim with no baseline, and a
        // mapping precondition is the only thing that creates one. The converse
        // holds for a nonempty mapping too: `shouldRequeueIndependentMapping`
        // requires an empty sentinel, so a claim with mapped files can never be
        // pulled back in. Only an empty mapping is genuinely ambiguous, because
        // the requeue heuristic then reads the claim's content and the
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
    exact(root, ["schema", "id", "title", "pool", "tasks"], label);
    if (root.schema !== DREAMER_EVAL_SCENARIO_SCHEMA) fail(`${label}.schema: version-invalid`);
    const poolValue = record(root.pool, `${label}.pool`);
    exact(poolValue, ["claims"], `${label}.pool`);
    const claims = array(poolValue.claims, `${label}.pool.claims`).map((entry, index) =>
        parseScenarioClaim(entry, `${label}.pool.claims[${index}]`),
    );
    if (claims.length > 50) fail(`${label}.pool.claims: count-invalid`);
    if (claims.filter((claim) => claim.hygieneVisible).length < MIN_POOL_CLAIMS) fail(`${label}.pool.claims: hygiene-visible-count-invalid`);
    unique(claims.map((claim) => claim.id), `${label}.pool.claims`);
    // Claim creation dedupes on (project, category, normalized content hash)
    // among active claims, so two rows whose contents normalize alike collapse
    // into one and the seeder aborts on its public-id cardinality check. The
    // production normalizer decides the identity here rather than a local copy
    // of its rules.
    unique(
        claims.map((claim) => `${claim.category}\u0000${normalizeMemoryContent(claim.content)}`),
        `${label}.pool.claims.content`,
    );
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
    // Storage identities, checked with the production predicates rather than a
    // local restatement: a value outside them names a claim that cannot exist,
    // so a scorer or report would attribute its result to something no run can
    // reproduce. The locator canonically embeds the claim's own public id, so a
    // locator naming a different claim is a mismatched pairing even when both
    // halves are individually well formed.
    const publicClaimId = string(value.publicClaimId, `${label}.publicClaimId`);
    if (!isValidPublicClaimId(publicClaimId)) fail(`${label}.publicClaimId: id-invalid`);
    const revisionLocator = string(value.revisionLocator, `${label}.revisionLocator`);
    const locator = parseRevisionLocator(revisionLocator);
    if (locator === null) return fail(`${label}.revisionLocator: locator-invalid`);
    if (locator.publicClaimId !== publicClaimId) {
        fail(`${label}.revisionLocator: locator-claim-mismatch`);
    }
    const content = string(value.content, `${label}.content`);
    // The locator's third segment is the revision's `content_sha256`, which
    // production computes as `sha256Utf8Hex(content)`. A digest over other bytes
    // describes a revision whose content is not the one recorded here.
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

/**
 * Parsed evidence, validated against the shape the declared task's scorer
 * actually produces.
 *
 * Verify parses to one record of three verdict lists, map and classify to one
 * entry per claim, and each parser refuses a manifest that yielded no entries —
 * so an empty record or array is evidence no scorer could have emitted.
 *
 * `observedPublicIds` is null for an ERROR run, whose pool capture may be
 * partial; for a completed one every public id must name a claim the report
 * captured, since evidence about a claim absent from the pool describes a
 * different experiment.
 */
function parseManifestEvidence(
    value: unknown,
    label: string,
    task: DreamerTask,
    observedPublicIds: ReadonlySet<string> | null,
): ParsedManifestEvidence | null {
    if (value === null) return null;
    const entryId = (entry: Record<string, unknown>, entryLabel: string): void => {
        const publicClaimId = string(entry.publicClaimId, `${entryLabel}.publicClaimId`);
        if (!isValidPublicClaimId(publicClaimId)) fail(`${entryLabel}.publicClaimId: id-invalid`);
        if (observedPublicIds !== null && !observedPublicIds.has(publicClaimId)) {
            fail(`${entryLabel}.publicClaimId: unobserved-claim`);
        }
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
        // Field sets come straight from `parseVerifyManifest`: a verified entry
        // carries its backing files, an update adds the replacement body, and an
        // archive carries the reason instead of files.
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
            string(item.content, `${entryLabel}.content`);
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
        // `parseClassifyManifest` sets only the attributes the entry carried and
        // refuses one that carried none, so the key set varies within that bound.
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
    return entries;
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
    const task = enumeration(root.task, DREAMER_TASKS, `${label}.task`);
    const status = enumeration(root.status, ["PASS", "FAIL", "ERROR"], `${label}.status`);
    let reason: ErrorReason | FailReason | null = null;
    if (status === "PASS") {
        if (root.reason !== null) fail(`${label}.reason: pass-reason-invalid`);
    } else if (status === "ERROR") {
        reason = enumeration(root.reason, ERROR_REASONS, `${label}.reason`);
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
    // No evaluated task creates, deletes, or rekeys a claim — archival shows up
    // as lifecycleState on the same row — so a completed run observes the same
    // identities before and after. Drift means the report either omitted an
    // affected claim or bound one claim's result to another identity, and each
    // silently corrupts a before/after comparison. An ERROR run is exempt: it
    // may have failed before capturing the pool, so a partial capture is the
    // honest record there.
    if (status !== "ERROR") {
        // Binding equality is vacuous for two empty captures, and every valid
        // scenario declares at least MIN_POOL_CLAIMS claims, so a completed run
        // observed at least that many. Without this floor a report can drop the
        // whole experiment population and still satisfy the comparison.
        if (poolBefore.length < MIN_POOL_CLAIMS) fail(`${label}.poolBefore: pool-capture-incomplete`);
        if (!sameIdentityBindings(poolBefore, poolAfter)) fail(`${label}.poolAfter: identity-drift`);
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
    const rawManifest = nullableRawText(root.rawManifest, `${label}.rawManifest`);
    const parsedManifest = parseManifestEvidence(
        root.parsedManifest,
        `${label}.parsedManifest`,
        task,
        status === "ERROR" ? null : new Set(poolBefore.map((claim) => claim.publicClaimId)),
    );
    // A scorer reaches PASS only after a nonblank manifest survives validation
    // and yields parsed evidence, so a PASS carrying blank bytes or no evidence
    // claims a scored experiment with nothing showing a model was scored. Blank
    // bytes stay retainable on an ERROR report, which is exactly what
    // ERROR:provider-failure records.
    if (status === "PASS" && (rawManifest === null || rawManifest.trim().length === 0 || parsedManifest === null)) {
        fail(`${label}.parsedManifest: pass-requires-evidence`);
    }
    // A FAIL is reached the same way: `precheck` admits only a nonblank manifest,
    // so every scorer failure has raw bytes behind it, and every reason except
    // `invalid-output` — the one raised when validation itself threw — also
    // carries parsed evidence.
    if (status === "FAIL") {
        if (rawManifest === null || rawManifest.trim().length === 0) {
            fail(`${label}.rawManifest: fail-requires-evidence`);
        }
        if (reason === "invalid-output") {
            // The reason is raised from the catch around validation, which returns
            // before any parse result exists, so evidence alongside it is a
            // combination no run produces.
            if (parsedManifest !== null) fail(`${label}.parsedManifest: invalid-output-has-evidence`);
        } else if (parsedManifest === null) {
            fail(`${label}.parsedManifest: fail-requires-evidence`);
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
        poolBefore,
        poolAfter,
        rawManifest,
        parsedManifest,
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
