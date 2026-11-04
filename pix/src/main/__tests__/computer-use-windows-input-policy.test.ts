import assert from "node:assert/strict";
import type { ComputerActParams } from "../../shared/computer-use-types.js";
import { ComputerUseError, type DriverToolResult } from "../computer-use/contracts.js";
import { assertWindowsBackgroundKeyboardAllowed } from "../computer-use/windows-input-policy.js";

const target = { pid: 42, window_id: 7 };
const diagnostic = (structuredContent: Record<string, unknown>): DriverToolResult => ({ content: [], structuredContent, isError: false });
const legacy = diagnostic({ exe_xaml_match: false, xaml_routing_recommended: false, windows: [{ hwnd: 7, xaml_class_match: false }] });
const modern = diagnostic({ exe_xaml_match: true, xaml_routing_recommended: true, windows: [{ hwnd: 7, xaml_class_match: false }] });
const isBackgroundRefusal = (error: unknown): boolean => error instanceof ComputerUseError
	&& error.code === "background_unavailable" && error.detail.includes("no input was sent") && Boolean(error.hint?.includes('delivery="foreground"'));

for (const action of ["type_text", "press_key", "hotkey"] as const) {
	let reads = 0;
	await assert.rejects(assertWindowsBackgroundKeyboardAllowed({ ...target, action, element_token: "s00000001:2" }, async () => {
		reads++;
		return modern;
	}), isBackgroundRefusal, `${action}: a token cannot turn XAML keyboard events into background input`);
	assert.equal(reads, 1);
	await assertWindowsBackgroundKeyboardAllowed({ ...target, action }, async () => legacy);
}

for (const params of [
	{ ...target, action: "type_text", delivery: "foreground" },
	{ ...target, action: "press_key", delivery: "foreground" },
	{ ...target, action: "hotkey", delivery: "foreground" },
	{ ...target, action: "set_value", delivery: "background" },
	{ ...target, action: "click", delivery: "background" },
] satisfies ComputerActParams[]) {
	await assertWindowsBackgroundKeyboardAllowed(params, async () => { throw new Error("semantic UIA and foreground routes do not need a keyboard diagnostic"); });
}

await assertWindowsBackgroundKeyboardAllowed({ ...target, action: "press_key" }, async () => diagnostic({
	exe_xaml_match: false,
	xaml_routing_recommended: true,
	windows: [{ hwnd: 7, xaml_class_match: false }, { hwnd: 8, xaml_class_match: true }],
}));

await assert.rejects(assertWindowsBackgroundKeyboardAllowed({ ...target, action: "press_key" }, async () => diagnostic({
	exe_xaml_match: false,
	xaml_routing_recommended: true,
	windows: [{ hwnd: 7, xaml_class_match: true }],
})), isBackgroundRefusal);

await assert.rejects(assertWindowsBackgroundKeyboardAllowed({ pid: 42, action: "type_text" }, async () => modern), isBackgroundRefusal);
await assert.rejects(assertWindowsBackgroundKeyboardAllowed({ ...target, action: "type_text" }, async () => null), isBackgroundRefusal);
await assert.rejects(assertWindowsBackgroundKeyboardAllowed({ ...target, action: "type_text" }, async () => diagnostic({})), isBackgroundRefusal);
await assert.rejects(assertWindowsBackgroundKeyboardAllowed({ ...target, action: "type_text" }, async () => diagnostic({
	exe_xaml_match: false, xaml_routing_recommended: false, windows: [],
})), isBackgroundRefusal, "missing requested HWND is not a proven legacy target");
await assert.rejects(assertWindowsBackgroundKeyboardAllowed({ action: "type_text" }, async () => { throw new Error("no pid to inspect"); }), isBackgroundRefusal);

const cancelled = new ComputerUseError("cancelled", "Stopped by user");
await assert.rejects(assertWindowsBackgroundKeyboardAllowed({ ...target, action: "type_text" }, async () => { throw cancelled; }), (error: unknown) => error === cancelled);

console.log("PASS: Windows keyboard policy preserves foreground and semantic UIA, and refuses unsupported or undetermined background input before dispatch.");
