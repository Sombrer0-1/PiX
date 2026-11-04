/**
 * Application-level computer-use service.
 *
 * Composition root for everything that outlives one session generation: driver
 * location / version probing, the managed installer, the lazy cua-driver MCP
 * client with its CuaDriverBackend, the single DesktopLease, the TargetGuard
 * (fed with the Electron surface facts), the emergency-stop global shortcut and
 * the snapshot / event fan-out consumed by the IPC adapters and the renderer
 * store.
 *
 * Availability follows the top-down table (global switch -> platform ->
 * installer -> driver location -> version -> client state -> permissions). The
 * driver is never started by `init()`: the first `ensureReady()` from a
 * controller resolves the binary, probes its version, creates the client, runs
 * `checkPermissions()` and maps missing permissions to `permission_required`
 * (degraded capabilities are recorded but never block).
 * An idle driver (10 minutes without a call and without a lease) is stopped and
 * returns to `stopped`.
 *
 * The service keeps a registry of every live controller (added by
 * `createController`, removed when the controller is disposed) so that the
 * emergency stop, the global off switch, and client state changes can reach all
 * of them. All state sources - controller `session_state` events, lease
 * changes, client state changes and install progress - are coalesced into one
 * `snapshot` event per 50 ms window; `activity` events are forwarded as they
 * happen.
 *
 * Imports concrete implementations on purpose: the service is the only
 * composition root. Everything Electron-specific arrives through
 * `deps.electron`, so the module stays testable in pure Node.
 */

import type {
	ComputerUseAvailability,
	ComputerUseCommand,
	ComputerUseEvent,
	ComputerUsePlatform,
	ComputerUseSettings,
	ComputerUseSnapshot,
	DriverInfo,
	InstallProgress,
	ResolvedComputerUseSettings,
} from "../../shared/computer-use-types.js";
import {
	computerUseDegradedLabel,
	computerUsePermissionLabel,
	resolveComputerUseSettings,
} from "../../shared/computer-use-types.js";
import type { PixCommandResult } from "../../shared/types.js";
import type {
	ComputerBackend,
	DesktopLease,
	DriverClient,
	PermissionReport,
	PixSurfaceProvider,
	TargetGuard,
} from "./contracts.js";
import { ComputerUseError, errorText, unrefTimer } from "./contracts.js";
import { CuaDriverBackend } from "./cua-backend.js";
import { createDesktopLease } from "./desktop-lease.js";
import { DRIVER_VERSION, detectComputerUsePlatform } from "./driver-manifest.js";
import { DriverInstaller, installerDriverRoot, installerTmpDir, removeStaleEntries } from "./driver-installer.js";
import { probeDriverVersion, resolveDriverBinary, type ResolvedDriver } from "./driver-locator.js";
import { DRIVER_INCOMPATIBLE_PREFIX, McpDriverClient, type McpDriverClientOptions } from "./mcp-driver-client.js";
import { encodeScreenshotForModel } from "./screenshot-codec.js";
import {
	ComputerUseSessionController,
	type ComputerUseControllerEvent,
	type ComputerUseSessionControllerDeps,
} from "./session-controller.js";
import { createTargetGuard } from "./target-guard.js";

/** Snapshot coalescing window: all triggers inside one window emit one event. */
const SNAPSHOT_THROTTLE_MS = 50;
/** Lazy driver idle stop: 10 minutes without use and without a lease. */
const DRIVER_IDLE_STOP_MS = 10 * 60_000;
/** `availabilityDetail` budget for raw driver output (stderr tail, failure text). */
const DETAIL_MAX_CHARS = 400;
/** Availability detail shared by every driver_incompatible row. */
const DRIVER_INCOMPATIBLE_DETAIL = "驱动版本不兼容，请重新安装";
/** macOS privacy panes opened by `open_permission_settings`. */
const MACOS_PERMISSION_PANES: Readonly<Record<"accessibility" | "screen_recording", string>> = {
	accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	screen_recording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

/** No Electron surface facts (tests, headless): no PiX pid / focus protection data. */
const NOOP_SURFACE: PixSurfaceProvider = { getPixPids: () => [], isPixFocused: () => false };

export interface ComputerUseServiceDeps {
	agentDir: string;                              // getAgentDir()
	initialSettings: ComputerUseSettings | undefined;
	electron?: {                                   // 测试可省略（无快捷键/无 surface 保护时用 no-op）
		registerShortcut: (accelerator: string, cb: () => void) => boolean;   // 实现 = globalShortcut.register(a, cb) && globalShortcut.isRegistered(a)
		unregisterShortcut: (accelerator: string) => void;
		surface: PixSurfaceProvider;
		openExternal: (url: string) => Promise<void>;
	};
	createClient?: (opts: McpDriverClientOptions) => DriverClient;   // 测试注入
	installer?: DriverInstaller;                                       // 测试注入
	platform?: ComputerUsePlatform | null;                             // 测试注入；缺省 detect
	nodePlatform?: NodeJS.Platform;                                    // 测试注入；缺省 process.platform（选快捷键用）
	probeDriver?: (binaryPath: string) => Promise<string>;             // 测试注入（受控探针时序）
	idleStopMs?: number;                                               // 测试注入（空闲回收窗口）
	appVersion?: string;                                               // 注入 app.getVersion()；传给 McpDriverClient.clientVersion
}

/** Per-platform emergency-stop accelerator. Electron: "Control" = Ctrl on every OS, "Alt" = Option on macOS. */
const EMERGENCY_STOP_ACCELERATORS: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
	win32: "Control+Alt+Escape",        // 非系统保留（Ctrl+Shift+Esc 才是任务管理器）
	darwin: "Control+Alt+Escape",       // = Ctrl+Option+Esc；避开 Cmd+Option+Esc（系统“强制退出”）
	linux: "Control+Alt+Shift+Escape",  // 避开 KDE 的 Ctrl+Alt+Esc（xkill）
};

