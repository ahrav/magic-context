import type { EmbeddingConfig } from "../../../config/schema/magic-context";
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
export declare function getLocalEmbeddingRecipe(model: string): LocalEmbeddingRecipe;
/**
 * Stable embedding-provider identity used for provider/pipeline reuse.
 *
 * The API key value is intentionally never hashed or stored. Only key
 * presence participates in identity so switching between anonymous and
 * authenticated modes recreates the provider, while rotating a key does not
 * leak secret material into logs or persisted model ids.
 */
export declare function getEmbeddingProviderIdentity(config: EmbeddingConfig): string;
//# sourceMappingURL=embedding-identity.d.ts.map