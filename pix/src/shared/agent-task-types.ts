/**
 * Versioned, plain-data contract for app-level agent tasks (design plan
 * section 4.4). Shared by main (AgentTaskService, AgentTaskRuntime, the SDK
 * `agent` tool, SessionBridge), renderer (task panel store) and the parent
 * transcript (replay), so this module is a runtime leaf: the only imports are
 * type-only (SubagentSingleResult, RequestUserInputRequest, ThinkingLevel,
 * ProjectLocation), every value here survives structuredClone / JSON
 * round-trips and the renderer can import it directly.
 *
 * 1.4.2 R2 version gates (documented here; enforced by the code shape):
 * - AgentTaskStatus DOES include "interrupted" (queued/running/waiting_input ->
 *   interrupted; interrupted -> [queued,failed,cancelled]).
 * - AgentTaskInfo DOES carry the 1.4.2 recovery fields (lastCheckpointSeq,
 *   hasUnclosedToolCall, stopReason), all optional.
 * - AgentTaskFailureReason IS extended with "storage_limit"/"user_decision".
 * - AgentTaskRecoveryIssueCode is declared (1.4.2 R1, for the store diagnostics
 *   and the R2 recovery issues); AgentTaskStorageStatus, AgentTaskRecoveryIssue
 *   and AgentTaskListSnapshot ARE declared (R2); ResumeDecision,
 *   AgentTaskResumeSummary, AgentTaskDiagnosticExport and AgentTaskClearAllResult
 *   ARE declared (R3, the recovery-command plain-data contract).
 *
 * Producer/consumer semantics (documented here; enforced by the guard where
 * observable):
 * - generation is a non-negative integer, 0 at creation, +1 per successful
 *   resume prepare (1.4.1 only ever creates 0; resumption arrives in 1.4.2).
 * - queuePosition is only legal while queued; running/waiting_input must have
 *   startedAt; completed/failed/cancelled clear autoBackground/queuePosition
 *   and must have endedAt.
 * - activities.length <= AGENT_TASK_MAX_ACTIVITIES and finalOutput stays
 *   within AGENT_TASK_MAX_FINAL_OUTPUT_BYTES (UTF-8); truncation sets
 *   outputTruncated and keeps originalOutputBytes.
 * - planLinkState is "none" exactly when planLink is absent; with a link it
 *   starts "pending" and can only become "consumed" or "released" through
 *   idempotent confirmation (the two never convert into each other).
 * - presentation changes never change status.
 * The guard owns these observable invariants; status transitions and group
 * consistency are owned by AgentTaskService.
 */

import type { SubagentSingleResult } from "./subagent-types.js";
import type { ProjectLocation, ThinkingLevel } from "./project-location.js";
import type { RequestUserInputRequest } from "./types.js";

export const AGENT_TASK_SCHEMA_VERSION = 1 as const;
/** Default concurrent running slots (running + waiting_input) when unset. */
export const AGENT_TASK_DEFAULT_RUNNING_SLOTS = 4;
/** Absolute ceiling for the user-configurable concurrent-slot setting. */
export const AGENT_TASK_MAX_RUNNING_SLOTS = 8;
export const AGENT_TASK_MAX_ACTIVITIES = 20;
export const AGENT_TASK_MAX_FINAL_OUTPUT_BYTES = 48 * 1024;
/** Recent-activity window cap for renderer/replay snapshots (same value as the hard cap). */
export const AGENT_TASK_MAX_RECENT_ACTIVITIES = 20;
/** Off by default: foreground agent tools wait for the result. */
export const DEFAULT_AUTO_BACKGROUND_MS = 0;
/**
 * Loose default nested-session turn cap when the agent definition omits
 * `maxTurns`. Built-in `general-purpose` uses the same number; YAML ceiling
 * is `MAX_AGENT_TURNS` in coding-agent (higher, so custom agents can raise it).
 */
export const DEFAULT_MAX_TURNS = 150;

/** True when `value` is an integer in [1, AGENT_TASK_MAX_RUNNING_SLOTS]. */
export function isAgentTaskRunningSlots(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= 1 && value <= AGENT_TASK_MAX_RUNNING_SLOTS;
}

/**
 * Settings sanitizer: keep a legal slot count, otherwise drop to undefined
 * so an absent/invalid payload does not overwrite a stored value.
 */
