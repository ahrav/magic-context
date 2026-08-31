import {
	cortexKitProjectConfigBasePath,
	cortexKitUserConfigBasePath,
	type LegacyConfigSource,
	resolveLegacyConfigSources,
	resolveLegacyConfigSourcesForHarness,
} from "@magic-context/core/config/migrate-config-location";
import "@magic-context/core/config/prune-config-leaf";
import { existsSync, readFileSync } from "node:fs";
import { migrateLegacyAgentEnabledInMemory } from "@magic-context/core/config/agent-disable";
import { migrateDreamerV2 } from "@magic-context/core/config/migrate-dreamer-v2";
import { migrateLegacyExperimental } from "@magic-context/core/config/migrate-experimental";
import {
	constrainProjectThresholdOverrides,
	dropInheritedEmbeddingKeyOnRedirect,
	stripUnsafeProjectConfigFields,
} from "@magic-context/core/config/project-security";
import { pruneNestedConfigLeaf } from "@magic-context/core/config/prune-config-leaf";
import {
	type MagicContextConfig,
	MagicContextConfigSchema,
} from "@magic-context/core/config/schema/magic-context";
import { substituteConfigVariables } from "@magic-context/core/config/variable";
import {
	isPrototypePollutionKey,
	sanitizeParsedJson,
} from "@magic-context/core/shared/jsonc-parser";
import { setOutputReserveConfig } from "@magic-context/core/shared/models-dev-cache";
import type { PromptSurfaceConfig } from "@magic-context/core/shared/prompt-surface";
import { setWindowOverlayPath } from "@magic-context/core/shared/window-geometry";
import { parse as parseCommentJson } from "comment-json";

export interface LoadPiConfigOptions {
	cwd?: string;
}

export interface LoadPiConfigResult {
	config: MagicContextConfig;
	/** registrationPromptSurface contains USER-tier defaults and overrides before project routing merges. */
	registrationPromptSurface: PromptSurfaceConfig;
	warnings: string[];
	loadedFromPaths: string[];
}

export type LoadOutcome =
	| "ok"
	| "project-file-parse-error"
	| "project-file-io-error"
	| "legacy-config-unmigrated"
	| "schema-recovery"
	| "substitution-failure";

