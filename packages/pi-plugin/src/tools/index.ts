/**
 *
 * The shared guidance advertises a tool only when Pi registers it.
 * If guidance advertises an unregistered tool, Pi returns "tool not found" when the agent invokes it.
 *
 * `ctx_note` and `ctx_expand` are omitted for `--no-session` child processes because they resolve to the ephemeral child session.
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
	/** The resolver uses the user-level home-project setting to resolve the current directory's project identity. */
	resolveProjectIdentity?: (ctx: { cwd: string }) => string | undefined;
	/** When true, ctx_memory exposes dreamer-only actions (update, merge, archive).
	 * The subagent extension enables `allowDreamerActions` when its parent passes `--magic-context-dreamer-actions`.
	 * The main extension leaves `allowDreamerActions` false to match OpenCode's primary-agent surface. */
	allowDreamerActions?: boolean;
	/** `ctx_reduce` defers drops for the most recent `protectedTags` tags.
	 * `protectedTags` must equal `magic_context.protected_tags`. */
	protectedTags?: number;
	/** The resolver reads protected-tag config from the current cwd at tool-call time. */
	resolveProtectedTags?: (ctx: { cwd: string }) => number | undefined;
	/** `ctx_note` accepts smart notes with `surface_condition` only when the dreamer evaluates them; otherwise it rejects the writes to prevent stuck-pending state.
	 * `ctx_note` rejects smart-note writes when `dreamerEnabled` is false to prevent stuck-pending state. */
	dreamerEnabled?: boolean;
	/** The resolver reads smart-note enablement from the current cwd at tool-call time. */
	resolveDreamerEnabled?: (ctx: { cwd: string }) => boolean | undefined;
	/** `memoryToolEnabled=false` omits `ctx_memory` from the registered surface.
	 * The sidekick needs read-only `ctx_search`; dreamer and the main agent keep `ctx_memory`. */
	memoryToolEnabled?: boolean;
	/** `sessionScopedToolsDisabled=true` omits `ctx_note` and `ctx_expand` from the registered surface.
	 * `--no-session` sidekick and dreamer children set `sessionScopedToolsDisabled`.
	 * In `--no-session` children, `ctx_note` and `ctx_expand` resolve `ctx.sessionManager.getSessionId()` to the ephemeral child session.
	 * In `--no-session` children, `ctx_note` writes notes under the hidden ephemeral child ID.
	 * In `--no-session` children, `ctx_expand` expands the child's empty transcript. */
	sessionScopedToolsDisabled?: boolean;
	/* */
	todowriteEnabled?: boolean;
	/** Main Pi entry registers /todos; lean subagent entries keep commands off. */
	todowriteCommandEnabled?: boolean;
	/** `compactionOff=true` omits `ctx_reduce` while leaving the other Pi tools available. */
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

	// `ctx_note` and `ctx_expand` resolve the ephemeral child session in `--no-session` children, so omit them to prevent orphaned notes and expansion of the empty child transcript.
	// `ctx_note` and `ctx_expand` resolve the ephemeral child session in `--no-session` children, so omit them to prevent orphaned notes and expansion of the empty child transcript.
	// `ctx_note` and `ctx_expand` resolve the ephemeral child session in `--no-session` children, so omit them to prevent orphaned notes and expansion of the empty child transcript.
	// `ctx_note` and `ctx_expand` resolve the ephemeral child session in `--no-session` children, so omit them to prevent orphaned notes and expansion of the empty child transcript.
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
		pi.registerTool(createTodowriteTool());
		if (opts.todowriteCommandEnabled !== false) {
			registerTodosCommand(pi);
		}
	}

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
