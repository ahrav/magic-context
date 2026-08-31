/**
 *
 * `runScenario` drives an authored transcript through the production historian path.
 * `TestHarness` boots `opencode serve`.
 * `MockProvider` scripts every main-agent turn in the authored transcript.
 * The historian agent uses a live model for operator runs and a scripted matcher for deterministic tests.
 * The runner captures scoring inputs in the run record.
 * Infrastructure failures surface as run-record `error`, never as a scored FAIL.
 *
 * Each `runScenario` call boots its own harness.
 * `runScenario` refuses an artifact directory that already contains a run record.
 * Retrying in a reused environment replays stale idempotency receipts.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    extractLatestAssistantText,
} from "../../../plugin/src/shared/assistant-message-extractor";
import { extractLatestHistorianReasoning } from "../../../plugin/src/hooks/magic-context/compartment-runner-historian";
import { hasClaimMemoryFragment } from "../../../plugin/src/features/magic-context/memory/storage-claim-current-state";
import { resolveProjectIdentity } from "../../../plugin/src/features/magic-context/memory/project-identity";
import { createClaimMemorySchema } from "../../../plugin/src/features/magic-context/storage-claim-memory-schema";
import {
    INTERNAL_OPENCODE_AGENT_SIGNATURES,
    MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES,
} from "../../../plugin/src/hooks/magic-context/internal-agent-signatures";
import { openTestDb } from "../test-db";
import { TestHarness, type TestHarnessOptions } from "../harness";
import { MockProvider, type MockResponse } from "../mock-provider/server";
import {
    EXECUTE_THRESHOLD_PERCENTAGE,
    FILLER_TURN,
    MAX_PADDING_TURNS,
    MIN_BUILD_TURNS,
    PROBE_CHOICE_SEPARATOR,
    PROBE_PROMPT_CHOICE_PREFIX,
    PROBE_PROMPT_CLAIM_ID_SUFFIX,
    PROBE_PROMPT_EXACT_SUFFIX,
    PROBE_PROMPT_QUESTION_LABEL,
    PROBE_PROMPT_REASK_PREFIX,
    PROBE_PROMPT_SHARED,
    containsCompleteValue,
    decodeXmlEntities,
    matchesGold,
    normalizeContent,
    scenarioFingerprint,
    triggerFingerprint,
    triggerTurnUsage,
    type HistorianEvalScenario,
    type Probe,
} from "./contract";
import { ballastProse } from "../ballast";
import { deriveProtectedTailTokenTarget } from "../../../plugin/src/hooks/magic-context/protected-tail-boundary";
import {
    deriveHistorianChunkTokens,
    resolveHistorianContextLimit,
} from "../../../plugin/src/hooks/magic-context/derive-budgets";
import { DEFAULT_HISTORIAN_TIMEOUT_MS } from "../../../plugin/src/config/schema/magic-context";
import { promotionEvidenceCount, readInjectedClaims, type InjectedClaimRecord } from "./claim-read";
import { verifyAllActiveClaims } from "./verification-bridge";

export type { InjectedClaimRecord } from "./claim-read";

/**
 * The scorer rejects run records whose schema identity differs from the required value.
 * Changing the record shape requires a new schema identity.
 * Schema `v3` requires `system.opencodeVersion` and `system.bunVersion`.
 * Changing the record shape without changing its identifier would make one identifier denote incompatible schemas.
 * The scorer classifies records with earlier schema identities as `record-malformed`.
 * it is.
 */
/**
 * Each live historian pass reserves two minutes for non-request work.
 *
 * Two minutes prevents the lane wait from expiring at the plugin timeout.
 * The reserve covers local SQLite writes and the quiescence poll.
 */
const LIVE_HISTORIAN_OVERHEAD_MS = 120_000;

/* */
const PRE_PROBE_SNAPSHOT_FILE = "context-db-snapshot-pre-probe.sqlite";

export const RUN_RECORD_SCHEMA = "historian-eval-run-record/v3";

/**
 * The matcher uses production's exported signature list so prompt rewording fails module loading instead of silently misrouting scenarios.
 */
function requireSignature(signatures: readonly string[], needle: string): string {
    const found = signatures.find((signature) => signature.includes(needle));
    if (found === undefined) {
        throw new Error(`historian-eval: no internal-agent signature contains "${needle}"`);
    }
    return found;
}

/**
 */
const HISTORIAN_SYSTEM_MARKER = requireSignature(MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES, "Historian");

/* */
const TITLE_SYSTEM_MARKER = requireSignature(INTERNAL_OPENCODE_AGENT_SIGNATURES, "title generator");



/**
 * `authoredTurnOrdinals` identifies authored turns in the rendered transcript.
 *
 * Harness-owned filler turns precede authored turns when a scenario has fewer than `MIN_BUILD_TURNS` turns.
 * The scenario alone determines the resulting layout.
 * The scorer validates stored `authoredTurnOrdinals` against this layout.
 * `authoredTurnOrdinals` determines which compartments count toward gold's minimum.
 * `authoredTurnOrdinals` prevents a second derivation from classifying different rows as authored.
 */
export function authoredTurnOrdinalsFor(scenario: HistorianEvalScenario): Array<[number, number]> {
    const fillerCount = Math.max(0, MIN_BUILD_TURNS - scenario.transcript.turns.length);
    return scenario.transcript.turns.map((_, index) => {
        const userOrdinal = (fillerCount + index) * 2 + 1;
        return [userOrdinal, userOrdinal + 1];
    });
}

const POISON_TEXT = "HISTORIAN-EVAL-POISON: unscripted main-agent turn reached the default response";

/** The scorer does not attribute infrastructure failures to historian quality. */
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
    | "probe-response-leak"
    | "probe-tool-use"
    | "harness-failure";

export interface RunRecordError {
    reason: RunErrorReason;
    detail: string;
}

/* */
export interface HistorianRunArtifact {
    runIndex: number;
    /* */
    rawOutput: string | null;
    status: "success" | "failed" | "noop";
    failureReason: string | null;
    repairUsed: boolean;
    attemptCount: number;
    discardedLast: boolean;
    /** `chunkEndOrdinal` is the maximum persisted compartment end and is `null` when unknown. */
    lookaheadMargin: number | null;
    emittedCompartments: number;
    persistedCompartments: number;
    factsEmitted: number;
    chunkStartOrdinal: number | null;
    chunkEndOrdinal: number | null;
    /**
     * Each run records claims created and evidence rows attached to existing claims under the scenario's project.
     *
     * Each run records promotion evidence because scenario-wide totals can hide skipped promotions, and repeated facts attach to existing claims.
     */
    promotionEvidenceAdded: number;
    /**
     * `unprocessedFrom` is the first ordinal the historian did not process; it is null when the historian consumes its chunk.
     *
     * `unprocessedFrom` can follow early emitted compartments; therefore chunk coverage does not prove the historian saw the authored transcript, and absence checks exclude the unprocessed suffix.
     */
    unprocessedFrom: number | null;
}

/**
 * `probeResponseLeak` returns a later probe's gold answer found outside the sending response's accepted answer envelope, or null.
 *
 * `extractAnswerEnvelope` accepts exactly one envelope and ignores surrounding text, so prefatory chat does not trigger `probe-envelope-malformed`.
 * Because assistant turns are not compartment-covered, later probes read raw replies, including commentary that states a later probe's answer.
 * `goldRangeLeak` searches authored `TRANSCRIPT` text.
 *
 * A reply cannot influence a probe that was already asked.
 *
 * Replies with two envelopes are rejected and re-asked but remain in session history.
 * Stripping every envelope would exempt rejected envelopes that contain later probes' gold answers.
 * `<answer>x</answer><answer>later-gold</answer>` contains a later gold answer in a rejected envelope.
 *
 * `containsCompleteValue` matches complete values, so mentioning `4096` does not match `4`.
 * answer "4".
 */
