import { type ToolDefinition, tool } from "@opencode-ai/plugin";

import { getAuthorityManagedMarker } from "../../features/magic-context/context-authority";
import { getLastIndexedOrdinal } from "../../features/magic-context/message-index";
import {
    compileSurfaceCondition,
    conditionCompileReplySuffix,
    conditionCompileStorageFields,
} from "../../features/magic-context/smart-notes/condition-compiler";
import { wakePlaneStatus } from "../../features/magic-context/smart-notes/wake-plane";
import {
    addNote,
    dismissNote,
    getNotes,
    getReadySmartNotes,
    getSessionNotes,
    type Note,
    setNoteLastReadAt,
    type UpdateNoteOptions,
    updateNote,
} from "../../features/magic-context/storage";
import type { RustNoteToolRequest, RustToolBackends } from "../../plugin/rust-tool-backends";
import {
    isRustAuthorityDrainingError,
    toolCallIdFromContext,
} from "../../plugin/rust-tool-backends";
import type { Database } from "../../shared/sqlite";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_NOTE_DESCRIPTION } from "./constants";
import { anchorSuffix, DEFAULT_READ_LIMIT, paginateNewestFirst } from "./pagination";
import type { CtxNoteArgs, CtxNoteReadFilter } from "./types";

export { CTX_NOTE_LIGHT_DESCRIPTION } from "../light-descriptions";

export interface CtxNoteToolDeps {
    db: Database;
    dreamerEnabled?: boolean;
    /**
     * Resolve the project identity for the session's directory at call time.
     * See CtxMemoryToolDeps.resolveProjectPath for why this is a function.
     * Optional — when undefined, smart-note creation is rejected with an
     * explanatory error.
     */
    resolveProjectPath?: (directory: string) => string | undefined;
    rustToolBackends?: RustToolBackends;
}

/** Capture the live-tail message ordinal so a note can be traced back to the
 *  conversation that produced it. Best-effort: returns null when there are no
 *  indexed messages yet (ordinal 0) or the lookup fails, in which case the note
 *  is stored without an anchor. */
function captureAnchorOrdinal(db: Database, sessionId: string): number | null {
    try {
        const ordinal = getLastIndexedOrdinal(db, sessionId);
        return ordinal > 0 ? ordinal : null;
    } catch {
        return null;
    }
}

function formatNoteLine(note: Note): string {
    const statusSuffix = note.status === "active" ? "" : ` (${note.status})`;

    if (note.type === "session") {
        return `- **#${note.id}**${statusSuffix}: ${note.content}${anchorSuffix(note)}`;
    }

    const conditionText =
        note.status === "ready"
            ? (note.readyReason ?? note.surfaceCondition ?? "Condition satisfied")
            : (note.surfaceCondition ?? "No condition recorded");
    const conditionLabel = note.status === "ready" ? "Condition met" : "Condition";

    return `- **#${note.id}**${statusSuffix}: ${note.content}${anchorSuffix(note)}\n  ${conditionLabel}: ${conditionText}`;
}

const DISMISS_FOOTER = '\n\nTo dismiss a stale note: ctx_note(action="dismiss", note_id=N)';

function buildReadSections(args: {
    db: Database;
    sessionId: string;
    projectIdentity?: string;
    filter?: CtxNoteReadFilter;
    limit: number;
    offset: number;
}): string[] {
    if (args.filter === undefined) {
        const sessionNotes = getSessionNotes(args.db, args.sessionId);
        const readySmartNotes = args.projectIdentity
            ? getReadySmartNotes(args.db, args.projectIdentity)
            : [];
        const sections: string[] = [];

        if (sessionNotes.length > 0) {
            const { page, footer } = paginateNewestFirst(sessionNotes, args.limit, args.offset);
            const lines = page.map((note) => formatNoteLine(note)).join("\n");
            sections.push(`## Session Notes\n\n${lines}${footer ? `\n\n${footer}` : ""}`);
        }

        if (readySmartNotes.length > 0) {
            const { page, footer } = paginateNewestFirst(readySmartNotes, args.limit, args.offset);
            sections.push(
                `## 🔔 Ready Smart Notes\n\n${page
                    .map((note) => formatNoteLine(note))
                    .join("\n\n")}${footer ? `\n\n${footer}` : ""}`,
            );
        }

        return sections;
    }

    const statusByFilter: Record<
        CtxNoteReadFilter,
        | "active"
        | "pending"
        | "ready"
        | "dismissed"
        | Array<"active" | "pending" | "ready" | "dismissed">
    > = {
        active: "active",
        all: ["active", "pending", "ready", "dismissed"],
        dismissed: "dismissed",
        pending: "pending",
        ready: "ready",
    };

    const sessionNotes = getNotes(args.db, {
        sessionId: args.sessionId,
        type: "session",
        status: statusByFilter[args.filter],
    });
    const smartNotes = args.projectIdentity
        ? getNotes(args.db, {
              projectPath: args.projectIdentity,
              type: "smart",
              status: statusByFilter[args.filter],
          })
        : [];

    const sections: string[] = [];

    if (sessionNotes.length > 0) {
        const { page, footer } = paginateNewestFirst(sessionNotes, args.limit, args.offset);
        const lines = page.map((note) => formatNoteLine(note)).join("\n");
        sections.push(`## Session Notes\n\n${lines}${footer ? `\n\n${footer}` : ""}`);
    }

    if (smartNotes.length > 0) {
        const { page, footer } = paginateNewestFirst(smartNotes, args.limit, args.offset);
        const lines = page.map((note) => formatNoteLine(note)).join("\n\n");
        sections.push(`## Smart Notes\n\n${lines}${footer ? `\n\n${footer}` : ""}`);
    }

    return sections;
}

