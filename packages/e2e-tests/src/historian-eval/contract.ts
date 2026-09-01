/**
 * The module defines the versioned artifact contract for the Historian structural eval lane.
 *
 * A scenario file contains an authored transcript, gold expectations, and hidden structured-answer probes.
 * The authored transcript is fixed input.
 * Gold expectations cover the claim set visible through `readAuthorizedClaimMemorySnapshot`.
 * Parsing rejects unknown keys, free-text probe answers, and literal claim-id golds without echoing artifact values.
 * Rejected artifacts produce named diagnostics that do not echo artifact values.
 *
 * Scenario identity is the canonical-JSON fingerprint of the semantic payload.
 * Harness-owned trigger pressure is excluded from the fingerprint.
 * Context limits, per-turn usage tokens, and ballast are excluded from the fingerprint.
 * Changing the pressure recipe does not change a frozen scenario's identity.
 */

import { canonicalFingerprint, canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import {
    PRIVACY_POLICY_VERSION,
    SANITIZER_VERSION,
} from "../../../plugin/scripts/retrieval-benchmark/privacy";
import { deriveProtectedTailTokenTarget } from "../../../plugin/src/hooks/magic-context/protected-tail-boundary";
import {
    deriveHistorianChunkTokens,
    resolveHistorianContextLimit,
} from "../../../plugin/src/hooks/magic-context/derive-budgets";
import {
    compactRole,
    compactTextForSummary,
    formatBlock,
    normalizeText,
    type ChunkBlock,
} from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { cleanUserText } from "../../../plugin/src/hooks/magic-context/read-session-chunk";
import { isSystemDirective } from "../../../plugin/src/shared/system-directive";
import { estimateTokens } from "../../../plugin/src/shared/token-estimator";
import { V2_MEMORY_CATEGORIES } from "../../../plugin/src/features/magic-context/memory/constants";
import { ballastProse } from "../ballast";
import { HEX64_RE, makeContractPrimitives } from "../contract-primitives";

/**
 * `PROBE_PROMPT_SHARED` contains the fixed text that `buildProbePrompt` places around every probe question.
 *
 * `PROBE_PROMPT_SHARED` is defined here so the runner and freeze lint inspect identical boilerplate.
 * The freeze lint searches the shared boilerplate for probe-answer collisions.
 * A gold answer that appears in shared boilerplate can be produced by echoing the scored prompt.
 *
 * The shared constants contain only boilerplate; each rendered question and choice remains probe-specific.
 * Including rendered questions and choices in the shared boilerplate would make every multiple-choice gold collide with its own prompt.
 */
export const PROBE_PROMPT_SHARED =
    "Answer strictly from the project memory and session history already available to you in this conversation. " +
    "Reply with the answer inside an <answer></answer> envelope. Put nothing else inside the envelope.";
export const PROBE_PROMPT_EXACT_SUFFIX = "Answer with the exact value only.";
export const PROBE_PROMPT_CHOICE_PREFIX = "Choose exactly one of:";
export const PROBE_PROMPT_CLAIM_ID_SUFFIX =
    "Answer with the id of the single project-memory claim (the identifier before the colon in the project-memory block) that records it.";
export const PROBE_PROMPT_REASK_PREFIX = "Your previous reply had no valid <answer></answer> envelope.";
/* */
export const PROBE_PROMPT_QUESTION_LABEL = "Question:";

export const SCENARIO_SCHEMA = "historian-eval-scenario/v1";
export const MANIFEST_SCHEMA = "historian-eval-manifest/v1";
export const RELEASE_VERSION_RE = /^v\d+$/;

export { HEX64_RE };
export const SCENARIO_ID_RE = /^hse-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const EXPECTED_CLAIM_ID_RE = /^exp-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const EXPECTED_ABSENT_ID_RE = /^abs-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PROBE_ID_RE = /^probe-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every scenario declares the hard-negative families it exercises.
 * The freeze lint requires every declared hard-negative family to have at least one `expectedAbsent` predicate tagged with that family.
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

/** No free-text probe answer reaches scoring. */
export const PROBE_ANSWER_TYPES = ["exact", "multiple-choice", "claim-id"] as const;

/* */
const MEMORY_CATEGORIES: readonly string[] = V2_MEMORY_CATEGORIES;

export class HistorianEvalContractError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: readonly string[]) {
        super([...diagnostics].sort().join("; "));
        this.diagnostics = [...diagnostics].sort();
    }
}

const primitives = makeContractPrimitives(HistorianEvalContractError);
const { fail, record, exact, string, staticId, hex64, array, integer, unique } = primitives;
export const enumeration = primitives.enumeration;

/* */
export interface TranscriptTurn {
    user: string;
    assistant: string;
}

/**
 * Content predicates use normalized substring matching and accept neither free text nor regular expressions.
 * Content matching trims, case-folds, and collapses whitespace to tolerate incidental historian wording drift.
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
     * The probe tier's leakage gate rejects a gold-fact-bearing raw sourceTurnRange that survives the injection splice.
     */
    sourceTurnRange: [number, number];
}

export interface ExpectedAbsent {
    id: string;
    family: HardNegativeFamily;
    predicate: ContentPredicate;
}

export interface CompartmentExpectations {
    /** The scenario must produce at least these persisted compartments. */
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
          /** The gold expected claim backs this probe and triggers an ERROR if injection-budget trimming removes it. */
          sourceClaimRef: string;
      }
    | {
          id: string;
          question: string;
          answerType: "multiple-choice";
          choices: string[];
          goldAnswer: string;
          sourceClaimRef: string;
      }
    | { id: string; question: string; answerType: "claim-id"; expectedClaimRef: string };

/**
 * scenario.
 */
export interface TriggerRecipe {
    /** The scenario declares 1 or 2 runs; a declared run that never fires is an ERROR. */
    expectedHistorianRuns: number;
    /** The harness pins the mock model context limit for threshold pressure. */
    modelContextLimit: number;
    /** The harness scripts usage tokens for ordinary build turns. */
    usageTokensPerTurn: number;
    /** The harness scripts usage tokens for the threshold-crossing spike turn. */
    spikeUsageTokens: number;
    /** The harness appends deterministic ballast tokens to each user turn. */
    ballastTokensPerTurn: number;
    /** Freeze lint subtracts this safety margin from the historian chunk budget. */
    headroomMarginTokens: number;
}

export interface HistorianEvalScenario {
    schema: typeof SCENARIO_SCHEMA;
    id: string;
    title: string;
    families: HardNegativeFamily[];
    transcript: {
        turns: TranscriptTurn[];
        /** `epilogueStartIndex` marks the first epilogue turn used for discard-last healing. */
        epilogueStartIndex: number;
    };
    trigger: TriggerRecipe;
    gold: GoldExpectations;
    probes: Probe[];
}

function parsePredicate(raw: unknown, label: string): ContentPredicate {
    const value = record(raw, label);
    exact(value, ["kind", "value"], label);
    const text = string(value.value, `${label}.value`);
    // `parsePredicate` caps predicate values before semantic validation because scoring scans visible claims and freeze lint checks predicate pairs.
    if (text.length > MAX_PREDICATE_VALUE_CHARS) fail(`${label}.value: above-operational-maximum`);
    return {
        kind: enumeration(value.kind, ["normalized-substring"], `${label}.kind`),
        value: text,
    };
}

/**
 */
export const MAX_TRANSCRIPT_TURNS = 100;
export const MAX_TURN_TEXT_CHARS = 20_000;
/**
 * The parser caps expectation and probe arrays before mapping them because freeze lint compares each expected-absent predicate with each expected claim.
 * normalize-and-substring scans.
 */
