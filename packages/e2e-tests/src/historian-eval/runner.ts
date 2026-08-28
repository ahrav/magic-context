/**
 * Historian structural eval lane — replay runner (U2).
 *
 * Drives one scenario end-to-end through the REAL historian path: the e2e
 * harness boots `opencode serve`, the MockProvider scripts every main-agent
 * turn of the authored transcript, and the historian agent routes either to
 * a live model (operator runs) or to a scripted matcher (deterministic
 * tests). Everything scoring needs is captured into a run record; infra
 * failures are separated from model behavior (R6): they surface as a run
 * record `error`, never as a scored FAIL.
 *
 * Fresh temp environment per attempt (KTD9): each `runScenario` call boots
 * its own harness, and an artifact directory that already holds a run record
 * is refused — retrying in a reused environment would replay stale
 * idempotency receipts and score first-attempt state.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    extractLatestAssistantText,
} from "../../../plugin/src/shared/assistant-message-extractor";
import { extractLatestHistorianReasoning } from "../../../plugin/src/hooks/magic-context/compartment-runner-historian";
import {
    readAuthorizedClaimMemorySnapshot,
} from "../../../plugin/src/features/magic-context/memory/claim-memory-render";
import { hasClaimMemoryFragment } from "../../../plugin/src/features/magic-context/memory/storage-claim-current-state";
import { resolveProjectIdentity } from "../../../plugin/src/features/magic-context/memory/project-identity";
import { createClaimMemorySchema } from "../../../plugin/src/features/magic-context/storage-claim-memory-schema";
import { openTestDb } from "../test-db";
import { TestHarness, type TestHarnessOptions } from "../harness";
import { MockProvider, type MockResponse } from "../mock-provider/server";
import {
    MIN_BUILD_TURNS,
    RUN_RECORD_SCHEMA,
    ballastText,
    laneWorkspaceEpoch,
    predicateMatches,
    scenarioFingerprint,
    type HistorianEvalScenario,
    type Probe,
} from "./contract";
import { deriveProtectedTailTokenTarget } from "../../../plugin/src/hooks/magic-context/protected-tail-boundary";
import {
    deriveHistorianChunkTokens,
    resolveHistorianContextLimit,
} from "../../../plugin/src/hooks/magic-context/derive-budgets";
import { classifyTerminalRuns } from "./scorer";
import { verifyAllActiveClaims } from "./verification-bridge";

export { RUN_RECORD_SCHEMA } from "./contract";

/**
 * File name of the database snapshot inside a run's artifact directory.
 * `contextDbSnapshotPath` stores this relative name, never an absolute one:
 * the archived directory is downloaded to a different machine at a different
 * path, and re-scoring resolves it against wherever the run record now lives.
 */
export const CONTEXT_DB_SNAPSHOT_FILE = "context-db-snapshot.sqlite";

/**
 * Marker-based historian request detection (pattern proven by
 * tests/historian-success.test.ts). The historian's system prompt carries
 * this phrase; its user content carries the `<new_messages>` block.
 */
const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";

/** Threshold the lane pins; also feeds the padding math in paddingTurnCount. */
const EXECUTE_THRESHOLD_PERCENTAGE = 40;

const POISON_TEXT = "HISTORIAN-EVAL-POISON: unscripted main-agent turn reached the default response";

/** Infra causes (R6). None of these may be attributed to historian quality. */
export type RunErrorReason =
    | "lease-lost"
    | "no-op-promotion"
    | "fallback-engaged"
    | "script-drift"
    | "gold-range-leak"
    | "stale-snapshot"
    | "run-never-fired"
    | "probe-envelope-malformed"
    | "probe-gold-uncovered"
    | "historian-infrastructure-failure"
    | "harness-failure";

export interface RunRecordError {
    reason: RunErrorReason;
    detail: string;
}

/** Per historian run: the raw output artifact plus healing evidence (R9). */
export interface HistorianRunArtifact {
    runIndex: number;
    /** Raw output text, extracted exactly as production validated it (KTD5). */
    rawOutput: string | null;
    status: "success" | "failed" | "noop";
    failureReason: string | null;
    repairUsed: boolean;
    attemptCount: number;
    discardedLast: boolean;
    /** chunkEndOrdinal - max persisted compartment end; null when unknowable. */
    lookaheadMargin: number | null;
    emittedCompartments: number;
    persistedCompartments: number;
    factsEmitted: number;
    chunkStartOrdinal: number | null;
    chunkEndOrdinal: number | null;
}

export interface InjectedClaimRecord {
    publicClaimId: string;
    revisionLocator: string;
    content: string;
    category: string;
    revision: number;
}

export interface ProbeExchange {
    probeId: string;
    /** Envelope contents of the final answer attempt; null when malformed twice. */
    answerRaw: string | null;
    reAsked: boolean;
    /** revisionLocators recorded as injected for the probe turn. */
    injectedRevisionLocators: string[];
    /** Captured probe-turn request payload (mock-captured; null on live routes). */
    payloadText: string | null;
}

export interface SystemVersionTuple {
    repoCommitSha: string;
    /**
     * Resolved OpenCode release the harness ran against. The installer serves
     * whatever is current, so two otherwise identical scheduled runs can sit
     * on different harness runtimes; without this field they would record the
     * same system identity and appear longitudinally comparable when they are
     * not. "unknown" when the version cannot be resolved.
     */
    opencodeVersion: string;
    historianModelId: string;
    probeModelId: string;
    parserImpl: "ts";
    chunkTokenBudget: number | null;
}

export interface PerGoldPredicateCount {
    expectedClaimId: string;
    claimCount: number;
    revisionCount: number;
}

