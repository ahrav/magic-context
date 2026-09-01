import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeClaimApprovalCommand } from "@magic-context/core/features/magic-context/memory/claim-policy-commands";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { describeError } from "@magic-context/core/shared/error-message";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

export interface RegisterCtxApproveDeps {
	db: ContextDatabase;
	projectDir: string;
	projectIdentity: string;
	/** Pi can `/cd` after boot, so the command resolves the invoking context's active project.
	 * Without `resolveProject`, the command uses the registration-time `projectDir` and `projectIdentity`. */
	resolveProject?: (ctx: { cwd: string }) => {
		projectDir: string;
		projectIdentity: string;
	};
}

export function registerCtxApproveCommand(
	pi: ExtensionAPI,
	deps: RegisterCtxApproveDeps,
): void {
	pi.registerCommand("ctx-approve", {
		description:
			"Approve (or --revoke) the exact current revision of a project memory claim",
		handler: async (args, ctx) => {
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-approve",
					text: "## Claim Approval\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}
			const sessionMeta = getOrCreateSessionMeta(deps.db, sessionId);
			if (sessionMeta.isSubagent) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-approve",
					text: "## Claim Approval — Refused\n\nApproval commands are user-only and unavailable to subagent sessions.",
					level: "warning",
				});
				return;
			}
			const project = deps.resolveProject?.(ctx) ?? {
				projectDir: deps.projectDir,
				projectIdentity: deps.projectIdentity,
			};
			if (!project.projectIdentity) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-approve",
					text: "## Claim Approval — Unavailable\n\nNo active project is configured for this session.",
					level: "error",
				});
				return;
			}
			try {
				const result = await executeClaimApprovalCommand(
					{
						db: deps.db,
						projectPath: project.projectIdentity,
						projectRoot: project.projectDir,
						host: "pi",
						sessionId,
					},
					args ?? "",
				);
				sendCtxStatusMessage(pi, {
					title: "/ctx-approve",
					text: result.text,
					level: result.level,
				});
			} catch (error) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-approve",
					text: `## Claim Approval — Failed\n\n${describeError(error).brief}`,
					level: "error",
				});
			}
		},
	});
}
