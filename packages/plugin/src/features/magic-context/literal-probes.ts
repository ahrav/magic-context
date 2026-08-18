/**
 * Extract high-signal literal tokens ("probes") from a search query.
 *
 * Why this exists: `sanitizeFtsQuery` AND-joins every token, so a long natural-
 * language query like "why did ctx-status tool calls inflate" only matches a
 * message that contains ALL those words. A message that contains the literal
 * symbol `/ctx-status` but not the other six words is never retrieved — pure
 * recall loss, unfixable by ranking. Running each literal probe as its OWN FTS
 * query (in addition to the full query) recovers those candidates.
 *
 * Tuned for a PROSE / CONVERSATION corpus (memories + raw chat + commit
 * messages), NOT code: we look for the symbol/command/path/identifier shapes
 * that appear verbatim in conversation and that a paraphrased NL query would
 * otherwise drown. Plain prose yields zero probes, so NL queries are unaffected.
 */

const MAX_PROBES = 5;
const MIN_PROBE_LENGTH = 3;

// Slash command: /ctx-status, /ctx-session-upgrade
const SLASH_COMMAND_RE = /\/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/gi;
// hyphen/underscore identifiers: ctx-status, git_sweep_coordinator, memory_block_ids
const KEBAB_SNAKE_RE = /[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+/gi;
// dotted identifiers / file paths: search.ts, memory.auto_search, inject-compartments.ts
const DOTTED_RE = /[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)+/gi;
// camelCase / PascalCase identifiers: getMessageOrdinal, materializeM0, RawMessage
const CAMEL_RE = /\b[a-zA-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g;
// commit SHAs (7–40 hex). Bounded to avoid matching ordinary decimal numbers.
const SHA_RE = /\b[0-9a-f]{7,40}\b/gi;
// error / type codes: TS2345, ERR_FOO_BAR
const ERROR_CODE_RE = /\b(?:TS\d{4,}|ERR_[A-Z][A-Z0-9_]*)\b/g;
// quoted spans: "exact phrase" or `exact phrase` (capture inner text)
const QUOTED_RE = /["`]([^"`]{3,80})["`]/g;

// A SHA regex would also match a 7+ hex run inside a longer word; require the
// whole token to be hex (the \b guards handle this) AND contain a digit so we
// don't flag prose words like "feedface" — rare, but cheap to exclude.
function looksLikeSha(token: string): boolean {
    return /[0-9]/.test(token) && /^[0-9a-f]{7,40}$/i.test(token);
}

/**
 * Pull literal probes from a query, most-specific shapes first, deduplicated
 * (case-insensitive) and capped. Returns [] for plain natural-language text.
 * Extraction stops when the MAX_PROBES prioritized slots are full — later
 * shapes are never scanned once the cap is reached.
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

    // Order matters: quoted spans and slash commands are the most intentional
    // literal signals, so they get the earliest (highest-priority) probe slots
    // before the cap stops extraction.
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

/** True when a probe appears verbatim (case-insensitive) in the text. Used to
 *  boost candidates that contain the exact literal the user searched for. */
export function containsProbeVerbatim(text: string, probes: string[]): boolean {
    if (probes.length === 0) return false;
    const haystack = text.toLowerCase();
    return probes.some((probe) => haystack.includes(probe.toLowerCase()));
}
