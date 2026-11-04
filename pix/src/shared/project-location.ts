/**
 * Shared project location & execution environment types.
 *
 * Canonical, serializable types describing where a PiX project runs. Shared by
 * the renderer, preload and main processes per wsl_plan.md §4.3.
 *
 * `ProjectLocation.path` is ALWAYS the logical (model-visible) path: for
 * Windows it equals `physicalPath`; for WSL it is the POSIX path inside the
 * distro. `physicalPath` is the host/bootstrap path and is never shown to the
 * model.
 *
 * This module is a leaf: it has no runtime imports. `ThinkingLevel`,
 * `TakeHerEyesSettings` and `GuiSettings` are co-located here (and re-exported
 * by types.ts) so that `GuiSettings` can reference them without a circular
 * dependency. Their field shapes are preserved exactly as they were in types.ts
 * (e.g. `takeHerEyes` remains the `TakeHerEyesSettings` object, not the bare
 * `boolean` sketched in the plan's prose), because out-of-scope callers
 * (SettingsPage.vue, session-bridge.ts) read `takeHerEyes.provider` /
 * `takeHerEyes.modelId` and assign `defaultThinkingLevel` to a `ThinkingLevel`
 * ref. GuiSettings shape changes so far: the §4.3 additions (`schemaVersion`,
 * `wsl`), the 1.4.0 additions (`planModel`, `planThinkingLevel`,
 * `enableProductAnalytics`), the 1.4.1 addition (`autoBackgroundMs`) and the
 * 1.5.0 addition (`computerUse`, whose `ComputerUseSettings` is co-located with
 * `TakeHerEyesSettings` below).
 * `agentTaskMaxConcurrent` is optional; absent means the consumer default
 * (AGENT_TASK_DEFAULT_RUNNING_SLOTS = 4).
 * Migrations are per-version and never write the optional fields: an absent
 * `autoBackgroundMs` means the consumer default (0 = off).
 * `defaultAcp` is optional; absent / undefined = false. It only seeds brand-new
 * empty sessions; resume does not use it.
 */

// ============================================================================
// Project environment & location
// ============================================================================

export type ProjectEnvironment =
  | { kind: "windows" }
  | { kind: "wsl"; distro: string };

export interface ProjectLocation {
  /** Logical (model-visible) path; equals physicalPath for Windows. */
  path: string;
  /** Host/bootstrap path; never displayed to the model. */
  physicalPath: string;
  name: string;
  environment: ProjectEnvironment;
}

export interface ProjectInfo extends ProjectLocation {
  lastOpened: number;
  sessionCount: number;
}

export interface ProjectLocationInput {
  environment: ProjectEnvironment;
  logicalPath?: string;
  physicalPath?: string;
  name?: string;
}

// ============================================================================
// WSL settings & distro metadata
// ============================================================================

export interface WslSettings {
  enabled: boolean;
  distro: string;
  defaultCwd: string;
}

export interface WslDistroInfo {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
}

export interface WslDistroListResult {
  distros: WslDistroInfo[];
  diagnostic?: string;
}

export type ResolveProjectLocationResult =
  | { success: true; location: ProjectLocation }
  | { success: false; error: string };

export type ExecutionEnvironmentInfo =
  | { kind: "windows"; logicalCwd: string }
  | { kind: "wsl"; distro: string; logicalCwd: string; ready: boolean; diagnostic?: string };

// ============================================================================
// Thinking & take-her-eyes settings (co-located for GuiSettings)
// ============================================================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface TakeHerEyesSettings {
  enabled: boolean;
  provider?: string;
  modelId?: string;
}

/**
 * Computer-use（电脑操控）全局设置（1.5.0）。缺省（键不存在）= 全局关闭 + 全部
 * 默认值；数值范围由 shared/computer-use-types.ts 的
 * `resolveComputerUseSettings` 在读取时夹取（store 保留用户原值）。
 */
export interface ComputerUseSettings {
  /** 全局功能开关，默认 false。 */
  enabled: boolean;
  /** 自定义 cua-driver 可执行文件绝对路径；缺省 = 托管安装。 */
  driverPath?: string;
  /** 截图长边像素 768–2560，缺省 1568。 */
  maxImageDimension?: number;
  /** 单张截图 base64 字节上限 150_000–1_500_000，缺省 450_000。 */
  screenshotMaxBytes?: number;
  /** 上下文保留最近截图数 1–8，缺省 3。 */
  keepRecentScreenshots?: number;
  /** 新会话默认开启会话开关，缺省 false。 */
  defaultSessionEnabled?: boolean;
}

// ============================================================================
// GUI settings
// ============================================================================

export interface GuiSettings {
  /** @deprecated No longer needed with direct AgentSession integration */
  piPath?: string;
  theme: string;
  recentProjects: ProjectInfo[];
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  takeHerEyes?: TakeHerEyesSettings;
  /** Settings schema version; migrated to 4 on first load (1.4.1). */
  schemaVersion?: number;
  /** Global WSL defaults; only seed new-project dialog defaults. */
  wsl?: WslSettings;
  /** 1.4.0: plan-mode model; undefined = inherit the session model. */
  planModel?: { provider: string; modelId: string };
  /** 1.4.0: plan-mode thinking level; undefined = inherit. */
  planThinkingLevel?: ThinkingLevel;
  /**
   * 1.4.0: anonymous product-analytics switch; defaults to false and is
   * independent of enableInstallTelemetry.
   */
  enableProductAnalytics?: boolean;
  /**
   * 1.4.1: auto-background threshold in ms for foreground agent tasks;
   * 60000 | 120000 | 300000 | 0 (off). Absent = consumer default
   * (DEFAULT_AUTO_BACKGROUND_MS, 0 = off). When set, expiry only flips
   * panel presentation; it does not release the parent tool await.
   */
  autoBackgroundMs?: number;
  /**
   * Concurrent AgentTask running slots (running + waiting_input).
   * Integer 1–8; absent = AGENT_TASK_DEFAULT_RUNNING_SLOTS (4).
   */
  agentTaskMaxConcurrent?: number;
  /**
   * 仅用于全新空会话的初值。缺省 / undefined = false。resume 不使用。
   */
  defaultAcp?: boolean;
  /**
   * 1.5.0: computer-use（电脑操控）设置；缺省 = 全局关闭 + 全部默认值。
   */
  computerUse?: ComputerUseSettings;
}
