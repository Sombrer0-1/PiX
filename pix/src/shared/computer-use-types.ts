/**
 * Plain-data contract for PiX computer use.
 *
 * Shared by main (src/main/computer-use/*, ipc-computer-use-adapters, preload)
 * and renderer (computer-use-store, computer-use UI), so this is a leaf module:
 * the ONLY import is the type-only re-export of `ComputerUseSettings` from
 * ./project-location.js (its home, next to TakeHerEyesSettings). Every value
 * here survives structuredClone / JSON round-trips. Import convention (same as
 * todo-types.ts): main/preload use the relative path
 * "../shared/computer-use-types.js"; renderer uses "@shared/computer-use-types.js".
 */

import type { ComputerUseSettings } from "./project-location.js";

// ---- 设置（ComputerUseSettings 本体定义在 project-location.ts，这里 type 透出） ----
export type { ComputerUseSettings };

export const COMPUTER_OBSERVE_TOOL_NAME = "computer_observe";
export const COMPUTER_ACT_TOOL_NAME = "computer_act";
export const COMPUTER_TOOL_NAMES = [COMPUTER_OBSERVE_TOOL_NAME, COMPUTER_ACT_TOOL_NAME] as const;
/** Session JSONL CustomEntry type for the per-session toggle. */
export const COMPUTER_USE_CUSTOM_TYPE = "pix-computer-use-v1";

export const COMPUTER_USE_DEFAULTS = {
	maxImageDimension: 1568,
	screenshotMaxBytes: 450_000,
	keepRecentScreenshots: 3,
	defaultSessionEnabled: false,
} as const;

export const COMPUTER_USE_LIMITS = {
	maxImageDimension: { min: 768, max: 2560 },
	screenshotMaxBytes: { min: 150_000, max: 1_500_000 },
	keepRecentScreenshots: { min: 1, max: 8 },
	typeTextMaxChars: 10_000,
	observationTextMaxChars: 24_000,
	maxElements: { default: 400, max: 2000 },
	waitMaxMs: 10_000,
	// 以下为工具 schema 与 controller 校验共用的字段界限；computer-tools.ts 只能引用这里，不得写字面量
	queryMaxChars: 200,
	verifyExpect: { min: 1, max: 8 },
	scrollAmount: { min: 1, max: 50 },
	menuPath: { min: 1, max: 16, itemMaxChars: 200 },   // 与 cua-driver 0.34.1 invoke_menu inputSchema maxLength 一致
	hotkeyKeys: { min: 2, max: 6 },
	modifiers: { max: 4 },
	keyMaxChars: 32,
	valueMaxChars: 10_000,
	appNameMaxChars: 256,
	urls: { max: 8, itemMaxChars: 2048 },
	/** 截图超预算时的重拍长边下限（独立于设置项下限 768，否则 0.75× 重拍会被夹回原值）。 */
	reshotMinImageDimension: 512,
} as const;

/** Fully-resolved settings (defaults applied, values clamped). */
export interface ResolvedComputerUseSettings {
	enabled: boolean;
	driverPath: string | null;
	maxImageDimension: number;
	screenshotMaxBytes: number;
	keepRecentScreenshots: number;
	defaultSessionEnabled: boolean;
}
/** Apply defaults + clamp. undefined input → disabled defaults. Pure. */
export function resolveComputerUseSettings(s: ComputerUseSettings | undefined): ResolvedComputerUseSettings {
	return {
		enabled: s?.enabled === true,
		driverPath: typeof s?.driverPath === "string" && s.driverPath.length > 0 ? s.driverPath : null,
		maxImageDimension: clampNumber(
			s?.maxImageDimension,
			COMPUTER_USE_DEFAULTS.maxImageDimension,
			COMPUTER_USE_LIMITS.maxImageDimension.min,
			COMPUTER_USE_LIMITS.maxImageDimension.max,
		),
		screenshotMaxBytes: clampNumber(
			s?.screenshotMaxBytes,
			COMPUTER_USE_DEFAULTS.screenshotMaxBytes,
			COMPUTER_USE_LIMITS.screenshotMaxBytes.min,
			COMPUTER_USE_LIMITS.screenshotMaxBytes.max,
		),
		keepRecentScreenshots: clampNumber(
			s?.keepRecentScreenshots,
			COMPUTER_USE_DEFAULTS.keepRecentScreenshots,
			COMPUTER_USE_LIMITS.keepRecentScreenshots.min,
			COMPUTER_USE_LIMITS.keepRecentScreenshots.max,
		),
		defaultSessionEnabled: s?.defaultSessionEnabled === true,
	};
}
/**
 * IPC sanitizer. Returns undefined when value is not a plain object OR `enabled` is not a boolean
 * (enabled is the required anchor of ComputerUseSettings). Otherwise returns `{ enabled, ...validOptionalFields }`:
 * unknown keys dropped; optional fields kept only when type-correct (numbers finite integers; driverPath is
 * normalized first — trimmed, one layer of surrounding double quotes removed — then accepted only when it is an
 * absolute path string ≤ 1024 chars). Does NOT clamp (store keeps the user value; resolveComputerUseSettings clamps).
 * Caller (ipc-handlers.sanitizeSettings) mirrors the takeHerEyes pattern: explicit
 * `computerUse: undefined` → delete; sanitizer undefined → key ignored (not written).
 */
