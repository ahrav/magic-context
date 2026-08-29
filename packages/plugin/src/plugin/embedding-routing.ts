import type {
    EmbeddingConfig,
    EmbeddingFallbackProvider,
    MagicContextConfig,
} from "../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../config/schema/magic-context";
import {
    getSynapseLaneIdentity,
    SYNAPSE_DEFAULT_MODEL,
    SYNAPSE_MAX_INPUT_BYTES,
    SYNAPSE_MAX_INPUT_TOKENS,
} from "../features/magic-context/memory/embedding-synapse";
import type { ConnectionOrigin } from "../shared/mc-host-lifecycle";

export interface ResolvedSynapseEmbeddingConfig {
    provider: "synapse";
    model: string;
    /** Advertised per-input token window; SYNAPSE_MAX_INPUT_TOKENS when the
     *  catalog omits it. */
    max_input_tokens: number;
    /** Advertised UTF-8 byte ceiling for one input. */
    synapse_max_input_bytes: number;
    synapse_connection_file?: string;
    synapse_connection_origin: ConnectionOrigin;
    synapse_fallback?: EmbeddingConfig;
    synapse_fingerprint?: string;
    synapse_table_epoch?: number;
    // Dims are absent until the first embed response pins them; the registry
    // treats a missing value as adopt-on-first-write.
    synapse_dims?: number;
    synapse_recommended_batch?: number;
    synapse_recommended_token_budget?: number;
    synapse_provenance?: unknown;
}

export interface ResolvedEmbeddingRouting {
    /** Provider config for the authoritative lane. */
    primary: EmbeddingConfig | ResolvedSynapseEmbeddingConfig;
    /** Separate Synapse config for the developer mirror, when armed. */
    shadow: ResolvedSynapseEmbeddingConfig | null;
    /** Human-readable warnings produced while selecting a lane. */
    warnings: string[];
}

function fallbackConfig(
    config: EmbeddingConfig,
    provider: EmbeddingFallbackProvider | undefined,
): EmbeddingConfig {
    // SAFETY: each fallback field is narrowed before use.
    const raw = config as unknown as Record<string, unknown>;
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
    const apiKey = typeof raw.api_key === "string" ? raw.api_key.trim() : "";
    const inputType = typeof raw.input_type === "string" ? raw.input_type.trim() : "";
    const queryInputType =
        typeof raw.query_input_type === "string" ? raw.query_input_type.trim() : "";
    const truncate = typeof raw.truncate === "string" ? raw.truncate.trim() : "";
    const maxInputTokens =
        typeof raw.max_input_tokens === "number" ? raw.max_input_tokens : undefined;

    if (provider === "off") return { provider: "off" };
    if (provider === "openai-compatible") {
        return {
            provider: "openai-compatible",
            model,
            endpoint,
            ...(apiKey ? { api_key: apiKey } : {}),
            ...(inputType ? { input_type: inputType } : {}),
            ...(queryInputType ? { query_input_type: queryInputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(maxInputTokens !== undefined ? { max_input_tokens: maxInputTokens } : {}),
        };
    }
    return {
        provider: "local",
        model: model || DEFAULT_LOCAL_EMBEDDING_MODEL,
        ...(maxInputTokens !== undefined ? { max_input_tokens: maxInputTokens } : {}),
    };
}

function deferredSynapseConfig(
    config: EmbeddingConfig,
    subc: MagicContextConfig["subc"],
    fallback?: EmbeddingConfig,
): ResolvedSynapseEmbeddingConfig {
    const model =
        config.provider === "synapse" && "model" in config
            ? config.model || SYNAPSE_DEFAULT_MODEL
            : SYNAPSE_DEFAULT_MODEL;
    return {
        provider: "synapse",
        model,
        max_input_tokens: SYNAPSE_MAX_INPUT_TOKENS,
        synapse_max_input_bytes: SYNAPSE_MAX_INPUT_BYTES,
        synapse_connection_origin: subc ? "explicit" : "managed-default",
        ...(subc ? { synapse_connection_file: subc.connection_file } : {}),
        ...(fallback ? { synapse_fallback: fallback } : {}),
    };
}

/**
 * Translate the configured embedding block into lane intents. Synapse lanes
 * are deferred (no daemon probe here): the registry resolves them on first
 * use and only then persists an identity, so a fallback vector can never be
 * written under a Synapse identity. The registry receives only the selected
 * lane's provider fields, not the raw routing controls.
 */
export async function resolveEmbeddingRouting(args: {
    config: MagicContextConfig;
}): Promise<ResolvedEmbeddingRouting> {
    const config = args.config.embedding;
    const { subc } = args.config;
    const shadowEnabled = args.config.shadow_embedding?.enabled === true;
    const warnings: string[] = [];

    if (config.provider !== "synapse") {
        let shadow: ResolvedSynapseEmbeddingConfig | null = null;
        if (shadowEnabled && config.provider === "off") {
            warnings.push("shadow_embedding is ignored when embedding.provider is off");
        } else if (shadowEnabled) {
            shadow = deferredSynapseConfig(config, subc);
        }
        return { primary: config, shadow, warnings };
    }

    if (shadowEnabled) {
        warnings.push("shadow_embedding is ignored when the primary provider is synapse");
    }

    const fallbackProvider = config.fallback_provider;
    const fallback = fallbackConfig(config, fallbackProvider);
    if (!fallbackProvider) {
        warnings.push(
            "embedding.provider synapse requires embedding.fallback_provider; using local fallback",
        );
        return {
            primary: deferredSynapseConfig(config, subc, fallbackConfig(config, "local")),
            shadow: null,
            warnings,
        };
    }

    return {
        primary: deferredSynapseConfig(config, subc, fallback),
        shadow: null,
        warnings,
    };
}
