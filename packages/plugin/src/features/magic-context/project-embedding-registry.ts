import { createHash, randomUUID } from "node:crypto";

import type { EmbeddingConfig } from "../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../config/schema/magic-context";
import { log } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    buildCanonicalChunkTextFromFts,
    buildCompartmentSummaryFallbackText,
    type CompartmentChunkBackfillCandidate,
    type CompartmentChunkWindow,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    countSessionCompartmentEmbedCoverage,
    countUnembeddedSessionCompartments,
    deleteCompartmentChunkEmbeddingsForModel,
    getExistingChunkHashes,
    loadUnembeddedCompartmentChunkCandidates,
    loadUnembeddedSessionChunkCandidates,
    normalizeCompartmentChunkMaxInputTokens,
    replaceCompartmentChunkEmbeddings,
    type SaveCompartmentChunkEmbeddingInput,
} from "./compartment-chunk-embedding";
import {
    countEmbeddedCommits,
    hasCommitEmbedding,
    loadUnembeddedCommits,
    saveCommitEmbedding,
} from "./git-commits/storage-git-commit-embeddings";
import { getCommitCount } from "./git-commits/storage-git-commits";
import {
    acquireGitSweepLease,
    releaseGitSweepLease,
    renewGitSweepLease,
} from "./git-commits/sweep-coordinator";
import { getEmbeddingProviderIdentity } from "./memory/embedding-identity";
import { LocalEmbeddingProvider } from "./memory/embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./memory/embedding-openai";
import type {
    DetailedEmbedContext,
    DetailedEmbedItem,
    EmbeddingPageReceipt,
    EmbeddingProvider,
    EmbeddingPurpose,
} from "./memory/embedding-provider";
import {
    normalizeSynapseTokenBudget,
    SYNAPSE_DEFAULT_BATCH_TIMEOUT_MS,
    SYNAPSE_MAX_INPUT_BYTES,
    SYNAPSE_MAX_INPUT_TOKENS,
    SynapseEmbeddingProvider,
} from "./memory/embedding-synapse";
import {
    recordSessionProjectIdentity,
    repairMisScopedCompartmentChunkEmbeddingsForProject,
} from "./session-project-storage";
import {
    applySynapseReceiptGroup,
    pruneSynapseBatchLedgerForProject,
    reopenCompleteSynapseLedgerGroupWithProof,
} from "./storage-embedding-measurements";

const OFF_PROVIDER_IDENTITY = "embedding-provider:off";
const SWEEP_MAX_WALL_CLOCK_MS = 10 * 60 * 1000;
// The commit drain processes multiple batches while it holds the coordinator lease.
// The per-sweep caps prevent one project from monopolizing the provider.
const COMMIT_DRAIN_BATCH_SIZE = 16;
const COMMIT_DRAIN_MAX_PER_SWEEP = 500;
const CHUNK_DRAIN_BATCH_SIZE = 8;
const CHUNK_DRAIN_MAX_PER_SWEEP = 200;
const EMBEDDING_IDENTITY_GC_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const STALE_EMBEDDING_GC_BATCH_SIZE = 250;
// Each embedding window contains at most `max_input_tokens`, so limiting windows also limits tokens per request.
// Compartments are never split across provider calls.
// A compartment with more than 2 windows is sent in one over-cap provider call.
const MAX_WINDOWS_PER_EMBED_CALL = 2;
// Session backfill can outlive the coordinator lease TTL.
// Session backfill renews the coordinator lease every 60 seconds.
const SESSION_EMBED_LEASE_RENEWAL_MS = 60 * 1000;
// The provider returns `null` or all-null vectors instead of throwing.
// These retry constants control when the drain stops, not HTTP retries.
// The drain makes up to 3 attempts for an all-null provider result with 250 ms base backoff.
// The drain records a compartment as failed when all 3 attempts produce no usable vectors.
// The drain excludes failed compartments so the oldest-first cursor can advance.
// Failed compartments remain eligible for a future drain.
// The drain stops after 3 consecutive all-failed batches.
const EMBED_SLICE_RETRY_ATTEMPTS = 3;
const EMBED_SLICE_RETRY_BASE_MS = 250;
// The drain treats a failed provider call lasting at least 10,000 ms as a timeout.
// The drain does not retry timeout-classified failures.
const EMBED_SLOW_FAILURE_NO_RETRY_MS = 10_000;
const MAX_CONSECUTIVE_FAILED_BATCHES = 3;

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
    /** `model` stores the friendly configured model name, such as "text-embedding-qwen3-embedding-4b".
     * `model` is "off" when no provider is configured or observation mode is enabled. */
    model: string;
    /** `provider` stores the configured provider kind, such as "openai-compatible", "local", or "ollama". */
    provider: string;
}

interface ProjectEmbeddingRegistration {
    db: Database;
    projectIdentity: string;
    sourceDirectory: string;
    config: EmbeddingConfig;
    providerIdentity: string;
    runtimeFingerprint: string;
    provider: EmbeddingProvider | null;
    generation: number;
    features: EmbeddingFeatures;
    modelId: string;
    chunkModelId: string;
    observationMode: boolean;
    /**
     * `deferredIntent` fingerprints the DEFERRED configuration that created this registration.
     * `deferredIntent` survives lane resolution.
     * Resolving a lane rewrites `config`, `providerIdentity`, and `runtimeFingerprint` to the discovered lane.
     * Without `deferredIntent`, a registration from the unchanged configuration appears to have different intent.
     * The differing intent discards a healthy resolved provider.
     */
    deferredIntent?: string;
}

interface StaleIdentityRow {
    modelId: string;
}

const projectRegistrations = new Map<string, ProjectEmbeddingRegistration>();

interface ShadowEmbeddingRegistration {
    db: Database;
    projectIdentity: string;
    sourceDirectory: string;
    config: EmbeddingConfig;
    provider: EmbeddingProvider;
    providerIdentity: string;
    modelId: string;
    chunkModelId: string;
    generation: number;
    /** `ShadowEmbeddingRegistration.deferredIntent` has the same lane-resolution semantics as `ProjectEmbeddingRegistration.deferredIntent`. */
    deferredIntent?: string;
}

type ShadowScope = "commit" | "chunk";

type EmbeddingIdentityScope = ShadowScope;
interface ShadowQueueItem {
    projectIdentity: string;
    scope: ShadowScope;
    ids: string[];
}

const shadowRegistrations = new Map<string, ShadowEmbeddingRegistration>();
const shadowQueue: ShadowQueueItem[] = [];
let shadowWorker: Promise<void> | null = null;
const SHADOW_MAX_ITEMS_PER_TICK = 64;
const SHADOW_MAX_BYTES_PER_TICK = 512 * 1024;
const SHADOW_MAX_WALL_CLOCK_MS = 2_000;

/**
 * Shadow scopes owe a historical backfill for the project.
 * Fingerprint rotation assigns the shadow lane a new `modelId`.
 * Rows embedded by the primary lane have no counterpart under the new identity.
 * The backfill marks affected scopes instead of processing the whole corpus in one transaction.
 * `pumpShadowBackfill` drains each affected scope in bounded chunks per tick.
 * A scope drops out once its missing set is empty.
 */
const pendingShadowBackfills = new Map<string, Set<ShadowScope>>();
/**
 * `pumpShadowBackfill` stops a scope when consecutive pumps enqueue the same missing-ID set; progress clears the stall.
 * Stalling prevents the worker from hot-looping after a batch makes no progress.
 */
const shadowBackfillLastIds = new Map<string, string>();
/* */
const shadowBackfillStopReasons = new Map<string, ShadowBackfillStopReason>();
export type ShadowBackfillStopReason = "drained" | "stalled_no_progress";

/* */
export function getShadowBackfillStopReason(
    projectIdentity: string,
    scope: "commit" | "chunk",
): ShadowBackfillStopReason | undefined {
    return shadowBackfillStopReasons.get(`${projectIdentity}:${scope}`);
}

const upsertActiveIdentityStatements = new WeakMap<Database, PreparedStatement>();
const backfillActiveIdentityStatements = new Map<
    EmbeddingIdentityScope,
    WeakMap<Database, PreparedStatement>
>();
const staleIdentityStatements = new Map<
    EmbeddingIdentityScope,
    WeakMap<Database, PreparedStatement>
>();
const deleteActiveIdentityStatements = new WeakMap<Database, PreparedStatement>();
let globalRegistrationGeneration = 0;

/**
 * Untrusted loads retain the last-known-good provider and suppress stale-identity GC; trusted registration clears the latch.
 * Untrusted loads include parse or I/O errors, unmigrated legacy config, and embedding-affecting substitution or recovery failures.
 * While latched, a project serves its last-known-good provider for reads and writes and suppresses stale-identity GC.
 * Untrusted loads must not delete embedding rows.
 */
const untrustedLoadProjects = new Set<string>();

/** Latch a project loaded from an untrusted config to suppress GC. */
export function markProjectLoadUntrusted(projectIdentity: string): void {
    untrustedLoadProjects.add(projectIdentity);
}
let projectSweepInProgress = false;
/** `createProvider` passes this context to every provider. */
interface ProviderContext {
    projectRoot: string;
    session: string;
    onSynapseLaneReady?: (
        metadata: import("./memory/embedding-synapse").SynapseLaneMetadata,
    ) => void;
}
/**
 * The test factory receives the same context as `createProvider`.
 * Test doubles receive the same context as real providers, so they can invoke `onSynapseLaneReady`.
 * Test doubles can drive deferred-lane resolution through `commitPrimarySynapseLane` and `commitShadowSynapseLane`.
 */
type TestProviderFactory = (
    config: EmbeddingConfig,
    context?: ProviderContext,
) => EmbeddingProvider | null;
let testProviderFactory: TestProviderFactory | null = null;

function synapseConfigFields(config: EmbeddingConfig): {
    model?: string;
    fingerprint?: string;
    tableEpoch?: number;
    dims?: number;
    provenance?: unknown;
} {
    // SAFETY: The function accesses config only through Record<string, unknown>.
    const raw = config as unknown as Record<string, unknown>;
    return {
        ...(typeof raw.model === "string" ? { model: raw.model } : {}),
        ...(typeof raw.synapse_fingerprint === "string"
            ? { fingerprint: raw.synapse_fingerprint }
            : {}),
        ...(typeof raw.synapse_table_epoch === "number"
            ? { tableEpoch: raw.synapse_table_epoch }
            : {}),
        ...(typeof raw.synapse_dims === "number" ? { dims: raw.synapse_dims } : {}),
        ...(raw.synapse_provenance !== undefined ? { provenance: raw.synapse_provenance } : {}),
    };
}

type SynapseRuntimeConfig = EmbeddingConfig & {
    model?: string;
    max_input_tokens?: number;
    synapse_max_input_bytes?: number;
    synapse_connection_file?: string;
    synapse_connection_origin?: "managed-default" | "explicit" | "injected";
    synapse_client_factory?: () => Promise<import("./memory/embedding-synapse").SynapseClientLike>;
    synapse_fallback?: EmbeddingConfig;
    synapse_fingerprint?: string;
    synapse_table_epoch?: number;
    synapse_dims?: number;
    synapse_recommended_batch?: number;
    synapse_recommended_token_budget?: number;
    synapse_provenance?: unknown;
};

function isDeferredSynapseConfig(config: EmbeddingConfig): config is SynapseRuntimeConfig {
    return config.provider === "synapse" && !synapseConfigFields(config).fingerprint;
}

/**
 * The function returns a provider's lane discovery state, or `undefined` when the provider does not report one.
 * The function reads structurally so test doubles and non-Synapse providers can decline to report a state.
 * Structural reads prevent nonreporting providers from being misread as pending.
 * Misreading a nonreporting provider as pending would preserve a lane that can never resolve.
 */
function synapseLaneDiscoveryState(
    provider: EmbeddingProvider,
): "pending" | "resolved" | "failed" | undefined {
    const state = (provider as { laneDiscoveryState?: unknown }).laneDiscoveryState;
    return state === "pending" || state === "resolved" || state === "failed" ? state : undefined;
}

function persistPrimaryDescriptor(db: Database, registration: ProjectEmbeddingRegistration): void {
    const descriptorTable = db
        .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'embedding_registrations'",
        )
        .get();
    if (!descriptorTable) return;
    const fields = synapseConfigFields(registration.config);
    db.prepare(
        `INSERT INTO embedding_registrations
            (project_path, provider_identity, model_id, chunk_model_id, fingerprint, table_epoch, dims, provenance_json, generation, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_path) DO UPDATE SET
            provider_identity = excluded.provider_identity,
            model_id = excluded.model_id,
            chunk_model_id = excluded.chunk_model_id,
            fingerprint = excluded.fingerprint,
            table_epoch = excluded.table_epoch,
            dims = excluded.dims,
            provenance_json = excluded.provenance_json,
            generation = excluded.generation,
            updated_at = excluded.updated_at`,
    ).run(
        registration.projectIdentity,
        registration.providerIdentity,
        registration.modelId,
        registration.chunkModelId,
        fields.fingerprint ?? "",
        fields.tableEpoch ?? 0,
        fields.dims ?? 0,
        JSON.stringify(fields.provenance ?? {}),
        registration.generation,
        Date.now(),
    );
}

function persistShadowDescriptor(db: Database, registration: ShadowEmbeddingRegistration): void {
    const descriptorTable = db
        .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'shadow_embedding_registrations'",
        )
        .get();
    if (!descriptorTable) return;
    const fields = synapseConfigFields(registration.config);
    const now = Date.now();
    const upsert = db.prepare(
        `INSERT INTO shadow_embedding_registrations
            (project_path, scope, model_id, generation, fingerprint, table_epoch, dims, provenance_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_path, scope, model_id) DO UPDATE SET
            generation = excluded.generation,
            fingerprint = excluded.fingerprint,
            table_epoch = excluded.table_epoch,
            dims = excluded.dims,
            provenance_json = excluded.provenance_json,
            updated_at = excluded.updated_at`,
    );
    const scopedModels = [
        ["memory", registration.modelId],
        ["commit", registration.modelId],
        ["chunk", registration.chunkModelId],
    ] as const;
    for (const [scope, modelId] of scopedModels) {
        upsert.run(
            registration.projectIdentity,
            scope,
            modelId,
            registration.generation,
            fields.fingerprint ?? "",
            fields.tableEpoch ?? 0,
            fields.dims ?? 0,
            JSON.stringify(fields.provenance ?? {}),
            now,
        );
    }
}

