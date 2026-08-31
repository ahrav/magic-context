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
import { recordDeliveredAntiMemoryUsage } from "../../features/magic-context/memory/storage-claim-operations";
import { autoSearchHintFragmentsStillEligible } from "../../features/magic-context/memory/storage-claim-visibility";
import type {
    UnifiedSearchOptions,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import {
    type AutoSearchHintDecision,
    type AutoSearchHintNoHintReason,
    appendAutoSearchHintDecision,
    getAutoSearchHintDecisions,
} from "../../features/magic-context/storage-meta-persisted";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
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
    | "below-threshold"
    | "packer-empty"
    | "timeout";

/** Below-threshold, empty, packer-empty, and timeout are completed empty-delivery outcomes.
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
export async function executeAutoSearchDelivery(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    prompt: string;
    searchOptions: UnifiedSearchOptions;
    scoreThreshold: number;
    timeoutMs?: number;
    /** The reference clock defaults to the live clock for hint-age wording.
     * */
    packNowMs?: number;
}): Promise<AutoSearchDelivery> {
    let results: UnifiedSearchResult[] | null;
    try {
        results = await unifiedSearchWithTimeout(
            args.db,
            args.sessionId,
            args.projectPath,
            args.prompt,
            args.searchOptions,
            args.timeoutMs ?? AUTO_SEARCH_TIMEOUT_MS,
        );
    } catch (error) {
        return { status: "incomplete", kind: "search-failure", error };
    }
    if (results === null) {
        return emptyDelivery("timeout", []);
    }
    if (results.length === 0) {
        return emptyDelivery("empty", results);
    }
    if (results[0].score < args.scoreThreshold) {
        return emptyDelivery("below-threshold", results);
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
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    gitCommitsEnabled?: boolean;
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

    // Persisted anti-memory warnings never replay; each warning requires a fresh search.
    // Ordinary hints carry no memory fragments and can replay.
    const replayHintIfEligible = (decision: AutoSearchHintDecision): void => {
        if (decision.decision !== "hint") return;
        if (!autoSearchHintFragmentsStillEligible(db, decision.memoryFragments)) {
            sessionLog(
                sessionId,
                `auto-search: suppressing persisted anti-memory warning for ${decision.messageId} — fresh search required`,
            );
            return;
        }
        appendReminderToUserMessageById(messages, decision.messageId, decision.text);
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
    if (delivery.reason === "empty" || delivery.reason === "packer-empty") {
        return writeNoHintAndReconcile("empty");
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
    // Any anti-memory fragment marks the persisted decision as non-replayable.
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
        appendReminderToUserMessageById(messages, userMsgId, payload);
        recordDeliveredAntiMemoryUsage(db, warningResults);
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
export function clearAutoSearchForSession(_sessionId: string): void {
}
