/**
 * Todo store tests (R3, SDD §3.3).
 *
 * Acceptance: subscription (replace-on-resubscribe + get_snapshot catch-up),
 * todo_state whole-state replace semantics, the all-completed summary
 * retention (controller auto-clear keeps a visible "全部完成" state) and
 * clear(). The store talks to main only through window.pixApi
 * (sendTodoCommand / onTodoEvent), so the tests stub that surface in
 * happy-dom - no Electron runtime is loaded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { PixApi } from "../../main/preload";
import type { PixCommandResult } from "@shared/types.js";
import type { TodoEvent, TodoItem, TodoSnapshot } from "@shared/todo-types.js";
import { useTodoStore } from "../stores/todo-store";

// ============================================================================
// Fixtures
// ============================================================================

function makeItems(): TodoItem[] {
	return [
		{ content: "Inspect the module", status: "completed" },
		{ content: "Run tests", status: "in_progress", activeForm: "Running tests" },
		{ content: "Update docs", status: "pending" },
	];
}

function makeSnapshot(overrides?: Partial<TodoSnapshot>): TodoSnapshot {
	return {
		sessionId: "session-1",
		items: makeItems(),
		updatedAt: 3,
		...overrides,
	};
}

// ============================================================================
// Harness: stub window.pixApi
// ============================================================================

let sendTodoCommand: ReturnType<typeof vi.fn>;
let onTodoEvent: ReturnType<typeof vi.fn>;
let todoEventCallback: ((event: TodoEvent) => void) | null;
const eventUnsubscribers: Array<() => void> = [];

function installPixApiMock(): void {
	todoEventCallback = null;
	eventUnsubscribers.length = 0;
	sendTodoCommand = vi.fn().mockResolvedValue({ success: true });
	onTodoEvent = vi.fn((callback: (event: TodoEvent) => void) => {
		todoEventCallback = callback;
		const unsubscribe = vi.fn();
		eventUnsubscribers.push(unsubscribe);
		return unsubscribe;
	});
	window.pixApi = { sendTodoCommand, onTodoEvent } as unknown as PixApi;
}

/** Deliver a TodoEvent through the currently registered onTodoEvent callback. */
function emit(event: TodoEvent): void {
	todoEventCallback?.(event);
}

beforeEach(() => {
	setActivePinia(createPinia());
	installPixApiMock();
});

// ============================================================================
// Subscription
// ============================================================================

describe("subscription", () => {
	it("registers one event listener, then queries get_snapshot after it", async () => {
		const store = useTodoStore();
		const snapshot = makeSnapshot();
		sendTodoCommand.mockResolvedValue({ success: true, data: snapshot });

		const unsubscribe = store.subscribeToEvents();

		expect(onTodoEvent).toHaveBeenCalledTimes(1);
		expect(sendTodoCommand).toHaveBeenCalledWith({ type: "get_snapshot" });
		// Subscription must be installed before the snapshot query so a push
		// arriving early can never be overwritten by a stale snapshot result.
		expect(onTodoEvent.mock.invocationCallOrder[0]).toBeLessThan(sendTodoCommand.mock.invocationCallOrder[0]);

		await vi.waitFor(() => {
			expect(store.items).toHaveLength(3);
		});
		expect(store.updatedAt).toBe(3);
		expect(store.sessionId).toBe("session-1");

		unsubscribe();
		expect(eventUnsubscribers[0]).toHaveBeenCalled();
	});

	it("replaces the previous subscription on re-subscribe (remount)", () => {
		const store = useTodoStore();
		store.subscribeToEvents();
		store.subscribeToEvents();

		expect(onTodoEvent).toHaveBeenCalledTimes(2);
		expect(eventUnsubscribers[0]).toHaveBeenCalled();
		expect(eventUnsubscribers[1]).not.toHaveBeenCalled();

		// Events flow only through the live (second) subscription.
		emit({ type: "todo_state", snapshot: makeSnapshot({ updatedAt: 9 }) });
		expect(store.items).toHaveLength(3);
		expect(store.updatedAt).toBe(9);
	});

	it("does not touch the mirror when get_snapshot fails", async () => {
		const store = useTodoStore();
		store.subscribeToEvents();

		// Hydrate the mirror first (as a mounted card would) so the failure path
		// is exercised against real state, not the initial empty defaults.
		emit({ type: "todo_state", snapshot: makeSnapshot() });
		expect(store.items).toHaveLength(3);

		sendTodoCommand.mockResolvedValue({ success: false, code: "todo_unavailable", error: "No active session." });

		const result = await store.refreshSnapshot();

		expect(result).toBeNull();
		// The hydrated mirror must survive the failed refresh (returns null, no throw).
		expect(store.items).toHaveLength(3);
	});
});

// ============================================================================
// todo_state whole-state replace
// ============================================================================

