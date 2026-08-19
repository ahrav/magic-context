/**
 * Transform-time auto-search hint runner.
 *
 * When a new user message arrives, optionally run ctx_search against the user's
 * prompt and append a caveman-compressed "vague recall" fragment hint to that
 * message. The hint nudges the agent to run ctx_search for full context rather
 * than injecting the content directly.
 *
 * Cache safety:
 *   - Attaches to the latest user message (the message that triggered the turn),
 *     never to message[0] or to any assistant message. Appending to the current
 *     user message happens BEFORE it reaches Anthropic's cache because this
 *     transform runs on the prompt path — same property as note nudges.
 *   - Idempotent via in-memory turn cache + `.includes()` guard in
 *     appendReminderToUserMessageById. On defer passes we re-append the same
 *     text; `.includes()` makes that a no-op.
 *   - New user turn (different message id) → compute fresh hint, new append.
 *   - Process restart → cache cleared; next pass will recompute but the user
 *     message is a fresh turn anyway, no provider cache to preserve yet.
 */

import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import type {
    UnifiedSearchOptions,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import { unifiedSearch } from "../../features/magic-context/search";
import {
    type AutoSearchHintNoHintReason,
    appendAutoSearchHintDecision,
    getAutoSearchHintDecisions,
} from "../../features/magic-context/storage-meta-persisted";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { packAutoSearchHint } from "./auto-search-hint";
import {
    AUTO_SEARCH_RESULT_LIMIT,
    AUTO_SEARCH_SOURCES,
    extractBoundedAutoSearchQuery,
} from "./auto-search-prompt";
import { hasMeaningfulUserText } from "./read-session-formatting";
import { appendReminderToUserMessageById } from "./transform-message-helpers";
import type { MessageLike } from "./transform-operations";

/** Hard cap on how long the transform hot path waits for unified search to finish.
 *  If the configured embedding provider is slow or saturated, we abandon the hint for this
 *  turn and let the next user turn try again. Transform must never hang on auto-search. */
const AUTO_SEARCH_TIMEOUT_MS = 3_000;

/** Race `unifiedSearch` against a timer. Resolves with results on success, or `null` on timeout.
 *  On timeout, the AbortController fires so the underlying HTTP embed request is cancelled —
 *  this prevents dangling fetches from piling up at the provider (e.g. LMStudio saturation). */
async function unifiedSearchWithTimeout(
    db: Database,
    sessionId: string,
    projectPath: string,
    prompt: string,
    options: UnifiedSearchOptions,
    timeoutMs: number,
): Promise<UnifiedSearchResult[] | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(null);
        }, timeoutMs);
    });
    try {
        return await Promise.race([
            unifiedSearch(db, sessionId, projectPath, prompt, {
                ...options,
                signal: controller.signal,
                // Plugin-internal auto-surfacing: do NOT count these as real
                // retrievals. The agent may never actually consume the hint,
                // and counting inflates retrieval_count-based memory
                // promotion decisions with false-positive signal.
                countRetrievals: false,
            }),
            timeoutPromise,
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

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

/** Below-threshold, empty, packer-empty, and timeout are completed
 *  empty-delivery outcomes. Search failures are incomplete evidence, not
 *  empty rankings. */
export type AutoSearchDelivery =
    | {
          status: "complete";
          reason: AutoSearchDeliveryReason;
          hintText: string | null;
          prePack: UnifiedSearchResult[];
          delivered: UnifiedSearchResult[];
          tokenCount: number;
          omittedCount: number;
      }
    | { status: "incomplete"; kind: "search-failure"; error: unknown };

function emptyDelivery(
    reason: AutoSearchDeliveryReason,
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
 * `runAutoSearchHint` delegates here, so structured callers observe the same
 * source restrictions, timeout, and packing the transform applies.
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
    const packed = packAutoSearchHint(results);
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
    /** Memory ids already rendered in the injected <session-history> block —
     *  skip fragments that just duplicate visible memories. */
    visibleMemoryIds?: Set<number>;
}

export function collectUserPromptParts(message: MessageLike): string {
    let collected = "";
    for (const part of message.parts) {
        // Persisted parts can hydrate as null (invalid JSON or a literal
        // "null" row); one malformed part must not abort the whole message.
        if (part === null || typeof part !== "object") continue;
        const p = part as { type?: string; text?: string; ignored?: boolean };
        if (p.type !== "text" || typeof p.text !== "string") continue;
        // Skip plugin-internal ignored notifications (conflict warnings, TUI setup
        // notices, startup announcements, etc.). They're persisted as ordinary
        // user-role messages but should never reach embeddings or hint detection.
        if (p.ignored === true) continue;
        collected += (collected.length > 0 ? "\n" : "") + p.text;
    }
    return collected;
}

/** Tests whether the user message already carries a stacked plugin augmentation
 *  or auto-hint block — in which case auto-search should skip so we don't double
 *  up. This runs on the RAW text (before stripping) because the whole point is
 *  to detect what the stripper would remove. Exported so candidate recovery
 *  applies the same eligibility gate the live path applies. */
export function hasStackedAugmentation(rawText: string): boolean {
    return (
        rawText.includes("<sidekick-augmentation>") ||
        rawText.includes("<ctx-search-hint>") ||
        rawText.includes("<ctx-search-auto>")
    );
}

function extractUserPromptText(message: MessageLike): string {
    // Strip all plugin-owned injections AND any other XML/HTML markup so the
    // embedded prompt is just what the user actually typed. Without this:
    //
    //  - Every embedded query would carry "§NNN§ " tag prefixes, temporal
    //    markers, plugin nudges, and any other XML the user (or an upstream
    //    extension) included in their message. That noise distorts semantic
    //    similarity scores and leaks plugin-internal markup into local
    //    embedding endpoint logs (LMStudio, openai-compatible, etc).
    //
    //  - Specific allowlists missed real cases: pasted code with `<Component>`,
    //    quoted XML from another tool's output, ALFONSO/OMO markers we hadn't
    //    enumerated yet, and so on. A generic strip catches all of them.
    return extractBoundedAutoSearchQuery(collectUserPromptParts(message));
}

function findLatestMeaningfulUserMessage(messages: MessageLike[]): MessageLike | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg.info.role !== "user") continue;
        if (typeof msg.info.id !== "string") continue;
        // hasMeaningfulUserText filters parts that should never reach embeddings:
        //   - ignored: true notifications (announcement, conflict warning, TUI setup)
        //   - system reminders, OMO internal initiator markers
        //   - system-directive-only stubs
        // The previous inline check accepted any non-empty text part, which let
        // ignored plugin-internal messages (e.g. the v0.21.7 startup announcement)
        // reach the embedding endpoint as if they were real user prompts.
        if (hasMeaningfulUserText(msg.parts)) {
            return msg;
        }
    }
    return null;
}

