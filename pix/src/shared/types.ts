/**
 * Shared types between main and renderer processes.
 * These mirror the Pi RPC protocol types.
 */

// Project location, WSL settings and GuiSettings live in project-location.ts
// (a leaf module) and are re-exported here so existing `from "../shared/types"`
// imports keep working. See project-location.ts for the rationale. Only the
// types used by other declarations in this file are imported; the rest are
// re-exported at the bottom.
import type {
  ExecutionEnvironmentInfo,
  ThinkingLevel,
} from "./project-location.js";
import type { CustomProviderConfig } from "./custom-providers.js";
import type {
  PlanCancelRef,
  PlanDeviation,
  PlanRuntimeSnapshot,
  PlanStep,
} from "./plan-types.js";
import type {
  AgentTaskActivity,
  AgentTaskDiagnosticExport,
  AgentTaskInfo,
  AgentTaskInputRequest,
  AgentTaskListSnapshot,
  AgentTaskLogEvent,
  AgentTaskLogSnapshot,
  AgentTaskRecoveryIssue,
  AgentTaskStorageStatus,
  AgentTaskTranscriptPage,
} from "./agent-task-types.js";

// ============================================================================
// RPC Command Types (commands sent to pi via stdin)
// ============================================================================

export interface ClipboardImage {
  mimeType: string;
  base64: string;
}

export type RpcCommand =
  // Prompting
  | { id?: string; type: "prompt"; message: string; filePaths?: string[]; images?: ClipboardImage[] }
  | { id?: string; type: "steer"; message: string; filePaths?: string[]; images?: ClipboardImage[] }
  | { id?: string; type: "follow_up"; message: string; filePaths?: string[]; images?: ClipboardImage[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "retry" }
  | { id?: string; type: "abort_retry" }
  | { id?: string; type: "respond_user_input"; response: RequestUserInputResponse }
  | { id?: string; type: "new_session"; parentSession?: string }
  // State
  | { id?: string; type: "get_state" }
  // Model
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model"; direction?: "forward" | "backward" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "get_available_thinking_levels" }
  | { id?: string; type: "supports_thinking" }
  | { id?: string; type: "set_scoped_models"; patterns: string[] }
  | { id?: string; type: "get_scoped_models" }
  // Thinking
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }
  // Compaction
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_acp"; enabled: boolean }
  // Session
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "fork"; entryId: string; position?: "before" | "at"; label?: string }
  | {
      id?: string;
      type: "navigate_tree";
      targetId: string;
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    }
  | { id?: string; type: "clone" }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "set_session_name"; name: string }
  | { id?: string; type: "get_tree" }
  | { id?: string; type: "get_user_messages_for_forking" }
  | { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
  // Messages
  | { id?: string; type: "get_messages" }
  // Commands
  | { id?: string; type: "get_commands" }
  // Export
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "export_jsonl"; outputPath?: string }
  // Auth
  | { id?: string; type: "login"; provider: string }
  | { id?: string; type: "logout"; provider: string }
  | { id?: string; type: "get_auth_status" }
  | { id?: string; type: "set_api_key"; provider: string; key: string }
  | { id?: string; type: "remove_auth"; provider: string }
  // Custom providers (models.json management; reuses the RPC channel)
  | { id?: string; type: "get_custom_providers" }
  | { id?: string; type: "set_custom_providers"; providers: Record<string, CustomProviderConfig> }
  // Settings (full pi settings from SettingsManager)
  | { id?: string; type: "get_pi_settings" }
  | { id?: string; type: "set_pi_setting"; key: string; value: unknown }
  | { id?: string; type: "set_pi_settings"; entries: Array<{ key: string; value: unknown }> }
  // Resources
  | { id?: string; type: "reload_resources" }
  | { id?: string; type: "get_themes" }
  | { id?: string; type: "get_resource_status" };

// ============================================================================
// RPC Response Types (received from pi stdout)
// ============================================================================

export interface RpcSessionState {
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying?: boolean;
  retryAttempt?: number;
  executionMode: "approval" | "unattended" | "read-only";
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  /** Optional; missing = ACP OFF. */
  acp?: { enabled: boolean; locked: boolean };
  messageCount: number;
  pendingMessageCount: number;
  blockImages?: boolean;
  goal?: ThreadGoal;
  /**
   * Execution environment of the active session. Unrelated to `executionMode`
   * (which is the approval mode). WSL sessions carry distro + logicalCwd; the
   * renderer reads this to render the environment badge.
   */
  executionEnvironment?: ExecutionEnvironmentInfo;
}

