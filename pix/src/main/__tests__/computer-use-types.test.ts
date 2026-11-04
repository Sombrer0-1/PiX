/**
 * Computer-use shared contract tests.
 *
 * Covers the input/output examples verbatim (resolveComputerUseSettings ×2,
 * sanitizeComputerUseSettings ×3, missingRequiredFields ×2,
 * isComputerUseCommand ×2), the detectComputerUsePlatform mapping (all five
 * platforms plus the null fallbacks), the ComputerUseError message format +
 * COMPUTER_USE_ERROR_PATTERN recovery, the locked DRIVER_ASSETS values,
 * the driver allow/required/env/argv constants, and the shared constant tables.
 *
 * Run with: npm exec tsx -- src/main/__tests__/computer-use-types.test.ts
 */

import { ComputerUseError } from "../computer-use/contracts.js";
import {
	DRIVER_ASSETS,
	DRIVER_CHILD_ENV,
	DRIVER_MCP_ARGS,
	DRIVER_RELEASE_BASE_URL,
	DRIVER_RELEASE_TAG,
	DRIVER_REQUIRED_TOOLS,
	DRIVER_TOOL_ALLOWLIST,
	DRIVER_VERSION,
	detectComputerUsePlatform,
} from "../computer-use/driver-manifest.js";
import {
	COMPUTER_ACT_REQUIRED,
	COMPUTER_ACT_TOOL_NAME,
	COMPUTER_OBSERVE_REQUIRED,
	COMPUTER_OBSERVE_TOOL_NAME,
	COMPUTER_TOOL_NAMES,
	COMPUTER_USE_CUSTOM_TYPE,
	COMPUTER_USE_DEFAULTS,
	COMPUTER_USE_ERROR_PATTERN,
	COMPUTER_USE_LIMITS,
	isAbsoluteComputerUseDriverPath,
	isComputerUseCommand,
	missingRequiredFields,
	normalizeComputerUseDriverPath,
	resolveComputerUseSettings,
	sanitizeComputerUseSettings,
	type ComputerActAction,
	type ComputerActParams,
	type ComputerObserveParams,
	type ComputerObserveView,
} from "../../shared/computer-use-types.js";

// ============================================================================
// Test harness (todo-ipc.test.ts style)
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

