/**
 * Historian structural eval lane — deterministic scorer (U3) and hidden-probe
 * comparison (U4).
 *
 * Layered raw-output seam (KTD5): the primary entry point takes the raw
 * historian output artifact and runs it through the production parse →
 * validate → publish-into-temp-DB → score pipeline. Crafted wrong outputs
 * mostly die in `validateHistorianOutput` before any DB exists, so the
 * mutation battery needs this seam upstream of the database; a validation
 * rejection is a scoreable stage outcome, never a crash.
 *
 * Facts scoring reads the literal injection surface —
 * `readAuthorizedClaimMemorySnapshot` (`auto_inject`, active lifecycle,
 * stale retry) — with the run record's pinned `nowMs` threaded through every
 * read, so re-scoring the same run record is time-independent and yields
 * byte-identical verdicts (KTD1).
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
 * Lane-report schema identity. Bumped with the run record for the same change:
 * the report embeds a `SystemVersionTuple` both at the top level and on every
 * scenario score, so requiring `opencodeVersion` (v2) and then `bunVersion` (v3)
 * changed the report's shape too. Left unchanged, one identifier would name two
 * incompatible report shapes and a consumer could not tell an archived report from
 * a current one.
 */
const LANE_REPORT_SCHEMA = "historian-eval-report/v3";

/** KTD8 FAIL reason codes. */
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
    /** Recall drives FAIL; precision is reported but never fails alone (R7). */
    precision: number | null;
    recall: number | null;
    expectedClaimsMatched: number;
    expectedClaimsTotal: number;
    visibleClaimsMatched: number;
    visibleClaimsTotal: number;
    /** Expected-absent predicate ids that matched an injection-visible claim (R8). */
    falseAuthoritativeMatches: string[];
    structuralFindings: string[];
    probeVerdicts: ProbeVerdict[];
    /**
     * System identity of the run this score came from, or null when there is none
     * to trust — the raw-output seam, or a record whose own system field is
     * malformed. Retained so `buildLaneReport` can prove one report describes one
     * system rather than trusting the label its caller passes (KD4/KTD7).
     */
    system: SystemVersionTuple | null;
    /**
     * Which entry point produced this score.
     *
     * The discriminator for lane membership. A null `system` cannot serve: an
     * artifact-integrity ERROR for a malformed record also has none, and treating
     * that as a seam result made one damaged artifact abort the whole report —
     * undoing the per-scenario ERROR it was supposed to become.
     */
    source: "run-record" | "raw-output";
}

export type RawOutputStageResult =
    | { stage: "validation-rejected"; error: string }
    /**
     * The output validated but left authored evidence outside what it processed, so it
     * cannot be scored against this scenario's gold.
     *
     * A distinct stage rather than a FAIL, because it is not a claim about historian
     * quality: an artifact that stopped short simply was not shown the transcript the
     * gold is written against, and scoring it would report a vacuous absence pass. Also
     * not `validation-rejected` — the output IS valid, which is what makes the omission
     * easy to miss.
     */
    | { stage: "authored-evidence-unprocessed"; error: string }
    | { stage: "scored"; score: ScenarioScore };

export interface RawOutputScoringOptions {
    nowMs?: number;
    chunkStartOrdinal?: number;
    chunkEndOrdinal?: number;
    authoredStartOrdinal?: number;
    authoredEndOrdinal?: number;
}

export interface RawOutputScoringRead {
    result: RawOutputStageResult;
    injectedClaims: InjectedClaimRecord[];
}

interface FactsScore {
    precision: number | null;
    recall: number | null;
    expectedClaimsMatched: number;
    expectedClaimsTotal: number;
    visibleClaimsMatched: number;
    visibleClaimsTotal: number;
    falseAuthoritativeMatches: string[];
}

export type ExpectationGoldMatchPredicates = Record<string, boolean>;

/** Independent match predicate per gold expectation; no matching assignment is consulted. */
export function expectationGoldMatchPredicates(
    scenario: HistorianEvalScenario,
    visible: ReadonlyArray<{ category: string; content: string }>,
): ExpectationGoldMatchPredicates {
    return Object.fromEntries(
        scenario.gold.expectedClaims
            .map((expected) => [expected.id, visible.some((claim) => matchesGold(expected, claim))] as const)
            .sort(([left], [right]) => left.localeCompare(right)),
    );
}

/**
 * How many gold expectations can be satisfied by DISTINCT visible claims.
 *
 * Kuhn's augmenting-path search for a maximum bipartite matching, expectations on one
 * side and visible claims on the other, edges from `matchesGold`. Distinctness is the
 * whole point: without it one claim satisfying several expectations inflates recall
 * past the number of claims the historian actually formed.
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
 * Expected-absent predicate ids matched by a claim set (R8).
 *
 * Extracted from `scoreFacts` because the stored-error passthrough in
 * `scoreRunRecord` has to ask the same question of a record's CAPTURED claims,
 * where no snapshot-derived visible set exists. `ExpectedAbsent` carries no
 * category, so the check is predicate-only by construction and needs nothing
 * from a claim but its content.
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
 * Facts precision/recall against gold, keyed by the shared `matchesGold`
 * rule (category + content predicate, R7), plus the separately-reported
 * false-authoritative check (R8; `ExpectedAbsent` carries no category, so
 * that check is predicate-only by construction). Operates on the
 * injection-visible claim set only: soft-hidden (stale/disputed/superseded)
 * claims never reach this list, which is what makes R3's supersession rule
 * checkable at the scored surface.
 */