export interface RpcSlashCommand {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  sourceInfo: {
    path?: string;
    package?: string;
    name?: string;
  };
}

export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

export interface ThreadGoal {
  id: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedMs: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface ModelInfo {
  provider: string;
  id: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
  input?: ("text" | "image")[];
  thinkingLevelMap?: Record<string, string | null>;
}

/**
 * Classification of an API error, mirrored from @earendil-works/pi-ai.
 * Drives the status badge and retry-button visibility in the UI.
 */
export type ApiErrorCategory =
  | "auth"
  | "quota"
  | "overloaded"
  | "server"
  | "rate_limit"
  | "network"
  | "unknown";

// ============================================================================
// Agent Session Event Types (streamed from pi stdout)
// ============================================================================

export type AgentSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: unknown[]; willRetry?: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message: unknown; toolResults: unknown[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent?: unknown }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "file_change"; toolCallId: string; toolName: string; change: FileChangeSummary; aggregate: TurnDiffSummary }
  | { type: "verification_gate"; reason: "file_changes"; summary: TurnDiffSummary }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result?: unknown; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "eye_model_start"; id?: string; provider: string; modelId: string; imageCount: number }
  | { type: "eye_model_end"; id?: string; provider: string; modelId: string; imageCount: number; success: boolean; errorMessage?: string }
  | { type: "goal_update"; goal: ThreadGoal | undefined }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; retryAfterMs?: number; category?: ApiErrorCategory }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | {
      type: "api_error";
      errorMessage: string;
      category: ApiErrorCategory;
      httpStatus?: number;
      title: string;
      retryable: boolean;
      autoRetried?: number;
      retryAfterMs?: number;
    };

export interface AgentMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
  [key: string]: unknown;
}

export interface ChatMessageAttachment {
  path: string;
  name: string;
  kind: "text" | "image" | "file";
  size?: number;
  content?: string;
}

// ============================================================================
// Display Block Types (derived from events for rendering)
// ============================================================================

export interface ToolWorkItem {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  diff?: DiffSummary;
  fileChange?: FileChangeSummary;
}

export interface DiffSummary {
  added: number;
  removed: number;
}

export interface FileChangeSummary extends DiffSummary {
  path?: string;
  toolCallId: string;
  toolName: string;
  diff?: string;
  patch?: string;
  firstChangedLine?: number;
}

export interface TurnDiffSummary extends DiffSummary {
  files: number;
  changes: FileChangeSummary[];
}

export type DisplayBlock =
  | { id: string; type: "user-message"; text: string; attachments?: ChatMessageAttachment[]; timestamp: number }
  | { id: string; type: "agent-message"; content: string; isStreaming: boolean; timestamp: number }
  | {
      id: string;
      type: "thinking";
      /** 累积的思考纯文本。空串 = 「AI 正在思考...」等待占位（尚未收到 thinking delta）。 */
      content: string;
      /** "streaming"=思考 delta 仍可能到达；"ended"=thinking_end / 回放 / 回合终止。 */
      phase: "streaming" | "ended";
      /** true = 下一个 move 已开始（首段正文 / 工具调用），视图层据此自动折叠。 */
      superseded: boolean;
      timestamp: number;
    }
  | { id: string; type: "vision-status"; provider: string; modelId: string; imageCount: number; status: "running" | "success" | "error"; timestamp: number }
  | { id: string; type: "work-status"; tools: ToolWorkItem[]; isStreaming: boolean; timestamp: number }
  | { id: string; type: "turn-separator"; timestamp: number }
  | { id: string; type: "error"; message: string; source?: string; category?: ApiErrorCategory; httpStatus?: number; title?: string; retryable?: boolean; autoRetried?: number; retryAfterMs?: number; timestamp: number }
  | { id: string; type: "compaction"; reason: string; result: string; aborted: boolean; timestamp: number }
  | { id: string; type: "retry"; success: boolean; attempt: number; maxAttempts: number; delayMs?: number; category?: ApiErrorCategory; errorSummary?: string; retryAfterMs?: number; timestamp: number }
  | { id: string; type: "note"; text: string; timestamp: number }
  | { id: string; type: "status"; status: "running" | "idle" | "error" | "compacting"; timestamp: number };

