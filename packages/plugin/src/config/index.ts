import { existsSync, readFileSync } from "node:fs";

import {
    detectConfigFile,
    isPrototypePollutionKey,
    parseConfigJsonc,
} from "../shared/jsonc-parser";
import { setOutputReserveConfig } from "../shared/models-dev-cache";
import type { PromptSurfaceConfig } from "../shared/prompt-surface";
import { setWindowOverlayPath } from "../shared/window-geometry";
import { isCompactionEnabled, migrateLegacyAgentEnabledInMemory } from "./agent-disable";
import type { LoadOutcome } from "./load-outcome";
import {
    cortexKitProjectConfigBasePath,
    cortexKitUserConfigBasePath,
    type LegacyConfigSource,
    resolveLegacyConfigSources,
    resolveLegacyConfigSourcesForHarness,
} from "./migrate-config-location";
import { migrateDreamerV2 } from "./migrate-dreamer-v2";
import { migrateLegacyExperimental } from "./migrate-experimental";
import {
    constrainProjectThresholdOverrides,
    dropInheritedEmbeddingKeyOnRedirect,
    stripUnsafeProjectConfigFields,
} from "./project-security";
import { pruneNestedConfigLeaf } from "./prune-config-leaf";
import { type MagicContextConfig, MagicContextConfigSchema } from "./schema/magic-context";
import { resolveTransformMode } from "./transform-mode";
import { substituteConfigVariables } from "./variable";

export type { LoadOutcome } from "./load-outcome";

export interface MagicContextPluginConfig extends MagicContextConfig {
    disabled_hooks?: string[];
    command?: Record<
        string,
        {
            template: string;
            description?: string;
            agent?: string;
            model?: string;
            subtask?: boolean;
        }
    >;
}

function getUserConfigBasePath(): string {
    return cortexKitUserConfigBasePath();
}

function getProjectConfigBasePath(directory: string): string {
    return cortexKitProjectConfigBasePath(directory);
}

interface LegacyReadFallback {
    /* */
    source: LegacyConfigSource | null;
}

/**
 */
function resolveLegacyReadFallback(sources: readonly LegacyConfigSource[]): LegacyReadFallback {
    return { source: sources.find((s) => existsSync(s.path)) ?? null };
}

interface LoadedConfigFile {
    config: Record<string, unknown>;
    /** The loader prefixes {env:} and {file:} substitution warnings with the config path. */
    warnings: string[];
}

export interface LoadResultDetailed {
    config: MagicContextPluginConfig & { configWarnings?: string[] };
    /** The loader captures USER-tier defaults and overrides before merging project routing. */
    registrationPromptSurface: PromptSurfaceConfig;
    loadOutcome: LoadOutcome;
    sources: {
        userConfig: LoadOutcome;
        projectConfig: LoadOutcome;
    };
    substitutionFailures: Array<{ keyPath: string; source: "user" | "project"; message: string }>;
    recoveredTopLevelKeys: string[];
}

interface LoadedConfigFileDetailed extends LoadedConfigFile {
    outcome: LoadOutcome;
    source: "user" | "project";
}

function loadConfigFileDetailed(
    configPath: string,
    source: "user" | "project",
): LoadedConfigFileDetailed | null {
    if (!existsSync(configPath)) {
        return null;
    }

    let rawText: string;
    try {
        rawText = readFileSync(configPath, "utf-8");
    } catch (error) {
        return {
            config: {},
            warnings: [
                `${configPath}: failed to read config: ${error instanceof Error ? error.message : String(error)}`,
            ],
            outcome: "project-file-io-error",
            source,
        };
    }

    try {
        const substituted = substituteConfigVariables({
            text: rawText,
            configPath,
            isProjectConfig: source === "project",
        });
        const rejectedKeyPaths: string[] = [];
        const config = parseConfigJsonc<Record<string, unknown>>(substituted.text, {
            onRejectedKey: (path) => rejectedKeyPaths.push(path.join(".")),
        });
        const unsafeKeyWarnings = rejectedKeyPaths.map(
            (path) =>
                `Ignored unsafe config key "${path}" (security: prototype-pollution keys are not allowed).`,
        );
        return {
            config,
            warnings: [...substituted.warnings, ...unsafeKeyWarnings].map(
                (warning) => `${configPath}: ${warning}`,
            ),
            outcome:
                rejectedKeyPaths.length > 0
                    ? "schema-recovery"
                    : substituted.warnings.length > 0
                      ? "substitution-failure"
                      : "ok",
            source,
        };
    } catch (error) {
        return {
            config: {},
            warnings: [
                `${configPath}: failed to load config: ${error instanceof Error ? error.message : String(error)}`,
            ],
            outcome: "project-file-parse-error",
            source,
        };
    }
}

