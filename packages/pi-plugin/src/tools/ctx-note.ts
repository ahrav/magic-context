/**
 *
 *
 * Smart notes with `surface_condition` are project-scoped.
 * The dreamer evaluates smart notes during nightly runs.
 * The tool rejects smart-note writes when the dreamer is disabled.
 * When the dreamer is disabled, existing smart notes remain `pending` with no surfacing path.
 *
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getLastIndexedOrdinal } from "@magic-context/core/features/magic-context/message-index";
import {
	compileSurfaceCondition,
	conditionCompileReplySuffix,
	conditionCompileStorageFields,
} from "@magic-context/core/features/magic-context/smart-notes/condition-compiler";
import { wakePlaneStatus } from "@magic-context/core/features/magic-context/smart-notes/wake-plane";
import type {
	ContextDatabase,
	UpdateNoteOptions,
} from "@magic-context/core/features/magic-context/storage";
import {
	addNote,
	dismissNote,
	getNotes,
	type Note,
	type NoteStatus,
	setNoteLastReadAt,
	updateNote,
} from "@magic-context/core/features/magic-context/storage";
import { CTX_NOTE_DESCRIPTION } from "@magic-context/core/tools/ctx-note/constants";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const FILTER_VALUES = [
	"active",
	"pending",
	"ready",
	"dismissed",
	"all",
] as const;
type CtxNoteReadFilter = (typeof FILTER_VALUES)[number];

const ParamsSchema = Type.Object(
	{
		action: Type.Optional(
			Type.Union(
				[
					Type.Literal("write"),
					Type.Literal("read"),
					Type.Literal("dismiss"),
					Type.Literal("update"),
				],
				{
					description:
						"Operation to perform. Defaults to 'write' when content is provided, otherwise 'read'.",
				},
			),
		),
		content: Type.Optional(
			Type.String({
				description: "Note text to store when action is 'write'.",
			}),
		),
		surface_condition: Type.Optional(
			Type.String({
				description:
					"Externally verifiable condition for smart notes. A background checker verifies it using ONLY outside signals (GitHub state via gh, files on disk, git history, web) — it cannot see this conversation. Use for PR/issue state, release tags, file contents, workflow runs. NOT for 'when the user mentions X' / 'when we revisit Y' — write a regular note instead.",
			}),
		),
		note_id: Type.Optional(
			Type.Number({
				description: "Note ID (required for 'dismiss' and 'update' actions).",
			}),
		),
		filter: Type.Optional(
			Type.Union(
				FILTER_VALUES.map((value) => Type.Literal(value)),
				{
					description:
						"Optional read filter. Defaults to active session notes + ready smart notes. Use 'all' to inspect every status or 'pending' to inspect unsurfaced smart notes.",
				},
			),
		),
		limit: Type.Optional(
			Type.Number({
				description:
					"Max notes per section for read, newest first (default: 25)",
			}),
		),
		offset: Type.Optional(
			Type.Number({
				description:
					"Skip this many newest notes for read — page older ones (default: 0)",
			}),
		),
	},
	{ additionalProperties: true },
);

type CtxNoteParams = Static<typeof ParamsSchema>;

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function err(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
}

/** The tool records the live-tail message ordinal so `ctx_expand` can trace the note to its source conversation.
 *  packages/plugin/src/tools/ctx-note/tools.ts. */
function captureAnchorOrdinal(
	db: ContextDatabase,
	sessionId: string,
): number | null {
	try {
		const ordinal = getLastIndexedOrdinal(db, sessionId);
		return ordinal > 0 ? ordinal : null;
	} catch {
		return null;
	}
}

function anchorSuffix(note: Note): string {
	return note.anchorOrdinal !== null ? ` ↳ @msg ${note.anchorOrdinal}` : "";
}

function formatNoteLine(note: Note): string {
	if (note.type === "smart") {
		const conditionLine =
			note.status === "ready"
				? (note.readyReason ?? note.surfaceCondition ?? "Condition satisfied")
				: (note.surfaceCondition ?? "No condition recorded");
		const statusSuffix = note.status === "active" ? "" : ` (${note.status})`;
		return `- **#${note.id}**${statusSuffix}: ${note.content}${anchorSuffix(note)}\n  *Condition*: ${conditionLine}`;
	}
	const statusSuffix = note.status === "active" ? "" : ` (${note.status})`;
	return `- **#${note.id}**${statusSuffix}: ${note.content}${anchorSuffix(note)}`;
}

const DISMISS_FOOTER =
	'\n\nTo dismiss a stale note: ctx_note(action="dismiss", note_id=N)';

/**
 * */
const DEFAULT_READ_LIMIT = 25;

function paginateNewestFirst(
	notes: Note[],
	limit: number,
	offset: number,
): { page: Note[]; total: number; footer: string | null } {
	const total = notes.length;
	const newestFirst = [...notes].reverse();
	const page = newestFirst.slice(offset, offset + limit);
	const remaining = total - offset - page.length;
	const footer =
		remaining > 0
			? `Showing ${page.length} of ${total} (newest first) — ${remaining} older: ctx_note(action="read", offset=${offset + page.length})`
			: null;
	return { page, total, footer };
}