function scoreFacts(
    scenario: HistorianEvalScenario,
    visible: ReadonlyArray<{ category: string; content: string }>,
): FactsScore {
    const expected = scenario.gold.expectedClaims;
    // Recall is a ONE-TO-ONE pairing, not an independent test per expectation. A gold
    // predicate is a substring matcher, so one formed claim whose content states two
    // same-category predicates satisfies both expectations independently — reporting
    // 2/2 for one claim the historian formed. `parseScenario` refuses identical and
    // subsumed predicates, but two unrelated predicates that can co-occur in one
    // sentence are neither, so the corpus can legally contain the pair. Pairing bounds
    // recall by how many claims were actually formed, which is what the tier claims to
    // measure.
    //
    // Maximum matching rather than greedy, because a greedy pass over expectations can
    // consume a claim that was the only match for a later one and understate recall.
    // Both sides are bounded by `MAX_EXPECTATION_ENTRIES`, so the augmenting-path search
    // is cheap.
    const matchedExpectedCount = maximumGoldMatching(expected, visible);
    // Precision stays per-claim and independent: it asks whether each formed claim is
    // one the gold wanted, and a claim satisfying two expectations is still one correct
    // claim. Pairing it would penalise a historian for stating two wanted facts in one
    // well-formed claim, which is not an error.
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
    // Production-precondition self-check (R9): the same invariant production
    // enforces before publishing — ordinals strictly increasing, ranges
    // non-overlapping, coverage contiguous.
    //
    // Contiguity is a whole-session property, so a replay of one chunk that
    // starts past ordinal 1 needs the coverage its earlier runs already
    // published; without it the invariant reports a gap that is not a property
    // of the output under test. `priorCoverage` stands in for exactly that, and
    // is excluded from the count check so gold's `minCount` still measures only
    // the compartments this output produced.
    const storedError = validateStoredCompartments(priorCoverage === null ? rows : [priorCoverage, ...rows]);
    if (storedError !== null) findings.push(`stored-compartments: ${storedError}`);
    // Contiguity is a whole-session property, but gold's minimum is a claim
    // about the AUTHORED transcript: the session also carries harness-owned
    // filler and post-epilogue padding, which gold and the contract's capacity
    // lint both exclude. Counting those rows would let a historian satisfy the
    // minimum with compartments sitting entirely in filler or padding while
    // covering the authored transcript with one.
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
 * Runs whose discarded provisional compartment no later successful run healed.
 *
 * Extracted because two callers need exactly this subset: `healingFindings`
 * reports it, and the probe-coverage gate stands down for it. Deriving it from
 * the runs rather than filtering finding strings keeps the two from drifting on a
 * message reword — and the OTHER healing class must not be included, since a KEPT
 * provisional boundary leaves its range covered and therefore explains no gap.
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
    // Every run, not just the last. A kept provisional boundary was PERSISTED,
    // so unlike a discard there is nothing for a later run to re-derive — the
    // forbidden forced-keep path is already in the stored structure, and a
    // subsequent success does not repair it.
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
 * Whether a compartment block in this probe's own captured payload states the probe's
 * gold ANSWER — the other surface a probe may answer from when the claim budget
 * dropped its claim.
 *
 * Searched in the compartment blocks only, never the whole payload. A predicate like
 * "4096" can appear incidentally in prompt text, ordinals, or filler, and a false
 * "available" turns an infrastructure ERROR into a model FAIL — the R6 violation in
 * reverse. Historian-authored summary text is the surface whose match actually means
 * the fact was recoverable.
 *
 * False for a claim-id probe unconditionally. Its answer is the runtime public claim
 * id, which `renderClaimMemoryLine` emits into `<project-memory>` and nowhere else; a
 * compartment block is prose about the transcript, written before promotion assigned
 * any id, so a summary stating the fact does not make the id recoverable.
 *
 * False for a payload-less exchange. Live routes cannot capture the request, so there
 * is no evidence the fact was reachable, and assuming it was would charge the model on
 * an absence of proof — the same live-mode capture gap the replayed leak gate carries.
 */
function goldAnswerStatedInCompartments(probe: Probe, exchange: ProbeExchange): boolean {
    // The FINAL request, not the concatenated window. A compartment rendered for a
    // discarded first attempt says nothing about what the answering request carried, and
    // reading the combined text let that stale block suppress `error-trimmed` for a
    // guessed retry — the same staleness the locator evidence already binds to this
    // request.
    const payloadText = exchange.finalRequestPayloadText;
    if (probe.answerType === "claim-id" || payloadText === null) return false;
    // The ANSWER as a complete value, not the gold predicate. A summary matching a
    // predicate broader than the answer states the topic without stating the value, so
    // searching for the predicate reported an answer the probe could not have read.
    //
    // Decoded first, because the payload carries the WIRE form. The renderers escape
    // block contents, so an authored answer of `A&B` reaches the request as `A&amp;B`:
    // comparing against the raw value reported it absent and converted an answerable
    // probe into an infrastructure ERROR. Decoding also removes the reverse hazard, where
    // an answer of `amp` matched the entity text rather than any stated value.
    return containsCompleteValue(
        injectedBlockContents(payloadText, COMPARTMENT_BLOCK_TAGS),
        probe.goldAnswer,
    );
}

/** Resolve a gold expected-claim reference to concrete injected claims. */
function claimsMatchingGold(claim: ExpectedClaim, items: readonly InjectedClaimRecord[]): InjectedClaimRecord[] {
    return items.filter((item) => matchesGold(claim, item));
}

/**
 * Deterministic probe comparison (KD2/KTD6): normalized string equality for
 * exact and multiple-choice; claim-id answers resolve the gold
 * expected-claim reference to runtime public ids via the recorded injected
 * set before comparison. A miss whose backing gold claim was promoted but
 * absent from the injected set is `error-trimmed` — an injection-budget
 * loss, not historian quality.
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

    // Availability BEFORE acceptance, so the two answers to "was this probe
    // measurable?" cannot disagree.
    //
    // `error-trimmed` used to be reachable only through a FAILING answer, so an
    // unmeasurable probe that happened to answer correctly counted as a PASS while the
    // same probe answering wrongly was excluded from the tier. That asymmetry can only
    // bias probe accuracy upward, and a multiple-choice prompt renders every option, so
    // guessing right is a 1-in-N event rather than a remote one. A probe with no
    // surface to recover its answer from is unmeasurable whichever way it answered.
    //
    // Scoped to a claim that WAS promoted. With nothing promoted there is no injection
    // loss to attribute: the facts tier reports the recall miss and a probe verdict on
    // it is ordinary model evidence.
    if (goldClaim !== null) {
        const promoted = claimsMatchingGold(goldClaim, injectedClaims);
        // What the probe needs is its ANSWER, not merely a claim satisfying the gold
        // predicate. A predicate is a substring matcher and can be broader than the
        // answer — predicate "session cache" against gold "Redis" — so a claim reading
        // "session cache configured" satisfies the expectation while supplying nothing
        // the probe could answer from. Requiring only predicate-matching therefore let a
        // correct guess through the gate as a PASS, which is the same hole this gate was
        // added to close, one level in. `lintScenario` does not cover it either: it
        // requires the answer and the predicate to occur in the same source RANGE, not
        // in the same claim.
        //
        // Claim-id probes are the exception, and not by exemption: their answer IS the
        // claim's identity, so a matching claim in the probe's injected set is exactly
        // the evidence, and there is no separate value to look for.
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
        // Decoded on BOTH sides before comparing. A model that read the escaped wire form
        // out of an injected block can answer `A&amp;B` for an authored gold of `A&B`, and
        // the raw comparison marked that correct answer wrong — while the availability
        // check one branch up already decodes the same text, so the two disagreed about
        // what the value is. Both sides, not just the reply: decoding only the model's
        // answer would break the mirror case where the gold itself is authored with an
        // entity.
        pass =
            exchange.answerRaw !== null &&
            normalizeContent(decodeXmlEntities(exchange.answerRaw)) ===
                normalizeContent(decodeXmlEntities(probe.goldAnswer));
    }
    if (pass) return { probeId: probe.id, outcome: "pass", expected, actual: exchange.answerRaw };

    // Past the gate the probe WAS measurable — the claim was injected for it, or a
    // compartment states the fact — so a wrong answer is the model's.
    return { probeId: probe.id, outcome: "fail", expected, actual: exchange.answerRaw };
}

function assembleScore(args: {
    scenarioId: string;
    facts: FactsScore;
    structuralFindings: string[];
    probeVerdicts: ProbeVerdict[];
    /**
     * Any declared historian run produced no valid output.
     *
     * ANY, not every. `recordInventoryError` proves each recorded run is either a
     * success or a validation exhaustion, so a failed run is always model behaviour
     * (KTD4) — and a two-run scenario whose first pass satisfies every gold while
     * its second exhausts validation is not a clean result. Keying this on "every
     * run failed" let exactly that report PASS, with nothing in the score naming
     * the pass that produced nothing.
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

    // A trimmed probe cannot be scored — charging an injection-budget loss to
    // the historian would violate R6 — but it outranks no other evidence at
    // all, so conversion requires that there be none.
    //
    // `failReasons` is coarse: one aggregate `"probe"` entry covers every
    // failing verdict. Allowing conversion whenever the only reason was
    // `"probe"` therefore still suppressed a genuinely failed probe whenever a
    // DIFFERENT, fully injected probe happened to be trimmed alongside it —
    // biasing exactly the probe results this rule exists to protect. Requiring
    // an empty reason set covers the probe-versus-probe case as well as
    // false-authoritative, recall, structural, and invalid-output.
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
 * Single chunk for the raw-output seam.
 *
 * The default covers the authored transcript, which is the ordinal space
 * crafted mutation inputs are written against. `range` exists because the
 * runner's real chunk is NOT in that space: harness-owned filler turns shift
 * every authored ordinal, and post-epilogue padding extends the transcript, so
 * replaying a captured `HistorianRunArtifact.rawOutput` needs the ordinals the
 * historian actually saw (`chunkStartOrdinal`/`chunkEndOrdinal` on the same
 * artifact). Validating a captured output against the authored-only space
 * rejects its compartments as outside the chunk.
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
 * Serialized bytes of one fully bootstrapped scoring database.
 * `createClaimReaderTestDatabase` composes and stamps the whole direct
 * schema, which costs two orders of magnitude more than the scoring it
 * enables; the mutation battery calls `scoreRawOutput` several times per
 * scenario and `promoteRelease` recomputes the battery per promotion.
 * Deserializing this template yields an identical, isolated, writable
 * in-memory copy per call without rebuilding the schema. Bun-only like the
 * rest of the e2e lane (see `openTestDb` in ../test-db.ts).
 */
let scoringDbTemplate: Uint8Array | null = null;

/**
 * One isolated, writable scoring database per call.
 *
 * Exported so a test can assert the connection configuration below: no caller on
 * the scoring path can observe it, so nothing else would catch its loss.
 */
export function freshScoringDatabase(): Database {
    if (scoringDbTemplate === null) {
        const template = createClaimReaderTestDatabase();
        // SAFETY: E2E executes in Bun, so the plugin Database is bun:sqlite,
        // which carries serialize/deserialize. commentlint: allow(JUDGE)
        scoringDbTemplate = (template as unknown as BunDatabase).serialize();
        template.close();
    }
    const db = BunDatabase.deserialize(scoringDbTemplate);
    // Serialization carries database BYTES, not connection state: a deserialized
    // handle opens with SQLite's defaults (foreign keys off, no busy timeout),
    // while `createClaimReaderTestDatabase` configures both. Left unset, a scorer
    // write violating a claim relationship would be accepted and scored here
    // while the factory-backed connection and production reject it — so a storage
    // regression would score green. Values match the factory.
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    return db as unknown as Database;
}

/**
 * Primary scorer entry point: raw historian output artifact →
 * parse → validate → publish into a fresh temp DB → score. Validation
 * rejection is a stage outcome the mutation battery asserts on; it never
 * appears as a live scenario verdict (live all-attempts-invalid is
 * FAIL:invalid-output via `scoreRunRecord`).
 *
 * Pass `chunkStartOrdinal`/`chunkEndOrdinal` when replaying a captured
 * artifact; see `syntheticChunk` for why the recorded ordinals are required
 * there and the authored-transcript default is not.
 *
 * `authoredStartOrdinal`/`authoredEndOrdinal` scope gold's compartment minimum
 * to the authored transcript, as `scoreRunRecord` does from the record's
 * `authoredTurnOrdinals`. A replayed runtime chunk spans harness-owned filler
 * and padding, so without them this seam would count compartments toward the
 * minimum that `scoreRunRecord` excludes — the same structural output scoring
 * differently through the two entry points. The authored-transcript default
 * needs no span because there the chunk IS the authored space.
 */
export function scoreRawOutputWithInjectedClaims(
    rawOutput: string,
    scenario: HistorianEvalScenario,
    options: RawOutputScoringOptions = {},
): RawOutputScoringRead {
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
    // Never null, because the span decides which compartments count toward gold's
    // `minCount` and a runtime chunk range covers harness filler and post-epilogue
    // padding as well as the authored transcript. Leaving it absent let an output
    // satisfy the minimum with compartments sitting entirely in padding — passing this
    // seam while the same artifact failed `scoreRunRecord`, which always supplies it.
    //
    // Required from the caller rather than derived. Where the authored content sits
    // inside a replayed chunk is not recoverable from the range: a captured artifact's
    // ordinals depend on the filler count of the run that produced it, so deriving from
    // this scenario's rendered layout would silently mis-scope a chunk captured under a
    // different one. The caller replaying a `HistorianRunArtifact` has the bounds in
    // that record's `authoredTurnOrdinals`. Same reasoning as the half-supplied range
    // above: a caller error, not a silent fallback.
    const authoredSpan = hasAuthoredSpan
        ? {
              startMessage: options.authoredStartOrdinal as number,
              endMessage: options.authoredEndOrdinal as number,
          }
        : { startMessage: chunk.startIndex, endMessage: chunk.endIndex };
    const validated = validateHistorianOutput(rawOutput, RAW_OUTPUT_SESSION_ID, chunk, [], 1);
    if (!validated.ok) {
        return { result: { stage: "validation-rejected", error: validated.error }, injectedClaims: [] };
    }

    // Stopping early is LEGAL in a valid output — `<unprocessed_from>` is how the
    // historian says it did — but a prefix that ends before the authored span cannot be
    // scored against gold written over that span. Enough early compartments and facts to
    // satisfy `minCount` and recall, with a hard negative in the unprocessed suffix,
    // produced a PASS for an artifact that was never shown the forbidden formation: the
    // absence check passed vacuously.
    //
    // Measured from how far the EMITTED compartments reach rather than from
    // `unprocessed_from`, because the two agree on what was processed and the reach is on
    // the validated result. Pre-discard, since the question is what the output covered,
    // not what production would persist. Bounded by the authored span, since filler and
    // padding carry no gold.
    // BOTH ends. Checking only the reach let a later captured chunk — one starting after
    // an early hard negative — form every later positive claim, reach the authored end, and
    // still never see the negative, so its absence passed vacuously exactly as a truncated
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
            result: {
                stage: "authored-evidence-unprocessed",
                error: `output covers ${covered}, which does not span the authored ordinals ${authoredSpan.startMessage}-${authoredSpan.endMessage}; gold and absence checks over the uncovered part would pass vacuously`,
            },
            injectedClaims: [],
        };
    }

    // Mirror production's publish gating (compartment-runner-incremental):
    // a provisional last compartment inside the healing slack is discarded
    // and unanchored promotion is skipped for the whole pass, so this seam
    // persists exactly what production would persist. Without the mirror, a
    // crafted output production would strip scores as if it published.
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
            // A fresh single-writer temp DB cannot legitimately be stale.
            throw new Error("historian-eval scorer: temp-DB claim snapshot unexpectedly stale");
        }
        const rows = persisted.map((compartment) => ({
            startMessage: compartment.startMessage,
            endMessage: compartment.endMessage,
        }));
        return {
            result: {
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
            },
            injectedClaims: visible,
        };
    } finally {
        db.close();
    }
}

