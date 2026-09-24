/**
 * Todo IPC tests (R3, SDD §3.3).
 *
 * Covers the todo-command IPC contract end-to-end with an INJECTABLE IPC
 * adapter (pure Node, no Electron runtime): get_snapshot, guard rejections
 * (invalid command / no controller), the todo_write tool surface (fixed
 * success text, structured failure text, all-completed auto-clear) and
 * todo-event forwarding (todo_state pushes, controller replacement re-sync
 * convergence).
 *
 * IPC harness rule (design plan §3, same as plan-ipc.test.ts): the test
 * registers the REAL production handlers from ipc-todo-adapters.ts on a
 * top-level-imported injectable IpcMainLike/WebContentsLike adapter;
 * production registerIpcHandlers passes the real ipcMain / win.webContents.
 * ipc-handlers.ts itself cannot be imported from pure Node (its electron
 * import chain fails to load outside the Electron runtime), so the todo
 * registration and dispatch live in a pure module the test imports directly -
 * no mirror, no lockstep. The command semantics are exercised against the
 * REAL TodoController.
 *
 * Run with: npm exec tsx -- src/main/__tests__/todo-ipc.test.ts
 */

import type { PixCommandResult } from "../../shared/types.js";
import { TODO_MAX_ITEMS, type TodoSnapshot } from "../../shared/todo-types.js";
import { TodoController } from "../todo/todo-controller.js";
import { TODO_TOOL_NAME, createTodoWriteTool } from "../todo/todo-tool.js";
import {
	registerTodoIpcHandlers,
	resyncTodoEventForwarding,
	subscribeTodoEventForwarding,
} from "../ipc-todo-adapters.js";
import type { IpcMainLike, WebContentsLike } from "../ipc-plan-adapters.js";