// ============================================================================
// Project & Session Info Types
// ============================================================================

// ProjectInfo and the project-location surface are defined in project-location.ts
// and re-exported at the bottom of this file. SessionInfo stays here: its field
// types are unchanged (created/modified remain ISO strings) per the WSL plan's
// "do not change fields" note; WSL mode translates `cwd` to logical at the
// listSessions call site, and `path` is the physical JSONL path (not shown to
// the model).

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

// ============================================================================
// GUI Settings Types
// ============================================================================

// GuiSettings is defined in project-location.ts (it references ProjectInfo and
// WslSettings, both co-located there) and re-exported at the bottom of this
// file. The §4.3 additions (schemaVersion, wsl) are the only shape changes;
// takeHerEyes/defaultThinkingLevel keep their existing rich field types.

// ============================================================================
// Model-initiated User Input
// ============================================================================

export interface RequestUserInputOption {
  label: string;
  description?: string;
}

export interface RequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options?: RequestUserInputOption[];
}

export interface RequestUserInputRequest {
  id: string;
  questions: RequestUserInputQuestion[];
}

export interface RequestUserInputResponse {
  id: string;
  answers: Record<string, string>;
  cancelled?: boolean;
}

/** Why the main process revoked an already-displayed user input request. */
export type RequestUserInputDismissalReason = "aborted" | "session_closed";

/**
 * Main-initiated revocation of a displayed user input request (design plan
 * section 4.9). The renderer only discards its local clarification state when
 * the id matches the pending request; it never replies to a dismissal.
 */
export interface RequestUserInputDismissal {
  id: string;
  reason: RequestUserInputDismissalReason;
}

// ============================================================================
// Auth Types
// ============================================================================

export interface AuthStatus {
  provider: string;
  configured: boolean;
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  label?: string;
}

/** Map of provider name -> auth status */
export type AuthStatusMap = Record<string, AuthStatus>;

// ============================================================================
// Session Tree Types
// ============================================================================

export interface TreeEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  summary?: string;
  messagePreview?: string;
  label?: string;
  labelTimestamp?: number | string;
  children?: TreeEntry[];
}

export interface UserMessageForForking {
  entryId: string;
  text: string;
}

// ============================================================================
// Resource Types
// ============================================================================

export interface ThemeInfo {
  name: string;
  path?: string;
  source: "builtin" | "custom";
}

export interface ResourceStatus {
  extensions: { loaded: number; errors: string[] };
  skills: { loaded: number };
  prompts: { loaded: number };
  themes: { loaded: number };
}

// ============================================================================
// MCP Types
// ============================================================================

export interface McpServerInfo {
  name: string;
  status: "disconnected" | "connecting" | "connected" | "failed";
  error?: string;
  toolCount: number;
  tools: string[];
  transport: "stdio" | "http" | "sse";
  required: boolean;
  stderr?: string;
}

export interface McpConfigInfo {
  configPaths: string[];
  errors: string[];
}

export interface McpResourceInfo {
  server: string;
  resources: unknown[];
}

export interface McpResourceContent {
  server: string;
  contents: unknown[];
  errors?: string[];
}

// ============================================================================
// Pi Settings Type (mirrors Settings from pi SDK settings-manager)
// ============================================================================

export interface PiSettings {
  lastChangelogVersion?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  transport?: string;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  execution?: {
    mode?: "approval" | "unattended" | "read-only";
    verificationGate?: boolean;
  };
  theme?: string;
  hideThinkingBlock?: boolean;
  shellPath?: string;
  quietStartup?: boolean;
  shellCommandPrefix?: string;
  npmCommand?: string[];
  collapseChangelog?: boolean;
  enableInstallTelemetry?: boolean;
  enableSkillCommands?: boolean;
  sessionDir?: string;
  httpIdleTimeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  enabledModels?: string[];
  doubleEscapeAction?: "fork" | "tree" | "none";
  treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
  showHardwareCursor?: boolean;
  editorPaddingX?: number;
  autocompleteMaxVisible?: number;
  codeBlockIndent?: string;
  [key: string]: unknown;
}