export function parseAgentTaskMaxConcurrent(value: unknown): number | undefined {
  return isAgentTaskRunningSlots(value) ? value : undefined;
}

/**
 * Runtime clamp: legal integers stay in [1, MAX]; anything else becomes DEFAULT.
 */
export function clampAgentTaskRunningSlots(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value < 1) return 1;
    if (value > AGENT_TASK_MAX_RUNNING_SLOTS) return AGENT_TASK_MAX_RUNNING_SLOTS;
    return value;
  }
  return AGENT_TASK_DEFAULT_RUNNING_SLOTS;
}

export type AgentTaskExecutionMode = "approval" | "unattended" | "read-only";
export type AgentTaskStatus =
  | "queued" | "running" | "waiting_input"
  | "completed" | "failed" | "cancelled"
  | "interrupted";  // 1.4.2 (R2): restart hydration of any pre-exit non-terminal state
export type AgentTaskPresentation = "foreground" | "background";
export type AgentTaskStopReason = "user_cancel" | "app_shutdown"; // 1.4.1 区分，供 1.4.2 判定
export type AgentTaskFailureReasonV141 =
  | "invalid_parameters" | "max_turns" | "api_error" | "model_unavailable" | "model_not_found" | "model_ambiguous" | "model_auth_unavailable"
  | "unknown_agent" | "tool_unavailable" | "project_agent_denied" | "prompt_too_large"
  | "session_start_failed" | "internal_error";
// 1.4.2 (R2): storage_limit (runtime budget exhaustion) / user_decision (R3 mark_failed).
// 1.5 (P1): resume_blocked - the restart auto-recovery pass could not resume an
// interrupted task (workspace changed / transcript corrupt / model unavailable);
// the task converges to failed instead of waiting for a user decision.
export type AgentTaskFailureReason = AgentTaskFailureReasonV141 | "storage_limit" | "user_decision" | "resume_blocked";

export interface AgentTaskActivity { sequence: number; toolCallId: string; toolName: string; status: "running"|"completed"|"failed"; summary?: string; startedAt: number; endedAt?: number; }
export interface AgentTaskUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number; turns: number; }

export interface AgentTaskPlanLink { planId: string; version: number; stepId: string; }
export type AgentTaskPlanLinkState = "none" | "pending" | "consumed" | "released";
export interface AgentDefinitionSnapshot {
  name: string; description: string; systemPrompt: string;
  tools?: string[]; disallowedTools?: string[]; maxTurns?: number; color?: string;
  source: "user" | "project" | "built-in"; filePath?: string; baseDir?: string;
}
export interface AgentTaskModelSnapshot { provider: string; modelId: string; }
export type AgentTaskAgentScope = "user" | "project" | "both";
export type AgentTaskItemSpec =
  | {
      resolution: "ready";
      index: number;
      prompt: string;
      description: string;
      agent: AgentDefinitionSnapshot;
      model: AgentTaskModelSnapshot;
      maxTurns: number;
      /** workflow schema children only: must already be a subset-legal ObjectJsonSchema (the service does no subset gate). Absent is legal. */
      outputSchema?: unknown;
      /** workflow children only: extra system-prompt suffix (artifacts). Absent is legal. Persist-on-spec so resume reads it. */
      appendSystemPrompt?: string;
    }
  | { resolution: "rejected"; index: number; prompt: string; description: string; requestedAgentName?: string; failureReason: AgentTaskFailureReason; errorMessage: string };
export interface AgentTaskItemSummary {
  index: number; agentName: string; agentSource: "user"|"project"|"built-in"|"unknown";
  model?: AgentTaskModelSnapshot; // 当前有效模型；R3 成功 prepare 切换后更新，冻结 spec 仍保留创建时模型
  maxTurns?: number;
}

/** 创建返回前冻结；之后不得读取父 SessionBridge generation 的可变对象。 */
export interface AgentTaskSpec {
  schemaVersion: typeof AGENT_TASK_SCHEMA_VERSION;
  taskId: string; groupId: string;
  groupMode: "single" | "parallel" | "chain"; // 原 agent tool 模式；所有同 group spec 一致，供恢复 handle/order
  mode: "single" | "chain";              // runtime 粒度；parallel 被拆为多个 mode=single spec
  items: AgentTaskItemSpec[];               // single=1；chain=按原顺序，可各自使用不同 agent/model
  agentScope: AgentTaskAgentScope;
  thinkingLevel: ThinkingLevel;
  executionMode: AgentTaskExecutionMode;
  verificationGate: boolean;
  project: ProjectLocation;
  workspaceId: string;
  agentDir: string;
  parentSessionId: string;
  parentToolCallId: string;
  planLink?: AgentTaskPlanLink;
  createdAt: number;
}

