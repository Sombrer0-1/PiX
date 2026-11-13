import type { ThinkingLevel } from "./project-location.js";
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

export interface ClipboardImage {
  mimeType: string;
  base64: string;
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
  purpose?: "tool_approval" | "project_agent_trust";
}

export interface RequestUserInputResponse {
  id: string;
  answers: Record<string, string>;
  cancelled?: boolean;
}

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