export function probeResponseLeak(args: {
    probes: readonly Probe[];
    probeIndex: number;
    responseText: string | null;
}): string | null {
    const { probes, probeIndex, responseText } = args;
    if (responseText === null) return null;
    const own = probes[probeIndex];
    const outside = outsideAcceptedEnvelope(responseText, (content) =>
        own !== undefined &&
        own.answerType !== "claim-id" &&
        // `probeResponseLeak` decodes XML entities before normalizing to match `compareProbeAnswer`.
        // Without decoding, an escaped correct answer could pass `compareProbeAnswer` but remain outside the exempted envelope.
        normalizeContent(decodeXmlEntities(content)) === normalizeContent(decodeXmlEntities(own.goldAnswer)),
    );
    for (const later of probes.slice(probeIndex + 1)) {
        // `probeResponseLeak` skips claim-id answers because their accepted IDs depend on each later probe's injected set, which is unavailable while this probe runs.
        // `probeResponseClaimIdLeak` checks claim-id leaks after every probe's injection evidence is captured.
        if (later.answerType === "claim-id") continue;
        if (containsCompleteValue(outside, later.goldAnswer)) {
            return `response text outside the answer envelope states a later probe's (${later.id}) gold answer`;
        }
    }
    return null;
}

/**
 * A later probe can copy all reply text except an envelope containing the sending probe's correct answer.
 *
 * A correct envelope is exempt so the sending probe can answer its own question.
 * Exempting a wrong reply would let a later probe copy another probe's gold answer.
 * Malformed envelopes remain copyable, so no content in them is exempt.
 *
 * Exact and multiple-choice answers use authored gold; unresolved claim IDs return false so the scan does not exempt their envelopes.
 */
function outsideAcceptedEnvelope(responseText: string, isCorrectAnswer: (content: string) => boolean): string {
    const accepted = extractAnswerEnvelope(responseText);
    if (accepted === null || !isCorrectAnswer(accepted)) return responseText;
    const envelope = /<answer>[\s\S]*?<\/answer>/.exec(responseText);
    return envelope === null ? responseText : responseText.replace(envelope[0], " ");
}

/**
 *
 *
 */
/**
 *
 * Only claims that match the gold and whose locators were injected for the probe can produce PASS.
 */
function acceptedClaimIds(
    scenario: HistorianEvalScenario,
    probe: Probe,
    exchange: ProbeExchange | undefined,
    injectedClaims: readonly InjectedClaimRecord[],
): string[] {
    if (probe.answerType !== "claim-id" || exchange === undefined) return [];
    const goldClaim = scenario.gold.expectedClaims.find((claim) => claim.id === probe.expectedClaimRef);
    if (goldClaim === undefined) return [];
    const injectedForProbe = new Set(exchange.injectedRevisionLocators);
    return injectedClaims
        .filter((item) => matchesGold(goldClaim, item) && injectedForProbe.has(item.revisionLocator))
        .map((item) => item.publicClaimId);
}

export function probeResponseClaimIdLeak(args: {
    scenario: HistorianEvalScenario;
    exchanges: readonly ProbeExchange[];
    injectedClaims: readonly InjectedClaimRecord[];
}): string | null {
    const { scenario, exchanges, injectedClaims } = args;
    const exchangeById = new Map(exchanges.map((exchange) => [exchange.probeId, exchange]));
    for (const [index, earlier] of scenario.probes.entries()) {
        const earlierExchange = exchangeById.get(earlier.id);
        if (earlierExchange === undefined) continue;
        // `probeResponseClaimIdLeak` scans every earlier reply because discarded malformed replies remain in the session.
        const replies = [
            ...earlierExchange.discardedResponseTexts,
            ...(earlierExchange.responseText === null ? [] : [earlierExchange.responseText]),
        ];
        if (replies.length === 0) continue;
        // `probeResponseClaimIdLeak` excludes an earlier probe's correct answer envelopes because self-answers are not leaks.
        // For claim-id probes, `probeResponseClaimIdLeak` exempts only IDs that `acceptedClaimIds` accepts for the earlier probe.
        const ownCorrect = new Set(
            acceptedClaimIds(scenario, earlier, exchangeById.get(earlier.id), injectedClaims).map(normalizeContent),
        );
        if (earlier.answerType !== "claim-id") ownCorrect.add(normalizeContent(earlier.goldAnswer));
        const outside = replies
            .map((reply) => outsideAcceptedEnvelope(reply, (content) => ownCorrect.has(normalizeContent(content))))
            .join("\n");
        for (const later of scenario.probes.slice(index + 1)) {
            if (later.answerType !== "claim-id") continue;
            const laterExchange = exchangeById.get(later.id);
            if (laterExchange === undefined) continue;
            const goldClaim = scenario.gold.expectedClaims.find((claim) => claim.id === later.expectedClaimRef);
            if (goldClaim === undefined) continue;
            const accepted = acceptedClaimIds(scenario, later, laterExchange, injectedClaims);
            if (accepted.some((id) => containsCompleteValue(outside, id))) {
                return `probe ${earlier.id}: response text outside the answer envelope states a claim id accepted for a later probe (${later.id})`;
            }
        }
    }
    return null;
}

/**
 * historian request.
 *
 * Only text not included in a model request makes an absence check vacuous.
 * Text the model saw but did not compartmentalize does not make an absence check vacuous.
 * A validation-exhausted run counts in full because the model received its chunk and produced no output.
 * `noop` run counts for nothing (it made no request at all).
 *
 * `exposedRanges` reports each run's handed chunk, not the ordinals its output consumed.
 * A successful output may declare `<unprocessed_from>` inside its chunk; the artifact records and the snapshot cross-checks its ordinal.
 * `unprocessedFrom` does not identify the first ordinal the output did not read.
 * `exposedRanges` must not infer unread ordinals from `unprocessedFrom`; incorrect truncation converts healthy runs into coverage aborts.
 */
export function exposedRanges(
    runs: readonly HistorianRunArtifact[],
): Array<{ start: number; end: number }> {
    return runs
        .filter((run) => run.status !== "noop" && run.chunkStartOrdinal !== null && run.chunkEndOrdinal !== null)
        .map((run) => ({ start: run.chunkStartOrdinal as number, end: run.chunkEndOrdinal as number }));
}

export interface ProbeExchange {
    probeId: string;
    /** Returns the final answer attempt's envelope contents; returns null after two malformed attempts. */
    answerRaw: string | null;
    reAsked: boolean;
    /* */
    injectedRevisionLocators: string[];
    /** Stores the mock-captured probe-turn request payload; stores null for live routes. */
    payloadText: string | null;
    /**
     * Stores the final request captured for the turn, which produced the accepted answer.
     *
     * `payloadText` includes every request in the probe's window so leak detection sees discarded attempts.
     * Per-turn evidence uses `finalRequestPayloadText` rather than `payloadText`.
     * A re-ask's discarded attempt can render claim or compartment blocks absent from the accepted-answer request.
     * `payloadText` can let stale blocks from a discarded attempt suppress `error-trimmed` on a guessed retry.
     */
    finalRequestPayloadText: string | null;
    /**
     * Stores the assistant text from which the answer was extracted.
     *
     * `answerRaw` alone cannot verify that the stored value came from the model response.
     * `responseText` lets rescoring verify that `answerRaw` came from the model response.
     * Without `responseText`, editing a wrong answer to the gold value can turn a probe failure into a pass without failing integrity checks.
     * `answerRaw` must agree with the answer extracted from `responseText`.
     */
    responseText: string | null;
    /**
     * `discardedResponseTexts` stores replies from attempts whose answers were REJECTED, in send order.
     *
     * `responseText` holds only the reply that produced the answer.
     * Discarded replies remain in the shared session, so later probes can read them.
     * The authored-value scan covers each attempt before deferred claim-id scans run.
     * The claim-id scan runs only after every probe's injection evidence exists.
     * The deferred claim-id scan reads discarded replies from the recorded exchanges.
     */
    discardedResponseTexts: string[];
}

