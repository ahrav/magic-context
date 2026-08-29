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
import { invalidateProject } from "./memory/embedding-cache";
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
    exactMemoryContentDigests,
    memoriesEligibleForEmbedding,
} from "./memory/storage-claim-visibility";
import { sha256Utf8Hex } from "./memory/storage-claims";
import {
    getMemoryEmbedCoverage,
    hasMemoryEmbedding,
    saveEmbedding,
    saveEmbeddingIfHashMatches,
} from "./memory/storage-memory-embeddings";
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
const SWEEP_MAX_CONSECUTIVE_EMPTY = 3;
// Backlog-drain caps for the commit-embedding path. The drain loops within one
// held coordinator lease so a large backlog (e.g. a 2000-commit repo that was
// indexed before embeddings were enabled) clears in a few ticks instead of
// crawling one batch per tick. Bounded per sweep so one project can't starve
// the others or pin the provider indefinitely.
const COMMIT_DRAIN_BATCH_SIZE = 16;
const COMMIT_DRAIN_MAX_PER_SWEEP = 500;
const CHUNK_DRAIN_BATCH_SIZE = 8;
const CHUNK_DRAIN_MAX_PER_SWEEP = 200;
const EMBEDDING_IDENTITY_GC_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const STALE_EMBEDDING_GC_BATCH_SIZE = 250;
// Hard cap on embedding-window texts sent in ONE provider call. Deliberately
// SMALL: a local embedding endpoint (LMStudio/Ollama) runs one forward pass per
// input, so batching many max_input_tokens-sized windows into a single request
// makes that request too slow to finish inside the HTTP timeout (the dominant
// failure was 16 windows/call timing out at 30s on a local 4B model) — or large
// enough to 400. With each window already ≤ max_input_tokens, capping windows
// per call also caps tokens per call, so a small value keeps every request fast.
// More round-trips, but each completes; far better than oversized calls that
// time out and stall the drain. Compartments are never split across calls; a
// compartment with more windows than this still embeds as its own over-cap call.
const MAX_WINDOWS_PER_EMBED_CALL = 2;
// Session backfill (/ctx-embed) holds the coordinator lease for an unbounded
// run, so it must renew before the TTL lapses (mirrors the git sweep).
const SESSION_EMBED_LEASE_RENEWAL_MS = 60 * 1000;
// Resilience for the session drain. The provider NEVER throws (it returns null /
// all-null vectors and owns its own HTTP circuit breaker), so "retry" here is the
// drain's stop policy, not HTTP retry:
//   - EMBED_SLICE_RETRY_*: re-attempt a single provider call a few times with
//     backoff when it comes back with no usable vectors (a transient blip before
//     the provider's own breaker trips). Cheap insurance for same-run completion.
//   - MAX_CONSECUTIVE_FAILED_BATCHES: a compartment that still won't embed after
//     retries is recorded as failed, EXCLUDED so the oldest-first cursor advances
//     past it (retried on a future run, not persisted as permanent skip), and the
//     drain CONTINUES. Only after this many consecutive all-failed batches do we
//     stop — that's a provider that's actually down, and hammering 800
//     compartments against a dead endpoint helps no one.
const EMBED_SLICE_RETRY_ATTEMPTS = 3;
const EMBED_SLICE_RETRY_BASE_MS = 250;
// If a single failed provider call took at least this long, treat it as a
// timeout (not a transient blip) and do NOT retry it — re-sending the same
// payload would just burn another full timeout. A healthy small call (≤2
// windows) returns in a few seconds, well under this.
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
    /** Friendly configured model name (e.g. "text-embedding-qwen3-embedding-4b"),
     *  for user-facing status. "off" when no provider / observation mode. */
    model: string;
    /** Configured provider kind (e.g. "openai-compatible", "local", "ollama"). */
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
     * Fingerprint of the DEFERRED configuration this registration was created
     * from, retained across lane resolution. Resolving a lane rewrites `config`,
     * `providerIdentity`, and `runtimeFingerprint` to the discovered lane, so
     * without this the next registration from the same unchanged config would
     * look like a different intent and discard a healthy resolved provider.
     */
    deferredIntent?: string;
}

interface UnembeddedMemoryRow {
    id: number;
    content: string;
    normalized_hash: string;
}

type EmbeddingIdentityScope = "memory" | "commit" | "chunk";

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
    /** See {@link ProjectEmbeddingRegistration.deferredIntent}. */
    deferredIntent?: string;
}

type ShadowScope = "memory" | "commit" | "chunk";
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
 * Shadow scopes that still owe a historical backfill for a project. A Synapse
 * fingerprint rotation gives the shadow lane a brand-new modelId, so every row
 * the primary lane already embedded lacks a counterpart under the new identity.
 * Rather than dump the whole corpus into one transaction we mark the affected
 * scopes here and let the shadow worker drain them a bounded chunk per tick
 * (see pumpShadowBackfill). A scope drops out once its missing set is empty.
 */
const pendingShadowBackfills = new Map<string, Set<ShadowScope>>();
/**
 * Last missing-id batch enqueued per `${projectIdentity}:${scope}`. Used as a
 * stall guard: if a pump produces the exact same id set as the previous one,
 * nothing was written in between (the embeds are failing), so we stop
 * re-enqueueing that scope instead of hot-looping the worker against a provider
 * that cannot succeed. Any real progress changes the set and clears the stall.
 */
const shadowBackfillLastIds = new Map<string, string>();
/** Why a (project:scope) backfill stopped: "drained" or "stalled_no_progress". */
const shadowBackfillStopReasons = new Map<string, ShadowBackfillStopReason>();
export type ShadowBackfillStopReason = "drained" | "stalled_no_progress";

/** Stop reason for a scope's last backfill retirement, for status surfaces. */
export function getShadowBackfillStopReason(
    projectIdentity: string,
    scope: "memory" | "commit" | "chunk",
): ShadowBackfillStopReason | undefined {
    return shadowBackfillStopReasons.get(`${projectIdentity}:${scope}`);
}

const loadUnembeddedMemoriesStatements = new WeakMap<Database, PreparedStatement>();
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
 * Projects whose most-recent config load was untrusted (parse/IO error, legacy
 * config unmigrated, or an embedding-affecting substitution/recovery failure).
 * While a project is latched here we keep serving its last-known-good provider
 * for reads/writes but SUPPRESS the destructive stale-identity GC — a degraded
 * load must never delete embedding rows off a config we don't trust. The latch
 * clears the next time a trusted config successfully registers the project.
 */
const untrustedLoadProjects = new Set<string>();

