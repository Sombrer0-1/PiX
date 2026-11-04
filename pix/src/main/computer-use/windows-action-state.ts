import type { ComputerActParams, ComputerVerifyExpectation } from "../../shared/computer-use-types.js";
import type { WindowsVerificationElement, WindowsVerificationSnapshot } from "./windows-verification.js";

export interface WindowsActionTarget {
	pid: number;
	window_id: number;
	selector: NonNullable<ComputerVerifyExpectation["element"]>["selector"];
	label: string;
	role: string;
}

/** Resolve the caller's exact snapshot token before collecting independent native evidence. */
export function windowsActionTarget(params: ComputerActParams, snapshot: Record<string, unknown> | undefined): WindowsActionTarget | null {
	if (!params.element_token || !Array.isArray(snapshot?.elements)) return null;
	const entry: unknown = snapshot.elements.find((candidate: unknown) => typeof candidate === "object" && candidate !== null
		&& (candidate as Record<string, unknown>).element_token === params.element_token);
	if (typeof entry !== "object" || entry === null) return null;
	const element = entry as Record<string, unknown>;
	if (typeof element.role !== "string" || typeof element.label !== "string") return null;
	if (params.action === "click" && typeof element.selected !== "boolean" && !(Array.isArray(element.actions) && element.actions.includes("toggle"))) return null;
	if (!["click", "type_text", "set_value"].includes(params.action)) return null;
	const pid = params.pid ?? snapshot?.pid;
	const windowId = params.window_id ?? snapshot?.window_id;
	if (typeof pid !== "number" || typeof windowId !== "number") return null;
	return { pid, window_id: windowId, selector: { role: element.role, ...(element.label ? { label_contains: element.label } : {}) }, label: element.label, role: element.role };
}

export function nativeActionElement(target: WindowsActionTarget, snapshot: WindowsVerificationSnapshot): WindowsVerificationElement | null {
	if (!snapshot.complete || snapshot.pid !== target.pid || snapshot.window_id !== target.window_id) return null;
	const matches = snapshot.elements.filter((element) => element.role.toLowerCase() === target.role.toLowerCase() && element.label === target.label
		&& element.process_id === target.pid && !element.web_ancestor);
	return matches.length === 1 ? matches[0] : null;
}

export function normalizeWindowsText(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

/** TextPattern includes a virtual final paragraph in some native editors. */
export function expectedInsertedText(before: WindowsVerificationElement, text: string): string | null {
	if (before.value === undefined || before.value_truncated || before.text_document === undefined
		|| before.selection_prefix === undefined || before.selection_text === undefined) return null;
	const value = normalizeWindowsText(before.value);
	const document = normalizeWindowsText(before.text_document);
	if (document !== value && document !== `${value}\n`) return null;
	const start = Math.min(normalizeWindowsText(before.selection_prefix).length, value.length);
	const end = Math.min(start + normalizeWindowsText(before.selection_text).length, value.length);
	return value.slice(0, start) + normalizeWindowsText(text) + value.slice(end);
}

export function confirmedWindowsAction(params: ComputerActParams, before: WindowsVerificationElement | null, after: WindowsVerificationElement | null): boolean {
	if (!before || !after || before.runtime_id !== after.runtime_id || after.value_truncated) return false;
	if (params.action === "set_value") return after.value !== undefined && normalizeWindowsText(after.value) === normalizeWindowsText(params.value ?? "");
	if (params.action === "type_text") {
		const expected = expectedInsertedText(before, params.text ?? "");
		return expected !== null && after.value !== undefined && normalizeWindowsText(after.value) === expected;
	}
	return params.action === "click" && before.selected !== undefined && after.selected === !before.selected;
}
