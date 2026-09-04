import type { PromptSurfaceConfig } from "../shared/prompt-surface";
import { type MagicContextConfig } from "./schema/magic-context";
export interface MagicContextPluginConfig extends MagicContextConfig {
    disabled_hooks?: string[];
    command?: Record<string, {
        template: string;
        description?: string;
        agent?: string;
        model?: string;
        subtask?: boolean;
    }>;
}
export type LoadOutcome = "ok" | "project-file-parse-error" | "project-file-io-error" | "legacy-config-unmigrated" | "schema-recovery" | "substitution-failure";
export interface LoadResultDetailed {
    config: MagicContextPluginConfig & {
        configWarnings?: string[];
    };
    /** USER-tier default/overrides captured before project routing is merged. */
    registrationPromptSurface: PromptSurfaceConfig;
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
export declare function loadPluginConfig(directory: string): MagicContextPluginConfig & {
    configWarnings?: string[];
};
export declare function loadPluginConfigDetailed(directory: string): LoadResultDetailed;
//# sourceMappingURL=index.d.ts.map