/** Latch a project as currently loaded from an untrusted config (suppresses GC). */
export function markProjectLoadUntrusted(projectIdentity: string): void {
    untrustedLoadProjects.add(projectIdentity);
}
let projectSweepInProgress = false;
/** Construction context every provider receives from {@link createProvider}. */
interface ProviderContext {
    projectRoot: string;
    session: string;
    onSynapseLaneReady?: (
        metadata: import("./memory/embedding-synapse").SynapseLaneMetadata,
    ) => void;
}
/**
 * Test factory for the embedding provider. It receives the same context the
 * real providers get, so a fake can invoke `onSynapseLaneReady` and drive the
 * deferred-lane resolution path (`commitPrimarySynapseLane` /
 * `commitShadowSynapseLane`) instead of a hand-rolled imitation of it.
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
    db.prepare(
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
    ).run(
        registration.projectIdentity,
        "memory",
        registration.modelId,
        registration.generation,
        fields.fingerprint ?? "",
        fields.tableEpoch ?? 0,
        fields.dims ?? 0,
        JSON.stringify(fields.provenance ?? {}),
        now,
    );
    db.prepare(
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
    ).run(
        registration.projectIdentity,
        "commit",
        registration.modelId,
        registration.generation,
        fields.fingerprint ?? "",
        fields.tableEpoch ?? 0,
        fields.dims ?? 0,
        JSON.stringify(fields.provenance ?? {}),
        now,
    );
    db.prepare(
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
    ).run(
        registration.projectIdentity,
        "chunk",
        registration.chunkModelId,
        registration.generation,
        fields.fingerprint ?? "",
        fields.tableEpoch ?? 0,
        fields.dims ?? 0,
        JSON.stringify(fields.provenance ?? {}),
        now,
    );
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
    registration.config = config;
    registration.providerIdentity = providerIdentity;
    registration.runtimeFingerprint = getRuntimeFingerprint(config);
    registration.modelId = providerIdentity;
    registration.chunkModelId = chunkModelId;
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
    registration.config = config;
    registration.providerIdentity = providerIdentity;
    registration.runtimeFingerprint = getRuntimeFingerprint(config);
    registration.provider = null;
    registration.modelId = providerIdentity === OFF_PROVIDER_IDENTITY ? "off" : providerIdentity;
    registration.chunkModelId = providerIdentity === OFF_PROVIDER_IDENTITY ? "off" : chunkModelId;
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
            "memory",
            registration.modelId,
            now,
        );
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
            // provider + identity hash. See issue #259.
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
            // Preserve provider-specific request fields (NVIDIA NIM input_type;
            // truncate). They must survive normalization so (a) they reach the
            // provider request body and (b) a change to either is part of the
            // config identity hash → a real config change correctly wipes stale
            // vectors. query_input_type shapes per-call requests only and is
            // intentionally omitted from identity (stored vectors use passage).
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
    // Chunk vectors depend on the provider vector space AND the exact windowing
    // contract used to derive chunk text. Memory/commit vectors intentionally use
    // only providerIdentity so a chunk-window change does not wipe unrelated stores.
    const chunkIdentity = {
        providerIdentity,
        // v3 adds Synapse's advertised UTF-8 byte ceiling. Other providers have
        // no byte cap, so they retain v2 identity and avoid a no-op re-embed.
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
    // but must stay enabled or the embed entry points that resolve it (and
    // that activate its fallback) would never run. getOrCreateProjectProvider
    // applies the same provider-based gate.
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
            memory: `SELECT DISTINCT e.model_id AS model_id
                     FROM memory_embeddings e
                     JOIN memories m ON m.id = e.memory_id
                     WHERE m.project_path = ?`,
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
    if (features.memoryEnabled) {
        recordScopeActiveIdentity(db, projectIdentity, "memory", currentProviderIdentity, now);
    }
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
    memoryRowsDeleted: number;
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
    if (scope === "memory") {
        return db
            .prepare(
                `DELETE FROM memory_embeddings
                 WHERE rowid IN (
                     SELECT me.rowid
                     FROM memory_embeddings me
                     JOIN memories m ON m.id = me.memory_id
                     WHERE m.project_path = ? AND me.model_id = ?
                     LIMIT ?
                 )`,
            )
            .run(projectIdentity, modelId, limit).changes;
    }
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
    if (scope === "memory") {
        return Boolean(
            db
                .prepare(
                    `SELECT 1
                     FROM memory_embeddings me
                     JOIN memories m ON m.id = me.memory_id
                     WHERE m.project_path = ? AND me.model_id = ?
                     LIMIT 1`,
                )
                .get(projectIdentity, modelId),
        );
    }
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
        memoryRowsDeleted: 0,
        commitRowsDeleted: 0,
        chunkRowsDeleted: 0,
        trackingRowsDeleted: 0,
    };
    if (!snapshot) return result;

    // A degraded/untrusted config load must never drive deletion: the snapshot
    // we'd GC against may be last-known-good while the on-disk config is broken
    // or mid-migration. Reads keep serving the cached vectors; GC waits until a
    // trusted register clears the latch.
    if (untrustedLoadProjects.has(projectIdentity)) return result;

    const cutoff = now - EMBEDDING_IDENTITY_GC_GRACE_MS;
    const deleteTracking = getDeleteActiveIdentityStatement(db);
    const shadow = shadowRegistrations.get(projectIdentity);
    const protectedModels = {
        memory: new Set([snapshot.modelId, ...(shadow ? [shadow.modelId] : [])]),
        commit: new Set([snapshot.modelId, ...(shadow ? [shadow.modelId] : [])]),
        chunk: new Set([snapshot.chunkModelId, ...(shadow ? [shadow.chunkModelId] : [])]),
    };
    const scopes: Array<{
        scope: EmbeddingIdentityScope;
        enabled: boolean;
        currentModelId: string;
    }> = [
        {
            scope: "memory",
            enabled: snapshot.enabled && snapshot.modelId !== "off",
            currentModelId: snapshot.modelId,
        },
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

    // One invocation removes at most one bounded batch. Keeping the stale
    // identity marker until its final vector is gone makes later timer ticks
    // resume safely without holding a writer lock across the whole backlog.
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
                if (scope === "memory") result.memoryRowsDeleted += deleted;
                else if (scope === "commit") result.commitRowsDeleted += deleted;
                else result.chunkRowsDeleted += deleted;

                if (!hasStaleEmbeddingRows(db, scope, projectIdentity, modelId)) {
                    result.trackingRowsDeleted += deleteTracking.run(
                        projectIdentity,
                        scope,
                        modelId,
                    ).changes;
                } else if (deleted === 0) {
                    // Avoid spinning through an unexpectedly undeletable backlog.
                    remainingBudget = 0;
                }
            }
        }
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // The transaction may already be closed by SQLite after a fatal error.
        }
        throw error;
    }

    if (result.memoryRowsDeleted > 0) invalidateProject(projectIdentity);
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
    // Callers re-register from the user's configuration on every tool call, so
    // the incoming config for an already-resolved deferred lane is still the
    // deferred one while the registration now carries the discovered lane.
    // Matching the retained intent keeps that healthy provider and its
    // descriptor instead of tearing both down and re-demanding per call.
    const resumesResolvedLane =
        deferredSynapse &&
        prior !== undefined &&
        !prior.observationMode &&
        prior.deferredIntent === runtimeFingerprint &&
        // A fallback activation keeps the intent but replaces the config with the
        // fallback, and that demotion must stay retryable: only a lane that is
        // still a RESOLVED Synapse config may be carried forward. A prior that is
        // still unresolved falls through to the ordinary reuse predicate, which
        // already matches it on the deferred fingerprint.
        prior.config.provider === "synapse" &&
        !isDeferredSynapseConfig(prior.config);
    const canReuseProvider =
        prior !== undefined &&
        !prior.observationMode &&
        (resumesResolvedLane ||
            (prior.runtimeFingerprint === runtimeFingerprint &&
                prior.providerIdentity === providerIdentity));
    // A resumed lane keeps the prior registration's resolved identity; only a
    // genuinely new deferred registration publishes the placeholder.
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
    // Synthetic ledger sessions (this project's primary and shadow batch keys)
    // are never deleted through session teardown, so prune their expired rows
    // on every (re)registration to keep the ledger bounded.
    pruneSynapseBatchLedgerForProject(db, projectIdentity);
    // A trusted registration just landed — clear any prior untrusted-load latch
    // so GC can resume for this project.
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
        // Carrying the provider forward means preserving the registration OBJECT,
        // not copying its fields into a new one: the provider's
        // `onSynapseLaneReady` closure captured this object, and
        // `commitPrimarySynapseLane` only accepts the identity currently in the
        // map. A fresh object would silently drop the lane resolution of an
        // initialization already in flight, leaving an initialized provider whose
        // registration stays at the placeholder identity forever.
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
    // A resumed lane is fully resolved, so its descriptor stays authoritative;
    // only an unresolved deferred registration has nothing to persist.
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
    // The primary lane's reasoning applies here too: an already-resolved lane
    // is re-registered from the same deferred config on every tool call, and its
    // descriptor now describes the discovered lane.
    const resumesResolvedLane =
        deferredIntent !== undefined && priorRegistration?.deferredIntent === deferredIntent;
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
        (resumesResolvedLane || (!deferredSynapse && prior.providerIdentity === providerIdentity))
    ) {
        void provider.dispose();
        dbForShadowQueue.set(projectIdentity, db);
        persistShadowDescriptor(db, prior);
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
            recordScopeActiveIdentity(db, projectIdentity, "memory", registration.modelId, now);
            recordScopeActiveIdentity(db, projectIdentity, "commit", registration.modelId, now);
            recordScopeActiveIdentity(db, projectIdentity, "chunk", registration.chunkModelId, now);
            persistShadowDescriptor(db, registration);
        })();
    }
    // A new shadow identity just landed (rotation, or a first/again registration
    // over a corpus that already has primary rows). Re-embed the historical
    // corpus under it so the measurement cohort keeps its coverage; the old
    // identity's rows age out through the 14-day GC. No-op when nothing is
    // missing (fresh project / identity unchanged path returned above).
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
 * Base missing-set query for one shadow scope: the items the PRIMARY lane has
 * already embedded (row under the primary modelId) that have NO row under the
 * shadow modelId yet. Mirrors the primary backfill's LEFT JOIN ... WHERE NULL
 * shape. Returned without ORDER BY/LIMIT so callers can append a bounded LIMIT
 * (id listing) or wrap it in a COUNT(*).
 */
