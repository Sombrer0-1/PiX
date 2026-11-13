/**
 * Versioned, plain-data contract for the PiX Plan feature (1.4.0).
 *
 * Shared by main (PlanController, plan tools), renderer (plan store/UI) and the
 * parent transcript, so this is a leaf module: the only import is a type-only
 * ThinkingLevel from the shared leaf project-location.ts, and every value here
 * survives structuredClone / JSON round-trips.
 *
 * 1.4.1 version gates (B4; documented here, enforced by the code shape):
 * - PlanStep carries waitingTaskGroupId/consumedTaskGroupId/
 *   consumedTaskSummary (all optional; present only for task-linked steps).
 * - PlanRuntimeSnapshot carries pendingTaskLinkReleases
 *   (PendingPlanTaskLinkRelease), written only briefly between a plan
 *   revision/cancel and the idempotent service release.
 * - PlanStepStatus includes "interrupted" (1.4.2 R4): the hydrated status of a
 *   task-linked step after an abnormal exit, keeping waitingReason="agent_task"
 *   + waitingTaskGroupId until the group result is consumed or the link is
 *   released.
 * schemaVersion stays 1 across the 1.4.x line; the guards reject unknown
 * schemaVersion and tolerate unknown extra fields, so snapshots written by
 * later 1.4.x runtimes still pass the v1 shape check.
 *
 * Guard scope: isPlan/isPlanStep/isPlanRuntimeSnapshot check JSON shape,
 * enums, bounds (step count, finite non-negative numbers) and nothing else.
 * They never touch the filesystem/cwd and never judge DAG (dependsOn graph),
 * workspace or cross-field semantics (waitingReason/status conditionals,
 * completed evidence, envelope consistency) - those live in PlanController and
 * plan-deviation. The status transition tables are exported here as the
 * controller's validation basis; terminal states are never rewritten.
 */

import type { ThinkingLevel } from "./project-location.js";

export const PLAN_SCHEMA_VERSION = 1 as const;
export const PLAN_MAX_STEPS = 20;
export const PLAN_MIN_STEPS = 1;
/** Runtime Plan release gate passed to validatePlanDraft (1.4.0/1.4.1/1.4.2). */
export type PlanRelease = "1.4.0" | "1.4.1" | "1.4.2";
/** This build ships the combined 1.4.2 surface (background steps allowed). */
export const PLAN_RUNTIME_RELEASE: PlanRelease = "1.4.2";

export type PlanStatus =
  | "planning" | "planning_failed" | "awaiting_approval" | "revising"
  | "approved" | "executing" | "paused" | "completed" | "failed" | "cancelled";

export type PlanStepStatus =
  | "pending" | "running" | "waiting_input" | "completed"
  | "failed" | "skipped" | "cancelled" | "interrupted";  // "interrupted" 由 1.4.2（R4）加入本联合
// 1.4.2（R4）：task-linked step 异常退出水合为 "interrupted"，保留
// waitingReason="agent_task"+waitingTaskGroupId；1.4.0/1.4.1 不含此状态

export type PlanStepExecutionTarget = "parent" | "subagent_foreground" | "subagent_background";
// 1.4.0: submitPlan 校验拒绝 subagent_background（字段级错误+planning_failed）；1.4.1 起放行
export type PlanStepRisk = "low" | "medium" | "high";
export type PlanStepEffort = "small" | "medium" | "large";
export type PlanStepWaitingReason = "user_input" | "agent_task" | "";
export type PlanVerificationStatus = "passed" | "failed" | "not_run";

export interface PlanStepFile { path: string; operation: "read" | "create" | "modify" | "delete"; }

export interface PlanVerificationResult { status: PlanVerificationStatus; summary: string; }

export interface PlanStep {
  stepKey: string;                    // 模型提交，版本内唯一
  stepId: string;                     // 宿主分配，版本内稳定
  title: string;
  description: string;
  files: PlanStepFile[];              // 可为空，需 scopeNote 说明
  scopeNote?: string;
  expectedCommands?: string[];
  executionTarget: PlanStepExecutionTarget;
  risk: PlanStepRisk;
  riskReason: string;                 // PRD A3 要求 risk 附理由
  effort: PlanStepEffort;
  verification: string;
  dependsOn: string[];                // 宿主转为 stepId[]
  status: PlanStepStatus;
  waitingReason: PlanStepWaitingReason;
  waitingTaskGroupId?: string;          // 1.4.1+ waiting_input(agent_task)；1.4.2 亦由对应 interrupted step 保留
  consumedTaskGroupId?: string;         // 1.4.1+；Plan snapshot 已持久化消费事实，供 crash 后幂等补确认
  consumedTaskSummary?: string;
  completionSummary?: string;
  verificationResult?: PlanVerificationResult;
}

