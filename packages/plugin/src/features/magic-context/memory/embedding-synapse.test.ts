import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    createSynapseLedgerPage,
    getSynapseLedgerPage,
    markSynapseLedgerObsolete,
    markSynapseLedgerOutcome,
    markSynapseLedgerPolling,
    markSynapseLedgerReady,
    recordSynapseLedgerCursor,
    recordSynapseLedgerJob,
    recordSynapseLedgerRestart,
} from "../storage-embedding-measurements";
import { createDirectTestDatabase } from "../test-database";
import type { DetailedEmbedContext, DetailedEmbedItem } from "./embedding-provider";
import {
    _resetSynapseClientForTests,
    _synapseSharedClientStateForTests,
    getSynapseBatchRequestKey,
    getSynapseLaneIdentity,
    SYNAPSE_MAX_INPUT_TOKENS,
    type SynapseClientLike,
    SynapseEmbeddingProvider,
} from "./embedding-synapse";

class MockSynapseClient implements SynapseClientLike {
    readonly requests: Array<{ method: string; params: unknown }> = [];
    private batchAttempts = 0;
    constructor(private readonly batchSize = 2) {}

    async call<Response = unknown>(
        _module: string,
        method: string,
        params?: unknown,
    ): Promise<Response> {
        this.requests.push({ method, params });
        if (method === "models.list") {
            return {
                models: [
                    {
                        model: "gte-modernbert-base-f16",
                        fingerprint: "fp-live",
                        table_epoch: 0,
                        dims: 3,
                        recommended_batch: this.batchSize,
                        provenance: { source: "fixture" },
                    },
                ],
            } as Response;
        }
        if (method === "embed.query") {
            return {
                vector: [1, 2, 3],
                fingerprint: "fp-live",
                table_epoch: 0,
            } as Response;
        }
        if (method === "embed.batch") {
            this.batchAttempts += 1;
            if (this.batchAttempts === 1) {
                const error = new Error("module is loading") as Error & {
                    code: string;
                    retry_after_ms: number;
                };
                error.code = "model_loading";
                error.retry_after_ms = 0;
                throw error;
            }
            const request = params as { items: Array<{ id: string; content_sha256: string }> };
            return {
                items: request.items.map((item) => ({
                    id: item.id,
                    embedding: [1, 2, 3],
                    content_sha256: item.content_sha256,
                    fingerprint: "fp-live",
                    table_epoch: 0,
                })),
            } as Response;
        }
        throw new Error(`unexpected method ${method}`);
    }

    close(): void {}
}

afterEach(() => {
    _resetSynapseClientForTests();
});

describe("SynapseEmbeddingProvider", () => {
    it("discovers a certified model and sends the required artifact constraints", async () => {
        const client = new MockSynapseClient();
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });

        expect(await provider.initialize()).toBe(true);
        expect(provider.maxInputTokens).toBe(SYNAPSE_MAX_INPUT_TOKENS);
        expect(provider.modelId).toBe(getSynapseLaneIdentity("gte-modernbert-base-f16", "fp-live"));

        const vector = await provider.embed("hello");
        expect(vector).toEqual(new Float32Array([1, 2, 3]));
        const request = client.requests.find((entry) => entry.method === "embed.query");
        expect(request?.params).toMatchObject({
            model: "gte-modernbert-base-f16",
            required_fingerprint: "fp-live",
            required_epoch: 0,
            allow_equivalent: false,
            accept_declared: false,
        });
    });

    it("adopts the catalog's advertised input limits", async () => {
        const client = new MockSynapseClient();
        client.call = async <Response = unknown>(
            _module: string,
            method: string,
            params?: unknown,
        ) => {
            client.requests.push({ method, params });
            if (method === "models.list") {
                return {
                    models: [
                        {
                            model: "gte-modernbert-base-f16",
                            fingerprint: "fp-live",
                            table_epoch: 0,
                            dims: 3,
                            max_input_tokens: 2048,
                            max_input_bytes: 4096,
                        },
                    ],
                } as Response;
            }
            throw new Error(`unexpected method ${method}`);
        };
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });

        expect(await provider.initialize()).toBe(true);
        expect(provider.maxInputTokens).toBe(2048);
        expect(provider.maxInputBytes).toBe(4096);
    });

    it("honors the live recommended batch size and retries model loading with retry_after_ms", async () => {
        const client = new MockSynapseClient(1);
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });

        const vectors = await provider.embedItems([
            { id: "memory:1", text: "one", contentSha256: "a" },
            { id: "memory:2", text: "two", contentSha256: "b" },
        ]);

        expect(vectors.size).toBe(2);
        expect(client.requests.filter((entry) => entry.method === "embed.batch")).toHaveLength(3);
        const keys = client.requests
            .filter((entry) => entry.method === "embed.batch")
            .map((entry) => (entry.params as { request_key: string }).request_key);
        expect(keys[0]).toBe(keys[1]);
    });

    it("rejects served fingerprint substitution without adapting", async () => {
        const client = new MockSynapseClient();
        client.call = async <Response = unknown>(
            _module: string,
            method: string,
            params?: unknown,
        ) => {
            client.requests.push({ method, params });
            if (method === "models.list") {
                return {
                    models: [
                        {
                            model: "gte-modernbert-base-f16",
                            fingerprint: "fp-live",
                            table_epoch: 0,
                            dims: 3,
                        },
                    ],
                } as Response;
            }
            return { vector: [1, 2, 3], fingerprint: "fp-other", table_epoch: 0 } as Response;
        };
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });

        expect(await provider.embed("hello")).toBeNull();
        expect(await provider.embed("again")).toBeNull();
    });

    it("refuses rediscovery that rotates the pinned lane fingerprint", async () => {
        const client = new MockSynapseClient();
        client.call = async <Response = unknown>(
            _module: string,
            method: string,
            params?: unknown,
        ) => {
            client.requests.push({ method, params });
            if (method === "models.list") {
                return {
                    models: [
                        {
                            model: "gte-modernbert-base-f16",
                            fingerprint: "fp-rotated",
                            table_epoch: 1,
                        },
                    ],
                } as Response;
            }
            return { vector: [1, 2, 3], fingerprint: "fp-rotated", table_epoch: 1 } as Response;
        };
        // The routing probe pins model, fingerprint, and epoch but not dims —
        // the live catalog omits them — so this provider must rediscover before
        // its first call while its registration's destination rows are already
        // keyed to the pinned lane identity.
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            model: "gte-modernbert-base-f16",
            fingerprint: "fp-pinned",
            tableEpoch: 0,
            clientFactory: async () => client,
        });

        expect(await provider.initialize()).toBe(false);
        expect(provider.modelId).not.toBe(
            getSynapseLaneIdentity("gte-modernbert-base-f16", "fp-rotated"),
        );
        expect(await provider.embed("hello")).toBeNull();
        const vectors = await provider.embedItems([
            { id: "memory:1", text: "one", contentSha256: "a" },
        ]);
        expect(vectors.size).toBe(0);
        expect(client.requests.some((entry) => entry.method === "embed.batch")).toBe(false);
    });

    it("adopts rediscovered dims when the pinned lane identity still matches", async () => {
        const client = new MockSynapseClient();
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            model: "gte-modernbert-base-f16",
            fingerprint: "fp-live",
            tableEpoch: 0,
            clientFactory: async () => client,
        });

        expect(await provider.initialize()).toBe(true);
        expect(provider.modelId).toBe(getSynapseLaneIdentity("gte-modernbert-base-f16", "fp-live"));
        expect(await provider.embed("hello")).toEqual(new Float32Array([1, 2, 3]));
    });
});