// ============================================================================
// Team (Roundtable) Types
// ============================================================================
//
// 圆桌（Discuss）的跨进程类型与常量的唯一来源是 team-types.ts；本文件对 Team 段只
// 做 re-export，避免双份定义（dev plan §3.1 / §4.12）。main / preload / renderer
// 仍可沿用 `from "../shared/types"` 这一条导入路径。
//
// 非类型的圆桌常量（USER_SEAT_ID、ROUNDTABLE_TIER_SEATS、DEFAULT_ROUNDTABLE_TIER、
// MIN_SEATS、MAX_SEATS、PERSPECTIVE_TEMPLATES、timelineTypeFromUtterance）不在
// type-only re-export 之列，直接从 `shared/team-types.js` 导入。

export type {
  AttentionItem,
  DeliverableVersion,
  DeliveryState,
  ExitRequest,
  InboxEntry,
  InterruptLevel,
  KnowledgeCard,
  OpenItem,
  PackedContext,
  PersistedRoundtable,
  RoundtableLifecycle,
  RoundtableMetricsSnapshot,
  RoundtableSettings,
  RoundtableState,
  RoundtableTier,
  SeatConfig,
  SeatInfo,
  SeatRuntimeStatus,
  TeamCommand,
  TeamEvent,
  TimelineItem,
  TimelineItemType,
  ToolAuthTier,
  UtteranceKind,
  WriteLease,
} from "./team-types.js";

/** A permission request from a worker agent. */
export interface PermissionRequest {
  id: string;
  teamName: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Plan IPC Types (PiX 1.4.0, design plan §4.9)
// ============================================================================
//
// Renderer <-> main contract for the Plan feature. PlanRuntimeSnapshot /
// PlanStep / PlanDeviation / PlanCancelRef come from the leaf module
// plan-types.ts; shared/types.ts never references main/plan/plan-controller.ts.
// The envelope (PixCommandResult) is the existing PixApi envelope, no second
// protocol.

export type PlanCommand =
  | {
      type: "enter_planning";
      requestText?: string;
      filePaths?: string[];
      images?: ClipboardImage[];
      source?: "configured" | "session";
    } // 首次 armed 提交 requestText 必填非空；仅 dormant retry 可省略，且此时不得带附件
  | { type: "retry_generation"; generationId: string }
  | { type: "use_session_model_and_retry"; generationId: string }
  | { type: "regenerate_plan"; generationId: string; concise: boolean }
  | { type: "request_revision"; planId: string; version: number; feedback: string; stepKey?: string }
  | { type: "return_previous_version"; planId: string; baseVersion: number }
  | { type: "approve"; planId: string; version: number }
  | { type: "start_execution"; planId: string; version: number }
  | ({ type: "cancel" } & PlanCancelRef)
  | { type: "retry_step"; planId: string; version: number; stepId: string }
  | { type: "skip_step"; planId: string; version: number; stepId: string }
  | { type: "continue_plan"; planId: string; version: number }
  | { type: "get_snapshot" };

export type PlanEvent =
  | { type: "plan_state"; snapshot: PlanRuntimeSnapshot }
  | { type: "plan_step"; planId: string; version: number; step: PlanStep }
  | { type: "plan_deviation"; deviation: PlanDeviation };

/**
 * Existing PixApi result envelope, reused for plan-command. Data-bearing
 * commands must carry `data` on success; data-less commands may omit it.
 */
export type PixCommandResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string; code?: string };

// ============================================================================
// Agent Task IPC Types (PiX 1.4.1, design plan §4.9)
// ============================================================================
//
// Renderer <-> main contract for the app-level agent task feature.
// AgentTaskInfo / AgentTaskActivity / AgentTaskInputRequest come from the leaf
// module agent-task-types.ts; shared/types.ts never references main-only
// service types. The envelope (PixCommandResult) is the existing PixApi
// envelope, no second protocol. AgentTaskCommandData must extend in lockstep
// with the command union per release stage: 1.4.1 get_all data is
// AgentTaskInfo[] (AgentTaskListSnapshot arrives with the 1.4.2 R2 switch),
// and AgentTaskGroupHandle belongs to the agent tool result, never to an IPC
// command's data.

