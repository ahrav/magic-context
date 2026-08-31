/**
 *
 * Pi loads this extension once per session from `pi.extensions`.
 * agent_end cleanup.
 *
 * Pi and OpenCode share `~/.local/share/cortexkit/magic-context/context.db`.
 *   ~/.local/share/cortexkit/magic-context/context.db
 * Session-scoped tables use `harness` values `opencode` or `pi` to attribute each row to its harness.
 *
 * `loadPiConfig()` reads project config from `$cwd/.cortexkit/magic-context.jsonc` and user config from `~/.config/cortexkit/magic-context.jsonc`.
 * `loadPiConfig()` uses schema defaults when neither config file exists.
 */

import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isCompactionEnabled,
	isDreamerRunnable,
} from "@magic-context/core/config/agent-disable";
import { migrateMagicContextConfigLocations } from "@magic-context/core/config/migrate-config-location";
import type {
	DreamerConfig,
	HistorianConfig,
	MagicContextConfig,
	SidekickConfig,
} from "@magic-context/core/config/schema/magic-context";
import {
	summarizeDreamSchedule,
	userMemoryCollectionEnabled,
} from "@magic-context/core/features/magic-context/dreamer/task-config";
import {
	type FailClosedReason,
	formatFailClosedBlockingMessage,
} from "@magic-context/core/features/magic-context/fail-closed-block";
import { configureSynapseManagedDemandStart } from "@magic-context/core/features/magic-context/memory/embedding-synapse";
import {
	resolveProjectIdentityForSession,
	resolveProjectRootDirectory,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import { scheduleIncrementalIndex } from "@magic-context/core/features/magic-context/message-index-async";
import { detectOverflow } from "@magic-context/core/features/magic-context/overflow-detection";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	getOrCreateSessionMeta,
	getPendingPiCompactionMarkerState,
	getSessionsWithPendingPiMarker,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	applySqliteTuningPragmas,
	getFormatRefusal,
	getSchemaFenceRejection,
	openDatabaseAsync,
	setSqlitePragmaConfig,
} from "@magic-context/core/features/magic-context/storage-db";
import {
	getOverflowState,
	recordOverflowDetected,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { setCtxReduceRegisteredGlobally } from "@magic-context/core/hooks/magic-context/ctx-reduce-availability";
import {
	deriveHistorianChunkTokens,
	resolveHistorianContextLimit,
} from "@magic-context/core/hooks/magic-context/derive-budgets";
import { resolveCacheTtl } from "@magic-context/core/hooks/magic-context/event-resolvers";
import { createLazyManagedDemandStart } from "@magic-context/core/hooks/magic-context/module-transport";
import {
	clearNoteNudgeTriggerAndCooldown,
	onNoteTrigger,
} from "@magic-context/core/hooks/magic-context/note-nudger";
import { preloadTokenizer } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { normalizeTodoStateJson } from "@magic-context/core/hooks/magic-context/todo-view";
import { maybeSendUpgradeReminder } from "@magic-context/core/hooks/magic-context/upgrade-reminder";
import { beginBootQuietPeriod } from "@magic-context/core/plugin/boot-quiet";
import {
	ANNOUNCEMENT_FEATURES,
	ANNOUNCEMENT_FOOTER,
	ANNOUNCEMENT_VERSION,
	markAnnouncementSeen,
	shouldShowAnnouncement,
} from "@magic-context/core/shared/announcement";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { setKeepSubagents } from "@magic-context/core/shared/keep-subagents";
import { log } from "@magic-context/core/shared/logger";
import {
	createPromptSurfaceGuidanceEpochCache,
	createPromptSurfaceRuntime,
} from "@magic-context/core/shared/prompt-surface-runtime";
import { resolveFallbackChain } from "@magic-context/core/shared/resolve-fallbacks";
import { setStoragePrivatePermissionEnforcement } from "@magic-context/core/shared/storage-permissions";

import { handlePiCloneSessionStart } from "./clone-inheritance";
import { registerCtxApproveCommand } from "./commands/ctx-approve";
import {
	type PiSidekickConfig,
	registerCtxAugCommand,
} from "./commands/ctx-aug";
import { registerCtxDreamCommand } from "./commands/ctx-dream";
import {
	maybeAutoEmbedPiSession,
	registerCtxEmbedCommand,
} from "./commands/ctx-embed";
import { registerCtxEnforceCommand } from "./commands/ctx-enforce";
import { registerCtxFlushCommand } from "./commands/ctx-flush";
import { registerCtxRecompCommand } from "./commands/ctx-recomp";
import { registerCtxSessionUpgradeCommand } from "./commands/ctx-session-upgrade";
import { registerCtxStatusCommand } from "./commands/ctx-status";
import { registerCtxWrapupCommand } from "./commands/ctx-wrapup";
import {
	registerCtxStatusEntryRenderer,
	sendCtxStatusMessage,
} from "./commands/pi-command-utils";
import { loadPiConfig } from "./config";
import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	clearPiM0Cache,
	clearSystemPromptRefresh,
	hasSystemPromptRefresh,
	type PiAutoSearchHandlerOptions,
	type PiContextHandlerOptions,
	type PiHistorianOptions,
	recordPiLiveModel,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemPromptRefresh,
	signalPiSystemPromptRefreshForProject,
	trackSessionForProject,
} from "./context-handler";
import {
	markPiChannel1Reduced,
	maybeChannel1ReminderForToolResult,
	maybeDeliverChannel2Pi,
} from "./ctx-reduce-nudge-pi";
import {
	awaitInFlightDreamers,
	registerPiDreamerProject,
	unregisterPiDreamerProject,
} from "./dreamer";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { registerPiFailClosedSurface } from "./fail-closed-pi";
import { resolvePiUsableContextLimit } from "./pi-context-limit";
import { computePiPressure, extractAssistantUsage } from "./pi-pressure";
import { awaitInFlightRecomps } from "./pi-recomp-runner";
import { readPiSessionMessages } from "./read-session-pi";
import { registerStatusLine, updateStatusLine } from "./status-line";
import { stripTagPrefixFromAssistantMessage } from "./strip-tag-prefix";
import {
	configurePiSubagentExtensions,
	MAGIC_CONTEXT_PI_SUBAGENT_ENV,
	PiSubagentRunner,
} from "./subagent-runner";
import {
	buildMagicContextBlock,
	clearPiSystemPromptSession,
	composeMagicContextSystemPrompt,
	processSystemPromptForCache,
} from "./system-prompt";
import { withTimeout } from "./timeout";
import { registerMagicContextTools } from "./tools";
import {
	parseTodos,
	registerTodoOverlay,
	registerTodoStateLifecycle,
	rememberTodowriteToolCallTodos,
	setTodoSnapshot,
} from "./tools/todo-view-pi";

const PREFIX = "[magic-context][pi]";
const managedDemandStart = createLazyManagedDemandStart({
	declaringModuleUrl: import.meta.url,
	parentPackageName: "@cortexkit/pi-magic-context",
});

// ---------------------------------------------------------------------------
//
// `@gotgenes/pi-subagents` creates child sessions in the parent process, so a process-global latch prevents duplicate initialization.
// `MAGIC_CONTEXT_PI_SUBAGENT=1` excludes spawned subagents but not in-process children, which inherit the parent environment.
//
// The latch uses `Symbol.for` on `globalThis` so duplicate module instances share it.
// Later initializations register no watchers, timers, or background scans.
// parent's already-registered extension instance keeps serving its session.
//
// Pi clears the parent's latch on `session_shutdown` so `/reload` can initialize a new extension.
// Child `session_shutdown` events cannot invoke the parent's handlers.
// A no-op child registers no shutdown handler and cannot clear the parent's latch.
// it.
// ---------------------------------------------------------------------------
const PI_ACTIVE_LATCH = Symbol.for("magic-context.pi.active");

function isPiMagicContextActiveInProcess(): boolean {
	return (globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH] === true;
}

function markPiMagicContextActive(): void {
	(globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH] = true;
}

function clearPiMagicContextActive(): void {
	try {
		delete (globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH];
	} catch {
		// Some runtimes disallow delete on globalThis; fall back to overwrite.
		(globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH] = undefined;
	}
}

function resolveCurrentProject(
	ctx: { cwd: string },
	allowHomeProject = false,
): {
	projectDir: string;
	projectIdentity: string;
} {
	const projectDir = ctx.cwd;
	const projectIdentity =
		resolveProjectIdentityForSession(projectDir, allowHomeProject) ?? "";
	return { projectDir, projectIdentity };
}

export function signalPiDeferredCompactionMarkerDrain(sessionId: string): void {
	signalPiDeferredHistoryRefresh(sessionId);
	signalPiDeferredMaterialization(sessionId);
}

/**
 * Pi native compaction invalidates Magic Context's cached `m[0]` and `m[1]` bytes.
 * In normal mode, Magic Context cancels Pi's event because Magic Context owns compaction.
 * Compaction-off mode clears Pi's `m[0]` and `m[1]` cache without cancelling the event.
 */
