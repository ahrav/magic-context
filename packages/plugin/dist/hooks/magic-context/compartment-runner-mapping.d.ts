import type { ParsedCompartment } from "./compartment-parser";
import type { CandidateCompartment } from "./compartment-runner-types";
/** Tier/metadata fields a parsed compartment may carry, threaded to storage. */
type ParsedTierFields = Pick<ParsedCompartment, "p1" | "p2" | "p3" | "p4" | "importance" | "episodeType">;
export declare function mapParsedCompartmentsToChunk(compartments: Array<{
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
} & ParsedTierFields>, chunk: {
    startIndex: number;
    endIndex: number;
    lines: Array<{
        ordinal: number;
        messageId: string;
    }>;
}, sequenceOffset: number): {
    ok: true;
    compartments: CandidateCompartment[];
} | {
    ok: false;
    error: string;
};
export {};
//# sourceMappingURL=compartment-runner-mapping.d.ts.map