export interface AgentTaskInfo {
  schemaVersion: typeof AGENT_TASK_SCHEMA_VERSION;
  taskId: string;
  groupId: string;
  groupMode: "single" | "parallel" | "chain";
  workspaceId: string;
  parentSessionId: string;
  parentToolCallId: string;
  itemSummaries: AgentTaskItemSummary[];
  thinkingLevel: ThinkingLevel;
  executionMode: AgentTaskExecutionMode;
  project: ProjectLocation;
  presentation: AgentTaskPresentation;
  status: AgentTaskStatus;
  queuePosition?: number;
  autoBackground?: { deadlineAt: number; warningAt: number; warningActive: boolean }; // 仅仍附着的前台 group；取消本次计时/后台化/终态后清除
  failureReason?: AgentTaskFailureReason;
  errorMessage?: string;
  description: string;
  finalOutput: string;
  outputTruncated: boolean;
  originalOutputBytes: number;
  results: SubagentSingleResult[];       // 按 spec.items 顺序；用于无损重建前台 SubagentDetails
  activities: AgentTaskActivity[];
  usage: AgentTaskUsage;
  toolUseCount: number;
  createdAt: number; startedAt?: number; updatedAt: number; endedAt?: number; durationMs: number;
  planLink?: AgentTaskPlanLink;
  deliveredSessionIds: string[];
  planLinkState: AgentTaskPlanLinkState;
  generation: number;                    // 续接竞态保护
  // 1.4.2 (R2) recovery fields
  lastCheckpointSeq?: number;
  hasUnclosedToolCall?: boolean;
  stopReason?: AgentTaskStopReason;
  // 1.5 (P2): workflow children only - the workflow-owned group flag, assigned
  // from GroupEntry.workflowOwned at creation and read back from the persisted
  // TaskIndexEntry at hydration (P1 already persisted it there); the task center
  // renders the workflow badge and hides the stop button for these tasks.
  workflowOwned?: boolean;
}

/** 跨 tool result/main/renderer 的 plain-data handle；不得放入 main-only service 文件。 */
export interface AgentTaskHandle {
  kind: "agent_task";
  taskId: string;
  generation: number;
  status: AgentTaskStatus;
  description: string;
  presentation: AgentTaskPresentation;
}
export interface AgentTaskGroupHandle {
  kind: "agent_task_group";
  groupId: string;
  mode: "single" | "parallel" | "chain";
  tasks: AgentTaskHandle[];
}

export interface AgentTaskInputRequest {
  taskId: string;
  requestId: string;
  generation: number;
  request: RequestUserInputRequest;      // 复用 shared types
}

/** 1.4.2 R1 加入，供 store 诊断与 R2 recovery issue 共用。 */
export type AgentTaskRecoveryIssueCode = "tail_corrupt" | "mid_log_corrupt" | "session_header_corrupt" | "index_corrupt" | "unknown_schema" | "migration_failed";

/**
 * 1.4.2 (R2): per-workspace storage accounting surfaced to the task panel
 * (PRD C5). "warning" once committed bytes (used + reserved) reach 80% of the
 * limit, "full" once they reach it.
 */
export interface AgentTaskStorageStatus {
  workspaceId: string;
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
  level: "ok" | "warning" | "full";
}

/**
 * 1.4.2 (R2): a task whose on-disk record could not be fully restored. This is
 * NOT a forged AgentTaskInfo/status - the task is read-only until cleared.
 * generation takes the last readable index/checkpoint generation; 0 when
 * neither is readable.
 */
export interface AgentTaskRecoveryIssue {
  taskId: string;
  workspaceId: string;
  generation: number;
  code: AgentTaskRecoveryIssueCode;
  message: string;
  recoverable: boolean;
  readOnly: boolean;
  updatedAt?: number;
}

/** 1.4.2 (R2): the get_all full-remount snapshot after restoreAll(). */
export interface AgentTaskListSnapshot {
  tasks: AgentTaskInfo[];
  recoveryIssues: AgentTaskRecoveryIssue[];
  storageStatuses: AgentTaskStorageStatus[];
}

