import type { MagicContextPluginConfig } from "../../config";
import type { LiveSessionState } from "../../hooks/magic-context/live-session-state";
import type { RustModeModuleClient } from "../../hooks/magic-context/rust-mode-transform";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import type { PluginContext } from "../types";
/**
 * Map the full plugin config down to the per-session hook config. Pure and
 * exported so it can be unit-tested directly — without a module-level
 * `mock.module` of the hooks barrel, which in Bun leaks process-globally across
 * test files (mock.restore() does not undo it) and corrupts sibling suites that
 * import the real hook shape.
 */
export declare function buildMagicContextHookConfig(pluginConfig: MagicContextPluginConfig): {
    protected_tags: number;
    execute_threshold_percentage: number | {
        [modelKey: string]: number;
        default: number;
    };
    disabled_hooks?: string[];
    command?: Record<string, {
        template: string;
        description?: string;
        agent?: string;
        model?: string;
        subtask?: boolean;
    }>;
    enabled: boolean;
    allow_home_project: boolean;
    mural: import("../../config/schema/magic-context").MuralConfig;
    transform_mode: "ts" | "rust";
    auto_update?: boolean;
    language?: string;
    historian?: import("../../config/schema/magic-context").HistorianConfig;
    dreamer?: import("../../config/schema/magic-context").DreamerConfig;
    smart_notes: {
        retina_handoff: boolean;
    };
    cache_ttl: string | {
        default: string;
        [modelKey: string]: string;
    };
    prompt_surface: import("../../config/schema/magic-context").PromptSurfaceConfig;
    output_reserve?: number | {
        default: number;
        [modelKey: string]: number;
    };
    models?: {
        window_overlay_path?: string;
    };
    toast_duration_ms?: number;
    execute_threshold_tokens?: {
        default?: number;
        [modelKey: string]: number | undefined;
    };
    clear_reasoning_age: number;
    history_budget_percentage: number;
    historian_timeout_ms: number;
    commit_cluster_trigger: {
        enabled: boolean;
        min_clusters: number;
    };
    sqlite: {
        cache_size_mb: number;
        mmap_size_mb: number;
    };
    storage: {
        enforce_private_permissions: boolean;
    };
    system_prompt_injection: {
        enabled: boolean;
        skip_signatures: string[];
    };
    temporal_awareness: boolean;
    keep_subagents: boolean;
    fail_closed_blocking: boolean;
    compaction: {
        enabled: boolean;
    };
    todowrite: {
        enabled: boolean;
        overlay: boolean;
    };
    pi?: import("../../config/schema/magic-context").PiConfig;
    smart_drops: boolean;
    caveman_text_compression: {
        enabled: boolean;
        min_chars: number;
    };
    embedding: import("../../config/schema/magic-context").EmbeddingConfig;
    subc?: import("../../config/schema/magic-context").SubcConfig;
    shadow_embedding?: import("../../config/schema/magic-context").ShadowEmbeddingConfig;
    memory: {
        enabled: boolean;
        injection_budget_tokens: number;
        auto_promote: boolean;
        retrieval_count_promotion_threshold: number;
        auto_search: {
            enabled: boolean;
            score_threshold: number;
            min_prompt_chars: number;
        };
        git_commit_indexing: {
            enabled: boolean;
            since_days: number;
            max_commits: number;
        };
    };
    sidekick?: import("../../features/magic-context").SidekickConfig;
};
export declare function createSessionHooks(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    liveSessionState: LiveSessionState;
    rustModeModuleClient?: RustModeModuleClient;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
}): {
    magicContext: ({
        "experimental.chat.messages.transform": ((_input: Record<string, never>, output: {
            messages: unknown[];
        }) => Promise<void>) & {
            invalidateRustWireState(sessionId: string): void;
            clearRustSession(sessionId: string): void;
        };
        "experimental.chat.system.transform": (input: {
            sessionID?: string;
            model?: {
                providerID?: string;
                modelID?: string;
            };
        }, output: {
            system: string[];
        }) => Promise<void>;
        "experimental.text.complete": (_input: {
            sessionID: string;
            messageID: string;
            partID: string;
        }, output: {
            text: string;
        }) => Promise<void>;
        disposeNoteEvaluationBridges: () => Promise<void>;
        "chat.message": (input: {
            sessionID?: string;
            variant?: string;
            agent?: string;
            model?: {
                providerID?: string;
                modelID?: string;
            };
        }) => Promise<void>;
        event: (input: {
            event: {
                type: string;
                properties?: unknown;
            };
        }) => Promise<void>;
        "command.execute.before": (input: unknown, output: unknown) => Promise<unknown>;
        "tool.execute.after": (input: unknown, output?: unknown) => Promise<void>;
    } & {
        rustToolBackends?: import("../rust-tool-backends").RustToolBackends;
    }) | null;
    rustToolBackends: import("../rust-tool-backends").RustToolBackends | undefined;
};
export declare function createSessionHooksAsync(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    liveSessionState: LiveSessionState;
    rustModeModuleClient?: RustModeModuleClient;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
}): Promise<{
    magicContext: ({
        "experimental.chat.messages.transform": ((_input: Record<string, never>, output: {
            messages: unknown[];
        }) => Promise<void>) & {
            invalidateRustWireState(sessionId: string): void;
            clearRustSession(sessionId: string): void;
        };
        "experimental.chat.system.transform": (input: {
            sessionID?: string;
            model?: {
                providerID?: string;
                modelID?: string;
            };
        }, output: {
            system: string[];
        }) => Promise<void>;
        "experimental.text.complete": (_input: {
            sessionID: string;
            messageID: string;
            partID: string;
        }, output: {
            text: string;
        }) => Promise<void>;
        disposeNoteEvaluationBridges: () => Promise<void>;
        "chat.message": (input: {
            sessionID?: string;
            variant?: string;
            agent?: string;
            model?: {
                providerID?: string;
                modelID?: string;
            };
        }) => Promise<void>;
        event: (input: {
            event: {
                type: string;
                properties?: unknown;
            };
        }) => Promise<void>;
        "command.execute.before": (input: unknown, output: unknown) => Promise<unknown>;
        "tool.execute.after": (input: unknown, output?: unknown) => Promise<void>;
    } & {
        rustToolBackends?: import("../rust-tool-backends").RustToolBackends;
    }) | null;
    rustToolBackends: import("../rust-tool-backends").RustToolBackends | undefined;
}>;
//# sourceMappingURL=create-session-hooks.d.ts.map