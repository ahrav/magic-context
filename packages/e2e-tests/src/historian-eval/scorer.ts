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
import { createClaimReaderTestDatabase } from "../../../plugin/src/features/magic-context/test-claim-database";
import { canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { openTestDb } from "../test-db";
import {
    matchesGold,
    normalizeContent,
    predicateMatches,
    scenarioFingerprint,
    type ExpectedClaim,
    type HistorianEvalScenario,
    type Probe,
} from "./contract";
import { readInjectedClaims } from "./claim-read";
import { verifyAllActiveClaims } from "./verification-bridge";
import { RUN_RECORD_SCHEMA } from "./runner";
import type {
    HistorianEvalRunRecord,
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
     * System identity of the run this score came from, or null when the score
     * has no run record behind it (the raw-output seam). Retained so
     * `buildLaneReport` can prove one report describes one system rather than
     * trusting the label its caller passes (KD4/KTD7).
     */
    system: SystemVersionTuple | null;
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
function healingFindings(record: HistorianEvalRunRecord): string[] {
    const runs = record.historianRuns;
    const finalRun = runs[runs.length - 1];
    if (!finalRun) return [];
    const findings: string[] = [];
    for (const [index, run] of runs.entries()) {
        if (!run.discardedLast) continue;
        if (runs.slice(index + 1).some((later) => later.status === "success")) continue;
        findings.push(
            `healing: run ${run.runIndex} discarded its provisional last compartment and no later successful run healed it`,
        );
    }
    if (
        !finalRun.discardedLast &&
        finalRun.emittedCompartments >= 2 &&
        finalRun.lookaheadMargin !== null &&
        finalRun.lookaheadMargin <= HISTORIAN_BOUNDARY_HEALING_SLACK
    ) {
        findings.push(
            `healing: final run kept a provisional boundary (lookahead margin ${finalRun.lookaheadMargin} <= slack ${HISTORIAN_BOUNDARY_HEALING_SLACK})`,
        );
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
            return { probeId: probe.id, outcome: "error-trimmed", expected, actual: exchange.answerRaw };
        }
    }
    return { probeId: probe.id, outcome: "fail", expected, actual: exchange.answerRaw };
}

function assembleScore(args: {
    scenarioId: string;
    facts: FactsScore;
    structuralFindings: string[];
    probeVerdicts: ProbeVerdict[];
    allAttemptsInvalid: boolean;
    system: SystemVersionTuple | null;
}): ScenarioScore {
    const { scenarioId, facts, structuralFindings, probeVerdicts, allAttemptsInvalid, system } = args;
    const failReasons = new Set<FailReason>();
    if (allAttemptsInvalid) failReasons.add("invalid-output");
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
 */
export function scoreRawOutput(
    rawOutput: string,
    scenario: HistorianEvalScenario,
    options: { nowMs?: number; chunkStartOrdinal?: number; chunkEndOrdinal?: number } = {},
): RawOutputStageResult {
    const nowMs = options.nowMs ?? Date.now();
    const hasRange = options.chunkStartOrdinal !== undefined || options.chunkEndOrdinal !== undefined;
    if (hasRange && (options.chunkStartOrdinal === undefined || options.chunkEndOrdinal === undefined)) {
        throw new Error("historian-eval scorer: chunkStartOrdinal and chunkEndOrdinal must be supplied together");
    }
    const chunk = syntheticChunk(
        scenario,
        hasRange
            ? { startOrdinal: options.chunkStartOrdinal as number, endOrdinal: options.chunkEndOrdinal as number }
            : null,
    );
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
                ),
                probeVerdicts: [],
                allAttemptsInvalid: false,
                system: null,
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
    };
}

/**
 * Ordinal span the scenario's authored turns occupy in the rendered transcript,
 * from the record's own `authoredTurnOrdinals`. Null when the record carries
 * none, which leaves the count unscoped rather than silently empty.
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
    if (record.expectedHistorianRuns !== scenario.trigger.expectedHistorianRuns) {
        return errorScore(
            record.scenarioId,
            "record-scenario-mismatch",
            `run record declares ${record.expectedHistorianRuns} historian run(s); scenario declares ${scenario.trigger.expectedHistorianRuns}`,
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
 * Score a run record produced by the replay runner. ERROR-flagged records
 * propagate their reason with no rates computed (R6). A live historian
 * whose every attempt failed validation is model behavior, not
 * infrastructure: FAIL:invalid-output (KTD4/KTD8).
 */
export function scoreRunRecord(record: HistorianEvalRunRecord, scenario: HistorianEvalScenario): ScenarioScore {
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
            allAttemptsInvalid: true,
            system: record.system,
        });
    }

    // Checked after the all-invalid branch: nothing was published there, so the
    // runner records no probe exchanges by design.
    const coverageError = probeCoverageError(record, scenario);
    if (coverageError !== null) return coverageError;

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
            absent = record.injectedClaims
                .filter((claim) => getProjectMemoryClaimByPublicId(db, claim.publicClaimId) === null)
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
                `run record names ${absent.length} injected claim(s) with no row in its snapshot: [${absent.slice(0, 5).join(", ")}]`,
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
                ...healingFindings(record),
            ],
            probeVerdicts,
            allAttemptsInvalid: false,
            system: record.system,
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