/** 以下 plain-data IPC 契约由 1.4.2 (R3) 加入（设计计划 §4.4）。 */
export type ResumeDecision =
  | { action: "continue"; confirmWorkspaceChanges: boolean }
  | { action: "switch_model"; provider: string; modelId: string; confirmWorkspaceChanges: boolean };
export interface AgentTaskDiagnosticExport { fileName: string; content: string; }

/**
 * get_transcript 的分页返回。entries 为该 item 的 session JSONL 条目
 * (SessionEntry 的结构化克隆形态;含 type==="message" 与 type==="custom_message"
 * 且 display!==false 的条目,不含文件头 type==="session" 行)。totalCount 为该
 * item 文件内成功解析的条目总数(仅计返回集合口径);nextCursor 为 null 表示该
 * item 已到尾。坏行跳过不计入。
 */
export interface AgentTaskTranscriptPage {
  taskId: string;
  itemIndex: number;
  entries: unknown[];
  totalCount: number;
  nextCursor: string | null;
  /** Byte offset of the first returned entry; used to page backward from a tail load. */
  prevCursor?: string | null;
}

/** get_task_log 的单条事件(旧字段 seq/ts/type + payload 平铺)。 */
export interface AgentTaskLogEvent {
  seq: number;
  ts: number;
  type: string;
  [key: string]: unknown;
}

/**
 * get_task_log 返回:任务事件日志(events.jsonl)的只读快照。
 * 超过 MAX_TASK_LOG_EVENTS(10000)条时保留最新 10000 条并置 truncated=true。
 */
export interface AgentTaskLogSnapshot {
  taskId: string;
  events: AgentTaskLogEvent[];
  truncated: boolean;
}

export const AGENT_TASK_TRANSITIONS: Record<AgentTaskStatus, readonly AgentTaskStatus[]> = {
  queued: ["running", "cancelled", "interrupted"],
  running: ["waiting_input", "completed", "failed", "cancelled", "interrupted"],
  waiting_input: ["running", "failed", "cancelled", "interrupted"],
  completed: [], failed: [], cancelled: [],
  // 1.4.2 (R2): interrupted (restart hydration) -> [queued,failed,cancelled]; queued is the
  // post-resume path (R3), failed/cancelled the explicit user decisions.
  interrupted: ["queued", "failed", "cancelled"],
};

// ============================================================================
// Guard helpers
// ============================================================================

// Runtime enum tables are the guard's single source for one-of checks; they
// mirror the exported unions above (1.4.2 R2 scope: "interrupted" +
// "storage_limit"/"user_decision").
const AGENT_TASK_EXECUTION_MODES = ["approval", "unattended", "read-only"] as const;
const AGENT_TASK_STATUSES = ["queued", "running", "waiting_input", "completed", "failed", "cancelled", "interrupted"] as const;
const AGENT_TASK_PRESENTATIONS = ["foreground", "background"] as const;
const AGENT_TASK_GROUP_MODES = ["single", "parallel", "chain"] as const;
const AGENT_TASK_AGENT_SOURCES = ["user", "project", "built-in", "unknown"] as const;
const AGENT_TASK_ACTIVITY_STATUSES = ["running", "completed", "failed"] as const;
const AGENT_TASK_PLAN_LINK_STATES = ["none", "pending", "consumed", "released"] as const;
const AGENT_TASK_STOP_REASONS = ["user_cancel", "app_shutdown"] as const;
const AGENT_TASK_FAILURE_REASONS = [
  "invalid_parameters", "max_turns", "api_error", "model_unavailable", "model_not_found",
  "model_ambiguous", "model_auth_unavailable", "unknown_agent", "tool_unavailable",
  "project_agent_denied", "prompt_too_large", "session_start_failed", "internal_error",
  "storage_limit", "user_decision", "resume_blocked",
] as const;
// Mirrors the subagent contract's own statuses/usage shape for stored results;
// kept local so agent-task-types.ts stays a runtime leaf.
const SUBAGENT_STATUSES = ["queued", "running", "completed", "failed", "aborted"] as const;
// Mirrors ThinkingLevel in project-location.ts; kept local so the guard can
// check it without a runtime import.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isAgentTaskUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { input, output, cacheRead, cacheWrite, totalTokens, cost, turns } = value;
  if (!isFiniteNonNegative(input) || !isFiniteNonNegative(output)) return false;
  if (!isFiniteNonNegative(cacheRead) || !isFiniteNonNegative(cacheWrite)) return false;
  if (!isFiniteNonNegative(totalTokens) || !isFiniteNonNegative(cost) || !isFiniteNonNegative(turns)) {
    return false;
  }
  return totalTokens === input + output + cacheRead + cacheWrite;
}