export interface SystemVersionTuple {
    repoCommitSha: string;
    /**
     *
     * Bun builds the plugin bundle and runs the runner; different Bun releases execute different bytes.
     * Scheduled runs pin Bun by commit; direct runs use the `bun` on PATH.
     * Without `bunVersion`, multi-run audits cannot distinguish differing Bun releases.
     * `bunVersion` distinguishes unpinned direct runs.
     * not reach.
     */
    bunVersion: string;
    /**
     * `opencodeVersion` identifies the resolved OpenCode release.
     * The installer can serve different OpenCode releases to otherwise identical scheduled runs.
     * Without `opencodeVersion`, different harness runtimes share the same system identity.
     * `opencodeVersion` is `"unknown"` when the version cannot be resolved.
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
    /**
     * `triggerFingerprint` identifies the trigger recipe executed for this attempt.
     *
     * `triggerFingerprint` remains separate so trigger retunes do not invalidate scenario approvals.
     * `scenarioFingerprint` is the release-facing semantic identity that approvals bind to.
     * Including harness-owned trigger pressure in `scenarioFingerprint` would invalidate approvals on pressure retunes.
     * `triggerFingerprint` binds each artifact to the trigger recipe that produced it.
     * `triggerFingerprint`.
     */
    triggerFingerprint: string;
    sessionId: string;
    /** Scoring reads require the workspace identity under which claims were promoted. */
    projectIdentity: string;
    /** `nowMs` fixes the clock for every scorer read. */
    nowMs: number;
    system: SystemVersionTuple;
    expectedHistorianRuns: number;
    historianRuns: HistorianRunArtifact[];
    /* */
    authoredTurnOrdinals: Array<[number, number]>;
    perGoldPredicate: PerGoldPredicateCount[];
    injectedClaims: InjectedClaimRecord[];
    probes: ProbeExchange[];
    /** ERROR records contain 0 verified claims. */
    verifiedClaimCount: number;
    contextDbSnapshotPath: string;
    error: RunRecordError | null;
}

export interface ScriptedHistorianMode {
    kind: "scripted";
    /**
     * Historian responses are ordered by request: initial, repair, then second run.
     * A function entry receives the ordinal range parsed from the request's `<new_messages>` block.
     * The parsed ordinal range lets scripts cover the chunk the plugin built.
     */
    outputs: Array<string | ((range: { start: number; end: number }) => string)>;
    /** The runner consumes one scripted probe response per probe attempt. */
    probeResponses?: string[];
}

export interface LiveHistorianMode {
    kind: "live";
    apiKey: string;
    /**
     * `historianModel` selects a user-tier historian route, such as "anthropic/claude-sonnet-4-5".
     * Well-known providers resolve from OpenCode's built-in registry.
     * The runner supplies the provider key through `extraEnv`.
     */
    historianModel: string;
    probeModel: { providerID: string; modelID: string };
}

export interface RunScenarioOptions {
    mode: ScriptedHistorianMode | LiveHistorianMode;
    /** The runner writes the run record and DB snapshot to `artifactDir`. */
    artifactDir: string;
    repoCommitSha?: string;
    /** The runner records the resolved `opencode --version` in the system tuple. */
    opencodeVersion?: string;
    /**
     * `historianWaitBudgetMs`.
     */
    historianWaitMs?: number;
}

/**
 *
 *
 * The live budget allows two prompt attempts plus overhead.
 */
function historianWaitBudgetMs(mode: RunScenarioOptions["mode"]): number {
    return mode.kind === "live" ? 2 * DEFAULT_HISTORIAN_TIMEOUT_MS + LIVE_HISTORIAN_OVERHEAD_MS : 90_000;
}

/**
 * The system tuple excludes scenario data.
 *
 *
 */
export function runSystemTuple(
    options: Pick<RunScenarioOptions, "mode"> & { repoCommitSha?: string; opencodeVersion?: string },
): SystemVersionTuple {
    const mode = options.mode;
    return {
        repoCommitSha: options.repoCommitSha ?? resolveRepoCommitSha(),
        bunVersion: Bun.version,
        opencodeVersion: options.opencodeVersion ?? "unknown",
        historianModelId: mode.kind === "live" ? mode.historianModel : "scripted-mock",
        probeModelId:
            mode.kind === "live" ? `${mode.probeModel.providerID}/${mode.probeModel.modelID}` : "scripted-mock",
        parserImpl: "ts",
        chunkTokenBudget: deriveHistorianChunkTokens(
            resolveHistorianContextLimit(mode.kind === "live" ? mode.historianModel : undefined),
        ),
    };
}

class RunAbort extends Error {
    constructor(
        readonly reason: RunErrorReason,
        readonly detail: string,
    ) {
        super(`${reason}: ${detail}`);
    }
}

/**
 *
 * `isHistorianRequest` detects historian requests from the `system` marker, not `messages`.
 * Main-agent histories can retain marker-bearing content in `messages`.
 * Matching `messages` can route a main-agent turn to `historianResponse`.
 * Misrouting consumes a scripted historian output and causes script drift.
 * If the `system` marker is absent, historian requests must fail with `script-drift`.
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
    return false;
}

/**
 */
function isTitleRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    const text = typeof system === "string" ? system : JSON.stringify(system ?? "");
    return text.includes(TITLE_SYSTEM_MARKER);
}

/**
 * The matcher uses substring matching for `<new_messages>` because injection can alter user-message boundaries and content.
 * The plugin's injection pass can prepend blocks to or splice user messages.
 * The matcher must not inspect only the last user message or require exact equality.
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

/**
 * The parser reads the ordinal range from the `Messages X-Y:` header in `<new_messages>`.
 * `buildCompartmentAgentPrompt` places `inputSource` immediately after the opening `<new_messages>` tag.
 * The parser treats the first `Messages X-Y:` header after `<new_messages>` as authoritative.
 * The parser must not parse bare `[N]` ordinals because transcript text and echoed repair payloads can contain them.
 * Bare `[N]` matches can corrupt the range and misattribute validation failures to the historian.
 */
export function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const text = JSON.stringify(body.messages ?? "");
    const markerIndex = text.indexOf("<new_messages>");
    if (markerIndex === -1) return null;
    const header = /Messages (\d+)-(\d+):/.exec(text.slice(markerIndex));
    if (!header) return null;
    return { start: Number(header[1]), end: Number(header[2]) };
}

export function buildProbePrompt(probe: Probe): string {
    // The runner uses contract constants so freeze lint checks the prompt it sends.
    if (probe.answerType === "exact") {
        return `${PROBE_PROMPT_SHARED}\n${PROBE_PROMPT_QUESTION_LABEL} ${probe.question}\n${PROBE_PROMPT_EXACT_SUFFIX}`;
    }
    if (probe.answerType === "multiple-choice") {
        return `${PROBE_PROMPT_SHARED}\n${PROBE_PROMPT_QUESTION_LABEL} ${probe.question}\n${PROBE_PROMPT_CHOICE_PREFIX} ${probe.choices.join(PROBE_CHOICE_SEPARATOR)}.`;
    }
    return `${PROBE_PROMPT_SHARED}\n${PROBE_PROMPT_QUESTION_LABEL} ${probe.question}\n${PROBE_PROMPT_CLAIM_ID_SUFFIX}`;
}

/**
 *
 * `<answer>` validation requires exactly one envelope to reject ambiguous replies.
 * `<answer>` validation rejects multiple envelopes instead of accepting a prefix.
 */
export function extractAnswerEnvelope(text: string | null): string | null {
    if (text === null) return null;
    const matches = [...text.matchAll(/<answer>([\s\S]*?)<\/answer>/g)];
    if (matches.length !== 1) return null;
    const answer = matches[0][1].trim();
    return answer.length > 0 ? answer : null;
}

/**
 */
const INJECTED_BLOCK_TAGS = [
    "session-history",
    "session-history-since",
    "new-compartments",
    "project-memory",
    "memory-mural",
    "user-profile",
    "ctx-search-hint",
] as const;

/**
 *
 * `stripInjectedBlocks` is sound only when the transcript does not contain injected-block tags.
 * `carriesInjectedBlockTag` must run before `stripInjectedBlocks`; blocks with trimmed closing tags remain unmatched, so `stripInjectedBlocks` retains their contents.
 * Retaining unmatched contents prevents `stripInjectedBlocks` from hiding potential leaks.
 */
export function stripInjectedBlocks(text: string): string {
    let remaining = text;
    for (const tag of INJECTED_BLOCK_TAGS) {
        remaining = remaining.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "\n");
    }
    return remaining;
}

/**
 *
 */
export const COMPARTMENT_BLOCK_TAGS = [
    "session-history",
    "session-history-since",
    "new-compartments",
    "memory-mural",
] as const satisfies readonly (typeof INJECTED_BLOCK_TAGS)[number][];

/**
 *
 */