export function emergencyStopAccelerator(platform: NodeJS.Platform): string | null {
	return EMERGENCY_STOP_ACCELERATORS[platform] ?? null;
}

export class ComputerUseService {
	private readonly _deps: ComputerUseServiceDeps;
	private readonly _nodePlatform: NodeJS.Platform;
	private readonly _createClient: (opts: McpDriverClientOptions) => DriverClient;
	private readonly _installer: DriverInstaller | null;
	private readonly _probeDriver: (binaryPath: string) => Promise<string>;
	private readonly _idleStopMs: number;
	private readonly _appVersion: string | undefined;

	private _platform: ComputerUsePlatform | null;
	private _settings: ResolvedComputerUseSettings;

	private _resolvedDriver: ResolvedDriver | null = null;
	private _driverVersion: string | null = null;
	private _driverProbeFailed = false;

	private _client: DriverClient | null = null;
	/** Path the current client was created for: a re-resolve to a different path rebuilds the client. */
	private _clientPath: string | null = null;
	private _backend: ComputerBackend | null = null;
	private _clientStateDetail: string | undefined;
	private _permissionReport: PermissionReport | null = null;
	private _crashCount = 0;
	private _unsubscribeClientState: (() => void) | null = null;

	private readonly _lease: DesktopLease;
	private readonly _leaseUnsubscribe: () => void;
	private readonly _guard: TargetGuard;

	private readonly _controllers = new Set<ComputerUseSessionController>();
	private _foregroundProvider: (() => ComputerUseSessionController | null) | null = null;

	private readonly _listeners = new Set<(event: ComputerUseEvent) => void>();
	private _snapshotTimer: NodeJS.Timeout | null = null;
	private _idleTimer: NodeJS.Timeout | null = null;

	private _installProgress: InstallProgress | null = null;

	private _shortcutWanted = false;
	private _shortcutAccelerator: string | null = null;

	private _readyPromise: Promise<void> | null = null;
	private _driverInfoChain: Promise<void> = Promise.resolve();
	/**
	 * The most recent in-flight refresh (or reset+refresh) chain entry, cleared
	 * when it settles: a concurrent ensureReady that found the driver info
	 * missing waits for THIS promise instead of queueing a second refresh, so it
	 * can never race a half-committed refresh and spawn an unverified binary.
	 */
	private _refreshInFlight: Promise<void> | null = null;
	/**
	 * Serializes client creation/reset independently of _driverInfoChain:
	 * _ensureReadyRun also creates clients without holding the driver-info
	 * chain, and an unsynchronized interleave with a chained reset could build
	 * two clients - the later one overwriting _client and the state
	 * subscription without stopping the earlier one (orphaned driver child
	 * process). Same mutex shape as _driverInfoChain.
	 */
	private _clientChain: Promise<void> = Promise.resolve();
	private _disposed = false;

	constructor(deps: ComputerUseServiceDeps) {
		this._deps = deps;
		this._nodePlatform = deps.nodePlatform ?? process.platform;
		this._platform = deps.platform !== undefined
			? deps.platform
			: detectComputerUsePlatform(process.platform, process.arch);
		this._settings = resolveComputerUseSettings(deps.initialSettings);
		this._createClient = deps.createClient ?? ((opts) => new McpDriverClient(opts));
		this._installer = deps.installer
			?? (this._platform !== null ? new DriverInstaller({ agentDir: deps.agentDir, platform: this._platform }) : null);
		this._probeDriver = deps.probeDriver ?? probeDriverVersion;
		this._idleStopMs = deps.idleStopMs ?? DRIVER_IDLE_STOP_MS;
		this._appVersion = deps.appVersion;
		this._guard = createTargetGuard(deps.electron?.surface ?? NOOP_SURFACE);
		this._lease = createDesktopLease();
		this._leaseUnsubscribe = this._lease.onChange(() => {
			this._syncShortcut();
			this._scheduleSnapshot();
		});
	}

	/** Locate driver, compute availability (no process start). */
	async init(): Promise<void> {
		// Startup sweeps of download leftovers and crashed-install staging dirs
		// older than 24h; best-effort, never throws, and they run even while the
		// global switch is off (cleanup is cheap, probing is not).
		await removeStaleEntries(installerTmpDir(this._deps.agentDir), "tmp");
		await removeStaleEntries(installerDriverRoot(this._deps.agentDir), "staging");
		if (!this._settings.enabled) {
			// A disabled service must not probe anything (a custom path on a
			// network share would stall startup); updateSettings refreshes on the
			// false -> true flip instead.
			this._syncShortcut();
			this._scheduleSnapshot();
			return;
		}
		await this._refreshDriverInfo();
		this._syncShortcut();
		this._scheduleSnapshot();
	}

