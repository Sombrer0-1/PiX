/**
 * Todo IPC adapters (R3, SDD §3.3).
 *
 * Pure registration/dispatch for the todo-command IPC surface, cloned from
 * ipc-plan-adapters.ts so todo-ipc.test.ts can register and exercise the REAL
 * production handlers in pure Node without loading the Electron runtime.
 * Production registerIpcHandlers / setupEventForwarding pass the real ipcMain
 * and the current window's webContents; the test passes a fake adapter. The
 * IpcMainLike / WebContentsLike adapter types live in ipc-plan-adapters.ts and
 * are reused here.
 */

import type { IpcMainLike, WebContentsLike } from "./ipc-plan-adapters.js";
import type { PixCommandResult } from "../shared/types.js";
import { isTodoCommand, type TodoCommand, type TodoSnapshot } from "../shared/todo-types.js";
import type { TodoController, TodoControllerEvent } from "./todo/todo-controller.js";

// 结构守卫已在 todo-types（叶子模块）导出，这里 re-export 保持与 plan/workflow
// 适配器“isXxxCommand 就近可得”的导入习惯。
export { isTodoCommand };

export async function executeTodoCommand(
	controller: TodoController,
	cmd: TodoCommand,
): Promise<PixCommandResult<TodoSnapshot | undefined>> {
	switch (cmd.type) {
		case "get_snapshot":
			return { success: true, data: controller.getSnapshot() };
		default:
			return { success: false, code: "unknown_todo_command", error: `Unknown todo command type: ${(cmd as { type: string }).type}` };
	}
}

/**
 * Register the todo-command handler on an injectable ipcMain adapter.
 * Production passes the real ipcMain; todo-ipc.test.ts passes a fake adapter.
 */
export function registerTodoIpcHandlers(ipc: IpcMainLike, getTodoController: () => TodoController | null): void {
	ipc.handle("todo-command", async (_event: unknown, command: unknown) => {
		// Re-attach the todo-event forwarding subscription to the current
		// controller before every command; a session switch replaced it since the
		// previous command (see subscribeTodoEventForwarding).
		todoEventForwardingSync?.();
		if (!isTodoCommand(command)) {
			return { success: false, code: "invalid_todo_command", error: `Invalid todo command: ${JSON.stringify(command)}` };
		}
		const controller = getTodoController();
		if (!controller) {
			return { success: false, code: "todo_unavailable", error: "Todo controller is not available (no active session)." };
		}
		try {
			return await executeTodoCommand(controller, command);
		} catch (err: unknown) {
			return { success: false, code: "todo_command_failed", error: err instanceof Error ? err.message : String(err) };
		}
	});
}

/**
 * Re-sync hook invoked by registerTodoIpcHandlers before every todo command
 * and by the session-switching / runtime start-stop command paths after they
 * replace the controller instance. Each solo runtime generation owns its own
 * TodoController (a session switch replaces the instance), and forwarding is
 * subscribed at setup time - before any session exists - so the subscription
 * must be re-attached to the current controller at command time, or a
 * replacement controller's first events would have no listener. The re-sync
 * also pushes a fresh todo_state snapshot when it detects a controller change,
 * so the renderer mirror converges without waiting for the next todo command.
 */
let todoEventForwardingSync: (() => void) | null = null;

/** Invoke the module-level re-sync hook (no-op when no forwarding is subscribed). */
export function resyncTodoEventForwarding(): void {
	todoEventForwardingSync?.();
}

/**
 * Forward TodoController events to the renderer on the todo-event channel.
 * Returns an unsubscribe function. The webContents getter is re-evaluated per
 * event so forwarding survives window close/reopen cycles; the controller
 * subscription is re-synced by registerTodoIpcHandlers before every command.
 */
export function subscribeTodoEventForwarding(
	getWebContents: () => WebContentsLike | null,
	getTodoController: () => TodoController | null,
): () => void {
	let current: TodoController | null = null;
	let currentUnsubscribe: (() => void) | null = null;
	let disposed = false;

	function sync(): void {
		if (disposed) return;
		const next = getTodoController();
		if (next === current) return;
		currentUnsubscribe?.();
		currentUnsubscribe = null;
		current = next;
		if (next) {
			currentUnsubscribe = next.onEvent((event) => {
				if (!disposed) {
					forward(event);
				}
			});
			// A controller replacement (e.g. session switch) means the replacement's
			// first todo_state events were emitted before the new subscription
			// existed and were dropped. Push the current snapshot immediately so the
			// renderer mirror converges to the new controller's state (whole-state
			// replace, so a re-push over an already-current mirror is a no-op).
			forward({ type: "todo_state", snapshot: next.getSnapshot() });
		}
	}

	function forward(event: TodoControllerEvent): void {
		const webContents = getWebContents();
		if (webContents) {
			webContents.send("todo-event", event);
		}
	}

	sync();
	todoEventForwardingSync = sync;

	return () => {
		disposed = true;
		currentUnsubscribe?.();
		currentUnsubscribe = null;
		current = null;
		if (todoEventForwardingSync === sync) {
			todoEventForwardingSync = null;
		}
	};
}
