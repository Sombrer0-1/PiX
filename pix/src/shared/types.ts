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
// Team Types (Agent Teams / Swarm)
// ============================================================================

/** Lifecycle status of a team. */
export type TeamLifecycleStatus = "inactive" | "active" | "stopping";

/** Predefined worker agent roles. */
export type TeammateRole = "planner" | "coder" | "reviewer" | "tester" | "researcher";

/** Runtime status of a single teammate agent. */
export type TeammateStatus = "dormant" | "standby" | "idle" | "running" | "error" | "shutdown";

/** How a teammate participates in a team. */
export type TeamMemberMode = "core" | "on_demand";

/** When a teammate should be activated. */
export type TeamActivationPolicy = "always" | "when_needed" | "manual";

/** Identity and runtime state of a teammate, sent to renderer. */
export interface TeammateInfo {
  /** Unique agent ID: "{agentName}::{teamName}" */
  agentId: string;
  /** Short display name (e.g. "planner", "coder", "reviewer") */
  name: string;
  /** Predefined role */
  role: TeammateRole;
  /** Whether this role is a default participant or an on-demand capability. */
  mode?: TeamMemberMode;
  /** Activation policy for this teammate. */
  activationPolicy?: TeamActivationPolicy;
  /** Current runtime status */
  status: TeammateStatus;
  /** Model used by this teammate (inherits leader model if undefined) */
  model?: string;
  /** UI color assigned at creation so same-role teammates stay distinguishable. */
  color?: string;
  /** Extra specialization instructions appended to this teammate's identity prompt. */
  specialization?: string;
  /** Timestamp when this teammate was created */
  createdAt: number;
  /** Last status change timestamp */
  statusChangedAt: number;
  /** Last time the worker was actively executing (started a turn or completed a turn) */
  lastActiveAt?: number;
  /** Current activity description (derived from latest session events) */
  currentActivity?: string;
  /** Error message if status is "error" */
  error?: string;
}

/** Full team state snapshot, sent to renderer on query and on changes. */
export interface TeamState {
  /** Team name */
  name: string;
  /** Lifecycle status */
  status: TeamLifecycleStatus;
  /** Leader agent ID (always "team-lead::{teamName}") */
  leadAgentId: string;
  /** Map of teammate agentId -> info */
  teammates: Record<string, TeammateInfo>;
  /** Timestamp when team was created */
  createdAt: number;
}

/** Persisted team history replayed to the renderer when a team is restored. */
export interface TeamHistory {
  /** Per-worker chat timelines, keyed by agentId. */
  workerMessages: Record<string, TeammateChatMessage[]>;
  /** Pending team bus messages (best-effort; consumed messages are not retained). */
  teamMessages: TeamMessage[];
  /** Full task list. */
  tasks: TeamTask[];
}

/** A single chat message in a worker's message timeline. */
export interface TeammateChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Agent ID of the actual sender (only set for incoming "user" messages). Used for correct persistence attribution. */
  senderAgentId?: string;
}

/** Priority level for messages on the team bus. Lower number = higher priority. */
export type MessageKind =
  | "shutdown"
  | "shutdown_response"
  | "permission_request"
  | "permission_response"
  | "plan_approval"
  | "leader_message"
  | "peer_message"
  | "broadcast"
  | "task_message"
  | "worker_summary"
  | "question"
  | "answer"
  | "proposal"
  | "objection"
  | "decision"
  | "handoff"
  | "review_request"
  | "fix_request"
  | "task_result"
  | "blocked";

// ============================================================================
// Team Task Type System
// ============================================================================

/** Semantic type of a team task, used for role-based auto-assignment. */
export type TeamTaskType = "research" | "plan" | "implement" | "fix" | "review" | "test" | "summarize" | "audit";

// ============================================================================
// Team Protocol Types (Phase 4)
// ============================================================================

