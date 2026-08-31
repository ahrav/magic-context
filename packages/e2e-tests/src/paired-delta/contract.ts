import { CHARS_PER_TOKEN } from "../ballast";
import { makeContractPrimitives } from "../contract-primitives";
import { ID_SHAPED_QUERY_MAX_TOKENS } from "../../../plugin/src/features/magic-context/search";

export const ARM_IDS = ["mc-on", "mc-off", "compaction", "r1", "r2", "r3"] as const;
export type ArmId = (typeof ARM_IDS)[number];
export const PRIMARY_ARM_IDS = ["mc-on", "mc-off", "compaction"] as const;
export type PrimaryArmId = (typeof PRIMARY_ARM_IDS)[number];
export const REGRET_ARM_IDS = ["mc-on", "r1", "r2", "r3"] as const;
/** Every arm that appears on either side of a paired subtraction. */
const COMPARED_ARM_IDS: readonly ArmId[] = [
    ...new Set<ArmId>([...PRIMARY_ARM_IDS, ...REGRET_ARM_IDS]),
];

export const RUN_HEALTHS = ["completed", "timeout", "crash", "malformed", "unavailable"] as const;
export type RunHealth = (typeof RUN_HEALTHS)[number];
export const REASON_CODES = [
    "deadline-exceeded",
    "runner-crash",
    "invalid-result",
    "prerequisite-unavailable",
    "product-crash",
    "harness-failure",
    "provider-unavailable",
    "arm-identity-mismatch",
    "absence-precondition-unmet",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
const NON_COMPLETED_HEALTHS: readonly RunHealth[] = RUN_HEALTHS.filter(
    (health) => health !== "completed",
);
/** Most reason codes name their own terminal path, so pairing one with a different health describes a run that cannot have happened and misattributes the missingness. `harness-failure` and `absence-precondition-unmet` are general-purpose and stay admissible on any non-completed health. commentlint: allow(JUDGE) */
const REASON_CODE_HEALTHS: Readonly<Record<ReasonCode, readonly RunHealth[]>> = {
    "deadline-exceeded": ["timeout"],
    "runner-crash": ["crash"],
    "product-crash": ["crash"],
    "invalid-result": ["malformed"],
    "arm-identity-mismatch": ["malformed"],
    "prerequisite-unavailable": ["unavailable"],
    "provider-unavailable": ["unavailable"],
    "harness-failure": NON_COMPLETED_HEALTHS,
    "absence-precondition-unmet": NON_COMPLETED_HEALTHS,
};

export const RUN_MODES = ["calibration", "weekly", "release"] as const;
export type RunMode = (typeof RUN_MODES)[number];
export const PAIRED_DELTA_MANIFEST_SCHEMA = "paired-delta-manifest/v1";

const idPattern = (prefix: string): RegExp =>
    new RegExp(`^${prefix}-[a-z0-9]+(?:-[a-z0-9]+)*$`);
export const FAMILY_ID_RE = idPattern("fam");
export const SCENARIO_ID_RE = idPattern("var");
export const CHECK_ID_RE = idPattern("check");
export const TURN_ID_RE = idPattern("turn");
export const MEMORY_ID_RE = idPattern("mem");

export class PairedDeltaContractError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: readonly string[]) {
        super(diagnostics.join("; "));
        this.name = "PairedDeltaContractError";
        this.diagnostics = diagnostics;
    }
}

const p = makeContractPrimitives(PairedDeltaContractError);

export interface CheckDeclaration {
    id: string;
    appliesToArms: ArmId[];
}

export interface TurnDeclaration {
    id: string;
    role: "user" | "assistant";
    content: string;
}

export interface ScenarioInterventions {
    r1: {
        insertAfterTurnId: string;
        query: string;
        /** Symbolic `mem-*` handles, never wire ids: a `mcm_<32hex>` public claim id is assigned by `seedGoldMemories` per run, so freezing one would freeze a value that never resolves. A runner must map each handle to the seeded `publicClaimId` before calling `scriptedCtxSearchTurn` and must assert the wire result against that resolved id — passing a handle through unmapped demotes the turn to a text search that cannot serve project-memory claims, silently collapsing R1 onto R0. commentlint: allow(JUDGE) */
        locatorIds: string[];
    };
    r2: {
        memories: Array<{ claim: string; evidence: string }>;
    };
    r3: {
        evidence: string;
    };
}

