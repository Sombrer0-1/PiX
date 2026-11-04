/**
 * Main-process cross-module contracts for computer use.
 *
 * Every value (`ComputerUseError`) and interface (`DriverClient`, `ComputerBackend`,
 * `TargetGuard`, `DesktopLease`, `ScreenshotEncoder`, `PixSurfaceProvider`, …) used by
 * two or more modules is written down here once. Implementations `implements` /
 * `import type` these types and never import each other.
 *
 * Runtime code is limited to `ComputerUseError` and the shared helpers at the bottom
 * (`errorText`, `unrefTimer`, `effectiveFrame`, `isComputerToolName`,
 * `SCREENSHOT_RETENTION_CHUNK`).
 */

import { COMPUTER_TOOL_NAMES } from "../../shared/computer-use-types.js";
import type {
	ComputerUseErrorCode, ComputerUsePlatform, ComputerObserveParams, ComputerActParams, ComputerToolDetails,
} from "../../shared/computer-use-types.js";

// ---- 错误 ----
/**
 * `Error.message` IS the model-visible text: "[computer_use:<code>] <detail>" + ("\nHint: " + hint)?.
 * Reason: the agent loop turns a thrown error into `createErrorToolResult(error.message)` and DROPS details
 * (packages/agent/src/agent-loop.ts:640–731), so code/hint must live in the message. The renderer recovers
 * the code with /^\[computer_use:([a-z_]+)\]/.
 */
export class ComputerUseError extends Error {
	constructor(readonly code: ComputerUseErrorCode, readonly detail: string, readonly hint?: string) {
		super(hint ? `[computer_use:${code}] ${detail}\nHint: ${hint}` : `[computer_use:${code}] ${detail}`);
		this.name = "ComputerUseError";
	}
}
// COMPUTER_USE_ERROR_PATTERN 定义在 shared/computer-use-types.ts（renderer 也要用）

// ---- 驱动客户端 ----
export type DriverClientState = "idle" | "starting" | "ready" | "crashed" | "stopping" | "failed";
export interface DriverToolResult {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	structuredContent?: Record<string, unknown>;
	isError: boolean;
}
export interface DriverCallOptions { signal?: AbortSignal; timeoutMs?: number }
export interface DriverToolInputSchema { required: readonly string[]; properties: ReadonlySet<string> }
export interface DriverClient {
	readonly state: DriverClientState;
	/** Idempotent; resolves when ready. Rejects ComputerUseError("unavailable" | "driver_incompatible"). */
	ensureStarted(): Promise<void>;
	listToolNames(): ReadonlySet<string>;
	getToolInputSchema(name: string): DriverToolInputSchema | null;
	/** Error mapping: cancelled / driver_crashed / timeout / driver_error / unsupported_on_platform. */
	callTool(name: string, args: Record<string, unknown>, opts?: DriverCallOptions): Promise<DriverToolResult>;
	/** Abort every in-flight call (emergency stop); each rejects "cancelled". */
	cancelAll(): void;
	stop(): Promise<void>;
	onStateChange(listener: (s: DriverClientState, detail?: string) => void): () => void;
}

