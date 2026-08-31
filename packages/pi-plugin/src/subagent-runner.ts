import * as childProcess from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	resolve as resolvePath,
} from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { probeChildSpawnFence } from "@magic-context/core/features/magic-context/schema-fence-probe";
import { openDatabase } from "@magic-context/core/features/magic-context/storage";
import type { SubagentKind } from "@magic-context/core/features/magic-context/storage-subagent-invocations";
import { recordChildInvocation } from "@magic-context/core/features/magic-context/subagent-token-capture";
import {
	ompModelRefToCanonical,
	piModelRefToCanonical,
	resolveModelRefForOmp,
	resolveModelRefForPi,
} from "@magic-context/core/shared/harness-provider-map";
import { sessionLog } from "@magic-context/core/shared/logger";
import type {
	SubagentProgressEvent,
	SubagentRunner,
	SubagentRunOptions,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";

/**
 * sidekick subagents.
 *
 * `pi` may be unavailable on PATH outside interactive Pi sessions.
 * Interactive Pi sessions expose `pi` on PATH.
 *
 * The resolved CLI path bypasses PATH lookup.
 *
 */
function resolveBundledPiCli(): string | null {
	try {
		const require_ = createRequire(import.meta.url);
		const pkgJson = require_.resolve(
			"@earendil-works/pi-coding-agent/package.json",
		);
		const cliPath = join(dirname(pkgJson), "dist/cli.js");
		if (existsSync(cliPath)) return cliPath;
		return null;
	} catch {
		return null;
	}
}

/**
 * */
interface PiInvocation {
	command: string;
	prefixArgs: string[];
}

/**
 *
 * The resolver invokes the host runtime with `cli.js` before falling back to `pi` on PATH.
 * Global npm installs expose `pi.cmd`, not literal `pi`, on Windows.
 * Windows cannot execute `dist/cli.js` directly because it ignores its Node shebang.
 * The resolver re-invokes the host CLI to avoid Windows shim and shebang handling.
 * The host invocation avoids shim resolution and uses the host Pi version and runtime.
 *
 * Extensions load in the host Pi process, so `argv[1]` names the host `cli.js`.
 *
 * Resolution order:
 * The resolver excludes Bun's `/$bunfs/root/` virtual paths because they cannot be passed as CLI script paths.
 * A packaged single-file Pi binary requires no script argument.
 *
 * The runner spawns Pi without a shell to avoid `cmd.exe` argument escaping on Windows.
 */
function resolvePiInvocation(): PiInvocation {
	const execPath = process.execPath;
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		currentScript?.startsWith("/$bunfs/root/") ?? false;

	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: execPath, prefixArgs: [currentScript] };
	}

	const execName = basename(execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: execPath, prefixArgs: [] };
	}

	const bundled = resolveBundledPiCli();
	if (bundled) {
		return { command: execPath, prefixArgs: [bundled] };
	}

	return { command: "pi", prefixArgs: [] };
}

/**
 * The resolver resolves `subagent-entry.js` relative to this module so spawned Pi processes load the bundled extension.
 * The resolver uses `import.meta.url` so the extension path is independent of the package installation location.
 *
 * Callers must omit `-x` when this returns `undefined`.
 * Subagents without the extension run without Magic Context tools.
 */
function resolveSubagentEntryPath(): string | undefined {
	try {
		// `dirname(fileURLToPath(import.meta.url))` is the runner's directory in Bun source and dist builds.
		const here = dirname(fileURLToPath(import.meta.url));
		const candidate = resolvePath(here, "subagent-entry.js");
		if (existsSync(candidate)) return candidate;

		return undefined;
	} catch {
		return undefined;
	}
}

const SUBAGENT_ENTRY_PATH = resolveSubagentEntryPath();

/**
 * The grace period starts after terminal assistant `message_end`.
 * Pi's print mode can emit `agent_end` or a clean `stopReason` without exiting.
 * Without `TERMINAL_DRAIN_GRACE_MS`, successful runs wait the full configured `timeoutMs`.
 *
 * The 2-second grace period lets remaining stdout and stdio writers flush before SIGTERM.
 * If Pi does not exit, the runner SIGTERMs Pi and returns the assembled result.
 */
const TERMINAL_DRAIN_GRACE_MS = 2_000;

export const MAGIC_CONTEXT_PI_SUBAGENT_ENV = "MAGIC_CONTEXT_PI_SUBAGENT";

function packageRootIsOmp(packageRoot: string): boolean {
	try {
		const manifest = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf-8"),
		) as { name?: unknown };
		return manifest.name === "@oh-my-pi/pi-coding-agent";
	} catch {
		return false;
	}
}

function expandHomePath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return resolvePath(homedir(), value.slice(2));
	}
	return resolvePath(value);
}

/**
 * `isOmpHostProcess` requires evidence beyond `PI_CODING_AGENT_DIR`.
 * `PI_CODING_AGENT_DIR` cannot identify OMP because upstream Pi also supports it.
 */
function isOmpHostProcess(): boolean {
	const execName = basename(process.execPath).toLowerCase();
	if (/^omp(?:\.exe)?$/.test(execName)) return true;

	const packageOverride = process.env.PI_PACKAGE_DIR?.trim();
	if (packageOverride && packageRootIsOmp(expandHomePath(packageOverride))) {
		return true;
	}

	let current = process.argv[1] ? dirname(resolvePath(process.argv[1])) : "";
	while (current) {
		if (packageRootIsOmp(current)) return true;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
}

function normalizedOmpProfile(): string | undefined {
	const raw = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim();
	return raw && raw !== "default" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw)
		? raw
		: undefined;
}

// OMP uses `PI_CODING_AGENT_DIR` as the custom agent-directory override.
// A named profile ignores PI_CODING_AGENT_DIR.
function getHostAgentSettingsDir(): string {
	if (!isOmpHostProcess()) return join(homedir(), ".pi", "agent");
	const configRoot = join(
		homedir(),
		process.env.PI_CONFIG_DIR?.trim() || ".omp",
	);
	const profile = normalizedOmpProfile();
	if (profile) return join(configRoot, "profiles", profile, "agent");
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return configured ? resolvePath(configured) : join(configRoot, "agent");
}

function modelRefToCanonicalForHost(ref: string): string {
	return isOmpHostProcess()
		? ompModelRefToCanonical(ref)
		: piModelRefToCanonical(ref);
}

function resolveModelRefForHost(ref: string): string {
	return isOmpHostProcess()
		? resolveModelRefForOmp(ref)
		: resolveModelRefForPi(ref);
}
let configuredSubagentExtensions: readonly string[] | undefined;

/* */
export function configurePiSubagentExtensions(
	extensions: readonly string[] | undefined,
): void {
	configuredSubagentExtensions = extensions?.slice();
}

function resolveSubagentExtensionEntry(entry: string): string {
	const trimmed = entry.trim();
	const isNpmSource = trimmed.startsWith("npm:");
	return !isNpmSource && !isAbsolute(trimmed)
		? resolvePath(getHostAgentSettingsDir(), trimmed)
		: trimmed;
}