export interface AbsencePreconditionDeclaration {
    evidenceTurnId: string;
    minimumBallastBytes: number;
}

export interface CheckResult {
    id: string;
    passed: boolean;
}

export interface VerifierContext {
    armId: ArmId;
    workspacePath: string;
    scriptedTurnText?: string;
    /** The `publicClaimId` each declared `locatorIds` handle resolved to for this run. A wire assertion must compare against these, not the symbolic handles: the search turn carries resolved ids, so the handles never appear in the result text. commentlint: allow(JUDGE) */
    resolvedLocatorIds?: readonly string[];
}

export type ScenarioVerifier = (
    context: VerifierContext,
) => CheckResult[] | Promise<CheckResult[]>;

export interface ScenarioDeclaration {
    scenarioId: string;
    familyId: string;
    title: string;
    expectedAnswer: string;
    checks: CheckDeclaration[];
    criticalCheckIds: string[];
    turnScript: TurnDeclaration[];
    interventions: ScenarioInterventions;
    absencePrecondition: AbsencePreconditionDeclaration;
    modelContextLimit: number;
    restartArms: ArmId[];
    verifier: ScenarioVerifier;
}

export interface ArmedCellResult {
    armId: ArmId;
    checksPassed: number;
    checksTotal: number;
    criticalPassed: number;
    criticalTotal: number;
    invalidSuccess: boolean;
    runHealth: RunHealth;
    reasonCode: ReasonCode | null;
}

export interface PairedDeltaManifestEntry {
    scenarioId: string;
    semanticFingerprint: string;
    verifierBundleDigest: string;
    runModes: RunMode[];
}

export interface PairedDeltaManifest {
    schema: typeof PAIRED_DELTA_MANIFEST_SCHEMA;
    scenarios: PairedDeltaManifestEntry[];
}

function parseStringArray(
    value: unknown,
    pattern: RegExp,
    label: string,
): string[] {
    const result = p.array(value, label).map((entry, index) =>
        p.staticId(entry, `${label}[${index}]`, pattern));
    p.unique(result, label);
    /** Matches `parseArmArray`: both call sites name a set the lane must actually act on, and every downstream predicate over an empty list is vacuously true. commentlint: allow(JUDGE) */
    if (result.length === 0) p.fail(`${label}: empty`);
    return result;
}

function parseArmArray(value: unknown, label: string): ArmId[] {
    const arms = p.array(value, label).map((entry, index) =>
        p.enumeration(entry, ARM_IDS, `${label}[${index}]`));
    p.unique(arms, label);
    if (arms.length === 0) p.fail(`${label}: empty`);
    return arms;
}

