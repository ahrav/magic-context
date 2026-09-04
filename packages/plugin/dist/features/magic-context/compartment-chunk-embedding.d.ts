import type { Database } from "../../shared/sqlite";
import type { VectorLoadObserver } from "./search-trace";
export declare const DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS = 512;
/**
 * Fraction of the configured `max_input_tokens` we actually fill per window.
 *
 * `max_input_tokens` is the provider's HARD context ceiling, but we window using
 * our own `estimateTokens` heuristic, which drifts from the provider's real
 * tokenizer (observed ~1% on Qwen3 — a chunk we sized at 8192 counted 8261 on
 * the server and was silently truncated). Targeting 90% of the ceiling absorbs
 * that cross-tokenizer drift so a window never exceeds the provider limit.
 */
export declare const CHUNK_WINDOW_SAFETY_RATIO = 0.9;
export interface CompartmentChunkBackfillCandidate {
    id: number;
    sessionId: string;
    startMessage: number;
    endMessage: number;
    title: string;
    createdAt: number;
}
export interface CompartmentChunkWindow {
    windowIndex: number;
    startOrdinal: number;
    endOrdinal: number;
    text: string;
    chunkHash: string;
}
export interface StoredCompartmentChunkEmbedding {
    compartmentId: number;
    sessionId: string;
    title: string;
    startOrdinal: number;
    endOrdinal: number;
    windowIndex: number;
    windowStartOrdinal: number;
    windowEndOrdinal: number;
    chunkHash: string;
    modelId: string;
    dims: number;
    vector: Float32Array;
}
export interface SaveCompartmentChunkEmbeddingInput {
    compartmentId: number;
    sessionId: string;
    projectPath: string;
    window: CompartmentChunkWindow;
    modelId: string;
    vector: Float32Array;
    createdAt?: number;
}
/** Clear process-level decoded vectors between isolated test cases. */
export declare function _resetCompartmentChunkSearchCacheForTests(): void;
export declare function normalizeCompartmentChunkMaxInputTokens(value: unknown): number;
export declare function buildCanonicalChunkTextFromFts(db: Database, sessionId: string, startOrdinal: number, endOrdinal: number): string;
/**
 * Fallback embeddable text for a compartment whose RAW span has NO indexable
 * content. A thin one-beat compartment — e.g. a host-injected
 * `<system-reminder>` notification (stripped to empty by the indexer) plus an
 * assistant tool-call (no text) — leaves `buildCanonicalChunkTextFromFts`
 * returning "". Such a compartment would never acquire an embedding row, so it
 * stays counted as "remaining" forever and the auto-embed drain re-fires its
 * start/finish notification on every restart (the desktop "Embedding 1 /
 * Embedded 0" loop).
 *
 * The compartment still carries a real summary (title + p1 paraphrase) — the
 * ONLY signal it has — so we embed that instead. This is NOT the redundancy that
 * retired `p1_embedding` (which embedded the summary ALONGSIDE the raw chunk):
 * here there is no raw chunk to embed, so the summary is the sole content.
 * Returns "" only when the compartment has neither a title nor p1/content.
 */
export declare function buildCompartmentSummaryFallbackText(db: Database, compartmentId: number): string;
/**
 * Convert historian input text into the same embeddable subset used by the FTS
 * backfill producer: only U:/A: conversational lines remain, and TC: tool-call
 * summaries are removed because they are better served by exact FTS probes.
 */
export declare function canonicalizeInMemoryChunkTextForEmbedding(chunkText: string, startOrdinal?: number, endOrdinal?: number): string;
export declare function chunkCanonicalText(canonicalText: string, startOrdinal: number, endOrdinal: number, maxInputTokens: number, maxInputBytes?: number): CompartmentChunkWindow[];
export declare function getExistingChunkHashes(db: Database, compartmentId: number, modelId: string, projectPath?: string): Map<number, string>;
export declare function chunkEmbeddingWindowsAreCurrent(db: Database, compartmentId: number, modelId: string, windows: readonly CompartmentChunkWindow[], projectPath?: string): boolean;
export declare function replaceCompartmentChunkEmbeddings(db: Database, rows: readonly SaveCompartmentChunkEmbeddingInput[]): void;
/** Remove one compartment's rows under one model, invalidating decoded pools. */
export declare function deleteCompartmentChunkEmbeddingsForModel(db: Database, compartmentId: number, modelId: string): void;
export declare function loadCompartmentChunkEmbeddingsForSearch(db: Database, sessionId: string, projectPath: string, modelId: string, onVectorLoad?: VectorLoadObserver, 
/** Ordinal cutoff the caller applies before comparing vectors. Warm
 *  touched-byte evidence counts only rows the search can actually
 *  compare; the cold decode below still reports the whole pool, since
 *  a cache miss genuinely decodes everything. */
touchedMaxOrdinal?: number | null): StoredCompartmentChunkEmbedding[];
/** Project-wide candidates for the passive missing-chunk drain, newest-first (a
 *  fresh compartment is the one a search is most likely to want).
 *
 *  `before` is a run-local keyset cursor. It advances past every selected batch,
 *  including no-work and failed candidates, without growing a SQL parameter
 *  list. The cursor is not persisted, so failures remain eligible on the next
 *  maintenance pass. */
export declare function loadUnembeddedCompartmentChunkCandidates(db: Database, projectPath: string, modelId: string, limit: number, before?: Pick<CompartmentChunkBackfillCandidate, "createdAt" | "id">): CompartmentChunkBackfillCandidate[];
/** Session-scoped variant of {@link loadUnembeddedCompartmentChunkCandidates}.
 *  Used by the on-demand `/ctx-embed-history` command, which backfills ONE
 *  session at a time (oldest-first so the user watches it fill chronologically),
 *  unlike the project-wide passive drain. A compartment is a candidate when it
 *  has no chunk-embedding row for `modelId` yet.
 *
 *  `excludeIds` lets the drain loop advance past compartments that produced no
 *  embeddable work this run (empty canonical text / windows already current) so
 *  one un-embeddable old compartment can't block every newer one — without it
 *  the oldest-first query would re-select the same stuck prefix forever. */
export declare function loadUnembeddedSessionChunkCandidates(db: Database, projectPath: string, sessionId: string, modelId: string, limit: number, excludeIds?: readonly number[]): CompartmentChunkBackfillCandidate[];
/** Count compartments in this session that still lack a chunk embedding for
 *  `modelId` — drives the `/ctx-embed-history` progress total. */
export declare function countUnembeddedSessionCompartments(db: Database, projectPath: string, sessionId: string, modelId: string): number;
/** Total embeddable compartments in this session (have a message range), and how
 *  many are currently embedded under `modelId`. Drives the `/ctx-embed` status
 *  line: `embedded / total`. Counts the project's OWN compartments for the
 *  session (same `session_projects` scoping as the unembedded counter). */
export declare function countSessionCompartmentEmbedCoverage(db: Database, projectPath: string, sessionId: string, modelId: string): {
    embedded: number;
    total: number;
};
//# sourceMappingURL=compartment-chunk-embedding.d.ts.map