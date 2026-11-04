/** Opt-in Windows regression test. Opens and closes a new, empty English Notepad window.
 * Run with PIX_CUA_DRIVER_BIN pointing to cua-driver.exe, then execute this file with tsx.
 */
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ComputerActParams, ComputerVerifyExpectation } from "../../shared/computer-use-types.js";
import { CuaDriverBackend } from "../computer-use/cua-backend.js";
import { ComputerUseError, type DriverToolResult } from "../computer-use/contracts.js";
import { McpDriverClient } from "../computer-use/mcp-driver-client.js";

interface TestTarget { pid: number; window_id: number }
interface TestElement { label: string; role: string; element_token: string; value?: string }

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
}

function elements(result: DriverToolResult): TestElement[] {
	return records(result.structuredContent?.elements).filter((entry): entry is Record<string, unknown> & TestElement =>
		typeof entry.label === "string" && typeof entry.role === "string" && typeof entry.element_token === "string");
}

async function run(): Promise<void> {
	const executablePath = process.env.PIX_CUA_DRIVER_BIN;
	if (process.platform !== "win32" || !executablePath) {
		console.log("SKIP: Windows and PIX_CUA_DRIVER_BIN are required.");
		return;
	}
	const client = new McpDriverClient({ executablePath, cwd: dirname(executablePath) });
	let latestWindow: DriverToolResult | undefined;
	const driverCall = client.callTool.bind(client);
	client.callTool = async (name, args, options) => {
		const result = await driverCall(name, args, options);
		if (name === "get_window_state") latestWindow = result;
		return result;
	};
	const backend = new CuaDriverBackend(client, process.arch === "arm64" ? "win32-arm64" : "win32-x64");
	await client.ensureStarted();
	const session = await backend.openSession(`pix-windows-actions-${process.pid}`);
	const call = async (tool: string, args: Record<string, unknown>): Promise<DriverToolResult> => {
		const result = await client.callTool(tool, { ...args, session: session.driverSession });
		assert.equal(result.isError, false, JSON.stringify(result.content));
		return result;
	};
	let target: TestTarget | undefined;
	let ownTabCreated = false;
	const state = async (): Promise<DriverToolResult> => {
		await backend.observe(session, { view: "window", ...target }, { maxImageDimension: 1568, wantImage: false });
		assert.ok(latestWindow);
		return latestWindow;
	};
	const waitForState = async (predicate: (snapshot: DriverToolResult) => boolean): Promise<DriverToolResult> => {
		const deadline = Date.now() + 3_000;
		let snapshot: DriverToolResult;
		do {
			snapshot = await state();
			if (predicate(snapshot)) break;
			await setTimeout(50);
		} while (Date.now() < deadline);
		return snapshot;
	};
	try {
		const before = await call("list_windows", { on_screen_only: false });
		const previousIds = new Set(records(before.structuredContent?.windows).map((window) => window.window_id));
		const launched = await call("launch_app", { name: "notepad" });
		const pid = launched.structuredContent?.pid;
		assert.equal(typeof pid, "number", "launch_app reports Notepad pid");
		const launchDeadline = Date.now() + 10_000;
		while (Date.now() < launchDeadline) {
			const windows = await call("list_windows", { pid, on_screen_only: false });
			const created = records(windows.structuredContent?.windows).find((window) =>
				typeof window.window_id === "number" && !previousIds.has(window.window_id));
			if (created && typeof created.window_id === "number") {
				target = { pid: pid as number, window_id: created.window_id };
				break;
			}
			await setTimeout(100);
		}
		assert.ok(target, "launch_app creates a separate window");
		console.log(`Test window: pid=${target.pid}, window_id=${target.window_id}`);
		// Notepad can restore historical tabs when a new window opens.
		await backend.act(session, { action: "invoke_menu", ...target, menu_path: ["File", "New tab"] }, {});
		const initial = await waitForState((snapshot) => snapshot.structuredContent?.window_title === "Untitled - Notepad"
			&& elements(snapshot).some((element) => element.role === "Document" && !element.value));
		assert.equal(initial.structuredContent?.window_title, "Untitled - Notepad", "test window is a new empty document");
		assert.ok(elements(initial).every((element) => element.role !== "Document" || !element.value), "document has no existing text");
		ownTabCreated = true;
		let snapshot = initial;

		await backend.act(session, { action: "hotkey", ...target, keys: ["ctrl", "s"], delivery: "foreground" }, {});
		snapshot = await waitForState((snapshot) => elements(snapshot).some((element) => element.role === "Button" && element.label === "Cancel"));
		let cancel = elements(snapshot).find((element) => element.role === "Button" && element.label === "Cancel");
		assert.ok(cancel, "foreground Ctrl+S opens Save as even with the File menu closed");
		const dialogWindows = await call("list_windows", { pid: target.pid, on_screen_only: false });
		const dialog = records(dialogWindows.structuredContent?.windows).find((window) =>
			typeof window.title === "string" && /^save as$/i.test(window.title));
		assert.ok(dialog && typeof dialog.window_id === "number", "Save as exposes its own HWND");
		const dialogObservation = await backend.observe(session, { view: "window", pid: target.pid, window_id: dialog.window_id }, { maxImageDimension: 1568, wantImage: true });
		assert.ok(dialogObservation.image && dialogObservation.image.width > 0 && dialogObservation.image.height > 0, "owned Save as dialog supports a window screenshot");
		assert.ok(dialogObservation.text.includes("Save as"), "dialog snapshot describes Save as controls");
		console.log("PASS: the Save as dialog has its own capturable HWND.");
		// A new snapshot invalidates tokens; reread the parent before cancelling.
		snapshot = await state();
		cancel = elements(snapshot).find((element) => element.role === "Button" && element.label === "Cancel");
		assert.ok(cancel);
		await backend.act(session, { action: "click", ...target, element_token: cancel.element_token }, {});
		console.log("PASS: Ctrl+S uses real keyboard input and opens Save as.");

		await backend.act(session, { action: "invoke_menu", ...target, menu_path: ["File"] }, {});
		snapshot = await waitForState((snapshot) => elements(snapshot).some((element) => element.role === "MenuItem" && element.label === "Save as"));
		assert.ok(elements(snapshot).some((element) => element.role === "MenuItem" && element.label === "Save as"), "File menu remains open after the call returns");
		console.log("PASS: a one-segment menu path leaves its popup visible.");

		await backend.act(session, { action: "invoke_menu", ...target, menu_path: ["File", "Save as"] }, {});
		snapshot = await waitForState((snapshot) => elements(snapshot).some((element) => element.role === "Button" && element.label === "Cancel"));
		cancel = elements(snapshot).find((element) => element.role === "Button" && element.label === "Cancel");
		assert.ok(cancel, "multi-segment File > Save as opens its dialog");
		await backend.act(session, { action: "click", ...target, element_token: cancel.element_token }, {});
		console.log("PASS: a multi-segment menu path resolves fresh popup tokens.");

		snapshot = await state();
		let field = elements(snapshot).find((element) => element.role === "Document");
		assert.ok(field, "new tab exposes its native editor");
		for (const params of [
			{ action: "type_text", text: "abc123" },
			{ action: "press_key", key: "enter" },
			{ action: "hotkey", keys: ["ctrl", "s"] },
		] satisfies ComputerActParams[]) {
			await assert.rejects(backend.act(session, { ...params, ...target, element_token: field.element_token, delivery: "background" }, {}),
				(error: unknown) => error instanceof ComputerUseError && error.code === "background_unavailable" && error.detail.includes("no input was sent"));
			snapshot = await state();
			field = elements(snapshot).find((element) => element.role === "Document");
			assert.ok(field);
			assert.equal(field.value ?? "", "", `${params.action} leaves the document unchanged`);
		}
		console.log("PASS: WinUI background text, Enter and hotkeys are refused before input and leave the document unchanged.");

		const typedText = "abc123中文";
		await backend.act(session, { action: "type_text", ...target, element_token: field.element_token, text: typedText, delivery: "foreground" }, {});
		snapshot = await waitForState((snapshot) => elements(snapshot).some((element) => element.role === "Document" && element.value === typedText));
		field = elements(snapshot).find((element) => element.role === "Document");
		assert.ok(field);
		assert.equal(field.value, typedText, "foreground text preserves every character in order");
		await backend.act(session, { action: "press_key", ...target, element_token: field.element_token, key: "enter", delivery: "foreground" }, {});
		snapshot = await waitForState((snapshot) => elements(snapshot).some((element) => element.role === "Document" && /[\r\n]$/.test(element.value ?? "")));
		field = elements(snapshot).find((element) => element.role === "Document");
		assert.ok(field);
		assert.equal(field.value?.replace(/\r\n?/g, "\n"), `${typedText}\n`, "foreground Enter adds exactly one line break");
		console.log("PASS: foreground text preserves exact character order and Enter inserts one line break.");

		const expectedValue = "PiX verification abc123中文";
		await backend.act(session, { action: "set_value", ...target, element_token: field.element_token, value: expectedValue, delivery: "background" }, {});
		snapshot = await waitForState((snapshot) => elements(snapshot).some((element) => element.role === "Document" && element.value === expectedValue));
		field = elements(snapshot).find((element) => element.role === "Document");
		assert.ok(field);
		assert.equal(field.value, expectedValue, "background UIA set_value writes the complete value");
		console.log("PASS: background set_value writes the complete native editor value.");

		for (const text of ["A1\nA2", "abc 123 !@#\n第二行 中文测试", "B1 中文 123 !@# XYZ", "中文测试 456", "B2 123 !@# XYZ 789"]) {
			snapshot = await state();
			field = elements(snapshot).find((element) => element.role === "Document");
			assert.ok(field);
			const cleared = await backend.act(session, { action: "set_value", ...target, element_token: field.element_token, value: "", delivery: "background" }, {});
			assert.equal(cleared.effect, "confirmed", "set_value reads back the same runtime-identified control");
			snapshot = await state();
			field = elements(snapshot).find((element) => element.role === "Document");
			assert.ok(field);
			const inserted = await backend.act(session, { action: "type_text", ...target, element_token: field.element_token, text, delivery: "foreground" }, {});
			assert.equal(inserted.route, "clipboard_paste");
			assert.equal(inserted.driverTool, "WM_PASTE", "RichEdit paste uses its native message rather than keyboard or IME events");
			assert.equal(inserted.effect, "confirmed", inserted.text);
			snapshot = await state();
			field = elements(snapshot).find((element) => element.role === "Document");
			assert.equal(field?.value?.replace(/\r\n?/g, "\n"), text, "clipboard paste preserves all characters, symbols and line breaks");
		}
		console.log("PASS: all reported multiline, Chinese, digit and symbol cases paste exactly and return confirmed native read-back.");
		assert.ok(field);
		await backend.act(session, { action: "hotkey", ...target, element_token: field.element_token, keys: ["ctrl", "a"], delivery: "foreground" }, {});
		snapshot = await state();
		field = elements(snapshot).find((element) => element.role === "Document");
		assert.ok(field);
		const replaced = await backend.act(session, { action: "type_text", ...target, element_token: field.element_token, text: "选区替换\nOK", delivery: "foreground" }, {});
		assert.equal(replaced.effect, "confirmed");
		snapshot = await state();
		field = elements(snapshot).find((element) => element.role === "Document");
		assert.equal(field?.value?.replace(/\r\n?/g, "\n"), "选区替换\nOK", "paste replaces the selection rather than appending or overwriting the whole control");
		console.log("PASS: selected text is replaced and confirmed against the original selection.");
		assert.ok(field);
		await backend.act(session, { action: "set_value", ...target, element_token: field.element_token, value: expectedValue, delivery: "background" }, {});
		snapshot = await state();
		field = elements(snapshot).find((element) => element.role === "Document");
		assert.ok(field);

		for (const [query, max_elements] of [["Text editor", 2], ["Bold", 4]] as const) {
			const found = await backend.observe(session, { view: "window", ...target, query, max_elements }, { maxImageDimension: 1568, wantImage: false });
			assert.match(found.text, new RegExp(query));
			assert.ok((found.tree?.returnedElements ?? 0) > 0, `${query} remains visible with a small output budget`);
		}
		console.log("PASS: small query budgets count matching controls rather than their ancestors.");
		const bold = elements(latestWindow!).find((element) => /^bold\b/i.test(element.label));
		assert.ok(bold);
		const toggled = await backend.act(session, { action: "click", ...target, element_token: bold.element_token }, {});
		assert.equal(toggled.effect, "confirmed", toggled.text);
		await backend.observe(session, { view: "window", ...target, query: "Bold", max_elements: 4 }, { maxImageDimension: 1568, wantImage: false });
		const boldAgain = elements(latestWindow!).find((element) => /^bold\b/i.test(element.label));
		assert.ok(boldAgain);
		await backend.act(session, { action: "click", ...target, element_token: boldAgain.element_token }, {});
		console.log("PASS: Bold toggles are confirmed from the same control's native state.");

		await backend.observe(session, { view: "window", ...target }, { maxImageDimension: 1568, wantImage: true });
		await backend.observe(session, { view: "zoom", ...target, region: { x1: 0, y1: 0, x2: 500, y2: 90 } }, { maxImageDimension: 1568, wantImage: true });
		await backend.act(session, { action: "click", ...target, from_zoom: true, x: 20, y: 48 }, {});
		const refreshedZoom = await backend.observe(session, { view: "window", ...target }, { maxImageDimension: 1568, wantImage: true, preserveZoom: true });
		assert.equal(refreshedZoom.zoom, true);
		assert.ok(refreshedZoom.image);
		await backend.act(session, { action: "click", ...target, from_zoom: true, x: 63, y: 48 }, {});
		await backend.observe(session, { view: "window", ...target }, { maxImageDimension: 1568, wantImage: true, preserveZoom: true });
		await backend.act(session, { action: "press_key", ...target, key: "escape", delivery: "foreground" }, {});
		console.log("PASS: successive zoom-coordinate clicks use fresh post-action zoom contexts without a manual observe-plus-zoom cycle.");

		const selector = { role: "Document", label_contains: field.label };
		const expect: ComputerVerifyExpectation[] = [
			{ element: { selector, exists: true } },
			{ element: { selector, enabled: true } },
			{ element: { selector, value_equals: expectedValue } },
		];
		const verified = await backend.observe(session, { view: "verify", ...target, expect }, { maxImageDimension: 1568, wantImage: false });
		assert.equal(verified.verify?.status, "satisfied", verified.text);
		assert.equal(verified.verify.stable, true);
		assert.equal(verified.verify.samples, 2);
		assert.deepEqual(verified.verify.predicates.map((predicate) => predicate.status), ["satisfied", "satisfied", "satisfied"]);
		const wrongValue = await backend.observe(session, {
			view: "verify", ...target, expect: [{ element: { selector, value_equals: `${expectedValue} mismatch` } }],
		}, { maxImageDimension: 1568, wantImage: false });
		assert.equal(wrongValue.verify?.status, "unsatisfied", wrongValue.text);
		console.log("PASS: native Document verification satisfies exists/enabled/exact value in two stable samples and rejects a wrong value.");

	} catch (error) {
		console.error("Windows actions regression failed:", error);
		throw error;
	} finally {
		try {
			if (target) {
				let snapshot = await state();
				const cancel = elements(snapshot).find((element) => element.role === "Button" && element.label === "Cancel");
				if (cancel) await backend.act(session, { action: "click", ...target, element_token: cancel.element_token }, {});
				if (ownTabCreated) {
					snapshot = await state();
					const field = elements(snapshot).find((element) => element.role === "Document");
					assert.ok(field, "cleanup locates the test tab");
					await backend.act(session, { action: "set_value", ...target, element_token: field.element_token, value: "", delivery: "background" }, {});
					await backend.act(session, { action: "invoke_menu", ...target, menu_path: ["File", "Close tab"] }, {});
					await setTimeout(250);
				}
				let remaining = await call("list_windows", { pid: target.pid, on_screen_only: false });
				if (records(remaining.structuredContent?.windows).some((window) => window.window_id === target?.window_id)) {
					snapshot = await state();
					const discard = elements(snapshot).find((element) => element.role === "Button" && /^(don't save|discard)$/i.test(element.label));
					if (discard) await backend.act(session, { action: "click", ...target, element_token: discard.element_token }, {});
					remaining = await call("list_windows", { pid: target.pid, on_screen_only: false });
					if (records(remaining.structuredContent?.windows).some((window) => window.window_id === target?.window_id)) {
						await backend.act(session, { action: "invoke_menu", ...target, menu_path: ["File", "Close window"] }, {});
					}
				}
				let closed = false;
				const closeDeadline = Date.now() + 2_000;
				do {
					const windows = await call("list_windows", { pid: target.pid, on_screen_only: false });
					closed = !records(windows.structuredContent?.windows).some((window) => window.window_id === target?.window_id);
					if (closed) break;
					await setTimeout(50);
				} while (Date.now() < closeDeadline);
				assert.ok(closed, "test window closed");
				console.log("PASS: the empty test window closed without creating a file.");
			}
		} finally {
			await backend.closeSession(session);
			await client.stop();
		}
	}
}

await run();
