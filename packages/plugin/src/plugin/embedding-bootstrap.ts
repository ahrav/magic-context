import { loadPluginConfigDetailed } from "../config";
import {
    type EmbeddingFeatures,
    registerProjectEmbedding,
    registerProjectShadowEmbedding,
} from "../features/magic-context/memory/embedding";
import { invalidateProject } from "../features/magic-context/memory/embedding-cache";
import { resolveProjectIdentityForSession } from "../features/magic-context/memory/project-identity";
import { log } from "../shared/logger";
import type { Database } from "../shared/sqlite";
import { handleUntrustedLoad, isConfigLoadUntrusted } from "./embedding-bootstrap-helpers";
import { resolveEmbeddingRouting } from "./embedding-routing";

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
    invalidateProject(projectIdentity);
    if (isConfigLoadUntrusted(detailed)) {
        handleUntrustedLoad(db, projectIdentity, directory, detailed);
        return;
    }

    const routing = await resolveEmbeddingRouting({ config: detailed.config });
    for (const warning of routing.warnings) {
        log(`[magic-context] ${warning}`);
    }

    const features: EmbeddingFeatures = {
        memoryEnabled: detailed.config.memory.enabled,
        gitCommitEnabled: detailed.config.memory.git_commit_indexing.enabled,
    };
    registerProjectEmbedding(db, projectIdentity, routing.primary, features, directory);
    if (routing.shadow) {
        registerProjectShadowEmbedding(db, projectIdentity, routing.shadow, directory);
    }
}
