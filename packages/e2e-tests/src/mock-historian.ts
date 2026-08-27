/**
 * Shared mock-historian payload builder for the e2e suite.
 *
 * The historian's output is validated before it is published (see
 * `validateHistorianOutput` in the plugin and `historian_validate.rs` in the
 * Rust module). Since strict tier validation landed, a compartment that lacks
 * the v2 paraphrase tiers is rejected: P1 is the required boundary, and a flat
 * v1-shaped compartment (bare prose, no `<p1>`) re-enters the retry chain and
 * never publishes. Every historian-publish e2e test therefore needs its mock
 * provider to answer with a valid v2 tiered compartment, or it times out
 * waiting for a publish that validation blocks.
 *
 * This helper emits the minimal valid v2 shape — a single compartment carrying
 * all four paraphrase tiers plus the `importance`/`episode_type` attributes and
 * the `<facts>`/`<events>` blocks — wrapped in the full `<output>` envelope with
 * a trailing `<unprocessed_from>` so the chunk reports as fully covered. It
 * mirrors the tiered fixture the cache-invariant tests already publish
 * successfully, so it satisfies both the TypeScript and Rust validation paths.
 */

export interface MockHistorianPayloadOptions {
    /** First raw ordinal the compartment covers (`<compartment start="...">`). */
    start: number;
    /** Last raw ordinal the compartment covers (`<compartment end="...">`). */
    end: number;
    /** Compartment title attribute. */
    title: string;
    /** P1 tier text — the fullest paraphrase and the required v2 boundary. */
    body: string;
    /** P2 tier text (shorter paraphrase). Defaults to `body`. */
    p2?: string;
    /** P3 tier text (shortest paraphrase). Defaults to `body`. */
    p3?: string;
    /** v2 decay-rate attribute (1-100). Defaults to 50. */
    importance?: number;
    /** v2 episode_type attribute. Defaults to "feature". */
    episodeType?: string;
}

/**
 * Build a valid v2 tiered historian `<output>` payload covering `start`..`end`.
 *
 * P4 is emitted self-closed (`<p4/>`), which the parser treats as an empty tier
 * — a legal v2 shape. `<unprocessed_from>` is set to `end + 1` so the validator
 * sees the whole chunk as consumed.
 */
export function buildMockHistorianPayload(options: MockHistorianPayloadOptions): string {
    return buildMockHistorianOutput({ compartments: [options] });
}

/** One compartment of a multi-compartment historian output. */
export interface MockHistorianCompartment {
    start: number;
    end: number;
    title: string;
    /** P1 tier text — the fullest paraphrase and the required v2 boundary. */
    body: string;
    /** P2 tier text (shorter paraphrase). Defaults to `body`. */
    p2?: string;
    /** P3 tier text (shortest paraphrase). Defaults to `body`. */
    p3?: string;
    importance?: number;
    episodeType?: string;
}

export interface MockHistorianFact {
    /**
     * Category tag name. Must be tag-shaped (`/^[A-Z][A-Z0-9_]*$/`): the
     * production parser scopes facts with a non-greedy `<facts>...</facts>`
     * regex, so a category carrying `>` or `</facts>` would structurally
     * corrupt the payload instead of exercising a wrong-category mutation.
     * Wrong-but-well-formed categories (outside the 5-category taxonomy) are
     * deliberately allowed for the mutation battery.
     */
    category: string;
    content: string;
}

export interface MockHistorianOutputOptions {
    compartments: MockHistorianCompartment[];
    facts?: MockHistorianFact[];
    /**
     * Defaults to max(compartment end)+1 — "fully processed". Required when
     * `compartments` is empty: there is no end to derive it from, and a silent
     * default would emit a malformed tag the parser treats as absent.
     */
    unprocessedFrom?: number;
}

const CATEGORY_TAG_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Build a v2 tiered historian `<output>` payload with full shape control —
 * multiple compartments, facts by category, explicit `unprocessed_from`.
 * Deterministic tests and the historian-eval mutation battery drive this
 * directly; `buildMockHistorianPayload` remains the minimal single-compartment
 * wrapper the rest of the suite uses.
 */
export function buildMockHistorianOutput(options: MockHistorianOutputOptions): string {
    const compartments = options.compartments
        .map((compartment) => {
            const body = escapeXml(compartment.body);
            const p2 = escapeXml(compartment.p2 ?? compartment.body);
            const p3 = escapeXml(compartment.p3 ?? compartment.body);
            return [
                `<compartment start="${compartment.start}" end="${compartment.end}" title="${escapeXml(compartment.title)}" importance="${compartment.importance ?? 50}" episode_type="${escapeXml(compartment.episodeType ?? "feature")}">`,
                `<p1>${body}</p1>`,
                `<p2>${p2}</p2>`,
                `<p3>${p3}</p3>`,
                "<p4/>",
                "</compartment>",
            ].join("\n");
        })
        .join("\n");

    const factsByCategory = new Map<string, string[]>();
    for (const fact of options.facts ?? []) {
        if (!CATEGORY_TAG_RE.test(fact.category)) {
            throw new Error(`buildMockHistorianOutput: category is not tag-shaped: ${JSON.stringify(fact.category)}`);
        }
        const bucket = factsByCategory.get(fact.category) ?? [];
        bucket.push(fact.content);
        factsByCategory.set(fact.category, bucket);
    }
    const facts = [...factsByCategory.entries()]
        .map(
            ([category, contents]) =>
                `<${category}>\n${contents.map((content) => `* ${escapeXml(content)}`).join("\n")}\n</${category}>`,
        )
        .join("\n");

    if (options.compartments.length === 0 && options.unprocessedFrom === undefined) {
        throw new Error("buildMockHistorianOutput: unprocessedFrom is required when compartments is empty");
    }
    const unprocessedFrom =
        options.unprocessedFrom ?? Math.max(...options.compartments.map((compartment) => compartment.end)) + 1;

    return [
        "<output>",
        "<compartments>",
        compartments,
        "</compartments>",
        `<facts>${facts ? `\n${facts}\n` : ""}</facts>`,
        "<events></events>",
        `<unprocessed_from>${unprocessedFrom}</unprocessed_from>`,
        "</output>",
    ].join("\n");
}

/** Escape the five XML-special characters so arbitrary prose stays well-formed. */
function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
