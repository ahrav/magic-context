/**
 *
 *
 * The prompt includes four rotating seeds from other projects.
 *
 * The prompt includes the six most recent compartments written in the same session.
 * Session references retain every tier, importance, and episode type.
 *       publish (compartment-embedding.ts).
 *
 * The prompt limits references to 10 examples: 4 seeds and up to 6 session references.
 */
import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";
import { REFERENCE_SEEDS, type ReferenceSeed } from "./reference-seeds.generated";

/**
 */
export interface ReferenceCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episodeType?: string | null;
}

/* */
export const SEED_FLOOR = 4;
/* */
export const SESSION_REF_WINDOW = 6;

/**
 */
const SEED_BANDS: ReadonlyArray<readonly [number, number]> = [
    [85, 100], // very high
    [60, 84], // high
    [30, 59], // mid
    [10, 29], // low-mid
    [1, 9], // low
];

function seedBandIndex(importance: number): number {
    for (let i = 0; i < SEED_BANDS.length; i++) {
        const [lo, hi] = SEED_BANDS[i];
        if (importance >= lo && importance <= hi) return i;
    }
    return importance > 100 ? 0 : SEED_BANDS.length - 1;
}

/* */
function seedsByBand(): ReferenceSeed[][] {
    const bands: ReferenceSeed[][] = SEED_BANDS.map(() => []);
    for (const seed of REFERENCE_SEEDS) {
        bands[seedBandIndex(seed.importance)].push(seed);
    }
    return bands;
}

/**
 * The non-cryptographic FNV-1a hash gives retries for the same `(sessionId, chunkStart)` identical seeds.
 * FNV-1a provides reproducibility, not security.
 */
function fnv1a(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        // `>>> 0` reduces the FNV-1a product to an unsigned 32-bit value.
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}

/**
 * The same `(sessionId, chunkStart)` deterministically selects the same seeds.
 *
 */
export function selectSeeds(
    sessionId: string,
    chunkStart: number,
    count = SEED_FLOOR,
): ReferenceSeed[] {
    const bands = seedsByBand();
    const seed = fnv1a(`${sessionId}:${chunkStart}`);
    const picks: ReferenceSeed[] = [];

    // The band walk repeats the hash-rotated band order only after visiting every band.
    const bandOrder: number[] = [];
    for (let i = 0; i < SEED_BANDS.length; i++) {
        bandOrder.push((i + (seed % SEED_BANDS.length)) % SEED_BANDS.length);
    }

    let bi = 0;
    let guard = 0;
    while (picks.length < count && guard < SEED_BANDS.length * 4) {
        const band = bands[bandOrder[bi % bandOrder.length]];
        bi++;
        guard++;
        if (band.length === 0) continue;
        const idx = (seed + picks.length) % band.length;
        const candidate = band[idx];
        if (!picks.includes(candidate)) picks.push(candidate);
    }

    // The fallback uses the flat corpus when band walking returns fewer than `count` seeds.
    for (let i = 0; picks.length < count && i < REFERENCE_SEEDS.length; i++) {
        const candidate = REFERENCE_SEEDS[(seed + i) % REFERENCE_SEEDS.length];
        if (!picks.includes(candidate)) picks.push(candidate);
    }

    return picks;
}

/* */
export function renderSeedExamplesBlock(seeds: ReferenceSeed[]): string {
    if (seeds.length === 0) return "";
    const body = seeds.map((s) => s.block).join("\n\n");
    return `<compartment_examples_from_other_projects>\n${body}\n</compartment_examples_from_other_projects>`;
}

/**
 * Rows with non-empty `p1` emit all four tiers; other rows emit `content`.
 */
function renderSessionRefCompartment(c: ReferenceCompartment): string {
    const importance = c.importance ?? 50;
    const attrs =
        `start="${c.startMessage}" end="${c.endMessage}" title="${escapeXmlAttr(c.title)}"` +
        (c.episodeType ? ` episode_type="${escapeXmlAttr(c.episodeType)}"` : "") +
        ` importance="${importance}"`;

    // A row is v2-tiered only when `p1` is a non-empty string.
    // `p1=''` rows fall through to flat `content`.
    // `escapeXmlContent` escapes tier bodies so `<`, `>`, and `&` cannot produce malformed XML.
    if (typeof c.p1 === "string" && c.p1.length > 0) {
        // `p4` may be empty and render as a self-closing element.
        const p4 = c.p4 && c.p4.length > 0 ? `<p4>\n${escapeXmlContent(c.p4)}\n</p4>` : "<p4/>";
        return [
            `<compartment ${attrs}>`,
            `<p1>\n${escapeXmlContent(c.p1)}\n</p1>`,
            `<p2>\n${escapeXmlContent(c.p2 ?? "")}\n</p2>`,
            `<p3>\n${escapeXmlContent(c.p3 ?? "")}\n</p3>`,
            p4,
            `</compartment>`,
        ].join("\n");
    }

    return `<compartment ${attrs}>\n${escapeXmlContent(c.content)}\n</compartment>`;
}

/**
 * `allCompartments` contains the session's compartments in chronological order.
 */
export function renderSessionReferencesBlock(allCompartments: ReferenceCompartment[]): string {
    if (allCompartments.length === 0) return "";
    const recent = allCompartments.slice(-SESSION_REF_WINDOW);
    const body = recent.map(renderSessionRefCompartment).join("\n\n");
    return `<session_references>\n${body}\n</session_references>`;
}

export interface ReferenceBlocks {
    /* */
    seedExamples: string;
    /* */
    sessionReferences: string;
}

/**
 */
export function buildReferenceBlocks(args: {
    sessionId: string;
    chunkStart: number;
    /** `sessionCompartments` contains the full list ordered ascending by sequence/endMessage. */
    sessionCompartments: ReferenceCompartment[];
}): ReferenceBlocks {
    const seeds = selectSeeds(args.sessionId, args.chunkStart);
    return {
        seedExamples: renderSeedExamplesBlock(seeds),
        sessionReferences: renderSessionReferencesBlock(args.sessionCompartments),
    };
}
