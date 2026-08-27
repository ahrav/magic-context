import { createHash } from "node:crypto";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    embedShadowTextForProject,
    getPrimaryEmbeddingMeasurementCohort,
    getShadowEmbeddingMeasurementCohort,
} from "./memory/embedding";
import { encodePhysicalResultLocator } from "./physical-result-locator";
import type { CapturedQueryEmbedding, UnifiedSearchOptions, UnifiedSearchResult } from "./search";
import { recordEmbeddingMeasurement } from "./storage-embedding-measurements";

export async function recordShadowMeasurement(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    query: string;
    options: UnifiedSearchOptions;
    primaryResults: UnifiedSearchResult[];
    primaryQuery: CapturedQueryEmbedding | null;
    primaryLatencyMs: number;
    search: (
        db: Database,
        sessionId: string,
        projectPath: string,
        query: string,
        options: UnifiedSearchOptions,
    ) => Promise<UnifiedSearchResult[]>;
}): Promise<void> {
    // Shadow measurement is pure telemetry, fired with `void` off the search
    // results path: it must never reject. A throw anywhere in this body (e.g.
    // SQLITE_BUSY on the measurement write) would surface as an unhandled
    // promise rejection in the host process, so the whole body is guarded.
    try {
        const shadowCohort = getShadowEmbeddingMeasurementCohort(args.projectPath);
        if (!shadowCohort) return;
        const primaryCohort = getPrimaryEmbeddingMeasurementCohort(args.projectPath);
        const shadowStartedAt = Date.now();
        let shadowFailed = false;
        let shadowResults: UnifiedSearchResult[] = [];
        try {
            const vector = await embedShadowTextForProject(args.projectPath, args.query);
            if (!vector) {
                shadowFailed = true;
            } else {
                shadowResults = await args.search(
                    args.db,
                    args.sessionId,
                    args.projectPath,
                    args.query,
                    {
                        ...args.options,
                        embedQuery: async () => vector,
                        isEmbeddingRuntimeEnabled: () => true,
                        embeddingEnabled: true,
                        embeddingModelIdOverride: shadowCohort.modelId,
                        chunkModelIdOverride: shadowCohort.chunkModelId,
                        measurementDisabled: true,
                        countRetrievals: false,
                    },
                );
            }
        } catch {
            shadowFailed = true;
        }

        const primaryModelId = args.primaryQuery?.modelId ?? primaryCohort?.modelId ?? "";
        const primaryFingerprint = primaryCohort?.fingerprint ?? "";
        const primaryEpoch = primaryCohort?.epoch ?? 0;
        const cohortKey = JSON.stringify({
            primaryFingerprint,
            primaryEpoch,
            shadowFingerprint: shadowCohort.fingerprint,
            shadowEpoch: shadowCohort.epoch,
        });
        const primaryIds = args.primaryResults.map(encodePhysicalResultLocator);
        const shadowIds = shadowResults.map(encodePhysicalResultLocator);
        const corpusHash = sha256(JSON.stringify({ query: args.query, primaryIds, shadowIds }));
        recordEmbeddingMeasurement(args.db, {
            sessionId: args.sessionId,
            projectPath: args.projectPath,
            queryText: args.query,
            cohortKey,
            primaryResultIds: primaryIds,
            shadowResultIds: shadowIds,
            primaryLatencyMs: args.primaryLatencyMs,
            shadowLatencyMs: Date.now() - shadowStartedAt,
            primaryFailed: args.primaryQuery === null,
            shadowFailed,
            primaryModelId,
            shadowModelId: shadowCohort.modelId,
            primaryFingerprint,
            shadowFingerprint: shadowCohort.fingerprint,
            primaryEpoch,
            shadowEpoch: shadowCohort.epoch,
            corpusHash,
            coverage: {
                primaryResultCount: primaryIds.length,
                shadowResultCount: shadowIds.length,
                primaryAnswered: args.primaryQuery !== null,
                shadowAnswered: !shadowFailed,
            },
        });
    } catch (error) {
        log("[magic-context] shadow embedding measurement failed:", error);
    }
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}
