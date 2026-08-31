import type {
	DreamerConfig,
	EmbeddingConfig,
} from "@magic-context/core/config/schema/magic-context";
import { openOpenCodeDb } from "@magic-context/core/features/magic-context/dreamer/open-opencode-db";
import {
	buildDreamTaskRuntimeConfigs,
	userMemoryCollectionEnabled,
} from "@magic-context/core/features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "@magic-context/core/features/magic-context/dreamer/task-executor";
import type { DreamTaskName } from "@magic-context/core/features/magic-context/dreamer/task-registry";
import {
	type ManualRunResult,
	runManualDream,
} from "@magic-context/core/features/magic-context/dreamer/task-scheduler";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { startDreamScheduleTimer as defaultStartDreamScheduleTimer } from "@magic-context/core/plugin/dream-timer";
import { ensureProjectRegisteredFromPiDirectory } from "../embedding-bootstrap";
import { PiSubagentRunner } from "../subagent-runner";
import { createPiPrimerRawProviderFactory } from "./primer-raw-provider-pi";
import { PiRetrospectiveRawProvider } from "./retrospective-raw-provider-pi";

export interface PiDreamerOptions {
	db: ContextDatabase;
	projectDir: string;
	projectIdentity: string;
	/** `loadPiConfig()` resolves `config` to a runnable `DreamerConfig`. */
	config: DreamerConfig;
	/**
	 * Dreamer uses `embeddingConfig` for memory maintenance and re-embedding.
	 * Dreamer uses deterministic file gates to maintain near-duplicate and stale memories.
	 * Dreamer re-embeds memory content rewritten by `improve`.
	 */
	embeddingConfig: EmbeddingConfig;
	/**
	 * Dreamer needs the configured `memory.enabled` gate.
	 */
	memoryEnabled: boolean;
	retinaHandoff?: boolean;
	language?: string;
	gitCommitIndexing: {
		enabled: boolean;
		since_days: number;
		max_commits: number;
	};
	/**
	 * Dreamer invokes `onAdjunctsRefreshNeeded` after publishing content that may affect `<project-docs>`, `<user-profile>`, or `<key-files>`.
	 * When `onAdjunctsRefreshNeeded` is undefined, no refresh occurs.
	 * Caches remain stale until the next refresh when `onAdjunctsRefreshNeeded` is undefined.
	 * `signalPiSystemPromptRefreshForProject` here.
	 */
	onAdjunctsRefreshNeeded?: (projectIdentity: string) => void;
}

type DreamTimerRegistration = Parameters<
	typeof defaultStartDreamScheduleTimer
>[0];
type DreamTimerClient = DreamTimerRegistration["client"];

interface SessionCreateArgs {
	query?: unknown;
	body?: unknown;
}

interface SessionMessagesArgs {
	path: { id: string };
}

interface SessionPromptArgs extends SessionMessagesArgs {
	body?: unknown;
	signal?: AbortSignal | null;
}

type SessionDeleteArgs = SessionMessagesArgs;

interface ProjectRegistration {
	cleanup: () => void;
	/** `runManual` runs dream tasks for this project immediately.
	 * `task` forces one task ignoring its gate; omitting it runs all enabled tasks.
	 *  registered dreamer timer also runs due tasks on its own schedule. */
	runManual: (task?: DreamTaskName) => Promise<ManualRunResult>;
	/**
	 * `resolveProjectIdentity` returns the same identity for worktrees and clones of one repository.
	 * `projectDir` records the checkout directory so re-registration can detect a switch.
	 * Re-registration rebuilds the timer and client against the new checkout and its configuration.
	 * */
	projectDir: string;
}

type PiSubagentRunnerFactory = () => PiSubagentRunner;

interface PiDreamerSession {
	id: string;
	directory: string;
	title?: string;
	messages: unknown[];
}

