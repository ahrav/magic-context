/**
 *
 * The packed hint directs the agent to run `ctx_search` for full context instead of receiving retrieved content directly.
 *
 * Cache safety:
 * The transform appends hints only to the triggering user message before Anthropic caches it.
 * The in-memory turn cache and `appendReminderToUserMessageById`'s `.includes()` guard make repeated deferred passes idempotent.
 * A new user turn with a different message ID computes and appends a fresh hint.
 * The transform recomputes the hint after a process restart because the in-memory turn cache is empty.
 */

import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import { resolveProjectRootDirectory } from "../../features/magic-context/memory/project-identity";
import type {
    SearchSource,
    UnifiedSearchOptions,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import {
    type AutoSearchHintDecision,
    type AutoSearchHintNoHintReason,
    appendAutoSearchHintDecision,
    getAutoSearchHintDecisions,
} from "../../features/magic-context/storage-meta-persisted";
import {
    type KernelClient,
    type KernelClientResolver,
    type KernelMemorySnapshot,
    kernelMemorySnapshotFrom,
} from "../../shared/kernel-client";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { searchKernelMemoryRows } from "../../tools/ctx-search/kernel-memory-search";
import { collectAntiMemoryWarningFragments, packAutoSearchHint } from "./auto-search-hint";
import {
    AUTO_SEARCH_RESULT_LIMIT,
    AUTO_SEARCH_SOURCES,
    extractBoundedAutoSearchQuery,
} from "./auto-search-prompt";
import {
    AUTO_SEARCH_TIMEOUT_MS,
    hasStackedAugmentation,
    unifiedSearchWithTimeout,
} from "./auto-search-shared";
import { MEMORY_READ_SURFACE, withholdLaggingMemory } from "./kernel-memory-render";
import { hasMeaningfulUserText } from "./read-session-formatting";
import { appendReminderToUserMessageById } from "./transform-message-helpers";
import type { MessageLike } from "./transform-operations";

export type AutoSearchOutcome =
    | { ok: true }
    | { ok: false; kind: "timeout" | "search-failure" | "cas-exhaustion" };

const AUTO_SEARCH_OK: AutoSearchOutcome = { ok: true };

export type AutoSearchDeliveryReason =
    | "delivered"
    | "empty"
    | "memory-abstained"
    | "memory-unavailable"
    | "below-threshold"
    | "packer-empty"
    | "timeout";

/** Below-threshold, empty, memory-abstained, memory-unavailable, packer-empty, and timeout are
 * completed empty-delivery outcomes. The two memory reasons replace `empty` when the kernel
 * withheld or could not serve memory, so an empty turn is not mistaken for a project with
 * nothing relevant.
 * Search failures are incomplete evidence, not empty rankings.
 * The delivered variant carries a non-null hint because the packer-empty branch rejects a null pack.
 *  `reason`. */
export type AutoSearchDelivery =
    | {
          status: "complete";
          reason: "delivered";
          hintText: string;
          prePack: UnifiedSearchResult[];
          delivered: UnifiedSearchResult[];
          tokenCount: number;
          omittedCount: number;
      }
    | {
          status: "complete";
          reason: Exclude<AutoSearchDeliveryReason, "delivered">;
          hintText: null;
          prePack: UnifiedSearchResult[];
          delivered: UnifiedSearchResult[];
          tokenCount: number;
          omittedCount: number;
      }
    | { status: "incomplete"; kind: "search-failure"; error: unknown };

function emptyDelivery(
    reason: Exclude<AutoSearchDeliveryReason, "delivered">,
    prePack: UnifiedSearchResult[],
): AutoSearchDelivery {
    return {
        status: "complete",
        reason,
        hintText: null,
        prePack,
        delivered: [],
        tokenCount: 0,
        omittedCount: prePack.length,
    };
}

/**
 * `runAutoSearchHint` gives structured callers the transform's source restrictions, timeout, and packing.
 * Persistence and message mutation stay with the transform caller.
 */
/** The `memory` source is served by the kernel; every other source still reads the local database. */
function localSources(sources: readonly SearchSource[]): SearchSource[] {
    return sources.filter((source) => source !== "memory");
}

/** The no-hint reason an empty turn records, given how the kernel answered. Every non-`available` state is withheld memory — `invalid` and `cancelled` reads served no rows just as `unavailable` does — so only a served-and-empty read records the project as having nothing relevant. commentlint: allow(JUDGE) */
function emptyReason(
    memory: KernelMemorySnapshot | null,
): "empty" | "memory-abstained" | "memory-unavailable" {
    if (memory === null || memory.state.kind === "available") return "empty";
    if (memory.state.kind === "abstained") return "memory-abstained";
    return "memory-unavailable";
}

export async function executeAutoSearchDelivery(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    prompt: string;
    searchOptions: UnifiedSearchOptions;
    scoreThreshold: number;
    /** Serves the `memory` source; absent when memory is disabled or the `memory` source is not requested. */
    kernelClient?: KernelClient;
    timeoutMs?: number;
    /** The reference clock defaults to the live clock for hint-age wording.
     * */
    packNowMs?: number;
}): Promise<AutoSearchDelivery> {
    // An undefined source list takes the auto-search defaults; `unifiedSearch` gives an
    // empty list the "no sources" meaning, not the default set. commentlint: allow(JUDGE)
    const sources: readonly SearchSource[] = args.searchOptions.sources ?? AUTO_SEARCH_SOURCES;
    const memoryRequested = sources.includes("memory");
    const kernelClient = memoryRequested ? args.kernelClient : undefined;
    const limit = args.searchOptions.limit ?? AUTO_SEARCH_RESULT_LIMIT;
    let timed: { results: UnifiedSearchResult[]; memory: KernelMemorySnapshot | null } | null;
    try {
        timed = await unifiedSearchWithTimeout(
            args.db,
            args.sessionId,
            args.projectPath,
            args.prompt,
            { ...args.searchOptions, sources: localSources(sources) },
            args.timeoutMs ?? AUTO_SEARCH_TIMEOUT_MS,
            kernelClient
                ? async (signal, deadlineMs) => {
                      const snapshot = withholdLaggingMemory(
                          kernelMemorySnapshotFrom(
                              await kernelClient.read({
                                  surface: MEMORY_READ_SURFACE,
                                  gated: true,
                                  signal,
                                  deadlineMs,
                              }),
                          ),
                      );
                      // The `explicit_search` surface serves `sensitive` rows; this
                      // automatic consumer re-imposes the daemon's auto-surface
                      // sensitivity rule before any row is scored. commentlint: allow(JUDGE)
                      return {
                          ...snapshot,
                          rows: snapshot.rows.filter(
                              (row) => row.object.sensitivity !== "sensitive",
                          ),
                      };
                  }
                : undefined,
        );
    } catch (error) {
        return { status: "incomplete", kind: "search-failure", error };
    }
    if (timed === null) {
        return emptyDelivery("timeout", []);
    }
    const memoryHits =
        timed.memory === null
            ? null
            : searchKernelMemoryRows({ rows: timed.memory.rows, query: args.prompt, limit });
    const results = [...(memoryHits ?? []), ...timed.results]
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    if (results.length === 0) {
        return emptyDelivery(emptyReason(timed.memory), results);
    }
    if (results[0].score < args.scoreThreshold) {
        // A withheld memory lane overrides `below-threshold`: the memory reasons stay retryable after the daemon recovers, while `below-threshold` persists a completed no-hint decision. commentlint: allow(JUDGE)
        const reason = emptyReason(timed.memory);
        return emptyDelivery(reason === "empty" ? "below-threshold" : reason, results);
    }
    const packed = packAutoSearchHint(results, {
        warningScoreThreshold: args.scoreThreshold,
        ...(args.packNowMs === undefined ? {} : { nowMs: args.packNowMs }),
    });
    if (packed.text === null) {
        return emptyDelivery("packer-empty", results);
    }
    return {
        status: "complete",
        reason: "delivered",
        hintText: packed.text,
        prePack: results,
        delivered: packed.delivered,
        tokenCount: packed.tokenCount,
        omittedCount: packed.omittedCount,
    };
}

