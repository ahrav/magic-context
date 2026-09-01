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
 *
 * The system stores raw `[ordinal] U:/A:` text, with TC tool summaries stripped, in `compartment_chunk_embeddings` for `ctx_search`.
 * The system embeds a whole compartment only when its text fits the provider input window.
 * The system splits text that exceeds the provider input window into windows.
 * `ctx_search` reads `compartment_chunk_embeddings` to search session history.
 *
 * `compartments.p1_embedding` is inert because search reads chunk embeddings.
 *
 * A missing or slow embedding provider must not block or fail a historian publish.
 * `memory.enabled` prevents memory-off users from calling the embedding endpoint.
 */

export interface CompartmentChunkToEmbed {
    id: number;
    startMessage: number;
    endMessage: number;
    /** Embedding canonicalization strips `TC:` tool summaries from `sourceChunkText`. */
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
            // `null` means no journaling lane owns the project, so the legacy path embeds the windows.
            // A boolean means the journaling lane owns the compartment.
            // `true` means the journaling lane applied the windows; `false` means it applied none.
            // When the result is `false`, the page ledger records either a failed page or receipts awaiting application.
            // When the result is `false`, the compartment keeps its existing destination rows and no ledger page reaches `complete`.
            // No ledger page reaches `complete`, so the next publish re-derives the windows.
            // The legacy path must not embed windows when the journaling lane owns the compartment.
            // The legacy path would write destination rows without receipts.
            // Destination rows without receipts create a split state.
            // Reopen proof treats those rows as current and declines to reopen them.
            // `idempotency_conflict` persists because reopen proof treats destination rows without receipts as current.
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
