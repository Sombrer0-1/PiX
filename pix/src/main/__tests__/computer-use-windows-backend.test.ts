import assert from "node:assert/strict";
import type { ComputerActParams } from "../../shared/computer-use-types.js";
import {
	ComputerUseError,
	type DriverClient,
	type DriverClientState,
	type DriverToolInputSchema,
	type DriverToolResult,
	type BackendVerifyResult,
} from "../computer-use/contracts.js";
import { CuaDriverBackend } from "../computer-use/cua-backend.js";

const POST_CLICK_ERROR = "Failed to click: foreground_unavailable: exact target HWND 0x100 or a verified same-process post-action window was not foreground after the click (actual foreground HWND 0x0)";
const PRE_CLICK_ERROR = "foreground_unavailable: Windows did not activate exact target HWND 0x100 (actual foreground HWND 0x200); no mouse input was sent";

class WindowsDriver implements DriverClient {
	state: DriverClientState = "ready";
	readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	readonly schemas = new Map<string, DriverToolInputSchema>();
	readonly listeners = new Set<(state: DriverClientState, detail?: string) => void>();
	readonly tools = new Set(["start_session", "click", "double_click", "right_click", "press_key", "hotkey", "debug_window_info"]);
	handler?: (tool: string, args: Record<string, unknown>) => DriverToolResult;
	response: DriverToolResult = { content: [{ type: "text", text: POST_CLICK_ERROR }], isError: true };
	async ensureStarted(): Promise<void> {}
	listToolNames(): ReadonlySet<string> { return this.tools; }
	getToolInputSchema(name: string): DriverToolInputSchema | null { return this.schemas.get(name) ?? null; }
	async callTool(tool: string, args: Record<string, unknown>): Promise<DriverToolResult> {
		this.calls.push({ tool, args });
		return tool === "start_session" ? { content: [], isError: false } : this.handler?.(tool, args) ?? this.response;
	}
	cancelAll(): void {}
	async stop(): Promise<void> {}
	onStateChange(listener: (state: DriverClientState, detail?: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

const handle = { driverSession: "windows-regressions" };
const click: ComputerActParams = { action: "click", pid: 42, window_id: 100, x: 20, y: 10, delivery: "foreground" };

for (const action of ["click", "double_click", "right_click"] as const) {
	const driver = new WindowsDriver();
	const backend = new CuaDriverBackend(driver, "win32-x64");
	const result = await backend.act(handle, { ...click, action }, {});
	assert.equal(result.effect, "unverifiable");
	assert.equal(result.deliveryMode, "foreground");
	assert.equal(result.route, "send_input");
	assert.equal(result.evidence?.[0].detail, POST_CLICK_ERROR);
	assert.match(result.text, /Mouse input was dispatched/);
	assert.equal(driver.calls.filter((call) => call.tool === action).length, 1, "an already dispatched click is never replayed");
}

for (const message of [
	PRE_CLICK_ERROR,
	"foreground_unavailable: exact target HWND 0x100 disappeared before mouse input could be sent",
	"SendInput inserted fewer modifier or mouse events than expected for the foreground click.",
]) {
	const driver = new WindowsDriver();
	driver.response = { content: [{ type: "text", text: message }], isError: true };
	await assert.rejects(new CuaDriverBackend(driver, "win32-x64").act(handle, click, {}), ComputerUseError);
}

for (const [platform, params] of [
	["linux-x64", click],
	["win32-x64", { ...click, delivery: "background" }],
	["win32-x64", { ...click, action: "press_key", key: "enter" }],
] as const) {
	await assert.rejects(new CuaDriverBackend(new WindowsDriver(), platform).act(handle, params, {}), ComputerUseError);
}

const unavailable = new WindowsDriver();
unavailable.response = { content: [{ type: "text", text: "hotkey on a modern XAML / UWP target could not find a UIA AcceleratorKey matching Ctrl+S" }], isError: true };
unavailable.handler = (tool) => tool === "debug_window_info"
	? { content: [], isError: false, structuredContent: { exe_xaml_match: false, windows: [{ hwnd: 100, xaml_class_match: false }] } }
	: unavailable.response;
await assert.rejects(
	new CuaDriverBackend(unavailable, "win32-x64").act(handle, { action: "hotkey", keys: ["ctrl", "s"], pid: 42, window_id: 100 }, {}),
	(error: unknown) => error instanceof ComputerUseError && error.code === "background_unavailable" && error.message.includes('delivery="foreground"'),
);

for (const [keys, expectedModifiers] of [
	[["ctrl", "s"], ["ctrl"]],
	[["S", " Control ", "Shift"], ["ctrl", "shift"]],
	[["cmd", "option", "x"], ["win", "alt"]],
] as const) {
	const driver = new WindowsDriver();
	driver.response = { content: [{ type: "text", text: "Sent chord via SendInput" }], isError: false };
	const result = await new CuaDriverBackend(driver, "win32-x64").act(handle, { action: "hotkey", keys: [...keys], pid: 42, window_id: 100, delivery: "foreground" }, {});
	assert.equal(driver.calls.at(-1)?.tool, "press_key");
	assert.equal(driver.calls.at(-1)?.args.key, keys[0] === "cmd" ? "x" : "s");
	assert.deepEqual(driver.calls.at(-1)?.args.modifiers, [...expectedModifiers]);
	assert.equal(driver.calls.at(-1)?.args.delivery_mode, "foreground");
	assert.equal(driver.calls.at(-1)?.args.pid, 42);
	assert.equal(driver.calls.at(-1)?.args.window_id, 100);
	assert.equal(result.driverTool, "press_key");
	assert.equal(result.effect, "unverifiable");
	assert.equal(result.route, "send_input");
}

for (const keys of [["ctrl", "shift"], ["ctrl", "a", "b"]]) {
	const driver = new WindowsDriver();
	await assert.rejects(new CuaDriverBackend(driver, "win32-x64").act(handle, { action: "hotkey", keys, delivery: "foreground" }, {}), ComputerUseError);
	assert.equal(driver.calls.length, 0, "invalid chords do not open a session or dispatch input");
}

for (const action of ["press_key", "hotkey"] as const) {
	const driver = new WindowsDriver();
	driver.response = { content: [], isError: false };
	await new CuaDriverBackend(driver, "win32-x64").act(handle, { action, key: "enter", keys: ["ctrl", "s"], delivery: "foreground" }, {});
	assert.equal(driver.calls.at(-1)?.args.scope, "desktop", "untargeted key input uses the declared desktop route");
}

const menuDriver = new WindowsDriver();
let menuReads = 0;
menuDriver.handler = (tool) => tool === "get_window_state"
	? {
		content: [], isError: false,
		structuredContent: { elements: [{ label: ++menuReads === 1 ? "File" : "Save", role: "MenuItem", element_token: `s0000000${menuReads}:1`, enabled: true, actions: ["invoke"], frame: { x: 0, y: 0, w: 100, h: 30 } }] },
	}
	: { content: [{ type: "text", text: "Menu action dispatched" }], isError: false, structuredContent: { effect: "unverifiable" } };
const menuResult = await new CuaDriverBackend(menuDriver, "win32-x64").act(handle, { action: "invoke_menu", pid: 42, window_id: 100, menu_path: ["File", "Save"] }, {});
assert.deepEqual(menuDriver.calls.map((call) => call.tool), ["start_session", "get_window_state", "click", "get_window_state", "click"]);
assert.equal(menuDriver.calls[2].args.element_token, "s00000001:1");
assert.equal(menuDriver.calls[4].args.element_token, "s00000002:1");
assert.equal(menuDriver.calls[4].args.session, handle.driverSession);
assert.equal(menuResult.driverTool, "click");
assert.equal(menuResult.route, "uia_menu_path");

const desktopDriver = new WindowsDriver();
const desktopBackend = new CuaDriverBackend(desktopDriver, "win32-x64");
const desktopImage: DriverToolResult = {
	isError: false,
	content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
	structuredContent: { screenshot_width: 1568, screenshot_height: 882, screen_width: 1920, screen_height: 1080, capture_id: "desktop-1" },
};
desktopDriver.response = desktopImage;
await desktopBackend.observe(handle, { view: "desktop" }, { maxImageDimension: 1568, wantImage: true });
desktopDriver.response = { content: [], isError: false };
await desktopBackend.act(handle, { action: "move_cursor", x: 784, y: 441 }, {});
assert.equal(desktopDriver.calls.at(-1)?.args.x, 960);
assert.equal(desktopDriver.calls.at(-1)?.args.y, 540);
desktopDriver.schemas.set("click", { required: [], properties: new Set(["x", "y", "scope", "coordinate_frame"]) });
await desktopBackend.act(handle, { action: "click", x: 784, y: 441, capture_id: "desktop-1" }, {});
assert.equal(desktopDriver.calls.at(-1)?.args.capture_id, undefined, "unsupported capture_id is omitted");
assert.equal(desktopDriver.calls.at(-1)?.args.x, 960, "a driver route without capture binding receives physical coordinates");
desktopDriver.schemas.delete("click");
await desktopBackend.act(handle, { action: "click", x: 784, y: 441, capture_id: "desktop-1" }, {});
assert.equal(desktopDriver.calls.at(-1)?.args.x, 784, "a capture-bound driver click is not scaled twice");
for (const listener of desktopDriver.listeners) listener("ready");
await assert.rejects(desktopBackend.act(handle, { action: "move_cursor", x: 784, y: 441 }, {}), ComputerUseError);
desktopDriver.response = desktopImage;
await desktopBackend.observe(handle, { view: "desktop" }, { maxImageDimension: 1568, wantImage: true });
await desktopBackend.closeSession(handle);
await assert.rejects(desktopBackend.act(handle, { action: "move_cursor", x: 784, y: 441 }, {}), ComputerUseError);

for (const action of ["type_text", "press_key", "hotkey"] as const) {
	const driver = new WindowsDriver();
	driver.response = { content: [], isError: false, structuredContent: { exe_xaml_match: true } };
	await assert.rejects(new CuaDriverBackend(driver, "win32-x64").act(handle,
		{ action, pid: 42, window_id: 100, text: "abc 123 !@#", key: "enter", keys: ["ctrl", "end"], element_token: "s00000001:1" }, {}),
		(error: unknown) => error instanceof ComputerUseError && error.code === "background_unavailable");
	assert.deepEqual(driver.calls.map((call) => call.tool), ["start_session", "debug_window_info"], "a diagnostic neither types input nor invalidates the token snapshot");
}

const legacyDriver = new WindowsDriver();
legacyDriver.handler = (tool) => tool === "debug_window_info"
	? { content: [], isError: false, structuredContent: { exe_xaml_match: false, windows: [{ hwnd: 100, xaml_class_match: false }] } }
	: tool === "get_window_state" ? { content: [], isError: false, structuredContent: { elements: [{ role: "Document", label: "Editor", element_token: "s00000001:2" }] } }
	: { content: [{ type: "text", text: "Legacy key dispatched" }], isError: false };
const legacyBackend = new CuaDriverBackend(legacyDriver, "win32-x64");
await legacyBackend.act(handle, { action: "press_key", key: "enter", pid: 42, window_id: 100 }, {});
assert.equal(legacyDriver.calls.at(-1)?.tool, "press_key", "supported legacy background delivery remains available");
await legacyBackend.observe(handle, { view: "window", pid: 42, window_id: 100 }, { maxImageDimension: 1568, wantImage: false });
await legacyBackend.act(handle, { action: "hotkey", keys: ["ctrl", "s"], pid: 42, window_id: 100, element_token: "s00000001:2" }, {});
assert.equal(legacyDriver.calls.at(-1)?.args.element_token, "s00000001:2", "hotkeys preserve the explicitly requested editor focus target");
await assert.rejects(legacyBackend.act(handle, { action: "hotkey", keys: ["ctrl", "s"], pid: 42, window_id: 100, element_token: "s00000001:2" }, {}),
	(error: unknown) => error instanceof ComputerUseError && error.code === "stale_reference");

const verifyDriver = new WindowsDriver();
verifyDriver.response = {
	content: [{ type: "text", text: "Old driver: unknown untrusted_source" }], isError: false,
	structuredContent: { status: "unknown", stable: false, samples: 2, predicates: [{ index: 0, status: "unknown", unknown_reason: "untrusted_source", observed_json: { matches: 1 } }] },
};
let nativeCalls = 0;
const nativeVerification: BackendVerifyResult = {
	status: "satisfied", stable: true, samples: 2, elapsedMs: 100,
	predicates: [{ index: 0, status: "satisfied", unknownReason: null, observed: '{"source":"windows_uia","runtime_id":"42,7,3","value":"0123456789"}' }],
};
const verifyBackend = new CuaDriverBackend(verifyDriver, "win32-x64", { verifyNative: async (target, expect) => {
	nativeCalls++;
	assert.deepEqual(target, { pid: 42, window_id: 100 });
	assert.equal(expect[0].element?.value_equals, "0123456789");
	return nativeVerification;
} });
const verification = await verifyBackend.observe(handle,
	{ view: "verify", pid: 42, window_id: 100, expect: [{ element: { selector: { role: "Document" }, value_equals: "0123456789" } }] },
	{ maxImageDimension: 1568, wantImage: false });
assert.equal(nativeCalls, 1);
assert.equal(verification.verify?.status, "satisfied");
assert.equal(verification.verify?.stable, true);
assert.match(verification.text, /Native Windows UIA evidence/);
assert.doesNotMatch(verification.text, /Old driver/, "the final summary uses the newly verified state");

const browserBackend = new CuaDriverBackend(verifyDriver, "win32-x64", { verifyNative: async () => ({
	...nativeVerification, status: "unknown", stable: false,
	predicates: [{ index: 0, status: "unknown", unknownReason: "untrusted_source", observed: null }],
}) });
const browserVerification = await browserBackend.observe(handle,
	{ view: "verify", pid: 42, window_id: 100, expect: [{ element: { selector: { role: "Document" }, exists: true } }] },
	{ maxImageDimension: 1568, wantImage: false });
assert.equal(browserVerification.verify?.status, "unknown", "independently untrusted web evidence is never relabelled satisfied");

console.log("Windows backend regressions passed.");