export function parseScenarioDeclaration(raw: unknown): ScenarioDeclaration {
    const root = p.record(raw, "scenario");
    p.exact(root, [
        "scenarioId",
        "familyId",
        "title",
        "expectedAnswer",
        "checks",
        "criticalCheckIds",
        "turnScript",
        "interventions",
        "absencePrecondition",
        "modelContextLimit",
        "restartArms",
        "verifier",
    ], "scenario");

    const checks = p.array(root.checks, "scenario.checks").map((rawCheck, index) => {
        const label = `scenario.checks[${index}]`;
        const check = p.record(rawCheck, label);
        p.exact(check, ["id", "appliesToArms"], label);
        return {
            id: p.staticId(check.id, `${label}.id`, CHECK_ID_RE),
            appliesToArms: parseArmArray(check.appliesToArms, `${label}.appliesToArms`),
        };
    });
    p.unique(checks.map(({ id }) => id), "scenario.checks");
    if (!checks.some(({ appliesToArms }) =>
        PRIMARY_ARM_IDS.every((arm) => appliesToArms.includes(arm)))) {
        p.fail("scenario.checks: primary-intersection-empty");
    }
    if (!checks.some(({ appliesToArms }) =>
        REGRET_ARM_IDS.every((arm) => appliesToArms.includes(arm)))) {
        p.fail("scenario.checks: ladder-intersection-empty");
    }

    const criticalCheckIds = parseStringArray(
        root.criticalCheckIds,
        CHECK_ID_RE,
        "scenario.criticalCheckIds",
    );
    const checksById = new Map(checks.map((check) => [check.id, check]));
    if (criticalCheckIds.some((id) => !checksById.has(id))) {
        p.fail("scenario.criticalCheckIds: unknown-check");
    }
    /** `validateCheckVector` omits a check from the arms it does not apply to, so a critical check declared for only some compared arms gives those arms different critical denominators and the paired critical delta subtracts unlike outcomes. Requiring full coverage keeps every critical comparison like-for-like. commentlint: allow(JUDGE) */
    if (
        criticalCheckIds.some((id) =>
            !COMPARED_ARM_IDS.every((arm) => checksById.get(id)!.appliesToArms.includes(arm)))
    ) {
        p.fail("scenario.criticalCheckIds: arm-coverage-incomplete");
    }

    const turnScript = p.array(root.turnScript, "scenario.turnScript").map((rawTurn, index) => {
        const label = `scenario.turnScript[${index}]`;
        const turn = p.record(rawTurn, label);
        p.exact(turn, ["id", "role", "content"], label);
        return {
            id: p.staticId(turn.id, `${label}.id`, TURN_ID_RE),
            role: p.enumeration(turn.role, ["user", "assistant"] as const, `${label}.role`),
            content: p.string(turn.content, `${label}.content`),
        };
    });
    p.unique(turnScript.map(({ id }) => id), "scenario.turnScript");
    const turnIds = new Set(turnScript.map(({ id }) => id));

    const interventions = p.record(root.interventions, "scenario.interventions");
    p.exact(interventions, ["r1", "r2", "r3"], "scenario.interventions");
    const r1 = p.record(interventions.r1, "scenario.interventions.r1");
    p.exact(r1, ["insertAfterTurnId", "query", "locatorIds"], "scenario.interventions.r1");
    const expectedAnswer = p.string(root.expectedAnswer, "scenario.expectedAnswer");
    const r1Query = p.string(r1.query, "scenario.interventions.r1.query");
    /** `scriptedCtxSearchTurn` interpolates the query into the model-visible prompt, so a query containing the expected answer lets R1 pass its critical check with no retrieval. commentlint: allow(JUDGE) */
    if (r1Query.includes(expectedAnswer)) {
        p.fail("scenario.interventions.r1.query: contains-answer");
    }
    const insertAfterTurnId = p.staticId(
        r1.insertAfterTurnId,
        "scenario.interventions.r1.insertAfterTurnId",
        TURN_ID_RE,
    );
    if (!turnIds.has(insertAfterTurnId)) {
        p.fail("scenario.interventions.r1.insertAfterTurnId: unknown-turn");
    }
    const locatorIds = parseStringArray(
        r1.locatorIds,
        MEMORY_ID_RE,
        "scenario.interventions.r1.locatorIds",
    );
    /** A runner must pass the resolved ids as one locator-shaped query, and `scriptedCtxSearchTurn` rejects a larger set rather than chunking it — chunking would no longer be one tool turn. Enforcing the helper's bound here fails the declaration at freeze time instead of at R1 run time. commentlint: allow(JUDGE) */
    if (locatorIds.length > ID_SHAPED_QUERY_MAX_TOKENS) {
        p.fail("scenario.interventions.r1.locatorIds: exceeds-search-limit");
    }
    const r2 = p.record(interventions.r2, "scenario.interventions.r2");
    p.exact(r2, ["memories"], "scenario.interventions.r2");
    const memories = p.array(r2.memories, "scenario.interventions.r2.memories").map(
        (rawMemory, index) => {
            const label = `scenario.interventions.r2.memories[${index}]`;
            const memory = p.record(rawMemory, label);
            p.exact(memory, ["claim", "evidence"], label);
            return {
                claim: p.string(memory.claim, `${label}.claim`),
                evidence: p.string(memory.evidence, `${label}.evidence`),
            };
        },
    );
    /** R2 is the formation rung: with no gold memory to inject the arm reproduces R1 rather than measuring formation, so `R2 - R1` and `R3 - R2` both silently describe a rung that was never exercised. commentlint: allow(JUDGE) */
    if (memories.length === 0) {
        p.fail("scenario.interventions.r2.memories: empty");
    }
    const r3 = p.record(interventions.r3, "scenario.interventions.r3");
    p.exact(r3, ["evidence"], "scenario.interventions.r3");

    const absence = p.record(root.absencePrecondition, "scenario.absencePrecondition");
    p.exact(
        absence,
        ["evidenceTurnId", "minimumBallastBytes"],
        "scenario.absencePrecondition",
    );
    const evidenceTurnId = p.staticId(
        absence.evidenceTurnId,
        "scenario.absencePrecondition.evidenceTurnId",
        TURN_ID_RE,
    );
    if (!turnIds.has(evidenceTurnId)) {
        p.fail("scenario.absencePrecondition.evidenceTurnId: unknown-turn");
    }
    const minimumBallastBytes = p.integer(
        absence.minimumBallastBytes,
        "scenario.absencePrecondition.minimumBallastBytes",
        1,
    );
    const modelContextLimit = p.integer(
        root.modelContextLimit,
        "scenario.modelContextLimit",
        1,
    );
    /** `minimumBallastBytes` is byte-denominated while `modelContextLimit` is token-denominated; ballast below the window rendered at CHARS_PER_TOKEN cannot evict the evidence turn, leaving the absence precondition unsatisfiable. commentlint: allow(JUDGE) */
    if (minimumBallastBytes < modelContextLimit * CHARS_PER_TOKEN) {
        p.fail("scenario.absencePrecondition: ballast-below-context");
    }

    const restartArms = p.array(root.restartArms, "scenario.restartArms").map(
        (entry, index) => p.enumeration(entry, ARM_IDS, `scenario.restartArms[${index}]`),
    );
    p.unique(restartArms, "scenario.restartArms");
    if (restartArms.some((arm) => arm !== "mc-on")) {
        p.fail("scenario.restartArms: unsupported-arm");
    }
    if (typeof root.verifier !== "function") {
        p.fail("scenario.verifier: function-required");
    }

    return {
        scenarioId: p.staticId(root.scenarioId, "scenario.scenarioId", SCENARIO_ID_RE),
        familyId: p.staticId(root.familyId, "scenario.familyId", FAMILY_ID_RE),
        title: p.string(root.title, "scenario.title"),
        expectedAnswer,
        checks,
        criticalCheckIds,
        turnScript,
        interventions: {
            r1: {
                insertAfterTurnId,
                query: r1Query,
                locatorIds,
            },
            r2: { memories },
            r3: { evidence: p.string(r3.evidence, "scenario.interventions.r3.evidence") },
        },
        absencePrecondition: {
            evidenceTurnId,
            minimumBallastBytes,
        },
        modelContextLimit,
        restartArms,
        verifier: root.verifier as ScenarioVerifier,
    };
}