// 1.5 (P1): the manual-operation commands are gone (send_to_session, clear,
// clear_all_terminal, background, foreground, continue_foreground_wait, resume,
// mark_failed, get_resume_summary) - delivery catch-up, auto-recovery and
// retention are main-process automations now. The remaining surface is the
// approval/stop pair plus queries; export_diagnostics stays for debugging.
export type AgentTaskCommandV141 =
  | { type: "cancel"; taskId: string; generation: number }
  | { type: "respond_input"; taskId: string; requestId: string; generation: number; response: RequestUserInputResponse }
  | { type: "cancel_input"; taskId: string; requestId: string; generation: number }
  | { type: "get_all" }
  | { type: "get_active_input_requests" };   // 支撑 preload getPendingAgentTaskInputRequests
// 1.4.2 (R3) 恢复命令中仅保留 export_diagnostics（诊断导出，排障用途）。
export type AgentTaskRecoveryCommandV142 =
  | { type: "export_diagnostics"; taskId: string };
export type AgentTaskCommandV142 = AgentTaskCommandV141 | AgentTaskRecoveryCommandV142;
// 1.5 (P3): the transcript replay/live channel commands - watch_task /
// unwatch_task register/release a task watcher (idempotent, counting) and
// get_transcript pages the item transcript from disk. They power the task
// center's work-record tab (TaskDetailPanel owns the watcher).
// 1.5 (P4): get_task_log returns the task event log snapshot (raw events +
// file-change history).
export type AgentTaskCommandV15 =
  | AgentTaskCommandV142
  | { type: "watch_task"; taskId: string }
  | { type: "unwatch_task"; taskId: string }
  | { type: "get"; taskId: string }
  | { type: "get_transcript"; taskId: string; itemIndex?: number; cursor?: string; limit?: number; tail?: boolean; before?: string }
  | { type: "get_task_log"; taskId: string };            // P4
export type AgentTaskCommand = AgentTaskCommandV15;

export type AgentTaskEventV141 =
  | { type: "task_state"; task: AgentTaskInfo }
  | { type: "task_input_dismissed"; taskId: string; requestId: string; generation: number; reason: string }
  | { type: "task_activities"; taskId: string; activities: AgentTaskActivity[]; toolUseCount?: number; durationMs?: number }
  | { type: "task_output"; taskId: string; output: string; truncated: boolean };
// 1.4.2 (R2): storage_status / recovery_issue join the renderable event union.
export type AgentTaskEventV142 = AgentTaskEventV141
  | { type: "storage_status"; status: AgentTaskStorageStatus }
  | { type: "recovery_issue"; issue: AgentTaskRecoveryIssue };
// 1.5 (P1): retention auto-deletes terminal task records; the renderer mirror
// converges through this push instead of a command's local side effect.
// 1.5 (P3): task_transcript streams per-item session events for watched tasks.
// 1.5 (P4): task_file_change carries only taskId + change (aggregate/planLink
// are main-only and stripped before they can cross IPC).
export type AgentTaskEventV15 =
  | AgentTaskEventV142
  | { type: "task_removed"; taskId: string }
  | { type: "task_transcript"; taskId: string; itemIndex: number; event: AgentSessionEvent }
  | { type: "task_file_change"; taskId: string; change: FileChangeSummary }; // P4, 仅 watched 任务;不含 aggregate/planLink
export type AgentTaskEvent = AgentTaskEventV15;
// 输入请求只走专用通道 agent-task-input-request；普通 AgentTaskEvent 不重复发送。
// main-only 的 AgentTaskServiceEvent.task_file_change 与本联合同名成员是两份
// 类型;跨 IPC 前必须由 adapters 完成 watched 过滤并剥离 aggregate/planLink。

export interface AgentTaskCommandDataMapV141 {
  cancel: undefined;
  respond_input: undefined; cancel_input: undefined;
  get_all: AgentTaskInfo[];
  get_active_input_requests: AgentTaskInputRequest[];
}
export type AgentTaskCommandDataV141<C extends AgentTaskCommandV141> = AgentTaskCommandDataMapV141[C["type"]];

// 1.4.2 (R2): get_all atomically switches to AgentTaskListSnapshot in shared /
// service / event forwarding at the same stage, so there is never an
// intermediate state where the service returns the new type while IPC still
// declares the old one. (R3) adds the recovery commands and their data shapes;
// AgentTaskCommandData must extend in lockstep with the command union.
export type AgentTaskCommandDataMapV142 = Omit<AgentTaskCommandDataMapV141, "get_all"> & {
  get_all: AgentTaskListSnapshot;
  export_diagnostics: AgentTaskDiagnosticExport;
};
export type AgentTaskCommandDataV142<C extends AgentTaskCommandV142> = AgentTaskCommandDataMapV142[C["type"]];

