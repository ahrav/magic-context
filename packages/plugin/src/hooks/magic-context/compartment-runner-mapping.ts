import type { PluginContext } from "../../plugin/types";
import { normalizeSDKResponse } from "../../shared";
import type { ParsedCompartment } from "./compartment-parser";
import type { CandidateCompartment } from "./compartment-runner-types";

/* */
type ParsedTierFields = Pick<
    ParsedCompartment,
    "p1" | "p2" | "p3" | "p4" | "importance" | "episodeType"
>;

function tierFieldsOf(c: ParsedTierFields): ParsedTierFields {
    return {
        p1: c.p1,
        p2: c.p2,
        p3: c.p3,
        p4: c.p4,
        importance: c.importance,
        episodeType: c.episodeType,
    };
}

export function mapParsedCompartmentsToChunk(
    compartments: Array<
        {
            startMessage: number;
            endMessage: number;
            title: string;
            content: string;
        } & ParsedTierFields
    >,
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
    },
    sequenceOffset: number,
): { ok: true; compartments: CandidateCompartment[] } | { ok: false; error: string } {
    const mapped: CandidateCompartment[] = [];
    for (const [index, compartment] of compartments.entries()) {
        const startLine = chunk.lines.find((line) => line.ordinal === compartment.startMessage);
        const endLine = chunk.lines.find((line) => line.ordinal === compartment.endMessage);
        if (!startLine || !endLine) {
            return {
                ok: false,
                error: `Compartment range ${compartment.startMessage}-${compartment.endMessage} does not map to raw session lines ${chunk.startIndex}-${chunk.endIndex}`,
            };
        }
        mapped.push({
            sequence: sequenceOffset + index,
            startMessage: compartment.startMessage,
            endMessage: compartment.endMessage,
            startMessageId: startLine.messageId,
            endMessageId: endLine.messageId,
            title: compartment.title,
            content: compartment.content,
            ...tierFieldsOf(compartment),
        });
    }

    return { ok: true, compartments: mapped };
}

/**
 * The session's own directory when the SDK can supply it, else `fallback`.
 * `session.get` failure is non-fatal by design — runners fall back to the
 * deps-supplied directory.
 */
export async function resolveSessionDirectory(
    client: PluginContext["client"],
    sessionId: string,
    fallback: string,
): Promise<string> {
    const parentSessionResponse = await client.session
        .get({ path: { id: sessionId } })
        .catch(() => null);
    const parentSession = normalizeSDKResponse(
        parentSessionResponse,
        null as { directory?: string } | null,
        { preferResponseOnMissingData: true },
    );
    return parentSession?.directory ?? fallback;
}