const registeredProjects = new Map<string, ProjectRegistration>();
const sessionsById = new Map<string, PiDreamerSession>();
const inFlightDreams = new Set<Promise<unknown>>();
let sessionCounter = 0;
let piSubagentRunnerFactory: PiSubagentRunnerFactory = () =>
	new PiSubagentRunner();
let startDreamScheduleTimerFn: typeof defaultStartDreamScheduleTimer =
	defaultStartDreamScheduleTimer;

/**
 * `registerPiDreamerProject` registers the project with the singleton timer and activates `PiSubagentRunner`. */
export function registerPiDreamerProject(opts: PiDreamerOptions): void {
	if (opts.config.disable === true) {
		return;
	}

	const existing = registeredProjects.get(opts.projectIdentity);
	if (existing) {
		if (existing.projectDir === opts.projectDir) {
			return;
		}
		// A changed `projectDir` for the same `projectIdentity` indicates a worktree or clone switch.
		// The existing timer and client closure remain pinned to the original directory.
		// Re-registration tears down the existing timer and client closure before rebuilding them.
		// Re-registration rebuilds the timer and client for the new directory with freshly resolved configuration.
		// Re-registration uses the new checkout's configuration, including its `dreamer.disable` setting.
		// A disabled re-registration leaves any existing registration unchanged.
		existing.cleanup();
		registeredProjects.delete(opts.projectIdentity);
	}

	// Module-level `inFlightDreams` and `sessionsById` are shared by the timer and `/ctx-dream` path.
	const client = createPiDreamerClient(opts);

	let cleanup: (() => void) | undefined;
	let cancelled = false;
	void startDreamScheduleTimerFn({
		directory: opts.projectDir,
		projectIdentity: opts.projectIdentity,
		client,
		dreamerConfig: opts.config,
		language: opts.language,
		gitCommitIndexing: opts.gitCommitIndexing,
		retinaHandoff: opts.retinaHandoff,
		ensureRegistered: ensureProjectRegisteredFromPiDirectory,
		// SCHEDULED Pi retrospective must read Pi JSONL sessions, not opencode.db.
		// The Pi provider factory ignores `db` because Pi reads JSONL from the current working directory.
		// The scheduled timer uses the manual path's Pi JSONL provider.
		retrospectiveRawProvider: () =>
			new PiRetrospectiveRawProvider({ projectCwd: opts.projectDir }),
		// The scheduled primer requires the Pi JSONL factory to render raw U:/TC: lines.
		// Without `primerRawProviderFactory`, the scheduled task receives no primer context.
		primerRawProviderFactory: createPiPrimerRawProviderFactory(),
	}).then((timerCleanup) => {
		if (cancelled) {
			// Cancellation can stop registration before timer setup completes.
			timerCleanup?.();
			return;
		}
		cleanup = timerCleanup;
	});

	// Manual runs use the per-task scheduler.
	// `DreamTimerClient` implements the executor's required `session` methods, but TypeScript cannot infer that through the wrapper.
	// Manual runs execute only tasks for `opts.projectIdentity`.
	const runManual = async (task?: DreamTaskName): Promise<ManualRunResult> =>
		runManualDream({
			db: opts.db,
			projectIdentity: opts.projectIdentity,
			tasks: buildDreamTaskRuntimeConfigs(opts.config, opts.language),
			executor: createDreamTaskExecutor({
				client: client as never,
				sessionDirectory: opts.projectDir,
				openOpenCodeDb,
				retrospectiveRawProvider: new PiRetrospectiveRawProvider({
					projectCwd: opts.projectDir,
				}),
				primerRawProviderFactory: createPiPrimerRawProviderFactory(),
				userMemoryCollectionEnabled: userMemoryCollectionEnabled(opts.config),
				ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
				language: opts.language,
				retinaHandoff: opts.retinaHandoff,
			}),
			task,
		});

	registeredProjects.set(opts.projectIdentity, {
		cleanup: () => {
			cancelled = true;
			cleanup?.();
		},
		runManual,
		projectDir: opts.projectDir,
	});
}

/**
 * The queue-claim operation returns `null` when the queue is empty or another worker holds the lease.
 *
 */
