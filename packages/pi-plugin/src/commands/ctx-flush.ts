import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage";
import { executeFlush } from "@magic-context/core/hooks/magic-context/execute-flush";
import { COMPACTION_OFF_COMMAND_UNAVAILABLE } from "../compaction-off-pi";
import {
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemPromptRefresh,
} from "../context-handler";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

export function registerCtxFlushCommand(
	pi: ExtensionAPI,
	deps: { db: ContextDatabase; compactionOff?: boolean },
): void {
	pi.registerCommand("ctx-flush", {
		description:
			"Force pending Magic Context drops to materialize on the next provider call",
		handler: async (_args, ctx) => {
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-flush",
					text: "## /ctx-flush\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}
			if (deps.compactionOff) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-flush",
					text: COMPACTION_OFF_COMMAND_UNAVAILABLE,
					level: "warning",
				});
				return;
			}

			const pendingBefore = getPendingOps(deps.db, sessionId).length;
			const result = executeFlush(deps.db, sessionId);

			//      the command).
			//      turn.
			signalPiHistoryRefresh(sessionId);
			signalPiPendingMaterialization(sessionId);
			signalPiSystemPromptRefresh(sessionId);

			const text =
				pendingBefore > 0
					? `## /ctx-flush\n\nFlushed ${pendingBefore} pending ops; next provider call will materialize.\n\n${result}`
					: `## /ctx-flush\n\n${result}`;
			sendCtxStatusMessage(
				pi,
				{
					title: "/ctx-flush",
					text,
					level: result.startsWith("Error:") ? "error" : "success",
				},
				{ sessionId, pendingBefore, result },
			);
		},
	});
}
