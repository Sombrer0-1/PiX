import type { ProjectInfo, ThinkingLevel, WslSettings } from "@earendil-works/pix-runtime/shared/project-location";

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

export type {
  ProjectEnvironment,
  ProjectLocation,
  ProjectInfo,
  ProjectLocationInput,
  WslSettings,
  WslDistroInfo,
  WslDistroListResult,
  ResolveProjectLocationResult,
  ExecutionEnvironmentInfo,
  ThinkingLevel,
} from "@earendil-works/pix-runtime/shared/project-location";
