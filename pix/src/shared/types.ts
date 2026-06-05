/**
 * Shared types between main and renderer processes.
 * These mirror the Pi RPC protocol types.
 */

// ============================================================================
// RPC Command Types (commands sent to pi via stdin)
// ============================================================================

export type RpcCommand =
  // Prompting
  | { id?: string; type: "prompt"; message: string; filePaths?: string[] }
  | { id?: string; type: "steer"; message: string; filePaths?: string[] }
  | { id?: string; type: "follow_up"; message: string; filePaths?: string[] }
  | { id?: string; type: "abort" }
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
  // Settings (full pi settings from SettingsManager)
  | { id?: string; type: "get_pi_settings" }
  | { id?: string; type: "set_pi_setting"; key: string; value: unknown }
  // Resources
  | { id?: string; type: "reload_resources" }
  | { id?: string; type: "get_themes" }
  | { id?: string; type: "get_resource_status" };

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// ============================================================================
// RPC Response Types (received from pi stdout)
// ============================================================================

export interface RpcSessionState {
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  executionMode: "approval" | "unattended";
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
  goal?: ThreadGoal;
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
}

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
  | { type: "goal_update"; goal: ThreadGoal | undefined }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

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
  | { id: string; type: "thinking"; timestamp: number }
  | { id: string; type: "work-status"; tools: ToolWorkItem[]; isStreaming: boolean; timestamp: number }
  | { id: string; type: "turn-separator"; timestamp: number }
  | { id: string; type: "error"; message: string; source?: string; timestamp: number }
  | { id: string; type: "compaction"; reason: string; result: string; aborted: boolean; timestamp: number }
  | { id: string; type: "retry"; success: boolean; attempt: number; maxAttempts: number; delayMs?: number; timestamp: number }
  | { id: string; type: "note"; text: string; timestamp: number }
  | { id: string; type: "status"; status: "running" | "idle" | "error" | "compacting"; timestamp: number };

// ============================================================================
// Project & Session Info Types
// ============================================================================

export interface ProjectInfo {
  path: string;
  name: string;
  lastOpened: number;
  sessionCount: number;
}

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

export interface GuiSettings {
  /** @deprecated No longer needed with direct AgentSession integration */
  piPath?: string;
  theme: "light";
  recentProjects: ProjectInfo[];
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
}

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
    mode?: "approval" | "unattended";
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