export interface PlanPlanningModel { provider: string; modelId: string; thinkingLevel: ThinkingLevel; }

export interface Plan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  planId: string;                     // 跨修订稳定
  version: number;                    // 从 1 递增
  status: PlanStatus;
  title: string;
  summary: string;
  planningModel: PlanPlanningModel;   // 本版本冻结快照
  steps: PlanStep[];
  createdAt: number;
  updatedAt: number;
}

export type PlanGenerationKind = "initial" | "revision" | "regenerate";
export interface PlanGenerationState {
  generationId: string;                 // 每次生成唯一；拒绝旧 turn 晚到提交
  kind: PlanGenerationKind;
  requestedVersion: number;
  concise: boolean;
  model: PlanPlanningModel;
  startedAt: number;
}
export interface PlanRevisionState {
  baseVersion: number;
  requestedVersion: number;
  feedback: string;
  stepKey?: string;
}
export interface PlanGenerationFailure {
  generationId: string;
  phase: "initial" | "revision";
  code: "model_unavailable" | "auth_unavailable" | "timeout" | "truncated" | "invalid_plan" | "cancelled" | "internal_error";
  message: string;
  fieldErrors: Array<{ path: string; message: string }>;
  retryable: boolean;
  occurredAt: number;
}
export type PlanCancelRef =
  | { planId: string; generationId: string }  // 尚无有效 Plan 的 planning/planning_failed
  | { planId: string; version: number };      // 已有有效版本

/** 1.4.1+；跨 Plan CustomEntry 与 task event 的补偿意图（修订/取消后待释放的 group link）。 */
export interface PendingPlanTaskLinkRelease {
  groupId: string;
  link: { planId: string; version: number; stepId: string };
  reason: "plan_revised" | "plan_cancelled";
}

/** PlanController 的完整可持久化状态；可表达尚无 Plan、候选修订和回退。 */
export interface PlanRuntimeSnapshot {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  phase: PlanStatus;
  planId: string | null;
  plan: Plan | null;                    // 当前展示版本；revising 时为暂不可批准的 base 内容
  lastValidPlan?: Plan;                 // 仅修订进行中/失败时保存的 immutable base
  generation?: PlanGenerationState;
  revision?: PlanRevisionState;
  failure?: PlanGenerationFailure;
  pendingTaskLinkReleases?: PendingPlanTaskLinkRelease[];
  deviations: PlanDeviation[];
  updatedAt: number;
}

export interface PlanDeviation {
  type: "file_out_of_scope" | "command_out_of_scope";
  stepId: string;
  toolCallId: string;
  path?: string;
  command?: string;
  declaredScope?: string;
  reason: string;
  detectedAt: number;
}

/** 状态转换表（PlanController 校验依据）。终态不被晚到事件回写。 */
export const PLAN_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  planning: ["awaiting_approval", "planning_failed", "cancelled"],
  planning_failed: ["planning", "cancelled"],
  awaiting_approval: ["revising", "approved", "cancelled"],
  revising: ["awaiting_approval", "cancelled"],
  approved: ["executing", "cancelled"],
  executing: ["paused", "completed", "failed", "cancelled"],
  paused: ["executing", "completed", "revising", "failed", "cancelled"],
  completed: [], failed: [], cancelled: [],
};

export const PLAN_STEP_TRANSITIONS: Record<PlanStepStatus, readonly PlanStepStatus[]> = {
  pending: ["running", "skipped", "cancelled"],
  running: ["waiting_input", "interrupted", "completed", "failed", "cancelled"], // 1.4.2 (R4): running -> interrupted
  waiting_input: ["running", "interrupted", "failed", "cancelled"],               // 1.4.2 (R4): waiting_input -> interrupted
  interrupted: ["running", "failed", "cancelled"],                                // 1.4.2 (R4)
  completed: [], failed: [], skipped: [], cancelled: [],
  // failed is terminal; failed -> running only via user "retry step" (controller special-case, not in this table)
  // 1.4.2 (R4) adds interrupted: running/waiting_input -> interrupted; interrupted -> [running,failed,cancelled]
};

/** Plan 工具白名单（规划期 setActiveToolsByName 用）。 */
export const PLAN_ALLOWLIST: readonly string[] = [
  "read", "grep", "find", "ls", "request_user_input", "submit_user_plan",
];

// ============================================================================
// Guard helpers
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

