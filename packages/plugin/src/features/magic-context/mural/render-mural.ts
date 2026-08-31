import { deflateSync } from "node:zlib";

import {
    MURAL_FONT_CELL_HEIGHT,
    MURAL_FONT_CELL_WIDTH,
    MURAL_FONT_GLYPHS,
    MURAL_FONT_LINE_PITCH,
    MURAL_FONT_REPLACEMENT_GLYPH,
    type MuralFontGlyph,
} from "./mural-font.generated";

/** Maximum canvas extent; sparse renders use only the needed snapped extent. */
export const MURAL_WIDTH = 1_092;
export const MURAL_HEIGHT = 1_092;
/** Anthropic vision image-token tiles are 28 pixels on each side. */
export const MURAL_VISION_TILE = 28;
/** Spleen's 5px cell includes its own blank right-side column for letter spacing. */
export const MURAL_CELL_WIDTH = MURAL_FONT_CELL_WIDTH;
export const MURAL_CELL_HEIGHT = MURAL_FONT_CELL_HEIGHT;
export const MURAL_LINE_PITCH = MURAL_FONT_LINE_PITCH;
export const MURAL_COLUMNS = 3;
export const MURAL_COLUMN_GAP = 1;
/** Width bounds keep sparse murals compact without making their columns unreadably narrow. */
const MURAL_MIN_ROOM_WIDTH = 40;
/** The 72-character maximum preserves compatibility with the single-column line-width limit. */
export const MURAL_ROOM_WIDTH = 72;
export const MURAL_ROWS = Math.floor(MURAL_HEIGHT / MURAL_LINE_PITCH);

export type MuralCategory = string;

/** MuralRenderEntry represents a flat entry; resolveMural orders entries by category, descending importance, then ascending id.
 * The renderer packs entries deterministically into the capped image. */
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
    placements: Map<string, { category: MuralCategory; column: number; line: number }>;
    layoutItems: MuralLayoutItem[];
    renderedIds: string[];
    /** Entries trimmed because the capped image filled before reaching them. */
    droppedIds: string[];
    categoryLineUsage: Record<string, number>;
    /** filledLineCount excludes blank cells.
     * */
    filledLineCount: number;
    /** width and height report PNG dimensions after content cropping and vision-tile snapping. */
    width: number;
    height: number;
}

const CATEGORY_COLORS: Record<string, readonly [number, number, number]> = {
    PROJECT_RULES: [24, 58, 112],
    ARCHITECTURE: [0, 88, 92],
    CONSTRAINTS: [126, 76, 16],
    CONFIG_VALUES: [88, 52, 132],
    NAMING: [28, 98, 58],
};
const BODY_INK: readonly [number, number, number] = [18, 20, 24];
const PROHIBITION_INK: readonly [number, number, number] = [148, 28, 35];

function codepoints(value: string): number {
    return [...value].length;
}

function escapeText(value: string): string {
    return value
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function banner(category: MuralCategory, roomWidth: number): string {
    const label = ` <${category}> `;
    if (codepoints(label) > roomWidth) {
        return [...label].slice(0, roomWidth).join("");
    }
    const remaining = roomWidth - codepoints(label);
    return `${"─".repeat(Math.floor(remaining / 2))}${label}${"─".repeat(Math.ceil(remaining / 2))}`;
}

/** Break tokens wider than width into width-sized slices because word-wrap cannot split unbreakable tokens.
 * */
function breakLongToken(token: string, width: number): string[] {
    const chars = [...token];
    if (chars.length <= width) return [token];
    const slices: string[] = [];
    for (let i = 0; i < chars.length; i += width) {
        slices.push(chars.slice(i, i + width).join(""));
    }
    return slices;
}

/**
 * Bullet the first line and indent continuation lines two spaces to distinguish wrapped cues from category bars.
 */
function wrapCue(cue: string, width: number): string[] {
    const continuationIndent = "  ";
    const words = escapeText(cue)
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((word) => breakLongToken(word, Math.max(1, width - continuationIndent.length)));
    if (words.length === 0) return ["•"];
    const lines: string[] = [];
    let line = "•";
    for (const word of words) {
        const separator = line === "•" ? "" : " ";
        const candidate = `${line}${separator}${word}`;
        if (codepoints(candidate) <= width) {
            line = candidate;
            continue;
        }
        lines.push(line);
        line = `${continuationIndent}${word}`;
    }
    lines.push(line);
    return lines;
}

interface PlannedLine {
    text: string;
    /** The line records entry IDs whose bodies start on it; a shared pair records two IDs. */
    entryIds: string[];
    isBanner: boolean;
    category: MuralCategory;
}

function canShareCues(cue: string, nextCue: string, roomWidth: number): boolean {
    const shortEntryLimit = Math.floor((roomWidth - 4) / 2);
    const shared = `•${cue} • ${nextCue}`;
    return (
        !cue.includes("⊘") &&
        !nextCue.includes("⊘") &&
        codepoints(cue) <= shortEntryLimit &&
        codepoints(nextCue) <= shortEntryLimit &&
        codepoints(shared) <= roomWidth
    );
}

/**
 * Width selection measures unwrapped lines, including category labels.
 * Category labels contribute to width measurement; decorative bars use the measured width.
 */
function naturalLineLengths(entries: readonly MuralRenderEntry[], roomWidth: number): number[] {
    const lengths: number[] = [];
    let currentCategory: string | null = null;
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        if (entry.category !== currentCategory) {
            currentCategory = entry.category;
            lengths.push(codepoints(` <${entry.category}> `));
        }

        const cue = escapeText(entry.cue);
        const next = entries[index + 1];
        const sameCategoryNext = next && next.category === entry.category;
        const nextCue = sameCategoryNext ? escapeText(next.cue) : "";
        if (sameCategoryNext && canShareCues(cue, nextCue, roomWidth)) {
            lengths.push(codepoints(`•${cue} • ${nextCue}`));
            index++;
        } else {
            lengths.push(1 + codepoints(cue));
        }
    }
    return lengths;
}