function clearDeferredDescriptor(
    db: Database,
    table: "embedding_registrations" | "shadow_embedding_registrations",
    projectIdentity: string,
): void {
    const present = db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
    if (!present) return;
    db.prepare(`DELETE FROM ${table} WHERE project_path = ?`).run(projectIdentity);
}

function resolvedSynapseConfigFromMetadata(
    config: SynapseRuntimeConfig,
    metadata: import("./memory/embedding-synapse").SynapseLaneMetadata,
): EmbeddingConfig {
    return resolveEmbeddingConfig({
        ...config,
        model: metadata.model,
        synapse_fingerprint: metadata.fingerprint,
        synapse_table_epoch: metadata.table_epoch,
        synapse_dims: metadata.dims,
        ...(metadata.recommended_batch
            ? { synapse_recommended_batch: metadata.recommended_batch }
            : {}),
        ...(metadata.recommended_token_budget
            ? { synapse_recommended_token_budget: metadata.recommended_token_budget }
            : {}),
        ...(metadata.max_input_tokens ? { max_input_tokens: metadata.max_input_tokens } : {}),
        ...(metadata.max_input_bytes ? { synapse_max_input_bytes: metadata.max_input_bytes } : {}),
        ...(metadata.provenance !== undefined ? { synapse_provenance: metadata.provenance } : {}),
    } as unknown as EmbeddingConfig);
}

/**
 * Adopt a newly resolved primary identity onto the registration and persist it
 * (active-identity rows + primary descriptor) in one transaction.
 */
function adoptPrimaryIdentity(
    registration: ProjectEmbeddingRegistration,
    config: EmbeddingConfig,
    providerIdentity: string,
    chunkModelId: string,
    modelIds: { modelId: string; chunkModelId: string },
): void {
    registration.config = config;
    registration.providerIdentity = providerIdentity;
    registration.runtimeFingerprint = getRuntimeFingerprint(config);
    registration.modelId = modelIds.modelId;
    registration.chunkModelId = modelIds.chunkModelId;
    registration.generation = ++globalRegistrationGeneration;
    registration.db.transaction(() => {
        recordActiveEmbeddingIdentityInCurrentTransaction(
            registration.db,
            registration.projectIdentity,
            providerIdentity,
            chunkModelId,
            registration.features,
        );
        persistPrimaryDescriptor(registration.db, registration);
    })();
}

function commitPrimarySynapseLane(
    registration: ProjectEmbeddingRegistration,
    metadata: import("./memory/embedding-synapse").SynapseLaneMetadata,
): void {
    if (
        projectRegistrations.get(registration.projectIdentity) !== registration ||
        registration.config.provider !== "synapse"
    ) {
        return;
    }
    const config = resolvedSynapseConfigFromMetadata(
        registration.config as SynapseRuntimeConfig,
        metadata,
    );
    const providerIdentity = getEmbeddingProviderIdentity(config);
    const chunkModelId = getChunkEmbeddingModelId(config, providerIdentity);
    const runtimeFingerprint = getRuntimeFingerprint(config);
    // A rebind initializes the replacement daemon and invokes `onSynapseLaneReady` again.
    // `onSynapseLaneReady` fires again with unchanged pinned metadata.
    // A lane that fails the generation check discards vectors produced before the rebind.
    // The rebind republishes only changed pinned metadata.
    // Re-registering an unchanged config keeps `generation` unchanged.
    const identityUnchanged =
        registration.providerIdentity === providerIdentity &&
        registration.chunkModelId === chunkModelId &&
        registration.runtimeFingerprint === runtimeFingerprint;
    registration.config = config;
    registration.providerIdentity = providerIdentity;
    registration.runtimeFingerprint = runtimeFingerprint;
    registration.modelId = providerIdentity;
    registration.chunkModelId = chunkModelId;
    if (!identityUnchanged) {
        registration.generation = ++globalRegistrationGeneration;
    }
    registration.db.transaction(() => {
        recordActiveEmbeddingIdentityInCurrentTransaction(
            registration.db,
            registration.projectIdentity,
            providerIdentity,
            chunkModelId,
            registration.features,
        );
        persistPrimaryDescriptor(registration.db, registration);
    })();
}

function activatePrimarySynapseFallback(registration: ProjectEmbeddingRegistration): boolean {
    if (
        projectRegistrations.get(registration.projectIdentity) !== registration ||
        !isDeferredSynapseConfig(registration.config)
    ) {
        return false;
    }
    const fallback = registration.config.synapse_fallback;
    if (!fallback) return false;
    const config = resolveEmbeddingConfig(fallback);
    const providerIdentity = getEmbeddingProviderIdentity(config);
    const chunkModelId = getChunkEmbeddingModelId(config, providerIdentity);
    const previousProvider = registration.provider;
    registration.provider = null;
    adoptPrimaryIdentity(registration, config, providerIdentity, chunkModelId, {
        modelId: providerIdentity === OFF_PROVIDER_IDENTITY ? "off" : providerIdentity,
        chunkModelId: providerIdentity === OFF_PROVIDER_IDENTITY ? "off" : chunkModelId,
    });
    disposeProvider(previousProvider);
    return true;
}

function commitShadowSynapseLane(
    registration: ShadowEmbeddingRegistration,
    metadata: import("./memory/embedding-synapse").SynapseLaneMetadata,
): void {
    if (shadowRegistrations.get(registration.projectIdentity) !== registration) return;
    const config = resolvedSynapseConfigFromMetadata(
        registration.config as SynapseRuntimeConfig,
        metadata,
    );
    const providerIdentity = getEmbeddingProviderIdentity(config);
    registration.config = config;
    registration.providerIdentity = providerIdentity;
    registration.modelId = providerIdentity;
    registration.chunkModelId = getChunkEmbeddingModelId(config, providerIdentity);
    registration.generation = ++globalRegistrationGeneration;
    registration.db.transaction(() => {
        const now = Date.now();
        recordScopeActiveIdentity(
            registration.db,
            registration.projectIdentity,
            "commit",
            registration.modelId,
            now,
        );
        recordScopeActiveIdentity(
            registration.db,
            registration.projectIdentity,
            "chunk",
            registration.chunkModelId,
            now,
        );
        persistShadowDescriptor(registration.db, registration);
    })();
    maybeArmShadowBackfill(registration.db, registration.projectIdentity, registration);
}

