/**
 * Host-only workflow request and live-run handle types. The renderer must
 * never see this module: `WorkflowParentRef` carries an
 * `AgentTaskSubmissionContext` borrow, so this file stays in the main
 * process. The browser-safe vocabulary lives in `src/shared/workflow-types.ts`.
 */

import type { WorkflowMeta, WorkflowResult, WorkflowRunId } from "../../../shared/workflow-types.js";
import type { AgentTaskSubmissionContext } from "../../agent-task/agent-task-service.js";
import type { WorkflowChildCache } from "../child-cache.js";

/**
 * What a caller asks for when starting a workflow run. `meta` and `args` are
 * plain JSON data by the seam contract. `parent` is required because every
 * `agent()` spawned by the script is attributed to that live Agent.
 */
export interface WorkflowParentRef {
  sessionId: string;
  toolCallId: string;
  workspaceId: string;
  /** Called once per child-start; the return value is only valid during createTaskGroup — the spawner must not cache the closure past freeze. */
  getSubmissionContext(): AgentTaskSubmissionContext;
}

export interface WorkflowStartRequest {
  /** The plain-JS script body (top-level await allowed; ends with `return <json-value>`). */
  script: string;
  /** The workflow's identity block, as plain JSON data (shape-validated by the engine). */
  meta: WorkflowMeta;
  /** Optional input exposed verbatim to the script as the `args` global. */
  args?: unknown;
  /** pix: default agent definition name; the tool layer generally does not pass it. ralph passes "general-purpose". */
  subagentProvider?: string;
  /** Optional per-run total-child ceiling. */
  maxTotalAgents?: number;
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: WorkflowParentRef;
  /** Cancels the run when aborted. */
  signal?: AbortSignal;
}

/**
 * Holder-owned live workflow. `result` never rejects; consumers may cancel
 * and must call idempotent `dispose()` to await script and child quiescence.
 */
export interface WorkflowRun {
  readonly id: WorkflowRunId;
  /** The validated meta block available before the script body runs. */
  readonly meta: WorkflowMeta;
  readonly result: Promise<WorkflowResult>; // never rejects
  /** Cancel the run and its children. */
  cancel(reason?: string): void;
  /** Cancel if needed and await bounded settlement and cleanup. */
  dispose(): Promise<void>;
}

export interface WorkflowEngineConfig {
  maxConcurrentAgents?: number; // 0 = auto; resolved value clamped to the live running-slot cap
  /** Live AgentTask running-slot cap used as the clamp for maxConcurrentAgents. */
  getRunningSlotCap?: () => number;
  maxTotalAgents?: number;      // default 1000
  maxItemsPerCall?: number;     // default 4096
  syncTimeoutMs?: number;       // default 5000
  disposeGraceMs?: number;      // default 5000
  /** Host-only child-result cache; never shipped in WorkerInit / workerData. */
  cache?: WorkflowChildCache;
}