/** Per-worker shutdown negotiation state. */
export type ShutdownState = "pending" | "confirmed" | "rejected";

/** A pending shutdown request for a specific worker. */
export interface ShutdownRequest {
  agentId: string;
  state: ShutdownState;
  reason?: string;
  requestedAt: number;
  respondedAt?: number;
}

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

/** A plan approval request from a worker agent. */
export interface PlanApproval {
  id: string;
  teamName: string;
  agentId: string;
  plan: string;
  files: string[];
  status: "pending" | "approved" | "rejected";
  feedback?: string;
  createdAt: number;
  updatedAt: number;
}

/** Role-based permission policy for worker tools. */
export type RolePermissionPolicy = {
  allowedTools: string[];
  deniedTools: string[];
};

// ============================================================================
// Team Roster Types
// ============================================================================

/** Configuration for a single worker slot. */
export interface WorkerConfig {
  role: TeammateRole;
  model?: string;
  customName?: string;
  mode?: TeamMemberMode;
  activationPolicy?: TeamActivationPolicy;
  /** Extra specialization instructions for this teammate's identity prompt. */
  specialization?: string;
}

// ============================================================================
// Team Task Types
// ============================================================================

/** Lifecycle status of a team task. */
export type TeamTaskStatus = "pending" | "assigned" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";

/** Structured completion evidence attached to a task result. */
export interface TeamTaskEvidence {
  /** One or two sentence outcome summary. */
  summary: string;
  /** Files or important paths changed by this task. */
  changedFiles: string[];
  /** Scope items the worker believes are complete. */
  completedScope: string[];
  /** Scope items explicitly not completed or still uncertain. */
  missingScope: string[];
  /** Verification performed, including commands, tests, or manual checks. */
  verification: string[];
  /** Known risks, assumptions, or fragile areas. */
  risks: string[];
  /** Suggested follow-up work. */
  followUps: string[];
  /** Worker confidence in the completion claim. */
  confidence?: "low" | "medium" | "high";
}

/** Context bundle injected when a worker starts a task. */
export interface TeamTaskContextPack {
  taskId: string;
  generatedAt: number;
  objective: string;
  assignedScope: string;
  dependencyEvidence: Array<{
    taskId: string;
    subject: string;
    result?: string;
    evidence?: TeamTaskEvidence;
  }>;
  parentEvidence?: {
    taskId: string;
    subject: string;
    result?: string;
    evidence?: TeamTaskEvidence;
  };
  relevantRisks: string[];
  touchedFiles: string[];
  openQuestions: string[];
  /** Role-specific coordination hints generated by the team runtime. */
  coordinationHints?: string[];
}

/** Stable task handoff packet produced when a worker completes a task. */
export interface TeamTaskHandoffPacket {
  taskId: string;
  createdAt: number;
  workerAgentId?: string;
  summary: string;
  evidence: TeamTaskEvidence;
  contextPack?: TeamTaskContextPack;
}

/** Explicit reliability gate state for task orchestration. */
export interface TeamTaskGateState {
  gate: "implementation" | "review" | "fix" | "verification" | "summary" | "none";
  status: "waiting" | "active" | "passed" | "issues" | "blocked";
  parentTaskId?: string;
  reason?: string;
  updatedAt: number;
}

/** Potential file ownership conflict between concurrent team tasks. */
export interface TeamTaskFileConflict {
  withTaskId: string;
  withSubject: string;
  files: string[];
  severity: "info" | "warning";
  reason: string;
}

