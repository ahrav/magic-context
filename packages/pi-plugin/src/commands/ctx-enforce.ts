import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeClaimEnforceCommand } from "@magic-context/core/features/magic-context/memory/claim-policy-commands";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { describeError } from "@magic-context/core/shared/error-message";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

export interface RegisterCtxEnforceDeps {
	db: ContextDatabase;
	projectDir: string;
	projectIdentity: string;
	/** Resolve the project for the invoking context: Pi can `/cd` between
	 * projects after boot, so enforcement must target the ACTIVE project (and
	 * evaluate artifacts under its filesystem root), not the
	 * registration-time one. Absent resolver falls back to boot values. */
	resolveProject?: (ctx: { cwd: string }) => {
		projectDir: string;
		projectIdentity: string;
	};
}

export function registerCtxEnforceCommand(
	pi: ExtensionAPI,
	deps: RegisterCtxEnforceDeps,
): void {
	pi.registerCommand("ctx-enforce", {
		description:
			"Bind a passing in-project artifact to an approved memory claim (ENFORCED)",
		handler: async (args, ctx) => {
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-enforce",
					text: "## Claim Enforcement\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}
			const sessionMeta = getOrCreateSessionMeta(deps.db, sessionId);
			if (sessionMeta.isSubagent) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-enforce",
					text: "## Claim Enforcement — Refused\n\nEnforcement commands are user-only and unavailable to subagent sessions.",
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
					title: "/ctx-enforce",
					text: "## Claim Enforcement — Unavailable\n\nNo active project is configured for this session.",
					level: "error",
				});
				return;
			}
			try {
				const result = await executeClaimEnforceCommand(
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
					title: "/ctx-enforce",
					text: result.text,
					level: result.level,
				});
			} catch (error) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-enforce",
					text: `## Claim Enforcement — Failed\n\n${describeError(error).brief}`,
					level: "error",
				});
			}
		},
	});
}
