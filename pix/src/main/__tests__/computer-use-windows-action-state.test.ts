import assert from "node:assert/strict";
import { confirmedWindowsAction, expectedInsertedText, nativeActionElement, windowsActionTarget } from "../computer-use/windows-action-state.js";
import type { WindowsVerificationElement } from "../computer-use/windows-verification.js";
import { limitWindowQuery } from "../computer-use/window-query.js";

const before: WindowsVerificationElement = {
	role: "Document", label: "Text editor", runtime_id: "42,7,3", process_id: 42,
	framework_id: "Win32", class_name: "RichEditD2DPT", web_ancestor: false,
	value: "prefix OLD suffix", text_document: "prefix OLD suffix\r", selection_prefix: "prefix ", selection_text: "OLD",
};
assert.equal(expectedInsertedText(before, "中文\n123 !@#"), "prefix 中文\n123 !@# suffix");
assert.equal(expectedInsertedText({ ...before, value: "", text_document: "\r", selection_prefix: "", selection_text: "" }, "A1\nA2"), "A1\nA2");
assert.equal(expectedInsertedText({ ...before, selection_text: undefined }, "abc"), null);
assert.equal(expectedInsertedText({ ...before, text_document: "unrelated text" }, "abc"), null);
assert.equal(expectedInsertedText({ ...before, value_truncated: true }, "abc"), null);
assert.equal(confirmedWindowsAction({ action: "type_text", text: "中文\n123 !@#" }, before, { ...before, value: "prefix 中文\r123 !@# suffix" }), true);
assert.equal(confirmedWindowsAction({ action: "type_text", text: "中文\n123 !@#" }, before, { ...before, value: "prefix 中文\r321 !@# suffix" }), false, "read-back checks the complete expected value, including character order");
assert.equal(confirmedWindowsAction({ action: "set_value", value: "A1\nA2" }, before, { ...before, value: "A1\r\nA2" }), true);
assert.equal(confirmedWindowsAction({ action: "set_value", value: "A1\nA2" }, before, { ...before, runtime_id: "new-control", value: "A1\nA2" }), false);
assert.equal(confirmedWindowsAction({ action: "click" }, { ...before, selected: false }, { ...before, selected: true }), true);
assert.equal(confirmedWindowsAction({ action: "click" }, { ...before, selected: false }, { ...before, selected: false }), false);

const target = windowsActionTarget({ action: "set_value", pid: 42, window_id: 7, element_token: "s00000001:3" }, {
	elements: [{ role: "Document", label: "Text editor", element_token: "s00000001:3" }],
});
assert.ok(target);
assert.equal(nativeActionElement(target, { pid: 42, window_id: 7, complete: true, elements: [before] }), before);
assert.equal(nativeActionElement(target, { pid: 42, window_id: 7, complete: true, elements: [before, before] }), null, "ambiguous identity cannot confirm an action");
assert.equal(nativeActionElement(target, { pid: 42, window_id: 7, complete: false, elements: [before] }), null);

const projected = limitWindowQuery({ isError: false, content: [{ type: "text", text: "old ancestors" }], structuredContent: {
	window_id: 7, snapshot_id: "s00000001", total_element_count: 100,
	elements: [{ index: 0, role: "Window", label: "Notepad" }, { index: 1, role: "Group", label: "Toolbar" },
		{ index: 80, role: "Button", label: "Bold", element_token: "s00000001:80" },
		{ index: 90, role: "Button", label: "Bold options", element_token: "s00000001:90" }],
} }, "Bold", 1);
assert.deepEqual(projected.structuredContent?.elements, [{ index: 80, role: "Button", label: "Bold", element_token: "s00000001:80" }]);
assert.equal(projected.structuredContent?.returned_element_count, 1);
assert.equal(projected.structuredContent?.filtered_element_count, 2);
assert.equal(projected.structuredContent?.truncated, true);
assert.equal(projected.structuredContent?.snapshot_id, "s00000001");
assert.ok(projected.content[0].type === "text" && !projected.content[0].text.includes("Toolbar"));

console.log("PASS: native text/selection read-back, runtime identity, toggle confirmation and query output budgets.");
