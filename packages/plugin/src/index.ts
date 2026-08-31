import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";

import {
    buildHiddenAgentConfig,
    buildHiddenAgentRegistrations,
} from "./agents/hidden-agent-registrations";
import { withContentLanguageDirective } from "./agents/language-directive";
import { denyTaskRoutingToCallerAgents } from "./agents/permissions";
import { loadPluginConfigDetailed } from "./config";
import { isCompactionEnabled, isDreamerRunnable } from "./config/agent-disable";
import { migrateMagicContextConfigLocations } from "./config/migrate-config-location";
import { getMagicContextBuiltinCommands } from "./features/builtin-commands/commands";
import { DREAMER_SYSTEM_PROMPT } from "./features/magic-context/dreamer/task-prompts";
import type {
    DreamTaskName,
    DreamTaskProgress,
} from "./features/magic-context/dreamer/task-registry";
import {
    createFailClosedController,
    getLastHookInitFailure,
} from "./features/magic-context/fail-closed-block";
import { configureSynapseManagedDemandStart } from "./features/magic-context/memory/embedding-synapse";
import { resolveProjectIdentityForSession } from "./features/magic-context/memory/project-identity";
import { SIDEKICK_SYSTEM_PROMPT } from "./features/magic-context/sidekick/agent";
import { SMART_NOTE_COMPILER_SYSTEM_PROMPT } from "./features/magic-context/smart-notes/compiler-prompt";
import {
    getSchemaFenceRejection,
    setSqlitePragmaConfig,
} from "./features/magic-context/storage-db";
import { recordToolDefinition } from "./features/magic-context/tool-definition-tokens";
import { createAutoUpdateCheckerHook } from "./hooks/auto-update-checker";
import {
    COMPARTMENT_AGENT_SYSTEM_PROMPT,
    COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
    HISTORIAN_EDITOR_SYSTEM_PROMPT,
} from "./hooks/magic-context/compartment-prompt";
import { createLiveSessionState } from "./hooks/magic-context/live-session-state";
import {
    configureManagedDemandStart,
    createLazyManagedDemandStart,
    McHostModuleTransport,
} from "./hooks/magic-context/module-transport";
import { preloadTokenizer } from "./hooks/magic-context/read-session-formatting";
import type { RustModeModuleClient } from "./hooks/magic-context/rust-mode-transform";
import { beginBootQuietPeriod } from "./plugin/boot-quiet";
import { cleanupConflictWarnings, sendConflictWarning } from "./plugin/conflict-warning-hook";
import { startDreamScheduleTimer } from "./plugin/dream-timer";
import { createDreamTimerModuleClient } from "./plugin/dream-timer-module-client";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./plugin/embedding-bootstrap";
import { createEventHandler } from "./plugin/event";
import { createSessionHooksAsync } from "./plugin/hooks/create-session-hooks";
import { isDisposedInstanceDirectory } from "./plugin/instance-disposal";
import { createMessagesTransformHandler } from "./plugin/messages-transform";
import { registerRpcHandlers } from "./plugin/rpc-handlers";
import { createToolRegistry } from "./plugin/tool-registry";
import {
    type ConflictResult,
    detectConflicts,
    resolveCompactionForBoot,
} from "./shared/conflict-detector";
import { getMagicContextStorageDir } from "./shared/data-path";
import { registerExitAbort, unregisterExitAbort } from "./shared/exit-abort-registry";
import { setKeepSubagents } from "./shared/keep-subagents";
import { log } from "./shared/logger";
import { refreshModelLimitsFromApi } from "./shared/models-dev-cache";
import { createPromptSurfaceRuntime } from "./shared/prompt-surface-runtime";
import { MagicContextRpcServer } from "./shared/rpc-server";
import { setStoragePrivatePermissionEnforcement } from "./shared/storage-permissions";

const managedDemandStart = createLazyManagedDemandStart({
    declaringModuleUrl: import.meta.url,
    parentPackageName: "@cortexkit/opencode-magic-context",
});

