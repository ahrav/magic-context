export interface ParsedCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    /** content stores the P1 mirror in v2 and the flat compartment body in v1. */
    content: string;
    /** p1 through p4 store v2 paraphrase tiers; they are undefined for v1/flat compartments, and p4 may be "" for a self-closing tier. */
    p1?: string;
    p2?: string;
    p3?: string;
    p4?: string;
    /** importance stores the v2 decay-rate signal and is undefined for v1/flat compartments. */
    importance?: number;
    /** episodeType stores comma-separated v2 activity types and is undefined for v1/flat compartments. */
    episodeType?: string;
}

export interface ParsedFact {
    category: string;
    content: string;
}

/**
 * ParsedEvent stores the event element name and its child text fields.
 * kind is the element name; fields maps child names to text content.
 */
export interface ParsedEvent {
    kind: string;
    /** atCompartment stores the 1-based compartment index from `at_compartment="N"` and is null when the attribute is absent or invalid. */
    atCompartment: number | null;
    /* */
    fields: Record<string, string>;
}

export interface ParsedPrimerCandidate {
    question: string;
    /**
     * Legacy bullet primers fall back to the chunk span at emission. */
    originCompartmentIndex?: number;
}

export interface ParsedCompartmentOutput {
    compartments: ParsedCompartment[];
    facts: ParsedFact[];
    events: ParsedEvent[];
    unprocessedFrom: number | null;
    userObservations: string[];
    primerCandidates: ParsedPrimerCandidate[];
}

// COMPARTMENT_REGEX captures attributes separately so attribute order does not affect parsing.
const COMPARTMENT_REGEX = /<compartment\s+([^>]*?)\s*>(.*?)<\/compartment>/gs;
const ATTR_START_REGEX = /\bstart="(\d+)"/;
const ATTR_END_REGEX = /\bend="(\d+)"/;
const ATTR_TITLE_REGEX = /\btitle="([^"]*)"/;
const ATTR_EPISODE_REGEX = /\bepisode_type="([^"]*)"/;
const ATTR_IMPORTANCE_REGEX = /\bimportance="(\d+)"/;
// Tier bodies end at any tier closing tag because the closing digit can differ from the opener's digit.
function makeTierOpenRegex(n: number): RegExp {
    return new RegExp(`<p${n}\\s*(/?)>`);
}
const TIER_OPEN_REGEXES = [
    makeTierOpenRegex(1),
    makeTierOpenRegex(2),
    makeTierOpenRegex(3),
    makeTierOpenRegex(4),
];
const TIER_CLOSE_ANY_REGEX = /<\/p\d/;
// TIER_OPEN_ANY_REGEX prevents a tier body from consuming a following tier opener.
const TIER_OPEN_ANY_REGEX = /<p\d/;
const CATEGORY_BLOCK_REGEX =
    /<(PROJECT_RULES|ARCHITECTURE|CONSTRAINTS|CONFIG_VALUES|NAMING)>(.*?)<\/\1>/gs;
const FACT_ITEM_REGEX = /^\s*\*\s*(.+)$/gm;
const UNPROCESSED_REGEX = /<unprocessed_from>(\d+)<\/unprocessed_from>/;
const USER_OBSERVATIONS_REGEX = /<user_observations>(.*?)<\/user_observations>/s;
const USER_OBS_ITEM_REGEX = /^\s*\*\s*(.+)$/gm;
const PRIMER_CANDIDATES_REGEX = /<primer_candidates>(.*?)<\/primer_candidates>/s;
// A primer uses `<primer at_compartment="N">question</primer>`, where N is the origin compartment's start ordinal.
// Legacy primer bullets (`*`, `-`, or `1.`) fall back to the chunk span at emission.
const PRIMER_ELEMENT_REGEX = /<primer\s+at_compartment="(\d+)"\s*>(.*?)<\/primer>/gs;
const PRIMER_ITEM_REGEX = /^\s*(?:\*|-|\d+\.)\s*(.+)$/gm;

