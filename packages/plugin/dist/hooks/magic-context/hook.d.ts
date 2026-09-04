import { type DreamerConfig, type HistorianConfig, type SidekickConfig } from "../../config/schema/magic-context";
import type { ResolvedTransformMode } from "../../config/transform-mode";
import type { createCompactionHandler } from "../../features/magic-context/compaction";
import type { Scheduler } from "../../features/magic-context/scheduler";
import type { Tagger } from "../../features/magic-context/tagger";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import type { PluginContext } from "../../plugin/types";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import type { Database } from "../../shared/sqlite";
import type { RustModeModuleClient } from "./rust-mode-transform";
export type { CommandExecuteInput, CommandExecuteOutput } from "./command-handler";
import type { LiveSessionState } from "./live-session-state";
export interface MagicContextDeps {
    client: PluginContext["client"];
    directory: string;
    tagger: Tagger;
    scheduler: Scheduler;
    onSessionCacheInvalidated?: (sessionId: string) => void;
    compactionHandler: ReturnType<typeof createCompactionHandler>;
    liveSessionState?: LiveSessionState;
    config: {
        protected_tags: number;
        /** User-level setting that lets a session started exactly in the canonical home directory use it as the project. */
        allow_home_project?: boolean;
        language?: string;
        smart_drops?: boolean;
        toast_duration_ms?: number;
        clear_reasoning_age?: number;
        execute_threshold_percentage?: number | {
            default: number;
            [modelKey: string]: number;
        };
        execute_threshold_tokens?: {
            default?: number;
            [modelKey: string]: number | undefined;
        };
        cache_ttl: string | Record<string, string>;
        prompt_surface?: PromptSurfaceConfig;
        historian?: HistorianConfig;
        history_budget_percentage?: number;
        historian_timeout_ms?: number;
        memory?: {
            enabled: boolean;
            injection_budget_tokens: number;
            /** When true, historian/recomp auto-promote eligible session facts
             *  to project memories. When false, promotion is skipped. Issue #44. */
            auto_promote?: boolean;
            /** Graduated from experimental.auto_search; now memory-scoped. */
            auto_search?: {
                enabled: boolean;
                score_threshold: number;
                min_prompt_chars: number;
            };
        };
        embedding?: {
            provider?: "local" | "openai-compatible" | "off" | "synapse";
        };
        sidekick?: SidekickConfig;
        dreamer?: DreamerConfig;
        smart_notes?: {
            retina_handoff?: boolean;
        };
        commit_cluster_trigger?: {
            enabled: boolean;
            min_clusters: number;
        };
        /** Issue #53: per-agent system-prompt injection opt-out. Optional in
         *  the inline type so legacy tests/callers don't have to construct it;
         *  Zod's .default() guarantees it's present in real loaded configs. */
        system_prompt_injection?: {
            enabled: boolean;
            skip_signatures: string[];
        };
        temporal_awareness?: boolean;
        caveman_text_compression?: {
            enabled: boolean;
            min_chars: number;
        };
        transform_mode?: ResolvedTransformMode;
        subc?: {
            connection_file: string;
        };
        /** Compaction-off mode gate (issue #266). Resolved ONCE here at the
         *  session-hook construction boundary via isCompactionEnabled; the
         *  resolved boolean is threaded to the transform phases. */
        compaction?: {
            enabled?: boolean;
        };
        mural?: {
            enabled: boolean;
            model?: string;
        };
    };
    /** Registration-owned prompt-surface loader shared with the tool registry. */
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    /** Test seam for the Rust authority adapter; production creates the subc client. */
    rustModeModuleClient?: RustModeModuleClient;
    /** Test and async-boot seam for supplying a database already opened by the caller. */
    openDatabaseForHook?: () => Database | null;
}
export declare function createMagicContextHook(deps: MagicContextDeps): ({
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
    rustToolBackends?: RustToolBackends;
}) | null;
/**
 * Async boot entry point. Migration lock retries must yield between attempts,
 * while the hook itself remains synchronous once a database is available.
 */
export declare function createMagicContextHookAsync(deps: MagicContextDeps): Promise<ReturnType<typeof createMagicContextHook>>;
//# sourceMappingURL=hook.d.ts.map