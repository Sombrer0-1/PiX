/**
 * Todo RPC (R3)
 *
 * Wraps the renderer's todo IPC surface (preload sendTodoCommand / onTodoEvent)
 * into a small transport, mirroring the usePlanRpc singleton-client pattern.
 * The todo store consumes this transport so the preload API stays behind one
 * seam; components normally go through the store instead of calling this
 * composable directly.
 */

import type { PixApi } from "../../main/preload";
import type { PixCommandResult } from "@shared/types.js";
import type { TodoCommand, TodoEvent, TodoSnapshot } from "@shared/todo-types.js";

/** Minimal todo IPC surface the todo store needs over the preload pixApi. */
export interface TodoTransport {
	sendTodoCommand: (command: TodoCommand) => Promise<PixCommandResult<TodoSnapshot>>;
	onTodoEvent: (callback: (event: TodoEvent) => void) => () => void;
}

function api(): PixApi {
	if (!window.pixApi) {
		throw new Error("PiX 预加载 API 不可用。");
	}
	return window.pixApi;
}

export function createTodoTransport(): TodoTransport {
	return {
		sendTodoCommand: (command) => api().sendTodoCommand(command),
		onTodoEvent: (callback) => api().onTodoEvent(callback),
	};
}

const singleTodoTransport = createTodoTransport();

export function useTodoRpc(): TodoTransport {
	return singleTodoTransport;
}
