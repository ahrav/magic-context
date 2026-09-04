import type { EmbeddingConfig } from "../config/schema/magic-context";
import type { Database } from "../shared/sqlite";
export type LoadOutcome = "ok" | "project-file-parse-error" | "project-file-io-error" | "legacy-config-unmigrated" | "schema-recovery" | "substitution-failure";
export interface EmbeddingLoadResultDetailed<TConfig extends {
    embedding: EmbeddingConfig;
}> {
    config: TConfig;
    loadOutcome: LoadOutcome;
    sources: {
        userConfig: LoadOutcome;
        projectConfig: LoadOutcome;
    };
    substitutionFailures: Array<{
        keyPath: string;
        source: "user" | "project";
        message: string;
    }>;
    recoveredTopLevelKeys: string[];
}
export declare const EMBEDDING_AFFECTING_KEYS: Set<string>;
export declare const EMBEDDING_AFFECTING_TOP_LEVEL_KEYS: Set<string>;
export declare function isConfigLoadUntrusted(detailed: EmbeddingLoadResultDetailed<{
    embedding: EmbeddingConfig;
}>): boolean;
export declare function describeFailure(detailed: EmbeddingLoadResultDetailed<{
    embedding: EmbeddingConfig;
}>): string;
export declare function logConfigFailureOnce(projectIdentity: string, detailed: EmbeddingLoadResultDetailed<{
    embedding: EmbeddingConfig;
}>): void;
export declare function handleUntrustedLoad(db: Database, projectIdentity: string, directory: string, detailed: EmbeddingLoadResultDetailed<{
    embedding: EmbeddingConfig;
}>): boolean;
export declare function _resetEmbeddingConfigFailureLogsForTests(): void;
//# sourceMappingURL=embedding-bootstrap-helpers.d.ts.map