describe("todo_state apply", () => {
	it("replaces the whole state (items, updatedAt, sessionId)", () => {
		const store = useTodoStore();
		store.subscribeToEvents();

		emit({ type: "todo_state", snapshot: makeSnapshot({ items: makeItems().slice(0, 1), sessionId: "session-2", updatedAt: 5 }) });
		expect(store.items).toHaveLength(1);
		expect(store.items[0].content).toBe("Inspect the module");
		expect(store.sessionId).toBe("session-2");
		expect(store.updatedAt).toBe(5);

		emit({ type: "todo_state", snapshot: makeSnapshot({ items: [], sessionId: "session-2", updatedAt: 6 }) });
		expect(store.items).toHaveLength(0);
		expect(store.updatedAt).toBe(6);
	});

	it("applies the same todo_state twice without duplicating state", () => {
		const store = useTodoStore();
		store.subscribeToEvents();

		const snapshot = makeSnapshot();
		emit({ type: "todo_state", snapshot });
		emit({ type: "todo_state", snapshot });

		expect(store.items).toEqual(makeItems());
		expect(store.completedCount).toBe(1);
	});

	it("hydrates the mirror from the get_snapshot response", async () => {
		const store = useTodoStore();
		const snapshot = makeSnapshot({ updatedAt: 42 });
		sendTodoCommand.mockResolvedValue({ success: true, data: snapshot });

		const result = await store.refreshSnapshot();

		expect(result).toEqual(snapshot);
		expect(sendTodoCommand).toHaveBeenCalledWith({ type: "get_snapshot" });
		expect(store.items).toHaveLength(3);
		expect(store.updatedAt).toBe(42);
	});

	it("a push arriving before the snapshot response is not overwritten by the stale response", async () => {
		const store = useTodoStore();
		const pending = defer<PixCommandResult<TodoSnapshot>>();
		sendTodoCommand.mockReturnValue(pending.promise);

		store.subscribeToEvents();

		// A push arrives while get_snapshot is still in flight.
		emit({ type: "todo_state", snapshot: makeSnapshot({ updatedAt: 10 }) });
		expect(store.updatedAt).toBe(10);

		// The response reflects equal-or-newer controller state and wins.
		pending.resolve({ success: true, data: makeSnapshot({ updatedAt: 11 }) });
		await vi.waitFor(() => {
			expect(store.updatedAt).toBe(11);
		});

		// A push arriving after the response wins (events carry full snapshots).
		emit({ type: "todo_state", snapshot: makeSnapshot({ updatedAt: 12 }) });
		expect(store.updatedAt).toBe(12);
	});
});

// ============================================================================
// All-completed summary retention (controller auto-clear convergence)
// ============================================================================

describe("completed summary retention", () => {
	it("keeps a visible summary after the controller auto-clears the list", () => {
		const store = useTodoStore();
		store.subscribeToEvents();

		emit({ type: "todo_state", snapshot: makeSnapshot() });
		expect(store.hasVisibleContent).toBe(true);

		// All-completed write -> controller stores [] -> todo_state with items [].
		emit({ type: "todo_state", snapshot: makeSnapshot({ items: [], sessionId: "session-1", updatedAt: 7 }) });

		expect(store.items).toHaveLength(0);
		expect(store.clearedCount).toBe(3);
		expect(store.hasVisibleContent).toBe(true);
	});

	it("clears the summary on the next non-empty write", () => {
		const store = useTodoStore();
		store.subscribeToEvents();

		emit({ type: "todo_state", snapshot: makeSnapshot() });
		emit({ type: "todo_state", snapshot: makeSnapshot({ items: [], sessionId: "session-1" }) });
		expect(store.clearedCount).toBe(3);

		emit({ type: "todo_state", snapshot: makeSnapshot({ items: makeItems().slice(0, 2), sessionId: "session-1", updatedAt: 8 }) });
		expect(store.clearedCount).toBeNull();
		expect(store.hasVisibleContent).toBe(true);
		expect(store.completedCount).toBe(1);
	});

	it("does not mistake a session switch for a completion clear", () => {
		const store = useTodoStore();
		store.subscribeToEvents();

		emit({ type: "todo_state", snapshot: makeSnapshot({ sessionId: "session-1" }) });

		// Switch to a fresh session whose empty snapshot arrives.
		emit({ type: "todo_state", snapshot: makeSnapshot({ items: [], sessionId: "session-2", updatedAt: 9 }) });

		expect(store.items).toHaveLength(0);
		expect(store.clearedCount).toBeNull();
		expect(store.hasVisibleContent).toBe(false);
	});
});

// ============================================================================
// clear()
// ============================================================================

describe("clear", () => {
	it("resets the whole mirror including the completed summary", () => {
		const store = useTodoStore();
		store.subscribeToEvents();

		emit({ type: "todo_state", snapshot: makeSnapshot() });
		emit({ type: "todo_state", snapshot: makeSnapshot({ items: [], sessionId: "session-1" }) });
		expect(store.clearedCount).toBe(3);

		store.clear();

		expect(store.items).toHaveLength(0);
		expect(store.updatedAt).toBeNull();
		expect(store.sessionId).toBeNull();
		expect(store.clearedCount).toBeNull();
		expect(store.hasVisibleContent).toBe(false);
	});
});

function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
