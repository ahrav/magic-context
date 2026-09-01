/**
 *
 *
 *      truncation.
 *
 * Body truncation removes oldest main-log lines before other report sections when a report exceeds its body budget.
 *
 */

/**
 * `MAX_GITHUB_BODY_BYTES` reserves 5,536 bytes below GitHub's 65,536-byte body limit.
 */
export const MAX_GITHUB_BODY_BYTES = 60_000;

const LOG_TRUNCATION_MARKER = "[truncated for GitHub 64KB limit — older log lines dropped]\n";
const FINAL_TRUNCATION_MARKER = "\n\n[truncated further to fit GitHub body limit]\n";
const FALLBACK_TRUNCATION_MARKER = "\n\n[truncated for GitHub 64KB limit]\n";

/**
 * The stack-frame patterns retain frames to identify the failing call site.
 *
 * The `failed:` pattern excludes status counts such as `0 failed`.
 */
const ERROR_LOG_PATTERNS = [
    /\bfailed:/i,
    /\b(?:[A-Z][a-zA-Z]*)?Error:\s/,
    /\bEMERGENCY\b/,
    /\bexception\b/i,
    /^\s+at\s+[\w.<>$]+\s+\(/,
    /^\s+at\s+(?:file:|node_modules\/|[^/\s]+:\d+)/,
];

function isErrorLogLine(line: string): boolean {
    return ERROR_LOG_PATTERNS.some((rx) => rx.test(line));
}

/**
 * `extractRecentErrors` returns matches oldest-first so issue bodies read chronologically.
 *
 */
export function extractRecentErrors(sanitized: string, limit = 20): string[] {
    const matches: string[] = [];
    const lines = sanitized.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && matches.length < limit; i -= 1) {
        if (isErrorLogLine(lines[i])) {
            matches.push(lines[i]);
        }
    }
    return matches.reverse();
}

/**
 * When the expected log fence exists, the function drops oldest log lines before enforcing the final limit.
 * The rendered body must place the main log fence after `## Log (last`.
 * slice.
 *
 * shrink first.
 *
 * `capBodyToGithubLimit` measures its budget in UTF-8 bytes.
 */
export function capBodyToGithubLimit(
    body: string,
    maxBytes: number = MAX_GITHUB_BODY_BYTES,
): string {
    if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;

    let capped = body;

    const heading = "## Log (last";
    const headingIdx = body.indexOf(heading);
    if (headingIdx === -1) {
        const markerBytes = Buffer.byteLength(FALLBACK_TRUNCATION_MARKER, "utf8");
        capped = truncateToByteBudget(body, maxBytes - markerBytes) + FALLBACK_TRUNCATION_MARKER;
        return enforceFinalBodyLimit(capped, maxBytes);
    }

    const fenceOpenIdx = body.indexOf("\n```", headingIdx);
    if (fenceOpenIdx === -1) return enforceFinalBodyLimit(body, maxBytes);
    const logStart = fenceOpenIdx + "\n```\n".length;
    const fenceCloseIdx = body.indexOf("\n```", logStart);
    if (fenceCloseIdx === -1) return enforceFinalBodyLimit(body, maxBytes);

    const head = body.slice(0, logStart);
    const log = body.slice(logStart, fenceCloseIdx);
    const tail = body.slice(fenceCloseIdx);

    const overheadBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
    const markerBytes = Buffer.byteLength(LOG_TRUNCATION_MARKER, "utf8");
    const logBudget = maxBytes - overheadBytes - markerBytes;
    if (logBudget <= 0) {
        capped = `${head}${LOG_TRUNCATION_MARKER}${tail}`;
        return enforceFinalBodyLimit(capped, maxBytes);
    }

    const lines = log.split("\n");
    let keepLines = lines;
    let kept = keepLines.join("\n");
    while (Buffer.byteLength(kept, "utf8") > logBudget && keepLines.length > 1) {
        // Dropping batches of oldest lines accelerates convergence for oversized logs.
        const dropCount = Math.max(1, Math.floor(keepLines.length * 0.05));
        keepLines = keepLines.slice(dropCount);
        kept = keepLines.join("\n");
    }
    // A single log line can exceed `logBudget` after all other lines are removed.
    if (Buffer.byteLength(kept, "utf8") > logBudget) {
        kept = truncateToByteBudget(kept, logBudget);
    }

    capped = `${head}${LOG_TRUNCATION_MARKER}${kept}${tail}`;
    return enforceFinalBodyLimit(capped, maxBytes);
}

function enforceFinalBodyLimit(body: string, maxBytes: number): string {
    if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
    const markerBytes = Buffer.byteLength(FINAL_TRUNCATION_MARKER, "utf8");
    if (markerBytes >= maxBytes) {
        return truncateToByteBudget(FINAL_TRUNCATION_MARKER, maxBytes);
    }
    return truncateToByteBudget(body, maxBytes - markerBytes) + FINAL_TRUNCATION_MARKER;
}

/**
 * Naive `Buffer.subarray(...).toString("utf8")` can split a multibyte code point.
 * A partial UTF-8 code point decodes as U+FFFD (3 bytes).
 * Replacement with U+FFFD can make the decoded output exceed `maxBytes`.
 * happens mid-character.
 *
 */
function truncateToByteBudget(input: string, maxBytes: number): string {
    if (maxBytes <= 0) return "";
    const buf = Buffer.from(input, "utf8");
    if (buf.length <= maxBytes) return input;
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) {
        end -= 1;
    }
    return buf.subarray(0, end).toString("utf8");
}