export function injectedBlockContents(text: string, tags: readonly string[]): string {
    const chunks: string[] = [];
    for (const tag of tags) {
        for (const match of text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))) {
            chunks.push(match[1]);
        }
    }
    return chunks.join("\n");
}

/**
 *
 * `stripInjectedBlocks` must not process payloads whose authored text contains injected-block tags, because forged tag pairs could hide leaked gold text.
 */
export function carriesInjectedBlockTag(text: string): boolean {
    return INJECTED_BLOCK_TAGS.some((tag) => text.includes(`<${tag}>`) || text.includes(`</${tag}>`));
}

/**
 *
 */
export function rangeCoveredByCompartments(
    range: readonly [number, number],
    compartments: ReadonlyArray<{ start: number; end: number }>,
): boolean {
    for (let ordinal = range[0]; ordinal <= range[1]; ordinal += 1) {
        if (!compartments.some((compartment) => compartment.start <= ordinal && compartment.end >= ordinal)) {
            return false;
        }
    }
    return true;
}

/**
 *
 *
 */
export function goldRangeLeak(args: {
    scenario: HistorianEvalScenario;
    goldClaims: ReadonlyArray<{ id: string; sourceTurnRange: readonly [number, number] }>;
    payloadText: string | null;
    probePrompt: string;
}): string | null {
    const { scenario, goldClaims, payloadText, probePrompt } = args;
    if (payloadText === null) return null;
    const authoredCarriesTag = scenario.transcript.turns.some(
        (turn) => carriesInjectedBlockTag(turn.user) || carriesInjectedBlockTag(turn.assistant),
    );
    const withoutPrompt = probePrompt.length === 0 ? payloadText : payloadText.split(probePrompt).join("\n");
    const rawHistory = authoredCarriesTag ? withoutPrompt : stripInjectedBlocks(withoutPrompt);
    // `rawHistory` omits an exact `probePrompt` match after prompt removal, so the matcher searches `unstripped` when `raw` contains `probePrompt`.
    // A match in `unstripped` can include the prompt itself.
    const unstripped = authoredCarriesTag ? payloadText : stripInjectedBlocks(payloadText);
    for (const claim of goldClaims) {
        for (let turn = claim.sourceTurnRange[0]; turn <= claim.sourceTurnRange[1]; turn += 1) {
            const authored = scenario.transcript.turns[turn];
            for (const raw of [authored.user, authored.assistant]) {
                if (raw.trim().length === 0) continue;
                const searched =
                    probePrompt.length > 0 && raw.includes(probePrompt) ? unstripped : rawHistory;
                if (searched.includes(raw)) {
                    return `raw transcript text of gold turn ${turn} survived in the probe payload`;
                }
            }
        }
    }
    return null;
}

/* */
function messageIds(messages: unknown): string[] {
    if (!Array.isArray(messages)) return [];
    const ids: string[] = [];
    for (const message of messages) {
        const direct = (message as { id?: unknown })?.id;
        const nested = (message as { info?: { id?: unknown } })?.info?.id;
        const id = typeof nested === "string" ? nested : typeof direct === "string" ? direct : null;
        if (id !== null) ids.push(id);
    }
    return ids;
}

/**
 *
 */
function toolInvocationsInNewMessages(messages: unknown, known: ReadonlySet<string>): string[] {
    if (!Array.isArray(messages)) return [];
    const names = new Set<string>();
    for (const message of messages) {
        const direct = (message as { id?: unknown })?.id;
        const nested = (message as { info?: { id?: unknown } })?.info?.id;
        const id = typeof nested === "string" ? nested : typeof direct === "string" ? direct : null;
        if (id !== null && known.has(id)) continue;
        const parts = (message as { parts?: unknown })?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
            const type = (part as { type?: unknown })?.type;
            if (typeof type !== "string" || !type.includes("tool")) continue;
            const candidate = part as { tool?: unknown; toolName?: unknown; name?: unknown };
            const name = [candidate.tool, candidate.toolName, candidate.name].find(
                (value): value is string => typeof value === "string" && value.length > 0,
            );
            names.add(name ?? "<unnamed>");
        }
    }
    return [...names].sort();
}

/**
 */
let cachedRepoCommitSha: string | null = null;
function resolveRepoCommitSha(): string {
    if (cachedRepoCommitSha !== null) return cachedRepoCommitSha;
    let sha = "unknown";
    try {
        const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
        const candidate = head.success ? head.stdout.toString().trim() : "";
        if (/^[0-9a-f]{40}$/.test(candidate)) {
            sha = candidate;
            const status = Bun.spawnSync(["git", "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
            const porcelain = status.success ? status.stdout.toString() : "";
            if (porcelain.trim().length > 0) {
                const diff = Bun.spawnSync(["git", "diff", "HEAD"], { stdout: "pipe", stderr: "ignore" });
                const hasher = new Bun.CryptoHasher("sha256");
                hasher.update(porcelain);
                hasher.update(diff.success ? diff.stdout.toString() : "");
                //
                const topLevel = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
                    stdout: "pipe",
                    stderr: "ignore",
                });
                const repoRoot = topLevel.success ? topLevel.stdout.toString().trim() : "";
                const untracked = Bun.spawnSync(
                    repoRoot.length === 0
                        ? ["git", "ls-files", "--others", "--exclude-standard", "-z"]
                        : ["git", "-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"],
                    { stdout: "pipe", stderr: "ignore" },
                );
                if (untracked.success) {
                    for (const path of untracked.stdout.toString().split("\0").filter((entry) => entry.length > 0)) {
                        let contents: Buffer | string;
                        try {
                            contents = readFileSync(repoRoot.length === 0 ? path : join(repoRoot, path));
                        } catch {
                            // for clean.
                            contents = "<unreadable>";
                        }
                        const pathBytes = Buffer.from(path, "utf8");
                        hasher.update(`${pathBytes.length}:`);
                        hasher.update(pathBytes);
                        hasher.update(`${contents.length}:`);
                        hasher.update(contents);
                    }
                }
                sha = `${candidate}-dirty.${hasher.digest("hex").slice(0, 12)}`;
            }
        }
    } catch {
        sha = "unknown";
    }
    cachedRepoCommitSha = sha;
    return sha;
}

/**
 *
 */
function assertLiveProvidersCredentialed(mode: LiveHistorianMode): void {
    const routes: Array<{ label: string; providerId: string }> = [
        { label: "historianModel", providerId: mode.historianModel.split("/")[0] ?? "" },
        { label: "probeModel.providerID", providerId: mode.probeModel.providerID },
    ];
    const offenders = routes.filter((route) => route.providerId !== "anthropic");
    if (offenders.length > 0) {
        throw new Error(
            `historian-eval: live mode exports only ANTHROPIC_API_KEY, so every live route must use the anthropic provider; ` +
                `${offenders.map((route) => `${route.label} resolves to "${route.providerId || "<empty>"}"`).join(", ")}`,
        );
    }
}

class ScenarioRunner {
    private harness: TestHarness | null = null;
    private embedMock: MockProvider | null = null;
    private historianMarkerMockHits = 0;
    private capturedChildIds = new Set<string>();
    private seenProbeMessageIds = new Set<string>();
    private probeResponseQueue: string[] = [];
    private turnScripts: Array<{ prompt: string; response: MockResponse; hits: number }> = [];
    private historianScriptExhausted = false;
    private historianScriptQueue: Array<string | ((range: { start: number; end: number }) => string)> | null = null;
    private historianRangeUnparseable = false;
    private collectedRuns: HistorianRunArtifact[] = [];
    private collectedProbes: ProbeExchange[] = [];
    private capturedClaims: {
        nowMs: number;
        injectedClaims: InjectedClaimRecord[];
        perGoldPredicate: PerGoldPredicateCount[];
        /**
         *
         *
         */
        snapshotPath: string;
    } | null = null;
    private sessionId = "";

    constructor(
        private readonly scenario: HistorianEvalScenario,
        private readonly options: RunScenarioOptions,
    ) {}