function resolveEmbeddingConfig(config?: EmbeddingConfig): EmbeddingConfig {
    if (!config || config.provider === "local") {
        return {
            provider: "local",
            model: config?.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
            ...(config?.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
            // local_dtype is spread CONDITIONALLY to preserve the byte-identical
            // default identity when unset (mirrors the schema transform). Only
            // a user-configured dtype survives normalization and reaches the
            // provider + identity hash.
            ...(config?.local_dtype ? { local_dtype: config.local_dtype } : {}),
        };
    }

    if (config.provider === "openai-compatible") {
        const apiKey = config.api_key?.trim();
        const inputType = config.input_type?.trim();
        const queryInputType = config.query_input_type?.trim();
        const truncate = config.truncate?.trim();
        return {
            provider: "openai-compatible",
            model: config.model.trim(),
            endpoint: config.endpoint.trim(),
            ...(apiKey ? { api_key: apiKey } : {}),
            // Preserve input_type and truncate through normalization because both affect provider requests and config identity.
            // Exclude query_input_type from identity because stored vectors use passage input.
            ...(inputType ? { input_type: inputType } : {}),
            ...(queryInputType ? { query_input_type: queryInputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(config.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
        };
    }

    if (config.provider === "off") {
        return { provider: "off" };
    }

    if (config.provider === "synapse") {
        const synapse = config as SynapseRuntimeConfig;
        const tokenBudget = normalizeSynapseTokenBudget(synapse.synapse_recommended_token_budget);
        return {
            provider: "synapse",
            model: synapse.model?.trim() || "gte-modernbert-base-f16",
            max_input_tokens:
                typeof synapse.max_input_tokens === "number" &&
                Number.isInteger(synapse.max_input_tokens) &&
                synapse.max_input_tokens > 0
                    ? synapse.max_input_tokens
                    : SYNAPSE_MAX_INPUT_TOKENS,
            synapse_max_input_bytes:
                typeof synapse.synapse_max_input_bytes === "number" &&
                Number.isInteger(synapse.synapse_max_input_bytes) &&
                synapse.synapse_max_input_bytes >= 4
                    ? synapse.synapse_max_input_bytes
                    : SYNAPSE_MAX_INPUT_BYTES,
            ...(synapse.synapse_connection_file
                ? { synapse_connection_file: synapse.synapse_connection_file }
                : {}),
            ...(synapse.synapse_connection_origin
                ? { synapse_connection_origin: synapse.synapse_connection_origin }
                : {}),
            ...(synapse.synapse_client_factory
                ? { synapse_client_factory: synapse.synapse_client_factory }
                : {}),
            ...(synapse.synapse_fallback ? { synapse_fallback: synapse.synapse_fallback } : {}),
            ...(synapse.synapse_fingerprint
                ? { synapse_fingerprint: synapse.synapse_fingerprint }
                : {}),
            ...(typeof synapse.synapse_table_epoch === "number"
                ? { synapse_table_epoch: synapse.synapse_table_epoch }
                : {}),
            ...(typeof synapse.synapse_dims === "number"
                ? { synapse_dims: synapse.synapse_dims }
                : {}),
            ...(typeof synapse.synapse_recommended_batch === "number"
                ? { synapse_recommended_batch: synapse.synapse_recommended_batch }
                : {}),
            ...(tokenBudget !== undefined ? { synapse_recommended_token_budget: tokenBudget } : {}),
            ...(synapse.synapse_provenance !== undefined
                ? { synapse_provenance: synapse.synapse_provenance }
                : {}),
        } as EmbeddingConfig;
    }

    throw new Error("Unknown embedding provider");
}

function createProvider(
    config: EmbeddingConfig,
    context?: ProviderContext,
): EmbeddingProvider | null {
    if (testProviderFactory) {
        return testProviderFactory(config, context);
    }

    if (config.provider === "off") {
        return null;
    }

    if (config.provider === "openai-compatible") {
        return new OpenAICompatibleEmbeddingProvider({
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.api_key,
            inputType: config.input_type,
            queryInputType: config.query_input_type,
            truncate: config.truncate,
            maxInputTokens: config.max_input_tokens,
        });
    }

    if (config.provider === "local") {
        return new LocalEmbeddingProvider(
            config.model,
            config.max_input_tokens,
            config.local_dtype,
        );
    }

    if (config.provider === "synapse") {
        const synapse = config as SynapseRuntimeConfig;
        return new SynapseEmbeddingProvider({
            ...(synapse.synapse_connection_file
                ? { connectionFile: synapse.synapse_connection_file }
                : {}),
            connectionOrigin: synapse.synapse_connection_origin,
            projectRoot: context?.projectRoot ?? "",
            session: context?.session ?? "embedding",
            model: synapse.model,
            fingerprint: synapse.synapse_fingerprint,
            tableEpoch: synapse.synapse_table_epoch,
            dims: synapse.synapse_dims,
            recommendedBatch: synapse.synapse_recommended_batch,
            recommendedTokenBudget: normalizeSynapseTokenBudget(
                synapse.synapse_recommended_token_budget,
            ),
            maxInputTokens: synapse.max_input_tokens,
            maxInputBytes: synapse.synapse_max_input_bytes,
            provenance: synapse.synapse_provenance,
            clientFactory: synapse.synapse_client_factory,
            onLaneReady: context?.onSynapseLaneReady,
        });
    }

    throw new Error("Unknown embedding provider");
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
        );
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function sha256Prefix(value: string, length = 16): string {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function contentSha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function getRuntimeFingerprint(config: EmbeddingConfig): string {
    if (config.provider === "off") {
        return OFF_PROVIDER_IDENTITY;
    }
    return `${getEmbeddingProviderIdentity(config)}:${sha256Prefix(stableStringify(config))}`;
}

function getChunkEmbeddingModelId(config: EmbeddingConfig, providerIdentity: string): string {
    if (config.provider === "off") {
        return OFF_PROVIDER_IDENTITY;
    }
    // Chunk identity includes the provider vector space and exact windowing.
    // Memory and commit vectors use only providerIdentity so chunk-window changes do not invalidate them.
    const chunkIdentity = {
        providerIdentity,
        // v3 includes Synapse's advertised UTF-8 byte ceiling.
        // Providers without a byte cap retain v2 identity to avoid no-op re-embedding.
        chunkerVersion: config.provider === "synapse" ? 3 : 2,
        maxInputTokens: normalizeCompartmentChunkMaxInputTokens(
            "max_input_tokens" in config ? config.max_input_tokens : undefined,
        ),
        maxInputBytes:
            config.provider === "synapse" && "synapse_max_input_bytes" in config
                ? config.synapse_max_input_bytes
                : undefined,
        truncate: config.provider === "openai-compatible" ? (config.truncate ?? "") : "",
    };
    return `${providerIdentity}:chunk:${sha256Prefix(stableStringify(chunkIdentity))}`;
}

function sameFeatures(a: EmbeddingFeatures, b: EmbeddingFeatures): boolean {
    return a.memoryEnabled === b.memoryEnabled && a.gitCommitEnabled === b.gitCommitEnabled;
}

function snapshotFor(
    registration: ProjectEmbeddingRegistration,
): ProjectEmbeddingRegistrationSnapshot {
    // Enablement follows the configured provider, not the resolved identity:
    // a deferred Synapse lane carries OFF_PROVIDER_IDENTITY until first use,
    // The lane must remain enabled so its embed entry points can resolve the lane and activate its fallback.
    // getOrCreateProjectProvider enables providers from the configured provider rather than the resolved identity.
    // `snapshotFor` enables providers from the configured provider rather than the resolved identity.
    const providerIsOn = (registration.config.provider ?? "local") !== "off";
    const enabled =
        !registration.observationMode && providerIsOn && registration.features.memoryEnabled;
    const gitCommitEnabled =
        !registration.observationMode && providerIsOn && registration.features.gitCommitEnabled;
    const configuredModel =
        "model" in registration.config && typeof registration.config.model === "string"
            ? registration.config.model.trim()
            : "";
    return {
        projectIdentity: registration.projectIdentity,
        sourceDirectory: registration.sourceDirectory,
        providerIdentity: registration.providerIdentity,
        runtimeFingerprint: registration.runtimeFingerprint,
        generation: registration.generation,
        features: { ...registration.features },
        enabled,
        gitCommitEnabled,
        modelId: registration.observationMode || !providerIsOn ? "off" : registration.modelId,
        chunkModelId:
            registration.observationMode || !providerIsOn ? "off" : registration.chunkModelId,
        model:
            registration.observationMode || !providerIsOn
                ? "off"
                : configuredModel
                  ? configuredModel
                  : registration.modelId,
        provider:
            registration.observationMode || !providerIsOn
                ? "off"
                : (registration.config.provider ?? "local"),
    };
}

function disposeProvider(provider: EmbeddingProvider | null): void {
    if (!provider) return;
    void provider.dispose().catch((error) => {
        log("[magic-context] embedding provider dispose failed:", error);
    });
}

function getUpsertActiveIdentityStatement(db: Database): PreparedStatement {
    let stmt = upsertActiveIdentityStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO embedding_identity_active (project_path, scope, model_id, last_active_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(project_path, scope, model_id) DO UPDATE SET
                 last_active_at = excluded.last_active_at`,
        );
        upsertActiveIdentityStatements.set(db, stmt);
    }
    return stmt;
}

function statementMapFor<T extends string>(
    maps: Map<T, WeakMap<Database, PreparedStatement>>,
    key: T,
): WeakMap<Database, PreparedStatement> {
    let map = maps.get(key);
    if (!map) {
        map = new WeakMap<Database, PreparedStatement>();
        maps.set(key, map);
    }
    return map;
}

function getBackfillActiveIdentityStatement(
    db: Database,
    scope: EmbeddingIdentityScope,
): PreparedStatement {
    const map = statementMapFor(backfillActiveIdentityStatements, scope);
    let stmt = map.get(db);
    if (!stmt) {
        const selectByScope: Record<EmbeddingIdentityScope, string> = {
            commit: `SELECT DISTINCT e.model_id AS model_id
                     FROM git_commit_embeddings e
                     JOIN git_commits c ON c.sha = e.sha
                     WHERE c.project_path = ?`,
            chunk: `SELECT DISTINCT e.model_id AS model_id
                    FROM compartment_chunk_embeddings e
                    WHERE e.project_path = ?`,
        };
        stmt = db.prepare(
            `INSERT OR IGNORE INTO embedding_identity_active (project_path, scope, model_id, last_active_at)
             SELECT ?, ?, model_id, ?
             FROM (${selectByScope[scope]})
             WHERE model_id IS NOT NULL`,
        );
        map.set(db, stmt);
    }
    return stmt;
}

function recordScopeActiveIdentity(
    db: Database,
    projectIdentity: string,
    scope: EmbeddingIdentityScope,
    modelId: string,
    now: number,
): void {
    getUpsertActiveIdentityStatement(db).run(projectIdentity, scope, modelId, now);
    getBackfillActiveIdentityStatement(db, scope).run(projectIdentity, scope, now, projectIdentity);
}

function recordActiveEmbeddingIdentity(
    db: Database,
    projectIdentity: string,
    currentProviderIdentity: string,
    currentChunkIdentity: string,
    features: EmbeddingFeatures,
): void {
    if (currentProviderIdentity === OFF_PROVIDER_IDENTITY) {
        return;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
        recordActiveEmbeddingIdentityInCurrentTransaction(
            db,
            projectIdentity,
            currentProviderIdentity,
            currentChunkIdentity,
            features,
        );
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // The transaction may already be closed by SQLite after a fatal error.
        }
        throw error;
    }
}

function recordActiveEmbeddingIdentityInCurrentTransaction(
    db: Database,
    projectIdentity: string,
    currentProviderIdentity: string,
    currentChunkIdentity: string,
    features: EmbeddingFeatures,
): void {
    if (currentProviderIdentity === OFF_PROVIDER_IDENTITY) return;
    const now = Date.now();
    if (features.gitCommitEnabled) {
        recordScopeActiveIdentity(db, projectIdentity, "commit", currentProviderIdentity, now);
    }
    if (features.memoryEnabled) {
        repairMisScopedCompartmentChunkEmbeddingsForProject(db, projectIdentity);
        recordScopeActiveIdentity(db, projectIdentity, "chunk", currentChunkIdentity, now);
    }
}

function getStaleIdentityStatement(db: Database, scope: EmbeddingIdentityScope): PreparedStatement {
    const map = statementMapFor(staleIdentityStatements, scope);
    let stmt = map.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT model_id AS modelId
             FROM embedding_identity_active
             WHERE project_path = ?
               AND scope = ?
               AND model_id <> ?
               AND last_active_at < ?`,
        );
        map.set(db, stmt);
    }
    return stmt;
}

function getDeleteActiveIdentityStatement(db: Database): PreparedStatement {
    let stmt = deleteActiveIdentityStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `DELETE FROM embedding_identity_active
             WHERE project_path = ? AND scope = ? AND model_id = ?`,
        );
        deleteActiveIdentityStatements.set(db, stmt);
    }
    return stmt;
}

function staleModelsForScope(
    db: Database,
    projectIdentity: string,
    scope: EmbeddingIdentityScope,
    currentModelId: string,
    cutoff: number,
    protectedModelIds: ReadonlySet<string> = new Set([currentModelId]),
): string[] {
    const rows = getStaleIdentityStatement(db, scope).all(
        projectIdentity,
        scope,
        currentModelId,
        cutoff,
    ) as StaleIdentityRow[];
    return rows
        .map((row) => row.modelId)
        .filter((modelId) => typeof modelId === "string" && !protectedModelIds.has(modelId));
}

export interface StaleEmbeddingSweepResult {
    commitRowsDeleted: number;
    chunkRowsDeleted: number;
    trackingRowsDeleted: number;
}

function deleteStaleEmbeddingBatch(
    db: Database,
    scope: EmbeddingIdentityScope,
    projectIdentity: string,
    modelId: string,
    limit: number,
): number {
    if (scope === "commit") {
        return db
            .prepare(
                `DELETE FROM git_commit_embeddings
                 WHERE rowid IN (
                     SELECT gce.rowid
                     FROM git_commit_embeddings gce
                     JOIN git_commits gc ON gc.sha = gce.sha
                     WHERE gc.project_path = ? AND gce.model_id = ?
                     LIMIT ?
                 )`,
            )
            .run(projectIdentity, modelId, limit).changes;
    }
    return db
        .prepare(
            `DELETE FROM compartment_chunk_embeddings
             WHERE id IN (
                 SELECT id
                 FROM compartment_chunk_embeddings
                 WHERE project_path = ? AND model_id = ?
                 LIMIT ?
             )`,
        )
        .run(projectIdentity, modelId, limit).changes;
}

function hasStaleEmbeddingRows(
    db: Database,
    scope: EmbeddingIdentityScope,
    projectIdentity: string,
    modelId: string,
): boolean {
    if (scope === "commit") {
        return Boolean(
            db
                .prepare(
                    `SELECT 1
                     FROM git_commit_embeddings gce
                     JOIN git_commits gc ON gc.sha = gce.sha
                     WHERE gc.project_path = ? AND gce.model_id = ?
                     LIMIT 1`,
                )
                .get(projectIdentity, modelId),
        );
    }
    return Boolean(
        db
            .prepare(
                `SELECT 1
                 FROM compartment_chunk_embeddings
                 WHERE project_path = ? AND model_id = ?
                 LIMIT 1`,
            )
            .get(projectIdentity, modelId),
    );
}

export function sweepStaleEmbeddingIdentitiesForProject(
    db: Database,
    projectIdentity: string,
    now = Date.now(),
): StaleEmbeddingSweepResult {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    const result: StaleEmbeddingSweepResult = {
        commitRowsDeleted: 0,
        chunkRowsDeleted: 0,
        trackingRowsDeleted: 0,
    };
    if (!snapshot) return result;

    // GC skips vector deletion after a degraded or untrusted config load until a trusted registration.
    // Without this guard, GC uses a last-known-good registration when the on-disk config is broken.
    // A trusted registration clears untrustedLoadProjects for projectIdentity.
    if (untrustedLoadProjects.has(projectIdentity)) return result;

    const cutoff = now - EMBEDDING_IDENTITY_GC_GRACE_MS;
    const deleteTracking = getDeleteActiveIdentityStatement(db);
    const shadow = shadowRegistrations.get(projectIdentity);
    const protectedModels = {
        commit: new Set([snapshot.modelId, ...(shadow ? [shadow.modelId] : [])]),
        chunk: new Set([snapshot.chunkModelId, ...(shadow ? [shadow.chunkModelId] : [])]),
    };
    const scopes: Array<{
        scope: EmbeddingIdentityScope;
        enabled: boolean;
        currentModelId: string;
    }> = [
        {
            scope: "commit",
            enabled: snapshot.gitCommitEnabled && snapshot.modelId !== "off",
            currentModelId: snapshot.modelId,
        },
        {
            scope: "chunk",
            enabled: snapshot.enabled && snapshot.chunkModelId !== "off",
            currentModelId: snapshot.chunkModelId,
        },
    ];

    // Each invocation deletes one bounded batch and retains the stale identity until its final vector is deleted, letting later timer ticks resume without a long-held writer lock.
    let remainingBudget = STALE_EMBEDDING_GC_BATCH_SIZE;
    db.exec("BEGIN IMMEDIATE");
    try {
        for (const { scope, enabled, currentModelId } of scopes) {
            if (!enabled || remainingBudget === 0) continue;
            for (const modelId of staleModelsForScope(
                db,
                projectIdentity,
                scope,
                currentModelId,
                cutoff,
                protectedModels[scope],
            )) {
                if (remainingBudget === 0) break;
                const deleted = deleteStaleEmbeddingBatch(
                    db,
                    scope,
                    projectIdentity,
                    modelId,
                    remainingBudget,
                );
                remainingBudget -= deleted;
                if (scope === "commit") result.commitRowsDeleted += deleted;
                else result.chunkRowsDeleted += deleted;

                if (!hasStaleEmbeddingRows(db, scope, projectIdentity, modelId)) {
                    result.trackingRowsDeleted += deleteTracking.run(
                        projectIdentity,
                        scope,
                        modelId,
                    ).changes;
                } else if (deleted === 0) {
                    // The zero-delete check prevents spinning through an undeletable backlog.
                    remainingBudget = 0;
                }
            }
        }
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // SQLite can close the transaction after a fatal error.
        }
        throw error;
    }

    return result;
}

export function registerProjectEmbedding(
    db: Database,
    projectIdentity: string,
    config: EmbeddingConfig,
    features: EmbeddingFeatures,
    sourceDirectory: string,
): ProjectEmbeddingRegistrationSnapshot {
    const resolvedConfig = resolveEmbeddingConfig(config);
    const deferredSynapse = isDeferredSynapseConfig(resolvedConfig);
    const providerIdentity = deferredSynapse
        ? OFF_PROVIDER_IDENTITY
        : getEmbeddingProviderIdentity(resolvedConfig);
    const runtimeFingerprint = deferredSynapse
        ? `deferred-synapse:${sha256Prefix(stableStringify(resolvedConfig))}`
        : getRuntimeFingerprint(resolvedConfig);
    const chunkModelId = deferredSynapse
        ? "off"
        : getChunkEmbeddingModelId(resolvedConfig, providerIdentity);
    const prior = projectRegistrations.get(projectIdentity);
    // Retaining the requested provider preserves an already healthy provider and its fallback.
    // A deferred registration retains the healthy provider and descriptor when it resumes a resolved lane.
    const resumesResolvedLane =
        deferredSynapse &&
        prior !== undefined &&
        !prior.observationMode &&
        prior.deferredIntent === runtimeFingerprint &&
        // Fallback activation retains the deferred intent but replaces the config, so only a resolved Synapse config may be carried forward.
        // The ordinary reuse predicate matches an unresolved prior on the deferred fingerprint.
        prior.config.provider === "synapse" &&
        !isDeferredSynapseConfig(prior.config);
    const canReuseProvider =
        prior !== undefined &&
        !prior.observationMode &&
        (resumesResolvedLane ||
            (prior.runtimeFingerprint === runtimeFingerprint &&
                prior.providerIdentity === providerIdentity));
    // A resumed lane retains the prior registration's resolved identity.
    // A new deferred registration publishes OFF_PROVIDER_IDENTITY.
    const effectiveConfig = resumesResolvedLane ? prior.config : resolvedConfig;
    const effectiveProviderIdentity = resumesResolvedLane
        ? prior.providerIdentity
        : providerIdentity;
    const effectiveRuntimeFingerprint = resumesResolvedLane
        ? prior.runtimeFingerprint
        : runtimeFingerprint;
    const effectiveChunkModelId = resumesResolvedLane ? prior.chunkModelId : chunkModelId;
    if (!deferredSynapse) {
        recordActiveEmbeddingIdentity(
            db,
            projectIdentity,
            providerIdentity,
            chunkModelId,
            features,
        );
    } else if (!resumesResolvedLane) {
        clearDeferredDescriptor(db, "embedding_registrations", projectIdentity);
    }
    // Each registration prunes expired synthetic-ledger rows because session teardown never deletes the primary and shadow batch sessions.
    pruneSynapseBatchLedgerForProject(db, projectIdentity);
    untrustedLoadProjects.delete(projectIdentity);
    const generationChanged =
        prior === undefined ||
        prior.observationMode ||
        prior.runtimeFingerprint !== effectiveRuntimeFingerprint ||
        prior.chunkModelId !== effectiveChunkModelId ||
        !sameFeatures(prior.features, features);
    const generation = generationChanged ? ++globalRegistrationGeneration : prior.generation;
    const nextState = {
        db,
        sourceDirectory,
        config: effectiveConfig,
        providerIdentity: effectiveProviderIdentity,
        runtimeFingerprint: effectiveRuntimeFingerprint,
        generation,
        features: { ...features },
        modelId:
            effectiveProviderIdentity === OFF_PROVIDER_IDENTITY ? "off" : effectiveProviderIdentity,
        chunkModelId:
            effectiveProviderIdentity === OFF_PROVIDER_IDENTITY ? "off" : effectiveChunkModelId,
        observationMode: false,
    };
    let registration: ProjectEmbeddingRegistration;
    if (canReuseProvider) {
        registration = Object.assign(prior, nextState);
        if (deferredSynapse) registration.deferredIntent = runtimeFingerprint;
        else delete registration.deferredIntent;
    } else {
        registration = {
            projectIdentity,
            provider: null,
            ...nextState,
            ...(deferredSynapse ? { deferredIntent: runtimeFingerprint } : {}),
        };
    }

    projectRegistrations.set(projectIdentity, registration);
    // A resumed lane is fully resolved, so its descriptor stays authoritative.
    if (!deferredSynapse || resumesResolvedLane) persistPrimaryDescriptor(db, registration);

    if (!canReuseProvider) {
        disposeProvider(prior?.provider ?? null);
    }

    return snapshotFor(registration);
}

export function registerProjectShadowEmbedding(
    db: Database,
    projectIdentity: string,
    config: EmbeddingConfig,
    sourceDirectory: string,
): ProjectEmbeddingRegistrationSnapshot | null {
    const resolvedConfig = resolveEmbeddingConfig(config);
    if (resolvedConfig.provider !== "synapse") {
        throw new Error("Shadow embedding registration requires the synapse provider");
    }
    const deferredSynapse = isDeferredSynapseConfig(resolvedConfig);
    const deferredIntent = deferredSynapse
        ? `deferred-synapse:${sha256Prefix(stableStringify(resolvedConfig))}`
        : undefined;
    const priorRegistration = shadowRegistrations.get(projectIdentity);
    // A matching deferred intent can identify a lane resolved by an earlier registration.
    // A resolved lane re-registered with the same deferred config retains its discovered descriptor.
    const resumesResolvedLane =
        deferredIntent !== undefined &&
        priorRegistration?.deferredIntent === deferredIntent &&
        priorRegistration.config.provider === "synapse" &&
        !isDeferredSynapseConfig(priorRegistration.config);
    // The registration preserves a lane whose initial discovery is still in flight.
    // Replacing an in-flight lane loses its pending discovery result.
    // Replacing the lane disposes the provider that owns the pending callback.
    // The identity guard rejects `onSynapseLaneReady` after replacement.
    // The replacement cohort remains `off` when the identity guard rejects the pending callback.
    // The registration path preserves a pending prior so its callback can commit the discovered lane.
    // The registration path preserves a pending prior until `models.list` returns.
    // The registration path does not persist a descriptor before the lane resolves.
    // An unresolved lane has no descriptor to persist.
    const preservesPendingLane =
        deferredIntent !== undefined &&
        priorRegistration?.deferredIntent === deferredIntent &&
        !resumesResolvedLane &&
        synapseLaneDiscoveryState(priorRegistration.provider) === "pending";
    if (deferredSynapse && !resumesResolvedLane) {
        clearDeferredDescriptor(db, "shadow_embedding_registrations", projectIdentity);
    }
    const providerIdentity = deferredSynapse
        ? OFF_PROVIDER_IDENTITY
        : getEmbeddingProviderIdentity(resolvedConfig);
    const chunkModelId = deferredSynapse
        ? "off"
        : getChunkEmbeddingModelId(resolvedConfig, providerIdentity);
    let registrationForCallback: ShadowEmbeddingRegistration | null = null;
    const provider = createProvider(resolvedConfig, {
        projectRoot: sourceDirectory,
        session: `shadow:${projectIdentity}`,
        onSynapseLaneReady: (metadata) => {
            if (registrationForCallback) {
                commitShadowSynapseLane(registrationForCallback, metadata);
            }
        },
    });
    if (!provider) return null;
    const prior = priorRegistration;
    if (
        prior &&
        (resumesResolvedLane ||
            preservesPendingLane ||
            (!deferredSynapse && prior.providerIdentity === providerIdentity))
    ) {
        void provider.dispose();
        dbForShadowQueue.set(projectIdentity, db);
        // The registration path does not persist a pending lane because it has no resolved identity.
        // Persisting a pending lane would overwrite the cleared deferred descriptor with `off`.
        // `commitShadowSynapseLane` persists the descriptor after discovery resolves.
        if (!preservesPendingLane) persistShadowDescriptor(db, prior);
        const backfillAlreadyArmed =
            hasPendingShadowBackfill(projectIdentity) ||
            shadowQueue.some((item) => item.projectIdentity === projectIdentity);
        if (!backfillAlreadyArmed) maybeArmShadowBackfill(db, projectIdentity, prior);
        return {
            ...snapshotFor({
                db: prior.db,
                projectIdentity,
                sourceDirectory,
                config: prior.config,
                providerIdentity: prior.providerIdentity,
                runtimeFingerprint: `shadow:${prior.providerIdentity}`,
                provider: prior.provider,
                generation: prior.generation,
                features: { memoryEnabled: true, gitCommitEnabled: true },
                modelId: prior.modelId,
                chunkModelId: prior.chunkModelId,
                observationMode: false,
            }),
            provider: "synapse",
        };
    }
    const generation = ++globalRegistrationGeneration;
    const registration: ShadowEmbeddingRegistration = {
        db,
        projectIdentity,
        sourceDirectory,
        config: resolvedConfig,
        provider,
        providerIdentity,
        modelId: providerIdentity,
        chunkModelId,
        generation,
        ...(deferredIntent === undefined ? {} : { deferredIntent }),
    };
    registrationForCallback = registration;
    shadowRegistrations.set(projectIdentity, registration);
    dbForShadowQueue.set(projectIdentity, db);
    if (prior) disposeProvider(prior.provider);
    if (!deferredSynapse) {
        db.transaction(() => {
            const now = Date.now();
            recordScopeActiveIdentity(db, projectIdentity, "commit", registration.modelId, now);
            recordScopeActiveIdentity(db, projectIdentity, "chunk", registration.chunkModelId, now);
            persistShadowDescriptor(db, registration);
        })();
    }
    // A changed shadow identity requires re-embedding historical primary rows to preserve cohort coverage.
    if (!deferredSynapse) maybeArmShadowBackfill(db, projectIdentity, registration);
    return {
        projectIdentity,
        sourceDirectory,
        providerIdentity,
        runtimeFingerprint: `shadow:${providerIdentity}`,
        generation,
        features: { memoryEnabled: true, gitCommitEnabled: true },
        enabled: true,
        gitCommitEnabled: true,
        modelId: registration.modelId,
        chunkModelId: registration.chunkModelId,
        model:
            "model" in resolvedConfig && typeof resolvedConfig.model === "string"
                ? resolvedConfig.model
                : registration.modelId,
        provider: "synapse",
    };
}

function startShadowWorker(): void {
    if (shadowWorker) return;
    shadowWorker = runShadowWorker().finally(() => {
        shadowWorker = null;
        if (shadowQueue.length > 0 || hasPendingShadowBackfill()) startShadowWorker();
    });
}

export interface ShadowEmbeddingMeasurementCohort {
    modelId: string;
    chunkModelId: string;
    fingerprint: string;
    epoch: number;
    dims: number;
}

export function getShadowEmbeddingMeasurementCohort(
    projectIdentity: string,
): ShadowEmbeddingMeasurementCohort | null {
    const registration = shadowRegistrations.get(projectIdentity);
    if (!registration) return null;
    const fields = synapseConfigFields(registration.config);
    return {
        modelId: registration.modelId,
        chunkModelId: registration.chunkModelId,
        fingerprint: fields.fingerprint ?? "",
        epoch: fields.tableEpoch ?? 0,
        dims: fields.dims ?? 0,
    };
}

export function getPrimaryEmbeddingMeasurementCohort(
    projectIdentity: string,
): ShadowEmbeddingMeasurementCohort | null {
    const registration = projectRegistrations.get(projectIdentity);
    if (!registration) return null;
    const fields = synapseConfigFields(registration.config);
    return {
        modelId: registration.modelId,
        chunkModelId: registration.chunkModelId,
        fingerprint: fields.fingerprint ?? "",
        epoch: fields.tableEpoch ?? 0,
        dims: fields.dims ?? 0,
    };
}

export async function embedShadowTextForProject(
    projectIdentity: string,
    text: string,
    signal?: AbortSignal,
): Promise<Float32Array | null> {
    const registration = shadowRegistrations.get(projectIdentity);
    if (!registration) return null;
    try {
        return await registration.provider.embed(text, signal, "query");
    } catch (error) {
        log("[magic-context] Synapse shadow query failed:", error);
        return null;
    }
}

export function enqueueShadowEmbeddingItems(
    projectIdentity: string,
    scope: ShadowScope,
    ids: readonly string[],
): void {
    if (ids.length === 0 || !shadowRegistrations.has(projectIdentity)) return;
    shadowQueue.push({ projectIdentity, scope, ids: [...ids] });
    startShadowWorker();
}

/**
 * The query omits ORDER BY and LIMIT so callers can add a bounded LIMIT.
 * Callers can wrap the query in COUNT(*).
 */
function shadowBackfillMissingBase(
    scope: ShadowScope,
    primaryModelId: string,
    shadowModelId: string,
    projectIdentity: string,
): { sql: string; params: unknown[]; orderBy: string } {
    if (scope === "commit") {
        return {
            sql: `SELECT gc.sha AS id
                  FROM git_commits gc
                  JOIN git_commit_embeddings gp ON gp.sha = gc.sha AND gp.model_id = ?
                  LEFT JOIN git_commit_embeddings gs ON gs.sha = gc.sha AND gs.model_id = ?
                  WHERE gc.project_path = ? AND gs.sha IS NULL`,
            params: [primaryModelId, shadowModelId, projectIdentity],
            orderBy: " ORDER BY gc.committed_at DESC, gc.sha",
        };
    }
    return {
        sql: `SELECT DISTINCT cp.compartment_id AS id
              FROM compartment_chunk_embeddings cp
              WHERE cp.project_path = ? AND cp.model_id = ?
                AND NOT EXISTS (
                    SELECT 1 FROM compartment_chunk_embeddings cs
                    WHERE cs.compartment_id = cp.compartment_id AND cs.model_id = ?
                )`,
        params: [projectIdentity, primaryModelId, shadowModelId],
        orderBy: " ORDER BY cp.compartment_id",
    };
}

/* */
function shadowBackfillMissingIds(
    db: Database,
    projectIdentity: string,
    scope: ShadowScope,
    primaryModelId: string,
    shadowModelId: string,
    limit: number,
): string[] {
    const { sql, params, orderBy } = shadowBackfillMissingBase(
        scope,
        primaryModelId,
        shadowModelId,
        projectIdentity,
    );
    const rows = db.prepare(`${sql}${orderBy} LIMIT ?`).all(...params, limit) as Array<{
        id: number | string;
    }>;
    return rows.map((row) => String(row.id));
}

/* */
function countShadowBackfillMissing(
    db: Database,
    projectIdentity: string,
    scope: ShadowScope,
    primaryModelId: string,
    shadowModelId: string,
): number {
    const { sql, params } = shadowBackfillMissingBase(
        scope,
        primaryModelId,
        shadowModelId,
        projectIdentity,
    );
    return (
        db.prepare(`SELECT COUNT(*) AS count FROM (${sql})`).get(...params) as { count: number }
    ).count;
}

function shadowModelIdForScope(
    registration: { modelId: string; chunkModelId: string },
    scope: ShadowScope,
): string {
    return scope === "chunk" ? registration.chunkModelId : registration.modelId;
}

function hasPendingShadowBackfill(projectIdentity?: string): boolean {
    if (projectIdentity === undefined) return pendingShadowBackfills.size > 0;
    const scopes = pendingShadowBackfills.get(projectIdentity);
    return scopes !== undefined && scopes.size > 0;
}

/**
 * The worker refills an empty live queue from pending historical backfills.
 * A repeated ID set means the prior pump made no progress.
 * Retiring a stalled scope prevents a failing provider from restarting the worker indefinitely.
 */
function pumpShadowBackfill(): void {
    for (const [projectIdentity, scopes] of pendingShadowBackfills) {
        const db = dbForShadowQueue.get(projectIdentity);
        const shadow = shadowRegistrations.get(projectIdentity);
        const primary = projectRegistrations.get(projectIdentity);
        if (!db || !shadow || !primary) {
            pendingShadowBackfills.delete(projectIdentity);
            continue;
        }
        for (const scope of [...scopes]) {
            const primaryModelId = shadowModelIdForScope(primary, scope);
            const shadowModelId = shadowModelIdForScope(shadow, scope);
            const stallKey = `${projectIdentity}:${scope}`;
            if (primaryModelId === "off" || shadowModelId === "off") {
                scopes.delete(scope);
                shadowBackfillLastIds.delete(stallKey);
                continue;
            }
            const ids = shadowBackfillMissingIds(
                db,
                projectIdentity,
                scope,
                primaryModelId,
                shadowModelId,
                SHADOW_MAX_ITEMS_PER_TICK,
            );
            if (ids.length === 0) {
                shadowBackfillStopReasons.set(stallKey, "drained");
                scopes.delete(scope);
                shadowBackfillLastIds.delete(stallKey);
                continue;
            }
            const signature = ids.join(",");
            if (shadowBackfillLastIds.get(stallKey) === signature) {
                shadowBackfillStopReasons.set(stallKey, "stalled_no_progress");
                log(
                    `[shadow] backfill scope ${scope} for ${projectIdentity} retired without progress — ` +
                        `the last batch produced no writes (provider failure or timeout is the usual cause); ` +
                        `${ids.length}+ items remain and retry on the next registration or manual --shadow run`,
                );
                scopes.delete(scope);
                shadowBackfillLastIds.delete(stallKey);
                continue;
            }
            shadowBackfillLastIds.set(stallKey, signature);
            shadowQueue.push({ projectIdentity, scope, ids });
        }
        if (scopes.size === 0) pendingShadowBackfills.delete(projectIdentity);
    }
}

/**
 * A new identity includes rotations and registrations after primary rows already exist.
 * The untrusted-config latch prevents degraded loads from enqueueing shadow work.
 */
function maybeArmShadowBackfill(
    db: Database,
    projectIdentity: string,
    shadow: ShadowEmbeddingRegistration,
): void {
    if (untrustedLoadProjects.has(projectIdentity)) return;
    const primary = projectRegistrations.get(projectIdentity);
    if (!primary) return; // No primary cohort to mirror yet.
    const pending = new Set<ShadowScope>();
    for (const scope of ["commit", "chunk"] as const) {
        const primaryModelId = shadowModelIdForScope(primary, scope);
        const shadowModelId = shadowModelIdForScope(shadow, scope);
        if (primaryModelId === "off" || shadowModelId === "off") continue;
        const probe = shadowBackfillMissingIds(
            db,
            projectIdentity,
            scope,
            primaryModelId,
            shadowModelId,
            1,
        );
        if (probe.length > 0) pending.add(scope);
    }
    if (pending.size === 0) return;
    pendingShadowBackfills.set(projectIdentity, pending);
    pumpShadowBackfill();
    startShadowWorker();
}

/* */
export function getShadowBackfillRemaining(
    db: Database,
    projectIdentity: string,
): { commit: number; chunk: number } {
    const remaining = { commit: 0, chunk: 0 };
    const primary = projectRegistrations.get(projectIdentity);
    const shadow = shadowRegistrations.get(projectIdentity);
    if (!primary || !shadow) return remaining;
    for (const scope of ["commit", "chunk"] as const) {
        const primaryModelId = shadowModelIdForScope(primary, scope);
        const shadowModelId = shadowModelIdForScope(shadow, scope);
        if (primaryModelId === "off" || shadowModelId === "off") continue;
        remaining[scope] = countShadowBackfillMissing(
            db,
            projectIdentity,
            scope,
            primaryModelId,
            shadowModelId,
        );
    }
    return remaining;
}

/**
 * The function drains pending historical backfills in addition to the live shadow queue.
 */
export async function flushShadowEmbeddingBacklog(
    projectIdentity?: string,
    onSettled?: () => void | Promise<void>,
): Promise<void> {
    if (shadowQueue.length > 0 || hasPendingShadowBackfill(projectIdentity)) {
        startShadowWorker();
    }
    for (;;) {
        const worker = shadowWorker;
        if (worker) {
            await worker;
            await onSettled?.();
            continue;
        }
        if (shadowQueue.length === 0 && !hasPendingShadowBackfill(projectIdentity)) return;
        // Work can remain after a backfill is armed without a queue push; startShadowWorker() advances it.
        startShadowWorker();
        if (!shadowWorker) await new Promise((resolve) => setTimeout(resolve, 10));
        await onSettled?.();
    }
}

type DetailedCapableProvider = EmbeddingProvider & {
    embedItemsDetailed: NonNullable<EmbeddingProvider["embedItemsDetailed"]>;
};

interface DetailedLane {
    provider: DetailedCapableProvider;
    laneRole: "primary" | "shadow";
    sessionId: string;
    /** modelId identifies the storage model for memory and commit destination rows. */
    modelId: string;
    /** chunkModelId identifies the storage model for chunk destination rows. */
    chunkModelId: string;
    /** batchTimeoutMs is the page timeout the provider applies to written deadlines.
     * The provider and reopened row must use the same timeout basis.
     * A provider with a non-default timeout polls against its own timeout budget.
     * Using another timeout makes the row advertise an unrelated lease. */
    batchTimeoutMs: number;
    /** stillCurrent returns true while the registration that produced this lane remains current. */
    stillCurrent: () => boolean;
}

/** providerBatchTimeoutMs returns the timeout the provider resolves for ledger deadlines.
 * Using the published timeout keeps reopened rows on the deadline basis used to open them.
 * A provider without pageTimeoutMs is a non-journaling lane.
 * A non-journaling lane uses SYNAPSE_DEFAULT_BATCH_TIMEOUT_MS. */
function providerBatchTimeoutMs(provider: EmbeddingProvider): number {
    const published = (provider as unknown as { pageTimeoutMs?: unknown }).pageTimeoutMs;
    return typeof published === "number" && Number.isFinite(published) && published > 0
        ? published
        : SYNAPSE_DEFAULT_BATCH_TIMEOUT_MS;
}

/** getDetailedLane returns a lane only when the registration has a detailed-capable provider.
 * */
function getDetailedLane(
    projectIdentity: string,
    laneRole: "primary" | "shadow",
): DetailedLane | null {
    if (laneRole === "shadow") {
        const registration = shadowRegistrations.get(projectIdentity);
        const provider = registration?.provider;
        if (!registration || !provider?.embedItemsDetailed) return null;
        if (isDeferredSynapseConfig(registration.config)) return null;
        return {
            provider: provider as DetailedCapableProvider,
            laneRole,
            sessionId: `shadow:${projectIdentity}`,
            modelId: registration.modelId,
            chunkModelId: registration.chunkModelId,
            batchTimeoutMs: providerBatchTimeoutMs(provider),
            stillCurrent: () => shadowRegistrations.get(projectIdentity) === registration,
        };
    }
    const registration = projectRegistrations.get(projectIdentity);
    if (!registration || registration.observationMode) return null;
    if (isDeferredSynapseConfig(registration.config)) return null;
    const provider = getOrCreateProjectProvider(registration);
    if (!provider?.embedItemsDetailed) return null;
    const generation = registration.generation;
    const runtimeFingerprint = registration.runtimeFingerprint;
    return {
        provider: provider as DetailedCapableProvider,
        laneRole,
        sessionId: projectIdentity,
        modelId: registration.modelId,
        chunkModelId: registration.chunkModelId,
        batchTimeoutMs: providerBatchTimeoutMs(provider),
        stillCurrent: () => {
            const current = projectRegistrations.get(projectIdentity);
            return (
                current !== undefined &&
                current.generation === generation &&
                current.runtimeFingerprint === runtimeFingerprint
            );
        },
    };
}

/** Destination-row classification is scoped to one reopen-proof transaction. */
interface DetailedDestinationProbe {
    /* */
    state: (item: { id: string; contentSha256: string }) => "absent" | "stale" | "current";
    /** A group reopen removes destination rows for every item in each reopened page, including lanes that cannot prove staleness.
     * */
    invalidate: (item: { id: string; contentSha256: string }) => void;
}

interface DetailedApplySpec {
    db: Database;
    projectIdentity: string;
    scope: "memory" | "commit" | "chunk";
    lane: DetailedLane;
    items: DetailedEmbedItem[];
    /* */
    readCurrentHashes: (ids: readonly string[]) => ReadonlyMap<string, string>;
    /* */
    writeGroup: (group: string, vectors: ReadonlyMap<string, Float32Array>) => void;
    /** A fresh probe is built for each reopen-proof transaction; cached snapshots do not outlive that transaction.
     * An earlier proof's invalidation changes the destination observed by the next proof. */
    makeDestinationProbe: () => DetailedDestinationProbe;
    signal?: AbortSignal;
}

/**
 * Each fully covered application group writes destination rows and changes every contributing receipt from ready to complete in one transaction.
 */
async function embedAndApplyDetailed(spec: DetailedApplySpec): Promise<Map<string, Set<string>>> {
    const { db, lane, items } = spec;
    if (items.length === 0) return new Map();
    const context: DetailedEmbedContext = {
        db,
        projectPath: spec.projectIdentity,
        sessionId: lane.sessionId,
        scope: spec.scope,
        laneRole: lane.laneRole,
    };
    let result = await lane.provider.embedItemsDetailed(items, context, spec.signal);

    const conflicted = result.failures.filter(
        (failure) => failure.code === "idempotency_conflict" && failure.rowId !== null,
    );
    if (conflicted.length > 0) {
        const conflictedGroups = new Set(conflicted.map((failure) => failure.applicationGroup));
        const retryGroups = new Set<string>();
        for (const group of conflictedGroups) {
            const reopened = db.transaction(() => {
                // A changed page has a fresh receipt rather than a conflict.
                const rowIds = (
                    db
                        .prepare(
                            `SELECT id FROM synapse_batch_ledger
                             WHERE project_path = ? AND session_id = ? AND scope = ?
                               AND lane_role = ? AND destination_model = ?
                               AND application_group = ? AND state = 'complete'`,
                        )
                        .all(
                            spec.projectIdentity,
                            lane.sessionId,
                            spec.scope,
                            lane.laneRole,
                            lane.provider.modelId,
                            group,
                        ) as Array<{ id: number }>
                ).map((row) => row.id);
                const evidence = items.filter((item) => item.applicationGroup === group);
                const probe = spec.makeDestinationProbe();
                let destinationNeedsRepair: boolean | undefined;
                return reopenCompleteSynapseLedgerGroupWithProof(db, {
                    rowIds,
                    deadlineAt: Date.now() + lane.batchTimeoutMs,
                    destinationState: (item) => {
                        destinationNeedsRepair ??= evidence.some(
                            (candidate) => probe.state(candidate) !== "current",
                        );
                        return destinationNeedsRepair ? "stale" : probe.state(item);
                    },
                    invalidateDestination: probe.invalidate,
                });
            })();
            if (reopened > 0) retryGroups.add(group);
        }
        if (retryGroups.size > 0) {
            const retryItems = items.filter((item) => retryGroups.has(item.applicationGroup));
            const retried = await lane.provider.embedItemsDetailed(
                retryItems,
                context,
                spec.signal,
            );
            // The retry supersedes all first-round results; retaining both result sets creates duplicate rows and fails group preflight.
            result = {
                receipts: [
                    ...result.receipts.filter(
                        (receipt) => !retryGroups.has(receipt.applicationGroup),
                    ),
                    ...retried.receipts,
                ],
                failures: [
                    ...result.failures.filter(
                        (failure) => !retryGroups.has(failure.applicationGroup),
                    ),
                    ...retried.failures,
                ],
            };
        }
    }

    if (!lane.stillCurrent()) return new Map();

    const expectedByGroup = new Map<string, number>();
    for (const item of items) {
        expectedByGroup.set(
            item.applicationGroup,
            (expectedByGroup.get(item.applicationGroup) ?? 0) + 1,
        );
    }
    const receiptsByGroup = new Map<string, EmbeddingPageReceipt[]>();
    for (const receipt of result.receipts) {
        const list = receiptsByGroup.get(receipt.applicationGroup);
        if (list) list.push(receipt);
        else receiptsByGroup.set(receipt.applicationGroup, [receipt]);
    }
    const applied = new Map<string, Set<string>>();
    for (const [group, receipts] of receiptsByGroup) {
        const covered = receipts.reduce((total, receipt) => total + receipt.items.length, 0);
        if (covered !== expectedByGroup.get(group)) continue;
        const vectors = new Map<string, Float32Array>();
        for (const receipt of receipts) {
            for (const [id, vector] of receipt.vectors) vectors.set(id, vector);
        }
        try {
            applySynapseReceiptGroup(db, {
                receipts,
                expectation: {
                    scope: spec.scope,
                    laneRole: lane.laneRole,
                    destinationModel: lane.provider.modelId,
                },
                readCurrentHashes: spec.readCurrentHashes,
                writeDestination: () => spec.writeGroup(group, vectors),
            });
        } catch (error) {
            log(`[magic-context] synapse receipt group ${group} not applied:`, error);
            continue;
        }
        applied.set(
            group,
            new Set(receipts.flatMap((receipt) => receipt.items.map((item) => item.id))),
        );
    }
    return applied;
}

async function embedCommitRowsDetailed(
    db: Database,
    projectIdentity: string,
    lane: DetailedLane,
    rows: readonly { sha: string; message: string }[],
): Promise<Set<string>> {
    // The host's item schema rejects empty and over-limit messages; dropping them before grouping preserves valid siblings.
    const specs = rows
        .filter(
            (row) =>
                row.message.length > 0 &&
                Buffer.byteLength(row.message, "utf8") <=
                    (lane.provider.maxInputBytes ?? SYNAPSE_MAX_INPUT_BYTES),
        )
        .map((row) => ({
            id: `commit:${row.sha}`,
            text: row.message,
            contentSha256: contentSha256(row.message),
        }));
    const group = `commit:${sha256Prefix(
        stableStringify(specs.map(({ id, contentSha256: hash }) => [id, hash])),
    )}`;
    const items: DetailedEmbedItem[] = specs.map((spec) => ({
        ...spec,
        applicationGroup: group,
    }));
    const shaFromItemId = (itemId: string): string => itemId.slice("commit:".length);
    const applied = await embedAndApplyDetailed({
        db,
        projectIdentity,
        scope: "commit",
        lane,
        items,
        readCurrentHashes: (ids) => {
            const map = new Map<string, string>();
            if (ids.length === 0) return map;
            const placeholders = ids.map(() => "?").join(",");
            const rows = db
                .prepare(
                    `SELECT sha, message FROM git_commits
                     WHERE project_path = ? AND sha IN (${placeholders})`,
                )
                .all(projectIdentity, ...ids.map(shaFromItemId)) as Array<{
                sha: string;
                message: unknown;
            }>;
            for (const row of rows) {
                if (typeof row.message === "string") {
                    map.set(`commit:${row.sha}`, contentSha256(row.message));
                }
            }
            return map;
        },
        writeGroup: (_group, vectors) => {
            for (const [id, vector] of vectors) {
                saveCommitEmbedding(db, shaFromItemId(id), vector, lane.modelId);
            }
        },
        // A commit's SHA fixes its source text, so an existing row cannot be source-stale; the probe reports only current or absent.
        makeDestinationProbe: () => ({
            state: (item) =>
                hasCommitEmbedding(db, shaFromItemId(item.id), lane.modelId) ? "current" : "absent",
            invalidate: (item) => {
                db.prepare("DELETE FROM git_commit_embeddings WHERE sha = ? AND model_id = ?").run(
                    shaFromItemId(item.id),
                    lane.modelId,
                );
            },
        }),
    });
    const shas = new Set<string>();
    for (const ids of applied.values()) {
        for (const id of ids) shas.add(shaFromItemId(id));
    }
    return shas;
}

/** The function uses versioned receipts for journaling providers and the existing guarded transaction otherwise.
 * */
export async function embedCommitRowsForProject(
    db: Database,
    projectIdentity: string,
    rows: readonly { sha: string; message: string }[],
): Promise<number> {
    if (rows.length === 0) return 0;
    const lane = getDetailedLane(projectIdentity, "primary");
    if (lane) {
        const applied = await embedCommitRowsDetailed(db, projectIdentity, lane, rows);
        if (applied.size > 0) {
            enqueueShadowEmbeddingItems(projectIdentity, "commit", [...applied]);
        }
        return applied.size;
    }
    const result = await embedItemsForProject(
        projectIdentity,
        rows.map((row) => ({
            id: `commit:${row.sha}`,
            text: row.message,
            contentSha256: contentSha256(row.message),
        })),
    );
    if (!result) return 0;
    let embeddedCount = 0;
    db.transaction(() => {
        for (const row of rows) {
            const embedding = result.vectors.get(`commit:${row.sha}`);
            if (!embedding) continue;
            saveCommitEmbedding(db, row.sha, embedding, result.modelId);
            embeddedCount += 1;
        }
    })();
    enqueueShadowEmbeddingItems(
        projectIdentity,
        "commit",
        rows.filter((row) => result.vectors.has(`commit:${row.sha}`)).map((row) => row.sha),
    );
    return embeddedCount;
}

interface CompartmentWindowsApplication {
    compartmentId: number;
    sessionId: string;
    windows: readonly CompartmentChunkWindow[];
    /** The transaction recomputes the compartment's current windows and defaults to reloading its stored source.
     * */
    currentWindows?: () => readonly CompartmentChunkWindow[];
}

/** Each compartment has one application group; its all-window replacement and contributing page receipts commit atomically.
 * */
async function applyCompartmentWindowsDetailed(
    db: Database,
    projectIdentity: string,
    lane: DetailedLane,
    args: CompartmentWindowsApplication,
    signal?: AbortSignal,
): Promise<boolean> {
    const group = `compartment:${args.compartmentId}`;
    const items: DetailedEmbedItem[] = args.windows.map((window) => ({
        id: `chunk:${args.compartmentId}:${window.windowIndex}`,
        text: window.text,
        contentSha256: window.chunkHash,
        applicationGroup: group,
    }));
    const windowIndexFromItemId = (itemId: string): number =>
        Number(itemId.split(":")[2] ?? Number.NaN);
    const currentWindows =
        args.currentWindows ??
        (() => {
            const source = db
                .prepare(
                    `SELECT start_message, end_message FROM compartments
                     WHERE id = ? AND session_id = ?`,
                )
                .get(args.compartmentId, args.sessionId) as {
                start_message: number;
                end_message: number;
            } | null;
            if (!source) return [];
            const text =
                buildCanonicalChunkTextFromFts(
                    db,
                    args.sessionId,
                    source.start_message,
                    source.end_message,
                ) || buildCompartmentSummaryFallbackText(db, args.compartmentId);
            return chunkCanonicalText(
                text,
                source.start_message,
                source.end_message,
                getProjectEmbeddingMaxInputTokens(projectIdentity),
                getProjectEmbeddingMaxInputBytes(projectIdentity),
            );
        });
    const applied = await embedAndApplyDetailed({
        db,
        projectIdentity,
        scope: "chunk",
        lane,
        items,
        signal,
        readCurrentHashes: (ids) => {
            const current = currentWindows();
            if (current.length !== ids.length) return new Map();
            const byIndex = new Map(current.map((window) => [window.windowIndex, window]));
            const map = new Map<string, string>();
            for (const id of ids) {
                const window = byIndex.get(windowIndexFromItemId(id));
                if (window) map.set(id, window.chunkHash);
            }
            return map;
        },
        writeGroup: (_group, vectors) => {
            const rowsToWrite: SaveCompartmentChunkEmbeddingInput[] = args.windows.map((window) => {
                const vector = vectors.get(`chunk:${args.compartmentId}:${window.windowIndex}`);
                if (!vector) {
                    throw new Error(
                        `missing chunk vector for window ${window.windowIndex} of compartment ${args.compartmentId}`,
                    );
                }
                return {
                    compartmentId: args.compartmentId,
                    sessionId: args.sessionId,
                    projectPath: projectIdentity,
                    window,
                    modelId: lane.chunkModelId,
                    vector,
                };
            });
            replaceCompartmentChunkEmbeddings(db, rowsToWrite);
        },
        makeDestinationProbe: () => {
            // The proof snapshots the hash map once; rereading it per item is O(items × windows) despite an identical in-transaction result.
            // The snapshot must not outlive a proof because invalidation deletes rows that the next proof must re-observe.
            let existing: ReadonlyMap<number, string> | null = null;
            // One compartment-wide invalidation per proof transaction covers every manifest window.
            let invalidated = false;
            return {
                state: (item: { id: string; contentSha256: string }) => {
                    existing ??= getExistingChunkHashes(
                        db,
                        args.compartmentId,
                        lane.chunkModelId,
                        projectIdentity,
                    );
                    if (existing.size === 0) return "absent";
                    const hash = existing.get(windowIndexFromItemId(item.id));
                    return hash === item.contentSha256 ? "current" : "stale";
                },
                invalidate: () => {
                    if (invalidated) return;
                    invalidated = true;
                    deleteCompartmentChunkEmbeddingsForModel(
                        db,
                        args.compartmentId,
                        lane.chunkModelId,
                    );
                },
            };
        },
    });
    return applied.has(group);
}

/**
 * The function returns null when the primary lane has no durable page journal so the caller uses its legacy path. */
export async function embedCompartmentWindowsDetailedForProject(
    db: Database,
    projectIdentity: string,
    args: CompartmentWindowsApplication,
): Promise<boolean | null> {
    const lane = getDetailedLane(projectIdentity, "primary");
    if (!lane) return null;
    const applied = await applyCompartmentWindowsDetailed(db, projectIdentity, lane, args);
    if (applied) {
        enqueueShadowEmbeddingItems(projectIdentity, "chunk", [String(args.compartmentId)]);
    }
    return applied;
}

async function embedShadowItems(
    registration: ShadowEmbeddingRegistration,
    items: readonly { id: string; text: string; contentSha256: string }[],
): Promise<Map<string, Float32Array>> {
    if (registration.provider.embedItems) {
        return registration.provider.embedItems(items);
    }
    const positional = await registration.provider.embedBatch(items.map((item) => item.text));
    return new Map(
        items.flatMap((item, index) => {
            const vector = positional[index];
            return vector ? [[item.id, vector] as const] : [];
        }),
    );
}

async function processShadowQueueItem(item: ShadowQueueItem): Promise<void> {
    const registration = shadowRegistrations.get(item.projectIdentity);
    if (!registration) return;
    if (item.ids.length > SHADOW_MAX_ITEMS_PER_TICK) {
        throw new Error("shadow worker must split oversized queue items");
    }
    if (item.scope === "commit") {
        const db = dbForShadowQueue.get(item.projectIdentity);
        if (!db) return;
        const placeholders = item.ids.map(() => "?").join(",");
        const rows = db
            .prepare(
                `SELECT sha, message FROM git_commits WHERE project_path = ? AND sha IN (${placeholders})`,
            )
            .all(item.projectIdentity, ...item.ids) as Array<{ sha: string; message: string }>;
        const shadowLane = getDetailedLane(item.projectIdentity, "shadow");
        if (shadowLane) {
            await embedCommitRowsDetailed(db, item.projectIdentity, shadowLane, rows);
            return;
        }
        const vectors = await embedShadowItems(
            registration,
            rows.map((row) => ({
                id: `commit:${row.sha}`,
                text: row.message,
                contentSha256: contentSha256(row.message),
            })),
        );
        db.transaction(() => {
            for (const row of rows) {
                const vector = vectors.get(`commit:${row.sha}`);
                if (vector) saveCommitEmbedding(db, row.sha, vector, registration.modelId);
            }
        })();
        return;
    }

    const db = dbForShadowQueue.get(item.projectIdentity);
    if (!db) return;
    const placeholders = item.ids.map(() => "?").join(",");
    const candidates = db
        .prepare(
            `SELECT id, session_id, start_message, end_message
         FROM compartments WHERE id IN (${placeholders})`,
        )
        .all(...item.ids.map((id) => Number(id))) as Array<{
        id: number;
        session_id: string;
        start_message: number;
        end_message: number;
    }>;
    // Initial and in-transaction recomputation use the same token and byte ceilings; otherwise their window hashes differ.
    const maxInputTokens = laneMaxInputTokens(registration);
    const maxInputBytes = laneMaxInputBytes(registration);
    const prepared = candidates.flatMap((candidate) => {
        const text =
            buildCanonicalChunkTextFromFts(
                db,
                candidate.session_id,
                candidate.start_message,
                candidate.end_message,
            ) || buildCompartmentSummaryFallbackText(db, candidate.id);
        if (!text) return [];
        const windows = chunkCanonicalText(
            text,
            candidate.start_message,
            candidate.end_message,
            maxInputTokens,
            maxInputBytes,
        );
        return windows.length > 0 ? [{ candidate, windows }] : [];
    });
    const shadowChunkLane = getDetailedLane(item.projectIdentity, "shadow");
    if (shadowChunkLane) {
        for (const preparedItem of prepared) {
            await applyCompartmentWindowsDetailed(db, item.projectIdentity, shadowChunkLane, {
                compartmentId: preparedItem.candidate.id,
                sessionId: preparedItem.candidate.session_id,
                windows: preparedItem.windows,
                currentWindows: () => {
                    const text =
                        buildCanonicalChunkTextFromFts(
                            db,
                            preparedItem.candidate.session_id,
                            preparedItem.candidate.start_message,
                            preparedItem.candidate.end_message,
                        ) || buildCompartmentSummaryFallbackText(db, preparedItem.candidate.id);
                    return chunkCanonicalText(
                        text,
                        preparedItem.candidate.start_message,
                        preparedItem.candidate.end_message,
                        maxInputTokens,
                        maxInputBytes,
                    );
                },
            });
        }
        return;
    }
    const items = prepared.flatMap((item) =>
        item.windows.map((window) => ({
            id: `chunk:${item.candidate.id}:${window.windowIndex}`,
            text: window.text,
            contentSha256: contentSha256(window.text),
        })),
    );
    const vectors = await embedShadowItems(registration, items);
    for (const item of prepared) {
        const rows: SaveCompartmentChunkEmbeddingInput[] = item.windows.flatMap((window) => {
            const vector = vectors.get(`chunk:${item.candidate.id}:${window.windowIndex}`);
            return vector
                ? [
                      {
                          compartmentId: item.candidate.id,
                          sessionId: item.candidate.session_id,
                          projectPath: registration.projectIdentity,
                          window,
                          modelId: registration.chunkModelId,
                          vector,
                      },
                  ]
                : [];
        });
        if (rows.length === item.windows.length) replaceCompartmentChunkEmbeddings(db, rows);
    }
}

const dbForShadowQueue = new Map<string, Database>();

async function runShadowWorker(): Promise<void> {
    const startedAt = Date.now();
    let processed = 0;
    let processedBytes = 0;
    for (;;) {
        if (shadowQueue.length === 0) {
            // When live mirror writes are drained, the worker processes pending historical backfill before idling so rotation backlogs drain incrementally.
            pumpShadowBackfill();
            if (shadowQueue.length === 0) break;
        }
        if (
            processed >= SHADOW_MAX_ITEMS_PER_TICK ||
            Date.now() - startedAt >= SHADOW_MAX_WALL_CLOCK_MS
        ) {
            break;
        }
        const item = shadowQueue.shift();
        if (!item) break;
        if (item.ids.length > SHADOW_MAX_ITEMS_PER_TICK) {
            shadowQueue.unshift({
                ...item,
                ids: item.ids.slice(SHADOW_MAX_ITEMS_PER_TICK),
            });
            item.ids = item.ids.slice(0, SHADOW_MAX_ITEMS_PER_TICK);
        }
        const itemBytes = item.ids.reduce((total, id) => total + id.length, 0);
        if (processed > 0 && processedBytes + itemBytes > SHADOW_MAX_BYTES_PER_TICK) {
            shadowQueue.unshift(item);
            break;
        }
        try {
            await processShadowQueueItem(item);
        } catch (error) {
            log("[magic-context] Synapse shadow write failed:", error);
        }
        processed += item.ids.length;
        processedBytes += itemBytes;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

export function registerProjectInObservationMode(
    db: Database,
    projectIdentity: string,
    sourceDirectory: string,
    failedConfig: EmbeddingConfig,
    failureSummary: string,
): ProjectEmbeddingRegistrationSnapshot {
    const prior = projectRegistrations.get(projectIdentity);
    const runtimeFingerprint = `observation:${sha256Prefix(failureSummary)}`;
    const generation =
        prior?.runtimeFingerprint === runtimeFingerprint && prior.observationMode
            ? prior.generation
            : ++globalRegistrationGeneration;
    const registration: ProjectEmbeddingRegistration = {
        db,
        projectIdentity,
        sourceDirectory,
        config: resolveEmbeddingConfig(failedConfig),
        providerIdentity: OFF_PROVIDER_IDENTITY,
        runtimeFingerprint,
        provider: null,
        generation,
        features: { memoryEnabled: false, gitCommitEnabled: false },
        modelId: "off",
        chunkModelId: "off",
        observationMode: true,
    };

    projectRegistrations.set(projectIdentity, registration);
    disposeProvider(prior?.provider ?? null);

    return snapshotFor(registration);
}

export function getProjectEmbeddingSnapshot(
    projectIdentity: string,
): ProjectEmbeddingRegistrationSnapshot | null {
    const registration = projectRegistrations.get(projectIdentity);
    return registration ? snapshotFor(registration) : null;
}

export function getProjectChunkEmbeddingModelId(projectIdentity: string): string {
    const registration = projectRegistrations.get(projectIdentity);
    return registration && !registration.observationMode ? registration.chunkModelId : "off";
}

/** A lane uses the provider-advertised chunk window when available; otherwise it uses the configured cap.
 * */
function laneMaxInputTokens(
    registration: { config: EmbeddingConfig; provider: EmbeddingProvider | null } | undefined,
): number {
    const configMax =
        registration?.config && "max_input_tokens" in registration.config
            ? registration.config.max_input_tokens
            : undefined;
    return normalizeCompartmentChunkMaxInputTokens(
        registration?.provider?.maxInputTokens ?? configMax,
    );
}

function laneMaxInputBytes(
    registration: { config: EmbeddingConfig; provider: EmbeddingProvider | null } | undefined,
): number | undefined {
    const configMax =
        registration?.config.provider === "synapse" &&
        "synapse_max_input_bytes" in registration.config
            ? registration.config.synapse_max_input_bytes
            : undefined;
    const maxInputBytes = registration?.provider?.maxInputBytes ?? configMax;
    return typeof maxInputBytes === "number" &&
        Number.isInteger(maxInputBytes) &&
        maxInputBytes >= 4
        ? maxInputBytes
        : undefined;
}

export function getProjectEmbeddingMaxInputTokens(projectIdentity: string): number {
    return laneMaxInputTokens(projectRegistrations.get(projectIdentity));
}

export function getProjectEmbeddingMaxInputBytes(projectIdentity: string): number | undefined {
    return laneMaxInputBytes(projectRegistrations.get(projectIdentity));
}

function getOrCreateProjectProvider(
    registration: ProjectEmbeddingRegistration,
): EmbeddingProvider | null {
    if (registration.config.provider === "off" || registration.observationMode) {
        return null;
    }
    if (registration.provider) {
        return registration.provider;
    }
    const provider = createProvider(registration.config, {
        projectRoot: registration.sourceDirectory,
        session: `project:${registration.projectIdentity}`,
        onSynapseLaneReady: (metadata) => commitPrimarySynapseLane(registration, metadata),
    });
    registration.provider = provider;
    return provider;
}

export async function embedTextForProject(
    projectIdentity: string,
    text: string,
    signal?: AbortSignal,
    purpose: EmbeddingPurpose = "passage",
): Promise<{
    vector: Float32Array;
    modelId: string;
    chunkModelId: string;
    generation: number;
} | null> {
    const registration = projectRegistrations.get(projectIdentity);
    if (!registration) return null;
    let provider = getOrCreateProjectProvider(registration);
    if (!provider) return null;

    let vector = await provider.embed(text, signal, purpose);
    if (!vector && !signal?.aborted && activatePrimarySynapseFallback(registration)) {
        provider = getOrCreateProjectProvider(registration);
        vector = provider ? await provider.embed(text, signal, purpose) : null;
    }
    if (!vector) return null;

    if (projectRegistrations.get(projectIdentity) !== registration) return null;
    return {
        vector,
        modelId: registration.modelId,
        chunkModelId: registration.chunkModelId,
        generation: registration.generation,
    };
}

export async function embedBatchForProject(
    projectIdentity: string,
    texts: string[],
    signal?: AbortSignal,
    purpose: EmbeddingPurpose = "passage",
): Promise<{ vectors: (Float32Array | null)[]; modelId: string; generation: number } | null> {
    if (texts.length === 0) {
        const registration = projectRegistrations.get(projectIdentity);
        if (!registration || registration.observationMode) return null;
        return { vectors: [], modelId: registration.modelId, generation: registration.generation };
    }

    const registration = projectRegistrations.get(projectIdentity);
    if (!registration) return null;
    let provider = getOrCreateProjectProvider(registration);
    if (!provider) return null;

    let vectors = await provider.embedBatch(texts, signal, purpose);
    if (
        !signal?.aborted &&
        vectors.every((vector) => vector === null) &&
        activatePrimarySynapseFallback(registration)
    ) {
        provider = getOrCreateProjectProvider(registration);
        vectors = provider
            ? await provider.embedBatch(texts, signal, purpose)
            : texts.map(() => null);
    }
    if (projectRegistrations.get(projectIdentity) !== registration) return null;
    return {
        vectors,
        modelId: registration.modelId,
        generation: registration.generation,
    };
}

export async function embedItemsForProject(
    projectIdentity: string,
    items: readonly { id: string; text: string; contentSha256: string }[],
    signal?: AbortSignal,
): Promise<{ vectors: Map<string, Float32Array>; modelId: string; generation: number } | null> {
    const registration = projectRegistrations.get(projectIdentity);
    if (!registration || registration.observationMode || items.length === 0) return null;
    let provider = getOrCreateProjectProvider(registration);
    if (!provider) return null;

    const embedVia = async (
        p: NonNullable<typeof provider>,
    ): Promise<Map<string, Float32Array>> => {
        if (p.embedItems) {
            return p.embedItems(items, signal);
        }
        const positional = await p.embedBatch(
            items.map((item) => item.text),
            signal,
            "passage",
        );
        return new Map(
            items.flatMap((item, index) => {
                const vector = positional[index];
                return vector ? [[item.id, vector] as const] : [];
            }),
        );
    };
    let vectors = await embedVia(provider);
    if (vectors.size === 0 && !signal?.aborted && activatePrimarySynapseFallback(registration)) {
        provider = getOrCreateProjectProvider(registration);
        if (!provider) return null;
        vectors = await embedVia(provider);
    }

    if (projectRegistrations.get(projectIdentity) !== registration) return null;
    return {
        vectors,
        modelId: registration.modelId,
        generation: registration.generation,
    };
}

/** Domain items use the positional providers' per-call window cap. */
async function embedItemsWindowBounded(
    projectIdentity: string,
    items: readonly { id: string; text: string; contentSha256: string }[],
    signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof embedItemsForProject>>> {
    if (items.length <= MAX_WINDOWS_PER_EMBED_CALL) {
        return embedItemsForProject(projectIdentity, items, signal);
    }
    const vectors = new Map<string, Float32Array>();
    let modelId: string | null = null;
    let generation: number | null = null;
    for (let start = 0; start < items.length; start += MAX_WINDOWS_PER_EMBED_CALL) {
        const result = await embedItemsForProject(
            projectIdentity,
            items.slice(start, start + MAX_WINDOWS_PER_EMBED_CALL),
            signal,
        );
        if (!result) return null;
        if (modelId === null) {
            modelId = result.modelId;
            generation = result.generation;
        } else if (modelId !== result.modelId || generation !== result.generation) {
            return null;
        }
        for (const [id, vector] of result.vectors) vectors.set(id, vector);
    }
    return modelId === null || generation === null ? null : { vectors, modelId, generation };
}

interface CommitBatchResult {
    selected: number;
    embedded: number;
}

/* */
async function embedCommitBatch(
    db: Database,
    projectIdentity: string,
    batchSize: number,
): Promise<CommitBatchResult> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.gitCommitEnabled) return { selected: 0, embedded: 0 };
    const limit = Math.max(1, Math.floor(batchSize));
    const registration = projectRegistrations.get(projectIdentity);
    const detailed = getDetailedLane(projectIdentity, "primary") !== null;
    const maxInputBytes = detailed
        ? (laneMaxInputBytes(registration) ?? SYNAPSE_MAX_INPUT_BYTES)
        : Number.MAX_SAFE_INTEGER;
    const commits = loadUnembeddedCommits(
        db,
        projectIdentity,
        snapshot.modelId,
        limit,
        maxInputBytes,
    );
    if (commits.length === 0) return { selected: 0, embedded: 0 };
    return {
        selected: commits.length,
        embedded: await embedCommitRowsForProject(db, projectIdentity, commits),
    };
}

/**
 * The drain coordinates each project's unembedded-commit backlog across processes.
 *
 * Backlog draining acquires the shared git-sweep lease per identity because every plugin process runs it each dream-timer tick. It ignores cooldown so indexed commits with `embedded=0` drain every tick, and releases without success so its cooldown remains independent of git sweeps.
 */
export async function drainCommitBacklogForProject(
    db: Database,
    projectIdentity: string,
    deadline: number,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.gitCommitEnabled) return 0;

    const holderId = `embed-sweep-${randomUUID()}`;
    const lease = acquireGitSweepLease(db, projectIdentity, holderId, { ignoreCooldown: true });
    if (!lease.acquired) {
        // Another process is sweeping or draining this identity; the worker skips this identity.
        return 0;
    }

    let total = 0;
    let processed = 0;
    let leaseLost = false;
    const renewal = setInterval(() => {
        try {
            if (!renewGitSweepLease(db, projectIdentity, holderId)) leaseLost = true;
        } catch {
            // A transient database error leaves the current TTL in force.
        }
    }, SESSION_EMBED_LEASE_RENEWAL_MS);
    (renewal as { unref?: () => void }).unref?.();
    try {
        while (!leaseLost && Date.now() < deadline && processed < COMMIT_DRAIN_MAX_PER_SWEEP) {
            const batchSize = Math.min(
                COMMIT_DRAIN_BATCH_SIZE,
                COMMIT_DRAIN_MAX_PER_SWEEP - processed,
            );
            const batch = await embedCommitBatch(db, projectIdentity, batchSize);
            processed += batch.selected;
            if (!renewGitSweepLease(db, projectIdentity, holderId)) leaseLost = true;
            if (leaseLost || batch.selected === 0) break;
            total += batch.embedded;
            if (batch.embedded < batch.selected || batch.selected < batchSize) break;
        }
    } finally {
        clearInterval(renewal);
        releaseGitSweepLease(db, projectIdentity, holderId);
    }
    return total;
}

interface CompartmentChunkBatchResult {
    /** A zero candidate count means the backlog is drained or chunk embedding is disabled; an all-no-work batch still selected candidates and must not stop the drain.
     * */
    selected: number;
    embedded: number;
    noWork: number[];
    failed: number[];
    nextCursor?: Pick<CompartmentChunkBackfillCandidate, "createdAt" | "id">;
}

async function embedCompartmentChunkBatch(
    db: Database,
    projectIdentity: string,
    batchSize: number,
    before?: Pick<CompartmentChunkBackfillCandidate, "createdAt" | "id">,
): Promise<CompartmentChunkBatchResult> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled || snapshot.chunkModelId === "off") {
        return { selected: 0, embedded: 0, noWork: [], failed: [] };
    }

    repairMisScopedCompartmentChunkEmbeddingsForProject(db, projectIdentity);
    const candidates = loadUnembeddedCompartmentChunkCandidates(
        db,
        projectIdentity,
        snapshot.chunkModelId,
        batchSize,
        before,
    );
    if (candidates.length === 0) return { selected: 0, embedded: 0, noWork: [], failed: [] };
    const { embedded, noWork, failed } = await embedCandidateChunkBatch(
        db,
        projectIdentity,
        snapshot.chunkModelId,
        candidates,
    );
    const tail = candidates[candidates.length - 1];
    return {
        selected: candidates.length,
        embedded,
        noWork,
        failed,
        nextCursor: { createdAt: tail.createdAt, id: tail.id },
    };
}