	isGloballyEnabled(): boolean {
		return this._settings.enabled;
	}

	getResolvedSettings(): ResolvedComputerUseSettings {
		return this._settings;
	}

	/** 关闭 → 所有控制器 revoke+reconcile、forceRelease、stop driver. */
	updateSettings(s: ComputerUseSettings | undefined): void {
		const previous = this._settings;
		const next = resolveComputerUseSettings(s);
		this._settings = next;
		if (next.driverPath !== previous.driverPath) {
			// The configured binary changed: drop the running client and re-resolve
			// lazily. Reset + refresh run inside the driver-info chain so a refresh
			// still probing the OLD path cannot rebuild the client from it after
			// the reset has already run.
			void this._resetDriverInfo().catch((err: unknown) => {
				console.warn(`[ComputerUse] driver re-resolve after settings change failed: ${errorText(err)}`);
			});
		} else if (next.enabled && !previous.enabled) {
			// init skipped the probe while the service was disabled; without
			// this refresh the availability would stay stuck on driver_missing
			// until the next recheck.
			void this._refreshDriverInfo().catch((err: unknown) => {
				console.warn(`[ComputerUse] driver refresh after enabling failed: ${errorText(err)}`);
			});
		}
		if (!next.enabled) {
			for (const controller of [...this._controllers]) {
				try {
					controller.revokeGrants();
					controller.reconcileTools();
				} catch (err: unknown) {
					console.warn(`[ComputerUse] controller revoke during global disable failed: ${errorText(err)}`);
				}
			}
			this._lease.forceRelease();
			this._installer?.cancel();
			if (previous.enabled) void this._stopDriver();
		}
		this._syncShortcut();
		this._scheduleSnapshot();
	}

	/**
	 * Builds one generation's controller with the service-owned deps (backend,
	 * lazy driver start, lease, guard, screenshot encoder, live settings) and
	 * registers it until it is disposed.
	 */
	createController(
		args: Omit<
			ComputerUseSessionControllerDeps,
			"controllerId" | "backend" | "ensureReady" | "lease" | "guard" | "encode" | "getSettings" | "emit"
		> & { genId: number },
	): ComputerUseSessionController {
		const { genId, ...rest } = args;
		const controller = new ComputerUseSessionController({
			...rest,
			controllerId: String(genId),
			backend: () => this._backend,
			ensureReady: () => this.ensureReady(),
			lease: this._lease,
			guard: this._guard,
			encode: encodeScreenshotForModel,
			getSettings: () => this._settings,
			emit: (event) => this._handleControllerEvent(event),
		});
		this._controllers.add(controller);
		// The controller has no "disposed" event, so registry removal wraps its
		// idempotent dispose (the bridge always disposes through the instance).
		const innerDispose = controller.dispose.bind(controller);
		controller.dispose = async (): Promise<void> => {
			this._controllers.delete(controller);
			await innerDispose();
		};
		return controller;
	}

	/** Bridge provides the current foreground controller (for snapshot.session). */
	setForegroundControllerProvider(fn: () => ComputerUseSessionController | null): void {
		this._foregroundProvider = fn;
	}

	getSnapshot(): ComputerUseSnapshot {
		const state = this._computeAvailability();
		const snapshot: ComputerUseSnapshot = {
			platform: this._platform,
			availability: state.availability,
			driver: this._driverInfo(),
			install: this._installProgress,
			emergencyShortcut: this._shortcutAccelerator,
			session: this._foregroundController()?.getSnapshot() ?? null,
			updatedAt: Date.now(),
		};
		if (state.detail !== undefined) snapshot.availabilityDetail = state.detail;
		// Linux display server: XDG_SESSION_TYPE of the PiX process is
		// the session the driver child would inherit, so the settings page can
		// warn about Wayland limitations before any driver start.
		if (this._platform !== null && this._platform.startsWith("linux")) {
			snapshot.linuxDisplayServer = linuxDisplayServer(process.env.XDG_SESSION_TYPE);
		}
		const missing = this._permissionReport?.missing ?? [];
		if (missing.length > 0) snapshot.missingPermissions = [...missing];
		const degraded = this._permissionReport?.degraded ?? [];
		if (degraded.length > 0) snapshot.degradedCapabilities = [...degraded];
		const undecided = this._permissionReport?.undecidable ?? [];
		if (undecided.length > 0) snapshot.permissionUndecided = [...undecided];
		return snapshot;
	}