/** Key-order-independent deep equality (JSON semantics). */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
	const a = stableJson(actual);
	const b = stableJson(expected);
	if (a === b) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message} - expected ${b}, got ${a}`);
	}
}

function run(name: string, fn: () => void): void {
	console.log(`\n=== ${name} ===\n`);
	try {
		fn();
	} catch (err) {
		failed++;
		console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
	}
}

// ============================================================================
// resolveComputerUseSettings
// ============================================================================

run("resolveComputerUseSettings: defaults, clamping and junk input", () => {
	assertDeepEqual(
		resolveComputerUseSettings(undefined),
		{
			enabled: false,
			driverPath: null,
			maxImageDimension: 1568,
			screenshotMaxBytes: 450000,
			keepRecentScreenshots: 3,
			defaultSessionEnabled: false,
		},
		"undefined input → disabled defaults",
	);

	assertDeepEqual(
		resolveComputerUseSettings({ enabled: true, maxImageDimension: 99999, keepRecentScreenshots: 0 }),
		{
			enabled: true,
			driverPath: null,
			maxImageDimension: 2560,
			screenshotMaxBytes: 450000,
			keepRecentScreenshots: 1,
			defaultSessionEnabled: false,
		},
		"over-max clamped to 2560, under-min clamped to 1, other fields defaulted",
	);
});

run("resolveComputerUseSettings: boundaries, passthrough and junk input", () => {
	const lower = resolveComputerUseSettings({
		enabled: false,
		maxImageDimension: 768,
		screenshotMaxBytes: 150_000,
		keepRecentScreenshots: 1,
	});
	assertEqual(lower.maxImageDimension, 768, "min maxImageDimension kept");
	assertEqual(lower.screenshotMaxBytes, 150_000, "min screenshotMaxBytes kept");
	assertEqual(lower.keepRecentScreenshots, 1, "min keepRecentScreenshots kept");

	const upper = resolveComputerUseSettings({
		enabled: true,
		maxImageDimension: 2560,
		screenshotMaxBytes: 1_500_000,
		keepRecentScreenshots: 8,
		defaultSessionEnabled: true,
		driverPath: "C:\\tools\\cua-driver\\cua-driver.exe",
	});
	assertEqual(upper.maxImageDimension, 2560, "max maxImageDimension kept");
	assertEqual(upper.screenshotMaxBytes, 1_500_000, "max screenshotMaxBytes kept");
	assertEqual(upper.keepRecentScreenshots, 8, "max keepRecentScreenshots kept");
	assertEqual(upper.defaultSessionEnabled, true, "defaultSessionEnabled passthrough");
	assertEqual(upper.driverPath, "C:\\tools\\cua-driver\\cua-driver.exe", "driverPath passthrough");
	assertEqual(upper.enabled, true, "enabled passthrough");

	// Out-of-contract values (only reachable through an un-sanitized store) fall
	// back to the defaults instead of producing NaN.
	const junk = resolveComputerUseSettings({
		enabled: true,
		maxImageDimension: Number.NaN,
		screenshotMaxBytes: Number.POSITIVE_INFINITY,
		keepRecentScreenshots: 3.7,
		driverPath: "",
	});
	assertEqual(junk.maxImageDimension, 1568, "NaN → default");
	assertEqual(junk.screenshotMaxBytes, 450000, "Infinity → default");
	assertEqual(junk.keepRecentScreenshots, 4, "fractional count rounded");
	assertEqual(junk.driverPath, null, "empty driverPath → null");
});

// ============================================================================
// sanitizeComputerUseSettings
// ============================================================================

run("sanitizeComputerUseSettings: unknown keys, invalid types and no clamping", () => {
	assertEqual(
		sanitizeComputerUseSettings({ enabled: "yes", foo: 1 }),
		undefined,
		"non-boolean enabled → undefined",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, foo: 1, driverPath: "relative/x", maxImageDimension: 1.5 }),
		{ enabled: true },
		"unknown key, non-absolute path and non-integer dropped",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: false, maxImageDimension: 99999 }),
		{ enabled: false, maxImageDimension: 99999 },
		"no clamping at sanitize time",
	);
});

run("sanitizeComputerUseSettings: guard shapes and field-level rules", () => {
	assertEqual(sanitizeComputerUseSettings(undefined), undefined, "undefined → undefined");
	assertEqual(sanitizeComputerUseSettings(null), undefined, "null → undefined");
	assertEqual(sanitizeComputerUseSettings("enabled:true"), undefined, "string → undefined");
	assertEqual(sanitizeComputerUseSettings(42), undefined, "number → undefined");
	assertEqual(sanitizeComputerUseSettings([{ enabled: true }]), undefined, "array → undefined");
	assertEqual(sanitizeComputerUseSettings({}), undefined, "missing enabled → undefined");
	assertEqual(sanitizeComputerUseSettings({ enabled: 1 }), undefined, "numeric enabled → undefined");

	const full = sanitizeComputerUseSettings({
		enabled: true,
		driverPath: "C:\\tools\\cua-driver\\cua-driver.exe",
		maxImageDimension: 1568,
		screenshotMaxBytes: 450_000,
		keepRecentScreenshots: 3,
		defaultSessionEnabled: false,
	});
	assertDeepEqual(
		full,
		{
			enabled: true,
			maxImageDimension: 1568,
			screenshotMaxBytes: 450_000,
			keepRecentScreenshots: 3,
			driverPath: "C:\\tools\\cua-driver\\cua-driver.exe",
			defaultSessionEnabled: false,
		},
		"all valid fields kept",
	);

	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, driverPath: "/usr/local/bin/cua-driver" }),
		{ enabled: true, driverPath: "/usr/local/bin/cua-driver" },
		"POSIX absolute driverPath kept",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, driverPath: "\\\\server\\share\\cua-driver.exe" }),
		{ enabled: true, driverPath: "\\\\server\\share\\cua-driver.exe" },
		"UNC driverPath kept",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, driverPath: "x" }),
		{ enabled: true },
		"relative driverPath dropped",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, driverPath: "C:/x/".padEnd(1026, "a") }),
		{ enabled: true },
		"driverPath over 1024 chars dropped",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, screenshotMaxBytes: 1.5 }),
		{ enabled: true },
		"non-integer number dropped",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, defaultSessionEnabled: "yes" }),
		{ enabled: true },
		"non-boolean defaultSessionEnabled dropped",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: false, driverPath: undefined, maxImageDimension: undefined }),
		{ enabled: false },
		"explicit undefined optionals dropped",
	);
});

// ============================================================================
// isComputerUseCommand
// ============================================================================

run("isComputerUseCommand: guard rules and full command set", () => {
	assertEqual(isComputerUseCommand({ type: "set_session_enabled", enabled: true }), true, "set_session_enabled with boolean");
	assertEqual(isComputerUseCommand({ type: "set_session_enabled" }), false, "set_session_enabled without enabled");

	assert(isComputerUseCommand({ type: "get_snapshot" }), "get_snapshot accepted");
	assert(isComputerUseCommand({ type: "revoke_grants" }), "revoke_grants accepted");
	assert(isComputerUseCommand({ type: "emergency_stop" }), "emergency_stop accepted");
	assert(isComputerUseCommand({ type: "install_driver" }), "install_driver accepted");
	assert(isComputerUseCommand({ type: "cancel_install" }), "cancel_install accepted");
	assert(isComputerUseCommand({ type: "recheck_driver" }), "recheck_driver accepted");
	assert(
		isComputerUseCommand({ type: "open_permission_settings", permission: "accessibility" }),
		"open_permission_settings/accessibility accepted",
	);
	assert(
		isComputerUseCommand({ type: "open_permission_settings", permission: "screen_recording" }),
		"open_permission_settings/screen_recording accepted",
	);
	assert(!isComputerUseCommand({ type: "open_permission_settings", permission: "camera" }), "unknown permission rejected");
	assert(!isComputerUseCommand({ type: "open_permission_settings" }), "missing permission rejected");
	assertEqual(isComputerUseCommand({ type: "set_session_enabled", enabled: "yes" }), false, "non-boolean enabled rejected");
	assert(!isComputerUseCommand({ type: "bogus" }), "unknown type rejected");
	assert(!isComputerUseCommand(null), "null rejected");
	assert(!isComputerUseCommand("get_snapshot"), "bare string rejected");
	assert(!isComputerUseCommand(undefined), "undefined rejected");
	assert(!isComputerUseCommand([]), "array rejected");
});

// ============================================================================
// missingRequiredFields
// ============================================================================

run("missingRequiredFields: alternative groups", () => {
	// P is pinned to the param interface at the call site (a bare literal would
	// infer a narrowed key set); this is how computer-tools / the controller call it.
	const clickParams: ComputerActParams = { action: "click", x: 1, y: 2 };
	assertEqual(
		missingRequiredFields(clickParams, COMPUTER_ACT_REQUIRED.click),
		null,
		"click with x/y satisfies the bare-coordinate alternative",
	);
	const invokeMenuParams: ComputerActParams = { action: "invoke_menu", pid: 1, menu_path: ["File"] };
	assertDeepEqual(
		missingRequiredFields(invokeMenuParams, COMPUTER_ACT_REQUIRED.invoke_menu),
		[["pid", "window_id", "menu_path"]],
		"invoke_menu without window_id returns the alternatives list",
	);
});

run("missingRequiredFields: group semantics", () => {
	const appsParams: ComputerObserveParams = { view: "apps" };
	assertEqual(
		missingRequiredFields(appsParams, COMPUTER_OBSERVE_REQUIRED.apps),
		null,
		"empty alternative group is always satisfied",
	);
	const windowParams: ComputerObserveParams = { view: "window" };
	assertDeepEqual(
		missingRequiredFields(windowParams, COMPUTER_OBSERVE_REQUIRED.window),
		[["pid", "window_id"]],
		"window without pid/window_id returns the alternatives list",
	);
	const zoomParams: ComputerObserveParams = { view: "zoom", pid: 3, window_id: 7, region: { x1: 0, y1: 0, x2: 1, y2: 1 } };
	assertEqual(
		missingRequiredFields(zoomParams, COMPUTER_OBSERVE_REQUIRED.zoom),
		null,
		"zoom fully specified",
	);
	const tokenClick: ComputerActParams = { action: "click", pid: 3, window_id: 7, element_token: "s12345678:4" };
	assertEqual(
		missingRequiredFields(tokenClick, COMPUTER_ACT_REQUIRED.click),
		null,
		"click via element_token satisfies the first alternative",
	);
	const zeroClick: ComputerActParams = { action: "click", pid: 3, window_id: 7, x: 0, y: 0 };
	assertEqual(
		missingRequiredFields(zeroClick, COMPUTER_ACT_REQUIRED.click),
		null,
		"zero coordinates count as present",
	);
	const partialClick: ComputerActParams = { action: "click", pid: 3, x: 0 };
	assertDeepEqual(
		missingRequiredFields(partialClick, COMPUTER_ACT_REQUIRED.click),
		[["pid", "window_id", "element_token"], ["pid", "window_id", "x", "y"], ["x", "y"]],
		"partial group falls through to the full alternatives list",
	);
	const waitParams: ComputerActParams = { action: "wait", duration_ms: 0 };
	assertEqual(
		missingRequiredFields(waitParams, COMPUTER_ACT_REQUIRED.wait),
		null,
		"wait accepts duration_ms 0",
	);
	const dragParams: ComputerActParams = { action: "drag", x: 1, y: 2, to_x: 3 };
	assertDeepEqual(
		missingRequiredFields(dragParams, COMPUTER_ACT_REQUIRED.drag),
		[["x", "y", "to_x", "to_y"]],
		"drag needs the full group",
	);
	// Every observe view / act action has an entry (the table is total).
	const views: ComputerObserveView[] = ["apps", "windows", "window", "desktop", "zoom", "verify"];
	const actions: ComputerActAction[] = [
		"click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "drag",
		"move_cursor", "set_value", "invoke_menu", "launch_app", "focus_window", "wait",
	];
	assert(views.every((v) => Array.isArray(COMPUTER_OBSERVE_REQUIRED[v])), "COMPUTER_OBSERVE_REQUIRED is total");
	assert(actions.every((a) => Array.isArray(COMPUTER_ACT_REQUIRED[a])), "COMPUTER_ACT_REQUIRED is total");
});

// ============================================================================
// ComputerUseError message format
// ============================================================================

run("ComputerUseError: model-visible message + pattern recovery", () => {
	const withHint = new ComputerUseError("self_target", "x", "y");
	assertEqual(withHint.message, "[computer_use:self_target] x\nHint: y", "message format with hint");
	assert(withHint instanceof Error, "extends Error");
	assertEqual(withHint.name, "ComputerUseError", "error name");
	assertEqual(withHint.code, "self_target", "code readonly field");
	assertEqual(withHint.detail, "x", "detail readonly field");
	assertEqual(withHint.hint, "y", "hint readonly field");

	const withoutHint = new ComputerUseError("desktop_busy", "another session holds the desktop lease");
	assertEqual(withoutHint.message, "[computer_use:desktop_busy] another session holds the desktop lease", "message format without hint");
	assertEqual(withoutHint.hint, undefined, "hint omitted");

	// version-probe / tools-list failures throw this code; constructing it pins
	// the union membership at compile time too.
	const incompatible = new ComputerUseError("driver_incompatible", "probe failed", "reinstall the driver");
	assertEqual(incompatible.code, "driver_incompatible", "driver_incompatible is a ComputerUseErrorCode member");
	assertEqual(COMPUTER_USE_ERROR_PATTERN.exec(incompatible.message)?.[1], "driver_incompatible", "pattern recovers driver_incompatible");

	const match = COMPUTER_USE_ERROR_PATTERN.exec(withHint.message);
	assert(match !== null, "pattern matches the error message");
	assertEqual(match?.[1], "self_target", "pattern captures the error code");
	assertEqual(COMPUTER_USE_ERROR_PATTERN.exec("plain text"), null, "pattern rejects non-matching text");
	assertEqual(COMPUTER_USE_ERROR_PATTERN.exec("[computer_use:SELF] x"), null, "pattern requires lowercase code");
});

// ============================================================================
// Platform detection
// ============================================================================

run("detectComputerUsePlatform: full mapping", () => {
	assertEqual(detectComputerUsePlatform("win32", "x64"), "win32-x64", "win32/x64");
	assertEqual(detectComputerUsePlatform("win32", "arm64"), "win32-arm64", "win32/arm64");
	assertEqual(detectComputerUsePlatform("darwin", "x64"), "darwin-universal", "darwin/x64");
	assertEqual(detectComputerUsePlatform("darwin", "arm64"), "darwin-universal", "darwin/arm64");
	assertEqual(detectComputerUsePlatform("linux", "x64"), "linux-x64", "linux/x64");
	assertEqual(detectComputerUsePlatform("linux", "arm64"), "linux-arm64", "linux/arm64");
	assertEqual(detectComputerUsePlatform("win32", "ia32"), null, "win32/ia32 unsupported");
	assertEqual(detectComputerUsePlatform("darwin", "ia32"), null, "darwin/ia32 unsupported");
	assertEqual(detectComputerUsePlatform("linux", "ppc64"), null, "linux/ppc64 unsupported");
	assertEqual(detectComputerUsePlatform("freebsd", "x64"), null, "freebsd/x64 unsupported");
	assertEqual(detectComputerUsePlatform("aix", "ppc64"), null, "aix unsupported");
});

// ============================================================================
// Driver manifest
// ============================================================================

run("driver manifest: version, assets and sha256", () => {
	assertEqual(DRIVER_VERSION, "0.34.1", "DRIVER_VERSION");
	assertEqual(DRIVER_RELEASE_TAG, "cua-driver-rs-v0.34.1", "DRIVER_RELEASE_TAG");
	assertEqual(
		DRIVER_RELEASE_BASE_URL,
		"https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.34.1",
		"DRIVER_RELEASE_BASE_URL",
	);
	assertEqual(DRIVER_RELEASE_BASE_URL.endsWith(DRIVER_RELEASE_TAG), true, "base url ends with the release tag");

	const expected = {
		"win32-x64": { fileName: "cua-driver-rs-0.34.1-windows-x86_64-binary.zip", archive: "zip", executable: "cua-driver.exe", sha256: "021bc2e5330c80a6c5e2c347c305fafbd4defe195d6282e0d20436f2f13c19bb", sizeBytes: 31346745 },
		"win32-arm64": { fileName: "cua-driver-rs-0.34.1-windows-arm64-binary.zip", archive: "zip", executable: "cua-driver.exe", sha256: "21820a2ae20cb4bb998a340ff87c11007b9eb5cec8d1b8338c7b0d6dc88b01a6", sizeBytes: 29462652 },
		"darwin-universal": { fileName: "cua-driver-rs-0.34.1-darwin-universal-binary.tar.gz", archive: "tar.gz", executable: "cua-driver", sha256: "52de49b5046df19245ad02ff9aa89ce9caf69e84988e1d0fac677611dd83e48c", sizeBytes: 47101654 },
		"linux-x64": { fileName: "cua-driver-rs-0.34.1-linux-x86_64-binary.tar.gz", archive: "tar.gz", executable: "cua-driver", sha256: "a41fe2bdcbeea4501dc594c074f16b0975728e0cc7b08b90acea8564d48fafee", sizeBytes: 34991293 },
		"linux-arm64": { fileName: "cua-driver-rs-0.34.1-linux-arm64-binary.tar.gz", archive: "tar.gz", executable: "cua-driver", sha256: "1c839d35401bbdea20f3e1cf50ace926ef17be6f32cea7e821b02b263c4933dc", sizeBytes: 34722300 },
	} as const;

	const platforms = Object.keys(expected) as Array<keyof typeof expected>;
	assertEqual(Object.keys(DRIVER_ASSETS).length, platforms.length, "all five platforms present");
	for (const platform of platforms) {
		const asset = DRIVER_ASSETS[platform];
		assertEqual(asset.platform, platform, `${platform}: platform field`);
		assertEqual(asset.fileName, expected[platform].fileName, `${platform}: fileName`);
		assertEqual(asset.archive, expected[platform].archive, `${platform}: archive`);
		assertEqual(asset.executable, expected[platform].executable, `${platform}: executable`);
		assertEqual(asset.sha256, expected[platform].sha256, `${platform}: sha256`);
		assertEqual(asset.sizeBytes, expected[platform].sizeBytes, `${platform}: sizeBytes`);
		if (!/^[0-9a-f]{64}$/.test(asset.sha256)) {
			failed++;
			console.error(`  FAIL: ${platform}: sha256 must be lowercase hex, got ${asset.sha256}`);
		} else {
			passed++;
			console.log(`  PASS: ${platform}: sha256 is lowercase hex`);
		}
	}
});

run("driver manifest: allowlist, required set, env and argv", () => {
	assertEqual(DRIVER_TOOL_ALLOWLIST.length, 22, "allowlist has 22 tools");
	assert(DRIVER_TOOL_ALLOWLIST.includes("get_window_state"), "allowlist includes get_window_state");
	assert(DRIVER_TOOL_ALLOWLIST.includes("bring_to_front"), "allowlist includes bring_to_front");
	for (const forbidden of ["set_config", "kill_app", "clipboard_read", "clipboard_write", "install_extension", "browser_navigate", "replay_trajectory", "start_recording", "escalate_session", "start_session_elevated"]) {
		assert(!DRIVER_TOOL_ALLOWLIST.includes(forbidden), `allowlist excludes ${forbidden}`);
	}
	assert(DRIVER_REQUIRED_TOOLS.length > 0 && DRIVER_REQUIRED_TOOLS.every((t) => DRIVER_TOOL_ALLOWLIST.includes(t)), "required tools are a subset of the allowlist");

	// Literal lock (verbatim from driver-manifest.ts): the length/positive/subset
	// assertions above cannot catch a renamed or reordered entry, so the exact
	// membership AND order of both lists are pinned by hand-written literals -
	// any edit to either list in the manifest fails here.
	const allowlistLiteral = [
		"start_session", "end_session", "check_permissions",
		"list_apps", "list_windows", "get_window_state", "get_desktop_state", "zoom", "verify_state",
		"click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "drag",
		"move_cursor", "set_value", "invoke_menu", "launch_app", "bring_to_front",
	];
	const requiredLiteral = [
		"list_apps", "list_windows", "get_window_state", "get_desktop_state", "click", "type_text", "press_key", "hotkey", "scroll",
	];
	assertDeepEqual([...DRIVER_TOOL_ALLOWLIST], allowlistLiteral, "DRIVER_TOOL_ALLOWLIST equals the literal 22-tool list (names and order)");
	assertDeepEqual([...DRIVER_REQUIRED_TOOLS], requiredLiteral, "DRIVER_REQUIRED_TOOLS equals the literal 9-tool list (names and order)");

	assertDeepEqual(
		DRIVER_CHILD_ENV,
		{
			CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
			DO_NOT_TRACK: "1",
			CUA_DRIVER_RS_UPDATE_CHECK: "0",
		},
		"telemetry/update-check env overrides",
	);
	assertDeepEqual(DRIVER_MCP_ARGS, ["mcp", "--direct"], "MCP argv pins --direct");
});

// ============================================================================
// Shared constants
// ============================================================================

run("shared constants: tool names, custom type, defaults, limits", () => {
	assertEqual(COMPUTER_OBSERVE_TOOL_NAME, "computer_observe", "observe tool name");
	assertEqual(COMPUTER_ACT_TOOL_NAME, "computer_act", "act tool name");
	assertDeepEqual(COMPUTER_TOOL_NAMES, ["computer_observe", "computer_act"], "tool name tuple");
	assertEqual(COMPUTER_USE_CUSTOM_TYPE, "pix-computer-use-v1", "CustomEntry type name");

	assertDeepEqual(
		COMPUTER_USE_DEFAULTS,
		{ maxImageDimension: 1568, screenshotMaxBytes: 450_000, keepRecentScreenshots: 3, defaultSessionEnabled: false },
		"COMPUTER_USE_DEFAULTS",
	);
	assertEqual(COMPUTER_USE_LIMITS.maxImageDimension.min, 768, "maxImageDimension min");
	assertEqual(COMPUTER_USE_LIMITS.maxImageDimension.max, 2560, "maxImageDimension max");
	assertEqual(COMPUTER_USE_LIMITS.screenshotMaxBytes.min, 150_000, "screenshotMaxBytes min");
	assertEqual(COMPUTER_USE_LIMITS.screenshotMaxBytes.max, 1_500_000, "screenshotMaxBytes max");
	assertEqual(COMPUTER_USE_LIMITS.keepRecentScreenshots.min, 1, "keepRecentScreenshots min");
	assertEqual(COMPUTER_USE_LIMITS.keepRecentScreenshots.max, 8, "keepRecentScreenshots max");
	assertEqual(COMPUTER_USE_LIMITS.typeTextMaxChars, 10_000, "typeTextMaxChars");
	assertEqual(COMPUTER_USE_LIMITS.observationTextMaxChars, 24_000, "observationTextMaxChars");
	assertEqual(COMPUTER_USE_LIMITS.maxElements.default, 400, "maxElements default");
	assertEqual(COMPUTER_USE_LIMITS.maxElements.max, 2000, "maxElements max");
	assertEqual(COMPUTER_USE_LIMITS.waitMaxMs, 10_000, "waitMaxMs");
	assertEqual(COMPUTER_USE_LIMITS.queryMaxChars, 200, "queryMaxChars");
	assertEqual(COMPUTER_USE_LIMITS.verifyExpect.min, 1, "verifyExpect min");
	assertEqual(COMPUTER_USE_LIMITS.verifyExpect.max, 8, "verifyExpect max");
	assertEqual(COMPUTER_USE_LIMITS.scrollAmount.min, 1, "scrollAmount min");
	assertEqual(COMPUTER_USE_LIMITS.scrollAmount.max, 50, "scrollAmount max");
	assertEqual(COMPUTER_USE_LIMITS.menuPath.min, 1, "menuPath min");
	assertEqual(COMPUTER_USE_LIMITS.menuPath.max, 16, "menuPath max");
	assertEqual(COMPUTER_USE_LIMITS.menuPath.itemMaxChars, 200, "menuPath itemMaxChars matches cua-driver 0.34.1");
	assertEqual(COMPUTER_USE_LIMITS.hotkeyKeys.min, 2, "hotkeyKeys min");
	assertEqual(COMPUTER_USE_LIMITS.hotkeyKeys.max, 6, "hotkeyKeys max");
	assertEqual(COMPUTER_USE_LIMITS.modifiers.max, 4, "modifiers max");
	assertEqual(COMPUTER_USE_LIMITS.keyMaxChars, 32, "keyMaxChars");
	assertEqual(COMPUTER_USE_LIMITS.valueMaxChars, 10_000, "valueMaxChars");
	assertEqual(COMPUTER_USE_LIMITS.appNameMaxChars, 256, "appNameMaxChars");
	assertEqual(COMPUTER_USE_LIMITS.urls.max, 8, "urls max");
	assertEqual(COMPUTER_USE_LIMITS.urls.itemMaxChars, 2048, "urls itemMaxChars");
	assertEqual(COMPUTER_USE_LIMITS.reshotMinImageDimension, 512, "reshotMinImageDimension");
});

// ============================================================================
// Driver path normalization (quoted Explorer "Copy as path" must survive save)
// ============================================================================

run("normalizeComputerUseDriverPath: quoted, plain and blank input", () => {
	assertEqual(
		normalizeComputerUseDriverPath('"C:\\tools\\cua-driver\\cua-driver.exe"'),
		"C:\\tools\\cua-driver\\cua-driver.exe",
		"quoted Windows path unquoted",
	);
	assertEqual(
		normalizeComputerUseDriverPath('  "C:\\tools\\cua-driver\\cua-driver.exe"  '),
		"C:\\tools\\cua-driver\\cua-driver.exe",
		"surrounding whitespace trimmed before unquoting",
	);
	assertEqual(
		normalizeComputerUseDriverPath("C:\\tools\\cua-driver\\cua-driver.exe"),
		"C:\\tools\\cua-driver\\cua-driver.exe",
		"plain Windows absolute path unchanged",
	);
	assertEqual(
		normalizeComputerUseDriverPath("/usr/local/bin/cua-driver"),
		"/usr/local/bin/cua-driver",
		"plain POSIX absolute path unchanged",
	);
	assertEqual(normalizeComputerUseDriverPath("   "), undefined, "blank input → undefined");
	assertEqual(normalizeComputerUseDriverPath(""), undefined, "empty input → undefined");
	assertEqual(
		normalizeComputerUseDriverPath('"C:\\tools\\cua-driver.exe'),
		'"C:\\tools\\cua-driver.exe',
		"unbalanced leading quote is not stripped",
	);
	assertEqual(isAbsoluteComputerUseDriverPath("C:\\tools\\cua-driver.exe"), true, "Windows absolute path predicate");
	assertEqual(isAbsoluteComputerUseDriverPath("/usr/local/bin/cua-driver"), true, "POSIX absolute path predicate");
	assertEqual(isAbsoluteComputerUseDriverPath("relative/x"), false, "relative path predicate");
});

run("sanitizeComputerUseSettings: driver path normalized before the absolute-path check", () => {
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, driverPath: '"C:\\tools\\cua-driver\\cua-driver.exe"' }),
		{ enabled: true, driverPath: "C:\\tools\\cua-driver\\cua-driver.exe" },
		"quoted Windows path kept without quotes",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, driverPath: '  "C:\\tools\\cua-driver.exe"  ' }),
		{ enabled: true, driverPath: "C:\\tools\\cua-driver.exe" },
		"quoted path with whitespace kept without quotes",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, driverPath: "C:\\tools\\cua-driver.exe" }),
		{ enabled: true, driverPath: "C:\\tools\\cua-driver.exe" },
		"plain absolute path unchanged",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, driverPath: "relative/x" }),
		{ enabled: true },
		"non-absolute path still dropped",
	);
	assertDeepEqual(
		sanitizeComputerUseSettings({ enabled: true, driverPath: '""' }),
		{ enabled: true },
		"quoted empty path still dropped",
	);
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
	process.exit(1);
}
