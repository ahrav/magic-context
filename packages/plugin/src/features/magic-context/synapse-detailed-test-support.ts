/**
 * Test-only support for exercising the Synapse detailed (versioned-receipt)
 * embedding path against a deterministic in-process host double. Used by the
 * writer suites and the crash matrix; never imported by production code.
 */

import type { EmbeddingConfig } from "../../config/schema/magic-context";
import {
    getSynapseLaneIdentity,
    type SynapseClientLike,
    SynapseEmbeddingProvider,
} from "./memory/embedding-synapse";

const SYNAPSE_TEST_MODEL = "gte-modernbert-base-f16";
const SYNAPSE_TEST_FINGERPRINT = "fp-test";
const SYNAPSE_TEST_EPOCH = 0;
const SYNAPSE_TEST_DIMS = 3;

export const SYNAPSE_TEST_LANE_IDENTITY = getSynapseLaneIdentity(
    SYNAPSE_TEST_MODEL,
    SYNAPSE_TEST_FINGERPRINT,
);

export interface RecordedHostCall {
    method: string;
    params: Record<string, unknown>;
}

/**
 * Deterministic host double: embed.batch always answers with a job descriptor
 * and embed.result serves the job's exact item set. `resultPages` scripts
 * multi-page or failing result flows; `vectorFor` shapes per-item vectors.
 */
export class DetailedSynapseTestHost implements SynapseClientLike {
    readonly calls: RecordedHostCall[] = [];
    private jobCounter = 0;
    private readonly jobItems = new Map<string, Array<{ id: string; content_sha256: string }>>();

    vectorFor: (id: string) => number[] = () => [1, 2, 3];
    resultPages?: (
        jobId: string,
        items: Array<{ id: string; content_sha256: string }>,
        resultCallIndex: number,
        cursor: unknown,
    ) => unknown;

    envelope(): Record<string, unknown> {
        return {
            model: SYNAPSE_TEST_MODEL,
            fingerprint: SYNAPSE_TEST_FINGERPRINT,
            table_epoch: SYNAPSE_TEST_EPOCH,
            dims: SYNAPSE_TEST_DIMS,
        };
    }

    batchCalls(): RecordedHostCall[] {
        return this.calls.filter((call) => call.method === "embed.batch");
    }

    async call<Response = unknown>(
        _module: string,
        method: string,
        params?: unknown,
    ): Promise<Response> {
        const record = { method, params: (params ?? {}) as Record<string, unknown> };
        this.calls.push(record);
        if (method === "models.list") {
            return {
                models: [
                    {
                        model: SYNAPSE_TEST_MODEL,
                        fingerprint: SYNAPSE_TEST_FINGERPRINT,
                        table_epoch: SYNAPSE_TEST_EPOCH,
                        dims: SYNAPSE_TEST_DIMS,
                    },
                ],
            } as Response;
        }
        if (method === "embed.query") {
            return { vector: [1, 2, 3], ...this.envelope() } as Response;
        }
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
                this.calls.filter(
                    (call) => call.method === "embed.result" && call.params.job_id === jobId,
                ).length - 1;
            if (this.resultPages) {
                const scripted = this.resultPages(jobId, items, index, record.params.cursor);
                if (scripted instanceof Error) throw scripted;
                return scripted as Response;
            }
            return {
                result: {
                    ...this.envelope(),
                    done: true,
                    vectors: items.map((item) => ({
                        id: item.id,
                        content_sha256: item.content_sha256,
                        vector: this.vectorFor(item.id),
                    })),
                },
            } as Response;
        }
        throw new Error(`unexpected method ${method}`);
    }

    close(): void {}
}

export function detailedSynapseTestProvider(
    host: SynapseClientLike,
    maxInputBytes?: number,
): SynapseEmbeddingProvider {
    return new SynapseEmbeddingProvider({
        connectionFile: "fixture",
        projectRoot: "/repo",
        session: "detailed-test",
        model: SYNAPSE_TEST_MODEL,
        fingerprint: SYNAPSE_TEST_FINGERPRINT,
        tableEpoch: SYNAPSE_TEST_EPOCH,
        dims: SYNAPSE_TEST_DIMS,
        recommendedBatch: 2,
        maxInputBytes,
        batchTimeoutMs: 5_000,
        clientFactory: async () => host,
    });
}

export function synapseTestConfig(): EmbeddingConfig {
    return {
        provider: "synapse",
        model: SYNAPSE_TEST_MODEL,
        synapse_fingerprint: SYNAPSE_TEST_FINGERPRINT,
        synapse_table_epoch: SYNAPSE_TEST_EPOCH,
        synapse_dims: SYNAPSE_TEST_DIMS,
    } as unknown as EmbeddingConfig;
}
