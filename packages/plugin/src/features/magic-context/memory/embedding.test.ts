import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { cosineSimilarity } from "./cosine-similarity";
import { _resetEmbeddingConfigForTests, embedText, initializeEmbedding } from "./embedding";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import { LocalEmbeddingProvider } from "./embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./embedding-openai";

describe("embedding module", () => {
    describe("#given cosine similarity", () => {
        it("returns 1 for identical vectors", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([1, 2, 3]),
                new Float32Array([1, 2, 3]),
            );

            //#then
            expect(similarity).toBe(1);
        });

        it("returns 0 for orthogonal vectors", () => {
            //#when
            const similarity = cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]));

            //#then
            expect(similarity).toBe(0);
        });

        it("returns -1 for opposite vectors", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([1, 0]),
                new Float32Array([-1, 0]),
            );

            //#then
            expect(similarity).toBe(-1);
        });

        it("handles zero vectors gracefully", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([0, 0, 0]),
                new Float32Array([0, 0, 0]),
            );

            //#then
            expect(similarity).toBe(0);
        });

        it("handles different length vectors", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([1, 2, 3]),
                new Float32Array([1, 2]),
            );

            //#then
            expect(similarity).toBe(0);
        });
    });

    describe("#given embedding providers", () => {
        it("local provider uses default model id and starts unloaded", () => {
            const provider = new LocalEmbeddingProvider();

            expect(provider.modelId).toBe(
                getEmbeddingProviderIdentity({
                    provider: "local",
                    model: "Xenova/bge-small-en-v1.5",
                }),
            );
            expect(provider.isLoaded()).toBe(false);
        });

        it("openai-compatible provider normalizes endpoint in model id", () => {
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

        it("openai-compatible identity tracks api-key presence but not secret value", () => {
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

    describe("#given the module-level embedText helper (R2)", () => {
        let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

        beforeEach(() => {
            fetchSpy = spyOn(globalThis, "fetch");
            fetchSpy.mockImplementation(
                (async () =>
                    new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
                        headers: { "content-type": "application/json" },
                    })) as unknown as typeof fetch,
            );
            initializeEmbedding({
                provider: "openai-compatible",
                model: "nvidia/nv-embed",
                endpoint: "http://127.0.0.1:65535",
                input_type: "passage",
                query_input_type: "query",
            });
        });

        afterEach(() => {
            _resetEmbeddingConfigForTests();
            fetchSpy.mockRestore();
        });

        function sentInputType(): unknown {
            const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit;
            return (JSON.parse(init.body as string) as Record<string, unknown>).input_type;
        }

        it("defaults to the passage input type when no purpose is given", async () => {
            const vector = await embedText("stored content");
            expect(vector).not.toBeNull();
            expect(sentInputType()).toBe("passage");
        });

        it("forwards an explicit query purpose to the provider", async () => {
            const vector = await embedText("search text", undefined, "query");
            expect(vector).not.toBeNull();
            expect(sentInputType()).toBe("query");
        });
    });
});
