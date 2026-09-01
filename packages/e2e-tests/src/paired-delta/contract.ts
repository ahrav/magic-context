import { CHARS_PER_TOKEN } from "../ballast";
import { makeContractPrimitives } from "../contract-primitives";
import {
    boundDynamicField,
    ID_SHAPED_QUERY_MAX_TOKENS,
} from "../../../plugin/src/features/magic-context/search-bounds";
import { normalizeMemoryContent } from "../../../plugin/src/features/magic-context/memory/normalize-hash";
import { PUBLIC_CLAIM_ID_PREFIX } from "../../../plugin/src/features/magic-context/memory/claim-operation-contract";
import {
    SCRIPTED_SEARCH_FOLLOW_UP,
    SCRIPTED_SEARCH_PROMPT_PREFIX,
} from "../oracle-arms/scripted-ctx-search";

export const ARM_IDS = ["mc-on", "mc-off", "compaction", "r1", "r2", "r3"] as const;
export type ArmId = (typeof ARM_IDS)[number];
/** The arms of the primary comparison: memory on, memory off, and native compaction. */
export const PRIMARY_ARM_IDS = ["mc-on", "mc-off", "compaction"] as const;
/** The arms of the regret ladder, in ascending order of oracle assistance. */
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

export const ANSWER_MATCHES = ["exact", "case-insensitive"] as const;
export type AnswerMatch = (typeof ANSWER_MATCHES)[number];

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

/** Canonical form before folding: composed and decomposed spellings render identically, so a decomposed answer in a turn is a leak of the composed gold. commentlint: allow(JUDGE) */
const canonicalFold = (value: string): string => value.normalize("NFC").toLowerCase();

/** The production claim encoder rejects a lone surrogate, so a declaration carrying one is unseedable. Uses the runtime predicate where present rather than restating the surrogate ranges. commentlint: allow(JUDGE) */
function isWellFormedUnicode(value: string): boolean {
    const wellFormed = (value as { isWellFormed?: () => boolean }).isWellFormed;
    if (typeof wellFormed === "function") return wellFormed.call(value);
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

/** A leak asks "could the model read the gold here", so any occurrence counts and case is folded: a model can re-case what it reads. Deliberately wider than the complete-value match used for gold presence, because the two fail safe in opposite directions. Shared so the freeze-time guard and a runner's pre-search gate cannot diverge. commentlint: allow(JUDGE) */
export function revealsAnswer(expectedAnswer: string, text: string): boolean {
    return canonicalFold(text).includes(canonicalFold(expectedAnswer));
}

export class PairedDeltaContractError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: readonly string[]) {
        super(diagnostics.join("; "));
        this.name = "PairedDeltaContractError";
        this.diagnostics = diagnostics;
    }
}

const p = makeContractPrimitives(PairedDeltaContractError);

export interface TurnDeclaration {
    id: string;
    role: "user" | "assistant";
    content: string;
}