	/**
	 * Lazy driver start, also injected into every controller as
	 * `ensureReady`: resolve -> probe -> new client -> ensureStarted ->
	 * checkPermissions. Throws ComputerUseError("unavailable" /
	 * "unsupported_on_platform" / "driver_incompatible" / "permission_required");
	 * degraded capabilities are recorded without blocking.
	 */
	ensureReady(): Promise<void> {
		const existing = this._readyPromise;
		if (existing !== null) return existing;
		// The finally-chain is the returned promise itself, so a caller that
		// awaited this call always sees the slot cleared before it continues.
		const run = this._ensureReadyRun().finally(() => {
			if (this._readyPromise === run) this._readyPromise = null;
		});
		this._readyPromise = run;
		void run.catch(() => undefined); // shared promise: never an unhandled rejection
		return run;
	}

	/** client.cancelAll() -> every live controller halt() -> forceRelease -> broadcast. */
	emergencyStop(): void {
		try {
			this._client?.cancelAll();
		} catch (err: unknown) {
			console.warn(`[ComputerUse] cancelAll during emergency stop failed: ${errorText(err)}`);
		}
		for (const controller of [...this._controllers]) {
			try {
				controller.halt();
			} catch (err: unknown) {
				console.warn(`[ComputerUse] controller halt during emergency stop failed: ${errorText(err)}`);
			}
		}
		this._lease.forceRelease();
		this._scheduleSnapshot();
	}

	onEvent(listener: (event: ComputerUseEvent) => void): () => void {
		this._listeners.add(listener);
		return () => {
			this._listeners.delete(listener);
		};
	}

	/** Idempotent: cancelAll -> controller dispose (end_session) -> client.stop -> shortcut unregister. */
	async dispose(): Promise<void> {
		if (this._disposed) return;
		this._disposed = true;
		this._clearSnapshotTimer();
		this._clearIdleTimer();
		this._leaseUnsubscribe();
		this._unsubscribeClientState?.();
		this._unsubscribeClientState = null;

		// Order matters: the client/backend must stay reachable while the
		// controllers dispose, because controller dispose emits end_session
		// through backend(). Only after every controller is gone does the client
		// stop and the references drop.
		try {
			this._client?.cancelAll();
		} catch (err: unknown) {
			console.warn(`[ComputerUse] cancelAll during dispose failed: ${errorText(err)}`);
		}
		for (const controller of [...this._controllers]) {
			this._controllers.delete(controller);
			try {
				await controller.dispose();
			} catch (err: unknown) {
				console.error(`[ComputerUse] controller dispose failed: ${errorText(err)}`);
			}
		}
		const client = this._client;
		this._client = null;
		this._backend = null;
		this._clientPath = null;
		if (client !== null) {
			try {
				await client.stop();
			} catch (err: unknown) {
				console.warn(`[ComputerUse] driver stop during dispose failed: ${errorText(err)}`);
			}
		}
		this._installer?.cancel();
		const accelerator = this._shortcutAccelerator;
		this._shortcutAccelerator = null;
		this._shortcutWanted = false;
		if (accelerator !== null) {
			try {
				this._deps.electron?.unregisterShortcut(accelerator);
			} catch (err: unknown) {
				console.warn(`[ComputerUse] shortcut unregister during dispose failed: ${errorText(err)}`);
			}
		}
		this._listeners.clear();
	}

	// =========================================================================
	// Lazy driver start
	// =========================================================================

	/** Shared rejection for the dispose gates: no driver process may spawn after shutdown. */
	private _disposedError(): ComputerUseError {
		return new ComputerUseError(
			"unavailable",
			"The computer-use service has been disposed.",
			"The app is shutting down; no driver process was started.",
		);
	}

