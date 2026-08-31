import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withContentLanguageDirective } from "@magic-context/core/agents/language-directive";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { isWrapupInProgress } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT } from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { executeContextRecompWithResult } from "@magic-context/core/hooks/magic-context/compartment-runner";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
	contextualizeUpgradeReason,
	extractRecompReason,
	isRecompComplete,
	isRecompFailure,
} from "@magic-context/core/hooks/magic-context/recomp-orchestrator";
import { describeError } from "@magic-context/core/shared/error-message";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { COMPACTION_OFF_COMMAND_UNAVAILABLE } from "../compaction-off-pi";
import {
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
} from "../context-handler";
import { ensureProjectRegisteredFromPiDirectory } from "../embedding-bootstrap";
import { createPiHistorianClient } from "../pi-recomp-client-shared";
import { stagePiRecompMarker } from "../pi-recomp-marker";
import { isPiRecompInFlight, spawnPiRecompRun } from "../pi-recomp-runner";
import { readPiSessionMessages } from "../read-session-pi";
import { updateStatusLine } from "../status-line";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

export interface CtxSessionUpgradeRuntimeDeps {
	db: ContextDatabase;
	runner: SubagentRunner;
	historianModel: string | undefined;
	historianChunkTokens: number;
	historianFallbacks?: readonly string[];
	historianTimeoutMs?: number;
	historianThinkingLevel?: string;
	language?: string;
	memoryEnabled: boolean;
	/** The runtime permits a session started exactly in the canonical home directory only when user-level configuration enables `allowHomeProject`. */
	allowHomeProject?: boolean;
	autoPromote: boolean;
	userMemoriesEnabled?: boolean;
	compactionOff?: boolean;
}

export interface RegisterCtxSessionUpgradeDeps
	extends CtxSessionUpgradeRuntimeDeps {
	resolveRuntimeDeps?: (ctx: { cwd: string }) => CtxSessionUpgradeRuntimeDeps;
}

/**
 *
 *   1. Full recomp — rebuilds every legacy v1 compartment into the v2 tiered
 *      shape (recomp emits NO facts, so curated memories are untouched here).
 *   2. Memory migration — re-evaluates the project's memories into the v2
 *      5-category taxonomy (once per project, idempotent).
 *
 * Recomp is session-scoped; migration is project-scoped.
 * The command uses the historian model and runner, so it works when the dreamer is disabled.
 */
