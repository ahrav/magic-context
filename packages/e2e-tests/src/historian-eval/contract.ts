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

export const SCENARIO_SCHEMA = "historian-eval-scenario/v1";
export const MANIFEST_SCHEMA = "historian-eval-manifest/v1";
export const RELEASE_VERSION_RE = /^v\d+$/;

export { HEX64_RE };
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

const primitives = makeContractPrimitives(HistorianEvalContractError);
const { fail, record, exact, string, staticId, hex64, array, integer, unique } = primitives;
export const enumeration = primitives.enumeration;

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
    const text = string(value.value, `${label}.value`);
    // Bounded for the same reason the transcript maxima exist: a predicate value
    // is normalized and substring-scanned repeatedly — per visible claim during
    // scoring, and all-pairs during the freeze lint's subsumption check — so an
    // unbounded value multiplies through those scans and can stall lint ahead of
    // every semantic check. Well beyond any authored formation.
    if (text.length > MAX_PREDICATE_VALUE_CHARS) fail(`${label}.value: above-operational-maximum`);
    return {
        kind: enumeration(value.kind, ["normalized-substring"], `${label}.kind`),
        value: text,
    };
}

/**
 * Operational maxima for authored transcripts. The trigger integers are
 * bounded for the same reason (see `parseTrigger`): the lint renders and
 * tokenizes the whole transcript, so the multiplied mass — turn count times
 * per-turn text plus ballast — must be capped before any rendering happens,
 * or a degenerate artifact hangs lint/CI ahead of every semantic check.
 */
export const MAX_TRANSCRIPT_TURNS = 100;
export const MAX_TURN_TEXT_CHARS = 20_000;
/**
 * Operational maximum for the authored expectation and probe arrays. Same
 * reason as the transcript maxima, plus one specific to the lint's shape: it
 * compares every expected-absent predicate against every expected claim, so the
 * work is quadratic in these counts. Uncapped, a compact artifact with
 * thousands of entries forces hundreds of millions of normalize-and-substring
 * operations and hangs freeze lint before any semantic check can reject it. The
 * cap is enforced before the arrays are mapped, so the parse itself stays cheap.
 */
export const MAX_EXPECTATION_ENTRIES = 100;

/** Operational maximum for one predicate value; see `parsePredicate`. */
export const MAX_PREDICATE_VALUE_CHARS = 2_000;
/**
 * Reject a gold answer the answer envelope cannot carry.
 *
 * Probe answers travel inside `<answer>...</answer>` and the runner extracts
 * them non-greedily, so a value containing the closing delimiter is read back
 * truncated at that point. The truncated prefix is non-empty, so the runner does
 * not re-ask either — it records a probe FAILURE against an answer no correct
 * reply could ever have produced. Freezing such a value would bake a
 * permanently-wrong probe into the corpus.
 */
function envelopeSafeAnswer(value: string, label: string): string {
    if (value.includes("</answer>") || value.includes("<answer>")) {
        fail(`${label}: answer-envelope-delimiter`);
    }
    return value;
}

/**
 * Operational maximum for one probe's option list. Bounded before the array is
 * mapped for the same reason as the expectation arrays, and separately from them
 * because it is nested: a scenario can stay under the probe cap while each probe
 * carries an enormous option list, and every option is normalized on parse and
 * normalized and sorted again for `probeIdentity`. A question with more options
 * than this is also not one a model can usefully answer.
 */
export const MAX_PROBE_CHOICES = 10;

/** Separator the probe prompt renders multiple-choice options with. */
export const PROBE_CHOICE_SEPARATOR = " | ";

/**
 * Ceiling on the harness-owned padding turns the runner appends after the
 * epilogue. Owned here so the freeze lint can tell whether a recipe's real
 * padding mass can clear its protected tail within the cap.
 */
export const MAX_PADDING_TURNS = 32;

/** Build turns the runner prepends to reach its minimum; see `MIN_BUILD_TURNS`. */
export const MIN_BUILD_TURNS = 10;

