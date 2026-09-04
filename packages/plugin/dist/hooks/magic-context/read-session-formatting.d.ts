export interface SessionChunkLine {
    ordinal: number;
    messageId: string;
}
export interface ChunkBlock {
    role: string;
    startOrdinal: number;
    endOrdinal: number;
    parts: string[];
    meta: SessionChunkLine[];
    commitHashes: string[];
    /**
     * True when every part in this block came from tool-call summaries only
     * (no textual narrative from the user or assistant). Historian often skips
     * such blocks — that's safe as long as we know the skipped range is
     * tool-only, so we mark the block here and let validation absorb the gap.
     */
    isToolOnly: boolean;
}
export declare function hasMeaningfulUserText(parts: unknown[]): boolean;
export declare function extractTexts(parts: unknown[]): string[];
/** Extract compact tool-call summaries from message parts.
 *  Returns lines like "TC: Fix lint errors" or "TC: read(src/index.ts)". */
export declare function extractToolCallSummaries(parts: unknown[]): string[];
export { estimateTokens, preloadTokenizer } from "../../shared/token-estimator";
export declare function normalizeText(text: string): string;
export declare function compactRole(role: string): string;
export declare function formatBlock(block: ChunkBlock): string;
export declare function extractCommitHashes(text: string): string[];
export declare function compactTextForSummary(text: string, role: string): {
    text: string;
    commitHashes: string[];
};
export declare function mergeCommitHashes(existing: string[], next: string[]): string[];
//# sourceMappingURL=read-session-formatting.d.ts.map