export const MAX_EXPECTATION_ENTRIES = 100;

/* */
export const MAX_PREDICATE_VALUE_CHARS = 2_000;
/**
 * `boundedAnswer` rejects gold answers the answer envelope cannot carry.
 *
 * `<answer>` envelopes carry probe answers; the runner extracts them non-greedily.
 * A closing `</answer>` in a value truncates the extracted answer.
 * A non-empty truncated prefix prevents the runner from re-asking.
 * The runner records a truncated probe answer as a FAILURE.
 * No correct reply can produce the truncated answer.
 * `envelopeSafeAnswer` rejects answer-envelope delimiters to prevent permanently wrong probes.
 */
function boundedAnswer(value: string, label: string): string {
    if (value.length > MAX_PROBE_ANSWER_CHARS) fail(`${label}: above-operational-maximum`);
    return value;
}

function envelopeSafeAnswer(value: string, label: string): string {
    if (value.includes("</answer>") || value.includes("<answer>")) {
        fail(`${label}: answer-envelope-delimiter`);
    }
    return value;
}

/**
 * `MAX_PROBE_CHOICES` limits each nested choice array because choice arrays nest within probes.
 * A scenario can meet the probe cap while a probe contains an enormous choice list.
 * Parsing normalizes every option, and `probeIdentity` normalizes and sorts every option.
 */
export const MAX_PROBE_CHOICES = 10;
/**
 *
 * Probe questions, exact answers, and choice strings feed regex construction.
 * Unbounded values can cause memory exhaustion or native regex errors.
 *
 * Probe questions use `MAX_TURN_TEXT_CHARS` because they are authored prose.
 * `MAX_PROBE_ANSWER_CHARS` equals `MAX_PREDICATE_VALUE_CHARS` because both limit values matched against content.
 */
export const MAX_PROBE_QUESTION_CHARS = MAX_TURN_TEXT_CHARS;
export const MAX_PROBE_ANSWER_CHARS = MAX_PREDICATE_VALUE_CHARS;

/* */
export const PROBE_CHOICE_SEPARATOR = " | ";

/**
 * Freeze lint uses `MAX_PADDING_TURNS` to determine whether recipe padding can clear its protected tail.
 * Recipe padding must clear its protected tail within `MAX_PADDING_TURNS`.
 */
export const MAX_PADDING_TURNS = 32;

/** The runner prepends build turns to reach `MIN_BUILD_TURNS`. */
export const MIN_BUILD_TURNS = 10;

/**
 * The runner prepends `FILLER_TURN` without ballast.
 *
 * Freeze lint measures `FILLER_TURN`'s rendered bytes because runners send its strings.
 * The chunk-headroom check must include `FILLER_TURN`'s rendered bytes.
 * Filler turns consume the historian's chunk budget, so lint must include them.
 */
export const FILLER_TURN = {
    user: "Routine progress update.",
    assistant: "Noted; continuing with routine work.",
} as const;

function turnText(value: unknown, label: string): string {
    const result = string(value, label);
    if (result.length > MAX_TURN_TEXT_CHARS) fail(`${label}: above-operational-maximum`);
    return result;
}