interface CandidateChunkBatchResult {
    /** The set contains compartments whose embeddings were fully persisted in this call. */
    embedded: number;
    /** Candidates with empty canonical text or current windows are not failures; session draining skips them to avoid selecting them again.
     * */
    noWork: number[];
    /**
     * The drain excludes failed candidates for the current run and retries them in later runs. */
    failed: number[];
}

/**
 * The batcher limits each provider call to `MAX_WINDOWS_PER_EMBED_CALL` windows unless one compartment alone exceeds the cap.
 * A compartment is an atomic persistence unit; never split its windows across provider calls. */
async function embedCandidateChunkBatch(
    db: Database,
    projectIdentity: string,
    modelId: string,
    candidates: CompartmentChunkBackfillCandidate[],
    signal?: AbortSignal,
): Promise<CandidateChunkBatchResult> {
    const noWork: number[] = [];
    const failed: number[] = [];
    if (candidates.length === 0) return { embedded: 0, noWork, failed };
    const maxInputTokens = getProjectEmbeddingMaxInputTokens(projectIdentity);
    const maxInputBytes = getProjectEmbeddingMaxInputBytes(projectIdentity);

    type Prepared = {
        candidate: CompartmentChunkBackfillCandidate;
        windows: ReturnType<typeof chunkCanonicalText>;
    };
    const prepared: Prepared[] = [];
    for (const candidate of candidates) {
        // The embedder uses the compartment summary when its raw span has no indexable text so notification- and tool-only compartments receive an embedding.
        // The embedder uses the compartment summary when raw text is not indexable.
        const canonicalText =
            buildCanonicalChunkTextFromFts(
                db,
                candidate.sessionId,
                candidate.startMessage,
                candidate.endMessage,
            ) || buildCompartmentSummaryFallbackText(db, candidate.id);
        if (canonicalText.length === 0) {
            noWork.push(candidate.id);
            continue;
        }
        const windows = chunkCanonicalText(
            canonicalText,
            candidate.startMessage,
            candidate.endMessage,
            maxInputTokens,
            maxInputBytes,
        );
        if (
            windows.length === 0 ||
            chunkEmbeddingWindowsAreCurrent(db, candidate.id, modelId, windows, projectIdentity)
        ) {
            noWork.push(candidate.id);
            continue;
        }
        prepared.push({ candidate, windows });
    }

    if (prepared.length === 0) return { embedded: 0, noWork, failed };

    const lane = getDetailedLane(projectIdentity, "primary");
    if (lane) {
        let embeddedDetailed = 0;
        for (const { candidate, windows } of prepared) {
            if (signal?.aborted) break;
            let applied = false;
            try {
                applied = await applyCompartmentWindowsDetailed(
                    db,
                    projectIdentity,
                    lane,
                    {
                        compartmentId: candidate.id,
                        sessionId: candidate.sessionId,
                        windows,
                        currentWindows: () => {
                            const text =
                                buildCanonicalChunkTextFromFts(
                                    db,
                                    candidate.sessionId,
                                    candidate.startMessage,
                                    candidate.endMessage,
                                ) || buildCompartmentSummaryFallbackText(db, candidate.id);
                            return chunkCanonicalText(
                                text,
                                candidate.startMessage,
                                candidate.endMessage,
                                maxInputTokens,
                                maxInputBytes,
                            );
                        },
                    },
                    signal,
                );
            } catch (error) {
                log("[magic-context] failed to embed compartment chunks (detailed):", error);
            }
            if (applied) {
                embeddedDetailed += 1;
                enqueueShadowEmbeddingItems(projectIdentity, "chunk", [String(candidate.id)]);
            } else if (!signal?.aborted) {
                failed.push(candidate.id);
            }
        }
        return { embedded: embeddedDetailed, noWork, failed };
    }

    let embedded = 0;
    let i = 0;
    while (i < prepared.length) {
        if (signal?.aborted) break;
        const slice: Prepared[] = [];
        let windowCount = 0;
        do {
            const item = prepared[i];
            slice.push(item);
            windowCount += item.windows.length;
            i += 1;
        } while (
            i < prepared.length &&
            windowCount + prepared[i].windows.length <= MAX_WINDOWS_PER_EMBED_CALL
        );

        const items = slice.flatMap((item) =>
            item.windows.map((window) => ({
                id: `chunk:${item.candidate.id}:${window.windowIndex}`,
                text: window.text,
                contentSha256: contentSha256(window.text),
            })),
        );

        // The retry loop retries failures that finish before EMBED_SLOW_FAILURE_NO_RETRY_MS with backoff.
        // The retry loop retries failures that finish before EMBED_SLOW_FAILURE_NO_RETRY_MS.
        // The batcher tracks persisted compartment IDs because provider calls can partially succeed.
        // A count cannot identify which compartments remain unpersisted after a partial provider response.
        // The batcher marks every compartment without persisted vectors as failed after a partial response.
        // The batcher marks every non-persisted compartment failed so the cursor advances and the next run retries it.
        const persistedIds = new Set<number>();
        for (let attempt = 0; attempt < EMBED_SLICE_RETRY_ATTEMPTS; attempt++) {
            if (signal?.aborted) break;
            let result: Awaited<ReturnType<typeof embedItemsForProject>> = null;
            const attemptStart = Date.now();
            try {
                // Sub-batch the provider call by window count so the per-request
                // payload stays bounded even when a SINGLE compartment contributed
                // more than MAX_WINDOWS_PER_EMBED_CALL windows (e.g. a huge file
                // dump split into many sub-windows by chunkCanonicalText). Without
                // this, the slice builder's "always include at least one
                // compartment" rule could hand the provider one enormous text array
                // in a single HTTP call, defeating the payload bound and risking
                // provider timeouts/rejections.
                result = await embedItemsWindowBounded(projectIdentity, items, signal);
            } catch (error) {
                log("[magic-context] failed to proactively embed compartment chunks:", error);
            }
            if (signal?.aborted) break;
            if (result) {
                for (const item of slice) {
                    if (persistedIds.has(item.candidate.id)) continue;
                    const vectors = item.windows.map((window) =>
                        result.vectors.get(`chunk:${item.candidate.id}:${window.windowIndex}`),
                    );
                    if (vectors.length !== item.windows.length || vectors.some((v) => !v)) {
                        continue;
                    }
                    const rows: SaveCompartmentChunkEmbeddingInput[] = item.windows.map(
                        (window, index) => ({
                            compartmentId: item.candidate.id,
                            sessionId: item.candidate.sessionId,
                            projectPath: projectIdentity,
                            window,
                            modelId,
                            vector: vectors[index] as Float32Array,
                        }),
                    );
                    replaceCompartmentChunkEmbeddings(db, rows);
                    persistedIds.add(item.candidate.id);
                    enqueueShadowEmbeddingItems(projectIdentity, "chunk", [
                        String(item.candidate.id),
                    ]);
                }
            }
            if (persistedIds.size === slice.length) break; // whole slice done
            // After partial persistence, the caller does not retry because `items` includes chunks for persisted compartments; it marks each selected compartment absent from `persistedIds` failed for the next run.
            if (persistedIds.size > 0) break;
            // The retry loop does not retry failures lasting at least `EMBED_SLOW_FAILURE_NO_RETRY_MS`; it marks the slice failed for the next run.
            if (Date.now() - attemptStart >= EMBED_SLOW_FAILURE_NO_RETRY_MS) break;
            if (attempt < EMBED_SLICE_RETRY_ATTEMPTS - 1) {
                await new Promise((resolve) =>
                    setTimeout(resolve, EMBED_SLICE_RETRY_BASE_MS * 2 ** attempt),
                );
            }
        }

        embedded += persistedIds.size;
        // The batcher leaves unattempted compartments eligible after abort.
        if (!signal?.aborted) {
            for (const item of slice) {
                if (!persistedIds.has(item.candidate.id)) failed.push(item.candidate.id);
            }
        }
    }
    return { embedded, noWork, failed };
}

