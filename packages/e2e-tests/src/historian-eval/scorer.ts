/**
 * comparison (U4).
 *
 * The raw-output entry point parses, validates, publishes into an isolated database, and scores the historian artifact.
 * Validation rejections are scoreable outcomes, not crashes.
 * The raw-output seam lets mutation tests score invalid artifacts before database publication.
 *
 * Facts scoring reads `readAuthorizedClaimMemorySnapshot` with the run record's pinned `nowMs`.
 * Re-scoring a run record is time-independent and yields byte-identical verdicts.
 */

import {
    HISTORIAN_BOUNDARY_HEALING_SLACK,
    shouldDiscardLastHistorianCompartment,
    validateHistorianOutput,
    validateStoredCompartments,
    type HistorianValidationChunk,
} from "../../../plugin/src/hooks/magic-context/compartment-runner-validation";
import { Database as BunDatabase } from "bun:sqlite";
import { appendCompartments } from "../../../plugin/src/features/magic-context/compartment-storage";
import { promoteSessionFactsDurable } from "../../../plugin/src/features/magic-context/memory/promotion";
import { getProjectMemoryClaimByPublicId } from "../../../plugin/src/features/magic-context/memory/storage-claim-operations";
import { resolveProjectIdsForIdentities } from "../../../plugin/src/features/magic-context/memory/storage-claim-current-state";
import { createClaimReaderTestDatabase } from "../../../plugin/src/features/magic-context/test-claim-database";
import type { Database } from "../../../plugin/src/shared/sqlite";
import { canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { openTestDb } from "../test-db";
import {
    containsCompleteValue,
    decodeXmlEntities,
    matchesGold,
    normalizeContent,
    predicateMatches,
    scenarioFingerprint,
    triggerFingerprint,
    type ExpectedClaim,
    type HistorianEvalScenario,
    type Probe,
} from "./contract";
import { promotionEvidenceCount, readInjectedClaims } from "./claim-read";
import { verifyAllActiveClaims } from "./verification-bridge";
import {
    COMPARTMENT_BLOCK_TAGS,
    RUN_RECORD_SCHEMA,
    authoredTurnOrdinalsFor,
    buildProbePrompt,
    extractAnswerEnvelope,
    goldRangeLeak,
    injectedBlockContents,
    exposedRanges,
    probeResponseClaimIdLeak,
    probeResponseLeak,
    rangeCoveredByCompartments,
} from "./runner";
import type {
    HistorianEvalRunRecord,
    HistorianRunArtifact,
    InjectedClaimRecord,
    ProbeExchange,
    SystemVersionTuple,
} from "./runner";

/**
 * `LANE_REPORT_SCHEMA` distinguishes incompatible report shapes.
 * `LANE_REPORT_SCHEMA` must change when the report shape becomes incompatible.
 * `LANE_REPORT_SCHEMA` lets consumers distinguish archived reports from reports with the current shape.
 */
const LANE_REPORT_SCHEMA = "historian-eval-report/v3";

/* */
export const FAIL_REASONS = ["false-authoritative", "recall", "structural", "probe", "invalid-output"] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

export interface ProbeVerdict {
    probeId: string;
    outcome: "pass" | "fail" | "error-trimmed";
    expected: string;
    actual: string | null;
}

export interface ScenarioScore {
    scenarioId: string;
    verdict: "PASS" | "FAIL" | "ERROR";
    failReasons: FailReason[];
    errorReason: string | null;
    errorDetail: string | null;
    /** Recall drives FAIL; precision is reported but never fails alone. */
    precision: number | null;
    recall: number | null;
    expectedClaimsMatched: number;
    expectedClaimsTotal: number;
    visibleClaimsMatched: number;
    visibleClaimsTotal: number;
    /** `falseAuthoritativeMatches` lists expected-absent predicate IDs matched by injection-visible claims. */
    falseAuthoritativeMatches: string[];
    structuralFindings: string[];
    probeVerdicts: ProbeVerdict[];
    /**
     * `system` identifies the scored run's system or is null for the raw-output seam and malformed system fields.
     * `buildLaneReport` retains the run's system identity instead of trusting a caller-provided label.
     */
    system: SystemVersionTuple | null;
    /**
     *
     * Malformed-record artifacts must become per-scenario `ERROR` results, not seam results.
     */
    source: "run-record" | "raw-output";
}

export type RawOutputStageResult =
    | { stage: "validation-rejected"; error: string }
    /**
     * An output that leaves authored evidence unprocessed cannot be scored against the scenario's gold.
     *
     * Return `ERROR`, not `FAIL`, because output that omits authored evidence cannot be compared with the scenario's gold.
     * Scoring output that omits authored evidence would produce a vacuous absent-claim pass.
     * Do not classify valid output that omits authored evidence as `validation-rejected`.
     */
    | { stage: "authored-evidence-unprocessed"; error: string }
    | { stage: "scored"; score: ScenarioScore };

interface FactsScore {
    precision: number | null;
    recall: number | null;
    expectedClaimsMatched: number;
    expectedClaimsTotal: number;
    visibleClaimsMatched: number;
    visibleClaimsTotal: number;
    falseAuthoritativeMatches: string[];
}

/**
 * `expectedClaimsMatched` counts gold expectations matched by distinct visible claims.
 *
 * Distinctness prevents one visible claim from satisfying multiple expectations and inflating recall.
 */
function maximumGoldMatching(
    expected: readonly ExpectedClaim[],
    visible: ReadonlyArray<{ category: string; content: string }>,
): number {
    const claimForExpectation = new Array<number>(expected.length).fill(-1);
    const expectationForClaim = new Array<number>(visible.length).fill(-1);
    let matched = 0;
    for (let index = 0; index < expected.length; index += 1) {
        const seen = new Array<boolean>(visible.length).fill(false);
        if (augmentGoldMatch(index, expected, visible, seen, claimForExpectation, expectationForClaim)) {
            matched += 1;
        }
    }
    return matched;
}

function augmentGoldMatch(
    expectationIndex: number,
    expected: readonly ExpectedClaim[],
    visible: ReadonlyArray<{ category: string; content: string }>,
    seen: boolean[],
    claimForExpectation: number[],
    expectationForClaim: number[],
): boolean {
    for (const [claimIndex, item] of visible.entries()) {
        if (seen[claimIndex] || !matchesGold(expected[expectationIndex], item)) continue;
        seen[claimIndex] = true;
        const incumbent = expectationForClaim[claimIndex];
        if (
            incumbent === -1 ||
            augmentGoldMatch(incumbent, expected, visible, seen, claimForExpectation, expectationForClaim)
        ) {
            claimForExpectation[expectationIndex] = claimIndex;
            expectationForClaim[claimIndex] = expectationIndex;
            return true;
        }
    }
    return false;
}

/**
 * `falseAuthoritativeMatches` lists expected-absent predicate IDs matched by a claim set.
 *
 * `scoreRunRecord` checks captured claims when no snapshot-derived visible set exists.
 * Because `ExpectedAbsent` has no category, the captured-claim fallback matches predicates only.
 * The false-authoritative check matches only claim content because `ExpectedAbsent` has no category.
 */
function falseAuthoritativeMatchesIn(
    scenario: HistorianEvalScenario,
    claims: ReadonlyArray<{ content: string }>,
): string[] {
    return scenario.gold.expectedAbsent
        .filter((absent) => claims.some((item) => predicateMatches(absent.predicate, item.content)))
        .map((absent) => absent.id)
        .sort();
}

/**
 * `matchesGold` requires matching categories and content predicates.
 * `ExpectedAbsent` has no category, so the false-authoritative check is predicate-only.
 * `scoreFacts` excludes stale, disputed, and superseded claims, so supersession affects the score.
 */
function scoreFacts(
    scenario: HistorianEvalScenario,
    visible: ReadonlyArray<{ category: string; content: string }>,
): FactsScore {
    const expected = scenario.gold.expectedClaims;
    // Recall uses one-to-one pairings, not independent tests per expectation.
    // A claim can match multiple expectations.
    // Pairing bounds recall by the number of claims the historian formed.
    // measure.
    //
    // `maximumGoldMatching` uses maximum matching because a greedy pass can consume a claim required by a later expectation and understate recall.
    // Both sets contain at most `MAX_EXPECTATION_ENTRIES`, bounding augmenting-path matching.
    // is cheap.
    const matchedExpectedCount = maximumGoldMatching(expected, visible);
    // Precision does not pair claims because one claim can satisfy multiple expectations without becoming multiple correct claims.
    const matchedVisible = visible.filter((item) => expected.some((claim) => matchesGold(claim, item)));
    const falseAuthoritativeMatches = falseAuthoritativeMatchesIn(scenario, visible);
    return {
        precision: visible.length === 0 ? null : matchedVisible.length / visible.length,
        recall: expected.length === 0 ? null : matchedExpectedCount / expected.length,
        expectedClaimsMatched: matchedExpectedCount,
        expectedClaimsTotal: expected.length,
        visibleClaimsMatched: matchedVisible.length,
        visibleClaimsTotal: visible.length,
        falseAuthoritativeMatches,
    };
}

function structuralFindingsFromRows(
    rows: Array<{ startMessage: number; endMessage: number }>,
    minCount: number,
    priorCoverage: { startMessage: number; endMessage: number } | null = null,
    authoredSpan: { startMessage: number; endMessage: number } | null = null,
): string[] {
    const findings: string[] = [];
    // Stored compartments require strictly increasing ordinals, non-overlapping ranges, and contiguous coverage.
    //
    // `priorCoverage` supplies earlier persisted coverage when validating a replayed chunk.
    // Without prior coverage, validating a chunk that starts after ordinal 1 reports a gap outside that chunk.
    // `minCount` excludes `priorCoverage` and counts only `rows`.
    const storedError = validateStoredCompartments(priorCoverage === null ? rows : [priorCoverage, ...rows]);
    if (storedError !== null) findings.push(`stored-compartments: ${storedError}`);
    // When `authoredSpan` is provided, `minCount` counts only rows that intersect it.
    // `minCount` excludes rows that do not intersect `authoredSpan`.
    // Counting rows outside `authoredSpan` could satisfy `minCount` without covering the authored transcript.
    const counted =
        authoredSpan === null
            ? rows
            : rows.filter(
                  (row) => row.endMessage >= authoredSpan.startMessage && row.startMessage <= authoredSpan.endMessage,
              );
    if (counted.length < minCount) {
        const scope = authoredSpan === null ? "persisted" : "persisted across the authored transcript";
        findings.push(`compartment-count: ${counted.length} ${scope}, gold requires at least ${minCount}`);
    }
    return findings;
}

/**
 *
 * Any later successful run marks a discarded provisional last compartment as healed.
 * Validation must inspect every run because later successful runs do not repair kept provisional boundaries.
 * A discarded provisional last compartment remains unhealed when no later run succeeds.
 */
/**
 *
 * `healingFindings` reports unhealed discarded runs, and the probe-coverage gate excludes them.
 * `unhealedDiscardRuns` derives unhealed discarded runs from `runs` so `healingFindings` and the probe-coverage gate remain aligned when finding messages change.
 * The probe-coverage gate excludes kept provisional boundaries because their ranges remain covered and explain no gap.
 */
function unhealedDiscardRuns(record: HistorianEvalRunRecord): HistorianRunArtifact[] {
    const runs = record.historianRuns;
    return runs.filter(
        (run, index) => run.discardedLast && !runs.slice(index + 1).some((later) => later.status === "success"),
    );
}

function healingFindings(record: HistorianEvalRunRecord): string[] {
    const runs = record.historianRuns;
    if (runs.length === 0) return [];
    const findings: string[] = [];
    for (const run of unhealedDiscardRuns(record)) {
        findings.push(
            `healing: run ${run.runIndex} discarded its provisional last compartment and no later successful run healed it`,
        );
    }
    // Validation checks every run because kept provisional boundaries remain covered, so later success cannot heal the boundary.
    // A forbidden forced-keep path remains in the stored structure; subsequent successful runs do not repair it.
    for (const run of runs) {
        if (
            !run.discardedLast &&
            run.emittedCompartments >= 2 &&
            run.lookaheadMargin !== null &&
            run.lookaheadMargin <= HISTORIAN_BOUNDARY_HEALING_SLACK
        ) {
            findings.push(
                `healing: run ${run.runIndex} kept a provisional boundary (lookahead margin ${run.lookaheadMargin} <= slack ${HISTORIAN_BOUNDARY_HEALING_SLACK})`,
            );
        }
    }
    return findings;
}

/**
 * A probe can answer from compartment text when the claim budget omits its claim.
 * `goldAnswerStatedInCompartments` can make a probe available when a compartment states `probe.goldAnswer`.
 *
 * `goldAnswerStatedInCompartments` searches only compartment blocks because predicate text elsewhere can be incidental.
 * A predicate appearing only in prompt text, ordinals, or filler must not make `available` true.
 * `available` must remain false when a predicate appears only outside a compartment; otherwise infrastructure errors become model failures.
 * Historian-authored summary text makes a fact recoverable when its match states that fact.
 *
 * Claim-id probes are unavailable because their answer is the runtime public claim ID.
 * A claim-id probe is always unavailable because `renderClaimMemoryLine` emits the runtime public claim ID only into `<project-memory>`.
 * A compartment block is written before promotion assigns any claim ID.
 * A compartment block is written before promotion assigns any claim ID, so a summary stating the fact does not make the ID recoverable.
 *
 * A payload-less exchange must not count as reachable evidence; otherwise infrastructure errors become model failures.
 */
function goldAnswerStatedInCompartments(probe: Probe, exchange: ProbeExchange): boolean {
    // `finalRequestPayloadText` excludes discarded attempts, whose compartments were not sent with the answering request.
    // Combined request text can include discarded-attempt compartments and incorrectly suppress `error-trimmed` for retries.
    // request.
    const payloadText = exchange.finalRequestPayloadText;
    if (probe.answerType === "claim-id" || payloadText === null) return false;
    // `containsCompleteValue` must match `probe.goldAnswer`, not the gold predicate.
    // Predicate matching would report an answer the probe could not have read.
    //
    // `payloadText` contains escaped wire-form block contents, so matching must decode them first.
    // `A&amp;B` must be decoded before matching `A&B`; raw comparison would report the answer absent.
    // Decoding prevents escaped answer text from producing `error-trimmed`.
    // Decoding prevents `amp` from matching `&amp;` rather than a stated value.
    return containsCompleteValue(
        injectedBlockContents(payloadText, COMPARTMENT_BLOCK_TAGS),
        probe.goldAnswer,
    );
}



/* */
function claimsMatchingGold(claim: ExpectedClaim, items: readonly InjectedClaimRecord[]): InjectedClaimRecord[] {
    return items.filter((item) => matchesGold(claim, item));
}

/**
 * `error-trimmed` applies when matching gold claims provide no answer-bearing injected locator and final-request compartments omit the answer.
 */
export function compareProbeAnswer(args: {
    probe: Probe;
    exchange: ProbeExchange;
    scenario: HistorianEvalScenario;
    injectedClaims: readonly InjectedClaimRecord[];
}): ProbeVerdict {
    const { probe, exchange, scenario, injectedClaims } = args;
    const injectedLocators = new Set(exchange.injectedRevisionLocators);
    const goldClaimId = probe.answerType === "claim-id" ? probe.expectedClaimRef : (probe.sourceClaimRef ?? null);
    const goldClaim = scenario.gold.expectedClaims.find((claim) => claim.id === goldClaimId) ?? null;

    // `compareProbeAnswer` determines availability before acceptance so measurability does not depend on answer correctness.
    //
    // `compareProbeAnswer` classifies unmeasurable probes before acceptance to prevent correct guesses from inflating accuracy.
    //
    if (goldClaim !== null) {
        const promoted = claimsMatchingGold(goldClaim, injectedClaims);
        // A matching claim must contain the probe answer, not only match the gold predicate.
        // Predicate-only matching permits a correct guess to pass without answer evidence.
        //
        // Claim-id probes require no separate answer value because the answer is the claim identity.
        // For claim-id probes, a matching claim at an injected locator supplies the required evidence.
        const answerBearing = (item: InjectedClaimRecord): boolean =>
            probe.answerType === "claim-id" || containsCompleteValue(item.content, probe.goldAnswer);
        const injectedForProbe = promoted.some(
            (item) => injectedLocators.has(item.revisionLocator) && answerBearing(item),
        );
        if (promoted.length > 0 && !injectedForProbe && !goldAnswerStatedInCompartments(probe, exchange)) {
            const expected =
                probe.answerType === "claim-id" ? "<no injected gold claim>" : probe.goldAnswer;
            return { probeId: probe.id, outcome: "error-trimmed", expected, actual: exchange.answerRaw };
        }
    }

    let expected: string;
    let pass: boolean;
    if (probe.answerType === "claim-id") {
        const matching = goldClaim === null ? [] : claimsMatchingGold(goldClaim, injectedClaims);
        const injectedMatching = matching.filter((item) => injectedLocators.has(item.revisionLocator));
        expected = injectedMatching.map((item) => item.publicClaimId).sort().join(" | ") || "<no injected gold claim>";
        pass =
            exchange.answerRaw !== null &&
            injectedMatching.some(
                (item) => normalizeContent(item.publicClaimId) === normalizeContent(exchange.answerRaw ?? ""),
            );
    } else {
        expected = probe.goldAnswer;
        // entity.
        pass =
            exchange.answerRaw !== null &&
            normalizeContent(decodeXmlEntities(exchange.answerRaw)) ===
                normalizeContent(decodeXmlEntities(probe.goldAnswer));
    }
    if (pass) return { probeId: probe.id, outcome: "pass", expected, actual: exchange.answerRaw };

    return { probeId: probe.id, outcome: "fail", expected, actual: exchange.answerRaw };
}

function assembleScore(args: {
    scenarioId: string;
    facts: FactsScore;
    structuralFindings: string[];
    probeVerdicts: ProbeVerdict[];
    /**
     *
     */
    anyRunInvalid: boolean;
    system: SystemVersionTuple | null;
    source: ScenarioScore["source"];
}): ScenarioScore {
    const { scenarioId, facts, structuralFindings, probeVerdicts, anyRunInvalid, system, source } = args;
    const failReasons = new Set<FailReason>();
    if (anyRunInvalid) failReasons.add("invalid-output");
    if (facts.falseAuthoritativeMatches.length > 0) failReasons.add("false-authoritative");
    if (facts.recall !== null && facts.recall < 1) failReasons.add("recall");
    if (structuralFindings.length > 0) failReasons.add("structural");
    if (probeVerdicts.some((verdict) => verdict.outcome === "fail")) failReasons.add("probe");

    //
    const trimmed = probeVerdicts.find((verdict) => verdict.outcome === "error-trimmed");
    if (trimmed !== undefined && failReasons.size === 0) {
        return {
            ...errorScore(
                scenarioId,
                "trimmed-by-injection-budget",
                `probe ${trimmed.probeId}: gold claim promoted but absent from the injected set`,
                system,
                source,
            ),
            probeVerdicts,
        };
    }

    return {
        scenarioId,
        verdict: failReasons.size === 0 ? "PASS" : "FAIL",
        failReasons: FAIL_REASONS.filter((reason) => failReasons.has(reason)),
        errorReason: null,
        errorDetail: null,
        precision: facts.precision,
        recall: facts.recall,
        expectedClaimsMatched: facts.expectedClaimsMatched,
        expectedClaimsTotal: facts.expectedClaimsTotal,
        visibleClaimsMatched: facts.visibleClaimsMatched,
        visibleClaimsTotal: facts.visibleClaimsTotal,
        falseAuthoritativeMatches: facts.falseAuthoritativeMatches,
        structuralFindings,
        probeVerdicts,
        system,
        source,
    };
}

/**
 *
 */
function syntheticChunk(
    scenario: HistorianEvalScenario,
    range: { startOrdinal: number; endOrdinal: number } | null,
): HistorianValidationChunk {
    const startIndex = range?.startOrdinal ?? 1;
    const endIndex = range?.endOrdinal ?? scenario.transcript.turns.length * 2;
    if (startIndex < 1 || endIndex < startIndex) {
        throw new Error(`historian-eval scorer: invalid chunk ordinal range ${startIndex}-${endIndex}`);
    }
    return {
        startIndex,
        endIndex,
        lines: Array.from({ length: endIndex - startIndex + 1 }, (_, index) => ({
            ordinal: startIndex + index,
            messageId: `msg-${startIndex + index}`,
        })),
        toolOnlyRanges: [],
        completedToolArcs: [],
    };
}

const RAW_OUTPUT_SESSION_ID = "historian-eval-raw-output";
const RAW_OUTPUT_PROJECT_IDENTITY = "dir:/historian-eval/raw-output";

/**
 */
let scoringDbTemplate: Uint8Array | null = null;

/**
 *
 */
export function freshScoringDatabase(): Database {
    if (scoringDbTemplate === null) {
        const template = createClaimReaderTestDatabase();
        scoringDbTemplate = (template as unknown as BunDatabase).serialize();
        template.close();
    }
    const db = BunDatabase.deserialize(scoringDbTemplate);
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    return db as unknown as Database;
}

/**
 *
 *
 * A replayed runtime chunk includes harness-owned filler.
 * Replay bounds prevent harness filler and padding from counting toward gold's `minCount`.
 * The bounds make `scoreRawOutput` exclude the compartments that `scoreRunRecord` excludes.
 * Without bounds, the two entry points can score the same output differently.
 * An authored chunk needs no explicit span.
 */
export function scoreRawOutput(
    rawOutput: string,
    scenario: HistorianEvalScenario,
    options: {
        nowMs?: number;
        chunkStartOrdinal?: number;
        chunkEndOrdinal?: number;
        authoredStartOrdinal?: number;
        authoredEndOrdinal?: number;
    } = {},
): RawOutputStageResult {
    const nowMs = options.nowMs ?? Date.now();
    const hasRange = options.chunkStartOrdinal !== undefined || options.chunkEndOrdinal !== undefined;
    if (hasRange && (options.chunkStartOrdinal === undefined || options.chunkEndOrdinal === undefined)) {
        throw new Error("historian-eval scorer: chunkStartOrdinal and chunkEndOrdinal must be supplied together");
    }
    const hasAuthoredSpan =
        options.authoredStartOrdinal !== undefined || options.authoredEndOrdinal !== undefined;
    if (hasRange && !hasAuthoredSpan) {
        throw new Error(
            "historian-eval scorer: a chunk range needs authoredStartOrdinal and authoredEndOrdinal; without them the gold compartment minimum would count harness filler and padding rows",
        );
    }
    if (hasAuthoredSpan && (options.authoredStartOrdinal === undefined || options.authoredEndOrdinal === undefined)) {
        throw new Error("historian-eval scorer: authoredStartOrdinal and authoredEndOrdinal must be supplied together");
    }
    const chunk = syntheticChunk(
        scenario,
        hasRange
            ? { startOrdinal: options.chunkStartOrdinal as number, endOrdinal: options.chunkEndOrdinal as number }
            : null,
    );
    // Default: the chunk is the authored transcript, so it is its own span.
    // The authored span must be non-null because it determines which compartments count toward gold's `minCount`.
    // A runtime chunk range includes harness filler, post-epilogue padding, and the authored transcript.
    // A non-null authored span prevents padding-only compartments from satisfying gold's `minCount`.
    // A non-null authored span keeps `scoreRawOutput` consistent with `scoreRunRecord`.
    //
    // Callers must supply replayed chunks' authored bounds because chunk ranges do not identify them.
    // Capture-time filler shifts authored ordinals.
    // Deriving bounds from the rendered scenario can mis-scope an artifact captured with different filler.
    // A `HistorianRunArtifact` stores the required bounds in `authoredTurnOrdinals`.
    // A caller that omits either authored bound must receive an error rather than a fallback.
    const authoredSpan = hasAuthoredSpan
        ? {
              startMessage: options.authoredStartOrdinal as number,
              endMessage: options.authoredEndOrdinal as number,
          }
        : { startMessage: chunk.startIndex, endMessage: chunk.endIndex };
    const validated = validateHistorianOutput(rawOutput, RAW_OUTPUT_SESSION_ID, chunk, [], 1);
    if (!validated.ok) {
        return { stage: "validation-rejected", error: validated.error };
    }

    // A valid output may stop early by emitting `<unprocessed_from>`.
    // The scorer cannot compare an output ending before the authored span with gold written over that span.
    // The scorer requires emitted compartments to reach the authored span before scoring against gold.
    // The reach requirement prevents coverage checks from accepting an uncovered authored span.
    // The reach requirement prevents an unprocessed hard negative from passing the absence check vacuously.
    //
    // The scorer measures coverage by validated emitted-compartment reach rather than by `unprocessed_from`.
    // The scorer measures reach before discard because coverage concerns emitted output, not persisted production output.
    // The scorer requires coverage of both authored-span ends: a chunk starting after an early hard negative can reach the end and satisfy later positives without evaluating that negative, making its absence check vacuously pass.
    // suffix did.
    const emittedReach = validated.compartments.reduce(
        (furthest, compartment) => Math.max(furthest, compartment.endMessage),
        0,
    );
    const emittedStart = validated.compartments.reduce(
        (earliest, compartment) => Math.min(earliest, compartment.startMessage),
        Number.POSITIVE_INFINITY,
    );
    if (emittedReach < authoredSpan.endMessage || emittedStart > authoredSpan.startMessage) {
        const covered = Number.isFinite(emittedStart) ? `${emittedStart}-${emittedReach}` : "nothing";
        return {
            stage: "authored-evidence-unprocessed",
            error: `output covers ${covered}, which does not span the authored ordinals ${authoredSpan.startMessage}-${authoredSpan.endMessage}; gold and absence checks over the uncovered part would pass vacuously`,
        };
    }

    // This scorer persists only compartments that production would publish.
    // Without this gating, the scorer could promote facts that production would discard.
    const discardLast = shouldDiscardLastHistorianCompartment(validated.compartments, chunk);
    const persisted = discardLast ? validated.compartments.slice(0, -1) : validated.compartments;

    const db = freshScoringDatabase();
    try {
        appendCompartments(db, RAW_OUTPUT_SESSION_ID, persisted);
        if (!discardLast) {
            promoteSessionFactsDurable(db, RAW_OUTPUT_SESSION_ID, RAW_OUTPUT_PROJECT_IDENTITY, validated.facts, {
                producer: "test-historian",
                runId: `${RAW_OUTPUT_SESSION_ID}:${nowMs}`,
                leaseKey: `compartment:${RAW_OUTPUT_SESSION_ID}`,
                leaseGeneration: "historian-eval",
                batchId: "raw-output",
            });
            verifyAllActiveClaims(db, RAW_OUTPUT_PROJECT_IDENTITY, nowMs);
        }

        const visible = readInjectedClaims(db, RAW_OUTPUT_PROJECT_IDENTITY, scenario.id, nowMs);
        if (visible === null) {
            throw new Error("historian-eval scorer: temp-DB claim snapshot unexpectedly stale");
        }
        const rows = persisted.map((compartment) => ({
            startMessage: compartment.startMessage,
            endMessage: compartment.endMessage,
        }));
        return {
            stage: "scored",
            score: assembleScore({
                scenarioId: scenario.id,
                facts: scoreFacts(scenario, visible),
                structuralFindings: structuralFindingsFromRows(
                    rows,
                    scenario.gold.compartments.minCount,
                    chunk.startIndex > 1 ? { startMessage: 1, endMessage: chunk.startIndex - 1 } : null,
                    authoredSpan,
                ),
                probeVerdicts: [],
                anyRunInvalid: false,
                system: null,
                source: "raw-output",
            }),
        };
    } finally {
        db.close();
    }
}

function errorScore(
    scenarioId: string,
    reason: string,
    detail: string | null,
    system: SystemVersionTuple | null = null,
    source: ScenarioScore["source"] = "run-record",
): ScenarioScore {
    return {
        scenarioId,
        verdict: "ERROR",
        failReasons: [],
        errorReason: reason,
        errorDetail: detail,
        precision: null,
        recall: null,
        expectedClaimsMatched: 0,
        expectedClaimsTotal: 0,
        visibleClaimsMatched: 0,
        visibleClaimsTotal: 0,
        falseAuthoritativeMatches: [],
        structuralFindings: [],
        probeVerdicts: [],
        system,
        source,
    };
}

/**
 */
function authoredOrdinalSpan(
    record: HistorianEvalRunRecord,
): { startMessage: number; endMessage: number } | null {
    const ordinals = record.authoredTurnOrdinals;
    if (ordinals.length === 0) return null;
    return {
        startMessage: Math.min(...ordinals.map(([user]) => user)),
        endMessage: Math.max(...ordinals.map(([, assistant]) => assistant)),
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 *
 */
/**
 *
 */
/* */
function isIdentityValue(value: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

function recordShapeError(record: HistorianEvalRunRecord): ScenarioScore | null {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
        return errorScore("<unknown>", "record-malformed", `run record is not an object: ${typeof record}`, null);
    }
    if (record.schema !== RUN_RECORD_SCHEMA) {
        return errorScore(
            typeof record.scenarioId === "string" && record.scenarioId.length > 0 ? record.scenarioId : "<unknown>",
            "record-schema-unsupported",
            `run record schema ${JSON.stringify(record.schema)} is not ${RUN_RECORD_SCHEMA}`,
            null,
        );
    }
    const isPair = (value: unknown): boolean =>
        Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === "number");
    const problems: string[] = [];
    if (typeof record.scenarioId !== "string" || record.scenarioId.length === 0) problems.push("scenarioId");
    if (typeof record.scenarioFingerprint !== "string") problems.push("scenarioFingerprint");
    if (typeof record.triggerFingerprint !== "string") problems.push("triggerFingerprint");
    if (typeof record.sessionId !== "string") problems.push("sessionId");
    if (typeof record.projectIdentity !== "string") problems.push("projectIdentity");
    if (typeof record.nowMs !== "number" || !Number.isFinite(record.nowMs)) problems.push("nowMs");
    if (
        record.system === null ||
        typeof record.system !== "object" ||
        !isIdentityValue(record.system.repoCommitSha) ||
        !isIdentityValue(record.system.bunVersion) ||
        !isIdentityValue(record.system.opencodeVersion) ||
        !isIdentityValue(record.system.historianModelId) ||
        !isIdentityValue(record.system.probeModelId) ||
        record.system.parserImpl !== "ts" ||
        !(record.system.chunkTokenBudget === null || typeof record.system.chunkTokenBudget === "number")
    ) {
        problems.push("system");
    }
    if (typeof record.expectedHistorianRuns !== "number") problems.push("expectedHistorianRuns");
    if (!Array.isArray(record.historianRuns)) {
        problems.push("historianRuns");
    } else if (
        !record.historianRuns.every(
            (run) =>
                run !== null &&
                typeof run === "object" &&
                typeof run.runIndex === "number" &&
                typeof run.status === "string" &&
                typeof run.discardedLast === "boolean" &&
                typeof run.emittedCompartments === "number" &&
                typeof run.persistedCompartments === "number" &&
                typeof run.factsEmitted === "number" &&
                typeof run.promotionEvidenceAdded === "number" &&
                (run.unprocessedFrom === null || typeof run.unprocessedFrom === "number") &&
                (run.failureReason === null || typeof run.failureReason === "string") &&
                (run.lookaheadMargin === null || typeof run.lookaheadMargin === "number") &&
                (run.chunkStartOrdinal === null || typeof run.chunkStartOrdinal === "number") &&
                (run.chunkEndOrdinal === null || typeof run.chunkEndOrdinal === "number"),
        )
    ) {
        problems.push("historianRuns[]");
    }
    if (!Array.isArray(record.probes)) {
        problems.push("probes");
    } else if (
        !record.probes.every(
            (exchange) =>
                exchange !== null &&
                typeof exchange === "object" &&
                typeof exchange.probeId === "string" &&
                (exchange.answerRaw === null || typeof exchange.answerRaw === "string") &&
                (exchange.payloadText === null || typeof exchange.payloadText === "string") &&
                (exchange.finalRequestPayloadText === null ||
                    typeof exchange.finalRequestPayloadText === "string") &&
                (exchange.responseText === null || typeof exchange.responseText === "string") &&
                Array.isArray(exchange.discardedResponseTexts) &&
                exchange.discardedResponseTexts.every((text) => typeof text === "string") &&
                Array.isArray(exchange.injectedRevisionLocators) &&
                exchange.injectedRevisionLocators.every((locator) => typeof locator === "string"),
        )
    ) {
        problems.push("probes[]");
    }
    if (!Array.isArray(record.injectedClaims)) {
        problems.push("injectedClaims");
    } else if (
        !record.injectedClaims.every(
            (claim) =>
                claim !== null &&
                typeof claim === "object" &&
                typeof claim.publicClaimId === "string" &&
                typeof claim.revisionLocator === "string" &&
                typeof claim.content === "string" &&
                typeof claim.category === "string" &&
                typeof claim.revision === "number",
        )
    ) {
        problems.push("injectedClaims[]");
    }
    if (!Array.isArray(record.authoredTurnOrdinals) || !record.authoredTurnOrdinals.every(isPair)) {
        problems.push("authoredTurnOrdinals");
    }
    if (typeof record.contextDbSnapshotPath !== "string") problems.push("contextDbSnapshotPath");
    if (record.error !== null && typeof record.error?.reason !== "string") problems.push("error");
    if (problems.length === 0) return null;
    return errorScore(
        typeof record.scenarioId === "string" ? record.scenarioId : "<unknown>",
        "record-malformed",
        `run record field(s) have the wrong shape: [${problems.join(", ")}]`,
        null,
    );
}

function recordIdentityError(
    record: HistorianEvalRunRecord,
    scenario: HistorianEvalScenario,
): ScenarioScore | null {
    if (record.scenarioId !== scenario.id) {
        return errorScore(
            record.scenarioId,
            "record-scenario-mismatch",
            `run record names scenario ${record.scenarioId}, scored against ${scenario.id}`,
            record.system,
        );
    }
    const fingerprint = scenarioFingerprint(scenario);
    if (record.scenarioFingerprint !== fingerprint) {
        return errorScore(
            record.scenarioId,
            "record-scenario-mismatch",
            `run record fingerprint ${record.scenarioFingerprint} does not match scenario ${scenario.id} (${fingerprint})`,
            record.system,
        );
    }
    const trigger = triggerFingerprint(scenario);
    if (record.triggerFingerprint !== trigger) {
        return errorScore(
            record.scenarioId,
            "record-scenario-mismatch",
            `run record trigger fingerprint ${record.triggerFingerprint} does not match scenario ${scenario.id}'s trigger recipe (${trigger})`,
            record.system,
        );
    }
    if (record.expectedHistorianRuns !== scenario.trigger.expectedHistorianRuns) {
        return errorScore(
            record.scenarioId,
            "record-scenario-mismatch",
            `run record declares ${record.expectedHistorianRuns} historian run(s); scenario declares ${scenario.trigger.expectedHistorianRuns}`,
            record.system,
        );
    }
    const expectedOrdinals = authoredTurnOrdinalsFor(scenario);
    if (canonicalJson(record.authoredTurnOrdinals) !== canonicalJson(expectedOrdinals)) {
        return errorScore(
            record.scenarioId,
            "record-scenario-mismatch",
            `run record's authoredTurnOrdinals ${JSON.stringify(record.authoredTurnOrdinals)} do not match the rendered layout ${JSON.stringify(expectedOrdinals)}`,
            record.system,
        );
    }
    return null;
}

/**
 *
 * An aborted ERROR record retains the runs recorded before the abort.
 */
function recordInventoryError(record: HistorianEvalRunRecord): ScenarioScore | null {
    const indices = record.historianRuns.map((run) => run.runIndex);
    const expected = Array.from({ length: record.expectedHistorianRuns }, (_, index) => index + 1);
    if (indices.length !== expected.length || indices.some((index, position) => index !== expected[position])) {
        return errorScore(
            record.scenarioId,
            "record-runs-incomplete",
            `run record declares ${record.expectedHistorianRuns} historian run(s) but carries indices [${indices.join(", ")}]`,
            record.system,
        );
    }
    // Expected indices do not show whether each run evaluated the historian.
    // The runner rejects `noop` runs and failed runs without a `validation: ` failure reason.
    // Independently stored records bypass runner status validation.
    // A nonexecuted run can retain an expected `runIndex`.
    // Without status validation, `[success, noop]` can score from only the successful run's snapshot.
    // A `noop` run does not evaluate the historian.
    const nonExecuted = record.historianRuns.filter(
        (run) => run.status !== "success" && !(run.status === "failed" && (run.failureReason ?? "").startsWith("validation: ")),
    );
    if (nonExecuted.length > 0) {
        return errorScore(
            record.scenarioId,
            "record-runs-incomplete",
            `run record carries ${nonExecuted.length} run(s) that did not evaluate the historian: ` +
                nonExecuted
                    .map((run) => `run ${run.runIndex} ${run.status}${run.failureReason === null ? "" : ` (${run.failureReason})`}`)
                    .join(", "),
            record.system,
        );
    }
    return null;
}

/**
 *
 * Missing exchanges omit their probes from verdict construction.
 * A missing exchange can leave a hidden probe unevaluated.
 * A missing probe can produce PASS without evaluating that probe.
 * Every declared probe must have exactly one recorded exchange.
 * rejects both.
 */
function probeCoverageError(
    record: HistorianEvalRunRecord,
    scenario: HistorianEvalScenario,
): ScenarioScore | null {
    const declared = scenario.probes.map((probe) => probe.id).sort();
    const recorded = record.probes.map((exchange) => exchange.probeId).sort();
    if (declared.length !== recorded.length || declared.some((id, index) => id !== recorded[index])) {
        return errorScore(
            record.scenarioId,
            "record-probes-incomplete",
            `scenario declares probes [${declared.join(", ")}]; run record carries [${recorded.join(", ")}]`,
            record.system,
        );
    }
    return null;
}

/**
 * Recorded per-run telemetry must agree with the snapshot's `historian_runs`.
 *
 * Structural findings must use snapshot rows rather than record-derived fields.
 * A hand-edited `discardedLast` value can suppress structural findings.
 * `discardedLast: false` and a widened margin can suppress unhealed-discard and forced-keep findings.
 * Recompute structural inputs from snapshot rows because record-derived values can suppress findings.
 *
 * The snapshot must not contain extra historian-run rows.
 * A probe-phase historian pass can add an undeclared historian-run row.
 * An extra historian-run row still contributes compartments and claims to scoring.
 *
 * `lookaheadMargin` uses the compartment prefix after each run, not the final snapshot maximum.
 */
function telemetryMismatch(
    record: HistorianEvalRunRecord,
    rows: ReadonlyArray<{
        status: string;
        failureReason: string | null;
        chunkStartOrdinal: number | null;
        chunkEndOrdinal: number | null;
        compartmentsProduced: number | null;
        factsEmitted: number | null;
        discardedLast: number;
        unprocessedFrom: number | null;
    }>,
    compartmentEndsInSequence: readonly number[],
): string | null {
    if (rows.length !== record.historianRuns.length) {
        return `snapshot holds ${rows.length} historian run row(s), record carries ${record.historianRuns.length}`;
    }
    // Every compartment row must belong to a recorded run.
    const attributedCompartments = record.historianRuns.reduce(
        (total, run) => total + run.persistedCompartments,
        0,
    );
    if (compartmentEndsInSequence.length !== attributedCompartments) {
        return `snapshot holds ${compartmentEndsInSequence.length} compartment row(s); the recorded runs account for ${attributedCompartments}`;
    }
    let persistedSoFar = 0;
    for (const [index, run] of record.historianRuns.entries()) {
        const row = rows[index];
        const discardedLast = row.discardedLast === 1;
        const persisted = row.compartmentsProduced ?? 0;
        persistedSoFar += persisted;
        const prefix = compartmentEndsInSequence.slice(0, persistedSoFar);
        const maxPersistedEnd = prefix.length === 0 ? null : Math.max(...prefix);
        const expected = {
            status: row.status,
            failureReason: row.failureReason,
            chunkStartOrdinal: row.chunkStartOrdinal,
            chunkEndOrdinal: row.chunkEndOrdinal,
            persistedCompartments: persisted,
            factsEmitted: row.factsEmitted ?? 0,
            unprocessedFrom: row.unprocessedFrom ?? null,
            discardedLast,
            emittedCompartments: persisted + (discardedLast ? 1 : 0),
            lookaheadMargin:
                row.chunkEndOrdinal !== null && maxPersistedEnd !== null
                    ? row.chunkEndOrdinal - maxPersistedEnd
                    : null,
        };
        const actual = {
            status: run.status,
            failureReason: run.failureReason,
            chunkStartOrdinal: run.chunkStartOrdinal,
            chunkEndOrdinal: run.chunkEndOrdinal,
            persistedCompartments: run.persistedCompartments,
            factsEmitted: run.factsEmitted,
            unprocessedFrom: run.unprocessedFrom,
            discardedLast: run.discardedLast,
            emittedCompartments: run.emittedCompartments,
            lookaheadMargin: run.lookaheadMargin,
        };
        if (canonicalJson(actual) !== canonicalJson(expected)) {
            return `run ${run.runIndex} telemetry ${canonicalJson(actual)} disagrees with its snapshot row ${canonicalJson(expected)}`;
        }
    }
    return null;
}

/**
 * The parser returns public claim IDs named in the last complete `<project-memory>` block of one captured request, or `null` when no complete block exists.
 *
 * The parser examines one request, not a probe's whole window, because the last block in concatenated re-ask text can belong to the discarded attempt.
 *
 * `null` and the empty set are distinct answers.
 *
 * Anchoring each match on the `: ` separator prevents an ID from matching a longer ID with the same prefix.
 */
function renderedClaimIdsInLastMemoryBlock(payloadText: string): Set<string> | null {
    const blocks = [...payloadText.matchAll(/<project-memory>([\s\S]*?)<\/project-memory>/g)];
    if (blocks.length === 0) return null;
    const ids = new Set<string>();
    for (const line of blocks[blocks.length - 1][1].split("\n")) {
        const separator = /^([^\s:]+)(?: \[[^\]]*\])?: /.exec(line);
        if (separator !== null) ids.add(separator[1]);
    }
    return ids;
}

/**
 *
 * wrong.
 */
type AbortedClaimEvidence =
    | { kind: "scored"; falseAuthoritativeMatches: string[] }
    | { kind: "snapshot-mismatch"; detail: string };

/**
 *
 * Either the record or the snapshot can be edited to misrepresent claim evidence.
 *
 *   promotion.
 * `record`-controlled selectors can omit captured promotions, so the validator accepts snapshot claims only when they equal `record.injectedClaims`.
 *
 * equality.
 *
 *
 */
function abortedRecordClaimEvidence(
    record: HistorianEvalRunRecord,
    scenario: HistorianEvalScenario,
): AbortedClaimEvidence {
    const recordedOnly = (): AbortedClaimEvidence => ({
        kind: "scored",
        falseAuthoritativeMatches: falseAuthoritativeMatchesIn(scenario, record.injectedClaims),
    });
    if (record.contextDbSnapshotPath.length === 0) return recordedOnly();
    let db: ReturnType<typeof openTestDb>;
    try {
        db = openTestDb(record.contextDbSnapshotPath, { readonly: true });
    } catch {
        return recordedOnly();
    }
    try {
        const visible = readInjectedClaims(db, record.projectIdentity, record.scenarioId, record.nowMs);
        if (visible === null) return recordedOnly();
        // The validator rejects an unresolvable `record.projectIdentity` because its empty query result can falsely equal `record.injectedClaims`.
        //
        if (resolveProjectIdsForIdentities(db, [record.projectIdentity]).length === 0) {
            return {
                kind: "snapshot-mismatch",
                detail:
                    "run record's project identity resolves to no project in its snapshot, " +
                    "so its claim set cannot be bound to this run",
            };
        }
        const claimSetIdentity = (claims: ReadonlyArray<InjectedClaimRecord>): string =>
            canonicalJson(
                [...claims].sort((left, right) =>
                    left.revisionLocator < right.revisionLocator
                        ? -1
                        : left.revisionLocator > right.revisionLocator
                          ? 1
                          : 0,
                ),
            );
        if (claimSetIdentity(record.injectedClaims) !== claimSetIdentity(visible)) {
            return {
                kind: "snapshot-mismatch",
                detail:
                    `run record names ${record.injectedClaims.length} injected claim(s) while its snapshot exposes ` +
                    `${visible.length}, and the two sets are not identical, so the snapshot cannot be bound to this run`,
            };
        }
        return { kind: "scored", falseAuthoritativeMatches: falseAuthoritativeMatchesIn(scenario, visible) };
    } catch {
        return recordedOnly();
    } finally {
        db.close();
    }
}

/**
 */
export function scoreRunRecord(record: HistorianEvalRunRecord, scenario: HistorianEvalScenario): ScenarioScore {
    const shapeError = recordShapeError(record);
    if (shapeError !== null) return shapeError;

    const identityError = recordIdentityError(record, scenario);
    if (identityError !== null) return identityError;

    // An `OBSERVED` authoritative state takes precedence over a stored error.
    //
    // Changing the verdict exposes the scenario to the always-run-fatal rule.
    if (record.error !== null) {
        const evidence = abortedRecordClaimEvidence(record, scenario);
        if (evidence.kind === "snapshot-mismatch") {
            return errorScore(
                record.scenarioId,
                "record-snapshot-mismatch",
                `${evidence.detail}; the run also aborted with ${record.error.reason}: ${record.error.detail}`,
                record.system,
            );
        }
        const errored = errorScore(record.scenarioId, record.error.reason, record.error.detail, record.system);
        if (evidence.falseAuthoritativeMatches.length === 0) return errored;
        return {
            ...errored,
            verdict: "FAIL",
            failReasons: ["false-authoritative"],
            falseAuthoritativeMatches: evidence.falseAuthoritativeMatches,
        };
    }

    // Only a record claiming completion is held to the full inventory.
    const inventoryError = recordInventoryError(record);
    if (inventoryError !== null) return inventoryError;

    // A missing, moved, or truncated SQLite snapshot is an infrastructure ERROR for this scenario.
    // lane.
    let db: ReturnType<typeof openTestDb>;
    try {
        db = openTestDb(record.contextDbSnapshotPath, { readonly: true });
    } catch (error) {
        return errorScore(
            record.scenarioId,
            "unreadable-snapshot",
            `context DB snapshot ${record.contextDbSnapshotPath} could not be opened: ${errorMessage(error)}`,
            record.system,
        );
    }
    try {
        let visible: InjectedClaimRecord[] | null;
        let rows: Array<{ startMessage: number; endMessage: number }>;
        try {
            visible = readInjectedClaims(db, record.projectIdentity, record.scenarioId, record.nowMs);
            rows = db
                .prepare(
                    "SELECT start_message AS startMessage, end_message AS endMessage FROM compartments WHERE session_id = ? ORDER BY sequence ASC",
                )
                .all(record.sessionId) as Array<{ startMessage: number; endMessage: number }>;
        } catch (error) {
            return errorScore(
                record.scenarioId,
                "unreadable-snapshot",
                `context DB snapshot ${record.contextDbSnapshotPath} could not be queried: ${errorMessage(error)}`,
                record.system,
            );
        }
        if (visible === null) {
            return errorScore(
                record.scenarioId,
                "stale-snapshot",
                "claim snapshot stale after the injection read's retry",
                record.system,
            );
        }

        // The scorer must bind the record to this snapshot, not merely to the scenario.
        //
        let absent: string[];
        try {
            // A recorded claim is injection evidence only when it belongs to `visible`.
            //
            const ownProjectIds = new Set(resolveProjectIdsForIdentities(db, [record.projectIdentity]));
            const visibleLocators = new Set(visible.map((item) => item.revisionLocator));
            absent = record.injectedClaims
                .filter((claim) => {
                    if (!visibleLocators.has(claim.revisionLocator)) return true;
                    const ref = getProjectMemoryClaimByPublicId(db, claim.publicClaimId);
                    return ref === null || !ownProjectIds.has(ref.projectId);
                })
                .map((claim) => claim.publicClaimId);
        } catch (error) {
            return errorScore(
                record.scenarioId,
                "unreadable-snapshot",
                `context DB snapshot ${record.contextDbSnapshotPath} could not resolve recorded claims: ${errorMessage(error)}`,
                record.system,
            );
        }
        if (absent.length > 0) {
            return errorScore(
                record.scenarioId,
                "record-snapshot-mismatch",
                `run record names ${absent.length} injected claim(s) not on its snapshot's injection surface, or owned by another project: [${absent.slice(0, 5).join(", ")}]`,
                record.system,
            );
        }

        // Filter `visible` because the check detects claims omitted from the run record.
        const recordedLocators = new Set(record.injectedClaims.map((claim) => claim.revisionLocator));
        const unrecorded = visible
            .filter((item) => !recordedLocators.has(item.revisionLocator))
            .map((item) => item.publicClaimId);
        if (unrecorded.length > 0) {
            return errorScore(
                record.scenarioId,
                "record-snapshot-mismatch",
                `snapshot exposes ${unrecorded.length} injection-visible claim(s) the run record never recorded: [${unrecorded.slice(0, 5).join(", ")}]`,
                record.system,
            );
        }

        // A shared locator must name the same claim across the whole record, not just by public ID.
        //
        const duplicateIdentifiers = [
            ...new Set(
                [
                    ...record.injectedClaims
                        .map((claim) => claim.publicClaimId)
                        .filter((id, index, ids) => ids.indexOf(id) !== index),
                    ...record.injectedClaims
                        .map((claim) => claim.revisionLocator)
                        .filter((locator, index, locators) => locators.indexOf(locator) !== index),
                ],
            ),
        ].sort();
        if (duplicateIdentifiers.length > 0) {
            return errorScore(
                record.scenarioId,
                "record-snapshot-mismatch",
                `run record repeats injected-claim identifier(s): [${duplicateIdentifiers.slice(0, 5).join(", ")}]`,
                record.system,
            );
        }

        const recordedByLocator = new Map(record.injectedClaims.map((claim) => [claim.revisionLocator, claim]));
        const divergent = visible
            .filter((item) => {
                const recorded = recordedByLocator.get(item.revisionLocator);
                return recorded !== undefined && canonicalJson(recorded) !== canonicalJson(item);
            })
            .map((item) => item.revisionLocator);
        if (divergent.length > 0) {
            return errorScore(
                record.scenarioId,
                "record-snapshot-mismatch",
                `run record and snapshot disagree on the claim behind ${divergent.length} locator(s): [${divergent.slice(0, 5).join(", ")}]`,
                record.system,
            );
        }

        let runRows: Array<{
            status: string;
            failureReason: string | null;
            chunkStartOrdinal: number | null;
            chunkEndOrdinal: number | null;
            compartmentsProduced: number | null;
            factsEmitted: number | null;
            discardedLast: number;
            unprocessedFrom: number | null;
        }>;
        let compartmentEndsInSequence: number[];
        try {
            runRows = db
                .prepare(
                    `SELECT status, failure_reason AS failureReason, chunk_start_ordinal AS chunkStartOrdinal,
                            chunk_end_ordinal AS chunkEndOrdinal, compartments_produced AS compartmentsProduced,
                            facts_emitted AS factsEmitted, discarded_last AS discardedLast,
                            unprocessed_from AS unprocessedFrom
                       FROM historian_runs WHERE session_id = ? ORDER BY id ASC`,
                )
                .all(record.sessionId) as typeof runRows;
            compartmentEndsInSequence = (
                db
                    .prepare(
                        "SELECT end_message AS endMessage FROM compartments WHERE session_id = ? ORDER BY sequence ASC",
                    )
                    .all(record.sessionId) as Array<{ endMessage: number }>
            ).map((row) => row.endMessage);
        } catch (error) {
            return errorScore(
                record.scenarioId,
                "unreadable-snapshot",
                `context DB snapshot ${record.contextDbSnapshotPath} could not be queried for run telemetry: ${errorMessage(error)}`,
                record.system,
            );
        }
        const mismatch = telemetryMismatch(record, runRows, compartmentEndsInSequence);
        if (mismatch !== null) {
            return errorScore(record.scenarioId, "record-snapshot-mismatch", mismatch, record.system);
        }

        // snapshot supports.
        //
        //
        // Use session-level invocation status because validation-failure runs have no invocation ID.
        //
        // A failed historian attempt prevents attributing exhaustion to the model.
        if (record.historianRuns.some((run) => run.status === "failed")) {
            let attemptStatuses: Array<{ status: string; n: number }>;
            try {
                attemptStatuses = db
                    .prepare(
                        `SELECT status, COUNT(*) AS n FROM subagent_invocations
                          WHERE session_id = ? AND subagent = 'historian' GROUP BY status`,
                    )
                    .all(record.sessionId) as typeof attemptStatuses;
            } catch (error) {
                return errorScore(
                    record.scenarioId,
                    "unreadable-snapshot",
                    `context DB snapshot ${record.contextDbSnapshotPath} could not be queried for invocation status: ${errorMessage(error)}`,
                    record.system,
                );
            }
            const completed = attemptStatuses.find((row) => row.status === "completed")?.n ?? 0;
            const failed = attemptStatuses.filter((row) => row.status !== "completed").reduce((sum, row) => sum + row.n, 0);
            if (completed === 0 || failed > 0) {
                return errorScore(
                    record.scenarioId,
                    "harness-failure",
                    `the record reports a validation failure, but the snapshot shows ${completed} completed and ${failed} non-completed historian attempt(s); without every attempt returning output the exhaustion cannot be attributed to the model`,
                    record.system,
                );
            }
        }

        // Return `FAIL:invalid-output` only after verifying persisted invocation evidence.
        // artifact-integrity ERROR.
        const allAttemptsInvalid =
            record.historianRuns.length > 0 && record.historianRuns.every((run) => run.status === "failed");
        if (allAttemptsInvalid) {
            return assembleScore({
                scenarioId: record.scenarioId,
                facts: {
                    precision: null,
                    recall: null,
                    expectedClaimsMatched: 0,
                    expectedClaimsTotal: scenario.gold.expectedClaims.length,
                    visibleClaimsMatched: 0,
                    visibleClaimsTotal: 0,
                    falseAuthoritativeMatches: [],
                },
                structuralFindings: [],
                probeVerdicts: [],
                anyRunInvalid: true,
                system: record.system,
                source: "run-record",
            });
        }

        // The all-invalid branch records no probe exchanges.
        const coverageError = probeCoverageError(record, scenario);
        if (coverageError !== null) return coverageError;

        // Independently scored records bypass the live coverage gate, so successful chunks must cover the hard-negative suffix.
        // The coverage check requires the chunk ordinals and ranges established by `recordIdentityError` and telemetry verification.
        const preEpilogue = record.authoredTurnOrdinals.slice(0, scenario.transcript.epilogueStartIndex);
        if (preEpilogue.length > 0) {
            const required: [number, number] = [
                preEpilogue[0][0],
                Math.max(...preEpilogue.map(([, assistant]) => assistant)),
            ];
            // Use `exposedRanges`: successful output can stop before its assigned chunk, while validation exhaustion exposes the full chunk.
            const exposed = exposedRanges(record.historianRuns);
            if (!rangeCoveredByCompartments(required, exposed)) {
                return errorScore(
                    record.scenarioId,
                    "harness-failure",
                    `the recorded runs exposed [${exposed
                        .map((range) => `${range.start}-${range.end}`)
                        .join(", ")}], which does not cover authored ordinals ${required[0]}-${required[1]}. Part of the transcript was never shown to the model, so absence checks would pass vacuously`,
                    record.system,
                );
            }
        }

        // Independently scored records bypass the live promotion guard, so detect runs whose promoted facts never reach the store.
        //
        // Validate promotion for each run; a scenario-wide total can hide a later run with no promotion.
        // Telemetry validation snapshot-binds `factsEmitted` and `discardedLast`.
        // `promotionEvidenceAdded` is a live-database delta with no per-run snapshot row.
        // When non-discarded runs emitted facts, the snapshot must contain stored promotion evidence under `record.projectIdentity`.
        const lostPromotion = record.historianRuns.filter(
            (run) => !run.discardedLast && run.factsEmitted > 0 && run.promotionEvidenceAdded === 0,
        );
        if (lostPromotion.length > 0) {
            return errorScore(
                record.scenarioId,
                "no-op-promotion",
                lostPromotion
                    .map(
                        (run) =>
                            `run ${run.runIndex} emitted ${run.factsEmitted} fact(s) but added no claim or evidence`,
                    )
                    .join("; "),
                record.system,
            );
        }
        // When non-discarded runs emitted facts, the snapshot must contain stored promotion evidence under `record.projectIdentity`.
        // When non-discarded runs emitted facts, the snapshot must contain stored promotion evidence under `record.projectIdentity`.
        // Claims promoted under another project identity do not satisfy this check.
        // Claims under another project identity can increase a global count without satisfying the project-scoped read.
        const totalFacts = record.historianRuns
            .filter((run) => !run.discardedLast)
            .reduce((sum, run) => sum + run.factsEmitted, 0);
        if (totalFacts > 0) {
            let promotionEvidence: number;
            try {
                promotionEvidence = promotionEvidenceCount(db, record.projectIdentity);
            } catch (error) {
                return errorScore(
                    record.scenarioId,
                    "unreadable-snapshot",
                    `context DB snapshot ${record.contextDbSnapshotPath} could not be queried for promotion evidence: ${errorMessage(error)}`,
                    record.system,
                );
            }
            if (promotionEvidence === 0) {
                return errorScore(
                    record.scenarioId,
                    "no-op-promotion",
                    `${totalFacts} fact(s) emitted across runs but the snapshot holds no claim or evidence under ${record.projectIdentity}`,
                    record.system,
                );
            }
        }

        // Otherwise, a fabricated locator can produce `error-trimmed` or admit an uninjected claim-id answer.
        // A claim-id answer is valid only for an injected claim.
        const recordedLocatorSet = new Set(record.injectedClaims.map((claim) => claim.revisionLocator));
        const foreignProbeLocators = record.probes.flatMap((exchange) =>
            exchange.injectedRevisionLocators
                .filter((locator) => !recordedLocatorSet.has(locator))
                .map((locator) => `${exchange.probeId}:${locator}`),
        );
        if (foreignProbeLocators.length > 0) {
            return errorScore(
                record.scenarioId,
                "record-snapshot-mismatch",
                `probe injected-locator set names ${foreignProbeLocators.length} claim(s) absent from the record's injected claims: [${foreignProbeLocators.slice(0, 5).join(", ")}]`,
                record.system,
            );
        }

        // The recorded set does not prove which locators a probe request carried.
        // A probe can omit a recorded locator unless its captured request is also checked.
        // Removing an injected locator causes `compareProbeAnswer` to treat the gold claim as promoted but not injected.
        // `compareProbeAnswer` returns `error-trimmed` when the gold claim is promoted but not injected.
        // `assembleScore` converts `error-trimmed` into an infrastructure ERROR, excluding the answer from scored metrics.
        //
        // The probe turn's captured request is the per-turn evidence.
        // The plugin writes `session_meta.memory_block_ids` from the claims rendered into `<project-memory>`.
        // A claim ID in the rendered memory block must correspond to a claim recorded in `injectedRevisionLocators` for that request.
        // Each claim ID rendered in the block must map to a revision locator in `injectedRevisionLocators` for that turn.
        // The validator uses the last payload block because `visibleRevisionLocators` is sampled after it.
        // A probe can capture two requests, and an earlier request's block may predate a trim.
        //
        for (const exchange of record.probes) {
            // The validator uses the final request payload because `injectedRevisionLocators` describes that request.
            // The validator does not infer a final-request block from combined request text.
            // A payload contains a final-request block only when that request rendered one.
            if (exchange.finalRequestPayloadText === null) continue;
            const rendered = renderedClaimIdsInLastMemoryBlock(exchange.finalRequestPayloadText);
            if (rendered === null) continue;
            const injectedForTurn = new Set(exchange.injectedRevisionLocators);
            const unclaimed = record.injectedClaims
                .filter(
                    (claim) => rendered.has(claim.publicClaimId) && !injectedForTurn.has(claim.revisionLocator),
                )
                .map((claim) => claim.publicClaimId);
            if (unclaimed.length > 0) {
                return errorScore(
                    record.scenarioId,
                    "record-snapshot-mismatch",
                    `probe ${exchange.probeId} omits ${unclaimed.length} claim(s) its own captured payload rendered as injected: [${unclaimed.slice(0, 5).join(", ")}]`,
                    record.system,
                );
            }
            // A complete `<project-memory>` block must list every injected claim.
            const overclaimed = record.injectedClaims
                .filter((claim) => injectedForTurn.has(claim.revisionLocator) && !rendered.has(claim.publicClaimId))
                .map((claim) => claim.publicClaimId);
            if (overclaimed.length > 0) {
                return errorScore(
                    record.scenarioId,
                    "record-snapshot-mismatch",
                    `probe ${exchange.probeId} claims ${overclaimed.length} injected claim(s) its own captured payload never rendered: [${overclaimed.slice(0, 5).join(", ")}]`,
                    record.system,
                );
            }
        }

        // `minCount` does not prove that this probe's range was covered.
        const compartmentRanges = rows.map((row) => ({ start: row.startMessage, end: row.endMessage }));
        // The validator does not classify gaps explained by an unhealed `DISCARD` as infrastructure errors.
        //
        // Only unhealed `DISCARD` runs excuse uncovered ranges.
        // produce.
        //
        // An uncovered range survives the injection splice as raw probe-payload text.
        const healing = healingFindings(record);
        const gateStandsDown = unhealedDiscardRuns(record).length > 0;
        for (const probe of gateStandsDown ? [] : scenario.probes) {
            const reference = probe.answerType === "claim-id" ? probe.expectedClaimRef : probe.sourceClaimRef;
            const goldClaim = scenario.gold.expectedClaims.find((claim) => claim.id === reference);
            if (goldClaim === undefined) continue;
            const [startTurn, endTurn] = goldClaim.sourceTurnRange;
            const range: [number, number] = [
                record.authoredTurnOrdinals[startTurn][0],
                record.authoredTurnOrdinals[endTurn][1],
            ];
            if (!rangeCoveredByCompartments(range, compartmentRanges)) {
                return errorScore(
                    record.scenarioId,
                    "probe-gold-uncovered",
                    `probe ${probe.id}: gold claim ${goldClaim.id} ordinal range ${range[0]}-${range[1]} not covered by the snapshot's compartments`,
                    record.system,
                );
            }
        }

        // Stored records require a leak check because they bypass the live gate.
        const scriptedProbes = record.system.probeModelId === "scripted-mock";
        for (const probe of scenario.probes) {
            const exchange = record.probes.find((entry) => entry.probeId === probe.id);
            if (exchange === undefined) continue;
            if (exchange.payloadText === null) {
                // `payloadText` is available only for scripted runs.
                if (!scriptedProbes) continue;
                return errorScore(
                    record.scenarioId,
                    "harness-failure",
                    `probe ${probe.id}: scripted record carries no captured payload, so the leak gate cannot be reapplied`,
                    record.system,
                );
            }
            const reference = probe.answerType === "claim-id" ? probe.expectedClaimRef : probe.sourceClaimRef;
            const goldClaim = scenario.gold.expectedClaims.find((claim) => claim.id === reference);
            const leak = goldRangeLeak({
                scenario,
                goldClaims: goldClaim === undefined ? [] : [goldClaim],
                payloadText: exchange.payloadText,
                probePrompt: buildProbePrompt(probe),
            });
            if (leak !== null) {
                return errorScore(record.scenarioId, "gold-range-leak", `probe ${probe.id}: ${leak}`, record.system);
            }
        }

        // `answerRaw` must be derivable from `responseText`.
        // `answerRaw` must be derivable from the recorded response; otherwise editing it to the gold value can turn a probe FAIL into a PASS.
        for (const exchange of record.probes) {
            if (exchange.responseText === null) {
                // `responseText` is required in both modes; `payloadText` is required only for scripted runs.
                return errorScore(
                    record.scenarioId,
                    "harness-failure",
                    `probe ${exchange.probeId}: record carries no response text, so its answer cannot be checked`,
                    record.system,
                );
            }
            const extracted = extractAnswerEnvelope(exchange.responseText);
            if (extracted !== exchange.answerRaw) {
                return errorScore(
                    record.scenarioId,
                    "record-snapshot-mismatch",
                    `probe ${exchange.probeId}: recorded answer ${JSON.stringify(exchange.answerRaw)} is not what its recorded response yields (${JSON.stringify(extracted)})`,
                    record.system,
                );
            }
            // Stored records require a response-leak check because they bypass the live gate.
            // A reply that includes a later probe's answer exposes that answer to the shared session.
            //
            // The validator uses scenario probe order because the runner asks probes in that order.
            const probeIndex = scenario.probes.findIndex((probe) => probe.id === exchange.probeId);
            if (probeIndex !== -1) {
                // Replaying only `responseText` would miss leaks in discarded replies.
                for (const reply of [exchange.responseText, ...exchange.discardedResponseTexts]) {
                    const responseLeak = probeResponseLeak({
                        probes: scenario.probes,
                        probeIndex,
                        responseText: reply,
                    });
                    if (responseLeak !== null) {
                        return errorScore(
                            record.scenarioId,
                            "probe-response-leak",
                            `probe ${exchange.probeId}: ${responseLeak}`,
                            record.system,
                        );
                    }
                }
            }
        }

        // `probeResponseClaimIdLeak` replays claim-ID leak checks because acceptance is per probe.
        // `exchange.injectedRevisionLocators` preserves which claims were accepted for each probe.
        const claimIdLeak = probeResponseClaimIdLeak({
            scenario,
            exchanges: record.probes,
            injectedClaims: record.injectedClaims,
        });
        if (claimIdLeak !== null) {
            return errorScore(record.scenarioId, "probe-response-leak", claimIdLeak, record.system);
        }

        const probesById = new Map(scenario.probes.map((probe) => [probe.id, probe]));
        const probeVerdicts = record.probes.map((exchange) => {
            const probe = probesById.get(exchange.probeId);
            if (probe === undefined) {
                throw new Error(`historian-eval scorer: run record names unknown probe ${exchange.probeId}`);
            }
            return compareProbeAnswer({ probe, exchange, scenario, injectedClaims: record.injectedClaims });
        });

        return assembleScore({
            scenarioId: record.scenarioId,
            facts: scoreFacts(scenario, visible),
            structuralFindings: [
                ...structuralFindingsFromRows(
                    rows,
                    scenario.gold.compartments.minCount,
                    null,
                    authoredOrdinalSpan(record),
                ),
                ...healing,
            ],
            probeVerdicts,
            // The all-failed branch returns before publication because unpublished facts and probes have no score.
            // PARTIAL failures still publish facts and probes, so the scorer scores both.
            // An exhausted-validation run still counts as model evidence.
            // Scenario aggregation counts validation-exhausted runs as model evidence.
            anyRunInvalid: record.historianRuns.some((run) => run.status === "failed"),
            system: record.system,
            source: "run-record",
        });
    } finally {
        db.close();
    }
}

export interface LaneReport {
    schema: typeof LANE_REPORT_SCHEMA;
    releaseVersion: string | null;
    system: SystemVersionTuple | null;
    scenarios: ScenarioScore[];
    aggregate: {
        total: number;
        scored: number;
        errors: number;
        errorCountsByReason: Record<string, number>;
        failCountsByReason: Record<string, number>;
        /** The report micro-averages scored scenarios and excludes ERRORs. */
        precision: number | null;
        recall: number | null;
        /* */
        falseAuthoritativeRate: number | null;
    };
    /** The run is red iff any scenario FAILs or any ERROR occurs. */
    red: boolean;
    /** False-authoritative FAIL is always run-fatal. */
    runFatal: boolean;
}

/**
 * Returns the shared non-null `score.system`, `supplied`, or `null`; rejects raw-output scores and system mismatches.
 *
 * The validator rejects reports that combine scores from different systems.
 * The validator rejects `options.system` when it differs from the shared non-null `score.system`.
 */
function resolveReportSystem(
    scores: readonly ScenarioScore[],
    supplied: SystemVersionTuple | undefined,
): SystemVersionTuple | null {
    const canonical = (system: SystemVersionTuple): string => canonicalJson(system);
    let agreed: SystemVersionTuple | null = null;
    for (const score of scores) {
        if (score.source === "raw-output") {
            throw new Error(
                `historian-eval report: score for ${score.scenarioId} came from the raw-output seam, which is not a lane result`,
            );
        }
        if (score.system === null) continue;
        if (agreed === null) {
            agreed = score.system;
            continue;
        }
        if (canonical(agreed) !== canonical(score.system)) {
            throw new Error(
                `historian-eval report: scores span more than one system (${canonical(agreed)} vs ${canonical(score.system)})`,
            );
        }
    }
    if (supplied !== undefined && agreed !== null && canonical(supplied) !== canonical(agreed)) {
        throw new Error(
            `historian-eval report: supplied system ${canonical(supplied)} does not match the scored records' ${canonical(agreed)}`,
        );
    }
    return agreed ?? supplied ?? null;
}

export function buildLaneReport(
    scores: readonly ScenarioScore[],
    options: { releaseVersion?: string; system?: SystemVersionTuple } = {},
): LaneReport {
    // evaluated nothing.
    if (scores.length === 0) {
        throw new Error("historian-eval report: no scenario scores; an empty lane report cannot be green");
    }
    const system = resolveReportSystem(scores, options.system);
    // not exist.
    const duplicated = [...new Set(
        scores
            .map((score) => score.scenarioId)
            .filter((id, index, ids) => ids.indexOf(id) !== index),
    )].sort();
    if (duplicated.length > 0) {
        throw new Error(`historian-eval report: duplicate scenario score(s) [${duplicated.join(", ")}]`);
    }
    const sorted = [...scores].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
    const errors = sorted.filter((score) => score.verdict === "ERROR");
    const scored = sorted.filter((score) => score.verdict !== "ERROR");

    const errorCountsByReason: Record<string, number> = {};
    for (const score of errors) {
        const reason = score.errorReason ?? "unknown";
        errorCountsByReason[reason] = (errorCountsByReason[reason] ?? 0) + 1;
    }
    const failCountsByReason: Record<string, number> = {};
    for (const score of scored) {
        for (const reason of score.failReasons) {
            failCountsByReason[reason] = (failCountsByReason[reason] ?? 0) + 1;
        }
    }

    const expectedTotal = scored.reduce((sum, score) => sum + score.expectedClaimsTotal, 0);
    const expectedMatched = scored.reduce((sum, score) => sum + score.expectedClaimsMatched, 0);
    const visibleTotal = scored.reduce((sum, score) => sum + score.visibleClaimsTotal, 0);
    const visibleMatched = scored.reduce((sum, score) => sum + score.visibleClaimsMatched, 0);
    const falseAuthoritativeScenarios = scored.filter((score) => score.falseAuthoritativeMatches.length > 0);

    return {
        schema: LANE_REPORT_SCHEMA,
        releaseVersion: options.releaseVersion ?? null,
        system,
        scenarios: sorted,
        aggregate: {
            total: sorted.length,
            scored: scored.length,
            errors: errors.length,
            errorCountsByReason,
            failCountsByReason,
            precision: visibleTotal === 0 ? null : visibleMatched / visibleTotal,
            recall: expectedTotal === 0 ? null : expectedMatched / expectedTotal,
            falseAuthoritativeRate: scored.length === 0 ? null : falseAuthoritativeScenarios.length / scored.length,
        },
        red: sorted.some((score) => score.verdict !== "PASS"),
        runFatal: scored.some((score) => score.failReasons.includes("false-authoritative")),
    };
}

/**
 *
 *
 */
export function scenarioNotCompletedScore(scenarioId: string, system: SystemVersionTuple | null): ScenarioScore {
    return errorScore(
        scenarioId,
        "scenario-not-completed",
        "the lane had not finished this scenario when the report was written",
        system,
    );
}

/**
 * out.
 *
 */
export function laneBudgetExhaustedScore(scenarioId: string, system: SystemVersionTuple | null): ScenarioScore {
    return errorScore(
        scenarioId,
        "lane-budget-exhausted",
        "the lane's wall-clock budget could not cover this scenario's worst-case historian waits, so it was not run",
        system,
    );
}

/**
 */
export function laneExitCode(report: LaneReport): number {
    if (report.runFatal) return 2;
    return report.red ? 1 : 0;
}
