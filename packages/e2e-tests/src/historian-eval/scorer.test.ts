import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../../plugin/src/features/magic-context/compartment-storage";
import { promoteSessionFactsDurable } from "../../../plugin/src/features/magic-context/memory/promotion";
import { createProjectMemoryClaim } from "../../../plugin/src/features/magic-context/memory/storage-claim-operations";
import { ensureProject } from "../../../plugin/src/features/magic-context/memory/storage-claims";
import { createDirectTestDatabase } from "../../../plugin/src/features/magic-context/test-database";
import type { Database } from "../../../plugin/src/shared/sqlite";
import { readInjectedClaims } from "./claim-read";
import { verifyAllActiveClaims } from "./verification-bridge";
import type { HistorianEvalScenario } from "./contract";
import { scenarioFingerprint, triggerFingerprint } from "./contract";
import { buildMockHistorianOutput, type MockHistorianFact } from "../mock-historian";
import type { HistorianEvalRunRecord, HistorianRunArtifact, InjectedClaimRecord, ProbeExchange } from "./runner";
import { RUN_RECORD_SCHEMA, authoredTurnOrdinalsFor, buildProbePrompt } from "./runner";
import {
    buildLaneReport,
    compareProbeAnswer,
    freshScoringDatabase,
    laneExitCode,
    scoreRawOutput,
    scoreRunRecord,
    type ScenarioScore,
} from "./scorer";
import { goldFacts, goldenRawOutput, validScenario, validScenarioRaw } from "./test-support";

const PROJECT_IDENTITY = "dir:/historian-eval/scorer-test";
const SESSION_ID = "ses_historianEvalScorer";

interface SnapshotFixture {
    dbPath: string;
    nowMs: number;
    injectedClaims: InjectedClaimRecord[];
    db: Database;
    cleanup: () => void;
}

/**
 */
