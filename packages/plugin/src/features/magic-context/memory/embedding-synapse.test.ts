import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McHostCallError } from "../../../shared/mc-host-client";
import { WaiterDetachedError } from "../../../shared/mc-host-lifecycle";
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
    type SynapseEmbeddingProviderOptions,
} from "./embedding-synapse";

class MockSynapseClient implements SynapseClientLike {
    readonly requests: Array<{
        method: string;
        params: unknown;
        expectedDaemonId?: Uint8Array;
    }> = [];
    private batchAttempts = 0;
    constructor(private readonly batchSize = 2) {}

    async call<Response = unknown>(
        _module: string,
        method: string,
        params?: unknown,
        options?: {
            timeoutMs?: number;
            identity?: { project_root: string; harness: string; session: string };
            targetKind?: "management_surface" | "tool_provider";
            expectedDaemonId?: Uint8Array;
        },
    ): Promise<Response> {
        this.requests.push({
            method,
            params,
            ...(options?.expectedDaemonId === undefined
                ? {}
                : { expectedDaemonId: options.expectedDaemonId }),
        });
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

function virtualTime(randomValues: number[] = [0]): {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    random: () => number;
    sleeps: number[];
} {
    let time = 0;
    let randomIndex = 0;
    const sleeps: number[] = [];
    return {
        now: () => time,
        sleep: async (ms) => {
            sleeps.push(ms);
            time += ms;
        },
        // Tests must declare every `randomValues` draw so an extra draw exposes a jitter-schedule change.
        random: () => {
            if (randomIndex >= randomValues.length) {
                throw new Error(
                    `virtualTime: draw ${randomIndex + 1} exceeds the ${randomValues.length} declared random value(s)`,
                );
            }
            return randomValues[randomIndex++];
        },
        sleeps,
    };
}

describe("SynapseEmbeddingProvider", () => {
    it("keeps injected factory providers lifecycle-neutral", async () => {
        const client = new MockSynapseClient();
        let demands = 0;
        const provider = new SynapseEmbeddingProvider({
            projectRoot: "/repo",
            session: "injected-synapse",
            demandStart: async () => {
                demands += 1;
                return { ok: true, reason: "started", storage: null };
            },
            clientFactory: async () => client,
            connectionOrigin: "managed-default",
        });

        expect(demands).toBe(0);
        await provider.initialize();
        await provider.initialize();
        expect(demands).toBe(0);
    });

    it("demands before a managed real connection and coalesces initialization", async () => {
        let demands = 0;
        const deadlines: (number | undefined)[] = [];
        const provider = new SynapseEmbeddingProvider({
            projectRoot: "/repo",
            session: "managed-synapse",
            demandStart: async (request) => {
                demands += 1;
                deadlines.push(request.deadlineMs);
                return { ok: false, reason: "startup_timeout", storage: null };
            },
            connectionOrigin: "managed-default",
        });

        expect(demands).toBe(0);
        await expect(Promise.all([provider.initialize(), provider.initialize()])).resolves.toEqual([
            false,
            false,
        ]);
        expect(demands).toBe(1);
        // The cold-start demand uses a shared deadline of at least 60,000 ms; per-query deadlines would detach waiters before startup completes.
        expect(deadlines[0]).toBeGreaterThanOrEqual(60_000);
    });

    it("does not demand a managed start for an already-aborted caller", async () => {
        // An already-aborted caller must not create an initialization flight because creating one triggers an uncancelable demand.
        let demands = 0;
        const provider = new SynapseEmbeddingProvider({
            projectRoot: "/repo",
            session: "managed-aborted-caller",
            demandStart: async () => {
                demands += 1;
                return { ok: true, reason: "started", storage: "ready" };
            },
            connectionOrigin: "managed-default",
        });

        expect(await provider.initialize(AbortSignal.abort())).toBe(false);
        expect(demands).toBe(0);
    });

    it("does not re-demand per call after a failed managed demand", async () => {
        let demands = 0;
        const provider = new SynapseEmbeddingProvider({
            projectRoot: "/repo",
            session: "managed-demand-backoff",
            demandStart: async () => {
                demands += 1;
                return { ok: false, reason: "native_payload_missing", storage: null };
            },
            connectionOrigin: "managed-default",
        });

        expect(await provider.initialize()).toBe(false);
        expect(await provider.initialize()).toBe(false);
        expect(demands).toBe(1);
    });

    it("does not re-demand when a managed demand succeeds without a daemon identity", async () => {
        // A demand success without an identity cannot dial, so it enters demand backoff.
        let demands = 0;
        const provider = new SynapseEmbeddingProvider({
            projectRoot: "/repo",
            session: "managed-demand-no-identity",
            demandStart: async () => {
                demands += 1;
                return { ok: true, reason: "started", storage: "ready" };
            },
            connectionOrigin: "managed-default",
        });

        expect(await provider.initialize()).toBe(false);
        expect(await provider.initialize()).toBe(false);
        expect(demands).toBe(1);
    });

    it("discovers a certified model and sends the required artifact constraints", async () => {
        const client = new MockSynapseClient();
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });

        expect(await provider.initialize()).toBe(true);
        expect(client.requests.find((entry) => entry.method === "models.list")?.params).toEqual({});
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

    it("binds Synapse calls to the lifecycle-compatible daemon identity", async () => {
        const client = new MockSynapseClient();
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "daemon-bound",
            clientFactory: async () => client,
        });
        const expectedDaemonId = new Uint8Array([1, 2, 3, 4]);
        (
            provider as unknown as {
                compatibleDaemonId: Uint8Array | null;
            }
        ).compatibleDaemonId = expectedDaemonId;

        expect(await provider.initialize()).toBe(true);
        expect(client.requests[0]?.expectedDaemonId).toEqual(expectedDaemonId);
    });

    it("refuses to publish on the managed lane without a certified daemon identity", async () => {
        const client = new MockSynapseClient();
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "fence-required",
            clientFactory: async () => client,
            // Injected factories are non-managed, so they cannot invoke a lifecycle owner.
            // Injected factories are non-managed, so they cannot invoke a lifecycle owner.
            // Injected factories are non-managed, so they cannot invoke a lifecycle owner.
            // Injected factories are non-managed, so they cannot invoke a lifecycle owner.
            // Injected factories are non-managed, so they cannot invoke a lifecycle owner.
            demandStart: async () => ({
                ok: true,
                reason: "started",
                storage: "ready",
                authenticatedDaemonId: new Uint8Array([4, 2]),
            }),
        });
        expect(await provider.initialize()).toBe(true);

        // The setup reproduces the post-rotation state the failure handler installs: the lane is managed and its certified identity is cleared.
        // An omitted expectation would publish unfenced onto the rotated daemon.
        // An omitted expectation would publish unfenced onto the rotated daemon.
        const internals = provider as unknown as {
            connectionOrigin: string;
            compatibleDaemonId: Uint8Array | null;
        };
        internals.connectionOrigin = "managed-default";
        internals.compatibleDaemonId = null;
        const published = client.requests.length;

        // `embed` returns `null` for a failed lane; no request reaches the wire without an expectation.
        expect(await provider.embed("hello")).toBeNull();
        expect(client.requests.length).toBe(published);
    });

    it("dials a managed-default lane that has no lifecycle owner to certify it", async () => {
        // A lane without an owner dials an already-running daemon before any identity is certified.
        const client = new MockSynapseClient();
        const provider = new SynapseEmbeddingProvider({
            projectRoot: "/repo",
            session: "passive-dial",
            clientFactory: async () => client,
        });
        const internals = provider as unknown as {
            connectionOrigin: string;
            demandStart: unknown;
            compatibleDaemonId: Uint8Array | null;
        };
        internals.connectionOrigin = "managed-default";
        expect(internals.demandStart).toBeUndefined();

        expect(await provider.initialize()).toBe(true);
        expect(internals.compatibleDaemonId).toBeNull();
        const discovery = client.requests.find((entry) => entry.method === "models.list");
        expect(discovery).toBeDefined();
        // Nothing certified an incarnation, so the call carries no expectation
        expect(discovery?.expectedDaemonId).toBeUndefined();
    });

    it("re-certification leaves an identity a sibling already certified in place", async () => {
        const client = new MockSynapseClient();
        const certified = new Uint8Array([9, 1]);
        const recertified = new Uint8Array([9, 2]);
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = () => resolve();
        });
        let demands = 0;
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "recertify-sibling",
            clientFactory: async () => client,
            demandStart: async () => {
                demands += 1;
                await gate;
                return {
                    ok: true,
                    reason: "started",
                    storage: "ready",
                    authenticatedDaemonId: recertified,
                };
            },
        });
        expect(await provider.initialize()).toBe(true);

        const internals = provider as unknown as {
            connectionOrigin: string;
            compatibleDaemonId: Uint8Array | null;
            initialized: boolean;
            rebindAfterModuleRestart(deadlineAt: number, signal?: AbortSignal): Promise<void>;
        };
        internals.connectionOrigin = "managed-default";
        internals.compatibleDaemonId = certified;

        const flight = internals.rebindAfterModuleRestart(Date.now() + 60_000);
        await Promise.resolve();
        await Promise.resolve();

        // An in-flight demand must not erase a dispatching sibling's re-established identity.
        // An in-flight demand must not erase a dispatching sibling's re-established identity.
        expect(demands).toBe(1);
        expect(internals.initialized).toBe(false);
        expect(internals.compatibleDaemonId).toEqual(certified);

        release();
        await expect(flight).resolves.toBeUndefined();
        expect(internals.compatibleDaemonId).toEqual(recertified);
    });

    it("does not clear a newer identity when a stale attempt fails after it is installed", async () => {
        const client = new MockSynapseClient();
        const rotated = new Uint8Array([8, 1]);
        const replacement = new Uint8Array([8, 2]);
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "stale-failure-sibling",
            clientFactory: async () => client,
        });
        expect(await provider.initialize()).toBe(true);

        const internals = provider as unknown as {
            connectionOrigin: string;
            compatibleDaemonId: Uint8Array | null;
            initialized: boolean;
        };
        internals.connectionOrigin = "managed-default";
        internals.compatibleDaemonId = rotated;

        client.call = async <Response = unknown>(
            _module: string,
            method: string,
            params?: unknown,
        ): Promise<Response> => {
            client.requests.push({ method, params });
            internals.compatibleDaemonId = replacement;
            internals.initialized = true;
            const error = new Error("module_restarted") as Error & { code: string };
            error.code = "module_restarted";
            throw error;
        };

        // The late failure is evidence about the rotated identity alone.
        expect(await provider.embed("hello")).toBeNull();
        expect(internals.compatibleDaemonId).toEqual(replacement);
        expect(internals.initialized).toBe(true);
    });

    it("does not arm managed-demand backoff for caller detachment", async () => {
        const client = new MockSynapseClient();
        let demands = 0;
        const provider = new SynapseEmbeddingProvider({
            projectRoot: "/repo",
            session: "managed-detachment",
            connectionOrigin: "managed-default",
            clientFactory: async () => client,
            demandStart: async () => {
                demands += 1;
                if (demands === 1) throw new WaiterDetachedError("aborted");
                return {
                    ok: true,
                    reason: "started",
                    storage: "ready",
                    authenticatedDaemonId: new Uint8Array([1]),
                };
            },
        });
        const internals = provider as unknown as { connectionOrigin: string };
        internals.connectionOrigin = "managed-default";

        expect(await provider.initialize()).toBe(false);
        expect(await provider.initialize()).toBe(true);
        expect(demands).toBe(2);
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
        // The page budget limits pages to two items despite the row limit of three.
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
        expect(provider.metadata?.recommended_batch).toBe(3);
        expect(provider.metadata?.recommended_token_budget).toBe(1024);

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

    it("retries queue-full admission through the deadline under the safety cap", async () => {
        let queryCalls = 0;
        // A served 0ms hint floors the base at 1ms; the 64-attempt cap binds before the 5s deadline.
        // The 64-attempt safety cap binds before the 5 s deadline.
        const time = virtualTime(new Array(63).fill(0));
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            queryTimeoutMs: 5_000,
            now: time.now,
            sleep: time.sleep,
            random: time.random,
            clientFactory: async () =>
                ({
                    async call<Response = unknown>(): Promise<Response> {
                        queryCalls += 1;
                        const error = new Error("query admission is full") as Error & {
                            code: string;
                            retry_after_ms: number;
                        };
                        error.code = "queue_full";
                        error.retry_after_ms = 0;
                        throw error;
                    },
                    close() {},
                }) as SynapseClientLike,
        });

        expect(await provider.embed("hello")).toBeNull();
        expect(queryCalls).toBe(64);
        expect(time.sleeps).toEqual(new Array(63).fill(1));
    });

    it("ends a retry delay as soon as the caller aborts", async () => {
        let queryCalls = 0;
        const controller = new AbortController();
        // The injected sleep never settles, so only the abort can end the race.
        // The retry delay must honor the signal so an aborted caller does not wait for the served 2s hint.
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            queryTimeoutMs: 30_000,
            now: () => 0,
            sleep: () => {
                controller.abort();
                return new Promise<void>(() => {});
            },
            random: () => 0,
            clientFactory: async () =>
                ({
                    async call<Response = unknown>(): Promise<Response> {
                        queryCalls += 1;
                        const error = new Error("query admission is full") as Error & {
                            code: string;
                            retry_after_ms: number;
                        };
                        error.code = "queue_full";
                        error.retry_after_ms = 2_000;
                        throw error;
                    },
                    close() {},
                }) as SynapseClientLike,
        });

        expect(await provider.embed("hello", controller.signal)).toBeNull();
        // Abort abandons the retry wait, so the next attempt is never dispatched.
        expect(queryCalls).toBe(1);
    });

    it("lets the deadline, not the four-attempt cap, budget queue-full retries", async () => {
        let queryCalls = 0;
        // The retry sequence stops after seven attempts because the next 50ms sleep reaches the 350ms deadline.
        const time = virtualTime(new Array(6).fill(0));
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            queryTimeoutMs: 350,
            now: time.now,
            sleep: time.sleep,
            random: time.random,
            clientFactory: async () =>
                ({
                    async call<Response = unknown>(): Promise<Response> {
                        queryCalls += 1;
                        const error = new Error("query admission is full") as Error & {
                            code: string;
                            retry_after_ms: number;
                        };
                        error.code = "queue_full";
                        error.retry_after_ms = 50;
                        throw error;
                    },
                    close() {},
                }) as SynapseClientLike,
        });

        expect(await provider.embed("hello")).toBeNull();
        expect(queryCalls).toBe(7);
        expect(time.sleeps).toEqual(new Array(6).fill(50));
    });

    it("gives overlapping embed calls independent retry jitter", async () => {
        const time = virtualTime([0.25, 0.75]);
        let queryCalls = 0;
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            queryTimeoutMs: 5_000,
            now: time.now,
            sleep: time.sleep,
            random: time.random,
            clientFactory: async () =>
                ({
                    async call<Response = unknown>(): Promise<Response> {
                        queryCalls += 1;
                        if (queryCalls <= 2) {
                            const error = new Error("full") as Error & {
                                code: string;
                                retry_after_ms: number;
                            };
                            error.code = "queue_full";
                            error.retry_after_ms = 100;
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

        const [first, second] = await Promise.all([
            provider.embed("first"),
            provider.embed("second"),
        ]);

        expect(first).toEqual(new Float32Array([1, 2, 3]));
        expect(second).toEqual(new Float32Array([1, 2, 3]));
        expect(queryCalls).toBe(4);
        // Jitter transforms base 100 with draws 0.25 and 0.75 into 150 and 250.
        expect([...time.sleeps].sort((left, right) => left - right)).toEqual([150, 250]);
        expect(time.sleeps[0]).not.toBe(time.sleeps[1]);
    });

    it("uses authoritative retry-after jitter and rebuilds attempt deadlines", async () => {
        const time = virtualTime([0.25, 0.75]);
        const calls: Array<Record<string, unknown>> = [];
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            queryTimeoutMs: 100,
            now: time.now,
            sleep: time.sleep,
            random: time.random,
            clientFactory: async () => ({
                async call<Response = unknown>(_m: string, _method: string, params?: unknown) {
                    calls.push(params as Record<string, unknown>);
                    if (calls.length < 3) {
                        const error = new Error("full") as Error & {
                            code: string;
                            retry_after_ms: number;
                        };
                        error.code = "queue_full";
                        error.retry_after_ms = 20;
                        throw error;
                    }
                    return {
                        vector: [1, 2, 3],
                        fingerprint: "fp-live",
                        table_epoch: 0,
                    } as Response;
                },
                close() {},
            }),
        });

        expect(await provider.embed("hello")).toEqual(new Float32Array([1, 2, 3]));
        expect(time.sleeps).toEqual([30, 50]);
        expect(calls.map((params) => params.deadline_ms)).toEqual([100, 70, 20]);
    });

    it("retries a host-shutdown cancellation and never condemns the lane", async () => {
        let calls = 0;
        const time = virtualTime([0]);
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            now: time.now,
            sleep: time.sleep,
            random: time.random,
            clientFactory: async () => ({
                async call<Response = unknown>(): Promise<Response> {
                    calls += 1;
                    if (calls === 1) {
                        // The host sends `cancelled` while restarting; the cancellation applies only to the current incarnation, so a retry may reach the next one.
                        const error = new Error("the host is shutting down") as Error & {
                            code: string;
                        };
                        error.code = "cancelled";
                        throw error;
                    }
                    return {
                        vector: [1, 2, 3],
                        fingerprint: "fp-live",
                        table_epoch: 0,
                    } as Response;
                },
                close() {},
            }),
        });

        expect(await provider.embed("hello")).toEqual(new Float32Array([1, 2, 3]));
        expect(calls).toBe(2);
    });

    it("maps a code-less AbortError to cancelled by its name and never retries it", async () => {
        let calls = 0;
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            clientFactory: async () => ({
                async call() {
                    calls += 1;
                    // A code-less `AbortError` is classified by its `name`.
                    throw Object.assign(new Error("aborted"), { name: "AbortError" });
                },
                close() {},
            }),
        });

        expect(await provider.embed("hello")).toBeNull();
        expect(calls).toBe(1);
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
        expect(await provider.initialize()).toBe(false);
        expect(listCalls).toBeGreaterThan(callsAfterFirstRound);
    });
});