// Runtime enum tables are the guard's single source for one-of checks; they
// mirror the exported unions above (1.4.2 R4 adds "interrupted" to the step
// status table; task-group fields are optional strings checked inline).
const PLAN_STATUSES = [
  "planning", "planning_failed", "awaiting_approval", "revising",
  "approved", "executing", "paused", "completed", "failed", "cancelled",
] as const;
const PLAN_STEP_STATUSES = [
  "pending", "running", "waiting_input", "completed",
  "failed", "skipped", "cancelled", "interrupted",
] as const;
const PLAN_STEP_EXECUTION_TARGETS = ["parent", "subagent_foreground", "subagent_background"] as const;
const PLAN_STEP_RISKS = ["low", "medium", "high"] as const;
const PLAN_STEP_EFFORTS = ["small", "medium", "large"] as const;
const PLAN_STEP_WAITING_REASONS = ["user_input", "agent_task", ""] as const;
const PLAN_VERIFICATION_STATUSES = ["passed", "failed", "not_run"] as const;
const PLAN_FILE_OPERATIONS = ["read", "create", "modify", "delete"] as const;
const PLAN_GENERATION_KINDS = ["initial", "revision", "regenerate"] as const;
const PLAN_FAILURE_PHASES = ["initial", "revision"] as const;
const PLAN_FAILURE_CODES = [
  "model_unavailable", "auth_unavailable", "timeout", "truncated",
  "invalid_plan", "cancelled", "internal_error",
] as const;
const PLAN_DEVIATION_TYPES = ["file_out_of_scope", "command_out_of_scope"] as const;
const PLAN_TASK_LINK_RELEASE_REASONS = ["plan_revised", "plan_cancelled"] as const;
// Mirrors ThinkingLevel in project-location.ts; kept local so the guard can
// check it without a runtime import (plan-types.ts stays a runtime leaf).
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function isPendingPlanTaskLinkRelease(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.groupId !== "string") return false;
  if (!isRecord(value.link)) return false;
  const link = value.link;
  if (typeof link.planId !== "string") return false;
  if (!isFiniteNonNegative(link.version)) return false;
  if (typeof link.stepId !== "string") return false;
  return isOneOf(value.reason, PLAN_TASK_LINK_RELEASE_REASONS);
}

function isPlanStepFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.path === "string" && isOneOf(value.operation, PLAN_FILE_OPERATIONS);
}

function isPlanVerificationResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isOneOf(value.status, PLAN_VERIFICATION_STATUSES) && typeof value.summary === "string";
}

function isPlanPlanningModel(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.provider === "string" &&
    typeof value.modelId === "string" &&
    isOneOf(value.thinkingLevel, THINKING_LEVELS)
  );
}

function isPlanGenerationState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.generationId === "string" &&
    isOneOf(value.kind, PLAN_GENERATION_KINDS) &&
    isFiniteNonNegative(value.requestedVersion) &&
    typeof value.concise === "boolean" &&
    isPlanPlanningModel(value.model) &&
    isFiniteNonNegative(value.startedAt)
  );
}

function isPlanRevisionState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isFiniteNonNegative(value.baseVersion) &&
    isFiniteNonNegative(value.requestedVersion) &&
    typeof value.feedback === "string" &&
    (value.stepKey === undefined || typeof value.stepKey === "string")
  );
}

function isPlanGenerationFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.generationId !== "string") return false;
  if (!isOneOf(value.phase, PLAN_FAILURE_PHASES)) return false;
  if (!isOneOf(value.code, PLAN_FAILURE_CODES)) return false;
  if (typeof value.message !== "string") return false;
  if (!Array.isArray(value.fieldErrors)) return false;
  if (
    !value.fieldErrors.every(
      (entry) => isRecord(entry) && typeof entry.path === "string" && typeof entry.message === "string",
    )
  ) {
    return false;
  }
  if (typeof value.retryable !== "boolean") return false;
  return isFiniteNonNegative(value.occurredAt);
}

function isPlanDeviation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isOneOf(value.type, PLAN_DEVIATION_TYPES)) return false;
  if (typeof value.stepId !== "string" || typeof value.toolCallId !== "string") return false;
  if (value.path !== undefined && typeof value.path !== "string") return false;
  if (value.command !== undefined && typeof value.command !== "string") return false;
  if (value.declaredScope !== undefined && typeof value.declaredScope !== "string") return false;
  if (typeof value.reason !== "string") return false;
  return isFiniteNonNegative(value.detectedAt);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Non-throwing structural narrowing of an unknown value into PlanStep.
 * Checks JSON shape, required fields, enums and optional-field types only.
 * Cross-field semantics (waitingReason/status conditionals, completed
 * evidence, DAG) are validated by PlanController, not here.
 */