export interface HistorianEvalRunRecord {
    schema: typeof RUN_RECORD_SCHEMA;
    scenarioId: string;
    scenarioFingerprint: string;
    sessionId: string;
    /** Workspace identity claims were promoted under; scoring reads need it. */
    projectIdentity: string;
    /** Wall clock pinned at capture time; every scorer read threads this (KTD1). */
    nowMs: number;
    system: SystemVersionTuple;
    expectedHistorianRuns: number;
    historianRuns: HistorianRunArtifact[];
    /** Ordinal of each authored turn's [user, assistant] message. */
    authoredTurnOrdinals: Array<[number, number]>;
    perGoldPredicate: PerGoldPredicateCount[];
    injectedClaims: InjectedClaimRecord[];
    probes: ProbeExchange[];
    /** Claims verified by the lane-owned verification bridge (0 in ERROR records). */
    verifiedClaimCount: number;
    contextDbSnapshotPath: string;
    error: RunRecordError | null;
}

export interface ScriptedHistorianMode {
    kind: "scripted";
    /**
     * Responses served to successive historian requests (initial, repair,
     * second run...). A function entry receives the ordinal range parsed from
     * the request's `<new_messages>` block so scripts can cover whatever
     * chunk the plugin actually built.
     */
    outputs: Array<string | ((range: { start: number; end: number }) => string)>;
    /** Scripted probe-answer responses, consumed one per probe attempt. */
    probeResponses?: string[];
}

export interface LiveHistorianMode {
    kind: "live";
    apiKey: string;
    /**
     * User-tier historian route, e.g. "anthropic/claude-sonnet-4-5".
     * Well-known providers resolve from OpenCode's built-in registry with
     * the key supplied via `extraEnv`.
     */
    historianModel: string;
    probeModel: { providerID: string; modelID: string };
}

export interface RunScenarioOptions {
    mode: ScriptedHistorianMode | LiveHistorianMode;
    /** Directory the run record and DB snapshot are written into. */
    artifactDir: string;
    repoCommitSha?: string;
    /** Resolved `opencode --version`; recorded in the system tuple. */
    opencodeVersion?: string;
    /** Per-run historian completion wait; defaults are mode-aware. */
    historianWaitMs?: number;
}

/** Historian completion wait when the historian model is scripted (mocked). */
const SCRIPTED_HISTORIAN_WAIT_MS = 90_000;
/**
 * Live historian passes make up to three sequential real model calls over a
 * ~32K-token chunk plus inter-attempt backoff. A scripted-sized wait aborts
 * as `run-never-fired` after the API tokens are already spent, so the live
 * default budgets for the full retry ladder.
 */
const LIVE_HISTORIAN_WAIT_MS = 600_000;

class RunAbort extends Error {
    constructor(
        readonly reason: RunErrorReason,
        readonly detail: string,
    ) {
        super(`${reason}: ${detail}`);
    }
}

/**
 * A historian request is identified by its SYSTEM prompt, never by its user
 * content. The `<new_messages>` block is only a fallback for a request that
 * carries no inspectable system prompt: a prompt-injection scenario may
 * legitimately put the literal `<new_messages>` in an authored user turn to
 * mimic the historian protocol, and treating that as a historian request
 * would feed a historian output back as the main-agent reply, misaligning
 * every later turn and reporting harness drift instead of scoring the
 * scenario.
 */
function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        return system.some(
            (block) =>
                typeof (block as { text?: unknown })?.text === "string" &&
                ((block as { text: string }).text ?? "").includes(HISTORIAN_SYSTEM_MARKER),
        );
    }
    return JSON.stringify(body.messages ?? "").includes("<new_messages>");
}

/**
 * OpenCode fires an auxiliary title-generation request per session. It is
 * not part of the transcript script, so the matcher answers it benignly
 * instead of letting it consume a scripted turn or hit the poison default.
 */
function isTitleRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    const text = typeof system === "string" ? system : JSON.stringify(system ?? "");
    return text.includes("title generator");
}

/**
 * Concatenated plain text of every user message in an Anthropic-shaped
 * request body. Turn matching CONTAINS-matches against this: the plugin's
 * injection pass can prepend blocks to or splice user messages, so neither
 * "last user message" nor an exact-equality match survives contact with the
 * real request shape.
 */
function allUserText(body: Record<string, unknown>): string {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const chunks: string[] = [];
    for (const raw of messages) {
        const message = raw as { role?: unknown; content?: unknown };
        if (message?.role !== "user") continue;
        if (typeof message.content === "string") {
            chunks.push(message.content);
        } else if (Array.isArray(message.content)) {
            for (const block of message.content) {
                const text = (block as { type?: unknown; text?: unknown })?.text;
                if ((block as { type?: unknown })?.type === "text" && typeof text === "string") {
                    chunks.push(text);
                }
            }
        }
    }
    return chunks.join("\n");
}

/** Ordinal range the historian request covers, parsed from `<new_messages>`. */
function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const text = JSON.stringify(body.messages ?? "");
    if (!text.includes("<new_messages>")) return null;
    const ordinals = [...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    if (ordinals.length === 0) return null;
    return { start: Math.min(...ordinals), end: Math.max(...ordinals) };
}

function buildProbePrompt(probe: Probe): string {
    const shared =
        "Answer strictly from the project memory and session history already available to you in this conversation. " +
        "Reply with the answer inside an <answer></answer> envelope. Put nothing else inside the envelope.";
    if (probe.answerType === "exact") {
        return `${shared}\nQuestion: ${probe.question}\nAnswer with the exact value only.`;
    }
    if (probe.answerType === "multiple-choice") {
        return `${shared}\nQuestion: ${probe.question}\nChoose exactly one of: ${probe.choices.join(" | ")}.`;
    }
    return `${shared}\nQuestion: ${probe.question}\nAnswer with the id of the single project-memory claim (the identifier before the colon in the project-memory block) that records it.`;
}

export function extractAnswerEnvelope(text: string | null): string | null {
    if (text === null) return null;
    const match = /<answer>([\s\S]*?)<\/answer>/.exec(text);
    if (!match) return null;
    const answer = match[1].trim();
    return answer.length > 0 ? answer : null;
}