export interface CtxNoteToolDeps {
	db: ContextDatabase;
	/**
	 * When the dreamer is disabled, existing smart notes remain `pending` with no surfacing path.
	 *  evaluator. */
	dreamerEnabled?: boolean;
	/** The tool resolves dreamer enablement at each call because `/cd` can select a project with different configuration.
	 *  smart-note support. */
	resolveDreamerEnabled?: (ctx: { cwd: string }) => boolean | undefined;
	/** The resolver permits the home directory only when user-level configuration enables it. */
	resolveProjectIdentity?: (directory: string) => string | undefined;
}

export function createCtxNoteTool(
	deps: CtxNoteToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	const resolveProject =
		deps.resolveProjectIdentity ?? resolveProjectIdentityForSession;
	return {
		name: "ctx_note",
		label: "Magic Context: Notes",
		description: CTX_NOTE_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(_toolCallId, params: CtxNoteParams, _signal, _onUpdate, ctx) {
			params = unwrapImitatedReducedArgs(params, ["action", "content"], {
				action: {
					type: "enum",
					values: ["write", "read", "dismiss", "update"],
				},
				content: "string",
				surface_condition: "string",
				note_id: "number",
				filter: { type: "enum", values: FILTER_VALUES },
				limit: "number",
				offset: "number",
			});
			const sessionId = ctx.sessionManager.getSessionId();
			const dreamerEnabled =
				deps.resolveDreamerEnabled?.(ctx) ?? deps.dreamerEnabled;
			// `content` signals a write only when non-empty.
			const action =
				params.action ?? (params.content?.trim() ? "write" : "read");

			if (action === "write") {
				const content = params.content?.trim();
				if (!content)
					return err("Error: 'content' is required when action is 'write'.");

				// The write path anchors the note to the live conversation tail for tracing through `ctx_expand`.
				// `anchorOrdinal` lets `ctx_expand` trace the note to the conversation tail.
				const anchorOrdinal = captureAnchorOrdinal(deps.db, sessionId);

				const surfaceCondition = params.surface_condition?.trim();
				if (surfaceCondition) {
					if ((await wakePlaneStatus()) === "present") {
						const note = addNote(deps.db, "session", {
							sessionId,
							content,
							anchorOrdinal,
						});
						return ok(
							`Saved session note #${note.id}.\nwake plane active — create a scheduled wake instead; stored as a plain note.`,
						);
					}
					if (dreamerEnabled !== true) {
						return err(
							"Error: Smart notes require dreamer to be enabled. Enable dreamer in magic-context.jsonc to use surface_condition.",
						);
					}
					const projectIdentity = resolveProject(ctx.cwd);
					if (!projectIdentity) {
						return err(
							"Error: Could not resolve project identity for smart note.",
						);
					}
					const compilation = await compileSurfaceCondition(surfaceCondition, {
						projectPath: ctx.cwd,
					});
					const note = addNote(deps.db, "smart", {
						content,
						sessionId,
						projectPath: projectIdentity,
						surfaceCondition,
						anchorOrdinal,
						...conditionCompileStorageFields(compilation),
					});
					return ok(
						`Created smart note #${note.id}. Dreamer will evaluate the condition during nightly runs:\n- Content: ${content}\n- Condition: ${surfaceCondition}${conditionCompileReplySuffix(compilation)}`,
					);
				}

				const note = addNote(deps.db, "session", {
					sessionId,
					content,
					anchorOrdinal,
				});
				return ok(`Saved session note #${note.id}.`);
			}

			if (action === "dismiss") {
				if (typeof params.note_id !== "number") {
					return err("Error: 'note_id' is required when action is 'dismiss'.");
				}
				const projectIdentity = resolveProject(ctx.cwd);
				if (!projectIdentity) {
					return err(
						"Error: Could not resolve project identity for note dismiss.",
					);
				}
				const dismissed = dismissNote(deps.db, params.note_id, {
					projectPath: projectIdentity,
					sessionId,
				});
				return dismissed
					? ok(`Note #${params.note_id} dismissed.`)
					: err(
							`Error: Note #${params.note_id} not found in your session/project or already dismissed.`,
						);
			}

			if (action === "update") {
				if (typeof params.note_id !== "number") {
					return err("Error: 'note_id' is required when action is 'update'.");
				}
				const updates: UpdateNoteOptions = {};
				if (params.content?.trim()) updates.content = params.content.trim();
				let compilation:
					| Awaited<ReturnType<typeof compileSurfaceCondition>>
					| undefined;
				if (params.surface_condition?.trim()) {
					const surfaceCondition = params.surface_condition.trim();
					updates.surfaceCondition = surfaceCondition;
					compilation = await compileSurfaceCondition(surfaceCondition, {
						projectPath: ctx.cwd,
					});
					Object.assign(updates, conditionCompileStorageFields(compilation));
				}
				if (!updates.content && !updates.surfaceCondition) {
					return err(
						"Error: Provide 'content' and/or 'surface_condition' to update.",
					);
				}
				const projectIdentity = resolveProject(ctx.cwd);
				if (!projectIdentity) {
					return err(
						"Error: Could not resolve project identity for note update.",
					);
				}
				const updated = updateNote(deps.db, params.note_id, updates, {
					projectPath: projectIdentity,
					sessionId,
				});
				if (!updated) {
					return err(
						`Error: Note #${params.note_id} not found in your session/project.`,
					);
				}
				const parts: string[] = [];
				if (updates.content) parts.push(`content: ${updates.content}`);
				if (updates.surfaceCondition)
					parts.push(`condition: ${updates.surfaceCondition}`);
				return ok(
					`Updated note #${params.note_id}\n- ${parts.join("\n- ")}${compilation ? conditionCompileReplySuffix(compilation) : ""}`,
				);
			}

			// The default mixed view requires `undefined`; coercing it to `"active"` changes the result set.
			// The default mixed view requires `undefined`; coercing it to `"active"` changes the result set.
			// Undefined selects active session notes and ready smart notes; "active" selects all active notes.
			// Undefined selects active session notes and ready smart notes; "active" selects all active notes.
			// Undefined selects active session notes and ready smart notes; "active" selects all active notes.
			// Undefined selects active session notes and ready smart notes; "active" selects all active notes.
			// Undefined selects active session notes and ready smart notes; "active" selects all active notes.
			const limit =
				typeof params.limit === "number" && params.limit > 0
					? Math.floor(params.limit)
					: DEFAULT_READ_LIMIT;
			const offset =
				typeof params.offset === "number" && params.offset > 0
					? Math.floor(params.offset)
					: 0;
			const sections = readNotes({
				db: deps.db,
				sessionId,
				cwd: ctx.cwd,
				resolveProjectIdentity: resolveProject,
				filter: params.filter,
				limit,
				offset,
			});

			try {
				setNoteLastReadAt(deps.db, sessionId);
			} catch {
				// The watermark is advisory and does not determine correctness.
			}

			if (sections.length === 0) {
				return ok("## Notes\n\nNo session notes or smart notes.");
			}

			const body = sections.join("\n\n");
			const anchorHint = body.includes("↳ @msg ")
				? "\n\n↳ @msg N marks the conversation tail when a note was written. To see what led to it: ctx_expand(start=N-x, end=N) (pick x for how far back to look)."
				: "";
			return ok(`${body}${anchorHint}${DISMISS_FOOTER}`);
		},
	};
}