export function isPlanStep(v: unknown): v is PlanStep {
  if (!isRecord(v)) return false;
  if (typeof v.stepKey !== "string" || typeof v.stepId !== "string") return false;
  if (typeof v.title !== "string" || typeof v.description !== "string") return false;
  if (!Array.isArray(v.files) || !v.files.every(isPlanStepFile)) return false;
  if (v.scopeNote !== undefined && typeof v.scopeNote !== "string") return false;
  if (
    v.expectedCommands !== undefined &&
    (!Array.isArray(v.expectedCommands) || !v.expectedCommands.every((c) => typeof c === "string"))
  ) {
    return false;
  }
  if (!isOneOf(v.executionTarget, PLAN_STEP_EXECUTION_TARGETS)) return false;
  if (!isOneOf(v.risk, PLAN_STEP_RISKS)) return false;
  if (typeof v.riskReason !== "string") return false;
  if (!isOneOf(v.effort, PLAN_STEP_EFFORTS)) return false;
  if (typeof v.verification !== "string") return false;
  if (!Array.isArray(v.dependsOn) || !v.dependsOn.every((d) => typeof d === "string")) return false;
  if (!isOneOf(v.status, PLAN_STEP_STATUSES)) return false;
  if (!isOneOf(v.waitingReason, PLAN_STEP_WAITING_REASONS)) return false;
  if (v.waitingTaskGroupId !== undefined && typeof v.waitingTaskGroupId !== "string") return false;
  if (v.consumedTaskGroupId !== undefined && typeof v.consumedTaskGroupId !== "string") return false;
  if (v.consumedTaskSummary !== undefined && typeof v.consumedTaskSummary !== "string") return false;
  if (v.completionSummary !== undefined && typeof v.completionSummary !== "string") return false;
  if (v.verificationResult !== undefined && !isPlanVerificationResult(v.verificationResult)) return false;
  return true;
}

/**
 * Non-throwing structural narrowing of an unknown value into Plan.
 * Checks JSON shape, schemaVersion, enums, step-count bounds
 * (PLAN_MIN_STEPS..PLAN_MAX_STEPS) and finite non-negative timestamps/version.
 * Does NOT check cwd, DAG (dependsOn graph) or version semantics - those live
 * in PlanController and plan-deviation.
 */
export function isPlan(v: unknown): v is Plan {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== PLAN_SCHEMA_VERSION) return false;
  if (typeof v.planId !== "string") return false;
  if (!isFiniteNonNegative(v.version)) return false;
  if (!isOneOf(v.status, PLAN_STATUSES)) return false;
  if (typeof v.title !== "string" || typeof v.summary !== "string") return false;
  if (!isPlanPlanningModel(v.planningModel)) return false;
  if (!Array.isArray(v.steps)) return false;
  if (v.steps.length < PLAN_MIN_STEPS || v.steps.length > PLAN_MAX_STEPS) return false;
  if (!v.steps.every(isPlanStep)) return false;
  if (!isFiniteNonNegative(v.createdAt) || !isFiniteNonNegative(v.updatedAt)) return false;
  return true;
}

/**
 * Non-throwing structural narrowing of an unknown value into PlanRuntimeSnapshot.
 * Checks JSON shape, schemaVersion, enums, optional sub-objects (generation,
 * revision, failure, lastValidPlan) and finite non-negative timestamps.
 * Envelope consistency (plan.planId/plan.status vs phase), lastValidPlan+
 * revision coupling and failure generationId identity are PlanController
 * semantics, not checked here.
 */
export function isPlanRuntimeSnapshot(v: unknown): v is PlanRuntimeSnapshot {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== PLAN_SCHEMA_VERSION) return false;
  if (!isOneOf(v.phase, PLAN_STATUSES)) return false;
  if (v.planId !== null && typeof v.planId !== "string") return false;
  if (v.plan !== null && !isPlan(v.plan)) return false;
  if (v.lastValidPlan !== undefined && !isPlan(v.lastValidPlan)) return false;
  if (v.generation !== undefined && !isPlanGenerationState(v.generation)) return false;
  if (v.revision !== undefined && !isPlanRevisionState(v.revision)) return false;
  if (v.failure !== undefined && !isPlanGenerationFailure(v.failure)) return false;
  if (
    v.pendingTaskLinkReleases !== undefined &&
    (!Array.isArray(v.pendingTaskLinkReleases) || !v.pendingTaskLinkReleases.every(isPendingPlanTaskLinkRelease))
  ) {
    return false;
  }
  if (!Array.isArray(v.deviations) || !v.deviations.every(isPlanDeviation)) return false;
  return isFiniteNonNegative(v.updatedAt);
}
