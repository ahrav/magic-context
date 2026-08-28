import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../../plugin/src/features/magic-context/compartment-storage";
import { promoteSessionFactsDurable } from "../../../plugin/src/features/magic-context/memory/promotion";
import { readAuthorizedClaimMemorySnapshot } from "../../../plugin/src/features/magic-context/memory/claim-memory-render";
import { createProjectMemoryClaim } from "../../../plugin/src/features/magic-context/memory/storage-claim-operations";
import { ensureProject } from "../../../plugin/src/features/magic-context/memory/storage-claims";
import { createDirectTestDatabase } from "../../../plugin/src/features/magic-context/test-database";
import type { Database } from "../../../plugin/src/shared/sqlite";
import { verifyAllActiveClaims } from "./verification-bridge";
import { RUN_RECORD_SCHEMA, parseScenario, scenarioFingerprint, type HistorianEvalScenario } from "./contract";
import { buildHistorianPayload, type PayloadFact } from "./payload";
import { CONTEXT_DB_SNAPSHOT_FILE } from "./runner";
import type { HistorianEvalRunRecord, HistorianRunArtifact, InjectedClaimRecord, ProbeExchange } from "./runner";
import {
    buildLaneReport,
    classifyTerminalRuns,
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
    /** Stands in for the run record's own directory. */
    dir: string;
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
    facts: PayloadFact[];
    compartments?: Array<{ start: number; end: number }>;
    nowMs?: number;
    /** When set, facts are created with this expiry instead of the promotion path. */
    expiresAt?: number;
    mutate?: (db: Database) => void;
}): SnapshotFixture {
    const dir = mkdtempSync(join(tmpdir(), "historian-eval-scorer-"));
    const dbPath = join(dir, CONTEXT_DB_SNAPSHOT_FILE);
    // The full direct-format schema (claims, claim-memory, session-runtime)
    // stamped exactly like a production bootstrap.
    const { db } = createDirectTestDatabase({ path: dbPath });
    const nowMs = args.nowMs ?? Date.now();
    const compartments = args.compartments ?? [{ start: 1, end: 8 }];
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
    const snapshot = readAuthorizedClaimMemorySnapshot(db, {
        authorizedIdentities: [PROJECT_IDENTITY],
        ownIdentities: [PROJECT_IDENTITY],
        sharedCategories: [],
        workspaceEpoch: "historian-eval:test",
        nowMs,
    });
    const injectedClaims = (snapshot?.items ?? []).map((item) => ({
        publicClaimId: item.publicClaimId,
        revisionLocator: item.revisionLocator,
        content: item.content,
        category: item.category,
        revision: item.revision,
    }));
    return {
        dir,
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
    return {
        runIndex: 1,
        rawOutput: goldenRawOutput(),
        status: "success",
        failureReason: null,
        repairUsed: false,
        attemptCount: 1,
        discardedLast: false,
        lookaheadMargin: 5,
        emittedCompartments: 1,
        persistedCompartments: 1,
        factsEmitted: 2,
        chunkStartOrdinal: 1,
        chunkEndOrdinal: 8,
        ...overrides,
    };
}

function makeRecord(
    fixture: SnapshotFixture,
    scenario: HistorianEvalScenario,
    overrides: Partial<HistorianEvalRunRecord> = {},
): HistorianEvalRunRecord {
    const locators = fixture.injectedClaims.map((claim) => claim.revisionLocator);
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
    return {
        schema: RUN_RECORD_SCHEMA,
        scenarioId: scenario.id,
        scenarioFingerprint: scenarioFingerprint(scenario),
        sessionId: SESSION_ID,
        projectIdentity: PROJECT_IDENTITY,
        nowMs: fixture.nowMs,
        system: {
            repoCommitSha: "test",
            opencodeVersion: "test",
            historianModelId: "scripted-mock",
            probeModelId: "scripted-mock",
            parserImpl: "ts",
            chunkTokenBudget: null,
        },
        expectedHistorianRuns: 1,
        historianRuns: [goldenRun()],
        authoredTurnOrdinals: [
            [1, 2],
            [3, 4],
            [5, 6],
            [7, 8],
        ],
        perGoldPredicate: [],
        injectedClaims: fixture.injectedClaims,
        probes,
        verifiedClaimCount: fixture.injectedClaims.length,
        contextDbSnapshotPath: CONTEXT_DB_SNAPSHOT_FILE,
        error: null,
        ...overrides,
    };
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

    test("raw output failing validation is a stage outcome, not a crash", () => {
        const scenario = validScenario();
        const overlapping = buildHistorianPayload({
            compartments: [
                { start: 1, end: 5, title: "A", body: "a" },
                { start: 4, end: 8, title: "B", body: "b" },
            ],
            facts: goldFacts(),
        });
        const result = scoreRawOutput(overlapping, scenario);
        expect(result.stage).toBe("validation-rejected");
    });
});