describe("recommended batch policy", () => {
    it("object-form recommended_batch {rows, token_budget} sets both limits and pages split on the token budget", async () => {
        const calls: number[][] = [];
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            clientFactory: async () =>
                ({
                    async call(_m: string, method: string, params?: unknown) {
                        if (method === "models.list") {
                            return {
                                result: {
                                    table_epoch: 0,
                                    models: [
                                        {
                                            model_id: "gte-modernbert-base-f16",
                                            fingerprints: ["fp1"],
                                            state: "ready",
                                            recommended_batch: { rows: 3, token_budget: 100 },
                                        },
                                    ],
                                },
                            };
                        }
                        const items = (params as { items: { id: string; text: string }[] }).items;
                        calls.push(items.map((item) => item.text.length));
                        return {
                            items: items.map((item) => ({
                                id: item.id,
                                embedding: [0.5, 0.5],
                                content_sha256: createHash("sha256")
                                    .update(item.text)
                                    .digest("hex"),
                                fingerprint: "fp1",
                                table_epoch: 0,
                            })),
                        };
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        // 4 items of ~200 chars = ~50 estimated tokens each against a 100-token
        // budget: pages must split at 2 items even though the row limit is 3.
        const text = "x".repeat(200);
        const items = ["a", "b", "c", "d"].map((id) => ({
            id,
            text,
            contentSha256: createHash("sha256").update(text).digest("hex"),
        }));
        const vectors = await provider.embedItems(items);
        expect(vectors.size).toBe(4);
        expect(calls.map((page) => page.length)).toEqual([2, 2]);
    });

    it("preserves the token budget when reconstructing a pinned provider", async () => {
        const mib = 1024 * 1024;
        const itemBytes = Math.ceil((9.6 * mib) / 2);
        const acceptedPageBytes: number[] = [];
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            model: "gte-modernbert-base-f16",
            fingerprint: "fp1",
            tableEpoch: 0,
            dims: 3,
            recommendedBatch: 2,
            recommendedTokenBudget: Math.ceil(itemBytes / 4) + 1,
            clientFactory: async () =>
                ({
                    async call(_m: string, method: string, params?: unknown) {
                        if (method !== "embed.batch") throw new Error(`unexpected ${method}`);
                        const items = (
                            params as {
                                items: Array<{ id: string; text: string; content_sha256: string }>;
                            }
                        ).items;
                        const bytes = items.reduce((total, item) => total + item.text.length, 0);
                        if (bytes > 5 * mib) {
                            const error = new Error("request exceeds host cap") as Error & {
                                code: string;
                            };
                            error.code = "schema_violation";
                            throw error;
                        }
                        acceptedPageBytes.push(bytes);
                        return {
                            items: items.map((item) => ({
                                id: item.id,
                                embedding: [0.5, 0.5, 0.5],
                                content_sha256: item.content_sha256,
                                fingerprint: "fp1",
                                table_epoch: 0,
                            })),
                        };
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        const text = "x".repeat(itemBytes);
        const contentSha256 = createHash("sha256").update(text).digest("hex");

        const vectors = await provider.embedItems([
            { id: "a", text, contentSha256 },
            { id: "b", text, contentSha256 },
        ]);

        expect(vectors.size).toBe(2);
        expect(acceptedPageBytes).toEqual([itemBytes, itemBytes]);
    });

    it("floors a fractional token budget rather than dropping the field", async () => {
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            clientFactory: async () =>
                ({
                    async call(_m: string, method: string) {
                        if (method !== "models.list") throw new Error(`unexpected ${method}`);
                        return {
                            result: {
                                table_epoch: 0,
                                models: [
                                    {
                                        model_id: "gte-modernbert-base-f16",
                                        fingerprints: ["fp1"],
                                        state: "ready",
                                        recommended_batch: { rows: 3.7, token_budget: 1024.5 },
                                    },
                                ],
                            },
                        };
                    },
                    close() {},
                }) as SynapseClientLike,
        });

        expect(await provider.initialize()).toBe(true);
        // Both halves of the measured policy floor, so a fractional budget
        // still bounds a page instead of leaving the lane unbounded.
        expect(provider.metadata?.recommended_batch).toBe(3);
        expect(provider.metadata?.recommended_token_budget).toBe(1024);

        // A pinned reconstruction floors the same way.
        const pinned = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            model: "gte-modernbert-base-f16",
            fingerprint: "fp1",
            tableEpoch: 0,
            dims: 3,
            recommendedBatch: 2,
            recommendedTokenBudget: 1024.5,
        });
        expect(pinned.metadata?.recommended_token_budget).toBe(1024);
    });

    it("bare-number recommended_batch still sets the row limit (legacy wire shape)", async () => {
        const calls: number[] = [];
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            clientFactory: async () =>
                ({
                    async call(_m: string, method: string, params?: unknown) {
                        if (method === "models.list") {
                            return {
                                result: {
                                    table_epoch: 0,
                                    models: [
                                        {
                                            model_id: "gte-modernbert-base-f16",
                                            fingerprints: ["fp1"],
                                            state: "ready",
                                            recommended_batch: 2,
                                        },
                                    ],
                                },
                            };
                        }
                        const items = (params as { items: { id: string; text: string }[] }).items;
                        calls.push(items.length);
                        return {
                            items: items.map((item) => ({
                                id: item.id,
                                embedding: [0.5, 0.5],
                                content_sha256: createHash("sha256")
                                    .update(item.text)
                                    .digest("hex"),
                                fingerprint: "fp1",
                                table_epoch: 0,
                            })),
                        };
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        const items = ["a", "b", "c"].map((id) => ({
            id,
            text: "hello",
            contentSha256: createHash("sha256").update("hello").digest("hex"),
        }));
        const vectors = await provider.embedItems(items);
        expect(vectors.size).toBe(3);
        expect(calls).toEqual([2, 1]);
    });

    it("single item over the token budget still ships alone", async () => {
        const calls: number[] = [];
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            clientFactory: async () =>
                ({
                    async call(_m: string, method: string, params?: unknown) {
                        if (method === "models.list") {
                            return {
                                result: {
                                    table_epoch: 0,
                                    models: [
                                        {
                                            model_id: "gte-modernbert-base-f16",
                                            fingerprints: ["fp1"],
                                            state: "ready",
                                            recommended_batch: { rows: 8, token_budget: 10 },
                                        },
                                    ],
                                },
                            };
                        }
                        const items = (params as { items: { id: string; text: string }[] }).items;
                        calls.push(items.length);
                        return {
                            items: items.map((item) => ({
                                id: item.id,
                                embedding: [0.5, 0.5],
                                content_sha256: createHash("sha256")
                                    .update(item.text)
                                    .digest("hex"),
                                fingerprint: "fp1",
                                table_epoch: 0,
                            })),
                        };
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        const big = "y".repeat(400);
        const items = [
            {
                id: "big1",
                text: big,
                contentSha256: createHash("sha256").update(big).digest("hex"),
            },
            {
                id: "big2",
                text: big,
                contentSha256: createHash("sha256").update(big).digest("hex"),
            },
        ];
        const vectors = await provider.embedItems(items);
        expect(vectors.size).toBe(2);
        expect(calls).toEqual([1, 1]);
    });
});

describe("connect discovery and retry policy", () => {
    it("maps a missing connection file to unavailable and evicts the rejected shared promise", async () => {
        const provider = new SynapseEmbeddingProvider({
            connectionFile: join(tmpdir(), `synapse-missing-${Date.now()}-${Math.random()}.json`),
            projectRoot: "/repo",
            session: "ses-1",
        });
        expect(await provider.initialize()).toBe(false);
        const state = _synapseSharedClientStateForTests();
        expect(state.hasPromise).toBe(false);
        expect(state.hasClient).toBe(false);
        expect(state.file).toBeNull();
        // Non-permanent: a later initialize is allowed to reconnect.
        expect(await provider.initialize()).toBe(false);
    });

    it("evicts a rejected factory client promise so a later valid connect initializes", async () => {
        let factoryCalls = 0;
        const good = new MockSynapseClient();
        const factory = async (): Promise<SynapseClientLike> => {
            factoryCalls += 1;
            if (factoryCalls === 1) throw new Error("connect refused");
            return good;
        };
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: factory,
        });
        expect(await provider.initialize()).toBe(false);
        expect(await provider.initialize()).toBe(true);
        expect(factoryCalls).toBe(2);
    });

    it("does not retry outcome_unknown for models.list, which has no idempotency policy", async () => {
        let calls = 0;
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () =>
                ({
                    async call() {
                        calls += 1;
                        throw new McHostCallError("outcome_unknown", "ambiguous send");
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        expect(await provider.initialize()).toBe(false);
        expect(calls).toBe(1);
    });

    it("retries outcome_unknown only under the embedding idempotency policy and bounds attempts", async () => {
        let queryCalls = 0;
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            queryTimeoutMs: 5_000,
            clientFactory: async () =>
                ({
                    async call<Response = unknown>(_m: string, method: string): Promise<Response> {
                        if (method !== "embed.query") throw new Error(`unexpected ${method}`);
                        queryCalls += 1;
                        if (queryCalls <= 2) {
                            const error = new McHostCallError(
                                "outcome_unknown",
                                "ambiguous send",
                            ) as McHostCallError & { retry_after_ms: number };
                            error.retry_after_ms = 0;
                            throw error;
                        }
                        return {
                            vector: [1, 2, 3],
                            fingerprint: "fp-live",
                            table_epoch: 0,
                        } as Response;
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        expect(await provider.embed("hello")).toEqual(new Float32Array([1, 2, 3]));
        expect(queryCalls).toBe(3);
    });

    it("caps the whole retry sequence at four application attempts", async () => {
        let queryCalls = 0;
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            queryTimeoutMs: 5_000,
            clientFactory: async () =>
                ({
                    async call() {
                        queryCalls += 1;
                        const error = new McHostCallError(
                            "outcome_unknown",
                            "ambiguous send",
                        ) as McHostCallError & { retry_after_ms: number };
                        error.retry_after_ms = 0;
                        throw error;
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        expect(await provider.embed("hello")).toBeNull();
        expect(queryCalls).toBe(4);
    });

    it("retries queue-full admission through the request deadline", async () => {
        let queryCalls = 0;
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            queryTimeoutMs: 5_000,
            clientFactory: async () =>
                ({
                    async call<Response = unknown>(): Promise<Response> {
                        queryCalls += 1;
                        if (queryCalls <= 4) {
                            const error = new Error("query admission is full") as Error & {
                                code: string;
                                retry_after_ms: number;
                            };
                            error.code = "queue_full";
                            error.retry_after_ms = 0;
                            throw error;
                        }
                        return {
                            vector: [1, 2, 3],
                            fingerprint: "fp-live",
                            table_epoch: 0,
                        } as Response;
                    },
                    close() {},
                }) as SynapseClientLike,
        });

        expect(await provider.embed("hello")).toEqual(new Float32Array([1, 2, 3]));
        expect(queryCalls).toBe(5);
    });

    it("stops retrying when the next delay would cross the absolute deadline", async () => {
        let queryCalls = 0;
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            queryTimeoutMs: 50,
            clientFactory: async () =>
                ({
                    async call() {
                        queryCalls += 1;
                        const error = new McHostCallError(
                            "outcome_unknown",
                            "ambiguous send",
                        ) as McHostCallError & { retry_after_ms: number };
                        error.retry_after_ms = 10_000;
                        throw error;
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        expect(await provider.embed("hello")).toBeNull();
        expect(queryCalls).toBe(1);
    });

    it("keeps target_unavailable non-permanent so callers stay on their configured fallback", async () => {
        let listCalls = 0;
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () =>
                ({
                    async call() {
                        listCalls += 1;
                        const error = new McHostCallError(
                            "terminal",
                            "route.open failed for module synapse: target_unavailable",
                            "target_unavailable",
                        ) as McHostCallError & { retry_after_ms: number };
                        error.retry_after_ms = 0;
                        throw error;
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        expect(await provider.initialize()).toBe(false);
        expect(await provider.embed("hello")).toBeNull();
        const callsAfterFirstRound = listCalls;
        expect(callsAfterFirstRound).toBeGreaterThan(0);
        // Not a permanent failure: the lane may recover later.
        expect(await provider.initialize()).toBe(false);
        expect(listCalls).toBeGreaterThan(callsAfterFirstRound);
    });
});

describe("embedItemsDetailed", () => {
    const MODEL = "gte-modernbert-base-f16";
    const FP = "fp-live";
    const ENVELOPE = { model: MODEL, fingerprint: FP, table_epoch: 0, dims: 3 };

    interface RecordedCall {
        method: string;
        params: Record<string, unknown>;
    }

    /** Deterministic host double: embed.batch answers with a job descriptor
     *  unless a scripted submit failure is set, and embed.result serves
     *  scripted pages per job. */
    class DetailedHost implements SynapseClientLike {
        readonly calls: RecordedCall[] = [];
        private jobCounter = 0;
        private readonly jobItems = new Map<
            string,
            Array<{ id: string; content_sha256: string }>
        >();
        batchError?: (batchCallIndex: number) => Error | null;
        resultPages?: (
            jobId: string,
            items: Array<{ id: string; content_sha256: string }>,
            resultCallIndex: number,
            cursor: unknown,
        ) => unknown;

        batchCalls(): RecordedCall[] {
            return this.calls.filter((call) => call.method === "embed.batch");
        }

        resultCalls(): RecordedCall[] {
            return this.calls.filter((call) => call.method === "embed.result");
        }

        async call<Response = unknown>(
            _module: string,
            method: string,
            params?: unknown,
        ): Promise<Response> {
            const record = { method, params: (params ?? {}) as Record<string, unknown> };
            this.calls.push(record);
            if (method === "embed.batch") {
                const scripted = this.batchError?.(this.batchCalls().length - 1);
                if (scripted) throw scripted;
                this.jobCounter += 1;
                const jobId = `job-${this.jobCounter}`;
                this.jobItems.set(
                    jobId,
                    (record.params.items as Array<{ id: string; content_sha256: string }>) ?? [],
                );
                return {
                    result: {
                        job_id: jobId,
                        request_key: record.params.request_key,
                        done: false,
                        status: "queued",
                        retry_after_ms: 0,
                    },
                } as Response;
            }
            if (method === "embed.result") {
                const jobId = record.params.job_id as string;
                const items = this.jobItems.get(jobId) ?? [];
                const index =
                    this.resultCalls().filter((call) => call.params.job_id === jobId).length - 1;
                if (this.resultPages) {
                    const scripted = this.resultPages(jobId, items, index, record.params.cursor);
                    if (scripted instanceof Error) throw scripted;
                    return scripted as Response;
                }
                return {
                    result: {
                        ...ENVELOPE,
                        done: true,
                        vectors: items.map((item) => ({
                            id: item.id,
                            content_sha256: item.content_sha256,
                            vector: [1, 2, 3],
                        })),
                    },
                } as Response;
            }
            throw new Error(`unexpected method ${method}`);
        }

        close(): void {}
    }

    function moduleRestartedError(): Error {
        const error = new Error("module restarted") as Error & { code: string };
        error.code = "module_restarted";
        return error;
    }

    /** The host's answer for a request whose own content it refuses, such as a
     *  text over the per-input byte cap. */
    function schemaViolationError(): Error {
        const error = new Error("text exceeds the host per-input cap") as Error & { code: string };
        error.code = "schema_violation";
        return error;
    }

    function ledgerDb(): Database {
        const db = createDirectTestDatabase().db;
        db.exec("PRAGMA foreign_keys=ON");
        return db;
    }

    function detailedContext(db: Database): DetailedEmbedContext {
        return {
            db,
            projectPath: "/repo",
            sessionId: "ses-1",
            scope: "memory",
            laneRole: "primary",
        };
    }

    function detailedProvider(client: SynapseClientLike): SynapseEmbeddingProvider {
        return new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            model: MODEL,
            fingerprint: FP,
            tableEpoch: 0,
            dims: 3,
            recommendedBatch: 2,
            batchTimeoutMs: 5_000,
            clientFactory: async () => client,
        });
    }

    function detailedItems(specs: Array<{ id: string; group: string }>): DetailedEmbedItem[] {
        return specs.map((spec) => ({
            id: spec.id,
            text: `text of ${spec.id}`,
            contentSha256: createHash("sha256").update(`text of ${spec.id}`).digest("hex"),
            applicationGroup: spec.group,
        }));
    }

    function ledgerRows(db: Database): Array<Record<string, unknown>> {
        return db
            .prepare(
                `SELECT id, application_group, state, state_version, attempt_id, job_id, cursor,
                        deadline_at, restart_count, failure_disposition
                   FROM synapse_batch_ledger ORDER BY id`,
            )
            .all() as Array<Record<string, unknown>>;
    }

    /** Wrap a Database so `insertCompetitor` runs the instant the exact-identity
     *  page read misses, placing a rival process's row between this attempt's
     *  read and its create so the partial unique index rejects the insert. */
    function raceLedgerCreate(db: Database, insertCompetitor: () => void): Database {
        let raced = false;
        const wrapper = {
            prepare(sql: string) {
                const statement = db.prepare(sql);
                if (raced || !/FROM synapse_batch_ledger[\s\S]*request_key = \?/.test(sql)) {
                    return statement;
                }
                return new Proxy(statement, {
                    get(target, property, receiver) {
                        if (property !== "get") {
                            const value = Reflect.get(target, property, receiver);
                            return typeof value === "function"
                                ? (value as (...a: unknown[]) => unknown).bind(target)
                                : value;
                        }
                        return (...args: unknown[]) => {
                            const row = target.get(...(args as never[]));
                            if (!raced && (row === null || row === undefined)) {
                                raced = true;
                                insertCompetitor();
                            }
                            return row;
                        };
                    },
                });
            },
            exec(sql: string) {
                return db.exec(sql);
            },
            transaction<F extends (...args: never[]) => unknown>(fn: F) {
                return db.transaction(fn);
            },
            close() {
                db.close();
            },
        };
        return wrapper as unknown as Database;
    }

    it("splits pages inside one application group and never lets a page cross groups", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const provider = detailedProvider(host);
            const items = detailedItems([
                { id: "memory:1", group: "g1" },
                { id: "memory:2", group: "g1" },
                { id: "memory:3", group: "g1" },
                { id: "memory:4", group: "g2" },
            ]);
            const result = await provider.embedItemsDetailed(items, detailedContext(db));

            expect(result.failures).toEqual([]);
            expect(result.receipts).toHaveLength(3);
            const pageIds = host
                .batchCalls()
                .map((call) => (call.params.items as Array<{ id: string }>).map((item) => item.id));
            expect(pageIds).toEqual([["memory:1", "memory:2"], ["memory:3"], ["memory:4"]]);
            const rows = ledgerRows(db);
            expect(rows).toHaveLength(3);
            expect(rows.map((row) => row.application_group)).toEqual(["g1", "g1", "g2"]);
            expect(rows.every((row) => row.state === "ready")).toBe(true);
            expect(new Set(result.receipts.map((receipt) => receipt.rowId)).size).toBe(3);
            for (const receipt of result.receipts) {
                expect(receipt.vectors.size).toBe(receipt.items.length);
            }
        } finally {
            closeQuietly(db);
        }
    });

    it("persists polling state at admission, records cursors as diagnostics, and stops at ready", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            let stateAtFirstPoll: Record<string, unknown> | null = null;
            host.resultPages = (_jobId, items, index) => {
                if (index === 0) {
                    stateAtFirstPoll = ledgerRows(db)[0];
                    return {
                        result: {
                            ...ENVELOPE,
                            done: false,
                            next_cursor: "cursor-1",
                            vectors: [
                                {
                                    id: items[0].id,
                                    content_sha256: items[0].content_sha256,
                                    vector: [1, 2, 3],
                                },
                            ],
                        },
                    };
                }
                return {
                    result: {
                        ...ENVELOPE,
                        done: true,
                        vectors: [
                            {
                                id: items[1].id,
                                content_sha256: items[1].content_sha256,
                                vector: [4, 5, 6],
                            },
                        ],
                    },
                };
            };
            const provider = detailedProvider(host);
            const items = detailedItems([
                { id: "memory:1", group: "g1" },
                { id: "memory:2", group: "g1" },
            ]);
            const result = await provider.embedItemsDetailed(items, detailedContext(db));

            expect(result.failures).toEqual([]);
            expect(result.receipts).toHaveLength(1);
            // Widened read: TS narrows the closure-assigned variable to its
            // initializer type at this point.
            const firstPoll = stateAtFirstPoll as Record<string, unknown> | null;
            expect(firstPoll?.state).toBe("polling");
            expect(firstPoll?.job_id).toBe("job-1");
            expect(typeof firstPoll?.attempt_id).toBe("string");
            expect(firstPoll?.deadline_at as number).toBeGreaterThan(Date.now());

            const row = ledgerRows(db)[0];
            expect(row.state).toBe("ready");
            expect(row.cursor).toBe("cursor-1");
            expect(row.state_version).toBe(result.receipts[0].stateVersion);
            expect(result.receipts[0].vectors.get("memory:2")).toEqual(new Float32Array([4, 5, 6]));
        } finally {
            closeQuietly(db);
        }
    });

    it("treats done:false without a cursor as explicit pending and keeps polling", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            host.resultPages = (_jobId, items, index) => {
                if (index < 2) {
                    return { result: { done: false, status: "running", retry_after_ms: 0 } };
                }
                return {
                    result: {
                        ...ENVELOPE,
                        done: true,
                        vectors: items.map((item) => ({
                            id: item.id,
                            content_sha256: item.content_sha256,
                            vector: [1, 2, 3],
                        })),
                    },
                };
            };
            const provider = detailedProvider(host);
            const result = await provider.embedItemsDetailed(
                detailedItems([{ id: "memory:1", group: "g1" }]),
                detailedContext(db),
            );
            expect(result.receipts).toHaveLength(1);
            expect(host.resultCalls()).toHaveLength(3);
            expect(ledgerRows(db)[0].state).toBe("ready");
        } finally {
            closeQuietly(db);
        }
    });

    it("recovers an adopted polling row by ignoring the saved cursor and polling the retained job from null", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const provider = detailedProvider(host);
            const items = detailedItems([
                { id: "memory:1", group: "g1" },
                { id: "memory:2", group: "g1" },
            ]);
            const requestKey = getSynapseBatchRequestKey({
                model: MODEL,
                fingerprint: FP,
                tableEpoch: 0,
                items,
            });
            const created = createSynapseLedgerPage(db, {
                projectPath: "/repo",
                sessionId: "ses-1",
                scope: "memory",
                laneRole: "primary",
                destinationModel: getSynapseLaneIdentity(MODEL, FP),
                applicationGroup: "g1",
                requestKey,
                manifest: items.map(({ id, contentSha256 }) => ({ id, contentSha256 })),
                deadlineAt: Date.now() + 60_000,
            });
            let seeded = markSynapseLedgerPolling(db, {
                rowId: created.rowId,
                expectedStateVersion: created.stateVersion,
                attemptId: "attempt-crashed",
                jobId: "job-retained",
            });
            seeded = recordSynapseLedgerCursor(db, {
                rowId: seeded.rowId,
                expectedStateVersion: seeded.stateVersion,
                jobId: "job-retained",
                cursor: "stale-cursor",
            });
            const observedCursors: unknown[] = [];
            host.resultPages = (jobId, _items, _index, cursor) => {
                observedCursors.push(cursor);
                expect(jobId).toBe("job-retained");
                return {
                    result: {
                        ...ENVELOPE,
                        done: true,
                        vectors: items.map((item) => ({
                            id: item.id,
                            content_sha256: item.contentSha256,
                            vector: [1, 2, 3],
                        })),
                    },
                };
            };
            (host as unknown as { jobItems: Map<string, unknown> }).jobItems.set(
                "job-retained",
                items.map((item) => ({ id: item.id, content_sha256: item.contentSha256 })),
            );

            const result = await provider.embedItemsDetailed(items, detailedContext(db));
            expect(result.failures).toEqual([]);
            expect(result.receipts).toHaveLength(1);
            expect(result.receipts[0].rowId).toBe(seeded.rowId);
            expect(host.batchCalls()).toHaveLength(0);
            expect(observedCursors[0]).toBeNull();
            expect(getSynapseLedgerPage(db, seeded.rowId)?.state).toBe("ready");
        } finally {
            closeQuietly(db);
        }
    });

    it("rebuilds a ready row whose page deadline already expired instead of wedging on it", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const provider = detailedProvider(host);
            const items = detailedItems([
                { id: "memory:1", group: "g1" },
                { id: "memory:2", group: "g1" },
            ]);
            const requestKey = getSynapseBatchRequestKey({
                model: MODEL,
                fingerprint: FP,
                tableEpoch: 0,
                items,
            });
            const created = createSynapseLedgerPage(db, {
                projectPath: "/repo",
                sessionId: "ses-1",
                scope: "memory",
                laneRole: "primary",
                destinationModel: getSynapseLaneIdentity(MODEL, FP),
                applicationGroup: "g1",
                requestKey,
                manifest: items.map(({ id, contentSha256 }) => ({ id, contentSha256 })),
                deadlineAt: Date.now() - 1,
            });
            let seeded = markSynapseLedgerPolling(db, {
                rowId: created.rowId,
                expectedStateVersion: created.stateVersion,
                attemptId: "attempt-crashed",
                jobId: "job-retained",
            });
            seeded = markSynapseLedgerReady(db, {
                rowId: seeded.rowId,
                expectedStateVersion: seeded.stateVersion,
                jobId: "job-retained",
            });

            const result = await provider.embedItemsDetailed(items, detailedContext(db));

            // The expired retained job is never polled (its deadline makes the
            // re-derive impossible); the row is obsoleted and a fresh page runs.
            expect(result.failures).toEqual([]);
            expect(result.receipts).toHaveLength(1);
            expect(result.receipts[0].rowId).not.toBe(seeded.rowId);
            expect(
                host.resultCalls().filter((call) => call.params.job_id === "job-retained"),
            ).toHaveLength(0);
            expect(host.batchCalls()).toHaveLength(1);
            expect(getSynapseLedgerPage(db, seeded.rowId)?.state).toBe("obsolete");
        } finally {
            closeQuietly(db);
        }
    });

    it("reports a retained ready-job failure and lets the next call retry", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const provider = detailedProvider(host);
            const items = detailedItems([{ id: "memory:1", group: "g1" }]);
            const requestKey = getSynapseBatchRequestKey({
                model: MODEL,
                fingerprint: FP,
                tableEpoch: 0,
                items,
            });
            const created = createSynapseLedgerPage(db, {
                projectPath: "/repo",
                sessionId: "ses-1",
                scope: "memory",
                laneRole: "primary",
                destinationModel: getSynapseLaneIdentity(MODEL, FP),
                applicationGroup: "g1",
                requestKey,
                manifest: items.map(({ id, contentSha256 }) => ({ id, contentSha256 })),
                deadlineAt: Date.now() + 60_000,
            });
            let seeded = markSynapseLedgerPolling(db, {
                rowId: created.rowId,
                expectedStateVersion: created.stateVersion,
                attemptId: "attempt-crashed",
                jobId: "job-retained",
            });
            seeded = markSynapseLedgerReady(db, {
                rowId: seeded.rowId,
                expectedStateVersion: seeded.stateVersion,
                jobId: "job-retained",
            });
            host.resultPages = (jobId, jobItems) => {
                if (jobId === "job-retained") {
                    const error = new Error("retained job unavailable") as Error & {
                        code: string;
                        retry_after_ms: number;
                    };
                    error.code = "queue_full";
                    error.retry_after_ms = 0;
                    return error;
                }
                return {
                    result: {
                        ...ENVELOPE,
                        done: true,
                        vectors: jobItems.map((item) => ({
                            id: item.id,
                            content_sha256: item.content_sha256,
                            vector: [1, 2, 3],
                        })),
                    },
                };
            };

            const failed = await provider.embedItemsDetailed(items, detailedContext(db));
            expect(failed.receipts).toEqual([]);
            expect(failed.failures).toHaveLength(1);
            expect(failed.failures[0].disposition).toBe("retryable");
            // The retained job's reply is the only thing that failed, so the
            // ready row retires and no row records a disposition for a page
            // that was never submitted.
            expect(ledgerRows(db).map((row) => row.state)).toEqual(["obsolete"]);

            const retried = await provider.embedItemsDetailed(items, detailedContext(db));
            expect(retried.failures).toEqual([]);
            expect(retried.receipts).toHaveLength(1);
            expect(ledgerRows(db).map((row) => row.state)).toEqual(["obsolete", "ready"]);
            expect(retried.receipts[0].rowId).toBe(ledgerRows(db)[1].id);
            expect(host.batchCalls()).toHaveLength(1);
        } finally {
            closeQuietly(db);
        }
    });

    it("retires a ready row whose retained job fails without failing a page it never submitted", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const provider = detailedProvider(host);
            const items = detailedItems([{ id: "memory:1", group: "g1" }]);
            const created = createSynapseLedgerPage(db, {
                projectPath: "/repo",
                sessionId: "ses-1",
                scope: "memory",
                laneRole: "primary",
                destinationModel: getSynapseLaneIdentity(MODEL, FP),
                applicationGroup: "g1",
                requestKey: getSynapseBatchRequestKey({
                    model: MODEL,
                    fingerprint: FP,
                    tableEpoch: 0,
                    items,
                }),
                manifest: items.map(({ id, contentSha256 }) => ({ id, contentSha256 })),
                deadlineAt: Date.now() + 60_000,
            });
            let seeded = markSynapseLedgerPolling(db, {
                rowId: created.rowId,
                expectedStateVersion: created.stateVersion,
                attemptId: "attempt-crashed",
                jobId: "job-retained",
            });
            seeded = markSynapseLedgerReady(db, {
                rowId: seeded.rowId,
                expectedStateVersion: seeded.stateVersion,
                jobId: "job-retained",
            });
            // The retained job answers with a hash that does not match the
            // page's content: permanent evidence about that reply, and the page
            // itself has not been submitted since its vectors were lost.
            host.resultPages = (jobId, jobItems) => ({
                result: {
                    ...ENVELOPE,
                    done: true,
                    vectors:
                        jobId === "job-retained"
                            ? [
                                  {
                                      id: items[0].id,
                                      content_sha256: "0".repeat(64),
                                      vector: [1, 2, 3],
                                  },
                              ]
                            : jobItems.map((item) => ({
                                  id: item.id,
                                  content_sha256: item.content_sha256,
                                  vector: [1, 2, 3],
                              })),
                },
            });

            const failed = await provider.embedItemsDetailed(items, detailedContext(db));
            expect(failed.receipts).toEqual([]);
            expect(failed.failures.map((failure) => failure.code)).toEqual(["artifact_invalid"]);
            // Only the ready row is retired. No second row records a
            // disposition for a page that never reached the daemon.
            expect(ledgerRows(db).map((row) => row.state)).toEqual(["obsolete"]);
            expect(host.batchCalls()).toEqual([]);

            // The next run opens a fresh page for the same identity and
            // submits it, so the content is embedded rather than foreclosed.
            const next = detailedProvider(host);
            const retried = await next.embedItemsDetailed(items, detailedContext(db));
            expect(retried.failures).toEqual([]);
            expect(retried.receipts).toHaveLength(1);
            expect(retried.receipts[0].vectors.size).toBe(1);
            expect(host.batchCalls()).toHaveLength(1);
            expect(ledgerRows(db).map((row) => row.state)).toEqual(["obsolete", "ready"]);
        } finally {
            closeQuietly(db);
        }
    });

    it("bypasses generic retry on module_restarted and resubmits the same page key exactly once", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            host.resultPages = (jobId, items) => {
                if (jobId === "job-1") return moduleRestartedError();
                return {
                    result: {
                        ...ENVELOPE,
                        done: true,
                        vectors: items.map((item) => ({
                            id: item.id,
                            content_sha256: item.content_sha256,
                            vector: [1, 2, 3],
                        })),
                    },
                };
            };
            const provider = detailedProvider(host);
            const result = await provider.embedItemsDetailed(
                detailedItems([{ id: "memory:1", group: "g1" }]),
                detailedContext(db),
            );

            expect(result.failures).toEqual([]);
            expect(result.receipts).toHaveLength(1);
            const batches = host.batchCalls();
            expect(batches).toHaveLength(2);
            expect(batches[0].params.request_key).toBe(batches[1].params.request_key);
            expect(
                host.resultCalls().filter((call) => call.params.job_id === "job-1"),
            ).toHaveLength(1);
            const row = ledgerRows(db)[0];
            expect(row.state).toBe("ready");
            expect(row.restart_count).toBe(1);
            expect(row.job_id).toBe("job-2");
        } finally {
            closeQuietly(db);
        }
    });

    it("fails the page when the single restart budget is spent instead of resubmitting again", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            host.resultPages = () => moduleRestartedError();
            const provider = detailedProvider(host);
            const result = await provider.embedItemsDetailed(
                detailedItems([{ id: "memory:1", group: "g1" }]),
                detailedContext(db),
            );

            expect(result.receipts).toEqual([]);
            expect(result.failures).toHaveLength(1);
            expect(result.failures[0].code).toBe("page_terminal");
            expect(result.failures[0].disposition).toBe("permanent");
            expect(host.batchCalls()).toHaveLength(2);
            const row = ledgerRows(db)[0];
            expect(row.state).toBe("failed");
            // A retryable row inside a live deadline is handed back to
            // `pending` with its restart_count intact, so only a permanent
            // disposition stops the page from resubmitting on every pass.
            expect(row.failure_disposition).toBe("permanent");
            expect(row.restart_count).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    it("keeps a ready-path module_restarted terminal once the page's restart budget is spent", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const provider = detailedProvider(host);
            const items = detailedItems([
                { id: "memory:1", group: "g1" },
                { id: "memory:2", group: "g2" },
            ]);
            const spentPage = [items[0]];
            const created = createSynapseLedgerPage(db, {
                projectPath: "/repo",
                sessionId: "ses-1",
                scope: "memory",
                laneRole: "primary",
                destinationModel: getSynapseLaneIdentity(MODEL, FP),
                applicationGroup: "g1",
                requestKey: getSynapseBatchRequestKey({
                    model: MODEL,
                    fingerprint: FP,
                    tableEpoch: 0,
                    items: spentPage,
                }),
                manifest: spentPage.map(({ id, contentSha256 }) => ({ id, contentSha256 })),
                deadlineAt: Date.now() + 60_000,
            });
            // The page's history: it spent its single durable restart, reached
            // ready under the replacement job, then lost its vectors with the
            // process. A second restart leaves it no budget to resubmit under.
            let seeded = markSynapseLedgerPolling(db, {
                rowId: created.rowId,
                expectedStateVersion: created.stateVersion,
                attemptId: "attempt-1",
                jobId: "job-first",
            });
            seeded = recordSynapseLedgerRestart(db, {
                rowId: seeded.rowId,
                expectedStateVersion: seeded.stateVersion,
                jobId: "job-first",
            });
            seeded = recordSynapseLedgerJob(db, {
                rowId: seeded.rowId,
                expectedStateVersion: seeded.stateVersion,
                attemptId: "attempt-2",
                jobId: "job-retained",
            });
            seeded = markSynapseLedgerReady(db, {
                rowId: seeded.rowId,
                expectedStateVersion: seeded.stateVersion,
                jobId: "job-retained",
            });
            host.resultPages = (jobId, jobItems) => {
                if (jobId === "job-retained") return moduleRestartedError();
                return {
                    result: {
                        ...ENVELOPE,
                        done: true,
                        vectors: jobItems.map((item) => ({
                            id: item.id,
                            content_sha256: item.content_sha256,
                            vector: [1, 2, 3],
                        })),
                    },
                };
            };

            const result = await provider.embedItemsDetailed(items, detailedContext(db));

            expect(result.failures).toHaveLength(1);
            expect(result.failures[0].applicationGroup).toBe("g1");
            expect(result.failures[0].code).toBe("page_terminal");
            expect(result.failures[0].disposition).toBe("permanent");
            expect(result.failures[0].rowId).toBe(seeded.rowId);
            // The exhausted page is never rebuilt and never resubmitted.
            expect(
                host
                    .batchCalls()
                    .filter((call) =>
                        (call.params.items as Array<{ id: string }>).some(
                            (item) => item.id === "memory:1",
                        ),
                    ),
            ).toEqual([]);
            // The lane stays live: a disabled lane reports `artifact_invalid`
            // for every later page instead of embedding it.
            expect(result.receipts).toHaveLength(1);
            expect(result.receipts[0].applicationGroup).toBe("g2");
            expect(result.receipts[0].vectors.size).toBe(1);
            const rows = ledgerRows(db);
            expect(rows).toHaveLength(2);
            expect(rows[0].id).toBe(seeded.rowId);
            expect(rows[0].state).toBe("ready");
            expect(rows[0].restart_count).toBe(1);
            expect(rows[1].application_group).toBe("g2");
            expect(rows[1].state).toBe("ready");
        } finally {
            closeQuietly(db);
        }
    });

    it("keeps a module_restarted retryable while the page still has restart budget", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            // The submit itself restarts, so the durable restart CAS never
            // runs and the page's single restart stays unspent.
            host.batchError = () => moduleRestartedError();
            const provider = detailedProvider(host);
            const result = await provider.embedItemsDetailed(
                detailedItems([{ id: "memory:1", group: "g1" }]),
                detailedContext(db),
            );

            expect(result.receipts).toEqual([]);
            expect(result.failures).toHaveLength(1);
            expect(result.failures[0].code).toBe("module_restarted");
            expect(result.failures[0].disposition).toBe("retryable");
            expect(host.batchCalls()).toHaveLength(1);
            const row = ledgerRows(db)[0];
            expect(row.state).toBe("failed");
            expect(row.failure_disposition).toBe("retryable");
            expect(row.restart_count).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    it("scopes an exhausted restart budget to its page and leaves sibling pages runnable", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            // Only the first group's job keeps restarting, so that page burns
            // its single durable restart and goes terminal while the second
            // group's page reaches the daemon with its own budget intact.
            host.resultPages = (_jobId, items) => {
                if (items.some((item) => item.id === "memory:1")) return moduleRestartedError();
                return {
                    result: {
                        ...ENVELOPE,
                        done: true,
                        vectors: items.map((item) => ({
                            id: item.id,
                            content_sha256: item.content_sha256,
                            vector: [1, 2, 3],
                        })),
                    },
                };
            };
            const provider = detailedProvider(host);
            const result = await provider.embedItemsDetailed(
                detailedItems([
                    { id: "memory:1", group: "g1" },
                    { id: "memory:2", group: "g2" },
                ]),
                detailedContext(db),
            );

            expect(result.failures).toHaveLength(1);
            expect(result.failures[0].applicationGroup).toBe("g1");
            expect(result.failures[0].code).toBe("page_terminal");
            expect(result.failures[0].disposition).toBe("permanent");
            // The lane is still live: a disabled lane reports `artifact_invalid`
            // for every later page instead of embedding it.
            expect(result.receipts).toHaveLength(1);
            expect(result.receipts[0].applicationGroup).toBe("g2");
            expect(result.receipts[0].vectors.size).toBe(1);
            const rows = ledgerRows(db);
            expect(rows.map((row) => row.application_group)).toEqual(["g1", "g2"]);
            expect(rows[0].state).toBe("failed");
            expect(rows[0].failure_disposition).toBe("permanent");
            expect(rows[0].restart_count).toBe(1);
            expect(rows[1].state).toBe("ready");
        } finally {
            closeQuietly(db);
        }
    });

    it("scopes a request-local schema violation to its page and leaves the lane live", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            // Only the first group's page carries content the host refuses, so
            // the second group's page must still reach the daemon.
            host.batchError = (index) => (index === 0 ? schemaViolationError() : null);
            const provider = detailedProvider(host);
            const result = await provider.embedItemsDetailed(
                detailedItems([
                    { id: "memory:1", group: "g1" },
                    { id: "memory:2", group: "g2" },
                ]),
                detailedContext(db),
            );

            expect(result.failures).toHaveLength(1);
            expect(result.failures[0].applicationGroup).toBe("g1");
            expect(result.failures[0].code).toBe("schema_violation");
            expect(result.failures[0].disposition).toBe("permanent");
            // A condemned lane answers `artifact_invalid` for every later page
            // without submitting it, so a served receipt proves the lane lives.
            expect(result.receipts).toHaveLength(1);
            expect(result.receipts[0].applicationGroup).toBe("g2");
            expect(result.receipts[0].vectors.size).toBe(1);
            expect(host.batchCalls()).toHaveLength(2);
            // The lane also stays usable for this project's other scopes.
            expect(provider.isLoaded()).toBe(true);
            expect(await provider.initialize()).toBe(true);
            const rows = ledgerRows(db);
            expect(rows.map((row) => row.application_group)).toEqual(["g1", "g2"]);
            expect(rows[0].state).toBe("failed");
            expect(rows[0].failure_disposition).toBe("permanent");
            expect(rows[1].state).toBe("ready");
        } finally {
            closeQuietly(db);
        }
    });

    it("keeps a permanently failed page terminal instead of rebuilding and resubmitting it", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const provider = detailedProvider(host);
            const items = detailedItems([{ id: "memory:1", group: "g1" }]);
            const created = createSynapseLedgerPage(db, {
                projectPath: "/repo",
                sessionId: "ses-1",
                scope: "memory",
                laneRole: "primary",
                destinationModel: getSynapseLaneIdentity(MODEL, FP),
                applicationGroup: "g1",
                requestKey: getSynapseBatchRequestKey({
                    model: MODEL,
                    fingerprint: FP,
                    tableEpoch: 0,
                    items,
                }),
                manifest: items.map(({ id, contentSha256 }) => ({ id, contentSha256 })),
                deadlineAt: Date.now() + 60_000,
            });
            const failed = markSynapseLedgerOutcome(db, {
                rowId: created.rowId,
                expectedStateVersion: created.stateVersion,
                disposition: "permanent",
            });

            const result = await provider.embedItemsDetailed(items, detailedContext(db));

            // The recorded permanent disposition is the page's answer: no new
            // ledger row, no new daemon job, and the failure stays permanent.
            expect(result.receipts).toEqual([]);
            expect(result.failures).toHaveLength(1);
            expect(result.failures[0].disposition).toBe("permanent");
            expect(result.failures[0].rowId).toBe(failed.rowId);
            expect(host.batchCalls()).toEqual([]);
            const rows = ledgerRows(db);
            expect(rows).toHaveLength(1);
            expect(rows[0].id).toBe(failed.rowId);
            expect(rows[0].state).toBe("failed");
            expect(rows[0].failure_disposition).toBe("permanent");
        } finally {
            closeQuietly(db);
        }
    });

    it("attaches to the winning row when a concurrent insert takes the page identity", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const provider = detailedProvider(host);
            const items = detailedItems([{ id: "memory:1", group: "g1" }]);
            let competitorRowId = 0;
            const racing = raceLedgerCreate(db, () => {
                competitorRowId = createSynapseLedgerPage(db, {
                    projectPath: "/repo",
                    sessionId: "ses-1",
                    scope: "memory",
                    laneRole: "primary",
                    destinationModel: getSynapseLaneIdentity(MODEL, FP),
                    applicationGroup: "g1",
                    requestKey: getSynapseBatchRequestKey({
                        model: MODEL,
                        fingerprint: FP,
                        tableEpoch: 0,
                        items,
                    }),
                    manifest: items.map(({ id, contentSha256 }) => ({ id, contentSha256 })),
                    deadlineAt: Date.now() + 60_000,
                }).rowId;
            });

            const result = await provider.embedItemsDetailed(items, detailedContext(racing));

            // The loser of the create race drives the winner's row instead of
            // reporting a transport failure for a page that already exists.
            expect(competitorRowId).toBeGreaterThan(0);
            expect(result.failures).toEqual([]);
            expect(result.receipts).toHaveLength(1);
            expect(result.receipts[0].rowId).toBe(competitorRowId);
            const rows = ledgerRows(db);
            expect(rows).toHaveLength(1);
            expect(rows[0].id).toBe(competitorRowId);
            expect(rows[0].state).toBe("ready");
        } finally {
            closeQuietly(db);
        }
    });

    it("returns the collected vectors by attaching to the winner when the ready CAS loses", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const provider = detailedProvider(host);
            const items = detailedItems([{ id: "memory:1", group: "g1" }]);
            let winner: Record<string, unknown> | null = null;
            host.resultPages = (jobId, jobItems, index) => {
                if (index === 0) {
                    // A sibling process validated the same job and advanced the
                    // row to ready first, leaving this attempt's version stale.
                    const live = ledgerRows(db)[0];
                    markSynapseLedgerReady(db, {
                        rowId: live.id as number,
                        expectedStateVersion: live.state_version as number,
                        jobId,
                    });
                    winner = ledgerRows(db)[0];
                }
                return {
                    result: {
                        ...ENVELOPE,
                        done: true,
                        vectors: jobItems.map((item) => ({
                            id: item.id,
                            content_sha256: item.content_sha256,
                            vector: [1, 2, 3],
                        })),
                    },
                };
            };

            const result = await provider.embedItemsDetailed(items, detailedContext(db));

            // Widened read: TS narrows the closure-assigned variable to its
            // initializer type at this point.
            const winnerRow = winner as Record<string, unknown> | null;
            expect(winnerRow?.state).toBe("ready");
            expect(result.failures).toEqual([]);
            expect(result.receipts).toHaveLength(1);
            expect(result.receipts[0].rowId).toBe(winnerRow?.id);
            expect(result.receipts[0].stateVersion).toBe(winnerRow?.state_version);
            expect(result.receipts[0].vectors.get("memory:1")).toEqual(new Float32Array([1, 2, 3]));
            expect(host.batchCalls()).toHaveLength(1);
            const rows = ledgerRows(db);
            expect(rows).toHaveLength(1);
            expect(rows[0].state).toBe("ready");
        } finally {
            closeQuietly(db);
        }
    });

    it("refuses to attach to a winner running a different job", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const provider = detailedProvider(host);
            const items = detailedItems([{ id: "memory:1", group: "g1" }]);
            const identity = {
                projectPath: "/repo",
                sessionId: "ses-1",
                scope: "memory" as const,
                laneRole: "primary" as const,
                destinationModel: getSynapseLaneIdentity(MODEL, FP),
                applicationGroup: "g1",
                requestKey: getSynapseBatchRequestKey({
                    model: MODEL,
                    fingerprint: FP,
                    tableEpoch: 0,
                    items,
                }),
            };
            let rivalRowId = 0;
            host.resultPages = (_jobId, jobItems, index) => {
                if (index === 0) {
                    // The live row for this identity is replaced by one running
                    // a different job, so the vectors in hand prove nothing
                    // about the row that now owns the page.
                    const live = ledgerRows(db)[0];
                    markSynapseLedgerObsolete(db, {
                        rowId: live.id as number,
                        expectedStateVersion: live.state_version as number,
                    });
                    const rival = createSynapseLedgerPage(db, {
                        ...identity,
                        manifest: items.map(({ id, contentSha256 }) => ({ id, contentSha256 })),
                        deadlineAt: Date.now() + 60_000,
                    });
                    const polling = markSynapseLedgerPolling(db, {
                        rowId: rival.rowId,
                        expectedStateVersion: rival.stateVersion,
                        attemptId: "attempt-rival",
                        jobId: "job-other",
                    });
                    rivalRowId = markSynapseLedgerReady(db, {
                        rowId: polling.rowId,
                        expectedStateVersion: polling.stateVersion,
                        jobId: "job-other",
                    }).rowId;
                }
                return {
                    result: {
                        ...ENVELOPE,
                        done: true,
                        vectors: jobItems.map((item) => ({
                            id: item.id,
                            content_sha256: item.content_sha256,
                            vector: [1, 2, 3],
                        })),
                    },
                };
            };

            const result = await provider.embedItemsDetailed(items, detailedContext(db));

            expect(rivalRowId).toBeGreaterThan(0);
            expect(result.receipts).toEqual([]);
            expect(result.failures).toHaveLength(1);
            expect(result.failures[0].code).toBe("transport");
            expect(result.failures[0].disposition).toBe("retryable");
            // The rival's row keeps its own version: no receipt claims it.
            const rival = getSynapseLedgerPage(db, rivalRowId);
            expect(rival?.state).toBe("ready");
            expect(rival?.jobId).toBe("job-other");
        } finally {
            closeQuietly(db);
        }
    });

    it("rejects every malformed result page shape without ever reaching ready", async () => {
        const good = (items: Array<{ id: string; content_sha256: string }>) =>
            items.map((item) => ({
                id: item.id,
                content_sha256: item.content_sha256,
                vector: [1, 2, 3],
            }));
        const cases: Array<{
            name: string;
            page: (items: Array<{ id: string; content_sha256: string }>) => Record<string, unknown>;
        }> = [
            {
                name: "duplicate id",
                page: (items) => ({
                    ...ENVELOPE,
                    done: true,
                    vectors: [...good(items), good(items)[0]],
                }),
            },
            {
                name: "missing id",
                page: (items) => ({ ...ENVELOPE, done: true, vectors: good(items).slice(0, 1) }),
            },
            {
                name: "extra id",
                page: (items) => ({
                    ...ENVELOPE,
                    done: true,
                    vectors: [
                        ...good(items),
                        { id: "memory:evil", content_sha256: "x", vector: [1, 2, 3] },
                    ],
                }),
            },
            {
                name: "malformed vector",
                page: (items) => ({
                    ...ENVELOPE,
                    done: true,
                    vectors: [{ ...good(items)[0], vector: "nope" }, ...good(items).slice(1)],
                }),
            },
            {
                name: "non-finite vector",
                page: (items) => ({
                    ...ENVELOPE,
                    done: true,
                    vectors: [
                        { ...good(items)[0], vector: [1, Number.NaN, 3] },
                        ...good(items).slice(1),
                    ],
                }),
            },
            {
                name: "wrong content hash",
                page: (items) => ({
                    ...ENVELOPE,
                    done: true,
                    vectors: [
                        { ...good(items)[0], content_sha256: "0".repeat(64) },
                        ...good(items).slice(1),
                    ],
                }),
            },
            {
                name: "wrong dimensions",
                page: (items) => ({
                    ...ENVELOPE,
                    done: true,
                    vectors: [{ ...good(items)[0], vector: [1, 2] }, ...good(items).slice(1)],
                }),
            },
            {
                name: "wrong fingerprint",
                page: (items) => ({
                    ...ENVELOPE,
                    fingerprint: "fp-evil",
                    done: true,
                    vectors: good(items),
                }),
            },
            {
                name: "wrong epoch",
                page: (items) => ({
                    ...ENVELOPE,
                    table_epoch: 9,
                    done: true,
                    vectors: good(items),
                }),
            },
            {
                name: "wrong model",
                page: (items) => ({
                    ...ENVELOPE,
                    model: "other-model",
                    done: true,
                    vectors: good(items),
                }),
            },
        ];
        for (const testCase of cases) {
            const db = ledgerDb();
            try {
                const host = new DetailedHost();
                host.resultPages = (_jobId, items) => ({ result: testCase.page(items) });
                const provider = detailedProvider(host);
                const result = await provider.embedItemsDetailed(
                    detailedItems([
                        { id: "memory:1", group: "g1" },
                        { id: "memory:2", group: "g1" },
                    ]),
                    detailedContext(db),
                );
                expect(result.receipts).toEqual([]);
                expect(result.failures).toHaveLength(1);
                expect(result.failures[0].disposition).toBe("permanent");
                const row = ledgerRows(db)[0];
                expect(row.state).toBe("failed");
                expect(row.failure_disposition).toBe("permanent");
            } finally {
                closeQuietly(db);
            }
        }
    });

    it("returns no vector under the synapse identity when the lane is unavailable and writes no ledger rows", async () => {
        const db = ledgerDb();
        try {
            const provider = new SynapseEmbeddingProvider({
                connectionFile: "fixture",
                projectRoot: "/repo",
                session: "ses-1",
                clientFactory: async () => {
                    throw new Error("connect refused");
                },
            });
            const result = await provider.embedItemsDetailed(
                detailedItems([
                    { id: "memory:1", group: "g1" },
                    { id: "memory:2", group: "g2" },
                ]),
                detailedContext(db),
            );
            expect(result.receipts).toEqual([]);
            expect(result.failures).toHaveLength(2);
            expect(result.failures.every((failure) => failure.rowId === null)).toBe(true);
            expect(result.failures.every((failure) => failure.disposition === "retryable")).toBe(
                true,
            );
            expect(ledgerRows(db)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    it("keeps the legacy embedItems path off the ledger entirely", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const provider = detailedProvider(host);
            const vectors = await provider.embedItems([
                { id: "memory:1", text: "one", contentSha256: "a" },
            ]);
            expect(vectors.size).toBe(1);
            expect(ledgerRows(db)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    it("keeps polling the canonical pending reply on the legacy embedItems path", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            host.resultPages = (_jobId, items, index) => {
                if (index === 0) {
                    return { result: { done: false, status: "queued", retry_after_ms: 0 } };
                }
                return {
                    result: {
                        ...ENVELOPE,
                        done: true,
                        vectors: items.map((item) => ({
                            id: item.id,
                            content_sha256: item.content_sha256,
                            vector: [1, 2, 3],
                        })),
                    },
                };
            };
            const provider = detailedProvider(host);
            const vectors = await provider.embedItems([
                { id: "memory:1", text: "one", contentSha256: "a" },
            ]);
            expect(vectors.get("memory:1")).toEqual(new Float32Array([1, 2, 3]));
            expect(host.resultCalls()).toHaveLength(2);
            expect(ledgerRows(db)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    it("keeps the cursor while a later legacy result page is pending", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const cursors: unknown[] = [];
            host.resultPages = (_jobId, items, index, cursor) => {
                cursors.push(cursor);
                if (index === 0) {
                    return {
                        result: {
                            ...ENVELOPE,
                            complete: false,
                            next_cursor: "cursor-1",
                            vectors: [
                                {
                                    id: items[0].id,
                                    content_sha256: items[0].content_sha256,
                                    vector: [1, 2, 3],
                                },
                            ],
                        },
                    };
                }
                if (index === 1) {
                    return { result: { complete: false, status: "running", retry_after_ms: 0 } };
                }
                return {
                    result: {
                        ...ENVELOPE,
                        complete: true,
                        vectors: [
                            {
                                id: items[1].id,
                                content_sha256: items[1].content_sha256,
                                vector: [4, 5, 6],
                            },
                        ],
                    },
                };
            };
            const provider = detailedProvider(host);

            const vectors = await provider.embedItems([
                { id: "memory:1", text: "one", contentSha256: "a" },
                { id: "memory:2", text: "two", contentSha256: "b" },
            ]);

            expect([...vectors.keys()]).toEqual(["memory:1", "memory:2"]);
            expect(vectors.get("memory:2")).toEqual(new Float32Array([4, 5, 6]));
            expect(cursors).toEqual([null, "cursor-1", "cursor-1"]);
            expect(ledgerRows(db)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("canonical request-key golden vectors", () => {
    // These exact keys are committed in docs/mc-host-wire-protocol.md §7.5.7
    // and asserted by the Rust unit tests in
    // crates/mc-host/src/synapse/protocol.rs; both languages must produce
    // identical bytes or batch idempotency breaks cross-language.
    const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");
    const keyFor = (epoch: number, items: { id: string; text: string }[]) =>
        getSynapseBatchRequestKey({
            model: "tiny-test-model",
            fingerprint: "fp-1",
            tableEpoch: epoch,
            items: items.map((item) => ({ id: item.id, contentSha256: sha256Hex(item.text) })),
        });

    it("matches the committed golden vectors", () => {
        expect(keyFor(1, [])).toBe(
            "581e663acbdeee7021b440822f8f054afa1089ca89f3be3585bf0e8032502186",
        );
        expect(
            keyFor(1, [
                { id: "item:0", text: "hello world" },
                { id: "item:1", text: "second text" },
            ]),
        ).toBe("ce9a0b29a7c3339ba91851d71b1164f93a35ea6053629f1e9a97ac26c2c02ece");
        expect(keyFor(7, [{ id: 'id "q"\\ü\n', text: 'café \u2028 "quoted\\" \n tab\t' }])).toBe(
            "abdb2e55e593fb0f05dfd9f01e3bbaba88f88452daa01cf19bb1ba43da933979",
        );
    });
});
