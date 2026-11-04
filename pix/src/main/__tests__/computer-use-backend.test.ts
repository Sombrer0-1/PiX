/**
 * CuaDriverBackend tests.
 *
 * Pure translation-table coverage plus CuaDriverBackend behaviour against an
 * injectable fake DriverClient (pure Node), closed by one regression that wires
 * the backend to the real McpDriverClient + fake-cua-driver.mjs child process:
 *  - every row of the translation table (driver tool name + argument mapping)
 *  - schema-adaptive act translation: coordinate_frame / scope / pid / window_id are
 *    sent only when the live tools/list schema declares them
 *  - session injection on every call / lazy start_session / end_session on dispose
 *  - start_session args adapting to the live tools/list schema (label/session)
 *  - runtime required check (missingDriverArgs) against the live tools/list schema
 *  - permission normalisation for win32 / darwin / linux with three-valued semantics
 *    (undefined = undecidable: never blocking, reported in `undecidable`)
 *  - result normalisation: joined + truncated text, image dimensions from
 *    structuredContent or the PNG/JPEG header, capture_id, effect passthrough,
 *    isError -> ComputerUseError classification
 *  - supports() derived from tools/list; wait never calls the driver
 *  - a full act/observe translation-scan regression against the real fixture child
 *    process: legal minimal params for every action and view must reach the
 *    driver without invalid_params or isError
 *
 * Run with: npx tsx src/main/__tests__/computer-use-backend.test.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ComputerActParams,
	ComputerObserveParams,
	ComputerUsePlatform,
	ComputerVerifyExpectation,
} from "../../shared/computer-use-types.js";
import { COMPUTER_USE_LIMITS } from "../../shared/computer-use-types.js";
import type {
	BackendSessionHandle,
	DriverClient,
	DriverClientState,
	DriverToolInputSchema,
	DriverToolResult,
} from "../computer-use/contracts.js";
import { ComputerUseError } from "../computer-use/contracts.js";
import {
	CuaDriverBackend,
	classifyDriverError,
	missingDriverArgs,
	normalizePermissions,
	translateAct,
	translateObserve,
} from "../computer-use/cua-backend.js";
import { DRIVER_MCP_ARGS } from "../computer-use/driver-manifest.js";
import { McpDriverClient } from "../computer-use/mcp-driver-client.js";

// ============================================================================
// Test harness (todo-ipc.test.ts style: PASS/FAIL counters, non-zero exit)
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

/** Key-order-insensitive deep comparison. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function assertJson(actual: unknown, expected: unknown, message: string): void {
	if (canonical(actual) === canonical(expected)) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message} - expected ${canonical(expected)}, got ${canonical(actual)}`);
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

async function catchComputerUseError(fn: () => Promise<unknown>, message: string): Promise<ComputerUseError | null> {
	try {
		await fn();
	} catch (err) {
		if (err instanceof ComputerUseError) {
			passed++;
			console.log(`  PASS: ${message}`);
			return err;
		}
		failed++;
		console.error(`  FAIL: ${message} - threw a non-ComputerUseError: ${String(err)}`);
		return null;
	}
	failed++;
	console.error(`  FAIL: ${message} - did not throw`);
	return null;
}

// ============================================================================
// Fake DriverClient (implements contracts.ts DriverClient; no real process)
// ============================================================================

class FakeDriverClient implements DriverClient {
	state: DriverClientState = "ready";
	readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	readonly tools = new Set<string>();
	readonly schemas = new Map<string, DriverToolInputSchema>();
	readonly responses = new Map<string, DriverToolResult>();
	private readonly _listeners = new Set<(s: DriverClientState, detail?: string) => void>();

	async ensureStarted(): Promise<void> {
		this.state = "ready";
	}

	listToolNames(): ReadonlySet<string> {
		return this.tools;
	}

	getToolInputSchema(name: string): DriverToolInputSchema | null {
		return this.schemas.get(name) ?? null;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<DriverToolResult> {
		this.calls.push({ tool: name, args });
		const response = this.responses.get(name);
		if (response === undefined) throw new Error(`fake driver: no response registered for "${name}"`);
		return response;
	}

	cancelAll(): void {}

	async stop(): Promise<void> {
		this.state = "idle";
	}

	onStateChange(listener: (s: DriverClientState, detail?: string) => void): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	emitState(state: DriverClientState): void {
		this.state = state;
		for (const listener of this._listeners) listener(state);
	}

	callsFor(tool: string): Array<{ tool: string; args: Record<string, unknown> }> {
		return this.calls.filter((call) => call.tool === tool);
	}
}

function makeBackend(platform: ComputerUsePlatform = "linux-x64"): { client: FakeDriverClient; backend: CuaDriverBackend } {
	const client = new FakeDriverClient();
	return { client, backend: new CuaDriverBackend(client, platform) };
}

function installStandardDriver(client: FakeDriverClient): void {
	for (const name of [
		"list_apps", "list_windows", "get_window_state", "get_desktop_state", "zoom", "verify_state",
		"click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "drag",
		"move_cursor", "set_value", "invoke_menu", "launch_app", "bring_to_front",
		"check_permissions", "start_session", "end_session",
	]) {
		client.tools.add(name);
	}
	client.schemas.set("get_window_state", {
		required: ["pid", "window_id"],
		properties: new Set(["pid", "window_id", "query", "max_elements", "include_screenshot", "max_image_dimension"]),
	});
	client.schemas.set("double_click", {
		required: ["pid"],
		properties: new Set(["pid", "window_id", "element_token", "x", "y", "coordinate_frame", "scope", "delivery_mode"]),
	});
	client.responses.set("start_session", textResult("session started"));
	client.responses.set("end_session", textResult("session ended"));
}

function textResult(text: string, structured?: Record<string, unknown>): DriverToolResult {
	const result: DriverToolResult = { content: [{ type: "text", text }], isError: false };
	if (structured !== undefined) result.structuredContent = structured;
	return result;
}

function errorResult(text: string, structured?: Record<string, unknown>): DriverToolResult {
	const result: DriverToolResult = { content: [{ type: "text", text }], isError: true };
	if (structured !== undefined) result.structuredContent = structured;
	return result;
}

/** Minimal PNG whose first 24 bytes are a valid IHDR (enough for the header parser). */
function tinyPng(width: number, height: number): string {
	const bytes = Buffer.alloc(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.writeUInt32BE(13, 8); // IHDR length
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes.toString("base64");
}

/** Minimal JPEG: SOI + SOF0 (no other segments). */
function tinyJpeg(width: number, height: number): string {
	const bytes = Buffer.alloc(15);
	bytes.writeUInt16BE(0xffd8, 0); // SOI
	bytes.writeUInt16BE(0xffc0, 2); // SOF0
	bytes.writeUInt16BE(11, 4); // segment length (2 + 9 payload bytes)
	bytes.writeUInt8(8, 6); // precision
	bytes.writeUInt16BE(height, 7);
	bytes.writeUInt16BE(width, 9);
	bytes.writeUInt8(1, 11); // components
	return bytes.toString("base64");
}

const HANDLE: BackendSessionHandle = { driverSession: "pix-gen1-aaaaaaaa" };

// ============================================================================
// translateObserve — translation table row by row
// ============================================================================

await run("translateObserve: every table row", async () => {
	const opts = { maxImageDimension: 1568, wantImage: true };

	const apps = translateObserve({ view: "apps" }, opts);
	assertEqual(apps.tool, "list_apps", "view=apps -> list_apps");
	assertEqual(Object.keys(apps.args).length, 0, "apps carries no args");

	const windows = translateObserve({ view: "windows", pid: 123, on_screen_only: true }, opts);
	assertEqual(windows.tool, "list_windows", "view=windows -> list_windows");
	assertEqual(windows.args.pid, 123, "windows pid filter");
	assertEqual(windows.args.on_screen_only, true, "windows on_screen_only");

	const window = translateObserve({ view: "window", pid: 10, window_id: 20, query: "Save", max_elements: 250 }, opts);
	assertEqual(window.tool, "get_window_state", "view=window -> get_window_state");
	assertEqual(window.args.pid, 10, "window pid");
	assertEqual(window.args.window_id, 20, "window window_id");
	assertEqual(window.args.query, "Save", "window query");
	assertEqual(window.args.max_elements, 250, "window max_elements passthrough");
	assertEqual(window.args.include_screenshot, true, "window include_screenshot=wantImage");
	assertEqual(window.args.max_image_dimension, 1568, "window max_image_dimension");

	const windowDefault = translateObserve({ view: "window", pid: 1, window_id: 2 }, opts);
	assertEqual(windowDefault.args.max_elements, COMPUTER_USE_LIMITS.maxElements.default, "window default max_elements");

	const noImage = translateObserve({ view: "window", pid: 1, window_id: 2 }, { maxImageDimension: 768, wantImage: false });
	assertEqual(noImage.args.include_screenshot, false, "wantImage=false -> include_screenshot=false");

	const desktop = translateObserve({ view: "desktop" }, { maxImageDimension: 1024, wantImage: false });
	assertEqual(desktop.tool, "get_desktop_state", "view=desktop -> get_desktop_state");
	assertEqual(desktop.args.max_image_dimension, 1024, "desktop still calls the driver without an image");
	assertEqual(Object.keys(desktop.args).length, 1, "desktop forwards only max_image_dimension");

	const zoom = translateObserve({ view: "zoom", pid: 5, window_id: 6, region: { x1: 1, y1: 2, x2: 30, y2: 40 } }, opts);
	assertEqual(zoom.tool, "zoom", "view=zoom -> zoom");
	assertEqual(zoom.args.pid, 5, "zoom pid (PiX requires it for self-protection)");
	assertEqual(zoom.args.window_id, 6, "zoom window_id");
	assertEqual(zoom.args.x1, 1, "zoom x1 <- region.x1");
	assertEqual(zoom.args.y1, 2, "zoom y1 <- region.y1");
	assertEqual(zoom.args.x2, 30, "zoom x2 <- region.x2");
	assertEqual(zoom.args.y2, 40, "zoom y2 <- region.y2");

	const expectations: ComputerVerifyExpectation[] = [
		{ window: { exists: true } },
		{ element: { selector: { role: "button" }, enabled: true } },
	];
	const verify = translateObserve({ view: "verify", pid: 7, window_id: 8, expect: expectations }, opts);
	assertEqual(verify.tool, "verify_state", "view=verify -> verify_state");
	assertEqual(verify.args.pid, 7, "verify pid");
	assertEqual(verify.args.window_id, 8, "verify window_id");
	assertJson(verify.args.expect, expectations, "verify expect passthrough");
	assertEqual(verify.args.include_screenshot, true, "verify include_screenshot=wantImage");
});

// ============================================================================
// translateAct — translation table row by row
// ============================================================================

await run("translateAct: click / double_click / right_click rows", async () => {
	const click = translateAct({
		action: "click", pid: 42, window_id: 7, element_token: "s1a2b3c4:5",
		capture_id: "c_9", from_zoom: true, modifiers: ["ctrl"], delivery: "foreground",
	});
	assert("tool" in click, "click translates to a driver call");
	if (!("tool" in click)) return;
	assertEqual(click.tool, "click", "action=click -> click");
	assertEqual(click.args.element_token, "s1a2b3c4:5", "click element_token");
	assertEqual(click.args.pid, 42, "click pid");
	assertEqual(click.args.window_id, 7, "click window_id");
	assertEqual(click.args.coordinate_frame, "window", "click coordinate_frame=frame (pid -> window)");
	assertEqual(click.args.capture_id, "c_9", "click capture_id");
	assertEqual(click.args.from_zoom, true, "click from_zoom");
	assertJson(click.args.modifier, ["ctrl"], "click modifier <- modifiers");
	assertEqual(click.args.delivery_mode, "foreground", "click delivery_mode <- delivery");
	assertEqual(click.args.scope, undefined, "click with pid sends no scope");

	const desktopClick = translateAct({ action: "click", x: 11, y: 12, frame: "desktop" });
	assert("tool" in desktopClick, "desktop click translates");
	if (!("tool" in desktopClick)) return;
	assertEqual(desktopClick.args.coordinate_frame, "desktop", "desktop click coordinate_frame");
	assertEqual(desktopClick.args.scope, "desktop", "desktop frame without pid -> scope=desktop");
	assertEqual(desktopClick.args.x, 11, "desktop click x");
	assertEqual(desktopClick.args.y, 12, "desktop click y");

	const dbl = translateAct({ action: "double_click", x: 5, y: 6, frame: "desktop" });
	assert("tool" in dbl, "desktop double_click translates");
	if (!("tool" in dbl)) return;
	assertEqual(dbl.tool, "double_click", "action=double_click -> double_click");
	assertEqual(dbl.args.scope, "desktop", "double_click desktop scope");
	assertEqual(dbl.args.pid, undefined, "double_click without pid omits pid");

	const right = translateAct({ action: "right_click", x: 1, y: 2 });
	assert("tool" in right, "right_click translates");
	if (!("tool" in right)) return;
	assertEqual(right.tool, "right_click", "action=right_click -> right_click");
	assertEqual(right.args.coordinate_frame, "desktop", "right_click default frame without pid is desktop");
	assertEqual(right.args.scope, "desktop", "right_click default scope is desktop");
});

await run("translateAct: type_text / press_key / hotkey rows", async () => {
	const type = translateAct({ action: "type_text", text: "hi", element_token: "s1a2b3c4:5", delivery: "foreground" });
	assert("tool" in type, "type_text translates");
	if (!("tool" in type)) return;
	assertEqual(type.tool, "type_text", "action=type_text -> type_text");
	assertEqual(type.args.text, "hi", "type_text text");
	assertEqual(type.args.element_token, "s1a2b3c4:5", "type_text element_token");
	assertEqual(type.args.delivery_mode, "foreground", "type_text delivery_mode");
	assertEqual("pid" in type.args, false, "type_text with only an element_token omits pid");
	assertEqual("scope" in type.args, false, "type_text with an element_token does not send scope=desktop");

	// cua-driver 0.34.1 requires pid on every non-desktop type_text call.
	const typeTargeted = translateAct({ action: "type_text", text: "hi", pid: 42, window_id: 7, element_token: "s1a2b3c4:5" });
	assert("tool" in typeTargeted, "type_text with pid/window_id translates");
	if (!("tool" in typeTargeted)) return;
	assertEqual(typeTargeted.args.pid, 42, "type_text forwards pid to the driver");
	assertEqual(typeTargeted.args.window_id, 7, "type_text forwards window_id to the driver");
	assertEqual("scope" in typeTargeted.args, false, "type_text with pid does not send scope=desktop");

	const typeDesktop = translateAct({ action: "type_text", text: "hi" });
	assert("tool" in typeDesktop, "untargeted type_text translates");
	if (!("tool" in typeDesktop)) return;
	assertEqual(typeDesktop.args.scope, "desktop", "type_text without a target sends scope=desktop");
	assertEqual("pid" in typeDesktop.args, false, "untargeted type_text omits pid");

	const typeSchema = { required: ["text"], properties: new Set(["text", "element_token", "delivery_mode"]) };
	const typeStripped = translateAct(
		{ action: "type_text", text: "hi", pid: 42, window_id: 7 },
		() => typeSchema,
	);
	assert("tool" in typeStripped, "type_text against a schema without pid translates");
	if (!("tool" in typeStripped)) return;
	assertEqual("pid" in typeStripped.args, false, "type_text omits pid when the driver schema does not declare it");
	assertEqual("window_id" in typeStripped.args, false, "type_text omits window_id when the driver schema does not declare it");
	const typeNoScope = translateAct({ action: "type_text", text: "hi" }, () => typeSchema);
	assert("tool" in typeNoScope, "untargeted type_text against a schema without scope translates");
	if (!("tool" in typeNoScope)) return;
	assertEqual("scope" in typeNoScope.args, false, "type_text omits scope when the driver schema does not declare it");

	const press = translateAct({
		action: "press_key", key: "enter", modifiers: ["shift"], element_token: "s1a2b3c4:5",
		pid: 3, window_id: 4, delivery: "background",
	});
	assert("tool" in press, "press_key translates");
	if (!("tool" in press)) return;
	assertEqual(press.tool, "press_key", "action=press_key -> press_key");
	assertEqual(press.args.key, "enter", "press_key key");
	assertJson(press.args.modifiers, ["shift"], "press_key modifiers");
	assertEqual(press.args.element_token, "s1a2b3c4:5", "press_key element_token");
	assertEqual(press.args.pid, 3, "press_key pid");
	assertEqual(press.args.window_id, 4, "press_key window_id");
	assertEqual(press.args.delivery_mode, "background", "press_key delivery_mode");

	const hotkey = translateAct({ action: "hotkey", keys: ["ctrl", "c"], pid: 9 });
	assert("tool" in hotkey, "hotkey translates");
	if (!("tool" in hotkey)) return;
	assertEqual(hotkey.tool, "hotkey", "action=hotkey -> hotkey");
	assertJson(hotkey.args.keys, ["ctrl", "c"], "hotkey keys");
	assertEqual(hotkey.args.pid, 9, "hotkey pid");
});

await run("translateAct: scroll / drag / move_cursor rows", async () => {
	const scroll = translateAct({ action: "scroll", direction: "down", amount: 3, x: 10, y: 20, pid: 2, window_id: 3 });
	assert("tool" in scroll, "scroll translates");
	if (!("tool" in scroll)) return;
	assertEqual(scroll.tool, "scroll", "action=scroll -> scroll");
	assertEqual(scroll.args.direction, "down", "scroll direction");
	assertEqual(scroll.args.amount, 3, "scroll amount");
	assertEqual(scroll.args.x, 10, "scroll x");
	assertEqual(scroll.args.y, 20, "scroll y");
	assertEqual(scroll.args.coordinate_frame, "window", "scroll coordinate_frame");

	const drag = translateAct({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4, frame: "desktop", from_zoom: true });
	assert("tool" in drag, "drag translates");
	if (!("tool" in drag)) return;
	assertEqual(drag.tool, "drag", "action=drag -> drag");
	assertEqual(drag.args.from_x, 1, "drag from_x <- x");
	assertEqual(drag.args.from_y, 2, "drag from_y <- y");
	assertEqual(drag.args.to_x, 3, "drag to_x");
	assertEqual(drag.args.to_y, 4, "drag to_y");
	assertEqual(drag.args.coordinate_frame, "desktop", "drag coordinate_frame");
	assertEqual(drag.args.from_zoom, true, "drag from_zoom");
	assertEqual("x" in drag.args, false, "drag does not forward the raw x");

	const move = translateAct({ action: "move_cursor", x: 8, y: 9 });
	assert("tool" in move, "move_cursor translates");
	if (!("tool" in move)) return;
	assertEqual(move.tool, "move_cursor", "action=move_cursor -> move_cursor");
	assertEqual(move.args.x, 8, "move_cursor x");
	assertEqual(move.args.y, 9, "move_cursor y");
	assertEqual(move.args.scope, "desktop", "move_cursor scope <- frame (no pid -> desktop)");

	const moveWindow = translateAct({ action: "move_cursor", x: 8, y: 9, frame: "window" });
	assert("tool" in moveWindow, "window-framed move_cursor translates");
	if (!("tool" in moveWindow)) return;
	assertEqual(moveWindow.args.scope, "window", "move_cursor scope <- frame (window)");
});

await run("translateAct: delivery_mode forwarded for scroll / drag / set_value", async () => {
	const scroll = translateAct({ action: "scroll", direction: "down", amount: 2, x: 1, y: 2, delivery: "foreground" });
	assert("tool" in scroll, "scroll translates");
	if (!("tool" in scroll)) return;
	assertEqual(scroll.args.delivery_mode, "foreground", "scroll delivery_mode <- delivery");
	const scrollDefault = translateAct({ action: "scroll", direction: "down", amount: 2, x: 1, y: 2 });
	assert("tool" in scrollDefault, "scroll without delivery translates");
	if (!("tool" in scrollDefault)) return;
	assertEqual("delivery_mode" in scrollDefault.args, false, "scroll without delivery omits delivery_mode (driver default)");

	const drag = translateAct({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4, delivery: "foreground" });
	assert("tool" in drag, "drag translates");
	if (!("tool" in drag)) return;
	assertEqual(drag.args.delivery_mode, "foreground", "drag delivery_mode <- delivery");
	const dragDefault = translateAct({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 });
	assert("tool" in dragDefault, "drag without delivery translates");
	if (!("tool" in dragDefault)) return;
	assertEqual("delivery_mode" in dragDefault.args, false, "drag without delivery omits delivery_mode (driver default)");

	const setValue = translateAct({ action: "set_value", pid: 5, element_token: "s1a2b3c4:5", value: "v", delivery: "foreground" });
	assert("tool" in setValue, "set_value translates");
	if (!("tool" in setValue)) return;
	assertEqual(setValue.args.delivery_mode, "foreground", "set_value delivery_mode <- delivery");
	const setValueDefault = translateAct({ action: "set_value", pid: 5, element_token: "s1a2b3c4:5", value: "v" });
	assert("tool" in setValueDefault, "set_value without delivery translates");
	if (!("tool" in setValueDefault)) return;
	assertEqual("delivery_mode" in setValueDefault.args, false, "set_value without delivery omits delivery_mode (driver default)");

	// The driver does not declare delivery_mode on these tools.
	const move = translateAct({ action: "move_cursor", x: 1, y: 2, delivery: "foreground" });
	assert("tool" in move, "move_cursor translates");
	if (!("tool" in move)) return;
	assertEqual("delivery_mode" in move.args, false, "move_cursor never carries delivery_mode");
	const menu = translateAct({ action: "invoke_menu", pid: 1, window_id: 2, menu_path: ["File"], delivery: "foreground" });
	assert("tool" in menu, "invoke_menu translates");
	if (!("tool" in menu)) return;
	assertEqual("delivery_mode" in menu.args, false, "invoke_menu never carries delivery_mode");
});

await run("translateAct: set_value / invoke_menu / launch_app / focus_window / wait rows", async () => {
	const setValue = translateAct({ action: "set_value", pid: 5, element_token: "s1a2b3c4:5", value: "hello", window_id: 6 });
	assert("tool" in setValue, "set_value translates");
	if (!("tool" in setValue)) return;
	assertEqual(setValue.tool, "set_value", "action=set_value -> set_value");
	assertEqual(setValue.args.pid, 5, "set_value pid");
	assertEqual(setValue.args.value, "hello", "set_value value");
	assertEqual(setValue.args.element_token, "s1a2b3c4:5", "set_value element_token");
	assertEqual(setValue.args.window_id, 6, "set_value window_id");

	const menu = translateAct({ action: "invoke_menu", pid: 1, window_id: 2, menu_path: ["File", "Save"] });
	assert("tool" in menu, "invoke_menu translates");
	if (!("tool" in menu)) return;
	assertEqual(menu.tool, "invoke_menu", "action=invoke_menu -> invoke_menu");
	assertEqual(menu.args.pid, 1, "invoke_menu pid");
	assertEqual(menu.args.window_id, 2, "invoke_menu window_id");
	assertJson(menu.args.path, ["File", "Save"], "invoke_menu path <- menu_path");

	const launch = translateAct({ action: "launch_app", app: "notepad", urls: ["https://example.com"] });
	assert("tool" in launch, "launch_app translates");
	if (!("tool" in launch)) return;
	assertEqual(launch.tool, "launch_app", "action=launch_app -> launch_app");
	assertEqual(launch.args.name, "notepad", "launch_app name <- app");
	assertJson(launch.args.urls, ["https://example.com"], "launch_app urls");

	const focus = translateAct({ action: "focus_window", pid: 11, window_id: 12 });
	assert("tool" in focus, "focus_window translates");
	if (!("tool" in focus)) return;
	assertEqual(focus.tool, "bring_to_front", "action=focus_window -> bring_to_front");
	assertEqual(focus.args.pid, 11, "focus_window pid");
	assertEqual(focus.args.window_id, 12, "focus_window window_id");

	const wait = translateAct({ action: "wait", duration_ms: 250 });
	assertJson(wait, { wait: 250 }, "action=wait -> { wait: duration_ms } (no driver tool)");
});

// ============================================================================
// Schema-adaptive act translation
// ============================================================================

await run("translateAct: driver-optional targeting fields are gated by the live schema", async () => {
	// Matrix: the schema declares / omits each of coordinate_frame, scope, pid (+window_id).
	const full: DriverToolInputSchema = {
		required: [],
		properties: new Set(["element_token", "x", "y", "to_x", "to_y", "coordinate_frame", "scope", "pid", "window_id"]),
	};
	const noFrame: DriverToolInputSchema = { required: [], properties: new Set(["element_token", "x", "y", "pid", "window_id"]) };
	const noScope: DriverToolInputSchema = { required: [], properties: new Set(["element_token", "x", "y", "coordinate_frame", "pid"]) };
	const noTarget: DriverToolInputSchema = { required: [], properties: new Set(["element_token", "x", "y", "coordinate_frame", "scope"]) };

	// click: every declared field is sent, undeclared fields are dropped.
	const clickFull = translateAct({ action: "click", pid: 5, window_id: 6, x: 1, y: 2 }, () => full);
	assert("tool" in clickFull, "click with a full schema translates");
	if (!("tool" in clickFull)) return;
	assertEqual(clickFull.args.coordinate_frame, "window", "declared coordinate_frame sent (pid -> window)");
	assertEqual(clickFull.args.pid, 5, "declared pid sent");
	assertEqual(clickFull.args.window_id, 6, "declared window_id sent");
	assertEqual("scope" in clickFull.args, false, "scope omitted for a window-framed click even when declared");

	const clickNoFrame = translateAct({ action: "click", x: 1, y: 2 }, () => noFrame);
	assert("tool" in clickNoFrame, "click without a declared coordinate_frame translates");
	if (!("tool" in clickNoFrame)) return;
	assertEqual("coordinate_frame" in clickNoFrame.args, false, "undeclared coordinate_frame is not sent");
	assertEqual("scope" in clickNoFrame.args, false, "undeclared scope is not sent");

	const clickNoScope = translateAct({ action: "click", x: 1, y: 2 }, () => noScope);
	assert("tool" in clickNoScope, "click without a declared scope translates");
	if (!("tool" in clickNoScope)) return;
	assertEqual(clickNoScope.args.coordinate_frame, "desktop", "declared coordinate_frame still sent (desktop default frame)");
	assertEqual("scope" in clickNoScope.args, false, "undeclared scope is not sent even for a pid-less desktop click");

	const clickNoTarget = translateAct({ action: "click", pid: 5, window_id: 6, x: 1, y: 2 }, () => noTarget);
	assert("tool" in clickNoTarget, "click without declared pid/window_id translates");
	if (!("tool" in clickNoTarget)) return;
	assertEqual("pid" in clickNoTarget.args, false, "undeclared pid is not sent");
	assertEqual("window_id" in clickNoTarget.args, false, "undeclared window_id is not sent");

	// A null schema (old driver / test stub: undecidable) keeps the historical payload.
	const clickLegacy = translateAct({ action: "click", pid: 5, window_id: 6, x: 1, y: 2 });
	assert("tool" in clickLegacy, "legacy click translates");
	if (!("tool" in clickLegacy)) return;
	assertEqual(clickLegacy.args.coordinate_frame, "window", "null schema keeps the historical coordinate_frame");
	assertEqual(clickLegacy.args.pid, 5, "null schema keeps the historical pid");
	assertEqual(clickLegacy.args.window_id, 6, "null schema keeps the historical window_id");

	// scroll: pid/window_id follow the same live-schema gate.
	const scrollFull = translateAct({ action: "scroll", direction: "down", x: 1, y: 2, pid: 5, window_id: 6 }, () => full);
	assert("tool" in scrollFull, "scroll with a full schema translates");
	if (!("tool" in scrollFull)) return;
	assertEqual(scrollFull.args.pid, 5, "scroll forwards a declared pid");
	assertEqual(scrollFull.args.window_id, 6, "scroll forwards a declared window_id");
	assertEqual(scrollFull.args.coordinate_frame, "window", "scroll sends a declared coordinate_frame");

	const scrollNull = translateAct({ action: "scroll", direction: "down", x: 1, y: 2, pid: 5, window_id: 6 });
	assert("tool" in scrollNull, "scroll with a null schema translates");
	if (!("tool" in scrollNull)) return;
	assertEqual(scrollNull.args.pid, 5, "scroll forwards pid even with a null schema (F8)");
	assertEqual(scrollNull.args.window_id, 6, "scroll forwards window_id even with a null schema (F8)");

	const scrollNoTarget = translateAct({ action: "scroll", direction: "down", x: 1, y: 2, pid: 5, window_id: 6 }, () => noTarget);
	assert("tool" in scrollNoTarget, "scroll without declared pid/window_id translates");
	if (!("tool" in scrollNoTarget)) return;
	assertEqual("pid" in scrollNoTarget.args, false, "scroll drops an undeclared pid");
	assertEqual("window_id" in scrollNoTarget.args, false, "scroll drops an undeclared window_id");

	// drag: same rules as scroll.
	const dragFull = translateAct({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4, pid: 5, window_id: 6 }, () => full);
	assert("tool" in dragFull, "drag with a full schema translates");
	if (!("tool" in dragFull)) return;
	assertEqual(dragFull.args.pid, 5, "drag forwards a declared pid");
	assertEqual(dragFull.args.window_id, 6, "drag forwards a declared window_id");

	const dragNull = translateAct({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4, pid: 5, window_id: 6 });
	assert("tool" in dragNull, "drag with a null schema translates");
	if (!("tool" in dragNull)) return;
	assertEqual(dragNull.args.pid, 5, "drag forwards pid even with a null schema (F9)");
	assertEqual(dragNull.args.window_id, 6, "drag forwards window_id even with a null schema (F9)");

	const dragNoFrame = translateAct({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 }, () => noFrame);
	assert("tool" in dragNoFrame, "drag without a declared coordinate_frame translates");
	if (!("tool" in dragNoFrame)) return;
	assertEqual("coordinate_frame" in dragNoFrame.args, false, "drag drops an undeclared coordinate_frame");
	assertEqual(dragNoFrame.args.from_x, 1, "drag keeps its unconditional from_x");

	// move_cursor: scope is gated the same way.
	const moveDeclared = translateAct({ action: "move_cursor", x: 1, y: 2 }, () => full);
	assert("tool" in moveDeclared, "move_cursor with a declared scope translates");
	if (!("tool" in moveDeclared)) return;
	assertEqual(moveDeclared.args.scope, "desktop", "move_cursor sends a declared scope");
	const moveUndeclared = translateAct({ action: "move_cursor", x: 1, y: 2 }, () => noScope);
	assert("tool" in moveUndeclared, "move_cursor without a declared scope translates");
	if (!("tool" in moveUndeclared)) return;
	assertEqual("scope" in moveUndeclared.args, false, "move_cursor drops an undeclared scope");
});

await run("translateAct: scroll/drag desktop-no-pid fall back to scope=desktop when declared", async () => {
	// A driver whose desktop branch only accepts scope="desktop" (does not declare
	// coordinate_frame) must still receive the desktop marker from scroll/drag,
	// exactly like the click family's pointerArgs already does.
	const scrollScopeOnly: DriverToolInputSchema = { required: [], properties: new Set(["direction", "amount", "x", "y", "scope", "pid", "window_id"]) };
	const scrollBoth: DriverToolInputSchema = { required: [], properties: new Set(["direction", "amount", "x", "y", "scope", "coordinate_frame", "pid", "window_id"]) };

	const scrollScope = translateAct({ action: "scroll", direction: "down", amount: 3, x: 10, y: 20 }, () => scrollScopeOnly);
	assert("tool" in scrollScope, "scroll with a scope-only schema translates");
	if (!("tool" in scrollScope)) return;
	assertEqual(scrollScope.args.scope, "desktop", "desktop scroll without pid sends scope=desktop when only scope is declared");
	assertEqual("coordinate_frame" in scrollScope.args, false, "an undeclared coordinate_frame is not sent");

	const scrollBothSent = translateAct({ action: "scroll", direction: "down", amount: 3, x: 10, y: 20 }, () => scrollBoth);
	assert("tool" in scrollBothSent, "scroll with both declared translates");
	if (!("tool" in scrollBothSent)) return;
	assertEqual(scrollBothSent.args.scope, "desktop", "scroll sends scope when both are declared");
	assertEqual(scrollBothSent.args.coordinate_frame, "desktop", "scroll sends coordinate_frame when both are declared");

	const dragScopeOnly: DriverToolInputSchema = { required: [], properties: new Set(["from_x", "from_y", "to_x", "to_y", "scope", "pid", "window_id"]) };
	const dragScope = translateAct({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 }, () => dragScopeOnly);
	assert("tool" in dragScope, "drag with a scope-only schema translates");
	if (!("tool" in dragScope)) return;
	assertEqual(dragScope.args.scope, "desktop", "desktop drag without pid sends scope=desktop when only scope is declared");
	assertEqual("coordinate_frame" in dragScope.args, false, "drag does not send an undeclared coordinate_frame");

	const dragBoth: DriverToolInputSchema = { required: [], properties: new Set(["from_x", "from_y", "to_x", "to_y", "scope", "coordinate_frame", "pid", "window_id"]) };
	const dragBothSent = translateAct({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 }, () => dragBoth);
	assert("tool" in dragBothSent, "drag with both declared translates");
	if (!("tool" in dragBothSent)) return;
	assertEqual(dragBothSent.args.scope, "desktop", "drag sends scope when both are declared");
	assertEqual(dragBothSent.args.coordinate_frame, "desktop", "drag sends coordinate_frame when both are declared");

	// A window-framed call (pid present) never carries scope, matching pointerArgs.
	const scrollWindow = translateAct({ action: "scroll", direction: "down", x: 1, y: 2, pid: 5 }, () => scrollBoth);
	assert("tool" in scrollWindow, "window-framed scroll translates");
	if (!("tool" in scrollWindow)) return;
	assertEqual("scope" in scrollWindow.args, false, "window-framed scroll with a pid sends no scope");
	const dragWindow = translateAct({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4, pid: 5 }, () => dragBoth);
	assert("tool" in dragWindow, "window-framed drag translates");
	if (!("tool" in dragWindow)) return;
	assertEqual("scope" in dragWindow.args, false, "window-framed drag with a pid sends no scope");
});

await run("backend act() feeds the live tools/list schema into the translation", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	client.schemas.set("click", { required: [], properties: new Set(["element_token", "x", "y"]) });
	client.responses.set("click", textResult("clicked"));
	const handle = await backend.openSession("pix-gen3-aaaa1111");

	await backend.act(handle, { action: "click", pid: 9, window_id: 8, x: 1, y: 2 }, {});
	const args = client.callsFor("click")[0].args;
	assertEqual(args.x, 1, "click x still forwarded");
	assert(!("pid" in args), "undeclared pid is not sent to the driver");
	assert(!("window_id" in args), "undeclared window_id is not sent");
	assert(!("coordinate_frame" in args), "undeclared coordinate_frame is not sent");

	client.schemas.set("scroll", { required: ["direction", "pid"], properties: new Set(["direction", "pid", "window_id"]) });
	client.responses.set("scroll", textResult("scrolled"));
	await backend.act(handle, { action: "scroll", direction: "down", pid: 7, window_id: 6 }, {});
	const scrollArgs = client.callsFor("scroll")[0].args;
	assertEqual(scrollArgs.pid, 7, "declared pid forwarded by the backend");
	assertEqual(scrollArgs.window_id, 6, "declared window_id forwarded by the backend");
});

