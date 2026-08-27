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
 * text mass a runner later sends. That equality is the whole point, so there is
 * no knob to vary the output: `tokens` alone determines the bytes. A previous
 * `seed` parameter that rotated the word-bank start position had no caller and
 * was an active hazard — the freeze lint rotated it per turn while every harness
 * used the default, so lint measured a transcript no runner sends. If per-turn
 * variation is ever wanted, it has to arrive here and in the harnesses'
 * `ballast()` signatures together, or the divergence comes back.
 */
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
    const target = Math.max(0, Math.round(tokens * 4)); // ~4 chars/token
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
