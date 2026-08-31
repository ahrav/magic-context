/**
 *
 *
 */

/** Assumes four characters per token. */
export const CHARS_PER_TOKEN = 4;

export function ballastProse(tokens: number): string {
    if (tokens <= 0) return "";
    const words = [
        "boundary",
        "historian",
        "compartment",
        "schedule",
        "pressure",
        "tokens",
        "window",
        "publish",
        "transform",
        "session",
        "marker",
        "budget",
        "eligible",
        "protected",
        "ordinal",
        "snapshot",
        "replay",
        "decision",
        "threshold",
        "baseline",
        "measure",
        "archive",
        "deliver",
    ];
    const target = Math.max(0, Math.round(tokens * CHARS_PER_TOKEN));
    const parts: string[] = [];
    let length = 0;
    let i = 0;
    while (length < target) {
        const w = words[i % words.length];
        parts.push(`${w}${i % 17 === 0 ? "." : ""}`);
        length += w.length + 1;
        i += 1;
    }
    return parts.join(" ");
}
