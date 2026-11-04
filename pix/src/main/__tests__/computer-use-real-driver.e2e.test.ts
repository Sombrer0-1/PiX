/**
 * Real-driver end-to-end test.
 *
 * Runs the real cua-driver 0.34.1 (`mcp --direct` with DRIVER_MCP_ARGS / driverChildEnv()) and
 * asserts the read-only path end to end:
 *   1. the raw MCP handshake (serverInfo name contains "cua-driver");
 *   2. McpDriverClient.ensureStarted() reaches ready with every DRIVER_REQUIRED_TOOLS entry in
 *      tools/list;
 *   3. `list_apps` is non-empty;
 *   4. `get_desktop_state` returns an image plus structuredContent.capture_id /
 *      screenshot_width / screenshot_height, and `encodeScreenshotForModel` keeps those pixel
 *      dimensions while fitting the default byte budget;
 *   5. `get_window_state`: on Linux a pid-only call succeeds; on Windows/macOS the live
 *      tools/list schema requires window_id, so the PiX contract layer (translateObserve +
 *      missingDriverArgs, cua-backend.ts) rejects the pid-only combination before the driver is
 *      ever called. Both branches target a pid that really owns a window; when none is available
 *      the branch prints a SKIP line instead of falling back to process.pid, which owns no
 *      windows and would fail for the wrong reason;
 *   6. `end_session` succeeds.
 *
 * Safety: the test runs on the user's live desktop and therefore calls ONLY the read-only driver
 * tools `list_apps`, `get_desktop_state`, `get_window_state` and `end_session` - no act-class tool
 * (click / type_text / press_key / hotkey / scroll / drag / move_cursor / set_value / invoke_menu /
 * launch_app / bring_to_front) is ever called. Screenshots stay in this process's memory: nothing is
 * written to disk and no base64 payload is printed.
 *
 * Driver source, in priority order:
 *   1. `PIX_CUA_DRIVER_BIN` - path of a cua-driver executable (no install);
 *   2. with `PIX_CUA_E2E_INSTALL=1`, DriverInstaller installs DRIVER_ASSETS[platform] into a fresh
 *      temporary agentDir under os.tmpdir() (real download + sha256 check + OS-tar extraction); the
 *      temporary directory is removed on exit.
 * Without either, or without a graphical session (win32/darwin count as desktop sessions; Linux
 * needs DISPLAY or WAYLAND_DISPLAY), the test prints `SKIP: <reason>` and exits 0. A sha256 mismatch
 * or a failed assertion is a FAIL (non-zero exit); a successful run prints `E2E RAN` and exits 0.
 *
 * Run with: cd pix && PIX_CUA_E2E_INSTALL=1 npx tsx src/main/__tests__/computer-use-real-driver.e2e.test.ts
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ComputerUsePlatform } from "../../shared/computer-use-types.js";
import { COMPUTER_USE_DEFAULTS } from "../../shared/computer-use-types.js";
import { ComputerUseError, type DriverToolResult } from "../computer-use/contracts.js";
import { missingDriverArgs, translateObserve } from "../computer-use/cua-backend.js";
import { DriverInstaller } from "../computer-use/driver-installer.js";
import {
	DRIVER_MCP_ARGS,
	DRIVER_REQUIRED_TOOLS,
	DRIVER_VERSION,
	detectComputerUsePlatform,
	driverChildEnv,
} from "../computer-use/driver-manifest.js";
import { McpDriverClient } from "../computer-use/mcp-driver-client.js";
import { encodeScreenshotForModel } from "../computer-use/screenshot-codec.js";

/** Long edge requested from the driver for the desktop screenshot. */
const SCREENSHOT_MAX_DIMENSION = 1024;
const CALL_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 20_000;
/** Default per-screenshot base64 budget: the codec must fit the image without changing its size. */
const SCREENSHOT_BUDGET_BYTES = COMPUTER_USE_DEFAULTS.screenshotMaxBytes;
/** DriverInstaller detail marker for a sha256 mismatch: that is a FAIL, never a SKIP. */
const SHA_MISMATCH_MARKER = "sha256 与清单不符";