/**
 * The loader merges raw JSON before Zod parsing so defaults do not become overrides.
 *
 * The merge recursively merges plain objects and atomically replaces arrays, primitives, and `null`.
 * The merge union-merges `disabled_hooks` so user and project configs can both contribute hook IDs.
 * element-wise.
 *
 * other's entries.
 */
function defineOwnConfigValue(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

function deepMergeRawConfig(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(base)) {
        if (isPrototypePollutionKey(key)) continue;
        defineOwnConfigValue(result, key, base[key]);
    }

    for (const key of Object.keys(override)) {
        if (isPrototypePollutionKey(key)) continue;
        const baseVal = Object.hasOwn(base, key) ? base[key] : undefined;
        const overrideVal = override[key];
        let mergedValue: unknown;
        if (
            baseVal !== null &&
            typeof baseVal === "object" &&
            !Array.isArray(baseVal) &&
            overrideVal !== null &&
            typeof overrideVal === "object" &&
            !Array.isArray(overrideVal)
        ) {
            mergedValue = deepMergeRawConfig(
                baseVal as Record<string, unknown>,
                overrideVal as Record<string, unknown>,
            );
        } else if (
            key === "disabled_hooks" &&
            Array.isArray(baseVal) &&
            Array.isArray(overrideVal)
        ) {
            mergedValue = [...new Set([...baseVal, ...overrideVal])];
        } else {
            mergedValue = overrideVal;
        }
        defineOwnConfigValue(result, key, mergedValue);
    }
    return result;
}

/**
 * Warning rendering never exposes values resolved by `{env:...}` or `{file:...}` substitution.
 *
 * The renderer reports string lengths and object and array shapes.
 * `<missing>`.
 */
function redactConfigValue(value: unknown): string {
    if (value === undefined) return "<missing>";
    if (value === null) return "null";
    if (typeof value === "string")
        return `string, ${value.length} char${value.length === 1 ? "" : "s"}`;
    if (typeof value === "number") return `number ${value}`;
    if (typeof value === "boolean") return `boolean ${value}`;
    if (Array.isArray(value)) return `array, ${value.length} item${value.length === 1 ? "" : "s"}`;
    if (typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>);
        return `object with keys [${keys.join(", ")}]`;
    }
    return typeof value;
}

