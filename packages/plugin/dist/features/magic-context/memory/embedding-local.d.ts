import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";
/** The dtype enum values accepted by @huggingface/transformers' feature-extraction
 *  pipeline (keyof typeof DATA_TYPES in transformers/types/utils/dtypes.d.ts).
 *  Kept as a literal union so the config schema, identity fold, and pipeline
 *  call share one source of truth. See issue #259. */
export type LocalEmbeddingDtype = "auto" | "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16" | "q2" | "q2f16" | "q1" | "q1f16";
export { getLocalEmbeddingRecipe, type LocalEmbeddingPooling, type LocalEmbeddingRecipe, } from "./embedding-identity";
export declare function isNativeRuntimeMissingError(error: unknown): boolean;
export declare class LocalEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;
    readonly maxInputTokens: number;
    private readonly model;
    private readonly dtype;
    private readonly recipe;
    private pipeline;
    private initPromise;
    private inFlight;
    private disposing;
    private disposePromise;
    private readonly inFlightWaiters;
    constructor(model?: string, maxInputTokens?: number, dtype?: LocalEmbeddingDtype);
    initialize(): Promise<boolean>;
    private waitForInFlightToDrain;
    private finishInFlight;
    embed(text: string, signal?: AbortSignal, purpose?: EmbeddingPurpose): Promise<Float32Array | null>;
    embedBatch(texts: string[], signal?: AbortSignal, purpose?: EmbeddingPurpose): Promise<(Float32Array | null)[]>;
    dispose(): Promise<void>;
    isLoaded(): boolean;
}
//# sourceMappingURL=embedding-local.d.ts.map