// Only elements inside `<events>` are events.
// Children of `<events>` are parsed kind-agnostically; a child with `at_compartment` is an event.
// Scoping to the `<events>` block prevents fact and compartment tags from being parsed as events.
const FACTS_BLOCK_REGEX = /<facts>(.*?)<\/facts>/s;
const EVENTS_BLOCK_REGEX = /<events>(.*?)<\/events>/s;
const EVENT_ELEMENT_REGEX = /<([a-z_]+)\s+at_compartment="(\d+)"\s*>(.*?)<\/\1>/gs;
const EVENT_FIELD_REGEX = /<([a-z_]+)\s*>(.*?)<\/\1>/gs;

/**
 *
 * The parser terminates an opened `<pN>` at the next tier closing tag because models can mismatch closing digits.
 * If the close tag is absent, the next opening tier tag or compartment end bounds the body.
 *
 * Returns:
 * The function returns a string, possibly `""`, when `<pN>` is present; `""` denotes a self-closing or empty element.
 * The function returns `undefined` when `<pN>` is absent entirely.
 */
function extractTier(inner: string, index: number): string | undefined {
    const openMatch = TIER_OPEN_REGEXES[index].exec(inner);
    if (!openMatch) return undefined;
    if (openMatch[1] === "/") return "";
    const rest = inner.slice(openMatch.index + openMatch[0].length);
    const closeAt = rest.search(TIER_CLOSE_ANY_REGEX);
    let body = closeAt === -1 ? rest : rest.slice(0, closeAt);
    const openInside = body.search(TIER_OPEN_ANY_REGEX);
    if (openInside !== -1) body = body.slice(0, openInside);
    return unescapeXml(body.trim());
}

/**
 */
export function extractTiersFromInner(inner: string): {
    p1?: string;
    p2?: string;
    p3?: string;
    p4?: string;
} {
    return {
        p1: extractTier(inner, 0),
        p2: extractTier(inner, 1),
        p3: extractTier(inner, 2),
        p4: extractTier(inner, 3),
    };
}

