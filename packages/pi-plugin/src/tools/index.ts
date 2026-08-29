/**
 * Pi-side tool registration.
 *
 * Registers `ctx_search`, `ctx_memory`, `ctx_note`, `ctx_expand`, and
 * `ctx_reduce` against the live Pi extension API. The shared guidance block
 * in `system-prompt.ts` advertises these to the LLM only when each is
 * available, so a registration gap surfaces as "tool not found" errors when
 * the agent tries to follow the guidance.
 *
 * `ctx_reduce` is part of the primary session-scoped surface. It is omitted
 * only for `--no-session` child processes where session-scoped tools would
 * resolve to the hidden ephemeral child session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import type { PromptSurfaceConfig } from "@magic-context/core/shared/prompt-surface";
import type { PromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import { createCtxExpandTool } from "./ctx-expand";
import { createCtxMemoryTool } from "./ctx-memory";
import { createCtxNoteTool } from "./ctx-note";
import { createCtxReduceTool } from "./ctx-reduce";
import { createCtxSearchTool } from "./ctx-search";
import { registerTodosCommand } from "./todo-view-pi";
import { createTodowriteTool } from "./todowrite";

export interface RegisterToolsOptions {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	memoryEnabled?: boolean;
	embeddingEnabled?: boolean;
	gitCommitsEnabled?: boolean;
	/** Resolve the current directory's project identity using the user-level home-project setting. */
	resolveProjectIdentity?: (ctx: { cwd: string }) => string | undefined;
	/** When true, ctx_memory exposes dreamer-only actions (update, merge, archive).
	 *  Set by the subagent extension entry when the parent passes
	 *  `--magic-context-dreamer-actions`. The main extension entry
	 *  (./index.ts) leaves this false to match OpenCode's primary-agent surface. */
	allowDreamerActions?: boolean;
	/** Number of recent tags that ctx_reduce should treat as protected
	 *  (deferred drops instead of immediate). Should match `magic_context.protected_tags`. */
	protectedTags?: number;
	/** Resolve protected-tag config from the current cwd at tool-call time. */
	resolveProtectedTags?: (ctx: { cwd: string }) => number | undefined;
	/** When true, ctx_note accepts smart notes (surface_condition) because
	 *  the dreamer is configured to evaluate them. When false, smart-note
	 *  writes are rejected to avoid stuck-pending state. */
	dreamerEnabled?: boolean;
	/** Resolve smart-note enablement from the current cwd at tool-call time. */
	resolveDreamerEnabled?: (ctx: { cwd: string }) => boolean | undefined;
	/** When false, omit ctx_memory from the registered surface. Sidekick only
	 *  needs read-only ctx_search; dreamer and the main agent keep ctx_memory. */
	memoryToolEnabled?: boolean;
	/** When true, omit session-scoped tools (ctx_note, ctx_expand) from the
	 *  registered surface. Set by `--no-session` children (sidekick, dreamer):
	 *  those tools resolve `ctx.sessionManager.getSessionId()` to the EPHEMERAL
	 *  child session, so ctx_note would write notes orphaned under the hidden
	 *  child id and ctx_expand would expand the child's empty transcript. */
	sessionScopedToolsDisabled?: boolean;
	/** When false, omit Magic Context's Pi todowrite tool entirely. */
	todowriteEnabled?: boolean;
	/** Main Pi entry registers /todos; lean subagent entries keep commands off. */
	todowriteCommandEnabled?: boolean;
	/** In compaction-off mode, omit ctx_reduce and keep the other Pi tools available. */
	compactionOff?: boolean;
	promptSurface?: PromptSurfaceConfig;
	promptSurfaceRuntime?: PromptSurfaceRuntime;
}

export function registerMagicContextTools(
	pi: ExtensionAPI,
	opts: RegisterToolsOptions,
): void {
	const resolveProjectIdentity = opts.resolveProjectIdentity
		? (directory: string) => opts.resolveProjectIdentity?.({ cwd: directory })
		: undefined;
	const promptSurfaceRuntime =
		opts.promptSurfaceRuntime ??
		createPromptSurfaceRuntime({
			userConfigDirectory: process.cwd(),
			warn: (message) =>
				console.warn(`[magic-context][pi] config warning: ${message}`),
		});
	// Pi registers provider tools once when the extension loads. Resolve the
	// registration default once here; project/model switches may reroute guidance
	// but cannot mutate the descriptions owned by this ExtensionAPI instance.
	const registration = promptSurfaceRuntime.resolveRegistration(
		opts.promptSurface,
	);
	const surfaceTool = <T extends { name: string; description: string }>(
		definition: T,
	): T => ({
		...definition,
		description: registration.descriptionFor(
			definition.name,
			definition.description,
		),
	});

	pi.registerTool(
		surfaceTool(
			createCtxSearchTool({
				db: opts.db,
				ensureProjectRegistered: opts.ensureProjectRegistered,
				memoryEnabled: opts.memoryEnabled,
				embeddingEnabled: opts.embeddingEnabled,
				gitCommitsEnabled: opts.gitCommitsEnabled,
				resolveProjectIdentity,
			}),
		),
	);

	if (opts.memoryToolEnabled !== false) {
		pi.registerTool(
			surfaceTool(
				createCtxMemoryTool({
					db: opts.db,
					ensureProjectRegistered: opts.ensureProjectRegistered,
					memoryEnabled: opts.memoryEnabled,
					allowDreamerActions: opts.allowDreamerActions ?? false,
					resolveProjectIdentity,
				}),
			),
		);
	}

	// ctx_note and ctx_expand are session-scoped: they resolve the CURRENT
	// session id at call time. For `--no-session` children that id is the hidden
	// ephemeral child session, so a note would be orphaned and an expand would
	// target the child's empty transcript. Omit them for those children; ctx_search
	// stays available and ctx_memory is controlled above.
	if (!opts.sessionScopedToolsDisabled) {
		pi.registerTool(
			surfaceTool(
				createCtxNoteTool({
					db: opts.db,
					dreamerEnabled: opts.dreamerEnabled ?? false,
					resolveDreamerEnabled: opts.resolveDreamerEnabled,
					resolveProjectIdentity,
				}),
			),
		);

		pi.registerTool(surfaceTool(createCtxExpandTool({ db: opts.db })));
	}

	if (opts.todowriteEnabled !== false) {
		// `todowrite` parity with OpenCode. Pi-coding-agent has no built-in
		// task list tool, so without this the synthetic-todowrite injector
		// would never have anything to surface. The tool just captures the
		// `todos` arg and echoes a pretty-printed JSON ack; `message_end`
		// in index.ts snapshots `params.todos` into `session_meta.last_todo_state`
		// for downstream synthesis. See `tools/todowrite.ts` header for rationale.
		pi.registerTool(createTodowriteTool());
		if (opts.todowriteCommandEnabled !== false) {
			registerTodosCommand(pi);
		}
	}

	// ctx_reduce is session-scoped just like ctx_note/ctx_expand: it resolves the
	// CURRENT session id at call time. Omit it for `--no-session` children where
	// that id points at a hidden ephemeral child session.
	if (!opts.sessionScopedToolsDisabled && !opts.compactionOff) {
		pi.registerTool(
			surfaceTool(
				createCtxReduceTool({
					db: opts.db,
					protectedTags: opts.protectedTags ?? 20,
					resolveProtectedTags: opts.resolveProtectedTags,
				}),
			),
		);
	}
}
