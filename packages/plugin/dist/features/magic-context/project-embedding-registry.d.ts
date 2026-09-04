import type { EmbeddingConfig } from "../../config/schema/magic-context";
import type { Database } from "../../shared/sqlite";
import { type CompartmentChunkWindow } from "./compartment-chunk-embedding";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
export interface EmbeddingFeatures {
    memoryEnabled: boolean;
    gitCommitEnabled: boolean;
}
export interface ProjectEmbeddingRegistrationSnapshot {
    projectIdentity: string;
    sourceDirectory: string;
    providerIdentity: string;
    runtimeFingerprint: string;
    generation: number;
    features: EmbeddingFeatures;
    enabled: boolean;
    gitCommitEnabled: boolean;
    modelId: string;
    chunkModelId: string;
    /** Friendly configured model name (e.g. "text-embedding-qwen3-embedding-4b"),
     *  for user-facing status. "off" when no provider / observation mode. */
    model: string;
    /** Configured provider kind (e.g. "openai-compatible", "local", "ollama"). */
    provider: string;
}
type ShadowScope = "commit" | "chunk";
export type ShadowBackfillStopReason = "drained" | "stalled_no_progress";
/** Stop reason for a scope's last backfill retirement, for status surfaces. */
export declare function getShadowBackfillStopReason(projectIdentity: string, scope: "commit" | "chunk"): ShadowBackfillStopReason | undefined;
/** Latch a project as currently loaded from an untrusted config (suppresses GC). */
export declare function markProjectLoadUntrusted(projectIdentity: string): void;
/** Construction context every provider receives from {@link createProvider}. */
interface ProviderContext {
    projectRoot: string;
    session: string;
    onSynapseLaneReady?: (metadata: import("./memory/embedding-synapse").SynapseLaneMetadata) => void;
}
/**
 * Test factory for the embedding provider. It receives the same context the
 * real providers get, so a fake can invoke `onSynapseLaneReady` and drive the
 * deferred-lane resolution path (`commitPrimarySynapseLane` /
 * `commitShadowSynapseLane`) instead of a hand-rolled imitation of it.
 */
type TestProviderFactory = (config: EmbeddingConfig, context?: ProviderContext) => EmbeddingProvider | null;
export declare function contentSha256(value: string): string;
export interface StaleEmbeddingSweepResult {
    commitRowsDeleted: number;
    chunkRowsDeleted: number;
    trackingRowsDeleted: number;
}
export declare function sweepStaleEmbeddingIdentitiesForProject(db: Database, projectIdentity: string, now?: number): StaleEmbeddingSweepResult;
export declare function registerProjectEmbedding(db: Database, projectIdentity: string, config: EmbeddingConfig, features: EmbeddingFeatures, sourceDirectory: string): ProjectEmbeddingRegistrationSnapshot;
export declare function registerProjectShadowEmbedding(db: Database, projectIdentity: string, config: EmbeddingConfig, sourceDirectory: string): ProjectEmbeddingRegistrationSnapshot | null;
export interface ShadowEmbeddingMeasurementCohort {
    modelId: string;
    chunkModelId: string;
    fingerprint: string;
    epoch: number;
    dims: number;
}
export declare function getShadowEmbeddingMeasurementCohort(projectIdentity: string): ShadowEmbeddingMeasurementCohort | null;
export declare function getPrimaryEmbeddingMeasurementCohort(projectIdentity: string): ShadowEmbeddingMeasurementCohort | null;
export declare function embedShadowTextForProject(projectIdentity: string, text: string, signal?: AbortSignal): Promise<Float32Array | null>;
export declare function enqueueShadowEmbeddingItems(projectIdentity: string, scope: ShadowScope, ids: readonly string[]): void;
/** Outstanding shadow-backfill rows per scope, for progress/status reporting. */
export declare function getShadowBackfillRemaining(db: Database, projectIdentity: string): {
    commit: number;
    chunk: number;
};
/**
 * Drain the shadow queue and any pending historical backfills to completion.
 * Used by tests and the manual backfill script; the running plugin never calls
 * this (it relies on the self-restarting bounded worker). `onSettled` fires
 * after each bounded worker pass so callers can report progress.
 */
export declare function flushShadowEmbeddingBacklog(projectIdentity?: string, onSettled?: () => void | Promise<void>): Promise<void>;
/** Embed and persist one batch of commit rows for the primary lane, through
 *  versioned receipts when the provider journals pages and through the
 *  existing guarded transaction otherwise. Returns how many commits landed. */
export declare function embedCommitRowsForProject(db: Database, projectIdentity: string, rows: readonly {
    sha: string;
    message: string;
}[]): Promise<number>;
interface CompartmentWindowsApplication {
    compartmentId: number;
    sessionId: string;
    windows: readonly CompartmentChunkWindow[];
    /** Recompute the compartment's current windows inside the transaction;
     *  defaults to reloading its stored source. */
    currentWindows?: () => readonly CompartmentChunkWindow[];
}
/** Publish-path entry for one compartment's windows. Returns null when the
 *  primary lane has no durable page journal (caller uses its legacy path). */