export async function runPiDreamForProject(
	projectIdentity: string,
	task?: DreamTaskName,
): Promise<ManualRunResult> {
	const registration = registeredProjects.get(projectIdentity);
	if (!registration) {
		throw new Error(
			`Pi dreamer not registered for project ${projectIdentity}; call registerPiDreamerProject() first`,
		);
	}
	return registration.runManual(task);
}

/* */
export function unregisterPiDreamerProject(opts: {
	projectIdentity: string;
}): void {
	const registration = registeredProjects.get(opts.projectIdentity);
	if (!registration) {
		return;
	}

	registration.cleanup();
	registeredProjects.delete(opts.projectIdentity);
}

/**
 * */
export async function awaitInFlightDreamers(): Promise<void> {
	if (inFlightDreams.size === 0) {
		return;
	}

	await Promise.allSettled(Array.from(inFlightDreams));
}

function createPiDreamerClient(opts: PiDreamerOptions): DreamTimerClient {
	const runner = piSubagentRunnerFactory();
	const model = opts.config.model;

	const session = {
		create: async (args: SessionCreateArgs) => {
			const sessionId = `magic-context-pi-dream-${++sessionCounter}`;
			sessionsById.set(sessionId, {
				id: sessionId,
				directory: readDirectory(args) ?? opts.projectDir,
				title: readSessionTitle(args),
				messages: [],
			});
			return { id: sessionId };
		},
		list: async () => ({ data: [] as Array<{ id: string }> }),
		prompt: async (args: SessionPromptArgs) => {
			const sessionId = args.path.id;
			const dreamSession = sessionsById.get(sessionId);
			if (!dreamSession) {
				throw new Error(`Pi dreamer session not found: ${sessionId}`);
			}

			const userMessage = extractUserMessage(args);
			const systemPrompt = extractSystemPrompt(args);
			// `promptSyncWithValidatedOutputRetry` owns fallback iteration.
			// `promptSyncWithValidatedOutputRetry` tries the per-task model and then its fallback chain.
			// Pi's facade uses `body.model` as the current attempt's model.
			// This facade passes `fallbackModels: undefined` to avoid a second fallback iteration.
			// Passing the dreamer-level chain would iterate fallbacks twice and override each task's configured chain.
			const perTaskModel = extractBodyModel(args) ?? model;
			const requestedAgent = extractBodyAgent(args) ?? "magic-context-dreamer";
			const runPromise = runner.run({
				agent: requestedAgent,
				systemPrompt,
				userMessage,
				model: perTaskModel,
				fallbackModels: undefined,
				// The executor's abort signal enforces the per-task timeout.
				// The subprocess timeout exceeds per-task timeouts so the executor's abort signal controls cancellation.
				timeoutMs: 30 * 60 * 1000,
				cwd: dreamSession.directory,
				signal: args.signal ?? undefined,
				thinkingLevel: opts.config.thinking_level,
			});
			inFlightDreams.add(runPromise);
			try {
				const result = await runPromise;
				if (!result.ok) {
					const error = new Error(
						`Pi dreamer subagent failed (${result.reason}): ${result.error}`,
					);
					if (result.transient) {
						(error as Error & { transient?: boolean }).transient = true;
					}
					throw error;
				}
				dreamSession.messages = [
					makeMessage("user", [{ type: "text", text: userMessage }]),
					makeMessage("assistant", [
						// Place synthetic tool parts before final text so `investigationToolCallCount` counts the agent's tool use.
						...syntheticToolParts(result.toolCallCount ?? 0),
						{ type: "text", text: result.assistantText },
					]),
				];
				opts.onAdjunctsRefreshNeeded?.(opts.projectIdentity);
			} finally {
				inFlightDreams.delete(runPromise);
			}
		},
		messages: async (args: SessionMessagesArgs) => {
			const dreamSession = sessionsById.get(args.path.id);
			return { data: dreamSession?.messages ?? [] };
		},
		delete: async (args: SessionDeleteArgs) => {
			sessionsById.delete(args.path.id);
			return {};
		},
	};

	return { session } as unknown as DreamTimerClient;
}