async function drainCompartmentChunkBacklogForProject(
    db: Database,
    projectIdentity: string,
    deadline: number,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled) return 0;

    const holderId = `chunk-embed-sweep-${randomUUID()}`;
    const lease = acquireGitSweepLease(db, projectIdentity, holderId, { ignoreCooldown: true });
    if (!lease.acquired) {
        return 0;
    }

    let total = 0;
    let leaseLost = false;
    // The run-local keyset cursor is not persisted, so failed rows remain eligible for the next maintenance pass.
    let cursor: Pick<CompartmentChunkBackfillCandidate, "createdAt" | "id"> | undefined;
    let consecutiveFailedBatches = 0;
    const renewal = setInterval(() => {
        try {
            if (!renewGitSweepLease(db, projectIdentity, holderId)) leaseLost = true;
        } catch {
            // A transient database error leaves the current TTL in force.
        }
    }, SESSION_EMBED_LEASE_RENEWAL_MS);
    (renewal as { unref?: () => void }).unref?.();
    try {
        while (!leaseLost && Date.now() < deadline && total < CHUNK_DRAIN_MAX_PER_SWEEP) {
            const { selected, embedded, failed, nextCursor } = await embedCompartmentChunkBatch(
                db,
                projectIdentity,
                CHUNK_DRAIN_BATCH_SIZE,
                cursor,
            );
            if (!renewGitSweepLease(db, projectIdentity, holderId)) leaseLost = true;
            if (leaseLost) break;
            total += embedded;
            if (selected === 0) break; // nothing left to select = drained
            cursor = nextCursor;

            // No-work rows do not reset provider health.
            // Mixed no-work/failed batches do not reset the failure streak; successful persistence resets it.
            if (embedded === 0 && failed.length > 0) {
                consecutiveFailedBatches += 1;
                if (consecutiveFailedBatches >= MAX_CONSECUTIVE_FAILED_BATCHES) break;
            } else if (embedded > 0) {
                consecutiveFailedBatches = 0;
            }

            // The loop yields after an all-no-work batch so timers, lease cancellation, and request handling remain live during a long no-work prefix.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        clearInterval(renewal);
        releaseGitSweepLease(db, projectIdentity, holderId);
    }
    return total;
}