function shadowBackfillMissingBase(
    scope: ShadowScope,
    primaryModelId: string,
    shadowModelId: string,
    projectIdentity: string,
): { sql: string; params: unknown[]; orderBy: string } {
    if (scope === "memory") {
        return {
            sql: `SELECT m.id AS id
                  FROM memories m
                  JOIN memory_embeddings mp ON mp.memory_id = m.id AND mp.model_id = ?
                  LEFT JOIN memory_embeddings ms ON ms.memory_id = m.id AND ms.model_id = ?
                  WHERE m.project_path = ? AND m.status = 'active' AND ms.memory_id IS NULL`,
            params: [primaryModelId, shadowModelId, projectIdentity],
            orderBy: " ORDER BY m.id",
        };
    }
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

/** One bounded chunk of shadow-backfill ids for a scope (empty when drained). */
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
    if (scope === "memory") {
        // Policy-hidden rows must be excluded HERE, not only at drain: the
        // id-ordered missing set otherwise re-selects the same hidden head
        // every pump, the drain filter writes nothing, the stall detector
        // retires the scope as stalled_no_progress, and every eligible row
        // with a higher id stays unbackfilled until re-registration. Page
        // past hidden prefixes with a cursor, exactly like the primary
        // backfill walk.
        const pageSize = Math.max(limit * 4, 64);
        let cursor = 0;
        const out: string[] = [];
        for (;;) {
            const page = db
                .prepare(`${sql} AND m.id > ?${orderBy} LIMIT ?`)
                .all(...params, cursor, pageSize) as Array<{ id: number }>;
            if (page.length === 0) break;
            const eligible = memoriesEligibleForEmbedding(
                db,
                page.map((row) => row.id),
            );
            for (const row of page) {
                if (out.length >= limit) break;
                if (eligible.has(row.id)) out.push(String(row.id));
            }
            if (out.length >= limit || page.length < pageSize) break;
            cursor = page[page.length - 1].id;
        }
        return out;
    }
    const rows = db.prepare(`${sql}${orderBy} LIMIT ?`).all(...params, limit) as Array<{
        id: number | string;
    }>;
    return rows.map((row) => String(row.id));
}

