import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import { embeddingModelsMatch, OpenAICompatibleEmbeddingProvider } from "./embedding-openai";

describe("provider modelId matches canonical identity (write/read must agree)", () => {
    // The provider stores writes under `this.modelId`.
    // registry/GC/reads resolve via getEmbeddingProviderIdentity(config). Any
    // Identity-affecting fields must be identical in `this.modelId` and `getEmbeddingProviderIdentity(config)`.
    const cases: Array<{ name: string; config: EmbeddingConfig }> = [
        {
            name: "endpoint+model only",
            config: { provider: "openai-compatible", endpoint: "http://h/v1", model: "m" },
        },
        {
            name: "with api_key + input_type",
            config: {
                provider: "openai-compatible",
                endpoint: "http://h/v1",
                model: "m",
                api_key: "k",
                input_type: "passage",
            },
        },
        {
            name: "with truncate set",
            config: {
                provider: "openai-compatible",
                endpoint: "http://h/v1",
                model: "m",
                truncate: "END",
            },
        },
    ];
    for (const c of cases) {
        test(c.name, () => {
            const provider = new OpenAICompatibleEmbeddingProvider({
                endpoint: c.config.endpoint,
                model: c.config.model,
                apiKey: c.config.provider === "openai-compatible" ? c.config.api_key : undefined,
                inputType:
                    c.config.provider === "openai-compatible" ? c.config.input_type : undefined,
                truncate: c.config.provider === "openai-compatible" ? c.config.truncate : undefined,
            });
            expect(provider.modelId).toBe(getEmbeddingProviderIdentity(c.config));
        });
    }

    test("endpoint trailing slash is normalized out of the identity", () => {
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://localhost:1234/v1/",
            model: "text-embedding-3-small",
            apiKey: "secret",
        });

        expect(provider.modelId).toBe(
            getEmbeddingProviderIdentity({
                provider: "openai-compatible",
                endpoint: "http://localhost:1234/v1",
                model: "text-embedding-3-small",
                api_key: "present",
            }),
        );
        expect(provider.isLoaded()).toBe(false);
    });

    test("identity tracks api-key presence but not the secret value", () => {
        const first = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://localhost:1234/v1/",
            model: "text-embedding-3-small",
            apiKey: "secret-one",
        });
        const rotated = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://localhost:1234/v1",
            model: "text-embedding-3-small",
            apiKey: "secret-two",
        });
        const anonymous = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://localhost:1234/v1",
            model: "text-embedding-3-small",
        });

        expect(first.modelId).toBe(rotated.modelId);
        expect(first.modelId).not.toBe(anonymous.modelId);
        expect(first.modelId).not.toContain("secret");
    });
});

describe("embeddingModelsMatch token-boundary semantics", () => {
    test("exact match", () => {
        expect(embeddingModelsMatch("qwen3-embedding-4b", "qwen3-embedding-4b")).toBe(true);
    });
    test("version-expansion suffix on a boundary matches", () => {
        expect(embeddingModelsMatch("text-embedding-3-small-v1", "text-embedding-3-small")).toBe(
            true,
        );
    });
    test("vendor-prefix trim on a boundary matches (either direction)", () => {
        expect(
            embeddingModelsMatch("openai/text-embedding-3-small", "text-embedding-3-small"),
        ).toBe(true);
        expect(
            embeddingModelsMatch("text-embedding-3-small", "openai/text-embedding-3-small"),
        ).toBe(true);
    });
    test("matches OpenRouter's canonicalized prefix and variant removal (#306)", () => {
        expect(
            embeddingModelsMatch(
                "private/openrouter/nvidia/llama-nemotron-embed-vl-1b-v2",
                "nvidia/llama-nemotron-embed-vl-1b-v2:free",
            ),
        ).toBe(true);
    });
    test("matches a single-sided variant tag", () => {
        expect(embeddingModelsMatch("X:latest", "X")).toBe(true);
    });
    test("matches equal tags", () => {
        expect(embeddingModelsMatch("X:free", "X:free")).toBe(true);
    });
    test("rejects different model-size tags", () => {
        expect(embeddingModelsMatch("mxbai-embed-large:335m", "mxbai-embed-large:137m")).toBe(
            false,
        );
        expect(embeddingModelsMatch("nomic-embed-text:v1", "nomic-embed-text:v1.5")).toBe(false);
    });
    test("still rejects a genuine substitution with a variant tag", () => {
        expect(
            embeddingModelsMatch("all-minilm-l6-v2", "nvidia/llama-nemotron-embed-vl-1b-v2:free"),
        ).toBe(false);
    });
    test("REJECTS a broad configured name contained as an interior token (corruption hole)", () => {
        // `0.6b` is a distinct model token, not a version suffix.
        expect(embeddingModelsMatch("text-embedding-qwen3-embedding-0.6b", "qwen3-embedding")).toBe(
            false,
        );
        expect(
            embeddingModelsMatch("qwen3-embedding-4b-dwq", "text-embedding-qwen3-embedding-0.6b"),
        ).toBe(false);
    });
    test("REJECTS a non-boundary prefix collision (small vs smaller)", () => {
        expect(embeddingModelsMatch("text-embedding-3-smallish", "text-embedding-3-small")).toBe(
            false,
        );
    });
    test("empty served or requested cannot be compared → not rejected", () => {
        expect(embeddingModelsMatch("", "anything")).toBe(true);
        expect(embeddingModelsMatch("anything", "")).toBe(true);
    });
});