    async run(): Promise<HistorianEvalRunRecord> {
        resolveRepoCommitSha();
        const recordPath = join(this.options.artifactDir, "run-record.json");
        if (existsSync(recordPath)) {
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
     * Variants override the remaining fields explicitly so ERROR, scoreable-exhaustion, and full-record semantics remain visible as diffs from this base.
     */
    private baseRecord(): Omit<
        HistorianEvalRunRecord,
        "projectIdentity" | "nowMs" | "perGoldPredicate" | "injectedClaims" | "probes" | "verifiedClaimCount" | "contextDbSnapshotPath" | "error"
    > {
        return {
            schema: RUN_RECORD_SCHEMA,
            scenarioId: this.scenario.id,
            scenarioFingerprint: scenarioFingerprint(this.scenario),
            triggerFingerprint: triggerFingerprint(this.scenario),
            sessionId: this.sessionId,
            system: this.systemTuple(),
            expectedHistorianRuns: this.scenario.trigger.expectedHistorianRuns,
            historianRuns: this.collectedRuns,
            authoredTurnOrdinals: this.authoredTurnOrdinals(),
        };
    }

    private emptyRecord(error: RunRecordError): HistorianEvalRunRecord {
        // `emptyRecord` stores a context-database snapshot so failures are diagnosable without rerunning.
        let snapshotPath = this.capturedClaims?.snapshotPath ?? "";
        if (snapshotPath === "") {
            try {
                if (this.harness !== null && this.harness.hasContextDb()) {
                    snapshotPath = this.snapshotContextDb(this.harness);
                }
            } catch {
                snapshotPath = "";
            }
        }
        return {
            ...this.baseRecord(),
            projectIdentity:
                this.capturedClaims === null || this.harness === null
                    ? ""
                    : resolveProjectIdentity(this.harness.opencode.env.workdir),
            nowMs: this.capturedClaims?.nowMs ?? Date.now(),
            perGoldPredicate: this.capturedClaims?.perGoldPredicate ?? [],
            injectedClaims: this.capturedClaims?.injectedClaims ?? [],
            probes: this.collectedProbes,
            verifiedClaimCount: 0,
            contextDbSnapshotPath: snapshotPath,
            // Harness-failure details can include child stdout and stderr verbatim.
            // redactSecrets removes the live API key before the record reaches disk.
            error: { reason: error.reason, detail: this.redactSecrets(error.detail) },
        };
    }

    /**
     * redactSecrets replaces a nonempty live API key in durable artifacts with `[REDACTED]`.
     * Harness errors and server stderr can contain the live API key because both are captured unfiltered.
     */
    private redactSecrets(text: string): string {
        const mode = this.options.mode;
        if (mode.kind !== "live" || mode.apiKey.length === 0) return text;
        return text.replaceAll(mode.apiKey, "[REDACTED]");
    }

    private fillerCount(): number {
        return Math.max(0, MIN_BUILD_TURNS - this.scenario.transcript.turns.length);
    }

    /**
     * Harness-owned padding turns after the authored epilogue are excluded from gold and the fingerprint.
     */
    private paddingTurnCount(): number {
        const trigger = this.scenario.trigger;
        const target = deriveProtectedTailTokenTarget({
            contextLimit: trigger.modelContextLimit,
            executeThresholdPercentage: EXECUTE_THRESHOLD_PERCENTAGE,
            usagePercentage: (trigger.spikeUsageTokens / trigger.modelContextLimit) * 100,
        });
        // The padding calculation uses each turn's actual ballast because the recipe permits fewer than 100 tokens, including zero.
        // Ballast excludes prose tokens.
        const tokensPerTurn = Math.max(1, trigger.ballastTokensPerTurn);
        // The extra turn absorbs rounding; the spike turn's ballast joins the tail.
        // `MAX_PADDING_TURNS` prevents a 96K tail target from creating hundreds of padding turns.
        // `lintScenario` reports a short tail at freeze time without suppressing runtime diagnostics for an unreachable trigger.
        return Math.min(MAX_PADDING_TURNS, Math.ceil(target.N / tokensPerTurn) + 1);
    }

    private systemTuple(): SystemVersionTuple {
        return runSystemTuple(this.options);
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

        // A live historian whose every attempt fails validation is model behavior, not infrastructure failure.
        // The scorer maps this record to `FAIL:invalid-output`; no published claims exist to capture or probe.
        if (runs.every((run) => run.status === "failed")) {
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
        this.assertAuthoredEvidenceWasChunked(runs);
        this.assertPromotionNotSilentlySkipped(harness, sessionId, runs);

        // Historian promotions enter as `CANDIDATE` with source `model_inference`; the visibility policy hides candidates from automatic surfaces until `VERIFIED`.
        //
        // The authoritative-claim bridge runs before authoritative capture; an abort leaves `capturedClaims` null.
        // The catch block captures claims before rethrowing so the record matches the verified snapshot.
        // The catch block captures claims after partial verification so captured claims reflect claims made visible by verification.
        let verifiedClaimCount: number;
        try {
            verifiedClaimCount = this.runVerificationBridge(harness);
        } catch (error) {
            this.captureClaimStateForAbort(harness);
            throw error;
        }

        // The probe stage can abort with `probe-envelope-malformed`, `probe-gold-uncovered`, `probe-response-leak`, or `probe-tool-use`.
        // The code captures claim state before probes so an abort cannot discard an observed false-authoritative promotion.
        // `nowMs` makes re-scoring time-independent.
        // (KTD1).
        const nowMs = Date.now();
        const { injectedClaims, perGoldPredicate } = this.captureClaimState(harness, nowMs);
        this.capturedClaims = {
            nowMs,
            injectedClaims,
            perGoldPredicate,
            snapshotPath: this.snapshotContextDb(harness, PRE_PROBE_SNAPSHOT_FILE),
        };

        const probes = await this.driveProbes(harness, sessionId);
        // A probe-phase request that reaches the poison default increments `defaultHits` even when every probe receives its scripted reply.
        // `assertNoScriptDrift` runs after `driveProbes` to validate the complete attempt.
        this.assertNoScriptDrift(harness);

        // The claim-ID response-leak check runs after every probe's injected locator set is available.
        const claimIdLeak = probeResponseClaimIdLeak({ scenario: this.scenario, exchanges: probes, injectedClaims });
        if (claimIdLeak !== null) throw new RunAbort("probe-response-leak", claimIdLeak);
        const snapshotPath = this.snapshotContextDb(harness);
        // The completion path scores the snapshot created after `driveProbes`.
        rmSync(join(this.options.artifactDir, PRE_PROBE_SNAPSHOT_FILE), { force: true });

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
     * `openDatabase()` in TS mode creates schemas without the claim-memory fragment.
     * The runner installs the claim-memory fragment with the production schema factory before historian runs.
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
        if (mode.kind === "live") assertLiveProvidersCredentialed(mode);
        // The runner uses a deterministic embedding endpoint so fire-and-forget embedding dispatch cannot race teardown with real network traffic.
        this.embedMock = new MockProvider();
        const { baseURL: embeddingEndpoint } = await this.embedMock.start();

        const magicContextConfig: Record<string, unknown> = {
            execute_threshold_percentage: EXECUTE_THRESHOLD_PERCENTAGE,
            keep_subagents: true,
            historian: {
                two_pass: false,
                disallowed_tools: ["*"],
                fallback_models: [],
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
     */
    private installMatchers(harness: TestHarness): void {
        const mode = this.options.mode;
        // The runner stores `historianScriptQueue` so `assertNoScriptDrift` can detect unconsumed outputs.
        // `assertNoScriptDrift` rejects unconsumed historian outputs.
        this.historianScriptQueue = mode.kind === "scripted" ? [...mode.outputs] : null;
        const scripted = this.historianScriptQueue;
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
            this.historianMarkerMockHits += 1;
            return {
                error: { status: 500, type: "historian_eval_fallback", message: "fallback engaged" },
            };
        }
        const next = scripted.shift();
        if (next === undefined) {
            this.historianScriptExhausted = true;
            return { text: POISON_TEXT, usage: { input_tokens: 100, output_tokens: 10 } };
        }
        let text: string;
        if (typeof next === "function") {
            const range = findOrdinalRange(body);
            if (range === null) {
                // A range-taking script cannot cover an unparseable chunk.
                this.historianRangeUnparseable = true;
                return { text: POISON_TEXT, usage: { input_tokens: 100, output_tokens: 10 } };
            }
            text = next(range);
        } else {
            text = next;
        }
        return {
            text,
            usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500 },
        };
    }

    /* */
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
     * driveTranscript places harness-owned filler before authored turns and adds deterministic ballast to each user prompt so the protected-tail boundary accounts for content mass.
     */
    private async driveTranscript(harness: TestHarness, sessionId: string, fillerCount: number): Promise<void> {
        const usage = {
            ...triggerTurnUsage(this.scenario.trigger.usageTokensPerTurn),
            output_tokens: 40,
        };
        for (let index = 0; index < fillerCount; index += 1) {
            await this.scriptedTurn(
                harness,
                sessionId,
                `${FILLER_TURN.user} ${ballastProse(this.scenario.trigger.ballastTokensPerTurn)}`,
                { text: FILLER_TURN.assistant, usage },
            );
        }
        for (const [index, turn] of this.scenario.transcript.turns.entries()) {
            await this.scriptedTurn(
                harness,
                sessionId,
                `${turn.user} ${ballastProse(this.scenario.trigger.ballastTokensPerTurn)}`,
                { text: turn.assistant, usage },
            );
        }
        // Post-epilogue padding pushes the protected tail past authored content so the historian chunk can reach every gold-fact range.
        const paddingBase = fillerCount + this.scenario.transcript.turns.length;
        for (let index = 0; index < this.paddingTurnCount(); index += 1) {
            await this.scriptedTurn(
                harness,
                sessionId,
                `Wrap-up housekeeping note ${index + 1}. ${ballastProse(this.scenario.trigger.ballastTokensPerTurn)}`,
                { text: "Housekeeping acknowledged.", usage },
            );
        }
    }

    private authoredTurnOrdinals(): Array<[number, number]> {
        return authoredTurnOrdinalsFor(this.scenario);
    }

    /**
     * The spike turn starts the historian in a fresh pass.
     */
    private async driveHistorianRun(
        harness: TestHarness,
        sessionId: string,
        runIndex: number,
    ): Promise<HistorianRunArtifact> {
        const trigger = this.scenario.trigger;
        const invocationsBefore = this.countHistorianInvocations(harness, sessionId);
        const completedInvocationsBefore = this.countHistorianInvocations(harness, sessionId, "completed");
        const failedInvocationsBefore = this.countHistorianInvocations(harness, sessionId, "failed");
        const markerHitsBefore = this.historianMarkerMockHits;
        const promotionEvidenceBefore = this.scopedPromotionEvidenceCount(harness);

        // Before the spike, the row count must equal the number of earlier declared runs.
        // A pre-spike turn that crosses the execution threshold can add a row.
        // The `>= runIndex` wait can adopt an earlier pass as the declared run.
        // The adopted early pass evaluates a different trigger point and chunk.
        // The early pass consumes its scripted output.
        // An empty scripted-output queue leaves no unconsumed historian output for `assertNoScriptDrift` to report.
        const rowsBeforeSpike = this.historianRunRows(harness, sessionId).length;
        if (rowsBeforeSpike !== runIndex - 1) {
            throw new RunAbort(
                "harness-failure",
                `historian run ${runIndex} found ${rowsBeforeSpike} run row(s) before its spike turn; ${runIndex - 1} expected, so a pass fired against an undeclared trigger point`,
            );
        }
        // The row is written only after an asynchronous pass finishes.
        // An earlier pass can remain in flight while the row count is correct.
        // An in-flight earlier pass can prevent the declared spike from starting its own pass.
        // The wait can adopt the in-flight pass as the declared run.
        // Consuming the in-flight pass's scripted output leaves no unconsumed historian output for `assertNoScriptDrift` to report.
        // `historianQuiesced` proves that no pass is running.
        if (!this.historianQuiesced(harness, sessionId)) {
            throw new RunAbort(
                "harness-failure",
                `historian run ${runIndex} found a pass already in flight before its spike turn; the declared run would adopt that pass's trigger point and chunk`,
            );
        }
        await this.scriptedTurn(
            harness,
            sessionId,
            `Continuing. ${ballastProse(trigger.ballastTokensPerTurn)}`,
            {
                text: "Acknowledged.",
                usage: { ...triggerTurnUsage(trigger.spikeUsageTokens), output_tokens: 40 },
            },
        );
        await this.scriptedTurn(harness, sessionId, `Please continue with step ${runIndex} of the plan.`, {
            text: "Standing by.",
            usage: { input_tokens: trigger.usageTokensPerTurn, output_tokens: 20 },
        });

        try {
            await harness.waitFor(
                () => this.historianRunRows(harness, sessionId).length >= runIndex && this.historianQuiesced(harness, sessionId),
                { timeoutMs: this.options.historianWaitMs ?? historianWaitBudgetMs(this.options.mode), label: `historian run ${runIndex}` },
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
        // Failed validation takes precedence over fallback detection.
        //
        // The production fallback chain ends with the live `SESSION` model.
        // This runner drives the source session with `MockProvider`.
        // A live historian that returns invalid output on both attempts sends a marker request to the mock.
        // A marker request on the mock shows that fallback reached the source session.
        // Aborting on that marker request converts invalid live-model output into `ERROR:fallback-engaged`.
        // That abort prevents recording `FAIL:invalid-output` for the live run.
        // A row that failed validation provides evidence of invalid live-model output.
        // A failed-validation row takes precedence over fallback detection.
        //
        // `markerHitsBefore` scopes the marker counter to one run.
        // `markerHitsBefore` prevents an earlier run's fallback from aborting a later healthy run.
        const markerHitsDuringRun = this.historianMarkerMockHits - markerHitsBefore;
        // The `validation: ` prefix is NOT proof the historian produced output.
        // `runValidatedHistorianPass` returns `{ ok: false }` for provider errors, auth failures, timeouts, child-session creation failures, and missing assistant output.
        // `compartment-runner-incremental` prefixes each `{ ok: false }` result with `validation: `.
        //
        // `failedValidation` requires a completed invocation in the current run before treating `validation: ` as model output.
        const completedDuringRun =
            this.countHistorianInvocations(harness, sessionId, "completed") - completedInvocationsBefore;
        // provider refused.
        const failedDuringRun =
            this.countHistorianInvocations(harness, sessionId, "failed") - failedInvocationsBefore;
        const failedValidation =
            row.status === "failed" &&
            (row.failure_reason ?? "").startsWith("validation: ") &&
            completedDuringRun > 0 &&
            failedDuringRun === 0;
        if (this.options.mode.kind === "live" && markerHitsDuringRun > 0 && !failedValidation) {
            throw new RunAbort(
                "fallback-engaged",
                `${markerHitsDuringRun} historian-marker request(s) reached the MockProvider during a live run`,
            );
        }
        // Non-`validation:` failures abort instead of being scored as invalid output.
        if (row.status === "noop") {
            throw new RunAbort(
                "run-never-fired",
                `historian run ${runIndex} recorded a no-op (${row.failure_reason ?? "no reason recorded"}); no historian request was made`,
            );
        }
        if (row.status === "failed" && !failedValidation) {
            throw new RunAbort(
                "harness-failure",
                `historian run ${runIndex} failed for a non-validation reason: ${row.failure_reason ?? "<none recorded>"}`,
            );
        }

        const rawOutput = await this.captureChildOutput(harness, sessionId);
        if (rawOutput === null && row.status === "success") {
            // A successful row with no capturable child output aborts because the run has no model-output evidence.
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
            unprocessedFrom: row.unprocessed_from ?? null,
            promotionEvidenceAdded: Math.max(0, this.scopedPromotionEvidenceCount(harness) - promotionEvidenceBefore),
        };
    }

    /**
     */
    private scopedPromotionEvidenceCount(harness: TestHarness): number {
        const db = openTestDb(harness.contextDbPath(), { readonly: true });
        try {
            return promotionEvidenceCount(db, resolveProjectIdentity(harness.opencode.env.workdir));
        } finally {
            db.close();
        }
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
        unprocessed_from: number | null;
    }> {
        if (!harness.hasContextDb()) return [];
        try {
            return harness
                .contextDb()
                .prepare(
                    `SELECT status, failure_reason, chunk_start_ordinal, chunk_end_ordinal,
                            compartments_produced, facts_emitted, discarded_last, unprocessed_from
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

    /**
     * recorded status.
     *
     */
    private countHistorianInvocations(harness: TestHarness, sessionId: string, status?: string): number {
        if (!harness.hasContextDb()) return 0;
        try {
            const clause = status === undefined ? "" : " AND status = ?";
            const params = status === undefined ? [sessionId] : [sessionId, status];
            const row = harness
                .contextDb()
                .prepare(
                    `SELECT COUNT(*) AS n FROM subagent_invocations WHERE session_id = ? AND subagent = 'historian'${clause}`,
                )
                .get(...params) as { n: number } | null;
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
        }
        for (const child of candidates) {
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
        if (this.historianRangeUnparseable) {
            throw new RunAbort(
                "script-drift",
                "historian request carried no parseable `Messages X-Y:` chunk header for a range-taking scripted output",
            );
        }
        const unconsumed = this.turnScripts.filter((entry) => entry.hits === 0).length;
        if (unconsumed > 0) {
            throw new RunAbort("script-drift", `${unconsumed} scripted main-agent turn(s) never consumed`);
        }
        const unconsumedHistorian = this.historianScriptQueue?.length ?? 0;
        if (unconsumedHistorian > 0) {
            throw new RunAbort(
                "script-drift",
                `${unconsumedHistorian} scripted historian output(s) never requested; the attempt did not exercise the path they script`,
            );
        }
        const defaultHits = harness.mock.defaultHits();
        if (defaultHits > 0) {
            throw new RunAbort("script-drift", `${defaultHits} request(s) fell through to the poison default response`);
        }
    }

    /**
     *
     *
     */
    private assertAuthoredEvidenceWasChunked(runs: readonly HistorianRunArtifact[]): void {
        const ordinals = this.authoredTurnOrdinals();
        const preEpilogue = ordinals.slice(0, this.scenario.transcript.epilogueStartIndex);
        if (preEpilogue.length === 0) return;
        const required: [number, number] = [
            preEpilogue[0][0],
            Math.max(...preEpilogue.map(([, assistant]) => assistant)),
        ];
        const exposed = exposedRanges(runs);
        if (!rangeCoveredByCompartments(required, exposed)) {
            throw new RunAbort(
                "harness-failure",
                `the declared runs exposed [${exposed
                    .map((range) => `${range.start}-${range.end}`)
                    .join(", ")}], which does not cover authored ordinals ${required[0]}-${required[1]}. Part of the transcript was never shown to the model, so absence checks would pass vacuously`,
            );
        }
    }

    /**
     *
     */
    private assertPromotionNotSilentlySkipped(
        harness: TestHarness,
        sessionId: string,
        runs: HistorianRunArtifact[],
    ): void {
        const lostPromotion = runs.filter(
            (run) => !run.discardedLast && run.factsEmitted > 0 && run.promotionEvidenceAdded === 0,
        );
        if (lostPromotion.length > 0) {
            throw new RunAbort(
                "no-op-promotion",
                lostPromotion
                    .map(
                        (run) =>
                            `run ${run.runIndex} emitted ${run.factsEmitted} fact(s) but added no claim or evidence`,
                    )
                    .join("; "),
            );
        }
        const totalFacts = runs
            .filter((run) => !run.discardedLast)
            .reduce((sum, run) => sum + run.factsEmitted, 0);
        if (totalFacts === 0) return;
        try {
            if (this.scopedPromotionEvidenceCount(harness) === 0) {
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
     * memories only.
     */
    private async driveProbes(harness: TestHarness, sessionId: string): Promise<ProbeExchange[]> {
        const exchanges = this.collectedProbes;
        const seed = await harness.client.session.messages({ path: { id: sessionId } });
        for (const id of messageIds(seed.data)) this.seenProbeMessageIds.add(id);
        const runRowsBefore = this.historianRunRows(harness, sessionId).length;
        for (const [probeIndex, probe] of this.scenario.probes.entries()) {
            exchanges.push(await this.driveProbe(harness, sessionId, probe, probeIndex));
        }
        try {
            await harness.waitFor(() => this.historianQuiesced(harness, sessionId), {
                timeoutMs: this.options.historianWaitMs ?? historianWaitBudgetMs(this.options.mode),
                label: "historian quiescent after the probe phase",
            });
        } catch {
            throw new RunAbort(
                "harness-failure",
                "a historian pass was still in flight after the probe phase; its run row cannot be accounted for",
            );
        }
        const runRowsAfter = this.historianRunRows(harness, sessionId).length;
        if (runRowsAfter !== runRowsBefore) {
            throw new RunAbort(
                "harness-failure",
                `${runRowsAfter - runRowsBefore} undeclared historian run(s) fired during the probe phase; the scenario's declared schedule is ${this.scenario.trigger.expectedHistorianRuns}`,
            );
        }
        if (this.probeResponseQueue.length > 0) {
            throw new RunAbort(
                "script-drift",
                `${this.probeResponseQueue.length} scripted probe response(s) never consumed`,
            );
        }
        return exchanges;
    }

    private async driveProbe(
        harness: TestHarness,
        sessionId: string,
        probe: Probe,
        probeIndex: number,
    ): Promise<ProbeExchange> {
        this.assertProbeGoldCovered(harness, sessionId, probe);
        const requestCountBefore = harness.mock.requests().length;

        let requestCountBeforeFinalAsk = requestCountBefore;
        const first = await this.askProbe(harness, sessionId, buildProbePrompt(probe));
        let answerRaw = first.answerRaw;
        let responseText = first.responseText;
        const toolNames = new Set(first.toolNames);
        let reAsked = false;
        const discardedResponseTexts: string[] = [];
        this.assertNoProbeResponseLeak(probe, probeIndex, first.responseText);
        if (answerRaw === null) {
            reAsked = true;
            if (first.responseText !== null) discardedResponseTexts.push(first.responseText);
            requestCountBeforeFinalAsk = harness.mock.requests().length;
            const retry = await this.askProbe(
                harness,
                sessionId,
                `${PROBE_PROMPT_REASK_PREFIX} ${buildProbePrompt(probe)}`,
            );
            answerRaw = retry.answerRaw;
            responseText = retry.responseText;
            for (const name of retry.toolNames) toolNames.add(name);
            this.assertNoProbeResponseLeak(probe, probeIndex, retry.responseText);
            if (answerRaw === null) {
                throw new RunAbort("probe-envelope-malformed", `probe ${probe.id} answered without a valid envelope twice`);
            }
        }

        if (toolNames.size > 0) {
            throw new RunAbort(
                "probe-tool-use",
                `probe ${probe.id} invoked ${[...toolNames].join(", ")}; a retrieved answer does not measure the injected payload`,
            );
        }

        const payloadText = this.capturedProbePayload(harness, requestCountBefore);
        this.assertNoGoldRangeLeak(probe, payloadText, buildProbePrompt(probe));
        const finalRequestPayload = this.capturedProbePayload(harness, requestCountBeforeFinalAsk);
        return {
            probeId: probe.id,
            answerRaw,
            reAsked,
            injectedRevisionLocators: this.injectedLocatorsForTurn(harness, sessionId, finalRequestPayload),
            payloadText,
            finalRequestPayloadText: finalRequestPayload,
            responseText,
            discardedResponseTexts,
        };
    }

    private async askProbe(
        harness: TestHarness,
        sessionId: string,
        prompt: string,
    ): Promise<{ answerRaw: string | null; responseText: string | null; toolNames: string[] }> {
        const mode = this.options.mode;
        if (mode.kind === "scripted") {
            const next = this.probeResponseQueue.shift();
            if (next === undefined) {
                throw new RunAbort("script-drift", "probe turn had no scripted probe response left");
            }
            await this.scriptedTurn(harness, sessionId, prompt, {
                text: next,
                // checks.
                usage: {
                    input_tokens: this.scenario.trigger.usageTokensPerTurn,
                    output_tokens: 40,
                },
            });
        } else {
            await harness.sendPrompt(sessionId, prompt, {
                providerID: mode.probeModel.providerID,
                modelID: mode.probeModel.modelID,
            });
        }
        const messagesRes = await harness.client.session.messages({ path: { id: sessionId } });
        const toolNames = toolInvocationsInNewMessages(messagesRes.data, this.seenProbeMessageIds);
        for (const id of messageIds(messagesRes.data)) this.seenProbeMessageIds.add(id);
        const responseText = extractLatestAssistantText(messagesRes.data);
        return {
            answerRaw: extractAnswerEnvelope(responseText),
            responseText,
            toolNames,
        };
    }

    /**
     *
     */
    private probeGoldClaims(probe: Probe): typeof this.scenario.gold.expectedClaims {
        const reference = probe.answerType === "claim-id" ? probe.expectedClaimRef : probe.sourceClaimRef;
        return this.scenario.gold.expectedClaims.filter((claim) => claim.id === reference);
    }

    /**
     * The leakage gate requires every probe-relevant gold-fact ordinal range to be covered by published compartment rows.
     * Uncovered ranges cause ERROR rather than scored FAIL because the splice may not have removed their raw messages.
     */
    private assertProbeGoldCovered(harness: TestHarness, sessionId: string, probe: Probe): void {
        const compartments = harness
            .contextDb()
            .prepare("SELECT start_message AS start, end_message AS end FROM compartments WHERE session_id = ?")
            .all(sessionId) as Array<{ start: number; end: number }>;
        const ordinals = this.authoredTurnOrdinals();
        for (const claim of this.probeGoldClaims(probe)) {
            const [startTurn, endTurn] = claim.sourceTurnRange;
            const range: [number, number] = [ordinals[startTurn][0], ordinals[endTurn][1]];
            if (!rangeCoveredByCompartments(range, compartments)) {
                throw new RunAbort(
                    "probe-gold-uncovered",
                    `probe ${probe.id}: gold claim ${claim.id} ordinal range ${range[0]}-${range[1]} not covered by the published compartments`,
                );
            }
        }
    }

    /**
     */
    private capturedProbePayload(harness: TestHarness, requestCountBefore: number): string | null {
        if (this.options.mode.kind === "live") return null;
        const probeRequests = harness.mock.requests().slice(requestCountBefore);
        // Zero captured requests indicate capture drift, not an absent payload.
        // Returning null would make `assertNoGoldRangeLeak` skip silently.
        // Without captured evidence, the probe could receive a normal PASS without evidence required for its verdict.
        if (probeRequests.length === 0) {
            throw new RunAbort(
                "harness-failure",
                "scripted probe turn captured no provider request; the leak gate has no payload to inspect",
            );
        }
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
     * The gate permits raw epilogue and harness-owned kick turns outside gold ranges.
     *
     * Magic Context blocks contain historian-authored summaries and claim text.
     * A summary may legitimately restate an authored sentence verbatim.
     * Searching them would falsely report leakage from a correct splice.
     * Searching injected blocks can raise `gold-range-leak` on summary wording alone.
     *
     * The exclusion is skipped when the scenario transcript contains `<project-memory>` tags.
     * A transcript-authored tag span is not evidence of injection, so stripping it could hide a real leak.
     * Such scenarios use the unstripped search, which can over-report but cannot conceal surviving raw text.
     */
    private assertNoProbeResponseLeak(probe: Probe, probeIndex: number, responseText: string | null): void {
        const leak = probeResponseLeak({ probes: this.scenario.probes, probeIndex, responseText });
        if (leak !== null) throw new RunAbort("probe-response-leak", `probe ${probe.id}: ${leak}`);
    }

    private assertNoGoldRangeLeak(probe: Probe, payloadText: string | null, probePrompt: string): void {
        const leak = goldRangeLeak({
            scenario: this.scenario,
            goldClaims: this.probeGoldClaims(probe),
            payloadText,
            probePrompt,
        });
        if (leak !== null) throw new RunAbort("gold-range-leak", `probe ${probe.id}: ${leak}`);
    }


    /**
     *
     * A read or parse failure aborts; only an absent row or absent column value produces an empty locator set.
     * Correct exact and multiple-choice probes can pass before locator-based trimming runs.
     * Swallowing a locator-read failure would let correct exact or multiple-choice probes pass without recorded injection evidence.
     * A correct exact or multiple-choice probe must not pass without per-probe injection evidence.
     */
    /**
     *
     * `session_meta.memory_block_ids` can retain locators from a previous turn.
     * When `inject-compartments` skips the cache update, `memory_block_ids` can remain stale.
     * The cache can contain previous-turn locators even when the request renders no `<project-memory>` block.
     * Stale cached locators could make the availability gate accept a correctly guessed answer without an answer-bearing claim.
     * The availability gate must not accept a correctly guessed answer when the request carries no answer-bearing claim.
     *
     * For a captured request, no rendered `<project-memory>` block means no locators were injected.
     * When `payloadText` is `null`, the cache remains the only injection evidence.
     */
    private injectedLocatorsForTurn(
        harness: TestHarness,
        sessionId: string,
        payloadText: string | null,
    ): string[] {
        const cached = this.visibleRevisionLocators(harness, sessionId);
        if (payloadText === null || cached.length === 0) return cached;
        const renderedBlock = /<project-memory>[\s\S]*?<\/project-memory>/.test(payloadText);
        return renderedBlock ? cached : [];
    }

    private visibleRevisionLocators(harness: TestHarness, sessionId: string): string[] {
        let raw: string | null;
        try {
            const row = harness
                .contextDb()
                .prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { memory_block_ids: string | null } | null;
            raw = row?.memory_block_ids ?? null;
        } catch (error) {
            throw new RunAbort(
                "harness-failure",
                `probe injection metadata unreadable: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (raw === null || raw.length === 0) return [];
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            throw new RunAbort(
                "harness-failure",
                `probe injection metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (!Array.isArray(parsed)) {
            throw new RunAbort("harness-failure", `probe injection metadata is not an array: ${typeof parsed}`);
        }
        // A wrong-typed locator entry must abort rather than be filtered out.
        // Treating `[42]` as an empty locator set would silently discard invalid evidence.
        const malformed = parsed.filter((entry) => typeof entry !== "string");
        if (malformed.length > 0) {
            throw new RunAbort(
                "harness-failure",
                `probe injection metadata has ${malformed.length} non-string entr(ies): ${JSON.stringify(malformed.slice(0, 3))}`,
            );
        }
        return parsed as string[];
    }

    /**
     */
    /**
     *
     * Capture failures must not replace the original abort.
     */
    private captureClaimStateForAbort(harness: TestHarness): void {
        if (this.capturedClaims !== null) return;
        try {
            const nowMs = Date.now();
            const { injectedClaims, perGoldPredicate } = this.captureClaimState(harness, nowMs);
            this.capturedClaims = {
                nowMs,
                injectedClaims,
                perGoldPredicate,
                snapshotPath: this.snapshotContextDb(harness, PRE_PROBE_SNAPSHOT_FILE),
            };
        } catch {
        }
    }

    private captureClaimState(
        harness: TestHarness,
        nowMs: number,
    ): { injectedClaims: InjectedClaimRecord[]; perGoldPredicate: PerGoldPredicateCount[] } {
        const identity = resolveProjectIdentity(harness.opencode.env.workdir);
        const db = openTestDb(harness.contextDbPath(), { readonly: true });
        try {
            const injectedClaims = readInjectedClaims(db, identity, this.scenario.id, nowMs);
            if (injectedClaims === null) {
                throw new RunAbort("stale-snapshot", "claim snapshot remained stale after the injection read's retry");
            }
            const perGoldPredicate = this.scenario.gold.expectedClaims.map((claim) => {
                const matching = injectedClaims.filter((item) => matchesGold(claim, item));
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

    private snapshotContextDb(harness: TestHarness, fileName = "context-db-snapshot.sqlite"): string {
        const snapshotPath = join(this.options.artifactDir, fileName);
        // `VACUUM INTO` produces a complete single-file image regardless of the live database's WAL state.
        // A plain file copy can omit committed pages still in `-wal`.
        const db = openTestDb(harness.contextDbPath(), { readwrite: true });
        try {
            db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
        } finally {
            db.close();
        }
        return snapshotPath;
    }

    /* */
    private async teardown(): Promise<void> {
        await Bun.sleep(250);
        try {
            if (this.harness !== null) {
                writeFileSync(
                    join(this.options.artifactDir, "opencode-stderr.log"),
                    this.redactSecrets(this.harness.opencode.stderr()),
                );
            }
        } catch {
            // ignore
        }
        try {
            await this.harness?.dispose();
        } catch {
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