class ScenarioRunner {
    private harness: TestHarness | null = null;
    private embedMock: MockProvider | null = null;
    private historianMarkerMockHits = 0;
    private capturedChildIds = new Set<string>();
    private probeResponseQueue: string[] = [];
    private turnScripts: Array<{ prompt: string; response: MockResponse; hits: number }> = [];
    private historianScriptExhausted = false;
    // Partial evidence accumulated as the scenario progresses, so an ERROR
    // record still carries whatever the run produced before the abort (R6).
    private collectedRuns: HistorianRunArtifact[] = [];
    private collectedProbes: ProbeExchange[] = [];
    private sessionId = "";

    constructor(
        private readonly scenario: HistorianEvalScenario,
        private readonly options: RunScenarioOptions,
    ) {}

    async run(): Promise<HistorianEvalRunRecord> {
        const recordPath = join(this.options.artifactDir, "run-record.json");
        if (existsSync(recordPath)) {
            // Fresh-environment invariant (KTD9): a reused attempt directory
            // means a reused environment; refuse rather than replay receipts.
            throw new Error(
                `historian-eval: run record already exists at ${recordPath}; each attempt needs a fresh artifact directory`,
            );
        }
        mkdirSync(this.options.artifactDir, { recursive: true });

        let record: HistorianEvalRunRecord;
        try {
            record = await this.execute();
        } catch (error) {
            if (error instanceof RunAbort) {
                record = this.emptyRecord({ reason: error.reason, detail: error.detail });
            } else {
                record = this.emptyRecord({
                    reason: "harness-failure",
                    detail: error instanceof Error ? error.message : String(error),
                });
            }
        } finally {
            await this.teardown();
        }
        writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
        return record;
    }

    /**
     * The fields every run-record variant shares. Variants override the rest
     * explicitly, so ERROR vs scoreable-exhaustion vs full-record semantics
     * stay visible as diffs from this base (R6/KTD4).
     */
    private baseRecord(): Omit<
        HistorianEvalRunRecord,
        "projectIdentity" | "nowMs" | "perGoldPredicate" | "injectedClaims" | "probes" | "verifiedClaimCount" | "contextDbSnapshotPath" | "error"
    > {
        return {
            schema: RUN_RECORD_SCHEMA,
            scenarioId: this.scenario.id,
            scenarioFingerprint: scenarioFingerprint(this.scenario),
            sessionId: this.sessionId,
            system: this.systemTuple(),
            expectedHistorianRuns: this.scenario.trigger.expectedHistorianRuns,
            historianRuns: this.collectedRuns,
            authoredTurnOrdinals: this.authoredTurnOrdinals(this.fillerCount()),
        };
    }

    private emptyRecord(error: RunRecordError): HistorianEvalRunRecord {
        // Best-effort DB snapshot: an ERROR record with the database beside
        // it is diagnosable without re-running the scenario.
        let snapshotPath = "";
        try {
            if (this.harness !== null && this.harness.hasContextDb()) {
                snapshotPath = this.snapshotContextDb(this.harness);
            }
        } catch {
            snapshotPath = "";
        }
        return {
            ...this.baseRecord(),
            projectIdentity: "",
            nowMs: Date.now(),
            perGoldPredicate: [],
            injectedClaims: [],
            probes: this.collectedProbes,
            verifiedClaimCount: 0,
            contextDbSnapshotPath: snapshotPath,
            error,
        };
    }

    private fillerCount(): number {
        return Math.max(0, MIN_BUILD_TURNS - this.scenario.transcript.turns.length);
    }

    /**
     * The spike turn's scripted usage. Reported in both `input_tokens` and
     * `cache_creation_input_tokens` so the threshold transform sees a real
     * prompt-cache write, the way a live provider reports one.
     */
    private spikeUsage(): { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number } {
        const spike = this.scenario.trigger.spikeUsageTokens;
        return { input_tokens: spike, output_tokens: 40, cache_creation_input_tokens: spike };
    }

    /**
     * Harness-owned padding turns AFTER the authored epilogue (excluded from
     * gold and the fingerprint, R5/KTD3). The protected-tail boundary keeps
     * the newest ~N tokens of raw history away from the historian; without
     * padding, N lands squarely on the authored transcript and no run can
     * ever cover the gold-fact ranges. Sized from the production tail-target
     * math at the scenario's own pressure numbers so recipe and product
     * cannot drift apart.
     */
    private paddingTurnCount(): number {
        const trigger = this.scenario.trigger;
        const target = deriveProtectedTailTokenTarget({
            contextLimit: trigger.modelContextLimit,
            executeThresholdPercentage: EXECUTE_THRESHOLD_PERCENTAGE,
            // The DECLARED spike value, not the prompt total the runtime
            // observes. Production accounts usage as
            // `input + cache.read + cache.write`, and `spikeUsage` reports the
            // spike in both `input_tokens` and `cache_creation_input_tokens`,
            // so the runtime sees roughly twice this percentage. Feeding that
            // observed figure in here collapses the tail target to its floor
            // (13.2K -> 6.4K at the checked-in recipe, four fewer padding
            // turns) and the protected tail then reaches back into the
            // authored transcript, so no run covers the gold ranges and every
            // probe scenario ERRORs as `probe-gold-uncovered`. Matching the
            // runtime tail at >= 80% observed usage requires modelling the
            // force-band caps and `emergencyTailScale` that
            // `deriveProtectedTailTokenTarget` alone does not capture.
            usagePercentage: (trigger.spikeUsageTokens / trigger.modelContextLimit) * 100,
        });
        const tokensPerTurn = Math.max(100, trigger.ballastTokensPerTurn);
        // One extra turn absorbs rounding; the spike turn itself also carries
        // ballast and joins the tail. Capped so degenerate pressure numbers
        // (huge context limits push the tail target to its 96K ceiling)
        // cannot stretch a scenario into hundreds of padding turns.
        return Math.min(32, Math.ceil(target.N / tokensPerTurn) + 1);
    }