type FetchLike = typeof fetch;

function makeProvider(): OpenAICompatibleEmbeddingProvider {
    return new OpenAICompatibleEmbeddingProvider({
        endpoint: "http://127.0.0.1:65535",
        model: "test-model",
    });
}

function successResponse(count = 1): Response {
    const body = {
        data: Array.from({ length: count }, () => ({ embedding: [0.1, 0.2, 0.3] })),
    };
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function errorResponse(): Response {
    return new Response("internal", { status: 500 });
}

describe("OpenAICompatibleEmbeddingProvider request body (NVIDIA NIM fields, issue #127)", () => {
    let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

    beforeEach(() => {
        fetchSpy = spyOn(globalThis, "fetch");
    });
    afterEach(() => {
        fetchSpy.mockRestore();
    });

    async function capturedBody(
        provider: OpenAICompatibleEmbeddingProvider,
    ): Promise<Record<string, unknown>> {
        fetchSpy.mockImplementation((async () => successResponse()) as FetchLike);
        await provider.embed("hello");
        const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
        return JSON.parse(init.body as string) as Record<string, unknown>;
    }

    test("includes input_type and truncate when configured", async () => {
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://127.0.0.1:65535",
            model: "nvidia/nv-embed",
            inputType: "passage",
            truncate: "END",
        });
        const body = await capturedBody(provider);
        expect(body.input_type).toBe("passage");
        expect(body.truncate).toBe("END");
        expect(body.model).toBe("nvidia/nv-embed");
    });

    test("omits input_type and truncate entirely when unset (standard OpenAI unaffected)", async () => {
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://127.0.0.1:65535",
            model: "text-embedding-3-small",
        });
        const body = await capturedBody(provider);
        expect("input_type" in body).toBe(false);
        expect("truncate" in body).toBe(false);
        expect(body.input).toBeDefined();
    });

    test("coerces empty / whitespace-only input to a space so the provider can't 400 the batch", async () => {
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://127.0.0.1:65535",
            model: "text-embedding-3-small",
        });
        fetchSpy.mockImplementation((async () => successResponse()) as FetchLike);
        await provider.embedBatch(["", "   ", "real text", "\n\t"]);
        const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
        const body = JSON.parse(init.body as string) as { input: string[] };
        // Empty / whitespace inputs become a single space; real text is untouched.
        expect(body.input).toEqual([" ", " ", "real text", " "]);
    });

    test("purpose query sends queryInputType when configured (#155)", async () => {
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://127.0.0.1:65535",
            model: "nvidia/nv-embed",
            inputType: "passage",
            queryInputType: "query",
        });
        fetchSpy.mockImplementation((async () => successResponse()) as FetchLike);
        await provider.embed("search text", undefined, "query");
        const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body.input_type).toBe("query");
    });

    test("purpose passage sends inputType when configured (#155)", async () => {
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://127.0.0.1:65535",
            model: "nvidia/nv-embed",
            inputType: "passage",
            queryInputType: "query",
        });
        fetchSpy.mockImplementation((async () => successResponse()) as FetchLike);
        await provider.embed("stored text", undefined, "passage");
        const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body.input_type).toBe("passage");
    });

    test("purpose query falls back to inputType when queryInputType unset (backward compat)", async () => {
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://127.0.0.1:65535",
            model: "nvidia/nv-embed",
            inputType: "passage",
        });
        fetchSpy.mockImplementation((async () => successResponse()) as FetchLike);
        await provider.embed("search text", undefined, "query");
        const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body.input_type).toBe("passage");
    });

    test("purpose query with both input types unset omits input_type", async () => {
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://127.0.0.1:65535",
            model: "text-embedding-3-small",
        });
        fetchSpy.mockImplementation((async () => successResponse()) as FetchLike);
        await provider.embed("search text", undefined, "query");
        const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect("input_type" in body).toBe(false);
    });
});