export interface AutoSearchRunnerOptions {
    enabled: boolean;
    scoreThreshold: number;
    minPromptChars: number;
    directory?: string;
    projectPath: string;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
    /** Serves the `memory` source; absent when no daemon transport exists. */
    kernelClient?: KernelClientResolver;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    gitCommitsEnabled?: boolean;
}

/**
 * Persisted anti-memory warnings never replay; each warning requires a fresh
 * search. Ordinary hints carry an empty fragment list and replay on every pass.
 */
export function autoSearchHintReplayable(
    decision: Extract<AutoSearchHintDecision, { decision: "hint" }>,
): boolean {
    return decision.memoryFragments !== undefined && decision.memoryFragments.length === 0;
}

export function collectUserPromptParts(message: MessageLike): string {
    let collected = "";
    for (const part of message.parts) {
        // The collector ignores null parts so a malformed part does not abort collection.
        if (part === null || typeof part !== "object") continue;
        const p = part as { type?: string; text?: string; ignored?: boolean };
        if (p.type !== "text" || typeof p.text !== "string") continue;
        // The transform skips ignored plugin notifications so they do not reach downstream prompt processing.
        if (p.ignored === true) continue;
        collected += (collected.length > 0 ? "\n" : "") + p.text;
    }
    return collected;
}