function isAgentTaskActivity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { sequence, toolCallId, toolName, status, summary, startedAt, endedAt } = value;
  if (!isFiniteNonNegative(sequence)) return false;
  if (typeof toolCallId !== "string" || typeof toolName !== "string") return false;
  if (!isOneOf(status, AGENT_TASK_ACTIVITY_STATUSES)) return false;
  if (summary !== undefined && typeof summary !== "string") return false;
  if (!isFiniteNonNegative(startedAt)) return false;
  if (endedAt !== undefined && !isFiniteNonNegative(endedAt)) return false;
  // running activities have no endedAt; completed/failed must have endedAt.
  if (status === "running") {
    return endedAt === undefined;
  }
  return endedAt !== undefined;
}

function isAgentTaskItemSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isFiniteNonNegative(value.index)) return false;
  if (typeof value.agentName !== "string") return false;
  if (!isOneOf(value.agentSource, AGENT_TASK_AGENT_SOURCES)) return false;
  if (value.model !== undefined) {
    if (!isRecord(value.model)) return false;
    if (typeof value.model.provider !== "string" || typeof value.model.modelId !== "string") return false;
  }
  if (value.maxTurns !== undefined && !isFiniteNonNegative(value.maxTurns)) return false;
  return true;
}

function isProjectLocation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.path !== "string" || typeof value.physicalPath !== "string") return false;
  if (typeof value.name !== "string") return false;
  if (!isRecord(value.environment)) return false;
  if (value.environment.kind === "windows") return true;
  if (value.environment.kind === "wsl") return typeof value.environment.distro === "string";
  return false;
}

function isAgentTaskPlanLink(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.planId === "string" &&
    isFiniteNonNegative(value.version) &&
    typeof value.stepId === "string"
  );
}

function isAutoBackground(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isFiniteNonNegative(value.deadlineAt) || !isFiniteNonNegative(value.warningAt)) return false;
  if (typeof value.warningActive !== "boolean") return false;
  // The warning always precedes the auto-background deadline.
  return value.warningAt < value.deadlineAt;
}

/**
 * Light structural check for a stored SubagentSingleResult. Deep per-result
 * validation (status invariants, error/abort reasons, per-field caps) stays in
 * subagent-types.ts, whose guard is the single source for the subagent
 * contract; the service only stores results that already passed it.
 */
function isStoredSubagentResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    isFiniteNonNegative(value.index) &&
    typeof value.agentName === "string" &&
    isOneOf(value.agentSource, AGENT_TASK_AGENT_SOURCES) &&
    isOneOf(value.status, SUBAGENT_STATUSES) &&
    typeof value.description === "string" &&
    typeof value.finalOutput === "string" &&
    typeof value.outputTruncated === "boolean" &&
    isFiniteNonNegative(value.originalOutputBytes) &&
    isFiniteNonNegative(value.toolUseCount) &&
    isAgentTaskUsage(value.usage) &&
    Array.isArray(value.activities) &&
    value.activities.length <= AGENT_TASK_MAX_RECENT_ACTIVITIES &&
    value.activities.every(isAgentTaskActivity) &&
    isFiniteNonNegative(value.durationMs)
  );
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Non-throwing structural narrowing of an unknown value into AgentTaskInfo.
 * Validates schemaVersion, enums, required fields, finite non-negative counts
 * and timestamps, generation (non-negative integer) and the observable
 * invariants: queuePosition only while queued, startedAt for
 * running/waiting_input, endedAt plus cleared autoBackground/queuePosition for
 * terminal states, activities cap, finalOutput byte cap with truncation book-
 * keeping, usage totalTokens consistency and planLink/planLinkState
 * consistency. Status transitions and group consistency are AgentTaskService
 * semantics, not checked here.
 */