/**
 * The harness-owned filler exchange the runner prepends, without ballast.
 *
 * Owned here for the same reason as `renderedTranscriptBlocks`: the freeze lint's
 * chunk-headroom check has to measure the bytes a runner actually sends, and
 * filler turns consume the historian's chunk budget just as authored ones do. A
 * copy of these strings in the runner is how the lint would come to measure a
 * transcript no run produces.
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
    if (answerType === "exact") {
        // `sourceClaimRef` is required, not optional: it is the only thing that
        // gives a probe's gold answer a declared source range. Without it the
        // runtime cannot tell "the supporting turns were trimmed by the injection
        // budget" (the KTD6 ERROR) from "the model got it wrong", so an
        // unanswerable probe would be scored as a model failure and contaminate
        // probe accuracy.
        exact(value, ["id", "question", "answerType", "goldAnswer", "sourceClaimRef"], label);
        const goldAnswer = envelopeSafeAnswer(string(value.goldAnswer, `${label}.goldAnswer`), `${label}.goldAnswer`);
        // A question that states its own answer measures nothing: the value the
        // probe rewards is in the prompt the model is answering, so it needs
        // neither injected memory nor session history to reply correctly.
        //
        // Only for `exact`. A multiple-choice prompt renders every option anyway,
        // so a question that restates them exposes nothing the model was not
        // going to be shown; and a claim-id answer is a runtime id no authored
        // question can contain.
        if (containsCompleteValue(question, goldAnswer)) {
            fail(`${label}.question: self-answering (states its own gold answer ${JSON.stringify(goldAnswer)})`);
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
        // Normalized, not verbatim: `probeIdentity` treats case and incidental
        // whitespace as the same answer, so `"Redis"` beside `" redis "` would be
        // two indistinguishable options in one question, and a model picking the
        // non-gold spelling of the same option would be scored wrong.
        unique(choices.map(normalizeContent), `${label}.choices`);
        // Every choice, not only the gold one: the model may legitimately reply
        // with any of them, and a delimiter-bearing choice would be read back
        // truncated and scored wrong.
        for (const [index, choice] of choices.entries()) {
            envelopeSafeAnswer(choice, `${label}.choices[${index}]`);
            // The prompt renders the options joined by this separator, so a
            // choice containing it makes the option count ambiguous — `["A | B",
            // "C"]` reads as three options — and a valid selection can be scored
            // wrong.
            if (choice.includes(PROBE_CHOICE_SEPARATOR)) {
                fail(`${label}.choices[${index}]: choice-separator`);
            }
        }
        const goldAnswer = string(value.goldAnswer, `${label}.goldAnswer`);
        if (!choices.includes(goldAnswer)) fail(`${label}.goldAnswer: not-a-choice`);
        return {
            id,
            question,
            answerType,
            choices,
            goldAnswer,
            sourceClaimRef: staticId(value.sourceClaimRef, `${label}.sourceClaimRef`, EXPECTED_CLAIM_ID_RE),
        };
    }
    // claim-id: gold names a gold expected-claim reference, never a literal
    // runtime id — the scorer resolves it against the recorded injected set.
    // `expectedClaimRef` already carries the provenance the other two types get
    // from `sourceClaimRef`, so carrying both would be two names for one edge.
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
    // Ids being distinct is not enough: two entries with different ids but the
    // same category and normalized predicate are one expectation written twice.
    // A scorer that checks each expectation independently would count a single
    // injected fact for both and inflate recall; a one-to-one scorer would leave
    // the second permanently unsatisfiable. Either way the number is wrong, so
    // the duplicate must never reach a freeze. The identity is JSON-encoded
    // rather than concatenated so no category string can forge a collision.
    unique(
        expectedClaims.map((claim) => JSON.stringify([claim.category, normalizeContent(claim.predicate.value)])),
        `${label}.gold.expectedClaims.identity`,
    );
    // Identical pairs are the special case; SUBSUMPTION has the same consequence
    // for the same reason. Predicates are normalized substrings, so if two
    // same-category predicates stand in a containment relation, any claim
    // matching the longer necessarily matches the shorter — one injected fact
    // credits both expectations, giving full recall for half the formation. The
    // check above cannot see it because the strings differ.
    //
    // Normalized once per claim, not once per pair: the comparison is all-pairs,
    // so normalizing inside the inner loop would rescan the same values O(n^2)
    // times. `parseExpectedClaim` bounds each value's length, which is what keeps
    // the remaining containment scans bounded too.
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
    // Same argument as the expected-claim identity check above, applied to the
    // other side of the gold: one forbidden formation written twice under two ids
    // becomes two gold checks, so a per-expectation scorer double-counts a single
    // false promotion. Family is part of the identity because the same formation
    // legitimately exercises two families.
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
    // Same argument as the gold identity checks: a probe copied verbatim under a
    // new id asks one question twice, and every aggregate over probe accuracy
    // then weights that behavior double. See `probeIdentity` for what counts as
    // the same question.
    unique(
        probes.map((probe) => {
            const { ask, claimRef } = probeIdentity(probe);
            return canonicalJson([ask, claimRef]);
        }),
        `${label}.probes.identity`,
    );
    // Probes run sequentially in ONE resumed session, so a later probe sees every
    // earlier probe's prompt and answer as recent raw history. That is exploitable
    // whenever the later probe's answer appears anywhere in that history, which is
    // two distinct surfaces: the earlier probe's ANSWER (its gold value and, for
    // multiple-choice, its options) and the earlier probe's QUESTION text. Both are
    // refused per ordered pair below.
    //
    // Probe uniqueness does not cover either: it includes the question text and
    // answer type, so "which cache backs sessions" as multiple-choice and a
    // differently worded exact probe on the same claim are distinct probes whose
    // answers are the same string.
    //
    // This does not make the probes independent — a model can still infer from a
    // related exchange without copying a value. True isolation needs each probe
    // to run from an identical pre-probe session state.
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
            // Two claim-id probes on ONE claim resolve to the same public id, so
            // their empty answer surfaces hide the most direct copy of all.
            if (left.answerType === "claim-id" && right.answerType === "claim-id" && leftRef === rightRef) {
                fail(
                    `${label}.probes: shared-answer-surface (${left.id} and ${right.id} both resolve ${leftRef} to the same runtime claim id)`,
                );
            }
            // Answer values are compared across ALL pairs, not only probes sharing
            // a gold claim. What makes the copy work is that the earlier exchange
            // put the later probe's answer in recent history; which claim each
            // probe rests on does not change that. Two exact probes on different
            // claims that happen to share a gold value are just as copyable, and a
            // multiple-choice prompt can expose another claim's exact answer as one
            // of its options.
            const leftSurface = answerSurface(left);
            const rightSurface = answerSurface(right);
            const shared = leftSurface.filter((value) => rightSurface.includes(value));
            if (shared.length > 0) {
                fail(
                    `${label}.probes: shared-answer-surface (${left.id} and ${right.id} share the answer value ${JSON.stringify(shared[0])}, so the earlier exchange answers the later probe)`,
                );
            }
            // Answer surfaces are not the only part of an earlier exchange the
            // later model reads. The QUESTION text is in the same raw history, and
            // a question can state another probe's answer while asking about
            // something else: "Was the limit 4096?" with gold `yes`, followed by a
            // probe whose gold is `4096`. The surface comparison above cannot see
            // that pair because `yes` and `4096` do not overlap.
            //
            // Directional, because the leak is: probes run in `probes` order, so
            // only the EARLIER question reaches the later model. Comparing both
            // ways would refuse pairs whose exposing text the answering model never
            // saw.
            //
            // Matched as a complete value for the same reason `containsCompleteValue`
            // exists at all: a question that only ever says "4096" must not count as
            // exposing the answer "4". Choices are not compared — a later
            // multiple-choice prompt renders its own options regardless, so an
            // earlier question naming one exposes nothing new.
            if (right.answerType !== "claim-id" && containsCompleteValue(left.question, right.goldAnswer)) {
                fail(
                    `${label}.probes: question-exposed-answer (${left.id} runs first and its question states ${JSON.stringify(right.goldAnswer)}, which is ${right.id}'s gold answer)`,
                );
            }
        }
    }

    const expectedClaimIds = new Set(expectedClaims.map((claim) => claim.id));
    for (const probe of probes) {
        // Every probe type now carries exactly one gold reference, so there is no
        // absent case to tolerate here.
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
 * Scenario identity: canonical fingerprint over everything authored — the
 * semantic payload plus the scenario's name (id and title) — which is what
 * approvals and tombstones bind to. Trigger pressure is harness-owned (R5/KTD3)
 * and excluded, except the declared run count, which is scenario semantics (a
 * run that never fires is ERROR).
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
 * The complete trigger recipe as a fingerprint, for binding a stored run record
 * to the pressure settings it actually executed under.
 *
 * Deliberately separate from `scenarioFingerprint`, which excludes everything
 * here but `expectedHistorianRuns` because trigger pressure is harness-owned and
 * must not move a release-facing semantic identity or invalidate an approval.
 * That exclusion leaves the values unbound to any artifact, and they are not
 * inert: `modelContextLimit` with the per-turn and spike usage decides WHEN the
 * historian fires, `headroomMarginTokens` decides where the protected-tail
 * boundary falls, and `ballastTokensPerTurn` decides how much filler the
 * evaluated chunk carries. Change any of them without touching the run count and
 * an artifact captured under the previous recipe still matches the scenario, so a
 * report can claim the revised recipe was executed while scoring a snapshot the
 * old one produced.
 *
 * Covers the whole recipe including `expectedHistorianRuns`, so the record binds
 * to one object rather than to a hand-maintained subset that a later field
 * addition silently leaves out.
 */
