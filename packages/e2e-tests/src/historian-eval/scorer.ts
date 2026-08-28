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
import { appendCompartments } from "../../../plugin/src/features/magic-context/compartment-storage";
import { promoteSessionFactsDurable } from "../../../plugin/src/features/magic-context/memory/promotion";
import { getProjectMemoryClaimByPublicId } from "../../../plugin/src/features/magic-context/memory/storage-claim-operations";
import { resolveProjectIdsForIdentities } from "../../../plugin/src/features/magic-context/memory/storage-claim-current-state";
import { createClaimReaderTestDatabase } from "../../../plugin/src/features/magic-context/test-claim-database";
import { canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { openTestDb } from "../test-db";
import {
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

const LANE_REPORT_SCHEMA = "historian-eval-report/v1";

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
    const matchedExpected = expected.filter((claim) => visible.some((item) => matchesGold(claim, item)));
    const matchedVisible = visible.filter((item) => expected.some((claim) => matchesGold(claim, item)));
    const falseAuthoritativeMatches = scenario.gold.expectedAbsent
        .filter((absent) => visible.some((item) => predicateMatches(absent.predicate, item.content)))
        .map((absent) => absent.id)
        .sort();
    return {
        precision: visible.length === 0 ? null : matchedVisible.length / visible.length,
        recall: expected.length === 0 ? null : matchedExpected.length / expected.length,
        expectedClaimsMatched: matchedExpected.length,
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
 * Boundary-healing evidence (R9/KTD3), scored from recorded per-run numbers.
 *
 * A discarded provisional compartment is healed only by a LATER SUCCESSFUL run
 * re-deriving the dropped range, so every run is inspected rather than the last
 * row alone: run 1 discarding and run 2 then failing validation leaves the
 * dropped range's facts never re-derived while the final row itself reports no
 * discard, and the record is not all-attempts-invalid either. A kept
 * multi-compartment boundary whose lookahead margin is inside the healing slack
 * means the forced-keep escape hatch (forbidden for facts-scored scenarios) or
 * equivalent skipped healing.
 */
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
        pass =
            exchange.answerRaw !== null && normalizeContent(exchange.answerRaw) === normalizeContent(probe.goldAnswer);
    }
    if (pass) return { probeId: probe.id, outcome: "pass", expected, actual: exchange.answerRaw };

    // Trimmed-by-injection-budget (KTD6): the gold claim exists among the
    // injection-eligible claims but was not in the probe turn's injected set.
    if (goldClaim !== null) {
        const promoted = claimsMatchingGold(goldClaim, injectedClaims);
        if (promoted.length > 0 && promoted.every((item) => !injectedLocators.has(item.revisionLocator))) {
            // The claim surface is not the only surface the probe may use. The prompt
            // says "project memory AND session history", and the injection splices
            // compartment-derived blocks alongside `<project-memory>` — so a gold fact
            // the claim budget dropped can still be stated in a compartment summary the
            // probe read. Calling that `error-trimmed` takes an ANSWERABLE model miss
            // out of scored metrics.
            //
            // Searched in the compartment blocks only, not the whole payload. A
            // predicate like "4096" can appear incidentally in prompt text, ordinals,
            // or filler, and a false "answerable" here converts an infrastructure
            // ERROR into a model FAIL — the R6 violation in reverse. Historian-authored
            // summary text is the surface whose match actually means the fact was
            // available.
            //
            // A payload-less exchange keeps `error-trimmed`: live routes cannot capture
            // the request, so there is no evidence the fact was reachable, and assuming
            // it was would charge the model on an absence of proof. That is the same
            // live-mode capture gap the replayed leak gate already carries.
            //
            // A claim-id probe keeps it unconditionally. Its answer is the runtime
            // public claim id, which `renderClaimMemoryLine` emits into
            // `<project-memory>` and nowhere else — compartment summaries are
            // historian-authored prose about the transcript and cannot contain an id
            // the store assigned at promotion time. So a summary stating the fact does
            // not make the id recoverable: `injectedMatching` is still empty, `expected`
            // is still `<no injected gold claim>`, and falling through would charge the
            // model for a probe that had no answer available.
            const answerableFromCompartments =
                probe.answerType !== "claim-id" &&
                exchange.payloadText !== null &&
                predicateMatches(
                    goldClaim.predicate,
                    injectedBlockContents(exchange.payloadText, COMPARTMENT_BLOCK_TAGS),
                );
            if (!answerableFromCompartments) {
                return { probeId: probe.id, outcome: "error-trimmed", expected, actual: exchange.answerRaw };
            }
        }
    }
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
 * Primary scorer entry point (KTD5): raw historian output artifact →
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
    const authoredSpan = hasAuthoredSpan
        ? {
              startMessage: options.authoredStartOrdinal as number,
              endMessage: options.authoredEndOrdinal as number,
          }
        : hasRange
          ? null
          : { startMessage: chunk.startIndex, endMessage: chunk.endIndex };
    const validated = validateHistorianOutput(rawOutput, RAW_OUTPUT_SESSION_ID, chunk, [], 1);
    if (!validated.ok) {
        return { stage: "validation-rejected", error: validated.error };
    }

    // Mirror production's publish gating (compartment-runner-incremental):
    // a provisional last compartment inside the healing slack is discarded
    // and unanchored promotion is skipped for the whole pass, so this seam
    // persists exactly what production would persist. Without the mirror, a
    // crafted output production would strip scores as if it published.
    const discardLast = shouldDiscardLastHistorianCompartment(validated.compartments, chunk);
    const persisted = discardLast ? validated.compartments.slice(0, -1) : validated.compartments;

    const db = createClaimReaderTestDatabase();
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
function recordShapeError(record: HistorianEvalRunRecord): ScenarioScore | null {
    // The root itself: deserialized JSON can be null, an array, or a primitive,
    // and every field access below would throw before reporting anything.
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
        return errorScore("<unknown>", "record-malformed", `run record is not an object: ${typeof record}`, null);
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
        typeof record.system.repoCommitSha !== "string" ||
        typeof record.system.historianModelId !== "string" ||
        typeof record.system.probeModelId !== "string" ||
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
                (exchange.responseText === null || typeof exchange.responseText === "string") &&
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
    // Version first: every check below reads fields by v1 meaning, so an
    // artifact written under a different schema must be refused rather than
    // reinterpreted. Otherwise a persisted record whose fields merely still
    // parse receives an ordinary PASS or FAIL under semantics it never had,
    // which defeats the point of versioning the record at all.
    if (record.schema !== RUN_RECORD_SCHEMA) {
        return errorScore(
            record.scenarioId,
            "record-schema-unsupported",
            `run record schema ${JSON.stringify(record.schema)} is not ${RUN_RECORD_SCHEMA}`,
            record.system,
        );
    }
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
 * Accepted runtime answers for each claim-id probe, resolved from the recorded
 * injected set through the same `matchesGold` rule `compareProbeAnswer` uses.
 *
 * The replay half of the runtime resolution: an earlier probe's prose can name a
 * later claim-id probe's answer, and that answer is a runtime id with no authored
 * value to compare against, so it has to be resolved before the leak scan can look
 * for it. Resolved from `record.injectedClaims` because that is what
 * `compareProbeAnswer` accepts as the answer, so the scan looks for exactly the ids
 * a PASS could be built from.
 */
function claimIdAnswersFor(
    scenario: HistorianEvalScenario,
    injectedClaims: readonly InjectedClaimRecord[],
): ReadonlyMap<string, readonly string[]> {
    const answers = new Map<string, readonly string[]>();
    for (const probe of scenario.probes) {
        if (probe.answerType !== "claim-id") continue;
        const goldClaim = scenario.gold.expectedClaims.find((claim) => claim.id === probe.expectedClaimRef);
        if (goldClaim === undefined) continue;
        answers.set(probe.id, claimsMatchingGold(goldClaim, injectedClaims).map((item) => item.publicClaimId));
    }
    return answers;
}

/**
 * Public claim ids named in the LAST `<project-memory>` block of a captured probe
 * payload, or `null` when the payload carries no complete block.
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

    if (record.error !== null) {
        return errorScore(record.scenarioId, record.error.reason, record.error.detail, record.system);
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
        }>;
        let compartmentEndsInSequence: number[];
        try {
            runRows = db
                .prepare(
                    `SELECT status, failure_reason AS failureReason, chunk_start_ordinal AS chunkStartOrdinal,
                            chunk_end_ordinal AS chunkEndOrdinal, compartments_produced AS compartmentsProduced,
                            facts_emitted AS factsEmitted, discarded_last AS discardedLast
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
            if (exchange.payloadText === null) continue;
            const rendered = renderedClaimIdsInLastMemoryBlock(exchange.payloadText);
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
                const responseLeak = probeResponseLeak({
                    probes: scenario.probes,
                    probeIndex,
                    responseText: exchange.responseText,
                    claimIdAnswers: claimIdAnswersFor(scenario, record.injectedClaims),
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
 * Frozen-release run exit mapping (KTD8): red iff any scenario FAIL or any
 * ERROR; a false-authoritative FAIL is always run-fatal. Exit codes: 0 green,
 * 1 red, 2 run-fatal (false-authoritative).
 */
export function laneExitCode(report: LaneReport): number {
    if (report.runFatal) return 2;
    return report.red ? 1 : 0;
}