function parseTurn(raw: unknown, label: string): TranscriptTurn {
    const value = record(raw, label);
    exact(value, ["user", "assistant"], label);
    return {
        user: turnText(value.user, `${label}.user`),
        assistant: turnText(value.assistant, `${label}.assistant`),
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
    if (question.length > MAX_PROBE_QUESTION_CHARS) fail(`${label}.question: above-operational-maximum`);
    if (answerType === "exact") {
        // probe accuracy.
        exact(value, ["id", "question", "answerType", "goldAnswer", "sourceClaimRef"], label);
        const goldAnswer = boundedAnswer(
            envelopeSafeAnswer(string(value.goldAnswer, `${label}.goldAnswer`), `${label}.goldAnswer`),
            `${label}.goldAnswer`,
        );
        // Questions must not state their own answers because the model can answer without injected memory or session history.
        //
        // Claim-id answers are runtime IDs and cannot appear in authored questions.
        if (containsCompleteValue(question, goldAnswer)) {
            fail(`${label}.question: self-answering (the question states this probe's own gold answer)`);
        }
        return {
            id,
            question,
            answerType,
            goldAnswer,
            sourceClaimRef: staticId(value.sourceClaimRef, `${label}.sourceClaimRef`, EXPECTED_CLAIM_ID_RE),
        };
    }
    if (answerType === "multiple-choice") {
        exact(value, ["id", "question", "answerType", "choices", "goldAnswer", "sourceClaimRef"], label);
        const rawChoices = array(value.choices, `${label}.choices`);
        if (rawChoices.length > MAX_PROBE_CHOICES) fail(`${label}.choices: above-operational-maximum`);
        const choices = rawChoices.map((entry, index) => string(entry, `${label}.choices[${index}]`));
        if (choices.length < 2) fail(`${label}.choices: choices-invalid`);
        // Treating `"Redis"` and `" redis "` as distinct choices would create indistinguishable options.
        // A model selecting a non-gold spelling of the same option would be scored wrong.
        // Choice comparison decodes entities because scoring treats encoded and decoded forms as equal.
        // Normalized gold matching would hide mismatches between `goldAnswer` and the literal choices.
        unique(choices.map((choice) => normalizeContent(decodeXmlEntities(choice))), `${label}.choices`);
        // The validator rejects delimiters in every choice because the model may answer with any choice.
        // The validator rejects delimiters in every choice because replies containing them are truncated before scoring.
        for (const [index, choice] of choices.entries()) {
            boundedAnswer(envelopeSafeAnswer(choice, `${label}.choices[${index}]`), `${label}.choices[${index}]`);
            // Choices cannot contain the prompt separator because it makes the rendered option count ambiguous.
            // Rendering `["A | B", "C"]` produces three apparent options.
            // A valid selection can then be scored incorrectly.
            // wrong.
            if (choice.includes(PROBE_CHOICE_SEPARATOR)) {
                fail(`${label}.choices[${index}]: choice-separator`);
            }
        }
        const goldAnswer = string(value.goldAnswer, `${label}.goldAnswer`);
        if (!choices.includes(goldAnswer)) fail(`${label}.goldAnswer: not-a-choice`);
        //
        //
        //
        // `containsCompleteValue` cannot detect steering that omits the option, such as "the obvious one".
        if (containsCompleteValue(question, goldAnswer)) {
            fail(`${label}.question: self-answering (the question states this probe's own gold answer)`);
        }
        return {
            id,
            question,
            answerType,
            choices,
            goldAnswer,
            sourceClaimRef: staticId(value.sourceClaimRef, `${label}.sourceClaimRef`, EXPECTED_CLAIM_ID_RE),
        };
    }
    // A claim-id gold answer names an expected-claim reference; the scorer resolves its runtime ID against the recorded injected set.
    // `expectedClaimRef` carries the provenance that `sourceClaimRef` provides for the other answer types, so both fields would name the same edge.
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
    if (turns.length > MAX_TRANSCRIPT_TURNS) fail(`${label}.transcript.turns: above-operational-maximum`);
    const epilogueStartIndex = integer(transcriptValue.epilogueStartIndex, `${label}.transcript.epilogueStartIndex`, 1);
    if (epilogueStartIndex >= turns.length) fail(`${label}.transcript.epilogueStartIndex: out-of-range`);

    const goldValue = record(root.gold, `${label}.gold`);
    exact(goldValue, ["expectedClaims", "expectedAbsent", "compartments"], `${label}.gold`);
    const bounded = (value: unknown, arrayLabel: string): unknown[] => {
        const entries = array(value, arrayLabel);
        if (entries.length > MAX_EXPECTATION_ENTRIES) fail(`${arrayLabel}: above-operational-maximum`);
        return entries;
    };
    const expectedClaims = bounded(goldValue.expectedClaims, `${label}.gold.expectedClaims`).map((entry, index) =>
        parseExpectedClaim(entry, `${label}.gold.expectedClaims[${index}]`, turns.length),
    );
    unique(
        expectedClaims.map((claim) => claim.id),
        `${label}.gold.expectedClaims`,
    );
    // Independent scoring would credit one injected fact to both duplicate expectations, inflating recall.
    // The identity key JSON-encodes the category and predicate tuple to prevent concatenation collisions.
    unique(
        expectedClaims.map((claim) => JSON.stringify([claim.category, normalizeContent(claim.predicate.value)])),
        `${label}.gold.expectedClaims.identity`,
    );
    // The validator rejects same-category predicates when either normalized value contains the other, preventing one injected fact from satisfying both expectations.
    // A claim matching the narrower predicate also matches the broader predicate.
    // One injected fact could satisfy both expectations and inflate recall.
    // The identity check does not detect containment because the normalized strings differ.
    //
    // Precomputing normalized predicates avoids O(n²) repeated normalization.
    const normalizedPredicates = expectedClaims.map((claim) => ({
        id: claim.id,
        category: claim.category,
        value: normalizeContent(claim.predicate.value),
    }));
    for (const [leftIndex, left] of normalizedPredicates.entries()) {
        for (const right of normalizedPredicates.slice(leftIndex + 1)) {
            if (left.category !== right.category) continue;
            if (left.value.includes(right.value) || right.value.includes(left.value)) {
                fail(
                    `${label}.gold.expectedClaims: subsumed-predicate (${left.id} and ${right.id} share category ${left.category} and one predicate contains the other)`,
                );
            }
        }
    }
    const expectedAbsent = bounded(goldValue.expectedAbsent, `${label}.gold.expectedAbsent`).map((entry, index) =>
        parseExpectedAbsent(entry, `${label}.gold.expectedAbsent[${index}]`),
    );
    unique(
        expectedAbsent.map((absent) => absent.id),
        `${label}.gold.expectedAbsent`,
    );
    // Duplicate forbidden formations would weight one false promotion twice.
    // Family is part of the identity because one formation can exercise multiple families.
    unique(
        expectedAbsent.map((absent) => JSON.stringify([absent.family, normalizeContent(absent.predicate.value)])),
        `${label}.gold.expectedAbsent.identity`,
    );
    const compartmentsValue = record(goldValue.compartments, `${label}.gold.compartments`);
    exact(compartmentsValue, ["minCount"], `${label}.gold.compartments`);
    const compartments: CompartmentExpectations = {
        minCount: integer(compartmentsValue.minCount, `${label}.gold.compartments.minCount`, 1),
    };

    const probes = bounded(root.probes, `${label}.probes`).map((entry, index) =>
        parseProbe(entry, `${label}.probes[${index}]`),
    );
    unique(
        probes.map((probe) => probe.id),
        `${label}.probes`,
    );
    // Duplicate probes weight the same behavior twice in aggregate accuracy.
    unique(
        probes.map((probe) => {
            const { ask, claimRef } = probeIdentity(probe);
            return canonicalJson([ask, claimRef]);
        }),
        `${label}.probes.identity`,
    );
    // Probes run sequentially in one resumed session, so each later probe sees all earlier prompts and responses.
    // Later probes can exploit answers present in earlier prompts or responses.
    // An earlier probe's accepted answer can contain a later probe's accepted answer.
    // as completely.
    //
    // A multiple-choice probe and a differently worded exact probe can be distinct while sharing an answer.
    //
    // The cross-probe checks do not make probes independent; models can infer answers from related exchanges.
    // Models can infer answers from related exchanges without copying a value.
    // True isolation requires each probe to start from an identical pre-probe session state.
    const answerSurface = (probe: Probe): string[] =>
        probe.answerType === "claim-id"
            ? []
            : [probe.goldAnswer, ...(probe.answerType === "multiple-choice" ? probe.choices : [])].map(
                  normalizeContent,
              );
    for (const [leftIndex, left] of probes.entries()) {
        for (const right of probes.slice(leftIndex + 1)) {
            const leftRef = left.answerType === "claim-id" ? left.expectedClaimRef : left.sourceClaimRef;
            const rightRef = right.answerType === "claim-id" ? right.expectedClaimRef : right.sourceClaimRef;
            // Two `claim-id` probes for one claim resolve to the same runtime claim ID.
            // Empty answer surfaces do not detect that shared runtime claim ID.
            if (left.answerType === "claim-id" && right.answerType === "claim-id" && leftRef === rightRef) {
                fail(
                    `${label}.probes: shared-answer-surface (${left.id} and ${right.id} both resolve ${leftRef} to the same runtime claim id)`,
                );
            }
            // `matchesGold` can resolve two same-category `claim-id` probes to one promoted claim when its content matches both predicates.
            //
            // The validator rejects same-category `claim-id` probe pairs because one promoted claim can resolve both probes.
            if (left.answerType === "claim-id" && right.answerType === "claim-id") {
                const leftCategory = expectedClaims.find((claim) => claim.id === leftRef)?.category;
                const rightCategory = expectedClaims.find((claim) => claim.id === rightRef)?.category;
                if (leftCategory !== undefined && leftCategory === rightCategory) {
                    fail(
                        `${label}.probes: claim-id-co-resolvable (${left.id} and ${right.id} reference same-category claims, so one promoted claim can satisfy both and resolve to one runtime id)`,
                    );
                }
            }
            // The validator compares all probe pairs because an earlier answer in history can answer a later probe.
            const leftSurface = answerSurface(left);
            const rightSurface = answerSurface(right);
            const shared = leftSurface.filter((value) => rightSurface.includes(value));
            if (shared.length > 0) {
                fail(
                    `${label}.probes: shared-answer-surface (${left.id} and ${right.id} share an answer value, so the earlier exchange answers the later probe)`,
                );
            }
            // The validator rejects an earlier answer surface that contains a later accepted answer because equality alone misses it.
            //
            // The validator rejects containment leaks before `probeResponseLeak` because that function exempts a probe's own accepted answer.
            //
            // The validator checks containment directionally because only earlier replies reach later prompts.
            // `containsCompleteValue` treats `4096` and `4` as distinct complete values.
            if (right.answerType !== "claim-id") {
                if (leftSurface.some((value) => containsCompleteValue(value, right.goldAnswer))) {
                    fail(
                        `${label}.probes: shared-answer-surface (${left.id} runs first and one of its answer surface values states ${right.id}'s gold answer)`,
                    );
                }
            }
            // The validator checks earlier question text because later models receive it in raw history.
            // A question can state another probe's answer while asking about something else.
            // For example, `Was the limit 4096?` can have gold `yes` before a probe with gold `4096`.
            // The answer-surface comparison cannot detect a `yes`/`4096` pair because the values do not overlap.
            //
            // Probes run in `probes` order, so only earlier questions reach later models.
            // Bidirectional comparison would reject pairs whose exposing text never reaches the answering model.
            // saw.
            //
            // `containsCompleteValue` matches complete values, so `4096` does not expose `4`.
            if (right.answerType !== "claim-id" && containsCompleteValue(left.question, right.goldAnswer)) {
                fail(
                    `${label}.probes: question-exposed-answer (${left.id} runs first and its question states ${right.id}'s gold answer)`,
                );
            }
        }
    }

    const expectedClaimIds = new Set(expectedClaims.map((claim) => claim.id));
    for (const probe of probes) {
        const reference = probe.answerType === "claim-id" ? probe.expectedClaimRef : probe.sourceClaimRef;
        if (!expectedClaimIds.has(reference)) {
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

/**
 * A trigger fingerprint binds each stored run record to the trigger settings used for that run.
 *
 * Changing trigger pressure without changing `expectedHistorianRuns` leaves `scenarioFingerprint` unchanged, so artifacts require `triggerFingerprint` to bind their execution recipe.
 *
 */
export function triggerFingerprint(scenario: HistorianEvalScenario): string {
    return canonicalFingerprint(scenario.trigger);
}

/**
 * `scenarioDuplicateKey` excludes scenario labels, contract-local IDs, and order from set-like arrays.
 *
 * `scenarioFingerprint` includes labels and IDs, so it cannot identify duplicate evaluations.
 * Keeping duplicate scenarios double-weights one evaluation in release aggregates.
 *
 * `scenarioDuplicateKey` resolves probe references to id-free claim semantics.
 * `scenarioDuplicateKey` preserves `transcript.turns` order because turn order changes meaning.
 * presentation.
 */
function scenarioDuplicateKey(scenario: HistorianEvalScenario): Record<string, unknown> {
    const claimById = new Map(scenario.gold.expectedClaims.map((claim) => [claim.id, claim]));
    // `normalizedPredicate` normalizes predicate values because `predicateMatches` compares normalized values.
    // `normalizedPredicate` makes predicates with equivalent normalized values identical in the duplicate key.
    // `scenarioDuplicateKey` keys transcript messages by the text the historian receives.
    const normalizedPredicate = (predicate: ContentPredicate): ContentPredicate => ({
        kind: predicate.kind,
        value: normalizeContent(predicate.value),
    });
    const claimSemantics = (claim: ExpectedClaim): Record<string, unknown> => ({
        category: claim.category,
        predicate: normalizedPredicate(claim.predicate),
        sourceTurnRange: claim.sourceTurnRange,
    });
    const referencedClaim = (id: string): Record<string, unknown> => {
        const claim = claimById.get(id);
        if (claim === undefined) {
            throw new HistorianEvalContractError(["releaseTuple.scenarios.semantic: dangling-reference"]);
        }
        return claimSemantics(claim);
    };
    return {
        schema: scenario.schema,
        families: canonicalOrder(scenario.families),
        // `scenarioDuplicateKey` preserves turn order but canonicalizes each message through the renderer's production path.
        // Messages differing only in internal whitespace or `<system-reminder>` blocks produce identical historian input.
        // Equivalent messages represent one evaluation; retaining both double-weights that evaluation.
        transcript: {
            epilogueStartIndex: scenario.transcript.epilogueStartIndex,
            turns: scenario.transcript.turns.map((turn) => ({
                user: messageAsHistorianSeesIt("user", turn.user),
                assistant: messageAsHistorianSeesIt("assistant", turn.assistant),
            })),
        },
        expectedHistorianRuns: scenario.trigger.expectedHistorianRuns,
        compartments: scenario.gold.compartments,
        expectedClaims: canonicalOrder(scenario.gold.expectedClaims.map(claimSemantics)),
        expectedAbsent: canonicalOrder(
            scenario.gold.expectedAbsent.map((absent) => ({
                family: absent.family,
                predicate: normalizedPredicate(absent.predicate),
            })),
        ),
        probes: canonicalOrder(
            scenario.probes.map((probe) => {
                const { ask, claimRef } = probeIdentity(probe);
                return { ...ask, claim: referencedClaim(claimRef) };
            }),
        ),
    };
}

function scenarioSemanticFingerprint(scenario: HistorianEvalScenario): string {
    return canonicalFingerprint(scenarioDuplicateKey(scenario));
}

/**
 * A probe identity includes its id-free question and its backing gold claim.
 *
 * Probes with identical `ask` and `claimRef` duplicate one question and overweight it in accuracy scoring.
 * Within a scenario, `ask` plus `claimRef` must be unique to prevent duplicate probes from overweighting accuracy.
 * Duplicate-scenario detection retains `ask` and replaces `claimRef` with the referenced claim's semantics.
 *
 * `normalizeContent` treats incidental whitespace and case differences as equivalent.
 * Multiple-choice `choices` are sorted because their order is presentation-only.
 * A different backing claim makes a probe distinct even when its question and answer match.
 */
function probeIdentity(probe: Probe): { ask: Record<string, unknown>; claimRef: string } {
    if (probe.answerType === "claim-id") {
        return {
            ask: { answerType: probe.answerType, question: normalizeContent(probe.question) },
            claimRef: probe.expectedClaimRef,
        };
    }
    return {
        ask: {
            answerType: probe.answerType,
            question: normalizeContent(probe.question),
            goldAnswer: normalizeContent(probe.goldAnswer),
            ...(probe.answerType === "multiple-choice"
                ? { choices: probe.choices.map(normalizeContent).sort() }
                : {}),
        },
        claimRef: probe.sourceClaimRef,
    };
}

/**
 * `canonicalOrder` sorts entries by canonical serialization so set-like arrays have order-independent fingerprints.
 */
function canonicalOrder<T>(entries: readonly T[]): T[] {
    return [...entries]
        .map((entry) => [canonicalJson(entry), entry] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, entry]) => entry);
}

/* */
/**
 *
 * `decodeXmlEntities` decodes `&amp;` last so `&amp;lt;` becomes `&lt;`, not `<`.
 */
/**
 * `codePointOrRaw` returns `raw` unless `code` is a safe-integer Unicode scalar value.
 *
 * `codePointOrRaw` rejects values outside `0..0x10ffff` because `String.fromCodePoint` throws `RangeError` for them.
 * Invalid numeric entities remain raw text so decoding cannot throw.
 */
function codePointOrRaw(code: number, raw: string): string {
    if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) return raw;
    // `String.fromCodePoint` accepts lone surrogates, but `codePointOrRaw` rejects them because they are not Unicode scalar values.
    if (code >= 0xd800 && code <= 0xdfff) return raw;
    return String.fromCodePoint(code);
}

export function decodeXmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (match, code: string) => codePointOrRaw(Number(code), match))
        .replace(/&#x([0-9a-fA-F]+);/g, (match, code: string) => codePointOrRaw(Number.parseInt(code, 16), match))
        .replace(/&amp;/g, "&");
}

