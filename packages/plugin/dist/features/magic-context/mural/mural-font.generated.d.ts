export interface MuralFontGlyph {
    readonly rows: readonly number[];
    readonly width: number;
    readonly advance: number;
}
export declare const MURAL_FONT_CELL_WIDTH = 5;
export declare const MURAL_FONT_CELL_HEIGHT = 8;
export declare const MURAL_FONT_LINE_PITCH = 9;
export declare const MURAL_FONT_GLYPHS: Readonly<Record<string, MuralFontGlyph>>;
/** Visible, deterministic replacement for characters outside the generated atlas. */
export declare const MURAL_FONT_REPLACEMENT_GLYPH: MuralFontGlyph;
//# sourceMappingURL=mural-font.generated.d.ts.map