function parsePluginConfig(
    rawConfig: Record<string, unknown>,
    recoveredTopLevelKeys: string[] = [],
): MagicContextPluginConfig & { configWarnings?: string[] } {
    // The loader reshapes legacy `experimental.*` keys before Zod parsing to preserve existing opt-in/out values.
    // `experimental.*` migration preserves users' opt-in/out state even if they never run `doctor`.
    const preMigrationWarnings: string[] = [];
    const migratedExperimental = migrateLegacyExperimental(rawConfig, preMigrationWarnings);
    // migrateDreamerV2 converts v1 task arrays, `user_memories`, and `pin_key_files` to per-task `tasks` records.
    // migrateDreamerV2 runs after migrateLegacyExperimental so it can fold migrated `user_memories` into v2 tasks.
    const migratedDreamer = migrateDreamerV2(migratedExperimental, preMigrationWarnings);
    const migrated = migrateLegacyAgentEnabledInMemory(migratedDreamer, preMigrationWarnings);
    const parsed = MagicContextConfigSchema.safeParse(migrated);
    const disabledHooks = Array.isArray(rawConfig.disabled_hooks)
        ? rawConfig.disabled_hooks.filter((value): value is string => typeof value === "string")
        : undefined;
    const command =
        typeof rawConfig.command === "object" && rawConfig.command !== null
            ? (rawConfig.command as MagicContextPluginConfig["command"])
            : undefined;

    if (parsed.success) {
        return {
            ...parsed.data,
            disabled_hooks: disabledHooks,
            command,
            ...(preMigrationWarnings.length > 0 ? { configWarnings: preMigrationWarnings } : {}),
        };
    }

    const defaults = MagicContextConfigSchema.parse({});
    const warnings: string[] = [];

    const errorPaths = new Set<string>();
    // The validator excludes generic Zod messages so warnings retain actionable validation reasons.
    // The loader surfaces custom Zod messages as config warnings.
    const customMessagesByKey = new Map<string, string>();
    // `issuePathsByKey` lets recovery prune invalid nested leaves without deleting their parent blocks.
    const issuePathsByKey = new Map<string, PropertyKey[][]>();
    const GENERIC_ZOD_PREFIXES = ["Too big", "Too small", "Invalid input", "Invalid", "Expected"];
    for (const issue of parsed.error.issues) {
        const topKey = issue.path[0];
        if (topKey !== undefined) {
            const key = String(topKey);
            errorPaths.add(key);
            const paths = issuePathsByKey.get(key) ?? [];
            paths.push([...issue.path]);
            issuePathsByKey.set(key, paths);
            const msg = issue.message;
            if (msg && !GENERIC_ZOD_PREFIXES.some((p) => msg.startsWith(p))) {
                if (!customMessagesByKey.has(key)) {
                    customMessagesByKey.set(key, msg);
                }
            }
        }
    }

    const patched: Record<string, unknown> = { ...rawConfig };
    for (const key of errorPaths) {
        recoveredTopLevelKeys.push(key);
        const isAgentConfig = key === "historian" || key === "dreamer" || key === "sidekick";
        if (isAgentConfig) {
            // Invalid agent configurations are dropped because default model settings could run expensive models or fail silently.
            delete patched[key];
            warnings.push(
                `"${key}": invalid agent configuration, ignoring. Check your magic-context.jsonc.`,
            );
            continue;
        }

        // Recovery prunes invalid nested leaves from object-valued keys and preserves valid siblings.
        // Preserving valid siblings retains migrated `memory.auto_search` and `memory.git_commit_indexing` settings.
        // The recovery code deletes the whole key when the issue targets that key or its value is not a prunable object.
        const issuePaths = issuePathsByKey.get(key) ?? [];
        const rawValue = rawConfig[key];
        const allNested =
            issuePaths.length > 0 &&
            issuePaths.every((p) => p.length >= 2) &&
            typeof rawValue === "object" &&
            rawValue !== null &&
            !Array.isArray(rawValue);
        if (allNested) {
            let prunedBlock: Record<string, unknown> = {
                ...(rawValue as Record<string, unknown>),
            };
            const prunedLeaves: string[] = [];
            for (const p of issuePaths) {
                // `p` is the full Zod issue path; recovery removes its deepest invalid leaf.
                // Recovery removes the deepest invalid leaf rather than `p[1]`.
                // For `memory.git_commit_indexing.since_days`, recovery removes only `since_days`.
                // For `memory.git_commit_indexing.since_days`, recovery preserves sibling fields such as `enabled: false`.
                const relative = p.slice(1);
                const result = pruneNestedConfigLeaf(prunedBlock, relative);
                if (result) {
                    prunedBlock = result.block;
                    prunedLeaves.push(result.removed);
                }
            }
            patched[key] = prunedBlock;
            const reason = customMessagesByKey.get(key);
            warnings.push(
                `"${key}": invalid nested field(s) ${prunedLeaves.map((l) => `"${l}"`).join(", ")}, using defaults for those.${reason ? ` ${reason}` : ""}`,
            );
            continue;
        }

        // `redactConfigValue` reports type and length, not resolved values, because `{env:...}` and `{file:...}` substitutions may expand secrets into `rawConfig`.
        delete patched[key];
        // Every top-level Zod issue path names a field in `defaults`.
        const defaultVal = (defaults as unknown as Record<string, unknown>)[key];
        const reason = customMessagesByKey.get(key);
        warnings.push(
            `"${key}": invalid value (${redactConfigValue(rawConfig[key])}), using default ${JSON.stringify(defaultVal)}.${reason ? ` ${reason}` : ""}`,
        );
    }

    // The field-recovery path reruns migrations so legacy experimental and dreamer-v1 blocks still migrate.
    const retryMigrated = migrateLegacyAgentEnabledInMemory(
        migrateDreamerV2(
            migrateLegacyExperimental(patched, preMigrationWarnings),
            preMigrationWarnings,
        ),
        preMigrationWarnings,
    );
    const retryParsed = MagicContextConfigSchema.safeParse(retryMigrated);
    if (retryParsed.success) {
        return {
            ...retryParsed.data,
            disabled_hooks: disabledHooks,
            command,
            configWarnings: [...preMigrationWarnings, ...warnings],
        };
    }

    warnings.push("Config recovery failed, using all defaults.");
    return {
        ...defaults,
        disabled_hooks: disabledHooks,
        command,
        configWarnings: [...preMigrationWarnings, ...warnings],
    };
}

