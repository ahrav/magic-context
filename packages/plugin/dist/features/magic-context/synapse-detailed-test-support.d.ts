/**
 * Test-only support for exercising the Synapse detailed (versioned-receipt)
 * embedding path against a deterministic in-process host double. Used by the
 * writer suites and the crash matrix; never imported by production code.
 */
import type { EmbeddingConfig } from "../../config/schema/magic-context";
import type { Database } from "../../shared/sqlite";
import { type SynapseClientLike, SynapseEmbeddingProvider } from "./memory/embedding-synapse";
export declare const SYNAPSE_TEST_MODEL = "gte-modernbert-base-f16";
export declare const SYNAPSE_TEST_FINGERPRINT = "fp-test";
export declare const SYNAPSE_TEST_EPOCH = 0;
export declare const SYNAPSE_TEST_DIMS = 3;
export declare const SYNAPSE_TEST_LANE_IDENTITY: string;
export interface RecordedHostCall {
    method: string;
    params: Record<string, unknown>;
}
/**
 * Deterministic host double: embed.batch always answers with a job descriptor
 * and embed.result serves the job's exact item set. `resultPages` scripts
 * multi-page or failing result flows; `vectorFor` shapes per-item vectors.
 */
export declare class DetailedSynapseTestHost implements SynapseClientLike {
    readonly calls: RecordedHostCall[];
    private jobCounter;
    private readonly jobItems;
    vectorFor: (id: string) => number[];
    resultPages?: (jobId: string, items: Array<{
        id: string;
        content_sha256: string;
    }>, resultCallIndex: number, cursor: unknown) => unknown;
    envelope(): Record<string, unknown>;
    batchCalls(): RecordedHostCall[];
    call<Response = unknown>(_module: string, method: string, params?: unknown): Promise<Response>;
    close(): void;
}
export declare function detailedSynapseTestProvider(host: SynapseClientLike, maxInputBytes?: number): SynapseEmbeddingProvider;
export declare function synapseTestConfig(): EmbeddingConfig;
export interface CrashInjection {
    /** SQL matcher for statements whose execution should throw. */
    matcher: RegExp;
    /** How many MATCHING executions to let through before throwing. */
    skip?: number;
    /** How many injected throws to perform before passing through again. */
    times?: number;
}
/**
 * Wrap a Database so chosen statements throw on execution, simulating a
 * process crash at that exact write. Delegates everything else unchanged;
 * transactions opened through the wrapper roll back on the injected throw,
 * matching what SQLite does when a process dies before COMMIT.
 */
export declare function crashingDatabase(db: Database, injection: CrashInjection): Database;
//# sourceMappingURL=synapse-detailed-test-support.d.ts.map