/** The caller must share deadlineAt across projects in one maintenance pass to enforce one wall-clock budget.
 * */
export async function embedUnembeddedCompartmentChunksForProject(
    db: Database,
    projectIdentity: string,
    deadlineAt: number = Date.now() + SWEEP_MAX_WALL_CLOCK_MS,
): Promise<number> {
    return drainCompartmentChunkBacklogForProject(db, projectIdentity, deadlineAt);
}

export interface SessionChunkBackfillProgress {
    /* */
    embedded: number;
    /* */
    total: number;
}

export type SessionChunkBackfillOutcome =
    | { status: "done"; embedded: number; total: number; failed: number }
    | { status: "nothing"; embedded: 0; total: 0 }
    | { status: "disabled"; embedded: 0; total: 0 }
    | { status: "busy"; embedded: 0; total: number }
    | { status: "aborted"; embedded: number; total: number; failed: number }
    | { status: "stalled"; embedded: number; total: number; remaining: number; failed: number };

/**
 * The active project drain has no per-sweep cap.
 * `chunk_hash` makes the function idempotent: reruns embed only chunks that remain unembedded.
 */
export async function embedSessionCompartmentChunks(
    db: Database,
    projectIdentity: string,
    sessionId: string,
    options?: {
        signal?: AbortSignal;
        onProgress?: (p: SessionChunkBackfillProgress) => void;
        batchSize?: number;
    },
): Promise<SessionChunkBackfillOutcome> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled || snapshot.chunkModelId === "off") {
        return { status: "disabled", embedded: 0, total: 0 };
    }
    recordSessionProjectIdentity(db, sessionId, projectIdentity);
    const total = countUnembeddedSessionCompartments(
        db,
        projectIdentity,
        sessionId,
        snapshot.chunkModelId,
    );
    if (total === 0) return { status: "nothing", embedded: 0, total: 0 };

    const holderId = `session-embed-${randomUUID()}`;
    const lease = acquireGitSweepLease(db, projectIdentity, holderId, { ignoreCooldown: true });
    if (!lease.acquired) return { status: "busy", embedded: 0, total };

    // The lease holder renews the lease before expiry to extend its TTL.
    let leaseLost = false;
    const drainAbort = new AbortController();
    const forwardCallerAbort = (): void => drainAbort.abort();
    if (options?.signal?.aborted) drainAbort.abort();
    else options?.signal?.addEventListener("abort", forwardCallerAbort, { once: true });
    const renewal = setInterval(() => {
        try {
            if (!renewGitSweepLease(db, projectIdentity, holderId)) {
                leaseLost = true;
                drainAbort.abort();
            }
        } catch {
            /* */
        }
    }, SESSION_EMBED_LEASE_RENEWAL_MS);
    (renewal as { unref?: () => void }).unref?.();

    const batchSize = Math.max(1, options?.batchSize ?? CHUNK_DRAIN_BATCH_SIZE);
    const skipIds: number[] = [];
    // The batcher keeps failed IDs only in memory so the cursor advances; future runs retry them.
    const failedIds: number[] = [];
    let embedded = 0;
    let aborted = false;
    let providerDown = false;
    let consecutiveFailedBatches = 0;
    try {
        options?.onProgress?.({ embedded, total });
        // The batcher re-queries each iteration so newly published compartments are included.
        // Each query rechecks `chunk_hash` deduplication against fresh state.
        // `total` remains the start-of-run denominator.
        // The callback clamps `embedded` to `total` when the historian publishes compartments mid-run.
        for (;;) {
            if (leaseLost || drainAbort.signal.aborted) {
                aborted = true;
                break;
            }
            const candidates = loadUnembeddedSessionChunkCandidates(
                db,
                projectIdentity,
                sessionId,
                snapshot.chunkModelId,
                batchSize,
                [...skipIds, ...failedIds],
            );
            if (candidates.length === 0) break;
            const {
                embedded: n,
                noWork,
                failed,
            } = await embedCandidateChunkBatch(
                db,
                projectIdentity,
                snapshot.chunkModelId,
                candidates,
                drainAbort.signal,
            );
            if (leaseLost || !renewGitSweepLease(db, projectIdentity, holderId)) {
                leaseLost = true;
                drainAbort.abort();
                aborted = true;
                break;
            }
            // The batcher records no-work candidates so the next query advances past them.
            for (const id of noWork) skipIds.push(id);
            // The batcher records this-run failures so the cursor advances; the next run retries them.
            for (const id of failed) failedIds.push(id);

            // A zero-progress batch with no no-work rows is all failed.
            if (n === 0 && noWork.length === 0) {
                consecutiveFailedBatches += 1;
                if (consecutiveFailedBatches >= MAX_CONSECUTIVE_FAILED_BATCHES) {
                    providerDown = true;
                    break;
                }
            } else {
                consecutiveFailedBatches = 0;
            }

            embedded += n;
            options?.onProgress?.({ embedded: Math.min(embedded, total), total });
            // The zero-delay timer lets the host serve other work between batches.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        clearInterval(renewal);
        options?.signal?.removeEventListener("abort", forwardCallerAbort);
        try {
            releaseGitSweepLease(db, projectIdentity, holderId);
        } catch (error) {
            // The catch preserves the drain's result or thrown error if lease release fails.
            // The lease expires after its TTL if release fails.
            log("[magic-context] embed drain: lease release failed (will TTL-expire):", error);
        }
    }
    if (aborted) return { status: "aborted", embedded, total, failed: failedIds.length };
    // Return `stalled` when the circuit opens or failed compartments remain.
    // `remaining` counts still-embeddable compartments.
    // The count excludes already-embedded rows and skipped compartments.
    if (providerDown || failedIds.length > 0) {
        const remaining = Math.max(
            0,
            countUnembeddedSessionCompartments(
                db,
                projectIdentity,
                sessionId,
                snapshot.chunkModelId,
            ) - skipIds.length,
        );
        if (remaining > 0) {
            return { status: "stalled", embedded, total, remaining, failed: failedIds.length };
        }
    }
    return { status: "done", embedded, total, failed: failedIds.length };
}