describe("embedItems page budget", () => {
    it("spans submission and polling with one page deadline", async () => {
        // A `queue_full` retry consumes 400 ms of the 1 s page budget; pending polling uses the remaining budget, so the page settles at 1 s rather than 1.4 s.
        const pageTimeoutMs = 1_000;
        let batchCalls = 0;
        let resultCalls = 0;
        // The poll schedule makes no jitter draws before the deadline.
        const time = virtualTime(new Array(64).fill(0));
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            fingerprint: "fp-live",
            tableEpoch: 0,
            dims: 3,
            batchTimeoutMs: pageTimeoutMs,
            now: time.now,
            sleep: time.sleep,
            random: time.random,
            clientFactory: async () =>
                ({
                    async call<Response = unknown>(
                        _module: string,
                        method: string,
                    ): Promise<Response> {
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
                        if (method === "embed.batch") {
                            batchCalls += 1;
                            if (batchCalls === 1) {
                                const error = new Error("batch admission is full") as Error & {
                                    code: string;
                                    retry_after_ms: number;
                                };
                                error.code = "queue_full";
                                error.retry_after_ms = 400;
                                throw error;
                            }
                            return { result: { job_id: "job-1" } } as Response;
                        }
                        if (method !== "embed.result") throw new Error(`unexpected ${method}`);
                        resultCalls += 1;
                        return { result: { retry_after_ms: 100 } } as Response;
                    },
                    close() {},
                }) as SynapseClientLike,
        });

        const text = "hello";
        const contentSha256 = createHash("sha256").update(text).digest("hex");
        const vectors = await provider.embedItems([{ id: "a", text, contentSha256 }]);

        // The page exhausts its budget before completion.
        expect(vectors.size).toBe(0);
        expect(resultCalls).toBeGreaterThan(0);
        expect(time.now()).toBeLessThanOrEqual(pageTimeoutMs);
    });
});