    private systemTuple(): SystemVersionTuple {
        const mode = this.options.mode;
        return {
            repoCommitSha: this.options.repoCommitSha ?? "unknown",
            opencodeVersion: this.options.opencodeVersion ?? "unknown",
            historianModelId: mode.kind === "live" ? mode.historianModel : "scripted-mock",
            probeModelId:
                mode.kind === "live" ? `${mode.probeModel.providerID}/${mode.probeModel.modelID}` : "scripted-mock",
            parserImpl: "ts",
            chunkTokenBudget: deriveHistorianChunkTokens(
                resolveHistorianContextLimit(mode.kind === "live" ? mode.historianModel : undefined),
            ),
        };
    }

    private async execute(): Promise<HistorianEvalRunRecord> {
        const harness = await this.boot();
        const sessionId = await harness.createSession();
        this.sessionId = sessionId;
        await this.installClaimMemoryFragment(harness);

        const fillerCount = this.fillerCount();
        await this.driveTranscript(harness, sessionId, fillerCount);

        const runs = this.collectedRuns;
        for (let runIndex = 1; runIndex <= this.scenario.trigger.expectedHistorianRuns; runIndex += 1) {
            runs.push(await this.driveHistorianRun(harness, sessionId, runIndex));
        }
        this.assertNoScriptDrift(harness);

        // A live historian whose every attempt was *rejected by validation* is
        // model behavior, not infrastructure (KTD4): return a scoreable record
        // (the scorer maps it to FAIL:invalid-output). Probes and claim
        // capture are meaningless with nothing published. Production reuses
        // the `failed` status for chunk-coverage, no-progress, and publish
        // exceptions too, so anything that is not validation exhaustion is an
        // infra ERROR (R6) and stays out of the quality rates.
        const terminal = classifyTerminalRuns(runs);
        if (terminal.kind === "infrastructure") {
            throw new RunAbort("historian-infrastructure-failure", terminal.detail);
        }
        if (terminal.kind === "validation-exhausted") {
            return {
                ...this.baseRecord(),
                projectIdentity: resolveProjectIdentity(harness.opencode.env.workdir),
                nowMs: Date.now(),
                perGoldPredicate: [],
                injectedClaims: [],
                probes: [],
                verifiedClaimCount: 0,
                contextDbSnapshotPath: this.snapshotContextDb(harness),
                error: null,
            };
        }
        this.assertPromotionNotSilentlySkipped(harness, sessionId, runs);

        // Lane-owned verification bridge: historian promotions land as
        // CANDIDATE (`model_inference`) and the visibility policy hides them
        // from automatic surfaces until VERIFIED. The lane measures
        // formation, not the orthogonal maturity gate, so it verifies every
        // active claim through the production verification operation before
        // the injection-dependent probe tier runs. See verification-bridge.ts.
        const verifiedClaimCount = this.runVerificationBridge(harness);

        const probes = await this.driveProbes(harness, sessionId);

        // Pin the clock before the authoritative snapshot read so re-scoring
        // is time-independent (KTD1).
        const nowMs = Date.now();
        const { injectedClaims, perGoldPredicate } = this.captureClaimState(harness, nowMs);
        const snapshotPath = this.snapshotContextDb(harness);

        return {
            ...this.baseRecord(),
            projectIdentity: resolveProjectIdentity(harness.opencode.env.workdir),
            nowMs,
            perGoldPredicate,
            injectedClaims,
            probes,
            verifiedClaimCount,
            contextDbSnapshotPath: snapshotPath,
            error: null,
        };
    }

    /**
     * Workaround for the pre-existing HEAD breakage tracked as a P1 bug:
     * TS-mode `openDatabase()` builds legacy-format databases (migrations
     * ceiling v89) that never install the claim-memory fragment, so the
     * production publish transaction's direct-claims promotion throws
     * "no such table" and rolls the whole publish back. The lane installs
     * the fragment with the production schema factory before any historian
     * run; remove once the runtime installs it itself.
     */
    private async installClaimMemoryFragment(harness: TestHarness): Promise<void> {
        await harness.waitFor(() => harness.hasContextDb(), { label: "context.db created" });
        const db = openTestDb(harness.contextDbPath(), { readwrite: true });
        try {
            if (!hasClaimMemoryFragment(db)) {
                db.transaction(() => createClaimMemorySchema(db)).immediate();
            }
        } finally {
            db.close();
        }
    }

    private runVerificationBridge(harness: TestHarness): number {
        const identity = resolveProjectIdentity(harness.opencode.env.workdir);
        const db = openTestDb(harness.contextDbPath(), { readwrite: true });
        try {
            return verifyAllActiveClaims(db, identity, Date.now());
        } finally {
            db.close();
        }
    }

    private async boot(): Promise<TestHarness> {
        const mode = this.options.mode;
        // Dedicated deterministic embedding endpoint (KTD9): fire-and-forget
        // embedding dispatch must never race teardown against a real network.
        this.embedMock = new MockProvider();
        const { baseURL: embeddingEndpoint } = await this.embedMock.start();

        const magicContextConfig: Record<string, unknown> = {
            execute_threshold_percentage: EXECUTE_THRESHOLD_PERCENTAGE,
            keep_subagents: true,
            historian: {
                two_pass: false,
                disallowed_tools: ["*"],
                fallback_models: [],
                // Always pinned explicitly: an unset historian model lets the
                // agent resolve an ambient default (a real provider on a
                // developer machine), and `historian.model` also gates the
                // memory migration that installs the claim-memory schema —
                // without it, fact promotion throws on a fresh database.
                model: mode.kind === "live" ? mode.historianModel : "mock-anthropic/mock-sonnet",
            },
            embedding: {
                provider: "openai-compatible",
                endpoint: embeddingEndpoint,
                model: "historian-eval-embed",
            },
        };

        const harnessOptions: TestHarnessOptions = {
            magicContextConfig,
            modelContextLimit: this.scenario.trigger.modelContextLimit,
            mockDefault: {
                text: POISON_TEXT,
                usage: { input_tokens: this.scenario.trigger.usageTokensPerTurn, output_tokens: 20 },
            },
            ...(mode.kind === "live"
                ? {
                      extraEnv: { ANTHROPIC_API_KEY: mode.apiKey },
                      hostname: "127.0.0.1" as const,
                  }
                : {}),
        };

        const harness = await TestHarness.create(harnessOptions);
        this.harness = harness;
        this.installMatchers(harness);
        if (mode.kind === "scripted") {
            this.probeResponseQueue = [...(mode.probeResponses ?? [])];
        }
        return harness;
    }

