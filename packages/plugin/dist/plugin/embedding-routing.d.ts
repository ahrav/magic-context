import type { EmbeddingConfig, MagicContextConfig } from "../config/schema/magic-context";
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
/**
 * Translate the configured embedding block into lane intents. Synapse lanes
 * are deferred (no daemon probe here): the registry resolves them on first
 * use and only then persists an identity, so a fallback vector can never be
 * written under a Synapse identity. The registry receives only the selected
 * lane's provider fields, not the raw routing controls.
 */
export declare function resolveEmbeddingRouting(args: {
    config: MagicContextConfig;
}): Promise<ResolvedEmbeddingRouting>;
export declare function getResolvedSynapseProviderIdentity(config: ResolvedSynapseEmbeddingConfig): string;
//# sourceMappingURL=embedding-routing.d.ts.map