/** Total outstanding shadow-backfill rows for a scope (progress reporting). */
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
    if (scope === "memory") {
        // Same policy predicate the selector applies: a quarantined or
        // rejected row is deliberately never drained, so counting it here
        // would leave a permanent nonzero "Remaining" with no queued work
        // that can reduce it.
        const rows = db.prepare(sql).all(...params) as Array<{ id: number }>;
        if (rows.length === 0) return 0;
        const eligible = memoriesEligibleForEmbedding(
            db,
            rows.map((row) => row.id),
        );
        return rows.filter((row) => eligible.has(row.id)).length;
    }
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
 * Refill the shadow queue from pending historical backfills. Called by the
 * worker whenever the live queue runs dry: for each pending (project, scope) it
 * enqueues one bounded chunk of the missing set. A scope is retired when its
 * missing set is empty, or when the same id set comes back twice in a row (no
 * write landed — see shadowBackfillLastIds), so a failing provider can never
 * spin the worker forever.
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
                // No progress since the last pump for this scope; stop retrying.
                // Record WHY so status surfaces can distinguish "honest backlog,
                // provider was failing" from "nothing left" — a bare remaining
                // count after a silent stop reads as an unembeddable-item bug and
                // costs a diagnosis cycle (2026-07-24: 437 chunks, transient
                // provider timeouts under load, zero recorded reason).
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
 * Detect whether a freshly registered shadow identity owes a historical
 * backfill and arm it. Runs whenever a NEW shadow identity lands — either a
 * rotation (prior identity differed) or a first/again registration whose corpus
 * already has primary rows but no shadow rows under the current identity (the
 * rotation-while-down case). Cheap: a LIMIT-1 probe per scope; the actual
 * embedding happens asynchronously in the bounded shadow worker, so this never
 * blocks registration. Gated on the untrusted-config latch so a degraded load
 * can never enqueue shadow work off a config we don't trust.
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
    for (const scope of ["memory", "commit", "chunk"] as const) {
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

/** Outstanding shadow-backfill rows per scope, for progress/status reporting. */
export function getShadowBackfillRemaining(
    db: Database,
    projectIdentity: string,
): { memory: number; commit: number; chunk: number } {
    const remaining = { memory: 0, commit: 0, chunk: 0 };
    const primary = projectRegistrations.get(projectIdentity);
    const shadow = shadowRegistrations.get(projectIdentity);
    if (!primary || !shadow) return remaining;
    for (const scope of ["memory", "commit", "chunk"] as const) {
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
 * Drain the shadow queue and any pending historical backfills to completion.
 * Used by tests and the manual backfill script; the running plugin never calls
 * this (it relies on the self-restarting bounded worker). `onSettled` fires
 * after each bounded worker pass so callers can report progress.
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
        // Work remains but no worker is running (e.g. a fresh backfill was armed
        // without a queue push); nudge it forward.
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
    /** Storage model id for memory/commit destination rows. */
    modelId: string;
    /** Storage model id for chunk destination rows. */
    chunkModelId: string;
    /** Page timeout this lane's provider applies to the deadlines it writes.
     *  A reopen rewrites the deadline of the very row the provider created, so
     *  both deadlines must come from one basis: a provider running a non-default
     *  timeout would otherwise poll a page against its own budget while the row
     *  advertises a lease from an unrelated one. */
    batchTimeoutMs: number;
    /** True while the registration that produced this lane is still current. */
    stillCurrent: () => boolean;
}

/** Page timeout the provider itself resolves for its ledger deadlines. Reading
 *  it keeps a reopened row on the same deadline basis the provider used to open
 *  it; a provider that does not publish one is a non-journaling lane, which
 *  falls back to the same default the ledger helpers assume. */
function providerBatchTimeoutMs(provider: EmbeddingProvider): number {
    const published = (provider as unknown as { pageTimeoutMs?: unknown }).pageTimeoutMs;
    return typeof published === "number" && Number.isFinite(published) && published > 0
        ? published
        : SYNAPSE_DEFAULT_BATCH_TIMEOUT_MS;
}

/** Resolve the lane's provider only when it can journal versioned receipts.
 *  Providers without embedItemsDetailed (local, openai-compatible, test fakes)
 *  return null and keep their existing non-ledger paths. */
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

/** Destination-row classification for one reopen-proof transaction. */
interface DetailedDestinationProbe {
    /** Classify one manifest item's exact destination row. */
    state: (item: { id: string; contentSha256: string }) => "absent" | "stale" | "current";
    /** Remove one manifest item's destination row. A group reopen invalidates
     *  every item of every page it reopens, so this runs for lanes that cannot
     *  prove staleness too. */
    invalidate: (item: { id: string; contentSha256: string }) => void;
}

interface DetailedApplySpec {
    db: Database;
    projectIdentity: string;
    scope: "memory" | "commit" | "chunk";
    lane: DetailedLane;
    items: DetailedEmbedItem[];
    /** Recompute current source hashes inside the destination transaction. */
    readCurrentHashes: (ids: readonly string[]) => ReadonlyMap<string, string>;
    /** Write one application group's destination rows inside that transaction. */
    writeGroup: (group: string, vectors: ReadonlyMap<string, Float32Array>) => void;
    /** Build a fresh probe for ONE reopen-proof transaction. Any snapshot the
     *  probe caches must not outlive that transaction: an earlier proof's
     *  invalidation changes the destination the next proof must observe. */
    makeDestinationProbe: () => DetailedDestinationProbe;
    signal?: AbortSignal;
}

/**
 * Embed items through the provider's durable page journal and apply every
 * fully-covered application group atomically: destination writes and every
 * contributing receipt's ready->complete CAS share one transaction; a group
 * with any failed page, missing vector, drifted source, or stale receipt
 * version applies nothing. When a group's pages report idempotency_conflict,
 * the group's complete pages are reopened together against one destination
 * proof and retried once.
 * Returns the applied item ids per application group.
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
                // Its destination evidence still proves every complete sibling
                // in the atomic group must reopen.
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
            // A retried group's first-round results are entirely superseded:
            // keeping its earlier receipts beside the rerun's would present
            // duplicate rows for one item set and fail the group preflight.
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

function memoryIdFromItemId(itemId: string): number {
    return Number(itemId.slice("memory:".length));
}

/** Memory application-group size. Memory vectors are independent rows with no
 *  cross-row atomicity requirement, so the group only bounds how much
 *  completed inference one failed page can discard. Chunking id-sorted
 *  memories keeps group identity stable when the caller's candidate set
 *  shifts: new (higher-id) memories perturb only the tail group. */
const MEMORY_APPLICATION_GROUP_SIZE = 32;

async function embedMemoryRowsDetailed(
    db: Database,
    projectIdentity: string,
    lane: DetailedLane,
    memories: readonly { id: number; content: string }[],
    signal?: AbortSignal,
): Promise<Map<number, Float32Array>> {
    // The caller's eligibility check can be arbitrarily stale by the time
    // this runs (batches wait behind other awaited provider work, and other
    // processes share the database): re-filter at the provider boundary and
    // bind each row to the exact captured bytes, so a quarantine/rejection
    // or rewrite landing after selection cannot leak content to the
    // provider.
    const eligibleAtDrain = memoriesEligibleForEmbedding(
        db,
        memories.map((memory) => memory.id),
    );
    const digestsAtDrain = exactMemoryContentDigests(
        db,
        memories.map((memory) => memory.id),
    );
    // Policy again AFTER the digest read (two autocommit snapshots): a hide
    // committed between them leaves the digest unchanged.
    const eligibleAfterDrain = memoriesEligibleForEmbedding(
        db,
        memories.map((memory) => memory.id),
    );
    memories = memories.filter(
        (memory) =>
            eligibleAtDrain.has(memory.id) &&
            digestsAtDrain.get(memory.id) === sha256Utf8Hex(memory.content) &&
            eligibleAfterDrain.has(memory.id),
    );
    if (memories.length === 0) return new Map();
    const specs = [...memories]
        .sort((a, b) => a.id - b.id)
        .map((memory) => ({
            id: `memory:${memory.id}`,
            text: memory.content,
            contentSha256: contentSha256(memory.content),
        }));
    const items: DetailedEmbedItem[] = [];
    for (let start = 0; start < specs.length; start += MEMORY_APPLICATION_GROUP_SIZE) {
        const chunk = specs.slice(start, start + MEMORY_APPLICATION_GROUP_SIZE);
        const group = `memory:${sha256Prefix(
            stableStringify(chunk.map(({ id, contentSha256: hash }) => [id, hash])),
        )}`;
        for (const spec of chunk) items.push({ ...spec, applicationGroup: group });
    }
    const inferred = new Map<string, Float32Array>();
    const applied = await embedAndApplyDetailed({
        db,
        projectIdentity,
        scope: "memory",
        lane,
        items,
        signal,
        readCurrentHashes: (ids) => {
            const map = new Map<string, string>();
            if (ids.length === 0) return map;
            const placeholders = ids.map(() => "?").join(",");
            const rows = db
                .prepare(
                    `SELECT id, content FROM memories
                     WHERE project_path = ? AND status = 'active' AND id IN (${placeholders})`,
                )
                .all(projectIdentity, ...ids.map(memoryIdFromItemId)) as Array<{
                id: number;
                content: unknown;
            }>;
            for (const row of rows) {
                if (typeof row.content === "string") {
                    map.set(`memory:${row.id}`, contentSha256(row.content));
                }
            }
            return map;
        },
        writeGroup: (_group, vectors) => {
            for (const [id, vector] of vectors) {
                saveEmbedding(db, memoryIdFromItemId(id), vector, lane.modelId);
                inferred.set(id, vector);
            }
        },
        // Memory staleness is unprovable from the destination row (no per-row
        // source hash), so the probe never reports "stale"; content edits
        // delete the row, which reads as "absent".
        makeDestinationProbe: () => ({
            state: (item) =>
                hasMemoryEmbedding(db, memoryIdFromItemId(item.id), lane.modelId)
                    ? "current"
                    : "absent",
            invalidate: (item) => {
                db.prepare(
                    "DELETE FROM memory_embeddings WHERE memory_id = ? AND model_id = ?",
                ).run(memoryIdFromItemId(item.id), lane.modelId);
            },
        }),
    });
    // writeGroup runs inside the apply transaction, so `inferred` also holds
    // vectors whose destination write was rolled back with a failed receipt
    // CAS. The applied ids are the committed set; nothing else may be returned.
    const written = new Map<number, Float32Array>();
    for (const ids of applied.values()) {
        for (const id of ids) {
            const vector = inferred.get(id);
            if (vector) written.set(memoryIdFromItemId(id), vector);
        }
    }
    return written;
}

/** Read-path and drain entry: memory batch through versioned receipts. Returns
 *  the committed vectors (merge caches only from this), or null when the lane
 *  has no durable page journal and the caller must use its legacy path. */
export async function embedMemoriesDetailedForProject(
    db: Database,
    projectIdentity: string,
    memories: readonly { id: number; content: string }[],
): Promise<Map<number, { embedding: Float32Array; modelId: string }> | null> {
    const lane = getDetailedLane(projectIdentity, "primary");
    if (!lane) return null;
    const written = await embedMemoryRowsDetailed(db, projectIdentity, lane, memories);
    const out = new Map<number, { embedding: Float32Array; modelId: string }>();
    for (const [id, embedding] of written) out.set(id, { embedding, modelId: lane.modelId });
    if (out.size > 0) {
        enqueueShadowEmbeddingItems(projectIdentity, "memory", [...out.keys()].map(String));
    }
    return out;
}

async function embedCommitRowsDetailed(
    db: Database,
    projectIdentity: string,
    lane: DetailedLane,
    rows: readonly { sha: string; message: string }[],
): Promise<Set<string>> {
    // Empty and over-limit messages fail the host's item schema. Dropping them
    // before the group is formed keeps one invalid commit from discarding its
    // otherwise valid siblings.
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
        // A commit's source text is fixed by its SHA, so an existing row can
        // never be source-stale; the probe reports only current or absent.
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

/** Embed and persist one batch of commit rows for the primary lane, through
 *  versioned receipts when the provider journals pages and through the
 *  existing guarded transaction otherwise. Returns how many commits landed. */
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
    /** Recompute the compartment's current windows inside the transaction;
     *  defaults to reloading its stored source. */
    currentWindows?: () => readonly CompartmentChunkWindow[];
}

/** One application group per compartment: the all-window replacement and every
 *  contributing page receipt commit together or not at all. */
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
            // One snapshot per proof transaction: the proof calls state() once
            // per manifest item, and re-reading the whole hash map each time
            // is O(items x windows) for the identical in-transaction answer.
            // The snapshot must not outlive the proof: an earlier proof's
            // invalidation deletes the rows the next proof must re-observe.
            let existing: ReadonlyMap<number, string> | null = null;
            // Invalidation is compartment-wide, so one call per proof
            // transaction covers every window in its manifest.
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

/** Publish-path entry for one compartment's windows. Returns null when the
 *  primary lane has no durable page journal (caller uses its legacy path). */
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
    if (item.scope === "memory") {
        const db = dbForShadowQueue.get(item.projectIdentity);
        if (!db) return;
        const placeholders = item.ids.map(() => "?").join(",");
        const loaded = db
            .prepare(
                `SELECT id, content, normalized_hash FROM memories
                 WHERE project_path = ? AND id IN (${placeholders}) AND status = 'active'`,
            )
            .all(item.projectIdentity, ...item.ids.map((id) => Number(id))) as Array<{
            id: number;
            content: string;
            normalized_hash: string;
        }>;
        // Re-check policy at drain time: a memory embedded while eligible can
        // be quarantined or rejected while its shadow item waits behind other
        // queue or backfill work, and uniform-absence content must not leave
        // the process through the shadow provider. Every shadow path drains
        // through this function, so this is the single choke point.
        const eligibleIds = memoriesEligibleForEmbedding(
            db,
            loaded.map((row) => row.id),
        );
        const rows = loaded.filter((row) => eligibleIds.has(row.id));
        const shadowLane = getDetailedLane(item.projectIdentity, "shadow");
        if (shadowLane) {
            await embedMemoryRowsDetailed(
                db,
                item.projectIdentity,
                shadowLane,
                rows.map((row) => ({ id: row.id, content: row.content })),
            );
            return;
        }
        // The fallback lane needs the same exact-byte drain filter as the
        // detailed lane: a rewrite to an eligible revision differing only in
        // case/whitespace keeps the normalized hash equal, so
        // saveEmbeddingIfHashMatches alone would persist the loaded
        // revision's vector for the new bytes.
        const digestsAtDrain = exactMemoryContentDigests(
            db,
            rows.map((row) => row.id),
        );
        // Policy again AFTER the digest read (two autocommit snapshots,
        // mirroring the detailed lane): a hide committed after `eligibleIds`
        // was read leaves the digest unchanged, and these bytes are about to
        // reach the embedding provider.
        const eligibleAfterDrain = memoriesEligibleForEmbedding(
            db,
            rows.map((row) => row.id),
        );
        const boundRows = rows.filter(
            (row) =>
                digestsAtDrain.get(row.id) === sha256Utf8Hex(row.content) &&
                eligibleAfterDrain.has(row.id),
        );
        if (boundRows.length === 0) return;
        const vectors = await embedShadowItems(
            registration,
            boundRows.map((row) => ({
                id: `memory:${row.id}`,
                text: row.content,
                contentSha256: contentSha256(row.content),
            })),
        );
        db.transaction(() => {
            // Re-bind inside the write transaction: the provider call above
            // yielded, and the normalized-hash guard alone cannot reject a
            // case/whitespace-only rewrite that landed meanwhile.
            const digestsAtSave = exactMemoryContentDigests(
                db,
                boundRows.map((row) => row.id),
            );
            for (const row of boundRows) {
                if (digestsAtSave.get(row.id) !== sha256Utf8Hex(row.content)) continue;
                const vector = vectors.get(`memory:${row.id}`);
                if (vector)
                    saveEmbeddingIfHashMatches(
                        db,
                        row.id,
                        vector,
                        registration.modelId,
                        row.normalized_hash,
                    );
            }
        })();
        return;
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
    // One window ceiling for the whole item: the initial windows and the
    // in-transaction recomputation must window identically, or every hash
    // comparison against the recomputed set fails.
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
            // Live mirror writes are drained; top up from any pending historical
            // backfill before idling so a rotation backlog drains incrementally.
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

export function unregisterProjectEmbedding(projectIdentity: string): void {
    const prior = projectRegistrations.get(projectIdentity);
    const shadow = shadowRegistrations.get(projectIdentity);
    if (!prior && !shadow) return;
    projectRegistrations.delete(projectIdentity);
    shadowRegistrations.delete(projectIdentity);
    dbForShadowQueue.delete(projectIdentity);
    globalRegistrationGeneration += 1;
    disposeProvider(prior?.provider ?? null);
    disposeProvider(shadow?.provider ?? null);
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

/** Chunk window ceiling for one lane: the provider's advertised window when it
 *  reports one (the host can advertise a different window than the config's
 *  default), else the lane's configured cap. */
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

    let vectors: Map<string, Float32Array>;
    if (provider.embedItems) {
        vectors = await provider.embedItems(items, signal);
    } else {
        const positional = await provider.embedBatch(
            items.map((item) => item.text),
            signal,
            "passage",
        );
        vectors = new Map(
            items.flatMap((item, index) => {
                const vector = positional[index];
                return vector ? [[item.id, vector] as const] : [];
            }),
        );
    }
    if (vectors.size === 0 && !signal?.aborted && activatePrimarySynapseFallback(registration)) {
        provider = getOrCreateProjectProvider(registration);
        if (!provider) return null;
        if (provider.embedItems) {
            vectors = await provider.embedItems(items, signal);
        } else {
            const positional = await provider.embedBatch(
                items.map((item) => item.text),
                signal,
                "passage",
            );
            vectors = new Map(
                items.flatMap((item, index) => {
                    const vector = positional[index];
                    return vector ? [[item.id, vector] as const] : [];
                }),
            );
        }
    }

    if (projectRegistrations.get(projectIdentity) !== registration) return null;
    return {
        vectors,
        modelId: registration.modelId,
        generation: registration.generation,
    };
}

/** Keep domain items bounded to the same per-call window cap used by positional providers. */
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

function isUnembeddedMemoryRow(row: unknown): row is UnembeddedMemoryRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.content === "string" &&
        typeof candidate.normalized_hash === "string"
    );
}

function getLoadUnembeddedMemoriesStatement(db: Database): PreparedStatement {
    let stmt = loadUnembeddedMemoriesStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT m.id AS id, m.content AS content, m.normalized_hash AS normalized_hash FROM memories m LEFT JOIN memory_embeddings me ON m.id = me.memory_id AND me.model_id = ? WHERE m.project_path = ? AND m.status = 'active' AND me.memory_id IS NULL AND m.id > ? ORDER BY m.id LIMIT ?",
        );
        loadUnembeddedMemoriesStatements.set(db, stmt);
    }
    return stmt;
}