export interface LoadPiConfigResultDetailed extends LoadPiConfigResult {
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

interface LoadedConfigFile {
	path: string;
	scope: "user" | "project";
	config: Record<string, unknown>;
	warnings: string[];
	loadOutcome: LoadOutcome;
}

function getProjectConfigPaths(cwd: string): string[] {
	const basePath = cortexKitProjectConfigBasePath(cwd);
	return [`${basePath}.jsonc`, `${basePath}.json`];
}

function getUserConfigPaths(): string[] {
	const basePath = cortexKitUserConfigBasePath();
	return [`${basePath}.jsonc`, `${basePath}.json`];
}

function resolveFirstExisting(paths: string[]): string | undefined {
	return paths.find((path) => existsSync(path));
}

// Pi falls back to its legacy config so schema defaults do not re-enable user-disabled features.
// Pi reads only its legacy paths so another harness's legacy config cannot affect Pi.
function resolvePiLegacyFallback(
	sources: readonly LegacyConfigSource[],
): LegacyConfigSource | null {
	return sources.find((source) => existsSync(source.path)) ?? null;
}

function loadConfigFile(
	path: string,
	scope: "user" | "project",
): LoadedConfigFile | null {
	try {
		const rawText = readFileSync(path, "utf-8");
		const substituted = substituteConfigVariables({
			text: rawText,
			configPath: path,
			// Project configs cannot expand `{env:}` or `{file:}` tokens because they may expose secrets.
			// Project configs cannot expand `{env:}` or `{file:}` tokens because they may expose secrets.
			isProjectConfig: scope === "project",
		});
		const rejectedKeyPaths: string[] = [];
		const config = sanitizeParsedJson(
			parseCommentJson(substituted.text) as Record<string, unknown>,
			{ onRejectedKey: (keyPath) => rejectedKeyPaths.push(keyPath.join(".")) },
		);
		const unsafeKeyWarnings = rejectedKeyPaths.map(
			(keyPath) =>
				`Ignored unsafe config key "${keyPath}" (security: prototype-pollution keys are not allowed).`,
		);
		return {
			path,
			scope,
			config,
			warnings: [...substituted.warnings, ...unsafeKeyWarnings].map(
				(warning) => `${path}: ${warning}`,
			),
			loadOutcome:
				rejectedKeyPaths.length > 0
					? "schema-recovery"
					: substituted.warnings.length > 0
						? "substitution-failure"
						: "ok",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			path,
			scope,
			config: {},
			warnings: [
				`${path}: failed to load config: ${message}; using defaults for this file.`,
			],
			loadOutcome:
				typeof (error as { code?: unknown }).code === "string"
					? "project-file-io-error"
					: "project-file-parse-error",
		};
	}
}

function redactConfigValue(value: unknown): string {
	if (value === undefined) return "<missing>";
	if (value === null) return "null";
	if (typeof value === "string") {
		return `string, ${value.length} char${value.length === 1 ? "" : "s"}`;
	}
	if (typeof value === "number") return `number ${value}`;
	if (typeof value === "boolean") return `boolean ${value}`;
	if (Array.isArray(value))
		return `array, ${value.length} item${value.length === 1 ? "" : "s"}`;
	if (typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		return `object with keys [${keys.join(", ")}]`;
	}
	return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defineOwnConfigValue(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function mergeRawConfigs(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const key of Object.keys(base)) {
		if (isPrototypePollutionKey(key)) continue;
		defineOwnConfigValue(merged, key, base[key]);
	}

	for (const key of Object.keys(override)) {
		if (isPrototypePollutionKey(key)) continue;
		const overrideValue = override[key];
		const baseValue = Object.hasOwn(base, key) ? base[key] : undefined;
		const mergedValue =
			isPlainObject(baseValue) && isPlainObject(overrideValue)
				? mergeRawConfigs(baseValue, overrideValue)
				: overrideValue;
		defineOwnConfigValue(merged, key, mergedValue);
	}

	return merged;
}

function parsePiConfig(
	rawConfig: Record<string, unknown>,
	recoveredTopLevelKeys: string[] = [],
): {
	config: MagicContextConfig;
	warnings: string[];
} {
	const preMigrationWarnings: string[] = [];
	const agentMigrated = migrateLegacyAgentEnabledInMemory(
		rawConfig,
		preMigrationWarnings,
	);
	// Migration preserves each relocated key's opt-in or opt-out.
	const migrated = migrateDreamerV2(
		migrateLegacyExperimental(agentMigrated, preMigrationWarnings),
		preMigrationWarnings,
	);
	const parsed = MagicContextConfigSchema.safeParse(migrated);
	if (parsed.success) {
		return { config: parsed.data, warnings: preMigrationWarnings };
	}

	const defaults = MagicContextConfigSchema.parse({});
	const errorPaths = new Set<string>();
	// Validation retains full error paths for each top-level key.
	// Full error paths let recovery remove invalid nested leaves without deleting their containing block.
	const issuePathsByKey = new Map<string, PropertyKey[][]>();
	for (const issue of parsed.error.issues) {
		const topKey = issue.path[0];
		if (topKey !== undefined) {
			const key = String(topKey);
			errorPaths.add(key);
			const paths = issuePathsByKey.get(key) ?? [];
			paths.push([...issue.path]);
			issuePathsByKey.set(key, paths);
		}
	}

	const patched: Record<string, unknown> = { ...migrated };
	const warnings: string[] = [...preMigrationWarnings];

	for (const key of errorPaths) {
		recoveredTopLevelKeys.push(key);
		const isAgentConfig =
			key === "historian" || key === "dreamer" || key === "sidekick";

		if (isAgentConfig) {
			delete patched[key];
			warnings.push(
				`"${key}": invalid agent configuration, ignoring. Check your magic-context.jsonc.`,
			);
			continue;
		}

		// For object-valued keys, recovery prunes only invalid nested leaves and keeps valid siblings.
		// Recovery keeps valid `memory` siblings when one nested field is invalid.
		// Recovery deletes the entire key only when the error is at that key or its value is not an object.
		const issuePaths = issuePathsByKey.get(key) ?? [];
		const rawValue = migrated[key];
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
				// Recovery prunes the deepest invalid leaf so valid siblings remain.
				// Recovery preserves a sibling `enabled: false`.
				const relative = p.slice(1);
				const result = pruneNestedConfigLeaf(prunedBlock, relative);
				if (result) {
					prunedBlock = result.block;
					prunedLeaves.push(result.removed);
				}
			}
			patched[key] = prunedBlock;
			warnings.push(
				`"${key}": invalid nested field(s) ${prunedLeaves.map((l) => `"${l}"`).join(", ")}, using defaults for those.`,
			);
			continue;
		}

		delete patched[key];
		const defaultValue = (defaults as unknown as Record<string, unknown>)[key];
		warnings.push(
			`"${key}": invalid value (${redactConfigValue(rawConfig[key])}), using default ${JSON.stringify(defaultValue)}.`,
		);
	}

