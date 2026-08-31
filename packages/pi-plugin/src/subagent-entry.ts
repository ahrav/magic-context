/**
 * `PiSubagentRunner` loads this entry to register subagent tools.
 *
 * `PiSubagentRunner` loads this entry only in child Pi processes.
 * The subagent entry registers only Magic Context tools intended for subagents.
 * else.
 *
 * `MAGIC_CONTEXT_PI_SUBAGENT=1` makes `./index.ts` return before registering its handlers.
 * Child Pi processes keep extension discovery enabled for provider models and AFT tools.
 * `MAGIC_CONTEXT_PI_SUBAGENT=1` prevents recursion by making the full entry return before registration.
 * The subagent entry is unguarded because child Pi processes must load its scoped tools.
 *
 * The full entry must not load in subagents because its handlers can recursively spawn subagents and alter subagent prompts.
 *      subagents.
 * The full entry performs database work, resource discovery, and timer wiring in subagents.
 * The full entry injects key files, project documentation, user profiles, and session history into subagent prompts.
 *
 * `--no-session` children receive `ctx_search`; dreamers receive `ctx_memory` only with `--magic-context-dreamer-actions`.
 * `ctx_search` provides read-only search over shared memories, messages, and Git.
 * Only dreamers receive `ctx_memory`; retrieval-only sidekicks use `ctx_search`.
 *
 * Hidden child sessions omit `ctx_note` and `ctx_expand` because they have no useful transcript or parent note ID.
 *
 *
 * `PiSubagentRunner` starts child Pi processes with `MAGIC_CONTEXT_PI_SUBAGENT=1` and this entry's `--extension` path.
 *     [other flags...]
 *
 * Pi applies the per-agent `--tools` list to the complete registry.
 * OMP applies `--tools` only to built-ins and appends discovered extension tools afterward.
 * OMP's `--tools` list budgets tools but does not sandbox extension tools.
 *
 * `--magic-context-dreamer-actions` registers `ctx_memory` with the dreamer action surface.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configureSynapseManagedDemandStart } from "@magic-context/core/features/magic-context/memory/embedding-synapse";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { createLazyManagedDemandStart } from "@magic-context/core/hooks/magic-context/module-transport";
import { setHarness } from "@magic-context/core/shared/harness";
import { log } from "@magic-context/core/shared/logger";
import { setStoragePrivatePermissionEnforcement } from "@magic-context/core/shared/storage-permissions";
import { loadPiConfig } from "./config";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { registerMagicContextTools } from "./tools";

const SUBAGENT_DREAMER_ACTIONS_FLAG = "magic-context-dreamer-actions";
const managedDemandStart = createLazyManagedDemandStart({
	declaringModuleUrl: import.meta.url,
	parentPackageName: "@cortexkit/pi-magic-context",
});

let openedDb: ContextDatabase | undefined;

export default function magicContextSubagentExtension(pi: ExtensionAPI): void {
	configureSynapseManagedDemandStart(managedDemandStart);
	// Shared-core session writes tag rows with `harness='pi'`.
	setHarness("pi");

	pi.registerFlag(SUBAGENT_DREAMER_ACTIONS_FLAG, {
		description:
			"Register ctx_memory with dreamer actions for Magic Context subagents.",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async () => {
		try {
			// Loading shared config before storage prevents a child from re-tightening externally managed permissions in trusted-group deployments.
			const directory = process.cwd();
			const { config: cfg, registrationPromptSurface } = loadPiConfig({
				cwd: directory,
			});
			setStoragePrivatePermissionEnforcement(
				cfg.storage.enforce_private_permissions,
			);
			const db = openDatabase();
			if (!db) {
				throw new Error(
					"storage open failed; refusing to start without Magic Context tools",
				);
			}
			openedDb = db;
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			const dreamerActionsEnabled =
				pi.getFlag(SUBAGENT_DREAMER_ACTIONS_FLAG) === true;

			registerMagicContextTools(pi, {
				db,
				ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
				resolveProjectIdentity: (ctx) =>
					resolveProjectIdentityForSession(ctx.cwd, cfg.allow_home_project),
				// `--magic-context-dreamer-actions` registers `ctx_memory` with dreamer actions.
				memoryToolEnabled: dreamerActionsEnabled,
				allowDreamerActions: dreamerActionsEnabled,
				// Hidden child sessions omit `ctx_note` and `ctx_expand` because they have no useful transcript or parent note ID.
				// Hidden child sessions omit `ctx_note` and `ctx_expand` because they have no useful transcript or parent note ID.
				sessionScopedToolsDisabled: true,
				todowriteEnabled: cfg.todowrite.enabled !== false,
				todowriteCommandEnabled: false,
				promptSurface: registrationPromptSurface,
			});

			log(
				`[pi-subagent] registered tools: ctx_search${dreamerActionsEnabled ? ", ctx_memory" : ""}${cfg.todowrite.enabled !== false ? ", todowrite" : ""}` +
					` (ctx_note/ctx_expand omitted: --no-session child;` +
					` memory=${cfg.memory.enabled}, embedding=${cfg.embedding.provider !== "off"},` +
					` git_commits=${cfg.memory.git_commit_indexing.enabled}, dreamer_actions=${dreamerActionsEnabled})`,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(`[pi-subagent] startup failed: ${message}`);
			process.exitCode = 1;
			throw err;
		}
	});

	pi.on("session_shutdown", () => {
		if (openedDb) {
			try {
				openedDb.close();
			} catch {}
			openedDb = undefined;
		}
	});
}
