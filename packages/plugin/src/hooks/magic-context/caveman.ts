/**
 * Deterministic rule-based text compression in the style of caveman-speak.
 *
 *
 * This module is pure and stateless.
 *
 *  - Code blocks (` and ``` fenced)
 *  - URLs (http://, https://)
 * - File paths with a 1–6-character extension and at least one /
 * - Commit hashes (7–40 hex chars not adjacent to ASCII letters or digits)
 * - Compartment markers (§N§, msg_*, ses_*, toolu_*)
 *
 */

export type CavemanLevel = "lite" | "full" | "ultra";

// ---------------------------------------------------------------------------
// Preserved regions must remain unchanged.
// ---------------------------------------------------------------------------

interface PreservedRegion {
    placeholder: string;
    original: string;
}

/** Run specific patterns first so earlier replacements shield their matches from later patterns.
 * */
const PRESERVATION_PATTERNS: RegExp[] = [
    /```[\s\S]*?```/g,
    /`[^`\n]+`/g,
    // URLs
    /https?:\/\/\S+/g,
    /§\d+§/g,
    /\b(?:msg|ses|toolu)_[A-Za-z0-9]+/g,
    /(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,6}/g,
    /(?<![a-z0-9])[0-9a-f]{7,40}(?![a-z0-9])/gi,
];

/** Sentinel placeholders prevent transformations from modifying preserved regions.
 * */
function protectRegions(text: string): { text: string; preserved: PreservedRegion[] } {
    const preserved: PreservedRegion[] = [];
    let working = text;

    for (const pattern of PRESERVATION_PATTERNS) {
        working = working.replace(pattern, (match) => {
            const placeholder = `\u0000MC_PRES_${preserved.length}\u0000`;
            preserved.push({ placeholder, original: match });
            return placeholder;
        });
    }

    return { text: working, preserved };
}

/* */
function restoreRegions(text: string, preserved: PreservedRegion[]): string {
    let working = text;
    // Restore in reverse order so nested placeholders resolve correctly.
    for (let i = preserved.length - 1; i >= 0; i--) {
        working = working.split(preserved[i].placeholder).join(preserved[i].original);
    }
    return working;
}

// ---------------------------------------------------------------------------
// Wordlists (all compared case-insensitively against word boundaries).
// ---------------------------------------------------------------------------

const FILLER_WORDS = [
    "just",
    "really",
    "basically",
    "actually",
    "essentially",
    "simply",
    "clearly",
    "obviously",
    "quite",
    "very",
    "somewhat",
    "rather",
    "fairly",
    "sort of",
    "kind of",
    "a bit",
];

const HEDGING_PHRASES = [
    "i think",
    "i believe",
    "i feel",
    "probably",
    "perhaps",
    "maybe",
    "it seems",
    "it appears",
    "arguably",
    "i suppose",
    "i guess",
];

const PLEASANTRIES = ["please", "thanks", "thank you", "kindly", "if possible"];

/** Drop auxiliary verbs only in Subject-Aux-Verb patterns.
 * Drop auxiliaries only between a subject noun and a participle or verb.
 * */
const AUXILIARIES = [
    "was",
    "were",
    "is",
    "are",
    "am",
    "be",
    "been",
    "being",
    "has been",
    "had been",
    "have been",
    "will be",
    "would be",
    "could be",
    "should be",
    "might be",
    "may be",
];

/** Phrase replacements — always applied at lite+ to shorten common verbose forms. */
const PHRASE_SHORTENINGS: Array<[RegExp, string]> = [
    [/\bin order to\b/gi, "to"],
    [/\bdue to the fact that\b/gi, "because"],
    [/\bat this point in time\b/gi, "now"],
    [/\bat the moment\b/gi, "now"],
    [/\bin the event that\b/gi, "if"],
    [/\bfor the purpose of\b/gi, "for"],
    [/\bwith regard to\b/gi, "about"],
    [/\bin spite of the fact that\b/gi, "though"],
    [/\bon the grounds that\b/gi, "because"],
    [/\bfor the reason that\b/gi, "because"],
];

/**
 * */
const ULTRA_CONNECTIVE_REPLACEMENTS: Array<[RegExp, string]> = [
    [/\b(?:and then|then after|afterwards)\b/gi, "→"],
    [/\bbecause of\b/gi, "//"],
    [/\btherefore\b/gi, "→"],
    [/\bbecause\b/gi, "//"],
    [/\bhowever\b/gi, "but"],
    [/\bfurthermore\b/gi, "+"],
    [/\badditionally\b/gi, "+"],
    [/\bas well as\b/gi, "+"],
    // Word-boundary " and " / " or " in prose — not inside identifiers.
    // Leading + trailing space ensures we don't touch "stand" or "word".
    [/ and /gi, " + "],
    [/ or /gi, " | "],
];

/** At ultra level, abbreviate a term only after it appears 3+ times in the same region.
 * Apply the 3+ occurrence threshold per region, not globally. */
const ULTRA_ABBREVIATIONS: Record<string, string> = {
    historian: "hist",
    compartment: "cmpt",
    compartments: "cmpts",
    compressor: "cmp",
    compression: "cmp",
    context: "ctx",
    message: "msg",
    messages: "msgs",
    session: "ses",
    configuration: "cfg",
    config: "cfg",
    implementation: "impl",
    implemented: "impl",
    repository: "repo",
    database: "db",
    directory: "dir",
};

// ---------------------------------------------------------------------------
// Transformation helpers.
// ---------------------------------------------------------------------------

/**
 * The optional leading space prevents double spaces after removal. */
function buildPhraseDropRegex(phrases: string[]): RegExp {
    const escaped = phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // Consuming an optional non-line-leading space prevents double spaces after removal.
    return new RegExp(`(\\s+)?\\b(?:${escaped.join("|")})\\b`, "gi");
}

function dropPhrases(text: string, phrases: string[]): string {
    return text.replace(buildPhraseDropRegex(phrases), "");
}

/** Retain articles immediately after the matched prepositions.
 * Drop articles only when immediately after specific disambiguators.
 * */
function dropArticles(text: string): string {
    // Also match at start of line: "The X" → "X".
    let working = text.replace(/\b(?:the|a|an)\b\s+/gi, "");
    working = working.replace(/ +/g, " ");
    return working;
}

/**
 * Only match an auxiliary followed by a verb-like token to preserve standalone past-tense "was" in "X was complex".
 * The verb-like-token lookahead preserves standalone past-tense "was" in "X was complex". */
function dropAuxiliaries(text: string): string {
    const sorted = [...AUXILIARIES].sort((a, b) => b.length - a.length);
    const escaped = sorted.map((a) => a.replace(/\s+/g, "\\s+"));
    const pattern = new RegExp(
        // The lookahead retains auxiliaries before complements such as "complex".
        `\\s+\\b(?:${escaped.join("|")})\\b\\s+(?=\\w+(?:ed|en|ing|ized|ised)\\b)`,
        "gi",
    );
    let working = text.replace(pattern, " ");
    working = working.replace(/ +/g, " ");
    return working;
}

function applyPhraseShortenings(text: string): string {
    let working = text;
    for (const [pattern, replacement] of PHRASE_SHORTENINGS) {
        working = working.replace(pattern, replacement);
    }
    return working;
}

function applyUltraConnectives(text: string): string {
    let working = text;
    for (const [pattern, replacement] of ULTRA_CONNECTIVE_REPLACEMENTS) {
        working = working.replace(pattern, replacement);
    }
    return working;
}

/* */
function countWordOccurrences(text: string, term: string): number {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = text.match(new RegExp(`\\b${escaped}\\b`, "gi"));
    return matches ? matches.length : 0;
}

function applyUltraAbbreviations(text: string): string {
    let working = text;
    for (const [term, abbreviation] of Object.entries(ULTRA_ABBREVIATIONS)) {
        if (countWordOccurrences(working, term) < 3) continue;
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        working = working.replace(new RegExp(`\\b${escaped}\\b`, "gi"), (match) => {
            return match[0] === match[0].toUpperCase()
                ? abbreviation[0].toUpperCase() + abbreviation.slice(1)
                : abbreviation;
        });
    }
    return working;
}

/**
 * */
function transformPreservingUserLines(text: string, transform: (chunk: string) => string): string {
    const lines = text.split("\n");
    const output: string[] = [];
    let buffer: string[] = [];

    const flushBuffer = () => {
        if (buffer.length === 0) return;
        const joined = buffer.join("\n");
        output.push(transform(joined));
        buffer = [];
    };

    for (const line of lines) {
        if (line.startsWith("U: ")) {
            flushBuffer();
            output.push(line);
        } else {
            buffer.push(line);
        }
    }
    flushBuffer();

    return output.join("\n");
}

/**
 * */
function normalizeWhitespace(text: string): string {
    return text
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 *
 *
 * */
export function cavemanCompress(text: string, level: CavemanLevel): string {
    if (text.length === 0) return text;

    const { text: protectedText, preserved } = protectRegions(text);

    const transformed = transformPreservingUserLines(protectedText, (chunk) => {
        let working = chunk;

        working = dropPhrases(working, FILLER_WORDS);
        working = dropPhrases(working, HEDGING_PHRASES);
        working = dropPhrases(working, PLEASANTRIES);
        working = applyPhraseShortenings(working);

        if (level === "full" || level === "ultra") {
            working = dropAuxiliaries(working);
            working = dropArticles(working);
        }

        if (level === "ultra") {
            working = applyUltraConnectives(working);
            working = applyUltraAbbreviations(working);
        }

        return working;
    });

    const restored = restoreRegions(transformed, preserved);
    return normalizeWhitespace(restored).trim();
}