	private async _ensureReadyRun(): Promise<void> {
		// dispose() must gate the lazy start: an ensureReady racing dispose (or an
		// in-flight run continuing past it) would otherwise spawn a driver child
		// nobody ever reclaims - _armIdleStopTimer short-circuits once disposed.
		if (this._disposed) throw this._disposedError();
		if (!this._settings.enabled) {
			throw new ComputerUseError("global_disabled", "Computer use is disabled.", "Turn it on under Settings > Computer use.");
		}
		const platform = this._platform;
		if (platform === null) {
			throw new ComputerUseError("unsupported_on_platform", "Computer use is not supported on this platform.");
		}
		if (this._resolvedDriver === null || this._driverVersion === null) {
			// If a refresh is already in flight, wait for it instead of queueing a
			// second one - the in-flight run will publish the info.
			const inFlight = this._refreshInFlight;
			await (inFlight !== null ? inFlight : this._refreshDriverInfo());
		}
		const resolved = this._resolvedDriver;
		if (resolved === null) {
			throw new ComputerUseError(
				"unavailable",
				"The computer-use driver is not installed.",
				"Open Settings > Computer use, click Install driver, then retry.",
			);
		}
		if (this._driverVersion === null || this._driverProbeFailed) {
			// The availability row classifies an unidentifiable driver as
			// driver_incompatible, so the thrown code must match the snapshot the
			// model sees.
			throw new ComputerUseError(
				"driver_incompatible",
				`The computer-use driver at ${resolved.path} could not be identified.`,
				"Reinstall the driver from Settings > Computer use, or point the custom path at a working cua-driver binary.",
			);
		}
		if (resolved.source === "managed" && this._driverVersion !== DRIVER_VERSION) {
			throw new ComputerUseError(
				"driver_incompatible",
				`The managed driver reports version ${this._driverVersion}, but this PiX build expects ${DRIVER_VERSION}.`,
				"Reinstall the driver from Settings > Computer use.",
			);
		}
		const client = await this._ensureClientInstance();
		if (client === null) {
			// Same root causes as the two branches above (probe failed / managed
			// version mismatch are exactly what makes _ensureClientInstanceNow
			// return null), so the code stays consistent with them.
			throw new ComputerUseError(
				"driver_incompatible",
				`The computer-use driver at ${resolved.path} is not usable.`,
				"Reinstall the driver from Settings > Computer use, then retry.",
			);
		}
		if (this._disposed) {
			// Same gate as at the top of this run, for a dispose that landed in
			// the await window between the client lookup and the spawn below.
			throw this._disposedError();
		}
		if (client.state !== "ready") {
			try {
				await client.ensureStarted();
			} catch (err: unknown) {
				this._scheduleSnapshot();
				throw err;
			}
		}
		// The driver child process exists from here on: arm the idle stop timer
		// before checkPermissions, which can still throw (driver timeout /
		// isError) - otherwise a successfully spawned driver would stay resident
		// forever. _armIdleStopTimer is idempotent (clear + re-arm).
		this._armIdleStopTimer();
		const backend = this._backend;
		if (backend === null) {
			throw new ComputerUseError("unavailable", "The computer-use backend is not available.", "Retry after the driver restarts.");
		}
		let report: PermissionReport;
		try {
			// macOS: read-only check (prompt:false inside the backend), never a system dialog.
			report = await backend.checkPermissions();
		} catch (err: unknown) {
			this._scheduleSnapshot();
			throw err;
		}
		this._permissionReport = report;
		this._syncShortcut();
		this._scheduleSnapshot();
		if (report.missing.length > 0) {
			throw new ComputerUseError(
				"permission_required",
				`Computer-use permissions are missing: ${report.missing.join(", ")}.`,
				"Grant them in the system settings (macOS: allow PiX.app under Privacy & Security > Accessibility and Screen Recording), then retry from Settings > Computer use; the driver attributes the permission to PiX itself.",
			);
		}
	}

	/** Serialized driver location + probe (never starts the MCP process). */
	private _refreshDriverInfo(): Promise<void> {
		const run = this._driverInfoChain.then(() => this._refreshDriverInfoNow());
		this._driverInfoChain = run.catch(() => undefined);
		this._trackRefreshInFlight(run);
		return run;
	}

	/**
	 * Serialized client reset + re-resolve (driverPath change): queued behind any
	 * refresh still probing the old path, so the last chain entry always decides
	 * which binary the rebuilt client points at.
	 */
	private _resetDriverInfo(): Promise<void> {
		const run = this._driverInfoChain
			.then(() => this._resetClient())
			.then(() => this._refreshDriverInfoNow());
		this._driverInfoChain = run.catch(() => undefined);
		this._trackRefreshInFlight(run);
		return run;
	}

	/** Remember the newest refresh chain entry until it settles (see _refreshInFlight). */
	private _trackRefreshInFlight(run: Promise<void>): void {
		this._refreshInFlight = run;
		const settled = (): void => {
			if (this._refreshInFlight === run) this._refreshInFlight = null;
		};
		run.then(settled, settled);
	}

	private async _refreshDriverInfoNow(): Promise<void> {
		const platform = this._platform;
		if (platform === null) {
			this._resolvedDriver = null;
			this._driverVersion = null;
			this._driverProbeFailed = false;
			this._syncShortcut();
			this._scheduleSnapshot();
			return;
		}
		let resolved: ResolvedDriver | null = null;
		try {
			resolved = await resolveDriverBinary({
				agentDir: this._deps.agentDir,
				platform,
				customPath: this._settings.driverPath,
			});
		} catch (err: unknown) {
			console.warn(`[ComputerUse] driver resolution failed: ${errorText(err)}`);
		}
		let version: string | null = null;
		let probeFailed = false;
		if (resolved !== null) {
			try {
				version = await this._probeDriver(resolved.path);
			} catch (err: unknown) {
				version = null;
				probeFailed = true;
				console.warn(`[ComputerUse] driver version probe failed for ${resolved.path}: ${errorText(err)}`);
			}
		}
		// Atomic commit: resolved / version / probeFailed publish together.
		// A concurrent ensureReady must never observe the NEW path paired with
		// the OLD (stale) version; readers either see the previous complete
		// state or the new one, never the mix.
		this._resolvedDriver = resolved;
		this._driverVersion = version;
		this._driverProbeFailed = probeFailed;
		await this._ensureClientInstance();
		this._syncShortcut();
		this._scheduleSnapshot();
	}

