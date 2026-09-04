/**
 * Shared token-budgeted rendering for explicit `ctx_search` output.
 *
 * OpenCode and Pi both render through this module so caps, ordering, and
 * formatted text cannot drift between harnesses (R39-R40). Each dynamic
 * result field is bounded to MAX_DYNAMIC_FIELD_BYTES of valid UTF-8 before
 * any tokenization, and packing keeps a ranked prefix of complete result
 * blocks under MAX_RENDERED_RESULT_TOKENS with reserved header, expand
 * hints, and omission notice.
 */
import type { AntiMemorySearchResult, UnifiedSearchResult } from "../../features/magic-context/search";
export declare function renderAntiMemoryWarning(result: AntiMemorySearchResult): string;
export type ExplicitDeliveryReason = "delivered" | "empty-results" | "packer-empty";
/** `delivered` contains exactly the results whose complete blocks appear in
 *  `text`, in rendered order. */
export interface PackedSearchResults {
    text: string;
    delivered: UnifiedSearchResult[];
    tokenCount: number;
    omittedCount: number;
    reason: ExplicitDeliveryReason;
}
/**
 * Packs the response under MAX_RENDERED_RESULT_TOKENS. Over-budget output
 * keeps a prefix of complete blocks and appends an omission notice — no
 * block is partially emitted. Empty results and a packer that cannot fit
 * even one block are completed empty-delivery outcomes, not failures.
 */
export declare function packSearchResults(query: string, results: UnifiedSearchResult[], currentSessionId: string, 
/** Reference clock for age wording; injectable so a fingerprinted
 *  benchmark scenario renders identical bytes on any day. */
nowMs?: number): PackedSearchResults;
//# sourceMappingURL=render.d.ts.map