import type { Database } from "../../../shared/sqlite";

export type EmbeddingPurpose = "query" | "passage";

export interface DetailedEmbedItem {
    id: string;
    text: string;
    contentSha256: string;
    /** Destination application-transaction group. A provider page never
     *  crosses groups (R18); one group may span several pages. */
    applicationGroup: string;
}

export interface DetailedEmbedContext {
    db: Database;
    projectPath: string;
    sessionId: string;
    scope: "memory" | "commit" | "chunk";
    laneRole: "primary" | "shadow";
}

/** One validated provider page: the durable versioned receipt (row id +
 *  state version) plus its immutable item set and in-memory vectors (R23). */
export interface EmbeddingPageReceipt {
    rowId: number;
    stateVersion: number;
    applicationGroup: string;
    items: readonly { id: string; contentSha256: string }[];
    vectors: Map<string, Float32Array>;
}

export interface EmbeddingPageFailure {
    applicationGroup: string;
    items: readonly { id: string; contentSha256: string }[];
    rowId: number | null;
    code: string;
    message: string;
    disposition: "retryable" | "permanent";
}

export interface DetailedEmbedResult {
    receipts: EmbeddingPageReceipt[];
    failures: EmbeddingPageFailure[];
}

export interface EmbeddingProvider {
    readonly modelId: string;
    /** Maximum safe input window for one embedding request. Unknown providers default to 512. */
    readonly maxInputTokens?: number;
    initialize(): Promise<boolean>;
    /** Embed a single text. `signal` lets callers abort the underlying network
     *  request (or long-running local inference) before the provider's internal
     *  timeout fires — used by transform-hot-path callers that have their own
     *  sub-timeout (e.g. 3s auto-search wants to cancel the 30s embed fetch).
     *  `purpose` selects asymmetric input_type on openai-compatible providers;
     *  defaults to `"passage"` (indexed/stored content). */
    embed(
        text: string,
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<Float32Array | null>;
    /** Batch variant of `embed`. Same signal semantics: aborting cancels the
     *  whole batch request (including the underlying HTTP call for remote providers).
     *  `purpose` defaults to `"passage"`. */
    embedBatch(
        texts: string[],
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<(Float32Array | null)[]>;
    /** Domain-item batch form for providers that can preserve item identity across retries. */
    embedItems?(
        items: readonly { id: string; text: string; contentSha256: string }[],
        signal?: AbortSignal,
    ): Promise<Map<string, Float32Array>>;
    /** Detailed batch capability: pages the items without crossing application
     *  groups, journals each page in the durable ledger, and returns versioned
     *  receipts for destination transactions. Only providers with a durable
     *  page journal (Synapse) implement this. */
    embedItemsDetailed?(
        items: readonly DetailedEmbedItem[],
        context: DetailedEmbedContext,
        signal?: AbortSignal,
    ): Promise<DetailedEmbedResult>;
    dispose(): Promise<void>;
    isLoaded(): boolean;
}