export function sanitizeComputerUseSettings(value: unknown): ComputerUseSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.enabled !== "boolean") return undefined;
	const cleaned: ComputerUseSettings = { enabled: raw.enabled };
	if (Number.isInteger(raw.maxImageDimension)) cleaned.maxImageDimension = raw.maxImageDimension as number;
	if (Number.isInteger(raw.screenshotMaxBytes)) cleaned.screenshotMaxBytes = raw.screenshotMaxBytes as number;
	if (Number.isInteger(raw.keepRecentScreenshots)) cleaned.keepRecentScreenshots = raw.keepRecentScreenshots as number;
	const driverPath = typeof raw.driverPath === "string" ? normalizeComputerUseDriverPath(raw.driverPath) : undefined;
	if (driverPath !== undefined && isAbsoluteComputerUseDriverPath(driverPath)) cleaned.driverPath = driverPath;
	if (typeof raw.defaultSessionEnabled === "boolean") cleaned.defaultSessionEnabled = raw.defaultSessionEnabled;
	return cleaned;
}

// ---- 运行状态 ----
export type ComputerUsePlatform = "win32-x64" | "win32-arm64" | "darwin-universal" | "linux-x64" | "linux-arm64";

export type ComputerUseAvailability =
	| "disabled"              // 全局开关关
	| "unsupported_platform"
	| "driver_missing"        // 未安装且无自定义路径
	| "driver_incompatible"   // 版本探测失败或 tools/list 缺必需工具
	| "installing"
	| "stopped"               // 就绪可用但驱动进程未启动（懒启动）
	| "starting"
	| "ready"
	| "permission_required"   // check_permissions 报告缺权限（macOS 辅助功能/录屏，Linux 输入）
	| "failed";               // 熔断（连续崩溃）或启动失败，需要用户“重试”

export interface DriverInfo {
	version: string | null;          // probe 结果，如 "0.34.1"
	source: "managed" | "custom" | null;
	path: string | null;
	expectedVersion: string;         // DRIVER_VERSION
}

export interface InstallProgress {
	phase: "downloading" | "verifying" | "extracting" | "done" | "failed" | "cancelled";
	receivedBytes: number;
	totalBytes: number | null;
	error?: string;
}

export type ComputerGrantLevel = "none" | "background" | "foreground";

export interface ComputerUseActivity {
	toolCallId: string;
	tool: "observe" | "act";
	summary: string;                 // 人类可读：例如 "点击 记事本 · 保存 按钮"
	startedAt: number;
	state: "running" | "succeeded" | "failed" | "cancelled";
	errorCode?: ComputerUseErrorCode;
}

/** Session-scoped part; null when there is no foreground single session. */
export interface ComputerUseSessionSnapshot {
	sessionId: string;
	sessionEnabled: boolean;
	grant: ComputerGrantLevel;
	holdsLease: boolean;
	halted: boolean;                 // emergency stop 之后，直到下一次用户 prompt
	toolsActive: boolean;            // 模型当前是否可见 computer 工具
	inactiveReason?: "global_disabled" | "session_disabled" | "read_only_mode" | "unavailable" | "plan_mode";
	activity: ComputerUseActivity | null;
}