const PI_READ_ONLY_BUILTINS = ["read", "grep", "find", "ls"] as const;
const PI_AFT_READ_TOOLS = ["aft_outline", "aft_zoom", "aft_search"] as const;
const PI_HISTORIAN_TOOLS = [...PI_READ_ONLY_BUILTINS, "aft_search"] as const;

/**
 * `DREAMER_ACTION_AGENTS` grants `ctx_memory` in the lean child extension.
 * Sidekick is retrieval-only and uses `ctx_search`.
 * Dreamer-equivalent agents need memory mutation and listing capabilities.
 *
 * DREAMER_ACTION_AGENTS must contain the exact agent IDs passed by Pi callers; mismatches disable elevated tools.
 * action surface.
 */
const DREAMER_ACTION_AGENTS: ReadonlySet<string> = new Set([
	"dreamer",
	"magic-context-dreamer",
]);
const SEARCH_ONLY_SUBAGENT_TOOL_AGENTS: ReadonlySet<string> = new Set([
	"sidekick",
	"dreamer-retrospective",
	// The strict allow-list can gate `ctx_search` only after the lean extension registers it.
	// The strict allow-list only gates tools that Pi has registered.
	// contract.
	"dreamer-primer-investigator",
]);

/**
 * Agents in `STRICT_TOOL_ALLOWLIST_ENTRIES` must run under Pi's hard `--tools` allow-list, not merely a narrowed extension.
 * When AFT is absent, optional AFT tool names are absent; when a provider registers them, filtering allows them.
 *
 * Pi enforces this capability boundary; OMP appends discovered extension tools after applying `--tools` to built-ins.
 * extension-tool sandbox.
 */
const STRICT_TOOL_ALLOWLIST_ENTRIES: readonly (readonly [
	string,
	readonly string[],
])[] = [
	["dreamer-retrospective", ["ctx_search"]],
	["smart-note-compiler", []],
	// The historian runner must not mutate source files or memory.
	// The historian runner permits only read-only Pi built-ins and `aft_search`; it excludes `aft_outline`, `aft_zoom`, and `ctx_*` tools.
	["magic-context-historian", PI_HISTORIAN_TOOLS],
	["historian", PI_HISTORIAN_TOOLS],
	["historian-recomp", PI_HISTORIAN_TOOLS],
	["historian-editor", PI_HISTORIAN_TOOLS],
	// Sidekick excludes `write`, `bash`, and `ctx_memory`.
	["sidekick", [...PI_READ_ONLY_BUILTINS, "ctx_search"]],
	["dreamer-classifier", []],
	["dreamer-reviewer", []],
	[
		"dreamer-primer-investigator",
		[...PI_READ_ONLY_BUILTINS, ...PI_AFT_READ_TOOLS, "ctx_search"],
	],
	["dreamer-memory-mapper", [...PI_READ_ONLY_BUILTINS, ...PI_AFT_READ_TOOLS]],
	// AFT read navigation is optional; ctx_memory and ctx_search are unavailable.
	// `dreamer-docs` is outside every `*_SUBAGENT_TOOL_AGENTS` set, so the lean extension cannot register `ctx_memory`.
	[
		"dreamer-docs",
		[...PI_READ_ONLY_BUILTINS, "bash", "write", "edit", ...PI_AFT_READ_TOOLS],
	],
	// `dreamer` belongs to `DREAMER_ACTION_AGENTS`, so the lean extension registers `ctx_memory`.
	// `dreamer`'s allow-list removes all seven built-ins, leaving only extension-provided `ctx_memory`.
	// `dreamer` has no code-reading tools.
	["dreamer", ["ctx_memory"]],
	// `magic-context-dreamer` is the Pi facade default when `body.agent` is absent.
	// `magic-context-dreamer` must retain the same `ctx_memory`-only allowlist as `dreamer`.
	// Each DREAMER_ACTION_AGENTS member requires a strict allowlist entry.
	["magic-context-dreamer", ["ctx_memory"]],
];

const STRICT_TOOL_ALLOWLIST: ReadonlyMap<string, readonly string[]> = new Map(
	STRICT_TOOL_ALLOWLIST_ENTRIES,
);

const ZERO_TOOL_PROMPT_REQUIRED_AGENTS: ReadonlySet<string> = new Set(
	STRICT_TOOL_ALLOWLIST_ENTRIES.filter(([, tools]) => tools.length === 0).map(
		([agent]) => agent,
	),
);

/**
 * OMP validates `--tools` against built-in names before extensions register.
 * Extension tools cannot be passed to OMP's --tools flag.
 *
 * resolveHostToolAllowlist narrows only OMP's built-in surface.
 * It does not call `restrictToolNames`, so discovered AFT, MCP, and ctx tools remain available.
 */
const OMP_TOOL_ALIASES: Readonly<Record<string, string>> = {
	find: "glob",
	ls: "glob",
};

const OMP_ALLOWLISTABLE_TOOLS: Readonly<Record<string, true>> = {
	read: true,
	grep: true,
	glob: true,
	bash: true,
	edit: true,
	write: true,
};

function resolveHostToolAllowlist(
	tools: readonly string[],
	ompHost: boolean = isOmpHostProcess(),
): readonly string[] {
	if (!ompHost) return tools;
	const resolved: string[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		const mapped = OMP_TOOL_ALIASES[tool] ?? tool;
		if (OMP_ALLOWLISTABLE_TOOLS[mapped] !== true || seen.has(mapped)) continue;
		seen.add(mapped);
		resolved.push(mapped);
	}
	return resolved;
}

const KNOWN_PI_SUBAGENT_AGENTS = [
	"magic-context-historian",
	"historian",
	"historian-recomp",
	"historian-editor",
	"sidekick",
	"dreamer-retrospective",
	"smart-note-compiler",
	"dreamer-classifier",
	"dreamer-reviewer",
	"dreamer-primer-investigator",
	"dreamer-memory-mapper",
	"dreamer-docs",
	"dreamer",
	"magic-context-dreamer",
] as const;

function inferAccountingSubagent(agent: string): SubagentKind {
	if (agent.includes("sidekick")) return "sidekick";
	if (agent.includes("retrospective")) return "dreamer";
	if (agent.includes("dreamer")) return "dreamer";
	if (agent.includes("compressor")) return "compressor";
	if (agent.includes("recomp")) return "recomp";
	return "historian";
}

type FailedRunResult = Extract<SubagentRunResult, { ok: false }>;

type PiRunMode = {
	disableDiscoveredExtensions: boolean;
};

const ALREADY_PROCESSING_PREFIX = "Agent is already processing";
// A loaded extension starting its own agent turn triggers the isolated retry.
// Subagent-runner tests require ALREADY_PROCESSING_PREFIX verbatim.
const ISOLATED_RETRY_COLLISION_LOG_MESSAGE =
	"pi subagent: a loaded Pi extension started an agent turn before the child's prompt could run; retrying with an isolated extension set (user extensions disabled for this run)";
// The isolated retry fires when a child exits 0 without protocol output.
const ISOLATED_RETRY_SILENT_LOG_MESSAGE =
	"pi subagent: child exited successfully but emitted no protocol output (no agent_end, zero stdout); a loaded Pi extension likely broke print mode; retrying with an isolated extension set (user extensions disabled for this run)";