	const retryParsed = MagicContextConfigSchema.safeParse(patched);
	if (retryParsed.success) {
		return { config: retryParsed.data, warnings };
	}

	warnings.push("Config recovery failed, using all defaults.");
	return { config: defaults, warnings };
}

export function loadPiConfig(
	opts: LoadPiConfigOptions = {},
): LoadPiConfigResult {
	const cwd = opts.cwd ?? process.cwd();
	const loadedFiles: LoadedConfigFile[] = [];
	const warnings: string[] = [];
	const legacySources = resolveLegacyConfigSources(cwd);
	const harnessLegacy = resolveLegacyConfigSourcesForHarness(cwd, "pi");

	const projectPath = resolveFirstExisting(getProjectConfigPaths(cwd));
	const projectLegacyFallback = projectPath
		? null
		: resolvePiLegacyFallback(harnessLegacy.project);
	const projectReadPath = projectPath ?? projectLegacyFallback?.path;
	if (projectReadPath) {
		const loaded = loadConfigFile(projectReadPath, "project");
		if (loaded) loadedFiles.push(loaded);
	}
	const legacyProjectUnmigrated =
		!projectPath &&
		!projectLegacyFallback &&
		legacySources.project.some((source) => existsSync(source.path));

	const userPath = resolveFirstExisting(getUserConfigPaths());
	const userLegacyFallback = userPath
		? null
		: resolvePiLegacyFallback(harnessLegacy.user);
	const userReadPath = userPath ?? userLegacyFallback?.path;
	if (userReadPath) {
		const loaded = loadConfigFile(userReadPath, "user");
		if (loaded) loadedFiles.push(loaded);
	}
	const legacyUserUnmigrated =
		!userPath &&
		!userLegacyFallback &&
		legacySources.user.some((source) => existsSync(source.path));

	if (userLegacyFallback) {
		warnings.push(
			`[user config] reading legacy config from ${userLegacyFallback.path} until migration completes; run \`npx @cortexkit/magic-context doctor\` to consolidate into the shared CortexKit location.`,
		);
	} else if (legacyUserUnmigrated) {
		warnings.push(
			"[user config] legacy Magic Context config exists but the shared CortexKit config is absent; embedding registration is paused until config migration completes.",
		);
	}

	if (projectLegacyFallback) {
		warnings.push(
			`[project config] reading legacy config from ${projectLegacyFallback.path} until migration completes; run \`npx @cortexkit/magic-context doctor\` to consolidate into the shared CortexKit location.`,
		);
	} else if (legacyProjectUnmigrated) {
		warnings.push(
			"[project config] legacy Magic Context config exists but the shared CortexKit config is absent; embedding registration is paused until config migration completes.",
		);
	}

	let rawConfig: Record<string, unknown> = {};
	const mergeFiles = [...loadedFiles].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "user" ? -1 : 1;
	});
	// The guard treats a project endpoint matching the user's endpoint as a non-redirect.
	const userRaw = mergeFiles.find((f) => f.scope === "user")?.config;
	// The threshold trust boundary uses the effective USER/default config as its baseline.
	const trustedBaseConfig = parsePiConfig(userRaw ?? {}).config;

	for (const loaded of mergeFiles) {
		const prefix =
			loaded.scope === "user" ? "[user config]" : "[project config]";
		warnings.push(...loaded.warnings.map((warning) => `${prefix} ${warning}`));

		if (loaded.scope === "project") {
			// The loader sanitizes the untrusted project config before merging it.
			const projectRaw = { ...loaded.config };
			for (const warning of stripUnsafeProjectConfigFields(projectRaw)) {
				warnings.push(`${prefix} ${warning}`);
			}
			rawConfig = mergeRawConfigs(rawConfig, projectRaw);
			for (const warning of dropInheritedEmbeddingKeyOnRedirect(
				projectRaw,
				rawConfig,
				userRaw,
			)) {
				warnings.push(`${prefix} ${warning}`);
			}
			for (const warning of constrainProjectThresholdOverrides({
				mergedRaw: rawConfig,
				projectRaw,
				trustedBaseConfig,
			})) {
				warnings.push(`${prefix} ${warning}`);
			}
		} else {
			rawConfig = mergeRawConfigs(rawConfig, loaded.config);
		}
	}

	const parsed = parsePiConfig(rawConfig);
	setOutputReserveConfig(parsed.config.output_reserve);
	setWindowOverlayPath(parsed.config.models?.window_overlay_path);
	warnings.push(
		...parsed.warnings.map((warning) => `[merged config] ${warning}`),
	);

	return {
		config: parsed.config,
		registrationPromptSurface: trustedBaseConfig.prompt_surface,
		warnings,
		loadedFromPaths: loadedFiles.map((loaded) => loaded.path),
	};
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
	loaded: LoadedConfigFile,
): Array<{ keyPath: string; source: "user" | "project"; message: string }> {
	if (
		loaded.warnings.length === 0 ||
		loaded.loadOutcome !== "substitution-failure"
	) {
		return [];
	}
	const emptyPaths = collectEmptyStringPaths(loaded.config);
	return loaded.warnings.map((message) => {
		const matchedPath = emptyPaths.find((path) => {
			const tail = path.split(".").at(-1) ?? path;
			return (
				message.includes(path) ||
				message.toLowerCase().includes(tail.toLowerCase())
			);
		});
		return {
			keyPath: matchedPath ?? "<unknown>",
			source: loaded.scope,
			message,
		};
	});
}

