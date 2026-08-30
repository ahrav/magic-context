/** Re-export surface over the project-scoped embedding registry.
 *  Embedding is per project: providers are created and cached in
 *  `project-embedding-registry`; this module re-exports that surface. */
export type {
    EmbeddingFeatures,
    ProjectEmbeddingRegistrationSnapshot,
} from "../project-embedding-registry";
export {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    contentSha256,
    embedBatchForProject,
    embedCommitRowsForProject,
    embedCompartmentWindowsDetailedForProject,
    embedItemsForProject,
    embedShadowTextForProject,
    embedTextForProject,
    embedUnembeddedCompartmentChunksForProject,
    enqueueShadowEmbeddingItems,
    flushShadowEmbeddingBacklog,
    getPrimaryEmbeddingMeasurementCohort,
    getProjectEmbeddingMaxInputBytes,
    getProjectEmbeddingSnapshot,
    getShadowBackfillRemaining,
    getShadowBackfillStopReason,
    getShadowEmbeddingMeasurementCohort,
    markProjectLoadUntrusted,
    registerProjectEmbedding,
    registerProjectInObservationMode,
    registerProjectShadowEmbedding,
    type ShadowEmbeddingMeasurementCohort,
    sweepAllRegisteredProjects,
} from "../project-embedding-registry";