const ISOLATED_RETRY_MODEL_UNAVAILABLE_MESSAGE =
	"model unavailable in isolated retry: it is provided by a disabled extension; configure it through models.json or add a built-in/provider-configured fallback";
const MODEL_RESOLUTION_ERROR_PATTERNS = [
	/unknown model/i,
	/unknown provider/i,
	/model.+not found/i,
	/provider.+not found/i,
	/could not resolve model/i,
	/no models? (matched|available|configured)/i,
	/model.+not configured/i,
] as const;

/** Each canonical provider prefix maps to the Pi provider form that last succeeded. */
const PI_PROVIDER_FORM_CACHE = new Map<string, string>();

type ProviderModelAttempt = {
	canonicalRef: string;
	canonicalProvider: string;
	modelRef: string;
	attemptedProvider: string;
	translated: boolean;
};

type ExtensionRetryResult = {
	result: SubagentRunResult;
	extensionRetryUsed: boolean;
};

/**
 *
 *
 * A subprocess isolates Pi's session manager from the host process.
 * Pi exposes no in-process child-session API equivalent to OpenCode's `client.session.create() / .prompt()`.
 *   Sessions are tied to a SessionManager that runs the interactive UI
 * Pi's agent loop requires exclusive ownership of stdout and stderr.
 * Pi supports single-shot invocation only through its print-mode subprocess.
 * `pi --print --mode json` emits typed NDJSON for every provider and model.
 *
 * Pi emits one JSON object per stdout line.
 *
 * Pi emits session records as `{ type: "session", id, version, timestamp, cwd }`.
 * Pi emits `{ type: "agent_start" }` when an agent starts.
 * Pi emits `{ type: "turn_start" }` when a turn starts.
 * `message_start` contains a `message` object with `role`, `content`, and other fields.
 * `message_end` contains a `message` object with `role`, `content`, and other fields.
 * Tool calls can add `turn_start`, `message_start`, `message_end`, and `turn_end` events.
 * `agent_end` contains the full final message array in `messages`.
 *
 * The `agent_end` event is the authoritative final state.
 * The runner extracts text only from the last assistant message in `agent_end`.
 *
 * If the last assistant message in `agent_end` has `stopReason` `error` or `aborted`, return `model_failed` with its `errorMessage`.
 * - Process exits non-zero before `agent_end` is observed → `non_zero_exit`.
 * - Process exits zero with no assistant result → `no_assistant`.
 * - Malformed JSON output before completion → `parse_failed`.
 * - Spawn itself fails (binary missing, permission denied) → `spawn_failed`.
 * - Caller's AbortSignal fires → kill the child + return `abort`.
 * - `timeoutMs` elapses before `agent_end` → kill + return `timeout`.
 *
 * `PiSubagentRunner` does not expose tool-call events; Pi executes tool calls in its child process.
 * `PiSubagentRunner` does not expose intermediate tool-call state to callers.
 * `PiSubagentRunner` returns only final assistant text, so callers cannot obtain the per-turn token usage reported in each `message_end`.
 */
export class PiSubagentRunner implements SubagentRunner {
	readonly harness = "pi";

	/**
	 * `PiSubagentRunner` resolves the invocation in the host process at construction so `process.argv[1]` identifies the host `cli.js`.
	 */
	private readonly invocation: PiInvocation;
	private readonly spawnImpl: typeof childProcess.spawn;
	private readonly platform: NodeJS.Platform;
	private readonly extraArgs: readonly string[];
	/** `undefined` means preserve Pi's normal extension discovery behavior. */
	private readonly subagentExtensions: readonly string[] | undefined;

	constructor(
		options: {
			piBinary?: string;
			platform?: NodeJS.Platform;
			extraArgs?: readonly string[];
			/** User-tier explicit extension allowlist; an empty list disables all discovered extensions. */
			subagentExtensions?: readonly string[];
			/** Test seam for subprocess lifecycle tests. Production uses child_process.spawn. */
			spawnImpl?: typeof childProcess.spawn;
		} = {},
	) {
		this.invocation = options.piBinary
			? { command: options.piBinary, prefixArgs: [] }
			: resolvePiInvocation();
		this.spawnImpl = options.spawnImpl ?? childProcess.spawn;
		this.platform = options.platform ?? process.platform;
		this.extraArgs = options.extraArgs ?? [];
		this.subagentExtensions =
			options.subagentExtensions ?? configuredSubagentExtensions;
	}

	async run(options: SubagentRunOptions): Promise<SubagentRunResult> {
		const providerAttempt = resolveProviderModelAttempt(options.model);
		const firstOptions = providerAttempt
			? { ...options, model: providerAttempt.canonicalRef }
			: options;
		const firstRun = await this.runWithExtensionRetry(
			firstOptions,
			providerAttempt?.modelRef,
		);
		if (!providerAttempt) return firstRun.result;
		if (firstRun.result.ok) {
			PI_PROVIDER_FORM_CACHE.set(
				providerAttempt.canonicalProvider,
				providerAttempt.attemptedProvider,
			);
			return firstRun.result;
		}
		if (!isProviderCredentialFailure(firstRun.result, providerAttempt)) {
			return firstRun.result;
		}

		// If an extension retry already ran, the provider retry retains isolated mode.
		const fallbackOptions = {
			...options,
			model: providerAttempt.canonicalRef,
		};
		const fallbackRun: ExtensionRetryResult = firstRun.extensionRetryUsed
			? {
					result: await this.runModelChain(
						fallbackOptions,
						{ disableDiscoveredExtensions: true },
						providerAttempt.canonicalRef,
					),
					extensionRetryUsed: true,
				}
			: await this.runWithExtensionRetry(
					fallbackOptions,
					providerAttempt.canonicalRef,
				);
		if (fallbackRun.result.ok) {
			PI_PROVIDER_FORM_CACHE.set(
				providerAttempt.canonicalProvider,
				providerAttempt.canonicalProvider,
			);
		}
		return fallbackRun.result;
	}

	private async runWithExtensionRetry(
		options: SubagentRunOptions,
		modelRefOverride?: string,
	): Promise<ExtensionRetryResult> {
		const primaryRunMode: PiRunMode = { disableDiscoveredExtensions: false };
		const primaryResult = await this.runModelChain(
			options,
			primaryRunMode,
			modelRefOverride,
		);
		if (
			this.spawnUsesNoExtensions(primaryRunMode) ||
			!isIsolatedRetryTrigger(primaryResult)
		) {
			return { result: primaryResult, extensionRetryUsed: false };
		}

		const sessionId = options.accountingSessionId ?? "pi-subagent";
		sessionLog(sessionId, isolatedRetryLogMessage(primaryResult));
		const isolatedResult = await this.runModelChain(
			options,
			{ disableDiscoveredExtensions: true },
			modelRefOverride,
		);
		if (!isolatedResult.ok && isIsolatedRetryModelUnavailable(isolatedResult)) {
			sessionLog(sessionId, ISOLATED_RETRY_MODEL_UNAVAILABLE_MESSAGE);
			return {
				result: annotateIsolatedRetryModelUnavailable(isolatedResult),
				extensionRetryUsed: true,
			};
		}
		return { result: isolatedResult, extensionRetryUsed: true };
	}