export function parseArmedCellResult(raw: unknown): ArmedCellResult {
    const root = p.record(raw, "cell");
    p.exact(root, [
        "armId",
        "checksPassed",
        "checksTotal",
        "criticalPassed",
        "criticalTotal",
        "invalidSuccess",
        "runHealth",
        "reasonCode",
    ], "cell");
    const result: ArmedCellResult = {
        armId: p.enumeration(root.armId, ARM_IDS, "cell.armId"),
        checksPassed: p.integer(root.checksPassed, "cell.checksPassed"),
        checksTotal: p.integer(root.checksTotal, "cell.checksTotal"),
        criticalPassed: p.integer(root.criticalPassed, "cell.criticalPassed"),
        criticalTotal: p.integer(root.criticalTotal, "cell.criticalTotal"),
        invalidSuccess: typeof root.invalidSuccess === "boolean"
            ? root.invalidSuccess
            : p.fail("cell.invalidSuccess: boolean-required"),
        runHealth: p.enumeration(root.runHealth, RUN_HEALTHS, "cell.runHealth"),
        reasonCode: root.reasonCode === null
            ? null
            : p.enumeration(root.reasonCode, REASON_CODES, "cell.reasonCode"),
    };
    if (result.checksPassed > result.checksTotal) {
        p.fail("cell.checks: passed-exceeds-total");
    }
    if (result.criticalPassed > result.criticalTotal) {
        p.fail("cell.critical: passed-exceeds-total");
    }
    /** `criticalCheckIds` is a declared subset of the scenario's checks, so a cell reporting more critical checks — or more critical successes — than overall ones is unreachable and would let an estimator credit critical success against a smaller or zero overall denominator. commentlint: allow(JUDGE) */
    if (result.criticalTotal > result.checksTotal) {
        p.fail("cell.critical: total-exceeds-checks");
    }
    if (result.criticalPassed > result.checksPassed) {
        p.fail("cell.critical: passed-exceeds-checks");
    }
    if ((result.runHealth === "completed") !== (result.reasonCode === null)) {
        p.fail("cell.reasonCode: health-mismatch");
    }
    if (
        result.reasonCode !== null &&
        !REASON_CODE_HEALTHS[result.reasonCode].includes(result.runHealth)
    ) {
        p.fail("cell.reasonCode: health-incompatible");
    }
    /** Every compared arm declares at least one check and at least one critical check, so a completed run cannot report an empty denominator; accepting one would make the paired deltas divide by nothing while looking like a valid measurement. commentlint: allow(JUDGE) */
    if (
        result.runHealth === "completed" &&
        (result.checksTotal === 0 || result.criticalTotal === 0)
    ) {
        p.fail("cell.checks: completed-requires-checks");
    }
    return result;
}