export function normalizeContent(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function predicateMatches(predicate: ContentPredicate, content: string): boolean {
    return normalizeContent(content).includes(normalizeContent(predicate.value));
}

/**
 * The runner and scorer use the same gold-to-claim match rule.
 */
export function matchesGold(
    claim: Pick<ExpectedClaim, "category" | "predicate">,
    item: { category: string; content: string },
): boolean {
    return item.category === claim.category && predicateMatches(claim.predicate, item.content);
}

/**
 * `content` must contain `value` with no letter-or-digit-adjacent characters.
 *
 * Substring matching would accept gold value `4` in transcript text `4096`, rewarding a wrong answer.
 * Letter-or-digit boundaries allow `"in-process lru"` in a sentence but reject `"4"` in `"4096"`.
 */
export function containsCompleteValue(content: string, value: string): boolean {
    return findCompleteValues(content, value, true) > 0;
}

/**
 * How many times `content` states `value` as a complete value.
 *
 * A caller comparing a transcript with a perturbation of it needs the count, not
 * just presence: a rewrite that adds or removes one occurrence of a probe's answer
 * changes what the probe can copy from raw history even when another occurrence
 * keeps presence unchanged.
 */
export function countCompleteValues(content: string, value: string): number {
    return findCompleteValues(content, value, false);
}

/** A letter or digit, the adjacency that makes a match part of a larger value. */
const VALUE_CHARACTER_RE = /^[\p{L}\p{N}]/u;

/**
 * The code point ending just before `index`, or `""` at the start.
 *
 * Read as a code point, not a code unit: a single `charAt` on an astral letter
 * returns one surrogate half, which is not a letter under `\p{L}`, so a match sitting
 * against such a letter would have looked boundary-clean.
 */
function codePointBefore(text: string, index: number): string {
    if (index <= 0) return "";
    const low = text.charCodeAt(index - 1);
    if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
        const high = text.charCodeAt(index - 2);
        if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
    }
    return text.charAt(index - 1);
}