	private async runModelChain(
		options: SubagentRunOptions,
		runMode: PiRunMode,
		primaryModelRef?: string,
	): Promise<SubagentRunResult> {
		const models = [options.model, ...(options.fallbackModels ?? [])].filter(
			(model): model is string => typeof model === "string" && model.length > 0,
		);
		const attempts = models.length > 0 ? models : [undefined];
		let lastResult: SubagentRunResult | null = null;
		for (let index = 0; index < attempts.length; index += 1) {
			const model = attempts[index];
			const attemptOptions = {
				...options,
				model,
				fallbackModels: undefined,
			};
			const result = await this.runOnce(
				attemptOptions,
				runMode,
				index === 0 ? primaryModelRef : undefined,
			);
			if (result.ok) return result;
			lastResult = result;
			// Pi print mode discovers extensions before reading stdin.
			// A user extension can start an agent turn during startup, causing a prompt conflict before the child accepts Magic Context input.
			// A user extension can make Pi `--print` exit 0 without protocol output.
			// An extension-caused first-model failure triggers one retry with discovered extensions disabled.
			// The retry prevents fallback models from repeating an extension-caused failure.
			// Isolation applies only to the current attempt; later runs re-enable extensions so extension-provided models remain available.
			// working normally.
			if (
				!this.spawnUsesNoExtensions(runMode) &&
				isIsolatedRetryTrigger(result)
			) {
				return result;
			}
			if (index >= attempts.length - 1 || !isFallbackEligible(result.reason)) {
				return result;
			}
		}
		return (
			lastResult ??
			this.runOnce(
				{ ...options, fallbackModels: undefined },
				runMode,
				primaryModelRef,
			)
		);
	}

	private spawnUsesNoExtensions(runMode: PiRunMode): boolean {
		return (
			runMode.disableDiscoveredExtensions ||
			this.subagentExtensions !== undefined ||
			hasNoExtensionsArg([...this.invocation.prefixArgs, ...this.extraArgs])
		);
	}