export function loadPluginConfig(
    directory: string,
): MagicContextPluginConfig & { configWarnings?: string[] } {
    return loadPluginConfigDetailed(directory).config;
}

function hasUserTierSubcConfig(config: Record<string, unknown> | undefined): boolean {
    const { subc } = config ?? {};
    if (typeof subc !== "object" || subc === null || Array.isArray(subc)) return false;
    const connectionFile = (subc as Record<string, unknown>).connection_file;
    return typeof connectionFile === "string" && connectionFile.trim().length > 0;
}

function collectEmptyStringPaths(value: unknown, prefix = ""): string[] {
    if (typeof value === "string") {
        return value === "" && prefix ? [prefix] : [];
    }
    if (Array.isArray(value) || value === null || typeof value !== "object") {
        return [];
    }

    const paths: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const nextPrefix = prefix ? `${prefix}.${key}` : key;
        paths.push(...collectEmptyStringPaths(child, nextPrefix));
    }
    return paths;
}

function bindSubstitutionFailures(
    loaded: LoadedConfigFileDetailed | null,
): Array<{ keyPath: string; source: "user" | "project"; message: string }> {
    if (!loaded || loaded.warnings.length === 0 || loaded.outcome !== "substitution-failure") {
        return [];
    }

    const emptyPaths = collectEmptyStringPaths(loaded.config);
    return loaded.warnings.map((message) => {
        const matchedPath = emptyPaths.find((path) => {
            const tail = path.split(".").at(-1) ?? path;
            return message.includes(path) || message.toLowerCase().includes(tail.toLowerCase());
        });
        return { keyPath: matchedPath ?? "<unknown>", source: loaded.source, message };
    });
}

function combinedOutcome(args: {
    sources: LoadResultDetailed["sources"];
    substitutionFailures: LoadResultDetailed["substitutionFailures"];
    recoveredTopLevelKeys: string[];
}): LoadOutcome {
    const sourceOutcomes = Object.values(args.sources);
    if (sourceOutcomes.includes("project-file-parse-error")) return "project-file-parse-error";
    if (sourceOutcomes.includes("project-file-io-error")) return "project-file-io-error";
    if (sourceOutcomes.includes("legacy-config-unmigrated")) return "legacy-config-unmigrated";
    if (args.recoveredTopLevelKeys.length > 0) return "schema-recovery";
    if (args.substitutionFailures.length > 0) return "substitution-failure";
    return "ok";
}