export function triggerFingerprint(scenario: HistorianEvalScenario): string {
    return canonicalFingerprint(scenario.trigger);
}

/**
 * What the scenario actually evaluates, with everything that is only a LABEL
 * removed: no scenario id or title, no contract-local `exp-*`, `abs-*`, or
 * `probe-*` ids, and set-like arrays reordered.
 *
 * Every one of those is a way to spell the same evaluation differently.
 * `scenarioFingerprint` covers them all — that is what makes it an identity —
 * so the release's duplicate guard cannot be built on it: a copy that renames
 * the scenario, renumbers its expectations and probes, rewrites the probe
 * references to match, and permutes the arrays runs the identical transcript
 * against the identical checks, and keeping both double-weights one evaluation
 * in every aggregate the release reports.
 *
 * Probe references are therefore resolved to the referenced claim's own id-free
 * semantics, which is what makes the renumbering invisible here.
 * `transcript.turns` is deliberately left ordered: turn order is meaning, not
 * presentation.
 */
function scenarioDuplicateKey(scenario: HistorianEvalScenario): Record<string, unknown> {
    const claimById = new Map(scenario.gold.expectedClaims.map((claim) => [claim.id, claim]));
    // Predicate values are normalized because that is how they are USED: every
    // comparison runs through `predicateMatches`, so two predicates that
    // normalize alike match identically and the scenarios evaluate identically.
    // Transcript text is deliberately NOT normalized here — it is rendered and
    // tokenized, so its whitespace changes the chunk the historian sees.
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
        // `parseScenario` rejects dangling references, so this resolves for every
        // parsed scenario; the guard keeps it total for a hand-built value.
        // Thrown rather than routed through `fail` so the undefined is narrowed
        // away — `fail` is destructured, which puts it outside control-flow
        // analysis of never-returning calls.
        if (claim === undefined) {
            throw new HistorianEvalContractError(["releaseTuple.scenarios.semantic: dangling-reference"]);
        }
        return claimSemantics(claim);
    };
    return {
        schema: scenario.schema,
        families: canonicalOrder(scenario.families),
        // Turn ORDER is preserved — it is meaning, not presentation — but each
        // message is canonicalized through the same production path the renderer
        // uses. Two transcripts that differ only in internal whitespace, or in a
        // `<system-reminder>` block, reach the historian as identical blocks, so
        // they are the same evaluation and keeping both double-weights it.
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
 * A probe split into what it asks (id-free: the question, the answer that
 * counts, and for multiple choice the option set) and which gold claim backs it.
 *
 * Two probes agreeing on both are one question asked twice, which overweights
 * that behavior in probe accuracy however the scorer aggregates — so `ask` plus
 * `claimRef` is the within-scenario uniqueness key. The duplicate-scenario guard
 * reuses `ask` and swaps `claimRef` for the referenced claim's semantics, so the
 * two views cannot drift apart.
 *
 * Question, gold answer, and choices are normalized because incidental
 * whitespace and case are not a different question. Choices are sorted because
 * their order is presentation. The backing claim is part of the key: a probe
 * backed by a different claim is a different probe.
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
 * Order-independent view of a set-like array: entries sorted by their own
 * canonical serialization, so the result depends on the entries and not on the
 * order they were authored in.
 */
function canonicalOrder<T>(entries: readonly T[]): T[] {
    return [...entries]
        .map((entry) => [canonicalJson(entry), entry] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, entry]) => entry);
}

