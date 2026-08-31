import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import { isCompactionEnabled, isDreamerRunnable } from "../config/agent-disable";
import { DEFAULT_PROTECTED_TAGS } from "../features/magic-context/defaults";
import { resolveProjectIdentityForSession } from "../features/magic-context/memory/project-identity";
import {
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "../features/magic-context/storage";
import { setCtxReduceRegisteredGlobally } from "../hooks/magic-context/ctx-reduce-availability";
import { getErrorMessage } from "../shared/error-message";
import { log } from "../shared/logger";
import type { PromptSurfaceConfig } from "../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../shared/prompt-surface-runtime";
import { createPromptSurfaceRuntime } from "../shared/prompt-surface-runtime";
import type { Database } from "../shared/sqlite";
import { createCtxExpandTools } from "../tools/ctx-expand";
import { CTX_MEMORY_ACTIONS, createCtxMemoryTools } from "../tools/ctx-memory";
import { createCtxNoteTools } from "../tools/ctx-note";
import { createCtxReduceTools } from "../tools/ctx-reduce";
import { createCtxSearchTools } from "../tools/ctx-search";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./embedding-bootstrap";
import { normalizeToolArgSchemas } from "./normalize-tool-arg-schemas";
import type { RustToolBackends } from "./rust-tool-backends";
import type { PluginContext } from "./types";

/**
 *
 */
const COMPACTION_OFF_REMOVED_TOOL_IDS = ["ctx_reduce"] as const;

/**
 */
export function getCompactionOffRemovedToolIds(): readonly string[] {
    return COMPACTION_OFF_REMOVED_TOOL_IDS;
}

export function createToolRegistry(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    rustToolBackends?: RustToolBackends;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    registrationPromptSurface?: PromptSurfaceConfig;
}): Record<string, ToolDefinition> {
    const { ctx, pluginConfig, rustToolBackends } = args;

    if (pluginConfig.enabled !== true) {
        return {};
    }

    const compactionOff = !isCompactionEnabled(pluginConfig);
    setCtxReduceRegisteredGlobally(!compactionOff);

    // Do not expose `ctx_*` tools unless persistent storage is healthy.
    let db: Database;
    try {
        const opened = openDatabase();
        if (!opened || !isDatabasePersisted(opened)) {
            const reason = getDatabasePersistenceError(opened);
            console.warn(
                `[magic-context] persistent storage unavailable; disabling magic-context tools${reason ? `: ${reason}` : ""}`,
            );
            return {};
        }
        db = opened;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(
            `[magic-context] persistent storage unavailable; disabling magic-context tools: ${reason}`,
        );
        return {};
    }

    // `ensureProjectRegisteredFromOpenCodeDirectory` failures must not create unhandled rejections during plugin initialization.
    void ensureProjectRegisteredFromOpenCodeDirectory(ctx.directory, db).catch((error) => {
        log(`[magic-context] embedding registration skipped: ${getErrorMessage(error)}`);
    });

    const resolveProjectPath = (directory: string) =>
        resolveProjectIdentityForSession(directory, pluginConfig.allow_home_project);

    const memoryEnabled = pluginConfig.memory?.enabled !== false;
    const allTools: Record<string, ToolDefinition> = {
        ...(compactionOff
            ? {}
            : createCtxReduceTools({
                  db,
                  protectedTags: pluginConfig.protected_tags ?? DEFAULT_PROTECTED_TAGS,
                  rustToolBackends,
              })),
        ...createCtxExpandTools({ db }),
        ...createCtxNoteTools({
            db,
            dreamerEnabled: isDreamerRunnable(pluginConfig),
            resolveProjectPath,
            rustToolBackends,
        }),
        ...createCtxSearchTools({
            db,
            resolveProjectPath,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        }),
        ...(memoryEnabled
            ? createCtxMemoryTools({
                  db,
                  resolveProjectPath,
                  ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
                  allowedActions: [...CTX_MEMORY_ACTIONS],
                  rustToolBackends,
              })
            : {}),
    };

    const promptSurfaceRuntime =
        args.promptSurfaceRuntime ??
        createPromptSurfaceRuntime({
            harness: "opencode",
            directory: ctx.directory,
            warn: (message) => console.warn(`[magic-context] config warning: ${message}`),
        });
    const registration = promptSurfaceRuntime.resolveRegistration(
        args.registrationPromptSurface ?? pluginConfig.prompt_surface,
    );
    const surfacedTools = Object.fromEntries(
        Object.entries(allTools).map(([toolId, definition]) => [
            toolId,
            {
                ...definition,
                description: registration.descriptionFor(toolId, definition.description ?? ""),
            },
        ]),
    ) as Record<string, ToolDefinition>;

    for (const toolDefinition of Object.values(surfacedTools)) {
        normalizeToolArgSchemas(toolDefinition);
    }

    return surfacedTools;
}
