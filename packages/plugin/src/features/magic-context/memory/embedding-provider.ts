import type { Database } from "../../../shared/sqlite";

export type EmbeddingPurpose = "query" | "passage";

export interface DetailedEmbedItem {
    id: string;
    text: string;
    contentSha256: string;
    /** applicationGroup identifies the destination application-transaction group.
     * A provider page never crosses application groups; one group may span multiple pages. */
    applicationGroup: string;
}

export interface DetailedEmbedContext {
    db: Database;
    projectPath: string;
    sessionId: string;
    scope: "memory" | "commit" | "chunk";
    laneRole: "primary" | "shadow";
}

/** rowId and stateVersion identify the validated provider-page receipt.
 * */
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
    /** Providers without a known limit use 512 input tokens. */
    readonly maxInputTokens?: number;
    /** Providers with a byte cap measure maxInputBytes in UTF-8 bytes. */
    readonly maxInputBytes?: number;
    initialize(): Promise<boolean>;
    /**
     * signal aborts the underlying network request or local inference before the provider timeout.
     * On OpenAI-compatible providers, purpose selects asymmetric input_type.
     * purpose defaults to "passage" for indexed or stored content. */
    embed(
        text: string,
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<Float32Array | null>;
    /**
     * An aborting signal cancels the whole batch request, including its underlying HTTP call for remote providers.
     *  `purpose` defaults to `"passage"`. */
    embedBatch(
        texts: string[],
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<(Float32Array | null)[]>;
    /** embedItems preserves item identity across retries for providers that support it. */
    embedItems?(
        items: readonly { id: string; text: string; contentSha256: string }[],
        signal?: AbortSignal,
    ): Promise<Map<string, Float32Array>>;
    /** embedItemsDetailed pages items within application groups, journals each page, and returns versioned receipts for destination transactions.
     * */
    embedItemsDetailed?(
        items: readonly DetailedEmbedItem[],
        context: DetailedEmbedContext,
        signal?: AbortSignal,
    ): Promise<DetailedEmbedResult>;
    dispose(): Promise<void>;
    isLoaded(): boolean;
}