export interface ComputerUseSnapshot {
	platform: ComputerUsePlatform | null;
	availability: ComputerUseAvailability;
	availabilityDetail?: string;     // 面向用户的中文说明
	missingPermissions?: string[];   // 阻断性缺失，例如 ["accessibility","screen_recording"]（macOS）、["display"]（Linux 无 X11/Wayland）
	degradedCapabilities?: string[]; // 非阻断降级，例如 ["accessibility_tree"]（Linux AT-SPI 不可用）、["background_input"]（Wayland）
	permissionUndecided?: string[];  // 驱动未上报的权限字段（不可判断、不阻断），设置页提示"无法确认权限"
	linuxDisplayServer?: "wayland" | "x11" | null; // Linux 会话显示协议（XDG_SESSION_TYPE）；驱动启动前即可提示 Wayland 受限
	driver: DriverInfo;
	install: InstallProgress | null;
	emergencyShortcut: string | null; // 注册成功的 accelerator；失败为 null
	session: ComputerUseSessionSnapshot | null;
	updatedAt: number;
}

/**
 * check_permissions 的三值归一化结果（true=已授 / false=缺失 / undefined=不可判断）：
 * missing 仅由显式 false 驱动（阻断性缺失）、degraded 为非阻断降级、undecidable 为驱动未上报的
 * 字段——不阻断，仅上报。是 main/computer-use/contracts.ts
 * PermissionReport 的结构超集，backend 返回值可直接透传给快照。
 */
export interface ComputerPermissionReport {
	missing: string[];                  // 阻断性缺失（显式 false）
	degraded: string[];                 // 非阻断降级
	undecidable: string[];              // 驱动未上报的字段（不可判断，不阻断）
}

// ---- IPC 命令（channel "computer-use-command"，返回 PixCommandResult<ComputerUseSnapshot>） ----
export type ComputerUseCommand =
	| { type: "get_snapshot" }
	| { type: "set_session_enabled"; enabled: boolean }
	| { type: "revoke_grants" }
	| { type: "emergency_stop" }
	| { type: "install_driver" }
	| { type: "cancel_install" }
	| { type: "recheck_driver" }       // 重新定位/探测/清熔断
	| { type: "open_permission_settings"; permission: "accessibility" | "screen_recording" };

/** 结构守卫：computer-use-command IPC 入口过滤（对照 isTodoCommand 的口径，含字段校验）。 */
export function isComputerUseCommand(v: unknown): v is ComputerUseCommand {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const cmd = v as Record<string, unknown>;
	switch (cmd.type) {
		case "get_snapshot":
		case "revoke_grants":
		case "emergency_stop":
		case "install_driver":
		case "cancel_install":
		case "recheck_driver":
			return true;
		case "set_session_enabled":
			return typeof cmd.enabled === "boolean";
		case "open_permission_settings":
			return cmd.permission === "accessibility" || cmd.permission === "screen_recording";
		default:
			return false;
	}
}

// ---- IPC 事件（channel "computer-use-event"） ----
export type ComputerUseEvent =
	| { type: "snapshot"; snapshot: ComputerUseSnapshot }
	| { type: "install_progress"; progress: InstallProgress }
	| { type: "activity"; sessionId: string; activity: ComputerUseActivity };

// ---- 错误码（模型可见文本与 UI 共用） ----
export type ComputerUseErrorCode =
	| "global_disabled" | "session_disabled" | "not_foreground" | "halted" | "unavailable"
	| "permission_required" | "user_denied" | "desktop_busy" | "self_target" | "invalid_params"
	| "stale_reference" | "background_unavailable" | "unsupported_on_platform" | "driver_error"
	| "driver_crashed" | "timeout" | "cancelled" | "dangerous_action_blocked" | "driver_incompatible";
// 非视觉模型属于降级而非错误（见 details.screenshot.omitted），没有对应错误码；
// dangerous_action_blocked 用于 unattended 模式下的危险热键（无人可确认）。
// driver_incompatible：版本探测失败或 tools/list 缺必需工具，
// 与同名 ComputerUseAvailability 值含义一致，作为错误码抛给调用方。
/** Error tool results carry no details (agent-loop drops them); the code is recovered from the text prefix. */
export const COMPUTER_USE_ERROR_PATTERN = /^\[computer_use:([a-z_]+)\]/;

