import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { getSynapseLaneIdentity } from "./embedding-synapse";
import { computeNormalizedHash } from "./normalize-hash";

function normalizeEndpoint(endpoint?: string): string {
    return endpoint?.trim().replace(/\/+$/, "") ?? "";
}

export type LocalEmbeddingPooling = "mean" | "cls";

/** A recipe fixes the pooling and query prefix required by a model card.
 * Omitting the required query prefix produces poor retrieval rankings.
 * Each recipe must remain keyed by model ID, not configuration.
 * Recipes stay in this module because `getEmbeddingProviderIdentity` depends on them. */
export interface LocalEmbeddingRecipe {
    pooling: LocalEmbeddingPooling;
    /** `queryPrefix` applies only to `"query"`-purpose inputs; passages remain unprefixed. */
    queryPrefix: string;
}

/** Models without an entry embed symmetrically: mean pooling, no instruction. */
const SYMMETRIC_RECIPE: LocalEmbeddingRecipe = { pooling: "mean", queryPrefix: "" };

const MODEL_RECIPES: Record<string, LocalEmbeddingRecipe> = {
    // BGE v1.5 CLS-pools and expects this exact retrieval instruction on short
    // queries: https://huggingface.co/BAAI/bge-small-en-v1.5#model-usage
    // Other spellings fall back to the symmetric recipe because fuzzy matching can silently apply wrong transforms.
    "Xenova/bge-small-en-v1.5": {
        pooling: "cls",
        queryPrefix: "Represent this sentence for searching relevant passages: ",
    },
    "BAAI/bge-small-en-v1.5": {
        pooling: "cls",
        queryPrefix: "Represent this sentence for searching relevant passages: ",
    },
};

export function getLocalEmbeddingRecipe(model: string): LocalEmbeddingRecipe {
    return MODEL_RECIPES[model] ?? SYMMETRIC_RECIPE;
}

/**
 * `getEmbeddingProviderIdentity` returns a stable identity for provider and pipeline reuse.
 *
 * The identity never hashes or stores the API key value.
 * Switching authentication modes recreates the provider.
 * Rotating an API key does not expose the key or change the provider identity.
 */
export function getEmbeddingProviderIdentity(config: EmbeddingConfig): string {
    if (config.provider === "off") {
        return "embedding-provider:off";
    }

    if (config.provider === "synapse") {
        const resolved = config as EmbeddingConfig & {
            model?: string;
            synapse_fingerprint?: string;
        };
        if (!resolved.model || !resolved.synapse_fingerprint) return "synapse:v1:pending";
        return getSynapseLaneIdentity(resolved.model, resolved.synapse_fingerprint);
    }

    if (config.provider !== "local" && config.provider !== "openai-compatible") {
        throw new Error("Unknown embedding provider");
    }

    const truncate = config.provider === "openai-compatible" ? config.truncate?.trim() : undefined;
    // local_dtype changes the produced vectors (a quantized ONNX model emits
    // different embeddings than fp32), so a non-default dtype MUST fold into the
    // model identity — switching dtype re-embeds rather than mixing vector
    // spaces. Spread CONDITIONALLY and EXCLUDE the default "fp32": omitting the
    // term when unset OR when set to the default keeps the identity byte-
    // identical for the common config, so adding this field does not force a
    // global re-embed on upgrade. Mirrors the truncate fold above.
    const localDtype =
        config.provider === "local" && config.local_dtype && config.local_dtype !== "fp32"
            ? config.local_dtype
            : undefined;
    const localRecipe =
        config.provider === "local"
            ? getLocalEmbeddingRecipe(config.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL)
            : undefined;
    const identityInput =
        config.provider === "openai-compatible"
            ? {
                  provider: "openai-compatible",
                  model: config.model.trim(),
                  endpoint: normalizeEndpoint(config.endpoint),
                  apiKeyPresent: Boolean(config.api_key?.trim()),
                  // For NIM, `input_type` selects vector spaces such as `query` and `passage`.
                  // `input_type` participates in identity so changing it re-embeds stored vectors.
                  // `truncate` changes the text embedded for over-long inputs.
                  // `truncate` participates in identity because changing it can change vectors for over-long inputs.
                  // `query_input_type` affects only per-call query requests, not stored passage vectors.
                  // `query_input_type` stays out of identity because it does not affect stored passage vectors.
                  inputType: config.input_type?.trim() || "",
                  ...(truncate ? { truncate } : {}),
              }
            : {
                  provider: "local",
                  model: config.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
                  endpoint: "",
                  apiKeyPresent: false,
                  ...(localDtype ? { localDtype } : {}),
                  ...(localRecipe &&
                  (localRecipe.pooling !== "mean" || localRecipe.queryPrefix !== "")
                      ? {
                            localRecipe: {
                                pooling: localRecipe.pooling,
                                queryPrefix: localRecipe.queryPrefix,
                            },
                        }
                      : {}),
              };

    return `embedding-provider:${computeNormalizedHash(JSON.stringify(identityInput))}`;
}
