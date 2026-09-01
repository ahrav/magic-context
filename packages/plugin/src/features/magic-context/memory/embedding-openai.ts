import { log } from "../../../shared/logger";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";
import { blockedEmbeddingEndpointReason } from "./embedding-ssrf";

interface OpenAICompatibleEmbeddingProviderOptions {
    endpoint?: string;
    model?: string;
    apiKey?: string;
    /** `inputType` supplies the default or passage `input_type` body field. */
    inputType?: string;
    /** The provider uses `queryInputType` for search embeddings and falls back to `inputType` when it is unset. */
    queryInputType?: string;
    /** `truncate` supplies the optional `truncate` body field. */
    truncate?: string;
    /** `maxInputTokens` caps chunk embeddings at a safe input-token count. */
    maxInputTokens?: number;
}

interface EmbeddingResponseBody {
    data?: Array<{
        embedding?: number[];
    }>;
    /** The endpoint reports its model in `model`.
     * */
    model?: string;
}

function normalizeEndpoint(endpoint?: string): string {
    return endpoint?.trim().replace(/\/+$/, "") ?? "";
}

type ParsedEmbeddingModel = {
    base: string;
    tag?: string;
};

function parseEmbeddingModel(model: string): ParsedEmbeddingModel {
    const lastColon = model.lastIndexOf(":");
    // Colons before the final slash are part of host-like prefixes, not model tags.
    if (lastColon > model.lastIndexOf("/")) {
        return { base: model.slice(0, lastColon), tag: model.slice(lastColon + 1) };
    }
    return { base: model };
}

function matchNormalizedEmbeddingModels(a: string, b: string): boolean {
    if (a.length === 0 || b.length === 0) return true; // can't compare → don't reject
    if (a === b) return true;
    const longer = a.length >= b.length ? a : b;
    const shorter = a.length >= b.length ? b : a;
    const isBoundary = (ch: string) => ch === "-" || ch === "/";
    // Version-expansion: longer = shorter + boundary + suffix (e.g. `…-small` → `…-small-v1`).
    if (longer.startsWith(shorter) && isBoundary(longer.charAt(shorter.length))) return true;
    // Vendor-prefix trim: longer = prefix + boundary + shorter (e.g. `openai/X` ↔ `X`).
    if (longer.endsWith(shorter) && isBoundary(longer.charAt(longer.length - shorter.length - 1)))
        return true;
    return false;
}

/**
 *
 *
 * Boundary-only matching prevents unrelated models from matching as interior fragments.
 */
export function embeddingModelsMatch(served: string, requested: string): boolean {
    const a = served.trim().toLowerCase();
    const b = requested.trim().toLowerCase();
    const servedModel = parseEmbeddingModel(a);
    const requestedModel = parseEmbeddingModel(b);

    if (
        servedModel.tag !== undefined &&
        requestedModel.tag !== undefined &&
        servedModel.tag !== requestedModel.tag
    ) {
        return false;
    }

    return matchNormalizedEmbeddingModels(servedModel.base, requestedModel.base);
}

/**
 * All callers share one circuit breaker, so failures from one caller can affect other callers.
 *
 * CLOSED issues requests and opens the breaker after FAILURE_THRESHOLD failures within FAILURE_WINDOW_MS.
 * OPEN short-circuits calls and returns null without making an HTTP request.
 * After OPEN_DURATION_MS, OPEN transitions to HALF_OPEN.
 * HALF_OPEN permits exactly one probe request.
 * Additional callers short-circuit while the HALF_OPEN probe is running.
 * A successful probe closes the circuit; a failed probe opens it immediately.
 * A failed half-open probe reopens the circuit for `OPEN_DURATION_MS`.
 *
 * Design notes:
 * Only the first caller after `circuitOpenUntil` elapses may probe the endpoint.
 * Limiting recovery to one probe prevents a request stampede.
 */
const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 60_000;
const OPEN_DURATION_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