// ============================================================================
// missingDriverArgs + runtime required check
// ============================================================================

await run("missingDriverArgs: pure schema check", async () => {
	const schema: DriverToolInputSchema = { required: ["pid", "window_id"], properties: new Set(["pid", "window_id"]) };
	assertJson(missingDriverArgs({ pid: 1, window_id: 2 }, schema), [], "all required args present");
	assertJson(missingDriverArgs({ pid: 1 }, schema), ["window_id"], "missing window_id reported");
	assertJson(missingDriverArgs({ pid: 1, window_id: undefined }, schema), ["window_id"], "explicit undefined counts as missing");
	assertJson(missingDriverArgs({}, null), [], "null schema is undecidable -> no missing args");
});

await run("runtime check: get_window_state.required=[pid,window_id] passes when provided", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	client.responses.set("get_window_state", textResult("window tree"));
	const handle = await backend.openSession(HANDLE.driverSession);

	const observation = await backend.observe(
		handle,
		{ view: "window", pid: 10, window_id: 20 },
		{ maxImageDimension: 768, wantImage: false },
	);
	assertEqual(observation.text, "window tree", "the observed window call reached the driver");
	assertEqual(client.callsFor("get_window_state").length, 1, "driver called exactly once");
});

await run("runtime check: Windows-style double_click.required=[pid] rejects the desktop double-click", async () => {
	const { client, backend } = makeBackend("win32-x64");
	installStandardDriver(client);
	client.responses.set("double_click", textResult("clicked"));
	const handle = await backend.openSession(HANDLE.driverSession);
	const callsBefore = client.calls.length;

	const error = await catchComputerUseError(
		() => backend.act(handle, { action: "double_click", x: 5, y: 6, frame: "desktop" }, {}),
		"desktop double_click without pid is rejected",
	);
	if (error === null) return;
	assertEqual(error.code, "invalid_params", "invalid_params code");
	assertEqual(
		error.message,
		"[computer_use:invalid_params] double_click on this platform requires: pid",
		"model-visible invalid_params message",
	);
	assertEqual(client.calls.length, callsBefore, "the driver was not called at all (no double_click, no start_session)");
});