export async function handlePiSessionBeforeCompact(args: {
	db: ContextDatabase;
	compactionOff: boolean;
	ctx: { sessionManager?: { getSessionId?: () => string | undefined } };
}): Promise<{ cancel: true } | undefined> {
	try {
		const sessionId = args.ctx.sessionManager?.getSessionId?.();
		if (typeof sessionId === "string" && sessionId.length > 0) {
			clearPiM0Cache(args.db, sessionId, "session_before_compact");
		}
	} catch {
		// Cache invalidation is best-effort; it must not suppress Pi's native path.
	}
	if (args.compactionOff) {
		info(
			"session_before_compact: native Pi compaction proceeds (compaction-off mode)",
		);
		return;
	}
	info("session_before_compact: cancelling — magic-context owns compaction");
	return { cancel: true };
}

export function canonicalPiModelKey(provider: string, model: string): string {
	return piModelRefToCanonical(`${provider}/${model}`);
}

export function persistPiMessageEndModelMeta(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	cacheTtlConfig: MagicContextConfig["cache_ttl"];
}): void {
	if (!args.message || typeof args.message !== "object") return;
	const msg = args.message as {
		role?: string;
		provider?: string;
		model?: string;
	};
	if (
		msg.role !== "assistant" ||
		typeof msg.provider !== "string" ||
		msg.provider.length === 0 ||
		typeof msg.model !== "string" ||
		msg.model.length === 0
	) {
		return;
	}
	const modelKey = canonicalPiModelKey(msg.provider, msg.model);
	recordPiLiveModel(args.sessionId, modelKey);
	const cacheTtl = resolveCacheTtl(args.cacheTtlConfig, modelKey);
	const currentMeta = getOrCreateSessionMeta(args.db, args.sessionId);
	if (currentMeta.cacheTtl !== cacheTtl) {
		updateSessionMeta(args.db, args.sessionId, { cacheTtl });
	}
}

type TodoOverlayUpdater = { update: (sessionId?: string) => void };

type CompatiblePiTodoCapture = {
	normalized: string;
	todos: Exclude<ReturnType<typeof parseTodos>, null>;
};

function getCompatiblePiTodoCapture(
	todos: unknown,
): CompatiblePiTodoCapture | null {
	if (!Array.isArray(todos)) return null;
	const normalized = normalizeTodoStateJson(todos);
	if (normalized === null) return null;
	const parsed = parseTodos(todos);
	if (parsed === null) return null;
	return { normalized, todos: parsed };
}

function applyCompatiblePiTodoCapture(args: {
	db: ContextDatabase;
	sessionId: string;
	todowriteEnabled: boolean;
	todoOverlay?: TodoOverlayUpdater;
	persist: boolean;
	toolCallId?: string;
	capture: CompatiblePiTodoCapture;
}): void {
	rememberTodowriteToolCallTodos(args.toolCallId, args.capture.todos);
	if (args.todowriteEnabled) {
		setTodoSnapshot(args.sessionId, args.capture.todos);
		args.todoOverlay?.update(args.sessionId);
	}
	if (args.persist) {
		updateSessionMeta(args.db, args.sessionId, {
			lastTodoState: args.capture.normalized,
		});
	}
}

/**
 * Capture `todowrite` payloads only when they match Magic Context's task-list enum contract.
 * Third-party Pi extensions can reuse the `todowrite` tool name.
 * Incompatible `todowrite` payloads must not update `last_todo_state` or the transcript render cache.
 */
export function capturePiTodowriteArgsIfCompatible(args: {
	db: ContextDatabase;
	sessionId: string;
	todos: unknown;
	todowriteEnabled: boolean;
	todoOverlay?: TodoOverlayUpdater;
	persist: boolean;
	toolCallId?: string;
}): boolean {
	const capture = getCompatiblePiTodoCapture(args.todos);
	if (capture === null) return false;
	applyCompatiblePiTodoCapture({ ...args, capture });
	return true;
}

/**
 * Capture only the first compatible `todowrite` call from an assistant `message_end` payload.
 * Accepting compatible payloads preserves interoperation with third-party tools that share the `todowrite` name.
 */
export function capturePiTodowriteMessageIfCompatible(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	todowriteEnabled: boolean;
	todoOverlay?: TodoOverlayUpdater;
	persist: boolean;
}): boolean {
	const msg = args.message as { role?: unknown; content?: unknown } | undefined;
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) {
		return false;
	}

	for (const block of msg.content) {
		if (!block || typeof block !== "object") continue;
		const b = block as {
			type?: unknown;
			name?: unknown;
			arguments?: unknown;
		};
		if (b.type !== "toolCall") continue;
		if (typeof b.name !== "string") continue;
		if (b.name !== "todowrite") continue;
		const capture = getCompatiblePiTodoCapture(
			(b.arguments as { todos?: unknown } | null | undefined)?.todos,
		);
		if (capture === null) continue;
		applyCompatiblePiTodoCapture({ ...args, capture });
		return true;
	}

	return false;
}

function info(message: string, data?: unknown): void {
	log(`${PREFIX} ${message}`, data);
}

function warn(message: string, data?: unknown): void {
	log(`${PREFIX} WARN ${message}`, data);
}

// The loader checks shared CortexKit paths before Pi-owned legacy files.
// The loader falls back to Pi-owned legacy files only when no shared CortexKit base exists.
// Cache each directory's migration result to avoid rerunning the idempotent, lock-guarded migration at every per-cwd switch.
const migratedConfigDirs = new Set<string>();
// Deduplicate config summaries and warnings by resolved directory when `args.dedupe` is true.
const loggedPiConfigDirs = new Set<string>();
function ensureConfigLocationsMigrated(dir: string): void {
	if (migratedConfigDirs.has(dir)) return;
	migratedConfigDirs.add(dir);
	migrateMagicContextConfigLocations(dir, {
		warn: (m) => warn(m),
		info: (m) => info(m),
	});
}

function logPiConfigLoad(args: {
	dir: string;
	loadedFromPaths: string[];
	warnings: string[];
	dedupe?: boolean;
}): void {
	const key = resolve(args.dir);
	if (args.dedupe && loggedPiConfigDirs.has(key)) return;
	if (args.dedupe) {
		loggedPiConfigDirs.add(key);
	}
	if (args.loadedFromPaths.length > 0) {
		info(`config loaded from: ${args.loadedFromPaths.join(", ")}`);
	} else {
		info("config: no magic-context.jsonc found, using schema defaults");
	}
	for (const warning of args.warnings) {
		warn(`config: ${warning}`);
	}
}

export const __test = {
	logPiConfigLoad,
	resetLoggedPiConfigDirs(): void {
		loggedPiConfigDirs.clear();
	},
	isPiMagicContextActiveInProcess,
	markPiMagicContextActive,
	clearPiMagicContextActive,
};

function formatTokens(value: number): string {
	return value.toLocaleString();
}

function getPiMessageModel(message: unknown): {
	provider: string | undefined;
	model: string | undefined;
} {
	if (!message || typeof message !== "object") {
		return { provider: undefined, model: undefined };
	}
	const msg = message as { provider?: unknown; model?: unknown };
	return {
		provider: typeof msg.provider === "string" ? msg.provider : undefined,
		model: typeof msg.model === "string" ? msg.model : undefined,
	};
}

function resolvePiPressureContextLimit(args: {
	db: ContextDatabase;
	sessionId: string;
	piContextWindow: number;
	model?: { provider?: string; id?: string; maxTokens?: number };
}): number {
	let detectedContextLimit: number | undefined;
	try {
		const overflowState = getOverflowState(args.db, args.sessionId);
		if (overflowState.detectedContextLimit > 0) {
			detectedContextLimit = overflowState.detectedContextLimit;
		}
	} catch (err) {
		warn("message_end: getOverflowState failed:", err);
	}
	return (
		resolvePiUsableContextLimit({
			rawContextWindow: args.piContextWindow,
			model: args.model,
			detectedContextLimit,
		}) ?? 0
	);
}

export async function persistPiPressureFromMessageEnd(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	piContextWindow: number;
	piModel?: { provider?: string; id?: string; maxTokens?: number };
	piTokens?: number;
	notifyIssue?: (message: string) => unknown | Promise<unknown>;
}): Promise<void> {
	const { provider, model } = getPiMessageModel(args.message);
	const effectiveContextLimit = resolvePiPressureContextLimit({
		db: args.db,
		sessionId: args.sessionId,
		piContextWindow: args.piContextWindow,
		model: args.piModel ?? { provider, id: model },
	});
	const usage = extractAssistantUsage(args.message);
	const pressure = computePiPressure(usage, effectiveContextLimit);
	const msg =
		args.message && typeof args.message === "object"
			? (args.message as { errorMessage?: unknown })
			: undefined;
	const messageHadOverflowError =
		typeof msg?.errorMessage === "string" &&
		detectOverflow(msg.errorMessage).isOverflow;
	const updates: Partial<{
		lastResponseTime: number;
		lastContextPercentage: number;
		lastInputTokens: number;
		observedSafeInputTokens: number;
		cacheAlertSent: boolean;
	}> = { lastResponseTime: Date.now() };

	if (pressure) {
		const percentage = pressure.percentage;
		const contextLimit = effectiveContextLimit;
		const meta = getOrCreateSessionMeta(args.db, args.sessionId);
		const observedSafeInputTokens = meta.observedSafeInputTokens ?? 0;
		if (
			percentage > 100 &&
			observedSafeInputTokens > 0 &&
			pressure.inputTokens <= observedSafeInputTokens * 2
		) {
			if (!meta.cacheAlertSent) {
				updates.cacheAlertSent = true;
				const safeTokens = Math.max(
					observedSafeInputTokens,
					pressure.inputTokens,
				);
				const modelLabel =
					provider && model ? `${provider}/${model}` : "the active model";
				await args.notifyIssue?.(
					`⚠️ Magic Context: Pi reports a context limit of ${formatTokens(contextLimit)} tokens for ${modelLabel} but you've successfully sent ${formatTokens(safeTokens)} tokens in this session — the reported limit looks wrong. Restart Pi if you suspect this is incorrect.`,
				);
			}
		}
		updates.lastContextPercentage = percentage;
		updates.lastInputTokens = pressure.inputTokens;
		if (!messageHadOverflowError) {
			updates.observedSafeInputTokens = Math.max(
				observedSafeInputTokens,
				pressure.inputTokens,
			);
		}
	} else if (typeof args.piTokens === "number") {
		updates.lastInputTokens = args.piTokens;
		if (effectiveContextLimit > 0) {
			updates.lastContextPercentage =
				(args.piTokens / effectiveContextLimit) * 100;
		}
	}

	updateSessionMeta(args.db, args.sessionId, updates);
}