function extractUserPromptText(message: MessageLike): string {
    // The transform strips markup before embedding to exclude plugin-owned tags.
    //
    //
    return extractBoundedAutoSearchQuery(collectUserPromptParts(message));
}

function findLatestMeaningfulUserMessage(messages: MessageLike[]): MessageLike | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg.info.role !== "user") continue;
        if (typeof msg.info.id !== "string") continue;
        // The embedding collector excludes ignored notifications, system reminders, and directive-only stubs.
        if (hasMeaningfulUserText(msg.parts)) {
            return msg;
        }
    }
    return null;
}

/**
 */
export async function runAutoSearchHint(args: {
    sessionId: string;
    db: Database;
    messages: MessageLike[];
    options: AutoSearchRunnerOptions;
}): Promise<AutoSearchOutcome> {
    const { sessionId, db, messages, options } = args;
    if (!options.enabled) return AUTO_SEARCH_OK;

    const userMsg = findLatestMeaningfulUserMessage(messages);
    if (!userMsg || typeof userMsg.info.id !== "string") return AUTO_SEARCH_OK;
    const userMsgId = userMsg.info.id;

    const replayHintIfEligible = (decision: AutoSearchHintDecision): void => {
        if (decision.decision !== "hint") return;
        if (autoSearchHintReplayable(decision)) {
            appendReminderToUserMessageById(messages, decision.messageId, decision.text);
            return;
        }
        sessionLog(
            sessionId,
            `auto-search: suppressing persisted anti-memory warning for ${decision.messageId} — fresh search required`,
        );
    };

    const existing = getAutoSearchHintDecisions(db, sessionId);
    const existingForMessage = existing.find((decision) => decision.messageId === userMsgId);
    if (existingForMessage) {
        replayHintIfEligible(existingForMessage);
        return AUTO_SEARCH_OK;
    }

    // The transform creates hints only for the final message because mutating an earlier message invalidates cached later messages.
    if (messages.length === 0 || messages[messages.length - 1].info.id !== userMsgId) {
        return AUTO_SEARCH_OK;
    }

    const writeNoHintAndReconcile = (reason: AutoSearchHintNoHintReason): AutoSearchOutcome => {
        const outcome = appendAutoSearchHintDecision(db, sessionId, {
            messageId: userMsgId,
            decision: "no-hint",
            reason,
        });
        if (!outcome.ok) return { ok: false, kind: "cas-exhaustion" };
        if (outcome.kind === "already-present") {
            replayHintIfEligible(outcome.decision);
        }
        return AUTO_SEARCH_OK;
    };

    // The transform checks raw text for augmentation tags before stripping them because stripping removes the duplicate-augmentation signal.
    const rawPartsText = collectUserPromptParts(userMsg);
    if (hasStackedAugmentation(rawPartsText)) {
        sessionLog(
            sessionId,
            "auto-search: skipping — user message already carries augmentation/hint",
        );
        return writeNoHintAndReconcile("stacked");
    }
    const rawPrompt = extractUserPromptText(userMsg);
    if (rawPrompt.length < options.minPromptChars) {
        return writeNoHintAndReconcile("too-short");
    }

    let delivery: AutoSearchDelivery;
    try {
        if (options.directory) {
            await options.ensureProjectRegistered?.(options.directory, db);
        }
        const embeddingSnapshot = getProjectEmbeddingSnapshot(options.projectPath);
        const memoryEnabled = embeddingSnapshot?.features.memoryEnabled ?? options.memoryEnabled;
        const embeddingEnabled = embeddingSnapshot
            ? embeddingSnapshot.enabled || embeddingSnapshot.gitCommitEnabled
            : options.embeddingEnabled;
        const gitCommitsEnabled =
            embeddingSnapshot?.gitCommitEnabled ?? options.gitCommitsEnabled ?? false;
        const searchOptions: UnifiedSearchOptions = {
            limit: AUTO_SEARCH_RESULT_LIMIT,
            memoryEnabled,
            embeddingEnabled,
            gitCommitsEnabled,
            embedQuery: async (text, signal) => {
                const result = await embedTextForProject(
                    options.projectPath,
                    text,
                    signal,
                    "query",
                );
                return result;
            },
            isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
            sources: [...AUTO_SEARCH_SOURCES],
        };
        delivery = await executeAutoSearchDelivery({
            db,
            sessionId,
            projectPath: options.projectPath,
            prompt: rawPrompt,
            searchOptions,
            scoreThreshold: options.scoreThreshold,
            ...(memoryEnabled !== false && options.kernelClient && options.directory
                ? {
                      kernelClient: options.kernelClient({
                          sessionId,
                          projectRoot: resolveProjectRootDirectory(options.directory),
                      }),
                  }
                : {}),
        });
    } catch (error) {
        delivery = { status: "incomplete", kind: "search-failure", error };
    }

    if (delivery.status === "incomplete") {
        // On retryable failure, the transform does not persist a no-hint decision so a later pass re-evaluates the message.
        log(
            `[auto-search] unified search failed for session ${sessionId} (will retry next pass): ${delivery.error instanceof Error ? delivery.error.message : String(delivery.error)}`,
        );
        return { ok: false, kind: "search-failure" };
    }

    if (delivery.reason === "timeout") {
        // On timeout, the transform skips persistence of a no-hint decision so a later pass re-evaluates the message.
        sessionLog(
            sessionId,
            `auto-search: timed out after ${AUTO_SEARCH_TIMEOUT_MS}ms, skipping hint for this turn (will retry)`,
        );
        return { ok: false, kind: "timeout" };
    }

    const results = delivery.prePack;
    if (delivery.reason === "packer-empty") {
        return writeNoHintAndReconcile("empty");
    }
    if (
        delivery.reason === "empty" ||
        delivery.reason === "memory-abstained" ||
        delivery.reason === "memory-unavailable"
    ) {
        return writeNoHintAndReconcile(delivery.reason);
    }
    if (delivery.reason === "below-threshold") {
        sessionLog(
            sessionId,
            `auto-search: top score ${results[0].score.toFixed(3)} below threshold ${options.scoreThreshold}`,
        );
        return writeNoHintAndReconcile("below-threshold");
    }

    const hintText = delivery.hintText;

    const payload = `\n\n${hintText}`;
    // Any anti-memory fragment marks the persisted decision as non-replayable;
    // ordinary kernel hits persist an empty fragment list and replay.
    const { warningResults, memoryFragments } = collectAntiMemoryWarningFragments(
        delivery.delivered,
    );
    const outcome = appendAutoSearchHintDecision(db, sessionId, {
        messageId: userMsgId,
        decision: "hint",
        text: payload,
        memoryFragments,
    });
    if (!outcome.ok) {
        sessionLog(sessionId, `auto-search: CAS exhausted for ${userMsgId}; skipping wire append`);
        return { ok: false, kind: "cas-exhaustion" };
    }
    if (outcome.kind === "appended" && warningResults.length > 0) {
        // A freshly delivered warning bypasses replay; later passes cannot re-serve it.
        appendReminderToUserMessageById(messages, userMsgId, payload);
    } else {
        replayHintIfEligible(outcome.decision);
    }
    sessionLog(
        sessionId,
        `auto-search: attached hint to ${userMsgId} (${results.length} fragments, top score ${results[0].score.toFixed(3)})`,
    );
    return AUTO_SEARCH_OK;
}

/** Session cleanup hook — call on session.deleted. */
export function clearAutoSearchForSession(_sessionId: string): void {}
