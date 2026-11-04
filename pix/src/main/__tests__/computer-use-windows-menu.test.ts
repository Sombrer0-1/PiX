import assert from "node:assert/strict";
import { ComputerUseError, type DriverToolResult } from "../computer-use/contracts.js";
import { invokeWindowsMenu } from "../computer-use/windows-menu.js";

const result = (elements: unknown[]): DriverToolResult => ({ content: [], structuredContent: { elements }, isError: false });
const item = (label: string, token: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	label, element_token: token, role: "MenuItem", enabled: true, actions: ["invoke"], frame: { x: 0, y: 0, w: 100, h: 30 }, ...extra,
});
const target = { pid: 42, window_id: 7, menu_path: ["File", "Save"] };

{
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	let observations = 0;
	const outcome = await invokeWindowsMenu(target, async (tool, args) => {
		calls.push({ tool, args });
		if (tool === "get_window_state") return ++observations === 1
			? result([item("File", "s00000001:1", { actions: ["invoke", "expand"] })])
			: result([item("Save", "s00000002:2")]);
		return { content: [{ type: "text", text: "Dispatched" }], structuredContent: { effect: "unverifiable" }, isError: false };
	});
	assert.deepEqual(calls.map((call) => call.tool), ["get_window_state", "click", "get_window_state", "click"]);
	assert.equal(calls[1].args.element_token, "s00000001:1");
	assert.equal(calls[1].args.action, "expand");
	assert.equal(calls[3].args.element_token, "s00000002:2");
	assert.equal(calls[3].args.action, undefined);
	assert.equal(calls[1].args.delivery_mode, "background");
	assert.equal(outcome.structuredContent?.effect, "unverifiable");
	assert.equal(outcome.structuredContent?.route, "uia_menu_path");
}

{
	let reads = 0;
	let clicks = 0;
	await invokeWindowsMenu(target, async (tool) => {
		if (tool === "click") { clicks++; return result([]); }
		reads++;
		return result(reads === 1 ? [item("File", "s00000001:1")] : reads === 2 ? [] : [item("Save", "s00000003:2")]);
	});
	assert.equal(reads, 3, "wait for asynchronously published popup children");
	assert.equal(clicks, 2, "each menu action is dispatched once");
}

for (const [name, elements] of [
	["duplicate menu items", [item("File", "s00000001:1"), item("File", "s00000001:2")]],
	["disabled item", [item("File", "s00000001:1", { enabled: false })]],
	["collapsed item", [item("File", "s00000001:1", { frame: { w: 0, h: 0 } })]],
	["missing bounds", [item("File", "s00000001:1", { frame: undefined })]],
	["document text", [item("File", "s00000001:1", { role: "Text" })]],
] as const) {
	let clicks = 0;
	await assert.rejects(invokeWindowsMenu({ ...target, menu_path: ["File"] }, async (tool) => {
		if (tool === "click") clicks++;
		return result([...elements]);
	}), ComputerUseError, name);
	assert.equal(clicks, 0, `${name}: no action dispatched`);
}

{
	let clickedToken: unknown;
	await invokeWindowsMenu({ ...target, menu_path: ["File"] }, async (tool, args) => {
		if (tool === "click") { clickedToken = args.element_token; return result([]); }
		return result([item("File", "s00000001:1"), item("File", "s00000001:2", { role: "Button", actions: ["expand"] })]);
	});
	assert.equal(clickedToken, "s00000001:1");
}

{
	let clicks = 0;
	await assert.rejects(invokeWindowsMenu(target, async (tool) => {
		if (tool === "click") { clicks++; return result([]); }
		return clicks === 0 ? result([item("File", "s00000001:1")])
			: result([item("Save", "s00000002:1"), item("Save", "s00000002:2")]);
	}), (error: unknown) => error instanceof ComputerUseError && error.detail.includes("Previous menu hops were dispatched"));
	assert.equal(clicks, 1, "a failed path reports partial progress without replaying previous hops");
}

{
	const abort = new AbortController();
	let clicks = 0;
	await assert.rejects(invokeWindowsMenu(target, async (tool) => {
		if (tool === "click") { clicks++; abort.abort(); return result([]); }
		return result([item("File", "s00000001:1")]);
	}, abort.signal), (error: unknown) => error instanceof ComputerUseError && error.code === "cancelled");
	assert.equal(clicks, 1, "cancellation stops before the next menu hop");
}

console.log("PASS: Windows menu paths use fresh tokens, wait for popup state, and reject ambiguous or unavailable items.");