/* */
const PLUGIN_VERSION: string = (() => {
	try {
		const req = createRequire(import.meta.url);
		return (req("../package.json") as { version: string }).version;
	} catch {
		return "0.0.0";
	}
})();

/**
 * */
setHarness("pi");

// ---------------------------------------------------------------------------
// Config-driven resolvers
//
// resolvers below
// Each resolver returns `undefined` when its feature is disabled, allowing registration helpers to short-circuit.
//
// ---------------------------------------------------------------------------

export function resolveSidekickFromConfig(
	config: MagicContextConfig,
): PiSidekickConfig | undefined {
	const sidekick = config.sidekick as SidekickConfig | undefined;
	if (!sidekick || sidekick.disable === true) return undefined;
	const model = sidekick.model?.trim();
	if (!model || model.length === 0) return undefined;
	return {
		model,
		systemPrompt: sidekick.system_prompt,
		timeoutMs: sidekick.timeout_ms,
		thinking_level: sidekick.thinking_level,
		fallbackModels: resolveFallbackChain(sidekick.fallback_models),
		language: config.language,
		allowHomeProject: config.allow_home_project,
	};
}

export function resolveHistorianFromConfig(
	config: MagicContextConfig,
): PiHistorianOptions | undefined {
	// Malformed JSONC merges can omit `historian` despite its schema default; use undefined-safe access.
	const historian = config.historian as HistorianConfig | undefined;
	if (historian?.disable === true) return undefined;
	const model = historian?.model?.trim();
	if (!model || model.length === 0) return undefined;

	// `historianContextLimit` uses the historian model because the model bounds one summarizer call; Pi resolves the trigger budget per context pass from the live main-session model and effective execute threshold to match OpenCode.
	const historianContextLimit = resolveHistorianContextLimit(model);
	const historianChunkTokens = deriveHistorianChunkTokens(
		historianContextLimit,
	);

	const fallbackModels = resolveFallbackChain(historian?.fallback_models);

	return {
		runner: new PiSubagentRunner(),
		model,
		fallbackModels,
		historianChunkTokens,
		timeoutMs: config.historian_timeout_ms,
		// `historian.two_pass` runs an editor pass after the first pass to remove low-signal `U:` lines and cross-compartment duplicates. It defaults to false because the second historian round trip adds latency and token cost.
		twoPass: historian?.two_pass === true,
		// Pi uses the configured thinking level for historian subagent invocations.
		// `PiSubagentRunner` passes `thinkingLevel` as `--thinking <level>` to the Pi subprocess.
		thinkingLevel: historian?.thinking_level,
		executeThresholdPercentage: config.execute_threshold_percentage,
		executeThresholdTokens: config.execute_threshold_tokens,
		commitClusterTrigger: config.commit_cluster_trigger,
		protectedTags: config.protected_tags,
		clearReasoningAge: config.clear_reasoning_age,
		historyBudgetPercentage: config.history_budget_percentage,
		memoryEnabled: config.memory.enabled,
		autoPromote: config.memory.auto_promote,
		userMemoriesEnabled: userMemoryCollectionEnabled(config.dreamer),
		language: config.language,
		allowHomeProject: config.allow_home_project,
	};
}

function resolveAutoSearchFromConfig(
	config: MagicContextConfig,
): PiAutoSearchHandlerOptions {
	const auto = config.memory.auto_search;
	const enabled = auto?.enabled ?? false;
	return {
		enabled,
		scoreThreshold: auto?.score_threshold ?? 0.55,
		minPromptChars: auto?.min_prompt_chars ?? 20,
	};
}

export function resolveDreamerFromConfig(
	config: MagicContextConfig,
): DreamerConfig | undefined {
	return config.dreamer?.disable === true ? undefined : config.dreamer;
}

/**
 *
 */
export default async function (pi: ExtensionAPI): Promise<void> {
	if (process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] === "1") {
		log(
			`${PREFIX} subagent child detected (${MAGIC_CONTEXT_PI_SUBAGENT_ENV}=1); skipping full extension registration`,
		);
		return;
	}
	// `@gotgenes/pi-subagents` runs child agent sessions in the parent process.
	// Child sessions inherit the parent's environment and re-run this factory, so the spawned-child guard does not run.
	// The process-global latch records that the full Magic Context runtime is active in this process.
	// A second initialization starts no watchers, timers, or background scans.
	// Disposal and `/reload` re-arm the latch for a later registration.
	if (isPiMagicContextActiveInProcess()) {
		log(
			`${PREFIX} in-process re-init detected (Magic Context already active in this process); skipping full extension registration`,
		);
		return;
	}
	configureSynapseManagedDemandStart(managedDemandStart);
	markPiMagicContextActive();
	beginBootQuietPeriod();

	// The runtime resolves the user-tier storage policy before opening the shared database because project config cannot alter it.
	// Every project in this process uses the operator's owner-private or externally managed permission policy.
	const bootProjectDir = process.cwd();
	ensureConfigLocationsMigrated(bootProjectDir);
	const bootConfig = loadPiConfig({ cwd: bootProjectDir });
	setStoragePrivatePermissionEnforcement(
		bootConfig.config.storage.enforce_private_permissions,
	);
	setSqlitePragmaConfig({
		cacheSizeMb: bootConfig.config.sqlite.cache_size_mb,
		mmapSizeMb: bootConfig.config.sqlite.mmap_size_mb,
	});

	const storageDir = getMagicContextStorageDir();
	const dbPath = join(storageDir, "context.db");

	let db: ContextDatabase | null | undefined;
	let openFailureCause: string | null = null;
	try {
		db = await openDatabaseAsync();
	} catch (err) {
		openFailureCause = err instanceof Error ? err.message : String(err);
		db = null;
	}

	// `openDatabaseAsync()` returns `null` when the persisted schema is newer than this binary supports.
	// `openDatabaseAsync()` signals unsupported newer schemas with `null`; the catch handles thrown database-open and migration failures.
	// When fail_closed_blocking is on (the default), Magic Context registers a blocking surface.
	// The blocking surface prevents Magic Context from silently skipping hooks.
	if (!db) {
		const projectDirForConfig = process.cwd();
		ensureConfigLocationsMigrated(projectDirForConfig);
		const early = loadPiConfig({ cwd: projectDirForConfig });
		if (!early.config.enabled) {
			info(
				"plugin DISABLED via config (enabled: false) — skipping registration",
			);
			return;
		}
		const formatRefusal = getFormatRefusal();
		const fence = getSchemaFenceRejection();
		const reason: FailClosedReason = formatRefusal
			? {
					kind: "format_refusal",
					family: formatRefusal.family,
					reasons: formatRefusal.reasons,
				}
			: fence
				? {
						kind: "schema_fence",
						persistedVersion: fence.persistedVersion,
						supportedVersion: fence.supportedVersion,
					}
				: {
						kind: "storage_failure",
						cause:
							openFailureCause ??
							`storage unavailable at ${dbPath} (unsupported database format, or open failed)`,
					};
		if (
			early.config.fail_closed_blocking === false ||
			!isCompactionEnabled(early.config)
		) {
			warn(
				`Magic Context (pi) storage unavailable at ${dbPath}: ${formatFailClosedBlockingMessage(reason)}. ` +
					"fail_closed_blocking=false — degrading silently (hooks not registered).",
			);
			return;
		}
		warn(
			`Magic Context (pi) storage unavailable at ${dbPath}: ${formatFailClosedBlockingMessage(reason)}`,
		);
		let fullRuntimeStarted = false;
		registerPiFailClosedSurface(pi, {
			reason,
			tryReopen: async () => {
				try {
					return await openDatabaseAsync();
				} catch {
					return null;
				}
			},
			onRecovered: async (recoveredDb) => {
				if (fullRuntimeStarted) return;
				fullRuntimeStarted = true;
				await startPiMagicContextRuntime(pi, recoveredDb, dbPath);
			},
		});
		return;
	}

	await startPiMagicContextRuntime(pi, db, dbPath);
}

/**
 * The fail-closed surface can re-probe and start the runtime without a process restart.
 */
