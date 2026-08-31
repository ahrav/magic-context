import { isRecord } from "../../shared/record-type-guard";

/**
 * Providers that reject empty assistant content receive this non-empty placeholder.
 *
 * `stripDroppedPlaceholderMessages`, `stripSystemInjectedMessages`, and `replaySentinelByMessageIds` can reduce an assistant message to `{ role: "assistant", content: "" }`.
 * The `@ai-sdk/anthropic` branch filters empty text and reasoning parts before sending them to the provider.
 *
 * A non-empty placeholder keeps the wire valid and tells the model that content was dropped.
 */
export const WHOLE_MESSAGE_PLACEHOLDER_TEXT = "[dropped]";

/**
 *
 * The `@ai-sdk/anthropic` branch filters empty text and reasoning parts before sending them to the provider.
 * empty-part filter.
 *
 */
export function modelAcceptsEmptyContent(providerID?: string): boolean {
    return providerID === "anthropic";
}

/**
 *
 *
 * Anthropic and Bedrock cache prompt-rendered configuration, so configuration changes cause a natural cache bust.
 *
 *
 *
 */
export function variantChangeBustsProviderCache(providerID?: string): boolean {
    if (providerID === undefined) return true;
    if (providerID === "anthropic") return true;
    if (providerID === "google-vertex-anthropic") return true;
    if (providerID.includes("bedrock")) return true;
    return false;
}

/**
 * Replace stripped message parts with empty-text sentinels to preserve array length and indices across passes.
 * across passes.
 *
 *
 * Call sites must call this helper only when `modelAcceptsEmptyContent()` returns `true`.
 * For non-Anthropic providers, empty text parts can reach the wire and break provider-specific adjacency or non-empty-content invariants.
 *
 */
export function makeSentinel(originalPart: unknown): {
    type: "text";
    text: string;
} & Record<string, unknown> {
    const sentinel: { type: "text"; text: string } & Record<string, unknown> = {
        type: "text",
        text: "",
    };
    if (isRecord(originalPart)) {
        if (originalPart.cache_control !== undefined) {
            sentinel.cache_control = originalPart.cache_control;
        }
        if (originalPart.cacheControl !== undefined) {
            sentinel.cacheControl = originalPart.cacheControl;
        }
    }
    return sentinel;
}

/**
 *
 * The canonical Anthropic provider receives an empty-text sentinel.
 * Other providers receive the `[dropped]` sentinel because they may reject empty text parts.
 *
 */
export function makeWholeMessageSentinel(
    providerID?: string,
): { type: "text"; text: string } & Record<string, unknown> {
    return {
        type: "text",
        text: modelAcceptsEmptyContent(providerID) ? "" : WHOLE_MESSAGE_PLACEHOLDER_TEXT,
    };
}

/**
 * Strip functions skip existing sentinels so replay remains idempotent.
 * Strip functions do not recount or mutate an existing sentinel.
 * installed.
 *
 */
export function isSentinel(part: unknown): boolean {
    if (!isRecord(part)) return false;
    if (part.type !== "text") return false;
    if (typeof part.text !== "string") return false;
    return part.text === "" || part.text === WHOLE_MESSAGE_PLACEHOLDER_TEXT;
}

/**
 * OpenCode rebuilds messages from its DB between defer passes, so replay preserves the neutralized wire shape.
 * Messages in `ids` were neutralized before OpenCode rebuilt them from its DB.
 * Replay neutralizes messages in `ids` again after OpenCode rebuilds them.
 *
 * The live session provider determines whether replay installs `""` or `[dropped]`.
 * Callers must pass the live session's provider.
 * gets `""`.
 *
 * Callers can remove IDs absent from `messages` from the persisted set.
 */
export function replaySentinelByMessageIds(
    messages: Array<{ info: { id?: string }; parts: unknown[] }>,
    ids: Set<string>,
    providerID?: string,
): { replayed: number; missingIds: string[] } {
    if (ids.size === 0) return { replayed: 0, missingIds: [] };
    const seen = new Set<string>();
    let replayed = 0;
    for (const msg of messages) {
        const id = msg.info.id;
        if (!id || !ids.has(id)) continue;
        seen.add(id);
        if (msg.parts.length === 1 && isSentinel(msg.parts[0])) continue;
        msg.parts.length = 0;
        msg.parts.push(makeWholeMessageSentinel(providerID));
        replayed++;
    }
    const missingIds: string[] = [];
    for (const id of ids) if (!seen.has(id)) missingIds.push(id);
    return { replayed, missingIds };
}