// ============================================================================
// classifyDriverError
// ============================================================================

await run("classifyDriverError: stale / background_unavailable / permission / driver_error", async () => {
	const stale = classifyDriverError(errorResult("element_token s1a2b3c4:5 is stale; re-observe the window", {
		code: "tool_invocation_failed",
	}));
	assertEqual(stale.code, "stale_reference", "stale -> stale_reference");

	const background = classifyDriverError(errorResult("background_unavailable: delivery_mode=background is not supported here", {
		code: "tool_invocation_failed",
	}));
	assertEqual(background.code, "background_unavailable", "background_unavailable -> background_unavailable");

	const permission = classifyDriverError(errorResult("Screen recording permission not granted for this process", {
		code: "tool_invocation_failed",
	}));
	assertEqual(permission.code, "permission_required", "permission -> permission_required");

	const notFound = classifyDriverError(errorResult("No windows found for pid 4242. Provide window_id.", {
		code: "tool_invocation_failed",
	}));
	assertEqual(notFound.code, "driver_error", "not-found stays driver_error (model self-corrects)");
	assertEqual(notFound.message, "No windows found for pid 4242. Provide window_id.", "driver text preserved verbatim");

	const noText = classifyDriverError({ content: [], structuredContent: { code: "tool_invocation_failed" }, isError: true });
	assertEqual(noText.code, "driver_error", "no text -> driver_error");
	assertEqual(noText.message, "tool_invocation_failed", "code used as the message fallback");
});