describe("scoreRunRecord", () => {
    test("golden run record scores PASS with all probes passing", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const score = scoreRunRecord(makeRecord(fixture, scenario), scenario, { recordDir: fixture.dir });
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
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            // Keep probe answers consistent so only recall fails.
            record.probes = [];
            const score = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
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
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            record.probes = [];
            const score = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
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
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            record.probes = [];
            const score = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
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
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario, {
                historianRuns: [goldenRun({ emittedCompartments: 2, persistedCompartments: 2, lookaheadMargin: 1 })],
            });
            record.probes = [];
            const score = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
            expect(score.failReasons).toContain("structural");
            expect(score.structuralFindings.some((finding) => finding.includes("healing"))).toBe(true);
        } finally {
            fixture.cleanup();
        }
    });

    test("unhealed discard on the final run scores FAIL:structural", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario, {
                historianRuns: [goldenRun(), goldenRun({ runIndex: 2, discardedLast: true })],
            });
            record.probes = [];
            const score = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
            expect(score.failReasons).toContain("structural");
        } finally {
            fixture.cleanup();
        }
    });

    test("refuses a run record paired with a different scenario fingerprint", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            // An archived dev run re-scored after its same-ID scenario was
            // edited: the old snapshot against new gold would otherwise return
            // an apparently valid verdict.
            const editedRaw = validScenarioRaw();
            (editedRaw.gold as { expectedClaims: Array<Record<string, unknown>> }).expectedClaims[0].predicate = {
                kind: "normalized-substring",
                value: "a different architecture decision",
            };
            const edited = parseScenario(editedRaw);
            expect(scenarioFingerprint(edited)).not.toBe(record.scenarioFingerprint);
            expect(() => scoreRunRecord(record, edited, { recordDir: fixture.dir })).toThrow(/fingerprint drift/);
        } finally {
            fixture.cleanup();
        }
    });

    test("refuses a run record from a different scenario id or schema", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        try {
            const scenario = validScenario();
            const wrongId = makeRecord(fixture, scenario, { scenarioId: "hse-some-other-scenario" });
            expect(() => scoreRunRecord(wrongId, scenario, { recordDir: fixture.dir })).toThrow(
                /cannot be scored against scenario/,
            );
            const wrongSchema = makeRecord(fixture, scenario, {
                schema: "historian-eval-run-record/v0" as typeof RUN_RECORD_SCHEMA,
            });
            expect(() => scoreRunRecord(wrongSchema, scenario, { recordDir: fixture.dir })).toThrow(/schema/);
        } finally {
            fixture.cleanup();
        }
    });

    test("scores an archived run record after its directory moves (portable snapshot path)", () => {
        const fixture = makeSnapshot({ facts: goldFacts() });
        const relocated = mkdtempSync(join(tmpdir(), "historian-eval-archive-"));
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            // Take the snapshot the way the runner does (VACUUM INTO yields a
            // complete single-file image), but land it at a directory that
            // never existed on the runner — what an operator gets after
            // downloading the uploaded artifact.
            const moved = join(relocated, record.contextDbSnapshotPath);
            fixture.db.exec(`VACUUM INTO '${moved.replaceAll("'", "''")}'`);
            const score = scoreRunRecord(record, scenario, { recordDir: relocated });
            expect(score.verdict).toBe("PASS");
            expect(score.recall).toBe(1);
        } finally {
            rmSync(relocated, { recursive: true, force: true });
            fixture.cleanup();
        }
    });

    test("infrastructure-caused terminal failures are not charged as invalid-output", () => {
        // Production writes status `failed` for chunk-coverage rejections,
        // no-forward-progress, and publish exceptions as well as validation
        // rejection. Booking an outage as historian quality would violate R6,
        // so only a validation reason may reach FAIL:invalid-output.
        for (const failureReason of [
            "chunk-coverage: chunk 1-8 not covered",
            "no forward progress beyond raw message 7",
            "exception: publish transaction rolled back",
            "stale_snapshot",
            "protected-tail drain quota exhausted",
            null,
        ]) {
            const runs = [
                goldenRun({ status: "failed", failureReason, rawOutput: null }),
                goldenRun({ runIndex: 2, status: "failed", failureReason, rawOutput: null }),
            ];
            const classification = classifyTerminalRuns(runs);
            expect(classification.kind).toBe("infrastructure");
        }
    });

    test("a single infrastructure failure among validation rejections is still infrastructure", () => {
        const classification = classifyTerminalRuns([
            goldenRun({ status: "failed", failureReason: "validation: bad output" }),
            goldenRun({ runIndex: 2, status: "failed", failureReason: "exception: storage unavailable" }),
        ]);
        expect(classification.kind).toBe("infrastructure");
        if (classification.kind !== "infrastructure") return;
        expect(classification.detail).toContain("run 2");
        expect(classification.detail).toContain("storage unavailable");
    });

    test("validation rejections on every attempt classify as exhaustion, in both production spellings", () => {
        for (const failureReason of ["validation: missing tiered paraphrase", "existing-validation: stored drift"]) {
            expect(classifyTerminalRuns([goldenRun({ status: "failed", failureReason })]).kind).toBe(
                "validation-exhausted",
            );
        }
    });

    test("a run set with any usable attempt is not terminal", () => {
        expect(classifyTerminalRuns([]).kind).toBe("not-terminal");
        expect(
            classifyTerminalRuns([
                goldenRun({ status: "failed", failureReason: "validation: bad" }),
                goldenRun({ runIndex: 2, status: "success" }),
            ]).kind,
        ).toBe("not-terminal");
    });

    test("all historian attempts invalid scores FAIL:invalid-output (KTD4)", () => {
        const fixture = makeSnapshot({ facts: [] });
        try {
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ status: "failed", failureReason: "validation failed", rawOutput: "garbage" }),
                    goldenRun({ runIndex: 2, status: "failed", failureReason: "validation failed", rawOutput: "garbage" }),
                ],
            });
            record.probes = [];
            const score = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
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
            const score = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
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
            const scenario = validScenario();
            const record = makeRecord(fixture, scenario);
            record.probes = [];
            const first = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
            const second = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
            expect(first.verdict).toBe("PASS");
            expect(JSON.stringify(second)).toBe(JSON.stringify(first));
            // Boundary twin: the pinned clock is the CAUSE. Advancing the
            // record's own clock past the expiry flips the verdict, so a
            // scorer substituting any other clock cannot satisfy both.
            const advanced = scoreRunRecord({ ...record, nowMs: pinnedNowMs + 120_000 }, scenario, { recordDir: fixture.dir });
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
                    goldenRun({ status: "failed", failureReason: "validation failed" }),
                    goldenRun({ runIndex: 2, status: "failed", failureReason: "validation failed" }),
                ],
            });
            const score = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
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
            const score = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
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
            const score = scoreRunRecord(record, scenario, { recordDir: fixture.dir });
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