export function parsePairedDeltaManifest(raw: unknown): PairedDeltaManifest {
    const root = p.record(raw, "manifest");
    p.exact(root, ["schema", "scenarios"], "manifest");
    if (root.schema !== PAIRED_DELTA_MANIFEST_SCHEMA) {
        p.fail("manifest.schema: version-invalid");
    }
    const scenarios = p.array(root.scenarios, "manifest.scenarios").map((rawEntry, index) => {
        const label = `manifest.scenarios[${index}]`;
        const entry = p.record(rawEntry, label);
        p.exact(
            entry,
            ["scenarioId", "semanticFingerprint", "verifierBundleDigest", "runModes"],
            label,
        );
        const runModes = p.array(entry.runModes, `${label}.runModes`).map((mode, modeIndex) =>
            p.enumeration(mode, RUN_MODES, `${label}.runModes[${modeIndex}]`));
        p.unique(runModes, `${label}.runModes`);
        /** The manifest is the sole source of run-mode membership, so an entry claiming no mode is frozen into the pool yet selected by no calibration, weekly, or release run — silently removing a scenario from execution while every freeze check still passes. commentlint: allow(JUDGE) */
        if (runModes.length === 0) p.fail(`${label}.runModes: empty`);
        return {
            scenarioId: p.staticId(entry.scenarioId, `${label}.scenarioId`, SCENARIO_ID_RE),
            semanticFingerprint: p.hex64(entry.semanticFingerprint, `${label}.semanticFingerprint`),
            verifierBundleDigest: p.hex64(entry.verifierBundleDigest, `${label}.verifierBundleDigest`),
            runModes,
        };
    });
    p.unique(scenarios.map(({ scenarioId }) => scenarioId), "manifest.scenarios");
    return { schema: PAIRED_DELTA_MANIFEST_SCHEMA, scenarios };
}

export function validateCheckVector(
    declaration: ScenarioDeclaration,
    armId: ArmId,
    results: readonly CheckResult[],
): void {
    const expected = declaration.checks
        .filter(({ appliesToArms }) => appliesToArms.includes(armId))
        .map(({ id }) => id)
        .sort();
    /** Verifier output is untrusted input, not a parsed artifact: without this revalidation a verifier returning null or a malformed entry raises a bare TypeError that a runner records as a harness failure rather than a scenario failure. commentlint: allow(JUDGE) */
    const actual = p.array(results, "checkVector").map((entry, index) => {
        const label = `checkVector[${index}]`;
        const check = p.record(entry, label);
        p.exact(check, ["id", "passed"], label);
        if (typeof check.passed !== "boolean") {
            p.fail(`${label}.passed: boolean-required`);
        }
        return p.staticId(check.id, `${label}.id`, CHECK_ID_RE);
    });
    p.unique(actual, "checkVector");
    if (
        actual.length !== expected.length ||
        [...actual].sort().some((id, index) => id !== expected[index])
    ) {
        p.fail("checkVector: declaration-mismatch");
    }
}