function makeSnapshot(args: {
    facts: MockHistorianFact[];
    compartments?: Array<{ start: number; end: number }>;
    nowMs?: number;
    /* */
    expiresAt?: number;
    mutate?: (db: Database) => void;
}): SnapshotFixture {
    const dir = mkdtempSync(join(tmpdir(), "historian-eval-scorer-"));
    const dbPath = join(dir, "context-db-snapshot.sqlite");
    const { db } = createDirectTestDatabase({ path: dbPath });
    const nowMs = args.nowMs ?? Date.now();
    const compartments = args.compartments ?? [
        { start: 1, end: 12 },
        { start: 13, end: 20 },
    ];
    appendCompartments(
        db,
        SESSION_ID,
        compartments.map((range, index) => ({
            sequence: index + 1,
            startMessage: range.start,
            endMessage: range.end,
            startMessageId: `msg-${range.start}`,
            endMessageId: `msg-${range.end}`,
            title: `Compartment ${index + 1}`,
            content: "P1 summary",
            p1: "P1 summary",
            p2: "P2",
            p3: "P3",
            p4: "",
        })),
    );
    if (args.expiresAt === undefined) {
        promoteSessionFactsDurable(db, SESSION_ID, PROJECT_IDENTITY, args.facts, {
            producer: "test-historian",
            runId: `${SESSION_ID}:1`,
            leaseKey: `compartment:${SESSION_ID}`,
            leaseGeneration: "test",
            batchId: "1-8",
        });
    } else {
        const projectId = ensureProject(db, PROJECT_IDENTITY);
        for (const [index, fact] of args.facts.entries()) {
            createProjectMemoryClaim(
                db,
                { producer: "test-historian", operationKey: `expiring-${index}` },
                {
                    projectId,
                    content: fact.content,
                    category: fact.category,
                    expiresAt: args.expiresAt,
                    provenance: {
                        sourceLocator: `historian://test-historian/${SESSION_ID}/exp/${index}`,
                        sourceContent: fact.content,
                        sourceSessionId: SESSION_ID,
                        extractor: "historian",
                        extractorVersion: "direct-claims-v1",
                        extractorRunId: `${SESSION_ID}:exp`,
                        independenceKey: `test-historian:exp:${index}`,
                        sourceTrustClass: "model_inference",
                    },
                    actor: "test-historian",
                    nowMs,
                },
            );
        }
    }
    verifyAllActiveClaims(db, PROJECT_IDENTITY, nowMs);
    args.mutate?.(db);
    const injectedClaims = readInjectedClaims(db, PROJECT_IDENTITY, "test", nowMs) ?? [];
    return {
        dbPath,
        nowMs,
        injectedClaims,
        db,
        cleanup: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/**
 *
 */
function withAnswer(exchange: ProbeExchange, answerRaw: string): ProbeExchange {
    return { ...exchange, answerRaw, responseText: `<answer>${answerRaw}</answer>` };
}

/**
 * The fixture models a claim trimmed from one probe turn by removing its locator and rendered payload line.
 *
 */
function withoutInjectedClaim(exchange: ProbeExchange, claim: InjectedClaimRecord): ProbeExchange {
    const withoutLine = (text: string | null): string | null =>
        text === null
            ? null
            : text
                  .split("\n")
                  .filter((line) => !line.startsWith(`${claim.publicClaimId}:`))
                  .join("\n");
    return {
        ...exchange,
        injectedRevisionLocators: exchange.injectedRevisionLocators.filter(
            (locator) => locator !== claim.revisionLocator,
        ),
        payloadText: withoutLine(exchange.payloadText),
        finalRequestPayloadText: withoutLine(exchange.finalRequestPayloadText),
    };
}

function goldenRun(overrides: Partial<HistorianRunArtifact> = {}): HistorianRunArtifact {
    const run: HistorianRunArtifact = {
        runIndex: 1,
        rawOutput: goldenRawOutput(),
        status: "success",
        failureReason: null,
        repairUsed: false,
        attemptCount: 1,
        discardedLast: false,
        lookaheadMargin: 0,
        emittedCompartments: 1,
        persistedCompartments: 1,
        factsEmitted: 2,
        chunkStartOrdinal: 1,
        chunkEndOrdinal: 20,
        promotionEvidenceAdded: 2,
        unprocessedFrom: null,
        ...overrides,
    };
    return overrides.emittedCompartments !== undefined
        ? run
        : { ...run, emittedCompartments: run.persistedCompartments + (run.discardedLast ? 1 : 0) };
}

function makeRecord(
    fixture: SnapshotFixture,
    scenario: HistorianEvalScenario,
    overrides: Partial<HistorianEvalRunRecord> = {},
): HistorianEvalRunRecord {
    const locators = fixture.injectedClaims.map((claim) => claim.revisionLocator);
    const compartmentEnds = (
        fixture.db
            .prepare("SELECT end_message AS endMessage FROM compartments WHERE session_id = ? ORDER BY sequence ASC")
            .all(SESSION_ID) as Array<{ endMessage: number }>
    ).map((row) => row.endMessage);
    const probes: ProbeExchange[] = scenario.probes.map((probe) => {
        let answerRaw = "4096";
        if (probe.answerType === "multiple-choice") answerRaw = probe.goldAnswer;
        if (probe.answerType === "claim-id") {
            const match = fixture.injectedClaims.find((claim) => claim.content.toLowerCase().includes("lru"));
            answerRaw = match?.publicClaimId ?? "missing";
        }
        return {
            probeId: probe.id,
            answerRaw,
            reAsked: false,
            injectedRevisionLocators: locators,
            // The scorer reapplies the leak gate to every scripted probe request.
            // `payloadText` excludes the raw authored transcript removed by the splice.
            payloadText: [
                buildProbePrompt(probe),
                "<project-memory>",
                ...fixture.injectedClaims.map((claim) => `${claim.publicClaimId}: ${claim.content}`),
                "</project-memory>",
            ].join("\n"),
            // The scorer extracts the answer from `responseText` and requires it to equal `answerRaw`.
            responseText: `<answer>${answerRaw}</answer>`,
            // No re-ask occurs, so `finalRequestPayloadText` is the only request.
            discardedResponseTexts: [],
            finalRequestPayloadText: [
                buildProbePrompt(probe),
                "<project-memory>",
                ...fixture.injectedClaims.map((claim) => `${claim.publicClaimId}: ${claim.content}`),
                "</project-memory>",
            ].join("\n"),
        };
    });
    const record = buildRecord();
    // The fixture inserts `historian_runs` rows so the scorer can cross-check them against the run record.
    // The fixture normalizes `chunkEndOrdinal` so `lookaheadMargin` matches the compartment ranges.
    fixture.db.prepare("DELETE FROM historian_runs WHERE session_id = ?").run(SESSION_ID);
    // `subagent_invocations.status` distinguishes returned malformed text from an invocation that never executed.
    fixture.db.prepare("DELETE FROM subagent_invocations WHERE session_id = ?").run(SESSION_ID);
    const insertInvocation = fixture.db.prepare(
        `INSERT INTO subagent_invocations (session_id, harness, subagent, started_at, status)
         VALUES (?, 'opencode', 'historian', ?, 'completed')`,
    );
    const insertRun = fixture.db.prepare(
        `INSERT INTO historian_runs
             (session_id, run_kind, status, failure_reason, chunk_start_ordinal, chunk_end_ordinal,
              compartments_produced, facts_emitted, discarded_last, unprocessed_from,
              subagent_invocation_id, created_at)
         VALUES (?, 'incremental', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const run of record.historianRuns) {
        // `completed` records returned model text; `failed` records provider failures.
        // behaviour.
        const invocationId = Number(insertInvocation.run(SESSION_ID, fixture.nowMs).lastInsertRowid);
        insertRun.run(
            SESSION_ID,
            run.status,
            run.failureReason,
            run.chunkStartOrdinal,
            run.chunkEndOrdinal,
            run.persistedCompartments,
            run.factsEmitted,
            run.discardedLast ? 1 : 0,
            run.unprocessedFrom,
            invocationId,
            fixture.nowMs,
        );
    }
    return record;

    function buildRecord(): HistorianEvalRunRecord {
      const draft = {
        schema: RUN_RECORD_SCHEMA,
        scenarioId: scenario.id,
        scenarioFingerprint: scenarioFingerprint(scenario),
        // The scorer validates the recipe separately because the semantic fingerprint excludes trigger pressure.
        triggerFingerprint: triggerFingerprint(scenario),
        sessionId: SESSION_ID,
        projectIdentity: PROJECT_IDENTITY,
        nowMs: fixture.nowMs,
        system: {
            repoCommitSha: "test",
            bunVersion: "test-bun",
            opencodeVersion: "test",
            historianModelId: "scripted-mock",
            probeModelId: "scripted-mock",
            parserImpl: "ts",
            chunkTokenBudget: null,
        },
        expectedHistorianRuns: scenario.trigger.expectedHistorianRuns,
        historianRuns: Array.from({ length: scenario.trigger.expectedHistorianRuns }, (_, index) =>
            goldenRun({ runIndex: index + 1 }),
        ),
        // The fixture derives the ordinal from the rendered layout because the scorer validates it.
        authoredTurnOrdinals: authoredTurnOrdinalsFor(scenario),
        perGoldPredicate: [],
        injectedClaims: fixture.injectedClaims,
        probes,
        verifiedClaimCount: fixture.injectedClaims.length,
        contextDbSnapshotPath: fixture.dbPath,
        error: null,
        ...overrides,
      } satisfies HistorianEvalRunRecord;
      let persistedSoFar = 0;
      return {
          ...draft,
          historianRuns: draft.historianRuns.map((run) => {
              persistedSoFar += run.persistedCompartments;
              const prefix = compartmentEnds.slice(0, persistedSoFar);
              if (run.lookaheadMargin === null || prefix.length === 0) return run;
              return { ...run, chunkEndOrdinal: Math.max(...prefix) + run.lookaheadMargin };
          }),
      };
    }
}

/**
 */
function probeFreeScenario(base: HistorianEvalScenario = validScenario()): HistorianEvalScenario {
    return { ...base, probes: [] };
}

describe("scoreRawOutput (layered raw-output seam)", () => {
    test("golden output scores PASS with P=R=1.0", () => {
        const result = scoreRawOutput(goldenRawOutput(), validScenario());
        expect(result.stage).toBe("scored");
        if (result.stage !== "scored") return;
        expect(result.score.verdict).toBe("PASS");
        expect(result.score.precision).toBe(1);
        expect(result.score.recall).toBe(1);
    });

    test("dropped gold fact scores FAIL:recall", () => {
        const output = goldenRawOutput(validScenario(), goldFacts().slice(0, 1));
        const result = scoreRawOutput(output, validScenario());
        expect(result.stage).toBe("scored");
        if (result.stage !== "scored") return;
        expect(result.score.verdict).toBe("FAIL");
        expect(result.score.failReasons).toEqual(["recall"]);
    });

    test("extra unexpected active claim lowers precision without changing the verdict", () => {
        const output = goldenRawOutput(validScenario(), [
            ...goldFacts(),
            { category: "NAMING", content: "Helper modules use the -support suffix." },
        ]);
        const result = scoreRawOutput(output, validScenario());
        expect(result.stage).toBe("scored");
        if (result.stage !== "scored") return;
        expect(result.score.verdict).toBe("PASS");
        expect(result.score.precision).not.toBeNull();
        expect(result.score.precision!).toBeLessThan(1);
        expect(result.score.recall).toBe(1);
    });

    test("expected-absent match scores FAIL:false-authoritative, reported separately from P/R", () => {
        const output = goldenRawOutput(validScenario(), [
            ...goldFacts(),
            { category: "ARCHITECTURE", content: "Use Redis for the session cache." },
        ]);
        const result = scoreRawOutput(output, validScenario());
        expect(result.stage).toBe("scored");
        if (result.stage !== "scored") return;
        expect(result.score.verdict).toBe("FAIL");
        expect(result.score.failReasons).toContain("false-authoritative");
        expect(result.score.falseAuthoritativeMatches).toEqual(["abs-redis-active"]);
        // Recall remains perfect when the run fails.
        expect(result.score.recall).toBe(1);
    });

    test("rejected-alternative-as-constraint passes (R3's preferred formation)", () => {
        const raw = validScenarioRaw();
        (raw.gold as { expectedClaims: Record<string, unknown>[] }).expectedClaims.push({
            id: "exp-redis-rejection",
            category: "CONSTRAINTS",
            predicate: { kind: "normalized-substring", value: "redis was rejected because" },
            sourceTurnRange: [1, 1],
        });
        const scenario = validScenario();
        const constraintScenario = { ...scenario };
        constraintScenario.gold = {
            ...scenario.gold,
            expectedClaims: [
                ...scenario.gold.expectedClaims,
                {
                    id: "exp-redis-rejection",
                    category: "CONSTRAINTS",
                    predicate: { kind: "normalized-substring", value: "redis was rejected because" },
                    sourceTurnRange: [1, 1],
                },
            ],
        };
        const output = goldenRawOutput(constraintScenario, [
            ...goldFacts(),
            {
                category: "CONSTRAINTS",
                content: "Redis was rejected because it adds an operational dependency.",
            },
        ]);
        const result = scoreRawOutput(output, constraintScenario);
        expect(result.stage).toBe("scored");
        if (result.stage !== "scored") return;
        expect(result.score.verdict).toBe("PASS");
    });

    test("captured artifact replays only against the ordinals the historian actually saw", () => {
        const scenario = validScenario();
        const shifted = buildMockHistorianOutput({
            compartments: [{ start: 21, end: 28, title: "Session cache decision", body: "Chose the in-process LRU cache over Redis; capacity 4096." }],
            facts: goldFacts(),
        });

        const againstAuthoredSpace = scoreRawOutput(shifted, scenario);
        expect(againstAuthoredSpace.stage).toBe("validation-rejected");

        const againstRecordedChunk = scoreRawOutput(shifted, scenario, {
            chunkStartOrdinal: 21,
            chunkEndOrdinal: 28,
            authoredStartOrdinal: 21,
            authoredEndOrdinal: 28,
        });
        expect(againstRecordedChunk.stage).toBe("scored");
        if (againstRecordedChunk.stage !== "scored") return;
        expect(againstRecordedChunk.score.verdict).toBe("PASS");
        expect(againstRecordedChunk.score.recall).toBe(1);
    });

    test("a replayed chunk scopes the gold minimum to the authored span, like scoreRunRecord", () => {
        const base = validScenario();
        const scenario: HistorianEvalScenario = {
            ...base,
            gold: { ...base.gold, compartments: { minCount: 2 } },
        };
        const output = buildMockHistorianOutput({
            compartments: [
                { start: 21, end: 28, title: "Authored", body: "Chose the in-process LRU cache over Redis; capacity 4096." },
                { start: 29, end: 40, title: "Padding", body: "Housekeeping acknowledged." },
            ],
            facts: goldFacts(),
        });
        const result = scoreRawOutput(output, scenario, {
            chunkStartOrdinal: 21,
            chunkEndOrdinal: 40,
            authoredStartOrdinal: 21,
            authoredEndOrdinal: 28,
        });
        expect(result.stage).toBe("scored");
        if (result.stage !== "scored") return;
        expect(result.score.failReasons).toContain("structural");
        expect(
            result.score.structuralFindings.some((finding) =>
                finding.includes("1 persisted across the authored transcript"),
            ),
        ).toBe(true);
    });

    test("an output that stops inside the authored span is not scored", () => {
        const base = validScenario();
        // The early compartment satisfies Gold's minimum of 1, and both gold facts are emitted.
        // Both emitted gold facts yield recall 1.
        // The hard negative is authored only in the epilogue turn.
        // The absence check would otherwise pass an artifact never shown the forbidden formation.
        const short = buildMockHistorianOutput({
            compartments: [{ start: 1, end: 4, title: "Prefix", body: "Chose the in-process LRU cache over Redis; capacity 4096." }],
            facts: goldFacts(),
            unprocessedFrom: 5,
        });
        const result = scoreRawOutput(short, base);
        expect(result.stage).toBe("authored-evidence-unprocessed");
    });

    test("an output covering the authored span still scores", () => {
        // Golden output covers every authored message, so the guard accepts it.
        const result = scoreRawOutput(goldenRawOutput(), validScenario());
        expect(result.stage).toBe("scored");
    });

    test("a chunk range supplied half-way is a caller error, not a silent authored-space fallback", () => {
        expect(() => scoreRawOutput(goldenRawOutput(), validScenario(), { chunkStartOrdinal: 21 })).toThrow(
            /chunkStartOrdinal and chunkEndOrdinal must be supplied together/,
        );
    });

    test("a chunk range without authored bounds is a caller error, not a filler-counting fallback", () => {
        // Without authored bounds, the gold minimum counts every persisted row.
        // Compartments entirely in harness padding can then satisfy the gold minimum.
        expect(() =>
            scoreRawOutput(goldenRawOutput(), validScenario(), { chunkStartOrdinal: 21, chunkEndOrdinal: 40 }),
        ).toThrow(/authoredStartOrdinal and authoredEndOrdinal/);
    });

    test("raw output failing validation is a stage outcome, not a crash", () => {
        const scenario = validScenario();
        const overlapping = buildMockHistorianOutput({
            compartments: [
                { start: 1, end: 5, title: "A", body: "a" },
                { start: 4, end: 8, title: "B", body: "b" },
            ],
            facts: goldFacts(),
        });
        const result = scoreRawOutput(overlapping, scenario);
        expect(result.stage).toBe("validation-rejected");
    });

    test("provisional last compartment inside the healing slack is discarded and skips promotion, as production would", () => {
        const scenario = validScenario();
        const messageCount = scenario.transcript.turns.length * 2;
        const output = buildMockHistorianOutput({
            compartments: [
                { start: 1, end: messageCount - 4, title: "Kept", body: "kept" },
                { start: messageCount - 3, end: messageCount, title: "Provisional tail", body: "tail" },
            ],
            facts: goldFacts(),
        });
        const result = scoreRawOutput(output, scenario);
        expect(result.stage).toBe("scored");
        if (result.stage !== "scored") return;
        // A lookahead margin of 0 is within healing slack, so production discards the tail.
        // Production skips unanchored promotion for that pass.
        // No gold fact may score as visible.
        expect(result.score.recall).toBe(0);
        expect(result.score.failReasons).toContain("recall");
    });
});

describe("scoreRunRecord", () => {
    test("golden run record scores PASS with all probes passing", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const score = scoreRunRecord(makeRecord(fixture, scenario), scenario);
            expect(score.verdict).toBe("PASS");
            expect(score.precision).toBe(1);
            expect(score.recall).toBe(1);
            expect(score.probeVerdicts.every((verdict) => verdict.outcome === "pass")).toBe(true);
        } finally {
            fixture.cleanup();
        }
    });

    test("gold fact absent from the injection read scores FAIL:recall", () => {
        const fixture = makeSnapshot({ facts: goldFacts().slice(0, 1) });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("FAIL");
            expect(score.failReasons).toEqual(["recall"]);
        } finally {
            fixture.cleanup();
        }
    });

    test("superseded (soft-hidden) claim matching an expected-absent predicate passes", () => {
        const fixture = makeSnapshot({
            facts: [...goldFacts(), { category: "ARCHITECTURE", content: "Use Redis for the session cache." }],
            mutate: (db) => {
                const revisionFor = (like: string): number => {
                    const row = db
                        .prepare(
                            `SELECT c.current_revision_id AS revisionId
                             FROM claims c
                             JOIN claim_revisions r ON r.id = c.current_revision_id
                             WHERE r.content LIKE ?`,
                        )
                        .get(like) as { revisionId: number } | null;
                    if (!row) throw new Error(`fixture: claim matching ${like} not found`);
                    return row.revisionId;
                };
                db.prepare(
                    "INSERT INTO claim_conflicts (relation, left_revision_id, right_revision_id, created_at) VALUES ('supersedes', ?, ?, ?)",
                ).run(revisionFor("%in-process LRU cache%"), revisionFor("%Redis for the session cache%"), Date.now());
            },
        });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(record, scenario);
            // The injection read cannot see the injected claim, so no false-authoritative match occurs.
            expect(score.falseAuthoritativeMatches).toEqual([]);
            expect(score.verdict).toBe("PASS");
        } finally {
            fixture.cleanup();
        }
    });

    test("overlapping compartment ranges hand-written into the DB score FAIL:structural", () => {
        const fixture = makeSnapshot({
            facts: goldFacts(),
            compartments: [
                { start: 1, end: 5 },
                // The chunk range ends at 18 so it spans the authored transcript.
                // The chunk range ends at 18, spanning the authored transcript.
                { start: 4, end: 18 },
            ],
        });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("FAIL");
            expect(score.failReasons).toContain("structural");
            expect(score.structuralFindings.some((finding) => finding.includes("overlap"))).toBe(true);
        } finally {
            fixture.cleanup();
        }
    });

    test("healing evidence violation (final run kept provisional boundary) scores FAIL:structural", () => {
        // Every compartment row must be attributed to a recorded run.
        // Every compartment row must be attributed to a recorded run.
        const fixture = makeSnapshot({
            facts: goldFacts(),
            compartments: [
                { start: 1, end: 8 },
                { start: 9, end: 14 },
                { start: 15, end: 20 },
            ],
        });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun(),
                    goldenRun({ runIndex: 2, emittedCompartments: 2, persistedCompartments: 2, lookaheadMargin: 1 }),
                ],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.failReasons).toContain("structural");
            expect(score.structuralFindings.some((finding) => finding.includes("healing"))).toBe(true);
        } finally {
            fixture.cleanup();
        }
    });

    test("unhealed discard on the final run scores FAIL:structural", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario, {
                historianRuns: [goldenRun(), goldenRun({ runIndex: 2, discardedLast: true })],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.failReasons).toContain("structural");
        } finally {
            fixture.cleanup();
        }
    });

    test("all historian attempts invalid scores FAIL:invalid-output (KTD4)", () => {
        const fixture = makeSnapshot({ facts: [] });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ status: "failed", failureReason: "validation: no parsable compartment", rawOutput: "garbage" }),
                    goldenRun({ runIndex: 2, status: "failed", failureReason: "validation: no parsable compartment", rawOutput: "garbage" }),
                ],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("FAIL");
            expect(score.failReasons).toEqual(["invalid-output"]);
        } finally {
            fixture.cleanup();
        }
    });

    test("one run exhausting validation is invalid-output even when the other satisfies every gold", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            // A validation-exhausted run causes `invalid-output` even when another run satisfies every gold.
            // A failed validation-exhausted run is model evidence even when another run succeeds.
            // A failed validation-exhausted run is model evidence even when another run succeeds.
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ runIndex: 1, persistedCompartments: 2, emittedCompartments: 2 }),
                    goldenRun({
                        runIndex: 2,
                        status: "failed",
                        failureReason: "validation: no parsable compartment",
                        rawOutput: "garbage",
                        persistedCompartments: 0,
                        emittedCompartments: 0,
                        factsEmitted: 0,
                        promotionEvidenceAdded: 0,
                        // Run 1's compartments reach the chunk end, so the snapshot margin is 0.
                        // The telemetry cross-check compares the snapshot margin with telemetry.
                        // The scorer rejects a null telemetry margin as a snapshot mismatch before verdict evaluation.
                        // The scorer rejects snapshot mismatches before evaluating the verdict.
                        lookaheadMargin: 0,
                    }),
                ],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("FAIL");
            expect(score.failReasons).toContain("invalid-output");
            // Run 1 published facts, so the rates remain meaningful.
            expect(score.recall).toBe(1);
        } finally {
            fixture.cleanup();
        }
    });

    test("ERROR-flagged run record propagates with no rates computed (R6)", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario, {
                error: { reason: "script-drift", detail: "2 scripted turns never consumed" },
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("script-drift");
            expect(score.precision).toBeNull();
            expect(score.recall).toBeNull();
        } finally {
            fixture.cleanup();
        }
    });

    test("re-scoring with wall clock advanced past claim expiry yields byte-identical verdicts (pinned nowMs)", () => {
        // The claims are expired against the real wall clock but live against the pinned clock.
        // A scorer that reads `Date.now()` sees no visible claims and fails recall.
        const pinnedNowMs = Date.now() - 120_000;
        const fixture = makeSnapshot({
            facts: goldFacts(),
            nowMs: pinnedNowMs,
            expiresAt: pinnedNowMs + 60_000,
        });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            const first = scoreRunRecord(record, scenario);
            const second = scoreRunRecord(record, scenario);
            expect(first.verdict).toBe("PASS");
            expect(JSON.stringify(second)).toBe(JSON.stringify(first));
            // Using a clock other than `record.nowMs` would make the baseline and advanced records indistinguishable.
            //
            // `record-snapshot-mismatch` means the record's injected claims do not match the snapshot injection surface.
            const advanced = scoreRunRecord({ ...record, nowMs: pinnedNowMs + 120_000 }, scenario);
            expect(advanced.verdict).not.toBe("PASS");
            expect(advanced.errorReason).toBe("record-snapshot-mismatch");
            expect(JSON.stringify(advanced)).not.toBe(JSON.stringify(first));
        } finally {
            fixture.cleanup();
        }
    });

    test("an ERROR-flagged record with all-failed runs stays ERROR (R6 precedence)", () => {
        const fixture = makeSnapshot({ facts: [] });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario, {
                error: { reason: "script-drift", detail: "2 scripted turns never consumed" },
                historianRuns: [
                    goldenRun({ status: "failed", failureReason: "validation: no parsable compartment" }),
                    goldenRun({ runIndex: 2, status: "failed", failureReason: "validation: no parsable compartment" }),
                ],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("script-drift");
            expect(score.failReasons).toEqual([]);
            expect(score.recall).toBeNull();
        } finally {
            fixture.cleanup();
        }
    });

    test("a false-authoritative match outranks a trimmed probe: run-fatal evidence is never dropped (R8/KTD8)", () => {
        const fixture = makeSnapshot({
            facts: [...goldFacts(), { category: "ARCHITECTURE", content: "Use Redis for the session cache." }],
        });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            // The scorer trims `probe-capacity` because its injected claims omit the capacity claim.
            // False-authoritative priority prevents the wrong answer from being classified only as `trimmed-by-injection-budget`.
            // Without false-authoritative priority, the outcome would be `trimmed-by-injection-budget` with exit code 1 instead of 2.
            const trimmed = fixture.injectedClaims.find((claim) => claim.content.includes("4096"));
            if (trimmed === undefined) throw new Error("fixture lacks the capacity claim");
            record.probes = record.probes.map((exchange) =>
                exchange.probeId === "probe-capacity"
                    ? withoutInjectedClaim(withAnswer(exchange, "wrong"), trimmed)
                    : exchange,
            );
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("FAIL");
            expect(score.failReasons).toContain("false-authoritative");
            expect(score.falseAuthoritativeMatches).toEqual(["abs-redis-active"]);
            const report = buildLaneReport([score]);
            expect(report.runFatal).toBe(true);
            expect(laneExitCode(report)).toBe(2);
        } finally {
            fixture.cleanup();
        }
    });

    test("a trimmed probe never converts an independent recall FAIL into ERROR (R6/R7)", () => {
        const base = validScenario();
        const scenario: HistorianEvalScenario = {
            ...base,
            gold: {
                ...base.gold,
                expectedClaims: [
                    ...base.gold.expectedClaims,
                    {
                        id: "exp-never-promoted",
                        category: "CONSTRAINTS",
                        predicate: { kind: "normalized-substring", value: "a constraint no run ever promoted" },
                        sourceTurnRange: [1, 1],
                    },
                ],
            },
        };
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const record = makeRecord(fixture, scenario);
            // Recall evidence comes from facts read, independent of probe tier.
            // A trimmed probe must not convert independent recall evidence to ERROR.
            const trimmed = fixture.injectedClaims.find((claim) => claim.content.includes("4096"));
            if (trimmed === undefined) throw new Error("fixture lacks the capacity claim");
            record.probes = record.probes.map((exchange) =>
                exchange.probeId === "probe-capacity"
                    ? withoutInjectedClaim(withAnswer(exchange, "wrong"), trimmed)
                    : exchange,
            );
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("FAIL");
            expect(score.failReasons).toEqual(["recall"]);
            expect(score.probeVerdicts.some((verdict) => verdict.outcome === "error-trimmed")).toBe(true);
        } finally {
            fixture.cleanup();
        }
    });
    test("a record paired with a different scenario is ERROR, never a misattributed verdict", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord({ ...record, scenarioId: "hse-some-other-scenario" }, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-scenario-mismatch");
            expect(score.recall).toBeNull();
        } finally {
            fixture.cleanup();
        }
    });

    test("a record whose scenario was edited after the run is ERROR (fingerprint mismatch)", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            const edited: HistorianEvalScenario = { ...scenario, title: `${scenario.title} (reworded)` };
            const score = scoreRunRecord(record, edited);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-scenario-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("a truncated run inventory is ERROR, not a PASS off the retained snapshot", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            const truncated = { ...record, historianRuns: record.historianRuns.slice(0, 1) };
            const score = scoreRunRecord(truncated, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-runs-incomplete");

            const noRuns = { ...record, historianRuns: [] };
            expect(scoreRunRecord(noRuns, scenario).errorReason).toBe("record-runs-incomplete");
        } finally {
            fixture.cleanup();
        }
    });

    test("a record missing a declared probe exchange is ERROR, not a PASS that skipped the probe", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            expect(scoreRunRecord(record, scenario).verdict).toBe("PASS");

            const dropped = { ...record, probes: record.probes.slice(0, record.probes.length - 1) };
            const droppedScore = scoreRunRecord(dropped, scenario);
            expect(droppedScore.verdict).toBe("ERROR");
            expect(droppedScore.errorReason).toBe("record-probes-incomplete");

            const duplicated = { ...record, probes: [...record.probes, record.probes[0]] };
            expect(scoreRunRecord(duplicated, scenario).errorReason).toBe("record-probes-incomplete");
        } finally {
            fixture.cleanup();
        }
    });

    test("an unreadable snapshot is an ERROR for that scenario, not a thrown lane abort", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(
                { ...record, contextDbSnapshotPath: join(fixture.dbPath, "..", "absent-snapshot.sqlite") },
                scenario,
            );
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("unreadable-snapshot");
            expect(score.recall).toBeNull();
        } finally {
            fixture.cleanup();
        }
    });

    test("a trimmed probe never swallows a different probe's genuine failure", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            const trimmed = fixture.injectedClaims.find((claim) => claim.content.includes("4096"));
            if (trimmed === undefined) throw new Error("fixture lacks the capacity claim");
            // The scorer trims `probe-capacity` because its injected set lacks a promoted gold claim.
            // probe-store fails independently with a complete injected set.
            // failReasons collapses both outcomes into one "probe" entry.
            // A rule keyed on the aggregated "probe" reason would convert the scenario to ERROR and drop the real failure.
            record.probes = record.probes.map((exchange) => {
                if (exchange.probeId === "probe-capacity") {
                    return withoutInjectedClaim(withAnswer(exchange, "wrong"), trimmed);
                }
                if (exchange.probeId === "probe-store") return withAnswer(exchange, "redis");
                return exchange;
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("FAIL");
            expect(score.failReasons).toEqual(["probe"]);
            expect(score.probeVerdicts.some((verdict) => verdict.outcome === "error-trimmed")).toBe(true);
            expect(score.probeVerdicts.some((verdict) => verdict.outcome === "fail")).toBe(true);
        } finally {
            fixture.cleanup();
        }
    });

    test("a record that lost its injected-claim evidence is ERROR, not a PASS off the intact snapshot", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            // Exact and multiple-choice passing comparisons do not read `record.injectedClaims`.
            // Snapshot facts can still determine scores when `injectedClaims` is empty.
            const base = validScenario();
            const scenario: HistorianEvalScenario = {
                ...base,
                probes: base.probes.filter((probe) => probe.answerType !== "claim-id"),
            };
            const record = makeRecord(fixture, scenario);
            expect(scoreRunRecord(record, scenario).verdict).toBe("PASS");

            const score = scoreRunRecord({ ...record, injectedClaims: [] }, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("an empty system-version field is malformed, not a usable identity", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            // A runtime discriminator must reject empty strings because `typeof x === "string"` accepts `""`.
            // An empty runtime field would group a record with runs that do not share its runtime.
            for (const field of ["bunVersion", "opencodeVersion", "repoCommitSha", "historianModelId", "probeModelId"] as const) {
                for (const empty of ["", "   "]) {
                    const score = scoreRunRecord(
                        { ...record, system: { ...record.system, [field]: empty } },
                        scenario,
                    );
                    expect(score.errorReason, `${field}=${JSON.stringify(empty)}`).toBe("record-malformed");
                }
            }
        } finally {
            fixture.cleanup();
        }
    });

    test("an older schema is classified as unsupported, not as a malformed record", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            // Classify v1/v2 records lacking v3-required system fields as compatible historical artifacts, not `record-malformed`.
            const { bunVersion: _bun, opencodeVersion: _oc, ...olderSystem } = record.system;
            const older = {
                ...record,
                schema: "historian-eval-run-record/v1" as typeof RUN_RECORD_SCHEMA,
                system: olderSystem as typeof record.system,
            };
            const score = scoreRunRecord(older, scenario);
            expect(score.errorReason).toBe("record-schema-unsupported");
            expect(score.errorDetail).toContain("historian-eval-run-record/v1");
            expect(score.scenarioId).toBe(scenario.id);
        } finally {
            fixture.cleanup();
        }
    });

    test("an ERROR artifact under an unsupported schema is an integrity error, not its own stale reason", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario, {
                error: { reason: "script-drift", detail: "2 scripted turns never consumed" },
            });
            // Identity validation prevents foreign or incompatible artifacts from entering reports under their stored error reasons.
            const wrongSchema = scoreRunRecord(
                { ...record, schema: "historian-eval-run-record/v0" as typeof RUN_RECORD_SCHEMA },
                scenario,
            );
            expect(wrongSchema.errorReason).toBe("record-schema-unsupported");

            const wrongScenario = scoreRunRecord({ ...record, scenarioId: "hse-other" }, scenario);
            expect(wrongScenario.errorReason).toBe("record-scenario-mismatch");

            // Run-inventory validation must follow stored-error passthrough because ERROR records may legitimately omit declared runs.
            const aborted = scoreRunRecord({ ...record, historianRuns: [] }, scenario);
            expect(aborted.errorReason).toBe("script-drift");
        } finally {
            fixture.cleanup();
        }
    });

    test("an observed false-authoritative promotion survives an aborted run: FAIL run-fatal, not ERROR (R8/KTD8)", () => {
        const fixture = makeSnapshot({
            facts: [...goldFacts(), { category: "ARCHITECTURE", content: "Use Redis for the session cache." }],
        });
        try {
            const scenario = validScenario();
            // The scorer captures claim state before probe-tier execution so probe aborts preserve claim-state evidence.
            const aborted = makeRecord(fixture, scenario, {
                error: { reason: "probe-response-leak", detail: "probe-capacity leaked a claim id" },
            });
            const score = scoreRunRecord(aborted, scenario);
            expect(score.verdict).toBe("FAIL");
            expect(score.failReasons).toEqual(["false-authoritative"]);
            expect(score.falseAuthoritativeMatches).toEqual(["abs-redis-active"]);
            // The score preserves the abort reason and detail while reporting `FAIL`.
            expect(score.errorReason).toBe("probe-response-leak");
            expect(score.errorDetail).toBe("probe-capacity leaked a claim id");
            expect(score.recall).toBeNull();
            expect(score.precision).toBeNull();
            const report = buildLaneReport([score]);
            expect(report.runFatal).toBe(true);
            expect(laneExitCode(report)).toBe(2);
        } finally {
            fixture.cleanup();
        }
    });

    test("an aborted record whose claim set disagrees with its snapshot is an integrity ERROR, not a verdict", () => {
        const fixture = makeSnapshot({
            facts: [...goldFacts(), { category: "ARCHITECTURE", content: "Use Redis for the session cache." }],
        });
        try {
            const scenario = validScenario();
            const aborted = makeRecord(fixture, scenario, {
                error: { reason: "probe-response-leak", detail: "probe-capacity leaked a claim id" },
            });
            // Each record-snapshot mismatch scores as `ERROR`.
            const forged = {
                publicClaimId: "clm-forged",
                revisionLocator: "rev-forged",
                content: "Use Redis for the session cache.",
                category: "ARCHITECTURE",
                revision: 1,
            };
            for (const [label, edited] of [
                ["truncated claim array", { ...aborted, injectedClaims: [] }],
                // An empty `projectIdentity` must mismatch when the snapshot contains the forbidden claim.
                ["unresolvable identity with no recorded claims", { ...aborted, projectIdentity: "", injectedClaims: [] }],
                ["appended forged claim", { ...aborted, injectedClaims: [...aborted.injectedClaims, forged] }],
                ["edited project identity", { ...aborted, projectIdentity: "no-such-project" }],
            ] satisfies Array<[string, HistorianEvalRunRecord]>) {
                const score = scoreRunRecord(edited, scenario);
                expect(score.verdict, label).toBe("ERROR");
                expect(score.errorReason, label).toBe("record-snapshot-mismatch");
                // The integrity failure preserves the abort reason in `errorDetail`.
                expect(score.errorDetail, label).toContain("probe-response-leak");
                expect(score.failReasons, label).toEqual([]);
            }

            // A changed `nowMs` mismatches only when it changes the visible claim set.
            // With no validity windows, `nowMs: 1` returns the same three claims, so the aborted promotion remains a `FAIL`.
            // A snapshot mismatch rejects only edits that change the visible claim set.
            const shiftedClock = scoreRunRecord({ ...aborted, nowMs: 1 }, scenario);
            expect(shiftedClock.verdict).toBe("FAIL");
            expect(shiftedClock.falseAuthoritativeMatches).toEqual(["abs-redis-active"]);
            expect(laneExitCode(buildLaneReport([shiftedClock]))).toBe(2);
        } finally {
            fixture.cleanup();
        }
    });

    test("an aborted run with no forbidden promotion stays an ordinary ERROR", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const aborted = makeRecord(fixture, scenario, {
                error: { reason: "probe-response-leak", detail: "probe-capacity leaked a claim id" },
            });
            const score = scoreRunRecord(aborted, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("probe-response-leak");
            expect(score.failReasons).toEqual([]);
            expect(laneExitCode(buildLaneReport([score]))).toBe(1);
        } finally {
            fixture.cleanup();
        }
    });

    test("a stored record carrying a run that never evaluated the historian is ERROR", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            // Stored records bypass runner validation.
            // The stored record retains its expected index, so the inventory check accepts it.
            const noop = makeRecord(fixture, scenario, {
                historianRuns: [goldenRun(), goldenRun({ runIndex: 2, status: "noop" })],
            });
            expect(scoreRunRecord(noop, scenario).errorReason).toBe("record-runs-incomplete");

            const infraFailure = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun(),
                    goldenRun({ runIndex: 2, status: "failed", failureReason: "stale_snapshot" }),
                ],
            });
            expect(scoreRunRecord(infraFailure, scenario).errorReason).toBe("record-runs-incomplete");

            // A validation failure is model behavior and stays scoreable.
            const invalid = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun(),
                    goldenRun({ runIndex: 2, status: "failed", failureReason: "validation: no parsable compartment" }),
                ],
            });
            expect(scoreRunRecord(invalid, scenario).verdict).not.toBe("ERROR");
        } finally {
            fixture.cleanup();
        }
    });

    test("an all-invalid record with an unreadable snapshot is an integrity ERROR, not a model FAIL", () => {
        const fixture = makeSnapshot({ facts: [] });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ status: "failed", failureReason: "validation: no parsable compartment" }),
                    goldenRun({
                        runIndex: 2,
                        status: "failed",
                        failureReason: "validation: no parsable compartment",
                    }),
                ],
            });
            // `invalid-output` produces `FAIL`.
            expect(scoreRunRecord(record, scenario).failReasons).toEqual(["invalid-output"]);

            // Without the snapshot, the record cannot support a model-quality score.
            const score = scoreRunRecord(
                { ...record, contextDbSnapshotPath: join(fixture.dbPath, "..", "absent.sqlite") },
                scenario,
            );
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("unreadable-snapshot");
        } finally {
            fixture.cleanup();
        }
    });

    test("a non-object record root is one ERROR, not a thrown lane abort", () => {
        const scenario = probeFreeScenario();
        for (const root of [null, [], 7, "record"]) {
            const score = scoreRunRecord(root as unknown as HistorianEvalRunRecord, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-malformed");
        }
    });

    test("a compartment row no recorded run accounts for is a mismatch", () => {
        const fixture = makeSnapshot({
            facts: goldFacts(),
            compartments: [
                { start: 1, end: 12 },
                { start: 13, end: 18 },
                { start: 19, end: 20 },
            ],
        });
        try {
            const scenario = probeFreeScenario();
            // Two runs with one persisted compartment each cannot account for three rows.
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("a kept provisional boundary does not excuse an uncovered gold range", () => {
        // No row reaches the authored span 13–20, so the gold range is uncovered.
        const fixture = makeSnapshot({
            facts: goldFacts(),
            compartments: [
                { start: 1, end: 12 },
                { start: 13, end: 16 },
            ],
        });
        try {
            const scenario = validScenario();
            // A persisted `KEPT` boundary makes `persistedCompartments` equal 2.
            // The persisted `KEPT` boundary covers its range and does not explain the gap.
            // The coverage gate must fail when no row reaches the authored span.
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ persistedCompartments: 1, emittedCompartments: 1 }),
                    goldenRun({
                        runIndex: 2,
                        persistedCompartments: 1,
                        emittedCompartments: 1,
                        // A boundary within `HISTORIAN_BOUNDARY_HEALING_SLACK` is `KEPT`.
                        // A chunk ending at 18 is within `HISTORIAN_BOUNDARY_HEALING_SLACK`.
                        // Compartments stop at 16, leaving the capacity claim uncovered.
                        lookaheadMargin: 2,
                        factsEmitted: 0,
                    }),
                ],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("probe-gold-uncovered");
        } finally {
            fixture.cleanup();
        }
    });

    test("an unhealed discard covering a probe's gold range stays a structural FAIL", () => {
        // Compartments reach 16, leaving the capacity claim's 17–18 uncovered.
        const fixture = makeSnapshot({ facts: goldFacts(), compartments: [{ start: 1, end: 16 }] });
        try {
            const scenario = validScenario();
            // A dropped provisional tail leaves the probe's gold range uncovered.
            // Dropping the provisional tail is a forbidden boundary decision.
            // The scorer classifies a forbidden boundary decision as a model failure, not an infrastructure `ERROR`.
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ persistedCompartments: 1, emittedCompartments: 1 }),
                    goldenRun({
                        runIndex: 2,
                        persistedCompartments: 0,
                        emittedCompartments: 1,
                        discardedLast: true,
                        factsEmitted: 0,
                        // A chunk ending at 18 is within `HISTORIAN_BOUNDARY_HEALING_SLACK`.
                        // Discarding the provisional tail leaves part of the authored span uncovered.
                        lookaheadMargin: 2,
                    }),
                ],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("FAIL");
            expect(score.failReasons).toContain("structural");
            expect(score.structuralFindings.some((finding) => finding.includes("discarded"))).toBe(true);
        } finally {
            fixture.cleanup();
        }
    });

    test("one claim satisfying two same-category expectations does not give full recall", () => {
        // The two same-category predicates are unrelated, so the contract permits both expectations.
        // Neither predicate contains the other, so the contract permits both expectations.
        // A single claim can satisfy both expectations, so independent matching reports 2/2.
        // Recall must be bounded by the claims actually formed.
        const base = validScenario();
        const scenario: HistorianEvalScenario = {
            ...base,
            probes: [],
            gold: {
                ...base.gold,
                expectedClaims: [
                    {
                        id: "exp-lru-cache",
                        category: "ARCHITECTURE",
                        predicate: { kind: "normalized-substring", value: "in-process LRU cache" },
                        sourceTurnRange: [1, 1],
                    },
                    {
                        id: "exp-ttl",
                        category: "ARCHITECTURE",
                        predicate: { kind: "normalized-substring", value: "TTL eviction" },
                        sourceTurnRange: [1, 1],
                    },
                ],
            },
        };
        const fixture = makeSnapshot({
            facts: [
                {
                    category: "ARCHITECTURE",
                    content: "Sessions use the in-process LRU cache with TTL eviction.",
                },
            ],
        });
        try {
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(record, scenario);
            expect(score.expectedClaimsMatched).toBe(1);
            expect(score.recall).toBe(0.5);
            expect(score.failReasons).toContain("recall");
        } finally {
            fixture.cleanup();
        }
    });

    test("two claims satisfying two expectations still give full recall", () => {
        // The claim–expectation pairing must not understate recall.
        // Full recall remains 1 when two claims match two expectations.
        const base = validScenario();
        const scenario: HistorianEvalScenario = { ...base, probes: [] };
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(record, scenario);
            expect(score.recall).toBe(1);
        } finally {
            fixture.cleanup();
        }
    });

    test("a record captured under a different trigger recipe is refused", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            // The context limit can change when the historian fires without changing the declared run count.
            // `modelContextLimit` determines when the historian fires and which chunk it evaluates.
            // `scenarioFingerprint` excludes `modelContextLimit`.
            // `scenarioFingerprint` cannot distinguish records that differ only in the context limit.
            const retuned: HistorianEvalScenario = {
                ...scenario,
                trigger: { ...scenario.trigger, modelContextLimit: scenario.trigger.modelContextLimit * 2 },
            };
            const score = scoreRunRecord(record, retuned);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-scenario-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("a run that emitted facts but added no promotion evidence is no-op-promotion, not recall", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            // A fact emitted by the historian but absent from the store is a plumbing loss, not a recall miss.
            // The live runner aborts on plumbing loss; independently scored records must return the same verdict.
            // The scorer must not charge the loss to historian recall.
            //
            // Run 2 must report the loss because run 1 promoted.
            // Only the per-run field exposes the loss when run 1 promoted facts.
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ runIndex: 1 }),
                    goldenRun({ runIndex: 2, promotionEvidenceAdded: 0 }),
                ],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("no-op-promotion");
        } finally {
            fixture.cleanup();
        }
    });

    test("a run record omitting promotionEvidenceAdded is malformed, not silently exempt", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            // An absent field does not equal 0, so the shape gate must reject the omission.
            const stripped = record.historianRuns.map((run) => {
                const { promotionEvidenceAdded: _dropped, ...rest } = run;
                return rest as HistorianRunArtifact;
            });
            const score = scoreRunRecord({ ...record, historianRuns: stripped }, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-malformed");
        } finally {
            fixture.cleanup();
        }
    });

    test("a probe claiming a locator its own payload never rendered is refused", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            const extra = fixture.injectedClaims.find((claim) => claim.content.includes("4096"));
            if (extra === undefined) throw new Error("fixture lacks the capacity claim");
            // A locator beyond the complete final block over-claims a request claim.
            // A locator beyond the complete final block is not inert: `compareProbeAnswer` treats its claim's gold as injected.
            // `compareProbeAnswer` can suppress `error-trimmed` for a guess when it treats the claim's gold as injected.
            record.probes = record.probes.map((exchange) =>
                exchange.probeId === "probe-capacity"
                    ? {
                          ...exchange,
                          finalRequestPayloadText:
                              exchange.finalRequestPayloadText === null
                                  ? null
                                  : exchange.finalRequestPayloadText
                                        .split("\n")
                                        .filter((line) => !line.startsWith(`${extra.publicClaimId}:`))
                                        .join("\n"),
                      }
                    : exchange,
            );
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("a validation-failed run whose invocation never completed is not invalid-output", () => {
        const fixture = makeSnapshot({ facts: [] });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ status: "failed", failureReason: "validation: provider refused", rawOutput: null }),
                    goldenRun({ runIndex: 2, status: "failed", failureReason: "validation: provider refused", rawOutput: null }),
                ],
            });
            // Production stamps `validation: ` even when the provider returns no output.
            // `validation:` alone does not prove that the model received the chunk.
            // Failed linked invocations classify the `validation:` failure as a harness failure.
            fixture.db.prepare("UPDATE subagent_invocations SET status = 'failed' WHERE session_id = ?").run(SESSION_ID);
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("harness-failure");
        } finally {
            fixture.cleanup();
        }
    });

    test("a probe omitting a locator its own payload rendered is refused, not read as trimmed", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            const trimmed = fixture.injectedClaims.find((claim) => claim.content.includes("4096"));
            if (trimmed === undefined) throw new Error("fixture lacks the capacity claim");
            // The plugin cannot produce a locator set that omits a rendered claim.
            record.probes = record.probes.map((exchange) =>
                exchange.probeId === "probe-capacity"
                    ? {
                          ...withAnswer(exchange, "wrong"),
                          injectedRevisionLocators: exchange.injectedRevisionLocators.filter(
                              (locator) => locator !== trimmed.revisionLocator,
                          ),
                      }
                    : exchange,
            );
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("a recorded reply that volunteers a later probe's answer is refused on replay", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            // The answer volunteers probe-store's gold outside the probe-capacity envelope.
            // Probe turns are never compartment-covered, so that prose is raw history for probe-store.
            // A PASS for probe-store would be a copy from raw history.
            // `answerRaw` still matches the extraction, so reproducibility cannot detect the copy.
            record.probes = record.probes.map((exchange) =>
                exchange.probeId === "probe-capacity"
                    ? {
                          ...exchange,
                          answerRaw: "4096",
                          responseText: "<answer>4096</answer> For context, sessions are backed by the in-process lru cache.",
                      }
                    : exchange,
            );
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("probe-response-leak");
        } finally {
            fixture.cleanup();
        }
    });

    test("a reply naming a claim id accepted for a later probe is refused on replay", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            const lru = fixture.injectedClaims.find((claim) => claim.content.toLowerCase().includes("lru"));
            if (lru === undefined) throw new Error("fixture lacks the LRU claim");
            // `probe-capacity` exposes the public ID that `probe-claim`'s answer resolves to.
            // Probe turns are never compartment-covered, so `probe-claim` can read that public ID from raw history.
            // A PASS for `probe-claim` would therefore copy raw history.
            record.probes = record.probes.map((exchange) =>
                exchange.probeId === "probe-capacity"
                    ? {
                          ...exchange,
                          answerRaw: "4096",
                          responseText: `<answer>4096</answer> The architecture is recorded as ${lru.publicClaimId}.`,
                      }
                    : exchange,
            );
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("probe-response-leak");
        } finally {
            fixture.cleanup();
        }
    });

    test("an id the later probe was never credited with is not a leak", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            const lru = fixture.injectedClaims.find((claim) => claim.content.toLowerCase().includes("lru"));
            if (lru === undefined) throw new Error("fixture lacks the LRU claim");
            // A locator absent from `probe-claim`'s injected set cannot be credited.
            // The resolver must resolve public IDs against the answering probe's injected set, not all injected claims.
            record.probes = record.probes.map((exchange) => {
                if (exchange.probeId === "probe-capacity") {
                    return {
                        ...exchange,
                        answerRaw: "4096",
                        responseText: `<answer>4096</answer> The architecture is recorded as ${lru.publicClaimId}.`,
                    };
                }
                if (exchange.probeId === "probe-claim") return withoutInjectedClaim(exchange, lru);
                return exchange;
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.errorReason).not.toBe("probe-response-leak");
        } finally {
            fixture.cleanup();
        }
    });

    test("a discarded malformed reply carrying a later gold is refused on replay", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            // The first reply used two envelopes and was re-asked, so it is absent from `responseText`.
            // The rejected reply was sent, so `probe-store` read it.
            // Rejected probe replies remain readable by later probes, so replay detection includes them.
            record.probes = record.probes.map((exchange) =>
                exchange.probeId === "probe-capacity"
                    ? {
                          ...exchange,
                          answerRaw: "4096",
                          responseText: "<answer>4096</answer>",
                          discardedResponseTexts: ["<answer>4096</answer><answer>in-process lru</answer>"],
                      }
                    : exchange,
            );
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("probe-response-leak");
        } finally {
            fixture.cleanup();
        }
    });

    test("a chatty recorded reply that leaks nothing still scores", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            // `responseText` accepts text before and after the envelope.
            // Rejecting text outside the envelope would turn otherwise valid chatty replies into an ERROR.
            record.probes = record.probes.map((exchange) =>
                exchange.probeId === "probe-capacity"
                    ? {
                          ...exchange,
                          answerRaw: "4096",
                          responseText: "Sure, happy to help.\n<answer>4096</answer>\nLet me know if you need anything else.",
                      }
                    : exchange,
            );
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("PASS");
        } finally {
            fixture.cleanup();
        }
    });

    test("a record declaring a non-TS parser is refused", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(
                { ...record, system: { ...record.system, parserImpl: "rust" as "ts" } },
                scenario,
            );
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-malformed");
        } finally {
            fixture.cleanup();
        }
    });

    test("a malformed nested entry is one ERROR, not a thrown lane abort", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            // `inventory` must be an object before the inventory check dereferences its fields.
            const nested = { ...record, historianRuns: [null] } as unknown as HistorianEvalRunRecord;
            const score = scoreRunRecord(nested, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-malformed");
        } finally {
            fixture.cleanup();
        }
    });

    test("a record missing its probe response text is a harness failure in either mode", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            const liveRecord = {
                ...record,
                system: { ...record.system, probeModelId: "anthropic/claude-sonnet-4-5" },
                probes: record.probes.map((exchange, index) =>
                    index === 0 ? { ...exchange, responseText: null } : exchange,
                ),
            };
            const score = scoreRunRecord(liveRecord, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("harness-failure");
        } finally {
            fixture.cleanup();
        }
    });

    test("a malformed persisted record is one ERROR, not a thrown lane abort", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            // TypeScript's interface says nothing about JSON loaded from disk.
            const truncated = { ...record, historianRuns: null } as unknown as HistorianEvalRunRecord;
            const score = scoreRunRecord(truncated, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-malformed");
        } finally {
            fixture.cleanup();
        }
    });

    test("an edited probe answer no longer matching its recorded response is ERROR", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            const forged = {
                ...record,
                probes: record.probes.map((exchange, index) =>
                    index === 0 ? { ...exchange, answerRaw: "4096" } : exchange,
                ),
            };
            const honest = { ...record, probes: record.probes.map((e, i) => (i === 0 ? withAnswer(e, "4096") : e)) };
            expect(scoreRunRecord(honest, scenario).errorReason).toBeNull();
            const score = scoreRunRecord({ ...forged, probes: forged.probes.map((e, i) => (i === 0 ? { ...e, answerRaw: "wrong" } : e)) }, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("an appended injected-claim entry reusing a real public id is rejected", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            // A reused public ID passes existence validation even when it has no `visible` entry.
            // The divergence check ignores entries absent from `visible`.
            // The scorer rejects fabricated locators whose gold-matching content enters a probe's locator set.
            const forged = {
                ...record,
                injectedClaims: [
                    ...record.injectedClaims,
                    { ...record.injectedClaims[0], revisionLocator: "loc-fabricated" },
                ],
            };
            const score = scoreRunRecord(forged, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("raw gold text in a recorded payload is a leak, not a scored answer", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            // The live runner rejects payloadText containing gold text; stored artifacts bypass that check.
            const leaked = {
                ...record,
                probes: record.probes.map((exchange, index) =>
                    index === 0
                        ? {
                              ...exchange,
                              payloadText: `${exchange.payloadText}\n${scenario.transcript.turns[2].user}`,
                          }
                        : exchange,
                ),
            };
            const score = scoreRunRecord(leaked, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("gold-range-leak");
        } finally {
            fixture.cleanup();
        }
    });

    test("a probe whose gold range is uncovered in the snapshot is ERROR, not a scored answer", () => {
        // The filler compartment satisfies minCount, but no compartment covers authored range 13-20, so the splice cannot remove the probe's gold history.
        const fixture = makeSnapshot({ facts: goldFacts(), compartments: [{ start: 1, end: 16 }] });
        try {
            const scenario = validScenario();
            // The two declared runs must report one persisted compartment because the snapshot has one compartment row.
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ persistedCompartments: 1, emittedCompartments: 1 }),
                    goldenRun({
                        runIndex: 2,
                        persistedCompartments: 0,
                        emittedCompartments: 0,
                        factsEmitted: 0,
                        lookaheadMargin: 2,
                    }),
                ],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("probe-gold-uncovered");
        } finally {
            fixture.cleanup();
        }
    });

    test("a two-run artifact whose later run persists a further compartment is not a mismatch", () => {
        // Run 1's margin uses prefix maximum 12, whereas run 2's uses final maximum 20; using the final maximum for both yields -8 for run 1 and rejects a valid artifact.
        const fixture = makeSnapshot({
            facts: goldFacts(),
            compartments: [
                { start: 1, end: 12 },
                { start: 13, end: 20 },
            ],
        });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ persistedCompartments: 1, lookaheadMargin: 0 }),
                    goldenRun({ runIndex: 2, persistedCompartments: 1, lookaheadMargin: 0 }),
                ],
            });
            expect(record.historianRuns[0].chunkEndOrdinal).toBe(12);
            expect(record.historianRuns[1].chunkEndOrdinal).toBe(20);
            const score = scoreRunRecord(record, scenario);
            expect(score.errorReason).toBeNull();
            expect(score.verdict).toBe("PASS");
        } finally {
            fixture.cleanup();
        }
    });

    test("edited healing telemetry is caught against the snapshot's own run rows", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const honest = makeRecord(fixture, scenario, {
                historianRuns: [goldenRun(), goldenRun({ runIndex: 2, discardedLast: true })],
            });
            expect(scoreRunRecord(honest, scenario).failReasons).toContain("structural");

            // Clearing the discard flag suppresses the unhealed-discard finding.
            // authoritative row.
            const edited = {
                ...honest,
                historianRuns: honest.historianRuns.map((run) =>
                    run.runIndex === 2 ? { ...run, discardedLast: false, emittedCompartments: 1 } : run,
                ),
            };
            const score = scoreRunRecord(edited, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("an extra historian run in the snapshot is caught by row-count disagreement", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            // An undeclared pass fired after the inventory was assembled.
            // An undeclared pass leaves a row that the record cannot name.
            fixture.db
                .prepare(
                    `INSERT INTO historian_runs
                         (session_id, run_kind, status, compartments_produced, facts_emitted, discarded_last, created_at)
                     VALUES (?, 'incremental', 'success', 1, 1, 0, ?)`,
                )
                .run(SESSION_ID, fixture.nowMs);
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("a probe locator set naming a claim the record never recorded is ERROR", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            const forged = {
                ...record,
                probes: record.probes.map((exchange, index) =>
                    index === 0
                        ? { ...exchange, injectedRevisionLocators: [...exchange.injectedRevisionLocators, "loc-forged"] }
                        : exchange,
                ),
            };
            const score = scoreRunRecord(forged, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("an earlier run's kept provisional boundary is not repaired by a later success", () => {
        const fixture = makeSnapshot({
            facts: goldFacts(),
            compartments: [
                { start: 1, end: 8 },
                { start: 9, end: 14 },
                { start: 15, end: 20 },
            ],
        });
        try {
            const scenario = probeFreeScenario();
            // Run 1 persisted a forbidden forced-keep boundary.
            // Run 2 cannot re-derive a persisted forced-keep boundary.
            // Because Run 2 cannot re-derive the boundary, a final-run-only check reports nothing.
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ emittedCompartments: 2, persistedCompartments: 2, lookaheadMargin: 1 }),
                    goldenRun({ runIndex: 2, status: "success", persistedCompartments: 1 }),
                ],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.failReasons).toContain("structural");
            expect(
                score.structuralFindings.some((finding) => finding.includes("run 1 kept a provisional boundary")),
            ).toBe(true);
        } finally {
            fixture.cleanup();
        }
    });

    test("record-controlled authored ordinals are validated against the scenario", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            for (const ordinals of [
                [] as Array<[number, number]>,
                [[1, 8]] as Array<[number, number]>,
                [
                    [1, 2],
                    [3, 4],
                    [5, 6],
                ] as Array<[number, number]>,
                [
                    [1, 20],
                    [3, 4],
                    [5, 6],
                    [7, 8],
                ] as Array<[number, number]>,
            ]) {
                const score = scoreRunRecord({ ...record, authoredTurnOrdinals: ordinals }, scenario);
                expect(score.verdict).toBe("ERROR");
                expect(score.errorReason).toBe("record-scenario-mismatch");
            }
        } finally {
            fixture.cleanup();
        }
    });

    test("an edited recorded claim is caught even when its locator and public id still match", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            // Probe resolution runs `matchesGold` over recorded claims, so repointing a claim to a gold claim's content and category forges an acceptable claim-ID answer without reducing recall.
            const forged = {
                ...record,
                injectedClaims: record.injectedClaims.map((claim, index) =>
                    index === 0
                        ? { ...claim, content: "Session cache capacity is 4096 entries.", category: "CONFIG_VALUES" }
                        : claim,
                ),
            };
            const score = scoreRunRecord(forged, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("compartments outside the authored transcript do not satisfy the gold minimum", () => {
        // Gold requires two authored compartments, but only one persists across the authored transcript.
        // The filler compartment lies outside the authored ordinal span.
        const fixture = makeSnapshot({
            facts: goldFacts(),
            // Ordinals 1-12 are harness-owned filler turns; ordinals 13-20 are the authored transcript.
            // Only the second compartment is authored.
            compartments: [
                { start: 1, end: 12 },
                { start: 13, end: 20 },
            ],
        });
        try {
            const base = probeFreeScenario();
            const scenario: HistorianEvalScenario = {
                ...base,
                gold: { ...base.gold, compartments: { minCount: 2 } },
            };
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(record, scenario);
            expect(score.failReasons).toContain("structural");
            expect(
                score.structuralFindings.some((finding) =>
                    finding.includes("1 persisted across the authored transcript"),
                ),
            ).toBe(true);
        } finally {
            fixture.cleanup();
        }
    });

    test("an unsupported run-record schema is ERROR before any gold is compared", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(
                { ...record, schema: "historian-eval-run-record/v0" as typeof RUN_RECORD_SCHEMA },
                scenario,
            );
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-schema-unsupported");
            expect(score.recall).toBeNull();
        } finally {
            fixture.cleanup();
        }
    });

    test("a record paired with another attempt's snapshot is ERROR, not a verdict off foreign claims", () => {
        // the recorded claims name rows that only exist in the other database.
        const attemptOne = makeSnapshot({ facts: goldFacts() });
        const attemptTwo = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(attemptOne, scenario);
            expect(scoreRunRecord(record, scenario).verdict).toBe("PASS");

            const crossed = { ...record, contextDbSnapshotPath: attemptTwo.dbPath };
            const score = scoreRunRecord(crossed, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            attemptOne.cleanup();
            attemptTwo.cleanup();
        }
    });

    test("an earlier run's discard stays unhealed when the later run fails validation", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            // A failed later run does not re-derive an earlier discarded tail.
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ discardedLast: true }),
                    goldenRun({ runIndex: 2, status: "failed", failureReason: "validation: no parsable compartment" }),
                ],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.failReasons).toContain("structural");
            expect(score.structuralFindings.some((finding) => finding.includes("run 1 discarded"))).toBe(true);
        } finally {
            fixture.cleanup();
        }
    });

    test("an earlier run's discard healed by a later successful run raises no finding", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario, {
                historianRuns: [goldenRun({ discardedLast: true }), goldenRun({ runIndex: 2, status: "success" })],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.structuralFindings).toEqual([]);
            expect(score.verdict).toBe("PASS");
        } finally {
            fixture.cleanup();
        }
    });
});

describe("compareProbeAnswer (hidden-probe tier scoring)", () => {
    const scenario = validScenario();
    const injected: InjectedClaimRecord[] = [
        {
            publicClaimId: "mem-lru01",
            revisionLocator: "loc-lru01",
            content: "Sessions are cached by the in-process LRU cache.",
            category: "ARCHITECTURE",
            revision: 1,
        },
        {
            publicClaimId: "mem-cap01",
            revisionLocator: "loc-cap01",
            content: "Session cache capacity is 4096 entries.",
            category: "CONFIG_VALUES",
            revision: 1,
        },
    ];
    const exchange = (probeId: string, answerRaw: string | null, locators = ["loc-lru01", "loc-cap01"]): ProbeExchange => ({
        probeId,
        answerRaw,
        reAsked: false,
        injectedRevisionLocators: locators,
        payloadText: null,
        finalRequestPayloadText: null,
        responseText: answerRaw === null ? null : `<answer>${answerRaw}</answer>`,
        discardedResponseTexts: [],
    });

    test("exact-value probe compares by normalized string equality", () => {
        const probe = scenario.probes[0];
        expect(
            compareProbeAnswer({ probe, exchange: exchange(probe.id, "  4096 "), scenario, injectedClaims: injected })
                .outcome,
        ).toBe("pass");
        expect(
            compareProbeAnswer({ probe, exchange: exchange(probe.id, "2048"), scenario, injectedClaims: [] }).outcome,
        ).toBe("fail");
    });

    test("wrong multiple-choice selection fails the probe", () => {
        const probe = scenario.probes[1];
        expect(
            compareProbeAnswer({ probe, exchange: exchange(probe.id, "redis"), scenario, injectedClaims: injected })
                .outcome,
        ).toBe("fail");
        expect(
            compareProbeAnswer({
                probe,
                exchange: exchange(probe.id, "In-Process LRU"),
                scenario,
                injectedClaims: injected,
            }).outcome,
        ).toBe("pass");
    });

    test("claim-id probe resolves the gold expected-claim reference to the runtime public id", () => {
        const probe = scenario.probes[2];
        expect(
            compareProbeAnswer({ probe, exchange: exchange(probe.id, "mem-lru01"), scenario, injectedClaims: injected })
                .outcome,
        ).toBe("pass");
        expect(
            compareProbeAnswer({ probe, exchange: exchange(probe.id, "mem-cap01"), scenario, injectedClaims: injected })
                .outcome,
        ).toBe("fail");
    });

    test("a correct answer on an unavailable claim is error-trimmed, not a PASS", () => {
        const probe = scenario.probes[0];
        // The scorer excludes an answer unless an injected claim or permitted compartment summary states its value.
        const verdict = compareProbeAnswer({
            probe,
            exchange: exchange(probe.id, "4096", ["loc-lru01"]),
            scenario,
            injectedClaims: injected,
        });
        expect(verdict.outcome).toBe("error-trimmed");
    });

    test("an injected claim that satisfies the predicate but not the answer is not availability", () => {
        // A broader predicate can match a claim without exposing the expected value.
        // A predicate match without the expected value does not make the value recoverable.
        const broaderScenario: HistorianEvalScenario = {
            ...scenario,
            gold: {
                ...scenario.gold,
                expectedClaims: scenario.gold.expectedClaims.map((claim) =>
                    claim.id === "exp-cache-capacity"
                        ? { ...claim, predicate: { kind: "normalized-substring" as const, value: "session cache" } }
                        : claim,
                ),
            },
        };
        const topicOnly: InjectedClaimRecord[] = [
            {
                publicClaimId: "mem-topic",
                revisionLocator: "loc-topic",
                content: "Session cache configured.",
                category: "CONFIG_VALUES",
                revision: 1,
            },
        ];
        const verdict = compareProbeAnswer({
            probe: broaderScenario.probes[0],
            exchange: exchange(broaderScenario.probes[0].id, "4096", ["loc-topic"]),
            scenario: broaderScenario,
            injectedClaims: topicOnly,
        });
        expect(verdict.outcome).toBe("error-trimmed");
    });

    test("an escaped answer matches an authored gold with the same character", () => {
        const ampScenario: HistorianEvalScenario = {
            ...scenario,
            gold: {
                ...scenario.gold,
                expectedClaims: scenario.gold.expectedClaims.map((claim) =>
                    claim.id === "exp-cache-capacity"
                        ? { ...claim, predicate: { kind: "normalized-substring" as const, value: "A&B" } }
                        : claim,
                ),
            },
            probes: [{ ...scenario.probes[0], answerType: "exact" as const, goldAnswer: "A&B", sourceClaimRef: "exp-cache-capacity" }],
        };
        const ampClaims: InjectedClaimRecord[] = [
            {
                publicClaimId: "mem-amp",
                revisionLocator: "loc-amp",
                content: "The marker is A&B for the cache.",
                category: "CONFIG_VALUES",
                revision: 1,
            },
        ];
        const verdict = compareProbeAnswer({
            probe: ampScenario.probes[0],
            exchange: exchange(ampScenario.probes[0].id, "A&amp;B", ["loc-amp"]),
            scenario: ampScenario,
            injectedClaims: ampClaims,
        });
        expect(verdict.outcome).toBe("pass");
    });

    test("a correct answer stays a PASS when the claim was injected for the probe", () => {
        const probe = scenario.probes[0];
        // Locators in `injectedRevisionLocators` make an answer rely on injected memory.
        // A locator in `injectedRevisionLocators` makes the answer rely on injected memory.
        const verdict = compareProbeAnswer({
            probe,
            exchange: exchange(probe.id, "4096"),
            scenario,
            injectedClaims: injected,
        });
        expect(verdict.outcome).toBe("pass");
    });

    test("a correct answer stays a PASS when a compartment states the fact", () => {
        const probe = scenario.probes[0];
        // A permitted compartment summary can make a trimmed claim recoverable.
        const verdict = compareProbeAnswer({
            probe,
            exchange: {
                ...exchange(probe.id, "4096", ["loc-lru01"]),
                payloadText:
                    "<new-compartments>\nCache decision: capacity set to 4096 entries.\n</new-compartments>",
                finalRequestPayloadText:
                    "<new-compartments>\nCache decision: capacity set to 4096 entries.\n</new-compartments>",
            },
            scenario,
            injectedClaims: injected,
        });
        expect(verdict.outcome).toBe("pass");
    });

    test("a trimmed claim whose fact a compartment still states is a model FAIL, not trimmed", () => {
        const probe = scenario.probes[0];
        // `error-trimmed` applies only when neither injected claims nor permitted compartment summaries state the answer.
        const verdict = compareProbeAnswer({
            probe,
            exchange: {
                ...exchange(probe.id, "wrong", ["loc-lru01"]),
                payloadText:
                    "<new-compartments>\nCache decision: capacity set to 4096 entries.\n</new-compartments>",
                finalRequestPayloadText:
                    "<new-compartments>\nCache decision: capacity set to 4096 entries.\n</new-compartments>",
            },
            scenario,
            injectedClaims: injected,
        });
        expect(verdict.outcome).toBe("fail");
    });

    test("a trimmed claim-id probe stays error-trimmed even when a compartment states the fact", () => {
        const probe = scenario.probes.find((entry) => entry.answerType === "claim-id");
        if (probe === undefined) throw new Error("fixture lacks a claim-id probe");
        // Public claim IDs are recoverable only from `<project-memory>`, not compartment summaries.
        const verdict = compareProbeAnswer({
            probe,
            exchange: {
                ...exchange(probe.id, "mem-lru01", ["loc-cap01"]),
                payloadText:
                    "<new-compartments>\nSessions are cached by the in-process LRU cache.\n</new-compartments>",
                finalRequestPayloadText:
                    "<new-compartments>\nSessions are cached by the in-process LRU cache.\n</new-compartments>",
            },
            scenario,
            injectedClaims: injected,
        });
        expect(verdict.outcome).toBe("error-trimmed");
    });

    test("a trimmed claim absent from every compartment stays error-trimmed", () => {
        const probe = scenario.probes[0];
        // No injected surface states the fact, so the trim causes an injection-budget loss rather than a model-quality failure.
        const verdict = compareProbeAnswer({
            probe,
            exchange: {
                ...exchange(probe.id, "wrong", ["loc-lru01"]),
                payloadText:
 "<new-compartments>\nCache decision: Redis was rejected.\n</new-compartments>",
                finalRequestPayloadText:
 "<new-compartments>\nCache decision: Redis was rejected.\n</new-compartments>",
            },
            scenario,
            injectedClaims: injected,
        });
        expect(verdict.outcome).toBe("error-trimmed");
    });

    test("the fact stated only in the claim surface does not make a trimmed probe answerable", () => {
        const probe = scenario.probes[0];
        // `<project-memory>` contains the trimmed claim; searching it would treat the removed claim as evidence that the trim failed.
        const verdict = compareProbeAnswer({
            probe,
            exchange: {
                ...exchange(probe.id, "wrong", ["loc-lru01"]),
                payloadText:
 "<project-memory>\nmem-cap01: Session cache capacity is 4096 entries.\n</project-memory>",
                // The fixture has one request, so the final request has the same text.
                finalRequestPayloadText:
 "<project-memory>\nmem-cap01: Session cache capacity is 4096 entries.\n</project-memory>",
            },
            scenario,
            injectedClaims: injected,
        });
        expect(verdict.outcome).toBe("error-trimmed");
    });

    test("miss whose gold claim was promoted but not injected is error-trimmed, excluded from rates", () => {
        const probe = scenario.probes[0];
        const verdict = compareProbeAnswer({
            probe,
            exchange: exchange(probe.id, "wrong", ["loc-lru01"]),
            scenario,
            injectedClaims: injected,
        });
        expect(verdict.outcome).toBe("error-trimmed");

        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const record = makeRecord(fixture, scenario);
            const trimmed = fixture.injectedClaims.find((claim) => claim.content.includes("4096"));
            if (trimmed === undefined) throw new Error("fixture lacks the capacity claim");
            record.probes = record.probes.map((probeExchange) =>
                probeExchange.probeId === "probe-capacity"
                    ? withoutInjectedClaim(withAnswer(probeExchange, "wrong"), trimmed)
                    : probeExchange,
            );
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("trimmed-by-injection-budget");
            expect(score.precision).toBeNull();
        } finally {
            fixture.cleanup();
        }
    });
});

describe("buildLaneReport", () => {
    const LANE_SYSTEM = {
        repoCommitSha: "c".repeat(40),
        bunVersion: "test-bun",
        opencodeVersion: "test",
        historianModelId: "scripted-mock",
        probeModelId: "scripted-mock",
        parserImpl: "ts" as const,
        chunkTokenBudget: null,
    };

    function passScore(id: string): ScenarioScore {
        return {
            scenarioId: id,
            verdict: "PASS",
            failReasons: [],
            errorReason: null,
            errorDetail: null,
            precision: 1,
            recall: 1,
            expectedClaimsMatched: 2,
            expectedClaimsTotal: 2,
            visibleClaimsMatched: 2,
            visibleClaimsTotal: 2,
            falseAuthoritativeMatches: [],
            structuralFindings: [],
            probeVerdicts: [],
            // Lane scores come from runs, so the report accepts only scores with both a system and source.
            system: LANE_SYSTEM,
            source: "run-record",
        };
    }

    test("ERRORs are excluded from rates; false-authoritative reported top-level; red per KTD8", () => {
        const fa: ScenarioScore = {
            ...passScore("hse-b"),
            verdict: "FAIL",
            failReasons: ["false-authoritative"],
            falseAuthoritativeMatches: ["abs-x"],
        };
        const errored: ScenarioScore = {
            ...passScore("hse-c"),
            verdict: "ERROR",
            errorReason: "script-drift",
            precision: null,
            recall: null,
            // Aggregating all scenarios rather than scored scenarios would lower these nonzero rates below 1.
            expectedClaimsMatched: 0,
            expectedClaimsTotal: 2,
            visibleClaimsMatched: 0,
            visibleClaimsTotal: 2,
        };
        const report = buildLaneReport([passScore("hse-a"), fa, errored]);
        expect(report.aggregate.scored).toBe(2);
        expect(report.aggregate.errors).toBe(1);
        expect(report.aggregate.precision).toBe(1);
        expect(report.aggregate.recall).toBe(1);
        expect(report.aggregate.errorCountsByReason).toEqual({ "script-drift": 1 });
        expect(report.aggregate.falseAuthoritativeRate).toBe(0.5);
        expect(report.red).toBe(true);
        expect(report.runFatal).toBe(true);
    });

    test("all-PASS report is green and byte-stable for identical inputs", () => {
        const scores = [passScore("hse-b"), passScore("hse-a")];
        const first = buildLaneReport(scores);
        const second = buildLaneReport([...scores]);
        expect(first.red).toBe(false);
        expect(first.runFatal).toBe(false);
        expect(first.scenarios.map((score) => score.scenarioId)).toEqual(["hse-a", "hse-b"]);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    test("a report cannot span two systems, and cannot be labelled with a system the scores contradict", () => {
        const system = {
            repoCommitSha: "a".repeat(40),
            bunVersion: "test-bun",
            opencodeVersion: "test",
            historianModelId: "anthropic/claude-sonnet-4-5",
            probeModelId: "anthropic/claude-sonnet-4-5",
            parserImpl: "ts" as const,
            chunkTokenBudget: 100_000,
        };
        const other = { ...system, repoCommitSha: "b".repeat(40) };

        expect(buildLaneReport([{ ...passScore("hse-a"), system }]).system).toEqual(system);

        // The report refuses seam scores by `source`, not a null `system`, because artifact-integrity errors also omit `system` and remain reportable.
        expect(() => buildLaneReport([{ ...passScore("hse-a"), source: "raw-output" }])).toThrow(
            /raw-output seam/,
        );
        expect(() =>
            buildLaneReport([{ ...passScore("hse-a"), system: null, errorReason: "record-malformed", verdict: "ERROR" }]),
        ).not.toThrow();

        expect(() =>
            buildLaneReport([
                { ...passScore("hse-a"), system },
                { ...passScore("hse-b"), system: other },
            ]),
        ).toThrow(/span more than one system/);

        expect(() => buildLaneReport([{ ...passScore("hse-a"), system }], { system: other })).toThrow(
            /does not match the scored records/,
        );

        // Field order must not matter because deserialized run-record tuples and caller literals use different construction sites.
        const permuted = {
            chunkTokenBudget: system.chunkTokenBudget,
            probeModelId: system.probeModelId,
            parserImpl: system.parserImpl,
            historianModelId: system.historianModelId,
            repoCommitSha: system.repoCommitSha,
            bunVersion: "test-bun",
            opencodeVersion: "test",
        };
        expect(JSON.stringify(permuted)).not.toBe(JSON.stringify(system));
        expect(() => buildLaneReport([{ ...passScore("hse-a"), system: permuted }], { system })).not.toThrow();
    });

    test("an empty score set is refused rather than reported green", () => {
        // An empty list makes `some` false, so the process would exit 0 without evaluating anything.
        expect(() => buildLaneReport([])).toThrow(/empty lane report cannot be green/);
    });

    test("a duplicated scenario score is refused rather than double-weighted", () => {
        expect(() => buildLaneReport([passScore("hse-a"), passScore("hse-b")])).not.toThrow();
        expect(() => buildLaneReport([passScore("hse-a"), passScore("hse-a")])).toThrow(
            /duplicate scenario score\(s\) \[hse-a\]/,
        );
    });

    test("exit-code mapping (KTD8): green 0, red 1, false-authoritative run-fatal 2", () => {
        expect(laneExitCode(buildLaneReport([passScore("hse-a")]))).toBe(0);
        const errored: ScenarioScore = {
            ...passScore("hse-a"),
            verdict: "ERROR",
            errorReason: "run-never-fired",
        };
        expect(laneExitCode(buildLaneReport([errored]))).toBe(1);
        const recallFail: ScenarioScore = { ...passScore("hse-a"), verdict: "FAIL", failReasons: ["recall"] };
        expect(laneExitCode(buildLaneReport([recallFail]))).toBe(1);
        const fatal: ScenarioScore = {
            ...passScore("hse-a"),
            verdict: "FAIL",
            failReasons: ["false-authoritative"],
            falseAuthoritativeMatches: ["abs-x"],
        };
        expect(laneExitCode(buildLaneReport([fatal, passScore("hse-b")]))).toBe(2);
    });
});

describe("scoring database provisioning", () => {
    test("the deserialized scoring connection enforces foreign keys and keeps the busy timeout", () => {
        // Bun serialization preserves database bytes, not connection state, so deserialized handles use SQLite defaults: foreign keys off and no busy timeout.
        // Without these PRAGMAs, scoring can accept foreign-key violations.
        const db = freshScoringDatabase();
        try {
            expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
            expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
        } finally {
            db.close();
        }
    });
});

describe("compareProbeAnswer claim-id availability", () => {
    test("a wrong claim id fails on its merits when the backing claim IS injected", () => {
        const scenario = validScenario();
        const probe = scenario.probes.find((candidate) => candidate.answerType === "claim-id");
        expect(probe).toBeDefined();
        const backing = scenario.gold.expectedClaims.find((claim) => claim.id === probe!.expectedClaimRef);
        expect(backing).toBeDefined();
        const injected: InjectedClaimRecord[] = [
            {
                publicClaimId: "mem-backing",
                revisionLocator: "loc-backing",
                content: `Recorded decision: ${backing!.predicate.value}.`,
                category: backing!.category,
                revision: 1,
            },
        ];
        const exchange: ProbeExchange = {
            probeId: probe!.id,
            answerRaw: "mem-some-other-claim",
            reAsked: false,
            injectedRevisionLocators: ["loc-backing"],
            payloadText: null,
            finalRequestPayloadText: null,
            responseText: "<answer>mem-some-other-claim</answer>",
            discardedResponseTexts: [],
        };
        const verdict = compareProbeAnswer({ probe: probe!, exchange, scenario, injectedClaims: injected });
        // With an injected backing claim, a wrong claim ID must fail rather than report no injected gold claim.
        expect(verdict.outcome).toBe("fail");
        expect(verdict.expected).toBe("mem-backing");

        const unavailable = compareProbeAnswer({
            probe: probe!,
            exchange: { ...exchange, injectedRevisionLocators: [] },
            scenario,
            injectedClaims: injected,
        });
        expect(unavailable.expected).toBe("<no injected gold claim>");
    });
});
