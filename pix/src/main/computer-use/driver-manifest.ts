/**
 * Managed cua-driver manifest.
 *
 * Fixed version, release assets (sha256, layout, executable name), the driver
 * tool allowlist / required set, the child-process env policy (overrides +
 * credential-key sanitisation) and the MCP argv. Pure constants plus the
 * `detectComputerUsePlatform` and `driverChildEnv` mappings; consumed by
 * driver-locator, driver-installer, mcp-driver-client and computer-use-service.
 * Never call a driver tool outside DRIVER_TOOL_ALLOWLIST.
 */

import type { ComputerUsePlatform } from "../../shared/computer-use-types.js";

export const DRIVER_VERSION = "0.34.1";
export const DRIVER_RELEASE_TAG = "cua-driver-rs-v0.34.1";
export const DRIVER_RELEASE_BASE_URL = `https://github.com/trycua/cua/releases/download/${DRIVER_RELEASE_TAG}`;

export interface DriverAsset {
	platform: ComputerUsePlatform;
	fileName: string;            // release asset name
	sha256: string;              // lowercase hex
	archive: "zip" | "tar.gz";
	executable: string;          // path inside extracted dir
	sizeBytes: number;
}
/** Locked release assets (values from the GitHub Release API digest). */
export const DRIVER_ASSETS: Readonly<Record<ComputerUsePlatform, DriverAsset>> = {
	"win32-x64": {
		platform: "win32-x64",
		fileName: "cua-driver-rs-0.34.1-windows-x86_64-binary.zip",
		sha256: "021bc2e5330c80a6c5e2c347c305fafbd4defe195d6282e0d20436f2f13c19bb",
		archive: "zip",
		executable: "cua-driver.exe",
		sizeBytes: 31346745,
	},
	"win32-arm64": {
		platform: "win32-arm64",
		fileName: "cua-driver-rs-0.34.1-windows-arm64-binary.zip",
		sha256: "21820a2ae20cb4bb998a340ff87c11007b9eb5cec8d1b8338c7b0d6dc88b01a6",
		archive: "zip",
		executable: "cua-driver.exe",
		sizeBytes: 29462652,
	},
	"darwin-universal": {
		platform: "darwin-universal",
		fileName: "cua-driver-rs-0.34.1-darwin-universal-binary.tar.gz",
		sha256: "52de49b5046df19245ad02ff9aa89ce9caf69e84988e1d0fac677611dd83e48c",
		archive: "tar.gz",
		executable: "cua-driver",
		sizeBytes: 47101654,
	},
	"linux-x64": {
		platform: "linux-x64",
		fileName: "cua-driver-rs-0.34.1-linux-x86_64-binary.tar.gz",
		sha256: "a41fe2bdcbeea4501dc594c074f16b0975728e0cc7b08b90acea8564d48fafee",
		archive: "tar.gz",
		executable: "cua-driver",
		sizeBytes: 34991293,
	},
	"linux-arm64": {
		platform: "linux-arm64",
		fileName: "cua-driver-rs-0.34.1-linux-arm64-binary.tar.gz",
		sha256: "1c839d35401bbdea20f3e1cf50ace926ef17be6f32cea7e821b02b263c4933dc",
		archive: "tar.gz",
		executable: "cua-driver",
		sizeBytes: 34722300,
	},
};
/** Map process.platform/process.arch → ComputerUsePlatform; null when unsupported. darwin x64/arm64 both → darwin-universal. */
export function detectComputerUsePlatform(platform: NodeJS.Platform, arch: string): ComputerUsePlatform | null {
	if (platform === "win32") {
		if (arch === "x64") return "win32-x64";
		if (arch === "arm64") return "win32-arm64";
		return null;
	}
	if (platform === "darwin") {
		if (arch === "x64" || arch === "arm64") return "darwin-universal";
		return null;
	}
	if (platform === "linux") {
		if (arch === "x64") return "linux-x64";
		if (arch === "arm64") return "linux-arm64";
		return null;
	}
	return null;
}

/** The ONLY driver tools PiX may call. cua-backend.ts must never call anything else. */
export const DRIVER_TOOL_ALLOWLIST: readonly string[] = [
	"start_session", "end_session", "check_permissions",
	"list_apps", "list_windows", "get_window_state", "get_desktop_state", "zoom", "verify_state",
	"click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "drag",
	"move_cursor", "set_value", "invoke_menu", "launch_app", "bring_to_front", "debug_window_info",
];
/** Tools that must exist in tools/list for availability "ready" (others → per-action unsupported_on_platform). */
export const DRIVER_REQUIRED_TOOLS: readonly string[] = [
	"list_apps", "list_windows", "get_window_state", "get_desktop_state", "click", "type_text", "press_key", "hotkey", "scroll",
];
/**
 * Env overrides for the driver child. The client MUST pass the parent env
 * (credential-looking keys stripped; see driverChildEnv) layered with
 * DRIVER_CHILD_ENV as StdioClientTransport `env` — the SDK otherwise only
 * inherits a whitelist that lacks DISPLAY / WAYLAND_DISPLAY / XDG_SESSION_TYPE /
 * DBUS_SESSION_BUS_ADDRESS (sdk client/stdio.js:5–40, 68), breaking Linux
 * capture and input. Values verified against v0.34.1 source: telemetry.rs:216–240,
 * version_check.rs:476/507.
 */
export const DRIVER_CHILD_ENV: Readonly<Record<string, string>> = {
	CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
	DO_NOT_TRACK: "1",
	CUA_DRIVER_RS_UPDATE_CHECK: "0",
};

/**
 * Env keys matching this pattern are stripped before the parent env is handed
 * to any driver child (MCP client AND version probe): the runtime-downloaded
 * third-party driver has no need for API keys / tokens / passwords, and
 * inheriting them would leak credentials (e.g. ANTHROPIC_API_KEY) to a foreign
 * binary. DRIVER_CHILD_ENV / extraEnv are layered on top of the filtered env,
 * so they always survive.
 */
const SENSITIVE_ENV_KEY_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE/i;

/**
 * `process.env` reduced to its string entries (Windows exposes undefined values
 * for empty vars), minus every entry whose key looks like a credential
 * (SENSITIVE_ENV_KEY_PATTERN). The driver child keeps the display/session
 * variables it actually needs (DISPLAY, WAYLAND_DISPLAY, XDG_*, DBUS_*, HOME,
 * PATH, ...); secrets from the PiX parent never reach the third-party binary.
 */
function sanitizedDriverEnvEntries(env: NodeJS.ProcessEnv): Record<string, string> {
	const entries: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value !== "string") continue;
		if (SENSITIVE_ENV_KEY_PATTERN.test(key)) continue;
		entries[key] = value;
	}
	return entries;
}

/** Parent env for any driver child (MCP client AND version probe): sanitized parent env layered with DRIVER_CHILD_ENV. */
export function driverChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	return { ...sanitizedDriverEnvEntries(env), ...DRIVER_CHILD_ENV };
}
/** argv after the executable. `--direct` is mandatory on every platform (main.rs:395–425). */
export const DRIVER_MCP_ARGS: readonly string[] = ["mcp", "--direct"];