export function parseCompartmentOutput(text: string): ParsedCompartmentOutput {
    const compartments: ParsedCompartment[] = [];
    const facts: ParsedFact[] = [];

    for (const match of text.matchAll(COMPARTMENT_REGEX)) {
        const attrs = match[1];
        const inner = match[2];

        const startMatch = attrs.match(ATTR_START_REGEX);
        const endMatch = attrs.match(ATTR_END_REGEX);
        const titleMatch = attrs.match(ATTR_TITLE_REGEX);
        if (!startMatch || !endMatch || !titleMatch) continue;

        const startMessage = parseInt(startMatch[1], 10);
        const endMessage = parseInt(endMatch[1], 10);
        const title = unescapeXml(titleMatch[1]);
        if (Number.isNaN(startMessage) || Number.isNaN(endMessage) || !title) continue;

        const episodeMatch = attrs.match(ATTR_EPISODE_REGEX);
        const importanceMatch = attrs.match(ATTR_IMPORTANCE_REGEX);
        const episodeType = episodeMatch ? unescapeXml(episodeMatch[1]) : undefined;
        const importance = importanceMatch ? parseInt(importanceMatch[1], 10) : undefined;

        // A v2 tiered compartment contains at least `<p1>`.
        const p1 = extractTier(inner, 0);
        if (typeof p1 === "string" && p1.length > 0) {
            const p2 = extractTier(inner, 1);
            const p3 = extractTier(inner, 2);
            const p4 = extractTier(inner, 3);
            compartments.push({
                startMessage,
                endMessage,
                title,
                content: p1, // content mirrors P1 (fullest tier) for v2 rows
                p1,
                // Missing middle tiers inherit the next denser tier's value.
                // Tiered output always defines `p1` through `p4`; `p4` may be `""`.
                p2: typeof p2 === "string" ? p2 : p1,
                p3: typeof p3 === "string" ? p3 : typeof p2 === "string" ? p2 : p1,
                p4: typeof p4 === "string" ? p4 : "",
                importance,
                episodeType,
            });
            continue;
        }

        // Flat input lacks tier elements.
        const content = unescapeXml(inner.trim());
        if (content) {
            compartments.push({
                startMessage,
                endMessage,
                title,
                content,
                importance,
                episodeType,
            });
        }
    }

    // The parser scopes category extraction to `<facts>` because category tags can occur in event fields and compartment bodies.
    // Without `<facts>`, the parser removes `<events>` and `<compartment>` blocks before extracting categories.
    // Bare category blocks are valid only outside <events> when <facts> is absent.
    // The parser strips `<events>` before fallback category extraction to prevent event fields from being parsed as facts.
    const factsBlockMatch = text.match(FACTS_BLOCK_REGEX);
    // Without `<facts>`, the parser strips `<events>` and `<compartment>` blocks before fallback extraction to exclude category-shaped tags in their prose or attributes.
    const factsScope = factsBlockMatch
        ? factsBlockMatch[1]
        : text
              .replace(EVENTS_BLOCK_REGEX, "")
              .replace(/<compartment\s+[^>]*?\s*>.*?<\/compartment>/gs, "");
    for (const categoryMatch of factsScope.matchAll(CATEGORY_BLOCK_REGEX)) {
        const category = categoryMatch[1];
        const blockContent = categoryMatch[2];
        for (const itemMatch of blockContent.matchAll(FACT_ITEM_REGEX)) {
            const content = unescapeXml(itemMatch[1].trim());
            if (content) {
                facts.push({ category, content });
            }
        }
    }

    const unprocessedMatch = text.match(UNPROCESSED_REGEX);
    const unprocessedFrom = unprocessedMatch ? parseInt(unprocessedMatch[1], 10) : null;

    const userObservations: string[] = [];
    const userObsMatch = text.match(USER_OBSERVATIONS_REGEX);
    if (userObsMatch) {
        for (const itemMatch of userObsMatch[1].matchAll(USER_OBS_ITEM_REGEX)) {
            const obs = unescapeXml(itemMatch[1].trim());
            if (obs) userObservations.push(obs);
        }
    }

    const primerCandidates: ParsedPrimerCandidate[] = [];
    const primerMatch = text.match(PRIMER_CANDIDATES_REGEX);
    if (primerMatch) {
        const block = primerMatch[1];
        // Element-form candidates use `<primer at_compartment="N">…</primer>`, where `N` is the origin ordinal.
        let sawElement = false;
        for (const el of block.matchAll(PRIMER_ELEMENT_REGEX)) {
            sawElement = true;
            const question = unescapeXml(el[2].trim());
            if (question) {
                primerCandidates.push({
                    question,
                    originCompartmentIndex: Number.parseInt(el[1], 10),
                });
            }
        }
        // The parser reads bullet items only when the block contains no element-form candidates; bullets have no origin tag.
        if (!sawElement) {
            for (const itemMatch of block.matchAll(PRIMER_ITEM_REGEX)) {
                const question = unescapeXml(itemMatch[1].trim());
                if (question) primerCandidates.push({ question });
            }
        }
    }

    const events = parseEvents(text);

    compartments.sort((a, b) => a.startMessage - b.startMessage);

    return { compartments, facts, events, unprocessedFrom, userObservations, primerCandidates };
}

/**
 */
function parseEvents(text: string): ParsedEvent[] {
    const blockMatch = text.match(EVENTS_BLOCK_REGEX);
    if (!blockMatch) return [];
    const block = blockMatch[1];
    const events: ParsedEvent[] = [];
    for (const elMatch of block.matchAll(EVENT_ELEMENT_REGEX)) {
        const kind = elMatch[1];
        const atRaw = parseInt(elMatch[2], 10);
        const atCompartment = Number.isNaN(atRaw) ? null : atRaw;
        const fields: Record<string, string> = {};
        for (const fieldMatch of elMatch[3].matchAll(EVENT_FIELD_REGEX)) {
            const name = fieldMatch[1];
            const value = unescapeXml(fieldMatch[2].trim());
            if (value) fields[name] = value;
        }
        events.push({ kind, atCompartment, fields });
    }
    return events;
}

function unescapeXml(s: string): string {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}