export async function embedUnembeddedMemoriesForProject(
    db: Database,
    projectIdentity: string,
    batchSize = 10,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled) return 0;

    const normalizedBatchSize = Math.max(1, Math.floor(batchSize));
    // Hard-hidden / rejected content never leaves the process, remote
    // embedding providers included — and hidden rows are deliberately never
    // embedded, so they sit in this backlog indefinitely. Walk the backlog in
    // fixed-size id-ordered pages: each page bounds memory (a growing LIMIT
    // would page most of the table in at once), and the walk runs to table
    // exhaustion so no hidden prefix — of any length — can starve an eligible
    // row behind it.
    const pageSize = Math.max(normalizedBatchSize * 4, 64);
    let cursor = 0;
    const memories: { id: number; content: string; normalized_hash: string }[] = [];
    for (;;) {
        const page = getLoadUnembeddedMemoriesStatement(db).all(
            snapshot.modelId,
            projectIdentity,
            cursor,
            pageSize,
        );
        const fetched = page.filter(isUnembeddedMemoryRow);
        const nextCursor = fetched.length > 0 ? fetched[fetched.length - 1].id : cursor;
        const embeddable = memoriesEligibleForEmbedding(
            db,
            fetched.map((memory) => memory.id),
        );
        for (const memory of fetched) {
            if (memories.length >= normalizedBatchSize) break;
            if (embeddable.has(memory.id)) memories.push(memory);
        }
        if (
            memories.length >= normalizedBatchSize ||
            page.length < pageSize ||
            nextCursor <= cursor
        ) {
            break;
        }
        cursor = nextCursor;
    }
    if (memories.length === 0) return 0;

    try {
        const lane = getDetailedLane(projectIdentity, "primary");
        if (lane) {
            const written = await embedMemoryRowsDetailed(
                db,
                projectIdentity,
                lane,
                memories.map((memory) => ({ id: memory.id, content: memory.content })),
            );
            if (written.size > 0) {
                enqueueShadowEmbeddingItems(
                    projectIdentity,
                    "memory",
                    [...written.keys()].map(String),
                );
            }
            return written.size;
        }
        // Same drain-boundary recheck as the detailed lane: the page-walk
        // precheck above is stale once any await has run. Bind each row to
        // the exact captured bytes too — a rewrite to an eligible revision
        // differing only in case/whitespace keeps the normalized hash equal,
        // so saveEmbeddingIfHashMatches alone would persist the superseded
        // revision's vector for the new bytes.
        const eligibleAtDrain = memoriesEligibleForEmbedding(
            db,
            memories.map((memory) => memory.id),
        );
        const digestsAtDrain = exactMemoryContentDigests(
            db,
            memories.map((memory) => memory.id),
        );
        const stillEligible = memories.filter(
            (memory) =>
                eligibleAtDrain.has(memory.id) &&
                digestsAtDrain.get(memory.id) === sha256Utf8Hex(memory.content),
        );
        if (stillEligible.length === 0) return 0;
        const result = await embedItemsForProject(
            projectIdentity,
            stillEligible.map((memory) => ({
                id: `memory:${memory.id}`,
                text: memory.content,
                contentSha256: contentSha256(memory.content),
            })),
        );
        if (!result) return 0;

        let embeddedCount = 0;
        db.transaction(() => {
            // Re-bind inside the write transaction: the provider call above
            // yielded, and the normalized-hash guard alone cannot reject a
            // case/whitespace-only rewrite that landed meanwhile — the save
            // would reinstate the predecessor's vector under the successor
            // bytes. Same discipline as the shadow drain.
            const digestsAtSave = exactMemoryContentDigests(
                db,
                stillEligible.map((memory) => memory.id),
            );
            for (const memory of stillEligible) {
                if (digestsAtSave.get(memory.id) !== sha256Utf8Hex(memory.content)) continue;
                const embedding = result.vectors.get(`memory:${memory.id}`);
                if (!embedding) continue;
                if (
                    saveEmbeddingIfHashMatches(
                        db,
                        memory.id,
                        embedding,
                        result.modelId,
                        memory.normalized_hash,
                    )
                ) {
                    embeddedCount += 1;
                }
            }
        })();
        enqueueShadowEmbeddingItems(
            projectIdentity,
            "memory",
            stillEligible
                .filter((memory) => result.vectors.has(`memory:${memory.id}`))
                .map((memory) => String(memory.id)),
        );
        return embeddedCount;
    } catch (error) {
        log("[magic-context] failed to proactively embed missing memories:", error);
        return 0;
    }
}