function readDirectory(args: { query?: unknown }): string | undefined {
	const query = args.query;
	if (typeof query !== "object" || query === null) {
		return undefined;
	}

	const directory = (query as { directory?: unknown }).directory;
	return typeof directory === "string" && directory.length > 0
		? directory
		: undefined;
}

function readSessionTitle(args: { body?: unknown }): string | undefined {
	const body = args.body;
	if (typeof body !== "object" || body === null) {
		return undefined;
	}

	const title = (body as { title?: unknown }).title;
	return typeof title === "string" ? title : undefined;
}

function extractUserMessage(args: { body?: unknown }): string {
	const body = args.body;
	if (typeof body !== "object" || body === null) {
		return "";
	}

	const parts = (body as { parts?: unknown }).parts;
	if (!Array.isArray(parts)) {
		return "";
	}

	return parts
		.map((part) => {
			if (typeof part !== "object" || part === null) {
				return "";
			}
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

function extractSystemPrompt(args: { body?: unknown }): string {
	const body = args.body;
	if (typeof body !== "object" || body === null) {
		return "";
	}

	const system = (body as { system?: unknown }).system;
	return typeof system === "string" ? system : "";
}

/**
 * */
function extractBodyModel(args: { body?: unknown }): string | undefined {
	const body = args.body;
	if (typeof body !== "object" || body === null) return undefined;
	const model = (body as { model?: unknown }).model;
	if (typeof model !== "object" || model === null) return undefined;
	const providerID = (model as { providerID?: unknown }).providerID;
	const modelID = (model as { modelID?: unknown }).modelID;
	if (typeof providerID === "string" && typeof modelID === "string") {
		return `${providerID}/${modelID}`;
	}
	return undefined;
}

function extractBodyAgent(args: { body?: unknown }): string | undefined {
	const body = args.body;
	if (typeof body !== "object" || body === null) return undefined;
	const agent = (body as { agent?: unknown }).agent;
	return typeof agent === "string" && agent.length > 0 ? agent : undefined;
}

type SyntheticPart =
	| { type: "text"; text: string }
	| { type: "tool"; tool: string; state: { input: { description: string } } };

/**
 * `investigationToolCallCount` and `extractToolCallSummaries` require `{ type: "tool", tool, state }` parts.
 * Pi's facade carries only final assistant text.
 * Pi's facade omits tool parts, so synthetic parts preserve the evidence required by the grounding gate.
 * Without synthetic tool parts, the refresh-primers grounding gate rejects Pi answers because `investigationToolCallCount` returns 0.
 */
function syntheticToolParts(count: number): SyntheticPart[] {
	const safe = Math.max(0, Math.floor(count));
	return Array.from({ length: safe }, () => ({
		type: "tool" as const,
		tool: "investigation",
		state: { input: { description: "investigation step" } },
	}));
}

function makeMessage(
	role: "user" | "assistant",
	parts: SyntheticPart[],
): unknown {
	return {
		info: {
			role,
			time: { created: Date.now() },
		},
		parts,
	};
}

export const __test = {
	registeredProjectCount: () => registeredProjects.size,
	setPiSubagentRunnerFactory: (factory: PiSubagentRunnerFactory) => {
		piSubagentRunnerFactory = factory;
	},
	setStartDreamScheduleTimerFactory: (
		factory: typeof defaultStartDreamScheduleTimer,
	) => {
		startDreamScheduleTimerFn = factory;
	},
	reset: () => {
		for (const registration of registeredProjects.values()) {
			registration.cleanup();
		}
		registeredProjects.clear();
		sessionsById.clear();
		inFlightDreams.clear();
		sessionCounter = 0;
		piSubagentRunnerFactory = () => new PiSubagentRunner();
		startDreamScheduleTimerFn = defaultStartDreamScheduleTimer;
	},
};
