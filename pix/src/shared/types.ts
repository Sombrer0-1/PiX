import type {
  AgentMessage,
  ApiErrorCategory,
  ClipboardImage,
  DiffSummary,
  FileChangeSummary,
  RequestUserInputResponse,
  ThreadGoal,
} from "@earendil-works/pix-runtime/shared/types";
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
import type { CustomApi, CustomProviderConfig } from "./custom-providers.js";
// ============================================================================
// RPC Command Types (commands sent to pi via stdin)
// ============================================================================

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
  // Probe an OpenAI-compatible {baseUrl}/models listing for import candidates.
  // apiKey is the form's current input (plaintext); providerName asks main to
  // fall back to the stored key (auth.json first, then models.json) when the
  // form carries none -- the renderer only ever sees the SENTINEL mask.
  | {
      id?: string;
      type: "fetch_provider_models";
      baseUrl: string;
      api: CustomApi;
      apiKey?: string;
      providerName?: string;
    }
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

/**
 * Why the main process revoked an already-displayed user input request.
 * "session_backgrounded" (Stage B) only clears the renderer card when a busy
 * session is detached into the background; the bridge-side entry stays
 * suspended and is re-sent on re-attach.
 */
export type RequestUserInputDismissalReason = "aborted" | "session_closed" | "session_backgrounded";

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
// Background Live Sessions (Stage B: solo bridge session parallelism)
// ============================================================================

/** Liveness badge of one backgrounded busy session (the active session is never listed). */
export interface LiveSessionInfo {
  /** Session JSONL physical path (matches SessionInfo.path). */
  path: string;
  state: "running" | "waiting_input";
  pendingCount: number;
}

/**
 * Full snapshot of the backgrounded live sessions, pushed on the dedicated
 * pi-sessions-state channel at detach/attach/state-change/finalize (Stage B D7).
 */
export type SessionsStatePayload = { sessions: LiveSessionInfo[] };

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
} from "@earendil-works/pix-runtime/shared/plan-types";

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
} from "@earendil-works/pix-runtime/shared/agent-task-types";

// Workflow plain-data types are canonically defined in workflow-types.ts
// (leaf module, guards included). Re-exported here so preload/renderer keep
// the single `from "../shared/types"` import path used across the codebase.
export type {
  WorkflowCommand,
  WorkflowEvent,
  WorkflowViewState,
} from "@earendil-works/pix-runtime/shared/workflow-types";

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

export type {
  AgentMessage,
  AgentSessionEvent,
  AgentTaskCommand,
  AgentTaskCommandDataMapV141,
  AgentTaskCommandDataMapV142,
  AgentTaskCommandDataMapV15,
  AgentTaskCommandDataV141,
  AgentTaskCommandDataV142,
  AgentTaskCommandDataV15,
  AgentTaskCommandV141,
  AgentTaskCommandV142,
  AgentTaskCommandV15,
  AgentTaskEvent,
  AgentTaskEventV141,
  AgentTaskEventV142,
  AgentTaskEventV15,
  AgentTaskRecoveryCommandV142,
  ApiErrorCategory,
  ClipboardImage,
  DiffSummary,
  FileChangeSummary,
  PixCommandResult,
  PlanCommand,
  PlanEvent,
  RequestUserInputOption,
  RequestUserInputQuestion,
  RequestUserInputRequest,
  RequestUserInputResponse,
  ThreadGoal,
  ThreadGoalStatus,
  TurnDiffSummary,
} from "@earendil-works/pix-runtime/shared/types";