/** Normalization applied to both predicate values and candidate content. */
export function normalizeContent(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function predicateMatches(predicate: ContentPredicate, content: string): boolean {
    return normalizeContent(content).includes(normalizeContent(predicate.value));
}

/**
 * Whether an injection-visible claim satisfies a gold expected-claim: same
 * category AND content predicate match. The one gold↔claim match rule shared
 * by the runner's per-gold evidence counts and the scorer's facts
 * precision/recall, so run-record evidence and scored verdicts agree on which
 * claims count as gold.
 */
export function matchesGold(
    claim: Pick<ExpectedClaim, "category" | "predicate">,
    item: { category: string; content: string },
): boolean {
    return item.category === claim.category && predicateMatches(claim.predicate, item.content);
}

/**
 * Whether `content` states `value` as a COMPLETE value rather than merely
 * containing its characters.
 *
 * A predicate is a substring matcher by design, but a probe's gold answer is one
 * exact value: plain containment would accept `"4"` as evidenced by a transcript
 * that only ever says `"4096"`, freezing a probe that rewards a wrong answer.
 * The boundary is letter-or-digit adjacency, so `"in-process lru"` still matches
 * inside a sentence while `"4"` no longer matches inside `"4096"`.
 */
export function containsCompleteValue(content: string, value: string): boolean {
    const needle = normalizeContent(value);
    if (needle.length === 0) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(normalizeContent(content));
}

/**
 * One authored message as the historian will actually receive it, or `""` when
 * production discards it outright.
 *
 * Production runs every text part through `normalizeText`, and every USER part
 * through `cleanUserText` first; then it drops a user message whose cleaned text
 * is empty or is a Magic Context system directive, since `hasMeaningfulUserText`
 * rejects both and an authored eval transcript carries no tool parts to rescue it
 * (read-session-chunk.ts). All three rules are applied here so the lint's two
 * consumers — the rendered byte mass and the authored-evidence search — agree
 * with the runtime rather than with the raw JSON.
 *
 * This is why the evidence rules cannot search the raw strings: text that a
 * `<system-reminder>` block carries, or that a directive-only turn carries, is
 * gone before the historian sees it, so a predicate or gold answer found only
 * there is not authored evidence at all — it would make recall failures
 * inevitable or an absence check vacuous.
 */
function messageAsHistorianSeesIt(role: "user" | "assistant", text: string): string {
    if (role !== "user") return normalizeText(text);
    const cleaned = cleanUserText(text);
    return isSystemDirective(cleaned) ? "" : normalizeText(cleaned);
}

/**
 * Authored evidence text for a half-open turn range: both messages of every
 * turn as the historian receives them, ballast excluded. Ballast is
 * harness-owned filler that never carries authored evidence, so including it
 * could only let a predicate match by accident against generated prose.
 */
function evidenceText(scenario: HistorianEvalScenario, startTurn: number, endTurnExclusive: number): string {
    return scenario.transcript.turns
        .slice(startTurn, endTurnExclusive)
        .map(
            (turn) =>
                `${messageAsHistorianSeesIt("user", turn.user)} ${messageAsHistorianSeesIt("assistant", turn.assistant)}`,
        )
        .join(" ");
}

/**
 * The transcript as the chunk builder will see it: one formatted block per
 * message. Rendered with the PRODUCTION `formatBlock` over the block shape the
 * chunk builder constructs (one block per message, compact roles), and with the
 * SHARED ballast generator the harnesses send — so the freeze lint's headroom
 * check measures the same bytes that actually reach the historian, and stays
 * current when either production renderer or ballast generator changes.
 *
 * Returned per block, not joined, because production budgets per block: it
 * tokenizes each `formatBlock` result and accumulates the counts (see
 * `flushCurrentBlock` in read-session-chunk.ts). Token estimation is not
 * additive across concatenation — BPE merges across a joining newline and the
 * heuristic fallback rounds per call — so a joined estimate is a different
 * number from the one the budget decision uses.
 *
 * Ballast is generated by the shared `ballastProse`, whose output depends on the
 * token count alone. That is deliberate and load-bearing here: the harnesses
 * send `ballastProse(tokens)` and so does this renderer, so lint cannot measure
 * a transcript no runner produces. The generator used to take a seed that
 * rotated its word bank, and this renderer rotated it per turn while every
 * harness used the default — because the bank's words differ in length, that
 * measured a different SIZE, which near the chunk-budget boundary is the
 * difference between a scenario freezing lint-clean and its live chunk
 * splitting. The parameter is gone, so the divergence is now unrepresentable.
 *
 * Exported for the fidelity tests: this rendering is the lint's whole
 * measurement surface, so its agreement with the harness is a contract.
 */
/**
 * Token usage the lane reports for one transcript turn carrying `tokens`.
 *
 * The count is reported as BOTH input and cache-write. Owned here, and built from
 * here by the runner, so the shape has one definition rather than a literal
 * repeated at each usage site.
 *
 * It does NOT follow that the threshold sees twice the declared number: the
 * percentage the protected-tail boundary consumes matches the declared count, as
 * the harness suite demonstrates, so the lint's threshold math uses the declared
 * value.
 */
export function triggerTurnUsage(tokens: number): {
    input_tokens: number;
    cache_creation_input_tokens: number;
} {
    return { input_tokens: tokens, cache_creation_input_tokens: tokens };
}

/**
 * Execution threshold the lane pins into every harness config, owned here
 * rather than by the runner because the freeze lint has to reason about it: a
 * trigger recipe is only valid relative to the threshold its runs will use.
 * The runner imports this, so recipe and product cannot drift apart.
 */
export const EXECUTE_THRESHOLD_PERCENTAGE = 40;

/**
 * Rendered blocks for the harness-owned filler turns that PRECEDE the authored
 * transcript, in the same production text path `renderedTranscriptBlocks` uses.
 *
 * Separate from the authored renderer because that one is the lint's measurement
 * surface for authored content and the fidelity tests bind to it; these turns are
 * excluded from gold and the fingerprint but still occupy the chunk.
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
    // Ballast comes from the scenario's own trigger inside the renderer, so the
    // filler turns carry exactly what the runner attaches to them.
    return renderedTranscriptBlocks(filler);
}

export function renderedTranscriptBlocks(scenario: HistorianEvalScenario): string[] {
    const ballast = ballastProse(scenario.trigger.ballastTokensPerTurn);
    // Built through the production text path, not from the raw authored strings:
    // `compactTextForSummary` strips a commit hash out of assistant prose and
    // returns it separately, and `formatBlock` then re-attaches it as a `commits:`
    // suffix. Hard-coding empty `commitHashes` and raw text produced different
    // bytes — and therefore a different token count — from what the historian
    // receives, which near the budget decides whether the live chunk splits.
    const block = (role: "user" | "assistant", text: string, ordinal: number): ChunkBlock | null => {
        const seen = messageAsHistorianSeesIt(role, text);
        // Production `continue`s past a message with no remaining text rather than
        // emitting an empty block, so emitting one here would put bytes in the
        // measurement that the historian never receives. Ordinals are derived from
        // the turn index, so skipping one does not renumber the rest.
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
 * Freeze lint (U1). Returns sorted diagnostics; empty array = lint-clean.
 * Coverage of probe gold-fact ranges is a runtime precondition (KTD6), not
 * a lint rule — the lint cannot know what the live historian will cover.
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
            // Gold facts in the epilogue would be dropped whenever discard-last
            // heals the boundary, so recall could never be attributed to the
            // historian.
            diagnostics.push(`${label}.gold.expectedClaims.${claim.id}.sourceTurnRange: inside-epilogue`);
        }
        // The range is what the probe tier's leakage gate trusts when it decides
        // whether the fact-bearing raw text survived injection, and what the
        // scorer treats as the fact's origin. A predicate absent from every
        // message in its declared range names no authored fact at all: the
        // scenario would score the historian against something the transcript
        // never said, and the leakage gate would guard the wrong turns.
        const authoredIn = evidenceText(scenario, claim.sourceTurnRange[0], claim.sourceTurnRange[1] + 1);
        if (!predicateMatches(claim.predicate, authoredIn)) {
            diagnostics.push(`${label}.gold.expectedClaims.${claim.id}.sourceTurnRange: predicate-not-authored`);
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
    // `parseScenario` proves a probe's gold reference RESOLVES; it says nothing
    // about the answer. An answer absent from the referenced claim's source range
    // is not transcript-supported, so the frozen probe would reward a
    // hallucination and mark the supported answer wrong. Checked against the
    // referenced range rather than the whole transcript because that range is
    // what the probe claims as its provenance.
    const claimRangeById = new Map(
        scenario.gold.expectedClaims.map((claim) => [
            claim.id,
            evidenceText(scenario, claim.sourceTurnRange[0], claim.sourceTurnRange[1] + 1),
        ]),
    );
    for (const probe of scenario.probes) {
        if (probe.answerType === "claim-id") continue;
        const range = claimRangeById.get(probe.sourceClaimRef);
        if (range === undefined) continue;
        if (!containsCompleteValue(range, probe.goldAnswer)) {
            diagnostics.push(`${label}.probes.${probe.id}.goldAnswer: not-authored-in-source-range`);
        }
    }

    // The answer must also not be sitting in HARNESS-owned text. The runner wraps
    // the authored transcript in filler, per-turn ballast, post-epilogue padding,
    // and spike/kick turns, and `ballastProse` draws from a fixed word bank —
    // "boundary", "session", "threshold", "snapshot", "budget" among them. A gold
    // answer that collides with any of that, or with the harness's own turn text,
    // is stated repeatedly in raw history, and the post-epilogue padding sits in
    // the PROTECTED TAIL, which is never compartment-covered and therefore never
    // spliced out. So the probe model can read the answer off recent raw history
    // and PASS with the injected payload contributing nothing.
    //
    // Neither runtime gate covers this. `assertProbeGoldCovered` and
    // `goldRangeLeak` are both scoped to the AUTHORED gold range — deliberately,
    // since an uncovered non-gold tail is allowed to remain raw — so harness
    // padding is outside what either inspects.
    //
    // Checked at freeze time because it is fully determined by the recipe:
    // `ballastProse` output depends only on its token count, and the turn texts are
    // constants. Complete values, so an answer of "4" is not reported merely
    // because the bank emits "4096"-like digits. Choices are not checked — a
    // distractor appearing in filler reveals no answer.
    const ballast = ballastProse(scenario.trigger.ballastTokensPerTurn);
    const harnessOwnedText = [
        FILLER_TURN.user,
        FILLER_TURN.assistant,
        ballast,
        // Padding and spike/kick turns, verbatim from `driveTranscript` and
        // `driveHistorianRun`. Text only: which index each carries cannot change
        // whether a word collides.
        "Wrap-up housekeeping note 1.",
        "Housekeeping acknowledged.",
        "Continuing.",
        "Acknowledged.",
        "Please continue with step 1 of the plan.",
        "Standing by.",
    ].join(" ");
    for (const probe of scenario.probes) {
        if (probe.answerType === "claim-id") continue;
        if (containsCompleteValue(harnessOwnedText, probe.goldAnswer)) {
            diagnostics.push(`${label}.probes.${probe.id}.goldAnswer: occurs-in-harness-owned-text`);
        }
    }

    for (const absent of scenario.gold.expectedAbsent) {
        if (normalizeContent(absent.predicate.value).length === 0) {
            diagnostics.push(`${label}.gold.expectedAbsent.${absent.id}.predicate: empty-after-normalization`);
        }
        // A hard negative only measures non-promotion if the historian was
        // actually exposed to the forbidden formation. A predicate absent from
        // the pre-epilogue transcript — never authored, or authored only in the
        // epilogue that discard-last can drop — passes its absence check
        // vacuously, so the release would claim coverage for a family it never
        // exercised.
        if (!predicateMatches(absent.predicate, preEpilogueText)) {
            diagnostics.push(`${label}.gold.expectedAbsent.${absent.id}.predicate: not-authored-before-epilogue`);
        }
        // A forbidden formation that is a normalized substring of a gold
        // claim's content is a contradiction: any claim satisfying the gold
        // predicate necessarily trips the absent predicate, so the scenario
        // is unsatisfiable and would freeze permanently broken.
        for (const claim of scenario.gold.expectedClaims) {
            if (predicateMatches(absent.predicate, claim.predicate.value)) {
                diagnostics.push(`${label}.gold.expectedAbsent.${absent.id}: contradicts-${claim.id}`);
            }
        }
    }
    // Compartments partition the chunk's messages (one message belongs to
    // exactly one compartment), so a scenario can never produce more of them
    // than it has messages; a larger minCount is unsatisfiable forever.
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

    // Single-chunk headroom (KTD3): production tokenizer + production budget
    // derivation. The historian model is live and unknown at lint time, so
    // the budget uses the production fallback context limit; the declared
    // margin absorbs live-model drift, and the runner records actual chunk
    // state (`hasMore`) at run time.
    const chunkBudget = deriveHistorianChunkTokens(resolveHistorianContextLimit(undefined));
    // Summed per block, matching production's accumulation rather than
    // tokenizing one joined string: a joined estimate is a different number, and
    // near the budget with a small margin the difference decides whether the live
    // chunk splits.
    // Filler blocks included: the runner prepends them whenever the scenario is
    // shorter than the build minimum, and they consume the same chunk budget. An
    // authored-only measurement lets a short, ballast-heavy scenario pass while
    // its filler pushes the gold into another chunk — surfacing at runtime as
    // `run-never-fired` or `probe-gold-uncovered` rather than anything naming the
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

    // Trigger ordering (KTD3): the recipe only produces the run schedule it
    // declares if ordinary turns stay BELOW the execution threshold and the
    // spike crosses it. The numeric bounds on these fields do not imply that
    // ordering, and either violation misaligns run rows against scripted
    // outputs: a build turn at or above the threshold launches the historian
    // during filler or authored turns, before `driveHistorianRun` starts
    // counting, while a spike below it never launches and the scenario ends as
    // `run-never-fired`.
    // Declared tokens over the declared limit. An earlier revision doubled these
    // on the theory that production sums input and cache-write, which the tail
    // target above refutes: the boundary that consumes this same
    // `usagePercentage` matches the declared value, so doubling here would reject
    // recipes whose build turns are genuinely below the threshold.
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

    // Padding mass (KTD3): the runner appends padding turns after the epilogue to
    // push the protected tail past the authored content, each carrying
    // `ballastTokensPerTurn`. The turn count is capped, so a recipe with light
    // ballast against a large tail target cannot build the tail it needs — and the
    // symptom is an unrelated-looking `run-never-fired` or `probe-gold-uncovered`
    // rather than anything naming the recipe.
    // The DECLARED spike percentage, not a doubled "effective" one. The runner
    // passes the same value and the harness suite is the evidence: doubling it
    // moves this target from 13,200 to 6,400 tokens for the canonical recipe,
    // which drops the padding from ten turns to six, and the historian's chunk
    // then stops short of the authored gold — `probe-gold-uncovered` on scenarios
    // that pass with the declared value. Whatever production sums elsewhere, the
    // percentage that predicts THIS boundary is the declared one.
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
    /**
     * Binds the approval to the WHOLE release under review — version, tuple,
     * and tombstones (see `releaseApprovalFingerprint`) — not just the tuple.
     * Tombstones are errata governance: were they outside the binding, a
     * prior release's approvals could be replayed verbatim on a manifest that
     * drops a tombstone, resurrecting a scenario known to be wrong with no
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
     * Errata (R12): scenario ids from prior releases found wrong. Existing
     * releases are never edited.
     *
     * Tombstones must persist into every later release, which is a relation
     * BETWEEN two manifests and therefore not something `parseManifest` can
     * check from one document — see `assertReleaseSuccession`. Approval binding
     * only stops a prior release's approvals being replayed on a manifest that
     * drops a tombstone; it cannot stop a freshly approved release from dropping
     * one.
     */
    tombstones: string[];
}

