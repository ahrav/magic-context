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
    // MIN_BUILD_TURNS, so six harness-owned filler turns precede its four authored
    // ones and the authored span is ordinals 13-20. A real run's compartments
    // cover the chunk from ordinal 1, and the scenario declares two historian
    // runs each persisting one compartment — the scorer requires every compartment
    // row to be attributed to a recorded run, so the count matches the runs.
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
 * Rewrite a probe's answer together with the response it was extracted from.
 *
 * The scorer reproduces the extraction and requires the two to agree, so editing
 * `answerRaw` alone produces a deliberately-forged record — which is a different
 * test than "the model answered wrongly".
 */
function withAnswer(exchange: ProbeExchange, answerRaw: string): ProbeExchange {
    return { ...exchange, answerRaw, responseText: `<answer>${answerRaw}</answer>` };
}

/**
 * Model a claim the injection budget trimmed out of ONE probe turn: drop its
 * locator and the line the captured payload rendered for it.
 *
 * Both, for the same reason `withAnswer` rewrites the response alongside the
 * answer. The plugin writes `memory_block_ids` from exactly the claims it rendered
 * into `<project-memory>`, so a payload that still renders a claim the locator set
 * omits describes no run the runner can produce — and the scorer refuses it as a
 * forged record rather than reading it as a trimmed probe. Editing the locator set
 * alone would therefore test the integrity gate, not trimming.
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
        // Both payloads, since the per-turn evidence check reads the FINAL request while the
        // leak gate reads the window. Trimming only one describes a turn no run produces.
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
        // A promoting run left promotion evidence; the runner records the delta per
        // run so a later run's lost promotion is not masked by an earlier one.
        promotionEvidenceAdded: 2,
        // The output consumed its whole chunk, which is what a healthy run does.
        unprocessedFrom: null,
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
            // A scripted run always captures its probe request, and the scorer
            // reapplies the leak gate to it. Representative content: the prompt
            // the runner sent plus the injected claim block — compartment-derived
            // text, never the raw authored transcript the splice removed.
            payloadText: [
                buildProbePrompt(probe),
                "<project-memory>",
                ...fixture.injectedClaims.map((claim) => `${claim.publicClaimId}: ${claim.content}`),
                "</project-memory>",
            ].join("\n"),
            // The response the answer was extracted from; the scorer reproduces
            // the extraction and requires the two to agree.
            responseText: `<answer>${answerRaw}</answer>`,
            // No re-ask in the golden fixture, so nothing was discarded and the only
            // request IS the final one.
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
    // A real snapshot always carries the `historian_runs` rows the record was
    // derived from, and the scorer now cross-checks the two. Writing them here
    // from the record's own runs keeps the fixture representative; `chunkEndOrdinal`
    // is normalized so each run's `lookaheadMargin` is the margin the snapshot's
    // compartments actually imply, whatever ranges a test supplies.
    fixture.db.prepare("DELETE FROM historian_runs WHERE session_id = ?").run(SESSION_ID);
    // A real snapshot links each run to the subagent invocation that produced it, and the
    // scorer reads `subagent_invocations.status` to tell an attempt that RETURNED malformed
    // text from one that never executed — the distinction production's `validation: ` prefix
    // erases. A fixture with no invocation rows carries no such evidence, so writing them is
    // what makes these records representative rather than merely well-shaped.
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
        // `completed`: the attempt returned text. A validation-failed run in these fixtures
        // models a model that emitted unusable compartments, which is the case the lane scores
        // as FAIL:invalid-output; a provider failure would be `failed` and is not model
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
        // Bound separately from the semantic fingerprint, which excludes trigger
        // pressure; the scorer refuses a record whose recipe is not the scenario's.
        triggerFingerprint: triggerFingerprint(scenario),
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

        // The authored bounds travel with the range: where authored content sits inside
        // a replayed chunk depends on the filler count of the run that captured it, so
        // the scorer refuses to guess. A real replay reads them from the record's
        // `authoredTurnOrdinals`; here the whole chunk is the authored span.
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

    test("an output that stops inside the authored span is not scored", () => {
        const base = validScenario();
        // Gold's minimum is 1 and the early compartment satisfies it; both gold facts are
        // emitted, so recall would be 1. But the output stops before the epilogue turn
        // where the hard negative is authored, so the absence check would pass vacuously —
        // which is a PASS for an artifact never shown the forbidden formation.
        const short = buildMockHistorianOutput({
            compartments: [{ start: 1, end: 4, title: "Prefix", body: "Chose the in-process LRU cache over Redis; capacity 4096." }],
            facts: goldFacts(),
            unprocessedFrom: 5,
        });
        const result = scoreRawOutput(short, base);
        expect(result.stage).toBe("authored-evidence-unprocessed");
    });

    test("an output covering the authored span still scores", () => {
        // The guard must not reject the ordinary case: the golden output covers every
        // authored message, so it is scoreable.
        const result = scoreRawOutput(goldenRawOutput(), validScenario());
        expect(result.stage).toBe("scored");
    });

    test("a chunk range supplied half-way is a caller error, not a silent authored-space fallback", () => {
        expect(() => scoreRawOutput(goldenRawOutput(), validScenario(), { chunkStartOrdinal: 21 })).toThrow(
            /chunkStartOrdinal and chunkEndOrdinal must be supplied together/,
        );
    });

    test("a chunk range without authored bounds is a caller error, not a filler-counting fallback", () => {
        // Without the bounds the gold minimum counted every persisted row, so an output
        // whose compartments sit entirely in harness padding satisfied it here while the
        // same artifact failed `scoreRunRecord`.
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
                // Overlaps the first range, which is the finding under test; extended to 18
                // so the chunk the runs were handed still spans the authored transcript, as
                // a lint-clean recipe's does.
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
        // Three rows, because run 2 persists two: every compartment row must be
        // attributed to a recorded run.
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
            // Run 1 publishes and satisfies the golds; run 2 exhausts validation. The
            // old `every`-based flag was false here, so the scenario reported PASS with
            // nothing in the score naming the declared pass that produced nothing.
            // `recordInventoryError` proves a `failed` run is a validation exhaustion,
            // so it is model evidence (KTD4) whether or not a sibling succeeded.
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
                        // The snapshot implies zero margin (run 1's compartments already
                        // reach the chunk end), and the telemetry cross-check compares the
                        // two — a null here would be refused as a snapshot mismatch before
                        // the verdict under test is reached.
                        lookaheadMargin: 0,
                    }),
                ],
            });
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("FAIL");
            expect(score.failReasons).toContain("invalid-output");
            // Facts still scored: run 1 published, so unlike the all-failed branch the
            // rates are meaningful and must not be nulled.
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
            // Boundary twin: the pinned clock is the CAUSE. Advancing the record's
            // own clock past the expiry changes the outcome, so a scorer
            // substituting any other clock cannot satisfy both halves.
            //
            // The advanced clock now lands on `record-snapshot-mismatch` rather
            // than FAIL:recall, and that is the correct reading: at that clock the
            // recorded injected claims are no longer on the snapshot's injection
            // surface, which for any record the runner produced means the record
            // and its snapshot disagree. Either way the verdict is clock-derived,
            // which is what this asserts.
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
            // Trim the capacity claim out of the injected set and answer its
            // probe wrongly: without FA priority this would be swallowed as
            // trimmed-by-injection-budget ERROR and exit 1 instead of 2.
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
            // Trim the capacity claim out of the probe's injected set and
            // answer wrongly (a trimmed probe), while a different gold claim
            // is missing from the visible set (recall < 1). Recall evidence
            // comes from the facts read, independent of the probe tier, so
            // the trimmed probe must not swallow it into an ERROR.
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
            const trimmed = fixture.injectedClaims.find((claim) => claim.content.includes("4096"));
            if (trimmed === undefined) throw new Error("fixture lacks the capacity claim");
            // probe-capacity is trimmed (its gold claim was promoted but is not
            // in its injected set) while probe-store fails on its own merits and
            // is fully injected. `failReasons` collapses both into one "probe"
            // entry, so a rule keyed on that aggregate converts the whole
            // scenario to ERROR and drops the real failure.
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

    test("an observed false-authoritative promotion survives an aborted run: FAIL run-fatal, not ERROR (R8/KTD8)", () => {
        const fixture = makeSnapshot({
            facts: [...goldFacts(), { category: "ARCHITECTURE", content: "Use Redis for the session cache." }],
        });
        try {
            const scenario = validScenario();
            // The runner captures claim state before the probe tier precisely so a
            // probe abort keeps this evidence. Left to the ordinary stored-error
            // passthrough, the always-run-fatal outcome came back as a
            // `runFatal: false` ERROR and the lane exited 1, so aborting after a
            // forbidden promotion masked it.
            const aborted = makeRecord(fixture, scenario, {
                error: { reason: "probe-response-leak", detail: "probe-capacity leaked a claim id" },
            });
            const score = scoreRunRecord(aborted, scenario);
            expect(score.verdict).toBe("FAIL");
            expect(score.failReasons).toEqual(["false-authoritative"]);
            expect(score.falseAuthoritativeMatches).toEqual(["abs-redis-active"]);
            // The abort is still reported, not replaced: only the verdict changes.
            expect(score.errorReason).toBe("probe-response-leak");
            expect(score.errorDetail).toBe("probe-capacity leaked a claim id");
            // Nothing here measured recall or precision, so the aggregate rates
            // must not move.
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
            // Each of these breaks the record-to-snapshot equality in a different
            // place, and each one used to be scored: the truncated array hid the
            // promotion, the forged entry invented one, and the two edited
            // selectors returned an empty visible set indistinguishable from "no
            // promotion". None of them is a report about the run, so none of them
            // produces a verdict — the completion path returns the same
            // `record-snapshot-mismatch` for the identical forgeries.
            const forged = {
                publicClaimId: "clm-forged",
                revisionLocator: "rev-forged",
                content: "Use Redis for the session cache.",
                category: "ARCHITECTURE",
                revision: 1,
            };
            for (const [label, edited] of [
                ["truncated claim array", { ...aborted, injectedClaims: [] }],
                ["appended forged claim", { ...aborted, injectedClaims: [...aborted.injectedClaims, forged] }],
                ["edited project identity", { ...aborted, projectIdentity: "no-such-project" }],
            ] satisfies Array<[string, HistorianEvalRunRecord]>) {
                const score = scoreRunRecord(edited, scenario);
                expect(score.verdict, label).toBe("ERROR");
                expect(score.errorReason, label).toBe("record-snapshot-mismatch");
                // The abort is still named, so the integrity failure does not erase
                // what the run was doing when it stopped.
                expect(score.errorDetail, label).toContain("probe-response-leak");
                expect(score.failReasons, label).toEqual([]);
            }

            // An edited clock is only a forgery when it MOVES the visible set.
            // These fixtures carry no validity windows, so the read returns the
            // same three claims and the record still agrees with its snapshot —
            // the promotion is genuinely bound to this run and stays run-fatal.
            // Asserted so the mismatch rule is not mistaken for "any edit is an
            // ERROR": it rejects disagreement, not tampering it cannot see.
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
            // Two runs persisting one compartment each cannot explain three rows,
            // and structural scoring plus the coverage gate consume every row.
            const record = makeRecord(fixture, scenario);
            const score = scoreRunRecord(record, scenario);
            expect(score.verdict).toBe("ERROR");
            expect(score.errorReason).toBe("record-snapshot-mismatch");
        } finally {
            fixture.cleanup();
        }
    });

    test("a kept provisional boundary does not excuse an uncovered gold range", () => {
        // Three rows, none reaching the authored span at 13-20, so the gold range
        // is uncovered while every row is attributed to a run.
        const fixture = makeSnapshot({
            facts: goldFacts(),
            compartments: [
                { start: 1, end: 12 },
                { start: 13, end: 16 },
            ],
        });
        try {
            const scenario = validScenario();
            // A KEPT boundary was PERSISTED — hence persistedCompartments 2, not 0 —
            // so its range is covered and it explains no gap, unlike a discard. The
            // coverage gate must still fire.
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ persistedCompartments: 1, emittedCompartments: 1 }),
                    goldenRun({
                        runIndex: 2,
                        persistedCompartments: 1,
                        emittedCompartments: 1,
                        // Inside `HISTORIAN_BOUNDARY_HEALING_SLACK`, which is what makes this
                        // a KEPT provisional boundary; it also puts the chunk end at 18, so
                        // the runs were handed the authored span even though their
                        // compartments stop at 16 and leave the capacity claim uncovered.
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
        // Compartments reach 16, leaving the capacity claim's 17-18 uncovered — which is the
        // premise — while the chunk the runs were handed still spans the authored transcript.
        const fixture = makeSnapshot({ facts: goldFacts(), compartments: [{ start: 1, end: 16 }] });
        try {
            const scenario = validScenario();
            // The final run dropped its provisional tail, which is why the probe's
            // gold range is uncovered. That is a forbidden boundary decision the
            // scorer classifies as a model failure, so the coverage gate must not
            // pre-empt it with an infrastructure ERROR.
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ persistedCompartments: 1, emittedCompartments: 1 }),
                    goldenRun({
                        runIndex: 2,
                        persistedCompartments: 0,
                        emittedCompartments: 1,
                        discardedLast: true,
                        factsEmitted: 0,
                        // Puts this run's chunk end at 18, so the runs were handed the
                        // authored span even though the discard left its tail uncovered.
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
        // Two expectations, unrelated predicates, same category — legal under the
        // contract, since neither predicate contains the other. One formed claim states
        // both, so an independent test per expectation reports 2/2 for a single claim.
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
        // The pairing must not understate: distinct claims for distinct expectations is
        // exactly the case recall is meant to reward.
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
            // Retuned pressure with the declared run count untouched: the context
            // limit decides when the historian fires and what the evaluated chunk
            // contains, but `scenarioFingerprint` excludes it, so nothing else in the
            // record would notice that this artifact predates the change.
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
            // The fact reached the historian's output and never reached the store, so
            // the missing claim is a plumbing loss. The live runner aborts on this;
            // a record scored independently must reach the same verdict rather than
            // charging the loss to historian recall.
            //
            // Charged to the SECOND run: run 1 promoted, so a scenario-wide total is
            // non-zero and only the per-run field exposes the loss.
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
            // `undefined === 0` is false, so an absent field would pass the plumbing
            // guard vacuously — the omission has to be refused at the shape gate.
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
            // The complete final block names the claims the request carried, so a locator
            // beyond it is an over-claim — and not inert: `compareProbeAnswer` would read that
            // claim's gold as injected and suppress `error-trimmed` for a guess, or accept its
            // public id for a claim-id probe. Only the RENDERED line is removed, leaving the
            // locator behind, which is the shape a hand-edited record has.
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
            // Production stamps `validation: ` even when the provider never returned output, so
            // the reason alone cannot say the model was shown the chunk. Marking the linked
            // invocations `failed` is what an outage looks like in the snapshot.
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
            // Only the locator set is edited; the captured payload still renders the
            // claim. That is the shape a hand-edited record has when a wrong answer is
            // laundered into `error-trimmed` — the plugin writes the locator set from
            // exactly the claims it rendered, so no real run produces this pair.
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
            // probe-capacity answers correctly, then volunteers probe-store's gold
            // value outside the envelope. Probe turns are never compartment-covered,
            // so that prose is raw history for probe-store — whose PASS would then
            // be a copy. `answerRaw` still matches the extraction, so the
            // reproducibility check above cannot catch it.
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
            // probe-capacity volunteers the public id that probe-claim's answer resolves
            // to. Probe turns are never compartment-covered, so that id is raw history
            // for probe-claim, whose PASS would then be a copy.
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
            // Same reply, but the claim's locator is absent from probe-claim's injected
            // set, so `compareProbeAnswer` would never credit that id — copying it
            // cannot produce a PASS. Resolving against the whole injected surface
            // instead of that probe's own set turned this valid run into an ERROR.
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
            // The first reply was rejected (two envelopes) and re-asked, so it is not
            // `responseText` — but it was sent, so probe-store still read it. Replaying
            // only the survivor left this record scoring clean.
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
            // Preamble and sign-off around the envelope are ordinary model
            // behaviour; refusing them would convert chattiness into an ERROR.
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
            // A container check alone leaves this to throw on the first field
            // dereference inside the inventory check.
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
            // Only the answer is edited, as a forged record would: the response it
            // was supposedly extracted from still yields the original.
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
            // Existence passes on the reused public id and the entry never appears
            // in `visible`, so neither the existence nor the divergence check sees
            // it — but its fabricated locator could then carry gold-matching
            // content into a probe's locator set.
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
            // The live runner would have aborted this run; a stored artifact
            // never passed through that gate.
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
        // minCount is satisfied by the filler compartment, but the authored
        // range 13-20 is not covered, so the splice cannot have removed the raw
        // gold history the probe is supposed to be blind to.
        const fixture = makeSnapshot({ facts: goldFacts(), compartments: [{ start: 1, end: 16 }] });
        try {
            const scenario = validScenario();
            // One compartment row, so the two declared runs must account for
            // exactly one between them.
            const record = makeRecord(fixture, scenario, {
                historianRuns: [
                    goldenRun({ persistedCompartments: 1, emittedCompartments: 1 }),
                    // `lookaheadMargin` puts the chunk end at 18: the runs were handed the
                    // authored span, and the compartments simply stop short of it.
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
            // Run 1 took the forbidden forced-keep path and PERSISTED that
            // boundary, so unlike a discard there is nothing for run 2 to
            // re-derive; a final-run-only check would report nothing.
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
        // The capacity claim was promoted but is not in this probe's injected set and no
        // compartment states it, so the probe had no surface to recover 4096 from — it
        // guessed. Counting that as a PASS while the same probe answering wrongly is
        // excluded can only bias the tier upward, and a multiple-choice prompt renders
        // every option, so a right guess is a 1-in-N event.
        const verdict = compareProbeAnswer({
            probe,
            exchange: exchange(probe.id, "4096", ["loc-lru01"]),
            scenario,
            injectedClaims: injected,
        });
        expect(verdict.outcome).toBe("error-trimmed");
    });

    test("an injected claim that satisfies the predicate but not the answer is not availability", () => {
        // A predicate is a substring matcher and can be broader than the answer. This
        // claim satisfies "4096"'s expectation only in the sense that it is the same
        // category and matches a broader predicate — it does not state the value, so the
        // probe had nothing to read and a correct answer is a guess.
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
        // The injected block carries the escaped wire form, so a model reading it back can
        // answer `A&amp;B` for an authored gold of `A&B`. Comparing raw marked that correct
        // answer wrong, while the availability check one branch up already decoded the same
        // text — so the two disagreed about what the value is.
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
        // The gate must not swallow an ordinary PASS: the capacity locator IS in this
        // probe's injected set, so the answer rests on injected memory.
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
        // Trimmed from the claim surface but stated in a compartment summary, which the
        // prompt tells the probe it may use — so the answer is recoverable and scores.
        const verdict = compareProbeAnswer({
            probe,
            exchange: {
                ...exchange(probe.id, "4096", ["loc-lru01"]),
                payloadText:
                    "<new-compartments>\nCache decision: capacity set to 4096 entries.\n</new-compartments>",
                // One request in this fixture, so the final request carries the same text.
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
        // The claim budget dropped the capacity claim, but the injected compartment
        // summary states the fact — and the prompt tells the probe it may answer from
        // session history. The probe was answerable, so a wrong answer is the model's
        // miss; `error-trimmed` would take it out of scored metrics.
        const verdict = compareProbeAnswer({
            probe,
            exchange: {
                ...exchange(probe.id, "wrong", ["loc-lru01"]),
                payloadText:
                    "<new-compartments>\nCache decision: capacity set to 4096 entries.\n</new-compartments>",
                // One request in this fixture, so the final request carries the same text.
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
        // A claim-id answer is the runtime public id, which is emitted into
        // `<project-memory>` and nowhere else — a compartment summary is prose about
        // the transcript and cannot carry an id the store assigned at promotion time.
        // So the fact being summarised does not make the id recoverable, and falling
        // through to `fail` would charge the model for a probe with no answer
        // available (`expected` is `<no injected gold claim>`).
        const verdict = compareProbeAnswer({
            probe,
            exchange: {
                ...exchange(probe.id, "mem-lru01", ["loc-cap01"]),
                payloadText:
                    "<new-compartments>\nSessions are cached by the in-process LRU cache.\n</new-compartments>",
                // One request in this fixture, so the final request carries the same text.
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
        // Same trim, but no injected surface carries the fact — the probe genuinely
        // could not answer, which is an injection-budget loss and not model quality.
        const verdict = compareProbeAnswer({
            probe,
            exchange: {
                ...exchange(probe.id, "wrong", ["loc-lru01"]),
                payloadText:
 "<new-compartments>\nCache decision: Redis was rejected.\n</new-compartments>",
                // One request in this fixture, so the final request carries the same text.
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
        // `<project-memory>` is the surface the trim removed the claim FROM. Searching
        // it would read the block's own contents as proof the trim did not happen.
        const verdict = compareProbeAnswer({
            probe,
            exchange: {
                ...exchange(probe.id, "wrong", ["loc-lru01"]),
                payloadText:
 "<project-memory>\nmem-cap01: Session cache capacity is 4096 entries.\n</project-memory>",
                // One request in this fixture, so the final request carries the same text.
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
            // Lane scores come from runs, so they carry a system and declare their
            // source; the report refuses raw-output seam results.
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
            opencodeVersion: "test",
            historianModelId: "anthropic/claude-sonnet-4-5",
            probeModelId: "anthropic/claude-sonnet-4-5",
            parserImpl: "ts" as const,
            chunkTokenBudget: 100_000,
        };
        const other = { ...system, repoCommitSha: "b".repeat(40) };

        // Derived from the scores, not from the caller's label.
        expect(buildLaneReport([{ ...passScore("hse-a"), system }]).system).toEqual(system);

        // A seam score is refused by SOURCE, not by a null system: an
        // artifact-integrity ERROR also carries no system and must stay reportable.
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

        // Field order must not matter: a deserialized run-record tuple and a
        // caller literal never share a construction site.
        const permuted = {
            chunkTokenBudget: system.chunkTokenBudget,
            probeModelId: system.probeModelId,
            parserImpl: system.parserImpl,
            historianModelId: system.historianModelId,
            repoCommitSha: system.repoCommitSha,
            opencodeVersion: "test",
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

describe("scoring database provisioning", () => {
    test("the deserialized scoring connection enforces foreign keys and keeps the busy timeout", () => {
        // Bun serialization carries database BYTES, not connection state, so a
        // deserialized handle comes up with SQLite's defaults: foreign keys off
        // and no busy timeout. Left that way, a scorer write violating a claim
        // relationship would be accepted and scored here while the
        // factory-backed connection and production reject it — a storage
        // regression would score green.
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
        // The property the mutation battery depends on: with a candidate present
        // the verdict is a real comparison against that claim's id, not an
        // availability outcome. An empty injected set instead yields
        // "<no injected gold claim>", which fails for want of any candidate and
        // would stay green under a comparator that accepted the wrong id.
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
