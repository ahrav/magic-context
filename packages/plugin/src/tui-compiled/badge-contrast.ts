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

type Color = { r: number; g: number; b: number; a?: number };

// Below this alpha the theme background is too transparent to read as a label on
// the accent (issue #186: background:"none" resolves to alpha 0).
const MIN_OPAQUE_ALPHA = 0.5;

// If the theme background and accent are within this per-channel distance they
// are effectively the same color, so background-on-accent text is unreadable.
const MIN_CHANNEL_DISTANCE = 0.06;

// Luminance midpoint for the fallback pick: accents below this keep white text,
// accents at/above it (light/pastel/near-white) get black. White-biased relative
// to the strict equal-contrast crossover (~0.179) so saturated mid-tone accents
// stay white. Only consulted on the degenerate fallback path.
const LIGHT_ACCENT_LUMINANCE = 0.5;

function srgbChannelToLinear(c: number): number {
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(bg: Color): number {
    return (
        0.2126 * srgbChannelToLinear(bg.r) +
        0.7152 * srgbChannelToLinear(bg.g) +
        0.0722 * srgbChannelToLinear(bg.b)
    );
}

function nearlyEqual(a: Color, b: Color): boolean {
    return (
        Math.abs(a.r - b.r) < MIN_CHANNEL_DISTANCE &&
        Math.abs(a.g - b.g) < MIN_CHANNEL_DISTANCE &&
        Math.abs(a.b - b.b) < MIN_CHANNEL_DISTANCE
    );
}

/**
 * Pure black/white pick by accent luminance. Used as the badge fallback and kept
 * exported for callers that only have the accent.
 */
export function readableTextColorOn(bg: Color): string {
    return relativeLuminance(bg) < LIGHT_ACCENT_LUMINANCE ? "#ffffff" : "#000000";
}

/**
 * Badge label color on the accent: the theme background (AFT parity) when it is
 * usable, else a guaranteed-visible black/white fallback. Returns the passed-in
 * `background` reference unchanged on the primary path.
 */
export function badgeTextColor<T extends Color>(accent: T, background: T): T | string {
    const alpha = background.a ?? 1;
    if (alpha >= MIN_OPAQUE_ALPHA && !nearlyEqual(accent, background)) {
        return background;
    }
    return readableTextColorOn(accent);
}