export function buildReleaseTuple(scenarios: readonly HistorianEvalScenario[]): ReleaseTuple {
    // An empty corpus still hashes to a well-formed fingerprint that approvals
    // can bind to, so the lane would promote a release that measures nothing and
    // report a vacuous pass. Discovery or filtering yielding zero files is a
    // pipeline fault, not a valid release.
    if (scenarios.length === 0) fail("releaseTuple.scenarios: empty");
    // Tombstones are keyed by scenario id, so an id shared by two distinct
    // scenarios would retire both at once. Unique ids alone leave the worse
    // authoring mistake open: `scenarioFingerprint` covers the id and title, so
    // a scenario copied under a new name has a new identity by construction and
    // no identity-based check can see it — while it silently double-weights one
    // evaluation in every aggregate the release reports. Hence the second,
    // name-independent check. A third check over full fingerprints would be
    // dead: distinct ids already imply distinct identities.
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
 * The material an approval signs off on: the release version, the tuple, and
 * the sorted tombstone set. Everything a release states about the corpus and
 * its errata is inside this fingerprint, so approvals cannot transfer across
 * releases that differ in any of it.
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
    // Pinned to the imported constants for the same reason the schema version is:
    // these name the policies the lane actually implements. Accepting arbitrary
    // strings would let a manifest declare `"made-up"` versions, recompute the
    // release fingerprint over them, and present the corpus as reviewed under a
    // privacy or sanitizer policy no code here enforces. Rotating either policy
    // is a deliberate constant bump, which correctly invalidates prior approvals.
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
    // Two approval kinds exist because they are two different reviews: one asks
    // whether the corpus is safe to publish, the other whether the golds encode
    // the intended behavior. One actor holding both seats collapses them into a
    // single judgement while the manifest still presents two, so the manifest
    // would overstate the review the release actually received.
    //
    // Compared through `normalizeContent`, not verbatim: the string validator
    // preserves the authored value, so `"alice"` and `" Alice "` are two
    // spellings of one actor and an exact comparison would let them pass. The
    // lane does not impose an approver-identifier format instead — handles,
    // emails, and directory ids are all org-specific — so it normalizes what it
    // is given rather than legislating the shape.
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
 * The two facts a release states about its own errata: which release it is, and
 * which scenario ids it retires. Nothing here is policy-versioned.
 *
 * Separate from `ReleaseManifest` so a HISTORICAL predecessor can be read for the
 * inheritance check after a deliberate privacy or sanitizer bump. `parseManifest`
 * pins those constants to the ones the lane implements, which is right for a
 * release being published but makes a formerly valid predecessor unparseable the
 * moment either constant rotates — and that is exactly when its tombstones still
 * need to be carried forward. A current `ReleaseManifest` satisfies this shape,
 * so the same check serves both.
 */
export interface ReleaseLineage {
    releaseVersion: string;
    tombstones: readonly string[];
}

/**
 * Read the lineage facts out of any manifest document, current or historical.
 *
 * Validates the manifest schema, the release version, and the tombstone ids —
 * the values this check actually relies on — and deliberately ignores the tuple
 * and approvals. A predecessor is being consulted for what it retired, not
 * re-certified: its approvals were bound to its own corpus under the policy of
 * its day, and re-imposing today's policy on it would only make the inheritance
 * gate unusable across the rotation it is most needed for.
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
 * Enforce the errata invariant across a release boundary: a later release
 * carries forward every tombstone its predecessor declared.
 *
 * Separate from `parseManifest` because this is a relation between two releases,
 * not a property of one document. `parseManifest` can prove a release's
 * approvals are bound to exactly the corpus and tombstone set they signed, which
 * stops a prior release's approvals being REPLAYED on a manifest that drops a
 * tombstone — but a release that drops one and collects fresh approvals is
 * internally consistent, and would resurrect a scenario already known to be
 * wrong. Only the predecessor can rule that out.
 *
 * Version order is checked too, so the arguments cannot be supplied backwards
 * and quietly pass: "later" is what makes the inheritance direction meaningful.
 * Both versions match `RELEASE_VERSION_RE`, so the numeric suffix is total.
 *
 * The stronger alternative is an append-only tombstone registry the promote step
 * reads instead of the previous manifest; this check is what the contract can
 * enforce with no store, and the two are compatible — a registry would supply
 * the `previous` lineage.
 */
export function assertReleaseSuccession(previous: ReleaseLineage, next: ReleaseLineage): void {
    const versionOf = (release: ReleaseLineage): number => Number(release.releaseVersion.slice(1));
    if (versionOf(next) <= versionOf(previous)) {
        fail("releaseSuccession.releaseVersion: not-later-than-previous");
    }
    const carried = new Set(next.tombstones);
    const dropped = previous.tombstones.filter((id) => !carried.has(id)).sort();
    if (dropped.length > 0) {
        // Ids are authored `hse-*` values, not artifact content, so naming them
        // is a diagnostic the operator can act on rather than an echo of the
        // material under review.
        fail(`releaseSuccession.tombstones: dropped-${dropped.join(",")}`);
    }
}

/**
 * A release must not publish and retire the same scenario.
 *
 * The corpus and the tombstone set arrive from opposite directions —
 * `buildReleaseTuple` sees only scenarios, `parseManifest` sees only ids — so
 * neither can catch an id that appears in both, and a release would ship a
 * scenario it simultaneously declares known-wrong. Checked against the scenarios
 * the tuple was built from, since that is the set the fingerprint covers.
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