function noteAuthorityRefusal(args: CtxNoteArgs, action: RustNoteToolRequest["action"]): string {
    const readiness = "Rust notes authority is not ready.";
    if ((action === "write" || action === "update") && typeof args.content === "string") {
        return `Error: ${readiness} Write REFUSED and NOT saved; RESEND after authority is ready.\nContent to resend:\n${args.content}`;
    }
    return `Error: ${readiness} Request REFUSED and NOT applied; RESEND after authority is ready.`;
}

function moduleNoteText(
    response: unknown,
    args: CtxNoteArgs,
    action: RustNoteToolRequest["action"],
): string | null {
    let value = response;
    if (value !== null && typeof value === "object" && "result" in value) {
        value = (value as { result?: unknown }).result;
    }
    if (isRustAuthorityDrainingError(value)) {
        return noteAuthorityRefusal(args, action);
    }
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.ok === false || record.error || typeof record.message === "string") {
            const error = record.error;
            const message =
                typeof error === "string"
                    ? error
                    : error !== null && typeof error === "object" && "message" in error
                      ? String((error as { message?: unknown }).message)
                      : typeof record.message === "string"
                        ? record.message
                        : "module rejected ctx_note";
            return `Error: ${message}`;
        }
        const content = record.content;
        if (Array.isArray(content)) {
            const text = content.find(
                (item): item is { text: string } =>
                    item !== null &&
                    typeof item === "object" &&
                    typeof (item as { text?: unknown }).text === "string",
            )?.text;
            if (text) return text;
        }
    }
    return null;
}

