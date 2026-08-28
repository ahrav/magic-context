/**
 * Replay-runner tests (U2). These boot the full TestHarness (`opencode
 * serve` + MockProvider) with a SCRIPTED historian for determinism; the live
 * historian path is exercised by the operator-run prototype (see
 * ../../historian-eval/README.md). TS-mode OpenCode only — they run in the
 * opencode-e2e standalone selection, never under rust or pi modes.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScenario, type HistorianEvalScenario } from "./contract";
import { buildHistorianPayload } from "./payload";
import {
    CONTEXT_DB_SNAPSHOT_FILE,
    extractAnswerEnvelope,
    runScenario,
    type ScriptedHistorianMode,
} from "./runner";
import { scoreRunRecord } from "./scorer";
import { goldFacts, validScenarioRaw } from "./test-support";

const RUN_TIMEOUT_MS = 300_000;

function tempArtifactDir(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "historian-eval-runner-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function singleRunScenario(): HistorianEvalScenario {
    const raw = validScenarioRaw();
    (raw.trigger as Record<string, unknown>).expectedHistorianRuns = 1;
    return parseScenario(raw);
}

/** Scripted historian output covering exactly the requested chunk. */
function coveringOutput(facts = goldFacts()): ScriptedHistorianMode["outputs"][number] {
    return (range) =>
        buildHistorianPayload({
            compartments: [
                {
                    start: range.start,
                    end: range.end,
                    title: "Session cache decision",
                    body: "Chose the in-process LRU cache over Redis; capacity 4096.",
                },
            ],
            facts,
        });
}

/** Probe answers matching validScenario's three probes, in order. */
function goldProbeResponses(): string[] {
    return [
        "<answer>4096</answer>",
        "<answer>in-process lru</answer>",
        // Placeholder: the claim-id probe needs the runtime id, which the
        // scripted probe model cannot know. Tests using this expect a probe
        // FAIL, not a PASS, on the third probe.
        "<answer>mem-unknown</answer>",
    ];
}

describe("extractAnswerEnvelope", () => {
    test("takes envelope contents only, tolerating surrounding prose", () => {
        expect(extractAnswerEnvelope("Sure!\n<answer> 4096 </answer>\nHope that helps.")).toBe("4096");
        expect(extractAnswerEnvelope("no envelope here")).toBeNull();
        expect(extractAnswerEnvelope("<answer>  </answer>")).toBeNull();
        expect(extractAnswerEnvelope(null)).toBeNull();
    });
});

