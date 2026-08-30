import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { getSynapseLaneIdentity } from "./embedding-synapse";
import { computeNormalizedHash } from "./normalize-hash";

function normalizeEndpoint(endpoint?: string): string {
    return endpoint?.trim().replace(/\/+$/, "") ?? "";
}

export type LocalEmbeddingPooling = "mean" | "cls";

/** How a model's card says its vectors must be produced. Wrong pooling or a
 *  missing query instruction still yields plausible-looking vectors, just
 *  quietly bad rankings, so the recipe is bound to the model id rather than
 *  left to configuration. Defined here because the recipe participates in the
 *  provider identity below, and the provider module already imports this one. */
export interface LocalEmbeddingRecipe {
    pooling: LocalEmbeddingPooling;
    /** Prepended to `"query"`-purpose inputs only; passages embed unprefixed. */
    queryPrefix: string;
}

/** Models without an entry embed symmetrically: mean pooling, no instruction. */
const SYMMETRIC_RECIPE: LocalEmbeddingRecipe = { pooling: "mean", queryPrefix: "" };

const MODEL_RECIPES: Record<string, LocalEmbeddingRecipe> = {
    // BGE v1.5 CLS-pools and expects this exact retrieval instruction on short
    // queries: https://huggingface.co/BAAI/bge-small-en-v1.5#model-usage
    // Both the Xenova ONNX export and the upstream BAAI id name the same model
    // card, so both bind the same recipe. Other spellings deliberately fall
    // back to the symmetric recipe: guessing a recipe from a fuzzy name match
    // risks applying the wrong transforms, which corrupts silently.
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
 * Stable embedding-provider identity used for provider/pipeline reuse.
 *
 * The API key value is intentionally never hashed or stored. Only key
 * presence participates in identity so switching between anonymous and
 * authenticated modes recreates the provider, while rotating a key does not
 * leak secret material into logs or persisted model ids.
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
                  // input_type changes the embedding vector space (e.g. NIM
                  // 'query' vs 'passage'), so it participates in identity — a
                  // change must re-embed. truncate changes which text an over-long
                  // input actually embeds, so a change can shift those vectors and
                  // it participates too. (query_input_type shapes only per-call
                  // query requests, never the stored passage vectors, so it stays
                  // out.) truncate is spread CONDITIONALLY: omitting it when unset
                  // keeps the identity byte-identical for the common no-truncate
                  // config, so adding this term does not force a global re-embed —
                  // only configs that actually set truncate get a new identity
                  // (and under per-model coexistence even that just coexists +
                  // lazily GCs, never a destructive wipe).
                  inputType: config.input_type?.trim() || "",
                  ...(truncate ? { truncate } : {}),
              }
            : {
                  provider: "local",
                  model: config.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
                  endpoint: "",
                  apiKeyPresent: false,
                  ...(localDtype ? { localDtype } : {}),
                  // The recipe (pooling + query instruction) changes the produced
                  // vectors for the SAME model name: a bge-small vector embedded
                  // under the symmetric mean recipe is not comparable to one
                  // embedded under CLS with the query instruction. Folding the
                  // recipe in re-embeds installations whose stored vectors
                  // predate the model's bound recipe. Spread CONDITIONALLY and
                  // EXCLUDE the symmetric recipe, so models without a bound
                  // recipe keep a byte-identical identity — mirrors the
                  // localDtype fold above.
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