await run("isError results become ComputerUseError from the backend", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	client.responses.set("get_window_state", errorResult("element_token s1a2b3c4:5 is stale; re-observe the window", {
		code: "tool_invocation_failed",
	}));
	const handle = await backend.openSession(HANDLE.driverSession);

	const error = await catchComputerUseError(
		() => backend.observe(handle, { view: "window", pid: 1, window_id: 2 }, { maxImageDimension: 768, wantImage: false }),
		"isError observation throws",
	);
	if (error === null) return;
	assertEqual(error.code, "stale_reference", "classified error code");
	assert(error.message.startsWith("[computer_use:stale_reference]"), "message carries the code prefix");
	assert(error.message.includes("is stale"), "driver text preserved");
});

await run("background_unavailable errors carry the foreground-retry hint", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	client.responses.set("click", errorResult("background_unavailable: delivery_mode=background is not supported here", {
		code: "tool_invocation_failed",
	}));
	const handle = await backend.openSession(HANDLE.driverSession);

	const error = await catchComputerUseError(
		() => backend.act(handle, { action: "click", pid: 1, window_id: 2, x: 3, y: 4 }, {}),
		"background_unavailable throws",
	);
	if (error === null) return;
	assertEqual(error.code, "background_unavailable", "classified code");
	assert(error.message.startsWith("[computer_use:background_unavailable]"), "message carries the code prefix");
	assert(
		error.message.includes('Retry the same action with delivery="foreground"; PiX will request a foreground grant.'),
		"message includes the foreground-retry hint",
	);
	assertEqual(
		error.hint,
		'Retry the same action with delivery="foreground"; PiX will request a foreground grant.',
		"hint field carries the same text",
	);

	client.responses.set("click", errorResult("No windows found for pid 4242.", { code: "tool_invocation_failed" }));
	const other = await catchComputerUseError(
		() => backend.act(handle, { action: "click", pid: 1, window_id: 2, x: 3, y: 4 }, {}),
		"other driver errors still throw",
	);
	if (other === null) return;
	assertEqual(other.code, "driver_error", "other errors keep their code");
	assertEqual(other.hint, undefined, "other errors keep the no-hint construction");
});

