/**
 * Historian structural eval lane — versioned artifact contract.
 *
 * A scenario file carries three artifacts in one JSON document: an authored
 * transcript (fixed input), gold expectations over the injection-visible
 * claim set (the surface `readAuthorizedClaimMemorySnapshot` reads), and
 * hidden probes constrained to structured answers. Parsing is fail-closed:
 * unknown keys, free-text probe answers, and literal claim-id golds reject
 * with named diagnostics that never echo artifact values.
 *
 * Scenario identity is a canonical-JSON fingerprint over the semantic
 * payload only. Harness-owned trigger pressure (context limits, per-turn
 * usage tokens, ballast) is deliberately outside the fingerprint so tuning
 * the pressure recipe never changes a frozen scenario's identity.
 */

import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import {
    PRIVACY_POLICY_VERSION,
    SANITIZER_VERSION,
} from "../../../plugin/scripts/retrieval-benchmark/privacy";
import {
    deriveHistorianChunkTokens,
    resolveHistorianContextLimit,
} from "../../../plugin/src/hooks/magic-context/derive-budgets";
import { estimateTokens } from "../../../plugin/src/shared/token-estimator";
import { V2_MEMORY_CATEGORIES } from "../../../plugin/src/features/magic-context/memory/constants";

export const SCENARIO_SCHEMA = "historian-eval-scenario/v1";
export const MANIFEST_SCHEMA = "historian-eval-manifest/v1";
export const RELEASE_VERSION_RE = /^v\d+$/;

export const HEX64_RE = /^[0-9a-f]{64}$/;
export const SCENARIO_ID_RE = /^hse-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const EXPECTED_CLAIM_ID_RE = /^exp-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const EXPECTED_ABSENT_ID_RE = /^abs-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PROBE_ID_RE = /^probe-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The authored hard-negative families (R2). Every scenario declares which
 * families it exercises; the freeze lint requires each declared family to
 * carry at least one expected-absent predicate tagged with it, so a family
 * can never be claimed without a checkable non-promotion expectation.
 */
export const HARD_NEGATIVE_FAMILIES = [
    "proposed-but-rejected",
    "explored-never-accepted",
    "assistant-speculation",
    "user-correction",
    "current-vs-historical",
    "prompt-injection",
    "conflicting-evidence",
] as const;
export type HardNegativeFamily = (typeof HARD_NEGATIVE_FAMILIES)[number];

/** Structured-only probe answers (KD2): no free text ever reaches scoring. */
export const PROBE_ANSWER_TYPES = ["exact", "multiple-choice", "claim-id"] as const;

/** Widened for `includes` checks against arbitrary authored category strings. */
const MEMORY_CATEGORIES: readonly string[] = V2_MEMORY_CATEGORIES;

export class HistorianEvalContractError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: readonly string[]) {
        super([...diagnostics].sort().join("; "));
        this.diagnostics = [...diagnostics].sort();
    }
}

function fail(code: string): never {
    throw new HistorianEvalContractError([code]);
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`${label}: object-required`);
    }
    return value as Record<string, unknown>;
}

function exact(recordValue: Record<string, unknown>, keys: readonly string[], label: string): void {
    const actual = Object.keys(recordValue).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label}: fields-invalid`);
    }
}

function string(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) fail(`${label}: string-invalid`);
    return value;
}

function staticId(value: unknown, label: string, pattern: RegExp): string {
    const result = string(value, label);
    if (!pattern.test(result)) fail(`${label}: id-invalid`);
    return result;
}

function hex64(value: unknown, label: string): string {
    const result = string(value, label);
    if (!HEX64_RE.test(result)) fail(`${label}: fingerprint-invalid`);
    return result;
}

export function enumeration<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${label}: enum-invalid`);
    return value as T;
}