/** The width selector chooses the smallest bounded width that wraps at most 5% of lines. */
function chooseRoomWidth(entries: readonly MuralRenderEntry[]): number {
    for (let width = MURAL_MIN_ROOM_WIDTH; width <= MURAL_ROOM_WIDTH; width++) {
        const lengths = naturalLineLengths(entries, width);
        const allowedWrappedLines = Math.ceil(lengths.length * 0.05);
        const wrappedLines = lengths.filter((length) => length > width).length;
        if (wrappedLines <= allowedWrappedLines) return width;
    }
    return MURAL_ROOM_WIDTH;
}

/**
 * Shared-pair packing increases line density.
 * rest.
 */
function planLines(entries: readonly MuralRenderEntry[], roomWidth: number): PlannedLine[] {
    const lines: PlannedLine[] = [];
    let currentCategory: string | null = null;
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        if (entry.category !== currentCategory) {
            currentCategory = entry.category;
            lines.push({
                text: banner(entry.category, roomWidth),
                entryIds: [],
                isBanner: true,
                category: entry.category,
            });
        }

        const cue = escapeText(entry.cue);
        const next = entries[index + 1];
        const sameCategoryNext = next && next.category === entry.category;
        const nextCue = sameCategoryNext ? escapeText(next.cue) : "";
        if (sameCategoryNext && canShareCues(cue, nextCue, roomWidth)) {
            lines.push({
                text: `•${cue} • ${nextCue}`,
                entryIds: [entry.id, next.id],
                isBanner: false,
                category: entry.category,
            });
            index++;
            continue;
        }

        const wrapped = wrapCue(cue, roomWidth);
        wrapped.forEach((text, wrappedIndex) => {
            lines.push({
                text,
                // Only the first wrapped line anchors the entry's placement.
                entryIds: wrappedIndex === 0 ? [entry.id] : [],
                isBanner: false,
                category: entry.category,
            });
        });
    }
    return lines;
}

function splitPlan(plan: readonly PlannedLine[], columnCount: number): PlannedLine[][] {
    const columns: PlannedLine[][] = Array.from({ length: columnCount }, () => []);
    let offset = 0;
    for (let column = 0; column < columnCount && offset < plan.length; column++) {
        const remainingLines = plan.length - offset;
        const remainingColumns = columnCount - column;
        let take = Math.min(MURAL_ROWS, Math.ceil(remainingLines / remainingColumns));

        // Keep each category banner with at least one following body line.
        while (
            offset + take < plan.length &&
            take < MURAL_ROWS &&
            plan[offset + take - 1]?.isBanner
        ) {
            take++;
        }
        // If `take === MURAL_ROWS` ends on a banner, leave the row blank to avoid an orphaned category header.
        if (take === MURAL_ROWS && plan[offset + take - 1]?.isBanner) take--;
        if (take <= 0) break;

        columns[column] = plan.slice(offset, offset + take);
        offset += take;
    }
    return columns;
}

interface LayoutResult {
    text: string;
    grid: string[][];
    placements: MuralRenderResult["placements"];
    layoutItems: MuralLayoutItem[];
    renderedIds: string[];
    droppedIds: string[];
    usage: Record<string, number>;
    filledLineCount: number;
    columnCount: number;
    rowCount: number;
}