describe("OpenAICompatibleEmbeddingProvider circuit breaker", () => {
    let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

    beforeEach(() => {
        fetchSpy = spyOn(globalThis, "fetch");
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    test("opens circuit after 3 consecutive failures within window", async () => {
        fetchSpy.mockImplementation((async () => errorResponse()) as FetchLike);

        const provider = makeProvider();
        await provider.embed("one");
        await provider.embed("two");
        expect(provider._getCircuitState()).toBe("closed");
        expect(provider._getFailureCount()).toBe(2);

        await provider.embed("three");
        expect(provider._getCircuitState()).toBe("open");
    });

    test("open circuit short-circuits without issuing fetch", async () => {
        fetchSpy.mockImplementation((async () => errorResponse()) as FetchLike);

        const provider = makeProvider();
        await provider.embed("a");
        await provider.embed("b");
        await provider.embed("c");
        expect(provider._getCircuitState()).toBe("open");

        const beforeCount = fetchSpy.mock.calls.length;
        const result = await provider.embed("d");
        expect(result).toBeNull();
        expect(fetchSpy.mock.calls.length).toBe(beforeCount); // no new fetch
    });

    test("success resets failure counters", async () => {
        let fail = true;
        fetchSpy.mockImplementation((async () =>
            fail ? errorResponse() : successResponse()) as FetchLike);

        const provider = makeProvider();
        await provider.embed("x");
        await provider.embed("y");
        expect(provider._getFailureCount()).toBe(2);

        fail = false;
        const result = await provider.embed("ok");
        expect(result).not.toBeNull();
        expect(provider._getFailureCount()).toBe(0);
        expect(provider._getCircuitState()).toBe("closed");
    });

    test("aborts fetch when it exceeds timeout (AbortError path records failure)", async () => {
        fetchSpy.mockImplementation(async () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            throw err;
        });

        const provider = makeProvider();
        const result = await provider.embed("will time out");
        expect(result).toBeNull();
        expect(provider._getFailureCount()).toBe(1);
    });

    test("failures outside the rolling window don't accumulate toward open", async () => {
        fetchSpy.mockImplementation((async () => errorResponse()) as FetchLike);

        const provider = makeProvider();

        await provider.embed("one");
        expect(provider._getFailureCount()).toBe(1);
        provider._resetCircuit();

        await provider.embed("two");
        await provider.embed("three");
        expect(provider._getFailureCount()).toBe(2);
        expect(provider._getCircuitState()).toBe("closed");
    });

    test("half-open probe: single failure re-opens circuit (canonical pattern)", async () => {
        fetchSpy.mockImplementation((async () => errorResponse()) as FetchLike);

        const provider = makeProvider();
        await provider.embed("a");
        await provider.embed("b");
        await provider.embed("c");
        expect(provider._getCircuitState()).toBe("open");

        // The test hook bypasses the 5-minute open interval.
        provider._resetCircuit();
        // A past OPEN timestamp makes the next call a half-open probe.
        (provider as unknown as { circuitOpenUntil: number }).circuitOpenUntil = Date.now() - 10;

        // After the open interval elapses, the next call is a half-open probe.
        // One failed half-open probe reopens the circuit; CLOSED requires three failures.
        const beforeProbeFailureCount = provider._getFailureCount();
        await provider.embed("probe");
        expect(provider._getFailureCount()).toBe(beforeProbeFailureCount); // window cleared on re-open
        expect(provider._getCircuitState()).toBe("open");
    });

    test("half-open probe in flight: concurrent callers short-circuit (no stampede)", async () => {
        // The mock fetch remains pending so the probe stays in flight.
        let hangResolver: ((r: Response) => void) | undefined;
        fetchSpy.mockImplementation(
            (async () =>
                new Promise<Response>((resolve) => {
                    hangResolver = resolve;
                })) as FetchLike,
        );

        const provider = makeProvider();
        (provider as unknown as { circuitOpenUntil: number }).circuitOpenUntil = Date.now() - 10;

        // Caller 1 claims the probe slot without awaiting it.
        const probePromise = provider.embed("probe-caller");

        // A microtask lets caller 1 claim the probe slot before caller 2 starts.
        await Promise.resolve();

        // Caller 2 short-circuits while the half-open probe is in flight.
        // Half-open permits one caller while a probe is in flight.
        const beforeConcurrentFetches = fetchSpy.mock.calls.length;
        const concurrentResult = await provider.embed("concurrent-caller");
        expect(concurrentResult).toBeNull();
        expect(fetchSpy.mock.calls.length).toBe(beforeConcurrentFetches);

        // A successful half-open probe closes the circuit.
        hangResolver?.(successResponse());
        await probePromise;
        expect(provider._getCircuitState()).toBe("closed");
    });

    test("outer caller abort doesn't count against the circuit", async () => {
        fetchSpy.mockImplementation((async (_url, init) => {
            const signal = (init as RequestInit | undefined)?.signal;
            if (signal) {
                return new Promise<Response>((_resolve, reject) => {
                    signal.addEventListener("abort", () => {
                        const err = new Error("The operation was aborted");
                        err.name = "AbortError";
                        reject(err);
                    });
                });
            }
            return successResponse();
        }) as FetchLike);

        const provider = makeProvider();
        const outerController = new AbortController();
        const outerSignal = outerController.signal;

        setTimeout(() => outerController.abort(), 30);

        const result = await provider.embed("hang but outer aborts", outerSignal);
        expect(result).toBeNull();
        // A caller abort does not count as an endpoint failure.
        // A caller abort does not indicate endpoint health.
        expect(provider._getFailureCount()).toBe(0);
    });

    test("treats 200 with empty body as a typed failure (no SyntaxError leak)", async () => {
        fetchSpy.mockImplementation(
            (async () =>
                new Response("", {
                    status: 200,
                    headers: { "content-type": "application/json" },
                })) as FetchLike,
        );

        const provider = makeProvider();
        const result = await provider.embed("text");
        expect(result).toBeNull();
        // A 200 response with an empty body counts as a failure for circuit-breaker purposes.
        // A 200 response with an empty body counts as a failure because it provides no embedding.
        expect(provider._getFailureCount()).toBe(1);
    });

    test("treats 200 with non-JSON body as a typed failure (no SyntaxError leak)", async () => {
        // A 200 response with an HTML body must produce a typed failure rather than leak a JSON parse error.
        fetchSpy.mockImplementation(
            (async () =>
                new Response("<html>upstream error</html>", {
                    status: 200,
                    headers: { "content-type": "text/html" },
                })) as FetchLike,
        );

        const provider = makeProvider();
        const result = await provider.embed("text");
        expect(result).toBeNull();
        expect(provider._getFailureCount()).toBe(1);
    });
});

describe("OpenAICompatibleEmbeddingProvider model-substitution guard", () => {
    let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
    beforeEach(() => {
        fetchSpy = spyOn(globalThis, "fetch");
    });
    afterEach(() => {
        fetchSpy.mockRestore();
    });

    function modelResponse(model: string): Response {
        return new Response(JSON.stringify({ model, data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }

    test("rejects vectors when the endpoint serves a DIFFERENT model (LMStudio substitution)", async () => {
        fetchSpy.mockImplementation((async () =>
            modelResponse("text-embedding-qwen3-embedding-0.6b")) as FetchLike);
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://127.0.0.1:65535",
            model: "qwen3-embedding-4b-dwq",
        });
        const result = await provider.embed("text");
        expect(result).toBeNull();
        // A model mismatch counts as a failure so the circuit breaker backs off the misrouting endpoint.
        expect(provider._getFailureCount()).toBe(1);
    });

    test("accepts vectors when the served model matches exactly", async () => {
        fetchSpy.mockImplementation((async () =>
            modelResponse("qwen3-embedding-4b-dwq")) as FetchLike);
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://127.0.0.1:65535",
            model: "qwen3-embedding-4b-dwq",
        });
        const result = await provider.embed("text");
        expect(result).not.toBeNull();
        expect(provider._getFailureCount()).toBe(0);
    });

    test("tolerates version-expanded / prefix model names (no false rejection)", async () => {
        fetchSpy.mockImplementation((async () =>
            modelResponse("text-embedding-3-small-v1")) as FetchLike);
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://127.0.0.1:65535",
            model: "text-embedding-3-small",
        });
        const result = await provider.embed("text");
        expect(result).not.toBeNull();
        expect(provider._getFailureCount()).toBe(0);
    });

    test("accepts when the endpoint omits the model field (cannot compare)", async () => {
        fetchSpy.mockImplementation(
            (async () =>
                new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                })) as FetchLike,
        );
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: "http://127.0.0.1:65535",
            model: "any-model",
        });
        const result = await provider.embed("text");
        expect(result).not.toBeNull();
        expect(provider._getFailureCount()).toBe(0);
    });
});
