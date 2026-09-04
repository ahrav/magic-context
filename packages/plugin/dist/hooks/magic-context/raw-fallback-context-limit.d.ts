export declare class RawFallbackContextLimitError extends Error {
    readonly estimatedTokens: number;
    readonly contextLimitTokens: number;
    readonly code = "RAW_FALLBACK_CONTEXT_LIMIT";
    readonly recoverable = true;
    constructor(estimatedTokens: number, contextLimitTokens: number, options?: {
        cause?: unknown;
    });
}
//# sourceMappingURL=raw-fallback-context-limit.d.ts.map