export interface EmbeddingCoverageStatus {
    /* */
    enabled: boolean;
    /* */
    model: string;
    /* */
    provider: string;
    /* */
    session: { embedded: number; total: number };
    /* */
    commits: { embedded: number; total: number; gitEnabled: boolean };
}

/**
 */
export function getEmbeddingCoverageStatus(
    db: Database,
    projectIdentity: string,
    sessionId: string,
): EmbeddingCoverageStatus {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled || snapshot.chunkModelId === "off") {
        return {
            enabled: false,
            model: snapshot?.model ?? "off",
            provider: snapshot?.provider ?? "off",
            session: { embedded: 0, total: 0 },
            commits: { embedded: 0, total: 0, gitEnabled: false },
        };
    }
    const session = countSessionCompartmentEmbedCoverage(
        db,
        projectIdentity,
        sessionId,
        snapshot.chunkModelId,
    );
    const gitEnabled = snapshot.gitCommitEnabled;
    const commits = gitEnabled
        ? {
              embedded: countEmbeddedCommits(db, projectIdentity, snapshot.modelId),
              total: getCommitCount(db, projectIdentity),
              gitEnabled: true,
          }
        : { embedded: 0, total: 0, gitEnabled: false };
    return {
        enabled: true,
        model: snapshot.model,
        provider: snapshot.provider,
        session,
        commits,
    };
}