/**
 * Entry point. Called from transform post-processing. No-op when disabled,
 * when there is no meaningful user message, when prompt is too short, when
 * search returns nothing strong enough, or when the hint has already been
 * appended for this turn.
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

    const existing = getAutoSearchHintDecisions(db, sessionId);
    const existingForMessage = existing.find((decision) => decision.messageId === userMsgId);
    if (existingForMessage) {
        if (existingForMessage.decision === "hint") {
            appendReminderToUserMessageById(messages, userMsgId, existingForMessage.text);
        }
        return AUTO_SEARCH_OK;
    }

    // Live-tail gate: only compute a NEW hint when the meaningful user message is
    // the actual last element of the array (a just-arrived user turn the assistant
    // has not answered yet). `findLatestMeaningfulUserMessage` returns the latest
    // user message even when it is BURIED behind a queued-message race or a
    // mid-turn assistant tail — appending a fresh hint there would mutate an
    // already-cached message and bust everything after it (the Bust-B class). On a
    // non-tail pass we only replay persisted decisions (handled above); we never
    // create a new one. A note-nudger-style `triggerMessageId` deferral would be
    // wrong here: auto-search has no trigger event and runs every pass, so a
    // deferral gate would either no-op or permanently suppress.
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
        if (outcome.kind === "already-present" && outcome.decision.decision === "hint") {
            appendReminderToUserMessageById(messages, userMsgId, outcome.decision.text);
        }
        return AUTO_SEARCH_OK;
    };

    // New turn — compute hint fresh. Suppression check must run BEFORE stripping
    // because the stripper removes the exact tags that signal "already augmented".
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
            // Hard-filter memories already rendered in <session-history>.
            // unifiedSearch applies this during memory merging so ranking
            // can't be distorted by already-visible hits.
            visibleMemoryIds: options.visibleMemoryIds ?? null,
            // Primers v1 are cache-neutral: they surface via explicit ctx_search
            // and dashboard only, never transform-time auto-search prompt hints.
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
        // Retryable failure — do NOT persist a permanent no-hint decision, or the
        // hint would be suppressed forever for this message even though the next
        // pass might succeed. Just skip this pass; a later pass re-evaluates.
        log(
            `[auto-search] unified search failed for session ${sessionId} (will retry next pass): ${delivery.error instanceof Error ? delivery.error.message : String(delivery.error)}`,
        );
        return { ok: false, kind: "search-failure" };
    }

    if (delivery.reason === "timeout") {
        // Timeout is also retryable — skip without persisting a no-hint decision.
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
    if (!hintText) {
        return writeNoHintAndReconcile("empty");
    }

    // Prefix with double newline so the hint is a separate block, not glued
    // onto the last word of the user's prompt.
    const payload = `\n\n${hintText}`;
    const outcome = appendAutoSearchHintDecision(db, sessionId, {
        messageId: userMsgId,
        decision: "hint",
        text: payload,
    });
    if (!outcome.ok) {
        sessionLog(sessionId, `auto-search: CAS exhausted for ${userMsgId}; skipping wire append`);
        return { ok: false, kind: "cas-exhaustion" };
    }
    if (outcome.decision.decision === "hint") {
        appendReminderToUserMessageById(messages, userMsgId, outcome.decision.text);
    }
    sessionLog(
        sessionId,
        `auto-search: attached hint to ${userMsgId} (${results.length} fragments, top score ${results[0].score.toFixed(3)})`,
    );
    return AUTO_SEARCH_OK;
}

/** Test hook — wipe the per-turn cache. */
export function _resetAutoSearchCache(): void {
    // Decisions are persisted in SQLite; retained as a no-op compatibility hook for tests.
}

/** Session cleanup hook — call on session.deleted. */
export function clearAutoSearchForSession(_sessionId: string): void {
    // Decisions are session_meta state and are removed by clearSession().
}