// 1.5 (P3/P4): the V15 map extends V142 with the task-center commands' payloads
// while every legacy entry keeps its shape (AgentTaskCommandData must extend in
// lockstep with the command union, same rule as the V142 gate).
export type AgentTaskCommandDataMapV15 = AgentTaskCommandDataMapV142 & {
  watch_task: undefined;
  unwatch_task: undefined;
  get: AgentTaskInfo;
  get_transcript: AgentTaskTranscriptPage;
  get_task_log: AgentTaskLogSnapshot;
};
export type AgentTaskCommandDataV15<C extends AgentTaskCommandV15> = AgentTaskCommandDataMapV15[C["type"]];

// ============================================================================
// Re-exports from project-location.ts
// ============================================================================
//
// These types are canonically defined in project-location.ts (a leaf module)
// so GuiSettings can reference ProjectInfo/WslSettings without a circular
// import. They are re-exported here to preserve the existing
// `from "../shared/types"` import paths used across main, preload and renderer.

export type {
  GuiSettings,
  ProjectEnvironment,
  ProjectInfo,
  ProjectLocation,
  ProjectLocationInput,
  WslSettings,
  WslDistroInfo,
  WslDistroListResult,
  ResolveProjectLocationResult,
  ExecutionEnvironmentInfo,
  ThinkingLevel,
  TakeHerEyesSettings,
} from "./project-location.js";

// Plan plain-data types are canonically defined in plan-types.ts (leaf module,
// guards included). Re-exported here so preload/renderer keep the single
// `from "../shared/types"` import path used across the codebase.
export type {
  Plan,
  PlanCancelRef,
  PlanDeviation,
  PlanGenerationFailure,
  PlanGenerationKind,
  PlanGenerationState,
  PlanPlanningModel,
  PlanRevisionState,
  PlanRuntimeSnapshot,
  PlanStatus,
  PlanStep,
  PlanStepFile,
  PlanStepStatus,
  PlanVerificationResult,
  PlanVerificationStatus,
} from "./plan-types.js";

// AgentTask plain-data types are canonically defined in agent-task-types.ts
// (leaf module, guards included). Re-exported here so preload/renderer keep the
// single `from "../shared/types"` import path used across the codebase.
export type {
  AgentTaskActivity,
  AgentTaskDiagnosticExport,
  AgentTaskExecutionMode,
  AgentTaskFailureReason,
  AgentTaskInfo,
  AgentTaskInputRequest,
  AgentTaskListSnapshot,
  AgentTaskLogEvent,
  AgentTaskLogSnapshot,
  AgentTaskPresentation,
  AgentTaskRecoveryIssue,
  AgentTaskRecoveryIssueCode,
  AgentTaskStatus,
  AgentTaskStorageStatus,
  AgentTaskTranscriptPage,
  AgentTaskUsage,
  ResumeDecision,
} from "./agent-task-types.js";

// Workflow plain-data types are canonically defined in workflow-types.ts
// (leaf module, guards included). Re-exported here so preload/renderer keep
// the single `from "../shared/types"` import path used across the codebase.
export type {
  WorkflowCommand,
  WorkflowEvent,
  WorkflowViewState,
} from "./workflow-types.js";

// Git panel plain-data types are canonically defined in git-types.ts (leaf
// module, structural guard included). Re-exported here so preload/renderer
// keep the single `from "../shared/types"` import path used across the
// codebase. The leaf exports a runtime value (isProjectLocationLike), so the
// types and the value are re-exported separately.
export type {
  GitChangedFile,
  GitErrorCode,
  GitUpstreamInfo,
  GitWorkdirCounts,
  GitWorkdirSnapshot,
} from "./git-types.js";
export { isProjectLocationLike } from "./git-types.js";

// Side-question (BTW) plain-data types are canonically defined in
// btw-types.ts (leaf module). Re-exported here so preload/renderer keep the
// single `from "../shared/types"` import path used across the codebase. The
// leaf exports runtime values (BTW_MAX_QUESTION_LENGTH, btwValidateQuestion),
// so the types and the values are re-exported separately.
export type {
  BtwAskResult,
  BtwAskStatus,
} from "./btw-types.js";
export { BTW_MAX_QUESTION_LENGTH, btwValidateQuestion } from "./btw-types.js";
