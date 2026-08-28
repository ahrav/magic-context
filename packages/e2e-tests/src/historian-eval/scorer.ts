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

import { resolve } from "node:path";
import {
    HISTORIAN_BOUNDARY_HEALING_SLACK,
    validateHistorianOutput,
    validateStoredCompartments,
    type HistorianValidationChunk,
} from "../../../plugin/src/hooks/magic-context/compartment-runner-validation";
import { appendCompartments } from "../../../plugin/src/features/magic-context/compartment-storage";
import { readAuthorizedClaimMemorySnapshot } from "../../../plugin/src/features/magic-context/memory/claim-memory-render";
import { promoteSessionFactsDurable } from "../../../plugin/src/features/magic-context/memory/promotion";
import { createClaimReaderTestDatabase } from "../../../plugin/src/features/magic-context/test-claim-database";
import type { Database } from "../../../plugin/src/shared/sqlite";
import { openTestDb } from "../test-db";
import {
    RUN_RECORD_SCHEMA,
    laneWorkspaceEpoch,
    normalizeContent,
    predicateMatches,
    scenarioFingerprint,
    type ExpectedClaim,
    type HistorianEvalScenario,
    type Probe,
} from "./contract";
import { verifyAllActiveClaims } from "./verification-bridge";
import type {
    HistorianEvalRunRecord,
    HistorianRunArtifact,
    InjectedClaimRecord,
    ProbeExchange,
    SystemVersionTuple,
} from "./runner";

const LANE_REPORT_SCHEMA = "historian-eval-report/v1";

/**
 * Production `historian_runs.failure_reason` values that mean "the model's
 * output was rejected by the validator", and nothing else. Production writes
 * the same `failed` status for chunk-coverage rejections, no-forward-progress,
 * stale snapshots, drain-quota exhaustion, empty chunks, and publish
 * exceptions — charging any of those to historian quality would violate R6,
 * so only a reason led by the `validation` word may become
 * FAIL:invalid-output. Matched on the leading word rather than an exact
 * prefix so the classification does not hinge on the punctuation of a string
 * built in another package.
 */
const VALIDATION_FAILURE_RE = /^(?:existing-)?validation\b/i;

export type TerminalRunClassification =
    | { kind: "not-terminal" }
    | { kind: "validation-exhausted" }
    | { kind: "infrastructure"; detail: string };

/**
 * Classify a run set in which the historian produced nothing usable.
 *
 * Every attempt failing is only a *quality* verdict when every failure was a
 * validation rejection; an API, runtime, or storage fault that lands as
 * `failed` is infrastructure and must be excluded from the rates. An
 * unrecognized reason is treated as infrastructure on purpose: a loud ERROR
 * that excludes one scenario is recoverable, while silently booking an outage
 * as model failure corrupts the longitudinal quality numbers this lane exists
 * to produce — so if production grows a new terminal reason, this fails safe.
 */
export function classifyTerminalRuns(runs: readonly HistorianRunArtifact[]): TerminalRunClassification {
    if (runs.length === 0 || !runs.every((run) => run.status === "failed")) return { kind: "not-terminal" };
    const nonValidation = runs.filter((run) => !VALIDATION_FAILURE_RE.test(run.failureReason?.trim() ?? ""));
    if (nonValidation.length === 0) return { kind: "validation-exhausted" };
    return {
        kind: "infrastructure",
        detail: nonValidation
            .map((run) => `run ${run.runIndex}: ${run.failureReason ?? "<no failure reason recorded>"}`)
            .join("; "),
    };
}

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
}

export type RawOutputStageResult =
    | { stage: "validation-rejected"; error: string }
    | { stage: "scored"; score: ScenarioScore };

