/**
 * Build a compact "you may recall something related" hint from unified search
 * results, ready to append to a user message.
 *
 * The hint intentionally compresses fragments so they feel like vague recall
 * rather than a drop-in answer — the goal is to nudge the agent to run
 * ctx_search for full context, not to provide the answer itself.
 *
 * Compression strategy per source:
 *   - memory → caveman-ultra via `cavemanCompress()` (token-dense)
 *   - git_commit → raw commit subject (already terse); prefixed with SHA + age
 *   - message → caveman-ultra, role tag
 *
 * Guardrails:
 *   - Every dynamic source field is bounded to MAX_RENDER_FIELD_BYTES of
 *     valid UTF-8 BEFORE compression or tokenization, so the budget check
 *     itself never performs unbounded work
 *   - Ordinary fragments use a small character cap. Anti-memory warnings use
 *     bounded fields so their complete warning contract remains visible.
 *   - Skip fragments whose source is already present in visible session-history
 *     (caller handles) — this module only knows about search results
 *   - Total output is token-packed under MAX_AUTO_HINT_TOKENS: an over-budget
 *     fragment is omitted whole while the wrapper and footer cue stay intact
 */
import type { UnifiedSearchResult } from "../../features/magic-context/search";
export interface AutoSearchHintOptions {
    maxFragments?: number;
    fragmentCharCap?: number;
    /** Reference clock for age wording; injectable so a fingerprinted
     *  benchmark scenario renders identical bytes on any day. */
    nowMs?: number;
    /** Minimum score a warning must reach to claim the reserved first slot.
     *  Defaults to 0, which reserves the slot for any warning present. */
    warningScoreThreshold?: number;
}
/** `delivered` contains exactly the results whose fragments appear in
 *  `text`, in fragment order. `text` is null when nothing packs. */
export interface PackedAutoSearchHint {
    text: string | null;
    delivered: UnifiedSearchResult[];
    tokenCount: number;
    omittedCount: number;
}
/**
 * Packs the hint under MAX_AUTO_HINT_TOKENS and reports which results
 * survived. An over-budget fragment is dropped whole from the tail; a lone
 * over-budget fragment yields a null text with an empty delivered list
 * rather than a partially emitted hint.
 *
 * This function does NOT enforce the caller's general score or message-length
 * gates — the transform-time auto-search wiring applies those first. The one
 * exception is `warningScoreThreshold`, because the reserved warning slot is
 * this function's own decision: it promotes a warning past the caller's
 * ranking, so the bar that warning must clear has to be enforced where the
 * promotion happens or every caller has to remember to pre-filter.
 */
export declare function packAutoSearchHint(results: UnifiedSearchResult[], options?: AutoSearchHintOptions): PackedAutoSearchHint;
/**
 * Build the hint text. Returns null when `results` is empty, when no fragment
 * has meaningful content after compression, or when limits zero out the budget.
 */
export declare function buildAutoSearchHint(results: UnifiedSearchResult[], options?: AutoSearchHintOptions): string | null;
export interface AntiMemoryWarningDelivery {
    /** Delivered warning results, in delivery order. */
    warningResults: Extract<UnifiedSearchResult, {
        source: "anti_memory";
    }>[];
    /** Claim identity + normalized hash bindings for the persisted hint
     *  decision. A non-empty list marks the decision non-replayable: warning
     *  delivery always requires a fresh search rather than stored text. */
    memoryFragments: Array<{
        id: number;
        hash: string;
    }>;
}
/** One definition of "which delivered fragments are anti-memory warnings and
 * what identity binds them", shared by the OpenCode and Pi auto-search
 * runners so the deliver-or-replay contract cannot drift between harnesses. */
export declare function collectAntiMemoryWarningFragments(delivered: readonly UnifiedSearchResult[]): AntiMemoryWarningDelivery;
//# sourceMappingURL=auto-search-hint.d.ts.map