	/**
	 * Creates the MCP client object and its backend as soon as a usable driver is
	 * known. This starts NOTHING: the child process only spawns inside
	 * `ensureReady()`. Creating the objects early is required by reconciliation,
	 * which maps `backend() === null` to `"unavailable"`: with a
	 * null backend the registry would drop the computer tools at session start
	 * and no tool call could ever trigger the lazy start.
	 *
	 * When the resolved binary path changed since the current client was created
	 * (custom path deleted, managed fallback flipped, ...), the old client is
	 * reset first and rebuilt for the new path.
	 *
	 * The whole create/reset decision runs on _clientChain: callers reach this
	 * both from the driver-info chain and directly from _ensureReadyRun, so
	 * without serialization two callers can each decide to create and the later
	 * one overwrites _client without stopping the earlier client. The queued
	 * body re-reads all state after taking the lock (double check).
	 */
	private _ensureClientInstance(): Promise<DriverClient | null> {
		const run = this._clientChain.then(() => this._ensureClientInstanceNow());
		this._clientChain = run.then(() => undefined, () => undefined);
		return run;
	}

	/** Lock-held body of _ensureClientInstance. Never re-enter through the public helpers (self-deadlock). */
	private async _ensureClientInstanceNow(): Promise<DriverClient | null> {
		if (this._client !== null && this._clientPath === (this._resolvedDriver?.path ?? null)) return this._client;
		// Inline lock-held reset: queueing _resetClient() here would wait for the
		// chain this body already occupies (deadlock).
		if (this._client !== null) await this._resetClientNow();
		const resolved = this._resolvedDriver;
		const platform = this._platform;
		if (this._disposed) {
			// dispose() ran while a refresh/ensureReady chain was parked on an await
			// (version probe, client.stop): without this gate the chain would
			// rebuild a client after dispose and spawn a driver child nobody
			// reclaims (_armIdleStopTimer short-circuits once disposed).
			throw this._disposedError();
		}
		if (resolved === null || platform === null || this._driverVersion === null || this._driverProbeFailed) return null;
		if (resolved.source === "managed" && this._driverVersion !== DRIVER_VERSION) return null;
		// clientVersion: the real PiX app version when injected, otherwise
		// undefined and the client falls back to its built-in default.
		const client = this._createClient({ executablePath: resolved.path, cwd: resolved.dir, clientVersion: this._appVersion });
		this._client = client;
		this._clientPath = resolved.path;
		this._backend = new CuaDriverBackend(client, platform);
		this._attachClient(client);
		return client;
	}

	/**
	 * Drop the running client/backend (recheck, driver path change) so the next ensureReady rebuilds them.
	 * Serialized on _clientChain so it cannot interleave with a concurrent create.
	 */
	private _resetClient(): Promise<void> {
		const run = this._clientChain.then(() => this._resetClientNow());
		this._clientChain = run.then(() => undefined, () => undefined);
		return run;
	}

	/** Lock-held body of _resetClient. Never re-enter through the public helpers (self-deadlock). */
	private async _resetClientNow(): Promise<void> {
		this._clearIdleTimer();
		this._unsubscribeClientState?.();
		this._unsubscribeClientState = null;
		const client = this._client;
		this._client = null;
		this._backend = null;
		this._clientPath = null;
		this._clientStateDetail = undefined;
		this._permissionReport = null;
		this._crashCount = 0;
		if (client !== null) {
			try {
				await client.stop();
			} catch (err: unknown) {
				console.warn(`[ComputerUse] driver stop during reset failed: ${errorText(err)}`);
			}
		}
		this._syncShortcut();
		this._scheduleSnapshot();
	}

	/** Global switch off / dispose: stop the child process but keep the client object for lazy reuse. */
	private async _stopDriver(): Promise<void> {
		this._clearIdleTimer();
		const client = this._client;
		if (client === null) return;
		try {
			await client.stop();
		} catch (err: unknown) {
			console.warn(`[ComputerUse] driver stop failed: ${errorText(err)}`);
		}
		this._syncShortcut();
		this._scheduleSnapshot();
	}

	private _attachClient(client: DriverClient): void {
		this._unsubscribeClientState = client.onStateChange((state, detail) => {
			this._clientStateDetail = detail;
			if (state === "crashed") this._crashCount += 1;
			else if (state === "idle") this._crashCount = 0;
			this._syncShortcut();
			this._scheduleSnapshot();
		});
	}

	private _armIdleStopTimer(): void {
		this._clearIdleTimer();
		if (this._disposed || this._client === null) return;
		const timer = setTimeout(() => {
			this._idleTimer = null;
			this._handleIdleStop();
		}, this._idleStopMs);
		unrefTimer(timer);
		this._idleTimer = timer;
	}

	private _clearIdleTimer(): void {
		if (this._idleTimer === null) return;
		clearTimeout(this._idleTimer);
		this._idleTimer = null;
	}

	/** 10 minutes without a call and without a lease -> stop() -> availability "stopped". */
	private _handleIdleStop(): void {
		const client = this._client;
		if (client === null || this._disposed) return;
		if (client.state === "starting" || client.state === "crashed") {
			this._armIdleStopTimer();
			return;
		}
		if (client.state !== "ready") return;
		if (this._lease.getState().holderId !== null) {
			this._armIdleStopTimer();
			return;
		}
		void client
			.stop()
			.catch((err: unknown) => {
				console.warn(`[ComputerUse] idle driver stop failed: ${errorText(err)}`);
			})
			.finally(() => {
				this._syncShortcut();
				this._scheduleSnapshot();
			});
	}

	// =========================================================================
	// Availability (first hit wins)
	// =========================================================================

