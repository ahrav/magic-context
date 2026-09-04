import type { Database } from "../../shared/sqlite";
import type { CapturedQueryEmbedding, UnifiedSearchOptions, UnifiedSearchResult } from "./search";
export declare function recordShadowMeasurement(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    query: string;
    options: UnifiedSearchOptions;
    primaryResults: UnifiedSearchResult[];
    primaryQuery: CapturedQueryEmbedding | null;
    primaryLatencyMs: number;
    search: (db: Database, sessionId: string, projectPath: string, query: string, options: UnifiedSearchOptions) => Promise<UnifiedSearchResult[]>;
}): Promise<void>;
//# sourceMappingURL=search-measurement.d.ts.map