    /**
     * All main-agent scripting is matcher-keyed on the exact prompt the
     * runner sent, never on request order: OpenCode fires auxiliary
     * requests (title generation) that would silently steal queue-ordered
     * responses and misalign every later turn. Aux traffic gets a benign
     * reply; anything unrecognized falls through to the poison default and
     * trips the script-drift ERROR.
     */
    private installMatchers(harness: TestHarness): void {
        const mode = this.options.mode;
        const scripted = mode.kind === "scripted" ? [...mode.outputs] : null;
        harness.mock.addMatcher((body) => {
            if (isHistorianRequest(body)) return this.historianResponse(body, scripted);
            if (isTitleRequest(body)) {
                return { text: "historian-eval scenario session", usage: { input_tokens: 50, output_tokens: 10 } };
            }
            const userText = allUserText(body);
            for (const entry of this.turnScripts) {
                if (entry.hits === 0 && userText.includes(entry.prompt)) {
                    entry.hits += 1;
                    return entry.response;
                }
            }
            return null;
        });
    }

    private historianResponse(
        body: Record<string, unknown>,
        scripted: Array<string | ((range: { start: number; end: number }) => string)> | null,
    ): MockResponse {
        if (scripted === null) {
            // Live mode: a historian request reaching the mock means the
            // production fallback chain terminated at the session model.
            this.historianMarkerMockHits += 1;
            return {
                error: { status: 500, type: "historian_eval_fallback", message: "fallback engaged" },
            };
        }
        const next = scripted.shift();
        if (next === undefined) {
            // An under-scripted historian is harness misconfiguration, not
            // model behavior: without this flag the poison text would fail
            // validation and masquerade as FAIL:invalid-output.
            this.historianScriptExhausted = true;
            return { text: POISON_TEXT, usage: { input_tokens: 100, output_tokens: 10 } };
        }
        const range = findOrdinalRange(body) ?? { start: 1, end: 1 };
        const text = typeof next === "function" ? next(range) : next;
        return {
            text,
            usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500 },
        };
    }

    /** Register the scripted reply for one prompt, then send it. */
    private async scriptedTurn(
        harness: TestHarness,
        sessionId: string,
        prompt: string,
        response: MockResponse,
        promptOptions: { providerID?: string; modelID?: string } = {},
    ): Promise<void> {
        this.turnScripts.push({ prompt, response, hits: 0 });
        await harness.sendPrompt(sessionId, prompt, promptOptions);
    }

    /**
     * Render the transcript: harness-owned filler turns first (excluded from
     * gold and fingerprint), then the authored turns, each user prompt
     * carrying deterministic ballast so the size-based protected-tail
     * boundary sees real content mass (R5/KTD3).
     */
    private async driveTranscript(harness: TestHarness, sessionId: string, fillerCount: number): Promise<void> {
        const usage = {
            input_tokens: this.scenario.trigger.usageTokensPerTurn,
            output_tokens: 40,
            cache_creation_input_tokens: this.scenario.trigger.usageTokensPerTurn,
        };
        for (let index = 0; index < fillerCount; index += 1) {
            await this.scriptedTurn(
                harness,
                sessionId,
                `Routine progress update. ${ballastText(this.scenario.trigger.ballastTokensPerTurn, index)}`,
                { text: "Noted; continuing with routine work.", usage },
            );
        }
        for (const [index, turn] of this.scenario.transcript.turns.entries()) {
            await this.scriptedTurn(
                harness,
                sessionId,
                `${turn.user} ${ballastText(this.scenario.trigger.ballastTokensPerTurn, fillerCount + index)}`,
                { text: turn.assistant, usage },
            );
        }
        // Post-epilogue padding: pushes the protected tail past the authored
        // content so the historian chunk can reach every gold-fact range.
        const paddingBase = fillerCount + this.scenario.transcript.turns.length;
        for (let index = 0; index < this.paddingTurnCount(); index += 1) {
            await this.scriptedTurn(
                harness,
                sessionId,
                `Wrap-up housekeeping note ${index + 1}. ${ballastText(this.scenario.trigger.ballastTokensPerTurn, paddingBase + index)}`,
                { text: "Housekeeping acknowledged.", usage },
            );
        }
    }

    private authoredTurnOrdinals(fillerCount: number): Array<[number, number]> {
        return this.scenario.transcript.turns.map((_, index) => {
            const userOrdinal = (fillerCount + index) * 2 + 1;
            return [userOrdinal, userOrdinal + 1];
        });
    }

    /**
     * Spike + kick pattern from tests/historian-success.test.ts: one turn
     * carries the threshold-crossing usage; the following turn gives the
     * transform a fresh pass to actually start the historian.
     */
    private async driveHistorianRun(
        harness: TestHarness,
        sessionId: string,
        runIndex: number,
    ): Promise<HistorianRunArtifact> {
        const trigger = this.scenario.trigger;
        const invocationsBefore = this.countHistorianInvocations(harness, sessionId);

        await this.scriptedTurn(
            harness,
            sessionId,
            `Continuing. ${ballastText(trigger.ballastTokensPerTurn, 100 + runIndex)}`,
            {
                text: "Acknowledged.",
                usage: this.spikeUsage(),
            },
        );
        await this.scriptedTurn(harness, sessionId, `Please continue with step ${runIndex} of the plan.`, {
            text: "Standing by.",
            usage: { input_tokens: trigger.usageTokensPerTurn, output_tokens: 20 },
        });

        try {
            await harness.waitFor(
                () => this.historianRunRows(harness, sessionId).length >= runIndex && this.historianQuiesced(harness, sessionId),
                {
                    timeoutMs:
                        this.options.historianWaitMs ??
                        (this.options.mode.kind === "live" ? LIVE_HISTORIAN_WAIT_MS : SCRIPTED_HISTORIAN_WAIT_MS),
                    label: `historian run ${runIndex}`,
                },
            );
        } catch {
            throw new RunAbort(
                "run-never-fired",
                `scenario declares ${this.scenario.trigger.expectedHistorianRuns} historian runs; run ${runIndex} never completed`,
            );
        }

        const row = this.historianRunRows(harness, sessionId)[runIndex - 1];
        if (row.status === "failed" && /lease/i.test(row.failure_reason ?? "")) {
            throw new RunAbort("lease-lost", row.failure_reason ?? "lease lost");
        }
        if (this.options.mode.kind === "live" && this.historianMarkerMockHits > 0) {
            throw new RunAbort(
                "fallback-engaged",
                `${this.historianMarkerMockHits} historian-marker request(s) reached the MockProvider during a live run`,
            );
        }

        const rawOutput = await this.captureChildOutput(harness, sessionId);
        if (rawOutput === null && row.status === "success") {
            // A successful publish with no capturable child output means the
            // SDK surface drifted or the child session vanished — evidence
            // loss, never model behavior (R6).
            throw new RunAbort(
                "harness-failure",
                `historian run ${runIndex} published but its child-session output could not be captured`,
            );
        }
        const attemptCount = this.countHistorianInvocations(harness, sessionId) - invocationsBefore;
        const persisted = row.compartments_produced ?? 0;
        const discardedLast = row.discarded_last === 1;
        const maxPersistedEnd = this.maxPersistedCompartmentEnd(harness, sessionId);
        return {
            runIndex,
            rawOutput,
            status: row.status as HistorianRunArtifact["status"],
            failureReason: row.failure_reason ?? null,
            repairUsed: attemptCount > 1,
            attemptCount,
            discardedLast,
            lookaheadMargin:
                row.chunk_end_ordinal !== null && maxPersistedEnd !== null
                    ? row.chunk_end_ordinal - maxPersistedEnd
                    : null,
            emittedCompartments: persisted + (discardedLast ? 1 : 0),
            persistedCompartments: persisted,
            factsEmitted: row.facts_emitted ?? 0,
            chunkStartOrdinal: row.chunk_start_ordinal,
            chunkEndOrdinal: row.chunk_end_ordinal,
        };
    }

    private historianRunRows(
        harness: TestHarness,
        sessionId: string,
    ): Array<{
        status: string;
        failure_reason: string | null;
        chunk_start_ordinal: number | null;
        chunk_end_ordinal: number | null;
        compartments_produced: number | null;
        facts_emitted: number | null;
        discarded_last: number;
    }> {
        if (!harness.hasContextDb()) return [];
        try {
            return harness
                .contextDb()
                .prepare(
                    `SELECT status, failure_reason, chunk_start_ordinal, chunk_end_ordinal,
                            compartments_produced, facts_emitted, discarded_last
                     FROM historian_runs WHERE session_id = ? ORDER BY id ASC`,
                )
                .all(sessionId) as ReturnType<ScenarioRunner["historianRunRows"]>;
        } catch {
            return [];
        }
    }

    private historianQuiesced(harness: TestHarness, sessionId: string): boolean {
        try {
            const row = harness
                .contextDb()
                .prepare("SELECT compartment_in_progress FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { compartment_in_progress: number } | null;
            return row !== null && row.compartment_in_progress === 0;
        } catch {
            return false;
        }
    }

    private countHistorianInvocations(harness: TestHarness, sessionId: string): number {
        if (!harness.hasContextDb()) return 0;
        try {
            const row = harness
                .contextDb()
                .prepare(
                    "SELECT COUNT(*) AS n FROM subagent_invocations WHERE session_id = ? AND subagent = 'historian'",
                )
                .get(sessionId) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    private maxPersistedCompartmentEnd(harness: TestHarness, sessionId: string): number | null {
        try {
            const row = harness
                .contextDb()
                .prepare("SELECT MAX(end_message) AS m FROM compartments WHERE session_id = ?")
                .get(sessionId) as { m: number | null } | null;
            return row?.m ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Read the historian child session immediately after the pass
     * (`keep_subagents: true` keeps it alive) and extract the raw output
     * artifact with production's own extraction, so a reasoning-only payload
     * yields exactly what production validated (KTD5).
     */
    private async captureChildOutput(harness: TestHarness, sessionId: string): Promise<string | null> {
        const childrenRes = await harness.client.session.children({ path: { id: sessionId } });
        const children = Array.isArray(childrenRes.data)
            ? (childrenRes.data as Array<{ id?: string; title?: string; time?: { created?: number } }>)
            : [];
        const candidates = children
            .filter(
                (child) =>
                    typeof child.id === "string" &&
                    (child.title ?? "").includes("magic-context-compartment") &&
                    !this.capturedChildIds.has(child.id),
            )
            .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
        for (const child of candidates) {
            this.capturedChildIds.add(child.id as string);
            const messagesRes = await harness.client.session.messages({ path: { id: child.id as string } });
            const messages = messagesRes.data;
            const text = extractLatestAssistantText(messages) ?? extractLatestHistorianReasoning(messages);
            if (text !== null) return text;
        }
        return null;
    }

    private assertNoScriptDrift(harness: TestHarness): void {
        if (this.historianScriptExhausted) {
            throw new RunAbort("script-drift", "historian request arrived after the scripted output queue was exhausted");
        }
        const unconsumed = this.turnScripts.filter((entry) => entry.hits === 0).length;
        if (unconsumed > 0) {
            throw new RunAbort("script-drift", `${unconsumed} scripted main-agent turn(s) never consumed`);
        }
        const defaultHits = harness.mock.defaultHits();
        if (defaultHits > 0) {
            throw new RunAbort("script-drift", `${defaultHits} request(s) fell through to the poison default response`);
        }
    }

    /**
     * Silent no-op promotion (R6): facts were emitted but no claim ever
     * reached the store. That is a plumbing loss (empty promotion directory,
     * skipped unanchored promotion on every run), not historian quality.
     */
    private assertPromotionNotSilentlySkipped(
        harness: TestHarness,
        sessionId: string,
        runs: HistorianRunArtifact[],
    ): void {
        const totalFacts = runs.reduce((sum, run) => sum + run.factsEmitted, 0);
        if (totalFacts === 0) return;
        try {
            const row = harness
                .contextDb()
                .prepare("SELECT COUNT(*) AS n FROM claims")
                .get() as { n: number } | null;
            if ((row?.n ?? 0) === 0) {
                throw new RunAbort(
                    "no-op-promotion",
                    `${totalFacts} fact(s) emitted across runs but zero claims reached the store`,
                );
            }
        } catch (error) {
            if (error instanceof RunAbort) throw error;
            throw new RunAbort("no-op-promotion", "claims table unreadable after fact-emitting runs");
        }
    }

    /**
     * Hidden probes (KTD6): resume the source session; the production
     * injection splice removes compartment-covered raw messages on the next
     * prompt, so the probe model answers from compartments and claim-backed
     * memories only.
     */
    private async driveProbes(harness: TestHarness, sessionId: string): Promise<ProbeExchange[]> {
        const exchanges = this.collectedProbes;
        for (const probe of this.scenario.probes) {
            exchanges.push(await this.driveProbe(harness, sessionId, probe));
        }
        return exchanges;
    }

    private async driveProbe(harness: TestHarness, sessionId: string, probe: Probe): Promise<ProbeExchange> {
        this.assertProbeGoldCovered(harness, sessionId, probe);
        const requestCountBefore = harness.mock.requests().length;

        let answerRaw = await this.askProbe(harness, sessionId, buildProbePrompt(probe));
        let reAsked = false;
        if (answerRaw === null) {
            reAsked = true;
            answerRaw = await this.askProbe(
                harness,
                sessionId,
                `Your previous reply had no valid <answer></answer> envelope. ${buildProbePrompt(probe)}`,
            );
            if (answerRaw === null) {
                throw new RunAbort("probe-envelope-malformed", `probe ${probe.id} answered without a valid envelope twice`);
            }
        }

        const payloadText = this.capturedProbePayload(harness, requestCountBefore);
        this.assertNoGoldRangeLeak(probe, payloadText);
        return {
            probeId: probe.id,
            answerRaw,
            reAsked,
            injectedRevisionLocators: this.visibleRevisionLocators(harness, sessionId),
            payloadText,
        };
    }

    private async askProbe(harness: TestHarness, sessionId: string, prompt: string): Promise<string | null> {
        const mode = this.options.mode;
        if (mode.kind === "scripted") {
            const next = this.probeResponseQueue.shift();
            if (next === undefined) {
                throw new RunAbort("script-drift", "probe turn had no scripted probe response left");
            }
            await this.scriptedTurn(harness, sessionId, prompt, {
                text: next,
                usage: { input_tokens: 200, output_tokens: 40 },
            });
        } else {
            await harness.sendPrompt(sessionId, prompt, {
                providerID: mode.probeModel.providerID,
                modelID: mode.probeModel.modelID,
            });
        }
        const messagesRes = await harness.client.session.messages({ path: { id: sessionId } });
        return extractAnswerEnvelope(extractLatestAssistantText(messagesRes.data));
    }

    /** Gold claims a probe's leakage/coverage gates must protect (KTD6). */
    private probeGoldClaims(probe: Probe): typeof this.scenario.gold.expectedClaims {
        return probe.answerType === "claim-id"
            ? this.scenario.gold.expectedClaims.filter((claim) => claim.id === probe.expectedClaimRef)
            : this.scenario.gold.expectedClaims;
    }

    /**
     * Leakage-gate precondition (KTD6), scoped to what injection can
     * promise: each probe-relevant gold-fact ordinal range must be covered
     * by published compartment rows, or the splice cannot have removed its
     * raw messages. Uncovered gold range → ERROR, never a scored FAIL.
     */
    private assertProbeGoldCovered(harness: TestHarness, sessionId: string, probe: Probe): void {
        const compartments = harness
            .contextDb()
            .prepare("SELECT start_message AS start, end_message AS end FROM compartments WHERE session_id = ?")
            .all(sessionId) as Array<{ start: number; end: number }>;
        const ordinals = this.authoredTurnOrdinals(this.fillerCount());
        const covered = (range: [number, number]): boolean => {
            // Union coverage: adjacent compartments legitimately tile a
            // multi-turn gold range, so requiring one containing compartment
            // would misclassify valid output as uncovered.
            for (let ordinal = range[0]; ordinal <= range[1]; ordinal += 1) {
                if (!compartments.some((c) => c.start <= ordinal && c.end >= ordinal)) return false;
            }
            return true;
        };
        for (const claim of this.probeGoldClaims(probe)) {
            const [startTurn, endTurn] = claim.sourceTurnRange;
            const range: [number, number] = [ordinals[startTurn][0], ordinals[endTurn][1]];
            if (!covered(range)) {
                throw new RunAbort(
                    "probe-gold-uncovered",
                    `probe ${probe.id}: gold claim ${claim.id} ordinal range ${range[0]}-${range[1]} not covered by the published compartments`,
                );
            }
        }
    }

    /**
     * Plain text of every message (user AND assistant) across every request
     * captured during the probe turn's window, decoded from structured
     * content blocks so JSON escaping cannot hide a leak. Mock-captured, so
     * scripted mode only; live probe routes go to the live provider (the
     * compartment-coverage precondition still enforces the gate there).
     */
    private capturedProbePayload(harness: TestHarness, requestCountBefore: number): string | null {
        if (this.options.mode.kind === "live") return null;
        const probeRequests = harness.mock.requests().slice(requestCountBefore);
        if (probeRequests.length === 0) return null;
        const chunks: string[] = [];
        for (const request of probeRequests) {
            const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
            for (const raw of messages) {
                const message = raw as { content?: unknown };
                if (typeof message?.content === "string") {
                    chunks.push(message.content);
                } else if (Array.isArray(message?.content)) {
                    for (const block of message.content) {
                        const text = (block as { text?: unknown })?.text;
                        if (typeof text === "string") chunks.push(text);
                    }
                }
            }
        }
        return chunks.join("\n");
    }

    /**
     * Gold-fact-bearing raw ranges must not survive in the probe payload.
     * The gate is scoped to gold ranges: an uncovered non-gold tail (the
     * epilogue and harness-owned kick turns) is allowed to remain raw.
     */
    private assertNoGoldRangeLeak(probe: Probe, payloadText: string | null): void {
        if (payloadText === null) return;
        for (const claim of this.probeGoldClaims(probe)) {
            for (let turn = claim.sourceTurnRange[0]; turn <= claim.sourceTurnRange[1]; turn += 1) {
                const authored = this.scenario.transcript.turns[turn];
                for (const raw of [authored.user, authored.assistant]) {
                    if (payloadText.includes(raw)) {
                        throw new RunAbort(
                            "gold-range-leak",
                            `probe ${probe.id}: raw transcript text of gold turn ${turn} survived in the probe payload`,
                        );
                    }
                }
            }
        }
    }


    private visibleRevisionLocators(harness: TestHarness, sessionId: string): string[] {
        try {
            const row = harness
                .contextDb()
                .prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { memory_block_ids: string | null } | null;
            if (!row?.memory_block_ids) return [];
            const parsed = JSON.parse(row.memory_block_ids);
            return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
        } catch {
            return [];
        }
    }

    /**
     * The authoritative claim read: the literal injection surface
     * (`auto_inject`, active lifecycle, stale retry) with the pinned clock
     * (KTD1). A snapshot still stale after the built-in retry is ERROR.
     */
    private captureClaimState(
        harness: TestHarness,
        nowMs: number,
    ): { injectedClaims: InjectedClaimRecord[]; perGoldPredicate: PerGoldPredicateCount[] } {
        const identity = resolveProjectIdentity(harness.opencode.env.workdir);
        const db = openTestDb(harness.contextDbPath(), { readonly: true });
        try {
            const snapshot = readAuthorizedClaimMemorySnapshot(db, {
                authorizedIdentities: [identity],
                ownIdentities: [identity],
                sharedCategories: [],
                workspaceEpoch: laneWorkspaceEpoch(this.scenario.id),
                nowMs,
            });
            if (snapshot === null) {
                throw new RunAbort("stale-snapshot", "claim snapshot remained stale after the injection read's retry");
            }
            const injectedClaims = snapshot.items.map((item) => ({
                publicClaimId: item.publicClaimId,
                revisionLocator: item.revisionLocator,
                content: item.content,
                category: item.category,
                revision: item.revision,
            }));
            const perGoldPredicate = this.scenario.gold.expectedClaims.map((claim) => {
                const matching = snapshot.items.filter((item) => predicateMatches(claim.predicate, item.content));
                return {
                    expectedClaimId: claim.id,
                    claimCount: matching.length,
                    revisionCount: matching.reduce((sum, item) => sum + item.revision, 0),
                };
            });
            return { injectedClaims, perGoldPredicate };
        } finally {
            db.close();
        }
    }

    private snapshotContextDb(harness: TestHarness): string {
        const snapshotPath = join(this.options.artifactDir, CONTEXT_DB_SNAPSHOT_FILE);
        // VACUUM INTO produces a complete single-file image regardless of the
        // live database's WAL state; a plain file copy would silently drop
        // committed pages still sitting in `-wal`.
        const db = openTestDb(harness.contextDbPath(), { readwrite: true });
        try {
            db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
        } finally {
            db.close();
        }
        // Relative to the run record beside it, so the archived directory
        // re-scores wherever an operator unpacks it.
        return CONTEXT_DB_SNAPSHOT_FILE;
    }

    /** Teardown never fails the scenario (KTD9). */
    private async teardown(): Promise<void> {
        // Give fire-and-forget embedding dispatch a moment to quiesce against
        // the deterministic endpoint before the temp tree is removed.
        await Bun.sleep(250);
        try {
            // Server logs are run evidence: infra ERRORs are diagnosed from
            // them without re-running the scenario.
            if (this.harness !== null) {
                writeFileSync(join(this.options.artifactDir, "opencode-stderr.log"), this.harness.opencode.stderr());
            }
        } catch {
            // ignore
        }
        try {
            await this.harness?.dispose();
        } catch {
            // Logged failures are tolerated; teardown ordering never fails a scenario.
        }
        try {
            await this.embedMock?.stop();
        } catch {
            // ignore
        }
        this.harness = null;
        this.embedMock = null;
    }
}

export async function runScenario(
    scenario: HistorianEvalScenario,
    options: RunScenarioOptions,
): Promise<HistorianEvalRunRecord> {
    return new ScenarioRunner(scenario, options).run();
}