/** A shared task in the team task list. */
export interface TeamTask {
  /** Unique task identifier (UUID). */
  id: string;
  /** Team this task belongs to. */
  teamName: string;
  /** Short title / subject. */
  subject: string;
  /** Detailed description of what needs to be done. */
  description: string;
  /** Semantic task type for role-based auto-assignment. */
  taskType?: TeamTaskType;
  /** Current lifecycle status. */
  status: TeamTaskStatus;
  /** Agent ID of the worker who claimed this task (undefined if unclaimed). */
  ownerAgentId?: string;
  /** IDs of tasks that must be completed before this one can be claimed. */
  blockedBy: string[];
  /** IDs of tasks that are blocked by this one. */
  blocks: string[];
  /** Result summary provided by the worker upon completion. */
  result?: string;
  /** Structured evidence ledger captured with the completion result. */
  evidence?: TeamTaskEvidence;
  /** Model-visible context pack used when this task was claimed. */
  contextPack?: TeamTaskContextPack;
  /** Stable handoff packet produced at completion. */
  handoff?: TeamTaskHandoffPacket;
  /** Explicit reliability gate state for orchestration. */
  gateState?: TeamTaskGateState;
  /** Potential file conflicts with concurrent tasks. */
  fileConflicts?: TeamTaskFileConflict[];
  /** Timestamp when the task was created. */
  createdAt: number;
  /** Timestamp of the last status change. */
  updatedAt: number;
  /** Optional metadata (e.g. priority, tags). */
  metadata?: Record<string, unknown>;
}

/** A rich message flowing through the team message bus. */
export interface TeamMessage {
  id: string;
  teamName: string;
  fromAgentId: string;
  toAgentId: string;        // specific agentId or "*" for broadcast
  text: string;
  timestamp: number;
  read: boolean;
  delivered: boolean;
  summary: string;          // short description for UI timeline
  kind: MessageKind;
  fromRole: TeammateRole | "leader";
}

/** Events pushed from main to renderer for team state changes. */
export type TeamEvent =
  | { type: "team_created"; team: TeamState }
  | { type: "team_deleted"; teamName: string }
  | { type: "team_state_changed"; team: TeamState }
  | { type: "teammate_status_changed"; teamName: string; agentId: string; status: TeammateStatus; error?: string; timestamp?: number }
  | { type: "teammate_event"; teamName: string; agentId: string; event: AgentSessionEvent }
  | { type: "teammate_message"; teamName: string; agentId: string; message: TeammateChatMessage }
  | { type: "team_message"; teamName: string; message: TeamMessage }
  | { type: "task_created"; teamName: string; task: TeamTask }
  | { type: "task_updated"; teamName: string; task: TeamTask }
  | { type: "task_deleted"; teamName: string; taskId: string }
  | { type: "protocol_permission_request"; teamName: string; request: PermissionRequest }
  | { type: "protocol_permission_response"; teamName: string; requestId: string; approved: boolean; reason?: string }
  | { type: "protocol_plan_approval"; teamName: string; approval: PlanApproval }
  | { type: "protocol_plan_response"; teamName: string; approvalId: string; approved: boolean; feedback?: string }
  | { type: "protocol_shutdown_request"; teamName: string; agentId: string }
  | { type: "protocol_shutdown_response"; teamName: string; agentId: string; confirmed: boolean; reason?: string }
  | { type: "worker_summary"; teamName: string; fromAgentId: string; summary: string; taskId?: string };

/** Commands sent from renderer to main for team operations. */
export type TeamCommand =
  | { type: "create_team"; teamName?: string }
  | { type: "get_team_state" }
  | { type: "get_team_history" }
  | { type: "stop_team" }
  | { type: "send_message"; agentId: string; message: string }
  | { type: "abort_worker"; agentId: string }
  | { type: "activate_member"; agentId: string }
  | { type: "pause_member"; agentId: string }
  | { type: "create_task"; subject: string; description: string; assignTo?: string; blockedBy?: string[]; taskType?: TeamTaskType }
  | { type: "delete_task"; taskId: string }
  | { type: "request_shutdown"; agentId?: string }
  | { type: "respond_permission"; requestId: string; approved: boolean; reason?: string }
  | { type: "respond_plan_approval"; approvalId: string; approved: boolean; feedback?: string }
  | { type: "restart_worker"; agentId: string };

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
