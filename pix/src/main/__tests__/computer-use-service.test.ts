/**
 * Computer-use application service tests.
 *
 * Pure Node, no Electron, no real driver: the service is driven with an
 * injected fake DriverClient (never spawned), a real DriverInstaller whose
 * download is stubbed, a temp agentDir and a fake Electron surface. Covers
 * lazy start, the 11-row availability table (one case per row), the
 * permission-required path (missing blocks, degraded does not), the
 * emergency-stop shortcut registration window (including the crashed backoff),
 * `emergencyStopAccelerator`, registerShortcut false -> null, emergencyStop
 * (cancelAll + halt every registered controller + forceRelease + broadcast),
 * global disable (stop driver, revoke/reconcile controllers), settings
 * resolution, snapshot aggregation, event coalescing, dispose idempotency,
 * recheck_driver, open_permission_settings and the command surface. The
 * controller -> service pipeline (lazy driver start + lease + backend call) and
 * the extension hooks are covered here as well.
 *
 * Run with: npm exec tsx -- src/main/__tests__/computer-use-service.test.ts
 */

import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "@vitest/runner";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AgentSession,
	ExtensionAPI,
	ExtensionContext,
	RequestUserInputRequest,
	RequestUserInputResponse,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
	ComputerUseEvent,
	ComputerUsePlatform,
	ComputerUseSettings,
} from "../../shared/computer-use-types.js";
import {
	COMPUTER_ACT_TOOL_NAME,
	COMPUTER_OBSERVE_TOOL_NAME,
	COMPUTER_USE_CUSTOM_TYPE,
} from "../../shared/computer-use-types.js";
import type {
	DriverCallOptions,
	DriverClient,
	DriverClientState,
	DriverToolInputSchema,
	DriverToolResult,
} from "../computer-use/contracts.js";
import { ComputerUseError } from "../computer-use/contracts.js";
import { createComputerUseExtension } from "../computer-use/computer-use-extension.js";
import { DriverInstaller } from "../computer-use/driver-installer.js";
import { DRIVER_ASSETS } from "../computer-use/driver-manifest.js";
import type { McpDriverClientOptions } from "../computer-use/mcp-driver-client.js";
import {
	ComputerUseService,
	emergencyStopAccelerator,
	type ComputerUseServiceDeps,
} from "../computer-use/computer-use-service.js";
import type { ComputerUseSessionController } from "../computer-use/session-controller.js";