// ---- 工具参数（与 computer-tools.ts 的 TypeBox schema 一一对应） ----
export type ComputerObserveView = "apps" | "windows" | "window" | "desktop" | "zoom" | "verify";

export interface ComputerVerifyExpectation {
	element?: {
		selector: { label_contains?: string; role?: string };
		/** 仅支持 true；false 会被驱动拒绝（无法证明控件不存在）。 */
		exists?: boolean; enabled?: boolean; selected?: boolean; value_equals?: string;
	};
	window?: { exists?: boolean };
}

export interface ComputerObserveParams {
	view: ComputerObserveView;
	pid?: number;                    // window / zoom / verify 必需；windows 可选过滤
	window_id?: number;              // window / zoom / verify 必需（Windows/macOS 的 get_window_state 要求 [pid, window_id]，只有 Linux 可省略；PiX 取跨平台最严格集合）
	query?: string;                  // window：可访问性树过滤
	max_elements?: number;
	screenshot?: boolean;            // window/desktop/verify，缺省 true（非视觉模型强制 false）
	region?: { x1: number; y1: number; x2: number; y2: number }; // zoom，窗口截图像素
	expect?: ComputerVerifyExpectation[]; // verify，1–8 条
	on_screen_only?: boolean;        // windows
}

export type ComputerActAction =
	| "click" | "double_click" | "right_click" | "type_text" | "press_key" | "hotkey"
	| "scroll" | "drag" | "move_cursor" | "set_value" | "invoke_menu" | "launch_app"
	| "focus_window" | "wait";

export interface ComputerActParams {
	action: ComputerActAction;
	frame?: "window" | "desktop";    // 坐标系；缺省：有 pid → window，否则 desktop
	pid?: number;
	window_id?: number;
	element_token?: string;          // ^s[0-9a-f]{8}:[0-9]+$
	capture_id?: string;             // 绑定某次截图做准入校验
	x?: number; y?: number;          // 截图像素（对应 frame）
	to_x?: number; to_y?: number;    // drag 终点
	from_zoom?: boolean;             // 坐标来自 zoom 视图
	text?: string;                   // type_text
	key?: string;                    // press_key
	modifiers?: string[];            // press_key / click：ctrl shift alt super(cmd)
	keys?: string[];                 // hotkey，≥2
	direction?: "up" | "down" | "left" | "right"; // scroll
	amount?: number;                 // scroll 1–50
	value?: string;                  // set_value
	menu_path?: string[];            // invoke_menu，1–16（invoke_menu 需要 pid + window_id + menu_path）
	app?: string;                    // launch_app：应用名
	urls?: string[];                 // launch_app 可选
	duration_ms?: number;            // wait 0–10000
	delivery?: "background" | "foreground"; // 缺省 background
	observe_after?: boolean;         // 缺省 true：动作后自动观察同一目标
}

/**
 * PiX 侧“跨平台可移植”必填字段。每个 view/action 给出若干备选字段组，满足任一组即通过；
 * 缺失 → invalid_params（message 列出全部备选组）。这是 PiX 契约层校验；平台差异由 cua-backend 的
 * 运行时 inputSchema.required 校验兜底。工具 description 必须据此生成每个 action 的用法说明。
 */
