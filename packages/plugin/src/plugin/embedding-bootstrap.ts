import { loadPluginConfigDetailed } from "../config";
import type { MagicContextConfig } from "../config/schema/magic-context";
import {
    type EmbeddingFeatures,
    registerProjectEmbedding,
    registerProjectShadowEmbedding,
} from "../features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "../features/magic-context/memory/project-identity";
import { log } from "../shared/logger";
import type { Database } from "../shared/sqlite";
import {
    type EmbeddingLoadResultDetailed,
    handleUntrustedLoad,
    isConfigLoadUntrusted,
} from "./embedding-bootstrap-helpers";
import { resolveEmbeddingRouting } from "./embedding-routing";

/**
 * Registers a project's embedding routing from an already-loaded config.
 * Returns false when the load is untrusted — the project is latched via
 * `handleUntrustedLoad` instead of registered — and true when registration ran.
 * Harness callers own config loading and any registration memoization.
 */
export async function registerProjectEmbeddingFromDetailedLoad(args: {
    db: Database;
    directory: string;
    projectIdentity: string;
    detailed: EmbeddingLoadResultDetailed<MagicContextConfig>;
    logPrefix: string;
}): Promise<boolean> {
    const { db, directory, projectIdentity, detailed, logPrefix } = args;
    if (isConfigLoadUntrusted(detailed)) {
        handleUntrustedLoad(db, projectIdentity, directory, detailed);
        return false;
    }

    const routing = await resolveEmbeddingRouting({ config: detailed.config });
    for (const warning of routing.warnings) {
        log(`${logPrefix} ${warning}`);
    }

    const features: EmbeddingFeatures = {
        memoryEnabled: detailed.config.memory.enabled,
        gitCommitEnabled: detailed.config.memory.git_commit_indexing.enabled,
    };
    registerProjectEmbedding(db, projectIdentity, routing.primary, features, directory);
    if (routing.shadow) {
        registerProjectShadowEmbedding(db, projectIdentity, routing.shadow, directory);
    }
    return true;
}

export async function ensureProjectRegisteredFromOpenCodeDirectory(
    directory: string,
    db: Database,
): Promise<void> {
    const detailed = loadPluginConfigDetailed(directory);
    const projectIdentity = resolveProjectIdentityForSession(
        directory,
        detailed.config.allow_home_project,
    );
    if (!projectIdentity) return;
    await registerProjectEmbeddingFromDetailedLoad({
        db,
        directory,
        projectIdentity,
        detailed,
        logPrefix: "[magic-context]",
    });
}
