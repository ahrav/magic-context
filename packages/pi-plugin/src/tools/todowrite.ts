/**
 *
 *
 *
 *
 * The `message_end` path in `index.ts` snapshots the tool arguments into `session_meta.last_todo_state`.
 *
 *
 * ```text
 * packages/pi-plugin/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
 * packages/plugin/src/hooks/magic-context/todo-view.ts
 * ```
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	TITLE_DONE_STATUSES,
	TODO_PRIORITIES,
	TODO_STATUSES,
} from "@magic-context/core/hooks/magic-context/todo-view";
import { type Static, Type } from "typebox";
import {
	renderTodowriteCall,
	renderTodowriteResult,
	TODO_TOOL_NAME,
} from "./todo-view-pi";

const TodoItem = Type.Object({
	content: Type.String({ description: "Brief description of the task" }),
	status: Type.Union(TODO_STATUSES.map((v) => Type.Literal(v))),
	priority: Type.Optional(
		Type.Union(TODO_PRIORITIES.map((v) => Type.Literal(v))),
	),
	id: Type.Optional(
		Type.String({ description: "Optional stable id for the todo" }),
	),
});

const TodowriteParams = Type.Object({
	todos: Type.Array(TodoItem, {
		description:
			"Replace the current task list with this complete set of todos. Include every task you intend to track this turn — pending, in_progress, completed, or cancelled — because the list overwrites previous state.",
	}),
});

type TodowriteParamsT = Static<typeof TodowriteParams>;

const PROMPT_SNIPPET = "Manage a task list to track multi-step progress";

const PROMPT_GUIDELINES = [
	"Use `todowrite` for non-trivial work spanning 3+ steps, when the user gives you multiple tasks, or when you need to track progress across a verify/fix loop. Skip it for single-shot answers or trivial one-step work.",
	"Pass the COMPLETE updated todo list every time. This tool replaces the prior list rather than appending to it, so include pending, in_progress, completed, and cancelled tasks that should remain visible.",
	"When starting a task, mark exactly one todo `in_progress` before doing the work. Mark items `completed` immediately when done; use `cancelled` only for work that is no longer needed.",
	"Never mark a todo completed if verification is failing, implementation is partial, or an unresolved blocker remains. Keep it `in_progress` and add or update a todo for the blocker instead.",
];

export function createTodowriteTool(): ToolDefinition<typeof TodowriteParams> {
	return {
		name: TODO_TOOL_NAME,
		label: "Todos",
		description: "Manage the session task list.",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: TodowriteParams,
		async execute(
			_toolCallId,
			params: TodowriteParamsT,
			_signal,
			_onUpdate,
			_ctx,
		) {
			const todos = params.todos ?? [];
			// `message_end` captures the tool arguments in `session_meta.last_todo_state`.
			const active = todos.filter(
				(todo) => !TITLE_DONE_STATUSES.has(todo.status),
			).length;
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(todos, null, 2),
					},
				],
				details: {
					todos,
					title: `${active} todos`,
					truncated: false,
				},
			};
		},
		renderCall(args, theme, context) {
			return renderTodowriteCall(args, theme, context);
		},
		renderResult(result, _opts, theme, context) {
			return renderTodowriteResult(result, theme, context);
		},
	};
}