// ============================================================================
// normalizePermissions
// ============================================================================

await run("normalizePermissions: win32 / darwin / linux", async () => {
	assertJson(
		normalizePermissions("win32-x64", { accessibility: false }),
		{ missing: [], degraded: [], undecidable: [] },
		"win32 never blocks",
	);
	assertJson(
		normalizePermissions("win32-arm64", undefined),
		{ missing: [], degraded: [], undecidable: [] },
		"win32 without fields stays empty",
	);
	assertJson(
		normalizePermissions("darwin-universal", { accessibility: false, screen_recording: false }),
		{ missing: ["accessibility", "screen_recording"], degraded: [], undecidable: [] },
		"darwin missing both permissions",
	);
	assertJson(
		normalizePermissions("darwin-universal", { accessibility: true, screen_recording: true }),
		{ missing: [], degraded: [], undecidable: [] },
		"darwin fully granted",
	);
	assertJson(
		normalizePermissions("darwin-universal", { accessibility: true }),
		{ missing: [], degraded: [], undecidable: ["screen_recording"] },
		"darwin undecidable field does not block but is reported",
	);
	assertJson(
		normalizePermissions("darwin-universal", undefined),
		{ missing: [], degraded: [], undecidable: ["accessibility", "screen_recording"] },
		"darwin with no fields: both permissions undecidable, nothing blocks",
	);
	assertJson(
		normalizePermissions("linux-x64", { x11: false, wayland: false, atspi: true, xsend_event: false }),
		{ missing: ["display"], degraded: [], undecidable: [] },
		"linux without X11 and Wayland blocks display",
	);
	assertJson(
		normalizePermissions("linux-x64", { x11: false, wayland: true, atspi: false, xsend_event: false }),
		{ missing: [], degraded: ["accessibility_tree", "background_input"], undecidable: [] },
		"linux wayland-only: degraded AT-SPI and background input",
	);
	assertJson(
		normalizePermissions("linux-x64", { x11: true, wayland: false, atspi: true, xsend_event: false }),
		{ missing: [], degraded: [], undecidable: [] },
		"linux X11 with AT-SPI is fully available",
	);
	assertJson(
		normalizePermissions("linux-arm64", undefined),
		{ missing: [], degraded: [], undecidable: ["x11", "wayland", "atspi"] },
		"linux with no fields: all three reported undecidable, nothing blocks",
	);
	assertJson(
		normalizePermissions("linux-x64", { x11: undefined, wayland: false, atspi: true }),
		{ missing: [], degraded: [], undecidable: ["x11"] },
		"linux undecidable x11 with wayland=false does not block display",
	);
});