	private _computeAvailability(): { availability: ComputerUseAvailability; detail?: string } {
		if (!this._settings.enabled) return { availability: "disabled" };
		if (this._platform === null) return { availability: "unsupported_platform", detail: "当前平台不受支持" };
		if (this._installer?.isInstalling() === true) return { availability: "installing", detail: "正在安装操控驱动" };
		if (this._resolvedDriver === null) return { availability: "driver_missing", detail: "未安装操控驱动" };
		if (this._driverProbeFailed
			|| this._driverVersion === null
			|| (this._resolvedDriver.source === "managed" && this._driverVersion !== DRIVER_VERSION)) {
			return { availability: "driver_incompatible", detail: DRIVER_INCOMPATIBLE_DETAIL };
		}
		const client = this._client;
		if (client === null) return { availability: "stopped", detail: this._stoppedDetail() };
		switch (client.state) {
			case "failed": {
				const detail = this._clientStateDetail ?? "";
				if (detail.startsWith(DRIVER_INCOMPATIBLE_PREFIX)) {
					return { availability: "driver_incompatible", detail: DRIVER_INCOMPATIBLE_DETAIL };
				}
				return { availability: "failed", detail: `驱动启动失败：${truncateDetail(detail)}` };
			}
			case "idle":
			case "stopping":
				return { availability: "stopped", detail: this._stoppedDetail() };
			case "starting":
				return { availability: "starting", detail: "正在启动操控驱动" };
			case "crashed":
				return {
					availability: "starting",
					detail: `驱动异常退出，正在重启（第 ${Math.max(1, this._crashCount)} 次）`,
				};
			case "ready": {
				const missing = this._permissionReport?.missing ?? [];
				if (missing.length > 0) {
					return {
						availability: "permission_required",
						detail: `缺少系统权限：${missing.map(computerUsePermissionLabel).join("、")}`,
					};
				}
				const parts = ["驱动已就绪"];
				const degraded = this._permissionReport?.degraded ?? [];
				if (degraded.length > 0) parts.push(`能力受限：${degraded.map(computerUseDegradedLabel).join("、")}`);
				const warning = this._customVersionWarning();
				if (warning !== undefined) parts.push(warning);
				return { availability: "ready", detail: parts.join("；") };
			}
		}
	}

	private _stoppedDetail(): string {
		const parts = ["驱动已就绪，将在首次使用时启动"];
		const warning = this._customVersionWarning();
		if (warning !== undefined) parts.push(warning);
		return parts.join("；");
	}

	/** A custom binary with a different version may run, but the snapshot warns. */
	private _customVersionWarning(): string | undefined {
		if (this._resolvedDriver?.source !== "custom" || this._driverVersion === null) return undefined;
		if (this._driverVersion === DRIVER_VERSION) return undefined;
		return `自定义驱动版本 ${this._driverVersion} 与 PiX 验证版本 ${DRIVER_VERSION} 不一致，可能不稳定`;
	}

	private _driverInfo(): DriverInfo {
		return {
			version: this._driverVersion,
			source: this._resolvedDriver?.source ?? null,
			path: this._resolvedDriver?.path ?? null,
			expectedVersion: DRIVER_VERSION,
		};
	}

	// =========================================================================
	// Emergency-stop shortcut
	// =========================================================================

	/**
	 * Registered while availability ∈ {starting, ready, permission_required} or
	 * a lease is held, unregistered otherwise. Crashed maps to "starting", so a
	 * backoff restart never unregisters/re-registers. registerShortcut() false
	 * (including "taken by another app": isRegistered() false) -> emergencyShortcut
	 * stays null and the UI stop button remains the primary channel.
	 */
	private _syncShortcut(): void {
		if (this._disposed) return;
		const availability = this._computeAvailability().availability;
		const leaseHeld = this._lease.getState().holderId !== null;
		const wanted = availability === "starting" || availability === "ready"
			|| availability === "permission_required" || leaseHeld;
		if (wanted === this._shortcutWanted) return;
		this._shortcutWanted = wanted;
		if (wanted) {
			const accelerator = emergencyStopAccelerator(this._nodePlatform);
			const electron = this._deps.electron;
			if (accelerator === null || electron === undefined) {
				this._shortcutAccelerator = null;
				return;
			}
			let registered = false;
			try {
				registered = electron.registerShortcut(accelerator, () => this.emergencyStop());
			} catch (err: unknown) {
				console.warn(`[ComputerUse] shortcut registration failed: ${errorText(err)}`);
			}
			this._shortcutAccelerator = registered ? accelerator : null;
		} else {
			const accelerator = this._shortcutAccelerator;
			this._shortcutAccelerator = null;
			if (accelerator !== null) {
				try {
					this._deps.electron?.unregisterShortcut(accelerator);
				} catch (err: unknown) {
					console.warn(`[ComputerUse] shortcut unregister failed: ${errorText(err)}`);
				}
			}
		}
	}

	// =========================================================================
	// Events / snapshot fan-out
	// =========================================================================

	private _foregroundController(): ComputerUseSessionController | null {
		return this._foregroundProvider?.() ?? null;
	}

