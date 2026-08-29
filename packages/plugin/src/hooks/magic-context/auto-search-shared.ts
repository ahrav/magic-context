import type {
    UnifiedSearchOptions,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import { unifiedSearch } from "../../features/magic-context/search";
import type { Database } from "../../shared/sqlite";

/** Hard cap on how long the transform hot path waits for unified search to finish.
 *  If the configured embedding provider is slow or saturated, we abandon the hint for this
 *  turn and let the next user turn try again. Transform must never hang on auto-search. */
export const AUTO_SEARCH_TIMEOUT_MS = 3_000;

/** Race `unifiedSearch` against a timer. Resolves with results on success, or `null` on timeout.
 *  On timeout, the AbortController fires so the underlying HTTP embed request is cancelled —
 *  this prevents dangling fetches from piling up at the provider (e.g. LMStudio saturation). */
export async function unifiedSearchWithTimeout(
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
                memoryPolicySurface: "auto_search",
            }),
            timeoutPromise,
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** True when the raw user text already carries a search augmentation
 *  or auto-hint block — in which case auto-search should skip so we don't double
 *  up. This runs on the RAW text (before stripping) because the whole point is
 *  to detect what the stripper would remove. */
export function hasStackedAugmentation(rawText: string): boolean {
    return (
        rawText.includes("<sidekick-augmentation>") ||
        rawText.includes("<ctx-search-hint>") ||
        rawText.includes("<ctx-search-auto>")
    );
}