export function loadPluginConfigDetailed(directory: string): LoadResultDetailed {
    const userDetected = detectConfigFile(getUserConfigBasePath());
    const projectDetected = detectConfigFile(getProjectConfigBasePath(directory));
    const legacySources = resolveLegacyConfigSources(directory);
    const harnessLegacy = resolveLegacyConfigSourcesForHarness(directory, "opencode");

    const userLegacyFallback =
        userDetected.format === "none"
            ? resolveLegacyReadFallback(harnessLegacy.user)
            : { source: null };
    const projectLegacyFallback =
        projectDetected.format === "none"
            ? resolveLegacyReadFallback(harnessLegacy.project)
            : { source: null };

    const legacyUserUnmigrated =
        userDetected.format === "none" &&
        !userLegacyFallback.source &&
        legacySources.user.some((source) => existsSync(source.path));
    const legacyProjectUnmigrated =
        projectDetected.format === "none" &&
        !projectLegacyFallback.source &&
        legacySources.project.some((source) => existsSync(source.path));

    const userLoaded =
        userDetected.format !== "none"
            ? loadConfigFileDetailed(userDetected.path, "user")
            : userLegacyFallback.source
              ? loadConfigFileDetailed(userLegacyFallback.source.path, "user")
              : null;
    const projectLoaded =
        projectDetected.format !== "none"
            ? loadConfigFileDetailed(projectDetected.path, "project")
            : projectLegacyFallback.source
              ? loadConfigFileDetailed(projectLegacyFallback.source.path, "project")
              : null;

    const allWarnings: string[] = [];
    let mergedRaw: Record<string, unknown> = {};
    const trustedBaseConfig = parsePluginConfig(userLoaded?.config ?? {});

    if (userLegacyFallback.source) {
        allWarnings.push(
            `[user config] reading legacy config from ${userLegacyFallback.source.path} until migration completes; run \`npx @cortexkit/magic-context doctor\` to consolidate into the shared CortexKit location.`,
        );
    } else if (legacyUserUnmigrated) {
        allWarnings.push(
            "[user config] legacy Magic Context config exists but the shared CortexKit config is absent; embedding registration is paused until config migration completes.",
        );
    }

    if (projectLegacyFallback.source) {
        allWarnings.push(
            `[project config] reading legacy config from ${projectLegacyFallback.source.path} until migration completes; run \`npx @cortexkit/magic-context doctor\` to consolidate into the shared CortexKit location.`,
        );
    } else if (legacyProjectUnmigrated) {
        allWarnings.push(
            "[project config] legacy Magic Context config exists but the shared CortexKit config is absent; embedding registration is paused until config migration completes.",
        );
    }

    if (userLoaded) {
        allWarnings.push(...userLoaded.warnings.map((w) => `[user config] ${w}`));
        mergedRaw = deepMergeRawConfig(mergedRaw, userLoaded.config);
    }

    if (projectLoaded) {
        allWarnings.push(...projectLoaded.warnings.map((w) => `[project config] ${w}`));
        const projectRaw = { ...projectLoaded.config };
        for (const warning of stripUnsafeProjectConfigFields(projectRaw)) {
            allWarnings.push(`[project config] ${warning}`);
        }
        mergedRaw = deepMergeRawConfig(mergedRaw, projectRaw);
        for (const warning of dropInheritedEmbeddingKeyOnRedirect(
            projectRaw,
            mergedRaw,
            userLoaded?.config,
        )) {
            allWarnings.push(`[project config] ${warning}`);
        }
        for (const warning of constrainProjectThresholdOverrides({
            mergedRaw,
            projectRaw,
            trustedBaseConfig,
        })) {
            allWarnings.push(`[project config] ${warning}`);
        }
    }

    const recoveredTopLevelKeys: string[] = [];
    const config = parsePluginConfig(mergedRaw, recoveredTopLevelKeys);
    setOutputReserveConfig(config.output_reserve);
    setWindowOverlayPath(config.models?.window_overlay_path);
    if (config.configWarnings?.length) {
        allWarnings.push(
            ...config.configWarnings.map((w) => {
                if (userLoaded && projectLoaded) return `[config] ${w}`;
                if (userLoaded) return `[user config] ${w}`;
                return `[project config] ${w}`;
            }),
        );
    }

    const resolvedTransformMode = resolveTransformMode({
        configured: config.transform_mode,
        userTierConfiguredRust: userLoaded?.config?.transform_mode === "rust",
        userTierHasSubc: hasUserTierSubcConfig(userLoaded?.config),
        compactionEnabled: isCompactionEnabled(config),
    });
    config.transform_mode = resolvedTransformMode.mode;
    allWarnings.push(...resolvedTransformMode.warnings.map((warning) => `[config] ${warning}`));

    if (allWarnings.length > 0) {
        config.configWarnings = allWarnings;
    } else if ("configWarnings" in config) {
        config.configWarnings = undefined;
    }

    const substitutionFailures = [
        ...bindSubstitutionFailures(userLoaded),
        ...bindSubstitutionFailures(projectLoaded),
    ];
    const sources = {
        userConfig:
            userLoaded?.outcome ??
            (legacyUserUnmigrated ? "legacy-config-unmigrated" : ("ok" as LoadOutcome)),
        projectConfig:
            projectLoaded?.outcome ??
            (legacyProjectUnmigrated ? "legacy-config-unmigrated" : ("ok" as LoadOutcome)),
    };

    return {
        config,
        registrationPromptSurface: trustedBaseConfig.prompt_surface,
        loadOutcome: combinedOutcome({ sources, substitutionFailures, recoveredTopLevelKeys }),
        sources,
        substitutionFailures,
        recoveredTopLevelKeys,
    };
}
