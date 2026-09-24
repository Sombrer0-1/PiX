/**
 * Plain-data contract for the session todo list (R3, SDD §3.3).
 *
 * Shared by main (todo/todo-controller, todo/todo-tool, ipc-todo-adapters,
 * preload) and renderer (todo-store, TodoCard), so this is a leaf module: no
 * imports from other shared files, every value here survives structuredClone /
 * JSON round-trips and the renderer can import it directly. Import convention
 * (review-verified): main/preload use the relative path "../shared/todo-types.js";
 * renderer uses the "@shared/todo-types.js" alias.
 */

/** 单个会话清单的条目数上限（工具 schema 与 controller 校验共用）。 */
export const TODO_MAX_ITEMS = 50;

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	/** 祈使句短句（"Run tests"）。 */
	content: string;
	status: TodoStatus;
	/** 进行时文案（"Running tests"）；进行中行展示用。 */
	activeForm?: string;
}

export interface TodoSnapshot {
	sessionId: string;
	items: TodoItem[];
	updatedAt: number;
}

export type TodoEvent = { type: "todo_state"; snapshot: TodoSnapshot };

export type TodoCommand = { type: "get_snapshot" };

const VALID_TODO_STATUSES = new Set<string>(["pending", "in_progress", "completed"]);

/** 结构守卫：todo-command IPC 入口过滤（对照 isPlanCommand 的防御口径）。 */
export function isTodoCommand(cmd: unknown): cmd is TodoCommand {
	if (typeof cmd !== "object" || cmd === null || !("type" in cmd)) return false;
	const type = (cmd as Record<string, unknown>).type;
	if (typeof type !== "string" || type !== "get_snapshot") return false;
	return true;
}

/** 结构守卫：controller.write 逐条校验（content/status/activeForm 形状）。 */
export function isTodoItem(v: unknown): v is TodoItem {
	if (typeof v !== "object" || v === null) return false;
	const item = v as Record<string, unknown>;
	if (typeof item.content !== "string" || item.content === "") return false;
	if (typeof item.status !== "string" || !VALID_TODO_STATUSES.has(item.status)) return false;
	if (item.activeForm !== undefined && (typeof item.activeForm !== "string" || item.activeForm === "")) {
		return false;
	}
	return true;
}