// ============================================================================
// CuaDriverBackend: observe / act normalisation
// ============================================================================

await run("observe: text/image/captureId/target normalisation + session injection", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	client.responses.set("get_window_state", {
		content: [
			{ type: "text", text: "Notepad\n  [0] Edit" },
			{ type: "image", data: tinyPng(3, 4), mimeType: "image/png" },
		],
		structuredContent: { capture_id: "cap-1", screenshot_width: 800, screenshot_height: 600, snapshot_id: "snap-1" },
		isError: false,
	});
	const handle = await backend.openSession("pix-gen1-aaaaaaaa");
	assertEqual(handle.driverSession, "pix-gen1-aaaaaaaa", "openSession returns the driver session label");
	assertEqual(client.callsFor("start_session").length, 1, "openSession calls start_session once");
	assertJson(client.calls[0].args, { session: "pix-gen1-aaaaaaaa" }, "start_session carries the session label");

	const observation = await backend.observe(
		handle,
		{ view: "window", pid: 10, window_id: 20 },
		{ maxImageDimension: 1024, wantImage: true },
	);
	assertEqual(observation.text, "Notepad\n  [0] Edit", "text items joined");
	assertEqual(observation.image?.width, 800, "image width from structuredContent screenshot_width");
	assertEqual(observation.image?.height, 600, "image height from structuredContent screenshot_height");
	assertEqual(observation.image?.mimeType, "image/png", "image mimeType preserved");
	assertEqual(observation.captureId, "cap-1", "captureId <- structuredContent.capture_id");
	assertEqual(observation.driverTool, "get_window_state", "driverTool reported");
	assertJson(observation.target, { pid: 10, windowId: 20, frame: "window" }, "target derived from observe params");

	const call = client.callsFor("get_window_state")[0];
	assertEqual(call.args.session, "pix-gen1-aaaaaaaa", "every driver call injects session");
	assertEqual(call.args.pid, 10, "observe forwarded pid");
	assertEqual(call.args.window_id, 20, "observe forwarded window_id");
	assertEqual(call.args.max_image_dimension, 1024, "observe forwarded maxImageDimension");
	assertEqual(call.args.include_screenshot, true, "observe forwarded wantImage");
	assertEqual(client.callsFor("start_session").length, 1, "a live session is not restarted on every call");
});

await run("observe: image dimensions fall back to the PNG/JPEG header", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	const handle = await backend.openSession("pix-gen1-bbbbbbbb");

	client.responses.set("get_window_state", {
		content: [{ type: "image", data: tinyPng(7, 9), mimeType: "image/png" }],
		structuredContent: {},
		isError: false,
	});
	const png = await backend.observe(handle, { view: "window", pid: 1, window_id: 2 }, { maxImageDimension: 768, wantImage: true });
	assertEqual(png.image?.width, 7, "PNG width parsed from the IHDR header");
	assertEqual(png.image?.height, 9, "PNG height parsed from the IHDR header");

	client.responses.set("get_window_state", {
		content: [{ type: "image", data: tinyJpeg(11, 13), mimeType: "image/jpeg" }],
		structuredContent: { screenshot_width: 21 },
		isError: false,
	});
	const jpeg = await backend.observe(handle, { view: "window", pid: 1, window_id: 2 }, { maxImageDimension: 768, wantImage: true });
	assertEqual(jpeg.image?.width, 21, "structuredContent width wins when present");
	assertEqual(jpeg.image?.height, 13, "missing height falls back to the JPEG SOF header");
});

await run("observe: wantImage=false drops the driver image but keeps the call", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	client.responses.set("get_desktop_state", {
		content: [
			{ type: "text", text: "Desktop: 2 windows" },
			{ type: "image", data: tinyPng(2, 2), mimeType: "image/png" },
		],
		structuredContent: { capture_id: "cap-2", screenshot_width: 960, screenshot_height: 600 },
		isError: false,
	});
	const handle = await backend.openSession("pix-gen1-cccccccc");

	const observation = await backend.observe(handle, { view: "desktop" }, { maxImageDimension: 960, wantImage: false });
	assertEqual(observation.image, null, "image dropped for a non-vision model");
	assertEqual(observation.text, "Desktop: 2 windows", "metadata text kept");
	assertEqual(client.callsFor("get_desktop_state").length, 1, "the driver is still called without an image");
	assertEqual(observation.target?.frame, "desktop", "desktop target frame");
});

await run("observe: long text is truncated with the marker", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	const long = "x".repeat(COMPUTER_USE_LIMITS.observationTextMaxChars + 500);
	client.responses.set("list_apps", textResult(long));
	const handle = await backend.openSession("pix-gen1-dddddddd");

	const observation = await backend.observe(handle, { view: "apps" }, { maxImageDimension: 768, wantImage: false });
	assert(
		observation.text.length <= COMPUTER_USE_LIMITS.observationTextMaxChars,
		"truncated text stays within observationTextMaxChars",
	);
	assert(
		/…\[truncated \d+ chars; use query\/max_elements to narrow\]$/.test(observation.text),
		"truncation marker appended at the tail",
	);
	assert(observation.text.startsWith("xxxx"), "text keeps the head of the driver output");
});

await run("observe: snapshot_id and tree metadata normalisation", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	const handle = await backend.openSession("pix-gen1-tree0001");

	client.responses.set("get_window_state", textResult("Window tree", {
		capture_id: "cap-tree",
		snapshot_id: "snap-tree",
		truncated: true,
		truncation_reason: "element_cap",
		elements_complete: false,
		total_element_count: 120,
		returned_element_count: 40,
		filtered_element_count: 3,
	}));
	const full = await backend.observe(handle, { view: "window", pid: 1, window_id: 2 }, { maxImageDimension: 768, wantImage: false });
	assertEqual(full.snapshotId, "snap-tree", "snapshotId <- structuredContent.snapshot_id");
	assertEqual(full.captureId, "cap-tree", "captureId still parsed");
	assertJson(
		full.tree,
		{
			truncated: true,
			truncationReason: "element_cap",
			complete: false,
			totalElements: 120,
			returnedElements: 40,
			filteredElements: 3,
		},
		"tree metadata normalised",
	);

	client.responses.set("get_window_state", textResult("Window tree", { capture_id: "cap-bare" }));
	const bare = await backend.observe(handle, { view: "window", pid: 1, window_id: 2 }, { maxImageDimension: 768, wantImage: false });
	assertEqual(bare.tree, undefined, "no tree fields -> tree undefined");
	assertEqual(bare.snapshotId, undefined, "missing snapshot_id stays undefined");

	client.responses.set("get_window_state", textResult("Window tree", {
		truncated: "yes",
		truncation_reason: 42,
		elements_complete: "no",
		total_element_count: "many",
		returned_element_count: null,
		filtered_element_count: true,
	}));
	const junk = await backend.observe(handle, { view: "window", pid: 1, window_id: 2 }, { maxImageDimension: 768, wantImage: false });
	assertJson(
		junk.tree,
		{
			truncated: false,
			truncationReason: null,
			complete: null,
			totalElements: null,
			returnedElements: null,
			filteredElements: null,
		},
		"non-boolean/non-number tree fields become null",
	);
});

