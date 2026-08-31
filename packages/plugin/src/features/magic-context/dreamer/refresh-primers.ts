import { DREAMER_PRIMER_INVESTIGATOR_AGENT } from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import { createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import {
    type RawMessageProvider,
    setRawMessageProvider,
    withRawSessionMessageCache,
} from "../../../hooks/magic-context/read-session-chunk";
import { extractToolCallSummaries } from "../../../hooks/magic-context/read-session-formatting";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { describeError, getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import {
    getActivePrimers,
    getPrimerCandidatesByIds,
    type Primer,
    updatePrimerAnswer,
} from "../storage-primers";
import { recordChildInvocation } from "../subagent-token-capture";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import { buildPrimerSeed } from "./primer-seed";
import { PRIMER_INVESTIGATOR_SYSTEM_PROMPT } from "./task-prompts";

const REFRESH_PRIMERS_PER_RUN = 5;

export interface RefreshPrimersArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    model?: string;
    fallbackModels?: readonly string[];
    language?: string;
    onProgress?: (processed: number) => void;
    /**
     * On Pi, `rawProviderFactory` builds a `RawMessageProvider` for an arbitrary historical session.
     * Pi stores historical sessions as JSONL and has no `opencode.db`.
     * OpenCode leaves `rawProviderFactory` undefined, so the seed read uses read-only `opencode.db`.
     * `Returning null` selects the closed-book fallback.
     * `rawProviderFactory` may be async because Pi JSONL discovery is async.
     * `readMessages()` itself is synchronous (wraps already-loaded entries).
     */
    rawProviderFactory?: (
        sessionId: string,
    ) => Promise<RawMessageProvider | null> | RawMessageProvider | null;
}

export interface RefreshPrimersResult {
    refreshed: number;
    skipped: number;
}

/**
 * `lastObservedAt` is bumped on recurrence, so it cannot determine refresh priority: recurring primers would starve quiet primers.
 */
function primersNeedingRefresh(primers: Primer[]): Primer[] {
    return primers
        .filter(
            (primer) =>
                !primer.answer.trim() ||
                primer.answerRefreshedAt == null ||
                (primer.lastObservedAt ?? 0) > primer.answerRefreshedAt,
        )
        .sort(
            (a, b) =>
                (a.answerRefreshedAt ?? 0) - (b.answerRefreshedAt ?? 0) ||
                (a.lastObservedAt ?? a.createdAt) - (b.lastObservedAt ?? b.createdAt) ||
                a.id - b.id,
        )
        .slice(0, REFRESH_PRIMERS_PER_RUN);
}

function buildInvestigationPrompt(
    primer: Primer,
    seedKind: "raw" | "closed-book",
    orientation: string,
    prePost: string,
): string {
    const orientationHeader =
        seedKind === "raw"
            ? `### Orientation — where this question arose (a MAP, NOT current truth)
The lines below are from the session episode where this question came up.
\`U:\` = what the user asked. \`TC:\` = which files/symbols the agent read.
This shows you WHERE to look. It does NOT tell you the current answer — the code
may have changed since. Investigate the CURRENT source yourself.

${orientation || "(no orientation available)"}`
            : `### Orientation (compartment summary — raw episode unavailable)
${orientation || "(none)"}`;

    return `## Task: Refresh a Magic Context Primer by investigating the current code

You maintain a concise, durable answer to a standing question about how THIS
project currently works. Your job is to GROUND the answer in today's source.

### Question
${primer.question}

### Current Answer
${primer.answer.trim() || "(empty)"}

${orientationHeader}

### Surrounding context
${prePost || "(none)"}

### Instructions
- Use your tools (read / grep / glob / aft_outline / aft_zoom / aft_search) to
  investigate the CURRENT source. Open the files the orientation points at, and
  follow the code from there.
- Ground every claim in code you actually read THIS run. Where the orientation's
  old conclusions conflict with current source, current source wins.
- Prefer stable architecture / invariants over transient task status.
- Keep the answer concise (~3-8 bullets or short paragraphs).
- If you cannot ground an answer in current code, return the current answer
  unchanged if it is non-empty; otherwise return an empty string.

Return valid JSON only, no markdown fencing:
{ "answer": "..." }`;
}

/**
 * The gate rejects runs with no tool calls because they cannot ground an answer in current source.
 * The gate preserves the existing answer when the run makes no tool calls.
 * The gate counts every tool call so part-shape changes cannot bypass it.
 */
function investigationToolCallCount(messages: unknown[]): number {
    if (!Array.isArray(messages)) return 0;
    let count = 0;
    for (const message of messages) {
        if (message === null || typeof message !== "object") continue;
        const parts = (message as { parts?: unknown }).parts;
        if (Array.isArray(parts)) count += extractToolCallSummaries(parts).length;
    }
    return count;
}

function parseAnswer(messages: unknown[], fallback: string): string {
    const text = extractLatestAssistantText(messages);
    if (!text) throw new Error("refresh-primers returned no output");
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) throw new Error("refresh-primers returned no JSON");
    const parsed = JSON.parse(jsonMatch[1]) as { answer?: unknown };
    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
    if (!answer && fallback.trim()) return fallback.trim();
    if (answer.length > 20_000) throw new Error("refresh-primers answer too large");
    return answer;
}

