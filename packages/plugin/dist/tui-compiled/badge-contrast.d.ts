/**
 * Pick the text color for the sidebar header badge (a bold label drawn on a
 * `theme.accent` background).
 *
 * Primary rule (matches AFT's sidebar by construction): paint the theme's own
 * `background` color as the label, the inverse-of-panel look. Because it is a
 * fixed theme token rather than an accent-derived computation, MC's badge and
 * AFT's badge agree on EVERY accent automatically, so the same theme can never
 * make one badge black and the other white (issue #198).
 *
 * Fallback rule (the reason a luminance pick exists at all): `theme.background`
 * can be unusable as a label color in two degenerate cases, where it would
 * render the label invisible on the accent:
 *   1. Transparent background. Themes that respect terminal transparency set
 *      `background: "none"`, which resolves to `RGBA(0,0,0,0)`; drawing it as
 *      text renders fully transparent and the label disappears (issue #186).
 *   2. Background ~= accent. If the theme's background and accent are nearly the
 *      same color, background-on-accent text has no contrast.
 * In either case we fall back to a black/white pick that is guaranteed visible
 * on the always-opaque accent.
 *
 * `RGBA` channels from @opentui/core are normalized 0..1 floats (alpha included).
 * We accept the minimal `{ r, g, b, a? }` shape so this stays a pure, trivially
 * testable function independent of the native color class, and we return the
 * passed-in `background` object unchanged on the primary path so it stays the
 * exact same theme token AFT uses.
 */
type Color = {
    r: number;
    g: number;
    b: number;
    a?: number;
};
/**
 * Pure black/white pick by accent luminance. Used as the badge fallback and kept
 * exported for callers that only have the accent.
 */
export declare function readableTextColorOn(bg: Color): string;
/**
 * Badge label color on the accent: the theme background (AFT parity) when it is
 * usable, else a guaranteed-visible black/white fallback. Returns the passed-in
 * `background` reference unchanged on the primary path.
 */
export declare function badgeTextColor<T extends Color>(accent: T, background: T): T | string;
export {};
//# sourceMappingURL=badge-contrast.d.ts.map