// ---- 后端 ----
export interface BackendSessionHandle { readonly driverSession: string }  // e.g. "pix-<genId>-<8hex>"
export interface BackendImage { data: string; mimeType: string; width: number; height: number }
/** get_window_state 的树覆盖信息（cua-driver 0.34.1）；字段缺失或类型不符时为 null。 */
export interface BackendTreeInfo {
	truncated: boolean;
	truncationReason: string | null;
	complete: boolean | null;
	totalElements: number | null;
	returnedElements: number | null;
	filteredElements: number | null;
}
/** verify_state 的单条 predicate 结果。 */
export interface BackendVerifyPredicate {
	index: number;
	status: "satisfied" | "unsatisfied" | "unknown";
	unknownReason: string | null;
	observed: string | null;
}
/** verify_state 的归一化结果。 */
export interface BackendVerifyResult {
	status: "satisfied" | "unsatisfied" | "unknown";
	stable: boolean;
	samples: number;
	elapsedMs: number | null;
	predicates: BackendVerifyPredicate[];
}
export interface BackendObservation {
	text: string;                          // 面向模型的文本（驱动提供的元素列表/树摘要/窗口信息）
	image: BackendImage | null;            // 原始驱动截图，未经 PiX 预算
	captureId?: string;
	snapshotId?: string;                   // 当前驱动快照 id；element_token 前缀由它派生
	tree?: BackendTreeInfo;
	verify?: BackendVerifyResult;          // 仅 view=verify
	zoom?: boolean;                       // 截图为新生成的 zoom 视图；坐标配合 from_zoom
	target?: ComputerToolDetails["target"];
	driverTool: string;
}
export interface BackendActionResult {
	text: string;
	effect?: string;                       // 驱动结果；原生回读证明目标值/状态时为 confirmed
	deliveryMode?: "background" | "foreground" | "not_applicable" | "unknown";
	route?: string;                        // 驱动实际使用的输入路径（如 "uia"）
	evidence?: Array<{ kind: string; detail: string | null }>;
	target?: ComputerToolDetails["target"];
	driverTool: string;
}
/** undecidable: fields the driver left unreported (undefined) - not blocking, surfaced for the UI. */
export interface PermissionReport { missing: string[]; degraded: string[]; undecidable?: readonly string[] }
export interface ComputerBackend {
	readonly platform: ComputerUsePlatform;
	openSession(label: string): Promise<BackendSessionHandle>;    // 懒调用 start_session
	closeSession(h: BackendSessionHandle): Promise<void>;          // end_session，失败吞掉
	/** Throws ComputerUseError. maxImageDimension = per-call long edge. */
	observe(h: BackendSessionHandle, p: ComputerObserveParams, o: { maxImageDimension: number; wantImage: boolean; signal?: AbortSignal; preserveZoom?: boolean }): Promise<BackendObservation>;
	act(h: BackendSessionHandle, p: ComputerActParams, o: { signal?: AbortSignal }): Promise<BackendActionResult>;
	/** check_permissions (macOS 传 prompt:false 做只读检查) → 平台归一化报告。 */
	checkPermissions(): Promise<PermissionReport>;
	supports(kind: "observe" | "act", name: string): boolean;
}

// ---- 截图编码 ----
export type EncodeResult =
	| { ok: true; data: string; mimeType: string; width: number; height: number; bytes: number }
	| { ok: false; reason: "over_budget"; bytes: number };
export type ScreenshotEncoder = (img: BackendImage, maxBytes: number) => Promise<EncodeResult>;

// ---- 上下文保留策略（applyScreenshotRetention） ----
export interface ScreenshotRetentionPolicy { keepRecent: number; chunk: number }

// ---- 目标守卫（Electron 数据由 service 注入） ----
export interface PixSurfaceProvider { getPixPids(): number[]; isPixFocused(): boolean }
export interface TargetGuard {
	assertActAllowed(p: ComputerActParams): void;          // throws ComputerUseError("self_target")
	assertObserveAllowed(p: ComputerObserveParams): void;  // throws ComputerUseError("self_target")
}

// ---- 桌面租约 ----
export interface DesktopLeaseState { holderId: string | null; acquiredAt: number | null; lastUsedAt: number | null }
export interface DesktopLease {
	tryAcquire(holderId: string): boolean;
	release(holderId: string): void;
	forceRelease(): void;
	getState(): DesktopLeaseState;
	onChange(listener: (s: DesktopLeaseState) => void): () => void;
}

// ---- 共享微型工具 ----

/** Coordinate frame of an act call; default: pid -> window, otherwise desktop. */
export function effectiveFrame(p: ComputerActParams): "window" | "desktop" {
	return p.frame ?? (p.pid !== undefined ? "window" : "desktop");
}

/** True when `name` is one of the PiX computer tools. */
export function isComputerToolName(name: string): boolean {
	return (COMPUTER_TOOL_NAMES as readonly string[]).includes(name);
}

/** unknown 错误 → message 文本。 */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Unref 定时器句柄。ref'd timer 会拖住短命进程（测试）；Electron 主进程不受影响。
 */
export function unrefTimer(handle: unknown): void {
	const timer = handle as { unref?: () => void } | null | undefined;
	if (timer !== null && timer !== undefined && typeof timer.unref === "function") timer.unref();
}

/** 截图上下文保留策略的替换粒度。 */
export const SCREENSHOT_RETENTION_CHUNK = 2;
