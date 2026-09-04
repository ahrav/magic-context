import type { Database } from "../../shared/sqlite";
/**
 * Compartment chunk embedding (v2).
 *
 * Each compartment's raw `[ordinal] U:/A:` conversational text (TC: tool
 * summaries stripped) is embedded — whole-compartment when it fits the
 * provider's input window, otherwise windowed — and stored in
 * `compartment_chunk_embeddings`. This is the semantic substrate for ctx_search
 * over session history.
 *
 * The older per-compartment `p1_embedding` (summary vector) was retired once
 * chunk embeddings landed: it had no remaining reader (search uses chunks), and
 * the only prospective consumer — dreamer cross-compartment linking — does not
 * exist yet and can derive its own representation when built. The
 * `compartments.p1_embedding` column is left inert; dreamer v2 decides whether
 * to repopulate or drop it.
 *
 * Fire-and-forget + best-effort: a missing/slow embedding provider must never
 * block or fail a historian publish. Gated by `memory.enabled` so a memory-off
 * user never hits the embedding endpoint.
 */
export interface CompartmentChunkToEmbed {
    id: number;
    startMessage: number;
    endMessage: number;
    /** Optional publish-time chunk text. When present, TC: tool summaries are stripped. */
    sourceChunkText?: string;
}
export declare function embedAndStoreCompartmentChunks(db: Database, sessionId: string, projectPath: string, compartments: readonly CompartmentChunkToEmbed[]): Promise<void>;
//# sourceMappingURL=compartment-embedding.d.ts.map