interface CommitBatchResult {
    selected: number;
    embedded: number;
}

/** Drain a single batch of unembedded commits. */
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
        // Another process is sweeping/draining this identity — skip cleanly.
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
    /** Candidates the query returned; 0 means the backlog is drained (or chunk
     *  embedding is off), which is the drain loop's only "stop, nothing left"
     *  signal — an all-no-work batch still selected rows and must not stop it. */
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
    /** Compartments fully embedded + persisted this call. */
    embedded: number;
    /** Candidates that yielded NO embeddable work (empty canonical text or
     *  windows already current) — they are not failures and the session drain
     *  must skip past them rather than re-select them forever. */
    noWork: number[];
    /** Candidates the provider could not embed this call even after retries
     *  (returned no/partial vectors). NOT permanent: excluded for the rest of
     *  THIS run so the cursor advances, but re-attempted on a future run. */
    failed: number[];
}

/** Embed + persist chunk vectors for an already-selected candidate batch.
 *  Shared by the project-wide passive drain and the session-scoped on-demand
 *  backfill. Provider calls are sub-batched by window count
 *  (`MAX_WINDOWS_PER_EMBED_CALL`) so a single large compartment (or a big
 *  `batchSize`) can't build one enormous payload tensor. Each compartment is the
 *  atomic persist unit — its windows are never split across provider calls. */
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
        // Raw-span text first; fall back to the compartment's summary (title+p1)
        // when the span has no indexable content (notification/tool-only beat),
        // so such compartments still get a real embedding row instead of being
        // re-counted as "remaining" forever (the desktop auto-embed loop).
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

    // Embed the prepared compartments in sub-batches bounded by window count so
    // the per-call payload (and the provider's padded tensor / JSON body) stays
    // bounded regardless of how many windows a single compartment produced.
    let embedded = 0;
    let i = 0;
    while (i < prepared.length) {
        if (signal?.aborted) break;
        const slice: Prepared[] = [];
        let windowCount = 0;
        // Always include at least one compartment, even if it alone exceeds the
        // cap (a single very large compartment must still be embeddable).
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

        // Retry the provider call a few times with backoff. The provider returns
        // null / all-null on failure (never throws), so we can't read the failure
        // reason — but we CAN time it: a fast failure (refused connection, 400,
        // brief blip) is worth a quick retry; a SLOW failure means the request hit
        // the provider's HTTP timeout, and re-sending the identical (too-big/too-
        // slow) payload would just burn another full timeout. So retry only when
        // the prior attempt failed FAST. With MAX_WINDOWS_PER_EMBED_CALL=2 a
        // healthy call returns in ~seconds, so this threshold cleanly separates a
        // transient blip from a genuine timeout.
        // Track WHICH compartments of the slice actually persisted (not just a
        // count). A provider can return vectors for some inputs in a call but not
        // others; with a count-only check, a partial-success slice would break the
        // retry loop AND skip the failed-marking, leaving the non-persisted
        // compartment neither saved nor excluded — so it gets re-queried (and
        // re-sent) every iteration until it's the last candidate. Tracking ids
        // lets us mark every NON-persisted item as failed regardless of partial
        // success, so the cursor advances past it (retried next run).
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
                // provider timeouts/rejections (PR #207 review).
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
            // Partial success: don't retry (would re-send the persisted items); the
            // non-persisted ones are marked failed below and retried next run.
            if (persistedIds.size > 0) break;
            // Don't retry a SLOW failure: it timed out, so the same payload will
            // just time out again. Mark failed and move on (retried next run).
            if (Date.now() - attemptStart >= EMBED_SLOW_FAILURE_NO_RETRY_MS) break;
            if (attempt < EMBED_SLICE_RETRY_ATTEMPTS - 1) {
                await new Promise((resolve) =>
                    setTimeout(resolve, EMBED_SLICE_RETRY_BASE_MS * 2 ** attempt),
                );
            }
        }

        embedded += persistedIds.size;
        // Every slice compartment that did NOT persist (full OR partial failure):
        // record as failed (not no-work) so the drain advances past it this run
        // and retries it next run, rather than re-selecting it every iteration.
        // Skip on abort — those simply didn't get their turn and re-queue naturally.
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
    // Every selected batch advances the run-local keyset cursor, including
    // no-work and failed rows. The cursor is not persisted, so provider
    // failures remain eligible for the next maintenance pass.
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

            // No-work rows do not reset provider health. Mixed no-work/failed
            // batches still prove the provider made no progress on attempted
            // inputs; successful persistence resets the failure streak.
            if (embedded === 0 && failed.length > 0) {
                consecutiveFailedBatches += 1;
                if (consecutiveFailedBatches >= MAX_CONSECUTIVE_FAILED_BATCHES) break;
            } else if (embedded > 0) {
                consecutiveFailedBatches = 0;
            }

            // An all-no-work batch performs no provider await. Yield explicitly
            // so timers, lease cancellation, and request handling stay live while
            // the cursor walks a long no-work prefix.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        clearInterval(renewal);
        releaseGitSweepLease(db, projectIdentity, holderId);
    }
    return total;
}