await run("observe: verify result normalisation (only for view=verify)", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	const handle = await backend.openSession("pix-gen1-verify01");
	const expect: ComputerVerifyExpectation[] = [{ window: { exists: true } }];

	client.responses.set("verify_state", textResult("Verified", {
		status: "unsatisfied",
		stable: false,
		samples: 2,
		elapsed_ms: 15,
		predicates: [
			{ index: 0, status: "unknown", unknown_reason: "window_not_found", observed_json: "raw observed text" },
			{ status: "satisfied", observed_json: { role: "button", enabled: true } },
			{ index: 2, status: "bogus" },
			null,
			{ index: 3, status: "unsatisfied", unknown_reason: 7, observed_json: null },
		],
	}));
	const verify = await backend.observe(handle, { view: "verify", pid: 7, window_id: 8, expect }, { maxImageDimension: 768, wantImage: false });
	assertJson(
		verify.verify,
		{
			status: "unsatisfied",
			stable: false,
			samples: 2,
			elapsedMs: 15,
			predicates: [
				{ index: 0, status: "unknown", unknownReason: "window_not_found", observed: "raw observed text" },
				{ index: 1, status: "satisfied", unknownReason: null, observed: '{"role":"button","enabled":true}' },
				{ index: 2, status: "unknown", unknownReason: null, observed: null },
				{ index: 3, status: "unsatisfied", unknownReason: null, observed: null },
			],
		},
		"verify result normalised (index fallback, status fallback, JSON-encoded observed)",
	);

	const longObserved = "z".repeat(400);
	client.responses.set("verify_state", textResult("Verified", {
		status: "unknown",
		stable: true,
		samples: 1,
		elapsed_ms: 0,
		predicates: Array.from({ length: 10 }, (_value, index) => ({ status: "satisfied", observed_json: longObserved })),
	}));
	const limited = await backend.observe(handle, { view: "verify", pid: 7, window_id: 8, expect }, { maxImageDimension: 768, wantImage: false });
	assertEqual(limited.verify?.predicates.length, 8, "predicates limited to 8");
	assertEqual(limited.verify?.predicates[0].observed?.length, 300, "observed_json truncated to 300 chars");
	assertEqual(limited.verify?.stable, true, "stable boolean parsed");
	assertEqual(limited.verify?.samples, 1, "samples parsed");

	// The same fields on a non-verify observation are ignored.
	client.responses.set("get_window_state", textResult("Window", { status: "satisfied", stable: true, samples: 1, predicates: [] }));
	const window = await backend.observe(handle, { view: "window", pid: 1, window_id: 2 }, { maxImageDimension: 768, wantImage: false });
	assertEqual(window.verify, undefined, "verify block dropped unless view=verify");
});

await run("act: effect passthrough, target, session injection", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	client.responses.set("click", textResult("Clicked at (5, 6).", {
		summary: "Clicked at (5, 6).",
		effect: "unverifiable",
		route: "uia",
		delivery: "background",
	}));
	const handle = await backend.openSession("pix-gen1-eeeeeeee");

	const result = await backend.act(handle, { action: "click", pid: 42, window_id: 7, x: 5, y: 6 }, {});
	assertEqual(result.driverTool, "click", "driverTool reported");
	assertEqual(result.effect, "unverifiable", "effect passed through");
	assertEqual(result.text, "Clicked at (5, 6).\n[pix] effect=unverifiable", "effect appended to the action text");
	assertJson(result.target, { pid: 42, windowId: 7, frame: "window" }, "act target derived from params");
	assertEqual(client.callsFor("click")[0].args.session, "pix-gen1-eeeeeeee", "act injects the session");

	client.responses.set("double_click", {
		content: [],
		structuredContent: { summary: "Double-clicked.", effect: "unverifiable" },
		isError: false,
	});
	const fromSummary = await backend.act(handle, { action: "double_click", pid: 42, window_id: 7, x: 5, y: 6 }, {});
	assertEqual(fromSummary.text, "Double-clicked.\n[pix] effect=unverifiable", "structuredContent.summary used when content has no text");
});

await run("act: delivery.mode / route / evidence normalisation", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	client.responses.set("click", textResult("Clicked.", {
		effect: "confirmed",
		delivery: { mode: "foreground" },
		route: "uia",
		evidence: [
			{ kind: "window_state", detail: "title changed" },
			{ kind: "screenshot", detail: null },
			{ kind: "invalid_detail", detail: 42 },
			{ detail: "no kind" },
			"junk",
		],
	}));
	const handle = await backend.openSession("pix-gen1-actnorm1");

	const result = await backend.act(handle, { action: "click", pid: 42, window_id: 7, x: 5, y: 6 }, {});
	assertEqual(result.effect, "confirmed", "effect still parsed");
	assertEqual(result.text, "Clicked.\n[pix] effect=confirmed", "text behavior unchanged");
	assertEqual(result.deliveryMode, "foreground", "deliveryMode <- structuredContent.delivery.mode");
	assertEqual(result.route, "uia", "route <- structuredContent.route");
	assertJson(
		result.evidence,
		[
			{ kind: "window_state", detail: "title changed" },
			{ kind: "screenshot", detail: null },
			{ kind: "invalid_detail", detail: null },
		],
		"evidence keeps records with a string kind; non-string detail becomes null",
	);

	client.responses.set("click", textResult("Clicked.", {
		delivery: { mode: "sideways" },
		evidence: Array.from({ length: 10 }, () => ({ kind: "k", detail: "d" })),
	}));
	const limited = await backend.act(handle, { action: "click", pid: 42, window_id: 7, x: 5, y: 6 }, {});
	assertEqual(limited.deliveryMode, undefined, "unknown delivery.mode dropped");
	assertEqual(limited.route, undefined, "missing route stays undefined");
	assertEqual(limited.evidence?.length, 8, "evidence limited to 8");

	client.responses.set("click", textResult("Clicked.", { delivery: "background" }));
	const legacy = await backend.act(handle, { action: "click", pid: 42, window_id: 7, x: 5, y: 6 }, {});
	assertEqual(legacy.deliveryMode, undefined, "a plain-string delivery field is ignored (only delivery.mode is read)");
});

await run("act: wait never calls the driver", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	const handle = await backend.openSession("pix-gen1-ffffffff");
	const callsBefore = client.calls.length;

	const result = await backend.act(handle, { action: "wait", duration_ms: 250 }, {});
	assertEqual(client.calls.length, callsBefore, "wait does not call the driver");
	assertEqual(result.text, "Waited 250 ms.", "wait reports the duration locally");
	assertEqual(result.driverTool, "wait", "wait has no driver tool");
	assertEqual(result.target, undefined, "wait has no target");
});

// ============================================================================
// CuaDriverBackend: permissions / supports / session lifecycle
// ============================================================================

await run("checkPermissions: prompt=false only when declared; normalised per platform", async () => {
	const { client, backend } = makeBackend("darwin-universal");
	installStandardDriver(client);
	client.schemas.set("check_permissions", { required: [], properties: new Set(["prompt"]) });
	client.responses.set("check_permissions", textResult("permission report", { accessibility: true, screen_recording: false }));

	const report = await backend.checkPermissions();
	assertEqual(client.callsFor("check_permissions")[0].args.prompt, false, "prompt=false sent when the driver declares it");
	assertJson(report, { missing: ["screen_recording"], degraded: [], undecidable: [] }, "darwin report normalised");

	const linux = makeBackend("linux-x64");
	installStandardDriver(linux.client);
	linux.client.schemas.set("check_permissions", { required: [], properties: new Set(["include_details"]) });
	linux.client.responses.set("check_permissions", textResult("permission report", { x11: true, wayland: false, atspi: true }));
	await linux.backend.checkPermissions();
	assert(
		!("prompt" in linux.client.callsFor("check_permissions")[0].args),
		"prompt omitted when the driver does not declare it",
	);
});

await run("supports(): derived from the live tools/list", async () => {
	const { client, backend } = makeBackend();
	for (const name of ["list_apps", "click", "type_text", "bring_to_front"]) client.tools.add(name);

	assertEqual(backend.supports("observe", "apps"), true, "list_apps present -> observe apps supported");
	assertEqual(backend.supports("observe", "desktop"), false, "get_desktop_state missing -> not supported");
	assertEqual(backend.supports("act", "click"), true, "click present -> supported");
	assertEqual(backend.supports("act", "focus_window"), true, "bring_to_front present -> supported");
	assertEqual(backend.supports("act", "hotkey"), false, "hotkey missing -> not supported");
	assertEqual(backend.supports("act", "wait"), true, "wait needs no driver tool");
	assertEqual(backend.supports("observe", "bogus"), false, "unknown view unsupported");
	assertEqual(backend.supports("act", "bogus"), false, "unknown action unsupported");
});

