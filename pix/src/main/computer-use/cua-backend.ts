/**
 * cua-driver backend.
 *
 * Translates PiX tools to cua-driver calls:
 *  - translateObserve / translateAct turn the two PiX tool surfaces
 *    (computer_observe / computer_act) into `{ tool, args }` for the driver,
 *    following the translation table; `wait` never reaches the driver (the
 *    controller performs the local, signal-interruptible sleep);
 *  - every call is validated against the live tools/list inputSchema
 *    (missingDriverArgs) BEFORE the driver is touched, so platform-specific
 *    requirements surface as a deterministic invalid_params instead of a
 *    driver_error;
 *  - act translations are schema-adaptive: the driver-optional targeting fields
 *    (coordinate_frame / scope / pid / window_id) are sent only when the live
 *    tools/list schema declares them, so the payload stays valid no matter which
 *    platform-specific parameter subset the driver exposes (a null schema means
 *    undecidable and keeps the historical payload);
 *  - check_permissions results are normalised per platform into
 *    ComputerPermissionReport with three-valued semantics (missing field =
 *    undecidable -> never blocking, but reported in `undecidable`);
 *  - driver results are normalised into the contracts.ts shapes: text items
 *    joined + truncated to COMPUTER_USE_LIMITS.observationTextMaxChars, image
 *    dimensions from structuredContent.screenshot_width/height or the PNG/JPEG
 *    header, effect appended to the action text, capture_id passed through;
 *    `isError` results become ComputerUseError via classifyDriverError.
 *
 * Windows menu traversal and desktop coordinate mapping live in dedicated helpers.
 * Driver calls outside DRIVER_TOOL_ALLOWLIST are impossible: the translation
 * tables below are static and mcp-driver-client.ts rejects any other name.
 */

import type {
	ComputerActAction,
	ComputerActParams,
	ComputerObserveParams,
	ComputerObserveView,
	ComputerPermissionReport,
	ComputerToolDetails,
	ComputerUseErrorCode,
	ComputerUsePlatform,
} from "../../shared/computer-use-types.js";
import { COMPUTER_USE_LIMITS } from "../../shared/computer-use-types.js";
import type {
	BackendActionResult,
	BackendImage,
	BackendObservation,
	BackendSessionHandle,
	BackendTreeInfo,
	BackendVerifyPredicate,
	BackendVerifyResult,
	ComputerBackend,
	DriverClient,
	DriverToolInputSchema,
	DriverToolResult,
} from "./contracts.js";
import { ComputerUseError, effectiveFrame } from "./contracts.js";
import { DesktopCoordinateMapper } from "./desktop-coordinate-mapper.js";
import { invokeWindowsMenu } from "./windows-menu.js";
import { assertWindowsBackgroundKeyboardAllowed } from "./windows-input-policy.js";
import { mergeWindowsVerification, verifyNativeWindowsElements, readWindowsUiaElements, type WindowsVerificationElement } from "./windows-verification.js";
import { withWindowsClipboardText } from "./windows-clipboard.js";
import { confirmedWindowsAction, nativeActionElement, windowsActionTarget, type WindowsActionTarget } from "./windows-action-state.js";
import { limitWindowQuery } from "./window-query.js";

// ============================================================================
// Translation tables (single source of truth for translate* + supports)
// ============================================================================

const OBSERVE_TOOL_BY_VIEW: Readonly<Record<ComputerObserveView, string>> = {
	apps: "list_apps",
	windows: "list_windows",
	window: "get_window_state",
	desktop: "get_desktop_state",
	zoom: "zoom",
	verify: "verify_state",
};

/** `wait` is handled locally and has no driver tool. */
type DriverActAction = Exclude<ComputerActAction, "wait">;

const ACT_TOOL_BY_ACTION: Readonly<Record<DriverActAction, string>> = {
	click: "click",
	double_click: "double_click",
	right_click: "right_click",
	type_text: "type_text",
	press_key: "press_key",
	hotkey: "hotkey",
	scroll: "scroll",
	drag: "drag",
	move_cursor: "move_cursor",
	set_value: "set_value",
	invoke_menu: "invoke_menu",
	launch_app: "launch_app",
	focus_window: "bring_to_front",
};

/** Driver tool for a PiX view/action name; null when the name is unknown. */
function driverToolFor(kind: "observe" | "act", name: string): string | null {
	const table: Readonly<Record<string, string | undefined>> = kind === "observe" ? OBSERVE_TOOL_BY_VIEW : ACT_TOOL_BY_ACTION;
	return table[name] ?? null;
}

// ============================================================================
// Pure helpers
// ============================================================================

/** Copy the defined entries of `pairs` into a fresh args object (undefined -> key omitted). */
function definedArgs(pairs: Record<string, unknown>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(pairs)) {
		if (value !== undefined) args[key] = value;
	}
	return args;
}

/**
 * Pure: driver-level required check against the live tools/list schema.
 * Returns the missing driver arg names ([] = ok). A null schema means the tool
 * was not found in tools/list (or has no cached schema): undecidable -> [].
 */
export function missingDriverArgs(args: Record<string, unknown>, schema: DriverToolInputSchema | null): string[] {
	if (schema === null) return [];
	return schema.required.filter((name) => args[name] === undefined);
}

/**
 * True when the live tools/list schema declares `field`. A null schema (no cached
 * schema: old driver / test stub) is undecidable and keeps the historical payload.
 */
function declaredByDriver(schema: DriverToolInputSchema | null, field: string): boolean {
	return schema === null || schema.properties.has(field);
}

/** The pid / window_id pair, gated on the live schema like every other targeting field. */
function targetingArgs(p: ComputerActParams, schema: DriverToolInputSchema | null): { pid?: number; window_id?: number } {
	return {
		pid: declaredByDriver(schema, "pid") ? p.pid : undefined,
		window_id: declaredByDriver(schema, "window_id") ? p.window_id : undefined,
	};
}