/**
 *
 * An explicit "active" filter includes active smart notes that are not ready.
 * An explicit "active" filter includes active smart notes that are not ready.
 *
 */
function readNotes(args: {
	db: ContextDatabase;
	sessionId: string;
	cwd: string;
	resolveProjectIdentity: (directory: string) => string | undefined;
	filter: CtxNoteReadFilter | undefined;
	limit: number;
	offset: number;
}): string[] {
	const projectIdentity = args.resolveProjectIdentity(args.cwd);

	if (args.filter === undefined) {
		const sessionNotes = getNotes(args.db, {
			sessionId: args.sessionId,
			type: "session",
			status: "active",
		});
		const readySmartNotes = projectIdentity
			? getNotes(args.db, {
					projectPath: projectIdentity,
					type: "smart",
					status: "ready",
				})
			: [];
		const sections: string[] = [];
		if (sessionNotes.length > 0) {
			const { page, footer } = paginateNewestFirst(
				sessionNotes,
				args.limit,
				args.offset,
			);
			const lines = page.map(formatNoteLine).join("\n");
			sections.push(
				`## Session Notes\n\n${lines}${footer ? `\n\n${footer}` : ""}`,
			);
		}
		if (readySmartNotes.length > 0) {
			sections.push(
				`## 🔔 Ready Smart Notes\n\n${readySmartNotes.map(formatNoteLine).join("\n\n")}`,
			);
		}
		return sections;
	}

	const statusByFilter: Record<CtxNoteReadFilter, NoteStatus | NoteStatus[]> = {
		active: "active",
		all: ["active", "pending", "ready", "dismissed"],
		dismissed: "dismissed",
		pending: "pending",
		ready: "ready",
	};
	const status = statusByFilter[args.filter];

	const sessionNotes = getNotes(args.db, {
		sessionId: args.sessionId,
		type: "session",
		status,
	});
	const smartNotes = projectIdentity
		? getNotes(args.db, {
				projectPath: projectIdentity,
				type: "smart",
				status,
			})
		: [];

	const sections: string[] = [];
	if (sessionNotes.length > 0) {
		const { page, footer } = paginateNewestFirst(
			sessionNotes,
			args.limit,
			args.offset,
		);
		const lines = page.map(formatNoteLine).join("\n");
		sections.push(
			`## Session Notes\n\n${lines}${footer ? `\n\n${footer}` : ""}`,
		);
	}
	if (smartNotes.length > 0) {
		const { page, footer } = paginateNewestFirst(
			smartNotes,
			args.limit,
			args.offset,
		);
		const lines = page.map(formatNoteLine).join("\n\n");
		sections.push(`## Smart Notes\n\n${lines}${footer ? `\n\n${footer}` : ""}`);
	}
	return sections;
}
