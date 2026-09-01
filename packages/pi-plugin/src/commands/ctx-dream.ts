import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDreamTaskBacklogs } from "@magic-context/core/features/magic-context/dreamer/task-gates";
import {
	CANONICAL_DREAM_TASKS,
	type DreamTaskName,
	formatDreamTaskBacklogs,
	isCanonicalDreamTask,
} from "@magic-context/core/features/magic-context/dreamer/task-registry";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { sessionLog } from "@magic-context/core/shared/logger";
import { runPiDreamForProject } from "../dreamer";
import { sendCtxStatusMessage } from "./pi-command-utils";

export function registerCtxDreamCommand(
	pi: ExtensionAPI,
	deps: {
		db: ContextDatabase;
		projectDir: string;
		projectIdentity: string;
		resolveProject?: (ctx: { cwd: string }) => {
			projectDir: string;
			projectIdentity: string;
		};
		dreamerEnabled?: boolean;
		resolveDreamerEnabled?: (ctx: { cwd: string }) => boolean | undefined;
		onProjectSeen?: (projectIdentity: string) => void;
	},
): void {
	pi.registerCommand("ctx-dream", {
		description: "Run Magic Context dreamer tasks for this project now",
		handler: async (args, ctx) => {
			const project = deps.resolveProject?.(ctx) ?? {
				projectDir: deps.projectDir,
				projectIdentity: deps.projectIdentity,
			};
			const dreamerEnabled =
				deps.resolveDreamerEnabled?.(ctx) ?? deps.dreamerEnabled;
			deps.onProjectSeen?.(project.projectIdentity);

			const requested =
				typeof args === "string" ? args.trim() : String(args ?? "").trim();
			let task: DreamTaskName | undefined;
			if (requested) {
				if (!isCanonicalDreamTask(requested)) {
					sendCtxStatusMessage(
						pi,
						{
							title: "/ctx-dream",
							text: `## /ctx-dream\n\nUnknown task "${requested}".`,
							level: "info",
						},
						{
							projectDir: project.projectDir,
							projectIdentity: project.projectIdentity,
						},
					);
					return;
				}
				task = requested;
			}
			if (dreamerEnabled === false) {
				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: "## /ctx-dream\n\nDreamer is disabled for this project (`dreamer.disable=true`).",
						level: "info",
					},
					{
						projectDir: project.projectDir,
						projectIdentity: project.projectIdentity,
					},
				);
				return;
			}
			const backlogTasks = task ? [task] : CANONICAL_DREAM_TASKS;
			const backlogBefore = getDreamTaskBacklogs(
				deps.db,
				project.projectIdentity,
				backlogTasks,
			);

			// The initial status reports the backlog before lease acquisition.
			sendCtxStatusMessage(
				pi,
				{
					title: "/ctx-dream",
					text: [
						"## /ctx-dream",
						"",
						task
							? `Running dream task "${task}" for ${project.projectIdentity}…`
							: `Starting dream run for ${project.projectIdentity}…`,
						`Project directory: ${project.projectDir}`,
						"",
						"Backlog before starting:",
						formatDreamTaskBacklogs(backlogBefore, backlogTasks),
					].join("\n"),
					level: "info",
				},
				{
					projectDir: project.projectDir,
					projectIdentity: project.projectIdentity,
				},
			);

			try {
				const result = await runPiDreamForProject(
					project.projectIdentity,
					task,
				);
				const lines: string[] = [];
				if (result.ran.length > 0) lines.push(`Ran: ${result.ran.join(", ")}`);
				if (result.failed.length > 0)
					lines.push(`Failed: ${result.failed.join(", ")}`);
				if ((result.failureDetails?.length ?? 0) > 0) {
					lines.push(
						"Failure details:",
						...(result.failureDetails ?? []).map((detail) => `- ${detail}`),
					);
				}
				if (result.skippedNoWork.length > 0)
					lines.push(`Skipped (no work): ${result.skippedNoWork.join(", ")}`);
				if (result.deferredBusy.length > 0)
					lines.push(
						`Busy: ${result.deferredBusy.join(", ")} — another dream task holds this domain's lease; retry in a minute`,
					);
				if (Object.keys(result.backlogAfter ?? {}).length > 0) {
					lines.push(
						"",
						"Backlog at run end:",
						formatDreamTaskBacklogs(result.backlogAfter),
					);
				}
				if (lines.length === 0) lines.push("No enabled dream tasks to run.");

				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: ["## /ctx-dream", "", ...lines].join("\n"),
						level: result.ran.length > 0 ? "success" : "info",
					},
					{
						projectDir: project.projectDir,
						projectIdentity: project.projectIdentity,
					},
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sessionLog(project.projectIdentity, `/ctx-dream failed: ${message}`);
				sendCtxStatusMessage(
					pi,
					{
						title: "/ctx-dream",
						text: [
							"## /ctx-dream",
							"",
							`Dream run failed: ${message}`,
							"The registered timer will retry due tasks on its next tick.",
						].join("\n"),
						level: "error",
					},
					{
						projectDir: project.projectDir,
						projectIdentity: project.projectIdentity,
					},
				);
			}
		},
	});
}
