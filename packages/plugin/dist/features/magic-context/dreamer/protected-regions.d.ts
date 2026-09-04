export interface EnforceProtectedRegionsResult {
    /** The text to persist (candidate, repaired candidate, or original on reject). */
    text: string;
    violated: boolean;
}
export interface ProtectedBlock {
    /** Full identifying start-marker line (the line containing mc:protected START). */
    startMarkerLine: string;
    /** Bytes from START line through END line inclusive. */
    block: string;
}
/** Extract every mc:protected region from `text`, keyed by the full START marker line. */
export declare function extractProtectedBlocks(text: string): ProtectedBlock[];
/**
 * Enforce that every mc:protected region present in `original` is byte-identical
 * in `candidate`. Returns the text to actually write and whether a violation was repaired.
 */
export declare function enforceProtectedRegions(original: string, candidate: string): EnforceProtectedRegionsResult;
//# sourceMappingURL=protected-regions.d.ts.map