/** Pointer/click arg mapping shared by click / double_click / right_click. */
function pointerArgs(p: ComputerActParams, schema: DriverToolInputSchema | null): Record<string, unknown> {
	const frame = effectiveFrame(p);
	const desktopScope = frame === "desktop" && p.pid === undefined;
	return definedArgs({
		element_token: p.element_token,
		x: p.x,
		y: p.y,
		coordinate_frame: declaredByDriver(schema, "coordinate_frame") ? frame : undefined,
		...targetingArgs(p, schema),
		capture_id: declaredByDriver(schema, "capture_id") ? p.capture_id : undefined,
		from_zoom: p.from_zoom,
		modifier: p.modifiers,
		delivery_mode: p.delivery,
		scope: desktopScope && declaredByDriver(schema, "scope") ? "desktop" : undefined,
	});
}

/** Pure translation of a computer_observe call (session injected by the caller). */
export function translateObserve(
	p: ComputerObserveParams,
	o: { maxImageDimension: number; wantImage: boolean },
): { tool: string; args: Record<string, unknown> } {
	switch (p.view) {
		case "apps":
			return { tool: OBSERVE_TOOL_BY_VIEW.apps, args: {} };
		case "windows":
			return { tool: OBSERVE_TOOL_BY_VIEW.windows, args: definedArgs({ pid: p.pid, on_screen_only: p.on_screen_only }) };
		case "window":
			return {
				tool: OBSERVE_TOOL_BY_VIEW.window,
				args: definedArgs({
					pid: p.pid,
					window_id: p.window_id,
					query: p.query,
					max_elements: p.max_elements ?? COMPUTER_USE_LIMITS.maxElements.default,
					include_screenshot: o.wantImage,
					max_image_dimension: o.maxImageDimension,
				}),
			};
		case "desktop":
			// Called even when wantImage=false (the window list / metadata text is still wanted);
			// observe() drops the image in that case.
			return { tool: OBSERVE_TOOL_BY_VIEW.desktop, args: { max_image_dimension: o.maxImageDimension } };
		case "zoom":
			return {
				tool: OBSERVE_TOOL_BY_VIEW.zoom,
				args: definedArgs({
					pid: p.pid,
					window_id: p.window_id,
					x1: p.region?.x1,
					y1: p.region?.y1,
					x2: p.region?.x2,
					y2: p.region?.y2,
				}),
			};
		case "verify":
			return {
				tool: OBSERVE_TOOL_BY_VIEW.verify,
				args: definedArgs({
					pid: p.pid,
					window_id: p.window_id,
					expect: p.expect,
					include_screenshot: o.wantImage,
				}),
			};
	}
}

/**
 * Pure translation of a computer_act call. `wait` returns `{ wait: duration_ms }`:
 * the controller sleeps locally (interruptible by signal) and the driver is never called.
 * `getSchema` supplies the live tools/list inputSchema while the args are assembled:
 * the driver-optional targeting fields (coordinate_frame / scope / pid / window_id)
 * are sent only when the driver declares them; the default `() => null` (old driver /
 * test stub: undecidable) keeps the historical payload.
 */
