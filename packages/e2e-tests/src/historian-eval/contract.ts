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
        return {
            id,
            question,
            answerType,
            goldAnswer: string(value.goldAnswer, `${label}.goldAnswer`),
            sourceClaimRef: staticId(value.sourceClaimRef, `${label}.sourceClaimRef`, EXPECTED_CLAIM_ID_RE),
        };
    }
    if (answerType === "multiple-choice") {
        exact(value, ["id", "question", "answerType", "choices", "goldAnswer", "sourceClaimRef"], label);
        const choices = array(value.choices, `${label}.choices`).map((entry, index) =>
            string(entry, `${label}.choices[${index}]`),
        );
        if (choices.length < 2) fail(`${label}.choices: choices-invalid`);
        // Normalized, not verbatim: `probeIdentity` treats case and incidental
        // whitespace as the same answer, so `"Redis"` beside `" redis "` would be
        // two indistinguishable options in one question, and a model picking the
        // non-gold spelling of the same option would be scored wrong.
        unique(choices.map(normalizeContent), `${label}.choices`);
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
        transcript: scenario.transcript,
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
export function renderedTranscriptBlocks(scenario: HistorianEvalScenario): string[] {
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
        if (!normalizeContent(range).includes(normalizeContent(probe.goldAnswer))) {
            diagnostics.push(`${label}.probes.${probe.id}.goldAnswer: not-authored-in-source-range`);
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
    const transcriptTokens = renderedTranscriptBlocks(scenario).reduce(
        (total, blockText) => total + estimateTokens(blockText),
        0,
    );
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