export function scoreRawOutput(
    rawOutput: string,
    scenario: HistorianEvalScenario,
    options: RawOutputScoringOptions = {},
): RawOutputStageResult {
    return scoreRawOutputWithInjectedClaims(rawOutput, scenario, options).result;
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
 * Ordinal span the scenario's authored turns occupy in the rendered transcript,
 * from the record's own `authoredTurnOrdinals`, which `recordIdentityError` has
 * already validated against the scenario. Null only for a scenario with no
 * authored turns, where there is no span to scope to.
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
 * Reject a record that is not this scenario's, or whose own run inventory is
 * incomplete, before any gold is compared.
 *
 * Scoring reads gold from `scenario` and the claim surface from the record's
 * snapshot. Nothing otherwise ties the two together, so a record paired with a
 * different — or since-edited — scenario yields a plausible verdict, reported
 * under `record.scenarioId`, that measures neither. The run inventory is
 * checked for the same reason: records are copied, truncated, and hand-edited
 * after they leave the runner, where the `run-never-fired` guard can no longer
 * reach them, and a record missing a declared run would otherwise be scored
 * from whatever its retained snapshot happens to contain.
 */
/**
 * Shape of a deserialized run record, checked before anything traverses it.
 *
 * The interface is a compile-time claim about values this module constructs; a
 * record loaded from disk has had no such guarantee. A truncated artifact with
 * `historianRuns: null` satisfies the schema string and then throws inside the
 * first `.map`, aborting scoring for every remaining scenario rather than being
 * counted as one damaged artifact. Checked explicitly rather than behind a
 * blanket catch, so a genuine scorer bug still surfaces as a bug.
 */
/** A system-tuple field that actually names something: a string with non-whitespace text. */
function isIdentityValue(value: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

function recordShapeError(record: HistorianEvalRunRecord): ScenarioScore | null {
    // The root itself: deserialized JSON can be null, an array, or a primitive,
    // and every field access below would throw before reporting anything.
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
        return errorScore("<unknown>", "record-malformed", `run record is not an object: ${typeof record}`, null);
    }
    // Schema BEFORE the field requirements below, which are version-specific: a real
    // v1 or v2 record legitimately lacks `system.opencodeVersion` or
    // `system.bunVersion`, and reporting that as `record-malformed` calls a valid
    // historical artifact damaged — defeating the point of bumping the schema for
    // those very fields. Only the root-object check above precedes this, because
    // reading `.schema` needs it.
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
        // Non-empty, not merely `string`. Every one of these exists to DISTINGUISH
        // one run from another, and `""` distinguishes nothing — a record with an
        // empty version or sha would take an ordinary PASS/FAIL and then be grouped
        // by `resolveReportSystem` as comparable with runs it shares nothing with.
        // Applied to the whole tuple rather than the two version fields alone,
        // because the argument is identical for the sha and the model routes.
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
    // Nested entries too: a container check alone leaves `historianRuns: [null]`
    // to throw on the first field dereference, which is the same lane-aborting
    // failure one level down.
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
                // Checked, not tolerated as optional: the replay guard below reads
                // `factsEmitted > 0 && promotionEvidenceAdded === 0`, and an omitted
                // field makes that comparison `undefined === 0` — false — so a
                // record that simply drops the field would pass the guard vacuously.
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
                // Validated for the same reason `promotionEvidenceAdded` is: the deferred
                // claim-id leak scan reads this array, and an omitted field would make it
                // scan nothing while every other check still passed.
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
    // The schema is already proven supported by `recordShapeError`, which has to
    // classify it before applying version-specific field requirements — so every
    // check here may read fields by their current meaning.
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
    // The trigger recipe is deliberately outside `scenarioFingerprint` (pressure is
    // harness-owned and must not move a release-facing identity), which leaves it
    // bound to nothing unless the record carries it separately. It is not inert:
    // the context limit and usage decide when the historian fires, the headroom
    // margin decides where the protected tail falls, and the ballast decides what
    // the evaluated chunk contains. Without this an artifact captured under the
    // previous recipe scores clean against the revised one, and the report claims a
    // recipe that never ran.
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
    // `authoredTurnOrdinals` decides which compartments count toward gold's
    // minimum, and nothing else binds it: the fingerprint covers the scenario,
    // not the record's copy of the rendered layout. The layout is fully
    // determined by the scenario, so it is compared against the EXACT ordinals
    // the runner derives rather than a shape test — a shape test admits any
    // whole-turn offset, and shifting the span onto harness-owned filler rows is
    // precisely how a record makes filler compartments count toward gold.
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
 * Run inventory of a record that claims to have COMPLETED.
 *
 * Separate from identity because an ERROR record legitimately carries fewer
 * runs than declared — it aborted partway and keeps whatever evidence it had —
 * so this check applies only after the stored-error passthrough.
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
    // Indices alone do not prove a run evaluated the historian. The runner
    // rejects a `noop` row and a non-validation failure while it is driving the
    // scenario, but an independently stored record never passes through those
    // guards — and such a run keeps its expected index, so the check above sees
    // nothing wrong. Left unchecked, `[success, noop]` scores a normal PASS off
    // the successful run's snapshot for a declared run that never ran.
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
 * Every declared probe must have exactly one recorded exchange.
 *
 * Verdicts are built by mapping the RECORDED exchanges, so a truncated list
 * silently drops a declared hidden probe — leaving no failing verdict and a
 * scenario that PASSes without that probe ever being evaluated — and a
 * duplicated one double-weights a single answer. Comparing sorted id lists
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
 * `healingFindings` decides structural verdicts entirely from the record's
 * `discardedLast`, `emittedCompartments`, and `lookaheadMargin`, and the snapshot
 * that travels beside the record retains the authoritative rows — so trusting
 * the record means a hand-edited `discardedLast: false` with a widened margin
 * silently suppresses an unhealed-discard or forced-keep finding. The derived
 * fields are recomputed from the rows rather than compared, since that is how the
 * runner produced them.
 *
 * Row COUNT is part of the agreement: an undeclared historian pass — one that
 * fired during the probe phase, after the run inventory was assembled — leaves an
 * extra row whose compartments and claims still reach scoring.
 *
 * `lookaheadMargin` is reconstructed against the compartment prefix that existed
 * after each run, not the snapshot's final maximum. The runner records the margin
 * immediately after its own run, so in a multi-run scenario whose later run
 * persists a further compartment the final maximum yields a smaller or negative
 * value for the earlier run — rejecting a valid artifact. Compartments are only
 * ever appended, so the prefix after run i is the first `sum(persisted[0..i])`
 * rows in sequence order.
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
    // Every compartment row must belong to a recorded run. The prefix walk below
    // ignores anything past the recorded total, but structural scoring and the
    // probe-coverage gate consume every row — so an unattributed contiguous row
    // could satisfy `minCount` or cover a probe's gold range.
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
 * Public claim ids named in the LAST `<project-memory>` block of ONE captured request,
 * or `null` when it carries no complete block.
 *
 * One request, not a probe's whole window: across a re-ask the last block in the
 * concatenated text can belong to the discarded attempt, which describes nothing about
 * what the answering request carried.
 *
 * `null` and the empty set are different answers and callers must not conflate
 * them: no block means no per-turn evidence was captured (nothing injected, or a
 * block whose closing tag budget trimming removed), while an empty complete block
 * cannot occur — `renderClaimMemoryBlock` returns "" for zero items.
 *
 * Ids are read from line starts, not by substring: `renderClaimMemoryLine` emits
 * `<publicClaimId>: <content>` (with an optional ` [source]` between them), so a
 * claim whose CONTENT quotes another claim's id would otherwise be read as
 * rendering it. Anchoring on the separator also stops one id being matched inside
 * a longer one that shares its prefix.
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
 * What an aborted record's claim evidence supports.
 *
 * Three outcomes, not two, because there are three genuinely different states and
 * collapsing any pair of them is what made the previous two attempts at this
 * wrong.
 */
type AbortedClaimEvidence =
    | { kind: "scored"; falseAuthoritativeMatches: string[] }
    | { kind: "snapshot-mismatch"; detail: string };

/**
 * Claim evidence for a record that aborted, and how far it can be trusted.
 *
 * An ERROR record never reaches the snapshot-binding checks below — those run
 * only on the completion path — so on this path neither side is verified, and
 * each one alone can be edited to lie in a different direction:
 *
 * - Trusting the ARRAY lets a truncated `injectedClaims` HIDE a captured
 *   promotion.
 * - Trusting the SNAPSHOT lets the record's own unverified selectors hide it
 *   instead (`readInjectedClaims` is keyed by `projectIdentity` and `nowMs`), or
 *   lets a mispaired snapshot from another attempt of the same project INVENT a
 *   promotion this run never made.
 *
 * No additional selector guard fixes that, because the question is not whether
 * the selectors look plausible — it is whether this snapshot belongs to this run,
 * and nothing on the record answers it directly. What does answer it is the same
 * mutual agreement the completion path relies on: the runner writes
 * `injectedClaims` and the snapshot from one read at one pinned clock, so for a
 * genuine record the two claim sets are IDENTICAL — locators, contents,
 * categories, revisions, cardinality. A different attempt's snapshot, an edited
 * selector that changes the visible set, and an edited array each break that
 * equality.
 *
 * So agreement decides authority. When the sets agree the snapshot answers, and
 * the array cannot invent anything. When they disagree, this artifact is
 * self-inconsistent: it is not a report about the run at all, and guessing which
 * side was edited is how both earlier versions ended up maskable. It becomes a
 * `record-snapshot-mismatch` ERROR — exactly what the completion path returns for
 * the identical forgery — carrying the abort's own reason in the detail so
 * nothing is lost.
 *
 * A missing, unopenable, unqueryable, or stale snapshot leaves the array as the
 * only evidence there is. Scoring it is the fail-loud direction; refusing would
 * restore the masking hole this path exists to close.
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
        // The selector has to name something in THIS snapshot before its answer can
        // bind anything. `readInjectedClaims` is keyed by `record.projectIdentity`,
        // so an identity that resolves to no project returns an empty visible set —
        // and two empty sets compare equal, making a vacuous query look like
        // agreement while a forbidden claim sits in the snapshot under the real
        // project. The runner reaches exactly that shape when abort-path claim
        // capture fails and the best-effort snapshot succeeds: `emptyRecord` writes
        // `projectIdentity: ""` with `injectedClaims: []`.
        //
        // Set equality proves the snapshot belongs to this run; identity resolution
        // proves the question was asked of it at all. Neither substitutes for the
        // other, and an unresolvable identity is the same unbindable artifact as a
        // disagreement, so it reports the same way.
        if (resolveProjectIdsForIdentities(db, [record.projectIdentity]).length === 0) {
            return {
                kind: "snapshot-mismatch",
                detail:
                    "run record's project identity resolves to no project in its snapshot, " +
                    "so its claim set cannot be bound to this run",
            };
        }
        // Whole claims, locator-ordered: one comparison covers the locator set,
        // every field behind each locator, and cardinality — so a truncation, an
        // appended entry, a content or category edit, a duplicate, and a foreign
        // snapshot all surface as the same disagreement.
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
            // Counts only: the ids on either side may be unreviewed text from an
            // externally assembled artifact, which is why the surrounding checks
            // report shapes rather than values.
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
 * Score a run record produced by the replay runner. ERROR-flagged records
 * propagate their reason with no rates computed (R6). A live historian
 * whose every attempt failed validation is model behavior, not
 * infrastructure: FAIL:invalid-output (KTD4/KTD8).
 */
export function scoreRunRecord(record: HistorianEvalRunRecord, scenario: HistorianEvalScenario): ScenarioScore {
    // Shape precedes everything: every check below reads nested fields.
    const shapeError = recordShapeError(record);
    if (shapeError !== null) return shapeError;

    // Identity precedes the stored-error passthrough. An ERROR artifact under an
    // unsupported schema, or paired with a different scenario, would otherwise
    // enter the lane report under its own stale identity and reason — reported
    // as that scenario's infrastructure failure when the artifact is not that
    // scenario's at all.
    const identityError = recordIdentityError(record, scenario);
    if (identityError !== null) return identityError;

    // The stored-error passthrough is ordinary infrastructure precedence, and it
    // must not outrank an authoritative state that was already OBSERVED. The
    // runner captures claim state BEFORE the probe tier precisely so a probe
    // abort (`probe-envelope-malformed`, `probe-gold-uncovered`,
    // `probe-response-leak`, `probe-tool-use`) keeps that evidence on the
    // record; discarding it here reported the one always-run-fatal outcome as a
    // `runFatal: false` ERROR — exit 1 instead of 2 — so aborting after a
    // forbidden promotion was a way to mask it.
    //
    // Scored from the snapshot when it can be bound to this run, from the
    // record's captured claims when there is no readable snapshot at all, and
    // refused as an integrity ERROR when the two disagree — see
    // `abortedRecordClaimEvidence`. On the scored paths the abort's reason and
    // detail stay put, so the infrastructure failure is still reported rather
    // than replaced; only the verdict changes, which is what puts the scenario
    // where the always-run-fatal rule can see it. Rates stay null and the claim
    // counts zero — nothing here measures recall or precision — so the aggregate
    // is unaffected beyond the false-authoritative rate this outcome belongs in.
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

    // Snapshot storage is external run evidence and fails independently of
    // historian quality — a record copied without its SQLite file, a path that
    // moved, a truncated image. That is an infrastructure ERROR for this
    // scenario, not an exception that aborts every remaining scenario in the
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

        // Bind the record to THIS snapshot, not merely to this scenario. Facts
        // are scored from `visible` here, while probe verdicts and trimming
        // resolve against `record.injectedClaims`; pair a record with another
        // attempt's snapshot of the same scenario and both identity checks
        // above still pass while its public ids refer to rows that do not exist
        // in the database being scored.
        //
        // The test is EXISTENCE, not membership in `visible`. A claim can
        // legitimately drop out of the visible set at the read clock — expiry,
        // supersession, any soft-hidden lifecycle — while its rows are present
        // and the pairing is sound; requiring visibility would turn that into a
        // spurious mismatch. A snapshot from a different attempt has no such
        // rows at all, which is the case this separates out.
        let absent: string[];
        try {
            // Membership in the VISIBLE surface, which is the only thing that makes
            // a recorded claim evidence of injection. Existence proved a row
            // somewhere; ownership narrowed that to this project; neither excluded
            // a real but soft-hidden claim of the same project, which an edited
            // record could append with forged content and a locator that then
            // carries a probe answer.
            //
            // The runner reads `injectedClaims` from the same surface, at the same
            // pinned clock, from the database this snapshot is a copy of — so for a
            // genuine record the two sets are identical, and anything extra is an
            // addition. Ownership is still checked, so a foreign claim is named as
            // such rather than reported as merely unexpected.
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

        // The other direction: every claim visible here must appear in the
        // recorded set. Existence alone accepts omissions, and an omission is
        // not inert — a record truncated to `injectedClaims: []` scores facts
        // from the intact snapshot while exact and multiple-choice comparisons
        // never consult that array, so the lost injection evidence would PASS
        // unnoticed. Checked against `visible` rather than by row existence
        // because this direction is about what the record failed to record.
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

        // A shared locator must name the same claim in both, compared over the
        // WHOLE record rather than its public id.
        //
        // `content` and `category` are load-bearing, not decoration: probe
        // resolution runs `matchesGold` over the RECORDED claims, so editing an
        // unrelated recorded claim's content and category to match a gold claim
        // makes its public id an accepted answer for a claim-id probe. With the
        // real claim still visible, recall stays complete and precision does not
        // fail on its own, so the scenario would PASS on a forged answer.
        // A set, not a bag. The comparisons below key on locator and iterate
        // `visible`, so an APPENDED entry — reusing a real public id under a
        // fabricated locator — is examined by neither: existence passes on the
        // reused id, and the entry never appears in `visible`. That fabricated
        // locator can then enter a probe's locator set carrying gold-matching
        // content, and `compareProbeAnswer` accepts an unrelated claim id as the
        // answer. `readInjectedClaims` yields one entry per claim, so a repeat of
        // either identifier cannot come from a real run.
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

        // Telemetry cross-check before any structural verdict is derived from it.
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

        // The runner's invocation proof, reapplied — at SESSION level, which is as far as the
        // snapshot supports.
        //
        // Production stamps `validation: ` on every unsuccessful pass, including one whose
        // provider never returned output, so the reason alone cannot say whether the model was
        // shown the chunk; replay was accepting any such row as model behaviour and reporting
        // an outage-only artifact as FAIL:invalid-output.
        //
        // Per-run attribution is NOT available here, and that is a property of the artifact
        // rather than a shortcut: `historian_runs.subagent_invocation_id` is left NULL on the
        // validation-failure path, so the rows that need the evidence are exactly the rows that
        // carry no link to it. A per-run join therefore refused every genuine exhaustion — the
        // harness suite's own all-attempts-invalid run included. What the snapshot does support
        // is the session-level question: did any historian attempt fail to execute at all?
        //
        // Applied only when the record claims exhaustion, so a healthy record is unaffected,
        // and it errs toward `harness-failure`: with a failed attempt present, the artifact
        // cannot separate "the model emitted garbage" from "an attempt never ran", and charging
        // that to the model is the attribution R6 forbids.
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

        // FAIL:invalid-output is a claim about model behavior, so it is made only
        // after the persisted evidence backs it. Classifying first meant a deleted
        // snapshot, or a copied record whose statuses were edited to validation
        // failures, was charged to historian quality instead of surfacing as an
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

        // After the all-invalid branch: nothing was published there, so the runner
        // records no probe exchanges by design.
        const coverageError = probeCoverageError(record, scenario);
        if (coverageError !== null) return coverageError;

        // The runner's authored-chunk-coverage proof, reapplied to a stored artifact. The
        // live gate rejects a token-capped run before it writes a completed record, but a
        // record scored independently never passes through it — and a stored record whose
        // successful chunks stop before a hard-negative suffix passes facts and the early
        // probes while the absence check passes vacuously. The ranges are snapshot-bound by
        // the telemetry cross-check above, and the ordinals by `recordIdentityError`, so
        // both inputs are already proven.
        const preEpilogue = record.authoredTurnOrdinals.slice(0, scenario.transcript.epilogueStartIndex);
        if (preEpilogue.length > 0) {
            const required: [number, number] = [
                preEpilogue[0][0],
                Math.max(...preEpilogue.map(([, assistant]) => assistant)),
            ];
            // What the runs EXPOSED, not their chunk bounds: a successful output that stopped
            // early read less than it was handed. A validation-exhausted run still saw its
            // whole chunk, so it counts in full — see `exposedRanges`.
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

        // The runner's promotion-plumbing guard, reapplied to a stored artifact.
        // A run that emitted facts, kept its tail, and added no claim or evidence
        // lost the promotion in plumbing — the fact never reached the store — so
        // its missing claim is not a historian recall miss. The live guard aborts
        // that attempt, but a record scored independently never passes through it,
        // and without this the same artifact reports FAIL:recall and charges the
        // loss to the model.
        //
        // Per run, not scenario-wide: run 1 promoting successfully leaves the total
        // non-zero, so run 2's silently skipped promotion would pass a summed
        // check. Ordered after the telemetry cross-check so `factsEmitted` and
        // `discardedLast` are already snapshot-bound; `promotionEvidenceAdded` is a
        // live-database delta with no per-run row to compare against, which is why
        // the aggregate check below binds the claim to the snapshot.
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
        // The other half of the runner's guard, and the part that is snapshot-backed:
        // facts were emitted, so the snapshot must hold promotion evidence under the
        // record's own project identity. This is what stops the check above from
        // being defeated by editing `promotionEvidenceAdded` to a non-zero lie —
        // a record claiming promotions its snapshot never received is refused
        // regardless of the per-run numbers. Scoped to the identity the record
        // declares, matching the runner: claims promoted under a different one leave
        // the authoritative read empty while satisfying a global count.
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

        // Per-probe locator sets must name claims the record actually recorded as
        // injected. Editing one converts a genuine wrong answer into
        // `error-trimmed` — excluding it from scored metrics — or admits a
        // claim-id answer for a claim that was never injected. This bounds the
        // set to real, snapshot-backed claims.
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

        // Membership in the recorded set is necessary but not sufficient: it bounds
        // the locator set from above and says nothing about what THIS probe's turn
        // actually carried, so removing a locator whose claim was injected still
        // passes. That removal is not inert — `compareProbeAnswer` reads the gold
        // claim as promoted-but-not-injected and returns `error-trimmed`, which
        // `assembleScore` converts into an infrastructure ERROR, taking a genuine
        // wrong answer out of scored metrics.
        //
        // The probe turn's own captured request is the per-turn evidence. The
        // plugin writes `session_meta.memory_block_ids` from exactly the claims it
        // rendered into `<project-memory>` for that request, so a claim named in the
        // block was injected on that turn by construction, and its locator must be
        // in the recorded set. Read from the LAST block in the payload, which is the
        // request `visibleRevisionLocators` was sampled after — a re-asked probe
        // captures two requests, and an earlier one's block may predate a trim.
        //
        // One-directional deliberately. The converse — every recorded locator must
        // be named in the block — has legitimate counter-examples: the plugin skips
        // the `memory_block_ids` update when the claim lane is unstable, leaving the
        // previous turn's locators recorded with no block rendered, and a block whose
        // closing tag was lost to budget trimming is not matched here at all. Both
        // would become spurious ERRORs.
        for (const exchange of record.probes) {
            // The FINAL request, like the locator set it is checked against. Reading the
            // concatenated window found the last block in COMBINED text, which on a re-ask is
            // the discarded first attempt's whenever the retry withheld its own — so a
            // genuine record whose locators correctly describe only the retry was rejected as
            // a mismatch. "Last block in the payload" is the final request's block only when
            // the final request rendered one, which is exactly what cannot be assumed here.
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
            // And the converse, which a COMPLETE block makes assertable. The reasons this
            // check was one-directional — the plugin skipping the `memory_block_ids` update
            // with no block rendered, and a block whose closing tag budget trimming removed —
            // are both "no complete block", and neither survives here: a well-formed block was
            // captured for the request that produced the answer, and it names every claim that
            // request carried. A locator beyond it is an over-claim, and not inert —
            // `compareProbeAnswer` would accept that claim's public id for a claim-id probe,
            // or read its gold as injected and suppress `error-trimmed` for a guess.
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

        // The runner's leakage precondition, re-applied to a stored artifact: a
        // probe whose gold source range is not compartment-covered cannot have had
        // its raw history removed by the splice, so its answer proves nothing.
        // `minCount` being satisfied elsewhere in the transcript does not imply
        // this probe's own range was covered, and a stored record never passes
        // through the live gate.
        const compartmentRanges = rows.map((row) => ({ start: row.startMessage, end: row.endMessage }));
        // A gap an unhealed DISCARD explains is NOT infrastructure: the range is
        // uncovered precisely because a run dropped the compartment that covered
        // it, which `healingFindings` classifies as a structural model FAIL, and
        // ERRORing here would move that verdict out of scored metrics.
        //
        // Scoped to the discard class only. A run that KEPT a provisional boundary
        // persisted it, so its range is covered and it explains no gap — treating
        // that finding as an excuse would let a genuinely uncovered range be scored
        // as probe and structural FAILs instead of the ERROR this gate exists to
        // produce.
        //
        // Known limitation: this stand-down is not reachable from a live attempt.
        // `driveProbe` applies the same coverage check against the live database
        // before the probe is asked, so a run whose gold range the discard left
        // uncovered aborts as `ERROR:probe-gold-uncovered`, and the stored-error
        // passthrough above returns that reason before `healingFindings` is
        // consulted. Standing the live gate down does not reach here either: an
        // uncovered range is precisely a range the injection splice did NOT remove,
        // so its raw text survives in the probe payload and the leak gate below
        // aborts with `gold-range-leak` instead — a different reason for the same
        // physical run, with the structural verdict still out of scored metrics.
        // Recovering it needs the probe tier to record a per-probe unmeasurable
        // outcome rather than abort the whole attempt, so structural and facts
        // scoring survive a probe precondition failure. Until then this branch
        // guards only records whose payload no longer carries the raw range.
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

        // The runner's leak gate, reapplied to the recorded payload. A stored
        // record never passes through the live check, so a copied or older
        // artifact whose captured request still holds raw gold text would score
        // from that leaked answer as long as the snapshot has coverage.
        const scriptedProbes = record.system.probeModelId === "scripted-mock";
        for (const probe of scenario.probes) {
            const exchange = record.probes.find((entry) => entry.probeId === probe.id);
            if (exchange === undefined) continue;
            if (exchange.payloadText === null) {
                // Scripted runs capture the payload; live runs cannot, and that
                // limitation is the live-mode gap recorded in the runner.
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

        // The recorded answer must be reproducible from the recorded response.
        // Without this, `answerRaw` is an unfalsifiable derivation and editing it
        // to the gold value turns a probe FAIL into a PASS.
        for (const exchange of record.probes) {
            if (exchange.responseText === null) {
                // Required in BOTH modes, unlike the captured payload. `askProbe`
                // records this for every route and extracts `answerRaw` from it,
                // and two unextractable replies abort the run — so a completed
                // exchange cannot legitimately lack it, and exempting live records
                // would leave `answerRaw` unfalsifiable exactly where the payload
                // gate is already absent.
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
            // The runner's response-leak gate, reapplied to the recorded reply.
            // Commentary outside the envelope stays raw in the shared session, so a
            // reply that volunteers a later probe's answer hands it over — and a
            // stored record never passes through the live gate, so a copied or older
            // artifact would score that later probe's PASS from the leak.
            //
            // Indexed by the SCENARIO's probe order, not the record's array order:
            // the runner asks in scenario order, and that order is what decides
            // which probes could still read this reply.
            const probeIndex = scenario.probes.findIndex((probe) => probe.id === exchange.probeId);
            if (probeIndex !== -1) {
                // Every reply the probe sent, matching the runner. It scans each attempt
                // as it happens; the record keeps the survivor in `responseText` and the
                // rejected ones in `discardedResponseTexts`, and a discarded reply was
                // still sent — so replaying only the survivor left a stored record whose
                // malformed first reply carried a later probe's gold scoring clean.
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

        // The claim-id half of the response-leak gate, replayed with the same function
        // the runner defers to — acceptance is per-probe, so it needs every exchange's
        // injected locator set alongside the recorded claims.
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
            // The all-failed branch above returned early because nothing was
            // published there and facts and probes are meaningless. A PARTIAL failure
            // still publishes, so its facts and probes are scored — but the run that
            // exhausted validation is model evidence all the same, and reporting only
            // the all-failed case left a two-run scenario free to PASS on one good
            // pass while the other produced nothing.
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
        /** Micro-averaged over scored scenarios; ERRORs excluded (R6). */
        precision: number | null;
        recall: number | null;
        /** Top-level figure, reported separately from precision/recall (R8). */
        falseAuthoritativeRate: number | null;
    };
    /** Frozen-release run verdict (KTD8): red iff any scenario FAIL or any ERROR. */
    red: boolean;
    /** False-authoritative FAIL is always run-fatal (R8/KTD8). */
    runFatal: boolean;
}

/**
 * The one system every scored record agrees on, or a thrown mismatch.
 *
 * A report is a claim about one system; scores from different commits or model
 * pairs combined into it produce plausible aggregates that describe no run that
 * ever happened. The caller's `options.system` is a label, so it is checked
 * against the evidence rather than believed. Scores with no run record behind
 * them (the raw-output seam) carry no system and constrain nothing.
 */
function resolveReportSystem(
    scores: readonly ScenarioScore[],
    supplied: SystemVersionTuple | undefined,
): SystemVersionTuple | null {
    // Key-order-independent: `score.system` is deserialized from a run-record
    // JSON while a supplied tuple is a caller literal, so the two never share a
    // construction site and `JSON.stringify` would compare their insertion
    // orders as well as their values — failing a run that is in fact
    // consistent. `canonicalJson` sorts keys, and is the same canonicalizer the
    // scenario fingerprint is built on.
    const canonical = (system: SystemVersionTuple): string => canonicalJson(system);
    let agreed: SystemVersionTuple | null = null;
    for (const score of scores) {
        if (score.source === "raw-output") {
            // No probe tier ran, so an empty `probeVerdicts` would let a scenario
            // declaring hidden probes PASS. A lane report is a statement about
            // executed runs, so the mutation battery's scores are refused rather
            // than silently averaged in. Keyed on the source, not on a null
            // system: an artifact-integrity ERROR has no trustworthy system either
            // and must still be reportable.
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
    // A report over no scenarios is a broken invocation — failed discovery,
    // artifact loading, or over-filtering — not a green run. `some` is false on
    // an empty list, so it would otherwise be non-red and exit 0 having
    // evaluated nothing.
    if (scores.length === 0) {
        throw new Error("historian-eval report: no scenario scores; an empty lane report cannot be green");
    }
    const system = resolveReportSystem(scores, options.system);
    // One result per frozen scenario. A duplicate — an original plus a retry of
    // the same scenario, say — is weighted twice in every micro-averaged rate
    // and every failure count, so the report would describe a corpus that does
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
 * Placeholder for a scenario the lane has not finished yet.
 *
 * Seeded for every scenario before the first one is attempted, and replaced in
 * place as each completes, so an incremental report always describes the WHOLE
 * corpus rather than the prefix that happened to finish. Two things follow from
 * that. A report killed mid-run cannot be mistaken for a complete result over a
 * smaller corpus — the aggregate is micro-averaged, so a prefix-only report would
 * publish rates for scenarios nobody selected. And a run terminated during its
 * very first scenario still leaves evidence, which "write after each scenario"
 * alone does not provide: nothing had completed, so nothing had been written,
 * while the tokens were already spent.
 *
 * An ERROR verdict, so an unfinished run is never green.
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
 * Score for a scenario the lane never got to because its wall-clock budget ran
 * out.
 *
 * An ERROR, not a silent omission: `buildLaneReport` micro-averages over the
 * scenarios it is given, so dropping the unreached ones would publish rates for a
 * corpus subset while claiming the release, and `red` would be false if the ones
 * that did run all passed. Constructed here rather than in the caller so the
 * score shape stays owned by the scorer.
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
 * Frozen-release run exit mapping (KTD8): red iff any scenario FAIL or any
 * ERROR; a false-authoritative FAIL is always run-fatal. Exit codes: 0 green,
 * 1 red, 2 run-fatal (false-authoritative).
 */
export function laneExitCode(report: LaneReport): number {
    if (report.runFatal) return 2;
    return report.red ? 1 : 0;
}