export function translateAct(
	p: ComputerActParams,
	getSchema: (tool: string) => DriverToolInputSchema | null = () => null,
): { tool: string; args: Record<string, unknown> } | { wait: number } {
	switch (p.action) {
		case "wait":
			return { wait: p.duration_ms ?? 0 };
		case "click":
		case "double_click":
		case "right_click":
			return { tool: ACT_TOOL_BY_ACTION[p.action], args: pointerArgs(p, getSchema(ACT_TOOL_BY_ACTION[p.action])) };
		case "type_text": {
			const schema = getSchema(ACT_TOOL_BY_ACTION.type_text);
			// No pid/window_id/element/point: the driver types into the focused
			// window only when scope=desktop. Any other shape still needs pid,
			// which the driver enforces; sending scope there would ignore the token.
			const desktopScope = p.pid === undefined
				&& p.window_id === undefined
				&& p.element_token === undefined
				&& p.x === undefined
				&& p.y === undefined;
			return {
				tool: ACT_TOOL_BY_ACTION.type_text,
				args: definedArgs({
					text: p.text,
					element_token: p.element_token,
					x: p.x,
					y: p.y,
					...targetingArgs(p, schema),
					scope: desktopScope && declaredByDriver(schema, "scope") ? "desktop" : undefined,
					delivery_mode: p.delivery,
				}),
			};
		}
		case "press_key": {
			const schema = getSchema(ACT_TOOL_BY_ACTION.press_key);
			return {
				tool: ACT_TOOL_BY_ACTION.press_key,
				args: definedArgs({
					key: p.key,
					modifiers: p.modifiers,
					element_token: p.element_token,
					x: declaredByDriver(schema, "x") ? p.x : undefined,
					y: declaredByDriver(schema, "y") ? p.y : undefined,
					from_zoom: declaredByDriver(schema, "from_zoom") ? p.from_zoom : undefined,
					...targetingArgs(p, schema),
					scope: p.pid === undefined && p.window_id === undefined && p.element_token === undefined
						&& p.x === undefined && p.y === undefined
						&& declaredByDriver(schema, "scope") ? "desktop" : undefined,
					delivery_mode: p.delivery,
				}),
			};
		}
		case "hotkey": {
			const schema = getSchema(ACT_TOOL_BY_ACTION.hotkey);
			return {
				tool: ACT_TOOL_BY_ACTION.hotkey,
				args: definedArgs({
					keys: p.keys,
					element_token: declaredByDriver(schema, "element_token") ? p.element_token : undefined,
					...targetingArgs(p, schema),
					scope: p.pid === undefined && p.window_id === undefined && declaredByDriver(schema, "scope") ? "desktop" : undefined,
					delivery_mode: p.delivery,
				}),
			};
		}
		case "scroll": {
			const schema = getSchema(ACT_TOOL_BY_ACTION.scroll);
			const desktopScope = effectiveFrame(p) === "desktop" && p.pid === undefined;
			return {
				tool: ACT_TOOL_BY_ACTION.scroll,
				args: definedArgs({
					direction: p.direction,
					amount: p.amount,
					element_token: p.element_token,
					x: p.x,
					y: p.y,
					coordinate_frame: declaredByDriver(schema, "coordinate_frame") ? effectiveFrame(p) : undefined,
					scope: desktopScope && declaredByDriver(schema, "scope") ? "desktop" : undefined,
					...targetingArgs(p, schema),
					delivery_mode: p.delivery,
				}),
			};
		}
		case "drag": {
			const schema = getSchema(ACT_TOOL_BY_ACTION.drag);
			const desktopScope = effectiveFrame(p) === "desktop" && p.pid === undefined;
			return {
				tool: ACT_TOOL_BY_ACTION.drag,
				args: definedArgs({
					from_x: p.x,
					from_y: p.y,
					to_x: p.to_x,
					to_y: p.to_y,
					coordinate_frame: declaredByDriver(schema, "coordinate_frame") ? effectiveFrame(p) : undefined,
					scope: desktopScope && declaredByDriver(schema, "scope") ? "desktop" : undefined,
					...targetingArgs(p, schema),
					from_zoom: p.from_zoom,
					delivery_mode: p.delivery,
				}),
			};
		}
		case "move_cursor": {
			const schema = getSchema(ACT_TOOL_BY_ACTION.move_cursor);
			return {
				tool: ACT_TOOL_BY_ACTION.move_cursor,
				args: definedArgs({
					x: p.x,
					y: p.y,
					scope: declaredByDriver(schema, "scope") ? effectiveFrame(p) : undefined,
				}),
			};
		}
		case "set_value": {
			const schema = getSchema(ACT_TOOL_BY_ACTION.set_value);
			return {
				tool: ACT_TOOL_BY_ACTION.set_value,
				args: definedArgs({
					...targetingArgs(p, schema),
					value: p.value,
					element_token: p.element_token,
					delivery_mode: p.delivery,
				}),
			};
		}
		case "invoke_menu": {
			const schema = getSchema(ACT_TOOL_BY_ACTION.invoke_menu);
			return {
				tool: ACT_TOOL_BY_ACTION.invoke_menu,
				args: definedArgs({
					...targetingArgs(p, schema),
					path: p.menu_path,
				}),
			};
		}
		case "launch_app":
			return { tool: ACT_TOOL_BY_ACTION.launch_app, args: definedArgs({ name: p.app, urls: p.urls }) };
		case "focus_window": {
			const schema = getSchema(ACT_TOOL_BY_ACTION.focus_window);
			return {
				tool: ACT_TOOL_BY_ACTION.focus_window,
				args: definedArgs({
					...targetingArgs(p, schema),
				}),
			};
		}
		default: {
			const unknown = p as { action?: string };
			throw new ComputerUseError("invalid_params", `unsupported computer action: ${String(unknown.action)}`);
		}
	}
}

/**
 * Pure: map a driver isError result to a ComputerUseErrorCode.
 * Inputs: structuredContent.code (the generic code is "tool_invocation_failed")
 * plus text keywords (stale / background_unavailable / permission / not found).
 * "not found" and every other driver complaint stay `driver_error` with the
 * original driver text preserved, so the model can correct itself (e.g.
 * "No windows found for pid ... Provide window_id.").
 */
export function classifyDriverError(r: DriverToolResult): { code: ComputerUseErrorCode; message: string } {
	const message = joinTextContent(r.content);
	const code = readString(r.structuredContent, "code");
	const haystack = code === undefined ? message : `${code}\n${message}`;
	const finalMessage = message.length > 0 ? message : (code ?? "driver reported an error");
	if (/stale|zoom_context_missing|screenshot_context_missing/i.test(haystack)) return { code: "stale_reference", message: finalMessage };
	if (/background[_\s-]*unavailable/i.test(haystack)) return { code: "background_unavailable", message: finalMessage };
	if (/permission/i.test(haystack)) return { code: "permission_required", message: finalMessage };
	return { code: "driver_error", message: finalMessage };
}

/**
 * Pure: normalise check_permissions structuredContent per platform.
 * Three-valued semantics: false = missing (drives missing/degraded exactly as
 * before), true = granted, undefined = undecidable -> never blocking, but the
 * field name is reported in `undecidable` so the snapshot can surface it
 * (macOS/Windows field names are unverified).
 */
export function normalizePermissions(
	platform: ComputerUsePlatform,
	structured: Record<string, unknown> | undefined,
): ComputerPermissionReport {
	const missing: string[] = [];
	const degraded: string[] = [];
	const undecidable: string[] = [];
	if (platform === "darwin-universal") {
		if (structured?.accessibility === false) missing.push("accessibility");
		else if (structured?.accessibility === undefined) undecidable.push("accessibility");
		if (structured?.screen_recording === false) missing.push("screen_recording");
		else if (structured?.screen_recording === undefined) undecidable.push("screen_recording");
	} else if (platform === "linux-x64" || platform === "linux-arm64") {
		const x11 = structured?.x11;
		const wayland = structured?.wayland;
		const atspi = structured?.atspi;
		if (x11 === undefined) undecidable.push("x11");
		if (wayland === undefined) undecidable.push("wayland");
		if (atspi === undefined) undecidable.push("atspi");
		if (x11 === false && wayland === false) missing.push("display");
		if (atspi === false) degraded.push("accessibility_tree");
		if (wayland === true && x11 === false) degraded.push("background_input");
	}
	// win32: "Windows requires no special permissions" (impl_.rs:1222) - always empty.
	return { missing, degraded, undecidable };
}

// ============================================================================
// Result normalisation helpers
// ============================================================================