/** The code point starting at `index`, or `""` at the end. */
function codePointAt(text: string, index: number): string {
    const point = text.codePointAt(index);
    return point === undefined ? "" : String.fromCodePoint(point);
}

/**
 * Occurrences of `value` in `content`, by starting position, stopping at the first
 * when `firstOnly`.
 *
 * Substring search plus a boundary test on the two adjacent characters, rather than
 * a regex advanced one character at a time: a repeated-substring haystack makes the
 * regex re-derive each overlapping match, which turned a two-thousand-character
 * answer against a megabyte of repetitive text into seconds of work. Counted by
 * starting position, so `blue blue` occurs twice in `blue blue blue` — a caller
 * comparing counts across a perturbation would otherwise miss the loss of one
 * overlapping occurrence.
 */
function findCompleteValues(content: string, value: string, firstOnly: boolean): number {
    // Both sides decoded first, so every collision guard uses the SAME equality
    // `compareProbeAnswer` accepts on. Without it a gold of `A&B` was accepted when a
    // model answered `A&amp;B`, while a question or an earlier reply containing
    // `A&amp;B` passed these guards — so the escaped form could be copied out of the
    // prompt or the shared history and still score.
    const needle = normalizeContent(decodeXmlEntities(value));
    if (needle.length === 0) return 0;
    const haystack = normalizeContent(decodeXmlEntities(content));
    let count = 0;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
        const before = codePointBefore(haystack, at);
        const after = codePointAt(haystack, at + needle.length);
        if (VALUE_CHARACTER_RE.test(before) || VALUE_CHARACTER_RE.test(after)) continue;
        count += 1;
        if (firstOnly) return count;
    }
    return count;
}

/**
 *
 * Rendering and evidence matching use identical normalization.
 *
 * Evidence search follows message filtering because the historian never receives removed user text.
 */
function messageAsHistorianSeesIt(role: "user" | "assistant", text: string): string {
    if (role !== "user") return normalizeText(text);
    const cleaned = cleanUserText(text);
    return isSystemDirective(cleaned) ? "" : normalizeText(cleaned);
}

/**
 * Authored evidence text for a turn list: both messages of every turn as the
 * historian receives them, ballast excluded. Ballast is harness-owned filler
 * that never carries authored evidence, so including it could only let a
 * predicate match by accident against generated prose.
 */
export function authoredEvidenceText(turns: readonly TranscriptTurn[]): string {
    return turns
        .map(
            (turn) =>
                `${messageAsHistorianSeesIt("user", turn.user)} ${messageAsHistorianSeesIt("assistant", turn.assistant)}`,
        )
        .join(" ");
}

export interface NormalizedEvidenceMessage {
    turnIndex: number;
    role: "user" | "assistant";
    text: string;
}

/**
 * The messages of `turns` the historian actually receives, in evidence order,
 * with the ones production discards omitted.
 *
 * Case and spacing are as authored, so a caller that needs the exact spelling of
 * something — a case-sensitive identifier, say — can read it here rather than
 * from the raw message, whose discarded parts the historian never sees.
 */
export function visibleEvidenceMessages(
    turns: readonly TranscriptTurn[],
): NormalizedEvidenceMessage[] {
    return turns.flatMap((turn, turnIndex) =>
        (["user", "assistant"] as const).flatMap((role) => {
            const text = messageAsHistorianSeesIt(role, turn[role]);
            return normalizeContent(text).length === 0 ? [] : [{ turnIndex, role, text }];
        }),
    );
}

/**
 * The same messages, each normalized the way `predicateMatches` compares.
 *
 * Joining these with a single space reproduces
 * `normalizeContent(authoredEvidenceText(turns))`, so a caller can map a
 * predicate match back to the exact messages it spans. Evidence rules that
 * search the whole range — the expected-absent authorship check, for one —
 * accept matches no single message contains, and a per-turn or per-role
 * approximation of this view silently misses them.
 */
export function normalizedEvidenceMessages(
    turns: readonly TranscriptTurn[],
): NormalizedEvidenceMessage[] {
    return visibleEvidenceMessages(turns).map((message) => ({
        ...message,
        text: normalizeContent(message.text),
    }));
}

/** Authored evidence text for a half-open turn range. */
function evidenceText(scenario: HistorianEvalScenario, startTurn: number, endTurnExclusive: number): string {
    return authoredEvidenceText(scenario.transcript.turns.slice(startTurn, endTurnExclusive));
}

/**
 * Formats each user and assistant message as a separate block to match chunk-builder input.
 * The renderer uses production `formatBlock` and shared `ballastProse` so lint measures historian input.
 * The lint measures the bytes sent to the historian.
 *
 * The function returns one block per message because production budgets each block separately.
 * The chunk builder tokenizes each `formatBlock` result separately and accumulates the counts.
 * Token estimates are not additive across concatenated blocks: BPE merges across the joining newline, and the fallback rounds each call.
 * A joined estimate differs from the per-block estimate used for budget decisions.
 *
 * The harnesses and this renderer both call `ballastProse(tokens)`, so lint measures a transcript a runner can produce.
 * `ballastProse` has no seed parameter, so renderer and harness ballast cannot diverge by seed.
 *
 */
/**
 * The lane reports `tokens` as both input and cache-write usage.
 *
 * The runner builds usage through `triggerTurnUsage`, so the usage shape has one definition.
 *
 * Reporting `tokens` in both fields does not make the threshold consume `2 * tokens`.
 * The lint's threshold math uses the declared `tokens` value, not the sum of both fields.
 * value.
 */
export function triggerTurnUsage(tokens: number): {
    input_tokens: number;
    cache_creation_input_tokens: number;
} {
    return { input_tokens: tokens, cache_creation_input_tokens: tokens };
}

/**
 * `EXECUTE_THRESHOLD_PERCENTAGE` defines the execution threshold for every harness config.
 * The freeze lint requires the same threshold that harness runs use.
 * The trigger recipe is valid only for the threshold used by its harness runs.
 * The runner imports the trigger recipe, so the recipe cannot drift from the runner.
 */
export const EXECUTE_THRESHOLD_PERCENTAGE = 40;

/**
 *
 * Filler blocks do not contribute to gold or the fingerprint, but they consume chunk capacity.
 */
export function renderedFillerBlocks(scenario: HistorianEvalScenario): string[] {
    const fillerCount = Math.max(0, MIN_BUILD_TURNS - scenario.transcript.turns.length);
    if (fillerCount === 0) return [];
    const filler: HistorianEvalScenario = {
        ...scenario,
        transcript: {
            ...scenario.transcript,
            turns: Array.from({ length: fillerCount }, () => ({
                user: FILLER_TURN.user,
                assistant: FILLER_TURN.assistant,
            })),
        },
    };
    return renderedTranscriptBlocks(filler);
}