export function registerCtxSessionUpgradeCommand(
	pi: ExtensionAPI,
	deps: RegisterCtxSessionUpgradeDeps,
): void {
	pi.registerCommand("ctx-session-upgrade", {
		description:
			"Upgrade this session to the current Magic Context history format and re-organize project memories",
		handler: async (_args, ctx) => {
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}
			const currentDeps = deps.resolveRuntimeDeps?.(ctx) ?? deps;
			if (currentDeps.compactionOff) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: COMPACTION_OFF_COMMAND_UNAVAILABLE,
					level: "warning",
				});
				return;
			}
			if (!currentDeps.historianModel) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nUnavailable because `historian.model` is not configured.",
					level: "error",
				});
				return;
			}

			if (isWrapupInProgress(currentDeps.db, sessionId)) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\n/ctx-wrapup is already compacting this session. Wait for it to finish, then try again.",
					level: "warning",
				});
				return;
			}

			if (isPiRecompInFlight(sessionId)) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nAn upgrade or recomp is already running for this session in the background. Wait for it to finish, then try again.",
					level: "warning",
				});
				return;
			}

			// "Upgradable" = lacks usable v2 tiers: a pre-v2 `legacy=1` row OR a
			// malformed `legacy=0` row with an empty `p1`
			// OpenCode runManagedUpgrade).
			const compartments = getCompartments(currentDeps.db, sessionId);
			const upgradableCount = compartments.filter(
				(c) => c.legacy === 1 || !c.p1 || c.p1.trim() === "",
			).length;

			// Consolidation uses the user's working model instead of the historian model.
			const sessionMainModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;

			if (upgradableCount === 0) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: [
						"## Session Upgrade — Already Up To Date",
						"",
						compartments.length === 0
							? "This session has no compartment history to upgrade yet."
							: "This session's compartments are already in the current format.",
					].join("\n"),
					level: "info",
				});
				return;
			}

			sendCtxStatusMessage(pi, {
				title: "/ctx-session-upgrade",
				text: "## Session Upgrade\n\nRebuilding compartments into the v2 format. This may take a while.",
				level: "info",
			});

			const provider = {
				readMessages: () => readPiSessionMessages(ctx),
			} satisfies RawMessageProvider;

			// The handler runs the upgrade in the background to keep the Pi REPL responsive.
			// spawnPiRecompRun.
			spawnPiRecompRun({
				sessionId,
				provider,
				onStatusChange: () =>
					updateStatusLine(ctx, {
						db: currentDeps.db,
						projectIdentity: ctx.cwd,
					}),
				work: async () => {
					const recompResult = await executeContextRecompWithResult(
						{
							client: createPiHistorianClient({
								runner: currentDeps.runner,
								model: currentDeps.historianModel as string,
								fallbackModels: currentDeps.historianFallbacks,
								timeoutMs: currentDeps.historianTimeoutMs,
								thinkingLevel: currentDeps.historianThinkingLevel,
								directory: ctx.cwd,
								accountingSessionId: sessionId,
								systemPrompt: withContentLanguageDirective(
									COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
									currentDeps.language,
									{ preserveUserQuotes: true },
								),
								notify: (text) =>
									sendCtxStatusMessage(pi, {
										title: "/ctx-session-upgrade",
										text,
										level: "info",
									}),
							}) as never,
							db: currentDeps.db,
							sessionId,
							historianChunkTokens: currentDeps.historianChunkTokens,
							directory: ctx.cwd,
							historianTimeoutMs: currentDeps.historianTimeoutMs,
							memoryEnabled: currentDeps.memoryEnabled,
							autoPromote: currentDeps.autoPromote,
							// The handler registers the project before recomp so rebuilt compartments receive embeddings.
							// Rebuilt compartments must receive embeddings to appear in `ctx_search`.
							ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
							// The runner retries with configured fallbacks, then the session model, after the historian primary returns an empty or invalid HTTP-200 response.
							fallbackModels: currentDeps.historianFallbacks,
							fallbackModelId: sessionMainModel,
							language: currentDeps.language,
						},
						{},
					);

					// `published` confirms that recomp rebuilt compartments.
					// `isRecompFailure` does not recognize lease- or active-runs no-ops (`Historian already running…`).
					// `published` can accompany `— Partial`; do not migrate partial rebuilds because they leave tierless legacy rows.
					// recomp-orchestrator gate.
					if (
						!recompResult.published ||
						!isRecompComplete(recompResult.message)
					) {
						const reason = contextualizeUpgradeReason(
							isRecompFailure(recompResult.message)
								? extractRecompReason(recompResult.message)
								: `Compartments were not fully rebuilt: ${extractRecompReason(recompResult.message)}`,
						);
						sendCtxStatusMessage(pi, {
							title: "/ctx-session-upgrade",
							text: `## Session Upgrade — Incomplete\n\n${reason}`,
							level: "error",
						});
						return;
					}

					// Background runs must defer marker application until a turn boundary; eager application can mutate the active branch mid-turn.
					//
					// `stagePiRecompMarker` failures must not prevent refresh signaling, migration, or the completion message.
					// `stagePiRecompMarker` failures are recoverable because the next incremental historian pass stages a covering marker.
					// published.
					try {
						stagePiRecompMarker({ db: currentDeps.db, sessionId, ctx });
					} catch (markerError) {
						sessionLog(
							sessionId,
							`pi /ctx-session-upgrade marker staging failed (non-fatal, recomp already published): ${describeError(markerError).brief}`,
						);
					}

					signalPiDeferredHistoryRefresh(sessionId);
					signalPiDeferredMaterialization(sessionId);

					sendCtxStatusMessage(pi, {
						title: "/ctx-session-upgrade",
						text: [
							"## Session Upgrade — Complete",
							"",
							upgradableCount > 0
								? `Rebuilt ${upgradableCount} legacy compartment${upgradableCount === 1 ? "" : "s"} into the v2 format.`
								: "Rebuilt this session's compartments into the v2 format.",
							"",
							recompResult.message,
						].join("\n"),
						level: "info",
					});
				},
			});
		},
	});
}