export async function sweepAllRegisteredProjects(db: Database): Promise<{
    commitsEmbedded: number;
    chunksEmbedded: number;
    perProject: Map<string, { commits: number; chunks: number }>;
}> {
    if (projectSweepInProgress) {
        log("[magic-context] project embedding sweep already in progress, skipping this tick");
        return {
            commitsEmbedded: 0,
            chunksEmbedded: 0,
            perProject: new Map(),
        };
    }

    projectSweepInProgress = true;
    const startedAt = Date.now();
    const deadline = startedAt + SWEEP_MAX_WALL_CLOCK_MS;
    const perProject = new Map<string, { commits: number; chunks: number }>();
    let commitsEmbedded = 0;
    let chunksEmbedded = 0;

    try {
        for (const projectIdentity of projectRegistrations.keys()) {
            let commits = 0;
            let chunks = 0;

            if (Date.now() < deadline) {
                commits = await drainCommitBacklogForProject(db, projectIdentity, deadline);
                commitsEmbedded += commits;
            }

            if (Date.now() < deadline) {
                chunks = await drainCompartmentChunkBacklogForProject(
                    db,
                    projectIdentity,
                    deadline,
                );
                chunksEmbedded += chunks;
            }

            perProject.set(projectIdentity, { commits, chunks });
            if (Date.now() >= deadline) break;
        }
    } finally {
        projectSweepInProgress = false;
    }

    return { commitsEmbedded, chunksEmbedded, perProject };
}

export function _setTestProviderFactoryForProject(factory: TestProviderFactory | null): void {
    testProviderFactory = factory;
}

export function _resetProjectEmbeddingRegistryForTests(): void {
    for (const registration of projectRegistrations.values()) {
        disposeProvider(registration.provider);
    }
    for (const registration of shadowRegistrations.values()) {
        disposeProvider(registration.provider);
    }
    projectRegistrations.clear();
    shadowRegistrations.clear();
    shadowQueue.length = 0;
    pendingShadowBackfills.clear();
    shadowBackfillLastIds.clear();
    dbForShadowQueue.clear();
    untrustedLoadProjects.clear();
    globalRegistrationGeneration = 0;
    projectSweepInProgress = false;
    testProviderFactory = null;
}
