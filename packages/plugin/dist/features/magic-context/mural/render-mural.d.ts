/** Maximum canvas extent; sparse renders use only the needed snapped extent. */
export declare const MURAL_WIDTH = 1092;
export declare const MURAL_HEIGHT = 1092;
/** Anthropic vision image-token tiles are 28 pixels on each side. */
export declare const MURAL_VISION_TILE = 28;
export declare const MURAL_FONT = "spleen-5x8";
/** Spleen's 5px cell includes its own blank right-side column for letter spacing. */
export declare const MURAL_CELL_WIDTH = 5;
export declare const MURAL_CELL_HEIGHT = 8;
export declare const MURAL_LINE_PITCH = 9;
export declare const MURAL_COLUMNS = 3;
export declare const MURAL_COLUMN_GAP = 1;
/** Keep the historical 72-character maximum so murals remain compatible with the prior single-column layout and its line-width limit. */
export declare const MURAL_ROOM_WIDTH = 72;
export declare const MURAL_ROWS: number;
export declare const MURAL_LINE_CAPACITY: number;
export type MuralCategory = string;
/** A flat mural entry to render. No rooms, no merges — resolveMural produces a
 *  pre-ordered flat list (category band → importance DESC → id ASC) and the
 *  renderer packs it deterministically into the capped image. */
export interface MuralRenderEntry {
    id: string;
    category: MuralCategory;
    importance: number;
    cue: string;
}
export interface MuralLayoutItem {
    kind: "category" | "entry";
    category: MuralCategory;
    column: number;
    startLine: number;
    endLine: number;
}
export interface MuralRenderResult {
    png: Uint8Array;
    dataUrl: string;
    muralText: string;
    sha256Input: string;
    placements: Map<string, {
        category: MuralCategory;
        column: number;
        line: number;
    }>;
    layoutItems: MuralLayoutItem[];
    renderedIds: string[];
    /** Entries trimmed because the capped image filled before reaching them. */
    droppedIds: string[];
    categoryLineUsage: Record<string, number>;
    /** Content lines actually placed in the grid (excludes blank cells). Used to
     *  assert the three-column fill occupancy. */
    filledLineCount: number;
    /** PNG dimensions after content cropping and vision-tile snapping. */
    width: number;
    height: number;
}
/**
 * Render the deterministic mural from a pre-ordered flat entry list. Zero LLM,
 * pure function of its input — callable any time. Category bands, bullet lines,
 * shared-pair packing, fitted word-wrap, balanced columns, and prohibition ink
 * are all preserved from the author-era renderer; rooms and merges are gone.
 */
export declare function renderMural(entries: readonly MuralRenderEntry[]): MuralRenderResult;
/** Anthropic charges one visual token per 28x28 image patch. */
export declare function muralImageTokenEstimateForDimensions(width: number, height: number): number;
export declare const muralImageTokenEstimate: number;
//# sourceMappingURL=render-mural.d.ts.map