	private async runOnce(
		options: SubagentRunOptions,
		runMode: PiRunMode,
		modelRefOverride?: string,
	): Promise<SubagentRunResult> {
		const startTime = Date.now();
		let recordedAccounting = false;
		const recordAccounting = (
			result: SubagentRunResult,
			messages: unknown[] = [],
		) => {
			if (!options.accountingSessionId || recordedAccounting) return;
			recordedAccounting = true;
			recordChildInvocation({
				db: openDatabase(),
				parentSessionId: options.accountingSessionId,
				harness: "pi",
				subagent:
					options.accountingSubagent ?? inferAccountingSubagent(options.agent),
				task: options.accountingTask ?? null,
				startedAt: startTime,
				status: result.ok
					? "completed"
					: result.reason === "abort"
						? "aborted"
						: "failed",
				messages,
				providerId:
					typeof options.model === "string"
						? options.model.split("/")[0]
						: null,
				modelId:
					typeof options.model === "string"
						? options.model.split("/").slice(1).join("/")
						: null,
				error: result.ok ? null : result.error,
				parentInvocationId: options.accountingParentInvocationId ?? null,
			});
		};
		if (options.signal?.aborted) {
			const result: SubagentRunResult = {
				ok: false,
				reason: "abort",
				error: "pi subagent aborted by caller",
				durationMs: Date.now() - startTime,
			};
			// The runner ignores accounting write failures so `run` still returns its `SubagentRunResult`.
			try {
				recordAccounting(result);
			} catch (err) {
				sessionLog(
					options.accountingSessionId ?? "subagent",
					`subagent accounting failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return result;
		}

		const failBeforeSpawn = (
			reason: Extract<SubagentRunResult, { ok: false }>["reason"],
			error: string,
			transient = false,
		): SubagentRunResult => {
			const result: SubagentRunResult = {
				ok: false,
				reason,
				error,
				durationMs: Date.now() - startTime,
				...(transient ? { transient: true } : {}),
			};
			try {
				recordAccounting(result);
			} catch (err) {
				sessionLog(
					options.accountingSessionId ?? "subagent",
					`subagent accounting failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return result;
		};

		// A zero-tool child needs a system prompt to receive its task instructions.
		// Otherwise, Pi can substitute a persisted user-mode prompt.
		if (
			ZERO_TOOL_PROMPT_REQUIRED_AGENTS.has(options.agent) &&
			options.systemPrompt.trim().length === 0
		) {
			return failBeforeSpawn(
				"invalid_prompt",
				`zero-tool Pi subagent "${options.agent}" requires a non-empty system prompt`,
				true,
			);
		}

		const fence = probeChildSpawnFence(openDatabase());
		if (!fence.allowSpawn) {
			return failBeforeSpawn(
				"spawn_failed",
				`Magic Context: plugin build is older than its database (database=v${fence.failure.persistedVersion}, supported_fence=v${fence.failure.supportedVersion}) — restart Pi.`,
			);
		}

		// On Linux, the runner pipes prompts larger than 128 KiB because `MAX_ARG_STRLEN` limits each argv entry.
		// Windows `CreateProcess` caps the entire command line at 32,767 characters.
		// On Windows, the runner pipes prompts instead of placing them in argv to reserve command-line space for flags and the generated-file system prompt.
		// Pi print mode appends stdin to its initial message; the runner omits the positional argv prompt when piping stdin to prevent duplication.
		const promptBytes = Buffer.byteLength(options.userMessage, "utf8");
		const deliverViaStdin =
			promptBytes > PROMPT_ARGV_MAX_BYTES || this.platform === "win32";
		let systemPromptTempDir: string | undefined;
		let systemPromptPath: string | undefined;
		const cleanupSystemPromptFile = () => {
			if (!systemPromptTempDir) return;
			const tempDir = systemPromptTempDir;
			systemPromptTempDir = undefined;
			systemPromptPath = undefined;
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Temp-file cleanup is best-effort and must never mask the run result.
			}
		};
		if (options.systemPrompt.length > 0) {
			try {
				systemPromptTempDir = mkdtempSync(join(tmpdir(), "mc-pi-prompt-"));
				systemPromptPath = join(systemPromptTempDir, "system-prompt.txt");
				writeFileSync(systemPromptPath, options.systemPrompt, "utf8");
			} catch (error) {
				cleanupSystemPromptFile();
				return failBeforeSpawn(
					"spawn_failed",
					`failed to prepare pi system prompt file: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const args = buildArgs(options, {
			disableDiscoveredExtensions: runMode.disableDiscoveredExtensions,
			subagentExtensions: this.subagentExtensions,
			omitPositionalMessage: deliverViaStdin,
			systemPromptPath,
			modelRef: modelRefOverride,
		});

		// Pi accepts `provider/model` through `--model`; no separate `--provider` flag is needed.

		return new Promise<SubagentRunResult>((resolve) => {
			let accountingMessages: unknown[] = [];
			// The `settled` guard lets timeout, abort, and exit handlers determine whether a timeout won a completion race.
			// the outcome."
			let settled = false;
			const settle = (result: SubagentRunResult) => {
				if (settled) return;
				settled = true;
				cleanupSystemPromptFile();
				// `recordAccounting` failures must not prevent `settle` from resolving.
				try {
					recordAccounting(result, accountingMessages);
				} catch (err) {
					sessionLog(
						options.accountingSessionId ?? "subagent",
						`subagent accounting failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				resolve(result);
			};

			// `emitProgress` isolates progress callback failures from the runner.
			const emitProgress = (event: SubagentProgressEvent) => {
				if (!options.onProgress) return;
				try {
					options.onProgress(event);
				} catch {
				}
			};

			let child: ReturnType<typeof childProcess.spawn>;
			try {
				child = this.spawnImpl(
					this.invocation.command,
					[...this.invocation.prefixArgs, ...this.extraArgs, ...args],
					{
						cwd: options.cwd,
						// The merged environment preserves `PATH`, `HOME`, and authentication variables for provider extensions.
						// `MAGIC_CONTEXT_PI_SUBAGENT_ENV` must not replace `process.env`.
						env: {
							...process.env,
							[MAGIC_CONTEXT_PI_SUBAGENT_ENV]: "1",
						},
						// Pi writes JSON events to stdout and diagnostics to stderr; `deliverViaStdin` controls whether stdin is piped.
						// When the message rides in argv, stdin stays closed because Pi print-mode blocks on open idle stdin.
						stdio: [deliverViaStdin ? "pipe" : "ignore", "pipe", "pipe"],
					},
				);
			} catch (error) {
				cleanupSystemPromptFile();
				settle({
					ok: false,
					reason: "spawn_failed",
					error: error instanceof Error ? error.message : String(error),
					durationMs: Date.now() - startTime,
				});
				return;
			}

			if (options.signal?.aborted) {
				terminateChild(child);
				settle({
					ok: false,
					reason: "abort",
					error: "pi subagent aborted by caller",
					durationMs: Date.now() - startTime,
				});
				return;
			}

			emitProgress({ type: "spawned", argv: args, pid: child.pid });

			// The runner closes stdin after writing so Pi's print-mode read receives EOF.
			if (deliverViaStdin && child.stdin) {
				// Stream write failures emit asynchronous `error` events rather than throwing from `.end()`.
				// An `error` listener prevents EPIPE from becoming an unhandled stream error.
				// The runner attaches the `error` listener before `.end()` because write failures are asynchronous.
				child.stdin.on("error", () => {
				});
				try {
					child.stdin.end(options.userMessage, "utf8");
				} catch {
					// The `catch` ignores synchronous `.end()` failures.
				}
			}

			// `emitProgress` forwards stderr before child exit, including while child exit is delayed.
			// otherwise).
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				stderr += text;
				// `stderr` is capped at 16,000 characters to bound memory on chatty failures.
				if (stderr.length > 16_000) {
					stderr = `${stderr.slice(0, 16_000)}…[truncated]`;
				}
				emitProgress({ type: "stderr", chunk: text });
			});
			// Child stderr pipe failures emit `error` events on the stream.
			// Unhandled stream `error` events can crash the host process.
			child.stderr?.on("error", () => {});

			// The runner waits for child exit after `agent_end` so the OS reaps the process before resolution.
			let finalAssistantText: string | null = null;
			let finalErrorMessage: string | null = null;
			let finalStopReason: string | null = null;
			let sawAgentEnd = false;
			let parseError: string | null = null;
			// `agent_end` provides the authoritative full message array; otherwise use accumulated `message_end` messages because stdout has no reliable tool-completion event.
			let agentEndMessages: unknown[] | null = null;

			// Detecting the final assistant turn bypasses the full-timeout wait.
			// Pi print mode can remain running after the final assistant turn.
			let drainTimerStarted = false;
			let drainTimerHandle: ReturnType<typeof setTimeout> | undefined;

			// `child.stdout` and `child.stderr` can be null when their stdio slots are not pipes; this runner passes `"pipe"` for both.
			// A missing stream settles as `parse_failed` instead of passing `null` to `createInterface`.
			if (!child.stdout) {
				settle({
					ok: false,
					reason: "parse_failed",
					error: "pi child process did not expose stdout (stdio misconfigured)",
					durationMs: Date.now() - startTime,
				});
				return;
			}
			// An `error` listener prevents an stdout pipe error from becoming an unhandled exception.
			child.stdout.on("error", () => {});
			const rl = createInterface({
				input: child.stdout,
				crlfDelay: Number.POSITIVE_INFINITY,
			});

			// Event progress lets timeout reports distinguish active output from silent failures.
			let eventCount = 0;
			let lastEventType: string | null = null;
			let lastEventTimestamp = 0;

			// The runner accumulates `message_end` messages because Pi emits intermediate and terminal turns.
			// Pi emits `message_end` for intermediate tool-call and terminal turns.
			// A successful final assistant turn has `stopReason="stop"` and no `toolCall` content.
			//
			// Pi's print mode does NOT emit an `agent_end` event on stdout.
			// `agent_end` is available only through Pi's internal extension event channel.
			// `session.subscribe` produces the stdout JSON stream without emitting `agent_end`.
			// `tool_execution_*`/`compaction_*`/`session_info_changed`/
			// `thinking_level_changed`/`queue_update`/`auto_retry_end`.
			//
			// The runner drains until the child exits naturally after a final assistant `message_end` with no `toolCall` content.
			const accumulatedMessages: unknown[] = [];
			accountingMessages = accumulatedMessages;

			rl.on("line", (line) => {
				if (line.length === 0) return;
				const parsed = parsePiEventLine(line);
				if (!parsed.ok) {
					// `parsePiEventLine` skips non-JSON stdout noise.
					// The runner defers parse failure so a later terminal event can still succeed.
					// The runner sets `parse_failed` only when no later terminal event succeeds.
					if ("noise" in parsed) return;
					parseError = parsed.error;
					return;
				}
				const event = parsed.event;

				if (typeof event !== "object" || event === null) return;
				const e = event as {
					type?: string;
					messages?: unknown;
					message?: unknown;
				};

				const isFirstEvent = eventCount === 0;
				eventCount += 1;
				lastEventTimestamp = Date.now();
				if (typeof e.type === "string") lastEventType = e.type;

				const elapsedMs = Date.now() - startTime;

				if (isFirstEvent && typeof e.type === "string") {
					emitProgress({
						type: "first_event",
						eventType: e.type,
						ms: elapsedMs,
					});
				}

				// The runner emits `raw_event` before branch handling so logs include unrecognized events.
				emitProgress({
					type: "raw_event",
					eventType: typeof e.type === "string" ? e.type : undefined,
					event,
					ms: elapsedMs,
				});

				// `agent_end` with `messages` takes precedence over accumulated messages.
				if (e.type === "agent_end" && Array.isArray(e.messages)) {
					sawAgentEnd = true;
					agentEndMessages = e.messages;
					const result = extractFinalAssistant(e.messages);
					finalAssistantText = result.text;
					finalStopReason = result.stopReason;
					finalErrorMessage = result.errorMessage;
					emitProgress({
						type: "terminal",
						stopReason: result.stopReason ?? undefined,
						textLength: result.text?.length ?? 0,
						hasToolCall: false,
						ms: elapsedMs,
					});
					return;
				}

				// `stopReason="length"` means the model exhausted its token limit mid-response.
				// `stopReason="length"` is terminal even though the response was truncated.
				// The runner maps `stopReason="length"` to `model_failed` because the model exhausted its token limit.
				if (e.type === "message_end" && e.message) {
					accumulatedMessages.push(e.message);
					const m = e.message as {
						role?: string;
						content?: unknown;
						stopReason?: string;
						errorMessage?: string;
					};
					if (m.role === "assistant") {
						const hasToolCall =
							Array.isArray(m.content) &&
							m.content.some(
								(c) =>
									typeof c === "object" &&
									c !== null &&
									(c as { type?: unknown }).type === "toolCall",
							);
						const isTerminalStopReason =
							typeof m.stopReason === "string" &&
							(m.stopReason === "stop" ||
								m.stopReason === "length" ||
								m.stopReason === "error" ||
								m.stopReason === "aborted");
						if (isTerminalStopReason && !hasToolCall) {
							sawAgentEnd = true;
							const result = extractFinalAssistant(accumulatedMessages);
							finalAssistantText = result.text;
							finalStopReason = result.stopReason;
							finalErrorMessage = result.errorMessage;
							emitProgress({
								type: "terminal",
								stopReason: m.stopReason,
								textLength: result.text?.length ?? 0,
								hasToolCall: false,
								ms: elapsedMs,
							});
						}
					}
				}

				// After a terminal assistant turn, the runner allows 2 seconds for the child to flush stdout and exit naturally.
				//
				// The runner starts the drain timer after terminal detection instead of waiting for `timeoutMs`.
				// The runner gives the child 2 seconds to flush and exit naturally after a terminal turn.
				// drain-after-stop pattern.
				if (sawAgentEnd && !drainTimerStarted) {
					drainTimerStarted = true;
					if (timeoutHandle) {
						clearTimeout(timeoutHandle);
						timeoutHandle = undefined;
					}
					drainTimerHandle = setTimeout(() => {
						if (settled) return;
						terminateChild(child);
					}, TERMINAL_DRAIN_GRACE_MS);
					if (typeof drainTimerHandle.unref === "function") {
						drainTimerHandle.unref();
					}
				}
			});

			// The hard-timeout handler sends `SIGTERM` before `SIGKILL` so the child can flush stdout.
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
				timeoutHandle = setTimeout(() => {
					if (settled) return;
					terminateChild(child);
					// `eventCount === 0` identifies a silent timeout.
					// Malformed and non-object JSON leave the timeout classified as silent.
					const sinceLastEvent =
						lastEventTimestamp > 0 ? Date.now() - lastEventTimestamp : -1;
					const progressSuffix =
						eventCount === 0
							? " — no events received from child (silent hang: spawn/auth/network or model never started streaming)"
							: ` — saw ${eventCount} events; last event type=${lastEventType ?? "?"} ${sinceLastEvent}ms before timeout (model was emitting events but no terminal stopReason reached)`;
					settle({
						ok: false,
						reason: "timeout",
						error: `pi subagent timed out after ${options.timeoutMs}ms${progressSuffix}${stderr.length > 0 ? ` | stderr: ${stderr.slice(0, 500)}` : ""}`,
						durationMs: Date.now() - startTime,
						meta: {
							stderr: stderr.length > 0 ? stderr : undefined,
							eventCount,
							lastEventType: lastEventType ?? undefined,
							msSinceLastEvent: sinceLastEvent,
						},
					});
				}, options.timeoutMs);
			}

			const onAbort = () => {
				if (settled) return;
				terminateChild(child);
				settle({
					ok: false,
					reason: "abort",
					error: "pi subagent aborted by caller",
					durationMs: Date.now() - startTime,
				});
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });

