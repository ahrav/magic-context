import type { MagicContextPluginConfig } from "../../config";
import { DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE } from "../../config/schema/magic-context";
import { createCompactionHandler } from "../../features/magic-context/compaction";
import { DEFAULT_PROTECTED_TAGS } from "../../features/magic-context/defaults";
import { createScheduler } from "../../features/magic-context/scheduler";
import { createTagger } from "../../features/magic-context/tagger";
import { createMagicContextHookAsync } from "../../hooks/magic-context";
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
export function buildMagicContextHookConfig(pluginConfig: MagicContextPluginConfig) {
    // Pass the WHOLE plugin config through and only override the fields that
    // need defaulting. This was a hand-maintained field-by-field mapping, which
    // silently dropped every hook-config field added after the mapping was
    // written: `smart_drops`, `language`, `embedding`, and `transform_mode`
    // all read as undefined inside the hook even when set by
    // the user, turning opted-in features off with no warning. The hook only
    // consumes the fields its config type declares, so the extra top-level keys
    // carried by the spread are inert.
    return {
        ...pluginConfig,
        protected_tags: pluginConfig.protected_tags ?? DEFAULT_PROTECTED_TAGS,
        execute_threshold_percentage:
            pluginConfig.execute_threshold_percentage ?? DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    };
}

export async function createSessionHooksAsync(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    liveSessionState: LiveSessionState;
    rustModeModuleClient?: RustModeModuleClient;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
}) {
    const { ctx, pluginConfig, liveSessionState } = args;

    if (pluginConfig.enabled !== true) {
        return { magicContext: null, rustToolBackends: undefined };
    }

    const tagger = createTagger();
    const scheduler = createScheduler({
        executeThresholdPercentage:
            pluginConfig.execute_threshold_percentage ?? DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
        executeThresholdTokens: pluginConfig.execute_threshold_tokens,
    });
    const compactionHandler = createCompactionHandler();
    const hookResult = await createMagicContextHookAsync({
        client: ctx.client,
        directory: ctx.directory,
        tagger,
        scheduler,
        compactionHandler,
        liveSessionState,
        rustModeModuleClient: args.rustModeModuleClient,
        promptSurfaceRuntime: args.promptSurfaceRuntime,
        config: buildMagicContextHookConfig(pluginConfig),
    });

    return {
        magicContext: hookResult,
        rustToolBackends: hookResult?.rustToolBackends,
    };
}