function array(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) fail(`${label}: array-required`);
    return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${label}: integer-invalid`);
    return value as number;
}

function unique(values: readonly string[], label: string): void {
    if (new Set(values).size !== values.length) fail(`${label}: duplicate`);
}

/** One scripted exchange: the user prompt and the mock main-agent reply. */
export interface TranscriptTurn {
    user: string;
    assistant: string;
}

/**
 * Content predicates are normalized-substring matchers by design (one form;
 * no free text, no regex until a scenario proves the need). Normalization is
 * trim + case-fold + whitespace-collapse so the live historian's incidental
 * wording drift does not flake the match.
 */
export interface ContentPredicate {
    kind: "normalized-substring";
    value: string;
}

export interface ExpectedClaim {
    id: string;
    category: string;
    predicate: ContentPredicate;
    /**
     * Inclusive turn-index range the fact is authored into. The probe tier's
     * leakage gate uses this to assert no gold-fact-bearing raw range
     * survives the injection splice.
     */
    sourceTurnRange: [number, number];
}

export interface ExpectedAbsent {
    id: string;
    family: HardNegativeFamily;
    predicate: ContentPredicate;
}

export interface CompartmentExpectations {
    /** Persisted compartments the scenario must produce, at minimum. */
    minCount: number;
}

export interface GoldExpectations {
    expectedClaims: ExpectedClaim[];
    expectedAbsent: ExpectedAbsent[];
    compartments: CompartmentExpectations;
}

export type Probe =
    | {
          id: string;
          question: string;
          answerType: "exact";
          goldAnswer: string;
          /** Gold expected-claim backing this probe; enables the trimmed-by-injection-budget ERROR (KTD6). */
          sourceClaimRef?: string;
      }
    | {
          id: string;
          question: string;
          answerType: "multiple-choice";
          choices: string[];
          goldAnswer: string;
          sourceClaimRef?: string;
      }
    | { id: string; question: string; answerType: "claim-id"; expectedClaimRef: string };

/**
 * Harness-owned trigger pressure (KTD3). Named, not improvised — but outside
 * the scenario fingerprint: tuning pressure must not re-identify a frozen
 * scenario.
 */
export interface TriggerRecipe {
    /** Runs the scenario declares (1 or 2). A declared run never firing is ERROR. */
    expectedHistorianRuns: number;
    /** Mock model context limit the harness pins for threshold pressure. */
    modelContextLimit: number;
    /** Scripted usage tokens for ordinary build turns. */
    usageTokensPerTurn: number;
    /** Scripted usage tokens for the threshold-crossing spike turn. */
    spikeUsageTokens: number;
    /** Deterministic ballast tokens appended to each user turn. */
    ballastTokensPerTurn: number;
    /** Safety margin the freeze lint subtracts from the historian chunk budget. */
    headroomMarginTokens: number;
}

export interface HistorianEvalScenario {
    schema: typeof SCENARIO_SCHEMA;
    id: string;
    title: string;
    families: HardNegativeFamily[];
    transcript: {
        turns: TranscriptTurn[];
        /** Index of the first epilogue turn (KTD3 discard-last healing). */
        epilogueStartIndex: number;
    };
    trigger: TriggerRecipe;
    gold: GoldExpectations;
    probes: Probe[];
}

function parsePredicate(raw: unknown, label: string): ContentPredicate {
    const value = record(raw, label);
    exact(value, ["kind", "value"], label);
    return {
        kind: enumeration(value.kind, ["normalized-substring"], `${label}.kind`),
        value: string(value.value, `${label}.value`),
    };
}

function parseTurn(raw: unknown, label: string): TranscriptTurn {
    const value = record(raw, label);
    exact(value, ["user", "assistant"], label);
    return {
        user: string(value.user, `${label}.user`),
        assistant: string(value.assistant, `${label}.assistant`),
    };
}

function parseExpectedClaim(raw: unknown, label: string, turnCount: number): ExpectedClaim {
    const value = record(raw, label);
    exact(value, ["id", "category", "predicate", "sourceTurnRange"], label);
    const range = array(value.sourceTurnRange, `${label}.sourceTurnRange`);
    if (range.length !== 2) fail(`${label}.sourceTurnRange: range-invalid`);
    const start = integer(range[0], `${label}.sourceTurnRange[0]`);
    const end = integer(range[1], `${label}.sourceTurnRange[1]`);
    if (start > end || end >= turnCount) fail(`${label}.sourceTurnRange: range-invalid`);
    return {
        id: staticId(value.id, `${label}.id`, EXPECTED_CLAIM_ID_RE),
        category: string(value.category, `${label}.category`),
        predicate: parsePredicate(value.predicate, `${label}.predicate`),
        sourceTurnRange: [start, end],
    };
}

function parseExpectedAbsent(raw: unknown, label: string): ExpectedAbsent {
    const value = record(raw, label);
    exact(value, ["id", "family", "predicate"], label);
    return {
        id: staticId(value.id, `${label}.id`, EXPECTED_ABSENT_ID_RE),
        family: enumeration(value.family, HARD_NEGATIVE_FAMILIES, `${label}.family`),
        predicate: parsePredicate(value.predicate, `${label}.predicate`),
    };
}

function parseProbe(raw: unknown, label: string): Probe {
    const value = record(raw, label);
    const answerType = enumeration(value.answerType, PROBE_ANSWER_TYPES, `${label}.answerType`);
    const id = staticId(value.id, `${label}.id`, PROBE_ID_RE);
    const question = string(value.question, `${label}.question`);
    const sourceClaimRef =
        "sourceClaimRef" in value
            ? staticId(value.sourceClaimRef, `${label}.sourceClaimRef`, EXPECTED_CLAIM_ID_RE)
            : undefined;
    if (answerType === "exact") {
        exact(
            value,
            sourceClaimRef === undefined
                ? ["id", "question", "answerType", "goldAnswer"]
                : ["id", "question", "answerType", "goldAnswer", "sourceClaimRef"],
            label,
        );
        return {
            id,
            question,
            answerType,
            goldAnswer: string(value.goldAnswer, `${label}.goldAnswer`),
            ...(sourceClaimRef === undefined ? {} : { sourceClaimRef }),
        };
    }
    if (answerType === "multiple-choice") {
        exact(
            value,
            sourceClaimRef === undefined
                ? ["id", "question", "answerType", "choices", "goldAnswer"]
                : ["id", "question", "answerType", "choices", "goldAnswer", "sourceClaimRef"],
            label,
        );
        const choices = array(value.choices, `${label}.choices`).map((entry, index) =>
            string(entry, `${label}.choices[${index}]`),
        );
        if (choices.length < 2) fail(`${label}.choices: choices-invalid`);
        unique(choices, `${label}.choices`);
        const goldAnswer = string(value.goldAnswer, `${label}.goldAnswer`);
        if (!choices.includes(goldAnswer)) fail(`${label}.goldAnswer: not-a-choice`);
        return {
            id,
            question,
            answerType,
            choices,
            goldAnswer,
            ...(sourceClaimRef === undefined ? {} : { sourceClaimRef }),
        };
    }
    // claim-id: gold names a gold expected-claim reference, never a literal
    // runtime id — the scorer resolves it against the recorded injected set.
    exact(value, ["id", "question", "answerType", "expectedClaimRef"], label);
    return {
        id,
        question,
        answerType,
        expectedClaimRef: staticId(value.expectedClaimRef, `${label}.expectedClaimRef`, EXPECTED_CLAIM_ID_RE),
    };
}

function parseTrigger(raw: unknown, label: string): TriggerRecipe {
    const value = record(raw, label);
    exact(
        value,
        [
            "expectedHistorianRuns",
            "modelContextLimit",
            "usageTokensPerTurn",
            "spikeUsageTokens",
            "ballastTokensPerTurn",
            "headroomMarginTokens",
        ],
        label,
    );
    const expectedHistorianRuns = integer(value.expectedHistorianRuns, `${label}.expectedHistorianRuns`, 1);
    if (expectedHistorianRuns > 2) fail(`${label}.expectedHistorianRuns: run-budget-exceeded`);
    // Operational maxima: the lint renders ~4 chars per ballast token and the
    // runner drives one turn per padding unit, so unbounded pressure numbers
    // could hang lint or CI before any semantic check rejects them.
    const bounded = (key: string, minimum: number, maximum: number): number => {
        const result = integer(value[key], `${label}.${key}`, minimum);
        if (result > maximum) fail(`${label}.${key}: above-operational-maximum`);
        return result;
    };
    return {
        expectedHistorianRuns,
        modelContextLimit: bounded("modelContextLimit", 1, 10_000_000),
        usageTokensPerTurn: bounded("usageTokensPerTurn", 1, 10_000_000),
        spikeUsageTokens: bounded("spikeUsageTokens", 1, 10_000_000),
        ballastTokensPerTurn: bounded("ballastTokensPerTurn", 0, 50_000),
        headroomMarginTokens: bounded("headroomMarginTokens", 0, 100_000),
    };
}

export function parseScenario(raw: unknown, label = "scenario"): HistorianEvalScenario {
    const root = record(raw, label);
    exact(root, ["schema", "id", "title", "families", "transcript", "trigger", "gold", "probes"], label);
    if (root.schema !== SCENARIO_SCHEMA) fail(`${label}.schema: version-invalid`);
    const families = array(root.families, `${label}.families`).map((entry, index) =>
        enumeration(entry, HARD_NEGATIVE_FAMILIES, `${label}.families[${index}]`),
    );
    if (families.length === 0) fail(`${label}.families: empty`);
    unique(families, `${label}.families`);

    const transcriptValue = record(root.transcript, `${label}.transcript`);
    exact(transcriptValue, ["turns", "epilogueStartIndex"], `${label}.transcript`);
    const turns = array(transcriptValue.turns, `${label}.transcript.turns`).map((entry, index) =>
        parseTurn(entry, `${label}.transcript.turns[${index}]`),
    );
    if (turns.length < 2) fail(`${label}.transcript.turns: too-few-turns`);
    const epilogueStartIndex = integer(transcriptValue.epilogueStartIndex, `${label}.transcript.epilogueStartIndex`, 1);
    if (epilogueStartIndex >= turns.length) fail(`${label}.transcript.epilogueStartIndex: out-of-range`);

    const goldValue = record(root.gold, `${label}.gold`);
    exact(goldValue, ["expectedClaims", "expectedAbsent", "compartments"], `${label}.gold`);
    const expectedClaims = array(goldValue.expectedClaims, `${label}.gold.expectedClaims`).map((entry, index) =>
        parseExpectedClaim(entry, `${label}.gold.expectedClaims[${index}]`, turns.length),
    );
    unique(
        expectedClaims.map((claim) => claim.id),
        `${label}.gold.expectedClaims`,
    );
    const expectedAbsent = array(goldValue.expectedAbsent, `${label}.gold.expectedAbsent`).map((entry, index) =>
        parseExpectedAbsent(entry, `${label}.gold.expectedAbsent[${index}]`),
    );
    unique(
        expectedAbsent.map((absent) => absent.id),
        `${label}.gold.expectedAbsent`,
    );
    const compartmentsValue = record(goldValue.compartments, `${label}.gold.compartments`);
    exact(compartmentsValue, ["minCount"], `${label}.gold.compartments`);
    const compartments: CompartmentExpectations = {
        minCount: integer(compartmentsValue.minCount, `${label}.gold.compartments.minCount`, 1),
    };

    const probes = array(root.probes, `${label}.probes`).map((entry, index) =>
        parseProbe(entry, `${label}.probes[${index}]`),
    );
    unique(
        probes.map((probe) => probe.id),
        `${label}.probes`,
    );
    const expectedClaimIds = new Set(expectedClaims.map((claim) => claim.id));
    for (const probe of probes) {
        const reference =
            probe.answerType === "claim-id" ? probe.expectedClaimRef : (probe.sourceClaimRef ?? null);
        if (reference !== null && !expectedClaimIds.has(reference)) {
            fail(`${label}.probes.${probe.id}: dangling-reference`);
        }
    }

    return {
        schema: SCENARIO_SCHEMA,
        id: staticId(root.id, `${label}.id`, SCENARIO_ID_RE),
        title: string(root.title, `${label}.title`),
        families,
        transcript: { turns, epilogueStartIndex },
        trigger: parseTrigger(root.trigger, `${label}.trigger`),
        gold: { expectedClaims, expectedAbsent, compartments },
        probes,
    };
}

/**
 * Scenario identity: canonical fingerprint over the semantic payload.
 * Trigger pressure is harness-owned (R5/KTD3) and excluded, except the
 * declared run count, which is scenario semantics (a run that never fires
 * is ERROR).
 */
export function scenarioFingerprint(scenario: HistorianEvalScenario): string {
    return canonicalFingerprint({
        schema: scenario.schema,
        id: scenario.id,
        title: scenario.title,
        families: scenario.families,
        transcript: scenario.transcript,
        expectedHistorianRuns: scenario.trigger.expectedHistorianRuns,
        gold: scenario.gold,
        probes: scenario.probes,
    });
}

/** Normalization applied to both predicate values and candidate content. */
export function normalizeContent(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function predicateMatches(predicate: ContentPredicate, content: string): boolean {
    return normalizeContent(content).includes(normalizeContent(predicate.value));
}

/**
 * The raw text mass the chunk builder will see for one turn. Mirrors the
 * runner's rendering (authored text plus deterministic ballast) so the
 * freeze lint's headroom check measures what actually reaches the historian.
 */
function renderedTranscriptText(scenario: HistorianEvalScenario): string {
    const lines: string[] = [];
    scenario.transcript.turns.forEach((turn, index) => {
        lines.push(`[${index * 2 + 1}] user: ${turn.user} ${ballastText(scenario.trigger.ballastTokensPerTurn, index)}`);
        lines.push(`[${index * 2 + 2}] assistant: ${turn.assistant}`);
    });
    return lines.join("\n");
}

/**
 * Deterministic ballast: same turn index → same bytes, every run (R5).
 * Varied word bank because BPE tokenizers degrade on degenerate repeats;
 * ~4 chars/token keeps the size math stable (see TestHarness.ballast).
 */
export function ballastText(tokens: number, turnIndex: number): string {
    if (tokens <= 0) return "";
    const words = [
        "boundary",
        "historian",
        "compartment",
        "schedule",
        "pressure",
        "tokens",
        "window",
        "publish",
        "transform",
        "session",
        "marker",
        "budget",
        "eligible",
        "protected",
        "ordinal",
        "snapshot",
        "replay",
        "decision",
        "threshold",
        "baseline",
        "measure",
        "archive",
        "deliver",
    ];
    const target = Math.max(0, Math.round(tokens * 4));
    const parts: string[] = [];
    let length = 0;
    let i = turnIndex % words.length;
    while (length < target) {
        const w = words[i % words.length];
        parts.push(`${w}${i % 17 === 0 ? "." : ""}`);
        length += w.length + 1;
        i += 1;
    }
    return parts.join(" ");
}

/**
 * Freeze lint (U1). Returns sorted diagnostics; empty array = lint-clean.
 * Coverage of probe gold-fact ranges is a runtime precondition (KTD6), not
 * a lint rule — the lint cannot know what the live historian will cover.
 */
export function lintScenario(scenario: HistorianEvalScenario): string[] {
    const diagnostics: string[] = [];
    const label = scenario.id;

    for (const claim of scenario.gold.expectedClaims) {
        if (!MEMORY_CATEGORIES.includes(claim.category)) {
            diagnostics.push(`${label}.gold.expectedClaims.${claim.id}.category: outside-taxonomy`);
        }
        if (normalizeContent(claim.predicate.value).length === 0) {
            diagnostics.push(`${label}.gold.expectedClaims.${claim.id}.predicate: empty-after-normalization`);
        }
        if (claim.sourceTurnRange[1] >= scenario.transcript.epilogueStartIndex) {
            // Gold facts in the epilogue would be dropped whenever discard-last
            // heals the boundary, so recall could never be attributed to the
            // historian.
            diagnostics.push(`${label}.gold.expectedClaims.${claim.id}.sourceTurnRange: inside-epilogue`);
        }
    }
    if (scenario.gold.expectedClaims.length === 0) {
        diagnostics.push(`${label}.gold.expectedClaims: empty`);
    }
    if (scenario.probes.length === 0) {
        // The mutation battery's probe class needs at least one probe to
        // exercise; a probe-less scenario would freeze with that class
        // silently skipped.
        diagnostics.push(`${label}.probes: empty`);
    }

    for (const absent of scenario.gold.expectedAbsent) {
        if (normalizeContent(absent.predicate.value).length === 0) {
            diagnostics.push(`${label}.gold.expectedAbsent.${absent.id}.predicate: empty-after-normalization`);
        }
    }
    const absentFamilies = new Set(scenario.gold.expectedAbsent.map((absent) => absent.family));
    for (const family of scenario.families) {
        if (!absentFamilies.has(family)) {
            diagnostics.push(`${label}.families.${family}: missing-expected-absent`);
        }
    }
    for (const family of absentFamilies) {
        if (!scenario.families.includes(family)) {
            diagnostics.push(`${label}.gold.expectedAbsent: undeclared-family-${family}`);
        }
    }

    // Single-chunk headroom (KTD3): production tokenizer + production budget
    // derivation. The historian model is live and unknown at lint time, so
    // the budget uses the production fallback context limit; the declared
    // margin absorbs live-model drift, and the runner records actual chunk
    // state (`hasMore`) at run time.
    const chunkBudget = deriveHistorianChunkTokens(resolveHistorianContextLimit(undefined));
    const transcriptTokens = estimateTokens(renderedTranscriptText(scenario));
    if (transcriptTokens + scenario.trigger.headroomMarginTokens > chunkBudget) {
        diagnostics.push(
            `${label}.transcript: exceeds-single-chunk-headroom (${transcriptTokens} + margin ${scenario.trigger.headroomMarginTokens} > ${chunkBudget})`,
        );
    }

    return diagnostics.sort();
}

/**
 * Release tuple (KD4/KTD7): scenario artifacts plus lane schema and
 * privacy/sanitizer versions. The run report separately records the
 * system-version tuple (repo SHA, model identifiers) — system churn moves
 * scores without touching frozen files, so it lives outside release identity.
 */
export interface ReleaseTuple {
    corpusFingerprint: string;
    scenarioSchemaVersion: typeof SCENARIO_SCHEMA;
    privacyPolicyVersion: string;
    sanitizerVersion: string;
}

export const APPROVAL_KINDS = ["privacy", "gold-intent"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export interface Approval {
    kind: ApprovalKind;
    approver: string;
    releaseTupleFingerprint: string;
}

export interface ReleaseManifest {
    schema: typeof MANIFEST_SCHEMA;
    releaseVersion: string;
    releaseTuple: ReleaseTuple;
    approvals: { privacy: Approval; goldIntent: Approval };
    /**
     * Errata (R12): scenario ids from prior releases found wrong. Tombstoned
     * ids persist in every later release; existing releases are never edited.
     */
    tombstones: string[];
}

export function buildReleaseTuple(scenarios: readonly HistorianEvalScenario[]): ReleaseTuple {
    return {
        corpusFingerprint: canonicalFingerprint(scenarios.map((scenario) => scenarioFingerprint(scenario)).sort()),
        scenarioSchemaVersion: SCENARIO_SCHEMA,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION,
        sanitizerVersion: SANITIZER_VERSION,
    };
}

export function parseApproval(raw: unknown, label: string): Approval {
    const value = record(raw, label);
    exact(value, ["kind", "approver", "releaseTupleFingerprint"], label);
    return {
        kind: enumeration(value.kind, APPROVAL_KINDS, `${label}.kind`),
        approver: string(value.approver, `${label}.approver`),
        releaseTupleFingerprint: hex64(value.releaseTupleFingerprint, `${label}.releaseTupleFingerprint`),
    };
}

function parseReleaseTuple(raw: unknown, label: string): ReleaseTuple {
    const value = record(raw, label);
    exact(value, ["corpusFingerprint", "scenarioSchemaVersion", "privacyPolicyVersion", "sanitizerVersion"], label);
    if (value.scenarioSchemaVersion !== SCENARIO_SCHEMA) fail(`${label}.scenarioSchemaVersion: version-invalid`);
    return {
        corpusFingerprint: hex64(value.corpusFingerprint, `${label}.corpusFingerprint`),
        scenarioSchemaVersion: SCENARIO_SCHEMA,
        privacyPolicyVersion: string(value.privacyPolicyVersion, `${label}.privacyPolicyVersion`),
        sanitizerVersion: string(value.sanitizerVersion, `${label}.sanitizerVersion`),
    };
}

export function parseManifest(raw: unknown, label = "manifest"): ReleaseManifest {
    const root = record(raw, label);
    exact(root, ["schema", "releaseVersion", "releaseTuple", "approvals", "tombstones"], label);
    if (root.schema !== MANIFEST_SCHEMA) fail(`${label}.schema: version-invalid`);
    const releaseVersion = string(root.releaseVersion, `${label}.releaseVersion`);
    if (!RELEASE_VERSION_RE.test(releaseVersion)) fail(`${label}.releaseVersion: version-invalid`);
    const releaseTuple = parseReleaseTuple(root.releaseTuple, `${label}.releaseTuple`);
    const approvalsValue = record(root.approvals, `${label}.approvals`);
    exact(approvalsValue, ["privacy", "goldIntent"], `${label}.approvals`);
    const privacy = parseApproval(approvalsValue.privacy, `${label}.approvals.privacy`);
    const goldIntent = parseApproval(approvalsValue.goldIntent, `${label}.approvals.goldIntent`);
    if (privacy.kind !== "privacy") fail(`${label}.approvals.privacy.kind: wrong-kind`);
    if (goldIntent.kind !== "gold-intent") fail(`${label}.approvals.goldIntent.kind: wrong-kind`);
    const tupleFingerprint = canonicalFingerprint(releaseTuple);
    for (const approval of [privacy, goldIntent]) {
        if (approval.releaseTupleFingerprint !== tupleFingerprint) {
            fail(`${label}.approvals.${approval.kind}: stale-or-foreign-tuple`);
        }
    }
    const tombstones = array(root.tombstones, `${label}.tombstones`).map((entry, index) =>
        staticId(entry, `${label}.tombstones[${index}]`, SCENARIO_ID_RE),
    );
    unique(tombstones, `${label}.tombstones`);
    return {
        schema: MANIFEST_SCHEMA,
        releaseVersion,
        releaseTuple,
        approvals: { privacy, goldIntent },
        tombstones,
    };
}