export function isAgentTaskInfo(v: unknown): v is AgentTaskInfo {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== AGENT_TASK_SCHEMA_VERSION) return false;
  if (typeof v.taskId !== "string" || typeof v.groupId !== "string") return false;
  if (!isOneOf(v.groupMode, AGENT_TASK_GROUP_MODES)) return false;
  if (typeof v.workspaceId !== "string") return false;
  if (typeof v.parentSessionId !== "string" || typeof v.parentToolCallId !== "string") return false;
  if (!Array.isArray(v.itemSummaries) || !v.itemSummaries.every(isAgentTaskItemSummary)) return false;
  if (!isOneOf(v.thinkingLevel, THINKING_LEVELS)) return false;
  if (!isOneOf(v.executionMode, AGENT_TASK_EXECUTION_MODES)) return false;
  if (!isProjectLocation(v.project)) return false;
  if (!isOneOf(v.presentation, AGENT_TASK_PRESENTATIONS)) return false;
  if (!isOneOf(v.status, AGENT_TASK_STATUSES)) return false;

  // queuePosition is only legal while queued; terminal states and the 1.4.2
  // interrupted pre-shutdown snapshots clear it and autoBackground.
  // autoBackground is checked for shape only on other states (where it is legal).
  if (v.queuePosition !== undefined && (v.status !== "queued" || !isFiniteNonNegative(v.queuePosition))) {
    return false;
  }
  if (v.status === "completed" || v.status === "failed" || v.status === "cancelled" || v.status === "interrupted") {
    if (v.autoBackground !== undefined || v.queuePosition !== undefined) return false;
  } else if (v.autoBackground !== undefined && !isAutoBackground(v.autoBackground)) {
    return false;
  }

  // failureReason is the failed-state classifier; other states never carry it.
  if (v.failureReason !== undefined) {
    if (v.status !== "failed" || !isOneOf(v.failureReason, AGENT_TASK_FAILURE_REASONS)) return false;
  } else if (v.status === "failed") {
    return false;
  }
  if (v.errorMessage !== undefined && typeof v.errorMessage !== "string") return false;
  if (typeof v.description !== "string") return false;

  if (typeof v.finalOutput !== "string") return false;
  if (utf8ByteLength(v.finalOutput) > AGENT_TASK_MAX_FINAL_OUTPUT_BYTES) return false;
  if (typeof v.outputTruncated !== "boolean") return false;
  if (!isFiniteNonNegative(v.originalOutputBytes)) return false;
  // Truncated output must keep the pre-truncation byte size.
  if (v.outputTruncated && v.originalOutputBytes <= utf8ByteLength(v.finalOutput)) return false;

  if (!Array.isArray(v.results) || !v.results.every(isStoredSubagentResult)) return false;
  if (!Array.isArray(v.activities) || v.activities.length > AGENT_TASK_MAX_ACTIVITIES) return false;
  if (!v.activities.every(isAgentTaskActivity)) return false;
  if (!isAgentTaskUsage(v.usage)) return false;
  if (!isFiniteNonNegative(v.toolUseCount)) return false;
  if (!isFiniteNonNegative(v.createdAt) || !isFiniteNonNegative(v.updatedAt)) return false;
  if (!isFiniteNonNegative(v.durationMs)) return false;
  if (v.startedAt !== undefined && !isFiniteNonNegative(v.startedAt)) return false;
  if (v.endedAt !== undefined && !isFiniteNonNegative(v.endedAt)) return false;
  // running/waiting_input must have startedAt; terminal states must have
  // endedAt. interrupted (1.4.2 restart hydration) needs neither.
  if ((v.status === "running" || v.status === "waiting_input") && v.startedAt === undefined) return false;
  if (v.status === "completed" || v.status === "failed" || v.status === "cancelled") {
    if (v.endedAt === undefined) return false;
  }
  if (v.startedAt !== undefined && v.endedAt !== undefined && v.endedAt < v.startedAt) return false;

  // 1.4.2 recovery fields (all optional): lastCheckpointSeq is a non-negative
  // integer, hasUnclosedToolCall a boolean, stopReason one of the enum.
  if (v.lastCheckpointSeq !== undefined) {
    if (typeof v.lastCheckpointSeq !== "number" || !Number.isInteger(v.lastCheckpointSeq) || v.lastCheckpointSeq < 0) {
      return false;
    }
  }
  if (v.hasUnclosedToolCall !== undefined && typeof v.hasUnclosedToolCall !== "boolean") return false;
  if (v.stopReason !== undefined && !isOneOf(v.stopReason, AGENT_TASK_STOP_REASONS)) return false;
  // 1.5 (P2): workflowOwned is optional; when present it must be a boolean
  // (records persisted before the field existed stay acceptable).
  if (v.workflowOwned !== undefined && typeof v.workflowOwned !== "boolean") return false;

  if (v.planLink !== undefined && !isAgentTaskPlanLink(v.planLink)) return false;
  // planLinkState is "none" exactly when no link is attached; with a link it
  // is pending/consumed/released (never "none").
  if (v.planLink === undefined) {
    if (v.planLinkState !== "none") return false;
  } else if (!isOneOf(v.planLinkState, AGENT_TASK_PLAN_LINK_STATES) || v.planLinkState === "none") {
    return false;
  }

  if (!Array.isArray(v.deliveredSessionIds) || !v.deliveredSessionIds.every((s) => typeof s === "string")) {
    return false;
  }
  // generation is a non-negative integer (0 at creation; +1 per successful
  // resume prepare in 1.4.2).
  if (typeof v.generation !== "number" || !Number.isInteger(v.generation) || v.generation < 0) {
    return false;
  }
  return true;
}