const server: Plugin = async (ctx) => {
    // Broca child processes must not initialize Magic Context.
    // Do not use the buffered logger: it arms a flush timer and appends to the Magic Context log file.
    if (process.env.MAGIC_CONTEXT_BROCA_CHILD === "1") {
        console.error(
            "[magic-context] broca child detected (MAGIC_CONTEXT_BROCA_CHILD=1); skipping plugin startup",
        );
        return {};
    }
    configureManagedDemandStart(managedDemandStart);
    configureSynapseManagedDemandStart(managedDemandStart);
    beginBootQuietPeriod();
    // Migrate legacy per-harness config before loading because the loader reads only the shared CortexKit location.
    // The migration is idempotent, uses a lock across Desktop instances, and fails open.
    // The config-warning path surfaces migration conflicts and partial failures.
    const configMigrationWarnings = migrateMagicContextConfigLocations(ctx.directory, {
        warn: (m) => log(`[magic-context] ${m}`),
        info: (m) => log(`[magic-context] ${m}`),
    });
    const loadedPluginConfig = loadPluginConfigDetailed(ctx.directory);
    const pluginConfig = loadedPluginConfig.config;
    const promptSurfaceRuntime = createPromptSurfaceRuntime({
        harness: "opencode",
        directory: ctx.directory,
        warn: (message) => log(`[magic-context] config warning: ${message}`),
    });
    if (configMigrationWarnings.length > 0) {
        pluginConfig.configWarnings = [
            ...configMigrationWarnings,
            ...(pluginConfig.configWarnings ?? []),
        ];
    }
    // Configure storage policy and SQLite tuning before the first openDatabase() call.
    // Storage is user-tier and shared by every project handled by this plugin process.
    setStoragePrivatePermissionEnforcement(pluginConfig.storage.enforce_private_permissions);
    setSqlitePragmaConfig({
        cacheSizeMb: pluginConfig.sqlite.cache_size_mb,
        mmapSizeMb: pluginConfig.sqlite.mmap_size_mb,
    });
    // When enabled, keep historian, dreamer, sidekick, and migration child sessions after success.
    setKeepSubagents(pluginConfig.keep_subagents === true);
    const autoUpdateAbort = new AbortController();
    // Register autoUpdateAbort with the shared exit listener to avoid one process listener per plugin instance.
    // Registering process.once("exit") per plugin instance would add one exit listener per instance.
    // OpenCode Desktop runs many plugin instances in one process, and Node warns after 10 exit listeners.
    registerExitAbort(autoUpdateAbort);

    if (pluginConfig.configWarnings?.length) {
        for (const w of pluginConfig.configWarnings) {
            log(`[magic-context] config warning: ${w}`);
        }
        // Delay the startup notification until an active session is available.
        const warningText = [
            "## ⚠️ Magic Context Config Warning",
            "",
            "Some configuration values are invalid and were replaced with defaults:",
            "",
            ...pluginConfig.configWarnings.map((w) => `- ${w}`),
            "",
            "Check your `magic-context.jsonc` to fix these values.",
        ].join("\n");

        setTimeout(async () => {
            try {
                const { sendIgnoredMessage } = await import(
                    "./hooks/magic-context/send-session-notification"
                );
                // sendIgnoredMessage routes TUI notifications to toasts and Desktop notifications to ignored messages via isTuiConnected().
                // Use the first active session because sendIgnoredMessage requires a session ID.
                // session.list() may return `{ data: [...] }` or an array, so handle both shapes at runtime.
                type SessionListFn = () => Promise<
                    { data?: Array<{ id?: string }> } | Array<{ id?: string }>
                >;
                const clientWithSessions = ctx.client as unknown as {
                    session?: { list?: SessionListFn };
                };
                const sessions = await Promise.resolve(clientWithSessions.session?.list?.()).catch(
                    () => null,
                );
                const sessionList = Array.isArray(sessions) ? sessions : sessions?.data;
                const sessionId = sessionList?.[0]?.id;
                if (sessionId) {
                    // Pass the session's agent, model, and variant so the ignored message does not select the default agent or model.
                    // Passing no agent, model, or variant records the ignored message with the defaults.
                    // Using the defaults attributes the notice to the default agent rather than the session agent.
                    // Using the defaults switches the model on the next user turn and invalidates the prefix cache.
                    // `resolvePromptContext` reads real session messages and returns `null` for fresh or empty sessions.
                    await sendIgnoredMessage(ctx.client, sessionId, warningText, {});
                }
            } catch {
                // Config warning delivery must not crash startup.
            }
        }, 3000);
    }

    // Pass `resolvedCompaction` explicitly because `detectConflicts` does not re-derive it from config files.
    // When MC compaction is off, native `compaction.auto=true` is not a conflict.
    // When MC compaction is off, native `compaction.auto=true` leaves the plugin enabled.
    //
    // `ctx.client.config.get()` returns the configuration shown by `opencode debug config`.
    // Native compaction state is read from `ctx.client.config.get()`, not re-derived from config files.
    // File-based re-derivation defaults `compaction.auto` to `true` when no configuration file resolves.
    // File-based detection can disable the plugin when `auto=false` is defined in an unresolved configuration layer.
    // If the resolved-config fetch fails or times out, conflict detection uses the file-based check.
    let conflictResult: ConflictResult | null = null;
    if (pluginConfig.enabled) {
        const resolvedCompaction = await resolveCompactionForBoot(ctx.client);
        if (resolvedCompaction === null) {
            log(
                "[magic-context] resolved-config fetch failed; using file-based compaction detection (the running server's resolved config may differ — `opencode debug config` is authoritative)",
            );
        }
        conflictResult = detectConflicts(ctx.directory, {
            compactionEnabled: isCompactionEnabled(pluginConfig),
            resolvedCompaction: resolvedCompaction ?? undefined,
        });
        if (conflictResult.hasConflict) {
            pluginConfig.enabled = false;
            log(`[magic-context] disabled due to conflicts: ${conflictResult.reasons.join("; ")}`);
        } else {
            log("[magic-context] no conflicts detected, plugin enabled");
        }
    }

    const liveSessionState = createLiveSessionState();
    const rustModeModuleClient: RustModeModuleClient | undefined =
        pluginConfig.transform_mode === "rust"
            ? new McHostModuleTransport(pluginConfig.subc?.connection_file)
            : undefined;

    const hooks = await createSessionHooksAsync({
        ctx,
        pluginConfig,
        liveSessionState,
        rustModeModuleClient,
        promptSurfaceRuntime,
    });

    // A healed storage reopen installs real hooks without rebuilding the outer messages-transform wrapper.
    // The mutable holder lets a healed storage reopen install real hooks without rebuilding the outer messages-transform wrapper.
    const magicContextRuntime: {
        magicContext: typeof hooks.magicContext;
        rustToolBackends: typeof hooks.rustToolBackends;
    } = {
        magicContext: hooks.magicContext,
        rustToolBackends: hooks.rustToolBackends,
    };

    // When MC is enabled but storage cannot open because of a schema fence or migration failure, block primary transforms instead of falling through to native compaction.
    // Storage-open failures must not unregister hooks and fall through to native compaction.
    const failClosed = createFailClosedController();
    const failClosedBlockingEnabled =
        pluginConfig.enabled === true && pluginConfig.fail_closed_blocking !== false;
    if (pluginConfig.enabled === true && !magicContextRuntime.magicContext) {
        const initFailure = getLastHookInitFailure();
        if (initFailure?.type === "storage") {
            failClosed.arm(initFailure.reason);
            log(
                `[magic-context] fail-closed blocking armed (${initFailure.reason.kind}); primary sessions will error until storage recovers or the build is upgraded`,
            );
        }
    }

    const tryReopenStorage = async (): Promise<boolean> => {
        if (magicContextRuntime.magicContext) {
            failClosed.clear();
            return true;
        }
        try {
            const reopened = await createSessionHooksAsync({
                ctx,
                pluginConfig,
                liveSessionState,
                rustModeModuleClient,
                promptSurfaceRuntime,
            });
            if (!reopened.magicContext) return false;
            magicContextRuntime.magicContext = reopened.magicContext;
            magicContextRuntime.rustToolBackends = reopened.rustToolBackends;
            failClosed.clear();
            log("[magic-context] storage re-probe succeeded; Magic Context runtime restored");
            return true;
        } catch (error) {
            log(`[magic-context] storage re-probe failed: ${error}`);
            return false;
        }
    };

    const tools = createToolRegistry({
        ctx,
        pluginConfig,
        rustToolBackends: magicContextRuntime.rustToolBackends,
        promptSurfaceRuntime,
        registrationPromptSurface: loadedPluginConfig.registrationPromptSurface,
    });

    // The auto-update checker uses `storageDir` to deduplicate npm requests across concurrent plugin instances.
    // The auto-update checker deduplicates npm requests even when configuration or conflicts disable the runtime.
    const storageDir = getMagicContextStorageDir();

    // Function-scope handles let the `server.instance.disposed` cleanup handler stop them.
    let rpcServer: MagicContextRpcServer | null = null;
    let stopDreamTimerRegistration: (() => void) | undefined;

    // The dream schedule timer runs at plugin level so overnight dreaming works without chat activity.
    if (pluginConfig.enabled) {
        const dreamerRunnable = isDreamerRunnable(pluginConfig);
        const classifyModuleClient = createDreamTimerModuleClient(rustModeModuleClient);
        const timerProjectIdentity = resolveProjectIdentityForSession(
            ctx.directory,
            pluginConfig.allow_home_project,
        );
        if (!timerProjectIdentity) {
            log(
                "[magic-context] dream timer skipped: no project identity is bound for this directory",
            );
        } else {
            const timerRegistration = {
                directory: ctx.directory,
                projectIdentity: timerProjectIdentity,
                client: ctx.client,
                dreamerConfig: dreamerRunnable ? pluginConfig.dreamer : undefined,
                language: pluginConfig.language,
                transformMode: pluginConfig.transform_mode,
                embeddingConfig: pluginConfig.embedding,
                memoryEnabled: pluginConfig.memory?.enabled === true,
                memoryInjectionBudgetTokens: pluginConfig.memory?.injection_budget_tokens,
                mural: pluginConfig.mural,
                retinaHandoff: pluginConfig.smart_notes.retina_handoff,
                gitCommitIndexing: pluginConfig.memory.git_commit_indexing?.enabled
                    ? {
                          enabled: true,
                          since_days: pluginConfig.memory.git_commit_indexing.since_days,
                          max_commits: pluginConfig.memory.git_commit_indexing.max_commits,
                      }
                    : undefined,
                ensureRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
                onDreamerProgress: (
                    progress: DreamTaskProgress | null,
                    completedTask: DreamTaskName | undefined,
                ) => {
                    if (progress) {
                        liveSessionState.dreamerProgressByProject.set(
                            timerProjectIdentity,
                            progress,
                        );
                    } else if (
                        liveSessionState.dreamerProgressByProject.get(timerProjectIdentity)
                            ?.task === completedTask
                    ) {
                        liveSessionState.dreamerProgressByProject.delete(timerProjectIdentity);
                    }
                },
                moduleClient: classifyModuleClient,
            };
            // The dream timer is best-effort background maintenance, so registration failures must not prevent hook registration.
            // Registration failures must not leave the transform and compaction pipeline unregistered.
            // `openTimerDatabaseOrNull` converts fatal timer-database opens to `null`.
            // The registration wrapper catches errors other than fatal timer-database opens.
            try {
                stopDreamTimerRegistration = await startDreamScheduleTimer(timerRegistration);
            } catch (err) {
                log(
                    `[magic-context] dream timer registration failed (continuing without it): ${err}`,
                );
            }
        }

        // RPC communication between the TUI and server bypasses the SQLite plugin_messages bus.
        rpcServer = new MagicContextRpcServer(storageDir, ctx.directory);
        registerRpcHandlers(rpcServer, {
            directory: ctx.directory,
            config: pluginConfig,
            client: ctx.client,
            liveSessionState,
            rustModeModuleClient,
        });
        rpcServer.start().catch((err) => {
            log(`[magic-context] RPC server failed to start: ${err}`);
        });

        // Startup warms the model-context-limit cache from OpenCode's SDK once.
        // The resolver refreshes model context limits from the OpenCode API.
        // Until refresh completes, resolution uses the persisted last-known-good limit, then 128k.
        //
        // Startup retries up to 3 times when OpenCode's provider service is unavailable.
        // The refresh runs fire-and-forget so it never blocks plugin initialization.
        //
        // The resolver does not schedule periodic refreshes because a later refresh can lower a limit during an active session.
        void refreshModelLimitsFromApi(ctx.client, { retries: 3, retryDelayMs: 1000 });
    }

    // `openDatabase()` fails closed for newer shared schemas; warn Desktop users because Desktop has no dialog surface.
    // The ignored-message path warns Desktop users because Desktop has no dialog surface.
    {
        const fence = getSchemaFenceRejection();
        if (fence) {
            void import("./plugin/conflict-warning-hook").then(({ sendSchemaFenceWarning }) =>
                sendSchemaFenceWarning(
                    ctx.client as unknown as Record<string, unknown>,
                    ctx.directory,
                    fence,
                ),
            );
        }
    }

    // Desktop has no dialog surface, so `sendConflictWarning` covers Desktop.
    if (conflictResult?.hasConflict) {
        // The handler sends the warning to the project's last active session without awaiting it.
        void sendConflictWarning(
            ctx.client as unknown as Record<string, unknown>,
            ctx.directory,
            conflictResult,
        );
    } else if (pluginConfig.enabled) {
        // The handler removes leftover conflict warnings only when no conflict exists and pluginConfig.enabled.
        const serverUrl = (ctx as Record<string, unknown>).serverUrl;
        const serverUrlStr =
            serverUrl instanceof URL ? serverUrl.toString().replace(/\/$/, "") : undefined;
        void cleanupConflictWarnings(
            ctx.client as unknown as Record<string, unknown>,
            ctx.directory,
            serverUrlStr,
        );
    }

    // Only the setup wizard and `doctor` add the TUI sidebar entry; startup must not restore an entry the user removed.

    // Desktop posts one ignored announcement message per release.
    //
    // TUI and Desktop share `last_announced_version`, so dismissal on either surface suppresses announcements on both.
    //
    // Startup delays delivery 8 seconds and does not await it, so delivery failures cannot block startup.
    if (pluginConfig.enabled && !conflictResult?.hasConflict) {
        try {
            const {
                shouldShowAnnouncement,
                ANNOUNCEMENT_VERSION,
                ANNOUNCEMENT_FEATURES,
                ANNOUNCEMENT_FOOTER,
                markAnnouncementSeen,
            } = await import("./shared/announcement");
            if (shouldShowAnnouncement()) {
                setTimeout(() => {
                    void import("./plugin/conflict-warning-hook")
                        .then(({ sendStartupAnnouncement }) =>
                            sendStartupAnnouncement(
                                ctx.client as unknown as Record<string, unknown>,
                                ctx.directory,
                                ANNOUNCEMENT_VERSION,
                                ANNOUNCEMENT_FEATURES,
                                ANNOUNCEMENT_FOOTER,
                                markAnnouncementSeen,
                            ),
                        )
                        .catch(() => {
                        });
                }, 8000);
            }
        } catch {
        }
    }

    // `tool.definition` events use the latest chat context because their input contains only `toolID`.
    let lastChatContext: { providerID: string; modelID: string; agentName: string } | null = null;

    // Disposal matches `ownInstanceDirectory`, not a shared project identity.
    const ownInstanceDirectory = ctx.directory;

    return {
        tool: tools,
        event: createEventHandler({
            magicContext: {
                event: async (input) => {
                    await magicContextRuntime.magicContext?.event?.(input);
                },
            },
            autoUpdateChecker: createAutoUpdateCheckerHook(ctx, {
                autoUpdate: pluginConfig.auto_update !== false,
                signal: autoUpdateAbort.signal,
                storageDir,
            }),
            // `onInstanceDisposed` cleans up only this instance's process-resident resources.
            // Instance teardown must not dispose the native ONNX embedding session.
            onInstanceDisposed: (disposedDirectory: string) => {
                if (!isDisposedInstanceDirectory(ownInstanceDirectory, disposedDirectory)) return;
                try {
                    autoUpdateAbort.abort();
                    // Disposal unregisters `autoUpdateAbort` so the exit-abort registry does not retain it.
                    unregisterExitAbort(autoUpdateAbort);
                } catch {
                    // best-effort
                }
                try {
                    stopDreamTimerRegistration?.();
                } catch {
                    // best-effort
                }
                void magicContextRuntime.magicContext
                    ?.disposeNoteEvaluationBridges()
                    .catch(() => {});
                try {
                    rpcServer?.stop();
                } catch {
                    // best-effort
                }
                log(
                    "[magic-context] instance disposed — stopped RPC server, dream timer, auto-update",
                );
            },
        }),
        "experimental.chat.messages.transform": createMessagesTransformHandler({
            magicContext: magicContextRuntime.magicContext,
            getMagicContext: () => magicContextRuntime.magicContext,
            failClosed,
            failClosedBlockingEnabled,
            // When compaction is disabled, a failed transform passes through the input messages even if `failClosedBlocking` is enabled.
            compactionOff: !isCompactionEnabled(pluginConfig),
            internalChildSessions: liveSessionState.internalChildSessions,
            tryReopenStorage,
            // SAFETY: wrapper matches the hook's runtime call shape.
        }) as unknown as NonNullable<Hooks["experimental.chat.messages.transform"]>,
        "experimental.chat.system.transform": async (input, output) => {
            await magicContextRuntime.magicContext?.["experimental.chat.system.transform"]?.(
                input,
                output,
            );
        },
        "command.execute.before": async (input, output) => {
            await magicContextRuntime.magicContext?.["command.execute.before"]?.(input, output);
        },
        "chat.message": async (input, _output) => {
            // The first prompt awaits `preloadTokenizer()` so later synchronous estimates use the installed package.
            await preloadTokenizer();
            // The handler sets `lastChatContext` before magic-context hooks because `registry.tools()` runs next and `tool.definition` uses that context.
            const typed = input as {
                model?: { providerID?: string; modelID?: string };
                agent?: string;
            };
            const provId = typed.model?.providerID;
            const modId = typed.model?.modelID;
            const agent = typed.agent;
            if (provId && modId && agent) {
                lastChatContext = { providerID: provId, modelID: modId, agentName: agent };
            }
            await magicContextRuntime.magicContext?.["chat.message"]?.(input);
        },
        "tool.definition": async (input, output) => {
            // The handler skips tool-definition measurement until `chat.message` supplies provider, model, and agent context.
            if (!lastChatContext) return;
            const typedInput = input as { toolID?: string };
            const typedOutput = output as { description?: unknown; parameters?: unknown };
            if (!typedInput.toolID) return;
            recordToolDefinition(
                lastChatContext.providerID,
                lastChatContext.modelID,
                lastChatContext.agentName,
                typedInput.toolID,
                typeof typedOutput.description === "string" ? typedOutput.description : "",
                typedOutput.parameters,
            );
        },
        "tool.execute.after": async (input, output) => {
            await magicContextRuntime.magicContext?.["tool.execute.after"]?.(input, output);
        },
        "experimental.text.complete": async (input, output) => {
            await magicContextRuntime.magicContext?.["experimental.text.complete"]?.(input, output);
        },
        config: async (config) => {
            try {
                if (pluginConfig.enabled !== true) {
                    return;
                }
                const commandConfig = {
                    ...(config.command ?? {}),
                    ...getMagicContextBuiltinCommands(isCompactionEnabled(pluginConfig)),
                    ...(pluginConfig.command ?? {}),
                };

                config.command = commandConfig;
                // Hidden-agent overrides remove `thinking_level` because OpenCode does not accept it as an agent config field.
                const dreamerAgentOverrides = pluginConfig.dreamer
                    ? (() => {
                          const {
                              tasks: _tasks,
                              inject_docs: _injectDocs,
                              thinking_level: _thinkingLevel,
                              ...agentOverrides
                          } = pluginConfig.dreamer;
                          return agentOverrides;
                      })()
                    : undefined;
                const sidekickAgentOverrides = pluginConfig.sidekick
                    ? (() => {
                          const {
                              timeout_ms: _timeoutMs,
                              system_prompt: _systemPrompt,
                              thinking_level: _thinkingLevel,
                              ...agentOverrides
                          } = pluginConfig.sidekick;
                          return agentOverrides;
                      })()
                    : undefined;
                // Historian overrides remove `two_pass`, `disallowed_tools`, and `thinking_level` because OpenCode rejects them as agent config fields.
                // Historian overrides remove `two_pass`, `disallowed_tools`, and `thinking_level` because OpenCode rejects them as agent config fields.
                const historianAgentOverrides = pluginConfig.historian
                    ? (() => {
                          const {
                              two_pass: _twoPass,
                              disallowed_tools: _disallowedTools,
                              thinking_level: _thinkingLevel,
                              ...agentOverrides
                          } = pluginConfig.historian;
                          return agentOverrides;
                      })()
                    : undefined;
                // OpenCode's legacy loader invokes entry exports as plugin factories, so `buildHiddenAgentRegistrations` must remain outside the entry module.
                // OpenCode's legacy loader invokes entry exports as plugin factories, so `buildHiddenAgentRegistrations` must remain outside the entry module.
                // OpenCode's legacy loader invokes entry exports as plugin factories, so `buildHiddenAgentRegistrations` must remain outside the entry module.
                // OpenCode's legacy loader invokes entry exports as plugin factories, so `buildHiddenAgentRegistrations` must remain outside the entry module.
                // OpenCode's legacy loader invokes entry exports as plugin factories, so `buildHiddenAgentRegistrations` must remain outside the entry module.
                // OpenCode's legacy loader invokes entry exports as plugin factories, so `buildHiddenAgentRegistrations` must remain outside the entry module.
                const registrations = buildHiddenAgentRegistrations({
                    dreamerPrompt: DREAMER_SYSTEM_PROMPT,
                    smartNoteCompilerPrompt: SMART_NOTE_COMPILER_SYSTEM_PROMPT,
                    historianPrompt: withContentLanguageDirective(
                        COMPARTMENT_AGENT_SYSTEM_PROMPT,
                        pluginConfig.language,
                        { preserveUserQuotes: true },
                    ),
                    historianRecompPrompt: withContentLanguageDirective(
                        COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
                        pluginConfig.language,
                        { preserveUserQuotes: true },
                    ),
                    historianEditorPrompt: withContentLanguageDirective(
                        HISTORIAN_EDITOR_SYSTEM_PROMPT,
                        pluginConfig.language,
                        { preserveUserQuotes: true },
                    ),
                    sidekickPrompt: SIDEKICK_SYSTEM_PROMPT,
                    dreamerOverrides: dreamerAgentOverrides,
                    historianOverrides: historianAgentOverrides,
                    sidekickOverrides: sidekickAgentOverrides,
                    historianDisallowed: pluginConfig.historian?.disallowed_tools ?? [],
                });

                const agentConfig = { ...(config.agent ?? {}) } as NonNullable<typeof config.agent>;
                const agentConfigRecord = agentConfig as Record<string, Record<string, unknown>>;
                const internalAgentIds = registrations.map((registration) => registration.id);
                for (const reg of registrations) {
                    if (typeof reg.prompt !== "string" || reg.prompt.length === 0) {
                        log(
                            `[magic-context] skipping hidden agent '${reg.id}' — prompt unavailable at config time (dir=${ctx.directory}); will re-register on a later complete pass`,
                        );
                        continue;
                    }
                    agentConfigRecord[reg.id] = buildHiddenAgentConfig(
                        reg.prompt,
                        reg.allowedTools,
                        reg.maxSteps,
                        reg.overrides,
                        reg.id,
                        reg.lockPermissions === true,
                        reg.description,
                    );
                }
                const callerAgentConfig = denyTaskRoutingToCallerAgents(
                    agentConfigRecord,
                    internalAgentIds,
                );
                config.agent = callerAgentConfig as NonNullable<typeof config.agent>;
            } catch (error) {
                // Command and agent registration failures must not prevent plugin loading.
                // Registration failures retain the previous agent configuration.
                const e = error as { message?: string; stack?: string };
                log(
                    `[magic-context] config hook failed (commands/agents NOT registered; transform still active): ${e?.message ?? error}`,
                    e?.stack
                        ? { stackHead: e.stack.split("\n").slice(0, 6).join("\n") }
                        : undefined,
                );
            }
        },
    };
};

const plugin: PluginModule = {
    id: "opencode-magic-context",
    server,
};

export default plugin;
