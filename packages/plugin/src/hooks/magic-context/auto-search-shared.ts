import type {
    UnifiedSearchOptions,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import { unifiedSearch } from "../../features/magic-context/search";
import type { KernelMemorySnapshot } from "../../shared/kernel-client";
import type { Database } from "../../shared/sqlite";

/** Hard cap on how long the transform hot path waits for unified search to finish.
 *  If the configured embedding provider is slow or saturated, we abandon the hint for this
 *  turn and let the next user turn try again. Transform must never hang on auto-search. */
export const AUTO_SEARCH_TIMEOUT_MS = 3_000;

export interface TimedAutoSearch {
    results: UnifiedSearchResult[];
    /** `null` when the caller supplied no memory reader. */
    memory: KernelMemorySnapshot | null;
}

/**
 * Races `unifiedSearch` and the optional kernel memory read against one timer.
 * Resolves with both on success, or `null` on timeout. The one `AbortController`
 * cancels the embed request and the kernel call together, so neither outlives
 * the turn that asked for them.
 */
export async function unifiedSearchWithTimeout(
    db: Database,
    sessionId: string,
    projectPath: string,
    prompt: string,
    options: UnifiedSearchOptions,
    timeoutMs: number,
    readMemory?: (signal: AbortSignal, deadlineMs: number) => Promise<KernelMemorySnapshot>,
): Promise<TimedAutoSearch | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(null);
        }, timeoutMs);
    });
    const search = async (): Promise<TimedAutoSearch> => {
        const [results, memory] = await Promise.all([
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
            readMemory ? readMemory(controller.signal, timeoutMs) : Promise.resolve(null),
        ]);
        return { results, memory };
    };
    try {
        return await Promise.race([search(), timeoutPromise]);
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
