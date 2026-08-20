import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    buildCanonicalChunkTextFromFts,
    buildCompartmentSummaryFallbackText,
    canonicalizeInMemoryChunkTextForEmbedding,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    replaceCompartmentChunkEmbeddings,
    type SaveCompartmentChunkEmbeddingInput,
} from "./compartment-chunk-embedding";
import {
    contentSha256,
    embedCompartmentWindowsDetailedForProject,
    embedItemsForProject,
    enqueueShadowEmbeddingItems,
    getProjectChunkEmbeddingModelId,
    getProjectEmbeddingMaxInputBytes,
    getProjectEmbeddingMaxInputTokens,
} from "./project-embedding-registry";

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

export async function embedAndStoreCompartmentChunks(
    db: Database,
    sessionId: string,
    projectPath: string,
    compartments: readonly CompartmentChunkToEmbed[],
): Promise<void> {
    if (compartments.length === 0) return;
    const maxInputTokens = getProjectEmbeddingMaxInputTokens(projectPath);
    const maxInputBytes = getProjectEmbeddingMaxInputBytes(projectPath);

    for (const compartment of compartments) {
        try {
            const fromMemory = compartment.sourceChunkText
                ? canonicalizeInMemoryChunkTextForEmbedding(
                      compartment.sourceChunkText,
                      compartment.startMessage,
                      compartment.endMessage,
                  )
                : "";
            const canonicalText =
                fromMemory ||
                buildCanonicalChunkTextFromFts(
                    db,
                    sessionId,
                    compartment.startMessage,
                    compartment.endMessage,
                ) ||
                buildCompartmentSummaryFallbackText(db, compartment.id);
            if (canonicalText.length === 0) continue;

            const windows = chunkCanonicalText(
                canonicalText,
                compartment.startMessage,
                compartment.endMessage,
                maxInputTokens,
                maxInputBytes,
            );
            if (windows.length === 0) continue;

            const currentModelId = getProjectChunkEmbeddingModelId(projectPath);
            if (
                currentModelId !== "off" &&
                chunkEmbeddingWindowsAreCurrent(
                    db,
                    compartment.id,
                    currentModelId,
                    windows,
                    projectPath,
                )
            ) {
                continue;
            }

            const detailed = await embedCompartmentWindowsDetailedForProject(db, projectPath, {
                compartmentId: compartment.id,
                sessionId,
                windows,
                ...(fromMemory
                    ? {
                          currentWindows: () =>
                              chunkCanonicalText(
                                  canonicalText,
                                  compartment.startMessage,
                                  compartment.endMessage,
                                  maxInputTokens,
                                  maxInputBytes,
                              ),
                      }
                    : {}),
            });
            // `null` means no journaling lane owns this project, so the legacy
            // path below embeds the windows. A boolean means the journaling lane
            // owns this compartment: `true` applied its windows, `false` applied
            // none of them and left the outcome in the page ledger — a failed
            // page with its retry disposition, or receipts still awaiting
            // application. Either way the compartment keeps its existing
            // destination rows and no ledger page reaches 'complete', so the next
            // publish re-derives the windows. Embedding them through the legacy
            // path instead would write destination rows with no receipt behind
            // them, which is the split state the ledger exists to prevent: a
            // later reopen proof reads those rows as current, declines to reopen,
            // and strands the group on idempotency_conflict.
            if (detailed === false) {
                sessionLog(
                    sessionId,
                    `compartment chunk embedding not applied by the synapse lane for compartment ${compartment.id}: no receipt group covered its windows`,
                );
                continue;
            }
            if (detailed === true) continue;

            const result = await embedItemsForProject(
                projectPath,
                windows.map((window) => ({
                    id: `chunk:${compartment.id}:${window.windowIndex}`,
                    text: window.text,
                    contentSha256: contentSha256(window.text),
                })),
            );
            if (!result) continue;
            if (
                chunkEmbeddingWindowsAreCurrent(
                    db,
                    compartment.id,
                    currentModelId,
                    windows,
                    projectPath,
                )
            ) {
                continue;
            }

            const rows: SaveCompartmentChunkEmbeddingInput[] = [];
            for (const window of windows) {
                const vector = result.vectors.get(`chunk:${compartment.id}:${window.windowIndex}`);
                if (!vector) continue;
                rows.push({
                    compartmentId: compartment.id,
                    sessionId,
                    projectPath,
                    window,
                    modelId: currentModelId,
                    vector,
                });
            }
            if (rows.length === windows.length) {
                replaceCompartmentChunkEmbeddings(db, rows);
                enqueueShadowEmbeddingItems(projectPath, "chunk", [String(compartment.id)]);
            }
        } catch (error) {
            sessionLog(
                sessionId,
                `compartment chunk embedding failed for compartment ${compartment.id}:`,
                error,
            );
        }
    }
}