/** Passive missing-chunk drain for one project. `deadlineAt` is the shared
 *  wall-clock budget of the maintenance pass that invoked it — callers that
 *  iterate several projects must pass ONE deadline across all of them so a
 *  multi-project pass cannot outrun the caller's own schedule. */
export async function embedUnembeddedCompartmentChunksForProject(
    db: Database,
    projectIdentity: string,
    deadlineAt: number = Date.now() + SWEEP_MAX_WALL_CLOCK_MS,
): Promise<number> {
    return drainCompartmentChunkBacklogForProject(db, projectIdentity, deadlineAt);
}

export interface SessionChunkBackfillProgress {
    /** Compartments fully embedded so far this run. */
    embedded: number;
    /** Total compartments that needed embedding when the run started. */
    total: number;
}

export type SessionChunkBackfillOutcome =
    | { status: "done"; embedded: number; total: number; failed: number }
    | { status: "nothing"; embedded: 0; total: 0 }
    | { status: "disabled"; embedded: 0; total: 0 }
    | { status: "busy"; embedded: 0; total: number }
    | { status: "aborted"; embedded: number; total: number; failed: number }
    // Some candidates could not be embedded this run (provider returned no
    // vectors for them after retries) and were not skippable no-work rows —
    // surfaced so the command can tell the user it stopped early (with how many
    // failed) instead of falsely "done". `remaining` is still-embeddable count.
    | { status: "stalled"; embedded: number; total: number; remaining: number; failed: number };

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
    // The session command path resolves this identity from the host session;
    // persist it before counting so stale rows under another project cannot make
    // this session look already embedded forever.
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

    // Unbounded run → renew the lease before the TTL lapses so a sibling process
    // or the passive sweep can't acquire the "expired" lease mid-run (mirrors the
    // git sweep's renewal loop). Cleared in finally.
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
            /* best-effort; the current lease remains valid until its TTL */
        }
    }, SESSION_EMBED_LEASE_RENEWAL_MS);
    (renewal as { unref?: () => void }).unref?.();

    const batchSize = Math.max(1, options?.batchSize ?? CHUNK_DRAIN_BATCH_SIZE);
    // Compartments that produced no embeddable work (empty canonical text /
    // already-current windows) accumulate here and are excluded from subsequent
    // candidate queries, so one un-embeddable old compartment can't block the
    // oldest-first cursor from reaching newer ones (no infinite re-select).
    const skipIds: number[] = [];
    // Compartments the provider couldn't embed THIS run (after retries). Excluded
    // so the cursor advances past them and the drain finishes the rest, but NOT
    // persisted as skip — a future run re-attempts them.
    const failedIds: number[] = [];
    let embedded = 0;
    let aborted = false;
    let providerDown = false;
    let consecutiveFailedBatches = 0;
    try {
        options?.onProgress?.({ embedded, total });
        // Re-query each iteration (rather than pre-loading all candidates) so
        // newly-published compartments mid-run are picked up and chunk_hash dedup
        // is re-checked against fresh state. `total` is the start-of-run
        // denominator; `embedded` is clamped to it in the callback in case the
        // historian published mid-run.
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
            // Record no-work candidates so the next query advances past them.
            for (const id of noWork) skipIds.push(id);
            // Record this-run failures so the cursor advances; retried next run.
            for (const id of failed) failedIds.push(id);

            // Circuit breaker: a batch that made zero forward progress and had no
            // skippable no-work rows is an all-failed batch. A few in a row means
            // the provider is down — stop instead of grinding every remaining
            // compartment through retries against a dead endpoint.
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
            // Yield to the event loop so the burst stays interruptible and the
            // host process can serve other work between batches.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        clearInterval(renewal);
        options?.signal?.removeEventListener("abort", forwardCallerAbort);
        try {
            releaseGitSweepLease(db, projectIdentity, holderId);
        } catch (error) {
            // A release-time SQLite error (e.g. lock contention) must not mask the
            // drain's own result/throw. The lease TTL-expires on its own.
            log("[magic-context] embed drain: lease release failed (will TTL-expire):", error);
        }
    }
    if (aborted) return { status: "aborted", embedded, total, failed: failedIds.length };
    // Either the provider went down (circuit broke) or some compartments failed
    // their retries but the rest drained. Count what's genuinely still embeddable
    // (excludes already-embedded rows; no-work skips are permanently empty-text
    // compartments, not a stall).
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
    /** Whether embedding is active at all for this project. */
    enabled: boolean;
    /** Friendly configured model name, or "off"/"disabled". */
    model: string;
    /** Configured provider kind ("local" / "openai-compatible" / "ollama" / "off"). */
    provider: string;
    /** This session's compartment-chunk coverage. */
    session: { embedded: number; total: number };
    /** Project-wide active-memory coverage. */
    memories: { embedded: number; total: number };
    /** Project-wide git-commit coverage (only meaningful when gitEnabled). */
    commits: { embedded: number; total: number; gitEnabled: boolean };
}