describe("embedItemsDetailed", () => {
    const MODEL = "gte-modernbert-base-f16";
    const FP = "fp-live";
    const ENVELOPE = { model: MODEL, fingerprint: FP, table_epoch: 0, dims: 3 };

    interface RecordedCall {
        method: string;
        params: Record<string, unknown>;
        expectedDaemonId?: Uint8Array;
        timeoutMs?: number;
    }

    /**
     * */
    class DetailedHost implements SynapseClientLike {
        readonly calls: RecordedCall[] = [];
        private jobCounter = 0;
        private readonly jobItems = new Map<
            string,
            Array<{ id: string; content_sha256: string }>
        >();
        batchRetryAfterMs = 50;
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
            options?: { expectedDaemonId?: Uint8Array; timeoutMs?: number },
        ): Promise<Response> {
            const record = {
                method,
                params: (params ?? {}) as Record<string, unknown>,
                ...(options?.expectedDaemonId === undefined
                    ? {}
                    : { expectedDaemonId: options.expectedDaemonId }),
                ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            };
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
                        retry_after_ms: this.batchRetryAfterMs,
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

    /** The client rejects a request before enqueueing when the authenticated daemon differs from the certified incarnation, so the daemon receives no request.
     * */
    function daemonGenerationChangedError(): Error {
        const error = new Error(
            "authenticated daemon changed after lifecycle compatibility validation",
        ) as Error & { code: string };
        error.code = "daemon_generation_changed";
        return error;
    }

    /** The host rejects inputs exceeding the per-input byte cap.
     * */
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

    function detailedProvider(
        client: SynapseClientLike,
        overrides: Partial<SynapseEmbeddingProviderOptions> = {},
    ): SynapseEmbeddingProvider {
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
            ...overrides,
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

    /** The wrapper inserts a competitor row after the exact-identity read misses and before creation, so the partial unique index rejects this attempt's insert.
     * */
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
            const time = virtualTime([0.5]);
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
            const provider = detailedProvider(host, {
                now: time.now,
                sleep: time.sleep,
                random: time.random,
            });
            const items = detailedItems([
                { id: "memory:1", group: "g1" },
                { id: "memory:2", group: "g1" },
            ]);
            const result = await provider.embedItemsDetailed(items, detailedContext(db));

            expect(result.failures).toEqual([]);
            expect(result.receipts).toHaveLength(1);
            const firstPoll = stateAtFirstPoll as Record<string, unknown> | null;
            expect(firstPoll?.state).toBe("polling");
            expect(firstPoll?.job_id).toBe("job-1");
            expect(typeof firstPoll?.attempt_id).toBe("string");
            expect(firstPoll?.deadline_at as number).toBeGreaterThan(time.now());

            const row = ledgerRows(db)[0];
            expect(row.state).toBe("ready");
            expect(row.cursor).toBe("cursor-1");
            expect(row.state_version).toBe(result.receipts[0].stateVersion);
            expect(result.receipts[0].vectors.get("memory:2")).toEqual(new Float32Array([4, 5, 6]));
            // A ready job never sleeps; it pays only wire round trips.
            expect(time.sleeps).toEqual([]);
            expect(host.calls.every((call) => !("deadline_ms" in call.params))).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    it("treats done:false without a cursor as explicit pending and keeps polling", async () => {
        const db = ledgerDb();
        try {
            const time = virtualTime([0.5]);
            const host = new DetailedHost();
            host.resultPages = (_jobId, items, index) => {
                if (index < 2) {
                    return { result: { done: false, status: "running", retry_after_ms: 50 } };
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
            const provider = detailedProvider(host, {
                now: time.now,
                sleep: time.sleep,
                random: time.random,
                pollDefaultDelayMs: 50,
            });
            const result = await provider.embedItemsDetailed(
                detailedItems([{ id: "memory:1", group: "g1" }]),
                detailedContext(db),
            );
            expect(result.receipts).toHaveLength(1);
            expect(host.resultCalls()).toHaveLength(3);
            // The first poll is immediate.
            // The fast-first delay is min(1 * (1 + 0.5), 50) = 1.5 ms.
            // The pending wait uses max(10, 1.5 * 1.6) = 10 ms.
            // The 50 ms server cap does not clamp the 1.5 ms fast-first or 10 ms pending delay.
            expect(time.sleeps).toEqual([1.5, 10]);
            expect(ledgerRows(db)[0].state).toBe("ready");
        } finally {
            closeQuietly(db);
        }
    });

    it("clamps escalating polls to the page deadline and keeps the 120s count finite", async () => {
        const db = ledgerDb();
        try {
            const time = virtualTime([0]);
            const host = new DetailedHost();
            host.batchRetryAfterMs = 50_000;
            host.resultPages = () => ({
                result: { done: false, status: "running", retry_after_ms: 50_000 },
            });
            const provider = detailedProvider(host, {
                batchTimeoutMs: 120_000,
                now: time.now,
                sleep: time.sleep,
                random: time.random,
                pollInitialDelayMs: 30_000,
                pollDefaultDelayMs: 50_000,
            });

            const result = await provider.embedItemsDetailed(
                detailedItems([{ id: "memory:1", group: "g1" }]),
                detailedContext(db),
            );

            expect(result.receipts).toEqual([]);
            expect(result.failures[0]?.code).toBe("timeout");
            // The first poll is immediate at t=0.
            // The next waits are 30_000 ms (jitter draw 0) and 48_000 ms (30_000 * 1.6).
            // The 120_000 ms deadline leaves a final 42_000 ms wait; only three polls occur before expiry.
            expect(host.resultCalls()).toHaveLength(3);
            expect(time.sleeps).toEqual([30_000, 48_000, 42_000]);
            expect(time.now()).toBe(120_000);
        } finally {
            closeQuietly(db);
        }
    });

    it("bounds the default-configuration poll count over the full 120s deadline", async () => {
        const db = ledgerDb();
        try {
            // Only the fast-first delay consumes a jitter draw.
            // deterministic escalation.
            const time = virtualTime([0]);
            const host = new DetailedHost();
            host.resultPages = () => ({
                result: { done: false, status: "running", retry_after_ms: 50 },
            });
            const provider = detailedProvider(host, {
                batchTimeoutMs: 120_000,
                now: time.now,
                sleep: time.sleep,
                random: time.random,
                pollDefaultDelayMs: 50,
            });

            const result = await provider.embedItemsDetailed(
                detailedItems([{ id: "memory:1", group: "g1" }]),
                detailedContext(db),
            );

            expect(result.receipts).toEqual([]);
            expect(result.failures[0]?.code).toBe("timeout");
            // The provider polls immediately, then sleeps 1, 10, 16, 25.6, 40.96, and 50 ms until the deadline.
            // A never-finishing job performs at most 2_404 polls before its deadline.
            // under defaults.
            expect(host.resultCalls()).toHaveLength(2404);
            expect(time.now()).toBe(120_000);
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

            // The expired retained job is never polled; its deadline makes re-derivation impossible, so the row is obsoleted and a fresh page runs.
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
            // The retained reply is the only failure, so the ready row retires and no row records a disposition for an unsubmitted page.
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
            // A retained reply whose hash mismatches the expected hash permanently records failure.
            // The mismatched hash permanently records failure for the retained reply.
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
            // Only the ready row is retired; no second row records a disposition for a page that never reached the daemon.
            expect(ledgerRows(db).map((row) => row.state)).toEqual(["obsolete"]);
            expect(host.batchCalls()).toEqual([]);

            // The next run opens a fresh page for the same identity, and the fresh submission embeds the content.
            // The fresh submission embeds the content.
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

    it("rebinds a restarted page to the compatible replacement daemon", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const daemonIds = [new Uint8Array([1]), new Uint8Array([2])];
            // The retained job rotates once when its reply reports a restart.
            // Daemon identity depends on generation, not demand count; coalesced demands during one restart observe the same replacement.
            let rotated = false;
            host.resultPages = (jobId, items) => {
                if (jobId === "job-1") {
                    rotated = true;
                    return moduleRestartedError();
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
            let demands = 0;
            const mutable = provider as unknown as {
                connectionOrigin: "managed-default";
                demandStart: () => Promise<{
                    ok: true;
                    reason: "started";
                    storage: null;
                    authenticatedDaemonId: Uint8Array;
                }>;
            };
            mutable.connectionOrigin = "managed-default";
            mutable.demandStart = async () => {
                demands += 1;
                return {
                    ok: true,
                    reason: "started",
                    storage: null,
                    authenticatedDaemonId: (rotated ? daemonIds[1] : daemonIds[0]) as Uint8Array,
                };
            };

            const result = await provider.embedItemsDetailed(
                detailedItems([{ id: "memory:1", group: "g1" }]),
                detailedContext(db),
            );

            expect(result.failures).toEqual([]);
            expect(result.receipts).toHaveLength(1);
            // The client demands twice: once for certification and once to rebind after the restart.
            expect(demands).toBe(2);
            const batches = host.batchCalls();
            expect(batches).toHaveLength(2);
            expect(batches[0].expectedDaemonId).toEqual(daemonIds[0]);
            expect(batches[1].expectedDaemonId).toEqual(daemonIds[1]);
            expect(batches[0].params.request_key).toBe(batches[1].params.request_key);
        } finally {
            closeQuietly(db);
        }
    });

    it("rebinds a page refused by the pre-publication daemon fence without spending the restart budget", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const daemonIds = [new Uint8Array([1]), new Uint8Array([2])];
            let rotated = false;
            // The client fence refuses the first submission before publishing.
            // A `not_sent` refusal means no request reached the daemon.
            // A `not_sent` refusal permits resubmission of the same request key against the replacement daemon.
            host.batchError = (index) => {
                if (index !== 0) return null;
                rotated = true;
                return daemonGenerationChangedError();
            };
            const provider = detailedProvider(host);
            const mutable = provider as unknown as {
                connectionOrigin: "managed-default";
                demandStart: () => Promise<{
                    ok: true;
                    reason: "started";
                    storage: null;
                    authenticatedDaemonId: Uint8Array;
                }>;
            };
            mutable.connectionOrigin = "managed-default";
            mutable.demandStart = async () => ({
                ok: true,
                reason: "started",
                storage: null,
                authenticatedDaemonId: (rotated ? daemonIds[1] : daemonIds[0]) as Uint8Array,
            });

            const result = await provider.embedItemsDetailed(
                detailedItems([{ id: "memory:1", group: "g1" }]),
                detailedContext(db),
            );

            // The fence is absorbed in-page, so the page succeeds without returning a failure to retry.
            expect(result.failures).toEqual([]);
            expect(result.receipts).toHaveLength(1);
            const batches = host.batchCalls();
            expect(batches).toHaveLength(2);
            // The replacement daemon deduplicates the same request key.
            // The retry uses the replacement daemon identity without double-embedding.
            expect(batches[0].params.request_key).toBe(batches[1].params.request_key);
            expect(batches[1].expectedDaemonId).toEqual(daemonIds[1]);
            // The durable restart budget belongs to observed daemon restarts.
            // A pre-publication refusal does not consume the durable restart budget.
            // A later observed daemon restart remains absorbable.
            const row = getSynapseLedgerPage(db, result.receipts[0].rowId);
            expect(row?.restartCount ?? 0).toBe(0);
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
            // A permanent `failure_disposition` prevents repeated page resubmission.
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
            // The page has spent its single durable restart.
            // The replacement job reached `ready` before returning `module_restarted`.
            // After a second restart, the page has no restart budget for resubmission.
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
            // A disabled lane reports `artifact_invalid`.
            // The disabled lane reports `artifact_invalid` for every later page instead of embedding it.
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
            // The first restart consumes the single submission-time rebind.
            // The rebind resubmits the same request key.
            // The second restart propagates without consuming the durable restart budget.
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
            const batchCalls = host.batchCalls();
            expect(batchCalls).toHaveLength(2);
            expect(batchCalls[1].params.request_key).toBe(batchCalls[0].params.request_key);
            const row = ledgerRows(db)[0];
            expect(row.state).toBe("failed");
            expect(row.failure_disposition).toBe("retryable");
            expect(row.restart_count).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    it("reports a page cancelled when the abort lands inside its re-validation", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            const controller = new AbortController();
            let demands = 0;
            const provider = new SynapseEmbeddingProvider({
                connectionFile: "fixture",
                projectRoot: "/repo",
                session: "ses-1",
                model: MODEL,
                fingerprint: FP,
                tableEpoch: 0,
                dims: 3,
                recommendedBatch: 2,
                batchTimeoutMs: 5_000,
                clientFactory: async () => host,
                demandStart: async () => {
                    demands += 1;
                    // The abort occurs while the managed demand is in flight.
                    // `initialize` observes the abort on its own await.
                    // A rejected `raceSignal` makes `initialize` return `false`.
                    controller.abort();
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    return {
                        ok: true,
                        reason: "started",
                        storage: "ready",
                        authenticatedDaemonId: new Uint8Array([7, 7]),
                    };
                },
            });
            // Certifying the lane before installing the managed origin lets pre-loop initialization dispatch the first page without demanding.
            expect(await provider.initialize()).toBe(true);
            const internals = provider as unknown as {
                connectionOrigin: string;
                compatibleDaemonId: Uint8Array | null;
                initialized: boolean;
            };
            internals.connectionOrigin = "managed-default";
            internals.compatibleDaemonId = new Uint8Array([7, 7]);

            // An earlier page's rotation leaves the lane managed and uncertified.
            // A managed, uncertified lane requires per-page re-validation.
            host.resultPages = (_jobId, items) => {
                if (items.some((item) => item.id === "memory:1")) internals.initialized = false;
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

            const result = await provider.embedItemsDetailed(
                detailedItems([
                    { id: "memory:1", group: "g1" },
                    { id: "memory:2", group: "g2" },
                ]),
                detailedContext(db),
                controller.signal,
            );

            // The first page returned a receipt even though it invalidated the identity.
            expect(result.receipts).toHaveLength(1);
            expect(result.receipts[0].applicationGroup).toBe("g1");
            // The second page's re-validation makes exactly one demand.
            expect(demands).toBe(1);
            expect(result.failures).toHaveLength(1);
            const g2 = result.failures[0];
            expect(g2.applicationGroup).toBe("g2");
            expect(g2.code).toBe("cancelled");
            expect(g2.message).toBe("Synapse request aborted");
            expect(g2.disposition).toBe("retryable");
            // The cancelled page must never have reached the wire.
            expect(host.batchCalls()).toHaveLength(1);
        } finally {
            closeQuietly(db);
        }
    });

    it("scopes an exhausted restart budget to its page and leaves sibling pages runnable", async () => {
        const db = ledgerDb();
        try {
            const host = new DetailedHost();
            // The first group's page exhausts its single durable restart; the second page retains its own budget.
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
            // A live lane embeds later pages; a disabled lane returns `artifact_invalid`.
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
            // Only the first group's page contains content the host rejects.
            // The second group's page reaches the daemon despite the first group's rejection.
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
            // A condemned lane returns `artifact_invalid` without submitting later pages.
            // A receipt for a later page proves that the lane is not condemned.
            expect(result.receipts).toHaveLength(1);
            expect(result.receipts[0].applicationGroup).toBe("g2");
            expect(result.receipts[0].vectors.size).toBe(1);
            expect(host.batchCalls()).toHaveLength(2);
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

            // A permanently failed page creates no additional ledger row or daemon job.
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

            // The loser of the create race drives the winner's row.
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
                    // A sibling process advanced the same job's row to `ready`, making this attempt's version stale.
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

            // The widened read prevents TypeScript from narrowing a closure-assigned variable to its initial type.
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
                    // The provider discards vectors when the live row belongs to a different job.
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
            // No receipt claims the rival row.
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
            const time = virtualTime([0]);
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
            const provider = detailedProvider(host, {
                now: time.now,
                sleep: time.sleep,
                random: time.random,
            });
            const vectors = await provider.embedItems([
                { id: "memory:1", text: "one", contentSha256: "a" },
            ]);
            expect(vectors.get("memory:1")).toEqual(new Float32Array([1, 2, 3]));
            expect(host.resultCalls()).toHaveLength(2);
            expect(time.sleeps).toEqual([1]);
            expect(host.calls.every((call) => !("deadline_ms" in call.params))).toBe(true);
            expect(ledgerRows(db)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    it("keeps the original legacy page deadline across daemon rebind and polling", async () => {
        let now = 1_000;
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
            const provider = new SynapseEmbeddingProvider({
                connectionFile: "fixture",
                projectRoot: "/repo",
                session: "legacy-deadline",
                model: MODEL,
                fingerprint: FP,
                tableEpoch: 0,
                dims: 3,
                recommendedBatch: 2,
                batchTimeoutMs: 100,
                now: () => now,
                clientFactory: async () => host,
            });
            const daemonIds = [new Uint8Array([1]), new Uint8Array([2])];
            let demands = 0;
            const mutable = provider as unknown as {
                connectionOrigin: "managed-default";
                demandStart: () => Promise<{
                    ok: true;
                    reason: "started";
                    storage: null;
                    authenticatedDaemonId: Uint8Array;
                }>;
            };
            mutable.connectionOrigin = "managed-default";
            mutable.demandStart = async () => {
                if (demands === 1) now += 40;
                return {
                    ok: true,
                    reason: "started",
                    storage: null,
                    authenticatedDaemonId: daemonIds[demands++] as Uint8Array,
                };
            };

            const vectors = await provider.embedItems([
                { id: "memory:1", text: "one", contentSha256: "a" },
            ]);

            expect(vectors.get("memory:1")).toEqual(new Float32Array([1, 2, 3]));
            expect(demands).toBe(2);
            const batches = host.batchCalls();
            expect(batches[0].expectedDaemonId).toEqual(daemonIds[0]);
            expect(batches[1].expectedDaemonId).toEqual(daemonIds[1]);
            expect(batches[0].params.request_key).toBe(batches[1].params.request_key);
            const replacementPoll = host
                .resultCalls()
                .find((call) => call.params.job_id === "job-2");
            expect(replacementPoll?.timeoutMs).toBe(60);
        } finally {
            _resetSynapseClientForTests();
        }
    });

    it("keeps the cursor while a later legacy result page is pending", async () => {
        const db = ledgerDb();
        try {
            const time = virtualTime([0]);
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
            const provider = detailedProvider(host, {
                now: time.now,
                sleep: time.sleep,
                random: time.random,
            });

            const vectors = await provider.embedItems([
                { id: "memory:1", text: "one", contentSha256: "a" },
                { id: "memory:2", text: "two", contentSha256: "b" },
            ]);

            expect([...vectors.keys()]).toEqual(["memory:1", "memory:2"]);
            expect(vectors.get("memory:2")).toEqual(new Float32Array([4, 5, 6]));
            expect(cursors).toEqual([null, "cursor-1", "cursor-1"]);
            expect(time.sleeps).toEqual([1]);
            expect(ledgerRows(db)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("canonical request-key golden vectors", () => {
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
