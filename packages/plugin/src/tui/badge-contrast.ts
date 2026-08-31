/**
 * `theme.accent` background).
 *
 *
 *
 */

type Color = { r: number; g: number; b: number; a?: number };

const MIN_OPAQUE_ALPHA = 0.5;

const MIN_CHANNEL_DISTANCE = 0.06;

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
 */
export function readableTextColorOn(bg: Color): string {
    return relativeLuminance(bg) < LIGHT_ACCENT_LUMINANCE ? "#ffffff" : "#000000";
}

/**
 */
export function badgeTextColor<T extends Color>(accent: T, background: T): T | string {
    const alpha = background.a ?? 1;
    if (alpha >= MIN_OPAQUE_ALPHA && !nearlyEqual(accent, background)) {
        return background;
    }
    return readableTextColorOn(accent);
}