			child.on("error", (error) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (drainTimerHandle) clearTimeout(drainTimerHandle);
				options.signal?.removeEventListener("abort", onAbort);
				settle({
					ok: false,
					reason: "spawn_failed",
					error: error instanceof Error ? error.message : String(error),
					durationMs: Date.now() - startTime,
				});
			});

			child.on("close", (code, signal) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (drainTimerHandle) clearTimeout(drainTimerHandle);
				options.signal?.removeEventListener("abort", onAbort);
				emitProgress({
					type: "child_exit",
					code,
					signal,
					ms: Date.now() - startTime,
				});
				if (settled) return;

				// A drain `SIGTERM` stops Pi print mode after the final turn.
				// Captured stopReason and text remain authoritative after the final turn.
				// A signaled close must not convert a valid answer into a subprocess failure.
				if (sawAgentEnd) {
					const trimmedAssistantText = finalAssistantText?.trim() ?? null;
					if (
						trimmedAssistantText === null ||
						trimmedAssistantText.length === 0
					) {
						settle({
							ok: false,
							reason: "no_assistant",
							error:
								trimmedAssistantText === null
									? "pi agent_end did not include an assistant message"
									: "pi assistant produced empty text",
							durationMs: Date.now() - startTime,
							// agent_end or terminal message_end proves protocol output.
							// sawProtocolOutput prevents the isolated retry after an empty completed turn.
							meta: {
								stderr: stderr.length > 0 ? stderr : undefined,
								sawProtocolOutput: true,
							},
						});
						return;
					}
					if (
						finalStopReason === "error" ||
						finalStopReason === "aborted" ||
						finalStopReason === "length"
					) {
						settle({
							ok: false,
							reason:
								finalStopReason === "length" ? "truncated" : "model_failed",
							error:
								finalErrorMessage ??
								`pi assistant stopped with reason "${finalStopReason}"`,
							durationMs: Date.now() - startTime,
							meta: { stderr: stderr.length > 0 ? stderr : undefined },
						});
						return;
					}
					settle({
						ok: true,
						assistantText: trimmedAssistantText,
						// `agent_end` with `messages` takes precedence over accumulated `message_end` messages.
						// countToolCalls counts toolCall content parts independently of event names.
						toolCallCount: countToolCalls(
							agentEndMessages ?? accumulatedMessages,
						),
						durationMs: Date.now() - startTime,
						meta: { stderr: stderr.length > 0 ? stderr : undefined },
					});
					return;
				}

				if (parseError !== null) {
					settle({
						ok: false,
						reason: "parse_failed",
						error: parseError,
						durationMs: Date.now() - startTime,
						meta: {
							stderr: stderr.length > 0 ? stderr : undefined,
							exitCode: code,
							signal,
						},
					});
					return;
				}

				if (code !== 0 || signal !== null) {
					settle({
						ok: false,
						reason: "non_zero_exit",
						error: `pi exited (code=${code}, signal=${signal}) without emitting agent_end. stderr: ${stderr.slice(0, 500) || "(empty)"}`,
						durationMs: Date.now() - startTime,
						meta: {
							stderr: stderr.length > 0 ? stderr : undefined,
							exitCode: code,
							signal,
						},
					});
					return;
				}

				settle({
					ok: false,
					reason: "no_assistant",
					error: `pi exited successfully without emitting agent_end. stderr: ${stderr.slice(0, 500) || "(empty)"}`,
					durationMs: Date.now() - startTime,
					meta: {
						stderr: stderr.length > 0 ? stderr : undefined,
						exitCode: code,
						signal,
						// The runner retries only when `eventCount === 0` and no `agent_end` was observed.
						// The retry distinguishes no agent_end with zero parsed events from partial runs that did not complete a turn.
						sawProtocolOutput: eventCount > 0,
					},
				});
			});
		});
	}
}

