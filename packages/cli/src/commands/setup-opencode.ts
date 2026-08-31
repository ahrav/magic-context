import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { loadPluginConfig } from "@magic-context/core/config";
import { isCompactionEnabled } from "@magic-context/core/config/agent-disable";
import { detectConflicts } from "@magic-context/core/shared/conflict-detector";
import { fixConflicts } from "@magic-context/core/shared/conflict-fixer";
import {
    appendJsoncArrayValues,
    removeJsoncArrayEntries,
    setJsoncValue,
} from "@magic-context/core/shared/jsonc-edit";
import { stringify as stringifyJsonc } from "comment-json";
import {
    isDevPathPluginEntry,
    isLocalPathPluginEntry,
    matchesPluginEntry,
} from "../adapters/opencode";
import { writeFileAtomic } from "../lib/atomic-write";
import {
    hasUserConfigLocationMigrationRefusal,
    migrateConfigLocationsForCli,
} from "../lib/config-location-migration";
import { runDreamerSetup } from "../lib/dreamer-setup";
import { assertJsoncConfigsParseable, readJsoncConfigForUpdate } from "../lib/jsonc-config";
import { pickModel } from "../lib/model-picker";
import { detectOpenCode } from "../lib/opencode-detect";
import { getAvailableModels, getOpenCodeVersion } from "../lib/opencode-helpers";
import {
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION as PLUGIN_ENTRY,
    OPENCODE_PLUGIN_NAME as PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import { detectConfigPaths } from "../lib/paths";
import { confirm, intro, log, note, outro, promptIO, spinner } from "../lib/prompts";

const DCP_PLUGIN_NAME = "@tarquinen/opencode-dcp";

/**
 */
function resolveCompactionEnabledForWriter(): boolean {
    try {
        const config = loadPluginConfig(process.cwd());
        return isCompactionEnabled(config);
    } catch (error) {
        log.warn(
            `Could not load Magic Context config to resolve compaction mode; ` +
                `preserving existing native compaction fields. ` +
                `(${error instanceof Error ? error.message : String(error)})`,
        );
        return false;
    }
}

function ensureDir(dir: string): void {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

export function addPluginToOpenCodeConfig(
    configPath: string,
    _format: "json" | "jsonc" | "none",
    removeDcp = false,
    /**
     * When compactionEnabled is false, the writer does not write compaction.auto or compaction.prune.
     * When compactionEnabled is false, the writer does not change compaction fields.
     */
    compactionEnabled = true,
): void {
    const existsAtCommit = existsSync(configPath);
    const existing = existsAtCommit ? readJsoncConfigForUpdate(configPath) : {};
    if (!existsAtCommit) {
        ensureDir(dirname(configPath));
        const created: Record<string, unknown> = { plugin: [PLUGIN_ENTRY] };
        if (compactionEnabled) {
            created.compaction = { auto: false, prune: false };
        }
        writeFileAtomic(configPath, `${stringifyJsonc(created, null, 2)}\n`);
        return;
    }

    let text = readFileSync(configPath, "utf-8");
    let changed = false;
    const rawPlugins: unknown[] = Array.isArray(existing.plugin) ? existing.plugin : [];
    const retainedPlugins = removeDcp
        ? rawPlugins.filter((plugin) => !matchesPluginEntry(plugin, DCP_PLUGIN_NAME))
        : rawPlugins;

    if (
        retainedPlugins.some(
            (plugin) =>
                isLocalPathPluginEntry(plugin) &&
                String(plugin).includes("magic-context") &&
                !isDevPathPluginEntry(plugin),
        )
    ) {
        log.warn(
            "An unverifiable local OpenCode plugin path was ignored; its package name is not Magic Context.",
        );
    }

    if (Array.isArray(existing.plugin)) {
        if (removeDcp) {
            const result = removeJsoncArrayEntries(text, ["plugin"], (plugin) =>
                matchesPluginEntry(plugin, DCP_PLUGIN_NAME),
            );
            if (result.removed) {
                text = result.text;
                changed = true;
            }
        }

        const hasNpmEntry = retainedPlugins.some((plugin) =>
            matchesPluginEntry(plugin, PLUGIN_NAME),
        );
        const hasDevEntry = retainedPlugins.some((plugin) => isDevPathPluginEntry(plugin));
        if (!hasNpmEntry && !hasDevEntry) {
            text = appendJsoncArrayValues(text, ["plugin"], [PLUGIN_ENTRY]);
            changed = true;
        }
    } else {
        text = setJsoncValue(text, ["plugin"], [PLUGIN_ENTRY]);
        changed = true;
    }

    // When compactionEnabled is false, the writer does not change compaction fields.
    // When compactionEnabled is true, the writer sets compaction.auto and compaction.prune to false.
    if (compactionEnabled) {
        const compaction = existing.compaction;
        const hasCompactionObject =
            typeof compaction === "object" && compaction !== null && !Array.isArray(compaction);
        if (!hasCompactionObject) {
            text = setJsoncValue(text, ["compaction"], { auto: false, prune: false });
            changed = true;
        } else {
            const fields = compaction as Record<string, unknown>;
            if (fields.auto !== false) {
                text = setJsoncValue(text, ["compaction", "auto"], false);
                changed = true;
            }
            if (fields.prune !== false) {
                text = setJsoncValue(text, ["compaction", "prune"], false);
                changed = true;
            }
        }
    }

    if (changed) writeFileAtomic(configPath, text);
}

export function addPluginToTuiConfig(configPath: string, _format: "json" | "jsonc" | "none"): void {
    const existsAtCommit = existsSync(configPath);
    const existing = existsAtCommit ? readJsoncConfigForUpdate(configPath) : {};
    if (!existsAtCommit) {
        ensureDir(dirname(configPath));
        writeFileAtomic(configPath, `${stringifyJsonc({ plugin: [PLUGIN_ENTRY] }, null, 2)}\n`);
        return;
    }

    const rawPlugins: unknown[] = Array.isArray(existing.plugin) ? existing.plugin : [];
    if (
        rawPlugins.some(
            (plugin) =>
                isLocalPathPluginEntry(plugin) &&
                String(plugin).includes("magic-context") &&
                !isDevPathPluginEntry(plugin),
        )
    ) {
        log.warn(
            "An unverifiable local TUI plugin path was ignored; its package name is not Magic Context.",
        );
    }

    const hasNpmEntry = rawPlugins.some((plugin) => matchesPluginEntry(plugin, PLUGIN_NAME));
    const hasDevEntry = rawPlugins.some((plugin) => isDevPathPluginEntry(plugin));
    if (hasNpmEntry || hasDevEntry) return;

    const text = Array.isArray(existing.plugin)
        ? appendJsoncArrayValues(readFileSync(configPath, "utf-8"), ["plugin"], [PLUGIN_ENTRY])
        : setJsoncValue(readFileSync(configPath, "utf-8"), ["plugin"], [PLUGIN_ENTRY]);
    writeFileAtomic(configPath, text);
}

export function findDcpPluginIndexes(plugins: unknown[]): number[] {
    return plugins
        .map((plugin, index) => (matchesPluginEntry(plugin, DCP_PLUGIN_NAME) ? index : -1))
        .filter((index) => index >= 0);
}

function pluginEntryName(entry: unknown): string {
    if (typeof entry === "string") return entry;
    if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
    return String(entry);
}

async function resolveDcpConflictBeforeSetup(
    configPath: string,
    format: "json" | "jsonc" | "none",
): Promise<boolean> {
    if (format === "none") return false;
    const ocConfig = readJsoncConfigForUpdate(configPath);
    const plugins = Array.isArray(ocConfig.plugin) ? ocConfig.plugin : [];
    const dcpIndexes = findDcpPluginIndexes(plugins);
    if (dcpIndexes.length === 0) return false;

    log.warn(`Found conflicting plugin: ${pluginEntryName(plugins[dcpIndexes[0]])}`);
    log.message(
        "opencode-dcp (Dynamic Context Pruning) and Magic Context both manage context.\n" +
            "Running both simultaneously will cause unpredictable behavior.",
    );
    const shouldRemove = await confirm("Remove opencode-dcp from your config?", true);
    if (!shouldRemove) {
        log.warn("Skipped — you may experience context management conflicts");
    }
    return shouldRemove;
}

export function writeMagicContextConfig(
    configPath: string,
    options: {
        historianModel: string | null;
        dreamerEnabled: boolean;
        dreamerModel: string | null;
        /* */
        dreamerTasks?: Record<string, { schedule: string }>;
        sidekickEnabled: boolean;
        sidekickModel: string | null;
        claudeMax: boolean;
    },
): void {
    const config = readJsoncConfigForUpdate(configPath);

    if (!config.$schema) {
        config.$schema =
            "https://raw.githubusercontent.com/ahrav/magic-context/main/assets/magic-context.schema.json";
    }

    if (options.historianModel) {
        const historian = (config.historian as Record<string, unknown>) ?? {};
        historian.model = options.historianModel;
        config.historian = historian;
    }

    const dreamer = (config.dreamer as Record<string, unknown>) ?? {};
    delete dreamer.enabled;
    if (options.dreamerEnabled) {
        delete dreamer.disable;
        if (options.dreamerModel) {
            dreamer.model = options.dreamerModel;
        }
        if (options.dreamerTasks) {
            dreamer.tasks = options.dreamerTasks;
        }
    } else {
        dreamer.disable = true;
    }
    config.dreamer = dreamer;

    const sidekick = (config.sidekick as Record<string, unknown>) ?? {};
    delete sidekick.enabled;
    if (options.sidekickEnabled) {
        delete sidekick.disable;
        if (options.sidekickModel) {
            sidekick.model = options.sidekickModel;
        }
        config.sidekick = sidekick;
    } else {
        sidekick.disable = true;
        config.sidekick = sidekick;
    }

    if (options.claudeMax) {
        const cacheTtl = (config.cache_ttl as Record<string, string>) ?? {};
        if (!cacheTtl.default) cacheTtl.default = "5m";
        cacheTtl["anthropic/claude-sonnet-4-6"] = "59m";
        cacheTtl["anthropic/claude-opus-4-6"] = "59m";
        config.cache_ttl = cacheTtl;
    }

    writeFileAtomic(configPath, `${stringifyJsonc(config, null, 2)}\n`);
}

export async function runSetup(dryRun = false): Promise<number> {
    intro("Magic Context — Setup");
    if (dryRun) {
        log.warn("Dry run — no files will be written and no config will be changed.");
        log.message(
            "[dry-run] would migrate legacy Magic Context config before setup reads or writes the shared CortexKit config.",
        );
    } else {
        const migrationWarnings = migrateConfigLocationsForCli(process.cwd(), log);
        if (hasUserConfigLocationMigrationRefusal(migrationWarnings)) {
            outro(
                "Setup stopped — resolve the legacy Magic Context user config migration conflict, then rerun setup.",
            );
            return 1;
        }
    }

    const s = spinner();
    s.start("Checking OpenCode installation");

    const detection = detectOpenCode();
    if (detection.kind === "none") {
        s.stop("OpenCode not found");
        const shouldContinue = await confirm(
            "OpenCode not found on PATH. Continue setup anyway?",
            false,
        );
        if (!shouldContinue) {
            log.info("Install OpenCode: https://opencode.ai");
            outro("Setup cancelled");
            return 1;
        }
    } else if (detection.kind === "desktop") {
        // absent.
        s.stop("OpenCode Desktop detected (CLI not installed)");
        log.info(
            "Model auto-discovery needs the OpenCode CLI; you will enter models manually. Install the CLI to auto-populate: https://opencode.ai",
        );
    } else {
        const version = getOpenCodeVersion(detection.binary);
        s.stop(`OpenCode ${version ?? ""} detected`);
    }

    s.start("Fetching available models");

    const allModels = detection.kind === "cli" ? getAvailableModels(detection.binary) : [];
    if (allModels.length > 0) {
        s.stop(`Found ${allModels.length} models`);
    } else {
        s.stop("No models found");
        log.warn("You can configure models manually in magic-context.jsonc later");
    }

    const paths = detectConfigPaths();
    const hadExistingSetup =
        paths.opencodeConfigFormat !== "none" ||
        existsSync(paths.magicContextConfig) ||
        paths.tuiConfigFormat !== "none";

    if (!dryRun) {
        try {
            assertJsoncConfigsParseable([
                paths.opencodeConfig,
                paths.magicContextConfig,
                paths.tuiConfig,
            ]);
        } catch (error) {
            log.error(error instanceof Error ? error.message : String(error));
            outro("Setup stopped — fix the malformed config and rerun setup.");
            return 1;
        }
    }

    const removeDcp = dryRun
        ? false
        : await resolveDcpConflictBeforeSetup(paths.opencodeConfig, paths.opencodeConfigFormat);

    const compactionEnabled = resolveCompactionEnabledForWriter();

    if (dryRun) {
        log.message(
            compactionEnabled
                ? `[dry-run] would add the plugin to ${paths.opencodeConfig} and disable compaction`
                : `[dry-run] would add the plugin to ${paths.opencodeConfig} (compaction-off mode — native compaction fields left untouched)`,
        );
    }

    let conflictFix: Parameters<typeof fixConflicts>[1] | null = null;
    if (hadExistingSetup) {
        const conflicts = detectConflicts(process.cwd(), {
            compactionEnabled,
        });
        if (conflicts.hasConflict) {
            log.warn("Found conflicting configuration that can disable Magic Context:");
            for (const reason of conflicts.reasons) {
                log.message(`  • ${reason}`);
            }

            if (dryRun) {
                log.message("[dry-run] would offer to apply automatic conflict fixes");
            } else {
                const shouldFixConflicts = await confirm(
                    "Apply automatic conflict fixes to your OpenCode and OMO config files?",
                    true,
                );

                if (shouldFixConflicts) {
                    conflictFix = conflicts.conflicts;
                } else {
                    log.warn(
                        "Skipped automatic conflict fixes — Magic Context may remain disabled",
                    );
                }
            }
        }
    }

    const historianModel = await pickModel(promptIO, allModels, "historian");
    log.success(`Historian: ${historianModel}`);

    const dreamerEnabled = await confirm("Enable dreamer?", true);
    let dreamerModel: string | null = null;
    let dreamerTasks: Record<string, { schedule: string }> | undefined;
    if (dreamerEnabled) {
        const result = await runDreamerSetup(promptIO, allModels);
        dreamerModel = result.model;
        dreamerTasks = result.tasks;
    }

    const sidekickEnabled = await confirm("Enable sidekick?", false);
    let sidekickModel: string | null = null;
    if (sidekickEnabled) {
        sidekickModel = await pickModel(promptIO, allModels, "sidekick");
        log.success(`Sidekick: ${sidekickModel}`);
    }

    const hasAnthropic = allModels.some((m) => m.startsWith("anthropic/"));
    let claudeMax = false;
    if (hasAnthropic) {
        log.message(
            "Claude Max/Pro subscribers get extended prompt caching (up to 1 hour).\n" +
                "This lets Magic Context defer context operations much longer, saving money.",
        );
        claudeMax = await confirm("Do you have a Claude Max or Pro subscription?", false);
        if (claudeMax) {
            log.success("Cache TTL set to 59m for Anthropic models");
        }
    }

    if (dryRun) {
        log.message(`[dry-run] would write Magic Context config to ${paths.magicContextConfig}`);
        log.message(`[dry-run] would add the TUI sidebar plugin to ${paths.tuiConfig}`);
    }

    // ─── Step 8: Oh-My-OpenCode compatibility ───────────
    // Intentional: this branch handles the FIRST-TIME-INSTALL case only.
    // Existing users hit the same OMO conflict-fix logic via the
    // `if (hadExistingSetup) detectConflicts/fixConflicts` block above,
    // which already covers omoPreemptiveCompaction,
    // omoContextWindowMonitor, and omoAnthropicRecovery. Audit tools
    // sometimes flag this `!hadExistingSetup` gate as "OMO check skipped
    // for existing users" — that's a false positive.
    let disableOmoHooks = false;
    if (paths.omoConfig && !hadExistingSetup) {
        log.warn(`Found oh-my-opencode config: ${paths.omoConfig}`);
        log.message(
            "These hooks may conflict:\n" +
                "  • context-window-monitor\n" +
                "  • preemptive-compaction\n" +
                "  • anthropic-context-window-limit-recovery",
        );

        const shouldDisable = dryRun
            ? false
            : await confirm("Disable these hooks in oh-my-opencode?", true);
        if (dryRun) {
            log.message("[dry-run] would offer to disable conflicting oh-my-opencode hooks");
        }
        if (shouldDisable) {
            disableOmoHooks = true;
        } else {
            log.warn("Skipped — you may experience context management conflicts");
        }
    }

    if (!dryRun) {
        addPluginToOpenCodeConfig(
            paths.opencodeConfig,
            paths.opencodeConfigFormat,
            removeDcp,
            compactionEnabled,
        );
        log.success(`Plugin added to ${paths.opencodeConfig}`);
        if (removeDcp) log.success("Removed opencode-dcp from plugin list");
        if (compactionEnabled) {
            log.info("Disabled built-in compaction (auto=false, prune=false)");
            log.message(
                "Magic Context handles context management — built-in compaction would interfere",
            );
        } else {
            log.info("Compaction-off mode active — leaving native compaction config untouched");
        }

        if (conflictFix) {
            const actions = fixConflicts(process.cwd(), conflictFix, {
                compactionEnabled,
            });
            if (actions.length > 0) {
                for (const action of actions) log.success(action);
            } else {
                log.info("No additional conflict changes were needed");
            }
        }

        writeMagicContextConfig(paths.magicContextConfig, {
            historianModel,
            dreamerEnabled,
            dreamerModel,
            dreamerTasks,
            sidekickEnabled,
            sidekickModel,
            claudeMax,
        });
        log.success(`Config written to ${paths.magicContextConfig}`);
        addPluginToTuiConfig(paths.tuiConfig, paths.tuiConfigFormat);
        log.success(`TUI sidebar plugin added to ${basename(paths.tuiConfig)}`);

        if (disableOmoHooks) {
            const actions = fixConflicts(
                process.cwd(),
                {
                    compactionAuto: false,
                    compactionPrune: false,
                    dcpPlugin: false,
                    omoPreemptiveCompaction: true,
                    omoContextWindowMonitor: true,
                    omoAnthropicRecovery: true,
                },
                {
                    compactionEnabled,
                },
            );
            if (actions.includes("Disabled conflicting oh-my-opencode hooks")) {
                log.success("Hooks disabled in oh-my-opencode config");
            }
        }
    }

    const summary = [
        `Plugin: ${PLUGIN_NAME}`,
        compactionEnabled
            ? "Compaction: disabled (Magic Context manages the window)"
            : "Compaction: off (native compaction owns the window)",
        historianModel ? `Historian: ${historianModel}` : "Historian: fallback chain",
        dreamerEnabled
            ? `Dreamer: enabled${dreamerModel ? ` (${dreamerModel})` : ""}`
            : "Dreamer: disabled",
        sidekickEnabled
            ? `Sidekick: enabled${sidekickModel ? ` (${sidekickModel})` : ""}`
            : "Sidekick: disabled",
    ].join("\n");

    note(summary, dryRun ? "Configuration (dry run — not written)" : "Configuration");

    if (dryRun) {
        outro("Dry run complete — nothing was written.");
        return 0;
    }

    outro("Run 'opencode' to start!");

    return 0;
}