function combinedOutcome(args: {
	sources: LoadPiConfigResultDetailed["sources"];
	substitutionFailures: LoadPiConfigResultDetailed["substitutionFailures"];
	recoveredTopLevelKeys: string[];
}): LoadOutcome {
	const sourceOutcomes = Object.values(args.sources);
	if (sourceOutcomes.includes("project-file-parse-error"))
		return "project-file-parse-error";
	if (sourceOutcomes.includes("project-file-io-error"))
		return "project-file-io-error";
	if (sourceOutcomes.includes("legacy-config-unmigrated"))
		return "legacy-config-unmigrated";
	if (args.recoveredTopLevelKeys.length > 0) return "schema-recovery";
	if (args.substitutionFailures.length > 0) return "substitution-failure";
	return "ok";
}

export function loadPiConfigDetailed(
	opts: LoadPiConfigOptions = {},
): LoadPiConfigResultDetailed {
	const cwd = opts.cwd ?? process.cwd();
	const loadedFiles: LoadedConfigFile[] = [];
	const warnings: string[] = [];
	const legacySources = resolveLegacyConfigSources(cwd);
	const harnessLegacy = resolveLegacyConfigSourcesForHarness(cwd, "pi");

	const projectPath = resolveFirstExisting(getProjectConfigPaths(cwd));
	const projectLegacyFallback = projectPath
		? null
		: resolvePiLegacyFallback(harnessLegacy.project);
	const projectReadPath = projectPath ?? projectLegacyFallback?.path;
	if (projectReadPath) {
		const loaded = loadConfigFile(projectReadPath, "project");
		if (loaded) loadedFiles.push(loaded);
	}
	const legacyProjectUnmigrated =
		!projectPath &&
		!projectLegacyFallback &&
		legacySources.project.some((source) => existsSync(source.path));

	const userPath = resolveFirstExisting(getUserConfigPaths());
	const userLegacyFallback = userPath
		? null
		: resolvePiLegacyFallback(harnessLegacy.user);
	const userReadPath = userPath ?? userLegacyFallback?.path;
	if (userReadPath) {
		const loaded = loadConfigFile(userReadPath, "user");
		if (loaded) loadedFiles.push(loaded);
	}
	const legacyUserUnmigrated =
		!userPath &&
		!userLegacyFallback &&
		legacySources.user.some((source) => existsSync(source.path));

	if (userLegacyFallback) {
		warnings.push(
			`[user config] reading legacy config from ${userLegacyFallback.path} until migration completes; run \`npx @cortexkit/magic-context doctor\` to consolidate into the shared CortexKit location.`,
		);
	} else if (legacyUserUnmigrated) {
		warnings.push(
			"[user config] legacy Magic Context config exists but the shared CortexKit config is absent; embedding registration is paused until config migration completes.",
		);
	}

	if (projectLegacyFallback) {
		warnings.push(
			`[project config] reading legacy config from ${projectLegacyFallback.path} until migration completes; run \`npx @cortexkit/magic-context doctor\` to consolidate into the shared CortexKit location.`,
		);
	} else if (legacyProjectUnmigrated) {
		warnings.push(
			"[project config] legacy Magic Context config exists but the shared CortexKit config is absent; embedding registration is paused until config migration completes.",
		);
	}

	let rawConfig: Record<string, unknown> = {};
	const mergeFiles = [...loadedFiles].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "user" ? -1 : 1;
	});
	const userRaw = mergeFiles.find((f) => f.scope === "user")?.config;
	// A cloned repository may delay compaction but must not lower thresholds enough to increase historian work for the user's account.
	const trustedBaseConfig = parsePiConfig(userRaw ?? {}).config;

	for (const loaded of mergeFiles) {
		const prefix =
			loaded.scope === "user" ? "[user config]" : "[project config]";
		warnings.push(...loaded.warnings.map((warning) => `${prefix} ${warning}`));

		if (loaded.scope === "project") {
			const projectRaw = { ...loaded.config };
			for (const warning of stripUnsafeProjectConfigFields(projectRaw)) {
				warnings.push(`${prefix} ${warning}`);
			}
			rawConfig = mergeRawConfigs(rawConfig, projectRaw);
			for (const warning of dropInheritedEmbeddingKeyOnRedirect(
				projectRaw,
				rawConfig,
				userRaw,
			)) {
				warnings.push(`${prefix} ${warning}`);
			}
			for (const warning of constrainProjectThresholdOverrides({
				mergedRaw: rawConfig,
				projectRaw,
				trustedBaseConfig,
			})) {
				warnings.push(`${prefix} ${warning}`);
			}
		} else {
			rawConfig = mergeRawConfigs(rawConfig, loaded.config);
		}
	}

	const recoveredTopLevelKeys: string[] = [];
	const parsed = parsePiConfig(rawConfig, recoveredTopLevelKeys);
	setOutputReserveConfig(parsed.config.output_reserve);
	setWindowOverlayPath(parsed.config.models?.window_overlay_path);
	warnings.push(
		...parsed.warnings.map((warning) => `[merged config] ${warning}`),
	);
	const substitutionFailures = loadedFiles.flatMap(bindSubstitutionFailures);
	const userLoaded = loadedFiles.find((loaded) => loaded.scope === "user");
	const projectLoaded = loadedFiles.find(
		(loaded) => loaded.scope === "project",
	);
	const sources = {
		userConfig:
			userLoaded?.loadOutcome ??
			(legacyUserUnmigrated
				? "legacy-config-unmigrated"
				: ("ok" as LoadOutcome)),
		projectConfig:
			projectLoaded?.loadOutcome ??
			(legacyProjectUnmigrated
				? "legacy-config-unmigrated"
				: ("ok" as LoadOutcome)),
	};

	return {
		config: parsed.config,
		registrationPromptSurface: trustedBaseConfig.prompt_surface,
		warnings,
		loadedFromPaths: loadedFiles.map((loaded) => loaded.path),
		loadOutcome: combinedOutcome({
			sources,
			substitutionFailures,
			recoveredTopLevelKeys,
		}),
		sources,
		substitutionFailures,
		recoveredTopLevelKeys,
	};
}