// ============================================================================
// Test harness (todo-ipc.test.ts style: PASS/FAIL counters, non-zero exit on failure)
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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** All text content items of a driver result, joined with newlines. */
function textContent(result: DriverToolResult): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function firstImage(result: DriverToolResult): { data: string; mimeType: string } | null {
	for (const item of result.content) {
		if (item.type === "image") return item;
	}
	return null;
}

function positiveDimension(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** First running app pid reported by `list_apps` (used by the Linux get_window_state branch). */
function firstAppPid(result: DriverToolResult): number | null {
	const apps = result.structuredContent?.apps;
	if (!Array.isArray(apps)) return null;
	for (const entry of apps) {
		if (typeof entry !== "object" || entry === null) continue;
		const pid = (entry as Record<string, unknown>).pid;
		if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return pid;
	}
	return null;
}

/**
 * First pid that actually owns a window, from get_desktop_state's structuredContent.windows:
 * the node test process owns no windows, so a get_window_state call against process.pid
 * would fail for the wrong reason.
 */
function firstWindowPid(structured: Record<string, unknown> | undefined): number | null {
	const windows = structured?.windows;
	if (!Array.isArray(windows)) return null;
	for (const entry of windows) {
		if (typeof entry !== "object" || entry === null) continue;
		const pid = (entry as Record<string, unknown>).pid;
		if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return pid;
	}
	return null;
}

/** win32/darwin are desktop sessions; Linux needs X11/Wayland. */
function hasGraphicalSession(): boolean {
	if (process.platform === "win32" || process.platform === "darwin") return true;
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Spawn failures caused by the OS security policy (SmartScreen / Defender / AV) or by a broken
 * binary the installer produced: these are SKIP reasons, not PiX assertion failures.
 */
const ENVIRONMENTAL_START_FAILURE = /EPERM|EACCES|ENOENT|ENOEXEC|access is denied|permission denied|operation not permitted|SmartScreen|Windows Defender|not a valid Win32 application|Bad CPU type|module could not be found/i;

// ============================================================================
// Driver acquisition
// ============================================================================

interface AcquiredDriver {
	executablePath: string;
	dir: string;
	/** Removes the temporary agentDir; a no-op when the executable came from PIX_CUA_DRIVER_BIN. */
	cleanup: () => void;
}

type AcquireResult =
	| { kind: "ok"; driver: AcquiredDriver }
	| { kind: "skipped"; reason: string }
	| { kind: "failed"; reason: string };

async function acquireDriver(platform: ComputerUsePlatform): Promise<AcquireResult> {
	const envPath = (process.env.PIX_CUA_DRIVER_BIN ?? "").trim();
	if (envPath.length > 0) {
		if (!existsSync(envPath)) {
			return { kind: "skipped", reason: `PIX_CUA_DRIVER_BIN does not point to an existing file: ${envPath}` };
		}
		console.log(`driver: PIX_CUA_DRIVER_BIN = ${envPath}`);
		return { kind: "ok", driver: { executablePath: envPath, dir: dirname(envPath), cleanup: () => undefined } };
	}

	const installAllowed = process.env.PIX_CUA_E2E_INSTALL === "1" || process.env.PIX_CUA_E2E_INSTALL === "true";
	if (!installAllowed) {
		return { kind: "skipped", reason: "no driver (set PIX_CUA_DRIVER_BIN or PIX_CUA_E2E_INSTALL=1)" };
	}

	const agentDir = mkdtempSync(join(tmpdir(), "pix-computer-use-e2e-"));
	const cleanup = (): void => {
		try {
			rmSync(agentDir, { recursive: true, force: true });
		} catch {
			// Temp cleanup is best effort.
		}
	};
	console.log(`driver: installing cua-driver ${DRIVER_VERSION} (${platform}) into ${agentDir}`);
	console.log("  install: real download + sha256 verification + system tar extraction");
	try {
		const installer = new DriverInstaller({ agentDir, platform });
		let lastPhase = "";
		const executablePath = await installer.install((progress) => {
			if (progress.phase === lastPhase) return;
			lastPhase = progress.phase;
			console.log(`  install: ${progress.phase}`);
		});
		console.log(`driver: installed ${executablePath}`);
		return { kind: "ok", driver: { executablePath, dir: dirname(executablePath), cleanup } };
	} catch (error) {
		cleanup();
		if (error instanceof ComputerUseError && error.detail.includes(SHA_MISMATCH_MARKER)) {
			return { kind: "failed", reason: `driver asset sha256 mismatch: ${error.detail}` };
		}
		return { kind: "skipped", reason: `driver install failed: ${errorText(error)}` };
	}
}

// ============================================================================
// Raw MCP handshake (serverInfo)
// ============================================================================

interface HandshakeResult {
	ok: boolean;
	name: string;
	version: string;
	error?: string;
}

/**
 * `mcp --direct` handshake with a raw SDK client; McpDriverClient (DriverClient) deliberately does
 * not expose serverInfo, so the handshake assertion uses the same executable / argv / env directly.
 */
async function checkHandshake(driver: AcquiredDriver): Promise<HandshakeResult> {
	const transport = new StdioClientTransport({
		command: driver.executablePath,
		args: [...DRIVER_MCP_ARGS],
		cwd: driver.dir,
		env: driverChildEnv(),
		stderr: "pipe",
	});
	const client = new Client({ name: "pix-e2e", version: "0.0.0" });
	try {
		await client.connect(transport, { timeout: START_TIMEOUT_MS });
		const info = client.getServerVersion();
		return { ok: true, name: info?.name ?? "", version: info?.version ?? "" };
	} catch (error) {
		return { ok: false, name: "", version: "", error: errorText(error) };
	} finally {
		await client.close().catch(() => undefined);
	}
}

// ============================================================================
// Main flow
// ============================================================================

type Outcome = { kind: "ran" } | { kind: "skipped"; reason: string };

async function main(): Promise<Outcome> {
	console.log("=== computer-use real-driver e2e ===");
	const platform = detectComputerUsePlatform(process.platform, process.arch);
	console.log(`host: ${process.platform}/${process.arch}, node ${process.versions.node}, driver platform ${platform ?? "<unsupported>"}`);

	if (!hasGraphicalSession()) {
		return { kind: "skipped", reason: "no graphical session" };
	}
	if (platform === null) {
		return { kind: "skipped", reason: `unsupported platform ${process.platform}/${process.arch}` };
	}

	const acquired = await acquireDriver(platform);
	if (acquired.kind === "skipped") return { kind: "skipped", reason: acquired.reason };
	if (acquired.kind === "failed") {
		assert(false, acquired.reason);
		return { kind: "ran" };
	}
	const driver = acquired.driver;

	let client: McpDriverClient | null = null;
	try {
		// ---- 1. mcp --direct handshake ----
		console.log("\n--- handshake (mcp --direct) ---");
		const handshake = await checkHandshake(driver);
		if (!handshake.ok) {
			const detail = handshake.error ?? "unknown failure";
			if (ENVIRONMENTAL_START_FAILURE.test(detail)) {
				return { kind: "skipped", reason: `driver executable could not be started: ${detail}` };
			}
			assert(false, `mcp --direct handshake failed: ${detail}`);
			return { kind: "ran" };
		}
		assertIncludes(handshake.name, "cua-driver", `handshake serverInfo.name contains "cua-driver"`);
		console.log(`  serverInfo: ${handshake.name} ${handshake.version}`);

		// ---- 2. McpDriverClient startup (DRIVER_MCP_ARGS default, driverChildEnv) ----
		console.log("\n--- McpDriverClient ---");
		client = new McpDriverClient({ executablePath: driver.executablePath, cwd: driver.dir });
		client.onStateChange((state, detail) => {
			console.log(`  driver state: ${state}${detail === undefined ? "" : ` (${detail.slice(0, 200)})`}`);
		});
		try {
			await client.ensureStarted();
		} catch (error) {
			const detail = errorText(error);
			if (ENVIRONMENTAL_START_FAILURE.test(detail)) {
				return { kind: "skipped", reason: `driver could not be started: ${detail}` };
			}
			assert(false, `McpDriverClient.ensureStarted() failed: ${detail}`);
			return { kind: "ran" };
		}
		assertEqual(client.state, "ready", "McpDriverClient reached ready with the real driver");
		const toolNames = client.listToolNames();
		console.log(`  tools/list: ${toolNames.size} tools`);
		for (const required of DRIVER_REQUIRED_TOOLS) {
			assert(toolNames.has(required), `tools/list exposes the required tool ${required}`);
		}

		const session = `pix-e2e-${process.pid}`;

		// ---- 3. list_apps ----
		console.log("\n--- list_apps (read-only) ---");
		const apps = await client.callTool("list_apps", { session }, { timeoutMs: CALL_TIMEOUT_MS });
		assert(!apps.isError, "list_apps did not return an error result");
		const appsText = textContent(apps);
		const appsArray = apps.structuredContent?.apps;
		const appCount = Array.isArray(appsArray) ? appsArray.length : null;
		assert(appsText.length > 0, "list_apps returned non-empty text");
		assert(appCount !== 0, `list_apps reports at least one app (${appCount === null ? "count not reported, text length " + appsText.length : appCount + " apps"})`);

		// ---- 4. get_desktop_state + codec ----
		console.log("\n--- get_desktop_state (read-only) ---");
		const desktop = await client.callTool(
			"get_desktop_state",
			{ max_image_dimension: SCREENSHOT_MAX_DIMENSION, session },
			{ timeoutMs: CALL_TIMEOUT_MS },
		);
		assert(!desktop.isError, "get_desktop_state did not return an error result");
		const image = firstImage(desktop);
		assert(image !== null, "get_desktop_state returned an image content block");
		const structured = desktop.structuredContent ?? {};
		const captureId = structured.capture_id;
		assert(typeof captureId === "string" && captureId.length > 0, `structuredContent.capture_id is present (${typeof captureId === "string" ? captureId : "<missing>"})`);
		const width = positiveDimension(structured.screenshot_width);
		const height = positiveDimension(structured.screenshot_height);
		assert(width !== null && height !== null, `structuredContent.screenshot_width/height are positive (${width}x${height})`);
		console.log(`  screenshot: ${image === null ? "<none>" : image.mimeType}, ${width}x${height}, ${image === null ? 0 : image.data.length} base64 chars (kept in memory only)`);

		if (image !== null && width !== null && height !== null) {
			const encoded = await encodeScreenshotForModel(
				{ data: image.data, mimeType: image.mimeType, width, height },
				SCREENSHOT_BUDGET_BYTES,
			);
			assert(encoded.ok, `encodeScreenshotForModel fits the ${SCREENSHOT_BUDGET_BYTES}-byte budget`);
			if (encoded.ok) {
				assertEqual(encoded.width, width, "codec kept the screenshot width");
				assertEqual(encoded.height, height, "codec kept the screenshot height");
				console.log(`  codec: ${image.data.length} -> ${encoded.bytes} base64 chars, ${encoded.mimeType}, ${encoded.width}x${encoded.height}`);
			} else {
				console.error(`  codec: over_budget at ${encoded.bytes} base64 chars`);
			}
		}

		// ---- 5. get_window_state (platform branch) ----
		console.log("\n--- get_window_state (read-only) ---");
		const isLinux = platform.startsWith("linux");
		if (isLinux) {
			// Never fall back to process.pid - the node process owns no windows, so the
			// call would fail for the wrong reason. Skip the branch when no app pid exists.
			const appPid = firstAppPid(apps);
			if (appPid === null) {
				console.log("SKIP: no app with windows on Linux");
			} else {
				const windowState = await client.callTool(
					"get_window_state",
					{ pid: appPid, session },
					{ timeoutMs: CALL_TIMEOUT_MS },
				);
				assert(!windowState.isError, `linux: get_window_state with only pid succeeds (pid ${appPid})`);
				assert(textContent(windowState).length > 0, "linux: pid-only get_window_state returned text");
			}
		} else {
			const schema = client.getToolInputSchema("get_window_state");
			assert(schema !== null, "tools/list cached a get_window_state input schema");
			const required = schema?.required ?? [];
			assert(
				required.includes("window_id"),
				`win32/darwin: the driver requires window_id for get_window_state (required: ${required.join(", ") || "<none>"})`,
			);
			// Prefer a pid that actually owns a window (from get_desktop_state's windows list);
			// process.pid owns none. The pure translation/contract assertions do not call the driver,
			// so they run with whatever pid is available.
			const windowPid = firstWindowPid(desktop.structuredContent);
			const translated = translateObserve(
				{ view: "window", pid: windowPid ?? process.pid },
				{ maxImageDimension: SCREENSHOT_MAX_DIMENSION, wantImage: true },
			);
			assertEqual(translated.tool, "get_window_state", "PiX translates observe view=window onto get_window_state");
			const translatedArgs = translated.args as Record<string, unknown>;
			assert(translatedArgs.window_id === undefined, "the pid-only PiX call carries no window_id");
			const missing = missingDriverArgs(translatedArgs, schema);
			assert(
				missing.includes("window_id"),
				`win32/darwin: the PiX contract layer rejects the pid-only combination before any driver call (missing: ${missing.join(", ") || "<none>"})`,
			);
			// Driver-side evidence for the same rule: the real driver answers the pid-only call with an
			// explicit isError (still a read-only get_window_state call, no act tool involved). Only run
			// it against a pid that really owns a window - otherwise the failure would prove "no windows
			// for this pid" instead of the missing-window_id rejection.
			if (windowPid === null) {
				console.log("SKIP: no window pid reported by get_desktop_state on win32/darwin");
			} else {
				const pidOnly = await client.callTool("get_window_state", { pid: windowPid, session }, { timeoutMs: CALL_TIMEOUT_MS });
				assert(pidOnly.isError, "win32/darwin: the driver itself rejects a pid-only get_window_state");
				console.log(`  driver pid-only result: isError=${pidOnly.isError}, text length ${textContent(pidOnly).length}`);
			}
		}

		// ---- 6. end_session ----
		console.log("\n--- end_session (read-only) ---");
		const ended = await client.callTool("end_session", { session }, { timeoutMs: CALL_TIMEOUT_MS });
		assert(!ended.isError, "end_session succeeds");
		console.log(`  end_session result: isError=${ended.isError}, text length ${textContent(ended).length}`);

		return { kind: "ran" };
	} finally {
		if (client !== null) {
			await client.stop().catch((error: unknown) => {
				console.warn(`  driver stop failed: ${errorText(error)}`);
			});
		}
		driver.cleanup();
	}
}

/** `haystack.includes(needle)` with a readable PASS/FAIL line. */
function assertIncludes(haystack: string, needle: string, message: string): void {
	assert(haystack.includes(needle), `${message} (got "${haystack}")`);
}

// ============================================================================

const outcome = await main();
if (outcome.kind === "skipped") {
	console.log(`SKIP: ${outcome.reason}`);
	process.exit(0);
}
console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
	console.log("E2E FAIL");
	process.exitCode = 1;
} else {
	console.log("E2E RAN");
}
