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
import {
    compactRole,
    formatBlock,
    type ChunkBlock,
} from "../../../plugin/src/hooks/magic-context/read-session-formatting";
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

/**
 * Operational maxima for authored transcripts. The trigger integers are
 * bounded for the same reason (see `parseTrigger`): the lint renders and
 * tokenizes the whole transcript, so the multiplied mass — turn count times
 * per-turn text plus ballast — must be capped before any rendering happens,
 * or a degenerate artifact hangs lint/CI ahead of every semantic check.
 */
export const MAX_TRANSCRIPT_TURNS = 100;
export const MAX_TURN_TEXT_CHARS = 20_000;

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
    if (turns.length > MAX_TRANSCRIPT_TURNS) fail(`${label}.transcript.turns: above-operational-maximum`);
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
 * Scenario identity: canonical fingerprint over the semantic payload plus the
 * scenario's name (id and title), which is what approvals and tombstones bind
 * to. Trigger pressure is harness-owned (R5/KTD3) and excluded, except the
 * declared run count, which is scenario semantics (a run that never fires
 * is ERROR).
 */
export function scenarioFingerprint(scenario: HistorianEvalScenario): string {
    return canonicalFingerprint({
        ...scenarioSemanticPayload(scenario),
        id: scenario.id,
        title: scenario.title,
    });
}

/**
 * What the scenario actually evaluates, with its NAME removed: no id, no title.
 * Copying a scenario and relabelling it changes `scenarioFingerprint` — that is
 * the point of an identity — so the release's uniqueness guard cannot be built
 * on it. Two entries agreeing here drive the same transcript against the same
 * golds and probes, so keeping both double-weights one evaluation in every
 * aggregate the release reports.
 */
function scenarioSemanticPayload(scenario: HistorianEvalScenario): Record<string, unknown> {
    return {
        schema: scenario.schema,
        families: scenario.families,
        transcript: scenario.transcript,
        expectedHistorianRuns: scenario.trigger.expectedHistorianRuns,
        gold: scenario.gold,
        probes: scenario.probes,
    };
}

function scenarioSemanticFingerprint(scenario: HistorianEvalScenario): string {
    return canonicalFingerprint(scenarioSemanticPayload(scenario));
}

/** Normalization applied to both predicate values and candidate content. */
export function normalizeContent(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function predicateMatches(predicate: ContentPredicate, content: string): boolean {
    return normalizeContent(content).includes(normalizeContent(predicate.value));
}

/**
 * Authored evidence text for a half-open turn range: both messages of every
 * turn, ballast excluded. Ballast is harness-owned filler that never carries
 * authored evidence, so including it could only let a predicate match by
 * accident against generated prose.
 */
function evidenceText(scenario: HistorianEvalScenario, startTurn: number, endTurnExclusive: number): string {
    return scenario.transcript.turns
        .slice(startTurn, endTurnExclusive)
        .map((turn) => `${turn.user} ${turn.assistant}`)
        .join(" ");
}

/**
 * The raw text mass the chunk builder will see for the transcript. Rendered
 * with the PRODUCTION `formatBlock` over the block shape the chunk builder
 * constructs (one block per message, compact roles), and with the SHARED
 * ballast generator the harnesses send — so the freeze lint's headroom check
 * measures the same bytes that actually reach the historian, and stays
 * current when either production renderer or ballast generator changes.
 *
 * Ballast is rendered with `ballastProse`'s default seed because that is the
 * only seed the harnesses can send: `TestHarness.ballast(tokens)` and its pi
 * and rust twins take no seed. Rotating the word bank per turn here would
 * measure a transcript no runner produces, and the word bank's words differ in
 * length, so a rotated seed changes the rendered byte count — near the
 * chunk-budget boundary that is the difference between a scenario freezing
 * lint-clean and its live chunk splitting. A runner that ever varies ballast
 * per turn has to thread the same seed through both sides.
 *
 * Exported for the seed-fidelity test: this rendering is the lint's whole
 * measurement surface, so its agreement with the harness is a contract.
 */
export function renderedTranscriptText(scenario: HistorianEvalScenario): string {
    const blocks: ChunkBlock[] = [];
    const ballast = ballastProse(scenario.trigger.ballastTokensPerTurn);
    scenario.transcript.turns.forEach((turn, index) => {
        blocks.push({
            role: compactRole("user"),
            startOrdinal: index * 2 + 1,
            endOrdinal: index * 2 + 1,
            parts: [ballast ? `${turn.user} ${ballast}` : turn.user],
            meta: [],
            commitHashes: [],
            isToolOnly: false,
        });
        blocks.push({
            role: compactRole("assistant"),
            startOrdinal: index * 2 + 2,
            endOrdinal: index * 2 + 2,
            parts: [turn.assistant],
            meta: [],
            commitHashes: [],
            isToolOnly: false,
        });
    });
    return blocks.map(formatBlock).join("\n");
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
     * Errata (R12): scenario ids from prior releases found wrong. Tombstoned
     * ids persist in every later release; existing releases are never edited.
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
    if (privacy.approver === goldIntent.approver) fail(`${label}.approvals: approver-not-independent`);
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