/**
 * The messages of `turns` as the chunk builder renders their content: production
 * cleaning, then `compactTextForSummary`, with the messages production drops
 * omitted and the commit metadata compaction extracts carried alongside the text.
 *
 * Positional ordinals are deliberately excluded, so two callers can ask whether a
 * reordering changes what the historian receives at all. Compaction matters for
 * that question: it lifts a commit hash out of assistant prose and lowercases it
 * into metadata, so `Committed ABCDEF1` and `Committed abcdef1` reach the model
 * identically even though the authored strings differ.
 */
export function compactedEvidenceMessages(
    turns: readonly TranscriptTurn[],
): NormalizedEvidenceMessage[] {
    return visibleEvidenceMessages(turns).flatMap((message) => {
        const compacted = compactTextForSummary(message.text, message.role);
        if (!compacted.text) return [];
        return [
            {
                ...message,
                text: [compacted.text, ...compacted.commitHashes].join(" "),
            },
        ];
    });
}

export function renderedTranscriptBlocks(scenario: HistorianEvalScenario): string[] {
    const ballast = ballastProse(scenario.trigger.ballastTokensPerTurn);
    // `compactTextForSummary` removes commit hashes from assistant prose, and `formatBlock` reattaches them in a `commits:` field.
    // Using raw text with empty `commitHashes` changes formatted bytes and token counts.
    // Formatted byte differences can change whether a near-budget chunk splits.
    const block = (role: "user" | "assistant", text: string, ordinal: number): ChunkBlock | null => {
        const seen = messageAsHistorianSeesIt(role, text);
        // The renderer skips messages with no remaining text because the historian receives no block for them.
        // Ordinals use turn indices, so omitted messages do not renumber later blocks.
        if (!seen) return null;
        const compacted = compactTextForSummary(seen, role);
        if (!compacted.text) return null;
        return {
            role: compactRole(role),
            startOrdinal: ordinal,
            endOrdinal: ordinal,
            parts: [compacted.text],
            meta: [],
            commitHashes: compacted.commitHashes,
            isToolOnly: false,
        };
    };
    const blocks: ChunkBlock[] = [];
    scenario.transcript.turns.forEach((turn, index) => {
        const user = block("user", ballast ? `${turn.user} ${ballast}` : turn.user, index * 2 + 1);
        if (user) blocks.push(user);
        const assistant = block("assistant", turn.assistant, index * 2 + 2);
        if (assistant) blocks.push(assistant);
    });
    return blocks.map(formatBlock);
}

/**
 *
 * parseModelRoute rejects `anthropic/` because its model segment is empty.
 *
 * parseModelRoute rejects empty interior segments because `anthropic//` yields the invalid model ID `/`.
 * parseModelRoute trims interior segments so `openrouter / vendor / model-1` resolves without embedded spaces.
 * A slash-bearing model ID like `vendor/model-1` remains valid.
 */
export function parseModelRoute(variable: string, value: string): { providerID: string; modelID: string } {
    const [rawProvider, ...modelParts] = value.split("/");
    const providerID = (rawProvider ?? "").trim();
    const modelSegments = modelParts.map((part) => part.trim());
    const modelID = modelSegments.join("/");
    if (
        providerID.length === 0 ||
        modelSegments.length === 0 ||
        modelSegments.some((segment) => segment.length === 0)
    ) {
        throw new HistorianEvalContractError([
            `${variable}: expected provider/model with both parts non-empty (got "${value}")`,
        ]);
    }
    return { providerID, modelID };
}

/**
 * `[]` means no lint violations.
 * Lint cannot verify coverage of probe fact ranges because it cannot observe live-historian coverage.
 */