export const COMPUTER_OBSERVE_REQUIRED: Readonly<Record<ComputerObserveView, ReadonlyArray<ReadonlyArray<keyof ComputerObserveParams>>>> = {
	apps: [[]], windows: [[]], desktop: [[]],
	window: [["pid", "window_id"]],
	zoom: [["pid", "window_id", "region"]],
	verify: [["pid", "window_id", "expect"]],
};
export const COMPUTER_ACT_REQUIRED: Readonly<Record<ComputerActAction, ReadonlyArray<ReadonlyArray<keyof ComputerActParams>>>> = {
	click: [["pid", "window_id", "element_token"], ["pid", "window_id", "x", "y"], ["x", "y"]],
	double_click: [["pid", "window_id", "element_token"], ["pid", "window_id", "x", "y"], ["x", "y"]],
	right_click: [["pid", "window_id", "element_token"], ["pid", "window_id", "x", "y"], ["x", "y"]],
	type_text: [["text"]],
	press_key: [["key"]],
	hotkey: [["keys"]],
	scroll: [["direction"]],
	drag: [["x", "y", "to_x", "to_y"]],
	move_cursor: [["x", "y"]],
	set_value: [["pid", "element_token", "value"]],
	invoke_menu: [["pid", "window_id", "menu_path"]],
	launch_app: [["app"]],
	focus_window: [["pid"]],
	wait: [["duration_ms"]],
};
/** Pure: returns null when satisfied, else the alternatives list for the error message. */
export function missingRequiredFields<P extends object>(
	params: P,
	alternatives: ReadonlyArray<ReadonlyArray<keyof P>>,
): ReadonlyArray<ReadonlyArray<keyof P>> | null {
	for (const group of alternatives) {
		if (group.every((key) => params[key] !== undefined)) {
			return null;
		}
	}
	return alternatives;
}

/** details of AgentToolResult for both tools (persisted in JSONL; keep small, NO base64). */
export interface ComputerToolDetails {
	kind: "observe" | "act";
	view?: ComputerObserveView;
	action?: ComputerActAction;
	target?: { pid?: number; windowId?: number; appName?: string; windowTitle?: string; frame?: "window" | "desktop" };
	captureId?: string;
	/** 当前驱动快照 id；element_token 前缀由它派生。 */
	snapshotId?: string;
	screenshot?: { width: number; height: number; mimeType: string; bytes: number; omitted?: "non_vision_model" | "images_blocked" | "not_requested" };
	grant: ComputerGrantLevel;
	durationMs: number;
	// 不含 errorCode：错误结果没有 details（agent-loop.ts:640–731），错误码从文本前缀解析（COMPUTER_USE_ERROR_PATTERN）
	driverTool?: string;             // 调试用：实际调用的驱动工具名
}

// ============================================================================
// 中文标签（主进程快照 detail 与渲染端展示共用，单一来源）
// ============================================================================

const PERMISSION_LABELS: Readonly<Record<string, string>> = {
	accessibility: "辅助功能",
	screen_recording: "屏幕录制",
	display: "图形显示会话",
};

const DEGRADED_LABELS: Readonly<Record<string, string>> = {
	accessibility_tree: "可访问性树不可用（仅截图）",
	background_input: "Wayland 下无法后台输入（改用前台需要授权）",
};

const GRANT_LABELS: Readonly<Record<string, string>> = {
	none: "未授权",
	background: "后台授权",
	foreground: "前台授权",
};

/** 权限项中文名；未知项原样透出。 */
export function computerUsePermissionLabel(permission: string): string {
	return PERMISSION_LABELS[permission] ?? permission;
}

/** 降级项中文名；未知项原样透出。 */
export function computerUseDegradedLabel(capability: string): string {
	return DEGRADED_LABELS[capability] ?? capability;
}

/** 授权级别中文名；未知项原样透出。 */
export function computerUseGrantLabel(level: string): string {
	return GRANT_LABELS[level] ?? level;
}

// ============================================================================
// Internal helpers
// ============================================================================

/** 有限数值 → Math.round 后夹取到 [min, max]；其它类型（含 NaN/Infinity）→ fallback。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.round(value), min), max);
}

/** 绝对路径：POSIX（/…）或 Windows 盘符（C:\ 或 C:/）或 UNC（\\…）；长度 1–1024。 */
export function isAbsoluteComputerUseDriverPath(p: string): boolean {
	if (p.length === 0 || p.length > 1024) return false;
	if (p.startsWith("/")) return true;
	if (p.startsWith("\\\\")) return true;
	return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * 驱动路径输入规范化（设置页与主进程共用）：trim；首尾均为双引号且长度 ≥ 2 时剥掉且只剥掉一层，再 trim；
 * 空串 → undefined。资源管理器「复制为路径」会得到 "C:\…\cua-driver.exe"，不规范化会被绝对路径检查丢弃。
 */
export function normalizeComputerUseDriverPath(value: string): string | undefined {
	let path = value.trim();
	if (path.length >= 2 && path.startsWith("\"") && path.endsWith("\"")) {
		path = path.slice(1, -1).trim();
	}
	return path.length > 0 ? path : undefined;
}