const ctxNoteArgsShape = {
    action: tool.schema
        .enum(["write", "read", "dismiss", "update"])
        .optional()
        .describe(
            "Operation to perform. Defaults to 'write' when content is provided, otherwise 'read'.",
        ),
    content: tool.schema.string().optional().describe("Note text to store when action is 'write'."),
    surface_condition: tool.schema
        .string()
        .optional()
        .describe(
            "Externally verifiable condition for smart notes. A separate background agent (dreamer) checks this using gh CLI, web fetches, file reads, git, etc. — NOT your conversation history. Use only for things like GitHub PR/issue state, release tags, file contents, or workflow runs. DO NOT use for 'when the user mentions X' / 'when we revisit Y' / 'when relevant to current task' — dreamer has no access to session context. For session-relative reminders, omit this and write a regular note.",
        ),
    filter: tool.schema
        .enum(["all", "active", "pending", "ready", "dismissed"])
        .optional()
        .describe(
            "Optional read filter. Defaults to active session notes + ready smart notes. Use 'all' to inspect every status or 'pending' to inspect unsurfaced smart notes.",
        ),
    limit: tool.schema
        .number()
        .optional()
        .describe("Max notes per section for read, newest first (default: 25)"),
    offset: tool.schema
        .number()
        .optional()
        .describe("Skip this many newest notes for read — page older ones (default: 0)"),
    note_id: tool.schema
        .number()
        .optional()
        .describe("Note ID (required for 'dismiss' and 'update' actions)."),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxNoteArgsSchema = tool.schema.object(ctxNoteArgsShape).passthrough();

function createCtxNoteTool(deps: CtxNoteToolDeps): ToolDefinition {
    return tool({
        description: CTX_NOTE_DESCRIPTION,
        args: ctxNoteArgsShape,
        async execute(rawArgs: CtxNoteArgs, toolContext) {
            const parsedArgs = ctxNoteArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxNoteArgs;
            args = unwrapImitatedReducedArgs(args, ["action", "content"], {
                action: { type: "enum", values: ["write", "read", "dismiss", "update"] },
                content: "string",
                surface_condition: "string",
                filter: {
                    type: "enum",
                    values: ["all", "active", "pending", "ready", "dismissed"],
                },
                limit: "number",
                offset: "number",
                note_id: "number",
            });
            const sessionId = toolContext.sessionID;
            // Infer write only on NON-EMPTY content. GPT-family models fill every
            // optional param (content:"" for a read), so a bare `typeof === "string"`
            // check would mis-infer `write` and then reject the empty content.
            const action = args.action ?? (args.content?.trim() ? "write" : "read");
            const wakePlaneActive =
                action === "write" &&
                Boolean(args.surface_condition?.trim()) &&
                (await wakePlaneStatus()) === "present";
            const surfaceCondition = wakePlaneActive ? undefined : args.surface_condition?.trim();

            // Resolve the session's actual project from `toolContext.directory`
            // each call. OpenCode's top-level `ctx.directory` (the launch dir)
            // can differ from the session's working directory when the user
            // runs `opencode -s <id>` from outside the project.
            const projectIdentity = deps.resolveProjectPath?.(toolContext.directory);

            const marker = projectIdentity
                ? getAuthorityManagedMarker(deps.db, projectIdentity)
                : null;
            let notesAuthority: "TS" | "PREPARING" | "MODULE" | "DRAINING" | null = null;
            if (projectIdentity && deps.rustToolBackends?.authorityState) {
                try {
                    notesAuthority = await deps.rustToolBackends.authorityState({
                        projectPath: projectIdentity,
                        projectRoot: toolContext.directory,
                        domain: "notes",
                    });
                } catch (error) {
                    if (marker) {
                        return `Error: Rust notes authority is unavailable. ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
            }
            if (notesAuthority === "MODULE") {
                const rustNote = deps.rustToolBackends?.note;
                if (!rustNote || !projectIdentity) {
                    return "Error: Rust notes authority is active, but this module transport does not support ctx_note.";
                }
                const commandId = toolCallIdFromContext(toolContext);
                let compilation: Awaited<ReturnType<typeof compileSurfaceCondition>> | undefined;
                if ((action === "write" || action === "update") && surfaceCondition) {
                    if (
                        deps.rustToolBackends?.noteEvaluationAvailable?.(projectIdentity) === true
                    ) {
                        compilation = await compileSurfaceCondition(surfaceCondition, {
                            projectPath: toolContext.directory,
                        });
                    } else if (!commandId) {
                        return "Error: Smart-note evaluation is unavailable for this Rust-authority project; the note was not written.";
                    }
                    // An identified request goes through without compilation:
                    // the module replays a committed command's recorded
                    // response from its ledger and refuses a first-time
                    // mutation with this same message. Failing here would make
                    // a lost-response retry report the note as unwritten.
                }
                const request: RustNoteToolRequest = {
                    ...(commandId ? { commandId } : {}),
                    sessionId,
                    projectRoot: toolContext.directory,
                    projectPath: projectIdentity,
                    memoryProject: projectIdentity,
                    action,
                    content: args.content,
                    surfaceCondition,
                    ...(compilation ? conditionCompileStorageFields(compilation) : {}),
                    filter: args.filter,
                    limit: args.limit,
                    offset: args.offset,
                    noteId: args.note_id,
                };
                try {
                    const text = moduleNoteText(await rustNote(request), args, action);
                    if (text === null) {
                        return "Error: Rust module returned an invalid ctx_note response.";
                    }
                    if (text.startsWith("Error:")) return text;
                    if (wakePlaneActive) {
                        return `${text}\nwake plane active — create a scheduled wake instead; stored as a plain note.`;
                    }
                    if (compilation) return text + conditionCompileReplySuffix(compilation);
                    return text;
                } catch (error) {
                    if (isRustAuthorityDrainingError(error)) {
                        return noteAuthorityRefusal(args, action);
                    }
                    return `Error: Rust module ctx_note failed. ${error instanceof Error ? error.message : String(error)}`;
                }
            }
            if (marker || notesAuthority === "PREPARING" || notesAuthority === "DRAINING") {
                return noteAuthorityRefusal(args, action);
            }

            if (action === "write") {
                const content = args.content?.trim();
                if (!content) {
                    return "Error: 'content' is required when action is 'write'.";
                }

                // Anchor the note to the live conversation tail so it can be
                // traced back later. The agent reads this as the upper bound and
                // expands `anchorOrdinal - x .. anchorOrdinal` via ctx_expand at
                // its own discretion. Best-effort: 0 (no indexed messages yet)
                // stores null and the note simply renders without an anchor.
                const anchorOrdinal = captureAnchorOrdinal(deps.db, sessionId);

                // Smart note — project-scoped with condition evaluation by dreamer
                if (args.surface_condition?.trim()) {
                    if (wakePlaneActive) {
                        const note = addNote(deps.db, "session", {
                            sessionId,
                            content,
                            anchorOrdinal,
                        });
                        return `Saved session note #${note.id}.\nwake plane active — create a scheduled wake instead; stored as a plain note.`;
                    }
                    if (!deps.dreamerEnabled) {
                        return "Error: Smart notes require dreamer to be enabled. Enable dreamer in magic-context.jsonc to use surface_condition.";
                    }
                    if (!projectIdentity) {
                        return "Error: Could not resolve project identity for smart note.";
                    }
                    const smartSurfaceCondition = args.surface_condition.trim();
                    const compilation = await compileSurfaceCondition(smartSurfaceCondition, {
                        projectPath: toolContext.directory,
                    });
                    const note = addNote(deps.db, "smart", {
                        content,
                        projectPath: projectIdentity,
                        sessionId,
                        surfaceCondition: smartSurfaceCondition,
                        anchorOrdinal,
                        ...conditionCompileStorageFields(compilation),
                    });
                    return `Created smart note #${note.id}. Dreamer will evaluate the condition during nightly runs:\n- Content: ${content}\n- Condition: ${smartSurfaceCondition}${conditionCompileReplySuffix(compilation)}`;
                }

                // Simple session note
                const note = addNote(deps.db, "session", { sessionId, content, anchorOrdinal });
                return `Saved session note #${note.id}.`;
            }

            if (action === "dismiss") {
                const noteId = args.note_id;
                if (typeof noteId !== "number") {
                    return "Error: 'note_id' is required when action is 'dismiss'.";
                }
                if (!projectIdentity) {
                    return "Error: Could not resolve project identity for note dismiss.";
                }
                const dismissed = dismissNote(deps.db, noteId, {
                    projectPath: projectIdentity,
                    sessionId,
                });
                return dismissed
                    ? `Note #${noteId} dismissed.`
                    : `Error: Note #${noteId} not found in your session/project or already dismissed.`;
            }

            if (action === "update") {
                const noteId = args.note_id;
                if (typeof noteId !== "number") {
                    return "Error: 'note_id' is required when action is 'update'.";
                }
                const updates: UpdateNoteOptions = {};
                if (args.content?.trim()) updates.content = args.content.trim();
                let compilation: Awaited<ReturnType<typeof compileSurfaceCondition>> | undefined;
                if (args.surface_condition?.trim()) {
                    const surfaceCondition = args.surface_condition.trim();
                    updates.surfaceCondition = surfaceCondition;
                    compilation = await compileSurfaceCondition(surfaceCondition, {
                        projectPath: toolContext.directory,
                    });
                    Object.assign(updates, conditionCompileStorageFields(compilation));
                }

                if (!updates.content && !updates.surfaceCondition) {
                    return "Error: Provide 'content' and/or 'surface_condition' to update.";
                }
                if (!projectIdentity) {
                    return "Error: Could not resolve project identity for note update.";
                }
                const updated = updateNote(deps.db, noteId, updates, {
                    projectPath: projectIdentity,
                    sessionId,
                });
                if (!updated) {
                    return `Error: Note #${noteId} not found in your session/project or has no compatible fields to update.`;
                }
                const parts: string[] = [];
                if (updates.content) parts.push(`Content: ${updates.content}`);
                if (updates.surfaceCondition) parts.push(`Condition: ${updates.surfaceCondition}`);
                return `Updated note #${noteId}:\n${parts.join("\n")}${compilation ? conditionCompileReplySuffix(compilation) : ""}`;
            }

            const limit =
                typeof args.limit === "number" && args.limit > 0
                    ? Math.floor(args.limit)
                    : DEFAULT_READ_LIMIT;
            const offset =
                typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
            const sections = buildReadSections({
                db: deps.db,
                filter: args.filter,
                projectIdentity,
                sessionId,
                limit,
                offset,
            });

            // Record read watermark so note-nudger can suppress reminders
            // when the agent has already seen notes in recent context and no
            // new notes have been written since.
            try {
                setNoteLastReadAt(deps.db, sessionId);
            } catch {
                // Best-effort — the watermark is a suppression hint, not correctness.
            }

            if (sections.length === 0) {
                return "## Notes\n\nNo session notes or smart notes.";
            }

            const body = sections.join("\n\n");
            // Only surface the anchor hint when at least one note carries one,
            // so notes written before anchoring (or with no indexed tail) don't
            // advertise a capability their output doesn't show.
            const anchorHint = body.includes("↳ @msg ")
                ? "\n\n↳ @msg N marks the conversation tail when a note was written. To see what led to it: ctx_expand(start=N-x, end=N) (pick x for how far back to look)."
                : "";
            return body + anchorHint + DISMISS_FOOTER;
        },
    });
}

export function createCtxNoteTools(deps: CtxNoteToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_note: createCtxNoteTool(deps),
    };
}
