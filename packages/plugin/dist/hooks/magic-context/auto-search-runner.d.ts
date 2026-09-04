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
import type { UnifiedSearchOptions, UnifiedSearchResult } from "../../features/magic-context/search";
import type { Database } from "../../shared/sqlite";
import type { MessageLike } from "./transform-operations";
export type AutoSearchOutcome = {
    ok: true;
} | {
    ok: false;
    kind: "timeout" | "search-failure" | "cas-exhaustion";
};
export type AutoSearchDeliveryReason = "delivered" | "empty" | "below-threshold" | "packer-empty" | "timeout";
/** Below-threshold, empty, packer-empty, and timeout are completed
 *  empty-delivery outcomes. Search failures are incomplete evidence, not
 *  empty rankings. The delivered variant carries a non-null hint by
 *  construction (the packer-empty branch already rejected a null pack), so
 *  consumers need no defensive null re-check after discriminating on
 *  `reason`. */
export type AutoSearchDelivery = {
    status: "complete";
    reason: "delivered";
    hintText: string;
    prePack: UnifiedSearchResult[];
    delivered: UnifiedSearchResult[];
    tokenCount: number;
    omittedCount: number;
} | {
    status: "complete";
    reason: Exclude<AutoSearchDeliveryReason, "delivered">;
    hintText: null;
    prePack: UnifiedSearchResult[];
    delivered: UnifiedSearchResult[];
    tokenCount: number;
    omittedCount: number;
} | {
    status: "incomplete";
    kind: "search-failure";
    error: unknown;
};
/**
 * `runAutoSearchHint` delegates here, so structured callers observe the same
 * source restrictions, timeout, and packing the transform applies.
 * Persistence and message mutation stay with the transform caller.
 */
export declare function executeAutoSearchDelivery(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    prompt: string;
    searchOptions: UnifiedSearchOptions;
    scoreThreshold: number;
    timeoutMs?: number;
    /** Reference clock for hint age wording (defaults to the live clock);
     *  the benchmark injects the scenario's fixed reference time. */
    packNowMs?: number;
}): Promise<AutoSearchDelivery>;
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
export declare function collectUserPromptParts(message: MessageLike): string;
/** Tests whether the user message already carries a stacked plugin augmentation
 *  or auto-hint block — in which case auto-search should skip so we don't double
 *  up. This runs on the RAW text (before stripping) because the whole point is
 *  to detect what the stripper would remove. Exported so candidate recovery
 *  applies the same stacked-augmentation gate as the live path. */
export declare function hasStackedAugmentation(rawText: string): boolean;
/**
 * Entry point. Called from transform post-processing. No-op when disabled,
 * when there is no meaningful user message, when prompt is too short, when
 * search returns nothing strong enough, or when the hint has already been
 * appended for this turn.
 */
export declare function runAutoSearchHint(args: {
    sessionId: string;
    db: Database;
    messages: MessageLike[];
    options: AutoSearchRunnerOptions;
}): Promise<AutoSearchOutcome>;
/** Test hook — wipe the per-turn cache. */
export declare function _resetAutoSearchCache(): void;
/** Session cleanup hook — call on session.deleted. */
export declare function clearAutoSearchForSession(_sessionId: string): void;
//# sourceMappingURL=auto-search-runner.d.ts.map