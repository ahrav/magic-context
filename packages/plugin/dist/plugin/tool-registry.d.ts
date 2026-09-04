import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import type { PromptSurfaceConfig } from "../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../shared/prompt-surface-runtime";
import type { RustToolBackends } from "./rust-tool-backends";
import type { PluginContext } from "./types";
/**
 * The enumerated tool IDs removed in compaction-off mode (today exactly
 * `["ctx_reduce"]`). Exported so the acceptance test diffs the mode-off tool
 * set against the mode-on set and asserts the difference equals exactly this
 * list — a future tool the reduce factory grows appears here and fails the
 * diff rather than silently vanishing in compaction-off mode.
 */
export declare function getCompactionOffRemovedToolIds(): readonly string[];
export declare function createToolRegistry(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    rustToolBackends?: RustToolBackends;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    registrationPromptSurface?: PromptSurfaceConfig;
}): Record<string, ToolDefinition>;
//# sourceMappingURL=tool-registry.d.ts.map