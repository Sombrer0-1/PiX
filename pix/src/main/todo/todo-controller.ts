/**
 * Session todo controller (R3, SDD §3.3).
 *
 * Per-solo-generation in-memory todo list, cloned from the Plan subsystem
 * topology: owned by SessionBridge (one instance per RuntimeGeneration), the
 * model is the single writer (todo_write tool full replacement), the renderer
 * is a read-only mirror fed by todo_state events + get_snapshot catch-up. No
 * persistence - a session switch/close replaces the generation and starts from
 * an empty list.
 */

import { TODO_MAX_ITEMS, isTodoItem, type TodoItem, type TodoSnapshot } from "../../shared/todo-types.js";

export type TodoControllerEvent = { type: "todo_state"; snapshot: TodoSnapshot };

export class TodoController {
	private readonly _getSessionId: () => string;
	private _items: TodoItem[] = [];
	private _listeners = new Set<(e: TodoControllerEvent) => void>();

	/**
	 * sessionId 惰性求值：构造点（_createSession planController 旁）parentSessionRef
	 * 尚为 null（createAgentSession 之后才赋值），与 PlanController 的 getSession
	 * 惰性 getter、runnerContext.getSessionId 同款。
	 */
	constructor(getSessionId: () => string) {
		this._getSessionId = getSessionId;
	}

	/**
	 * 全量替换（非增量）。防御性校验：逐条 isTodoItem、条数 ≤ TODO_MAX_ITEMS，
	 * 违规抛错（todo_write 工具在调用前已归一化并把任何拒绝转成结构化失败文案，
	 * 这里是未来其它调用方的最后一道防线）。全部 completed → 存 []（CC 同款：
	 * 清单随任务全部完成自动收尾）。每次写入后发射 todo_state。
	 */
	write(items: TodoItem[]): TodoSnapshot {
		if (!Array.isArray(items)) {
			throw new Error("todo items must be an array");
		}
		if (items.length > TODO_MAX_ITEMS) {
			throw new Error(`todo list exceeds the maximum of ${TODO_MAX_ITEMS} items`);
		}
		for (const item of items) {
			if (!isTodoItem(item)) {
				throw new Error("todo list contains an invalid item");
			}
		}
		const cleared = items.length > 0 && items.every((item) => item.status === "completed");
		this._items = cleared ? [] : structuredClone(items);
		const snapshot = this.getSnapshot();
		const event: TodoControllerEvent = { type: "todo_state", snapshot };
		for (const listener of this._listeners) {
			listener(event);
		}
		return snapshot;
	}

	/** 深拷贝快照（镜像侧绝不可持有内部数组）。 */
	getSnapshot(): TodoSnapshot {
		return {
			sessionId: this._getSessionId(),
			items: structuredClone(this._items),
			updatedAt: Date.now(),
		};
	}

	onEvent(listener: (e: TodoControllerEvent) => void): () => void {
		this._listeners.add(listener);
		return () => {
			this._listeners.delete(listener);
		};
	}

	/** 代际销毁收口：清 listeners（内存态本身随实例一起丢弃）。 */
	dispose(): void {
		this._listeners.clear();
	}
}
