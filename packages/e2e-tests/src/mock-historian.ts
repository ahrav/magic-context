/**
 *
 *
 * The payload sets `<unprocessed_from>` to `end + 1` so the chunk reports fully covered.
 */

export interface MockHistorianPayloadOptions {
    /** The builder writes `start` as the compartment's first raw ordinal. */
    start: number;
    /** The builder writes `end` as the compartment's last raw ordinal. */
    end: number;
    /* */
    title: string;
    /** P1 is the fullest paraphrase and the required v2 boundary. */
    body: string;
    /* */
    p2?: string;
    /* */
    p3?: string;
    /* */
    importance?: number;
    /* */
    episodeType?: string;
}

/**
 * The function returns a valid v2 historian `<output>` payload covering `start` through `end`.
 *
 * The parser accepts self-closed `<p4/>` as an empty v2 tier.
 * `<unprocessed_from> = end + 1` marks the chunk fully consumed.
 */
export function buildMockHistorianPayload(options: MockHistorianPayloadOptions): string {
    return buildMockHistorianOutput({ compartments: [options] });
}

/* */
export interface MockHistorianCompartment {
    start: number;
    end: number;
    title: string;
    /** P1 is the fullest paraphrase and the required v2 boundary. */
    body: string;
    /* */
    p2?: string;
    /* */
    p3?: string;
    importance?: number;
    episodeType?: string;
}

export interface MockHistorianFact {
    /**
     * `category` must match `/^[A-Z][A-Z0-9_]*$/`; malformed tags can corrupt `<facts>` parsing.
     * production parser scopes facts with a non-greedy `<facts>...</facts>`
     * A category containing `>` or `</facts>` corrupts the `<facts>` payload before a wrong-category mutation can be tested.
     * The builder permits well-formed categories outside the five-category taxonomy so mutation tests can produce wrong categories.
     */
    category: string;
    /**
     * `content` must be non-empty, trimmed, and contain no ECMAScript line terminators.
     */
    content: string;
}

export interface MockHistorianOutputOptions {
    compartments: MockHistorianCompartment[];
    facts?: MockHistorianFact[];
    /**
     * `unprocessedFrom` defaults to `max(compartment.end) + 1` and is required when `compartments` is empty.
     * Without `unprocessedFrom`, empty `compartments` emit `-Infinity`, which the parser treats as absent.
     */
    unprocessedFrom?: number;
}

const CATEGORY_TAG_RE = /^[A-Z][A-Z0-9_]*$/;

/**
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
        if (/[\r\n\u2028\u2029]/.test(fact.content)) {
            throw new Error(
                `buildMockHistorianOutput: fact content must be single-line: ${JSON.stringify(fact.content)}`,
            );
        }
        // The production parser trims each fact and drops empty results.
        if (fact.content.length === 0 || fact.content !== fact.content.trim()) {
            throw new Error(
                `buildMockHistorianOutput: fact content must be non-empty and trimmed: ${JSON.stringify(fact.content)}`,
            );
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

/**
 *
 * `escapeXml` rejects `&lt;`, `&gt;`, `&quot;`, and `&apos;` because the production parser cannot round-trip them.
 * TODO: Support round-tripping `&lt;`, `&gt;`, `&quot;`, and `&apos;` in the production decoder.
 */
function escapeXml(text: string): string {
    const unrecoverable = text.match(/&(?:lt|gt|quot|apos);/);
    if (unrecoverable) {
        throw new Error(
            `buildMockHistorianOutput: text contains an entity the production parser cannot round-trip (${unrecoverable[0]}): ${JSON.stringify(text)}`,
        );
    }
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