export async function refreshPrimers(args: RefreshPrimersArgs): Promise<RefreshPrimersResult> {
    const result: RefreshPrimersResult = { refreshed: 0, skipped: 0 };
    const primers = primersNeedingRefresh(getActivePrimers(args.db, args.projectIdentity));
    if (primers.length === 0) return result;

    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(
        args.db,
        args.holderId,
        args.leaseKey,
        () => abortController.abort(),
        args.leaseAcquisition,
    );

    try {
        for (let i = 0; i < primers.length; i += 1) {
            const primer = primers[i];
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) break;
            // The per-primer slice reserves refresh capacity for other primers.
            const primersRemaining = primers.length - i;
            const sliceMs = Math.max(1, Math.floor(remainingMs / primersRemaining));

            const refreshed = await refreshOnePrimer(args, primer, sliceMs, abortController.signal);
            if (refreshed) result.refreshed += 1;
            else result.skipped += 1;
            args.onProgress?.(result.refreshed + result.skipped);
        }
        log(`[dreamer] refresh-primers: refreshed=${result.refreshed} skipped=${result.skipped}`);
        return result;
    } finally {
        heartbeat.stop();
    }
}

/**
 * try/finally guarantees the child is deleted even if a mid-loop deadline throw
 * `refreshPrimer` returns `true` if it commits the answer.
 */
async function refreshOnePrimer(
    args: RefreshPrimersArgs,
    primer: Primer,
    sliceMs: number,
    signal: AbortSignal,
): Promise<boolean> {
    // On Pi, the refresh resolves a raw provider before opening the synchronous seed scope.
    const originSessionId = originSessionIdForPrimer(args, primer);
    let provider: RawMessageProvider | null = null;
    if (args.rawProviderFactory && originSessionId) {
        try {
            provider = await args.rawProviderFactory(originSessionId);
        } catch {
            provider = null; // → closed-book fallback inside buildPrimerSeed
        }
    }
    const seed = withRawSessionMessageCache(() => {
        const unregister =
            provider && originSessionId ? setRawMessageProvider(originSessionId, provider) : null;
        try {
            return buildPrimerSeed(args.db, primer);
        } finally {
            unregister?.();
        }
    });

    let agentSessionId: string | null = null;
    const startedAt = Date.now();
    try {
        const createResponse = await createChildSessionWithFence({
            client: args.client,
            db: args.db,
            parentSessionId: args.parentSessionId,
            title: "magic-context-dream-refresh-primers",
            directory: args.sessionDirectory,
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create primer refresh session.");

        const prompt = buildInvestigationPrompt(primer, seed.kind, seed.orientation, seed.prePost);
        const run = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_PRIMER_INVESTIGATOR_AGENT,
                    system: withContentLanguageDirective(
                        PRIMER_INVESTIGATOR_SYSTEM_PROMPT,
                        args.language,
                    ),
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: sliceMs,
                signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:refresh-primers",
                fetchOutput: async () => {
                    const messagesResponse = await args.client.session.messages({
                        path: { id: agentSessionId as string },
                        query: { directory: args.sessionDirectory, limit: 100 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => parseAnswer(messages, primer.answer),
            },
        );

        recordInvocation(args, startedAt, { status: "completed", messages: run.output });

        const answer = run.validated.trim();
        if (!answer) return false;

        if (investigationToolCallCount(run.output) === 0) {
            log(
                `[dreamer] refresh-primers: primer #${primer.id} answer not committed (no investigation tool calls)`,
            );
            return false;
        }

        runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
            updatePrimerAnswer(args.db, primer.id, answer);
        });
        return true;
    } catch (error) {
        const desc = describeError(error);
        log(
            `[dreamer] refresh-primers failed (primer #${primer.id}): ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        recordInvocation(args, startedAt, { status: "failed", error });
        throw error;
    } finally {
        // The lookup returns the most-recent candidate's session id without rendering.
        if (agentSessionId) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((e: unknown) => {
                    log(`[dreamer] refresh-primers session cleanup failed: ${getErrorMessage(e)}`);
                });
        }
    }
}

function originSessionIdForPrimer(args: RefreshPrimersArgs, primer: Primer): string | null {
    const candidates = getPrimerCandidatesByIds(args.db, primer.sourceCandidateIds);
    const mostRecent = candidates
        .slice()
        .sort((a, b) => b.sourceMessageTime - a.sourceMessageTime || b.id - a.id)[0];
    return mostRecent?.sessionId ?? null;
}

function recordInvocation(
    args: RefreshPrimersArgs,
    startedAt: number,
    params: { status: "completed" | "failed"; messages?: unknown[]; error?: unknown },
): void {
    if (!args.parentSessionId) return;
    recordChildInvocation({
        db: args.db,
        parentSessionId: args.parentSessionId,
        harness: "opencode",
        subagent: "dreamer",
        task: "refresh-primers",
        startedAt,
        status: params.status,
        messages: params.messages,
        error: params.error,
    });
}