function renderLayout(
    entries: readonly MuralRenderEntry[],
    plan: readonly PlannedLine[],
    roomWidth: number,
    columnCount: number,
): LayoutResult {
    const grid = Array.from({ length: columnCount }, () =>
        Array.from({ length: MURAL_ROWS }, () => ""),
    );
    const placements: MuralRenderResult["placements"] = new Map();
    const layoutItems: MuralLayoutItem[] = [];
    const renderedIds: string[] = [];
    const placedIds = new Set<string>();
    const usage: Record<string, number> = {};
    let filledLineCount = 0;

    for (const [column, columnPlan] of splitPlan(plan, columnCount).entries()) {
        const columnGrid = grid[column];
        if (!columnGrid) continue;
        for (const [row, line] of columnPlan.entries()) {
            columnGrid[row] = line.text;
            filledLineCount += 1;
            usage[line.category] = (usage[line.category] ?? 0) + 1;
            const placementLine = row + 1;
            if (line.isBanner) {
                layoutItems.push({
                    kind: "category",
                    category: line.category,
                    column,
                    startLine: placementLine,
                    endLine: placementLine,
                });
            }
            for (const id of line.entryIds) {
                placements.set(id, {
                    category: line.category,
                    column,
                    line: placementLine,
                });
                if (!placedIds.has(id)) {
                    placedIds.add(id);
                    renderedIds.push(id);
                }
                layoutItems.push({
                    kind: "entry",
                    category: line.category,
                    column,
                    startLine: placementLine,
                    endLine: placementLine,
                });
            }
        }
    }

    const droppedIds = entries.filter((entry) => !placedIds.has(entry.id)).map((entry) => entry.id);
    const usedColumnCount = grid.reduce(
        (last, column, index) => (column.some(Boolean) ? index + 1 : last),
        0,
    );
    const rowCount = grid.reduce((last, column) => {
        for (let row = column.length - 1; row >= 0; row--) {
            if (column[row]) return Math.max(last, row + 1);
        }
        return last;
    }, 0);
    const textLines = Array.from({ length: rowCount }, (_, row) =>
        Array.from({ length: usedColumnCount }, (_, column) =>
            (grid[column]?.[row] ?? "").padEnd(roomWidth),
        ).join(" "),
    );
    return {
        text: `${textLines.join("\n")}\n`,
        grid,
        placements,
        layoutItems,
        renderedIds,
        droppedIds,
        usage,
        filledLineCount,
        columnCount: usedColumnCount,
        rowCount,
    };
}

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type);
    const output = new Uint8Array(12 + data.length);
    const view = new DataView(output.buffer);
    view.setUint32(0, data.length);
    output.set(typeBytes, 4);
    output.set(data, 8);
    view.setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length)));
    return output;
}

function encodeRgbPng(pixels: Uint8Array, width: number, height: number): Uint8Array {
    const raw = new Uint8Array((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        const rawStart = y * (width * 3 + 1);
        raw[rawStart] = 0;
        raw.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), rawStart + 1);
    }
    const ihdr = new Uint8Array(13);
    const header = new DataView(ihdr.buffer);
    header.setUint32(0, width);
    header.setUint32(4, height);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const compressed = new Uint8Array(deflateSync(raw, { level: 9 }));
    const chunks = [
        signature,
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", compressed),
        pngChunk("IEND", new Uint8Array()),
    ];
    const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}

/** The generated atlas uses Spleen glyph pixels; unknown characters use a visible, deterministic replacement glyph.
 * */
function glyph(character: string): MuralFontGlyph {
    return MURAL_FONT_GLYPHS[character] ?? MURAL_FONT_REPLACEMENT_GLYPH;
}

function drawGlyph(
    pixels: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
    character: string,
    color: readonly [number, number, number],
): void {
    const glyphData = glyph(character);
    const [red, green, blue] = color;
    for (let row = 0; row < MURAL_CELL_HEIGHT; row++) {
        const pattern = glyphData.rows[row] ?? 0;
        for (let column = 0; column < glyphData.width; column++) {
            if ((pattern & (1 << (glyphData.width - column - 1))) === 0) continue;
            const px = x + column;
            const py = y + row;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const offset = (py * width + px) * 3;
            pixels[offset] = red;
            pixels[offset + 1] = green;
            pixels[offset + 2] = blue;
        }
    }
}

function drawText(
    pixels: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
    text: string,
    color: readonly [number, number, number],
): void {
    let offset = 0;
    for (const character of [...text]) {
        drawGlyph(pixels, width, height, x + offset, y, character, color);
        offset += glyph(character).advance;
    }
}

function fillRect(
    pixels: Uint8Array,
    canvasWidth: number,
    canvasHeight: number,
    x: number,
    y: number,
    width: number,
    height: number,
    color: readonly [number, number, number],
): void {
    const [red, green, blue] = color;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(canvasWidth, x + width);
    const bottom = Math.min(canvasHeight, y + height);
    for (let py = top; py < bottom; py++) {
        for (let px = left; px < right; px++) {
            const offset = (py * canvasWidth + px) * 3;
            pixels[offset] = red;
            pixels[offset + 1] = green;
            pixels[offset + 2] = blue;
        }
    }
}