/** All text items of a driver result, joined with newlines. */
function joinTextContent(content: DriverToolResult["content"]): string {
	const texts: string[] = [];
	for (const item of content) {
		if (item.type === "text") texts.push(item.text);
	}
	return texts.join("\n");
}

/**
 * Truncate model-visible text to COMPUTER_USE_LIMITS.observationTextMaxChars,
 * appending the marker (total length stays <= the limit).
 */
function truncateObservationText(text: string): string {
	const max = COMPUTER_USE_LIMITS.observationTextMaxChars;
	if (text.length <= max) return text;
	const marker = (dropped: number): string => `…[truncated ${dropped} chars; use query/max_elements to narrow]`;
	let keep = Math.max(0, max - marker(text.length).length);
	let dropped = text.length - keep;
	keep = Math.max(0, max - marker(dropped).length);
	dropped = text.length - keep;
	return text.slice(0, keep) + marker(dropped);
}

function readString(structured: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = structured?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readDimension(structured: Record<string, unknown> | undefined, key: string): number | null {
	const value = structured?.[key];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function readNullableBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function readNullableNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const TREE_FIELDS = [
	"truncated",
	"truncation_reason",
	"elements_complete",
	"total_element_count",
	"returned_element_count",
	"filtered_element_count",
] as const;

/** get_window_state tree metadata; undefined when the driver reported none of the fields. */
function readTreeInfo(structured: Record<string, unknown> | undefined): BackendTreeInfo | undefined {
	if (structured === undefined) return undefined;
	if (!TREE_FIELDS.some((field) => structured[field] !== undefined)) return undefined;
	const reason = structured.truncation_reason;
	return {
		truncated: readNullableBoolean(structured.truncated) === true,
		truncationReason: typeof reason === "string" ? reason : null,
		complete: readNullableBoolean(structured.elements_complete),
		totalElements: readNullableNumber(structured.total_element_count),
		returnedElements: readNullableNumber(structured.returned_element_count),
		filteredElements: readNullableNumber(structured.filtered_element_count),
	};
}

const VERIFY_STATUSES: ReadonlySet<string> = new Set(["satisfied", "unsatisfied", "unknown"]);
type VerifyStatus = "satisfied" | "unsatisfied" | "unknown";

function readVerifyStatus(value: unknown): VerifyStatus {
	return typeof value === "string" && VERIFY_STATUSES.has(value) ? (value as VerifyStatus) : "unknown";
}

/** observed_json: strings stay raw, other values are JSON-encoded; both truncated to 300 chars. */
function readObservedJson(value: unknown): string | null {
	if (typeof value === "string") return value.length > 300 ? value.slice(0, 300) : value;
	if (value === undefined || value === null) return null;
	const json = JSON.stringify(value);
	if (json === undefined) return null;
	return json.length > 300 ? json.slice(0, 300) : json;
}

function readVerifyPredicates(value: unknown): BackendVerifyPredicate[] {
	if (!Array.isArray(value)) return [];
	const predicates: BackendVerifyPredicate[] = [];
	for (let position = 0; position < value.length && predicates.length < 8; position++) {
		const item = value[position];
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		const reason = record.unknown_reason;
		predicates.push({
			index: readNullableNumber(record.index) ?? position,
			status: readVerifyStatus(record.status),
			unknownReason: typeof reason === "string" ? reason : null,
			observed: readObservedJson(record.observed_json),
		});
	}
	return predicates;
}

function readVerifyResult(structured: Record<string, unknown> | undefined): BackendVerifyResult | undefined {
	if (structured === undefined) return undefined;
	return {
		status: readVerifyStatus(structured.status),
		stable: readNullableBoolean(structured.stable) === true,
		samples: readNullableNumber(structured.samples) ?? 0,
		elapsedMs: readNullableNumber(structured.elapsed_ms),
		predicates: readVerifyPredicates(structured.predicates),
	};
}

const DELIVERY_MODES: ReadonlySet<string> = new Set(["background", "foreground", "not_applicable", "unknown"]);
type DeliveryMode = "background" | "foreground" | "not_applicable" | "unknown";

function readDeliveryMode(structured: Record<string, unknown> | undefined): DeliveryMode | undefined {
	const delivery = structured?.delivery;
	if (typeof delivery !== "object" || delivery === null || Array.isArray(delivery)) return undefined;
	const mode = (delivery as Record<string, unknown>).mode;
	return typeof mode === "string" && DELIVERY_MODES.has(mode) ? (mode as DeliveryMode) : undefined;
}

function readEvidence(value: unknown): Array<{ kind: string; detail: string | null }> | undefined {
	if (!Array.isArray(value)) return undefined;
	const evidence: Array<{ kind: string; detail: string | null }> = [];
	for (let position = 0; position < value.length && evidence.length < 8; position++) {
		const item = value[position];
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		if (typeof record.kind !== "string") continue;
		evidence.push({
			kind: record.kind,
			detail: typeof record.detail === "string" ? record.detail : null,
		});
	}
	return evidence;
}

function firstImageItem(content: DriverToolResult["content"]): { data: string; mimeType: string } | null {
	for (const item of content) {
		if (item.type === "image") return { data: item.data, mimeType: item.mimeType };
	}
	return null;
}

/** Decode the first 64 KiB of a base64 payload (enough for the PNG/JPEG header). */
function decodeHead(data: string): Buffer {
	const base64Head = data.slice(0, Math.ceil(65536 / 3) * 4);
	return Buffer.from(base64Head, "base64");
}

function parsePngSize(bytes: Buffer): { width: number; height: number } | null {
	if (bytes.length < 24) return null;
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for (let i = 0; i < signature.length; i++) {
		if (bytes[i] !== signature[i]) return null;
	}
	// IHDR is the first chunk: length (8..11), type (12..15), width (16..19), height (20..23).
	if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function parseJpegSize(bytes: Buffer): { width: number; height: number } | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let pos = 2;
	while (pos + 1 < bytes.length) {
		if (bytes[pos] !== 0xff) return null;
		const marker = bytes[pos + 1];
		if (marker === 0xff) {
			pos++; // fill byte
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			pos += 2; // standalone markers
			continue;
		}
		if (pos + 4 > bytes.length) return null;
		const segmentLength = bytes.readUInt16BE(pos + 2);
		if (segmentLength < 2) return null;
		// SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (pos + 9 > bytes.length) return null;
			return { width: bytes.readUInt16BE(pos + 7), height: bytes.readUInt16BE(pos + 5) };
		}
		pos += 2 + segmentLength;
	}
	return null;
}

/** PNG/JPEG header dimensions; null when the format is unknown or the header is incomplete. */
function parseImageSize(data: string, mimeType: string): { width: number; height: number } | null {
	const head = decodeHead(data);
	const mime = mimeType.toLowerCase();
	if (mime.includes("png")) return parsePngSize(head);
	if (mime.includes("jpeg") || mime.includes("jpg")) return parseJpegSize(head);
	return parsePngSize(head) ?? parseJpegSize(head);
}

/**
 * First image item + dimensions. structuredContent.screenshot_width/height win
 * (present on Linux, contract-crate shared on macOS/Windows); anything missing
 * falls back to the PNG/JPEG header. 0 = unknown (never expected in practice).
 */
function readBackendImage(content: DriverToolResult["content"], structured: Record<string, unknown> | undefined): BackendImage | null {
	const item = firstImageItem(content);
	if (item === null) return null;
	const width = readDimension(structured, "screenshot_width");
	const height = readDimension(structured, "screenshot_height");
	if (width !== null && height !== null) {
		return { data: item.data, mimeType: item.mimeType, width, height };
	}
	const parsed = parseImageSize(item.data, item.mimeType);
	return {
		data: item.data,
		mimeType: item.mimeType,
		width: width ?? parsed?.width ?? 0,
		height: height ?? parsed?.height ?? 0,
	};
}

type ComputerTarget = NonNullable<ComputerToolDetails["target"]>;

function makeTarget(pid: number | undefined, windowId: number | undefined, frame: "window" | "desktop"): ComputerTarget {
	const target: ComputerTarget = { frame };
	if (pid !== undefined) target.pid = pid;
	if (windowId !== undefined) target.windowId = windowId;
	return target;
}

function observeTarget(p: ComputerObserveParams): ComputerToolDetails["target"] {
	switch (p.view) {
		case "desktop":
			return { frame: "desktop" };
		case "window":
		case "zoom":
		case "verify":
			return makeTarget(p.pid, p.window_id, "window");
		case "windows":
			return p.pid === undefined ? undefined : { pid: p.pid };
		default:
			return undefined;
	}
}

function actTarget(p: ComputerActParams): ComputerToolDetails["target"] {
	if (p.action === "wait") return undefined;
	if (p.action === "launch_app") return p.app === undefined ? undefined : { appName: p.app };
	return makeTarget(p.pid, p.window_id, effectiveFrame(p));
}

// ============================================================================
// Backend
// ============================================================================

interface ZoomRegion { pid: number; windowId: number; x1: number; y1: number; x2: number; y2: number }
interface CuaDriverBackendOptions {
	verifyNative?: typeof verifyNativeWindowsElements;
	readNative?: typeof readWindowsUiaElements;
	clipboard?: typeof withWindowsClipboardText;
}

export class CuaDriverBackend implements ComputerBackend {
	readonly platform: ComputerUsePlatform;
	private readonly _client: DriverClient;
	private readonly _desktopCoordinates: DesktopCoordinateMapper | null;
	private readonly _verifyNative: typeof verifyNativeWindowsElements;
	private readonly _snapshots = new Map<string, Record<string, unknown>>();
	private readonly _zoomRegions = new Map<string, ZoomRegion>();
	private readonly _readNative: typeof readWindowsUiaElements;
	private readonly _clipboard: typeof withWindowsClipboardText;
	/**
	 * Driver-side sessions started since the driver process last became ready.
	 * A crash + restart wipes driver-side sessions, so every "ready" transition
	 * marks them all as needing a lazy start_session.
	 */
	private readonly _liveSessions = new Set<string>();

	constructor(client: DriverClient, platform: ComputerUsePlatform, options: CuaDriverBackendOptions = {}) {
		this._client = client;
		this.platform = platform;
		this._verifyNative = options.verifyNative ?? verifyNativeWindowsElements;
		this._readNative = options.readNative ?? readWindowsUiaElements;
		this._clipboard = options.clipboard ?? withWindowsClipboardText;
		this._desktopCoordinates = platform === "win32-x64" || platform === "win32-arm64" ? new DesktopCoordinateMapper() : null;
		client.onStateChange((state) => {
			if (state === "ready") {
				this._liveSessions.clear();
				this._desktopCoordinates?.clear();
				this._snapshots.clear();
				this._zoomRegions.clear();
			}
		});
	}

	async openSession(label: string): Promise<BackendSessionHandle> {
		await this._ensureSession(label, undefined);
		return { driverSession: label };
	}

	async closeSession(h: BackendSessionHandle): Promise<void> {
		this._liveSessions.delete(h.driverSession);
		this._desktopCoordinates?.clear(h.driverSession);
		this._snapshots.delete(h.driverSession);
		this._zoomRegions.delete(h.driverSession);
		try {
			await this._callDriver("end_session", { session: h.driverSession }, {});
		} catch {
			// Best-effort: the session may already be gone (driver restart); dispose must not fail.
		}
	}

	async observe(
		h: BackendSessionHandle,
		p: ComputerObserveParams,
		o: { maxImageDimension: number; wantImage: boolean; signal?: AbortSignal; preserveZoom?: boolean },
	): Promise<BackendObservation> {
		let requestedZoom: ZoomRegion | undefined;
		if (p.view === "zoom" && p.region && p.pid !== undefined && p.window_id !== undefined) {
			const base = this._snapshots.get(h.driverSession);
			const width = readDimension(base, "screenshot_width");
			const height = readDimension(base, "screenshot_height");
			if (width && height && base?.pid === p.pid && base.window_id === p.window_id) {
				requestedZoom = { pid: p.pid, windowId: p.window_id,
					x1: p.region.x1 / width, y1: p.region.y1 / height, x2: p.region.x2 / width, y2: p.region.y2 / height };
			}
		}
		const query = (this.platform === "win32-x64" || this.platform === "win32-arm64") && p.view === "window" && p.query?.trim() ? p.query.trim() : undefined;
		const t = translateObserve(query ? { ...p, query, max_elements: COMPUTER_USE_LIMITS.maxElements.max } : p, { maxImageDimension: o.maxImageDimension, wantImage: o.wantImage });
		const raw = await this._callDriver(t.tool, t.args, { session: h.driverSession, signal: o.signal });
		if (requestedZoom) this._zoomRegions.set(h.driverSession, requestedZoom);
		else if (p.view === "window" && !o.preserveZoom) this._zoomRegions.delete(h.driverSession);
		const result = query ? limitWindowQuery(raw, query, p.max_elements ?? COMPUTER_USE_LIMITS.maxElements.default) : raw;
		let structured = result.structuredContent;
		let image = o.wantImage ? readBackendImage(result.content, structured) : null;
		let zoomed = p.view === "zoom";
		const region = o.preserveZoom ? this._zoomRegions.get(h.driverSession) : undefined;
		if (p.view === "window" && image && region && region.pid === p.pid && region.windowId === p.window_id) {
			const freshZoom = translateObserve({ view: "zoom", pid: p.pid, window_id: p.window_id, region: {
				x1: region.x1 * image.width, y1: region.y1 * image.height, x2: region.x2 * image.width, y2: region.y2 * image.height,
			} }, { maxImageDimension: o.maxImageDimension, wantImage: true });
			const zoomResult = await this._callDriver(freshZoom.tool, freshZoom.args, { session: h.driverSession, signal: o.signal });
			const zoomImage = readBackendImage(zoomResult.content, zoomResult.structuredContent);
			if (zoomImage) {
				image = zoomImage;
				structured = { ...structured, capture_id: readString(zoomResult.structuredContent, "capture_id"), screenshot_width: image.width, screenshot_height: image.height };
				zoomed = true;
			}
		}
		if (p.view === "desktop") this._desktopCoordinates?.record(h.driverSession, structured, image !== null);
		let verify = p.view === "verify" ? readVerifyResult(structured) : undefined;
		let text = truncateObservationText(joinTextContent(result.content));
		if ((this.platform === "win32-x64" || this.platform === "win32-arm64") && verify !== undefined
			&& p.pid !== undefined && p.window_id !== undefined
			&& verify.predicates.some((predicate) => predicate.status === "unknown" && predicate.unknownReason === "untrusted_source")) {
			// The driver treats every UIA Document as web content, including native
			// RichEdit. Re-read native provenance and values instead of trusting it.
			const native = await this._verifyNative({ pid: p.pid, window_id: p.window_id }, p.expect ?? [], o.signal);
			const merged = mergeWindowsVerification(verify, native);
			if (merged !== verify) {
				text = `Verification status=${merged.status} stable=${merged.stable} samples=${merged.samples}. Native Windows UIA evidence:\n`
					+ merged.predicates.map((predicate) => `[${predicate.index}] ${predicate.status}${predicate.unknownReason ? ` (${predicate.unknownReason})` : ""} observed=${predicate.observed ?? "null"}`).join("\n");
				verify = merged;
			}
		}
		return {
			text: truncateObservationText(text),
			image,
			captureId: readString(structured, "capture_id"),
			snapshotId: readString(structured, "snapshot_id"),
			tree: readTreeInfo(structured),
			verify,
			zoom: zoomed || undefined,
			target: observeTarget(p),
			driverTool: t.tool,
		};
	}

	async act(
		h: BackendSessionHandle,
		p: ComputerActParams,
		o: { signal?: AbortSignal },
	): Promise<BackendActionResult> {
		let translatedParams = p;
		const windows = this.platform === "win32-x64" || this.platform === "win32-arm64";
		const clipboardText = windows && p.action === "type_text" && p.delivery === "foreground" ? p.text : undefined;
		if (windows && p.action === "type_text" && p.delivery === "foreground") {
			if (clipboardText === undefined) throw new ComputerUseError("invalid_params", "type_text requires text.");
			if (p.element_token !== undefined && (p.x !== undefined || p.y !== undefined)) {
				throw new ComputerUseError("invalid_params", "Pass element_token or x/y for type_text, not both.");
			}
			if (p.from_zoom && p.x !== undefined && !declaredByDriver(this._client.getToolInputSchema("press_key"), "from_zoom")) {
				throw new ComputerUseError("unsupported_on_platform", "Typing directly at zoom coordinates is not supported by this driver.", "Click the zoom target, then type using the fresh editor element_token.");
			}
		}
		const windowsForegroundHotkey = windows && p.action === "hotkey" && p.delivery === "foreground";
		if (windowsForegroundHotkey) {
			// HotkeyTool ignores foreground delivery on XAML hosts; PressKeyTool's
			// foreground path already sends a real chord through SendInput.
			const aliases: Readonly<Record<string, string>> = {
				ctrl: "ctrl", control: "ctrl", shift: "shift", alt: "alt", option: "alt",
				win: "win", windows: "win", super: "win", meta: "win", cmd: "win", command: "win",
			};
			const modifiers = new Set<string>();
			const keys: string[] = [];
			for (const rawKey of p.keys ?? []) {
				const key = rawKey.trim().toLowerCase();
				const modifier = aliases[key];
				if (modifier !== undefined) modifiers.add(modifier);
				else keys.push(key);
			}
			if (keys.length !== 1 || keys[0].length === 0) {
				throw new ComputerUseError("invalid_params", "A Windows hotkey requires exactly one non-modifier key plus its modifiers.");
			}
			translatedParams = { ...p, action: "press_key", key: keys[0], modifiers: [...modifiers] };
		}
		const t = translateAct(translatedParams, (tool) => this._client.getToolInputSchema(tool));
		if ("wait" in t) {
			// PiX-level sleep performed by the controller (interruptible by signal); the driver is never called.
			return { text: `Waited ${t.wait} ms.`, target: actTarget(p), driverTool: "wait" };
		}
		if (windows) {
			await assertWindowsBackgroundKeyboardAllowed(p, (pid) => this._client.listToolNames().has("debug_window_info")
				? this._callDriver("debug_window_info", { pid }, { session: h.driverSession, signal: o.signal })
				: Promise.resolve(null));
		}
		const args = this._desktopCoordinates?.map(h.driverSession, p, t.args) ?? t.args;
		const call = (tool: string, driverArgs: Record<string, unknown>): Promise<DriverToolResult> =>
			this._callDriver(tool, driverArgs, { session: h.driverSession, signal: o.signal });
		if (windows && p.element_token !== undefined) {
			const snapshot = this._snapshots.get(h.driverSession);
			if (!Array.isArray(snapshot?.elements) || !snapshot.elements.some((element: unknown) => typeof element === "object" && element !== null
				&& (element as Record<string, unknown>).element_token === p.element_token)
				|| (p.pid !== undefined && p.pid !== snapshot.pid) || (p.window_id !== undefined && p.window_id !== snapshot.window_id)) {
				throw new ComputerUseError("stale_reference", "The element token does not belong to the latest observed target.", "Observe the target window and use its fresh element_token before acting.");
			}
		}
		const actionTarget = windows ? windowsActionTarget(p, this._snapshots.get(h.driverSession)) : null;
		const before = actionTarget ? await this._readActionElement(actionTarget, p.action === "type_text", o.signal) : null;
		this._snapshots.delete(h.driverSession);
		let result: DriverToolResult;
		let driverTool = t.tool;
		if (clipboardText !== undefined) {
			const text = clipboardText;
			if (!text) {
				result = { content: [{ type: "text", text: "No text to insert." }], isError: false, structuredContent: { effect: "confirmed" } };
			} else {
				result = await this._clipboard(text, async (pasteNative) => {
					let pasted: DriverToolResult;
					if (before?.native_window_handle && before.framework_id === "Win32" && /^richedit/i.test(before.class_name)) {
						await pasteNative(before.process_id, before.native_window_handle);
						pasted = { content: [], isError: false, structuredContent: { effect: "unverifiable" } };
						driverTool = "WM_PASTE";
					} else {
						const pasteArgs = translateAct({ ...p, action: "press_key", key: "v", modifiers: ["ctrl"] }, (tool) => this._client.getToolInputSchema(tool));
						if (!("tool" in pasteArgs)) throw new ComputerUseError("invalid_params", "Invalid paste action.");
						pasted = await call(pasteArgs.tool, pasteArgs.args);
						driverTool = "press_key";
					}
					await this._confirmAction(p, actionTarget, before, pasted, o.signal);
					return {
						...pasted,
						content: [{ type: "text", text: `Pasted ${text.length} characters into the target editor.` }],
						structuredContent: { ...pasted.structuredContent, delivery: { mode: driverTool === "WM_PASTE" ? "background" : "foreground" }, route: "clipboard_paste", effect: pasted.structuredContent?.effect ?? "unverifiable" },
					};
				}, o.signal);
			}
		} else if (windows && p.action === "invoke_menu") {
			if (p.pid === undefined || p.window_id === undefined || p.menu_path === undefined) {
				throw new ComputerUseError("invalid_params", "invoke_menu requires pid, window_id and menu_path.");
			}
			result = await invokeWindowsMenu({ pid: p.pid, window_id: p.window_id, menu_path: p.menu_path }, call, o.signal);
			driverTool = "click";
		} else {
			result = await call(t.tool, args);
			if (windows) await this._confirmAction(p, actionTarget, before, result, o.signal);
		}
		if (windowsForegroundHotkey) {
			result.structuredContent = {
				...result.structuredContent,
				effect: result.structuredContent?.effect ?? "unverifiable",
				delivery: { mode: "foreground" },
				route: "send_input",
			};
		}
		this._snapshots.delete(h.driverSession);
		const structured = result.structuredContent;
		const effect = readString(structured, "effect");
		let text = truncateObservationText(joinTextContent(result.content) || readString(structured, "summary") || "");
		if (effect !== undefined) {
			// Tell the model the driver could not verify the effect: it must observe to confirm.
			text = text.length > 0 ? `${text}\n[pix] effect=${effect}` : `[pix] effect=${effect}`;
		}
		return {
			text,
			effect,
			deliveryMode: readDeliveryMode(structured),
			route: readString(structured, "route"),
			evidence: readEvidence(structured?.evidence),
			target: actTarget(p),
			driverTool,
		};
	}

	async checkPermissions(): Promise<ComputerPermissionReport> {
		const args: Record<string, unknown> = {};
		// macOS-only parameter: read-only check that never raises the system dialog.
		// Optional driver parameters are sent only when the driver declares them.
		if (this._client.getToolInputSchema("check_permissions")?.properties.has("prompt") === true) {
			args.prompt = false;
		}
		const result = await this._callDriver("check_permissions", args, {});
		return normalizePermissions(this.platform, result.structuredContent);
	}

	/** Per-action availability from the live tools/list. */
	supports(kind: "observe" | "act", name: string): boolean {
		if (kind === "act" && name === "wait") return true; // handled locally, no driver tool needed
		const tool = driverToolFor(kind, name);
		return tool !== null && this._client.listToolNames().has(tool);
	}

	// ---- internals ----

	private async _readActionElement(target: WindowsActionTarget, selection: boolean, signal?: AbortSignal): Promise<WindowsVerificationElement | null> {
		try {
			return nativeActionElement(target, await this._readNative(target, [{ element: { selector: target.selector, exists: true } }], signal, selection));
		} catch (error) {
			if (signal?.aborted) throw new ComputerUseError("cancelled", "Action read-back was cancelled.");
			return null;
		}
	}

	private async _confirmAction(p: ComputerActParams, target: WindowsActionTarget | null, before: WindowsVerificationElement | null,
		result: DriverToolResult, signal?: AbortSignal): Promise<void> {
		if (!target || !before) return;
		const after = await this._readActionElement(target, false, signal);
		if (confirmedWindowsAction(p, before, after)) {
			const previous = result.structuredContent;
			result.structuredContent = { ...previous, effect: "confirmed", evidence: [
				...(Array.isArray(previous?.evidence) ? previous.evidence : []),
				{ kind: "native_value_readback", detail: `The same native control (${before.runtime_id}) matched the expected ${p.action === "click" ? "toggle state" : "complete value"}.` },
			] };
		}
	}

	/** Runtime required check against the live tools/list schema. */
	private _assertDriverArgs(tool: string, args: Record<string, unknown>): void {
		const missing = missingDriverArgs(args, this._client.getToolInputSchema(tool));
		if (missing.length > 0) {
			throw new ComputerUseError("invalid_params", `${tool} on this platform requires: ${missing.join(", ")}`);
		}
	}

	/**
	 * Validate -> lazily (re)start the session -> call the driver with `session`
	 * injected -> classify isError results. Validation runs before the session is
	 * touched so a bad call never opens a driver session.
	 */
	private async _callDriver(
		tool: string,
		args: Record<string, unknown>,
		o: { session?: string; signal?: AbortSignal },
	): Promise<DriverToolResult> {
		this._assertDriverArgs(tool, args);
		if (o.session !== undefined) await this._ensureSession(o.session, o.signal);
		const callArgs = o.session === undefined ? args : { ...args, session: o.session };
		const result = await this._client.callTool(tool, callArgs, { signal: o.signal });
		if (!result.isError && tool === "get_window_state" && o.session !== undefined && result.structuredContent) {
			this._snapshots.set(o.session, {
				pid: args.pid, window_id: args.window_id, elements: result.structuredContent.elements,
				screenshot_width: result.structuredContent.screenshot_width, screenshot_height: result.structuredContent.screenshot_height,
			});
		}
		if (result.isError) {
			const message = joinTextContent(result.content);
			const windows = this.platform === "win32-x64" || this.platform === "win32-arm64";
			// cua-driver checks foreground again after SendInput has completed. Closing
			// a window can fail that check even though every mouse event was inserted.
			if (windows && args.delivery_mode === "foreground"
				&& (tool === "click" || tool === "double_click" || tool === "right_click")
				&& /foreground_unavailable: exact target HWND .+? or a verified same-process\s+post-action window was not foreground after the click\s+\(actual foreground HWND .+?\)/s.test(message)) {
				return {
					isError: false,
					content: [{ type: "text", text: "Mouse input was dispatched. The foreground changed after the click; inspect the returned observation before deciding whether another action is needed." }],
					structuredContent: {
						effect: "unverifiable",
						delivery: { mode: "foreground" },
						route: "send_input",
						evidence: [{ kind: "post_action_foreground_changed", detail: message }],
					},
				};
			}
			// This XAML branch returns before attempting input when no exposed UIA
			// accelerator matches. The foreground press_key route can inject the chord.
			const classified = windows && tool === "hotkey" && args.delivery_mode !== "foreground"
				&& /could not find a UIA AcceleratorKey/.test(message)
				? { code: "background_unavailable" as const, message }
				: classifyDriverError(result);
			if (classified.code === "stale_reference"
				&& /zoom_context_missing|screenshot_context_missing/i.test(`${message}\n${readString(result.structuredContent, "code") ?? ""}`)) {
				throw new ComputerUseError(classified.code, classified.message,
					'Observe the same window with screenshot=true, then zoom again before using from_zoom. A new window observation replaces the previous zoom context.');
			}
			if (classified.code === "background_unavailable") {
				throw new ComputerUseError(
					classified.code,
					classified.message,
					'Retry the same action with delivery="foreground"; PiX will request a foreground grant.',
				);
			}
			throw new ComputerUseError(classified.code, classified.message);
		}
		return result;
	}

	/**
	 * start_session once per driver process lifetime; after a restart it is re-run lazily.
	 * The argument name follows the live tools/list schema (see _startSessionArgs).
	 */
	private async _ensureSession(driverSession: string, signal?: AbortSignal): Promise<void> {
		if (this._liveSessions.has(driverSession)) return;
		await this._callDriver("start_session", this._startSessionArgs(driverSession), { signal });
		this._liveSessions.add(driverSession);
	}

	/**
	 * start_session args adapt to the driver's declared schema: a declared `label`
	 * receives the session label (cua-driver 0.34.1 requires it), a declared
	 * `session` the session id; with no cached schema (undecidable) or neither
	 * property declared, fall back to the historical `{ session }` shape.
	 */
	private _startSessionArgs(driverSession: string): Record<string, unknown> {
		const schema = this._client.getToolInputSchema("start_session");
		if (schema === null) return { session: driverSession };
		const args: Record<string, unknown> = {};
		if (schema.properties.has("label")) args.label = driverSession;
		if (schema.properties.has("session")) args.session = driverSession;
		return Object.keys(args).length > 0 ? args : { session: driverSession };
	}
}