/**
 * Non-throwing structural narrowing of an unknown value into one item spec
 * entry (the frozen preflight unit carried by AgentTaskSpec.items). Checks the
 * ready/rejected variant discriminants, the frozen agent/model snapshots and
 * the optional workflow outputSchema (absent is legal; present must be a plain
 * object — subset-legal ObjectJsonSchema shape is the worker's gate, not
 * checked here) and the optional appendSystemPrompt (absent is legal; present
 * must be a string). Unknown fields are ignored so old snapshots restore.
 */
export function isAgentTaskItemSpec(value: unknown): value is AgentTaskItemSpec {
  if (!isRecord(value)) return false;
  if (!isFiniteNonNegative(value.index)) return false;
  if (typeof value.prompt !== "string" || typeof value.description !== "string") return false;
  if (value.resolution === "rejected") {
    if (value.requestedAgentName !== undefined && typeof value.requestedAgentName !== "string") return false;
    if (!isOneOf(value.failureReason, AGENT_TASK_FAILURE_REASONS)) return false;
    return typeof value.errorMessage === "string";
  }
  if (value.resolution !== "ready") return false;
  const agent = value.agent;
  if (!isRecord(agent)) return false;
  if (typeof agent.name !== "string" || typeof agent.description !== "string") return false;
  if (typeof agent.systemPrompt !== "string") return false;
  if (!isOneOf(agent.source, AGENT_TASK_AGENT_SOURCES)) return false;
  const model = value.model;
  if (!isRecord(model) || typeof model.provider !== "string" || typeof model.modelId !== "string") return false;
  if (!isFiniteNonNegative(value.maxTurns)) return false;
  if (value.outputSchema !== undefined) {
    if (typeof value.outputSchema !== "object" || value.outputSchema === null || Array.isArray(value.outputSchema)) {
      return false;
    }
  }
  if (value.appendSystemPrompt !== undefined && typeof value.appendSystemPrompt !== "string") {
    return false;
  }
  return true;
}

/**
 * Non-throwing structural narrowing of an unknown value into AgentTaskGroupHandle.
 * Checks kind, group mode and per-task handle shape (generation integer,
 * status/presentation enums).
 */
export function isAgentTaskGroupHandle(v: unknown): v is AgentTaskGroupHandle {
  if (!isRecord(v)) return false;
  if (v.kind !== "agent_task_group") return false;
  if (typeof v.groupId !== "string") return false;
  if (!isOneOf(v.mode, AGENT_TASK_GROUP_MODES)) return false;
  if (!Array.isArray(v.tasks)) return false;
  return v.tasks.every((task) => {
    if (!isRecord(task)) return false;
    if (task.kind !== "agent_task") return false;
    if (typeof task.taskId !== "string" || typeof task.description !== "string") return false;
    if (typeof task.generation !== "number" || !Number.isInteger(task.generation) || task.generation < 0) {
      return false;
    }
    if (!isOneOf(task.status, AGENT_TASK_STATUSES)) return false;
    return isOneOf(task.presentation, AGENT_TASK_PRESENTATIONS);
  });
}