// ============================================================================
// Test harness (matches plan-ipc.test.ts style)
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message}`);
	}
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
	if (actual === expected) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
	console.log(`\n=== ${name} ===\n`);
	try {
		await fn();
	} catch (err) {
		failed++;
		console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
	}
}

/**
 * Assert the result is a failure envelope and return it narrowed so callers
 * can inspect code/error (PixCommandResult is a discriminated union).
 */
function assertFailure(
	result: PixCommandResult,
	message: string,
): { success: false; error: string; code?: string } {
	if (result.success === false) {
		passed++;
		console.log(`  PASS: ${message}`);
		return result;
	}
	failed++;
	console.error(`  FAIL: ${message} - expected failure envelope, got ${JSON.stringify(result)}`);
	return { success: false, error: "" };
}

// ============================================================================
// Injectable IPC adapter (pure Node; REAL handlers imported from
// ipc-todo-adapters.ts - no mirror, no lockstep)
// ============================================================================

class FakeIpcMain implements IpcMainLike {
	private readonly _handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
		this._handlers.set(channel, listener);
	}

	async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
		const listener = this._handlers.get(channel);
		if (!listener) {
			throw new Error(`No handler registered for channel "${channel}"`);
		}
		return listener({}, ...args);
	}
}

class FakeWebContents implements WebContentsLike {
	readonly sent: Array<{ channel: string; args: unknown[] }> = [];

	send(channel: string, ...args: unknown[]): void {
		this.sent.push({ channel, args });
	}

	eventsOn(channel: string): unknown[] {
		return this.sent.filter((message) => message.channel === channel).map((message) => message.args[0]);
	}
}

function makeItems(): Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> {
	return [
		{ content: "Inspect the module", status: "completed" },
		{ content: "Run tests", status: "in_progress", activeForm: "Running tests" },
		{ content: "Update docs", status: "pending" },
	];
}

// ============================================================================
// Tests
// ============================================================================

await run("registration: invalid commands rejected with invalid_todo_command", async () => {
	const controller = new TodoController(() => "session-1");
	const ipc = new FakeIpcMain();
	registerTodoIpcHandlers(ipc, () => controller);

	const bogus = (await ipc.invoke("todo-command", { type: "bogus" })) as PixCommandResult;
	const bogusFailure = assertFailure(bogus, "unknown type rejected");
	assertEqual(bogusFailure.code, "invalid_todo_command", "invalid_todo_command code");
	assert(bogusFailure.error.includes("Invalid todo command"), "error message present");

	const notObject = (await ipc.invoke("todo-command", "get_snapshot")) as PixCommandResult;
	assertFailure(notObject, "non-object command rejected");
});

await run("todo_unavailable when the bridge exposes no controller", async () => {
	const ipc = new FakeIpcMain();
	registerTodoIpcHandlers(ipc, () => null);
	const result = (await ipc.invoke("todo-command", { type: "get_snapshot" })) as PixCommandResult;
	const failure = assertFailure(result, "envelope failure");
	assertEqual(failure.code, "todo_unavailable", "todo_unavailable code");
	assert(failure.error.length > 0, "error message present");
});

await run("get_snapshot: data envelope with guard-valid empty snapshot", async () => {
	const controller = new TodoController(() => "session-1");
	const ipc = new FakeIpcMain();
	registerTodoIpcHandlers(ipc, () => controller);

	const before = (await ipc.invoke("todo-command", { type: "get_snapshot" })) as PixCommandResult<TodoSnapshot | undefined>;
	assertEqual(before.success, true, "get_snapshot succeeds before any write");
	if (before.success !== true) return;
	assert("data" in before, "data-bearing command carries data");
	assertEqual(before.data!.items.length, 0, "initial snapshot is empty");
	assertEqual(before.data!.sessionId, "session-1", "snapshot carries the session id");

	// The returned snapshot is a defensive clone.
	before.data!.items.push({ content: "mutated", status: "pending" });
	assertEqual(controller.getSnapshot().items.length, 0, "mutating the returned snapshot does not affect the controller");
});

await run("controller: full replacement, lazy session id, all-completed auto-clear", async () => {
	let sessionId = "";
	const controller = new TodoController(() => sessionId);

	// Lazy session id: the construction site's parent session is still null;
	// the snapshot reads whatever the getter returns at call time.
	let snapshot = controller.write(makeItems());
	assertEqual(snapshot.sessionId, "", "session id is resolved lazily (empty before the session exists)");
	sessionId = "session-late";
	snapshot = controller.write(makeItems());
	assertEqual(snapshot.sessionId, "session-late", "session id picked up once the session is bound");

	assertEqual(snapshot.items.length, 3, "full replacement stores the whole list");
	const stored = controller.getSnapshot();
	assertEqual(stored.items[1].activeForm, "Running tests", "activeForm preserved");
	assertEqual(stored.items[1].status, "in_progress", "in_progress preserved");

	// Deep copy: the caller's array is not aliased.
	const input = makeItems();
	controller.write(input);
	input[0].content = "mutated";
	assertEqual(controller.getSnapshot().items[0].content, "Inspect the module", "stored items are a copy of the input");

	// All-completed -> store [] (CC semantics).
	controller.write(makeItems());
	const completed = makeItems().map((item) => ({ ...item, status: "completed" as const }));
	const cleared = controller.write(completed);
	assertEqual(cleared.items.length, 0, "all-completed list is stored as empty");

	// A mixed list after a clear is stored normally.
	const mixed = controller.write(makeItems());
	assertEqual(mixed.items.length, 3, "mixed list stored after a clear");
});

await run("controller: write rejects invalid items and over-limit lists", async () => {
	const controller = new TodoController(() => "session-1");
	controller.write(makeItems());

	// Invalid item shape (empty content).
	let threw = false;
	try {
		controller.write([{ content: "", status: "pending" }]);
	} catch {
		threw = true;
	}
	assert(threw, "empty content rejected");
	assertEqual(controller.getSnapshot().items.length, 3, "previous list survives a rejected write");

	// Invalid status.
	threw = false;
	try {
		controller.write([{ content: "x", status: "done" } as unknown as { content: string; status: "pending" }]);
	} catch {
		threw = true;
	}
	assert(threw, "unknown status rejected");

	// Over the item cap.
	const tooMany = Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, i) => ({
		content: `item-${i}`,
		status: "pending" as const,
	}));
	threw = false;
	try {
		controller.write(tooMany);
	} catch {
		threw = true;
	}
	assert(threw, "over-limit list rejected");
});

await run("todo_write tool: fixed success text, structured failures, auto-clear", async () => {
	const controller = new TodoController(() => "session-1");
	const tool = createTodoWriteTool(controller);
	assertEqual(tool.name, TODO_TOOL_NAME, "tool name todo_write");
	assertEqual(tool.promptSnippet, "Track multi-step work with a session todo list.", "promptSnippet per SDD");
	assert(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length >= 3, "promptGuidelines present");

	const ok = await tool.execute("tc-1", { todos: makeItems() });
	assertEqual(ok.content.length, 1, "success result has one content block");
	assertEqual(
		ok.content[0].type === "text" ? ok.content[0].text : "",
		"Todo list updated. Continue using the todo list to track progress; mark items completed as you finish them.",
		"fixed success text",
	);
	assertEqual(controller.getSnapshot().items.length, 3, "tool write stored the list");

	const allDone = await tool.execute("tc-2", { todos: makeItems().map((item) => ({ ...item, status: "completed" as const })) });
	assertEqual(allDone.content[0].type === "text" ? allDone.content[0].text : "", "Todo list updated. Continue using the todo list to track progress; mark items completed as you finish them.", "auto-clear write still succeeds");
	assertEqual(controller.getSnapshot().items.length, 0, "all-completed tool write clears the list");

	const invalid = await tool.execute("tc-3", { todos: [{ content: "", status: "pending" }] });
	const invalidText = invalid.content[0].type === "text" ? invalid.content[0].text : "";
	assert(invalidText.startsWith("Todo list rejected:"), "invalid item returns structured failure text");
	assertEqual(controller.getSnapshot().items.length, 0, "invalid write does not mutate the list");
});

await run("todo-event forwarding: todo_state pushed on every write", async () => {
	const controller = new TodoController(() => "session-1");
	const webContents = new FakeWebContents();
	const unsubscribe = subscribeTodoEventForwarding(() => webContents, () => controller);

	// Subscribing to a non-null controller pushes its current snapshot first.
	const initial = webContents.eventsOn("todo-event") as Array<{ type: string; snapshot: { items: unknown[] } }>;
	assertEqual(initial.length, 1, "subscribe pushes the current snapshot once");
	assertEqual(initial[0].type, "todo_state", "initial push is todo_state");
	assertEqual(initial[0].snapshot.items.length, 0, "initial push carries the empty list");

	controller.write(makeItems());
	controller.write(makeItems().map((item) => ({ ...item, status: "completed" as const })));

	const events = webContents.eventsOn("todo-event") as Array<{ type: string; snapshot: { items: unknown[] } }>;
	assertEqual(events.length, 3, "one todo_state per write plus the initial push");
	assertEqual(events[1].snapshot.items.length, 3, "first write forwarded with items");
	assertEqual(events[2].snapshot.items.length, 0, "all-completed clear forwarded");

	// Unsubscribe stops forwarding.
	const beforeCount = events.length;
	unsubscribe();
	controller.write(makeItems());
	assertEqual(webContents.eventsOn("todo-event").length, beforeCount, "unsubscribe stops forwarding");
});

await run("dispose clears listeners (no further forwarding)", async () => {
	const controller = new TodoController(() => "session-1");
	let received = 0;
	const unsubscribe = controller.onEvent(() => {
		received++;
	});
	controller.write(makeItems());
	assertEqual(received, 1, "listener invoked before dispose");
	unsubscribe();

	controller.dispose();
	controller.write(makeItems());
	assertEqual(received, 1, "dispose clears listeners (no invocation after dispose)");
});

await run("sync re-subscription pushes the replacement controller snapshot", async () => {
	// A session switch replaces the TodoController instance. The re-sync hook
	// (invoked by the session-switching / runtime start-stop command paths)
	// must detect the swap and push the replacement's current snapshot, so the
	// renderer mirror converges without waiting for the next todo command.
	const first = new TodoController(() => "session-1");
	const second = new TodoController(() => "session-2");
	const webContents = new FakeWebContents();
	let current: TodoController | null = first;
	const unsubscribe = subscribeTodoEventForwarding(() => webContents, () => current);

	first.write(makeItems());
	const beforeSwap = (webContents.eventsOn("todo-event") as unknown[]).length;

	// Emulate a session switch: the bridge replaces the controller instance and
	// the command path re-syncs the event forwarding.
	current = second;
	resyncTodoEventForwarding();

	const events = webContents.eventsOn("todo-event") as Array<{ type: string; snapshot: { sessionId: string; items: unknown[] } }>;
	assertEqual(events.length, beforeSwap + 1, "re-sync pushes exactly one snapshot on the controller swap");
	const lastEvent = events[events.length - 1];
	assert(lastEvent !== undefined, "todo_state pushed on controller change");
	assertEqual(lastEvent.snapshot.sessionId, "session-2", "pushed snapshot comes from the replacement controller");
	assertEqual(lastEvent.snapshot.items.length, 0, "replacement snapshot has an empty list");

	// A re-sync while the controller is stable must not push again.
	const beforeStable = events.length;
	resyncTodoEventForwarding();
	assertEqual(
		(webContents.eventsOn("todo-event") as unknown[]).length,
		beforeStable,
		"stable controller re-sync pushes no duplicate snapshot",
	);

	// The replacement controller's live events are forwarded after the swap.
	second.write(makeItems());
	const after = webContents.eventsOn("todo-event") as Array<{ type: string; snapshot: { sessionId: string; items: unknown[] } }>;
	assertEqual(after[after.length - 1].snapshot.items.length, 3, "replacement controller live events forwarded after swap");
	unsubscribe();
});

await run("forwarding survives a null-controller window (runtime stopped)", async () => {
	const controller = new TodoController(() => "session-1");
	const webContents = new FakeWebContents();
	let current: TodoController | null = controller;
	const unsubscribe = subscribeTodoEventForwarding(() => webContents, () => current);

	// stop-pi: the bridge generation is disposed; resync must detach cleanly.
	current = null;
	resyncTodoEventForwarding();
	const count = (webContents.eventsOn("todo-event") as unknown[]).length;

	// A late write on the disposed controller must not reach the renderer.
	controller.write(makeItems());
	assertEqual((webContents.eventsOn("todo-event") as unknown[]).length, count, "detached controller events are dropped");

	// start-pi: a fresh controller is picked up and its snapshot pushed.
	const next = new TodoController(() => "session-2");
	current = next;
	resyncTodoEventForwarding();
	const events = webContents.eventsOn("todo-event") as Array<{ type: string; snapshot: { sessionId: string } }>;
	assertEqual(events[events.length - 1].snapshot.sessionId, "session-2", "fresh controller snapshot pushed on start");
	unsubscribe();
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
	process.exit(1);
}