describe("runScenario (scripted historian)", () => {
    test("fresh-environment invariant: a reused artifact directory is refused", async () => {
        const { dir, cleanup } = tempArtifactDir();
        try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "run-record.json"), "{}\n");
            await expect(
                runScenario(singleRunScenario(), {
                    mode: { kind: "scripted", outputs: [] },
                    artifactDir: dir,
                }),
            ).rejects.toThrow(/fresh artifact directory/);
        } finally {
            cleanup();
        }
    });

    test(
        "happy path: scripted valid output publishes; run record carries raw output, telemetry, probes, and DB snapshot",
        async () => {
            const { dir, cleanup } = tempArtifactDir();
            try {
                const scenario = singleRunScenario();
                const record = await runScenario(scenario, {
                    mode: {
                        kind: "scripted",
                        outputs: [coveringOutput()],
                        probeResponses: goldProbeResponses(),
                    },
                    artifactDir: dir,
                });
                expect(record.error).toBeNull();
                expect(record.historianRuns).toHaveLength(1);
                const run = record.historianRuns[0];
                expect(run.status).toBe("success");
                expect(run.repairUsed).toBe(false);
                expect(run.rawOutput ?? "").toContain("<compartments>");
                expect(run.factsEmitted).toBe(2);
                expect(record.verifiedClaimCount).toBeGreaterThanOrEqual(2);
                expect(record.injectedClaims.length).toBeGreaterThanOrEqual(2);
                expect(record.perGoldPredicate.every((entry) => entry.claimCount >= 1)).toBe(true);
                // Stored relative to the record so an archived artifact
                // re-scores wherever it is unpacked.
                expect(record.contextDbSnapshotPath).toBe(CONTEXT_DB_SNAPSHOT_FILE);
                expect(existsSync(join(dir, record.contextDbSnapshotPath))).toBe(true);
                expect(record.probes).toHaveLength(3);

                // The persisted record round-trips.
                const onDisk = JSON.parse(readFileSync(join(dir, "run-record.json"), "utf8"));
                expect(onDisk.scenarioId).toBe(scenario.id);

                // End-to-end: the scorer accepts the record. The claim-id
                // probe answered a placeholder id, so the verdict is
                // FAIL:probe — facts and structure must be clean.
                const score = scoreRunRecord(record, scenario, { recordDir: dir });
                expect(score.recall).toBe(1);
                expect(score.falseAuthoritativeMatches).toEqual([]);
                expect(score.structuralFindings).toEqual([]);
                expect(score.failReasons).toEqual(["probe"]);
            } finally {
                cleanup();
            }
        },
        RUN_TIMEOUT_MS,
    );

    test(
        "repair path: first output invalid, second valid; publish succeeds with repair recorded",
        async () => {
            const { dir, cleanup } = tempArtifactDir();
            try {
                const scenario = singleRunScenario();
                const record = await runScenario(scenario, {
                    mode: {
                        kind: "scripted",
                        outputs: ["this is not a historian payload", coveringOutput()],
                        probeResponses: goldProbeResponses(),
                    },
                    artifactDir: dir,
                });
                expect(record.error).toBeNull();
                expect(record.historianRuns).toHaveLength(1);
                expect(record.historianRuns[0].status).toBe("success");
                expect(record.historianRuns[0].repairUsed).toBe(true);
                expect(record.historianRuns[0].attemptCount).toBeGreaterThanOrEqual(2);
            } finally {
                cleanup();
            }
        },
        RUN_TIMEOUT_MS,
    );

    test(
        "declared historian run that never fires reports ERROR run-never-fired",
        async () => {
            const { dir, cleanup } = tempArtifactDir();
            try {
                const raw = validScenarioRaw();
                (raw.trigger as Record<string, unknown>).expectedHistorianRuns = 1;
                // Pressure numbers that can never fire: a huge context limit
                // keeps the threshold path silent, and near-zero ballast keeps
                // the transcript below the tail-size trigger. The declared run
                // cannot fire.
                (raw.trigger as Record<string, unknown>).modelContextLimit = 10_000_000;
                (raw.trigger as Record<string, unknown>).spikeUsageTokens = 2_000;
                (raw.trigger as Record<string, unknown>).ballastTokensPerTurn = 50;
                const record = await runScenario(parseScenario(raw), {
                    mode: { kind: "scripted", outputs: [coveringOutput()] },
                    artifactDir: dir,
                    historianWaitMs: 20_000,
                });
                expect(record.error?.reason).toBe("run-never-fired");
                expect(record.historianRuns).toEqual([]);
            } finally {
                cleanup();
            }
        },
        RUN_TIMEOUT_MS,
    );

    test(
        "script drift: probe turn without a scripted probe response reports ERROR script-drift",
        async () => {
            const { dir, cleanup } = tempArtifactDir();
            try {
                const record = await runScenario(singleRunScenario(), {
                    mode: { kind: "scripted", outputs: [coveringOutput()], probeResponses: [] },
                    artifactDir: dir,
                });
                expect(record.error?.reason).toBe("script-drift");
            } finally {
                cleanup();
            }
        },
        RUN_TIMEOUT_MS,
    );

    test(
        "exhaustion: every historian attempt invalid yields a scoreable FAIL:invalid-output record",
        async () => {
            const { dir, cleanup } = tempArtifactDir();
            try {
                const scenario = singleRunScenario();
                const record = await runScenario(scenario, {
                    mode: {
                        kind: "scripted",
                        // Initial, repair, and the fallback-chain terminal
                        // attempt all produce unusable output.
                        outputs: ["not a payload", "still not a payload", "never a payload"],
                    },
                    artifactDir: dir,
                });
                expect(record.error).toBeNull();
                expect(record.historianRuns).toHaveLength(1);
                expect(record.historianRuns[0].status).toBe("failed");
                // Only a validation rejection may be charged to historian
                // quality; any other terminal reason is an infra ERROR.
                expect(record.historianRuns[0].failureReason ?? "").toMatch(/^(?:existing-)?validation:/);
                expect(record.probes).toEqual([]);
                const score = scoreRunRecord(record, scenario, { recordDir: dir });
                expect(score.verdict).toBe("FAIL");
                expect(score.failReasons).toEqual(["invalid-output"]);
            } finally {
                cleanup();
            }
        },
        RUN_TIMEOUT_MS,
    );

    test(
        "discard-last healing: run 1 drops its provisional compartment, run 2 re-derives the range",
        async () => {
            const { dir, cleanup } = tempArtifactDir();
            try {
                const raw = validScenarioRaw();
                (raw.trigger as Record<string, unknown>).expectedHistorianRuns = 2;
                (raw as { probes: unknown[] }).probes = [];
                const scenario = parseScenario(raw);
                const record = await runScenario(scenario, {
                    mode: {
                        kind: "scripted",
                        outputs: [
                            // Run 1: two compartments, the second ending flush
                            // with the chunk end (lookahead margin 0), so the
                            // boundary-healing heuristic discards it.
                            (range) => {
                                const mid = Math.floor((range.start + range.end) / 2);
                                return buildHistorianPayload({
                                    compartments: [
                                        { start: range.start, end: mid, title: "First half", body: "first" },
                                        { start: mid + 1, end: range.end, title: "Provisional tail", body: "tail" },
                                    ],
                                    facts: goldFacts(),
                                });
                            },
                            coveringOutput(),
                        ],
                    },
                    artifactDir: dir,
                });
                expect(record.error).toBeNull();
                expect(record.historianRuns).toHaveLength(2);
                expect(record.historianRuns[0].discardedLast).toBe(true);
                expect(record.historianRuns[0].emittedCompartments).toBe(2);
                expect(record.historianRuns[0].persistedCompartments).toBe(1);
                expect(record.historianRuns[1].discardedLast).toBe(false);
                // Run 2 re-derived the discarded range: facts finally promoted.
                expect(record.verifiedClaimCount).toBeGreaterThanOrEqual(2);
            } finally {
                cleanup();
            }
        },
        RUN_TIMEOUT_MS,
    );
});