export declare function embedCompartmentWindowsDetailedForProject(db: Database, projectIdentity: string, args: CompartmentWindowsApplication): Promise<boolean | null>;
export declare function registerProjectInObservationMode(db: Database, projectIdentity: string, sourceDirectory: string, failedConfig: EmbeddingConfig, failureSummary: string): ProjectEmbeddingRegistrationSnapshot;
export declare function unregisterProjectEmbedding(projectIdentity: string): void;
export declare function getProjectEmbeddingSnapshot(projectIdentity: string): ProjectEmbeddingRegistrationSnapshot | null;
export declare function getProjectChunkEmbeddingModelId(projectIdentity: string): string;
export declare function getProjectEmbeddingMaxInputTokens(projectIdentity: string): number;
export declare function getProjectEmbeddingMaxInputBytes(projectIdentity: string): number | undefined;
export declare function embedTextForProject(projectIdentity: string, text: string, signal?: AbortSignal, purpose?: EmbeddingPurpose): Promise<{
    vector: Float32Array;
    modelId: string;
    chunkModelId: string;
    generation: number;
} | null>;
export declare function embedBatchForProject(projectIdentity: string, texts: string[], signal?: AbortSignal, purpose?: EmbeddingPurpose): Promise<{
    vectors: (Float32Array | null)[];
    modelId: string;
    generation: number;
} | null>;
export declare function embedItemsForProject(projectIdentity: string, items: readonly {
    id: string;
    text: string;
    contentSha256: string;
}[], signal?: AbortSignal): Promise<{
    vectors: Map<string, Float32Array>;
    modelId: string;
    generation: number;
} | null>;
/**
 * Drain a project's unembedded-commit backlog, coordinated across processes.
 *
 * Drains pure backlogs (indexed commits with no embedding row). The dream-timer
 * git-sweep embeds new commits from `git log` but skips backlog drain when
 * `embedded=0`; this path runs after each sweep (ignoreCooldown lease) so
 * pre-existing backlogs clear. Every plugin process runs this
 * on its dream-timer tick, so without coordination N processes hammer the
 * embedding provider with the same commits. We take the shared git-sweep lease
 * (mutual exclusion) per identity — but with `ignoreCooldown`, because a
 * backlog must keep draining every tick until empty and must not be blocked by
 * the cooldown the dream-timer sweep advances. We release without marking
 * success so the two paths' cooldown tracking stays independent.
 */
export declare function drainCommitBacklogForProject(db: Database, projectIdentity: string, deadline: number): Promise<number>;
/** Passive missing-chunk drain for one project. `deadlineAt` is the shared
 *  wall-clock budget of the maintenance pass that invoked it — callers that
 *  iterate several projects must pass ONE deadline across all of them so a
 *  multi-project pass cannot outrun the caller's own schedule. */
export declare function embedUnembeddedCompartmentChunksForProject(db: Database, projectIdentity: string, deadlineAt?: number): Promise<number>;
export interface SessionChunkBackfillProgress {
    /** Compartments fully embedded so far this run. */
    embedded: number;
    /** Total compartments that needed embedding when the run started. */
    total: number;
}
export type SessionChunkBackfillOutcome = {
    status: "done";
    embedded: number;
    total: number;
    failed: number;
} | {
    status: "nothing";
    embedded: 0;
    total: 0;
} | {
    status: "disabled";
    embedded: 0;
    total: 0;
} | {
    status: "busy";
    embedded: 0;
    total: number;
} | {
    status: "aborted";
    embedded: number;
    total: number;
    failed: number;
} | {
    status: "stalled";
    embedded: number;
    total: number;
    remaining: number;
    failed: number;
};
/**
 * Backfill ALL un-embedded compartment chunks for ONE session in a single run
 * (the `/ctx-embed-history` command path), oldest-first so progress fills
 * chronologically. Unlike the passive project drain this has no per-sweep cap —
 * the user asked for the whole session — but it still runs under the per-project
 * embedding coordinator lease (mutual exclusion with the passive sweep + sibling
 * processes) and yields between batches so an 8-core local-inference burst stays
 * interruptible. Idempotent + resumable via chunk_hash; re-running embeds only
 * what's still missing.
 */
export declare function embedSessionCompartmentChunks(db: Database, projectIdentity: string, sessionId: string, options?: {
    signal?: AbortSignal;
    onProgress?: (p: SessionChunkBackfillProgress) => void;
    batchSize?: number;
}): Promise<SessionChunkBackfillOutcome>;
export interface EmbeddingCoverageStatus {
    /** Whether embedding is active at all for this project. */
    enabled: boolean;
    /** Friendly configured model name, or "off"/"disabled". */
    model: string;
    /** Configured provider kind ("local" / "openai-compatible" / "ollama" / "off"). */
    provider: string;
    /** This session's compartment-chunk coverage. */
    session: {
        embedded: number;
        total: number;
    };
    /** Project-wide git-commit coverage (only meaningful when gitEnabled). */
    commits: {
        embedded: number;
        total: number;
        gitEnabled: boolean;
    };
}
/**
 * The no-argument `/ctx-embed` status reports session and project git-commit
 * coverage for the active model. Pure reads — no provider calls.
 */
export declare function getEmbeddingCoverageStatus(db: Database, projectIdentity: string, sessionId: string): EmbeddingCoverageStatus;
export declare function sweepAllRegisteredProjects(db: Database): Promise<{
    commitsEmbedded: number;
    chunksEmbedded: number;
    perProject: Map<string, {
        commits: number;
        chunks: number;
    }>;
}>;
export declare function _setTestProviderFactoryForProject(factory: TestProviderFactory | null): void;
export declare function _resetProjectEmbeddingRegistryForTests(): void;
export {};
//# sourceMappingURL=project-embedding-registry.d.ts.map