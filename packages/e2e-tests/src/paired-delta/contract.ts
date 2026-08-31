import { makeContractPrimitives } from "../contract-primitives";

export const ARM_IDS = ["mc-on", "mc-off", "compaction", "r1", "r2", "r3"] as const;
export type ArmId = (typeof ARM_IDS)[number];
export const PRIMARY_ARM_IDS = ["mc-on", "mc-off", "compaction"] as const;
export type PrimaryArmId = (typeof PRIMARY_ARM_IDS)[number];
export const REGRET_ARM_IDS = ["mc-on", "r1", "r2", "r3"] as const;

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
}

export type ScenarioVerifier = (
    context: VerifierContext,
) => CheckResult[] | Promise<CheckResult[]>;

export interface ScenarioDeclaration {
    scenarioId: string;
    familyId: string;
    title: string;
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

export type PrimaryArmCells = Partial<Record<PrimaryArmId, ArmedCellResult>>;
export type RegretLadder = Partial<Record<ArmId, ArmedCellResult>>;

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
    const checkIds = new Set(checks.map(({ id }) => id));
    if (criticalCheckIds.some((id) => !checkIds.has(id))) {
        p.fail("scenario.criticalCheckIds: unknown-check");
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
    const insertAfterTurnId = p.staticId(
        r1.insertAfterTurnId,
        "scenario.interventions.r1.insertAfterTurnId",
        TURN_ID_RE,
    );
    if (!turnIds.has(insertAfterTurnId)) {
        p.fail("scenario.interventions.r1.insertAfterTurnId: unknown-turn");
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
        checks,
        criticalCheckIds,
        turnScript,
        interventions: {
            r1: {
                insertAfterTurnId,
                query: p.string(r1.query, "scenario.interventions.r1.query"),
                locatorIds: parseStringArray(
                    r1.locatorIds,
                    MEMORY_ID_RE,
                    "scenario.interventions.r1.locatorIds",
                ),
            },
            r2: { memories },
            r3: { evidence: p.string(r3.evidence, "scenario.interventions.r3.evidence") },
        },
        absencePrecondition: {
            evidenceTurnId,
            minimumBallastBytes: p.integer(
                absence.minimumBallastBytes,
                "scenario.absencePrecondition.minimumBallastBytes",
                1,
            ),
        },
        modelContextLimit: p.integer(root.modelContextLimit, "scenario.modelContextLimit", 1),
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
    if ((result.runHealth === "completed") !== (result.reasonCode === null)) {
        p.fail("cell.reasonCode: health-mismatch");
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
    const actual = results.map(({ id }) => id);
    p.unique(actual, "checkVector");
    if (
        actual.length !== expected.length ||
        [...actual].sort().some((id, index) => id !== expected[index])
    ) {
        p.fail("checkVector: declaration-mismatch");
    }
    if (results.some(({ passed }) => typeof passed !== "boolean")) {
        p.fail("checkVector: passed-boolean-required");
    }
}
