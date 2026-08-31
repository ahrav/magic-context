/**
 *
 *
 */

const MAX_PROBES = 5;
const MIN_PROBE_LENGTH = 3;

const SLASH_COMMAND_RE = /\/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/gi;
const KEBAB_SNAKE_RE = /[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+/gi;
const DOTTED_RE = /[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)+/gi;
const CAMEL_RE = /\b[a-zA-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g;
const SHA_RE = /\b[0-9a-f]{7,40}\b/gi;
const ERROR_CODE_RE = /\b(?:TS\d{4,}|ERR_[A-Z][A-Z0-9_]*)\b/g;
const QUOTED_RE = /["`]([^"`]{3,80})["`]/g;

// The digit requirement excludes hex-only words such as `feedface`.
function looksLikeSha(token: string): boolean {
    return /[0-9]/.test(token) && /^[0-9a-f]{7,40}$/i.test(token);
}

/**
 */
export function extractLiteralProbes(query: string): string[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const ordered: string[] = [];
    const seen = new Set<string>();

    const add = (raw: string | undefined): void => {
        if (!raw) return;
        const probe = raw.trim();
        if (probe.length < MIN_PROBE_LENGTH) return;
        const key = probe.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        ordered.push(probe);
    };

    const full = (): boolean => ordered.length >= MAX_PROBES;

    const shapes: Array<[RegExp, (m: RegExpMatchArray) => string | undefined]> = [
        [QUOTED_RE, (m) => m[1]],
        [SLASH_COMMAND_RE, (m) => m[0]],
        [ERROR_CODE_RE, (m) => m[0]],
        [DOTTED_RE, (m) => m[0]],
        [KEBAB_SNAKE_RE, (m) => m[0]],
        [CAMEL_RE, (m) => m[0]],
        [SHA_RE, (m) => (looksLikeSha(m[0]) ? m[0] : undefined)],
    ];
    for (const [pattern, pick] of shapes) {
        for (const m of trimmed.matchAll(pattern)) {
            if (full()) return ordered;
            add(pick(m));
        }
    }

    return ordered;
}

/**
 * */
export function containsProbeVerbatim(text: string, probes: string[]): boolean {
    if (probes.length === 0) return false;
    const haystack = text.toLowerCase();
    return probes.some((probe) => haystack.includes(probe.toLowerCase()));
}
