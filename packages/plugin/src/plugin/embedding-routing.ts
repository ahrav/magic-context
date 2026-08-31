import type {
    EmbeddingConfig,
    EmbeddingFallbackProvider,
    MagicContextConfig,
} from "../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../config/schema/magic-context";
import {
    SYNAPSE_DEFAULT_MODEL,
    SYNAPSE_MAX_INPUT_BYTES,
    SYNAPSE_MAX_INPUT_TOKENS,
} from "../features/magic-context/memory/embedding-synapse";
import type { ConnectionOrigin } from "../shared/mc-host-lifecycle";

export interface ResolvedSynapseEmbeddingConfig {
    provider: "synapse";
    model: string;
    /** `max_input_tokens` defaults to `SYNAPSE_MAX_INPUT_TOKENS` when the catalog omits the advertised window.
     * */
    max_input_tokens: number;
    /** `synapse_max_input_bytes` is the advertised UTF-8 byte ceiling for one input. */
    synapse_max_input_bytes: number;
    synapse_connection_file?: string;
    synapse_connection_origin: ConnectionOrigin;
    synapse_fallback?: EmbeddingConfig;
    synapse_fingerprint?: string;
    synapse_table_epoch?: number;
    // `synapse_dims` remains absent until the first embed response pins its value.
    // The registry adopts `synapse_dims` on the first write when it is missing.
    synapse_dims?: number;
    synapse_recommended_batch?: number;
    synapse_recommended_token_budget?: number;
    synapse_provenance?: unknown;
}

export interface ResolvedEmbeddingRouting {
    /** `primary` supplies the authoritative lane's provider config. */
    primary: EmbeddingConfig | ResolvedSynapseEmbeddingConfig;
    /** `shadow` supplies a separate Synapse config for the armed developer mirror. */
    shadow: ResolvedSynapseEmbeddingConfig | null;
    /** `warnings` contains human-readable warnings from lane selection. */
    warnings: string[];
}

function fallbackConfig(
    config: EmbeddingConfig,
    provider: EmbeddingFallbackProvider | undefined,
): EmbeddingConfig {
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
 * Synapse identities are deferred without probing the daemon.
 * The registry persists a Synapse identity only on first use.
 * The registry never writes fallback vectors under Synapse identities.
 * The registry uses the lane's provider fields, not the raw routing controls.
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