export interface ScenarioInterventions {
    r1: {
        insertAfterTurnId: string;
        /** Symbolic `mem-*` handles, never wire ids: a `mcm_<32hex>` public claim id is assigned by `seedGoldMemories` per run, so freezing one would freeze a value that never resolves. A runner must map each handle to the seeded `publicClaimId` before calling `scriptedCtxSearchTurn` and must assert the wire result against that resolved id — passing a handle through unmapped demotes the turn to a text search that cannot serve project-memory claims, silently collapsing R1 onto R0. commentlint: allow(JUDGE) */
        locatorIds: string[];
    };
    r2: {
        memories: Array<{ claim: string; evidence: string }>;
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
    /** Whether reproducing the answer's exact casing is part of the gold. */
    answerMatch: AnswerMatch;
    checks: string[];
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
    /** Every call site names a set the lane must act on, and every downstream predicate over an empty list is vacuously true. commentlint: allow(JUDGE) */
    if (result.length === 0) p.fail(`${label}: empty`);
    return result;
}

export function parseScenarioDeclaration(raw: unknown): ScenarioDeclaration {
    const root = p.record(raw, "scenario");
    p.exact(root, [
        "scenarioId",
        "familyId",
        "title",
        "expectedAnswer",
        "answerMatch",
        "checks",
        "criticalCheckIds",
        "turnScript",
        "interventions",
        "absencePrecondition",
        "modelContextLimit",
        "restartArms",
        "verifier",
    ], "scenario");

    /** A flat id list, not per-arm membership: `ArmedCellResult` keeps only aggregate counts, so a check scored on some compared arms and not others gives them different denominators and the paired subtraction compares unlike ratios. Every arm therefore scores the same set, and an arm-specific condition belongs in a validity gate that decides `runHealth`. `parseStringArray` also rejects an empty list, so a scenario always has a denominator. commentlint: allow(JUDGE) */
    const checks = parseStringArray(root.checks, CHECK_ID_RE, "scenario.checks");
    const criticalCheckIds = parseStringArray(
        root.criticalCheckIds,
        CHECK_ID_RE,
        "scenario.criticalCheckIds",
    );
    const checkIds = new Set(checks);
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
    p.exact(interventions, ["r1", "r2"], "scenario.interventions");
    const r1 = p.record(interventions.r1, "scenario.interventions.r1");
    p.exact(r1, ["insertAfterTurnId", "locatorIds"], "scenario.interventions.r1");
    const expectedAnswer = p.string(root.expectedAnswer, "scenario.expectedAnswer");
    /** Verifiers compare against the model's trimmed file contents, and `p.string` preserves the authored bytes so a fingerprint stays over what was written. A padded answer is therefore unmatchable in every arm; reject it here rather than trimming and changing the covered bytes. commentlint: allow(JUDGE) */
    if (expectedAnswer !== expectedAnswer.trim()) {
        p.fail("scenario.expectedAnswer: not-trimmed");
    }
    /** Every resolved locator begins with this prefix, so an answer occurring inside it leaks from every id a reseed could produce — the runner's pre-search gate would never clear and the scenario could never execute. Only the prefix is invariant; a collision with the random hex is cleared by reseeding. commentlint: allow(JUDGE) */
    if (revealsAnswer(expectedAnswer, PUBLIC_CLAIM_ID_PREFIX)) {
        p.fail("scenario.expectedAnswer: collides-with-claim-id-prefix");
    }
    /** The R1 search turn adds this wrapper text to the transcript whatever the query resolves to, so an answer occurring in it is readable by the later probe without any retrieval — and unlike an id collision, no reseed can clear it. commentlint: allow(JUDGE) */
    /** Composed, not each part alone: the turn emits `${SCRIPTED_SEARCH_PROMPT_PREFIX}${query}` and every query starts with the claim-id prefix, so an answer straddling that join is revealed by a prompt neither string reveals by itself. commentlint: allow(JUDGE) */
    if ([
        `${SCRIPTED_SEARCH_PROMPT_PREFIX}${PUBLIC_CLAIM_ID_PREFIX}`,
        SCRIPTED_SEARCH_FOLLOW_UP,
    ].some((text) => revealsAnswer(expectedAnswer, text))) {
        p.fail("scenario.expectedAnswer: revealed-by-search-prompt");
    }
    const answerMatch = p.enumeration(root.answerMatch, ANSWER_MATCHES, "scenario.answerMatch");
    const leaks = (text: string): boolean => revealsAnswer(expectedAnswer, text);
    /** Gold presence asks "can the arm derive the exact answer here", so only a complete value counts and a narrower match is the conservative one: `147` does not supply `47`. It also honors the declared casing policy, unlike the leak guard: under `exact` the verifier rejects a differently-cased answer, so folding here would certify gold the arm can never produce. Boundaries are code-point aware through `u`-flag lookaround rather than index arithmetic, which would read one UTF-16 unit and see an astral letter's low surrogate as a separator. Letters, numbers, combining marks, `_`, `-`, `/`, and `\` are value characters, so a longer path cannot satisfy a path answer under either separator; `.`, `;`, and `,` are not, so a trailing sentence period still matches. commentlint: allow(JUDGE) */
    const suppliesAnswer = (text: string): boolean => {
        const fold = (value: string): string =>
            answerMatch === "exact" ? value.normalize("NFC") : canonicalFold(value);
        const escaped = fold(expectedAnswer).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const valueChar = "[\\p{L}\\p{N}\\p{M}_/\\\\-]";
        /** A `.` bounded by value characters continues the value rather than ending it, so `47.5` does not supply `47`, while a terminal `.` still does. commentlint: allow(JUDGE) */
        const before = `(?<!${valueChar})(?<!${valueChar}\\.)`;
        const after = `(?!${valueChar})(?!\\.${valueChar})`;
        return new RegExp(`${before}${escaped}${after}`, "u").test(fold(text));
    };
    const insertAfterTurnId = p.staticId(
        r1.insertAfterTurnId,
        "scenario.interventions.r1.insertAfterTurnId",
        TURN_ID_RE,
    );
    if (!turnIds.has(insertAfterTurnId)) {
        p.fail("scenario.interventions.r1.insertAfterTurnId: unknown-turn");
    }
    const insertIndex = turnScript.findIndex(({ id }) => id === insertAfterTurnId);
    /** `scriptedCtxSearchTurn` only performs the fixed oracle exchange; a later user turn has to consume the retrieved result and write the answer file, so without one R1 fails even when retrieval succeeded and its cell is not comparable with the other arms. commentlint: allow(JUDGE) */
    if (!turnScript.slice(insertIndex + 1).some(({ role }) => role === "user")) {
        p.fail("scenario.interventions.r1.insertAfterTurnId: no-following-probe");
    }
    /** From the insertion turn inclusive: the ballast precedes that turn, so an answer repeated there is not buried either and stays visible to every arm. Runs after the ordering and evidence-gold rules so a misplaced evidence turn reports its own diagnostic instead of surfacing here. commentlint: allow(JUDGE) */
    const postInsertionLeak = (): void => {
        if (
            turnScript.slice(insertIndex).some(({ content }) => leaks(content))
        ) {
            p.fail("scenario.turnScript: post-insertion-answer-leak");
        }
    };
    const locatorIds = parseStringArray(
        r1.locatorIds,
        MEMORY_ID_RE,
        "scenario.interventions.r1.locatorIds",
    );
    /** A runner must pass the resolved ids as one locator-shaped query, and `scriptedCtxSearchTurn` rejects a larger set rather than chunking it — chunking would no longer be one tool turn. Enforcing the helper's bound here fails the declaration at freeze time instead of at R1 run time. commentlint: allow(JUDGE) */
    if (locatorIds.length > ID_SHAPED_QUERY_MAX_TOKENS) {
        p.fail("scenario.interventions.r1.locatorIds: exceeds-search-limit");
    }
    /** The resolved handles become the search query, which `scriptedCtxSearchTurn` interpolates into the model-visible prompt, so a handle named after the answer would let R1 pass its critical check with no retrieval. commentlint: allow(JUDGE) */
    if (locatorIds.some(leaks)) {
        p.fail("scenario.interventions.r1.locatorIds: contains-answer");
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
    /** The seeder resolves rows with equal normalized content onto one claim and attaches the rest as extra provenance, so claims differing only by casing or whitespace still collapse to a single `publicClaimId`: R1 would satisfy several handles from one delivered row while R2 exercised fewer gold memories than declared. Keyed through the production normalizer so the two identities cannot drift. commentlint: allow(JUDGE) */
    p.unique(
        memories.map(({ claim }) => normalizeMemoryContent(claim)),
        "scenario.interventions.r2.memories",
    );
    /** R2 seeds these as verified project memory and the `<project-memory>` renderer exposes the claim, not this declaration's `evidence` provenance. With no claim carrying the answer the arm receives no gold and reproduces R1, so `R2 - R1` and `R3 - R2` describe a malformed intervention. One claim suffices: gold may be spread across a multi-locator set. commentlint: allow(JUDGE) */
    /** Every claim must survive rendering byte-for-byte. `ctx_search` bounds each field to MAX_RENDER_FIELD_BYTES, so a longer claim reaches R1 truncated while R3 — derived from the raw claims — receives it whole, and the arms then compare different gold. Bounding the claim also keeps it far inside any configured R2 injection budget, which skips a claim it cannot fit rather than truncating it. commentlint: allow(JUDGE) */
    for (const [index, { claim }] of memories.entries()) {
        const label = `scenario.interventions.r2.memories[${index}].claim`;
        if (boundDynamicField(claim) !== claim) p.fail(`${label}: exceeds-render-bound`);
        /** `seedGoldMemories` writes through the production claim encoder, which rejects a lone surrogate, so an ill-formed claim freezes but can never be seeded. commentlint: allow(JUDGE) */
        if (!isWellFormedUnicode(claim)) p.fail(`${label}: unicode-ill-formed`);
    }
    /** The whole gold payload must fit what one rendered field carries. R2 admits claims against a configured `injection_budget_tokens` and skips any that does not fit, leaving R2 short while R1 and R3 receive the full set; the exact cost needs a seeded snapshot and the renderer's accounting, so this is a deliberately conservative proxy that stays well inside the 500-token floor the schema permits. The runner owns the exact check against its own budget. commentlint: allow(JUDGE) */
    const payload = memories.map(({ claim }) => claim).join("\n");
    if (boundDynamicField(payload) !== payload) {
        p.fail("scenario.interventions.r2.memories: payload-exceeds-render-bound");
    }
    if (!memories.some(({ claim }) => suppliesAnswer(claim))) {
        p.fail("scenario.interventions.r2.memories: answer-absent");
    }
    /** `r2.memories` is the declaration's only gold, so it is also what a runner seeds and resolves `r1.locatorIds` against. Unequal lengths leave a handle with no `publicClaimId` to map to and make R1 and R2 compare different gold sets; pairing is positional. commentlint: allow(JUDGE) */
    if (locatorIds.length !== memories.length) {
        p.fail("scenario.interventions.r1.locatorIds: memory-cardinality-mismatch");
    }

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
    /** Ballast can only bury evidence that already entered the transcript. Evidence supplied at or after the R1 insertion point stays directly available to the probe in every arm, so the baseline answers without retrieval and the absence comparison the lane exists to measure collapses. commentlint: allow(JUDGE) */
    const evidenceIndex = turnScript.findIndex(({ id }) => id === evidenceTurnId);
    if (evidenceIndex >= insertIndex) {
        p.fail("scenario.absencePrecondition.evidenceTurnId: not-before-r1-insertion");
    }
    /** The mc-on arm forms and later retrieves memory from this turn alone, so an evidence turn that does not carry the answer leaves it nothing to preserve — its failures would measure a missing premise rather than preservation or retrieval. commentlint: allow(JUDGE) */
    if (!suppliesAnswer(turnScript[evidenceIndex]!.content)) {
        p.fail("scenario.absencePrecondition.evidenceTurnId: answer-absent");
    }
    postInsertionLeak();
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
        answerMatch,
        checks,
        criticalCheckIds,
        turnScript,
        interventions: {
            r1: {
                insertAfterTurnId,
                locatorIds,
            },
            r2: { memories },
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
    /** An empty pool matches an empty registry, so a removed or mis-generated index would freeze as valid and leave every run mode with no measurements instead of a contract failure. commentlint: allow(JUDGE) */
    if (scenarios.length === 0) p.fail("manifest.scenarios: empty");
    /** The registry takes membership solely from here and `assertFrozenPool` permits run-mode edits without drift, so a mode losing its last member would run with no measurements while every freeze check stayed green. This constrains the pool to cover each mode once, not any entry to carry a particular mode. commentlint: allow(JUDGE) */
    const covered = new Set(scenarios.flatMap(({ runModes }) => runModes));
    if (RUN_MODES.some((mode) => !covered.has(mode))) {
        p.fail("manifest.scenarios: run-mode-uncovered");
    }
    return { schema: PAIRED_DELTA_MANIFEST_SCHEMA, scenarios };
}

/** The R3 arm receives its gold in the prompt rather than as memory, so its content is exactly the R2 claim set — deriving it keeps `R3 - R2` a comparison of representation instead of also comparing what each arm was told. commentlint: allow(JUDGE) */
export function r3PromptEvidence(declaration: ScenarioDeclaration): string {
    return declaration.interventions.r2.memories.map(({ claim }) => claim).join("\n");
}

export function validateCheckVector(
    declaration: ScenarioDeclaration,
    results: readonly CheckResult[],
): void {
    const expected = [...declaration.checks].sort();
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