/** The layout rounds the content extent up to a complete vision tile without exceeding the cap. */
function snapDimensionToVisionTile(contentPixels: number, maximum: number): number {
    return Math.min(
        maximum,
        Math.max(
            MURAL_VISION_TILE,
            Math.ceil(contentPixels / MURAL_VISION_TILE) * MURAL_VISION_TILE,
        ),
    );
}

/**
 */
export function renderMural(entries: readonly MuralRenderEntry[]): MuralRenderResult {
    const roomWidth = chooseRoomWidth(entries);
    const plan = planLines(entries, roomWidth);
    const candidates = Array.from({ length: MURAL_COLUMNS }, (_, index) => {
        const requestedColumnCount = index + 1;
        const layout = renderLayout(entries, plan, roomWidth, requestedColumnCount);
        const contentWidth =
            layout.columnCount === 0
                ? 0
                : layout.columnCount * roomWidth * MURAL_CELL_WIDTH +
                  MURAL_COLUMN_GAP * (layout.columnCount - 1) * MURAL_CELL_WIDTH;
        const contentHeight = layout.rowCount * MURAL_LINE_PITCH;
        const width = snapDimensionToVisionTile(contentWidth, MURAL_WIDTH);
        const height = snapDimensionToVisionTile(contentHeight, MURAL_HEIGHT);
        return {
            requestedColumnCount,
            layout,
            width,
            height,
            tileArea: muralImageTokenEstimateForDimensions(width, height),
        };
    });

    // When no layout fits the full plan under the hard cap, maximize retained entries before minimizing tile area.
    const fittingCandidates = candidates.filter(
        (candidate) => candidate.layout.droppedIds.length === 0,
    );
    const candidatesToCompare = fittingCandidates.length > 0 ? fittingCandidates : candidates;
    const firstCandidate = candidatesToCompare[0];
    if (!firstCandidate) throw new Error("mural layout candidate list is empty");
    const selected = candidatesToCompare.reduce((best, candidate) => {
        if (!best) return candidate;
        if (
            fittingCandidates.length === 0 &&
            candidate.layout.renderedIds.length !== best.layout.renderedIds.length
        ) {
            return candidate.layout.renderedIds.length > best.layout.renderedIds.length
                ? candidate
                : best;
        }
        if (candidate.tileArea !== best.tileArea) {
            return candidate.tileArea < best.tileArea ? candidate : best;
        }
        return candidate.requestedColumnCount < best.requestedColumnCount ? candidate : best;
    }, firstCandidate);

    const { layout, width, height } = selected;
    const pixels = new Uint8Array(width * height * 3).fill(255);
    const contentWidth =
        layout.columnCount === 0
            ? 0
            : layout.columnCount * roomWidth * MURAL_CELL_WIDTH +
              MURAL_COLUMN_GAP * (layout.columnCount - 1) * MURAL_CELL_WIDTH;
    const left = Math.floor((width - contentWidth) / 2);
    for (let column = 0; column < layout.columnCount; column++) {
        for (let row = 0; row < layout.rowCount; row++) {
            const text = layout.grid[column]?.[row] ?? "";
            const isCategory = text.includes("<") && text.includes(">");
            const category = isCategory ? text.match(/<([^>]+)>/)?.[1] : undefined;
            if (isCategory)
                fillRect(
                    pixels,
                    width,
                    height,
                    left + column * (roomWidth + MURAL_COLUMN_GAP) * MURAL_CELL_WIDTH,
                    row * MURAL_LINE_PITCH,
                    roomWidth * MURAL_CELL_WIDTH,
                    MURAL_CELL_HEIGHT,
                    CATEGORY_COLORS[category ?? ""] ?? [72, 78, 86],
                );
            const ink = isCategory
                ? ([255, 255, 255] as const)
                : text.includes("⊘")
                  ? PROHIBITION_INK
                  : BODY_INK;
            drawText(
                pixels,
                width,
                height,
                left + column * (roomWidth + MURAL_COLUMN_GAP) * MURAL_CELL_WIDTH,
                row * MURAL_LINE_PITCH,
                text,
                ink,
            );
        }
    }
    const png = encodeRgbPng(pixels, width, height);
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    return {
        png,
        dataUrl,
        muralText: layout.text,
        sha256Input: layout.text,
        placements: layout.placements,
        layoutItems: layout.layoutItems,
        renderedIds: layout.renderedIds,
        droppedIds: layout.droppedIds,
        categoryLineUsage: layout.usage,
        filledLineCount: layout.filledLineCount,
        width,
        height,
    };
}

/* */
export function muralImageTokenEstimateForDimensions(width: number, height: number): number {
    return Math.ceil(width / MURAL_VISION_TILE) * Math.ceil(height / MURAL_VISION_TILE);
}
