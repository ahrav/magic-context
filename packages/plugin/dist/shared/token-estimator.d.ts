/**
 * Shared token estimation (KTD1 — search hard bounds).
 *
 * Extracted from `hooks/magic-context/read-session-formatting.ts` so feature
 * and tool code (search bounds, ctx_search rendering, auto-search hints) can
 * consume the same token-counting contract without depending on the transform
 * runtime hook module. The hook module re-exports these symbols, so existing
 * imports keep working.
 */
export declare function preloadTokenizer(): Promise<boolean>;
export declare function estimateTokens(text: string): number;
//# sourceMappingURL=token-estimator.d.ts.map