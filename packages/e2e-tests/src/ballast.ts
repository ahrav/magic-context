/**
 * Shared deterministic prose ballast for the e2e suite.
 *
 * The protected-tail boundary (v3) is SIZE-based: it measures the true-raw
 * token content of the session, not the mock's fabricated usage numbers, so
 * pressure-driving turns must carry real content mass. Varied word bank (not
 * single-char repeats): BPE tokenizers degrade pathologically on degenerate
 * repeats, and varied prose tokenizes at a stable rate so the size math holds.
 *
 * One implementation feeds every consumer — the TS/pi/rust harnesses and the
 * historian-eval freeze lint — so the text mass a lint measures is the same
 * text mass a runner later sends. `seed` rotates the word-bank start position
 * (same seed → same bytes, every run).
 */
export function ballastProse(tokens: number, seed = 0): string {
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
    const target = Math.max(0, Math.round(tokens * 4)); // ~4 chars/token
    const parts: string[] = [];
    let length = 0;
    let i = seed % words.length;
    while (length < target) {
        const w = words[i % words.length];
        parts.push(`${w}${i % 17 === 0 ? "." : ""}`);
        length += w.length + 1;
        i += 1;
    }
    return parts.join(" ");
}