await run("start_session args adapt to the driver's declared tools/list schema", async () => {
	// cua-driver 0.34.1 declares start_session as { label: required, session: optional }; with that
	// schema the historical { session } payload would fail _assertDriverArgs as invalid_params.
	const labelAndSession = makeBackend();
	installStandardDriver(labelAndSession.client);
	labelAndSession.client.schemas.set("start_session", { required: ["label"], properties: new Set(["label", "session"]) });
	const handle = await labelAndSession.backend.openSession("pix-gen4-11111111");
	assertEqual(handle.driverSession, "pix-gen4-11111111", "openSession resolves when the schema requires label");
	assertJson(
		labelAndSession.client.callsFor("start_session")[0]?.args,
		{ label: "pix-gen4-11111111", session: "pix-gen4-11111111" },
		"a schema declaring label+session receives both",
	);

	const labelOnly = makeBackend();
	installStandardDriver(labelOnly.client);
	labelOnly.client.schemas.set("start_session", { required: ["label"], properties: new Set(["label"]) });
	await labelOnly.backend.openSession("pix-gen4-22222222");
	const sent = labelOnly.client.callsFor("start_session")[0]?.args ?? {};
	assertEqual(sent.label, "pix-gen4-22222222", "a label-only schema receives the label");
	assert(!("session" in sent), "an undeclared session key is not sent");

	const sessionOnly = makeBackend();
	installStandardDriver(sessionOnly.client);
	sessionOnly.client.schemas.set("start_session", { required: [], properties: new Set(["session"]) });
	await sessionOnly.backend.openSession("pix-gen4-33333333");
	assertJson(
		sessionOnly.client.callsFor("start_session")[0]?.args,
		{ session: "pix-gen4-33333333" },
		"a session-only schema receives the session",
	);

	const neither = makeBackend();
	installStandardDriver(neither.client);
	neither.client.schemas.set("start_session", { required: [], properties: new Set<string>() });
	await neither.backend.openSession("pix-gen4-44444444");
	assertJson(
		neither.client.callsFor("start_session")[0]?.args,
		{ session: "pix-gen4-44444444" },
		"a schema declaring neither falls back to the historical { session } shape",
	);
});

await run("session lifecycle: restart re-opens lazily, closeSession swallows failures", async () => {
	const { client, backend } = makeBackend();
	installStandardDriver(client);
	client.responses.set("list_apps", textResult("apps"));
	const handle = await backend.openSession("pix-gen2-11111111");
	await backend.observe(handle, { view: "apps" }, { maxImageDimension: 768, wantImage: false });
	assertEqual(client.callsFor("start_session").length, 1, "one start_session before the restart");

	client.emitState("crashed");
	client.emitState("ready"); // the restarted driver has forgotten every session
	await backend.observe(handle, { view: "apps" }, { maxImageDimension: 768, wantImage: false });
	assertEqual(client.callsFor("start_session").length, 2, "start_session re-issued after the driver restart");
	assertJson(client.calls.map((call) => call.tool).slice(-2), ["start_session", "list_apps"], "re-start precedes the next observe");

	client.responses.set("end_session", errorResult("no such session", { code: "tool_invocation_failed" }));
	await backend.closeSession(handle);
	assertEqual(client.callsFor("end_session")[0].args.session, "pix-gen2-11111111", "end_session carries the session label");
	// (closeSession must not throw on the error result; reaching this line is the assertion.)
	passed++;
	console.log("  PASS: closeSession swallowed the end_session failure");
});

// ============================================================================
// Real-driver regression: CuaDriverBackend on the actual MCP fixture process
// ============================================================================

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_DRIVER_SCRIPT = join(FIXTURES_DIR, "fake-cua-driver.mjs");

interface DriverReportLine {
	phase: string;
	name?: string;
	args?: Record<string, unknown>;
}

function readReport(reportPath: string): DriverReportLine[] {
	if (!existsSync(reportPath)) return [];
	return readFileSync(reportPath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as DriverReportLine);
}

await run("regression: label-required start_session on the real fixture process", async () => {
	// The fixture declares start_session as { label: required, session: optional } (the cua-driver
	// 0.34.1 shape); the backend must satisfy the live required-args check and send both fields.
	const dir = mkdtempSync(join(tmpdir(), "pix-computer-use-backend-"));
	const reportPath = join(dir, "driver-report.jsonl");
	const client = new McpDriverClient({
		executablePath: process.execPath,
		cwd: FIXTURES_DIR,
		args: [FAKE_DRIVER_SCRIPT, ...DRIVER_MCP_ARGS],
		extraEnv: { FAKE_DRIVER_REPORT: reportPath },
		startTimeoutMs: 8_000,
		defaultCallTimeoutMs: 4_000,
	});
	try {
		await client.ensureStarted();
		const schema = client.getToolInputSchema("start_session");
		assert(schema !== null, "the fixture exposes a start_session schema");
		assertJson([...(schema?.required ?? [])], ["label"], "the fixture schema requires label (cua-driver 0.34.1 shape)");

		const backend = new CuaDriverBackend(client, "linux-x64");
		const handle = await backend.openSession("pix-gen5-11111111");
		assertEqual(handle.driverSession, "pix-gen5-11111111", "openSession passes the required-args check (no invalid_params)");
		const startCall = readReport(reportPath).find((line) => line.phase === "call" && line.name === "start_session");
		assert(startCall !== undefined, "the fixture logged the start_session call");
		assertJson(startCall?.args, { label: "pix-gen5-11111111", session: "pix-gen5-11111111" }, "{label, session} went over the wire");

		const observation = await backend.observe(handle, { view: "apps" }, { maxImageDimension: 768, wantImage: false });
		assert(observation.text.includes("fake list_apps ok"), "observe runs through the validated translation layer");
		assert(observation.text.includes('"session":"pix-gen5-11111111"'), "observe injects the session into the driver call");
		assertEqual(observation.image, null, "wantImage=false drops the image");
	} finally {
		await client.stop();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Temp cleanup is best effort.
		}
	}
});

await run("regression: full act + observe translation scan on the real fixture process", async () => {
	// Every act action and observe view must run translate -> driver call with legal
	// minimal params against the fixture's real tools/list schemas. Any invalid_params
	// (required-args check) or driver isError result throws ComputerUseError, which the
	// run() wrapper reports as this block failing - nothing is caught or relaxed here.
	const dir = mkdtempSync(join(tmpdir(), "pix-computer-use-backend-"));
	const reportPath = join(dir, "driver-report.jsonl");
	const client = new McpDriverClient({
		executablePath: process.execPath,
		cwd: FIXTURES_DIR,
		args: [FAKE_DRIVER_SCRIPT, ...DRIVER_MCP_ARGS],
		extraEnv: { FAKE_DRIVER_REPORT: reportPath },
		startTimeoutMs: 8_000,
		defaultCallTimeoutMs: 4_000,
	});
	try {
		await client.ensureStarted();
		const backend = new CuaDriverBackend(client, "linux-x64");
		const handle = await backend.openSession("pix-gen6-11111111");

		const actCases: Array<[string, ComputerActParams]> = [
			["click by element_token", { action: "click", pid: 42, window_id: 7, element_token: "s1a2b3c4:5" }],
			["click by coordinates", { action: "click", x: 10, y: 20 }],
			["double_click", { action: "double_click", x: 10, y: 20 }],
			["right_click", { action: "right_click", x: 10, y: 20 }],
			["type_text", { action: "type_text", text: "hello" }],
			["press_key", { action: "press_key", key: "enter" }],
			["hotkey", { action: "hotkey", keys: ["ctrl", "c"] }],
			["scroll with pid/window_id", { action: "scroll", direction: "down", amount: 3, pid: 42, window_id: 7 }],
			["drag", { action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 }],
			["move_cursor", { action: "move_cursor", x: 5, y: 6 }],
			["set_value", { action: "set_value", pid: 42, element_token: "s1a2b3c4:5", value: "v" }],
			["invoke_menu", { action: "invoke_menu", pid: 42, window_id: 7, menu_path: ["File", "Save"] }],
			["launch_app", { action: "launch_app", app: "notepad" }],
		];
		for (const [name, params] of actCases) {
			const result = await backend.act(handle, params, {});
			assert(
				result.text.includes(`fake ${result.driverTool} ok`),
				`act ${name}: translated call reached the driver (no invalid_params / isError)`,
			);
		}

		const observeCases: Array<[string, ComputerObserveParams]> = [
			["apps", { view: "apps" }],
			["windows", { view: "windows" }],
			["window", { view: "window", pid: 42, window_id: 7 }],
			["desktop", { view: "desktop" }],
			["zoom", { view: "zoom", pid: 42, window_id: 7, region: { x1: 0, y1: 0, x2: 10, y2: 10 } }],
		];
		for (const [name, params] of observeCases) {
			const observation = await backend.observe(handle, params, { maxImageDimension: 768, wantImage: false });
			assert(
				observation.text.includes(`fake ${observation.driverTool} ok`),
				`observe ${name}: translated call reached the driver (no invalid_params / isError)`,
			);
		}

		// The wire log proves scroll actually carried pid/window_id through the fixture's schema.
		const scrollCall = readReport(reportPath).filter((line) => line.phase === "call" && line.name === "scroll").at(-1);
		assert(scrollCall !== undefined, "the fixture logged the scroll call");
		assertEqual(scrollCall?.args?.pid, 42, "scroll carried pid over the wire (fixture declares it)");
		assertEqual(scrollCall?.args?.window_id, 7, "scroll carried window_id over the wire");
	} finally {
		await client.stop();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Temp cleanup is best effort.
		}
	}
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
	process.exit(1);
}
