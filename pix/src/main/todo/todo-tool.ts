/**
 * Session todo SDK custom tool (R3, SDD §3.3).
 *
 * todo_write: the model submits the COMPLETE todo list every call (full
 * replacement, CC TodoWrite semantics). The controller is the single writer of
 * record; the renderer GUI is read-only. Business failures (invalid items,
 * over-limit lists, controller rejection) return ordinary AgentToolResult
 * failure text - nothing here throws for a business failure.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TODO_MAX_ITEMS, isTodoItem, type TodoItem } from "../../shared/todo-types.js";
import type { TodoController } from "./todo-controller.js";

export const TODO_TOOL_NAME = "todo_write";

/** TypeBox 参数 schema：结构约束（类型 + 枚举 + 长度），与 CC 的 TodoWrite 同款。 */
const TodoParamsSchema = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1 }),
			status: StringEnum(["pending", "in_progress", "completed"] as const),
			activeForm: Type.Optional(Type.String({ minLength: 1 })),
		}),
		{ minItems: 0, maxItems: TODO_MAX_ITEMS },
	),
});

/** CC 同款固定成功文案：不描述清单内容，只引导持续使用。 */
const TODO_WRITE_SUCCESS_TEXT =
	"Todo list updated. Continue using the todo list to track progress; mark items completed as you finish them.";

const TODO_WRITE_DESCRIPTION = [
	"Send the full todo list each time. An empty list clears it.",
	"Mark an item in_progress before starting it. Keep at most one item in progress. Mark an item completed when its work and required checks are done. The list clears when all items are completed.",
	"Add newly needed items and remove items that no longer apply.",
	'Use an action for content ("Run tests") and an ongoing action for activeForm ("Running tests").',
].join(" ");

function textContent(text: string): TextContent {
	return { type: "text", text };
}

/** 入参归一化失败文案（结构化失败，不 throw）。 */
function rejectionText(reason: string): string {
	return `Todo list rejected: ${reason} Resend the complete list.`;
}

/** 校验并收窄入参（isTodoItem 逐条 + 条数上限），违规返回 null。 */
function normalizeTodos(todos: TodoItem[]): TodoItem[] | null {
	if (todos.length > TODO_MAX_ITEMS) {
		return null;
	}
	for (const item of todos) {
		if (!isTodoItem(item)) {
			return null;
		}
	}
	return todos;
}

/**
 * Create the todo_write ToolDefinition bound to the owning controller.
 */
export function createTodoWriteTool(controller: TodoController): ToolDefinition<typeof TodoParamsSchema, undefined> {
	return {
		name: TODO_TOOL_NAME,
		label: "Update Todo List",
		description: TODO_WRITE_DESCRIPTION,
		promptSnippet: "Track multi-step work with a session todo list.",
		promptGuidelines: ["Use todo_write before starting work with three or more steps, multiple files, or ordered subtasks."],
		parameters: TodoParamsSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
			const todos = normalizeTodos(params.todos);
			if (todos === null) {
				const reason =
					params.todos.length > TODO_MAX_ITEMS
						? `the list is limited to ${TODO_MAX_ITEMS} items (got ${params.todos.length}).`
						: "every item needs a non-empty content, a status of pending/in_progress/completed, and (when present) a non-empty activeForm.";
				return { content: [textContent(rejectionText(reason))], details: undefined };
			}
			try {
				controller.write(todos);
			} catch (err: unknown) {
				return {
					content: [textContent(rejectionText(err instanceof Error ? `${err.message}.` : "internal rejection."))],
					details: undefined,
				};
			}
			return { content: [textContent(TODO_WRITE_SUCCESS_TEXT)], details: undefined };
		},
	};
}