type CircuitState = "closed" | "open" | "half_open";

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;
    readonly maxInputTokens: number;

    private readonly endpoint: string;
    private readonly model: string;
    private readonly apiKey: string;
    private readonly inputType: string;
    private readonly queryInputType: string;
    private readonly truncate: string;
    private initialized = false;

    private failureTimes: number[] = [];
    private circuitOpenUntil = 0;
    private openLogged = false;
    /** `modelMismatchLogged` prevents repeated warnings for persistent model substitution.
     * Logs at most one model-substitution warning per provider instance.
     * */
    private modelMismatchLogged = false;
    /**
     * */
    private halfOpenProbeInFlight = false;

    constructor(options: OpenAICompatibleEmbeddingProviderOptions) {
        this.endpoint = normalizeEndpoint(options.endpoint);
        this.model = options.model?.trim() ?? "";
        this.apiKey = options.apiKey?.trim() ?? "";
        this.inputType = options.inputType?.trim() ?? "";
        this.queryInputType = options.queryInputType?.trim() ?? "";
        this.truncate = options.truncate?.trim() ?? "";
        this.maxInputTokens =
            typeof options.maxInputTokens === "number" && Number.isFinite(options.maxInputTokens)
                ? Math.max(1, Math.floor(options.maxInputTokens))
                : 512;
        this.modelId = getEmbeddingProviderIdentity({
            provider: "openai-compatible",
            endpoint: this.endpoint,
            model: this.model,
            ...(this.apiKey ? { api_key: this.apiKey } : {}),
            ...(this.inputType ? { input_type: this.inputType } : {}),
            // `truncate` participates in identity because it changes which portion of an overlong input is embedded.
            // Read, write, and GC identity calculations must include the same optional fields.
            // Otherwise writes use a `model_id` that reads and GC do not resolve.
            // An identity mismatch can return zero results and reap valid vectors.
            ...(this.truncate ? { truncate: this.truncate } : {}),
        });
    }

    async initialize(): Promise<boolean> {
        if (this.initialized) return true;
        if (!this.endpoint || !this.model) {
            log(
                "[magic-context] openai-compatible embedding provider is missing endpoint or model",
            );
            this.initialized = false;
            return false;
        }

        // The provider rejects cloud-metadata and link-local endpoints because embedding request bodies can contain captured secrets.
        // LAN ranges remain allowed for self-hosted LM Studio and Ollama endpoints.
        // keep working.
        const blockedReason = blockedEmbeddingEndpointReason(this.endpoint);
        if (blockedReason) {
            log(`[magic-context] embedding endpoint blocked: ${blockedReason}`);
            this.initialized = false;
            return false;
        }

        this.initialized = true;
        return true;
    }

    private resolveInputTypeForPurpose(purpose: EmbeddingPurpose = "passage"): string {
        if (purpose === "query") {
            return this.queryInputType || this.inputType;
        }
        return this.inputType;
    }

    async embed(
        text: string,
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<Float32Array | null> {
        const [embedding] = await this.embedBatch([text], signal, purpose);
        return embedding ?? null;
    }

    async embedBatch(
        texts: string[],
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<(Float32Array | null)[]> {
        if (texts.length === 0) {
            return [];
        }

        const requestTexts = texts.map((t) => (t.trim().length === 0 ? " " : t));

        if (!(await this.initialize())) {
            return Array.from({ length: texts.length }, () => null);
        }

        if (signal?.aborted) {
            return Array.from({ length: texts.length }, () => null);
        }

        // The circuit check atomically claims the half-open probe slot.
        // `try`/`finally` releases the probe slot when setup throws.
        // Every claimed probe slot is released so the circuit cannot remain half-open permanently.
        let isProbe = false;
        let internalController: AbortController | undefined;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let onOuterAbort: (() => void) | undefined;

        try {
            const claim = this.claimProbeOrShortCircuit();
            if (claim === "short_circuit") {
                return Array.from({ length: texts.length }, () => null);
            }
            isProbe = claim === "probe";
            internalController = new AbortController();
            timeoutHandle = setTimeout(() => internalController?.abort(), FETCH_TIMEOUT_MS);
            onOuterAbort = () => internalController?.abort();
            if (signal) {
                signal.addEventListener("abort", onOuterAbort, { once: true });
            }

            const inputTypeForRequest = this.resolveInputTypeForPurpose(purpose);
            const response = await fetch(`${this.endpoint}/embeddings`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: this.model,
                    input: requestTexts,
                    // The provider omits unset fields to preserve compatibility with standard OpenAI endpoints.
                    // unaffected.
                    ...(inputTypeForRequest ? { input_type: inputTypeForRequest } : {}),
                    ...(this.truncate ? { truncate: this.truncate } : {}),
                }),
                // The pre-flight SSRF check validates only the configured endpoint.
                // Default redirect-following can send embedding request bodies to a destination that the pre-flight SSRF check did not validate.
                // Fetch rejects redirect responses when `redirect` is `"error"`.
                redirect: "error",
                signal: internalController.signal,
            });

            if (!response.ok) {
                log(
                    `[magic-context] openai-compatible embedding request failed: ${response.status} ${response.statusText}`,
                );
                this.recordFailure(isProbe);
                return Array.from({ length: texts.length }, () => null);
            }

            // Reading the body as text enables diagnostics for malformed response bodies.
            const rawBody = await response.text();
            if (rawBody.trim().length === 0) {
                log(
                    `[magic-context] openai-compatible embedding request returned empty body (status=${response.status}, content-type=${response.headers.get("content-type") ?? "none"})`,
                );
                this.recordFailure(isProbe);
                return Array.from({ length: texts.length }, () => null);
            }
            let body: EmbeddingResponseBody;
            try {
                body = JSON.parse(rawBody) as EmbeddingResponseBody;
            } catch (parseError) {
                const snippet = rawBody.slice(0, 200).replace(/\s+/g, " ");
                log(
                    `[magic-context] openai-compatible embedding response was not JSON (status=${response.status}, ${rawBody.length}B body, snippet="${snippet}"):`,
                    parseError instanceof Error ? parseError.message : parseError,
                );
                this.recordFailure(isProbe);
                return Array.from({ length: texts.length }, () => null);
            }
            // Vectors from another model must not be indexed under the requested model.
            // Indexing vectors under another model's identity silently corrupts the index, so the client refuses them.
            const servedModel = typeof body.model === "string" ? body.model : "";
            if (this.model && servedModel && !embeddingModelsMatch(servedModel, this.model)) {
                if (!this.modelMismatchLogged) {
                    log(
                        `[magic-context] embedding endpoint served a DIFFERENT model than requested — refusing the substituted vectors (they have the wrong dimensions/space). requested="${this.model}" served="${servedModel}". Check that the endpoint serves the requested model; variant suffixes and vendor prefixes are matched automatically.`,
                    );
                    this.modelMismatchLogged = true;
                }
                this.recordFailure(isProbe);
                return Array.from({ length: texts.length }, () => null);
            }

            const items = Array.isArray(body.data) ? body.data : [];

            const results = Array.from({ length: texts.length }, (_, index) => {
                const embedding = items[index]?.embedding;
                return Array.isArray(embedding) ? Float32Array.from(embedding) : null;
            });

            // A response with no usable vectors is a failed embedding response.
            if (results.every((r) => r === null)) {
                this.recordFailure(isProbe);
            } else {
                this.recordSuccess();
            }

            return results;
        } catch (error) {
            // The catch block also receives `AbortError` from the fetch timeout or the caller abort signal.
            const isAbort =
                error instanceof Error &&
                (error.name === "AbortError" || error.message.includes("aborted"));
            if (isAbort) {
                // Caller aborts do not penalize the endpoint; internal timeouts do.
                if (signal?.aborted) {
                    // Releasing the half-open probe slot without changing circuit state lets the next real call probe again.
                } else {
                    log(
                        `[magic-context] openai-compatible embedding request timed out after ${FETCH_TIMEOUT_MS}ms`,
                    );
                    this.recordFailure(isProbe);
                }
            } else {
                log("[magic-context] openai-compatible embedding request failed:", error);
                this.recordFailure(isProbe);
            }
            return Array.from({ length: texts.length }, () => null);
        } finally {
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
            }
            if (signal && onOuterAbort) {
                signal.removeEventListener("abort", onOuterAbort);
            }
            if (isProbe) {
                this.halfOpenProbeInFlight = false;
            }
        }
    }

    async dispose(): Promise<void> {
        this.initialized = false;
    }

    isLoaded(): boolean {
        return this.initialized;
    }

    /**
     * "allow" means the circuit is CLOSED; the caller makes a non-probe request.
     * "probe" means the circuit is HALF_OPEN; the caller owns the probe slot.
     * "short_circuit" means the circuit is OPEN or a half-open probe is in flight; the caller returns nulls.
     *
     * This function synchronously sets `halfOpenProbeInFlight` before returning so concurrent callers short-circuit.
     */
    private claimProbeOrShortCircuit(): "allow" | "probe" | "short_circuit" {
        if (this.circuitOpenUntil === 0) {
            return "allow";
        }
        if (Date.now() < this.circuitOpenUntil) {
            return "short_circuit";
        }
        // The circuit enters HALF_OPEN after `circuitOpenUntil` elapses.
        if (this.halfOpenProbeInFlight) {
            return "short_circuit";
        }
        // The half-open transition sets `halfOpenProbeInFlight` but preserves `circuitOpenUntil` until `recordSuccess()`.
        this.halfOpenProbeInFlight = true;
        log("[magic-context] openai-compatible embedding: circuit half-open, probing endpoint");
        return "probe";
    }

    private recordFailure(isProbe: boolean): void {
        if (isProbe) {
            // A single half-open probe failure reopens the circuit.
            this.circuitOpenUntil = Date.now() + OPEN_DURATION_MS;
            if (!this.openLogged) {
                log(
                    `[magic-context] openai-compatible embedding: probe failed, re-opening circuit for ${OPEN_DURATION_MS / 60_000}min`,
                );
                this.openLogged = true;
            }
            this.failureTimes = [];
            return;
        }

        const now = Date.now();
        const cutoff = now - FAILURE_WINDOW_MS;
        this.failureTimes = this.failureTimes.filter((t) => t > cutoff);
        this.failureTimes.push(now);

        if (this.failureTimes.length >= FAILURE_THRESHOLD) {
            this.circuitOpenUntil = now + OPEN_DURATION_MS;
            if (!this.openLogged) {
                log(
                    `[magic-context] openai-compatible embedding: opening circuit for ${OPEN_DURATION_MS / 60_000}min after ${this.failureTimes.length} failures in ${FAILURE_WINDOW_MS / 1_000}s`,
                );
                this.openLogged = true;
            }
            // counting fresh.
            this.failureTimes = [];
        }
    }

    private recordSuccess(): void {
        if (this.failureTimes.length > 0 || this.circuitOpenUntil > 0 || this.openLogged) {
            log("[magic-context] openai-compatible embedding: endpoint recovered, circuit closed");
        }
        this.failureTimes = [];
        this.circuitOpenUntil = 0;
        this.openLogged = false;
    }

    // Test-only hooks.
    _getCircuitState(): CircuitState {
        if (this.circuitOpenUntil === 0) return "closed";
        if (Date.now() < this.circuitOpenUntil) {
            return this.halfOpenProbeInFlight ? "half_open" : "open";
        }
        return "half_open";
    }
    _getFailureCount(): number {
        return this.failureTimes.length;
    }
    _resetCircuit(): void {
        this.failureTimes = [];
        this.circuitOpenUntil = 0;
        this.openLogged = false;
        this.halfOpenProbeInFlight = false;
    }
}