interface VisibleClaim {
    publicClaimId: string;
    revisionLocator: string;
    content: string;
    category: string;
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

/**
 * Facts precision/recall against gold, keyed by category + content
 * predicate (R7), plus the separately-reported false-authoritative check
 * (R8). Operates on the injection-visible claim set only: soft-hidden
 * (stale/disputed/superseded) claims never reach this list, which is what
 * makes R3's supersession rule checkable at the scored surface.
 */
function scoreFacts(scenario: HistorianEvalScenario, visible: readonly VisibleClaim[]): FactsScore {
    const expected = scenario.gold.expectedClaims;
    const matchedExpected = expected.filter((claim) =>
        visible.some((item) => item.category === claim.category && predicateMatches(claim.predicate, item.content)),
    );
    const matchedVisible = visible.filter((item) =>
        expected.some((claim) => item.category === claim.category && predicateMatches(claim.predicate, item.content)),
    );
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

function readVisibleClaims(db: Database, projectIdentity: string, epoch: string, nowMs: number): VisibleClaim[] | null {
    const snapshot = readAuthorizedClaimMemorySnapshot(db, {
        authorizedIdentities: [projectIdentity],
        ownIdentities: [projectIdentity],
        sharedCategories: [],
        workspaceEpoch: epoch,
        nowMs,
    });
    if (snapshot === null) return null;
    return snapshot.items.map((item) => ({
        publicClaimId: item.publicClaimId,
        revisionLocator: item.revisionLocator,
        content: item.content,
        category: item.category,
    }));
}

function structuralFindingsFromRows(
    rows: Array<{ startMessage: number; endMessage: number }>,
    minCount: number,
): string[] {
    const findings: string[] = [];
    // Production-precondition self-check (R9): the same invariant production
    // enforces before publishing — ordinals strictly increasing, ranges
    // non-overlapping, coverage contiguous.
    const storedError = validateStoredCompartments(rows);
    if (storedError !== null) findings.push(`stored-compartments: ${storedError}`);
    if (rows.length < minCount) {
        findings.push(`compartment-count: ${rows.length} persisted, gold requires at least ${minCount}`);
    }
    return findings;
}

/**
 * Boundary-healing evidence (R9/KTD3), scored from recorded per-run numbers.
 * A discarded provisional compartment on the FINAL run means the dropped
 * range's facts were never re-derived; a kept multi-compartment boundary
 * whose lookahead margin is inside the healing slack means the forced-keep
 * escape hatch (forbidden for facts-scored scenarios) or equivalent skipped
 * healing.
 */
function healingFindings(record: HistorianEvalRunRecord): string[] {
    const finalRun = record.historianRuns[record.historianRuns.length - 1];
    if (!finalRun) return [];
    const findings: string[] = [];
    if (finalRun.discardedLast) {
        findings.push("healing: final run discarded its provisional last compartment and no later run healed it");
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
    return items.filter(
        (item) => item.category === claim.category && predicateMatches(claim.predicate, item.content),
    );
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
}): ScenarioScore {
    const { scenarioId, facts, structuralFindings, probeVerdicts, allAttemptsInvalid } = args;
    const failReasons = new Set<FailReason>();
    if (allAttemptsInvalid) failReasons.add("invalid-output");
    if (facts.falseAuthoritativeMatches.length > 0) failReasons.add("false-authoritative");
    if (facts.recall !== null && facts.recall < 1) failReasons.add("recall");
    if (structuralFindings.length > 0) failReasons.add("structural");
    if (probeVerdicts.some((verdict) => verdict.outcome === "fail")) failReasons.add("probe");

    // Trimmed-by-injection-budget outranks probe-derived FAILs — charging an
    // injection-budget loss to the historian would violate R6 — but never a
    // false-authoritative match: that evidence comes from the facts read,
    // independent of any probe, and is always run-fatal (R8/KTD8).
    const trimmed = probeVerdicts.find((verdict) => verdict.outcome === "error-trimmed");
    if (trimmed !== undefined && !failReasons.has("false-authoritative")) {
        return {
            ...errorScore(
                scenarioId,
                "trimmed-by-injection-budget",
                `probe ${trimmed.probeId}: gold claim promoted but absent from the injected set`,
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
    };
}

/** Synthetic single chunk covering the whole authored transcript. */
function syntheticChunk(scenario: HistorianEvalScenario): HistorianValidationChunk {
    const messageCount = scenario.transcript.turns.length * 2;
    return {
        startIndex: 1,
        endIndex: messageCount,
        lines: Array.from({ length: messageCount }, (_, index) => ({
            ordinal: index + 1,
            messageId: `msg-${index + 1}`,
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
 */
export function scoreRawOutput(
    rawOutput: string,
    scenario: HistorianEvalScenario,
    options: { nowMs?: number } = {},
): RawOutputStageResult {
    const nowMs = options.nowMs ?? Date.now();
    const validated = validateHistorianOutput(rawOutput, RAW_OUTPUT_SESSION_ID, syntheticChunk(scenario), [], 1);
    if (!validated.ok) {
        return { stage: "validation-rejected", error: validated.error };
    }

    const db = createClaimReaderTestDatabase();
    try {
        appendCompartments(
            db,
            RAW_OUTPUT_SESSION_ID,
            validated.compartments.map((compartment) => ({
                sequence: compartment.sequence,
                startMessage: compartment.startMessage,
                endMessage: compartment.endMessage,
                startMessageId: compartment.startMessageId,
                endMessageId: compartment.endMessageId,
                title: compartment.title,
                content: compartment.content,
                p1: compartment.p1,
                p2: compartment.p2,
                p3: compartment.p3,
                p4: compartment.p4,
                importance: compartment.importance,
                episodeType: compartment.episodeType,
            })),
        );
        promoteSessionFactsDurable(db, RAW_OUTPUT_SESSION_ID, RAW_OUTPUT_PROJECT_IDENTITY, validated.facts, {
            producer: "test-historian",
            runId: `${RAW_OUTPUT_SESSION_ID}:${nowMs}`,
            leaseKey: `compartment:${RAW_OUTPUT_SESSION_ID}`,
            leaseGeneration: "historian-eval",
            batchId: "raw-output",
        });
        verifyAllActiveClaims(db, RAW_OUTPUT_PROJECT_IDENTITY, nowMs);

        const visible = readVisibleClaims(db, RAW_OUTPUT_PROJECT_IDENTITY, laneWorkspaceEpoch(scenario.id), nowMs);
        if (visible === null) {
            // A fresh single-writer temp DB cannot legitimately be stale.
            throw new Error("historian-eval scorer: temp-DB claim snapshot unexpectedly stale");
        }
        const rows = validated.compartments.map((compartment) => ({
            startMessage: compartment.startMessage,
            endMessage: compartment.endMessage,
        }));
        return {
            stage: "scored",
            score: assembleScore({
                scenarioId: scenario.id,
                facts: scoreFacts(scenario, visible),
                structuralFindings: structuralFindingsFromRows(rows, scenario.gold.compartments.minCount),
                probeVerdicts: [],
                allAttemptsInvalid: false,
            }),
        };
    } finally {
        db.close();
    }
}

function errorScore(scenarioId: string, reason: string, detail: string | null): ScenarioScore {
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
    };
}

/**
 * Score a run record produced by the replay runner. ERROR-flagged records
 * propagate their reason with no rates computed (R6). A live historian
 * whose every attempt was rejected by validation is model behavior, not
 * infrastructure: FAIL:invalid-output (KTD4/KTD8).
 *
 * `recordDir` is the directory the run record itself lives in;
 * `contextDbSnapshotPath` is stored relative to it so an archived artifact
 * re-scores after being downloaded to a different path. An absolute stored
 * path still resolves to itself, so pre-existing records keep working.
 */
export function scoreRunRecord(
    record: HistorianEvalRunRecord,
    scenario: HistorianEvalScenario,
    options: { recordDir: string },
): ScenarioScore {
    // Pairing checks before anything is read: the record carries the schema,
    // scenario id, and scenario fingerprint precisely so a record cannot be
    // scored against a scenario it did not run. Re-scoring an archived record
    // after its same-id scenario was edited would otherwise evaluate an old
    // database against new gold and return an apparently valid verdict.
    if (record.schema !== RUN_RECORD_SCHEMA) {
        throw new Error(`historian-eval scorer: run record schema ${record.schema} is not ${RUN_RECORD_SCHEMA}`);
    }
    if (record.scenarioId !== scenario.id) {
        throw new Error(
            `historian-eval scorer: run record for ${record.scenarioId} cannot be scored against scenario ${scenario.id}`,
        );
    }
    const expectedFingerprint = scenarioFingerprint(scenario);
    if (record.scenarioFingerprint !== expectedFingerprint) {
        throw new Error(
            `historian-eval scorer: ${scenario.id} fingerprint drift; run record recorded ${record.scenarioFingerprint} but the scenario now fingerprints ${expectedFingerprint}`,
        );
    }
    if (record.error !== null) {
        return errorScore(record.scenarioId, record.error.reason, record.error.detail);
    }
    if (classifyTerminalRuns(record.historianRuns).kind === "validation-exhausted") {
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
        });
    }

    const db = openTestDb(resolve(options.recordDir, record.contextDbSnapshotPath), { readonly: true });
    try {
        const visible = readVisibleClaims(
            db,
            record.projectIdentity,
            laneWorkspaceEpoch(record.scenarioId),
            record.nowMs,
        );
        if (visible === null) {
            return errorScore(record.scenarioId, "stale-snapshot", "claim snapshot stale after the injection read's retry");
        }
        const rows = db
            .prepare(
                "SELECT start_message AS startMessage, end_message AS endMessage FROM compartments WHERE session_id = ? ORDER BY sequence ASC",
            )
            .all(record.sessionId) as Array<{ startMessage: number; endMessage: number }>;

        const probesById = new Map(scenario.probes.map((probe) => [probe.id, probe]));
        // The runner drives every scenario probe or aborts, so a short probe
        // set means the record was truncated or hand-edited. Without this the
        // whole probe tier is silently skipped and the scenario can score
        // PASS — the same archived-record hazard the pairing checks above
        // close, so it fails the same way.
        const exchangedProbeIds = new Set(record.probes.map((exchange) => exchange.probeId));
        const missingProbes = scenario.probes
            .filter((probe) => !exchangedProbeIds.has(probe.id))
            .map((probe) => probe.id);
        if (missingProbes.length > 0) {
            throw new Error(
                `historian-eval scorer: run record for ${record.scenarioId} is missing probe exchange(s) ${missingProbes.join(", ")}`,
            );
        }
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
                ...structuralFindingsFromRows(rows, scenario.gold.compartments.minCount),
                ...healingFindings(record),
            ],
            probeVerdicts,
            allAttemptsInvalid: false,
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

export function buildLaneReport(
    scores: readonly ScenarioScore[],
    options: { releaseVersion?: string; system?: SystemVersionTuple } = {},
): LaneReport {    const sorted = [...scores].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
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
        system: options.system ?? null,
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
