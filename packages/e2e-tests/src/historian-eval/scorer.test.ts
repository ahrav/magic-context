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
import { scenarioFingerprint } from "./contract";
import { buildMockHistorianOutput, type MockHistorianFact } from "../mock-historian";
import type { HistorianEvalRunRecord, HistorianRunArtifact, InjectedClaimRecord, ProbeExchange } from "./runner";
import { RUN_RECORD_SCHEMA, authoredTurnOrdinalsFor } from "./runner";
import {
    buildLaneReport,
    compareProbeAnswer,
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
 * Build a snapshot DB the way the runner's temp environment would end up:
 * compartments persisted, facts promoted through the production promotion
 * path, and the injected set read through the real injection surface.
 */
function makeSnapshot(args: {
    facts: MockHistorianFact[];
    compartments?: Array<{ start: number; end: number }>;
    nowMs?: number;
    /** When set, facts are created with this expiry instead of the promotion path. */
    expiresAt?: number;
    mutate?: (db: Database) => void;
}): SnapshotFixture {
    const dir = mkdtempSync(join(tmpdir(), "historian-eval-scorer-"));
    const dbPath = join(dir, "context-db-snapshot.sqlite");
    const { db } = createDirectTestDatabase({ path: dbPath });
    const nowMs = args.nowMs ?? Date.now();
    // Rendered-space default: validScenario is shorter than the runner's
    // MIN_BUILD_TURNS, so six harness-owned filler turns precede its four
    // authored ones and the authored span is ordinals 13-20. A real run's
    // compartments cover the chunk from ordinal 1, so one compartment spanning
    // the whole rendered transcript is what the contiguity invariant expects;
    // the authored-span scoping is what decides the gold minimum.
    const compartments = args.compartments ?? [{ start: 1, end: 20 }];
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
        ...overrides,
    };
    // A discarding run emitted one more compartment than it persisted, which is
    // how the runner derives the field. Deriving it here keeps every override
    // coherent instead of requiring each call site to remember the pairing.
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
    // Ordered ends, so a run's chunk bound can be normalized against the prefix
    // that existed after IT — the way the runner records the margin — rather than
    // against the session's final maximum.
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
            payloadText: null,
        };
    });
    const record = buildRecord();
    // A real snapshot always carries the `historian_runs` rows the record was
    // derived from, and the scorer now cross-checks the two. Writing them here
    // from the record's own runs keeps the fixture representative; `chunkEndOrdinal`
    // is normalized so each run's `lookaheadMargin` is the margin the snapshot's
    // compartments actually imply, whatever ranges a test supplies.
    fixture.db.prepare("DELETE FROM historian_runs WHERE session_id = ?").run(SESSION_ID);
    const insertRun = fixture.db.prepare(
        `INSERT INTO historian_runs
             (session_id, run_kind, status, failure_reason, chunk_start_ordinal, chunk_end_ordinal,
              compartments_produced, facts_emitted, discarded_last, created_at)
         VALUES (?, 'incremental', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const run of record.historianRuns) {
        insertRun.run(
            SESSION_ID,
            run.status,
            run.failureReason,
            run.chunkStartOrdinal,
            run.chunkEndOrdinal,
            run.persistedCompartments,
            run.factsEmitted,
            run.discardedLast ? 1 : 0,
            fixture.nowMs,
        );
    }
    return record;

    function buildRecord(): HistorianEvalRunRecord {
      const draft = {
        schema: RUN_RECORD_SCHEMA,
        scenarioId: scenario.id,
        scenarioFingerprint: scenarioFingerprint(scenario),
        sessionId: SESSION_ID,
        projectIdentity: PROJECT_IDENTITY,
        nowMs: fixture.nowMs,
        system: {
            repoCommitSha: "test",
            historianModelId: "scripted-mock",
            probeModelId: "scripted-mock",
            parserImpl: "ts",
            chunkTokenBudget: null,
        },
        // Mirror what the runner produces: exactly the declared number of runs,
        // indexed 1..N. `scoreRunRecord` rejects a record whose own inventory
        // disagrees with the scenario, so an under-populated fixture would be
        // testing the integrity gate rather than the verdict under test.
        expectedHistorianRuns: scenario.trigger.expectedHistorianRuns,
        historianRuns: Array.from({ length: scenario.trigger.expectedHistorianRuns }, (_, index) =>
            goldenRun({ runIndex: index + 1 }),
        ),
        // Derived, not hand-written: the scorer validates this against the exact
        // rendered layout, and a literal here was claiming ordinals the runner
        // cannot produce for a scenario this short.
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
 * `validScenario` with no probes, for tests isolating the facts/structural
 * tier from the probe tier. Expressed as a scenario that declares no probes
 * rather than a record whose exchanges were deleted: `scoreRunRecord` rejects
 * the latter as a truncated artifact.
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
        // Separately reported: recall stays perfect even though the run failed.
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
        // The runner prepends filler turns and appends padding, so a real
        // chunk sits well past the authored transcript's ordinal space. The
        // authored-only default must reject that output, and the recorded
        // chunk range must accept it — otherwise a captured
        // HistorianRunArtifact.rawOutput cannot be replayed or mutated.
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
        });
        expect(againstRecordedChunk.stage).toBe("scored");
        if (againstRecordedChunk.stage !== "scored") return;
        expect(againstRecordedChunk.score.verdict).toBe("PASS");
        expect(againstRecordedChunk.score.recall).toBe(1);
    });

    test("a replayed chunk scopes the gold minimum to the authored span, like scoreRunRecord", () => {
        // Two compartments in the replayed runtime chunk, only one of which
        // intersects the authored transcript. Both entry points must agree that
        // gold's minimum of 2 is unmet.
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

    test("a chunk range supplied half-way is a caller error, not a silent authored-space fallback", () => {
        expect(() => scoreRawOutput(goldenRawOutput(), validScenario(), { chunkStartOrdinal: 21 })).toThrow(
            /chunkStartOrdinal and chunkEndOrdinal must be supplied together/,
        );
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
        // Lookahead margin 0 <= healing slack: production discards the tail
        // and skips unanchored promotion for the pass, so no gold fact may
        // score as visible.
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
            // Not visible on the injection read, so no false-authoritative match (R3/KTD1).
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
                { start: 4, end: 8 },
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
        const fixture = makeSnapshot({ facts: goldFacts() });
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
        // Pin the record's clock two minutes into the past and expire the
        // claims one minute later: expired against the real wall clock, live
        // against the pinned clock. A scorer that leaked Date.now() would see
        // an empty visible set and flunk recall.
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
            // Boundary twin: the pinned clock is the CAUSE. Advancing the
            // record's own clock past the expiry flips the verdict, so a
            // scorer substituting any other clock cannot satisfy both.
            const advanced = scoreRunRecord({ ...record, nowMs: pinnedNowMs + 120_000 }, scenario);
            expect(advanced.verdict).toBe("FAIL");
            expect(advanced.failReasons).toEqual(["recall"]);
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
            // Trim the capacity claim out of the injected set and answer its
            // probe wrongly: without FA priority this would be swallowed as
            // trimmed-by-injection-budget ERROR and exit 1 instead of 2.
            const trimmedLocator = fixture.injectedClaims.find((claim) => claim.content.includes("4096"))
                ?.revisionLocator;
            record.probes = record.probes.map((exchange) =>
                exchange.probeId === "probe-capacity"
                    ? {
                          ...exchange,
                          answerRaw: "wrong",
                          injectedRevisionLocators: exchange.injectedRevisionLocators.filter(
                              (locator) => locator !== trimmedLocator,
                          ),
                      }
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
            // Trim the capacity claim out of the probe's injected set and
            // answer wrongly (a trimmed probe), while a different gold claim
            // is missing from the visible set (recall < 1). Recall evidence
            // comes from the facts read, independent of the probe tier, so
            // the trimmed probe must not swallow it into an ERROR.
            const trimmedLocator = fixture.injectedClaims.find((claim) => claim.content.includes("4096"))
                ?.revisionLocator;
            record.probes = record.probes.map((exchange) =>
                exchange.probeId === "probe-capacity"
                    ? {
                          ...exchange,
                          answerRaw: "wrong",
                          injectedRevisionLocators: exchange.injectedRevisionLocators.filter(
                              (locator) => locator !== trimmedLocator,
                          ),
                      }
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
            // The scenario declares two runs; keep only the first, as a
            // hand-copied or interrupted artifact would.
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
            const trimmedLocator = fixture.injectedClaims.find((claim) => claim.content.includes("4096"))
                ?.revisionLocator;
            // probe-capacity is trimmed (its gold claim was promoted but is not
            // in its injected set) while probe-store fails on its own merits and
            // is fully injected. `failReasons` collapses both into one "probe"
            // entry, so a rule keyed on that aggregate converts the whole
            // scenario to ERROR and drops the real failure.
            record.probes = record.probes.map((exchange) => {
                if (exchange.probeId === "probe-capacity") {
                    return {
                        ...exchange,
                        answerRaw: "wrong",
                        injectedRevisionLocators: exchange.injectedRevisionLocators.filter(
                            (locator) => locator !== trimmedLocator,
                        ),
                    };
                }
                if (exchange.probeId === "probe-store") return { ...exchange, answerRaw: "redis" };
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
            // Only exact and multiple-choice probes, whose passing comparisons
            // never consult record.injectedClaims — so an emptied array would
            // otherwise go unnoticed while facts score from the snapshot.
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

    test("an ERROR artifact under an unsupported schema is an integrity error, not its own stale reason", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            const record = makeRecord(fixture, scenario, {
                error: { reason: "script-drift", detail: "2 scripted turns never consumed" },
            });
            // Identity precedes the stored-error passthrough, so a foreign or
            // incompatible artifact cannot enter the report under its own reason.
            const wrongSchema = scoreRunRecord(
                { ...record, schema: "historian-eval-run-record/v0" as typeof RUN_RECORD_SCHEMA },
                scenario,
            );
            expect(wrongSchema.errorReason).toBe("record-schema-unsupported");

            const wrongScenario = scoreRunRecord({ ...record, scenarioId: "hse-other" }, scenario);
            expect(wrongScenario.errorReason).toBe("record-scenario-mismatch");

            // An ERROR record legitimately carries fewer runs than declared, so
            // the inventory check must stay behind the passthrough.
            const aborted = scoreRunRecord({ ...record, historianRuns: [] }, scenario);
            expect(aborted.errorReason).toBe("script-drift");
        } finally {
            fixture.cleanup();
        }
    });

    test("a stored record carrying a run that never evaluated the historian is ERROR", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            // The runner rejects these while driving, but an independently
            // stored record never passes through those guards, and the run keeps
            // its expected index so the inventory check sees nothing wrong.
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
            // Backed by evidence: still FAIL:invalid-output.
            expect(scoreRunRecord(record, scenario).failReasons).toEqual(["invalid-output"]);

            // Snapshot gone: the claim about model quality has nothing behind it.
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

    test("a probe whose gold range is uncovered in the snapshot is ERROR, not a scored answer", () => {
        // minCount is satisfied by the filler compartment, but the authored
        // range 13-20 is not covered, so the splice cannot have removed the raw
        // gold history the probe is supposed to be blind to.
        const fixture = makeSnapshot({ facts: goldFacts(), compartments: [{ start: 1, end: 12 }] });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("probe-gold-uncovered");
        } finally {
            fixture.cleanup();
        }
    });

    test("a two-run artifact whose later run persists a further compartment is not a mismatch", () => {
        // Run 1's margin was recorded against the compartments that existed then
        // (prefix max 12); run 2's against the full set (max 20). Reconstructing
        // both from the snapshot's FINAL maximum makes run 1's expected margin
        // -8 and rejects a valid artifact.
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

            // Flip the discard flag off, as a hand-edited artifact would, to
            // suppress the unhealed-discard finding. The snapshot still holds the
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
            // An undeclared pass — one that fired during the probe phase, after
            // the inventory was assembled — leaves a row the record cannot name.
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
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = probeFreeScenario();
            // Run 1 took the forbidden forced-keep path and PERSISTED that
            // boundary, so unlike a discard there is nothing for run 2 to
            // re-derive; a final-run-only check would report nothing.
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ emittedCompartments: 2, persistedCompartments: 2, lookaheadMargin: 1 }),
                    goldenRun({ runIndex: 2, status: "success" }),
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
            // Each of these would otherwise widen or disable the authored-span
            // scoping that decides which compartments count toward gold.
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
            // Probe resolution runs matchesGold over the RECORDED claims, so
            // repointing one at a gold claim's content/category forges an
            // acceptable claim-id answer while recall stays complete.
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
        // Gold requires one compartment; the session carries two, but only the
        // filler/padding one exists outside the authored ordinal span.
        const fixture = makeSnapshot({
            facts: goldFacts(),
            // Ordinals 1-12 are the harness-owned filler turns; 13-20 are the
            // authored transcript. Only the second compartment is authored.
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
        // Same scenario, two attempts: identity and inventory checks pass, but
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
            // Run 1 published while dropping its provisional tail; run 2 then
            // failed, so the dropped range was never re-derived. The final row
            // reports no discard of its own, and the record is not
            // all-attempts-invalid, so only a per-run check catches it.
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
            record.probes = record.probes.map((probeExchange) =>
                probeExchange.probeId === "probe-capacity"
                    ? {
                          ...probeExchange,
                          answerRaw: "wrong",
                          injectedRevisionLocators: probeExchange.injectedRevisionLocators.filter(
                              (locator) =>
                                  locator !==
                                  fixture.injectedClaims.find((claim) => claim.content.includes("4096"))
                                      ?.revisionLocator,
                          ),
                      }
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
            system: null,
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
            // Non-zero counters: if the aggregation summed over ALL
            // scenarios instead of scored ones, these would drag the rates
            // below 1 and the assertions below would catch it.
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
            historianModelId: "anthropic/claude-sonnet-4-5",
            probeModelId: "anthropic/claude-sonnet-4-5",
            parserImpl: "ts" as const,
            chunkTokenBudget: 100_000,
        };
        const other = { ...system, repoCommitSha: "b".repeat(40) };

        // Derived from the scores, not from the caller's label.
        expect(buildLaneReport([{ ...passScore("hse-a"), system }]).system).toEqual(system);

        expect(() =>
            buildLaneReport([
                { ...passScore("hse-a"), system },
                { ...passScore("hse-b"), system: other },
            ]),
        ).toThrow(/span more than one system/);

        expect(() => buildLaneReport([{ ...passScore("hse-a"), system }], { system: other })).toThrow(
            /does not match the scored records/,
        );

        // A score with no run record behind it constrains nothing.
        expect(buildLaneReport([passScore("hse-a")], { system }).system).toEqual(system);

        // Field order must not matter: a deserialized run-record tuple and a
        // caller literal never share a construction site.
        const permuted = {
            chunkTokenBudget: system.chunkTokenBudget,
            probeModelId: system.probeModelId,
            parserImpl: system.parserImpl,
            historianModelId: system.historianModelId,
            repoCommitSha: system.repoCommitSha,
        };
        expect(JSON.stringify(permuted)).not.toBe(JSON.stringify(system));
        expect(() => buildLaneReport([{ ...passScore("hse-a"), system: permuted }], { system })).not.toThrow();
    });

    test("an empty score set is refused rather than reported green", () => {
        // `some` is false on an empty list, so this would otherwise be non-red
        // and exit 0 having evaluated nothing.
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
