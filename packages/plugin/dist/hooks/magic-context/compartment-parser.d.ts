export interface ParsedCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    /** v2: P1 tier text (mirror). v1/flat: the flat compartment body. */
    content: string;
    /** v2 paraphrase tiers (model B). Undefined for v1/flat compartments. p4 may be "" (self-close). */
    p1?: string;
    p2?: string;
    p3?: string;
    p4?: string;
    /** v2 decay-rate signal (1-100). Undefined for v1/flat. */
    importance?: number;
    /** v2 comma-separated activity types. Undefined for v1/flat. */
    episodeType?: string;
}
export interface ParsedFact {
    category: string;
    content: string;
}
/**
 * A historian-extracted event (v2). Two kinds today — `causal_incident` and
 * `trajectory_correction` — but parsed kind-agnostically: `kind` is the element
 * name and `fields` holds every child element verbatim. v2.0 STORES events
 * (E2 events table) but does NOT render them; parsing kind-agnostically means a
 * future event-kind or field addition needs no parser change.
 */
export interface ParsedEvent {
    kind: string;
    /** 1-based compartment index the event anchors to (`at_compartment="N"`); null if absent/invalid. */
    atCompartment: number | null;
    /** child element name → text content (e.g. summary, before_strategy, evidence). */
    fields: Record<string, string>;
}
export interface ParsedPrimerCandidate {
    question: string;
    /** 1-based index into the publish's emitted compartments
     *  (`<primer at_compartment="N">`), matching the SAME convention as
     *  `<events>` anchoring. Undefined for the legacy bullet form, in which case
     *  emission falls back to the chunk span. */
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
/**
 * Extract all four tier bodies from a compartment's inner markup using the
 * lenient closing rules above. Exposed for the v70 heal migration, which
 * re-parses flat `content` that the old strict parser stranded as legacy when a
 * model mismatched a tier's closing tag. Each tier is undefined when absent.
 */
export declare function extractTiersFromInner(inner: string): {
    p1?: string;
    p2?: string;
    p3?: string;
    p4?: string;
};
export declare function parseCompartmentOutput(text: string): ParsedCompartmentOutput;
//# sourceMappingURL=compartment-parser.d.ts.map