export function lintScenario(scenario: HistorianEvalScenario): string[] {
    const diagnostics: string[] = [];
    const label = scenario.id;
    const preEpilogueText = evidenceText(scenario, 0, scenario.transcript.epilogueStartIndex);

    for (const claim of scenario.gold.expectedClaims) {
        if (!MEMORY_CATEGORIES.includes(claim.category)) {
            diagnostics.push(`${label}.gold.expectedClaims.${claim.id}.category: outside-taxonomy`);
        }
        if (normalizeContent(claim.predicate.value).length === 0) {
            diagnostics.push(`${label}.gold.expectedClaims.${claim.id}.predicate: empty-after-normalization`);
        }
        if (claim.sourceTurnRange[1] >= scenario.transcript.epilogueStartIndex) {
            // Facts in the epilogue cannot be attributed to the historian when discard-last removes the epilogue.
            // historian.
            diagnostics.push(`${label}.gold.expectedClaims.${claim.id}.sourceTurnRange: inside-epilogue`);
        }
        // `claim.sourceTurnRange` defines claim provenance; the predicate must occur within that range.
        const authoredIn = evidenceText(scenario, claim.sourceTurnRange[0], claim.sourceTurnRange[1] + 1);
        if (!predicateMatches(claim.predicate, authoredIn)) {
            diagnostics.push(`${label}.gold.expectedClaims.${claim.id}.sourceTurnRange: predicate-not-authored`);
        }
    }
    if (scenario.gold.expectedClaims.length === 0) {
        diagnostics.push(`${label}.gold.expectedClaims: empty`);
    }
    if (scenario.probes.length === 0) {
        // silently skipped.
        diagnostics.push(`${label}.probes: empty`);
    }
    // Probe answers must occur in the referenced claim's source range.
    // The referenced claim's `sourceTurnRange` defines the probe answer's provenance.
    const claimRangeById = new Map(
        scenario.gold.expectedClaims.map((claim) => [
            claim.id,
            evidenceText(scenario, claim.sourceTurnRange[0], claim.sourceTurnRange[1] + 1),
        ]),
    );
    const claimById = new Map(scenario.gold.expectedClaims.map((claim) => [claim.id, claim]));
    for (const probe of scenario.probes) {
        if (probe.answerType === "claim-id") continue;
        const range = claimRangeById.get(probe.sourceClaimRef);
        if (range === undefined) continue;
        if (!containsCompleteValue(range, probe.goldAnswer)) {
            diagnostics.push(`${label}.probes.${probe.id}.goldAnswer: not-authored-in-source-range`);
        }
        // The backing claim must require the answer; otherwise answer omissions are classified as excluded infrastructure loss instead of recall failures.
        const backing = claimById.get(probe.sourceClaimRef);
        if (backing !== undefined && !containsCompleteValue(backing.predicate.value, probe.goldAnswer)) {
            diagnostics.push(`${label}.probes.${probe.id}.goldAnswer: not-required-by-${backing.id}`);
        }
    }

    for (const absent of scenario.gold.expectedAbsent) {
        if (normalizeContent(absent.predicate.value).length === 0) {
            diagnostics.push(`${label}.gold.expectedAbsent.${absent.id}.predicate: empty-after-normalization`);
        }
        // Hard negatives require the forbidden formation in the pre-epilogue transcript; otherwise their absence checks pass vacuously.
        // exercised.
        if (!predicateMatches(absent.predicate, preEpilogueText)) {
            diagnostics.push(`${label}.gold.expectedAbsent.${absent.id}.predicate: not-authored-before-epilogue`);
        }
        // Reject forbidden formations that are normalized substrings of gold claim content because every matching gold claim would violate the hard negative.
        for (const claim of scenario.gold.expectedClaims) {
            if (predicateMatches(absent.predicate, claim.predicate.value)) {
                diagnostics.push(`${label}.gold.expectedAbsent.${absent.id}: contradicts-${claim.id}`);
            }
        }
    }
    // `minCount` cannot exceed twice the transcript turn count.
    if (scenario.gold.compartments.minCount > scenario.transcript.turns.length * 2) {
        diagnostics.push(`${label}.gold.compartments.minCount: exceeds-message-capacity`);
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

    const chunkBudget = deriveHistorianChunkTokens(resolveHistorianContextLimit(undefined));
    // chunk splits.
    // recipe.
    const transcriptTokens = [...renderedFillerBlocks(scenario), ...renderedTranscriptBlocks(scenario)].reduce(
        (total, blockText) => total + estimateTokens(blockText),
        0,
    );
    if (transcriptTokens + scenario.trigger.headroomMarginTokens > chunkBudget) {
        diagnostics.push(
            `${label}.transcript: exceeds-single-chunk-headroom (${transcriptTokens} + margin ${scenario.trigger.headroomMarginTokens} > ${chunkBudget})`,
        );
    }

    // Ordinary turns must stay below the execution threshold and the spike must cross it; otherwise run rows no longer align with scripted outputs.
    // A build turn at or above the threshold launches the historian before driveHistorianRun counts; a spike below the threshold never launches it.
    // `run-never-fired`.
    // usagePercentage uses the declared token value, not input plus cache-write tokens.
    const thresholdPercentage = (tokens: number): number =>
        (tokens / scenario.trigger.modelContextLimit) * 100;
    const buildPercentage = thresholdPercentage(scenario.trigger.usageTokensPerTurn);
    const spikePercentage = thresholdPercentage(scenario.trigger.spikeUsageTokens);
    if (buildPercentage >= EXECUTE_THRESHOLD_PERCENTAGE) {
        diagnostics.push(
            `${label}.trigger.usageTokensPerTurn: build-turn-crosses-threshold (${buildPercentage.toFixed(2)}% >= ${EXECUTE_THRESHOLD_PERCENTAGE}%)`,
        );
    }
    if (spikePercentage < EXECUTE_THRESHOLD_PERCENTAGE) {
        diagnostics.push(
            `${label}.trigger.spikeUsageTokens: spike-below-threshold (${spikePercentage.toFixed(2)}% < ${EXECUTE_THRESHOLD_PERCENTAGE}%)`,
        );
    }

    // The runner appends padding turns after the epilogue; each adds ballastTokensPerTurn to push the protected tail beyond authored content.
    // `ballastTokensPerTurn * MAX_PADDING_TURNS` must reach the protected-tail target.
    // Insufficient padding can surface as `run-never-fired` or `probe-gold-uncovered`.
    const tailTarget = deriveProtectedTailTokenTarget({
        contextLimit: scenario.trigger.modelContextLimit,
        executeThresholdPercentage: EXECUTE_THRESHOLD_PERCENTAGE,
        usagePercentage: (scenario.trigger.spikeUsageTokens / scenario.trigger.modelContextLimit) * 100,
    });
    const paddingTokensPerTurn = Math.max(1, scenario.trigger.ballastTokensPerTurn);
    const paddingTurnsNeeded = Math.ceil(tailTarget.N / paddingTokensPerTurn) + 1;
    if (paddingTurnsNeeded > MAX_PADDING_TURNS) {
        diagnostics.push(
            `${label}.trigger.ballastTokensPerTurn: padding-cannot-clear-protected-tail (${paddingTurnsNeeded} turns at ${paddingTokensPerTurn} token(s) needed for a ${tailTarget.N}-token tail, cap ${MAX_PADDING_TURNS})`,
        );
    }

    // Gold answers must not occur in harness-generated text.
    // `ballastProse` can reproduce words used by a gold answer.
    // Harness text containing a gold answer can satisfy the probe without the injected payload.
    // Post-epilogue padding remains raw because the protected tail is not compartment-covered.
    //
    // `assertProbeGoldCovered` and `goldRangeLeak` do not inspect harness padding.
    // Non-gold tail text may remain raw.
    //
    // Rendered turn indices can match numeric gold answers, so every generated turn index requires checking.
    //
    // `containsCompleteValue` does not match `"4"` within `"4096"`.
    // The lint does not check choice distractors because filler distractors do not reveal the answer.
    const paddingTurns = Math.min(MAX_PADDING_TURNS, paddingTurnsNeeded);
    // `sharedHarnessText` contains text every probe renders; `suffixFor` supplies the per-type suffix.
    // A combined surface would include suffix text that the scored probe does not render.
    // An exact probe with gold answer `"choose"` must not be checked against `PROBE_PROMPT_CHOICE_PREFIX`.
    // The lint must not reject a valid scenario for text absent from that probe's history.
    // False refusals exclude valid scenarios from the corpus.
    const sharedHarnessText = [
        FILLER_TURN.user,
        FILLER_TURN.assistant,
        ballastProse(scenario.trigger.ballastTokensPerTurn),
        // `PROBE_PROMPT_SHARED`, `PROBE_PROMPT_REASK_PREFIX`, and `PROBE_PROMPT_QUESTION_LABEL` appear in the scored turn.
        // A probe whose gold answer is `"project"`, `"memory"`, `"session"`, or `"value"` can copy it from the prompt wrapper.
        PROBE_PROMPT_SHARED,
        PROBE_PROMPT_REASK_PREFIX,
        PROBE_PROMPT_QUESTION_LABEL,
        ...Array.from({ length: paddingTurns }, (_, index) => `Wrap-up housekeeping note ${index + 1}.`),
        "Housekeeping acknowledged.",
        "Continuing.",
        "Acknowledged.",
        ...Array.from(
            { length: scenario.trigger.expectedHistorianRuns },
            (_, index) => `Please continue with step ${index + 1} of the plan.`,
        ),
        "Standing by.",
    ].join(" ");
    // Each probe is checked against its own suffix and every earlier suffix because resumed-session history contains earlier prompts only.
    // An earlier claim-id prompt exposes `"identifier"` to later probes.
    const suffixFor = (probe: Probe): string =>
        probe.answerType === "exact"
            ? PROBE_PROMPT_EXACT_SUFFIX
            : probe.answerType === "multiple-choice"
              ? PROBE_PROMPT_CHOICE_PREFIX
              : PROBE_PROMPT_CLAIM_ID_SUFFIX;
    for (const [index, probe] of scenario.probes.entries()) {
        if (probe.answerType === "claim-id") continue;
        const rendered = scenario.probes.slice(0, index + 1).map(suffixFor);
        if (containsCompleteValue([sharedHarnessText, ...rendered].join(" "), probe.goldAnswer)) {
            diagnostics.push(`${label}.probes.${probe.id}.goldAnswer: occurs-in-harness-owned-text`);
        }
    }

    return diagnostics.sort();
}

/**
 * The release identity excludes the system-version tuple because system changes can alter scores without changing frozen files.
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
    /**
     * `releaseFingerprint` binds approval to the release version, tuple, and tombstones.
     * Excluding tombstones would allow prior approvals to authorize a manifest that removes a tombstone.
     * Removing a tombstone can resurrect a scenario known to be wrong.
     * fresh sign-off.
     */
    releaseFingerprint: string;
}

export interface ReleaseManifest {
    schema: typeof MANIFEST_SCHEMA;
    releaseVersion: string;
    releaseTuple: ReleaseTuple;
    approvals: { privacy: Approval; goldIntent: Approval };
    /**
     * Errata lists scenario IDs from prior releases that were found incorrect.
     * releases are never edited.
     *
     * Tombstones must persist across later releases.
     * `parseManifest` cannot verify tombstone persistence because it receives one manifest.
     * `assertReleaseSuccession` verifies tombstone persistence across manifests.
     * Approval binding prevents prior approvals from authorizing a manifest that drops a tombstone.
     * one.
     */
    tombstones: string[];
}

