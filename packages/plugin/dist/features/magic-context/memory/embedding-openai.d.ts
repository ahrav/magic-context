import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";
interface OpenAICompatibleEmbeddingProviderOptions {
    endpoint?: string;
    model?: string;
    apiKey?: string;
    /** Default/passage `input_type` body field (e.g. NVIDIA NIM 'passage'). */
    inputType?: string;
    /** Optional query `input_type` for search embeddings; falls back to inputType when unset. */
    queryInputType?: string;
    /** Optional `truncate` body field (e.g. NVIDIA NIM 'NONE'/'START'/'END'). */
    truncate?: string;
    /** Maximum safe input tokens for chunk embeddings. */
    maxInputTokens?: number;
}
/**
 * Whether the model an endpoint served is the model we asked for.
 *
 * Exact match after trim+lowercase, with TOKEN-BOUNDARY prefix/suffix tolerance
 * so a server that version-expands a name (`text-embedding-3-small` →
 * `…-small-v1`) or trims a vendor prefix (`openai/text-embedding-3-small` →
 * `text-embedding-3-small`) still counts as a match. OpenRouter routing tags
 * such as `:free` are ignored when only one side has a tag, while tags on both
 * sides must be equal so Ollama model-size tags remain distinct.
 *
 * Crucially this is NOT a plain substring test. A loose `a.includes(b)` would
 * MATCH a broadly-configured name against an unrelated served model that merely
 * contains it as a middle token — e.g. configured `qwen3-embedding`, served
 * `text-embedding-qwen3-embedding-0.6b` → store 0.6b vectors under the broad
 * identity (wrong-dim corruption, the exact failure this guard exists to stop).
 * So the shorter name must align on a `-`/`/` boundary as a genuine PREFIX or
 * SUFFIX of the longer, never as an interior fragment.
 */
export declare function embeddingModelsMatch(served: string, requested: string): boolean;
type CircuitState = "closed" | "open" | "half_open";
export declare class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;
    readonly maxInputTokens: number;
    private readonly endpoint;
    private readonly model;
    private readonly apiKey;
    private readonly inputType;
    private readonly queryInputType;
    private readonly truncate;
    private initialized;
    private failureTimes;
    private circuitOpenUntil;
    private openLogged;
    /** One-shot guard so a persistent model substitution doesn't flood the log
     *  with one line per batch. Resets with the provider instance (i.e. on any
     *  config change), so a corrected config logs again if it regresses. */
    private modelMismatchLogged;
    /** True while a half-open probe is in flight. Only the caller who set this
     *  to true is allowed to make a real HTTP call; everyone else short-
     *  circuits as if the circuit were still OPEN. */
    private halfOpenProbeInFlight;
    constructor(options: OpenAICompatibleEmbeddingProviderOptions);
    initialize(): Promise<boolean>;
    private resolveInputTypeForPurpose;
    embed(text: string, signal?: AbortSignal, purpose?: EmbeddingPurpose): Promise<Float32Array | null>;
    embedBatch(texts: string[], signal?: AbortSignal, purpose?: EmbeddingPurpose): Promise<(Float32Array | null)[]>;
    dispose(): Promise<void>;
    isLoaded(): boolean;
    /**
     * Decide what this caller should do:
     *   - "allow":         CLOSED — proceed with a real request, not as a probe
     *   - "probe":         HALF_OPEN — this caller owns the probe slot
     *   - "short_circuit": OPEN or half-open probe already in flight — return nulls
     *
     * Claiming the probe slot (setting `halfOpenProbeInFlight = true`) is done
     * here, synchronously, so concurrent callers see the flag and short-circuit.
     */
    private claimProbeOrShortCircuit;
    private recordFailure;
    private recordSuccess;
    _getCircuitState(): CircuitState;
    _getFailureCount(): number;
    _resetCircuit(): void;
}
export {};
//# sourceMappingURL=embedding-openai.d.ts.map