// ============================================================================
// Harness (PASS/FAIL counters, same style as todo-ipc.test.ts)
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

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message} - expected ${b}, got ${a}`);
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Await `promise`, expect a ComputerUseError and return it (null on mismatch). */
async function expectComputerUseError(promise: Promise<unknown>, code: string, message: string): Promise<ComputerUseError | null> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof ComputerUseError && err.code === code) {
			passed++;
			console.log(`  PASS: ${message}`);
			return err;
		}
		failed++;
		console.error(`  FAIL: ${message} - expected ComputerUseError(${code}), got ${String(err)}`);
		return null;
	}
	failed++;
	console.error(`  FAIL: ${message} - expected a rejection, call resolved`);
	return null;
}

/** Poll until `predicate` is true (event-driven assertions, no fixed sleeps). */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) {
			passed++;
			console.log(`  PASS: ${message}`);
			return;
		}
		await sleep(10);
	}
	failed++;
	console.error(`  FAIL: ${message} - timed out after ${timeoutMs}ms`);
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

// ============================================================================
// Fakes
// ============================================================================

/** Structurally implements DriverClient without ever spawning anything. */
class FakeDriverClient implements DriverClient {
	state: DriverClientState = "idle";
	readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	ensureStartedCalls = 0;
	stopCalls = 0;
	cancelAllCalls = 0;
	permissions: Record<string, unknown> = {};
	/** check_permissions answers with isError -> backend.checkPermissions throws (driver_error). */
	checkPermissionsIsError = false;
	startGate: Deferred<void> | null = null;
	/** Holds stop() until released: lets tests park a reset/dispose mid-stop. */
	stopGate: Deferred<void> | null = null;
	startFailure: ComputerUseError | null = null;
	private readonly _listeners = new Set<(state: DriverClientState, detail?: string) => void>();

	async ensureStarted(): Promise<void> {
		this.ensureStartedCalls++;
		if (this.startGate !== null) {
			this._setState("starting");
			await this.startGate.promise;
		}
		if (this.startFailure !== null) {
			this._setState("failed", this.startFailure.detail);
			throw this.startFailure;
		}
		this._setState("ready");
	}

	listToolNames(): ReadonlySet<string> {
		return new Set(["check_permissions", "start_session", "end_session", "click", "get_window_state"]);
	}

	getToolInputSchema(): DriverToolInputSchema | null {
		return null;
	}

	async callTool(name: string, args: Record<string, unknown>, _opts?: DriverCallOptions): Promise<DriverToolResult> {
		this.calls.push({ name, args });
		switch (name) {
			case "check_permissions":
				return {
					content: this.checkPermissionsIsError
						? [{ type: "text", text: "driver exploded: internal error" }]
						: [],
					structuredContent: this.permissions,
					isError: this.checkPermissionsIsError,
				};
			case "start_session":
			case "end_session":
				return { content: [{ type: "text", text: `${name} ok` }], isError: false };
			case "get_window_state":
			case "get_desktop_state":
				return {
					content: [{ type: "text", text: "window tree" }],
					structuredContent: { capture_id: "c_1", screenshot_width: 640, screenshot_height: 480 },
					isError: false,
				};
			default:
				return {
					content: [{ type: "text", text: `did ${name}` }],
					structuredContent: { effect: "unverifiable" },
					isError: false,
				};
		}
	}

	cancelAll(): void {
		this.cancelAllCalls++;
	}

	async stop(): Promise<void> {
		this.stopCalls++;
		if (this.stopGate !== null) await this.stopGate.promise;
		this._setState("idle");
	}

	onStateChange(listener: (state: DriverClientState, detail?: string) => void): () => void {
		this._listeners.add(listener);
		return () => {
			this._listeners.delete(listener);
		};
	}

	/** Test-only state transition (crash / restart / shutdown). */
	setState(state: DriverClientState, detail?: string): void {
		this._setState(state, detail);
	}

	private _setState(state: DriverClientState, detail?: string): void {
		this.state = state;
		for (const listener of [...this._listeners]) listener(state, detail);
	}
}

class FakeElectron {
	readonly registered = new Map<string, () => void>();
	readonly registerCalls: string[] = [];
	readonly unregisterCalls: string[] = [];
	readonly openedUrls: string[] = [];
	registerResult = true;

	electronDeps(): NonNullable<ComputerUseServiceDeps["electron"]> {
		return {
			registerShortcut: (accelerator: string, cb: () => void): boolean => {
				this.registerCalls.push(accelerator);
				if (!this.registerResult) return false;
				this.registered.set(accelerator, cb);
				return true;
			},
			unregisterShortcut: (accelerator: string): void => {
				this.unregisterCalls.push(accelerator);
				this.registered.delete(accelerator);
			},
			surface: { getPixPids: () => [], isPixFocused: () => false },
			openExternal: async (url: string): Promise<void> => {
				this.openedUrls.push(url);
			},
		};
	}
}

class FakeSession {
	readonly registry: Set<string>;
	activeTools: string[] = [];
	isStreaming = false;
	mode: "approval" | "unattended" | "read-only" = "approval";
	blockImages = false;
	abortCalls = 0;
	readonly settingsManager = {
		getExecutionMode: (): string => this.mode,
		getBlockImages: (): boolean => this.blockImages,
	};

	constructor(registry: string[]) {
		this.registry = new Set(registry);
	}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	/** Mirrors AgentSession: unknown names are silently dropped (agent-session.ts:1254-1266). */
	setActiveToolsByName(names: string[]): void {
		this.activeTools = names.filter((name) => this.registry.has(name));
	}

	abort(): Promise<void> {
		this.abortCalls++;
		return Promise.resolve();
	}

	asSession(): AgentSession {
		return this as unknown as AgentSession;
	}
}

class FakeSessionManager {
	branch: unknown[] = [];
	readonly appended: Array<{ customType: string; data: unknown }> = [];

	appendCustomEntry(customType: string, data?: unknown): string {
		this.appended.push({ customType, data });
		return `entry-${this.appended.length}`;
	}

	getBranch(): unknown[] {
		return this.branch;
	}

	getSessionId(): string {
		return "session-1";
	}

	asManager(): SessionManager {
		return this as unknown as SessionManager;
	}
}

interface FakeController {
	controller: ComputerUseSessionController;
	session: FakeSession;
	manager: FakeSessionManager;
}

function makeController(
	service: ComputerUseService,
	genId: number,
	opts: { mode?: "approval" | "unattended" | "read-only"; branch?: unknown[] } = {},
): FakeController {
	const session = new FakeSession([COMPUTER_OBSERVE_TOOL_NAME, COMPUTER_ACT_TOOL_NAME]);
	session.mode = opts.mode ?? "approval";
	const manager = new FakeSessionManager();
	manager.branch = opts.branch ?? [];
	const controller = service.createController({
		genId,
		getSession: () => session.asSession(),
		getSessionManager: () => manager.asManager(),
		isForeground: () => true,
		requestUserInput: async (request: RequestUserInputRequest): Promise<RequestUserInputResponse> => ({
			id: request.id,
			answers: {},
		}),
		isPlanRestricted: () => false,
	});
	return { controller, session, manager };
}

function makeCtx(input: ("text" | "image")[] = ["text", "image"]): ExtensionContext {
	return { model: { input } } as unknown as ExtensionContext;
}

function customEntry(data: unknown, id: string): unknown {
	return { type: "custom", customType: COMPUTER_USE_CUSTOM_TYPE, data, id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}

interface HarnessOptions {
	agentDir?: string;
	settings?: ComputerUseSettings;
	platform?: ComputerUsePlatform | null;
	nodePlatform?: NodeJS.Platform;
	electron?: FakeElectron;
	installer?: DriverInstaller;
	probeDriver?: (binaryPath: string) => Promise<string>;
	createClient?: (opts: McpDriverClientOptions) => DriverClient;
	idleStopMs?: number;
	appVersion?: string;
}

interface Harness {
	service: ComputerUseService;
	client: FakeDriverClient;
	events: ComputerUseEvent[];
}

/** Every temp agentDir created by makeAgentDir (swept once at file end). */
const createdAgentDirs: string[] = [];

async function makeAgentDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "pix-computer-use-service-"));
	createdAgentDirs.push(dir);
	return dir;
}

/**
 * Default settings point the custom driver path at the running Node binary:
 * `resolveDriverBinary` accepts it and `probeDriverVersion` returns
 * `process.versions.node`, which is a legal "custom driver, different version"
 * case. Tests that need `driver_missing` pass a fresh agentDir and no
 * driverPath.
 */
async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
	const agentDir = opts.agentDir ?? (await makeAgentDir());
	const client = new FakeDriverClient();
	const electron = opts.electron ?? null;
	const events: ComputerUseEvent[] = [];
	const service = new ComputerUseService({
		agentDir,
		initialSettings: opts.settings ?? { enabled: true, driverPath: process.execPath },
		platform: opts.platform !== undefined ? opts.platform : "win32-x64",
		nodePlatform: opts.nodePlatform ?? "win32",
		createClient: opts.createClient ?? ((_opts: McpDriverClientOptions) => client),
		...(opts.installer !== undefined ? { installer: opts.installer } : {}),
		...(opts.probeDriver !== undefined ? { probeDriver: opts.probeDriver } : {}),
		...(opts.idleStopMs !== undefined ? { idleStopMs: opts.idleStopMs } : {}),
		...(opts.appVersion !== undefined ? { appVersion: opts.appVersion } : {}),
		...(electron !== null ? { electron: electron.electronDeps() } : {}),
	});
	service.onEvent((event) => events.push(event));
	return { service, client, events };
}

/** A fetch that only ever settles by aborting: keeps DriverInstaller in "downloading". */
const pendingFetch: typeof fetch = (_input, init) =>
	new Promise<Response>((_resolve, reject) => {
		const signal = init?.signal;
		const onAbort = (): void => reject(new Error("download aborted"));
		if (signal?.aborted === true) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/**
 * Temporarily pin the manifest digest to the fixture digest so an offline
 * fixture can complete the install success path (same trick as the installer
 * test file's withAssetSha).
 */
async function withAssetSha<T>(platform: ComputerUsePlatform, sha256: string, fn: () => Promise<T>): Promise<T> {
	const asset = DRIVER_ASSETS[platform] as { sha256: string };
	const original = asset.sha256;
	asset.sha256 = sha256;
	try {
		return await fn();
	} finally {
		asset.sha256 = original;
	}
}

function screenshotMessage(captureId: string): unknown {
	return {
		role: "toolResult",
		toolName: COMPUTER_OBSERVE_TOOL_NAME,
		content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
		details: { captureId },
	};
}

// ============================================================================
// Tests: accelerator constant
// ============================================================================

await run("emergencyStopAccelerator: per-platform values", async () => {
	assertEqual(emergencyStopAccelerator("win32"), "Control+Alt+Escape", "windows accelerator");
	assertEqual(emergencyStopAccelerator("darwin"), "Control+Alt+Escape", "macOS accelerator is Ctrl+Option+Esc");
	assertEqual(emergencyStopAccelerator("linux"), "Control+Alt+Shift+Escape", "linux accelerator avoids KDE xkill");
	assertEqual(emergencyStopAccelerator("freebsd"), null, "unknown platform has no accelerator");
});

// ============================================================================
// Tests: availability table (11 rows)
// ============================================================================

await run("availability row 1: global switch off -> disabled", async () => {
	const h = await makeHarness({ settings: { enabled: false } });
	await h.service.init();
	const snap = h.service.getSnapshot();
	assertEqual(snap.availability, "disabled", "disabled when the global switch is off");
	assertEqual(snap.availabilityDetail, undefined, "no detail for the disabled row");
	assertEqual(snap.platform, "win32-x64", "platform is reported");
	assertEqual(snap.driver.expectedVersion, "0.34.1", "driver info carries DRIVER_VERSION");
	assertEqual(snap.driver.version, null, "no probe while disabled");
	assertEqual(snap.session, null, "no session without a foreground controller");
	assertEqual(snap.install, null, "no install progress");
	assertEqual(snap.emergencyShortcut, null, "no shortcut without electron deps");
	assertEqual(h.service.isGloballyEnabled(), false, "isGloballyEnabled reflects the switch");
});

await run("availability row 2: platform null -> unsupported_platform", async () => {
	const h = await makeHarness({ settings: { enabled: true }, platform: null });
	await h.service.init();
	const snap = h.service.getSnapshot();
	assertEqual(snap.availability, "unsupported_platform", "unsupported platform");
	assertEqual(snap.availabilityDetail, "当前平台不受支持", "Chinese detail");
	assertEqual(snap.driver.source, null, "no driver source");
	const err = await expectComputerUseError(h.service.ensureReady(), "unsupported_on_platform", "ensureReady refuses unsupported platforms");
	assertEqual(err?.code, "unsupported_on_platform", "error code");
});

await run("availability row 3: installer running -> installing (+ progress, cancel)", async () => {
	const agentDir = await makeAgentDir();
	const installer = new DriverInstaller({
		agentDir,
		platform: "win32-x64",
		baseUrl: "http://127.0.0.1:9",
		fetchImpl: pendingFetch,
		extract: async () => undefined,
	});
	const h = await makeHarness({ agentDir, installer, settings: { enabled: true } });
	await h.service.init();
	assertEqual(h.service.getSnapshot().availability, "driver_missing", "driver not installed yet");

	const result = await h.service.execute({ type: "install_driver" });
	assertEqual(result.success, true, "install_driver succeeds");
	assertEqual(result.success ? result.data?.availability : null, "installing", "availability is installing while downloading");
	await waitFor(
		() => h.events.some((e) => e.type === "install_progress" && e.progress.phase === "downloading"),
		"downloading progress event emitted",
	);
	assertEqual(h.service.getSnapshot().install?.phase, "downloading", "snapshot carries the install progress");

	await h.service.execute({ type: "cancel_install" });
	await waitFor(
		() => h.events.some((e) => e.type === "install_progress" && e.progress.phase === "cancelled"),
		"cancelled progress event emitted",
	);
	await waitFor(() => h.service.getSnapshot().availability === "driver_missing", "availability returns to driver_missing after cancel");
});

await run("availability row 4: no driver -> driver_missing", async () => {
	const h = await makeHarness({ settings: { enabled: true } });
	await h.service.init();
	const snap = h.service.getSnapshot();
	assertEqual(snap.availability, "driver_missing", "driver missing");
	assertEqual(snap.availabilityDetail, "未安装操控驱动", "Chinese detail");
	assertEqual(snap.driver.path, null, "no driver path");
	await expectComputerUseError(h.service.ensureReady(), "unavailable", "ensureReady refuses a missing driver");
});

await run("availability row 5a: version probe fails -> driver_incompatible", async () => {
	const agentDir = await makeAgentDir();
	const bogus = path.join(agentDir, process.platform === "win32" ? "bogus-driver.exe" : "bogus-driver");
	await writeFile(bogus, "this is not an executable\n");
	await chmod(bogus, 0o755).catch(() => undefined);
	const h = await makeHarness({ agentDir, settings: { enabled: true, driverPath: bogus } });
	await h.service.init();
	const snap = h.service.getSnapshot();
	assertEqual(snap.availability, "driver_incompatible", "probe failure maps to driver_incompatible");
	assertEqual(snap.availabilityDetail, "驱动版本不兼容，请重新安装", "Chinese detail");
	assertEqual(snap.driver.path, bogus, "path is reported for diagnosis");
	assertEqual(snap.driver.version, null, "no version");
	await expectComputerUseError(h.service.ensureReady(), "driver_incompatible", "ensureReady refuses an unidentifiable driver with the row 5 code");
});

await run("availability row 5b: client failed with driver_incompatible detail", async () => {
	const h = await makeHarness({});
	await h.service.init();
	// Production shape (mcp-driver-client): missing DRIVER_REQUIRED_TOOLS rejects
	// with the driver_incompatible code and the same-prefixed detail.
	h.client.startFailure = new ComputerUseError("driver_incompatible", "driver_incompatible: missing click, hotkey");
	await expectComputerUseError(h.service.ensureReady(), "driver_incompatible", "ensureReady surfaces the client failure");
	const snap = h.service.getSnapshot();
	assertEqual(snap.availability, "driver_incompatible", "failed + driver_incompatible prefix -> driver_incompatible");
	assertEqual(snap.availabilityDetail, "驱动版本不兼容，请重新安装", "Chinese detail");
});

await run("availability row 6: client failed for another reason -> failed (detail tail)", async () => {
	const h = await makeHarness({});
	await h.service.init();
	h.client.startFailure = new ComputerUseError("unavailable", "cua-driver: handshake timed out after 20000ms (stderr tail)");
	await expectComputerUseError(h.service.ensureReady(), "unavailable", "ensureReady surfaces the start failure");
	const snap = h.service.getSnapshot();
	assertEqual(snap.availability, "failed", "other failures -> failed");
	assert((snap.availabilityDetail ?? "").includes("驱动启动失败"), "detail prefixes the failure");
	assert((snap.availabilityDetail ?? "").includes("handshake timed out"), "detail carries the stderr tail");
});

await run("availability row 7: client idle/stopping -> stopped (custom version warning)", async () => {
	const h = await makeHarness({});
	await h.service.init();
	const snap = h.service.getSnapshot();
	assertEqual(snap.availability, "stopped", "resolved but not started -> stopped");
	assertEqual(snap.driver.source, "custom", "custom driver source");
	assertEqual(snap.driver.path, process.execPath, "custom driver path");
	assertEqual(snap.driver.version, process.versions.node, "probed version");
	assert((snap.availabilityDetail ?? "").includes("驱动已就绪"), "detail explains lazy start");
	assert((snap.availabilityDetail ?? "").includes("不一致"), "custom version mismatch warning is attached");
	assert((snap.availabilityDetail ?? "").includes(process.versions.node), "warning names the probed version");
});

await run("availability row 8/9/10/11: starting / crashed-as-starting / permission_required / ready", async () => {
	const h = await makeHarness({ platform: "linux-x64", settings: { enabled: true, driverPath: process.execPath } });
	await h.service.init();

	// Row 8: starting (gated start).
	h.client.startGate = createDeferred<void>();
	const readyPromise = h.service.ensureReady();
	await sleep(10);
	assertEqual(h.service.getSnapshot().availability, "starting", "row 8: starting");
	h.client.startGate.resolve();
	await readyPromise;

	// Row 11: ready.
	const ready = h.service.getSnapshot();
	assertEqual(ready.availability, "ready", "row 11: ready");
	assert((ready.availabilityDetail ?? "").includes("驱动已就绪"), "ready detail");

	// Row 9: crashed -> starting with the crash ordinal.
	h.client.setState("crashed");
	const crashed = h.service.getSnapshot();
	assertEqual(crashed.availability, "starting", "row 9: crashed maps to starting");
	assert((crashed.availabilityDetail ?? "").includes("正在重启"), "crashed detail explains the restart");
	assert((crashed.availabilityDetail ?? "").includes("第 1 次"), "crashed detail carries the ordinal");
	h.client.setState("ready");

	// Row 10: ready + missing permissions.
	h.client.permissions = { x11: false, wayland: false };
	await expectComputerUseError(h.service.ensureReady(), "permission_required", "missing permissions block ensureReady");
	const blocked = h.service.getSnapshot();
	assertEqual(blocked.availability, "permission_required", "row 10: permission_required");
	assert((blocked.availabilityDetail ?? "").includes("图形显示会话"), "missing item uses its Chinese label");
	assertDeepEqual(blocked.missingPermissions, ["display"], "missingPermissions in the snapshot");

	// Row 11 with degraded only: never blocking (Wayland without X11, no AT-SPI).
	h.client.permissions = { x11: false, wayland: true, atspi: false };
	await h.service.ensureReady();
	const degraded = h.service.getSnapshot();
	assertEqual(degraded.availability, "ready", "degraded capabilities do not block");
	assertDeepEqual(degraded.degradedCapabilities, ["accessibility_tree", "background_input"], "degradedCapabilities in the snapshot");
	assertEqual(degraded.missingPermissions, undefined, "no blocking permissions");
	assert((degraded.availabilityDetail ?? "").includes("能力受限"), "degraded detail");
});

// ============================================================================
// Tests: lazy start + permission gate
// ============================================================================

await run("ensureReady: lazy start runs resolve -> probe -> client -> checkPermissions", async () => {
	const h = await makeHarness({});
	await h.service.init();
	assertEqual(h.client.ensureStartedCalls, 0, "init never starts the driver process");
	assertEqual(h.client.calls.length, 0, "no driver calls before the first tool call");

	await h.service.ensureReady();
	assertEqual(h.client.ensureStartedCalls, 1, "ensureStarted called once");
	assertEqual(h.client.calls.filter((c) => c.name === "check_permissions").length, 1, "checkPermissions called after start");

	await h.service.ensureReady();
	assertEqual(h.client.ensureStartedCalls, 1, "ensureStarted is idempotent");
	assertEqual(h.service.getSnapshot().availability, "ready", "availability ready");
});

await run("ensureReady: permission_required hint points at the settings page", async () => {
	const h = await makeHarness({ platform: "linux-x64", settings: { enabled: true, driverPath: process.execPath } });
	await h.service.init();
	h.client.permissions = { x11: false, wayland: false };
	const err = await expectComputerUseError(h.service.ensureReady(), "permission_required", "missing permission blocks");
	assert((err?.message ?? "").includes("[computer_use:permission_required]"), "message carries the code prefix");
	assert((err?.message ?? "").includes("Hint:"), "message carries a hint");
	assert((err?.message ?? "").includes("Settings"), "hint points at the settings page");
});

// ============================================================================
// Tests: emergency-stop shortcut
// ============================================================================

await run("shortcut: registered for starting/ready/permission_required, kept through crash backoff", async () => {
	const electron = new FakeElectron();
	const h = await makeHarness({
		electron,
		nodePlatform: "linux",
		platform: "linux-x64",
		settings: { enabled: true, driverPath: process.execPath },
	});
	await h.service.init();
	assertEqual(electron.registerCalls.length, 0, "not registered while stopped");
	assertEqual(h.service.getSnapshot().emergencyShortcut, null, "no accelerator while stopped");

	h.client.startGate = createDeferred<void>();
	const readyPromise = h.service.ensureReady();
	await sleep(10);
	assertEqual(h.service.getSnapshot().availability, "starting", "state is starting");
	assertEqual(electron.registerCalls.length, 1, "registered on the starting transition");
	assertEqual(electron.registerCalls[0], "Control+Alt+Shift+Escape", "linux accelerator is used");
	assertEqual(h.service.getSnapshot().emergencyShortcut, "Control+Alt+Shift+Escape", "snapshot exposes the accelerator");
	h.client.startGate.resolve();
	await readyPromise;
	assertEqual(h.service.getSnapshot().availability, "ready", "state is ready");
	assertEqual(electron.unregisterCalls.length, 0, "no unregister on starting -> ready");
	assertEqual(electron.registerCalls.length, 1, "no re-register on starting -> ready");

	// permission_required keeps it registered.
	h.client.permissions = { x11: false, wayland: false };
	await expectComputerUseError(h.service.ensureReady(), "permission_required", "permission gate hits");
	assertEqual(h.service.getSnapshot().availability, "permission_required", "state is permission_required");
	assertEqual(electron.unregisterCalls.length, 0, "still registered while permission is missing");

	// crashed (backoff) maps to starting: no unregister/re-register churn.
	h.client.setState("crashed");
	assertEqual(h.service.getSnapshot().availability, "starting", "crashed maps to starting");
	assertEqual(electron.unregisterCalls.length, 0, "kept registered during the backoff");
	assertEqual(electron.registerCalls.length, 1, "no re-register during the backoff");

	// Leaving the registration window unregisters.
	h.client.setState("idle");
	assertEqual(electron.unregisterCalls.length, 1, "unregistered when the driver stops");
	assertEqual(h.service.getSnapshot().emergencyShortcut, null, "accelerator cleared");
	assertEqual(electron.registered.size, 0, "no live registration left");
});

await run("shortcut: registerShortcut false -> emergencyShortcut stays null", async () => {
	const electron = new FakeElectron();
	electron.registerResult = false;
	const h = await makeHarness({ electron });
	await h.service.init();
	await h.service.ensureReady();
	assertEqual(h.service.getSnapshot().availability, "ready", "driver is ready");
	assertEqual(electron.registerCalls.length, 1, "registration was attempted");
	assertEqual(h.service.getSnapshot().emergencyShortcut, null, "failed registration leaves the shortcut null");
});

// ============================================================================
// Tests: emergency stop / global disable / controller registry
// ============================================================================

await run("controller -> service pipeline: lazy start, lease, backend call, emergencyStop", async () => {
	const h = await makeHarness({});
	await h.service.init();
	const c1 = makeController(h.service, 1, { mode: "unattended" });
	const c2 = makeController(h.service, 2);
	c1.controller.setSessionEnabled(true);
	c2.controller.setSessionEnabled(true);
	h.service.setForegroundControllerProvider(() => c1.controller);
	assertEqual(c1.controller.getSnapshot()?.toolsActive, true, "reconcile activated the tools");
	assertEqual(h.client.ensureStartedCalls, 0, "controller creation does not start the driver");

	const result = await c1.controller.act(
		"t1",
		{ action: "click", pid: 4242, window_id: 77, element_token: "s1a2b3c4d:5" },
		undefined,
		makeCtx(),
	);
	const text = result.content[0].type === "text" ? result.content[0].text : "";
	assert(text.includes("did click"), "action result text is the driver text");
	assert(text.includes("[pix] capture_id=c_1 frame=window"), "post-action observation reported");
	assert(text.includes("grant=background"), "grant level reported");
	assert(text.includes("effect=unverifiable"), "driver effect passed through");
	assertEqual(result.details?.driverTool, "click", "driver tool recorded in details");
	assertEqual(h.client.ensureStartedCalls, 1, "lazy start happened exactly once");
	assert(
		h.client.calls.some((c) => c.name === "start_session") && h.client.calls.some((c) => c.name === "click"),
		"driver session opened and click dispatched",
	);
	assertEqual(c1.controller.getSnapshot()?.holdsLease, true, "controller holds the desktop lease");

	h.service.emergencyStop();
	assertEqual(h.client.cancelAllCalls, 1, "cancelAll called once");
	assertEqual(c1.session.abortCalls, 1, "first controller halted (session.abort)");
	assertEqual(c2.session.abortCalls, 1, "second controller halted (session.abort)");
	assertEqual(c1.controller.getSnapshot()?.halted, true, "first controller halted flag");
	assertEqual(c2.controller.getSnapshot()?.halted, true, "second controller halted flag");
	assertEqual(c1.controller.getSnapshot()?.holdsLease, false, "lease force-released");
	assertEqual(c1.controller.getSnapshot()?.grant, "none", "grant revoked");
	await waitFor(() => h.events.some((e) => e.type === "snapshot"), "snapshot broadcast after the emergency stop");
});

await run("controller registry: disposed controllers are no longer halted", async () => {
	const h = await makeHarness({});
	await h.service.init();
	const live = makeController(h.service, 1);
	const gone = makeController(h.service, 2);
	await gone.controller.dispose();
	h.service.emergencyStop();
	assertEqual(gone.session.abortCalls, 0, "disposed controller is not halted");
	assertEqual(live.session.abortCalls, 1, "live controller is halted");
});

await run("global disable: stop driver + revoke/reconcile controllers + forceRelease", async () => {
	const h = await makeHarness({});
	await h.service.init();
	const { controller, session } = makeController(h.service, 3);
	controller.setSessionEnabled(true);
	assertEqual(controller.getSnapshot()?.toolsActive, true, "tools active before the switch-off");
	await h.service.ensureReady();
	assertEqual(h.service.getSnapshot().availability, "ready", "driver running");

	h.service.updateSettings({ enabled: false });
	await waitFor(() => h.client.stopCalls >= 1, "driver stopped on global disable");
	assertEqual(h.service.getSnapshot().availability, "disabled", "availability disabled");
	assertEqual(controller.getSnapshot()?.toolsActive, false, "tools reconciled away immediately");
	assertEqual(controller.getSnapshot()?.inactiveReason, "global_disabled", "inactive reason is global_disabled");
	assertEqual(controller.getSnapshot()?.grant, "none", "grants revoked");
	assertEqual(controller.getSnapshot()?.holdsLease, false, "lease released");
	assertEqual(session.abortCalls, 0, "global disable does not halt the session");
});

// ============================================================================
// Tests: settings, snapshot aggregation, events, commands, dispose
// ============================================================================

await run("getResolvedSettings: updateSettings applies defaults and clamps", async () => {
	const h = await makeHarness({ settings: { enabled: false } });
	await h.service.init();
	assertDeepEqual(h.service.getResolvedSettings(), {
		enabled: false,
		driverPath: null,
		maxImageDimension: 1568,
		screenshotMaxBytes: 450_000,
		keepRecentScreenshots: 3,
		defaultSessionEnabled: false,
	}, "defaults for an undefined-shaped setting");
	h.service.updateSettings({ enabled: true, maxImageDimension: 99_999, keepRecentScreenshots: 0, defaultSessionEnabled: true });
	const resolved = h.service.getResolvedSettings();
	assertEqual(resolved.enabled, true, "enabled reflected");
	assertEqual(resolved.maxImageDimension, 2560, "maxImageDimension clamped to the upper bound");
	assertEqual(resolved.keepRecentScreenshots, 1, "keepRecentScreenshots clamped to the lower bound");
	assertEqual(resolved.defaultSessionEnabled, true, "defaultSessionEnabled reflected");
	assertEqual(resolved.screenshotMaxBytes, 450_000, "untouched value keeps its default");
});

await run("snapshot: aggregation includes the foreground controller; events are coalesced", async () => {
	const h = await makeHarness({});
	await h.service.init();
	await sleep(80);
	const { controller, manager } = makeController(h.service, 4);
	h.service.setForegroundControllerProvider(() => controller);
	const snap = h.service.getSnapshot();
	assertEqual(snap.session?.sessionId, "session-1", "session snapshot comes from the foreground controller");
	assertEqual(snap.session?.sessionEnabled, false, "session toggle default");
	assertEqual(snap.session?.grant, "none", "no grant yet");
	assertEqual(h.events.filter((e) => e.type === "snapshot").length >= 1, true, "init broadcast a snapshot");

	h.events.length = 0;
	controller.setSessionEnabled(true);
	controller.setSessionEnabled(false);
	h.service.emergencyStop();
	await waitFor(() => h.events.some((e) => e.type === "snapshot"), "snapshot event arrives after the coalescing window");
	await sleep(120);
	const snapshots = h.events.filter((e) => e.type === "snapshot");
	assertEqual(snapshots.length, 1, "three triggers inside one 50ms window produce one snapshot event");
	const last = snapshots[0];
	assertEqual(last.type === "snapshot" ? last.snapshot.session?.sessionId : null, "session-1", "coalesced snapshot carries the session");
	assertEqual(manager.appended.length, 2, "session toggle entries were persisted");
});

await run("execute: session toggle, revoke, get_snapshot and missing foreground session", async () => {
	const h = await makeHarness({});
	await h.service.init();
	const missing = await h.service.execute({ type: "set_session_enabled", enabled: true });
	assert(missing.success === false, "set_session_enabled without a foreground controller fails");
	assertEqual(missing.success === false ? missing.code : null, "computer_use_unavailable", "failure code");
	const noop = await h.service.execute({ type: "revoke_grants" });
	assertEqual(noop.success, true, "revoke_grants is a no-op without a controller");

	const { controller } = makeController(h.service, 5);
	h.service.setForegroundControllerProvider(() => controller);
	const on = await h.service.execute({ type: "set_session_enabled", enabled: true });
	assertEqual(on.success ? on.data?.session?.sessionEnabled : null, true, "toggle on is reflected in the returned snapshot");
	const off = await h.service.execute({ type: "set_session_enabled", enabled: false });
	assertEqual(off.success ? off.data?.session?.sessionEnabled : null, false, "toggle off is reflected");
	const snapshot = await h.service.execute({ type: "get_snapshot" });
	assertEqual(snapshot.success ? snapshot.data?.platform : null, "win32-x64", "get_snapshot returns the snapshot");
	assertEqual(snapshot.success ? snapshot.data?.updatedAt !== undefined : false, true, "updatedAt present");
});

await run("execute: recheck_driver re-locates, clears the fuse and rebuilds the client", async () => {
	const h = await makeHarness({});
	await h.service.init();
	h.client.startFailure = new ComputerUseError("unavailable", "handshake timed out");
	await expectComputerUseError(h.service.ensureReady(), "unavailable", "first start fails");
	assertEqual(h.service.getSnapshot().availability, "failed", "failed after the start failure");

	const recheck = await h.service.execute({ type: "recheck_driver" });
	assertEqual(recheck.success, true, "recheck_driver succeeds");
	assertEqual(h.client.stopCalls, 1, "the failed client was stopped (fuse cleared)");
	assertEqual(h.service.getSnapshot().availability, "stopped", "driver re-located -> stopped");
	h.client.startFailure = null;
	await h.service.ensureReady();
	assertEqual(h.service.getSnapshot().availability, "ready", "a fresh client starts after recheck");
});

await run("execute: open_permission_settings is macOS-only and deep-links the privacy panes", async () => {
	const electron = new FakeElectron();
	const h = await makeHarness({ electron, nodePlatform: "darwin" });
	await h.service.init();
	const accessibility = await h.service.execute({ type: "open_permission_settings", permission: "accessibility" });
	assertEqual(accessibility.success, true, "accessibility pane opens");
	assertEqual(
		electron.openedUrls[0],
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
		"accessibility URL",
	);
	const screen = await h.service.execute({ type: "open_permission_settings", permission: "screen_recording" });
	assertEqual(screen.success, true, "screen recording pane opens");
	assertEqual(
		electron.openedUrls[1],
		"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
		"screen recording URL",
	);

	const other = new FakeElectron();
	const h2 = await makeHarness({ electron: other, nodePlatform: "win32" });
	await h2.service.init();
	const unsupported = await h2.service.execute({ type: "open_permission_settings", permission: "accessibility" });
	assert(unsupported.success === false, "non-darwin fails");
	assertEqual(unsupported.success === false ? unsupported.code : null, "unsupported_platform", "unsupported_platform code");
	assertEqual(other.openedUrls.length, 0, "nothing opened off macOS");
});

await run("dispose: cancelAll -> controller dispose -> client.stop -> unregister, idempotent", async () => {
	const electron = new FakeElectron();
	const h = await makeHarness({ electron });
	await h.service.init();
	await h.service.ensureReady();
	const { controller, session } = makeController(h.service, 6);
	h.service.setForegroundControllerProvider(() => controller);
	assertEqual(electron.registerCalls.length, 1, "shortcut registered while ready");

	await h.service.dispose();
	assertEqual(h.client.cancelAllCalls, 1, "cancelAll during dispose");
	assertEqual(h.client.stopCalls, 1, "client.stop during dispose");
	assertEqual(electron.unregisterCalls.length, 1, "shortcut unregistered during dispose");
	assertEqual(controller.getSnapshot()?.toolsActive, false, "controller still reports its state after dispose");

	await h.service.dispose();
	assertEqual(h.client.stopCalls, 1, "second dispose is a no-op");
	assertEqual(electron.unregisterCalls.length, 1, "shortcut not unregistered twice");
	assertEqual(session.abortCalls, 0, "dispose does not abort the session");
});

// ============================================================================
// Tests: bug fixes (idle stop, client rebuild on path change, dispose order,
// startup tmp sweep)
// ============================================================================

await run("idle stop: armed even when checkPermissions throws after a successful start", async () => {
	// Short idle window (DI) so the timer fires in real time instead of 10 min.
	const h = await makeHarness({ idleStopMs: 50 });
	await h.service.init();
	h.client.checkPermissionsIsError = true;
	await expectComputerUseError(h.service.ensureReady(), "driver_error", "checkPermissions failure surfaces");
	assertEqual(h.client.state, "ready", "the driver process is up and resident");
	assertEqual(h.client.stopCalls, 0, "not stopped yet");
	await waitFor(() => h.client.stopCalls === 1, "idle stop fired after the idle window despite the failed permission check");
});

await run("updateSettings driverPath: reset+refresh serialized behind an in-flight probe", async () => {
	const agentDir = await makeAgentDir();
	const customA = path.join(agentDir, "driver-a");
	const customB = path.join(agentDir, "driver-b");
	await writeFile(customA, "#!a\n");
	await writeFile(customB, "#!b\n");
	await chmod(customA, 0o755).catch(() => undefined);
	await chmod(customB, 0o755).catch(() => undefined);
	const createdPaths: string[] = [];
	const client = new FakeDriverClient();
	const probeCalls: string[] = [];
	const firstGate = createDeferred<void>();
	let gate: Deferred<void> | null = firstGate;
	const probeDriver = async (binaryPath: string): Promise<string> => {
		probeCalls.push(binaryPath);
		const current = gate;
		if (current !== null) {
			gate = null;
			await current.promise;
		}
		return "9.9.9";
	};
	const h = await makeHarness({
		agentDir,
		settings: { enabled: true, driverPath: customA },
		probeDriver,
		createClient: (opts) => {
			createdPaths.push(opts.executablePath);
			return client;
		},
	});

	// The init refresh resolves customA and gets stuck inside the version probe.
	const initPromise = h.service.init();
	await waitFor(() => probeCalls.length === 1, "the init refresh is stuck in the version probe");
	// driverPath changes while that refresh is still probing the old path.
	h.service.updateSettings({ enabled: true, driverPath: customB });
	firstGate.resolve();
	await initPromise;
	await waitFor(() => h.service.getSnapshot().driver.path === customB, "the queued refresh re-resolves the new path");

	await h.service.ensureReady();
	assert(createdPaths.includes(customA), "the stuck refresh had built a client for the old path first");
	assertEqual(createdPaths.at(-1), customB, "ensureReady uses a client built for the new driver path");
	assertEqual(h.service.getSnapshot().availability, "ready", "ready on the new path");
});

await run("dispose: an ensureReady parked in the version probe must not rebuild a client afterwards", async () => {
	const created: FakeDriverClient[] = [];
	const probeGate = createDeferred<void>();
	let probeEntered = false;
	const h = await makeHarness({
		settings: { enabled: true, driverPath: process.execPath },
		probeDriver: async () => {
			if (probeEntered) return "9.9.9";
			probeEntered = true;
			await probeGate.promise;
			return "9.9.9";
		},
		createClient: () => {
			const client = new FakeDriverClient();
			created.push(client);
			return client;
		},
	});

	// Lazy start reaches the refresh chain and parks inside the version probe.
	const ready = h.service.ensureReady();
	await waitFor(() => probeEntered, "ensureReady is parked inside the gated version probe");
	// dispose() completes while _client is still null (nothing to stop)...
	await h.service.dispose();
	// ...then the probe resolves and the chain would rebuild a client.
	probeGate.resolve();
	await expectComputerUseError(ready, "unavailable", "the parked ensureReady rejects after dispose");
	assertEqual(created.length, 0, "no client was created after dispose");
	assertEqual(created.reduce((sum, c) => sum + c.ensureStartedCalls, 0), 0, "ensureStarted never ran");
	assertEqual(h.service.getSnapshot().availability, "stopped", "the post-dispose snapshot does not report ready");
});

await run("client creation race: a direct ensureReady and a chained reset cannot each build a client", async () => {
	const agentDir = await makeAgentDir();
	const customA = path.join(agentDir, "driver-a");
	const customB = path.join(agentDir, "driver-b");
	await writeFile(customA, "#!a\n");
	await writeFile(customB, "#!b\n");
	await chmod(customA, 0o755).catch(() => undefined);
	await chmod(customB, 0o755).catch(() => undefined);
	const created: FakeDriverClient[] = [];
	const stopGates = [createDeferred<void>(), createDeferred<void>()];
	const h = await makeHarness({
		agentDir,
		settings: { enabled: true, driverPath: customA },
		probeDriver: async () => "9.9.9",
		createClient: () => {
			const client = new FakeDriverClient();
			const gate = stopGates[created.length];
			if (gate !== undefined) client.stopGate = gate;
			created.push(client);
			return client;
		},
	});
	await h.service.init();
	assertEqual(created.length, 1, "init built one client for the initial custom path");

	// A driverPath change parks the chained reset inside the first client's stop().
	h.service.updateSettings({ enabled: true, driverPath: customB });
	await waitFor(() => created[0].stopCalls === 1, "the chained reset is parked stopping the first client");

	// While that reset is parked (state already cleared), a direct ensureReady
	// (not on the driver-info chain) decides to build a client for the still
	// resolved OLD path.
	const ready2 = h.service.ensureReady();
	stopGates[0].resolve();
	// The chained refresh lands on the NEW path and parks resetting that client.
	await waitFor(
		() => created.length >= 2 && created[1].stopCalls === 1,
		"the chained refresh is parked stopping the second client",
	);

	// A second direct ensureReady while the second client's stop is parked.
	const ready3 = h.service.ensureReady();
	stopGates[1].resolve();
	await ready2;
	await ready3;
	// Let the driver-info chain finish its tail (a stale extra client here would
	// overwrite a started one without stopping it).
	await sleep(50);

	const unstopped = created.filter((c) => c.stopCalls === 0);
	assertEqual(unstopped.length, 1, "exactly one created client (the current one) was never stopped");
	assertEqual(
		created.every((c) => c === created.at(-1) || c.stopCalls >= 1),
		true,
		"every replaced client was stopped",
	);
	assertEqual(
		created.slice(0, -1).filter((c) => c.ensureStartedCalls > 0 && c.stopCalls === 0).length,
		0,
		"no started client was left running as an orphan",
	);
	assertEqual(h.service.getSnapshot().driver.path, customB, "the service resolved the new driver path");
});

await run("client rebuild: a re-resolve to a different path drops the old client", async () => {
	const agentDir = await makeAgentDir();
	const customB = path.join(agentDir, "driver-b");
	await writeFile(customB, "#!b\n");
	await chmod(customB, 0o755).catch(() => undefined);
	const createdPaths: string[] = [];
	const client = new FakeDriverClient();
	const h = await makeHarness({
		agentDir,
		settings: { enabled: true, driverPath: customB },
		probeDriver: async () => "9.9.9",
		createClient: (opts) => {
			createdPaths.push(opts.executablePath);
			return client;
		},
	});
	await h.service.init();
	assertDeepEqual(createdPaths, [customB], "initial client built for the custom path");
	assertEqual(h.service.getSnapshot().driver.path, customB, "resolved to the custom path");

	// The custom binary disappears; the next plain refresh (e.g. the post-install
	// refresh) must not keep a client aimed at the vanished path.
	rmSync(customB);
	await h.service.init();
	assertEqual(h.service.getSnapshot().availability, "driver_missing", "the stale client is dropped, not kept");
	assertEqual(client.stopCalls, 1, "the dropped client was stopped");
	await expectComputerUseError(h.service.ensureReady(), "unavailable", "ensureReady refuses the missing driver");
});

await run("dispose: controller sessions are ended (end_session) before the client is dropped", async () => {
	const h = await makeHarness({});
	await h.service.init();
	const { controller } = makeController(h.service, 8, { mode: "unattended" });
	controller.setSessionEnabled(true);
	h.service.setForegroundControllerProvider(() => controller);
	await controller.act(
		"t1",
		{ action: "click", pid: 4242, window_id: 77, element_token: "s1a2b3c4d:5" },
		undefined,
		makeCtx(),
	);
	assert(h.client.calls.some((c) => c.name === "start_session"), "session opened");
	await h.service.dispose();
	assert(h.client.calls.some((c) => c.name === "end_session"), "end_session emitted during dispose");
	assertEqual(h.client.stopCalls, 1, "client stopped during dispose");
});

await run("init: sweeps stale (>24h) download tmp entries at startup", async () => {
	const agentDir = await makeAgentDir();
	const tmpDir = path.join(agentDir, "computer-use", "tmp");
	mkdirSync(tmpDir, { recursive: true });
	const stale = path.join(tmpDir, "stale-download.part");
	const fresh = path.join(tmpDir, "fresh-download.part");
	writeFileSync(stale, "stale");
	writeFileSync(fresh, "fresh");
	const longAgo = Date.now() - 25 * 60 * 60 * 1000;
	utimesSync(stale, longAgo / 1000, longAgo / 1000);

	const h = await makeHarness({ agentDir, settings: { enabled: true } });
	await h.service.init();
	assert(!existsSync(stale), ">24h tmp entry removed at startup");
	assert(existsSync(fresh), "fresh tmp entry kept");
});

await run("init: sweeps stale (>24h) staging dirs at startup", async () => {
	const agentDir = await makeAgentDir();
	const driverRoot = path.join(agentDir, "computer-use", "cua-driver");
	const staging = path.join(driverRoot, "0.34.1.staging-1a2b3c4d-5e6f");
	mkdirSync(staging, { recursive: true });
	writeFileSync(path.join(staging, "leftover.bin"), "x");
	const longAgo = Date.now() - 25 * 60 * 60 * 1000;
	utimesSync(staging, longAgo / 1000, longAgo / 1000);

	const h = await makeHarness({ agentDir, settings: { enabled: true } });
	await h.service.init();
	assert(!existsSync(staging), ">24h staging dir removed at startup");
});

await run("init with the global switch off probes nothing", async () => {
	const probeCalls: string[] = [];
	const h = await makeHarness({
		settings: { enabled: false, driverPath: process.execPath },
		probeDriver: async (binaryPath: string): Promise<string> => {
			probeCalls.push(binaryPath);
			return "9.9.9";
		},
	});
	await h.service.init();
	assertEqual(probeCalls.length, 0, "no version probe runs while the service is disabled");
	assertEqual(h.service.getSnapshot().availability, "disabled", "availability disabled");
	assertEqual(h.service.getSnapshot().driver.path, null, "no driver was resolved");
});

await run("updateSettings false -> true triggers the refresh init skipped", async () => {
	const probeCalls: string[] = [];
	const h = await makeHarness({
		settings: { enabled: false, driverPath: process.execPath },
		probeDriver: async (binaryPath: string): Promise<string> => {
			probeCalls.push(binaryPath);
			return "9.9.9";
		},
	});
	await h.service.init();
	assertEqual(probeCalls.length, 0, "disabled init did not probe");
	assertEqual(h.service.getSnapshot().availability, "disabled", "still disabled right after init");

	h.service.updateSettings({ enabled: true, driverPath: process.execPath });
	await waitFor(() => probeCalls.length === 1, "the false -> true flip runs the deferred refresh");
	await waitFor(
		() => h.service.getSnapshot().availability === "stopped",
		"availability leaves driver_missing after the flip (idle client, lazy start)",
	);
	assertEqual(h.service.getSnapshot().driver.path, process.execPath, "the driver path resolved after enabling");
});

await run("driver info refresh: atomic commit + concurrent ensureReady waits for the probe", async () => {
	const agentDir = await makeAgentDir();
	const customA = path.join(agentDir, "driver-a");
	const customB = path.join(agentDir, "driver-b");
	await writeFile(customA, "#!a\n");
	await writeFile(customB, "#!b\n");
	await chmod(customA, 0o755).catch(() => undefined);
	await chmod(customB, 0o755).catch(() => undefined);
	const createdPaths: string[] = [];
	const probeCalls: string[] = [];
	// The gate is captured when a probe STARTS, so re-arming `probeGate` for the
	// second refresh never disturbs an already-parked probe.
	let probeGate: Deferred<void> | null = null;
	const probeDriver = async (binaryPath: string): Promise<string> => {
		probeCalls.push(binaryPath);
		const gate = probeGate;
		if (gate !== null) await gate.promise;
		return "9.9.9";
	};
	const h = await makeHarness({
		agentDir,
		settings: { enabled: true, driverPath: customA },
		probeDriver,
		createClient: (opts) => {
			createdPaths.push(opts.executablePath);
			return new FakeDriverClient();
		},
	});

	// The init refresh resolves customA and parks inside the version probe.
	const gateA = createDeferred<void>();
	probeGate = gateA;
	const initPromise = h.service.init();
	await waitFor(() => probeCalls.length === 1, "the init refresh reached the gated probe");
	// Atomic commit: the resolved path stays UNPUBLISHED until the probe settles
	// (publishing it first would pair it with the stale version for every
	// concurrent reader).
	assertEqual(h.service.getSnapshot().driver.path, null, "atomic commit: no path is published while the probe is pending");

	// A concurrent ensureReady must wait for that in-flight refresh instead of
	// queueing a second one (or worse, creating a client from stale info).
	const ready = h.service.ensureReady();
	await sleep(80);
	assertEqual(createdPaths.length, 0, "ensureReady does not create a client while the probe is in flight");
	assertEqual(probeCalls.length, 1, "ensureReady did not queue a second refresh");

	gateA.resolve();
	await initPromise;
	await ready;
	assertDeepEqual(createdPaths, [customA], "exactly one client was created, for the freshly probed path");
	assertEqual(h.service.getSnapshot().availability, "ready", "the waiting ensureReady completed normally");

	// Path change with a second gated probe: the COMMITTED info (path + version
	// together) stays on customA until the new probe settles.
	const gateB = createDeferred<void>();
	probeGate = gateB;
	h.service.updateSettings({ enabled: true, driverPath: customB });
	await waitFor(() => probeCalls.length === 2, "the post-change refresh reached the second gated probe");
	const midRefresh = h.service.getSnapshot();
	assertEqual(midRefresh.driver.path, customA, "atomic commit: the old path stays visible during the new probe");
	assertEqual(midRefresh.driver.version, "9.9.9", "path and version stay a consistent pair");
	gateB.resolve();
	await waitFor(() => h.service.getSnapshot().driver.path === customB, "the new path publishes after its probe settles");
});

await run("install success rebuilds the client instead of reusing the failed one", async () => {
	const agentDir = await makeAgentDir();
	const platform: ComputerUsePlatform = "win32-x64";
	const asset = DRIVER_ASSETS[platform];
	const archive = Buffer.from("pix-service-install-fixture");
	const digest = createHash("sha256").update(archive).digest("hex");
	const installer = new DriverInstaller({
		agentDir,
		platform,
		fetchImpl: async () => new Response(archive),
		extract: async (_archivePath, _kind, destDir) => {
			writeFileSync(path.join(destDir, asset.executable), "driver-binary");
		},
	});
	const created: FakeDriverClient[] = [];
	const h = await makeHarness({
		agentDir,
		installer,
		settings: { enabled: true, driverPath: process.execPath },
		createClient: () => {
			const client = new FakeDriverClient();
			created.push(client);
			return client;
		},
	});
	await h.service.init();
	assertEqual(created.length, 1, "init built the initial client for the custom path");

	// The failed client stays failed: a plain refresh would keep it forever via
	// the same-path early return.
	created[0].startFailure = new ComputerUseError("unavailable", "handshake timed out");
	await expectComputerUseError(h.service.ensureReady(), "unavailable", "the start fails before the install");
	assertEqual(h.service.getSnapshot().availability, "failed", "availability failed before the install");

	// The install + the post-install resolve both compare against the manifest
	// digest, so the whole sequence runs inside the withAssetSha patch window
	// (offline fixture, see the installer test file's header note).
	const result = await withAssetSha(platform, digest, async () => {
		const res = await h.service.execute({ type: "install_driver" });
		await waitFor(() => created.length === 2, "a fresh client was created after the install landed");
		await waitFor(
			() => h.service.getSnapshot().availability === "stopped",
			"availability returns to stopped (fresh idle client, lazy start)",
		);
		return res;
	});
	assertEqual(result.success, true, "install_driver accepted");
	assertEqual(created[0].stopCalls, 1, "the old failed client was stopped and removed");
});

await run("snapshot: linux display server + permissionUndecided fields", async () => {
	const previousSessionType = process.env.XDG_SESSION_TYPE;
	const win = await makeHarness({});
	const h = await makeHarness({ platform: "linux-x64", settings: { enabled: true, driverPath: process.execPath } });
	try {
		process.env.XDG_SESSION_TYPE = "wayland";
		await h.service.init();
		assertEqual(h.service.getSnapshot().linuxDisplayServer, "wayland", "XDG_SESSION_TYPE=wayland is mapped");

		process.env.XDG_SESSION_TYPE = "x11";
		assertEqual(h.service.getSnapshot().linuxDisplayServer, "x11", "XDG_SESSION_TYPE=x11 is mapped");

		delete process.env.XDG_SESSION_TYPE;
		assertEqual(h.service.getSnapshot().linuxDisplayServer, null, "an unset session type maps to null");

		// Non-Linux platforms leave the field absent entirely.
		assertEqual(win.service.getSnapshot().linuxDisplayServer, undefined, "non-Linux platforms omit linuxDisplayServer");

		// permissionUndecided: atspi unreported by the driver -> undecidable,
		// surfaced without blocking (x11/wayland both granted).
		h.client.permissions = { x11: true, wayland: true };
		await h.service.ensureReady();
		assertDeepEqual(h.service.getSnapshot().permissionUndecided, ["atspi"], "undecidable permission fields are surfaced");
		assertEqual(h.service.getSnapshot().availability, "ready", "undecidable fields never block");
	} finally {
		if (previousSessionType === undefined) {
			delete process.env.XDG_SESSION_TYPE;
		} else {
			process.env.XDG_SESSION_TYPE = previousSessionType;
		}
		await win.service.dispose();
		await h.service.dispose();
	}
});

await run("createClient receives the injected appVersion as clientVersion", async () => {
	const seen: Array<string | undefined> = [];
	const injected = await makeHarness({
		appVersion: "2.1.0-test",
		createClient: (opts) => {
			seen.push(opts.clientVersion);
			return new FakeDriverClient();
		},
	});
	await injected.service.init();
	assertEqual(seen[0], "2.1.0-test", "the injected app version reaches the client options");

	const plain = await makeHarness({
		createClient: (opts) => {
			seen.push(opts.clientVersion);
			return new FakeDriverClient();
		},
	});
	await plain.service.init();
	assertEqual(seen[1], undefined, "without injection clientVersion stays undefined (client-side default)");
});

// ============================================================================
// Tests: extension hooks
// ============================================================================

await run("extension: session_start / session_tree / before_agent_start / context", async () => {
	const h = await makeHarness({});
	await h.service.init();
	const { controller, manager } = makeController(h.service, 7);
	console.log(`  INFO: controller id ${controller.id}`);
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown): void => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	const factory = createComputerUseExtension(controller, () => ({ keepRecent: 3, chunk: 2 }));
	await factory(pi);

	for (const event of ["session_start", "session_tree", "before_agent_start", "context"]) {
		assertEqual(handlers.has(event) && (handlers.get(event)?.length ?? 0) === 1, true, `handler registered for ${event}`);
	}

	// session_start: hydrate picks the branch entry + reconcile activates the tools.
	manager.branch = [customEntry({ schemaVersion: 1, enabled: true, at: 1 }, "entry-1")];
	handlers.get("session_start")?.[0]({ type: "session_start", reason: "startup" }, undefined);
	assertEqual(controller.isSessionEnabled(), true, "session_start hydrates the toggle from the branch");
	assertEqual(controller.getSnapshot()?.toolsActive, true, "session_start reconciles the tools");

	// before_agent_start: clears halted/deniedThisRun, reconciles, returns undefined.
	controller.halt();
	assertEqual(controller.getSnapshot()?.halted, true, "halted before the new turn");
	const returned = handlers.get("before_agent_start")?.[0]({ type: "before_agent_start" }, undefined);
	assertEqual(returned, undefined, "before_agent_start must not return a systemPrompt/message");
	assertEqual(controller.getSnapshot()?.halted, false, "before_agent_start clears halted");
	assertEqual(controller.getSnapshot()?.toolsActive, true, "before_agent_start reconciles the tools");

	// session_tree: re-reads the new branch (disabled there).
	manager.branch = [customEntry({ schemaVersion: 1, enabled: false, at: 2 }, "entry-2")];
	handlers.get("session_tree")?.[0]({ type: "session_tree" }, undefined);
	assertEqual(controller.isSessionEnabled(), false, "session_tree hydrates the new branch value");
	assertEqual(controller.getSnapshot()?.toolsActive, false, "session_tree drops the tools");

	// context: delegates to applyScreenshotRetention with the live policy.
	const messages = [
		screenshotMessage("c_1"),
		screenshotMessage("c_2"),
		screenshotMessage("c_3"),
		screenshotMessage("c_4"),
		screenshotMessage("c_5"),
	] as unknown as AgentMessage[];
	const contextResult = handlers.get("context")?.[0]({ type: "context", messages }, undefined) as { messages: unknown[] };
	assertEqual(Array.isArray(contextResult.messages), true, "context returns a messages array");
	const encoded = JSON.stringify(contextResult.messages);
	const placeholders = encoded.split("[earlier computer screenshot removed to save context").length - 1;
	assertEqual(placeholders, 2, "keepRecent 3 + chunk 2 removes the two oldest screenshots");
	assert(encoded.includes("c_1") && encoded.includes("c_2"), "oldest capture ids are referenced in the placeholders");
	assertEqual(contextResult.messages.length, messages.length, "message count never changes");
});

// ============================================================================
// Tests: regression fixes (stderr tail truncation, global disable cancels install)
// ============================================================================

await run("failed detail: truncation keeps the stderr tail, not the head", async () => {
	const h = await makeHarness({});
	await h.service.init();
	const startMarker = "START_OF_STDERR";
	const endMarker = "END_OF_STDERR";
	const longText = `${startMarker}${"x".repeat(1200)}${endMarker}`;
	h.client.startFailure = new ComputerUseError("unavailable", longText);
	await expectComputerUseError(h.service.ensureReady(), "unavailable", "ensureReady surfaces the long start failure");
	const snap = h.service.getSnapshot();
	assertEqual(snap.availability, "failed", "long start failure maps to failed");
	const detail = snap.availabilityDetail ?? "";
	assert(detail.includes(endMarker), "detail keeps the stderr tail (END marker)");
	assert(!detail.includes(startMarker), "detail drops the stderr head (START marker)");
	const prefix = "驱动启动失败：";
	assert(detail.startsWith(prefix), "detail keeps the failure prefix");
	const truncated = detail.slice(prefix.length);
	assert(truncated.length <= 400, `truncated detail stays within 400 chars (got ${String(truncated.length)})`);
});

await run("global disable: cancels an in-flight install", async () => {
	const agentDir = await makeAgentDir();
	const installer = new DriverInstaller({
		agentDir,
		platform: "win32-x64",
		baseUrl: "http://127.0.0.1:9",
		fetchImpl: pendingFetch,
		extract: async () => undefined,
	});
	const h = await makeHarness({ agentDir, installer, settings: { enabled: true } });
	await h.service.init();
	assertEqual(h.service.getSnapshot().availability, "driver_missing", "driver not installed yet");

	const result = await h.service.execute({ type: "install_driver" });
	assertEqual(result.success, true, "install_driver accepted");
	assertEqual(h.service.getSnapshot().availability, "installing", "installing while downloading");
	await waitFor(
		() => h.events.some((e) => e.type === "install_progress" && e.progress.phase === "downloading"),
		"downloading progress event emitted",
	);

	h.service.updateSettings({ enabled: false, driverPath: h.service.getResolvedSettings().driverPath ?? undefined });
	assertEqual(h.service.getSnapshot().availability, "disabled", "disabled outranks the in-flight install");
	await waitFor(
		() => h.events.some((e) => e.type === "install_progress" && e.progress.phase === "cancelled"),
		"install emits the terminal cancelled progress event",
	);
	await waitFor(() => !installer.isInstalling(), "installer is no longer running after the global disable");
});

// ============================================================================
// Cleanup: remove every temp agentDir created during the run (the file
// executes top-to-bottom under tsx, so one sweep at the end covers them all).
// ============================================================================

for (const dir of createdAgentDirs) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Best effort; the OS tmp cleaner handles the rest.
	}
}

// ============================================================================
// Summary
// ============================================================================

console.log(`\n=== Summary ===\n`);
console.log(`PASS: ${passed}`);
console.log(`FAIL: ${failed}`);
if (process.env.VITEST !== undefined) {
	// vitest entry point: the script body above already ran during collection;
	// this test only reports the harness verdict (tsx keeps process.exitCode).
	test("service script harness verdict (tsx entry prints PASS/FAIL above)", () => {
		assertEqual(failed, 0, "no harness failures");
	});
} else if (failed > 0) {
	process.exitCode = 1;
}