/**
 * Gather the embedding-coverage status for `/ctx-embed` (no-arg): which model is
 * active, and how much of this session's history / the project's memories /
 * git commits are embedded under it. Pure reads — no provider calls.
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
            memories: { embedded: 0, total: 0 },
            commits: { embedded: 0, total: 0, gitEnabled: false },
        };
    }
    const session = countSessionCompartmentEmbedCoverage(
        db,
        projectIdentity,
        sessionId,
        snapshot.chunkModelId,
    );
    const memories = getMemoryEmbedCoverage(db, projectIdentity, snapshot.modelId);
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
        memories,
        commits,
    };
}

export async function sweepAllRegisteredProjects(
    db: Database,
    batchSize = 10,
): Promise<{
    memoriesEmbedded: number;
    commitsEmbedded: number;
    chunksEmbedded: number;
    perProject: Map<string, { memories: number; commits: number; chunks: number }>;
}> {
    if (projectSweepInProgress) {
        log("[magic-context] project embedding sweep already in progress, skipping this tick");
        return {
            memoriesEmbedded: 0,
            commitsEmbedded: 0,
            chunksEmbedded: 0,
            perProject: new Map(),
        };
    }

    projectSweepInProgress = true;
    const startedAt = Date.now();
    const deadline = startedAt + SWEEP_MAX_WALL_CLOCK_MS;
    const perProject = new Map<string, { memories: number; commits: number; chunks: number }>();
    let memoriesEmbedded = 0;
    let commitsEmbedded = 0;
    let chunksEmbedded = 0;

    try {
        for (const projectIdentity of projectRegistrations.keys()) {
            let memories = 0;
            let commits = 0;
            let chunks = 0;
            let consecutiveEmpty = 0;

            while (Date.now() < deadline) {
                const count = await embedUnembeddedMemoriesForProject(
                    db,
                    projectIdentity,
                    batchSize,
                );
                if (count === 0) {
                    consecutiveEmpty += 1;
                    if (consecutiveEmpty >= SWEEP_MAX_CONSECUTIVE_EMPTY) break;
                    break;
                }
                consecutiveEmpty = 0;
                memories += count;
                memoriesEmbedded += count;
                if (count < batchSize) break;
            }

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

            perProject.set(projectIdentity, { memories, commits, chunks });
            if (Date.now() >= deadline) break;
        }
    } finally {
        projectSweepInProgress = false;
    }

    return { memoriesEmbedded, commitsEmbedded, chunksEmbedded, perProject };
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
