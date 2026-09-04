import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { cosineSimilarity } from "./cosine-similarity";
import type { EmbeddingPurpose } from "./embedding-provider";
export type { EmbeddingFeatures, ProjectEmbeddingRegistrationSnapshot, } from "../project-embedding-registry";
export { _resetProjectEmbeddingRegistryForTests, _setTestProviderFactoryForProject, contentSha256, embedBatchForProject, embedCommitRowsForProject, embedCompartmentWindowsDetailedForProject, embedItemsForProject, embedShadowTextForProject, embedTextForProject, embedUnembeddedCompartmentChunksForProject, enqueueShadowEmbeddingItems, flushShadowEmbeddingBacklog, getPrimaryEmbeddingMeasurementCohort, getProjectEmbeddingMaxInputBytes, getProjectEmbeddingSnapshot, getShadowBackfillRemaining, getShadowBackfillStopReason, getShadowEmbeddingMeasurementCohort, markProjectLoadUntrusted, registerProjectEmbedding, registerProjectInObservationMode, registerProjectShadowEmbedding, type ShadowEmbeddingMeasurementCohort, sweepAllRegisteredProjects, unregisterProjectEmbedding, } from "../project-embedding-registry";
export declare function initializeEmbedding(config: EmbeddingConfig): void;
export declare function isEmbeddingEnabled(): boolean;
/** Restores the module-default embedding config. Tests that call
 *  `initializeEmbedding` share this module's global state with every other
 *  test file in the process; resetting to a non-default config (e.g.
 *  `"off"`) would silently disable semantic lanes for later files. */
export declare function _resetEmbeddingConfigForTests(): void;
export declare function embedText(text: string, signal?: AbortSignal, purpose?: EmbeddingPurpose): Promise<Float32Array | null>;
export { cosineSimilarity };
//# sourceMappingURL=embedding.d.ts.map