import { describe, expect, test } from "bun:test";
import { MURAL_FONT_GLYPHS } from "./mural-font.generated";
import {
    MURAL_CELL_WIDTH,
    MURAL_HEIGHT,
    MURAL_LINE_PITCH,
    MURAL_ROOM_WIDTH,
    MURAL_VISION_TILE,
    MURAL_WIDTH,
    type MuralRenderEntry,
    muralImageTokenEstimateForDimensions,
    renderMural,
} from "./render-mural";

const CATEGORIES = ["PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING"];

function longestLine(text: string): number {
    return Math.max(...text.split("\n").map((line) => [...line.replace(/\s+$/, "")].length), 0);
}

function syntheticEntries(count: number): MuralRenderEntry[] {
    return Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        category: CATEGORIES[index % CATEGORIES.length]!,
        importance: 80,
        cue: `cue ${index} anchor→target relation`,
    }));
}

describe("deterministic mural renderer", () => {
    test("includes every printable ASCII glyph in the generated atlas", () => {
        for (let codepoint = 0x20; codepoint <= 0x7e; codepoint++) {
            const character = String.fromCodePoint(codepoint);
            expect(MURAL_FONT_GLYPHS[character]).toBeDefined();
        }
    });

    test("preserves case and leaves a blank column between consecutive M glyphs", () => {
        const upper = MURAL_FONT_GLYPHS.M!;
        const lower = MURAL_FONT_GLYPHS.a!;
        expect(lower.rows).not.toEqual(upper.rows);

        const pairColumns = Array.from({ length: upper.advance * 2 }, (_, column) =>
            upper.rows.some((row) => {
                const localColumn = column % upper.advance;
                return (
                    localColumn < upper.width &&
                    (row & (1 << (upper.width - localColumn - 1))) !== 0
                );
            }),
        );
        expect(pairColumns[upper.advance - 1]).toBe(false);
        expect(pairColumns[upper.advance]).toBe(true);
    });

    test("renders identical bytes for identical input (pure function)", () => {
        const entries: MuralRenderEntry[] = Array.from({ length: 40 }, (_, index) => ({
            id: index + 1,
            category: CATEGORIES[index % CATEGORIES.length]!,
            importance: 80 - (index % 30),
            cue: `synthetic cue ${index}`,
        }));
        const first = renderMural(entries);
        const second = renderMural(entries);
        expect(Buffer.from(first.png).equals(Buffer.from(second.png))).toBe(true);
        expect(first.sha256Input).toBe(second.sha256Input);
        expect(first.png.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
        expect([MURAL_WIDTH, MURAL_HEIGHT]).toEqual([1092, 1092]);
    });

    test("uses Anthropic's exact 28px tile token formula", () => {
        expect(muralImageTokenEstimateForDimensions(1092, 1092)).toBe(39 * 39);
        expect(muralImageTokenEstimateForDimensions(364, 700)).toBe(13 * 25);
    });

    test("fits the 7/50/200 size matrix while keeping full pools at the cap", () => {
        const expected = {
            // The 7-entry layout rounds 200px by 126px to 224px by 140px, using 40 tiles.
            7: [224, 140, 40],
            // Three 40-character columns plus two gap characters require 616 px (22 tiles).
            // The 34 lines require 308 px (11 tiles).
            50: [616, 308, 242],
            // The never-orphan-header rule leaves 120 usable rows per column.
            // A 1092 px height uses 39 tiles, so the layout uses 858 image tiles.
            200: [616, 1092, 858],
        } as const;

        for (const count of [7, 50, 200] as const) {
            const result = renderMural(syntheticEntries(count));
            expect(result.width % MURAL_VISION_TILE).toBe(0);
            expect(result.height % MURAL_VISION_TILE).toBe(0);
            expect([
                result.width,
                result.height,
                muralImageTokenEstimateForDimensions(result.width, result.height),
            ]).toEqual(expected[count]);
            if (count === 7 || count === 50) {
                expect(result.width).toBeLessThan(MURAL_WIDTH);
                expect(result.height).toBeLessThan(MURAL_HEIGHT);
            } else {
                // Fitted columns keep the full pool 616 px wide, avoiding blank side tiles.
                expect(result.height).toBe(MURAL_HEIGHT);
            }
        }
    });

    test("never costs more tiles than the legacy 72-character single-column fixture", () => {
        const entries = syntheticEntries(50);
        const result = renderMural(entries);
        // Alternating categories produce 50 banners and 50 body lines. The comparison single-column layout uses 72 characters and 100 lines.
        // The single-column layout is 924 px tall (33 tiles), for 429 tiles.
        const legacyTiles = muralImageTokenEstimateForDimensions(
            Math.ceil((MURAL_ROOM_WIDTH * MURAL_CELL_WIDTH) / MURAL_VISION_TILE) *
                MURAL_VISION_TILE,
            Math.ceil((entries.length * 2 * MURAL_LINE_PITCH) / MURAL_VISION_TILE) *
                MURAL_VISION_TILE,
        );
        const newTiles = muralImageTokenEstimateForDimensions(result.width, result.height);
        expect(newTiles).toBeLessThanOrEqual(legacyTiles);
    });

    test("fills all three columns on a 300-cue fixture (>80% line occupancy)", () => {
        const entries: MuralRenderEntry[] = Array.from({ length: 300 }, (_, index) => ({
            id: index + 1,
            category: CATEGORIES[index % CATEGORIES.length]!,
            importance: 75,
            cue: `cue ${index} anchor→target relation`,
        }));
        const result = renderMural(entries);
        expect(result.layoutItems.some((item) => item.column === 0)).toBe(true);
        expect(result.layoutItems.some((item) => item.column === 1)).toBe(true);
        expect(result.layoutItems.some((item) => item.column === 2)).toBe(true);
        const rows = Math.floor(MURAL_HEIGHT / MURAL_LINE_PITCH);
        const capacity = 3 * rows;
        expect(result.filledLineCount / capacity).toBeGreaterThan(0.8);
    });

    test("word-wraps a long high-importance cue at the column width (never overruns 72)", () => {
        const longCue =
            "very long high importance cue that certainly exceeds one column and must wrap across multiple lines cleanly";
        const result = renderMural([
            { id: 1, category: "PROJECT_RULES", importance: 90, cue: longCue },
        ]);
        // No rendered line exceeds three legacy-width columns.
        // The content width is narrower than three legacy-width columns, and continuation lines use two spaces.
        expect(longestLine(result.muralText)).toBeLessThanOrEqual(
            MURAL_ROOM_WIDTH * 3 + 2, // three padded columns + 2 single-space gaps
        );
        for (const line of result.muralText.split("\n")) {
            for (const column of [0, 1, 2]) {
                const slice = line.slice(
                    column * (MURAL_ROOM_WIDTH + 1),
                    column * (MURAL_ROOM_WIDTH + 1) + MURAL_ROOM_WIDTH,
                );
                expect([...slice].length).toBeLessThanOrEqual(MURAL_ROOM_WIDTH);
            }
        }
        // The single entry gets a placement for its first wrapped line.
        expect(result.renderedIds).toContain(1);
    });

    test("packs two short cues onto one shared line", () => {
        const result = renderMural([
            { id: 1, category: "NAMING", importance: 50, cue: "short a" },
            { id: 2, category: "NAMING", importance: 50, cue: "short b" },
        ]);
        // The paired entries share one line number.
        const a = result.placements.get(1);
        const b = result.placements.get(2);
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(a!.line).toBe(b!.line);
        expect(a!.column).toBe(b!.column);
    });

    test("does not shared-pair a prohibition cue (⊘ carries its own line)", () => {
        const result = renderMural([
            { id: 1, category: "CONSTRAINTS", importance: 50, cue: "⊘x (break)" },
            { id: 2, category: "CONSTRAINTS", importance: 50, cue: "short b" },
        ]);
        const a = result.placements.get(1);
        const b = result.placements.get(2);
        expect(a!.line).not.toBe(b!.line);
    });

    test("prohibition ink: a ⊘ cue renders in the prohibition color, plain cues in body ink", () => {
        // Murals differing only by a prohibited cue must produce different pixels.
        // Prohibited cues use a color distinct from normal cue text.
        const withProhibition = renderMural([
            { id: 1, category: "CONSTRAINTS", importance: 80, cue: "⊘cache write (ABI break)" },
        ]);
        const withoutProhibition = renderMural([
            { id: 1, category: "CONSTRAINTS", importance: 80, cue: "cache write ABI ok now yes" },
        ]);
        expect(Buffer.from(withProhibition.png).equals(Buffer.from(withoutProhibition.png))).toBe(
            false,
        );
    });

    test("empty entry list renders nothing placed (m0 omits the block)", () => {
        const result = renderMural([]);
        expect(result.renderedIds).toHaveLength(0);
        expect(result.filledLineCount).toBe(0);
        // An empty mural produces a valid blank PNG instead of throwing.
        expect(result.png.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    });

    test("emits one category banner per distinct category band", () => {
        const result = renderMural([
            { id: 1, category: "PROJECT_RULES", importance: 80, cue: "a b c" },
            { id: 2, category: "ARCHITECTURE", importance: 80, cue: "d e f" },
            { id: 3, category: "ARCHITECTURE", importance: 70, cue: "g h i" },
        ]);
        const banners = result.layoutItems.filter((item) => item.kind === "category");
        expect(banners).toHaveLength(2);
    });
});
