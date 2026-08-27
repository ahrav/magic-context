/**
 * Historian output payload builder for the eval lane.
 *
 * Deterministic tests and the mutation battery need full control over the
 * emitted shape — multiple compartments, facts by category, deliberately
 * overlapping ranges, wrong categories — which the minimal shared
 * `buildMockHistorianPayload` deliberately does not expose. The emitted
 * format is the v2 tiered payload production's parser and validator accept.
 */

export interface PayloadCompartment {
    start: number;
    end: number;
    title: string;
    body: string;
    importance?: number;
    episodeType?: string;
}

export interface PayloadFact {
    category: string;
    content: string;
}

export interface HistorianPayloadOptions {
    compartments: PayloadCompartment[];
    facts?: PayloadFact[];
    /** Defaults to max(end)+1 — "fully processed". */
    unprocessedFrom?: number;
}

function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function buildHistorianPayload(options: HistorianPayloadOptions): string {
    const compartments = options.compartments
        .map((compartment) => {
            const body = escapeXml(compartment.body);
            return [
                `<compartment start="${compartment.start}" end="${compartment.end}" title="${escapeXml(compartment.title)}" importance="${compartment.importance ?? 50}" episode_type="${escapeXml(compartment.episodeType ?? "feature")}">`,
                `<p1>${body}</p1>`,
                `<p2>${body}</p2>`,
                `<p3>${body}</p3>`,
                "<p4/>",
                "</compartment>",
            ].join("\n");
        })
        .join("\n");

    const factsByCategory = new Map<string, string[]>();
    for (const fact of options.facts ?? []) {
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