	private _handleControllerEvent(event: ComputerUseControllerEvent): void {
		if (event.type === "activity") {
			this._emitEvent({ type: "activity", sessionId: event.sessionId, activity: event.activity });
		}
		this._scheduleSnapshot();
	}

	private _emitEvent(event: ComputerUseEvent): void {
		for (const listener of [...this._listeners]) {
			try {
				listener(event);
			} catch (err: unknown) {
				console.warn(`[ComputerUse] event listener failed: ${errorText(err)}`);
			}
		}
	}

	/** Trailing 50 ms coalescing: any number of triggers inside one window emits one snapshot. */
	private _scheduleSnapshot(): void {
		if (this._disposed || this._snapshotTimer !== null) return;
		const timer = setTimeout(() => {
			this._snapshotTimer = null;
			if (this._disposed) return;
			this._emitEvent({ type: "snapshot", snapshot: this.getSnapshot() });
		}, SNAPSHOT_THROTTLE_MS);
		unrefTimer(timer);
		this._snapshotTimer = timer;
	}

	private _clearSnapshotTimer(): void {
		if (this._snapshotTimer === null) return;
		clearTimeout(this._snapshotTimer);
		this._snapshotTimer = null;
	}

	// =========================================================================
	// Install flow
	// =========================================================================

	private _startInstall(): void {
		const installer = this._installer;
		if (installer === null || installer.isInstalling()) return;
		void installer
			.install((progress) => this._handleInstallProgress(progress))
			// A successful install must DROP the old client (it is failed or aimed
			// at the replaced binary) and rebuild it from the new install: a plain
			// refresh would keep the old object through the same-path early return
			// in _ensureClientInstanceNow, leaving a permanently "failed" client.
			.then(() => this._resetDriverInfo())
			.catch((err: unknown) => {
				console.warn(`[ComputerUse] driver install failed: ${errorText(err)}`);
			})
			.finally(() => {
				this._syncShortcut();
				this._scheduleSnapshot();
			});
	}

	private _handleInstallProgress(progress: InstallProgress): void {
		this._installProgress = progress;
		this._emitEvent({ type: "install_progress", progress });
		this._syncShortcut();
		this._scheduleSnapshot();
	}

	// =========================================================================
	// Commands
	// =========================================================================

	async execute(cmd: ComputerUseCommand): Promise<PixCommandResult<ComputerUseSnapshot>> {
		try {
			switch (cmd.type) {
				case "get_snapshot":
					break;
				case "set_session_enabled": {
					const controller = this._foregroundController();
					if (controller === null) {
						return { success: false, error: "没有可用的前台会话。", code: "computer_use_unavailable" };
					}
					controller.setSessionEnabled(cmd.enabled);
					break;
				}
				case "revoke_grants":
					this._foregroundController()?.revokeGrants();
					break;
				case "emergency_stop":
					this.emergencyStop();
					break;
				case "install_driver":
					if (this._installer === null || this._platform === null) {
						return { success: false, error: "当前平台不支持安装操控驱动。", code: "unsupported_platform" };
					}
					this._startInstall();
					break;
				case "cancel_install":
					this._installer?.cancel();
					break;
				case "recheck_driver":
					await this._resetDriverInfo();
					break;
				case "open_permission_settings": {
					const opened = await this._openPermissionSettings(cmd.permission);
					if (!opened.ok) return { success: false, error: opened.error, code: opened.code };
					break;
				}
			}
			return { success: true, data: this.getSnapshot() };
		} catch (err: unknown) {
			return { success: false, error: errorText(err), code: "computer_use_command_failed" };
		}
	}

	/** macOS-only deep link (TCC belongs to PiX under `--direct`). */
	private async _openPermissionSettings(
		permission: "accessibility" | "screen_recording",
	): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
		if (this._nodePlatform !== "darwin") {
			return { ok: false, error: "只有 macOS 需要打开系统权限设置。", code: "unsupported_platform" };
		}
		const openExternal = this._deps.electron?.openExternal;
		if (openExternal === undefined) {
			return { ok: false, error: "系统集成不可用。", code: "unsupported_platform" };
		}
		try {
			await openExternal(MACOS_PERMISSION_PANES[permission]);
			return { ok: true };
		} catch (err: unknown) {
			return { ok: false, error: `打开系统设置失败：${errorText(err)}`, code: "computer_use_command_failed" };
		}
	}
}

// ============================================================================
// Internal helpers
// ============================================================================

/** One-line, length-capped availabilityDetail from the raw driver output tail. */
function truncateDetail(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length === 0) return "驱动进程未能启动";
	if (oneLine.length <= DETAIL_MAX_CHARS) return oneLine;
	// Keep the tail: the failure line is at the end of stderr, not the start.
	// The leading ellipsis counts against the budget, so the result never exceeds it.
	return `…${oneLine.slice(-(DETAIL_MAX_CHARS - 1))}`;
}

/** XDG_SESSION_TYPE -> snapshot value: "wayland"/"x11" verbatim, everything else null. */
function linuxDisplayServer(sessionType: string | undefined): "wayland" | "x11" | null {
	if (sessionType === "wayland") return "wayland";
	if (sessionType === "x11") return "x11";
	return null;
}