function getResultStderr(result: FailedRunResult): string {
	const stderr = result.meta?.stderr;
	return typeof stderr === "string" ? stderr : "";
}

function hasNoExtensionsArg(args: readonly string[]): boolean {
	return args.includes("--no-extensions");
}

function isPiExtensionCollisionFailure(
	result: SubagentRunResult,
): result is FailedRunResult {
	return (
		!result.ok &&
		result.reason === "non_zero_exit" &&
		getResultStderr(result).includes(ALREADY_PROCESSING_PREFIX)
	);
}

/**
 *
 * `agent_end` and terminal `message_end` set `sawProtocolOutput`, so `no_assistant` failures bypass isolated retry.
 * retry.
 */
function isSilentNoAssistantFailure(
	result: SubagentRunResult,
): result is FailedRunResult {
	return (
		!result.ok &&
		result.reason === "no_assistant" &&
		result.meta?.sawProtocolOutput === false
	);
}

/**
 * A failed primary attempt receives at most one isolated retry.
 * The retry disables discovered user extensions with `--no-extensions`.
 */
function isIsolatedRetryTrigger(
	result: SubagentRunResult,
): result is FailedRunResult {
	return (
		isPiExtensionCollisionFailure(result) || isSilentNoAssistantFailure(result)
	);
}

/* */
function isolatedRetryLogMessage(result: FailedRunResult): string {
	return isPiExtensionCollisionFailure(result)
		? ISOLATED_RETRY_COLLISION_LOG_MESSAGE
		: ISOLATED_RETRY_SILENT_LOG_MESSAGE;
}

function isIsolatedRetryModelUnavailable(
	result: SubagentRunResult,
): result is FailedRunResult {
	if (result.ok) return false;
	const diagnosticText = `${result.error}\n${getResultStderr(result)}`;
	return MODEL_RESOLUTION_ERROR_PATTERNS.some((pattern) =>
		pattern.test(diagnosticText),
	);
}

function annotateIsolatedRetryModelUnavailable(
	result: FailedRunResult,
): FailedRunResult {
	if (result.error.startsWith(ISOLATED_RETRY_MODEL_UNAVAILABLE_MESSAGE)) {
		return result;
	}
	return {
		...result,
		error: `${ISOLATED_RETRY_MODEL_UNAVAILABLE_MESSAGE}. Original failure: ${result.error}`,
	};
}

function isFallbackEligible(reason: string): boolean {
	return (
		reason === "model_failed" ||
		reason === "truncated" ||
		reason === "non_zero_exit" ||
		reason === "no_assistant"
	);
}

function providerPrefix(ref: string): string | undefined {
	const slash = ref.indexOf("/");
	return slash > 0 ? ref.slice(0, slash) : undefined;
}

function replaceProviderPrefix(ref: string, provider: string): string {
	const slash = ref.indexOf("/");
	return slash > 0 ? `${provider}${ref.slice(slash)}` : ref;
}

function resolveProviderModelAttempt(
	model: string | undefined,
): ProviderModelAttempt | undefined {
	if (typeof model !== "string" || model.length === 0) return undefined;

	const canonicalRef = modelRefToCanonicalForHost(model);
	const canonicalProvider = providerPrefix(canonicalRef);
	if (!canonicalProvider) return undefined;

	const translatedRef = resolveModelRefForHost(canonicalRef);
	const translatedProvider = providerPrefix(translatedRef);
	const cachedProvider = PI_PROVIDER_FORM_CACHE.get(canonicalProvider);
	if (
		!translatedProvider ||
		(translatedProvider === canonicalProvider && cachedProvider === undefined)
	) {
		return undefined;
	}

	const attemptedProvider = cachedProvider ?? translatedProvider;
	return {
		canonicalRef,
		canonicalProvider,
		modelRef: replaceProviderPrefix(canonicalRef, attemptedProvider),
		attemptedProvider,
		translated: attemptedProvider !== canonicalProvider,
	};
}

function isProviderCredentialFailure(
	result: SubagentRunResult,
	attempt: ProviderModelAttempt,
): result is FailedRunResult {
	return (
		attempt.translated &&
		!result.ok &&
		result.reason === "non_zero_exit" &&
		getResultStderr(result).includes(
			`No API key found for ${attempt.attemptedProvider}`,
		)
	);
}

/**
 * Limit the positional message to 96 KiB because Linux permits at most 128 KiB per argv entry.
 * Linux limits one argv entry to MAX_ARG_STRLEN (128 KiB).
 * A ~50K-token (~200 KB) prompt exceeds that limit and causes `spawn()` to fail with `E2BIG` on Linux.
 * Pipe prompts larger than 96 KiB through stdin to avoid Linux E2BIG errors.
 * Pi's print mode concatenates stdin into the initial message.
 * The 96 KiB limit leaves multibyte and encoding headroom below Linux's 128 KiB argv-entry limit.
 */
export const PROMPT_ARGV_MAX_BYTES = 96 * 1024;

/**
 *
 *
 * Omit the positional message when piping to prevent prompt duplication.
 */