export function buildReleaseTuple(scenarios: readonly HistorianEvalScenario[]): ReleaseTuple {
    // An empty corpus can produce an approval-bound fingerprint.
    if (scenarios.length === 0) fail("releaseTuple.scenarios: empty");
    // A tombstone for a duplicate scenario ID would retire both scenarios.
    // Unique IDs do not detect scenarios copied under new names.
    // Copying a scenario under a new name creates a distinct `scenarioFingerprint`.
    // `scenarioSemanticFingerprint` detects renamed copies independently of their IDs.
    // A full-fingerprint uniqueness check adds nothing because distinct IDs produce distinct identities.
    unique(
        scenarios.map((scenario) => scenario.id),
        "releaseTuple.scenarios.id",
    );
    unique(
        scenarios.map((scenario) => scenarioSemanticFingerprint(scenario)),
        "releaseTuple.scenarios.semantic",
    );
    const fingerprints = scenarios.map((scenario) => scenarioFingerprint(scenario));
    return {
        corpusFingerprint: canonicalFingerprint([...fingerprints].sort()),
        scenarioSchemaVersion: SCENARIO_SCHEMA,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION,
        sanitizerVersion: SANITIZER_VERSION,
    };
}

/**
 * Approvals cannot authorize releases with different signed fields.
 */
export function releaseApprovalFingerprint(release: {
    releaseVersion: string;
    releaseTuple: ReleaseTuple;
    tombstones: readonly string[];
}): string {
    return canonicalFingerprint({
        releaseVersion: release.releaseVersion,
        releaseTuple: release.releaseTuple,
        tombstones: [...release.tombstones].sort(),
    });
}

export function parseApproval(raw: unknown, label: string): Approval {
    const value = record(raw, label);
    exact(value, ["kind", "approver", "releaseFingerprint"], label);
    return {
        kind: enumeration(value.kind, APPROVAL_KINDS, `${label}.kind`),
        approver: string(value.approver, `${label}.approver`),
        releaseFingerprint: hex64(value.releaseFingerprint, `${label}.releaseFingerprint`),
    };
}

function parseReleaseTuple(raw: unknown, label: string): ReleaseTuple {
    const value = record(raw, label);
    exact(value, ["corpusFingerprint", "scenarioSchemaVersion", "privacyPolicyVersion", "sanitizerVersion"], label);
    if (value.scenarioSchemaVersion !== SCENARIO_SCHEMA) fail(`${label}.scenarioSchemaVersion: version-invalid`);
    // `privacyPolicyVersion` and `sanitizerVersion` must equal the imported constants because they identify enforced policies.
    // Arbitrary version strings could claim policies that the lane does not enforce.
    // An arbitrary version could enter the release fingerprint without identifying an enforced policy.
    // Changing either policy constant invalidates prior approvals.
    if (value.privacyPolicyVersion !== PRIVACY_POLICY_VERSION) fail(`${label}.privacyPolicyVersion: version-invalid`);
    if (value.sanitizerVersion !== SANITIZER_VERSION) fail(`${label}.sanitizerVersion: version-invalid`);
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
    const tombstones = array(root.tombstones, `${label}.tombstones`).map((entry, index) =>
        staticId(entry, `${label}.tombstones[${index}]`, SCENARIO_ID_RE),
    );
    unique(tombstones, `${label}.tombstones`);
    const approvalsValue = record(root.approvals, `${label}.approvals`);
    exact(approvalsValue, ["privacy", "goldIntent"], `${label}.approvals`);
    const privacy = parseApproval(approvalsValue.privacy, `${label}.approvals.privacy`);
    const goldIntent = parseApproval(approvalsValue.goldIntent, `${label}.approvals.goldIntent`);
    if (privacy.kind !== "privacy") fail(`${label}.approvals.privacy.kind: wrong-kind`);
    if (goldIntent.kind !== "gold-intent") fail(`${label}.approvals.goldIntent.kind: wrong-kind`);
    // Privacy and gold-intent approvals represent separate reviews.
    // The two approvals require different approvers to preserve independent reviews.
    // A shared approver would make two approval fields represent one judgment.
    //
    // `normalizeContent` prevents differently spaced or cased approver spellings from satisfying the independence check.
    if (normalizeContent(privacy.approver) === normalizeContent(goldIntent.approver)) {
        fail(`${label}.approvals: approver-not-independent`);
    }
    const expectedFingerprint = releaseApprovalFingerprint({ releaseVersion, releaseTuple, tombstones });
    for (const approval of [privacy, goldIntent]) {
        if (approval.releaseFingerprint !== expectedFingerprint) {
            fail(`${label}.approvals.${approval.kind}: stale-or-foreign-release`);
        }
    }
    return {
        schema: MANIFEST_SCHEMA,
        releaseVersion,
        releaseTuple,
        approvals: { privacy, goldIntent },
        tombstones,
    };
}

/**
 *
 * `ReleaseLineage` accepts historical manifests whose policy constants differ from the current lane's constants.
 */
export interface ReleaseLineage {
    releaseVersion: string;
    tombstones: readonly string[];
}

/**
 *
 * The inheritance check relies only on the schema, release version, and tombstones.
 * `parseReleaseLineage` ignores tuples and approvals because inheritance depends only on tombstones.
 * A predecessor supplies retired scenarios, not a new approval.
 */
export function parseReleaseLineage(raw: unknown, label = "lineage"): ReleaseLineage {
    const root = record(raw, label);
    if (root.schema !== MANIFEST_SCHEMA) fail(`${label}.schema: version-invalid`);
    const releaseVersion = string(root.releaseVersion, `${label}.releaseVersion`);
    if (!RELEASE_VERSION_RE.test(releaseVersion)) fail(`${label}.releaseVersion: version-invalid`);
    const tombstones = array(root.tombstones, `${label}.tombstones`).map((entry, index) =>
        staticId(entry, `${label}.tombstones[${index}]`, SCENARIO_ID_RE),
    );
    unique(tombstones, `${label}.tombstones`);
    return { releaseVersion, tombstones };
}

/**
 * Each later release must carry forward every tombstone declared by its predecessor.
 *
 * A dropped tombstone resurrects a known retired scenario.
 *
 * Version order prevents callers from supplying the releases backwards.
 * A later version defines the tombstone-inheritance direction.
 *
 */
export function assertReleaseSuccession(previous: ReleaseLineage, next: ReleaseLineage): void {
    const versionOf = (release: ReleaseLineage): number => Number(release.releaseVersion.slice(1));
    if (versionOf(next) <= versionOf(previous)) {
        fail("releaseSuccession.releaseVersion: not-later-than-previous");
    }
    const carried = new Set(next.tombstones);
    const dropped = previous.tombstones.filter((id) => !carried.has(id)).sort();
    if (dropped.length > 0) {
        fail(`releaseSuccession.tombstones: dropped-${dropped.join(",")}`);
    }
}

/**
 * A release must not publish and retire the same scenario.
 *
 * `assertTombstonesRetired` requires both `scenarios` and `release.tombstones` because they identify published scenarios and retired IDs, respectively.
 */
export function assertTombstonesRetired(
    scenarios: readonly HistorianEvalScenario[],
    release: ReleaseLineage,
): void {
    const retired = new Set(release.tombstones);
    const published = scenarios.map((scenario) => scenario.id).filter((id) => retired.has(id)).sort();
    if (published.length > 0) {
        fail(`releaseTombstones.scenarios: still-published-${published.join(",")}`);
    }
}
