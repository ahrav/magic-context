import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubcCallError } from "../../../shared/mc-host-client";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    createSynapseLedgerPage,
    getSynapseLedgerPage,
    markSynapseLedgerPolling,
    recordSynapseLedgerCursor,
} from "../storage-embedding-measurements";
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
                        throw new SubcCallError("outcome_unknown", "ambiguous send");
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
                            const error = new SubcCallError(
                                "outcome_unknown",
                                "ambiguous send",
                            ) as SubcCallError & { retry_after_ms: number };
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
                        const error = new SubcCallError(
                            "outcome_unknown",
                            "ambiguous send",
                        ) as SubcCallError & { retry_after_ms: number };
                        error.retry_after_ms = 0;
                        throw error;
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        expect(await provider.embed("hello")).toBeNull();
        expect(queryCalls).toBe(4);
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
                        const error = new SubcCallError(
                            "outcome_unknown",
                            "ambiguous send",
                        ) as SubcCallError & { retry_after_ms: number };
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
                        const error = new SubcCallError(
                            "terminal",
                            "route.open failed for module synapse: target_unavailable",
                            "target_unavailable",
                        ) as SubcCallError & { retry_after_ms: number };
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

    /** Deterministic host double: embed.batch always answers with a job
     *  descriptor and embed.result serves scripted pages per job. */
    class DetailedHost implements SynapseClientLike {
        readonly calls: RecordedCall[] = [];
        private jobCounter = 0;
        private readonly jobItems = new Map<
            string,
            Array<{ id: string; content_sha256: string }>
        >();
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

    function ledgerDb(): Database {
        const db = new Database(":memory:");
        db.exec("PRAGMA foreign_keys=ON");
        initializeDatabase(db);
        runMigrations(db);
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
            expect(stateAtFirstPoll?.state).toBe("polling");
            expect(stateAtFirstPoll?.job_id).toBe("job-1");
            expect(typeof stateAtFirstPoll?.attempt_id).toBe("string");
            expect(stateAtFirstPoll?.deadline_at as number).toBeGreaterThan(Date.now());

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
            expect(result.failures[0].code).toBe("module_restarted");
            expect(result.failures[0].disposition).toBe("retryable");
            expect(host.batchCalls()).toHaveLength(2);
            const row = ledgerRows(db)[0];
            expect(row.state).toBe("failed");
            expect(row.failure_disposition).toBe("retryable");
            expect(row.restart_count).toBe(1);
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
});