async function startPiMagicContextRuntime(
	pi: ExtensionAPI,
	database: ContextDatabase,
	dbPath: string,
): Promise<void> {
	const db = database;

	// The boot project affects only initial config loading and logging.
	// Identity and path resolution use `ctx.cwd` for each hook and command, so cwd switches follow the active project without reloading config.
	const projectDir = process.cwd();
	const seenDreamerProjectIdentities = new Set<string>();
	// Invalid config fields use defaults per key.
	//
	// `warn()` surfaces invalid-config warnings to users.
	ensureConfigLocationsMigrated(projectDir);
	const { config, warnings, loadedFromPaths, registrationPromptSurface } =
		loadPiConfig({
			cwd: projectDir,
		});
	const promptSurfaceRuntime = createPromptSurfaceRuntime({
		harness: "pi",
		directory: projectDir,
		warn: (message) => warn(`config: ${message}`),
	});
	const promptSurfaceGuidanceEpochs =
		createPromptSurfaceGuidanceEpochCache(promptSurfaceRuntime);
	const projectIdentity =
		resolveProjectIdentityForSession(projectDir, config.allow_home_project) ??
		"";
	if (projectIdentity) seenDreamerProjectIdentities.add(projectIdentity);
	info(
		`loaded v${PLUGIN_VERSION} | harness=pi | db=${dbPath} | ` +
			`project=${projectIdentity} | dir=${projectDir}`,
	);
	// Pi registers tools once per process, so compaction registration does not follow later /cd config changes.
	const compactionOff = !isCompactionEnabled(config);
	setCtxReduceRegisteredGlobally(!compactionOff);
	if (!compactionOff) {
		try {
			const pendingPiMarkerSessions = getSessionsWithPendingPiMarker(db);
			for (const sid of pendingPiMarkerSessions) {
				signalPiDeferredCompactionMarkerDrain(sid);
			}
			if (pendingPiMarkerSessions.length > 0) {
				log(
					`${PREFIX} rehydrated ${pendingPiMarkerSessions.length} Pi deferred compaction marker session(s)`,
				);
			}
		} catch (err) {
			warn(
				`Magic Context (pi) failed to rehydrate deferred Pi compaction markers: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	// Pi configures child-runner extensions once at boot because the allowlist is user-tier only.
	// The returned merged config strips project-level subagent extension settings.
	configurePiSubagentExtensions(config.pi?.subagent_extensions);
	logPiConfigLoad({
		dir: projectDir,
		loadedFromPaths,
		warnings,
		dedupe: true,
	});

	// setSqlitePragmaConfig supplies cache_size and mmap_size to future opens in this process.
	// setSqlitePragmaConfig.
	setStoragePrivatePermissionEnforcement(
		config.storage.enforce_private_permissions,
	);
	setSqlitePragmaConfig({
		cacheSizeMb: config.sqlite.cache_size_mb,
		mmapSizeMb: config.sqlite.mmap_size_mb,
	});
	applySqliteTuningPragmas(db);

	// keep_subagents preserves child sessions after successful completion.
	setKeepSubagents(config.keep_subagents === true);

	if (!config.enabled) {
		info("plugin DISABLED via config (enabled: false) — skipping registration");
		return;
	}

	await ensureProjectRegisteredFromPiDirectory(projectDir, db);
	info(
		`registered embedding config for project ${projectIdentity ?? "(no project identity; cwd is $HOME)"}`,
	);

	type ResolvedPiProjectDeps = {
		projectDir: string;
		projectIdentity: string;
		config: MagicContextConfig;
		historianConfig: PiHistorianOptions | undefined;
		autoSearchConfig: PiAutoSearchHandlerOptions;
		contextOptions: PiContextHandlerOptions;
		sidekickConfig: PiSidekickConfig | undefined;
		dreamerConfig: DreamerConfig | undefined;
		dreamerEnabled: boolean;
	};

	// Pi resolves runtime dependencies per cwd because /cd and multi-root sessions can switch projects while registrations remain process-wide.
	// The memoized project-dependency accessor resolves project-sensitive configuration for the active cwd.
	const projectDepsByDir = new Map<string, ResolvedPiProjectDeps>();

	const buildContextOptions = (
		cfg: MagicContextConfig,
		hist: PiHistorianOptions | undefined,
		auto: PiAutoSearchHandlerOptions,
	): PiContextHandlerOptions => ({
		db: database,
		smartDrops: cfg.smart_drops === true,
		protectedTags: cfg.protected_tags ?? 20,
		heuristics: {
			caveman: cfg.caveman_text_compression
				? {
						enabled: cfg.caveman_text_compression.enabled,
						minChars: cfg.caveman_text_compression.min_chars,
					}
				: undefined,
			clearReasoningAge: cfg.clear_reasoning_age,
		},
		injection: {
			memoryEnabled: cfg.memory.enabled,
			injectDocs: cfg.dreamer?.inject_docs !== false,
			injectionBudgetTokens: cfg.memory.injection_budget_tokens,
			temporalAwareness: cfg.temporal_awareness === true,
			muralEnabled: cfg.mural.enabled === true,
		},
		scheduler: {
			executeThresholdPercentage: cfg.execute_threshold_percentage,
			executeThresholdTokens: cfg.execute_threshold_tokens,
		},
		historian: hist,
		language: cfg.language,
		autoSearch: auto,
		resolveForProject: resolveContextOptionsForProject,
		compactionOff,
		allowHomeProject: cfg.allow_home_project,
		maybeAutoEmbedSession: (sessionId, dir, identity) => {
			maybeAutoEmbedPiSession(
				{
					db: database,
					projectDir: dir,
					projectIdentity: identity,
					memoryEnabled: cfg.memory.enabled,
				},
				sessionId,
				dir,
				identity,
				(text) => {
					sendCtxStatusMessage(pi, {
						title: "/ctx-embed",
						text,
						level: "info",
					});
				},
			);
		},
	});

	function buildProjectDeps(
		dir: string,
		identity: string,
		cfg: MagicContextConfig,
	): ResolvedPiProjectDeps {
		const hist = resolveHistorianFromConfig(cfg);
		if (hist) {
			hist.onStatusChange = (ctx) => {
				updateStatusLine(ctx, {
					db: database,
					projectIdentity:
						resolveCurrentProject(ctx, cfg.allow_home_project)
							.projectIdentity ?? "",
				});
			};
		}
		const auto = resolveAutoSearchFromConfig(cfg);
		return {
			projectDir: dir,
			projectIdentity: identity,
			config: cfg,
			historianConfig: hist,
			autoSearchConfig: auto,
			contextOptions: buildContextOptions(cfg, hist, auto),
			sidekickConfig: resolveSidekickFromConfig(cfg),
			dreamerConfig: resolveDreamerFromConfig(cfg),
			dreamerEnabled: isDreamerRunnable(cfg),
		};
	}

	function resolveProjectDepsForDir(
		dir: string,
		identityOverride?: string,
	): ResolvedPiProjectDeps {
		const cached = projectDepsByDir.get(dir);
		if (cached) return cached;
		ensureConfigLocationsMigrated(dir);
		const switchedLoad = loadPiConfig({ cwd: dir });
		logPiConfigLoad({
			dir,
			loadedFromPaths: switchedLoad.loadedFromPaths,
			warnings: switchedLoad.warnings,
			dedupe: true,
		});
		const switchedConfig = switchedLoad.config;
		const switchedIdentity =
			identityOverride ??
			resolveProjectIdentityForSession(
				dir,
				switchedConfig.allow_home_project,
			) ??
			"";
		const built = buildProjectDeps(dir, switchedIdentity, switchedConfig);
		projectDepsByDir.set(dir, built);
		return built;
	}

	function resolveCurrentProjectDeps(ctx: {
		cwd: string;
	}): ResolvedPiProjectDeps {
		return resolveProjectDepsForDir(ctx.cwd);
	}

	function resolveContextOptionsForProject(
		dir: string,
	): PiContextHandlerOptions {
		return resolveProjectDepsForDir(dir).contextOptions;
	}

	const bootProjectDeps = buildProjectDeps(projectDir, projectIdentity, config);
	projectDepsByDir.set(projectDir, bootProjectDeps);
	const todowriteEnabled = bootProjectDeps.config.todowrite.enabled !== false;
	const todowriteOverlayEnabled =
		todowriteEnabled && bootProjectDeps.config.todowrite.overlay !== false;

	// directory.
	// Pi registers tools and slash commands once per process.
	registerMagicContextTools(pi, {
		db,
		ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
		// `--magic-context-dreamer-actions` flag.
		allowDreamerActions: false,
		// Pi registers tools once per process even though /cd can change projects.
		memoryToolEnabled: true,
		protectedTags: config.protected_tags ?? 20,
		resolveProtectedTags: (ctx) =>
			resolveCurrentProjectDeps(ctx).config.protected_tags ?? 20,
		resolveProjectIdentity: (ctx) =>
			resolveCurrentProjectDeps(ctx).projectIdentity,
		dreamerEnabled: isDreamerRunnable(config),
		resolveDreamerEnabled: (ctx) =>
			resolveCurrentProjectDeps(ctx).dreamerEnabled,
		todowriteEnabled,
		compactionOff,
		promptSurface: registrationPromptSurface,
		promptSurfaceRuntime,
	});
	info(
		compactionOff
			? todowriteEnabled
				? "registered tools: ctx_search, ctx_memory, ctx_note, ctx_expand, todowrite; registered /todos (ctx_reduce unavailable in compaction-off mode)"
				: "registered tools: ctx_search, ctx_memory, ctx_note, ctx_expand (ctx_reduce unavailable in compaction-off mode; todowrite disabled)"
			: todowriteEnabled
				? "registered tools: ctx_search, ctx_memory, ctx_note, ctx_expand, todowrite, ctx_reduce; registered /todos"
				: "registered tools: ctx_search, ctx_memory, ctx_note, ctx_expand, ctx_reduce (todowrite disabled)",
	);

	pi.on("session_start", async (event, ctx) => {
		await handlePiCloneSessionStart(event, ctx, {
			db,
			signalPendingMarker: signalPiDeferredCompactionMarkerDrain,
		});
	});

	const readLastTodoState = (sessionId: string) =>
		getOrCreateSessionMeta(db, sessionId).lastTodoState;
	if (todowriteEnabled) {
		registerTodoStateLifecycle(pi, { readLastTodoState });
	}
	const todoOverlay = todowriteOverlayEnabled
		? registerTodoOverlay(pi, {
				readLastTodoState,
			})
		: undefined;
	info(
		todowriteOverlayEnabled
			? "registered todowrite overlay"
			: "registered todowrite overlay: DISABLED (todowrite.enabled=false or todowrite.overlay=false)",
	);

	registerPiContextHandler(pi, bootProjectDeps.contextOptions);
	info(
		bootProjectDeps.historianConfig
			? `registered historian trigger (model=${bootProjectDeps.historianConfig.model}, executeThreshold=${formatExecuteThresholdForLog(bootProjectDeps.historianConfig.executeThresholdPercentage)})`
			: "registered historian trigger: DISABLED (set historian.model in magic-context.jsonc)",
	);
	info(
		bootProjectDeps.autoSearchConfig.enabled
			? `registered auto-search hint (threshold=${bootProjectDeps.autoSearchConfig.scoreThreshold}, minChars=${bootProjectDeps.autoSearchConfig.minPromptChars})`
			: "registered auto-search hint: DISABLED (memory.auto_search.enabled=false)",
	);

	registerCtxAugCommand(
		pi,
		(ctx) => resolveCurrentProjectDeps(ctx).sidekickConfig,
	);
	info(
		bootProjectDeps.sidekickConfig
			? `registered /ctx-aug (sidekick model=${bootProjectDeps.sidekickConfig.model})`
			: "registered /ctx-aug (sidekick disabled — set sidekick.disable=false and sidekick.model in config)",
	);

	const statusEntryRendererAvailable = registerCtxStatusEntryRenderer(pi);
	info(
		statusEntryRendererAvailable
			? "registered model-invisible ctx-status entry renderer"
			: "ctx-status entry renderer unavailable; using legacy visible-message fallback",
	);

	const recompRunner = new PiSubagentRunner();
	const wrapupRunner = new PiSubagentRunner();
	const upgradeRunner = new PiSubagentRunner();
	registerCtxStatusCommand(pi, {
		db,
		projectIdentity,
		resolveProject: resolveCurrentProject,
		protectedTags: bootProjectDeps.config.protected_tags,
		executeThresholdPercentage:
			bootProjectDeps.config.execute_threshold_percentage,
		historyBudgetPercentage: bootProjectDeps.config.history_budget_percentage,
		injectionBudgetTokens:
			bootProjectDeps.config.memory?.injection_budget_tokens,
		commitClusterTrigger: bootProjectDeps.config.commit_cluster_trigger,
		executeThresholdTokens: bootProjectDeps.config.execute_threshold_tokens,
		dreamer: {
			runnable: bootProjectDeps.dreamerEnabled,
			scheduleSummary: summarizeDreamSchedule(bootProjectDeps.config.dreamer),
		},
		resolveStatusDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				projectIdentity: current.projectIdentity,
				protectedTags: current.config.protected_tags,
				executeThresholdPercentage: current.config.execute_threshold_percentage,
				historyBudgetPercentage: current.config.history_budget_percentage,
				injectionBudgetTokens: current.config.memory?.injection_budget_tokens,
				commitClusterTrigger: current.config.commit_cluster_trigger,
				executeThresholdTokens: current.config.execute_threshold_tokens,
				dreamer: {
					runnable: current.dreamerEnabled,
					scheduleSummary: summarizeDreamSchedule(current.config.dreamer),
				},
			};
		},
	});
	info("registered /ctx-status");
	registerStatusLine(pi, { db, projectIdentity });
	info("registered magic-context status line");

	registerCtxFlushCommand(pi, { db, compactionOff });
	info("registered /ctx-flush");

	const resolveCommandProject = (ctx: { cwd: string }) => ({
		projectDir: resolveProjectRootDirectory(ctx.cwd),
		projectIdentity: resolveCurrentProjectDeps(ctx).projectIdentity,
	});
	registerCtxApproveCommand(pi, {
		db,
		projectDir,
		projectIdentity,
		resolveProject: resolveCommandProject,
	});
	info("registered /ctx-approve");
	registerCtxEnforceCommand(pi, {
		db,
		projectDir,
		projectIdentity,
		resolveProject: resolveCommandProject,
	});
	info("registered /ctx-enforce");

	registerCtxRecompCommand(pi, {
		db,
		runner: recompRunner,
		historianModel: bootProjectDeps.historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(bootProjectDeps.historianConfig?.model),
		),
		historianFallbacks: bootProjectDeps.historianConfig?.fallbackModels,
		historianTimeoutMs: bootProjectDeps.config.historian_timeout_ms,
		historianThinkingLevel: bootProjectDeps.historianConfig?.thinkingLevel,
		language: bootProjectDeps.config.language,
		memoryEnabled: bootProjectDeps.config.memory.enabled,
		autoPromote: bootProjectDeps.config.memory.auto_promote,
		compactionOff,
		resolveRuntimeDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				runner: recompRunner,
				historianModel: current.historianConfig?.model,
				historianChunkTokens: deriveHistorianChunkTokens(
					resolveHistorianContextLimit(current.historianConfig?.model),
				),
				historianFallbacks: current.historianConfig?.fallbackModels,
				historianTimeoutMs: current.config.historian_timeout_ms,
				historianThinkingLevel: current.historianConfig?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: current.config.memory.enabled,
				autoPromote: current.config.memory.auto_promote,
				compactionOff,
			};
		},
	});
	info("registered /ctx-recomp");

	registerCtxWrapupCommand(pi, {
		db,
		runner: wrapupRunner,
		historianModel: bootProjectDeps.historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(bootProjectDeps.historianConfig?.model),
		),
		historianFallbacks: bootProjectDeps.historianConfig?.fallbackModels,
		historianTimeoutMs: bootProjectDeps.config.historian_timeout_ms,
		historianThinkingLevel: bootProjectDeps.historianConfig?.thinkingLevel,
		language: bootProjectDeps.config.language,
		memoryEnabled: bootProjectDeps.config.memory.enabled,
		autoPromote: bootProjectDeps.config.memory.auto_promote,
		compactionOff,
		userMemoriesEnabled: userMemoryCollectionEnabled(
			bootProjectDeps.config.dreamer,
		),
		executeThresholdPercentage:
			bootProjectDeps.config.execute_threshold_percentage,
		executeThresholdTokens: bootProjectDeps.config.execute_threshold_tokens,
		resolveRuntimeDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				runner: wrapupRunner,
				historianModel: current.historianConfig?.model,
				historianChunkTokens: deriveHistorianChunkTokens(
					resolveHistorianContextLimit(current.historianConfig?.model),
				),
				historianFallbacks: current.historianConfig?.fallbackModels,
				historianTimeoutMs: current.config.historian_timeout_ms,
				historianThinkingLevel: current.historianConfig?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: current.config.memory.enabled,
				autoPromote: current.config.memory.auto_promote,
				compactionOff,
				userMemoriesEnabled: userMemoryCollectionEnabled(
					current.config.dreamer,
				),
				executeThresholdPercentage: current.config.execute_threshold_percentage,
				executeThresholdTokens: current.config.execute_threshold_tokens,
			};
		},
	});
	info("registered /ctx-wrapup");

	registerCtxSessionUpgradeCommand(pi, {
		db,
		runner: upgradeRunner,
		historianModel: bootProjectDeps.historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(bootProjectDeps.historianConfig?.model),
		),
		historianFallbacks: bootProjectDeps.historianConfig?.fallbackModels,
		historianTimeoutMs: bootProjectDeps.config.historian_timeout_ms,
		historianThinkingLevel: bootProjectDeps.historianConfig?.thinkingLevel,
		language: bootProjectDeps.config.language,
		memoryEnabled: bootProjectDeps.config.memory.enabled,
		allowHomeProject: bootProjectDeps.config.allow_home_project,
		autoPromote: bootProjectDeps.config.memory.auto_promote,
		compactionOff,
		userMemoriesEnabled: userMemoryCollectionEnabled(
			bootProjectDeps.config.dreamer,
		),
		resolveRuntimeDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				runner: upgradeRunner,
				historianModel: current.historianConfig?.model,
				historianChunkTokens: deriveHistorianChunkTokens(
					resolveHistorianContextLimit(current.historianConfig?.model),
				),
				historianFallbacks: current.historianConfig?.fallbackModels,
				historianTimeoutMs: current.config.historian_timeout_ms,
				historianThinkingLevel: current.historianConfig?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: current.config.memory.enabled,
				allowHomeProject: current.config.allow_home_project,
				autoPromote: current.config.memory.auto_promote,
				compactionOff,
				userMemoriesEnabled: userMemoryCollectionEnabled(
					current.config.dreamer,
				),
			};
		},
	});
	info("registered /ctx-session-upgrade");

	registerCtxDreamCommand(pi, {
		db,
		projectDir,
		projectIdentity,
		resolveProject: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				projectDir: current.projectDir,
				projectIdentity: current.projectIdentity,
			};
		},
		dreamerEnabled: bootProjectDeps.dreamerEnabled,
		resolveDreamerEnabled: (ctx) =>
			resolveCurrentProjectDeps(ctx).dreamerEnabled,
		onProjectSeen: (identity) => seenDreamerProjectIdentities.add(identity),
	});
	info("registered /ctx-dream");

	registerCtxEmbedCommand(pi, {
		db,
		projectDir,
		projectIdentity,
		memoryEnabled: bootProjectDeps.config.memory.enabled,
		resolveMemoryEnabled: (ctx) =>
			resolveCurrentProjectDeps(ctx).config.memory.enabled,
		resolveProject: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				projectDir: current.projectDir,
				projectIdentity: current.projectIdentity,
			};
		},
	});
	info("registered /ctx-embed");

	const dreamerConfig = bootProjectDeps.dreamerConfig;
	if (dreamerConfig) {
		registerPiDreamerProject({
			db,
			projectDir,
			projectIdentity,
			config: dreamerConfig,
			embeddingConfig: bootProjectDeps.config.embedding,
			memoryEnabled: bootProjectDeps.config.memory.enabled,
			retinaHandoff: bootProjectDeps.config.smart_notes.retina_handoff,
			language: bootProjectDeps.config.language,
			gitCommitIndexing: bootProjectDeps.config.memory.git_commit_indexing,
			onAdjunctsRefreshNeeded: signalPiSystemPromptRefreshForProject,
		});
		info(`registered dreamer (${summarizeDreamSchedule(dreamerConfig)})`);
	} else {
		info(
			bootProjectDeps.dreamerEnabled
				? "registered dreamer: DISABLED (no dreamer config)"
				: "registered dreamer: DISABLED (dreamer.disable=true or no dreamer config)",
		);
	}

	//
	// `system-prompt-hash.ts`.
	pi.on("before_agent_start", async (event, ctx) => {
		await preloadTokenizer();
		// The extension shows each ANNOUNCEMENT_VERSION once per machine.
		// Pi and OpenCode share the persistence file, so an announcement appears once per machine.
		// Pi and OpenCode share `getMagicContextStorageDir()/last_announced_version` to suppress duplicate announcements.
		//
		// The extension suppresses announcements when the announcement constants are empty.
		// The extension suppresses announcements when Pi or OpenCode has dismissed `ANNOUNCEMENT_VERSION`.
		//
		// markAnnouncementSeen writes storage asynchronously and swallows failures; a failure can cause a duplicate notification at the next interactive Pi startup.
		try {
			if (ctx.hasUI && shouldShowAnnouncement()) {
				// Plain-text URLs avoid OSC 8 compatibility and escape-stripping issues.
				// Plain-text URLs remain visible when the terminal strips raw escapes.
				const featureText = ANNOUNCEMENT_FEATURES.map(
					(line) => `  • ${line}`,
				).join("\n");
				const sections = [
					`✨ Magic Context v${ANNOUNCEMENT_VERSION} — what's new:`,
					"",
					featureText,
				];
				if (ANNOUNCEMENT_FOOTER && ANNOUNCEMENT_FOOTER.trim().length > 0) {
					// The blank line separates the persistent footer from version-specific bullets.
					sections.push("", ANNOUNCEMENT_FOOTER);
				}
				ctx.ui.notify(sections.join("\n"), "info");
				markAnnouncementSeen(ANNOUNCEMENT_VERSION);
			}
		} catch {
			// Announcement-delivery failures do not block agent startup.
		}

		try {
			const effectiveProjectDeps = resolveCurrentProjectDeps(ctx);
			const currentProject = {
				projectDir: effectiveProjectDeps.projectDir,
				projectIdentity: effectiveProjectDeps.projectIdentity,
			};
			const effectiveConfig = effectiveProjectDeps.config;
			seenDreamerProjectIdentities.add(currentProject.projectIdentity);

			// The initial `registerPiDreamerProject` call uses `process.cwd()`, but Pi can switch projects.
			// Pi can switch projects mid-process (`/cd`, multi-root).
			// Without registration, a switched-into project is never dreamed and `/ctx-dream` throws "not registered".
			// `registerPiDreamerProject` is idempotent for the same identity and directory.
			// `registerPiDreamerProject` rebuilds when the directory changes for the same repository identity.
			//
			// A switched-into project may carry its own config, so use `resolveCurrentProjectDeps(ctx)`.
			// A switched-into project may carry its own config, so boot config must not leak into this registration.
			const effectiveDreamerConfig = effectiveProjectDeps.dreamerConfig;
			if (effectiveDreamerConfig) {
				try {
					registerPiDreamerProject({
						db,
						projectDir: currentProject.projectDir,
						projectIdentity: currentProject.projectIdentity,
						config: effectiveDreamerConfig,
						embeddingConfig: effectiveConfig.embedding,
						memoryEnabled: effectiveConfig.memory.enabled,
						retinaHandoff: effectiveConfig.smart_notes.retina_handoff,
						language: effectiveConfig.language,
						gitCommitIndexing: effectiveConfig.memory.git_commit_indexing,
						onAdjunctsRefreshNeeded: signalPiSystemPromptRefreshForProject,
					});
				} catch (err) {
					warn("before_agent_start: registerPiDreamerProject threw:", err);
				}
			} else {
				// An existing registration may use configuration from a different checkout.
				try {
					unregisterPiDreamerProject({
						projectIdentity: currentProject.projectIdentity,
					});
				} catch (err) {
					warn("before_agent_start: unregisterPiDreamerProject threw:", err);
				}
			}
			// `sessionManager.getSessionId()` is available only after Pi creates a session.
			// `before_agent_start` resolves the session ID because it fires once per agent turn.
			const sm = ctx.sessionManager;
			let sessionId: string | undefined;
			if (sm !== undefined) {
				const getId = (sm as { getSessionId?: () => string | undefined })
					.getSessionId;
				if (typeof getId === "function") {
					try {
						const id = getId.call(sm);
						if (typeof id === "string" && id.length > 0) sessionId = id;
					} catch {
					}
				}
			}
			if (sessionId) {
				trackSessionForProject(currentProject.projectIdentity, sessionId);

				// A session switch clears the outgoing session's deferred-refresh and materialization sets to prevent cross-session leakage.
				// The durable pending marker in `session_meta` survives a session switch.
				// The durable marker requires a signal-driven drain; startup rehydration does not rerun on switch-back.
				// A session switch re-signals a durable pending marker so the next eligible materializing pass drains it.
				//
				// The drain re-arms only when `appendCompaction` and `getBranch` are available; otherwise it preserves its signal.
				try {
					const smForDrain = sm as {
						appendCompaction?: unknown;
						getBranch?: unknown;
					};
					const canDrain =
						typeof smForDrain.appendCompaction === "function" &&
						typeof smForDrain.getBranch === "function";
					if (
						!compactionOff &&
						canDrain &&
						getPendingPiCompactionMarkerState(db, sessionId)
					) {
						signalPiDeferredCompactionMarkerDrain(sessionId);
					}
				} catch {
					// A pending-marker read failure must not block agent start.
				}

				// The reminder path targets sessions with legacy pre-v2 compartments only when the historian can run.
				if (
					!compactionOff &&
					ctx.hasUI &&
					effectiveProjectDeps.historianConfig?.model
				) {
					void maybeSendUpgradeReminder(
						{
							client: null,
							db,
							sendIgnoredMessage: async (_client, _sid, text) => {
								ctx.ui.notify(text, "info");
								return "sent";
							},
							getNotificationParams: () => ({}),
							// Pi's `ctx.ui.notify` toast is transient and absent from scrollback.
							// The durable `session_meta` marker must not suppress reminders after one missed toast.
							// The durable `session_meta` marker re-prompts each Pi start until the session upgrades.
							deliveryPersists: false,
						},
						sessionId,
					).catch(() => {
						// Reminder-delivery failures do not block agent startup.
					});
				}
			}

			// The handler resolves `effectiveConfig` from the current checkout after a project switch.
			// A switched-into project may contain `.cortexkit/magic-context.jsonc`.
			// Reusing boot `config` would render the launch project's adjuncts in the new checkout.
			if (effectiveConfig.system_prompt_injection?.enabled === false) {
				return;
			}
			const skipSigs =
				effectiveConfig.system_prompt_injection?.skip_signatures ?? [];
			if (
				skipSigs.some(
					(sig) => sig.length > 0 && event.systemPrompt.includes(sig),
				)
			) {
				return;
			}

			//   - `/ctx-flush`
			// Dreamer publication of `ARCHITECTURE.md` or `STRUCTURE.md` sets the refresh signal.
			// Dreamer user-memory promotion sets the refresh signal.
			// Hash-change detection on the previous turn sets the refresh signal.
			//
			// When the refresh signal is set, the handler reloads disk-backed adjuncts.
			// When the refresh signal is unset, the handler reuses cached values.
			//
			// The handler clears the refresh signal only after `buildMagicContextBlock` and `processSystemPromptForCache` succeed.
			// `buildMagicContextBlock` or `processSystemPromptForCache` failures preserve the signal for retry on the next prompt.
			const isCacheBusting = sessionId
				? hasSystemPromptRefresh(sessionId)
				: true; // first-pass-no-session: act as cache-busting (force fresh read)

			const promptSurfaceModel = (
				ctx as { model?: { provider?: unknown; id?: unknown } }
			).model;
			const promptSurfaceModelKey =
				typeof promptSurfaceModel?.provider === "string" &&
				promptSurfaceModel.provider.length > 0 &&
				typeof promptSurfaceModel.id === "string" &&
				promptSurfaceModel.id.length > 0
					? canonicalPiModelKey(
							promptSurfaceModel.provider,
							promptSurfaceModel.id,
						)
					: undefined;
			const promptSurface = sessionId
				? promptSurfaceGuidanceEpochs.resolve(
						sessionId,
						effectiveConfig.prompt_surface,
						promptSurfaceModelKey,
					)
				: promptSurfaceRuntime.resolveGuidance(
						effectiveConfig.prompt_surface,
						promptSurfaceModelKey,
					);

			const block = buildMagicContextBlock({
				db,
				cwd: currentProject.projectDir,
				sessionId,
				memoryEnabled: effectiveConfig.memory.enabled,
				includeGuidance: true,
				protectedTags: effectiveConfig.protected_tags,
				ctxReduceCallable: !compactionOff,
				dreamerEnabled: effectiveProjectDeps.dreamerEnabled,
				temporalAwarenessEnabled: effectiveConfig.temporal_awareness ?? false,
				cavemanTextCompressionEnabled:
					effectiveConfig.caveman_text_compression?.enabled === true,
				language: effectiveConfig.language,
				promptSurfacePreset: promptSurface.preset,
				primaryGuidanceOverride: promptSurface.primaryOverride,
				// Dreamer promotes recurring observations to stable memories, which render as `<user-profile>`.
				// The handler renders user memories only when `dreamer.user_memories.enabled` is true.
				userMemoriesEnabled: userMemoryCollectionEnabled(
					effectiveConfig.dreamer,
				),
				isCacheBusting,
				existingSystemPrompt: event.systemPrompt,
			});

			// When `sessionId` is present, the handler hashes `composedPrompt` even without `block` so cache tracking freezes the sticky date and detects changes.
			const composedPrompt = composeMagicContextSystemPrompt(
				event.systemPrompt,
				block,
			);

			if (!sessionId) {
				// Without `sessionId`, the handler skips cache processing; a later turn with `sessionId` initializes the hash and sticky date.
				if (block) return { systemPrompt: composedPrompt };
				return;
			}

			const result = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: composedPrompt,
				isCacheBusting,
				promptSurfacePreset: promptSurface.preset,
			});

			if (result.hashChanged) {
				// When `hashChanged`, the handler queues history, system-prompt, and pending-materialization refreshes because this turn may have read stale cached adjuncts.
				// The next `pi.on("context")` rebuilds `<session-history>` and materializes queued operations.
				// The next `before_agent_start` refreshes adjuncts.
				signalPiHistoryRefresh(sessionId);
				signalPiSystemPromptRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
			}

			// The handler clears the refresh signal only when the pass-start `isCacheBusting` was true.
			// The handler uses the pass-start `isCacheBusting` value rather than rereading the refresh set.
			// Using the pass-start `isCacheBusting` value preserves signals raised during the pass, including `result.hashChanged`, for the next prompt.
			if (isCacheBusting) {
				clearSystemPromptRefresh(sessionId);
			}

			return { systemPrompt: result.systemPrompt };
		} catch (error) {
			warn("failed to build magic-context block:", error);
			return;
		}
	});
	info("registered before_agent_start system prompt injector");

	// The `agent_end` handler must not await in-flight historian or Dreamer work.
	// runs.
	//
	// The `agent_end` handler must not await `awaitInFlightHistorians()` because Pi awaits extension handlers before delivering the UI-facing `agent_end` event.
	// `extensions/runner.js` awaits each `agent_end` handler.
	// `agent-session.js` awaits its emit before delivering the UI-facing `agent_end` event.
	// Awaiting an in-flight historian delays TUI completion until the background run finishes.
	// Historian compacts in the background while the main agent continues.
	// Magic-context requires background compaction while the main agent continues.
	//
	// Interactive Pi remains alive between turns, so background historians can continue.
	// The `context` handler prevents duplicate historian runs for a `sessionId`.
	// Historian publication paths register each run in `inFlightHistorian`.
	// `inFlightHistorian` lets 95% waits and `session_shutdown` join active runs.
	//     needed.
	// After an interrupted historian, the next session resumes or uses `historian_failure_count` recovery.
	//
	// `pi --print` exits after `agent_end`, killing any background historian.
	// instead.
	pi.on("agent_end", (event, ctx) => {
		// The `agent_end` handler must return synchronously and must not await background work.
		// `session_shutdown` awaits in-flight historians and dreamers before stdio teardown.
		// Each background run handles its own errors.
		log("agent_end: returning synchronously (background work continues)");

		// The pipeline records a `pending` intent near the threshold, and the `agent_end` handler delivers it through `sendMessage(followUp)` at the turn boundary.
		// `maybeDeliverChannel2Pi` uses CAS to deliver at most once per tail-reset cycle and only when the intent is `pending`.
		//
		// `agent_end` delivers a follow-up only when the final assistant `stopReason` is `"stop"`; error, aborted, and retry events could inject a follow-up mid-retry and consume the cycle.
		try {
			const msgs = (
				event as { messages?: Array<{ role?: string; stopReason?: string }> }
			)?.messages;
			const lastAssistant = Array.isArray(msgs)
				? [...msgs].reverse().find((m) => m?.role === "assistant")
				: undefined;
			if (lastAssistant?.stopReason === "stop") {
				const sessionId = ctx.sessionManager?.getSessionId?.();
				if (sessionId && db && !compactionOff)
					maybeDeliverChannel2Pi(pi, db, sessionId);
			}
		} catch (err) {
			log(`agent_end: channel2 delivery skipped: ${String(err)}`);
		}
	});

	// `tool_execution_start` exposes `event.args` before tool output.
	// `tool_execution_end` is fire-and-forget and can race with the next pipeline pass.
	//
	//
	// Firing note nudges for every `todowrite` is premature because agents use repeated calls to record intermediate progress.
	//
	// `postprocess` prevents subagents from delivering note nudges.
	pi.on("tool_execution_start", async (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (event.toolName === "todowrite") {
				const todoArgs = event.args as
					| { todos?: Array<{ status?: string }> }
					| undefined;
				const toolCallId =
					typeof (event as { toolCallId?: unknown }).toolCallId === "string"
						? (event as { toolCallId: string }).toolCallId
						: undefined;
				const todos = todoArgs?.todos;
				const sessionMeta = Array.isArray(todos)
					? getOrCreateSessionMeta(db, sessionId)
					: null;

				// The capture persists normalized state on every `todowrite` call so the transform-time injection path has a current snapshot.
				capturePiTodowriteArgsIfCompatible({
					db,
					sessionId,
					todos,
					todowriteEnabled,
					todoOverlay,
					persist: Boolean(sessionMeta && !sessionMeta.isSubagent),
					toolCallId,
				});

				if (
					Array.isArray(todos) &&
					todos.length > 0 &&
					todos.every(
						(t) => t.status === "completed" || t.status === "cancelled",
					)
				) {
					if (!compactionOff && sessionMeta && !sessionMeta.isSubagent) {
						onNoteTrigger(db, sessionId, "todos_complete");
					}
				}
			} else if (event.toolName === "ctx_note") {
				clearNoteNudgeTriggerAndCooldown(db, sessionId);
			}
		} catch (err) {
			// The `tool_execution_start` handler ignores failures to avoid interrupting tool execution.
			log(
				`tool_execution_start hook failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			if (!compactionOff && event.toolName === "ctx_reduce") {
				markPiChannel1Reduced(sessionId, db);
			}
		} catch (err) {
			log(
				`tool_execution_end hook failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	// `ctx_reduce` reminders are appended to tool results during the turn.
	// Returning the original content plus a `<system-reminder>` block replaces the recorded result with the appended content.
	pi.on("tool_result", async (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			if (compactionOff) return;
			const block = maybeChannel1ReminderForToolResult({
				db,
				sessionId,
				toolName: event.toolName,
				content: event.content,
			});
			if (db) maybeDeliverChannel2Pi(pi, db, sessionId, "steer");
			if (!block) return;
			return { content: [...event.content, block] };
		} catch (err) {
			log(
				`tool_result hook failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	pi.on("session_before_compact", async (_event, ctx) =>
		handlePiSessionBeforeCompact({ db, compactionOff, ctx }),
	);

	// `opencode.db`.
	//
	// Mutating `event.message` changes the message persisted by `sessionManager.appendMessage`.
	// different harness.
	//
	// Unstripped prefixes appear in assistant responses in Pi's UI.
	pi.on("message_end", async (event, ctx) => {
		try {
			const msg = event.message as unknown;
			if (!compactionOff && msg !== null && typeof msg === "object") {
				stripTagPrefixFromAssistantMessage(
					msg as { role: string; content: unknown },
				);
			}
		} catch (err) {
			warn("message_end: stripTagPrefixFromAssistantMessage threw:", err);
		}

		// The scheduler state lets TTL gating choose execution or deferral on the next transform pass.
		try {
			const sm = ctx.sessionManager as
				| { getSessionId?: () => string | undefined }
				| undefined;
			const sessionId = sm?.getSessionId?.();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			// SAFETY: id and role are re-checked below before use.
			const endedMsg = event.message as unknown as {
				id?: string;
				role?: string;
			};
			if (
				endedMsg?.role === "assistant" &&
				typeof endedMsg.id === "string" &&
				endedMsg.id.length > 0
			) {
				const messageId = endedMsg.id;
				scheduleIncrementalIndex(db, sessionId, messageId, () => {
					const rawMessages = readPiSessionMessages(ctx);
					return (
						rawMessages.find((message) => message.id === messageId) ?? null
					);
				});
			}
			persistPiMessageEndModelMeta({
				db,
				sessionId,
				message: event.message,
				cacheTtlConfig: resolveCurrentProjectDeps(ctx).config.cache_ttl,
			});
			// `session_meta.detected_context_limit` overrides `piContextWindow` after an overflow.
			// `persistPiPressureFromMessageEnd` uses `session_meta.detected_context_limit` for post-overflow pressure.
			const piUsage = ctx.getContextUsage?.();
			const piContextWindow =
				piUsage &&
				typeof piUsage.contextWindow === "number" &&
				piUsage.contextWindow > 0
					? piUsage.contextWindow
					: (ctx.model?.contextWindow ?? 0);
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: event.message,
				piContextWindow,
				piModel: ctx.model,
				piTokens:
					piUsage && typeof piUsage.tokens === "number"
						? piUsage.tokens
						: undefined,
				notifyIssue: async (message) => {
					const uiNotify = (
						ctx as { ui?: { notify?: (message: string) => unknown } }
					).ui?.notify;
					if (typeof uiNotify === "function") {
						void uiNotify.call(ctx.ui, message);
					} else {
						warn(message);
					}
				},
			});

			//
			// `message_end` captures unregistered tools; `tool_execution_start` does not.
			// `tool_execution_start` fires only for tools registered with Pi.
			// A todowrite-shaped tool absent from Pi's registry does not trigger tool_execution_start.
			// Reading the assistant message at message_end also captures unregistered todowrite-shaped tools.
			//   call.
			//
			// `capturePiTodowriteMessageIfCompatible` writes only to the database and does not mutate the message.
			// Subagents skip capture because they do not receive downstream synthetic todowrite injection.
			// gate).
			try {
				const sessionMetaForTodo = getOrCreateSessionMeta(db, sessionId);
				if (!sessionMetaForTodo.isSubagent) {
					capturePiTodowriteMessageIfCompatible({
						db,
						sessionId,
						message: event.message,
						todowriteEnabled,
						todoOverlay,
						persist: true,
					});
				}
			} catch (err) {
				warn("message_end: synthetic todowrite capture failed:", err);
			}
		} catch (err) {
			warn("message_end: persist session_meta usage failed:", err);
		}

		// When `message.errorMessage` matches a known context-overflow pattern, the handler records emergency recovery in `session_meta`.
		// The next transform pass uses the recovery flag in `session_meta` to perform emergency recovery.
		// Emergency recovery invokes the historian immediately and drops all tools.
		// Pressure calculations use `detected_context_limit` when the overflow error reports one.
		//
		// `detectOverflow` recognizes provider-specific context-overflow errors and a generic fallback.
		try {
			if (compactionOff) return;
			const sm = ctx.sessionManager as
				| { getSessionId?: () => string | undefined }
				| undefined;
			const sessionId = sm?.getSessionId?.();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			const msgRaw = event.message as unknown;
			if (!msgRaw || typeof msgRaw !== "object") return;
			const msg = msgRaw as {
				role?: string;
				errorMessage?: string;
				provider?: string;
				model?: string;
			};
			if (msg.role !== "assistant") return;
			if (
				typeof msg.errorMessage !== "string" ||
				msg.errorMessage.length === 0
			) {
				return;
			}
			const detection = detectOverflow(msg.errorMessage);
			if (!detection.isOverflow) return;
			const modelKey =
				typeof msg.provider === "string" &&
				typeof msg.model === "string" &&
				msg.provider.length > 0 &&
				msg.model.length > 0
					? `${msg.provider}/${msg.model}`
					: undefined;
			recordOverflowDetected(
				db,
				sessionId,
				detection.reportedLimit,
				modelKey,
				"provider_overflow",
				detection.reportedLimitProvenance,
			);
			log(
				`[magic-context][${sessionId}] overflow detected: reportedLimit=${
					detection.reportedLimit ?? "?"
				} provenance=${detection.reportedLimitProvenance ?? "?"} pattern=${detection.matchedPattern ?? "?"}`,
			);
		} catch (err) {
			warn("message_end: overflow detection failed:", err);
		}
	});

	// The shutdown handler unregisters the project so `/reload` cannot leave the dreamer timer pointing to the prior extension instance.
	// `/reload` tears down extensions and re-runs the default export.
	//
	// The shutdown handler must not close the SQLite handle because `openDatabase()` caches handles by path.
	// `openDatabase()` stores handles in a process-lifetime Map keyed by path.
	// Closing the handle does not remove its cached Map entry.
	// After reload, `openDatabase()` returns the closed cached handle.
	// Every tool and hook then fails with "database is not open".
	// The database handle remains valid across `/reload` because the host process stays alive.
	pi.on("session_shutdown", async (_event, ctx) => {
		// The shutdown handler waits up to 5 seconds for each historian, recomp, and dreamer drain.
		// Pi awaits agent_end handlers; draining there stalls UI loading on turns that trigger historian.
		// `session_shutdown` also fires for `/reload`.
		//
		// The 5-second cap prevents a hung run from blocking shutdown.
		// In pi --print mode, the process exits after agent_end and before session_shutdown fires.
		const SHUTDOWN_DRAIN_MS = 5_000;
		try {
			await withTimeout(awaitInFlightHistorians(), SHUTDOWN_DRAIN_MS);
		} catch (err) {
			warn("shutdown: historian drain threw:", err);
		}
		try {
			await withTimeout(awaitInFlightRecomps(), SHUTDOWN_DRAIN_MS);
		} catch (err) {
			warn("shutdown: recomp drain threw:", err);
		}
		try {
			await withTimeout(awaitInFlightDreamers(), SHUTDOWN_DRAIN_MS);
		} catch (err) {
			warn("shutdown: dreamer drain threw:", err);
		}
		try {
			for (const identity of seenDreamerProjectIdentities) {
				unregisterPiDreamerProject({ projectIdentity: identity });
			}
		} catch (err) {
			warn("shutdown: unregisterPiDreamerProject threw:", err);
		}
		// Pi resets module state on session swap through _extensionRunner.invalidate.
		// On plain shutdown, per-session maps would retain their last entries.
		// Pi resets module state on /reload.
		// anyway.
		try {
			const sm = (
				ctx as unknown as {
					sessionManager?: { getSessionId?: () => string | undefined };
				}
			).sessionManager;
			const sessionId =
				typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
			if (typeof sessionId === "string" && sessionId.length > 0) {
				clearPiSystemPromptSession(sessionId);
				promptSurfaceGuidanceEpochs.clear(sessionId);
				// Long-lived Pi processes can reinitialize the extension after `session_shutdown`, so the handler clears per-session maps.
				clearContextHandlerSession(sessionId);
			}
		} catch {
			// best-effort cleanup
		}
		// `session_shutdown` with reason `reload` fires before `/reload` re-imports the extension.
		clearPiMagicContextActive();
	});

	pi.on("session_before_switch", (_event, ctx) => {
		try {
			const sm = (
				ctx as unknown as {
					sessionManager?: { getSessionId?: () => string | undefined };
				}
			).sessionManager;
			const outgoingSessionId =
				typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
			if (
				typeof outgoingSessionId === "string" &&
				outgoingSessionId.length > 0
			) {
				// `session_before_switch` clears in-memory per-session maps so they do not retain one entry per session swap.
				// `session_before_switch` must not clear durable state: users can return to the prior session.
				clearPiSystemPromptSession(outgoingSessionId);
				promptSurfaceGuidanceEpochs.clear(outgoingSessionId);
				clearContextHandlerSession(outgoingSessionId);
			}
		} catch {
		}
	});
}

/**
 * `formatExecuteThresholdForLog` formats per-model maps explicitly to avoid `[object Object]%`.
 */
function formatExecuteThresholdForLog(
	value: number | { default: number; [modelKey: string]: number } | undefined,
): string {
	if (value === undefined) return "65%";
	if (typeof value === "number") return `${value}%`;
	const overrides = Object.entries(value)
		.filter(([key]) => key !== "default")
		.map(([key, pct]) => `${key}=${pct}%`);
	const base = `${value.default}%`;
	return overrides.length > 0 ? `${base} (${overrides.join(", ")})` : base;
}