export function buildArgs(
	options: SubagentRunOptions,
	opts?: {
		disableDiscoveredExtensions?: boolean;
		subagentExtensions?: readonly string[];
		omitPositionalMessage?: boolean;
		subagentEntryPath?: string;
		systemPromptPath?: string;
		modelRef?: string;
	},
): string[] {
	const ompHost = isOmpHostProcess();
	const args: string[] = [
		"--print",
		"--mode",
		"json",
		// `agent_end` on stdout supplies the result, so child sessions need no persisted JSONL.
		"--no-session",
		// A configured user allowlist disables extension discovery with `--no-extensions` and explicitly loads only allowlisted entries.
		// Subagents need neither skills nor project context.
		"--no-skills",
		// OMP rejects Pi's --no-prompt-templates and --no-context-files flags.
		// OMP folds AGENTS.md-style context into rules.
		// `--no-rules` preserves the exact child system prompt.
		...(ompHost
			? (["--no-rules"] as const)
			: (["--no-prompt-templates", "--no-context-files"] as const)),
		// Only unknown or explicitly zero-tool agents receive `--no-tools` below.
		// Known Magic Context children receive an explicit `--tools` allowlist.
	];
	if (
		opts?.disableDiscoveredExtensions ||
		opts?.subagentExtensions !== undefined
	) {
		// An active allowlist disables auto-discovered extensions.
		args.push("--no-extensions");
	}

	if (opts?.subagentExtensions !== undefined) {
		for (const extension of opts.subagentExtensions) {
			args.push("--extension", resolveSubagentExtensionEntry(extension));
		}
	}

	// The runner loads the lean subagent extension only for children that need scoped `ctx_*` tools.
	// Without an allowlist, discovered extensions remain enabled so provider extensions can register models.
	// The full Magic Context entry receives `MAGIC_CONTEXT_PI_SUBAGENT=1`.
	// With `MAGIC_CONTEXT_PI_SUBAGENT=1`, the full Magic Context entry returns before registering hooks, tools, or timers.
	// The lean entry does not check `MAGIC_CONTEXT_PI_SUBAGENT`; it registers only subagent-scoped tools.
	// The runner omits `--extension` when the bundle is absent, so the child lacks Magic Context `ctx_*` tools.
	//
	// The runner uses `--extension`, not `-e`, because extension-registered flags can conflict with `-e`.
	// Historian and compressor subagents do not use `ctx_*` tools.
	// Loading the entry would add startup cost and tool-registration surface.
	// Sidekick and dreamer subagents receive the lean entry.
	const subagentEntryPath = opts?.subagentEntryPath ?? SUBAGENT_ENTRY_PATH;
	const shouldLoadSubagentExtension =
		subagentEntryPath &&
		(SEARCH_ONLY_SUBAGENT_TOOL_AGENTS.has(options.agent) ||
			DREAMER_ACTION_AGENTS.has(options.agent));
	if (shouldLoadSubagentExtension) {
		args.push("--extension", subagentEntryPath);

		// Only dreamer subagents get `ctx_memory` in the child extension.
		// Sidekick loads the same entry for `ctx_search` but must remain read-only.
		if (DREAMER_ACTION_AGENTS.has(options.agent)) {
			args.push("--magic-context-dreamer-actions");
		}
	}

	// Pi applies every child's explicit built-in tool gate as hard registry isolation.
	// OMP validates only built-in names and appends discovered extension tools.
	const strictTools = STRICT_TOOL_ALLOWLIST.get(options.agent);
	if (strictTools === undefined) {
		sessionLog(
			options.accountingSessionId ?? "pi-subagent",
			`Pi subagent agent "${options.agent}" has no strict tool allow-list; forcing --no-tools`,
		);
		args.push("--no-tools");
	} else {
		const hostTools = resolveHostToolAllowlist(strictTools, ompHost);
		if (hostTools.length > 0) {
			args.push("--tools", hostTools.join(","));
		} else {
			args.push("--no-tools");
		}
	}

	if (opts?.systemPromptPath) {
		// `--system-prompt` replaces Pi's default prompt to preserve subagent role guidance.
		// The runner writes each subagent prompt to a temporary file and passes its absolute path.
		// The runner passes the generated prompt file by absolute path because Windows CreateProcess limits command lines to 32,767 characters.
		// The historian prompt is about 60 KB, so embedding it can exceed Windows' 32,767-character command-line limit.
		args.push("--system-prompt", opts.systemPromptPath);
	}

	if (typeof options.model === "string" && options.model.length > 0) {
		// Pi's `--models` limits the model picker; it does not define a fallback order.
		// The runner implements fallback by spawning one child per model, so each invocation receives one `--model`.
		//
		// The shared config stores the canonical (OpenCode) provider form.
		// Pi names the auth-plugin provider `openai` as `openai-codex`.
		// Translate to Pi's form when adding `--model` so `options.model` stays canonical elsewhere.
		args.push(
			"--model",
			opts?.modelRef ?? resolveModelRefForHost(options.model),
		);
	}

	// Without an explicit level, Pi resolves the level.
	// `github-copilot/gpt-5.4` rejects Pi's default `minimal` level.
	if (options.thinkingLevel) {
		args.push("--thinking", options.thinkingLevel);
	}

	// Positional message argument MUST come last in print-mode argv.
	// Pi 0.7x parses print-mode prompts after all known flags.
	// Newer Pi builds reject a `--` sentinel as an unknown option.
	//
	// The runner omits the positional message when it pipes the message through stdin for oversized prompts or on win32.
	// Passing the prompt through stdin and as a positional argument would duplicate it.
	if (!opts?.omitPositionalMessage) {
		args.push(options.userMessage);
	}

	return args;
}

/**
 * messages array.
 *
 * Pi defines `AgentMessage` in `@earendil-works/pi-ai`.
 *   {
 * Pi's `AgentMessage.role` is `user`, `assistant`, or `toolResult`.
 * Pi's `AgentMessage.content` contains `text`, `toolCall`, and `toolResult` parts.
 * Pi's `AgentMessage.stopReason` includes `stop`, `error`, and `aborted`.
 *     errorMessage?: string,
 *     ...
 *   }
 *
 */
export function extractFinalAssistant(messages: unknown[]): {
	text: string | null;
	stopReason: string | null;
	errorMessage: string | null;
} {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (typeof msg !== "object" || msg === null) continue;
		const m = msg as {
			role?: string;
			content?: unknown;
			stopReason?: string;
			errorMessage?: string;
		};
		if (m.role !== "assistant") continue;

		const text = Array.isArray(m.content)
			? m.content
					.filter((c): c is { type: string; text: string } => {
						if (typeof c !== "object" || c === null) return false;
						const cc = c as { type?: unknown; text?: unknown };
						return cc.type === "text" && typeof cc.text === "string";
					})
					.map((c) => c.text)
					.join("")
			: "";

		return {
			text,
			stopReason: typeof m.stopReason === "string" ? m.stopReason : null,
			errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : null,
		};
	}
	return { text: null, stopReason: null, errorMessage: null };
}

/**
 * Each `toolCall` content part represents one invocation.
 */
export function countToolCalls(messages: unknown[]): number {
	let count = 0;
	for (const msg of messages) {
		if (typeof msg !== "object" || msg === null) continue;
		const m = msg as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const part of m.content) {
			if (
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "toolCall"
			) {
				count += 1;
			}
		}
	}
	return count;
}

export function parsePiEventLine(
	line: string,
):
	| { ok: true; event: unknown }
	| { ok: false; error: string }
	| { ok: false; noise: true } {
	if (!line.trimStart().startsWith("{")) {
		return { ok: false, noise: true };
	}
	try {
		return { ok: true, event: JSON.parse(line) };
	} catch (error) {
		return {
			ok: false,
			error: `failed to parse event: ${error instanceof Error ? error.message : String(error)} | line=${line.slice(0, 200)}`,
		};
	}
}

function terminateChild(child: ReturnType<typeof childProcess.spawn>) {
	let exited = false;
	child.once("close", () => {
		exited = true;
	});
	child.once("exit", () => {
		exited = true;
	});
	child.kill("SIGTERM");
	const killHandle = setTimeout(() => {
		if (!exited && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}, 2000);
	if (typeof killHandle.unref === "function") {
		killHandle.unref();
	}
}

export const __test = {
	buildArgs,
	extractFinalAssistant,
	parsePiEventLine,
	terminateChild,
	DREAMER_ACTION_AGENTS,
	KNOWN_PI_SUBAGENT_AGENTS,
	resolveHostToolAllowlist,
	STRICT_TOOL_ALLOWLIST,
	ZERO_TOOL_PROMPT_REQUIRED_AGENTS,
	resetProviderFormCache: () => PI_PROVIDER_FORM_CACHE.clear(),
};
